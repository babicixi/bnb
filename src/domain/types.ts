export type Id = string;

export type RoleName = "admin" | "manager" | "sales_agent" | "cleaning_crew";

export type BookingStatus =
  | "held"
  | "pending_payment"
  | "confirmed"
  | "checked_in"
  | "checked_out"
  | "cleaning_assigned"
  | "cleaning_in_progress"
  | "cleaned"
  | "extra_payment_required"
  | "refund_pending"
  | "cancellation_requested"
  | "cancelled"
  | "closed";

export type BookingType = "hourly" | "day" | "multi_day";
export type PaymentStatus =
  | "pending"
  | "proof_uploaded"
  | "proof_invalid"
  | "verified"
  | "refunded"
  | "cancelled";
export type ProofStatus = "uploaded" | "invalid" | "accepted";
export type DiscountScope = "global" | "agent_specific";
export type AdjustmentType = "percentage" | "fixed";
export type CleaningJobStatus =
  | "assigned"
  | "arrived"
  | "in_progress"
  | "completed"
  | "cancelled";
export type CancellationRequestStatus = "requested" | "approved" | "rejected";
export type SyncStatus = "not_synced" | "pending" | "synced" | "failed";

export interface User {
  id: Id;
  role: RoleName;
  fullName: string;
  email: string;
  phone?: string;
  isActive: boolean;
  passwordHash?: string;
}

export interface Guest {
  id: Id;
  fullName: string;
  phone: string;
  email?: string;
  documentNumber?: string;
  notes?: string;
  facebookHandle?: string;
  instagramHandle?: string;
}

export interface Building {
  id: Id;
  name: string;
  address: string;
  city: string;
  district?: string;
}

export interface HourlyTierRates {
  /** Flat rate for stays up to 2 hours. */
  rate2hVnd?: number;
  rate4hVnd?: number;
  rate6hVnd?: number;
  rate8hVnd?: number;
  rate12hVnd?: number;
}

export interface Room {
  id: Id;
  buildingId: Id;
  name: string;
  roomNumber?: string;
  maxGuests: number;
  /**
   * Default day rate. Used as the fallback when neither the per-day calendar
   * row nor `baseWeekendRateVnd` (for Sat/Sun) carries a more specific value.
   */
  baseDayRateVnd: number;
  /** Optional weekend rate (Sat/Sun). Falls back to baseDayRateVnd. */
  baseWeekendRateVnd?: number;
  /** Per-hour fallback when no tier covers the requested duration. */
  baseHourlyRateVnd: number;
  /** Flat tier prices for short stays. Smallest tier ≥ duration wins. */
  baseHourlyTiers?: HourlyTierRates;
  /** When false, the room cannot be booked hourly. Defaults to true. */
  hourlyEnabled?: boolean;
  isActive: boolean;
  /** Legacy single-language description (used when description_en/vi missing). */
  description?: string;
  descriptionEn?: string;
  descriptionVi?: string;
  features?: string[];
  photoUrls?: string[];
  videoUrls?: string[];
  externalChannel?: string;
  externalCalendarEventId?: string;
  syncStatus: SyncStatus;
  lastSyncedAt?: Date;
}

export interface RoomDailyRate {
  roomId: Id;
  rateDate: string;
  dayRateVnd: number;
  hourlyRateVnd: number;
  /** Optional override of the per-tier hourly prices for this date. */
  hourlyTiers?: HourlyTierRates;
  /** Marks the date as special (e.g. public holiday) for UI surfacing. */
  isSpecial?: boolean;
  /** Free-form note (e.g. "Tet holiday", "Long weekend"). */
  note?: string;
}

export interface Booking {
  id: Id;
  bookingNumber: string;
  roomId: Id;
  guestId: Id;
  salesAgentId?: Id;
  bookingType: BookingType;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  checkInAt: Date;
  checkOutAt: Date;
  finalRoomChargeVnd: number;
  discountAmountVnd: number;
  securityDepositVnd: number;
  amountPaidVnd: number;
  amountDueVnd: number;
  refundDueVnd: number;
  calculatedCommissionVnd: number;
  minibarChargesVnd: number;
  damageChargesVnd: number;
  externalChannel?: string;
  externalReservationId?: string;
  externalCalendarEventId?: string;
  syncStatus: SyncStatus;
  lastSyncedAt?: Date;
  cancelledAt?: Date;
  notes?: string;
  source?: "guest" | "agent" | "admin";
  paymentProofUrl?: string;
  guestSourceTag?: string;
  paymentDeadlineAt?: Date;
  discountIdApplied?: Id;
}

export type PayoutStatus = "paid" | "void";

export interface AgentCommissionPayment {
  id: Id;
  salesAgentId: Id;
  weekStartIso: string; // YYYY-MM-DD (Monday)
  amountVnd: number;
  status?: PayoutStatus; // defaults to "paid" — voided rows do not count toward paid total
  screenshotUrl?: string;
  paidAt: Date;
  notes?: string;
  createdByUserId?: Id;
}

export interface CleanerPayrollPayment {
  id: Id;
  cleanerUserId: Id;
  weekStartIso: string; // YYYY-MM-DD (Monday)
  jobsCount: number;
  amountVnd: number;
  status?: PayoutStatus; // defaults to "paid"
  screenshotUrl?: string;
  paidAt: Date;
  notes?: string;
  createdByUserId?: Id;
}

export interface BookingHold {
  id: Id;
  roomId: Id;
  checkInAt: Date;
  checkOutAt: Date;
  heldUntil: Date;
  createdByUserId?: Id;
  createdAt: Date;
  expiredAt?: Date;
}

export interface Payment {
  id: Id;
  bookingId: Id;
  amountVnd: number;
  method: "bank_transfer";
  status: PaymentStatus;
  createdAt: Date;
}

export interface PaymentProof {
  id: Id;
  bookingId: Id;
  paymentId?: Id;
  uploadedByGuest: boolean;
  fileUrl: string;
  status: ProofStatus;
  reviewedByUserId?: Id;
  reviewedAt?: Date;
  invalidReason?: string;
  createdAt: Date;
}

export interface Discount {
  id: Id;
  name: string;
  scope: DiscountScope;
  salesAgentId?: Id;
  discountType: AdjustmentType;
  value: number;
  isActive: boolean;
  validFrom?: string;
  validUntil?: string;
  /** Optional cap on how many bookings this discount may be applied to. */
  usageLimit?: number;
}

export interface AgentCommissionRule {
  id: Id;
  salesAgentId: Id;
  commissionType: AdjustmentType;
  value: number;
  isActive: boolean;
  validFrom?: string;
  validUntil?: string;
}

export interface MinibarItem {
  id: Id;
  name: string;
  unitPriceVnd: number;
  isActive: boolean;
}

export interface CleaningCrewProfile {
  userId: Id;
  fixedPayPerJobVnd: number;
  jobsCompleted: number;
  averageRating?: number;
  reliabilityNotes?: string;
}

export interface CleaningAvailability {
  id: Id;
  cleaningCrewUserId: Id;
  availableFrom: Date;
  availableUntil: Date;
  isActive: boolean;
}

export interface CleaningJob {
  id: Id;
  bookingId: Id;
  roomId: Id;
  assignedToUserId?: Id;
  status: CleaningJobStatus;
  windowStartAt: Date;
  windowEndAt: Date;
  arrivedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  fixedPayVnd: number;
  damageChargesVnd: number;
  damageNotes?: string;
  photoUrls: string[];
}

export interface MinibarUsage {
  id: Id;
  bookingId: Id;
  /** The room the booking is in — denormalized so usage can be aggregated by room without joining bookings. */
  roomId?: Id;
  minibarItemId: Id;
  cleaningJobId?: Id;
  quantity: number;
  totalVnd: number;
  reportedByUserId?: Id;
  createdAt: Date;
}

/** A restock event: cleaner/manager dropped N units of an item into a room. */
export interface MinibarRestock {
  id: Id;
  roomId: Id;
  minibarItemId: Id;
  quantity: number;
  notes?: string;
  performedByUserId?: Id;
  createdAt: Date;
}

/**
 * Optional admin-set low-stock threshold per room/item. Stock on hand below
 * this triggers a low-stock badge on the inventory page.
 */
export interface MinibarStockThreshold {
  roomId: Id;
  minibarItemId: Id;
  reorderAt: number; // raise alert when stock <= this
}

export interface CleaningRating {
  id: Id;
  cleaningJobId: Id;
  ratedByUserId: Id;
  rating: number;
  notes?: string;
  createdAt: Date;
}

export interface CancellationRequest {
  id: Id;
  bookingId: Id;
  requestedByUserId: Id;
  status: CancellationRequestStatus;
  reason?: string;
  cancellationFeeVnd: number;
  approvedByUserId?: Id;
  approvedAt?: Date;
  createdAt: Date;
}

export interface RefundRecord {
  bookingId: Id;
  amountPaidVnd: number;
  finalRoomChargeVnd: number;
  cancellationFeeVnd: number;
  minibarChargesVnd: number;
  damageChargesVnd: number;
  refundDueVnd: number;
}

export type MaintenanceReason =
  | "maintenance"
  | "deep_cleaning"
  | "owner_use"
  | "offline";

export interface MaintenanceBlock {
  id: Id;
  roomId: Id;
  startsAt: Date;
  endsAt: Date;
  reason: MaintenanceReason;
  notes?: string;
  createdByUserId?: Id;
  createdAt: Date;
}

/**
 * Cancellation fee policy. Tiers are evaluated in order; the first one whose
 * `withinHoursOfCheckIn` is greater than or equal to the time remaining
 * until check-in wins. If no tier matches, the fee is 0.
 *
 * Default (matches the original spec):
 *   [{ withinHoursOfCheckIn: 24, feePercent: 50 },
 *    { withinHoursOfCheckIn: 72, feePercent: 30 }]
 *
 * → ≤ 24h before check-in → 50%
 * → ≤ 72h (but > 24h) → 30%
 * → otherwise → 0%
 */
export interface CancellationFeeTier {
  withinHoursOfCheckIn: number;
  feePercent: number;
}

export interface NotificationLogEntry {
  id: Id;
  event: string;
  bookingId?: Id;
  cleaningJobId?: Id;
  actorUserId?: Id;
  payload?: Record<string, unknown>;
  occurredAt: Date;
}

export type TaskStatus = "open" | "in_progress" | "completed" | "cancelled";
export type TaskPriority = "low" | "normal" | "high" | "urgent";

export interface InternalTask {
  id: Id;
  title: string;
  description?: string;
  relatedEntityType?: string;
  relatedEntityId?: Id;
  assignedRole?: RoleName;
  assignedUserId?: Id;
  priority: TaskPriority;
  dueAt?: Date;
  status: TaskStatus;
  createdByUserId?: Id;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  notes?: string;
}

export interface AuditLogEntry {
  id: Id;
  actorUserId?: Id;
  actorRole?: RoleName;
  action: string;
  entityType: string;
  entityId: Id;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  notes?: string;
  createdAt: Date;
}

export type CommissionLedgerStatus = "pending" | "approved" | "paid" | "voided";

export interface CommissionLedgerEntry {
  id: Id;
  bookingId: Id;
  salesAgentId: Id;
  amountVnd: number;
  ruleId?: Id;
  status: CommissionLedgerStatus;
  paidAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  notes?: string;
}

export interface BookingGuestView {
  bookingNumber: string;
  status: BookingStatus;
  checkInAt: Date;
  checkOutAt: Date;
  guest?: Pick<Guest, "fullName" | "phone" | "email">;
}
