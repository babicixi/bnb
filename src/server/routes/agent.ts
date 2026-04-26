import { Router, type Express } from "express";
import { z } from "zod";
import {
  applyConfirmationSideEffects,
  calculateAgentCommission,
  calculateBookingPrice,
  checkAvailability,
  createBookingFromHold,
  createHold,
  expireOldHolds,
  recordPendingCommission,
  requestCancellation,
  bookingGuestViewForUser,
} from "../../index.js";
import {
  indexBooking,
  listAvailabilityContext,
  nextBookingNumber,
  nextId,
  type Repository,
} from "../../repo/memory.js";
import { requireRole, type RequestWithUser } from "../middleware/auth.js";
import { parseVietnamLocal } from "../parseTime.js";
import { notify } from "../../services/notifications.js";

export function mountAgentRoutes(app: Express, repo: Repository): void {
  const router = Router();
  router.use(requireRole("sales_agent"));

  router.get("/", (req, res) => {
    const agent = (req as RequestWithUser).currentUser!;
    const ownBookings = Array.from(repo.bookings.values())
      .filter((b) => b.salesAgentId === agent.id)
      .sort((a, b) => b.checkInAt.getTime() - a.checkInAt.getTime());
    const totalCommission = ownBookings.reduce(
      (s, b) => s + (b.calculatedCommissionVnd || 0),
      0,
    );
    res.render("agent/index", {
      title: "My bookings",
      bookings: ownBookings,
      totalCommission,
      guestForBooking: (b: { guestId: string }) => repo.guests.get(b.guestId),
      roomForBooking: (b: { roomId: string }) => repo.rooms.get(b.roomId),
    });
  });

  router.get("/new", (_req, res) => {
    res.render("agent/new", {
      title: "New booking",
      rooms: Array.from(repo.rooms.values()),
      discounts: Array.from(repo.discounts).filter((d) => d.isActive),
      error: null,
    });
  });

  const newBookingSchema = z.object({
    roomId: z.string(),
    bookingType: z.enum(["hourly", "day", "multi_day"]),
    checkInAt: z.string(),
    checkOutAt: z.string(),
    guestName: z.string().min(1),
    guestPhone: z.string().min(1),
    guestEmail: z.string().email().optional().or(z.literal("")),
    discountId: z.string().optional(),
    notes: z.string().optional(),
  });

  router.post("/new", (req, res) => {
    const parsed = newBookingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("agent/new", {
        title: "New booking",
        rooms: Array.from(repo.rooms.values()),
        discounts: Array.from(repo.discounts).filter((d) => d.isActive),
        error: "Please complete all fields.",
      });
      return;
    }
    const data = parsed.data;
    const agent = (req as RequestWithUser).currentUser!;
    const room = repo.rooms.get(data.roomId);
    if (!room) {
      res.status(404).render("error", { title: "Room not found", message: "" });
      return;
    }
    const checkInAt = parseVietnamLocal(data.checkInAt);
    const checkOutAt = parseVietnamLocal(data.checkOutAt);

    expireOldHolds(repo.holds);
    const availability = checkAvailability(
      data.roomId,
      checkInAt,
      checkOutAt,
      listAvailabilityContext(repo),
    );
    if (!availability.available) {
      res.status(409).render("error", {
        title: "Unavailable",
        message: "Selected window conflicts with another booking/hold.",
      });
      return;
    }

    let chosenDiscount;
    if (data.discountId) {
      const candidate = repo.discounts.find((d) => d.id === data.discountId);
      if (
        candidate &&
        candidate.isActive &&
        (candidate.scope === "global" || candidate.salesAgentId === agent.id)
      ) {
        chosenDiscount = candidate;
      }
    }
    const discounts = chosenDiscount ? [chosenDiscount] : [];

    let price;
    try {
      price = calculateBookingPrice({
        bookingType: data.bookingType,
        checkInAt,
        checkOutAt,
        room,
        rates: repo.rates,
        discounts,
        salesAgentId: agent.id,
      });
    } catch (err) {
      res.status(400).render("error", {
        title: "Invalid time",
        message: (err as Error).message,
      });
      return;
    }

    const guest = {
      id: nextId("guest"),
      fullName: data.guestName,
      phone: data.guestPhone,
      email: data.guestEmail || undefined,
    };
    repo.guests.set(guest.id, guest);

    const hold = createHold({
      id: nextId("hold"),
      roomId: data.roomId,
      requestedCheckIn: price.checkInAt,
      requestedCheckOut: price.checkOutAt,
      context: {
        bookings: Array.from(repo.bookings.values()),
        holds: repo.holds,
      },
      createdByUserId: agent.id,
    });

    const bookingNumber = nextBookingNumber(repo);
    const { booking, payment } = createBookingFromHold({
      id: nextId("booking"),
      bookingNumber,
      hold,
      guest,
      room,
      rates: repo.rates,
      bookingType: data.bookingType,
      salesAgentId: agent.id,
      discounts,
    });
    booking.notes = data.notes?.trim() || undefined;
    booking.source = "agent";
    indexBooking(repo, booking);
    repo.payments.set(payment.id, payment);
    notify("booking_hold_created", {
      bookingId: booking.id,
      actorUserId: agent.id,
    });
    res.redirect(`/book/${booking.bookingNumber}`);
  });

  router.get("/bookings/:id", (req, res) => {
    const agent = (req as RequestWithUser).currentUser!;
    const booking = repo.bookings.get(req.params.id);
    if (!booking || booking.salesAgentId !== agent.id) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const guest = repo.guests.get(booking.guestId)!;
    const room = repo.rooms.get(booking.roomId);
    const view = bookingGuestViewForUser(agent, booking, guest);
    const commission = calculateAgentCommission({
      salesAgentId: agent.id,
      netAmountAfterDiscountVnd: booking.finalRoomChargeVnd,
      rules: repo.commissionRules,
      asOfDate: booking.checkInAt.toISOString().slice(0, 10),
    });
    res.render("agent/booking", {
      title: `Booking ${booking.bookingNumber}`,
      booking,
      view,
      room,
      commission,
    });
  });

  router.post("/bookings/:id/cancel-request", (req, res) => {
    const agent = (req as RequestWithUser).currentUser!;
    const booking = repo.bookings.get(req.params.id);
    if (!booking || booking.salesAgentId !== agent.id) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const request = requestCancellation({
      id: nextId("cancel"),
      booking,
      requestedBy: agent,
      reason: String(req.body.reason ?? ""),
    });
    repo.cancellationRequests.set(request.id, request);
    notify("cancellation_requested", { bookingId: booking.id });
    res.redirect(`/agent/bookings/${booking.id}`);
  });

  // Helper: confirm booking after upload (agent flow can also accept proof out-of-band)
  router.post("/bookings/:id/auto-confirm", (req, res) => {
    const agent = (req as RequestWithUser).currentUser!;
    const booking = repo.bookings.get(req.params.id);
    if (!booking || booking.salesAgentId !== agent.id) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    booking.status = "confirmed";
    booking.paymentStatus = "proof_uploaded";
    booking.amountPaidVnd =
      booking.finalRoomChargeVnd + booking.securityDepositVnd;
    booking.amountDueVnd = 0;
    try {
      const result = applyConfirmationSideEffects({
        booking,
        commissionRules: repo.commissionRules,
        cleaning: {
          cleaningJobId: nextId("cleaning"),
          availability: repo.cleaningAvailability,
          crewProfiles: Array.from(repo.cleaningCrewProfiles.values()),
        },
      });
      if (result.cleaningJob) {
        repo.cleaningJobs.set(result.cleaningJob.id, result.cleaningJob);
        notify("cleaning_assigned", { bookingId: booking.id });
      }
    } catch {
      applyConfirmationSideEffects({
        booking,
        commissionRules: repo.commissionRules,
      });
    }
    if (booking.salesAgentId && booking.calculatedCommissionVnd > 0) {
      recordPendingCommission(repo.commissionLedger, {
        id: nextId("commission"),
        bookingId: booking.id,
        salesAgentId: booking.salesAgentId,
        amountVnd: booking.calculatedCommissionVnd,
      });
    }
    notify("booking_confirmed", {
      bookingId: booking.id,
      actorUserId: agent.id,
    });
    res.redirect(`/agent/bookings/${booking.id}`);
  });

  app.use("/agent", router);
}
