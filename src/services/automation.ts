import type {
  Booking,
  BookingHold,
  BookingStatus,
  CleaningJob,
  Id,
} from "../domain/types.js";
import { expireOldHolds } from "./availability.js";

/**
 * Marks bookings whose payment deadline has passed as cancelled.
 * Returns the bookings it cancelled.
 */
export function expireUnpaidBookings(
  bookings: Iterable<Booking>,
  now = new Date(),
): Booking[] {
  const cancelled: Booking[] = [];
  for (const booking of bookings) {
    if (
      booking.status === "pending_payment" &&
      booking.paymentDeadlineAt &&
      booking.paymentDeadlineAt <= now
    ) {
      booking.status = "cancelled";
      booking.cancelledAt = now;
      cancelled.push(booking);
    }
  }
  return cancelled;
}

export interface SweepResult {
  expiredHolds: BookingHold[];
  cancelledBookings: Booking[];
}

/**
 * One pass of operational housekeeping. Suitable for periodic invocation
 * (in-process timer, or a SQL-backed cron job once persistence lands).
 */
export function runOperationalSweep(input: {
  holds: BookingHold[];
  bookings: Iterable<Booking>;
  now?: Date;
}): SweepResult {
  const now = input.now ?? new Date();
  const holdsBefore = input.holds.filter((h) => !h.expiredAt).length;
  expireOldHolds(input.holds, now);
  const expiredHolds = input.holds.filter(
    (h) => h.expiredAt && h.expiredAt.getTime() === now.getTime(),
  );
  void holdsBefore;
  const cancelledBookings = expireUnpaidBookings(input.bookings, now);
  return { expiredHolds, cancelledBookings };
}

export interface DailyChecklist {
  date: string;
  todayCheckIns: Booking[];
  todayCheckOuts: Booking[];
  pendingPayment: Booking[];
  pendingExtraPayment: Booking[];
  pendingRefunds: Booking[];
  pendingCleaningJobs: CleaningJob[];
  unassignedCleaningJobs: CleaningJob[];
  inMaintenance: Id[]; // room ids; placeholder until maintenance blocks land
}

const ACTIVE_BOOKING_STATUSES = new Set<BookingStatus>([
  "confirmed",
  "checked_in",
  "checked_out",
  "cleaning_assigned",
  "cleaning_in_progress",
  "cleaned",
  "extra_payment_required",
  "refund_pending",
]);

export function computeDailyChecklist(input: {
  bookings: Iterable<Booking>;
  cleaningJobs: Iterable<CleaningJob>;
  date?: Date;
}): DailyChecklist {
  const date = input.date ?? new Date();
  const dateKey = vietnamDateKeyOf(date);
  const allBookings = Array.from(input.bookings);
  const allJobs = Array.from(input.cleaningJobs);

  return {
    date: dateKey,
    todayCheckIns: allBookings.filter(
      (b) =>
        ACTIVE_BOOKING_STATUSES.has(b.status) &&
        vietnamDateKeyOf(b.checkInAt) === dateKey,
    ),
    todayCheckOuts: allBookings.filter(
      (b) =>
        ACTIVE_BOOKING_STATUSES.has(b.status) &&
        vietnamDateKeyOf(b.checkOutAt) === dateKey,
    ),
    pendingPayment: allBookings.filter(
      (b) =>
        b.status === "pending_payment" || b.paymentStatus === "proof_invalid",
    ),
    pendingExtraPayment: allBookings.filter(
      (b) => b.status === "extra_payment_required" || b.amountDueVnd > 0,
    ),
    pendingRefunds: allBookings.filter(
      (b) => b.status === "refund_pending" || b.refundDueVnd > 0,
    ),
    pendingCleaningJobs: allJobs.filter(
      (j) =>
        j.status !== "completed" &&
        j.status !== "cancelled" &&
        vietnamDateKeyOf(j.windowStartAt) === dateKey,
    ),
    unassignedCleaningJobs: allJobs.filter((j) => !j.assignedToUserId),
    inMaintenance: [],
  };
}

const VIETNAM_OFFSET_MS = 7 * 60 * 60_000;
function vietnamDateKeyOf(date: Date): string {
  return new Date(date.getTime() + VIETNAM_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}
