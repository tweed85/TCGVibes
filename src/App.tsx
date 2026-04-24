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
import type { Ability, Card, GameState, PokemonInPlay } from "./engine/types";
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

  const state = stateRef.current;
  const me = state.players.p1;
  const opp = state.players.p2;
  const myTurn = state.activePlayer === "p1" && state.phase === "main";

  // Persist imported decks across reloads.
  useEffect(() => {
    savePersistedImports(imports);
  }, [imports]);

  // Let the AI take its turn automatically; also resolve its pending promote
  // if it was KO'd on the human's turn.
  useEffect(() => {
    if (preGameOpen) return;
    if (state.winner !== null) return;
    // AI-won coin toss: auto-pick first/second after a short delay.
    if (state.phase === "coinFlip" && state.coinFlip?.step === "chooseFirst" && state.coinFlip.winner === "p2") {
      const t = setTimeout(() => {
        resolveAiCoinChoice(state);
        rerender();
      }, 700);
      return () => clearTimeout(t);
    }
    // Opening setup for the AI: resolve as soon as the human finishes their
    // own setup (or immediately if they already have).
    if (state.phase === "setup" && !state.players.p2.setupComplete) {
      const t = setTimeout(() => {
        resolveAiSetup(state, "p2");
        rerender();
      }, 400);
      return () => clearTimeout(t);
    }
    if (state.pendingPromote === "p2") {
      const t = setTimeout(() => {
        resolveAiPendingPromote(state, "p2");
        rerender();
      }, 400);
      return () => clearTimeout(t);
    }
    if (state.phase === "main" && state.activePlayer === "p2") {
      const t = setTimeout(() => {
        takeAiTurn(state, "p2");
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

  const promoteOpen = state.pendingPromote === "p1";

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
      handle(playBasicToBench(state, "p1", i), `Played ${card.name} to bench.`);
      return;
    }
    if (card.supertype === "Trainer") {
      const isTool =
        card.subtypes.includes("Pokémon Tool") || card.subtypes.includes("Tool");
      const needsTarget =
        isTool ||
        card.effectId === "gustOppBenched";
      if (needsTarget) {
        setSelected({ kind: "hand", index: i });
        setStatusMsg(
          isTool
            ? "Select one of your Pokémon to attach the Tool."
            : `Select target for ${card.name}.`,
        );
        return;
      }
      handle(playTrainer(state, "p1", i), `Played ${card.name}.`);
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
          promoteBenchToActive(state, "p1", benchIdx),
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
        handle(attachEnergy(state, "p1", selected.index, p.instanceId), `Attached ${card.name}.`);
        return;
      }
      if (card.supertype === "Pokémon" && card.evolvesFrom && side === "me") {
        handle(evolve(state, "p1", selected.index, p.instanceId), `Evolved into ${card.name}.`);
        return;
      }
      if (card.supertype === "Trainer") {
        const isTool =
          card.subtypes.includes("Pokémon Tool") || card.subtypes.includes("Tool");
        if (isTool && side === "me") {
          const target: TrainerTarget = { kind: "inPlay", instanceId: p.instanceId };
          handle(
            playTrainer(state, "p1", selected.index, target),
            `Attached ${card.name} to ${p.card.name}.`,
          );
          return;
        }
        if (card.effectId === "gustOppBenched" && side === "opp") {
          const target: TrainerTarget = { kind: "oppInPlay", instanceId: p.instanceId };
          handle(
            playTrainer(state, "p1", selected.index, target),
            `Played ${card.name}.`,
          );
          return;
        }
      }
    }
    setSelected({ kind: "inPlay", instanceId: p.instanceId });
  };

  const onActivateAbility = (p: PokemonInPlay, abilityIndex: number) => {
    if (!myTurn) return;
    const r = activateAbility(state, "p1", p.instanceId, abilityIndex);
    handle(
      r.ok ? { ok: true } : { ok: false, reason: r.reason ?? "Cannot activate." },
      r.ok ? `Activated ${p.card.abilities![abilityIndex].name}.` : undefined,
    );
  };

  const onAttack = (atkIndex: number) => {
    if (!myTurn) return;
    handle(attack(state, "p1", atkIndex));
  };

  const onRetreat = (benchIdx: number) => {
    if (!myTurn) return;
    handle(retreat(state, "p1", benchIdx), "Retreated.");
  };

  const onEndTurn = () => {
    if (!myTurn) return;
    handle(endTurn(state, "p1"), "Turn ended.");
  };

  const onReset = () => {
    rngRef.current = makeRng(Date.now());
    const fallback = buildDeck(deckSpecs[0]);
    const myDeck = deckForId(myDeckId, fallback);
    const oppDeck = deckForId(oppDeckId, fallback);
    stateRef.current = setupGame(myDeck, oppDeck, rngRef.current, {
      p1Name: "You",
      p2Name: "CPU",
    });
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
          onChangeMyDeck={setMyDeckId}
          onChangeOppDeck={setOppDeckId}
          onToggleOpenHands={setOpenHands}
          onOpenImport={() => setImportOpen(true)}
          onStart={() => {
            onReset();
            setPreGameOpen(false);
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

      {!preGameOpen && state.phase === "coinFlip" && state.coinFlip?.step === "chooseFirst" && state.coinFlip.winner === "p1" && (
        <ChooseFirstModal
          result={state.coinFlip.result!}
          guess={state.coinFlip.guess!}
          onChoose={(first) => {
            chooseFirstPlayer(state, "p1", first);
            rerender();
          }}
        />
      )}

      {!preGameOpen && state.phase === "coinFlip" && state.coinFlip?.step === "chooseFirst" && state.coinFlip.winner === "p2" && (
        <CoinResultBanner
          result={state.coinFlip.result!}
          guess={state.coinFlip.guess!}
        />
      )}

      {!preGameOpen && state.phase === "setup" && !state.players.p1.setupComplete && (
        <SetupModal
          hand={state.players.p1.hand}
          mulligans={state.players.p1.mulligans}
          onConfirm={(activeIdx, benchIdxs) => {
            const err = completeSetup(state, "p1", activeIdx, benchIdxs);
            if (err) setStatusMsg(err);
            rerender();
          }}
        />
      )}

      {state.pendingPick && state.pendingPick.player === "p1" && (
        <PickModal
          pick={state.pendingPick}
          onResolve={(idx) => {
            const r = resolvePendingPick(state, "p1", idx);
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
      <div className="board">
        <PlayerSide
          state={state}
          label={opp.name}
          player={opp}
          isMe={false}
          selected={selected}
          onInPlayClick={(p) => onInPlayClick(p, "opp")}
        />
        <PlayerSide
          state={state}
          label={me.name}
          player={me}
          isMe
          selected={selected}
          onInPlayClick={(p) => onInPlayClick(p, "me")}
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
        {state.stadium && (
          <div className="stadium-banner">
            <span>Stadium: <b>{state.stadium.card.name}</b></span>
            <span className="text">
              ({state.players[state.stadium.controller].name}) {state.stadium.card.text}
            </span>
          </div>
        )}
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
}

function PlayerSide({
  state,
  label,
  player,
  isMe,
  selected,
  onInPlayClick,
}: SideProps) {
  return (
    <div className={`side ${isMe ? "me" : "opponent"}`}>
      <div className="side-stats">
        <h3>{label}</h3>
        <div className="prizes">
          {player.prizes.map((_, i) => <div className="prize" key={i} />)}
        </div>
        <div className="stat">Deck <span>{player.deck.length}</span></div>
        <div className="stat">Disc <span>{player.discard.length}</span></div>
        {player.mulligans > 0 && (
          <div className="stat">Mull <span>{player.mulligans}</span></div>
        )}
      </div>

      <div className="play-area">
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
        <div className="bench-slot">
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
      </div>
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
    parsed.parseErrors.length === 0;

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
  onChoose,
}: {
  result: "heads" | "tails";
  guess: "heads" | "tails";
  onChoose: (first: boolean) => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal coin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>You won the flip!</h2>
        </div>
        <p className="modal-hint">
          You called <b>{guess}</b>, the coin landed <b>{result}</b>. Choose who goes first.
        </p>
        <div className="modal-actions">
          <button className="primary" onClick={() => onChoose(true)}>I'll go first</button>
          <button onClick={() => onChoose(false)}>CPU goes first</button>
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
  onChangeMyDeck,
  onChangeOppDeck,
  onToggleOpenHands,
  onOpenImport,
  onStart,
}: {
  deckSpecs: { id: string; name: string }[];
  imports: ImportedDeck[];
  myDeckId: string;
  oppDeckId: string;
  openHands: boolean;
  onChangeMyDeck: (id: string) => void;
  onChangeOppDeck: (id: string) => void;
  onToggleOpenHands: (v: boolean) => void;
  onOpenImport: () => void;
  onStart: () => void;
}) {
  const describe = (id: string): string | null => {
    const imp = imports.find((d) => d.id === id);
    if (imp) return `Imported · ${imp.cards.length} cards`;
    return null;
  };
  return (
    <div className="modal-backdrop">
      <div className="modal pregame-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>TCGVibes — Choose your decks</h2>
        </div>
        <p className="modal-hint">
          Pick a preset or bring your own via <b>Import Deck</b>. You'll choose
          your Active and Bench Pokémon in the next step.
        </p>
        <div className="pregame-grid">
          <div className="pregame-slot">
            <div className="pregame-slot-label">You</div>
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
            <div className="pregame-slot-label">CPU</div>
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
          <label className="toggle">
            <input
              type="checkbox"
              checked={openHands}
              onChange={(e) => onToggleOpenHands(e.target.checked)}
            />
            Open hands (reveal CPU cards)
          </label>
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
