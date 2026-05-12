// Status conditions (Asleep / Burned / Confused / Paralyzed / Poisoned)
// + Pokémon Checkup ordering. Extracted from rules.ts as part of Stage 5A
// internal-module split. `flipCoin`, `logEvent`, and `opponentOf` are
// imported from "../rules" — circular at the module-import graph but safe
// at runtime because all three are hoisted function declarations only
// called inside function bodies here.

import { flipCoin, logEvent, opponentOf } from "../rules";
import { knockOutIfNeeded } from "./prizeKo";
import {
  abilitiesActiveOnInstance,
  canBeAfflictedBy,
  effectiveMaxHp,
  isStatusImmune,
  poisonExtraCounters,
} from "../ongoingEffects";
import type {
  GameState,
  PlayerId,
  PokemonInPlay,
  StatusCondition,
} from "../types";

// Asleep, Confused, and Paralyzed are mutually exclusive with each other
// (applying one replaces any of the others). Burned and Poisoned can stack
// with anything.
const EXCLUSIVE_STATUSES: StatusCondition[] = ["asleep", "confused", "paralyzed"];

export function hasStatus(p: PokemonInPlay, s: StatusCondition): boolean {
  return p.statuses.includes(s);
}

/**
 * Apply a Special Condition to a Pokémon, honoring immunity rules and the
 * mutually-exclusive Asleep/Confused/Paralyzed slot. Routes through
 * `isStatusImmune` (Festival Grounds / Insomnia / Antique Fossils / Ancient
 * Booster Energy Capsule / Bubble Water Energy) and `canBeAfflictedBy`
 * before mutating. Burned + Poisoned coexist with each other and with the
 * exclusive trio; applying any of {asleep, confused, paralyzed} clears any
 * other member of that trio first.
 */
export function addStatus(
  state: GameState,
  p: PokemonInPlay,
  s: StatusCondition,
): void {
  // Festival Grounds: Pokémon with Energy attached can't be affected by
  // Special Conditions. Per-status ability immunity (e.g. Insomnia) handled
  // by canBeAfflictedBy.
  if (isStatusImmune(p, state)) {
    logEvent(state, "system", `${p.card.name} is immune to ${s} (Festival Grounds).`);
    return;
  }
  if (!canBeAfflictedBy(p, s, state)) {
    logEvent(state, "system", `${p.card.name} is immune to ${s}.`);
    return;
  }
  if (EXCLUSIVE_STATUSES.includes(s)) {
    p.statuses = p.statuses.filter((x) => !EXCLUSIVE_STATUSES.includes(x));
  }
  if (!p.statuses.includes(s)) p.statuses.push(s);
  logEvent(state, "system", `${p.card.name} is now ${s}.`);
}

export function removeStatus(p: PokemonInPlay, s: StatusCondition): void {
  p.statuses = p.statuses.filter((x) => x !== s);
}

export function clearAllStatuses(p: PokemonInPlay): void {
  p.statuses = [];
}

// Called after damage-from-status so we honor KO timing.
function damageFromStatus(
  state: GameState,
  owner: PlayerId,
  p: PokemonInPlay,
  amount: number,
  reason: string,
): void {
  if (!p || state.phase === "gameOver") return;
  p.damage += amount;
  logEvent(state, "system", `${p.card.name} takes ${amount} damage (${reason}).`);
  if (p.damage >= effectiveMaxHp(p, state)) {
    // KO handled by the caller's knockOut flow.
    knockOutIfNeeded(state, owner);
  }
}

// Pokémon Checkup: runs at the end of each turn, before switching players.
// Rulebook order is Poison → Burn → Asleep → Paralyzed, and each condition
// is resolved for *both* Actives before moving to the next. We apply that
// interleaving here. Paralyze is cleared only on the owner's own Checkup —
// a Paralyze applied by the opponent persists through the opponent's
// Checkup and only wears off at the end of the owner's next turn.
export function pokemonCheckup(state: GameState): void {
  if (state.phase === "gameOver") return;
  const ORDER: PlayerId[] = ["p1", "p2"];
  const endingPlayer = state.activePlayer; // the player whose turn is ending

  // Festival Grounds: status-immune Pokémon shed all conditions at Checkup
  // start. Handle this cleanup once per Pokémon up-front so nothing else in
  // the loop below operates on a condition that should have already fallen off.
  for (const pid of ORDER) {
    const a = state.players[pid].active;
    if (a && isStatusImmune(a, state) && a.statuses.length > 0) {
      a.statuses = [];
      logEvent(state, "system", `${a.card.name} shakes off all Conditions (Festival Grounds).`);
    }
  }

  // 0a. Sand Stream — if Active has it, put 2 damage counters on each of
  // opp's Basic Pokémon during Pokémon Checkup.
  for (const pid of ORDER) {
    const active = state.players[pid].active;
    if (!active) continue;
    const hasSandStream = (active.card.abilities ?? []).some((ab) => ab.name === "Sand Stream");
    if (!hasSandStream) continue;
    const opp = state.players[opponentOf(pid)];
    const oppAllies = [opp.active, ...opp.bench].filter((p): p is PokemonInPlay => !!p);
    for (const target of oppAllies) {
      if (!target.card.subtypes.includes("Basic")) continue;
      target.damage += 20;
      logEvent(state, "system", `Sand Stream: 2 counters on ${target.card.name}.`);
    }
  }

  // 0b. Freezing Shroud (Froslass) — during Pokémon Checkup, put 1 damage
  // counter on each Pokémon (both yours and your opponent's) that has an
  // Ability, except any Froslass. Source-side gate: a Froslass whose
  // abilities are suppressed by Sticky Bind / Initialization / Midnight
  // Fluttering on its own instance does NOT contribute the passive (matches
  // CLAUDE.md "Triggered abilities honor instance suppressors" pattern).
  {
    const froslassInPlay = (() => {
      for (const pid of ORDER) {
        const pl = state.players[pid];
        const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
        for (const a of allies) {
          if (!abilitiesActiveOnInstance(state, a)) continue;
          if ((a.card.abilities ?? []).some((ab) => ab.name === "Freezing Shroud")) {
            return true;
          }
        }
      }
      return false;
    })();
    if (froslassInPlay) {
      for (const pid of ORDER) {
        const pl = state.players[pid];
        const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
        for (const target of allies) {
          if ((target.card.abilities ?? []).length === 0) continue;
          if (target.card.name === "Froslass") continue; // exception per text
          target.damage += 10;
          logEvent(state, "system", `Freezing Shroud: 1 counter on ${target.card.name}.`);
        }
      }
    }
  }

  // 1. Poison damage (Perilous Jungle adds +20 on non-Darkness).
  // Mega Dragalge ex Pernicious Poison sets `heavyPoisonCounters` on the
  // defender, replacing the per-Checkup damage with N counters' worth.
  for (const pid of ORDER) {
    const a = state.players[pid].active;
    if (!a || !hasStatus(a, "poisoned")) continue;
    const heavy = (a as typeof a & { heavyPoisonCounters?: number }).heavyPoisonCounters;
    if (heavy && heavy > 0) {
      damageFromStatus(state, pid, a, heavy * 10, "heavy poison");
    } else {
      const extra = poisonExtraCounters(state, a);
      damageFromStatus(state, pid, a, 10 + extra, extra ? "poison (Perilous Jungle)" : "poison");
    }
    if ((state.phase as string) === "gameOver") return;
  }

  // 2. Burn damage (20) + cure flip (heads cures). Magma Surge on the
  // opponent's Active adds +30 (3 more counters).
  for (const pid of ORDER) {
    const a = state.players[pid].active;
    if (!a || !hasStatus(a, "burned")) continue;
    let burnDmg = 20;
    const opp = state.players[opponentOf(pid)];
    if (opp.active) {
      for (const ab of opp.active.card.abilities ?? []) {
        if (ab.name === "Magma Surge") burnDmg += 30;
      }
    }
    damageFromStatus(state, pid, a, burnDmg, burnDmg > 20 ? "burn (Magma Surge)" : "burn");
    if ((state.phase as string) === "gameOver") return;
    const cured = flipCoin(state, `${a.card.name} burn flip`);
    if (cured) {
      removeStatus(a, "burned");
      logEvent(state, "system", `${a.card.name}'s burn is cured.`);
    }
  }

  // 3. Asleep wake-check flip.
  for (const pid of ORDER) {
    const a = state.players[pid].active;
    if (!a || !hasStatus(a, "asleep")) continue;
    const woke = flipCoin(state, `${a.card.name} asleep flip`);
    if (woke) {
      removeStatus(a, "asleep");
      logEvent(state, "system", `${a.card.name} woke up.`);
    }
  }

  // 4. Paralyze clears — ONLY on the owner's own Checkup. If the opponent
  // paralyzed their Active at the end of their turn, it stays paralyzed for
  // the owner's next turn and only wears off at the end of that turn.
  {
    const a = state.players[endingPlayer].active;
    if (a && hasStatus(a, "paralyzed")) {
      removeStatus(a, "paralyzed");
      logEvent(state, "system", `${a.card.name} is no longer paralyzed.`);
    }
  }
}
