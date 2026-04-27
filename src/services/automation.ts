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
 * Marks bookings whose checkout passed (and weren't manually advanced) as
 * checked_out. Returns the bookings touched.
 */
export function autoCheckoutOverdueBookings(
  bookings: Iterable<Booking>,
  now = new Date(),
): Booking[] {
  const touched: Booking[] = [];
  for (const booking of bookings) {
    if (
      (booking.status === "confirmed" || booking.status === "checked_in") &&
      booking.checkOutAt <= now
    ) {
      booking.status = "checked_out";
      touched.push(booking);
    }
  }
  return touched;
}

/**
 * Closes bookings that have completed cleaning, no outstanding extra payment
 * or refund, and aren't already closed/cancelled.
 */
export function autoCloseSettledBookings(input: {
  bookings: Iterable<Booking>;
  cleaningJobsByBookingId: Map<string, { status: string }>;
  now?: Date;
}): Booking[] {
  const now = input.now ?? new Date();
  void now;
  const touched: Booking[] = [];
  for (const booking of input.bookings) {
    if (
      booking.status === "cleaned" &&
      booking.amountDueVnd === 0 &&
      booking.refundDueVnd === 0
    ) {
      const job = input.cleaningJobsByBookingId.get(booking.id);
      if (!job || job.status === "completed") {
        booking.status = "closed";
        touched.push(booking);
      }
    }
  }
  return touched;
}

/**
 * One pass of operational housekeeping. Suitable for periodic invocation
 * (in-process timer, or a SQL-backed cron job once persistence lands).
 */
export function runOperationalSweep(input: {
  holds: BookingHold[];
  bookings: Iterable<Booking>;
  cleaningJobs?: Iterable<CleaningJob>;
  now?: Date;
}): SweepResult & { checkedOut: Booking[]; closed: Booking[] } {
  const now = input.now ?? new Date();
  const holdsBefore = input.holds.filter((h) => !h.expiredAt).length;
  expireOldHolds(input.holds, now);
  const expiredHolds = input.holds.filter(
    (h) => h.expiredAt && h.expiredAt.getTime() === now.getTime(),
  );
  void holdsBefore;
  const bookingsArr = Array.from(input.bookings);
  const cancelledBookings = expireUnpaidBookings(bookingsArr, now);
  const checkedOut = autoCheckoutOverdueBookings(bookingsArr, now);

  const cleaningJobsByBookingId = new Map<string, { status: string }>();
  if (input.cleaningJobs) {
    for (const j of input.cleaningJobs) {
      cleaningJobsByBookingId.set(j.bookingId, { status: j.status });
    }
  }
  const closed = autoCloseSettledBookings({
    bookings: bookingsArr,
    cleaningJobsByBookingId,
    now,
  });

  return { expiredHolds, cancelledBookings, checkedOut, closed };
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
      (b) =>
        b.status !== "cancelled" &&
        b.status !== "closed" &&
        (b.status === "extra_payment_required" || b.amountDueVnd > 0),
    ),
    pendingRefunds: allBookings.filter(
      (b) =>
        b.status !== "closed" &&
        (b.status === "refund_pending" || b.refundDueVnd > 0),
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
