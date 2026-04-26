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
      res
        .status(400)
        .render("error", {
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
      editBookingTimes({
        booking,
        room,
        rates: repo.rates,
        requestedCheckIn: parseVietnamLocal(parsed.data.checkInAt),
        requestedCheckOut: parseVietnamLocal(parsed.data.checkOutAt),
      });
      booking.notes = parsed.data.notes ?? booking.notes;
      if (booking.status === "extra_payment_required")
        notify("extra_payment_required", { bookingId: booking.id });
      if (booking.status === "refund_pending")
        notify("refund_pending", { bookingId: booking.id });
      res.redirect(`/admin/bookings/${booking.id}`);
    } catch (err) {
      res
        .status(400)
        .render("error", {
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
