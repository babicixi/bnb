import type { Request, Response, NextFunction } from "express";
import { DEFAULT_LOCALE, t, type Locale } from "./i18n.js";
import { FEATURES, featureIcon, featureLabel } from "../domain/features.js";

export function attachLocaleAndHelpers(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Vietnam-first audience: default to VI, allow ?locale=en (or vi) to override
  // for that single response, and remember the choice in a cookie.
  let locale: Locale = DEFAULT_LOCALE;
  const cookieLocale = (req as Request & { cookies?: Record<string, string> })
    .cookies?.locale;
  if (cookieLocale === "en" || cookieLocale === "vi") locale = cookieLocale;
  if (req.query.locale === "en" || req.query.locale === "vi") {
    locale = req.query.locale;
    res.cookie("locale", locale, {
      httpOnly: false,
      sameSite: "lax",
      maxAge: 365 * 24 * 60 * 60_000,
    });
  }
  res.locals.locale = locale;
  res.locals.t = (key: string, ...args: unknown[]) => t(key, locale, ...args);
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
  res.locals.currentPath = req.path;
  res.locals.videoEmbed = videoEmbedFor;
  res.locals.featureCatalog = FEATURES;
  res.locals.featureLabel = (key: string) => featureLabel(key, locale);
  res.locals.featureIcon = featureIcon;
  res.locals.roomDescription = (room: {
    descriptionEn?: string;
    descriptionVi?: string;
    description?: string;
  }) => {
    if (locale === "vi" && room.descriptionVi) return room.descriptionVi;
    if (locale === "en" && room.descriptionEn) return room.descriptionEn;
    return room.descriptionVi || room.descriptionEn || room.description || "";
  };
  next();
}

/**
 * Given a video URL, return either an iframe embed (for known providers)
 * or a plain anchor as a fallback so unknown URLs still render usefully.
 */
function videoEmbedFor(url: string): string {
  if (!url) return "";
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._\-/:?=&]/g, "");
  // YouTube: full or short URL
  let m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]+)/);
  if (m && m[1]) {
    return `<iframe class="vid-embed" src="https://www.youtube.com/embed/${safe(m[1])}" frameborder="0" allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
  }
  // Vimeo
  m = url.match(/vimeo\.com\/(\d+)/);
  if (m && m[1]) {
    return `<iframe class="vid-embed" src="https://player.vimeo.com/video/${safe(m[1])}" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
  }
  // Google Drive shared file
  m = url.match(/drive\.google\.com\/file\/d\/([\w-]+)/);
  if (m && m[1]) {
    return `<iframe class="vid-embed" src="https://drive.google.com/file/d/${safe(m[1])}/preview" frameborder="0" allow="autoplay" allowfullscreen></iframe>`;
  }
  // Fallback: plain link
  const safeUrl = url.replace(/"/g, "&quot;");
  return `<a class="btn secondary" href="${safeUrl}" target="_blank" rel="noopener">▶ Watch video</a>`;
}
