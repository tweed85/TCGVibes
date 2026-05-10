// Replay history modal — shows past games stored locally via the
// persistence layer. Each row exposes Download (serialize the stored
// replay to JSON via the same blob pattern App.tsx uses for the
// active-game export) and Delete. Phase D adds an Upload button per
// row, gated on the cloud-upload setting.
//
// Lives in its own file + default export so App.tsx can React.lazy-load
// it — the modal is only shown when the user opens it from the Game
// menu, and the deck-builder split-pattern keeps the boot bundle thin.

import { useEffect, useState } from "react";
import { deleteReplay, loadReplays, type StoredReplay } from "../data/persistence";

interface Props {
  onClose: () => void;
  /** v2.4 (Phase D) — when true, rows show an Upload button for replays
   *  that haven't successfully uploaded yet. */
  cloudUploadEnabled?: boolean;
  /** v2.4 (Phase D) — caller-supplied upload trigger so this modal stays
   *  decoupled from the Supabase client. Returns the new uploaded state
   *  for the row (true if successful) so the modal can refresh. */
  onUpload?: (row: StoredReplay) => Promise<void>;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function describeOutcome(row: StoredReplay): string {
  const o = row.replay.outcome;
  if (!o) return "—";
  if (o.winner === null) return "Draw";
  return o.winner === "p1" ? "P1 win" : "P2 win";
}

function downloadReplay(row: StoredReplay): void {
  const blob = new Blob([JSON.stringify(row.replay, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pandabananastcg-replay-${row.localId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ReplayHistoryModal({
  onClose,
  cloudUploadEnabled = false,
  onUpload,
}: Props) {
  const [rows, setRows] = useState<StoredReplay[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const refresh = async () => {
    setRows(await loadReplays());
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleDelete = async (localId: string) => {
    await deleteReplay(localId);
    await refresh();
  };

  const handleUpload = async (row: StoredReplay) => {
    if (!onUpload) return;
    setBusy((s) => new Set(s).add(row.localId));
    try {
      await onUpload(row);
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(row.localId);
        return n;
      });
      await refresh();
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal replay-history-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Replays</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          {rows.length === 0 ? (
            <p className="muted">
              No replays yet. Finish a game and it'll show up here.
            </p>
          ) : (
            <table className="replay-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Mode</th>
                  <th>Outcome</th>
                  <th>Turns</th>
                  <th aria-label="Actions"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const o = row.replay.outcome;
                  const turnCount = row.replay.commands.filter(
                    (c) => c.kind === "endTurn",
                  ).length;
                  const showUpload =
                    cloudUploadEnabled && !row.uploaded && !!onUpload;
                  return (
                    <tr key={row.localId}>
                      <td>{formatDate(o?.completedAt ?? row.replay.createdAt)}</td>
                      <td>{o?.gameMode ?? "—"}</td>
                      <td>{describeOutcome(row)}</td>
                      <td>{turnCount}</td>
                      <td className="replay-row-actions">
                        <button onClick={() => downloadReplay(row)}>
                          Download
                        </button>
                        {showUpload && (
                          <button
                            onClick={() => handleUpload(row)}
                            disabled={busy.has(row.localId)}
                            title={row.uploadError ?? "Upload to the shared corpus"}
                          >
                            {busy.has(row.localId)
                              ? "Uploading…"
                              : row.uploadError
                                ? "Retry"
                                : "Upload"}
                          </button>
                        )}
                        {row.uploaded && (
                          <span className="muted" title={`Uploaded ${formatDate(row.uploadedAt)}`}>
                            ✓ uploaded
                          </span>
                        )}
                        <button
                          className="danger"
                          onClick={() => handleDelete(row.localId)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
