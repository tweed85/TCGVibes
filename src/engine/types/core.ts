// Runtime game state: PokemonInPlay, PlayerState, GameState, RNG, turn-
// scoped modifiers, and per-game enums (Phase, CoinFlipState, LogEntry).
// Type-only cycle with ./pending is fine.

import type {
  Card,
  EnergyCard,
  EnergyType,
  PokemonCard,
  StatusCondition,
  TrainerCard,
} from "./cards";
import type {
  PendingChoiceMenu,
  PendingHandReveal,
  PendingInPlayTarget,
  PendingPick,
  PendingSearchNotice,
} from "./pending";

// Runtime instance of a Pokémon in play (active or bench).
export interface PokemonInPlay {
  instanceId: string;
  card: PokemonCard;
  damage: number;
  attachedEnergy: EnergyCard[];
  evolvedFrom: PokemonCard[]; // stack of pre-evolutions
  tools: TrainerCard[]; // Pokémon Tool cards attached — max 1 per Pokémon
  playedThisTurn: boolean;
  evolvedThisTurn: boolean;
  statuses: StatusCondition[]; // asleep/paralyzed/confused are mutually exclusive with each other; poisoned/burned can coexist
  abilityUsedThisTurn: boolean; // tracks "once during your turn" abilities
  // Turn-locked restrictions applied by attacks with "during your/opponent's
  // next turn, this/Defending Pokémon can't …" text. Inclusive turn number.
  cantAttackUntilTurn?: number;
  cantRetreatUntilTurn?: number;
  // Dunsparce "Dig": heads on the attack sets this to state.turn + 1 so
  // during the opponent's next turn, all incoming damage and non-damage
  // effects directed at this Pokémon are prevented.
  shieldedUntilTurn?: number;
  // True only on the turn this Pokémon moved from Bench to Active. Used by
  // attack predicates like Rayquaza Breakthrough Assault. Cleared at end of
  // its owner's turn.
  movedToActiveThisTurn?: boolean;
  // Set by attacks like Archaludon "Metal Defender" — during the opponent's
  // upcoming turn, this Pokémon ignores its own Weakness. Cleared at end of
  // its owner's turn.
  noWeaknessUntilTurn?: number;
  // Tracks "this Pokémon was healed during this turn" for predicates like
  // Vileplume "Lively Flower". Cleared at end of owner's turn.
  healedThisTurn?: boolean;
  // True if this Pokémon was damaged by an attack during the opponent's
  // most recent turn. Cleared when this Pokémon's owner ends their turn.
  damagedLastOppTurn?: boolean;
  // Name of the last attack used by THIS Pokémon during its owner's most
  // recent turn. Used by predicates like Togedemaru ex Spiky Rolling
  // ("If this Pokémon used Spiky Rolling during your last turn, ..."). Set
  // when an attack resolves; consumed/preserved across the next attack.
  lastAttackUsedNamePriorTurn?: string;
  // Set by Corrosive Sludge: at endTurn() when state.turn === this value,
  // KO this Pokémon (and discard attached). Stored as the absolute turn
  // number on which the trigger fires (= attacker's turn + 1). Cleared on
  // KO.
  scheduledKoOnTurn?: number;
}

export type PlayerId = "p1" | "p2";

export interface PlayerState {
  id: PlayerId;
  name: string;
  deck: Card[];
  hand: Card[];
  discard: Card[];
  prizes: Card[];
  bench: PokemonInPlay[]; // up to 5
  active: PokemonInPlay | null;
  energyAttachedThisTurn: boolean;
  supporterPlayedThisTurn: boolean;
  retreatedThisTurn: boolean;
  mulligans: number; // count of mulligans taken at setup
  setupComplete: boolean; // true after the player has chosen Active + bench at opening
  // Turn-scoped attack bonuses applied to this player's attacks, cleared at
  // end of their turn. E.g. Black Belt's Training: +40 vs ex, Premium Power Pro:
  // +30 for Fighting.
  thisTurnAttackBonuses: TurnAttackBonus[];
  // Damage reductions that apply during the opponent's NEXT turn (set by
  // Supporters like Jasmine's Gaze or Items like Iron Defender, cleared when
  // that turn ends).
  nextOpponentTurnDamageReductions: TurnDamageReduction[];
  // Budew's Itchy Pollen and similar attacks set this on the opponent so they
  // can't play Item cards during their next turn. Cleared when that turn ends.
  itemsBlockedNextTurn: boolean;
  // True if this player has used the in-play Stadium's activated ability
  // this turn (stadiums with once-per-turn "may" effects).
  stadiumUsedThisTurn: boolean;
  // Tracks "Last-Ditch" ability group usage ("You can't use more than 1
  // Ability that has 'Last-Ditch' in its name each turn."). Cleared at end
  // of turn.
  lastDitchUsedThisTurn: boolean;
  // Name of the last Supporter this player played this turn (null if none).
  // Used by abilities gated on a specific Supporter having been played
  // (Shadowy Envoy → Janine's Secret Art, Frilled Generator → Canari).
  // Cleared at end of turn.
  lastSupporterNameThisTurn: string | null;
  // True during this player's turn when ≥1 of their Pokémon was KO'd during
  // the opponent's turn that just ended. Consumed by Flip the Script / etc.
  // Cleared at the end of this player's turn.
  yourPokemonKoedLastOppTurn: boolean;
  // Names of YOUR Pokémon that were KO'd by an ATTACK during the opponent's
  // last turn. Used by predicates like Hop's Trevenant Horrifying Revenge
  // ("if any of your Hop's Pokémon were Knocked Out by damage from an attack
  // during your opponent's last turn"). Distinct from
  // yourPokemonKoedLastOppTurn because:
  //   1. KOs from status / recoil / effect damage do NOT populate this list
  //      (card text requires "by damage from an attack").
  //   2. Tracks WHICH Pokémon (by name) were KO'd, so name-prefix predicates
  //      don't false-positive on a sibling-still-in-play heuristic.
  // Cleared at the end of this player's turn.
  yourPokemonKoedByAttackLastOppTurnNames: string[];
  // Names of Item cards (Trainer subtype "Item") this player has played
  // from hand this turn. Used by predicates like Espurr "Buddy Attack"
  // (Chaos Rising) — "if you played Tomes of Transformation from your hand
  // during this turn". Cleared at the end of this player's turn.
  itemsPlayedThisTurn?: string[];
  // Number of Prize cards this player took during their most recent
  // (already-ended) turn. Used by Okidogi "Settle the Score" — "+60 damage
  // for each Prize card your opponent took during their last turn."
  // Reset to 0 at the start of each of this player's own turns.
  lastTurnPrizesTaken: number;
  // Set true once this player's Legacy Energy has triggered its "opp takes
  // 1 fewer Prize" effect. "Can't be applied more than once per game."
  legacyEnergyUsed: boolean;
  isAI: boolean;
  // AI strategy version. "v1" is the original greedy + 1-ply lookahead.
  // "v2" enables the strengthened heuristics (archetype awareness,
  // threat-aware eval, etc.) — fast, no extra search cost. Defaults to
  // "v1" when unset so existing tests don't change behavior.
  aiVersion?: "v1" | "v2";
  // Per-aiStep MCTS time budget in milliseconds. 0 (default) = MCTS off.
  // >0 enables MCTS at the v2 path. Kept separate from `aiVersion` so the
  // heuristic improvements ship without the search cost; MCTS is opt-in
  // for benchmarking, scenario tests, and the production app.
  mctsBudgetMs?: number;
}

export interface TurnAttackBonus {
  amount: number;
  // Optional gates. attackerType must match. The defender-shape gates
  // (againstEx, againstV) are OR-ed when both are set on one entry — e.g.
  // Kieran's "+30 vs ex AND V" fires if the defender is ex OR V.
  againstEx?: boolean; // only vs opponent's Active Pokémon ex
  againstV?: boolean; // only vs opponent's Active Pokémon V (V/VMAX/VSTAR/V-UNION)
  attackerType?: EnergyType; // only attacks from this type
}

export interface TurnDamageReduction {
  amount: number;
  defenderType?: EnergyType; // only when defender is this type (Iron Defender: Metal)
}

export interface StadiumInPlay {
  card: TrainerCard;
  controller: PlayerId;
}

export type Phase =
  | "coinFlip" // pre-game coin toss: player guesses heads/tails, winner chooses first
  | "setup"
  | "draw"
  | "main"
  | "attack"
  | "between"
  | "promoteActive" // waiting for a player to choose a new Active from their Bench
  | "pick" // waiting for a player to pick cards from a pool (search / peek / recover)
  | "gameOver";

// Pre-game coin-flip state. Null once the flip is fully resolved and both
// players' hands have been dealt.
export interface CoinFlipState {
  step: "pickGuess" | "chooseFirst";
  guess?: "heads" | "tails";
  result?: "heads" | "tails";
  winner?: PlayerId;
}

export interface LogEntry {
  turn: number;
  player: PlayerId | "system";
  text: string;
}

// Minimal RNG interface attached to GameState so effects can flip coins,
// shuffle, and pick targets without threading an extra parameter everywhere.
export interface GameRng {
  next(): number;
  int(maxExclusive: number): number;
  // Snapshot + restore the internal PRNG cursor. Used by the App's undo
  // stack so a re-executed action consumes the same entropy as the original
  // (otherwise undo+retry randomizes results).
  getState(): number;
  setState(s: number): void;
}

export interface GameState {
  players: Record<PlayerId, PlayerState>;
  activePlayer: PlayerId;
  turn: number;
  phase: Phase;
  winner: PlayerId | null;
  log: LogEntry[];
  // The player who goes first this game. Set by chooseFirstPlayer; null
  // until then. Used to derive "this is my first turn" for both players —
  // going-first's first turn is engine turn 1; going-second's is turn 2.
  firstPlayer: PlayerId | null;
  // True on the very first player's first turn — they cannot attack or play a Supporter.
  firstTurnNoAttack: boolean;
  // Stadium card currently in play (replaces previous when a new one is played).
  stadium: StadiumInPlay | null;
  // If non-null, game is paused waiting for this player to pick a new Active from their Bench.
  pendingPromote: PlayerId | null;
  // FIFO of additional players queued to promote after `pendingPromote` resolves.
  // Both-Active-KO (Houndoom-style mutual KO) sets this — defender promotes
  // first (real-TCG rule: non-active-player promotes first), then the active
  // player drains the queue. Empty array when no queue.
  pendingPromoteQueue: PlayerId[];
  // Heavy Baton: when the holder is KO'd, the energies don't auto-discard
  // and don't auto-attach. They stash here until the owner has promoted a
  // new Active and can interactively pick a Bench Pokémon to receive the
  // energies. Auto-resolves for AI and for humans with only one bench.
  pendingHeavyBaton:
    | { ownerId: PlayerId; energies: EnergyCard[]; max: number }
    | null;
  // Glass Trumpet (and any "pick from discard, then place in play" effect):
  // discard-recovery picker parks selected Energy here, then a follow-up
  // pendingInPlayTarget routes them onto chosen Bench targets without ever
  // putting the cards in hand.
  pendingAttachQueue:
    | { ownerId: PlayerId; energies: EnergyCard[]; sourceLabel: string }
    | null;
  // Handheld Fan: when the holder takes damage during opponent's attack and
  // the holder's owner (defender) is human + the attacker has 2+ bench,
  // defer the auto-move so the defender can pick which of the attacker's
  // Bench Pokémon receives the Energy. The attacker's `endTurn` is gated
  // on this picker resolving (mirrors the Heavy Baton pause pattern).
  pendingHandheldFan:
    | { defenderId: PlayerId; attackerSideId: PlayerId }
    | null;
  // Amulet of Hope: when the holder is KO'd by an opponent attack, the
  // owner gets to search up to 3 cards from their deck. Defer the picker
  // until AFTER promoteBenchToActive completes so KO/promote ordering is
  // stable (mirrors Heavy Baton).
  pendingAmuletOfHope:
    | { ownerId: PlayerId }
    | null;
  // What to do once the promote resolves.
  //  - "endTurn": KO happened during attack, run endTurn next
  //  - "passTurn": KO happened during checkup, skip cleanup and pass to opponent
  //  - "secondAttack": a Festival Lead second-hit is queued; run it after the
  //    opponent promotes, then endTurn
  onPromoteResolved: "endTurn" | "passTurn" | "secondAttack" | null;
  // Queued repeat attack (Dipplin/Festival Lead "attack twice"). Set when the
  // first hit resolves and the attacker still qualifies for a second hit.
  pendingSecondAttack: { player: PlayerId; attackIndex: number } | null;
  // If non-null, a player is being asked to pick cards from a pool (search /
  // peek / discard recovery). Blocks normal actions until resolved.
  pendingPick: PendingPick | null;
  // If non-null, the named player must click one of their own benched
  // Pokémon to complete a switch (e.g., the Switch item). The UI shows a
  // status prompt; clicking a bench Pokémon resolves it.
  pendingSwitchTarget: PlayerId | null;
  // A small menu-of-options prompt (e.g. "choose Burned / Confused /
  // Poisoned"). Distinct from PendingInPlayTarget — there's no Pokémon to
  // click, just an option to select. Used by Cradily Selective Slime,
  // Grafaiai Miraculous Paint, and future menu-pick cards.
  pendingChoiceMenu: PendingChoiceMenu | null;
  // Phase 7 — pre-attack discard-for-damage picker support. When a
  // damage-scaling discard effect (Inferno X / Bellowing Thunder / Spill
  // the Tea) opens a picker, the count of discarded Energy is recorded
  // here so the effect dispatcher can read it on attack resume instead
  // of running its own auto-discard.
  preComputedDiscardForDamage: number | null;
  // If non-null, a player must click an in-play Pokémon (own or opponent,
  // scoped by the action) to complete a trainer effect that needs a target
  // (Enhanced Hammer, Crushing Hammer on heads, Tool Scrapper, Heavy Baton,
  // Scoop Up Cyclone).
  pendingInPlayTarget: PendingInPlayTarget | null;
  // If non-null, a hand-reveal pick is pending (Eri, Xerosic's Machinations).
  pendingHandReveal: PendingHandReveal | null;
  // If non-null, an inter-stage search notice is pending (Dawn skipping an
  // empty category, etc.) — a small modal waits for the user to click
  // Continue before moving on to the next chained stage.
  pendingSearchNotice: PendingSearchNotice | null;
  // If non-null, Rare Candy has been played on a Basic and the player must
  // pick which Stage 2 (from their hand) to use when multiple match.
  pendingRareCandyChoice: {
    player: PlayerId;
    targetInstanceId: string;
    handIndexes: number[]; // indexes into the player's hand at the moment of the pick
  } | null;
  // Override for `snipeOne`-style attacks: when set, the effect targets the
  // opponent's bench Pokémon at this index instead of auto-picking. Cleared
  // after the attack.
  snipeTargetOverride: number | null;
  // Pre-game coin flip / first-player choice. Non-null until the winner has
  // picked first/second and hands are about to be dealt.
  coinFlip: CoinFlipState | null;
  rng: GameRng;
}
