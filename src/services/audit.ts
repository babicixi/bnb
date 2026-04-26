import type { AuditLogEntry, Id, RoleName } from "../domain/types.js";

export interface AuditSink {
  push(entry: AuditLogEntry): void;
}

export interface CreateAuditEntry {
  id: Id;
  actorUserId?: Id;
  actorRole?: RoleName;
  action: string;
  entityType: string;
  entityId: Id;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  notes?: string;
  occurredAt?: Date;
}

export function recordAudit(
  sink: AuditSink,
  input: CreateAuditEntry,
): AuditLogEntry {
  const entry: AuditLogEntry = {
    id: input.id,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    before: input.before,
    after: input.after,
    notes: input.notes,
    createdAt: input.occurredAt ?? new Date(),
  };
  sink.push(entry);
  return entry;
}

export function snapshotBooking(b: {
  status: string;
  paymentStatus: string;
  checkInAt: Date;
  checkOutAt: Date;
  finalRoomChargeVnd: number;
  amountPaidVnd: number;
  amountDueVnd: number;
  refundDueVnd: number;
  notes?: string;
}): Record<string, unknown> {
  return {
    status: b.status,
    paymentStatus: b.paymentStatus,
    checkInAt: b.checkInAt.toISOString(),
    checkOutAt: b.checkOutAt.toISOString(),
    finalRoomChargeVnd: b.finalRoomChargeVnd,
    amountPaidVnd: b.amountPaidVnd,
    amountDueVnd: b.amountDueVnd,
    refundDueVnd: b.refundDueVnd,
    notes: b.notes,
  };
}
