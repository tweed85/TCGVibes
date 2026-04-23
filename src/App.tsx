import { useEffect, useMemo, useRef, useState } from "react";
import {
  attachEnergy,
  attack,
  endTurn,
  evolve,
  playBasicToBench,
  playTrainer,
  retreat,
} from "./engine/actions";
import { takeAiTurn } from "./engine/ai";
import { makeRng } from "./engine/rng";
import { canPayCost, energyProvidedBy, isBasic, isPokemon, setupGame } from "./engine/rules";
import type { ActionResult } from "./engine/actions";
import type { Card, GameState, PokemonInPlay } from "./engine/types";
import { buildDeck, validatedDeckSpecs } from "./data/decks";
import { datasetAsOf, datasetFormat } from "./data/cards";
import { CardView, FaceDownCard, PokemonInPlayView } from "./ui/CardView";

type Selection =
  | { kind: "hand"; index: number }
  | { kind: "inPlay"; instanceId: string }
  | null;

function useForceRerender() {
  const [, set] = useState(0);
  return () => set((x) => x + 1);
}

export default function App() {
  const deckSpecs = useMemo(() => validatedDeckSpecs(), []);
  const [myDeckId, setMyDeckId] = useState(deckSpecs[0]?.id ?? "");
  const [oppDeckId, setOppDeckId] = useState(deckSpecs[1]?.id ?? deckSpecs[0]?.id ?? "");
  const rngRef = useRef(makeRng(42));

  const buildInitial = (): GameState => {
    const myDeck = buildDeck(
      deckSpecs.find((d) => d.id === myDeckId) ?? deckSpecs[0],
    );
    const oppDeck = buildDeck(
      deckSpecs.find((d) => d.id === oppDeckId) ?? deckSpecs[0],
    );
    return setupGame(myDeck, oppDeck, rngRef.current, {
      p1Name: "You",
      p2Name: "CPU",
    });
  };

  const stateRef = useRef<GameState>(buildInitial());
  const rerender = useForceRerender();
  const [selected, setSelected] = useState<Selection>(null);
  const [statusMsg, setStatusMsg] = useState<string>("");

  const state = stateRef.current;
  const me = state.players.p1;
  const opp = state.players.p2;
  const myTurn = state.activePlayer === "p1" && state.phase === "main";

  // Let the AI take its turn automatically.
  useEffect(() => {
    if (state.phase === "main" && state.activePlayer === "p2" && state.winner === null) {
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

  const onHandClick = (i: number) => {
    if (!myTurn) return;
    const card = me.hand[i];
    if (!card) return;

    // If we already selected something, treat as a no-op and reselect the hand card.
    if (selected?.kind === "hand" && selected.index === i) {
      setSelected(null);
      return;
    }

    // Quick paths that don't need a target.
    if (isPokemon(card) && isBasic(card)) {
      handle(playBasicToBench(state, "p1", i), `Played ${card.name} to bench.`);
      return;
    }
    if (card.supertype === "Trainer") {
      handle(playTrainer(state, "p1", i), `Played ${card.name}.`);
      return;
    }
    // Energy or evolution — need target.
    setSelected({ kind: "hand", index: i });
    setStatusMsg(
      card.supertype === "Energy"
        ? "Select a Pokémon in play to attach to."
        : "Select the Pokémon to evolve.",
    );
  };

  const onInPlayClick = (p: PokemonInPlay, side: "me" | "opp") => {
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
    }
    setSelected({ kind: "inPlay", instanceId: p.instanceId });
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
    const myDeck = buildDeck(
      deckSpecs.find((d) => d.id === myDeckId) ?? deckSpecs[0],
    );
    const oppDeck = buildDeck(
      deckSpecs.find((d) => d.id === oppDeckId) ?? deckSpecs[0],
    );
    stateRef.current = setupGame(myDeck, oppDeck, rngRef.current, {
      p1Name: "You",
      p2Name: "CPU",
    });
    setSelected(null);
    setStatusMsg("");
    rerender();
  };

  const myActiveAttacks = useMemo(() => {
    if (!me.active) return [];
    const provided = energyProvidedBy(me.active);
    return me.active.card.attacks.map((a, i) => ({
      index: i,
      name: a.name,
      damage: a.damage,
      cost: a.cost,
      payable: canPayCost(provided, a.cost),
    }));
  }, [me.active, me.active?.attachedEnergy.length]);

  return (
    <div className="app">
      <div className="header">
        <h1>TCGVibes — Pokémon TCG Clone</h1>
        <div className="meta">
          Turn {state.turn} · {state.players[state.activePlayer].name}'s turn · Phase: {state.phase}
          <div style={{ fontSize: 10, opacity: 0.7 }}>
            {datasetFormat} · as of {datasetAsOf}
          </div>
        </div>
        <div className="controls">
          <label style={{ fontSize: 11, display: "flex", flexDirection: "column" }}>
            You
            <select value={myDeckId} onChange={(e) => setMyDeckId(e.target.value)}>
              {deckSpecs.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 11, display: "flex", flexDirection: "column" }}>
            CPU
            <select value={oppDeckId} onChange={(e) => setOppDeckId(e.target.value)}>
              {deckSpecs.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </label>
          <button className="primary" onClick={onReset}>New Game</button>
        </div>
      </div>

      <div className="board">
        {/* Opponent side */}
        <PlayerSide
          label={opp.name}
          player={opp}
          isMe={false}
          selected={selected}
          onInPlayClick={(p) => onInPlayClick(p, "opp")}
        />

        {/* My side */}
        <PlayerSide
          label={me.name}
          player={me}
          isMe
          selected={selected}
          onHandClick={onHandClick}
          onInPlayClick={(p) => onInPlayClick(p, "me")}
          onAttack={onAttack}
          onRetreat={onRetreat}
          onEndTurn={onEndTurn}
          myTurn={myTurn}
          attacks={myActiveAttacks}
          statusMsg={statusMsg}
        />
      </div>

      <div className="log">
        {state.log.slice(-30).map((e, i) => (
          <div key={i} className={`entry ${e.player}`}>
            [T{e.turn}] {e.player !== "system" && `${state.players[e.player].name} `}
            {e.text}
          </div>
        ))}
      </div>

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

interface SideProps {
  label: string;
  player: GameState["players"]["p1"];
  isMe: boolean;
  selected: Selection;
  onHandClick?: (i: number) => void;
  onInPlayClick?: (p: PokemonInPlay) => void;
  onAttack?: (i: number) => void;
  onRetreat?: (benchIdx: number) => void;
  onEndTurn?: () => void;
  myTurn?: boolean;
  attacks?: { index: number; name: string; damage: number; cost: string[]; payable: boolean }[];
  statusMsg?: string;
}

function PlayerSide({
  label,
  player,
  isMe,
  selected,
  onHandClick,
  onInPlayClick,
  onAttack,
  onRetreat,
  onEndTurn,
  myTurn,
  attacks,
  statusMsg,
}: SideProps) {
  return (
    <div className={`side ${isMe ? "me" : "opponent"}`}>
      <div className="zone">
        <h3>Prizes ({player.prizes.length})</h3>
        <div className="prizes">
          {player.prizes.map((_, i) => <div className="prize" key={i} />)}
        </div>
        <div className="stat">Deck: <span>{player.deck.length}</span></div>
        <div className="stat">Discard: <span>{player.discard.length}</span></div>
      </div>

      <div className="zone">
        <h3>{label} — Active & Bench</h3>
        <div className="active-area">
          {player.active ? (
            <PokemonInPlayView
              p={player.active}
              selected={
                selected?.kind === "inPlay" &&
                selected.instanceId === player.active.instanceId
              }
              onClick={() => onInPlayClick?.(player.active!)}
            />
          ) : (
            <div className="card facedown">No Active</div>
          )}
        </div>
        <div className="row">
          {player.bench.map((p) => (
            <PokemonInPlayView
              key={p.instanceId}
              p={p}
              selected={selected?.kind === "inPlay" && selected.instanceId === p.instanceId}
              onClick={() => onInPlayClick?.(p)}
            />
          ))}
          {Array.from({ length: 5 - player.bench.length }).map((_, i) => (
            <div key={`empty-${i}`} className="card facedown" style={{ opacity: 0.3 }}>
              Empty
            </div>
          ))}
        </div>

        {isMe && (
          <>
            <h3>Hand ({player.hand.length})</h3>
            <div className="row">
              {player.hand.map((c: Card, i) => (
                <CardView
                  key={`${c.id}-${i}`}
                  card={c}
                  selected={selected?.kind === "hand" && selected.index === i}
                  onClick={() => onHandClick?.(i)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      <div className="zone">
        {isMe ? (
          <>
            <h3>Controls</h3>
            {statusMsg && <div style={{ fontSize: 11, color: "#fbbf24" }}>{statusMsg}</div>}
            <div className="stat">
              Energy attached: <span>{player.energyAttachedThisTurn ? "Yes" : "No"}</span>
            </div>
            <div className="stat">
              Supporter: <span>{player.supporterPlayedThisTurn ? "Yes" : "No"}</span>
            </div>

            <div style={{ marginTop: 8, fontSize: 11, color: "#94a3b8" }}>Attacks:</div>
            <div className="controls">
              {attacks?.length === 0 && <span style={{ fontSize: 11 }}>—</span>}
              {attacks?.map((a) => (
                <button
                  key={a.index}
                  disabled={!myTurn || !a.payable}
                  onClick={() => onAttack?.(a.index)}
                  title={a.cost.join(", ")}
                >
                  {a.name} ({a.damage})
                </button>
              ))}
            </div>

            <div style={{ marginTop: 8, fontSize: 11, color: "#94a3b8" }}>Retreat to:</div>
            <div className="controls">
              {player.bench.length === 0 && <span style={{ fontSize: 11 }}>—</span>}
              {player.bench.map((p, i) => (
                <button key={p.instanceId} disabled={!myTurn} onClick={() => onRetreat?.(i)}>
                  {p.card.name}
                </button>
              ))}
            </div>

            <div style={{ marginTop: "auto" }}>
              <button className="primary" disabled={!myTurn} onClick={onEndTurn}>
                End Turn
              </button>
            </div>
          </>
        ) : (
          <>
            <h3>Hand ({player.hand.length})</h3>
            <div className="row">
              {player.hand.map((_, i) => <FaceDownCard key={i} />)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
