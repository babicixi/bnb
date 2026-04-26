import bcrypt from "bcryptjs";
import { Router, type Express } from "express";
import { z } from "zod";
import type { Repository } from "../../repo/memory.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export function mountAuthRoutes(app: Express, repo: Repository): void {
  const router = Router();

  router.get("/login", (_req, res) => {
    res.render("login", { title: "Staff login", error: null });
  });

  router.post("/login", (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).render("login", {
        title: "Staff login",
        error: "Email and password required.",
      });
      return;
    }
    const user = Array.from(repo.users.values()).find(
      (u) => u.email.toLowerCase() === parsed.data.email.toLowerCase(),
    );
    if (!user || !user.passwordHash || !user.isActive) {
      res
        .status(401)
        .render("login", { title: "Staff login", error: "Invalid login." });
      return;
    }
    if (!bcrypt.compareSync(parsed.data.password, user.passwordHash)) {
      res
        .status(401)
        .render("login", { title: "Staff login", error: "Invalid login." });
      return;
    }
    req.session.userId = user.id;
    const redirect =
      user.role === "admin" || user.role === "manager"
        ? "/admin"
        : user.role === "sales_agent"
          ? "/agent"
          : "/cleaning";
    res.redirect(redirect);
  });

  router.post("/logout", (req, res) => {
    req.session.destroy(() => {
      res.redirect("/");
    });
  });

  app.use(router);
}
