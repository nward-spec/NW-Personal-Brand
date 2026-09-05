/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** Injected at build time from package.json (see vite.config.ts). */
declare const __APP_VERSION__: string;
/** Build timestamp (ISO), injected at build time. */
declare const __BUILD_TIME__: string;
