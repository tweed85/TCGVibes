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
import { resolveAiPendingPromote, takeAiTurn } from "./engine/ai";
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

  // Let the AI take its turn automatically; also resolve its pending promote
  // if it was KO'd on the human's turn.
  useEffect(() => {
    if (state.winner !== null) return;
    // AI needs to promote?
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
    // Energy or evolution — need target.
    setSelected({ kind: "hand", index: i });
    setStatusMsg(
      card.supertype === "Energy"
        ? "Select a Pokémon in play to attach to."
        : "Select the Pokémon to evolve.",
    );
  };

  const onInPlayClick = (p: PokemonInPlay, side: "me" | "opp") => {
    // Promote on KO — clicking a benched own Pokémon promotes it.
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
          onActivateAbility={onActivateAbility}
          myTurn={myTurn}
          promoteOpen={promoteOpen}
          attacks={myActiveAttacks}
          statusMsg={statusMsg}
        />
      </div>

      {state.stadium && (
        <div className="stadium-banner">
          Stadium: <b>{state.stadium.card.name}</b> (controller: {state.players[state.stadium.controller].name})
          <div style={{ fontSize: 11, color: "#94a3b8" }}>{state.stadium.card.text}</div>
        </div>
      )}

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
  onActivateAbility?: (p: PokemonInPlay, abilityIndex: number) => void;
  myTurn?: boolean;
  promoteOpen?: boolean;
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
  onActivateAbility,
  myTurn,
  promoteOpen,
  attacks,
  statusMsg,
}: SideProps) {
  // Abilities available on any in-play Pokémon the player controls.
  const activatableAbilities = isMe
    ? [player.active, ...player.bench]
        .filter((p): p is PokemonInPlay => !!p)
        .flatMap((p) =>
          (p.card.abilities ?? [])
            .map((a, i) => ({ p, a, i }))
            .filter(({ a, p }) => a.effect && !p.abilityUsedThisTurn),
        )
    : [];
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
            {promoteOpen && (
              <div style={{ fontSize: 11, color: "#ef4444", fontWeight: 700 }}>
                Your Active was Knocked Out — click a Benched Pokémon to promote.
              </div>
            )}
            {statusMsg && <div style={{ fontSize: 11, color: "#fbbf24" }}>{statusMsg}</div>}
            <div className="stat">
              Energy attached: <span>{player.energyAttachedThisTurn ? "Yes" : "No"}</span>
            </div>
            <div className="stat">
              Supporter: <span>{player.supporterPlayedThisTurn ? "Yes" : "No"}</span>
            </div>
            <div className="stat">
              Retreated: <span>{player.retreatedThisTurn ? "Yes" : "No"}</span>
            </div>
            {player.mulligans > 0 && (
              <div className="stat">Mulligans: <span>{player.mulligans}</span></div>
            )}

            {activatableAbilities.length > 0 && (
              <>
                <div style={{ marginTop: 8, fontSize: 11, color: "#9333ea" }}>Abilities:</div>
                <div className="controls">
                  {activatableAbilities.map(({ p, a, i }) => (
                    <button
                      key={`${p.instanceId}-${i}`}
                      disabled={!myTurn || promoteOpen}
                      onClick={() => onActivateAbility?.(p, i)}
                      title={a.text}
                      style={{ borderColor: "#9333ea" }}
                    >
                      {a.name} ({p.card.name})
                    </button>
                  ))}
                </div>
              </>
            )}

            <div style={{ marginTop: 8, fontSize: 11, color: "#94a3b8" }}>Attacks:</div>
            <div className="controls">
              {attacks?.length === 0 && <span style={{ fontSize: 11 }}>—</span>}
              {attacks?.map((a) => (
                <button
                  key={a.index}
                  disabled={!myTurn || !a.payable || promoteOpen}
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
                <button
                  key={p.instanceId}
                  disabled={!myTurn || promoteOpen || player.retreatedThisTurn}
                  onClick={() => onRetreat?.(i)}
                >
                  {p.card.name}
                </button>
              ))}
            </div>

            <div style={{ marginTop: "auto" }}>
              <button className="primary" disabled={!myTurn || promoteOpen} onClick={onEndTurn}>
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
