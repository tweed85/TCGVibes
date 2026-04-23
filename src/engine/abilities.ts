// Ability detection + activated-ability resolution.
//
// Pokémon abilities run the gamut from passive ongoing effects ("This
// Pokémon's attacks do 20 more damage") to triggered ones ("When you play
// this Pokémon...") to activated ones ("Once during your turn, you may...").
//
// We only auto-wire a narrow set of activated, once-per-turn abilities.
// Anything else stays as display-only text.

import { logEvent } from "./rules";
import type {
  Ability,
  AbilityEffect,
  Card,
  EnergyCard,
  EnergyType,
  GameState,
  PlayerId,
  PokemonInPlay,
} from "./types";

const ENERGY_TYPES: EnergyType[] = [
  "Grass", "Fire", "Water", "Lightning", "Psychic",
  "Fighting", "Darkness", "Metal", "Fairy", "Dragon", "Colorless",
];

export function detectAbilityEffect(a: { name: string; type: string; text: string }): AbilityEffect | undefined {
  const text = a.text || "";
  // Ignore passive/triggered — only auto-wire activated ("Once during your turn").
  if (!/once during your turn/i.test(text)) return undefined;

  // "Once during your turn, you may draw a card."
  if (/draw a card/i.test(text) && !/draw 2/i.test(text)) {
    return { kind: "drawOne", oncePerTurn: true };
  }
  if (/draw 2 cards/i.test(text)) {
    return { kind: "drawTwo", oncePerTurn: true };
  }

  // "Once during your turn, you may heal N damage from this Pokémon."
  {
    const m = text.match(/heal (\d+) damage from this Pok[eé]mon/i);
    if (m) return { kind: "healSelf", amount: parseInt(m[1], 10), oncePerTurn: true };
  }

  // "Once during your turn, you may search your deck for a basic [Type] Energy..."
  {
    const m = text.match(/search your deck for a basic ([A-Za-z]+ )?energy/i);
    if (m) {
      return { kind: "searchBasicEnergy", count: 1, oncePerTurn: true };
    }
  }

  // "Once during your turn, you may attach a basic [Type] Energy card from your
  // hand to 1 of your Pokémon."
  {
    const m = text.match(/attach a basic ([A-Za-z]+) energy card from your hand/i);
    if (m) {
      const type = ENERGY_TYPES.find((t) => t.toLowerCase() === m[1].toLowerCase());
      if (type) return { kind: "attachEnergyFromHand", energyType: type, oncePerTurn: true };
    }
  }

  return undefined;
}

// Apply detection in-place to all abilities on a Pokémon card — called during
// card mapping.
export function annotateAbilities(abilities: Ability[] | undefined): Ability[] | undefined {
  if (!abilities) return abilities;
  return abilities.map((a) => ({ ...a, effect: detectAbilityEffect(a) }));
}

// ---- Activate an ability at runtime --------------------------------------

export interface ActivateResult {
  ok: boolean;
  reason?: string;
}

function shuffleDeck(state: GameState, pl: PlayerId): void {
  const player = state.players[pl];
  const arr = player.deck;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = state.rng.int(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export function activateAbility(
  state: GameState,
  player: PlayerId,
  instanceId: string,
  abilityIndex: number,
): ActivateResult {
  if (state.phase !== "main")
    return { ok: false, reason: "Not in main phase." };
  if (state.activePlayer !== player)
    return { ok: false, reason: "Not your turn." };

  const pl = state.players[player];
  const holder: PokemonInPlay | undefined =
    pl.active?.instanceId === instanceId
      ? pl.active
      : pl.bench.find((p) => p.instanceId === instanceId);
  if (!holder) return { ok: false, reason: "Pokémon not in play." };

  const ability = holder.card.abilities?.[abilityIndex];
  if (!ability) return { ok: false, reason: "No such ability." };
  if (!ability.effect) return { ok: false, reason: "That ability isn't engine-playable." };
  if (ability.effect.oncePerTurn && holder.abilityUsedThisTurn)
    return { ok: false, reason: "Ability already used this turn." };

  const e = ability.effect;
  switch (e.kind) {
    case "drawOne":
    case "drawTwo": {
      const n = e.kind === "drawOne" ? 1 : 2;
      let drawn = 0;
      for (let i = 0; i < n; i++) {
        const c = pl.deck.shift();
        if (!c) break;
        pl.hand.push(c);
        drawn++;
      }
      logEvent(state, player, `uses ${ability.name} on ${holder.card.name}: draws ${drawn} card(s).`);
      break;
    }
    case "healSelf": {
      const before = holder.damage;
      holder.damage = Math.max(0, holder.damage - e.amount);
      logEvent(state, player, `uses ${ability.name}: heals ${before - holder.damage} from ${holder.card.name}.`);
      break;
    }
    case "searchBasicEnergy": {
      const isBasicEnergy = (c: Card): c is EnergyCard =>
        c.supertype === "Energy" && c.subtypes.includes("Basic");
      let found = 0;
      const keep: Card[] = [];
      for (const c of pl.deck) {
        if (found < e.count && isBasicEnergy(c)) {
          pl.hand.push(c);
          found++;
        } else {
          keep.push(c);
        }
      }
      pl.deck = keep;
      shuffleDeck(state, player);
      logEvent(state, player, `uses ${ability.name}: gets ${found} basic Energy.`);
      break;
    }
    case "attachEnergyFromHand": {
      // Attach to self if applicable; otherwise skip (target-picking UI is a
      // follow-up — for now auto-attach to the same Pokémon).
      const idx = pl.hand.findIndex(
        (c) => c.supertype === "Energy" && c.subtypes.includes("Basic") && (c as EnergyCard).provides.includes(e.energyType),
      );
      if (idx < 0) return { ok: false, reason: `No basic ${e.energyType} Energy in hand.` };
      const [en] = pl.hand.splice(idx, 1) as [EnergyCard];
      holder.attachedEnergy.push(en);
      logEvent(state, player, `uses ${ability.name}: attaches ${en.name} to ${holder.card.name}.`);
      break;
    }
  }

  holder.abilityUsedThisTurn = true;
  return { ok: true };
}
