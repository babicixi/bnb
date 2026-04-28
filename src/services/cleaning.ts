import type {
  Booking,
  CleaningAvailability,
  CleaningCrewProfile,
  CleaningJob,
  CleaningRating,
  Id,
  MinibarItem,
  MinibarUsage,
  User,
} from "../domain/types.js";
import { addMinutes, CLEANING_BUFFER_MINUTES } from "../domain/time.js";

export function autoAssignCleaningJob(input: {
  id: Id;
  booking: Booking;
  availability: CleaningAvailability[];
  crewProfiles: CleaningCrewProfile[];
  flipBookingStatus?: boolean;
}): CleaningJob {
  const windowStartAt = input.booking.checkOutAt;
  const windowEndAt = addMinutes(windowStartAt, CLEANING_BUFFER_MINUTES);
  const assignedAvailability = input.availability
    .filter(
      (slot) =>
        slot.isActive &&
        slot.availableFrom <= windowStartAt &&
        slot.availableUntil >= windowEndAt &&
        input.crewProfiles.some(
          (profile) => profile.userId === slot.cleaningCrewUserId,
        ),
    )
    .sort((a, b) => a.availableFrom.getTime() - b.availableFrom.getTime())[0];

  if (!assignedAvailability) {
    throw new Error("No cleaning crew is available for the checkout window.");
  }

  const profile = input.crewProfiles.find(
    (candidate) => candidate.userId === assignedAvailability.cleaningCrewUserId,
  );
  if (!profile) {
    throw new Error("Assigned cleaning crew profile was not found.");
  }

  if (input.flipBookingStatus) {
    input.booking.status = "cleaning_assigned";
  }

  return {
    id: input.id,
    bookingId: input.booking.id,
    roomId: input.booking.roomId,
    assignedToUserId: assignedAvailability.cleaningCrewUserId,
    status: "assigned",
    windowStartAt,
    windowEndAt,
    fixedPayVnd: calculateCleanerPay(profile),
    damageChargesVnd: 0,
    photoUrls: [],
  };
}

export function calculateCleanerPay(profile: CleaningCrewProfile): number {
  return profile.fixedPayPerJobVnd;
}

function assertCanUpdateJob(job: CleaningJob, user: User): void {
  if (user.role === "admin" || user.role === "manager") return;
  if (user.role === "cleaning_crew" && job.assignedToUserId === user.id) return;
  throw new Error("User is not authorized to update this cleaning job.");
}

export function markCleaningArrived(input: {
  job: CleaningJob;
  user: User;
  now?: Date;
}): CleaningJob {
  assertCanUpdateJob(input.job, input.user);
  if (input.job.status !== "assigned") {
    throw new Error("Cleaning job must be assigned to mark arrived.");
  }
  input.job.status = "arrived";
  input.job.arrivedAt = input.now ?? new Date();
  return input.job;
}

export function startCleaning(input: {
  job: CleaningJob;
  booking: Booking;
  user: User;
  now?: Date;
}): CleaningJob {
  assertCanUpdateJob(input.job, input.user);
  if (input.job.status !== "arrived" && input.job.status !== "assigned") {
    throw new Error(
      "Cleaning job must be assigned or arrived to start cleaning.",
    );
  }
  input.job.status = "in_progress";
  input.job.startedAt = input.now ?? new Date();
  input.booking.status = "cleaning_in_progress";
  return input.job;
}

export function completeCleaning(input: {
  job: CleaningJob;
  booking: Booking;
  profile: CleaningCrewProfile;
  user: User;
  now?: Date;
}): CleaningJob {
  assertCanUpdateJob(input.job, input.user);
  if (input.job.status !== "in_progress" && input.job.status !== "arrived") {
    throw new Error(
      "Cleaning job must be in progress (or at least arrived) to complete.",
    );
  }
  input.job.status = "completed";
  input.job.completedAt = input.now ?? new Date();
  input.booking.status = "cleaned";
  input.profile.jobsCompleted += 1;
  return input.job;
}

export function reportMinibarUsage(input: {
  id: Id;
  job: CleaningJob;
  booking: Booking;
  item: MinibarItem;
  quantity: number;
  user: User;
  now?: Date;
}): MinibarUsage {
  assertCanUpdateJob(input.job, input.user);
  if (input.quantity <= 0) {
    throw new Error("Minibar usage quantity must be positive.");
  }
  if (!input.item.isActive) {
    throw new Error("Minibar item is not active.");
  }
  const totalVnd = input.item.unitPriceVnd * input.quantity;
  input.booking.minibarChargesVnd += totalVnd;
  recomputeExtrasBalance(input.booking);

  return {
    id: input.id,
    bookingId: input.booking.id,
    roomId: input.booking.roomId,
    minibarItemId: input.item.id,
    cleaningJobId: input.job.id,
    quantity: input.quantity,
    totalVnd,
    reportedByUserId: input.user.id,
    createdAt: input.now ?? new Date(),
  };
}

export function reportCleaningDamage(input: {
  job: CleaningJob;
  booking: Booking;
  user: User;
  damageChargesVnd: number;
  notes?: string;
}): CleaningJob {
  assertCanUpdateJob(input.job, input.user);
  if (input.damageChargesVnd < 0) {
    throw new Error("Damage charges cannot be negative.");
  }
  input.job.damageChargesVnd += input.damageChargesVnd;
  if (input.notes !== undefined) {
    input.job.damageNotes = input.job.damageNotes
      ? `${input.job.damageNotes}\n${input.notes}`
      : input.notes;
  }
  input.booking.damageChargesVnd += input.damageChargesVnd;
  recomputeExtrasBalance(input.booking);
  return input.job;
}

/**
 * Reconciles a booking's amountDue / refundDue with the extras (minibar +
 * damages) reported during the stay. The security deposit acts as collateral
 * for these extras: if extras stay below the deposit, nothing more is owed
 * and the refund-due shrinks; once extras pass the deposit, the surplus
 * becomes amountDue and the booking flips to "extra_payment_required" so it
 * surfaces in the admin queue. Cancellations have their own refund logic, so
 * we leave those alone.
 */
export function recomputeExtrasBalance(booking: Booking): void {
  if (booking.status === "cancelled" || booking.status === "closed") return;
  const extras =
    (booking.minibarChargesVnd || 0) + (booking.damageChargesVnd || 0);
  const deposit = booking.securityDepositVnd || 0;
  if (extras <= deposit) {
    booking.amountDueVnd = 0;
    booking.refundDueVnd = deposit - extras;
  } else {
    booking.amountDueVnd = extras - deposit;
    booking.refundDueVnd = 0;
    const liveStatuses: ReadonlyArray<Booking["status"]> = [
      "confirmed",
      "checked_in",
      "checked_out",
      "cleaning_assigned",
      "cleaning_in_progress",
      "cleaned",
    ];
    if (liveStatuses.includes(booking.status)) {
      booking.status = "extra_payment_required";
    }
  }
}

export function addCleaningPhoto(input: {
  job: CleaningJob;
  user: User;
  photoUrl: string;
}): CleaningJob {
  assertCanUpdateJob(input.job, input.user);
  if (!input.photoUrl) {
    throw new Error("Photo URL is required.");
  }
  input.job.photoUrls.push(input.photoUrl);
  return input.job;
}

export function rateCleaning(input: {
  id: Id;
  job: CleaningJob;
  profile: CleaningCrewProfile;
  ratedBy: User;
  rating: number;
  notes?: string;
  existingRatingsCount?: number;
  now?: Date;
}): CleaningRating {
  if (input.ratedBy.role !== "admin" && input.ratedBy.role !== "manager") {
    throw new Error("Only admin or manager can rate cleaning.");
  }
  if (input.job.status !== "completed") {
    throw new Error("Cleaning job must be completed before rating.");
  }
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    throw new Error("Rating must be an integer between 1 and 5.");
  }

  const previousCount = input.existingRatingsCount ?? 0;
  const previousAverage = input.profile.averageRating ?? 0;
  const newCount = previousCount + 1;
  input.profile.averageRating =
    (previousAverage * previousCount + input.rating) / newCount;

  return {
    id: input.id,
    cleaningJobId: input.job.id,
    ratedByUserId: input.ratedBy.id,
    rating: input.rating,
    notes: input.notes,
    createdAt: input.now ?? new Date(),
  };
}
