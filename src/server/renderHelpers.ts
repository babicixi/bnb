import type { Request, Response, NextFunction } from "express";
import { t, type Locale } from "./i18n.js";

export function attachLocaleAndHelpers(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const locale: Locale = req.query.locale === "vi" ? "vi" : "en";
  res.locals.locale = locale;
  res.locals.t = (key: string) => t(key, locale);
  res.locals.formatVnd = (n: number) =>
    new Intl.NumberFormat("vi-VN").format(n) + " ₫";
  res.locals.formatDateTime = (d: Date) => {
    if (!d) return "";
    const date = d instanceof Date ? d : new Date(d);
    return date
      .toLocaleString("en-GB", {
        timeZone: "Asia/Ho_Chi_Minh",
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
      .replace(",", "");
  };
  res.locals.currentUser = (
    req as Request & { currentUser?: { fullName?: string; role?: string } }
  ).currentUser;
  next();
}
