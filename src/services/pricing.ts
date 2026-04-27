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
} from "../domain/time.js";

export interface NormalizedBookingTimes {
  bookingType: BookingType;
  checkInAt: Date;
  checkOutAt: Date;
  convertedToDayRate: boolean;
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
  const inMs = Date.parse(`${inKey}T00:00:00Z`);
  const outMs = Date.parse(`${outKey}T00:00:00Z`);
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
      };
    }

    const checkoutKey = addVietnamDays(requestedCheckIn, 1);
    return {
      bookingType: "day",
      checkInAt: requestedCheckIn,
      checkOutAt: atVietnamTime(checkoutKey, 11),
      convertedToDayRate: true,
    };
  }

  if (bookingType === "day") {
    if (vietnamHour(requestedCheckIn) < 14) {
      throw new Error(
        "Day booking check-in must be at or after 14:00 Vietnam time.",
      );
    }

    return {
      bookingType,
      checkInAt: requestedCheckIn,
      checkOutAt: atVietnamTime(addVietnamDays(requestedCheckIn, 1), 11),
      convertedToDayRate: false,
    };
  }

  if (vietnamHour(requestedCheckIn) < 14) {
    throw new Error(
      "Multi-day booking check-in must be at or after 14:00 Vietnam time.",
    );
  }

  return {
    bookingType,
    checkInAt: requestedCheckIn,
    checkOutAt: atVietnamTime(vietnamDateKey(requestedCheckOut), 11),
    convertedToDayRate: false,
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
  const roomChargeVnd =
    normalized.bookingType === "hourly" && !normalized.convertedToDayRate
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
          normalized.checkOutAt,
        );
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
  };
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
