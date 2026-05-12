// Single source of truth for the app version. Imported by the replay
// schema (Phase 5) and any future place that wants to stamp output with
// the build it came from. A grep on this constant is the version-bump
// procedure.
export const APP_VERSION = "0.0.1";
