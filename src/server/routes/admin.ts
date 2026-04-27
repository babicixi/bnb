import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import multer from "multer";
import { Router, type Express } from "express";
import { z } from "zod";
import {
  approveCancellation,
  autoAssignCleaningJob,
  calculateBookingPrice,
  editBookingTimes,
  markPaymentProofInvalid,
  requestCancellation,
} from "../../index.js";
import { nextId, type Repository } from "../../repo/memory.js";
import { requireRole } from "../middleware/auth.js";
import { notify } from "../../services/notifications.js";
import { parseVietnamLocal } from "../parseTime.js";
import { computeDailyChecklist } from "../../services/automation.js";
import {
  bookingsToCsv,
  calculateAgentPerformance,
  calculateCleanerPerformance,
  calculateOccupancy,
  calculateRevenueSummary,
  rowsToCsv,
} from "../../services/reports.js";
import { snapshotBooking } from "../../services/audit.js";
import { audit } from "../auditHelper.js";
import {
  approveCommission,
  markCommissionPaid,
  voidCommission,
} from "../../services/commissionLedger.js";
import type { RequestWithUser } from "../middleware/auth.js";

function defaultRange(): { from: Date; to: Date } {
  const now = new Date();
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - 30);
  const to = new Date(now);
  to.setUTCDate(to.getUTCDate() + 60);
  return { from, to };
}

const filterSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.string().optional(),
  paymentStatus: z.string().optional(),
  buildingId: z.string().optional(),
  roomId: z.string().optional(),
  agentId: z.string().optional(),
  view: z.enum(["table", "week", "month"]).optional(),
  cal: z.string().optional(), // anchor date YYYY-MM-DD (week mode) or YYYY-MM (month mode)
});

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfWeekSunday(d: Date): Date {
  // Snap to the Sunday on or before d (UTC).
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day),
  );
}

function buildWeekView(input: {
  bookings: Array<import("../../domain/types.js").Booking>;
  guests: Map<string, import("../../domain/types.js").Guest>;
  rooms: Array<import("../../domain/types.js").Room>;
  maintenance: Array<import("../../domain/types.js").MaintenanceBlock>;
  filters: Record<string, string | undefined>;
  anchorDate?: string;
}) {
  const now = new Date();
  let anchor: Date;
  if (input.anchorDate && /^\d{4}-\d{2}-\d{2}$/.test(input.anchorDate)) {
    anchor = new Date(`${input.anchorDate}T00:00:00Z`);
  } else {
    anchor = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }
  const weekStart = startOfWeekSunday(anchor);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart.getTime() + i * 86_400_000);
    const dow = d.getUTCDay();
    days.push({
      iso: isoDate(d),
      day: d.getUTCDate(),
      dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow],
      month: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()],
      isWeekend: dow === 0 || dow === 6,
      isToday: isoDate(d) === isoDate(now),
      label: isoDate(d),
    });
  }

  type Bar = {
    booking: import("../../domain/types.js").Booking;
    guestName: string;
    colStart: number;
    colSpan: number;
    /** Vietnam-local start hour within the first visible day (0-24). */
    startHour: number;
    /** Vietnam-local end hour within the last visible day (0-24). */
    endHour: number;
    /** True when the booking is wholly inside a single day cell. */
    isPartialDay: boolean;
  };
  type MaintBar = {
    block: import("../../domain/types.js").MaintenanceBlock;
    colStart: number;
    colSpan: number;
    startHour: number;
    endHour: number;
    isPartialDay: boolean;
  };
  const barsByRoom: Record<string, Bar[]> = {};
  const maintBarsByRoom: Record<string, MaintBar[]> = {};

  // Vietnam-local hour-of-day for `d`, clamped to [0, 24] relative to the
  // calendar day identified by `dayIso`. Used to position bars within a cell.
  function vnHourOnDay(d: Date, dayIso: string): number {
    const vn = new Date(d.getTime() + 7 * 60 * 60_000);
    const iso = vn.toISOString().slice(0, 10);
    if (iso < dayIso) return 0;
    if (iso > dayIso) return 24;
    return vn.getUTCHours() + vn.getUTCMinutes() / 60;
  }

  function colsFor(start: Date, end: Date): { colStart: number; colSpan: number } | null {
    if (end <= weekStart || start >= weekEnd) return null;
    const dayOf = (d: Date) =>
      new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const startDay = dayOf(start < weekStart ? weekStart : start);
    let lastDay: Date;
    if (end >= weekEnd) {
      lastDay = new Date(weekEnd.getTime() - 86_400_000);
    } else {
      const endDayOnly = dayOf(end);
      if (end.getTime() === endDayOnly.getTime()) {
        lastDay = new Date(endDayOnly.getTime() - 86_400_000);
      } else {
        lastDay = endDayOnly;
      }
    }
    const colStart =
      Math.round((startDay.getTime() - weekStart.getTime()) / 86_400_000) + 1;
    const lastCol =
      Math.round((lastDay.getTime() - weekStart.getTime()) / 86_400_000) + 1;
    const colSpan = lastCol - colStart + 1;
    if (colSpan < 1) return null;
    return { colStart, colSpan };
  }

  for (const b of input.bookings) {
    if (b.status === "cancelled" || b.status === "held") continue;
    const cols = colsFor(b.checkInAt, b.checkOutAt);
    if (!cols) continue;
    const guest = input.guests.get(b.guestId);
    const startDayIso = days[cols.colStart - 1]?.iso ?? "";
    const endDayIso = days[cols.colStart - 1 + cols.colSpan - 1]?.iso ?? "";
    const startHour = vnHourOnDay(b.checkInAt, startDayIso);
    const endHour = vnHourOnDay(b.checkOutAt, endDayIso);
    (barsByRoom[b.roomId] ??= []).push({
      booking: b,
      guestName: guest ? guest.fullName : "—",
      ...cols,
      startHour,
      endHour,
      isPartialDay: b.bookingType === "hourly" && cols.colSpan === 1,
    });
  }
  for (const list of Object.values(barsByRoom)) {
    list.sort(
      (a, b) =>
        a.colStart - b.colStart ||
        a.startHour - b.startHour ||
        b.colSpan - a.colSpan,
    );
  }
  for (const m of input.maintenance) {
    const cols = colsFor(m.startsAt, m.endsAt);
    if (!cols) continue;
    const startDayIso = days[cols.colStart - 1]?.iso ?? "";
    const endDayIso = days[cols.colStart - 1 + cols.colSpan - 1]?.iso ?? "";
    (maintBarsByRoom[m.roomId] ??= []).push({
      block: m,
      ...cols,
      startHour: vnHourOnDay(m.startsAt, startDayIso),
      endHour: vnHourOnDay(m.endsAt, endDayIso),
      isPartialDay: cols.colSpan === 1,
    });
  }

  function buildQuery(anchorIso: string): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(input.filters)) {
      if (v && k !== "view" && k !== "cal") params.set(k, v);
    }
    params.set("view", "week");
    params.set("cal", anchorIso);
    return params.toString();
  }
  const prevAnchor = isoDate(new Date(weekStart.getTime() - 7 * 86_400_000));
  const nextAnchor = isoDate(new Date(weekStart.getTime() + 7 * 86_400_000));
  const todayAnchor = isoDate(now);
  const label =
    `${days[0]!.month} ${days[0]!.day} – ${days[6]!.month} ${days[6]!.day}, ${weekStart.getUTCFullYear()}`;

  return {
    days,
    barsByRoom,
    maintBarsByRoom,
    label,
    prevQuery: buildQuery(prevAnchor),
    nextQuery: buildQuery(nextAnchor),
    todayQuery: buildQuery(todayAnchor),
  };
}

function buildMonthGrid(input: {
  bookings: Array<import("../../domain/types.js").Booking>;
  guests: Map<string, import("../../domain/types.js").Guest>;
  rooms: Map<string, import("../../domain/types.js").Room>;
  maintenance: Array<import("../../domain/types.js").MaintenanceBlock>;
  filters: Record<string, string | undefined>;
  anchorMonth?: string;
}) {
  const now = new Date();
  let year: number;
  let month: number;
  if (input.anchorMonth && /^\d{4}-\d{2}$/.test(input.anchorMonth)) {
    const parts = input.anchorMonth.split("-").map(Number);
    year = parts[0]!;
    month = parts[1]! - 1;
  } else {
    year = now.getUTCFullYear();
    month = now.getUTCMonth();
  }
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const nextMonth = new Date(Date.UTC(year, month + 1, 1));
  const gridStart = startOfWeekSunday(firstOfMonth);
  // Always 6 weeks tall so the grid is a stable rectangle.
  const totalDays = 42;

  const allDays = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(gridStart.getTime() + i * 86_400_000);
    allDays.push({
      iso: isoDate(d),
      day: d.getUTCDate(),
      isOutside: d < firstOfMonth || d >= nextMonth,
      isToday: isoDate(d) === isoDate(now),
      isWeekend: d.getUTCDay() === 0 || d.getUTCDay() === 6,
    });
  }
  const weeks: Array<typeof allDays> = [];
  for (let w = 0; w < 6; w++) {
    weeks.push(allDays.slice(w * 7, w * 7 + 7));
  }

  // Per-week bars with lane assignment so overlapping bookings stack.
  type WeekBar = {
    booking: import("../../domain/types.js").Booking;
    guestName: string;
    roomName: string;
    colStart: number;
    colSpan: number;
    lane: number;
  };
  const barsByWeek: WeekBar[][] = [];
  for (let w = 0; w < weeks.length; w++) {
    const week = weeks[w]!;
    const wkStart = new Date(`${week[0]!.iso}T00:00:00Z`);
    const wkEnd = new Date(wkStart.getTime() + 7 * 86_400_000);

    const collected: Omit<WeekBar, "lane">[] = [];
    for (const b of input.bookings) {
      if (b.status === "cancelled" || b.status === "held") continue;
      if (b.checkOutAt <= wkStart || b.checkInAt >= wkEnd) continue;
      const start = b.checkInAt < wkStart ? wkStart : b.checkInAt;
      const startIso = isoDate(start);
      const endExclusive = b.checkOutAt > wkEnd ? wkEnd : b.checkOutAt;
      const endDay = new Date(
        Date.UTC(
          endExclusive.getUTCFullYear(),
          endExclusive.getUTCMonth(),
          endExclusive.getUTCDate(),
        ),
      );
      const lastIso =
        endExclusive.getTime() === endDay.getTime()
          ? isoDate(new Date(endDay.getTime() - 86_400_000))
          : isoDate(endDay);
      const colStart = week.findIndex((d) => d.iso === startIso) + 1;
      const lastCol = week.findIndex((d) => d.iso === lastIso) + 1;
      if (colStart < 1 || lastCol < 1) continue;
      const colSpan = lastCol - colStart + 1;
      const guest = input.guests.get(b.guestId);
      const room = input.rooms.get(b.roomId);
      collected.push({
        booking: b,
        guestName: guest ? guest.fullName : "—",
        roomName: room ? room.name : b.roomId,
        colStart,
        colSpan,
      });
    }
    collected.sort(
      (a, b) => a.colStart - b.colStart || b.colSpan - a.colSpan,
    );
    const laneEnds: number[] = [];
    const placed: WeekBar[] = collected.map((bar) => {
      let lane = 0;
      while (lane < laneEnds.length && (laneEnds[lane] ?? 0) > bar.colStart) {
        lane++;
      }
      laneEnds[lane] = bar.colStart + bar.colSpan;
      return { ...bar, lane };
    });
    barsByWeek.push(placed);
  }

  function buildQuery(anchorYm: string): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(input.filters)) {
      if (v && k !== "view" && k !== "cal") params.set(k, v);
    }
    params.set("view", "month");
    params.set("cal", anchorYm);
    return params.toString();
  }
  const prevDate = new Date(Date.UTC(year, month - 1, 1));
  const nextDate = new Date(Date.UTC(year, month + 1, 1));
  const ym = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const label = firstOfMonth.toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return {
    weeks,
    barsByWeek,
    label,
    prevQuery: buildQuery(ym(prevDate)),
    nextQuery: buildQuery(ym(nextDate)),
    todayQuery: buildQuery(ym(now)),
  };
}

// Legacy month-rooms-grid builder, kept around for reference but unused now
// that buildWeekView and buildMonthGrid cover the supported views.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function buildCalendar(input: {
  bookings: Array<import("../../domain/types.js").Booking>;
  guests: Map<string, import("../../domain/types.js").Guest>;
  rooms: Array<import("../../domain/types.js").Room>;
  maintenance: Array<import("../../domain/types.js").MaintenanceBlock>;
  filters: Record<string, string | undefined>;
  anchorMonth?: string;
}) {
  const now = new Date();
  let year: number;
  let month: number; // 0-11
  if (input.anchorMonth && /^\d{4}-\d{2}$/.test(input.anchorMonth)) {
    const [y, m] = input.anchorMonth.split("-").map(Number);
    year = y!;
    month = m! - 1;
  } else {
    year = now.getUTCFullYear();
    month = now.getUTCMonth();
  }
  const firstDay = new Date(Date.UTC(year, month, 1));
  const nextMonth = new Date(Date.UTC(year, month + 1, 1));
  const daysInMonth = Math.round(
    (nextMonth.getTime() - firstDay.getTime()) / 86_400_000,
  );

  const days = [];
  for (let i = 0; i < daysInMonth; i++) {
    const d = new Date(Date.UTC(year, month, i + 1));
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    days.push({
      iso,
      day: i + 1,
      dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow],
      isWeekend: dow === 0 || dow === 6,
      label: iso,
    });
  }

  // Bars: one entry per booking that intersects the visible month, with
  // grid-column start/span computed so the front-end can render a single
  // multi-day bar instead of a label per cell.
  type Bar = {
    booking: import("../../domain/types.js").Booking;
    guestName: string;
    colStart: number; // 1-based among day columns
    colSpan: number;
  };
  type MaintBar = {
    block: import("../../domain/types.js").MaintenanceBlock;
    colStart: number;
    colSpan: number;
  };
  const barsByRoom: Record<string, Bar[]> = {};
  const maintBarsByRoom: Record<string, MaintBar[]> = {};

  const monthStart = firstDay;
  const monthEnd = nextMonth;

  function colsFor(start: Date, end: Date): { colStart: number; colSpan: number } | null {
    const clampedStart = start < monthStart ? monthStart : start;
    const clampedEnd = end > monthEnd ? monthEnd : end;
    if (clampedStart >= monthEnd || clampedEnd <= monthStart) return null;
    const startDay = new Date(
      Date.UTC(
        clampedStart.getUTCFullYear(),
        clampedStart.getUTCMonth(),
        clampedStart.getUTCDate(),
      ),
    );
    const endDay = new Date(
      Date.UTC(
        clampedEnd.getUTCFullYear(),
        clampedEnd.getUTCMonth(),
        clampedEnd.getUTCDate(),
      ),
    );
    const colStart =
      Math.round((startDay.getTime() - monthStart.getTime()) / 86_400_000) + 1;
    let colSpan = Math.round((endDay.getTime() - startDay.getTime()) / 86_400_000);
    // a one-day occupancy (e.g. hourly booking that starts and ends same day)
    // still gets one column.
    if (colSpan < 1) colSpan = 1;
    // Don't run past the visible month.
    if (colStart + colSpan - 1 > daysInMonth) colSpan = daysInMonth - colStart + 1;
    return { colStart, colSpan };
  }

  for (const b of input.bookings) {
    if (b.status === "cancelled" || b.status === "held") continue;
    const cols = colsFor(b.checkInAt, b.checkOutAt);
    if (!cols) continue;
    const guest = input.guests.get(b.guestId);
    const guestName = guest ? guest.fullName : "—";
    (barsByRoom[b.roomId] ??= []).push({
      booking: b,
      guestName,
      colStart: cols.colStart,
      colSpan: cols.colSpan,
    });
  }
  for (const list of Object.values(barsByRoom)) {
    list.sort((a, b) => a.colStart - b.colStart);
  }

  for (const m of input.maintenance) {
    const cols = colsFor(m.startsAt, m.endsAt);
    if (!cols) continue;
    (maintBarsByRoom[m.roomId] ??= []).push({
      block: m,
      colStart: cols.colStart,
      colSpan: cols.colSpan,
    });
  }

  function buildQuery(monthIso: string): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(input.filters)) {
      if (v) params.set(k, v);
    }
    params.set("view", "calendar");
    params.set("cal", monthIso);
    return params.toString();
  }
  const prevDate = new Date(Date.UTC(year, month - 1, 1));
  const nextDate = new Date(Date.UTC(year, month + 1, 1));
  const prevQuery = buildQuery(
    `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, "0")}`,
  );
  const nextQuery = buildQuery(
    `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth() + 1).padStart(2, "0")}`,
  );

  const label = firstDay.toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return {
    days,
    barsByRoom,
    maintBarsByRoom,
    label,
    prevQuery,
    nextQuery,
  };
}

export function mountAdminRoutes(
  app: Express,
  repo: Repository,
  uploadsDir: string,
): void {
  fs.mkdirSync(uploadsDir, { recursive: true });
  const screenshotStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
      cb(
        null,
        `payment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`,
      );
    },
  });
  const screenshotUpload = multer({
    storage: screenshotStorage,
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (!/^image\//.test(file.mimetype)) {
        cb(new Error("Only image uploads are allowed."));
        return;
      }
      cb(null, true);
    },
  });

  const router = Router();
  router.use(requireRole("admin", "manager"));
  router.use((_req, res, next) => {
    res.locals.bodyClass = "wide-page";
    next();
  });

  function csvField(value: string): string {
    if (value === undefined || value === null) return "";
    const s = String(value);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  function csvFileName(name: string): string {
    return name.replace(/[^A-Za-z0-9_-]+/g, "_") || "report";
  }

  router.get("/", (req, res) => {
    const filters = filterSchema.parse(req.query);
    let bookings = Array.from(repo.bookings.values());
    if (filters.status)
      bookings = bookings.filter((b) => b.status === filters.status);
    if (filters.paymentStatus)
      bookings = bookings.filter(
        (b) => b.paymentStatus === filters.paymentStatus,
      );
    if (filters.roomId)
      bookings = bookings.filter((b) => b.roomId === filters.roomId);
    if (filters.buildingId) {
      const buildingRooms = new Set(
        Array.from(repo.rooms.values())
          .filter((r) => r.buildingId === filters.buildingId)
          .map((r) => r.id),
      );
      bookings = bookings.filter((b) => buildingRooms.has(b.roomId));
    }
    if (filters.agentId)
      bookings = bookings.filter((b) => b.salesAgentId === filters.agentId);
    if (filters.from) {
      const fromAt = new Date(filters.from);
      if (!Number.isNaN(fromAt.getTime()))
        bookings = bookings.filter((b) => b.checkInAt >= fromAt);
    }
    if (filters.to) {
      const toAt = new Date(filters.to);
      if (!Number.isNaN(toAt.getTime()))
        bookings = bookings.filter((b) => b.checkInAt <= toAt);
    }
    bookings.sort((a, b) => a.checkInAt.getTime() - b.checkInAt.getTime());

    const allRooms = Array.from(repo.rooms.values());
    const calendarRooms = filters.roomId
      ? allRooms.filter((r) => r.id === filters.roomId)
      : filters.buildingId
        ? allRooms.filter((r) => r.buildingId === filters.buildingId)
        : allRooms;
    const view: "table" | "week" | "month" =
      filters.view === "table"
        ? "table"
        : filters.view === "month"
          ? "month"
          : "week";

    const cleaningJobsByBookingId = new Map<
      string,
      import("../../domain/types.js").CleaningJob
    >();
    for (const j of repo.cleaningJobs.values()) {
      cleaningJobsByBookingId.set(j.bookingId, j);
    }

    const filteredBookingsForCal = Array.from(repo.bookings.values()).filter(
      (b) =>
        (!filters.roomId || b.roomId === filters.roomId) &&
        (!filters.buildingId ||
          calendarRooms.some((r) => r.id === b.roomId)),
    );

    const calendar =
      view === "week"
        ? buildWeekView({
            bookings: filteredBookingsForCal,
            guests: repo.guests,
            rooms: calendarRooms,
            maintenance: repo.maintenanceBlocks,
            filters: filters as Record<string, string | undefined>,
            anchorDate: filters.cal,
          })
        : null;

    const monthGrid =
      view === "month"
        ? buildMonthGrid({
            bookings: filteredBookingsForCal,
            guests: repo.guests,
            rooms: repo.rooms,
            maintenance: repo.maintenanceBlocks,
            filters: filters as Record<string, string | undefined>,
            anchorMonth: filters.cal,
          })
        : null;

    res.render("admin/index", {
      title: "Admin dashboard",
      bookings,
      rooms: allRooms,
      calendarRooms,
      buildings: Array.from(repo.buildings.values()),
      agents: Array.from(repo.users.values()).filter(
        (u) => u.role === "sales_agent",
      ),
      users: repo.users,
      filters,
      view,
      calendar,
      monthGrid,
      guestForBooking: (b: { guestId: string }) => repo.guests.get(b.guestId),
      roomForBooking: (b: { roomId: string }) => repo.rooms.get(b.roomId),
      cleaningJobForBooking: (b: { id: string }) =>
        cleaningJobsByBookingId.get(b.id),
    });
  });

  router.get("/bookings/:id", (req, res) => {
    const booking = repo.bookings.get(req.params.id);
    if (!booking) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const guest = repo.guests.get(booking.guestId);
    const room = repo.rooms.get(booking.roomId);
    const building = room ? repo.buildings.get(room.buildingId) : undefined;
    const agent = booking.salesAgentId
      ? repo.users.get(booking.salesAgentId)
      : undefined;
    const proofs = Array.from(repo.paymentProofs.values()).filter(
      (p) => p.bookingId === booking.id,
    );
    const cleaningJob = Array.from(repo.cleaningJobs.values()).find(
      (j) => j.bookingId === booking.id,
    );
    const cleaner =
      cleaningJob && cleaningJob.assignedToUserId
        ? repo.users.get(cleaningJob.assignedToUserId)
        : undefined;
    const cancellation = Array.from(repo.cancellationRequests.values()).find(
      (c) => c.bookingId === booking.id,
    );
    const minibarLines = repo.minibarUsage
      .filter((u) => u.bookingId === booking.id)
      .map((u) => ({ ...u, item: repo.minibarItems.get(u.minibarItemId) }));
    const ledgerEntries = Array.from(repo.commissionLedger.values()).filter(
      (e) => e.bookingId === booking.id,
    );
    const discount = booking.discountIdApplied
      ? repo.discounts.find((d) => d.id === booking.discountIdApplied)
      : undefined;
    res.render("admin/booking", {
      title: `Booking ${booking.bookingNumber}`,
      booking,
      guest,
      room,
      building,
      agent,
      cleaner,
      proofs,
      cleaningJob,
      cancellation,
      minibarLines,
      ledgerEntries,
      discount,
      cleaners: Array.from(repo.cleaningCrewProfiles.values()).map((p) => ({
        ...p,
        user: repo.users.get(p.userId),
      })),
    });
  });

  const editSchema = z.object({
    checkInAt: z.string().optional(),
    checkInDate: z.string().optional(),
    checkInTime: z.string().optional(),
    checkOutAt: z.string().optional(),
    checkOutDate: z.string().optional(),
    checkOutTime: z.string().optional(),
    bookingType: z.enum(["hourly", "day", "multi_day"]).optional(),
    notes: z.string().optional(),
  });

  function composeAdminDateTime(
    direct?: string,
    date?: string,
    time?: string,
  ): string | undefined {
    if (direct && direct.length > 0) return direct;
    if (date && time) return `${date}T${time}`;
    return undefined;
  }

  router.post("/bookings/:id/edit", async (req, res) => {
    const booking = repo.bookings.get(req.params.id);
    if (!booking) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const parsed = editSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", {
        title: "Invalid edit",
        message: "Check the dates.",
      });
      return;
    }
    const room = repo.rooms.get(booking.roomId);
    if (!room) {
      res.status(404).render("error", { title: "Room missing", message: "" });
      return;
    }
    const inRaw = composeAdminDateTime(
      parsed.data.checkInAt,
      parsed.data.checkInDate,
      parsed.data.checkInTime,
    );
    const outRaw = composeAdminDateTime(
      parsed.data.checkOutAt,
      parsed.data.checkOutDate,
      parsed.data.checkOutTime,
    );
    if (!inRaw || !outRaw) {
      res
        .status(400)
        .render("error", { title: "Invalid dates", message: "" });
      return;
    }
    try {
      const before = snapshotBooking(booking);
      const reqIn = parseVietnamLocal(inRaw);
      const reqOut = parseVietnamLocal(outRaw);
      const { detectBookingType } = await import("../../services/pricing.js");
      const newType = parsed.data.bookingType ?? detectBookingType(reqIn, reqOut);
      booking.bookingType = newType;
      editBookingTimes({
        booking,
        room,
        rates: repo.rates,
        requestedCheckIn: reqIn,
        requestedCheckOut: reqOut,
      });
      booking.notes = parsed.data.notes ?? booking.notes;
      audit(repo, req, {
        action: "booking.edit",
        entityType: "booking",
        entityId: booking.id,
        before,
        after: snapshotBooking(booking),
      });
      if (booking.status === "extra_payment_required")
        notify("extra_payment_required", { bookingId: booking.id });
      if (booking.status === "refund_pending")
        notify("refund_pending", { bookingId: booking.id });
      res.redirect(`/admin/bookings/${booking.id}`);
    } catch (err) {
      res.status(400).render("error", {
        title: "Cannot edit",
        message: (err as Error).message,
      });
    }
  });

  router.post("/bookings/:id/delete", (req, res) => {
    const booking = repo.bookings.get(req.params.id);
    if (!booking) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    // Cascade: drop everything that referenced this booking.
    for (const p of Array.from(repo.payments.values())) {
      if (p.bookingId === booking.id) repo.payments.delete(p.id);
    }
    for (const p of Array.from(repo.paymentProofs.values())) {
      if (p.bookingId === booking.id) repo.paymentProofs.delete(p.id);
    }
    for (const j of Array.from(repo.cleaningJobs.values())) {
      if (j.bookingId === booking.id) repo.cleaningJobs.delete(j.id);
    }
    for (const c of Array.from(repo.cancellationRequests.values())) {
      if (c.bookingId === booking.id) repo.cancellationRequests.delete(c.id);
    }
    for (const e of Array.from(repo.commissionLedger.values())) {
      if (e.bookingId === booking.id) repo.commissionLedger.delete(e.id);
    }
    repo.minibarUsage = repo.minibarUsage.filter(
      (u) => u.bookingId !== booking.id,
    );
    repo.bookingsByNumber.delete(booking.bookingNumber);
    repo.bookings.delete(booking.id);
    audit(repo, req, {
      action: "booking.delete",
      entityType: "booking",
      entityId: booking.id,
      before: {
        bookingNumber: booking.bookingNumber,
        status: booking.status,
        guestId: booking.guestId,
        roomId: booking.roomId,
      },
    });
    res.redirect("/admin");
  });

  router.post("/bookings/_bulk/delete-cancelled", (req, res) => {
    const removed: string[] = [];
    for (const b of Array.from(repo.bookings.values())) {
      if (b.status === "cancelled" || b.status === "closed") {
        repo.bookings.delete(b.id);
        repo.bookingsByNumber.delete(b.bookingNumber);
        // Cascade like the per-booking delete above.
        for (const p of Array.from(repo.payments.values())) {
          if (p.bookingId === b.id) repo.payments.delete(p.id);
        }
        for (const p of Array.from(repo.paymentProofs.values())) {
          if (p.bookingId === b.id) repo.paymentProofs.delete(p.id);
        }
        for (const j of Array.from(repo.cleaningJobs.values())) {
          if (j.bookingId === b.id) repo.cleaningJobs.delete(j.id);
        }
        for (const c of Array.from(repo.cancellationRequests.values())) {
          if (c.bookingId === b.id) repo.cancellationRequests.delete(c.id);
        }
        for (const e of Array.from(repo.commissionLedger.values())) {
          if (e.bookingId === b.id) repo.commissionLedger.delete(e.id);
        }
        repo.minibarUsage = repo.minibarUsage.filter(
          (u) => u.bookingId !== b.id,
        );
        removed.push(b.bookingNumber);
      }
    }
    audit(repo, req, {
      action: "booking.bulk_delete_cancelled",
      entityType: "booking",
      entityId: "*",
      after: { count: removed.length, removed },
    });
    res.redirect("/admin");
  });

  router.post("/bookings/:id/cancel", (req, res) => {
    const booking = repo.bookings.get(req.params.id);
    if (!booking) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const reviewer = (
      req as unknown as {
        currentUser: { id: string; role: "admin" | "manager" };
      }
    ).currentUser;
    const existing = Array.from(repo.cancellationRequests.values()).find(
      (c) => c.bookingId === booking.id && c.status === "requested",
    );
    const request =
      existing ??
      requestCancellation({
        id: nextId("cancel"),
        booking,
        requestedBy: {
          id: reviewer.id,
          role: reviewer.role,
          fullName: "",
          email: "",
          isActive: true,
        },
      });
    if (!existing) repo.cancellationRequests.set(request.id, request);
    approveCancellation({
      booking,
      request,
      approvedBy: {
        id: reviewer.id,
        role: reviewer.role,
        fullName: "",
        email: "",
        isActive: true,
      },
      now: new Date(),
      tiers: repo.cancellationPolicy,
    });
    audit(repo, req, {
      action: "booking.cancel",
      entityType: "booking",
      entityId: booking.id,
      after: {
        status: booking.status,
        cancellationFeeVnd: request.cancellationFeeVnd,
      },
    });
    notify("cancellation_approved", { bookingId: booking.id });
    res.redirect(`/admin/bookings/${booking.id}`);
  });

  router.post("/bookings/:id/proof-invalid", (req, res) => {
    const booking = repo.bookings.get(req.params.id);
    if (!booking) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const proof = Array.from(repo.paymentProofs.values()).find(
      (p) => p.bookingId === booking.id && p.status !== "invalid",
    );
    if (!proof) {
      res
        .status(400)
        .render("error", { title: "No proof to invalidate", message: "" });
      return;
    }
    const reviewer = (
      req as unknown as {
        currentUser: { id: string; role: "admin" | "manager" };
      }
    ).currentUser;
    markPaymentProofInvalid({
      proof,
      booking,
      reviewer: {
        id: reviewer.id,
        role: reviewer.role,
        fullName: "",
        email: "",
        isActive: true,
      },
      reason: String(req.body.reason ?? "Marked invalid"),
    });
    audit(repo, req, {
      action: "booking.proof_invalidated",
      entityType: "booking",
      entityId: booking.id,
      notes: String(req.body.reason ?? ""),
    });
    notify("payment_proof_invalid", { bookingId: booking.id });
    res.redirect(`/admin/bookings/${booking.id}`);
  });

  router.post("/bookings/:id/assign-cleaner", (req, res) => {
    const booking = repo.bookings.get(req.params.id);
    if (!booking) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const cleanerId = String(req.body.cleanerId ?? "").trim();
    const profile = repo.cleaningCrewProfiles.get(cleanerId);
    if (!profile) {
      res
        .status(400)
        .render("error", { title: "Unknown cleaner", message: "" });
      return;
    }
    const existing = Array.from(repo.cleaningJobs.values()).find(
      (j) => j.bookingId === booking.id,
    );
    if (existing) {
      existing.assignedToUserId = cleanerId;
      existing.fixedPayVnd = profile.fixedPayPerJobVnd;
      audit(repo, req, {
        action: "cleaning.assigned",
        entityType: "booking",
        entityId: booking.id,
        notes: `cleaner=${cleanerId}`,
      });
      notify("cleaning_assigned", { bookingId: booking.id });
      res.redirect(`/admin/bookings/${booking.id}`);
      return;
    }
    const filteredAvailability = repo.cleaningAvailability.filter(
      (a) => a.cleaningCrewUserId === cleanerId,
    );
    try {
      const job = autoAssignCleaningJob({
        id: nextId("cleaning"),
        booking,
        availability: filteredAvailability,
        crewProfiles: [profile],
      });
      repo.cleaningJobs.set(job.id, job);
      audit(repo, req, {
        action: "cleaning.assigned",
        entityType: "booking",
        entityId: booking.id,
        notes: `cleaner=${cleanerId}`,
      });
      notify("cleaning_assigned", { bookingId: booking.id });
    } catch (err) {
      res.status(400).render("error", {
        title: "Cannot assign",
        message: (err as Error).message,
      });
      return;
    }
    res.redirect(`/admin/bookings/${booking.id}`);
  });

  router.post("/bookings/:id/notes", (req, res) => {
    const booking = repo.bookings.get(req.params.id);
    if (!booking) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    booking.notes = String(req.body.notes ?? "");
    res.redirect(`/admin/bookings/${booking.id}`);
  });

  router.get("/refunds", (_req, res) => {
    // Refunds remain pending even after cancellation if money is still owed.
    // Hide closed bookings (admin marked the refund as settled).
    const bookings = Array.from(repo.bookings.values()).filter(
      (b) =>
        b.status !== "closed" &&
        (b.status === "refund_pending" || b.refundDueVnd > 0),
    );
    res.render("admin/list-finance", {
      title: "Pending refunds",
      heading: "Pending refunds",
      column: "refundDueVnd",
      bookings,
      guestForBooking: (b: { guestId: string }) => repo.guests.get(b.guestId),
      roomForBooking: (b: { roomId: string }) => repo.rooms.get(b.roomId),
    });
  });

  router.get("/today", (_req, res) => {
    const checklist = computeDailyChecklist({
      bookings: repo.bookings.values(),
      cleaningJobs: repo.cleaningJobs.values(),
    });
    res.render("admin/today", {
      title: "Today's operations",
      checklist,
      guestForBooking: (b: { guestId: string }) => repo.guests.get(b.guestId),
      roomForBooking: (b: { roomId: string }) => repo.rooms.get(b.roomId),
      bookingForJob: (j: { bookingId: string }) =>
        repo.bookings.get(j.bookingId),
      roomForJob: (j: { roomId: string }) => repo.rooms.get(j.roomId),
    });
  });

  router.get("/extras", (_req, res) => {
    // Extras only apply to live bookings — cancelled/closed don't owe more.
    const bookings = Array.from(repo.bookings.values()).filter(
      (b) =>
        b.status !== "cancelled" &&
        b.status !== "closed" &&
        (b.status === "extra_payment_required" || b.amountDueVnd > 0),
    );
    res.render("admin/list-finance", {
      title: "Pending extra payments",
      heading: "Pending extra payments",
      column: "amountDueVnd",
      bookings,
      guestForBooking: (b: { guestId: string }) => repo.guests.get(b.guestId),
      roomForBooking: (b: { roomId: string }) => repo.rooms.get(b.roomId),
    });
  });

  router.get("/commissions", (_req, res) => {
    const entries = Array.from(repo.commissionLedger.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    res.render("admin/commissions", {
      title: "Commissions",
      entries,
      agents: repo.users,
      bookingForEntry: (e: { bookingId: string }) =>
        repo.bookings.get(e.bookingId),
    });
  });

  router.post("/commissions/:id/approve", (req, res) => {
    const entry = repo.commissionLedger.get(req.params.id as string);
    const user = (req as RequestWithUser).currentUser!;
    if (!entry) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    try {
      approveCommission(entry, user);
      audit(repo, req, {
        action: "commission.approved",
        entityType: "commission",
        entityId: entry.id,
      });
    } catch (err) {
      res.status(400).render("error", {
        title: "Cannot approve",
        message: (err as Error).message,
      });
      return;
    }
    res.redirect("/admin/commissions");
  });

  router.post("/commissions/:id/paid", (req, res) => {
    const entry = repo.commissionLedger.get(req.params.id as string);
    const user = (req as RequestWithUser).currentUser!;
    if (!entry) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    try {
      markCommissionPaid(entry, user, new Date(), String(req.body.notes ?? ""));
      audit(repo, req, {
        action: "commission.paid",
        entityType: "commission",
        entityId: entry.id,
      });
    } catch (err) {
      res.status(400).render("error", {
        title: "Cannot mark paid",
        message: (err as Error).message,
      });
      return;
    }
    res.redirect("/admin/commissions");
  });

  router.post("/commissions/:id/void", (req, res) => {
    const entry = repo.commissionLedger.get(req.params.id as string);
    const user = (req as RequestWithUser).currentUser!;
    if (!entry) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    try {
      voidCommission(entry, user, new Date(), String(req.body.notes ?? ""));
      audit(repo, req, {
        action: "commission.voided",
        entityType: "commission",
        entityId: entry.id,
      });
    } catch (err) {
      res.status(400).render("error", {
        title: "Cannot void",
        message: (err as Error).message,
      });
      return;
    }
    res.redirect("/admin/commissions");
  });

  router.get("/pricing", (req, res) => {
    const roomId = String(
      req.query.roomId ?? Array.from(repo.rooms.keys())[0] ?? "",
    );
    const room = repo.rooms.get(roomId);
    const now = new Date();
    const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const rates = repo.rates
      .filter((r) => r.roomId === roomId && r.rateDate >= monthStart)
      .sort((a, b) => a.rateDate.localeCompare(b.rateDate));
    const buildings = Array.from(repo.buildings.values());
    const allRooms = Array.from(repo.rooms.values()).sort((a, b) =>
      (a.roomNumber || a.name).localeCompare(b.roomNumber || b.name),
    );
    res.render("admin/pricing", {
      title: "Pricing",
      rooms: allRooms,
      buildings,
      room,
      rates,
      flash: req.query.flash || null,
    });
  });

  // Remove a single per-day override.
  router.post("/pricing/remove", (req, res) => {
    const roomId = String(req.body.roomId ?? "");
    const rateDate = String(req.body.rateDate ?? "");
    const idx = repo.rates.findIndex(
      (r) => r.roomId === roomId && r.rateDate === rateDate,
    );
    if (idx >= 0) {
      const before = repo.rates[idx];
      repo.rates.splice(idx, 1);
      audit(repo, req, {
        action: "pricing.remove",
        entityType: "room_daily_rate",
        entityId: `${roomId}@${rateDate}`,
        before: before as unknown as Record<string, unknown>,
      });
    }
    res.redirect(`/admin/pricing?roomId=${roomId}&flash=removed`);
  });

  // Clear all overrides for a room (useful when seed left a backlog).
  router.post("/pricing/clear-all", (req, res) => {
    const roomId = String(req.body.roomId ?? "");
    const removed = repo.rates.filter((r) => r.roomId === roomId).length;
    repo.rates = repo.rates.filter((r) => r.roomId !== roomId);
    audit(repo, req, {
      action: "pricing.clear_all",
      entityType: "room_daily_rate",
      entityId: roomId,
      after: { removed },
    });
    res.redirect(`/admin/pricing?roomId=${roomId}&flash=cleared`);
  });

  // Rates come in from the form in thousands of VND ("900" → 900,000) so the
  // user can type "900" or "1500" without the trailing zeros.
  const singleRateSchema = z.object({
    roomId: z.string(),
    rateDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dayRateK: z.coerce.number().nonnegative(),
    hourlyRateK: z.coerce.number().nonnegative(),
    rate2hK: z.string().optional(),
    rate4hK: z.string().optional(),
    rate6hK: z.string().optional(),
    rate8hK: z.string().optional(),
    rate12hK: z.string().optional(),
    isSpecial: z.string().optional(),
    note: z.string().optional(),
  });

  router.post("/pricing/edit", (req, res) => {
    const parsed = singleRateSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .render("error", { title: "Invalid pricing", message: "" });
      return;
    }
    const dayRateVnd = Math.round(parsed.data.dayRateK * 1000);
    const hourlyRateVnd = Math.round(parsed.data.hourlyRateK * 1000);
    const tiers = parseTiersK(parsed.data);
    const isSpecial = parsed.data.isSpecial === "1";
    const note = parsed.data.note?.trim() || undefined;
    const before = repo.rates.find(
      (r) =>
        r.roomId === parsed.data.roomId && r.rateDate === parsed.data.rateDate,
    );
    const beforeSnapshot = before ? { ...before } : undefined;
    if (before) {
      before.dayRateVnd = dayRateVnd;
      before.hourlyRateVnd = hourlyRateVnd;
      before.hourlyTiers = tiers;
      before.isSpecial = isSpecial || undefined;
      before.note = note;
    } else {
      repo.rates.push({
        roomId: parsed.data.roomId,
        rateDate: parsed.data.rateDate,
        dayRateVnd,
        hourlyRateVnd,
        hourlyTiers: tiers,
        isSpecial: isSpecial || undefined,
        note,
      });
    }
    audit(repo, req, {
      action: "pricing.edit",
      entityType: "room_daily_rate",
      entityId: `${parsed.data.roomId}@${parsed.data.rateDate}`,
      before: beforeSnapshot,
      after: {
        ...parsed.data,
        dayRateVnd,
        hourlyRateVnd,
        hourlyTiers: tiers,
        isSpecial,
        note,
      },
    });
    res.redirect(`/admin/pricing?roomId=${parsed.data.roomId}&flash=saved`);
  });

  const bulkRateSchema = z.object({
    roomId: z.string(),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    weekdayRateK: z.string().optional(),
    weekendRateK: z.string().optional(),
    hourlyRateK: z.string().optional(),
    rate2hK: z.string().optional(),
    rate4hK: z.string().optional(),
    rate6hK: z.string().optional(),
    rate8hK: z.string().optional(),
    rate12hK: z.string().optional(),
    markSpecial: z.string().optional(),
    note: z.string().optional(),
  });

  router.post("/pricing/bulk", (req, res) => {
    const parsed = bulkRateSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .render("error", { title: "Invalid bulk edit", message: "" });
      return;
    }
    const start = new Date(`${parsed.data.fromDate}T00:00:00Z`);
    const end = new Date(`${parsed.data.toDate}T00:00:00Z`);
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end < start
    ) {
      res.status(400).render("error", { title: "Bad date range", message: "" });
      return;
    }
    const weekdayRateVnd = parseOptionalK(parsed.data.weekdayRateK);
    const weekendRateVnd = parseOptionalK(parsed.data.weekendRateK);
    const hourlyRateVnd = parseOptionalK(parsed.data.hourlyRateK);
    const tiers = parseTiersK(parsed.data);
    const markSpecial = parsed.data.markSpecial === "1";
    const note = parsed.data.note?.trim() || undefined;

    let cursor = start;
    let count = 0;
    while (cursor <= end) {
      const dateKey = cursor.toISOString().slice(0, 10);
      const dow = cursor.getUTCDay();
      const isWeekend = dow === 0 || dow === 6;
      const targetDayRate = isWeekend
        ? (weekendRateVnd ?? weekdayRateVnd)
        : weekdayRateVnd;
      let existing = repo.rates.find(
        (r) => r.roomId === parsed.data.roomId && r.rateDate === dateKey,
      );
      if (!existing) {
        existing = {
          roomId: parsed.data.roomId,
          rateDate: dateKey,
          dayRateVnd: targetDayRate ?? 0,
          hourlyRateVnd: hourlyRateVnd ?? 0,
        };
        repo.rates.push(existing);
      }
      if (targetDayRate !== undefined) existing.dayRateVnd = targetDayRate;
      if (hourlyRateVnd !== undefined) existing.hourlyRateVnd = hourlyRateVnd;
      if (tiers) existing.hourlyTiers = tiers;
      if (markSpecial) existing.isSpecial = true;
      if (note !== undefined) existing.note = note;
      count += 1;
      cursor = new Date(cursor.getTime() + 24 * 60 * 60_000);
    }
    audit(repo, req, {
      action: "pricing.bulk_edit",
      entityType: "room_daily_rate",
      entityId: parsed.data.roomId,
      after: {
        ...parsed.data,
        weekdayRateVnd,
        weekendRateVnd,
        hourlyRateVnd,
        tiers,
        markSpecial,
        note,
        count,
      },
    });
    res.redirect(
      `/admin/pricing?roomId=${parsed.data.roomId}&flash=bulk-${count}`,
    );
  });

  // Apply a percentage adjustment (signed: -10 = 10% off, +15 = 15% up) to a
  // date range across one or more rooms. The adjustment is computed against
  // each room's own defaults (weekday/weekend day rate, per-hour, tiers).
  const bulkPercentSchema = z.object({
    roomIds: z.union([z.string(), z.array(z.string())]),
    contextRoomId: z.string().optional(),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    percent: z.coerce.number(),
    markSpecial: z.string().optional(),
    note: z.string().optional(),
  });

  router.post("/pricing/bulk-percent", (req, res) => {
    const parsed = bulkPercentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", {
        title: "Invalid percent adjustment",
        message: "",
      });
      return;
    }
    const start = new Date(`${parsed.data.fromDate}T00:00:00Z`);
    const end = new Date(`${parsed.data.toDate}T00:00:00Z`);
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end < start
    ) {
      res.status(400).render("error", { title: "Bad date range", message: "" });
      return;
    }
    const roomIds = Array.isArray(parsed.data.roomIds)
      ? parsed.data.roomIds
      : [parsed.data.roomIds];
    const factor = 1 + parsed.data.percent / 100;
    const markSpecial = parsed.data.markSpecial === "1";
    const note = parsed.data.note?.trim() || undefined;

    const adj = (vnd: number | undefined): number | undefined =>
      vnd === undefined ? undefined : Math.round((vnd * factor) / 1000) * 1000;

    let count = 0;
    for (const rid of roomIds) {
      const r = repo.rooms.get(rid);
      if (!r) continue;
      let cursor = new Date(start);
      while (cursor <= end) {
        const dateKey = cursor.toISOString().slice(0, 10);
        const dow = cursor.getUTCDay();
        const isWeekend = dow === 0 || dow === 6;
        const baseDay = isWeekend
          ? (r.baseWeekendRateVnd ?? r.baseDayRateVnd)
          : r.baseDayRateVnd;
        const newDay = adj(baseDay) ?? baseDay;
        const newHourly = adj(r.baseHourlyRateVnd) ?? r.baseHourlyRateVnd;
        const baseTiers = r.baseHourlyTiers;
        const newTiers = baseTiers
          ? {
              rate2hVnd: adj(baseTiers.rate2hVnd),
              rate4hVnd: adj(baseTiers.rate4hVnd),
              rate6hVnd: adj(baseTiers.rate6hVnd),
              rate8hVnd: adj(baseTiers.rate8hVnd),
              rate12hVnd: adj(baseTiers.rate12hVnd),
            }
          : undefined;
        let existing = repo.rates.find(
          (x) => x.roomId === rid && x.rateDate === dateKey,
        );
        if (!existing) {
          existing = {
            roomId: rid,
            rateDate: dateKey,
            dayRateVnd: newDay,
            hourlyRateVnd: newHourly,
          };
          repo.rates.push(existing);
        } else {
          existing.dayRateVnd = newDay;
          existing.hourlyRateVnd = newHourly;
        }
        if (newTiers) existing.hourlyTiers = newTiers;
        if (markSpecial) existing.isSpecial = true;
        if (note !== undefined) existing.note = note;
        count += 1;
        cursor = new Date(cursor.getTime() + 24 * 60 * 60_000);
      }
    }
    audit(repo, req, {
      action: "pricing.bulk_percent",
      entityType: "room_daily_rate",
      entityId: roomIds.join(","),
      after: {
        rooms: roomIds,
        from: parsed.data.fromDate,
        to: parsed.data.toDate,
        percent: parsed.data.percent,
        markSpecial,
        note,
        count,
      },
    });
    const back = parsed.data.contextRoomId || roomIds[0];
    res.redirect(
      `/admin/pricing?roomId=${back}&flash=percent-${parsed.data.percent}-${count}`,
    );
  });

  // Remove a list of overrides (selected via checkboxes in the table).
  const bulkRemoveSchema = z.object({
    roomId: z.string(),
    dates: z.union([z.string(), z.array(z.string())]),
  });

  router.post("/pricing/bulk-remove", (req, res) => {
    const parsed = bulkRemoveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.redirect("/admin/pricing");
      return;
    }
    const dates = new Set(
      Array.isArray(parsed.data.dates) ? parsed.data.dates : [parsed.data.dates],
    );
    const before = repo.rates.length;
    repo.rates = repo.rates.filter(
      (r) => !(r.roomId === parsed.data.roomId && dates.has(r.rateDate)),
    );
    const removed = before - repo.rates.length;
    audit(repo, req, {
      action: "pricing.bulk_remove",
      entityType: "room_daily_rate",
      entityId: parsed.data.roomId,
      after: { dates: Array.from(dates), removed },
    });
    res.redirect(
      `/admin/pricing?roomId=${parsed.data.roomId}&flash=removed-${removed}`,
    );
  });

  const copySchema = z.object({
    fromRoomId: z.string(),
    toRoomId: z.string(),
  });

  router.post("/pricing/copy", (req, res) => {
    const parsed = copySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid copy", message: "" });
      return;
    }
    if (parsed.data.fromRoomId === parsed.data.toRoomId) {
      res.status(400).render("error", {
        title: "Same room",
        message: "Pick a different target room.",
      });
      return;
    }
    const sourceRates = repo.rates.filter(
      (r) => r.roomId === parsed.data.fromRoomId,
    );
    repo.rates = repo.rates.filter((r) => r.roomId !== parsed.data.toRoomId);
    for (const r of sourceRates) {
      repo.rates.push({ ...r, roomId: parsed.data.toRoomId });
    }
    audit(repo, req, {
      action: "pricing.copy",
      entityType: "room",
      entityId: parsed.data.toRoomId,
      after: { fromRoomId: parsed.data.fromRoomId, count: sourceRates.length },
    });
    res.redirect(`/admin/pricing?roomId=${parsed.data.toRoomId}&flash=copied`);
  });

  // ---------- Properties (buildings + rooms) ----------
  router.get("/properties", (_req, res) => {
    const rooms = Array.from(repo.rooms.values()).sort(
      (a, b) =>
        a.buildingId.localeCompare(b.buildingId) ||
        (a.roomNumber || a.name).localeCompare(b.roomNumber || b.name),
    );
    res.render("admin/properties", {
      title: "Properties",
      buildings: Array.from(repo.buildings.values()),
      rooms,
      buildingForRoom: (r: { buildingId: string }) =>
        repo.buildings.get(r.buildingId),
    });
  });

  const buildingSchema = z.object({
    name: z.string().min(1),
    address: z.string().min(1),
    city: z.string().min(1),
    district: z.string().optional(),
  });

  router.post("/properties/buildings", (req, res) => {
    const parsed = buildingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid building", message: "" });
      return;
    }
    const id = nextId("building");
    const b = {
      id,
      name: parsed.data.name,
      address: parsed.data.address,
      city: parsed.data.city,
      district: parsed.data.district || undefined,
    };
    repo.buildings.set(id, b);
    audit(repo, req, {
      action: "building.create",
      entityType: "building",
      entityId: id,
      after: b as Record<string, unknown>,
    });
    res.redirect("/admin/properties");
  });

  router.post("/properties/buildings/:id", (req, res) => {
    const b = repo.buildings.get(req.params.id as string);
    if (!b) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const parsed = buildingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid building", message: "" });
      return;
    }
    const before = { ...b };
    b.name = parsed.data.name;
    b.address = parsed.data.address;
    b.city = parsed.data.city;
    b.district = parsed.data.district || undefined;
    audit(repo, req, {
      action: "building.edit",
      entityType: "building",
      entityId: b.id,
      before: before as unknown as Record<string, unknown>,
      after: { ...b } as unknown as Record<string, unknown>,
    });
    res.redirect("/admin/properties");
  });

  function parseLines(value: string | undefined): string[] {
    if (!value) return [];
    return value
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  const roomSchema = z.object({
    buildingId: z.string().min(1),
    name: z.string().min(1),
    roomNumber: z.string().optional(),
    maxGuests: z.coerce.number().int().positive(),
    baseDayRateK: z.coerce.number().nonnegative(),
    baseWeekendRateK: z.string().optional(),
    baseHourlyRateK: z.coerce.number().nonnegative(),
    rate2hK: z.string().optional(),
    rate4hK: z.string().optional(),
    rate6hK: z.string().optional(),
    rate8hK: z.string().optional(),
    rate12hK: z.string().optional(),
    hourlyEnabled: z.string().optional(),
    description: z.string().optional(),
    features: z.string().optional(),
    photoUrls: z.string().optional(),
    videoUrls: z.string().optional(),
    isActive: z.string().optional(),
  });

  function parseTiersK(data: {
    rate2hK?: string;
    rate4hK?: string;
    rate6hK?: string;
    rate8hK?: string;
    rate12hK?: string;
  }): import("../../domain/types.js").HourlyTierRates | undefined {
    const t: import("../../domain/types.js").HourlyTierRates = {};
    const set = (
      v: string | undefined,
      k: keyof import("../../domain/types.js").HourlyTierRates,
    ) => {
      if (v === undefined || v === "") return;
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) t[k] = Math.round(n * 1000);
    };
    set(data.rate2hK, "rate2hVnd");
    set(data.rate4hK, "rate4hVnd");
    set(data.rate6hK, "rate6hVnd");
    set(data.rate8hK, "rate8hVnd");
    set(data.rate12hK, "rate12hVnd");
    return Object.keys(t).length > 0 ? t : undefined;
  }

  function parseOptionalK(value: string | undefined): number | undefined {
    if (value === undefined || value === "") return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return Math.round(n * 1000);
  }

  router.post(
    "/properties/rooms",
    screenshotUpload.array("photoFiles", 12),
    (req, res) => {
      const parsed = roomSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .render("error", { title: "Invalid room", message: "" });
        return;
      }
      const uploadedPhotoUrls = ((req.files as Express.Multer.File[]) || []).map(
        (f) => `/uploads/${path.basename(f.path)}`,
      );
      const id = nextId("room");
      const room = {
        id,
        buildingId: parsed.data.buildingId,
        name: parsed.data.name,
        roomNumber: parsed.data.roomNumber || undefined,
        maxGuests: parsed.data.maxGuests,
        baseDayRateVnd: Math.round(parsed.data.baseDayRateK * 1000),
        baseWeekendRateVnd: parseOptionalK(parsed.data.baseWeekendRateK),
        baseHourlyRateVnd: Math.round(parsed.data.baseHourlyRateK * 1000),
        baseHourlyTiers: parseTiersK(parsed.data),
        hourlyEnabled: parsed.data.hourlyEnabled === "1",
        isActive: parsed.data.isActive === "1",
        description: parsed.data.description || undefined,
        features: parseLines(parsed.data.features),
        photoUrls: [...parseLines(parsed.data.photoUrls), ...uploadedPhotoUrls],
        videoUrls: parseLines(parsed.data.videoUrls),
        syncStatus: "not_synced" as const,
      };
      repo.rooms.set(id, room);
      audit(repo, req, {
        action: "room.create",
        entityType: "room",
        entityId: id,
        after: room as Record<string, unknown>,
      });
      res.redirect("/admin/properties");
    },
  );

  router.post(
    "/properties/rooms/:id",
    screenshotUpload.array("photoFiles", 12),
    (req, res) => {
      const room = repo.rooms.get(req.params.id as string);
      if (!room) {
        res.status(404).render("error", { title: "Not found", message: "" });
        return;
      }
      const parsed = roomSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).render("error", { title: "Invalid room", message: "" });
        return;
      }
      const uploadedPhotoUrls = ((req.files as Express.Multer.File[]) || []).map(
        (f) => `/uploads/${path.basename(f.path)}`,
      );
      const before = { ...room };
      room.buildingId = parsed.data.buildingId;
      room.name = parsed.data.name;
      room.roomNumber = parsed.data.roomNumber || undefined;
      room.maxGuests = parsed.data.maxGuests;
      room.baseDayRateVnd = Math.round(parsed.data.baseDayRateK * 1000);
      room.baseWeekendRateVnd = parseOptionalK(parsed.data.baseWeekendRateK);
      room.baseHourlyRateVnd = Math.round(parsed.data.baseHourlyRateK * 1000);
      room.baseHourlyTiers = parseTiersK(parsed.data);
      room.hourlyEnabled = parsed.data.hourlyEnabled === "1";
      room.isActive = parsed.data.isActive === "1";
      room.description = parsed.data.description || undefined;
      room.features = parseLines(parsed.data.features);
      room.photoUrls = [
        ...parseLines(parsed.data.photoUrls),
        ...uploadedPhotoUrls,
      ];
      room.videoUrls = parseLines(parsed.data.videoUrls);
      audit(repo, req, {
        action: "room.edit",
        entityType: "room",
        entityId: room.id,
        before: before as unknown as Record<string, unknown>,
        after: { ...room } as unknown as Record<string, unknown>,
      });
      res.redirect("/admin/properties");
    },
  );

  router.post("/properties/rooms/:id/photos/remove", (req, res) => {
    const room = repo.rooms.get(req.params.id as string);
    if (!room) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const url = String(req.body.url ?? "");
    if (room.photoUrls) {
      room.photoUrls = room.photoUrls.filter((u) => u !== url);
    }
    audit(repo, req, {
      action: "room.photo_remove",
      entityType: "room",
      entityId: room.id,
      after: { url },
    });
    res.redirect("/admin/properties");
  });

  router.post("/properties/rooms/:id/delete", (req, res) => {
    const room = repo.rooms.get(req.params.id as string);
    if (!room) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const refs = Array.from(repo.bookings.values()).filter(
      (b) => b.roomId === room.id,
    ).length;
    if (refs > 0) {
      res.status(400).render("error", {
        title: "Cannot delete room",
        message: `${refs} booking(s) reference this room. Deactivate the room instead so existing history stays intact.`,
      });
      return;
    }
    repo.rooms.delete(room.id);
    audit(repo, req, {
      action: "room.delete",
      entityType: "room",
      entityId: room.id,
      before: room as unknown as Record<string, unknown>,
    });
    res.redirect("/admin/properties");
  });

  router.post("/properties/buildings/:id/delete", (req, res) => {
    const b = repo.buildings.get(req.params.id as string);
    if (!b) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const roomRefs = Array.from(repo.rooms.values()).filter(
      (r) => r.buildingId === b.id,
    ).length;
    if (roomRefs > 0) {
      res.status(400).render("error", {
        title: "Cannot delete building",
        message: `${roomRefs} room(s) belong to this building. Move or delete them first.`,
      });
      return;
    }
    repo.buildings.delete(b.id);
    audit(repo, req, {
      action: "building.delete",
      entityType: "building",
      entityId: b.id,
      before: b as unknown as Record<string, unknown>,
    });
    res.redirect("/admin/properties");
  });

  router.post("/properties/rooms/:id/toggle", (req, res) => {
    const room = repo.rooms.get(req.params.id as string);
    if (!room) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    room.isActive = !room.isActive;
    audit(repo, req, {
      action: "room.toggle",
      entityType: "room",
      entityId: room.id,
      after: { isActive: room.isActive },
    });
    res.redirect("/admin/properties");
  });

  // ---------- Sales agent management ----------
  function isoMondayOf(d: Date): string {
    // Monday (Vietnam-week-aligned, but use UTC date for stability) of week containing d.
    const day = d.getUTCDay(); // 0=Sun..6=Sat
    const diff = day === 0 ? 6 : day - 1;
    const monday = new Date(
      Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate() - diff,
      ),
    );
    return monday.toISOString().slice(0, 10);
  }

  type AgentWeeklyRow = {
    weekStartIso: string;
    bookingCount: number;
    netRevenueVnd: number;
    commissionVnd: number;
    paidAmountVnd: number;
    payments: Array<import("../../domain/types.js").AgentCommissionPayment>;
  };

  function buildAgentWeeklyRows(
    ledger: Array<import("../../domain/types.js").CommissionLedgerEntry>,
    payments: Array<import("../../domain/types.js").AgentCommissionPayment>,
  ): AgentWeeklyRow[] {
    const buckets = new Map<string, AgentWeeklyRow>();
    const get = (wk: string): AgentWeeklyRow => {
      let row = buckets.get(wk);
      if (!row) {
        row = {
          weekStartIso: wk,
          bookingCount: 0,
          netRevenueVnd: 0,
          commissionVnd: 0,
          paidAmountVnd: 0,
          payments: [],
        };
        buckets.set(wk, row);
      }
      return row;
    };
    for (const e of ledger) {
      if (e.status === "voided") continue;
      const wk = isoMondayOf(e.createdAt);
      const row = get(wk);
      const booking = repo.bookings.get(e.bookingId);
      if (booking) {
        row.bookingCount += 1;
        row.netRevenueVnd += booking.finalRoomChargeVnd;
      }
      row.commissionVnd += e.amountVnd;
    }
    for (const p of payments) {
      const row = get(p.weekStartIso);
      if (p.status !== "void") row.paidAmountVnd += p.amountVnd;
      row.payments.push(p);
    }
    const thisWeek = isoMondayOf(new Date());
    if (!buckets.has(thisWeek)) get(thisWeek);
    const rows = Array.from(buckets.values());
    rows.sort((a, b) => b.weekStartIso.localeCompare(a.weekStartIso));
    for (const r of rows) {
      r.payments.sort((x, y) => y.paidAt.getTime() - x.paidAt.getTime());
    }
    return rows;
  }

  function ledgerByAgentMap() {
    const m = new Map<
      string,
      Array<import("../../domain/types.js").CommissionLedgerEntry>
    >();
    for (const e of repo.commissionLedger.values()) {
      const arr = m.get(e.salesAgentId) ?? [];
      arr.push(e);
      m.set(e.salesAgentId, arr);
    }
    return m;
  }

  function agentPaymentsByAgentMap() {
    const m = new Map<
      string,
      Array<import("../../domain/types.js").AgentCommissionPayment>
    >();
    for (const p of repo.agentPayments) {
      const arr = m.get(p.salesAgentId) ?? [];
      arr.push(p);
      m.set(p.salesAgentId, arr);
    }
    return m;
  }

  router.get("/agents", (req, res) => {
    const agents = Array.from(repo.users.values()).filter(
      (u) => u.role === "sales_agent",
    );
    const ledgerByAgent = ledgerByAgentMap();
    const paymentsByAgent = agentPaymentsByAgentMap();
    const fromIso =
      typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)
        ? req.query.from
        : "";
    const toIso =
      typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)
        ? req.query.to
        : "";
    const inRange = (wk: string) =>
      (!fromIso || wk >= fromIso) && (!toIso || wk <= toIso);

    const agentRows = agents.map((a) => {
      const ledger = ledgerByAgent.get(a.id) ?? [];
      const payments = paymentsByAgent.get(a.id) ?? [];
      const weeklyRows = buildAgentWeeklyRows(ledger, payments).filter((r) =>
        inRange(r.weekStartIso),
      );
      const lifetimeBookings = weeklyRows.reduce(
        (s, r) => s + r.bookingCount,
        0,
      );
      const lifetimeNetRevenue = weeklyRows.reduce(
        (s, r) => s + r.netRevenueVnd,
        0,
      );
      const lifetimeEarned = weeklyRows.reduce(
        (s, r) => s + r.commissionVnd,
        0,
      );
      const lifetimePaid = weeklyRows.reduce((s, r) => s + r.paidAmountVnd, 0);
      return {
        agent: a,
        weeklyRows,
        lifetimeBookings,
        lifetimeNetRevenue,
        lifetimeEarned,
        lifetimePaid,
        rule: repo.commissionRules.find(
          (r) => r.salesAgentId === a.id && r.isActive,
        ),
        discounts: repo.discounts.filter(
          (d) => d.scope === "agent_specific" && d.salesAgentId === a.id,
        ),
      };
    });

    // All-agent aggregate: union all weeks, sum across agents.
    const allWeeks = new Map<string, AgentWeeklyRow>();
    for (const ar of agentRows) {
      for (const r of ar.weeklyRows) {
        let agg = allWeeks.get(r.weekStartIso);
        if (!agg) {
          agg = {
            weekStartIso: r.weekStartIso,
            bookingCount: 0,
            netRevenueVnd: 0,
            commissionVnd: 0,
            paidAmountVnd: 0,
            payments: [],
          };
          allWeeks.set(r.weekStartIso, agg);
        }
        agg.bookingCount += r.bookingCount;
        agg.netRevenueVnd += r.netRevenueVnd;
        agg.commissionVnd += r.commissionVnd;
        agg.paidAmountVnd += r.paidAmountVnd;
        agg.payments.push(...r.payments);
      }
    }
    const aggregateRows = Array.from(allWeeks.values()).sort((a, b) =>
      b.weekStartIso.localeCompare(a.weekStartIso),
    );

    const filteredAggregate = aggregateRows.filter((r) =>
      inRange(r.weekStartIso),
    );
    res.render("admin/agents", {
      title: "Sales agents",
      agentRows,
      aggregateRows: filteredAggregate,
      filters: { from: fromIso, to: toIso },
      countDiscountUsage: (discountId: string) =>
        Array.from(repo.bookings.values()).filter(
          (b) => b.discountIdApplied === discountId,
        ).length,
    });
  });

  const newAgentSchema = z.object({
    fullName: z.string().min(1),
    email: z.string().email(),
    phone: z.string().optional(),
    password: z.string().min(8),
    commissionType: z.enum(["percentage", "fixed"]),
    commissionValue: z.coerce.number().nonnegative(),
  });

  router.post("/agents", (req, res) => {
    const parsed = newAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid agent", message: "" });
      return;
    }
    const id = nextId("agent");
    const user = {
      id,
      role: "sales_agent" as const,
      fullName: parsed.data.fullName,
      email: parsed.data.email,
      phone: parsed.data.phone || undefined,
      isActive: true,
      passwordHash: bcrypt.hashSync(parsed.data.password, 8),
    };
    repo.users.set(id, user);
    // Fixed commission is entered in ₫'000s (e.g. "120" = 120,000 ₫); percentage stays as-is.
    const ruleValueVnd =
      parsed.data.commissionType === "fixed"
        ? Math.round(parsed.data.commissionValue * 1000)
        : parsed.data.commissionValue;
    const rule = {
      id: nextId("commission-rule"),
      salesAgentId: id,
      commissionType: parsed.data.commissionType,
      value: ruleValueVnd,
      isActive: true,
    };
    repo.commissionRules.push(rule);
    audit(repo, req, {
      action: "agent.create",
      entityType: "user",
      entityId: id,
      after: {
        fullName: user.fullName,
        email: user.email,
        commissionType: rule.commissionType,
        commissionValue: rule.value,
      },
    });
    res.redirect("/admin/agents");
  });

  const userEditSchema = z.object({
    fullName: z.string().min(1),
    email: z.string().email(),
    phone: z.string().optional(),
    password: z.string().optional(),
  });

  function applyUserEdit(
    user: import("../../domain/types.js").User,
    data: { fullName: string; email: string; phone?: string; password?: string },
  ) {
    const before = {
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      passwordChanged: false,
    };
    user.fullName = data.fullName;
    user.email = data.email;
    user.phone = data.phone?.trim() || undefined;
    let passwordChanged = false;
    if (data.password && data.password.length > 0) {
      if (data.password.length < 8) throw new Error("Password must be at least 8 characters.");
      user.passwordHash = bcrypt.hashSync(data.password, 8);
      passwordChanged = true;
    }
    return {
      before,
      after: {
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        passwordChanged,
      },
    };
  }

  router.post("/agents/:id/edit", (req, res) => {
    const u = repo.users.get(req.params.id as string);
    if (!u || u.role !== "sales_agent") {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const parsed = userEditSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid edit", message: "" });
      return;
    }
    try {
      const diff = applyUserEdit(u, parsed.data);
      audit(repo, req, {
        action: "agent.edit",
        entityType: "user",
        entityId: u.id,
        before: diff.before,
        after: diff.after,
      });
    } catch (err) {
      res.status(400).render("error", {
        title: "Cannot save",
        message: (err as Error).message,
      });
      return;
    }
    res.redirect("/admin/agents");
  });

  function userReferenceCount(userId: string): {
    bookings: number;
    cleaningJobs: number;
    payments: number;
  } {
    return {
      bookings: Array.from(repo.bookings.values()).filter(
        (b) => b.salesAgentId === userId,
      ).length,
      cleaningJobs: Array.from(repo.cleaningJobs.values()).filter(
        (j) => j.assignedToUserId === userId,
      ).length,
      payments:
        repo.agentPayments.filter((p) => p.salesAgentId === userId).length +
        repo.cleanerPayments.filter((p) => p.cleanerUserId === userId).length,
    };
  }

  router.post("/agents/:id/delete", (req, res) => {
    const u = repo.users.get(req.params.id as string);
    if (!u || u.role !== "sales_agent") {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const refs = userReferenceCount(u.id);
    const total = refs.bookings + refs.cleaningJobs + refs.payments;
    if (total > 0) {
      res.status(400).render("error", {
        title: "Cannot delete agent",
        message: `Agent is referenced by ${refs.bookings} booking(s), ${refs.payments} payment(s). Deactivate them instead so audit history stays intact.`,
      });
      return;
    }
    repo.users.delete(u.id);
    // Also drop their commission rules and agent-specific discounts.
    repo.commissionRules = repo.commissionRules.filter(
      (r) => r.salesAgentId !== u.id,
    );
    repo.discounts = repo.discounts.filter((d) => d.salesAgentId !== u.id);
    audit(repo, req, {
      action: "agent.delete",
      entityType: "user",
      entityId: u.id,
      before: { fullName: u.fullName, email: u.email },
    });
    res.redirect("/admin/agents");
  });

  router.post("/agents/:id/toggle", (req, res) => {
    const u = repo.users.get(req.params.id as string);
    if (!u || u.role !== "sales_agent") {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    u.isActive = !u.isActive;
    audit(repo, req, {
      action: "agent.toggle",
      entityType: "user",
      entityId: u.id,
      after: { isActive: u.isActive },
    });
    res.redirect("/admin/agents");
  });

  const agentRuleEditSchema = z.object({
    commissionType: z.enum(["percentage", "fixed"]),
    commissionValue: z.coerce.number().nonnegative(),
  });

  router.post("/agents/:id/rule", (req, res) => {
    const u = repo.users.get(req.params.id as string);
    if (!u || u.role !== "sales_agent") {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const parsed = agentRuleEditSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid rule", message: "" });
      return;
    }
    // Deactivate prior active rules; create new active one.
    for (const r of repo.commissionRules) {
      if (r.salesAgentId === u.id && r.isActive) r.isActive = false;
    }
    const ruleValueVnd =
      parsed.data.commissionType === "fixed"
        ? Math.round(parsed.data.commissionValue * 1000)
        : parsed.data.commissionValue;
    const rule = {
      id: nextId("commission-rule"),
      salesAgentId: u.id,
      commissionType: parsed.data.commissionType,
      value: ruleValueVnd,
      isActive: true,
    };
    repo.commissionRules.push(rule);
    audit(repo, req, {
      action: "agent.rule_update",
      entityType: "user",
      entityId: u.id,
      after: { commissionType: rule.commissionType, commissionValue: rule.value },
    });
    res.redirect("/admin/agents");
  });

  const agentDiscountSchema = z.object({
    name: z.string().min(1),
    discountType: z.enum(["percentage", "fixed"]),
    value: z.coerce.number().nonnegative(),
    usageLimit: z.string().optional(),
    validFrom: z.string().optional(),
    validUntil: z.string().optional(),
  });

  router.post("/agents/:id/discounts", (req, res) => {
    const u = repo.users.get(req.params.id as string);
    if (!u || u.role !== "sales_agent") {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const parsed = agentDiscountSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .render("error", { title: "Invalid discount", message: "" });
      return;
    }
    const limit = parsed.data.usageLimit
      ? Number(parsed.data.usageLimit)
      : undefined;
    // Fixed discount values are entered in ₫'000s (type "100" for ₫100,000); percentage stays as-is.
    const valueVnd =
      parsed.data.discountType === "fixed"
        ? Math.round(parsed.data.value * 1000)
        : parsed.data.value;
    const discount = {
      id: nextId("discount"),
      name: parsed.data.name,
      scope: "agent_specific" as const,
      salesAgentId: u.id,
      discountType: parsed.data.discountType,
      value: valueVnd,
      isActive: true,
      validFrom: parsed.data.validFrom || undefined,
      validUntil: parsed.data.validUntil || undefined,
      usageLimit:
        limit !== undefined && Number.isFinite(limit) && limit > 0
          ? limit
          : undefined,
    };
    repo.discounts.push(discount);
    audit(repo, req, {
      action: "agent.discount_create",
      entityType: "discount",
      entityId: discount.id,
      after: discount as Record<string, unknown>,
    });
    res.redirect("/admin/agents");
  });

  const discountEditSchema = z.object({
    name: z.string().min(1),
    discountType: z.enum(["percentage", "fixed"]),
    value: z.coerce.number().nonnegative(),
    usageLimit: z.string().optional(),
    validFrom: z.string().optional(),
    validUntil: z.string().optional(),
  });

  router.post("/discounts/:id/edit", (req, res) => {
    const d = repo.discounts.find((x) => x.id === req.params.id);
    if (!d) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const parsed = discountEditSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .render("error", { title: "Invalid discount", message: "" });
      return;
    }
    const before = { ...d };
    d.name = parsed.data.name;
    d.discountType = parsed.data.discountType;
    d.value =
      parsed.data.discountType === "fixed"
        ? Math.round(parsed.data.value * 1000)
        : parsed.data.value;
    const limit = parsed.data.usageLimit
      ? Number(parsed.data.usageLimit)
      : undefined;
    d.usageLimit =
      limit !== undefined && Number.isFinite(limit) && limit > 0
        ? limit
        : undefined;
    d.validFrom = parsed.data.validFrom || undefined;
    d.validUntil = parsed.data.validUntil || undefined;
    audit(repo, req, {
      action: "discount.edit",
      entityType: "discount",
      entityId: d.id,
      before: before as unknown as Record<string, unknown>,
      after: { ...d } as unknown as Record<string, unknown>,
    });
    res.redirect("/admin/agents");
  });

  router.post("/discounts/:id/toggle", (req, res) => {
    const d = repo.discounts.find((x) => x.id === req.params.id);
    if (!d) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    d.isActive = !d.isActive;
    audit(repo, req, {
      action: "discount.toggle",
      entityType: "discount",
      entityId: d.id,
      after: { isActive: d.isActive },
    });
    res.redirect("/admin/agents");
  });

  router.post("/discounts/:id/delete", (req, res) => {
    const idx = repo.discounts.findIndex((x) => x.id === req.params.id);
    if (idx < 0) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const before = repo.discounts[idx]!;
    const used = Array.from(repo.bookings.values()).some(
      (b) => b.discountIdApplied === before.id,
    );
    if (used) {
      res.status(400).render("error", {
        title: "Cannot delete discount",
        message:
          "This discount has been applied to one or more bookings. Deactivate it instead so it can no longer be used on new bookings.",
      });
      return;
    }
    repo.discounts.splice(idx, 1);
    audit(repo, req, {
      action: "discount.delete",
      entityType: "discount",
      entityId: before.id,
      before: before as unknown as Record<string, unknown>,
    });
    res.redirect("/admin/agents");
  });

  const paymentSchema = z
    .object({
      weekStartIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      amountVnd: z.coerce.number().int().nonnegative().optional(),
      amountK: z.coerce.number().nonnegative().optional(),
      notes: z.string().optional(),
    })
    .refine((v) => v.amountVnd !== undefined || v.amountK !== undefined, {
      message: "amount required",
    });

  router.post(
    "/agents/:id/payments",
    screenshotUpload.single("screenshot"),
    (req, res) => {
      const u = repo.users.get(req.params.id as string);
      if (!u || u.role !== "sales_agent") {
        res.status(404).render("error", { title: "Not found", message: "" });
        return;
      }
      const parsed = paymentSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .render("error", { title: "Invalid payment", message: "" });
        return;
      }
      const amountVnd =
        parsed.data.amountK !== undefined
          ? Math.round(parsed.data.amountK * 1000)
          : (parsed.data.amountVnd ?? 0);
      const screenshotUrl = req.file
        ? `/uploads/${path.basename(req.file.path)}`
        : undefined;
      const payment = {
        id: nextId("agent-payment"),
        salesAgentId: u.id,
        weekStartIso: parsed.data.weekStartIso,
        amountVnd,
        screenshotUrl,
        paidAt: new Date(),
        notes: parsed.data.notes || undefined,
        createdByUserId: (req as unknown as { currentUser?: { id?: string } })
          .currentUser?.id,
      };
      repo.agentPayments.push(payment);
      // Mark all approved (or pending) ledger entries for this agent in this week as paid.
      for (const e of repo.commissionLedger.values()) {
        if (
          e.salesAgentId === u.id &&
          isoMondayOf(e.createdAt) === parsed.data.weekStartIso &&
          e.status !== "paid" &&
          e.status !== "voided"
        ) {
          e.status = "paid";
          e.paidAt = payment.paidAt;
          e.updatedAt = payment.paidAt;
        }
      }
      audit(repo, req, {
        action: "agent.payment",
        entityType: "user",
        entityId: u.id,
        after: {
          weekStartIso: payment.weekStartIso,
          amountVnd: payment.amountVnd,
          screenshotUrl,
        },
      });
      res.redirect("/admin/agents");
    },
  );

  router.post("/agent-payments/:id/toggle", (req, res) => {
    const p = repo.agentPayments.find((x) => x.id === req.params.id);
    if (!p) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    p.status = p.status === "void" ? "paid" : "void";
    audit(repo, req, {
      action: "agent.payment_toggle",
      entityType: "agent_payment",
      entityId: p.id,
      after: { status: p.status },
    });
    res.redirect("/admin/agents");
  });

  router.post("/agent-payments/:id/delete", (req, res) => {
    const idx = repo.agentPayments.findIndex((x) => x.id === req.params.id);
    if (idx < 0) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const before = repo.agentPayments[idx]!;
    repo.agentPayments.splice(idx, 1);
    audit(repo, req, {
      action: "agent.payment_delete",
      entityType: "agent_payment",
      entityId: before.id,
      before: before as unknown as Record<string, unknown>,
    });
    res.redirect("/admin/agents");
  });

  router.get("/agents/:id/report.csv", (req, res) => {
    const u = repo.users.get(req.params.id as string);
    if (!u || u.role !== "sales_agent") {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const ledger = ledgerByAgentMap().get(u.id) ?? [];
    const payments = agentPaymentsByAgentMap().get(u.id) ?? [];
    const weeklyRows = buildAgentWeeklyRows(ledger, payments);
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const csvLines: string[] = [];
    csvLines.push(`Sales agent report,${csvField(u.fullName)}`);
    csvLines.push(`Email,${csvField(u.email)}`);
    csvLines.push(`Generated,${new Date().toISOString()}`);
    csvLines.push(
      "Note,Percentage commissions are net of discount codes; fixed are flat per booking.",
    );
    csvLines.push("");
    csvLines.push(
      "Week of,Bookings,Net revenue (VND),Commission earned (VND),Commission paid (VND),Outstanding (VND),Payment screenshots",
    );
    for (const w of weeklyRows) {
      const outstanding = Math.max(0, w.commissionVnd - w.paidAmountVnd);
      const screenshots = w.payments
        .map((p) => (p.screenshotUrl ? `${baseUrl}${p.screenshotUrl}` : ""))
        .filter(Boolean)
        .join(" ");
      csvLines.push(
        [
          w.weekStartIso,
          String(w.bookingCount),
          String(w.netRevenueVnd),
          String(w.commissionVnd),
          String(w.paidAmountVnd),
          String(outstanding),
          csvField(screenshots),
        ].join(","),
      );
    }
    const totalCommission = weeklyRows.reduce(
      (s, w) => s + w.commissionVnd,
      0,
    );
    const totalPaid = weeklyRows.reduce((s, w) => s + w.paidAmountVnd, 0);
    csvLines.push("");
    csvLines.push(
      `Total,${weeklyRows.reduce((s, w) => s + w.bookingCount, 0)},${weeklyRows.reduce((s, w) => s + w.netRevenueVnd, 0)},${totalCommission},${totalPaid},${Math.max(0, totalCommission - totalPaid)},`,
    );
    res
      .type("text/csv; charset=utf-8")
      .setHeader(
        "Content-Disposition",
        `attachment; filename="${csvFileName(u.fullName)}-commissions.csv"`,
      )
      .send(csvLines.join("\n"));
  });

  // ---------- Cleaning crew management ----------
  type CleanerWeeklyRow = {
    weekStartIso: string;
    jobsCompleted: number;
    earnedVnd: number;
    paidAmountVnd: number;
    payments: Array<import("../../domain/types.js").CleanerPayrollPayment>;
  };

  function buildCleanerWeeklyRows(
    jobs: Array<import("../../domain/types.js").CleaningJob>,
    payments: Array<import("../../domain/types.js").CleanerPayrollPayment>,
  ): CleanerWeeklyRow[] {
    const buckets = new Map<string, CleanerWeeklyRow>();
    const get = (wk: string): CleanerWeeklyRow => {
      let row = buckets.get(wk);
      if (!row) {
        row = {
          weekStartIso: wk,
          jobsCompleted: 0,
          earnedVnd: 0,
          paidAmountVnd: 0,
          payments: [],
        };
        buckets.set(wk, row);
      }
      return row;
    };
    for (const j of jobs) {
      if (j.status !== "completed" || !j.completedAt) continue;
      const wk = isoMondayOf(j.completedAt);
      const row = get(wk);
      row.jobsCompleted += 1;
      row.earnedVnd += j.fixedPayVnd;
    }
    for (const p of payments) {
      const row = get(p.weekStartIso);
      if (p.status !== "void") row.paidAmountVnd += p.amountVnd;
      row.payments.push(p);
    }
    const thisWeek = isoMondayOf(new Date());
    if (!buckets.has(thisWeek)) get(thisWeek);
    const rows = Array.from(buckets.values());
    rows.sort((a, b) => b.weekStartIso.localeCompare(a.weekStartIso));
    for (const r of rows) {
      r.payments.sort((x, y) => y.paidAt.getTime() - x.paidAt.getTime());
    }
    return rows;
  }

  router.get("/cleaners", (req, res) => {
    const cleaners = Array.from(repo.users.values()).filter(
      (u) => u.role === "cleaning_crew",
    );
    const fromIso =
      typeof req.query.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from)
        ? req.query.from
        : "";
    const toIso =
      typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)
        ? req.query.to
        : "";
    const inRange = (wk: string) =>
      (!fromIso || wk >= fromIso) && (!toIso || wk <= toIso);
    const jobsByCleaner = new Map<
      string,
      Array<import("../../domain/types.js").CleaningJob>
    >();
    for (const j of repo.cleaningJobs.values()) {
      if (!j.assignedToUserId) continue;
      const arr = jobsByCleaner.get(j.assignedToUserId) ?? [];
      arr.push(j);
      jobsByCleaner.set(j.assignedToUserId, arr);
    }
    const paymentsByCleaner = new Map<
      string,
      Array<import("../../domain/types.js").CleanerPayrollPayment>
    >();
    for (const p of repo.cleanerPayments) {
      const arr = paymentsByCleaner.get(p.cleanerUserId) ?? [];
      arr.push(p);
      paymentsByCleaner.set(p.cleanerUserId, arr);
    }

    const cleanerRows = cleaners.map((c) => {
      const profile = repo.cleaningCrewProfiles.get(c.id);
      const jobs = jobsByCleaner.get(c.id) ?? [];
      const payments = paymentsByCleaner.get(c.id) ?? [];
      const weeklyRows = buildCleanerWeeklyRows(jobs, payments).filter((r) =>
        inRange(r.weekStartIso),
      );
      const lifetimeJobs = weeklyRows.reduce((s, r) => s + r.jobsCompleted, 0);
      const lifetimeEarned = weeklyRows.reduce((s, r) => s + r.earnedVnd, 0);
      const lifetimePaid = weeklyRows.reduce(
        (s, r) => s + r.paidAmountVnd,
        0,
      );
      const upcomingJobs = jobs
        .filter(
          (j) =>
            j.windowStartAt > new Date(Date.now() - 86_400_000) &&
            j.status !== "cancelled",
        )
        .sort((a, b) => a.windowStartAt.getTime() - b.windowStartAt.getTime())
        .slice(0, 8);

      return {
        cleaner: c,
        profile,
        weeklyRows,
        lifetimeJobs,
        lifetimeEarned,
        lifetimePaid,
        upcomingJobs,
      };
    });

    // Aggregate across all cleaners.
    const allWeeks = new Map<string, CleanerWeeklyRow>();
    for (const cr of cleanerRows) {
      for (const r of cr.weeklyRows) {
        let agg = allWeeks.get(r.weekStartIso);
        if (!agg) {
          agg = {
            weekStartIso: r.weekStartIso,
            jobsCompleted: 0,
            earnedVnd: 0,
            paidAmountVnd: 0,
            payments: [],
          };
          allWeeks.set(r.weekStartIso, agg);
        }
        agg.jobsCompleted += r.jobsCompleted;
        agg.earnedVnd += r.earnedVnd;
        agg.paidAmountVnd += r.paidAmountVnd;
        agg.payments.push(...r.payments);
      }
    }
    const aggregateRows = Array.from(allWeeks.values()).sort((a, b) =>
      b.weekStartIso.localeCompare(a.weekStartIso),
    );

    const allRooms = Array.from(repo.rooms.values());
    const allBookings = Array.from(repo.bookings.values());

    res.render("admin/cleaners", {
      title: "Cleaning crew",
      cleanerRows,
      aggregateRows: aggregateRows.filter((r) => inRange(r.weekStartIso)),
      filters: { from: fromIso, to: toIso },
      allCleaners: cleaners,
      bookingForJob: (j: { bookingId: string }) =>
        allBookings.find((b) => b.id === j.bookingId),
      roomForJob: (j: { roomId: string }) =>
        allRooms.find((r) => r.id === j.roomId),
    });
  });

  const newCleanerSchema = z.object({
    fullName: z.string().min(1),
    email: z.string().email(),
    phone: z.string().optional(),
    password: z.string().min(8),
    fixedPayPerJobK: z.coerce.number().nonnegative(),
  });

  router.post("/cleaners", (req, res) => {
    const parsed = newCleanerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid cleaner", message: "" });
      return;
    }
    const id = nextId("cleaner");
    repo.users.set(id, {
      id,
      role: "cleaning_crew",
      fullName: parsed.data.fullName,
      email: parsed.data.email,
      phone: parsed.data.phone || undefined,
      isActive: true,
      passwordHash: bcrypt.hashSync(parsed.data.password, 8),
    });
    repo.cleaningCrewProfiles.set(id, {
      userId: id,
      fixedPayPerJobVnd: Math.round(parsed.data.fixedPayPerJobK * 1000),
      jobsCompleted: 0,
    });
    audit(repo, req, {
      action: "cleaner.create",
      entityType: "user",
      entityId: id,
      after: {
        fullName: parsed.data.fullName,
        email: parsed.data.email,
        fixedPayVnd: Math.round(parsed.data.fixedPayPerJobK * 1000),
      },
    });
    res.redirect("/admin/cleaners");
  });

  router.post("/cleaners/:id/edit", (req, res) => {
    const u = repo.users.get(req.params.id as string);
    if (!u || u.role !== "cleaning_crew") {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const parsed = userEditSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid edit", message: "" });
      return;
    }
    try {
      const diff = applyUserEdit(u, parsed.data);
      audit(repo, req, {
        action: "cleaner.edit",
        entityType: "user",
        entityId: u.id,
        before: diff.before,
        after: diff.after,
      });
    } catch (err) {
      res.status(400).render("error", {
        title: "Cannot save",
        message: (err as Error).message,
      });
      return;
    }
    res.redirect("/admin/cleaners");
  });

  router.post("/cleaners/:id/delete", (req, res) => {
    const u = repo.users.get(req.params.id as string);
    if (!u || u.role !== "cleaning_crew") {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const refs = userReferenceCount(u.id);
    const total = refs.bookings + refs.cleaningJobs + refs.payments;
    if (total > 0) {
      res.status(400).render("error", {
        title: "Cannot delete cleaner",
        message: `Cleaner is assigned to ${refs.cleaningJobs} job(s) and has ${refs.payments} payment(s). Deactivate instead.`,
      });
      return;
    }
    repo.users.delete(u.id);
    repo.cleaningCrewProfiles.delete(u.id);
    repo.cleaningAvailability = repo.cleaningAvailability.filter(
      (a) => a.cleaningCrewUserId !== u.id,
    );
    audit(repo, req, {
      action: "cleaner.delete",
      entityType: "user",
      entityId: u.id,
      before: { fullName: u.fullName, email: u.email },
    });
    res.redirect("/admin/cleaners");
  });

  router.post("/cleaners/:id/toggle", (req, res) => {
    const u = repo.users.get(req.params.id as string);
    if (!u || u.role !== "cleaning_crew") {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    u.isActive = !u.isActive;
    audit(repo, req, {
      action: "cleaner.toggle",
      entityType: "user",
      entityId: u.id,
      after: { isActive: u.isActive },
    });
    res.redirect("/admin/cleaners");
  });

  const cleanerPaySchema = z.object({
    fixedPayPerJobK: z.coerce.number().nonnegative(),
  });

  router.post("/cleaners/:id/pay", (req, res) => {
    const u = repo.users.get(req.params.id as string);
    if (!u || u.role !== "cleaning_crew") {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const parsed = cleanerPaySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .render("error", { title: "Invalid pay rate", message: "" });
      return;
    }
    const profile = repo.cleaningCrewProfiles.get(u.id) ?? {
      userId: u.id,
      fixedPayPerJobVnd: 0,
      jobsCompleted: 0,
    };
    const before = profile.fixedPayPerJobVnd;
    profile.fixedPayPerJobVnd = Math.round(parsed.data.fixedPayPerJobK * 1000);
    repo.cleaningCrewProfiles.set(u.id, profile);
    audit(repo, req, {
      action: "cleaner.pay_rate_update",
      entityType: "user",
      entityId: u.id,
      before: { fixedPayPerJobVnd: before },
      after: { fixedPayPerJobVnd: profile.fixedPayPerJobVnd },
    });
    res.redirect("/admin/cleaners");
  });

  const jobEditSchema = z.object({
    assignedToUserId: z.string().optional(),
    windowStartAt: z.string().optional(),
    windowEndAt: z.string().optional(),
    status: z
      .enum(["assigned", "arrived", "in_progress", "completed", "cancelled"])
      .optional(),
  });

  router.post("/cleaning-jobs/:id/edit", (req, res) => {
    const job = repo.cleaningJobs.get(req.params.id as string);
    if (!job) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const parsed = jobEditSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid edit", message: "" });
      return;
    }
    const before = {
      assignedToUserId: job.assignedToUserId,
      windowStartAt: job.windowStartAt.toISOString(),
      windowEndAt: job.windowEndAt.toISOString(),
      status: job.status,
    };
    if (parsed.data.assignedToUserId !== undefined) {
      job.assignedToUserId = parsed.data.assignedToUserId || undefined;
      if (job.assignedToUserId) {
        const profile = repo.cleaningCrewProfiles.get(job.assignedToUserId);
        if (profile) job.fixedPayVnd = profile.fixedPayPerJobVnd;
      }
    }
    if (parsed.data.windowStartAt) {
      const d = parseVietnamLocal(parsed.data.windowStartAt);
      if (!Number.isNaN(d.getTime())) job.windowStartAt = d;
    }
    if (parsed.data.windowEndAt) {
      const d = parseVietnamLocal(parsed.data.windowEndAt);
      if (!Number.isNaN(d.getTime())) job.windowEndAt = d;
    }
    if (parsed.data.status) job.status = parsed.data.status;
    audit(repo, req, {
      action: "cleaning_job.edit",
      entityType: "cleaning_job",
      entityId: job.id,
      before,
      after: {
        assignedToUserId: job.assignedToUserId,
        windowStartAt: job.windowStartAt.toISOString(),
        windowEndAt: job.windowEndAt.toISOString(),
        status: job.status,
      },
    });
    res.redirect("/admin/cleaners");
  });

  const cleanerPaymentSchema = z
    .object({
      weekStartIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      jobsCount: z.coerce.number().int().nonnegative(),
      amountVnd: z.coerce.number().int().nonnegative().optional(),
      amountK: z.coerce.number().nonnegative().optional(),
      notes: z.string().optional(),
    })
    .refine((v) => v.amountVnd !== undefined || v.amountK !== undefined, {
      message: "amount required",
    });

  router.post(
    "/cleaners/:id/payments",
    screenshotUpload.single("screenshot"),
    (req, res) => {
      const u = repo.users.get(req.params.id as string);
      if (!u || u.role !== "cleaning_crew") {
        res.status(404).render("error", { title: "Not found", message: "" });
        return;
      }
      const parsed = cleanerPaymentSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .render("error", { title: "Invalid payment", message: "" });
        return;
      }
      const amountVnd =
        parsed.data.amountK !== undefined
          ? Math.round(parsed.data.amountK * 1000)
          : (parsed.data.amountVnd ?? 0);
      const screenshotUrl = req.file
        ? `/uploads/${path.basename(req.file.path)}`
        : undefined;
      const payment = {
        id: nextId("cleaner-payment"),
        cleanerUserId: u.id,
        weekStartIso: parsed.data.weekStartIso,
        jobsCount: parsed.data.jobsCount,
        amountVnd,
        screenshotUrl,
        paidAt: new Date(),
        notes: parsed.data.notes || undefined,
        createdByUserId: (req as unknown as { currentUser?: { id?: string } })
          .currentUser?.id,
      };
      repo.cleanerPayments.push(payment);
      audit(repo, req, {
        action: "cleaner.payment",
        entityType: "user",
        entityId: u.id,
        after: {
          weekStartIso: payment.weekStartIso,
          jobsCount: payment.jobsCount,
          amountVnd: payment.amountVnd,
          screenshotUrl,
        },
      });
      res.redirect("/admin/cleaners");
    },
  );

  router.post("/cleaner-payments/:id/toggle", (req, res) => {
    const p = repo.cleanerPayments.find((x) => x.id === req.params.id);
    if (!p) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    p.status = p.status === "void" ? "paid" : "void";
    audit(repo, req, {
      action: "cleaner.payment_toggle",
      entityType: "cleaner_payment",
      entityId: p.id,
      after: { status: p.status },
    });
    res.redirect("/admin/cleaners");
  });

  router.post("/cleaner-payments/:id/delete", (req, res) => {
    const idx = repo.cleanerPayments.findIndex((x) => x.id === req.params.id);
    if (idx < 0) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const before = repo.cleanerPayments[idx]!;
    repo.cleanerPayments.splice(idx, 1);
    audit(repo, req, {
      action: "cleaner.payment_delete",
      entityType: "cleaner_payment",
      entityId: before.id,
      before: before as unknown as Record<string, unknown>,
    });
    res.redirect("/admin/cleaners");
  });

  router.get("/cleaners/:id/report.csv", (req, res) => {
    const u = repo.users.get(req.params.id as string);
    if (!u || u.role !== "cleaning_crew") {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const profile = repo.cleaningCrewProfiles.get(u.id);
    const jobs: Array<import("../../domain/types.js").CleaningJob> = [];
    for (const j of repo.cleaningJobs.values()) {
      if (j.assignedToUserId === u.id) jobs.push(j);
    }
    const payments = repo.cleanerPayments.filter((p) => p.cleanerUserId === u.id);
    const weeklyRows = buildCleanerWeeklyRows(jobs, payments);
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const csvLines: string[] = [];
    csvLines.push(`Cleaning crew report,${csvField(u.fullName)}`);
    csvLines.push(`Email,${csvField(u.email)}`);
    csvLines.push(
      `Fixed pay per job (VND),${profile ? profile.fixedPayPerJobVnd : 0}`,
    );
    csvLines.push(`Generated,${new Date().toISOString()}`);
    csvLines.push("");
    csvLines.push(
      "Week of,Completed jobs,Earned (VND),Paid (VND),Outstanding (VND),Payment screenshots",
    );
    for (const w of weeklyRows) {
      const outstanding = Math.max(0, w.earnedVnd - w.paidAmountVnd);
      const screenshots = w.payments
        .map((p) => (p.screenshotUrl ? `${baseUrl}${p.screenshotUrl}` : ""))
        .filter(Boolean)
        .join(" ");
      csvLines.push(
        [
          w.weekStartIso,
          String(w.jobsCompleted),
          String(w.earnedVnd),
          String(w.paidAmountVnd),
          String(outstanding),
          csvField(screenshots),
        ].join(","),
      );
    }
    const totalEarned = weeklyRows.reduce((s, w) => s + w.earnedVnd, 0);
    const totalPaid = weeklyRows.reduce((s, w) => s + w.paidAmountVnd, 0);
    csvLines.push("");
    csvLines.push(
      `Total,${weeklyRows.reduce((s, w) => s + w.jobsCompleted, 0)},${totalEarned},${totalPaid},${Math.max(0, totalEarned - totalPaid)},`,
    );
    res
      .type("text/csv; charset=utf-8")
      .setHeader(
        "Content-Disposition",
        `attachment; filename="${csvFileName(u.fullName)}-payroll.csv"`,
      )
      .send(csvLines.join("\n"));
  });

  // ---------- Discounts ----------
  router.get("/discounts", (_req, res) => {
    res.render("admin/discounts", {
      title: "Discounts",
      discounts: repo.discounts,
      agents: Array.from(repo.users.values()).filter(
        (u) => u.role === "sales_agent",
      ),
    });
  });

  const discountSchema = z.object({
    name: z.string().min(1),
    scope: z.enum(["global", "agent_specific"]),
    salesAgentId: z.string().optional(),
    discountType: z.enum(["percentage", "fixed"]),
    value: z.coerce.number().nonnegative(),
    isActive: z.string().optional(),
    validFrom: z.string().optional(),
    validUntil: z.string().optional(),
  });

  router.post("/discounts", (req, res) => {
    const parsed = discountSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .render("error", { title: "Invalid discount", message: "" });
      return;
    }
    const discount = {
      id: nextId("discount"),
      name: parsed.data.name,
      scope: parsed.data.scope,
      salesAgentId:
        parsed.data.scope === "agent_specific"
          ? parsed.data.salesAgentId
          : undefined,
      discountType: parsed.data.discountType,
      value: parsed.data.value,
      isActive: parsed.data.isActive === "1",
      validFrom: parsed.data.validFrom || undefined,
      validUntil: parsed.data.validUntil || undefined,
    };
    repo.discounts.push(discount);
    audit(repo, req, {
      action: "discount.create",
      entityType: "discount",
      entityId: discount.id,
      after: discount as Record<string, unknown>,
    });
    res.redirect("/admin/discounts");
  });

  router.post("/discounts/:id/toggle", (req, res) => {
    const d = repo.discounts.find((x) => x.id === req.params.id);
    if (!d) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    d.isActive = !d.isActive;
    audit(repo, req, {
      action: "discount.toggle",
      entityType: "discount",
      entityId: d.id,
      after: { isActive: d.isActive },
    });
    res.redirect("/admin/discounts");
  });

  // ---------- Commission rules ----------
  router.get("/commission-rules", (_req, res) => {
    res.render("admin/commission-rules", {
      title: "Commission rules",
      rules: repo.commissionRules,
      agents: Array.from(repo.users.values()).filter(
        (u) => u.role === "sales_agent",
      ),
    });
  });

  const ruleSchema = z.object({
    salesAgentId: z.string().min(1),
    commissionType: z.enum(["percentage", "fixed"]),
    value: z.coerce.number().nonnegative(),
    isActive: z.string().optional(),
    validFrom: z.string().optional(),
    validUntil: z.string().optional(),
  });

  router.post("/commission-rules", (req, res) => {
    const parsed = ruleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid rule", message: "" });
      return;
    }
    const ruleValueVnd =
      parsed.data.commissionType === "fixed"
        ? Math.round(parsed.data.value * 1000)
        : parsed.data.value;
    const rule = {
      id: nextId("commission-rule"),
      salesAgentId: parsed.data.salesAgentId,
      commissionType: parsed.data.commissionType,
      value: ruleValueVnd,
      isActive: parsed.data.isActive === "1",
      validFrom: parsed.data.validFrom || undefined,
      validUntil: parsed.data.validUntil || undefined,
    };
    repo.commissionRules.push(rule);
    audit(repo, req, {
      action: "commission_rule.create",
      entityType: "commission_rule",
      entityId: rule.id,
      after: rule as Record<string, unknown>,
    });
    res.redirect("/admin/commission-rules");
  });

  router.post("/commission-rules/:id/toggle", (req, res) => {
    const r = repo.commissionRules.find((x) => x.id === req.params.id);
    if (!r) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    r.isActive = !r.isActive;
    audit(repo, req, {
      action: "commission_rule.toggle",
      entityType: "commission_rule",
      entityId: r.id,
      after: { isActive: r.isActive },
    });
    res.redirect("/admin/commission-rules");
  });

  // ---------- Minibar items ----------
  router.get("/minibar", (_req, res) => {
    res.render("admin/minibar", {
      title: "Minibar items",
      items: Array.from(repo.minibarItems.values()),
    });
  });

  const minibarItemSchema = z.object({
    name: z.string().min(1),
    unitPriceK: z.coerce.number().nonnegative(),
    isActive: z.string().optional(),
  });

  router.post("/minibar", (req, res) => {
    const parsed = minibarItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid item", message: "" });
      return;
    }
    const item = {
      id: nextId("minibar"),
      name: parsed.data.name,
      unitPriceVnd: Math.round(parsed.data.unitPriceK * 1000),
      isActive: parsed.data.isActive === "1",
    };
    repo.minibarItems.set(item.id, item);
    audit(repo, req, {
      action: "minibar.create",
      entityType: "minibar_item",
      entityId: item.id,
      after: item as Record<string, unknown>,
    });
    res.redirect("/admin/minibar");
  });

  router.post("/minibar/:id/toggle", (req, res) => {
    const item = repo.minibarItems.get(req.params.id as string);
    if (!item) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    item.isActive = !item.isActive;
    audit(repo, req, {
      action: "minibar.toggle",
      entityType: "minibar_item",
      entityId: item.id,
      after: { isActive: item.isActive },
    });
    res.redirect("/admin/minibar");
  });

  const minibarEditSchema = z.object({
    name: z.string().min(1),
    unitPriceK: z.coerce.number().nonnegative(),
  });

  router.post("/minibar/:id/edit", (req, res) => {
    const item = repo.minibarItems.get(req.params.id as string);
    if (!item) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const parsed = minibarEditSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid edit", message: "" });
      return;
    }
    const before = { name: item.name, unitPriceVnd: item.unitPriceVnd };
    item.name = parsed.data.name;
    item.unitPriceVnd = Math.round(parsed.data.unitPriceK * 1000);
    audit(repo, req, {
      action: "minibar.edit",
      entityType: "minibar_item",
      entityId: item.id,
      before,
      after: { name: item.name, unitPriceVnd: item.unitPriceVnd },
    });
    res.redirect("/admin/minibar");
  });

  // ---------- Reports ----------
  function parseRange(
    q: Record<string, unknown>,
  ): { from: Date; to: Date } | undefined {
    const from = q.from ? new Date(String(q.from)) : undefined;
    const to = q.to ? new Date(String(q.to)) : undefined;
    if (
      !from ||
      !to ||
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime())
    )
      return undefined;
    return { from, to };
  }

  router.get("/reports", (req, res) => {
    const range =
      parseRange(req.query as Record<string, unknown>) ?? defaultRange();
    const summary = calculateRevenueSummary({
      bookings: repo.bookings.values(),
      rooms: repo.rooms.values(),
      range,
    });
    const occupancy = calculateOccupancy({
      bookings: repo.bookings.values(),
      rooms: repo.rooms.values(),
      range,
    });
    const agentPerf = calculateAgentPerformance({
      bookings: repo.bookings.values(),
      ledger: repo.commissionLedger.values(),
      range,
    });
    const cleanerPerf = calculateCleanerPerformance({
      cleaningJobs: repo.cleaningJobs.values(),
      profiles: repo.cleaningCrewProfiles.values(),
      range,
    });
    res.render("admin/reports", {
      title: "Reports",
      range: {
        from: range.from.toISOString().slice(0, 10),
        to: range.to.toISOString().slice(0, 10),
      },
      summary,
      occupancy,
      agentPerf,
      cleanerPerf,
      rooms: repo.rooms,
      users: repo.users,
    });
  });

  router.get("/exports/bookings.csv", (_req, res) => {
    const csv = bookingsToCsv(repo.bookings.values());
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="bookings-${Date.now()}.csv"`,
    );
    res.send(csv);
  });

  router.get("/exports/revenue.csv", (req, res) => {
    const range =
      parseRange(req.query as Record<string, unknown>) ?? defaultRange();
    const summary = calculateRevenueSummary({
      bookings: repo.bookings.values(),
      rooms: repo.rooms.values(),
      range,
    });
    const csv = rowsToCsv(
      summary.byRoom.map((r) => ({
        room_id: r.roomId,
        bookings: r.bookings,
        gross: r.grossRevenueVnd,
        discounts: r.discountsVnd,
        net: r.netRevenueVnd,
        refunds: r.refundsVnd,
        minibar: r.minibarVnd,
        damages: r.damagesVnd,
      })),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="revenue-${Date.now()}.csv"`,
    );
    res.send(csv);
  });

  router.get("/exports/commission-ledger.csv", (_req, res) => {
    const csv = rowsToCsv(
      Array.from(repo.commissionLedger.values()).map((e) => ({
        id: e.id,
        booking_id: e.bookingId,
        sales_agent_id: e.salesAgentId,
        amount_vnd: e.amountVnd,
        status: e.status,
        paid_at: e.paidAt ? e.paidAt.toISOString() : "",
        created_at: e.createdAt.toISOString(),
      })),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="commission-ledger-${Date.now()}.csv"`,
    );
    res.send(csv);
  });

  router.get("/exports/audit.csv", (_req, res) => {
    const csv = rowsToCsv(
      repo.auditLog.map((e) => ({
        id: e.id,
        created_at: e.createdAt.toISOString(),
        actor_user_id: e.actorUserId ?? "",
        actor_role: e.actorRole ?? "",
        action: e.action,
        entity_type: e.entityType,
        entity_id: e.entityId,
        notes: e.notes ?? "",
        before: e.before ? JSON.stringify(e.before) : "",
        after: e.after ? JSON.stringify(e.after) : "",
      })),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-${Date.now()}.csv"`,
    );
    res.send(csv);
  });

  router.get("/notifications", (_req, res) => {
    const entries = repo.notificationLog.slice().reverse().slice(0, 200);
    res.render("admin/notifications", {
      title: "Notifications",
      entries,
      bookingById: (id?: string) => (id ? repo.bookings.get(id) : undefined),
    });
  });

  router.get("/tasks", (_req, res) => {
    const tasks = Array.from(repo.tasks.values()).sort((a, b) => {
      if (a.status !== b.status) return a.status === "open" ? -1 : 1;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
    res.render("admin/tasks", {
      title: "Internal tasks",
      tasks,
      bookingById: (id?: string) => (id ? repo.bookings.get(id) : undefined),
    });
  });

  router.post("/tasks/:id/status", (req, res) => {
    const task = repo.tasks.get(req.params.id as string);
    if (!task) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const next = String(req.body.status ?? "");
    if (
      next !== "open" &&
      next !== "in_progress" &&
      next !== "completed" &&
      next !== "cancelled"
    ) {
      res.status(400).render("error", { title: "Invalid status", message: "" });
      return;
    }
    task.status = next;
    task.updatedAt = new Date();
    if (next === "completed") task.completedAt = new Date();
    audit(repo, req, {
      action: "task.transition",
      entityType: "task",
      entityId: task.id,
      after: { status: task.status },
    });
    res.redirect("/admin/tasks");
  });

  // ---------- Policies (cancellation fees, etc.) ----------
  router.get("/policies", (_req, res) => {
    res.render("admin/policies", {
      title: "Policies",
      policy: repo.cancellationPolicy,
    });
  });

  const policySchema = z.object({
    withinHoursOfCheckIn: z.array(z.string()).default([]),
    feePercent: z.array(z.string()).default([]),
  });

  router.post("/policies/cancellation", (req, res) => {
    // Express body-parser delivers repeated form fields as arrays; ensure
    // both inputs are arrays even when the user kept only one tier.
    const body = req.body as Record<string, unknown>;
    const toArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)];
    const parsed = policySchema.safeParse({
      withinHoursOfCheckIn: toArr(body.withinHoursOfCheckIn),
      feePercent: toArr(body.feePercent),
    });
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid policy", message: "" });
      return;
    }
    const tiers: import("../../domain/types.js").CancellationFeeTier[] = [];
    const len = Math.min(
      parsed.data.withinHoursOfCheckIn.length,
      parsed.data.feePercent.length,
    );
    for (let i = 0; i < len; i += 1) {
      const h = Number(parsed.data.withinHoursOfCheckIn[i]);
      const p = Number(parsed.data.feePercent[i]);
      if (
        Number.isFinite(h) &&
        h >= 0 &&
        Number.isFinite(p) &&
        p >= 0 &&
        p <= 100
      ) {
        tiers.push({
          withinHoursOfCheckIn: h,
          feePercent: p,
        });
      }
    }
    tiers.sort((a, b) => a.withinHoursOfCheckIn - b.withinHoursOfCheckIn);
    const before = repo.cancellationPolicy.slice();
    repo.cancellationPolicy = tiers;
    audit(repo, req, {
      action: "policy.cancellation_update",
      entityType: "policy",
      entityId: "cancellation",
      before: { tiers: before },
      after: { tiers },
    });
    res.redirect("/admin/policies");
  });

  // ---------- Maintenance blocks ----------
  router.get("/maintenance", (_req, res) => {
    const blocks = repo.maintenanceBlocks
      .slice()
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    res.render("admin/maintenance", {
      title: "Maintenance blocks",
      blocks,
      rooms: Array.from(repo.rooms.values()),
      roomById: (id?: string) => (id ? repo.rooms.get(id) : undefined),
    });
  });

  const maintenanceSchema = z.object({
    roomId: z.string(),
    startsAt: z.string().min(1),
    endsAt: z.string().min(1),
    reason: z.enum(["maintenance", "deep_cleaning", "owner_use", "offline"]),
    notes: z.string().optional(),
  });

  router.post("/maintenance", (req, res) => {
    const parsed = maintenanceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid block", message: "" });
      return;
    }
    const startsAt = parseVietnamLocal(parsed.data.startsAt);
    const endsAt = parseVietnamLocal(parsed.data.endsAt);
    if (
      Number.isNaN(startsAt.getTime()) ||
      Number.isNaN(endsAt.getTime()) ||
      endsAt <= startsAt
    ) {
      res.status(400).render("error", { title: "Bad date range", message: "" });
      return;
    }
    const reviewer = (req as unknown as { currentUser: { id: string } })
      .currentUser;
    const block = {
      id: nextId("maintenance"),
      roomId: parsed.data.roomId,
      startsAt,
      endsAt,
      reason: parsed.data.reason,
      notes: parsed.data.notes,
      createdByUserId: reviewer.id,
      createdAt: new Date(),
    };
    repo.maintenanceBlocks.push(block);
    audit(repo, req, {
      action: "maintenance.create",
      entityType: "maintenance",
      entityId: block.id,
      after: {
        roomId: block.roomId,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        reason: block.reason,
      },
      notes: parsed.data.notes,
    });
    res.redirect("/admin/maintenance");
  });

  router.post("/maintenance/:id/delete", (req, res) => {
    const idx = repo.maintenanceBlocks.findIndex((b) => b.id === req.params.id);
    if (idx < 0) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const removed = repo.maintenanceBlocks[idx]!;
    repo.maintenanceBlocks.splice(idx, 1);
    audit(repo, req, {
      action: "maintenance.delete",
      entityType: "maintenance",
      entityId: removed.id,
    });
    res.redirect("/admin/maintenance");
  });

  router.get("/audit", (_req, res) => {
    const entries = repo.auditLog.slice().reverse().slice(0, 200);
    res.render("admin/audit", {
      title: "Audit log",
      entries,
      userById: (id?: string) => (id ? repo.users.get(id) : undefined),
    });
  });

  // Side helper: room price preview JSON for inline checks
  router.get("/price-preview", (req, res) => {
    try {
      const roomId = String(req.query.roomId);
      const room = repo.rooms.get(roomId);
      if (!room) {
        res.status(404).json({ error: "room not found" });
        return;
      }
      const price = calculateBookingPrice({
        bookingType: req.query.bookingType as "hourly" | "day" | "multi_day",
        checkInAt: parseVietnamLocal(String(req.query.checkInAt)),
        checkOutAt: parseVietnamLocal(String(req.query.checkOutAt)),
        room,
        rates: repo.rates,
      });
      res.json(price);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.use("/admin", router);
}
