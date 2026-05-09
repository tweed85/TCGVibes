// Deck Doctor — coach-style analyzer.
//
// Pure module. Inputs come in via `DeckInput` and `DoctorContext`; the
// analyzer never reads outside its arguments. `composeReport` adds the
// timestamp/version metadata, `serializeDoctorReport` renders the plaintext
// for the clipboard. The structured DeckAnalysis can be reused (UI, tests).
//
// Engine behavior is unchanged — we read card data, run heuristics, and
// emit findings. Nothing here mutates state or imports React.

import type {
  Card,
  EnergyCard,
  EnergyType,
  PokemonCard,
  TrainerCard,
} from "../engine/types";
import {
  ARCHETYPE_PROFILES,
  detectArchetypeFromCardNames,
  type Archetype,
  type Confidence,
} from "../engine/aiArchetype";
import { getRoleTags, type RoleTag, type RoleTagHit } from "./cardRoles";
import type { DeckListEntry, importDecklist } from "./decklistParser";
import { hypergeometric, oddsAtLeast } from "./deckMath";

// ---- Types ---------------------------------------------------------------

export interface DoctorContext {
  cardsByName: Map<string, Card[]>;
  gameplayKey: (c: Card) => string;
}

export interface DeckInput {
  cards: Card[];
  source: "preset" | "saved" | "paste";
  sourceName?: string;
  // PTCGL paste metadata (only when source === "paste"):
  entries?: DeckListEntry[];
  parseErrors?: string[];
  unmatched?: DeckListEntry[];
  pasteNotices?: PasteNotice[];
}

export type PasteNotice =
  | { kind: "over-four"; cardName: string; pastedCount: number }
  | { kind: "ace-spec"; cardNames: string[] }
  | { kind: "radiant"; cardNames: string[] }
  | {
      kind: "name-only-match";
      pastedEntry: string;
      resolvedTo?: { name: string; setCode: string; number: string };
      ambiguous: boolean;
      candidates?: Array<{
        name: string;
        setCode: string;
        number: string;
        signature: string;
      }>;
    };

export type Severity = "error" | "warning" | "suggestion";
export type Actionability = "high" | "medium" | "low";
export type Scope = "deck" | "line" | "card" | "archetype";
export type Category =
  | "Legal"
  | "Composition"
  | "Consistency"
  | "Energy"
  | "Mobility"
  | "Stage lines"
  | "Archetype"
  | "Probability";

export interface Finding {
  id: string;
  severity: Severity;
  confidence: Confidence;
  actionability: Actionability;
  scope: Scope;
  category: Category;
  title: string;
  detail: string;
  evidence?: string[];
  cards?: string[];
  fix?: string[];
}

export interface SuppressionNote {
  findingId: string;
  reason: string;
}

export interface DeckComposition {
  pokemon: number;
  trainer: number;
  energy: number;
  basics: number;
  attackersMain: string[];
  attackersSupport: string[];
  drawEngines: string[];
  searchPokemon: string[];
  searchTrainer: string[];
  searchEnergy: string[];
  searchAbilities: string[];
  setupAbilities: string[];
  evolutionAccelerators: string[];
  recyclers: string[];
  gustEffects: string[];
  switchOrPivot: string[];
  stadiums: string[];
  tools: string[];
  aceSpec: string[];
  notes: string[];
}

export interface DeckAnalysis {
  source: { kind: DeckInput["source"]; name?: string };
  archetype: { id: Archetype; confidence: Confidence };
  composition: DeckComposition;
  findings: Finding[];
  priorities: Finding[];
  suppressions: SuppressionNote[];
  ok: boolean;
  noMajorIssues: boolean;
}

export interface ReportMeta {
  generatedAt: string;
  datasetAsOf: string;
  doctorVersion: number;
}

export interface DoctorReport extends DeckAnalysis {
  meta: ReportMeta;
}

// ---- Adapter: parser → typed paste notices --------------------------------

// Builds a one-line attack/ability signature for a Pokémon card so the user
// can tell same-name printings apart in the ambiguity evidence.
function cardSignature(c: Card): string {
  if (c.supertype === "Pokémon") {
    const main = c.attacks?.[0];
    const tail = main
      ? ` · ${main.cost.length}E ${main.name} ${main.damageText ?? main.damage ?? ""}`.trim()
      : "";
    return `${c.hp ?? "?"} HP${tail}`;
  }
  if (c.supertype === "Energy") {
    return `${(c.subtypes ?? []).join(" · ")} · ${c.provides.join("/")}`;
  }
  return (c.subtypes ?? []).join(" · ") || "Trainer";
}

export function pasteNoticesFromImport(
  importResult: ReturnType<typeof importDecklist>,
  ctx: DoctorContext,
): PasteNotice[] {
  const out: PasteNotice[] = [];

  // over-four: walk entries, sum counts per name, emit when >4 (basic energy
  // is exempt — same gate the parser uses).
  const perName = new Map<string, number>();
  for (const e of importResult.entries) {
    perName.set(e.name, (perName.get(e.name) ?? 0) + e.count);
  }
  for (const [name, count] of perName) {
    if (count <= 4) continue;
    const sample = ctx.cardsByName.get(name)?.[0];
    const isBasicEnergy =
      sample?.supertype === "Energy" && sample.subtypes.includes("Basic");
    if (isBasicEnergy) continue;
    out.push({ kind: "over-four", cardName: name, pastedCount: count });
  }

  // ace-spec / radiant — count from the resolved deck (post-clamp).
  const aceSpecNames = new Set<string>();
  const radiantNames = new Set<string>();
  for (const c of importResult.deck) {
    const subs = (c as { subtypes?: string[] }).subtypes ?? [];
    if (subs.includes("ACE SPEC")) aceSpecNames.add(c.name);
    if (subs.includes("Radiant")) radiantNames.add(c.name);
  }
  if (aceSpecNames.size > 1) {
    out.push({ kind: "ace-spec", cardNames: [...aceSpecNames].sort() });
  }
  if (radiantNames.size > 1) {
    out.push({ kind: "radiant", cardNames: [...radiantNames].sort() });
  }

  // name-only-match — derived from the parser's nameOnlyMatches list.
  for (const e of importResult.nameOnlyMatches) {
    // Best-effort: pick a resolved card with the same name from the deck.
    const resolved = importResult.deck.find((c) => c.name === e.name);
    const sameName = ctx.cardsByName.get(e.name) ?? [];
    const distinctKeys = new Set(sameName.map((c) => ctx.gameplayKey(c)));
    const ambiguous = distinctKeys.size > 1;
    out.push({
      kind: "name-only-match",
      pastedEntry: `${e.count} ${e.name} ${e.limitlessSet} ${e.number}`,
      resolvedTo: resolved
        ? {
            name: resolved.name,
            setCode: resolved.setCode ?? "",
            number: resolved.number ?? "",
          }
        : undefined,
      ambiguous,
      candidates: ambiguous
        ? sameName.map((c) => ({
            name: c.name,
            setCode: c.setCode ?? "",
            number: c.number ?? "",
            signature: cardSignature(c),
          }))
        : undefined,
    });
  }

  return out;
}

// ---- Helpers --------------------------------------------------------------

function isPokemonCard(c: Card): c is PokemonCard {
  return c.supertype === "Pokémon";
}
function isEnergyCard(c: Card): c is EnergyCard {
  return c.supertype === "Energy";
}
function isTrainerCard(c: Card): c is TrainerCard {
  return c.supertype === "Trainer";
}
function isBasicPoke(c: Card): boolean {
  return isPokemonCard(c) && (c.subtypes ?? []).includes("Basic");
}
function isStage1(c: Card): boolean {
  return isPokemonCard(c) && (c.subtypes ?? []).includes("Stage 1");
}
function isStage2(c: Card): boolean {
  return isPokemonCard(c) && (c.subtypes ?? []).includes("Stage 2");
}
function isStadium(c: Card): boolean {
  return isTrainerCard(c) && (c.subtypes ?? []).includes("Stadium");
}
function isTool(c: Card): boolean {
  return (
    isTrainerCard(c) &&
    ((c.subtypes ?? []).includes("Pokémon Tool") ||
      (c.subtypes ?? []).includes("Tool"))
  );
}

// Aggregate counts by card name across printings (rule-of-4 is by name).
function countsByName(deck: Card[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of deck) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  return counts;
}

// Unique card names with at least one tag from `wanted`.
function namesWithAnyTag(deck: Card[], wanted: ReadonlySet<RoleTag>): string[] {
  const seen = new Set<string>();
  const tagsByCard = new Map<Card, RoleTagHit[]>();
  for (const c of deck) {
    if (seen.has(c.name)) continue;
    let hits = tagsByCard.get(c);
    if (!hits) {
      hits = getRoleTags(c);
      tagsByCard.set(c, hits);
    }
    if (hits.some((h) => wanted.has(h.tag))) seen.add(c.name);
  }
  return [...seen].sort();
}

function namesWithExactTag(deck: Card[], wanted: RoleTag): string[] {
  return namesWithAnyTag(deck, new Set([wanted]));
}

// Heuristic main-attacker filter (used when no archetype profile applies).
function looksLikeMainAttacker(c: PokemonCard): boolean {
  for (const a of c.attacks ?? []) {
    if (a.damage >= 100) return true;
    if (
      a.damageText &&
      /×|x ?\d|coin flips|each .* in your discard|each Energy/i.test(a.damageText)
    ) {
      return true;
    }
    if (
      a.text &&
      /\bfor each\b.*\b(damage|energy|prize|card)\b/i.test(a.text)
    ) {
      return true;
    }
  }
  return false;
}

// ---- Engine reachability --------------------------------------------------

// Walks evolvesFrom recursively to verify the full chain is supported by the
// rest of the deck. Stage 2 may use Rare Candy as a fallback for the missing
// Stage 1 (NOT for the missing Basic). Returns false (line broken) when any
// required step is absent.
//
// Ambiguity (multiple distinct cards share an `evolvesFrom` name) is
// resolved by a best-effort first match; callers should reduce confidence
// of any related finding when they detect ambiguity themselves via ctx.
export function engineIsReachable(
  card: PokemonCard,
  deck: Card[],
  ctx: DoctorContext,
): boolean {
  // Build name set once.
  const namesInDeck = new Set(deck.map((c) => c.name));
  const hasRareCandy = namesInDeck.has("Rare Candy");

  // Helper: walk evolvesFrom once.
  function predecessor(name: string): PokemonCard | undefined {
    const candidates = (ctx.cardsByName.get(name) ?? []).filter((c): c is PokemonCard =>
      isPokemonCard(c),
    );
    if (candidates.length === 0) return undefined;
    return candidates[0];
  }

  if (isBasicPoke(card)) return true;

  if (isStage1(card)) {
    const basic = card.evolvesFrom;
    if (!basic) return true; // malformed — be permissive
    return namesInDeck.has(basic);
  }

  if (isStage2(card)) {
    const stage1Name = card.evolvesFrom;
    if (!stage1Name) return true;
    const stage1 = predecessor(stage1Name);
    const basicName = stage1?.evolvesFrom;
    if (!basicName) return false;
    if (!namesInDeck.has(basicName)) return false;
    if (namesInDeck.has(stage1Name)) return true;
    // Rare Candy bridges Basic → Stage 2 only when the Basic is present.
    return hasRareCandy;
  }

  return true;
}

// ---- Energy plan helpers --------------------------------------------------

// Sums basic-energy supply by type.
function basicEnergySupply(deck: Card[]): Record<EnergyType, number> {
  const supply: Record<EnergyType, number> = {
    Grass: 0, Fire: 0, Water: 0, Lightning: 0, Psychic: 0,
    Fighting: 0, Darkness: 0, Metal: 0, Fairy: 0, Dragon: 0, Colorless: 0,
  };
  for (const c of deck) {
    if (!isEnergyCard(c)) continue;
    if (!c.subtypes.includes("Basic")) continue;
    for (const t of c.provides) supply[t] += 1;
  }
  return supply;
}

// Special energy supply across the whole deck — set of types provided
// (wildcards / multi-type are unioned).
function specialEnergyTypes(deck: Card[]): Set<EnergyType> {
  const out = new Set<EnergyType>();
  for (const c of deck) {
    if (!isEnergyCard(c)) continue;
    if (!c.subtypes.includes("Special")) continue;
    for (const t of c.provides) out.add(t);
  }
  return out;
}

// ---- Composition assembly -------------------------------------------------

function buildComposition(
  deck: Card[],
  archetype: { id: Archetype; confidence: Confidence },
  ctx: DoctorContext,
  suppressions: SuppressionNote[],
): DeckComposition {
  const counts = countsByName(deck);

  let pokemon = 0;
  let trainer = 0;
  let energy = 0;
  let basics = 0;
  for (const c of deck) {
    if (isPokemonCard(c)) {
      pokemon += 1;
      if ((c.subtypes ?? []).includes("Basic")) basics += 1;
    } else if (isTrainerCard(c)) {
      trainer += 1;
    } else if (isEnergyCard(c)) {
      energy += 1;
    }
  }

  // For the Composition surface, "drawEngines" only lists reachable
  // ability-driven engines; pure Supporters land in their own bucket via
  // the user-visible counts (we don't list every Iono — too noisy).
  const drawEngines: string[] = [];
  for (const c of deck) {
    if (!isPokemonCard(c)) continue;
    const tags = getRoleTags(c).map((h) => h.tag);
    if (
      (tags.includes("draw:ability") || tags.includes("search:ability")) &&
      engineIsReachable(c, deck, ctx) &&
      !drawEngines.includes(c.name)
    ) {
      drawEngines.push(c.name);
    }
  }

  // ACE SPEC / Radiant lists — derived from the resolved deck.
  const aceSpec: string[] = [];
  const tools: string[] = [];
  const stadiums: string[] = [];
  for (const c of deck) {
    if (!isTrainerCard(c)) continue;
    const subs = c.subtypes ?? [];
    if (subs.includes("ACE SPEC") && !aceSpec.includes(c.name)) aceSpec.push(c.name);
    if (isTool(c) && !tools.includes(c.name)) tools.push(c.name);
    if (isStadium(c) && !stadiums.includes(c.name)) stadiums.push(c.name);
  }

  // Profile notes + suppression summaries land in `notes` so the user
  // always sees why a scary check was silenced.
  const notes: string[] = [];
  if (archetype.id !== "generic" && ARCHETYPE_PROFILES[archetype.id]?.notes) {
    notes.push(...ARCHETYPE_PROFILES[archetype.id].notes!);
  }
  for (const s of suppressions) {
    notes.push(`Suppressed ${s.findingId}: ${s.reason}`);
  }

  // Main / support attacker classification: archetype-driven first.
  const profile =
    archetype.id !== "generic" && archetype.confidence !== "low"
      ? ARCHETYPE_PROFILES[archetype.id]
      : null;

  const allPokemonNames = [
    ...new Set(deck.filter(isPokemonCard).map((c) => c.name)),
  ].sort();

  let attackersMain: string[];
  let attackersSupport: string[];
  if (profile) {
    attackersMain = profile.mainAttackers.filter((n) => counts.has(n));
    attackersSupport = allPokemonNames.filter((n) => !attackersMain.includes(n));
  } else {
    const main = new Set<string>();
    const support = new Set<string>();
    for (const c of deck) {
      if (!isPokemonCard(c)) continue;
      if (looksLikeMainAttacker(c)) main.add(c.name);
      else if ((c.attacks ?? []).length > 0) support.add(c.name);
    }
    attackersMain = [...main].sort();
    attackersSupport = [...support]
      .filter((n) => !main.has(n))
      .sort();
  }

  return {
    pokemon,
    trainer,
    energy,
    basics,
    attackersMain,
    attackersSupport,
    drawEngines,
    searchPokemon: namesWithExactTag(deck, "search:pokemon"),
    searchTrainer: namesWithExactTag(deck, "search:trainer"),
    searchEnergy: namesWithExactTag(deck, "search:energy"),
    searchAbilities: namesWithExactTag(deck, "search:ability").filter((n) => {
      // Reachable-only — broken-line search engines don't earn credit.
      const sample = (ctx.cardsByName.get(n) ?? []).find(isPokemonCard);
      return sample ? engineIsReachable(sample, deck, ctx) : false;
    }),
    setupAbilities: namesWithExactTag(deck, "setup:ability"),
    evolutionAccelerators: namesWithExactTag(deck, "evolution:accelerator"),
    recyclers: namesWithExactTag(deck, "recycle:card"),
    gustEffects: namesWithExactTag(deck, "mobility:gust"),
    switchOrPivot: namesWithAnyTag(deck, new Set(["mobility:switch", "mobility:pivot"])),
    stadiums,
    tools,
    aceSpec,
    notes,
  };
}

// ---- Analyzer -------------------------------------------------------------

export interface AnalyzeOpts {
  disableExceptions?: boolean;
}

export function analyzeDeck(
  input: DeckInput,
  ctx: DoctorContext,
  opts: AnalyzeOpts = {},
): DeckAnalysis {
  const findings: Finding[] = [];
  const suppressions: SuppressionNote[] = [];

  // Archetype detection (used by main-attacker classification, energy plan,
  // archetype-aware findings, suppression of expected exceptions).
  const namesInDeck = new Set(input.cards.map((c) => c.name));
  const archetype = detectArchetypeFromCardNames(namesInDeck);
  const profile =
    archetype.id !== "generic" && archetype.confidence !== "low"
      ? ARCHETYPE_PROFILES[archetype.id]
      : null;

  // Helper: try to suppress a finding via the archetype's expectedExceptions.
  // Returns true if the finding should be silenced. When opts.disableExceptions
  // is set (test-only), suppression never fires.
  function maybeSuppress(id: string): boolean {
    if (opts.disableExceptions) return false;
    if (!profile?.expectedExceptions) return false;
    const exc = profile.expectedExceptions.find((e) => e.id === id);
    if (!exc) return false;
    suppressions.push({ findingId: id, reason: exc.reason });
    return true;
  }

  // Helper: emit a finding (skipping silently if suppressed).
  function emit(f: Finding): void {
    if (maybeSuppress(f.id)) return;
    findings.push(f);
  }

  const counts = countsByName(input.cards);

  // ---- Legal --------------------------------------------------------------
  for (const err of input.parseErrors ?? []) {
    emit({
      id: "legal.parse-error",
      severity: "error",
      confidence: "high",
      actionability: "high",
      scope: "deck",
      category: "Legal",
      title: "Couldn't parse a line in your decklist",
      detail: err,
    });
  }
  for (const u of input.unmatched ?? []) {
    emit({
      id: "legal.unmatched",
      severity: "error",
      confidence: "high",
      actionability: "high",
      scope: "deck",
      category: "Legal",
      title: `Couldn't resolve "${u.name}"`,
      detail: `Set ${u.limitlessSet} ${u.number} isn't in the current legal pool.`,
    });
  }
  for (const n of input.pasteNotices ?? []) {
    if (n.kind === "over-four") {
      emit({
        id: "legal.over-four-copies",
        severity: "error",
        confidence: "high",
        actionability: "high",
        scope: "card",
        category: "Legal",
        title: `Pasted ${n.pastedCount}× ${n.cardName}`,
        detail:
          "The 4-per-name rule caps non-basic-energy cards at 4 copies. Excess copies were dropped.",
        cards: [n.cardName],
        evidence: [`Pasted: ${n.pastedCount}`, "Allowed: 4"],
      });
    } else if (n.kind === "ace-spec") {
      emit({
        id: "legal.ace-spec-overage",
        severity: "error",
        confidence: "high",
        actionability: "high",
        scope: "deck",
        category: "Legal",
        title: "More than one ACE SPEC card",
        detail: "A deck may contain only 1 ACE SPEC card.",
        cards: n.cardNames,
        evidence: n.cardNames,
      });
    } else if (n.kind === "radiant") {
      emit({
        id: "legal.radiant-overage",
        severity: "error",
        confidence: "high",
        actionability: "high",
        scope: "deck",
        category: "Legal",
        title: "More than one Radiant Pokémon",
        detail: "A deck may contain only 1 Radiant Pokémon.",
        cards: n.cardNames,
        evidence: n.cardNames,
      });
    } else if (n.kind === "name-only-match") {
      const candidates = n.candidates ?? [];
      const evidence: string[] = [`Pasted: ${n.pastedEntry}`];
      if (n.resolvedTo) {
        evidence.push(
          `Resolved to: ${n.resolvedTo.name} ${n.resolvedTo.setCode} ${n.resolvedTo.number}`,
        );
      }
      if (n.ambiguous) {
        evidence.push("Multiple distinct printings share this name:");
        for (const c of candidates) {
          evidence.push(`  ${c.name} ${c.setCode} ${c.number} — ${c.signature}`);
        }
      }
      emit({
        id: "legal.name-only-match",
        severity: "warning",
        confidence: n.ambiguous ? "low" : "medium",
        actionability: n.ambiguous ? "high" : "low",
        scope: "card",
        category: "Legal",
        title: n.ambiguous
          ? `Ambiguous name match for "${n.resolvedTo?.name ?? "(unknown)"}"`
          : `Name-only match for "${n.resolvedTo?.name ?? "(unknown)"}"`,
        detail: n.ambiguous
          ? "The pasted set/number didn't match a printing in the legal pool, and the name resolves to multiple mechanically-distinct cards. Doctor may be analyzing the wrong card."
          : "The pasted set/number didn't match, but the name resolved to a unique printing. Likely fine.",
        evidence,
        fix: n.ambiguous
          ? ["Update the decklist with an exact set + number for this card."]
          : undefined,
      });
    }
  }

  if (input.cards.length !== 60) {
    emit({
      id: "legal.card-count",
      severity: "error",
      confidence: "high",
      actionability: "high",
      scope: "deck",
      category: "Legal",
      title: `Deck has ${input.cards.length} cards`,
      detail: "A legal Pokémon TCG deck has exactly 60 cards.",
      evidence: [`Current: ${input.cards.length}`, "Required: 60"],
    });
  }
  const basicCount = input.cards.filter(isBasicPoke).length;
  if (basicCount === 0) {
    emit({
      id: "legal.no-basic",
      severity: "error",
      confidence: "high",
      actionability: "high",
      scope: "deck",
      category: "Legal",
      title: "No Basic Pokémon",
      detail: "A deck must contain at least 1 Basic Pokémon to start a game.",
    });
  }

  // ---- Consistency --------------------------------------------------------
  // Collect tag presence (counts of unique-name cards).
  const drawSupporters = namesWithExactTag(input.cards, "draw:supporter");
  const drawAbilityNames = namesWithExactTag(input.cards, "draw:ability").filter((n) => {
    const sample = (ctx.cardsByName.get(n) ?? []).find(isPokemonCard);
    return sample ? engineIsReachable(sample, input.cards, ctx) : false;
  });
  const searchAbilityNames = namesWithExactTag(input.cards, "search:ability").filter((n) => {
    const sample = (ctx.cardsByName.get(n) ?? []).find(isPokemonCard);
    return sample ? engineIsReachable(sample, input.cards, ctx) : false;
  });
  const searchPokemonNames = namesWithExactTag(input.cards, "search:pokemon");
  const evolutionAccelerators = namesWithExactTag(input.cards, "evolution:accelerator");

  const drawSupporterCount = drawSupporters
    .map((n) => counts.get(n) ?? 0)
    .reduce((a, b) => a + b, 0);

  if (
    drawSupporters.length === 0 &&
    drawAbilityNames.length === 0 &&
    searchAbilityNames.length === 0
  ) {
    emit({
      id: "consistency.no-engine",
      severity: "error",
      confidence: "high",
      actionability: "high",
      scope: "deck",
      category: "Consistency",
      title: "No draw or search engine",
      detail:
        "No draw Supporter, draw-ability Pokémon, or search-ability Pokémon is present (or the line for one is broken). The deck cannot reliably refill its hand.",
      fix: [
        "Add 4 Iono / Professor's Research style Supporters,",
        "or run a draw-ability Pokémon (Bibarel, Dudunsparce) with its Basic,",
        "or run a search-ability Pokémon (Pidgeot ex) with a complete evolution line.",
      ],
    });
  } else if (
    drawSupporterCount < 4 &&
    drawAbilityNames.length === 0 &&
    searchAbilityNames.length === 0
  ) {
    emit({
      id: "consistency.thin-draw",
      severity: "warning",
      confidence: "high",
      actionability: "medium",
      scope: "deck",
      category: "Consistency",
      title: `Thin draw — ${drawSupporterCount} Supporter copies`,
      detail:
        "Most decks run 6–10 draw Supporter copies; with a draw-ability Pokémon (Bibarel, Dudunsparce) or a search-ability Pokémon (Pidgeot ex) this is fine.",
      evidence: [`Supporters: ${drawSupporterCount}`, "Recommended: 6+"],
      cards: drawSupporters,
    });
  }

  if (searchPokemonNames.length === 0) {
    emit({
      id: "consistency.no-search",
      severity: "warning",
      confidence: "high",
      actionability: "medium",
      scope: "deck",
      category: "Consistency",
      title: "No Pokémon search items",
      detail:
        "Pokémon search items (Ultra Ball, Nest Ball, Quick Ball, Buddy-Buddy Poffin) reduce mulligan risk and accelerate setup.",
    });
  }

  const hasStage2 = input.cards.some(isStage2);
  if (
    hasStage2 &&
    evolutionAccelerators.length === 0 &&
    searchPokemonNames.length === 0 &&
    searchAbilityNames.length === 0
  ) {
    emit({
      id: "consistency.no-evo-search",
      severity: "suggestion",
      confidence: "medium",
      actionability: "medium",
      scope: "deck",
      category: "Consistency",
      title: "Stage 2 line without evolution support",
      detail:
        "Stage 2 lines benefit from Rare Candy, Pokémon search items, or a search-ability Pokémon to assemble the line on time.",
    });
  }

  // ---- Probability --------------------------------------------------------
  const deckSize = input.cards.length;
  if (deckSize > 0) {
    const mulligan = hypergeometric({
      deckSize,
      successes: basicCount,
      draws: 7,
      want: 0,
    });
    const mulPct = (mulligan * 100).toFixed(1);
    // Thresholds calibrated against real competitive decks: ~10 Basics is
    // a common low-end lead count and produces ~25% mulligan, which is
    // unfortunate but not "broken." We only error when basics are dangerously
    // low (>30%, basically <8 Basics).
    let mulSeverity: Severity | null = null;
    if (mulligan > 0.30) mulSeverity = "error";
    else if (mulligan > 0.20) mulSeverity = "warning";
    else if (mulligan > 0.08) mulSeverity = "suggestion";
    if (mulSeverity) {
      emit({
        id: "prob.mulligan-rate",
        severity: mulSeverity,
        confidence: "high",
        actionability: mulSeverity === "error" ? "high" : "medium",
        scope: "deck",
        category: "Probability",
        title: `Mulligan rate ≈ ${mulPct}%`,
        detail: `P(0 Basics in opening 7) with ${basicCount} Basics in a ${deckSize}-card deck.`,
        evidence: [`Basics: ${basicCount}`, `Mulligan: ${mulPct}%`],
      });
    }

    const t1Basic2 = oddsAtLeast(deckSize, basicCount, 7, 2);
    if (t1Basic2 < 0.6) {
      emit({
        id: "prob.t1-basic-coverage",
        severity: "suggestion",
        confidence: "medium",
        actionability: "medium",
        scope: "deck",
        category: "Probability",
        title: `Raw T1 Basic coverage ≈ ${(t1Basic2 * 100).toFixed(1)}%`,
        detail:
          "Raw unassisted odds — search items can recover from low rolls. P(≥2 Basics in opening 7).",
      });
    }

    const searchPokemonCount = searchPokemonNames
      .map((n) => counts.get(n) ?? 0)
      .reduce((a, b) => a + b, 0);
    const t1Search = oddsAtLeast(deckSize, searchPokemonCount, 7, 1);
    if (t1Search < 0.7 && searchPokemonCount > 0) {
      emit({
        id: "prob.t1-search-coverage",
        severity: "suggestion",
        confidence: "medium",
        actionability: "medium",
        scope: "deck",
        category: "Probability",
        title: `Raw T1 search coverage ≈ ${(t1Search * 100).toFixed(1)}%`,
        detail: "Raw unassisted odds — P(≥1 Pokémon search item in opening 7).",
      });
    }

    // Raw energy opening — for the deck's primary attacker, P(≥1 matching
    // basic energy in opening 8). Skip if no main attacker can be identified.
    const composition = buildComposition(input.cards, archetype, ctx, []);
    const primaryName = composition.attackersMain[0];
    const primaryCard =
      primaryName && (ctx.cardsByName.get(primaryName) ?? []).find(isPokemonCard);
    if (primaryCard) {
      const preferredAttackName =
        profile?.preferredAttacks?.[primaryCard.name]?.[0];
      const attack =
        primaryCard.attacks.find((a) => a.name === preferredAttackName) ??
        primaryCard.attacks
          .slice()
          .sort((a, b) => b.cost.length - a.cost.length)[0];
      if (attack) {
        const requiredTypes = attack.cost.filter((t) => t !== "Colorless");
        if (requiredTypes.length > 0) {
          const supply = basicEnergySupply(input.cards);
          const matching = requiredTypes.reduce((acc, t) => acc + supply[t], 0);
          const odds = oddsAtLeast(deckSize, matching, 8, 1);
          const evidence: string[] = [
            `Primary attacker: ${primaryCard.name} (${attack.name}, cost ${attack.cost.join("/")})`,
            `Matching basic energy: ${matching}`,
          ];
          if (composition.searchEnergy.length > 0) {
            evidence.push(`Energy search: ${composition.searchEnergy.join(", ")}`);
          }
          if (profile?.energyPlan?.acceleration?.length) {
            const present = profile.energyPlan.acceleration.filter((n) => counts.has(n));
            if (present.length > 0) {
              evidence.push(`Acceleration in deck: ${present.join(", ")}`);
            }
          }
          if (odds < 0.7) {
            emit({
              id: "prob.raw-energy-opening",
              severity: "warning",
              confidence: "medium",
              actionability: "medium",
              scope: "deck",
              category: "Probability",
              title: `Raw Energy Opening ≈ ${(odds * 100).toFixed(1)}%`,
              detail:
                "Raw odds; ignores Earthen Vessel, search effects, and acceleration.",
              evidence,
            });
          }
        }
      }
    }
  }

  // ---- Energy -------------------------------------------------------------
  const totalEnergy = input.cards.filter(isEnergyCard).length;
  if (totalEnergy === 0 && input.cards.length > 0) {
    emit({
      id: "energy.thin-supply",
      severity: "warning",
      confidence: "high",
      actionability: "high",
      scope: "deck",
      category: "Energy",
      title: "No Energy cards",
      detail: "The deck contains 0 Energy cards.",
    });
  } else if (totalEnergy > 0 && totalEnergy < 6) {
    const profileSays = profile?.energyPlan?.manualEnergyIsThinOk;
    const accelerators = profile?.energyPlan?.acceleration ?? [];
    const acceleratorPresent = accelerators.some((n) => counts.has(n));
    const accelOk = accelerators.length === 0 || acceleratorPresent;
    if (profileSays && accelOk) {
      suppressions.push({
        findingId: "energy.thin-supply",
        reason: `${profile?.id ?? "Archetype"} expects thin manual Energy (acceleration / engine compensates).`,
      });
    } else {
      const evidence: string[] = [`Energy cards: ${totalEnergy}`];
      if (profileSays && !acceleratorPresent && accelerators.length > 0) {
        evidence.push(
          `Profile would have suppressed this if any of [${accelerators.join(", ")}] were in the deck (none are).`,
        );
      }
      emit({
        id: "energy.thin-supply",
        severity: "warning",
        confidence: profileSays ? "medium" : "high",
        actionability: "medium",
        scope: "deck",
        category: "Energy",
        title: `Only ${totalEnergy} Energy cards`,
        detail:
          "Most decks run 6+ Energy cards (or rely on a profile-specified acceleration plan).",
        evidence,
      });
    }
  }

  // Energy: attacker payment path check.
  // Pull main attackers (post-archetype-override) from a dry composition pass.
  const compositionForEnergy = buildComposition(input.cards, archetype, ctx, []);
  const basicSupply = basicEnergySupply(input.cards);
  const specialTypes = specialEnergyTypes(input.cards);
  for (const name of compositionForEnergy.attackersMain) {
    const attacker = (ctx.cardsByName.get(name) ?? []).find(isPokemonCard);
    if (!attacker) continue;
    const preferredAttackName = profile?.preferredAttacks?.[name]?.[0];
    const attack =
      attacker.attacks.find((a) => a.name === preferredAttackName) ??
      attacker.attacks
        .slice()
        .sort((a, b) => b.cost.length - a.cost.length)[0];
    if (!attack) continue;
    const requiredTypes = attack.cost.filter((t) => t !== "Colorless");
    if (requiredTypes.length === 0) continue;

    const missingTypes = requiredTypes.filter(
      (t) => basicSupply[t] === 0 && !specialTypes.has(t),
    );
    if (missingTypes.length === 0) continue;

    const accelerators = profile?.energyPlan?.acceleration ?? [];
    const acceleratorsPresent = accelerators.filter((n) => counts.has(n));
    const wouldSuppress = profile?.energyPlan?.acceleration?.length
      ? acceleratorsPresent.length > 0 &&
        // Acceleration must cover at least one missing type. Profile lists
        // the requiredTypes for the plan; if any missing type is in that
        // requiredTypes set we assume the accelerator covers it.
        missingTypes.some((t) => profile.energyPlan!.requiredTypes.includes(t))
      : false;

    if (wouldSuppress) {
      suppressions.push({
        findingId: "energy.attacker-cant-be-paid",
        reason: `Profile expects acceleration: ${acceleratorsPresent.join(", ")}.`,
      });
      continue;
    }

    const evidence: string[] = [
      `${name} (${attack.name}) requires: ${requiredTypes.join(", ")}`,
      `Missing types: ${missingTypes.join(", ")}`,
    ];
    if (accelerators.length > 0 && acceleratorsPresent.length === 0) {
      evidence.push(
        `Profile expected acceleration not present in the deck: ${accelerators.join(", ")}.`,
      );
    }
    emit({
      id: "energy.attacker-cant-be-paid",
      severity: "error",
      confidence: accelerators.length > 0 ? "medium" : "high",
      actionability: "high",
      scope: "card",
      category: "Energy",
      title: `${name} can't pay ${attack.name}`,
      detail:
        "No matching basic energy or special energy provides the required type, and no archetype acceleration is in the deck.",
      cards: [name],
      evidence,
    });
  }

  // ---- Mobility -----------------------------------------------------------
  // Average retreat across main attackers; flag if no switch / pivot.
  const mainAttackerCards = compositionForEnergy.attackersMain
    .map((n) => (ctx.cardsByName.get(n) ?? []).find(isPokemonCard))
    .filter((c): c is PokemonCard => !!c);
  if (mainAttackerCards.length > 0) {
    const meanRetreat =
      mainAttackerCards.reduce((acc, c) => acc + (c.retreatCost?.length ?? 0), 0) /
      mainAttackerCards.length;
    const switchCount = compositionForEnergy.switchOrPivot.length;
    if (meanRetreat > 2.0 && switchCount === 0) {
      emit({
        id: "mobility.no-switch",
        severity: "warning",
        confidence: "high",
        actionability: "high",
        scope: "deck",
        category: "Mobility",
        title: "Heavy retreat costs without Switch / pivot",
        detail:
          "Main attackers average over 2 retreat with no Switch, Switch Cart, or pivot Pokémon. Stuck attackers will lose tempo.",
        evidence: [
          `Mean retreat: ${meanRetreat.toFixed(1)}`,
          "Switch / pivot cards: 0",
        ],
      });
    }
  }
  if (compositionForEnergy.gustEffects.length === 0) {
    emit({
      id: "mobility.no-gust",
      severity: "suggestion",
      confidence: "high",
      actionability: "medium",
      scope: "deck",
      category: "Mobility",
      title: "No gust effects (Boss's Orders / Counter Catcher)",
      detail:
        "Gust effects bypass tanky Active Pokémon and finish weakened benched threats. Most competitive decks run at least 2.",
    });
  }

  // ---- Stage lines --------------------------------------------------------
  if (hasStage2) {
    if (!counts.has("Rare Candy")) {
      emit({
        id: "stage.no-rare-candy",
        severity: "warning",
        confidence: "high",
      actionability: "medium",
        scope: "line",
        category: "Stage lines",
        title: "Stage 2 line without Rare Candy",
        detail:
          "Without Rare Candy you must evolve through the Stage 1 every game — slower and more vulnerable to disruption.",
      });
    }
  }
  // Broken-chain check (Stage 1 / Stage 2). Match by name.
  const seenLineKeys = new Set<string>();
  for (const c of input.cards) {
    if (!isPokemonCard(c)) continue;
    if (!isStage1(c) && !isStage2(c)) continue;
    if (seenLineKeys.has(c.name)) continue;
    seenLineKeys.add(c.name);
    if (engineIsReachable(c, input.cards, ctx)) continue;
    // Resolve descriptive evidence (which step is missing).
    let evidence: string[] = [];
    if (isStage1(c)) {
      evidence = [`${c.name} evolves from ${c.evolvesFrom ?? "?"} — missing.`];
    } else {
      const stage1Name = c.evolvesFrom ?? "";
      const sample = (ctx.cardsByName.get(stage1Name) ?? []).find(isPokemonCard);
      const basicName = sample?.evolvesFrom ?? "";
      const haveBasic = counts.has(basicName);
      const haveStage1 = counts.has(stage1Name);
      const haveCandy = counts.has("Rare Candy");
      if (!haveBasic) {
        evidence.push(`Missing Basic: ${basicName || "(unknown)"}`);
      } else if (!haveStage1 && !haveCandy) {
        evidence.push(
          `Missing Stage 1: ${stage1Name} — and no Rare Candy fallback.`,
        );
      } else {
        evidence.push("Chain incomplete.");
      }
    }
    emit({
      id: "stage.broken-chain",
      severity: "error",
      confidence: "high",
      actionability: "high",
      scope: "line",
      category: "Stage lines",
      title: `${c.name}'s evolution line is broken`,
      detail:
        "An evolution Pokémon needs its earlier stages in the deck (Stage 2 may use Rare Candy as a Stage 1 fallback only).",
      cards: [c.name],
      evidence,
    });
  }

  // ---- Archetype ----------------------------------------------------------
  if (profile && archetype.confidence !== "low") {
    for (const name of profile.core) {
      if (!counts.has(name)) {
        emit({
          id: "archetype.missing-core",
          severity: "warning",
          confidence: "high",
          actionability: "high",
          scope: "archetype",
          category: "Archetype",
          title: `Missing ${archetype.id} core: ${name}`,
          detail: `${name} is a core card for the ${archetype.id} archetype.`,
          cards: [name],
        });
      }
    }
    let missingSupportShown = 0;
    for (const name of profile.support) {
      if (counts.has(name)) continue;
      if (missingSupportShown >= 3) break;
      emit({
        id: "archetype.missing-support",
        severity: "suggestion",
        confidence: "high",
      actionability: "medium",
        scope: "archetype",
        category: "Archetype",
        title: `Could add: ${name}`,
        detail: `${name} is a typical support pillar for the ${archetype.id} archetype.`,
        cards: [name],
      });
      missingSupportShown += 1;
    }
  }

  // ---- Compose final report ------------------------------------------------
  const composition = buildComposition(input.cards, archetype, ctx, suppressions);

  // priorities = top 3 by (severity, actionability, confidence) where
  // error > warning > suggestion, high > medium > low.
  const priorityRank = (f: Finding): number => {
    const sev = f.severity === "error" ? 3 : f.severity === "warning" ? 2 : 1;
    const act = f.actionability === "high" ? 3 : f.actionability === "medium" ? 2 : 1;
    const conf = f.confidence === "high" ? 3 : f.confidence === "medium" ? 2 : 1;
    return sev * 100 + act * 10 + conf;
  };
  const priorities = [...findings]
    .sort((a, b) => priorityRank(b) - priorityRank(a))
    .slice(0, 3);

  const ok = !findings.some((f) => f.severity === "error");
  const noMajorIssues =
    ok && !findings.some((f) => f.severity === "warning");

  return {
    source: { kind: input.source, name: input.sourceName },
    archetype,
    composition,
    findings,
    priorities,
    suppressions,
    ok,
    noMajorIssues,
  };
}

// ---- Compose / serialize report ------------------------------------------

export const DOCTOR_VERSION = 1;

export function composeReport(a: DeckAnalysis, meta: ReportMeta): DoctorReport {
  return { ...a, meta };
}

const SCOPE_DISCLAIMER =
  "Structural review only — not a meta or matchup grade.";

// Optional Meta-section payload — kept loosely typed at the deckDoctor.ts
// boundary so the serializer doesn't need to import metaDoctor's types
// directly (metaDoctor depends on this module). The shape MUST match
// MetaAnalysis from metaDoctor.ts.
export interface SerializedMetaSection {
  metaGrade: "A" | "B" | "C" | "D" | "insufficient-data";
  matchupGrade?: "favored" | "even" | "unfavored" | "unknown";
  matchupGradeAgainst?: string;
  expectedWinRate?: number;
  expectedWinRateRange?: { low: number; high: number };
  metaConfidence?: string;
  fieldCoverage?: number;
  topMatchups?: { hero: string; villain: string; winRate: number; ci95Low: number; ci95High: number }[];
  worstMatchups?: { hero: string; villain: string; winRate: number; ci95Low: number; ci95High: number }[];
  stockMissingCore?: string[];
  techMissingClasses?: string[];
  snapshot?: { id: string; coversThrough: string; dataAgeDays: number; quality: string };
}

export function serializeDoctorReport(
  report: DoctorReport,
  meta?: SerializedMetaSection,
): string {
  const out: string[] = [];
  out.push(SCOPE_DISCLAIMER);
  out.push("");
  out.push(`Deck Doctor — ${report.source.name ?? "(unnamed)"}`);
  out.push(`Source: ${report.source.kind}`);
  out.push(
    `Archetype: ${report.archetype.id} (${report.archetype.confidence} confidence)`,
  );
  out.push(`Generated: ${report.meta.generatedAt}`);
  out.push(`Dataset: ${report.meta.datasetAsOf}`);
  out.push(`Doctor version: ${report.meta.doctorVersion}`);
  out.push("");
  out.push("Composition");
  out.push("-----------");
  const c = report.composition;
  out.push(
    `Pokémon ${c.pokemon} · Trainer ${c.trainer} · Energy ${c.energy} · Basics ${c.basics}`,
  );
  if (c.attackersMain.length) out.push(`Main attackers: ${c.attackersMain.join(", ")}`);
  if (c.drawEngines.length) out.push(`Draw / search engines: ${c.drawEngines.join(", ")}`);
  if (c.searchPokemon.length) out.push(`Search items: ${c.searchPokemon.join(", ")}`);
  if (c.gustEffects.length) out.push(`Gust: ${c.gustEffects.join(", ")}`);
  if (c.switchOrPivot.length) out.push(`Switch / pivot: ${c.switchOrPivot.join(", ")}`);
  if (c.stadiums.length) out.push(`Stadiums: ${c.stadiums.join(", ")}`);
  if (c.tools.length) out.push(`Tools: ${c.tools.join(", ")}`);
  if (c.aceSpec.length) out.push(`ACE SPEC: ${c.aceSpec.join(", ")}`);
  for (const note of c.notes) out.push(`Note: ${note}`);

  const sections: Array<{ label: string; sev: Severity }> = [
    { label: "Problems", sev: "error" },
    { label: "Risks", sev: "warning" },
    { label: "Suggestions", sev: "suggestion" },
  ];
  for (const { label, sev } of sections) {
    const items = report.findings.filter((f) => f.severity === sev);
    // Copy excludes low-confidence / low-actionability suggestions to keep the
    // shared text focused on actionable feedback. Errors and warnings always
    // ship; suggestions only ship if their actionability is high.
    const filtered =
      sev === "suggestion"
        ? items.filter((f) => f.actionability === "high")
        : items;
    if (filtered.length === 0) continue;
    out.push("");
    out.push(`${label} (${filtered.length})`);
    out.push("-".repeat(label.length + 4));
    for (const f of filtered) {
      out.push(`• ${f.title} [${f.id}]`);
      out.push(`  ${f.detail}`);
      if (f.evidence?.length) {
        for (const e of f.evidence) out.push(`  - ${e}`);
      }
      if (f.fix?.length) {
        out.push("  Fix:");
        for (const fix of f.fix) out.push(`    ${fix}`);
      }
    }
  }

  if (meta) {
    out.push("");
    out.push("Meta");
    out.push("----");
    out.push(
      "This grade reflects the archetype into the field. List-specific feedback is above.",
    );
    if (meta.snapshot) {
      out.push(
        `Snapshot: ${meta.snapshot.id} · covers through ${meta.snapshot.coversThrough} (${meta.snapshot.dataAgeDays} days old, ${meta.snapshot.quality})`,
      );
    }
    out.push(`Meta grade: ${meta.metaGrade}`);
    if (meta.expectedWinRate !== undefined) {
      const pct = (meta.expectedWinRate * 100).toFixed(1);
      const range = meta.expectedWinRateRange
        ? ` (weighted range ${(meta.expectedWinRateRange.low * 100).toFixed(0)}–${(meta.expectedWinRateRange.high * 100).toFixed(0)}%)`
        : "";
      out.push(`Expected WR: ${pct}%${range}`);
    }
    if (meta.metaConfidence) out.push(`Confidence: ${meta.metaConfidence}`);
    if (meta.fieldCoverage !== undefined)
      out.push(`Field coverage: ${(meta.fieldCoverage * 100).toFixed(0)}%`);
    if (meta.matchupGradeAgainst) {
      out.push(
        `Matchup vs ${meta.matchupGradeAgainst}: ${meta.matchupGrade ?? "unknown"}`,
      );
    }
    if (meta.topMatchups?.length) {
      out.push("Favored matchups:");
      for (const m of meta.topMatchups) {
        out.push(
          `  ${m.villain} — ${(m.winRate * 100).toFixed(0)}% (95% CI: ${(m.ci95Low * 100).toFixed(0)}–${(m.ci95High * 100).toFixed(0)}%)`,
        );
      }
    }
    if (meta.worstMatchups?.length) {
      out.push("Tough matchups:");
      for (const m of meta.worstMatchups) {
        out.push(
          `  ${m.villain} — ${(m.winRate * 100).toFixed(0)}% (95% CI: ${(m.ci95Low * 100).toFixed(0)}–${(m.ci95High * 100).toFixed(0)}%)`,
        );
      }
    }
    if (meta.stockMissingCore?.length) {
      out.push("Missing stock cards:");
      for (const n of meta.stockMissingCore) out.push(`  - ${n}`);
    }
    if (meta.techMissingClasses?.length) {
      out.push("Missing tech answer-classes:");
      for (const n of meta.techMissingClasses) out.push(`  - ${n}`);
    }
  }

  return out.join("\n");
}
