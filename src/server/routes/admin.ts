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
import { snapshotBooking } from "../../services/audit.js";
import { audit } from "../auditHelper.js";
import {
  approveCommission,
  markCommissionPaid,
  voidCommission,
} from "../../services/commissionLedger.js";
import type { RequestWithUser } from "../middleware/auth.js";

const filterSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  status: z.string().optional(),
  paymentStatus: z.string().optional(),
  buildingId: z.string().optional(),
  roomId: z.string().optional(),
  agentId: z.string().optional(),
});

export function mountAdminRoutes(app: Express, repo: Repository): void {
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
    res.render("admin/index", {
      title: "Admin dashboard",
      bookings,
      rooms: Array.from(repo.rooms.values()),
      buildings: Array.from(repo.buildings.values()),
      agents: Array.from(repo.users.values()).filter(
        (u) => u.role === "sales_agent",
      ),
      filters,
      guestForBooking: (b: { guestId: string }) => repo.guests.get(b.guestId),
      roomForBooking: (b: { roomId: string }) => repo.rooms.get(b.roomId),
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
      res
        .status(400)
        .render("error", {
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
      res
        .status(400)
        .render("error", {
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
      res
        .status(400)
        .render("error", {
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

  const singleRateSchema = z.object({
    roomId: z.string(),
    rateDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dayRateVnd: z.coerce.number().int().nonnegative(),
    hourlyRateVnd: z.coerce.number().int().nonnegative(),
  });

  router.post("/pricing/edit", (req, res) => {
    const parsed = singleRateSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .render("error", { title: "Invalid pricing", message: "" });
      return;
    }
    const before = repo.rates.find(
      (r) =>
        r.roomId === parsed.data.roomId && r.rateDate === parsed.data.rateDate,
    );
    const beforeSnapshot = before ? { ...before } : undefined;
    if (before) {
      before.dayRateVnd = parsed.data.dayRateVnd;
      before.hourlyRateVnd = parsed.data.hourlyRateVnd;
    } else {
      repo.rates.push({
        roomId: parsed.data.roomId,
        rateDate: parsed.data.rateDate,
        dayRateVnd: parsed.data.dayRateVnd,
        hourlyRateVnd: parsed.data.hourlyRateVnd,
      });
    }
    audit(repo, req, {
      action: "pricing.edit",
      entityType: "room_daily_rate",
      entityId: `${parsed.data.roomId}@${parsed.data.rateDate}`,
      before: beforeSnapshot,
      after: parsed.data,
    });
    res.redirect(`/admin/pricing?roomId=${parsed.data.roomId}&flash=saved`);
  });

  const bulkRateSchema = z.object({
    roomId: z.string(),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dayRateVnd: z.coerce.number().int().nonnegative(),
    hourlyRateVnd: z.coerce.number().int().nonnegative(),
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
          existing.dayRateVnd = parsed.data.dayRateVnd;
          existing.hourlyRateVnd = parsed.data.hourlyRateVnd;
        } else {
          repo.rates.push({
            roomId: parsed.data.roomId,
            rateDate: dateKey,
            dayRateVnd: parsed.data.dayRateVnd,
            hourlyRateVnd: parsed.data.hourlyRateVnd,
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
      after: { ...parsed.data, count },
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
      res
        .status(400)
        .render("error", {
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
