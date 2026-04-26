import type {
  Booking,
  Discount,
  Room,
  RoomDailyRate,
} from "../domain/types.js";
import { calculateBookingPrice } from "./pricing.js";
import { calculateRefund } from "./cancellation.js";

export function editBookingTimes(input: {
  booking: Booking;
  room: Room;
  rates: RoomDailyRate[];
  requestedCheckIn: Date;
  requestedCheckOut: Date;
  discounts?: Discount[];
}): Booking {
  const oldTotal =
    input.booking.finalRoomChargeVnd + input.booking.securityDepositVnd;
  const price = calculateBookingPrice({
    bookingType: input.booking.bookingType,
    checkInAt: input.requestedCheckIn,
    checkOutAt: input.requestedCheckOut,
    room: input.room,
    rates: input.rates,
    discounts: input.discounts,
    salesAgentId: input.booking.salesAgentId,
  });
  const newTotal = price.amountToCollectVnd;

  input.booking.bookingType = price.bookingType;
  input.booking.checkInAt = price.checkInAt;
  input.booking.checkOutAt = price.checkOutAt;
  input.booking.finalRoomChargeVnd = price.netRoomChargeVnd;
  input.booking.discountAmountVnd = price.discountAmountVnd;

  if (newTotal > input.booking.amountPaidVnd) {
    input.booking.amountDueVnd = newTotal - input.booking.amountPaidVnd;
    input.booking.refundDueVnd = 0;
    input.booking.status = "extra_payment_required";
    return input.booking;
  }

  const refund = calculateRefund({
    bookingId: input.booking.id,
    amountPaidVnd: input.booking.amountPaidVnd,
    finalRoomChargeVnd: price.netRoomChargeVnd,
    minibarChargesVnd: input.booking.minibarChargesVnd,
    damageChargesVnd: input.booking.damageChargesVnd,
  });

  input.booking.amountDueVnd = 0;
  input.booking.refundDueVnd = refund.refundDueVnd;
  if (refund.refundDueVnd > 0 && newTotal < oldTotal) {
    input.booking.status = "refund_pending";
  }

  return input.booking;
}
