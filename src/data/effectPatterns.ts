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

  // ---- Opponent can't play Item cards next turn -----------------------------
  // Budew's Itchy Pollen and similar disruption attacks.
  if (/they can't play any item cards from their hand/i.test(text)) {
    effects.push({ kind: "blockOppItemsNextTurn" });
  }

  // ---- "Flip N coins. This attack does N damage for each heads." ------------
  {
    const m = text.match(/flip (\d+) coins?\. this attack does (\d+) damage for each heads/i);
    if (m) {
      const coins = parseInt(m[1], 10);
      const perHeads = parseInt(m[2], 10);
      effects.push({ kind: "flipMultiCoinsPerHeads", coins, perHeads });
      baseDamageOverride = 0;
    }
  }

  // ---- Self-lock next turn --------------------------------------------------
  if (/during your next turn, this pok[eé]mon can'?t (?:use )?attack/i.test(text)) {
    effects.push({ kind: "selfCantAttackNextTurn" });
  }

  // ---- Defender can't retreat next turn -------------------------------------
  if (/during your opponent'?s next turn, the defending pok[eé]mon can'?t retreat/i.test(text)) {
    effects.push({ kind: "defenderCantRetreatNextTurn" });
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

  // ---- Switch out opponent's Active -----------------------------------------
  if (/switch out your opponent'?s active pok[eé]mon to the bench/i.test(text)) {
    effects.push({ kind: "switchOutOpponent" });
  }

  // ---- Self switch to bench -------------------------------------------------
  if (/switch this pok[eé]mon with 1 of your benched pok[eé]mon/i.test(text)) {
    effects.push({ kind: "selfSwitch" });
  }

  // ---- Discard Energy from opp Active ---------------------------------------
  if (/flip a coin\. if heads, discard an energy from your opponent'?s active pok[eé]mon/i.test(text)) {
    effects.push({ kind: "flipHeadsDiscardOppEnergy" });
  } else if (/discard an energy from your opponent'?s active pok[eé]mon/i.test(text)) {
    effects.push({ kind: "discardOppEnergy", count: 1 });
  } else {
    const m = text.match(/discard (\d+) energy from your opponent'?s active pok[eé]mon/i);
    if (m) effects.push({ kind: "discardOppEnergy", count: parseInt(m[1], 10) });
  }

  // ---- Heal each of your Pokémon --------------------------------------------
  {
    const m = text.match(/heal (\d+) damage from each of your pok[eé]mon/i);
    if (m) effects.push({ kind: "healEachOwnPokemon", amount: parseInt(m[1], 10) });
  }

  // ---- Mill opp deck --------------------------------------------------------
  if (/discard the top card of your opponent'?s deck/i.test(text)) {
    effects.push({ kind: "discardTopOfOppDeck", count: 1 });
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
  // "Flip a coin until you get tails. This attack does N damage for each heads."
  if (damageText.endsWith("×")) {
    const m = text.match(/flip a coin until you get tails\. this attack does (\d+) damage for each heads/i);
    if (m) {
      effects.push({ kind: "flipUntilTailsPerHeads", perHeads: parseInt(m[1], 10) });
      baseDamageOverride = 0;
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
  // Dunsparce "Dig": "Flip a coin. If heads, during your opponent's next turn,
  // prevent all damage from and effects of attacks done to this Pokémon."
  if (/flip a coin\. if heads, during your opponent'?s next turn, prevent all damage from and effects of attacks done to this pok[eé]mon/i.test(text)) {
    effects.push({ kind: "shieldNextTurn", requiresHeads: true });
  } else if (/during your opponent'?s next turn, prevent all damage from and effects of attacks done to this pok[eé]mon/i.test(text)) {
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

  // ---- "This Pokémon can't use <name> next turn" --------------------------
  // Riolu "Accelerating Stab" / Mega Lucario "Mega Brave" — scoped lock
  // against re-using the SAME attack. Detect via "can't use <AttackName>"
  // matching the attack's own name.
  {
    const m = text.match(/during your next turn, this pok[eé]mon can'?t use (.+?)\./i);
    if (m && atk.name) {
      const expected = atk.name.trim().toLowerCase();
      const locked = m[1].trim().toLowerCase();
      if (expected === locked) {
        effects.push({ kind: "selfCantUseAttackNextTurn", attackName: atk.name });
      } else {
        // Different attack named — fall back to the broader "no attacks"
        // lock so at least SOME restriction fires.
        effects.push({ kind: "selfCantAttackNextTurn" });
      }
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

  // ---- Ignore Weakness / Resistance ---------------------------------------
  if (/this attack'?s damage isn'?t affected by weakness or resistance/i.test(text)) {
    effects.push({ kind: "ignoreWeaknessResistance" });
  }

  // ---- Return self + all attached to hand ---------------------------------
  // Meowth ex "Tuck Tail": "Put this Pokémon and all attached cards into
  // your hand."
  if (/put this pok[eé]mon and all attached cards into your hand/i.test(text)) {
    effects.push({ kind: "returnSelfToHand" });
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
