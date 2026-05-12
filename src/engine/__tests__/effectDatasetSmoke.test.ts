// Dataset-facing effect smoke.
//
// The audit guard watches TypeScript effect unions. This test walks the real
// loaded Standard card pool and proves detection across every legal card is
// still healthy: attack regexes don't throw, annotated ability effects point
// at known ability kinds, and trainer effect ids point at known Trainer ids.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allCards } from "../../data/cards";
import { getAttackEffects } from "../../data/effectPatterns";
import type { Attack, PokemonCard, TrainerCard } from "../types";

function between(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`Could not find markers ${startMarker} -> ${endMarker}`);
  }
  return text.slice(start, end);
}

function topLevelKinds(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/^  \| \{(?:\s*kind: "([^"]+)"|\s*\n\s+kind: "([^"]+)")/gm)]
      .map((m) => m[1] ?? m[2]),
  );
}

function trainerIds(text: string): Set<string> {
  return new Set([...text.matchAll(/\| "([^"]+)"/g)].map((m) => m[1]));
}

function knownEffectSets(): {
  attack: Set<string>;
  ability: Set<string>;
  trainer: Set<string>;
} {
  const effects = readFileSync("src/engine/types/effects.ts", "utf8");
  const cards = readFileSync("src/engine/types/cards.ts", "utf8");
  const trainers = readFileSync("src/engine/trainerEffects.ts", "utf8");
  return {
    attack: topLevelKinds(
      between(effects, "export type AttackEffect =", "export type PokemonFilter"),
    ),
    ability: topLevelKinds(
      between(cards, "export type AbilityEffect =", "export type AbilityCondition"),
    ),
    trainer: trainerIds(
      between(
        trainers,
        "export type TrainerEffectId =",
        "export function detectTrainerEffect",
      ),
    ),
  };
}

function attackLabel(card: PokemonCard, attack: Attack): string {
  return `${card.name} ${card.setCode ?? "?"} ${card.number ?? "?"} / ${attack.name}`;
}

describe("dataset effect detection smoke", () => {
  it("walks every legal card and keeps detected effect ids connected to known unions", () => {
    const known = knownEffectSets();
    const failures: string[] = [];
    let attacksVisited = 0;
    let attackEffectsDetected = 0;
    let abilityEffectsDetected = 0;
    let trainerEffectsDetected = 0;

    expect(allCards.length).toBeGreaterThan(2500);

    for (const card of allCards) {
      if (card.supertype === "Pokémon") {
        const pokemon = card as PokemonCard;
        for (const attack of pokemon.attacks) {
          attacksVisited += 1;
          try {
            const effects = getAttackEffects(attack);
            attackEffectsDetected += effects.length;
            for (const effect of effects) {
              if (!known.attack.has(effect.kind)) {
                failures.push(
                  `${attackLabel(pokemon, attack)} detected unknown AttackEffect kind "${effect.kind}"`,
                );
              }
            }
          } catch (e) {
            failures.push(
              `${attackLabel(pokemon, attack)} threw during getAttackEffects: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        }
        for (const ability of pokemon.abilities ?? []) {
          if (!ability.effect) continue;
          abilityEffectsDetected += 1;
          if (!known.ability.has(ability.effect.kind)) {
            failures.push(
              `${pokemon.name} ${pokemon.setCode ?? "?"} ${pokemon.number ?? "?"} / ${ability.name} has unknown AbilityEffect kind "${ability.effect.kind}"`,
            );
          }
        }
      } else if (card.supertype === "Trainer") {
        const trainer = card as TrainerCard;
        if (!trainer.effectId) continue;
        trainerEffectsDetected += 1;
        if (!known.trainer.has(trainer.effectId)) {
          failures.push(
            `${trainer.name} ${trainer.setCode ?? "?"} ${trainer.number ?? "?"} has unknown TrainerEffectId "${trainer.effectId}"`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
    expect(attacksVisited).toBeGreaterThan(1000);
    // These are deliberately lower than today's exact counts. The guard is
    // meant to catch detection collapsing, while allowing normal dataset
    // refreshes to move exact card counts.
    expect(attackEffectsDetected).toBeGreaterThan(500);
    expect(abilityEffectsDetected).toBeGreaterThan(100);
    expect(trainerEffectsDetected).toBeGreaterThan(100);
  });
});
