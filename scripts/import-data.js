/* Copies the old Claude Artifact data (exported as migration/<collection>/<id>.json) into the new database.
   Accounts, password hashes, roles (including the Super Admin), role access, settings, sessions and sign-ups all move over.

   Usage (PowerShell), with the same variables the site uses:
     $env:UPSTASH_REDIS_REST_URL = "https://..."; $env:UPSTASH_REDIS_REST_TOKEN = "..."
     node scripts/import-data.js            # adds only what is missing
     node scripts/import-data.js --replace  # overwrites documents that already exist
   The migration folder holds password hashes: it is git-ignored. Do not commit or share it. */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('../api/_lib');

const dir = path.join(__dirname, '..', 'migration');
const replace = process.argv.includes('--replace');

(async () => {
  if (!process.env.UPSTASH_REDIS_REST_URL && !process.env.KV_REST_API_URL) {
    console.error('Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN first (see CLAUDE.md).');
    process.exit(1);
  }
  let added = 0, skipped = 0;
  for (const col of L.COLS) {
    const d = path.join(dir, col);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter(n => n.endsWith('.json'))) {
      const id = f.replace(/\.json$/, '');
      const doc = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
      const ok = replace
        ? (await L.one(['HSET', L.K(col), id, JSON.stringify(doc)]), true)
        : !!(await L.one(['HSETNX', L.K(col), id, JSON.stringify(doc)]));
      if (ok) added++; else skipped++;
      console.log((ok ? 'imported ' : 'kept     ') + col + '/' + id);
    }
  }
  await L.bump();
  console.log('\nDone: ' + added + ' imported, ' + skipped + ' already there.');
})().catch(e => { console.error(e.message); process.exit(1); });
