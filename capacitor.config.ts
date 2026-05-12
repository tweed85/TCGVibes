import type { CapacitorConfig } from "@capacitor/cli";

// Capacitor wraps the built React app in a native iOS shell. The Vite build
// outputs to dist/, which Capacitor copies into the native app on `cap sync`.
//
// Initial setup (once CocoaPods is installed via `sudo gem install cocoapods`):
//   1. npm run build               # produces dist/
//   2. npx cap add ios             # generates ios/ Xcode project (one-time)
//   3. npx cap sync ios            # copies dist/ + plugins
//   4. npx cap open ios            # launches Xcode
//
// On subsequent dev cycles after the Xcode project exists:
//   npm run build && npx cap sync ios && npx cap open ios
//
// Offline play works out of the box — the service worker (vite-plugin-pwa)
// precaches the app shell + dataset, and runtime-caches card images.

const config: CapacitorConfig = {
  appId: "com.pandabananas.tcg",
  appName: "PandaBananasTCG",
  webDir: "dist",
  ios: {
    // Limitless's CDN serves card images over HTTPS, so no ATS exception
    // needed. Leave this minimal until we have a concrete iOS-only need.
    contentInset: "always",
  },
};

export default config;
