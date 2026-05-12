// Shared ActionResult type + ok/fail constructors. Extracted from
// actions.ts so the attack-pipeline split (actions/attack.ts) can use
// them without a circular value import. Both actions.ts and
// actions/attack.ts import from this leaf file; actions.ts re-exports
// `ActionResult` to preserve its public surface.

export type ActionResult =
  | { ok: true }
  | { ok: false; reason: string };

export const ok: ActionResult = { ok: true };
export const fail = (reason: string): ActionResult => ({ ok: false, reason });
