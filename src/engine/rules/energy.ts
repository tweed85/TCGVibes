// Energy cost matching + Special Energy attach-rule enforcement.
// Extracted from rules.ts as part of Stage 5A internal-module split.
// `logEvent` is imported from "../rules" — circular at the module-import
// graph, but safe at runtime because `logEvent` is only called inside
// function bodies and is hoisted as a function declaration.

import { logEvent } from "../rules";
import type {
  EnergyCard,
  EnergyType,
  GameState,
  PlayerId,
  PokemonCard,
  PokemonInPlay,
} from "../types";

// Wildcard marker. Emitted by effectiveEnergyProvides for Prism / Luminous /
// Legacy / Neo Upper Energy. In the pool, "*" matches any specific-type cost
// and also counts as a valid Colorless payment.
export const WILD_ENERGY = "*";

// Runtime-effective provides for an attached Energy card. Takes the holder
// into account for conditional special energies (Ignition, Prism, Neo Upper,
// Luminous). Returns an array of strings — each entry is one energy unit
// (payable against 1 specific-type cost or 1 Colorless cost).
export function effectiveEnergyProvides(
  e: EnergyCard,
  holder: PokemonCard,
  holderAttached?: EnergyCard[],
): string[] {
  const subs = holder.subtypes ?? [];
  const isBasicHolder = subs.includes("Basic");
  const isStage2Holder = subs.includes("Stage 2");
  const isEvolutionHolder = !!holder.evolvesFrom;
  switch (e.name) {
    case "Team Rocket's Energy":
      // "provides 2 in any combination of Psychic and Darkness." Two slots,
      // each payable as P or C, or D or C. We approximate as one P + one D;
      // cost P+D, 2C, and 1 P (or 1 D) all resolve correctly.
      return ["Psychic", "Darkness"];
    case "Prism Energy":
      return isBasicHolder ? [WILD_ENERGY] : ["Colorless"];
    case "Luminous Energy": {
      // "If the Pokémon this card is attached to has any other Special Energy
      // attached, this card provides Colorless Energy instead."
      const others = (holderAttached ?? []).filter((x) => x !== e);
      const anyOtherSpecial = others.some((x) => (x.subtypes ?? []).includes("Special"));
      return anyOtherSpecial ? ["Colorless"] : [WILD_ENERGY];
    }
    case "Legacy Energy":
      return [WILD_ENERGY];
    case "Ignition Energy":
      // Provides C, or CCC on an Evolution holder. End-of-turn discard is
      // handled separately in endTurn().
      return isEvolutionHolder ? ["Colorless", "Colorless", "Colorless"] : ["Colorless"];
    case "Neo Upper Energy":
      return isStage2Holder ? [WILD_ENERGY, WILD_ENERGY] : ["Colorless"];
    case "Growing Grass Energy":
      return ["Grass"];
    case "Rocky Fighting Energy":
      return ["Fighting"];
    case "Telepathic Psychic Energy":
      return ["Psychic"];
    case "Nitro Fire Energy":
      // me4 Special Energy — "While attached to a Pokémon, this card
      // provides 1 Fire Energy."
      return ["Fire"];
    case "Bubble Water Energy":
      // me4 Special Energy — provides Water (the standard Water Special
      // Energy reading; status-immunity is handled in canBeAfflictedBy).
      return ["Water"];
    case "Magnet Metal Energy":
      // me4 Special Energy — provides Metal (free retreat handled in
      // effectiveRetreatCost).
      return ["Metal"];
  }
  // Default: use the static provides (basic energy has its own type; plain
  // special energies default to Colorless).
  return e.provides.slice();
}

/**
 * Greedy cost-matching: walks specific-type costs first (consuming exact
 * type matches from the pool, falling back to wildcards), then checks
 * remaining pool size against Colorless. Order matters — without
 * specific-first matching, a wildcard could be spent on Colorless and
 * leave the specific cost unpayable. The caller's `attached` array is
 * sliced internally so callers don't need to defensively copy.
 */
export function canPayCost(
  attached: string[] | EnergyType[],
  cost: EnergyType[],
): boolean {
  const pool = (attached as string[]).slice();
  // First match specific-type costs, then Colorless can be paid by anything.
  const specific = cost.filter((c) => c !== "Colorless");
  const colorless = cost.length - specific.length;
  for (const need of specific) {
    // Prefer an exact-type match, else consume a wildcard.
    let i = pool.indexOf(need);
    if (i === -1) i = pool.indexOf(WILD_ENERGY);
    if (i === -1) return false;
    pool.splice(i, 1);
  }
  return pool.length >= colorless;
}

export const energyProvidedBy = (p: PokemonInPlay): string[] =>
  p.attachedEnergy.flatMap((e) => effectiveEnergyProvides(e, p.card, p.attachedEnergy));

// Some Special Energies have ongoing attachment gates (Team Rocket's Energy:
// "If this card is attached to anything other than a Team Rocket's Pokémon,
// discard this card."). Call this after any effect that moves or reassigns
// energies (Energy Switch, Scramble Switch, N's Plan, etc.) to enforce.
export function enforceSpecialEnergyAttachRules(state: GameState): void {
  for (const pid of ["p1", "p2"] as PlayerId[]) {
    const pl = state.players[pid];
    for (const p of [pl.active, ...pl.bench]) {
      if (!p) continue;
      for (let i = p.attachedEnergy.length - 1; i >= 0; i--) {
        const e = p.attachedEnergy[i];
        if (e.name === "Team Rocket's Energy" && !p.card.name.startsWith("Team Rocket's ")) {
          p.attachedEnergy.splice(i, 1);
          pl.discard.push(e);
          logEvent(state, pid, `${e.name} is discarded from ${p.card.name} (not a Team Rocket's Pokémon).`);
        }
      }
    }
  }
}
