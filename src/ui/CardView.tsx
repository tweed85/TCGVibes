import { memo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { Card, PokemonCard, PokemonInPlay } from "../engine/types";

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

// Long-press → zoom for touch devices (mobile / tablet have no right-click).
// Returns the props to spread onto the card element. `setSuppressClick` is a
// flag the click handler reads to skip the trailing tap when long-press
// fired. Cancels on pointer-move >10px so swipe-scrolling the hand strip
// doesn't trigger zoom.
function useCardLongPress(card: Card): {
  pointerProps: {
    onPointerDown: (ev: PointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onPointerLeave: () => void;
    onPointerMove: (ev: PointerEvent<HTMLElement>) => void;
  };
  consumeNextClick: () => boolean;
} {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    startPos.current = null;
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
        timer.current = setTimeout(() => {
          fired.current = true;
          if (zoomHandler) zoomHandler(card);
        }, 500);
      },
      onPointerUp: clear,
      onPointerCancel: clear,
      onPointerLeave: clear,
      onPointerMove: (ev) => {
        if (!startPos.current) return;
        const dx = ev.clientX - startPos.current.x;
        const dy = ev.clientY - startPos.current.y;
        if (dx * dx + dy * dy > 100) clear(); // ~10px threshold
      },
    },
    consumeNextClick,
  };
}

interface Props {
  card: Card;
  selected?: boolean;
  onClick?: () => void;
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

function CardViewInner({ card, selected, onClick }: Props) {
  const cls = `card card-imaged${selected ? " selected" : ""}`;
  const tip = cardTooltip(card) + "\n\nShift+click (or long-press) to zoom";
  const { pointerProps, consumeNextClick } = useCardLongPress(card);
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
// re-render every parent rerender. `onClick` is intentionally excluded from
// the comparison: parents recreate it each render (closing over the latest
// hand index), but the closure body always reads through stateRef so stale
// closures behave identically to fresh ones.
export const CardView = memo(
  CardViewInner,
  (prev, next) => prev.card === next.card && prev.selected === next.selected,
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
}

export function PokemonInPlayView({
  p,
  selected,
  onClick,
  maxHp,
  legalTarget,
}: PokemonInPlayProps) {
  const cls =
    `card card-imaged in-play` +
    (selected ? " selected" : "") +
    (legalTarget ? " legal-target" : "");
  const tip = cardTooltip(p.card);

  // Render each attached Energy as a colored pip showing its type initial.
  // For special energies with a wild or multi-type provides, we render a
  // rainbow pip marked `*`.
  const pips = p.attachedEnergy.map((e, i) => {
    const types = e.provides ?? ["Colorless"];
    const primary = types[0] ?? "Colorless";
    // Team Rocket's Energy (P/D), Prism, Luminous, etc. share multi-type
    // provides; show the first type's color but tag as wild when there are
    // more than one distinct types.
    const distinct = new Set(types);
    const isWild = distinct.size > 1;
    const cls = `energy-pip energy-${isWild ? "wild" : primary}`;
    const glyph = isWild ? "*" : (primary[0] ?? "C");
    return (
      <span
        key={`${e.id}-${i}`}
        className={cls}
        title={`${e.name} (${types.join("/")})`}
      >
        {glyph}
      </span>
    );
  });

  const effMax = maxHp ?? p.card.hp;
  const currentHp = Math.max(0, effMax - p.damage);
  const longPress = useCardLongPress(p.card);
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
      title={tip + "\n\nShift+click (or long-press) to zoom"}
    >
      <CardImage src={p.card.imageLarge} alt={p.card.name}>
        <CardTextBody card={p.card} />
      </CardImage>
      <div className="in-play-overlay">
        <div className="hp-badge" data-low={currentHp <= effMax * 0.3 ? "true" : undefined}>
          {currentHp}/{effMax}
        </div>
        {p.statuses.length > 0 && (
          <div className="statuses">
            {p.statuses.map((s) => (
              <span key={s} className={`status status-${s}`} title={s}>
                {STATUS_LABELS[s] ?? s}
              </span>
            ))}
          </div>
        )}
        {pips.length > 0 && <div className="energy-row">{pips}</div>}
        {p.tools.length > 0 && (
          <div className="tool-badge" title={p.tools.map((t) => t.name).join(", ")}>
            🔧{p.tools.length > 1 ? p.tools.length : ""}
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
