import type {
  AgentCommissionRule,
  AuditLogEntry,
  Booking,
  BookingHold,
  Building,
  CancellationRequest,
  CleaningAvailability,
  CleaningCrewProfile,
  CleaningJob,
  CleaningRating,
  CommissionLedgerEntry,
  Discount,
  Guest,
  Id,
  MinibarItem,
  MinibarUsage,
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

  bookingNumberCounter: { value: number };
}

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
    bookingNumberCounter: { value: 0 },
  };
}

export function nextBookingNumber(repo: Repository, now = new Date()): string {
  repo.bookingNumberCounter.value += 1;
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = String(repo.bookingNumberCounter.value).padStart(4, "0");
  return `BNB-${ymd}-${seq}`;
}

export function nextId(prefix: string): Id {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function listAvailabilityContext(repo: Repository): {
  bookings: Booking[];
  holds: BookingHold[];
} {
  return {
    bookings: Array.from(repo.bookings.values()),
    holds: repo.holds,
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
