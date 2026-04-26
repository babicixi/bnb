import express from "express";
import session from "express-session";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRepository, seedRepository } from "../repo/index.js";
import type { Repository } from "../repo/memory.js";
import { attachCurrentUser } from "./middleware/auth.js";
import { attachLocaleAndHelpers } from "./renderHelpers.js";
import { mountAuthRoutes } from "./routes/auth.js";
import { mountPublicRoutes } from "./routes/public.js";
import { mountBookingRoutes } from "./routes/booking.js";
import { mountAdminRoutes } from "./routes/admin.js";
import { mountAgentRoutes } from "./routes/agent.js";
import { mountCleaningRoutes } from "./routes/cleaning.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");

export interface CreateAppOptions {
  repository?: Repository;
  sessionSecret?: string;
  uploadsDir?: string;
}

export function createApp(opts: CreateAppOptions = {}): {
  app: express.Express;
  repo: Repository;
  uploadsDir: string;
  demoCredentials: ReturnType<typeof seedRepository>;
} {
  const repo = opts.repository ?? createRepository();
  const demoCredentials = seedRepository(repo);
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

  mountAuthRoutes(app, repo);
  mountPublicRoutes(app, repo);
  mountBookingRoutes(app, repo, uploadsDir);
  mountAdminRoutes(app, repo);
  mountAgentRoutes(app, repo);
  mountCleaningRoutes(app, repo);

  app.use((_req, res) => {
    res
      .status(404)
      .render("error", { title: "Not found", message: "Page not found." });
  });

  return { app, repo, uploadsDir, demoCredentials };
}
