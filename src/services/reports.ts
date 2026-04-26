import type {
  Booking,
  CleaningCrewProfile,
  CleaningJob,
  CommissionLedgerEntry,
  Id,
  Room,
} from "../domain/types.js";
import { CLEANING_BUFFER_MINUTES } from "../domain/time.js";

const NON_REVENUE_STATUSES = new Set<Booking["status"]>(["held", "cancelled"]);
const FUTURE_PROJECTABLE_STATUSES = new Set<Booking["status"]>([
  "pending_payment",
  "held",
]);

export interface DateRange {
  from: Date;
  to: Date;
}

export interface ReportRoomTotals {
  roomId: Id;
  bookings: number;
  grossRevenueVnd: number;
  discountsVnd: number;
  netRevenueVnd: number;
  refundsVnd: number;
  minibarVnd: number;
  damagesVnd: number;
}

export interface RevenueSummary {
  bookingsCount: number;
  cancelledCount: number;
  grossRevenueVnd: number;
  discountsVnd: number;
  netRevenueVnd: number;
  refundsVnd: number;
  minibarVnd: number;
  damagesVnd: number;
  pendingExtraPaymentsVnd: number;
  projectedRevenueVnd: number;
  averageBookingValueVnd: number;
  cancellationRate: number; // 0..1
  byRoom: ReportRoomTotals[];
}

export interface OccupancyResult {
  totalAvailableHours: number;
  bookedHours: number;
  cleaningBufferHours: number;
  occupancyRate: number; // 0..1, paid hours only
  byRoom: Array<{
    roomId: Id;
    bookedHours: number;
    cleaningBufferHours: number;
    occupancyRate: number;
  }>;
}

export interface AgentPerformanceRow {
  agentId: Id;
  bookings: number;
  confirmed: number;
  cancelled: number;
  netRevenueVnd: number;
  discountsUsedVnd: number;
  commissionEarnedVnd: number;
  commissionPendingVnd: number;
  commissionPaidVnd: number;
  averageBookingValueVnd: number;
  cancellationRate: number;
}

export interface CleanerPerformanceRow {
  cleanerId: Id;
  jobsAssigned: number;
  jobsCompleted: number;
  averageRating?: number;
  fixedPayEarnedVnd: number;
}

function inRange(date: Date | undefined, range?: DateRange): boolean {
  if (!range) return true;
  if (!date) return false;
  return date >= range.from && date <= range.to;
}

export function calculateRevenueSummary(input: {
  bookings: Iterable<Booking>;
  rooms: Iterable<Room>;
  range?: DateRange;
}): RevenueSummary {
  const bookings = Array.from(input.bookings);
  const inWindow = bookings.filter((b) => inRange(b.checkInAt, input.range));

  const consideredForRevenue = inWindow.filter(
    (b) => !NON_REVENUE_STATUSES.has(b.status),
  );
  const cancelled = inWindow.filter((b) => b.status === "cancelled");

  let gross = 0;
  let discounts = 0;
  let refunds = 0;
  let minibar = 0;
  let damages = 0;
  let extras = 0;
  let projected = 0;

  const perRoom = new Map<Id, ReportRoomTotals>();
  for (const room of input.rooms) {
    perRoom.set(room.id, {
      roomId: room.id,
      bookings: 0,
      grossRevenueVnd: 0,
      discountsVnd: 0,
      netRevenueVnd: 0,
      refundsVnd: 0,
      minibarVnd: 0,
      damagesVnd: 0,
    });
  }

  for (const b of consideredForRevenue) {
    const grossForBooking = b.finalRoomChargeVnd + b.discountAmountVnd;
    gross += grossForBooking;
    discounts += b.discountAmountVnd;
    refunds += b.refundDueVnd;
    minibar += b.minibarChargesVnd;
    damages += b.damageChargesVnd;
    extras += b.amountDueVnd;
    if (FUTURE_PROJECTABLE_STATUSES.has(b.status))
      projected += b.finalRoomChargeVnd;

    const row = perRoom.get(b.roomId);
    if (row) {
      row.bookings += 1;
      row.grossRevenueVnd += grossForBooking;
      row.discountsVnd += b.discountAmountVnd;
      row.netRevenueVnd += b.finalRoomChargeVnd;
      row.refundsVnd += b.refundDueVnd;
      row.minibarVnd += b.minibarChargesVnd;
      row.damagesVnd += b.damageChargesVnd;
    }
  }

  const net = consideredForRevenue.reduce(
    (s, b) => s + b.finalRoomChargeVnd,
    0,
  );
  const inWindowCount = inWindow.length;
  const cancellationRate =
    inWindowCount === 0 ? 0 : cancelled.length / inWindowCount;
  const avg =
    consideredForRevenue.length === 0
      ? 0
      : Math.round(net / consideredForRevenue.length);

  return {
    bookingsCount: consideredForRevenue.length,
    cancelledCount: cancelled.length,
    grossRevenueVnd: gross,
    discountsVnd: discounts,
    netRevenueVnd: net,
    refundsVnd: refunds,
    minibarVnd: minibar,
    damagesVnd: damages,
    pendingExtraPaymentsVnd: extras,
    projectedRevenueVnd: projected,
    averageBookingValueVnd: avg,
    cancellationRate,
    byRoom: Array.from(perRoom.values()),
  };
}

export function calculateOccupancy(input: {
  bookings: Iterable<Booking>;
  rooms: Iterable<Room>;
  range: DateRange;
}): OccupancyResult {
  const ms = input.range.to.getTime() - input.range.from.getTime();
  const totalHoursPerRoom = Math.max(0, ms / 3_600_000);
  const rooms = Array.from(input.rooms);
  const totalAvailableHours = totalHoursPerRoom * rooms.length;

  let booked = 0;
  let buffer = 0;
  const perRoom: OccupancyResult["byRoom"] = [];

  for (const room of rooms) {
    let bookedRoom = 0;
    let bufferRoom = 0;
    for (const b of input.bookings) {
      if (b.roomId !== room.id || NON_REVENUE_STATUSES.has(b.status)) continue;
      const start = max(b.checkInAt, input.range.from);
      const end = min(b.checkOutAt, input.range.to);
      if (start < end)
        bookedRoom += (end.getTime() - start.getTime()) / 3_600_000;
      const bufferEnd = new Date(
        b.checkOutAt.getTime() + CLEANING_BUFFER_MINUTES * 60_000,
      );
      const bStart = max(b.checkOutAt, input.range.from);
      const bEnd = min(bufferEnd, input.range.to);
      if (bStart < bEnd)
        bufferRoom += (bEnd.getTime() - bStart.getTime()) / 3_600_000;
    }
    booked += bookedRoom;
    buffer += bufferRoom;
    perRoom.push({
      roomId: room.id,
      bookedHours: bookedRoom,
      cleaningBufferHours: bufferRoom,
      occupancyRate: totalHoursPerRoom > 0 ? bookedRoom / totalHoursPerRoom : 0,
    });
  }

  const occupancyRate =
    totalAvailableHours > 0 ? booked / totalAvailableHours : 0;

  return {
    totalAvailableHours,
    bookedHours: booked,
    cleaningBufferHours: buffer,
    occupancyRate,
    byRoom: perRoom,
  };
}

export function calculateAgentPerformance(input: {
  bookings: Iterable<Booking>;
  ledger: Iterable<CommissionLedgerEntry>;
  range?: DateRange;
}): AgentPerformanceRow[] {
  const byAgent = new Map<Id, AgentPerformanceRow>();
  function ensure(id: Id): AgentPerformanceRow {
    let row = byAgent.get(id);
    if (!row) {
      row = {
        agentId: id,
        bookings: 0,
        confirmed: 0,
        cancelled: 0,
        netRevenueVnd: 0,
        discountsUsedVnd: 0,
        commissionEarnedVnd: 0,
        commissionPendingVnd: 0,
        commissionPaidVnd: 0,
        averageBookingValueVnd: 0,
        cancellationRate: 0,
      };
      byAgent.set(id, row);
    }
    return row;
  }

  const counts: Record<
    Id,
    { window: number; confirmed: number; cancelled: number }
  > = {};
  for (const b of input.bookings) {
    if (!b.salesAgentId) continue;
    if (!inRange(b.checkInAt, input.range)) continue;
    const row = ensure(b.salesAgentId);
    counts[b.salesAgentId] ??= { window: 0, confirmed: 0, cancelled: 0 };
    const c = counts[b.salesAgentId]!;
    c.window += 1;
    if (NON_REVENUE_STATUSES.has(b.status)) {
      if (b.status === "cancelled") c.cancelled += 1;
      continue;
    }
    c.confirmed += 1;
    row.netRevenueVnd += b.finalRoomChargeVnd;
    row.discountsUsedVnd += b.discountAmountVnd;
    row.commissionEarnedVnd += b.calculatedCommissionVnd;
  }

  for (const entry of input.ledger) {
    const row = ensure(entry.salesAgentId);
    if (entry.status === "pending" || entry.status === "approved")
      row.commissionPendingVnd += entry.amountVnd;
    if (entry.status === "paid") row.commissionPaidVnd += entry.amountVnd;
  }

  for (const [id, row] of byAgent) {
    const c = counts[id];
    if (c) {
      row.bookings = c.window;
      row.confirmed = c.confirmed;
      row.cancelled = c.cancelled;
      row.cancellationRate = c.window === 0 ? 0 : c.cancelled / c.window;
    }
    row.averageBookingValueVnd =
      row.confirmed === 0 ? 0 : Math.round(row.netRevenueVnd / row.confirmed);
  }

  return Array.from(byAgent.values()).sort(
    (a, b) => b.netRevenueVnd - a.netRevenueVnd,
  );
}

export function calculateCleanerPerformance(input: {
  cleaningJobs: Iterable<CleaningJob>;
  profiles: Iterable<CleaningCrewProfile>;
  range?: DateRange;
}): CleanerPerformanceRow[] {
  const byCleaner = new Map<Id, CleanerPerformanceRow>();
  for (const profile of input.profiles) {
    byCleaner.set(profile.userId, {
      cleanerId: profile.userId,
      jobsAssigned: 0,
      jobsCompleted: 0,
      averageRating: profile.averageRating,
      fixedPayEarnedVnd: 0,
    });
  }
  for (const job of input.cleaningJobs) {
    if (!job.assignedToUserId) continue;
    if (!inRange(job.windowStartAt, input.range)) continue;
    const row = byCleaner.get(job.assignedToUserId);
    if (!row) continue;
    row.jobsAssigned += 1;
    if (job.status === "completed") {
      row.jobsCompleted += 1;
      row.fixedPayEarnedVnd += job.fixedPayVnd;
    }
  }
  return Array.from(byCleaner.values()).sort(
    (a, b) => b.jobsCompleted - a.jobsCompleted,
  );
}

function max(a: Date, b: Date): Date {
  return a.getTime() > b.getTime() ? a : b;
}
function min(a: Date, b: Date): Date {
  return a.getTime() < b.getTime() ? a : b;
}

// CSV helpers
function csvEscape(value: unknown): string {
  if (value == null) return "";
  const s = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function bookingsToCsv(bookings: Iterable<Booking>): string {
  const header = [
    "booking_number",
    "status",
    "payment_status",
    "room_id",
    "guest_id",
    "sales_agent_id",
    "check_in_at",
    "check_out_at",
    "final_room_charge_vnd",
    "discount_vnd",
    "amount_paid_vnd",
    "amount_due_vnd",
    "refund_due_vnd",
    "minibar_vnd",
    "damages_vnd",
    "calculated_commission_vnd",
    "source",
    "notes",
  ];
  const rows = [header.join(",")];
  for (const b of bookings) {
    rows.push(
      [
        b.bookingNumber,
        b.status,
        b.paymentStatus,
        b.roomId,
        b.guestId,
        b.salesAgentId ?? "",
        b.checkInAt,
        b.checkOutAt,
        b.finalRoomChargeVnd,
        b.discountAmountVnd,
        b.amountPaidVnd,
        b.amountDueVnd,
        b.refundDueVnd,
        b.minibarChargesVnd,
        b.damageChargesVnd,
        b.calculatedCommissionVnd,
        b.source ?? "",
        b.notes ?? "",
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return rows.join("\n");
}

export function rowsToCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const out = [headers.join(",")];
  for (const row of rows) {
    out.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  return out.join("\n");
}
