<!-- freshness: 168h | last-touched: 2026-05-11T01:16:31Z | owner: codex -->

# Agent Ownership

## Lanes

### Claude

Claude owns planning, review, synthesis, architecture/risk analysis, acceptance criteria, and handoff clarity.

Primary files and workflows:

- `docs/*_AUDIT.md`
- `docs/FINDINGS.md`
- Durable implementation plans in `docs/**`
- Risk review for `src/engine/**`, `src/data/**`, `src/ui/**`, `supabase/**`
- Cross-agent summaries in `/ai/PROJECT_STATE.md`, `/ai/CONTEXT_SUMMARY.md`, and `/ai/inbox.md`

### Codex

Codex owns implementation, refactors, tests, static checks, scripts, and automation.

Primary files and workflows:

- `src/engine/**`
- `src/data/**`
- `src/ui/**`
- `src/App.tsx`
- `e2e/**`
- `supabase/**`
- `scripts/**`
- `.github/**`
- Implementation-status updates in `docs/**` and `/ai/QA.md`

### ChatGPT / User-Facing Coordinator

ChatGPT owns user-facing coordination:

- Choose the next plan to execute
- Ask for reviews of Claude or Codex outputs
- Approve risky automation or broad refactors
- Keep product intent visible

## Static Path Table

| Path | Primary | Reviewer |
|---|---|---|
| `src/engine/**` | Codex | Claude |
| `src/ui/**` + `src/App.tsx` | Codex | Claude |
| `src/data/**` | Codex | Claude |
| `docs/**` plans + audits | Claude | Codex |
| `docs/**` implementation-status updates | Codex | Claude |
| `/ai/**` | Append-only by default | Active coordinator rewrites snapshots |
| `supabase/**` | Codex | Claude |
| `scripts/**` | Codex | Claude |

## Claim Rule

For cross-path tasks, claim the TODO line before editing:

```md
- [ ] [claimed:codex:2026-05-11T01:16:31Z] Task title — verify: `npm run test`
```

Claims less than 1 hour old require an inbox handoff before another agent reclaims them.
