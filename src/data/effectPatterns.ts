// Parse Pokémon TCG attack text into structured AttackEffect entries.
//
// Coverage is deliberately narrow: we only match common, unambiguous patterns
// so the engine applies effects that match the card's printed text. Anything
// that doesn't match stays as free-form `text` on the attack — the UI shows
// it, the engine just doesn't evaluate it.

import type {
  Attack,
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

// Lazy resolver: most attacks never fire in any given game, so we defer the
// regex pattern detection from dataset-load time to first inspection. The
// caller passes an Attack; we cache the result on the Attack object itself.
//
// Synthetic attacks (e.g. tool-granted Geobuster) ship with `effects`
// pre-populated; we still mark them resolved so we don't re-detect.
//
// `baseDamageOverride` (when extractEffects returns one for "30×"-style
// per-attached-energy attacks) is applied here by mutating attack.damage.
// The mapping is deterministic: the same attack always overrides to the same
// value, so re-resolving on a different copy produces the same result.
export function getAttackEffects(attack: Attack): AttackEffect[] {
  if (attack.effectsResolved) return attack.effects ?? [];
  if (attack.effects && attack.effects.length > 0) {
    attack.effectsResolved = true;
    return attack.effects;
  }
  const { effects, baseDamageOverride } = extractEffects({
    name: attack.name,
    damage: attack.damageText,
    text: attack.text,
  });
  if (baseDamageOverride !== undefined) attack.damage = baseDamageOverride;
  attack.effects = effects.length > 0 ? effects : undefined;
  attack.effectsResolved = true;
  return attack.effects ?? [];
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
      } else if (/for each of your opponent'?s pok[eé]mon ex in play/i.test(text)) {
        // Dudunsparce ex Tenacious Tail — 60× per opp ex Pokémon in play.
        // Without this branch, the "60×" base leaks through and combines
        // with the per-ex-count from the secondary `perOppPokemonEx`
        // matcher, doubling the damage.
        effects.push({ kind: "perOppPokemonEx", perCount: base });
        baseDamageOverride = 0;
      } else if (perEnergyMatch) {
        const qualifier = (perEnergyMatch[1] ?? "").trim();
        const energyType = matchEnergyType(qualifier);
        effects.push({ kind: "perAttachedEnergy", perEnergy: base, energyType });
        baseDamageOverride = 0;
      } else if (multEachHeads) {
        // Coin-flip multiplier damage with "N×" base — alt phrasing that uses
        // "times the number of heads" instead of "for each heads". Push the
        // effect explicitly; the standard "for each heads" path below catches
        // the more common phrasing. Zero the base since "N×" implies no-damage
        // without the multiplier.
        const m = multEachHeads;
        const coins = m[1] === "a" ? 1 : parseInt(m[1], 10);
        effects.push({ kind: "flipMultiCoinsPerHeads", coins, perHeads: base });
        baseDamageOverride = 0;
      } else if (/discard the top \d+ cards? of your deck.*?for each basic [A-Za-z]+ energy/i.test(text)) {
        // Avalugg "Glacier Crush" — "Discard the top 6 cards of your deck.
        // This attack does 60 damage for each basic Water Energy you
        // discarded this way." The mill-and-scale rider is detected later;
        // zero the base so it doesn't double-count.
        baseDamageOverride = 0;
      } else if (/for each .+? attached to all (?:of your )?pok[eé]mon/i.test(text)) {
        // Delphox "Energized Storm" / Xerneas "Geostorm" — "30× damage for
        // each Energy attached to all (of your) Pokémon". The detection +
        // handler comes later; zero the base so the multiplier doesn't leak
        // through as a flat 30.
        baseDamageOverride = 0;
      } else if (/for each of your pok[eé]mon that has .+ in its name/i.test(text)) {
        // Beedrill ex "Rumbling Bees" — "110× damage for each of your
        // Beedrill and Beedrill ex in play." Zero base; the rider is
        // detected as perInPlayPokemonNamed below.
        baseDamageOverride = 0;
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
  // Matches both phrasings:
  //  - "...for each basic <T> energy card that you discarded"
  //  - "...for each basic <T> energy you discarded this way" (Avalugg Glacier Crush)
  {
    const m = text.match(/discard the top (\d+) cards? of your deck[\.,]?\s*(?:and )?this attack does (\d+) damage for each basic ([A-Za-z]+) energy(?: cards?)?(?: that)? you discarded(?: this way)?/i);
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
  if (text.match(
    /discard a team rocket'?s energy from this pok[eé]mon\.\s*if you do, discard your opponent'?s active pok[eé]mon and all attached cards/i,
  )) {
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
  // Also matches Flaaffy "Disconnect" — "Your opponent can't play any Item
  // cards from their hand during their next turn."
  if (/(?:they|your opponent) can'?t play any item cards from their hand/i.test(text)) {
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
  // ---- "Flip N coins. If all of them are heads, this attack does M more damage." ----
  // Common variants: "Flip 2 coins. If both of them are heads, ..." / "Flip 3
  // coins. If all of them are heads, ...".
  {
    const m = text.match(
      /flip (\d+) coins?\. if (?:all|both) of them are heads, this attack does (\d+) more damage/i,
    );
    if (m) {
      effects.push({
        kind: "flipAllHeadsBonus",
        coins: parseInt(m[1], 10),
        bonus: parseInt(m[2], 10),
      });
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
  if (text.match(
    /during your opponent'?s next turn, (?:the defending pok[eé]mon|that pok[eé]mon) can'?t retreat/i,
  )) {
    effects.push({ kind: "defenderCantRetreatNextTurn" });
  }
  // ---- Defender can't attack next turn --------------------------------------
  if (text.match(
    /during your opponent'?s next turn, (?:the defending pok[eé]mon|that pok[eé]mon) can'?t (?:use )?attacks?\b/i,
  )) {
    effects.push({ kind: "defenderCantAttackNextTurn" });
  }

  // ---- Self-damage reduction next turn --------------------------------------
  {
    const m = text.match(/during your opponent'?s next turn, this pok[eé]mon takes (\d+) less damage/i);
    if (m) effects.push({ kind: "selfDamageReductionNextTurn", amount: parseInt(m[1], 10) });
  }

  // ---- "Put up to N <self-name> from your discard pile onto your Bench." ---
  // Duskull "Come and Get You". The self-name is whatever Pokémon hosts this
  // attack — we don't know it at pattern-extract time, so the handler reads
  // ctx.attacker.card.name and matches against discard. We only detect the
  // pattern + N here; the matcher carries the same-name flag.
  {
    const m = text.match(
      /put up to (\d+) [A-Za-z'éÉ-]+ from your discard pile onto your bench/i,
    );
    if (m) {
      effects.push({
        kind: "recurSelfFromDiscardToBench",
        max: parseInt(m[1], 10),
        selfNameOnly: true,
      });
    }
  }

  // ---- Snipe one Pokémon, scaled by energy attached ------------------------
  // Genesect Bug's Cannon: "20 damage to 1 of your opponent's Pokémon for
  // each Grass Energy attached to this Pokémon." Must precede the generic
  // snipeOne so we don't double-register.
  let snipePerEnergyMatched = false;
  {
    const m = text.match(
      /(\d+) damage to 1 of your opponent'?s (?:benched )?pok[eé]mon for each ([A-Za-z]+) energy attached to this pok[eé]mon/i,
    );
    if (m) {
      const energyType = matchEnergyType(m[2]);
      if (energyType) {
        effects.push({
          kind: "snipeOnePerEnergy",
          perEnergy: parseInt(m[1], 10),
          energyType,
        });
        snipePerEnergyMatched = true;
      }
    }
  }

  // ---- Snipe one Pokémon (bench-only OR free-pick) --------------------------
  // "This attack [also] does N damage to 1 of your opponent's [Benched] Pokémon."
  // The "Benched" word distinguishes:
  //   present → bench-only (typically a follow-up snipe after a main attack)
  //   absent  → may target Active or Bench (Fezandipiti ex Cruel Arrow,
  //             where this IS the main damage; W/R applies on Active).
  {
    const m = text.match(/(\d+) damage to 1 of your opponent'?s (benched )?pok[eé]mon/i);
    if (m && !/each of/i.test(text) && !snipePerEnergyMatched) {
      effects.push({
        kind: "snipeOne",
        damage: parseInt(m[1], 10),
        benchOnly: Boolean(m[2]),
      });
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

  // ---- Distributed damage: "Choose N times, do M damage each" -------------
  // Arboliva ex "Oil Salvo": "Choose 1 of your opponent's Pokémon N times.
  // ... For each time you chose a Pokémon, do M damage to it. This damage
  // isn't affected by Weakness or Resistance."
  {
    const m = text.match(
      /choose 1 of your opponent'?s pok[eé]mon (\d+) times[\s\S]*?for each time you chose a pok[eé]mon,? do (\d+) damage to it/i,
    );
    if (m) {
      const ignoreWR = /isn'?t affected by weakness or resistance|don'?t apply weakness/i.test(text);
      effects.push({
        kind: "distributeDamage",
        times: parseInt(m[1], 10),
        perHit: parseInt(m[2], 10),
        ignoreWR,
      });
      baseDamageOverride = 0;
    }
  }

  // ---- Distributed counters on Benched: "Put N damage counters …" ---------
  // Dragapult ex "Phantom Dive": "Put 6 damage counters on your opponent's
  // Benched Pokémon in any way you like." Counter placement always bypasses
  // W/R; we model it as N hits of 10 damage on the bench only. The base
  // attack damage (200 for Dragapult) still hits the Active normally.
  {
    const m = text.match(
      /put (\d+) damage counters? on your opponent'?s benched pok[eé]mon in any way you like/i,
    );
    if (m) {
      effects.push({
        kind: "distributeDamage",
        times: parseInt(m[1], 10),
        perHit: 10,
        ignoreWR: true,
        benchOnly: true,
      });
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
  if (text.match(
    /flip a coin\. if heads, during your opponent'?s next turn, prevent all damage (?:from and effects of attacks |done to this pok[eé]mon by attacks)/i,
  )) {
    effects.push({ kind: "shieldNextTurn", requiresHeads: true });
  } else if (text.match(
    /during your opponent'?s next turn, prevent all damage (?:from and effects of attacks |done to this pok[eé]mon by attacks)/i,
  )) {
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
  if (text.match(
    /this (?:attack'?s )?damage isn'?t affected by weakness or resistance,?\s*or by any effects on (?:your opponent'?s active pok[eé]mon|those pok[eé]mon)/i,
  )) {
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
  if (text.match(
    /this attack'?s damage isn'?t affected by any effects on your opponent'?s active pok[eé]mon/i,
  )) {
    if (!effects.some((ef) => ef.kind === "ignoreOppEffects")) {
      effects.push({ kind: "ignoreOppEffects" });
    }
  }

  // ---- Return self + all attached to hand ---------------------------------
  // Meowth ex "Tuck Tail": "Put this Pokémon and all attached cards into
  // your hand." Also matches Emolga "Sky Return": "Return this Pokémon and
  // all attached cards to your hand."
  if (/(?:put|return) this pok[eé]mon and all attached cards (?:into|to) your hand/i.test(text)) {
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
  // Skipped if perFriendlyBench etc. already matched. Multiplicative form
  // ("N× damage for each ...") zeros the base damage so the parsed N from
  // damage="N×" doesn't add to the per-X scaler — without this, Spidops's
  // Rocket Rush at 6 TR Pokémon dealt 30 + 30×6 = 210 instead of 180.
  {
    const r = detectPerPokemonFilter(text, effects);
    if (r.multiplicativeMatched) baseDamageOverride = 0;
  }

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

  // ---- New patterns (this batch) ----

  // Tinkaton Windup Swing: "This attack does N less damage for each Energy
  // attached to your opponent's Active Pokémon."
  {
    const m = text.match(
      /this attack does (\d+) less damage for each energy attached to your opponent'?s active pok[eé]mon/i,
    );
    if (m) effects.push({ kind: "damageReducedPerEnergyOnDefender", perCount: parseInt(m[1], 10) });
  }

  // Ceruledge Infernal Slash: "Discard N Basic <Type> Energy cards from your
  // hand. If you can't discard N cards in this way, this attack does nothing."
  {
    const m = text.match(
      /discard (\d+) basic ([A-Za-z]+) energy cards? from your hand\. if you can'?t discard \d+ cards? in this way, this attack does nothing/i,
    );
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) effects.push({ kind: "discardEnergyFromHandOrFizzle", count: parseInt(m[1], 10), energyType: t });
    }
  }

  // Lokix Jumping Shot: "Shuffle this Pokémon and all attached cards into
  // your deck."
  if (/shuffle this pok[eé]mon and all attached cards into your deck/i.test(text)) {
    effects.push({ kind: "selfShuffleIntoDeck" });
  }

  // Volcanion Backfire: "Put N <Type> Energy attached to this Pokémon into
  // your hand."
  {
    const m = text.match(/put (\d+) ([A-Za-z]+) energy attached to this pok[eé]mon into your hand/i);
    if (m) {
      const t = matchEnergyType(m[2]);
      effects.push({ kind: "returnAttachedEnergyToHand", count: parseInt(m[1], 10), energyType: t });
    }
  }

  // Gloom Disperse Drool: "This attack also does N damage to each Benched
  // Pokémon (both yours and your opponent's)."
  {
    const m = text.match(
      /this attack also does (\d+) damage to each benched pok[eé]mon \(both yours and your opponent'?s\)/i,
    );
    if (m) effects.push({ kind: "alsoDamageEachBench", damage: parseInt(m[1], 10), sides: "both" });
  }

  // Bronzong Tool Drop: "This attack does N damage for each Pokémon Tool
  // attached to all Pokémon."
  {
    const m = text.match(/this attack does (\d+) damage for each pok[eé]mon tool attached to all pok[eé]mon/i);
    if (m) effects.push({ kind: "perAttachedToolBothSides", perCount: parseInt(m[1], 10) });
  }

  // Raticate Retaliatory Incisors: "This attack does N damage for each
  // damage counter on all of your Benched <Name>."
  {
    const m = text.match(
      /this attack does (\d+) damage for each damage counter on all of your benched ([A-Za-z][A-Za-z' -]+?)\.?$/i,
    );
    if (m) {
      effects.push({
        kind: "perDamageCounterOnBenchNamed",
        perCount: parseInt(m[1], 10),
        namePart: m[2].trim().replace(/[. ]+$/, ""),
      });
    }
  }

  // Frosmoth Cold Cyclone: "Move a <Type> Energy from this Pokémon to 1 of
  // your Benched Pokémon."
  {
    const m = text.match(/move an? ([A-Za-z]+) energy from this pok[eé]mon to 1 of your benched pok[eé]mon/i);
    if (m) {
      const t = matchEnergyType(m[1]);
      effects.push({ kind: "moveOneEnergyToBench", energyType: t });
    }
  }

  // Raichu Strong Volt: "Discard a <Type> Energy from this Pokémon."
  // (One-shot single-energy discard, not the per-energy-for-damage form.)
  {
    const m = text.match(/^discard an? ([A-Za-z]+) energy from this pok[eé]mon\.?$/im);
    if (m) {
      const t = matchEnergyType(m[1]);
      // Avoid claiming if we already detected discardOwnEnergy / per-energy.
      const alreadyHas = effects.some(
        (e) => e.kind === "discardOwnEnergy" || e.kind === "discardOwnEnergyForDamage",
      );
      if (!alreadyHas) {
        effects.push({ kind: "discardSingleAttachedEnergy", energyType: t });
      }
    }
  }

  // Okidogi Settle the Score: "This attack does N more damage for each
  // Prize card your opponent took during their last turn."
  {
    const m = text.match(
      /this attack does (\d+) more damage for each prize card your opponent took during their last turn/i,
    );
    if (m) effects.push({ kind: "perPrizeOppTookLastTurn", perCount: parseInt(m[1], 10) });
  }

  // Celebi Traverse Time: "Search your deck for up to N in any combination
  // of <X> Pokémon and <Y> cards, reveal them, and put them into your hand."
  // Heatmor Licking Catch: similar shape with Pokémon + Basic Energy.
  {
    const mPS = text.match(
      /search your deck for up to (\d+) in any combination of ([A-Za-z]+) pok[eé]mon and stadium cards, reveal them, and put them into your hand/i,
    );
    if (mPS) {
      const t = matchEnergyType(mPS[2]);
      if (t) {
        const max = parseInt(mPS[1], 10);
        // Each slot independently matches either a Pokémon of <type> OR any
        // Stadium card. Engine's slot-based search picks the first match per
        // slot, so we put one Pokémon slot then the rest as Stadium-or-any.
        const filters: AttackSearchFilter[] = [];
        for (let i = 0; i < max; i++) {
          filters.push(
            i === 0
              ? { kind: "pokemonOfType", energyType: t }
              : { kind: "any" },
          );
        }
        effects.push({ kind: "searchDeckMixedToHand", max, filters });
      }
    }
  }
  {
    const mPE = text.match(
      /search your deck for up to (\d+) in any combination of ([A-Za-z]+) pok[eé]mon and basic ([A-Za-z]+) energy cards, reveal them, and put them into your hand/i,
    );
    if (mPE) {
      const tp = matchEnergyType(mPE[2]);
      const te = matchEnergyType(mPE[3]);
      if (tp && te) {
        const max = parseInt(mPE[1], 10);
        const filters: AttackSearchFilter[] = [];
        for (let i = 0; i < max; i++) {
          filters.push(
            i % 2 === 0
              ? { kind: "pokemonOfType", energyType: tp }
              : { kind: "basicEnergyType", energyType: te },
          );
        }
        effects.push({ kind: "searchDeckMixedToHand", max, filters });
      }
    }
  }

  // Xerneas Geo Gate: "Search your deck for up to N Basic <Type> Pokémon and
  // put them onto your Bench."
  {
    const m = text.match(
      /search your deck for up to (\d+) basic ([A-Za-z]+) pok[eé]mon and put them onto your bench/i,
    );
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) effects.push({ kind: "searchDeckBasicTypeToBench", max: parseInt(m[1], 10), pokemonType: t });
    }
  }

  // Rotom Roto Call: "Search your deck for any number of Pokémon that have
  // '<Name>' in their name and put them onto your Bench."
  {
    const m = text.match(
      /search your deck for any number of pok[eé]mon that have "?([A-Za-z][A-Za-z' -]+?)"? in their name and put them onto your bench/i,
    );
    if (m) effects.push({ kind: "searchDeckNamedPokemonToBench", namePart: m[1].trim() });
  }

  // Furfrou Hand Trim: "Discard random cards from your opponent's hand
  // until they have N cards in their hand."
  {
    const m = text.match(
      /discard random cards from your opponent'?s hand until they have (\d+) cards? in their hand/i,
    );
    if (m) effects.push({ kind: "oppHandTrimToCount", targetCount: parseInt(m[1], 10) });
  }

  // Smeargle Energizing Sketch: "Flip N coins. Attach an amount of Basic
  // Energy up to the number of heads from your discard pile to your Benched
  // Pokémon in any way you like."
  {
    const m = text.match(
      /flip (\d+) coins?\. attach an amount of basic energy up to the number of heads from your discard pile to your benched pok[eé]mon/i,
    );
    if (m) effects.push({ kind: "flipNAttachBasicFromDiscardToBench", coins: parseInt(m[1], 10) });
  }

  // Snorlax Gormandizer: "Flip a coin until you get tails. Search your deck
  // for an amount of Basic Energy up to the number of heads and attach it
  // to this Pokémon."
  if (text.match(
    /flip a coin until you get tails\. search your deck for an amount of basic energy up to the number of heads and attach it to this pok[eé]mon/i,
  )) {
    effects.push({ kind: "flipUntilTailsAttachBasicSelf" });
  }

  // Mawile Double Eater: "Discard up to N Energy cards from your hand, and
  // this attack does M damage for each card you discarded in this way."
  {
    const m = text.match(
      /discard up to (\d+) energy cards? from your hand,? and this attack does (\d+) damage for each card you discarded in this way/i,
    );
    if (m) {
      effects.push({
        kind: "discardEnergyFromHandForDamage",
        max: parseInt(m[1], 10),
        damagePer: parseInt(m[2], 10),
      });
    }
  }

  // Terapagos Prism Charge: "Search your deck for up to N Basic Energy
  // cards of different types and attach them to your Tera Pokémon in any
  // way you like."
  {
    const m = text.match(
      /search your deck for up to (\d+) basic energy cards? of different types and attach them to your ([A-Za-z][A-Za-z ]+?) pok[eé]mon/i,
    );
    if (m) {
      effects.push({
        kind: "searchBasicEnergyDifferentTypesToBenchSubtype",
        max: parseInt(m[1], 10),
        benchSubtype: m[2].trim(),
      });
    }
  }

  // Pawmot Voltaic Fist: "You may have this Pokémon also do N damage to
  // itself and make your opponent's Active Pokémon Paralyzed."
  {
    const m = text.match(
      /(?:you may have )?this pok[eé]mon also do (\d+) damage to itself and make your opponent'?s active pok[eé]mon (asleep|burned|confused|paralyzed|poisoned)/i,
    );
    if (m) {
      effects.push({
        kind: "selfDamageAndStatusOpp",
        selfDamage: parseInt(m[1], 10),
        status: m[2].toLowerCase() as StatusCondition,
      });
    }
  }

  // Manectric Flash Impact / Honchkrow / various: "This attack also does
  // N damage to 1 of your Benched Pokémon."
  {
    const m = text.match(
      /this attack also does (\d+) damage to 1 of your benched pok[eé]mon/i,
    );
    if (m) effects.push({ kind: "alsoDamageOwnBench", damage: parseInt(m[1], 10) });
  }

  // Teal/Hearthflame/Wellspring Mask Ogerpon Kagura family: "Search your
  // deck for a Basic <Type> Energy card and attach it to 1 of your Pokémon."
  {
    const m = text.match(
      /search your deck for a basic ([A-Za-z]+) energy card and attach it to 1 of your pok[eé]mon/i,
    );
    if (m) {
      const t = matchEnergyType(m[1]);
      if (t) effects.push({ kind: "searchBasicEnergyAttachOne", energyType: t });
    }
  }

  // Misty's Lapras Swim Together: "Search your deck for up to N <Name>
  // Pokémon, reveal them, and put them into your hand."
  {
    const m = text.match(
      /search your deck for up to (\d+) ([A-Z][A-Za-z'’-]+(?:'s| s)?) pok[eé]mon, reveal them, and put them into your hand/i,
    );
    if (m) {
      effects.push({
        kind: "searchDeckNamedPokemonToHand",
        namePart: m[2].trim(),
        max: parseInt(m[1], 10),
      });
    }
  }

  // Ethan's Typhlosion Buddy Blast: "This attack does N more damage for
  // each <Name> card in your discard pile."
  {
    const m = text.match(
      /this attack does (\d+) more damage for each ([A-Z][A-Za-z'’ -]+?) card in your discard pile/i,
    );
    if (m) {
      effects.push({
        kind: "perCardInOwnDiscardNamed",
        namePart: m[2].trim(),
        perCount: parseInt(m[1], 10),
      });
    }
  }

  // Paldean Tauros Raging Charge: "This attack does N damage for each of
  // your Pokémon that has '<Name>' in its name that has any damage
  // counters on it."
  {
    const m = text.match(
      /this attack does (\d+) damage for each of your pok[eé]mon that has "([A-Za-z][A-Za-z' -]+?)" in its name that has any damage counters/i,
    );
    if (m) {
      effects.push({
        kind: "perOwnPokemonNamedWithDamage",
        namePart: m[2].trim(),
        perCount: parseInt(m[1], 10),
      });
    }
  }

  // Misty's Gyarados Splashing Panic: "Discard the top N cards of your
  // deck, and this attack does M damage for each <Name> Pokémon that you
  // discarded in this way."
  {
    const m = text.match(
      /discard the top (\d+) cards? of your deck,? and this attack does (\d+) damage for each ([A-Z][A-Za-z'’ -]+?) pok[eé]mon that you discarded in this way/i,
    );
    if (m) {
      effects.push({
        kind: "discardTopNAndDamagePerNamed",
        topN: parseInt(m[1], 10),
        namePart: m[3].trim(),
        perCount: parseInt(m[2], 10),
      });
    }
  }

  // Steven's Baltoy Summoning Sign: "Search your deck for up to N Basic
  // <Name> Pokémon and put them onto your Bench."
  {
    const m = text.match(
      /search your deck for up to (\d+) basic ([A-Z][A-Za-z'’ -]+?) pok[eé]mon and put them onto your bench/i,
    );
    if (m) {
      effects.push({
        kind: "searchDeckBasicNamedToBench",
        namePart: m[2].trim(),
        max: parseInt(m[1], 10),
      });
    }
  }

  // Hydrapple Hydra Breath: "Discard N Basic <Type> Energy cards from your
  // hand, and Knock Out your opponent's Active Pokémon. If you can't
  // discard N cards in this way, this attack does nothing."
  {
    const m = text.match(
      /discard (\d+) basic ([A-Za-z]+) energy cards? from your hand,? and knock out your opponent'?s active pok[eé]mon/i,
    );
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) {
        effects.push({
          kind: "discardEnergyFromHandAndKoOpp",
          count: parseInt(m[1], 10),
          energyType: t,
        });
      }
    }
  }

  // Clefable Metronome / N's Zoroark / Team Rocket's Mimikyu copy-attack
  // family: "Choose 1 of your opponent's [Active] Pokémon's attacks and
  // use it as this attack."
  if (text.match(/choose 1 of your opponent'?s active pok[eé]mon's attacks and use it as this attack/i)) {
    effects.push({ kind: "useOppActiveAttack" });
  }
  // N's Zoroark ex Night Joker: "Choose 1 of your Benched <Name> Pokémon's
  // attacks and use it as this attack."
  {
    const m = text.match(
      /choose 1 of your benched ([A-Za-z'’ -]+?) pok[eé]mon's attacks and use it as this attack/i,
    );
    if (m) {
      effects.push({ kind: "useBenchedAllyNamedAttack", namePart: m[1].trim() });
    }
  }
  // Coin-flip variant (Ethan's Sudowoodo Try to Imitate).
  if (text.match(
    /flip a coin\. if heads, choose 1 of your opponent'?s active pok[eé]mon's attacks and use it as this attack/i,
  )) {
    effects.push({ kind: "useOppActiveAttack", coinFlip: true });
  }

  // Team Rocket's Wobbuffet Rocket Mirror: "Move all damage counters from
  // 1 of your Benched <Name> Pokémon to your opponent's Active Pokémon."
  {
    const m = text.match(
      /move all damage counters from 1 of your benched ([A-Z][A-Za-z'’ -]+?) pok[eé]mon to your opponent'?s active pok[eé]mon/i,
    );
    if (m) {
      effects.push({ kind: "moveAllBenchDamageNamedToOppActive", namePart: m[1].trim() });
    }
  }

  // Stoutland Odor Sleuth: "Flip N coins. Put a number of cards up to the
  // number of heads from your discard pile into your hand."
  {
    const m = text.match(
      /flip (\d+) coins?\. put a number of cards up to the number of heads from your discard pile into your hand/i,
    );
    if (m) {
      effects.push({
        kind: "flipNRecoverDiscardToHand",
        coins: parseInt(m[1], 10),
        filter: { kind: "any" },
      });
    }
  }

  // Tornadus Wrapped in Wind: "Attach a Basic Energy card from your hand
  // to this Pokémon."
  if (
    text.match(/^attach a basic energy card from your hand to this pok[eé]mon\.?$/im) &&
    !text.match(/\bdiscard\b/i)
  ) {
    effects.push({ kind: "attachBasicEnergyFromHandToSelf" });
  }

  // Rocket Feathers (Honchkrow): "You may discard any number of Supporter
  // cards that have '<Name>' in their name from your hand, and this attack
  // does M damage for each card you discarded in this way."
  {
    const m = text.match(
      /you may discard any number of supporter cards that have "([A-Z][A-Za-z'’ ]+?)" in their name from your hand,? and this attack does (\d+) damage for each card you discarded in this way/i,
    );
    if (m) {
      effects.push({
        kind: "discardNamedSupporterFromHandForDamage",
        namePart: m[1].trim(),
        perCount: parseInt(m[2], 10),
        max: 99,
      });
    }
  }

  // Scrafty Ruffians Attack: "Flip a coin for each <Type> Pokémon you have
  // in play. This attack does N damage for each heads."
  {
    const m = text.match(
      /flip a coin for each ([A-Za-z]+) pok[eé]mon you have in play\. this attack does (\d+) damage for each heads/i,
    );
    if (m) {
      const t = matchEnergyType(m[1]);
      if (t) effects.push({ kind: "flipPerPokemonOfTypePerHeads", energyType: t, perHeads: parseInt(m[2], 10) });
    }
  }

  // Abomasnow Frozen Wood: "If this Pokémon has N or more <Type> Energy
  // attached, this attack does M more damage."
  {
    const m = text.match(
      /if this pok[eé]mon has (\d+) or more ([A-Za-z]+) energy attached,? this attack does (\d+) more damage/i,
    );
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) {
        effects.push({
          kind: "ifSelfEnergyAtLeastBonus",
          energyType: t,
          count: parseInt(m[1], 10),
          bonus: parseInt(m[3], 10),
        });
      }
    }
  }

  // Inteleon Bring Down: "Choose a Pokémon in play (yours or your
  // opponent's) that has the least HP remaining, except for this Pokémon,
  // and it is Knocked Out."
  if (text.match(
    /choose a pok[eé]mon in play.*?that has the least hp remaining.*?and it is knocked out/i,
  )) {
    effects.push({ kind: "koLowestHpInPlay" });
  }

  // Shiftry Reversing Gust + Sylveon Mystical Return: "Flip a coin. If
  // heads, choose 1 of your opponent's [Benched] Pokémon. Shuffle..."
  if (text.match(
    /flip a coin\. if heads, choose 1 of your opponent'?s (?:benched )?pok[eé]mon\. shuffle that pok[eé]mon and all attached cards into their deck/i,
  )) {
    effects.push({ kind: "flipShuffleOppPokemonIntoDeck" });
  }

  // Sandslash Sand Attack: "During your opponent's next turn, if the
  // Defending Pokémon tries to use an attack, your opponent flips a coin.
  // If tails, that attack doesn't happen."
  if (text.match(
    /during your opponent'?s next turn, if the defending pok[eé]mon tries to use an attack, your opponent flips a coin\. if tails, that attack doesn'?t happen/i,
  )) {
    effects.push({ kind: "defenderAttackCoinFlipNextTurn" });
  }

  // Pachirisu Electrified Incisors.
  if (text.match(
    /during your opponent'?s next turn, whenever they attach an energy card from their hand to the defending pok[eé]mon, place (\d+) damage counters on that pok[eé]mon/i,
  )) {
    const m = text.match(/place (\d+) damage counters/i);
    const counters = m ? parseInt(m[1], 10) : 80;
    effects.push({ kind: "defenderEnergyAttachPenaltyNextTurn", counters });
  }

  // Watchog Focus Energy: "During your next turn, this Pokémon's <Name>
  // attack's base damage is N."
  {
    const m = text.match(
      /during your next turn, this pok[eé]mon'?s ([A-Za-z][A-Za-z' -]+?) attack'?s base damage is (\d+)/i,
    );
    if (m) {
      effects.push({
        kind: "selfNextTurnAttackBaseOverride",
        attackName: m[1].trim(),
        baseDamage: parseInt(m[2], 10),
      });
    }
  }

  // Crawdaunt Cutting Riposte: "If this Pokémon has any damage counters
  // on it, this attack can be used for <Type>."
  {
    const m = text.match(
      /if this pok[eé]mon has any damage counters on it,? this attack can be used for ([A-Za-z]+)/i,
    );
    if (m) {
      const t = matchEnergyType(m[1]);
      if (t) effects.push({ kind: "altTypeCostIfDamaged", energyType: t });
    }
  }

  // Salazzle Sudden Scorching: "Your opponent discards a card from their
  // hand. If this Pokémon evolved from <Source> during this turn, your
  // opponent discards N more cards."
  {
    const m = text.match(
      /your opponent discards a card from their hand\. if this pok[eé]mon evolved from ([A-Z][A-Za-z'’ -]+?) during this turn, your opponent discards (\d+) more cards/i,
    );
    if (m) {
      effects.push({
        kind: "oppDiscardWithEvolveBonus",
        baseCount: 1,
        bonusCount: parseInt(m[2], 10),
        sourceCardName: m[1].trim(),
      });
    }
  }

  // N's Vanilluxe Snow Coating.
  if (/double the number of damage counters on each of your opponent'?s pok[eé]mon/i.test(text)) {
    effects.push({ kind: "doubleOppDamageCounters" });
  }

  // Team Rocket's Murkrow Torment: "Choose 1 of your opponent's Active
  // Pokémon's attacks. During your opponent's next turn, that Pokémon
  // can't use that attack."
  if (text.match(
    /choose 1 of your opponent'?s active pok[eé]mon's attacks\. during your opponent'?s next turn, that pok[eé]mon can'?t use that attack/i,
  )) {
    effects.push({ kind: "lockOneOppAttackNextTurn" });
  }

  // Team Rocket's Blipbug Searching Eyes.
  if (/look at 1 of your opponent'?s face-down prize cards/i.test(text)) {
    effects.push({ kind: "peekOppPrize" });
  }

  // Gothorita Fortunate Eye.
  {
    const m = text.match(
      /look at the top (\d+) cards of your opponent'?s deck and put them back in any order/i,
    );
    if (m) effects.push({ kind: "peekOppDeckTop", count: parseInt(m[1], 10) });
  }

  // Cinderace Turbo Flare: "Search your deck for up to N Basic Energy
  // cards and attach them to your Benched Pokémon in any way you like."
  {
    const m = text.match(
      /search your deck for up to (\d+) basic energy cards? and attach them to your benched pok[eé]mon/i,
    );
    if (m) effects.push({ kind: "searchBasicEnergyAttachBench", max: parseInt(m[1], 10) });
  }

  // Dialga Chrono Burst: "You may shuffle all Energy attached to this
  // Pokémon into your deck and have this attack do N more damage."
  {
    const m = text.match(
      /you may shuffle all energy attached to this pok[eé]mon into your deck and have this attack do (\d+) more damage/i,
    );
    if (m) effects.push({ kind: "optionalShuffleSelfEnergyForBonus", bonus: parseInt(m[1], 10) });
  }

  // Meloetta Soothing Melody: "Heal N damage from 1 of your Benched
  // <Type> Pokémon."
  {
    const m = text.match(
      /heal (\d+) damage from 1 of your benched ([A-Za-z]+) pok[eé]mon/i,
    );
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) effects.push({ kind: "healOneBenchPokemonByType", amount: parseInt(m[1], 10), pokemonType: t });
    }
  }

  // Miltank Bellyful of Milk: "Flip 2 coins. If both of them are heads,
  // heal all damage from 1 of your Pokémon."
  if (text.match(/flip 2 coins?\. if both of them are heads, heal all damage from 1 of your pok[eé]mon/i)) {
    effects.push({ kind: "flipBothHeadsHealOne" });
  }

  // Dedenne Tail Generator: "Choose Basic <Type> Energy cards from your
  // discard pile up to the amount of Energy attached to all of your
  // opponent's Pokémon and attach them to your <Type> Pokémon in any way."
  {
    const m = text.match(
      /choose basic ([A-Za-z]+) energy cards? from your discard pile up to the amount of energy attached to all of your opponent'?s pok[eé]mon and attach them to your ([A-Za-z]+) pok[eé]mon/i,
    );
    if (m) {
      const te = matchEnergyType(m[1]);
      const tp = matchEnergyType(m[2]);
      if (te && tp) {
        effects.push({ kind: "attachDiscardEnergyByOppEnergy", energyType: te, pokemonType: tp });
      }
    }
  }

  // Kyogre Riptide: "This attack does N damage for each Basic <Type>
  // Energy card in your discard pile. Then, shuffle those cards into your
  // deck."
  {
    const m = text.match(
      /this attack does (\d+) damage for each basic ([A-Za-z]+) energy card in your discard pile\. then, shuffle those cards into your deck/i,
    );
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) {
        effects.push({
          kind: "perBasicEnergyInDiscardThenShuffle",
          energyType: t,
          perCount: parseInt(m[1], 10),
        });
      }
    }
  }

  // Boldore Smack Down: "If your opponent's Active Pokémon has <Type>
  // Resistance, this attack does N more damage."
  {
    const m = text.match(
      /if your opponent'?s active pok[eé]mon has ([A-Za-z]+) resistance, this attack does (\d+) more damage/i,
    );
    if (m) {
      const t = matchEnergyType(m[1]);
      if (t) {
        effects.push({
          kind: "ifDefenderHasResistanceOfTypeBonus",
          resistanceType: t,
          bonus: parseInt(m[2], 10),
        });
      }
    }
  }

  // Basculin Bared Fangs: "If your opponent's Active Pokémon has no damage
  // counters on it before this attack does damage, this attack does nothing."
  if (text.match(
    /if your opponent'?s active pok[eé]mon has no damage counters on it before this attack does damage, this attack does nothing/i,
  )) {
    effects.push({ kind: "fizzleIfDefenderUndamaged" });
  }

  // Team Rocket's Exeggutor Tri Kinesis: "Flip 3 coins. If all of them
  // are heads, Knock Out 1 of your opponent's Pokémon."
  {
    const m = text.match(
      /flip (\d+) coins?\. if all of them are heads, knock out 1 of your opponent'?s pok[eé]mon/i,
    );
    if (m) effects.push({ kind: "flipAllHeadsKoOppOne", coins: parseInt(m[1], 10) });
  }

  // Chi-Yu Scorching Earth: "If your opponent has a Stadium in play,
  // discard it. If you do, your opponent can't play any Stadium cards from
  // their hand during their next turn."
  if (text.match(
    /if your opponent has a stadium in play, discard it\. if you do, your opponent can'?t play any stadium cards from their hand during their next turn/i,
  )) {
    effects.push({ kind: "discardOppStadiumAndLock" });
  }

  // Medicham Harmonious Spirit Palm: "If this Pokémon and your opponent's
  // Active Pokémon have the same amount of Energy attached, this attack
  // does N more damage."
  {
    const m = text.match(
      /if this pok[eé]mon and your opponent'?s active pok[eé]mon have the same amount of energy attached, this attack does (\d+) more damage/i,
    );
    if (m) effects.push({ kind: "ifEqualEnergyBonus", bonus: parseInt(m[1], 10) });
  }

  // Boltund Electrifying Dash: "Search your deck for up to N Basic <Type>
  // Energy cards and attach them to your Benched Pokémon in any way you like."
  {
    const m = text.match(
      /search your deck for up to (\d+) basic ([A-Za-z]+) energy cards? and attach them to your benched pok[eé]mon/i,
    );
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) effects.push({ kind: "searchBasicEnergyTypeAttachBench", max: parseInt(m[1], 10), energyType: t });
    }
  }

  // Forretress / Delcatty: "You may move any amount of <Type> Energy from
  // your Pokémon to your other Pokémon in any way you like." (or no type
  // for any-Energy variants)
  {
    const m = text.match(
      /you may move any amount of (?:([A-Za-z]+) )?energy from your pok[eé]mon to your other pok[eé]mon/i,
    );
    if (m) {
      const t = m[1] ? matchEnergyType(m[1]) : undefined;
      effects.push({ kind: "moveAnyEnergyAcrossOwn", energyType: t });
    }
  }

  // Varoom Metal Coating: "Attach a Basic <Type> Energy card from your
  // discard pile to this Pokémon."
  {
    const m = text.match(
      /^attach a basic ([A-Za-z]+) energy card from your discard pile to this pok[eé]mon\.?$/im,
    );
    if (m) {
      const t = matchEnergyType(m[1]);
      if (t) effects.push({ kind: "attachBasicEnergyDiscardToSelfTyped", energyType: t });
    }
  }

  // Poltchageist Tea Server: "Put a Basic <Type> Energy card from your
  // discard pile into your hand."
  {
    const m = text.match(
      /put a basic ([A-Za-z]+) energy card from your discard pile into your hand/i,
    );
    if (m) {
      const t = matchEnergyType(m[1]);
      if (t) effects.push({ kind: "recoverBasicEnergyTypeToHand", energyType: t });
    }
  }

  // Scream Tail Supportive Singing: "Heal N damage from 1 of your Benched
  // <Subtype> Pokémon."
  {
    const m = text.match(
      /heal (\d+) damage from 1 of your benched (Ancient|Future|Tera) pok[eé]mon/i,
    );
    if (m) {
      effects.push({ kind: "healOneBenchBySubtype", amount: parseInt(m[1], 10), subtype: m[2] });
    }
  }

  // Walking Wake Undulating Slice: "Put up to N damage counters on this
  // Pokémon. This attack does M damage for each damage counter you placed
  // in this way."
  {
    const m = text.match(
      /put up to (\d+) damage counters? on this pok[eé]mon\. this attack does (\d+) damage for each damage counter you placed in this way/i,
    );
    if (m) {
      effects.push({
        kind: "selfPlaceCountersForDamage",
        max: parseInt(m[1], 10),
        damagePer: parseInt(m[2], 10),
      });
    }
  }

  // Decidueye Power Shot: "Discard a Basic <Type> Energy card from your
  // hand. If you can't, this attack does nothing."
  {
    const m = text.match(
      /discard a basic ([A-Za-z]+) energy card from your hand\. if you can'?t,? this attack does nothing/i,
    );
    if (m) {
      const t = matchEnergyType(m[1]);
      if (t) effects.push({ kind: "discardSingleEnergyFromHandOrFizzle", energyType: t });
    }
  }

  // Vikavolt Circuit Cannon: "This attack does N more damage for each of
  // your Benched <Name>."
  {
    const m = text.match(
      /this attack does (\d+) more damage for each of your benched ([A-Z][A-Za-z'’ -]+?)\.?\s*$/im,
    );
    if (m) {
      effects.push({
        kind: "perBenchPokemonNamed",
        namePart: m[2].trim(),
        perCount: parseInt(m[1], 10),
      });
    }
  }

  // Aggron Angry Slam: "This attack does N damage for each of your Pokémon
  // that has any damage counters on it."
  {
    const m = text.match(
      /this attack does (\d+) damage for each of your pok[eé]mon that has any damage counters on it/i,
    );
    if (m) effects.push({ kind: "perOwnPokemonWithDamage", perCount: parseInt(m[1], 10) });
  }

  // Hawlucha Prize Count: "If you have more Prize cards remaining than
  // your opponent, this attack does N more damage."
  {
    const m = text.match(
      /if you have more prize cards? remaining than your opponent,? this attack does (\d+) more damage/i,
    );
    if (m) effects.push({ kind: "ifMorePrizesThanOpp", bonus: parseInt(m[1], 10) });
  }

  // Sableye Damage Collection: "You may move any number of damage counters
  // from your opponent's Benched Pokémon to their Active Pokémon."
  if (text.match(
    /you may move any number of damage counters from your opponent'?s benched pok[eé]mon to their active pok[eé]mon/i,
  )) {
    effects.push({ kind: "moveAllOppBenchDamageToOppActive" });
  }

  // Ariados String Bind: "This attack does N more damage for each
  // Colorless in your opponent's Active Pokémon's Retreat Cost."
  {
    const m = text.match(
      /this attack does (\d+) more damage for each colorless in your opponent'?s active pok[eé]mon'?s retreat cost/i,
    );
    if (m) effects.push({ kind: "perColorlessOnDefenderRetreat", perCount: parseInt(m[1], 10) });
  }

  // Sinistcha Spill the Tea: "Discard up to N Grass Energy cards from your
  // Pokémon. This attack does M damage for each card you discarded in this way."
  {
    const m = text.match(
      /discard up to (\d+) ([A-Za-z]+) energy cards? from your pok[eé]mon\. this attack does (\d+) damage for each card you discarded in this way/i,
    );
    if (m) {
      const t = matchEnergyType(m[2]);
      effects.push({
        kind: "discardEnergyAnywhereForDamage",
        max: parseInt(m[1], 10),
        damagePer: parseInt(m[3], 10),
        energyType: t,
      });
    }
  }

  // Sinistcha ex Re-Brew: "Put N damage counters on 1 of your opponent's
  // Pokémon for each Basic <Type> Energy card in your discard pile. Then,
  // shuffle those Energy cards into your deck."
  {
    const m = text.match(
      /put (\d+) damage counters? on 1 of your opponent'?s pok[eé]mon for each basic ([A-Za-z]+) energy card in your discard pile\. then, shuffle those energy cards into your deck/i,
    );
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) {
        effects.push({
          kind: "perBasicEnergyDiscardCountersOnOpp",
          perCount: parseInt(m[1], 10),
          energyType: t,
        });
      }
    }
  }

  // Team Rocket's Porygon Hacking: "Discard a card from your hand. If you
  // do, your opponent discards a card from their hand."
  if (text.match(
    /discard a card from your hand\. if you do, your opponent discards a card from their hand/i,
  )) {
    effects.push({ kind: "discardOwnAndOppHand" });
  }

  // Morpeko Pick and Stick: "Attach up to N Basic Energy cards from your
  // discard pile to your Pokémon in any way you like."
  {
    const m = text.match(
      /attach up to (\d+) basic energy cards? from your discard pile to your pok[eé]mon in any way you like/i,
    );
    if (m) effects.push({ kind: "attachAnyBasicEnergyDiscardN", max: parseInt(m[1], 10) });
  }

  // Bronzong Evolution Jammer.
  if (text.match(
    /during your opponent'?s next turn,? they can'?t play any pok[eé]mon from their hand to evolve their pok[eé]mon/i,
  )) {
    effects.push({ kind: "blockOppEvolveNextTurn" });
  }

  // Rillaboom Drum Beating: "During your opponent's next turn, attacks
  // used by the Defending Pokémon cost Colorless more, and its Retreat
  // Cost is Colorless more."
  if (text.match(
    /during your opponent'?s next turn,? attacks used by the defending pok[eé]mon cost colorless more,? and its retreat cost is colorless more/i,
  )) {
    effects.push({ kind: "defenderAttackAndRetreatCostUpNextTurn", amount: 1 });
  }

  // Leafeon Leaflet Blessings.
  {
    const m = text.match(
      /attach a basic ([A-Za-z]+) energy card from your hand to 1 of your benched pok[eé]mon\. if you do, heal all damage from that pok[eé]mon/i,
    );
    if (m) {
      const t = matchEnergyType(m[1]);
      if (t) effects.push({ kind: "attachBasicEnergyTypeToBenchAndHeal", energyType: t });
    }
  }

  // Chimecho Homeward Chime: "Shuffle 1 of your Benched Pokémon and all
  // attached cards into your deck."
  if (text.match(/shuffle 1 of your benched pok[eé]mon and all attached cards into your deck/i)) {
    effects.push({ kind: "shuffleOwnBenchPokemonIntoDeck" });
  }

  // Swirlix Sneaky Placement: "Put N damage counters on 1 of your
  // opponent's Pokémon."
  {
    const m = text.match(
      /^put (\d+) damage counters? on 1 of your opponent'?s pok[eé]mon\.?\s*$/im,
    );
    if (m) effects.push({ kind: "placeCountersOnOneOpp", counters: parseInt(m[1], 10) });
  }

  // Conkeldurr Gutsy Swing: "If this Pokémon is affected by a Special
  // Condition, ignore all Energy in this attack's cost."
  if (text.match(
    /if this pok[eé]mon is affected by a special condition,? ignore all energy in this attack'?s cost/i,
  )) {
    effects.push({ kind: "freeCostIfStatus" });
  }

  // Mega Heracross ex Juggernaut Horn: "If this Pokémon was damaged by an
  // attack during your opponent's last turn, this attack does that much
  // more damage."
  if (text.match(
    /if this pok[eé]mon was damaged by an attack during your opponent'?s last turn,? this attack does that much more damage/i,
  )) {
    effects.push({ kind: "damageEqualToDamageTakenLastTurn" });
  }

  // Cresselia Crescent Purge: "You may turn 1 of your face-down Prize
  // cards face up. If you do, this attack does N more damage."
  {
    const m = text.match(
      /you may turn 1 of your face-down prize cards face up\. if you do, this attack does (\d+) more damage/i,
    );
    if (m) effects.push({ kind: "autoOptionalBonus", bonus: parseInt(m[1], 10) });
  }

  // Iron Valiant Majestic Sword: "If you played a <subtype> Supporter
  // card from your hand during this turn, this attack does N more damage."
  {
    const m = text.match(
      /if you played a (Future|Ancient|Tera) supporter card from your hand during this turn,? this attack does (\d+) more damage/i,
    );
    if (m) {
      effects.push({
        kind: "ifPlayedSupporterSubtypeBonus",
        supporterSubtype: m[1],
        bonus: parseInt(m[2], 10),
      });
    }
  }

  // Hippowdon Super Sandstorm: "This attack also does N damage to each
  // Benched Pokémon that has any damage counters on it (both yours and
  // your opponent's)."
  {
    const m = text.match(
      /this attack also does (\d+) damage to each benched pok[eé]mon that has any damage counters on it/i,
    );
    if (m) effects.push({ kind: "alsoDamageBenchWithCounters", damage: parseInt(m[1], 10) });
  }

  // Team Rocket's Weezing Explode Together Now: "This attack does N
  // damage for each Pokémon in play that has '<X>' or '<Y>' in its name
  // (both yours and your opponent's)."
  {
    const m = text.match(
      /this attack does (\d+) damage for each pok[eé]mon in play that has "([^"]+)"\s+or "([^"]+)" in its name(?: \(both yours and your opponent'?s\))?/i,
    );
    if (m) {
      // Treat as a single combined namePart (will match either Koffing or
      // Weezing because contains-check is OR-able with two passes; we just
      // pick the first.)
      effects.push({
        kind: "perInPlayPokemonNamed",
        namePart: m[2],
        perCount: parseInt(m[1], 10),
        bothSides: true,
      });
      effects.push({
        kind: "perInPlayPokemonNamed",
        namePart: m[3],
        perCount: parseInt(m[1], 10),
        bothSides: true,
      });
    }
  }
  // Beedrill ex "Rumbling Bees": "This attack does N damage for each of
  // your Beedrill and Beedrill ex in play." (Same name modulo "ex" suffix
  // — collapses to one perInPlayPokemonNamed pass that case-insensitively
  // matches "Beedrill" since Beedrill ex's card name contains "Beedrill".)
  if (!effects.some((e) => e.kind === "perInPlayPokemonNamed")) {
    const m = text.match(
      /this attack does (\d+) damage for each of your ([A-Z][A-Za-z'’ -]+?) and \2 ex in play/i,
    );
    if (m) {
      effects.push({
        kind: "perInPlayPokemonNamed",
        namePart: m[2].trim(),
        perCount: parseInt(m[1], 10),
        bothSides: false,
      });
    }
  }
  // Mega Floette ex "Gentle Light": "Heal 30 damage from each Pokémon
  // (both yours and your opponent's)."
  {
    const m = text.match(
      /heal (\d+) damage from each pok[eé]mon\s*\(both yours and your opponent'?s\)/i,
    );
    if (m) effects.push({ kind: "healEachInPlayBothSides", amount: parseInt(m[1], 10) });
  }
  // Delphox "Energized Storm": "This attack does 30 damage for each
  // Energy attached to all Pokémon." Counts every Energy on every active
  // and benched Pokémon on both sides.
  {
    const m = text.match(
      /(\d+) damage for each ([A-Za-z]+ )?energy attached to all (?:of your )?pok[eé]mon/i,
    );
    if (m) {
      const t = m[2] ? matchEnergyType(m[2].trim()) : undefined;
      const ours = /attached to all of your pok[eé]mon/i.test(text);
      effects.push({
        kind: "perEnergyAcrossInPlay",
        perCount: parseInt(m[1], 10),
        energyType: t,
        side: ours ? "friendly" : "both",
      });
    }
  }
  // Mega Greninja ex "Ninja Spinner": "You may put a [W] Energy attached
  // to this Pokémon into your hand. If you do, this attack does 80 more
  // damage."
  {
    const m = text.match(
      /you may put a(?:n)? ([A-Za-z]+) energy attached to this pok[eé]mon into your hand\.?\s*if you do, this attack does (\d+) more damage/i,
    );
    if (m) {
      const t = matchEnergyType(m[1]);
      effects.push({
        kind: "optionalSelfTypedEnergyToHandForBonus",
        energyType: t ?? "Colorless",
        bonus: parseInt(m[2], 10),
      });
    }
  }
  // Metagross "Metallic Hammer": "You may discard 3 [M] Energy from this
  // Pokémon. If you do, this attack does 150 more damage." Optional
  // typed-energy discard for damage bonus.
  {
    const m = text.match(
      /you may discard (\d+) ([A-Za-z]+) energy from this pok[eé]mon\.?\s*if you do, this attack does (\d+) more damage/i,
    );
    if (m) {
      const t = matchEnergyType(m[2]);
      effects.push({
        kind: "optionalDiscardSelfEnergyForBonus",
        count: parseInt(m[1], 10),
        energyType: t,
        bonus: parseInt(m[3], 10),
      });
    }
  }
  // Trevenant "Cursed Root": "During your opponent's next turn, the
  // Defending Pokémon can't have Energy attached to it from your
  // opponent's hand."
  if (
    /during your opponent'?s next turn, the defending pok[eé]mon can'?t have energy attached to it from your opponent'?s hand/i.test(
      text,
    )
  ) {
    effects.push({ kind: "defenderCantBeAttachedNextTurn" });
  }
  // Gourgeist ex "Horror Rondo": "This attack does N more damage for
  // each of your Benched Pokémon that has any damage counters on it."
  {
    const m = text.match(
      /this attack does (\d+) more damage for each of your benched pok[eé]mon that has any damage counters? on it/i,
    );
    if (m) effects.push({ kind: "perDamagedFriendlyBench", perCount: parseInt(m[1], 10) });
  }
  // Mega Dragalge ex "Corrosive Liquid": "Discard all Pokémon Tools and
  // Special Energy from all of your opponent's Pokémon."
  if (
    /discard all pok[eé]mon tools and special energy from all of your opponent'?s pok[eé]mon/i.test(
      text,
    )
  ) {
    effects.push({ kind: "discardAllOppToolsAndSpecialEnergyAll" });
  }
  // Mega Dragalge ex "Pernicious Poison": "Your opponent's Active
  // Pokémon is now Poisoned. During Pokémon Checkup, place N damage
  // counters on that Pokémon instead of 1."
  {
    const m = text.match(
      /during pok[eé]mon checkup, place (\d+) damage counters? on that pok[eé]mon instead of 1/i,
    );
    if (m) effects.push({ kind: "applyHeavyPoison", counters: parseInt(m[1], 10) });
  }
  // Golisopod "Vital Slash": "If your opponent's Pokémon is Knocked Out
  // by damage from this attack, during your opponent's next turn, this
  // Pokémon takes no damage or effects from attacks."
  if (
    /if your opponent'?s pok[eé]mon is knocked out by damage from this attack, during your opponent'?s next turn, this pok[eé]mon takes no damage or effects from attacks/i.test(
      text,
    )
  ) {
    effects.push({ kind: "shieldNextTurnIfKoThisAttack" });
  }
  // Golbat "Covert Flight": "During your opponent's next turn, prevent
  // all damage done to this Pokémon by attacks from Basic Pokémon."
  // (Subtype-gated shield variant of shieldNextTurn.)
  if (
    /during your opponent'?s next turn, prevent all damage done to this pok[eé]mon by attacks from basic pok[eé]mon/i.test(
      text,
    )
  ) {
    // Avoid double-emit: the broad shieldNextTurn regex below will also
    // match this text. The subtype-gated variant takes precedence.
    effects.push({ kind: "selfShieldNextTurnFromSubtype", subtype: "Basic" });
  }
  // Deoxys "Psy Protect": "During your opponent's next turn, this
  // Pokémon takes no damage from attacks from your opponent's Pokémon
  // that have any Abilities." (Ability-gated shield variant.)
  if (
    /during your opponent'?s next turn, this pok[eé]mon takes no damage from attacks from your opponent'?s pok[eé]mon that have any abilities/i.test(
      text,
    )
  ) {
    effects.push({ kind: "selfShieldNextTurnFromAbility" });
  }
  // Watchog "Snipe Check": "Flip 3 coins. For each heads, look at your
  // opponent's hand, choose a card, and put it on top of your opponent's
  // deck. Then, your opponent shuffles their deck."
  {
    const m = text.match(
      /flip (\d+) coins?\. for each heads,? look at your opponent'?s hand,? choose a card,? and put it on top of your opponent'?s deck/i,
    );
    if (m) {
      effects.push({
        kind: "multiCoinPickFromOppHandToTopDeck",
        coins: parseInt(m[1], 10),
      });
    }
  }
  // Tauros "Target Together": "Choose 1 of your opponent's Pokémon, and
  // flip a coin for each of your Pokémon that has <Name> in its name.
  // This attack does N damage to the Pokémon you chose for each heads."
  {
    const m = text.match(
      /choose 1 of your opponent'?s pok[eé]mon,? and flip a coin for each of your pok[eé]mon that has ([A-Za-z'’ -]+?) in its name\.?\s*this attack does (\d+) damage to the pok[eé]mon you chose for each heads/i,
    );
    if (m) {
      effects.push({
        kind: "perNamedAllyCoinDamageChosen",
        namePart: m[1].trim(),
        damagePerHeads: parseInt(m[2], 10),
      });
    }
  }
  // Claydol "Devolution Ray": "If your opponent's Active Pokémon is an
  // evolved Pokémon, devolve it by putting the highest Stage Evolution
  // card on it into your opponent's hand." Reuses devolveOneOppToHand.
  if (
    /if your opponent'?s active pok[eé]mon is an evolved pok[eé]mon, devolve it by putting the highest stage evolution card on it into your opponent'?s hand/i.test(
      text,
    )
  ) {
    if (!effects.some((eft) => eft.kind === "devolveOneOppToHand")) {
      effects.push({ kind: "devolveOneOppToHand" });
    }
  }
  // Crobat "Poison Sound Wave": "Your opponent's Active Pokémon is now
  // Confused and Poisoned." (Dual-status; the single-status regex earlier
  // only catches one. Add a second status if matched.)
  {
    const m = text.match(
      /your opponent'?s active pok[eé]mon is now (asleep|burned|confused|paralyzed|poisoned) and (asleep|burned|confused|paralyzed|poisoned)/i,
    );
    if (m) {
      const s1 = STATUS_FROM_TEXT[m[1].toLowerCase()];
      const s2 = STATUS_FROM_TEXT[m[2].toLowerCase()];
      // Replace the existing single-status push (if any) with both.
      const existingIdx = effects.findIndex(
        (e) => e.kind === "applyStatus" && e.target === "defender",
      );
      if (existingIdx >= 0) effects.splice(existingIdx, 1);
      if (s1) effects.push({ kind: "applyStatus", status: s1, target: "defender" });
      if (s2) effects.push({ kind: "applyStatus", status: s2, target: "defender" });
    }
  }
  // Octillery "Ink Jet": "During your opponent's next turn, if the
  // Defending Pokémon tries to use an attack, your opponent flips 2
  // coins. If either of them is tails, that attack doesn't happen."
  // Variant of defenderAttackCoinFlipNextTurn (single-coin) with N coins
  // and "any tails" failure.
  {
    const m = text.match(
      /during your opponent'?s next turn, if the defending pok[eé]mon tries to use an attack, your opponent flips (\d+) coins?\. if (?:either of them|any of them|all of them) (?:is|are) tails, that attack doesn'?t happen/i,
    );
    if (m && !effects.some((e) => e.kind === "defenderAttackCoinFlipNextTurn")) {
      effects.push({ kind: "defenderAttackCoinFlipNextTurn" });
      // Note: we treat the multi-coin variant as a stricter single-coin gate.
      // The 2-coin variant has ~75% fail rate vs single's 50%; engine will
      // simulate as a single coin (slightly under-models the lockout). Good
      // enough for now; flag for later refinement.
    }
  }
  // Espurr "Buddy Attack": "If you played Tomes of Transformation from
  // your hand during this turn, this attack does 60 more damage."
  {
    const m = text.match(
      /if you played ([A-Z][A-Za-z'’ -]+?) from your hand during this turn,? this attack does (\d+) more damage/i,
    );
    if (m && !effects.some((e) => e.kind === "conditionalDamage")) {
      effects.push({
        kind: "conditionalDamage",
        bonus: parseInt(m[2], 10),
        mode: "bonus",
        predicate: { kind: "playedNamedItemThisTurn", namePart: m[1].trim() },
      });
    }
  }
  // Ferrothorn "Special Whip": "If this Pokémon has any Special Energy
  // attached, this attack does 70 more damage."
  {
    const m = text.match(
      /if this pok[eé]mon has any special energy attached,? this attack does (\d+) more damage/i,
    );
    if (m && !effects.some((e) => e.kind === "conditionalDamage")) {
      effects.push({
        kind: "conditionalDamage",
        bonus: parseInt(m[1], 10),
        mode: "bonus",
        predicate: { kind: "selfHasSpecialEnergy" },
      });
    }
  }
  // Deoxys (32) "Psy Spear": "If this Pokémon has at least 2 extra
  // Energy attached (in addition to this attack's cost), this attack
  // also does 120 damage to 1 of your opponent's Benched Pokémon."
  {
    const m = text.match(
      /if this pok[eé]mon has at least (\d+) extra energy attached[^.]*?this attack also does (\d+) damage to 1 of your opponent'?s benched pok[eé]mon/i,
    );
    if (m) {
      effects.push({
        kind: "conditionalSnipeBench",
        extraEnergy: parseInt(m[1], 10),
        damage: parseInt(m[2], 10),
      });
    }
  }

  // ---- Pokémon ex bespoke attacks ----

  // Persian ex Haughty Order: "Reveal the top N cards of your opponent's
  // deck. You may choose an attack from a Pokémon you find there and use
  // it as this attack. Shuffle the revealed cards into your opponent's
  // deck."
  {
    const m = text.match(
      /reveal the top (\d+) cards? of your opponent'?s deck\. you may choose an attack from a pok[eé]mon you find there and use it as this attack/i,
    );
    if (m) effects.push({ kind: "useAttackFromOppDeckTop", revealCount: parseInt(m[1], 10) });
  }

  // Ninetales me1-20 Supernatural Shapeshifter: "Discard the top card of
  // your deck, and if that card is a Supporter card, use the effect of
  // that card as the effect of this attack."
  if (
    text.match(
      /discard the top card of your deck,? and if that card is a supporter card,? use the effect of that card as the effect of this attack/i,
    )
  ) {
    effects.push({ kind: "discardTopOfOwnDeckUseSupporterEffect" });
  }

  // Team Rocket's Grimer sv10-123 Corrosive Sludge: "At the end of your
  // opponent's next turn, discard the Defending Pokémon and all attached
  // cards."
  if (
    text.match(
      /at the end of your opponent'?s next turn,? discard the defending pok[eé]mon and all attached cards/i,
    )
  ) {
    effects.push({ kind: "discardDefenderEndOfOppNextTurn" });
  }

  // Scream Tail ex Scream: "...your opponent can't play any Supporter cards
  // from their hand during their next turn." (Engine doesn't separately
  // gate "go second + first turn"; the predicate is enforced by the player
  // — they simply won't be able to attack on T1 unless the rules allow.)
  if (text.match(/your opponent can'?t play any supporter cards? from their hand during their next turn/i)) {
    effects.push({ kind: "blockOppSupportersNextTurn" });
  }

  // Lapras ex Larimar Rain: "Look at the top N cards of your deck and
  // attach any number of Energy cards you find there to your Pokémon in
  // any way you like. Shuffle the other cards back into your deck."
  {
    const m = text.match(
      /look at the top (\d+) cards? of your deck and attach any number of energy cards? you find there to your pok[eé]mon in any way you like/i,
    );
    if (m) effects.push({ kind: "topNAttachAnyEnergyToOwn", count: parseInt(m[1], 10) });
  }

  // Palossand ex Barite Jail: "Put damage counters on each of your
  // opponent's Benched Pokémon until its remaining HP is N."
  {
    const m = text.match(
      /put damage counters? on each of your opponent'?s benched pok[eé]mon until its remaining hp is (\d+)/i,
    );
    if (m) effects.push({ kind: "fillOppBenchUntilHpN", targetHp: parseInt(m[1], 10) });
  }

  // Alolan Exeggutor ex Swinging Sphene: "Flip a coin. If heads, Knock Out
  // your opponent's Active Basic Pokémon. If tails, Knock Out 1 of your
  // opponent's Benched Basic Pokémon."
  if (
    text.match(
      /flip a coin\. if heads, knock out your opponent'?s active basic pok[eé]mon\. if tails, knock out 1 of your opponent'?s benched basic pok[eé]mon/i,
    )
  ) {
    effects.push({ kind: "flipKoOppActiveOrBenchedBasic" });
  }

  // Leafeon ex Moss Agate: "Heal N damage from each of your Benched
  // Pokémon."
  {
    const m = text.match(/heal (\d+) damage from each of your benched pok[eé]mon/i);
    if (m) effects.push({ kind: "healEachOwnBench", amount: parseInt(m[1], 10) });
  }

  // Flareon ex Burning Charge: "Search your deck for up to N Basic Energy
  // cards and attach them to 1 of your Pokémon."
  {
    const m = text.match(
      /search your deck for up to (\d+) basic energy cards? and attach them to 1 of your pok[eé]mon/i,
    );
    if (m) effects.push({ kind: "searchBasicEnergyAttachOneN", max: parseInt(m[1], 10) });
  }

  // Glaceon ex Euclase: "Knock Out 1 of your opponent's Pokémon that has
  // exactly N damage counters on it."
  {
    const m = text.match(
      /knock out 1 of your opponent'?s pok[eé]mon that has exactly (\d+) damage counters on it/i,
    );
    if (m) effects.push({ kind: "koOppAnyWithExactlyDamageCounters", counters: parseInt(m[1], 10) });
  }

  // Espeon ex Amazez: "Devolve each of your opponent's evolved Pokémon by
  // shuffling the highest Stage Evolution card on it into your opponent's
  // deck."
  if (
    text.match(
      /devolve each of your opponent'?s evolved pok[eé]mon by shuffling the highest stage evolution card on it into your opponent'?s deck/i,
    )
  ) {
    effects.push({ kind: "devolveAllOppEvolvedToDeck" });
  }

  // Veluza ex Purging Strike: "You may discard your hand. If you discarded
  // any cards in this way, this attack does N more damage."
  {
    const m = text.match(
      /you may discard your hand\. if you discarded any cards in this way, this attack does (\d+) more damage/i,
    );
    if (m) effects.push({ kind: "optionalDiscardHandForBonus", bonus: parseInt(m[1], 10) });
  }

  // Mimikyu ex Mischievous Hands: "Choose N of your opponent's Pokémon and
  // put M damage counters on each of them."
  {
    const m = text.match(
      /choose (\d+) of your opponent'?s pok[eé]mon and put (\d+) damage counters? on each of them/i,
    );
    if (m) {
      effects.push({
        kind: "placeCountersOnNOpp",
        targetCount: parseInt(m[1], 10),
        counters: parseInt(m[2], 10),
      });
    }
  }


  // Mamoswine ex Rumbling March: "This attack does N more damage for each
  // Stage 2 Pokémon on your Bench."
  {
    const m = text.match(
      /this attack does (\d+) more damage for each (Stage [12]) pok[eé]mon on your bench/i,
    );
    if (m) {
      effects.push({
        kind: "perOwnBenchSubtype",
        subtype: m[2],
        perCount: parseInt(m[1], 10),
      });
    }
  }

  // ---- Final omnibus batch (remaining type-attack patterns) ----

  // N's Sigilyph Victory Symbol: "If you use this attack when you have
  // exactly N Prize cards remaining, you win this game."
  {
    const m = text.match(/you win this game/i);
    if (m) {
      const m2 = text.match(/you have exactly (\d+) prize cards? remaining/i);
      if (m2) effects.push({ kind: "winGameIfPrizesEquals", prizes: parseInt(m2[1], 10) });
    }
  }

  // Annihilape Destined Fight: "Both Active Pokémon are Knocked Out."
  if (text.match(/both active pok[eé]mon are knocked out/i)) {
    effects.push({ kind: "bothActiveKnockedOut" });
  }

  // Iron Valiant Calculation: "Look at the top N cards of your deck and put
  // them back in any order."
  {
    const m = text.match(
      /look at the top (\d+) cards? of your deck and put them back in any order/i,
    );
    if (m) effects.push({ kind: "peekOwnDeckTop", count: parseInt(m[1], 10) });
  }

  // Hop's Silicobra Turf Maker: "Search your deck for a Stadium card,
  // reveal it, and put it into your hand."
  if (text.match(/search your deck for a stadium card,? reveal it,? and put it into your hand/i)) {
    effects.push({ kind: "searchStadiumToHand" });
  }

  // Dedenne Electromagnetic Sonar: "Put a Trainer card from your discard
  // pile into your hand."
  if (text.match(/^put a trainer card from your discard pile into your hand\.?\s*$/im)) {
    effects.push({ kind: "recoverTrainerFromDiscardToHand" });
  }

  // Wooper Scoop Water: "Shuffle up to N Basic <Type> Energy cards from
  // your discard pile into your deck."
  {
    const m = text.match(
      /shuffle up to (\d+) basic ([A-Za-z]+) energy cards? from your discard pile into your deck/i,
    );
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) effects.push({ kind: "shuffleBasicEnergyDiscardToDeck", max: parseInt(m[1], 10), energyType: t });
    }
  }

  // Fraxure Dragon Pulse: "Discard the top N cards of your deck." Also
  // handles the singular "Discard the top card of your deck." form.
  {
    const m = text.match(/^discard the top (?:(\d+) cards?|card) of your deck\.?$/im);
    if (m) effects.push({ kind: "millOwnDeck", count: m[1] ? parseInt(m[1], 10) : 1 });
  }

  // Quagsire Drenched Headbutt: "Discard the top N cards of your deck.
  // This attack does M damage for each Energy card you discarded in this way."
  {
    const m = text.match(
      /discard the top (\d+) cards? of your deck\.\s*this attack does (\d+) damage for each energy card you discarded in this way/i,
    );
    if (m) {
      effects.push({
        kind: "discardTopNAndDamagePerEnergy",
        topN: parseInt(m[1], 10),
        perCount: parseInt(m[2], 10),
      });
    }
  }

  // Yveltal Corrosive Winds.
  {
    const m = text.match(
      /put (\d+) damage counters? on each of your opponent'?s pok[eé]mon that has any damage counters on it/i,
    );
    if (m) effects.push({ kind: "countersOnEachDamagedOpp", counters: parseInt(m[1], 10) });
  }

  // Uxie Painful Memories.
  {
    const m = text.match(
      /^put (\d+) damage counters? on each of your opponent'?s pok[eé]mon\.?\s*$/im,
    );
    if (m) effects.push({ kind: "countersOnEachOpp", counters: parseInt(m[1], 10) });
  }

  // Cofagrigus Law of the Underworld.
  {
    const m = text.match(
      /put (\d+) damage counters? on each pok[eé]mon that has an ability \(both yours and your opponent'?s\)/i,
    );
    if (m) effects.push({ kind: "countersOnEachWithAbility", counters: parseInt(m[1], 10) });
  }

  // Duosion Cellular Evolution.
  if (
    text.match(
      /search your deck for a card that evolves from 1 of your pok[eé]mon and put it onto that pok[eé]mon to evolve it/i,
    )
  ) {
    effects.push({ kind: "searchAndEvolveOne" });
  }

  // Lillie's Comfey Inviting Flowers.
  {
    const m = text.match(
      /you may search your deck for any number of basic ([A-Z][A-Za-z'’ -]+?) pok[eé]mon and put them onto your bench/i,
    );
    if (m) effects.push({ kind: "searchAnyBasicNamedToBench", namePart: m[1].trim() });
  }

  // Smoochum Delightful Kiss.
  {
    const m = text.match(
      /search your deck for up to (\d+) basic ([A-Za-z]+) energy cards? and attach them to 1 of your benched pok[eé]mon/i,
    );
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) effects.push({ kind: "searchBasicEnergyTypeAttachOneBench", energyType: t, max: parseInt(m[1], 10) });
    }
  }

  // Mesprit Full Heart.
  {
    const m = text.match(
      /attach up to (\d+) basic ([A-Za-z]+) energy cards? from your hand to your pok[eé]mon in any way you like/i,
    );
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) effects.push({ kind: "attachBasicEnergyTypeFromHandN", energyType: t, max: parseInt(m[1], 10) });
    }
  }

  // Azelf Neurokinesis: "This attack does N more damage for each damage
  // counter on all of your opponent's Pokémon."
  {
    const m = text.match(
      /this attack does (\d+) more damage for each damage counter on all of your opponent'?s pok[eé]mon/i,
    );
    if (m) effects.push({ kind: "perDamageCounterOnAllOpp", perCount: parseInt(m[1], 10) });
  }

  // Kilowattrel Wind Power Charge.
  {
    const m = text.match(
      /during your next turn, attacks used by this pok[eé]mon do (\d+) more damage to your opponent'?s active pok[eé]mon/i,
    );
    if (m) effects.push({ kind: "selfNextTurnAllAttacksBonus", bonus: parseInt(m[1], 10) });
  }

  // Hypno Daydream.
  if (
    text.match(
      /during your opponent'?s next turn, if they attach an energy card from their hand to the defending pok[eé]mon, their turn ends/i,
    )
  ) {
    effects.push({ kind: "oppEnergyAttachEndsTurn" });
  }

  // Vibrava Screech.
  {
    const m = text.match(
      /during your next turn, the defending pok[eé]mon takes (\d+) more damage from attacks/i,
    );
    if (m) effects.push({ kind: "defenderTakesMoreNextTurn", bonus: parseInt(m[1], 10) });
  }

  // Electivire Unleash Lightning: "During your next turn, your Pokémon
  // can't attack."
  if (text.match(/during your next turn, your pok[eé]mon can'?t attack/i)) {
    effects.push({ kind: "lockOwnAttackersNextTurn" });
  }

  // Walrein Frigid Fangs: "During your opponent's next turn, Pokémon that
  // have N or less Energy attached can't attack."
  {
    const m = text.match(
      /during your opponent'?s next turn, pok[eé]mon that have (\d+) or less energy attached can'?t attack/i,
    );
    if (m) effects.push({ kind: "lockOppLowEnergyAttackersNextTurn", maxEnergy: parseInt(m[1], 10) });
  }

  // Iron Bundle Gusting Collision.
  {
    const m = text.match(
      /this attack does (\d+) less damage for each colorless in your opponent'?s active pok[eé]mon'?s retreat cost/i,
    );
    if (m && !effects.some((eft) => eft.kind === "damageReducedPerEnergyOnDefender")) {
      effects.push({
        kind: "damageReducedPerColorlessOnDefenderRetreat",
        perCount: parseInt(m[1], 10),
      });
    }
  }

  // Miraidon C.O.D.E.: Protect.
  {
    const m = text.match(
      /prevent all damage done to each of your ([A-Za-z]+) pok[eé]mon by attacks from pok[eé]mon ex/i,
    );
    if (m) effects.push({ kind: "protectSubtypeFromExNextTurn", subtype: m[1].trim() });
  }

  // Ribombee Plentiful Pollen.
  {
    const m = text.match(
      /during your next turn, if the defending pok[eé]mon is knocked out,? take (\d+) more prize cards?/i,
    );
    if (m) effects.push({ kind: "bonusPrizesIfDefenderKoNextTurn", bonus: parseInt(m[1], 10) });
  }

  // Tirtouga Ancient Seaweed.
  {
    const m = text.match(
      /this attack does (\d+) damage for each item card in your opponent'?s discard pile/i,
    );
    if (m) effects.push({ kind: "perItemInOppDiscard", perCount: parseInt(m[1], 10) });
  }

  // Octillery Aqua Wash.
  if (
    text.match(
      /you may put an energy attached to your opponent'?s active pok[eé]mon into their hand/i,
    )
  ) {
    effects.push({ kind: "bounceOppActiveEnergyToOppHand", count: 1 });
  }

  // Paldean Tauros (Water) Upthrusting Horns: "You may put N Energy attached
  // to your opponent's Active Stage 2 Pokémon into their hand."
  {
    const m = text.match(
      /you may put (\d+) energy attached to your opponent'?s active (stage [12]) pok[eé]mon into their hand/i,
    );
    if (m) {
      effects.push({
        kind: "bounceOppActiveEnergyToOppHand",
        count: parseInt(m[1], 10),
        defenderSubtype: m[2].replace(/\s/, " ").replace(/(\w)(\w+)/, (_x, a, b) => a.toUpperCase() + b),
      });
    }
  }

  // Espathra Mystical Eyes: "Devolve 1 of your opponent's evolved Pokémon
  // by putting the highest Stage Evolution card on it into your opponent's
  // hand."
  if (
    text.match(
      /devolve 1 of your opponent'?s evolved pok[eé]mon by putting the highest stage evolution card on it into your opponent'?s hand/i,
    )
  ) {
    effects.push({ kind: "devolveOneOppToHand" });
  }

  // Flutter Mane Perplexing Transfer.
  {
    const m = text.match(
      /move all damage counters from 1 of your benched (Ancient|Future|Tera) pok[eé]mon to your opponent'?s active pok[eé]mon/,
    );
    if (m) effects.push({ kind: "moveAllBenchDamageBySubtypeToOppActive", subtype: m[1] });
  }

  // Paldean Tauros (Fighting) Blocking Stomp.
  {
    const m = text.match(
      /if the defending pok[eé]mon is a (basic|stage 1|stage 2) pok[eé]mon, it can'?t attack during your opponent'?s next turn/i,
    );
    if (m) {
      const sub = m[1].toLowerCase() === "basic" ? "Basic" : m[1].toLowerCase() === "stage 1" ? "Stage 1" : "Stage 2";
      effects.push({ kind: "defenderOfSubtypeCantAttackNextTurn", subtype: sub });
    }
  }

  // Zoroark Illusory Hijacking.
  {
    const m = text.match(
      /this attack does (\d+) damage for each of your opponent'?s pok[eé]mon ex and pok[eé]mon v in play/i,
    );
    if (m) effects.push({ kind: "perOppPokemonExOrV", perCount: parseInt(m[1], 10) });
  }

  // Ceruledge Cursed Edge: "Discard all Special Energy from all of your
  // opponent's Pokémon."
  if (text.match(/discard all special energy from all of your opponent'?s pok[eé]mon/i)) {
    effects.push({ kind: "discardAllOppSpecialEnergy" });
  }

  // Melmetal Reforged Axe.
  if (
    text.match(
      /before doing damage, discard all pok[eé]mon tools from this pok[eé]mon\. if you can'?t discard any, this attack does nothing/i,
    )
  ) {
    effects.push({ kind: "discardOwnToolsOrFizzle" });
  }

  // Grafaiai Mischievous Painting.
  {
    const m = text.match(
      /attach up to (\d+) energy cards? from your opponent'?s discard pile to their pok[eé]mon in any way you like/i,
    );
    if (m) effects.push({ kind: "attachOppDiscardEnergyToOpp", max: parseInt(m[1], 10) });
  }

  // Comfey Flower Shower.
  {
    const m = text.match(/each player draws (\d+) cards?/i);
    if (m) effects.push({ kind: "eachPlayerDrawsN", count: parseInt(m[1], 10) });
  }

  // Gholdengo All-You-Can-Grab.
  if (
    text.match(
      /flip a coin until you get tails\. search your deck for a number of cards up to the number of heads and put them into your hand/i,
    )
  ) {
    effects.push({ kind: "flipUntilTailsSearchToHand" });
  }

  // TR Mimikyu Gemstone Mimicry.
  if (
    text.match(
      /choose 1 of your opponent'?s active tera pok[eé]mon's attacks and use it as this attack/i,
    )
  ) {
    effects.push({ kind: "useOppActiveAttackOfSubtype", subtype: "Tera" });
  }

  // TR Nidorina Dark Awakening: "Choose up to N of your <Type> Pokémon.
  // For each of those Pokémon, search your deck for a card that evolves
  // from that Pokémon and put it onto that Pokémon to evolve it."
  {
    const m = text.match(
      /choose up to (\d+) of your ([A-Za-z]+) pok[eé]mon\. for each of those pok[eé]mon, search your deck for a card that evolves from that pok[eé]mon and put it onto that pok[eé]mon to evolve it/i,
    );
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) effects.push({ kind: "searchAndEvolveNamedTypePokemon", energyType: t, max: parseInt(m[1], 10) });
    }
  }

  // Zamazenta Strong Bash.
  if (
    text.match(
      /during your opponent'?s next turn, if this pok[eé]mon is damaged by an attack[^.]*put damage counters on the attacking pok[eé]mon equal to the damage done to this pok[eé]mon/i,
    )
  ) {
    effects.push({ kind: "counterAttackerEqualToTakenNextTurn" });
  }

  // Dialga Time Manipulation: "Search your deck for 2 cards, shuffle your
  // deck, then put those cards on top of it in any order."
  if (
    text.match(
      /search your deck for 2 cards, shuffle your deck, then put those cards on top of it in any order/i,
    )
  ) {
    effects.push({ kind: "searchAndTopdeckTwo" });
  }

  // Landorus Fist of Focus: "Attach an Energy card from your discard pile
  // to this Pokémon."
  if (text.match(/^attach an energy card from your discard pile to this pok[eé]mon\.?$/im)) {
    effects.push({ kind: "attachAnyEnergyDiscardToSelf" });
  }

  // Druddigon Dragon's Fury: "Attach a Basic <Type> Energy card from your
  // discard pile to 1 of your <Type-of-Pokémon> Pokémon."
  {
    const m = text.match(
      /attach a basic ([A-Za-z]+) energy card from your discard pile to 1 of your ([A-Za-z]+) pok[eé]mon/i,
    );
    if (m) {
      const te = matchEnergyType(m[1]);
      const tp = matchEnergyType(m[2]);
      if (te && tp) {
        effects.push({ kind: "attachBasicEnergyDiscardToTypePokemon", energyType: te, pokemonType: tp });
      }
    }
  }

  // Raichu Collateral Bolts.
  {
    const m = text.match(
      /this attack does (\d+) damage to each pok[eé]mon that has any damage counters on it \(both yours and your opponent'?s\), except for this pok[eé]mon/i,
    );
    if (m) effects.push({ kind: "damageEachWithCountersExceptSelf", damage: parseInt(m[1], 10) });
  }

  // Drifblim Everyone Explode Now: "This attack does N damage for each of
  // your <X> and <Y> in play. This attack also does M damage to each of
  // your <X> and <Y>."
  {
    const m = text.match(
      /this attack does (\d+) damage for each of your ([A-Z][A-Za-z'’ -]+?) and ([A-Z][A-Za-z'’ -]+?) in play\. this attack also does (\d+) damage to each of your/i,
    );
    if (m) {
      effects.push({
        kind: "perNamedInPlayWithSelfDamage",
        namePart: m[2].trim(),
        perCount: parseInt(m[1], 10),
        selfDamage: parseInt(m[4], 10),
      });
      effects.push({
        kind: "perNamedInPlayWithSelfDamage",
        namePart: m[3].trim(),
        perCount: parseInt(m[1], 10),
        selfDamage: parseInt(m[4], 10),
      });
    }
  }

  // Inkay Mischievous Tentacles: "Look at the top card of your opponent's
  // deck. You may have your opponent shuffle their deck." — info-only;
  // recognized as wired. We model it as peekOppDeckTop with count=1.
  if (
    text.match(
      /look at the top card of your opponent'?s deck\. you may have your opponent shuffle their deck/i,
    )
  ) {
    effects.push({ kind: "peekOppDeckTop", count: 1 });
  }

  // Grafaiai Miraculous Paint: "Flip a coin. If heads, choose a Special
  // Condition. Your opponent's Active Pokémon is now affected by that
  // Special Condition."
  if (
    text.match(
      /flip a coin\. if heads, choose a special condition\. your opponent'?s active pok[eé]mon is now affected by that special condition/i,
    )
  ) {
    effects.push({ kind: "flipChooseStatusOpp" });
  }

  // Slowking Seek Inspiration.
  if (
    text.match(
      /discard the top card of your deck, and if that card is a pok[eé]mon that doesn'?t have a rule box, choose 1 of its attacks and use it as this attack/i,
    )
  ) {
    effects.push({ kind: "discardTopUsePokemonNoRuleBoxAttack" });
  }

  // Musharna Dream Calling.
  {
    const m = text.match(
      /you may search your deck for any number of ([A-Z][A-Za-z'’ -]+?) cards?, reveal them,? and put them into your hand/i,
    );
    if (m) effects.push({ kind: "searchAnyNamedTrainerToHand", namePart: m[1].trim() });
  }

  // Elgyem Slight Shift.
  if (
    text.match(/move an energy from 1 of your opponent'?s pok[eé]mon to another of their pok[eé]mon/i)
  ) {
    effects.push({ kind: "moveOppEnergyAcrossOpp" });
  }

  // Pachirisu Crackling Charge: "Flip N coins. Attach a number of Basic
  // <Type> Energy cards up to the number of heads from your discard pile
  // to your Benched Pokémon in any way you like."
  {
    const m = text.match(
      /flip (\d+) coins?\. attach a number of basic ([A-Za-z]+) energy cards? up to the number of heads from your discard pile to your benched pok[eé]mon/i,
    );
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) {
        effects.push({
          kind: "flipNAttachBasicTypeFromDiscardToBench",
          coins: parseInt(m[1], 10),
          energyType: t,
        });
      }
    }
  }

  // Miraidon Peak Acceleration: "Search your deck for up to N Basic Energy
  // cards and attach them to your <Subtype> Pokémon in any way you like."
  {
    const m = text.match(
      /search your deck for up to (\d+) basic energy cards? and attach them to your (Future|Ancient|Tera|Mega) pok[eé]mon/i,
    );
    if (m) {
      effects.push({
        kind: "searchBasicEnergyAttachSubtype",
        max: parseInt(m[1], 10),
        subtype: m[2],
      });
    }
  }

  // Sandile Tighten Up: "Your opponent discards a card from their hand."
  if (
    text.match(/^your opponent discards a card from their hand\.?\s*$/im) &&
    !effects.some((eft) => eft.kind === "oppDiscardsHand")
  ) {
    effects.push({ kind: "oppDiscardsHand", count: 1 });
  }

  // Predicate-based bonus / fizzle attacks (route through the existing
  // conditionalDamage detector by matching an "if X, this attack does N..."
  // shape; the predicate parser handles X). For these we pre-extend the
  // predicate parser via predicate aliases above.

  // Sableye Cocky Claw — Stage-2-Bench-of-Type predicate.
  {
    const m = text.match(
      /if you have any (Stage [12]) ([A-Za-z]+) pok[eé]mon on your bench,? this attack does (\d+) more damage/i,
    );
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) {
        effects.push({
          kind: "conditionalDamage",
          bonus: parseInt(m[3], 10),
          mode: "bonus",
          predicate: { kind: "youHaveBenchPokemonOfTypeAndSubtype", energyType: t, subtype: m[1] },
        });
      }
    }
  }

  // Ho-Oh Shining Blaze — bench-subtype predicate.
  {
    const m = text.match(
      /if you have any (Tera|Future|Ancient|Mega) pok[eé]mon on your bench,? this attack does (\d+) more damage/i,
    );
    if (m) {
      effects.push({
        kind: "conditionalDamage",
        bonus: parseInt(m[2], 10),
        mode: "bonus",
        predicate: { kind: "youHaveBenchPokemonOfSubtype", subtype: m[1] },
      });
    }
  }

  // Electivire Short-Circuit Knuckle.
  // Slither Wing Iron Smasher.
  {
    const m = text.match(
      /if your opponent has any ([A-Za-z]+) pok[eé]mon in play,? this attack does (\d+) more damage/i,
    );
    if (m) {
      const subtypes = ["Future", "Ancient", "Tera", "Mega"];
      const lowered = m[1].toLowerCase();
      if (subtypes.map((s) => s.toLowerCase()).includes(lowered)) {
        effects.push({
          kind: "conditionalDamage",
          bonus: parseInt(m[2], 10),
          mode: "bonus",
          predicate: { kind: "oppHasPokemonOfSubtype", subtype: subtypes[subtypes.map((s) => s.toLowerCase()).indexOf(lowered)] },
        });
      } else {
        const t = matchEnergyType(m[1]);
        if (t) {
          effects.push({
            kind: "conditionalDamage",
            bonus: parseInt(m[2], 10),
            mode: "bonus",
            predicate: { kind: "oppHasPokemonOfType", energyType: t },
          });
        }
      }
    }
  }

  // Mienshao Gale Roundhouse: opp hand size.
  {
    const m = text.match(
      /if your opponent has (\d+) or fewer cards in their hand,? this attack does (\d+) more damage/i,
    );
    if (m) {
      effects.push({
        kind: "conditionalDamage",
        bonus: parseInt(m[2], 10),
        mode: "bonus",
        predicate: { kind: "oppHandSizeAtMost", count: parseInt(m[1], 10) },
      });
    }
  }

  // Krookodile Cursed Slug — same predicate.
  // (Already covered by the above pattern.)

  // Swalot Devouring Mouth: more energy than defender.
  {
    const m = text.match(
      /if this pok[eé]mon has more energy attached than your opponent'?s active pok[eé]mon,? this attack does (\d+) more damage/i,
    );
    if (m) {
      effects.push({
        kind: "conditionalDamage",
        bonus: parseInt(m[1], 10),
        mode: "bonus",
        predicate: { kind: "selfHasMoreEnergyThanDefender" },
      });
    }
  }

  // Enamorus Love Resonance.
  {
    const m = text.match(
      /if any of your pok[eé]mon in play are the same type as any of your opponent'?s pok[eé]mon in play,? this attack does (\d+) more damage/i,
    );
    if (m) {
      effects.push({
        kind: "conditionalDamage",
        bonus: parseInt(m[1], 10),
        mode: "bonus",
        predicate: { kind: "typeMatchesAnyOppPokemon" },
      });
    }
  }

  // Metagross Conjoined Beams.
  {
    const m = text.match(
      /if ([A-Z][A-Za-z'’ -]+?) and ([A-Z][A-Za-z'’ -]+?) are on your bench,? this attack does (\d+) more damage/i,
    );
    if (m) {
      effects.push({
        kind: "conditionalDamage",
        bonus: parseInt(m[3], 10),
        mode: "bonus",
        predicate: { kind: "hasBothNamedOnBench", nameA: m[1].trim(), nameB: m[2].trim() },
      });
    }
  }

  // Iron Crown Deleting Slash.
  {
    const m = text.match(
      /if your opponent has (\d+) or more benched pok[eé]mon,? this attack does (\d+) more damage/i,
    );
    if (m) {
      effects.push({
        kind: "conditionalDamage",
        bonus: parseInt(m[2], 10),
        mode: "bonus",
        predicate: { kind: "oppBenchAtLeast", count: parseInt(m[1], 10) },
      });
    }
  }

  // Koraidon Unrelenting Onslaught.
  {
    const m = text.match(
      /if 1 of your other (Ancient|Future|Tera|Mega) pok[eé]mon used an attack during your last turn,? this attack does (\d+) more damage/i,
    );
    if (m) {
      effects.push({
        kind: "conditionalDamage",
        bonus: parseInt(m[2], 10),
        mode: "bonus",
        predicate: { kind: "anyAllyOfSubtypeUsedAttackLastTurn", subtype: m[1] },
      });
    }
  }

  // Medicham Seventh Kick / Alolan Dugtrio Trio-Cheehoo: "If you don't have
  // exactly N cards in your hand, this attack does nothing."
  {
    const m = text.match(
      /if you don'?t have exactly (\d+) cards in your hand,? this attack does nothing/i,
    );
    if (m) {
      effects.push({
        kind: "conditionalDamage",
        bonus: 0,
        mode: "fizzleIfNot",
        predicate: { kind: "yourHandSizeEquals", count: parseInt(m[1], 10) },
      });
    }
  }

  // Sandile Tighten Up: "Your opponent discards a card from their hand."
  // Already detected by the existing `oppDiscardsHand` regex. Skip.

  // Grimmsnarl / Throh — perColorless variants. (Throh is "less damage";
  // already covered above. Grimmsnarl is "for each Colorless" with
  // damage="50" base dmg, additive.)
  {
    const m = text.match(
      /this attack does (\d+) damage for each colorless in your opponent'?s active pok[eé]mon'?s retreat cost/i,
    );
    if (m && !effects.some((eft) => eft.kind === "perColorlessOnDefenderRetreat")) {
      effects.push({
        kind: "perColorlessOnDefenderRetreat",
        perCount: parseInt(m[1], 10),
      });
    }
  }

  // ---- Grass Pokémon attacks ----

  // Dartrix United Wings: "This attack does N damage for each Pokémon in
  // your discard pile that has the <Name> attack."
  {
    const m = text.match(
      /this attack does (\d+) damage for each pok[eé]mon in your discard pile that has the ([A-Za-z][A-Za-z'’ -]+?) attack/i,
    );
    if (m) {
      effects.push({
        kind: "perPokemonInDiscardWithAttack",
        attackName: m[2].trim(),
        perCount: parseInt(m[1], 10),
      });
    }
  }

  // Mow Rotom Reaping Dash: "Before doing damage, discard all Pokémon Tools
  // and Special Energy from your opponent's Active Pokémon."
  if (
    text.match(
      /before doing damage, discard all pok[eé]mon tools and special energy from your opponent'?s active pok[eé]mon/i,
    )
  ) {
    effects.push({ kind: "discardAllOppToolsAndSpecialEnergy" });
  }

  // Zarude Jungle Whip: "You may put all Energy attached to this Pokémon
  // into your hand to have this attack do N more damage."
  {
    const m = text.match(
      /you may put all energy attached to this pok[eé]mon into your hand to have this attack do (\d+) more damage/i,
    );
    if (m) effects.push({ kind: "optionalSelfEnergyToHandForBonus", bonus: parseInt(m[1], 10) });
  }

  // Illumise Slowing Perfume: "...Shuffle 1 of your opponent's Benched
  // Pokémon and all attached cards into their deck."
  if (
    text.match(/shuffle 1 of your opponent'?s benched pok[eé]mon and all attached cards into their deck/i)
  ) {
    effects.push({ kind: "shuffleOppBenchedIntoDeck" });
  }

  // Rabsca Counterturn: "If there are N or fewer cards in your deck, this
  // attack does M more damage." → conditional bonus with new predicate.
  {
    const m = text.match(
      /if there are (\d+) or fewer cards? in your deck,? this attack does (\d+) more damage/i,
    );
    if (m) {
      effects.push({
        kind: "conditionalDamage",
        bonus: parseInt(m[2], 10),
        mode: "bonus",
        predicate: { kind: "yourDeckSizeAtMost", count: parseInt(m[1], 10) },
      });
    }
  }

  // Sinistcha Cursed Drop: "Put N damage counters on your opponent's
  // Pokémon in any way you like." Already have placeCountersOnOppBenchAny;
  // the existing detection regex is for "...on your opponent's Pokémon"
  // (no "Benched" qualifier) — the wording matches but the existing
  // detector might be filtering on a stricter shape. Add a permissive
  // match.
  {
    const m = text.match(
      /^put (\d+) damage counters? on your opponent'?s pok[eé]mon in any way you like\.?\s*$/im,
    );
    if (m && !effects.some((eft) => eft.kind === "placeCountersOnOppBenchAny")) {
      effects.push({ kind: "placeCountersOnOppBenchAny", counters: parseInt(m[1], 10) });
    }
  }

  // Serperior Solar Coiling: "If <Name> is in your discard pile, this
  // attack does N more damage." parseAttackPredicate lowercases its input
  // so it can't capture original-case names; we run a case-preserving
  // pattern directly on `text` here.
  {
    const m = text.match(
      /\bif ([A-Z][A-Za-z'’ -]+?) is in your discard pile,? this attack does (\d+) more damage/i,
    );
    if (m && !effects.some((eft) => eft.kind === "conditionalDamage")) {
      effects.push({
        kind: "conditionalDamage",
        bonus: parseInt(m[2], 10),
        mode: "bonus",
        predicate: { kind: "yourDiscardHasCardNamed", namePart: m[1].trim() },
      });
    }
  }

  // Grubbin Flock — already wired via searchDeckNamedToBenchN's broader
  // pattern. The existing "search up to N <Name> and put them onto your
  // bench" detector should match "search ... up to 2 Grubbin and put them
  // onto your Bench" once we relax the namePart shape.
  // (If it doesn't match here, the catch-all is the bullet below.)
  {
    const m = text.match(
      /search your deck for up to (\d+) ([A-Z][A-Za-z'’ -]+?) and put them onto your bench\b/i,
    );
    if (m) {
      const namePart = m[2].trim();
      if (
        !namePart.toLowerCase().endsWith(" energy") &&
        !/basic|pok[eé]mon\b/i.test(namePart) &&
        !effects.some((eft) => eft.kind === "searchDeckNamedToBenchN")
      ) {
        effects.push({
          kind: "searchDeckNamedToBenchN",
          namePart,
          max: parseInt(m[1], 10),
        });
      }
    }
  }

  // ---- Colorless Pokémon attacks ----

  // TR Porygon2/Porygon-Z R Command: "This attack does N damage for each
  // Supporter card that has '<Name>' in its name in your discard pile."
  {
    const m = text.match(
      /this attack does (\d+) damage for each supporter card that has "([A-Z][A-Za-z'’ -]+?)" in its name in your discard pile/i,
    );
    if (m) {
      effects.push({
        kind: "perSupporterInOwnDiscardNamed",
        namePart: m[2].trim(),
        perCount: parseInt(m[1], 10),
      });
    }
  }

  // Talonflame Aero Chase: "If the Retreat Cost of your opponent's Active
  // Pokémon is ColorlessColorless or more, this attack does N more damage."
  {
    const m = text.match(
      /if the retreat cost of your opponent'?s active pok[eé]mon is ((?:Colorless)+) or more,? this attack does (\d+) more damage/i,
    );
    if (m) {
      const cost = (m[1].match(/Colorless/gi) ?? []).length;
      effects.push({
        kind: "conditionalDamage",
        bonus: parseInt(m[2], 10),
        mode: "bonus",
        predicate: { kind: "defenderRetreatCostAtLeast", count: cost },
      });
    }
  }

  // Zangoose Fury Cutter: "Flip 3 coins. If 1 of them is heads, this
  // attack does N more damage. If 2 of them are heads, this attack does
  // M more damage. If all of them are heads, this attack does P more damage."
  {
    const m = text.match(
      /flip (\d+) coins?\. if 1 of them is heads, this attack does (\d+) more damage\. if 2 of them are heads, this attack does (\d+) more damage\.(?:\s*if (?:all of them|3 of them) are heads, this attack does (\d+) more damage\.?)?/i,
    );
    if (m) {
      const tiers = [parseInt(m[2], 10), parseInt(m[3], 10)];
      if (m[4]) tiers.push(parseInt(m[4], 10));
      effects.push({ kind: "tieredFlipDamage", coins: parseInt(m[1], 10), tiers });
    }
  }

  // Heliolisk Parabolic Charge: "Search your deck for up to N Energy
  // cards, reveal them, and put them into your hand."
  {
    const m = text.match(
      /search your deck for up to (\d+) energy cards?, reveal them,? and put them into your hand/i,
    );
    if (m) effects.push({ kind: "searchAnyEnergyToHand", max: parseInt(m[1], 10) });
  }

  // Oranguru "Now You're in My Power": "Until the end of your next turn,
  // the Defending Pokémon's Weakness is now <Type>."
  {
    const m = text.match(
      /until the end of your next turn, the defending pok[eé]mon'?s weakness is now ([A-Za-z]+)/i,
    );
    if (m) {
      const t = matchEnergyType(m[1]);
      if (t) effects.push({ kind: "rewriteDefenderWeaknessNextTurn", toType: t });
    }
  }

  // Maushold Familial March: "Search your deck for up to N in any
  // combination of <Name> and <Name> ex and put them onto your Bench."
  {
    const m = text.match(
      /search your deck for up to (\d+) in any combination of ([A-Z][A-Za-z'’ -]+?) and ([A-Z][A-Za-z'’ -]+?) ex and put them onto your bench/i,
    );
    if (m && m[2].trim() === m[3].trim()) {
      effects.push({
        kind: "searchDeckNamedToBenchN",
        namePart: m[2].trim(),
        max: parseInt(m[1], 10),
      });
    }
  }

  // Miltank Moomoo Rolling: "You can use this attack only if this Pokémon
  // used Rollout during your last turn." Implemented as a fizzle gate.
  {
    const m = text.match(
      /you can use this attack only if this pok[eé]mon used ([A-Z][A-Za-z' -]+?) during your last turn/i,
    );
    if (m) effects.push({ kind: "fizzleUnlessUsedAttackLastTurn", attackName: m[1].trim() });
  }

  // Regigigas Jewel Breaker: "If your opponent's Active Pokémon is a Tera
  // Pokémon, this attack does N more damage."
  {
    const m = text.match(
      /if your opponent'?s active pok[eé]mon is a tera pok[eé]mon,? this attack does (\d+) more damage/i,
    );
    if (m) {
      effects.push({
        kind: "conditionalDamage",
        bonus: parseInt(m[1], 10),
        mode: "bonus",
        predicate: { kind: "defenderHasSubtype", subtype: "Tera" },
      });
    }
  }

  // Komala Slumbering Smack: "Both Active Pokémon are now Asleep."
  {
    const m = text.match(/both active pok[eé]mon are now (asleep|burned|confused|paralyzed|poisoned)/i);
    if (m) {
      effects.push({
        kind: "bothActiveNowStatus",
        status: m[1].toLowerCase() as StatusCondition,
      });
    }
  }
  // The Komala "+100 next turn" piece is detected by the existing
  // selfNextTurnAttackBonus regex — confirmed by grepping. Skip here.

  // Jolteon ex Flashing Spear: "You may discard up to N Basic Energy from
  // your Benched Pokémon. This attack does M more damage for each card you
  // discarded in this way." (Variant of discardBenchEnergyForDamage with
  // "more damage for each" wording instead of just "damage for each".)
  {
    const m = text.match(
      /you may discard up to (\d+) basic energy from your benched pok[eé]mon\. this attack does (\d+) more damage for each card you discarded in this way/i,
    );
    if (m) {
      // Reuse existing discardBenchEnergyForDamage if not already detected.
      if (!effects.some((eft) => eft.kind === "discardBenchEnergyForDamage")) {
        effects.push({
          kind: "discardBenchEnergyForDamage",
          max: parseInt(m[1], 10),
          damagePer: parseInt(m[2], 10),
        });
      }
    }
  }

  // Grubbin / Froakie Flock: "Search your deck for up to N <Name> and put
  // them onto your Bench."
  {
    const m = text.match(
      /search your deck for up to (\d+) ([A-Z][A-Za-z'’ -]+?) and put them onto your bench/,
    );
    if (
      m &&
      // Avoid clashing with the typed search detector above.
      !m[2].toLowerCase().endsWith(" energy") &&
      !/basic|pok[eé]mon/i.test(m[2])
    ) {
      effects.push({
        kind: "searchDeckNamedToBenchN",
        namePart: m[2].trim(),
        max: parseInt(m[1], 10),
      });
    }
  }

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
  if (/(?:a stadium (?:card )?is in play|you have a stadium (?:card )?in play)/i.test(c)) {
    return { kind: "stadiumInPlayNamed", stadiumNamePart: "" };
  }
  if (/your opponent has a stadium (?:card )?in play/i.test(c)) {
    // Reuse stadiumInPlayNamed; the engine doesn't distinguish controller in
    // the predicate today, so we treat "any Stadium in play" as the gate.
    // (Cards using this predicate typically pair it with a "discard the
    // Stadium" rider that's separately wired.)
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
  // ---- New predicates (this batch) ----
  // "If you have at least N <Type> Energy in play"
  {
    const m = c.match(/you have at least (\d+) ([A-Za-z]+) energy in play/i);
    if (m) {
      const t = matchEnergyType(m[2]);
      if (t) return { kind: "youHaveEnergyOfTypeAtLeast", energyType: t, count: parseInt(m[1], 10) };
    }
  }
  // "If this Pokémon was healed during this turn"
  if (/this pok[eé]mon was healed (?:during )?this turn/i.test(c)) {
    return { kind: "selfHealedThisTurn" };
  }
  // "If this Pokémon was damaged by an attack during your opponent's last turn"
  if (/this pok[eé]mon was damaged by an attack during your opponent'?s last turn/i.test(c)) {
    return { kind: "selfDamagedLastOppTurn" };
  }
  // "If this Pokémon used <Name> during your last turn"
  {
    const m = c.match(/this pok[eé]mon used ([A-Za-z][A-Za-z' -]+?) during your last turn/i);
    if (m) return { kind: "selfUsedAttackLastTurn", attackName: m[1].trim() };
  }
  // "If your opponent's Active Pokémon isn't <Status>"
  {
    const m = c.match(/your opponent'?s active pok[eé]mon isn'?t (asleep|burned|confused|paralyzed|poisoned)/i);
    if (m) return { kind: "defenderHasNoStatus", status: m[1].toLowerCase() as StatusCondition };
  }
  // "If your opponent doesn't have exactly N or M Prize cards remaining"
  {
    const m = c.match(/your opponent (?:doesn'?t have|has) exactly (\d+) or (\d+) prize cards? remaining/i);
    if (m) return { kind: "oppPrizesInRange", min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
  }
  // "If <Name> is in your discard pile"
  {
    const m = c.match(/([A-Z][A-Za-z'’ -]+?) is in your discard pile/);
    if (m && !m[1].toLowerCase().startsWith("basic ")) {
      return { kind: "yourDiscardHasCardNamed", namePart: m[1].trim() };
    }
  }
  // "If any of your Benched <Name> have any damage counters on them"
  {
    const m = c.match(/(?:any of )?your benched ([A-Za-z][A-Za-z' -]*?) have any damage counters/i);
    if (m) return { kind: "benchPokemonNamedHasDamage", namePart: m[1].trim() };
  }
  // "If your Benched Pokémon have any damage counters on them"
  if (/your benched pok[eé]mon have any damage counters/i.test(c)) {
    return { kind: "anyBenchHasDamage" };
  }
  // "If any of your <named> Pokémon were Knocked Out by damage from an
  // attack during your opponent's last turn"
  {
    const m = c.match(
      /any of your ([A-Za-z][A-Za-z' -]+?) (?:pok[eé]mon )?(?:were|was) knocked out by damage from an attack during your opponent'?s last turn/i,
    );
    if (m) return { kind: "yourNamedPokemonKoedLastOppTurn", namePart: m[1].trim() };
  }
  // "If you played a Supporter card that has '<Name>' in its name during this turn"
  {
    const m = c.match(/you played a supporter card that has "?([A-Za-z][A-Za-z' -]+?)"? in its name (?:from your hand )?during this turn/i);
    if (m) return { kind: "supporterPlayedThisTurnNameContains", namePart: m[1].trim() };
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
  // Bare "<NameWithApostrophe>'s" — used when the caller has already
  // stripped the trailing "pokemon" word (e.g., the per-pokemon-filter
  // regex captures only the qualifier before "pokemon"). Spidops's
  // "...for each of your Team Rocket's Pokémon in play" passes
  // "Team Rocket's" alone here.
  {
    const m = c.match(/^([a-z'’ ]+?)'s$/i);
    if (m) return { kind: "namePart", namePart: `${m[1]}'s` };
  }
  return undefined;
}

// Returns `true` if a multiplicative "N× damage for each <X> Pokémon in
// play" effect was matched — caller must zero the base damage override
// because "N×" implies the base is purely multiplicative on the per-X
// count (no flat damage without the multiplier). The additive variant
// ("N more damage for each ...", damage="N+") preserves base damage and
// returns false. Mirrors the per-bench / per-energy / per-counter
// handlers at lines 90-126 which already write `baseDamageOverride = 0`
// for the multiplicative case.
function detectPerPokemonFilter(
  text: string,
  effects: AttackEffect[],
): { multiplicativeMatched: boolean } {
  const reMult = /(\d+) damage for each of your (?:([^.]+?)\s+)?pok[eé]mon in play(?:\s+([^.]*?))?(?:\.|$)/i;
  const reAdd = /(\d+) more damage for each of your (?:([^.]+?)\s+)?pok[eé]mon in play/i;
  const reOppMult = /(\d+) damage for each of your opponent'?s (?:([^.]+?)\s+)?pok[eé]mon in play/i;

  for (const [re, side, isMultiplicative] of [
    [reMult, "friendly", true],
    [reAdd, "friendly", false],
    [reOppMult, "opponent", true],
  ] as const) {
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
    return { multiplicativeMatched: isMultiplicative };
  }
  return { multiplicativeMatched: false };
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
  if (text.match(/discard a random card from your opponent'?s hand/i)) {
    effects.push({ kind: "randomOppHandDiscard", count: 1 });
  }
}

function detectRevealOppHand(text: string, effects: AttackEffect[]): void {
  // "Choose a random card from your opponent's hand. <they reveal and> shuffle into deck."
  if (text.match(
    /choose a random card from your opponent'?s hand[\s\S]*?(?:reveals?|reveal that card)[\s\S]*?shuffles? (?:it|that card|them) into their deck/i,
  )) {
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
