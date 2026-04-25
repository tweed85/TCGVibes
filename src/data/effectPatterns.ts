// Parse Pokémon TCG attack text into structured AttackEffect entries.
//
// Coverage is deliberately narrow: we only match common, unambiguous patterns
// so the engine applies effects that match the card's printed text. Anything
// that doesn't match stays as free-form `text` on the attack — the UI shows
// it, the engine just doesn't evaluate it.

import type {
  AttackEffect,
  AttackPredicate,
  AttackSearchFilter,
  EnergyType,
  PokemonFilter,
  StatusCondition,
} from "../engine/types";

interface ApiAttack {
  name: string;
  cost?: string[];
  damage?: string;
  text?: string;
}

interface PatternMatch {
  effects: AttackEffect[];
  baseDamageOverride?: number; // replace the parsed damage (for "30×" per-energy attacks)
}

const STATUS_FROM_TEXT: Record<string, StatusCondition> = {
  asleep: "asleep",
  burned: "burned",
  confused: "confused",
  paralyzed: "paralyzed",
  poisoned: "poisoned",
};

const ENERGY_TYPES: EnergyType[] = [
  "Grass", "Fire", "Water", "Lightning", "Psychic",
  "Fighting", "Darkness", "Metal", "Fairy", "Dragon", "Colorless",
];

function matchEnergyType(s: string): EnergyType | undefined {
  const hit = ENERGY_TYPES.find((t) => s.toLowerCase().includes(t.toLowerCase()));
  return hit;
}

export function extractEffects(atk: ApiAttack): PatternMatch {
  const effects: AttackEffect[] = [];
  let baseDamageOverride: number | undefined;
  const text = atk.text ?? "";
  const damageText = atk.damage ?? "";

  if (!text && !damageText.includes("×") && !damageText.includes("+")) {
    return { effects };
  }

  // ---- "N×" damage for each <thing> ---------------------------------------
  // Example: damage="30×", text="This attack does 30 damage for each Energy
  // attached to this Pokémon." The multiplier-X pattern zeros out the base
  // damage (the "×" suffix means "no damage without the multiplier").
  if (damageText.endsWith("×")) {
    const base = parseInt(damageText, 10);
    if (!isNaN(base)) {
      const perEnergyMatch = text.match(
        /for each ([A-Za-z]+ )?Energy attached/i,
      );
      const multEachHeads = text.match(
        /flip (\d+|a) coins?\. This attack does \d+ damage (times|for each) (the |times )?(number of heads|heads)/i,
      );
      // Detection order matters: check the more-specific per-X patterns
      // before generic "for each Energy" since some text contains both.
      if (/for each of your opponent'?s\s+benched pok[eé]mon/i.test(text)) {
        effects.push({ kind: "perOpponentBench", perCount: base });
        baseDamageOverride = 0;
      } else if (/for each benched pok[eé]mon\s*\(both yours and your opponent'?s\)/i.test(text)) {
        effects.push({ kind: "perBothBench", perCount: base });
        baseDamageOverride = 0;
      } else if (/for each of your\s+benched pok[eé]mon/i.test(text)) {
        effects.push({ kind: "perFriendlyBench", perCount: base });
        baseDamageOverride = 0;
      } else if (/for each damage counter on this pok[eé]mon/i.test(text)) {
        effects.push({ kind: "perDamageCounterOnSelf", perCount: base });
        baseDamageOverride = 0;
      } else if (/for each damage counter on your opponent'?s active pok[eé]mon/i.test(text)) {
        effects.push({ kind: "perDamageCounterOnDefender", perCount: base });
        baseDamageOverride = 0;
      } else if (/for each Energy attached to your opponent'?s active pok[eé]mon/i.test(text)) {
        effects.push({ kind: "perEnergyOnDefender", perCount: base });
        baseDamageOverride = 0;
      } else if (/for each Prize card your opponent has taken/i.test(text)) {
        effects.push({ kind: "perPrizeOppTaken", perCount: base });
        baseDamageOverride = 0;
      } else if (perEnergyMatch) {
        const qualifier = (perEnergyMatch[1] ?? "").trim();
        const energyType = matchEnergyType(qualifier);
        effects.push({ kind: "perAttachedEnergy", perEnergy: base, energyType });
        baseDamageOverride = 0;
      } else if (multEachHeads) {
        // Coin-flip multiplier damage — unimplemented; fall back to base.
        baseDamageOverride = base;
      } else {
        // Generic per-thing multiplier; treat as flat base for safety.
        baseDamageOverride = base;
      }
    }
  }

  // ---- "Flip a coin. If heads, this attack does N more damage." ------------
  {
    const m = text.match(/flip a coin\. if heads, (?:this attack does )?(\d+) more damage/i);
    if (m) effects.push({ kind: "flipHeadsBonus", bonus: parseInt(m[1], 10) });
  }

  // ---- "This attack does N more damage for each [Type] Energy attached." ---
  // Additive bonus stacked on top of a base damage like "60+".
  if (!effects.some((e) => e.kind === "perAttachedEnergy")) {
    const m = text.match(
      /this attack does (\d+) more damage for each ([A-Za-z]+ )?Energy attached/i,
    );
    if (m) {
      const perEnergy = parseInt(m[1], 10);
      const qualifier = (m[2] ?? "").trim();
      const energyType = matchEnergyType(qualifier);
      effects.push({ kind: "perAttachedEnergy", perEnergy, energyType });
    }
  }

  // ---- Additive "+N more damage for each <thing>" patterns ----------------
  // These run when the base damage has a "+" suffix (e.g. "60+"), so the
  // base damage stays and this adds count × perCount on top.
  if (!effects.some((e) => e.kind === "perFriendlyBench")) {
    const m = text.match(/(\d+) more damage for each of your\s+benched pok[eé]mon/i);
    if (m) effects.push({ kind: "perFriendlyBench", perCount: parseInt(m[1], 10) });
  }
  if (!effects.some((e) => e.kind === "perOpponentBench")) {
    const m = text.match(/(\d+) more damage for each of your opponent'?s\s+benched pok[eé]mon/i);
    if (m) effects.push({ kind: "perOpponentBench", perCount: parseInt(m[1], 10) });
  }
  if (!effects.some((e) => e.kind === "perBothBench")) {
    const m = text.match(/(\d+) more damage for each benched pok[eé]mon\s*\(both yours and your opponent'?s\)/i);
    if (m) effects.push({ kind: "perBothBench", perCount: parseInt(m[1], 10) });
  }
  if (!effects.some((e) => e.kind === "perDamageCounterOnSelf")) {
    const m = text.match(/(\d+) more damage for each damage counter on this pok[eé]mon/i);
    if (m) effects.push({ kind: "perDamageCounterOnSelf", perCount: parseInt(m[1], 10) });
  }
  if (!effects.some((e) => e.kind === "perDamageCounterOnDefender")) {
    const m = text.match(/(\d+) more damage for each damage counter on your opponent'?s active pok[eé]mon/i);
    if (m) effects.push({ kind: "perDamageCounterOnDefender", perCount: parseInt(m[1], 10) });
  }
  if (!effects.some((e) => e.kind === "perEnergyOnDefender")) {
    const m = text.match(/(\d+) more damage for each Energy attached to your opponent'?s active pok[eé]mon/i);
    if (m) effects.push({ kind: "perEnergyOnDefender", perCount: parseInt(m[1], 10) });
  }
  if (!effects.some((e) => e.kind === "perEnergyOnBothActives")) {
    const m = text.match(/(\d+) more damage for each Energy attached to both active pok[eé]mon/i);
    if (m) effects.push({ kind: "perEnergyOnBothActives", perCount: parseInt(m[1], 10) });
  }
  // ---- Per-prize-you-taken --------------------------------------------------
  {
    const m = text.match(/(\d+) damage for each prize card you have taken/i);
    if (m) effects.push({ kind: "perPrizeYouTaken", perCount: parseInt(m[1], 10) });
  }
  // ---- Per-energy-in-opp-discard -------------------------------------------
  {
    const m = text.match(/(\d+) damage for each ([A-Za-z]+ )?energy card in your opponent'?s discard pile/i);
    if (m) {
      const t = m[2] ? matchEnergyType(m[2]) : undefined;
      effects.push({ kind: "perEnergyInOppDiscard", perCount: parseInt(m[1], 10), energyType: t });
    }
  }
  // ---- Per-status-on-defender ----------------------------------------------
  {
    const m = text.match(/(\d+) damage for each special condition affecting your opponent'?s active pok[eé]mon/i);
    if (m) effects.push({ kind: "perStatusOnDefender", perCount: parseInt(m[1], 10) });
  }
  // ---- Per-card-in-own-discard (typed energy / named filter) --------------
  {
    const m = text.match(/(\d+) more damage for each ([A-Za-z]+ )?energy cards? in your discard pile/i);
    if (m) {
      const t = m[2] ? matchEnergyType(m[2]) : undefined;
      if (t) {
        effects.push({ kind: "perCardInOwnDiscard", perCount: parseInt(m[1], 10), filter: { kind: "energyOfType", energyType: t } });
      }
    }
  }
  {
    const m = text.match(/(\d+) more damage for each ([A-Za-z']+) cards? in your discard pile/i);
    if (m && !effects.some((e) => e.kind === "perCardInOwnDiscard")) {
      // E.g., "Ancient cards" — use namePart matching subtype/name.
      effects.push({
        kind: "perCardInOwnDiscard",
        perCount: parseInt(m[1], 10),
        filter: { kind: "cardNamePart", namePart: m[2] },
      });
    }
  }
  // ---- Discard typed Energy from opp's Active ----------------------------
  {
    const m = text.match(/discard (?:a |an |\d+ )?([A-Za-z]+) energy from your opponent'?s active pok[eé]mon/i);
    if (m && !effects.some((e) => e.kind === "discardOppEnergy" || e.kind === "discardOppSpecialEnergy")) {
      const t = matchEnergyType(m[1]);
      if (t) effects.push({ kind: "discardTypedOppEnergy", count: 1, energyType: t });
    }
  }
  // ---- Self-cure all statuses ---------------------------------------------
  if (/this pok[eé]mon recovers from all special conditions/i.test(text)) {
    effects.push({ kind: "selfRecoverAllStatuses" });
  }
  // ---- Self ignores Weakness next turn -----------------------------------
  if (/during your opponent'?s next turn, this pok[eé]mon has no weakness/i.test(text)) {
    effects.push({ kind: "selfNoWeaknessNextTurn" });
  }
  // ---- Discard hand for draw ---------------------------------------------
  {
    const m = text.match(/discard a card from your hand\.\s*if you do, draw (\d+) cards?/i);
    if (m) effects.push({ kind: "discardHandForDraw", drawCount: parseInt(m[1], 10) });
  }
  // ---- Conditional base damage override ----------------------------------
  {
    const re = /if ([^.]+?), this attack'?s base damage is (\d+)/gi;
    for (const m of text.matchAll(re)) {
      const pred = parseAttackPredicate(m[1]);
      if (pred) {
        effects.push({ kind: "conditionalBaseDamageOverride", baseDamage: parseInt(m[2], 10), predicate: pred });
      }
    }
  }
  // ---- Peek top, optionally discard ---------------------------------------
  if (/look at the top card of your deck\.\s*you may discard that card/i.test(text)) {
    effects.push({ kind: "peekTopMayDiscard" });
  }
  // ---- Mill self for damage per typed energy -----------------------------
  {
    const m = text.match(/discard the top (\d+) cards? of your deck[\.,]?\s*(?:and )?this attack does (\d+) damage for each basic ([A-Za-z]+) energy card that you discarded/i);
    if (m) {
      const t = matchEnergyType(m[3]);
      if (t) effects.push({ kind: "millSelfForDamagePerType", count: parseInt(m[1], 10), damagePer: parseInt(m[2], 10), energyType: t });
    }
  }
  // ---- Move all damage from own bench → opp Pokémon ----------------------
  if (/move all damage counters from 1 of your benched pok[eé]mon to 1 of your opponent'?s pok[eé]mon/i.test(text)) {
    effects.push({ kind: "moveDamageOwnBenchToOpp" });
  }
  // ---- KO all opp Pokémon at or below N HP -------------------------------
  {
    const m = text.match(/knock out each of your opponent'?s pok[eé]mon that has (\d+) hp or less remaining/i);
    if (m) effects.push({ kind: "koAllOppWithLowHp", hpMax: parseInt(m[1], 10) });
  }
  // ---- Shuffle N opp's bench Pokémon into deck ---------------------------
  {
    const m = text.match(/choose (\d+) of your opponent'?s benched pok[eé]mon\.\s*(?:if you do, )?shuffle (?:those|all of) (?:your opponent'?s benched )?pok[eé]mon[^.]*?into (?:your opponent'?s|their) deck/i);
    if (m) effects.push({ kind: "shuffleOppBenchToDeck", count: parseInt(m[1], 10) });
  }
  // ---- Peek top N → optionally bench Pokémon -----------------------------
  {
    const m = text.match(/look at the top (\d+) cards? of your deck\.\s*you may put any number of pok[eé]mon you find there onto your bench/i);
    if (m) effects.push({ kind: "peekTopOptionalBench", count: parseInt(m[1], 10) });
  }
  // ---- Discard typed Energy from self → status on opp's Active -----------
  {
    const m = text.match(/(?:you may )?discard (\d+) ([A-Za-z]+) energy from this pok[eé]mon (?:and|to) make your opponent'?s active pok[eé]mon (asleep|burned|confused|paralyzed|poisoned)/i);
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) effects.push({
        kind: "discardOwnEnergyForStatus",
        count: parseInt(m[1], 10),
        energyType: t,
        status: m[3].toLowerCase() as StatusCondition,
      });
    }
  }
  // ---- Reveal named Pokémon from hand for damage ------------------------
  {
    const m = text.match(/reveal any number of ([A-Za-z][A-Za-z' ,-]+?) from your hand[\.,]?\s*(?:and )?this attack does (\d+) damage for each card you revealed/i);
    if (m) {
      // Split names on commas / "and" / "or"
      const names = m[1]
        .split(/,\s*(?:and |or )?|\s+(?:and|or)\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      effects.push({
        kind: "revealNamedFromHandForDamage",
        namesPattern: names,
        damagePer: parseInt(m[2], 10),
      });
    }
  }
  // ---- Discard a named Special Energy → KO opp Active --------------------
  if (
    /discard a team rocket'?s energy from this pok[eé]mon\.\s*if you do, discard your opponent'?s active pok[eé]mon and all attached cards/i.test(
      text,
    )
  ) {
    effects.push({ kind: "discardSpecialEnergyKoOpp", energyName: "Team Rocket's Energy" });
  }
  // ---- Reveal opp's hand (info-only) -------------------------------------
  // Skip if any reveal-opp-hand-*-action variant already pushed an effect that
  // would also reveal the hand.
  if (
    /^your opponent reveals their hand\.?\s*$/i.test(text) ||
    /\byour opponent reveals their hand\b/i.test(text) &&
      !effects.some((eft) => eft.kind === "revealOppHandDiscard" || eft.kind === "damagePerCardClassInOppHand")
  ) {
    if (!effects.some((eft) => eft.kind === "revealOppHand")) {
      effects.push({ kind: "revealOppHand" });
    }
  }
  // ---- For-each-bench evolution-search ----------------------------------
  if (/for each of your benched pok[eé]mon, search your deck for a card that evolves from that pok[eé]mon and put it onto that pok[eé]mon to evolve it/i.test(text)) {
    effects.push({ kind: "searchEvolveBench" });
  }
  // ---- Self next-turn attack-name bonus ---------------------------------
  {
    const m = text.match(/during your next turn, this pok[eé]mon'?s ([A-Za-z][A-Za-z' -]+?) attack does (\d+) more damage/i);
    if (m) {
      effects.push({ kind: "selfNextTurnAttackBonus", attackName: m[1].trim(), bonus: parseInt(m[2], 10) });
    }
  }
  // ---- This Pokémon can't use <Name> again until it leaves the Active Spot
  {
    const m = text.match(/this pok[eé]mon can'?t use ([A-Za-z][A-Za-z' -]+?) again until it leaves the active spot/i);
    if (m) effects.push({ kind: "selfCantUseAttackUntilLeavesActive", attackName: m[1].trim() });
  }
  // ---- KO opp if it has exactly N damage counters ------------------------
  {
    const m = text.match(/if your opponent'?s active pok[eé]mon has exactly (\d+) damage counters on it, that pok[eé]mon is knocked out/i);
    if (m) effects.push({ kind: "koOppIfExactlyDamageCounters", counters: parseInt(m[1], 10) });
  }
  // ---- Discard up to N opp Tools -----------------------------------------
  {
    const m = text.match(/discard up to (\d+) pok[eé]mon tools? from your opponent'?s pok[eé]mon/i);
    if (m) effects.push({ kind: "discardOppToolsN", max: parseInt(m[1], 10) });
  }
  // ---- Per Special Energy on self ----------------------------------------
  {
    const m = text.match(/this attack does (\d+) damage for each special energy card attached to this pok[eé]mon/i);
    if (m) effects.push({ kind: "perSpecialEnergyOnSelf", perCount: parseInt(m[1], 10) });
  }
  // ---- Damage reduction per counter on self ------------------------------
  {
    const m = text.match(/this attack does (\d+) less damage for each damage counter on this pok[eé]mon/i);
    if (m) effects.push({ kind: "perDamageCounterReduction", perCount: parseInt(m[1], 10) });
  }
  // ---- Attach Basic Energy from hand to 1 of your Pokémon ----------------
  if (/^attach a basic energy card from your hand to 1 of your pok[eé]mon\.?$/i.test(text.trim()) ||
      /\battach a basic energy card from your hand to 1 of your pok[eé]mon\.?\s*$/i.test(text)) {
    effects.push({ kind: "attachBasicFromHandToOne" });
  }
  // ---- Bounce N opp Energy to opp's hand ---------------------------------
  {
    const m = text.match(/(?:you may )?put (\d+) energy attached to your opponent'?s active pok[eé]mon into their hand/i);
    if (m) effects.push({ kind: "bounceOppEnergyToHand", count: parseInt(m[1], 10) });
  }
  // ---- Delayed damage on Defending at end of opp's next turn -------------
  {
    const m = text.match(/at the end of your opponent'?s next turn, put (\d+) damage counters? on the defending pok[eé]mon/i);
    if (m) effects.push({ kind: "delayedDamageOnDefender", counters: parseInt(m[1], 10) });
  }
  // ---- Damage opp down to a floor HP -------------------------------------
  {
    const m = text.match(/put damage counters? on your opponent'?s active pok[eé]mon until its remaining hp is (\d+)/i);
    if (m) effects.push({ kind: "damageOppDownTo", floorHp: parseInt(m[1], 10) });
  }
  // ---- Self-KO discard all attached --------------------------------------
  if (/^discard this pok[eé]mon and all attached cards\.?\s*$/i.test(text.trim()) ||
      /\bdiscard this pok[eé]mon and all attached cards\b/i.test(text)) {
    effects.push({ kind: "selfKoDiscardAll" });
  }
  // ---- Self-mill (no damage rider) ---------------------------------------
  if (!effects.some((e) => e.kind === "millSelfForDamagePerType" || e.kind === "revealTopForFilteredDamage")) {
    const m = text.match(/^discard the top (\d+|a) cards? of your deck\.?$/i);
    if (m) {
      const n = m[1].toLowerCase() === "a" ? 1 : parseInt(m[1], 10);
      effects.push({ kind: "discardTopOfOwnDeck", count: n });
    }
  }
  // ---- Reveal top N → +M damage per <subtype> found, then discard those --
  {
    const m = text.match(/reveal the top (\d+) cards? of your deck\.\s*this attack does (\d+) damage for each ([A-Za-z]+) card you find there\.\s*then,? discard those \3 cards/i);
    if (m) {
      effects.push({
        kind: "revealTopForFilteredDamage",
        count: parseInt(m[1], 10),
        damagePer: parseInt(m[2], 10),
        subtype: m[3],
      });
    }
  }
  // ---- Damage per counter on filtered bench ------------------------------
  {
    const m = text.match(/(\d+) damage for each damage counter on all of your benched ([A-Za-z][A-Za-z' -]*?) pok[eé]mon/i);
    if (m) {
      const filterStr = m[2].trim();
      const filter = parsePokemonFilter(filterStr) ?? { kind: "namePart", namePart: filterStr };
      effects.push({ kind: "perCountersOnFilteredBench", perCount: parseInt(m[1], 10), filter });
    }
  }
  // ---- Bounce one of your Benched + all attached → hand ------------------
  if (/^put 1 of your benched pok[eé]mon and all attached cards into your hand\.?$/i.test(text.trim()) ||
      /\bput 1 of your benched pok[eé]mon and all attached cards into your hand\b/i.test(text)) {
    effects.push({ kind: "bounceOneBench" });
  }
  // ---- Mill both decks → +N damage per Energy discarded ------------------
  {
    const m = text.match(/discard the top card of each player'?s deck\.\s*this attack does (\d+) more damage for each energy card discarded/i);
    if (m) effects.push({ kind: "millBothForEnergyDamage", damagePer: parseInt(m[1], 10) });
  }
  // ---- Discard-energy-for-damage riders -----------------------------------
  // "You may discard up to N Energy from your Benched Pokémon. +M more damage for each card discarded."
  {
    const m = text.match(/discard up to (\d+) energy from your benched pok[eé]mon\. this attack does (\d+) more damage for each card you discarded/i);
    if (m) effects.push({ kind: "discardBenchEnergyForDamage", max: parseInt(m[1], 10), damagePer: parseInt(m[2], 10) });
  }
  // "You may discard any amount of Energy from this Pokémon. This attack does N more damage for each card discarded."
  {
    const m = text.match(/discard any amount of energy from this pok[eé]mon\. this attack does (\d+) more damage for each card you discarded/i);
    if (m) effects.push({ kind: "discardOwnEnergyForDamage", damagePer: parseInt(m[1], 10) });
  }
  if (!effects.some((e) => e.kind === "perPrizeOppTaken")) {
    const m = text.match(/(\d+) more damage for each Prize card your opponent has taken/i);
    if (m) effects.push({ kind: "perPrizeOppTaken", perCount: parseInt(m[1], 10) });
  }

  // ---- "Flip a coin. If tails, this attack does nothing." ------------------
  {
    if (/flip a coin\. if tails, this attack does nothing/i.test(text)) {
      effects.push({ kind: "flipTailsFizzle" });
    }
  }

  // ---- "Flip a coin. If heads, this attack does X more damage." where X=base
  // We covered the explicit-N pattern above; another variant is "If heads,
  // this attack does double damage."
  {
    if (/if heads, this attack does double damage/i.test(text)) {
      effects.push({ kind: "flipHeadsDouble" });
    }
  }

  // ---- Status infliction on opponent's Active -------------------------------
  // Coin-flip-gated variants ALSO match — they need the flip wrapper. Detected
  // first so we know whether to emit the coin-gate too.
  const coinGateForStatus = /flip a coin\.\s*if heads,?\s+(?:your opponent'?s active pok[eé]mon|the defending pok[eé]mon) is now/i.test(text);
  // "Your opponent's Active Pokémon is now <status>."
  {
    const m = text.match(
      /opponent'?s Active Pok[eé]mon is now (Asleep|Burned|Confused|Paralyzed|Poisoned)/i,
    );
    if (m) {
      const status = STATUS_FROM_TEXT[m[1].toLowerCase()];
      if (status) {
        effects.push({ kind: "applyStatus", status, target: "defender", requiresHeads: coinGateForStatus || undefined });
      }
    }
  }
  // "The Defending Pokémon is now <status>." (older wording)
  {
    const m = text.match(
      /defending Pok[eé]mon is now (Asleep|Burned|Confused|Paralyzed|Poisoned)/i,
    );
    if (m) {
      const status = STATUS_FROM_TEXT[m[1].toLowerCase()];
      if (status && !effects.some((e) => e.kind === "applyStatus" && e.target === "defender")) {
        effects.push({ kind: "applyStatus", status, target: "defender", requiresHeads: coinGateForStatus || undefined });
      }
    }
  }
  // "This Pokémon is now <status>." — self-status (Snorlax Collapse, etc.).
  {
    const m = text.match(
      /this Pok[eé]mon is now (Asleep|Burned|Confused|Paralyzed|Poisoned)/i,
    );
    if (m) {
      const status = STATUS_FROM_TEXT[m[1].toLowerCase()];
      if (status) effects.push({ kind: "applyStatus", status, target: "self" });
    }
  }

  // ---- Self-damage (recoil) -------------------------------------------------
  // "This Pokémon also does N damage to itself."
  {
    const m = text.match(/this pok[eé]mon (?:also )?does (\d+) damage to itself/i);
    if (m) effects.push({ kind: "selfDamage", damage: parseInt(m[1], 10) });
  }

  // ---- Bench snipe — damage to each of opponent's benched ------------------
  // "This attack also does N damage to each of your opponent's Benched Pokémon."
  {
    const m = text.match(
      /(\d+) damage to each of your opponent'?s Benched Pok[eé]mon/i,
    );
    if (m) {
      effects.push({
        kind: "benchSnipe",
        damage: parseInt(m[1], 10),
        target: "opponentBench",
      });
    }
  }
  // "N damage to each of your Benched Pokémon AND your opponent's Benched."
  {
    const m = text.match(
      /(\d+) damage to each (?:other )?Pok[eé]mon \(both yours and your opponent'?s\)/i,
    );
    if (m) {
      effects.push({
        kind: "benchSnipe",
        damage: parseInt(m[1], 10),
        target: "allBench",
      });
    }
  }
  // "This attack does N damage to each of your opponent's Pokémon." (Active
  // included.) Often paired with a "(Don't apply Weakness and Resistance for
  // Benched Pokémon.)" clause; the resolver applies W/R to the Active normally.
  // Skip the "ex / V" qualifier variants here — those are class-filtered AOE
  // (e.g. Vaporeon ex Severe Squall hits only Pokémon ex). Future work.
  if (!/(\d+) damage to each of your opponent'?s Pok[eé]mon (?:ex|V)\b/i.test(text)) {
    const m = text.match(
      /(\d+) damage to each of your opponent'?s Pok[eé]mon\b/i,
    );
    if (m) {
      effects.push({
        kind: "benchSnipe",
        damage: parseInt(m[1], 10),
        target: "allOpponents",
      });
    }
  }

  // ---- Heal self ------------------------------------------------------------
  // "Heal N damage from this Pokémon."
  {
    const m = text.match(/heal (\d+) damage from this Pok[eé]mon/i);
    if (m) effects.push({ kind: "heal", amount: parseInt(m[1], 10), target: "self" });
  }

  // ---- Discard own energy ---------------------------------------------------
  // "Discard N Energy from this Pokémon." (or "all Energy")
  {
    const mAll = text.match(/discard all (?:\[[A-Za-z]\] |basic )?energy (?:cards? )?(?:attached )?from this pok[eé]mon/i);
    if (mAll) {
      // Use a sentinel of 99 — handler caps at attacher's actual energy.
      effects.push({ kind: "discardOwnEnergy", count: 99 });
    }
  }
  if (!effects.some((e) => e.kind === "discardOwnEnergy")) {
    const m = text.match(
      /discard (a|an|one|two|three|\d+) (?:\[[A-Za-z]\] |basic )?Energy (?:card )?(?:cards? )?(?:attached )?from this Pok[eé]mon/i,
    );
    if (m) {
      const tok = m[1].toLowerCase();
      const count =
        tok === "a" || tok === "an" || tok === "one"
          ? 1
          : tok === "two"
          ? 2
          : tok === "three"
          ? 3
          : parseInt(tok, 10) || 1;
      effects.push({ kind: "discardOwnEnergy", count });
    }
  }

  // ---- Draw cards -----------------------------------------------------------
  // "Draw cards until you have N cards in your hand." (Thievul Greedy Hunt)
  {
    const m = text.match(/(?:you may )?draw cards until you have (\d+) cards? in your hand/i);
    if (m) {
      effects.push({
        kind: "drawUntilHandSize",
        targetSize: parseInt(m[1], 10),
        optional: /^you may/i.test(m[0]) || undefined,
      });
    }
  }
  // "Draw N cards." or "Draw a card." (attack-level draw)
  if (!effects.some((e) => e.kind === "drawUntilHandSize")) {
    const m = text.match(/draw (\d+|a) cards?/i);
    if (m) {
      const n = m[1].toLowerCase() === "a" ? 1 : parseInt(m[1], 10);
      effects.push({ kind: "drawCards", count: n });
    }
  }

  // ---- Opponent can't play Item cards next turn -----------------------------
  // Budew's Itchy Pollen and similar disruption attacks.
  if (/they can't play any item cards from their hand/i.test(text)) {
    effects.push({ kind: "blockOppItemsNextTurn" });
  }

  // ---- "Flip N coins. This attack does N damage for each heads." ------------
  // Multiplicative: damage attribute is "X×" → base zeroed; perHeads × heads.
  // Additive: damage attribute is "X+" → keep base; perHeads × heads is added.
  {
    const m = text.match(/flip (\d+) coins?\. this attack does (\d+) (more )?damage for each heads/i);
    if (m) {
      const coins = parseInt(m[1], 10);
      const perHeads = parseInt(m[2], 10);
      const additive = !!m[3];
      effects.push({ kind: "flipMultiCoinsPerHeads", coins, perHeads });
      if (!additive) baseDamageOverride = 0;
    }
  }
  // ---- "Flip N coins. For each heads, <action>." ---------------------------
  // Per-heads non-damage rider — discard Energy or mill the opponent's deck.
  {
    const m = text.match(/flip (\d+) coins?\. for each heads, discard an energy from your opponent'?s active pok[eé]mon/i);
    if (m) {
      const coins = parseInt(m[1], 10);
      effects.push({ kind: "multiCoinFlipDiscardOppEnergy", coins });
    }
  }
  {
    const m = text.match(/flip (\d+) coins?\. for each heads, discard the top card of your opponent'?s deck/i);
    if (m) {
      const coins = parseInt(m[1], 10);
      effects.push({ kind: "multiCoinFlipMillOpp", coins });
    }
  }

  // ---- Self-lock next turn (handled below in the consolidated block) ------

  // ---- Defender can't retreat next turn -------------------------------------
  if (
    /during your opponent'?s next turn, (?:the defending pok[eé]mon|that pok[eé]mon) can'?t retreat/i.test(
      text,
    )
  ) {
    effects.push({ kind: "defenderCantRetreatNextTurn" });
  }
  // ---- Defender can't attack next turn --------------------------------------
  if (
    /during your opponent'?s next turn, (?:the defending pok[eé]mon|that pok[eé]mon) can'?t (?:use )?attacks?\b/i.test(
      text,
    )
  ) {
    effects.push({ kind: "defenderCantAttackNextTurn" });
  }

  // ---- Self-damage reduction next turn --------------------------------------
  {
    const m = text.match(/during your opponent'?s next turn, this pok[eé]mon takes (\d+) less damage/i);
    if (m) effects.push({ kind: "selfDamageReductionNextTurn", amount: parseInt(m[1], 10) });
  }

  // ---- Snipe one benched Pokémon --------------------------------------------
  {
    const m = text.match(/(\d+) damage to 1 of your opponent'?s (?:benched )?pok[eé]mon/i);
    if (m && !/each of/i.test(text)) {
      effects.push({ kind: "snipeOne", damage: parseInt(m[1], 10) });
    }
  }
  // ---- Multi-target damage (2-or-3 picks) ---------------------------------
  // "This attack [also] does N damage to (each of)? 2/3 of your opponent's
  // [Benched] Pokémon." Auto-picks most-damaged targets; humans don't get a
  // picker yet.
  {
    const m = text.match(/(?:this attack (?:also )?does )?(\d+) damage to (?:each of )?(\d+) of your opponent'?s (benched )?pok[eé]mon/i);
    if (m) {
      const count = parseInt(m[2], 10);
      // Skip "1 of" — handled by snipeOne above.
      if (count >= 2 && count <= 5) {
        effects.push({
          kind: "damageMultipleTargets",
          damage: parseInt(m[1], 10),
          count,
          benchOnly: !!m[3],
        });
      }
    }
  }

  // ---- Switch out opponent's Active -----------------------------------------
  if (/switch out your opponent'?s active pok[eé]mon to the bench/i.test(text)) {
    effects.push({ kind: "switchOutOpponent" });
  }

  // ---- Self switch to bench -------------------------------------------------
  if (/switch this pok[eé]mon with 1 of your benched (?:[A-Za-z]+ )?pok[eé]mon/i.test(text)) {
    effects.push({ kind: "selfSwitch" });
  }

  // ---- Discard Energy from opp Active ---------------------------------------
  if (/discard (a|an|\d+) special energy from your opponent'?s active pok[eé]mon/i.test(text)) {
    const m = text.match(/discard (a|an|\d+) special energy/i)!;
    const tok = m[1].toLowerCase();
    const n = tok === "a" || tok === "an" ? 1 : parseInt(tok, 10);
    effects.push({ kind: "discardOppSpecialEnergy", count: n });
  } else if (/flip a coin\. if heads, discard an energy from your opponent'?s active pok[eé]mon/i.test(text)) {
    effects.push({ kind: "flipHeadsDiscardOppEnergy" });
  } else if (/discard an energy from your opponent'?s active pok[eé]mon/i.test(text)) {
    effects.push({ kind: "discardOppEnergy", count: 1 });
  } else {
    const m = text.match(/discard (\d+) energy from your opponent'?s active pok[eé]mon/i);
    if (m) effects.push({ kind: "discardOppEnergy", count: parseInt(m[1], 10) });
  }

  // ---- Heal each of your Pokémon --------------------------------------------
  {
    const m = text.match(/heal (\d+) damage from each of your pok[eé]mon\b/i);
    if (m) effects.push({ kind: "healEachOwnPokemon", amount: parseInt(m[1], 10) });
  }
  // "Heal N damage from each of your Basic/Stage 1/Stage 2 Pokémon."
  {
    const m = text.match(/heal (\d+) damage from each of your (basic|stage 1|stage 2|evolution) pok[eé]mon/i);
    if (m) {
      const sub = m[2].toLowerCase();
      const subtype = sub === "basic" ? "Basic" : sub === "stage 1" ? "Stage 1" : sub === "stage 2" ? "Stage 2" : "Evolution";
      effects.push({ kind: "healEachOwnSubtype", amount: parseInt(m[1], 10), subtype: subtype as "Basic" | "Stage 1" | "Stage 2" | "Evolution" });
    }
  }
  // "Heal N damage from 1 of your Pokémon." (Targeted heal)
  {
    const m = text.match(/heal (\d+) damage from 1 of your pok[eé]mon/i);
    if (m) effects.push({ kind: "healOneOfYours", amount: parseInt(m[1], 10) });
  }
  // "Heal from this Pokémon the same amount of damage you did to your opponent's Active Pokémon."
  if (/heal from this pok[eé]mon the same amount of damage you did to your opponent'?s active pok[eé]mon/i.test(text)) {
    effects.push({ kind: "healEqualToDamageDealt" });
  }

  // ---- Mill opp deck --------------------------------------------------------
  if (/discard the top card of your opponent'?s deck/i.test(text)) {
    effects.push({ kind: "discardTopOfOppDeck", count: 1 });
  }
  {
    const m = text.match(/discard the top (\d+) cards? of your opponent'?s deck/i);
    if (m) effects.push({ kind: "discardTopOfOppDeck", count: parseInt(m[1], 10) });
  }

  // ---- Discard opp's Tools --------------------------------------------------
  if (/discard all pok[eé]mon tools from your opponent'?s active pok[eé]mon/i.test(text)) {
    effects.push({ kind: "discardOppTools" });
  }

  // ---- Call for Family: search for up to N Basics to Bench ------------------
  {
    const m = text.match(/search your deck for up to (\d+) basic pok[eé]mon and put them onto your bench/i);
    if (m) effects.push({ kind: "callForFamily", max: parseInt(m[1], 10) });
  }

  // ---- Flip-until-tails geometric damage -----------------------------------
  // "Flip a coin until you get tails. This attack does N (more) damage for each heads."
  // Multiplicative ("X×") zeros the base; additive ("X+") keeps it.
  {
    const m = text.match(/flip a coin until you get tails\. this attack does (\d+) (more )?damage for each heads/i);
    if (m) {
      effects.push({ kind: "flipUntilTailsPerHeads", perHeads: parseInt(m[1], 10) });
      const additive = !!m[2];
      if (!additive && damageText.endsWith("×")) baseDamageOverride = 0;
    }
  }

  // ---- Place N damage counters per card in your hand ----------------------
  // Alakazam "Powerful Hand": "Place 2 damage counters on your opponent's
  // Active Pokémon for each card in your hand." The damage number is 0 (or
  // missing); the effect places counters directly.
  {
    const m = text.match(/place (\d+) damage counters?\s+on your opponent'?s active pok[eé]mon\s+for each card in your hand/i);
    if (m) {
      effects.push({ kind: "placeCountersPerHandCard", countersPerCard: parseInt(m[1], 10) });
      baseDamageOverride = 0;
    }
  }

  // ---- Fizzle if no Stadium in play ---------------------------------------
  // Fan Rotom "Assault Landing": "If there is no Stadium in play, this
  // attack does nothing."
  if (/if there is no stadium in play, this attack does nothing/i.test(text)) {
    effects.push({ kind: "fizzleIfNoStadium" });
  }

  // ---- Coin-flip shield (prevent all damage & effects next turn) ----------
  // Dunsparce "Dig" / Iron Defense / Snom Hide. The "from and effects of"
  // wording is the strongest version; "all damage done" alone still prevents
  // damage but allows non-damage effects through. We don't distinguish at
  // runtime — both block damage during the opp's next turn.
  if (
    /flip a coin\. if heads, during your opponent'?s next turn, prevent all damage (?:from and effects of attacks |done to this pok[eé]mon by attacks)/i.test(
      text,
    )
  ) {
    effects.push({ kind: "shieldNextTurn", requiresHeads: true });
  } else if (
    /during your opponent'?s next turn, prevent all damage (?:from and effects of attacks |done to this pok[eé]mon by attacks)/i.test(
      text,
    )
  ) {
    effects.push({ kind: "shieldNextTurn", requiresHeads: false });
  }

  // ---- Search Energy → attach to a Benched Pokémon of type X --------------
  // Shaymin "Send Flowers": "Search your deck for an Energy card and attach
  // it to 1 of your Benched Grass Pokémon."
  {
    const m = text.match(/search your deck for an energy card and attach it to 1 of your benched ([A-Za-z]+) pok[eé]mon/i);
    if (m) {
      const t = matchEnergyType(m[1]);
      if (t) effects.push({ kind: "searchEnergyAttachBenchType", pokemonType: t });
    }
  }

  // ---- Attach N Basic <type> Energy from discard to bench -----------------
  // Mega Lucario ex "Aura Jab": "Attach up to 3 Basic Fighting Energy cards
  // from your discard pile to your Benched Pokémon in any way you like."
  {
    const m = text.match(/attach up to (\d+) basic ([A-Za-z]+) energy cards? from your discard pile to your benched pok[eé]mon/i);
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) effects.push({ kind: "attachNFromDiscardToBench", energyType: t, max: parseInt(m[1], 10) });
    }
  }
  // "Attach up to N Basic <type> Energy from discard to this Pokémon."
  {
    const m = text.match(/attach up to (\d+) basic ([A-Za-z]+) energy cards? from your discard pile to this pok[eé]mon/i);
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) effects.push({ kind: "attachNFromDiscardToSelf", energyType: t, max: parseInt(m[1], 10) });
    }
  }
  // "Attach (up to N) Basic Energy card(s) from discard to 1 of your Benched."
  {
    const m = text.match(/attach (?:up to (\d+)|a) basic ([A-Za-z]+ )?energy cards? from your discard pile to 1 of your benched pok[eé]mon/i);
    if (m) {
      const max = m[1] ? parseInt(m[1], 10) : 1;
      const energyType = m[2] ? matchEnergyType(m[2]) : undefined;
      effects.push({ kind: "attachBasicFromDiscardToOneBench", energyType, max });
    }
  }
  // "Attach a Basic <type> Energy card from discard to each of your Benched."
  {
    const m = text.match(/attach a basic ([A-Za-z]+) energy card from your discard pile to each of your benched pok[eé]mon/i);
    if (m) {
      const t = matchEnergyType(m[1]);
      if (t) effects.push({ kind: "attachBasicFromDiscardToEachBench", energyType: t });
    }
  }
  // ---- Recover Pokémon / Trainer from discard ----------------------------
  // "Put (up to) N (<filter>) Pokémon from your discard pile onto your Bench."
  {
    const m = text.match(/put (?:up to (\d+)|a|an) ([A-Za-z' -]+ )?pok[eé]mon from your discard pile onto your bench/i);
    if (m) {
      const max = m[1] ? parseInt(m[1], 10) : 1;
      const filterStr = (m[2] ?? "").trim();
      const filter = parsePokemonFilter(filterStr) ?? { kind: "any" };
      effects.push({ kind: "recoverPokemonFromDiscardToBench", max, filter });
    }
  }
  // "Put up to N <Name> from your discard pile onto your Bench." — variant
  // where the filter is a literal Pokémon name without the word "Pokémon".
  if (!effects.some((e) => e.kind === "recoverPokemonFromDiscardToBench")) {
    const m = text.match(/put up to (\d+) ([A-Za-z][A-Za-z' -]+?) from your discard pile onto your bench/i);
    if (m) {
      effects.push({
        kind: "recoverPokemonFromDiscardToBench",
        max: parseInt(m[1], 10),
        filter: { kind: "namePart", namePart: m[2].trim() },
      });
    }
  }
  // "Put up to N (<filter>) Pokémon from your discard pile into your hand."
  {
    const m = text.match(/put (?:up to (\d+)|a|an) ([A-Za-z' -]+ )?pok[eé]mon from your discard pile into your hand/i);
    if (m) {
      const max = m[1] ? parseInt(m[1], 10) : 1;
      const filterStr = (m[2] ?? "").trim();
      const filter = parsePokemonFilter(filterStr) ?? { kind: "any" };
      effects.push({ kind: "recoverPokemonFromDiscardToHand", max, filter });
    }
  }
  // "Put a Supporter / Item card from your discard pile into your hand."
  {
    const m = text.match(/put (?:up to (\d+)|a|an) (supporter|item|pok[eé]mon tool) cards? from your discard pile into your hand/i);
    if (m) {
      const max = m[1] ? parseInt(m[1], 10) : 1;
      const sub = m[2].toLowerCase();
      const subtype = sub === "supporter" ? "Supporter" : sub === "item" ? "Item" : "Pokémon Tool";
      effects.push({ kind: "recoverTrainerFromDiscard", max, subtype: subtype as "Supporter" | "Item" | "Pokémon Tool" });
    }
  }

  // ---- Self-lock next turn (consolidated) --------------------------------
  // Two shapes: scoped to a specific attack name ("can't use Mega Brave"),
  // or a broad lock ("can't attack" / "can't use attacks"). The named variant
  // wins when the captured name matches the current attack; otherwise we
  // fall through to the broad lock if the text says any-attack.
  {
    const named = text.match(/during your next turn, this pok[eé]mon can'?t use ([^.]+?)\./i);
    let pushed = false;
    if (named && atk.name) {
      const expected = atk.name.trim().toLowerCase();
      const locked = named[1].trim().toLowerCase();
      if (expected === locked) {
        effects.push({ kind: "selfCantUseAttackNextTurn", attackName: atk.name });
        pushed = true;
      }
    }
    if (!pushed && /during your next turn, this pok[eé]mon can'?t (?:use )?attacks?\b/i.test(text)) {
      effects.push({ kind: "selfCantAttackNextTurn" });
    }
  }

  // ---- For each opp Pokémon, flip a coin; N damage per heads --------------
  // Mega Zygarde ex "Nullifying Zero"
  if (/for each of your opponent'?s pok[eé]mon, flip a coin\. if heads, this attack does (\d+) damage to that pok[eé]mon/i.test(text)) {
    const m = text.match(/if heads, this attack does (\d+) damage to that pok[eé]mon/i);
    if (m) {
      effects.push({ kind: "multiCoinPerOppPokemon", damagePerHeads: parseInt(m[1], 10) });
      baseDamageOverride = 0;
    }
  }

  // ---- Fizzle unless a named ally is on your Bench ------------------------
  // Solrock "Cosmic Beam": "If you don't have Lunatone on your Bench, this
  // attack does nothing."
  {
    const m = text.match(/if you don'?t have ([A-Za-z][A-Za-z' -]*?) on your bench, this attack does nothing/i);
    if (m) {
      effects.push({ kind: "fizzleIfNoAlly", allyName: m[1].trim() });
    }
  }

  // ---- Ignore Weakness / Resistance / Opp Effects -------------------------
  // Combined "Weakness or Resistance, or by any effects" → all three flags.
  if (
    /this (?:attack'?s )?damage isn'?t affected by weakness or resistance,?\s*or by any effects on (?:your opponent'?s active pok[eé]mon|those pok[eé]mon)/i.test(
      text,
    )
  ) {
    effects.push({ kind: "ignoreWeaknessResistance" });
    effects.push({ kind: "ignoreOppEffects" });
  } else if (/this (?:attack'?s )?damage isn'?t affected by weakness or resistance/i.test(text)) {
    effects.push({ kind: "ignoreWeaknessResistance" });
  } else {
    if (/this (?:attack'?s )?damage isn'?t affected by weakness\b/i.test(text)) {
      effects.push({ kind: "ignoreWeaknessOnly" });
    }
    if (/this (?:attack'?s )?damage isn'?t affected by resistance\b/i.test(text)) {
      effects.push({ kind: "ignoreResistanceOnly" });
    }
  }
  if (
    /this attack'?s damage isn'?t affected by any effects on your opponent'?s active pok[eé]mon/i.test(
      text,
    )
  ) {
    if (!effects.some((ef) => ef.kind === "ignoreOppEffects")) {
      effects.push({ kind: "ignoreOppEffects" });
    }
  }

  // ---- Return self + all attached to hand ---------------------------------
  // Meowth ex "Tuck Tail": "Put this Pokémon and all attached cards into
  // your hand."
  if (/put this pok[eé]mon and all attached cards into your hand/i.test(text)) {
    effects.push({ kind: "returnSelfToHand" });
  }

  // ---- Attack-driven deck search (huge bucket) ----------------------------
  detectAttackDeckSearch(text, effects);

  // ---- Reveal-opp-hand riders --------------------------------------------
  detectRevealOppHand(text, effects);

  // ---- Random hand discard -----------------------------------------------
  detectRandomHandDiscard(text, effects);

  // ---- Damage counter placement (bypass W/R) ------------------------------
  // "Place N damage counters on your opponent's Active Pokémon." (skipping the
  // Alakazam Powerful Hand variant — handled by placeCountersPerHandCard.)
  if (!/place \d+ damage counters? on your opponent'?s active pok[eé]mon for each card in your hand/i.test(text)) {
    const m = text.match(/place (\d+) damage counters? on your opponent'?s active pok[eé]mon/i);
    if (m) effects.push({ kind: "placeCounters", counters: parseInt(m[1], 10), target: "oppActive" });
  }
  // "Place N damage counters on 1 of your opponent's Benched Pokémon."
  {
    const m = text.match(/place (\d+) damage counters? on 1 of your opponent'?s benched pok[eé]mon/i);
    if (m) effects.push({ kind: "placeCounters", counters: parseInt(m[1], 10), target: "oppBench" });
  }
  // "Place N damage counters on 1 of your opponent's Pokémon."
  if (!effects.some((e) => e.kind === "placeCounters")) {
    const m = text.match(/place (\d+) damage counters? on 1 of your opponent'?s pok[eé]mon/i);
    if (m) effects.push({ kind: "placeCounters", counters: parseInt(m[1], 10), target: "anyOpp" });
  }

  // ---- Damage scaling per filtered friendly/opponent in play --------------
  // "This attack does N damage for each of your Pokémon in play [that has the
  // Round attack / that has X in its name / Type Pokémon]."
  // Skipped if perFriendlyBench etc. already matched.
  detectPerPokemonFilter(text, effects);

  // ---- Discard Stadium ----------------------------------------------------
  if (/discard a stadium in play/i.test(text)) {
    effects.push({ kind: "discardStadium" });
  }
  // ---- Place counters on opp's bench in any way ---------------------------
  {
    const m = text.match(/put (\d+) damage counters? on your opponent'?s benched pok[eé]mon in any way you like/i);
    if (m) effects.push({ kind: "placeCountersOnOppBenchAny", counters: parseInt(m[1], 10) });
  }
  // ---- Defender's attacks weaker next turn (Charm-style) ------------------
  {
    const m = text.match(/during your opponent'?s next turn, attacks used by the defending pok[eé]mon do (\d+) less damage/i);
    if (m) effects.push({ kind: "defenderAttacksWeakerNextTurn", amount: parseInt(m[1], 10) });
  }
  // ---- Counter-attacker on next-turn damage --------------------------------
  {
    const m = text.match(/during your opponent'?s next turn, if this pok[eé]mon is damaged by an attack[^.]*?put (\d+) damage counters? on the attacking pok[eé]mon/i);
    if (m) effects.push({ kind: "counterAttackerNextTurn", counters: parseInt(m[1], 10) });
  }
  // ---- Opp discards N hand cards (random) ---------------------------------
  {
    const m = text.match(/your opponent discards (\d+) cards? from their hand/i);
    if (m) effects.push({ kind: "oppDiscardsHand", count: parseInt(m[1], 10) });
  }
  // ---- Damage per card in opp's hand ---------------------------------------
  {
    const m = text.match(/this attack does (\d+) damage for each card in your opponent'?s hand/i);
    if (m) effects.push({ kind: "perCardInOppHand", perCount: parseInt(m[1], 10) });
  }
  // ---- Attach any number of Basic Energy from hand to your Pokémon --------
  if (/(?:you may )?attach any number of basic energy cards from your hand to your pok[eé]mon in any way you like/i.test(text)) {
    effects.push({ kind: "attachAnyBasicFromHandAll" });
  }
  // ---- Return self + discard attached -------------------------------------
  if (/(?:you may )?put this pok[eé]mon into your hand\..*?discard all cards attached/i.test(text)) {
    effects.push({ kind: "returnSelfToHandDiscardAttached" });
  }
  // ---- Bounce own energy to hand ------------------------------------------
  {
    const m = text.match(/put an energy attached to this pok[eé]mon into your hand/i);
    if (m) effects.push({ kind: "ownEnergyToHand", count: 1 });
  }

  // ---- Gust opp's bench to Active (no targeting; same as Pokémon Catcher) -
  if (/switch in 1 of your opponent'?s benched pok[eé]mon to the active spot/i.test(text)) {
    effects.push({ kind: "gustOppBenchedAttack" });
  }

  // ---- Discard-any-amount-energy across own Pokémon for damage ------------
  {
    const m = text.match(/discard any amount of (?:basic )?([A-Za-z]+ )?energy(?: cards?)? from(?: among)? your pok[eé]mon[\.,]?\s*(?:and )?this attack does (\d+) damage for each card you discarded/i);
    if (m) {
      const t = m[1] ? matchEnergyType(m[1]) : undefined;
      effects.push({ kind: "discardAnyEnergyAcrossOwnForDamage", damagePer: parseInt(m[2], 10), energyType: t });
    }
  }
  // ---- Discard energy from hand for damage --------------------------------
  {
    const m = text.match(/(?:you may )?discard up to (\d+) energy cards? from your hand[\.,]?\s*(?:and )?this attack does (\d+) more damage for each card you discarded/i);
    if (m) effects.push({ kind: "discardHandEnergyForDamage", max: parseInt(m[1], 10), damagePer: parseInt(m[2], 10) });
  }
  // ---- Per Pokémon Tool attached across own ------------------------------
  {
    const m = text.match(/(\d+) damage for each pok[eé]mon tool attached to all of your pok[eé]mon/i);
    if (m) effects.push({ kind: "perOwnToolAttached", perCount: parseInt(m[1], 10) });
  }
  // ---- Opp chooses N cards from hand → deck -------------------------------
  {
    const m = text.match(/your opponent chooses (\d+) cards? from their hand and shuffles those cards? into their deck/i);
    if (m) effects.push({ kind: "oppChoosesHandToDeck", count: parseInt(m[1], 10) });
  }
  // ---- Discard up to N (typed?) Energy from this Pokémon for damage ------
  // Cards may say "Energy cards" or just "Energy" — allow both.
  {
    const m = text.match(/discard up to (\d+) ([A-Za-z]+ )?energy(?: cards?)? from this pok[eé]mon[\.,]?\s*(?:and )?this attack does (\d+) (more )?damage for each card you discarded/i);
    if (m) {
      const t = m[2] ? matchEnergyType(m[2]) : undefined;
      effects.push({ kind: "discardOwnEnergyUpToForDamage", max: parseInt(m[1], 10), damagePer: parseInt(m[3], 10), energyType: t });
    }
  }
  // "Discard all <type> Energy from this Pokémon. This attack does N damage for each card you discarded."
  {
    const m = text.match(/discard all ([A-Za-z]+) energy from this pok[eé]mon\. this attack does (\d+) damage for each card you discarded/i);
    if (m) {
      const t = matchEnergyType(m[1]);
      if (t) effects.push({ kind: "discardOwnEnergyUpToForDamage", max: 99, damagePer: parseInt(m[2], 10), energyType: t });
    }
  }

  // ---- Move energy between own Pokémon ------------------------------------
  // Mega Gengar ex Void Gale, Castform Sunny Form, Kilowattrel Storm Bolt.
  if (/move all energy from this pok[eé]mon to (?:1 of )?your benched pok[eé]mon/i.test(text)) {
    effects.push({ kind: "moveOwnEnergyToBench", count: "all" });
  } else {
    const m = text.match(/move (\d+|an) energy from this pok[eé]mon to 1 of your benched pok[eé]mon/i);
    if (m) {
      const n = m[1].toLowerCase() === "an" ? 1 : parseInt(m[1], 10);
      effects.push({ kind: "moveOwnEnergyToBench", count: n });
    }
  }
  // ---- Own-bench damage (self-recoil to own Bench): "this attack also does
  // N damage to each of your Benched Pokémon" --
  if (!effects.some((e) => e.kind === "benchSnipe")) {
    const m = text.match(/this attack (?:also )?does (\d+) damage to each of your benched pok[eé]mon\b/i);
    if (m) {
      effects.push({ kind: "benchSnipe", damage: parseInt(m[1], 10), target: "ownBench" });
    }
  }
  // Move opp Active's Energy to opp's bench.
  if (/(?:you may )?move an energy from your opponent'?s active pok[eé]mon to 1 of their benched pok[eé]mon/i.test(text)) {
    effects.push({ kind: "moveOppEnergyToBench", count: 1 });
  }

  // ---- Conditional damage modifiers ---------------------------------------
  // Generic shape: "If <predicate>, this attack does N more damage." or
  // "If <predicate>, this attack does nothing." or "If <predicate>, it is
  // Knocked Out." Each calls `parseAttackPredicate` on the captured clause.
  detectConditionalDamage(text, effects);

  return { effects, baseDamageOverride };
}

// Parse the "<conditional clause>" of a conditional-damage attack and return
// a structured AttackPredicate, or undefined if the wording isn't recognized.
// Handled defender-state, attacker-state, and a small set of game-state
// predicates. Defender wording is normalized: "your opponent's Active
// Pokémon is X", "the Defending Pokémon is X", "it is X" — all map to the
// same predicate set.
function parseAttackPredicate(clauseRaw: string): AttackPredicate | undefined {
  const c = clauseRaw.trim().toLowerCase();
  // Defender-side
  if (/your opponent'?s active pok[eé]mon is(?:n'?t| not)? a (?:pok[eé]mon )?ex(?:\s|,|\.|$)/i.test(c)) {
    return { kind: "defenderIsEx" };
  }
  if (/your opponent'?s active pok[eé]mon is(?:n'?t| not)? a pok[eé]mon ex or (?:pok[eé]mon )?v\b/i.test(c)) {
    return { kind: "defenderIsExOrV" };
  }
  if (/your opponent'?s active pok[eé]mon is(?:n'?t| not)? a stage 2 pok[eé]mon/i.test(c)) {
    return { kind: "defenderHasSubtype", subtype: "Stage 2" };
  }
  if (/your opponent'?s active pok[eé]mon is(?:n'?t| not)? a stage 1 pok[eé]mon/i.test(c)) {
    return { kind: "defenderHasSubtype", subtype: "Stage 1" };
  }
  if (/your opponent'?s active pok[eé]mon is(?:n'?t| not)? an? evolution pok[eé]mon/i.test(c)) {
    return { kind: "defenderHasSubtype", subtype: "Evolution" };
  }
  if (/your opponent'?s active pok[eé]mon is(?:n'?t| not)? a basic pok[eé]mon/i.test(c)) {
    return { kind: "defenderHasSubtype", subtype: "Basic" };
  }
  {
    const m = c.match(/your opponent'?s active pok[eé]mon is (asleep|burned|confused|paralyzed|poisoned)/i);
    if (m) {
      return { kind: "defenderHasStatus", status: m[1].toLowerCase() as StatusCondition };
    }
  }
  if (/your opponent'?s active pok[eé]mon is affected by a special condition/i.test(c)) {
    return { kind: "defenderHasAnyStatus" };
  }
  {
    const m = c.match(/your opponent'?s active pok[eé]mon is a ([A-Za-z]+) pok[eé]mon\b/i);
    if (m) {
      const t = matchEnergyType(m[1]);
      if (t) return { kind: "defenderHasType", type: t };
    }
  }
  if (/your opponent'?s active pok[eé]mon has a pok[eé]mon tool/i.test(c)) {
    return { kind: "defenderHasTool" };
  }
  if (/your opponent'?s active pok[eé]mon has any (?:special )?energy attached/i.test(c)) {
    return { kind: "defenderHasSpecialEnergy" };
  }
  if (/your opponent'?s active pok[eé]mon (?:already )?has any damage counters/i.test(c)) {
    return { kind: "defenderHasDamage" };
  }
  // Attacker-side
  {
    const m = c.match(/this pok[eé]mon has at least (\d+) extra energy attached/i);
    if (m) return { kind: "selfHasExtraEnergy", extra: parseInt(m[1], 10) };
  }
  if (/this pok[eé]mon has any damage counters/i.test(c)) {
    return { kind: "selfHasDamage" };
  }
  if (/this pok[eé]mon has no damage counters/i.test(c)) {
    return { kind: "selfHasNoDamage" };
  }
  if (/this pok[eé]mon has a pok[eé]mon tool attached/i.test(c)) {
    return { kind: "selfHasTool" };
  }
  if (/this pok[eé]mon evolved (?:from|this turn)/i.test(c)) {
    return { kind: "selfEvolvedThisTurn" };
  }
  if (/this pok[eé]mon moved from your bench to the active spot this turn/i.test(c)) {
    return { kind: "selfMovedToActiveThisTurn" };
  }
  // Self-status predicate: "this Pokémon is Asleep/Burned/etc."
  {
    const m = c.match(/this pok[eé]mon is (asleep|burned|confused|paralyzed|poisoned)/i);
    if (m) return { kind: "selfHasStatus", status: m[1].toLowerCase() as StatusCondition };
  }
  if (/a stadium (?:card )?is in play/i.test(c)) {
    return { kind: "stadiumInPlayNamed", stadiumNamePart: "" };
  }
  // Prize predicates
  {
    const m = c.match(/your opponent has (\d+) or fewer prize cards? remaining/i);
    if (m) return { kind: "oppPrizesAtMost", count: parseInt(m[1], 10) };
  }
  {
    const m = c.match(/you have exactly (\d+) prize cards? remaining/i);
    if (m) return { kind: "yourPrizesEquals", count: parseInt(m[1], 10) };
  }
  {
    const m = c.match(/you have (\d+) or fewer prize cards? remaining/i);
    if (m) return { kind: "yourPrizesAtMost", count: parseInt(m[1], 10) };
  }
  // Hand size predicate
  {
    const m = c.match(/you have exactly (\d+) cards? in your hand/i);
    if (m) return { kind: "yourHandSizeEquals", count: parseInt(m[1], 10) };
  }
  // KO last turn predicate
  if (/(?:any of )?your pok[eé]mon (?:were|was) knocked out by damage from an attack during your opponent'?s last turn/i.test(c)) {
    return { kind: "yourPokemonKoedLastOppTurn" };
  }
  // Bench-type predicate
  {
    const m = c.match(/you have any ([A-Za-z]+) pok[eé]mon on your bench/i);
    if (m) {
      const t = matchEnergyType(m[1]);
      if (t) return { kind: "youHaveBenchPokemonOfType", energyType: t };
    }
  }
  // All-bench-damaged predicate (Drampa Raging Cannon)
  if (/all of your benched pok[eé]mon have at least 1 damage counter/i.test(c)) {
    return { kind: "allBenchHasDamage" };
  }
  // Same-hand-size-as-opp predicate (Iron Boulder Adjusted Horn)
  if (/(?:you have|the same number of cards in your hand) (?:as|same number).*?your opponent/i.test(c) ||
      /you have the same number of cards in your hand as your opponent/i.test(c)) {
    return { kind: "yourHandSizeEqualsOpp" };
  }
  // Bench-count predicate ("4 or fewer Benched Pokémon")
  {
    const m = c.match(/you have (\d+) or fewer benched pok[eé]mon/i);
    if (m) return { kind: "yourBenchCountAtMost", count: parseInt(m[1], 10) };
  }
  // "If you have N or more Basic <Type> Energy cards in your discard pile"
  {
    const m = c.match(/you have (\d+) or more basic ([A-Za-z]+) energy cards? in your discard pile/i);
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) return { kind: "yourDiscardHasNTypedEnergy", count: parseInt(m[1], 10), energyType: t };
    }
  }
  // "If <Name> is on your Bench" — bench-name predicate
  {
    const m = c.match(/(?:if )?([A-Za-z][A-Za-z' -]*?) is on your bench/i);
    if (m) return { kind: "youHavePokemonNamedOnBench", namePart: m[1].trim() };
  }
  if (/this pok[eé]mon has no energy attached/i.test(c)) {
    return { kind: "selfHasNoEnergy" };
  }
  if (/this pok[eé]mon has any special energy attached/i.test(c)) {
    return { kind: "selfHasSpecialEnergy" };
  }
  // Typed energy: "this Pokémon has any <Type> Energy attached"
  {
    const m = c.match(/this pok[eé]mon has any ([a-z]+) energy attached/i);
    if (m) {
      const t = matchEnergyType(m[1]);
      if (t) return { kind: "selfHasEnergyOfType", energyType: t };
    }
  }
  // Named special energy attached: "Team Rocket's Energy attached" etc.
  {
    const m = c.match(/this pok[eé]mon has any ([A-Za-z][A-Za-z' -]*?) energy attached/i);
    if (m) {
      const name = m[1].trim();
      // Capitalize correctly — but easier to match by lowercased lookup later.
      return { kind: "selfHasNamedEnergy", energyName: `${name.replace(/\b\w/g, (c) => c.toUpperCase())} Energy` };
    }
  }
  // Game-state — Stadium / Supporter named
  {
    const m = c.match(/(?:if|when) ([A-Za-z'’-][A-Za-z'’ -]*?) is in play/i);
    if (m) {
      return { kind: "stadiumInPlayNamed", stadiumNamePart: m[1].trim() };
    }
  }
  return undefined;
}

// Numeric prefix tokens like "a / an / 2 / up to 3" — return the maximum.
function parseQuantity(token: string): number {
  const t = token.toLowerCase();
  if (t.startsWith("up to ")) return parseQuantity(t.slice(6));
  if (t === "a" || t === "an" || t === "one") return 1;
  if (t === "two") return 2;
  if (t === "three") return 3;
  if (t === "four") return 4;
  if (t === "five") return 5;
  const n = parseInt(t, 10);
  return isNaN(n) ? 1 : n;
}

// Map a search clause ("a Pokémon", "up to 2 Basic Pokémon", "an Item card",
// "up to 3 Basic Fire Energy cards") to a filter + max count.
function parseSearchClause(clauseRaw: string): { filter: AttackSearchFilter; max: number } | undefined {
  const clause = clauseRaw.trim().toLowerCase().replace(/\s+/g, " ");
  // Energy-typed: "Basic Fire Energy"
  {
    const m = clause.match(/^((?:up to )?(?:a|an|one|two|three|four|five|\d+)) basic ([a-z]+) energy/);
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) return { filter: { kind: "basicEnergyType", energyType: t }, max: parseQuantity(m[1]) };
    }
  }
  // Plain basic energy
  {
    const m = clause.match(/^((?:up to )?(?:a|an|one|two|three|four|five|\d+)) basic energy/);
    if (m) return { filter: { kind: "basicEnergy" }, max: parseQuantity(m[1]) };
  }
  // Pokémon-type: "Darkness Pokémon"
  {
    const m = clause.match(/^((?:up to )?(?:a|an|one|two|three|four|five|\d+)) ([a-z]+) pok[eé]mon/);
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) return { filter: { kind: "pokemonOfType", energyType: t }, max: parseQuantity(m[1]) };
    }
  }
  // Stage-2 / Stage-1 / Basic Pokémon
  {
    const m = clause.match(/^((?:up to )?(?:a|an|one|two|three|four|five|\d+)) basic pok[eé]mon/);
    if (m) return { filter: { kind: "basicPokemon" }, max: parseQuantity(m[1]) };
  }
  {
    const m = clause.match(/^((?:up to )?(?:a|an|one|two|three|four|five|\d+)) stage 2 pok[eé]mon/);
    if (m) return { filter: { kind: "stage2Pokemon" }, max: parseQuantity(m[1]) };
  }
  {
    const m = clause.match(/^((?:up to )?(?:a|an|one|two|three|four|five|\d+)) stage 1 pok[eé]mon/);
    if (m) return { filter: { kind: "stage1Pokemon" }, max: parseQuantity(m[1]) };
  }
  {
    const m = clause.match(/^((?:up to )?(?:a|an|one|two|three|four|five|\d+)) evolution pok[eé]mon/);
    if (m) return { filter: { kind: "evolutionPokemon" }, max: parseQuantity(m[1]) };
  }
  // Plain "Pokémon"
  {
    const m = clause.match(/^((?:up to )?(?:a|an|one|two|three|four|five|\d+)) pok[eé]mon/);
    if (m) return { filter: { kind: "pokemon" }, max: parseQuantity(m[1]) };
  }
  // Trainer subtypes
  {
    const m = clause.match(/^((?:up to )?(?:a|an|one|two|three|four|five|\d+)) supporter/);
    if (m) return { filter: { kind: "supporter" }, max: parseQuantity(m[1]) };
  }
  {
    const m = clause.match(/^((?:up to )?(?:a|an|one|two|three|four|five|\d+)) (?:item|item card)/);
    if (m) return { filter: { kind: "item" }, max: parseQuantity(m[1]) };
  }
  {
    const m = clause.match(/^((?:up to )?(?:a|an|one|two|three|four|five|\d+)) pok[eé]mon tool/);
    if (m) return { filter: { kind: "tool" }, max: parseQuantity(m[1]) };
  }
  {
    const m = clause.match(/^((?:up to )?(?:a|an|one|two|three|four|five|\d+)) trainer/);
    if (m) return { filter: { kind: "trainer" }, max: parseQuantity(m[1]) };
  }
  // Any "card"
  {
    const m = clause.match(/^((?:up to )?(?:a|an|one|two|three|four|five|\d+)) cards?/);
    if (m) return { filter: { kind: "any" }, max: parseQuantity(m[1]) };
  }
  return undefined;
}

function detectAttackDeckSearch(text: string, effects: AttackEffect[]): void {
  // "Search your deck for X, reveal it/them, and put it/them into your hand."
  // Optional `you may` prefix.
  {
    const re = /(?:you may )?search your deck for ([^.]+?)(?:, reveal (?:it|them),)? and put (?:it|them) into your hand/gi;
    for (const m of text.matchAll(re)) {
      const opt = /^you may /i.test(m[0]);
      const parsed = parseSearchClause(m[1]);
      if (parsed) {
        effects.push({
          kind: "searchDeckAttack",
          filter: parsed.filter,
          destination: "hand",
          max: parsed.max,
          optional: opt || undefined,
        });
      }
    }
  }
  // "Search your deck for X and put it onto your Bench."
  {
    const re = /search your deck for ([^.]+?) and put (?:it|them) onto your bench/gi;
    for (const m of text.matchAll(re)) {
      const parsed = parseSearchClause(m[1]);
      if (parsed) {
        effects.push({
          kind: "searchDeckAttack",
          filter: parsed.filter,
          destination: "bench",
          max: parsed.max,
        });
      }
    }
  }
  // "Search your deck for N Basic <type> Energy cards and attach them to this Pokémon."
  {
    const re = /search your deck for ([^.]+?) and attach (?:it|them) to this pok[eé]mon/gi;
    for (const m of text.matchAll(re)) {
      const parsed = parseSearchClause(m[1]);
      if (parsed) {
        effects.push({
          kind: "searchDeckAttack",
          filter: parsed.filter,
          destination: "attachSelf",
          max: parsed.max,
        });
      }
    }
  }
  // "Search your deck for N Basic Energy cards and attach them to your Pokémon in any way you like."
  {
    const re = /search your deck for ([^.]+?) and attach (?:it|them) to your pok[eé]mon in any way you like/gi;
    for (const m of text.matchAll(re)) {
      const parsed = parseSearchClause(m[1]);
      if (parsed) {
        effects.push({
          kind: "searchDeckAttack",
          filter: parsed.filter,
          destination: "attachAll",
          max: parsed.max,
        });
      }
    }
  }
  // "Search your deck for a card that evolves from this Pokémon and put it
  // onto this Pokémon to evolve it." — Misdreavus Ascension.
  if (/search your deck for a card that evolves from this pok[eé]mon and put it onto this pok[eé]mon to evolve it/i.test(text)) {
    effects.push({ kind: "searchEvolveSelf" });
  }
  // "For each of your Benched Pokémon, search your deck for a Basic <Type>
  // Energy card and attach it to that Pokémon."
  {
    const m = text.match(
      /for each of your benched pok[eé]mon, search your deck for a basic ([a-z]+) energy card and attach it to that pok[eé]mon/i,
    );
    if (m) {
      const t = matchEnergyType(m[1]);
      if (t) effects.push({ kind: "searchEnergyForEachBench", energyType: t });
    }
  }
}

function parsePokemonFilter(clauseRaw: string): PokemonFilter | undefined {
  const c = clauseRaw.trim().toLowerCase();
  if (!c) return { kind: "any" };
  // "that has the <Name> attack"
  {
    const m = c.match(/that has the ([A-Za-z' -]+?) attack/i);
    if (m) return { kind: "hasAttackNamed", attackName: m[1].trim() };
  }
  // "<type> Pokémon"
  {
    const m = c.match(/^([a-z]+)\s+pok[eé]mon$/i);
    if (m) {
      const t = matchEnergyType(m[1]);
      if (t) return { kind: "type", energyType: t };
    }
  }
  // "<NameWithApostrophe>'s Pokémon" — Team Rocket's, Cynthia's, etc.
  {
    const m = c.match(/^([a-z'’ ]+?)'s\s+pok[eé]mon$/i);
    if (m) return { kind: "namePart", namePart: `${m[1]}'s` };
  }
  return undefined;
}

function detectPerPokemonFilter(text: string, effects: AttackEffect[]): void {
  // Multiplicative: damage="N×", "for each of your <X> Pokémon in play"
  // Additive: damage="N+", "N more damage for each of your <X> Pokémon in play"
  const reMult = /(\d+) damage for each of your (?:([^.]+?)\s+)?pok[eé]mon in play(?:\s+([^.]*?))?(?:\.|$)/i;
  const reAdd = /(\d+) more damage for each of your (?:([^.]+?)\s+)?pok[eé]mon in play/i;
  const reOppMult = /(\d+) damage for each of your opponent'?s (?:([^.]+?)\s+)?pok[eé]mon in play/i;

  for (const [re, side] of [[reMult, "friendly"], [reAdd, "friendly"], [reOppMult, "opponent"]] as const) {
    const m = text.match(re);
    if (!m) continue;
    if (
      effects.some((e) =>
        e.kind === "perFriendlyBench" ||
        e.kind === "perOpponentBench" ||
        e.kind === "perPokemonFilter",
      )
    ) {
      continue;
    }
    const filterPart = (m[2] ?? "").trim();
    let filter = parsePokemonFilter(filterPart);
    // Special "that has the <X> attack" suffix in m[3]
    if (!filter && m[3]) filter = parsePokemonFilter(m[3]);
    if (!filter) filter = { kind: "any" };
    effects.push({
      kind: "perPokemonFilter",
      side,
      perCount: parseInt(m[1], 10),
      filter,
      includeActive: true,
    });
    break;
  }
}

function detectRandomHandDiscard(text: string, effects: AttackEffect[]): void {
  // "Flip N coins. For each heads, discard a random card from opp's hand."
  {
    const m = text.match(/flip (\d+) coins?\. for each heads, discard a random card from your opponent'?s hand/i);
    if (m) {
      effects.push({ kind: "multiCoinFlipRandomOppHandDiscard", coins: parseInt(m[1], 10) });
      return;
    }
  }
  if (/discard a random card from your opponent'?s hand/i.test(text)) {
    effects.push({ kind: "randomOppHandDiscard", count: 1 });
  }
}

function detectRevealOppHand(text: string, effects: AttackEffect[]): void {
  // "Choose a random card from your opponent's hand. <they reveal and> shuffle into deck."
  if (
    /choose a random card from your opponent'?s hand[\s\S]*?(?:reveals?|reveal that card)[\s\S]*?shuffles? (?:it|that card|them) into their deck/i.test(
      text,
    )
  ) {
    effects.push({ kind: "randomOppHandToDeck", count: 1 });
  }
  // "Flip a coin until you get tails. For each heads, choose a random card from opp's hand and shuffle..."
  // — handled by upgrading the count via flip-multiplier kind. Skipped for simplicity.

  // "Your opponent reveals their hand, and you discard a card you find there."
  if (/your opponent reveals their hand,? (?:and )?(?:you )?discard a card you find there/i.test(text)) {
    effects.push({ kind: "revealOppHandDiscard", filter: "any", max: 1, min: 1 });
  } else if (/your opponent reveals their hand\.\s*discard a card you find there/i.test(text)) {
    effects.push({ kind: "revealOppHandDiscard", filter: "any", max: 1, min: 1 });
  } else if (/your opponent reveals their hand\.\s*discard all (?:item|item cards?(?: and pok[eé]mon tool cards?)?) you find there/i.test(text)) {
    effects.push({ kind: "revealOppHandDiscard", filter: "itemOrTool", max: 99, min: 0 });
  }
  // "Your opponent reveals their hand. This attack does N damage for each
  // <class> card you find there."
  {
    const re = /your opponent reveals their hand[\.,]\s*(?:and )?this attack does (\d+) damage for each (Trainer|Energy|Pok[eé]mon|Item|Supporter) cards? you find there/i;
    const m = text.match(re);
    if (m) {
      const filter = m[2].toLowerCase().replace("é", "e") as "trainer" | "energy" | "pokemon" | "item" | "supporter";
      effects.push({ kind: "damagePerCardClassInOppHand", damagePer: parseInt(m[1], 10), filter });
    }
  }
}

function detectConditionalDamage(text: string, effects: AttackEffect[]): void {
  // "If <X>, this attack does N more damage."
  const reBonus =
    /if ([^.]+?), this attack does (\d+) more damage/gi;
  for (const m of text.matchAll(reBonus)) {
    const pred = parseAttackPredicate(m[1]);
    if (pred) {
      effects.push({ kind: "conditionalDamage", bonus: parseInt(m[2], 10), mode: "bonus", predicate: pred });
    }
  }
  // "If <X>, this attack does nothing."
  const reFizzle = /if ([^.]+?), this attack does nothing/gi;
  for (const m of text.matchAll(reFizzle)) {
    // Skip if it's the simple "If tails" coin-flip form (already handled).
    if (/^tails\b/i.test(m[1].trim())) continue;
    const pred = parseAttackPredicate(m[1]);
    if (pred) {
      effects.push({ kind: "conditionalDamage", bonus: 0, mode: "fizzleIfNot", predicate: pred });
    }
  }
  // "If <X>, it is Knocked Out." (Haxorus Axe Blast etc.)
  const reKo = /if ([^.]+?),(?: it is| this pok[eé]mon is| your opponent'?s active pok[eé]mon is) knocked out/gi;
  for (const m of text.matchAll(reKo)) {
    const pred = parseAttackPredicate(m[1]);
    if (pred) {
      effects.push({ kind: "conditionalKoDefender", predicate: pred });
    }
  }
  // "If <X>, it is now <Status>." (Black Kyurem Ice Age etc.)
  const reStatus = /if ([^.]+?),(?: it is now| this pok[eé]mon is now| your opponent'?s active pok[eé]mon is now) (asleep|burned|confused|paralyzed|poisoned)/gi;
  for (const m of text.matchAll(reStatus)) {
    const pred = parseAttackPredicate(m[1]);
    if (pred) {
      effects.push({
        kind: "conditionalStatus",
        status: m[2].toLowerCase() as StatusCondition,
        target: "defender",
        predicate: pred,
      });
    }
  }
}

// Stats helper for smoke tests: classify how many attacks we can auto-wire.
export function effectCoverageStats(apiAttacks: ApiAttack[]): {
  total: number;
  withText: number;
  withEffects: number;
} {
  const total = apiAttacks.length;
  const withText = apiAttacks.filter((a) => a.text && a.text.length > 0).length;
  const withEffects = apiAttacks.filter((a) => extractEffects(a).effects.length > 0).length;
  return { total, withText, withEffects };
}
