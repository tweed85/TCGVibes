// Hand-curated role tags for high-impact cards in the current legal pool,
// plus regex fallbacks for the long tail.
//
// Whitelist entries below are verified-present in the May 2026 standard pool
// at the time of writing. The dataset-validation test at
// src/data/__tests__/deckDoctor.test.ts asserts every name resolves via
// cardsByName, so a future rotation that drops a card surfaces immediately.
//
// `getRoleTags(card)` returns metadata, not bare tags — whitelist hits carry
// `confidence: "high"`, regex fallbacks carry `"low"`. Findings that depend
// on a regex-tagged card inherit that lower confidence.
//
// This module is DECK-AGNOSTIC: it only sees one card at a time. Engine
// reachability (whether a Pokémon's evolution line is supported by the rest
// of the deck) lives in deckDoctor.ts where the deck context is available.

import type { Card } from "../engine/types";
import type { Confidence } from "../engine/aiArchetype";

export type RoleTag =
  // Draw — actually puts cards into your hand
  | "draw:supporter"
  | "draw:disruption"
  | "draw:ability"
  | "draw:item"
  // Search — finds specific cards
  | "search:pokemon"
  | "search:trainer"
  | "search:energy"
  | "search:ability"
  // Setup / openers
  | "setup:ability"
  // Evolution
  | "evolution:accelerator"
  // Recycle
  | "recycle:card"
  // Mobility
  | "mobility:switch"
  | "mobility:pivot"
  | "mobility:gust"
  // Tech / answers
  | "tech:tool-removal"
  | "tech:special-energy"
  | "tech:ability-lock";

export interface RoleTagHit {
  tag: RoleTag;
  confidence: Confidence;
  source: "whitelist" | "regex";
}

// ---------------------------------------------------------------------------
// CARD_ROLES — hand-curated whitelist. Verified against the legal pool by
// the dataset-validation test.
// ---------------------------------------------------------------------------
export const CARD_ROLES: Record<string, RoleTag[]> = {
  // ---- Draw Supporters --------------------------------------------------
  // (Iono / Professor's Research / Marnie / Cynthia / Penny etc. have
  // rotated out of standard; only verified-present names appear here.)
  "Lillie's Determination": ["draw:supporter"],
  "Lt. Surge's Bargain": ["draw:supporter"],
  "Iris's Fighting Spirit": ["draw:supporter"],
  "Surfer": ["draw:supporter"],
  "Cheren": ["draw:supporter"],
  "Lacey": ["draw:supporter"],
  "Drasna": ["draw:supporter"],
  "Tyme": ["draw:supporter"],
  "Friends in Paldea": ["draw:supporter"],
  "Billy & O'Nare": ["draw:supporter"],
  "Picnicker": ["draw:supporter"],
  "Hilda": ["draw:supporter"],
  "Judge": ["draw:supporter", "draw:disruption"],
  "Colress's Tenacity": ["draw:supporter"],
  "Carmine": ["draw:supporter"],
  "Team Rocket's Archer": ["draw:supporter"],
  "Team Rocket's Ariana": ["draw:supporter"],
  "Urbain": ["draw:supporter"],

  // ---- Draw / search abilities (Pokémon) -------------------------------
  // Industrious-Incisors / Ascending-Voice draw chains.
  "Dudunsparce": ["draw:ability"],

  // ---- Search items (Pokémon) ------------------------------------------
  "Ultra Ball": ["search:pokemon"],
  "Buddy-Buddy Poffin": ["search:pokemon"],
  "Poké Pad": ["search:pokemon"],
  "Poké Ball": ["search:pokemon"],
  "Mega Signal": ["search:pokemon"],
  "Fighting Gong": ["search:pokemon"],

  // ---- Search items (Trainer / energy) --------------------------------
  "Pokégear 3.0": ["search:trainer"],
  "Energy Search": ["search:energy"],

  // ---- Evolution acceleration ------------------------------------------
  "Rare Candy": ["evolution:accelerator"],

  // ---- Recycle ---------------------------------------------------------
  "Night Stretcher": ["recycle:card"],
  "Energy Recycler": ["recycle:card"],

  // ---- Mobility: switch / pivot ----------------------------------------
  "Switch": ["mobility:switch"],
  "Latias ex": ["mobility:pivot"],

  // ---- Mobility: gust --------------------------------------------------
  "Boss's Orders": ["mobility:gust"],

  // ---- Tech ------------------------------------------------------------
  "Tool Scrapper": ["tech:tool-removal"],
  "Enhanced Hammer": ["tech:special-energy"],
};

// ---------------------------------------------------------------------------
// Regex fallbacks for the long tail. Tags found via regex carry
// `confidence: "low"` and `source: "regex"`. Used when CARD_ROLES misses.
// ---------------------------------------------------------------------------

interface RegexRule {
  tag: RoleTag;
  match: (card: Card) => boolean;
}

const REGEX_RULES: RegexRule[] = [
  // Supporter that draws.
  {
    tag: "draw:supporter",
    match: (c) =>
      c.supertype === "Trainer" &&
      (c.subtypes ?? []).includes("Supporter") &&
      /draw \d+ cards?\b|draw cards until|shuffle your hand .* then draw/i.test(c.text ?? ""),
  },
  // Disruption supporter that ALSO draws — same plus opp-shuffle text.
  {
    tag: "draw:disruption",
    match: (c) =>
      c.supertype === "Trainer" &&
      (c.subtypes ?? []).includes("Supporter") &&
      /draw \d+ cards?|draw cards until/i.test(c.text ?? "") &&
      /your opponent .* shuffle .* their hand|each player shuffles?/i.test(c.text ?? ""),
  },
  // Item that draws.
  {
    tag: "draw:item",
    match: (c) =>
      c.supertype === "Trainer" &&
      (c.subtypes ?? []).includes("Item") &&
      /draw \d+ cards?\b/i.test(c.text ?? ""),
  },
  // Pokémon search items.
  {
    tag: "search:pokemon",
    match: (c) =>
      c.supertype === "Trainer" &&
      (c.subtypes ?? []).includes("Item") &&
      /search your deck for (a |an |up to \d+ )?(?:\w+ )*pok[eé]mon/i.test(c.text ?? ""),
  },
  // Energy search items.
  {
    tag: "search:energy",
    match: (c) =>
      c.supertype === "Trainer" &&
      (c.subtypes ?? []).includes("Item") &&
      /search your deck for (a |an |up to \d+ )?(?:\w+ )*energy/i.test(c.text ?? ""),
  },
  // Trainer search items.
  {
    tag: "search:trainer",
    match: (c) =>
      c.supertype === "Trainer" &&
      (c.subtypes ?? []).includes("Item") &&
      /search your deck for (a |an |up to \d+ )?(?:\w+ )*supporter/i.test(c.text ?? ""),
  },
  // Tool removal items.
  {
    tag: "tech:tool-removal",
    match: (c) =>
      c.supertype === "Trainer" &&
      /discard (?:a |all )?pok[eé]mon tool/i.test(c.text ?? ""),
  },
  // Recycle — items that put cards from discard into deck or hand.
  {
    tag: "recycle:card",
    match: (c) =>
      c.supertype === "Trainer" &&
      (c.subtypes ?? []).includes("Item") &&
      /from your discard pile (?:back )?into your (?:deck|hand)/i.test(c.text ?? ""),
  },
];

// ---------------------------------------------------------------------------
// Public lookup. Returns the union of whitelist tags (high confidence) and
// regex fallbacks (low confidence) for the card. If the whitelist already
// covered a tag, the regex fallback for that tag is suppressed so we don't
// double-count or downgrade a known-good tag.
// ---------------------------------------------------------------------------
export function getRoleTags(card: Card): RoleTagHit[] {
  const out: RoleTagHit[] = [];
  const whitelist = CARD_ROLES[card.name];
  const seen = new Set<RoleTag>();
  if (whitelist) {
    for (const tag of whitelist) {
      out.push({ tag, confidence: "high", source: "whitelist" });
      seen.add(tag);
    }
  }
  for (const rule of REGEX_RULES) {
    if (seen.has(rule.tag)) continue;
    if (rule.match(card)) {
      out.push({ tag: rule.tag, confidence: "low", source: "regex" });
      seen.add(rule.tag);
    }
  }
  return out;
}

// Convenience: just the tag set (without metadata) for callers that don't
// care about source — handy in unit tests and a few internal lookups.
export function roleTagsOf(card: Card): Set<RoleTag> {
  return new Set(getRoleTags(card).map((h) => h.tag));
}
