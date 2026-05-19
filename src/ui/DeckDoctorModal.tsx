// Deck Doctor — standalone modal.
//
// Three input modes (preset / saved / paste). The analyzer + composeReport
// produce a structured DoctorReport; the modal renders Game plan +
// Problems / Risks / Suggestions. "Copy report" serializes via
// serializeDoctorReport (the disclaimer line lives there, not in the
// structured report). Lazy-loaded via React.lazy in App.tsx.

import { Fragment, useEffect, useMemo, useState } from "react";
import { allCards, cardsByName, datasetAsOf } from "../data/cards";
import { gameplayKey } from "../data/cardEquivalence";
import {
  analyzeDeck,
  composeReport,
  DOCTOR_VERSION,
  pasteNoticesFromImport,
  serializeDoctorReport,
  type DeckAnalysis,
  type DeckInput,
  type DoctorContext,
  type Finding,
  type SerializedMetaSection,
  type Severity,
} from "../data/deckDoctor";
import {
  buildDeck,
  validatedDeckSpecs,
} from "../data/decks";
import {
  importDecklist,
  type DeckListEntry,
} from "../data/decklistParser";
import { ARCHETYPE_PROFILES, type Archetype } from "../engine/aiArchetype";
import {
  loadLatestSnapshotSync,
  type MetaSnapshot,
} from "../data/metaSnapshot";
import {
  analyzeMeta,
  STATIC_MATCHUP_DISCLAIMER,
  type MetaAnalysis,
} from "../data/metaDoctor";
import type { MatchupCheck } from "../data/matchupChecks";
import type { Card } from "../engine/types";
import {
  aggregateCells,
  loadPairings,
  loadDecklists,
  pairingsForMatchup,
  tallyMatchupFromPairings,
  wilson95FromTally,
  filterByMinRound,
  decklistTotalCount,
  type PairingRecord,
  type AggregateCell,
  type DecklistRecord,
} from "../data/aggregates";

interface SavedDeck {
  id: string;
  name: string;
  entries: DeckListEntry[];
  cards: Card[];
}

export interface DeckDoctorModalProps {
  imports: SavedDeck[];
  initial?: { source: "preset" | "saved"; id: string };
  onClose: () => void;
}

const ctx: DoctorContext = {
  get cardsByName() {
    return cardsByName;
  },
  gameplayKey,
};

type InputMode = "preset" | "saved" | "paste";
type ReportTab = "structure" | "matchups" | "meta";
// Top-level tabs — let users browse the matchup matrix WITHOUT going
// through the deck-analysis path first. Reflects the "I just want to
// look up a matchup" use case (Joe-vs-Bob round 4 etc).
type TopTab = "analyze" | "browse";

const SEVERITY_META: Record<Severity, { label: string; icon: string }> = {
  error: { label: "Problems", icon: "⛔" },
  warning: { label: "Risks", icon: "⚠" },
  suggestion: { label: "Suggestions", icon: "💡" },
};

const META_GRADE_LABEL: Record<MetaAnalysis["metaGrade"], string> = {
  A: "A",
  B: "B",
  C: "C",
  D: "D",
  "insufficient-data": "—",
};

function formatPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

export default function DeckDoctorModal({
  imports,
  initial,
  onClose,
}: DeckDoctorModalProps) {
  const presets = useMemo(() => validatedDeckSpecs(), []);
  const [mode, setMode] = useState<InputMode>(initial?.source ?? "preset");
  const [presetId, setPresetId] = useState<string>(
    initial?.source === "preset" ? initial.id : presets[0]?.id ?? "",
  );
  const [savedId, setSavedId] = useState<string>(
    initial?.source === "saved" ? initial.id : imports[0]?.id ?? "",
  );
  const [pasteText, setPasteText] = useState<string>("");
  const [analysis, setAnalysis] = useState<DeckAnalysis | null>(null);
  const [userDeck, setUserDeck] = useState<Card[]>([]);
  const [meta, setMeta] = useState<MetaAnalysis | null>(null);
  const [copyHint, setCopyHint] = useState<string>("");
  const [showFallback, setShowFallback] = useState<boolean>(false);
  const [fallbackText, setFallbackText] = useState<string>("");
  const [tab, setTab] = useState<ReportTab>("structure");
  const [topTab, setTopTab] = useState<TopTab>("analyze");
  // Standalone matchup-browser state — separate from the analyze flow's
  // `opponent` so picking a deck for analysis doesn't reset the matchup
  // browser the user was looking at.
  const [browseHero, setBrowseHero] = useState<Archetype | "unknown">("dragapult-dudunsparce");
  const [browseVillain, setBrowseVillain] = useState<Archetype | "unknown">("crustle");

  // Load the freshest non-fixture snapshot. The loader returns null when no
  // research-quality snapshot is committed — UI handles that gracefully.
  const snapshot: MetaSnapshot | null = useMemo(
    () => loadLatestSnapshotSync(),
    [],
  );

  // Opponent picker state — populated from snapshot archetypes (sorted by
  // metaShare) when available, ARCHETYPE_PROFILES keys otherwise.
  const opponentChoices: Array<Archetype | "unknown"> = useMemo(() => {
    if (snapshot && snapshot.archetypes.length > 0) {
      return [...snapshot.archetypes]
        .sort((a, b) => b.metaShare - a.metaShare)
        .map((a) => a.id);
    }
    return Object.keys(ARCHETYPE_PROFILES) as Archetype[];
  }, [snapshot]);
  const [opponent, setOpponent] = useState<Archetype | "unknown">(
    opponentChoices[0] ?? "unknown",
  );
  useEffect(() => {
    setOpponent(opponentChoices[0] ?? "unknown");
  }, [opponentChoices]);

  // ---- Auto-analyze when initial selection is provided ----
  // (Keeps the manual Analyze button as the v1 trigger; no debounce yet.)

  function buildInput(): DeckInput | null {
    if (mode === "preset") {
      const spec = presets.find((p) => p.id === presetId);
      if (!spec) return null;
      const cards = buildDeck(spec);
      return { cards, source: "preset", sourceName: spec.name };
    }
    if (mode === "saved") {
      const saved = imports.find((d) => d.id === savedId);
      if (!saved) return null;
      return { cards: saved.cards, source: "saved", sourceName: saved.name };
    }
    // paste
    if (!pasteText.trim()) return null;
    const importResult = importDecklist(pasteText);
    const pasteNotices = pasteNoticesFromImport(importResult, ctx);
    return {
      cards: importResult.deck,
      source: "paste",
      sourceName: "Pasted decklist",
      entries: importResult.entries,
      parseErrors: importResult.parseErrors,
      unmatched: importResult.unmatched,
      pasteNotices,
    };
  }

  function onAnalyze(): void {
    const input = buildInput();
    if (!input) {
      setAnalysis(null);
      setMeta(null);
      setUserDeck([]);
      return;
    }
    const a = analyzeDeck(input, ctx);
    setAnalysis(a);
    setUserDeck(input.cards);
    setMeta(analyzeMeta(a, input.cards, snapshot, ctx, opponent));
  }

  // Re-run meta analysis when the opponent picker changes — keeps Matchups
  // tab live without forcing a full re-analyze.
  useEffect(() => {
    if (!analysis) return;
    setMeta(analyzeMeta(analysis, userDeck, snapshot, ctx, opponent));
    // intentional: re-derive on opponent change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opponent]);

  async function onCopy(): Promise<void> {
    if (!analysis) return;
    const report = composeReport(analysis, {
      generatedAt: new Date().toISOString(),
      datasetAsOf,
      doctorVersion: DOCTOR_VERSION,
    });
    // Build the Meta-section payload for the serializer when meta analysis
    // exists and the snapshot is usable.
    const metaSection: SerializedMetaSection | undefined =
      meta && meta.snapshot && meta.snapshot.usableForGrades
        ? {
            metaGrade: meta.metaGrade,
            matchupGrade: meta.matchupGrade,
            matchupGradeAgainst: meta.matchupGradeAgainst,
            expectedWinRate: meta.expectedWinRate,
            expectedWinRateRange: meta.expectedWinRateRange,
            metaConfidence: meta.metaConfidence,
            fieldCoverage: meta.fieldCoverage,
            stockMissingCore: meta.stockListFindings
              .filter((f) => f.id === "stock.missing-core")
              .map((f) => f.cardName),
            techMissingClasses: meta.techCoverageFindings.map((f) =>
              f.title.replace(/^Missing answer:\s*/, ""),
            ),
            snapshot: {
              id: meta.snapshot.id,
              coversThrough: meta.snapshot.coversThrough,
              dataAgeDays: meta.snapshot.dataAgeDays,
              quality: meta.snapshot.quality,
            },
          }
        : undefined;
    const text = serializeDoctorReport(report, metaSection);
    try {
      await navigator.clipboard.writeText(text);
      setCopyHint("Copied to clipboard.");
      setShowFallback(false);
      setTimeout(() => setCopyHint(""), 2000);
    } catch {
      // Clipboard blocked (non-secure context, permissions). Fall back to
      // a textarea with the text pre-selected.
      setFallbackText(text);
      setShowFallback(true);
    }
  }

  const findings = analysis?.findings ?? [];
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  const suggestions = findings.filter((f) => f.severity === "suggestion");

  // Sanity: the dataset must be loaded for the analyzer to work. The app
  // awaits loadCards() before rendering so this should always be true here,
  // but if someone opens the doctor extra-early we still render gracefully.
  const datasetReady = allCards.length > 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal deck-doctor-modal"
        role="dialog"
        aria-label="Deck Doctor"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Deck Doctor</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {!datasetReady && (
          <div className="dd-loading">Loading card dataset…</div>
        )}

        {/* Top-level tabs — Analyze vs Browse. "Browse" lets the user
            inspect any matchup in the field data without analyzing a
            specific deck first (e.g. "did Crustle beat Ogerpon in
            round 4 like the matrix says it should?"). */}
        <div className="dd-toptabs" role="tablist" aria-label="Doctor mode">
          <button
            type="button"
            role="tab"
            aria-selected={topTab === "analyze"}
            className={topTab === "analyze" ? "active" : ""}
            onClick={() => setTopTab("analyze")}
          >
            Analyze a deck
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={topTab === "browse"}
            className={topTab === "browse" ? "active" : ""}
            onClick={() => setTopTab("browse")}
          >
            Browse matchups
          </button>
        </div>

        {topTab === "browse" && (
          <MatchupBrowser
            hero={browseHero}
            villain={browseVillain}
            onChangeHero={setBrowseHero}
            onChangeVillain={setBrowseVillain}
          />
        )}

        {topTab === "analyze" && (
        <div className="deck-doctor-body">
          {/* ---- Input pane ---- */}
          <div className="dd-input">
            <div className="dd-mode" role="tablist" aria-label="Deck source">
              {(["preset", "saved", "paste"] as InputMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  className={mode === m ? "active" : ""}
                  onClick={() => setMode(m)}
                >
                  {m === "preset" ? "Preset" : m === "saved" ? "Saved" : "Paste PTCGL"}
                </button>
              ))}
            </div>

            {mode === "preset" && (
              <label className="dd-field">
                <span>Preset deck</span>
                <select
                  aria-label="Preset deck"
                  value={presetId}
                  onChange={(e) => setPresetId(e.target.value)}
                >
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {mode === "saved" && (
              imports.length > 0 ? (
                <label className="dd-field">
                  <span>Saved deck</span>
                  <select
                    aria-label="Saved deck"
                    value={savedId}
                    onChange={(e) => setSavedId(e.target.value)}
                  >
                    {imports.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="muted dd-empty">
                  No saved decks yet — import or build one in the deck builder.
                </div>
              )
            )}

            {mode === "paste" && (
              <label className="dd-field">
                <span>Paste PTCGL decklist</span>
                <textarea
                  aria-label="Paste decklist"
                  rows={12}
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder={"Pokémon: 4\n4 Pikachu ex SSP 73\n…"}
                />
              </label>
            )}

            <div className="dd-actions">
              <button
                type="button"
                className="primary"
                onClick={onAnalyze}
                aria-label="Analyze"
              >
                Analyze
              </button>
              {analysis && (
                <button
                  type="button"
                  onClick={() => void onCopy()}
                  aria-label="Copy report"
                >
                  Copy report
                </button>
              )}
              {copyHint && <span className="muted dd-copy-hint">{copyHint}</span>}
            </div>

            {showFallback && (
              <div className="dd-clipboard-fallback">
                <p className="muted">
                  Clipboard access blocked — press Ctrl+C / Cmd+C to copy.
                </p>
                <textarea
                  ref={(el) => {
                    if (el) el.select();
                  }}
                  rows={8}
                  readOnly
                  value={fallbackText}
                  aria-label="Report text fallback"
                />
              </div>
            )}
          </div>

          {/* ---- Report pane (3 tabs: Structure / Matchups / Meta) ---- */}
          <div className="dd-report">
            {analysis ? (
              <>
                <div className="dd-tabs" role="tablist" aria-label="Report sections">
                  {(["structure", "matchups", "meta"] as ReportTab[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      role="tab"
                      aria-selected={tab === t}
                      aria-controls={`dd-tabpanel-${t}`}
                      className={tab === t ? "active" : ""}
                      onClick={() => setTab(t)}
                    >
                      {t === "structure" ? "Structure" : t === "matchups" ? "Matchups" : "Meta"}
                    </button>
                  ))}
                </div>
                {tab === "structure" && (
                  <div
                    id="dd-tabpanel-structure"
                    role="tabpanel"
                    aria-label="Structure"
                  >
                    <DoctorReportView
                      analysis={analysis}
                      errors={errors}
                      warnings={warnings}
                      suggestions={suggestions}
                    />
                  </div>
                )}
                {tab === "matchups" && (
                  <div
                    id="dd-tabpanel-matchups"
                    role="tabpanel"
                    aria-label="Matchups"
                  >
                    <MatchupsTab
                      meta={meta}
                      hero={analysis.archetype.id}
                      opponent={opponent}
                      onChangeOpponent={setOpponent}
                      opponentChoices={opponentChoices}
                      hasUsableSnapshot={!!snapshot && snapshot.usableForGrades}
                    />
                  </div>
                )}
                {tab === "meta" && (
                  <div
                    id="dd-tabpanel-meta"
                    role="tabpanel"
                    aria-label="Meta"
                  >
                    <MetaTab meta={meta} snapshot={snapshot} />
                  </div>
                )}
              </>
            ) : (
              <div className="muted dd-empty">
                Select a source and click Analyze to see feedback.
              </div>
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

interface ReportViewProps {
  analysis: DeckAnalysis;
  errors: Finding[];
  warnings: Finding[];
  suggestions: Finding[];
}

function DoctorReportView({
  analysis,
  errors,
  warnings,
  suggestions,
}: ReportViewProps) {
  const c = analysis.composition;
  return (
    <>
      <section
        className="dd-game-plan"
        aria-label="Game plan"
        role="region"
      >
        <header className="dd-game-plan-header">
          <h3>
            {analysis.noMajorIssues
              ? "Looks solid — here are some tuning ideas"
              : "Game plan"}
          </h3>
          <span className="dd-archetype">
            Archetype: <strong>{analysis.archetype.id}</strong>{" "}
            <em>({analysis.archetype.confidence})</em>
          </span>
        </header>
        <div className="dd-composition">
          <div className="dd-composition-row">
            Pokémon {c.pokemon} · Trainer {c.trainer} · Energy {c.energy} · Basics{" "}
            {c.basics}
          </div>
          {c.attackersMain.length > 0 && (
            <div className="dd-composition-row">
              <strong>Main attackers:</strong> {c.attackersMain.join(", ")}
            </div>
          )}
          {c.drawEngines.length > 0 && (
            <div className="dd-composition-row">
              <strong>Draw / search engines:</strong> {c.drawEngines.join(", ")}
            </div>
          )}
          {c.searchPokemon.length > 0 && (
            <div className="dd-composition-row">
              <strong>Search items:</strong> {c.searchPokemon.join(", ")}
            </div>
          )}
          {c.gustEffects.length > 0 && (
            <div className="dd-composition-row">
              <strong>Gust:</strong> {c.gustEffects.join(", ")}
            </div>
          )}
          {c.switchOrPivot.length > 0 && (
            <div className="dd-composition-row">
              <strong>Switch / pivot:</strong> {c.switchOrPivot.join(", ")}
            </div>
          )}
          {c.notes.map((n, i) => (
            <div key={i} className="dd-note">
              {n}
            </div>
          ))}
        </div>
        {analysis.priorities.length > 0 && !analysis.noMajorIssues && (
          <div className="dd-priorities">
            <h4>Top priorities</h4>
            {analysis.priorities.map((f, i) => (
              <FindingRow key={i} f={f} compact />
            ))}
          </div>
        )}
      </section>

      <Section title="Problems" findings={errors} severity="error" />
      <Section title="Risks" findings={warnings} severity="warning" />
      <Section
        title="Suggestions"
        findings={suggestions}
        severity="suggestion"
      />
    </>
  );
}

function Section({
  title,
  findings,
  severity,
}: {
  title: string;
  findings: Finding[];
  severity: Severity;
}) {
  if (findings.length === 0) return null;
  return (
    <section className="dd-section" aria-label={title}>
      <h3>
        {SEVERITY_META[severity].icon} {title} ({findings.length})
      </h3>
      {findings.map((f, i) => (
        <FindingRow key={i} f={f} />
      ))}
    </section>
  );
}

// ---- Matchups tab --------------------------------------------------------

interface MatchupsTabProps {
  meta: MetaAnalysis | null;
  hero: Archetype | "unknown";
  opponent: Archetype | "unknown";
  onChangeOpponent: (a: Archetype | "unknown") => void;
  opponentChoices: Array<Archetype | "unknown">;
  hasUsableSnapshot: boolean;
}

function MatchupsTab({
  meta,
  hero,
  opponent,
  onChangeOpponent,
  opponentChoices,
  hasUsableSnapshot,
}: MatchupsTabProps) {
  if (!meta) return null;
  const grade = meta.matchupGrade;
  const ci = meta.matchupCi95;
  return (
    <section className="dd-section" aria-label="Matchups">
      <header className="dd-game-plan-header">
        <h3>Matchups</h3>
        <label className="dd-field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 11 }}>
            {hasUsableSnapshot ? "Opponent" : "Opponent (no meta data available)"}
          </span>
          <select
            aria-label="Opponent archetype"
            value={opponent}
            onChange={(e) => onChangeOpponent(e.target.value as Archetype)}
          >
            {opponentChoices.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      </header>
      <div className="dd-grade-banner" data-grade={grade}>
        <strong>Matchup grade:</strong> {grade}
        {ci && meta.expectedWinRate !== undefined && (
          <span className="muted" style={{ marginLeft: 8 }}>
            (winRate with Wilson CI range —{" "}
            {formatPct(ci.low)}–{formatPct(ci.high)})
          </span>
        )}
        {meta.matchupSampleSize !== undefined && (
          <span className="muted" style={{ marginLeft: 8 }}>
            · sample {meta.matchupSampleSize} ({meta.matchupConfidence})
          </span>
        )}
      </div>
      <p className="muted dd-static-disclaimer">
        Static matchup checks: {STATIC_MATCHUP_DISCLAIMER}
      </p>
      {meta.matchupChecks.length === 0 ? (
        <div className="muted dd-empty">No data — pick an opponent and re-analyze.</div>
      ) : (
        meta.matchupChecks.map((c, i) => <MatchupCheckRow key={i} c={c} />)
      )}
      <FieldDataSection hero={hero} villain={opponent} />
    </section>
  );
}

// ---- Matchup browser (standalone, no deck analysis required) -----------
//
// Top-level entry that bypasses the deck-analysis flow. The user picks
// any (hero, villain) pair from the wired archetype list and the same
// FieldDataSection renders below — drill-down + round filter included.
// This is the "I just want to look at the matchup matrix" path.
//
// Available archetypes are derived from the cells file: only archetypes
// the aggregator has actually seen show up in the picker. Hides the
// "I added a slug to the union but no real games exist for it yet"
// case from the user.

interface MatchupBrowserProps {
  hero: Archetype | "unknown";
  villain: Archetype | "unknown";
  onChangeHero: (a: Archetype | "unknown") => void;
  onChangeVillain: (a: Archetype | "unknown") => void;
}

function MatchupBrowser({
  hero,
  villain,
  onChangeHero,
  onChangeVillain,
}: MatchupBrowserProps) {
  // Archetypes the aggregator has labeled-pair data for — sorted by
  // total game count so the most-represented decks float to the top of
  // the picker.
  const archetypeOptions = useMemo(() => {
    const counts = new Map<Archetype | "unknown", number>();
    for (const cell of aggregateCells.cells) {
      counts.set(cell.hero, (counts.get(cell.hero) ?? 0) + cell.sampleSize);
    }
    return [...counts.entries()]
      .filter(([k]) => k !== "unknown") // unknown can't be picked as a hero/villain
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
  }, []);
  return (
    <div className="dd-browse">
      <div className="dd-browse-header">
        <h3>Matchup browser</h3>
        <p className="muted" style={{ fontSize: 11, margin: "4px 0 0 0" }}>
          Pick any pair of wired archetypes. Drill-down shows every labeled
          game from the cached Regionals — including who won, the projected
          matchup, and links to the published decklists.
        </p>
      </div>
      <div className="dd-browse-controls">
        <label className="dd-field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 11 }}>Hero</span>
          <select
            aria-label="Hero archetype"
            value={hero}
            onChange={(e) => onChangeHero(e.target.value as Archetype)}
          >
            {archetypeOptions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">vs</span>
        <label className="dd-field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 11 }}>Villain</span>
          <select
            aria-label="Villain archetype"
            value={villain}
            onChange={(e) => onChangeVillain(e.target.value as Archetype)}
          >
            {archetypeOptions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      </div>
      <FieldDataSection hero={hero} villain={villain} />
    </div>
  );
}

// ---- Field data section (drill-down + round filter) ----------------------
//
// Sits below the static matchup checks in the Matchups tab. Pulls from the
// committed aggregator output (src/data/aggregates/*.json) — a separate data
// source from the meta snapshot's matchupMatrix. The cells file is eager-
// loaded (small); pairings.json is lazy-loaded the first time the user
// expands the drill-down.
//
// Round filter (Strategy 3B from the design doc) is a Skill-handicap
// approximation: filtering out R1-R4 removes the noisy bottom-third of the
// field where deck-vs-deck winrates are skewed by skill disparity. The cell
// recomputes client-side via tallyMatchupFromPairings + wilson95FromTally,
// so the user sees both the raw winrate AND the filtered one with a delta.

interface FieldDataSectionProps {
  hero: Archetype | "unknown";
  villain: Archetype | "unknown";
}

function FieldDataSection({ hero, villain }: FieldDataSectionProps) {
  const [pairings, setPairings] = useState<PairingRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minRound, setMinRound] = useState<number>(1); // 1 = all rounds
  const [expanded, setExpanded] = useState(false);

  // Lazy-load pairings.json the first time the section is expanded.
  useEffect(() => {
    if (!expanded || pairings || loading) return;
    setLoading(true);
    loadPairings()
      .then((p) => {
        setPairings(p);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e?.message ?? e));
        setLoading(false);
      });
  }, [expanded, pairings, loading]);

  // Raw cell from cells.json (no filtering).
  const rawCell = useMemo<AggregateCell | null>(() => {
    return (
      aggregateCells.cells.find((c) => c.hero === hero && c.villain === villain) ??
      null
    );
  }, [hero, villain]);

  // Drill-down: pairings for (hero vs villain), filtered by round.
  const allMatchupPairings = useMemo(() => {
    if (!pairings) return null;
    return pairingsForMatchup(pairings, hero, villain);
  }, [pairings, hero, villain]);
  const filteredPairings = useMemo(() => {
    if (!allMatchupPairings) return null;
    return filterByMinRound(allMatchupPairings, minRound);
  }, [allMatchupPairings, minRound]);

  // Recomputed cell stats from the filtered pairings (for the "round-filtered
  // win rate" display). Uses the same Wilson math as the aggregator.
  const filteredStats = useMemo(() => {
    if (!filteredPairings) return null;
    const t = tallyMatchupFromPairings(filteredPairings, hero, villain);
    const total = t.wins + t.losses + t.ties;
    if (total === 0) return null;
    const effectiveWins = t.wins + 0.5 * t.ties;
    const stats = wilson95FromTally(effectiveWins, total);
    return { ...t, total, ...stats };
  }, [filteredPairings, hero, villain]);

  if (hero === "unknown" || villain === "unknown" || hero === villain) {
    return null;
  }
  if (!rawCell || rawCell.sampleSize === 0) {
    return (
      <div className="dd-section-inner">
        <h4>Tournament games</h4>
        <p className="muted">
          No labeled tournament pairings for {hero} vs {villain} in the current
          aggregate. Re-run the weekend refresh skill to pull more events.
        </p>
      </div>
    );
  }

  return (
    <div className="dd-section-inner dd-field-data">
      <div className="dd-field-header">
        <h4>Tournament games — {hero} vs {villain}</h4>
        <span className="muted">
          {rawCell.sampleSize} games across the cached Regional cache
        </span>
      </div>

      <div className="dd-field-stats">
        <div>
          <strong>Raw:</strong>{" "}
          {formatPct(rawCell.winRate)}{" "}
          <span className="muted">
            (CI {formatPct(rawCell.ci95Low)}–{formatPct(rawCell.ci95High)}, n={rawCell.sampleSize})
          </span>
        </div>
        {filteredStats && minRound > 1 && (
          <div>
            <strong>Round {minRound}+:</strong>{" "}
            {formatPct(filteredStats.winRate)}{" "}
            <span className="muted">
              (CI {formatPct(filteredStats.ci95Low)}–{formatPct(filteredStats.ci95High)}, n={filteredStats.total})
            </span>
            <RoundFilterDelta raw={rawCell.winRate} filtered={filteredStats.winRate} />
          </div>
        )}
      </div>

      <div className="dd-field-controls">
        <label className="dd-field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 11 }}>Round filter</span>
          <select
            aria-label="Minimum round filter"
            value={minRound}
            onChange={(e) => setMinRound(parseInt(e.target.value, 10))}
          >
            <option value={1}>All rounds</option>
            <option value={5}>Round 5+ (skip bottom-third)</option>
            <option value={7}>Round 7+ (Day 2 cut)</option>
          </select>
        </label>
        <button
          className="link-button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? "Hide games" : "View individual games"}
        </button>
      </div>

      {expanded && (
        <div className="dd-pairing-list" role="region" aria-label="Individual tournament games">
          {loading && <div className="muted">Loading pairings…</div>}
          {error && <div className="muted">Failed to load pairings: {error}</div>}
          {filteredPairings && filteredPairings.length === 0 && (
            <div className="muted">No games match the current filter.</div>
          )}
          {filteredPairings && filteredPairings.length > 0 && (
            <PairingTable
              pairings={filteredPairings}
              hero={hero}
              villain={villain}
              projectedWinRate={rawCell.winRate}
            />
          )}
        </div>
      )}
    </div>
  );
}

function RoundFilterDelta({ raw, filtered }: { raw: number; filtered: number }) {
  const delta = filtered - raw;
  if (Math.abs(delta) < 0.005) return null;
  const pct = (delta * 100).toFixed(1);
  const sign = delta > 0 ? "+" : "";
  const color = delta > 0 ? "#7cd180" : "#e57373";
  return (
    <span style={{ color, marginLeft: 8, fontSize: 11 }}>
      ({sign}{pct} pp vs raw)
    </span>
  );
}

interface PairingTableProps {
  pairings: PairingRecord[];
  hero: Archetype | "unknown";
  villain: Archetype | "unknown";
  projectedWinRate: number;
}

function PairingTable({ pairings, hero, villain, projectedWinRate }: PairingTableProps) {
  // Sort: event then round, oldest first. Stable ordering helps the user
  // scan a particular player's arc across rounds.
  const sorted = useMemo(
    () =>
      [...pairings].sort(
        (a, b) => a.eventName.localeCompare(b.eventName) || a.round - b.round,
      ),
    [pairings],
  );

  // The "favorite" archetype for this cell — the one expected to win > 50%.
  const favorite: Archetype | "unknown" = projectedWinRate >= 0.5 ? hero : villain;

  // Track which rows are expanded (decklists visible). Multiple rows can
  // be open at once so the user can compare two games side-by-side.
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const toggleRow = (i: number) => {
    setExpandedRows((cur) => {
      const next = new Set(cur);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  // Lazy-load decklists when the user expands the first row. Map is
  // shared across all expansions — keyed by labs decklistUrl.
  const [decklists, setDecklists] = useState<Record<string, DecklistRecord> | null>(null);
  const [decklistsLoading, setDecklistsLoading] = useState(false);
  useEffect(() => {
    if (expandedRows.size === 0 || decklists || decklistsLoading) return;
    setDecklistsLoading(true);
    loadDecklists()
      .then((d) => {
        setDecklists(d);
        setDecklistsLoading(false);
      })
      .catch(() => setDecklistsLoading(false));
  }, [expandedRows.size, decklists, decklistsLoading]);

  return (
    <table className="dd-pairing-table">
      <thead>
        <tr>
          <th></th>
          <th>Event</th>
          <th>Rd</th>
          <th>Player ({hero})</th>
          <th></th>
          <th>Player ({villain})</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((p, i) => {
          // Resolve hero / villain to the actual p1 / p2 sides.
          const heroIsP1 = p.p1.archetype === hero;
          const heroPlayer = heroIsP1 ? p.p1 : p.p2;
          const villainPlayer = heroIsP1 ? p.p2 : p.p1;
          // Outcome from hero's perspective.
          const heroResult: "win" | "loss" | "tie" =
            p.result === "tie"
              ? "tie"
              : heroIsP1
              ? p.result
              : p.result === "win"
              ? "loss"
              : "win";
          const winner: Archetype | "unknown" =
            heroResult === "win" ? hero : heroResult === "loss" ? villain : "unknown";
          const upset =
            heroResult !== "tie" && winner !== favorite && winner !== "unknown";
          const isOpen = expandedRows.has(i);
          return (
            <Fragment key={i}>
              <tr className={upset ? "dd-pairing-upset" : undefined}>
                <td className="dd-pairing-toggle">
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => toggleRow(i)}
                    aria-expanded={isOpen}
                    aria-label={isOpen ? "Hide decklists" : "Show decklists"}
                    title={isOpen ? "Hide decklists" : "Show decklists"}
                  >
                    {isOpen ? "▼" : "▶"}
                  </button>
                </td>
                <td className="dd-pairing-event">
                  {abbreviateEvent(p.eventName)}
                </td>
                <td>{p.round}</td>
                <td className="dd-pairing-player">
                  {heroPlayer.name}
                  {heroPlayer.country && <span className="muted"> [{heroPlayer.country}]</span>}
                  {heroPlayer.finalRecord && (
                    <span className="muted"> · {heroPlayer.finalRecord}</span>
                  )}
                </td>
                <td className="dd-pairing-vs">vs</td>
                <td className="dd-pairing-player">
                  {villainPlayer.name}
                  {villainPlayer.country && <span className="muted"> [{villainPlayer.country}]</span>}
                  {villainPlayer.finalRecord && (
                    <span className="muted"> · {villainPlayer.finalRecord}</span>
                  )}
                </td>
                <td className={`dd-pairing-result dd-result-${heroResult}`}>
                  {heroResult === "win" ? "W" : heroResult === "loss" ? "L" : "T"}
                  {upset && (
                    <span
                      className="dd-pairing-upset-flag"
                      title="Underdog won relative to projected matchup"
                    >
                      {" "}
                      ✱
                    </span>
                  )}
                </td>
              </tr>
              {isOpen && (
                <tr className="dd-pairing-decklists-row">
                  <td></td>
                  <td colSpan={6}>
                    <PairingDecklists
                      hero={hero}
                      villain={villain}
                      heroPlayer={heroPlayer}
                      villainPlayer={villainPlayer}
                      decklists={decklists}
                      loading={decklistsLoading}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

// ---- Inline decklists for an expanded pairing row -----------------------

interface PairingDecklistsProps {
  hero: Archetype | "unknown";
  villain: Archetype | "unknown";
  heroPlayer: PairingRecord["p1"];
  villainPlayer: PairingRecord["p2"];
  decklists: Record<string, DecklistRecord> | null;
  loading: boolean;
}

function PairingDecklists({
  hero,
  villain,
  heroPlayer,
  villainPlayer,
  decklists,
  loading,
}: PairingDecklistsProps) {
  const heroList = heroPlayer.decklistUrl ? decklists?.[heroPlayer.decklistUrl] : undefined;
  const villainList = villainPlayer.decklistUrl
    ? decklists?.[villainPlayer.decklistUrl]
    : undefined;
  return (
    <div className="dd-pairing-decklists">
      <DeckColumn
        archetype={hero}
        playerName={heroPlayer.name}
        decklistUrl={heroPlayer.decklistUrl}
        list={heroList}
        loading={loading}
      />
      <DeckColumn
        archetype={villain}
        playerName={villainPlayer.name}
        decklistUrl={villainPlayer.decklistUrl}
        list={villainList}
        loading={loading}
      />
    </div>
  );
}

function DeckColumn({
  archetype,
  playerName,
  decklistUrl,
  list,
  loading,
}: {
  archetype: Archetype | "unknown";
  playerName: string;
  decklistUrl: string | null;
  list?: DecklistRecord;
  loading: boolean;
}) {
  return (
    <div className="dd-deck-column">
      <div className="dd-deck-header">
        <strong>{playerName}</strong> <span className="muted">· {archetype}</span>
        {decklistUrl && (
          <a
            className="dd-deck-link"
            href={decklistUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open on Limitless TCG"
          >
            ↗
          </a>
        )}
      </div>
      {!decklistUrl && (
        <div className="muted dd-deck-empty">No decklist published.</div>
      )}
      {decklistUrl && !list && loading && (
        <div className="muted dd-deck-empty">Loading decklist…</div>
      )}
      {decklistUrl && !list && !loading && (
        <div className="muted dd-deck-empty">
          Decklist data not in the local cache — run{" "}
          <code>npm run snapshot:fetch-limitless-decklists</code> to download.
        </div>
      )}
      {list && (
        <div className="dd-deck-list">
          <DeckSection title={`Pokémon (${sectionCount(list.pokemon)})`} entries={list.pokemon} />
          <DeckSection title={`Trainer (${sectionCount(list.trainer)})`} entries={list.trainer} />
          <DeckSection title={`Energy (${sectionCount(list.energy)})`} entries={list.energy} />
          <div className="muted dd-deck-total">Total: {decklistTotalCount(list)} cards</div>
        </div>
      )}
    </div>
  );
}

function sectionCount(entries: Array<{ count: number }>): number {
  return entries.reduce((a, e) => a + e.count, 0);
}

function DeckSection({
  title,
  entries,
}: {
  title: string;
  entries: Array<{ count: number; name: string; set: string; number: string }>;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="dd-deck-section">
      <div className="dd-deck-section-title">{title}</div>
      <ul className="dd-deck-entries">
        {entries.map((e, i) => (
          <li key={i}>
            <span className="dd-deck-count">{e.count}</span>{" "}
            <span className="dd-deck-name">{e.name}</span>{" "}
            <span className="muted dd-deck-set">
              {e.set} {e.number}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Compact event labels for the pairing table.
//
// The aggregator now sources event names from labs ("Regional Championship
// Los Angeles") rather than rk9's generic page title ("Tournament Pairings
// - RK9"). We further compress "Regional Championship X" → "X Regional"
// to keep the column readable — the city is the load-bearing part for
// users scanning the table.
function abbreviateEvent(name: string): string {
  if (!name) return "?";
  // Strip the legacy RK9 placeholder if it slipped through.
  const cleaned = name.replace(/Tournament Pairings - RK9.*/i, "RK9").trim();
  // "Regional Championship Prague" → "Prague Regional"
  const m = cleaned.match(/^Regional Championship\s+(.+?)\s*$/i);
  if (m) {
    const city = m[1].replace(/\s+\d{4}\s*$/, "").trim();
    return `${city} Regional`;
  }
  if (cleaned.length <= 24) return cleaned;
  return cleaned.slice(0, 24) + "…";
}

function MatchupCheckRow({ c }: { c: MatchupCheck }) {
  return (
    <div className="dd-finding" data-severity={c.severity}>
      <div className="dd-finding-title">{c.title}</div>
      <div className="dd-finding-detail">{c.detail}</div>
      {c.evidence && c.evidence.length > 0 && (
        <ul className="dd-finding-evidence">
          {c.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Meta tab ------------------------------------------------------------

interface MetaTabProps {
  meta: MetaAnalysis | null;
  snapshot: MetaSnapshot | null;
}

function MetaTab({ meta, snapshot }: MetaTabProps) {
  if (!meta) return null;
  const snap = meta.snapshot;
  return (
    <section className="dd-section" aria-label="Meta">
      {!snap || !snapshot ? (
        <div className="muted dd-empty">
          No meta snapshot available. Static feedback is in Structure / Matchups tabs.
        </div>
      ) : (
        <>
          {snap.unusable ? (
            <div className="dd-banner dd-banner-error">
              Meta snapshot is unusable ({snap.dataAgeDays} days old, quality{" "}
              {snap.quality}). Meta grade unavailable; list-level signals still
              apply below.
            </div>
          ) : snap.stale ? (
            <div className="dd-banner dd-banner-warn">
              Snapshot is {snap.dataAgeDays} days old — meta may have shifted.
            </div>
          ) : null}
          <div className="dd-snapshot-header">
            <strong>{snap.id}</strong> · data covers through{" "}
            {snap.coversThrough} ({snap.dataAgeDays} days old) · file generated{" "}
            {snap.generatedAgeDays} days ago.
          </div>
          {!snap.unusable && (
            <div className="dd-grade-banner" data-grade={meta.metaGrade}>
              <strong>Meta grade: {META_GRADE_LABEL[meta.metaGrade]}</strong>
              {meta.expectedWinRate !== undefined && (
                <>
                  {" · expected WR "}
                  <strong>{formatPct(meta.expectedWinRate)}</strong>
                  {meta.expectedWinRateRange && (
                    <span className="muted">
                      {" "}(weighted range {formatPct(meta.expectedWinRateRange.low)}
                      –{formatPct(meta.expectedWinRateRange.high)})
                    </span>
                  )}
                </>
              )}
              {meta.fieldCoverage !== undefined && (
                <span className="muted" style={{ marginLeft: 6 }}>
                  · field coverage {formatPct(meta.fieldCoverage)}
                </span>
              )}
              <span className="muted" style={{ marginLeft: 6 }}>
                · {meta.metaConfidence} confidence
              </span>
            </div>
          )}
          <p className="muted dd-static-disclaimer">
            This grade reflects the archetype into the field. List-specific
            feedback is below.
          </p>

          <details className="dd-methodology">
            <summary>Methodology &amp; coverage</summary>
            <p>{snapshot.methodology}</p>
            <ul>
              <li>Online: {formatPct(snapshot.onlineShare)} · offline: {formatPct(snapshot.offlineShare)}</li>
              <li>Bo1: {formatPct(snapshot.bo1Share)} · Bo3: {formatPct(snapshot.bo3Share)}</li>
              <li>Snapshot-wide matchup coverage: {formatPct(snapshot.matchupCoverageShare)}</li>
              <li>Unknown-archetype share: {formatPct(snapshot.unknownArchetypeShare)}</li>
            </ul>
            {snapshot.coverageNotes.length > 0 && (
              <ul>
                {snapshot.coverageNotes.map((n, i) => (
                  <li key={i}>
                    <strong>{n.category}</strong> ({n.count})
                    {n.detail ? ` — ${n.detail}` : null}
                  </li>
                ))}
              </ul>
            )}
            {snapshot.sources.length > 0 && (
              <p className="muted">
                Sources: {snapshot.sources.slice(0, 3).join(", ")}
                {snapshot.sources.length > 3 ? "…" : ""}
              </p>
            )}
          </details>

          {meta.stockListFindings.length > 0 && (
            <div className="dd-section-inner">
              <h4>Stock list comparison</h4>
              {meta.stockListFindings.map((f, i) => (
                <div key={i} className="dd-finding" data-severity={f.severity}>
                  <div className="dd-finding-title">
                    {f.cardName ? `${f.cardName}` : "Stock list"}
                  </div>
                  <div className="dd-finding-detail">{f.detail}</div>
                </div>
              ))}
            </div>
          )}

          {meta.techCoverageFindings.length > 0 && (
            <div className="dd-section-inner">
              <h4>Top missing tech</h4>
              {meta.techCoverageFindings.map((c, i) => (
                <MatchupCheckRow key={i} c={c} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function FindingRow({ f, compact }: { f: Finding; compact?: boolean }) {
  return (
    <div className={`dd-finding${compact ? " compact" : ""}`} data-severity={f.severity}>
      <div className="dd-finding-title">
        <span className="dd-finding-icon">{SEVERITY_META[f.severity].icon}</span>
        {f.title}
      </div>
      <div className="dd-finding-detail">{f.detail}</div>
      {f.evidence && f.evidence.length > 0 && (
        <ul className="dd-finding-evidence">
          {f.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {f.fix && f.fix.length > 0 && (
        <details className="dd-finding-fix">
          <summary>Fix</summary>
          <ul>
            {f.fix.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
