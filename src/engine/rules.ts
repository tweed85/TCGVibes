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
    lostZone: [],
    bench: [],
    active: null,
    energyAttachedThisTurn: false,
    supporterPlayedThisTurn: false,
    retreatedThisTurn: false,
    mulligans: 0,
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

// Starts a game: shuffle, deal 7, mulligan if no basics, place 6 prizes,
// both players must place an active basic before turn 1.
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

  for (const pl of [p1, p2]) {
    // Mulligan until opening hand has at least one Basic. Count mulligans so
    // the opponent can draw that many extra cards (per Play! Pokémon rules).
    let safety = 20;
    while (safety-- > 0) {
      pl.hand = [];
      pl.deck = rng.shuffle([...pl.deck, ...pl.hand]);
      drawCards(pl, 7);
      if (pl.hand.some(isBasic)) break;
      pl.mulligans++;
    }
    // Prizes: top 6.
    pl.prizes = pl.deck.splice(0, 6);
  }

  // Mulligan penalty: each opponent draws N extra cards, where N is the
  // mulligan count of the other player.
  if (p1.mulligans > 0) {
    drawCards(p2, p1.mulligans);
  }
  if (p2.mulligans > 0) {
    drawCards(p1, p2.mulligans);
  }

  // Auto-place each player's first Basic as active (MVP — skip choose-starter UI).
  for (const pl of [p1, p2]) {
    const idx = pl.hand.findIndex(isBasic);
    if (idx >= 0) {
      const [card] = pl.hand.splice(idx, 1) as [PokemonCard];
      pl.active = makePokemonInPlay(card);
      pl.active.playedThisTurn = false;
    }
  }

  const state: GameState = {
    players: { p1, p2 },
    activePlayer: "p1",
    turn: 1,
    phase: "draw",
    winner: null,
    log: [],
    firstTurnNoAttack: true,
    stadium: null,
    pendingPromote: null,
    onPromoteResolved: null,
    rng,
  };
  logEvent(state, "system", "Game start. P1 goes first.");
  if (p1.mulligans > 0) {
    logEvent(state, "system", `${p1.name} mulliganed ${p1.mulligans}×; ${p2.name} drew ${p1.mulligans} extra card(s).`);
  }
  if (p2.mulligans > 0) {
    logEvent(state, "system", `${p2.name} mulliganed ${p2.mulligans}×; ${p1.name} drew ${p2.mulligans} extra card(s).`);
  }
  // P1 draws for turn 1.
  drawCards(p1, 1);
  state.phase = "main";
  return state;
}

// --- Energy cost matching --------------------------------------------------

export function canPayCost(
  attached: EnergyType[],
  cost: EnergyType[],
): boolean {
  const pool = attached.slice();
  // First match specific-type costs, then Colorless can be paid by anything.
  const specific = cost.filter((c) => c !== "Colorless");
  const colorless = cost.length - specific.length;
  for (const need of specific) {
    const i = pool.indexOf(need);
    if (i === -1) return false;
    pool.splice(i, 1);
  }
  return pool.length >= colorless;
}

export const energyProvidedBy = (p: PokemonInPlay): EnergyType[] =>
  p.attachedEnergy.flatMap((e) => e.provides);

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
  if (p.damage >= p.card.hp) {
    // KO handled by the caller's knockOut flow.
    knockOutIfNeeded(state, owner);
  }
}

function knockOutIfNeeded(state: GameState, ownerId: PlayerId): void {
  const owner = state.players[ownerId];
  if (owner.active && owner.active.damage >= owner.active.card.hp) {
    knockOut(state, ownerId);
  }
}

// Pokémon Checkup: runs at the end of each turn, before switching players.
// Order (simplified from the official rulebook): Asleep wake-check, Paralysis
// auto-wake, Burned damage + wake-check, Poisoned damage.
export function pokemonCheckup(state: GameState): void {
  if (state.phase === "gameOver") return;
  for (const pid of ["p1", "p2"] as PlayerId[]) {
    const pl = state.players[pid];
    const a = pl.active;
    if (!a) continue;

    if (hasStatus(a, "asleep")) {
      const woke = flipCoin(state, `${a.card.name} asleep flip`);
      if (woke) {
        removeStatus(a, "asleep");
        logEvent(state, "system", `${a.card.name} woke up.`);
      }
    }
    if (hasStatus(a, "paralyzed")) {
      // Paralysis auto-cures between turns.
      removeStatus(a, "paralyzed");
      logEvent(state, "system", `${a.card.name} is no longer paralyzed.`);
    }
    if (hasStatus(a, "burned")) {
      damageFromStatus(state, pid, a, 20, "burn");
      if ((state.phase as string) === "gameOver") return;
      const cured = flipCoin(state, `${a.card.name} burn flip`);
      if (cured) {
        removeStatus(a, "burned");
        logEvent(state, "system", `${a.card.name}'s burn is cured.`);
      }
    }
    if (hasStatus(a, "poisoned")) {
      damageFromStatus(state, pid, a, 10, "poison");
      if ((state.phase as string) === "gameOver") return;
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
  if (target.damage >= target.card.hp) knockOut(state, defenderOwner);
}

// Prize-card value when KO'd. ex/V/Radiant give 2, VMAX/VSTAR give 3, others 1.
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
  const prizes = prizeValue(ko.card);
  logEvent(
    state,
    "system",
    `${ko.card.name} is Knocked Out! (${prizes} Prize${prizes > 1 ? "s" : ""})`,
  );
  // Move active + evolution stack + attached energy + tools to discard.
  owner.discard.push(
    ko.card,
    ...ko.evolvedFrom,
    ...ko.attachedEnergy,
    ...(ko.tools ?? []),
  );
  owner.active = null;

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
      if (p.damage >= p.card.hp) {
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
  }
}

export function endTurn(state: GameState): void {
  if (state.phase === "gameOver") return;
  if (state.pendingPromote) return;

  const prev = state.players[state.activePlayer];
  prev.energyAttachedThisTurn = false;
  prev.supporterPlayedThisTurn = false;
  prev.retreatedThisTurn = false;
  for (const p of [prev.active, ...prev.bench]) {
    if (p) {
      p.playedThisTurn = false;
      p.evolvedThisTurn = false;
      p.abilityUsedThisTurn = false;
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
