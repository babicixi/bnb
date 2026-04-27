import fs from "node:fs";
import path from "node:path";
import type { Repository } from "./memory.js";

/**
 * Lightweight JSON persistence for the in-memory repository.
 *
 * We tag Maps and Dates with a `__type` discriminator so they round-trip
 * through JSON.stringify/parse. The reviver runs depth-first so nested
 * Dates inside Map values are revived before the Map itself is reconstructed.
 *
 * The save path uses write-temp + rename for atomicity (no half-written
 * file if the process is killed mid-flush).
 */

const REVIVE_MAP = "__map__";
const REVIVE_DATE = "__date__";

// JSON.stringify calls Date.prototype.toJSON() *before* the replacer runs, so
// a plain `value instanceof Date` check there always misses. Look up the
// untransformed original on `this` instead.
function replacer(this: unknown, key: string, value: unknown): unknown {
  const parent = this as Record<string, unknown> | null;
  const original = parent ? parent[key] : value;
  if (original instanceof Date) {
    return { __type: REVIVE_DATE, iso: original.toISOString() };
  }
  if (value instanceof Map) {
    return { __type: REVIVE_MAP, entries: Array.from(value.entries()) };
  }
  return value;
}

// Matches ISO 8601 with milliseconds and Z (what Date.toISOString emits).
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function reviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && ISO_RE.test(value)) {
    return new Date(value);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as { __type?: string; entries?: unknown; iso?: string };
    if (v.__type === REVIVE_MAP && Array.isArray(v.entries)) {
      return new Map(v.entries as Array<[unknown, unknown]>);
    }
    if (v.__type === REVIVE_DATE && typeof v.iso === "string") {
      return new Date(v.iso);
    }
  }
  return value;
}

export function saveRepoSync(repo: Repository, filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(repo, replacer));
  fs.renameSync(tmp, filePath);
}

/**
 * Load a previously saved snapshot into the given repo, in place.
 * Returns true if a snapshot was found and applied, false otherwise.
 *
 * Existing closures that captured `repo` keep working because we mutate
 * its properties rather than swapping the object.
 */
export function loadRepoInPlace(repo: Repository, filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const json = fs.readFileSync(filePath, "utf-8");
  if (!json.trim()) return false;
  const data = JSON.parse(json, reviver) as Repository;
  const repoAny = repo as unknown as Record<string, unknown>;
  const dataAny = data as unknown as Record<string, unknown>;
  for (const k of Object.keys(repoAny)) {
    if (k in dataAny) repoAny[k] = dataAny[k];
  }
  return true;
}
