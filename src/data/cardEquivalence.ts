// Two cards are "gameplay equivalent" iff they share every gameplay-relevant
// field — same name + supertype + subtypes + HP + types + retreatCost +
// attacks (full text) + abilities (full text) + weaknesses + resistances
// + rules text. Only the printing-specific fields differ: id, setCode,
// number, imageLarge/imageSmall, regulationMark.
//
// CRITICAL: name alone is NOT enough. Multiple cards share a name across
// sets but carry different attacks (e.g. several Pikachu, Bulbasaur,
// Charizard printings each with a different moveset). Grouping by name
// alone would let the variant picker offer mechanically-different cards
// as if they were the same. The gameplay key below is the canonical
// equivalence test.
//
// The key is a structured string — order-stable, whitespace-normalized,
// and arrays sorted where order doesn't affect gameplay (subtypes, types,
// retreat cost, weaknesses, resistances). Attack and ability ORDER on the
// card IS preserved (attacks are typically ordered by cost; the order is
// part of the card's identity in PTCGL exports too).

import type { Card } from "../engine/types";

function norm(s: string | undefined): string {
  if (!s) return "";
  // Collapse all whitespace to single spaces; trim.
  return s.replace(/\s+/g, " ").trim();
}

function joinSorted(arr: readonly string[]): string {
  return [...arr].sort().join(",");
}

/**
 * Canonical gameplay-equivalence key. Two cards with identical keys are
 * mechanically interchangeable; any field that affects gameplay must be
 * reflected here. Printing-specific fields (id, setCode, number, images,
 * regulationMark) are deliberately excluded so different prints of the
 * same card produce the same key.
 */
export function gameplayKey(card: Card): string {
  const parts: string[] = [];
  parts.push(`name=${norm(card.name)}`);
  parts.push(`supertype=${card.supertype}`);
  parts.push(`subtypes=${joinSorted(card.subtypes ?? [])}`);

  if (card.supertype === "Pokémon") {
    parts.push(`hp=${card.hp}`);
    parts.push(`types=${joinSorted(card.types)}`);
    parts.push(`evolvesFrom=${card.evolvesFrom ?? ""}`);
    parts.push(`retreat=${joinSorted(card.retreatCost ?? [])}`);

    // Attacks — ORDER preserved (PTCGL prints attacks in card order; that
    // ordering is part of the card's identity). Each attack: name, cost
    // (sorted — attack-cost order doesn't matter for gameplay), damage,
    // damageText, full text. `effects` is a runtime cache, not in the key.
    const atks = (card.attacks ?? []).map((a) => {
      const cost = joinSorted(a.cost ?? []);
      return `atk(${norm(a.name)}|cost=${cost}|dmg=${a.damage ?? 0}|dmgT=${a.damageText ?? ""}|text=${norm(a.text)})`;
    });
    parts.push(`attacks=[${atks.join(";")}]`);

    // Abilities — ORDER preserved. Each: name, type (Ability vs Poké-Body),
    // text. `effect` is auto-detected, not part of the key (it's derived
    // from text).
    const abs = (card.abilities ?? []).map((ab) => {
      return `abi(${norm(ab.name)}|t=${ab.type}|text=${norm(ab.text)})`;
    });
    parts.push(`abilities=[${abs.join(";")}]`);

    // Weaknesses + resistances — order doesn't matter.
    const wks = (card.weaknesses ?? []).map((w) => `${w.type}|${w.value}`);
    const res = (card.resistances ?? []).map((r) => `${r.type}|${r.value}`);
    parts.push(`weak=[${joinSorted(wks)}]`);
    parts.push(`res=[${joinSorted(res)}]`);

    // Rule-box text (ex/VSTAR rule clauses) — order doesn't matter.
    const rules = (card.rules ?? []).map(norm);
    parts.push(`rules=[${joinSorted(rules)}]`);
  } else if (card.supertype === "Energy") {
    parts.push(`provides=${joinSorted(card.provides)}`);
    // Energy rules text is the gameplay contract for Special Energy.
    // Basic Energy carries no rules; key still differs because subtypes
    // include "Basic" vs "Special".
    const rules = (
      (card as { rules?: string[] }).rules ?? []
    ).map(norm);
    parts.push(`rules=[${joinSorted(rules)}]`);
  } else {
    // Trainer — text + rules carry the gameplay contract. effectId is
    // auto-detected from the rules text and would re-derive identically
    // for any two same-text printings, so it's redundant; leaving it
    // out keeps the key purely text-driven.
    parts.push(`text=${norm(card.text)}`);
    const rules = (card.rules ?? []).map(norm);
    parts.push(`rules=[${joinSorted(rules)}]`);
  }

  return parts.join("|");
}

/**
 * Returns every card in `pool` that's gameplay-equivalent to `target`.
 * Includes `target` itself if it's in the pool. Used by the deck builder
 * to populate the variant picker with TRUE art variants — same card,
 * different art only.
 */
export function variantsOf(target: Card, pool: readonly Card[]): Card[] {
  const key = gameplayKey(target);
  return pool.filter((c) => gameplayKey(c) === key);
}
