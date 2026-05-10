// Effect audit guard.
//
// This test deliberately watches the *shape* of the implemented effect
// surface rather than individual card behavior. If a new AttackEffect,
// AbilityEffect, or TrainerEffectId kind lands, the count/hash changes and
// the author must update docs/EFFECT_AUDIT.md with a coverage decision.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface InventoryExpectation {
  count: number;
  hash: string;
}

const EXPECTED = {
  attack: { count: 305, hash: "70358e863c904922" },
  ability: { count: 68, hash: "3c6119c0c8e1b247" },
  trainer: { count: 162, hash: "16e315fe6c79e542" },
} satisfies Record<string, InventoryExpectation>;

function between(text: string, startMarker: string, endMarker: string): string {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`Could not find markers ${startMarker} → ${endMarker}`);
  }
  return text.slice(start, end);
}

function topLevelKindUnion(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/^  \| \{ kind: "([^"]+)"/gm)].map((m) => m[1]),
    ),
  ].sort();
}

function trainerEffectIds(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/\| "([^"]+)"/g)].map((m) => m[1]),
    ),
  ].sort();
}

function digest(kinds: string[]): string {
  return createHash("sha256").update(kinds.join("\n")).digest("hex").slice(0, 16);
}

function expectInventory(
  label: keyof typeof EXPECTED,
  kinds: string[],
): void {
  const expected = EXPECTED[label];
  expect(
    {
      count: kinds.length,
      hash: digest(kinds),
    },
    `${label} effect inventory changed. Update docs/EFFECT_AUDIT.md and this guard after adding coverage for the new/removed kind.`,
  ).toEqual(expected);
}

describe("effect audit coverage guard", () => {
  it("keeps AttackEffect / AbilityEffect / TrainerEffectId inventories intentional", () => {
    const types = readFileSync("src/engine/types.ts", "utf8");
    const trainers = readFileSync("src/engine/trainerEffects.ts", "utf8");

    const attackKinds = topLevelKindUnion(
      between(types, "export type AttackEffect =", "export type PokemonFilter"),
    );
    const abilityKinds = topLevelKindUnion(
      between(types, "export type AbilityEffect =", "export type AbilityCondition"),
    );
    const trainerKinds = trainerEffectIds(
      between(
        trainers,
        "export type TrainerEffectId =",
        "export function detectTrainerEffect",
      ),
    );

    expectInventory("attack", attackKinds);
    expectInventory("ability", abilityKinds);
    expectInventory("trainer", trainerKinds);
  });

  it("keeps the audit document synced with the guarded inventory", () => {
    const audit = readFileSync("docs/EFFECT_AUDIT.md", "utf8");
    for (const [label, expected] of Object.entries(EXPECTED)) {
      expect(audit).toContain(`${expected.count}`);
      expect(audit).toContain(expected.hash);
      expect(audit.toLowerCase()).toContain(label);
    }
    for (const required of [
      "Required coverage tiers",
      "Risk tiers",
      "Coverage map",
      "New effect checklist",
    ]) {
      expect(audit).toContain(required);
    }
  });
});
