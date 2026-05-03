export const CLEANING_BUFFER_MINUTES = 60;
export const HOLD_MINUTES = 15;
/**
 * Fallback security deposit when none is configured on the repo. The admin
 * sets the live value at /admin/pricing → "Default security deposit"; bookings
 * always receive the value via BookingPriceInput.securityDepositVnd, so this
 * constant is only the default of last resort (e.g. unit tests that don't
 * explicitly opt in).
 */
export const SECURITY_DEPOSIT_VND = 0;
export const VIETNAM_UTC_OFFSET_MINUTES = 7 * 60;

const VIETNAM_OFFSET_MS = VIETNAM_UTC_OFFSET_MINUTES * 60_000;

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60_000);
}

export function overlaps(
  startA: Date,
  endA: Date,
  startB: Date,
  endB: Date,
): boolean {
  return startA < endB && startB < endA;
}

export function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function vietnamDateKey(date: Date): string {
  return new Date(date.getTime() + VIETNAM_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

export function vietnamHour(date: Date): number {
  return new Date(date.getTime() + VIETNAM_OFFSET_MS).getUTCHours();
}

export function vietnamMinute(date: Date): number {
  return new Date(date.getTime() + VIETNAM_OFFSET_MS).getUTCMinutes();
}

export function atVietnamTime(
  dateOrKey: Date | string,
  hour: number,
  minute = 0,
): Date {
  const key =
    typeof dateOrKey === "string" ? dateOrKey : vietnamDateKey(dateOrKey);
  const parts = key.split("-").map(Number);
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (!year || !month || !day) {
    throw new Error(`Invalid Vietnam date key: ${key}`);
  }
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute, 0, 0) - VIETNAM_OFFSET_MS,
  );
}

export function addVietnamDays(dateOrKey: Date | string, days: number): string {
  const base =
    typeof dateOrKey === "string"
      ? atVietnamTime(dateOrKey, 0)
      : atVietnamTime(dateOrKey, 0);
  return vietnamDateKey(addDays(base, days));
}

export function atUtcHour(date: Date, hour: number): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      hour,
      0,
      0,
      0,
    ),
  );
}

export function daysBetweenUtcDates(
  startInclusive: Date,
  endExclusive: Date,
): string[] {
  const dates: string[] = [];
  let cursor = atUtcHour(startInclusive, 0);
  const end = atUtcHour(endExclusive, 0);

  while (cursor < end) {
    dates.push(dateKey(cursor));
    cursor = addDays(cursor, 1);
  }

  return dates;
}

export function vietnamDateKeysBetween(
  startInclusive: Date,
  endExclusive: Date,
): string[] {
  const dates: string[] = [];
  let cursorKey = vietnamDateKey(startInclusive);
  const endKey = vietnamDateKey(endExclusive);

  while (cursorKey < endKey) {
    dates.push(cursorKey);
    cursorKey = addVietnamDays(cursorKey, 1);
  }

  return dates;
}
