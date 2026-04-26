import { EventEmitter } from "node:events";

export type NotificationEvent =
  | "booking_hold_created"
  | "hold_expiring_soon"
  | "hold_expired"
  | "payment_proof_uploaded"
  | "booking_confirmed"
  | "payment_proof_invalid"
  | "extra_payment_required"
  | "refund_pending"
  | "refund_sent"
  | "cancellation_requested"
  | "cancellation_approved"
  | "cancellation_rejected"
  | "checkin_today"
  | "checkout_today"
  | "cleaning_assigned"
  | "cleaning_started"
  | "cleaning_completed"
  | "minibar_reported"
  | "damage_reported"
  | "booking_closed";

export interface NotificationPayload {
  bookingId?: string;
  bookingNumber?: string;
  cleaningJobId?: string;
  actorUserId?: string;
  meta?: Record<string, unknown>;
  occurredAt: Date;
}

export const notifications = new EventEmitter();

export function notify(
  event: NotificationEvent,
  payload: Omit<NotificationPayload, "occurredAt"> & { occurredAt?: Date },
): void {
  notifications.emit(event, {
    ...payload,
    occurredAt: payload.occurredAt ?? new Date(),
  });
}
