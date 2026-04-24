// Unit tests for energy-cost matching. The rulebook specifies: specific-type
// slots in a cost must be paid by Energy providing that exact type; Colorless
// slots can be paid by any Energy.

import { describe, it, expect } from "vitest";
import { canPayCost } from "../rules";

describe("canPayCost", () => {
  it("empty cost is always payable", () => {
    expect(canPayCost([], [])).toBe(true);
    expect(canPayCost(["Grass"], [])).toBe(true);
  });

  it("specific Energy satisfies same-type cost", () => {
    expect(canPayCost(["Grass"], ["Grass"])).toBe(true);
    expect(canPayCost(["Fire", "Fire"], ["Fire", "Fire"])).toBe(true);
  });

  it("wrong type fails specific cost", () => {
    expect(canPayCost(["Water"], ["Grass"])).toBe(false);
  });

  it("Colorless slot pays with any type", () => {
    expect(canPayCost(["Grass"], ["Colorless"])).toBe(true);
    expect(canPayCost(["Fire", "Water"], ["Colorless", "Colorless"])).toBe(true);
  });

  it("mixed costs: specifics matched first, colorless pays the remainder", () => {
    // 1 Grass + 1 Colorless cost; provided Grass + Fire
    expect(canPayCost(["Grass", "Fire"], ["Grass", "Colorless"])).toBe(true);
    // Provided Grass + Grass; Grass + Colorless cost — second Grass pays Colorless
    expect(canPayCost(["Grass", "Grass"], ["Grass", "Colorless"])).toBe(true);
  });

  it("insufficient count fails", () => {
    expect(canPayCost(["Grass"], ["Grass", "Colorless"])).toBe(false);
    expect(canPayCost([], ["Colorless"])).toBe(false);
  });

  it("extra attached energy is fine", () => {
    expect(canPayCost(["Grass", "Grass", "Grass"], ["Grass"])).toBe(true);
  });
});
