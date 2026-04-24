// Card data types — shaped to mirror the Pokémon TCG API so data from the
// pokemon-tournament-cards subagent can drop in with minimal adaptation.

export type EnergyType =
  | "Grass"
  | "Fire"
  | "Water"
  | "Lightning"
  | "Psychic"
  | "Fighting"
  | "Darkness"
  | "Metal"
  | "Fairy"
  | "Dragon"
  | "Colorless";

export type Supertype = "Pokémon" | "Trainer" | "Energy";

export interface Attack {
  name: string;
  cost: EnergyType[];
  damage: number; // parsed base damage; modifiers (+, ×, -) live in text
  damageText?: string; // original API string, e.g. "30+", "20×"
  text?: string;
  effects?: AttackEffect[]; // resolved at attack time (coin flips, statuses, etc.)
}

// Discriminated union of engine-understood attack effects. Text for effects
// not matching any of these is preserved in Attack.text for display, but
// doesn't trigger engine behavior.
export type AttackEffect =
  | { kind: "flipHeadsBonus"; bonus: number } // "Flip a coin. If heads, this attack does N more damage."
  | { kind: "flipTailsFizzle" } // "Flip a coin. If tails, this attack does nothing."
  | { kind: "flipHeadsDouble" } // "Flip a coin. If heads, this attack does X more damage." with bonus=base
  | { kind: "perAttachedEnergy"; perEnergy: number; energyType?: EnergyType } // "N damage for each Energy attached."
  | { kind: "perFriendlyBench"; perCount: number } // "N damage for each of your Benched Pokémon."
  | { kind: "perOpponentBench"; perCount: number } // "... for each of your opponent's Benched Pokémon."
  | { kind: "perBothBench"; perCount: number } // "... for each Benched Pokémon (both yours and your opponent's)."
  | { kind: "perDamageCounterOnSelf"; perCount: number } // "... for each damage counter on this Pokémon."
  | { kind: "perDamageCounterOnDefender"; perCount: number } // "... for each damage counter on the opponent's Active."
  | { kind: "perEnergyOnDefender"; perCount: number } // "... for each Energy attached to your opponent's Active."
  | { kind: "perPrizeOppTaken"; perCount: number } // "... for each Prize card your opponent has taken."
  | { kind: "benchSnipe"; damage: number; target: "opponentBench" | "allBench" | "allOpponents" }
  | { kind: "selfDamage"; damage: number } // "This Pokémon also does N damage to itself."
  | { kind: "applyStatus"; status: StatusCondition; target: "defender" | "self" }
  | { kind: "heal"; amount: number; target: "self" | "active" }
  | { kind: "discardOwnEnergy"; count: number } // "Discard N Energy from this Pokémon."
  | { kind: "drawCards"; count: number }
  | { kind: "blockOppItemsNextTurn" } // Budew Itchy Pollen — opp can't play Items next turn.
  | { kind: "flipMultiCoinsPerHeads"; coins: number; perHeads: number } // "Flip N coins. N damage per heads."
  | { kind: "selfCantAttackNextTurn" } // During your next turn, this Pokémon can't attack.
  | { kind: "defenderCantRetreatNextTurn" } // During opp's next turn, Defending can't retreat.
  | { kind: "selfDamageReductionNextTurn"; amount: number } // "takes N less damage next turn"
  | { kind: "snipeOne"; damage: number } // "This attack also does N damage to 1 of opp's Benched"
  | { kind: "switchOutOpponent" } // Opp promotes new Active from bench
  | { kind: "selfSwitch" } // Switch attacker with a benched Pokémon
  | { kind: "discardOppEnergy"; count: number } // Discard N Energy from opp's Active
  | { kind: "flipHeadsDiscardOppEnergy" } // Flip — heads: discard one Energy from opp's Active
  | { kind: "healEachOwnPokemon"; amount: number } // Heal N from each of your Pokémon
  | { kind: "discardTopOfOppDeck"; count: number } // Mill the opp deck by N
  | { kind: "discardOppTools" }; // "Before doing damage, discard all Tools from opp's Active"

export type StatusCondition = "asleep" | "burned" | "confused" | "paralyzed" | "poisoned";

export interface Ability {
  name: string;
  type: string; // "Ability" | "Poké-Power" | "Poké-Body" | "Ancient Trait"
  text: string;
  effect?: AbilityEffect; // auto-detected; if present, UI shows an Activate button
}

// Narrow set of supported activated-ability effects.
export type AbilityEffect =
  | { kind: "drawOne"; oncePerTurn: true }
  | { kind: "drawTwo"; oncePerTurn: true }
  | { kind: "drawN"; count: number; oncePerTurn: true }
  | { kind: "healSelf"; amount: number; oncePerTurn: true }
  | { kind: "healAny"; amount: number; oncePerTurn: true } // heal one of your Pokémon
  | { kind: "searchBasicEnergy"; count: number; oncePerTurn: true }
  | { kind: "attachEnergyFromHand"; energyType: EnergyType; oncePerTurn: true }
  | { kind: "attachEnergyFromDiscardToSelf"; oncePerTurn: true } // any Basic Energy from discard → self
  | { kind: "searchDeckAnyCard"; oncePerTurn: true; condition?: AbilityCondition } // search for any 1 card
  | { kind: "searchDeckPokemon"; oncePerTurn: true } // search for any 1 Pokémon
  | { kind: "switchWithBench"; oncePerTurn: true };

// Conditional gates evaluated at activation time. If the condition fails,
// the button is disabled (or the activation blocked with a reason).
export type AbilityCondition =
  | { kind: "activeHasAbilityNamed"; abilityName: string };

export interface WeaknessResistance {
  type: EnergyType;
  value: string; // e.g. "×2", "-30"
}

interface CardBase {
  id: string;
  name: string;
  setCode?: string;
  number?: string;
  rarity?: string;
  regulationMark?: string;
  imageSmall?: string;
  imageLarge?: string;
}

export interface PokemonCard extends CardBase {
  supertype: "Pokémon";
  subtypes: string[]; // "Basic", "Stage 1", "Stage 2", "ex", "V", ...
  hp: number;
  types: EnergyType[];
  evolvesFrom?: string;
  attacks: Attack[];
  abilities?: Ability[];
  weaknesses?: WeaknessResistance[];
  resistances?: WeaknessResistance[];
  retreatCost: EnergyType[]; // Colorless placeholders
  rules?: string[]; // ex/VSTAR/rule-box text
}

export interface EnergyCard extends CardBase {
  supertype: "Energy";
  subtypes: string[]; // "Basic" | "Special"
  provides: EnergyType[]; // Basic energy provides one of its type
}

export interface TrainerCard extends CardBase {
  supertype: "Trainer";
  subtypes: string[]; // "Item" | "Supporter" | "Stadium" | "Pokémon Tool"
  text: string;
  rules?: string[];
  // Effects are kept data-driven via an effect id the engine interprets.
  effectId?: string;
}

export type Card = PokemonCard | EnergyCard | TrainerCard;

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
  isAI: boolean;
}

export interface TurnAttackBonus {
  amount: number;
  // Optional gates — all must match for the bonus to apply.
  againstEx?: boolean; // only vs opponent's Active Pokémon ex
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

// What to do with cards the player didn't pick when a pending pick resolves.
export type PendingPickFallback =
  | "shuffleIntoDeck" // search / top-peek effects
  | "bottomOfDeck" // a few peek effects
  | "returnToDiscard"; // discard-recovery effects

export interface PendingPick {
  player: PlayerId;
  // Human-readable description of what to pick.
  label: string;
  // Cards the player is choosing from (pulled out of their source zone).
  pool: Card[];
  min: number; // minimum picks required (0 for "may" effects)
  max: number; // maximum picks allowed
  // If set, only these pool indexes are pickable (rest are shown but disabled).
  eligibleIndexes?: number[];
  // What to do with unpicked cards once the pick resolves.
  unpicked: PendingPickFallback;
  // Where the pool came from — surfaced in the UI so the user knows Prize
  // cards are never involved in a deck search.
  source: "deck" | "deckTop" | "deckBottom" | "discard";
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
}

export interface GameState {
  players: Record<PlayerId, PlayerState>;
  activePlayer: PlayerId;
  turn: number;
  phase: Phase;
  winner: PlayerId | null;
  log: LogEntry[];
  // True on the very first player's first turn — they cannot attack or play a Supporter.
  firstTurnNoAttack: boolean;
  // Stadium card currently in play (replaces previous when a new one is played).
  stadium: StadiumInPlay | null;
  // If non-null, game is paused waiting for this player to pick a new Active from their Bench.
  pendingPromote: PlayerId | null;
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
  // Pre-game coin flip / first-player choice. Non-null until the winner has
  // picked first/second and hands are about to be dealt.
  coinFlip: CoinFlipState | null;
  rng: GameRng;
}
