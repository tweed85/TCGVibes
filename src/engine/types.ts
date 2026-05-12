// Barrel export. The engine's type surface was split into four cohesive
// modules under ./types/ for navigability:
//   - cards.ts    EnergyType, Supertype, StatusCondition, card schema,
//                 Attack, Ability + their effect/condition unions
//   - effects.ts  AttackEffect, AttackPredicate, PokemonFilter, AttackSearchFilter
//   - pending.ts  Interactive pending state (PendingPick, PendingInPlayTarget, etc.)
//   - core.ts     Runtime game state (PokemonInPlay, PlayerState, GameState, GameRng, …)
// Existing imports `from "./types"` / `from "../types"` keep resolving via
// these re-exports — no consumer churn.

export type {
  EnergyType,
  Supertype,
  StatusCondition,
  Attack,
  Ability,
  AbilityEffect,
  AbilityCondition,
  WeaknessResistance,
  PokemonCard,
  EnergyCard,
  TrainerCard,
  Card,
} from "./types/cards";

export type {
  AttackEffect,
  PokemonFilter,
  AttackSearchFilter,
  AttackPredicate,
} from "./types/effects";

export type {
  PendingPickFallback,
  PendingPickEffectKind,
  PendingChoiceMenuEffectKind,
  PendingChoiceMenu,
  PendingHandReveal,
  PendingInPlayTarget,
  PendingPick,
  DeckSearchChainStep,
  PendingSearchNotice,
} from "./types/pending";

export type {
  PokemonInPlay,
  PlayerId,
  PlayerState,
  TurnAttackBonus,
  TurnDamageReduction,
  StadiumInPlay,
  Phase,
  CoinFlipState,
  LogEntry,
  GameRng,
  GameState,
} from "./types/core";
