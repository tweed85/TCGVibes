# PandaBananasTCG

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18.3-61dafb?logo=react&logoColor=000)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-5.4-646cff?logo=vite&logoColor=white)](https://vitejs.dev/)
[![Capacitor](https://img.shields.io/badge/Capacitor-8.3-119eff?logo=capacitor&logoColor=white)](https://capacitorjs.com/)
[![Playwright](https://img.shields.io/badge/Playwright-1.59-2ead33?logo=playwright&logoColor=white)](https://playwright.dev/)

Browser-based Pokémon TCG clone. Human vs. strategic AI and local hot-seat
play on the current Play! Pokémon Standard pool (NA, ~2,776 cards). Pure
rule logic lives in `src/engine/` with no React; the UI is data-driven and
the AI runs a candidate-generator loop with archetype playbooks and an
optional MCTS overlay.

![Gameplay – desktop](docs/assets/gameplay-desktop.png)
![AI match](docs/assets/ai-match.gif)
![Mobile board](docs/assets/mobile-board.png)

> Image paths above are placeholders — captures will land in `docs/assets/` later.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

Node 18+.

## Common commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR |
| `npm run typecheck` | `tsc -b --noEmit` |
| `npm run test` | Vitest run (engine + UI unit tests) |
| `npm run e2e` | Playwright (boots dev server, headless Chromium) |
| `npm run build` | Production bundle |

## Tech stack

| Layer | Tooling |
| --- | --- |
| Language | TypeScript 5.6 |
| UI | React 18 + Vite 5 |
| Engine | Pure TS, no React; data-driven effects |
| Tests | Vitest (~938 specs) + Playwright (e2e smoke) |
| Mobile / native | Capacitor 8 (iOS), PWA via `vite-plugin-pwa` |
| Persistence | `idb-keyval` (local) + optional Supabase replay upload |

## Branches

- **`pandabananastcg`** — active development. PRs land here.
- **`main`** — tracks the deployable build. Open a PR from
  `pandabananastcg` to merge gameplay-ready work.

## Where to look

- [CLAUDE.md](CLAUDE.md) — full architecture + conventions
- [docs/EFFECTS.md](docs/EFFECTS.md) — attack / ability / trainer / stadium / tool effect coverage
- [docs/AI.md](docs/AI.md) — AI internals (v1 greedy, v2 archetype-aware, MCTS, playbooks)
- [docs/DECKS.md](docs/DECKS.md) — deck library + builder
- [docs/TESTS.md](docs/TESTS.md) — test-suite map
- [docs/REPLAY.md](docs/REPLAY.md) + [docs/REPLAY_BACKEND.md](docs/REPLAY_BACKEND.md) — replay determinism contract + cloud aggregation
- [docs/MOBILE.md](docs/MOBILE.md) — iOS / PWA / responsive layout
- [docs/AI_CPU_BUILD_PLAN.md](docs/AI_CPU_BUILD_PLAN.md) — AI build phases
- [docs/REFACTOR_PLAN.md](docs/REFACTOR_PLAN.md) — repo-health refactor plan
