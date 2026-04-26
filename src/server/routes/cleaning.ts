import { Router, type Express } from "express";
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

export function mountCleaningRoutes(app: Express, repo: Repository): void {
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
    res.render("cleaning/job", {
      title: `Cleaning job ${job.id}`,
      job,
      booking,
      room,
      minibarItems,
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
      res
        .status(400)
        .render("error", { title: "Invalid minibar entry", message: "" });
      return;
    }
    const booking = repo.bookings.get(job.bookingId);
    if (!booking) return;
    const item = repo.minibarItems.get(parsed.data.itemId);
    if (!item) {
      res
        .status(400)
        .render("error", { title: "Unknown minibar item", message: "" });
      return;
    }
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
    res.redirect(`/cleaning/${job.id}`);
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

  router.post("/:id/photo", (req, res) => {
    const r = req as RequestWithUser;
    const job = loadJobOr404(r, res);
    if (!job) return;
    const url = String(req.body.photoUrl ?? "").trim();
    if (!url) {
      res.status(400).render("error", { title: "Missing URL", message: "" });
      return;
    }
    addCleaningPhoto({ job, user: r.currentUser!, photoUrl: url });
    res.redirect(`/cleaning/${job.id}`);
  });

  app.use("/cleaning", router);
}
