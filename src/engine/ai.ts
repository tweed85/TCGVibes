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
} from "./ongoingEffects";
import { resolvePendingPick, resolvePendingSearchNotice } from "./pendingPick";
import { getAttackEffects } from "../data/effectPatterns";
import { resolveAiHandReveal } from "./trainerEffects";
import { logEvent } from "./rules";
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

// Going second is a meta edge (can attack on T1, opponent can't Supporter T1).
export function resolveAiCoinChoice(state: GameState): boolean {
  if (state.phase !== "coinFlip" || !state.coinFlip || state.coinFlip.step !== "chooseFirst") return false;
  if (state.coinFlip.winner !== "p2") return false;
  chooseFirstPlayer(state, "p2", false);
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
  if (pl.bench.length === 0) return false;

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
      // benchSnipe / selfDamage / applyStatus / heal / discardOwnEnergy /
      // drawCards don't affect the defender's raw damage tally.
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
    damage = Math.max(0, damage - reduction - turnRed);
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

  let best: PokemonInPlay | null = null;
  let bestScore = 0;
  for (const b of opp.bench) {
    for (const move of usable) {
      const score = gustValue(state, player, atk, move, b);
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
  }
  return bestScore >= 120 ? best : null;
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

  let best: PokemonInPlay | null = null;
  let bestScore = -Infinity;
  for (const p of candidates) {
    const s = scoreEnergyTarget(state, player, p, energy);
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

  if (tryStepAiTurn(state, player)) return true;

  // Nothing productive left — try to attack, then end. Either path ends the
  // turn (attack() runs end-of-turn flow internally; endTurn explicitly).
  if (tryAttack(state, player)) return false;
  endTurn(state, player);
  return false;
}

export function takeAiTurn(state: GameState, player: PlayerId): void {
  if (state.pendingPromote === player) resolveAiPendingPromote(state, player);

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

  // Step 1: bench Basics if we're thin.
  if (pl.bench.length < 3) {
    const idx = findPrimaryBasic(state, player);
    if (idx >= 0 && playBasicToBench(state, player, idx).ok) return true;
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
  // bench slots free.
  if (pl.bench.length < 4) {
    const idx = findPrimaryBasic(state, player);
    if (idx >= 0 && playBasicToBench(state, player, idx).ok) return true;
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
  // displace the opponent's). Simple heuristic — stadium power isn't modeled,
  // so this is mostly about preserving tempo.
  const stadiumIdx = pl.hand.findIndex(isStadium);
  if (stadiumIdx >= 0) {
    const alreadyOurs = state.stadium?.controller === player;
    if (!alreadyOurs && playTrainer(state, player, stadiumIdx).ok) return true;
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
  let bestIdx = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < pl.hand.length; i++) {
    const c = pl.hand[i];
    if (!isPokemonCard(c) || !isBasic(c)) continue;
    const s = scorePickedPokemon(state, player, c, primary);
    if (s > bestScore) { bestScore = s; bestIdx = i; }
  }
  return bestIdx;
}

// Activate the highest-value free ability on the board. Draw beats heal beats
// switch — in that order, roughly.
function tryActivateAbility(state: GameState, player: PlayerId): boolean {
  const pl = state.players[player];
  const holders = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
  let bestTarget: { holder: PokemonInPlay; abilityIdx: number; score: number } | null = null;

  for (const holder of holders) {
    if (holder.abilityUsedThisTurn) continue;
    if (!abilitiesActiveOn(state, holder.card)) continue;
    const abilities = holder.card.abilities ?? [];
    for (let ai = 0; ai < abilities.length; ai++) {
      const ab = abilities[ai];
      if (!ab.effect) continue;
      const score = scoreAbility(state, player, holder, ab.effect);
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

// Pick the best Trainer of a given kind. Returns null if nothing scores high
// enough — caller decides the threshold.
function pickBestTrainer(
  state: GameState,
  player: PlayerId,
  kind: (c: Card) => c is TrainerCard,
): { index: number; score: number } | null {
  const pl = state.players[player];
  let best: { index: number; score: number } | null = null;
  for (let i = 0; i < pl.hand.length; i++) {
    const c = pl.hand[i];
    if (!kind(c)) continue;
    const s = scoreTrainerForNow(state, player, c);
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

// JSON-clone the parts of GameState that mutate during a turn. The Rng has
// non-serializable closures (and we don't want simulated coin flips to
// disturb the real game's RNG sequence anyway), so we strip it and fit a
// fresh deterministic Rng. The log is also dropped — it's expensive to clone
// and irrelevant to evaluation.
//
// Card objects are immutable in this codebase (deck/hand/etc. just reorder
// references), so the JSON deep-copy duplicates them but doesn't break
// anything. Cost is bounded by deck+hand size (~140 cards/state) and is
// well within budget for ≤3 attack candidates per decision.
function cloneStateForSearch(state: GameState): GameState {
  const stripped = { ...state, rng: undefined, log: undefined };
  const cloned = JSON.parse(JSON.stringify(stripped)) as Omit<GameState, "rng" | "log">;
  // Force both sides to AI so all auto-pickers fire and the simulation
  // drives itself without waiting for human input.
  cloned.players.p1.isAI = true;
  cloned.players.p2.isAI = true;
  return {
    ...cloned,
    rng: makeRng(0xBADC0FFE),
    log: [],
  } as GameState;
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
function scorePosition(state: GameState, player: PlayerId): number {
  if (state.winner === player) return 1_000_000;
  if (state.winner !== null) return -1_000_000;

  const me = state.players[player];
  const opp = state.players[opponentOf(player)];
  let s = 0;

  // Prize differential — the central currency of the game. Each prize the
  // opponent owes is worth more than HP or energy.
  s += (6 - me.prizes.length) * 250;
  s -= (6 - opp.prizes.length) * 250;

  // Total HP on board (active + bench), proxied by max - damage.
  const hpSum = (pl: typeof me): number => {
    let total = pl.active ? effectiveMaxHp(pl.active, state) - pl.active.damage : 0;
    for (const b of pl.bench) total += effectiveMaxHp(b, state) - b.damage;
    return total;
  };
  s += hpSum(me) / 6;
  s -= hpSum(opp) / 6;

  // Energy on board — a flat proxy for "tempo." Each energy is one tempo
  // beat already paid for; losing a powered-up Pokémon costs us this much.
  const energyOnBoard = (pl: typeof me): number => {
    let n = pl.active?.attachedEnergy.length ?? 0;
    for (const b of pl.bench) n += b.attachedEnergy.length;
    return n;
  };
  s += energyOnBoard(me) * 8;
  s -= energyOnBoard(opp) * 8;

  // Bench depth so we don't tunnel-vision into a state with no follow-up.
  s += me.bench.length * 6;
  s -= opp.bench.length * 4;

  // No active = catastrophic if we can't promote.
  if (!me.active && me.bench.length === 0) s -= 100_000;
  if (!opp.active && opp.bench.length === 0) s += 100_000;

  // Hand size (mild — too much hand is a Marnie/N/Iono target).
  s += Math.min(me.hand.length, 7) * 3;
  s -= Math.min(opp.hand.length, 7) * 2;

  return s;
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
