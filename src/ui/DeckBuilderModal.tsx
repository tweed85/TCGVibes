// Deck Builder modal — in-app card browser + deck construction.
//
// Lives in its own file + default export so App.tsx can React.lazy-load it.
// First-page traffic doesn't need the full ~2,693-card scan + filter UI, so
// this module is code-split and fetched only when the user opens it.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Card } from "../engine/types";
import { allCards, cardsByName } from "../data/cards";
import {
  buildDeckFromEntries,
  type DeckListEntry,
} from "../data/decklistParser";
import { gameplayKey, variantsOf } from "../data/cardEquivalence";
import { CardView, triggerCardZoom } from "./CardView";
import { VariantPicker } from "./VariantPicker";

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
  // Variant picker state. When non-null, a modal pops over the deck-builder
  // listing every gameplay-equivalent printing. The variants array carries
  // the actual cards to render so the picker isn't recomputing equivalence
  // on every render. `mode` controls whether the pick adds a new copy or
  // swaps an existing entry's printing.
  const [variantPicker, setVariantPicker] = useState<
    | { mode: "add"; variants: Card[] }
    | { mode: "swap"; variants: Card[]; currentId: string }
    | null
  >(null);
  // Phone-only tab toggle: "browse" shows the search grid, "selected" shows
  // the picked-list. Hidden on tablet/desktop where both panes fit side-by-
  // side. The CSS `.mobile-tab--<active>` class on `.builder-body` flips
  // which child is visible at ≤768px.
  const [mobileTab, setMobileTab] = useState<"browse" | "selected">("browse");
  // Side-rail preview: sticky readable card pinned at the top of the right
  // panel. Updated on tile hover/focus and on hovering a deck-list row.
  // Click/right-click on tiles keeps their existing add/zoom behavior.
  const [previewCard, setPreviewCard] = useState<Card | null>(null);
  // Phase 6 keyboard affordances: refs + effect for "/" → focus search,
  // Esc → close (variant picker first, then modal), and Enter / "+" / "-"
  // operate on the focused / preview card.
  const searchInputRef = useRef<HTMLInputElement | null>(null);

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

  // Step 1: filter the full pool. One pass per printing — same as before.
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

  // Step 2: collapse to one tile per **gameplay-equivalent** group. Cards
  // that share a name but have different attacks (e.g. multiple Pikachu
  // printings, each with a different moveset) are NOT grouped — they're
  // mechanically distinct and must be picked separately. The grouping key
  // is the full gameplay signature; printing-specific fields (id, setCode,
  // number, image) are excluded.
  const groupedCards = useMemo(() => {
    const byKey = new Map<string, Card[]>();
    for (const c of filteredCards) {
      const k = gameplayKey(c);
      const list = byKey.get(k);
      if (list) list.push(c);
      else byKey.set(k, [c]);
    }
    const out: Array<{ representative: Card; variants: Card[]; key: string }> = [];
    for (const [key, variants] of byKey.entries()) {
      // Stable representative: lex-min id printing. This keeps the tile
      // image stable across re-renders even if the dataset reshuffles.
      const sorted = variants.slice().sort((a, b) => a.id.localeCompare(b.id));
      out.push({ representative: sorted[0], variants: sorted, key });
    }
    // Preserve filteredCards' ordering by representative position.
    const order = new Map(filteredCards.map((c, i) => [c.id, i] as const));
    out.sort((a, b) => (order.get(a.representative.id)! - order.get(b.representative.id)!));
    return out;
  }, [filteredCards]);

  const displayCards = groupedCards.slice(0, showCount);

  // Default the side-rail preview to the first visible card so the panel
  // isn't empty on open and updates sensibly when filters narrow the grid.
  const effectivePreview =
    previewCard ?? displayCards[0]?.representative ?? null;

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

  // Swap a single copy of fromId to toId. The two ids must share the same
  // card name (the picker only surfaces same-name printings, so this is
  // defensively checked but should never violate). Decrements fromId by 1
  // and increments toId by 1, leaving other copies unchanged.
  function swapPrinting(fromId: string, toId: string) {
    if (fromId === toId) return;
    setSelected((prev) => {
      const next = new Map(prev);
      const fromCount = next.get(fromId) ?? 0;
      if (fromCount <= 0) return prev;
      if (fromCount === 1) next.delete(fromId);
      else next.set(fromId, fromCount - 1);
      next.set(toId, (next.get(toId) ?? 0) + 1);
      return next;
    });
  }

  const canSave =
    name.trim().length > 0 &&
    validation.violations.length === 0 &&
    validation.deck.length === 60 &&
    !nameExists(name);

  // Phase 6 keyboard affordances. Listens at the window so the bindings
  // work whether the focus is on the grid, the deck panel, or nowhere.
  // Skips when the user is typing in an input/textarea (except for Esc,
  // which always closes the appropriate layer). Mutating helpers
  // (setVariantPicker / changeCount / setPreviewCard / onClose) are stable
  // closures captured by ref so the effect dep list stays small.
  const kbStateRef = useRef({
    effectivePreview,
    variantPickerOpen: !!variantPicker,
    onClose,
  });
  kbStateRef.current = {
    effectivePreview,
    variantPickerOpen: !!variantPicker,
    onClose,
  };
  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      return el.isContentEditable;
    };
    const handler = (ev: KeyboardEvent) => {
      const { effectivePreview, variantPickerOpen, onClose } = kbStateRef.current;
      // Escape: close variant picker first, then the modal.
      if (ev.key === "Escape") {
        if (variantPickerOpen) {
          ev.preventDefault();
          setVariantPicker(null);
          return;
        }
        ev.preventDefault();
        onClose();
        return;
      }
      // Other shortcuts are skipped while the user is typing.
      if (isTypingTarget(ev.target)) return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === "/") {
        ev.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select?.();
        return;
      }
      if (!effectivePreview) return;
      if (ev.key === "Enter" || ev.key === "+" || ev.key === "=") {
        ev.preventDefault();
        changeCount(effectivePreview.id, 1);
        return;
      }
      if (ev.key === "-" || ev.key === "_") {
        ev.preventDefault();
        changeCount(effectivePreview.id, -1);
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            ref={searchInputRef}
            className="builder-search"
            type="text"
            value={filter.search}
            onChange={(e) => setFilter((f) => ({ ...f, search: e.target.value }))}
            placeholder="Search card name… (press /)"
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

        <div className="builder-mobile-tabs" role="tablist" aria-label="Deck builder panes">
          <button
            type="button"
            role="tab"
            aria-selected={mobileTab === "browse"}
            className={mobileTab === "browse" ? "active" : ""}
            onClick={() => setMobileTab("browse")}
          >
            Browse
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mobileTab === "selected"}
            className={mobileTab === "selected" ? "active" : ""}
            onClick={() => setMobileTab("selected")}
          >
            Your deck ({totalCount}/60)
          </button>
        </div>

        <div className={`builder-body mobile-tab--${mobileTab}`}>
          <div className="builder-results">
            <div className="builder-results-meta">
              Showing {displayCards.length} of {groupedCards.length} cards ·
              <span style={{ marginLeft: 6, opacity: 0.7 }}>click to add · right-click to zoom</span>
            </div>
            <div className="builder-grid">
              {displayCards.map(({ representative: c, variants }) => {
                // Total copies across ALL printings of this name (rule-of-4 is
                // by name, not per-printing; basic Energy is exempt).
                const nameCount = copiesByName.get(c.name) ?? 0;
                const isBasicEnergy =
                  c.supertype === "Energy" && (c.subtypes ?? []).includes("Basic");
                const atFourCap = !isBasicEnergy && nameCount >= 4;
                const variantCount = variants.length;
                return (
                  <div
                    key={c.name}
                    className={`builder-card${nameCount > 0 ? " picked" : ""}${atFourCap ? " capped" : ""}`}
                    onMouseEnter={() => setPreviewCard(c)}
                    onFocus={() => setPreviewCard(c)}
                    onClick={(ev) => {
                      if (ev.shiftKey || ev.metaKey) {
                        triggerCardZoom(c);
                        return;
                      }
                      if (atFourCap) return;
                      // Single printing → add inline. Multi-printing → open
                      // the variant picker so the user can choose which art.
                      if (variantCount === 1) {
                        changeCount(c.id, 1);
                      } else {
                        setVariantPicker({ mode: "add", variants });
                      }
                    }}
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      triggerCardZoom(c);
                    }}
                    title={
                      atFourCap
                        ? `Already 4× ${c.name} · right-click to zoom`
                        : variantCount > 1
                          ? `${c.name} (${variantCount} arts) · click to pick · right-click to zoom`
                          : `Add ${c.name} · right-click to zoom`
                    }
                  >
                    <CardView card={c} />
                    {nameCount > 0 && <span className="builder-count">×{nameCount}</span>}
                    {variantCount > 1 && (
                      <span className="builder-variant-badge" title={`${variantCount} different prints in pool`}>
                        {variantCount} arts
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {showCount < groupedCards.length && (
              <button
                className="secondary builder-more"
                onClick={() => setShowCount((n) => n + 80)}
              >
                Show {Math.min(80, groupedCards.length - showCount)} more
              </button>
            )}
          </div>

          <div className="builder-selected">
            <div className="builder-preview">
              {effectivePreview ? (
                <>
                  <img
                    className="builder-preview-img"
                    src={effectivePreview.imageLarge}
                    alt={effectivePreview.name}
                    loading="lazy"
                  />
                  <div className="builder-preview-name">{effectivePreview.name}</div>
                  <div className="builder-preview-printing">
                    {toLimitlessCode(effectivePreview.setCode)} {effectivePreview.number}
                  </div>
                </>
              ) : (
                <div className="builder-preview-empty">
                  Hover a card to preview · right-click to zoom
                </div>
              )}
            </div>
            <div className="builder-selected-header">Your deck</div>
            {selectedCards.length === 0 ? (
              <div className="muted" style={{ padding: 12, fontSize: 12 }}>
                No cards picked yet. Click cards on the left to add.
              </div>
            ) : (
              <ul className="builder-selected-list">
                {selectedCards.map(({ card, count }) => {
                  // Variants are GAMEPLAY-equivalent printings of this exact
                  // card (not just same-name) — different attacks would be
                  // different cards mechanically and shouldn't be offered as
                  // an art swap. Filter the same-name pool by gameplay key.
                  const sameName = cardsByName.get(card.name) ?? [];
                  const variants = variantsOf(card, sameName);
                  const variantCount = variants.length;
                  return (
                    <li key={card.id} onMouseEnter={() => setPreviewCard(card)}>
                      <span className="bsel-count">{count}×</span>
                      <span className="bsel-name" title={card.name}>{card.name}</span>
                      <button
                        type="button"
                        className={`bsel-printing${variantCount > 1 ? " swappable" : ""}`}
                        onClick={() => {
                          if (variantCount > 1) {
                            setVariantPicker({ mode: "swap", variants, currentId: card.id });
                          }
                        }}
                        disabled={variantCount <= 1}
                        title={
                          variantCount > 1
                            ? `Click to swap art (${variantCount} prints)`
                            : "Only one print of this card"
                        }
                      >
                        {toLimitlessCode(card.setCode)} {card.number}
                        {variantCount > 1 && <span className="bsel-printing-arts"> · {variantCount} arts</span>}
                      </button>
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
                  );
                })}
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
      {variantPicker && (
        <VariantPicker
          variants={variantPicker.variants}
          currentId={variantPicker.mode === "swap" ? variantPicker.currentId : null}
          onPick={(card) => {
            if (variantPicker.mode === "add") {
              changeCount(card.id, 1);
            } else {
              swapPrinting(variantPicker.currentId, card.id);
            }
            setVariantPicker(null);
          }}
          onClose={() => setVariantPicker(null)}
        />
      )}
    </div>
  );
}
