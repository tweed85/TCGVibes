// Smoke test for the Deck Doctor entry path. Verifies a user can:
//   • open the app cold,
//   • click "Deck Doctor" inside the pre-game dialog,
//   • analyze a curated preset,
//   • see the Game plan section render,
//   • close the doctor — and the pre-game dialog stays visible (no game
//     started).
//
// Selectors are role-based so they don't break when CSS / class names
// change. The Deck Doctor button click is scoped to the pre-game dialog
// because (per the wiring) a second "Deck Doctor" button also lives in
// the in-game Game menu — we want the standalone path here.

import { test, expect } from "@playwright/test";

const APP_URL = "http://localhost:5173/";

test.describe("Deck Doctor — standalone entry path", () => {
  test("open cold, analyze a preset, close, pre-game still visible", async ({ page }) => {
    await page.goto(APP_URL);

    // The pre-game modal renders on cold start with aria-label="Choose decks".
    const preGame = page.getByRole("dialog", { name: /choose decks/i });
    await expect(preGame).toBeVisible();

    // Open the doctor from the pre-game options row.
    await preGame.getByRole("button", { name: /deck doctor/i }).click();

    const doctor = page.getByRole("dialog", { name: /deck doctor/i });
    await expect(doctor).toBeVisible();

    // Default mode is "Preset"; the combobox is the preset selector.
    await doctor.getByRole("button", { name: /^analyze$/i }).click();

    // The Game plan section is the report header — Structure tab is the
    // default; aria-label on the <section> identifies it.
    await expect(doctor.getByRole("region", { name: /game plan/i })).toBeVisible();

    // Close the doctor; pre-game dialog must still be visible (no game
    // was started — Deck Doctor is purely standalone).
    await doctor.getByRole("button", { name: /^close$/i }).click();
    await expect(preGame).toBeVisible();
  });

  test("Meta tab renders the snapshot grade banner without leaking fixtures", async ({ page }) => {
    await page.goto(APP_URL);

    const preGame = page.getByRole("dialog", { name: /choose decks/i });
    await preGame.getByRole("button", { name: /deck doctor/i }).click();
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
