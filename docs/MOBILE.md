# Mobile / iOS / offline

PWA + Capacitor scaffolding for mobile and offline play. See [../CLAUDE.md](../CLAUDE.md) for the project entry point.

- Capacitor scaffolded; `npx cap add ios` builds `dist/` into a
  WebView shell.
- PWA via vite-plugin-pwa: CacheFirst dataset + CDN images,
  NetworkFirst shell.
- Deck imports persist to IndexedDB; UI settings to localStorage.
- Mobile-responsive CSS: floating Stadium overlay, horizontal bench
  scroll with right-edge fade mask, right-to-left hand scroll with
  fade + scroll-snap, vertical action bar.
- Touch + safe-area hardening: `env(safe-area-inset-right)` baked
  into `.side` padding (clears iPhone X+ landscape notch and iPad
  Pro rounded corner); `touch-action: manipulation` on every
  interactive; landscape phones use 40px action-bar button minimum.
- Side-distinction tinting: opponent has a slightly darker bg + 1px
  red top accent.
- Narrow-width tightening (≤360px): pip min-width 14px,
  HP-badge font 11px; modal padding drops to 10px.
- Status-message dwell: ≥2.5s before allowing overwrite.
