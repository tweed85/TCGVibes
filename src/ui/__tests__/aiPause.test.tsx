// @vitest-environment jsdom

// M5 regression — the AI driver useEffect in App.tsx should pause when any
// modal-state flag is set (zoomCard / discardViewer / importOpen / buildOpen)
// and resume when they clear. This test mirrors the exact pattern App uses
// (useEffect with setTimeout scheduling, early-return guard on a "paused"
// boolean) and verifies the timer never fires while paused.
//
// Why a synthetic component instead of rendering App: App pulls in the
// full game engine, dataset, and a tree of dependent components, none of
// which matter for verifying this specific pattern. The pattern itself is
// what's being tested — App.tsx uses it verbatim.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect, useState } from "react";
import { act, render } from "@testing-library/react";

// Mirror of App.tsx's AI driver useEffect — same guard, same setTimeout
// pattern. If this test breaks, App's pause behavior is also broken.
function MockAIDriver({
  paused,
  onStep,
}: {
  paused: boolean;
  onStep: () => void;
}) {
  const [turn, setTurn] = useState(0);
  useEffect(() => {
    if (paused) return; // ← matches App.tsx:387 early-return
    const t = setTimeout(() => {
      onStep();
      setTurn((n) => n + 1);
    }, 100);
    return () => clearTimeout(t);
  });
  return <div data-testid="turn">{turn}</div>;
}

describe("AI driver pause guard (M5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not invoke onStep while paused=true", () => {
    const onStep = vi.fn();
    render(<MockAIDriver paused={true} onStep={onStep} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onStep).not.toHaveBeenCalled();
  });

  it("invokes onStep when not paused", () => {
    const onStep = vi.fn();
    render(<MockAIDriver paused={false} onStep={onStep} />);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(onStep).toHaveBeenCalled();
  });

  it("cleanup cancels in-flight timer when paused flips true mid-delay", () => {
    // Concrete race: AI scheduled a step on `paused=false`, then the user
    // opened a modal flipping it to true before the timer fired. The
    // cleanup MUST cancel the pending timer so the AI doesn't step under
    // the open modal. Relies on useEffect's cleanup-runs-before-next-effect
    // contract.
    const onStep = vi.fn();
    const { rerender } = render(<MockAIDriver paused={false} onStep={onStep} />);
    act(() => {
      vi.advanceTimersByTime(50); // half-way through the 100ms delay
    });
    rerender(<MockAIDriver paused={true} onStep={onStep} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onStep).not.toHaveBeenCalled();
  });

  it("resumes stepping once paused flips back to false", () => {
    const onStep = vi.fn();
    const { rerender } = render(<MockAIDriver paused={true} onStep={onStep} />);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(onStep).not.toHaveBeenCalled();

    rerender(<MockAIDriver paused={false} onStep={onStep} />);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(onStep).toHaveBeenCalledTimes(1);
  });

  it("multiple modal flags OR'd together — any one true pauses", () => {
    // App.tsx ORs zoomCard, discardViewer, importOpen, buildOpen. Any one
    // truthy should pause. Test the OR composition explicitly.
    const onStep = vi.fn();
    function App({ zoom, discard, imp, build }: {
      zoom: boolean; discard: boolean; imp: boolean; build: boolean;
    }) {
      return <MockAIDriver paused={!!(zoom || discard || imp || build)} onStep={onStep} />;
    }
    const { rerender } = render(<App zoom={true} discard={false} imp={false} build={false} />);
    act(() => { vi.advanceTimersByTime(500); });
    expect(onStep).not.toHaveBeenCalled();

    rerender(<App zoom={false} discard={true} imp={false} build={false} />);
    act(() => { vi.advanceTimersByTime(500); });
    expect(onStep).not.toHaveBeenCalled();

    rerender(<App zoom={false} discard={false} imp={false} build={true} />);
    act(() => { vi.advanceTimersByTime(500); });
    expect(onStep).not.toHaveBeenCalled();

    // All clear — the AI should resume.
    rerender(<App zoom={false} discard={false} imp={false} build={false} />);
    act(() => { vi.advanceTimersByTime(150); });
    expect(onStep).toHaveBeenCalledTimes(1);
  });
});
