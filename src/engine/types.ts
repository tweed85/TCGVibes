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
  | { kind: "benchSnipe"; damage: number; target: "opponentBench" | "allBench" | "allOpponents" }
  | { kind: "selfDamage"; damage: number } // "This Pokémon also does N damage to itself."
  | { kind: "applyStatus"; status: StatusCondition; target: "defender" | "self" }
  | { kind: "heal"; amount: number; target: "self" | "active" }
  | { kind: "discardOwnEnergy"; count: number } // "Discard N Energy from this Pokémon."
  | { kind: "drawCards"; count: number };

export type StatusCondition = "asleep" | "burned" | "confused" | "paralyzed" | "poisoned";

export interface Ability {
  name: string;
  type: string; // "Ability" | "Poké-Power" | "Poké-Body" | "Ancient Trait"
  text: string;
}

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
  playedThisTurn: boolean;
  evolvedThisTurn: boolean;
  statuses: StatusCondition[]; // asleep/paralyzed/confused are mutually exclusive with each other; poisoned/burned can coexist
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
  isAI: boolean;
}

export type Phase =
  | "setup"
  | "draw"
  | "main"
  | "attack"
  | "between"
  | "gameOver";

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
  // True on the very first player's first turn — they cannot attack.
  firstTurnNoAttack: boolean;
  rng: GameRng;
}
