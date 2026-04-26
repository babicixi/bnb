import type { NextFunction, Request, Response } from "express";
import type { RoleName, User } from "../../domain/types.js";

declare module "express-session" {
  interface SessionData {
    userId?: string;
  }
}

export interface RequestWithUser extends Request {
  currentUser?: User;
}

export function attachCurrentUser(getUser: (id: string) => User | undefined) {
  return (req: RequestWithUser, _res: Response, next: NextFunction): void => {
    const userId = req.session?.userId;
    if (userId) {
      const user = getUser(userId);
      if (user && user.isActive) {
        req.currentUser = user;
      }
    }
    next();
  };
}

export function requireUser(
  req: RequestWithUser,
  res: Response,
  next: NextFunction,
): void {
  if (!req.currentUser) {
    res.redirect("/login");
    return;
  }
  next();
}

export function requireRole(...allowed: RoleName[]) {
  return (req: RequestWithUser, res: Response, next: NextFunction): void => {
    const user = req.currentUser;
    if (!user) {
      res.redirect("/login");
      return;
    }
    if (!allowed.includes(user.role)) {
      res.status(403).render("error", {
        title: "Forbidden",
        message: "You do not have access to this page.",
      });
      return;
    }
    next();
  };
}
