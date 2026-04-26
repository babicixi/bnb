import type {
  Booking,
  BookingHold,
  BookingType,
  Discount,
  Guest,
  Id,
  Payment,
  Room,
  RoomDailyRate,
} from "../domain/types.js";
import { calculateBookingPrice } from "./pricing.js";

export interface CreateBookingFromHoldInput {
  id: Id;
  bookingNumber: string;
  hold: BookingHold;
  guest: Guest;
  room: Room;
  rates: RoomDailyRate[];
  bookingType: BookingType;
  salesAgentId?: Id;
  discounts?: Discount[];
  paymentId?: Id;
  now?: Date;
}

export interface CreateBookingFromHoldResult {
  booking: Booking;
  payment: Payment;
}

export function createBookingFromHold(
  input: CreateBookingFromHoldInput,
): CreateBookingFromHoldResult {
  if (input.hold.roomId !== input.room.id) {
    throw new Error("Hold and room do not match.");
  }
  if (input.hold.expiredAt) {
    throw new Error("Hold has already expired.");
  }

  const now = input.now ?? new Date();
  const price = calculateBookingPrice({
    bookingType: input.bookingType,
    checkInAt: input.hold.checkInAt,
    checkOutAt: input.hold.checkOutAt,
    room: input.room,
    rates: input.rates,
    discounts: input.discounts,
    salesAgentId: input.salesAgentId,
  });

  const booking: Booking = {
    id: input.id,
    bookingNumber: input.bookingNumber,
    roomId: input.room.id,
    guestId: input.guest.id,
    salesAgentId: input.salesAgentId,
    bookingType: price.bookingType,
    status: "pending_payment",
    paymentStatus: "pending",
    checkInAt: price.checkInAt,
    checkOutAt: price.checkOutAt,
    finalRoomChargeVnd: price.netRoomChargeVnd,
    discountAmountVnd: price.discountAmountVnd,
    securityDepositVnd: price.securityDepositVnd,
    amountPaidVnd: 0,
    amountDueVnd: price.amountToCollectVnd,
    refundDueVnd: 0,
    calculatedCommissionVnd: 0,
    minibarChargesVnd: 0,
    damageChargesVnd: 0,
    syncStatus: "not_synced",
  };

  const payment: Payment = {
    id: input.paymentId ?? `${input.id}-payment`,
    bookingId: booking.id,
    amountVnd: price.amountToCollectVnd,
    method: "bank_transfer",
    status: "pending",
    createdAt: now,
  };

  // The hold has been fulfilled by an actual booking; mark it expired so it
  // no longer occupies the availability map. The booking itself blocks the slot.
  input.hold.expiredAt = now;

  return { booking, payment };
}
