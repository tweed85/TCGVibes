import type {
  Card,
  EnergyCard,
  EnergyType,
  GameState,
  PlayerId,
  PokemonCard,
  PokemonInPlay,
  TrainerCard,
} from "./types";
import {
  applyDamage,
  canPayCost,
  clearAllStatuses,
  endTurn as endTurnRule,
  energyProvidedBy,
  flipCoin,
  hasStatus,
  isBasic,
  isPokemon,
  knockOut,
  logEvent,
  makePokemonInPlay,
  opponentOf,
  passTurn,
  resolveBenchKOs,
} from "./rules";
import { resolveAttackEffects } from "./effects";
import {
  fireTriggeredOnBench,
  fireTriggeredOnEvolve,
  fireTriggeredOnMoveToActive,
  fireTriggeredOnMoveToBench,
} from "./abilities";
import { setDeckSearchPick } from "./pendingPick";
import {
  applySurvivalBrace,
  benchPlacementDamage,
  canEvolveOnPlayTurn,
  confusedPersistsOnEvolve,
  effectiveAttackCost,
  effectiveMaxHp,
  effectiveRetreatCost,
  maxBenchSize,
  passiveAttackBonus,
  stadiumAttackBonus,
  stadiumDamageReduction,
  toolOnDamageActions,
  triggeredBerryTools,
  turnAttackBonus,
  turnDamageReduction,
} from "./ongoingEffects";

export type ActionResult =
  | { ok: true }
  | { ok: false; reason: string };

const ok: ActionResult = { ok: true };
const fail = (reason: string): ActionResult => ({ ok: false, reason });

// Guard: is it this player's main phase?
function requireMain(state: GameState, player: PlayerId): ActionResult {
  if (state.phase === "gameOver") return fail("Game is over.");
  if (state.activePlayer !== player) return fail("Not your turn.");
  if (state.phase !== "main") return fail("Not in main phase.");
  return ok;
}

export function playBasicToBench(
  state: GameState,
  player: PlayerId,
  handIndex: number,
): ActionResult {
  const g = requireMain(state, player);
  if (!g.ok) return g;
  const pl = state.players[player];
  const card = pl.hand[handIndex];
  if (!card) return fail("No such card in hand.");
  if (!isPokemon(card) || !isBasic(card)) return fail("Must be a Basic Pokémon.");
  const cap = maxBenchSize(state, pl.bench, pl.active);
  if (pl.bench.length >= cap) return fail("Bench is full.");
  pl.hand.splice(handIndex, 1);
  const p = makePokemonInPlay(card);
  // Risky Ruins: Basic non-Darkness takes 2 damage counters on bench play.
  const benchDmg = benchPlacementDamage(state, card);
  if (benchDmg > 0) {
    p.damage += benchDmg;
    logEvent(state, player, `${card.name} takes ${benchDmg} from Risky Ruins.`);
  }
  pl.bench.push(p);
  logEvent(state, player, `plays ${card.name} to the Bench.`);
  // Fire any triggered-on-bench abilities (Meowth ex Last-Ditch Catch, etc.).
  fireTriggeredOnBench(state, player, p);
  return ok;
}

function findInPlayByInstance(
  state: GameState,
  player: PlayerId,
  instanceId: string,
): PokemonInPlay | null {
  const pl = state.players[player];
  if (pl.active?.instanceId === instanceId) return pl.active;
  return pl.bench.find((p) => p.instanceId === instanceId) ?? null;
}

export function evolve(
  state: GameState,
  player: PlayerId,
  handIndex: number,
  targetInstanceId: string,
): ActionResult {
  const g = requireMain(state, player);
  if (!g.ok) return g;
  const pl = state.players[player];
  const card = pl.hand[handIndex];
  if (!card || !isPokemon(card)) return fail("Must evolve with a Pokémon card.");
  if (!card.evolvesFrom) return fail("That card is not an evolution.");
  const target = findInPlayByInstance(state, player, targetInstanceId);
  if (!target) return fail("Target not in play.");
  if (target.card.name !== card.evolvesFrom)
    return fail(`${card.name} evolves from ${card.evolvesFrom}, not ${target.card.name}.`);
  // Check once-per-turn evolution FIRST so nothing (including Forest of
  // Vitality) can chain Basic → Stage 1 → Stage 2 on the same instance.
  if (target.evolvedThisTurn) return fail("Already evolved this turn.");
  if (state.turn === 1) return fail("No evolving on the first turn.");
  // Forest of Vitality only overrides the played-this-turn rule for a Basic
  // Grass target on its first evolution of the turn.
  if (target.playedThisTurn && !canEvolveOnPlayTurn(state, target))
    return fail("Can't evolve a Pokémon played this turn.");

  pl.hand.splice(handIndex, 1);
  target.evolvedFrom.push(target.card);
  target.card = card;
  // Evolving clears Special Conditions — except Confused under Dizzying Valley.
  if (confusedPersistsOnEvolve(state)) {
    const wasConfused = target.statuses.includes("confused");
    clearAllStatuses(target);
    if (wasConfused) target.statuses.push("confused");
  } else {
    clearAllStatuses(target);
  }
  // Tools carry over; abilities reset.
  target.abilityUsedThisTurn = false;
  target.evolvedThisTurn = true;
  logEvent(state, player, `evolves into ${card.name}.`);

  // Fire any triggered-on-evolve ability the evolved card has (e.g.
  // Noctowl's Jewel Seeker, Alakazam's Psychic Draw, Hariyama's Heave-Ho
  // Catcher). Happens before the Mega Evolution end-of-turn check so the
  // triggered effect can still resolve (and open a pendingPick if needed).
  fireTriggeredOnEvolve(state, player, target);

  // Mega Evolution rule: evolving into a Mega Pokémon ends your turn.
  // Detected via the "Mega Evolution rule" text on the card's rule box.
  const rules = card.rules ?? [];
  const isMega =
    card.subtypes.some((s) => /^Mega/i.test(s)) ||
    rules.some((r) => /when .* Mega Evolves, your turn ends/i.test(r)) ||
    rules.some((r) => /Mega Evolution rule/i.test(r));
  if (isMega) {
    logEvent(state, "system", `${card.name}'s Mega Evolution ends the turn.`);
    endTurnRule(state);
  }
  return ok;
}

export function attachEnergy(
  state: GameState,
  player: PlayerId,
  handIndex: number,
  targetInstanceId: string,
): ActionResult {
  const g = requireMain(state, player);
  if (!g.ok) return g;
  const pl = state.players[player];
  if (pl.energyAttachedThisTurn) return fail("Already attached an Energy this turn.");
  const card = pl.hand[handIndex];
  if (!card || card.supertype !== "Energy")
    return fail("Must select an Energy card.");
  const target = findInPlayByInstance(state, player, targetInstanceId);
  if (!target) return fail("Target not in play.");
  // Team Rocket's Energy: "This card can only be attached to a Team Rocket's
  // Pokémon. If this card is attached to anything other than a Team Rocket's
  // Pokémon, discard this card." Block the attach pre-emptively for clearer UX.
  if (card.name === "Team Rocket's Energy" && !target.card.name.startsWith("Team Rocket's ")) {
    return fail("Team Rocket's Energy can only be attached to a Team Rocket's Pokémon.");
  }
  pl.hand.splice(handIndex, 1);
  target.attachedEnergy.push(card as EnergyCard);
  pl.energyAttachedThisTurn = true;
  logEvent(state, player, `attaches ${card.name} to ${target.card.name}.`);
  // On-attach triggers for special energies.
  const oppId2: PlayerId = player === "p1" ? "p2" : "p1";
  void oppId2; // suppress unused — reserved for future use
  if (card.name === "Enriching Energy") {
    // "When you attach this card from your hand to a Pokémon, draw 4 cards."
    let drawn = 0;
    for (let i = 0; i < 4; i++) {
      const c = pl.deck.shift();
      if (!c) break;
      pl.hand.push(c);
      drawn++;
    }
    if (drawn > 0) logEvent(state, player, `Enriching Energy: draws ${drawn}.`);
  } else if (card.name === "Jet Energy") {
    // "When you attach this card from your hand to 1 of your Benched Pokémon,
    // switch that Pokémon with your Active Pokémon." Only triggers if the
    // attach target is a benched ally.
    const benchIdx = pl.bench.findIndex((b) => b.instanceId === target.instanceId);
    if (benchIdx >= 0 && pl.active) {
      const incoming = pl.bench.splice(benchIdx, 1)[0];
      const outgoing = pl.active;
      clearAllStatuses(outgoing);
      pl.active = incoming;
      pl.bench.push(outgoing);
      logEvent(state, player, `Jet Energy: switches ${outgoing.card.name} → ${incoming.card.name}.`);
      fireTriggeredOnMoveToActive(state, player, incoming);
      fireTriggeredOnMoveToBench(state, player, outgoing);
    }
  } else if (card.name === "Telepathic Psychic Energy") {
    // "When you attach this card from your hand to a Psychic Pokémon, search
    // your deck for up to 2 Basic Psychic Pokémon and put them onto your
    // Bench. Then, shuffle your deck."
    if (target.card.types.includes("Psychic") && pl.bench.length < 5) {
      const pred = (c: Card) =>
        c.supertype === "Pokémon" && c.subtypes.includes("Basic") && c.types.includes("Psychic");
      const slots = Math.min(2, 5 - pl.bench.length);
      if (!setDeckSearchPick(state, player, pred, slots, "Telepathic Psychic Energy: pick up to 2 Basic Psychic Pokémon to Bench", { toBench: true })) {
        logEvent(state, player, "finds no Basic Psychic Pokémon.");
      }
    }
  }
  return ok;
}

export function playTrainer(
  state: GameState,
  player: PlayerId,
  handIndex: number,
  target?: TrainerTarget,
): ActionResult {
  const g = requireMain(state, player);
  if (!g.ok) return g;
  const pl = state.players[player];
  const card = pl.hand[handIndex];
  if (!card || card.supertype !== "Trainer") return fail("Not a Trainer card.");
  const t = card as TrainerCard;
  const isSupporter = t.subtypes.includes("Supporter");
  const isStadium = t.subtypes.includes("Stadium");
  const isTool = t.subtypes.includes("Pokémon Tool") || t.subtypes.includes("Tool");

  if (isSupporter) {
    if (pl.supporterPlayedThisTurn)
      return fail("Already played a Supporter this turn.");
    // Current rule: first player cannot play a Supporter on their first turn.
    // Rulebook: the player who goes first can't play a Supporter on their
    // first turn. `firstTurnNoAttack` is true only during the starting
    // player's first turn — regardless of whether that's p1 or p2.
    if (state.firstTurnNoAttack)
      return fail("First player can't play a Supporter on the first turn.");
  }

  // Budew's Itchy Pollen (and similar) locks the opponent out of Items this turn.
  if (t.subtypes.includes("Item") && pl.itemsBlockedNextTurn) {
    return fail("Can't play Item cards this turn (Itchy Pollen).");
  }

  // Tool: must be attached to a Pokémon in play with no Tool already.
  if (isTool) {
    const targetId = target?.kind === "inPlay" ? target.instanceId : null;
    if (!targetId) return fail("Pick a Pokémon to attach this Tool to.");
    const p = findInPlayByInstance(state, player, targetId);
    if (!p) return fail("Target not in play.");
    if ((p.tools?.length ?? 0) >= 1)
      return fail("That Pokémon already has a Tool attached.");
    pl.hand.splice(handIndex, 1);
    p.tools.push(t);
    logEvent(state, player, `attaches ${t.name} to ${p.card.name}.`);
    return ok;
  }

  // Stadium: replaces any existing Stadium (discards it, including the
  // opponent's if they had one). The new Stadium is now controlled by
  // whoever played it. Rulebook exception: you can't play a Stadium with
  // the same name as the one already in play.
  if (isStadium) {
    if (state.stadium && state.stadium.card.name === t.name) {
      return fail(`Can't play ${t.name} — a Stadium with the same name is already in play.`);
    }
    if (state.stadium) {
      const prev = state.stadium;
      state.players[prev.controller].discard.push(prev.card);
      logEvent(state, "system", `${prev.card.name} is replaced and discarded.`);
    }
    pl.hand.splice(handIndex, 1);
    state.stadium = { card: t, controller: player };
    logEvent(state, player, `plays Stadium ${t.name}.`);
    // A new Stadium can shrink effective HP (e.g. Gravity Mountain -30 on
    // Stage 2s) — sweep bench KOs so any Pokémon now past its cap is
    // removed before further actions run.
    resolveBenchKOs(state);
    // Area Zero Underdepths allows 8 bench; if that Stadium just left play
    // (replaced by a normal one), trim the bench back to 5 by discarding
    // the newest benched Pokémon (and attached cards).
    for (const pid of ["p1", "p2"] as PlayerId[]) {
      const side = state.players[pid];
      while (side.bench.length > 5) {
        const [discarded] = side.bench.splice(side.bench.length - 1, 1);
        side.discard.push(
          discarded.card,
          ...discarded.evolvedFrom,
          ...discarded.attachedEnergy,
          ...(discarded.tools ?? []),
        );
        logEvent(state, "system", `${discarded.card.name} is discarded (bench reduced to 5).`);
      }
    }
    return ok;
  }

  // Item / Supporter: check resource preconditions before committing the play.
  const block = precheckTrainerEffect(state, player, t, target);
  if (block) return fail(block);
  pl.hand.splice(handIndex, 1);
  applyTrainerEffect(state, player, t, target);
  if (isSupporter) {
    pl.supporterPlayedThisTurn = true;
    pl.lastSupporterNameThisTurn = t.name;
  }
  pl.discard.push(t);
  logEvent(state, player, `plays ${t.name}.`);
  return ok;
}

// Target descriptor for trainer effects that need a target.
export type TrainerTarget =
  | { kind: "inPlay"; instanceId: string }
  | { kind: "oppInPlay"; instanceId: string }
  | { kind: "handCard"; handIndex: number }
  | { kind: "discardCard"; discardIndex: number };

import { applyTrainerEffect, precheckTrainerEffect } from "./trainerEffects";

export function retreat(
  state: GameState,
  player: PlayerId,
  benchIndex: number,
): ActionResult {
  const g = requireMain(state, player);
  if (!g.ok) return g;
  const pl = state.players[player];
  if (pl.retreatedThisTurn) return fail("Already retreated this turn.");
  if (!pl.active) return fail("No Active Pokémon.");
  if (hasStatus(pl.active, "asleep")) return fail("Asleep Pokémon can't retreat.");
  if (hasStatus(pl.active, "paralyzed")) return fail("Paralyzed Pokémon can't retreat.");
  if (
    pl.active.cantRetreatUntilTurn !== undefined &&
    state.turn <= pl.active.cantRetreatUntilTurn
  ) {
    return fail("This Pokémon can't retreat this turn.");
  }
  if (benchIndex < 0 || benchIndex >= pl.bench.length)
    return fail("Invalid bench slot.");
  const cost = effectiveRetreatCost(pl.active);
  const provided = energyProvidedBy(pl.active);
  if (!canPayCost(provided, cost))
    return fail("Not enough Energy to retreat.");
  // Pay by discarding Colorless cost — discard the first N attached energies.
  for (let i = 0; i < cost.length; i++) {
    const e = pl.active.attachedEnergy.shift();
    if (e) pl.discard.push(e);
  }
  const [newActive] = pl.bench.splice(benchIndex, 1);
  const oldActive = pl.active;
  // Retreating clears all Special Conditions from the retreating Pokémon.
  clearAllStatuses(oldActive);
  pl.active = newActive;
  pl.bench.push(oldActive);
  pl.retreatedThisTurn = true;
  logEvent(state, player, `retreats ${oldActive.card.name}; ${newActive.card.name} is now Active.`);
  // Triggered-on-move hooks (Buzzing Boost on new Active, Fall Back to Reload
  // / Zero to Hero on the one that moved to Bench).
  fireTriggeredOnMoveToActive(state, player, newActive);
  fireTriggeredOnMoveToBench(state, player, oldActive);
  return ok;
}

// User-facing action when the game is paused on pendingPromote. Dispatches
// to the continuation queued by the code that triggered the promote:
//   - "endTurn" (default): run end-of-turn cleanup + pass to opponent
//   - "passTurn": skip cleanup (already happened) and pass
//   - null: do nothing more (promote happened mid-main-phase, rare)
export function promoteBenchToActive(
  state: GameState,
  player: PlayerId,
  benchIndex: number,
): ActionResult {
  if (state.pendingPromote !== player)
    return fail("Not waiting for your promote.");
  const pl = state.players[player];
  if (benchIndex < 0 || benchIndex >= pl.bench.length)
    return fail("Invalid bench slot.");
  const [promoted] = pl.bench.splice(benchIndex, 1);
  promoted.playedThisTurn = false;
  pl.active = promoted;
  state.pendingPromote = null;
  state.phase = "main";
  logEvent(state, player, `promotes ${promoted.card.name} to Active.`);
  fireTriggeredOnMoveToActive(state, player, promoted);

  const cont = state.onPromoteResolved;
  state.onPromoteResolved = null;
  if (cont === "endTurn") endTurnRule(state);
  else if (cont === "passTurn") passTurn(state);
  else if (cont === "secondAttack") resumeSecondAttack(state);
  return ok;
}

// Festival Lead + Festival Grounds lets the attacker hit twice. Helper here
// checks the conditions at a given moment.
function hasFestivalLeadTwin(state: GameState, attacker: import("./types").PokemonInPlay): boolean {
  if (state.stadium?.card.name !== "Festival Grounds") return false;
  return (attacker.card.abilities ?? []).some((a) => a.name === "Festival Lead");
}

// Run the damage / effects portion of an attack (one hit). Does not handle
// status checks, cost payment, or turn-ending — callers handle those.
function executeAttackHit(
  state: GameState,
  player: PlayerId,
  attackIndex: number,
): void {
  const pl = state.players[player];
  const atk = pl.active;
  if (!atk) return;
  const move = atk.card.attacks[attackIndex];
  if (!move) return;
  const defOwner = opponentOf(player);
  const def = state.players[defOwner].active;
  let damage = move.damage;
  damage += stadiumAttackBonus(state, atk, def);
  damage += passiveAttackBonus(state, player, atk, def);
  damage += turnAttackBonus(state, player, atk, def);
  if (def) {
    const atkType = atk.card.types[0];
    const weak = def.card.weaknesses?.find((w) => w.type === atkType);
    const res = def.card.resistances?.find((w) => w.type === atkType);
    if (weak && weak.value.startsWith("×")) {
      damage *= parseInt(weak.value.slice(1), 10) || 2;
    }
    if (res && res.value.startsWith("-")) {
      damage = Math.max(0, damage - (parseInt(res.value.slice(1), 10) || 30));
    }
    const reduction = stadiumDamageReduction(state, atk, def);
    const turnRed = turnDamageReduction(state, defOwner, def);
    const total = reduction + turnRed;
    if (total > 0) damage = Math.max(0, damage - total);
  }
  const result = resolveAttackEffects(state, {
    attacker: atk,
    attackerOwner: player,
    defender: def,
    defenderOwner: defOwner,
    move,
    damage,
  });
  damage = result.damage;
  // Survival Brace: cap damage so full-HP defender survives with 10 HP; it
  // discards after triggering.
  let survivalBraceTriggered = false;
  if (def && damage > 0) {
    const before = damage;
    damage = applySurvivalBrace(state, def, damage);
    if (damage !== before) survivalBraceTriggered = true;
  }
  logEvent(state, player, `attacks with ${move.name} for ${damage}.`);
  if (damage > 0) applyDamage(state, defOwner, damage);
  // Spiky Energy — "If the Pokémon this card is attached to is in the Active
  // Spot and is damaged by an attack, put 2 damage counters on the Attacking
  // Pokémon." Fires once per Spiky Energy attached, even on KO.
  if (def && damage > 0) {
    const spikyCount = def.attachedEnergy.filter((e) => e.name === "Spiky Energy").length;
    if (spikyCount > 0) {
      const counter = spikyCount * 20;
      atk.damage += counter;
      logEvent(state, "system", `${atk.card.name} takes ${counter} damage from Spiky Energy.`);
    }
  }
  // Tool "on damage" triggers (Lucky Helmet draw, Punk Helmet counter,
  // Team Rocket's Hypnotizer asleep, Deluxe Bomb counter). Deluxe Bomb
  // self-discards after triggering.
  if (def && damage > 0) {
    const toDiscardAfter: string[] = [];
    for (const act of toolOnDamageActions(state, def, true)) {
      if (act.kind === "drawCards") {
        const d = state.players[defOwner];
        let drawn = 0;
        for (let i = 0; i < act.count; i++) {
          const c = d.deck.shift();
          if (!c) break;
          d.hand.push(c);
          drawn++;
        }
        if (drawn > 0) logEvent(state, defOwner, `draws ${drawn} card(s) from Lucky Helmet.`);
      } else if (act.kind === "counterDamage") {
        atk.damage += act.damage;
        logEvent(state, "system", `${atk.card.name} takes ${act.damage} counter damage.`);
        // Deluxe Bomb is a single-shot item-tool that discards after trigger.
        if (def.tools.some((t) => t.name === "Deluxe Bomb")) toDiscardAfter.push("Deluxe Bomb");
      } else if (act.kind === "applyStatusToAttacker") {
        if (!atk.statuses.includes(act.status)) atk.statuses.push(act.status);
        logEvent(state, "system", `${atk.card.name} is now ${act.status}.`);
      }
    }
    for (const name of toDiscardAfter) {
      const i = def.tools.findIndex((t) => t.name === name);
      if (i >= 0) {
        const [tool] = def.tools.splice(i, 1);
        state.players[defOwner].discard.push(tool);
        logEvent(state, defOwner, `discards ${tool.name} (triggered).`);
      }
    }
  }
  // Discard any Berry Tools on the defender that just triggered.
  if (def && damage > 0) {
    const triggered = triggeredBerryTools(state, atk, def);
    if (triggered.length > 0) {
      for (const name of triggered) {
        const i = def.tools.findIndex((t) => t.name === name);
        if (i >= 0) {
          const [tool] = def.tools.splice(i, 1);
          state.players[defOwner].discard.push(tool);
          logEvent(state, defOwner, `discards ${tool.name} (berry triggered).`);
        }
      }
    }
  }
  // Survival Brace: one-shot tool, discards after trigger.
  if (def && survivalBraceTriggered) {
    const i = def.tools.findIndex((t) => t.name === "Survival Brace");
    if (i >= 0) {
      const [tool] = def.tools.splice(i, 1);
      state.players[defOwner].discard.push(tool);
      logEvent(state, defOwner, `discards ${tool.name} (Survival Brace triggered).`);
    }
  }
  if ((state.phase as string) !== "gameOver") {
    result.postDamage?.();
  }
  if ((state.phase as string) !== "gameOver") {
    resolveBenchKOs(state);
  }
  if ((state.phase as string) !== "gameOver" && pl.active && pl.active.damage >= effectiveMaxHp(pl.active, state)) {
    knockOut(state, player);
  }
}

// Shared post-hit branching — used by both the first hit (in attack) and the
// second hit (resumed by promoteBenchToActive after a KO). Returns true if
// the attack sequence is fully resolved (endTurn already called), false if
// we're paused on a pendingPromote or gameOver.
function finishHit(
  state: GameState,
  player: PlayerId,
  attackIndex: number,
  wasSecond: boolean,
): void {
  // Did the first hit trigger a second-hit eligibility?
  if (!wasSecond) {
    const atk = state.players[player].active;
    if (atk && hasFestivalLeadTwin(state, atk)) {
      state.pendingSecondAttack = { player, attackIndex };
      logEvent(state, "system", "Festival Lead: attack continues for a second hit.");
      if (state.pendingPromote) {
        // Defender KO'd → wait for promote, then run the second hit.
        state.onPromoteResolved = "secondAttack";
        return;
      }
      // No promote pause → run the second hit inline.
      state.pendingSecondAttack = null;
      executeAttackHit(state, player, attackIndex);
      finishHit(state, player, attackIndex, true);
      return;
    }
  }
  // End of sequence.
  if (state.pendingPromote) {
    state.onPromoteResolved = "endTurn";
    return;
  }
  const phaseAfter: string = state.phase;
  if (phaseAfter !== "gameOver") endTurnRule(state);
}

export function attack(
  state: GameState,
  player: PlayerId,
  attackIndex: number,
): ActionResult {
  if (state.phase === "gameOver") return fail("Game is over.");
  if (state.activePlayer !== player) return fail("Not your turn.");
  if (state.phase !== "main") return fail("Not in main phase.");
  if (state.firstTurnNoAttack) return fail("No attacking on the first turn.");
  const pl = state.players[player];
  const atk = pl.active;
  if (!atk) return fail("No Active Pokémon.");
  if (hasStatus(atk, "asleep")) return fail("Asleep Pokémon can't attack.");
  if (hasStatus(atk, "paralyzed")) return fail("Paralyzed Pokémon can't attack.");
  if (atk.cantAttackUntilTurn !== undefined && state.turn <= atk.cantAttackUntilTurn) {
    return fail("This Pokémon can't attack this turn.");
  }
  const move = atk.card.attacks[attackIndex];
  if (!move) return fail("No such attack.");
  const provided = energyProvidedBy(atk);
  const effectiveCost = effectiveAttackCost(state, atk, move.cost);
  if (!canPayCost(provided, effectiveCost))
    return fail("Not enough Energy for that attack.");

  // Confusion: flip on attack; on tails, attack fails and 30 damage to self.
  if (hasStatus(atk, "confused")) {
    const heads = flipCoin(state, `${atk.card.name} confusion flip`);
    if (!heads) {
      atk.damage += 30;
      logEvent(state, "system", `${atk.card.name} hurts itself in confusion (30 damage).`);
      if (atk.damage >= effectiveMaxHp(atk, state)) knockOut(state, player);
      if (state.pendingPromote) {
        state.onPromoteResolved = "endTurn";
        return ok;
      }
      const phase2: string = state.phase;
      if (phase2 !== "gameOver") endTurnRule(state);
      return ok;
    }
  }

  executeAttackHit(state, player, attackIndex);
  finishHit(state, player, attackIndex, false);
  // Per-attack overrides (snipe target, etc.) are single-use — consumed.
  state.snipeTargetOverride = null;
  return ok;
}

// Resume a queued Festival Lead second hit after the opponent has promoted a
// new Active. Called by promoteBenchToActive when onPromoteResolved is
// "secondAttack".
export function resumeSecondAttack(state: GameState): void {
  const queued = state.pendingSecondAttack;
  if (!queued) return;
  const { player, attackIndex } = queued;
  state.pendingSecondAttack = null;
  executeAttackHit(state, player, attackIndex);
  finishHit(state, player, attackIndex, true);
  state.snipeTargetOverride = null;
}

export function endTurn(state: GameState, player: PlayerId): ActionResult {
  if (state.activePlayer !== player) return fail("Not your turn.");
  if (state.phase !== "main") return fail("Can't end turn now.");
  endTurnRule(state);
  return ok;
}

// Re-export commonly used helpers for consumers.
export { isBasic, isPokemon } from "./rules";
export type { Card, PokemonCard, EnergyCard, TrainerCard, EnergyType, PokemonInPlay };
