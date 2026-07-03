# Remote error telemetry — setup

Lets you see errors from all ~20 users automatically (as rows in a Google
Sheet) instead of relying on colleagues to describe what went wrong.

## 1. Create the sink (one-time, ~5 minutes)

1. Go to [sheets.google.com](https://sheets.google.com) and create a new
   blank spreadsheet. Name it something like "Ariba Extension - Error Reports".
2. Extensions → Apps Script.
3. Delete the placeholder `Code.gs` content and paste in the contents of
   `telemetry/apps_script.gs` from this repo.
4. Save the project (any name).
5. Deploy → New deployment → gear icon → select type **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone** (required — the extension calls this
     anonymously with no Google login; access is only to *write*, since the
     script only exposes `doPost`, there's no read endpoint exposed publicly)
6. Click Deploy, authorize the permissions prompt (it's your own script), and
   copy the **Web app URL** (ends in `/exec`).

## 2. Wire it into the extension

Open `shared/constants.js` and set:

```js
var TELEMETRY_ENDPOINT = 'https://script.google.com/macros/s/XXXXXXXX/exec';
```

Bump the extension version in `manifest.json`, then publish to the Chrome
Web Store as usual. Once colleagues update, every error (and any manual
"🐞 Report a problem" click) shows up as a new row in the "Reports" tab of
your spreadsheet — supplier name, filename/message, stack trace, extension
version, and browser user-agent included.

## 3. Redeploying after editing apps_script.gs

Apps Script requires a **new deployment version** for code changes to take
effect on the existing URL:

Deploy → Manage deployments → pencil/edit icon on the existing deployment →
Version: **New version** → Deploy.

(Creating a brand new deployment instead would change the URL, which would
require updating `TELEMETRY_ENDPOINT` again — prefer editing the existing one.)

## Notes

- If `TELEMETRY_ENDPOINT` is left blank, the extension still keeps the last
  50 events in `chrome.storage.local` (key `debugLog`) per machine — useful
  for asking a colleague to open DevTools and run
  `chrome.storage.local.get('debugLog', console.log)` manually, but nothing
  gets sent anywhere.
- The sheet has no read authentication by design (only `doPost` is
  implemented, there's no `doGet` that returns data) — but treat the sheet
  itself as containing internal supplier names, so keep sharing on it
  restricted to people who should see that.
