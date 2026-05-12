// Variant picker — a popover/modal that lists every printing of a single
// card name and lets the user click one to select it. Reused from the deck
// builder's grid (when adding a card with multiple printings) and from the
// "Your deck" right-panel (when swapping the art on an already-added card).
//
// The component is cosmetic-only — the engine treats every printing as a
// distinct Card with the same effects. Picking a different printing only
// changes which `id` (and therefore which `imageLarge`) gets persisted to
// the deck entry.

import type { Card } from "../engine/types";

// Inverse of decklistParser's LIMITLESS_TO_SET_CODE map. Re-declared here
// (instead of imported) because DeckBuilderModal already has a copy and
// a third copy in this file keeps it self-contained for testing.
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

export interface VariantPickerProps {
  // The full list of printings to show. Caller is expected to pass every
  // entry from `cardsByName.get(name)` so the picker covers all variants.
  variants: Card[];
  // The currently-selected printing's id (if any) — gets a "current" badge
  // and a checkmark. Pass null/undefined when this is a fresh add.
  currentId?: string | null;
  // Fired when the user clicks a printing tile. Caller decides what to do
  // (add a copy, swap an existing entry's printing, etc).
  onPick: (card: Card) => void;
  // Dismiss without picking.
  onClose: () => void;
}

export function VariantPicker({ variants, currentId, onPick, onClose }: VariantPickerProps) {
  if (variants.length === 0) {
    return null;
  }
  const cardName = variants[0].name;
  return (
    <div
      className="modal-backdrop variant-picker-backdrop"
      onClick={onClose}
      role="dialog"
      aria-label={`Pick a printing of ${cardName}`}
    >
      <div
        className="modal variant-picker-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Pick an art for {cardName}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="variant-picker-grid">
          {variants.map((c) => {
            const isCurrent = currentId === c.id;
            return (
              <button
                key={c.id}
                type="button"
                className={`variant-picker-tile${isCurrent ? " current" : ""}`}
                onClick={() => onPick(c)}
                title={`${c.name} — ${toLimitlessCode(c.setCode)} ${c.number}`}
              >
                <img
                  src={c.imageLarge}
                  alt={`${c.name} (${toLimitlessCode(c.setCode)} ${c.number})`}
                  loading="lazy"
                />
                <span className="variant-picker-printing">
                  {toLimitlessCode(c.setCode)} {c.number}
                  {isCurrent && <span className="variant-picker-check"> ✓</span>}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
