import type {
  AdjustmentType,
  BookingType,
  Discount,
  Id,
  Room,
  RoomDailyRate,
} from "../domain/types.js";
import {
  addVietnamDays,
  atVietnamTime,
  SECURITY_DEPOSIT_VND,
  vietnamDateKey,
  vietnamDateKeysBetween,
  vietnamHour,
  vietnamMinute,
} from "../domain/time.js";

// A check-out after this Vietnam-local hour on the natural departure day
// rolls into another full day; a check-out between 11:00 and this cap is
// allowed as a "late check-out" billed via the room's hourly tier.
const LATE_CHECKOUT_LAST_HOUR = 18;

function isAfterLateCheckoutCap(date: Date): boolean {
  const h = vietnamHour(date);
  return h > LATE_CHECKOUT_LAST_HOUR ||
    (h === LATE_CHECKOUT_LAST_HOUR && vietnamMinute(date) > 0);
}

export interface NormalizedBookingTimes {
  bookingType: BookingType;
  checkInAt: Date;
  checkOutAt: Date;
  convertedToDayRate: boolean;
  /** Minutes past 11:00 on the final check-out day, when late check-out is in effect. */
  lateCheckoutMinutes: number;
}

/**
 * Picks a booking type from raw check-in / check-out times so the user does
 * not have to choose:
 *   - same Vietnam calendar day  → "hourly"
 *   - exactly one day apart      → "day"
 *   - two or more days apart     → "multi_day"
 *
 * `normalizeBookingTimes` still does its own validation/conversion on top
 * (e.g. an hourly booking that crosses midnight ends up as "day" via the
 * different-day branch and gets re-normalised to next-day 11:00).
 */
export function detectBookingType(
  checkInAt: Date,
  checkOutAt: Date,
): BookingType {
  const inKey = vietnamDateKey(checkInAt);
  const outKey = vietnamDateKey(checkOutAt);
  if (inKey === outKey) return "hourly";
  // Anything past the late-checkout cap rolls into another full day, which
  // can promote a single-day booking into a multi-day one.
  const effectiveOutKey = isAfterLateCheckoutCap(checkOutAt)
    ? addVietnamDays(outKey, 1)
    : outKey;
  const inMs = Date.parse(`${inKey}T00:00:00Z`);
  const outMs = Date.parse(`${effectiveOutKey}T00:00:00Z`);
  const days = Math.round((outMs - inMs) / 86_400_000);
  return days <= 1 ? "day" : "multi_day";
}

export interface BookingPriceInput {
  bookingType: BookingType;
  checkInAt: Date;
  checkOutAt: Date;
  room: Room;
  rates: RoomDailyRate[];
  discounts?: Discount[];
  salesAgentId?: Id;
  asOfDate?: string;
}

export interface BookingPrice {
  bookingType: BookingType;
  checkInAt: Date;
  checkOutAt: Date;
  roomChargeVnd: number;
  discountAmountVnd: number;
  netRoomChargeVnd: number;
  securityDepositVnd: number;
  amountToCollectVnd: number;
  convertedToDayRate: boolean;
  /** Late-checkout fee component bundled inside roomChargeVnd. 0 when not late. */
  lateCheckoutFeeVnd: number;
  /** Minutes past 11:00 used to compute the late-checkout tier. 0 when not late. */
  lateCheckoutMinutes: number;
}

export function normalizeBookingTimes(
  bookingType: BookingType,
  requestedCheckIn: Date,
  requestedCheckOut: Date,
): NormalizedBookingTimes {
  if (requestedCheckOut <= requestedCheckIn) {
    throw new Error("Checkout must be after check-in.");
  }

  if (bookingType === "hourly") {
    const sameVietnamDay =
      vietnamDateKey(requestedCheckIn) === vietnamDateKey(requestedCheckOut);
    if (sameVietnamDay) {
      return {
        bookingType,
        checkInAt: requestedCheckIn,
        checkOutAt: requestedCheckOut,
        convertedToDayRate: false,
        lateCheckoutMinutes: 0,
      };
    }

    const checkoutKey = addVietnamDays(requestedCheckIn, 1);
    return {
      bookingType: "day",
      checkInAt: requestedCheckIn,
      checkOutAt: atVietnamTime(checkoutKey, 11),
      convertedToDayRate: true,
      lateCheckoutMinutes: 0,
    };
  }

  if (vietnamHour(requestedCheckIn) < 14) {
    throw new Error(
      `${bookingType === "day" ? "Day" : "Multi-day"} booking check-in must be at or after 14:00 Vietnam time.`,
    );
  }

  // Day & multi-day share the same checkout normalization. The natural last
  // day is the Vietnam date of the requested checkout; if it's after the
  // late-checkout cap (18:00) we add another full day; otherwise we keep
  // the requested time and bill the late hours on top.
  const checkInKey = vietnamDateKey(requestedCheckIn);
  const requestedOutKey = vietnamDateKey(requestedCheckOut);
  const overflow = isAfterLateCheckoutCap(requestedCheckOut);
  const finalOutKey = overflow
    ? addVietnamDays(requestedOutKey, 1)
    : requestedOutKey;

  // Late-checkout window: requested between 11:00 and 18:00 inclusive on the
  // natural day, and we did not push to next day. Anything ≤ 11:00 is treated
  // as a clean 11:00 checkout (no late fee).
  let finalCheckOut = atVietnamTime(finalOutKey, 11);
  let lateCheckoutMinutes = 0;
  if (!overflow) {
    const standard11 = atVietnamTime(requestedOutKey, 11).getTime();
    if (requestedCheckOut.getTime() > standard11) {
      finalCheckOut = requestedCheckOut;
      lateCheckoutMinutes = Math.round(
        (requestedCheckOut.getTime() - standard11) / 60_000,
      );
    }
  }

  // Decide final booking type from the spread between check-in and check-out
  // calendar dates. Same-day-after-checkin → "day"; further → "multi_day".
  const inMs = atVietnamTime(checkInKey, 0).getTime();
  const outMs = atVietnamTime(finalOutKey, 0).getTime();
  const dayDiff = Math.round((outMs - inMs) / 86_400_000);
  const finalType: BookingType = dayDiff <= 1 ? "day" : "multi_day";

  return {
    bookingType: finalType,
    checkInAt: requestedCheckIn,
    checkOutAt: finalCheckOut,
    convertedToDayRate: false,
    lateCheckoutMinutes,
  };
}

export function calculateBookingPrice(input: BookingPriceInput): BookingPrice {
  if (
    input.bookingType === "hourly" &&
    input.room.hourlyEnabled === false
  ) {
    throw new Error(
      `${input.room.name} is not available for hourly bookings.`,
    );
  }
  const normalized = normalizeBookingTimes(
    input.bookingType,
    input.checkInAt,
    input.checkOutAt,
  );
  const isHourly =
    normalized.bookingType === "hourly" && !normalized.convertedToDayRate;
  // For day / multi-day: bill the day rate on the night-aligned check-out
  // (the actual checkOutAt may be the late-checkout time). The day-charge
  // helper buckets nights between in and out — we recompute the night
  // checkout (11:00 of finalOutKey) and add the late fee separately.
  const baseDayCheckOut = isHourly
    ? normalized.checkOutAt
    : atVietnamTime(vietnamDateKey(normalized.checkOutAt), 11);
  const baseChargeVnd = isHourly
    ? calculateHourlyCharge(
        input.room,
        input.rates,
        normalized.checkInAt,
        normalized.checkOutAt,
      )
    : calculateDayCharge(
        input.room,
        input.rates,
        normalized.checkInAt,
        baseDayCheckOut,
      );
  const lateCheckoutFeeVnd =
    !isHourly && normalized.lateCheckoutMinutes > 0
      ? calculateLateCheckoutFee(
          input.room,
          input.rates,
          normalized.checkOutAt,
          normalized.lateCheckoutMinutes,
        )
      : 0;
  const roomChargeVnd = baseChargeVnd + lateCheckoutFeeVnd;
  const discountAmountVnd = calculateBestDiscount({
    discounts: input.discounts ?? [],
    salesAgentId: input.salesAgentId,
    subtotalVnd: roomChargeVnd,
    asOfDate: input.asOfDate ?? vietnamDateKey(normalized.checkInAt),
  });
  const netRoomChargeVnd = Math.max(0, roomChargeVnd - discountAmountVnd);

  return {
    bookingType: normalized.bookingType,
    checkInAt: normalized.checkInAt,
    checkOutAt: normalized.checkOutAt,
    roomChargeVnd,
    discountAmountVnd,
    netRoomChargeVnd,
    securityDepositVnd: SECURITY_DEPOSIT_VND,
    amountToCollectVnd: netRoomChargeVnd + SECURITY_DEPOSIT_VND,
    convertedToDayRate: normalized.convertedToDayRate,
    lateCheckoutFeeVnd,
    lateCheckoutMinutes: normalized.lateCheckoutMinutes,
  };
}

/**
 * Late-checkout fee. Standard checkout is 11:00; the hour 11:00–12:00 is a
 * free grace period. From 12:00 to 18:00 we charge a flat tier based on how
 * many hours past noon the guest stays (rounded up to the next tier):
 *
 *   12:00 < out ≤ 14:00 → 2-hour tier
 *   14:00 < out ≤ 16:00 → 4-hour tier
 *   16:00 < out ≤ 18:00 → 6-hour tier
 *
 * Past 18:00 the booking is promoted to another full day in
 * normalizeBookingTimes, so we never see that case here.
 */
function calculateLateCheckoutFee(
  room: Room,
  rates: RoomDailyRate[],
  checkOutAt: Date,
  lateCheckoutMinutes: number,
): number {
  // hours past 11:00, then offset by the free grace hour to count "past noon".
  const hoursPastNoon = lateCheckoutMinutes / 60 - 1;
  if (hoursPastNoon <= 0) return 0;
  let tierHours: number;
  if (hoursPastNoon <= 2) tierHours = 2;
  else if (hoursPastNoon <= 4) tierHours = 4;
  else tierHours = 6;
  const checkOutKey = vietnamDateKey(checkOutAt);
  const rate = findRateForKey(room, rates, checkOutKey);
  return pickHourlyTier(
    tierHours,
    rate.hourlyRateVnd,
    rate.hourlyTiers,
    room.baseHourlyTiers,
  );
}

/**
 * Tier structure: { hours: 2, vnd: number }, … sorted ascending by hours.
 * Smallest tier whose `hours` ≥ requested duration wins. Falls back to
 * `hours × hourlyRateVnd` when no tier covers the duration.
 */
const TIER_HOURS: Array<{ hours: number; key: keyof import("../domain/types.js").HourlyTierRates }> = [
  { hours: 2, key: "rate2hVnd" },
  { hours: 4, key: "rate4hVnd" },
  { hours: 6, key: "rate6hVnd" },
  { hours: 8, key: "rate8hVnd" },
  { hours: 12, key: "rate12hVnd" },
];

function pickHourlyTier(
  hours: number,
  perHourVnd: number,
  tiers: import("../domain/types.js").HourlyTierRates | undefined,
  roomTiers: import("../domain/types.js").HourlyTierRates | undefined,
): number {
  if (tiers) {
    for (const t of TIER_HOURS) {
      if (hours <= t.hours && tiers[t.key] !== undefined) {
        return tiers[t.key] as number;
      }
    }
  }
  if (roomTiers) {
    for (const t of TIER_HOURS) {
      if (hours <= t.hours && roomTiers[t.key] !== undefined) {
        return roomTiers[t.key] as number;
      }
    }
  }
  return Math.max(1, hours) * perHourVnd;
}

function calculateHourlyCharge(
  room: Room,
  rates: RoomDailyRate[],
  checkInAt: Date,
  checkOutAt: Date,
): number {
  const rate = findRate(room, rates, checkInAt);
  const hours = Math.ceil(
    (checkOutAt.getTime() - checkInAt.getTime()) / 3_600_000,
  );
  return pickHourlyTier(hours, rate.hourlyRateVnd, rate.hourlyTiers, room.baseHourlyTiers);
}

function calculateDayCharge(
  room: Room,
  rates: RoomDailyRate[],
  checkInAt: Date,
  checkOutAt: Date,
): number {
  const keys = vietnamDateKeysBetween(checkInAt, checkOutAt);
  const billableKeys = keys.length > 0 ? keys : [vietnamDateKey(checkInAt)];
  return billableKeys.reduce(
    (sum, key) => sum + findRateForKey(room, rates, key).dayRateVnd,
    0,
  );
}

function isWeekendKey(rateDate: string): boolean {
  // rateDate is YYYY-MM-DD treated as UTC. Sat=6, Sun=0.
  const day = new Date(`${rateDate}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Default rate for a date when no per-day override exists. Picks the
 * room's weekend rate on Sat/Sun if set, otherwise the base day rate.
 */
function defaultDayRate(room: Room, rateDate: string): number {
  if (isWeekendKey(rateDate) && room.baseWeekendRateVnd !== undefined) {
    return room.baseWeekendRateVnd;
  }
  return room.baseDayRateVnd;
}

function findRate(
  room: Room,
  rates: RoomDailyRate[],
  checkInAt: Date,
): RoomDailyRate {
  return findRateForKey(room, rates, vietnamDateKey(checkInAt));
}

function findRateForKey(
  room: Room,
  rates: RoomDailyRate[],
  rateDate: string,
): RoomDailyRate {
  return (
    rates.find(
      (rate) => rate.roomId === room.id && rate.rateDate === rateDate,
    ) ?? {
      roomId: room.id,
      rateDate,
      dayRateVnd: defaultDayRate(room, rateDate),
      hourlyRateVnd: room.baseHourlyRateVnd,
    }
  );
}

function calculateBestDiscount(input: {
  discounts: Discount[];
  salesAgentId?: Id;
  subtotalVnd: number;
  asOfDate: string;
}): number {
  const allowedDiscounts = input.discounts.filter((discount) => {
    if (!discount.isActive) return false;
    if (discount.validFrom && discount.validFrom > input.asOfDate) return false;
    if (discount.validUntil && discount.validUntil < input.asOfDate)
      return false;
    if (discount.scope === "agent_specific")
      return discount.salesAgentId === input.salesAgentId;
    return true;
  });

  return allowedDiscounts.reduce(
    (best, discount) =>
      Math.max(
        best,
        adjustmentAmount(
          discount.discountType,
          discount.value,
          input.subtotalVnd,
        ),
      ),
    0,
  );
}

function adjustmentAmount(
  type: AdjustmentType,
  value: number,
  subtotalVnd: number,
): number {
  return type === "percentage"
    ? Math.round((subtotalVnd * value) / 100)
    : Math.min(subtotalVnd, Math.round(value));
}
