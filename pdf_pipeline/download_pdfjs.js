/**
 * download_pdfjs.js
 * ─────────────────────────────────────────────────────────────────────────────
 * One-time setup script: downloads the pdf.js v4 build files into this folder.
 *
 * Run ONCE from the pdf_pipeline directory:
 *   node pdf_pipeline/download_pdfjs.js
 *
 * After this, the extension is fully self-contained and works offline.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const VERSION  = '3.11.174';
const BASE_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${VERSION}/build`;
const OUT_DIR  = __dirname;

const FILES = [
  'pdf.min.js',
  'pdf.worker.min.js',
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    // rejectUnauthorized: false bypasses corporate SSL-inspection proxy chains
    // that present a self-signed certificate when intercepting HTTPS traffic.
    const options = { rejectUnauthorized: false };
    https.get(url, options, (res) => {
      // Follow one redirect (jsDelivr often uses 301)
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(err);
    });
  });
}

(async () => {
  console.log(`Downloading pdf.js v${VERSION} bundle files...\n`);
  for (const filename of FILES) {
    const url  = `${BASE_URL}/${filename}`;
    const dest = path.join(OUT_DIR, filename);
    process.stdout.write(`  ${filename} ... `);
    try {
      await download(url, dest);
      const size = (fs.statSync(dest).size / 1024).toFixed(1);
      console.log(`✓  (${size} KB)`);
    } catch (err) {
      console.log(`✗  FAILED: ${err.message}`);
      process.exit(1);
    }
  }
  console.log('\nDone! pdf.js is ready. Reload the extension in Chrome.');
})();
