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
  applyEvolveSideEffects,
  canPayCost,
  clearAllStatuses,
  endTurn as endTurnRule,
  hasStatus,
  isBasic,
  isPlayersFirstTurn,
  isPokemon,
  logEvent,
  makePokemonInPlay,
  passTurn,
  resolveBenchKOs,
} from "./rules";
import {
  fireTriggeredOnBench,
  fireTriggeredOnEvolve,
  fireTriggeredOnMoveToActive,
  fireTriggeredOnMoveToBench,
} from "./abilities";
import { setDeckSearchPick } from "./pendingPick";
import {
  abilitiesActiveOnInstance,
  actionBlockedByOppActive,
  benchPlacementDamage,
  canEvolveOnPlayTurn,
  effectiveRetreatCost,
  energyPoolForCost,
  maxBenchSize,
} from "./ongoingEffects";

// ActionResult / ok / fail moved to ./actions/_result.ts so the attack
// pipeline split (./actions/attack.ts) can share them without a circular
// value import. Re-exported below to preserve the public surface.
import { ok, fail, type ActionResult } from "./actions/_result";
export type { ActionResult };

// The attack pipeline lives in ./actions/attack.ts post-Stage-5B. The
// barrel re-exports below keep `import { attack, attackPreflight, ... }
// from "../actions"` working unchanged. `resumeSecondAttack` is also
// imported locally because promoteBenchToActive (below) calls it when
// resolving a queued Festival Lead second hit.
import { resumeSecondAttack } from "./actions/attack";
export {
  attackPreflight,
  attack,
  resumeDamageScalingAttack,
  resumeSecondAttack,
} from "./actions/attack";

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

/**
 * Bench a Basic Pokémon from hand. Phase-gated to `"main"`; rejects if the
 * bench is full (5) or if the card isn't Basic. Fires on-play ability
 * triggers via the engine's triggered-ability dispatcher.
 */
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

/**
 * Evolve an in-play Pokémon by attaching a hand card whose `evolvesFrom`
 * matches. Phase-gated to `"main"`. Rejects on the played-this-turn /
 * evolved-this-turn lock, on first-turn evolve ban (both players' first
 * turn), and when the chain mark / name doesn't match. Routes through
 * `applyEvolveSideEffects` so post-evolve cleanup (status clear under
 * Dizzying Valley, schedule-flag clear, ability reset) stays in sync with
 * the Rare Candy paths.
 */
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

/**
 * Attach an Energy card from hand to an in-play Pokémon. Phase-gated to
 * `"main"`. Enforces the 1-per-turn manual-attach slot
 * (`energyAttachedThisTurn`). Special Energies do their own ongoing
 * attachment-rule check via `enforceSpecialEnergyAttachRules` after the
 * attach lands.
 */
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

/**
 * Play a Trainer card from hand (Item / Supporter / Stadium / Pokémon Tool).
 * Phase-gated to `"main"`. Enforces:
 *   - Supporter slot (one per turn, blocked on going-first T1 except for
 *     `T1_SUPPORTER_EXCEPTIONS` like Team Rocket's Proton / Carmine)
 *   - Item lock from Budew's Itchy Pollen (`itemsBlockedNextTurn`)
 *   - Tool attach cap (max 1 per Pokémon)
 *   - Stadium replacement (incoming stadium swaps the in-play one)
 * Effect dispatch lives in `trainerEffects.ts`; this function is the
 * legality + slot-management shell that delegates.
 */
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

/**
 * Retreat the Active to a Bench slot. Phase-gated to `"main"`. Enforces
 * the 1-retreat-per-turn slot, pays Energy cost via
 * `effectiveRetreatCost` (honors free-retreat tools / abilities), clears
 * Special Conditions on the retreating Pokémon (per rulebook), and
 * triggers `applyOnRetreatTriggers`. Asleep / Paralyzed gates are
 * enforced in `attackPreflight`-style preflight; retreat itself is also
 * blocked by Confused under specific Stadium effects.
 */
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


/**
 * Action-layer End Turn — wraps `rules.endTurn` with player-ownership and
 * phase guards. Use this from UI / AI / replay; the rule-layer `endTurn`
 * (re-exported from rules.ts) is what runs the actual cleanup pipeline.
 */
export function endTurn(state: GameState, player: PlayerId): ActionResult {
  if (state.activePlayer !== player) return fail("Not your turn.");
  if (state.phase !== "main") return fail("Can't end turn now.");
  endTurnRule(state);
  return ok;
}

// Re-export commonly used helpers for consumers.
export { isBasic, isPokemon } from "./rules";
export type { Card, PokemonCard, EnergyCard, TrainerCard, EnergyType, PokemonInPlay };
