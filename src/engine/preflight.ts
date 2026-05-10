// Playability preflight — pure, non-mutating guards that mirror the
// in-action checks in actions.ts. Designed for the UI to dim / tooltip
// illegal hand cards / attacks / retreats BEFORE the player clicks.
//
// Critical contract: every guard's failure `reason` MUST match the matching
// action's `ActionResult.reason`. The contract test in
// __tests__/preflightContract.test.ts asserts this for every illegal-action
// fixture. Drift between the two surfaces is the only thing that can make
// dim/tooltip UI lie to the user.
//
// `attackPreflight` is re-exported from actions.ts so callers have a single
// import for all preflight needs.

import type {
  Card,
  EnergyCard,
  GameState,
  PlayerId,
  PokemonInPlay,
  PokemonCard,
  TrainerCard,
} from "./types";
import { attackPreflight } from "./actions";
import {
  canPayCost,
  hasStatus,
  isBasic,
  isPokemon,
  isPlayersFirstTurn,
} from "./rules";
import {
  abilitiesActiveOnInstance,
  actionBlockedByOppActive,
  effectiveRetreatCost,
  energyPoolForCost,
  maxBenchSize,
} from "./ongoingEffects";
import { precheckTrainerEffect } from "./trainerEffects";

// Re-export the existing attack preflight so callers have one entry point.
export { attackPreflight } from "./actions";

// ---- Types ----------------------------------------------------------------

export type PlayabilityKind =
  | "benchBasic"
  | "evolve"
  | "attachEnergy"
  | "playTrainer"
  | "playTool"
  | "rareCandy"
  | "retreat"
  | "attack"
  | "activateAbility"
  | "activateStadium"
  | "promoteBenchToActive"
  | "useStadium"
  | "cancelPendingTarget";

export interface PlayabilityEntry {
  kind: PlayabilityKind;
  ok: boolean;
  reason?: string;
  card?: Card;
  handIndex?: number;
  instanceId?: string;
  /** Instance ids that are legal targets when ok=true (for target-needing kinds). */
  targetInstanceIds?: string[];
}

export interface PlayerPlayability {
  player: PlayerId;
  /** One entry per hand card, in hand order. */
  hand: PlayabilityEntry[];
  /** One entry per attack on the active Pokémon. */
  attacks: PlayabilityEntry[];
  /** One entry per ally with at least one ability. */
  abilities: PlayabilityEntry[];
  retreat: PlayabilityEntry;
}

// ---- Result helpers -------------------------------------------------------

const ok = (
  kind: PlayabilityKind,
  extra?: Partial<PlayabilityEntry>,
): PlayabilityEntry => ({ kind, ok: true, ...extra });
const fail = (
  kind: PlayabilityKind,
  reason: string,
  extra?: Partial<PlayabilityEntry>,
): PlayabilityEntry => ({ kind, ok: false, reason, ...extra });

// ---- Shared turn-phase guard ---------------------------------------------

function turnGuard(state: GameState, player: PlayerId): string | null {
  if (state.phase === "gameOver") return "Game is over.";
  if (state.activePlayer !== player) return "Not your turn.";
  if (state.phase !== "main") return "Not in main phase.";
  return null;
}

// ---- Per-action guards ----------------------------------------------------

const T1_SUPPORTER_EXCEPTIONS = new Set<string>(["Team Rocket's Proton", "Carmine"]);

function findInPlayByInstance(
  state: GameState,
  player: PlayerId,
  instanceId: string,
): PokemonInPlay | null {
  const pl = state.players[player];
  if (pl.active?.instanceId === instanceId) return pl.active;
  return pl.bench.find((p) => p.instanceId === instanceId) ?? null;
}

/** Bench a Basic Pokémon. Mirrors playBasicToBench guards in actions.ts. */
export function canBenchBasic(
  state: GameState,
  player: PlayerId,
  handIndex: number,
): PlayabilityEntry {
  const phaseError = turnGuard(state, player);
  if (phaseError) return fail("benchBasic", phaseError, { handIndex });
  const pl = state.players[player];
  const card = pl.hand[handIndex];
  if (!card) return fail("benchBasic", "No such card in hand.", { handIndex });
  if (!isPokemon(card) || !isBasic(card))
    return fail("benchBasic", "Must be a Basic Pokémon.", { handIndex, card });
  if ((card.abilities ?? []).some((a) => a.name === "Hero's Spirit")) {
    return fail(
      "benchBasic",
      "Hero's Spirit: can only enter play via Zero to Hero.",
      { handIndex, card },
    );
  }
  const oppId: PlayerId = player === "p1" ? "p2" : "p1";
  const oppActive = state.players[oppId].active;
  if (
    oppActive &&
    (oppActive.card.abilities ?? []).some((a) => a.name === "Potent Glare") &&
    abilitiesActiveOnInstance(state, oppActive)
  ) {
    const isTeamRocket = card.name.startsWith("Team Rocket's ");
    const cardHasAbility = (card.abilities ?? []).length > 0;
    if (cardHasAbility && !isTeamRocket) {
      return fail(
        "benchBasic",
        "Potent Glare: can't play that Pokémon while opp's Active has Potent Glare.",
        { handIndex, card },
      );
    }
  }
  const cap = maxBenchSize(state, pl.bench, pl.active);
  if (pl.bench.length >= cap)
    return fail("benchBasic", "Bench is full.", { handIndex, card });
  return ok("benchBasic", { handIndex, card });
}

/**
 * Evolve a target Pokémon. Returns the set of legal target instance IDs in
 * `targetInstanceIds` when the card is a legal evolution but no specific
 * target was specified. Mirrors `evolve()` guards.
 */
export function canEvolve(
  state: GameState,
  player: PlayerId,
  handIndex: number,
  targetInstanceId?: string,
): PlayabilityEntry {
  const phaseError = turnGuard(state, player);
  if (phaseError) return fail("evolve", phaseError, { handIndex });
  const pl = state.players[player];
  const card = pl.hand[handIndex];
  if (!card) return fail("evolve", "No such card in hand.", { handIndex });
  if (!isPokemon(card)) return fail("evolve", "Must evolve with a Pokémon card.", { handIndex, card });
  if (!card.evolvesFrom)
    return fail("evolve", "That card is not an evolution.", { handIndex, card });

  const allies: PokemonInPlay[] = [
    ...(pl.active ? [pl.active] : []),
    ...pl.bench,
  ];
  const matchByName = (target: PokemonInPlay): boolean => {
    if (target.card.name === card.evolvesFrom) return true;
    // Rainbow DNA — Eevee ex / Eeveelution exception.
    const rainbowOK =
      (target.card.abilities ?? []).some((a) => a.name === "Rainbow DNA") &&
      (card.subtypes ?? []).some((s) => /^(?:ex|EX)$/.test(s)) &&
      (card.evolvesFrom === "Eevee" || card.evolvesFrom?.endsWith(" Eevee") === true);
    return rainbowOK;
  };

  const oppActive = state.players[player === "p1" ? "p2" : "p1"].active;
  const oppActiveIsEx = oppActive
    ? (oppActive.card.subtypes ?? []).some((s) => /^(?:ex|EX)$/.test(s))
    : false;
  const allowsTurn1ForTarget = (target: PokemonInPlay): boolean =>
    (target.card.abilities ?? []).some(
      (a) =>
        a.name === "Boosted Evolution" ||
        (a.name === "Stimulated Evolution" &&
          allies.some((p) => p.card.name === "Karrablast")) ||
        (a.name === "Fighting Roar" && oppActiveIsEx),
    );

  // Compute legal targets — those matching by name and passing turn rules.
  const legalTargets = allies.filter((target) => {
    if (!matchByName(target)) return false;
    if (target.evolvedThisTurn) return false;
    if (isPlayersFirstTurn(state, player) && !allowsTurn1ForTarget(target))
      return false;
    if (target.playedThisTurn && !allowsTurn1ForTarget(target)) return false;
    return true;
  });

  if (targetInstanceId === undefined) {
    if (legalTargets.length === 0)
      return fail("evolve", "No legal evolution target in play.", { handIndex, card });
    return ok("evolve", {
      handIndex,
      card,
      targetInstanceIds: legalTargets.map((p) => p.instanceId),
    });
  }

  const target = findInPlayByInstance(state, player, targetInstanceId);
  if (!target) return fail("evolve", "Target not in play.", { handIndex, card });
  if (!matchByName(target))
    return fail(
      "evolve",
      `${card.name} evolves from ${card.evolvesFrom}, not ${target.card.name}.`,
      { handIndex, card, instanceId: targetInstanceId },
    );
  if (target.evolvedThisTurn)
    return fail("evolve", "Already evolved this turn.", {
      handIndex, card, instanceId: targetInstanceId,
    });
  if (isPlayersFirstTurn(state, player) && !allowsTurn1ForTarget(target))
    return fail("evolve", "No evolving on your first turn.", {
      handIndex, card, instanceId: targetInstanceId,
    });
  if (target.playedThisTurn && !allowsTurn1ForTarget(target))
    return fail("evolve", "Can't evolve a Pokémon played this turn.", {
      handIndex, card, instanceId: targetInstanceId,
    });
  return ok("evolve", { handIndex, card, instanceId: targetInstanceId });
}

/** Attach an energy. Mirrors `attachEnergy` guards. */
export function canAttachEnergy(
  state: GameState,
  player: PlayerId,
  handIndex: number,
  targetInstanceId?: string,
): PlayabilityEntry {
  const phaseError = turnGuard(state, player);
  if (phaseError) return fail("attachEnergy", phaseError, { handIndex });
  const pl = state.players[player];
  if (pl.energyAttachedThisTurn)
    return fail("attachEnergy", "Already attached an Energy this turn.", { handIndex });
  const card = pl.hand[handIndex];
  if (!card) return fail("attachEnergy", "No such card in hand.", { handIndex });
  if (card.supertype !== "Energy")
    return fail("attachEnergy", "Must select an Energy card.", { handIndex, card });

  const allies: PokemonInPlay[] = [
    ...(pl.active ? [pl.active] : []),
    ...pl.bench,
  ];
  const targetIsLegal = (target: PokemonInPlay): boolean => {
    if (
      card.name === "Team Rocket's Energy" &&
      !target.card.name.startsWith("Team Rocket's ")
    )
      return false;
    const lockedUntil = (target as typeof target & { cantAttachEnergyFromHandUntilTurn?: number })
      .cantAttachEnergyFromHandUntilTurn;
    if (lockedUntil !== undefined && state.turn <= lockedUntil) return false;
    return true;
  };
  const legalTargets = allies.filter(targetIsLegal);

  if (targetInstanceId === undefined) {
    if (legalTargets.length === 0)
      return fail("attachEnergy", "No legal target for this Energy.", { handIndex, card });
    return ok("attachEnergy", {
      handIndex, card,
      targetInstanceIds: legalTargets.map((p) => p.instanceId),
    });
  }

  const target = findInPlayByInstance(state, player, targetInstanceId);
  if (!target) return fail("attachEnergy", "Target not in play.", { handIndex, card });
  if (
    card.name === "Team Rocket's Energy" &&
    !target.card.name.startsWith("Team Rocket's ")
  ) {
    return fail(
      "attachEnergy",
      "Team Rocket's Energy can only be attached to a Team Rocket's Pokémon.",
      { handIndex, card, instanceId: targetInstanceId },
    );
  }
  const lockedUntil = (target as typeof target & { cantAttachEnergyFromHandUntilTurn?: number })
    .cantAttachEnergyFromHandUntilTurn;
  if (lockedUntil !== undefined && state.turn <= lockedUntil) {
    return fail(
      "attachEnergy",
      `${target.card.name} can't have Energy attached from your hand this turn.`,
      { handIndex, card, instanceId: targetInstanceId },
    );
  }
  return ok("attachEnergy", { handIndex, card, instanceId: targetInstanceId });
}

/**
 * Play a Trainer card. Routes through `precheckTrainerEffect` for the
 * effect-id-specific checks (uses the same predicate `playTrainer` calls,
 * so reasons match by construction).
 */
export function canPlayTrainer(
  state: GameState,
  player: PlayerId,
  handIndex: number,
): PlayabilityEntry {
  const phaseError = turnGuard(state, player);
  if (phaseError) return fail("playTrainer", phaseError, { handIndex });
  const pl = state.players[player];
  const card = pl.hand[handIndex];
  if (!card) return fail("playTrainer", "No such card in hand.", { handIndex });
  if (card.supertype !== "Trainer")
    return fail("playTrainer", "Not a Trainer card.", { handIndex, card });
  const t = card as TrainerCard;
  const isSupporter = t.subtypes.includes("Supporter");
  const isStadium = t.subtypes.includes("Stadium");
  const isTool = t.subtypes.includes("Pokémon Tool") || t.subtypes.includes("Tool");

  if (isSupporter) {
    if (pl.supporterPlayedThisTurn)
      return fail("playTrainer", "Already played a Supporter this turn.", { handIndex, card });
    if (state.firstTurnNoAttack && !T1_SUPPORTER_EXCEPTIONS.has(t.name))
      return fail(
        "playTrainer",
        "First player can't play a Supporter on the first turn.",
        { handIndex, card },
      );
  }
  if (t.subtypes.includes("Item") && pl.itemsBlockedNextTurn) {
    return fail("playTrainer", "Can't play Item cards this turn (Itchy Pollen).", {
      handIndex, card,
    });
  }
  if (t.subtypes.includes("Item") && actionBlockedByOppActive(state, player, "Item")) {
    return fail(
      "playTrainer",
      "Opponent's Active Pokémon prevents playing Item cards.",
      { handIndex, card },
    );
  }
  if (isTool && actionBlockedByOppActive(state, player, "Pokémon Tool")) {
    return fail(
      "playTrainer",
      "Opponent's Active Pokémon prevents playing Pokémon Tools.",
      { handIndex, card },
    );
  }
  if (isStadium && actionBlockedByOppActive(state, player, "Stadium")) {
    return fail(
      "playTrainer",
      "Opponent's Active Pokémon prevents playing Stadium cards.",
      { handIndex, card },
    );
  }
  if (t.subtypes.includes("ACE SPEC")) {
    const oppId: PlayerId = player === "p1" ? "p2" : "p1";
    const opp = state.players[oppId];
    const blocker = [opp.active, ...opp.bench].find(
      (p): p is PokemonInPlay =>
        !!p &&
        p.tools.length > 0 &&
        (p.card.abilities ?? []).some((a) => a.name === "ACE Nullifier") &&
        abilitiesActiveOnInstance(state, p),
    );
    if (blocker) {
      return fail(
        "playTrainer",
        `${blocker.card.name}'s ACE Nullifier blocks ACE SPEC cards.`,
        { handIndex, card },
      );
    }
  }
  // Tools need a target with an open tool slot.
  if (isTool) {
    const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
    const eligible = allies.filter((p) => {
      let maxTools = 1;
      if (p.card.name.includes("Rotom")) {
        if (
          allies.some((a) =>
            (a.card.abilities ?? []).some((ab) => ab.name === "Multi Adapter"),
          )
        ) {
          maxTools = 2;
        }
      }
      return (p.tools?.length ?? 0) < maxTools;
    });
    if (eligible.length === 0) {
      return fail("playTrainer", "No Pokémon can hold this Tool.", {
        handIndex, card,
      });
    }
    return ok("playTrainer", {
      handIndex,
      card,
      targetInstanceIds: eligible.map((p) => p.instanceId),
    });
  }

  // Effect-specific precheck — share the predicate that playTrainer uses.
  // Returns string (the failure reason) or null on pass.
  const preReason = precheckTrainerEffect(state, player, t);
  if (preReason !== null) {
    return fail("playTrainer", preReason, { handIndex, card });
  }
  return ok("playTrainer", { handIndex, card });
}

/** Retreat the Active to a bench Pokémon. Mirrors `retreat()` guards. */
export function canRetreat(
  state: GameState,
  player: PlayerId,
): PlayabilityEntry {
  const phaseError = turnGuard(state, player);
  if (phaseError) return fail("retreat", phaseError);
  const pl = state.players[player];
  if (pl.retreatedThisTurn) return fail("retreat", "Already retreated this turn.");
  if (!pl.active) return fail("retreat", "No Active Pokémon.");
  if (hasStatus(pl.active, "asleep"))
    return fail("retreat", "Asleep Pokémon can't retreat.");
  if (hasStatus(pl.active, "paralyzed"))
    return fail("retreat", "Paralyzed Pokémon can't retreat.");
  if (
    pl.active.cantRetreatUntilTurn !== undefined &&
    state.turn <= pl.active.cantRetreatUntilTurn
  ) {
    return fail("retreat", "This Pokémon can't retreat this turn.");
  }
  if ((pl.active.card.subtypes ?? []).includes("Fossil"))
    return fail("retreat", "Fossil Pokémon can't retreat.");
  const oppId: PlayerId = player === "p1" ? "p2" : "p1";
  const opp = state.players[oppId];
  const flag = (opp as typeof opp & { poisonedOppCantRetreatNextTurn?: boolean })
    .poisonedOppCantRetreatNextTurn;
  if (flag && hasStatus(pl.active, "poisoned"))
    return fail(
      "retreat",
      "Roxie's Performance: Poisoned Pokémon can't retreat this turn.",
    );
  if (pl.bench.length === 0) return fail("retreat", "Invalid bench slot.");
  const cost = effectiveRetreatCost(pl.active, state);
  const provided = energyPoolForCost(pl.active, state);
  if (!canPayCost(provided, cost))
    return fail("retreat", "Not enough Energy to retreat.");
  return ok("retreat");
}

// ---- Aggregate -----------------------------------------------------------

/**
 * Compute playability for the player. The UI uses this to dim/tooltip
 * each hand card and the retreat button. Costs ~O(handSize × benchSize)
 * — cheap enough to call inside a `useMemo` keyed on the relevant state.
 */
export function computePlayerPlayability(
  state: GameState,
  player: PlayerId,
): PlayerPlayability {
  const pl = state.players[player];
  const hand: PlayabilityEntry[] = pl.hand.map((card, idx) => {
    if (card.supertype === "Pokémon") {
      const isBasicSub = (card.subtypes ?? []).includes("Basic");
      if (isBasicSub) return canBenchBasic(state, player, idx);
      if (card.evolvesFrom) return canEvolve(state, player, idx);
      return { kind: "benchBasic", ok: false, reason: "No action available.", handIndex: idx, card };
    }
    if (card.supertype === "Energy") {
      return canAttachEnergy(state, player, idx);
    }
    return canPlayTrainer(state, player, idx);
  });

  const attacks: PlayabilityEntry[] = [];
  if (pl.active) {
    for (let i = 0; i < pl.active.card.attacks.length; i++) {
      const r = attackPreflight(state, player, i);
      attacks.push(
        r.ok
          ? { kind: "attack", ok: true }
          : { kind: "attack", ok: false, reason: r.reason },
      );
    }
  }

  const abilities: PlayabilityEntry[] = []; // populated per-Pokémon in callers
  // Ability surface is broad and per-instance — leave to callers to compute
  // per-Pokémon. The aggregate stub is here so the type stays whole.

  return {
    player,
    hand,
    attacks,
    abilities,
    retreat: canRetreat(state, player),
  };
}

// ---- Re-exported types tests need ---------------------------------------

export type { Card, EnergyCard, PokemonCard, TrainerCard };
