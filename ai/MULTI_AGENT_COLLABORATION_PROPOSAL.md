# Multi-Agent Project Collaboration Proposal

## Purpose

We want Claude and Codex to review this local codebase and recommend how they should collaborate using shared markdown files, scheduled tasks, and event-driven file triggers.

The goal is to create a lightweight multi-agent workflow where each tool has clear ownership, avoids duplicating work, and communicates through files inside this project directory.

---

## Request for Claude and Codex

Please review the codebase and provide recommendations for:

1. Which parts of the project you are best suited to own
2. Which files, folders, or workflows should be assigned to you
3. How you should communicate status, blockers, and handoffs
4. How to operationalize event-driven file triggers
5. What scheduled tasks should run automatically
6. What markdown coordination files should exist
7. What safeguards are needed to avoid conflicting edits

---

## Proposed Shared Coordination Files

Please evaluate and improve this structure:

```text
/ai
  PROJECT_STATE.md
  TODO.md
  DECISIONS.md
  CONTEXT_SUMMARY.md
  QA.md
  inbox.md
  agent_ownership.md
  trigger_rules.md
  scheduled_tasks.md
```

### File Purposes

- `PROJECT_STATE.md`: Current project snapshot
- `TODO.md`: Prioritized task queue
- `DECISIONS.md`: Architecture and implementation decisions
- `CONTEXT_SUMMARY.md`: Compressed project memory
- `QA.md`: Test results, validation findings, risks
- `inbox.md`: Cross-agent messages and handoffs
- `agent_ownership.md`: Which agent owns which parts
- `trigger_rules.md`: Event-driven automation rules
- `scheduled_tasks.md`: Recurring review/update tasks

---

## Ownership Question

Claude and Codex should each propose an ownership model.

Example:

```text
Claude owns:
- Architecture review
- Requirements clarification
- Documentation
- Risk analysis
- Workflow design
- QA reasoning

Codex owns:
- Code edits
- Refactors
- Tests
- Static analysis
- Script creation
- Automation implementation
```

Please adjust this based on the actual codebase.

---

## Event-Driven File Trigger Concept

We want file changes to cause useful follow-up actions.

Examples:

```text
When /specs/*.md changes:
  -> Review requirements
  -> Update TODO.md
  -> Suggest implementation plan

When /src/** changes:
  -> Run tests or linting
  -> Update QA.md
  -> Flag risky changes

When /sql/** changes:
  -> Validate SQL style
  -> Check assumptions
  -> Update QA.md

When /ai/inbox.md changes:
  -> Parse new messages
  -> Respond or claim tasks

When /ai/TODO.md changes:
  -> Identify executable tasks
  -> Assign owner
  -> Update status
```

Please recommend:

- Which triggers are useful
- Which are too risky
- Which should be manual approval only
- Which scripts or tools should implement this

---

## Scheduled Task Ideas

Please recommend a practical schedule.

Candidate tasks:

```text
Every 15 minutes:
- Check /ai/inbox.md for new handoffs

Hourly:
- Review TODO.md and update PROJECT_STATE.md

Daily:
- Compress project context into CONTEXT_SUMMARY.md
- Summarize completed work
- Identify blockers

On git commit:
- Update CHANGELOG or QA notes
- Review changed files

On test failure:
- Update QA.md
- Create TODO item
```

---

## Required Output

Please write your recommendations into:

```text
/ai/agent_recommendations.md
```

Use this format:

```md
# Agent Recommendations

## Recommended Ownership

### Claude
...

### Codex
...

## Recommended File Structure
...

## Event-Driven Trigger Plan
...

## Scheduled Task Plan
...

## Conflict Avoidance Rules
...

## Risks
...

## First 5 Implementation Steps
...
```

---

## Important Constraints

- Avoid editing the same files at the same time
- Prefer append-only logs where possible
- Do not overwrite another agent's work without explicit handoff
- Keep markdown files structured and easy to parse
- Use git commits or diffs as the source of truth for code changes
- Any automation that modifies code should be conservative
- Risky actions should create recommendations, not direct edits

---

## Final Goal

Create a repeatable workflow where Claude, Codex, and ChatGPT can all collaborate on this local project through shared markdown files, clear ownership, event triggers, scheduled reviews, and git-based coordination.
