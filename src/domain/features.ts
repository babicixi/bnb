/**
 * Standard catalog of room features. Admin picks from this list via
 * checkboxes; landing & room pages render the matching icon + locale label.
 *
 * `key` is the stable identifier persisted on Room.features. Anything in
 * Room.features that is not in this catalog is rendered as a plain text tag
 * (legacy free-form values from before the catalog).
 */
export type FeatureKey =
  | "bathtub"
  | "bath_bomb"
  | "projector_65"
  | "tv_50"
  | "kitchen"
  | "kitchenette"
  | "king_bed"
  | "two_beds"
  | "balcony"
  | "city_view"
  | "wifi"
  | "ac"
  | "smart_tv"
  | "snacks_bar";

export interface FeatureDef {
  key: FeatureKey;
  icon: string; // single-character emoji or symbol
  en: string;
  vi: string;
}

export const FEATURES: FeatureDef[] = [
  { key: "bathtub",     icon: "🛁", en: "Bathtub",        vi: "Bồn tắm" },
  { key: "bath_bomb",   icon: "🧖", en: "Bath bomb",      vi: "Bom tắm" },
  { key: "projector_65",icon: "📽️", en: "65\" projector", vi: "Máy chiếu 65\"" },
  { key: "tv_50",       icon: "📺", en: "50\" TV",        vi: "TV 50\"" },
  { key: "smart_tv",    icon: "📺", en: "Smart TV",       vi: "Smart TV" },
  { key: "kitchen",     icon: "🍳", en: "Full kitchen",   vi: "Bếp đầy đủ" },
  { key: "kitchenette", icon: "🥣", en: "Kitchenette",    vi: "Bếp nhỏ" },
  { key: "king_bed",    icon: "🛏️", en: "King-size bed",  vi: "Giường King" },
  { key: "two_beds",    icon: "🛌", en: "Two beds",       vi: "Hai giường" },
  { key: "balcony",     icon: "🌿", en: "Balcony",        vi: "Ban công" },
  { key: "city_view",   icon: "🏙️", en: "City view",      vi: "View thành phố" },
  { key: "wifi",        icon: "📶", en: "Fast Wi-Fi",     vi: "Wi-Fi nhanh" },
  { key: "ac",          icon: "❄️", en: "Air conditioning", vi: "Điều hòa" },
  { key: "snacks_bar",  icon: "🍫", en: "Snacks bar",     vi: "Quầy đồ ăn vặt" },
];

const featureMap = new Map<string, FeatureDef>(FEATURES.map((f) => [f.key, f]));

/**
 * Legacy free-form features (e.g. "Balcony", "Smart TV", "65\" Projector")
 * are matched into the catalog via a normalized lookup so they pick up the
 * right icon on the public room page even if the admin hasn't migrated yet.
 *
 * Match order: exact key → normalized exact (lowercase, no punctuation/space)
 * → substring of either EN or VI label inside the feature string.
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}
const normalizedKeyMap = new Map<string, FeatureDef>();
for (const f of FEATURES) {
  normalizedKeyMap.set(normalize(f.key), f);
  normalizedKeyMap.set(normalize(f.en), f);
  normalizedKeyMap.set(normalize(f.vi), f);
}

function resolve(value: string): FeatureDef | undefined {
  if (!value) return undefined;
  if (featureMap.has(value)) return featureMap.get(value);
  const norm = normalize(value);
  const exact = normalizedKeyMap.get(norm);
  if (exact) return exact;
  // Substring fallback so things like "65 inch projector" still find projector_65.
  for (const f of FEATURES) {
    if (
      norm.includes(normalize(f.en)) ||
      normalize(f.en).includes(norm) ||
      norm.includes(normalize(f.vi))
    ) {
      return f;
    }
  }
  return undefined;
}

export function featureLabel(key: string, locale: "en" | "vi"): string {
  const def = resolve(key);
  if (!def) return key;
  return locale === "vi" ? def.vi : def.en;
}

export function featureIcon(key: string): string {
  return resolve(key)?.icon ?? "•";
}

export function isKnownFeature(key: string): boolean {
  return resolve(key) !== undefined;
}
