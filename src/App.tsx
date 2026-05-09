import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  attachEnergy,
  attack,
  attackPreflight,
  endTurn,
  evolve,
  playBasicToBench,
  playTrainer,
  promoteBenchToActive,
  retreat,
} from "./engine/actions";
import type { TrainerTarget } from "./engine/actions";
import { activateAbility } from "./engine/abilities";
import { aiStep, resolveAiCoinChoice, resolveAiPendingPromote, resolveAiSetup } from "./engine/ai";
import { resolvePendingPick, resolvePendingSearchNotice } from "./engine/pendingPick";
import {
  resolveSwitchTarget,
  resolveInPlayTarget,
  cancelInPlayTarget,
  resolveHandReveal,
  cancelHandReveal,
  resolveRareCandyChoice,
  cancelRareCandyChoice,
} from "./engine/trainerEffects";
import { stadiumHasActivatedEffect, useStadium } from "./engine/stadiumActivated";
import { makeRng } from "./engine/rng";
import {
  canPayCost,
  chooseFirstPlayer,
  completeSetup,
  isBasic,
  isPokemon,
  resolveCoinGuess,
  setupGame,
  unspentTurnSlots,
} from "./engine/rules";
import { effectiveAttackCost, effectiveAttacks, effectiveMaxHp, energyPoolForCost, estimateAttackDamage } from "./engine/ongoingEffects";
import type { ActionResult } from "./engine/actions";
import type { Ability, Card, GameState, LogEntry, PlayerId, PokemonInPlay } from "./engine/types";
import { buildDeck, validateDeckForPlay, validatedDeckSpecs } from "./data/decks";
import { datasetAsOf, datasetFormat } from "./data/cards";
import { getAttackEffects } from "./data/effectPatterns";
import { loadImportedDecks, saveImportedDecks, type PersistedImport } from "./data/persistence";
import {
  buildDeckFromEntries,
  importDecklist,
  type DeckListEntry,
} from "./data/decklistParser";
import { CardView, FaceDownCard, PokemonInPlayView, setCardZoomHandler } from "./ui/CardView";
// Deck Builder lives in its own module so it can be code-split out of the
// first-page bundle — ~400 KB gzipped savings since the builder isn't needed
// until the user opens the pre-game modal's Build Deck button.
const DeckBuilderModal = lazy(() => import("./ui/DeckBuilderModal"));

type Selection =
  | { kind: "hand"; index: number }
  | { kind: "inPlay"; instanceId: string }
  | null;

function useForceRerender() {
  const [, set] = useState(0);
  return () => set((x) => x + 1);
}

interface ImportedDeck {
  id: string;
  name: string;
  entries: DeckListEntry[]; // persistable source-of-truth
  cards: Card[];             // resolved at import / load time
}

// Settings stay in localStorage — small (~100 bytes) and we need sync init
// before first render. Imported decks moved to IndexedDB (see persistence.ts)
// so iOS WebView storage pressure can't evict them and we're not capped at
// localStorage's ~5MB.
const SETTINGS_STORAGE_KEY = "tcgvibes.settings.v1";

type AiSpeed = "instant" | "fast" | "normal" | "slow";

interface PersistedSettings {
  openHands?: boolean;
  gameMode?: "vsCPU" | "local";
  myDeckId?: string;
  oppDeckId?: string;
  aiSpeed?: AiSpeed;
}

// Per-step delay (ms) between AI decisions. "instant" runs the whole turn
// synchronously (no animation). The other tiers leave enough time to read
// the latest-action banner before the next play resolves.
const AI_STEP_DELAY_MS: Record<AiSpeed, number> = {
  instant: 0,
  fast: 1000,
  normal: 3000,
  slow: 5000,
};

function loadSettings(): PersistedSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as PersistedSettings;
  } catch {
    return {};
  }
}

function saveSettings(s: PersistedSettings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(s));
  } catch {
    // private mode / quota — silently ignore.
  }
}

function rehydrateImports(persisted: PersistedImport[]): ImportedDeck[] {
  const restored: ImportedDeck[] = [];
  for (const p of persisted) {
    if (!p || !p.id || !p.name || !Array.isArray(p.entries)) continue;
    const built = buildDeckFromEntries(p.entries);
    // Skip decks that can't be resolved at all (dataset drift) — the raw
    // entries would still be in storage for debugging, but a zero-card deck
    // is unplayable. Partial resolution (<60) is kept and flagged in UI.
    if (built.deck.length === 0) continue;
    restored.push({ id: p.id, name: p.name, entries: p.entries, cards: built.deck });
  }
  return restored;
}

export default function App() {
  const deckSpecs = useMemo(() => validatedDeckSpecs(), []);
  const savedSettings = useMemo(() => loadSettings(), []);
  // Imports come from IndexedDB (async). Start empty and rehydrate on mount.
  // Selected deck IDs may temporarily fall back to the first preset if the
  // user's saved import-deck isn't yet rehydrated by first paint, then sync
  // up once IDB resolves.
  const [imports, setImports] = useState<ImportedDeck[]>([]);
  const [importsLoaded, setImportsLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadImportedDecks().then((persisted) => {
      if (cancelled) return;
      setImports(rehydrateImports(persisted));
      setImportsLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);
  const knownDeckIds = useMemo(() => {
    const ids = new Set<string>(deckSpecs.map((d) => d.id));
    for (const i of imports) ids.add(i.id);
    return ids;
  }, [deckSpecs, imports]);
  const [myDeckId, setMyDeckId] = useState(
    savedSettings.myDeckId && knownDeckIds.has(savedSettings.myDeckId)
      ? savedSettings.myDeckId
      : deckSpecs[0]?.id ?? "",
  );
  const [oppDeckId, setOppDeckId] = useState(
    savedSettings.oppDeckId === "__random__"
      ? "__random__"
      : savedSettings.oppDeckId && knownDeckIds.has(savedSettings.oppDeckId)
        ? savedSettings.oppDeckId
        : deckSpecs[1]?.id ?? deckSpecs[0]?.id ?? "",
  );
  const rngRef = useRef(makeRng(Date.now()));

  // Resolve "__random__" to a concrete preset id at game start time, so we
  // can log / banner the deck that was rolled. Pass-through for other ids.
  const resolveDeckId = (id: string): string => {
    if (id === "__random__" && deckSpecs.length > 0) {
      const idx = Math.floor(Math.random() * deckSpecs.length);
      return deckSpecs[idx].id;
    }
    return id;
  };

  // Build a deck for the picker id — either a preset spec or an imported list.
  // The "__random__" sentinel must be resolved via `resolveDeckId` first.
  const deckForId = (id: string, fallback: Card[]): Card[] => {
    const resolved = resolveDeckId(id);
    const imported = imports.find((d) => d.id === resolved);
    if (imported) return imported.cards.map((c) => ({ ...c }));
    const spec = deckSpecs.find((d) => d.id === resolved);
    if (spec) return buildDeck(spec);
    return fallback;
  };


  const buildInitial = (): GameState => {
    const fallback = buildDeck(deckSpecs[0]);
    const myDeck = deckForId(myDeckId, fallback);
    const oppDeck = deckForId(oppDeckId, fallback);
    return setupGame(myDeck, oppDeck, rngRef.current, {
      p1Name: "You",
      p2Name: "CPU",
    });
  };

  const stateRef = useRef<GameState>(buildInitial());
  const rerender = useForceRerender();
  const [selected, setSelected] = useState<Selection>(null);
  // Drag-and-drop from hand → in-play. Non-null while a drag is in flight.
  // `dragging.handIndex` identifies the source card; `x/y` track the ghost's
  // position; `hoverTargetId` is the data-droptarget the pointer is currently
  // over (only set if it's a legal target — drives the .drop-hover highlight).
  const [dragging, setDragging] = useState<{
    handIndex: number;
    card: Card;
    x: number;
    y: number;
    hoverTargetId: string | null;
  } | null>(null);
  // Pointermove fires far faster than React can re-render. Stash the latest
  // coords in a ref and flush via rAF so we don't tear or thrash.
  const dragRafRef = useRef<number | null>(null);
  // Instance-id of the Pokémon whose ability button is currently hovered.
  // Used to glow the source Pokémon in the play area so multiple same-named
  // cards (e.g. two Teal Mask Ogerpon ex) are immediately distinguishable.
  const [hoveredAbilitySource, setHoveredAbilitySource] = useState<string | null>(null);
  const [statusMsg, setStatusMsgRaw] = useState<string>("");
  // Dwell-aware setter. The status-line at the top of the action bar is the
  // primary feedback channel for what just happened; rapid-clicking actions
  // would replace prior messages before the user could read them. Hold each
  // non-empty message for at least 2500ms before allowing it to be
  // overwritten — empty strings (explicit clears) bypass the dwell so
  // turn-end / modal-close paths still react instantly.
  const lastStatusAtRef = useRef<number>(0);
  const pendingStatusTimerRef = useRef<number | null>(null);
  const setStatusMsg = (msg: string): void => {
    if (pendingStatusTimerRef.current !== null) {
      clearTimeout(pendingStatusTimerRef.current);
      pendingStatusTimerRef.current = null;
    }
    const now = Date.now();
    const elapsed = now - lastStatusAtRef.current;
    if (msg === "" || elapsed >= 2500) {
      setStatusMsgRaw(msg);
      lastStatusAtRef.current = msg === "" ? 0 : now;
      return;
    }
    pendingStatusTimerRef.current = window.setTimeout(() => {
      setStatusMsgRaw(msg);
      lastStatusAtRef.current = Date.now();
      pendingStatusTimerRef.current = null;
    }, 2500 - elapsed);
  };
  const [openHands, setOpenHands] = useState(savedSettings.openHands ?? false);
  const [importOpen, setImportOpen] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);
  // Gate the game behind a pre-game deck selection step. Nothing runs (AI
  // setup, turn-1 draw, opening modal) until the player clicks Start.
  const [preGameOpen, setPreGameOpen] = useState(true);
  const [discardViewer, setDiscardViewer] = useState<PlayerId | null>(null);
  const [zoomCard, setZoomCard] = useState<Card | null>(null);
  // When the user initiates an attack that would snipe a benched opponent,
  // we pause to let them pick the target. Holds the pending attack index.
  const [pendingSnipeAttack, setPendingSnipeAttack] = useState<number | null>(null);
  // Set to true once the mulligan-summary modal has been dismissed for the
  // current game; prevents reopening on every rerender. Reset by onReset.
  const [mulliganNoticeDismissed, setMulliganNoticeDismissed] = useState(false);
  // Stack of pre-action snapshots for Undo. Each entry captures both the
  // serialized GameState (rng stripped, since rng is a function-bearing
  // closure that JSON-clone can't preserve) AND the RNG's internal cursor
  // position via `getState()`. On undo, we pop the most recent entry and
  // restore both pieces — including rewinding the rng cursor — so a retried
  // action consumes the same entropy and produces deterministic results
  // instead of randomized ones. The stack is reset at the start of each new
  // turn for the viewing player.
  const undoStackRef = useRef<Array<{ state: string; rngState: number; label: string }>>([]);
  const undoTurnRef = useRef<{ turn: number; player: PlayerId | null }>({ turn: -1, player: null });
  const [canUndo, setCanUndo] = useState(false);
  // Game mode: "vsCPU" leaves p2 as AI; "local" makes both sides human and
  // enables hotseat device-handoff between turns.
  const [gameMode, setGameMode] = useState<"vsCPU" | "local">(savedSettings.gameMode ?? "vsCPU");
  // CPU-turn pacing. The AI loop in App.tsx now runs one decision at a time
  // (see aiStep below) so the user can watch the turn unfold; this controls
  // the inter-step delay.
  const [aiSpeed, setAiSpeed] = useState<AiSpeed>(savedSettings.aiSpeed ?? "normal");
  // Per-turn safety counter for the step-paced AI loop. If aiStep ever fails
  // to make progress (shouldn't happen, but defensive against engine bugs),
  // we cap the loop and force-end the turn instead of spinning forever.
  const aiStepCountRef = useRef<{ turn: number; player: PlayerId | null; count: number }>({
    turn: -1,
    player: null,
    count: 0,
  });
  // Who's currently holding the device. Determines which side shows as "me"
  // at the bottom of the playmat. Always "p1" in vs-CPU mode.
  const [viewingPlayer, setViewingPlayer] = useState<PlayerId>("p1");
  // When set, the UI hides the board and shows a "pass the device" interstitial
  // until the incoming player clicks to start their turn.
  const [pendingHandoff, setPendingHandoff] = useState<PlayerId | null>(null);

  const state = stateRef.current;
  const isLocal = gameMode === "local";
  const me = state.players[viewingPlayer];
  const opp = state.players[viewingPlayer === "p1" ? "p2" : "p1"];
  const myTurn = state.activePlayer === viewingPlayer && state.phase === "main";

  // Persist imported decks across reloads. Skip the first save before IDB has
  // finished its initial load — otherwise we'd write an empty array over any
  // existing saved decks if the user lands on the page and reloads quickly.
  useEffect(() => {
    if (!importsLoaded) return;
    void saveImportedDecks(
      imports.map(({ id, name, entries }): PersistedImport => ({ id, name, entries })),
    );
  }, [imports, importsLoaded]);

  // Persist UI settings (gameMode, openHands, last-selected decks).
  useEffect(() => {
    saveSettings({ openHands, gameMode, myDeckId, oppDeckId, aiSpeed });
  }, [openHands, gameMode, myDeckId, oppDeckId, aiSpeed]);

  // Wire the global card-zoom handler (CardView calls it on shift+click).
  useEffect(() => {
    setCardZoomHandler((c) => setZoomCard(c));
    return () => setCardZoomHandler(null);
  }, []);

  // Reset the undo stack at the start of each fresh turn for the viewing
  // player. We don't push an initial snapshot — the stack only gets entries
  // when the player actually takes an action (via `snapshotForUndo` below).
  // After a turn flip, the previous turn's actions are no longer reversible.
  useEffect(() => {
    if (preGameOpen) return;
    if (state.winner !== null) return;
    if (pendingHandoff) return;
    if (state.phase !== "main") return;
    if (state.activePlayer !== viewingPlayer) return;
    const turnKey = undoTurnRef.current;
    if (turnKey.turn !== state.turn || turnKey.player !== viewingPlayer) {
      undoTurnRef.current = { turn: state.turn, player: viewingPlayer };
      undoStackRef.current = [];
      setCanUndo(false);
    }
  }, [state.turn, state.activePlayer, viewingPlayer, preGameOpen, pendingHandoff]);

  // Snapshot the current state + RNG cursor before a player action runs.
  // Called from each action handler (play / attach / evolve / retreat /
  // attack / playTrainer / activateAbility / promote). Pushes onto the
  // undo stack so the player can step back through their own actions.
  // Captures the rng cursor via `getState()` so re-execution after undo
  // consumes the same entropy and is deterministic.
  const snapshotForUndo = (label: string): void => {
    if (state.activePlayer !== viewingPlayer) return;
    if (state.phase !== "main") return;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { rng: _rng, ...serializable } = state;
    undoStackRef.current.push({
      state: JSON.stringify(serializable),
      rngState: state.rng.getState(),
      label,
    });
    setCanUndo(true);
  };

  // Export the current game log as a downloadable JSON file. Lightweight
  // "replay mode" — reading through the log lets you reconstruct the play.
  const onExportLog = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      turn: state.turn,
      activePlayer: state.activePlayer,
      winner: state.winner,
      players: {
        p1: { name: state.players.p1.name, prizes: state.players.p1.prizes.length, mulligans: state.players.p1.mulligans },
        p2: { name: state.players.p2.name, prizes: state.players.p2.prizes.length, mulligans: state.players.p2.mulligans },
      },
      log: state.log,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pandabananastcg-game-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatusMsg("Game log exported.");
  };

  const onUndo = () => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const entry = stack.pop()!;
    try {
      const restored = JSON.parse(entry.state);
      // Reuse the live RNG instance but rewind its internal cursor to where
      // it was before the undone action. Without this rewind, re-rolling
      // (e.g., a deck shuffle, coin flip, or random search pick) would
      // consume different entropy each time, making undo behave like a
      // randomizer instead of a real reversal.
      const rng = stateRef.current.rng;
      rng.setState(entry.rngState);
      stateRef.current = { ...restored, rng };
      setSelected(null);
      setStatusMsg(`Undid: ${entry.label}.`);
      setPendingSnipeAttack(null);
      setCanUndo(stack.length > 0);
      rerender();
    } catch {
      setStatusMsg("Undo failed.");
    }
  };

  // In local mode, detect when the "current actor" flips and trigger a
  // pass-the-device interstitial so the incoming player can't see the
  // outgoing player's hand. The current actor is: whichever human still
  // needs to set up during opening setup, otherwise the coin-flip winner
  // when picking first/second, otherwise the active player.
  useEffect(() => {
    if (!isLocal) return;
    if (preGameOpen) return;
    if (pendingHandoff) return;
    if (state.winner !== null) return;

    let actor: PlayerId | null = null;
    if (state.phase === "coinFlip" && state.coinFlip?.step === "chooseFirst") {
      actor = state.coinFlip.winner ?? null;
    } else if (state.phase === "setup") {
      for (const pid of ["p1", "p2"] as PlayerId[]) {
        if (!state.players[pid].setupComplete && !state.players[pid].isAI) {
          actor = pid;
          break;
        }
      }
    } else if (state.phase === "main" || state.phase === "pick" || state.phase === "promoteActive") {
      // pendingPick / promote can transfer to the OTHER player mid-attack
      // (e.g. Budew → opp needs to respond). Prefer the actor expected by
      // the engine.
      if (state.pendingPick) actor = state.pendingPick.player;
      else if (state.pendingPromote) actor = state.pendingPromote;
      else actor = state.activePlayer;
    }
    if (actor && actor !== viewingPlayer && !state.players[actor].isAI) {
      setPendingHandoff(actor);
    }
  });

  // Let the AI take its turn automatically; also resolve its pending promote
  // if it was KO'd on the human's turn.
  useEffect(() => {
    if (preGameOpen) return;
    if (state.winner !== null) return;
    if (pendingHandoff) return; // freeze AI while waiting on hotseat handoff
    // Pause the AI while the user is inspecting something modal — zooming a
    // card, browsing a discard pile, or working in the deck-builder. The
    // useEffect re-runs when these flip back to false, picking up where the
    // AI left off without losing the in-flight delay timer.
    if (zoomCard || discardViewer || importOpen || buildOpen) return;
    // AI-won coin toss: auto-pick first/second after a short delay.
    if (
      state.phase === "coinFlip" &&
      state.coinFlip?.step === "chooseFirst" &&
      state.coinFlip.winner &&
      state.players[state.coinFlip.winner].isAI
    ) {
      const t = setTimeout(() => {
        resolveAiCoinChoice(state);
        rerender();
      }, 700);
      return () => clearTimeout(t);
    }
    // Opening setup: AI resolves its own side automatically.
    for (const pid of ["p1", "p2"] as PlayerId[]) {
      const pl = state.players[pid];
      if (state.phase === "setup" && !pl.setupComplete && pl.isAI) {
        const t = setTimeout(() => {
          resolveAiSetup(state, pid);
          rerender();
        }, 400);
        return () => clearTimeout(t);
      }
    }
    if (state.pendingPromote && state.players[state.pendingPromote].isAI) {
      const target = state.pendingPromote;
      const t = setTimeout(() => {
        resolveAiPendingPromote(state, target);
        rerender();
      }, 400);
      return () => clearTimeout(t);
    }
    // AI owes a switch pick (shouldn't fire normally since trainerEffects
    // auto-resolves for AI, but defensive safety net).
    if (state.pendingSwitchTarget && state.players[state.pendingSwitchTarget].isAI) {
      const target = state.pendingSwitchTarget;
      const t = setTimeout(() => {
        resolveSwitchTarget(state, target, 0);
        rerender();
      }, 300);
      return () => clearTimeout(t);
    }
    // The AI is "owed work" any time it's the active player and the engine
    // is in a state aiStep can resolve. With the synchronous takeAiTurn,
    // mid-turn pendingPick / pendingHandReveal / pendingSearchNotice were
    // resolved inside the same call — but now we yield to React between
    // steps, so phase transitions like main → pick mid-Ultra-Ball would
    // freeze the AI. We trigger on any of those resolvable states.
    const aiHasPickWork =
      state.players[state.activePlayer].isAI &&
      ((state.pendingPick && state.pendingPick.player === state.activePlayer) ||
        (state.pendingHandReveal && state.pendingHandReveal.player === state.activePlayer) ||
        (state.pendingSearchNotice && state.pendingSearchNotice.player === state.activePlayer));
    const aiHasMainWork =
      state.phase === "main" && state.players[state.activePlayer].isAI;
    if (aiHasMainWork || aiHasPickWork) {
      const target = state.activePlayer;
      const delay = AI_STEP_DELAY_MS[aiSpeed];
      // Reset the safety counter when a new AI turn begins.
      const guard = aiStepCountRef.current;
      if (guard.turn !== state.turn || guard.player !== target) {
        guard.turn = state.turn;
        guard.player = target;
        guard.count = 0;
      }
      if (aiSpeed === "instant") {
        const t = setTimeout(() => {
          let safety = 60;
          while (safety-- > 0 && aiStep(state, target)) {
            // keep stepping
          }
          rerender();
        }, 0);
        return () => clearTimeout(t);
      }
      // Hard cap on step count per AI turn — guards against any pathological
      // case where aiStep keeps returning true without progress.
      if (guard.count > 80) {
        endTurn(state, target);
        rerender();
        return;
      }
      guard.count++;
      const t = setTimeout(() => {
        aiStep(state, target);
        rerender();
      }, delay);
      return () => clearTimeout(t);
    }
  });

  // Keyboard shortcuts:
  //   Esc  → close topmost dismissible modal (discard viewer, import)
  //   E    → end turn (if main phase + my turn + no blocking modal)
  //   1-9  → click hand card at that position
  //
  // Pattern: bind window listeners ONCE via a stable wrapper that defers to
  // a ref. Updating the ref each render keeps the closures fresh (no stale
  // state), without thrashing addEventListener/removeEventListener every
  // render. The previous version had no deps array, so it re-bound on
  // every CPU-step rerender.
  const keyHandlerRef = useRef<(ev: KeyboardEvent) => void>(() => {});
  const popHandlerRef = useRef<() => void>(() => {});
  keyHandlerRef.current = (ev: KeyboardEvent) => {
    // Never interfere with typing into inputs (decklist paste, deck name, etc.).
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (ev.key === "Escape") {
      if (zoomCard) { setZoomCard(null); ev.preventDefault(); return; }
      if (discardViewer) { setDiscardViewer(null); ev.preventDefault(); return; }
      if (importOpen) { setImportOpen(false); ev.preventDefault(); return; }
      if (buildOpen) { setBuildOpen(false); ev.preventDefault(); return; }
      return;
    }
    if (
      preGameOpen ||
      pendingHandoff ||
      state.pendingPick ||
      state.pendingHandReveal ||
      discardViewer ||
      importOpen ||
      buildOpen ||
      state.phase === "coinFlip" ||
      (state.phase === "setup" && !state.players[viewingPlayer].setupComplete) ||
      state.phase === "promoteActive" ||
      state.winner !== null
    ) return;
    if (state.phase !== "main") return;
    if (state.activePlayer !== viewingPlayer) return;
    if (ev.key === "e" || ev.key === "E") {
      onEndTurn();
      ev.preventDefault();
    } else if (/^[1-9]$/.test(ev.key)) {
      const idx = parseInt(ev.key, 10) - 1;
      if (idx < me.hand.length) {
        onHandClick(idx);
        ev.preventDefault();
      }
    }
  };
  popHandlerRef.current = () => {
    if (zoomCard) { setZoomCard(null); return; }
    if (discardViewer) { setDiscardViewer(null); return; }
    if (importOpen) { setImportOpen(false); return; }
    if (buildOpen) { setBuildOpen(false); return; }
  };
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => keyHandlerRef.current(ev);
    const onPop = () => popHandlerRef.current();
    window.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onPop);
    };
  }, []);

  // Push a history entry whenever a dismissible modal opens, so Android's
  // hardware/gesture back button lands on a popstate event (handled above)
  // rather than leaving the page entirely. The sentinel state is just a
  // marker — we never read it back. Closing the modal via Esc/click triggers
  // a normal `history.back()` so the entry doesn't accumulate.
  useEffect(() => {
    const anyModalOpen = !!(zoomCard || discardViewer || importOpen || buildOpen);
    if (!anyModalOpen) return;
    history.pushState({ tcgModal: true }, "");
  }, [zoomCard, discardViewer, importOpen, buildOpen]);

  const handle = (r: ActionResult, successMsg?: string) => {
    if (!r.ok) setStatusMsg(r.reason);
    else {
      setStatusMsg(successMsg ?? "");
      // Subtle haptic on a successful action — only on devices that support
      // the Vibration API (Android Chrome, some Android browsers; silent
      // no-op on iOS Safari, which is fine).
      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        navigator.vibrate(12);
      }
    }
    setSelected(null);
    rerender();
  };

  const promoteOpen = state.pendingPromote === viewingPlayer;

  const onHandClick = (i: number) => {
    // TERMINAL pendingPromote (attack-KO / checkup-KO) sets phase to
    // "promoteActive" — the engine itself blocks all main actions until
    // the player promotes. We surface a hint and bail.
    //
    // NON-terminal pendingPromote (e.g. Run Away Draw shuffling the active
    // away, Adrena-Brain KOing opp's active) leaves phase as "main" so the
    // player can keep playing Items / attach Energy / evolve / etc. before
    // choosing the new Active. We DON'T return here — the click should
    // proceed normally.
    if (promoteOpen && state.phase === "promoteActive") {
      setStatusMsg("Pick a Benched Pokémon to promote to Active.");
      return;
    }
    if (state.pendingInPlayTarget?.player === viewingPlayer) {
      setStatusMsg("Resolve the target picker first (or cancel).");
      return;
    }
    if (state.pendingHandReveal?.player === viewingPlayer) {
      setStatusMsg("Resolve the hand-reveal first (or cancel).");
      return;
    }
    // Rare Candy Stage-2 chooser: clicking an eligible Stage 2 resolves it.
    if (state.pendingRareCandyChoice?.player === viewingPlayer) {
      const r = resolveRareCandyChoice(state, viewingPlayer, i);
      if (!r.ok) setStatusMsg(r.reason ?? "Pick a matching Stage 2 from your hand.");
      else setStatusMsg("Rare Candy evolved.");
      rerender();
      return;
    }
    // A pendingPick (deck-search picker, top-peek, etc.) makes phase="pick"
    // so myTurn would be false and the click would silently no-op. Surface
    // an explicit hint instead.
    if (state.pendingPick?.player === viewingPlayer) {
      setStatusMsg("Resolve the pick modal first (Skip / Confirm) before playing more cards.");
      return;
    }
    if (state.pendingSearchNotice?.player === viewingPlayer) {
      setStatusMsg("Acknowledge the search notice first.");
      return;
    }
    // Read myTurn from LIVE state, not the captured `myTurn` closure value.
    // CardView's onClick is a closure preserved by my memo across re-renders,
    // so a captured `myTurn` from an earlier render can be stale (e.g.,
    // false from when it was the AI's turn) even after activePlayer flips
    // back to the user. stateRef-backed reads always see the current values.
    const liveMyTurn =
      state.activePlayer === viewingPlayer && state.phase === "main";
    if (!liveMyTurn) {
      if (state.activePlayer !== viewingPlayer) {
        setStatusMsg(`Wait — it's ${state.players[state.activePlayer].name}'s turn.`);
      } else {
        setStatusMsg(`Action paused (phase: ${state.phase}). Resolve any open prompt first.`);
      }
      return;
    }
    const card = me.hand[i];
    if (!card) return;

    if (selected?.kind === "hand" && selected.index === i) {
      setSelected(null);
      return;
    }

    if (isPokemon(card) && isBasic(card)) {
      snapshotForUndo(`play ${card.name} to bench`);
      handle(playBasicToBench(state, viewingPlayer, i), `Played ${card.name} to bench.`);
      return;
    }
    if (card.supertype === "Trainer") {
      const isTool =
        card.subtypes.includes("Pokémon Tool") || card.subtypes.includes("Tool");
      const isRareCandy = card.effectId === "rareCandyEvolve";
      const needsTarget =
        isTool ||
        card.effectId === "gustOppBenched" ||
        isRareCandy;
      if (needsTarget) {
        setSelected({ kind: "hand", index: i });
        setStatusMsg(
          isRareCandy
          ? "Select a Basic Pokémon in play to evolve with Rare Candy."
          : isTool
            ? "Select one of your Pokémon to attach the Tool."
            : `Select target for ${card.name}.`,
        );
        return;
      }
      snapshotForUndo(`play ${card.name}`);
      handle(playTrainer(state, viewingPlayer, i), `Played ${card.name}.`);
      return;
    }
    setSelected({ kind: "hand", index: i });
    setStatusMsg(
      card.supertype === "Energy"
        ? "Select a Pokémon in play to attach to."
        : "Select the Pokémon to evolve.",
    );
  };

  const onInPlayClick = (p: PokemonInPlay, side: "me" | "opp") => {
    // Pending in-play target prompt (Enhanced Hammer, Crushing Hammer, Tool
    // Scrapper, Scoop Up Cyclone, etc.) — resolve it by clicking a Pokémon.
    if (state.pendingInPlayTarget?.player === viewingPlayer) {
      const targetOwner: PlayerId = side === "me" ? viewingPlayer : (viewingPlayer === "p1" ? "p2" : "p1");
      const r = resolveInPlayTarget(state, viewingPlayer, targetOwner, p.instanceId);
      if (!r.ok) setStatusMsg(r.reason ?? "");
      else setStatusMsg(`Targeted ${p.card.name}.`);
      rerender();
      return;
    }
    // Pending Switch item — user clicks their own bench to pick the promoter.
    if (state.pendingSwitchTarget === viewingPlayer) {
      if (side !== "me") {
        setStatusMsg("Click one of YOUR Benched Pokémon to switch in.");
        return;
      }
      const benchIdx = me.bench.findIndex((b) => b.instanceId === p.instanceId);
      if (benchIdx < 0) {
        // Clicked the Active — that's the Pokémon that's switching OUT.
        // The picker wants the new Active, which lives on the bench.
        setStatusMsg("Click a Benched Pokémon (not the Active) to switch in.");
        return;
      }
      const r = resolveSwitchTarget(state, viewingPlayer, benchIdx);
      if (!r.ok) setStatusMsg(r.reason ?? "");
      else setStatusMsg(`Switched in ${p.card.name}.`);
      rerender();
      return;
    }
    if (promoteOpen && side === "me") {
      const benchIdx = me.bench.findIndex((b) => b.instanceId === p.instanceId);
      if (benchIdx >= 0) {
        handle(
          promoteBenchToActive(state, viewingPlayer, benchIdx),
          `Promoted ${p.card.name}.`,
        );
      }
      return;
    }
    if (!myTurn) return;
    if (selected?.kind === "hand") {
      const card = me.hand[selected.index];
      if (!card) return;
      if (card.supertype === "Energy" && side === "me") {
        snapshotForUndo(`attach ${card.name} to ${p.card.name}`);
        handle(attachEnergy(state, viewingPlayer, selected.index, p.instanceId), `Attached ${card.name}.`);
        return;
      }
      if (card.supertype === "Pokémon" && card.evolvesFrom && side === "me") {
        snapshotForUndo(`evolve ${p.card.name} → ${card.name}`);
        handle(evolve(state, viewingPlayer, selected.index, p.instanceId), `Evolved into ${card.name}.`);
        return;
      }
      if (card.supertype === "Trainer") {
        const isTool =
          card.subtypes.includes("Pokémon Tool") || card.subtypes.includes("Tool");
        if (isTool && side === "me") {
          const target: TrainerTarget = { kind: "inPlay", instanceId: p.instanceId };
          snapshotForUndo(`attach ${card.name} to ${p.card.name}`);
          handle(
            playTrainer(state, viewingPlayer, selected.index, target),
            `Attached ${card.name} to ${p.card.name}.`,
          );
          return;
        }
        if (card.effectId === "gustOppBenched" && side === "opp") {
          const target: TrainerTarget = { kind: "oppInPlay", instanceId: p.instanceId };
          snapshotForUndo(`play ${card.name} on ${p.card.name}`);
          handle(
            playTrainer(state, viewingPlayer, selected.index, target),
            `Played ${card.name}.`,
          );
          return;
        }
        if (card.effectId === "rareCandyEvolve" && side === "me") {
          const target: TrainerTarget = { kind: "inPlay", instanceId: p.instanceId };
          snapshotForUndo(`Rare Candy ${p.card.name}`);
          handle(
            playTrainer(state, viewingPlayer, selected.index, target),
            `Used Rare Candy on ${p.card.name}.`,
          );
          return;
        }
      }
    }
    setSelected({ kind: "inPlay", instanceId: p.instanceId });
  };

  // ------- Drag-and-drop: hand → in-play -----------------------------------
  // Click flow above (`onInPlayClick`) stays the source of truth for legality
  // gates and undo labels. Drag is a thin layer that pre-populates `selected`
  // (so `legalTargets` lights up the same way it does mid-click) and, on
  // pointerup, calls into the same engine routes the click handler does.

  const dispatchHandToInPlay = (
    handIndex: number,
    target:
      | { kind: "inPlay"; instanceId: string }
      | { kind: "bench-empty" },
  ): void => {
    const card = me.hand[handIndex];
    if (!card) return;

    if (target.kind === "bench-empty") {
      if (isPokemon(card) && isBasic(card)) {
        snapshotForUndo(`play ${card.name} to bench`);
        handle(
          playBasicToBench(state, viewingPlayer, handIndex),
          `Played ${card.name} to bench.`,
        );
      }
      return;
    }

    const { instanceId } = target;
    if (card.supertype === "Energy") {
      snapshotForUndo(`attach ${card.name}`);
      handle(
        attachEnergy(state, viewingPlayer, handIndex, instanceId),
        `Attached ${card.name}.`,
      );
      return;
    }
    if (card.supertype === "Pokémon" && card.evolvesFrom) {
      snapshotForUndo(`evolve → ${card.name}`);
      handle(
        evolve(state, viewingPlayer, handIndex, instanceId),
        `Evolved into ${card.name}.`,
      );
      return;
    }
    if (card.supertype === "Trainer") {
      const isTool =
        card.subtypes.includes("Pokémon Tool") ||
        card.subtypes.includes("Tool");
      if (isTool) {
        snapshotForUndo(`attach ${card.name}`);
        handle(
          playTrainer(state, viewingPlayer, handIndex, {
            kind: "inPlay",
            instanceId,
          }),
          `Attached ${card.name}.`,
        );
      }
    }
  };

  // Hit-test what the pointer is over, walking up to the nearest
  // [data-droptarget] ancestor. The ghost has pointer-events: none so the
  // element under the cursor is always the actual drop candidate, not the
  // floating preview.
  const dropTargetUnderPoint = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const target = (el as Element).closest("[data-droptarget]");
    return target?.getAttribute("data-droptarget") ?? null;
  };

  // True when `targetId` represents a legal drop for the currently dragged
  // card. Reuses the same legality data the click flow uses for highlighting.
  const isLegalDropTarget = (targetId: string, handIndex: number): boolean => {
    const card = me.hand[handIndex];
    if (!card) return false;
    if (targetId === "my:bench:empty") {
      return isPokemon(card) && isBasic(card) && me.bench.length < 5;
    }
    const m = targetId.match(/^my:inPlay:(.+)$/);
    if (!m) return false;
    return legalTargets.own.has(m[1]);
  };

  const onHandDragStart = (
    i: number,
    ev: ReactPointerEvent<HTMLElement>,
  ) => {
    if (!myTurn) return;
    const card = me.hand[i];
    if (!card) return;
    // Pre-populate `selected` so the existing legalTargets memo lights up
    // legal drop targets without duplicating its logic.
    setSelected({ kind: "hand", index: i });
    setDragging({
      handIndex: i,
      card,
      x: ev.clientX,
      y: ev.clientY,
      hoverTargetId: null,
    });
  };

  const onHandDragMove = (ev: ReactPointerEvent<HTMLElement>) => {
    if (dragRafRef.current !== null) return;
    const x = ev.clientX;
    const y = ev.clientY;
    dragRafRef.current = requestAnimationFrame(() => {
      dragRafRef.current = null;
      setDragging((prev) => {
        if (!prev) return prev;
        const tid = dropTargetUnderPoint(x, y);
        const legal = tid && isLegalDropTarget(tid, prev.handIndex) ? tid : null;
        return { ...prev, x, y, hoverTargetId: legal };
      });
    });
  };

  const onHandDragEnd = (ev: ReactPointerEvent<HTMLElement>) => {
    if (dragRafRef.current !== null) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
    }
    const drag = dragging;
    setDragging(null);
    if (!drag) return;
    const tid = dropTargetUnderPoint(ev.clientX, ev.clientY);
    if (!tid || !isLegalDropTarget(tid, drag.handIndex)) {
      // Clear the drag-time auto-selection so the player isn't left with a
      // mid-flow status hint after a snap-back.
      setSelected(null);
      return;
    }
    if (tid === "my:bench:empty") {
      dispatchHandToInPlay(drag.handIndex, { kind: "bench-empty" });
    } else {
      const m = tid.match(/^my:inPlay:(.+)$/);
      if (m) {
        dispatchHandToInPlay(drag.handIndex, {
          kind: "inPlay",
          instanceId: m[1],
        });
      }
    }
  };

  const onActivateAbility = (p: PokemonInPlay, abilityIndex: number) => {
    if (!myTurn) return;
    const abName = p.card.abilities?.[abilityIndex]?.name ?? "ability";
    snapshotForUndo(`activate ${abName}`);
    const r = activateAbility(state, viewingPlayer, p.instanceId, abilityIndex);
    handle(
      r.ok ? { ok: true } : { ok: false, reason: r.reason ?? "Cannot activate." },
      r.ok ? `Activated ${p.card.abilities![abilityIndex].name}.` : undefined,
    );
  };

  // Attack is the commit point — once it succeeds, side effects (damage, KOs,
  // prizes, opp's response turn) make pre-attack actions irreversible. Lock
  // the undo stack so the player can't accidentally roll back earlier plays
  // (attach energy, evolve) while a post-attack picker like Phantom Dive's
  // bench-distribute is still open. Failed attacks (insufficient energy etc.)
  // leave the stack intact so the player can still undo what came before.
  const lockUndoAfterAttack = () => {
    undoStackRef.current = [];
    setCanUndo(false);
  };

  const onAttack = (atkIndex: number) => {
    if (!myTurn) return;
    // If the attack carries a snipeOne effect with multiple candidate targets,
    // pause first so the user can pick. benchOnly attacks need bench.length > 1;
    // free-pick (Cruel Arrow style) needs (Active ? 1 : 0) + bench.length > 1
    // since Active is also a valid target.
    const move = me.active?.card.attacks[atkIndex];
    const snipe = move ? getAttackEffects(move).find((e) => e.kind === "snipeOne") : undefined;
    if (snipe && snipe.kind === "snipeOne") {
      const benchOnly = !!snipe.benchOnly;
      const candidateCount = (benchOnly ? 0 : (opp.active ? 1 : 0)) + opp.bench.length;
      const needsPick = benchOnly ? opp.bench.length > 1 : candidateCount > 1;
      if (needsPick) {
        setPendingSnipeAttack(atkIndex);
        return;
      }
    }
    const r = attack(state, viewingPlayer, atkIndex);
    if (r.ok) lockUndoAfterAttack();
    handle(r);
  };

  // benchIdx convention:
  //   null  → auto (engine default: most-damaged bench for benchOnly, Active
  //                  for free-pick when opp.active exists)
  //   >= 0  → opponent's bench index
  //   -1    → explicit "target opponent's Active" (free-pick mode only —
  //           engine treats negative override as the default branch, which
  //           for free-pick prefers Active)
  const commitSnipeAttack = (benchIdx: number | null) => {
    if (pendingSnipeAttack === null) return;
    state.snipeTargetOverride = benchIdx;
    const atk = pendingSnipeAttack;
    setPendingSnipeAttack(null);
    const r = attack(state, viewingPlayer, atk);
    if (r.ok) lockUndoAfterAttack();
    handle(r);
  };

  const onRetreat = (benchIdx: number) => {
    if (!myTurn) return;
    const promoter = me.bench[benchIdx];
    snapshotForUndo(`retreat to ${promoter?.card.name ?? "bench"}`);
    handle(retreat(state, viewingPlayer, benchIdx), "Retreated.");
  };

  const [endTurnConfirm, setEndTurnConfirm] = useState<string[] | null>(null);

  const onEndTurn = () => {
    if (!myTurn) return;
    const warns = unspentTurnSlots(state, viewingPlayer);
    if (warns.length > 0) {
      setEndTurnConfirm(warns);
      return;
    }
    handle(endTurn(state, viewingPlayer), "Turn ended.");
  };
  const confirmEndTurn = () => {
    setEndTurnConfirm(null);
    handle(endTurn(state, viewingPlayer), "Turn ended.");
  };
  const cancelEndTurn = () => setEndTurnConfirm(null);

  const onReset = () => {
    rngRef.current = makeRng(Date.now());
    const fallback = buildDeck(deckSpecs[0]);
    // Resolve random opp deck once so we can both build the deck and surface
    // the chosen name in the CPU's banner / log.
    const resolvedOppId = resolveDeckId(oppDeckId);
    const myDeck = deckForId(myDeckId, fallback);
    const oppSpec = deckSpecs.find((d) => d.id === resolvedOppId);
    const oppDeck = oppSpec
      ? buildDeck(oppSpec)
      : deckForId(resolvedOppId, fallback);
    const cpuName =
      gameMode === "vsCPU" && oppDeckId === "__random__" && oppSpec
        ? `CPU (${oppSpec.name})`
        : gameMode === "local"
          ? "Player 2"
          : "CPU";
    stateRef.current = setupGame(myDeck, oppDeck, rngRef.current, {
      p1Name: gameMode === "local" ? "Player 1" : "You",
      p2Name: cpuName,
      p2IsAI: gameMode !== "local",
    });
    // Reset hotseat state: p1 holds the device first; no handoff pending.
    setViewingPlayer("p1");
    setPendingHandoff(null);
    setSelected(null);
    setStatusMsg("");
    setMulliganNoticeDismissed(false);
    rerender();
  };

  // Memoized on a coarse render epoch (state.log.length advances on every
  // logged action). The previous "don't memoize" comment was about evolution
  // mutating PokemonInPlay.card — covered here by including
  // me.active?.card so the dep changes when the card reference is swapped.
  const myActiveAttacks = useMemo(() => {
    if (!me.active) return [];
    // Use the ability-aware pool so abilities like Meganium's Wild Growth
    // (each Basic Grass = 2 Grass) are honored when computing payability.
    const provided = energyPoolForCost(me.active, state);
    return effectiveAttacks(me.active).map((a, i) => {
      // Mirror the engine's full pre-attack legality check so the button
      // disables + tooltips the reason. attackPreflight is the same gate
      // attack() runs internally — single source of truth, can't drift.
      const pre = attackPreflight(state, viewingPlayer, i);
      const blockedReason = pre.ok ? null : pre.reason;
      // payable must use the EFFECTIVE attack cost (which reflects tools like
      // Hop's Choice Band reducing 1 Colorless, ability-driven discounts like
      // Bloodmoon Ursaluna ex Seasoned Skill, etc.). Using raw `a.cost` here
      // would disable the attack button when the engine actually considers
      // the attack legal — preflight uses effective cost via attackPreflight.
      const effectiveCost = effectiveAttackCost(state, me.active!, a.cost, a.name);
      return {
        index: i,
        name: a.name,
        damage: a.damage,
        damageText: a.damageText,
        cost: effectiveCost,
        payable: canPayCost(provided, effectiveCost),
        blockedReason,
        estimated: estimateAttackDamage(state, viewingPlayer, me.active!, a),
      };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.active, me.active?.card, state.log.length, state.turn, viewingPlayer]);

  // Derive a location label ("Active", "Bench 1", "Bench 2"…) per Pokémon
  // so the ability button can disambiguate multiple copies of the same card
  // in play (e.g. two Teal Mask Ogerpon ex, each with its own Teal Dance).
  const locationOf = (p: PokemonInPlay): string => {
    if (me.active?.instanceId === p.instanceId) return "Active";
    const idx = me.bench.findIndex((b) => b.instanceId === p.instanceId);
    return idx >= 0 ? `Bench ${idx + 1}` : "";
  };
  const activatableAbilities = useMemo(
    () =>
      [me.active, ...me.bench]
        .filter((p): p is PokemonInPlay => !!p)
        .flatMap((p) =>
          (p.card.abilities ?? [])
            .map((a, i) => ({ p, a, i, location: locationOf(p) }))
            .filter(({ a, p }) => a.effect && !p.abilityUsedThisTurn),
        ),
    // log.length advances each action, picking up p.abilityUsedThisTurn flips
    // and per-Pokémon card swaps from evolve.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [me.active, me.active?.card, me.bench, state.log.length, state.turn],
  );

  const inspected = useMemo(() => {
    if (selected?.kind === "hand") {
      const card = me.hand[selected.index];
      if (card) {
        return {
          kind: "hand" as const,
          card,
          label: `Hand ${selected.index + 1}`,
          pokemon: null,
          owner: viewingPlayer,
        };
      }
    }
    if (selected?.kind === "inPlay") {
      const sides: Array<{ owner: PlayerId; label: string; pokemon: PokemonInPlay | null }> = [
        { owner: viewingPlayer, label: "Your Active", pokemon: me.active },
        ...me.bench.map((pokemon, i) => ({ owner: viewingPlayer, label: `Your Bench ${i + 1}`, pokemon })),
        { owner: opp.id, label: `${opp.name} Active`, pokemon: opp.active },
        ...opp.bench.map((pokemon, i) => ({ owner: opp.id, label: `${opp.name} Bench ${i + 1}`, pokemon })),
      ];
      const found = sides.find((s) => s.pokemon?.instanceId === selected.instanceId);
      if (found?.pokemon) {
        return {
          kind: "inPlay" as const,
          card: found.pokemon.card,
          label: found.label,
          pokemon: found.pokemon,
          owner: found.owner,
        };
      }
    }
    if (me.active) {
      return {
        kind: "inPlay" as const,
        card: me.active.card,
        label: "Your Active",
        pokemon: me.active,
        owner: viewingPlayer,
      };
    }
    return null;
  }, [selected, me.hand, me.active, me.bench, opp.id, opp.name, opp.active, opp.bench, viewingPlayer]);

  // Legal-target highlighting — when a card is selected in hand, compute the
  // set of Pokémon instance-ids that would be a legal drop target and pass
  // that down to the rendered boards so they can light up accordingly.
  // Memoized: this re-runs only when the user changes selection, hovers an
  // ability source, the engine logs an action, or a pending in-play target
  // appears — not on every unrelated rerender (CPU-turn ticks, etc.).
  const legalTargets = useMemo(() => {
    const own = new Set<string>();
    const opp_ = new Set<string>();
    let benchHint = false; // highlight player's empty bench slots (Basic play)
    if (selected?.kind !== "hand") return { own, opp: opp_, benchHint };
    const card = me.hand[selected.index];
    if (!card) return { own, opp: opp_, benchHint };
    const myAllies = [me.active, ...me.bench].filter((p): p is PokemonInPlay => !!p);
    const oppAllies = [opp.active, ...opp.bench].filter((p): p is PokemonInPlay => !!p);

    if (isPokemon(card)) {
      if (isBasic(card) && state.phase === "main") {
        // Playing a Basic goes to a free bench slot.
        benchHint = me.bench.length < 5;
      } else if (card.evolvesFrom) {
        // Evolution — target Pokémon whose current card name matches evolvesFrom
        // and haven't been played / evolved this turn. Turn 1 never allows evolve.
        if (state.turn > 1) {
          for (const p of myAllies) {
            if (p.card.name !== card.evolvesFrom) continue;
            if (p.playedThisTurn || p.evolvedThisTurn) continue;
            own.add(p.instanceId);
          }
        }
      }
    } else if (card.supertype === "Energy") {
      // Any of your Pokémon can accept an Energy attach (TRE has its own
      // attach-time gate, but we highlight all and let the action handler
      // fail gracefully if the specific rule trips).
      if (!me.energyAttachedThisTurn) {
        for (const p of myAllies) own.add(p.instanceId);
      }
    } else if (card.supertype === "Trainer") {
      const isTool =
        card.subtypes.includes("Pokémon Tool") || card.subtypes.includes("Tool");
      const eid = card.effectId;
      if (isTool) {
        for (const p of myAllies) {
          if ((p.tools?.length ?? 0) === 0) own.add(p.instanceId);
        }
      } else if (eid === "rareCandyEvolve") {
        // Your Basics that have a matching Stage 2 in hand, not played this turn.
        for (const p of myAllies) {
          if (!p.card.subtypes.includes("Basic")) continue;
          if (p.playedThisTurn) continue;
          const hasStage2 = me.hand.some(
            (c) =>
              c.supertype === "Pokémon" &&
              c.subtypes.includes("Stage 2") &&
              !!c.evolvesFrom &&
              (() => {
                const s1 = (c as Card & { evolvesFrom?: string }).evolvesFrom;
                if (!s1) return false;
                // Need the Stage 1 to evolve from this basic's name.
                const byName = state as unknown; void byName;
                // Simpler: card dataset has the Stage 1 definition.
                return true; // let the action precheck do the strict check
              })(),
          );
          if (hasStage2) own.add(p.instanceId);
        }
      } else if (eid === "gustOppBenched" || eid === "flipGustOppBenched") {
        for (const p of opp.bench) opp_.add(p.instanceId);
      } else if (eid === "gustConfuseOppBasic") {
        for (const p of opp.bench) {
          if (p.card.subtypes.includes("Basic")) opp_.add(p.instanceId);
        }
      } else if (eid === "enhancedHammer") {
        for (const p of oppAllies) {
          if (p.attachedEnergy.some((e) => e.subtypes.includes("Special"))) {
            opp_.add(p.instanceId);
          }
        }
      } else if (eid === "crushingHammer") {
        for (const p of oppAllies) {
          if (p.attachedEnergy.length > 0) opp_.add(p.instanceId);
        }
      } else if (eid === "toolScrapper") {
        for (const p of myAllies) if (p.tools.length > 0) own.add(p.instanceId);
        for (const p of oppAllies) if (p.tools.length > 0) opp_.add(p.instanceId);
      } else if (eid === "scoopUpCyclone") {
        for (const p of me.bench) own.add(p.instanceId);
      } else if (eid === "energySwitchOwn") {
        // Source phase: highlight own Pokémon with basic Energy.
        for (const p of myAllies) {
          if (p.attachedEnergy.some((e) => e.subtypes.includes("Basic"))) {
            own.add(p.instanceId);
          }
        }
      } else if (eid === "moveBenchEnergyToActive") {
        for (const p of me.bench) {
          if (p.attachedEnergy.length > 0) own.add(p.instanceId);
        }
      } else if (eid === "healMegaExAndEnergyToHand") {
        for (const p of myAllies) {
          const subs = p.card.subtypes ?? [];
          const isMegaEx =
            subs.some((s) => /^MEGA$/i.test(s) || /^Mega /.test(s)) &&
            subs.includes("ex");
          if (isMegaEx && p.damage > 0) own.add(p.instanceId);
        }
      }
    }

    // Hovering an ability button glows the source Pokémon so duplicates are
    // distinguishable at a glance.
    if (hoveredAbilitySource) own.add(hoveredAbilitySource);

    // Active in-play target prompt (post-play picker for Wally's, Jacinthe,
    // Wondrous Patch, Poké Vital A, Energy Switch, etc.) — light up the
    // legal targets so the player can see where to click.
    const pip = state.pendingInPlayTarget;
    if (pip && pip.player === viewingPlayer) {
      const slotOk = (_p: PokemonInPlay, fromActive: boolean): boolean => {
        if (pip.slot === "active") return fromActive;
        if (pip.slot === "bench") return !fromActive;
        return true;
      };
      const consider = (p: PokemonInPlay, fromActive: boolean, isOpp: boolean) => {
        if (pip.scope === "own" && isOpp) return;
        if (pip.scope === "opp" && !isOpp) return;
        if (!slotOk(p, fromActive)) return;
        let pass = true;
        switch (pip.action.kind) {
          case "jacintheHeal":
            pass = p.card.types.includes("Psychic") && p.damage > 0; break;
          case "pokeVitalAHeal":
            pass = p.damage > 0; break;
          case "wondrousPatchAttach":
            pass = p.card.types.includes("Psychic"); break;
          case "wallysCompassion": {
            const subs = p.card.subtypes ?? [];
            const isMegaEx =
              subs.some((s) => /^MEGA$/i.test(s) || /^Mega /.test(s)) &&
              subs.includes("ex");
            pass = isMegaEx && p.damage > 0;
            break;
          }
          // Other action kinds already have handlers; default to highlighting
          // any matching slot/scope so the user knows the picker is open.
          default:
            pass = true;
        }
        if (!pass) return;
        if (isOpp) opp_.add(p.instanceId);
        else own.add(p.instanceId);
      };
      if (me.active) consider(me.active, true, false);
      for (const p of me.bench) consider(p, false, false);
      if (opp.active) consider(opp.active, true, true);
      for (const p of opp.bench) consider(p, false, true);
    }

    // Pending Switch (Item) — highlight own bench so the user knows what's
    // clickable. Without this hint, the prompt's "Click a Benched Pokémon"
    // text is the only cue and easy to overlook.
    if (state.pendingSwitchTarget === viewingPlayer) {
      for (const p of me.bench) own.add(p.instanceId);
    }

    return { own, opp: opp_, benchHint };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selected,
    hoveredAbilitySource,
    state.log.length,
    state.turn,
    state.phase,
    state.pendingInPlayTarget,
    me.hand,
    me.active,
    me.bench,
    me.energyAttachedThisTurn,
    opp.active,
    opp.bench,
    viewingPlayer,
  ]);

  return (
    <div className={`app${dragging ? " drag-active" : ""}`}>
      {/* ------------------------- Header ------------------------- */}
      <div className="header">
        <div className="brand">
          <h1>PandaBananasTCG</h1>
          <div className="meta">
            T{state.turn} · {state.players[state.activePlayer].name} · {state.phase}
            <span className="dataset"> · {datasetFormat} {datasetAsOf}</span>
          </div>
        </div>
        {!preGameOpen && state.phase === "main" && state.winner === null && (
          <div
            className={`turn-indicator ${
              state.activePlayer === viewingPlayer ? "yours" : "theirs"
            }`}
          >
            <span className="turn-label">
              {state.activePlayer === viewingPlayer
                ? "YOUR TURN"
                : `${state.players[state.activePlayer].name.toUpperCase()}'S TURN`}
            </span>
            <span className="turn-meta">Turn {state.turn}</span>
          </div>
        )}
        <div className="controls-row">
          {preGameOpen && (
            <>
              <label className="field">
                You
                <DeckSelect
                  value={myDeckId}
                  onChange={setMyDeckId}
                  specs={deckSpecs}
                  imports={imports}
                />
              </label>
              <label className="field">
                Opponent
                <DeckSelect
                  value={oppDeckId}
                  onChange={setOppDeckId}
                  specs={deckSpecs}
                  imports={imports}
                />
              </label>
            </>
          )}
          <label className="toggle">
            <input
              type="checkbox"
              checked={openHands}
              onChange={(e) => setOpenHands(e.target.checked)}
            />
            Open hands
          </label>
          <label className="field" title="How fast the CPU plays its turn">
            CPU Speed
            <select
              value={aiSpeed}
              onChange={(e) => setAiSpeed(e.target.value as AiSpeed)}
            >
              <option value="instant">Instant</option>
              <option value="fast">Fast</option>
              <option value="normal">Normal</option>
              <option value="slow">Slow</option>
            </select>
          </label>
          <details className="game-menu">
            <summary>Game</summary>
            <div className="game-menu-panel">
              <button className="secondary" onClick={() => setBuildOpen(true)}>Build Deck</button>
              <button className="secondary" onClick={() => setImportOpen(true)}>Import Deck</button>
              <button className="secondary" onClick={() => setPreGameOpen(true)}>Change Decks</button>
              <button className="secondary" onClick={onExportLog} title="Download this game's event log as JSON">
                Export Log
              </button>
            </div>
          </details>
          <button className="primary" onClick={onReset}>New Game</button>
        </div>
      </div>

      {preGameOpen && (
        <PreGameModal
          deckSpecs={deckSpecs}
          imports={imports}
          myDeckId={myDeckId}
          oppDeckId={oppDeckId}
          openHands={openHands}
          gameMode={gameMode}
          deckIssue={(id: string): string | null => {
            const fallback = buildDeck(deckSpecs[0]);
            // Random sentinel resolves to a preset; trust presets always validate.
            if (id === "__random__") return null;
            const deck = deckForId(id, fallback);
            return validateDeckForPlay(deck);
          }}
          onChangeMyDeck={setMyDeckId}
          onChangeOppDeck={setOppDeckId}
          onToggleOpenHands={setOpenHands}
          onChangeMode={(m) => {
            // Random-preset is a vs-CPU-only feature; if the user switches
            // to local, drop the sentinel back to a concrete preset.
            if (m === "local" && oppDeckId === "__random__") {
              setOppDeckId(deckSpecs[1]?.id ?? deckSpecs[0]?.id ?? "");
            }
            setGameMode(m);
          }}
          onOpenImport={() => setImportOpen(true)}
          onOpenBuild={() => setBuildOpen(true)}
          onStart={() => {
            onReset();
            setPreGameOpen(false);
          }}
        />
      )}

      {pendingHandoff && (
        <HandoffModal
          incomingPlayerName={state.players[pendingHandoff].name}
          onStart={() => {
            setViewingPlayer(pendingHandoff);
            setPendingHandoff(null);
            setSelected(null);
            setStatusMsg("");
          }}
        />
      )}

      {!preGameOpen && state.phase === "coinFlip" && state.coinFlip?.step === "pickGuess" && (
        <CoinFlipModal
          onGuess={(g) => {
            resolveCoinGuess(state, g);
            rerender();
          }}
        />
      )}

      {!preGameOpen &&
        !mulliganNoticeDismissed &&
        state.phase === "setup" &&
        !pendingHandoff &&
        (state.players.p1.mulligans > 0 || state.players.p2.mulligans > 0) &&
        !state.players[viewingPlayer].isAI && (
          <MulliganNoticeModal
            myName={me.name}
            oppName={opp.name}
            myMulligans={me.mulligans}
            oppMulligans={opp.mulligans}
            onContinue={() => setMulliganNoticeDismissed(true)}
          />
        )}

      {endTurnConfirm && (
        <EndTurnConfirmModal
          warnings={endTurnConfirm}
          onConfirm={confirmEndTurn}
          onCancel={cancelEndTurn}
        />
      )}

      {!preGameOpen &&
        state.phase === "coinFlip" &&
        state.coinFlip?.step === "chooseFirst" &&
        state.coinFlip.winner === viewingPlayer &&
        !state.players[state.coinFlip.winner].isAI &&
        !pendingHandoff && (
          <ChooseFirstModal
            result={state.coinFlip.result!}
            guess={state.coinFlip.guess!}
            winnerName={state.players[state.coinFlip.winner].name}
            onChoose={(first) => {
              chooseFirstPlayer(state, viewingPlayer, first);
              rerender();
            }}
          />
        )}

      {/* Only show the "CPU will choose" banner when an AI actually won.
          In local 2P, the other human wins and their own ChooseFirstModal
          comes up after the hand-off. */}
      {!preGameOpen &&
        state.phase === "coinFlip" &&
        state.coinFlip?.step === "chooseFirst" &&
        state.coinFlip.winner &&
        state.players[state.coinFlip.winner].isAI && (
          <CoinResultBanner
            result={state.coinFlip.result!}
            guess={state.coinFlip.guess!}
          />
        )}

      {!preGameOpen && state.phase === "setup" && !state.players[viewingPlayer].setupComplete && !state.players[viewingPlayer].isAI && !pendingHandoff && (
        <SetupModal
          hand={state.players[viewingPlayer].hand}
          mulligans={state.players[viewingPlayer].mulligans}
          onConfirm={(activeIdx, benchIdxs) => {
            const err = completeSetup(state, viewingPlayer, activeIdx, benchIdxs);
            if (err) setStatusMsg(err);
            rerender();
          }}
        />
      )}

      {discardViewer && (
        <DiscardViewerModal
          player={state.players[discardViewer]}
          onClose={() => setDiscardViewer(null)}
        />
      )}

      {zoomCard && (
        <CardZoomModal card={zoomCard} onClose={() => setZoomCard(null)} />
      )}

      {pendingSnipeAttack !== null && (() => {
        const move = me.active?.card.attacks[pendingSnipeAttack];
        const snipe = move ? getAttackEffects(move).find((e) => e.kind === "snipeOne") : undefined;
        const benchOnly = snipe?.kind === "snipeOne" ? !!snipe.benchOnly : true;
        return (
          <SnipeTargetModal
            bench={opp.bench}
            active={benchOnly ? null : opp.active}
            onPick={(idx) => commitSnipeAttack(idx)}
            onCancel={() => setPendingSnipeAttack(null)}
          />
        );
      })()}

      {state.pendingPick && state.pendingPick.player === viewingPlayer && (
        <PickModal
          pick={state.pendingPick}
          onResolve={(idx) => {
            const r = resolvePendingPick(state, viewingPlayer, idx);
            if (!r.ok) setStatusMsg(r.reason);
            rerender();
          }}
        />
      )}

      {state.pendingHandReveal && state.pendingHandReveal.player === viewingPlayer && (
        <HandRevealModal
          pending={state.pendingHandReveal}
          hand={state.players[state.pendingHandReveal.target].hand}
          onConfirm={(idxs) => {
            const r = resolveHandReveal(state, viewingPlayer, idxs);
            if (!r.ok) setStatusMsg(r.reason ?? "");
            rerender();
          }}
          onCancel={() => {
            cancelHandReveal(state);
            setStatusMsg("Hand reveal cancelled.");
            rerender();
          }}
        />
      )}

      {state.pendingSearchNotice && state.pendingSearchNotice.player === viewingPlayer && (
        <SearchNoticeModal
          message={state.pendingSearchNotice.message}
          onContinue={() => {
            resolvePendingSearchNotice(state, viewingPlayer);
            rerender();
          }}
        />
      )}

      {importOpen && (
        <ImportDeckModal
          existingNames={imports.map((d) => d.name)}
          savedDecks={imports}
          onDelete={(id) => {
            setImports((prev) => prev.filter((d) => d.id !== id));
            if (myDeckId === id) setMyDeckId(deckSpecs[0]?.id ?? "");
            if (oppDeckId === id) setOppDeckId(deckSpecs[0]?.id ?? "");
          }}
          onClose={() => setImportOpen(false)}
          onImport={(name, entries, deck, assignTo) => {
            const id = `imp-${Date.now()}`;
            setImports((prev) => [...prev, { id, name, entries, cards: deck }]);
            if (assignTo === "me" || assignTo === "both") setMyDeckId(id);
            if (assignTo === "opp" || assignTo === "both") setOppDeckId(id);
            setImportOpen(false);
          }}
        />
      )}

      {buildOpen && (
        <Suspense fallback={
          <div className="modal-backdrop">
            <div className="modal" style={{ maxWidth: 360, textAlign: "center" }}>
              <div className="muted" style={{ padding: 16 }}>Loading deck builder…</div>
            </div>
          </div>
        }>
          <DeckBuilderModal
            existingNames={imports.map((d) => d.name)}
            onClose={() => setBuildOpen(false)}
            onSave={(name, entries, deck, assignTo) => {
              const id = `bld-${Date.now()}`;
              setImports((prev) => [...prev, { id, name, entries, cards: deck }]);
              if (assignTo === "me" || assignTo === "both") setMyDeckId(id);
              if (assignTo === "opp" || assignTo === "both") setOppDeckId(id);
              setBuildOpen(false);
            }}
          />
        </Suspense>
      )}

      {/* --------------- Opponent hand strip (thin) --------------- */}
      <AiActionBanner
        state={state}
        active={
          !preGameOpen &&
          state.winner === null &&
          state.players[state.activePlayer].isAI &&
          (state.phase === "main" || state.phase === "pick") &&
          aiSpeed !== "instant"
        }
      />

      <div className="opp-strip">
        <span className="label">{opp.name}</span>
        <span className="badge">Hand {opp.hand.length}</span>
        <div className={`mini-hand${openHands ? " open" : ""}`}>
          {opp.hand.length === 0 && <span className="muted">—</span>}
          {opp.hand.map((c, i) =>
            openHands ? (
              <CardView key={`opp-${c.id}-${i}`} card={c} />
            ) : (
              <FaceDownCard key={`opp-${i}`} />
            ),
          )}
        </div>
      </div>

      {/* ------------------------- Board -------------------------- */}
      {/* Playmat layout (player's perspective, top-down):
           [opp back row: prizes | spacer | deck/discard/lz]
           [opp bench row]
           [opp active  ]
           [central stadium slot — shared]
           [my active   ]
           [my bench row]
           [my back row: prizes | spacer | deck/discard/lz]
         Prizes sit on the viewer's LEFT for both sides; deck/discard on
         the RIGHT. Bulbapedia and the official playmat place Prizes left
         of the play area and Deck/Discard on the opposite side. We keep
         both sides aligned visually (rather than rotating the opponent)
         so clicking and reading feel natural on a screen. */}
      <div className="game-layout">
        <div className="board">
          <PlayerSide
            state={state}
            label={opp.name}
            player={opp}
            isMe={false}
            selected={selected}
            legalTargets={legalTargets.opp}
            dropHoverId={null}
            onInPlayClick={(p) => onInPlayClick(p, "opp")}
            onViewDiscard={(pid) => setDiscardViewer(pid)}
          />
          <div className="stadium-slot" aria-label="Stadium zone">
            {state.stadium ? (
              <div className="stadium-card-wrap" title={state.stadium.card.text ?? ""}>
                <CardView card={state.stadium.card} />
                <div className="stadium-caption">
                  Stadium · {state.players[state.stadium.controller].name}
                </div>
              </div>
            ) : (
              <div className="stadium-empty">Stadium</div>
            )}
          </div>
          <PlayerSide
            state={state}
            label={me.name}
            player={me}
            isMe
            selected={selected}
            legalTargets={legalTargets.own}
            benchHint={legalTargets.benchHint}
            dropHoverId={dragging?.hoverTargetId ?? null}
            onInPlayClick={(p) => onInPlayClick(p, "me")}
            onViewDiscard={(pid) => setDiscardViewer(pid)}
          />
        </div>
        <GameInspector
          inspected={inspected}
          attacks={myActiveAttacks}
          log={state.log.slice(-14)}
          state={state}
        />
      </div>

      {/* -------------------- My hand ----------------------------- */}
      <div className="my-hand">
        <div className="my-hand-header">
          <span className="title">Hand ({me.hand.length})</span>
          <span className="hint">
            Basic → bench · Evo/Energy + target · Trainer plays
          </span>
        </div>
        <div className="my-hand-row">
          {me.hand.map((c: Card, i) => (
            <CardView
              key={`${c.id}-${i}`}
              card={c}
              selected={selected?.kind === "hand" && selected.index === i}
              onClick={() => onHandClick(i)}
              onDragStart={(ev) => onHandDragStart(i, ev)}
              onDragMove={onHandDragMove}
              onDragEnd={onHandDragEnd}
              dragging={dragging?.handIndex === i}
            />
          ))}
          {me.hand.length === 0 && <span className="muted">—</span>}
        </div>
      </div>

      {/* ------------------ Action bar (sticky) ------------------- */}
      <ActionBar
        myTurn={myTurn}
        promoteOpen={promoteOpen}
        terminalPromote={state.phase === "promoteActive"}
        statusMsg={
          state.pendingRareCandyChoice?.player === viewingPlayer
            ? "Click a Stage 2 in your hand to use with Rare Candy."
            : state.pendingInPlayTarget?.player === viewingPlayer
              ? formatPickerLabel(state.pendingInPlayTarget)
              : state.pendingSwitchTarget === viewingPlayer
                ? "Click a Benched Pokémon to promote to Active."
                : statusMsg
        }
        me={me}
        attacks={myActiveAttacks}
        activatable={activatableAbilities}
        stadiumButton={
          state.stadium &&
          stadiumHasActivatedEffect(state.stadium.card.name) &&
          !me.stadiumUsedThisTurn &&
          myTurn ? (
            <div className="group stadium">
              <div className="group-label">Stadium</div>
              <div className="group-buttons">
                <button
                  onClick={() => {
                    const r = useStadium(state, viewingPlayer);
                    if (!r.ok) setStatusMsg(r.reason);
                    else setStatusMsg(`Activated ${state.stadium!.card.name}.`);
                    rerender();
                  }}
                  title={state.stadium.card.text}
                >
                  Use {state.stadium.card.name}
                </button>
              </div>
            </div>
          ) : null
        }
        canUndo={canUndo}
        onUndo={onUndo}
        onAttack={onAttack}
        onRetreat={onRetreat}
        onEndTurn={onEndTurn}
        onActivateAbility={onActivateAbility}
        onHoverAbilitySource={setHoveredAbilitySource}
        pendingTargetActive={
          state.pendingInPlayTarget?.player === viewingPlayer ||
          state.pendingRareCandyChoice?.player === viewingPlayer
        }
        onCancelTarget={() => {
          if (state.pendingInPlayTarget?.player === viewingPlayer) cancelInPlayTarget(state);
          if (state.pendingRareCandyChoice?.player === viewingPlayer) cancelRareCandyChoice(state);
          rerender();
          setStatusMsg("Target cancelled.");
        }}
      />

      {state.winner && (
        <div className="winner">
          <div className="box">
            <h2>{state.players[state.winner].name} wins!</h2>
            <p className="muted" style={{ margin: "4px 0 14px", fontSize: 12 }}>
              {state.winner === viewingPlayer
                ? "Nice game."
                : "Tough one — try a different approach."}
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <button className="primary" onClick={onReset}>
                Rematch (same decks)
              </button>
              <button
                onClick={() => {
                  setPreGameOpen(true);
                }}
              >
                Change decks…
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Drag ghost — floats with the pointer during a hand → in-play drag.
          Rendered into document.body via portal so it isn't clipped by the
          hand strip's overflow or by any modal stacking context. */}
      {dragging &&
        createPortal(
          <div
            className="drag-ghost"
            style={{ left: dragging.x, top: dragging.y }}
            aria-hidden="true"
          >
            <CardView card={dragging.card} />
          </div>,
          document.body,
        )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// AiActionBanner — sticky banner that surfaces what the CPU is doing during
// its turn. Shows the most recent log entry attributed to the CPU player or
// to the system; turns invisible (but keeps DOM space) outside the AI's turn
// so the layout doesn't jump.
// -----------------------------------------------------------------------------
// Number of recent log entries to surface in the AI action stream. A single
// aiStep can emit a burst of entries (e.g. Ultra Ball: discard, discard, play,
// pending-search) — showing the tail lets the user follow the sequence
// instead of catching only the very last line before the next step renders.
const AI_BANNER_TAIL = 4;

// Append "(N left)" progress to multi-pick picker labels. The picker re-arms
// itself between clicks with `remaining` decremented, so showing the live
// count tells the player how many more clicks the effect will consume.
function formatPickerLabel(t: NonNullable<GameState["pendingInPlayTarget"]>): string {
  const a = t.action as { remaining?: number; counters?: number };
  const n = a.remaining ?? a.counters;
  if (typeof n === "number" && n > 0) {
    return `${t.label} — ${n} left`;
  }
  return t.label;
}

function AiActionBanner({
  state,
  active,
}: {
  state: GameState;
  active: boolean;
}) {
  const aiPlayer = state.activePlayer;
  // Memoize the tail-walk so unrelated rerenders (mouse hover on a card,
  // settings toggle) don't re-walk the log. Keyed on the values that can
  // actually change the tail.
  const tail = useMemo(() => {
    if (!active) return [];
    const out: { player: PlayerId | "system"; text: string }[] = [];
    for (let i = state.log.length - 1; i >= 0; i--) {
      const e = state.log[i];
      if (e.turn !== state.turn) break;
      if (e.player === aiPlayer || e.player === "system") {
        out.push({ player: e.player, text: e.text });
        if (out.length >= AI_BANNER_TAIL) break;
      }
    }
    out.reverse();
    return out;
  }, [active, state.log.length, state.turn, aiPlayer]);
  if (!active) return null;
  const aiName = state.players[aiPlayer].name;
  return (
    <div className="ai-banner" role="status" aria-live="polite">
      <span className="ai-banner-label">{aiName} is thinking…</span>
      {tail.length > 0 && (
        <div className="ai-banner-stream">
          {tail.map((e, i) => {
            const isLatest = i === tail.length - 1;
            return (
              <div
                key={`${state.log.length}-${i}`}
                className={`ai-banner-line ${e.player === aiPlayer ? "ai" : "sys"}${isLatest ? " latest" : ""}`}
              >
                {e.text}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// PlayerSide — renders one row of the board (stats column + play area).
// Controls have been hoisted out into ActionBar below.
// -----------------------------------------------------------------------------

interface SideProps {
  state: GameState;
  label: string;
  player: GameState["players"]["p1"];
  isMe: boolean;
  selected: Selection;
  /** Instance-ids of Pokémon on this side that are legal drop targets for
   *  the card currently selected in hand. */
  legalTargets?: Set<string>;
  /** When true, highlight this side's empty bench slots (Basic being played). */
  benchHint?: boolean;
  /** Drop-target id (e.g. "my:inPlay:<instanceId>" or "my:bench:empty") that
   *  the user is currently hovering during a hand → in-play drag. Drives the
   *  `.drop-hover` highlight on the relevant tile / empty slot. */
  dropHoverId?: string | null;
  onInPlayClick?: (p: PokemonInPlay) => void;
  onViewDiscard?: (player: PlayerId) => void;
}

function PlayerSide({
  state,
  label,
  player,
  isMe,
  selected,
  legalTargets,
  benchHint,
  dropHoverId,
  onInPlayClick,
  onViewDiscard,
}: SideProps) {
  // The Active row appears closest to the shared Stadium slot — for the
  // player that's "top" of their strip, for the opponent that's "bottom".
  // We render the rows in a fixed DOM order and swap visually with CSS
  // (grid row numbers on .side.opponent) so the opponent's bench sits
  // between their active and their deck/prizes, mirroring a real table.
  const activeSlot = (
    <div className="active-slot">
      {player.active ? (
        <PokemonInPlayView
          p={player.active}
          maxHp={effectiveMaxHp(player.active, state)}
          selected={
            selected?.kind === "inPlay" &&
            selected.instanceId === player.active.instanceId
          }
          legalTarget={!!legalTargets?.has(player.active.instanceId)}
          dropHover={
            isMe && dropHoverId === `my:inPlay:${player.active.instanceId}`
          }
          dropTargetId={isMe ? `my:inPlay:${player.active.instanceId}` : undefined}
          onClick={() => onInPlayClick?.(player.active!)}
        />
      ) : (
        <div className="card empty-slot">No Active</div>
      )}
    </div>
  );

  // Empty bench slots collapse onto a single drop-target ("my:bench:empty")
  // since `playBasicToBench` doesn't take a slot index — the engine appends
  // to the next free slot. Marking each slot with the same id is fine: only
  // one bench area exists per player.
  const benchRow = (
    <div className="bench-row">
      {player.bench.map((p) => (
        <PokemonInPlayView
          key={p.instanceId}
          p={p}
          maxHp={effectiveMaxHp(p, state)}
          selected={selected?.kind === "inPlay" && selected.instanceId === p.instanceId}
          legalTarget={!!legalTargets?.has(p.instanceId)}
          dropHover={isMe && dropHoverId === `my:inPlay:${p.instanceId}`}
          dropTargetId={isMe ? `my:inPlay:${p.instanceId}` : undefined}
          onClick={() => onInPlayClick?.(p)}
        />
      ))}
      {Array.from({ length: 5 - player.bench.length }).map((_, i) => {
        const isDropHover = isMe && dropHoverId === "my:bench:empty";
        return (
          <div
            key={`empty-${i}`}
            className={
              `card empty-slot` +
              (benchHint ? " legal-target" : "") +
              (isDropHover ? " drop-hover" : "")
            }
            data-droptarget={isMe ? "my:bench:empty" : undefined}
          >
            Empty
          </div>
        );
      })}
    </div>
  );

  return (
    <div className={`side ${isMe ? "me" : "opponent"}`} aria-label={label}>
      {/* Back row — prizes on viewer's left, deck/discard on the right.
          Matches the official playmat rule that deck/discard sit opposite prizes. */}
      <div className="back-row">
        <div className="prize-zone" aria-label={`${label} prizes`}>
          <div className="zone-label">Prizes · {player.prizes.length}</div>
          <div className="prize-grid">
            {player.prizes.map((_, i) => (
              <div className="prize-card" key={i} />
            ))}
            {Array.from({ length: 6 - player.prizes.length }).map((_, i) => (
              <div className="prize-card empty" key={`e-${i}`} />
            ))}
          </div>
        </div>

        <div className="back-row-meta">
          <div className="player-name">{label}</div>
          {player.mulligans > 0 && (
            <div className="meta-chip">Mulligans · {player.mulligans}</div>
          )}
        </div>

        <div className="library-zone" aria-label={`${label} deck and discard`}>
          <FaceDownStack count={player.deck.length} label="Deck" variant="deck" />
          <DiscardStack player={player} onView={() => onViewDiscard?.(player.id)} />
        </div>
      </div>

      {/* Bench row sits between the back row and the Active spot, matching a
          real playmat where the bench is "directly in front of the player". */}
      <div className="bench-slot">{benchRow}</div>

      {/* Active row sits adjacent to the shared Stadium in the center. */}
      <div className="active-row">{activeSlot}</div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Deck / Discard — small face-down stacks with a count chip. These live in
// the "library" corner of each side (opposite the prizes).
// -----------------------------------------------------------------------------

function FaceDownStack({
  count,
  label,
  variant,
}: {
  count: number;
  label: string;
  variant: "deck" | "discard";
}) {
  const empty = count === 0;
  return (
    <div className={`zone-stack ${variant}${empty ? " empty" : ""}`} title={`${label}: ${count}`}>
      <div className="stack-slot">
        {!empty && <div className="stack-back" aria-hidden="true" />}
        {!empty && count > 1 && <div className="stack-back stack-back-2" aria-hidden="true" />}
        {!empty && count > 5 && <div className="stack-back stack-back-3" aria-hidden="true" />}
        <div className="stack-count">{count}</div>
      </div>
      <div className="zone-label">{label}</div>
    </div>
  );
}

// Discard is face-up in real play: show the top card if we have one, otherwise
// fall back to an empty stack. Clicking opens a modal showing the whole pile
// (both your own and the opponent's — discards are public information).
function DiscardStack({
  player,
  onView,
}: {
  player: GameState["players"]["p1"];
  onView: () => void;
}) {
  const top = player.discard[player.discard.length - 1];
  const count = player.discard.length;
  if (!top) {
    return (
      <div onClick={onView} style={{ cursor: "pointer" }} title="View discard pile">
        <FaceDownStack count={0} label="Discard" variant="discard" />
      </div>
    );
  }
  return (
    <div
      className="zone-stack discard"
      onClick={onView}
      role="button"
      tabIndex={0}
      style={{ cursor: "pointer" }}
      title={`Discard: ${count} · top: ${top.name} · click to view all`}
    >
      <div className="stack-slot discard-top">
        <CardView card={top} />
        <div className="stack-count">{count}</div>
      </div>
      <div className="zone-label">Discard · click to view</div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// ActionBar — sticky footer with status line + attacks/retreat/abilities/end.
// Rendering this as a flat row keeps the board free of a fixed-width controls
// column, which is what was overflowing on short viewports.
// -----------------------------------------------------------------------------

interface ActionBarProps {
  myTurn: boolean;
  promoteOpen: boolean;
  terminalPromote: boolean;
  statusMsg: string;
  me: GameState["players"]["p1"];
  attacks: { index: number; name: string; damage: number; damageText?: string; cost: string[]; payable: boolean; blockedReason: string | null; estimated: number }[];
  activatable: { p: PokemonInPlay; a: Ability; i: number; location: string }[];
  stadiumButton?: React.ReactNode;
  canUndo?: boolean;
  onUndo?: () => void;
  onAttack: (i: number) => void;
  onRetreat: (i: number) => void;
  onEndTurn: () => void;
  onActivateAbility: (p: PokemonInPlay, i: number) => void;
  onHoverAbilitySource?: (instanceId: string | null) => void;
  pendingTargetActive?: boolean;
  onCancelTarget?: () => void;
}

function ActionBarInner({
  myTurn,
  promoteOpen,
  terminalPromote,
  statusMsg,
  me,
  attacks,
  activatable,
  stadiumButton,
  canUndo,
  onUndo,
  onAttack,
  onRetreat,
  onEndTurn,
  onActivateAbility,
  onHoverAbilitySource,
  pendingTargetActive,
  onCancelTarget,
}: ActionBarProps) {
  return (
    <div className="action-bar">
      <div className="status-line">
        {promoteOpen ? (
          <span className="promote-msg">
            {terminalPromote
              ? "Your Active was KO'd — click a Benched Pokémon to promote."
              : "Your Active left the field — pick a Benched Pokémon to promote (you can still play other cards first)."}
          </span>
        ) : (
          <span className={`msg${pendingTargetActive || !myTurn ? " waiting" : ""}`}>
            {statusMsg || (myTurn ? "Your turn." : "CPU thinking…")}
            {pendingTargetActive && onCancelTarget && (
              <button
                style={{ marginLeft: 8, padding: "2px 8px", fontSize: 12 }}
                onClick={onCancelTarget}
              >
                Cancel
              </button>
            )}
          </span>
        )}
        <div className="turn-flags">
          <span className={me.energyAttachedThisTurn ? "on" : ""}>Energy</span>
          <span className={me.supporterPlayedThisTurn ? "on" : ""}>Supporter</span>
          <span className={me.retreatedThisTurn ? "on" : ""}>Retreat</span>
        </div>
      </div>

      <div className="action-groups">
        {activatable.length > 0 && (
          <div className="group abilities">
            <div className="group-label">Abilities</div>
            <div className="group-buttons">
              {activatable.map(({ p, a, i, location }) => (
                <button
                  key={`${p.instanceId}-${i}`}
                  className="ability"
                  disabled={!myTurn || promoteOpen}
                  onClick={() => onActivateAbility(p, i)}
                  onMouseEnter={() => onHoverAbilitySource?.(p.instanceId)}
                  onMouseLeave={() => onHoverAbilitySource?.(null)}
                  onFocus={() => onHoverAbilitySource?.(p.instanceId)}
                  onBlur={() => onHoverAbilitySource?.(null)}
                  title={`${a.name} — ${p.card.name} (${location})\n\n${a.text}`}
                >
                  <span className="ability-name">{a.name}</span>
                  <span className="ability-source">{p.card.name} · {location}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="group">
          <div className="group-label">Attacks</div>
          <div className="group-buttons">
            {attacks.length === 0 && <span className="muted">—</span>}
            {attacks.map((a) => {
              const baseText = a.damageText ?? String(a.damage);
              const preview = a.payable && myTurn && a.estimated > 0
                ? ` → ${a.estimated}`
                : "";
              // Disable + tooltip the reason for any pre-click block (T1
              // ban, asleep, paralyzed, locked, Power Saver gate, etc.) so
              // the player sees WHY before clicking. `payable` covers
              // energy cost; `blockedReason` covers everything else the
              // engine's `attackPreflight` would reject.
              const disabledForReason = !myTurn || !a.payable || promoteOpen || !!a.blockedReason;
              const tooltip = a.blockedReason
                ? `${a.blockedReason}\n\nCost: ${a.cost.join(" / ") || "—"}\nBase: ${baseText}`
                : `Cost: ${a.cost.join(" / ") || "—"}\nBase: ${baseText}\nExpected vs current defender: ${a.estimated}`;
              return (
                <button
                  key={a.index}
                  className="attack-btn"
                  disabled={disabledForReason}
                  onClick={() => onAttack(a.index)}
                  title={tooltip}
                >
                  <span className="atk-name">{a.name}</span>
                  <span className="atk-damage">{baseText}{preview}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="group">
          <div className="group-label">Retreat to</div>
          <div className="group-buttons">
            {me.bench.length === 0 && <span className="muted">—</span>}
            {me.bench.map((p, i) => (
              <button
                key={p.instanceId}
                disabled={!myTurn || promoteOpen || me.retreatedThisTurn}
                onClick={() => onRetreat(i)}
              >
                {p.card.name}
              </button>
            ))}
          </div>
        </div>

        {stadiumButton}

        <div className="group end">
          <div className="group-buttons">
            {onUndo && (
              <button
                disabled={!myTurn || promoteOpen || !canUndo}
                onClick={onUndo}
                title="Rewind to the start of this turn"
              >
                Undo
              </button>
            )}
            <button
              className="primary"
              disabled={!myTurn || promoteOpen}
              onClick={onEndTurn}
            >
              End Turn
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Memoized: ActionBar renders attack/ability buttons that re-evaluate every
// parent render. Most parent renders during gameplay don't change the visible
// action set (mouse hovers, pending pickers, etc.). We compare the action-
// driving slices explicitly and ignore callback identities (closures still
// reach the latest stateRef-backed handlers).
const ActionBar = memo(ActionBarInner, (prev, next) => {
  if (prev.myTurn !== next.myTurn) return false;
  if (prev.promoteOpen !== next.promoteOpen) return false;
  if (prev.terminalPromote !== next.terminalPromote) return false;
  if (prev.statusMsg !== next.statusMsg) return false;
  if (prev.canUndo !== next.canUndo) return false;
  if (prev.pendingTargetActive !== next.pendingTargetActive) return false;
  if (prev.stadiumButton !== next.stadiumButton) return false;
  if (prev.me !== next.me) return false;
  // Player turn-flag fields drive the chip row.
  if (prev.me.energyAttachedThisTurn !== next.me.energyAttachedThisTurn) return false;
  if (prev.me.supporterPlayedThisTurn !== next.me.supporterPlayedThisTurn) return false;
  if (prev.me.retreatedThisTurn !== next.me.retreatedThisTurn) return false;
  // Attacks: same length + same payable/estimated values per row.
  if (prev.attacks.length !== next.attacks.length) return false;
  for (let i = 0; i < prev.attacks.length; i++) {
    const a = prev.attacks[i], b = next.attacks[i];
    if (a.name !== b.name) return false;
    if (a.payable !== b.payable) return false;
    if (a.blockedReason !== b.blockedReason) return false;
    if (a.estimated !== b.estimated) return false;
    if (a.damage !== b.damage) return false;
  }
  // Activatables: same shape (length + names + per-Pokémon abilityUsed flags).
  if (prev.activatable.length !== next.activatable.length) return false;
  for (let i = 0; i < prev.activatable.length; i++) {
    const a = prev.activatable[i], b = next.activatable[i];
    if (a.a.name !== b.a.name) return false;
    if (a.p !== b.p) return false;
    if (a.location !== b.location) return false;
    if (a.p.abilityUsedThisTurn !== b.p.abilityUsedThisTurn) return false;
  }
  return true;
});

type InspectedCard =
  | {
      kind: "hand" | "inPlay";
      card: Card;
      label: string;
      pokemon: PokemonInPlay | null;
      owner: PlayerId;
    }
  | null;

function GameInspector({
  inspected,
  attacks,
  log,
  state,
}: {
  inspected: InspectedCard;
  attacks: ActionBarProps["attacks"];
  log: LogEntry[];
  state: GameState;
}) {
  const pokemon = inspected?.pokemon ?? null;
  const card = inspected?.card ?? null;
  const maxHp = pokemon ? effectiveMaxHp(pokemon, state) : null;
  const currentHp = pokemon && maxHp !== null ? Math.max(0, maxHp - pokemon.damage) : null;
  const energies = pokemon?.attachedEnergy ?? [];
  const tools = pokemon?.tools ?? [];
  const statuses = pokemon?.statuses ?? [];

  return (
    <aside className="game-inspector" aria-label="Selected card and game log">
      <section className="inspector-section selected-card-panel">
        <div className="inspector-kicker">{inspected?.label ?? "Selected"}</div>
        {card ? (
          <>
            <div className="inspector-card-row">
              <div className="inspector-card">
                <CardView card={card} />
              </div>
              <div className="inspector-facts">
                <h2>{card.name}</h2>
                <div className="muted">{card.supertype} · {card.subtypes.join(" · ")}</div>
                {pokemon && currentHp !== null && maxHp !== null && (
                  <div className="hp-meter" aria-label={`HP ${currentHp} of ${maxHp}`}>
                    <div className="hp-meter-top">
                      <span>HP</span>
                      <strong>{currentHp}/{maxHp}</strong>
                    </div>
                    <div className="hp-track">
                      <span style={{ width: `${Math.max(0, Math.min(100, (currentHp / maxHp) * 100))}%` }} />
                    </div>
                  </div>
                )}
              </div>
            </div>
            {pokemon && (
              <div className="state-chip-grid">
                <span className={energies.length ? "state-chip on" : "state-chip"}>Energy {energies.length}</span>
                <span className={tools.length ? "state-chip on" : "state-chip"}>Tools {tools.length}</span>
                <span className={statuses.length ? "state-chip danger" : "state-chip"}>Status {statuses.length ? statuses.join(", ") : "clear"}</span>
              </div>
            )}
          </>
        ) : (
          <p className="modal-hint">Select a card or Pokemon to inspect details here.</p>
        )}
      </section>

      <section className="inspector-section attack-preview-panel">
        <div className="inspector-kicker">Attack Preview</div>
        {attacks.length > 0 ? (
          <div className="attack-preview-list">
            {attacks.map((a) => (
              <div className="attack-preview-row" key={a.index}>
                <div>
                  <strong>{a.name}</strong>
                  <span>{a.cost.join(" / ") || "No cost"}</span>
                </div>
                <b>{a.damageText ?? a.damage}{a.estimated > 0 ? ` → ${a.estimated}` : ""}</b>
              </div>
            ))}
          </div>
        ) : (
          <p className="modal-hint">Your Active Pokemon has no attacks available yet.</p>
        )}
      </section>

      <section className="inspector-section log-panel">
        <div className="inspector-kicker">Recent Log</div>
        <div className="log-content">
          {log.length === 0 && <div className="entry system">No actions yet.</div>}
          {log.map((e, i, arr) => {
            const prev = i > 0 ? arr[i - 1] : null;
            const newTurn = prev && prev.turn !== e.turn;
            return (
              <div key={`${e.turn}-${i}-${e.text}`}>
                {newTurn && <div className="entry turn-sep">Turn {e.turn}</div>}
                <div className={`entry ${e.player}`}>
                  [T{e.turn}] {e.player !== "system" && `${state.players[e.player].name} `}
                  {e.text}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </aside>
  );
}

// ---------------------------------------------------------------------------
//  Deck picker — grouped preset + imported decks
// ---------------------------------------------------------------------------

function DeckSelect({
  value,
  onChange,
  specs,
  imports,
  allowRandom,
}: {
  value: string;
  onChange: (id: string) => void;
  specs: { id: string; name: string }[];
  imports: ImportedDeck[];
  /** When true, expose a "🎲 Random preset" option that resolves to a
   *  random preset deck at game-start. Used for the CPU side. */
  allowRandom?: boolean;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {allowRandom && (
        <option value="__random__">🎲 Random preset</option>
      )}
      <optgroup label="Preset decks">
        {specs.map((d) => (
          <option key={d.id} value={d.id}>{d.name}</option>
        ))}
      </optgroup>
      {imports.length > 0 && (
        <optgroup label="Imported decks">
          {imports.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

// ---------------------------------------------------------------------------
//  Import deck modal
// ---------------------------------------------------------------------------

// First Pokémon-card line becomes the default deck name — usually the player's
// main attacker, which makes the dropdown entry easy to recognize.
function suggestDeckName(parsed: ReturnType<typeof importDecklist>): string {
  // Entries are preserved in source order; the first non-trivial name is fine.
  return parsed.deck[0]?.name ?? "Imported Deck";
}

function uniqueName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let i = 2;
  while (existing.includes(`${base} (${i})`)) i++;
  return `${base} (${i})`;
}

function ImportDeckModal({
  existingNames,
  savedDecks,
  onDelete,
  onClose,
  onImport,
}: {
  existingNames: string[];
  savedDecks: ImportedDeck[];
  onDelete: (id: string) => void;
  onClose: () => void;
  onImport: (
    name: string,
    entries: DeckListEntry[],
    deck: Card[],
    assignTo: "me" | "opp" | "both" | "none",
  ) => void;
}) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<ReturnType<typeof importDecklist> | null>(null);
  const [name, setName] = useState("");

  const parsed = result;
  const okToImport =
    !!parsed &&
    parsed.deck.length === 60 &&
    parsed.unmatched.length === 0 &&
    parsed.parseErrors.length === 0 &&
    parsed.ruleViolations.length === 0;

  const validate = () => {
    const r = importDecklist(text);
    setResult(r);
    if (!name) setName(uniqueName(suggestDeckName(r), existingNames));
  };

  const commit = (assignTo: "me" | "opp" | "both" | "none") => {
    if (!parsed) return;
    const finalName = (name.trim() || suggestDeckName(parsed)).slice(0, 60);
    onImport(uniqueName(finalName, existingNames), parsed.entries, parsed.deck, assignTo);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Import Decklist</h2>
          <button onClick={onClose}>Close</button>
        </div>
        <p className="modal-hint">
          Paste a standard Play! Pokémon decklist (as exported from Limitless or PTCGL).
          Lines look like <code>4 Dipplin TWM 18</code>. Section headers are optional.
        </p>
        <textarea
          className="decklist-input"
          rows={14}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Pokémon: 21\n4 Dipplin TWM 18\n...\n\nTrainer: 33\n4 Buddy-Buddy Poffin ASC 184\n...\n\nEnergy: 6\n6 Grass Energy SVE 1`}
        />
        <label className="field deck-name-field">
          Deck name
          <input
            type="text"
            value={name}
            placeholder="e.g. Dipplin (auto-filled after validating)"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button onClick={validate}>Validate</button>
          <button
            className="primary"
            disabled={!okToImport}
            onClick={() => commit("me")}
          >
            Add + use for You
          </button>
          <button disabled={!okToImport} onClick={() => commit("opp")}>
            Add + use for CPU
          </button>
          <button disabled={!okToImport} onClick={() => commit("none")}>
            Add only
          </button>
        </div>
        {savedDecks.length > 0 && (
          <div className="saved-decks">
            <div className="saved-decks-header">Saved decks ({savedDecks.length})</div>
            <ul>
              {savedDecks.map((d) => (
                <li key={d.id}>
                  <span>{d.name}</span>
                  <span className="count">{d.cards.length} cards</span>
                  <button
                    className="delete"
                    onClick={() => {
                      if (confirm(`Delete "${d.name}"?`)) onDelete(d.id);
                    }}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {parsed && (
          <div className="import-result">
            <div>
              <b>Total cards:</b> {parsed.totalCards} ({parsed.deck.length} resolved
              {parsed.deck.length !== 60 && " — needs 60"})
            </div>
            {parsed.nameOnlyMatches.length > 0 && (
              <details open>
                <summary>{parsed.nameOnlyMatches.length} matched by name (different printing in pool)</summary>
                <ul>
                  {parsed.nameOnlyMatches.map((e, i) => (
                    <li key={i}>{e.count} {e.name} {e.limitlessSet} {e.number}</li>
                  ))}
                </ul>
              </details>
            )}
            {parsed.unmatched.length > 0 && (
              <details open>
                <summary className="error">{parsed.unmatched.length} not found in legal pool</summary>
                <ul>
                  {parsed.unmatched.map((e, i) => (
                    <li key={i}>{e.count} {e.name} {e.limitlessSet} {e.number}</li>
                  ))}
                </ul>
              </details>
            )}
            {parsed.ruleViolations.length > 0 && (
              <details open>
                <summary className="error">{parsed.ruleViolations.length} deck-rule violation(s)</summary>
                <ul>
                  {parsed.ruleViolations.map((v, i) => <li key={i}>{v}</li>)}
                </ul>
              </details>
            )}
            {parsed.parseErrors.length > 0 && (
              <details open>
                <summary className="error">{parsed.parseErrors.length} lines couldn't be parsed</summary>
                <ul>
                  {parsed.parseErrors.map((l, i) => <li key={i}><code>{l}</code></li>)}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  CoinFlip modal — player guesses heads/tails; winner picks first/second
// ---------------------------------------------------------------------------

function CoinFlipModal({ onGuess }: { onGuess: (g: "heads" | "tails") => void }) {
  return (
    <div className="modal-backdrop">
      <div className="modal coin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Coin Flip</h2>
        </div>
        <p className="modal-hint">
          Heads or tails? Guess correctly and you'll choose who goes first.
        </p>
        <div className="modal-actions">
          <button className="primary" onClick={() => onGuess("heads")}>Heads</button>
          <button className="primary" onClick={() => onGuess("tails")}>Tails</button>
        </div>
      </div>
    </div>
  );
}

function ChooseFirstModal({
  result,
  guess,
  winnerName,
  onChoose,
}: {
  result: "heads" | "tails";
  guess: "heads" | "tails";
  winnerName: string;
  onChoose: (first: boolean) => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal coin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{winnerName} won the flip!</h2>
        </div>
        <p className="modal-hint">
          Called <b>{guess}</b>, coin landed <b>{result}</b>. Choose who goes first.
        </p>
        <div className="modal-actions">
          <button className="primary" onClick={() => onChoose(true)}>Go first</button>
          <button onClick={() => onChoose(false)}>Go second</button>
        </div>
      </div>
    </div>
  );
}

function CoinResultBanner({
  result,
  guess,
}: {
  result: "heads" | "tails";
  guess: "heads" | "tails";
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal coin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Coin flip: {result}</h2>
        </div>
        <p className="modal-hint">
          You called <b>{guess}</b>. CPU won the toss — they'll choose who goes first.
        </p>
      </div>
    </div>
  );
}

function EndTurnConfirmModal({
  warnings,
  onConfirm,
  onCancel,
}: {
  warnings: string[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>End turn?</h2>
        </div>
        <div className="mulligan-body">
          <p>You haven't used:</p>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
          <p className="muted">
            These slots reset on the opponent's turn — they don't carry over.
          </p>
        </div>
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={onConfirm}>End turn anyway</button>
        </div>
      </div>
    </div>
  );
}

function MulliganNoticeModal({
  myName,
  oppName,
  myMulligans,
  oppMulligans,
  onContinue,
}: {
  myName: string;
  oppName: string;
  myMulligans: number;
  oppMulligans: number;
  onContinue: () => void;
}) {
  const lines: string[] = [];
  const cardsWord = (n: number) => `${n} extra card${n === 1 ? "" : "s"}`;
  if (myMulligans > 0) {
    lines.push(
      `${myName} mulliganed ${myMulligans}× (no Basic Pokémon). ${oppName} drew ${cardsWord(myMulligans)}.`,
    );
  }
  if (oppMulligans > 0) {
    lines.push(
      `${oppName} mulliganed ${oppMulligans}× (no Basic Pokémon). ${myName} drew ${cardsWord(oppMulligans)}.`,
    );
  }
  return (
    <div className="modal-backdrop">
      <div className="modal mulligan-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Mulligan</h2>
        </div>
        <div className="mulligan-body">
          <p className="muted">
            If your opening hand has no Basic Pokémon, you reveal it, shuffle
            it back into your deck, and draw a new 7 — that's a "mulligan."
            Your opponent draws one extra card for each mulligan you take.
          </p>
          {lines.map((l, i) => (
            <p key={i}>{l}</p>
          ))}
        </div>
        <div className="modal-actions">
          <button className="primary" onClick={onContinue}>Continue</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  DeckBuilderModal lives in ./ui/DeckBuilderModal.tsx — lazy-loaded above.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
//  PreGame modal — pick decks before the game starts
// ---------------------------------------------------------------------------

function PreGameModal({
  deckSpecs,
  imports,
  myDeckId,
  oppDeckId,
  openHands,
  gameMode,
  deckIssue,
  onChangeMyDeck,
  onChangeOppDeck,
  onToggleOpenHands,
  onChangeMode,
  onOpenImport,
  onOpenBuild,
  onStart,
}: {
  deckSpecs: { id: string; name: string }[];
  imports: ImportedDeck[];
  myDeckId: string;
  oppDeckId: string;
  openHands: boolean;
  gameMode: "vsCPU" | "local";
  deckIssue: (id: string) => string | null;
  onChangeMyDeck: (id: string) => void;
  onChangeOppDeck: (id: string) => void;
  onToggleOpenHands: (v: boolean) => void;
  onChangeMode: (m: "vsCPU" | "local") => void;
  onOpenImport: () => void;
  onOpenBuild: () => void;
  onStart: () => void;
}) {
  const describe = (id: string): string | null => {
    const imp = imports.find((d) => d.id === id);
    if (imp) return `Imported · ${imp.cards.length} cards`;
    return null;
  };
  const myIssue = deckIssue(myDeckId);
  const oppIssue = deckIssue(oppDeckId);
  const startBlocked = !!(myIssue || oppIssue);
  const opponentLabel = gameMode === "local" ? "Player 2" : "CPU";
  return (
    <div className="modal-backdrop">
      <div className="modal pregame-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>PandaBananasTCG — Start a game</h2>
        </div>
        <div className="pregame-mode">
          <label className={`mode-option${gameMode === "vsCPU" ? " active" : ""}`}>
            <input
              type="radio"
              name="gameMode"
              checked={gameMode === "vsCPU"}
              onChange={() => onChangeMode("vsCPU")}
            />
            <b>vs CPU</b>
            <span>Play against a computer opponent.</span>
          </label>
          <label className={`mode-option${gameMode === "local" ? " active" : ""}`}>
            <input
              type="radio"
              name="gameMode"
              checked={gameMode === "local"}
              onChange={() => onChangeMode("local")}
            />
            <b>Local 2-player</b>
            <span>Hotseat. Pass the device between turns.</span>
          </label>
        </div>
        <p className="modal-hint">
          Pick a preset for each side, <b>build a deck</b> from the card pool,
          or bring your own via <b>Import Deck</b>. You'll choose Active and
          Bench Pokémon in the next step.
        </p>
        <div className="pregame-grid">
          <div className="pregame-slot">
            <div className="pregame-slot-label">{gameMode === "local" ? "Player 1" : "You"}</div>
            <DeckSelect
              value={myDeckId}
              onChange={onChangeMyDeck}
              specs={deckSpecs}
              imports={imports}
            />
            {describe(myDeckId) && <div className="pregame-slot-note">{describe(myDeckId)}</div>}
            {myIssue && <div className="pregame-slot-note error">⚠ {myIssue}</div>}
          </div>
          <div className="pregame-vs">vs</div>
          <div className="pregame-slot">
            <div className="pregame-slot-label">{opponentLabel}</div>
            <DeckSelect
              value={oppDeckId}
              onChange={onChangeOppDeck}
              specs={deckSpecs}
              imports={imports}
              allowRandom={gameMode === "vsCPU"}
            />
            {oppDeckId === "__random__" ? (
              <div className="pregame-slot-note">
                A preset deck will be picked at random when you start.
              </div>
            ) : (
              describe(oppDeckId) && <div className="pregame-slot-note">{describe(oppDeckId)}</div>
            )}
            {oppIssue && <div className="pregame-slot-note error">⚠ {oppIssue}</div>}
          </div>
        </div>
        <div className="pregame-options">
          {gameMode === "vsCPU" && (
            <label className="toggle">
              <input
                type="checkbox"
                checked={openHands}
                onChange={(e) => onToggleOpenHands(e.target.checked)}
              />
              Open hands (reveal CPU cards)
            </label>
          )}
          {gameMode === "local" && (
            <span className="muted" style={{ fontSize: 11 }}>
              In local play, each player's hand is hidden from the other.
            </span>
          )}
          <button onClick={onOpenBuild}>Build Deck…</button>
          <button onClick={onOpenImport}>Import Deck…</button>
        </div>
        <div className="modal-actions">
          <button
            className="primary"
            onClick={onStart}
            disabled={startBlocked}
            title={startBlocked ? "Fix the deck issue(s) above before starting." : undefined}
          >
            Start Game
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Handoff interstitial — hotseat pass-the-device between turns.
// ---------------------------------------------------------------------------

function HandoffModal({
  incomingPlayerName,
  onStart,
}: {
  incomingPlayerName: string;
  onStart: () => void;
}) {
  return (
    <div className="modal-backdrop handoff-backdrop">
      <div className="modal handoff-modal" onClick={(e) => e.stopPropagation()}>
        <div className="handoff-icon">⇄</div>
        <h2>Pass the device</h2>
        <p className="handoff-text">
          It's <b>{incomingPlayerName}</b>'s turn. Hand the device over before
          clicking below — the other player's hand is hidden until you start.
        </p>
        <div className="modal-actions">
          <button className="primary" onClick={onStart}>
            I'm {incomingPlayerName} — Start my turn
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Setup modal — opening hand: pick Active + optional bench
// ---------------------------------------------------------------------------

function SetupModal({
  hand,
  mulligans,
  onConfirm,
}: {
  hand: Card[];
  mulligans: number;
  onConfirm: (activeHandIdx: number, benchHandIdxs: number[]) => void;
}) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [benchIdxs, setBenchIdxs] = useState<number[]>([]);

  const isBasicCard = (c: Card) =>
    c.supertype === "Pokémon" && c.subtypes.includes("Basic");

  const onCardClick = (i: number) => {
    const c = hand[i];
    if (!isBasicCard(c)) return;
    // Already Active → clicking again deselects Active.
    if (activeIdx === i) { setActiveIdx(null); return; }
    // Already on bench → remove from bench.
    if (benchIdxs.includes(i)) {
      setBenchIdxs((cur) => cur.filter((x) => x !== i));
      return;
    }
    // No Active yet → make it Active.
    if (activeIdx === null) { setActiveIdx(i); return; }
    // Active already chosen → add to bench (up to 5).
    if (benchIdxs.length >= 5) return;
    setBenchIdxs((cur) => [...cur, i]);
  };

  const basicCount = hand.filter(isBasicCard).length;
  const canConfirm = activeIdx !== null;

  return (
    <div className="modal-backdrop">
      <div className="modal setup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Opening Setup — You</h2>
          <span className="pick-counter">
            Active: {activeIdx !== null ? "✓" : "—"} · Bench: {benchIdxs.length}/5
          </span>
        </div>
        <p className="modal-hint">
          {mulligans > 0 && <>Mulliganed {mulligans}× — {" "}</>}
          Click a <b>Basic Pokémon</b> to put it in the Active spot (required).
          Click more Basics to add them to your bench (optional, up to 5).
          {basicCount === 0 && " (No Basics in hand — this shouldn't happen.)"}
        </p>
        <div className="pick-pool">
          {hand.map((c, i) => {
            const eligible = isBasicCard(c);
            const isActive = activeIdx === i;
            const isBenched = benchIdxs.includes(i);
            const cls = `pick-card${isActive ? " picked active" : ""}${isBenched ? " picked bench" : ""}${eligible ? "" : " ineligible"}`;
            return (
              <div
                key={i}
                className={cls}
                onClick={() => onCardClick(i)}
                title={!eligible ? "Not a Basic Pokémon" : (isActive ? "Active — click to deselect" : isBenched ? "Bench — click to remove" : "Click to place")}
              >
                <CardView card={c} />
                {isActive && <div className="slot-badge active-badge">ACTIVE</div>}
                {isBenched && <div className="slot-badge bench-badge">BENCH</div>}
              </div>
            );
          })}
        </div>
        <div className="modal-actions">
          <button
            className="primary"
            disabled={!canConfirm}
            onClick={() => onConfirm(activeIdx!, benchIdxs)}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Snipe target modal — pick which of opp's Benched to hit (snipeOne attacks).
// ---------------------------------------------------------------------------

function SnipeTargetModal({
  bench,
  active,
  onPick,
  onCancel,
}: {
  bench: PokemonInPlay[];
  // Free-pick attacks (Cruel Arrow style: "X damage to 1 of opp's Pokémon"
  // without "Benched") may target Active too. benchOnly attacks pass null.
  active: PokemonInPlay | null;
  // null = engine default; non-negative = bench index; -1 = explicit Active.
  onPick: (idx: number | null) => void;
  onCancel: () => void;
}) {
  const freePick = active !== null;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal pick-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{freePick ? "Pick a Pokémon to hit" : "Pick a Benched Pokémon to snipe"}</h2>
        </div>
        <div className="pick-source-note">
          {freePick
            ? "This attack hits 1 of the opponent's Pokémon (Active or Bench). Weakness/Resistance applies to the Active target only."
            : "This attack hits one of the opponent's Benched Pokémon. Pick any, or let the engine auto-target the most damaged."}
        </div>
        <div className="pick-pool">
          {active && (
            <div
              key={active.instanceId}
              className="pick-card"
              onClick={() => onPick(-1)}
              title="Target Active"
            >
              <CardView card={active.card} />
              <div className="pick-card-label">Active</div>
            </div>
          )}
          {bench.map((p, i) => (
            <div
              key={p.instanceId}
              className="pick-card"
              onClick={() => onPick(i)}
            >
              <CardView card={p.card} />
            </div>
          ))}
        </div>
        <div className="modal-actions">
          {!freePick && (
            <button onClick={() => onPick(null)}>Auto-target (most damaged)</button>
          )}
          <button onClick={onCancel}>Cancel attack</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Card zoom modal — shift+click / right-click any card to see it big.
// ---------------------------------------------------------------------------

function CardZoomModal({
  card,
  onClose,
}: {
  card: Card;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop card-zoom-backdrop" onClick={onClose}>
      <div className="card-zoom" onClick={(e) => e.stopPropagation()}>
        {card.imageLarge ? (
          <img src={card.imageLarge} alt={card.name} />
        ) : (
          <div className="card-zoom-fallback">
            <CardView card={card} />
          </div>
        )}
        <button className="card-zoom-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Discard viewer — discard piles are public info in real play. This modal
//  lets the player click either discard pile and browse every card in it.
// ---------------------------------------------------------------------------

function DiscardViewerModal({
  player,
  onClose,
}: {
  player: GameState["players"]["p1"];
  onClose: () => void;
}) {
  const cards = player.discard;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal discard-viewer" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{player.name}'s Discard Pile</h2>
          <span className="pick-counter">{cards.length} card{cards.length === 1 ? "" : "s"}</span>
        </div>
        <p className="modal-hint">
          Oldest discards are on the left, most recent on the right.
        </p>
        {cards.length === 0 ? (
          <div className="muted" style={{ padding: 20, textAlign: "center" }}>
            The discard pile is empty.
          </div>
        ) : (
          <div className="pick-pool">
            {cards.map((c, i) => (
              <div key={i} className="pick-card" style={{ cursor: "default" }}>
                <CardView card={c} />
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button className="primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Pick modal — interactive chooser for search / peek / discard-recovery
// ---------------------------------------------------------------------------

function PickModal({
  pick,
  onResolve,
}: {
  pick: NonNullable<GameState["pendingPick"]>;
  onResolve: (pickedIndexes: number[]) => void;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  // Deck searches get an Eligible/All tab toggle. Default to Eligible — the
  // All view is for verifying what the rest of the deck looks like (deck
  // search is a key information-gathering tool in the TCG).
  const [tab, setTab] = useState<"eligible" | "all">("eligible");
  // Chained picks (Dawn Basic → Stage 1 → Stage 2, Hilda Evolution → Energy)
  // reuse the same PickModal mount — React doesn't remount because the
  // outer conditional stays true. Without this reset, `selected` from the
  // previous stage leaks into the next: e.g., selected=[0] from Stage 1
  // makes the Stage 2 modal think it's already at max=1, silently
  // rejecting any click on Alakazam at a higher index. Reset on every new
  // pool identity so each stage starts fresh.
  useEffect(() => {
    setSelected([]);
    setTab("eligible");
  }, [pick.pool, pick.label]);
  const eligibleSet = pick.eligibleIndexes
    ? new Set(pick.eligibleIndexes)
    : null;

  const isEligible = (i: number) => !eligibleSet || eligibleSet.has(i);
  const toggle = (i: number) => {
    if (!isEligible(i)) return;
    setSelected((cur) => {
      if (cur.includes(i)) return cur.filter((x) => x !== i);
      if (cur.length >= pick.max) return cur;
      return [...cur, i];
    });
  };

  const canConfirm = selected.length >= pick.min && selected.length <= pick.max;
  const canSkip = pick.min === 0;
  // Only deck searches with non-matching cards left in the deck get the All
  // tab — other sources (deckTop/deckBottom/discard) don't carry a snapshot
  // and there's no "rest" to show.
  const restCards = pick.source === "deck" ? pick.nonEligiblePool ?? [] : [];
  const showTabs = pick.source === "deck" && restCards.length > 0;
  const totalDeckCount = pick.pool.length + restCards.length;
  const showingAll = showTabs && tab === "all";

  return (
    <div className="modal-backdrop">
      <div className="modal pick-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{pick.label}</h2>
          <span className="pick-counter">
            {selected.length} / {pick.max} picked
          </span>
        </div>
        {showTabs && (
          <div className="pick-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "eligible"}
              className={`pick-tab${tab === "eligible" ? " active" : ""}`}
              onClick={() => setTab("eligible")}
            >
              Eligible ({pick.pool.length})
            </button>
            <button
              role="tab"
              aria-selected={tab === "all"}
              className={`pick-tab${tab === "all" ? " active" : ""}`}
              onClick={() => setTab("all")}
            >
              All ({totalDeckCount})
            </button>
          </div>
        )}
        <div className="pick-source-note">
          {pick.source === "deck" && (showingAll
            ? `Showing all ${totalDeckCount} cards in your Deck. Only the ${pick.pool.length} eligible card${pick.pool.length === 1 ? " is" : "s are"} clickable.`
            : `Searching your Deck — ${pick.pool.length} eligible card${pick.pool.length === 1 ? "" : "s"}. Prize cards are locked and not part of this search.`)}
          {pick.source === "deckTop" && `Top ${pick.pool.length} cards of your Deck. Prize cards are not shown.`}
          {pick.source === "deckBottom" && `Bottom ${pick.pool.length} cards of your Deck. Prize cards are not shown.`}
          {pick.source === "discard" && `Searching your Discard pile — ${pick.pool.length} eligible card${pick.pool.length === 1 ? "" : "s"}.`}
        </div>
        <div className="pick-pool">
          {pick.pool.map((c, i) => {
            const eligible = isEligible(i);
            const picked = selected.includes(i);
            return (
              <div
                key={`pool-${i}`}
                className={`pick-card${picked ? " picked" : ""}${eligible ? "" : " ineligible"}`}
                onClick={() => toggle(i)}
                title={eligible ? (picked ? "Click to deselect" : "Click to pick") : "Not eligible"}
              >
                <CardView card={c} />
              </div>
            );
          })}
          {showingAll && restCards.map((c, i) => (
            <div
              key={`rest-${i}`}
              className="pick-card ineligible"
              title="Not eligible for this search"
            >
              <CardView card={c} />
            </div>
          ))}
        </div>
        <div className="modal-actions">
          {canSkip && (
            <button onClick={() => onResolve([])}>Skip / Pick nothing</button>
          )}
          <button
            className="primary"
            disabled={!canConfirm}
            onClick={() => onResolve(selected)}
          >
            Confirm ({selected.length})
          </button>
        </div>
      </div>
    </div>
  );
}

function HandRevealModal({
  pending,
  hand,
  onConfirm,
  onCancel,
}: {
  pending: NonNullable<GameState["pendingHandReveal"]>;
  hand: Card[];
  onConfirm: (idxs: number[]) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const eligible = (i: number) => {
    const c = hand[i];
    if (c.supertype !== "Trainer" && pending.filter !== "any") return false;
    const subs = c.subtypes ?? [];
    switch (pending.filter) {
      case "any": return true;
      case "item": return subs.includes("Item");
      case "tool": return subs.includes("Pokémon Tool") || subs.includes("Tool");
      case "itemOrTool":
        return subs.includes("Item") || subs.includes("Pokémon Tool") || subs.includes("Tool");
      case "supporter": return subs.includes("Supporter");
    }
  };
  const toggle = (i: number) => {
    if (!eligible(i)) return;
    setSelected((cur) => {
      if (cur.includes(i)) return cur.filter((x) => x !== i);
      if (cur.length >= pending.max) return cur;
      return [...cur, i];
    });
  };
  const canConfirm = selected.length >= pending.min && selected.length <= pending.max;

  return (
    <div className="modal-backdrop">
      <div className="modal pick-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{pending.label}</h2>
          <span className="pick-counter">
            {selected.length} / {pending.max} picked
          </span>
        </div>
        <div className="pick-source-note">
          {pending.player === pending.target
            ? `Pick up to ${pending.max} card${pending.max === 1 ? "" : "s"} from your hand.`
            : `Your opponent's hand is revealed (${hand.length} card${hand.length === 1 ? "" : "s"}). Pick up to ${pending.max} eligible card${pending.max === 1 ? "" : "s"}.`}
        </div>
        <div className="pick-pool">
          {hand.length === 0 && <span className="muted">Empty hand.</span>}
          {hand.map((c, i) => {
            const isPickable = eligible(i);
            const picked = selected.includes(i);
            return (
              <div
                key={i}
                className={`pick-card${picked ? " picked" : ""}${isPickable ? "" : " ineligible"}`}
                onClick={() => toggle(i)}
                title={isPickable ? (picked ? "Click to deselect" : "Click to pick") : "Not eligible"}
              >
                <CardView card={c} />
              </div>
            );
          })}
        </div>
        <div className="modal-actions">
          {pending.min === 0 && (
            <>
              <button onClick={onCancel}>Cancel</button>
              <button onClick={() => onConfirm([])}>Skip / Pick nothing</button>
            </>
          )}
          <button
            className="primary"
            disabled={!canConfirm}
            onClick={() => onConfirm(selected)}
          >
            Confirm ({selected.length})
          </button>
        </div>
      </div>
    </div>
  );
}

// Short "this stage had no qualifying cards" notice shown between chained
// deck-search stages (Dawn). Blocks until the user clicks Continue so the
// skip is always seen, never silent.
function SearchNoticeModal({
  message,
  onContinue,
}: {
  message: string;
  onContinue: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={(e) => e.stopPropagation()}>
      <div className="modal search-notice-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Nothing to pick</h2>
        </div>
        <p className="modal-hint" style={{ fontSize: 13, margin: "8px 0 14px" }}>
          {message}
        </p>
        <div className="modal-actions" style={{ justifyContent: "flex-end" }}>
          <button className="primary" onClick={onContinue}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
