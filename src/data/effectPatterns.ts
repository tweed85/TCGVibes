// Parse Pokémon TCG attack text into structured AttackEffect entries.
//
// Coverage is deliberately narrow: we only match common, unambiguous patterns
// so the engine applies effects that match the card's printed text. Anything
// that doesn't match stays as free-form `text` on the attack — the UI shows
// it, the engine just doesn't evaluate it.

import type { AttackEffect, EnergyType, StatusCondition } from "../engine/types";

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
  // "Your opponent's Active Pokémon is now <status>."
  {
    const m = text.match(
      /opponent'?s Active Pok[eé]mon is now (Asleep|Burned|Confused|Paralyzed|Poisoned)/i,
    );
    if (m) {
      const status = STATUS_FROM_TEXT[m[1].toLowerCase()];
      if (status) effects.push({ kind: "applyStatus", status, target: "defender" });
    }
  }
  // "The Defending Pokémon is now <status>." (older wording)
  {
    const m = text.match(
      /defending Pok[eé]mon is now (Asleep|Burned|Confused|Paralyzed|Poisoned)/i,
    );
    if (m) {
      const status = STATUS_FROM_TEXT[m[1].toLowerCase()];
      if (status && !effects.some((e) => e.kind === "applyStatus")) {
        effects.push({ kind: "applyStatus", status, target: "defender" });
      }
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

  // ---- Heal self ------------------------------------------------------------
  // "Heal N damage from this Pokémon."
  {
    const m = text.match(/heal (\d+) damage from this Pok[eé]mon/i);
    if (m) effects.push({ kind: "heal", amount: parseInt(m[1], 10), target: "self" });
  }

  // ---- Discard own energy ---------------------------------------------------
  // "Discard N Energy from this Pokémon."
  {
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
  // "Draw N cards." (attack-level draw)
  {
    const m = text.match(/draw (\d+) cards?/i);
    if (m) effects.push({ kind: "drawCards", count: parseInt(m[1], 10) });
  }

  return { effects, baseDamageOverride };
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
