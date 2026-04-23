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
import { extractEffects } from "./effectPatterns";
import { detectTrainerEffect } from "../engine/trainerEffects";
import { annotateAbilities } from "../engine/abilities";

export interface ApiCard {
  id: string;
  name: string;
  supertype: string;
  subtypes?: string[];
  number?: string;
  rarity?: string;
  regulation_mark?: string;
  set_code?: string;
  set_name?: string;
  series?: string;
  release_date?: string;
  hp?: string;
  types?: string[];
  evolves_from?: string | null;
  evolves_to?: string[];
  attacks?: {
    name: string;
    cost?: string[];
    convertedEnergyCost?: number;
    damage?: string;
    text?: string;
  }[];
  abilities?: { name: string; type: string; text: string }[];
  weaknesses?: { type: string; value: string }[];
  resistances?: { type: string; value: string }[];
  retreat_cost?: string[];
  converted_retreat_cost?: number;
  rules?: string[];
  legalities?: { standard?: string };
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

function asEnergyTypes(arr: string[] | undefined): EnergyType[] {
  return (arr ?? []).map(asEnergyType);
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
  const { effects, baseDamageOverride } = extractEffects(a);
  return {
    name: a.name,
    cost: asEnergyTypes(a.cost),
    damage: baseDamageOverride ?? parsed.damage,
    damageText: parsed.text,
    text: a.text,
    effects: effects.length > 0 ? effects : undefined,
  };
}

function mapAbility(a: NonNullable<ApiCard["abilities"]>[number]): Ability {
  return { name: a.name, type: a.type, text: a.text };
}

function mapWR(w: { type: string; value: string }): WeaknessResistance {
  return { type: asEnergyType(w.type), value: w.value };
}

// Basic energy cards are named "<Type> Energy". Special energies get the
// Colorless fallback — their real effects aren't modeled yet.
function energyProvidesFromCard(c: ApiCard): EnergyType[] {
  const isBasic = (c.subtypes ?? []).includes("Basic");
  if (isBasic) {
    for (const t of ENERGY_TYPES) {
      if (c.name.startsWith(t)) return [t];
    }
  }
  return ["Colorless"];
}

export function mapCard(c: ApiCard): Card {
  const base = {
    id: c.id,
    name: c.name,
    setCode: c.set_code,
    number: c.number,
    rarity: c.rarity,
    regulationMark: c.regulation_mark,
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
