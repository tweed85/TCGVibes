// Strategic CPU opponent. Greedy per-turn loop, but the per-action scoring
// approximates how a competitive human sequences a turn: search items first,
// refresh the hand with a Supporter only if it's worth it, attach Energy to the
// attacker that's actually going to hit, gust into bench targets when the math
// wins prizes, pick the attack by value (OHKO > raw damage), etc.
//
// No tree search — just priority + scoring. The engine's own legality checks
// keep us honest; we only need to avoid picking *illegal* moves and *dumb*
// legal moves.

import {
  attachEnergy,
  attack,
  endTurn,
  evolve,
  playBasicToBench,
  playTrainer,
  promoteBenchToActive,
  retreat,
} from "./actions";
import {
  canPayCost,
  chooseFirstPlayer,
  completeSetup,
  isBasic,
  isPlayersFirstTurn,
  isPokemon,
  prizeValue,
  opponentOf,
} from "./rules";
import { activateAbility } from "./abilities";
import { makeRng } from "./rng";
import {
  effectiveAttackCost,
  effectiveMaxHp,
  effectiveRetreatCost,
  energyPoolForCost,
  stadiumAttackBonus,
  stadiumDamageReduction,
  turnAttackBonus,
  turnDamageReduction,
  abilitiesActiveOn,
  passiveAttackBonus,
  passiveDamageReduction,
} from "./ongoingEffects";
import { resolvePendingPick, resolvePendingSearchNotice } from "./pendingPick";
import { getAttackEffects } from "../data/effectPatterns";
import { resolveAiHandReveal } from "./trainerEffects";
import { precheckStadium, stadiumHasActivatedEffect, useStadium } from "./stadiumActivated";
import { logEvent } from "./rules";
import {
  archetypeOf,
  archetypeAbilityBonus,
  archetypeAttachBonus,
  archetypeBenchBonus,
  archetypeTrainerBonus,
  playbookAbilityBonusFromState,
  playbookCardBonusFromState,
  v2Active,
} from "./aiArchetype";
import { runMcts, type McAction } from "./mcts";
import type {
  Attack,
  Card,
  EnergyCard,
  EnergyType,
  GameState,
  PlayerId,
  PokemonCard,
  PokemonInPlay,
  TrainerCard,
} from "./types";

// --- Utility predicates ----------------------------------------------------

const isPokemonCard = (c: Card): c is PokemonCard => c.supertype === "Pokémon";
const isEnergyCard = (c: Card): c is EnergyCard => c.supertype === "Energy";
const isBasicEnergy = (c: Card): c is EnergyCard =>
  isEnergyCard(c) && c.subtypes.includes("Basic");
const isTrainer = (c: Card): c is TrainerCard => c.supertype === "Trainer";
const isSupporter = (c: Card): c is TrainerCard =>
  isTrainer(c) && c.subtypes.includes("Supporter");
const isItem = (c: Card): c is TrainerCard => isTrainer(c) && c.subtypes.includes("Item");
const isStadium = (c: Card): c is TrainerCard => isTrainer(c) && c.subtypes.includes("Stadium");
const isTool = (c: Card): c is TrainerCard =>
  isTrainer(c) && (c.subtypes.includes("Pokémon Tool") || c.subtypes.includes("Tool"));

const RULE_BOX = ["ex", "EX", "V", "VMAX", "VSTAR", "V-UNION", "GX"];
// Hoisted out of the evolve-scoring hot loop.
const MEGA_SUBTYPE_RE = /^Mega/i;
const isRuleBox = (c: PokemonCard): boolean =>
  (c.subtypes ?? []).some((s) => RULE_BOX.includes(s));

// --- Coin flip / setup -----------------------------------------------------

// Going second is the default meta edge (can attack on T1, opponent can't
// play a Supporter on T1). But against decks that *have* a T1-supporter
// exception (Team Rocket's Proton, Carmine), winning the flip and going
// FIRST denies that core enabler — worth eating our own T1 attack ban.
// Sourced from Prague R9 G3: champion chose first specifically to deny
// opp's T1 Proton search.
const T1_SUPPORTER_DENIAL_TARGETS = [
  "Team Rocket's Proton",
  "Team Rocket's Tarountula",
  "Team Rocket's Spidops",
  "Team Rocket's Mewtwo ex",
  "Carmine",
];

function shouldGoFirstForT1Denial(state: GameState, me: PlayerId): boolean {
  // v2 only — v1 keeps the "always go second" baseline.
  if (!v2Active(state, me)) return false;
  const opp = state.players[opponentOf(me)];
  // We can see opp's decklist (deck + hand + prizes + discard + in-play)
  // — same visibility as detectArchetype. The cards aren't drawn yet so
  // hand is hand-of-7 only, but the archetype is overwhelmingly determined
  // by the 60-card deck.
  const all: Card[] = [...opp.deck, ...opp.hand, ...opp.discard, ...opp.prizes];
  if (opp.active) all.push(opp.active.card);
  for (const p of opp.bench) all.push(p.card);
  const names = new Set(all.map((c) => c.name));
  return T1_SUPPORTER_DENIAL_TARGETS.some((n) => names.has(n));
}

export function resolveAiCoinChoice(state: GameState): boolean {
  if (state.phase !== "coinFlip" || !state.coinFlip || state.coinFlip.step !== "chooseFirst") return false;
  if (state.coinFlip.winner !== "p2") return false;
  const goFirst = shouldGoFirstForT1Denial(state, "p2");
  chooseFirstPlayer(state, "p2", goFirst);
  return true;
}

// Picks an opening Active that can actually threaten early, reserving the
// "best late-game attacker" for the bench when it needs multiple turns to set
// up. Benches everything else.
export function resolveAiSetup(state: GameState, player: PlayerId): boolean {
  if (state.phase !== "setup") return false;
  const pl = state.players[player];
  if (pl.setupComplete) return false;

  const basics = pl.hand
    .map((c, i) => ({ c: c as PokemonCard, i }))
    .filter((x) => isPokemon(x.c) && isBasic(x.c));
  if (basics.length === 0) return false;

  const primaryEnergy = deckPrimaryEnergy(pl.deck, pl.hand);
  const scored = basics.map(({ c, i }) => ({ i, score: scoreOpeningActive(c, primaryEnergy) }));
  scored.sort((a, b) => b.score - a.score);

  const bestIdx = scored[0].i;
  const benchIdxs = scored.slice(1).map((x) => x.i).slice(0, 5);
  completeSetup(state, player, bestIdx, benchIdxs);
  return true;
}

// Weighs an opener along three dimensions:
//   1. Has a low-cost attack that's usable with 1 Energy (big tempo).
//   2. Matches the deck's primary energy type (we can actually power it).
//   3. HP — a tie-breaker; fragile openers get KO'd T2 and lose prizes fast.
// Rule-box Pokémon in the Active spot are slightly penalized because getting
// them KO'd without a countermove concedes 2 prizes.
function scoreOpeningActive(card: PokemonCard, primaryEnergy: EnergyType | null): number {
  let s = 0;
  const cheapestAttack = card.attacks.length
    ? Math.min(...card.attacks.map((a) => a.cost.length))
    : 99;
  if (cheapestAttack <= 1) s += 60;
  else if (cheapestAttack === 2) s += 35;
  else if (cheapestAttack === 3) s += 10;

  if (primaryEnergy && card.types.includes(primaryEnergy)) s += 25;

  // Small HP bonus — tanky enough to survive one hit is valuable, but we don't
  // pile on to beat the low-cost-attack signal.
  s += Math.min(card.hp, 200) / 10;

  // Basics that evolve (e.g. Gardevoir/Rogue line) are fine in front, but a
  // pure "wall" (e.g. Basic-only with good attack) is preferred opener.
  if (card.evolvesFrom) s -= 5;

  // Penalize opening a 2-prize ex unless it has a 1-energy attack.
  if (isRuleBox(card) && cheapestAttack > 1) s -= 20;

  // Supporting-tech Basics with no usable attack at all are strictly bench.
  if (card.attacks.length === 0) s -= 80;

  return s;
}

// --- Promote-on-KO ---------------------------------------------------------

// Smart promote: prefer a bench Pokémon that can actually attack next turn
// (has usable energy already), falling back to the highest-HP option.
export function resolveAiPendingPromote(state: GameState, player: PlayerId): boolean {
  if (state.pendingPromote !== player) return false;
  const pl = state.players[player];
  // Bench-empty safety net: if the engine left us in a "must promote but no
  // bench" state (some indirect KO paths skip the inline knockOut game-over
  // check at rules.ts:951), declare the player out and end the game here so
  // the harness doesn't get stuck. The upstream callsite that set pending
  // promote without checking bench is a real bug to fix separately.
  if (pl.bench.length === 0) {
    state.winner = opponentOf(player);
    state.phase = "gameOver";
    state.pendingPromote = null;
    state.pendingPromoteQueue = [];
    logEvent(
      state,
      "system",
      `${pl.name} has no Pokémon left. ${state.players[opponentOf(player)].name} wins.`,
    );
    return true;
  }

  const scored = pl.bench.map((p, i) => ({ i, score: scorePromoteCandidate(p, state, player) }));
  scored.sort((a, b) => b.score - a.score);
  promoteBenchToActive(state, player, scored[0].i);
  return true;
}

function scorePromoteCandidate(p: PokemonInPlay, state: GameState, owner: PlayerId): number {
  let s = 0;
  // Can we attack right now from this spot? Huge plus.
  const provided = energyPoolForCost(p, state);
  const usable = p.card.attacks.filter((a) =>
    canPayCost(provided, effectiveAttackCost(state, p, a.cost)),
  );
  if (usable.length > 0) s += 80;

  // How "healthy" is this Pokémon?
  const maxHp = effectiveMaxHp(p, state);
  const remaining = maxHp - p.damage;
  s += remaining / 5;

  // 1-ply lookahead: estimate opponent's best swing against this candidate
  // specifically (their attacker, Stadium/Tool boosts, our resistances).
  // Reward candidates that survive; heavily punish candidates that hand the
  // opponent another instant prize.
  const oppId = opponentOf(owner);
  const opp = state.players[oppId];
  if (opp.active) {
    const oppProvided = energyPoolForCost(opp.active, state);
    let threat = 0;
    for (const move of opp.active.card.attacks) {
      if (!canPayCost(oppProvided, effectiveAttackCost(state, opp.active, move.cost))) continue;
      const d = estimateDamage(state, oppId, opp.active, move, p);
      if (d > threat) threat = d;
    }
    if (threat > 0) {
      if (threat >= remaining) {
        // We'd die immediately. Penalize heavily — and even more if it's a
        // multi-prizer (don't feed an ex into a punching bag).
        s -= 80;
        if (isRuleBox(p.card)) s -= 60;
      } else if (threat >= remaining * 0.7) {
        s -= 25;
      }
    }
    // Bonus: if we can OHKO their Active back, this is a counter-promote.
    if (usable.length > 0) {
      const oppMax = effectiveMaxHp(opp.active, state);
      const dmg = Math.max(...usable.map((m) =>
        estimateDamage(state, owner, p, m, opp.active!),
      ));
      if (opp.active.damage + dmg >= oppMax) {
        s += 60 + prizeValue(opp.active.card) * 30;
      }
    }
  }

  // Avoid walling up a 2-prizer that's going to get traded for a 1-prizer.
  if (isRuleBox(p.card)) s -= 15;
  // Damaged Pokémon are bad Actives — easy KO gives the opponent a prize.
  if (p.damage > 0) s -= p.damage / 10;

  return s;
}

// --- Scoring primitives ----------------------------------------------------

// Primary energy = most-common basic energy type in the deck/hand combined.
// Used to pick an attacker/setup that actually matches the deck.
// Accepts up to two card arrays so callers can avoid allocating a combined
// array (deck.concat(hand)) on each call from a hot path.
export function deckPrimaryEnergy(...sources: Card[][]): EnergyType | null {
  const counts = new Map<EnergyType, number>();
  for (const cards of sources) {
    for (const c of cards) {
      if (isBasicEnergy(c)) {
        for (const t of c.provides) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
  }
  let best: EnergyType | null = null;
  let bestN = 0;
  for (const [t, n] of counts.entries()) {
    if (n > bestN) { best = t; bestN = n; }
  }
  return best;
}

// Effective damage an attacker would deal to a specific defender, mirroring
// the engine's attack pipeline closely enough to drive targeting decisions.
// Ignores coin flips (treats them as average: half-credit on bonus, half on
// fizzle) and snipe/recoil post-damage effects.
function estimateDamage(
  state: GameState,
  attackerOwner: PlayerId,
  attacker: PokemonInPlay,
  move: Attack,
  defender: PokemonInPlay | null,
): number {
  // Resolve effects first so baseDamageOverride lands before we read damage.
  const effects = getAttackEffects(move);
  let damage = move.damage;
  damage += stadiumAttackBonus(state, attacker, defender);
  damage += turnAttackBonus(state, attackerOwner, attacker, defender);
  damage += passiveAttackBonus(state, attackerOwner, attacker, defender);

  for (const e of effects) {
    switch (e.kind) {
      case "flipHeadsBonus":
        damage += e.bonus / 2;
        break;
      case "flipTailsFizzle":
        damage = damage / 2; // half chance to miss
        break;
      case "flipHeadsDouble":
        damage = (damage + damage * 2) / 2;
        break;
      case "flipAllHeadsBonus": {
        // Probability of all heads = 1 / 2^coins.
        const p = 1 / Math.pow(2, e.coins);
        damage += e.bonus * p;
        break;
      }
      case "flipMultiCoinsPerHeads":
        // Expected heads = coins / 2.
        damage += (e.perHeads * e.coins) / 2;
        break;
      case "flipUntilTailsPerHeads":
        // Mega Kangaskhan ex Rapid-Fire Combo. Geometric distribution, p=0.5
        // for tails — expected number of heads = 1. Estimator under-counts
        // without this case (sees only base damage and ignores the bonus).
        damage += e.perHeads;
        break;
      case "perAttachedEnergy": {
        const energies = attacker.attachedEnergy;
        const matching = e.energyType
          ? energies.filter((en) => en.provides.includes(e.energyType!)).length
          : energies.length;
        damage += e.perEnergy * matching;
        break;
      }
      case "perFriendlyBench":
        damage += e.perCount * state.players[attackerOwner].bench.length;
        break;
      case "perOpponentBench":
        damage += e.perCount * state.players[opponentOf(attackerOwner)].bench.length;
        break;
      case "perBothBench":
        damage += e.perCount *
          (state.players[attackerOwner].bench.length + state.players[opponentOf(attackerOwner)].bench.length);
        break;
      case "perDamageCounterOnSelf":
        damage += e.perCount * Math.floor(attacker.damage / 10);
        break;
      case "perDamageCounterOnDefender":
        damage += e.perCount * Math.floor((defender?.damage ?? 0) / 10);
        break;
      case "perEnergyOnDefender":
        damage += e.perCount * (defender?.attachedEnergy.length ?? 0);
        break;
      case "perPrizeOppTaken":
        damage += e.perCount * (6 - state.players[opponentOf(attackerOwner)].prizes.length);
        break;
      case "benchSnipe":
        // "allOpponents" target adds e.damage to the Active hit (with W/R
        // applied below). Other targets only hit bench, no defender contribution.
        if (e.target === "allOpponents") damage += e.damage;
        break;
      case "snipeOnePerEnergy": {
        // Genesect Bug's Cannon: per-energy×count damage to one of opp's
        // Pokémon (Active or Bench). For active-damage estimation, count
        // the matching energies and add the resulting damage — this is
        // the entire damage on a Bug's Cannon (no base damage).
        const matching = attacker.attachedEnergy.filter((en) =>
          en.provides.includes(e.energyType),
        ).length;
        damage += e.perEnergy * matching;
        break;
      }
      // selfDamage / applyStatus / heal / discardOwnEnergy / drawCards don't
      // affect the defender's raw damage tally.
      default:
        break;
    }
  }

  if (defender) {
    const atkType = attacker.card.types[0];
    const weak = defender.card.weaknesses?.find((w) => w.type === atkType);
    const res = defender.card.resistances?.find((w) => w.type === atkType);
    if (weak && weak.value.startsWith("×")) {
      damage *= parseInt(weak.value.slice(1), 10) || 2;
    }
    if (res && res.value.startsWith("-")) {
      damage = Math.max(0, damage - (parseInt(res.value.slice(1), 10) || 30));
    }
    const reduction = stadiumDamageReduction(state, attacker, defender);
    const turnRed = turnDamageReduction(state, opponentOf(attackerOwner), defender);
    const passiveRed = passiveDamageReduction(state, opponentOf(attackerOwner), defender, attacker);
    damage = Math.max(0, damage - reduction - turnRed - passiveRed);
  }
  return Math.round(damage);
}

// Damage per energy cost — proxy for "value" of an attack when no OHKO is
// available. Used as a tiebreaker.
function attackValue(
  state: GameState,
  owner: PlayerId,
  attacker: PokemonInPlay,
  move: Attack,
  defender: PokemonInPlay | null,
): number {
  const dmg = estimateDamage(state, owner, attacker, move, defender);
  const cost = Math.max(1, move.cost.length);
  let v = dmg + dmg / cost; // prefer efficient attacks
  const defMax = defender ? effectiveMaxHp(defender, state) : 0;
  const isOHKO = !!defender && dmg > 0 && defender.damage + dmg >= defMax;
  // Self-damage / self-discard / self-locks are negatives — opening value lost.
  let hasSelfLock = false;
  let hasSetupEffect = false;
  let selfDamageDealt = 0;
  for (const e of getAttackEffects(move)) {
    if (e.kind === "selfDamage") {
      v -= e.damage * 0.7;
      selfDamageDealt += e.damage;
    }
    if (e.kind === "discardOwnEnergy") v -= e.count * 15; // losing setup hurts
    if (e.kind === "drawCards") v += e.count * 8; // free card draw is nice
    if (e.kind === "benchSnipe") v += e.damage * 1.5;
    if (e.kind === "applyStatus" && e.target === "defender") v += 15;
    if (e.kind === "heal") v += e.amount * 0.3;
    if (e.kind === "selfCantAttackNextTurn") hasSelfLock = true;
    if (e.kind === "selfCantUseAttackNextTurn") hasSelfLock = true;
    // Setup attacks (energy acceleration to bench / self) get a bonus that
    // makes the AI prefer them over a big non-KO swing when we have follow-up.
    if (e.kind === "attachNFromDiscardToBench") hasSetupEffect = true;
    if (e.kind === "searchEnergyAttachBenchType") hasSetupEffect = true;
    if (e.kind === "callForFamily") hasSetupEffect = true;
  }

  // 1-ply lookahead context: do we expect to survive into next turn? If our
  // Active is already in OHKO range from the opponent's expected hit, then:
  //   - the cost of self-damage / energy discard is irrelevant (we're dying
  //     anyway), so wash those penalties; and
  //   - taking the prize this turn is more valuable than chipping (since we
  //     won't be here to capitalize).
  const ourMax = effectiveMaxHp(attacker, state);
  const ourRemaining = ourMax - attacker.damage - selfDamageDealt;
  // Approximate opponent's next-turn swing using the cached helper.
  const expectedThreat = opponentMaxDamageNextTurn(state, owner);
  const dyingNextTurn = expectedThreat >= ourRemaining;

  // Prize race: if the opponent is on their last 1–2 prizes, OHKOs are
  // disproportionately valuable (game-winning), and chip is nearly worthless.
  const oppPrizesLeft = state.players[opponentOf(owner)].prizes.length;
  const ourPrizesLeft = state.players[owner].prizes.length;

  if (isOHKO) {
    v += 200 + prizeValue(defender!.card) * 80;
    if (oppPrizesLeft <= prizeValue(defender!.card)) v += 300; // game-winning
    if (dyingNextTurn) v += 60; // we'd lose value-trade by NOT taking the KO
    // Among multiple OHKOs, prefer the cheaper one (preserves energy for
    // next turn / the bench attacker after we get traded).
    v -= cost * 3;
    return v;
  }
  // Non-KO path: self-lock is a real cost because we used this turn to deal
  // partial damage AND can't follow up with this attack next turn.
  if (hasSelfLock) v -= Math.max(40, dmg * 0.4);
  // If we're dying next turn anyway, undo half of the self-cost penalty —
  // those drawbacks don't apply if we're not here to feel them.
  if (dyingNextTurn) v += selfDamageDealt * 0.4;

  // "Setup-KO line": if this attack doesn't OHKO but chips the defender
  // below the OHKO threshold for a typical 120-damage follow-up swing, give
  // it a moderate bonus — matches the Aura Jab → Mega Brave flow.
  if (defender && !isOHKO && dmg > 0) {
    const damageAfter = defender.damage + dmg;
    const remaining = defMax - damageAfter;
    if (remaining <= 150) v += 40;  // clearly in one-shot range next turn
    else if (remaining <= 220) v += 20; // Mega Brave / Wild Press range
    // If we'll be dead before we can follow up, the "setup the next KO"
    // bonus is mostly wasted — the bench attacker would need to inherit
    // the chip damage.
    if (dyingNextTurn) v -= 20;
  }
  // Late game: chip damage is worth less than reliable prize taking.
  if (oppPrizesLeft <= 2 && !isOHKO) v -= 20;
  // Behind on prizes — be aggressive even if it costs us. (You're losing if
  // you don't.)
  if (ourPrizesLeft > oppPrizesLeft + 1 && dmg > 0) v += 10;
  // Setup effects (attach-from-discard etc.) have lasting value beyond damage.
  if (hasSetupEffect) v += 35;
  return v;
}

// --- Trainer / Supporter scoring -------------------------------------------

// "How useful is this Trainer *right now*?" The heuristic is conservative:
// free value gets high scores; hand-refresh Supporters scale by how bad the
// current hand is; disruption Supporters score high only when we're ahead.
function scoreTrainerForNow(
  state: GameState,
  player: PlayerId,
  card: TrainerCard,
): number {
  const pl = state.players[player];
  const opp = state.players[opponentOf(player)];
  const id = card.effectId;
  if (!id) return 0; // unknown effect = don't bother playing

  const hand = pl.hand.length;
  const oppPrizes = opp.prizes.length;

  switch (id) {
    // --- Search items: almost always play these early. Thinning the deck
    // before a draw Supporter makes the Supporter's yield more impactful.
    case "searchBasicPokemon1":
    case "searchBasicPokemon2Poffin":
    case "searchUpTo2Basic":
    case "searchAnyPokemonFree":
    case "searchNonRuleBoxPokemon":
    case "searchStage1x3":
    case "searchTeraPokemon":
    case "searchPokemonCoinFlip":
    case "duskBall":
    case "searchAnyBasicsToBench":
    case "searchMegaEx":
    case "searchHopsBasics":
    case "searchFightingBasicOrEnergy":
    case "searchTMTools":
    case "searchTRSupporter":
      // Less valuable if bench is full and we already have plenty of Pokémon.
      if (pl.bench.length >= 5 && countPokemonInHand(pl.hand) >= 2) return 10;
      return 90;

    case "searchAnyPokemon":
      // Ultra Ball: costs 2 hand cards. Good if hand is large and full of
      // filler; weak if hand is already thin.
      if (pl.hand.length < 3) return 0; // can't pay cost
      if (pl.hand.length >= 5) return 85;
      return 30;

    case "searchBasicEnergy1":
    case "searchEnergyVariety":
    case "searchBasicEnergyN":
    case "energyCoinFlip":
    case "searchStadiumAndEnergy":
      // Want energy if anything on board can't attack yet.
      return weNeedEnergy(state, player) ? 70 : 30;

    case "energyRetrieval":
    case "nightStretcher":
      // Discard-recovery: valuable when we've already lost resources.
      if (countEnergyInDiscard(pl.discard) >= 1 || hasImportantPokemonInDiscard(pl.discard)) return 70;
      return 10;

    case "energyRecycler":
    case "sacredAsh":
      // Long-game items; only if we're burning through resources.
      return pl.deck.length < 15 ? 55 : 20;

    case "energySwitchOwn":
      // Only useful if active actually lacks energy the bench has.
      return 35;

    // --- Gust effects ------------------------------------------------------
    case "gustOppBenched":
    case "flipGustOppBenched":
    case "primeCatcher":
    case "gustConfuseOppBasic": {
      // Only play a gust if we have a concrete KO target on bench.
      const benchTarget = bestGustTarget(state, player);
      return benchTarget ? 95 : 5;
    }

    // --- One-shot hand disruption ----------------------------------------
    case "unfairStampShuffleDraw": {
      // ACE SPEC. Engine-gated to "one of your Pokémon was KO'd during
      // opp's last turn" (precheckTrainerEffect is authoritative); the
      // scorer mirrors that gate so the AI doesn't try obviously
      // illegal plays. Among legal plays, scale by opp hand size:
      // 6+ cards → high-value disruption; 3-5 → modest (below Item
      // threshold so we save it for a better window); 2 or fewer →
      // burning a one-shot ACE SPEC to flip a tiny hand is wasteful.
      if (!pl.yourPokemonKoedLastOppTurn) return 0;
      if (opp.hand.length >= 6) return 80;
      if (opp.hand.length <= 2) return 5;
      return 35;
    }

    // --- Switch / self-retreat --------------------------------------------
    case "simpleSwitch":
    case "switchActive":
    case "repelSwitchOut":
    case "scoopUpCyclone":
    case "scrambleSwitch": {
      // Useful if our Active is stuck / can't attack and bench can.
      const stuck = activeCantAttack(state, player);
      const hasLiveBench = pl.bench.some((p) => benchCanAttack(state, p));
      return stuck && hasLiveBench ? 80 : 15;
    }

    // --- Heals ------------------------------------------------------------
    case "heal30Active":
    case "heal30OrArven100":
    case "heal60DiscardEnergy":
    case "heal20AndCure":
    case "heal80IfEnergyCap":
    case "heal70Active":
    case "heal60ActiveAndCure":
    case "healEach40":
    case "heal150Any":
    case "heal150Psychic":
    case "heal60EachLightning":
    case "healDragon60":
    case "healAllIfLow30Hp":
    case "healAllMinor":
    case "healMegaExAndEnergyToHand": {
      // Threat-aware: if our Active would be OHKO'd next turn and we're
      // damaged, heals spike in value — they can save a 2-prize attacker.
      if (pl.active) {
        const maxHp = pl.active.card.hp;
        const ourHp = maxHp - pl.active.damage;
        const threat = opponentMaxDamageNextTurn(state, player);
        // Will die to the next attack AND we've taken some damage → top tier.
        if (pl.active.damage > 0 && threat >= ourHp) return 95;
        // In one-shot range (leaves us with <30) → high priority.
        if (pl.active.damage > 0 && ourHp - threat <= 30) return 80;
      }
      if (pl.active && pl.active.damage >= 60) return 70;
      if (pl.active && pl.active.damage >= 30) return 45;
      // If our active is healthy and no bench needs it, skip.
      const anyHurt = [pl.active, ...pl.bench].some((p) => p && p.damage > 0);
      return anyHurt ? 20 : 0;
    }

    // --- Draw supporters --------------------------------------------------
    case "drawUntilSeven":
      // Professor's Research / Iono / Marnie. Great on small hands, awful on big.
      if (hand <= 3) return 100;
      if (hand <= 5) return 55;
      if (hand <= 7) return 25;
      return 5; // don't shuffle 8 good cards away

    case "shuffleHandDraw6OrEight":
      if (hand <= 3) return 95;
      if (hand <= 5) return 55;
      return 20;

    case "shuffleHandDraw4Or8Lacey":
      // 8 if opp has ≤ 3 prizes (we're ahead is bad — opp is close to winning,
      // this is actually when we're BEHIND in prize race).
      if (oppPrizes <= 3) return 80; // big payout, play it
      return hand <= 4 ? 60 : 25;

    case "shuffleHandDrawDrasna":
      return hand <= 3 ? 60 : 20;

    case "discardHandDraw5":
      // Carmine: only if hand is genuinely bad; discards Supporters too.
      return hand <= 2 || (hand <= 4 && handQuality(pl.hand) < 1) ? 65 : 15;

    case "drawUntil6Discard":
      // Iris: net-positive draw if hand ≤ 4. Costs 1 discard.
      if (pl.hand.length < 2) return 0;
      return hand <= 4 ? 75 : 15;

    case "drawUntil5":
    case "drawUntilHandSix":
      if (hand <= 2) return 70;
      if (hand <= 4) return 45;
      return 10;

    case "draw2Plus2IfOppFew":
      return oppPrizes <= 3 ? 70 : 40;
    case "draw2Plus2IfHandBig":
      return hand >= 10 ? 35 : 50; // modest draw; only play if nothing better
    case "drawPerOppBenched":
      return opp.bench.length >= 3 ? 65 : 25;
    case "drawCoinFlip42":
      return hand <= 3 ? 40 : 15;
    case "eachPlayerShuffleDraw4":
      // Judge: also disrupts opponent. Lean more when opp is loaded.
      return opp.hand.length >= 8 ? 70 : (hand <= 4 ? 50 : 15);

    case "draw3":
    case "draw4":
      if (hand <= 3) return 75;
      if (hand <= 5) return 45;
      return 15;

    case "draytonTop7":
      return 55;

    // --- Disruption supporters --------------------------------------------
    case "eriDiscardOppItems":
      return opp.hand.length >= 4 ? 50 : 15;
    case "discardOppItemsHand":
      return opp.hand.length >= 5 ? 65 : 20;
    case "handTrimmerBothTo5":
      return opp.hand.length >= 7 && pl.hand.length <= 5 ? 50 : 15;

    // --- Energy-cost / damage disruption ----------------------------------
    case "enhancedHammer": {
      const opp2 = state.players[opponentOf(player)];
      const hasSpecial = opp2.active?.attachedEnergy.some((e) => e.subtypes.includes("Special"));
      return hasSpecial ? 80 : 5;
    }
    case "crushingHammer": {
      const opp2 = state.players[opponentOf(player)];
      const e = opp2.active?.attachedEnergy.length ?? 0;
      return e >= 2 ? 35 : 15; // coinflip, modest EV
    }
    case "toolScrapper":
      return hasAnnoyingTools(state, opponentOf(player)) ? 70 : 10;
    case "holeDigShovel":
      return 15; // mostly dead in our decks

    // --- Top-peek / deck-manipulation -------------------------------------
    case "pokegear37":
      return hand <= 3 || pl.supporterPlayedThisTurn ? 40 : 25;
    case "bugCatchingSet":
      return 35;
    case "deductionKit":
      return 10; // no reorder UI; effectively information only
    case "ciphermaniacSearch":
      return 40;
    case "darkBasicPokemonTopPeek":
      return state.turn > 1 ? 55 : 0;
    case "top6Take2Discard4":
      return hand <= 3 ? 50 : 30;

    // --- Turn-scoped buffs -------------------------------------------------
    case "buffPlus40VsExThisTurn":
      return oppHasEx(state, player) ? 85 : 10;
    case "buffFightingPlus30ThisTurn":
      return hasAttackerOfType(state, player, "Fighting") ? 65 : 10;
    case "debuffMinus30OppTurn":
    case "debuffMinus30OppTurnMetal":
      return 40;

    // --- Special one-offs --------------------------------------------------
    case "searchTrainer":
    case "search3Pokemonex":
    case "searchEvolutionPokemon":
    case "searchEvolutionAndEnergy":
    case "topPeekSupporterGrassFire":
    case "recoverFromDiscardLana":
    case "recoverFromDiscardTarragon":
    case "recover2Supporters":
    case "rebootPodFuture":
    case "nsPPUp":
    case "wondrousPatchPsychic":
    case "glassTrumpet":
    case "searchTopBasicEnergyAttach":
    case "searchBasicEnergyX":
    case "moveBenchEnergyToActive":
    case "rareCandyEvolve":
    case "dangerousLaser":
    case "trGreatBallFlip":
    case "trVentureBombFlip":
    case "searchEnergyToBench":
    case "discardOppToolAndSpecialEnergy":
      return 35; // "okay" default for recognized but situational effects

    default:
      return 25;
  }
}

function countPokemonInHand(hand: Card[]): number {
  return hand.filter(isPokemonCard).length;
}
function countEnergyInDiscard(discard: Card[]): number {
  return discard.filter(isBasicEnergy).length;
}
function hasImportantPokemonInDiscard(discard: Card[]): boolean {
  return discard.some((c) => isPokemonCard(c) && (isRuleBox(c) || (c.hp ?? 0) >= 150));
}
function hasAnnoyingTools(state: GameState, owner: PlayerId): boolean {
  const p = state.players[owner];
  const all = [p.active, ...p.bench].filter((x): x is PokemonInPlay => !!x);
  return all.some((pk) => pk.tools.length > 0);
}
function oppHasEx(state: GameState, self: PlayerId): boolean {
  const opp = state.players[opponentOf(self)];
  const all = [opp.active, ...opp.bench].filter((x): x is PokemonInPlay => !!x);
  return all.some((p) => isRuleBox(p.card));
}
function hasAttackerOfType(state: GameState, self: PlayerId, type: EnergyType): boolean {
  const pl = state.players[self];
  const all = [pl.active, ...pl.bench].filter((x): x is PokemonInPlay => !!x);
  return all.some((p) => p.card.types.includes(type));
}
// Rough "how good is this hand" signal: Pokémon + energy in hand worth more
// than duplicate Supporters.
function handQuality(hand: Card[]): number {
  let q = 0;
  for (const c of hand) {
    if (isPokemonCard(c)) q += 2;
    else if (isBasicEnergy(c)) q += 1;
    else if (isTrainer(c) && c.subtypes.includes("Item")) q += 1;
    else q += 0.5;
  }
  return q;
}

// We "need energy" if any of our attackers are one Energy short of a usable
// attack. Used to prioritize energy-search trainers.
function weNeedEnergy(state: GameState, player: PlayerId): boolean {
  const pl = state.players[player];
  const all = [pl.active, ...pl.bench].filter((x): x is PokemonInPlay => !!x);
  for (const p of all) {
    const cur = energyPoolForCost(p, state).length;
    const best = Math.min(...(p.card.attacks.length
      ? p.card.attacks.map((a) => effectiveAttackCost(state, p, a.cost).length)
      : [99]));
    if (best > cur && best - cur <= 2) return true;
  }
  return false;
}

function benchCanAttack(state: GameState, p: PokemonInPlay): boolean {
  const provided = energyPoolForCost(p, state);
  return p.card.attacks.some((a) => canPayCost(provided, effectiveAttackCost(state, p, a.cost)));
}

function activeCantAttack(state: GameState, player: PlayerId): boolean {
  const a = state.players[player].active;
  if (!a) return true;
  const provided = energyPoolForCost(a, state);
  return !a.card.attacks.some((atk) => canPayCost(provided, effectiveAttackCost(state, a, atk.cost)));
}

// --- Gust target selection -------------------------------------------------

// "What's the best opponent bench Pokémon to pull into the Active spot?"
// Returns the instance id, or null if no gust is worth playing.
function bestGustTarget(state: GameState, player: PlayerId): PokemonInPlay | null {
  const pl = state.players[player];
  const opp = state.players[opponentOf(player)];
  if (opp.bench.length === 0 || !pl.active) return null;

  // Only gust if our Active can actually attack (no point otherwise).
  const atk = pl.active;
  const provided = energyPoolForCost(atk, state);
  const usable = atk.card.attacks.filter((a) =>
    canPayCost(provided, effectiveAttackCost(state, atk, a.cost)),
  );
  if (usable.length === 0) return null;

  // v2: also weight gust targets that are "engine pieces" — ramp Pokémon
  // (Teal Mask Ogerpon ex, Bibarel-equivalents, Dudunsparce, Fan Rotom)
  // that drive the opp's plan. Removing one of those cripples tempo for
  // multiple turns, even if the gust target itself doesn't yield a KO.
  const v2 = v2Active(state, player);

  let best: PokemonInPlay | null = null;
  let bestScore = 0;
  for (const b of opp.bench) {
    for (const move of usable) {
      let score = gustValue(state, player, atk, move, b);
      if (v2) score += rampEngineBonus(b);
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
  }
  return bestScore >= 120 ? best : null;
}

// Pokémon that act as engine pieces in their decks. Targeting one with a
// gust + KO removes 1-2 turns of opp tempo. v2-only: v1 already KOs them
// when they happen to be the weakest target, but doesn't seek them out.
function rampEngineBonus(target: PokemonInPlay): number {
  const name = target.card.name;
  // Energy ramp / search engines.
  if (name === "Teal Mask Ogerpon ex") return 60;
  if (name === "Bibarel") return 60;
  if (name === "Dudunsparce") return 50; // Roll Out draw engine
  if (name === "Fan Rotom") return 40; // Fan Call deck thin
  if (name === "Fezandipiti ex") return 50; // Flip the Script
  if (name === "Munkidori") return 40; // Adrena-Brain
  if (name === "Team Rocket's Spidops") return 50; // Charging Up energy-from-discard
  if (name === "Blaziken ex") return 50; // Charging Up Fire-from-discard
  // Stage-2 setup pieces still on bench (means opp is mid-evolve).
  const subtypes = target.card.subtypes ?? [];
  if (subtypes.includes("Stage 2") && target.attachedEnergy.length === 0) return 30;
  // Un-powered high-ceiling punchers: rule-box attackers that haven't paid
  // their energy yet. KO'ing them now is far cheaper than letting them
  // come down on a charged Spidops/Blaziken/Drakloak. Identified during
  // the Prague R9 replay walkthrough — the gust priority list previously
  // only rewarded ramp engines, missing the "kill the puncher before it
  // boots" line.
  if (target.attachedEnergy.length === 0) {
    if (name === "Team Rocket's Mewtwo ex") return 55;
    if (name === "Dragapult ex") return 55;
    if (name === "Mega Lucario ex") return 50;
    if (name === "Arboliva ex") return 45;
    if (name === "Alakazam ex") return 45;
    // Generic fallback: any rule-box with 0 energy on bench is a worth-targeting
    // puncher. Lower magnitude so it doesn't outrank the named ramp engines,
    // but enough to prefer it over a powered minor attacker.
    if (isRuleBox(target.card)) return 30;
  }
  return 0;
}

// Value of gusting up `target`, attacking with `move`, weighted by prize swing.
function gustValue(
  state: GameState,
  owner: PlayerId,
  attacker: PokemonInPlay,
  move: Attack,
  target: PokemonInPlay,
): number {
  const dmg = estimateDamage(state, owner, attacker, move, target);
  const maxHp = effectiveMaxHp(target, state);
  const isKO = target.damage + dmg >= maxHp;
  const prizes = prizeValue(target.card);
  // Compare against what we'd get attacking the current Active instead.
  const currentActive = state.players[opponentOf(owner)].active;
  const currentHp = currentActive ? effectiveMaxHp(currentActive, state) : 0;
  const currentDmg = currentActive ? estimateDamage(state, owner, attacker, move, currentActive) : 0;
  const currentKO = currentActive ? (currentActive.damage + currentDmg >= currentHp) : false;
  const currentPrizes = currentActive ? prizeValue(currentActive.card) : 0;

  if (!isKO) return 0;
  // OHKO on bench. Worth more than the current-Active option if:
  //   a) we couldn't OHKO the Active, or
  //   b) the bench target is a higher prize-value card.
  let s = 150 + prizes * 60;
  if (!currentKO) s += 80; // we gain a KO we wouldn't have otherwise
  if (prizes > currentPrizes) s += (prizes - currentPrizes) * 50;
  // Less valuable if we'd deal the same or more prizes by just hitting Active.
  if (currentKO && prizes <= currentPrizes) s -= 100;
  return s;
}

// --- Energy-attach target selection ----------------------------------------

// Pick the best Pokémon on the field to receive the next Energy.
// Priority: Active if it reaches an attack this turn; else the best bench
// future attacker.
function pickEnergyAttachTarget(
  state: GameState,
  player: PlayerId,
  energy: EnergyCard,
): PokemonInPlay | null {
  const pl = state.players[player];
  const candidates: PokemonInPlay[] = [];
  if (pl.active) candidates.push(pl.active);
  candidates.push(...pl.bench);
  if (candidates.length === 0) return null;

  // v2: bias attach toward the archetype's planned attacker. Without this,
  // the AI may attach to a tanky bench Basic that isn't part of the deck's
  // game plan (e.g., attaching to a Manaphy on an Arboliva deck instead of
  // the Teal Mask Ogerpon ex that drives the plan).
  const arch = v2Active(state, player) ? archetypeOf(state, player) : "generic";
  let best: PokemonInPlay | null = null;
  let bestScore = -Infinity;
  for (const p of candidates) {
    let s = scoreEnergyTarget(state, player, p, energy);
    s += archetypeAttachBonus(arch, p);
    if (s > bestScore) { bestScore = s; best = p; }
  }
  return best;
}

function scoreEnergyTarget(
  state: GameState,
  player: PlayerId,
  p: PokemonInPlay,
  energy: EnergyCard,
): number {
  const pl = state.players[player];
  const isActive = pl.active === p;
  const provided = energyPoolForCost(p, state);
  // Simulate attaching by adding the energy to the provided pool.
  const simulated = [...provided, ...energy.provides];

  // Cache effectiveAttackCost per attack — same attack was hitting the
  // resolver three times (unlock check, usableAttacks, bestRemaining) which
  // is real cost on full-bench mid-game scoring passes.
  const costs = p.card.attacks.map((a) => effectiveAttackCost(state, p, a.cost));

  // Does this new energy *unlock* an attack that wasn't usable before?
  let unlocks = false;
  let unlockDamage = 0;
  let usableCount = 0;
  let bestRemaining = p.card.attacks.length === 0 ? 99 : Infinity;
  for (let i = 0; i < p.card.attacks.length; i++) {
    const atk = p.card.attacks[i];
    const cost = costs[i];
    const wasUsable = canPayCost(provided, cost);
    const nowUsable = canPayCost(simulated, cost);
    if (!wasUsable && nowUsable) {
      unlocks = true;
      const def = state.players[opponentOf(player)].active;
      unlockDamage = Math.max(unlockDamage, estimateDamage(state, player, p, atk, def));
    }
    if (nowUsable) usableCount++;
    const remaining = Math.max(0, cost.length - simulated.length);
    if (remaining < bestRemaining) bestRemaining = remaining;
  }

  let s = 0;
  // Active unlocks are worth a lot — we can swing this turn.
  if (isActive && unlocks && !state.firstTurnNoAttack) s += 200 + unlockDamage;
  // Any unlock at all (even bench) is good — sets up next-turn plays.
  else if (unlocks) s += 100 + unlockDamage / 2;

  s += usableCount * 10;

  // Reward matching the Pokémon's own type so rainbow decks don't dump Water
  // on a Fire attacker "just because."
  if (p.card.types.some((t) => energy.provides.includes(t))) s += 20;

  s -= bestRemaining * 5;

  // Don't pour more energy onto a Pokémon that already has enough for every
  // attack — diminishing returns.
  if (usableCount === p.card.attacks.length && p.card.attacks.length > 0) {
    s -= 30;
  }

  // Active preference as tiebreaker when unlock is the same.
  if (isActive) s += 5;

  // Don't attach to a Basic that's about to evolve into something totally
  // different in energy requirements — we can't tell reliably, so we just
  // lightly prefer Pokémon that are already in their "final" form visible.

  // Penalize attaching to a heavily-damaged bench Pokémon that's about to die.
  if (p.damage >= effectiveMaxHp(p, state) - 20) s -= 30;
  return s;
}

// --- Attack selection ------------------------------------------------------

// Pick the best-valued attack available on the current Active.
function pickBestAttack(state: GameState, player: PlayerId): { index: number; value: number } | null {
  const pl = state.players[player];
  if (!pl.active) return null;
  const atk = pl.active;
  // If this Pokémon can't attack at all this turn (Riolu's Accelerating Stab
  // self-lock, confusion sleep, paralysis, etc.), bail — no point scoring.
  if (atk.cantAttackUntilTurn !== undefined && state.turn <= atk.cantAttackUntilTurn) {
    return null;
  }
  // Per-attack locks (Riolu/Mega Brave-style "can't use <name> next turn").
  const perAttackLock = (atk as typeof atk & { cantUseAttacksUntilTurn?: Record<string, number> }).cantUseAttacksUntilTurn;
  const provided = energyPoolForCost(atk, state);
  const defender = state.players[opponentOf(player)].active;
  let best: { index: number; value: number } | null = null;
  for (let i = 0; i < atk.card.attacks.length; i++) {
    const move = atk.card.attacks[i];
    const cost = effectiveAttackCost(state, atk, move.cost);
    if (!canPayCost(provided, cost)) continue;
    // Skip attacks that are locked for this turn by a prior self-lock effect.
    if (perAttackLock && perAttackLock[move.name] !== undefined && state.turn <= perAttackLock[move.name]) {
      continue;
    }
    const v = attackValue(state, player, atk, move, defender);
    if (!best || v > best.value) best = { index: i, value: v };
  }
  return best;
}

// --- Pending-pick heuristics -----------------------------------------------

// Returns the index (in the pool) of the Pokémon best suited to power up the
// AI's strategy. Scores evolution pieces it needs, future attackers, and type
// matches.
function scorePickedPokemon(
  state: GameState,
  player: PlayerId,
  card: PokemonCard,
  primaryEnergy: EnergyType | null,
): number {
  const pl = state.players[player];
  let s = 0;
  const isBasicCard = card.subtypes.includes("Basic");
  // High-HP / high-damage Basics make great future attackers.
  if (isBasicCard) {
    s += card.hp / 20;
    const cheapest = card.attacks.length
      ? Math.min(...card.attacks.map((a) => a.cost.length))
      : 99;
    if (cheapest <= 1) s += 30;
    if (cheapest === 2) s += 20;
    if (primaryEnergy && card.types.includes(primaryEnergy)) s += 15;
    if (isRuleBox(card)) s += 10; // ex = more power later
  } else {
    // Evolution card: good if we already have its pre-evo in play.
    const inPlay = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
    const haveBase = inPlay.some((p) => p.card.name === card.evolvesFrom);
    if (haveBase) s += 60;
    else s += 10;
    s += card.hp / 25;
  }
  // Prefer Pokémon we don't already have a copy of in play (diversify).
  const inPlayNames = new Set<string>();
  if (pl.active) inPlayNames.add(pl.active.card.name);
  for (const b of pl.bench) inPlayNames.add(b.card.name);
  if (inPlayNames.has(card.name)) s -= 25;
  return s;
}

function scorePickedEnergy(
  card: EnergyCard,
  primaryEnergy: EnergyType | null,
): number {
  if (isBasicEnergy(card) && primaryEnergy && card.provides.includes(primaryEnergy)) return 40;
  if (isBasicEnergy(card)) return 25;
  return 15; // special energy, treat as okay
}

function scorePickedTrainer(state: GameState, player: PlayerId, card: TrainerCard): number {
  // Supporters: score roughly like we would for playing one this turn, plus a
  // "we don't have it yet" bonus.
  if (card.subtypes.includes("Supporter")) return 50 + scoreTrainerForNow(state, player, card) / 2;
  if (card.subtypes.includes("Stadium")) return 30;
  if (card.subtypes.includes("Pokémon Tool") || card.subtypes.includes("Tool")) return 35;
  return 40; // item — usually helpful
}

// Picks the top-N cards from the pool by our own scoring. Handles Nest Ball,
// Ultra Ball, Buddy-Buddy Poffin, Pokégear, etc. Supporter-search effects
// (Pokégear, Drayton) get Supporter preference; energy searches prefer the
// deck's primary type.
function resolveAiPendingPickSmart(state: GameState, player: PlayerId): boolean {
  const pick = state.pendingPick;
  if (!pick || pick.player !== player) return false;

  const pl = state.players[player];
  const label = pick.label.toLowerCase();
  const primaryEnergy = deckPrimaryEnergy(pl.deck, pl.hand);

  const eligible = pick.eligibleIndexes ?? pick.pool.map((_, i) => i);
  const max = Math.min(pick.max, eligible.length);
  if (max <= 0) {
    resolvePendingPick(state, player, []);
    return true;
  }

  // Discriminant-first dispatch. Effect-specific AI lanes match on
  // `pick.effectKind` (a stable identifier set by the effect that opened
  // the picker) rather than parsing `label`. Falls through to the
  // generic / label-based logic below if no effectKind is set or the
  // kind has no specialized handler yet.
  if (pick.effectKind) {
    switch (pick.effectKind) {
      case "preciousTrolley": {
        // Pick up to `max` Basics, ranked by archetype evolution support
        // first then generic Pokémon score.
        const evolvesFromSet = new Set<string>();
        for (const c of pl.deck) {
          if (isPokemonCard(c) && c.evolvesFrom) evolvesFromSet.add(c.evolvesFrom);
        }
        for (const c of pl.hand) {
          if (isPokemonCard(c) && c.evolvesFrom) evolvesFromSet.add(c.evolvesFrom);
        }
        const scored = eligible.map((i) => {
          const c = pick.pool[i];
          let s = 0;
          if (isPokemonCard(c)) {
            s = scorePickedPokemon(state, player, c, primaryEnergy);
            if (evolvesFromSet.has(c.name)) s += 40;
          }
          return { i, c, s };
        });
        scored.sort((a, b) => b.s - a.s);
        const picked: number[] = [];
        const seenNames = new Set<string>();
        for (const s of scored) {
          if (picked.length >= max) break;
          if (!isPokemonCard(s.c)) continue;
          if (seenNames.has(s.c.name)) continue;
          picked.push(s.i);
          seenNames.add(s.c.name);
        }
        resolvePendingPick(state, player, picked);
        return true;
      }
      case "energySearchPro": {
        // Different basic-Energy types only. Resolver enforces uniqueness;
        // here we de-dupe ourselves so the AI never gets caught by the
        // resolver-side rejection.
        const seenTypes = new Set<string>();
        const picked: number[] = [];
        const scored = eligible.map((i) => {
          const c = pick.pool[i];
          const s = isEnergyCard(c) ? scorePickedEnergy(c, primaryEnergy) : 0;
          return { i, c, s };
        });
        scored.sort((a, b) => b.s - a.s);
        for (const s of scored) {
          if (picked.length >= max) break;
          if (!isEnergyCard(s.c)) continue;
          const t = s.c.provides[0];
          if (!t || seenTypes.has(t)) continue;
          seenTypes.add(t);
          picked.push(s.i);
        }
        resolvePendingPick(state, player, picked);
        return true;
      }
      case "levincia": {
        // All eligible discard Energy is already filtered to Basic Lightning
        // — just take up to `max`.
        resolvePendingPick(state, player, eligible.slice(0, max));
        return true;
      }
      case "glassTrumpetEnergyPick": {
        // Pull up to 2 Basic Energy from discard. Prefer the deck's primary
        // type to fuel the Tera attacker.
        const scored = eligible.map((i) => {
          const c = pick.pool[i];
          const s = isEnergyCard(c) ? scorePickedEnergy(c, primaryEnergy) : 0;
          return { i, s };
        });
        scored.sort((a, b) => b.s - a.s);
        resolvePendingPick(state, player, scored.slice(0, max).map((x) => x.i));
        return true;
      }
      case "grandTreeStage1":
      case "grandTreeStage2": {
        // The captured-instance afterPick handlers in pendingPick.ts apply
        // the chosen Stage 1 / Stage 2 to the right ally. AI just picks
        // the first eligible card (only one card matches by construction
        // — the predicate is name-keyed). For Stage 2 (optional), still
        // take it: the surrounding stadiumActivated AI lane already
        // decides whether to run the chain.
        resolvePendingPick(state, player, eligible.slice(0, max));
        return true;
      }
      case "academyAtNight":
      case "prismTower":
      case "mysteryGarden":
        // These spawn pendingHandReveal, not pendingPick. Defensive
        // fallthrough — if a future change ever spawns a pendingPick under
        // these kinds, take the generic-scoring path below.
        break;
    }
  }

  // Special handling: Buddy-Buddy Poffin — pick TWO DIFFERENT low-HP Basics
  // that set up evolution lines.
  if (label.startsWith("buddy-buddy poffin")) {
    // Precompute the set of "evolves-from" names available in deck+hand once,
    // turning the per-candidate scan into an O(1) Set.has() lookup.
    const evolvesFromSet = new Set<string>();
    for (const c of pl.deck) {
      if (isPokemonCard(c) && c.evolvesFrom) evolvesFromSet.add(c.evolvesFrom);
    }
    for (const c of pl.hand) {
      if (isPokemonCard(c) && c.evolvesFrom) evolvesFromSet.add(c.evolvesFrom);
    }
    const scored = eligible.map((i) => {
      const c = pick.pool[i];
      let s = 0;
      if (isPokemonCard(c)) {
        s = scorePickedPokemon(state, player, c, primaryEnergy);
        if (evolvesFromSet.has(c.name)) s += 40;
      }
      return { i, c, s };
    });
    // Prefer distinct names.
    scored.sort((a, b) => b.s - a.s);
    const picked: number[] = [];
    const seenNames = new Set<string>();
    for (const s of scored) {
      if (picked.length >= max) break;
      if (!isPokemonCard(s.c)) continue;
      if (seenNames.has(s.c.name)) continue;
      picked.push(s.i);
      seenNames.add(s.c.name);
    }
    resolvePendingPick(state, player, picked);
    return true;
  }

  // Generic scoring.
  const scored = eligible.map((i) => {
    const c = pick.pool[i];
    let s = 0;
    if (isPokemonCard(c)) s = scorePickedPokemon(state, player, c, primaryEnergy);
    else if (isEnergyCard(c)) s = scorePickedEnergy(c, primaryEnergy);
    else if (isTrainer(c)) s = scorePickedTrainer(state, player, c);
    return { i, s };
  });
  scored.sort((a, b) => b.s - a.s);
  const pickedIdxs = scored.slice(0, max).map((x) => x.i);
  resolvePendingPick(state, player, pickedIdxs);
  return true;
}


// --- Main turn loop --------------------------------------------------------

// One discrete AI decision. Returns true if the AI is still working on its
// turn and the caller should call again; false when the turn has ended (the
// AI attacked, ran out of productive moves, or the game ended).
//
// Splitting the decision loop into stepwise calls lets the UI animate the
// turn — render after each step so the player can watch what the CPU is
// doing — while keeping the engine logic identical to the synchronous
// takeAiTurn() path.
export function aiStep(state: GameState, player: PlayerId): boolean {
  if (state.phase === "gameOver" || state.activePlayer !== player) return false;

  if (state.pendingPromote === player) {
    resolveAiPendingPromote(state, player);
    return true;
  }
  if (state.pendingPick && state.pendingPick.player === player) {
    resolveAiPendingPickSmart(state, player);
    return true;
  }
  if (state.pendingHandReveal && state.pendingHandReveal.player === player) {
    resolveAiHandReveal(state);
    return true;
  }
  if (state.pendingSearchNotice && state.pendingSearchNotice.player === player) {
    resolvePendingSearchNotice(state, player);
    return true;
  }

  // v2 with MCTS: search for the best single action with a 600ms budget.
  // If MCTS returns endTurn, fall through to the greedy attack-then-end
  // path so existing attack-handling stays consistent. If MCTS returns a
  // non-attack action, apply it and let the loop re-evaluate. If MCTS
  // returns null (no candidates / exhausted budget), fall through to
  // greedy. The lookaheadActive guard prevents re-entering MCTS during
  // its own greedy rollouts.
  // MCTS hook — only runs when `mctsBudgetMs > 0` (opt-in per-player).
  // v2 heuristics run regardless via the score adjustments above. MCTS
  // adds wall-clock cost; gating it explicitly keeps `npm run test` fast
  // while still allowing benchmarks / production to enable it.
  // Phase 6 (endgame solver): when prizes ≤ 2 on either side, the game
  // is in lethal-math territory. Champions calculate exhaustively here.
  // We approximate by bumping the MCTS budget 4× so more iterations land
  // in the closing window. Cheaper than a separate exhaustive search.
  const baseBudget = state.players[player].mctsBudgetMs ?? 0;
  const opp = state.players[opponentOf(player)];
  const inEndgame =
    state.players[player].prizes.length <= 2 || opp.prizes.length <= 2;
  const mctsBudget = baseBudget > 0 && inEndgame ? baseBudget * 4 : baseBudget;
  if (
    !lookaheadActive &&
    mctsBudget > 0 &&
    state.players[player].aiVersion === "v2" &&
    state.phase === "main" &&
    state.activePlayer === player
  ) {
    // Set lookaheadActive BEFORE running MCTS so the rollouts (which call
    // back into takeAiTurn → aiStep) skip the MCTS branch and use greedy
    // instead. Without this guard MCTS would recurse infinitely.
    lookaheadActive = true;
    let result: McAction | null = null;
    try {
      result = runMctsForTurn(state, player, mctsBudget);
    } finally {
      lookaheadActive = false;
    }
    if (result && result.kind !== "endTurn") {
      lookaheadActive = true;
      try {
        applyMctsAction(state, player, result);
      } finally {
        lookaheadActive = false;
      }
      return true;
    }
    // MCTS chose endTurn or returned null → fall through to greedy. The
    // greedy path will pick the best attack (or end the turn cleanly).
  }

  if (tryStepAiTurn(state, player)) return true;

  // Nothing productive left — try to attack, then end. Either path ends the
  // turn (attack() runs end-of-turn flow internally; endTurn explicitly).
  if (tryAttack(state, player)) return false;
  endTurn(state, player);
  return false;
}

// Wraps `runMcts` with the engine-specific eval + clone. Uses depth=0
// rollouts (no greedy playout — just leaf eval via scorePosition) so each
// iteration is cheap (~1-2ms). With 200ms budget that's ~100 iterations,
// enough for UCB to differentiate the top moves. A greedy-playout variant
// is available via `rolloutPolicy` but at this codebase's clone cost it
// only affords ~1-2 iterations per call, defeating MCTS's exploration.
function runMctsForTurn(
  state: GameState,
  player: PlayerId,
  budgetMs: number,
): McAction | null {
  const result = runMcts(state, player, {
    budgetMs,
    explorationC: 350,
    rolloutDepthTurns: 0,
    topK: 8,
    cloneStateForSearchWithSeed,
    leafEval: (s, p) => scorePosition(s, p),
  });
  return result.bestAction;
}

function applyMctsAction(state: GameState, player: PlayerId, a: McAction): boolean {
  switch (a.kind) {
    case "attack":
      return attack(state, player, a.attackIndex).ok;
    case "attachEnergy":
      return attachEnergy(state, player, a.handIdx, a.targetInstanceId).ok;
    case "evolve":
      return evolve(state, player, a.handIdx, a.targetInstanceId).ok;
    case "playBasic":
      return playBasicToBench(state, player, a.handIdx).ok;
    case "playTrainer":
      return playTrainer(state, player, a.handIdx, a.target).ok;
    case "retreat":
      return retreat(state, player, a.benchIdx).ok;
    case "activateAbility":
      return activateAbility(state, player, a.holderInstanceId, a.abilityIdx).ok;
    case "useStadium":
      return useStadium(state, player).ok;
    case "endTurn":
      endTurn(state, player);
      return true;
  }
}

export function takeAiTurn(state: GameState, player: PlayerId): void {
  if (state.pendingPromote === player) resolveAiPendingPromote(state, player);

  // v2: try MCTS first to plan the whole turn. The MCTS picks a single
  // best first action; we apply it then loop back into the greedy step
  // logic for follow-up actions. Each `aiStep` iteration may re-invoke
  // MCTS — bounded by `mctsBudget` per call. If MCTS produces no result
  // (e.g., search exhausted before any iteration completed), fall back
  // to greedy. The lookaheadActive guard prevents recursive MCTS during
  // its own simulations.
  // (MCTS hook lives inside aiStep — see below.)

  const MAX_ITERS = 60;
  let safety = MAX_ITERS;
  while (safety-- > 0) {
    // Mid-turn ability/attack KOs (Adrena-Brain, Cursed Blast, bench snipes)
    // can put pendingPromote on the OPPONENT while it's still our turn. We
    // can't proceed (phase is "promoteActive") until it's resolved. For AI
    // opponents, drive the promote so we can keep playing. For human
    // opponents in vsCPU, just bail — App.tsx will surface the picker and
    // re-invoke us once the human picks.
    if (state.pendingPromote && state.pendingPromote !== player) {
      if (state.players[state.pendingPromote].isAI) {
        resolveAiPendingPromote(state, state.pendingPromote);
        continue;
      }
      return;
    }
    if (!aiStep(state, player)) return;
  }
  endTurn(state, player);
}

// One decision step. Returns true if it made progress and the loop should
// re-evaluate from the top (so benefits from earlier steps — new Pokémon in
// play after Nest Ball, fresh hand after Professor's Research — are visible).
function tryStepAiTurn(state: GameState, player: PlayerId): boolean {
  const pl = state.players[player];

  // Step 1: bench Basics if we're thin. Bench < 3 is below the v2
  // bench-discipline threshold, so shouldBenchBasicNow always passes here;
  // the gate is included for symmetry with Step 4 / future tightening.
  if (pl.bench.length < 3) {
    const idx = findPrimaryBasic(state, player);
    if (idx >= 0 && shouldBenchBasicNow(state, player, pl.hand[idx])) {
      if (playBasicToBench(state, player, idx).ok) return true;
    }
  }

  // Step 2: search Items before Supporters. Deck-thinning makes the Supporter
  // more impactful and hand info richer when deciding what to play next.
  const itemPick = pickBestTrainer(state, player, isItem);
  if (itemPick && itemPick.score >= 40) {
    if (playTrainer(state, player, itemPick.index).ok) return true;
  }

  // Step 3: activate free-value abilities (draw, energy acceleration, heal).
  if (tryActivateAbility(state, player)) return true;

  // Step 4: evolve anything ready. Evolving now (a) keeps the chain moving and
  // (b) can power-up a benched attacker to replace a dying Active.
  if (tryEvolve(state, player)) return true;

  // Fill remaining bench before we spend the Supporter. Some searches want
  // bench slots free. v2 gates this through shouldBenchBasicNow so we don't
  // hand a free prize to a spreader by benching dead-weight filler when
  // the board is already developed.
  if (pl.bench.length < 4) {
    const idx = findPrimaryBasic(state, player);
    if (idx >= 0 && shouldBenchBasicNow(state, player, pl.hand[idx])) {
      if (playBasicToBench(state, player, idx).ok) return true;
    }
  }

  // Step 5: best Supporter now. We've already searched, drawn from abilities,
  // and evolved — so the Supporter decision has full information.
  if (!pl.supporterPlayedThisTurn) {
    const supPick = pickBestTrainer(state, player, isSupporter);
    if (supPick && supPick.score >= 45) {
      // Targetable Supporters (gust) need target info; handled in the play.
      if (tryPlaySupporterWithTarget(state, player, supPick.index)) return true;
    }
  }

  // Play a Stadium if we have one and none is on the field (or ours would
  // displace the opponent's). v2 Arboliva gets one extra exception: replace
  // our own non-Forest Stadium with Forest of Vitality when it immediately
  // unlocks a Grass evolution chain this turn.
  const stadiumIdx = pickStadiumToPlay(state, player);
  if (stadiumIdx >= 0) {
    const alreadyOurs = state.stadium?.controller === player;
    const card = pl.hand[stadiumIdx];
    const replacingOwnForForest =
      isTrainer(card) &&
      card.name === "Forest of Vitality" &&
      forestOfVitalityUnlocksGrassEvolution(state, player);
    if (
      (!alreadyOurs || replacingOwnForForest) &&
      playTrainer(state, player, stadiumIdx).ok
    ) return true;
  }

  // Activate the in-play Stadium's once-per-turn effect. Each activated
  // Stadium's `run()` already short-circuits to an AI-friendly auto-resolve
  // path (no human picker spawned), so this just needs to fire useStadium
  // when the precheck passes.
  // Lumiose City already short-circuits via `endTurnOnResolve`, so the
  // auto-pick path consumes the Bench-search and ends the turn cleanly.
  if (
    !pl.stadiumUsedThisTurn &&
    state.stadium &&
    stadiumHasActivatedEffect(state.stadium.card.name)
  ) {
    const pre = precheckStadium(state, player);
    if (pre.ok) {
      const r = useStadium(state, player);
      if (r.ok) return true;
    }
  }

  // Step 6: attach Energy — after searches/evolves so the right attacker
  // exists on the field.
  if (!pl.energyAttachedThisTurn) {
    const eIdx = pl.hand.findIndex(isEnergyCard);
    if (eIdx >= 0) {
      const target = pickEnergyAttachTarget(state, player, pl.hand[eIdx] as EnergyCard);
      if (target && attachEnergy(state, player, eIdx, target.instanceId).ok) return true;
    }
  }

  // Step 7: attach Tools to the Active (simple: first one, first free holder).
  const toolIdx = pl.hand.findIndex(isTool);
  if (toolIdx >= 0) {
    const candidates = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
    const target = candidates.find((p) => (p.tools?.length ?? 0) === 0);
    if (target &&
      playTrainer(state, player, toolIdx, { kind: "inPlay", instanceId: target.instanceId }).ok) return true;
  }

  // Play a Supporter at a lower threshold if nothing else is happening — we're
  // about to end the turn otherwise.
  if (!pl.supporterPlayedThisTurn) {
    const supPick = pickBestTrainer(state, player, isSupporter);
    if (supPick && supPick.score >= 25) {
      if (tryPlaySupporterWithTarget(state, player, supPick.index)) return true;
    }
  }

  // Step 8a: defensive retreat if our Active is about to be OHKO'd and a
  // Bench option offers a safer continuation. Skipped when we have a lethal
  // attack available from the current Active — taking the KO is always the
  // right call over playing defense.
  if (tryDefensiveRetreat(state, player)) return true;

  // Step 8b: retreat if our Active can't attack but a benched one can.
  if (tryRetreat(state, player)) return true;

  // Step 8c: OFFENSIVE switch — Active can attack but a Bench attacker has
  // a clean OHKO that the Active doesn't. Trade tempo for the prize.
  if (tryOffensiveSwitch(state, player)) return true;

  return false;
}

// Finds the most-useful Basic Pokémon in hand to bench (prefers evolution
// chain bases, then type-matching).
function findPrimaryBasic(state: GameState, player: PlayerId): number {
  const pl = state.players[player];
  const primary = deckPrimaryEnergy(pl.deck, pl.hand);
  // v2: bias bench picks toward archetype-defining Basics so the AI always
  // sets up its plan first (Riolu for Lucario, Smoliv for Arboliva, etc.).
  const arch = v2Active(state, player) ? archetypeOf(state, player) : "generic";
  let bestIdx = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < pl.hand.length; i++) {
    const c = pl.hand[i];
    if (!isPokemonCard(c) || !isBasic(c)) continue;
    let s = scorePickedPokemon(state, player, c, primary);
    s += archetypeBenchBonus(arch, c);
    if (s > bestScore) { bestScore = s; bestIdx = i; }
  }
  return bestIdx;
}

// Activate the highest-value free ability on the board. Draw beats heal beats
// switch — in that order, roughly.
function tryActivateAbility(state: GameState, player: PlayerId): boolean {
  const pl = state.players[player];
  const holders = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
  // v2: signature abilities (Teal Dance, Psychic Draw, Heave-Ho Catcher)
  // get a top-priority bonus so the archetype's engine fires before any
  // generic free-value ability competes for the same turn slot.
  const v2 = v2Active(state, player);
  const arch = v2 ? archetypeOf(state, player) : "generic";
  let bestTarget: { holder: PokemonInPlay; abilityIdx: number; score: number } | null = null;

  for (const holder of holders) {
    if (holder.abilityUsedThisTurn) continue;
    if (!abilitiesActiveOn(state, holder.card)) continue;
    const abilities = holder.card.abilities ?? [];
    for (let ai = 0; ai < abilities.length; ai++) {
      const ab = abilities[ai];
      if (!ab.effect) continue;
      let score = scoreAbility(state, player, holder, ab.effect);
      score += archetypeAbilityBonus(arch, ab.name);
      if (v2) score += playbookAbilityBonusFromState(state, player, ab.name);
      if (score > 0 && (!bestTarget || score > bestTarget.score)) {
        bestTarget = { holder, abilityIdx: ai, score };
      }
    }
  }
  if (!bestTarget) return false;
  const res = activateAbility(state, player, bestTarget.holder.instanceId, bestTarget.abilityIdx);
  return res.ok;
}

function scoreAbility(
  state: GameState,
  player: PlayerId,
  holder: PokemonInPlay,
  effect: import("./types").AbilityEffect,
): number {
  const pl = state.players[player];
  const opp = state.players[opponentOf(player)];
  const hasBasicEnergyInHand = (et: import("./types").EnergyType): boolean =>
    pl.hand.some((c) => isBasicEnergy(c) && c.provides.includes(et));
  const hasBasicEnergyInDiscard = (et?: import("./types").EnergyType): boolean =>
    pl.discard.some(
      (c) => isBasicEnergy(c) && (et === undefined || c.provides.includes(et)),
    );
  const allies = (): PokemonInPlay[] =>
    [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
  const mostHurt = (): number =>
    Math.max(0, ...allies().map((p) => p.damage));

  switch (effect.kind) {
    case "drawOne": return pl.hand.length < 7 ? 50 : 20;
    case "drawTwo": return pl.hand.length < 8 ? 65 : 25;
    case "drawN": return pl.hand.length < 8 ? 60 + effect.count * 5 : 25;
    case "drawNActiveOnly":
      return pl.active && pl.active.instanceId === holder.instanceId &&
        pl.hand.length < 7 ? 60 : 0;
    case "drawNDiscardCost":
      return pl.hand.length >= 2 && pl.hand.length < 7 ? 60 : 10;
    case "healSelf": return holder.damage >= effect.amount ? 50 : 10;
    case "healAny":
    case "healEachOwn": return mostHurt() >= effect.amount ? 55 : 10;

    // Energy ramp from hand ---------------------------------------------------
    case "searchBasicEnergy": return weNeedEnergy(state, player) ? 70 : 40;
    case "attachEnergyFromHand":
      return hasBasicEnergyInHand(effect.energyType) ? 75 : 0;
    case "attachEnergyFromHandThenDraw":
      // Teal Dance: attach + draw — strict upgrade over plain attach. Always
      // fire when a matching Energy is in hand.
      return hasBasicEnergyInHand(effect.energyType) ? 85 : 0;
    case "attachEnergyFromHandThenHeal":
      return hasBasicEnergyInHand(effect.energyType) ? 78 : 0;
    case "attachEnergyFromHandToBenchNameN":
      return hasBasicEnergyInHand(effect.energyType) &&
        pl.bench.some((p) => p.card.name.startsWith(effect.namePrefix))
        ? 80 : 0;
    case "attachEnergyFromHandToNamedAsOften":
      return hasBasicEnergyInHand(effect.energyType) &&
        allies().some((p) => p.card.name.includes(effect.namePrefix))
        ? 80 : 0;
    case "attachEnergyFromHandToActiveNamePrefix":
      return pl.active && pl.active.card.name.startsWith(effect.namePrefix) &&
        pl.hand.some(isBasicEnergy) ? 75 : 0;
    case "attachMixedFromHand":
      return (hasBasicEnergyInHand(effect.typeA) || hasBasicEnergyInHand(effect.typeB))
        ? 75 : 0;

    // Energy ramp from discard / deck ----------------------------------------
    case "attachEnergyFromDiscardToSelf": {
      const has = hasBasicEnergyInDiscard();
      return has && holder.card.attacks.some((a) => a.cost.length > energyPoolForCost(holder, state).length) ? 70 : 10;
    }
    case "attachEnergyFromDiscardToBench":
      return hasBasicEnergyInDiscard(effect.energyType) && pl.bench.length > 0 ? 75 : 0;
    case "top4AttachEnergyType":
      return weNeedEnergy(state, player) ? 60 : 35;

    // Movement / repositioning -----------------------------------------------
    case "moveBasicEnergyAnywhere":
    case "moveOwnBasicEnergyBetween": {
      // Only worthwhile when a basic Energy of the right type is on the
      // bench AND the Active needs more energy. Otherwise skip — we'd just
      // be re-shuffling for no gain.
      const sourceEnergyType = effect.kind === "moveBasicEnergyAnywhere" ? effect.energyType : undefined;
      const benchHasIt = pl.bench.some((p) =>
        p.attachedEnergy.some((e) =>
          isBasicEnergy(e) && (sourceEnergyType === undefined || e.provides.includes(sourceEnergyType))));
      const activeNeedsMore = !!pl.active &&
        pl.active.card.attacks.some((a) => a.cost.length > pl.active!.attachedEnergy.length);
      return benchHasIt && activeNeedsMore ? 55 : 0;
    }
    case "moveDamageOwnToOpp": {
      // Munkidori Adrena-Brain et al. — score by the prize/value swing of
      // landing N counters on the best opp target.
      if (effect.energyConditionType) {
        const hasCond = holder.attachedEnergy.some((en) =>
          en.provides.includes(effect.energyConditionType!),
        );
        if (!hasCond) return 0;
      }
      const damagedAllies = allies().filter((a) => a.damage > 0);
      if (damagedAllies.length === 0) return 0;
      const sourceMax = Math.max(...damagedAllies.map((a) => a.damage));
      const moved = Math.min(effect.counters, Math.floor(sourceMax / 10));
      if (moved === 0) return 0;
      const added = moved * 10;
      const oppTargets = [opp.active, ...opp.bench].filter((p): p is PokemonInPlay => !!p);
      let best = 0;
      for (const t of oppTargets) {
        const remaining = effectiveMaxHp(t, state) - t.damage;
        if (added >= remaining) {
          // Free KO via counter movement — directly gain prizes.
          const score = 90 + prizeValue(t.card) * 30;
          if (score > best) best = score;
        } else {
          // Chip toward a follow-up KO. The closer this gets to lethal, the
          // more value the chip carries.
          const chipScore = 25 + Math.max(0, 60 - (remaining - added) / 2);
          if (chipScore > best) best = chipScore;
        }
      }
      // Also pull damage off our own — useful even without a KO if our
      // Active is in OHKO range from the opponent's expected hit.
      const ourMostHurt = damagedAllies.reduce((a, b) => a.damage > b.damage ? a : b);
      const ourRemaining = effectiveMaxHp(ourMostHurt, state) - ourMostHurt.damage;
      const threat = opponentMaxDamageNextTurn(state, player);
      if (threat >= ourRemaining && threat < ourRemaining + added) {
        // We save a Pokémon by removing the damage that'd OHKO it.
        best = Math.max(best, 70 + prizeValue(ourMostHurt.card) * 20);
      }
      return best;
    }
    case "switchToActiveFromBench": return 0;
    case "switchWithActiveIfMegaExInPlay": {
      const active = pl.active;
      if (!active || active.instanceId !== holder.instanceId) return 0;
      return activeCantAttack(state, player) ? 60 : 0;
    }
    case "switchBenchedTypeToActiveWithStatus":
    case "swapWithBenchAndForceOppPromote": return 0;
    case "switchWithBench": {
      const active = pl.active;
      if (!active || active.instanceId !== holder.instanceId) return 0;
      if (!activeCantAttack(state, player)) return 0;
      return pl.bench.some((p) => benchCanAttack(state, p)) ? 60 : 0;
    }
    case "shuffleSelfIntoDeck": {
      // Pulls this Pokémon back into deck. From the Active spot, this
      // forces a promote — only sane if there's a Bench Pokémon to take
      // its place. From the Bench, it's mostly a tempo loss unless the
      // Pokémon is damaged enough to risk getting KO'd next turn.
      const fromActive = pl.active?.instanceId === holder.instanceId;
      if (fromActive) {
        return pl.bench.length > 0 && holder.damage > 0 ? 30 : 0;
      }
      return holder.damage >= holder.card.hp - 30 ? 25 : 0;
    }

    // Searches ---------------------------------------------------------------
    case "searchDeckAnyCard": return 55;
    case "searchDeckPokemon": return 50;
    case "searchDeckPokemonNamePrefix": return 55;
    case "searchDeckStadium": return state.stadium ? 25 : 50;
    case "searchDeckTrainerByName": return 55;
    case "searchEvolutionPokemonGated": return 65;
    case "searchEvolutionPokemonOfType": return 60;
    case "fanCallFirstTurn": return state.turn === 1 ? 80 : 0;
    case "benchFromDiscardHpMax":
      // Recovery: pull a small Basic out of discard onto the bench.
      return pl.discard.some((c) =>
        c.supertype === "Pokémon" &&
        c.subtypes.includes("Basic") &&
        c.hp <= effect.hpMax) && pl.bench.length < 5 ? 55 : 0;
    case "emergencyRotationFromHand":
      // Activated from hand — gated by predicate; safe to score positive.
      return 50;

    // Disruption / opponent-facing ------------------------------------------
    case "applyStatusToOppActive":
      return opp.active ? 50 : 0;
    case "flipReturnOppActiveEnergyToHand":
      return (opp.active?.attachedEnergy.length ?? 0) > 0 ? 45 : 0;
    case "flipGustOppWithStatus":
      return opp.bench.length > 0 ? 35 : 0;
    case "flipDiscardRandomFromOppHand":
      return opp.hand.length > 0 ? 35 : 0;
    case "flipChooseStatusOpp":
      return opp.active ? 45 : 0;
    case "discardHandEnergyStatusOppActive":
      return opp.active && pl.hand.some((c) =>
        isBasicEnergy(c) && c.provides.includes(effect.energyType)) ? 50 : 0;
    case "devolveOppEvolution":
      return opp.active && opp.active.evolvedFrom.length > 0 ? 55 : 0;
    case "discardToolFromHandGustOpp":
      return opp.bench.length > 0 &&
        pl.hand.some((c) => c.name === effect.toolName) ? 60 : 0;
    case "revealOppHandPutOnOppBench":
      return opp.bench.length < 5 ? 25 : 0;

    // Healing variants -------------------------------------------------------
    case "healAnyIfMegaExTypeInPlay":
    case "healAnyIfEnergyAttached":
      return mostHurt() >= effect.amount ? 50 : 0;

    // Hand / deck shaping ----------------------------------------------------
    case "discardSelfEnergyDrawToN":
      return holder.attachedEnergy.some((e) => e.provides.includes(effect.energyType)) &&
        pl.hand.length < effect.targetHand ? 50 : 0;
    case "putHandToBottomDrawToN":
      return pl.hand.length <= 2 ? 50 : 10;
    case "drawToNIfSupporterPlayedName":
      return pl.lastSupporterNameThisTurn === effect.supporterName &&
        pl.hand.length < effect.targetHand ? 70 : 0;
    case "searchEnergyIfSupporterPlayedName":
      return pl.lastSupporterNameThisTurn === effect.supporterName &&
        weNeedEnergy(state, player) ? 70 : 0;
    case "swapHandCardWithDeckTop":
      return pl.hand.length > 0 ? 25 : 0;
    case "discardBottomDeckSelfToTop": return 0;
    case "lunarCycleDrawN":
      return pl.hand.length < 7 && hasBasicEnergyInHand(effect.costEnergyType) ? 55 : 0;
    case "oppShuffleHandAndDrawN":
      return effect.drawCount >= 4 ? 60 : 35;
    case "oppShuffleToBottomDrawN":
      return pl.hand.length < 7 ? 55 : 25;
    case "bothPlayersDrawOne":
      return pl.hand.length < 5 ? 30 : 0;

    // Peeks ------------------------------------------------------------------
    case "peek2Top": return 35;
    case "peekTopMayDiscard": return 25;
    case "top6RevealSupporter": return 25;

    // Attack-shape buff ------------------------------------------------------
    case "attackBonusThisTurnSelfDamage":
      return holder.damage + effect.selfDamage * 10 < holder.card.hp ? 55 : 0;

    // Self-KO abilities: trade our holder for prizes. Worth it when the prize
    // gain outweighs the prize loss, OR when the holder is going to die
    // anyway (terminal value). ----------------------------------------------
    case "putCountersOnOppThenSelfKO": {
      const oppTargets = [opp.active, ...opp.bench].filter((p): p is PokemonInPlay => !!p);
      if (oppTargets.length === 0) return 0;
      const added = effect.counters * 10;
      // Best KO we can land.
      let prizesGained = 0;
      let chipBest = 0;
      for (const t of oppTargets) {
        const remaining = effectiveMaxHp(t, state) - t.damage;
        if (added >= remaining) {
          const p = prizeValue(t.card);
          if (p > prizesGained) prizesGained = p;
        } else {
          chipBest = Math.max(chipBest, 60 - (remaining - added) / 5);
        }
      }
      const prizesLost = prizeValue(holder.card);
      // Threat check — is our Dusknoir going to die anyway?
      const ourRemaining = effectiveMaxHp(holder, state) - holder.damage;
      const threat = opponentMaxDamageNextTurn(state, player);
      const dyingAnyway = pl.active?.instanceId === holder.instanceId && threat >= ourRemaining;

      if (prizesGained >= prizesLost) {
        // Net positive (or even) prize swing. Big payoff — especially in a
        // tight prize race where the KO ends the game.
        let s = 70 + (prizesGained - prizesLost) * 60;
        if (opp.prizes.length <= prizesGained) s += 200; // game-winning
        if (dyingAnyway) s += 30; // free upside on a terminal Pokémon
        return s;
      }
      if (dyingAnyway && prizesGained > 0) {
        // Free counters before the inevitable KO — squeeze any value we can.
        return 50 + prizesGained * 30;
      }
      // Pure chip — tempo loss usually too costly.
      return chipBest > 50 && dyingAnyway ? chipBest : 0;
    }
    case "attachNFromDiscardThenSelfKO": {
      // E.g., Mega Lucario "Aura Jab" hand-side — trade self-KO for energy
      // ramp. Only sane when the holder is dying anyway and the energy lands
      // on a meaningful target.
      const ourRemaining = effectiveMaxHp(holder, state) - holder.damage;
      const threat = opponentMaxDamageNextTurn(state, player);
      const dyingAnyway = pl.active?.instanceId === holder.instanceId && threat >= ourRemaining;
      if (!dyingAnyway) return 0;
      const benchHasAttacker = pl.bench.some((p) =>
        p.card.attacks.some((a) => a.cost.length > p.attachedEnergy.length));
      return benchHasAttacker ? 60 : 0;
    }
  }
  return 0;
}

// Evolves whichever in-play Pokémon would most benefit. Stage-2-from-Stage-1
// beats Stage-1-from-Basic, all else equal, because Stage 2's are usually the
// real attackers.
function tryEvolve(state: GameState, player: PlayerId): boolean {
  const pl = state.players[player];
  type Option = { handIdx: number; targetId: string; score: number };
  const options: Option[] = [];
  for (let i = 0; i < pl.hand.length; i++) {
    const c = pl.hand[i];
    if (!isPokemonCard(c) || !c.evolvesFrom) continue;
    const targets = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
    for (const t of targets) {
      if (t.card.name !== c.evolvesFrom) continue;
      if (t.playedThisTurn) continue;
      if (t.evolvedThisTurn) continue;
      // Score: bigger HP gain is better; pre-evolved already are always a win.
      let s = c.hp - t.card.hp;
      if (c.subtypes.includes("Stage 2")) s += 30;
      // The evolved form's attack-readiness matters. If the new card has a
      // useable attack with current energy, prefer it. If it doesn't and the
      // pre-evo did, this is a tempo loss — penalize.
      const provided = energyPoolForCost(t, state);
      const newCanAttack = c.attacks.some((a) =>
        canPayCost(provided, a.cost));
      const oldCanAttack = t.card.attacks.some((a) =>
        canPayCost(provided, effectiveAttackCost(state, t, a.cost)));
      if (newCanAttack) s += 25;
      else if (oldCanAttack && t === pl.active) s -= 30;
      // Bonus when this evolution is the Active and our current Active will
      // Mega Evolution ex: 3-prize liability. Slight penalty for evolving
      // into a Mega when we can't immediately attack so the AI doesn't
      // commit to a 3-prizer on a defenseless turn. (Pre-2025 the rule was
      // "Mega evolving ends your turn" — no longer in effect, so no big
      // penalty.)
      const isMega = (c.subtypes ?? []).some((st) => MEGA_SUBTYPE_RE.test(st));
      if (isMega) {
        const canAttackImmediately = c.attacks.some((a) =>
          canPayCost(provided, a.cost));
        s += canAttackImmediately ? 30 : -10;
      }
      // Don't burn an evolution on a damaged Active that's about to die —
      // the new card just gets KO'd. Exception: if evolving heals (some
      // evolutions do via on-evolve abilities), or if HP gain saves it.
      if (t === pl.active && t.damage > 0) {
        const newHp = c.hp;
        const threat = opponentMaxDamageNextTurn(state, player);
        if (threat >= newHp - t.damage && threat < t.card.hp - t.damage + 9999) {
          // Both forms die. Slight penalty to discourage feeding the evolution.
          s -= 20;
        }
      }
      options.push({ handIdx: i, targetId: t.instanceId, score: s });
    }
  }
  if (options.length === 0) return false;
  options.sort((a, b) => b.score - a.score);
  const pick = options[0];
  // Reject very-bad evolutions outright (e.g., Mega without immediate attack).
  if (pick.score <= -100) return false;
  return evolve(state, player, pick.handIdx, pick.targetId).ok;
}

function pickStadiumToPlay(state: GameState, player: PlayerId): number {
  const pl = state.players[player];
  const forestIdx = pl.hand.findIndex(
    (c) => isStadium(c) && c.name === "Forest of Vitality",
  );
  if (forestIdx >= 0 && forestOfVitalityUnlocksGrassEvolution(state, player)) {
    return forestIdx;
  }
  return pl.hand.findIndex(isStadium);
}

function forestOfVitalityUnlocksGrassEvolution(
  state: GameState,
  player: PlayerId,
): boolean {
  if (!v2Active(state, player)) return false;
  if (archetypeOf(state, player) !== "arboliva") return false;
  if (state.stadium?.card.name === "Forest of Vitality") return false;
  if (isPlayersFirstTurn(state, player)) return false;

  const pl = state.players[player];
  const grassEvolutionInHand = pl.hand.some((c) =>
    isPokemonCard(c) &&
    c.evolvesFrom &&
    c.types.includes("Grass"));
  if (!grassEvolutionInHand) return false;

  const targets = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
  return targets.some((target) => {
    if (!target.card.types.includes("Grass")) return false;
    if (!target.playedThisTurn && !target.evolvedThisTurn) return false;
    return pl.hand.some((c) =>
      isPokemonCard(c) &&
      c.evolvesFrom === target.card.name &&
      c.types.includes("Grass"));
  });
}

// Pick the best Trainer of a given kind. Returns null if nothing scores high
// enough — caller decides the threshold.
function pickBestTrainer(
  state: GameState,
  player: PlayerId,
  kind: (c: Card) => c is TrainerCard,
): { index: number; score: number } | null {
  const pl = state.players[player];
  // v2: archetype-defining Trainers get a fixed bonus so the AI prefers
  // its plan's signature cards over generic alternatives (e.g., Festival
  // Grounds over Apple Acid for festival-leads). Playbook adds turn-aware
  // priority on top so e.g. T1 Battle Cage drops before T1 Lana's Aid.
  const v2 = v2Active(state, player);
  const arch = v2 ? archetypeOf(state, player) : "generic";
  let best: { index: number; score: number } | null = null;
  for (let i = 0; i < pl.hand.length; i++) {
    const c = pl.hand[i];
    if (!kind(c)) continue;
    let s = scoreTrainerForNow(state, player, c);
    s += archetypeTrainerBonus(arch, c as TrainerCard);
    if (v2) s += playbookCardBonusFromState(state, player, c.name);
    if (s > (best?.score ?? 0)) best = { index: i, score: s };
  }
  return best;
}

// Supporter plays that need a target (gust) get one picked for them. Other
// Supporters just play normally.
function tryPlaySupporterWithTarget(state: GameState, player: PlayerId, handIdx: number): boolean {
  const pl = state.players[player];
  const card = pl.hand[handIdx];
  if (!card || !isTrainer(card)) return false;
  const id = (card as TrainerCard).effectId;

  if (id === "gustOppBenched" || id === "flipGustOppBenched" || id === "primeCatcher" || id === "gustConfuseOppBasic") {
    const target = bestGustTarget(state, player);
    if (!target) return false;
    logEvent(state, player, `[AI] gusts ${target.card.name} to win the prize exchange.`);
    const res = playTrainer(state, player, handIdx, {
      kind: "oppInPlay", instanceId: target.instanceId,
    });
    return res.ok;
  }

  return playTrainer(state, player, handIdx).ok;
}

// Estimate the opponent's peak damage to our Active on their next turn.
// Factors in current attached energy plus one reasonable +1 attach of the
// opponent's primary deck type (covers "they'll drop one more energy before
// swinging"). Intentionally a ceiling, not an expectation — used to drive
// defensive moves only when a very real threat exists.
function opponentMaxDamageNextTurn(state: GameState, player: PlayerId): number {
  const opp = state.players[opponentOf(player)];
  const oppAct = opp.active;
  const ourAct = state.players[player].active;
  if (!oppAct || !ourAct) return 0;

  const provided = energyPoolForCost(oppAct, state);
  const primary = deckPrimaryEnergy(opp.deck, opp.hand);
  // One-extra-energy hypothetical: if the opp has that energy type available
  // (deck or hand), assume they'll attach it.
  const hasExtraAvailable =
    !!primary &&
    opp.hand
      .concat(opp.deck)
      .some(
        (c) =>
          c.supertype === "Energy" &&
          c.subtypes.includes("Basic") &&
          (c as EnergyCard).provides.includes(primary),
      );
  const providedNext = hasExtraAvailable && primary
    ? [...provided, primary]
    : provided;

  let max = 0;
  for (const move of oppAct.card.attacks) {
    const cost = effectiveAttackCost(state, oppAct, move.cost);
    if (!canPayCost(providedNext, cost)) continue;
    const dmg = estimateDamage(state, opponentOf(player), oppAct, move, ourAct);
    if (dmg > max) max = dmg;
  }
  return max;
}

// Does the AI have a lethal hit on the opponent's Active this turn? Used as
// a short-circuit gate on defensive play — if we can KO now, take the KO.
function hasLethalThisTurn(state: GameState, player: PlayerId): boolean {
  const pl = state.players[player];
  const atk = pl.active;
  if (!atk) return false;
  if (state.firstTurnNoAttack) return false;
  if (atk.cantAttackUntilTurn !== undefined && state.turn <= atk.cantAttackUntilTurn) return false;
  const defender = state.players[opponentOf(player)].active;
  if (!defender) return false;
  const provided = energyPoolForCost(atk, state);
  const perAttackLock = (atk as typeof atk & { cantUseAttacksUntilTurn?: Record<string, number> }).cantUseAttacksUntilTurn;
  for (const move of atk.card.attacks) {
    if (!canPayCost(provided, effectiveAttackCost(state, atk, move.cost))) continue;
    if (perAttackLock && perAttackLock[move.name] !== undefined && state.turn <= perAttackLock[move.name]) continue;
    const dmg = estimateDamage(state, player, atk, move, defender);
    if (defender.damage + dmg >= effectiveMaxHp(defender, state)) return true;
  }
  return false;
}

// Defensive retreat — if our Active will be OHKO'd next turn (per the
// threat estimate) and a Bench option offers a better survival line, retreat
// to the Bench. Gated on "no KO available from the current Active"; taking a
// KO is always better than playing defense.
function tryDefensiveRetreat(state: GameState, player: PlayerId): boolean {
  const pl = state.players[player];
  if (!pl.active || pl.retreatedThisTurn || pl.bench.length === 0) return false;
  if (hasLethalThisTurn(state, player)) return false;

  const ourAct = pl.active;
  const ourHp = effectiveMaxHp(ourAct, state) - ourAct.damage;
  const threat = opponentMaxDamageNextTurn(state, player);
  // Only retreat defensively when the threat would actually KO us.
  if (threat < ourHp) return false;

  const cost = effectiveRetreatCost(ourAct, state).length;
  const currentEnergy = energyPoolForCost(ourAct, state).length;
  if (currentEnergy < cost) return false;

  // Pick the bench option that (a) is likely to survive the threat AND
  // (b) can plausibly attack next turn. Score both; only retreat if the
  // best option scores clearly better than staying.
  let bestIdx = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < pl.bench.length; i++) {
    const b = pl.bench[i];
    const benchHp = effectiveMaxHp(b, state) - b.damage;
    const canAtk = benchCanAttack(state, b);
    let score = 0;
    if (benchHp > threat) score += 100;            // survives the hit
    else score -= 40;                               // also dies — bad swap
    score += Math.min(benchHp, 200) / 10;           // tankier is better
    if (canAtk) score += 40;                        // can counter-attack
    if (b.card.subtypes.includes("ex") || b.card.subtypes.includes("EX")) {
      score -= 30; // don't put an ex up to die if another option exists
    }
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  if (bestIdx < 0 || bestScore < 60) return false;
  const ok = retreat(state, player, bestIdx).ok;
  if (ok) {
    logEvent(state, player, `[AI] retreats defensively — Active was at risk.`);
  }
  return ok;
}

// Retreat if the Active can't meaningfully attack and a benched Pokémon can.
function tryRetreat(state: GameState, player: PlayerId): boolean {
  const pl = state.players[player];
  if (!pl.active || pl.retreatedThisTurn) return false;
  if (pl.bench.length === 0) return false;
  if (!activeCantAttack(state, player)) return false;

  const cost = effectiveRetreatCost(pl.active, state).length;
  const currentEnergy = energyPoolForCost(pl.active, state).length;
  if (currentEnergy < cost) return false; // can't afford

  // Find a benched Pokémon that can attack.
  let bestBench = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < pl.bench.length; i++) {
    const b = pl.bench[i];
    if (!benchCanAttack(state, b)) continue;
    const provided = energyPoolForCost(b, state);
    const defender = state.players[opponentOf(player)].active;
    let bestDmg = 0;
    for (const a of b.card.attacks) {
      if (!canPayCost(provided, effectiveAttackCost(state, b, a.cost))) continue;
      const d = estimateDamage(state, player, b, a, defender);
      if (d > bestDmg) bestDmg = d;
    }
    // Account for retreat cost: losing `cost` energies from the active is
    // painful. Skip retreat if it'd strand the active with 0 energy AND the
    // damage gain is marginal.
    const gain = bestDmg - cost * 5;
    if (gain > bestScore) { bestScore = gain; bestBench = i; }
  }
  if (bestBench < 0) return false;
  if (bestScore < 30) return false; // not worth burning energy
  logEvent(state, player, `[AI] retreats stuck ${pl.active.card.name}.`);
  return retreat(state, player, bestBench).ok;
}

// Offensive switch: stay-in-place is wasting a turn when a Bench Pokémon has
// a clean OHKO available that the Active doesn't. Retreats so the next aiStep
// promotes the bench attacker into position.
function tryOffensiveSwitch(state: GameState, player: PlayerId): boolean {
  const pl = state.players[player];
  if (state.firstTurnNoAttack) return false;
  if (!pl.active || pl.retreatedThisTurn || pl.bench.length === 0) return false;
  const defender = state.players[opponentOf(player)].active;
  if (!defender) return false;

  const cost = effectiveRetreatCost(pl.active, state).length;
  const currentEnergy = energyPoolForCost(pl.active, state).length;
  if (currentEnergy < cost) return false;

  // Active's best damage on the current defender.
  const provided = energyPoolForCost(pl.active, state);
  let activeDmg = 0;
  for (const a of pl.active.card.attacks) {
    if (!canPayCost(provided, effectiveAttackCost(state, pl.active, a.cost))) continue;
    const d = estimateDamage(state, player, pl.active, a, defender);
    if (d > activeDmg) activeDmg = d;
  }
  const defMax = effectiveMaxHp(defender, state);
  const activeWouldOHKO = defender.damage + activeDmg >= defMax;
  if (activeWouldOHKO) return false; // Active does the job — no need to switch

  // Find a bench Pokémon that OHKOs.
  let bestIdx = -1;
  let bestDmg = 0;
  for (let i = 0; i < pl.bench.length; i++) {
    const b = pl.bench[i];
    const bp = energyPoolForCost(b, state);
    let d = 0;
    for (const a of b.card.attacks) {
      if (!canPayCost(bp, effectiveAttackCost(state, b, a.cost))) continue;
      const dmg = estimateDamage(state, player, b, a, defender);
      if (dmg > d) d = dmg;
    }
    if (b.damage + 0 < effectiveMaxHp(b, state) && // alive
      d > bestDmg && b.damage + d >= 0 && defender.damage + d >= defMax) {
      bestDmg = d;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return false;

  // Don't waste a 2-prizer Active just to switch in a 1-prizer for the same
  // KO if we're going to lose the 2-prizer next turn anyway. Compare prize
  // costs vs gain.
  const switchInPrize = prizeValue(pl.bench[bestIdx].card);
  const stayPrize = prizeValue(pl.active.card);
  // If switching costs us a higher-prize Active that's about to die, accept it.
  // But if our Active is healthy AND swapping just promotes a bigger prize
  // target, skip.
  const ourHp = effectiveMaxHp(pl.active, state) - pl.active.damage;
  const threat = opponentMaxDamageNextTurn(state, player);
  if (threat < ourHp && switchInPrize > stayPrize) return false;

  logEvent(state, player, `[AI] retreats to set up a Bench OHKO.`);
  return retreat(state, player, bestIdx).ok;
}

// Attempt to attack this turn. Returns true if an attack was issued (caller
// should exit — attack resolves into endTurn).
function tryAttack(state: GameState, player: PlayerId): boolean {
  if (state.firstTurnNoAttack) return false;
  const pl = state.players[player];
  if (!pl.active) return false;

  // Use 1-ply lookahead at the top level; fall back to greedy when we're
  // already inside a simulation (avoids blowing the search budget).
  const pick = lookaheadActive
    ? pickBestAttack(state, player)
    : pickBestAttackWithLookahead(state, player);
  if (!pick) return false;

  // Respect the action's return value: if attack() rejects the play (sleep
  // flip mid-resolve, precondition change between pick and call, etc.) we
  // must NOT report success or takeAiTurn will exit without ending the turn.
  const result = attack(state, player, pick.index);
  return result.ok;
}

// --- Multi-ply search ------------------------------------------------------
//
// Greedy attack scoring picks the best move based only on the immediate
// position. The lookahead picks the move that leaves us in the best position
// AFTER the opponent's expected response. We clone the state, apply our
// candidate attack, drive the engine forward through any pending* prompts,
// run the opponent's full turn via `takeAiTurn`, then score the result.
//
// Re-entrancy: `takeAiTurn` calls back into `tryAttack` which would call
// `pickBestAttackWithLookahead` again — we guard with `lookaheadActive` so
// the recursive call falls back to greedy.

let lookaheadActive = false;

// Shallow-clone the parts of GameState that mutate during simulation.
// Card objects are immutable in this codebase (deck/hand/etc. just reorder
// references), so we share Card refs across the clone. Mutable shape:
//   - `PokemonInPlay` (damage, attachedEnergy, statuses, tools, etc.)
//   - PlayerState arrays (hand, deck, discard, prizes, bench)
//   - PlayerState scalar flags (energyAttachedThisTurn, etc.)
//   - GameState scalars (turn, phase, etc.)
//   - Pending state objects (pendingPick, pendingPromote, etc.)
//
// Replacing the prior JSON.parse(JSON.stringify(state)) with explicit
// field-by-field copies is the #1 perf lever for both the existing 1-ply
// lookahead (~5-15ms → ~0.3-1ms per clone) AND for the MCTS that builds
// on top of this. Verified by the agent audit as the bottleneck.
//
// The Rng is replaced with a fresh deterministic seed; the log is dropped
// (expensive and irrelevant to eval). Both sides are forced to AI so the
// simulation drives itself.
function cloneStateForSearch(state: GameState): GameState {
  return cloneStateForSearchWithSeed(state, 0xBADC0FFE);
}

// Variant used by MCTS to determinize coin flips and shuffles per
// iteration. Each iteration passes a unique seed so different rollouts
// experience different chance outcomes.
export function cloneStateForSearchWithSeed(state: GameState, seed: number): GameState {
  return {
    players: {
      p1: clonePlayer(state.players.p1, true),
      p2: clonePlayer(state.players.p2, true),
    },
    activePlayer: state.activePlayer,
    turn: state.turn,
    phase: state.phase,
    winner: state.winner,
    log: [],
    firstPlayer: state.firstPlayer,
    firstTurnNoAttack: state.firstTurnNoAttack,
    stadium: state.stadium ? { ...state.stadium } : null,
    pendingPromote: state.pendingPromote,
    pendingPromoteQueue: [...state.pendingPromoteQueue],
    pendingHeavyBaton: state.pendingHeavyBaton
      ? { ...state.pendingHeavyBaton, energies: [...state.pendingHeavyBaton.energies] }
      : null,
    pendingAttachQueue: state.pendingAttachQueue
      ? { ...state.pendingAttachQueue, energies: [...state.pendingAttachQueue.energies] }
      : null,
    pendingHandheldFan: state.pendingHandheldFan
      ? { ...state.pendingHandheldFan }
      : null,
    pendingAmuletOfHope: state.pendingAmuletOfHope
      ? { ...state.pendingAmuletOfHope }
      : null,
    onPromoteResolved: state.onPromoteResolved,
    pendingSecondAttack: state.pendingSecondAttack ? { ...state.pendingSecondAttack } : null,
    pendingPick: state.pendingPick ? { ...state.pendingPick, pool: [...state.pendingPick.pool] } : null,
    pendingSwitchTarget: state.pendingSwitchTarget,
    pendingInPlayTarget: state.pendingInPlayTarget ? { ...state.pendingInPlayTarget } : null,
    pendingHandReveal: state.pendingHandReveal ? { ...state.pendingHandReveal } : null,
    pendingSearchNotice: state.pendingSearchNotice ? { ...state.pendingSearchNotice } : null,
    pendingRareCandyChoice: state.pendingRareCandyChoice
      ? { ...state.pendingRareCandyChoice, handIndexes: [...state.pendingRareCandyChoice.handIndexes] }
      : null,
    snipeTargetOverride: state.snipeTargetOverride,
    coinFlip: state.coinFlip ? { ...state.coinFlip } : null,
    rng: makeRng(seed),
  } as GameState;
}

function clonePlayer(
  pl: GameState["players"]["p1"],
  forceAi: boolean,
): GameState["players"]["p1"] {
  return {
    ...pl,
    hand: [...pl.hand],
    deck: [...pl.deck],
    discard: [...pl.discard],
    prizes: [...pl.prizes],
    bench: pl.bench.map(clonePokemonInPlay),
    active: pl.active ? clonePokemonInPlay(pl.active) : null,
    thisTurnAttackBonuses: pl.thisTurnAttackBonuses.map((b) => ({ ...b })),
    nextOpponentTurnDamageReductions: pl.nextOpponentTurnDamageReductions.map((b) => ({ ...b })),
    isAI: forceAi ? true : pl.isAI,
    aiVersion: pl.aiVersion,
  };
}

function clonePokemonInPlay(p: import("./types").PokemonInPlay): import("./types").PokemonInPlay {
  // Card refs are immutable — share. attachedEnergy + tools + evolvedFrom
  // are arrays of immutable Card refs; copy the array but not the cards.
  return {
    ...p,
    attachedEnergy: [...p.attachedEnergy],
    evolvedFrom: [...p.evolvedFrom],
    tools: [...p.tools],
    statuses: [...p.statuses],
  };
}

// Drive the engine past any pending* state until either (a) a player can
// take normal main-phase actions, or (b) the game is over / wedged.
function drainPending(sim: GameState, maxSteps = 30): void {
  for (let i = 0; i < maxSteps; i++) {
    if (sim.phase === "gameOver") return;
    if (sim.pendingPromote) {
      if (!resolveAiPendingPromote(sim, sim.pendingPromote)) return;
      continue;
    }
    if (sim.pendingPick) {
      const ok = resolveAiPendingPickSmart(sim, sim.pendingPick.player);
      if (!ok) return;
      continue;
    }
    if (sim.pendingHandReveal) {
      const ok = resolveAiHandReveal(sim);
      if (!ok) return;
      continue;
    }
    if (sim.pendingSearchNotice) {
      resolvePendingSearchNotice(sim, sim.pendingSearchNotice.player);
      continue;
    }
    return;
  }
}

// Heuristic position evaluation from `player`'s perspective. Higher is
// better. Game-over states get extreme scores so a winning line dominates;
// otherwise we combine prizes (biggest factor), bench HP, energy on board,
// and a small penalty for being out-of-actives.
// --- Load-bearing scorePosition constants ---------------------------------
// These weights drive the v2 threat-aware leaf eval that's responsible for
// the measured +12.5pp v2+MCTS win-rate edge over v1 (see docs/AI.md).
// Load-bearing MCTS leaf-eval weights; change only with benchmark evidence.
const ACTIVE_OHKO_BASE_PENALTY = 60;
const ACTIVE_OHKO_PRIZE_PENALTY = 80;
const OPP_ACTIVE_OHKO_BASE_BONUS = 50;
const OPP_ACTIVE_OHKO_PRIZE_BONUS = 60;

// --- Phase 2B threat / readiness overlay constants ------------------------
// Additive v2 overlays on top of the existing OHKO penalty/bonus. Smaller
// magnitudes than the base weights — they tune how the AI weighs prize-
// pressure context and immediate attack options on top of the raw threat
// detection. Benchmark coverage at PR boundary, not per-commit.
const ACTIVE_OHKO_GAME_LOSING_PENALTY = 150;
const ACTIVE_OHKO_BENCH_COUNTER_MITIGATION = 30;
const OPP_ACTIVE_GAME_WINNING_BONUS = 200;
const ACTIVE_CAN_ATTACK_NOW_BONUS = 15;
const EVOLUTION_IN_HAND_UNLOCK_BONUS = 10;

// scorePosition: terminal short-circuit + sum of named sub-scores. Each
// sub-score reads `state` for one slice of the position (prize race, threat,
// readiness, board, resources). The Phase 2A extraction is intentionally
// behavior-preserving — new AI strategy lands as additive overlays inside
// these helpers (e.g. scoreBenchRisk for spread-pressure detection).
function scorePosition(state: GameState, player: PlayerId): number {
  if (state.winner === player) return 1_000_000;
  if (state.winner !== null) return -1_000_000;
  return (
    scorePrizeRace(state, player) +
    scoreImmediateThreats(state, player) +
    scoreAttackReadiness(state, player) +
    scoreBoardDevelopment(state, player) +
    scoreResourceQuality(state, player) +
    scoreBenchRisk(state, player) +
    scoreDisruptionTiming(state, player)
  );
}

// Prize differential — the central currency of the game. Each prize the
// opponent owes is worth more than HP or energy. v2 adds a non-linear
// endgame curve (the last prize is worth more than the first; champions
// play harder for prizes 4→6 than for 0→1).
function scorePrizeRace(state: GameState, player: PlayerId): number {
  const me = state.players[player];
  const opp = state.players[opponentOf(player)];
  const v2 = me.aiVersion === "v2";
  const prizeWeight = (prizesTaken: number): number => {
    if (!v2) return prizesTaken * 250;
    return prizesTaken * 250 + Math.max(0, prizesTaken - 2) * 60;
  };
  return prizeWeight(6 - me.prizes.length) - prizeWeight(6 - opp.prizes.length);
}

// v2-only threat-aware eval. Penalize positions where our Active is in OHKO
// range from opp's projected next attack; symmetrically reward positions
// where opp's Active is in our OHKO range. Phase 2B layers three context-
// aware overlays on top of the base detection: game-losing escalator
// (opp closes the prize race off our KO), bench-counter mitigation
// (ready bench attacker softens the threat), and game-winning escalator
// (our OHKO closes the prize race).
function scoreImmediateThreats(state: GameState, player: PlayerId): number {
  const me = state.players[player];
  const opp = state.players[opponentOf(player)];
  if (me.aiVersion !== "v2") return 0;
  let s = 0;
  if (me.active) {
    const incoming = opponentMaxDamageNextTurn(state, player);
    const myActiveRemaining = effectiveMaxHp(me.active, state) - me.active.damage;
    if (incoming >= myActiveRemaining) {
      const prizeAtRisk = prizeValue(me.active.card);
      s -= ACTIVE_OHKO_BASE_PENALTY + prizeAtRisk * ACTIVE_OHKO_PRIZE_PENALTY;
      // Phase 2B: game-losing escalator. If opp would close out the
      // game with this KO (prizes ≤ prize value of our Active), the
      // position isn't just "bad trade" — it's "we lose next turn."
      if (opp.prizes.length <= prizeAtRisk) {
        s -= ACTIVE_OHKO_GAME_LOSING_PENALTY;
      }
      // Phase 2B: bench-counter mitigation. A ready bench attacker means
      // we can swap-and-retaliate after the trade. Threat still hurts but
      // the line isn't a single-point-of-failure.
      if (countReadyBenchAttackers(state, player) > 0) {
        s += ACTIVE_OHKO_BENCH_COUNTER_MITIGATION;
      }
    }
  }
  if (opp.active) {
    const ourPeak = me.active
      ? Math.max(
          0,
          ...me.active.card.attacks.map((a) =>
            estimateDamage(state, player, me.active!, a, opp.active),
          ),
        )
      : 0;
    const oppActiveRemaining = effectiveMaxHp(opp.active, state) - opp.active.damage;
    if (ourPeak >= oppActiveRemaining) {
      const oppPrize = prizeValue(opp.active.card);
      s += OPP_ACTIVE_OHKO_BASE_BONUS + oppPrize * OPP_ACTIVE_OHKO_PRIZE_BONUS;
      // Phase 2B: game-winning escalator. If KO'ing them closes the
      // prize race (our prizes ≤ value of their Active), this is the
      // closer — value the line significantly higher so MCTS picks it
      // over any setup play.
      if (me.prizes.length <= oppPrize) {
        s += OPP_ACTIVE_GAME_WINNING_BONUS;
      }
    }
  }
  return s;
}

// True if `p` has at least one attack we can pay right now given current
// energy. Distinct from "has energy on board" — a Pokémon with 2 Fire
// facing a 3-Fire attack has energy but no payable attack.
function hasPayableAttack(state: GameState, p: PokemonInPlay): boolean {
  const attacks = p.card.attacks;
  if (!attacks || attacks.length === 0) return false;
  const provided = energyPoolForCost(p, state);
  return attacks.some((a) =>
    canPayCost(provided, effectiveAttackCost(state, p, a.cost)),
  );
}

// Count of bench Pokémon that could attack right now. Shared by
// scoreAttackReadiness (readiness signal) and scoreImmediateThreats
// (bench-counter mitigation when our Active is doomed) so the two
// sub-scores read off the same ready-bench measurement.
function countReadyBenchAttackers(
  state: GameState,
  player: PlayerId,
): number {
  const me = state.players[player];
  let count = 0;
  for (const p of me.bench) {
    if (p.attachedEnergy.length === 0) continue;
    if (hasPayableAttack(state, p)) count++;
  }
  return count;
}

// Count of evolution Pokémon in our hand whose base sits in play AND is
// eligible to evolve this turn (not played-this-turn, not evolved-this-
// turn) AND the evolved card has attacks. Each match is a real "next-
// attach attacker" line that scorePosition should preserve when the
// AI considers shuffle/discard plays.
function countEvolutionInHandUnlockingActiveLine(
  state: GameState,
  player: PlayerId,
): number {
  const pl = state.players[player];
  const allies = [pl.active, ...pl.bench].filter(
    (p): p is PokemonInPlay => !!p,
  );
  if (allies.length === 0) return 0;
  let count = 0;
  for (const c of pl.hand) {
    if (c.supertype !== "Pokémon") continue;
    const evolved = c as PokemonCard;
    const evolvesFrom = evolved.evolvesFrom;
    if (!evolvesFrom) continue;
    if (!evolved.attacks || evolved.attacks.length === 0) continue;
    const base = allies.find(
      (a) =>
        a.card.name === evolvesFrom &&
        !a.playedThisTurn &&
        !a.evolvedThisTurn,
    );
    if (base) count++;
  }
  return count;
}

// Energy on board (tempo proxy) + v2 ready-bench counting. Each energy is
// one already-paid attachment beat — losing a powered Pokémon costs this
// much in resimulated attaches. v2 layers on bench-attacker readiness with
// a non-linear gust-insurance bonus for redundant ready attackers, plus
// Phase 2B overlays for "Active can attack now" and "evolution-in-hand
// unlocks an attacker."
function scoreAttackReadiness(state: GameState, player: PlayerId): number {
  const me = state.players[player];
  const opp = state.players[opponentOf(player)];
  const energyOnBoard = (pl: typeof me): number => {
    let n = pl.active?.attachedEnergy.length ?? 0;
    for (const b of pl.bench) n += b.attachedEnergy.length;
    return n;
  };
  let s = energyOnBoard(me) * 8 - energyOnBoard(opp) * 8;
  if (me.aiVersion !== "v2") return s;
  const readyBench = countReadyBenchAttackers(state, player);
  // Nearly-ready bench: 1 energy short of any payable attack. Still gust
  // insurance after the next attach.
  let nearlyReadyBench = 0;
  for (const p of me.bench) {
    if (p.attachedEnergy.length === 0) continue;
    const attacks = p.card.attacks;
    if (!attacks || attacks.length === 0) continue;
    const provided = energyPoolForCost(p, state);
    const hasCheapAttack = attacks.some((a) =>
      canPayCost(provided, effectiveAttackCost(state, p, a.cost)),
    );
    if (hasCheapAttack) continue;
    const minShort = Math.min(
      ...attacks.map((a) => {
        const cost = effectiveAttackCost(state, p, a.cost);
        return Math.max(0, cost.length - provided.length);
      }),
    );
    if (minShort === 1) nearlyReadyBench++;
  }
  s += readyBench * 15;
  // Gust-insurance bonus: redundant ready bench attackers convert "opp
  // gusts our finisher → -2 prizes and tempo" into "opp gusts → swap-and-
  // attack line." The second ready attacker is worth significantly more
  // than the first since it removes the single-point-of-failure. Sourced
  // from Prague R9 G1 T4: champion spread Crispin energies across two
  // Drakloaks specifically to defuse Boss's/Giovanni.
  if (readyBench >= 2) s += 35;
  if (readyBench >= 3) s += 15;
  s += nearlyReadyBench * 5;
  // Phase 2B: Active can attack right now (distinct from raw energy-on-
  // board — a Pokémon with 2 Fire facing 3-Fire has energy but no
  // payable attack).
  if (me.active && hasPayableAttack(state, me.active)) {
    s += ACTIVE_CAN_ATTACK_NOW_BONUS;
  }
  // Phase 2B: each evolution piece in hand that would unlock an
  // attacking Stage 1/2 on an eligible in-play base. Rewards holding
  // setup pieces — supports the "don't shuffle the evolution piece
  // away" intuition for hand-disruption Supporter timing decisions.
  s +=
    countEvolutionInHandUnlockingActiveLine(state, player) *
    EVOLUTION_IN_HAND_UNLOCK_BONUS;
  return s;
}

// HP sum + bench depth + catastrophic-no-Pokémon detection. Bench-depth
// weights are asymmetric (me ×6 / opp ×4): our follow-up plays matter more
// than denying opp follow-up at typical evaluation depth.
function scoreBoardDevelopment(state: GameState, player: PlayerId): number {
  const me = state.players[player];
  const opp = state.players[opponentOf(player)];
  const hpSum = (pl: typeof me): number => {
    let total = pl.active ? effectiveMaxHp(pl.active, state) - pl.active.damage : 0;
    for (const b of pl.bench) total += effectiveMaxHp(b, state) - b.damage;
    return total;
  };
  let s = hpSum(me) / 6 - hpSum(opp) / 6;
  s += me.bench.length * 6;
  s -= opp.bench.length * 4;
  // No active + no bench = we can't promote — catastrophic for that side.
  if (!me.active && me.bench.length === 0) s -= 100_000;
  if (!opp.active && opp.bench.length === 0) s += 100_000;
  return s;
}

// Hand-size signal (capped at 7) — mild because too much hand is a
// Marnie / N / Iono target, but a thin hand is structurally worse.
function scoreResourceQuality(state: GameState, player: PlayerId): number {
  const me = state.players[player];
  const opp = state.players[opponentOf(player)];
  return Math.min(me.hand.length, 7) * 3 - Math.min(opp.hand.length, 7) * 2;
}

// v2: penalize positions where opp's Active threatens bench spread and we
// have exposed bench Pokémon (low-value Basics: no archetype claim, no
// evolution line in library, no near-term attack). Rule-box exposed bench
// counts double — losing a 2-prize ex to a Phantom Dive is the textbook
// "don't bench dead weight under spread" mistake. v1 returns 0.
function scoreBenchRisk(state: GameState, player: PlayerId): number {
  const me = state.players[player];
  if (me.aiVersion !== "v2") return 0;
  if (!opponentHasBenchSpreadThreat(state, player)) return 0;
  const arch = archetypeOf(state, player);
  let exposed = 0;
  for (const p of me.bench) {
    if (archetypeBenchBonus(arch, p.card) > 0) continue;
    if (hasEvolutionInLibrary(me, p.card.name)) continue;
    if (basicCouldAttackSoon(p.card)) continue;
    const subs = p.card.subtypes ?? [];
    const ruleBox =
      subs.includes("ex") ||
      subs.includes("V") ||
      subs.includes("VSTAR") ||
      subs.includes("VMAX");
    exposed += ruleBox ? 2 : 1;
  }
  return -exposed * 20;
}

// Reserved for additive v2 overlays (Unfair Stamp / Iono / Marnie timing
// beyond the per-card scoreTrainerForNow lane, ACE SPEC scheduling).
function scoreDisruptionTiming(_state: GameState, _player: PlayerId): number {
  return 0;
}

// Detect bench-spread / bench-snipe threats from opp's Active. Used by both
// scoreBenchRisk (position penalty) and shouldBenchBasicNow (action gate),
// so the leaf eval and greedy path agree. Reads resolved AttackEffect[]
// via getAttackEffects (lazy regex match cached on the move), not free-form
// text — matches the data-driven effect dispatch the engine already uses.
function opponentHasBenchSpreadThreat(
  state: GameState,
  player: PlayerId,
): boolean {
  const opp = state.players[opponentOf(player)];
  if (!opp.active) return false;
  for (const move of opp.active.card.attacks ?? []) {
    for (const eff of getAttackEffects(move)) {
      switch (eff.kind) {
        case "placeCountersOnOppBenchAny":
          return true;
        case "placeCountersOnNOpp":
          return true;
        case "snipeOne":
          if (eff.benchOnly) return true;
          break;
        case "snipeOnePerEnergy":
          return true;
        case "placeCounters":
          if (eff.target === "oppBench" || eff.target === "anyOpp") return true;
          break;
        case "distributeDamage":
          if (eff.benchOnly) return true;
          break;
      }
    }
  }
  return false;
}

// True if a Stage 1/Stage 2 evolving from `basicName` sits in the player's
// deck or hand. Used to keep evolution-base Basics out of the dead-weight
// bucket — Dreepy under Dragapult pressure isn't dead weight if we have
// Drakloak ready to land next turn.
function hasEvolutionInLibrary(
  pl: import("./types").PlayerState,
  basicName: string,
): boolean {
  const test = (zone: Card[]): boolean =>
    zone.some(
      (c) =>
        c.supertype === "Pokémon" &&
        (c as PokemonCard).evolvesFrom === basicName,
    );
  return test(pl.deck) || test(pl.hand);
}

// True if the Basic's attack lineup includes a cheap, immediately-payable
// option with non-trivial damage. Distinguishes "real low-cost attacker"
// (Charcadet Hammer In, Fan Rotom Fan Call, etc.) from "filler with a
// 10-damage Pound." Threshold: free attacks need 30+ damage; 1-energy
// attacks need 30+. Below that, we treat the card as filler and let the
// bench-discipline gate / scoreBenchRisk overlay decide.
function basicCouldAttackSoon(card: Card): boolean {
  if (card.supertype !== "Pokémon") return false;
  const attacks = (card as PokemonCard).attacks ?? [];
  if (attacks.some((a) => a.cost.length === 0 && a.damage >= 30)) return true;
  if (attacks.some((a) => a.cost.length === 1 && a.damage >= 30)) return true;
  return false;
}

// v2 bench-discipline gate. Blocks low-value Basics from filling a
// developed bench under opponent spread pressure. v1 always allows
// (preserves the legacy "fill the bench" behavior).
function shouldBenchBasicNow(
  state: GameState,
  player: PlayerId,
  card: Card,
): boolean {
  if (!v2Active(state, player)) return true;
  const pl = state.players[player];
  // Less than 3 on bench: setup phase, never block.
  if (pl.bench.length < 3) return true;
  // No spread pressure → no over-benching risk worth gating against.
  if (!opponentHasBenchSpreadThreat(state, player)) return true;
  // Archetype-critical Basic? Always pass (Tarountula for Rocket Mewtwo,
  // Smoliv for Arboliva, Riolu for Lucario, etc.).
  const arch = archetypeOf(state, player);
  if (archetypeBenchBonus(arch, card) > 0) return true;
  // Has an evolution line in our library? Bench it — it's a setup base.
  if (hasEvolutionInLibrary(pl, card.name)) return true;
  // Real attacker (cheap, payable, non-trivial damage)? Bench it.
  if (basicCouldAttackSoon(card)) return true;
  // Otherwise: dead-weight filler. Don't add a free prize for the spreader.
  return false;
}

// 1-ply lookahead variant of pickBestAttack: simulates opp's expected reply.
function pickBestAttackWithLookahead(
  state: GameState,
  player: PlayerId,
): { index: number; value: number } | null {
  // Greedy fallback for the candidate enumeration — same legality checks.
  const greedy = pickBestAttack(state, player);
  if (!greedy) return null;
  const pl = state.players[player];
  if (!pl.active) return greedy;
  const atk = pl.active;
  // Confused / asleep / paralyzed-style hard-locks already filtered by
  // pickBestAttack; if it returned null we'd already have bailed.

  const provided = energyPoolForCost(atk, state);
  const perAttackLock = (atk as typeof atk & { cantUseAttacksUntilTurn?: Record<string, number> }).cantUseAttacksUntilTurn;

  // Enumerate legal attack candidates, mirroring pickBestAttack's filters.
  const candidates: number[] = [];
  for (let i = 0; i < atk.card.attacks.length; i++) {
    const move = atk.card.attacks[i];
    const cost = effectiveAttackCost(state, atk, move.cost);
    if (!canPayCost(provided, cost)) continue;
    if (perAttackLock && perAttackLock[move.name] !== undefined && state.turn <= perAttackLock[move.name]) continue;
    candidates.push(i);
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return greedy;

  let bestIdx = greedy.index;
  let bestScore = -Infinity;
  const oppId = opponentOf(player);

  lookaheadActive = true;
  try {
    for (const i of candidates) {
      const sim = cloneStateForSearch(state);
      let ok = false;
      try {
        ok = attack(sim, player, i).ok;
      } catch {
        ok = false;
      }
      if (!ok) continue;

      try {
        drainPending(sim);
        // Ply 2: opp's expected response.
        if (sim.phase !== "gameOver" && sim.activePlayer === oppId) {
          takeAiTurn(sim, oppId);
        }
        drainPending(sim);
        // Ply 3: our follow-up turn (greedy, since lookaheadActive=true).
        // This evaluates "which attack leaves me in the best position to
        // continue playing" rather than just "which trade looks best after
        // opp swings once." Bench-snipe and chip-attacks tend to score
        // better here when the follow-up KO completes the prize line.
        if (sim.phase !== "gameOver" && sim.activePlayer === player) {
          takeAiTurn(sim, player);
        }
        drainPending(sim);
      } catch {
        // Engine threw mid-simulation — treat as a worst-case score so we
        // never silently pick a move that breaks invariants.
        continue;
      }
      const score = scorePosition(sim, player);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
  } finally {
    lookaheadActive = false;
  }

  return { index: bestIdx, value: bestScore };
}
