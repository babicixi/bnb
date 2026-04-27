import type {
  AgentCommissionPayment,
  AgentCommissionRule,
  AuditLogEntry,
  Booking,
  BookingHold,
  Building,
  CancellationFeeTier,
  CancellationRequest,
  CleanerPayrollPayment,
  CleaningAvailability,
  CleaningCrewProfile,
  CleaningJob,
  CleaningRating,
  CommissionLedgerEntry,
  Discount,
  Guest,
  Id,
  InternalTask,
  MaintenanceBlock,
  MinibarItem,
  MinibarUsage,
  NotificationLogEntry,
  Payment,
  PaymentProof,
  Room,
  RoomDailyRate,
  User,
} from "../domain/types.js";

export interface Repository {
  buildings: Map<Id, Building>;
  rooms: Map<Id, Room>;
  rates: RoomDailyRate[];
  users: Map<Id, User>;
  guests: Map<Id, Guest>;
  bookings: Map<Id, Booking>;
  bookingsByNumber: Map<string, Id>;
  holds: BookingHold[];
  payments: Map<Id, Payment>;
  paymentProofs: Map<Id, PaymentProof>;
  discounts: Discount[];
  commissionRules: AgentCommissionRule[];
  minibarItems: Map<Id, MinibarItem>;
  minibarUsage: MinibarUsage[];
  cleaningCrewProfiles: Map<Id, CleaningCrewProfile>;
  cleaningAvailability: CleaningAvailability[];
  cleaningJobs: Map<Id, CleaningJob>;
  cleaningRatings: CleaningRating[];
  cancellationRequests: Map<Id, CancellationRequest>;
  auditLog: AuditLogEntry[];
  commissionLedger: Map<Id, CommissionLedgerEntry>;
  notificationLog: NotificationLogEntry[];
  tasks: Map<Id, InternalTask>;
  maintenanceBlocks: MaintenanceBlock[];
  agentPayments: AgentCommissionPayment[];
  cleanerPayments: CleanerPayrollPayment[];
  cancellationPolicy: CancellationFeeTier[];

  bookingNumberCounter: { value: number };
}

export const DEFAULT_CANCELLATION_POLICY: CancellationFeeTier[] = [
  { withinHoursOfCheckIn: 24, feePercent: 50 },
  { withinHoursOfCheckIn: 72, feePercent: 30 },
];

export function createRepository(): Repository {
  return {
    buildings: new Map(),
    rooms: new Map(),
    rates: [],
    users: new Map(),
    guests: new Map(),
    bookings: new Map(),
    bookingsByNumber: new Map(),
    holds: [],
    payments: new Map(),
    paymentProofs: new Map(),
    discounts: [],
    commissionRules: [],
    minibarItems: new Map(),
    minibarUsage: [],
    cleaningCrewProfiles: new Map(),
    cleaningAvailability: [],
    cleaningJobs: new Map(),
    cleaningRatings: [],
    cancellationRequests: new Map(),
    auditLog: [],
    commissionLedger: new Map(),
    notificationLog: [],
    tasks: new Map(),
    maintenanceBlocks: [],
    agentPayments: [],
    cleanerPayments: [],
    cancellationPolicy: DEFAULT_CANCELLATION_POLICY.map((t) => ({ ...t })),
    bookingNumberCounter: { value: 0 },
  };
}

/**
 * Build a human-readable booking number of the form
 *   `RoomSlug-BuildingSlug-YYYY.MM.DD-N`
 * where N counts existing bookings on the same room and same Vietnam
 * check-in date (so the second booking of room A on May 1 becomes -2).
 *
 * Falls back to `BNB-YYYYMMDD-N` if room or building info is missing
 * (so callers without room context still get a unique number).
 */
export function nextBookingNumber(
  repo: Repository,
  options?: {
    room?: Room;
    building?: Building;
    checkInAt?: Date;
  },
): string {
  const slug = (s?: string) =>
    (s ?? "").replace(/[^a-zA-Z0-9]/g, "").trim() || "X";
  if (options?.room && options.checkInAt) {
    const vnIso = vietnamDateKeyOf(options.checkInAt).replace(/-/g, ".");
    const sameDayCount = Array.from(repo.bookings.values()).filter(
      (b) =>
        b.roomId === options.room!.id &&
        vietnamDateKeyOf(b.checkInAt) === vietnamDateKeyOf(options.checkInAt!),
    ).length;
    return `${slug(options.room.name)}-${slug(options.building?.name)}-${vnIso}-${sameDayCount + 1}`;
  }
  repo.bookingNumberCounter.value += 1;
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = String(repo.bookingNumberCounter.value).padStart(4, "0");
  return `BNB-${ymd}-${seq}`;
}

const VIETNAM_OFFSET_MS_FOR_KEY = 7 * 60 * 60_000;
function vietnamDateKeyOf(d: Date): string {
  return new Date(d.getTime() + VIETNAM_OFFSET_MS_FOR_KEY)
    .toISOString()
    .slice(0, 10);
}

export function nextId(prefix: string): Id {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function listAvailabilityContext(repo: Repository): {
  bookings: Booking[];
  holds: BookingHold[];
  maintenanceBlocks: MaintenanceBlock[];
} {
  return {
    bookings: Array.from(repo.bookings.values()),
    holds: repo.holds,
    maintenanceBlocks: repo.maintenanceBlocks,
  };
}

export function getBookingByNumber(
  repo: Repository,
  bookingNumber: string,
): Booking | undefined {
  const id = repo.bookingsByNumber.get(bookingNumber);
  return id ? repo.bookings.get(id) : undefined;
}

export function indexBooking(repo: Repository, booking: Booking): void {
  repo.bookings.set(booking.id, booking);
  repo.bookingsByNumber.set(booking.bookingNumber, booking.id);
}
