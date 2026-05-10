// @vitest-environment jsdom
//
// ReplayHistoryModal — renders the local replay history table, handles
// delete, surfaces the cloud-upload button only when the parent passes
// an `onUpload` handler AND the cloud-upload toggle is enabled. The
// persistence layer is mocked at the module boundary so the test
// doesn't need fake-indexeddb.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, render, fireEvent, screen, waitFor } from "@testing-library/react";
import type { GameReplayV2 } from "../../engine/replay";

// vi.mock is hoisted above import statements, so any closed-over
// variables must be created via vi.hoisted to avoid the temporal-dead-
// zone error. The hoisted block runs BEFORE imports, so the mock
// factory can safely read state from it.
const mocks = vi.hoisted(() => {
  const state: { rows: unknown[] } = { rows: [] };
  const deleteSpy = vi.fn(async (localId: string) => {
    state.rows = state.rows.filter((r) => (r as { localId: string }).localId !== localId);
  });
  return { state, deleteSpy };
});

vi.mock("../../data/persistence", () => ({
  loadReplays: async () => mocks.state.rows,
  deleteReplay: mocks.deleteSpy,
}));

import ReplayHistoryModal from "../ReplayHistoryModal";

function mkReplay(localId: string, overrides: Partial<import("../../data/persistence").StoredReplay> = {}): import("../../data/persistence").StoredReplay {
  const replay: GameReplayV2 = {
    schemaVersion: 2,
    appVersion: "0.0.1",
    dataVersion: "2026-05-09",
    createdAt: "2026-05-09T12:00:00.000Z",
    initial: { p1CardIds: [], p2CardIds: [], rngSeed: 1 },
    commands: [{ kind: "endTurn", player: "p1" }, { kind: "endTurn", player: "p2" }],
    outcome: {
      winner: "p1",
      completedAt: "2026-05-09T13:00:00.000Z",
      gameMode: "vsCPU",
    },
  };
  return {
    localId,
    replay,
    uploaded: false,
    ...overrides,
  };
}

describe("ReplayHistoryModal", () => {
  beforeEach(() => {
    mocks.state.rows = [];
    mocks.deleteSpy.mockClear();
  });

  afterEach(() => {
    // RTL doesn't auto-cleanup under vitest unless globals.afterEach is wired
    // — without this, mounted modals leak across tests and `screen` queries
    // return rows from a previous render.
    cleanup();
  });

  it("renders empty state when there are no replays", async () => {
    const { findByText } = render(<ReplayHistoryModal onClose={() => {}} />);
    await findByText(/No replays yet/i);
  });

  it("renders rows newest-first with outcome and turn count", async () => {
    mocks.state.rows =[mkReplay("a"), mkReplay("b", { replay: { ...mkReplay("b").replay, outcome: { winner: "p2", completedAt: "2026-05-09T14:00:00.000Z", gameMode: "local" } } })];
    render(<ReplayHistoryModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(3)); // header + 2 rows
    expect(screen.getByText("P1 win")).toBeInTheDocument();
    expect(screen.getByText("P2 win")).toBeInTheDocument();
    // Both fixtures have 2 endTurn commands → turnCount=2.
    const turnCells = screen.getAllByRole("cell").filter((td) => td.textContent === "2");
    expect(turnCells.length).toBe(2);
  });

  it("Delete button calls deleteReplay and refreshes the list", async () => {
    mocks.state.rows =[mkReplay("a"), mkReplay("b")];
    render(<ReplayHistoryModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(3));
    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    fireEvent.click(deleteButtons[0]);
    await waitFor(() => expect(mocks.deleteSpy).toHaveBeenCalledWith("a"));
    // After refresh: header + 1 row.
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(2));
  });

  it("Upload button hidden when cloudUploadEnabled is false", async () => {
    mocks.state.rows =[mkReplay("a")];
    render(
      <ReplayHistoryModal
        onClose={() => {}}
        cloudUploadEnabled={false}
        onUpload={async () => {}}
      />,
    );
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(2));
    expect(screen.queryByRole("button", { name: /Upload|Retry/i })).toBeNull();
  });

  it("Upload button visible when cloudUploadEnabled AND row not yet uploaded", async () => {
    mocks.state.rows =[mkReplay("a", { uploaded: false })];
    const onUpload = vi.fn(async () => {});
    render(
      <ReplayHistoryModal
        onClose={() => {}}
        cloudUploadEnabled={true}
        onUpload={onUpload}
      />,
    );
    const uploadBtn = await screen.findByRole("button", { name: "Upload" });
    fireEvent.click(uploadBtn);
    await waitFor(() => expect(onUpload).toHaveBeenCalledWith(expect.objectContaining({ localId: "a" })));
  });

  it("uploadError surfaces in the button label as Retry and tooltip", async () => {
    mocks.state.rows =[
      mkReplay("a", { uploaded: false, uploadError: "503 Service Unavailable" }),
    ];
    render(
      <ReplayHistoryModal
        onClose={() => {}}
        cloudUploadEnabled={true}
        onUpload={async () => {}}
      />,
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(retry).toHaveAttribute("title", "503 Service Unavailable");
  });

  it("uploaded rows show the ✓ uploaded marker, no Upload button", async () => {
    mocks.state.rows =[mkReplay("a", { uploaded: true, uploadedAt: "2026-05-09T13:30:00.000Z", remoteId: "remote-1" })];
    render(
      <ReplayHistoryModal
        onClose={() => {}}
        cloudUploadEnabled={true}
        onUpload={async () => {}}
      />,
    );
    await screen.findByText(/✓ uploaded/);
    expect(screen.queryByRole("button", { name: /Upload|Retry/i })).toBeNull();
  });
});
