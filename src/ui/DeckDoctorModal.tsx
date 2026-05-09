// Deck Doctor — standalone modal.
//
// Three input modes (preset / saved / paste). The analyzer + composeReport
// produce a structured DoctorReport; the modal renders Game plan +
// Problems / Risks / Suggestions. "Copy report" serializes via
// serializeDoctorReport (the disclaimer line lives there, not in the
// structured report). Lazy-loaded via React.lazy in App.tsx.

import { useMemo, useState } from "react";
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
  onClose: () => void;
}

const ctx: DoctorContext = {
  get cardsByName() {
    return cardsByName;
  },
  gameplayKey,
};

type InputMode = "preset" | "saved" | "paste";

const SEVERITY_META: Record<Severity, { label: string; icon: string }> = {
  error: { label: "Problems", icon: "⛔" },
  warning: { label: "Risks", icon: "⚠" },
  suggestion: { label: "Suggestions", icon: "💡" },
};

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
  const [copyHint, setCopyHint] = useState<string>("");
  const [showFallback, setShowFallback] = useState<boolean>(false);
  const [fallbackText, setFallbackText] = useState<string>("");

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
      return;
    }
    const a = analyzeDeck(input, ctx);
    setAnalysis(a);
  }

  async function onCopy(): Promise<void> {
    if (!analysis) return;
    const report = composeReport(analysis, {
      generatedAt: new Date().toISOString(),
      datasetAsOf,
      doctorVersion: DOCTOR_VERSION,
    });
    const text = serializeDoctorReport(report);
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

          {/* ---- Report pane ---- */}
          <div className="dd-report">
            {analysis ? (
              <DoctorReportView
                analysis={analysis}
                errors={errors}
                warnings={warnings}
                suggestions={suggestions}
              />
            ) : (
              <div className="muted dd-empty">
                Select a source and click Analyze to see structural feedback.
              </div>
            )}
          </div>
        </div>
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
