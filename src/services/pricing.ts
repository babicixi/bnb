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

function calculateHourlyCharge(
  room: Room,
  rates: RoomDailyRate[],
  checkInAt: Date,
  checkOutAt: Date,
): number {
  const rate = findRate(room, rates, vietnamDateKey(checkInAt));
  const hours = Math.ceil(
    (checkOutAt.getTime() - checkInAt.getTime()) / 3_600_000,
  );
  return Math.max(1, hours) * rate.hourlyRateVnd;
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
    (sum, key) => sum + findRate(room, rates, key).dayRateVnd,
    0,
  );
}

function findRate(
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
      dayRateVnd: room.baseDayRateVnd,
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
