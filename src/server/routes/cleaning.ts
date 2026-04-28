import fs from "node:fs";
import path from "node:path";
import { Router, type Express } from "express";
import multer from "multer";
import { z } from "zod";
import {
  addCleaningPhoto,
  completeCleaning,
  markCleaningArrived,
  reportCleaningDamage,
  reportMinibarUsage,
  startCleaning,
} from "../../index.js";
import { nextId, type Repository } from "../../repo/memory.js";
import { requireRole, type RequestWithUser } from "../middleware/auth.js";
import { notify } from "../../services/notifications.js";
import { parseVietnamLocal } from "../parseTime.js";

export function mountCleaningRoutes(
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
  const photoUpload = multer({
    storage,
    limits: { fileSize: 12 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (!/^image\//.test(file.mimetype)) {
        cb(new Error("Only image uploads are allowed."));
        return;
      }
      cb(null, true);
    },
  });

  const router = Router();
  router.use(requireRole("cleaning_crew", "admin", "manager"));

  router.get("/", (req, res) => {
    const user = (req as RequestWithUser).currentUser!;
    const jobs = Array.from(repo.cleaningJobs.values()).filter((j) => {
      if (user.role === "admin" || user.role === "manager") return true;
      return j.assignedToUserId === user.id;
    });
    jobs.sort((a, b) => a.windowStartAt.getTime() - b.windowStartAt.getTime());
    res.render("cleaning/index", {
      title: "My cleaning jobs",
      jobs,
      bookingForJob: (j: { bookingId: string }) =>
        repo.bookings.get(j.bookingId),
      roomForJob: (j: { roomId: string }) => repo.rooms.get(j.roomId),
    });
  });

  function loadJobOr404(req: RequestWithUser, res: import("express").Response) {
    const job = repo.cleaningJobs.get(req.params.id as string);
    if (!job) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return null;
    }
    const user = req.currentUser!;
    if (user.role === "cleaning_crew" && job.assignedToUserId !== user.id) {
      res.status(403).render("error", { title: "Forbidden", message: "" });
      return null;
    }
    return job;
  }

  router.get("/:id", (req, res) => {
    const r = req as RequestWithUser;
    const job = loadJobOr404(r, res);
    if (!job) return;
    const booking = repo.bookings.get(job.bookingId);
    const room = repo.rooms.get(job.roomId);
    const minibarItems = Array.from(repo.minibarItems.values()).filter(
      (i) => i.isActive,
    );
    const recordedUsages = repo.minibarUsage
      .filter((u) => u.bookingId === job.bookingId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    res.render("cleaning/job", {
      title: `Cleaning job ${job.id}`,
      job,
      booking,
      room,
      minibarItems,
      recordedUsages,
      minibarItemById: (id: string) => repo.minibarItems.get(id),
      flash: typeof req.query.flash === "string" ? req.query.flash : "",
      flashError:
        typeof req.query.error === "string" ? req.query.error : "",
    });
  });

  router.post("/:id/arrived", (req, res) => {
    const r = req as RequestWithUser;
    const job = loadJobOr404(r, res);
    if (!job) return;
    markCleaningArrived({ job, user: r.currentUser! });
    res.redirect(`/cleaning/${job.id}`);
  });

  router.post("/:id/start", (req, res) => {
    const r = req as RequestWithUser;
    const job = loadJobOr404(r, res);
    if (!job) return;
    const booking = repo.bookings.get(job.bookingId);
    if (!booking) return;
    startCleaning({ job, booking, user: r.currentUser! });
    notify("cleaning_started", {
      bookingId: booking.id,
      cleaningJobId: job.id,
    });
    res.redirect(`/cleaning/${job.id}`);
  });

  router.post("/:id/complete", (req, res) => {
    const r = req as RequestWithUser;
    const job = loadJobOr404(r, res);
    if (!job) return;
    const booking = repo.bookings.get(job.bookingId);
    if (!booking) return;
    if (!job.assignedToUserId) return;
    const profile = repo.cleaningCrewProfiles.get(job.assignedToUserId);
    if (!profile) return;
    completeCleaning({ job, booking, profile, user: r.currentUser! });
    notify("cleaning_completed", {
      bookingId: booking.id,
      cleaningJobId: job.id,
    });
    res.redirect(`/cleaning/${job.id}`);
  });

  const minibarSchema = z.object({
    itemId: z.string().min(1),
    quantity: z.coerce.number().int().positive(),
  });

  router.post("/:id/minibar", (req, res) => {
    const r = req as RequestWithUser;
    const job = loadJobOr404(r, res);
    if (!job) return;
    const parsed = minibarSchema.safeParse(req.body);
    if (!parsed.success) {
      res.redirect(
        `/cleaning/${job.id}?error=${encodeURIComponent("Pick an item and a quantity ≥ 1.")}`,
      );
      return;
    }
    const booking = repo.bookings.get(job.bookingId);
    if (!booking) {
      res.redirect(`/cleaning/${job.id}?error=Booking+missing`);
      return;
    }
    const item = repo.minibarItems.get(parsed.data.itemId);
    if (!item) {
      res.redirect(
        `/cleaning/${job.id}?error=${encodeURIComponent("Unknown minibar item.")}`,
      );
      return;
    }
    try {
      const usage = reportMinibarUsage({
        id: nextId("minibar-usage"),
        job,
        booking,
        item,
        quantity: parsed.data.quantity,
        user: r.currentUser!,
      });
      repo.minibarUsage.push(usage);
      notify("minibar_reported", { bookingId: booking.id });
      res.redirect(
        `/cleaning/${job.id}?flash=${encodeURIComponent(`Recorded ${parsed.data.quantity} × ${item.name}`)}`,
      );
    } catch (err) {
      res.redirect(
        `/cleaning/${job.id}?error=${encodeURIComponent((err as Error).message)}`,
      );
    }
  });

  const damageSchema = z.object({
    damageChargesVnd: z.coerce.number().int().nonnegative(),
    notes: z.string().optional(),
  });

  router.post("/:id/damage", (req, res) => {
    const r = req as RequestWithUser;
    const job = loadJobOr404(r, res);
    if (!job) return;
    const booking = repo.bookings.get(job.bookingId);
    if (!booking) return;
    const parsed = damageSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .render("error", { title: "Invalid damage entry", message: "" });
      return;
    }
    reportCleaningDamage({
      job,
      booking,
      user: r.currentUser!,
      damageChargesVnd: parsed.data.damageChargesVnd,
      notes: parsed.data.notes,
    });
    notify("damage_reported", { bookingId: booking.id });
    res.redirect(`/cleaning/${job.id}`);
  });

  router.post(
    "/:id/photo",
    photoUpload.array("photoFiles", 8),
    (req, res) => {
      const r = req as RequestWithUser;
      const job = loadJobOr404(r, res);
      if (!job) return;
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const urlFromForm = String(req.body.photoUrl ?? "").trim();
      const urls: string[] = [];
      for (const f of files) urls.push(`/uploads/${path.basename(f.path)}`);
      if (urlFromForm) urls.push(urlFromForm);
      if (urls.length === 0) {
        res.redirect(
          `/cleaning/${job.id}?error=${encodeURIComponent("Pick at least one photo (file or URL).")}`,
        );
        return;
      }
      try {
        for (const u of urls) {
          addCleaningPhoto({ job, user: r.currentUser!, photoUrl: u });
        }
        res.redirect(
          `/cleaning/${job.id}?flash=${encodeURIComponent(`Added ${urls.length} photo(s)`)}`,
        );
      } catch (err) {
        res.redirect(
          `/cleaning/${job.id}?error=${encodeURIComponent((err as Error).message)}`,
        );
      }
    },
  );

  router.get("/me/history", (req, res) => {
    const user = (req as RequestWithUser).currentUser!;
    if (user.role !== "cleaning_crew") {
      res.status(403).render("error", { title: "Forbidden", message: "" });
      return;
    }
    const profile = repo.cleaningCrewProfiles.get(user.id);
    const jobs = Array.from(repo.cleaningJobs.values()).filter(
      (j) => j.assignedToUserId === user.id,
    );
    const payments = repo.cleanerPayments.filter(
      (p) => p.cleanerUserId === user.id,
    );

    // Bucket by Mon-aligned ISO week of the job completedAt date.
    function isoMondayOf(d: Date): string {
      const day = d.getUTCDay();
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
    type Row = {
      weekStartIso: string;
      jobsCompleted: number;
      earnedVnd: number;
      paidAmountVnd: number;
      payments: typeof payments;
    };
    const buckets = new Map<string, Row>();
    const get = (wk: string): Row => {
      let row = buckets.get(wk);
      if (!row) {
        row = {
          weekStartIso: wk,
          jobsCompleted: 0,
          earnedVnd: 0,
          paidAmountVnd: 0,
          payments: [],
        };
        buckets.set(wk, row);
      }
      return row;
    };
    for (const j of jobs) {
      if (j.status !== "completed" || !j.completedAt) continue;
      const row = get(isoMondayOf(j.completedAt));
      row.jobsCompleted += 1;
      row.earnedVnd += j.fixedPayVnd;
    }
    for (const p of payments) {
      const row = get(p.weekStartIso);
      if (p.status !== "void") row.paidAmountVnd += p.amountVnd;
      row.payments.push(p);
    }
    const thisWeek = isoMondayOf(new Date());
    if (!buckets.has(thisWeek)) get(thisWeek);
    const weeklyRows = Array.from(buckets.values()).sort((a, b) =>
      b.weekStartIso.localeCompare(a.weekStartIso),
    );
    for (const r of weeklyRows) {
      r.payments.sort((x, y) => y.paidAt.getTime() - x.paidAt.getTime());
    }

    const lifetimeJobs = weeklyRows.reduce((s, r) => s + r.jobsCompleted, 0);
    const lifetimeEarned = weeklyRows.reduce((s, r) => s + r.earnedVnd, 0);
    const lifetimePaid = weeklyRows.reduce(
      (s, r) => s + r.paidAmountVnd,
      0,
    );

    const recentJobs = jobs
      .slice()
      .sort((a, b) => b.windowStartAt.getTime() - a.windowStartAt.getTime())
      .slice(0, 12);

    res.render("cleaning/history", {
      title: "My history",
      user,
      profile,
      weeklyRows,
      lifetimeJobs,
      lifetimeEarned,
      lifetimePaid,
      recentJobs,
      bookingForJob: (j: { bookingId: string }) =>
        repo.bookings.get(j.bookingId),
      roomForJob: (j: { roomId: string }) => repo.rooms.get(j.roomId),
    });
  });

  router.get("/availability/me", (req, res) => {
    const user = (req as RequestWithUser).currentUser!;
    if (user.role !== "cleaning_crew") {
      res.status(403).render("error", { title: "Forbidden", message: "" });
      return;
    }
    const slots = repo.cleaningAvailability
      .filter((a) => a.cleaningCrewUserId === user.id)
      .sort((a, b) => a.availableFrom.getTime() - b.availableFrom.getTime())
      .slice(0, 60);
    res.render("cleaning/availability", { title: "My availability", slots });
  });

  router.post("/availability/me", (req, res) => {
    const user = (req as RequestWithUser).currentUser!;
    if (user.role !== "cleaning_crew") {
      res.status(403).render("error", { title: "Forbidden", message: "" });
      return;
    }
    const from = parseVietnamLocal(String(req.body.availableFrom ?? ""));
    const until = parseVietnamLocal(String(req.body.availableUntil ?? ""));
    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(until.getTime()) ||
      until <= from
    ) {
      res
        .status(400)
        .render("error", { title: "Bad availability window", message: "" });
      return;
    }
    repo.cleaningAvailability.push({
      id: nextId("availability"),
      cleaningCrewUserId: user.id,
      availableFrom: from,
      availableUntil: until,
      isActive: true,
    });
    res.redirect("/cleaning/availability/me");
  });

  router.post("/availability/:id/toggle", (req, res) => {
    const user = (req as RequestWithUser).currentUser!;
    const slot = repo.cleaningAvailability.find((a) => a.id === req.params.id);
    if (!slot) {
      res.status(404).render("error", { title: "Not found", message: "" });
      return;
    }
    if (user.role === "cleaning_crew" && slot.cleaningCrewUserId !== user.id) {
      res.status(403).render("error", { title: "Forbidden", message: "" });
      return;
    }
    slot.isActive = !slot.isActive;
    res.redirect("/cleaning/availability/me");
  });

  app.use("/cleaning", router);
}
