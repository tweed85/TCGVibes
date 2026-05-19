// Deck Doctor — standalone modal / workspace.
//
// Three input modes (preset / saved / paste). The analyzer + composeReport
// produce a structured DoctorReport; the modal renders Game plan +
// Problems / Risks / Suggestions. "Copy report" serializes via
// serializeDoctorReport (the disclaimer line lives there, not in the
// structured report). Lazy-loaded via React.lazy in App.tsx.

import { useEffect, useMemo, useState } from "react";
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

interface SavedDeck {
  id: string;
  name: string;
  entries: DeckListEntry[];
  cards: Card[];
}

export interface DeckDoctorModalProps {
  imports: SavedDeck[];
  initial?: { source: "preset" | "saved"; id: string };
  layout?: "modal" | "workspace";
  onClose: () => void;
}

const ctx: DoctorContext = {
  get cardsByName() {
    return cardsByName;
  },
  gameplayKey,
};

type InputMode = "preset" | "saved" | "paste";
type ReportTab = "structure" | "matchups" | "meta" | "field";

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
  layout = "modal",
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
        className={`modal deck-doctor-modal${layout === "workspace" ? " deck-doctor-workspace" : ""}`}
        role="dialog"
        aria-label="Deck Doctor"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2>Deck Doctor</h2>
            <div className="dd-title-subtitle">
              Competitive list analysis, matchup checks, and recent Limitless-informed meta context.
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {!datasetReady && (
          <div className="dd-loading">Loading card dataset…</div>
        )}

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

          {/* ---- Report pane (Structure / Matchups / Meta / Field) ---- */}
          <div className="dd-report">
            {analysis ? (
              <>
                <div className="dd-tabs" role="tablist" aria-label="Report sections">
                  {(["structure", "matchups", "meta", "field"] as ReportTab[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      role="tab"
                      aria-selected={tab === t}
                      aria-controls={`dd-tabpanel-${t}`}
                      className={tab === t ? "active" : ""}
                      onClick={() => setTab(t)}
                    >
                      {t === "structure"
                        ? "Structure"
                        : t === "matchups"
                          ? "Matchups"
                          : t === "meta"
                            ? "Meta"
                            : "Field"}
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
                {tab === "field" && (
                  <div
                    id="dd-tabpanel-field"
                    role="tabpanel"
                    aria-label="Field"
                  >
                    <FieldOverviewTab snapshot={snapshot} />
                  </div>
                )}
              </>
            ) : (
              <DeckDoctorHome snapshot={snapshot} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DeckDoctorHome({ snapshot }: { snapshot: MetaSnapshot | null }) {
  return (
    <>
      <section className="dd-hero-panel" aria-label="Deck Doctor overview">
        <div>
          <h3>Build for the field, not just the goldfish.</h3>
          <p>
            Paste a PTCGL or Limitless decklist, compare against recent stock lists,
            check matchup pressure, and see which archetypes and attackers are shaping
            the current Standard field.
          </p>
        </div>
        <div className="dd-hero-metrics" aria-label="Meta snapshot summary">
          <MetricPill label="Snapshot" value={snapshot?.id ?? "None"} />
          <MetricPill
            label="Events"
            value={snapshot ? String(snapshot.tournaments.length) : "0"}
          />
          <MetricPill
            label="Known field"
            value={snapshot ? formatPct(1 - snapshot.unknownArchetypeShare) : "—"}
          />
        </div>
      </section>
      <FieldOverviewTab snapshot={snapshot} />
    </>
  );
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="dd-metric-pill">
      <span>{label}</span>
      <strong>{value}</strong>
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
  opponent: Archetype | "unknown";
  onChangeOpponent: (a: Archetype | "unknown") => void;
  opponentChoices: Array<Archetype | "unknown">;
  hasUsableSnapshot: boolean;
}

function MatchupsTab({
  meta,
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
    </section>
  );
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

function FieldOverviewTab({ snapshot }: { snapshot: MetaSnapshot | null }) {
  if (!snapshot) {
    return (
      <section className="dd-section" aria-label="Field overview">
        <div className="muted dd-empty">
          No research-quality meta snapshot is available yet. Deck structure and
          static matchup checks still work once you analyze a list.
        </div>
      </section>
    );
  }

  const topArchetypes = [...snapshot.archetypes]
    .filter((a) => a.id !== "unknown")
    .sort((a, b) => b.metaShare - a.metaShare)
    .slice(0, 8);
  const recentTournaments = [...snapshot.tournaments]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);
  const cardSignals = snapshot.stockLists
    .flatMap((list) =>
      list.cards
        .filter((c) => c.role === "core" || c.role === "tech" || c.role === "spicy")
        .map((c) => ({ ...c, archetype: list.archetype, decksObserved: list.decksObserved })),
    )
    .sort((a, b) => {
      const roleScore = (role: string) => (role === "core" ? 3 : role === "tech" ? 2 : 1);
      return roleScore(b.role) - roleScore(a.role) || b.inclusionRate - a.inclusionRate;
    })
    .slice(0, 10);

  return (
    <section className="dd-section dd-field-overview" aria-label="Field overview">
      <header className="dd-game-plan-header">
        <h3>Competitive field</h3>
        <span className="dd-archetype">
          {snapshot.id} · through {snapshot.coversThrough.slice(0, 10)}
        </span>
      </header>

      <div className="dd-overview-grid">
        <div className="dd-overview-card">
          <h4>Most played archetypes</h4>
          <div className="dd-bar-list">
            {topArchetypes.map((a) => (
              <div key={a.id} className="dd-bar-row">
                <div className="dd-bar-label">
                  <span>{a.id}</span>
                  <strong>{formatPct(a.metaShare)}</strong>
                </div>
                <div className="dd-bar-track">
                  <div
                    className="dd-bar-fill"
                    style={{ width: `${Math.max(4, a.metaShare * 100)}%` }}
                  />
                </div>
                <div className="dd-mini-note">
                  sample {a.sampleSize} · {a.confidence}
                  {a.mainAttackerCards.length > 0
                    ? ` · ${a.mainAttackerCards.map((c) => c.cardName).join(", ")}`
                    : ""}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="dd-overview-card">
          <h4>Recent tournament inputs</h4>
          <div className="dd-tournament-list">
            {recentTournaments.map((t) => (
              <a
                key={t.id}
                href={t.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="dd-tournament-row"
              >
                <span>{t.name}</span>
                <strong>{t.playerCount} players</strong>
                <em>
                  {new Date(t.date).toLocaleDateString()} · {t.online ? "online" : "offline"} ·{" "}
                  {t.decklistVisibility}
                </em>
              </a>
            ))}
          </div>
        </div>

        <div className="dd-overview-card dd-overview-wide">
          <h4>Stock and tech signals</h4>
          <div className="dd-signal-grid">
            {cardSignals.map((c, i) => (
              <div key={`${c.archetype}-${c.cardName}-${i}`} className="dd-signal">
                <span>{c.role}</span>
                <strong>{c.cardName}</strong>
                <em>
                  {c.archetype} · {formatPct(c.inclusionRate)} inclusion · mode {c.modeCount}
                  {c.modeCountDecks ? ` in ${c.modeCountDecks} lists` : ""}
                </em>
              </div>
            ))}
          </div>
        </div>
      </div>

      <details className="dd-methodology">
        <summary>Limitless coverage notes</summary>
        <p>{snapshot.methodology}</p>
        <ul>
          <li>Online: {formatPct(snapshot.onlineShare)} · offline: {formatPct(snapshot.offlineShare)}</li>
          <li>Bo1: {formatPct(snapshot.bo1Share)} · Bo3: {formatPct(snapshot.bo3Share)}</li>
          <li>Known archetype share: {formatPct(1 - snapshot.unknownArchetypeShare)}</li>
          <li>Matchup coverage: {formatPct(snapshot.matchupCoverageShare)}</li>
        </ul>
      </details>
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
