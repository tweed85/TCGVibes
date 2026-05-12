// Effect audit guard.
//
// This test deliberately watches the *shape* of the implemented effect
// surface rather than individual card behavior. If a new AttackEffect,
// AbilityEffect, or TrainerEffectId kind lands, the count/hash changes and
// the author must update docs/EFFECT_AUDIT.md with a coverage decision.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ABILITY_AUDIT,
  ATTACK_AUDIT,
  TRAINER_AUDIT,
  CARD_LEVEL_EXCEPTIONS,
  hasPromptText,
} from "../_audit/userChoiceAudit";
import { findMissingShapeTests } from "../_audit/promptBehaviorAudit";
import {
  AI_PICK_POLICY_AUDIT,
  AI_INPLAY_POLICY_AUDIT,
  AI_HANDREVEAL_POLICY_AUDIT,
  AI_CHOICEMENU_POLICY_AUDIT,
} from "../_audit/aiPolicyAudit";
import {
  AI_PICK_POLICIES,
  AI_HANDREVEAL_POLICIES,
  AI_CHOICEMENU_POLICIES,
  AI_INPLAY_POLICIES,
} from "../aiPolicies";
// Side-effect imports — ai.ts and trainerEffects.ts register their policies
// at module load. The audit test would otherwise see empty registries.
import "../ai";
import "../trainerEffects";
import { mapCard, type ApiCard } from "../../data/cardMapper";
import { getAttackEffects } from "../../data/effectPatterns";

// Pinned baseline for unparsedPromptText counts at high/med severity.
// This pin prevents *new* prompt-worthy cards from silently slipping into
// the unparsed bucket. It is not a terminal-completion target; the generated
// report still marks these rows as open work until each is parsed, implemented,
// or explicitly excepted.
// Every previously-unparsed card now has either a parsed effect kind or an
// entry in CARD_LEVEL_EXCEPTIONS with a written rationale. The baseline is
// pinned at 0 to catch any new card whose printed text matches the prompt
// scanner but lacks both a parser and an exception entry.
const UNPARSED_PROMPT_BASELINE = {
  high: 0,
  med: 0,
  low: 0,
};

// Current generated-report ledger. This is intentionally NOT an acceptance
// target: it keeps unresolved rows visible so a green audit suite cannot be
// mistaken for "every prompt-worthy tournament-legal card is fully covered."
// When a follow-up converts/parses/exempts rows, update this ledger alongside
// docs/USER_CHOICE_AUDIT.md.
const USER_CHOICE_REPORT_STATUS = {
  tested: 3003,
  needsFix: 0,
  exception: 247,
  unparsed: 0,
};

interface InventoryExpectation {
  count: number;
  hash: string;
}

const EXPECTED = {
  attack: { count: 306, hash: "11de4a1df0a3c0b1" },
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
      [...text.matchAll(/^  \| \{(?:\s*kind: "([^"]+)"|\s*\n\s+kind: "([^"]+)")/gm)]
        .map((m) => m[1] ?? m[2]),
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
    const effects = readFileSync("src/engine/types/effects.ts", "utf8");
    const cards = readFileSync("src/engine/types/cards.ts", "utf8");
    const trainers = readFileSync("src/engine/trainerEffects.ts", "utf8");

    const attackKinds = topLevelKindUnion(
      between(effects, "export type AttackEffect =", "export type PokemonFilter"),
    );
    const abilityKinds = topLevelKindUnion(
      between(cards, "export type AbilityEffect =", "export type AbilityCondition"),
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

  it("user-choice audit covers every effect kind exhaustively (no missing rows, no stale rows)", () => {
    // The audit tables in src/engine/_audit/userChoiceAudit.ts are Records
    // keyed by the dispatch unions; TypeScript already enforces exhaustiveness
    // at compile time. This runtime guard double-checks that Object.keys() of
    // the audit tables equals the regex-extracted kind sets from source, which
    // catches drift if someone adds a top-level kind that the Record type
    // resolution somehow accepts (e.g. via `as Record<...>` casts).
    const effects = readFileSync("src/engine/types/effects.ts", "utf8");
    const cards = readFileSync("src/engine/types/cards.ts", "utf8");
    const trainers = readFileSync("src/engine/trainerEffects.ts", "utf8");

    const attackKinds = new Set(
      topLevelKindUnion(
        between(effects, "export type AttackEffect =", "export type PokemonFilter"),
      ),
    );
    const abilityKinds = new Set(
      topLevelKindUnion(
        between(cards, "export type AbilityEffect =", "export type AbilityCondition"),
      ),
    );
    const trainerIds = new Set(
      trainerEffectIds(
        between(
          trainers,
          "export type TrainerEffectId =",
          "export function detectTrainerEffect",
        ),
      ),
    );

    const auditAttack = new Set(Object.keys(ATTACK_AUDIT));
    const auditAbility = new Set(Object.keys(ABILITY_AUDIT));
    const auditTrainer = new Set(Object.keys(TRAINER_AUDIT));

    const setEquals = (a: Set<string>, b: Set<string>): boolean =>
      a.size === b.size && [...a].every((k) => b.has(k));

    expect(setEquals(attackKinds, auditAttack), "ATTACK_AUDIT keys must equal the AttackEffect kind union").toBe(true);
    expect(setEquals(abilityKinds, auditAbility), "ABILITY_AUDIT keys must equal the AbilityEffect kind union").toBe(true);
    expect(setEquals(trainerIds, auditTrainer), "TRAINER_AUDIT keys must equal the TrainerEffectId union").toBe(true);
  });

  it("every non-placeholder PromptBehaviorShape points at at least one existing test file", () => {
    // Placeholder shapes are excluded from this guard. They remain visible as
    // `needsFix` rows in docs/USER_CHOICE_AUDIT.md until follow-up work
    // registers real behavior tests or exceptions.
    const issues = findMissingShapeTests();
    expect(
      issues,
      `Behavior-shape registry has missing or stale test files:\n${issues
        .map((i) => `  ${i.shape}: ${i.reason} [${i.files.join(", ")}]`)
        .join("\n")}`,
    ).toEqual([]);
  });

  it("tournament-card prompt coverage: every prompt-worthy card has a parsed effect, an exception entry, or counts toward the pinned unparsedPromptText baseline", () => {
    // Walks the entire tournament-legal dataset, runs the prompt-text scanner
    // from userChoiceAudit, and asserts that the count of cards whose
    // printed text matches a prompt phrase but has NO parsed effect kind
    // stays at or below the pinned baseline. Growing the count forces the
    // author to either parse the card's effect or add it to
    // CARD_LEVEL_EXCEPTIONS with a written rationale.
    const raw = JSON.parse(
      readFileSync("data/pokemon/tournament-legal-cards.json", "utf8"),
    ) as { cards: ApiCard[] };

    const counts = { high: 0, med: 0, low: 0 };
    const offenders: { name: string; severity: "high" | "med" | "low" }[] = [];

    const severityOf = (text: string): "high" | "med" | "low" => {
      if (/\bchoose\b|\bput \d+\b|\blook at\b/i.test(text)) return "high";
      if (/\bmay\b/i.test(text)) return "med";
      return "low";
    };

    for (const apiCard of raw.cards) {
      if (CARD_LEVEL_EXCEPTIONS[apiCard.name]) continue;
      const card = mapCard(apiCard);

      if (card.supertype === "Pokémon") {
        for (const ab of card.abilities ?? []) {
          if (ab.effect) continue;
          if (!hasPromptText(ab.text ?? "")) continue;
          const sev = severityOf(ab.text);
          counts[sev]++;
          if (sev === "high") offenders.push({ name: apiCard.name, severity: sev });
        }
        for (const attack of card.attacks ?? []) {
          const effects = getAttackEffects(attack);
          if (effects.length > 0) continue;
          if (!attack.text || !hasPromptText(attack.text)) continue;
          const sev = severityOf(attack.text);
          counts[sev]++;
          if (sev === "high") offenders.push({ name: apiCard.name, severity: sev });
        }
      } else if (card.supertype === "Trainer") {
        if (card.effectId) continue;
        if (!hasPromptText(card.text)) continue;
        const sev = severityOf(card.text);
        counts[sev]++;
        if (sev === "high") offenders.push({ name: apiCard.name, severity: sev });
      }
    }

    const message =
      `unparsedPromptText baseline: ${JSON.stringify(counts)} vs pinned ${JSON.stringify(UNPARSED_PROMPT_BASELINE)}.\n` +
      `If counts grew, parse the new effect, add to CARD_LEVEL_EXCEPTIONS, or update the pin.\n` +
      `High-severity offenders: ${offenders.slice(0, 10).map((o) => o.name).join(", ")}${offenders.length > 10 ? "..." : ""}`;

    expect(counts.high, message).toBeLessThanOrEqual(UNPARSED_PROMPT_BASELINE.high);
    expect(counts.med, message).toBeLessThanOrEqual(UNPARSED_PROMPT_BASELINE.med);
    expect(counts.low, message).toBeLessThanOrEqual(UNPARSED_PROMPT_BASELINE.low);
  });

  it("user-choice report keeps unresolved row counts explicit", () => {
    const report = readFileSync("docs/USER_CHOICE_AUDIT.md", "utf8");
    const counts = { tested: 0, needsFix: 0, exception: 0, unparsed: 0 };

    for (const line of report.split("\n")) {
      if (!line.startsWith("| ") || line.startsWith("| Card") || line.startsWith("|------")) continue;
      const cols = line.split("|").map((s: string) => s.trim());
      const status = cols[7] as keyof typeof counts | undefined;
      if (status && status in counts) counts[status]++;
    }

    expect(
      counts,
      "Generated user-choice report status counts changed. If rows were fixed, parsed, or excepted, regenerate docs/USER_CHOICE_AUDIT.md and update USER_CHOICE_REPORT_STATUS. If this was accidental, inspect the report before accepting the audit as terminal.",
    ).toEqual(USER_CHOICE_REPORT_STATUS);
  });

  it("Phase 2 AI policy coverage: every kind classified 'policy' has a registered runtime entry", () => {
    // For each "policy" classification in the AI policy audit, verify the
    // runtime registry actually has that key. Catches registrations that
    // silently drop off after a module refactor (e.g. a circular-import
    // workaround that breaks load order).
    const checkRegistry = (
      label: string,
      auditTable: Record<string, "policy" | "genericScored" | "handledInline">,
      registry: Record<string, unknown>,
    ): string[] => {
      const missing: string[] = [];
      for (const [kind, cls] of Object.entries(auditTable)) {
        if (cls === "policy" && !(kind in registry)) {
          missing.push(`${label}: '${kind}' classified 'policy' but not registered`);
        }
      }
      return missing;
    };
    const missing = [
      ...checkRegistry("AI_PICK_POLICY", AI_PICK_POLICY_AUDIT, AI_PICK_POLICIES),
      ...checkRegistry("AI_INPLAY_POLICY", AI_INPLAY_POLICY_AUDIT, AI_INPLAY_POLICIES),
      ...checkRegistry("AI_HANDREVEAL_POLICY", AI_HANDREVEAL_POLICY_AUDIT, AI_HANDREVEAL_POLICIES),
      ...checkRegistry("AI_CHOICEMENU_POLICY", AI_CHOICEMENU_POLICY_AUDIT, AI_CHOICEMENU_POLICIES),
    ];
    expect(missing, `AI policy registry missing entries:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("Phase 2.7 reachability: aiStep drains an open pendingInPlayTarget without throwing", async () => {
    // Constructs a minimal GameState with an open pendingInPlayTarget for
    // an AI player, then calls aiStep. Verifies that the prompt resolves
    // (either through a registered policy or the first-eligible fallback)
    // and the engine doesn't stall. This is the dead-code-prevention guard
    // for AI_INPLAY_POLICIES — if the aiStep drain is removed in a future
    // refactor, this test surfaces it.
    const { aiStep } = await import("../ai");
    const { setupGame, resolveCoinGuess, chooseFirstPlayer, completeSetup, isBasic, isPokemon } = await import("../rules");
    const { makeRng } = await import("../rng");
    const { buildDeck, DECK_SPECS } = await import("../../data/decks");

    const state = setupGame(
      buildDeck(DECK_SPECS[0]),
      buildDeck(DECK_SPECS[1]),
      makeRng(901),
      { p2IsAI: false },
    );
    resolveCoinGuess(state, "heads");
    chooseFirstPlayer(state, state.coinFlip!.winner!, true);
    for (const pid of ["p1", "p2"] as const) {
      const idx = state.players[pid].hand.findIndex(
        (c) => isPokemon(c) && isBasic(c),
      );
      completeSetup(state, pid, idx, []);
    }
    state.firstTurnNoAttack = false;
    state.turn = 2;
    const ap = state.activePlayer;
    state.players[ap].isAI = true;
    // Add damage so abilityHealAny finds a valid target.
    if (state.players[ap].active) state.players[ap].active.damage = 50;

    // Open a generic-scored in-play target prompt that the fallback can
    // resolve (any-pokemon scope = own, slot = anywhere).
    state.pendingInPlayTarget = {
      player: ap,
      label: "Test: pick any of your Pokémon",
      scope: "own",
      slot: "anywhere",
      filter: "anyPokemon",
      action: { kind: "abilityHealAny", amount: 10 },
    };

    aiStep(state, ap);
    // After aiStep, the prompt should be drained (either resolved or cancelled).
    expect(state.pendingInPlayTarget).toBeNull();
  });

  it("parsed effect-kind gate: zero high/med autoSuspect rows in the audit tables", () => {
    // This gate covers parsed effect kinds only. It does not imply terminal
    // user-choice coverage across the tournament-legal pool; the report-status
    // ledger above keeps `needsFix` and `unparsed` card rows explicit until
    // follow-up phases convert them to tested behavior or exceptions.
    const tables = [
      { name: "ABILITY_AUDIT", t: ABILITY_AUDIT },
      { name: "ATTACK_AUDIT", t: ATTACK_AUDIT },
      { name: "TRAINER_AUDIT", t: TRAINER_AUDIT },
    ] as const;
    const offenders: string[] = [];
    for (const { name, t } of tables) {
      for (const [kind, c] of Object.entries(t)) {
        if (c.kind === "autoSuspect" && (c.severity === "high" || c.severity === "med")) {
          offenders.push(`${name}.${kind} = ${c.severity}: ${c.rationale}`);
        }
      }
    }
    expect(offenders, `Audit still has high/med autoSuspect rows:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});
