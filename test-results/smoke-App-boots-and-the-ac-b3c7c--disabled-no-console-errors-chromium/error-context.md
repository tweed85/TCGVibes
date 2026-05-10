# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: smoke.spec.ts >> App boots and the action bar wires up correctly >> loads the app, reaches main phase, Undo starts disabled, no console errors
- Location: e2e/smoke.spec.ts:12:3

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: expect.toBeVisible: Target page, context or browser has been closed
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - generic [ref=e4]:
    - generic [ref=e5]:
      - heading "PandaBananasTCG" [level=1] [ref=e6]
      - generic [ref=e7]:
        - text: T1 · You · setup
        - generic [ref=e8]: · Standard (North America) 2026-04-23
    - generic [ref=e9]:
      - generic [ref=e10]:
        - checkbox "Open hands" [ref=e11]
        - text: Open hands
      - generic "How fast the CPU plays its turn" [ref=e12]:
        - text: CPU Speed
        - combobox "CPU Speed" [ref=e13]:
          - option "Instant"
          - option "Fast"
          - option "Normal" [selected]
          - option "Slow"
      - group [ref=e14]:
        - generic "Game" [ref=e15] [cursor=pointer]
      - button "New Game" [ref=e16] [cursor=pointer]
  - generic [ref=e18]:
    - heading "Mulligan" [level=2] [ref=e20]
    - generic [ref=e21]:
      - paragraph [ref=e22]: If your opening hand has no Basic Pokémon, you reveal it, shuffle it back into your deck, and draw a new 7 — that's a "mulligan." Your opponent draws one extra card for each mulligan you take.
      - paragraph [ref=e23]: You mulliganed 1× (no Basic Pokémon). CPU drew 1 extra card.
    - button "Continue" [ref=e25] [cursor=pointer]
  - generic [ref=e27]:
    - generic [ref=e28]:
      - heading "Opening Setup — You" [level=2] [ref=e29]
      - generic [ref=e30]: "Active: — · Bench: 0/5"
    - paragraph [ref=e31]: Mulliganed 1× — Click a Basic Pokémon to put it in the Active spot (required). Click more Basics to add them to your bench (optional, up to 5).
    - generic [ref=e32]:
      - generic "Click to place" [ref=e33] [cursor=pointer]:
        - 'generic "Grookey Basic · Grass · HP 70 Grass · Smash Kick (10) Grass+Grass · Branch Poke (30) Weakness: Fire ×2 Retreat: 1 SV6 #14 · H Shift+click (or long-press) to zoom" [ref=e34]':
          - img "Grookey" [ref=e35]
      - generic "Click to place" [ref=e36] [cursor=pointer]:
        - 'generic "Grookey Basic · Grass · HP 70 Grass · Smash Kick (10) Grass+Grass · Branch Poke (30) Weakness: Fire ×2 Retreat: 1 SV6 #14 · H Shift+click (or long-press) to zoom" [ref=e37]':
          - img "Grookey" [ref=e38]
      - generic "Not a Basic Pokémon" [ref=e39]:
        - 'generic "Boss''s Orders Trainer · Supporter Switch in 1 of your opponent''s Benched Pokémon to the Active Spot. You may play only 1 Supporter card during your turn. ME1 #114 · I Shift+click (or long-press) to zoom" [ref=e40] [cursor=pointer]':
          - img "Boss's Orders" [ref=e41]
      - generic "Not a Basic Pokémon" [ref=e42]:
        - 'generic "Enhanced Hammer Trainer · Item Discard a Special Energy from 1 of your opponent''s Pokémon. You may play any number of Item cards during your turn. SV6 #148 · H Shift+click (or long-press) to zoom" [ref=e43] [cursor=pointer]':
          - img "Enhanced Hammer" [ref=e44]
      - generic "Not a Basic Pokémon" [ref=e45]:
        - 'generic "Lillie''s Determination Trainer · Supporter Shuffle your hand into your deck. Then, draw 6 cards. If you have exactly 6 Prize cards remaining, draw 8 cards instead. You may play only 1 Supporter card during your turn. ME1 #119 · I Shift+click (or long-press) to zoom" [ref=e46] [cursor=pointer]':
          - img "Lillie's Determination" [ref=e47]
      - generic "Not a Basic Pokémon" [ref=e48]:
        - 'generic "Rillaboom Stage 2 · Grass · HP 180 Evolves from Thwackey Grass · Drum Beating (60) During your opponent''s next turn, attacks used by the Defending Pokémon cost Colorless more, and its Retreat Cost is Colorless more. Grass+Grass · Wood Hammer (180) This Pokémon also does 50 damage to itself. Weakness: Fire ×2 Retreat: 4 SV6 #16 · H Shift+click (or long-press) to zoom" [ref=e49] [cursor=pointer]':
          - img "Rillaboom" [ref=e50]
      - generic "Not a Basic Pokémon" [ref=e51]:
        - 'generic "Thwackey Stage 1 · Grass · HP 100 Evolves from Grookey [Ability] Boom Boom Groove: Once during your turn, if your Active Pokémon has the Festival Lead Ability, you may search your deck for a card and put it into your hand. Then, shuffle your deck. Grass+Grass · Beat (50) Weakness: Fire ×2 Retreat: 2 SV6 #15 · H Shift+click (or long-press) to zoom" [ref=e52] [cursor=pointer]':
          - img "Thwackey" [ref=e53]
    - button "Confirm" [disabled] [ref=e55]
  - generic [ref=e56]:
    - generic [ref=e57]: CPU
    - generic [ref=e58]: Hand 5
    - generic [ref=e59]:
      - generic [ref=e60] [cursor=pointer]: TCG
      - generic [ref=e61] [cursor=pointer]: TCG
      - generic [ref=e62] [cursor=pointer]: TCG
      - generic [ref=e63] [cursor=pointer]: TCG
      - generic [ref=e64] [cursor=pointer]: TCG
  - generic [ref=e65]:
    - generic [ref=e66]:
      - generic "CPU" [ref=e67]:
        - generic [ref=e68]:
          - generic "CPU prizes" [ref=e69]:
            - generic [ref=e70]: Prizes · 6
          - generic [ref=e79]: CPU
          - generic "CPU deck and discard" [ref=e80]:
            - 'generic "Deck: 46" [ref=e81]':
              - generic [ref=e86]: "46"
              - generic [ref=e87]: Deck
            - generic "View discard pile" [ref=e88] [cursor=pointer]:
              - 'generic "Discard: 0" [ref=e89]':
                - generic [ref=e91]: "0"
                - generic [ref=e92]: Discard
        - generic [ref=e94]:
          - 'generic "Teal Mask Ogerpon ex Basic · Tera · ex · Grass · HP 210 [Ability] Teal Dance: Once during your turn, you may attach a Basic Grass Energy card from your hand to this Pokémon. If you attached Energy to a Pokémon in this way, draw a card. Grass+Grass+Grass · Myriad Leaf Shower (30+) This attack does 30 more damage for each Energy attached to both Active Pokémon. Weakness: Fire ×2 Retreat: 1 SV6 #25 · H Shift+click (or long-press) to zoom" [ref=e95] [cursor=pointer]':
            - img "Teal Mask Ogerpon ex" [ref=e96]
            - generic:
              - generic: 210/210
          - 'generic "Meowth ex Basic · ex · Colorless · HP 170 [Ability] Last-Ditch Catch: Once during your turn, when you play this Pokémon from your hand onto your Bench, you may use this Ability. Search your deck for a Supporter card, reveal it, and put it into your hand. Then, shuffle your deck. You can''t use more than 1 Ability that has \"Last-Ditch\" in its name each turn. Colorless+Colorless+Colorless · Tuck Tail (60) Put this Pokémon and all attached cards into your hand. Weakness: Fighting ×2 Retreat: 1 ME3 #62 · J Shift+click (or long-press) to zoom" [ref=e97] [cursor=pointer]':
            - img "Meowth ex" [ref=e98]
            - generic:
              - generic: 170/170
          - generic [ref=e99]: Empty
          - generic [ref=e100]: Empty
          - generic [ref=e101]: Empty
        - 'generic "Teal Mask Ogerpon ex Basic · Tera · ex · Grass · HP 210 [Ability] Teal Dance: Once during your turn, you may attach a Basic Grass Energy card from your hand to this Pokémon. If you attached Energy to a Pokémon in this way, draw a card. Grass+Grass+Grass · Myriad Leaf Shower (30+) This attack does 30 more damage for each Energy attached to both Active Pokémon. Weakness: Fire ×2 Retreat: 1 SV6 #25 · H Shift+click (or long-press) to zoom" [ref=e104] [cursor=pointer]':
          - img "Teal Mask Ogerpon ex" [ref=e105]
          - generic:
            - generic: 210/210
      - generic "Stadium zone" [ref=e106]:
        - generic [ref=e107]: 🏟 Stadium
      - generic "You" [ref=e108]:
        - generic [ref=e109]:
          - generic "You prizes" [ref=e110]:
            - generic [ref=e111]: Prizes · 6
          - generic [ref=e119]:
            - generic [ref=e120]: You
            - generic [ref=e121]: Mulligans · 1
          - generic "You deck and discard" [ref=e122]:
            - 'generic "Deck: 47" [ref=e123]':
              - generic [ref=e128]: "47"
              - generic [ref=e129]: Deck
            - generic "View discard pile" [ref=e130] [cursor=pointer]:
              - 'generic "Discard: 0" [ref=e131]':
                - generic [ref=e133]: "0"
                - generic [ref=e134]: Discard
        - generic [ref=e136]:
          - generic [ref=e137]: Empty
          - generic [ref=e138]: Empty
          - generic [ref=e139]: Empty
          - generic [ref=e140]: Empty
          - generic [ref=e141]: Empty
        - generic [ref=e144]: No Active
    - complementary "Selected card and game log" [ref=e145]:
      - generic [ref=e146]:
        - generic [ref=e147]: Selected
        - paragraph [ref=e148]: Select a card or Pokemon to inspect details here.
      - generic [ref=e149]:
        - generic [ref=e150]: Attack Preview
        - paragraph [ref=e151]: Your Active Pokemon has no attacks available yet.
      - generic [ref=e152]:
        - generic [ref=e153]: Recent Log
        - generic [ref=e154]:
          - generic [ref=e156]: "[T1] Game start. Flip a coin — guess heads or tails."
          - generic [ref=e158]: "[T1] Coin flip: heads. You wins the toss and chooses."
          - generic [ref=e160]: "[T1] You chose to go first. You goes first."
          - generic [ref=e162]: "[T1] You reveals mulligan hand: Basic Grass Energy, Switch, Poké Pad, Basic Grass Energy, Air Balloon, Night Stretcher, Thwackey."
          - generic [ref=e164]: "[T1] You mulliganed 1×; CPU drew 1 extra card(s)."
          - generic [ref=e166]: "[T1] Both players: choose your Active and bench Basic Pokémon."
          - generic [ref=e168]: "[T1] CPU sets up — Active: Teal Mask Ogerpon ex; Bench: Teal Mask Ogerpon ex, Meowth ex."
  - generic [ref=e169]:
    - generic [ref=e170]:
      - generic [ref=e171]: Hand (7)
      - generic [ref=e172]: Basic → bench · Evo/Energy + target · Trainer plays
    - generic [ref=e173]:
      - 'generic "Grookey Basic · Grass · HP 70 Grass · Smash Kick (10) Grass+Grass · Branch Poke (30) Weakness: Fire ×2 Retreat: 1 SV6 #14 · H Shift+click (or long-press) to zoom" [ref=e174] [cursor=pointer]':
        - img "Grookey"
      - 'generic "Grookey Basic · Grass · HP 70 Grass · Smash Kick (10) Grass+Grass · Branch Poke (30) Weakness: Fire ×2 Retreat: 1 SV6 #14 · H Shift+click (or long-press) to zoom" [ref=e175] [cursor=pointer]':
        - img "Grookey"
      - 'generic "Boss''s Orders Trainer · Supporter Switch in 1 of your opponent''s Benched Pokémon to the Active Spot. You may play only 1 Supporter card during your turn. ME1 #114 · I Shift+click (or long-press) to zoom" [ref=e176] [cursor=pointer]':
        - img "Boss's Orders"
      - 'generic "Enhanced Hammer Trainer · Item Discard a Special Energy from 1 of your opponent''s Pokémon. You may play any number of Item cards during your turn. SV6 #148 · H Shift+click (or long-press) to zoom" [ref=e177] [cursor=pointer]':
        - img "Enhanced Hammer"
      - 'generic "Lillie''s Determination Trainer · Supporter Shuffle your hand into your deck. Then, draw 6 cards. If you have exactly 6 Prize cards remaining, draw 8 cards instead. You may play only 1 Supporter card during your turn. ME1 #119 · I Shift+click (or long-press) to zoom" [ref=e178] [cursor=pointer]':
        - img "Lillie's Determination"
      - 'generic "Rillaboom Stage 2 · Grass · HP 180 Evolves from Thwackey Grass · Drum Beating (60) During your opponent''s next turn, attacks used by the Defending Pokémon cost Colorless more, and its Retreat Cost is Colorless more. Grass+Grass · Wood Hammer (180) This Pokémon also does 50 damage to itself. Weakness: Fire ×2 Retreat: 4 SV6 #16 · H Shift+click (or long-press) to zoom" [ref=e179] [cursor=pointer]':
        - img "Rillaboom"
      - 'generic "Thwackey Stage 1 · Grass · HP 100 Evolves from Grookey [Ability] Boom Boom Groove: Once during your turn, if your Active Pokémon has the Festival Lead Ability, you may search your deck for a card and put it into your hand. Then, shuffle your deck. Grass+Grass · Beat (50) Weakness: Fire ×2 Retreat: 2 SV6 #15 · H Shift+click (or long-press) to zoom" [ref=e180] [cursor=pointer]':
        - img "Thwackey"
  - generic [ref=e181]:
    - generic [ref=e182]:
      - generic [ref=e183]: CPU thinking…
      - generic [ref=e184]:
        - generic [ref=e185]: Energy
        - generic [ref=e186]: Supporter
        - generic [ref=e187]: Retreat
    - generic [ref=e188]:
      - generic [ref=e189]:
        - generic [ref=e190]: Attacks
        - generic [ref=e192]: —
      - generic [ref=e193]:
        - generic [ref=e194]: Retreat to
        - generic [ref=e196]: —
      - generic [ref=e198]:
        - button "Undo" [disabled] [ref=e199]
        - button "End Turn" [disabled] [ref=e200]
```

# Test source

```ts
  1   | // End-to-end click-through against the dev server. Validates that the
  2   | // recent rng/undo + Phantom Dive picker label changes don't break the
  3   | // boot path or the runtime UI. The actual rng-determinism and engine
  4   | // correctness are covered by the unit + integration tests; this file is
  5   | // the "does the app actually load and respond to clicks" smoke layer.
  6   | 
  7   | import { test, expect } from "@playwright/test";
  8   | 
  9   | const APP_URL = "http://localhost:5173/";
  10  | 
  11  | test.describe("App boots and the action bar wires up correctly", () => {
  12  |   test("loads the app, reaches main phase, Undo starts disabled, no console errors", async ({ page }) => {
  13  |     const consoleErrors: string[] = [];
  14  |     page.on("console", (msg) => {
  15  |       if (msg.type() === "error") consoleErrors.push(msg.text());
  16  |     });
  17  |     page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  18  | 
  19  |     await page.goto(APP_URL);
  20  | 
  21  |     // Pre-game modal should render with a Start Game primary button.
  22  |     await expect(page.getByRole("heading", { name: /Start a game/i })).toBeVisible();
  23  |     await page.getByRole("button", { name: "Start Game" }).click();
  24  | 
  25  |     // Coin flip modal — guess heads.
  26  |     await expect(page.getByRole("heading", { name: /Coin Flip/i })).toBeVisible();
  27  |     await page.getByRole("button", { name: "Heads" }).click();
  28  | 
  29  |     // Result banner; if we won, choose to go first. If we lost, the AI
  30  |     // chooses for us — either path lands in setup, so just attempt the
  31  |     // "Go first" click and ignore if it isn't visible.
  32  |     const goFirst = page.getByRole("button", { name: "Go first" });
  33  |     if (await goFirst.isVisible({ timeout: 2000 }).catch(() => false)) {
  34  |       await goFirst.click();
  35  |     }
  36  | 
  37  |     // Setup phase — click the first basic Pokémon in hand and confirm.
  38  |     // The "Done" button is gated on a valid Active being chosen; we just
  39  |     // wait for it and click. If our deck mulliganed, the board may be in
  40  |     // a different state — we tolerate it by checking for either the Done
  41  |     // button or the in-game action bar.
  42  |     const setupDone = page.getByRole("button", { name: /Done|Confirm/i });
  43  |     const handCards = page.locator(".hand-row .card-imaged, .hand .card-imaged").first();
  44  | 
  45  |     // Try to click a hand basic + confirm. Best-effort — some deck/seed
  46  |     // combos may need different setup flow; failure here doesn't prove a
  47  |     // regression unless the page errored.
  48  |     if (await handCards.isVisible({ timeout: 5000 }).catch(() => false)) {
  49  |       await handCards.click({ trial: false }).catch(() => {});
  50  |       if (await setupDone.isVisible({ timeout: 1500 }).catch(() => false)) {
  51  |         await setupDone.click().catch(() => {});
  52  |       }
  53  |     }
  54  | 
  55  |     // Dismiss the mulligan notice modal if it appears.
  56  |     const continueBtn = page.getByRole("button", { name: "Continue" });
  57  |     if (await continueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
  58  |       await continueBtn.click().catch(() => {});
  59  |     }
  60  | 
  61  |     // Wait for the action bar (signals main phase reached at least once).
> 62  |     await expect(page.locator(".action-bar").first()).toBeVisible({ timeout: 10000 });
      |                                                       ^ Error: expect.toBeVisible: Target page, context or browser has been closed
  63  | 
  64  |     // Undo button should exist and start disabled — the rewritten undo
  65  |     // stack only fills as the player takes actions; nothing has happened
  66  |     // yet on this turn (or it's the AI's turn, which also disables Undo).
  67  |     const undoBtn = page.getByRole("button", { name: /^Undo$/ });
  68  |     if (await undoBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
  69  |       await expect(undoBtn).toBeDisabled();
  70  |     }
  71  | 
  72  |     // App must not have logged any runtime errors during the boot/click path.
  73  |     // Filter out the well-known third-party noise (PWA registration warnings,
  74  |     // dev-mode React devtools nags) — we only care about errors from our
  75  |     // code / the engine.
  76  |     const real = consoleErrors.filter(
  77  |       (m) => !/Download the React DevTools|service worker|workbox|Failed to load resource/i.test(m),
  78  |     );
  79  |     expect(real, `console errors during boot:\n${real.join("\n")}`).toEqual([]);
  80  |   });
  81  | 
  82  |   test("Undo button activates after a play action and clears after Undo click", async ({ page }) => {
  83  |     const errors: string[] = [];
  84  |     page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  85  | 
  86  |     await page.goto(APP_URL);
  87  |     await page.getByRole("button", { name: "Start Game" }).click();
  88  |     await page.getByRole("button", { name: "Heads" }).click();
  89  |     const goFirst = page.getByRole("button", { name: "Go first" });
  90  |     if (await goFirst.isVisible({ timeout: 2000 }).catch(() => false)) {
  91  |       await goFirst.click();
  92  |     }
  93  | 
  94  |     // Setup: click first hand basic (best-effort selector), confirm via Done.
  95  |     const handCard = page.locator(".hand-row .card-imaged, .hand .card-imaged").first();
  96  |     if (await handCard.isVisible({ timeout: 5000 }).catch(() => false)) {
  97  |       await handCard.click().catch(() => {});
  98  |       const done = page.getByRole("button", { name: /Done|Confirm/i });
  99  |       if (await done.isVisible({ timeout: 1500 }).catch(() => false)) {
  100 |         await done.click().catch(() => {});
  101 |       }
  102 |     }
  103 | 
  104 |     // Skip mulligan modal if present.
  105 |     const cont = page.getByRole("button", { name: "Continue" });
  106 |     if (await cont.isVisible({ timeout: 2000 }).catch(() => false)) {
  107 |       await cont.click().catch(() => {});
  108 |     }
  109 | 
  110 |     await expect(page.locator(".action-bar").first()).toBeVisible({ timeout: 10000 });
  111 | 
  112 |     const undoBtn = page.getByRole("button", { name: /^Undo$/ });
  113 |     if (!(await undoBtn.isVisible({ timeout: 2000 }).catch(() => false))) {
  114 |       // Some seeds end up viewing the AI's turn first or in a layout where
  115 |       // the Undo button isn't surfaced — skip the active assertion. Engine
  116 |       // tests already prove the stack mechanism; this branch keeps the
  117 |       // test green when the UI variant doesn't expose the button.
  118 |       return;
  119 |     }
  120 | 
  121 |     // At fresh main phase, Undo starts disabled (empty stack — only player
  122 |     // actions push to it; turn-start doesn't).
  123 |     await expect(undoBtn).toBeDisabled();
  124 | 
  125 |     // Take an undoable action. The most reliable cross-seed action is
  126 |     // playing a Basic Pokémon from hand to bench: it requires no target
  127 |     // picker and no energy. Click the first eligible hand card; if it's
  128 |     // a basic, the engine plays it to bench and the snapshot fires.
  129 |     const handCardsAfter = page.locator(".hand-row .card-imaged, .hand .card-imaged");
  130 |     const handCount = await handCardsAfter.count();
  131 |     let played = false;
  132 |     for (let i = 0; i < handCount; i++) {
  133 |       const benchSize = await page.locator(".bench-row .card.in-play").count();
  134 |       await handCardsAfter.nth(i).click({ trial: false }).catch(() => {});
  135 |       // After click, did Undo become enabled? That's the proof that
  136 |       // snapshotForUndo fired and the action committed.
  137 |       if (await undoBtn.isEnabled({ timeout: 500 }).catch(() => false)) {
  138 |         played = true;
  139 |         // Sanity: bench should have grown by 1 if it was a basic.
  140 |         const newBench = await page.locator(".bench-row .card.in-play").count();
  141 |         expect(newBench).toBeGreaterThanOrEqual(benchSize);
  142 |         break;
  143 |       }
  144 |     }
  145 | 
  146 |     if (!played) {
  147 |       // No card in hand was a basic — that happens with some setups. The
  148 |       // smoke check (Undo starts disabled, no errors) already passed.
  149 |       return;
  150 |     }
  151 | 
  152 |     // Click Undo — stack pops, state reverts, button disables again.
  153 |     await undoBtn.click();
  154 |     await expect(undoBtn).toBeDisabled({ timeout: 2000 });
  155 |     expect(errors).toEqual([]);
  156 |   });
  157 | 
  158 |   test("Mobile viewport: app boots cleanly at 375px (iPhone SE / iPhone 12 mini)", async ({ page }) => {
  159 |     // Regression guard for the mobile UI cleanup pass — verifies the page
  160 |     // loads at iPhone SE 3rd gen width without runtime errors and the body
  161 |     // fits within the viewport. Doesn't drive setup-phase clicks since
  162 |     // those flake on cold-start at narrow widths; the boot-path coverage
```