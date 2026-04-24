// Ability detection + activated-ability resolution.
//
// Pokémon abilities run the gamut from passive ongoing effects ("This
// Pokémon's attacks do 20 more damage") to triggered ones ("When you play
// this Pokémon...") to activated ones ("Once during your turn, you may...").
//
// We auto-wire a selection of activated, once-per-turn abilities — both
// generic text patterns and a hand-picked set of common cards where the
// exact wording is specific (e.g. Thwackey's conditional search).

import { logEvent } from "./rules";
import { abilitiesActiveOn } from "./ongoingEffects";
import { setDeckSearchPick } from "./pendingPick";
import type {
  Ability,
  AbilityCondition,
  AbilityEffect,
  Card,
  EnergyCard,
  EnergyType,
  GameState,
  PlayerId,
  PokemonInPlay,
} from "./types";

const ENERGY_TYPES: EnergyType[] = [
  "Grass", "Fire", "Water", "Lightning", "Psychic",
  "Fighting", "Darkness", "Metal", "Fairy", "Dragon", "Colorless",
];

// Abilities that need bespoke detection (by name) because their text is
// more specific than a generic regex would handle cleanly.
const NAMED_ABILITY_EFFECTS: Record<string, AbilityEffect> = {
  // Thwackey — search for ANY card if Active has Festival Lead.
  "Boom Boom Groove": {
    kind: "searchDeckAnyCard",
    oncePerTurn: true,
    condition: { kind: "activeHasAbilityNamed", abilityName: "Festival Lead" },
  },
  // Mamoswine ex — search for any Pokémon.
  "Mammoth Hauler": { kind: "searchDeckPokemon", oncePerTurn: true },
  // Cynthia's Gabite — search for any Cynthia's Pokémon (we approximate as any Pokémon).
  "Champion's Call": { kind: "searchDeckPokemon", oncePerTurn: true },
  // Mega Dragonite ex — switch.
  "Sky Transport": { kind: "switchWithBench", oncePerTurn: true },
  // Alcremie ex — heal 30 from any.
  "Confectionary Gift": { kind: "healAny", amount: 30, oncePerTurn: true },
  // Erika's Vileplume ex — heal 30 from each (approximated via heal-each pattern).
  // Swadloon — heal 20 from Active (approximated as healAny and auto-target Active).
  "Healing Leaves": { kind: "healAny", amount: 20, oncePerTurn: true },
  // Blaziken ex — attach Basic Energy from discard to any of your Pokémon
  // (simplified to self to fit the current target model).
  "Seething Spirit": { kind: "attachEnergyFromDiscardToSelf", oncePerTurn: true },
  // Team Rocket's Spidops — attach Basic Energy from discard to self.
  "Charging Up": { kind: "attachEnergyFromDiscardToSelf", oncePerTurn: true },
};

export function detectAbilityEffect(a: { name: string; type: string; text: string }): AbilityEffect | undefined {
  // Name-based first so specific wording wins over generic regexes.
  const byName = NAMED_ABILITY_EFFECTS[a.name];
  if (byName) return byName;

  const text = a.text || "";
  // Ignore passive/triggered — only auto-wire activated ("Once during your turn").
  if (!/once during your turn/i.test(text)) return undefined;

  // "Once during your turn, you may draw a card."
  if (/\bdraw a card\b/i.test(text) && !/draw 2 cards/i.test(text)) {
    return { kind: "drawOne", oncePerTurn: true };
  }
  if (/draw 2 cards/i.test(text)) {
    return { kind: "drawTwo", oncePerTurn: true };
  }
  if (/draw 3 cards/i.test(text)) {
    return { kind: "drawN", count: 3, oncePerTurn: true };
  }

  // "Once during your turn, you may heal N damage from this Pokémon."
  {
    const m = text.match(/heal (\d+) damage from this Pok[eé]mon/i);
    if (m) return { kind: "healSelf", amount: parseInt(m[1], 10), oncePerTurn: true };
  }

  // "Once during your turn, you may search your deck for a basic [Type] Energy..."
  {
    const m = text.match(/search your deck for a basic ([A-Za-z]+ )?energy/i);
    if (m) {
      return { kind: "searchBasicEnergy", count: 1, oncePerTurn: true };
    }
  }

  // "Once during your turn, you may attach a basic [Type] Energy card from your
  // hand to 1 of your Pokémon."
  {
    const m = text.match(/attach a basic ([A-Za-z]+) energy card from your hand/i);
    if (m) {
      const type = ENERGY_TYPES.find((t) => t.toLowerCase() === m[1].toLowerCase());
      if (type) return { kind: "attachEnergyFromHand", energyType: type, oncePerTurn: true };
    }
  }

  return undefined;
}

// Apply detection in-place to all abilities on a Pokémon card — called during
// card mapping.
export function annotateAbilities(abilities: Ability[] | undefined): Ability[] | undefined {
  if (!abilities) return abilities;
  return abilities.map((a) => ({ ...a, effect: detectAbilityEffect(a) }));
}

// ---- Condition checks ----------------------------------------------------

function checkCondition(
  state: GameState,
  player: PlayerId,
  cond: AbilityCondition,
): { ok: true } | { ok: false; reason: string } {
  switch (cond.kind) {
    case "activeHasAbilityNamed": {
      const active = state.players[player].active;
      const hasAbility =
        !!active &&
        (active.card.abilities ?? []).some((a) => a.name === cond.abilityName);
      if (!hasAbility) {
        return { ok: false, reason: `Requires an Active Pokémon with the ${cond.abilityName} Ability.` };
      }
      return { ok: true };
    }
  }
}

// ---- Activate an ability at runtime --------------------------------------

export interface ActivateResult {
  ok: boolean;
  reason?: string;
}

function shuffleDeck(state: GameState, pl: PlayerId): void {
  const player = state.players[pl];
  const arr = player.deck;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = state.rng.int(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

export function activateAbility(
  state: GameState,
  player: PlayerId,
  instanceId: string,
  abilityIndex: number,
): ActivateResult {
  if (state.phase !== "main")
    return { ok: false, reason: "Not in main phase." };
  if (state.activePlayer !== player)
    return { ok: false, reason: "Not your turn." };

  const pl = state.players[player];
  const holder: PokemonInPlay | undefined =
    pl.active?.instanceId === instanceId
      ? pl.active
      : pl.bench.find((p) => p.instanceId === instanceId);
  if (!holder) return { ok: false, reason: "Pokémon not in play." };

  const ability = holder.card.abilities?.[abilityIndex];
  if (!ability) return { ok: false, reason: "No such ability." };
  if (!ability.effect) return { ok: false, reason: "That ability isn't engine-playable." };
  if (ability.effect.oncePerTurn && holder.abilityUsedThisTurn)
    return { ok: false, reason: "Ability already used this turn." };
  if (!abilitiesActiveOn(state, holder.card))
    return { ok: false, reason: "Abilities are disabled by the current Stadium." };

  const e = ability.effect;

  // Evaluate pre-activation conditions (e.g. Thwackey requires Festival Lead Active).
  if ("condition" in e && e.condition) {
    const check = checkCondition(state, player, e.condition);
    if (!check.ok) return check;
  }

  switch (e.kind) {
    case "drawOne":
    case "drawTwo":
    case "drawN": {
      const n = e.kind === "drawOne" ? 1 : e.kind === "drawTwo" ? 2 : e.count;
      let drawn = 0;
      for (let i = 0; i < n; i++) {
        const c = pl.deck.shift();
        if (!c) break;
        pl.hand.push(c);
        drawn++;
      }
      logEvent(state, player, `uses ${ability.name} on ${holder.card.name}: draws ${drawn} card(s).`);
      break;
    }

    case "healSelf": {
      const before = holder.damage;
      holder.damage = Math.max(0, holder.damage - e.amount);
      logEvent(state, player, `uses ${ability.name}: heals ${before - holder.damage} from ${holder.card.name}.`);
      break;
    }

    case "healAny": {
      // Target the most-damaged of your Pokémon (heuristic; no target UI yet).
      const allies = [pl.active, ...pl.bench].filter((p): p is PokemonInPlay => !!p);
      const target = allies.sort((a, b) => b.damage - a.damage)[0];
      if (!target) return { ok: false, reason: "No Pokémon in play." };
      const before = target.damage;
      target.damage = Math.max(0, target.damage - e.amount);
      logEvent(state, player, `uses ${ability.name}: heals ${before - target.damage} from ${target.card.name}.`);
      break;
    }

    case "searchBasicEnergy": {
      const isBasicEnergy = (c: Card): c is EnergyCard =>
        c.supertype === "Energy" && c.subtypes.includes("Basic");
      let found = 0;
      const keep: Card[] = [];
      for (const c of pl.deck) {
        if (found < e.count && isBasicEnergy(c)) {
          pl.hand.push(c);
          found++;
        } else {
          keep.push(c);
        }
      }
      pl.deck = keep;
      shuffleDeck(state, player);
      logEvent(state, player, `uses ${ability.name}: gets ${found} basic Energy.`);
      break;
    }

    case "attachEnergyFromHand": {
      const idx = pl.hand.findIndex(
        (c) => c.supertype === "Energy" && c.subtypes.includes("Basic") && (c as EnergyCard).provides.includes(e.energyType),
      );
      if (idx < 0) return { ok: false, reason: `No basic ${e.energyType} Energy in hand.` };
      const [en] = pl.hand.splice(idx, 1) as [EnergyCard];
      holder.attachedEnergy.push(en);
      logEvent(state, player, `uses ${ability.name}: attaches ${en.name} to ${holder.card.name}.`);
      break;
    }

    case "attachEnergyFromDiscardToSelf": {
      const isBasicEnergy = (c: Card): c is EnergyCard =>
        c.supertype === "Energy" && c.subtypes.includes("Basic");
      const idx = pl.discard.findIndex(isBasicEnergy);
      if (idx < 0) return { ok: false, reason: "No basic Energy in discard." };
      const [en] = pl.discard.splice(idx, 1) as [EnergyCard];
      holder.attachedEnergy.push(en);
      logEvent(state, player, `uses ${ability.name}: attaches ${en.name} to ${holder.card.name} from discard.`);
      break;
    }

    case "searchDeckAnyCard": {
      const set = setDeckSearchPick(
        state,
        player,
        () => true, // any card
        1,
        `${ability.name}: pick 1 card from deck`,
      );
      if (!set) {
        logEvent(state, player, `uses ${ability.name}: deck is empty.`);
      } else {
        logEvent(state, player, `uses ${ability.name}.`);
      }
      break;
    }

    case "searchDeckPokemon": {
      const isPkm = (c: Card) => c.supertype === "Pokémon";
      const set = setDeckSearchPick(
        state,
        player,
        isPkm,
        1,
        `${ability.name}: pick 1 Pokémon from deck`,
      );
      if (!set) {
        logEvent(state, player, `uses ${ability.name}: finds no Pokémon.`);
      } else {
        logEvent(state, player, `uses ${ability.name}.`);
      }
      break;
    }

    case "switchWithBench": {
      if (!pl.active || pl.bench.length === 0) {
        return { ok: false, reason: "Nothing to switch with." };
      }
      const incoming = pl.bench.shift()!;
      const outgoing = pl.active;
      pl.active = incoming;
      pl.bench.push(outgoing);
      logEvent(state, player, `uses ${ability.name}: switches ${outgoing.card.name} → ${incoming.card.name}.`);
      break;
    }
  }

  holder.abilityUsedThisTurn = true;
  return { ok: true };
}
