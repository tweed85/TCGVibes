import { useEffect, useMemo, useRef, useState } from "react";
import {
  attachEnergy,
  attack,
  endTurn,
  evolve,
  playBasicToBench,
  playTrainer,
  promoteBenchToActive,
  retreat,
} from "./engine/actions";
import type { TrainerTarget } from "./engine/actions";
import { activateAbility } from "./engine/abilities";
import { resolveAiCoinChoice, resolveAiPendingPromote, resolveAiSetup, takeAiTurn } from "./engine/ai";
import { resolvePendingPick } from "./engine/pendingPick";
import { makeRng } from "./engine/rng";
import {
  canPayCost,
  chooseFirstPlayer,
  completeSetup,
  energyProvidedBy,
  isBasic,
  isPokemon,
  resolveCoinGuess,
  setupGame,
} from "./engine/rules";
import { effectiveMaxHp } from "./engine/ongoingEffects";
import type { ActionResult } from "./engine/actions";
import type { Ability, Card, GameState, PlayerId, PokemonInPlay } from "./engine/types";
import { buildDeck, validatedDeckSpecs } from "./data/decks";
import { datasetAsOf, datasetFormat } from "./data/cards";
import {
  buildDeckFromEntries,
  importDecklist,
  type DeckListEntry,
} from "./data/decklistParser";
import { CardView, FaceDownCard, PokemonInPlayView } from "./ui/CardView";

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

// localStorage persistence. We store entries (not resolved Cards) so rotations
// or dataset updates re-resolve cleanly. Bump the key suffix if the schema
// changes in a breaking way.
const IMPORTS_STORAGE_KEY = "tcgvibes.imports.v1";

interface PersistedImport {
  id: string;
  name: string;
  entries: DeckListEntry[];
}

function loadPersistedImports(): ImportedDeck[] {
  try {
    const raw = localStorage.getItem(IMPORTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistedImport[];
    const restored: ImportedDeck[] = [];
    for (const p of parsed) {
      if (!p || !p.id || !p.name || !Array.isArray(p.entries)) continue;
      const built = buildDeckFromEntries(p.entries);
      // Skip decks that can't be resolved at all (dataset drift) — the raw
      // entries would still be in storage for debugging, but a zero-card deck
      // is unplayable. Partial resolution (<60) is kept and flagged in UI.
      if (built.deck.length === 0) continue;
      restored.push({ id: p.id, name: p.name, entries: p.entries, cards: built.deck });
    }
    return restored;
  } catch {
    return [];
  }
}

function savePersistedImports(imports: ImportedDeck[]): void {
  try {
    const data: PersistedImport[] = imports.map(({ id, name, entries }) => ({
      id,
      name,
      entries,
    }));
    localStorage.setItem(IMPORTS_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage quota / private mode — silently ignore; imports stay in-memory.
  }
}

export default function App() {
  const deckSpecs = useMemo(() => validatedDeckSpecs(), []);
  const [imports, setImports] = useState<ImportedDeck[]>(() => loadPersistedImports());
  const [myDeckId, setMyDeckId] = useState(deckSpecs[0]?.id ?? "");
  const [oppDeckId, setOppDeckId] = useState(deckSpecs[1]?.id ?? deckSpecs[0]?.id ?? "");
  const rngRef = useRef(makeRng(Date.now()));

  // Build a deck for the picker id — either a preset spec or an imported list.
  const deckForId = (id: string, fallback: Card[]): Card[] => {
    const imported = imports.find((d) => d.id === id);
    if (imported) return imported.cards.map((c) => ({ ...c }));
    const spec = deckSpecs.find((d) => d.id === id);
    if (spec) return buildDeck(spec);
    return fallback;
  };

  const buildInitial = (): GameState => {
    const myDeck = buildDeck(deckSpecs.find((d) => d.id === myDeckId) ?? deckSpecs[0]);
    const oppDeck = buildDeck(deckSpecs.find((d) => d.id === oppDeckId) ?? deckSpecs[0]);
    return setupGame(myDeck, oppDeck, rngRef.current, {
      p1Name: "You",
      p2Name: "CPU",
    });
  };

  const stateRef = useRef<GameState>(buildInitial());
  const rerender = useForceRerender();
  const [selected, setSelected] = useState<Selection>(null);
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [openHands, setOpenHands] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // Gate the game behind a pre-game deck selection step. Nothing runs (AI
  // setup, turn-1 draw, opening modal) until the player clicks Start.
  const [preGameOpen, setPreGameOpen] = useState(true);
  const [discardViewer, setDiscardViewer] = useState<PlayerId | null>(null);
  // Game mode: "vsCPU" leaves p2 as AI; "local" makes both sides human and
  // enables hotseat device-handoff between turns.
  const [gameMode, setGameMode] = useState<"vsCPU" | "local">("vsCPU");
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

  // Persist imported decks across reloads.
  useEffect(() => {
    savePersistedImports(imports);
  }, [imports]);

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
    if (state.phase === "main" && state.players[state.activePlayer].isAI) {
      const target = state.activePlayer;
      const t = setTimeout(() => {
        takeAiTurn(state, target);
        rerender();
      }, 500);
      return () => clearTimeout(t);
    }
  });

  const handle = (r: ActionResult, successMsg?: string) => {
    if (!r.ok) setStatusMsg(r.reason);
    else setStatusMsg(successMsg ?? "");
    setSelected(null);
    rerender();
  };

  const promoteOpen = state.pendingPromote === viewingPlayer;

  const onHandClick = (i: number) => {
    if (promoteOpen) {
      setStatusMsg("Pick a Benched Pokémon to promote to Active.");
      return;
    }
    if (!myTurn) return;
    const card = me.hand[i];
    if (!card) return;

    if (selected?.kind === "hand" && selected.index === i) {
      setSelected(null);
      return;
    }

    if (isPokemon(card) && isBasic(card)) {
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
        handle(attachEnergy(state, viewingPlayer, selected.index, p.instanceId), `Attached ${card.name}.`);
        return;
      }
      if (card.supertype === "Pokémon" && card.evolvesFrom && side === "me") {
        handle(evolve(state, viewingPlayer, selected.index, p.instanceId), `Evolved into ${card.name}.`);
        return;
      }
      if (card.supertype === "Trainer") {
        const isTool =
          card.subtypes.includes("Pokémon Tool") || card.subtypes.includes("Tool");
        if (isTool && side === "me") {
          const target: TrainerTarget = { kind: "inPlay", instanceId: p.instanceId };
          handle(
            playTrainer(state, viewingPlayer, selected.index, target),
            `Attached ${card.name} to ${p.card.name}.`,
          );
          return;
        }
        if (card.effectId === "gustOppBenched" && side === "opp") {
          const target: TrainerTarget = { kind: "oppInPlay", instanceId: p.instanceId };
          handle(
            playTrainer(state, viewingPlayer, selected.index, target),
            `Played ${card.name}.`,
          );
          return;
        }
        if (card.effectId === "rareCandyEvolve" && side === "me") {
          const target: TrainerTarget = { kind: "inPlay", instanceId: p.instanceId };
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

  const onActivateAbility = (p: PokemonInPlay, abilityIndex: number) => {
    if (!myTurn) return;
    const r = activateAbility(state, viewingPlayer, p.instanceId, abilityIndex);
    handle(
      r.ok ? { ok: true } : { ok: false, reason: r.reason ?? "Cannot activate." },
      r.ok ? `Activated ${p.card.abilities![abilityIndex].name}.` : undefined,
    );
  };

  const onAttack = (atkIndex: number) => {
    if (!myTurn) return;
    handle(attack(state, viewingPlayer, atkIndex));
  };

  const onRetreat = (benchIdx: number) => {
    if (!myTurn) return;
    handle(retreat(state, viewingPlayer, benchIdx), "Retreated.");
  };

  const onEndTurn = () => {
    if (!myTurn) return;
    handle(endTurn(state, viewingPlayer), "Turn ended.");
  };

  const onReset = () => {
    rngRef.current = makeRng(Date.now());
    const fallback = buildDeck(deckSpecs[0]);
    const myDeck = deckForId(myDeckId, fallback);
    const oppDeck = deckForId(oppDeckId, fallback);
    stateRef.current = setupGame(myDeck, oppDeck, rngRef.current, {
      p1Name: gameMode === "local" ? "Player 1" : "You",
      p2Name: gameMode === "local" ? "Player 2" : "CPU",
      p2IsAI: gameMode !== "local",
    });
    // Reset hotseat state: p1 holds the device first; no handoff pending.
    setViewingPlayer("p1");
    setPendingHandoff(null);
    setSelected(null);
    setStatusMsg("");
    rerender();
  };

  // Don't memoize: evolving mutates PokemonInPlay.card in place, so a
  // reference-keyed useMemo would return stale attacks/abilities. These are
  // cheap to recompute per render.
  const myActiveAttacks = (() => {
    if (!me.active) return [];
    const provided = energyProvidedBy(me.active);
    return me.active.card.attacks.map((a, i) => ({
      index: i,
      name: a.name,
      damage: a.damage,
      cost: a.cost,
      payable: canPayCost(provided, a.cost),
    }));
  })();

  const activatableAbilities = [me.active, ...me.bench]
    .filter((p): p is PokemonInPlay => !!p)
    .flatMap((p) =>
      (p.card.abilities ?? [])
        .map((a, i) => ({ p, a, i }))
        .filter(({ a, p }) => a.effect && !p.abilityUsedThisTurn),
    );

  return (
    <div className="app">
      {/* ------------------------- Header ------------------------- */}
      <div className="header">
        <div className="brand">
          <h1>TCGVibes</h1>
          <div className="meta">
            T{state.turn} · {state.players[state.activePlayer].name} · {state.phase}
            <span className="dataset"> · {datasetFormat} {datasetAsOf}</span>
          </div>
        </div>
        <div className="controls-row">
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
            CPU
            <DeckSelect
              value={oppDeckId}
              onChange={setOppDeckId}
              specs={deckSpecs}
              imports={imports}
            />
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={openHands}
              onChange={(e) => setOpenHands(e.target.checked)}
            />
            Open hands
          </label>
          <button onClick={() => setImportOpen(true)}>Import Deck</button>
          <button onClick={() => setPreGameOpen(true)}>Change Decks</button>
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
          onChangeMyDeck={setMyDeckId}
          onChangeOppDeck={setOppDeckId}
          onToggleOpenHands={setOpenHands}
          onChangeMode={setGameMode}
          onOpenImport={() => setImportOpen(true)}
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

      {/* --------------- Opponent hand strip (thin) --------------- */}
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
      <div className="board">
        <PlayerSide
          state={state}
          label={opp.name}
          player={opp}
          isMe={false}
          selected={selected}
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
          onInPlayClick={(p) => onInPlayClick(p, "me")}
          onViewDiscard={(pid) => setDiscardViewer(pid)}
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
            />
          ))}
          {me.hand.length === 0 && <span className="muted">—</span>}
        </div>
        <details className="log-details">
          <summary>Log ({state.log.length})</summary>
          <div className="log-content">
            {state.log.slice(-30).map((e, i) => (
              <div key={i} className={`entry ${e.player}`}>
                [T{e.turn}] {e.player !== "system" && `${state.players[e.player].name} `}
                {e.text}
              </div>
            ))}
          </div>
        </details>
      </div>

      {/* ------------------ Action bar (sticky) ------------------- */}
      <ActionBar
        myTurn={myTurn}
        promoteOpen={promoteOpen}
        statusMsg={statusMsg}
        me={me}
        attacks={myActiveAttacks}
        activatable={activatableAbilities}
        onAttack={onAttack}
        onRetreat={onRetreat}
        onEndTurn={onEndTurn}
        onActivateAbility={onActivateAbility}
      />

      {state.winner && (
        <div className="winner">
          <div className="box">
            <h2>{state.players[state.winner].name} wins!</h2>
            <button className="primary" onClick={onReset}>
              Play again
            </button>
          </div>
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
  onInPlayClick?: (p: PokemonInPlay) => void;
  onViewDiscard?: (player: PlayerId) => void;
}

function PlayerSide({
  state,
  label,
  player,
  isMe,
  selected,
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
          onClick={() => onInPlayClick?.(player.active!)}
        />
      ) : (
        <div className="card empty-slot">No Active</div>
      )}
    </div>
  );

  const benchRow = (
    <div className="bench-row">
      {player.bench.map((p) => (
        <PokemonInPlayView
          key={p.instanceId}
          p={p}
          maxHp={effectiveMaxHp(p, state)}
          selected={selected?.kind === "inPlay" && selected.instanceId === p.instanceId}
          onClick={() => onInPlayClick?.(p)}
        />
      ))}
      {Array.from({ length: 5 - player.bench.length }).map((_, i) => (
        <div key={`empty-${i}`} className="card empty-slot">Empty</div>
      ))}
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
  statusMsg: string;
  me: GameState["players"]["p1"];
  attacks: { index: number; name: string; damage: number; cost: string[]; payable: boolean }[];
  activatable: { p: PokemonInPlay; a: Ability; i: number }[];
  onAttack: (i: number) => void;
  onRetreat: (i: number) => void;
  onEndTurn: () => void;
  onActivateAbility: (p: PokemonInPlay, i: number) => void;
}

function ActionBar({
  myTurn,
  promoteOpen,
  statusMsg,
  me,
  attacks,
  activatable,
  onAttack,
  onRetreat,
  onEndTurn,
  onActivateAbility,
}: ActionBarProps) {
  return (
    <div className="action-bar">
      <div className="status-line">
        {promoteOpen ? (
          <span className="promote-msg">
            Your Active was KO'd — click a Benched Pokémon to promote.
          </span>
        ) : (
          <span className="msg">{statusMsg || (myTurn ? "Your turn." : "CPU thinking…")}</span>
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
              {activatable.map(({ p, a, i }) => (
                <button
                  key={`${p.instanceId}-${i}`}
                  className="ability"
                  disabled={!myTurn || promoteOpen}
                  onClick={() => onActivateAbility(p, i)}
                  title={a.text}
                >
                  {a.name} ({p.card.name})
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="group">
          <div className="group-label">Attacks</div>
          <div className="group-buttons">
            {attacks.length === 0 && <span className="muted">—</span>}
            {attacks.map((a) => (
              <button
                key={a.index}
                disabled={!myTurn || !a.payable || promoteOpen}
                onClick={() => onAttack(a.index)}
                title={a.cost.join(", ")}
              >
                {a.name} ({a.damage})
              </button>
            ))}
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

        <div className="group end">
          <div className="group-label">&nbsp;</div>
          <div className="group-buttons">
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

// ---------------------------------------------------------------------------
//  Deck picker — grouped preset + imported decks
// ---------------------------------------------------------------------------

function DeckSelect({
  value,
  onChange,
  specs,
  imports,
}: {
  value: string;
  onChange: (id: string) => void;
  specs: { id: string; name: string }[];
  imports: ImportedDeck[];
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
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
  onChangeMyDeck,
  onChangeOppDeck,
  onToggleOpenHands,
  onChangeMode,
  onOpenImport,
  onStart,
}: {
  deckSpecs: { id: string; name: string }[];
  imports: ImportedDeck[];
  myDeckId: string;
  oppDeckId: string;
  openHands: boolean;
  gameMode: "vsCPU" | "local";
  onChangeMyDeck: (id: string) => void;
  onChangeOppDeck: (id: string) => void;
  onToggleOpenHands: (v: boolean) => void;
  onChangeMode: (m: "vsCPU" | "local") => void;
  onOpenImport: () => void;
  onStart: () => void;
}) {
  const describe = (id: string): string | null => {
    const imp = imports.find((d) => d.id === id);
    if (imp) return `Imported · ${imp.cards.length} cards`;
    return null;
  };
  const opponentLabel = gameMode === "local" ? "Player 2" : "CPU";
  return (
    <div className="modal-backdrop">
      <div className="modal pregame-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>TCGVibes — Start a game</h2>
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
          Pick a preset for each side or bring your own via <b>Import Deck</b>.
          You'll choose Active and Bench Pokémon in the next step.
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
          </div>
          <div className="pregame-vs">vs</div>
          <div className="pregame-slot">
            <div className="pregame-slot-label">{opponentLabel}</div>
            <DeckSelect
              value={oppDeckId}
              onChange={onChangeOppDeck}
              specs={deckSpecs}
              imports={imports}
            />
            {describe(oppDeckId) && <div className="pregame-slot-note">{describe(oppDeckId)}</div>}
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
          <button onClick={onOpenImport}>Import Deck…</button>
        </div>
        <div className="modal-actions">
          <button className="primary" onClick={onStart}>Start Game</button>
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

  return (
    <div className="modal-backdrop">
      <div className="modal pick-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{pick.label}</h2>
          <span className="pick-counter">
            {selected.length} / {pick.max} picked
          </span>
        </div>
        <div className="pick-source-note">
          {pick.source === "deck" && `Searching your Deck — ${pick.pool.length} eligible card${pick.pool.length === 1 ? "" : "s"}. Prize cards are locked and not part of this search.`}
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
                key={i}
                className={`pick-card${picked ? " picked" : ""}${eligible ? "" : " ineligible"}`}
                onClick={() => toggle(i)}
                title={eligible ? (picked ? "Click to deselect" : "Click to pick") : "Not eligible"}
              >
                <CardView card={c} />
              </div>
            );
          })}
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
