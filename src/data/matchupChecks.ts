// Static matchup checks. "Static" = card-vs-card damage / weakness / prize
// math with NO GameState — uses raw card fields. Honest about what it
// ignores: Tools, Stadiums, abilities, conditional damage, energy
// acceleration, sequencing. Every finding's `detail` carries that caveat
// inline so it can never be quoted out of context.
//
// True simulation is deferred to a future phase that needs an engine-backed
// harness.

import type { Card, PokemonCard } from "../engine/types";
import { prizeValue } from "../engine/rules";
import { ARCHETYPE_PROFILES, type Archetype } from "../engine/aiArchetype";
import { getRoleTags } from "./cardRoles";
import type { DoctorContext } from "./deckDoctor";
import type { StockListEntry, ThreatClass } from "./metaSnapshot";

export interface MatchupCheck {
  id: string;
  severity: "error" | "warning" | "suggestion" | "info";
  title: string;
  detail: string;
  evidence?: string[];
}

export type DamageConfidence = "exact" | "parsed" | "unknown";

const STATIC_DISCLAIMER =
  "Static estimate — ignores Tools, Stadiums, abilities, conditional damage, energy acceleration, and sequencing.";

// ---- Damage parsing -------------------------------------------------------

interface ParsedDamage {
  base: number;
  confidence: DamageConfidence;
}

function parseAttackDamage(c: PokemonCard, attackName?: string): ParsedDamage | null {
  const attacks = c.attacks ?? [];
  // Pick the preferred attack first if specified.
  const named = attackName
    ? attacks.find((a) => a.name === attackName)
    : undefined;
  // Fallback: most-expensive attack with a positive damage.
  const fallback = attacks
    .slice()
    .sort((a, b) => b.cost.length - a.cost.length)[0];
  const a = named ?? fallback;
  if (!a) return null;

  // Exact: integer damage with no scaling text.
  if (typeof a.damage === "number" && a.damage > 0 && !a.damageText) {
    return { base: a.damage, confidence: "exact" };
  }
  // Parsed: damageText contains "+" / "×" / "x" suffix.
  if (a.damageText) {
    const m = a.damageText.match(/^(\d+)/);
    if (m) {
      return { base: parseInt(m[1], 10), confidence: "parsed" };
    }
  }
  // Numeric damage with damageText that didn't parse — treat as parsed.
  if (typeof a.damage === "number" && a.damage > 0) {
    return { base: a.damage, confidence: "parsed" };
  }
  // Effect-driven (damage counters, KO clauses, etc.) — confidence unknown.
  return { base: 0, confidence: "unknown" };
}

// ---- Effective damage with weakness/resistance ----------------------------

function effectiveDamage(
  attacker: PokemonCard,
  defender: PokemonCard,
  base: number,
): number {
  const atkType = attacker.types?.[0];
  if (!atkType) return base;
  const weak = (defender.weaknesses ?? []).find((w) => w.type === atkType);
  const resist = (defender.resistances ?? []).find((r) => r.type === atkType);
  let dmg = base;
  if (weak) {
    // Weakness multiplier in current standard is ×2.
    dmg = dmg * 2;
  }
  if (resist) {
    // Resistance is "-30" / "-20" — parse the integer.
    const m = resist.value.match(/-(\d+)/);
    if (m) dmg = Math.max(0, dmg - parseInt(m[1], 10));
  }
  return dmg;
}

function koTier(damage: number, hp: number): "OHKO" | "2HKO" | "3HKO+" {
  if (damage >= hp) return "OHKO";
  if (damage * 2 >= hp) return "2HKO";
  return "3HKO+";
}

function isExAttacker(c: PokemonCard): boolean {
  const subs = c.subtypes ?? [];
  return subs.some((s) => /^(ex|V|VMAX|VSTAR)$/i.test(s)) || subs.includes("Mega");
}

// ---- Prize race board model -----------------------------------------------

interface BoardModel {
  attacker: PokemonCard;
  bench: PokemonCard[];
  source: "stock" | "fallback";
}

function buildBoardFromStock(
  archetype: Archetype | "unknown",
  mainAttackers: PokemonCard[],
  ctx: DoctorContext,
  stockLists: StockListEntry[] = [],
): BoardModel {
  const stock = stockLists.find((s) => s.archetype === archetype);
  const bench: PokemonCard[] = [];
  if (stock && stock.decksObserved >= 5) {
    // Pick top 2 Pokémon by inclusion rate (role core/common).
    const candidates = stock.cards
      .filter((c) => c.role === "core" || c.role === "common")
      .sort((a, b) => b.inclusionRate - a.inclusionRate);
    for (const cand of candidates) {
      if (bench.length >= 2) break;
      const resolved = (ctx.cardsByName.get(cand.cardName) ?? []).find(
        (c): c is PokemonCard => c.supertype === "Pokémon",
      );
      if (
        resolved &&
        resolved.name !== mainAttackers[0]?.name
      ) {
        bench.push(resolved);
      }
    }
    return {
      attacker: mainAttackers[0],
      bench,
      source: "stock",
    };
  }
  // Fallback: just the main attacker. We omit bench completely; the prize
  // race finding then notes the limited model.
  return {
    attacker: mainAttackers[0],
    bench: [],
    source: "fallback",
  };
}

function modelPrizeCost(model: BoardModel): number {
  let total = prizeValue(model.attacker);
  for (const b of model.bench) total += prizeValue(b);
  return total;
}

// ---- Tech coverage -------------------------------------------------------

function countTagInDeck(deck: Card[], tag: string): number {
  // Returns total card copies whose role tags include `tag`.
  let n = 0;
  for (const c of deck) {
    const tags = getRoleTags(c).map((h) => h.tag);
    if (tags.includes(tag as never)) n += 1;
  }
  return n;
}

function countNameInDeck(deck: Card[], name: string): number {
  return deck.filter((c) => c.name === name).length;
}

function threatClassCovered(deck: Card[], cls: ThreatClass): boolean {
  const need = cls.minCopies ?? 1;
  for (const tag of cls.answerTags ?? []) {
    if (countTagInDeck(deck, tag) >= need) return true;
  }
  for (const name of cls.answerCardNames ?? []) {
    if (countNameInDeck(deck, name) >= need) return true;
  }
  return false;
}

// ---- Main entry -----------------------------------------------------------

export interface RunStaticChecksInput {
  user: { mainAttackers: PokemonCard[]; deckCards: Card[]; archetype: Archetype | "generic" };
  opponent: { mainAttackers: PokemonCard[]; archetype: Archetype | "unknown" };
  stockLists?: StockListEntry[];
  techCoverageForOpp?: ThreatClass[];
}

export function runStaticMatchupChecks(
  input: RunStaticChecksInput,
  ctx: DoctorContext,
): MatchupCheck[] {
  const out: MatchupCheck[] = [];
  const { user, opponent } = input;
  const userMain = user.mainAttackers[0];
  const oppMain = opponent.mainAttackers[0];

  // ---- 1) Weakness exposure (user weak to opp's main type) ---------------
  if (userMain && oppMain) {
    const oppType = oppMain.types?.[0];
    const userWeak = (userMain.weaknesses ?? []).some((w) => w.type === oppType);
    if (userWeak) {
      const isEx = isExAttacker(userMain);
      out.push({
        id: "matchup.weakness-exposure",
        severity: isEx ? "error" : "warning",
        title: `${userMain.name} is weak to ${oppType}`,
        detail: `${STATIC_DISCLAIMER} Your main attacker takes ×2 damage from ${oppMain.name}'s ${oppType} attacks.`,
        evidence: [`Weakness: ${oppType}`, `Opp lead type: ${oppMain.name}`],
      });
    }
  }

  // ---- 2) Reverse weakness (user targets opp's weakness) -----------------
  if (userMain && oppMain) {
    const userType = userMain.types?.[0];
    const oppWeak = (oppMain.weaknesses ?? []).some((w) => w.type === userType);
    if (oppWeak) {
      out.push({
        id: "matchup.reverse-weakness",
        severity: "info",
        title: `${oppMain.name} is weak to your ${userType}`,
        detail: `${STATIC_DISCLAIMER} Your main attacker hits the opponent's main attacker for ×2 damage.`,
        evidence: [`Your type: ${userType}`, `Their weakness: ${userType}`],
      });
    }
  }

  // ---- 3 & 4) OHKO threshold (both directions) --------------------------
  if (userMain && oppMain) {
    const profile = ARCHETYPE_PROFILES[user.archetype as Exclude<Archetype, "generic">];
    const userPreferred = profile?.preferredAttacks?.[userMain.name]?.[0];
    const userParsed = parseAttackDamage(userMain, userPreferred);
    const oppParsed = parseAttackDamage(oppMain);

    if (userParsed && userParsed.confidence !== "unknown") {
      const dmg = effectiveDamage(userMain, oppMain, userParsed.base);
      const tier = koTier(dmg, oppMain.hp);
      const caveat =
        userParsed.confidence === "parsed"
          ? " Parsed damage may understate scaling/conditional bonuses."
          : "";
      out.push({
        id: `matchup.user-${tier.toLowerCase()}`,
        severity: tier === "3HKO+" ? "warning" : "info",
        title: `${userMain.name} → ${oppMain.name}: ${tier}`,
        detail: `${STATIC_DISCLAIMER}${caveat} Static estimate: ${dmg} damage vs ${oppMain.hp} HP.`,
        evidence: [`Damage: ${dmg}`, `HP: ${oppMain.hp}`, `Confidence: ${userParsed.confidence}`],
      });
    } else if (userParsed) {
      out.push({
        id: "matchup.user-damage-unknown",
        severity: "info",
        title: `${userMain.name}'s damage is effect-driven`,
        detail: `${STATIC_DISCLAIMER} Couldn't statically estimate damage (effect-based attack).`,
      });
    }

    if (oppParsed && oppParsed.confidence !== "unknown") {
      const dmg = effectiveDamage(oppMain, userMain, oppParsed.base);
      const tier = koTier(dmg, userMain.hp);
      const userTier =
        userParsed && userParsed.confidence === "exact"
          ? koTier(effectiveDamage(userMain, oppMain, userParsed.base), oppMain.hp)
          : null;
      const caveat =
        oppParsed.confidence === "parsed"
          ? " Parsed damage may understate scaling/conditional bonuses."
          : "";
      // Error only when both sides have exact damage and opp OHKOs while user can't.
      const sev: MatchupCheck["severity"] =
        tier === "OHKO" &&
        userTier &&
        userTier !== "OHKO" &&
        userParsed?.confidence === "exact" &&
        oppParsed.confidence === "exact"
          ? "error"
          : tier === "OHKO"
            ? "warning"
            : "info";
      out.push({
        id: `matchup.opp-${tier.toLowerCase()}`,
        severity: sev,
        title: `${oppMain.name} → ${userMain.name}: ${tier}`,
        detail: `${STATIC_DISCLAIMER}${caveat} Static estimate: ${dmg} damage vs ${userMain.hp} HP.`,
        evidence: [`Damage: ${dmg}`, `HP: ${userMain.hp}`, `Confidence: ${oppParsed.confidence}`],
      });
    }
  }

  // ---- 5) Prize race -----------------------------------------------------
  if (userMain && oppMain) {
    const userBoard = buildBoardFromStock(
      user.archetype as Archetype | "unknown",
      user.mainAttackers,
      ctx,
      input.stockLists,
    );
    const oppBoard = buildBoardFromStock(
      opponent.archetype,
      opponent.mainAttackers,
      ctx,
      input.stockLists,
    );
    const userPrizes = modelPrizeCost(userBoard);
    const oppPrizes = modelPrizeCost(oppBoard);
    const fallback =
      userBoard.source === "fallback" || oppBoard.source === "fallback";
    const sev: MatchupCheck["severity"] =
      userPrizes - oppPrizes >= 3 ? "warning" : "info";
    const evidence: string[] = [
      `Your modeled board: ${userBoard.attacker.name}${userBoard.bench.length ? " + " + userBoard.bench.map((b) => b.name).join(", ") : ""} (${userPrizes} prizes given)`,
      `Their modeled board: ${oppBoard.attacker.name}${oppBoard.bench.length ? " + " + oppBoard.bench.map((b) => b.name).join(", ") : ""} (${oppPrizes} prizes given)`,
    ];
    if (fallback) {
      evidence.push(
        "Fallback board model used — stock-list data is too thin to pick a representative bench.",
      );
    }
    out.push({
      id: "matchup.prize-race",
      severity: sev,
      title: `Prize race: you ${userPrizes} · opp ${oppPrizes}`,
      detail: `${STATIC_DISCLAIMER} Ignores prize-trade sequencing and gust priority.`,
      evidence,
    });
  }

  // ---- 6) Tech coverage --------------------------------------------------
  for (const cls of input.techCoverageForOpp ?? []) {
    if (threatClassCovered(user.deckCards, cls)) continue;
    out.push({
      id: "matchup.tech-coverage-missing",
      severity: "suggestion",
      title: `Missing answer: ${cls.threat}`,
      detail: `${STATIC_DISCLAIMER} ${opponent.archetype} typically pressures ${cls.threat}; your deck has none of the usual answers.`,
      evidence: [
        ...(cls.answerCardNames ? [`Card answers: ${cls.answerCardNames.join(", ")}`] : []),
        ...(cls.answerTags ? [`Tag answers: ${cls.answerTags.join(", ")}`] : []),
        cls.minCopies && cls.minCopies > 1 ? `Minimum copies: ${cls.minCopies}` : "",
      ].filter(Boolean) as string[],
    });
  }

  return out;
}

// Re-export the disclaimer string so the UI can echo it in section headers.
export const STATIC_MATCHUP_DISCLAIMER = STATIC_DISCLAIMER;
