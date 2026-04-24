import { useState } from "react";
import type { Card, PokemonCard, PokemonInPlay } from "../engine/types";

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

export function CardView({ card, selected, onClick }: Props) {
  const cls = `card card-imaged${selected ? " selected" : ""}`;
  const tip = cardTooltip(card);
  return (
    <div className={cls} onClick={onClick} title={tip}>
      <CardImage src={card.imageLarge} alt={card.name}>
        <CardTextBody card={card} />
      </CardImage>
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  asleep: "ZZ",
  burned: "BRN",
  confused: "CNF",
  paralyzed: "PAR",
  poisoned: "PSN",
};

export function PokemonInPlayView({
  p,
  selected,
  onClick,
  maxHp,
}: {
  p: PokemonInPlay;
  selected?: boolean;
  onClick?: () => void;
  maxHp?: number;
}) {
  const cls = `card card-imaged in-play${selected ? " selected" : ""}`;
  const tip = cardTooltip(p.card);

  // Render energy as type initials (F, W, L, etc.)
  const energyInitials = p.attachedEnergy
    .map((e) => (e.provides[0] ?? "C")[0])
    .join(" ");

  const effMax = maxHp ?? p.card.hp;
  const currentHp = Math.max(0, effMax - p.damage);
  return (
    <div className={cls} onClick={onClick} title={tip}>
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
        {energyInitials && <div className="energy-badge">{energyInitials}</div>}
        {p.tools.length > 0 && (
          <div className="tool-badge" title={p.tools.map((t) => t.name).join(", ")}>
            🔧{p.tools.length > 1 ? p.tools.length : ""}
          </div>
        )}
      </div>
    </div>
  );
}

export function FaceDownCard() {
  return <div className="card facedown">TCG</div>;
}
