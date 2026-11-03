/* global __APP_VERSION__, __APP_BUILD__ */
// Injected by vite.config.js (package.json version + UTC build stamp); labs / node tests fall back to dev values.
export const VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
export const BUILD = typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : 'dev';
export const VERSION_LABEL = `v${VERSION} · ${BUILD}`;
