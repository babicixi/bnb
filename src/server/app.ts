import express from "express";
import session from "express-session";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRepository,
  loadRepoInPlace,
  saveRepoSync,
  seedRepository,
} from "../repo/index.js";
import type { Repository } from "../repo/memory.js";
import { attachCurrentUser } from "./middleware/auth.js";
import { attachLocaleAndHelpers } from "./renderHelpers.js";
import { mountAuthRoutes } from "./routes/auth.js";
import { mountPublicRoutes } from "./routes/public.js";
import { mountBookingRoutes } from "./routes/booking.js";
import { mountAdminRoutes } from "./routes/admin.js";
import { mountAgentRoutes } from "./routes/agent.js";
import { mountCleaningRoutes } from "./routes/cleaning.js";
import { runOperationalSweep } from "../services/automation.js";
import { notifications } from "../services/notifications.js";
import { createTask } from "../services/tasks.js";
import { nextId } from "../repo/memory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");

export interface CreateAppOptions {
  repository?: Repository;
  sessionSecret?: string;
  uploadsDir?: string;
  startSweepTimer?: boolean;
  sweepIntervalMs?: number;
  /**
   * If set, the repo state is loaded from this file on boot (replacing
   * the seed when present) and written back after every successful
   * non-GET response. Tests can omit this to keep state ephemeral.
   */
  persistencePath?: string;
}

export function createApp(opts: CreateAppOptions = {}): {
  app: express.Express;
  repo: Repository;
  uploadsDir: string;
  demoCredentials: ReturnType<typeof seedRepository>;
  sweepTimer?: NodeJS.Timeout;
  persistencePath?: string;
} {
  const repo = opts.repository ?? createRepository();
  // Always derive credentials from the demo seed so console output stays
  // useful, but only apply seed mutations on first boot. If a saved snapshot
  // exists, it wins (any later edits/additions are restored).
  const demoCredentials = seedRepository(repo);
  if (opts.persistencePath) {
    const loaded = loadRepoInPlace(repo, opts.persistencePath);
    if (loaded) {
      console.log(`▶ loaded saved state from ${opts.persistencePath}`);
    }
  }
  const uploadsDir = opts.uploadsDir ?? path.join(projectRoot, "uploads");

  const app = express();
  app.set("views", path.join(__dirname, "views"));
  app.set("view engine", "ejs");
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(
    session({
      secret: opts.sessionSecret ?? "dev-secret-change-me",
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: "lax", secure: false },
    }),
  );
  app.use(express.static(path.join(projectRoot, "public")));
  app.use("/uploads", express.static(uploadsDir));
  app.use(attachCurrentUser((id) => repo.users.get(id)));
  app.use(attachLocaleAndHelpers);

  // Persist the repo after every successful state-mutating response.
  if (opts.persistencePath) {
    const persistencePath = opts.persistencePath;
    app.use((req, res, next) => {
      if (req.method === "GET" || req.method === "HEAD") {
        next();
        return;
      }
      res.on("finish", () => {
        if (res.statusCode >= 400) return;
        try {
          saveRepoSync(repo, persistencePath);
        } catch (err) {
          console.error("[persist] save failed:", err);
        }
      });
      next();
    });
  }

  mountAuthRoutes(app, repo);
  mountPublicRoutes(app, repo);
  mountBookingRoutes(app, repo, uploadsDir);
  mountAdminRoutes(app, repo, uploadsDir);
  mountAgentRoutes(app, repo);
  mountCleaningRoutes(app, repo);

  app.use((_req, res) => {
    res
      .status(404)
      .render("error", { title: "Not found", message: "Page not found." });
  });

  // Wire notification log + auto-task creation
  const eventToTask: Record<
    string,
    {
      title: string;
      role: "admin" | "manager";
      priority: "high" | "normal" | "urgent";
    }
  > = {
    payment_proof_invalid: {
      title: "Contact guest about invalid payment proof",
      role: "admin",
      priority: "high",
    },
    refund_pending: {
      title: "Process pending refund",
      role: "admin",
      priority: "high",
    },
    extra_payment_required: {
      title: "Collect extra payment from guest",
      role: "admin",
      priority: "high",
    },
    cancellation_requested: {
      title: "Approve or reject cancellation request",
      role: "admin",
      priority: "high",
    },
    damage_reported: {
      title: "Review damage report",
      role: "admin",
      priority: "normal",
    },
    hold_expired: {
      title: "Hold expired without payment — review if recovery needed",
      role: "admin",
      priority: "normal",
    },
  };
  const universal =
    (event: string) =>
    (payload: {
      bookingId?: string;
      cleaningJobId?: string;
      actorUserId?: string;
      meta?: Record<string, unknown>;
      occurredAt?: Date;
    }) => {
      repo.notificationLog.push({
        id: nextId("notif"),
        event,
        bookingId: payload.bookingId,
        cleaningJobId: payload.cleaningJobId,
        actorUserId: payload.actorUserId,
        payload: payload.meta,
        occurredAt: payload.occurredAt ?? new Date(),
      });
      const taskTemplate = eventToTask[event];
      if (taskTemplate) {
        createTask(repo.tasks, {
          id: nextId("task"),
          title: taskTemplate.title,
          relatedEntityType: payload.bookingId ? "booking" : undefined,
          relatedEntityId: payload.bookingId,
          assignedRole: taskTemplate.role,
          priority: taskTemplate.priority,
        });
      }
    };
  notifications.setMaxListeners(50);
  for (const event of [
    "booking_hold_created",
    "hold_expiring_soon",
    "hold_expired",
    "payment_proof_uploaded",
    "booking_confirmed",
    "payment_proof_invalid",
    "extra_payment_required",
    "refund_pending",
    "refund_sent",
    "cancellation_requested",
    "cancellation_approved",
    "cancellation_rejected",
    "checkin_today",
    "checkout_today",
    "cleaning_assigned",
    "cleaning_started",
    "cleaning_completed",
    "minibar_reported",
    "damage_reported",
    "booking_closed",
  ]) {
    notifications.on(event, universal(event));
  }

  let sweepTimer: NodeJS.Timeout | undefined;
  if (opts.startSweepTimer) {
    const interval = opts.sweepIntervalMs ?? 60_000;
    sweepTimer = setInterval(() => {
      runOperationalSweep({
        holds: repo.holds,
        bookings: repo.bookings.values(),
        cleaningJobs: repo.cleaningJobs.values(),
      });
    }, interval);
    sweepTimer.unref?.();
  }

  return {
    app,
    repo,
    uploadsDir,
    demoCredentials,
    sweepTimer,
    persistencePath: opts.persistencePath,
  };
}
