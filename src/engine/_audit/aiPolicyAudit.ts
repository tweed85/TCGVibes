// AI policy audit.
//
// Mirrors the userChoiceAudit pattern but keyed by *prompt-source*
// discriminators (PendingPickEffectKind, PendingInPlayTarget action kinds,
// PendingHandRevealEffectKind, PendingChoiceMenuEffectKind) — distinct
// from the *handler* discriminators audited in userChoiceAudit.
//
// For every prompt-source kind, the audit declares whether the AI is
// expected to dispatch via a registered policy (`"policy"`) or fall
// through to a generic scorer / first-eligible fallback (`"genericScored"`).
// `"handledInline"` means the trainer/ability handler branches on
// `pl.isAI` BEFORE setting the prompt — the AI never sees the prompt
// for that action kind, so no policy or fallback is required.
//
// A vitest guard verifies that every `"policy"` entry is actually present
// in the runtime registry — catches registrations that silently drop off
// after a refactor.

import type {
  PendingChoiceMenuEffectKind,
  PendingInPlayTarget,
  PendingPickEffectKind,
} from "../types";
import type { PendingHandRevealEffectKind } from "../aiPolicies";

export type PolicyClassification = "policy" | "genericScored" | "handledInline";

// PendingPick lanes.
export const AI_PICK_POLICY_AUDIT: Record<PendingPickEffectKind, PolicyClassification> = {
  preciousTrolley: "policy",
  energySearchPro: "policy",
  academyAtNight: "genericScored", // spawns pendingHandReveal — see AI_HANDREVEAL_POLICY_AUDIT
  prismTower: "genericScored",
  mysteryGarden: "genericScored",
  levincia: "policy",
  grandTreeStage1: "policy",
  grandTreeStage2: "policy",
  glassTrumpetEnergyPick: "policy",
  reconDirective: "policy",
  peekTopMayDiscard: "policy",
};

// PendingInPlayTarget lanes — keyed by the action.kind discriminant.
// Most action kinds are "handledInline" — the opener branches on
// `pl.isAI` and resolves the effect without ever setting
// pendingInPlayTarget for an AI player. "genericScored" entries reach
// the defensive aiStep drain (resolveAiPendingInPlayTarget) and rely
// on the first-eligible fallback.
export const AI_INPLAY_POLICY_AUDIT: Record<PendingInPlayTarget["action"]["kind"], PolicyClassification> = {
  enhancedHammer: "handledInline",
  crushingHammer: "handledInline",
  pokemonCatcher: "handledInline",
  toolScrapper: "handledInline",
  heavyBaton: "handledInline",
  scoopUpCyclone: "handledInline",
  lisiasAppeal: "handledInline",
  nPlanEnergySource: "handledInline",
  wallysCompassion: "handledInline",
  energySwitchSource: "handledInline",
  energySwitchDest: "handledInline",
  typedEnergySwitchSource: "handledInline",
  typedEnergySwitchDest: "handledInline",
  abilityHealAny: "handledInline",
  abilityPlaceCountersOnOpp: "handledInline",
  abilitySwitchBenchedTypeWithStatus: "handledInline",
  abilitySwapWithBenchForceOppPromote: "handledInline",
  abilityDevolveOppEvolution: "handledInline",
  abilityAttachAnyBasicFromDiscardToTyped: "genericScored",
  abilityAttachMixedFromHand: "genericScored",
  attackMoveAnyEnergySource: "genericScored",
  attackMoveAnyEnergyDest: "genericScored",
  abilityAttachQueuedEnergyToAlly: "genericScored",
  attackAttachBasicFromHandToAlly: "genericScored",
  attackDiscardForDamagePicker: "handledInline", // Phase 7 — AI never sees this picker (attack() branches on !pl.isAI before opening)
  jacintheHeal: "handledInline",
  pokeVitalAHeal: "handledInline",
  potionHeal: "handledInline",
  superPotionHeal: "handledInline",
  wondrousPatchAttach: "handledInline",
  abilityMoveDamage: "handledInline",
  abilityCursedBlast: "handledInline",
  abilityAttachEnergyFromDiscard: "handledInline",
  crispinAttachEnergy: "handledInline",
  sendFlowersAttach: "handledInline",
  distributeDamage: "handledInline",
  attachEnergyFromDiscardPicker: "handledInline",
  heavyBatonPick: "handledInline",
  primeCatcherGust: "handledInline",
  primeCatcherSelfSwitch: "handledInline",
  surfingBeachSwitch: "handledInline",
  grandTreeBasicTarget: "handledInline",
  glassTrumpetAttach: "handledInline",
  scrambleSwitchTarget: "handledInline",
  handheldFanPick: "handledInline",
};

// PendingHandReveal lanes.
export const AI_HANDREVEAL_POLICY_AUDIT: Record<PendingHandRevealEffectKind, PolicyClassification> = {
  academyAtNight: "genericScored",
  prismTower: "genericScored",
  mysteryGarden: "genericScored",
};

// PendingChoiceMenu lanes.
export const AI_CHOICEMENU_POLICY_AUDIT: Record<PendingChoiceMenuEffectKind, PolicyClassification> = {
  selectiveSlimeStatus: "policy",
};
