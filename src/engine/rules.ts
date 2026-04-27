import type {
  Card,
  EnergyType,
  GameState,
  Phase,
  PlayerId,
  PlayerState,
  PokemonCard,
  PokemonInPlay,
  StatusCondition,
} from "./types";
import {
  canBeAfflictedBy,
  effectiveMaxHp,
  enforceAreaZeroBench,
  isStatusImmune,
  poisonExtraCounters,
  prizeReductionFromTools,
  toolOnKoActions,
} from "./ongoingEffects";
import type { Rng } from "./rng";

let instanceCounter = 0;
export const newInstanceId = () => `pp_${++instanceCounter}`;

export const isPokemon = (c: Card): c is PokemonCard =>
  c.supertype === "Pokémon";
export const isBasic = (c: Card): c is PokemonCard =>
  isPokemon(c) && c.subtypes.includes("Basic");

export function makePokemonInPlay(card: PokemonCard): PokemonInPlay {
  return {
    instanceId: newInstanceId(),
    card,
    damage: 0,
    attachedEnergy: [],
    evolvedFrom: [],
    tools: [],
    playedThisTurn: true,
    evolvedThisTurn: false,
    statuses: [],
    abilityUsedThisTurn: false,
  };
}

// Coin flip backed by the game RNG. Logs the result when `label` is given.
export function flipCoin(state: GameState, label?: string): boolean {
  const heads = state.rng.next() < 0.5;
  if (label) {
    logEvent(state, "system", `${label}: ${heads ? "heads" : "tails"}.`);
  }
  return heads;
}

export function opponentOf(p: PlayerId): PlayerId {
  return p === "p1" ? "p2" : "p1";
}

export function logEvent(
  state: GameState,
  player: PlayerId | "system",
  text: string,
): void {
  state.log.push({ turn: state.turn, player, text });
}

// --- Setup -----------------------------------------------------------------

export function createPlayer(
  id: PlayerId,
  name: string,
  deck: Card[],
  isAI: boolean,
): PlayerState {
  return {
    id,
    name,
    deck,
    hand: [],
    discard: [],
    prizes: [],
    bench: [],
    active: null,
    energyAttachedThisTurn: false,
    supporterPlayedThisTurn: false,
    retreatedThisTurn: false,
    mulligans: 0,
    setupComplete: false,
    thisTurnAttackBonuses: [],
    nextOpponentTurnDamageReductions: [],
    itemsBlockedNextTurn: false,
    stadiumUsedThisTurn: false,
    lastDitchUsedThisTurn: false,
    lastSupporterNameThisTurn: null,
    yourPokemonKoedLastOppTurn: false,
    legacyEnergyUsed: false,
    isAI,
  };
}

// Draw n cards, mutating deck/hand. Returns actual drawn count.
export function drawCards(player: PlayerState, n: number): number {
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    const c = player.deck.shift();
    if (!c) break;
    player.hand.push(c);
    drawn++;
  }
  return drawn;
}

// Starts a game: build decks (shuffled) and pause on the opening coin flip.
// Hands and mulligans happen after the flip winner chooses first/second.
export function setupGame(
  p1Deck: Card[],
  p2Deck: Card[],
  rng: Rng,
  opts: { p1Name?: string; p2Name?: string; p2IsAI?: boolean } = {},
): GameState {
  const p1 = createPlayer("p1", opts.p1Name ?? "Player", rng.shuffle(p1Deck), false);
  const p2 = createPlayer(
    "p2",
    opts.p2Name ?? "AI",
    rng.shuffle(p2Deck),
    opts.p2IsAI ?? true,
  );

  const state: GameState = {
    players: { p1, p2 },
    activePlayer: "p1",
    turn: 1,
    phase: "coinFlip",
    winner: null,
    log: [],
    firstTurnNoAttack: true,
    stadium: null,
    pendingPromote: null,
    onPromoteResolved: null,
    pendingSecondAttack: null,
    pendingPick: null,
    pendingSwitchTarget: null,
    pendingInPlayTarget: null,
    pendingHandReveal: null,
    pendingSearchNotice: null,
    pendingRareCandyChoice: null,
    snipeTargetOverride: null,
    coinFlip: { step: "pickGuess" },
    rng,
  };
  logEvent(state, "system", "Game start. Flip a coin — guess heads or tails.");
  return state;
}

// Inline Fisher–Yates using state.rng.int, since GameRng doesn't expose shuffle.
function shuffleInPlace<T>(state: GameState, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = state.rng.int(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Deal 7-card opening hands with mulligan penalties for both players. Called
// once the coin flip and first-player choice are resolved. The rulebook
// requires a mulliganing player to reveal the no-Basic hand; we log the hand
// contents so the opponent (and the log viewer) can see what was revealed.
function dealOpeningHands(state: GameState): void {
  const { p1, p2 } = state.players;
  for (const pl of [p1, p2]) {
    let safety = 20;
    while (safety-- > 0) {
      pl.deck = shuffleInPlace(state, [...pl.deck, ...pl.hand]);
      pl.hand = [];
      drawCards(pl, 7);
      if (pl.hand.some(isBasic)) break;
      // Rulebook: reveal the no-Basic hand to the opponent before reshuffling.
      logEvent(
        state,
        pl.id,
        `reveals mulligan hand: ${pl.hand.map((c) => c.name).join(", ")}.`,
      );
      pl.mulligans++;
    }
    pl.prizes = pl.deck.splice(0, 6);
  }
  // Mulligan penalty: each opponent draws N extra cards.
  if (p1.mulligans > 0) drawCards(p2, p1.mulligans);
  if (p2.mulligans > 0) drawCards(p1, p2.mulligans);
  if (p1.mulligans > 0) {
    logEvent(state, "system", `${p1.name} mulliganed ${p1.mulligans}×; ${p2.name} drew ${p1.mulligans} extra card(s).`);
  }
  if (p2.mulligans > 0) {
    logEvent(state, "system", `${p2.name} mulliganed ${p2.mulligans}×; ${p1.name} drew ${p2.mulligans} extra card(s).`);
  }
  logEvent(state, "system", "Both players: choose your Active and bench Basic Pokémon.");
}

// Human (or AI) guesses heads/tails. Flips the coin, records the winner,
// and advances to the first/second choice step.
export function resolveCoinGuess(
  state: GameState,
  guess: "heads" | "tails",
): void {
  if (state.phase !== "coinFlip" || !state.coinFlip || state.coinFlip.step !== "pickGuess") return;
  const heads = state.rng.next() < 0.5;
  const result: "heads" | "tails" = heads ? "heads" : "tails";
  const winner: PlayerId = guess === result ? "p1" : "p2";
  state.coinFlip = { step: "chooseFirst", guess, result, winner };
  logEvent(state, "system", `Coin flip: ${result}. ${state.players[winner].name} wins the toss and chooses.`);
}

// The coin-flip winner picks who goes first. Once set, deal hands and
// transition to the opening-setup phase.
export function chooseFirstPlayer(
  state: GameState,
  chooser: PlayerId,
  goFirst: boolean,
): string | null {
  if (state.phase !== "coinFlip" || !state.coinFlip || state.coinFlip.step !== "chooseFirst")
    return "Not in coin-flip choose phase.";
  if (state.coinFlip.winner !== chooser) return "Not your choice.";
  const firstPlayer: PlayerId = goFirst ? chooser : (chooser === "p1" ? "p2" : "p1");
  state.activePlayer = firstPlayer;
  state.coinFlip = null;
  state.phase = "setup";
  logEvent(
    state,
    "system",
    `${state.players[chooser].name} chose to go ${goFirst ? "first" : "second"}. ${state.players[firstPlayer].name} goes first.`,
  );
  dealOpeningHands(state);
  return null;
}

// Complete the opening setup for one player by promoting a hand card to the
// Active spot and (optionally) putting additional Basics on the Bench. Returns
// a list of validation errors, empty if successful.
export function completeSetup(
  state: GameState,
  player: PlayerId,
  activeHandIdx: number,
  benchHandIdxs: number[],
): string | null {
  if (state.phase !== "setup") return "Not in setup phase.";
  const pl = state.players[player];
  if (pl.setupComplete) return "Setup already completed for this player.";
  const activeCard = pl.hand[activeHandIdx];
  if (!activeCard) return "Invalid Active selection.";
  if (!isBasic(activeCard)) return "Active must be a Basic Pokémon.";
  // Bench slots: must be distinct from Active and from each other, all Basics,
  // and within 5 total.
  const seen = new Set<number>([activeHandIdx]);
  const bench: PokemonCard[] = [];
  for (const i of benchHandIdxs) {
    if (seen.has(i)) return "Duplicate card in bench selection.";
    const c = pl.hand[i];
    if (!c) return "Invalid bench selection.";
    if (!isBasic(c)) return "Bench must contain only Basic Pokémon.";
    seen.add(i);
    bench.push(c);
  }
  if (bench.length > 5) return "Bench can hold at most 5 Pokémon.";

  // Remove chosen cards from hand in descending order to preserve indexes.
  const idxsDesc = [...seen].sort((a, b) => b - a);
  for (const i of idxsDesc) pl.hand.splice(i, 1);
  // Place Active and bench as zero-damage, not-played-this-turn instances.
  pl.active = makePokemonInPlay(activeCard as PokemonCard);
  pl.active.playedThisTurn = false;
  for (const b of bench) {
    const p = makePokemonInPlay(b);
    p.playedThisTurn = false;
    pl.bench.push(p);
  }
  pl.setupComplete = true;
  logEvent(
    state,
    player,
    `sets up — Active: ${pl.active.card.name}${bench.length ? `; Bench: ${bench.map((c) => c.name).join(", ")}` : ""}.`,
  );

  // Both done? Transition to turn 1.
  if (state.players.p1.setupComplete && state.players.p2.setupComplete) {
    state.phase = "main";
    const first = state.activePlayer;
    drawCards(state.players[first], 1);
    logEvent(state, first, `draws for turn.`);
  }
  return null;
}

// --- Energy cost matching --------------------------------------------------

// Wildcard marker. Emitted by effectiveEnergyProvides for Prism / Luminous /
// Legacy / Neo Upper Energy. In the pool, "*" matches any specific-type cost
// and also counts as a valid Colorless payment.
export const WILD_ENERGY = "*";

// Runtime-effective provides for an attached Energy card. Takes the holder
// into account for conditional special energies (Ignition, Prism, Neo Upper,
// Luminous). Returns an array of strings — each entry is one energy unit
// (payable against 1 specific-type cost or 1 Colorless cost).
export function effectiveEnergyProvides(
  e: import("./types").EnergyCard,
  holder: PokemonCard,
  holderAttached?: import("./types").EnergyCard[],
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
  }
  // Default: use the static provides (basic energy has its own type; plain
  // special energies default to Colorless).
  return e.provides.slice();
}

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

// --- Status conditions -----------------------------------------------------

// Asleep, Confused, and Paralyzed are mutually exclusive with each other
// (applying one replaces any of the others). Burned and Poisoned can stack
// with anything.
const EXCLUSIVE_STATUSES: StatusCondition[] = ["asleep", "confused", "paralyzed"];

export function hasStatus(p: PokemonInPlay, s: StatusCondition): boolean {
  return p.statuses.includes(s);
}

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

function knockOutIfNeeded(state: GameState, ownerId: PlayerId): void {
  const owner = state.players[ownerId];
  if (owner.active && owner.active.damage >= effectiveMaxHp(owner.active, state)) {
    knockOut(state, ownerId);
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

  // 1. Poison damage (Perilous Jungle adds +20 on non-Darkness).
  for (const pid of ORDER) {
    const a = state.players[pid].active;
    if (!a || !hasStatus(a, "poisoned")) continue;
    const extra = poisonExtraCounters(state, a);
    damageFromStatus(state, pid, a, 10 + extra, extra ? "poison (Perilous Jungle)" : "poison");
    if ((state.phase as string) === "gameOver") return;
  }

  // 2. Burn damage (20) + cure flip (heads cures).
  for (const pid of ORDER) {
    const a = state.players[pid].active;
    if (!a || !hasStatus(a, "burned")) continue;
    damageFromStatus(state, pid, a, 20, "burn");
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

// --- Damage / KO / win -----------------------------------------------------

export function applyDamage(
  state: GameState,
  defenderOwner: PlayerId,
  damage: number,
): void {
  const target = state.players[defenderOwner].active;
  if (!target) return;
  // Apply weakness (×2) / resistance (-30) against attacker's type.
  // (MVP simplification handled by caller when computing damage.)
  target.damage += damage;
  logEvent(
    state,
    "system",
    `${target.card.name} takes ${damage} damage (now ${target.damage}).`,
  );
  if (target.damage >= effectiveMaxHp(target, state)) knockOut(state, defenderOwner);
}

// Prize-card value when KO'd. ex/V/GX give 2; VMAX and V-UNION give 3;
// VSTAR gives 2; Radiant and everything else give 1.
export function prizeValue(card: PokemonCard): number {
  const subs = card.subtypes ?? [];
  if (subs.includes("VMAX")) return 3;
  if (subs.includes("VSTAR")) return 2;
  if (subs.includes("V")) return 2;
  if (subs.includes("V-UNION")) return 3;
  if (subs.includes("ex") || subs.includes("EX") || subs.includes("GX")) return 2;
  // Radiant Pokémon give 1 prize (not 2) but carry restrictions; treat as 1.
  return 1;
}

function takePrizes(state: GameState, taker: PlayerId, count: number): void {
  const opp = state.players[taker];
  let taken = 0;
  for (let i = 0; i < count; i++) {
    const prize = opp.prizes.shift();
    if (!prize) break;
    opp.hand.push(prize);
    taken++;
    logEvent(state, opp.id, `takes a Prize (${prize.name}).`);
  }
  if (taken < count) {
    logEvent(
      state,
      "system",
      `Only ${taken} Prize(s) remaining of ${count} owed.`,
    );
  }
}

// Knock out the Active Pokémon of `ownerId` and resolve prize/win logic.
export function knockOut(state: GameState, ownerId: PlayerId): void {
  const owner = state.players[ownerId];
  if (!owner.active) return;
  const ko = owner.active;
  // If the KO happens on the opponent's turn, flag the KO'd player so their
  // Flip-the-Script-style "if one of your Pokémon was KO'd last turn" gate
  // can fire on their next turn.
  if (state.activePlayer !== ownerId) owner.yourPokemonKoedLastOppTurn = true;
  // Resolve KO-triggered Tool effects BEFORE the KO'd card goes to discard,
  // so the Tool is still "attached" for any condition checks. These effects
  // take place from the KO'd player's perspective.
  for (const act of toolOnKoActions(state, ko)) {
    if (act.kind === "searchDeckAnyN") {
      // Amulet of Hope — search your deck for up to N cards. Mid-KO we can't
      // open an interactive pick (pendingPromote needs the phase), so we do
      // a priority-based auto-search: Basic Pokémon first (so the promoted
      // Active has backup), then draw-Supporters (Iono / Professor's), then
      // Pokémon evolutions, then anything else. Still shuffles afterward.
      const priority = (c: Card): number => {
        if (c.supertype === "Pokémon" && c.subtypes.includes("Basic")) return 4;
        if (c.supertype === "Trainer" && c.subtypes.includes("Supporter")) return 3;
        if (c.supertype === "Pokémon") return 2;
        if (c.supertype === "Energy") return 1;
        return 0;
      };
      const sortedIdxs = owner.deck
        .map((c, i) => ({ i, prio: priority(c) }))
        .sort((a, b) => b.prio - a.prio)
        .slice(0, act.count)
        .map((x) => x.i)
        .sort((a, b) => b - a); // splice from high to low index
      const taken: Card[] = [];
      for (const i of sortedIdxs) taken.push(...owner.deck.splice(i, 1));
      owner.hand.push(...taken);
      if (taken.length > 0) {
        logEvent(
          state,
          ownerId,
          `Amulet of Hope: searches deck for ${taken.map((c) => c.name).join(", ")}.`,
        );
      }
      // Shuffle afterwards per the card text.
      const arr = owner.deck;
      for (let i = arr.length - 1; i > 0; i--) {
        const j = state.rng.int(i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    } else if (act.kind === "moveEnergyToBench") {
      // Heavy Baton — move Energy from the KO'd Pokémon to a Benched ally.
      // Auto-target: prefer the Benched Pokémon that already has the most
      // attached Energy (continuation-of-game heuristic: reinforce the
      // heaviest hitter). Ties broken by lowest instanceId so runs are
      // deterministic.
      if (owner.bench.length > 0 && ko.attachedEnergy.length > 0) {
        const target = owner.bench
          .slice()
          .sort((a, b) => b.attachedEnergy.length - a.attachedEnergy.length)[0];
        let moved = 0;
        while (moved < act.max && ko.attachedEnergy.length > 0) {
          const [e] = ko.attachedEnergy.splice(0, 1);
          target.attachedEnergy.push(e);
          moved++;
        }
        if (moved > 0) {
          logEvent(state, ownerId, `Heavy Baton moves ${moved} Energy to ${target.card.name}.`);
        }
      }
    }
  }
  // Flygon Sandy Flapping — when this Pokémon is KO'd in the Active Spot
  // from opponent's damage, discard top 2 of opp's deck.
  {
    const hasSandyFlapping = (ko.card.abilities ?? []).some(
      (a) => a.name === "Sandy Flapping",
    );
    if (hasSandyFlapping) {
      const oppId = opponentOf(ownerId);
      const opp = state.players[oppId];
      const top = opp.deck.splice(0, 2);
      if (top.length > 0) {
        opp.discard.push(...top);
        logEvent(state, ownerId, `Sandy Flapping (KO): discards ${top.length} card(s) from ${opp.name}'s deck.`);
      }
    }
  }

  const basePrizes = prizeValue(ko.card);
  let reduction = prizeReductionFromTools(ko);
  let bonus = 0;
  // Legacy Energy — once per game per player: if KO'd by opponent's attack,
  // opp takes 1 fewer Prize.
  const hasLegacy = ko.attachedEnergy.some((e) => e.name === "Legacy Energy");
  if (hasLegacy && !owner.legacyEnergyUsed) {
    reduction += 1;
    owner.legacyEnergyUsed = true;
    logEvent(state, ownerId, `Legacy Energy triggers — opponent takes 1 fewer Prize.`);
  }
  // Fragile Husk (Shedinja) — if KO'd by opp's Pokémon ex, opp takes 0 prizes.
  if ((ko.card.abilities ?? []).some((a) => a.name === "Fragile Husk")) {
    const oppActive = state.players[opponentOf(ownerId)].active;
    if (oppActive && (oppActive.card.subtypes ?? []).some((s) => /^(?:ex|EX)$/.test(s))) {
      reduction += 99;
      logEvent(state, ownerId, `Fragile Husk: opponent takes no Prizes.`);
    }
  }
  // Shadowy Concealment (Mega Gengar ex) — if 1 of your Darkness Pokémon is
  // KO'd by opp's ex, opp takes 1 fewer Prize. Doesn't stack.
  if (ko.card.types.includes("Darkness")) {
    const allies = [owner.active, ...owner.bench].filter((p): p is PokemonInPlay => !!p);
    const hasShadowy = allies.some((p) => (p.card.abilities ?? []).some((a) => a.name === "Shadowy Concealment"));
    if (hasShadowy) {
      const oppActive = state.players[opponentOf(ownerId)].active;
      if (oppActive && (oppActive.card.subtypes ?? []).some((s) => /^(?:ex|EX)$/.test(s))) {
        reduction += 1;
        logEvent(state, ownerId, `Shadowy Concealment: opponent takes 1 fewer Prize.`);
      }
    }
  }
  // Greedy Eater (Hydreigon ex) — if you (the KOing player) have Hydreigon ex
  // with this ability and the KO'd Pokémon is Basic, take 1 more Prize.
  {
    const taker = state.players[opponentOf(ownerId)];
    const takerAllies = [taker.active, ...taker.bench].filter((p): p is PokemonInPlay => !!p);
    const hasGreedy = takerAllies.some((p) => (p.card.abilities ?? []).some((a) => a.name === "Greedy Eater"));
    if (hasGreedy && (ko.card.subtypes ?? []).includes("Basic")) {
      bonus += 1;
      logEvent(state, taker.id, `Greedy Eater: takes 1 more Prize.`);
    }
    // Wonder Kiss (Togekiss) — when opp Active is KO'd, flip → +1 Prize.
    const hasWonderKiss = takerAllies.some((p) => (p.card.abilities ?? []).some((a) => a.name === "Wonder Kiss"));
    if (hasWonderKiss) {
      const heads = state.rng.next() < 0.5;
      if (heads) {
        bonus += 1;
        logEvent(state, taker.id, `Wonder Kiss flip: heads — takes 1 more Prize.`);
      } else {
        logEvent(state, taker.id, `Wonder Kiss flip: tails.`);
      }
    }
  }
  // Oh No You Don't (Munkidori ex) — if KO'd by opp's Pokémon AND you have
  // any Pecharunt ex in play, opp takes 1 fewer Prize.
  if ((ko.card.abilities ?? []).some((a) => a.name === "Oh No You Don't")) {
    const ownerAllies = [owner.active, ...owner.bench].filter((p): p is PokemonInPlay => !!p);
    if (ownerAllies.some((p) => p.card.name === "Pecharunt ex")) {
      reduction += 1;
      logEvent(state, ownerId, `Oh No You Don't: opp takes 1 fewer Prize.`);
    }
  }
  // Final Chain — if KO'd by opp's attack, search deck for any 1 card and
  // put into hand. AI auto-picks the most useful card (any draw / energy / ex);
  // simplest heuristic: pick the first ex Pokémon, else first energy, else
  // first card.
  if ((ko.card.abilities ?? []).some((a) => a.name === "Final Chain")) {
    const deck = owner.deck;
    if (deck.length > 0) {
      const isEx = (c: import("./types").Card) =>
        c.supertype === "Pokémon" && (c.subtypes ?? []).some((s) => /^(?:ex|EX)$/.test(s));
      const isEnergy = (c: import("./types").Card) => c.supertype === "Energy";
      let idx = deck.findIndex(isEx);
      if (idx < 0) idx = deck.findIndex(isEnergy);
      if (idx < 0) idx = 0;
      const [picked] = deck.splice(idx, 1);
      owner.hand.push(picked);
      // Shuffle the rest.
      shuffleInPlace(state, deck);
      logEvent(state, ownerId, `Final Chain: searches deck for ${picked.name}.`);
    }
  }
  // Infinite Shadow — if KO'd by opp's attack, return this card to hand
  // instead of the discard pile (attached cards still go to discard).
  const infiniteShadow = (ko.card.abilities ?? []).some((a) => a.name === "Infinite Shadow");
  const prizes = Math.max(0, basePrizes - reduction + bonus);
  if (prizes !== basePrizes) {
    logEvent(state, "system", `${ko.card.name} Knocked Out — prizes reduced.`);
  }
  logEvent(
    state,
    "system",
    `${ko.card.name} is Knocked Out! (${prizes} Prize${prizes !== 1 ? "s" : ""})`,
  );
  // Move active + evolution stack + attached energy + tools to discard.
  // Infinite Shadow returns the KO'd card to hand instead; attached cards
  // and pre-evolutions still go to discard.
  if (infiniteShadow) {
    owner.hand.push(ko.card);
    owner.discard.push(
      ...ko.evolvedFrom,
      ...ko.attachedEnergy,
      ...(ko.tools ?? []),
    );
    logEvent(state, ownerId, `Infinite Shadow: ${ko.card.name} returns to hand.`);
  } else {
    owner.discard.push(
      ko.card,
      ...ko.evolvedFrom,
      ...ko.attachedEnergy,
      ...(ko.tools ?? []),
    );
  }
  owner.active = null;
  // Area Zero Underdepths — if the KO'd Pokémon was the holder's only Tera,
  // their bench cap drops back to 5 and excess bench Pokémon are discarded.
  enforceAreaZeroBench(state);

  takePrizes(state, opponentOf(ownerId), prizes);

  // Win by prizes.
  const opp = state.players[opponentOf(ownerId)];
  if (opp.prizes.length === 0) {
    state.winner = opp.id;
    state.phase = "gameOver";
    logEvent(state, "system", `${opp.name} wins by taking all Prizes.`);
    return;
  }

  // Owner must promote a benched Pokémon. If none, owner loses.
  if (owner.bench.length === 0) {
    state.winner = opp.id;
    state.phase = "gameOver";
    logEvent(
      state,
      "system",
      `${owner.name} has no Pokémon left. ${opp.name} wins.`,
    );
    return;
  }
  // Pause the game for the owner to pick a new active (UI / AI resolves it
  // via promoteBenchToActive). The activePlayer is unchanged.
  state.pendingPromote = ownerId;
  state.phase = "promoteActive";
}

// Knock out benched Pokémon whose damage >= HP (e.g., bench snipe damage).
// Returns true if any bench KOs were resolved.
export function resolveBenchKOs(state: GameState): boolean {
  let any = false;
  for (const pid of ["p1", "p2"] as PlayerId[]) {
    const pl = state.players[pid];
    const survivors: typeof pl.bench = [];
    for (const p of pl.bench) {
      if (p.damage >= effectiveMaxHp(p, state)) {
        // Bench KO during the opponent's turn flags the owner for next-turn
        // Flip-the-Script gating.
        if (state.activePlayer !== pid) pl.yourPokemonKoedLastOppTurn = true;
        const prizes = prizeValue(p.card);
        logEvent(
          state,
          "system",
          `${p.card.name} is Knocked Out on the Bench! (${prizes} Prize${prizes > 1 ? "s" : ""})`,
        );
        pl.discard.push(
          p.card,
          ...p.evolvedFrom,
          ...p.attachedEnergy,
          ...(p.tools ?? []),
        );
        takePrizes(state, opponentOf(pid), prizes);
        any = true;
        // Check prize-out win mid-loop.
        const opp = state.players[opponentOf(pid)];
        if (opp.prizes.length === 0 && state.phase !== "gameOver") {
          state.winner = opp.id;
          state.phase = "gameOver";
          logEvent(state, "system", `${opp.name} wins by taking all Prizes.`);
          return true;
        }
      } else {
        survivors.push(p);
      }
    }
    pl.bench = survivors;
  }
  return any;
}

// Win-by-deckout: if active player can't draw at start of turn, they lose.
export function startTurnDraw(state: GameState): void {
  const p = state.players[state.activePlayer];
  const drawn = drawCards(p, 1);
  if (drawn === 0) {
    const winner = opponentOf(state.activePlayer);
    state.winner = winner;
    state.phase = "gameOver";
    logEvent(state, "system", `${p.name} cannot draw. ${state.players[winner].name} wins.`);
    return;
  }
  logEvent(state, state.activePlayer, `draws for turn.`);
}

export function endTurn(state: GameState): void {
  if (state.phase === "gameOver") return;
  if (state.pendingPromote) return;

  const prev = state.players[state.activePlayer];
  // Powerglass end-of-turn attach: Active with this Tool gets a Basic Energy
  // from discard attached to it.
  if (prev.active) {
    const hasPowerglass = prev.active.tools.some((t) => t.name === "Powerglass");
    if (hasPowerglass) {
      const idx = prev.discard.findIndex(
        (c) => c.supertype === "Energy" && c.subtypes.includes("Basic"),
      );
      if (idx >= 0) {
        const [e] = prev.discard.splice(idx, 1);
        prev.active.attachedEnergy.push(e as import("./types").EnergyCard);
        logEvent(state, prev.id, `Powerglass attaches ${e.name} to ${prev.active.card.name}.`);
      }
    }
  }
  // Ignition Energy: "discard it at the end of your turn." Scan all of the
  // ending player's Pokémon and discard any attached Ignition Energy cards.
  for (const p of [prev.active, ...prev.bench]) {
    if (!p) continue;
    for (let i = p.attachedEnergy.length - 1; i >= 0; i--) {
      if (p.attachedEnergy[i].name === "Ignition Energy") {
        const [e] = p.attachedEnergy.splice(i, 1);
        prev.discard.push(e);
        logEvent(state, prev.id, `Ignition Energy discards itself at end of turn.`);
      }
    }
  }
  prev.energyAttachedThisTurn = false;
  prev.supporterPlayedThisTurn = false;
  prev.retreatedThisTurn = false;
  prev.stadiumUsedThisTurn = false;
  prev.lastDitchUsedThisTurn = false;
  prev.lastSupporterNameThisTurn = null;
  // The OPPONENT's "my Pokémon got KO'd during their last (i.e. just-ended)
  // turn" flag applies during their UPCOMING turn. Clear the ending player's
  // own flag here (they've had their chance to consume it).
  prev.yourPokemonKoedLastOppTurn = false;
  // Turn-scoped attack bonuses (Black Belt's Training, Premium Power Pro,
  // Kieran's boost branch) reset at end of the player's turn.
  prev.thisTurnAttackBonuses = [];
  // The item-block flag on the player whose turn just ended clears now —
  // the block only applied to *their* turn (set by opp's previous Budew attack).
  prev.itemsBlockedNextTurn = false;
  // Reductions the *opponent* queued for "their next turn" (the one that just
  // ended) clear now — the active player is the opponent from the setter's
  // perspective.
  const opp = state.players[opponentOf(state.activePlayer)];
  opp.nextOpponentTurnDamageReductions = [];
  for (const p of [prev.active, ...prev.bench]) {
    if (p) {
      p.playedThisTurn = false;
      p.evolvedThisTurn = false;
      p.abilityUsedThisTurn = false;
      p.movedToActiveThisTurn = false;
    }
  }
  // noWeaknessUntilTurn protects during opp's upcoming turn — clear AFTER
  // the opponent's turn (i.e., at the start of this player's NEXT cleanup).
  // Simpler: clear when state.turn > value at end of any turn.
  for (const pid of ["p1", "p2"] as PlayerId[]) {
    for (const p of [state.players[pid].active, ...state.players[pid].bench]) {
      if (p && p.noWeaknessUntilTurn !== undefined && state.turn > p.noWeaknessUntilTurn) {
        p.noWeaknessUntilTurn = undefined;
      }
    }
  }
  // Glaceon "Permeating Chill" — at the end of opp's turn, place delayed
  // counters on the still-Active defender if any.
  {
    const justEnded = prev; // the player whose turn just ended
    const defender = justEnded.active;
    if (defender) {
      const bag = defender as PokemonInPlay & { delayedCountersAtTurnEnd?: number };
      if (bag.delayedCountersAtTurnEnd && bag.delayedCountersAtTurnEnd > 0) {
        defender.damage += bag.delayedCountersAtTurnEnd * 10;
        logEvent(state, "system", `Delayed damage: ${defender.card.name} takes ${bag.delayedCountersAtTurnEnd * 10}.`);
        bag.delayedCountersAtTurnEnd = undefined;
      }
    }
  }
  // Pokémon Checkup: process status effects on both actives. A status KO here
  // pauses on pendingPromote; once resolved, `passTurn` continues the flow.
  pokemonCheckup(state);
  if ((state.phase as string) === "gameOver") return;
  if (state.pendingPromote) {
    state.onPromoteResolved = "passTurn";
    return;
  }
  passTurn(state);
}

// Advance to the next player's turn. Extracted so promoteBenchToActive can
// resume the flow after a status-KO during Pokémon Checkup.
export function passTurn(state: GameState): void {
  if (state.phase === "gameOver") return;
  state.firstTurnNoAttack = false;
  state.activePlayer = opponentOf(state.activePlayer);
  state.turn += 1;
  state.phase = "draw";
  logEvent(state, "system", `Turn ${state.turn} — ${state.players[state.activePlayer].name}'s turn.`);
  startTurnDraw(state);
  // startTurnDraw may set phase to gameOver on deck-out; otherwise advance to main.
  if ((state.phase as Phase) !== "gameOver") state.phase = "main";
}
