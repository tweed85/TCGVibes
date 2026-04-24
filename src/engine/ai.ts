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
  energyProvidedBy,
  isBasic,
  isPokemon,
  prizeValue,
  opponentOf,
} from "./rules";
import { activateAbility } from "./abilities";
import {
  effectiveAttackCost,
  effectiveMaxHp,
  effectiveRetreatCost,
  stadiumAttackBonus,
  stadiumDamageReduction,
  turnAttackBonus,
  turnDamageReduction,
  abilitiesActiveOn,
} from "./ongoingEffects";
import { resolvePendingPick } from "./pendingPick";
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

  const primaryEnergy = deckPrimaryEnergy(pl.deck.concat(pl.hand));
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

  const scored = pl.bench.map((p, i) => ({ i, score: scorePromoteCandidate(p, state) }));
  scored.sort((a, b) => b.score - a.score);
  promoteBenchToActive(state, player, scored[0].i);
  return true;
}

function scorePromoteCandidate(p: PokemonInPlay, state: GameState): number {
  let s = 0;
  // Can we attack right now from this spot? Huge plus.
  const provided = energyProvidedBy(p);
  const canAttackNow = p.card.attacks.some((a) =>
    canPayCost(provided, effectiveAttackCost(state, p, a.cost)),
  );
  if (canAttackNow) s += 80;

  // How "healthy" is this Pokémon?
  const maxHp = effectiveMaxHp(p, state);
  const remaining = maxHp - p.damage;
  s += remaining / 5;

  // Avoid walling up a 2-prizer that's going to get traded for a 1-prizer.
  if (isRuleBox(p.card)) s -= 15;
  // Damaged Pokémon are bad Actives — easy KO gives the opponent a prize.
  if (p.damage > 0) s -= p.damage / 10;

  return s;
}

// --- Scoring primitives ----------------------------------------------------

// Primary energy = most-common basic energy type in the deck/hand combined.
// Used to pick an attacker/setup that actually matches the deck.
export function deckPrimaryEnergy(cards: Card[]): EnergyType | null {
  const counts = new Map<EnergyType, number>();
  for (const c of cards) {
    if (isBasicEnergy(c)) {
      for (const t of c.provides) counts.set(t, (counts.get(t) ?? 0) + 1);
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
  let damage = move.damage;
  damage += stadiumAttackBonus(state, attacker, defender);
  damage += turnAttackBonus(state, attackerOwner, attacker, defender);

  for (const e of move.effects ?? []) {
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
  for (const e of move.effects ?? []) {
    if (e.kind === "selfDamage") v -= e.damage * 0.7;
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
  // OHKO scales hugely because it ends the defender's next turn of offense
  // and takes prizes. Self-locks don't matter much on a KO (defender's gone).
  if (isOHKO) {
    v += 200 + prizeValue(defender!.card) * 80;
    return v;
  }
  // Non-KO path: self-lock is a real cost because we used this turn to deal
  // partial damage AND can't follow up with this attack next turn.
  if (hasSelfLock) v -= Math.max(40, dmg * 0.4);
  // "Setup-KO line": if this attack doesn't OHKO but chips the defender
  // below the OHKO threshold for a typical 120-damage follow-up swing, give
  // it a moderate bonus — matches the Aura Jab → Mega Brave flow.
  if (defender && !isOHKO && dmg > 0) {
    const damageAfter = defender.damage + dmg;
    const remaining = defMax - damageAfter;
    if (remaining <= 150) v += 40;  // clearly in one-shot range next turn
    else if (remaining <= 220) v += 20; // Mega Brave / Wild Press range
  }
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
      if (pl.active && pl.active.damage >= 60) return 70;
      if (pl.active && pl.active.damage >= 30) return 45;
      // If our active is healthy and no bench needs it, skip.
      const anyHurt = [pl.active, ...pl.bench].some((p) => p && p.damage > 0);
      return anyHurt ? 20 : 0;

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
    const cur = energyProvidedBy(p).length;
    const best = Math.min(...(p.card.attacks.length
      ? p.card.attacks.map((a) => effectiveAttackCost(state, p, a.cost).length)
      : [99]));
    if (best > cur && best - cur <= 2) return true;
  }
  return false;
}

function benchCanAttack(state: GameState, p: PokemonInPlay): boolean {
  const provided = energyProvidedBy(p);
  return p.card.attacks.some((a) => canPayCost(provided, effectiveAttackCost(state, p, a.cost)));
}

function activeCantAttack(state: GameState, player: PlayerId): boolean {
  const a = state.players[player].active;
  if (!a) return true;
  const provided = energyProvidedBy(a);
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
  const provided = energyProvidedBy(atk);
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
  const provided = energyProvidedBy(p);
  // Simulate attaching by adding the energy to the provided pool.
  const simulated = [...provided, ...energy.provides];

  // Does this new energy *unlock* an attack that wasn't usable before?
  let unlocks = false;
  let unlockDamage = 0;
  for (const atk of p.card.attacks) {
    const cost = effectiveAttackCost(state, p, atk.cost);
    const wasUsable = canPayCost(provided, cost);
    const nowUsable = canPayCost(simulated, cost);
    if (!wasUsable && nowUsable) {
      unlocks = true;
      const def = state.players[opponentOf(player)].active;
      unlockDamage = Math.max(unlockDamage, estimateDamage(state, player, p, atk, def));
    }
  }

  let s = 0;
  // Active unlocks are worth a lot — we can swing this turn.
  if (isActive && unlocks && !state.firstTurnNoAttack) s += 200 + unlockDamage;
  // Any unlock at all (even bench) is good — sets up next-turn plays.
  else if (unlocks) s += 100 + unlockDamage / 2;

  // Colorless-only attacks: the energy types don't matter, just count.
  const usableAttacks = p.card.attacks.filter((a) =>
    canPayCost(simulated, effectiveAttackCost(state, p, a.cost)),
  );
  s += usableAttacks.length * 10;

  // Reward matching the Pokémon's own type so rainbow decks don't dump Water
  // on a Fire attacker "just because."
  if (p.card.types.some((t) => energy.provides.includes(t))) s += 20;

  // Penalize "hopeless" cases: attacks still need way more energy.
  const bestRemaining = Math.min(
    ...(p.card.attacks.length
      ? p.card.attacks.map((a) =>
          Math.max(0, effectiveAttackCost(state, p, a.cost).length - simulated.length),
        )
      : [99]),
  );
  s -= bestRemaining * 5;

  // Don't pour more energy onto a Pokémon that already has enough for every
  // attack — diminishing returns.
  if (usableAttacks.length === p.card.attacks.length && p.card.attacks.length > 0) {
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
  const provided = energyProvidedBy(atk);
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
  const primaryEnergy = deckPrimaryEnergy([...pl.deck, ...pl.hand]);

  const eligible = pick.eligibleIndexes ?? pick.pool.map((_, i) => i);
  const max = Math.min(pick.max, eligible.length);
  if (max <= 0) {
    resolvePendingPick(state, player, []);
    return true;
  }

  // Special handling: Buddy-Buddy Poffin — pick TWO DIFFERENT low-HP Basics
  // that set up evolution lines.
  if (label.startsWith("buddy-buddy poffin")) {
    const scored = eligible.map((i) => {
      const c = pick.pool[i];
      let s = 0;
      if (isPokemonCard(c)) {
        s = scorePickedPokemon(state, player, c, primaryEnergy);
        // Prefer basics whose evolution we have in hand/deck.
        if (hasEvolutionForInDeckOrHand(pl, c.name)) s += 40;
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

function hasEvolutionForInDeckOrHand(pl: import("./types").PlayerState, baseName: string): boolean {
  for (const c of [...pl.deck, ...pl.hand]) {
    if (isPokemonCard(c) && c.evolvesFrom === baseName) return true;
  }
  return false;
}

// --- Main turn loop --------------------------------------------------------

export function takeAiTurn(state: GameState, player: PlayerId): void {
  if (state.pendingPromote === player) resolveAiPendingPromote(state, player);

  const MAX_ITERS = 60;
  let safety = MAX_ITERS;
  while (safety-- > 0) {
    if (state.phase === "gameOver" || state.activePlayer !== player) return;
    if (state.pendingPromote === player) {
      resolveAiPendingPromote(state, player);
      continue;
    }
    if (state.pendingPick && state.pendingPick.player === player) {
      resolveAiPendingPickSmart(state, player);
      continue;
    }
    if (state.pendingHandReveal && state.pendingHandReveal.player === player) {
      resolveAiHandReveal(state);
      continue;
    }

    if (tryStepAiTurn(state, player)) continue;

    // Nothing productive left — try to attack, then end.
    if (tryAttack(state, player)) return;
    endTurn(state, player);
    return;
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

  // Step 8: retreat if our Active can't attack but a benched one can.
  if (tryRetreat(state, player)) return true;

  return false;
}

// Finds the most-useful Basic Pokémon in hand to bench (prefers evolution
// chain bases, then type-matching).
function findPrimaryBasic(state: GameState, player: PlayerId): number {
  const pl = state.players[player];
  const primary = deckPrimaryEnergy([...pl.deck, ...pl.hand]);
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
  switch (effect.kind) {
    case "drawOne": return pl.hand.length < 7 ? 50 : 20;
    case "drawTwo": return pl.hand.length < 8 ? 65 : 25;
    case "drawN": return pl.hand.length < 8 ? 60 + effect.count * 5 : 25;
    case "healSelf": return holder.damage >= effect.amount ? 50 : 10;
    case "healAny": {
      const mostHurt = Math.max(...[pl.active, ...pl.bench].map((p) => p?.damage ?? 0));
      return mostHurt >= effect.amount ? 55 : 10;
    }
    case "searchBasicEnergy": return weNeedEnergy(state, player) ? 70 : 40;
    case "attachEnergyFromHand": {
      const hasThat = pl.hand.some((c) =>
        isBasicEnergy(c) && c.provides.includes(effect.energyType));
      return hasThat ? 75 : 0;
    }
    case "attachEnergyFromDiscardToSelf": {
      const has = pl.discard.some(isBasicEnergy);
      return has && holder.card.attacks.some((a) => a.cost.length > energyProvidedBy(holder).length) ? 70 : 10;
    }
    case "searchDeckAnyCard": return 55;
    case "searchDeckPokemon": return 50;
    case "switchWithBench": {
      // Skip if Active can attack; use if it can't and bench can.
      const active = pl.active;
      if (!active || active.instanceId !== holder.instanceId) return 0; // only matters for Active
      if (!activeCantAttack(state, player)) return 0;
      return pl.bench.some((p) => benchCanAttack(state, p)) ? 60 : 0;
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
      // Mega Evolution ends the turn — only evolve to Mega if we can attack
      // right after (has energy, the Mega itself can use an attack).
      const isMega = (c.subtypes ?? []).some((st) => /^Mega/i.test(st));
      if (isMega) {
        const provided = energyProvidedBy(t);
        const canAttackImmediately = c.attacks.some((a) =>
          canPayCost(provided, a.cost));
        if (!canAttackImmediately) s -= 200;
        else s += 40;
      }
      options.push({ handIdx: i, targetId: t.instanceId, score: s });
    }
  }
  if (options.length === 0) return false;
  options.sort((a, b) => b.score - a.score);
  const pick = options[0];
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

// Retreat if the Active can't meaningfully attack and a benched Pokémon can.
function tryRetreat(state: GameState, player: PlayerId): boolean {
  const pl = state.players[player];
  if (!pl.active || pl.retreatedThisTurn) return false;
  if (pl.bench.length === 0) return false;
  if (!activeCantAttack(state, player)) return false;

  const cost = effectiveRetreatCost(pl.active, state).length;
  const currentEnergy = energyProvidedBy(pl.active).length;
  if (currentEnergy < cost) return false; // can't afford

  // Find a benched Pokémon that can attack.
  let bestBench = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < pl.bench.length; i++) {
    const b = pl.bench[i];
    if (!benchCanAttack(state, b)) continue;
    const provided = energyProvidedBy(b);
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

// Attempt to attack this turn. Returns true if an attack was issued (caller
// should exit — attack resolves into endTurn).
function tryAttack(state: GameState, player: PlayerId): boolean {
  if (state.firstTurnNoAttack) return false;
  const pl = state.players[player];
  if (!pl.active) return false;

  const pick = pickBestAttack(state, player);
  if (!pick) return false;

  // Respect the action's return value: if attack() rejects the play (sleep
  // flip mid-resolve, precondition change between pick and call, etc.) we
  // must NOT report success or takeAiTurn will exit without ending the turn.
  const result = attack(state, player, pick.index);
  return result.ok;
}
