// Smoke test for the Deck Doctor entry paths. Verifies a user can reach
// the doctor from BOTH:
//   • the new home-view "Deck Doctor" tile (promoted to a peer entry
//     point alongside Play),
//   • the legacy pre-game-modal "Deck Doctor" button (kept for users
//     mid-play-flow who realize they want to analyze first).
//
// Selectors are role-based so they don't break when CSS / class names
// change.

import { test, expect } from "@playwright/test";

const APP_URL = "http://localhost:5173/";

test.describe("Deck Doctor — standalone entry path", () => {
  test("home tile → analyze preset → close back to home", async ({ page }) => {
    await page.goto(APP_URL);

    // Home view is the first thing rendered.
    await expect(page.getByRole("heading", { name: /PandaBananasTCG/i })).toBeVisible();
    await page.getByRole("button", { name: /open deck doctor/i }).click();

    const doctor = page.getByRole("dialog", { name: /deck doctor/i });
    await expect(doctor).toBeVisible();

    // Default mode is "Preset"; the combobox is the preset selector.
    await doctor.getByRole("button", { name: /^analyze$/i }).click();

    // The Game plan section is the report header — Structure tab is the
    // default; aria-label on the <section> identifies it.
    await expect(doctor.getByRole("region", { name: /game plan/i })).toBeVisible();

    // Close the doctor; home view must still be visible (no game was
    // started — Deck Doctor is purely standalone).
    await doctor.getByRole("button", { name: /^close$/i }).click();
    await expect(page.getByRole("heading", { name: /PandaBananasTCG/i })).toBeVisible();
  });

  test("pre-game modal → Doctor button (legacy entry) still works", async ({ page }) => {
    await page.goto(APP_URL);
    // Navigate home → play so we land on the pre-game modal.
    await page.getByRole("button", { name: /play a game/i }).click();
    const preGame = page.getByRole("dialog", { name: /choose decks/i });
    await expect(preGame).toBeVisible();
    await preGame.getByRole("button", { name: /deck doctor/i }).click();
    const doctor = page.getByRole("dialog", { name: /deck doctor/i });
    await expect(doctor).toBeVisible();
    await doctor.getByRole("button", { name: /^close$/i }).click();
    await expect(preGame).toBeVisible();
  });

  test("Browse matchups tab opens without analyzing a deck", async ({ page }) => {
    // Verifies the user can hop straight into matchup-matrix browsing
    // without going through the deck-analysis path first (the original
    // discoverability gap that promoted Matchups to a top-level tab).
    await page.goto(APP_URL);
    await page.getByRole("button", { name: /open deck doctor/i }).click();
    const doctor = page.getByRole("dialog", { name: /deck doctor/i });
    await expect(doctor).toBeVisible();

    // The two top-level tabs should be present BEFORE any analysis runs.
    const analyzeTab = doctor.getByRole("tab", { name: /analyze a deck/i });
    const browseTab = doctor.getByRole("tab", { name: /browse matchups/i });
    await expect(analyzeTab).toBeVisible();
    await expect(browseTab).toBeVisible();

    // Switch to Browse — hero/villain pickers + the field data section
    // should render without requiring an Analyze click first.
    await browseTab.click();
    await expect(doctor.getByRole("heading", { name: /matchup browser/i })).toBeVisible();
    await expect(doctor.getByRole("combobox", { name: /hero archetype/i })).toBeVisible();
    await expect(doctor.getByRole("combobox", { name: /villain archetype/i })).toBeVisible();
  });

  test("Meta tab renders the snapshot grade banner without leaking fixtures", async ({ page }) => {
    await page.goto(APP_URL);

    await page.getByRole("button", { name: /open deck doctor/i }).click();
    const doctor = page.getByRole("dialog", { name: /deck doctor/i });

    await doctor.getByRole("button", { name: /^analyze$/i }).click();

    // Switch to Meta tab.
    await doctor.getByRole("tab", { name: /^meta$/i }).click();
    const metaPanel = doctor.getByRole("tabpanel", { name: /meta/i });
    await expect(metaPanel).toBeVisible();

    // The rendered snapshot id MUST NOT start with "fixture-" — guards the
    // user-facing path against fixture leakage.
    const text = await metaPanel.textContent();
    expect(text ?? "").not.toMatch(/fixture-/);
  });
});
