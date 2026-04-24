// Deck Builder modal — in-app card browser + deck construction.
//
// Lives in its own file + default export so App.tsx can React.lazy-load it.
// First-page traffic doesn't need the full ~2,693-card scan + filter UI, so
// this module is code-split and fetched only when the user opens it.

import { useMemo, useState } from "react";
import type { Card } from "../engine/types";
import { allCards } from "../data/cards";
import {
  buildDeckFromEntries,
  type DeckListEntry,
} from "../data/decklistParser";
import { CardView, triggerCardZoom } from "./CardView";

// Inverse of the LIMITLESS_TO_SET_CODE map inside decklistParser; exported
// entries use the limitless codes so a decklist round-trips legibly.
const SET_CODE_TO_LIMITLESS: Record<string, string> = {
  sv4pt5: "PAF",
  sv5: "TEF",
  sv6: "TWM",
  sv6pt5: "SFA",
  sv7: "SCR",
  sv8: "SSP",
  sv8pt5: "PRE",
  sv9: "JTG",
  sv10: "DRI",
  zsv10pt5: "BLK",
  rsv10pt5: "WHT",
  me1: "MEG",
  me2: "PFL",
  me2pt5: "ASC",
  me3: "POR",
  sve: "SVE",
  svp: "SVP",
};

function toLimitlessCode(setCode: string | undefined): string {
  if (!setCode) return "";
  return SET_CODE_TO_LIMITLESS[setCode] ?? setCode.toUpperCase();
}

export interface DeckBuilderModalProps {
  existingNames: string[];
  onClose: () => void;
  onSave: (
    name: string,
    entries: DeckListEntry[],
    cards: Card[],
    assignTo: "me" | "opp" | "both" | "none",
  ) => void;
}

type BuilderFilter = {
  search: string;
  supertype: "all" | "Pokémon" | "Trainer" | "Energy";
  energyType: string;
  subtype: string;
};

export default function DeckBuilderModal({
  existingNames,
  onClose,
  onSave,
}: DeckBuilderModalProps) {
  const [name, setName] = useState("My Deck");
  const [filter, setFilter] = useState<BuilderFilter>({
    search: "",
    supertype: "all",
    energyType: "",
    subtype: "",
  });
  const [selected, setSelected] = useState<Map<string, number>>(new Map());
  const [showCount, setShowCount] = useState(80);

  const selectedCards: Array<{ card: Card; count: number }> = useMemo(() => {
    const out: Array<{ card: Card; count: number }> = [];
    for (const [id, count] of selected.entries()) {
      const card = allCards.find((c) => c.id === id);
      if (card) out.push({ card, count });
    }
    out.sort((a, b) => {
      const order = (c: Card) =>
        c.supertype === "Pokémon" ? 0 : c.supertype === "Trainer" ? 1 : 2;
      return order(a.card) - order(b.card) || a.card.name.localeCompare(b.card.name);
    });
    return out;
  }, [selected]);

  const totalCount = useMemo(
    () => selectedCards.reduce((n, s) => n + s.count, 0),
    [selectedCards],
  );

  const groups = useMemo(() => {
    let pk = 0, tr = 0, en = 0;
    for (const s of selectedCards) {
      if (s.card.supertype === "Pokémon") pk += s.count;
      else if (s.card.supertype === "Trainer") tr += s.count;
      else en += s.count;
    }
    return { pk, tr, en };
  }, [selectedCards]);

  const validation = useMemo(() => {
    const entries: DeckListEntry[] = selectedCards.map(({ card, count }) => ({
      count,
      name: card.name,
      limitlessSet: toLimitlessCode(card.setCode),
      number: card.number ?? "",
    }));
    const built = buildDeckFromEntries(entries);
    return {
      entries,
      deck: built.deck,
      violations: built.ruleViolations,
    };
  }, [selectedCards]);

  const filteredCards = useMemo(() => {
    const q = filter.search.trim().toLowerCase();
    const out: Card[] = [];
    for (const c of allCards) {
      if (filter.supertype !== "all" && c.supertype !== filter.supertype) continue;
      if (q && !c.name.toLowerCase().includes(q)) continue;
      if (filter.subtype) {
        const subs = (c as { subtypes?: string[] }).subtypes ?? [];
        if (!subs.includes(filter.subtype)) continue;
      }
      if (filter.energyType) {
        const et = filter.energyType;
        if (c.supertype === "Pokémon") {
          if (!c.types.includes(et as typeof c.types[number])) continue;
        } else if (c.supertype === "Energy") {
          if (!c.provides.includes(et as typeof c.provides[number])) continue;
        } else {
          continue;
        }
      }
      out.push(c);
    }
    return out;
  }, [filter]);

  const displayCards = filteredCards.slice(0, showCount);

  function nameExists(n: string): boolean {
    return existingNames.some((e) => e.toLowerCase() === n.trim().toLowerCase());
  }

  function changeCount(cardId: string, delta: number) {
    setSelected((prev) => {
      const next = new Map(prev);
      const cur = next.get(cardId) ?? 0;
      const target = Math.max(0, cur + delta);
      if (target === 0) next.delete(cardId);
      else next.set(cardId, target);
      return next;
    });
  }

  const canSave =
    name.trim().length > 0 &&
    validation.violations.length === 0 &&
    validation.deck.length === 60 &&
    !nameExists(name);

  const saveAndAssign = (assignTo: "me" | "opp" | "both" | "none") => {
    onSave(name.trim(), validation.entries, validation.deck, assignTo);
  };

  const copiesByName = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of selectedCards) m.set(s.card.name, (m.get(s.card.name) ?? 0) + s.count);
    return m;
  }, [selectedCards]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal deck-builder-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Build a Deck</h2>
          <span className={`pick-counter${totalCount === 60 ? " good" : totalCount > 60 ? " over" : ""}`}>
            {totalCount}/60 · P {groups.pk} · T {groups.tr} · E {groups.en}
          </span>
        </div>

        <div className="builder-toolbar">
          <label className="deck-name-field">
            Deck name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Deck"
            />
          </label>
          <input
            className="builder-search"
            type="text"
            value={filter.search}
            onChange={(e) => setFilter((f) => ({ ...f, search: e.target.value }))}
            placeholder="Search card name…"
          />
          <select
            value={filter.supertype}
            onChange={(e) => setFilter((f) => ({ ...f, supertype: e.target.value as BuilderFilter["supertype"] }))}
          >
            <option value="all">All types</option>
            <option value="Pokémon">Pokémon</option>
            <option value="Trainer">Trainer</option>
            <option value="Energy">Energy</option>
          </select>
          <select
            value={filter.subtype}
            onChange={(e) => setFilter((f) => ({ ...f, subtype: e.target.value }))}
          >
            <option value="">Any subtype</option>
            <option value="Basic">Basic</option>
            <option value="Stage 1">Stage 1</option>
            <option value="Stage 2">Stage 2</option>
            <option value="ex">ex</option>
            <option value="MEGA">Mega</option>
            <option value="Tera">Tera</option>
            <option value="Supporter">Supporter</option>
            <option value="Item">Item</option>
            <option value="Stadium">Stadium</option>
            <option value="Pokémon Tool">Tool</option>
            <option value="ACE SPEC">ACE SPEC</option>
          </select>
          <select
            value={filter.energyType}
            onChange={(e) => setFilter((f) => ({ ...f, energyType: e.target.value }))}
          >
            <option value="">Any energy</option>
            <option value="Grass">Grass</option>
            <option value="Fire">Fire</option>
            <option value="Water">Water</option>
            <option value="Lightning">Lightning</option>
            <option value="Psychic">Psychic</option>
            <option value="Fighting">Fighting</option>
            <option value="Darkness">Darkness</option>
            <option value="Metal">Metal</option>
            <option value="Dragon">Dragon</option>
            <option value="Colorless">Colorless</option>
          </select>
        </div>

        <div className="builder-body">
          <div className="builder-results">
            <div className="builder-results-meta">
              Showing {displayCards.length} of {filteredCards.length} matching ·
              <span style={{ marginLeft: 6, opacity: 0.7 }}>click to add · right-click to zoom</span>
            </div>
            <div className="builder-grid">
              {displayCards.map((c) => {
                const count = selected.get(c.id) ?? 0;
                const nameCount = copiesByName.get(c.name) ?? 0;
                const isBasicEnergy =
                  c.supertype === "Energy" && (c.subtypes ?? []).includes("Basic");
                const atFourCap = !isBasicEnergy && nameCount >= 4;
                return (
                  <div
                    key={c.id}
                    className={`builder-card${count > 0 ? " picked" : ""}${atFourCap && count === 0 ? " capped" : ""}`}
                    onClick={(ev) => {
                      if (ev.shiftKey || ev.metaKey) {
                        triggerCardZoom(c);
                        return;
                      }
                      if (atFourCap) return;
                      changeCount(c.id, 1);
                    }}
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      triggerCardZoom(c);
                    }}
                    title={atFourCap ? `Already 4× ${c.name} · right-click to zoom` : `Add ${c.name} · right-click to zoom`}
                  >
                    <CardView card={c} />
                    {count > 0 && <span className="builder-count">×{count}</span>}
                  </div>
                );
              })}
            </div>
            {showCount < filteredCards.length && (
              <button
                className="secondary builder-more"
                onClick={() => setShowCount((n) => n + 80)}
              >
                Show {Math.min(80, filteredCards.length - showCount)} more
              </button>
            )}
          </div>

          <div className="builder-selected">
            <div className="builder-selected-header">Your deck</div>
            {selectedCards.length === 0 ? (
              <div className="muted" style={{ padding: 12, fontSize: 12 }}>
                No cards picked yet. Click cards on the left to add.
              </div>
            ) : (
              <ul className="builder-selected-list">
                {selectedCards.map(({ card, count }) => (
                  <li key={card.id}>
                    <span className="bsel-count">{count}×</span>
                    <span className="bsel-name" title={card.name}>{card.name}</span>
                    <span className="bsel-printing">{toLimitlessCode(card.setCode)} {card.number}</span>
                    <button
                      className="bsel-btn"
                      onClick={() => changeCount(card.id, -1)}
                      title="Remove one"
                    >−</button>
                    <button
                      className="bsel-btn"
                      onClick={() => changeCount(card.id, 1)}
                      title="Add one"
                    >+</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {validation.violations.length > 0 && (
          <div className="builder-violations">
            {validation.violations.map((v, i) => <div key={i}>⚠ {v}</div>)}
          </div>
        )}
        {nameExists(name) && (
          <div className="builder-violations">⚠ A deck named "{name.trim()}" already exists.</div>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button disabled={!canSave} onClick={() => saveAndAssign("none")}>Save only</button>
          <button disabled={!canSave} onClick={() => saveAndAssign("me")}>Save + Use as You</button>
          <button disabled={!canSave} onClick={() => saveAndAssign("opp")}>Save + Use as Opp</button>
          <button className="primary" disabled={!canSave} onClick={() => saveAndAssign("both")}>
            Save + Use for Both
          </button>
        </div>
      </div>
    </div>
  );
}
