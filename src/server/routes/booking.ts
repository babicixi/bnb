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
  detectBookingType,
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
  // bookingType is no longer required — we auto-detect from times when absent.
  // Tests still pass it explicitly to assert specific behaviour.
  bookingType: bookingTypeSchema.optional(),
  // Either pre-composed ISO strings (used by tests) or split date+time pairs
  // (sent by the form). Both branches are accepted.
  checkInAt: z.string().optional(),
  checkInDate: z.string().optional(),
  checkInTime: z.string().optional(),
  checkOutAt: z.string().optional(),
  checkOutDate: z.string().optional(),
  checkOutTime: z.string().optional(),
  guestName: z.string().min(1),
  guestPhone: z.string().min(1),
  guestEmail: z.string().email(),
  guestFacebook: z.string().optional(),
  guestInstagram: z.string().optional(),
  notes: z.string().optional(),
});

function composeDateTime(
  direct?: string,
  date?: string,
  time?: string,
): string | undefined {
  if (direct && direct.length > 0) return direct;
  if (date && time) return `${date}T${time}`;
  return undefined;
}

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

  // Live availability check — used by the booking form's JS to show a
  // green/red banner with the price preview before the guest hits submit.
  router.get("/book/check", (req, res) => {
    const roomId = String(req.query.roomId ?? "");
    const room = repo.rooms.get(roomId);
    if (!room) {
      res.status(404).json({ available: false, message: "Room not found." });
      return;
    }
    const checkInRaw = String(req.query.checkInAt ?? "");
    const checkOutRaw = String(req.query.checkOutAt ?? "");
    const checkInAt = parseVietnamLocal(checkInRaw);
    const checkOutAt = parseVietnamLocal(checkOutRaw);
    if (
      Number.isNaN(checkInAt.getTime()) ||
      Number.isNaN(checkOutAt.getTime())
    ) {
      res
        .status(400)
        .json({ available: false, message: "Pick check-in and check-out." });
      return;
    }
    if (checkOutAt <= checkInAt) {
      res
        .status(400)
        .json({ available: false, message: "Check-out must be after check-in." });
      return;
    }
    expireOldHolds(repo.holds);
    const availability = checkAvailability(
      roomId,
      checkInAt,
      checkOutAt,
      listAvailabilityContext(repo),
    );
    if (!availability.available) {
      const reasons = availability.conflicts.map((c) => c.type);
      res.json({
        available: false,
        message:
          "That window overlaps " +
          (reasons.includes("maintenance")
            ? "a maintenance block."
            : reasons.includes("hold")
              ? "another guest's hold (try again in a few minutes)."
              : "another booking (including its 1-hour cleaning buffer)."),
      });
      return;
    }
    const bookingType = (req.query.bookingType as
      | "hourly"
      | "day"
      | "multi_day"
      | undefined) ?? detectBookingType(checkInAt, checkOutAt);
    try {
      const price = calculateBookingPrice({
        bookingType,
        checkInAt,
        checkOutAt,
        room,
        rates: repo.rates,
        securityDepositVnd: repo.globalSecurityDepositVnd,
      });
      res.json({
        available: true,
        bookingType: price.bookingType,
        amountToCollectVnd: price.amountToCollectVnd,
        netRoomChargeVnd: price.netRoomChargeVnd,
        roomChargeVnd: price.roomChargeVnd,
        securityDepositVnd: price.securityDepositVnd,
        checkInIso: price.checkInAt.toISOString(),
        checkOutIso: price.checkOutAt.toISOString(),
        convertedToDayRate: price.convertedToDayRate,
        lateCheckoutFeeVnd: price.lateCheckoutFeeVnd,
        lateCheckoutMinutes: price.lateCheckoutMinutes,
      });
    } catch (err) {
      res.json({ available: false, message: (err as Error).message });
    }
  });

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
    const checkInRaw = composeDateTime(
      data.checkInAt,
      data.checkInDate,
      data.checkInTime,
    );
    const checkOutRaw = composeDateTime(
      data.checkOutAt,
      data.checkOutDate,
      data.checkOutTime,
    );
    if (!checkInRaw || !checkOutRaw) {
      res
        .status(400)
        .render("error", { title: "Invalid dates", message: "" });
      return;
    }
    const checkInAt = parseVietnamLocal(checkInRaw);
    const checkOutAt = parseVietnamLocal(checkOutRaw);
    if (
      Number.isNaN(checkInAt.getTime()) ||
      Number.isNaN(checkOutAt.getTime())
    ) {
      res.status(400).render("error", { title: "Invalid dates", message: "" });
      return;
    }
    const bookingType = data.bookingType ?? detectBookingType(checkInAt, checkOutAt);

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
        bookingType,
        checkInAt,
        checkOutAt,
        room,
        rates: repo.rates,
        securityDepositVnd: repo.globalSecurityDepositVnd,
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
      email: data.guestEmail,
      facebookHandle: data.guestFacebook?.trim() || undefined,
      instagramHandle: data.guestInstagram?.trim() || undefined,
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

    const bookingNumber = nextBookingNumber(repo, {
      room,
      building: repo.buildings.get(room.buildingId),
      checkInAt: priceCheck.checkInAt,
    });
    const { booking, payment } = createBookingFromHold({
      id: nextId("booking"),
      bookingNumber,
      hold,
      guest,
      room,
      rates: repo.rates,
      bookingType,
      salesAgentId: undefined,
      securityDepositVnd: repo.globalSecurityDepositVnd,
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
