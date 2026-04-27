import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { loadCards } from "./data/cards";

const root = ReactDOM.createRoot(document.getElementById("root")!);

function showError(message: string): void {
  root.render(
    <div style={{
      color: "#fca5a5",
      fontFamily: "system-ui",
      fontSize: 13,
      padding: 20,
      whiteSpace: "pre-wrap",
      lineHeight: 1.5,
    }}>
      <strong style={{ display: "block", marginBottom: 8, color: "#f87171" }}>
        Failed to start PandaBananasTCG
      </strong>
      {message}
    </div>,
  );
}

// Show a brief loader while the dataset chunk arrives, then mount the game.
// The dataset is the heaviest non-engine asset (~1.5MB JS / 166KB gzipped) and
// used to be eagerly bundled at module init.
root.render(
  <div style={{
    color: "#94a3b8",
    fontFamily: "system-ui",
    fontSize: 13,
    height: "100dvh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  }}>
    Loading PandaBananasTCG…
  </div>,
);

loadCards().then(
  () => {
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  },
  (err: unknown) => {
    showError(err instanceof Error ? `${err.name}: ${err.message}\n\n${err.stack ?? ""}` : String(err));
  },
);

// Service worker registration — production-only, and we register it AFTER
// the app has mounted so any SW-side hiccup never blocks the initial render.
// Wrapped in try/catch since some WebView contexts (older WKWebView, certain
// privacy modes) throw on virtual:pwa-register imports.
if (import.meta.env.PROD) {
  void (async () => {
    try {
      const { registerSW } = await import("virtual:pwa-register");
      registerSW({ immediate: true });
    } catch {
      // Service worker registration unavailable in this context (e.g. Capacitor
      // WKWebView). Offline support is still provided by Capacitor itself
      // bundling dist/ into the native app, so this isn't fatal.
    }
  })();
}
