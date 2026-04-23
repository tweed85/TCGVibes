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

export function CardView({ card, selected, onClick }: Props) {
  const cls = `card${selected ? " selected" : ""}`;
  const tip = cardTooltip(card);

  if (card.supertype === "Pokémon") {
    return (
      <div className={cls} onClick={onClick} title={tip}>
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
      </div>
    );
  }
  if (card.supertype === "Energy") {
    return (
      <div className={cls} onClick={onClick} title={tip}>
        <div className="name">{card.name}</div>
        <div className="type">{card.subtypes.join(" · ")} Energy</div>
        <div className="energy">⚡ {card.provides.join(", ")}</div>
      </div>
    );
  }
  return (
    <div className={cls} onClick={onClick} title={tip}>
      <div className="name">{card.name}</div>
      <div className="type">{card.subtypes.join(" · ")}</div>
      <div className="trainer-text">{card.text}</div>
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
}: {
  p: PokemonInPlay;
  selected?: boolean;
  onClick?: () => void;
}) {
  const cls = `card${selected ? " selected" : ""}`;
  const tip = cardTooltip(p.card);

  // Render energy as type initials (F, W, L, etc.)
  const energyInitials = p.attachedEnergy
    .map((e) => (e.provides[0] ?? "C")[0])
    .join(" ");

  return (
    <div className={cls} onClick={onClick} title={tip}>
      <div className="name">{p.card.name}</div>
      <div className="type">
        {p.card.subtypes.join(" · ")} · {p.card.types.join("/")}
      </div>
      <div className="hp">
        HP {Math.max(0, p.card.hp - p.damage)}/{p.card.hp}
      </div>
      {p.damage > 0 && <div className="dmg">-{p.damage}</div>}
      {p.statuses.length > 0 && (
        <div className="statuses">
          {p.statuses.map((s) => (
            <span key={s} className={`status status-${s}`} title={s}>
              {STATUS_LABELS[s] ?? s}
            </span>
          ))}
        </div>
      )}
      <div className="energy">{energyInitials || "—"}</div>
      <AbilitiesBlock card={p.card} />
      <div className="atks">
        {p.card.attacks.map((a, i) => (
          <div className="atk" key={i} title={a.text}>
            <span>
              {a.cost.map((c) => c[0]).join("") || "—"} {a.name}
            </span>
            <span>{a.damageText ?? a.damage}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FaceDownCard() {
  return <div className="card facedown">TCG</div>;
}
