import type {
  Booking,
  CleaningAvailability,
  CleaningCrewProfile,
  CleaningJob,
  Id,
  User,
} from "../domain/types.js";
import { autoAssignCleaningJob } from "./cleaning.js";

function assertOperationalRole(user: User, action: string): void {
  if (user.role !== "admin" && user.role !== "manager") {
    throw new Error(`Only admin or manager can ${action}.`);
  }
}

export function checkInGuest(input: {
  booking: Booking;
  by: User;
  now?: Date;
}): Booking {
  assertOperationalRole(input.by, "check guests in");
  if (input.booking.status !== "confirmed") {
    throw new Error("Only confirmed bookings can be checked in.");
  }
  input.booking.status = "checked_in";
  return input.booking;
}

export function checkOutGuest(input: {
  booking: Booking;
  by: User;
  now?: Date;
  cleaning?: {
    cleaningJobId: Id;
    availability: CleaningAvailability[];
    crewProfiles: CleaningCrewProfile[];
  };
}): { booking: Booking; cleaningJob?: CleaningJob } {
  assertOperationalRole(input.by, "check guests out");
  if (input.booking.status !== "checked_in") {
    throw new Error("Only checked-in bookings can be checked out.");
  }
  input.booking.status = "checked_out";

  let cleaningJob: CleaningJob | undefined;
  if (input.cleaning) {
    cleaningJob = autoAssignCleaningJob({
      id: input.cleaning.cleaningJobId,
      booking: input.booking,
      availability: input.cleaning.availability,
      crewProfiles: input.cleaning.crewProfiles,
      flipBookingStatus: true,
    });
  }

  return { booking: input.booking, cleaningJob };
}

export function closeBooking(input: { booking: Booking; by: User }): Booking {
  assertOperationalRole(input.by, "close bookings");
  const closeable = new Set([
    "cleaned",
    "checked_out",
    "refund_pending",
    "extra_payment_required",
  ]);
  if (!closeable.has(input.booking.status)) {
    throw new Error(
      `Booking in status '${input.booking.status}' cannot be closed.`,
    );
  }
  input.booking.status = "closed";
  return input.booking;
}
