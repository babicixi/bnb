import type {
  AgentCommissionRule,
  Booking,
  CleaningAvailability,
  CleaningCrewProfile,
  CleaningJob,
  Id,
  Payment,
  PaymentProof,
  User,
} from "../domain/types.js";
import { vietnamDateKey } from "../domain/time.js";
import { calculateAgentCommission } from "./commission.js";
import { autoAssignCleaningJob } from "./cleaning.js";

export function uploadPaymentProof(input: {
  id: Id;
  booking: Booking;
  payment?: Payment;
  fileUrl: string;
  uploadedAt?: Date;
}): PaymentProof {
  const proof: PaymentProof = {
    id: input.id,
    bookingId: input.booking.id,
    paymentId: input.payment?.id,
    uploadedByGuest: true,
    fileUrl: input.fileUrl,
    status: "uploaded",
    createdAt: input.uploadedAt ?? new Date(),
  };

  if (input.payment) {
    input.payment.status = "proof_uploaded";
  }
  confirmBookingAfterPaymentProof(input.booking);

  return proof;
}

export function confirmBookingAfterPaymentProof(booking: Booking): Booking {
  booking.paymentStatus = "proof_uploaded";
  booking.status = "confirmed";
  const expectedTotal = booking.finalRoomChargeVnd + booking.securityDepositVnd;
  if (booking.amountPaidVnd < expectedTotal) {
    booking.amountPaidVnd = expectedTotal;
  }
  booking.amountDueVnd = Math.max(0, expectedTotal - booking.amountPaidVnd);
  return booking;
}

export interface ApplyConfirmationSideEffectsInput {
  booking: Booking;
  commissionRules?: AgentCommissionRule[];
  asOfDate?: string;
  cleaning?: {
    cleaningJobId: Id;
    availability: CleaningAvailability[];
    crewProfiles: CleaningCrewProfile[];
  };
}

export interface ApplyConfirmationSideEffectsResult {
  commissionVnd: number;
  cleaningJob?: CleaningJob;
}

export function applyConfirmationSideEffects(
  input: ApplyConfirmationSideEffectsInput,
): ApplyConfirmationSideEffectsResult {
  const commissionVnd = calculateAgentCommission({
    salesAgentId: input.booking.salesAgentId,
    netAmountAfterDiscountVnd: input.booking.finalRoomChargeVnd,
    rules: input.commissionRules ?? [],
    asOfDate: input.asOfDate ?? vietnamDateKey(input.booking.checkInAt),
  });
  input.booking.calculatedCommissionVnd = commissionVnd;

  let cleaningJob: CleaningJob | undefined;
  if (input.cleaning) {
    cleaningJob = autoAssignCleaningJob({
      id: input.cleaning.cleaningJobId,
      booking: input.booking,
      availability: input.cleaning.availability,
      crewProfiles: input.cleaning.crewProfiles,
      flipBookingStatus: false,
    });
  }

  return { commissionVnd, cleaningJob };
}

export function markPaymentProofInvalid(input: {
  proof: PaymentProof;
  booking: Booking;
  reviewer: User;
  reason: string;
  reviewedAt?: Date;
}): PaymentProof {
  if (input.reviewer.role !== "admin" && input.reviewer.role !== "manager") {
    throw new Error("Only admin or manager can mark payment proof invalid.");
  }

  input.proof.status = "invalid";
  input.proof.reviewedByUserId = input.reviewer.id;
  input.proof.reviewedAt = input.reviewedAt ?? new Date();
  input.proof.invalidReason = input.reason;
  input.booking.paymentStatus = "proof_invalid";
  input.booking.status = "pending_payment";

  return input.proof;
}
