import type {
  Card,
  EnergyCard,
  EnergyType,
  GameState,
  PlayerId,
  PlayerState,
  PokemonCard,
  PokemonInPlay,
  TrainerCard,
} from "./types";
import {
  applyDamage,
  applyEvolveSideEffects,
  canPayCost,
  clearAllStatuses,
  endTurn as endTurnRule,
  flipCoin,
  hasStatus,
  isBasic,
  isPlayersFirstTurn,
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
import { getAttackEffects } from "../data/effectPatterns";
import {
  abilitiesActiveOnInstance,
  applySurvivalBrace,
  applyAbilityKoSurvival,
  actionBlockedByOppActive,
  benchPlacementDamage,
  canEvolveOnPlayTurn,
  effectiveAttackCost,
  effectiveAttacks,
  effectiveMaxHp,
  effectiveRetreatCost,
  effectiveTypes,
  effectiveWeaknesses,
  energyPoolForCost,
  maxBenchSize,
  passiveAttackBonus,
  stadiumAttackBonus,
  stadiumDamageReduction,
  passiveDamageReduction,
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

// Returns true if this Supporter has an explicit "may use this card during
// your first turn" rules text — a per-card exception to the standard T1
// supporter ban for the going-first player. Cards with this exception go
// in this list.
const T1_SUPPORTER_EXCEPTIONS = new Set<string>([
  "Team Rocket's Proton",
  "Carmine",
]);
function supporterAllowsFirstTurn(card: import("./types").TrainerCard): boolean {
  return T1_SUPPORTER_EXCEPTIONS.has(card.name);
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
  // Hero's Spirit (Palafin Hero Form) — "Put this Pokémon into play only with
  // the effect of Palafin's Zero to Hero Ability." It can't be benched
  // directly from hand.
  if ((card.abilities ?? []).some((a) => a.name === "Hero's Spirit")) {
    return fail("Hero's Spirit: can only enter play via Zero to Hero.");
  }
  // Potent Glare (opp's Active) — "Your opponent can't play any Pokémon that
  // has an Ability from their hand, except for Team Rocket's Pokémon." We
  // treat this as a mid-turn block (but Pokémon already in play with the
  // ability are unaffected).
  {
    const oppId: PlayerId = player === "p1" ? "p2" : "p1";
    const oppActive = state.players[oppId].active;
    if (oppActive && (oppActive.card.abilities ?? []).some((a) => a.name === "Potent Glare")) {
      const isTeamRocket = card.name.startsWith("Team Rocket's ");
      const cardHasAbility = (card.abilities ?? []).length > 0;
      if (cardHasAbility && !isTeamRocket) {
        return fail("Potent Glare: can't play that Pokémon while opp's Active has Potent Glare.");
      }
    }
  }
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
  // Rainbow DNA (Eevee ex) — can evolve into any Pokémon ex that evolves from
  // Eevee, regardless of the played card's stated evolvesFrom (provided card
  // is a Pokémon ex whose evolution chain originates at Eevee). Per text,
  // can't be used during T1 or the turn played; that's enforced below by the
  // generic playedThisTurn / turn 1 rules.
  const targetHasRainbowDNA =
    (target.card.abilities ?? []).some((a) => a.name === "Rainbow DNA");
  const cardIsEx = (card.subtypes ?? []).some((s) => /^(?:ex|EX)$/.test(s));
  const cardEvolvesFromEevee =
    card.evolvesFrom === "Eevee" || card.evolvesFrom?.endsWith(" Eevee") === true;
  const rainbowMatch = targetHasRainbowDNA && cardIsEx && cardEvolvesFromEevee;
  if (target.card.name !== card.evolvesFrom && !rainbowMatch)
    return fail(`${card.name} evolves from ${card.evolvesFrom}, not ${target.card.name}.`);
  // Forest of Vitality (Grass→Grass) overrides BOTH the played-this-turn
  // rule and the once-per-instance evolution rule, so Chikorita → Bayleef →
  // Meganium can chain on a single FoV turn. Compute the override first so
  // the standard rules below can defer to it.
  const fovChain = canEvolveOnPlayTurn(state, target, card);
  // Boosted Evolution (Eevee) / Stimulated Evolution (Shelmet w/ Karrablast)
  // / Fighting Roar (target Pokémon that evolves only when opp Active is ex)
  // — let this Pokémon evolve on turn 1 / the turn it was played.
  const ownerAllies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
  const oppActive = state.players[player === "p1" ? "p2" : "p1"].active;
  const oppActiveIsEx = oppActive
    ? (oppActive.card.subtypes ?? []).some((s) => /^(?:ex|EX)$/.test(s))
    : false;
  const allowsTurn1 = (target.card.abilities ?? []).some(
    (a) =>
      a.name === "Boosted Evolution" ||
      (a.name === "Stimulated Evolution" && ownerAllies.some((p) => p.card.name === "Karrablast")) ||
      (a.name === "Fighting Roar" && oppActiveIsEx),
  );
  // Once-per-instance rule — bypassed by FoV's Grass→Grass chain.
  if (target.evolvedThisTurn && !fovChain) return fail("Already evolved this turn.");
  if (isPlayersFirstTurn(state, player) && !allowsTurn1)
    return fail("No evolving on your first turn.");
  // Played-this-turn rule — bypassed by FoV (Grass→Grass) or turn-1 abilities.
  if (target.playedThisTurn && !fovChain && !allowsTurn1)
    return fail("Can't evolve a Pokémon played this turn.");

  pl.hand.splice(handIndex, 1);
  target.evolvedFrom.push(target.card);
  target.card = card;
  applyEvolveSideEffects(state, target);
  logEvent(state, player, `evolves into ${card.name}.`);

  // Darkest Impulse (Mega Banette etc.) — opp-side reaction: when YOU evolve
  // a Pokémon, opp's allies with this ability place 4 damage counters on
  // the just-evolved Pokémon. Doesn't stack — fires only once even if
  // multiple holders are in play.
  {
    const oppId: PlayerId = player === "p1" ? "p2" : "p1";
    const oppAllies = [state.players[oppId].active, ...state.players[oppId].bench]
      .filter((p): p is PokemonInPlay => !!p);
    const triggers = oppAllies.some((q) =>
      (q.card.abilities ?? []).some((a) => a.name === "Darkest Impulse"),
    );
    if (triggers) {
      target.damage += 40;
      logEvent(state, oppId, `Darkest Impulse: 4 counters on ${target.card.name}.`);
    }
  }

  // Inviting Wink (Cacnea / Cacturne) — when this evolves, you may have opp
  // reveal their hand and put any Basic Pokémon you find there onto their
  // bench. Auto-applied: opp's Basic Pokémon in hand all bench (capped at
  // 5 slots). Skipped silently if opp's bench is full.
  if ((target.card.abilities ?? []).some((a) => a.name === "Inviting Wink")) {
    const oppId: PlayerId = player === "p1" ? "p2" : "p1";
    const opp = state.players[oppId];
    const benchSlotsAvailable = 5 - opp.bench.length;
    if (benchSlotsAvailable > 0) {
      const basicIdxs: number[] = [];
      for (let i = 0; i < opp.hand.length; i++) {
        const c = opp.hand[i];
        if (c.supertype === "Pokémon" && (c.subtypes ?? []).includes("Basic")) {
          basicIdxs.push(i);
          if (basicIdxs.length >= benchSlotsAvailable) break;
        }
      }
      if (basicIdxs.length > 0) {
        // Splice in descending order to keep prior indexes valid.
        for (const i of basicIdxs.sort((a, b) => b - a)) {
          const [c] = opp.hand.splice(i, 1);
          opp.bench.push(makePokemonInPlay(c as PokemonCard));
        }
        logEvent(state, player, `Inviting Wink: benches ${basicIdxs.length} Basic from ${opp.name}'s hand.`);
      }
    }
  }

  // Fire any triggered-on-evolve ability the evolved card has (e.g.
  // Noctowl's Jewel Seeker, Alakazam's Psychic Draw, Hariyama's Heave-Ho
  // Catcher).
  fireTriggeredOnEvolve(state, player, target);
  // Note: the current Mega Evolution mechanic (Mega Evolution ex set onward)
  // does NOT end your turn — the only Mega-specific rule on these cards is
  // "When your Mega Evolution Pokémon ex is Knocked Out, your opponent
  // takes 3 Prize cards." That's enforced via `prizeValue` in rules.ts.
  // The XY-era "Mega Evolution ends your turn" rule is no longer in effect.
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
  // Trevenant "Cursed Root" — defender can't have Energy attached from
  // opp's hand during opp's next turn. The flag is set on the defender at
  // attack-time; the gate clears with end-of-turn cleanup as the turn
  // counter advances past `cantAttachEnergyFromHandUntilTurn`.
  {
    const lockedUntil = (target as typeof target & { cantAttachEnergyFromHandUntilTurn?: number })
      .cantAttachEnergyFromHandUntilTurn;
    if (lockedUntil !== undefined && state.turn <= lockedUntil) {
      return fail(`${target.card.name} can't have Energy attached from your hand this turn.`);
    }
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
    const cap = maxBenchSize(state, pl.bench, pl.active);
    if (target.card.types.includes("Psychic") && pl.bench.length < cap) {
      const pred = (c: Card) =>
        c.supertype === "Pokémon" && c.subtypes.includes("Basic") && c.types.includes("Psychic");
      const slots = Math.min(2, cap - pl.bench.length);
      if (!setDeckSearchPick(state, player, pred, slots, "Telepathic Psychic Energy: pick up to 2 Basic Psychic Pokémon to Bench", { toBench: true })) {
        logEvent(state, player, "finds no Basic Psychic Pokémon.");
      }
    }
  }
  // On-attach ability reactions:
  // - Auto Heal (your Active with this ability triggers when YOU attach):
  //   heal 90 from the Pokémon you attached to.
  // - Gnawing Curse (opp's Pokémon with this ability triggers when YOU attach):
  //   place 2 damage counters on the Pokémon you attached to.
  {
    const pAllies = [pl.active, ...pl.bench].filter((q): q is import("./types").PokemonInPlay => !!q);
    for (const ally of pAllies) {
      if (pl.active !== ally) continue; // Auto Heal is Active-only.
      for (const ab of ally.card.abilities ?? []) {
        if (ab.name === "Auto Heal") {
          if (target.damage > 0) {
            const healed = Math.min(90, target.damage);
            target.damage -= healed;
            logEvent(state, player, `Auto Heal: heals ${healed} from ${target.card.name}.`);
          }
        }
      }
    }
    const oppId: PlayerId = player === "p1" ? "p2" : "p1";
    const oppAllies = [state.players[oppId].active, ...state.players[oppId].bench]
      .filter((q): q is import("./types").PokemonInPlay => !!q);
    for (const oppAlly of oppAllies) {
      for (const ab of oppAlly.card.abilities ?? []) {
        if (ab.name === "Gnawing Curse") {
          target.damage += 20;
          logEvent(state, oppId, `Gnawing Curse: 2 counters on ${target.card.name}.`);
        }
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
    // Exception: certain Supporters are explicitly playable on T1 (e.g.,
    // Team Rocket's Proton: "If you go first, you may use this card during
    // your first turn."). Mirror the Debut Performance attack-ban exception
    // pattern at the attack site.
    if (state.firstTurnNoAttack && !supporterAllowsFirstTurn(t))
      return fail("First player can't play a Supporter on the first turn.");
  }

  // Budew's Itchy Pollen (and similar) locks the opponent out of Items this turn.
  if (t.subtypes.includes("Item") && pl.itemsBlockedNextTurn) {
    return fail("Can't play Item cards this turn (Itchy Pollen).");
  }

  // Active-only ability blocks: Tyranitar Daunting Gaze (Items), Jellicent ex
  // Oceanic Curse (Items + Tools), Copperajah Massive Body (Stadiums).
  const isToolSub = t.subtypes.includes("Pokémon Tool") || t.subtypes.includes("Tool");
  if (t.subtypes.includes("Item") && actionBlockedByOppActive(state, player, "Item")) {
    return fail("Opponent's Active Pokémon prevents playing Item cards.");
  }
  if (isToolSub && actionBlockedByOppActive(state, player, "Pokémon Tool")) {
    return fail("Opponent's Active Pokémon prevents playing Pokémon Tools.");
  }
  if (t.subtypes.includes("Stadium") && actionBlockedByOppActive(state, player, "Stadium")) {
    return fail("Opponent's Active Pokémon prevents playing Stadium cards.");
  }

  // Genesect "ACE Nullifier" — "If this Pokémon has a Pokémon Tool attached,
  // your opponent can't play any ACE SPEC cards from their hand." Block the
  // play of ACE SPEC trainers when the opponent has a Genesect+Tool in play
  // with its Ability active.
  if (t.subtypes.includes("ACE SPEC")) {
    const oppId: PlayerId = player === "p1" ? "p2" : "p1";
    const opp = state.players[oppId];
    const blocker = [opp.active, ...opp.bench].find(
      (p) =>
        !!p &&
        p.tools.length > 0 &&
        (p.card.abilities ?? []).some((a) => a.name === "ACE Nullifier") &&
        abilitiesActiveOnInstance(state, p),
    );
    if (blocker) {
      return fail(`${blocker.card.name}'s ACE Nullifier blocks ACE SPEC cards.`);
    }
  }

  // Tool: must be attached to a Pokémon in play with no Tool already.
  // Multi Adapter (Rotom V) — "Each of your Pokémon that has 'Rotom' in its
  // name may have up to 2 Pokémon Tool cards attached." Bumps the cap to 2
  // for Rotom-named Pokémon when any owner ally has the ability in play.
  if (isTool) {
    const targetId = target?.kind === "inPlay" ? target.instanceId : null;
    if (!targetId) return fail("Pick a Pokémon to attach this Tool to.");
    const p = findInPlayByInstance(state, player, targetId);
    if (!p) return fail("Target not in play.");
    let maxTools = 1;
    if (p.card.name.includes("Rotom")) {
      const allies = [pl.active, ...pl.bench].filter((x): x is PokemonInPlay => !!x);
      if (allies.some((a) => (a.card.abilities ?? []).some((ab) => ab.name === "Multi Adapter"))) {
        maxTools = 2;
      }
    }
    if ((p.tools?.length ?? 0) >= maxTools)
      return fail(`That Pokémon already has ${maxTools === 1 ? "a Tool" : "the maximum Tools"} attached.`);
    pl.hand.splice(handIndex, 1);
    p.tools.push(t);
    logEvent(state, player, `attaches ${t.name} to ${p.card.name}.`);
    // Ancient Booster Energy Capsule: "recovers from all Special Conditions"
    // when attached to an Ancient Pokémon.
    if (
      t.name === "Ancient Booster Energy Capsule" &&
      (p.card.subtypes ?? []).includes("Ancient") &&
      p.statuses.length > 0
    ) {
      p.statuses = [];
      logEvent(state, "system", `${p.card.name} recovers from all Special Conditions (Ancient Booster Energy Capsule).`);
    }
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
    // Ange Floette can only be played by discarding Prism Tower from play.
    // Same-turn replacement is fine because Prism Tower and Ange Floette
    // have different names (the same-name gate above doesn't trigger).
    if (t.name === "Ange Floette" &&
        (!state.stadium || state.stadium.card.name !== "Prism Tower")) {
      return fail("Ange Floette can only be played by discarding Prism Tower.");
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
  if (t.subtypes.includes("Item")) {
    if (!pl.itemsPlayedThisTurn) pl.itemsPlayedThisTurn = [];
    pl.itemsPlayedThisTurn.push(t.name);
  }
  // Antique Fossils transform into Bench Pokémon — the card itself rides
  // along on the new PokemonInPlay (its TrainerCard surfaces in p.card via
  // the synthesized Pokémon). It must NOT also go to the discard pile, or
  // the engine would have two copies (one in play, one discarded). The
  // discard happens later when the Fossil leaves play (KO / voluntary
  // discard / KO-prize-grab — same flow as any Pokémon).
  if (t.effectId !== "playFossilAsBasic") {
    pl.discard.push(t);
  }
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
  // Antique Fossils — "This card can't retreat."
  if ((pl.active.card.subtypes ?? []).includes("Fossil")) {
    return fail("Fossil Pokémon can't retreat.");
  }
  // Roxie's Performance — opp set this turn-scoped flag during their last
  // turn; opp's Poisoned Pokémon can't retreat during this turn (the
  // flag is on the opp's PlayerState, gating OUR retreat when we're
  // poisoned). Cleared in endTurn cleanup.
  {
    const oppId: PlayerId = player === "p1" ? "p2" : "p1";
    const opp = state.players[oppId];
    const flag = (opp as PlayerState & { poisonedOppCantRetreatNextTurn?: boolean }).poisonedOppCantRetreatNextTurn;
    if (flag && hasStatus(pl.active, "poisoned")) {
      return fail("Roxie's Performance: Poisoned Pokémon can't retreat this turn.");
    }
  }
  if (benchIndex < 0 || benchIndex >= pl.bench.length)
    return fail("Invalid bench slot.");
  // Pass state so bench-wide ability discounts apply (Latias ex Skyliner,
  // Heatran Metal Bridge, Secret Forest Path stadium). Without state, only
  // tool/stadium reductions read off the active itself would land.
  const cost = effectiveRetreatCost(pl.active, state);
  const provided = energyPoolForCost(pl.active, state);
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

  // If another player is queued to promote (both-Active-KO), pop them next
  // and stay in the promoteActive phase. The original onPromoteResolved
  // continuation runs only after every queued promote drains. Skip if the
  // game ended during the just-completed promote (fireTriggeredOnMoveToActive
  // can cause a KO that ends the game).
  if ((state.phase as string) !== "gameOver" && state.pendingPromoteQueue.length > 0) {
    state.pendingPromote = state.pendingPromoteQueue.shift()!;
    state.phase = "promoteActive";
    return ok;
  }

  // Heavy Baton (mid-KO interactive picker): if the just-promoted player
  // had stashed energies waiting for a Bench target, fire the picker now.
  // This runs BEFORE the onPromoteResolved continuation so the player has
  // to place the energies before the turn flow resumes.
  if (
    (state.phase as string) !== "gameOver" &&
    state.pendingHeavyBaton &&
    state.pendingHeavyBaton.ownerId === player
  ) {
    const owner = state.players[player];
    if (owner.bench.length > 0) {
      state.pendingInPlayTarget = {
        player,
        label: `Heavy Baton: pick a Bench Pokémon to receive ${state.pendingHeavyBaton.energies.length} Energy`,
        scope: "own",
        slot: "bench",
        filter: "anyPokemon",
        action: { kind: "heavyBatonPick" },
      };
      // Don't run the continuation yet — the picker resolution does that.
      return ok;
    }
    // No bench (rare race): drop the energies to discard.
    owner.discard.push(...state.pendingHeavyBaton.energies);
    state.pendingHeavyBaton = null;
  }

  // Amulet of Hope (mid-KO interactive picker): open the deck-search picker
  // for up to 3 cards once promote ordering is stable. Picker's
  // `endTurnOnResolve` is NOT set — the resolver chains back into the
  // onPromoteResolved continuation via the same shape Heavy Baton uses.
  if (
    (state.phase as string) !== "gameOver" &&
    state.pendingAmuletOfHope &&
    state.pendingAmuletOfHope.ownerId === player
  ) {
    state.pendingAmuletOfHope = null;
    if (setDeckSearchPick(
      state, player, () => true, 3,
      "Amulet of Hope: pick up to 3 cards from your deck",
      { afterPick: { kind: "amuletOfHopeResume" } },
    )) {
      return ok;
    }
    // No cards in deck (extremely rare) — fall through to the continuation.
  }

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
  const move = effectiveAttacks(atk)[attackIndex];
  if (!move) return;
  const defOwner = opponentOf(player);
  const def = state.players[defOwner].active;
  // Dunsparce "Dig" (and similar) — if the defender is shielded during this
  // turn, the attack does nothing at all: no damage, no non-damage effects.
  if (def?.shieldedUntilTurn !== undefined && state.turn <= def.shieldedUntilTurn) {
    logEvent(state, "system", `${def.card.name} is shielded — ${move.name} has no effect.`);
    return;
  }
  // Subtype-gated shield (Golbat "Covert Flight" — only blocks Basic
  // attackers).
  if (def) {
    const sub = (def as typeof def & {
      shieldNextTurnFromSubtype?: { turn: number; subtype: string };
    }).shieldNextTurnFromSubtype;
    if (sub && state.turn <= sub.turn && atk.card.subtypes.includes(sub.subtype)) {
      logEvent(
        state,
        "system",
        `${def.card.name} is shielded vs ${sub.subtype} — ${move.name} has no effect.`,
      );
      return;
    }
  }
  // Ability-gated shield (Deoxys "Psy Protect" — only blocks attackers
  // that have any Abilities).
  if (def) {
    const abilityShield = (def as typeof def & {
      shieldNextTurnFromAbility?: number;
    }).shieldNextTurnFromAbility;
    if (
      abilityShield !== undefined &&
      state.turn <= abilityShield &&
      (atk.card.abilities ?? []).length > 0
    ) {
      logEvent(
        state,
        "system",
        `${def.card.name} is shielded vs ability attackers — ${move.name} has no effect.`,
      );
      return;
    }
  }
  // Snapshot the defender's in-play Pokémon names BEFORE this attack so we
  // can record which ones get KO'd "by damage from an attack". Used by
  // predicates like Hop's Trevenant Horrifying Revenge that check
  // `yourPokemonKoedByAttackLastOppTurnNames`. Status/recoil/effect KOs
  // happen outside this snapshot window, so they correctly don't get
  // counted as attack-KOs.
  const defInPlayBefore: Array<{ instanceId: string; name: string }> = [];
  {
    const dp = state.players[defOwner];
    if (dp.active) defInPlayBefore.push({ instanceId: dp.active.instanceId, name: dp.active.card.name });
    for (const b of dp.bench) defInPlayBefore.push({ instanceId: b.instanceId, name: b.card.name });
  }
  // Damage pipeline — order matters per TCG rules:
  //   1. Base damage from the attack
  //   2. Attacker-side additions (Stadium / Tool / ability passives, turn
  //      bonuses like Black Belt's Training)
  //   3. Attack-effect additions (per-bench, per-energy, per-damage-counter,
  //      coin-flip bonuses) — resolved inside resolveAttackEffects
  //   4. Weakness (×) — applied to the full summed damage
  //   5. Resistance (−) — subtracted from the weakness-adjusted damage
  //   6. Defender-side reductions (Stadium, Tool Berries, Jasmine's Gaze,
  //      Iron Defender)
  //
  // Doing W/R after step 3 is critical: e.g., Dipplin "Do the Wave" adds
  // +20 per bench inside resolveAttackEffects, and that full total must be
  // doubled against a Grass-weak Lunatone, not just the base.
  // Resolve effects up front so any baseDamageOverride (e.g. "20×" zeros the
  // base for per-energy / per-bench scaling) lands before we read move.damage.
  getAttackEffects(move);
  let damage = move.damage;
  damage += stadiumAttackBonus(state, atk, def);
  damage += passiveAttackBonus(state, player, atk, def);
  damage += turnAttackBonus(state, player, atk, def);
  // "During your next turn, this Pokémon's <Name> attack does +N damage."
  // Set by selfNextTurnAttackBonus the previous turn.
  {
    const bag = atk as typeof atk & {
      nextTurnAttackBonuses?: Record<string, { amount: number; turn: number }>;
    };
    const slot = bag.nextTurnAttackBonuses?.[move.name];
    if (slot && state.turn <= slot.turn) {
      damage += slot.amount;
    }
  }
  // "During your next turn, attacks used by this Pokémon do +N damage to
  // your opponent's Active Pokémon." (Kilowattrel Wind Power Charge,
  // Donphan No Reprieve.) Set by selfNextTurnAllAttacksBonus the previous
  // turn — applies broadly to ALL attacks during this turn.
  {
    const bag = atk as typeof atk & {
      allAttackBonusUntilTurn?: { turn: number; bonus: number };
    };
    if (bag.allAttackBonusUntilTurn && state.turn <= bag.allAttackBonusUntilTurn.turn) {
      damage += bag.allAttackBonusUntilTurn.bonus;
    }
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
  if (def && damage > 0) {
    const atkTypes = effectiveTypes(atk.card, atk);
    // effectiveWeaknesses honors Fairy Zone (opp Dragons get Psychic weakness).
    const weak = effectiveWeaknesses(def, state).find((w) => atkTypes.includes(w.type));
    const res = def.card.resistances?.find((w) => atkTypes.includes(w.type));
    const defenderIgnoresWeakness =
      def.noWeaknessUntilTurn !== undefined && state.turn <= def.noWeaknessUntilTurn;
    if (!result.ignoreWeakness && !defenderIgnoresWeakness && weak && weak.value.startsWith("×")) {
      const mult = parseInt(weak.value.slice(1), 10) || 2;
      damage *= mult;
      logEvent(
        state,
        "system",
        `Weakness: ${def.card.name} takes ×${mult} from ${weak.type} attacks.`,
      );
    }
    if (!result.ignoreResistance && res && res.value.startsWith("-")) {
      const red = parseInt(res.value.slice(1), 10) || 30;
      damage = Math.max(0, damage - red);
      logEvent(
        state,
        "system",
        `Resistance: ${def.card.name} reduces ${res.type} damage by ${red}.`,
      );
    }
    if (!result.ignoreOppEffects) {
      const reduction = stadiumDamageReduction(state, atk, def);
      const turnRed = turnDamageReduction(state, defOwner, def);
      const passiveRed = passiveDamageReduction(state, defOwner, def, atk);
      const total = reduction + turnRed + passiveRed;
      if (total > 0) damage = Math.max(0, damage - total);
    }
  }
  // Survival Brace: cap damage so full-HP defender survives with 10 HP; it
  // discards after triggering. Skipped when the attack carries
  // `ignoreOppEffects` (Dudunsparce ex Destructive Drill / Crustle Superb
  // Scissors / etc.) — those bypass effects on opp Pokémon entirely.
  let survivalBraceTriggered = false;
  if (def && damage > 0 && !result.ignoreOppEffects) {
    const before = damage;
    damage = applySurvivalBrace(state, def, damage);
    if (damage !== before) survivalBraceTriggered = true;
  }
  // Sturdy / Focus Sash equivalents (passive abilities): cap damage so the
  // defender survives at 10 HP. Predicates handle "only at full HP" or coin
  // flip variants. Same `ignoreOppEffects` bypass.
  if (def && damage > 0 && !result.ignoreOppEffects) {
    damage = applyAbilityKoSurvival(state, def, damage);
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
  // Active-only on-damage abilities: Poison Point / Incandescent Body
  // (status), Counterattacking Crest (counter damage), Spiteful Swirl
  // (1 counter on attacker, gated on Active being a Darkness Pokémon).
  if (def && damage > 0 && state.players[defOwner].active === def) {
    for (const a of (def.card.abilities ?? [])) {
      if (a.name === "Poison Point") {
        if (!atk.statuses.includes("poisoned")) atk.statuses.push("poisoned");
        logEvent(state, "system", `Poison Point: ${atk.card.name} is now Poisoned.`);
      } else if (a.name === "Incandescent Body") {
        if (!atk.statuses.includes("burned")) atk.statuses.push("burned");
        logEvent(state, "system", `Incandescent Body: ${atk.card.name} is now Burned.`);
      } else if (a.name === "Counterattacking Crest") {
        atk.damage += 50;
        logEvent(state, "system", `Counterattacking Crest: ${atk.card.name} takes 50 counter damage.`);
      } else if (a.name === "Spiteful Swirl") {
        if (def.card.types.includes("Darkness")) {
          atk.damage += 10;
          logEvent(state, "system", `Spiteful Swirl: ${atk.card.name} takes 10 counter damage.`);
        }
      } else if (a.name === "Pummeling Payback") {
        // Orthworm ex — 2 counters per Metal Energy attached.
        const metal = def.attachedEnergy.filter((e) => e.provides.includes("Metal")).length;
        if (metal > 0) {
          atk.damage += metal * 20;
          logEvent(state, "system", `Pummeling Payback: ${atk.card.name} takes ${metal * 20} damage.`);
        }
      } else if (a.name === "Counterattack" || a.name === "Counterattack Quills" || a.name === "Automated Combat") {
        atk.damage += 30;
        logEvent(state, "system", `${a.name}: ${atk.card.name} takes 30 counter damage.`);
      } else if (a.name === "Needle Armor") {
        // me4 Chesnaught — place 3 damage counters on the Attacking Pokémon
        // for each Grass Energy attached to this Pokémon.
        const grass = def.attachedEnergy.filter((e) => e.provides.includes("Grass")).length;
        if (grass > 0) {
          atk.damage += grass * 30;
          logEvent(state, "system", `Needle Armor: ${atk.card.name} takes ${grass * 30} counter damage.`);
        }
      } else if (a.name === "Exploding Needles") {
        // Only fires when this Active is KO'd by the incoming damage.
        if (def.damage >= effectiveMaxHp(def, state)) {
          atk.damage += 60;
          logEvent(state, "system", `Exploding Needles: ${atk.card.name} takes 60 counter damage.`);
        }
      } else if (a.name === "Shell Spikes") {
        // Discard 1 energy from the attacker (random; AI doesn't pick).
        if (atk.attachedEnergy.length > 0) {
          const removed = atk.attachedEnergy.shift()!;
          state.players[player].discard.push(removed);
          logEvent(state, "system", `Shell Spikes: ${atk.card.name} loses ${removed.name}.`);
        }
      } else if (a.name === "Smog Signals") {
        // When in Active and damaged, search deck for up to 2 Koffing-named
        // Pokémon and put them on the bench. Auto-applies for AI; for the
        // human, the deck-search infrastructure could open a picker but we
        // keep it auto for the on-damaged path.
        const defPl = state.players[defOwner];
        if (defPl.bench.length < 5) {
          let placed = 0;
          for (let i = 0; i < defPl.deck.length && placed < 2 && defPl.bench.length < 5; ) {
            const c = defPl.deck[i];
            if (c.supertype === "Pokémon" && c.name.includes("Koffing")) {
              defPl.deck.splice(i, 1);
              defPl.bench.push(makePokemonInPlay(c as PokemonCard));
              placed++;
            } else i++;
          }
          if (placed > 0) {
            logEvent(state, defOwner, `Smog Signals: benches ${placed} Koffing-line Pokémon.`);
            // Shuffle remaining deck.
            const arr = defPl.deck;
            for (let i = arr.length - 1; i > 0; i--) {
              const j = state.rng.int(i + 1);
              [arr[i], arr[j]] = [arr[j], arr[i]];
            }
          }
        }
      }
    }
  }
  // Bench-side on-damaged: Spiteful Swirl on Active fires already; some
  // abilities ("Exploding Needles") fire ONLY on KO — handled in postDamage
  // path below where KO is detected.
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
      } else if (act.kind === "moveEnergyAttackerToAttackerBench") {
        // Handheld Fan: move 1 Energy from the attacker to one of the
        // attacker's Bench Pokémon. Even if our holder is KO'd by the
        // hit, this still fires (per card text "even if this Pokémon is
        // Knocked Out").
        const attackerSide = state.players[player];
        const defenderSide = state.players[defOwner];
        if (atk.attachedEnergy.length === 0 || attackerSide.bench.length === 0) {
          // No legal move — skip silently.
        } else if (defenderSide.isAI || attackerSide.bench.length === 1) {
          // AI defender or single bench target: auto-pick the first Energy
          // and the first bench Pokémon.
          const en = atk.attachedEnergy.shift()!;
          attackerSide.bench[0].attachedEnergy.push(en);
          logEvent(
            state,
            "system",
            `Handheld Fan: ${en.name} moves from ${atk.card.name} to ${attackerSide.bench[0].card.name}.`,
          );
        } else {
          // Human defender + 2+ bench: defer the move to a defender-side
          // picker. finishHit() opens the prompt and gates endTurn on it.
          state.pendingHandheldFan = { defenderId: defOwner, attackerSideId: player };
        }
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
  // Some post-hooks add damage directly to the defender's Active (e.g.,
  // Alakazam "Powerful Hand" stacking counters per hand card, or Black
  // Kyurem's conditional KO). The applyDamage() path only runs the active-KO
  // check when damage came in via the regular `damage > 0` branch, so we
  // need an explicit check here too.
  if ((state.phase as string) !== "gameOver" && def) {
    const defPl = state.players[defOwner];
    if (defPl.active === def && def.damage >= effectiveMaxHp(def, state)) {
      knockOut(state, defOwner);
    }
  }
  if ((state.phase as string) !== "gameOver") {
    resolveBenchKOs(state);
  }
  if ((state.phase as string) !== "gameOver" && pl.active && pl.active.damage >= effectiveMaxHp(pl.active, state)) {
    knockOut(state, player);
  }
  // Diff defender's in-play before/after to record which of THEIR Pokémon
  // got KO'd specifically by this attack (i.e. damage from this attack
  // resolved into a KO somewhere in the chain above). Names go onto the
  // defender's `yourPokemonKoedByAttackLastOppTurnNames`. Predicates like
  // Hop's Trevenant Horrifying Revenge consume this list on the defender's
  // NEXT turn (they're now the attacker; the field still holds the names
  // from the prior opp turn until end-of-turn cleanup clears it).
  {
    const dp = state.players[defOwner];
    const stillInPlay = new Set<string>();
    if (dp.active) stillInPlay.add(dp.active.instanceId);
    for (const b of dp.bench) stillInPlay.add(b.instanceId);
    for (const before of defInPlayBefore) {
      if (!stillInPlay.has(before.instanceId)) {
        dp.yourPokemonKoedByAttackLastOppTurnNames.push(before.name);
      }
    }
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
  if (
    state.pendingInPlayTarget &&
    (state.pendingInPlayTarget.action.kind === "distributeDamage" ||
      state.pendingInPlayTarget.action.kind === "attachEnergyFromDiscardPicker") &&
    state.pendingInPlayTarget.action.finishTurn
  ) {
    return;
  }
  // Handheld Fan: human defender hasn't picked the bench target yet. Open
  // the picker now and gate endTurn on it (resolveInPlayTarget's
  // "handheldFanPick" case fires endTurn after the move applies).
  if (state.pendingHandheldFan) {
    const fan = state.pendingHandheldFan;
    state.pendingInPlayTarget = {
      player: fan.defenderId,
      label: "Handheld Fan: pick a Benched Pokémon (opponent's side) to receive 1 Energy",
      scope: "opp",
      slot: "bench",
      filter: "anyPokemon",
      action: { kind: "handheldFanPick" },
    };
    return;
  }
  const phaseAfter: string = state.phase;
  if (phaseAfter !== "gameOver") endTurnRule(state);
}

// Read-only check: returns ok if `attack(state, player, attackIndex)` would
// commit, otherwise the same `fail` reason the engine would emit. Drives the
// UI's pre-click attack-button disable + tooltip so the player sees WHY an
// attack isn't legal before they click instead of getting a post-click
// rejection toast. attack() itself routes through this so the UI and engine
// can never disagree about legality.
export function attackPreflight(
  state: GameState,
  player: PlayerId,
  attackIndex: number,
): ActionResult {
  if (state.phase === "gameOver") return fail("Game is over.");
  if (state.activePlayer !== player) return fail("Not your turn.");
  if (state.phase !== "main") return fail("Not in main phase.");
  const pl = state.players[player];
  const atk = pl.active;
  if (!atk) return fail("No Active Pokémon.");
  if (state.firstTurnNoAttack) {
    // Debut Performance (Meloetta ex) — bypasses the first-turn attack ban.
    const allowsFirstTurn = (atk.card.abilities ?? []).some((a) => a.name === "Debut Performance");
    if (!allowsFirstTurn) return fail("No attacking on the first turn.");
  }
  if (hasStatus(atk, "asleep")) return fail("Asleep Pokémon can't attack.");
  if (hasStatus(atk, "paralyzed")) return fail("Paralyzed Pokémon can't attack.");
  if (atk.cantAttackUntilTurn !== undefined && state.turn <= atk.cantAttackUntilTurn) {
    return fail("This Pokémon can't attack this turn.");
  }
  for (const ab of atk.card.abilities ?? []) {
    if (ab.name === "Power Saver") {
      const allies = [pl.active, ...pl.bench].filter((p): p is typeof pl.active & {} => !!p);
      const trCount = allies.filter((p) => p.card.name.startsWith("Team Rocket's ")).length;
      if (trCount < 4) {
        return fail("Power Saver: requires 4 or more Team Rocket's Pokémon in play.");
      }
    }
  }
  const move = effectiveAttacks(atk)[attackIndex];
  if (!move) return fail("No such attack.");
  const perAttackLock = (atk as typeof atk & { cantUseAttacksUntilTurn?: Record<string, number> }).cantUseAttacksUntilTurn;
  if (perAttackLock && perAttackLock[move.name] !== undefined && state.turn <= perAttackLock[move.name]) {
    return fail(`This Pokémon can't use ${move.name} this turn.`);
  }
  if ((atk.card.abilities ?? []).some((a) => a.name === "Born to Slack")) {
    const oppId: PlayerId = player === "p1" ? "p2" : "p1";
    const oppAllies = [state.players[oppId].active, ...state.players[oppId].bench]
      .filter((p): p is import("./types").PokemonInPlay => !!p);
    const hasExOrV = oppAllies.some((p) =>
      (p.card.subtypes ?? []).some((s) => /^(?:ex|EX|V|VMAX|VSTAR|V-UNION)$/.test(s)),
    );
    if (!hasExOrV) {
      return fail("Born to Slack: opponent has no Pokémon ex or V in play.");
    }
  }
  const provided = energyPoolForCost(atk, state);
  const effectiveCost = effectiveAttackCost(state, atk, move.cost, move.name);
  if (!canPayCost(provided, effectiveCost))
    return fail("Not enough Energy for that attack.");
  return ok;
}

export function attack(
  state: GameState,
  player: PlayerId,
  attackIndex: number,
): ActionResult {
  const pre = attackPreflight(state, player, attackIndex);
  if (!pre.ok) return pre;
  const atk = state.players[player].active!;

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

  // Phase 7 — pre-attack discard-for-damage picker. For Inferno X /
  // Bellowing Thunder / Spill the Tea (and any future damage-scaling
  // discard attack), open a picker BEFORE running the attack so the
  // player can choose which energies to discard. The picker resolves
  // via `resumeDamageScalingAttack` which re-enters the attack flow
  // with `state.preComputedDiscardForDamage` set.
  if (state.preComputedDiscardForDamage === null && !state.players[player].isAI) {
    const move = effectiveAttacks(atk)[attackIndex];
    if (move) {
      const effects = getAttackEffects(move);
      const damageScalingDiscard = effects.find(
        (e) =>
          e.kind === "discardAnyEnergyAcrossOwnForDamage" ||
          e.kind === "discardEnergyAnywhereForDamage",
      );
      if (damageScalingDiscard) {
        const energyType =
          (damageScalingDiscard as { energyType?: import("./types").EnergyType }).energyType ?? null;
        const max =
          damageScalingDiscard.kind === "discardEnergyAnywhereForDamage"
            ? (damageScalingDiscard as { max: number }).max
            : Number.POSITIVE_INFINITY;
        const allies = [state.players[player].active, ...state.players[player].bench].filter(
          (p): p is import("./types").PokemonInPlay => !!p,
        );
        const hasEligible = allies.some((p) =>
          p.attachedEnergy.some((en) =>
            energyType == null
              ? en.subtypes.includes("Basic")
              : en.provides.includes(energyType),
          ),
        );
        if (hasEligible) {
          state.pendingInPlayTarget = {
            player,
            label: `${move.name}: discard a${energyType ? ` ${energyType}` : "ny Basic"} Energy from one of your Pokémon (Cancel to apply damage)`,
            scope: "own",
            slot: "anywhere",
            filter: "hasAnyEnergy",
            action: {
              kind: "attackDiscardForDamagePicker",
              discarded: 0,
              max: Number.isFinite(max) ? max : 99,
              energyType,
              attackerOwner: player,
              attackIndex,
              attackName: move.name,
            },
          };
          return ok;
        }
      }
    }
  }

  executeAttackHit(state, player, attackIndex);
  finishHit(state, player, attackIndex, false);
  // Per-attack overrides (snipe target, etc.) are single-use — consumed.
  state.snipeTargetOverride = null;
  // Clear the pre-attack discard count after the attack completes.
  state.preComputedDiscardForDamage = null;
  return ok;
}

// Phase 7 — re-enter the attack flow after the pre-attack discard-for-damage
// picker resolves. Records the chosen discard count in
// `state.preComputedDiscardForDamage`, skips preflight + confusion (already
// done on the first pass), and runs executeAttackHit + finishHit.
export function resumeDamageScalingAttack(
  state: GameState,
  player: PlayerId,
  attackIndex: number,
  discarded: number,
): void {
  state.preComputedDiscardForDamage = discarded;
  executeAttackHit(state, player, attackIndex);
  finishHit(state, player, attackIndex, false);
  state.snipeTargetOverride = null;
  state.preComputedDiscardForDamage = null;
}

// Resume a queued Festival Lead second hit after the opponent has promoted a
// new Active. Called by promoteBenchToActive when onPromoteResolved is
// "secondAttack". Re-checks legality: the attacker may have been KO'd by an
// on-damage / passive trigger; the opp may have no Active to receive the hit
// (game-over edge); the attacker may have been put Asleep/Paralyzed by an
// ongoing condition that landed mid-promote.
export function resumeSecondAttack(state: GameState): void {
  const queued = state.pendingSecondAttack;
  if (!queued) return;
  const { player, attackIndex } = queued;
  state.pendingSecondAttack = null;
  if ((state.phase as string) === "gameOver") return;
  const attacker = state.players[player].active;
  const defender = state.players[player === "p1" ? "p2" : "p1"].active;
  if (!attacker || !defender) {
    logEvent(state, "system", "Second hit canceled — no valid attacker/defender.");
    if ((state.phase as string) !== "gameOver") endTurnRule(state);
    return;
  }
  if (hasStatus(attacker, "asleep") || hasStatus(attacker, "paralyzed")) {
    logEvent(state, "system", `${attacker.card.name} can't follow up — status prevented it.`);
    if ((state.phase as string) !== "gameOver") endTurnRule(state);
    return;
  }
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
