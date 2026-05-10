// Phase 2 — prompt model.
//
// `state.pending*` is the source of truth (8 user-resolvable fields,
// inventoried below). This module provides a single discriminated union
// (`PendingPrompt`) that projects whatever pending state is currently
// active into a uniform shape, so the UI can render one switch instead
// of scattering picker logic across pendingPick / pendingInPlayTarget /
// etc.
//
// Engine continuations (`pendingPromoteQueue`, `pendingSecondAttack`,
// `onPromoteResolved`) are NOT prompts and are intentionally excluded —
// they advance internally.
//
// The migration is adapter-first: `state.pendingPick` etc. remain the
// authoritative state. UI rendering can opt in to the prompt projection
// gradually. New effects should prefer this projection's shape.

import type {
  Card,
  EnergyCard,
  GameState,
  PendingHandReveal,
  PendingInPlayTarget,
  PendingPick,
  PendingSearchNotice,
  PlayerId,
} from "./types";

export interface BasePrompt {
  player: PlayerId;
  /** Short headline for the picker UI. */
  label: string;
  /** Engine source for the prompt (e.g. "Buddy-Buddy Poffin", "Phantom Dive"). */
  source?: string;
}

export type PendingPrompt =
  | DeckPickPrompt
  | DiscardPickPrompt
  | InPlayTargetPrompt
  | SwitchPrompt
  | PromotePrompt
  | HandRevealPrompt
  | SearchNoticePrompt
  | RareCandyChoicePrompt
  | HeavyBatonPrompt;

export interface DeckPickPrompt extends BasePrompt {
  kind: "deckPick";
  pool: Card[];
  min: number;
  max: number;
  /** Mirrors PendingPick.unpicked verbatim — the engine knows what to do
   *  with cards left unpicked (shuffle back, peek-and-discard, etc.). */
  unpicked:
    | "shuffleIntoDeck"
    | "topOfDeck"
    | "bottomOfDeck"
    | "discard"
    | "returnToDiscard";
  pickedDestination: "hand" | "bench" | "evolve" | "attach";
}

export interface DiscardPickPrompt extends BasePrompt {
  kind: "discardPick";
  pool: Card[];
  min: number;
  max: number;
  pickedDestination: "hand";
}

export interface InPlayTargetPrompt extends BasePrompt {
  kind: "inPlayTarget";
  /** Owner side(s) the picker can target. */
  side: "own" | "opp" | "either";
  /** Optional list of legal candidate instance ids; UI filters its highlight. */
  candidateInstanceIds?: string[];
}

export interface SwitchPrompt extends BasePrompt {
  kind: "switch";
}

export interface PromotePrompt extends BasePrompt {
  kind: "promote";
}

export interface HandRevealPrompt extends BasePrompt {
  kind: "handReveal";
  /** Whose hand is being revealed (the `target` player). The `player` on
   *  the prompt is who clicks to resolve it. */
  target: PlayerId;
  filter: "item" | "tool" | "itemOrTool" | "supporter" | "pokemon" | "any";
  min: number;
  max: number;
}

export interface SearchNoticePrompt extends BasePrompt {
  kind: "searchNotice";
  message: string;
}

export interface RareCandyChoicePrompt extends BasePrompt {
  kind: "rareCandyChoice";
  /** The Basic in play receiving the Rare Candy. */
  targetInstanceId: string;
  /** Hand indexes that point to legal Stage 2 evolutions. */
  handIndexes: number[];
}

export interface HeavyBatonPrompt extends BasePrompt {
  kind: "heavyBaton";
  ownerId: PlayerId;
  energies: EnergyCard[];
  max: number;
}

// ---- Adapters -------------------------------------------------------------

/** Most-active prompt for the player. Returns null when no prompt is open. */
export function activePrompt(state: GameState, viewer?: PlayerId): PendingPrompt | null {
  const all = activePrompts(state);
  if (viewer) {
    const owned = all.find((p) => p.player === viewer);
    if (owned) return owned;
  }
  return all[0] ?? null;
}

/**
 * All currently-open user-resolvable prompts (typically 0 or 1, but
 * theoretically more if engine continuations queue them up). Order is
 * not engine-meaningful — the UI typically picks the first match for
 * the viewer.
 */
export function activePrompts(state: GameState): PendingPrompt[] {
  const out: PendingPrompt[] = [];
  if (state.pendingPick) {
    out.push(pendingPickToPrompt(state.pendingPick));
  }
  if (state.pendingInPlayTarget) {
    out.push(pendingInPlayTargetToPrompt(state.pendingInPlayTarget));
  }
  if (state.pendingSwitchTarget !== null) {
    out.push({
      kind: "switch",
      player: state.pendingSwitchTarget,
      label: "Switch in a Benched Pokémon",
    });
  }
  if (state.pendingPromote !== null) {
    out.push({
      kind: "promote",
      player: state.pendingPromote,
      label: "Promote a Benched Pokémon to Active",
    });
  }
  if (state.pendingHandReveal) {
    out.push(pendingHandRevealToPrompt(state.pendingHandReveal));
  }
  if (state.pendingSearchNotice) {
    out.push(pendingSearchNoticeToPrompt(state.pendingSearchNotice));
  }
  if (state.pendingRareCandyChoice) {
    const r = state.pendingRareCandyChoice;
    out.push({
      kind: "rareCandyChoice",
      player: r.player,
      label: "Pick a Stage 2 to play with Rare Candy",
      targetInstanceId: r.targetInstanceId,
      handIndexes: r.handIndexes,
    });
  }
  if (state.pendingHeavyBaton) {
    out.push({
      kind: "heavyBaton",
      player: state.pendingHeavyBaton.ownerId,
      label: "Heavy Baton: pick a Benched Pokémon to receive the energies",
      ownerId: state.pendingHeavyBaton.ownerId,
      energies: state.pendingHeavyBaton.energies,
      max: state.pendingHeavyBaton.max,
    });
  }
  return out;
}

export function pendingPickToPrompt(p: PendingPick): DeckPickPrompt | DiscardPickPrompt {
  // PendingPick covers BOTH deck searches and discard recoveries; the
  // `source` field discriminates. Project the appropriate prompt kind.
  if (p.source === "discard") {
    return {
      kind: "discardPick",
      player: p.player,
      label: p.label,
      pool: p.pool,
      min: Math.max(0, p.min ?? 0),
      max: p.max,
      pickedDestination: "hand",
    };
  }
  const dest: DeckPickPrompt["pickedDestination"] = p.toBench
    ? "bench"
    : p.toEvolve
      ? "evolve"
      : p.attachToInstanceId
        ? "attach"
        : "hand";
  return {
    kind: "deckPick",
    player: p.player,
    label: p.label,
    pool: p.pool,
    min: Math.max(0, p.min ?? 0),
    max: p.max,
    unpicked: p.unpicked,
    pickedDestination: dest,
  };
}

export function pendingInPlayTargetToPrompt(p: PendingInPlayTarget): InPlayTargetPrompt {
  // PendingInPlayTarget already carries an explicit scope ("own" / "opp" /
  // "both"); we map "both" to "either" for the UI's coarser term.
  const side: InPlayTargetPrompt["side"] =
    p.scope === "both" ? "either" : p.scope;
  return {
    kind: "inPlayTarget",
    player: p.player,
    label: p.label,
    side,
  };
}

export function pendingHandRevealToPrompt(p: PendingHandReveal): HandRevealPrompt {
  return {
    kind: "handReveal",
    player: p.player,
    label: p.label,
    target: p.target,
    filter: p.filter,
    min: p.min,
    max: p.max,
  };
}

export function pendingSearchNoticeToPrompt(p: PendingSearchNotice): SearchNoticePrompt {
  return {
    kind: "searchNotice",
    player: p.player,
    label: "Continue",
    message: p.message,
  };
}
