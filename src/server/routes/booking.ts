import fs from "node:fs";
import path from "node:path";
import { Router, type Express } from "express";
import multer from "multer";
import { z } from "zod";
import {
  applyConfirmationSideEffects,
  calculateBookingPrice,
  checkAvailability,
  createBookingFromHold,
  createHold,
  expireOldHolds,
  recordPendingCommission,
  uploadPaymentProof,
} from "../../index.js";
import { parseVietnamLocal } from "../parseTime.js";
import {
  getBookingByNumber,
  indexBooking,
  listAvailabilityContext,
  nextBookingNumber,
  nextId,
  type Repository,
} from "../../repo/memory.js";
import { notify } from "../../services/notifications.js";

const bookingTypeSchema = z.enum(["hourly", "day", "multi_day"]);

const holdRequestSchema = z.object({
  roomId: z.string(),
  bookingType: bookingTypeSchema,
  checkInAt: z.string().min(1),
  checkOutAt: z.string().min(1),
  guestName: z.string().min(1),
  guestPhone: z.string().min(1),
  guestEmail: z.string().email().optional().or(z.literal("")),
  notes: z.string().optional(),
});

export function mountBookingRoutes(
  app: Express,
  repo: Repository,
  uploadsDir: string,
): void {
  fs.mkdirSync(uploadsDir, { recursive: true });
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
      cb(
        null,
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`,
      );
    },
  });
  const upload = multer({
    storage,
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

  router.post("/book/hold", (req, res) => {
    const parsed = holdRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("error", {
        title: "Invalid booking",
        message: "Please double-check the booking details and try again.",
      });
      return;
    }
    const data = parsed.data;
    const room = repo.rooms.get(data.roomId);
    if (!room) {
      res.status(404).render("error", { title: "Room not found", message: "" });
      return;
    }
    const checkInAt = parseVietnamLocal(data.checkInAt);
    const checkOutAt = parseVietnamLocal(data.checkOutAt);
    if (
      Number.isNaN(checkInAt.getTime()) ||
      Number.isNaN(checkOutAt.getTime())
    ) {
      res.status(400).render("error", { title: "Invalid dates", message: "" });
      return;
    }

    expireOldHolds(repo.holds);
    const availability = checkAvailability(
      data.roomId,
      checkInAt,
      checkOutAt,
      listAvailabilityContext(repo),
    );
    if (!availability.available) {
      res.status(409).render("error", {
        title: "Room unavailable",
        message: "That window is no longer available. Please pick another.",
      });
      return;
    }

    let priceCheck;
    try {
      priceCheck = calculateBookingPrice({
        bookingType: data.bookingType,
        checkInAt,
        checkOutAt,
        room,
        rates: repo.rates,
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
      requestedCheckIn: priceCheck.checkInAt,
      requestedCheckOut: priceCheck.checkOutAt,
      context: {
        bookings: Array.from(repo.bookings.values()),
        holds: repo.holds,
      },
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
      salesAgentId: undefined,
    });
    booking.notes = data.notes?.trim() || undefined;
    booking.source = "guest";
    indexBooking(repo, booking);
    repo.payments.set(payment.id, payment);
    notify("booking_hold_created", {
      bookingId: booking.id,
      bookingNumber: booking.bookingNumber,
    });

    res.redirect(`/book/${booking.bookingNumber}`);
  });

  router.get("/book/:bookingNumber", (req, res) => {
    const booking = getBookingByNumber(
      repo,
      req.params.bookingNumber as string,
    );
    if (!booking) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const guest = repo.guests.get(booking.guestId);
    const room = repo.rooms.get(booking.roomId);
    const payment = Array.from(repo.payments.values()).find(
      (p) => p.bookingId === booking.id,
    );
    const proof = Array.from(repo.paymentProofs.values()).find(
      (p) => p.bookingId === booking.id,
    );
    const holdForBooking = repo.holds.find(
      (h) =>
        h.roomId === booking.roomId &&
        h.checkInAt.getTime() === booking.checkInAt.getTime(),
    );
    res.render("booking", {
      title: `Booking ${booking.bookingNumber}`,
      booking,
      guest,
      room,
      payment,
      proof,
      hold: holdForBooking,
    });
  });

  router.post(
    "/book/:bookingNumber/upload-proof",
    upload.single("screenshot"),
    (req, res) => {
      const booking = getBookingByNumber(
        repo,
        req.params.bookingNumber as string,
      );
      if (!booking) {
        res.status(404).render("error", { title: "Not found", message: "" });
        return;
      }
      if (booking.status !== "pending_payment") {
        res.status(409).render("error", {
          title: "Cannot upload",
          message: "This booking is not awaiting payment.",
        });
        return;
      }
      const now = new Date();
      if (booking.paymentDeadlineAt && booking.paymentDeadlineAt <= now) {
        booking.status = "cancelled";
        booking.cancelledAt = now;
        notify("hold_expired", { bookingId: booking.id });
        res.status(410).render("error", {
          title: "Hold expired",
          message:
            "Your 15-minute hold expired before payment was uploaded. Please search availability again.",
        });
        return;
      }
      if (!req.file) {
        res.status(400).render("error", {
          title: "Missing file",
          message: "Please attach the bank transfer screenshot.",
        });
        return;
      }
      const fileUrl = `/uploads/${path.basename(req.file.path)}`;
      const payment = Array.from(repo.payments.values()).find(
        (p) => p.bookingId === booking.id,
      );
      const proof = uploadPaymentProof({
        id: nextId("proof"),
        booking,
        payment,
        fileUrl,
      });
      repo.paymentProofs.set(proof.id, proof);
      booking.paymentProofUrl = fileUrl;

      // Side effects: commission + cleaning. Cleaning may fail to auto-assign;
      // the booking still confirms and admin can assign later.
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
        // commission-only fallback when no cleaner is available
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
      notify("payment_proof_uploaded", { bookingId: booking.id });
      notify("booking_confirmed", { bookingId: booking.id });

      res.redirect(`/book/${booking.bookingNumber}/confirmation`);
    },
  );

  router.get("/book/:bookingNumber/confirmation", (req, res) => {
    const booking = getBookingByNumber(
      repo,
      req.params.bookingNumber as string,
    );
    if (!booking) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    const guest = repo.guests.get(booking.guestId);
    const room = repo.rooms.get(booking.roomId);
    res.render("confirmation", {
      title: "Confirmed",
      booking,
      guest,
      room,
    });
  });

  app.use(router);
}
