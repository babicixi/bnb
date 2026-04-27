import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import multer from "multer";
import { Router, type Express } from "express";
import { z } from "zod";
import {
  approveCancellation,
  autoAssignCleaningJob,
  calculateBookingPrice,
  editBookingTimes,
  markPaymentProofInvalid,
  requestCancellation,
} from "../../index.js";
import { nextId, type Repository } from "../../repo/memory.js";
import { requireRole } from "../middleware/auth.js";
import { notify } from "../../services/notifications.js";
import { parseVietnamLocal } from "../parseTime.js";
import { computeDailyChecklist } from "../../services/automation.js";
import {
  bookingsToCsv,
  calculateAgentPerformance,
  calculateCleanerPerformance,
  calculateOccupancy,
  calculateRevenueSummary,
  rowsToCsv,
} from "../../services/reports.js";
import { snapshotBooking } from "../../services/audit.js";
import { audit } from "../auditHelper.js";
import {
  approveCommission,
  markCommissionPaid,
  voidCommission,
} from "../../services/commissionLedger.js";
import type { RequestWithUser } from "../middleware/auth.js";

function defaultRange(): { from: Date; to: Date } {
  const now = new Date();
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - 30);
  const to = new Date(now);
  to.setUTCDate(to.getUTCDate() + 60);
  return { from, to };
}

const filterSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.string().optional(),
  paymentStatus: z.string().optional(),
  buildingId: z.string().optional(),
  roomId: z.string().optional(),
  agentId: z.string().optional(),
  view: z.enum(["table", "calendar"]).optional(),
  cal: z.string().optional(), // anchor month for calendar, YYYY-MM
});

function buildCalendar(input: {
  bookings: Array<import("../../domain/types.js").Booking>;
  guests: Map<string, import("../../domain/types.js").Guest>;
  rooms: Array<import("../../domain/types.js").Room>;
  maintenance: Array<import("../../domain/types.js").MaintenanceBlock>;
  filters: Record<string, string | undefined>;
  anchorMonth?: string;
}) {
  const now = new Date();
  let year: number;
  let month: number; // 0-11
  if (input.anchorMonth && /^\d{4}-\d{2}$/.test(input.anchorMonth)) {
    const [y, m] = input.anchorMonth.split("-").map(Number);
    year = y!;
    month = m! - 1;
  } else {
    year = now.getUTCFullYear();
    month = now.getUTCMonth();
  }
  const firstDay = new Date(Date.UTC(year, month, 1));
  const nextMonth = new Date(Date.UTC(year, month + 1, 1));
  const daysInMonth = Math.round(
    (nextMonth.getTime() - firstDay.getTime()) / 86_400_000,
  );

  const days = [];
  for (let i = 0; i < daysInMonth; i++) {
    const d = new Date(Date.UTC(year, month, i + 1));
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    days.push({
      iso,
      day: i + 1,
      dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow],
      isWeekend: dow === 0 || dow === 6,
      label: iso,
    });
  }

  const byRoomDay: Record<
    string,
    Record<string, Array<{ booking: import("../../domain/types.js").Booking; guestName: string }>>
  > = {};
  const maintenanceByRoomDay: Record<
    string,
    Record<string, Array<import("../../domain/types.js").MaintenanceBlock>>
  > = {};

  const monthStart = firstDay;
  const monthEnd = nextMonth;

  for (const b of input.bookings) {
    if (b.status === "cancelled" || b.status === "held") continue;
    const start = b.checkInAt < monthStart ? monthStart : b.checkInAt;
    const end = b.checkOutAt > monthEnd ? monthEnd : b.checkOutAt;
    if (start >= monthEnd || end <= monthStart) continue;
    const guest = input.guests.get(b.guestId);
    const guestName = guest ? guest.fullName : "—";
    let cursor = new Date(
      Date.UTC(
        start.getUTCFullYear(),
        start.getUTCMonth(),
        start.getUTCDate(),
      ),
    );
    const endDay = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()),
    );
    while (cursor <= endDay && cursor < monthEnd) {
      const iso = cursor.toISOString().slice(0, 10);
      const room = (byRoomDay[b.roomId] ??= {});
      const dayList = (room[iso] ??= []);
      dayList.push({ booking: b, guestName });
      cursor = new Date(cursor.getTime() + 86_400_000);
    }
  }

  for (const m of input.maintenance) {
    const start = m.startsAt < monthStart ? monthStart : m.startsAt;
    const end = m.endsAt > monthEnd ? monthEnd : m.endsAt;
    if (start >= monthEnd || end <= monthStart) continue;
    let cursor = new Date(
      Date.UTC(
        start.getUTCFullYear(),
        start.getUTCMonth(),
        start.getUTCDate(),
      ),
    );
    const endDay = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()),
    );
    while (cursor <= endDay && cursor < monthEnd) {
      const iso = cursor.toISOString().slice(0, 10);
      const room = (maintenanceByRoomDay[m.roomId] ??= {});
      const dayList = (room[iso] ??= []);
      dayList.push(m);
      cursor = new Date(cursor.getTime() + 86_400_000);
    }
  }

  function buildQuery(monthIso: string): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(input.filters)) {
      if (v) params.set(k, v);
    }
    params.set("view", "calendar");
    params.set("cal", monthIso);
    return params.toString();
  }
  const prevDate = new Date(Date.UTC(year, month - 1, 1));
  const nextDate = new Date(Date.UTC(year, month + 1, 1));
  const prevQuery = buildQuery(
    `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, "0")}`,
  );
  const nextQuery = buildQuery(
    `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth() + 1).padStart(2, "0")}`,
  );

  const label = firstDay.toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return {
    days,
    byRoomDay,
    maintenanceByRoomDay,
    label,
    prevQuery,
    nextQuery,
  };
}

export function mountAdminRoutes(
  app: Express,
  repo: Repository,
  uploadsDir: string,
): void {
  fs.mkdirSync(uploadsDir, { recursive: true });
  const screenshotStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
      cb(
        null,
        `payment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`,
      );
    },
  });
  const screenshotUpload = multer({
    storage: screenshotStorage,
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (!/^image\//.test(file.mimetype)) {
        cb(new Error("Only image uploads are allowed."));
        return;
      }
      cb(null, true);
    },
  });

  const router = Router();
  router.use(requireRole("admin", "manager"));

  router.get("/", (req, res) => {
    const filters = filterSchema.parse(req.query);
    let bookings = Array.from(repo.bookings.values());
    if (filters.status)
      bookings = bookings.filter((b) => b.status === filters.status);
    if (filters.paymentStatus)
      bookings = bookings.filter(
        (b) => b.paymentStatus === filters.paymentStatus,
      );
    if (filters.roomId)
      bookings = bookings.filter((b) => b.roomId === filters.roomId);
    if (filters.buildingId) {
      const buildingRooms = new Set(
        Array.from(repo.rooms.values())
          .filter((r) => r.buildingId === filters.buildingId)
          .map((r) => r.id),
      );
      bookings = bookings.filter((b) => buildingRooms.has(b.roomId));
    }
    if (filters.agentId)
      bookings = bookings.filter((b) => b.salesAgentId === filters.agentId);
    if (filters.from) {
      const fromAt = new Date(filters.from);
      if (!Number.isNaN(fromAt.getTime()))
        bookings = bookings.filter((b) => b.checkInAt >= fromAt);
    }
    if (filters.to) {
      const toAt = new Date(filters.to);
      if (!Number.isNaN(toAt.getTime()))
        bookings = bookings.filter((b) => b.checkInAt <= toAt);
    }
    bookings.sort((a, b) => a.checkInAt.getTime() - b.checkInAt.getTime());

    const allRooms = Array.from(repo.rooms.values());
    const calendarRooms = filters.roomId
      ? allRooms.filter((r) => r.id === filters.roomId)
      : filters.buildingId
        ? allRooms.filter((r) => r.buildingId === filters.buildingId)
        : allRooms;
    const view = filters.view === "calendar" ? "calendar" : "table";

    const cleaningJobsByBookingId = new Map<
      string,
      import("../../domain/types.js").CleaningJob
    >();
    for (const j of repo.cleaningJobs.values()) {
      cleaningJobsByBookingId.set(j.bookingId, j);
    }

    const calendar =
      view === "calendar"
        ? buildCalendar({
            bookings: Array.from(repo.bookings.values()).filter(
              (b) =>
                (!filters.roomId || b.roomId === filters.roomId) &&
                (!filters.buildingId ||
                  calendarRooms.some((r) => r.id === b.roomId)),
            ),
            guests: repo.guests,
            rooms: calendarRooms,
            maintenance: repo.maintenanceBlocks,
            filters: filters as Record<string, string | undefined>,
            anchorMonth: filters.cal,
          })
        : null;

    res.render("admin/index", {
      title: "Admin dashboard",
      bookings,
      rooms: allRooms,
      buildings: Array.from(repo.buildings.values()),
      agents: Array.from(repo.users.values()).filter(
        (u) => u.role === "sales_agent",
      ),
      users: repo.users,
      filters,
      view,
      calendar,
      guestForBooking: (b: { guestId: string }) => repo.guests.get(b.guestId),
      roomForBooking: (b: { roomId: string }) => repo.rooms.get(b.roomId),
      cleaningJobForBooking: (b: { id: string }) =>
        cleaningJobsByBookingId.get(b.id),
    });
  });

  router.get("/bookings/:id", (req, res) => {
    const booking = repo.bookings.get(req.params.id);
    if (!booking) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const guest = repo.guests.get(booking.guestId);
    const room = repo.rooms.get(booking.roomId);
    const proofs = Array.from(repo.paymentProofs.values()).filter(
      (p) => p.bookingId === booking.id,
    );
    const cleaningJob = Array.from(repo.cleaningJobs.values()).find(
      (j) => j.bookingId === booking.id,
    );
    const cancellation = Array.from(repo.cancellationRequests.values()).find(
      (c) => c.bookingId === booking.id,
    );
    res.render("admin/booking", {
      title: `Booking ${booking.bookingNumber}`,
      booking,
      guest,
      room,
      proofs,
      cleaningJob,
      cancellation,
      cleaners: Array.from(repo.cleaningCrewProfiles.values()).map((p) => ({
        ...p,
        user: repo.users.get(p.userId),
      })),
      flash: req.session.userId ? null : null,
    });
  });

  const editSchema = z.object({
    checkInAt: z.string().min(1),
    checkOutAt: z.string().min(1),
    notes: z.string().optional(),
  });

  router.post("/bookings/:id/edit", (req, res) => {
    const booking = repo.bookings.get(req.params.id);
    if (!booking) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const parsed = editSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", {
        title: "Invalid edit",
        message: "Check the dates.",
      });
      return;
    }
    const room = repo.rooms.get(booking.roomId);
    if (!room) {
      res.status(404).render("error", { title: "Room missing", message: "" });
      return;
    }
    try {
      const before = snapshotBooking(booking);
      editBookingTimes({
        booking,
        room,
        rates: repo.rates,
        requestedCheckIn: parseVietnamLocal(parsed.data.checkInAt),
        requestedCheckOut: parseVietnamLocal(parsed.data.checkOutAt),
      });
      booking.notes = parsed.data.notes ?? booking.notes;
      audit(repo, req, {
        action: "booking.edit",
        entityType: "booking",
        entityId: booking.id,
        before,
        after: snapshotBooking(booking),
      });
      if (booking.status === "extra_payment_required")
        notify("extra_payment_required", { bookingId: booking.id });
      if (booking.status === "refund_pending")
        notify("refund_pending", { bookingId: booking.id });
      res.redirect(`/admin/bookings/${booking.id}`);
    } catch (err) {
      res.status(400).render("error", {
        title: "Cannot edit",
        message: (err as Error).message,
      });
    }
  });

  router.post("/bookings/:id/cancel", (req, res) => {
    const booking = repo.bookings.get(req.params.id);
    if (!booking) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const reviewer = (
      req as unknown as {
        currentUser: { id: string; role: "admin" | "manager" };
      }
    ).currentUser;
    const existing = Array.from(repo.cancellationRequests.values()).find(
      (c) => c.bookingId === booking.id && c.status === "requested",
    );
    const request =
      existing ??
      requestCancellation({
        id: nextId("cancel"),
        booking,
        requestedBy: {
          id: reviewer.id,
          role: reviewer.role,
          fullName: "",
          email: "",
          isActive: true,
        },
      });
    if (!existing) repo.cancellationRequests.set(request.id, request);
    approveCancellation({
      booking,
      request,
      approvedBy: {
        id: reviewer.id,
        role: reviewer.role,
        fullName: "",
        email: "",
        isActive: true,
      },
      now: new Date(),
    });
    audit(repo, req, {
      action: "booking.cancel",
      entityType: "booking",
      entityId: booking.id,
      after: {
        status: booking.status,
        cancellationFeeVnd: request.cancellationFeeVnd,
      },
    });
    notify("cancellation_approved", { bookingId: booking.id });
    res.redirect(`/admin/bookings/${booking.id}`);
  });

  router.post("/bookings/:id/proof-invalid", (req, res) => {
    const booking = repo.bookings.get(req.params.id);
    if (!booking) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const proof = Array.from(repo.paymentProofs.values()).find(
      (p) => p.bookingId === booking.id && p.status !== "invalid",
    );
    if (!proof) {
      res
        .status(400)
        .render("error", { title: "No proof to invalidate", message: "" });
      return;
    }
    const reviewer = (
      req as unknown as {
        currentUser: { id: string; role: "admin" | "manager" };
      }
    ).currentUser;
    markPaymentProofInvalid({
      proof,
      booking,
      reviewer: {
        id: reviewer.id,
        role: reviewer.role,
        fullName: "",
        email: "",
        isActive: true,
      },
      reason: String(req.body.reason ?? "Marked invalid"),
    });
    audit(repo, req, {
      action: "booking.proof_invalidated",
      entityType: "booking",
      entityId: booking.id,
      notes: String(req.body.reason ?? ""),
    });
    notify("payment_proof_invalid", { bookingId: booking.id });
    res.redirect(`/admin/bookings/${booking.id}`);
  });

  router.post("/bookings/:id/assign-cleaner", (req, res) => {
    const booking = repo.bookings.get(req.params.id);
    if (!booking) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const cleanerId = String(req.body.cleanerId ?? "").trim();
    const profile = repo.cleaningCrewProfiles.get(cleanerId);
    if (!profile) {
      res
        .status(400)
        .render("error", { title: "Unknown cleaner", message: "" });
      return;
    }
    const existing = Array.from(repo.cleaningJobs.values()).find(
      (j) => j.bookingId === booking.id,
    );
    if (existing) {
      existing.assignedToUserId = cleanerId;
      existing.fixedPayVnd = profile.fixedPayPerJobVnd;
      audit(repo, req, {
        action: "cleaning.assigned",
        entityType: "booking",
        entityId: booking.id,
        notes: `cleaner=${cleanerId}`,
      });
      notify("cleaning_assigned", { bookingId: booking.id });
      res.redirect(`/admin/bookings/${booking.id}`);
      return;
    }
    const filteredAvailability = repo.cleaningAvailability.filter(
      (a) => a.cleaningCrewUserId === cleanerId,
    );
    try {
      const job = autoAssignCleaningJob({
        id: nextId("cleaning"),
        booking,
        availability: filteredAvailability,
        crewProfiles: [profile],
      });
      repo.cleaningJobs.set(job.id, job);
      audit(repo, req, {
        action: "cleaning.assigned",
        entityType: "booking",
        entityId: booking.id,
        notes: `cleaner=${cleanerId}`,
      });
      notify("cleaning_assigned", { bookingId: booking.id });
    } catch (err) {
      res.status(400).render("error", {
        title: "Cannot assign",
        message: (err as Error).message,
      });
      return;
    }
    res.redirect(`/admin/bookings/${booking.id}`);
  });

  router.post("/bookings/:id/notes", (req, res) => {
    const booking = repo.bookings.get(req.params.id);
    if (!booking) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    booking.notes = String(req.body.notes ?? "");
    res.redirect(`/admin/bookings/${booking.id}`);
  });

  router.get("/refunds", (_req, res) => {
    const bookings = Array.from(repo.bookings.values()).filter(
      (b) => b.status === "refund_pending" || b.refundDueVnd > 0,
    );
    res.render("admin/list-finance", {
      title: "Pending refunds",
      heading: "Pending refunds",
      column: "refundDueVnd",
      bookings,
      guestForBooking: (b: { guestId: string }) => repo.guests.get(b.guestId),
      roomForBooking: (b: { roomId: string }) => repo.rooms.get(b.roomId),
    });
  });

  router.get("/today", (_req, res) => {
    const checklist = computeDailyChecklist({
      bookings: repo.bookings.values(),
      cleaningJobs: repo.cleaningJobs.values(),
    });
    res.render("admin/today", {
      title: "Today's operations",
      checklist,
      guestForBooking: (b: { guestId: string }) => repo.guests.get(b.guestId),
      roomForBooking: (b: { roomId: string }) => repo.rooms.get(b.roomId),
      bookingForJob: (j: { bookingId: string }) =>
        repo.bookings.get(j.bookingId),
      roomForJob: (j: { roomId: string }) => repo.rooms.get(j.roomId),
    });
  });

  router.get("/extras", (_req, res) => {
    const bookings = Array.from(repo.bookings.values()).filter(
      (b) => b.status === "extra_payment_required" || b.amountDueVnd > 0,
    );
    res.render("admin/list-finance", {
      title: "Pending extra payments",
      heading: "Pending extra payments",
      column: "amountDueVnd",
      bookings,
      guestForBooking: (b: { guestId: string }) => repo.guests.get(b.guestId),
      roomForBooking: (b: { roomId: string }) => repo.rooms.get(b.roomId),
    });
  });

  router.get("/commissions", (_req, res) => {
    const entries = Array.from(repo.commissionLedger.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    res.render("admin/commissions", {
      title: "Commissions",
      entries,
      agents: repo.users,
      bookingForEntry: (e: { bookingId: string }) =>
        repo.bookings.get(e.bookingId),
    });
  });

  router.post("/commissions/:id/approve", (req, res) => {
    const entry = repo.commissionLedger.get(req.params.id as string);
    const user = (req as RequestWithUser).currentUser!;
    if (!entry) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    try {
      approveCommission(entry, user);
      audit(repo, req, {
        action: "commission.approved",
        entityType: "commission",
        entityId: entry.id,
      });
    } catch (err) {
      res.status(400).render("error", {
        title: "Cannot approve",
        message: (err as Error).message,
      });
      return;
    }
    res.redirect("/admin/commissions");
  });

  router.post("/commissions/:id/paid", (req, res) => {
    const entry = repo.commissionLedger.get(req.params.id as string);
    const user = (req as RequestWithUser).currentUser!;
    if (!entry) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    try {
      markCommissionPaid(entry, user, new Date(), String(req.body.notes ?? ""));
      audit(repo, req, {
        action: "commission.paid",
        entityType: "commission",
        entityId: entry.id,
      });
    } catch (err) {
      res.status(400).render("error", {
        title: "Cannot mark paid",
        message: (err as Error).message,
      });
      return;
    }
    res.redirect("/admin/commissions");
  });

  router.post("/commissions/:id/void", (req, res) => {
    const entry = repo.commissionLedger.get(req.params.id as string);
    const user = (req as RequestWithUser).currentUser!;
    if (!entry) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    try {
      voidCommission(entry, user, new Date(), String(req.body.notes ?? ""));
      audit(repo, req, {
        action: "commission.voided",
        entityType: "commission",
        entityId: entry.id,
      });
    } catch (err) {
      res.status(400).render("error", {
        title: "Cannot void",
        message: (err as Error).message,
      });
      return;
    }
    res.redirect("/admin/commissions");
  });

  router.get("/pricing", (req, res) => {
    const roomId = String(
      req.query.roomId ?? Array.from(repo.rooms.keys())[0] ?? "",
    );
    const room = repo.rooms.get(roomId);
    const rates = repo.rates
      .filter((r) => r.roomId === roomId)
      .sort((a, b) => a.rateDate.localeCompare(b.rateDate))
      .slice(0, 60);
    res.render("admin/pricing", {
      title: "Pricing",
      rooms: Array.from(repo.rooms.values()),
      room,
      rates,
      flash: req.query.flash || null,
    });
  });

  // Rates come in from the form in thousands of VND ("900" → 900,000) so the
  // user can type "900" or "1500" without the trailing zeros.
  const singleRateSchema = z.object({
    roomId: z.string(),
    rateDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dayRateK: z.coerce.number().nonnegative(),
    hourlyRateK: z.coerce.number().nonnegative(),
  });

  router.post("/pricing/edit", (req, res) => {
    const parsed = singleRateSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .render("error", { title: "Invalid pricing", message: "" });
      return;
    }
    const dayRateVnd = Math.round(parsed.data.dayRateK * 1000);
    const hourlyRateVnd = Math.round(parsed.data.hourlyRateK * 1000);
    const before = repo.rates.find(
      (r) =>
        r.roomId === parsed.data.roomId && r.rateDate === parsed.data.rateDate,
    );
    const beforeSnapshot = before ? { ...before } : undefined;
    if (before) {
      before.dayRateVnd = dayRateVnd;
      before.hourlyRateVnd = hourlyRateVnd;
    } else {
      repo.rates.push({
        roomId: parsed.data.roomId,
        rateDate: parsed.data.rateDate,
        dayRateVnd,
        hourlyRateVnd,
      });
    }
    audit(repo, req, {
      action: "pricing.edit",
      entityType: "room_daily_rate",
      entityId: `${parsed.data.roomId}@${parsed.data.rateDate}`,
      before: beforeSnapshot,
      after: { ...parsed.data, dayRateVnd, hourlyRateVnd },
    });
    res.redirect(`/admin/pricing?roomId=${parsed.data.roomId}&flash=saved`);
  });

  const bulkRateSchema = z.object({
    roomId: z.string(),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dayRateK: z.coerce.number().nonnegative(),
    hourlyRateK: z.coerce.number().nonnegative(),
    weekdayOnly: z.string().optional(),
  });

  router.post("/pricing/bulk", (req, res) => {
    const parsed = bulkRateSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .render("error", { title: "Invalid bulk edit", message: "" });
      return;
    }
    const start = new Date(`${parsed.data.fromDate}T00:00:00Z`);
    const end = new Date(`${parsed.data.toDate}T00:00:00Z`);
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end < start
    ) {
      res.status(400).render("error", { title: "Bad date range", message: "" });
      return;
    }
    const dayRateVnd = Math.round(parsed.data.dayRateK * 1000);
    const hourlyRateVnd = Math.round(parsed.data.hourlyRateK * 1000);
    let cursor = start;
    let count = 0;
    while (cursor <= end) {
      const dateKey = cursor.toISOString().slice(0, 10);
      const dow = cursor.getUTCDay();
      const isWeekday = dow >= 1 && dow <= 5;
      if (!parsed.data.weekdayOnly || isWeekday) {
        const existing = repo.rates.find(
          (r) => r.roomId === parsed.data.roomId && r.rateDate === dateKey,
        );
        if (existing) {
          existing.dayRateVnd = dayRateVnd;
          existing.hourlyRateVnd = hourlyRateVnd;
        } else {
          repo.rates.push({
            roomId: parsed.data.roomId,
            rateDate: dateKey,
            dayRateVnd,
            hourlyRateVnd,
          });
        }
        count += 1;
      }
      cursor = new Date(cursor.getTime() + 24 * 60 * 60_000);
    }
    audit(repo, req, {
      action: "pricing.bulk_edit",
      entityType: "room_daily_rate",
      entityId: parsed.data.roomId,
      after: { ...parsed.data, dayRateVnd, hourlyRateVnd, count },
    });
    res.redirect(
      `/admin/pricing?roomId=${parsed.data.roomId}&flash=bulk-${count}`,
    );
  });

  const copySchema = z.object({
    fromRoomId: z.string(),
    toRoomId: z.string(),
  });

  router.post("/pricing/copy", (req, res) => {
    const parsed = copySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid copy", message: "" });
      return;
    }
    if (parsed.data.fromRoomId === parsed.data.toRoomId) {
      res.status(400).render("error", {
        title: "Same room",
        message: "Pick a different target room.",
      });
      return;
    }
    const sourceRates = repo.rates.filter(
      (r) => r.roomId === parsed.data.fromRoomId,
    );
    repo.rates = repo.rates.filter((r) => r.roomId !== parsed.data.toRoomId);
    for (const r of sourceRates) {
      repo.rates.push({ ...r, roomId: parsed.data.toRoomId });
    }
    audit(repo, req, {
      action: "pricing.copy",
      entityType: "room",
      entityId: parsed.data.toRoomId,
      after: { fromRoomId: parsed.data.fromRoomId, count: sourceRates.length },
    });
    res.redirect(`/admin/pricing?roomId=${parsed.data.toRoomId}&flash=copied`);
  });

  // ---------- Properties (buildings + rooms) ----------
  router.get("/properties", (_req, res) => {
    const rooms = Array.from(repo.rooms.values()).sort(
      (a, b) =>
        a.buildingId.localeCompare(b.buildingId) ||
        (a.roomNumber || a.name).localeCompare(b.roomNumber || b.name),
    );
    res.render("admin/properties", {
      title: "Properties",
      buildings: Array.from(repo.buildings.values()),
      rooms,
      buildingForRoom: (r: { buildingId: string }) =>
        repo.buildings.get(r.buildingId),
    });
  });

  const buildingSchema = z.object({
    name: z.string().min(1),
    address: z.string().min(1),
    city: z.string().min(1),
    district: z.string().optional(),
  });

  router.post("/properties/buildings", (req, res) => {
    const parsed = buildingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid building", message: "" });
      return;
    }
    const id = nextId("building");
    const b = {
      id,
      name: parsed.data.name,
      address: parsed.data.address,
      city: parsed.data.city,
      district: parsed.data.district || undefined,
    };
    repo.buildings.set(id, b);
    audit(repo, req, {
      action: "building.create",
      entityType: "building",
      entityId: id,
      after: b as Record<string, unknown>,
    });
    res.redirect("/admin/properties");
  });

  router.post("/properties/buildings/:id", (req, res) => {
    const b = repo.buildings.get(req.params.id as string);
    if (!b) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const parsed = buildingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid building", message: "" });
      return;
    }
    const before = { ...b };
    b.name = parsed.data.name;
    b.address = parsed.data.address;
    b.city = parsed.data.city;
    b.district = parsed.data.district || undefined;
    audit(repo, req, {
      action: "building.edit",
      entityType: "building",
      entityId: b.id,
      before: before as unknown as Record<string, unknown>,
      after: { ...b } as unknown as Record<string, unknown>,
    });
    res.redirect("/admin/properties");
  });

  function parseLines(value: string | undefined): string[] {
    if (!value) return [];
    return value
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  const roomSchema = z.object({
    buildingId: z.string().min(1),
    name: z.string().min(1),
    roomNumber: z.string().optional(),
    maxGuests: z.coerce.number().int().positive(),
    baseDayRateK: z.coerce.number().nonnegative(),
    baseHourlyRateK: z.coerce.number().nonnegative(),
    description: z.string().optional(),
    features: z.string().optional(),
    photoUrls: z.string().optional(),
    isActive: z.string().optional(),
  });

  router.post("/properties/rooms", (req, res) => {
    const parsed = roomSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid room", message: "" });
      return;
    }
    const id = nextId("room");
    const room = {
      id,
      buildingId: parsed.data.buildingId,
      name: parsed.data.name,
      roomNumber: parsed.data.roomNumber || undefined,
      maxGuests: parsed.data.maxGuests,
      baseDayRateVnd: Math.round(parsed.data.baseDayRateK * 1000),
      baseHourlyRateVnd: Math.round(parsed.data.baseHourlyRateK * 1000),
      isActive: parsed.data.isActive !== "0",
      description: parsed.data.description || undefined,
      features: parseLines(parsed.data.features),
      photoUrls: parseLines(parsed.data.photoUrls),
      syncStatus: "not_synced" as const,
    };
    repo.rooms.set(id, room);
    audit(repo, req, {
      action: "room.create",
      entityType: "room",
      entityId: id,
      after: room as Record<string, unknown>,
    });
    res.redirect("/admin/properties");
  });

  router.post("/properties/rooms/:id", (req, res) => {
    const room = repo.rooms.get(req.params.id as string);
    if (!room) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const parsed = roomSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid room", message: "" });
      return;
    }
    const before = { ...room };
    room.buildingId = parsed.data.buildingId;
    room.name = parsed.data.name;
    room.roomNumber = parsed.data.roomNumber || undefined;
    room.maxGuests = parsed.data.maxGuests;
    room.baseDayRateVnd = Math.round(parsed.data.baseDayRateK * 1000);
    room.baseHourlyRateVnd = Math.round(parsed.data.baseHourlyRateK * 1000);
    room.isActive = parsed.data.isActive !== "0";
    room.description = parsed.data.description || undefined;
    room.features = parseLines(parsed.data.features);
    room.photoUrls = parseLines(parsed.data.photoUrls);
    audit(repo, req, {
      action: "room.edit",
      entityType: "room",
      entityId: room.id,
      before: before as unknown as Record<string, unknown>,
      after: { ...room } as unknown as Record<string, unknown>,
    });
    res.redirect("/admin/properties");
  });

  router.post("/properties/rooms/:id/toggle", (req, res) => {
    const room = repo.rooms.get(req.params.id as string);
    if (!room) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    room.isActive = !room.isActive;
    audit(repo, req, {
      action: "room.toggle",
      entityType: "room",
      entityId: room.id,
      after: { isActive: room.isActive },
    });
    res.redirect("/admin/properties");
  });

  // ---------- Sales agent management ----------
  function isoMondayOf(d: Date): string {
    // Monday (Vietnam-week-aligned, but use UTC date for stability) of week containing d.
    const day = d.getUTCDay(); // 0=Sun..6=Sat
    const diff = day === 0 ? 6 : day - 1;
    const monday = new Date(
      Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate() - diff,
      ),
    );
    return monday.toISOString().slice(0, 10);
  }

  function lastNWeeks(n: number): string[] {
    const out: string[] = [];
    const start = new Date();
    for (let i = 0; i < n; i++) {
      const d = new Date(start.getTime() - i * 7 * 86_400_000);
      out.push(isoMondayOf(d));
    }
    return out;
  }

  router.get("/agents", (_req, res) => {
    const agents = Array.from(repo.users.values()).filter(
      (u) => u.role === "sales_agent",
    );
    const weeks = lastNWeeks(6);
    const ledgerByAgent = new Map<
      string,
      Array<import("../../domain/types.js").CommissionLedgerEntry>
    >();
    for (const e of repo.commissionLedger.values()) {
      const arr = ledgerByAgent.get(e.salesAgentId) ?? [];
      arr.push(e);
      ledgerByAgent.set(e.salesAgentId, arr);
    }
    const paymentsByAgent = new Map<
      string,
      Array<import("../../domain/types.js").AgentCommissionPayment>
    >();
    for (const p of repo.agentPayments) {
      const arr = paymentsByAgent.get(p.salesAgentId) ?? [];
      arr.push(p);
      paymentsByAgent.set(p.salesAgentId, arr);
    }

    const agentRows = agents.map((a) => {
      const ledger = ledgerByAgent.get(a.id) ?? [];
      const lifetimeEarned = ledger.reduce((s, e) => s + e.amountVnd, 0);
      const lifetimePaid = ledger
        .filter((e) => e.status === "paid")
        .reduce((s, e) => s + e.amountVnd, 0);
      const weekly = weeks.map((wk) => {
        const earned = ledger
          .filter((e) => isoMondayOf(e.createdAt) === wk)
          .reduce((s, e) => s + e.amountVnd, 0);
        const paidAmount = (paymentsByAgent.get(a.id) ?? [])
          .filter((p) => p.weekStartIso === wk)
          .reduce((s, p) => s + p.amountVnd, 0);
        return { week: wk, earned, paidAmount };
      });
      return {
        agent: a,
        lifetimeEarned,
        lifetimePaid,
        weekly,
        rule: repo.commissionRules.find(
          (r) => r.salesAgentId === a.id && r.isActive,
        ),
        discounts: repo.discounts.filter(
          (d) => d.scope === "agent_specific" && d.salesAgentId === a.id,
        ),
        recentPayments: (paymentsByAgent.get(a.id) ?? [])
          .slice()
          .sort((x, y) => y.paidAt.getTime() - x.paidAt.getTime())
          .slice(0, 6),
      };
    });

    res.render("admin/agents", {
      title: "Sales agents",
      weeks,
      agentRows,
      countDiscountUsage: (discountId: string) =>
        Array.from(repo.bookings.values()).filter(
          (b) => b.discountIdApplied === discountId,
        ).length,
    });
  });

  const newAgentSchema = z.object({
    fullName: z.string().min(1),
    email: z.string().email(),
    phone: z.string().optional(),
    password: z.string().min(8),
    commissionType: z.enum(["percentage", "fixed"]),
    commissionValue: z.coerce.number().nonnegative(),
  });

  router.post("/agents", (req, res) => {
    const parsed = newAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid agent", message: "" });
      return;
    }
    const id = nextId("agent");
    const user = {
      id,
      role: "sales_agent" as const,
      fullName: parsed.data.fullName,
      email: parsed.data.email,
      phone: parsed.data.phone || undefined,
      isActive: true,
      passwordHash: bcrypt.hashSync(parsed.data.password, 8),
    };
    repo.users.set(id, user);
    const rule = {
      id: nextId("commission-rule"),
      salesAgentId: id,
      commissionType: parsed.data.commissionType,
      value: parsed.data.commissionValue,
      isActive: true,
    };
    repo.commissionRules.push(rule);
    audit(repo, req, {
      action: "agent.create",
      entityType: "user",
      entityId: id,
      after: {
        fullName: user.fullName,
        email: user.email,
        commissionType: rule.commissionType,
        commissionValue: rule.value,
      },
    });
    res.redirect("/admin/agents");
  });

  const userEditSchema = z.object({
    fullName: z.string().min(1),
    email: z.string().email(),
    phone: z.string().optional(),
    password: z.string().optional(),
  });

  function applyUserEdit(
    user: import("../../domain/types.js").User,
    data: { fullName: string; email: string; phone?: string; password?: string },
  ) {
    const before = {
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      passwordChanged: false,
    };
    user.fullName = data.fullName;
    user.email = data.email;
    user.phone = data.phone?.trim() || undefined;
    let passwordChanged = false;
    if (data.password && data.password.length > 0) {
      if (data.password.length < 8) throw new Error("Password must be at least 8 characters.");
      user.passwordHash = bcrypt.hashSync(data.password, 8);
      passwordChanged = true;
    }
    return {
      before,
      after: {
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        passwordChanged,
      },
    };
  }

  router.post("/agents/:id/edit", (req, res) => {
    const u = repo.users.get(req.params.id as string);
    if (!u || u.role !== "sales_agent") {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const parsed = userEditSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid edit", message: "" });
      return;
    }
    try {
      const diff = applyUserEdit(u, parsed.data);
      audit(repo, req, {
        action: "agent.edit",
        entityType: "user",
        entityId: u.id,
        before: diff.before,
        after: diff.after,
      });
    } catch (err) {
      res.status(400).render("error", {
        title: "Cannot save",
        message: (err as Error).message,
      });
      return;
    }
    res.redirect("/admin/agents");
  });

  router.post("/agents/:id/toggle", (req, res) => {
    const u = repo.users.get(req.params.id as string);
    if (!u || u.role !== "sales_agent") {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    u.isActive = !u.isActive;
    audit(repo, req, {
      action: "agent.toggle",
      entityType: "user",
      entityId: u.id,
      after: { isActive: u.isActive },
    });
    res.redirect("/admin/agents");
  });

  const agentRuleEditSchema = z.object({
    commissionType: z.enum(["percentage", "fixed"]),
    commissionValue: z.coerce.number().nonnegative(),
  });

  router.post("/agents/:id/rule", (req, res) => {
    const u = repo.users.get(req.params.id as string);
    if (!u || u.role !== "sales_agent") {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const parsed = agentRuleEditSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid rule", message: "" });
      return;
    }
    // Deactivate prior active rules; create new active one.
    for (const r of repo.commissionRules) {
      if (r.salesAgentId === u.id && r.isActive) r.isActive = false;
    }
    const rule = {
      id: nextId("commission-rule"),
      salesAgentId: u.id,
      commissionType: parsed.data.commissionType,
      value: parsed.data.commissionValue,
      isActive: true,
    };
    repo.commissionRules.push(rule);
    audit(repo, req, {
      action: "agent.rule_update",
      entityType: "user",
      entityId: u.id,
      after: { commissionType: rule.commissionType, commissionValue: rule.value },
    });
    res.redirect("/admin/agents");
  });

  const agentDiscountSchema = z.object({
    name: z.string().min(1),
    discountType: z.enum(["percentage", "fixed"]),
    value: z.coerce.number().nonnegative(),
    usageLimit: z.string().optional(),
    validFrom: z.string().optional(),
    validUntil: z.string().optional(),
  });

  router.post("/agents/:id/discounts", (req, res) => {
    const u = repo.users.get(req.params.id as string);
    if (!u || u.role !== "sales_agent") {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const parsed = agentDiscountSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .render("error", { title: "Invalid discount", message: "" });
      return;
    }
    const limit = parsed.data.usageLimit
      ? Number(parsed.data.usageLimit)
      : undefined;
    const discount = {
      id: nextId("discount"),
      name: parsed.data.name,
      scope: "agent_specific" as const,
      salesAgentId: u.id,
      discountType: parsed.data.discountType,
      value: parsed.data.value,
      isActive: true,
      validFrom: parsed.data.validFrom || undefined,
      validUntil: parsed.data.validUntil || undefined,
      usageLimit:
        limit !== undefined && Number.isFinite(limit) && limit > 0
          ? limit
          : undefined,
    };
    repo.discounts.push(discount);
    audit(repo, req, {
      action: "agent.discount_create",
      entityType: "discount",
      entityId: discount.id,
      after: discount as Record<string, unknown>,
    });
    res.redirect("/admin/agents");
  });

  const paymentSchema = z.object({
    weekStartIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    amountVnd: z.coerce.number().int().nonnegative(),
    notes: z.string().optional(),
  });

  router.post(
    "/agents/:id/payments",
    screenshotUpload.single("screenshot"),
    (req, res) => {
      const u = repo.users.get(req.params.id as string);
      if (!u || u.role !== "sales_agent") {
        res.status(404).render("error", { title: "Not found", message: "" });
        return;
      }
      const parsed = paymentSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .render("error", { title: "Invalid payment", message: "" });
        return;
      }
      const screenshotUrl = req.file
        ? `/uploads/${path.basename(req.file.path)}`
        : undefined;
      const payment = {
        id: nextId("agent-payment"),
        salesAgentId: u.id,
        weekStartIso: parsed.data.weekStartIso,
        amountVnd: parsed.data.amountVnd,
        screenshotUrl,
        paidAt: new Date(),
        notes: parsed.data.notes || undefined,
        createdByUserId: (req as unknown as { currentUser?: { id?: string } })
          .currentUser?.id,
      };
      repo.agentPayments.push(payment);
      // Mark all approved (or pending) ledger entries for this agent in this week as paid.
      for (const e of repo.commissionLedger.values()) {
        if (
          e.salesAgentId === u.id &&
          isoMondayOf(e.createdAt) === parsed.data.weekStartIso &&
          e.status !== "paid" &&
          e.status !== "voided"
        ) {
          e.status = "paid";
          e.paidAt = payment.paidAt;
          e.updatedAt = payment.paidAt;
        }
      }
      audit(repo, req, {
        action: "agent.payment",
        entityType: "user",
        entityId: u.id,
        after: {
          weekStartIso: payment.weekStartIso,
          amountVnd: payment.amountVnd,
          screenshotUrl,
        },
      });
      res.redirect("/admin/agents");
    },
  );

  // ---------- Cleaning crew management ----------
  router.get("/cleaners", (_req, res) => {
    const cleaners = Array.from(repo.users.values()).filter(
      (u) => u.role === "cleaning_crew",
    );
    const weeks = lastNWeeks(6);
    const jobsByCleaner = new Map<
      string,
      Array<import("../../domain/types.js").CleaningJob>
    >();
    for (const j of repo.cleaningJobs.values()) {
      if (!j.assignedToUserId) continue;
      const arr = jobsByCleaner.get(j.assignedToUserId) ?? [];
      arr.push(j);
      jobsByCleaner.set(j.assignedToUserId, arr);
    }
    const paymentsByCleaner = new Map<
      string,
      Array<import("../../domain/types.js").CleanerPayrollPayment>
    >();
    for (const p of repo.cleanerPayments) {
      const arr = paymentsByCleaner.get(p.cleanerUserId) ?? [];
      arr.push(p);
      paymentsByCleaner.set(p.cleanerUserId, arr);
    }

    const cleanerRows = cleaners.map((c) => {
      const profile = repo.cleaningCrewProfiles.get(c.id);
      const jobs = jobsByCleaner.get(c.id) ?? [];
      const completed = jobs.filter((j) => j.status === "completed");
      const lifetimeEarned = completed.reduce((s, j) => s + j.fixedPayVnd, 0);
      const lifetimePaid = (paymentsByCleaner.get(c.id) ?? []).reduce(
        (s, p) => s + p.amountVnd,
        0,
      );
      const weekly = weeks.map((wk) => {
        const weekJobs = completed.filter(
          (j) =>
            j.completedAt && isoMondayOf(j.completedAt) === wk,
        );
        const earned = weekJobs.reduce((s, j) => s + j.fixedPayVnd, 0);
        const paidAmount = (paymentsByCleaner.get(c.id) ?? [])
          .filter((p) => p.weekStartIso === wk)
          .reduce((s, p) => s + p.amountVnd, 0);
        return { week: wk, earned, jobs: weekJobs.length, paidAmount };
      });
      const upcomingJobs = jobs
        .filter(
          (j) =>
            j.windowStartAt > new Date(Date.now() - 86_400_000) &&
            j.status !== "cancelled",
        )
        .sort((a, b) => a.windowStartAt.getTime() - b.windowStartAt.getTime())
        .slice(0, 8);

      return {
        cleaner: c,
        profile,
        lifetimeEarned,
        lifetimePaid,
        weekly,
        upcomingJobs,
        recentPayments: (paymentsByCleaner.get(c.id) ?? [])
          .slice()
          .sort((x, y) => y.paidAt.getTime() - x.paidAt.getTime())
          .slice(0, 6),
      };
    });

    const allRooms = Array.from(repo.rooms.values());
    const allBookings = Array.from(repo.bookings.values());

    res.render("admin/cleaners", {
      title: "Cleaning crew",
      weeks,
      cleanerRows,
      allCleaners: cleaners,
      bookingForJob: (j: { bookingId: string }) =>
        allBookings.find((b) => b.id === j.bookingId),
      roomForJob: (j: { roomId: string }) =>
        allRooms.find((r) => r.id === j.roomId),
    });
  });

  const newCleanerSchema = z.object({
    fullName: z.string().min(1),
    email: z.string().email(),
    phone: z.string().optional(),
    password: z.string().min(8),
    fixedPayPerJobK: z.coerce.number().nonnegative(),
  });

  router.post("/cleaners", (req, res) => {
    const parsed = newCleanerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid cleaner", message: "" });
      return;
    }
    const id = nextId("cleaner");
    repo.users.set(id, {
      id,
      role: "cleaning_crew",
      fullName: parsed.data.fullName,
      email: parsed.data.email,
      phone: parsed.data.phone || undefined,
      isActive: true,
      passwordHash: bcrypt.hashSync(parsed.data.password, 8),
    });
    repo.cleaningCrewProfiles.set(id, {
      userId: id,
      fixedPayPerJobVnd: Math.round(parsed.data.fixedPayPerJobK * 1000),
      jobsCompleted: 0,
    });
    audit(repo, req, {
      action: "cleaner.create",
      entityType: "user",
      entityId: id,
      after: {
        fullName: parsed.data.fullName,
        email: parsed.data.email,
        fixedPayVnd: Math.round(parsed.data.fixedPayPerJobK * 1000),
      },
    });
    res.redirect("/admin/cleaners");
  });

  router.post("/cleaners/:id/edit", (req, res) => {
    const u = repo.users.get(req.params.id as string);
    if (!u || u.role !== "cleaning_crew") {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const parsed = userEditSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid edit", message: "" });
      return;
    }
    try {
      const diff = applyUserEdit(u, parsed.data);
      audit(repo, req, {
        action: "cleaner.edit",
        entityType: "user",
        entityId: u.id,
        before: diff.before,
        after: diff.after,
      });
    } catch (err) {
      res.status(400).render("error", {
        title: "Cannot save",
        message: (err as Error).message,
      });
      return;
    }
    res.redirect("/admin/cleaners");
  });

  router.post("/cleaners/:id/toggle", (req, res) => {
    const u = repo.users.get(req.params.id as string);
    if (!u || u.role !== "cleaning_crew") {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    u.isActive = !u.isActive;
    audit(repo, req, {
      action: "cleaner.toggle",
      entityType: "user",
      entityId: u.id,
      after: { isActive: u.isActive },
    });
    res.redirect("/admin/cleaners");
  });

  const cleanerPaySchema = z.object({
    fixedPayPerJobK: z.coerce.number().nonnegative(),
  });

  router.post("/cleaners/:id/pay", (req, res) => {
    const u = repo.users.get(req.params.id as string);
    if (!u || u.role !== "cleaning_crew") {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const parsed = cleanerPaySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .render("error", { title: "Invalid pay rate", message: "" });
      return;
    }
    const profile = repo.cleaningCrewProfiles.get(u.id) ?? {
      userId: u.id,
      fixedPayPerJobVnd: 0,
      jobsCompleted: 0,
    };
    const before = profile.fixedPayPerJobVnd;
    profile.fixedPayPerJobVnd = Math.round(parsed.data.fixedPayPerJobK * 1000);
    repo.cleaningCrewProfiles.set(u.id, profile);
    audit(repo, req, {
      action: "cleaner.pay_rate_update",
      entityType: "user",
      entityId: u.id,
      before: { fixedPayPerJobVnd: before },
      after: { fixedPayPerJobVnd: profile.fixedPayPerJobVnd },
    });
    res.redirect("/admin/cleaners");
  });

  const jobEditSchema = z.object({
    assignedToUserId: z.string().optional(),
    windowStartAt: z.string().optional(),
    windowEndAt: z.string().optional(),
    status: z
      .enum(["assigned", "arrived", "in_progress", "completed", "cancelled"])
      .optional(),
  });

  router.post("/cleaning-jobs/:id/edit", (req, res) => {
    const job = repo.cleaningJobs.get(req.params.id as string);
    if (!job) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const parsed = jobEditSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid edit", message: "" });
      return;
    }
    const before = {
      assignedToUserId: job.assignedToUserId,
      windowStartAt: job.windowStartAt.toISOString(),
      windowEndAt: job.windowEndAt.toISOString(),
      status: job.status,
    };
    if (parsed.data.assignedToUserId !== undefined) {
      job.assignedToUserId = parsed.data.assignedToUserId || undefined;
      if (job.assignedToUserId) {
        const profile = repo.cleaningCrewProfiles.get(job.assignedToUserId);
        if (profile) job.fixedPayVnd = profile.fixedPayPerJobVnd;
      }
    }
    if (parsed.data.windowStartAt) {
      const d = parseVietnamLocal(parsed.data.windowStartAt);
      if (!Number.isNaN(d.getTime())) job.windowStartAt = d;
    }
    if (parsed.data.windowEndAt) {
      const d = parseVietnamLocal(parsed.data.windowEndAt);
      if (!Number.isNaN(d.getTime())) job.windowEndAt = d;
    }
    if (parsed.data.status) job.status = parsed.data.status;
    audit(repo, req, {
      action: "cleaning_job.edit",
      entityType: "cleaning_job",
      entityId: job.id,
      before,
      after: {
        assignedToUserId: job.assignedToUserId,
        windowStartAt: job.windowStartAt.toISOString(),
        windowEndAt: job.windowEndAt.toISOString(),
        status: job.status,
      },
    });
    res.redirect("/admin/cleaners");
  });

  const cleanerPaymentSchema = z.object({
    weekStartIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    jobsCount: z.coerce.number().int().nonnegative(),
    amountVnd: z.coerce.number().int().nonnegative(),
    notes: z.string().optional(),
  });

  router.post(
    "/cleaners/:id/payments",
    screenshotUpload.single("screenshot"),
    (req, res) => {
      const u = repo.users.get(req.params.id as string);
      if (!u || u.role !== "cleaning_crew") {
        res.status(404).render("error", { title: "Not found", message: "" });
        return;
      }
      const parsed = cleanerPaymentSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .render("error", { title: "Invalid payment", message: "" });
        return;
      }
      const screenshotUrl = req.file
        ? `/uploads/${path.basename(req.file.path)}`
        : undefined;
      const payment = {
        id: nextId("cleaner-payment"),
        cleanerUserId: u.id,
        weekStartIso: parsed.data.weekStartIso,
        jobsCount: parsed.data.jobsCount,
        amountVnd: parsed.data.amountVnd,
        screenshotUrl,
        paidAt: new Date(),
        notes: parsed.data.notes || undefined,
        createdByUserId: (req as unknown as { currentUser?: { id?: string } })
          .currentUser?.id,
      };
      repo.cleanerPayments.push(payment);
      audit(repo, req, {
        action: "cleaner.payment",
        entityType: "user",
        entityId: u.id,
        after: {
          weekStartIso: payment.weekStartIso,
          jobsCount: payment.jobsCount,
          amountVnd: payment.amountVnd,
          screenshotUrl,
        },
      });
      res.redirect("/admin/cleaners");
    },
  );

  // ---------- Discounts ----------
  router.get("/discounts", (_req, res) => {
    res.render("admin/discounts", {
      title: "Discounts",
      discounts: repo.discounts,
      agents: Array.from(repo.users.values()).filter(
        (u) => u.role === "sales_agent",
      ),
    });
  });

  const discountSchema = z.object({
    name: z.string().min(1),
    scope: z.enum(["global", "agent_specific"]),
    salesAgentId: z.string().optional(),
    discountType: z.enum(["percentage", "fixed"]),
    value: z.coerce.number().nonnegative(),
    isActive: z.string().optional(),
    validFrom: z.string().optional(),
    validUntil: z.string().optional(),
  });

  router.post("/discounts", (req, res) => {
    const parsed = discountSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .render("error", { title: "Invalid discount", message: "" });
      return;
    }
    const discount = {
      id: nextId("discount"),
      name: parsed.data.name,
      scope: parsed.data.scope,
      salesAgentId:
        parsed.data.scope === "agent_specific"
          ? parsed.data.salesAgentId
          : undefined,
      discountType: parsed.data.discountType,
      value: parsed.data.value,
      isActive: parsed.data.isActive === "1",
      validFrom: parsed.data.validFrom || undefined,
      validUntil: parsed.data.validUntil || undefined,
    };
    repo.discounts.push(discount);
    audit(repo, req, {
      action: "discount.create",
      entityType: "discount",
      entityId: discount.id,
      after: discount as Record<string, unknown>,
    });
    res.redirect("/admin/discounts");
  });

  router.post("/discounts/:id/toggle", (req, res) => {
    const d = repo.discounts.find((x) => x.id === req.params.id);
    if (!d) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    d.isActive = !d.isActive;
    audit(repo, req, {
      action: "discount.toggle",
      entityType: "discount",
      entityId: d.id,
      after: { isActive: d.isActive },
    });
    res.redirect("/admin/discounts");
  });

  // ---------- Commission rules ----------
  router.get("/commission-rules", (_req, res) => {
    res.render("admin/commission-rules", {
      title: "Commission rules",
      rules: repo.commissionRules,
      agents: Array.from(repo.users.values()).filter(
        (u) => u.role === "sales_agent",
      ),
    });
  });

  const ruleSchema = z.object({
    salesAgentId: z.string().min(1),
    commissionType: z.enum(["percentage", "fixed"]),
    value: z.coerce.number().nonnegative(),
    isActive: z.string().optional(),
    validFrom: z.string().optional(),
    validUntil: z.string().optional(),
  });

  router.post("/commission-rules", (req, res) => {
    const parsed = ruleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid rule", message: "" });
      return;
    }
    const rule = {
      id: nextId("commission-rule"),
      salesAgentId: parsed.data.salesAgentId,
      commissionType: parsed.data.commissionType,
      value: parsed.data.value,
      isActive: parsed.data.isActive === "1",
      validFrom: parsed.data.validFrom || undefined,
      validUntil: parsed.data.validUntil || undefined,
    };
    repo.commissionRules.push(rule);
    audit(repo, req, {
      action: "commission_rule.create",
      entityType: "commission_rule",
      entityId: rule.id,
      after: rule as Record<string, unknown>,
    });
    res.redirect("/admin/commission-rules");
  });

  router.post("/commission-rules/:id/toggle", (req, res) => {
    const r = repo.commissionRules.find((x) => x.id === req.params.id);
    if (!r) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    r.isActive = !r.isActive;
    audit(repo, req, {
      action: "commission_rule.toggle",
      entityType: "commission_rule",
      entityId: r.id,
      after: { isActive: r.isActive },
    });
    res.redirect("/admin/commission-rules");
  });

  // ---------- Minibar items ----------
  router.get("/minibar", (_req, res) => {
    res.render("admin/minibar", {
      title: "Minibar items",
      items: Array.from(repo.minibarItems.values()),
    });
  });

  const minibarItemSchema = z.object({
    name: z.string().min(1),
    unitPriceVnd: z.coerce.number().int().nonnegative(),
    isActive: z.string().optional(),
  });

  router.post("/minibar", (req, res) => {
    const parsed = minibarItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid item", message: "" });
      return;
    }
    const item = {
      id: nextId("minibar"),
      name: parsed.data.name,
      unitPriceVnd: parsed.data.unitPriceVnd,
      isActive: parsed.data.isActive === "1",
    };
    repo.minibarItems.set(item.id, item);
    audit(repo, req, {
      action: "minibar.create",
      entityType: "minibar_item",
      entityId: item.id,
      after: item as Record<string, unknown>,
    });
    res.redirect("/admin/minibar");
  });

  router.post("/minibar/:id/toggle", (req, res) => {
    const item = repo.minibarItems.get(req.params.id as string);
    if (!item) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    item.isActive = !item.isActive;
    audit(repo, req, {
      action: "minibar.toggle",
      entityType: "minibar_item",
      entityId: item.id,
      after: { isActive: item.isActive },
    });
    res.redirect("/admin/minibar");
  });

  const minibarEditSchema = z.object({
    name: z.string().min(1),
    unitPriceVnd: z.coerce.number().int().nonnegative(),
  });

  router.post("/minibar/:id/edit", (req, res) => {
    const item = repo.minibarItems.get(req.params.id as string);
    if (!item) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const parsed = minibarEditSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid edit", message: "" });
      return;
    }
    const before = { name: item.name, unitPriceVnd: item.unitPriceVnd };
    item.name = parsed.data.name;
    item.unitPriceVnd = parsed.data.unitPriceVnd;
    audit(repo, req, {
      action: "minibar.edit",
      entityType: "minibar_item",
      entityId: item.id,
      before,
      after: { name: item.name, unitPriceVnd: item.unitPriceVnd },
    });
    res.redirect("/admin/minibar");
  });

  // ---------- Reports ----------
  function parseRange(
    q: Record<string, unknown>,
  ): { from: Date; to: Date } | undefined {
    const from = q.from ? new Date(String(q.from)) : undefined;
    const to = q.to ? new Date(String(q.to)) : undefined;
    if (
      !from ||
      !to ||
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime())
    )
      return undefined;
    return { from, to };
  }

  router.get("/reports", (req, res) => {
    const range =
      parseRange(req.query as Record<string, unknown>) ?? defaultRange();
    const summary = calculateRevenueSummary({
      bookings: repo.bookings.values(),
      rooms: repo.rooms.values(),
      range,
    });
    const occupancy = calculateOccupancy({
      bookings: repo.bookings.values(),
      rooms: repo.rooms.values(),
      range,
    });
    const agentPerf = calculateAgentPerformance({
      bookings: repo.bookings.values(),
      ledger: repo.commissionLedger.values(),
      range,
    });
    const cleanerPerf = calculateCleanerPerformance({
      cleaningJobs: repo.cleaningJobs.values(),
      profiles: repo.cleaningCrewProfiles.values(),
      range,
    });
    res.render("admin/reports", {
      title: "Reports",
      range: {
        from: range.from.toISOString().slice(0, 10),
        to: range.to.toISOString().slice(0, 10),
      },
      summary,
      occupancy,
      agentPerf,
      cleanerPerf,
      rooms: repo.rooms,
      users: repo.users,
    });
  });

  router.get("/exports/bookings.csv", (_req, res) => {
    const csv = bookingsToCsv(repo.bookings.values());
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="bookings-${Date.now()}.csv"`,
    );
    res.send(csv);
  });

  router.get("/exports/revenue.csv", (req, res) => {
    const range =
      parseRange(req.query as Record<string, unknown>) ?? defaultRange();
    const summary = calculateRevenueSummary({
      bookings: repo.bookings.values(),
      rooms: repo.rooms.values(),
      range,
    });
    const csv = rowsToCsv(
      summary.byRoom.map((r) => ({
        room_id: r.roomId,
        bookings: r.bookings,
        gross: r.grossRevenueVnd,
        discounts: r.discountsVnd,
        net: r.netRevenueVnd,
        refunds: r.refundsVnd,
        minibar: r.minibarVnd,
        damages: r.damagesVnd,
      })),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="revenue-${Date.now()}.csv"`,
    );
    res.send(csv);
  });

  router.get("/exports/commission-ledger.csv", (_req, res) => {
    const csv = rowsToCsv(
      Array.from(repo.commissionLedger.values()).map((e) => ({
        id: e.id,
        booking_id: e.bookingId,
        sales_agent_id: e.salesAgentId,
        amount_vnd: e.amountVnd,
        status: e.status,
        paid_at: e.paidAt ? e.paidAt.toISOString() : "",
        created_at: e.createdAt.toISOString(),
      })),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="commission-ledger-${Date.now()}.csv"`,
    );
    res.send(csv);
  });

  router.get("/exports/audit.csv", (_req, res) => {
    const csv = rowsToCsv(
      repo.auditLog.map((e) => ({
        id: e.id,
        created_at: e.createdAt.toISOString(),
        actor_user_id: e.actorUserId ?? "",
        actor_role: e.actorRole ?? "",
        action: e.action,
        entity_type: e.entityType,
        entity_id: e.entityId,
        notes: e.notes ?? "",
        before: e.before ? JSON.stringify(e.before) : "",
        after: e.after ? JSON.stringify(e.after) : "",
      })),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-${Date.now()}.csv"`,
    );
    res.send(csv);
  });

  router.get("/notifications", (_req, res) => {
    const entries = repo.notificationLog.slice().reverse().slice(0, 200);
    res.render("admin/notifications", {
      title: "Notifications",
      entries,
      bookingById: (id?: string) => (id ? repo.bookings.get(id) : undefined),
    });
  });

  router.get("/tasks", (_req, res) => {
    const tasks = Array.from(repo.tasks.values()).sort((a, b) => {
      if (a.status !== b.status) return a.status === "open" ? -1 : 1;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
    res.render("admin/tasks", {
      title: "Internal tasks",
      tasks,
      bookingById: (id?: string) => (id ? repo.bookings.get(id) : undefined),
    });
  });

  router.post("/tasks/:id/status", (req, res) => {
    const task = repo.tasks.get(req.params.id as string);
    if (!task) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const next = String(req.body.status ?? "");
    if (
      next !== "open" &&
      next !== "in_progress" &&
      next !== "completed" &&
      next !== "cancelled"
    ) {
      res.status(400).render("error", { title: "Invalid status", message: "" });
      return;
    }
    task.status = next;
    task.updatedAt = new Date();
    if (next === "completed") task.completedAt = new Date();
    audit(repo, req, {
      action: "task.transition",
      entityType: "task",
      entityId: task.id,
      after: { status: task.status },
    });
    res.redirect("/admin/tasks");
  });

  // ---------- Maintenance blocks ----------
  router.get("/maintenance", (_req, res) => {
    const blocks = repo.maintenanceBlocks
      .slice()
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    res.render("admin/maintenance", {
      title: "Maintenance blocks",
      blocks,
      rooms: Array.from(repo.rooms.values()),
      roomById: (id?: string) => (id ? repo.rooms.get(id) : undefined),
    });
  });

  const maintenanceSchema = z.object({
    roomId: z.string(),
    startsAt: z.string().min(1),
    endsAt: z.string().min(1),
    reason: z.enum(["maintenance", "deep_cleaning", "owner_use", "offline"]),
    notes: z.string().optional(),
  });

  router.post("/maintenance", (req, res) => {
    const parsed = maintenanceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", { title: "Invalid block", message: "" });
      return;
    }
    const startsAt = parseVietnamLocal(parsed.data.startsAt);
    const endsAt = parseVietnamLocal(parsed.data.endsAt);
    if (
      Number.isNaN(startsAt.getTime()) ||
      Number.isNaN(endsAt.getTime()) ||
      endsAt <= startsAt
    ) {
      res.status(400).render("error", { title: "Bad date range", message: "" });
      return;
    }
    const reviewer = (req as unknown as { currentUser: { id: string } })
      .currentUser;
    const block = {
      id: nextId("maintenance"),
      roomId: parsed.data.roomId,
      startsAt,
      endsAt,
      reason: parsed.data.reason,
      notes: parsed.data.notes,
      createdByUserId: reviewer.id,
      createdAt: new Date(),
    };
    repo.maintenanceBlocks.push(block);
    audit(repo, req, {
      action: "maintenance.create",
      entityType: "maintenance",
      entityId: block.id,
      after: {
        roomId: block.roomId,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        reason: block.reason,
      },
      notes: parsed.data.notes,
    });
    res.redirect("/admin/maintenance");
  });

  router.post("/maintenance/:id/delete", (req, res) => {
    const idx = repo.maintenanceBlocks.findIndex((b) => b.id === req.params.id);
    if (idx < 0) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const removed = repo.maintenanceBlocks[idx]!;
    repo.maintenanceBlocks.splice(idx, 1);
    audit(repo, req, {
      action: "maintenance.delete",
      entityType: "maintenance",
      entityId: removed.id,
    });
    res.redirect("/admin/maintenance");
  });

  router.get("/audit", (_req, res) => {
    const entries = repo.auditLog.slice().reverse().slice(0, 200);
    res.render("admin/audit", {
      title: "Audit log",
      entries,
      userById: (id?: string) => (id ? repo.users.get(id) : undefined),
    });
  });

  // Side helper: room price preview JSON for inline checks
  router.get("/price-preview", (req, res) => {
    try {
      const roomId = String(req.query.roomId);
      const room = repo.rooms.get(roomId);
      if (!room) {
        res.status(404).json({ error: "room not found" });
        return;
      }
      const price = calculateBookingPrice({
        bookingType: req.query.bookingType as "hourly" | "day" | "multi_day",
        checkInAt: parseVietnamLocal(String(req.query.checkInAt)),
        checkOutAt: parseVietnamLocal(String(req.query.checkOutAt)),
        room,
        rates: repo.rates,
      });
      res.json(price);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.use("/admin", router);
}
