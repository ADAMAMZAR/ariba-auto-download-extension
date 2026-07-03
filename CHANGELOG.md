# Changelog

All notable changes to **GPO - Automatic Certificate Checker** are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Version numbers follow [Semantic Versioning](https://semver.org/):
- **Patch** (`x.x.N`) — bug fixes, RPC ID updates, zero new behaviour
- **Minor** (`x.N.0`) — new features, backwards-compatible improvements
- **Major** (`N.0.0`) — breaking changes

---

## [2.6.6] — 2026-07-03

### Fixed
- Filename sanitizer no longer swallows the file extension's dot when a
  supplier name ends in "Pty Ltd" (e.g. `...Pty Ltd.pdf` was becoming
  `...P-Lpdf` instead of `...P-L.pdf`).

### Added
- Remote error telemetry: download/upload failures across content.js,
  notebooklm_kit.js, and background.js are now automatically reported (plus
  a manual "🐞 Report a problem" button in the popup), so issues reported by
  colleagues can be diagnosed without needing access to their machine.
- Error reports now include the supplier name — automatically for errors
  during a download run (read from the same `.supplier-name` element used
  for the QA extraction), and as an editable field on the manual "Report a
  problem" form.

## [2.1.0] — 2026-06-03

### Added
- `shared/constants.js` — single source of truth for all NotebookLM RPC IDs (`rLM1Ne`, `tGMBJ`, `b7Wfje`, `o4cbdc`, `s0tc2d`, `agX4Bc`, `le8sX`), API base URLs, download root folder name, popup dimensions, and upload batch size. A rotating RPC ID now requires a one-line change in one file.
- `notebooklm/nlm_runner.js` — extracted from the 400-line inline `executeScript` function in `background.js`. Fully lintable, debuggable, and version-controlled as a normal JS file.
- `shared/logger.js` — configurable debug logger with three tiers: `log()` (gated by `DEBUG` flag), `warn()`, `error()`. Replaces ~35 commented-out `console.log` calls.
- `createModal(title, loadingText)` factory in `notebooklm_kit.js` — eliminates ~90 lines of duplicated modal scaffold across `openManageModal`, `openRenameModal`, and `openLabelModal`.
- Re-entrant guard in `content/content.js` (`window.__aribaAutomationRunning`) — prevents double downloads if the user clicks the panel button twice rapidly.

### Changed
- **Folder structure adopted.** All files moved from flat root layout to:
  ```
  background/   content/   panel/   notebooklm/   shared/   icons/
  ```
- `background/background.js` — service worker path updated in `manifest.json`. All internal paths (panel URL, script injection `files:[]` arrays, `importScripts`) updated to reflect new locations.
- `panel/panel.js` — `executeScript files: ['content/content.js']` updated.
- `notebooklm/notebooklm_kit.js` — `chrome.runtime.getURL('notebooklm/nlm_inject.js')` updated.
- `manifest.json` — all `content_scripts`, `web_accessible_resources`, and `service_worker` paths updated.
- Step 0 (sync instructions) in `nlm_runner.js` now uses `getWizData()` for `bl=` and `f.sid=` instead of hardcoded stale values — consistent with Step 2 (file registration).

### Fixed
- **Screenshot overlay bug** — the full-page screenshot was capturing the automation loader modal instead of the Ariba page. The loader has been removed entirely; toast notifications (non-blocking, bottom-right) are the only remaining feedback mechanism.
- Silent `catch(e){}` blocks in `background.js` — bridge injection failures and session storage relay failures now surface as `console.warn` in the service worker DevTools.

### Removed
- Full-screen `#ariba-automation-loader` overlay from `content.js` (`showLoader`, `hideLoader`, `updateLoaderStatus`, `loaderStatusEl`, 138 lines total). `hideAribaLoader()` in `background.js` also removed along with all 4 call sites.

---

## [2.0.3] — 2026-06-03

### Changed
- Version bump (manual).

---

## [2.0.1] — prior

### Added
- Initial NotebookLM Kit integration (bulk delete, rename, label, sync instructions).
- Full-page screenshot via Chrome DevTools Protocol (debugger API).
- Ariba document auto-expansion and bulk download to named supplier folders.
- Panel UI with activity log and NotebookLM URL input.
