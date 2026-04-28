import { describe, expect, it } from "vitest";
import {
  addCleaningPhoto,
  applyConfirmationSideEffects,
  approveCancellation,
  autoAssignCleaningJob,
  bookingGuestViewForUser,
  calculateAgentCommission,
  calculateBookingPrice,
  calculateCancellationFee,
  calculateCleanerPay,
  calculateRefund,
  canApproveCancellation,
  canEditBooking,
  checkAvailability,
  checkInGuest,
  checkOutGuest,
  closeBooking,
  completeCleaning,
  createBookingFromHold,
  createHold,
  editBookingTimes,
  expireOldHolds,
  markCleaningArrived,
  markPaymentProofInvalid,
  normalizeBookingTimes,
  rateCleaning,
  reportCleaningDamage,
  reportMinibarUsage,
  requestCancellation,
  startCleaning,
  uploadPaymentProof,
} from "../src/index.js";
import type {
  AgentCommissionRule,
  Booking,
  BookingHold,
  CleaningAvailability,
  CleaningCrewProfile,
  CleaningJob,
  Discount,
  Guest,
  MinibarItem,
  Room,
  RoomDailyRate,
  User,
} from "../src/index.js";

const room: Room = {
  id: "room-1",
  buildingId: "building-1",
  name: "Studio Balcony",
  maxGuests: 2,
  baseDayRateVnd: 1_000_000,
  baseHourlyRateVnd: 150_000,
  isActive: true,
  syncStatus: "not_synced",
};

const rates: RoomDailyRate[] = [
  {
    roomId: "room-1",
    rateDate: "2026-05-01",
    dayRateVnd: 1_000_000,
    hourlyRateVnd: 150_000,
  },
  {
    roomId: "room-1",
    rateDate: "2026-05-02",
    dayRateVnd: 1_200_000,
    hourlyRateVnd: 150_000,
  },
  {
    roomId: "room-1",
    rateDate: "2026-05-03",
    dayRateVnd: 1_300_000,
    hourlyRateVnd: 160_000,
  },
];

const admin: User = {
  id: "admin-1",
  role: "admin",
  fullName: "Admin",
  email: "admin@example.com",
  isActive: true,
};

const manager: User = {
  id: "manager-1",
  role: "manager",
  fullName: "Manager",
  email: "manager@example.com",
  isActive: true,
};

const agentOne: User = {
  id: "agent-1",
  role: "sales_agent",
  fullName: "Agent One",
  email: "agent1@example.com",
  isActive: true,
};

const agentTwo: User = {
  id: "agent-2",
  role: "sales_agent",
  fullName: "Agent Two",
  email: "agent2@example.com",
  isActive: true,
};

const cleanerProfile: CleaningCrewProfile = {
  userId: "cleaner-1",
  fixedPayPerJobVnd: 120_000,
  jobsCompleted: 0,
};

const cleanerOne: User = {
  id: "cleaner-1",
  role: "cleaning_crew",
  fullName: "Cleaner One",
  email: "cleaner1@example.com",
  isActive: true,
};

const cleanerTwo: User = {
  id: "cleaner-2",
  role: "cleaning_crew",
  fullName: "Cleaner Two",
  email: "cleaner2@example.com",
  isActive: true,
};

const waterItem: MinibarItem = {
  id: "minibar-water",
  name: "Water",
  unitPriceVnd: 15_000,
  isActive: true,
};

const guest: Guest = {
  id: "guest-1",
  fullName: "Guest One",
  phone: "+84900000000",
  email: "guest@example.com",
};

function d(value: string): Date {
  return new Date(value);
}

function booking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: "booking-1",
    bookingNumber: "BNB-000001",
    roomId: "room-1",
    guestId: "guest-1",
    salesAgentId: "agent-1",
    bookingType: "day",
    status: "confirmed",
    paymentStatus: "proof_uploaded",
    checkInAt: d("2026-05-01T15:00:00+07:00"),
    checkOutAt: d("2026-05-02T11:00:00+07:00"),
    finalRoomChargeVnd: 1_000_000,
    discountAmountVnd: 0,
    securityDepositVnd: 500_000,
    amountPaidVnd: 1_500_000,
    amountDueVnd: 0,
    refundDueVnd: 0,
    calculatedCommissionVnd: 0,
    minibarChargesVnd: 0,
    damageChargesVnd: 0,
    syncStatus: "not_synced",
    ...overrides,
  };
}

function hold(overrides: Partial<BookingHold> = {}): BookingHold {
  return {
    id: "hold-1",
    roomId: "room-1",
    checkInAt: d("2026-05-01T15:00:00+07:00"),
    checkOutAt: d("2026-05-02T11:00:00+07:00"),
    heldUntil: d("2026-05-01T10:15:00+07:00"),
    createdAt: d("2026-05-01T10:00:00+07:00"),
    ...overrides,
  };
}

describe("availability and holds", () => {
  it("overlapping confirmed booking blocks availability", () => {
    const result = checkAvailability(
      "room-1",
      d("2026-05-01T16:00:00+07:00"),
      d("2026-05-01T18:00:00+07:00"),
      { bookings: [booking()], holds: [] },
      d("2026-05-01T09:00:00+07:00"),
    );

    expect(result.available).toBe(false);
    expect(result.conflicts).toEqual([{ type: "booking", id: "booking-1" }]);
  });

  it("overlapping held booking blocks availability", () => {
    const result = checkAvailability(
      "room-1",
      d("2026-05-01T16:00:00+07:00"),
      d("2026-05-01T18:00:00+07:00"),
      { bookings: [], holds: [hold()] },
      d("2026-05-01T10:10:00+07:00"),
    );

    expect(result.available).toBe(false);
  });

  it("expired hold does not block availability", () => {
    const holds = [hold()];
    expireOldHolds(holds, d("2026-05-01T10:16:00+07:00"));

    const result = checkAvailability(
      "room-1",
      d("2026-05-01T16:00:00+07:00"),
      d("2026-05-01T18:00:00+07:00"),
      { bookings: [], holds },
      d("2026-05-01T10:16:00+07:00"),
    );

    expect(result.available).toBe(true);
  });

  it("1-hour cleaning buffer blocks availability", () => {
    const result = checkAvailability(
      "room-1",
      d("2026-05-02T11:30:00+07:00"),
      d("2026-05-02T13:00:00+07:00"),
      { bookings: [booking()], holds: [] },
      d("2026-05-01T10:00:00+07:00"),
    );

    expect(result.available).toBe(false);
  });

  it("createHold creates a 15-minute hold when available", () => {
    const context = { bookings: [], holds: [] as BookingHold[] };
    const created = createHold({
      id: "hold-new",
      roomId: "room-1",
      requestedCheckIn: d("2026-05-04T15:00:00+07:00"),
      requestedCheckOut: d("2026-05-05T11:00:00+07:00"),
      createdAt: d("2026-05-01T10:00:00+07:00"),
      context,
    });

    expect(created.heldUntil).toEqual(d("2026-05-01T10:15:00+07:00"));
    expect(context.holds).toHaveLength(1);
  });
});

describe("pricing", () => {
  it("hourly same-day booking remains hourly", () => {
    const normalized = normalizeBookingTimes(
      "hourly",
      d("2026-05-01T10:00:00+07:00"),
      d("2026-05-01T13:00:00+07:00"),
    );

    expect(normalized.bookingType).toBe("hourly");
    expect(normalized.convertedToDayRate).toBe(false);
  });

  it("hourly booking crossing midnight converts to day rate and 11:00 next-day checkout", () => {
    const price = calculateBookingPrice({
      bookingType: "hourly",
      checkInAt: d("2026-05-01T23:00:00+07:00"),
      checkOutAt: d("2026-05-02T01:00:00+07:00"),
      room,
      rates,
    });

    expect(price.bookingType).toBe("day");
    expect(price.convertedToDayRate).toBe(true);
    expect(price.checkOutAt).toEqual(d("2026-05-02T11:00:00+07:00"));
    expect(price.roomChargeVnd).toBe(1_000_000);
  });

  it("day booking enforces after-14:00 check-in and 11:00 next-day checkout", () => {
    expect(() =>
      normalizeBookingTimes(
        "day",
        d("2026-05-01T13:59:00+07:00"),
        d("2026-05-02T10:00:00+07:00"),
      ),
    ).toThrow(/14:00/);

    const normalized = normalizeBookingTimes(
      "day",
      d("2026-05-01T14:00:00+07:00"),
      d("2026-05-02T09:00:00+07:00"),
    );

    expect(normalized.checkOutAt).toEqual(d("2026-05-02T11:00:00+07:00"));
  });

  it("multi-day booking calculates correct checkout and price", () => {
    const price = calculateBookingPrice({
      bookingType: "multi_day",
      checkInAt: d("2026-05-01T15:00:00+07:00"),
      checkOutAt: d("2026-05-03T11:00:00+07:00"),
      room,
      rates,
    });

    expect(price.checkOutAt).toEqual(d("2026-05-03T11:00:00+07:00"));
    expect(price.roomChargeVnd).toBe(2_200_000);
    expect(price.lateCheckoutFeeVnd).toBe(0);
  });

  it("day booking with checkout 14:00 next day adds 2h late-checkout tier", () => {
    const price = calculateBookingPrice({
      bookingType: "day",
      checkInAt: d("2026-05-01T14:00:00+07:00"),
      checkOutAt: d("2026-05-02T14:00:00+07:00"),
      room,
      rates,
    });

    expect(price.bookingType).toBe("day");
    expect(price.checkOutAt).toEqual(d("2026-05-02T14:00:00+07:00"));
    // 1 night day rate + 2h tier (no baseHourlyTiers → falls back to 2h * hourlyRateVnd)
    expect(price.lateCheckoutFeeVnd).toBe(300_000);
    expect(price.roomChargeVnd).toBe(1_300_000);
  });

  it("day booking with checkout 18:00 next day adds 6h late-checkout tier", () => {
    const price = calculateBookingPrice({
      bookingType: "day",
      checkInAt: d("2026-05-01T14:00:00+07:00"),
      checkOutAt: d("2026-05-02T18:00:00+07:00"),
      room,
      rates,
    });

    expect(price.bookingType).toBe("day");
    expect(price.checkOutAt).toEqual(d("2026-05-02T18:00:00+07:00"));
    // 6h * 150k = 900k late fee on top of 1M day rate
    expect(price.lateCheckoutFeeVnd).toBe(900_000);
    expect(price.roomChargeVnd).toBe(1_900_000);
  });

  it("day booking with checkout after 18:00 promotes to multi-day (extra night)", () => {
    const price = calculateBookingPrice({
      bookingType: "day",
      checkInAt: d("2026-05-01T14:00:00+07:00"),
      checkOutAt: d("2026-05-02T21:00:00+07:00"),
      room,
      rates,
    });

    expect(price.bookingType).toBe("multi_day");
    // checkout pushed to 11:00 the day AFTER the requested day
    expect(price.checkOutAt).toEqual(d("2026-05-03T11:00:00+07:00"));
    expect(price.lateCheckoutFeeVnd).toBe(0);
    // 2 nights: rates for May 1 + May 2
    expect(price.roomChargeVnd).toBe(2_200_000);
  });

  it("day booking with checkout 11:30 next day is within free grace hour", () => {
    const price = calculateBookingPrice({
      bookingType: "day",
      checkInAt: d("2026-05-01T14:00:00+07:00"),
      checkOutAt: d("2026-05-02T11:30:00+07:00"),
      room,
      rates,
    });

    // hour past noon ≤ 0 → no late fee
    expect(price.lateCheckoutFeeVnd).toBe(0);
    expect(price.roomChargeVnd).toBe(1_000_000);
  });

  it("global discount applies correctly", () => {
    const discounts: Discount[] = [
      {
        id: "discount-global",
        name: "10 percent",
        scope: "global",
        discountType: "percentage",
        value: 10,
        isActive: true,
      },
    ];

    const price = calculateBookingPrice({
      bookingType: "day",
      checkInAt: d("2026-05-01T15:00:00+07:00"),
      checkOutAt: d("2026-05-02T11:00:00+07:00"),
      room,
      rates,
      discounts,
    });

    expect(price.discountAmountVnd).toBe(100_000);
    expect(price.amountToCollectVnd).toBe(1_400_000);
  });

  it("agent-specific discount applies only to assigned agent", () => {
    const discounts: Discount[] = [
      {
        id: "discount-agent",
        name: "Agent One 200k",
        scope: "agent_specific",
        salesAgentId: "agent-1",
        discountType: "fixed",
        value: 200_000,
        isActive: true,
      },
    ];

    const agentOnePrice = calculateBookingPrice({
      bookingType: "day",
      checkInAt: d("2026-05-01T15:00:00+07:00"),
      checkOutAt: d("2026-05-02T11:00:00+07:00"),
      room,
      rates,
      discounts,
      salesAgentId: "agent-1",
    });
    const agentTwoPrice = calculateBookingPrice({
      bookingType: "day",
      checkInAt: d("2026-05-01T15:00:00+07:00"),
      checkOutAt: d("2026-05-02T11:00:00+07:00"),
      room,
      rates,
      discounts,
      salesAgentId: "agent-2",
    });

    expect(agentOnePrice.discountAmountVnd).toBe(200_000);
    expect(agentTwoPrice.discountAmountVnd).toBe(0);
  });

  it("hourly tier picks the smallest tier covering the duration", () => {
    const tieredRoom: Room = {
      ...room,
      baseHourlyTiers: {
        rate2hVnd: 200_000,
        rate4hVnd: 350_000,
        rate6hVnd: 480_000,
      },
    };
    const r2 = calculateBookingPrice({
      bookingType: "hourly",
      checkInAt: d("2026-05-01T10:00:00+07:00"),
      checkOutAt: d("2026-05-01T12:00:00+07:00"),
      room: tieredRoom,
      rates,
    });
    expect(r2.roomChargeVnd).toBe(200_000);

    const r3 = calculateBookingPrice({
      bookingType: "hourly",
      checkInAt: d("2026-05-01T10:00:00+07:00"),
      checkOutAt: d("2026-05-01T13:00:00+07:00"),
      room: tieredRoom,
      rates,
    });
    expect(r3.roomChargeVnd).toBe(350_000);

    const r5 = calculateBookingPrice({
      bookingType: "hourly",
      checkInAt: d("2026-05-01T10:00:00+07:00"),
      checkOutAt: d("2026-05-01T15:00:00+07:00"),
      room: tieredRoom,
      rates,
    });
    expect(r5.roomChargeVnd).toBe(480_000);
  });

  it("hourly with no tier covering duration falls back to per-hour", () => {
    const tieredRoom: Room = {
      ...room,
      baseHourlyRateVnd: 100_000,
      baseHourlyTiers: { rate2hVnd: 200_000 }, // only 2h tier defined
    };
    const r5 = calculateBookingPrice({
      bookingType: "hourly",
      checkInAt: d("2026-05-01T10:00:00+07:00"),
      checkOutAt: d("2026-05-01T15:00:00+07:00"),
      room: tieredRoom,
      rates: [], // no per-day overrides
    });
    expect(r5.roomChargeVnd).toBe(500_000); // 5h * 100k
  });

  it("calculateBookingPrice rejects hourly when room.hourlyEnabled is false", () => {
    const dayOnlyRoom: Room = { ...room, hourlyEnabled: false };
    expect(() =>
      calculateBookingPrice({
        bookingType: "hourly",
        checkInAt: d("2026-05-01T10:00:00+07:00"),
        checkOutAt: d("2026-05-01T13:00:00+07:00"),
        room: dayOnlyRoom,
        rates,
      }),
    ).toThrow(/not available for hourly/);
  });

  it("weekend rate falls back to weekend default when no per-day override", () => {
    const weekendRoom: Room = {
      ...room,
      baseDayRateVnd: 1_000_000,
      baseWeekendRateVnd: 1_500_000,
    };
    // 2026-05-02 is a Saturday → weekend rate applies
    const sat = calculateBookingPrice({
      bookingType: "day",
      checkInAt: d("2026-05-02T15:00:00+07:00"),
      checkOutAt: d("2026-05-03T11:00:00+07:00"),
      room: weekendRoom,
      rates: [],
    });
    expect(sat.roomChargeVnd).toBe(1_500_000);

    // 2026-05-04 is a Monday → weekday rate
    const mon = calculateBookingPrice({
      bookingType: "day",
      checkInAt: d("2026-05-04T15:00:00+07:00"),
      checkOutAt: d("2026-05-05T11:00:00+07:00"),
      room: weekendRoom,
      rates: [],
    });
    expect(mon.roomChargeVnd).toBe(1_000_000);
  });

  it("per-day rate override beats weekend default", () => {
    const weekendRoom: Room = {
      ...room,
      baseDayRateVnd: 1_000_000,
      baseWeekendRateVnd: 1_500_000,
    };
    // Saturday with explicit holiday override
    const overridden = calculateBookingPrice({
      bookingType: "day",
      checkInAt: d("2026-05-02T15:00:00+07:00"),
      checkOutAt: d("2026-05-03T11:00:00+07:00"),
      room: weekendRoom,
      rates: [
        {
          roomId: "room-1",
          rateDate: "2026-05-02",
          dayRateVnd: 2_000_000,
          hourlyRateVnd: 200_000,
          isSpecial: true,
          note: "Labour day weekend",
        },
      ],
    });
    expect(overridden.roomChargeVnd).toBe(2_000_000);
  });
});

describe("payments and permissions", () => {
  it("payment screenshot upload auto-confirms booking", () => {
    const target = booking({
      status: "pending_payment",
      paymentStatus: "pending",
    });
    const proof = uploadPaymentProof({
      id: "proof-1",
      booking: target,
      fileUrl: "https://example.com/proofs/1.jpg",
    });

    expect(proof.status).toBe("uploaded");
    expect(target.status).toBe("confirmed");
    expect(target.paymentStatus).toBe("proof_uploaded");
  });

  it("fake/invalid proof can be marked by admin/manager", () => {
    const target = booking();
    const proof = uploadPaymentProof({
      id: "proof-1",
      booking: target,
      fileUrl: "https://example.com/proof.jpg",
    });

    markPaymentProofInvalid({
      proof,
      booking: target,
      reviewer: manager,
      reason: "Screenshot does not match transfer.",
    });

    expect(proof.status).toBe("invalid");
    expect(target.paymentStatus).toBe("proof_invalid");
    expect(target.status).toBe("pending_payment");
  });

  it("sales agent cannot see other agents' guest details", () => {
    const ownView = bookingGuestViewForUser(
      agentOne,
      booking({ salesAgentId: "agent-1" }),
      guest,
    );
    const otherView = bookingGuestViewForUser(
      agentTwo,
      booking({ salesAgentId: "agent-1" }),
      guest,
    );

    expect(ownView.guest?.phone).toBe("+84900000000");
    expect(otherView.guest).toBeUndefined();
  });
});

describe("booking edits", () => {
  it("extension recalculates amount due and requires extra payment", () => {
    const target = booking({
      bookingType: "multi_day",
      amountPaidVnd: 1_500_000,
      finalRoomChargeVnd: 1_000_000,
    });

    editBookingTimes({
      booking: target,
      room,
      rates,
      requestedCheckIn: d("2026-05-01T15:00:00+07:00"),
      requestedCheckOut: d("2026-05-03T11:00:00+07:00"),
    });

    expect(target.finalRoomChargeVnd).toBe(2_200_000);
    expect(target.amountDueVnd).toBe(1_200_000);
    expect(target.status).toBe("extra_payment_required");
  });

  it("shortening recalculates refund due and marks refund pending", () => {
    const target = booking({
      bookingType: "multi_day",
      amountPaidVnd: 2_700_000,
      finalRoomChargeVnd: 2_200_000,
      checkInAt: d("2026-05-01T15:00:00+07:00"),
      checkOutAt: d("2026-05-03T11:00:00+07:00"),
    });

    editBookingTimes({
      booking: target,
      room,
      rates,
      requestedCheckIn: d("2026-05-01T15:00:00+07:00"),
      requestedCheckOut: d("2026-05-02T11:00:00+07:00"),
    });

    expect(target.finalRoomChargeVnd).toBe(1_000_000);
    expect(target.refundDueVnd).toBe(1_700_000);
    expect(target.status).toBe("refund_pending");
  });
});

describe("cancellation and refunds", () => {
  it("sales agent can request but not approve cancellation", () => {
    const target = booking();
    const request = requestCancellation({
      id: "cancel-1",
      booking: target,
      requestedBy: agentOne,
      reason: "Guest changed plans.",
    });

    expect(request.status).toBe("requested");
    expect(target.status).toBe("cancellation_requested");
    expect(() =>
      approveCancellation({
        booking: target,
        request,
        approvedBy: agentOne,
        now: d("2026-04-30T12:00:00+07:00"),
      }),
    ).toThrow(/Only admin or manager/);
  });

  it("cancellation fee is 0% if more than 3 days before check-in", () => {
    expect(
      calculateCancellationFee({
        now: d("2026-04-27T14:59:00+07:00"),
        checkInAt: d("2026-05-01T15:00:00+07:00"),
        finalRoomChargeVnd: 1_000_000,
      }),
    ).toBe(0);
  });

  it("cancellation fee is 30% between 3 days and 1 day", () => {
    expect(
      calculateCancellationFee({
        now: d("2026-04-29T15:00:00+07:00"),
        checkInAt: d("2026-05-01T15:00:00+07:00"),
        finalRoomChargeVnd: 1_000_000,
      }),
    ).toBe(300_000);
  });

  it("cancellation fee uses custom tiers when provided", () => {
    // Custom policy: within 6h → 100%, within 48h → 25%, otherwise 0%
    const tiers = [
      { withinHoursOfCheckIn: 6, feePercent: 100 },
      { withinHoursOfCheckIn: 48, feePercent: 25 },
    ];
    // 4 hours before → first tier (100%)
    expect(
      calculateCancellationFee({
        now: d("2026-05-01T11:00:00+07:00"),
        checkInAt: d("2026-05-01T15:00:00+07:00"),
        finalRoomChargeVnd: 1_000_000,
        tiers,
      }),
    ).toBe(1_000_000);
    // 30 hours before → second tier (25%)
    expect(
      calculateCancellationFee({
        now: d("2026-04-30T09:00:00+07:00"),
        checkInAt: d("2026-05-01T15:00:00+07:00"),
        finalRoomChargeVnd: 1_000_000,
        tiers,
      }),
    ).toBe(250_000);
    // 5 days before → no tier matches → 0
    expect(
      calculateCancellationFee({
        now: d("2026-04-26T15:00:00+07:00"),
        checkInAt: d("2026-05-01T15:00:00+07:00"),
        finalRoomChargeVnd: 1_000_000,
        tiers,
      }),
    ).toBe(0);
  });

  it("cancellation fee is 50% within 24 hours", () => {
    expect(
      calculateCancellationFee({
        now: d("2026-04-30T15:01:00+07:00"),
        checkInAt: d("2026-05-01T15:00:00+07:00"),
        finalRoomChargeVnd: 1_000_000,
      }),
    ).toBe(500_000);
  });

  it("refund deducts minibar and damages", () => {
    const refund = calculateRefund({
      bookingId: "booking-1",
      amountPaidVnd: 1_500_000,
      finalRoomChargeVnd: 1_000_000,
      minibarChargesVnd: 40_000,
      damageChargesVnd: 100_000,
    });

    expect(refund.refundDueVnd).toBe(360_000);
  });

  it("approving cancellation zeros amountDue and recomputes refundDue", () => {
    const target = booking({
      amountPaidVnd: 1_500_000,
      finalRoomChargeVnd: 1_000_000,
      amountDueVnd: 200_000, // stale value from a prior edit
      minibarChargesVnd: 50_000,
      damageChargesVnd: 0,
    });
    const request = requestCancellation({
      id: "cancel-amt",
      booking: target,
      requestedBy: agentOne,
    });
    approveCancellation({
      booking: target,
      request,
      approvedBy: admin,
      now: d("2026-04-29T15:00:00+07:00"), // 2 days before check-in → 30%
    });
    expect(target.status).toBe("cancelled");
    expect(target.amountDueVnd).toBe(0);
    // refund = 1_500_000 - 1_000_000 - 300_000 - 50_000 = 150_000
    expect(target.refundDueVnd).toBe(150_000);
    expect(request.cancellationFeeVnd).toBe(300_000);
  });

  it("admin can approve cancellation and set fee", () => {
    const target = booking();
    const request = requestCancellation({
      id: "cancel-1",
      booking: target,
      requestedBy: agentOne,
    });
    const approved = approveCancellation({
      booking: target,
      request,
      approvedBy: admin,
      now: d("2026-04-29T15:00:00+07:00"),
    });

    expect(approved.status).toBe("approved");
    expect(approved.cancellationFeeVnd).toBe(300_000);
    expect(target.status).toBe("cancelled");
  });
});

describe("commissions and cleaning", () => {
  it("percentage commission calculated on net after discount", () => {
    const rules: AgentCommissionRule[] = [
      {
        id: "commission-1",
        salesAgentId: "agent-1",
        commissionType: "percentage",
        value: 10,
        isActive: true,
      },
    ];

    expect(
      calculateAgentCommission({
        salesAgentId: "agent-1",
        netAmountAfterDiscountVnd: 900_000,
        rules,
        asOfDate: "2026-05-01",
      }),
    ).toBe(90_000);
  });

  it("fixed commission calculated per confirmed booking", () => {
    const rules: AgentCommissionRule[] = [
      {
        id: "commission-2",
        salesAgentId: "agent-2",
        commissionType: "fixed",
        value: 120_000,
        isActive: true,
      },
    ];

    expect(
      calculateAgentCommission({
        salesAgentId: "agent-2",
        netAmountAfterDiscountVnd: 900_000,
        rules,
        asOfDate: "2026-05-01",
      }),
    ).toBe(120_000);
  });

  it("cleaning job auto-assigns based on availability", () => {
    const availability: CleaningAvailability[] = [
      {
        id: "availability-1",
        cleaningCrewUserId: "cleaner-1",
        availableFrom: d("2026-05-02T11:00:00+07:00"),
        availableUntil: d("2026-05-02T14:00:00+07:00"),
        isActive: true,
      },
    ];

    const job = autoAssignCleaningJob({
      id: "cleaning-job-1",
      booking: booking(),
      availability,
      crewProfiles: [cleanerProfile],
    });

    expect(job.assignedToUserId).toBe("cleaner-1");
    expect(job.windowStartAt).toEqual(d("2026-05-02T11:00:00+07:00"));
    expect(job.windowEndAt).toEqual(d("2026-05-02T12:00:00+07:00"));
  });

  it("cleaner fixed pay is calculated per job", () => {
    expect(calculateCleanerPay(cleanerProfile)).toBe(120_000);
  });
});

describe("cleaning crew job lifecycle", () => {
  function makeJob(overrides: Partial<CleaningJob> = {}): CleaningJob {
    return {
      id: "cleaning-job-1",
      bookingId: "booking-1",
      roomId: "room-1",
      assignedToUserId: "cleaner-1",
      status: "assigned",
      windowStartAt: d("2026-05-02T11:00:00+07:00"),
      windowEndAt: d("2026-05-02T12:00:00+07:00"),
      fixedPayVnd: 120_000,
      damageChargesVnd: 0,
      photoUrls: [],
      ...overrides,
    };
  }

  it("assigned cleaner can mark arrived, start, and complete the job", () => {
    const job = makeJob();
    const target = booking({ status: "checked_out" });
    const profile: CleaningCrewProfile = {
      ...cleanerProfile,
      jobsCompleted: 5,
    };

    markCleaningArrived({
      job,
      user: cleanerOne,
      now: d("2026-05-02T11:05:00+07:00"),
    });
    expect(job.status).toBe("arrived");

    startCleaning({
      job,
      booking: target,
      user: cleanerOne,
      now: d("2026-05-02T11:10:00+07:00"),
    });
    expect(job.status).toBe("in_progress");
    expect(target.status).toBe("cleaning_in_progress");

    completeCleaning({
      job,
      booking: target,
      profile,
      user: cleanerOne,
      now: d("2026-05-02T11:55:00+07:00"),
    });
    expect(job.status).toBe("completed");
    expect(target.status).toBe("cleaned");
    expect(profile.jobsCompleted).toBe(6);
  });

  it("a different cleaner cannot update someone else's job", () => {
    const job = makeJob();
    expect(() => markCleaningArrived({ job, user: cleanerTwo })).toThrow(
      /not authorized/,
    );
  });

  it("manager can update any cleaning job", () => {
    const job = makeJob();
    const target = booking();
    markCleaningArrived({
      job,
      user: manager,
      now: d("2026-05-02T11:05:00+07:00"),
    });
    startCleaning({
      job,
      booking: target,
      user: manager,
      now: d("2026-05-02T11:10:00+07:00"),
    });
    expect(job.status).toBe("in_progress");
  });

  it("reportMinibarUsage adds to booking minibar charges", () => {
    const job = makeJob({ status: "in_progress" });
    const target = booking({ minibarChargesVnd: 0 });
    const usage = reportMinibarUsage({
      id: "usage-1",
      job,
      booking: target,
      item: waterItem,
      quantity: 3,
      user: cleanerOne,
    });
    expect(usage.totalVnd).toBe(45_000);
    expect(target.minibarChargesVnd).toBe(45_000);
  });

  it("reportCleaningDamage updates job and booking damage charges", () => {
    const job = makeJob({ status: "in_progress" });
    const target = booking({ damageChargesVnd: 0 });
    reportCleaningDamage({
      job,
      booking: target,
      user: cleanerOne,
      damageChargesVnd: 200_000,
      notes: "Broken lamp",
    });
    expect(job.damageChargesVnd).toBe(200_000);
    expect(job.damageNotes).toBe("Broken lamp");
    expect(target.damageChargesVnd).toBe(200_000);
  });

  it("addCleaningPhoto appends to photo urls", () => {
    const job = makeJob({ status: "in_progress" });
    addCleaningPhoto({
      job,
      user: cleanerOne,
      photoUrl: "https://example.com/p1.jpg",
    });
    addCleaningPhoto({
      job,
      user: cleanerOne,
      photoUrl: "https://example.com/p2.jpg",
    });
    expect(job.photoUrls).toEqual([
      "https://example.com/p1.jpg",
      "https://example.com/p2.jpg",
    ]);
  });

  it("only admin or manager can rate cleaning, and only after completion", () => {
    const job = makeJob({ status: "in_progress" });
    const profile: CleaningCrewProfile = {
      ...cleanerProfile,
      averageRating: undefined,
    };

    expect(() =>
      rateCleaning({
        id: "rating-1",
        job,
        profile,
        ratedBy: cleanerOne,
        rating: 5,
      }),
    ).toThrow(/admin or manager/);

    expect(() =>
      rateCleaning({ id: "rating-1", job, profile, ratedBy: admin, rating: 5 }),
    ).toThrow(/completed/);

    job.status = "completed";
    rateCleaning({ id: "rating-1", job, profile, ratedBy: admin, rating: 4 });
    expect(profile.averageRating).toBe(4);

    rateCleaning({
      id: "rating-2",
      job,
      profile,
      ratedBy: manager,
      rating: 2,
      existingRatingsCount: 1,
    });
    expect(profile.averageRating).toBe(3);
  });
});

describe("createBookingFromHold", () => {
  it("mints a booking from an active hold and expires the hold", () => {
    const context = { bookings: [], holds: [] as BookingHold[] };
    const heldUntilAt = d("2026-04-15T10:15:00+07:00");
    const created = createHold({
      id: "hold-from-test",
      roomId: "room-1",
      requestedCheckIn: d("2026-05-01T15:00:00+07:00"),
      requestedCheckOut: d("2026-05-02T11:00:00+07:00"),
      createdAt: d("2026-04-15T10:00:00+07:00"),
      context,
    });
    expect(created.heldUntil).toEqual(heldUntilAt);

    const result = createBookingFromHold({
      id: "booking-new",
      bookingNumber: "BNB-2026-0001",
      hold: created,
      guest,
      room,
      rates,
      bookingType: "day",
      salesAgentId: "agent-1",
      now: d("2026-04-15T10:05:00+07:00"),
    });

    expect(result.booking.status).toBe("pending_payment");
    expect(result.booking.paymentStatus).toBe("pending");
    expect(result.booking.bookingNumber).toBe("BNB-2026-0001");
    expect(result.booking.finalRoomChargeVnd).toBe(1_000_000);
    expect(result.booking.amountDueVnd).toBe(1_500_000);
    expect(result.payment.method).toBe("bank_transfer");
    expect(result.payment.amountVnd).toBe(1_500_000);
    expect(created.expiredAt).toEqual(d("2026-04-15T10:05:00+07:00"));
  });

  it("rejects creation from a hold that already expired", () => {
    const expiredHold: BookingHold = {
      ...hold(),
      expiredAt: d("2026-04-15T10:30:00+07:00"),
    };
    expect(() =>
      createBookingFromHold({
        id: "booking-x",
        bookingNumber: "BNB-X",
        hold: expiredHold,
        guest,
        room,
        rates,
        bookingType: "day",
      }),
    ).toThrow(/expired/);
  });
});

describe("applyConfirmationSideEffects", () => {
  it("populates calculatedCommissionVnd and assigns cleaning without flipping status", () => {
    const target = booking({ status: "confirmed", calculatedCommissionVnd: 0 });
    const rules: AgentCommissionRule[] = [
      {
        id: "commission-side-effects",
        salesAgentId: "agent-1",
        commissionType: "percentage",
        value: 10,
        isActive: true,
      },
    ];
    const availability: CleaningAvailability[] = [
      {
        id: "availability-conf",
        cleaningCrewUserId: "cleaner-1",
        availableFrom: d("2026-05-02T11:00:00+07:00"),
        availableUntil: d("2026-05-02T14:00:00+07:00"),
        isActive: true,
      },
    ];

    const result = applyConfirmationSideEffects({
      booking: target,
      commissionRules: rules,
      asOfDate: "2026-05-01",
      cleaning: {
        cleaningJobId: "cj-confirm",
        availability,
        crewProfiles: [cleanerProfile],
      },
    });

    expect(result.commissionVnd).toBe(100_000);
    expect(target.calculatedCommissionVnd).toBe(100_000);
    expect(target.status).toBe("confirmed");
    expect(result.cleaningJob?.assignedToUserId).toBe("cleaner-1");
  });
});

describe("lifecycle transitions", () => {
  it("checkInGuest requires confirmed status and operational role", () => {
    const target = booking({ status: "confirmed" });
    expect(() => checkInGuest({ booking: target, by: agentOne })).toThrow(
      /admin or manager/,
    );
    checkInGuest({ booking: target, by: manager });
    expect(target.status).toBe("checked_in");
    expect(() => checkInGuest({ booking: target, by: admin })).toThrow(
      /confirmed/,
    );
  });

  it("checkOutGuest moves to checked_out and can auto-assign cleaning", () => {
    const target = booking({ status: "checked_in" });
    const availability: CleaningAvailability[] = [
      {
        id: "availability-co",
        cleaningCrewUserId: "cleaner-1",
        availableFrom: d("2026-05-02T11:00:00+07:00"),
        availableUntil: d("2026-05-02T14:00:00+07:00"),
        isActive: true,
      },
    ];

    const result = checkOutGuest({
      booking: target,
      by: admin,
      cleaning: {
        cleaningJobId: "cj-checkout",
        availability,
        crewProfiles: [cleanerProfile],
      },
    });

    expect(result.cleaningJob?.assignedToUserId).toBe("cleaner-1");
    expect(target.status).toBe("cleaning_assigned");
  });

  it("closeBooking only allowed from terminal-ish states by admin/manager", () => {
    const target = booking({ status: "cleaned" });
    expect(() => closeBooking({ booking: target, by: agentOne })).toThrow(
      /admin or manager/,
    );
    closeBooking({ booking: target, by: admin });
    expect(target.status).toBe("closed");

    const open = booking({ status: "confirmed" });
    expect(() => closeBooking({ booking: open, by: admin })).toThrow(
      /cannot be closed/,
    );
  });
});

describe("permission helpers", () => {
  it("canEditBooking returns true for admin/manager and only own bookings for agents", () => {
    const own = booking({ salesAgentId: "agent-1" });
    const other = booking({ salesAgentId: "agent-2" });
    expect(canEditBooking(admin, own)).toBe(true);
    expect(canEditBooking(manager, other)).toBe(true);
    expect(canEditBooking(agentOne, own)).toBe(true);
    expect(canEditBooking(agentOne, other)).toBe(false);
    expect(canEditBooking(cleanerOne, own)).toBe(false);
  });

  it("canApproveCancellation true only for admin/manager", () => {
    expect(canApproveCancellation(admin)).toBe(true);
    expect(canApproveCancellation(manager)).toBe(true);
    expect(canApproveCancellation(agentOne)).toBe(false);
    expect(canApproveCancellation(cleanerOne)).toBe(false);
  });
});
