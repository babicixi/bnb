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
  res.locals.currentPath = req.path;
  res.locals.videoEmbed = videoEmbedFor;
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
