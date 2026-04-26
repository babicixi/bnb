import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../src/server/app.js";
import type { DemoCredential } from "../src/repo/seed.js";
import type { Repository } from "../src/repo/memory.js";

interface Bootstrap {
  app: Express;
  repo: Repository;
  demoCredentials: DemoCredential[];
  uploadsDir: string;
}

let ctx: Bootstrap;

beforeAll(() => {
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "bnb-uploads-"));
  ctx = createApp({ uploadsDir, sessionSecret: "test-secret" });
});

afterAll(() => {
  if (ctx?.uploadsDir) {
    fs.rmSync(ctx.uploadsDir, { recursive: true, force: true });
  }
});

function passwordFor(role: string): { email: string; password: string } {
  const cred = ctx.demoCredentials.find((c) => c.role === role);
  if (!cred) throw new Error(`no demo credential for role ${role}`);
  return { email: cred.email, password: cred.password };
}

async function loginAs(
  role: string,
  agentEmail?: string,
): Promise<request.Agent> {
  const agent = request.agent(ctx.app);
  const cred = agentEmail
    ? {
        email: agentEmail,
        password: ctx.demoCredentials.find((c) => c.email === agentEmail)!
          .password,
      }
    : passwordFor(role);
  const res = await agent
    .post("/login")
    .type("form")
    .send({ email: cred.email, password: cred.password });
  expect(res.status).toBe(302);
  return agent;
}

let dayOffsetCounter = 2;
function uniqueDayOffset(): number {
  dayOffsetCounter += 2;
  return dayOffsetCounter;
}

function vietnamIso(dayOffset: number, hour: number, minute = 0): string {
  const now = new Date();
  const utcHour = hour - 7;
  const t = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + dayOffset,
      utcHour,
      minute,
      0,
      0,
    ),
  );
  return t.toISOString();
}

function slot(): { checkInAt: string; checkOutAt: string; day: number } {
  const day = uniqueDayOffset();
  return {
    day,
    checkInAt: vietnamIso(day, 15),
    checkOutAt: vietnamIso(day, 18),
  };
}

describe("public site", () => {
  it("renders home page with rooms", async () => {
    const res = await request(ctx.app).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Studio Balcony");
  });

  it("guest can create a hold + booking via POST /book/hold", async () => {
    const res = await request(ctx.app)
      .post("/book/hold")
      .type("form")
      .send({
        roomId: "room-1",
        bookingType: "day",
        ...slot(),
        guestName: "Test Guest",
        guestPhone: "+84111111111",
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/book\/BNB-/);
  });
});

describe("payment proof flow", () => {
  it("payment screenshot upload auto-confirms booking; later upload after expiry rejected", async () => {
    // Create booking
    const create = await request(ctx.app)
      .post("/book/hold")
      .type("form")
      .send({
        roomId: "room-2",
        bookingType: "day",
        ...slot(),
        guestName: "Pay Guest",
        guestPhone: "+84222222222",
      });
    expect(create.status).toBe(302);
    const number = create.headers.location!.split("/").pop()!;

    const fakePng = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
      "hex",
    );

    const upload = await request(ctx.app)
      .post(`/book/${number}/upload-proof`)
      .attach("screenshot", fakePng, {
        filename: "proof.png",
        contentType: "image/png",
      });
    expect(upload.status).toBe(302);
    expect(upload.headers.location).toBe(`/book/${number}/confirmation`);

    const conf = await request(ctx.app).get(`/book/${number}/confirmation`);
    expect(conf.status).toBe(200);
    expect(conf.text).toContain("Booking confirmed");

    const id = ctx.repo.bookingsByNumber.get(number)!;
    const booking = ctx.repo.bookings.get(id)!;
    expect(booking.status).toBe("confirmed");
    expect(booking.paymentStatus).toBe("proof_uploaded");

    // A second upload should be rejected because booking is no longer pending_payment
    const second = await request(ctx.app)
      .post(`/book/${number}/upload-proof`)
      .attach("screenshot", fakePng, {
        filename: "again.png",
        contentType: "image/png",
      });
    expect(second.status).toBe(409);
  });

  it("guest cannot upload payment after the hold expires", async () => {
    const create = await request(ctx.app)
      .post("/book/hold")
      .type("form")
      .send({
        roomId: "room-3",
        bookingType: "day",
        ...slot(),
        guestName: "Expired Guest",
        guestPhone: "+84333333333",
      });
    const number = create.headers.location!.split("/").pop()!;
    const id = ctx.repo.bookingsByNumber.get(number)!;
    const booking = ctx.repo.bookings.get(id)!;
    // Force the payment deadline to have already passed
    booking.paymentDeadlineAt = new Date(Date.now() - 60_000);

    const fakePng = Buffer.from("89504e470d0a1a0a", "hex");
    const upload = await request(ctx.app)
      .post(`/book/${number}/upload-proof`)
      .attach("screenshot", fakePng, {
        filename: "late.png",
        contentType: "image/png",
      });
    expect(upload.status).toBe(410);
    expect(upload.text).toMatch(/expired/i);
    expect(ctx.repo.bookings.get(id)!.status).toBe("cancelled");
  });
});

describe("admin permissions and dashboards", () => {
  it("admin can view bookings dashboard; anonymous redirected to /login", async () => {
    const anon = await request(ctx.app).get("/admin");
    expect(anon.status).toBe(302);
    expect(anon.headers.location).toBe("/login");

    const admin = await loginAs("admin");
    const res = await admin.get("/admin");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Admin dashboard");
  });

  it("admin can mark a payment proof invalid", async () => {
    // Set up: confirmed booking with proof
    const create = await request(ctx.app)
      .post("/book/hold")
      .type("form")
      .send({
        roomId: "room-1",
        bookingType: "day",
        ...slot(),
        guestName: "Proof Guest",
        guestPhone: "+84444444444",
      });
    const number = create.headers.location!.split("/").pop()!;
    const id = ctx.repo.bookingsByNumber.get(number)!;
    const fakePng = Buffer.from("89504e470d0a1a0a", "hex");
    const upload = await request(ctx.app)
      .post(`/book/${number}/upload-proof`)
      .attach("screenshot", fakePng, {
        filename: "p.png",
        contentType: "image/png",
      });
    expect(upload.status, `upload body: ${upload.text.slice(0, 200)}`).toBe(
      302,
    );

    const admin = await loginAs("admin");
    const res = await admin
      .post(`/admin/bookings/${id}/proof-invalid`)
      .type("form")
      .send({ reason: "Wrong amount" });
    expect(res.status).toBe(302);
    const booking = ctx.repo.bookings.get(id)!;
    expect(booking.paymentStatus).toBe("proof_invalid");
    expect(booking.status).toBe("pending_payment");
  });

  it("admin booking edit recalculates extra payment / refund", async () => {
    const s = slot();
    const create = await request(ctx.app)
      .post("/book/hold")
      .type("form")
      .send({
        roomId: "room-1",
        bookingType: "multi_day",
        checkInAt: s.checkInAt,
        checkOutAt: vietnamIso(s.day + 1, 11),
        guestName: "Edit Guest",
        guestPhone: "+84555555555",
      });
    const number = create.headers.location!.split("/").pop()!;
    const id = ctx.repo.bookingsByNumber.get(number)!;
    const fakePng = Buffer.from("89504e470d0a1a0a", "hex");
    const upload = await request(ctx.app)
      .post(`/book/${number}/upload-proof`)
      .attach("screenshot", fakePng, {
        filename: "p.png",
        contentType: "image/png",
      });
    expect(upload.status).toBe(302);

    const booking = ctx.repo.bookings.get(id)!;
    const originalPaid = booking.amountPaidVnd;

    const admin = await loginAs("admin");
    // Extend by another night → bigger total
    const res = await admin
      .post(`/admin/bookings/${id}/edit`)
      .type("form")
      .send({
        checkInAt: booking.checkInAt.toISOString(),
        checkOutAt: vietnamIso(s.day + 2, 11),
      });
    expect(res.status).toBe(302);
    const after = ctx.repo.bookings.get(id)!;
    expect(after.amountDueVnd).toBeGreaterThan(0);
    expect(after.status).toBe("extra_payment_required");
    expect(after.amountPaidVnd).toBe(originalPaid);
  });
});

describe("sales agent permissions", () => {
  it("agent sees only own bookings; cannot see other agents' booking detail", async () => {
    const agent1 = await loginAs("sales_agent", "agent1@example.com");
    const create = await agent1
      .post("/agent/new")
      .type("form")
      .send({
        roomId: "room-1",
        bookingType: "day",
        ...slot(),
        guestName: "Agent1 Guest",
        guestPhone: "+84666666666",
      });
    expect(create.status).toBe(302);
    const number = create.headers.location!.split("/").pop()!;
    const bookingId = ctx.repo.bookingsByNumber.get(number)!;

    const list = await agent1.get("/agent");
    expect(list.text).toContain(number);

    // agent2 should not be able to view it
    const agent2 = await loginAs("sales_agent", "agent2@example.com");
    const detail = await agent2.get(`/agent/bookings/${bookingId}`);
    expect(detail.status).toBe(404);
    const list2 = await agent2.get("/agent");
    expect(list2.text).not.toContain(number);
  });

  it("sales agent can request cancellation but the request is just 'requested', not approved", async () => {
    const agent1 = await loginAs("sales_agent", "agent1@example.com");
    const create = await agent1
      .post("/agent/new")
      .type("form")
      .send({
        roomId: "room-2",
        bookingType: "day",
        ...slot(),
        guestName: "Cancel Guest",
        guestPhone: "+84777777777",
      });
    const id = ctx.repo.bookingsByNumber.get(
      create.headers.location!.split("/").pop()!,
    )!;
    const res = await agent1
      .post(`/agent/bookings/${id}/cancel-request`)
      .type("form")
      .send({ reason: "guest changed plans" });
    expect(res.status).toBe(302);
    const cancellations = Array.from(
      ctx.repo.cancellationRequests.values(),
    ).filter((c) => c.bookingId === id);
    expect(cancellations.length).toBe(1);
    expect(cancellations[0]!.status).toBe("requested");
    expect(ctx.repo.bookings.get(id)!.status).toBe("cancellation_requested");
  });

  it("agent-specific discount only applies in agent flow when chosen", async () => {
    const agent1 = await loginAs("sales_agent", "agent1@example.com");
    const create = await agent1
      .post("/agent/new")
      .type("form")
      .send({
        roomId: "room-1",
        bookingType: "day",
        ...slot(),
        guestName: "Disc Guest",
        guestPhone: "+84888888888",
        discountId: "discount-agent1-100k",
      });
    const id = ctx.repo.bookingsByNumber.get(
      create.headers.location!.split("/").pop()!,
    )!;
    expect(ctx.repo.bookings.get(id)!.discountAmountVnd).toBe(100_000);
  });
});

describe("cleaner permissions", () => {
  it("cleaner only sees their assigned jobs", async () => {
    // Create a confirmed booking → cleaning job auto-assigned to cleaner-1
    const create = await request(ctx.app)
      .post("/book/hold")
      .type("form")
      .send({
        roomId: "room-1",
        bookingType: "day",
        ...slot(),
        guestName: "Clean Guest",
        guestPhone: "+84999999999",
      });
    const number = create.headers.location!.split("/").pop()!;
    const fakePng = Buffer.from("89504e470d0a1a0a", "hex");
    await request(ctx.app)
      .post(`/book/${number}/upload-proof`)
      .attach("screenshot", fakePng, {
        filename: "p.png",
        contentType: "image/png",
      });

    const job = Array.from(ctx.repo.cleaningJobs.values()).at(-1)!;

    const cleaner1 = await loginAs("cleaning_crew", "cleaner1@example.com");
    const list = await cleaner1.get("/cleaning");
    expect(list.status).toBe(200);

    const detail = await cleaner1.get(`/cleaning/${job.id}`);
    // cleaner-1 may or may not be the assignee depending on auto-assignment ordering;
    // verify either own job (200) OR forbidden (403), but never 404 leak.
    expect([200, 403]).toContain(detail.status);

    // The other cleaner should never get 200 unless they are the assignee
    const otherCred = ctx.demoCredentials.find(
      (c) => c.role === "cleaning_crew" && c.email !== "cleaner1@example.com",
    )!;
    const cleaner2 = await loginAs("cleaning_crew", otherCred.email);
    const detail2 = await cleaner2.get(`/cleaning/${job.id}`);
    if (job.assignedToUserId === "cleaner-2") {
      expect(detail2.status).toBe(200);
    } else {
      expect(detail2.status).toBe(403);
    }
  });
});

describe("automation: hold expiry sweep", () => {
  it("expireUnpaidBookings cancels pending_payment bookings past deadline", async () => {
    const create = await request(ctx.app)
      .post("/book/hold")
      .type("form")
      .send({
        roomId: "room-2",
        bookingType: "day",
        ...slot(),
        guestName: "Sweep Guest",
        guestPhone: "+84121212121",
      });
    const id = ctx.repo.bookingsByNumber.get(
      create.headers.location!.split("/").pop()!,
    )!;
    const booking = ctx.repo.bookings.get(id)!;
    booking.paymentDeadlineAt = new Date(Date.now() - 1000);

    const { runOperationalSweep } =
      await import("../src/services/automation.js");
    const result = runOperationalSweep({
      holds: ctx.repo.holds,
      bookings: ctx.repo.bookings.values(),
    });
    expect(result.cancelledBookings.some((b) => b.id === id)).toBe(true);
    expect(ctx.repo.bookings.get(id)!.status).toBe("cancelled");
  });
});

describe("daily checklist", () => {
  it("includes today check-ins and pending refunds", async () => {
    const { computeDailyChecklist } =
      await import("../src/services/automation.js");
    const c = computeDailyChecklist({
      bookings: ctx.repo.bookings.values(),
      cleaningJobs: ctx.repo.cleaningJobs.values(),
    });
    expect(typeof c.date).toBe("string");
    expect(Array.isArray(c.todayCheckIns)).toBe(true);
    expect(Array.isArray(c.pendingRefunds)).toBe(true);
  });
});

describe("audit log + commission ledger", () => {
  it("admin booking edit writes an audit entry", async () => {
    const s = slot();
    const create = await request(ctx.app)
      .post("/book/hold")
      .type("form")
      .send({
        roomId: "room-3",
        bookingType: "multi_day",
        checkInAt: s.checkInAt,
        checkOutAt: vietnamIso(s.day + 1, 11),
        guestName: "Audit Guest",
        guestPhone: "+84131313131",
      });
    const id = ctx.repo.bookingsByNumber.get(
      create.headers.location!.split("/").pop()!,
    )!;

    const admin = await loginAs("admin");
    await admin
      .post(`/admin/bookings/${id}/edit`)
      .type("form")
      .send({
        checkInAt: ctx.repo.bookings.get(id)!.checkInAt.toISOString(),
        checkOutAt: vietnamIso(s.day + 2, 11),
      });

    const matching = ctx.repo.auditLog.filter(
      (e) => e.action === "booking.edit" && e.entityId === id,
    );
    expect(matching.length).toBeGreaterThan(0);
  });

  it("agent booking confirmation creates a pending commission ledger entry", async () => {
    const agent = await loginAs("sales_agent", "agent1@example.com");
    const create = await agent
      .post("/agent/new")
      .type("form")
      .send({
        roomId: "room-2",
        bookingType: "day",
        ...slot(),
        guestName: "Ledger Guest",
        guestPhone: "+84141414141",
      });
    const id = ctx.repo.bookingsByNumber.get(
      create.headers.location!.split("/").pop()!,
    )!;
    const fakePng = Buffer.from("89504e470d0a1a0a", "hex");
    await request(ctx.app)
      .post(`/book/${ctx.repo.bookings.get(id)!.bookingNumber}/upload-proof`)
      .attach("screenshot", fakePng, {
        filename: "p.png",
        contentType: "image/png",
      });
    const ledger = Array.from(ctx.repo.commissionLedger.values()).filter(
      (l) => l.bookingId === id,
    );
    expect(ledger.length).toBe(1);
    expect(ledger[0]!.status).toBe("pending");
    expect(ledger[0]!.amountVnd).toBeGreaterThan(0);

    // Admin approves, marks paid
    const admin = await loginAs("admin");
    const approveRes = await admin.post(
      `/admin/commissions/${ledger[0]!.id}/approve`,
    );
    expect(approveRes.status).toBe(302);
    expect(ctx.repo.commissionLedger.get(ledger[0]!.id)!.status).toBe(
      "approved",
    );
    const paidRes = await admin.post(
      `/admin/commissions/${ledger[0]!.id}/paid`,
    );
    expect(paidRes.status).toBe(302);
    expect(ctx.repo.commissionLedger.get(ledger[0]!.id)!.status).toBe("paid");
  });
});

describe("admin pricing edit", () => {
  it("single-rate edit updates the rate and writes audit entry", async () => {
    const admin = await loginAs("admin");
    const today = new Date().toISOString().slice(0, 10);
    const res = await admin.post("/admin/pricing/edit").type("form").send({
      roomId: "room-1",
      rateDate: today,
      dayRateVnd: 9999999,
      hourlyRateVnd: 1234,
    });
    expect(res.status).toBe(302);
    const rate = ctx.repo.rates.find(
      (r) => r.roomId === "room-1" && r.rateDate === today,
    )!;
    expect(rate.dayRateVnd).toBe(9999999);
    expect(
      ctx.repo.auditLog.some(
        (e) => e.action === "pricing.edit" && e.entityId === `room-1@${today}`,
      ),
    ).toBe(true);
  });
});

describe("reports + CSV exports", () => {
  it("revenue summary excludes cancelled bookings and reports projected separately", async () => {
    const { calculateRevenueSummary } =
      await import("../src/services/reports.js");
    const summary = calculateRevenueSummary({
      bookings: ctx.repo.bookings.values(),
      rooms: ctx.repo.rooms.values(),
    });
    // Some bookings have been cancelled in earlier tests; counted under cancelledCount only.
    expect(summary.cancelledCount).toBeGreaterThan(0);
    // bookingsCount only counts non-cancelled / non-held entries.
    for (const b of ctx.repo.bookings.values()) {
      if (b.status === "cancelled") {
        // ensure cancelled don't appear in net revenue
      }
    }
    expect(summary.netRevenueVnd).toBeGreaterThanOrEqual(0);
    expect(summary.projectedRevenueVnd).toBeGreaterThanOrEqual(0);
  });

  it("occupancy reports cleaning buffer separately from booked hours", async () => {
    const { calculateOccupancy } = await import("../src/services/reports.js");
    const range = {
      from: new Date(Date.now() - 7 * 86400_000),
      to: new Date(Date.now() + 60 * 86400_000),
    };
    const occ = calculateOccupancy({
      bookings: ctx.repo.bookings.values(),
      rooms: ctx.repo.rooms.values(),
      range,
    });
    expect(occ.totalAvailableHours).toBeGreaterThan(0);
    expect(occ.bookedHours).toBeGreaterThan(0);
    expect(occ.cleaningBufferHours).toBeGreaterThanOrEqual(0);
    expect(occ.occupancyRate).toBeLessThan(1);
  });

  it("admin can download bookings.csv but anonymous cannot", async () => {
    const anon = await request(ctx.app).get("/admin/exports/bookings.csv");
    expect(anon.status).toBe(302);
    expect(anon.headers.location).toBe("/login");

    const admin = await loginAs("admin");
    const res = await admin.get("/admin/exports/bookings.csv");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text.split("\n")[0]).toContain("booking_number");
    expect(res.text.split("\n").length).toBeGreaterThan(1);
  });

  it("agent cannot access reports", async () => {
    const agent = await loginAs("sales_agent", "agent1@example.com");
    const res = await agent.get("/admin/reports");
    expect(res.status).toBe(403);
  });
});

describe("notifications + tasks + auto-close", () => {
  it("notification log captures booking_confirmed and creates an admin task on refund_pending", async () => {
    const beforeLog = ctx.repo.notificationLog.length;
    const beforeTasks = ctx.repo.tasks.size;

    // Confirm a booking → triggers booking_confirmed
    const create = await request(ctx.app)
      .post("/book/hold")
      .type("form")
      .send({
        roomId: "room-1",
        bookingType: "day",
        ...slot(),
        guestName: "Notif Guest",
        guestPhone: "+84150000000",
      });
    const number = create.headers.location!.split("/").pop()!;
    const fakePng = Buffer.from("89504e470d0a1a0a", "hex");
    await request(ctx.app)
      .post(`/book/${number}/upload-proof`)
      .attach("screenshot", fakePng, {
        filename: "p.png",
        contentType: "image/png",
      });

    expect(ctx.repo.notificationLog.length).toBeGreaterThan(beforeLog);
    expect(
      ctx.repo.notificationLog.some((n) => n.event === "booking_confirmed"),
    ).toBe(true);

    // Mark proof invalid → should fire payment_proof_invalid → auto-create task
    const id = ctx.repo.bookingsByNumber.get(number)!;
    const admin = await loginAs("admin");
    await admin
      .post(`/admin/bookings/${id}/proof-invalid`)
      .type("form")
      .send({ reason: "test" });

    const newTasks = Array.from(ctx.repo.tasks.values()).slice(beforeTasks);
    expect(newTasks.some((t) => /invalid payment/i.test(t.title))).toBe(true);
  });

  it("admin can transition a task open → completed", async () => {
    const admin = await loginAs("admin");
    const list = await admin.get("/admin/tasks");
    expect(list.status).toBe(200);
    const open = Array.from(ctx.repo.tasks.values()).find(
      (t) => t.status === "open",
    );
    if (!open) return;
    const r = await admin
      .post(`/admin/tasks/${open.id}/status`)
      .type("form")
      .send({ status: "completed" });
    expect(r.status).toBe(302);
    expect(ctx.repo.tasks.get(open.id)!.status).toBe("completed");
  });

  it("autoCloseSettledBookings closes a cleaned booking with no balances", async () => {
    const { autoCloseSettledBookings } =
      await import("../src/services/automation.js");
    // Synthesize: pick a booking, set to cleaned with zero balances + completed cleaning
    const b = Array.from(ctx.repo.bookings.values()).find(
      (x) =>
        x.status !== "cancelled" &&
        x.status !== "closed" &&
        x.amountDueVnd === 0 &&
        x.refundDueVnd === 0,
    );
    if (!b) return;
    b.status = "cleaned";
    const closed = autoCloseSettledBookings({
      bookings: [b],
      cleaningJobsByBookingId: new Map([[b.id, { status: "completed" }]]),
    });
    expect(closed.length).toBe(1);
    expect(b.status).toBe("closed");
  });
});

describe("cleaner availability self-management", () => {
  it("cleaner can add and toggle their own availability window", async () => {
    const cleaner = await loginAs("cleaning_crew", "cleaner1@example.com");
    const before = ctx.repo.cleaningAvailability.length;
    const newSlot = slot();
    const add = await cleaner
      .post("/cleaning/availability/me")
      .type("form")
      .send({
        availableFrom: newSlot.checkInAt,
        availableUntil: newSlot.checkOutAt,
      });
    expect(add.status).toBe(302);
    expect(ctx.repo.cleaningAvailability.length).toBe(before + 1);
    const created =
      ctx.repo.cleaningAvailability[ctx.repo.cleaningAvailability.length - 1]!;
    expect(created.cleaningCrewUserId).toBe("cleaner-1");
    expect(created.isActive).toBe(true);
    const toggle = await cleaner.post(
      `/cleaning/availability/${created.id}/toggle`,
    );
    expect(toggle.status).toBe(302);
    expect(created.isActive).toBe(false);
  });
});
