import type {
  Booking,
  BookingHold,
  BookingStatus,
  Id,
} from "../domain/types.js";
import {
  addMinutes,
  CLEANING_BUFFER_MINUTES,
  HOLD_MINUTES,
  overlaps,
} from "../domain/time.js";

const BLOCKING_BOOKING_STATUSES = new Set<BookingStatus>([
  "held",
  "pending_payment",
  "confirmed",
  "checked_in",
  "checked_out",
  "cleaning_assigned",
  "cleaning_in_progress",
  "cleaned",
  "extra_payment_required",
  "refund_pending",
  "cancellation_requested",
]);

export interface AvailabilityContext {
  bookings: Booking[];
  holds: BookingHold[];
}

export interface AvailabilityResult {
  available: boolean;
  conflicts: Array<{ type: "booking" | "hold"; id: Id }>;
}

export function checkAvailability(
  roomId: Id,
  requestedCheckIn: Date,
  requestedCheckOut: Date,
  context: AvailabilityContext,
  now = new Date(),
): AvailabilityResult {
  const conflicts: AvailabilityResult["conflicts"] = [];

  for (const booking of context.bookings) {
    if (
      booking.roomId !== roomId ||
      !BLOCKING_BOOKING_STATUSES.has(booking.status)
    ) {
      continue;
    }

    const blockedUntil = addMinutes(
      booking.checkOutAt,
      CLEANING_BUFFER_MINUTES,
    );
    if (
      overlaps(
        requestedCheckIn,
        requestedCheckOut,
        booking.checkInAt,
        blockedUntil,
      )
    ) {
      conflicts.push({ type: "booking", id: booking.id });
    }
  }

  for (const hold of context.holds) {
    if (hold.roomId !== roomId || hold.expiredAt || hold.heldUntil <= now) {
      continue;
    }

    const blockedUntil = addMinutes(hold.checkOutAt, CLEANING_BUFFER_MINUTES);
    if (
      overlaps(
        requestedCheckIn,
        requestedCheckOut,
        hold.checkInAt,
        blockedUntil,
      )
    ) {
      conflicts.push({ type: "hold", id: hold.id });
    }
  }

  return { available: conflicts.length === 0, conflicts };
}

export function createHold(input: {
  id: Id;
  roomId: Id;
  requestedCheckIn: Date;
  requestedCheckOut: Date;
  createdAt?: Date;
  createdByUserId?: Id;
  context: AvailabilityContext;
}): BookingHold {
  const createdAt = input.createdAt ?? new Date();
  const availability = checkAvailability(
    input.roomId,
    input.requestedCheckIn,
    input.requestedCheckOut,
    input.context,
    createdAt,
  );

  if (!availability.available) {
    throw new Error("Room is unavailable for the requested time.");
  }

  const hold: BookingHold = {
    id: input.id,
    roomId: input.roomId,
    checkInAt: input.requestedCheckIn,
    checkOutAt: input.requestedCheckOut,
    heldUntil: addMinutes(createdAt, HOLD_MINUTES),
    createdAt,
    createdByUserId: input.createdByUserId,
  };

  input.context.holds.push(hold);
  return hold;
}

export function expireOldHolds(
  holds: BookingHold[],
  now = new Date(),
): BookingHold[] {
  for (const hold of holds) {
    if (!hold.expiredAt && hold.heldUntil <= now) {
      hold.expiredAt = now;
    }
  }

  return holds;
}
