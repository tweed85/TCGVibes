import type { Card, PokemonInPlay } from "../engine/types";

interface Props {
  card: Card;
  selected?: boolean;
  onClick?: () => void;
}

export function CardView({ card, selected, onClick }: Props) {
  const cls = `card${selected ? " selected" : ""}`;
  if (card.supertype === "Pokémon") {
    return (
      <div className={cls} onClick={onClick} title={card.name}>
        <div className="name">{card.name}</div>
        <div className="type">
          {card.subtypes.join(" · ")} · {card.types.join("/")}
        </div>
        <div className="hp">HP {card.hp}</div>
        <div className="atks">
          {card.attacks.map((a, i) => (
            <div className="atk" key={i}>
              <span>
                {a.cost.map((c) => c[0]).join("")} {a.name}
              </span>
              <span>{a.damage}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (card.supertype === "Energy") {
    return (
      <div className={cls} onClick={onClick} title={card.name}>
        <div className="name">{card.name}</div>
        <div className="type">Energy</div>
        <div className="energy">⚡ {card.provides.join(", ")}</div>
      </div>
    );
  }
  return (
    <div className={cls} onClick={onClick} title={card.name}>
      <div className="name">{card.name}</div>
      <div className="type">{card.subtypes.join(" · ")}</div>
      <div style={{ fontSize: 10, marginTop: "auto" }}>{card.text}</div>
    </div>
  );
}

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
  return (
    <div className={cls} onClick={onClick} title={p.card.name}>
      <div className="name">{p.card.name}</div>
      <div className="type">
        {p.card.subtypes.join(" · ")} · {p.card.types.join("/")}
      </div>
      <div className="hp">
        HP {p.card.hp - p.damage}/{p.card.hp}
      </div>
      {p.damage > 0 && <div className="dmg">-{p.damage}</div>}
      <div className="energy">
        {p.attachedEnergy.length > 0
          ? p.attachedEnergy.map((e) => e.provides[0][0]).join(" ")
          : "—"}
      </div>
      <div className="atks">
        {p.card.attacks.map((a, i) => (
          <div className="atk" key={i}>
            <span>
              {a.cost.map((c) => c[0]).join("")} {a.name}
            </span>
            <span>{a.damage}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FaceDownCard() {
  return <div className="card facedown">TCG</div>;
}
