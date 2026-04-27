import type {
  Booking,
  CancellationRequest,
  Id,
  RefundRecord,
  User,
} from "../domain/types.js";

export function calculateCancellationFee(input: {
  now: Date;
  checkInAt: Date;
  finalRoomChargeVnd: number;
}): number {
  const hoursUntilCheckIn =
    (input.checkInAt.getTime() - input.now.getTime()) / 3_600_000;

  if (hoursUntilCheckIn > 72) {
    return 0;
  }

  if (hoursUntilCheckIn > 24) {
    return Math.round(input.finalRoomChargeVnd * 0.3);
  }

  return Math.round(input.finalRoomChargeVnd * 0.5);
}

export function calculateRefund(input: {
  bookingId?: Id;
  amountPaidVnd: number;
  finalRoomChargeVnd: number;
  cancellationFeeVnd?: number;
  minibarChargesVnd?: number;
  damageChargesVnd?: number;
}): RefundRecord {
  const cancellationFeeVnd = input.cancellationFeeVnd ?? 0;
  const minibarChargesVnd = input.minibarChargesVnd ?? 0;
  const damageChargesVnd = input.damageChargesVnd ?? 0;
  const refundDueVnd = Math.max(
    0,
    input.amountPaidVnd -
      input.finalRoomChargeVnd -
      cancellationFeeVnd -
      minibarChargesVnd -
      damageChargesVnd,
  );

  return {
    bookingId: input.bookingId ?? "",
    amountPaidVnd: input.amountPaidVnd,
    finalRoomChargeVnd: input.finalRoomChargeVnd,
    cancellationFeeVnd,
    minibarChargesVnd,
    damageChargesVnd,
    refundDueVnd,
  };
}

export function requestCancellation(input: {
  id: Id;
  booking: Booking;
  requestedBy: User;
  reason?: string;
  now?: Date;
}): CancellationRequest {
  if (input.requestedBy.role === "cleaning_crew") {
    throw new Error("Cleaning crew cannot request booking cancellation.");
  }

  input.booking.status = "cancellation_requested";

  return {
    id: input.id,
    bookingId: input.booking.id,
    requestedByUserId: input.requestedBy.id,
    status: "requested",
    reason: input.reason,
    cancellationFeeVnd: 0,
    createdAt: input.now ?? new Date(),
  };
}

export function approveCancellation(input: {
  booking: Booking;
  request: CancellationRequest;
  approvedBy: User;
  now: Date;
}): CancellationRequest {
  if (
    input.approvedBy.role !== "admin" &&
    input.approvedBy.role !== "manager"
  ) {
    throw new Error("Only admin or manager can approve cancellation.");
  }

  const fee = calculateCancellationFee({
    now: input.now,
    checkInAt: input.booking.checkInAt,
    finalRoomChargeVnd: input.booking.finalRoomChargeVnd,
  });

  input.request.status = "approved";
  input.request.approvedByUserId = input.approvedBy.id;
  input.request.approvedAt = input.now;
  input.request.cancellationFeeVnd = fee;
  input.booking.status = "cancelled";
  input.booking.cancelledAt = input.now;
  // A cancelled booking owes no further extras; any computed refund replaces
  // any prior amountDue. Recompute refund using the cancellation fee.
  input.booking.amountDueVnd = 0;
  const refund = calculateRefund({
    bookingId: input.booking.id,
    amountPaidVnd: input.booking.amountPaidVnd,
    finalRoomChargeVnd: input.booking.finalRoomChargeVnd,
    cancellationFeeVnd: fee,
    minibarChargesVnd: input.booking.minibarChargesVnd,
    damageChargesVnd: input.booking.damageChargesVnd,
  });
  input.booking.refundDueVnd = refund.refundDueVnd;

  return input.request;
}
