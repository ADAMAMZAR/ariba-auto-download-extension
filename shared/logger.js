// ============================================================
// shared/logger.js — Configurable debug logger
//
// Loaded in the same contexts as constants.js:
//   • background/background.js → importScripts('../shared/logger.js')
//   • content scripts via manifest content_scripts array
//   • MAIN world injections via executeScript files:[]
//
// Usage:
//   log('Some debug info', value);    // only prints when DEBUG = true
//   warn('Something suspicious');     // always prints
//   error('Something broke:', err);   // always prints
//
// To enable verbose logging for a dev build, flip DEBUG to true.
// ============================================================

// Use var so the symbols land on globalThis and are accessible
// from any script loaded in the same context (mirroring constants.js).

/** Set to true to enable verbose debug output in the DevTools console. */
var DEBUG = false;

/**
 * Debug-only log — silenced in production (DEBUG = false).
 * @param {...*} args
 */
var log = function () {
  if (DEBUG) {
    console.log('[Ariba Ext]', ...arguments);
  }
};

/**
 * Always-visible warning — use for recoverable unexpected conditions.
 * @param {...*} args
 */
var warn = function () {
  console.warn('[Ariba Ext]', ...arguments);
};

/**
 * Always-visible error — use for failures that affect functionality.
 * @param {...*} args
 */
var error = function () {
  console.error('[Ariba Ext]', ...arguments);
};
