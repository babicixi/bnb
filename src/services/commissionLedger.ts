import type {
  CommissionLedgerEntry,
  CommissionLedgerStatus,
  Id,
  User,
} from "../domain/types.js";

export interface LedgerSink {
  set(id: Id, entry: CommissionLedgerEntry): void;
  get(id: Id): CommissionLedgerEntry | undefined;
  values(): IterableIterator<CommissionLedgerEntry>;
}

export function recordPendingCommission(
  sink: LedgerSink,
  input: {
    id: Id;
    bookingId: Id;
    salesAgentId: Id;
    amountVnd: number;
    ruleId?: Id;
    now?: Date;
  },
): CommissionLedgerEntry {
  const now = input.now ?? new Date();
  const entry: CommissionLedgerEntry = {
    id: input.id,
    bookingId: input.bookingId,
    salesAgentId: input.salesAgentId,
    amountVnd: input.amountVnd,
    ruleId: input.ruleId,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  sink.set(entry.id, entry);
  return entry;
}

function assertOperationalRole(user: User, action: string): void {
  if (user.role !== "admin" && user.role !== "manager") {
    throw new Error(`Only admin or manager can ${action}.`);
  }
}

function transition(
  entry: CommissionLedgerEntry,
  next: CommissionLedgerStatus,
  user: User,
  now: Date,
  notes?: string,
): CommissionLedgerEntry {
  entry.status = next;
  entry.updatedAt = now;
  if (next === "paid") entry.paidAt = now;
  if (notes) entry.notes = notes;
  void user;
  return entry;
}

export function approveCommission(
  entry: CommissionLedgerEntry,
  user: User,
  now = new Date(),
): CommissionLedgerEntry {
  assertOperationalRole(user, "approve commission");
  if (entry.status !== "pending")
    throw new Error("Only pending commissions can be approved.");
  return transition(entry, "approved", user, now);
}

export function markCommissionPaid(
  entry: CommissionLedgerEntry,
  user: User,
  now = new Date(),
  notes?: string,
): CommissionLedgerEntry {
  assertOperationalRole(user, "mark commission paid");
  if (entry.status !== "approved")
    throw new Error("Commission must be approved before being marked paid.");
  return transition(entry, "paid", user, now, notes);
}

export function voidCommission(
  entry: CommissionLedgerEntry,
  user: User,
  now = new Date(),
  notes?: string,
): CommissionLedgerEntry {
  assertOperationalRole(user, "void commission");
  if (entry.status === "paid")
    throw new Error("Paid commissions cannot be voided.");
  return transition(entry, "voided", user, now, notes);
}
