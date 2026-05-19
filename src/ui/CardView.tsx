import { memo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import type { Card, EnergyCard, PokemonCard, PokemonInPlay } from "../engine/types";

// Shared "zoom" subscriber — the top-level App wires a listener that
// intercepts shift+click / right-click on any CardView and renders a large
// zoom modal. Anything interested (basically just App) can call
// setZoomSubscriber with a handler.
let zoomHandler: ((card: Card) => void) | null = null;
export function setCardZoomHandler(fn: ((card: Card) => void) | null): void {
  zoomHandler = fn;
}

// Imperatively trigger the zoom modal (used by wrapper components that want
// their own right-click / keyboard handlers to open the zoom overlay).
export function triggerCardZoom(card: Card): void {
  zoomHandler?.(card);
}

const ENERGY_ABBR: Record<string, string> = {
  Fire: "Fr",
  Water: "W",
  Grass: "G",
  Lightning: "L",
  Psychic: "P",
  Fighting: "Ft",
  Darkness: "Dk",
  Metal: "M",
  Dragon: "Dr",
  Fairy: "Fy",
  Colorless: "C",
};

function EnergyTypeMark({ type }: { type: string }) {
  switch (type) {
    case "Fire":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M13.6 2.8c.5 3.1-.8 4.9-2 6.3-.8 1-1.5 1.9-1.3 3.2 1.5-.7 2.4-1.9 2.9-3.4 2.9 2.1 4.4 4.4 4.4 7 0 3.1-2.3 5.3-5.6 5.3s-5.6-2.2-5.6-5.3c0-2.1 1-3.8 2.7-5.6 1.8-1.8 3.2-3.7 4.5-7.5Z" />
        </svg>
      );
    case "Water":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2.5s6.2 6.8 6.2 11.7A6.2 6.2 0 1 1 5.8 14.2C5.8 9.3 12 2.5 12 2.5Z" />
        </svg>
      );
    case "Grass":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20.5 3.5C11.2 3.5 5 8.4 5 15.3c0 2.2 1.4 4 3.8 4.7 1.2-4.9 4.6-8.5 9.4-10.5-3.6 2.5-5.9 5.8-6.9 10.1 5.7-.8 9.2-6.2 9.2-16.1Z" />
        </svg>
      );
    case "Lightning":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M13.9 2 5.6 13.1h5.2L9.8 22l8.6-12.2h-5.3L13.9 2Z" />
        </svg>
      );
    case "Psychic":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4.2a7.8 7.8 0 1 0 7.8 7.8h-3.2a4.6 4.6 0 1 1-4.6-4.6V4.2Z" />
          <circle cx="12" cy="12" r="2.4" />
        </svg>
      );
    case "Fighting":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6.3 10.3h11.4c1.2 0 2.1 1 2.1 2.1v2.1c0 3.2-2.6 5.7-5.7 5.7h-3.3c-3.6 0-6.6-2.9-6.6-6.6v-1.2c0-1.2.9-2.1 2.1-2.1Z" />
          <path d="M6.8 4.2h1.6v6.1H5.2V5.8c0-.9.7-1.6 1.6-1.6Zm4 0h1.7v6.1H9.1V5.9c0-.9.8-1.7 1.7-1.7Zm4.2.6h1.5c.9 0 1.6.7 1.6 1.6v3.9h-3.2V4.8Z" />
        </svg>
      );
    case "Darkness":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M15.8 3.5a8.7 8.7 0 1 0 0 17 7.4 7.4 0 1 1 0-17Z" />
        </svg>
      );
    case "Metal":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m12 2.8 8 4.6v9.2l-8 4.6-8-4.6V7.4l8-4.6Zm0 4.1-4.4 2.6v5l4.4 2.6 4.4-2.6v-5L12 6.9Z" />
        </svg>
      );
    case "Dragon":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2.6 20.4 12 12 21.4 3.6 12 12 2.6Zm0 5.1L8.1 12l3.9 4.3 3.9-4.3L12 7.7Z" />
        </svg>
      );
    case "Fairy":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m12 2.8 2.1 6.2h6.5l-5.2 3.8 2 6.4-5.4-3.9-5.4 3.9 2-6.4L3.4 9h6.5L12 2.8Z" />
        </svg>
      );
    case "Colorless":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="7.6" />
        </svg>
      );
    default:
      return <span className="energy-fallback">{type.slice(0, 2)}</span>;
  }
}

const ENERGY_VISIBLE_LIMIT = 4;
const ENERGY_COLLAPSE_VISIBLE = 3;
const TOOL_VISIBLE_LIMIT = 2;

function energyTokenModel(e: EnergyCard): {
  primary: string;
  types: string[];
  isWild: boolean;
  className: string;
  code: string;
} {
  const types = e.provides ?? ["Colorless"];
  const primary = types[0] ?? "Colorless";
  const distinct = new Set(types);
  const isWild = distinct.size > 1;
  return {
    primary,
    types,
    isWild,
    className: `energy-token energy-pip energy-${isWild ? "wild" : primary}`,
    code: isWild ? "*" : (ENERGY_ABBR[primary] ?? primary.slice(0, 2)),
  };
}

function EnergyToken({ energy, index }: { energy: EnergyCard; index: number }) {
  const model = energyTokenModel(energy);
  return (
    <span
      className={model.className}
      style={{ "--stack-index": index } as CSSProperties}
      title={`${energy.name} (${model.types.join("/")})`}
      aria-label={`${energy.name}, provides ${model.types.join("/")}`}
    >
      {model.isWild ? <span className="energy-wild-mark" aria-hidden="true" /> : <EnergyTypeMark type={model.primary} />}
      <span className="energy-sr-code">{model.code}</span>
    </span>
  );
}

function EnergyOverflowToken({ hidden, energies }: { hidden: number; energies: EnergyCard[] }) {
  return (
    <span
      className="energy-token energy-stack-count"
      title={`Additional Energy: ${energies.map((e) => e.name).join(", ")}`}
      aria-label={`${hidden} additional attached Energy`}
    >
      +{hidden}
    </span>
  );
}

type ToolIconKind =
  | "balloon"
  | "amulet"
  | "capsule"
  | "berry"
  | "bangle"
  | "chip"
  | "counter"
  | "weight"
  | "bomb"
  | "gem"
  | "fan"
  | "baton"
  | "cape"
  | "band"
  | "orb"
  | "pearl"
  | "helmet"
  | "belt"
  | "glass"
  | "board"
  | "crystal"
  | "brace"
  | "hypno"
  | "tm"
  | "scale";

interface ToolIconSpec {
  kind: ToolIconKind;
  fg: string;
  bg1: string;
  bg2: string;
  mark?: string;
}

const TOOL_ICON_OVERRIDES: Record<string, ToolIconSpec> = {
  "Air Balloon": { kind: "balloon", fg: "#fef3c7", bg1: "#38bdf8", bg2: "#7c3aed" },
  "Amulet of Hope": { kind: "amulet", fg: "#fff7ed", bg1: "#f59e0b", bg2: "#ec4899" },
  "Ancient Booster Energy Capsule": { kind: "capsule", fg: "#fef3c7", bg1: "#b45309", bg2: "#7c2d12", mark: "A" },
  "Babiri Berry": { kind: "berry", fg: "#111827", bg1: "#facc15", bg2: "#94a3b8", mark: "B" },
  "Binding Mochi": { kind: "orb", fg: "#f5d0fe", bg1: "#a855f7", bg2: "#4c1d95", mark: "M" },
  "Brave Bangle": { kind: "bangle", fg: "#fff7ed", bg1: "#f97316", bg2: "#be123c" },
  "Colbur Berry": { kind: "berry", fg: "#e0e7ff", bg1: "#111827", bg2: "#6366f1", mark: "C" },
  "Core Memory": { kind: "chip", fg: "#cffafe", bg1: "#0891b2", bg2: "#164e63" },
  "Counter Gain": { kind: "counter", fg: "#dcfce7", bg1: "#16a34a", bg2: "#166534" },
  "Cynthia's Power Weight": { kind: "weight", fg: "#f8fafc", bg1: "#64748b", bg2: "#1e293b" },
  "Deluxe Bomb": { kind: "bomb", fg: "#fee2e2", bg1: "#ef4444", bg2: "#7f1d1d" },
  "Future Booster Energy Capsule": { kind: "capsule", fg: "#e0f2fe", bg1: "#06b6d4", bg2: "#4338ca", mark: "F" },
  "Gravity Gemstone": { kind: "gem", fg: "#f5d0fe", bg1: "#7c3aed", bg2: "#1e1b4b" },
  "Haban Berry": { kind: "berry", fg: "#f3e8ff", bg1: "#c084fc", bg2: "#7c3aed", mark: "H" },
  "Handheld Fan": { kind: "fan", fg: "#ecfeff", bg1: "#22d3ee", bg2: "#0f766e" },
  "Heavy Baton": { kind: "baton", fg: "#fef3c7", bg1: "#f59e0b", bg2: "#78350f" },
  "Hero's Cape": { kind: "cape", fg: "#fee2e2", bg1: "#dc2626", bg2: "#1d4ed8" },
  "Hop's Choice Band": { kind: "band", fg: "#dcfce7", bg1: "#22c55e", bg2: "#15803d" },
  "Light Ball": { kind: "orb", fg: "#111827", bg1: "#fde047", bg2: "#f97316", mark: "L" },
  "Lillie's Pearl": { kind: "pearl", fg: "#082f49", bg1: "#e0f2fe", bg2: "#fdf2f8" },
  "Lucky Helmet": { kind: "helmet", fg: "#fef9c3", bg1: "#eab308", bg2: "#854d0e", mark: "L" },
  "Maximum Belt": { kind: "belt", fg: "#fee2e2", bg1: "#ef4444", bg2: "#111827" },
  "Occa Berry": { kind: "berry", fg: "#fff7ed", bg1: "#f97316", bg2: "#b91c1c", mark: "O" },
  "Passho Berry": { kind: "berry", fg: "#dbeafe", bg1: "#3b82f6", bg2: "#1e40af", mark: "P" },
  "Payapa Berry": { kind: "berry", fg: "#fce7f3", bg1: "#ec4899", bg2: "#9333ea", mark: "P" },
  Powerglass: { kind: "glass", fg: "#d1fae5", bg1: "#10b981", bg2: "#047857" },
  "Punk Helmet": { kind: "helmet", fg: "#f5d0fe", bg1: "#db2777", bg2: "#111827", mark: "P" },
  "Rescue Board": { kind: "board", fg: "#e0f2fe", bg1: "#0ea5e9", bg2: "#0369a1" },
  "Sacred Charm": { kind: "amulet", fg: "#ecfeff", bg1: "#14b8a6", bg2: "#0f766e" },
  "Sparkling Crystal": { kind: "crystal", fg: "#f0fdfa", bg1: "#22d3ee", bg2: "#a855f7" },
  "Survival Brace": { kind: "brace", fg: "#dcfce7", bg1: "#65a30d", bg2: "#365314" },
  "Team Rocket's Hypnotizer": { kind: "hypno", fg: "#f5d0fe", bg1: "#7c3aed", bg2: "#111827", mark: "R" },
  "Technical Machine: Fluorite": { kind: "tm", fg: "#f0fdfa", bg1: "#2dd4bf", bg2: "#4338ca", mark: "TM" },
  "Thick Scale": { kind: "scale", fg: "#ecfccb", bg1: "#84cc16", bg2: "#166534" },
};

function toolInitials(card: Card): string {
  const words = card.name.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "T";
}

function toolIconSpec(card: Card): ToolIconSpec {
  const exact = TOOL_ICON_OVERRIDES[card.name];
  if (exact) return exact;
  const n = card.name.toLowerCase();
  if (n.includes("berry")) return { kind: "berry", fg: "#fff7ed", bg1: "#ef4444", bg2: "#7f1d1d", mark: toolInitials(card).slice(0, 1) };
  if (n.includes("helmet")) return { kind: "helmet", fg: "#f8fafc", bg1: "#64748b", bg2: "#0f172a", mark: toolInitials(card).slice(0, 1) };
  if (n.includes("capsule")) return { kind: "capsule", fg: "#e0f2fe", bg1: "#06b6d4", bg2: "#4338ca", mark: toolInitials(card).slice(0, 1) };
  if (n.includes("band")) return { kind: "band", fg: "#dcfce7", bg1: "#22c55e", bg2: "#15803d" };
  if (n.includes("belt")) return { kind: "belt", fg: "#fee2e2", bg1: "#ef4444", bg2: "#111827" };
  if (n.includes("charm") || n.includes("amulet")) return { kind: "amulet", fg: "#ecfeff", bg1: "#14b8a6", bg2: "#0f766e" };
  return { kind: "chip", fg: "#e2e8f0", bg1: "#475569", bg2: "#0f172a", mark: toolInitials(card) };
}

function ToolIcon({ card }: { card: Card }) {
  const spec = toolIconSpec(card);
  const style = {
    "--tool-fg": spec.fg,
    "--tool-bg1": spec.bg1,
    "--tool-bg2": spec.bg2,
  } as CSSProperties;
  const mark = spec.mark ?? toolInitials(card).slice(0, 1);
  return (
    <span className={`tool-icon tool-${spec.kind}`} style={style} aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <ToolIconShape kind={spec.kind} />
      </svg>
      {(spec.mark || spec.kind === "berry" || spec.kind === "capsule" || spec.kind === "helmet" || spec.kind === "tm" || spec.kind === "orb") && (
        <span className="tool-mark">{mark}</span>
      )}
    </span>
  );
}

function ToolChip({ card, index }: { card: Card; index: number }) {
  const image = card.imageSmall ?? card.imageLarge;
  return (
    <span
      className="tool-chip tool-badge"
      style={{ "--stack-index": index } as CSSProperties}
      title={card.name}
      aria-label={card.name}
    >
      <span className="tool-card-tab" aria-hidden="true">
        {image ? <img src={image} alt="" loading="lazy" /> : <ToolIcon card={card} />}
      </span>
      <span className="tool-chip-glint" aria-hidden="true" />
      <span className="tool-chip-sr">{card.name}</span>
    </span>
  );
}

function ToolIconShape({ kind }: { kind: ToolIconKind }) {
  switch (kind) {
    case "balloon":
      return <><path d="M12 3.2c3.5 0 6 2.6 6 5.9 0 4.1-4 7.3-5.1 8.1h-1.8C10 16.4 6 13.2 6 9.1c0-3.3 2.5-5.9 6-5.9Z" /><path d="M10.5 17.2h3l-1.5 2.2-1.5-2.2Zm1.5 2.1v2" /></>;
    case "amulet":
      return <><path d="M12 3.2 18.8 8 16.2 20H7.8L5.2 8 12 3.2Z" /><path d="m12 7.4 1.2 2.6 2.9.4-2.1 2 0.5 2.9-2.5-1.4-2.5 1.4.5-2.9-2.1-2 2.9-.4L12 7.4Z" /></>;
    case "capsule":
      return <><path d="M6.9 17.1a4.2 4.2 0 0 1 0-5.9l4.3-4.3a4.2 4.2 0 1 1 5.9 5.9l-4.3 4.3a4.2 4.2 0 0 1-5.9 0Z" /><path d="m9.5 8.6 5.9 5.9" /></>;
    case "berry":
      return <><path d="M12 7.8c4.6 0 7.1 2.4 7.1 6.1 0 4-3.2 6.9-7.1 6.9s-7.1-2.9-7.1-6.9c0-3.7 2.5-6.1 7.1-6.1Z" /><path d="M12 8.2c.8-3 2.8-4.5 6-4.4-.5 3.3-2.5 4.8-6 4.4Z" /></>;
    case "bangle":
      return <><path d="M6.2 12a5.8 5.8 0 1 0 11.6 0 5.8 5.8 0 0 0-11.6 0Zm3 0a2.8 2.8 0 1 1 5.6 0 2.8 2.8 0 0 1-5.6 0Z" /><path d="M18.3 5.7 20.5 8l-2.2 2.2L16 8l2.3-2.3Z" /></>;
    case "chip":
      return <><path d="M7 7h10v10H7V7Z" /><path d="M9 3v4m3-4v4m3-4v4M9 17v4m3-4v4m3-4v4M3 9h4m-4 3h4m-4 3h4m10-6h4m-4 3h4m-4 3h4" /></>;
    case "counter":
      return <><path d="M6 7h8.8c2.6 0 4.2 1.7 4.2 4s-1.6 4-4.2 4H9.4" /><path d="m10 4-4 3 4 3M14 12h6M17 9v6" /></>;
    case "weight":
      return <><path d="M8 9h8l2.2 10H5.8L8 9Z" /><path d="M9.4 9a2.6 2.6 0 1 1 5.2 0" /></>;
    case "bomb":
      return <><path d="M7 13.5a6 6 0 1 0 12 0 6 6 0 0 0-12 0Z" /><path d="M15.6 7.8 18.8 4.6M17.6 4.2l2.2 2.2M5.3 6.8l2.3 2.3" /></>;
    case "gem":
    case "crystal":
      return <><path d="M12 3 20 9l-8 12L4 9l8-6Z" /><path d="M4 9h16M8.5 9 12 21 15.5 9 12 3 8.5 9Z" /></>;
    case "fan":
      return <><path d="M12 20c-3.4-4.6-5.3-8.1-5.8-13.7 3.5 1.1 5.4 4.3 5.8 13.7Z" /><path d="M12 20c.4-9.4 2.3-12.6 5.8-13.7-.5 5.6-2.4 9.1-5.8 13.7Z" /><path d="M7.5 19h9" /></>;
    case "baton":
      return <><path d="M6 18 18 6" /><path d="m15.7 3.7 4.6 4.6M3.7 15.7l4.6 4.6" /><path d="M9.8 14.2 14.2 9.8" /></>;
    case "cape":
      return <><path d="M8 4h8l2.4 16c-2.6-1.3-4.7-1.4-6.4-.4-1.7-1-3.8-.9-6.4.4L8 4Z" /><path d="M8 4c1.1 1.4 2.4 2.1 4 2.1s2.9-.7 4-2.1" /></>;
    case "band":
      return <><path d="M5 15.5C8.6 9.8 13.2 6.5 19 5.3c-.9 5.9-4.2 10.5-10 13.8L5 15.5Z" /><path d="m8.8 12.8 2.4 2.4M12 9.8l2.2 2.2" /></>;
    case "orb":
      return <><circle cx="12" cy="12" r="7.2" /><path d="M8 12h8M12 8v8" /></>;
    case "pearl":
      return <><circle cx="12" cy="12" r="6.8" /><path d="M9.2 8.8c1.3-1.1 3.2-1.4 5-.7" /></>;
    case "helmet":
      return <><path d="M5.5 13.5C5.5 8.8 8.2 5 12 5s6.5 3.8 6.5 8.5v3H5.5v-3Z" /><path d="M5.5 14h13M8.5 17v2.2h7V17" /></>;
    case "belt":
      return <><path d="M3 9h18v6H3V9Z" /><path d="M9 8h6v8H9V8Z" /><path d="M11 12h2.5" /></>;
    case "glass":
      return <><path d="M10 5h4v7l4 7H6l4-7V5Z" /><path d="M8 16h8M9 5h6" /></>;
    case "board":
      return <><path d="M4 15.5 17 5l3 3-13 10.5-3-3Z" /><path d="M7 18.5h8M6.2 12.8l4.8 4.8" /></>;
    case "brace":
      return <><path d="M6.5 12a5.5 5.5 0 0 0 8.8 4.4l-2.1-2.1A2.5 2.5 0 1 1 12 9.5V6.4a5.5 5.5 0 0 0-5.5 5.6Z" /><path d="M15 6.5h4v4" /></>;
    case "hypno":
      return <><path d="M5 12a7 7 0 1 0 14 0 7 7 0 0 0-14 0Z" /><path d="M8 12c1.4-3.2 6.6-3.2 8 0-1.4 3.2-6.6 3.2-8 0Z" /><circle cx="12" cy="12" r="1.8" /></>;
    case "tm":
      return <><path d="M5 5h14v14H5V5Z" /><path d="M8 9h8M8 12h8M8 15h5" /></>;
    case "scale":
      return <><path d="M12 4c4.3 2.5 6.4 5.9 6.2 10.3-2.6 1.2-4.7 3.1-6.2 5.7-1.5-2.6-3.6-4.5-6.2-5.7C5.6 9.9 7.7 6.5 12 4Z" /><path d="M8 12h8M9 15h6M10 9h4" /></>;
  }
}

function maybeZoom(card: Card, ev: MouseEvent): boolean {
  if (!zoomHandler) return false;
  if (ev.shiftKey || ev.metaKey || ev.button === 2) {
    ev.preventDefault();
    ev.stopPropagation();
    zoomHandler(card);
    return true;
  }
  return false;
}

// Pointer-event handler for the three card gestures: tap (default click),
// long-press → zoom (touch / mouse), and drag (when caller opts in via
// `onDragStart`). All three share a single pointerdown:
//   • move >8px before 500ms → DRAG (cancels long-press, suppresses click)
//   • hold 500ms without movement → LONG-PRESS (suppresses click, fires zoom)
//   • release without either → CLICK
// `consumeNextClick()` returns true once if the trailing pointerup should
// suppress the synthetic click (because zoom or drag fired in its place).
interface CardGestureOpts {
  onDragStart?: (ev: PointerEvent<HTMLElement>) => void;
  onDragMove?: (ev: PointerEvent<HTMLElement>) => void;
  onDragEnd?: (ev: PointerEvent<HTMLElement>) => void;
}

function useCardGesture(
  card: Card,
  opts: CardGestureOpts = {},
): {
  pointerProps: {
    onPointerDown: (ev: PointerEvent<HTMLElement>) => void;
    onPointerUp: (ev: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (ev: PointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
    onPointerMove: (ev: PointerEvent<HTMLElement>) => void;
  };
  consumeNextClick: () => boolean;
} {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const dragMode = useRef(false);
  const captured = useRef<{ el: HTMLElement; pointerId: number } | null>(null);
  const fired = useRef(false);
  // Read drag callbacks through a ref so the hook doesn't re-bind handlers
  // when the parent re-renders (which would invalidate any in-flight drag).
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const reset = () => {
    clearTimer();
    startPos.current = null;
    dragMode.current = false;
    if (captured.current) {
      try {
        captured.current.el.releasePointerCapture(captured.current.pointerId);
      } catch {
        // ignore — capture may have already been released by the browser
      }
      captured.current = null;
    }
  };
  const consumeNextClick = () => {
    if (fired.current) {
      fired.current = false;
      return true;
    }
    return false;
  };
  return {
    pointerProps: {
      onPointerDown: (ev) => {
        // Only react to primary touch / pen / mouse-left so right-click
        // still routes through `onContextMenu`.
        if (ev.button !== 0 && ev.pointerType === "mouse") return;
        startPos.current = { x: ev.clientX, y: ev.clientY };
        fired.current = false;
        dragMode.current = false;
        timer.current = setTimeout(() => {
          // Long-press wins only if drag hasn't claimed the gesture.
          if (dragMode.current) return;
          fired.current = true;
          timer.current = null;
          if (zoomHandler) zoomHandler(card);
        }, 500);
      },
      onPointerUp: (ev) => {
        if (dragMode.current && optsRef.current.onDragEnd) {
          optsRef.current.onDragEnd(ev);
          fired.current = true; // suppress trailing click
        }
        reset();
      },
      onPointerCancel: () => {
        // Treat as drag-cancel: don't fire a drop; just clean up.
        if (dragMode.current) fired.current = true;
        reset();
      },
      onPointerLeave: () => {
        // Pointer capture (set during drag) means we keep receiving move /
        // up events even after leaving — so only abort when NOT dragging.
        if (!dragMode.current) reset();
      },
      onPointerMove: (ev) => {
        if (dragMode.current) {
          optsRef.current.onDragMove?.(ev);
          return;
        }
        if (!startPos.current) return;
        const dx = ev.clientX - startPos.current.x;
        const dy = ev.clientY - startPos.current.y;
        const dist2 = dx * dx + dy * dy;
        // Drag threshold (8px) — promote to drag if caller opted in.
        // Touch input is excluded: dragging-from-hand on a phone is
        // fiddly (the finger covers the card + drop targets are too
        // small for accurate aim), so touch users fall through to the
        // tap-then-pick-target click flow. 2-in-1 devices still get
        // drag for the mouse — pointerType is per-event, not global.
        if (
          dist2 > 64 &&
          optsRef.current.onDragStart &&
          ev.pointerType !== "touch"
        ) {
          dragMode.current = true;
          clearTimer();
          // Pointer capture keeps move/up firing on this element even when
          // the cursor wanders over a drop target — clientX/Y stays valid
          // and elementFromPoint resolves the target independently.
          try {
            ev.currentTarget.setPointerCapture(ev.pointerId);
            captured.current = { el: ev.currentTarget as HTMLElement, pointerId: ev.pointerId };
          } catch {
            // ignore — fall back to bubbling events
          }
          optsRef.current.onDragStart(ev);
          return;
        }
        // Existing tap-cancel threshold (10px) for the long-press path so a
        // small jitter on touch doesn't cancel zoom prematurely.
        if (dist2 > 100) clearTimer();
      },
    },
    consumeNextClick,
  };
}

// Back-compat alias for callers that only need tap + long-press (no drag).
function useCardLongPress(card: Card) {
  return useCardGesture(card);
}

interface Props {
  card: Card;
  selected?: boolean;
  onClick?: () => void;
  /** Drag-from-hand wiring. Caller passes onDragStart to opt in; the gesture
   *  hook handles pointer capture, the long-press / click / drag
   *  disambiguation, and forwards onDragMove / onDragEnd. */
  onDragStart?: (ev: PointerEvent<HTMLElement>) => void;
  onDragMove?: (ev: PointerEvent<HTMLElement>) => void;
  onDragEnd?: (ev: PointerEvent<HTMLElement>) => void;
  /** Visual cue while the user is mid-drag from this card. */
  dragging?: boolean;
  /** Phase 1 preflight: when set, the card is illegal to play right now and
   *  the reason should appear in the tooltip. Click handler still fires —
   *  the engine returns the same reason via ActionResult.reason. */
  illegalReason?: string;
}

// Compact tooltip text describing the whole card, shown via the `title`
// attribute on hover so the UI stays dense but details are still accessible.
function cardTooltip(card: Card): string {
  const lines: string[] = [card.name];
  if (card.supertype === "Pokémon") {
    lines.push(`${card.subtypes.join(" · ")} · ${card.types.join("/")} · HP ${card.hp}`);
    if (card.evolvesFrom) lines.push(`Evolves from ${card.evolvesFrom}`);
    if (card.abilities?.length) {
      for (const ab of card.abilities) {
        lines.push(`\n[${ab.type}] ${ab.name}: ${ab.text}`);
      }
    }
    for (const a of card.attacks) {
      const cost = a.cost.length ? a.cost.join("+") : "—";
      lines.push(`\n${cost} · ${a.name} (${a.damageText ?? a.damage})`);
      if (a.text) lines.push(a.text);
    }
    if (card.weaknesses?.length) {
      lines.push(`\nWeakness: ${card.weaknesses.map((w) => `${w.type} ${w.value}`).join(", ")}`);
    }
    if (card.resistances?.length) {
      lines.push(`Resistance: ${card.resistances.map((w) => `${w.type} ${w.value}`).join(", ")}`);
    }
    lines.push(`Retreat: ${card.retreatCost.length}`);
  } else if (card.supertype === "Energy") {
    lines.push(`Energy · ${card.subtypes.join(" · ")}`);
    lines.push(`Provides: ${card.provides.join(", ")}`);
  } else {
    lines.push(`Trainer · ${card.subtypes.join(" · ")}`);
    if (card.text) lines.push("\n" + card.text);
  }
  if (card.setCode && card.number) {
    lines.push(`\n${card.setCode.toUpperCase()} #${card.number}${card.regulationMark ? ` · ${card.regulationMark}` : ""}`);
  }
  return lines.join("\n");
}

function AbilitiesBlock({ card }: { card: PokemonCard }) {
  if (!card.abilities?.length) return null;
  return (
    <div className="abilities">
      {card.abilities.map((a, i) => (
        <div key={i} className="ability" title={a.text}>
          <span className="ability-tag">{a.type.charAt(0)}</span> {a.name}
        </div>
      ))}
    </div>
  );
}

// A card image with an automatic fallback to the text rendering if the image
// fails to load. The text fallback is provided by the caller as children.
function CardImage({
  src,
  alt,
  children,
}: {
  src: string | undefined;
  alt: string;
  children: React.ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <>{children}</>;
  return (
    <img
      className="card-img"
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      // Browsers ship with `draggable=true` on <img>, which fires native HTML5
      // dragstart and swallows the pointermove events our gesture hook needs.
      // Disable native drag here so our custom pointer-based DnD takes over.
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
    />
  );
}

// Text-only card body (used as fallback when the CDN image is missing).
function CardTextBody({ card }: { card: Card }) {
  if (card.supertype === "Pokémon") {
    return (
      <>
        <div className="name">{card.name}</div>
        <div className="type">
          {card.subtypes.join(" · ")} · {card.types.join("/")}
        </div>
        <div className="hp">HP {card.hp}</div>
        <AbilitiesBlock card={card} />
        <div className="atks">
          {card.attacks.map((a, i) => (
            <div className="atk" key={i} title={a.text}>
              <span>
                {a.cost.map((c) => c[0]).join("") || "—"} {a.name}
              </span>
              <span>{a.damageText ?? a.damage}</span>
            </div>
          ))}
        </div>
      </>
    );
  }
  if (card.supertype === "Energy") {
    return (
      <>
        <div className="name">{card.name}</div>
        <div className="type">{card.subtypes.join(" · ")} Energy</div>
        <div className="energy">⚡ {card.provides.join(", ")}</div>
      </>
    );
  }
  return (
    <>
      <div className="name">{card.name}</div>
      <div className="type">{card.subtypes.join(" · ")}</div>
      <div className="trainer-text">{card.text}</div>
    </>
  );
}

function CardViewInner({
  card,
  selected,
  onClick,
  onDragStart,
  onDragMove,
  onDragEnd,
  dragging,
  illegalReason,
}: Props) {
  const cls =
    `card card-imaged` +
    (selected ? " selected" : "") +
    (dragging ? " drag-source" : "") +
    (illegalReason ? " illegal" : "");
  const tip =
    (illegalReason ? `${illegalReason}\n\n` : "") +
    cardTooltip(card) +
    "\n\nShift+click (or long-press) to zoom";
  const { pointerProps, consumeNextClick } = useCardGesture(card, {
    onDragStart,
    onDragMove,
    onDragEnd,
  });
  return (
    <div
      className={cls}
      onClick={(ev) => {
        if (consumeNextClick()) return;
        if (maybeZoom(card, ev)) return;
        onClick?.();
      }}
      onContextMenu={(ev) => {
        if (maybeZoom(card, ev)) return;
      }}
      {...pointerProps}
      title={tip}
    >
      <CardImage src={card.imageLarge} alt={card.name}>
        <CardTextBody card={card} />
      </CardImage>
    </div>
  );
}

// Memoized so static cards in hands / deck-tops / discard viewer don't
// re-render every parent rerender. Click and drag callbacks are intentionally
// excluded from the comparison: parents recreate them each render (closing
// over the latest hand index), but the closure bodies always read through
// stateRef so stale closures behave identically to fresh ones. `dragging`
// IS compared so the drag-source visual updates when a drag starts/ends.
export const CardView = memo(
  CardViewInner,
  (prev, next) =>
    prev.card === next.card &&
    prev.selected === next.selected &&
    prev.dragging === next.dragging &&
    prev.illegalReason === next.illegalReason,
);

const STATUS_LABELS: Record<string, string> = {
  asleep: "ZZ",
  burned: "BRN",
  confused: "CNF",
  paralyzed: "PAR",
  poisoned: "PSN",
};

interface PokemonInPlayProps {
  p: PokemonInPlay;
  selected?: boolean;
  onClick?: () => void;
  maxHp?: number;
  /** When true, the Pokémon is a legal drop target for whatever is currently
   *  selected in hand. Drives a highlight so the player can see at a glance
   *  where the selected card can be played. */
  legalTarget?: boolean;
  /** When true, this tile is currently under the pointer during a drag and
   *  the dragged card can be dropped here. Adds a stronger highlight than
   *  `legalTarget` alone. */
  dropHover?: boolean;
  /** Marks this tile as a drag-and-drop target. Read at drop-time by walking
   *  from the element under the pointer up to its nearest [data-droptarget]
   *  ancestor. The owning App resolves the string to a dispatch. */
  dropTargetId?: string;
}

export function PokemonInPlayView({
  p,
  selected,
  onClick,
  maxHp,
  legalTarget,
  dropHover,
  dropTargetId,
}: PokemonInPlayProps) {
  const cls =
    `card card-imaged in-play` +
    (selected ? " selected" : "") +
    (legalTarget ? " legal-target" : "") +
    (dropHover ? " drop-hover" : "");
  const tip = cardTooltip(p.card);

  // Render attachments as physical board tokens: a readable stack of glossy
  // Energy coins and tiny Tool card-tabs anchored to the Pokémon's edges.
  const visibleEnergyCount =
    p.attachedEnergy.length > ENERGY_VISIBLE_LIMIT
      ? ENERGY_COLLAPSE_VISIBLE
      : p.attachedEnergy.length;
  const visibleEnergy = p.attachedEnergy.slice(0, visibleEnergyCount);
  const hiddenEnergy = p.attachedEnergy.slice(visibleEnergyCount);
  const visibleTools = p.tools.slice(0, TOOL_VISIBLE_LIMIT);
  const hiddenTools = Math.max(0, p.tools.length - visibleTools.length);

  const effMax = maxHp ?? p.card.hp;
  const currentHp = Math.max(0, effMax - p.damage);
  const longPress = useCardLongPress(p.card);
  // Ability gem — a small cyan diamond pinned to the card when it has an
  // unused once-per-turn ability. From the Claude Design prototype: lets
  // the player see at a glance which in-play cards have a tappable ability
  // they haven't burned yet this turn.
  const hasAbilities = (p.card.abilities?.length ?? 0) > 0;
  const showAbilityGem = hasAbilities && !p.abilityUsedThisTurn;
  return (
    <div
      className={cls}
      onClick={(ev) => {
        if (longPress.consumeNextClick()) return;
        if (maybeZoom(p.card, ev)) return;
        onClick?.();
      }}
      onContextMenu={(ev) => {
        if (maybeZoom(p.card, ev)) return;
      }}
      {...longPress.pointerProps}
      data-droptarget={dropTargetId}
      title={tip + "\n\nShift+click (or long-press) to zoom"}
    >
      <CardImage src={p.card.imageLarge} alt={p.card.name}>
        <CardTextBody card={p.card} />
      </CardImage>
      <div className="in-play-overlay">
        <div className="hp-badge" data-low={currentHp <= effMax * 0.3 ? "true" : undefined}>
          {currentHp}/{effMax}
        </div>
        {showAbilityGem && (
          <div
            className="ability-gem"
            aria-label="Has unused ability"
            title="Has an unused ability — click to use"
          />
        )}
        {p.statuses.length > 0 && (
          <div className="statuses">
            {p.statuses.map((s) => (
              <span key={s} className={`status status-${s}`} title={s}>
                {STATUS_LABELS[s] ?? s}
              </span>
            ))}
          </div>
        )}
        {p.attachedEnergy.length > 0 && (
          <div className="attachment-layer attachment-layer-energy">
            <div className="energy-row energy-stack" aria-label={`Attached Energy: ${p.attachedEnergy.map((e) => e.name).join(", ")}`}>
              {visibleEnergy.map((e, i) => (
                <EnergyToken key={`${e.id}-${i}`} energy={e} index={i} />
              ))}
              {hiddenEnergy.length > 0 && (
                <EnergyOverflowToken hidden={hiddenEnergy.length} energies={hiddenEnergy} />
              )}
            </div>
          </div>
        )}
        {p.tools.length > 0 && (
          <div className="attachment-layer attachment-layer-tools">
            <div className="tool-row tool-stack" aria-label={`Attached tools: ${p.tools.map((t) => t.name).join(", ")}`}>
              {visibleTools.map((tool, i) => (
                <ToolChip key={`${tool.id}-${i}`} card={tool} index={i} />
              ))}
              {hiddenTools > 0 && <span className="tool-more">+{hiddenTools}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// PokemonInPlayView intentionally NOT memoized: the engine mutates the
// PokemonInPlay object in place (damage, attachedEnergy, statuses, tools),
// so React.memo can't see changes — both `prev` and `next` props alias the
// same object reference, and any custom comparator reading those fields is
// already comparing post-mutation values to themselves. This component is
// cheap enough that re-rendering on every parent render is fine.

export function FaceDownCard() {
  return <div className="card facedown">TCG</div>;
}
