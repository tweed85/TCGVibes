// Attack-text pattern detection tests. Makes sure the dozens of regex patterns
// in effectPatterns.ts reliably identify their target effects across both
// "N×" pure-multiplier damage and "N+" additive damage wordings.

import { describe, it, expect } from "vitest";
import { extractEffects } from "../effectPatterns";

type ApiAttack = Parameters<typeof extractEffects>[0];

function mkAttack(overrides: Partial<ApiAttack>): ApiAttack {
  return {
    name: "Test Attack",
    cost: [],
    ...overrides,
  } as ApiAttack;
}

describe("coin-flip effects", () => {
  it("flipHeadsBonus from 'If heads, this attack does 30 more damage.'", () => {
    const e = extractEffects(
      mkAttack({
        damage: "30+",
        text: "Flip a coin. If heads, this attack does 30 more damage.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "flipHeadsBonus", bonus: 30 });
  });

  it("flipTailsFizzle from 'If tails, this attack does nothing.'", () => {
    const e = extractEffects(
      mkAttack({
        damage: "50",
        text: "Flip a coin. If tails, this attack does nothing.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "flipTailsFizzle" });
  });

  it("flipHeadsDouble from 'If heads, this attack does double damage.'", () => {
    const e = extractEffects(
      mkAttack({
        damage: "40",
        text: "Flip a coin. If heads, this attack does double damage.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "flipHeadsDouble" });
  });

  it("flipMultiCoinsPerHeads from 'Flip N coins. This attack does N damage for each heads.'", () => {
    const e = extractEffects(
      mkAttack({
        damage: "30×",
        text: "Flip 2 coins. This attack does 30 damage for each heads.",
      }),
    );
    expect(e.effects).toContainEqual({
      kind: "flipMultiCoinsPerHeads",
      coins: 2,
      perHeads: 30,
    });
    expect(e.baseDamageOverride).toBe(0);
  });
});

describe("per-count damage scaling", () => {
  it("'N damage for each of your Benched Pokémon' → perFriendlyBench (×)", () => {
    const e = extractEffects(
      mkAttack({
        damage: "20×",
        text: "This attack does 20 damage for each of your Benched Pokémon.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "perFriendlyBench", perCount: 20 });
    expect(e.baseDamageOverride).toBe(0);
  });

  it("'30 more damage for each of your Benched Pokémon' → perFriendlyBench (+)", () => {
    const e = extractEffects(
      mkAttack({
        damage: "60+",
        text: "This attack does 30 more damage for each of your Benched Pokémon.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "perFriendlyBench", perCount: 30 });
    expect(e.baseDamageOverride).toBeUndefined();
  });

  it("'for each of your opponent's Benched Pokémon' → perOpponentBench", () => {
    const e = extractEffects(
      mkAttack({
        damage: "30×",
        text: "This attack does 30 damage for each of your opponent's Benched Pokémon.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "perOpponentBench", perCount: 30 });
  });

  it("'for each Benched Pokémon (both yours and your opponent's)' → perBothBench", () => {
    const e = extractEffects(
      mkAttack({
        damage: "20+",
        text: "This attack does 20 more damage for each Benched Pokémon (both yours and your opponent's).",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "perBothBench", perCount: 20 });
  });

  it("'for each damage counter on this Pokémon' → perDamageCounterOnSelf", () => {
    const e = extractEffects(
      mkAttack({
        damage: "20×",
        text: "This attack does 20 damage for each damage counter on this Pokémon.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "perDamageCounterOnSelf", perCount: 20 });
  });

  it("'for each damage counter on your opponent's Active Pokémon' → perDamageCounterOnDefender", () => {
    const e = extractEffects(
      mkAttack({
        damage: "20×",
        text: "This attack does 20 damage for each damage counter on your opponent's Active Pokémon.",
      }),
    );
    expect(e.effects).toContainEqual({
      kind: "perDamageCounterOnDefender",
      perCount: 20,
    });
  });

  it("'for each Energy attached to your opponent's Active' → perEnergyOnDefender", () => {
    const e = extractEffects(
      mkAttack({
        damage: "30+",
        text: "This attack does 30 more damage for each Energy attached to your opponent's Active Pokémon.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "perEnergyOnDefender", perCount: 30 });
  });

  it("'for each Prize card your opponent has taken' → perPrizeOppTaken", () => {
    const e = extractEffects(
      mkAttack({
        damage: "130+",
        text: "This attack does 50 more damage for each Prize card your opponent has taken.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "perPrizeOppTaken", perCount: 50 });
  });

  it("'for each Energy attached to this Pokémon' → perAttachedEnergy (×)", () => {
    const e = extractEffects(
      mkAttack({
        damage: "30×",
        text: "This attack does 30 damage for each Energy attached to this Pokémon.",
      }),
    );
    expect(e.effects).toContainEqual({
      kind: "perAttachedEnergy",
      perEnergy: 30,
      energyType: undefined,
    });
    expect(e.baseDamageOverride).toBe(0);
  });

  it("'for each Water Energy attached' picks up the type qualifier", () => {
    const e = extractEffects(
      mkAttack({
        damage: "20+",
        text: "This attack does 20 more damage for each Water Energy attached to this Pokémon.",
      }),
    );
    expect(e.effects).toContainEqual({
      kind: "perAttachedEnergy",
      perEnergy: 20,
      energyType: "Water",
    });
  });
});

describe("disruption effects", () => {
  it("Budew's Itchy Pollen: block opp items", () => {
    const e = extractEffects(
      mkAttack({
        damage: "10",
        text: "During your opponent's next turn, they can't play any Item cards from their hand.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "blockOppItemsNextTurn" });
  });

  it("self-lock next turn", () => {
    const e = extractEffects(
      mkAttack({
        damage: "200",
        text: "During your next turn, this Pokémon can't attack.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "selfCantAttackNextTurn" });
  });

  it("defender-can't-retreat next turn", () => {
    const e = extractEffects(
      mkAttack({
        damage: "20",
        text: "During your opponent's next turn, the Defending Pokémon can't retreat.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "defenderCantRetreatNextTurn" });
  });

  it("self-damage reduction next turn", () => {
    const e = extractEffects(
      mkAttack({
        damage: "20",
        text: "During your opponent's next turn, this Pokémon takes 30 less damage from attacks.",
      }),
    );
    expect(e.effects).toContainEqual({
      kind: "selfDamageReductionNextTurn",
      amount: 30,
    });
  });

  it("single-target bench snipe — 'Benched' present → benchOnly:true", () => {
    const e = extractEffects(
      mkAttack({
        damage: "20",
        text: "This attack also does 20 damage to 1 of your opponent's Benched Pokémon.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "snipeOne", damage: 20, benchOnly: true });
  });

  it("single-target free-pick snipe — 'Benched' absent → benchOnly:false", () => {
    // Fezandipiti ex Cruel Arrow targets Active OR Bench.
    const e = extractEffects(
      mkAttack({
        damage: "",
        text: "This attack does 100 damage to 1 of your opponent's Pokémon. (Don't apply Weakness and Resistance for Benched Pokémon.)",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "snipeOne", damage: 100, benchOnly: false });
  });

  it("switch out opp's Active", () => {
    const e = extractEffects(
      mkAttack({
        damage: "30",
        text: "Switch out your opponent's Active Pokémon to the Bench. (Your opponent chooses the new Active Pokémon.)",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "switchOutOpponent" });
  });

  it("self-switch", () => {
    const e = extractEffects(
      mkAttack({
        damage: "50",
        text: "Switch this Pokémon with 1 of your Benched Pokémon.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "selfSwitch" });
  });

  it("discard an Energy from opp's Active", () => {
    const e = extractEffects(
      mkAttack({
        damage: "40",
        text: "Discard an Energy from your opponent's Active Pokémon.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "discardOppEnergy", count: 1 });
  });

  it("flip heads → discard an Energy from opp's Active", () => {
    const e = extractEffects(
      mkAttack({
        damage: "30",
        text: "Flip a coin. If heads, discard an Energy from your opponent's Active Pokémon.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "flipHeadsDiscardOppEnergy" });
    // Should NOT also have an unconditional discardOppEnergy
    expect(e.effects.find((x) => x.kind === "discardOppEnergy")).toBeUndefined();
  });

  it("heal each of your Pokémon", () => {
    const e = extractEffects(
      mkAttack({
        damage: "100",
        text: "Heal 50 damage from each of your Pokémon.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "healEachOwnPokemon", amount: 50 });
  });

  it("mill opp top card", () => {
    const e = extractEffects(
      mkAttack({
        damage: "20",
        text: "Discard the top card of your opponent's deck.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "discardTopOfOppDeck", count: 1 });
  });

  it("discard opp's Tools before damage", () => {
    const e = extractEffects(
      mkAttack({
        damage: "30",
        text: "Before doing damage, discard all Pokémon Tools from your opponent's Active Pokémon.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "discardOppTools" });
  });
});

describe("status application", () => {
  it("'Your opponent's Active Pokémon is now Asleep.'", () => {
    const e = extractEffects(
      mkAttack({
        damage: "20",
        text: "Your opponent's Active Pokémon is now Asleep.",
      }),
    );
    expect(e.effects).toContainEqual({
      kind: "applyStatus",
      status: "asleep",
      target: "defender",
    });
  });

  it("'now Poisoned'", () => {
    const e = extractEffects(
      mkAttack({
        damage: "30",
        text: "Your opponent's Active Pokémon is now Poisoned.",
      }),
    );
    expect(e.effects).toContainEqual({
      kind: "applyStatus",
      status: "poisoned",
      target: "defender",
    });
  });
});

describe("bench-summon / geometric flip", () => {
  it("Call for Family — 'up to N Basic Pokémon' → callForFamily", () => {
    const e = extractEffects(
      mkAttack({
        damage: "",
        text: "Search your deck for up to 2 Basic Pokémon and put them onto your Bench. Then, shuffle your deck.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "callForFamily", max: 2 });
  });

  it("Flip-until-tails geometric damage", () => {
    const e = extractEffects(
      mkAttack({
        damage: "20×",
        text: "Flip a coin until you get tails. This attack does 20 damage for each heads.",
      }),
    );
    expect(e.effects).toContainEqual({
      kind: "flipUntilTailsPerHeads",
      perHeads: 20,
    });
    expect(e.baseDamageOverride).toBe(0);
  });
});

describe("misc simple effects", () => {
  it("'This Pokémon does N damage to itself' → selfDamage", () => {
    const e = extractEffects(
      mkAttack({
        damage: "180",
        text: "This Pokémon also does 50 damage to itself.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "selfDamage", damage: 50 });
  });

  it("'Discard N Energy from this Pokémon' → discardOwnEnergy", () => {
    const e = extractEffects(
      mkAttack({
        damage: "180",
        text: "Discard 2 Energy from this Pokémon.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "discardOwnEnergy", count: 2 });
  });

  it("'Heal N damage from this Pokémon' → heal self", () => {
    const e = extractEffects(
      mkAttack({
        damage: "30",
        text: "Heal 30 damage from this Pokémon.",
      }),
    );
    expect(e.effects).toContainEqual({
      kind: "heal",
      amount: 30,
      target: "self",
    });
  });

  it("'bench snipe — N damage to each of your opponent's Benched Pokémon'", () => {
    const e = extractEffects(
      mkAttack({
        damage: "60",
        text: "This attack also does 20 damage to each of your opponent's Benched Pokémon. (Don't apply Weakness and Resistance for Benched Pokémon.)",
      }),
    );
    expect(e.effects).toContainEqual({
      kind: "benchSnipe",
      damage: 20,
      target: "opponentBench",
    });
  });

  it("Ninetales Supernatural Shapeshifter → discardTopOfOwnDeckUseSupporterEffect", () => {
    const e = extractEffects(
      mkAttack({
        damage: "",
        text: "Discard the top card of your deck, and if that card is a Supporter card, use the effect of that card as the effect of this attack.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "discardTopOfOwnDeckUseSupporterEffect" });
  });

  it("Mega Lucario ex Aura Jab → attachNFromDiscardToBench(max=3, Fighting)", () => {
    const e = extractEffects(
      mkAttack({
        damage: "130",
        text: "Attach up to 3 Basic Fighting Energy cards from your discard pile to your Benched Pokémon in any way you like.",
      }),
    );
    expect(e.effects).toContainEqual({
      kind: "attachNFromDiscardToBench",
      energyType: "Fighting",
      max: 3,
    });
  });

  it("Arboliva ex Oil Salvo → distributeDamage", () => {
    const e = extractEffects(
      mkAttack({
        damage: "",
        text: "Choose 1 of your opponent's Pokémon 6 times. (You can choose the same Pokémon more than once.) For each time you chose a Pokémon, do 20 damage to it. This damage isn't affected by Weakness or Resistance.",
      }),
    );
    expect(e.effects).toContainEqual({
      kind: "distributeDamage",
      times: 6,
      perHit: 20,
      ignoreWR: true,
    });
  });

  it("Dragapult ex Phantom Dive → distributeDamage benchOnly", () => {
    const e = extractEffects(
      mkAttack({
        damage: "200",
        text: "Put 6 damage counters on your opponent's Benched Pokémon in any way you like.",
      }),
    );
    expect(e.effects).toContainEqual({
      kind: "distributeDamage",
      times: 6,
      perHit: 10,
      ignoreWR: true,
      benchOnly: true,
    });
  });

  it("Team Rocket's Grimer Corrosive Sludge → discardDefenderEndOfOppNextTurn", () => {
    const e = extractEffects(
      mkAttack({
        damage: "",
        text: "At the end of your opponent's next turn, discard the Defending Pokémon and all attached cards.",
      }),
    );
    expect(e.effects).toContainEqual({ kind: "discardDefenderEndOfOppNextTurn" });
  });
});
