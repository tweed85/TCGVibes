// AI policy registries.
//
// Per-prompt-family AI resolvers. Today the AI's lane for each prompt
// either lives inline in the handler that OPENS the prompt (branching on
// `pl.isAI` and auto-resolving without ever opening it) or in a switch
// inside the central resolver (`resolveAiPendingPickSmart`,
// `resolveAiHandReveal`, `resolveAiChoiceMenu`). This module declares
// the registry types so future conversions have a documented home; the
// migration of existing lanes is incremental (see aiPolicyAudit.ts for
// the coverage map).
//
// Cycle note: this module declares TYPES + thin REGISTRY containers. The
// actual policy functions are registered FROM the modules that own their
// scoring helpers (ai.ts, trainerEffects.ts, abilities.ts). That avoids a
// circular import where aiPolicies.ts would otherwise need to import
// scoring helpers from ai.ts.

import type {
  GameState,
  PendingChoiceMenuEffectKind,
  PendingHandReveal,
  PendingInPlayTarget,
  PendingPick,
  PendingPickEffectKind,
  PlayerId,
} from "./types";

export type AIPickPolicy = (
  state: GameState,
  player: PlayerId,
  pick: PendingPick,
) => number[];

export type AIInPlayPolicy = (
  state: GameState,
  player: PlayerId,
  prompt: PendingInPlayTarget,
) => string | null;

export type AIHandRevealPolicy = (
  state: GameState,
  player: PlayerId,
  prompt: PendingHandReveal,
) => number[];

export type AIChoiceMenuPolicy = (
  state: GameState,
  player: PlayerId,
  options: { id: string; label: string }[],
) => string;

// Stable identifier union for PendingHandReveal AI dispatch. Mirrors
// PendingPickEffectKind in shape; introduced in Phase 2.1 to replace the
// legacy reuse of PendingPickEffectKind on PendingHandReveal.effectKind.
export type PendingHandRevealEffectKind =
  | "academyAtNight"
  | "prismTower"
  | "mysteryGarden";

// Registries. Mutated only via registerAi* helpers at module load. Reads
// are unguarded — registry shape is stable after engine init.
export const AI_PICK_POLICIES: Partial<Record<PendingPickEffectKind, AIPickPolicy>> = {};
export const AI_INPLAY_POLICIES: Partial<Record<PendingInPlayTarget["action"]["kind"], AIInPlayPolicy>> = {};
export const AI_HANDREVEAL_POLICIES: Partial<Record<PendingHandRevealEffectKind, AIHandRevealPolicy>> = {};
export const AI_CHOICEMENU_POLICIES: Partial<Record<PendingChoiceMenuEffectKind, AIChoiceMenuPolicy>> = {};

export function registerAiPickPolicy(
  kind: PendingPickEffectKind,
  policy: AIPickPolicy,
): void {
  AI_PICK_POLICIES[kind] = policy;
}

export function registerAiInPlayPolicy(
  kind: PendingInPlayTarget["action"]["kind"],
  policy: AIInPlayPolicy,
): void {
  AI_INPLAY_POLICIES[kind] = policy;
}

export function registerAiHandRevealPolicy(
  kind: PendingHandRevealEffectKind,
  policy: AIHandRevealPolicy,
): void {
  AI_HANDREVEAL_POLICIES[kind] = policy;
}

export function registerAiChoiceMenuPolicy(
  kind: PendingChoiceMenuEffectKind,
  policy: AIChoiceMenuPolicy,
): void {
  AI_CHOICEMENU_POLICIES[kind] = policy;
}
