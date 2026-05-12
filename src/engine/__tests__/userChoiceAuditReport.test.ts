// User-choice audit report generator.
//
// Vitest-gated: runs only when `AUDIT_REPORT=1` is set in the environment.
// Walks every tournament-legal card, joins its parsed effect kinds against
// ABILITY_AUDIT / ATTACK_AUDIT / TRAINER_AUDIT, and writes
// docs/USER_CHOICE_AUDIT.md grouped by severity.
//
// Run with:
//
//   npm run audit:choices
//
// The report is checked in so reviewers can read the audit without running
// the test. CI does NOT regenerate the report — the audit tables + their
// exhaustiveness guards in effectAuditCoverage.test.ts are what enforce
// coverage.

import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  ABILITY_AUDIT,
  ATTACK_AUDIT,
  TRAINER_AUDIT,
  CARD_LEVEL_EXCEPTIONS,
  hasPromptText,
  type EffectClassification,
} from "../_audit/userChoiceAudit";
import {
  PROMPT_BEHAVIOR_TESTS,
  PHASE3_PHASE4_PLACEHOLDER_SHAPES,
  type PromptBehaviorShape,
} from "../_audit/promptBehaviorAudit";
import { mapCard, type ApiCard } from "../../data/cardMapper";
import { getAttackEffects } from "../../data/effectPatterns";
import { DECK_SPECS } from "../../data/decks";
import type { PokemonCard, TrainerCard } from "../types";
import type { TrainerEffectId } from "../trainerEffects";

// ---------------------------------------------------------------------------
// Card → deck membership join (by name match in the decklist text).
// ---------------------------------------------------------------------------

function buildNameToDeckMap(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const spec of DECK_SPECS) {
    // Each decklist line that starts with a quantity + name like "4 Drakloak SCR 130".
    const lines = spec.decklist.split("\n");
    for (const line of lines) {
      const m = line.match(/^\d+\s+(.+?)\s+[A-Z][A-Z0-9-]+\s+\d+/);
      if (!m) continue;
      const name = m[1].trim();
      const existing = out.get(name) ?? [];
      if (!existing.includes(spec.name)) existing.push(spec.name);
      out.set(name, existing);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Behavior-shape lookup — given an effect kind, which PromptBehaviorShape(s)
// is it associated with? We compute this from PROMPT_BEHAVIOR_TESTS keys and
// a name-based mapping. The placeholder set is excluded for the report's
// Status column unless the effect's kind has been wired through that shape.
//
// This map is heuristic: a kind maps to one shape if its name plainly fits
// (e.g. "searchDeckAnyCard" → "deckSearch_anyCard"). Unmapped kinds report
// shape = "(unmapped)" — the audit team can refine the map row by row.
// ---------------------------------------------------------------------------

function behaviorShapeFor(kind: string): PromptBehaviorShape | "(unmapped)" {
  // Manual map for known cards. Phase 3/4 fills in placeholders as
  // conversions land.
  const direct: Record<string, PromptBehaviorShape> = {
    // Ability kinds
    searchDeckAnyCard: "deckSearch_anyCard",
    searchDeckPokemon: "deckSearch_pokemon",
    searchDeckPokemonNamePrefix: "deckSearch_pokemonNamePrefix",
    searchBasicEnergy: "deckSearch_basicEnergy",
    searchDeckStadium: "deckSearch_stadium",
    searchDeckTrainerByName: "deckSearch_trainerByName",
    searchEvolutionPokemonGated: "deckSearch_evolutionGated",
    searchEvolutionPokemonOfType: "deckSearch_evolutionOfType",
    searchDeckAnyCardToTopdeck: "deckSearch_anyToTopdeck",
    searchEnergyIfSupporterPlayedName: "deckSearch_energyIfSupporterPlayedName",
    top6RevealSupporter: "topPeek_supporter",
    attachEnergyFromDiscardToSelf: "inPlayTarget_attachEnergyDiscardSelf",
    moveDamageOwnToOpp: "inPlayTarget_moveDamageOwnToOpp",
    fanCallFirstTurn: "deckSearch_pokemon",
    peek2Top: "topPeek_drakloak_recon",
    peekTopMayDiscard: "topPeek_morpeko_snackSeek",
    swapHandCardWithDeckTop: "handReveal_swapWithDeckTop",
    revealOppHandPutOnOppBench: "handReveal_oppBasicHpCap",
    flipChooseStatusOpp: "chooseStatus_threeWay",
    discardHandEnergyDrawToN: "handEnergyDiscard_drawToN",
    discardHandEnergyPlaceCountersOnOpp: "handEnergyDiscardThenInPlayTarget",
    moveOwnBasicEnergyBetween: "moveEnergySourceDest_typedBasic",
    moveBasicEnergyAnywhere: "moveEnergySourceDest_anyBasic_asOften",
    switchBenchedTypeToActiveWithStatus: "inPlayTarget_switchTypedBenchedWithStatus",
    swapWithBenchAndForceOppPromote: "inPlayTarget_swapWithBenchForceOppPromote",
    discardToolFromHandGustOpp: "handReveal_discardToolThenInPlayTarget",
    top4AttachEnergyType: "inPlayTarget_attachEnergyPerTop4",
    // Phase 6/7 multi-step distribution mappings
    attachNFromDiscardThenSelfKO: "rearmingAttachFromDiscardTyped",
    attachMixedFromHand: "rearmingAttachMixedFromHand",
    moveAnyEnergyAcrossOwn: "rearmingMoveEnergyAnywhereOwn",
    attachAnyBasicFromHandAll: "rearmingAttachAllBasicFromHand",
    discardAnyEnergyAcrossOwnForDamage: "preAttackDiscardForDamage",
    discardEnergyAnywhereForDamage: "preAttackDiscardForDamage",
    // Heal / switch / devolve ability mappings (use generic shapes).
    healAny: "inPlayTarget_anyHeal",
    healAnyIfEnergyAttached: "inPlayTarget_anyHeal",
    healAnyIfMegaExTypeInPlay: "inPlayTarget_anyHeal",
    switchWithBench: "switch_simpleSwitch",
    devolveOppEvolution: "inPlayTarget_devolveSingle",
    // Search-attack effects: searchDeckAttack covers most attack-driven
    // tutors. Many of these run as in-attack pickers; map to the
    // generic attack-builder shape.
    searchDeckAttack: "deckSearch_attackBuilder",
    searchEvolveSelf: "deckSearch_evolve",
    searchEvolveBench: "deckSearch_evolve",
    searchAndEvolveOne: "deckSearch_evolve",
    searchAndEvolveNamedTypePokemon: "deckSearch_evolveAttackName",
    searchAndTopdeckTwo: "deckSearch_andTopdeckTwo",
    searchEnergyForEachBench: "deckSearch_energyForEachBench",
    searchDeckNamedToBenchN: "deckSearch_namedToBenchN",
    searchDeckNamedPokemonToHand: "deckSearch_namedPokemonToHand",
    searchDeckMixedToHand: "deckSearch_mixedToHand",
    searchDeckNamedPokemonToBench: "deckSearch_namedPokemonToBench",
    searchDeckBasicNamedToBench: "deckSearch_namedBasicToBench",
    searchDeckBasicTypeToBench: "deckSearch_basicTypeToBench",
    searchAnyEnergyToHand: "deckSearch_anyEnergyToHand",
    searchAnyNamedTrainerToHand: "deckSearch_namedTrainerToHand",
    searchAnyBasicNamedToBench: "deckSearch_anyBasicNamedToBench",
    searchStadiumToHand: "deckSearch_stadiumToHand",
    // Energy-attach search variants
    searchBasicEnergyAttachBench: "deckSearch_basicEnergyAttach",
    searchBasicEnergyAttachOne: "deckSearch_basicEnergyAttach",
    searchBasicEnergyAttachOneN: "deckSearch_basicEnergyAttach",
    searchBasicEnergyAttachSubtype: "deckSearch_basicEnergyAttach",
    searchBasicEnergyDifferentTypesToBenchSubtype: "deckSearch_basicEnergyAttach",
    searchBasicEnergyTypeAttachBench: "deckSearch_basicEnergyAttach",
    searchBasicEnergyTypeAttachOneBench: "deckSearch_basicEnergyAttach",
    searchEnergyAttachBenchType: "deckSearch_basicEnergyAttach",
    // Reveal/discard hand
    revealOppHand: "handReveal_revealOppHandDiscard",
    discardOppItems: "handReveal_discardOppItems",
    // Attack kinds
    callForFamily: "deckSearch_callForFamily",
    damageMultipleTargets: "inPlayTarget_phantomDive",
    distributeDamage: "inPlayTarget_distribute",
    snipeOne: "inPlayTarget_snipeOne",
    snipeOnePerEnergy: "inPlayTarget_snipeOne",
    placeCountersOnOppBenchAny: "inPlayTarget_placeCounterOpp",
    switchOutOpponent: "inPlayTarget_switchOpp",
    gustOppBenchedAttack: "inPlayTarget_gustAttack",
    moveDamageOwnBenchToOpp: "inPlayTarget_moveDamageOwnBenchToOpp",
    discardOppTools: "inPlayTarget_discardOppTools",
    discardOppToolsN: "inPlayTarget_discardOppTools",
    discardOppEnergy: "inPlayTarget_discardOppEnergy",
    discardTypedOppEnergy: "inPlayTarget_discardTypedOppEnergy",
    discardBenchEnergyForDamage: "inPlayTarget_discardBenchEnergyForDamage",
    discardEnergyFromHandForDamage: "inPlayTarget_discardEnergyFromHandForDamage",
    discardHandEnergyForDamage: "inPlayTarget_discardHandEnergyForDamage",
    revealOppHandDiscard: "handReveal_revealOppHandDiscard",
    oppChoosesHandToDeck: "handReveal_oppChoosesHandToDeck",
    flipNRecoverDiscardToHand: "discardRecover_flipN",
    recoverPokemonFromDiscardToBench: "discardRecover_pokemonToBench",
    recoverPokemonFromDiscardToHand: "discardRecover_pokemonToHand",
    recoverTrainerFromDiscard: "discardRecover_trainer",
    recoverTrainerFromDiscardToHand: "discardRecover_trainerToHand",
    recoverBasicEnergyTypeToHand: "discardRecover_basicEnergyType",
    // Trainer effect ids
    bigCatchingNet: "inPlayTarget_bigCatchingNet",
    boxedOrder: "deckSearch_anyCard",
    bugCatchingSet: "topPeek_bugCatchingSet",
    callBell: "deckSearch_pokemon",
    canariLightningSearch: "deckSearch_pokemon",
    cassiopeiaSearch2: "deckSearch_pokemon",
    ciphermaniacSearch: "deckSearch_anyCard",
    crushingHammer: "inPlayTarget_crushingHammer",
    darkBasicPokemonTopPeek: "topPeek_darkBasicPokemon",
    dawnSearchBasicStage1Stage2: "deckSearch_chain_basicStage1Stage2",
    deductionKit: "deckSearch_anyCard",
    discardOppItemsHand: "handReveal_discardOppItems",
    discardOppToolAndSpecialEnergy: "inPlayTarget_discardOppTools",
    draytonTop7: "topPeek_drayton",
    duskBall: "bottomPeek_duskBall",
    energyRecycler: "discardRecover_energyRetrieval",
    energyRetrieval: "discardRecover_energyRetrieval",
    energySwatter: "inPlayTarget_crushingHammer",
    energySwitchOwn: "inPlayTarget_energySwitch",
    enhancedHammer: "inPlayTarget_enhancedHammer",
    eriDiscardOppItems: "handReveal_eriDiscardItems",
    flipGustOppBenched: "inPlayTarget_pokemonCatcher",
    glassTrumpet: "inPlayTarget_glassTrumpet",
    gustConfuseOppBasic: "inPlayTarget_boss",
    gustOppBenched: "inPlayTarget_boss",
    hasselTop8Take3: "topPeek_hassel",
    heal150Any: "inPlayTarget_anyHeal",
    heal150Psychic: "inPlayTarget_psychicHeal",
    heal30Active: "inPlayTarget_potion",
    heal30OrArven100: "inPlayTarget_potion",
    heal60ActiveAndCure: "inPlayTarget_potion",
    heal60DiscardEnergy: "inPlayTarget_superPotion",
    heal70Active: "inPlayTarget_potion",
    heal80IfEnergyCap: "inPlayTarget_potion",
    healDragon60: "inPlayTarget_dragon60",
    healMegaExAndEnergyToHand: "inPlayTarget_healMegaExEnergyToHand",
    janineSecretArt: "inPlayTarget_pokemonCatcher",
    kofuBottom2Draw4: "handReveal_kofuBottom2",
    larrySkillDiscardSearch: "deckSearch_anyCard",
    loveBall: "deckSearch_pokemon",
    ltSurgeBargain: "deckSearch_pokemon",
    ltSurgeStrategy: "deckSearch_pokemon",
    maxRodRecoverPokemonOrEnergy: "discardRecover_maxRod",
    megatonBlower: "inPlayTarget_discardOppTools",
    naveenPreDiscardDraw5: "handReveal_naveenPreDiscard",
    nightStretcher: "discardRecover_nightStretcher",
    ogresMaskSwapOgerpon: "inPlayTarget_ogresMask",
    perrinSearch: "deckSearch_anyCard",
    philippeMetalEnergy: "deckSearch_basicEnergy",
    pokegear37: "topPeek_supporter",
    primeCatcher: "inPlayTarget_boss",
    protonSearchBasicTR: "deckSearch_namedPokemonToBench",
    raifortPeek5Discard: "topPeek_raifort5Discard",
    rareCandyEvolve: "rareCandy_evolveStage2",
    rebootPodFuture: "deckSearch_pokemon",
    recover2Supporters: "discardRecover_2supporters",
    recoverFromDiscardLana: "discardRecover_lanasAid",
    recoverFromDiscardTarragon: "discardRecover_tarragon",
    rosaEnergyToStage2: "deckSearch_basicEnergy",
    roxiesPerformance: "deckSearch_anyCard",
    sacredAsh: "discardRecover_sacredAsh",
    salvatoreEvolveSearch: "deckSearch_evolve",
    scoopUpCyclone: "inPlayTarget_scoopUpCyclone",
    scrambleSwitch: "switch_simpleSwitch",
    search3Pokemonex: "deckSearch_pokemonex3",
    searchAnyBasicsToBench: "deckSearch_anyBasicNamedToBench",
    searchAnyPokemon: "handReveal_ultraBall",
    searchAnyPokemonFree: "deckSearch_pokemon",
    searchBasicEnergy1: "deckSearch_basicEnergy",
    searchBasicEnergyN: "deckSearch_basicEnergy",
    searchBasicEnergyX: "deckSearch_basicEnergy",
    searchBasicPokemon1: "deckSearch_pokemon",
    searchBasicPokemon2Poffin: "deckSearch_pokemon",
    searchEnergyToBench: "deckSearch_basicEnergy",
    searchEnergyVariety: "deckSearch_basicEnergy",
    searchEvolutionAndEnergy: "deckSearch_evolve",
    searchEvolutionPokemon: "deckSearch_evolve",
    searchFightingBasicOrEnergy: "deckSearch_pokemon",
    searchHopsBasics: "deckSearch_hopsBasics",
    searchMegaEx: "deckSearch_megaEx",
    searchNonRuleBoxPokemon: "deckSearch_pokemon",
    searchPokemonCoinFlip: "deckSearch_pokemon",
    searchStadiumAndEnergy: "deckSearch_chain_stadiumAndEnergy",
    searchStage1x3: "deckSearch_pokemon",
    searchTMTools: "deckSearch_TMTools",
    searchTRSupporter: "deckSearch_TRSupporter",
    searchTeraPokemon: "deckSearch_teraPokemon",
    searchTopBasicEnergyAttach: "topPeek_supporter",
    searchTrainer: "deckSearch_anyCard",
    searchUpTo2Basic: "deckSearch_pokemon",
    secretBoxQuadSearch: "deckSearch_secretBoxQuad",
    simpleSwitch: "switch_simpleSwitch",
    strangeTimepieceDevolve: "inPlayTarget_devolveSingle",
    surferSwitchDraw5: "switch_simpleSwitch",
    switchActive: "switch_simpleSwitch",
    tomesOfTransformation: "deckSearch_pokemon",
    toolScrapper: "inPlayTarget_toolScrapper",
    top6Take2Discard4: "topPeek_take2Discard4",
    topPeekSupporterGrassFire: "topPeek_grassFireOrSimilar",
    trGiovanniSwitchGust: "inPlayTarget_pokemonCatcher",
    trGreatBallFlip: "deckSearch_pokemon",
    treasureTrackerToolSearch: "deckSearch_anyCard",
    wondrousPatchPsychic: "inPlayTarget_wondrousPatch",
    acerolasMischief: "inPlayTarget_potion",
    accompanyingFlute: "deckSearch_pokemon",
    azsTranquility: "discardRecover_pokemonToHand",
    repelSwitchOut: "switch_repelSwitchOut",
  };
  if (kind in direct) return direct[kind];
  return "(unmapped)";
}

// ---------------------------------------------------------------------------
// Report row + status derivation
// ---------------------------------------------------------------------------

type Status = "tested" | "needsFix" | "exception" | "unparsed";

interface ReportRow {
  cardName: string;
  setNumber: string;
  effectText: string;
  parsedKind: string; // or "unparsedPromptText"
  shape: PromptBehaviorShape | "(unmapped)" | "(n/a)";
  testFile: string;
  classification: EffectClassification | { kind: "unparsedPromptText"; severity: "high" | "med" | "low" };
  status: Status;
  decks: string[];
}

const placeholderShapes = new Set<PromptBehaviorShape>(PHASE3_PHASE4_PLACEHOLDER_SHAPES);

function statusCounts(rows: ReportRow[]): Record<Status, number> {
  return rows.reduce<Record<Status, number>>(
    (acc, row) => {
      acc[row.status]++;
      return acc;
    },
    { tested: 0, needsFix: 0, exception: 0, unparsed: 0 },
  );
}

function statusFor(
  classification: ReportRow["classification"],
  shape: ReportRow["shape"],
  testFile: string,
  cardName: string,
): Status {
  if (CARD_LEVEL_EXCEPTIONS[cardName]) return "exception";
  if (classification.kind === "unparsedPromptText") return "unparsed";
  if (classification.kind === "autoSuspect") return "needsFix";
  if (classification.kind === "missingSkip") return testFile ? "tested" : "needsFix";
  if (classification.kind === "autoCorrectByRule") return "tested";
  // prompts
  if (shape === "(unmapped)" || shape === "(n/a)") return "needsFix";
  if (placeholderShapes.has(shape as PromptBehaviorShape)) return "needsFix";
  return testFile ? "tested" : "needsFix";
}

function severityBucket(c: ReportRow["classification"]): string {
  if (c.kind === "autoSuspect") return `autoSuspect / ${c.severity}`;
  if (c.kind === "unparsedPromptText") return `unparsedPromptText / ${c.severity}`;
  if (c.kind === "missingSkip") return "missingSkip";
  if (c.kind === "prompts") return "prompts";
  return "autoCorrectByRule";
}

// Severity rank for printed text we can't parse — heuristic.
function unparsedSeverity(text: string): "high" | "med" | "low" {
  if (/\bchoose\b|\bput \d+\b|\blook at\b/i.test(text)) return "high";
  if (/\bmay\b/i.test(text)) return "med";
  return "low";
}

// Section order top → bottom.
const SECTION_ORDER = [
  "autoSuspect / high",
  "autoSuspect / med",
  "autoSuspect / low",
  "missingSkip",
  "unparsedPromptText / high",
  "unparsedPromptText / med",
  "unparsedPromptText / low",
  "prompts",
  "autoCorrectByRule",
];

// ---------------------------------------------------------------------------
// Main report generator
// ---------------------------------------------------------------------------

function generateReport(): { rows: ReportRow[]; markdown: string } {
  const raw = JSON.parse(
    readFileSync("data/pokemon/tournament-legal-cards.json", "utf8"),
  ) as { cards: ApiCard[] };

  const decksByName = buildNameToDeckMap();
  const rows: ReportRow[] = [];

  for (const apiCard of raw.cards) {
    const card = mapCard(apiCard);
    const decks = decksByName.get(card.name) ?? [];
    const setNumber = `${apiCard.set_code ?? "?"}/${apiCard.number ?? "?"}`;

    if (card.supertype === "Pokémon") {
      const pkmn = card as PokemonCard;
      for (const ab of pkmn.abilities ?? []) {
        const effectText = ab.text ?? "";
        if (ab.effect) {
          const kind = ab.effect.kind;
          const classification = ABILITY_AUDIT[kind];
          const shape = behaviorShapeFor(kind);
          const testFile =
            shape !== "(unmapped)"
              ? (PROMPT_BEHAVIOR_TESTS[shape] ?? [])[0] ?? ""
              : "";
          rows.push({
            cardName: card.name,
            setNumber,
            effectText: `[${ab.name}] ${effectText}`,
            parsedKind: kind,
            shape,
            testFile,
            classification,
            status: statusFor(classification, shape, testFile, card.name),
            decks,
          });
        } else if (hasPromptText(effectText)) {
          const severity = unparsedSeverity(effectText);
          const classification = { kind: "unparsedPromptText" as const, severity };
          rows.push({
            cardName: card.name,
            setNumber,
            effectText: `[${ab.name}] ${effectText}`,
            parsedKind: "unparsedPromptText",
            shape: "(n/a)",
            testFile: "",
            classification,
            status: statusFor(classification, "(n/a)", "", card.name),
            decks,
          });
        }
      }

      for (const attack of pkmn.attacks ?? []) {
        const effects = getAttackEffects(attack);
        const text = attack.text ?? "";
        if (effects.length === 0) {
          if (text && hasPromptText(text)) {
            const severity = unparsedSeverity(text);
            const classification = { kind: "unparsedPromptText" as const, severity };
            rows.push({
              cardName: card.name,
              setNumber,
              effectText: `[${attack.name}] ${text}`,
              parsedKind: "unparsedPromptText",
              shape: "(n/a)",
              testFile: "",
              classification,
              status: statusFor(classification, "(n/a)", "", card.name),
              decks,
            });
          }
          continue;
        }
        for (const eff of effects) {
          const classification = ATTACK_AUDIT[eff.kind];
          const shape = behaviorShapeFor(eff.kind);
          const testFile =
            shape !== "(unmapped)"
              ? (PROMPT_BEHAVIOR_TESTS[shape] ?? [])[0] ?? ""
              : "";
          rows.push({
            cardName: card.name,
            setNumber,
            effectText: `[${attack.name}] ${text}`,
            parsedKind: eff.kind,
            shape,
            testFile,
            classification,
            status: statusFor(classification, shape, testFile, card.name),
            decks,
          });
        }
      }
    } else if (card.supertype === "Trainer") {
      const tr = card as TrainerCard;
      const text = tr.text ?? "";
      if (tr.effectId) {
        const effectId = tr.effectId as TrainerEffectId;
        const classification = TRAINER_AUDIT[effectId];
        const shape = behaviorShapeFor(effectId);
        const testFile =
          shape !== "(unmapped)"
            ? (PROMPT_BEHAVIOR_TESTS[shape] ?? [])[0] ?? ""
            : "";
        rows.push({
          cardName: card.name,
          setNumber,
          effectText: text,
          parsedKind: effectId,
          shape,
          testFile,
          classification,
          status: statusFor(classification, shape, testFile, card.name),
          decks,
        });
      } else if (hasPromptText(text)) {
        const severity = unparsedSeverity(text);
        const classification = { kind: "unparsedPromptText" as const, severity };
        rows.push({
          cardName: card.name,
          setNumber,
          effectText: text,
          parsedKind: "unparsedPromptText",
          shape: "(n/a)",
          testFile: "",
          classification,
          status: statusFor(classification, "(n/a)", "", card.name),
          decks,
        });
      }
    }
  }

  // Group rows by section and render markdown.
  const bySection = new Map<string, ReportRow[]>();
  for (const r of rows) {
    const sec = severityBucket(r.classification);
    if (!bySection.has(sec)) bySection.set(sec, []);
    bySection.get(sec)!.push(r);
  }
  // Sort each section: needsFix/unparsed first, then alphabetical by card name.
  for (const arr of bySection.values()) {
    arr.sort((a, b) => {
      const aPri = a.status === "needsFix" || a.status === "unparsed" ? 0 : 1;
      const bPri = b.status === "needsFix" || b.status === "unparsed" ? 0 : 1;
      if (aPri !== bPri) return aPri - bPri;
      return a.cardName.localeCompare(b.cardName);
    });
  }

  const total = rows.length;
  const counts = SECTION_ORDER.map((s) => `${s}: ${(bySection.get(s) ?? []).length}`).join(" • ");
  const status = statusCounts(rows);
  const openRows = status.needsFix + status.unparsed;

  const md: string[] = [];
  md.push("# User-Choice Audit");
  md.push("");
  md.push("Auto-generated by `npm run audit:choices`. Do not hand-edit.");
  md.push("");
  md.push("This report joins every tournament-legal card to its parsed effect kind, classifies the kind via [src/engine/_audit/userChoiceAudit.ts](../src/engine/_audit/userChoiceAudit.ts), and reports whether the card's printed user choice is honored by the engine.");
  md.push("");
  md.push(`**Total rows:** ${total}`);
  md.push("");
  md.push(`**Counts:** ${counts}`);
  md.push("");
  md.push(`**Status counts:** tested: ${status.tested} • needsFix: ${status.needsFix} • exception: ${status.exception} • unparsed: ${status.unparsed}`);
  md.push("");
  if (openRows > 0) {
    md.push(`> Not terminal-complete: ${openRows} rows still require implementation, parsing, or an explicit exception.`);
    md.push("");
  }
  md.push("**Status legend:**");
  md.push("- `tested` — classification ∈ {prompts, autoCorrectByRule, missingSkip-with-skip-test} AND a behavior test is registered for the prompt shape.");
  md.push("- `needsFix` — engine auto-resolves a printed user choice; Phase 3/4 will convert this row to a prompt.");
  md.push("- `exception` — listed in `CARD_LEVEL_EXCEPTIONS` with a written rationale.");
  md.push("- `unparsed` — printed text contains prompt-worthy language but the engine has no parsed effect kind.");
  md.push("");

  for (const section of SECTION_ORDER) {
    const arr = bySection.get(section) ?? [];
    if (arr.length === 0) continue;
    md.push(`## ${section} (${arr.length})`);
    md.push("");
    md.push("| Card | Set/# | Effect text | Kind | Shape | Behavior test | Status | Decks |");
    md.push("|------|-------|-------------|------|-------|----------------|--------|-------|");
    for (const r of arr) {
      const text = r.effectText.replace(/\|/g, "\\|").replace(/\n/g, " ");
      const truncated = text.length > 180 ? text.slice(0, 177) + "…" : text;
      md.push(
        `| ${r.cardName} | ${r.setNumber} | ${truncated} | \`${r.parsedKind}\` | \`${r.shape}\` | ${r.testFile ? `\`${r.testFile}\`` : "—"} | ${r.status} | ${r.decks.join(", ") || "—"} |`,
      );
    }
    md.push("");
  }

  return { rows, markdown: md.join("\n") };
}

describe("user-choice audit report", () => {
  if (process.env.AUDIT_REPORT !== "1") {
    it.skip("regenerates docs/USER_CHOICE_AUDIT.md (set AUDIT_REPORT=1 to enable)", () => {});
    return;
  }

  it("writes docs/USER_CHOICE_AUDIT.md", () => {
    const { rows, markdown } = generateReport();
    writeFileSync("docs/USER_CHOICE_AUDIT.md", markdown);
    // Surface a few summary lines for the test reporter.
    // eslint-disable-next-line no-console
    console.log(`Wrote ${rows.length} rows to docs/USER_CHOICE_AUDIT.md`);
  });
});
