// Maps raw Pokémon TCG API card objects into engine Card types.
//
// The dataset lives in /data/pokemon/tournament-legal-cards.json — generated
// from the PokemonTCG/pokemon-tcg-data mirror, filtered to regulation marks
// H/I/J (Standard-legal as of 2026-04-23, North America).
//
// The API stores numbers as strings and damage with modifier suffixes
// ("30+", "20×", "50-"). We parse the leading integer and keep the original
// text around for UI display. Modifier effects (+ / × / -) are NOT evaluated
// by the engine yet — base damage is applied.

import type {
  Ability,
  Attack,
  Card,
  EnergyCard,
  EnergyType,
  PokemonCard,
  TrainerCard,
  WeaknessResistance,
} from "../engine/types";
import { detectTrainerEffect } from "../engine/trainerEffects";
import { annotateAbilities } from "../engine/abilities";
import { cardImageUrl } from "./cardImages";

export interface ApiCard {
  id: string;
  name: string;
  supertype: string;
  subtypes?: string[];
  number?: string;
  regulation_mark?: string;
  set_code?: string;
  hp?: string;
  types?: string[];
  evolves_from?: string | null;
  attacks?: {
    name: string;
    cost?: string[];
    damage?: string;
    text?: string;
  }[];
  abilities?: { name: string; type: string; text: string }[];
  weaknesses?: { type: string; value: string }[];
  resistances?: { type: string; value: string }[];
  retreat_cost?: string[];
  rules?: string[];
}

const ENERGY_TYPES = new Set<EnergyType>([
  "Grass",
  "Fire",
  "Water",
  "Lightning",
  "Psychic",
  "Fighting",
  "Darkness",
  "Metal",
  "Fairy",
  "Dragon",
  "Colorless",
]);

function asEnergyType(s: string | undefined): EnergyType {
  if (s && ENERGY_TYPES.has(s as EnergyType)) return s as EnergyType;
  return "Colorless";
}

// Some newer cards use the token "Free" in the cost array to indicate a
// zero-Energy attack (e.g. Budew sv8pt5's Itchy Pollen). Strip those out so
// the attack correctly shows as free. Retreat cost can also be "Free" for
// abilities like Air Balloon-style 0 retreat; same filter applies.
function asEnergyTypes(arr: string[] | undefined): EnergyType[] {
  return (arr ?? [])
    .filter((s) => s && s.toLowerCase() !== "free")
    .map(asEnergyType);
}

function parseDamage(raw: string | undefined): { damage: number; text?: string } {
  if (!raw) return { damage: 0 };
  // Leading integer (including 0). Ignore modifier suffix for base damage.
  const m = raw.match(/^(\d+)/);
  const damage = m ? parseInt(m[1], 10) : 0;
  return { damage, text: raw };
}

function mapAttack(a: NonNullable<ApiCard["attacks"]>[number]): Attack {
  const parsed = parseDamage(a.damage);
  // Effects are detected on first use via getAttackEffects(), not at load
  // time. Most attacks never fire in any given game.
  return {
    name: a.name,
    cost: asEnergyTypes(a.cost),
    damage: parsed.damage,
    damageText: parsed.text,
    text: a.text,
  };
}

function mapAbility(a: NonNullable<ApiCard["abilities"]>[number]): Ability {
  return { name: a.name, type: a.type, text: a.text };
}

function mapWR(w: { type: string; value: string }): WeaknessResistance {
  return { type: asEnergyType(w.type), value: w.value };
}

// Basic energy cards are named either "<Type> Energy" (older printings) or
// "Basic <Type> Energy" (SVE and later). Strip the optional "Basic " prefix
// before matching. Special energies fall back to Colorless until their
// individual effects are modeled.
function energyProvidesFromCard(c: ApiCard): EnergyType[] {
  const isBasic = (c.subtypes ?? []).includes("Basic");
  if (isBasic) {
    const trimmed = c.name.replace(/^Basic\s+/i, "");
    for (const t of ENERGY_TYPES) {
      if (trimmed.startsWith(t)) return [t];
    }
  }
  return ["Colorless"];
}

export function mapCard(c: ApiCard): Card {
  const img = cardImageUrl(c.set_code, c.number);
  const base = {
    id: c.id,
    name: c.name,
    setCode: c.set_code,
    number: c.number,
    regulationMark: c.regulation_mark,
    imageSmall: img,
    imageLarge: img,
  };

  if (c.supertype === "Pokémon") {
    const card: PokemonCard = {
      ...base,
      supertype: "Pokémon",
      subtypes: c.subtypes ?? [],
      hp: c.hp ? parseInt(c.hp, 10) || 0 : 0,
      types: asEnergyTypes(c.types),
      evolvesFrom: c.evolves_from ?? undefined,
      attacks: (c.attacks ?? []).map(mapAttack),
      abilities: annotateAbilities(c.abilities?.map(mapAbility)),
      weaknesses: c.weaknesses?.map(mapWR),
      resistances: c.resistances?.map(mapWR),
      retreatCost: asEnergyTypes(c.retreat_cost),
      rules: c.rules,
    };
    return card;
  }

  if (c.supertype === "Energy") {
    const card: EnergyCard = {
      ...base,
      supertype: "Energy",
      subtypes: c.subtypes ?? [],
      provides: energyProvidesFromCard(c),
    };
    return card;
  }

  const effectId = detectTrainerEffect({
    name: c.name,
    supertype: c.supertype,
    subtypes: c.subtypes,
    rules: c.rules,
  });
  const card: TrainerCard = {
    ...base,
    supertype: "Trainer",
    subtypes: c.subtypes ?? [],
    text: (c.rules ?? []).join("\n\n") || "",
    rules: c.rules,
    effectId,
  };
  return card;
}

// Some Pokémon cards in the dataset lack retreat cost in the JSON (rare
// data gaps). Others are not playable in our MVP (e.g., cards that only
// work via an ability). This returns a quick playability check.
export function isEngineUsable(c: Card): boolean {
  if (c.supertype === "Pokémon") {
    return c.hp > 0 && c.attacks.length > 0;
  }
  return true;
}
