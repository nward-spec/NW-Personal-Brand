// Writes the unsigned "Journal Sync.shortcut" for a given sync token.
//
//   node --experimental-strip-types scripts/make-shortcut.mjs <token> [endpoint] [out.shortcut]
//
// Then sign it on a Mac (iOS refuses unsigned shortcut files):
//   shortcuts sign --mode anyone --input "Journal Sync.shortcut" --output "Journal Sync (signed).shortcut"

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildJournalSyncPlist } from '../src/core/shortcut-plist.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [token, endpointArg, outArg] = process.argv.slice(2);
if (!token) {
  console.error('usage: make-shortcut.mjs <token> [endpoint] [out]');
  process.exit(1);
}
let endpoint = endpointArg;
if (!endpoint) {
  const env = readFileSync(join(root, '.env.production'), 'utf8');
  const url = /VITE_SUPABASE_URL=(.+)/.exec(env)?.[1]?.trim();
  if (!url) throw new Error('No endpoint given and .env.production has no VITE_SUPABASE_URL');
  endpoint = `${url}/functions/v1/reminders-shortcut`;
}
const out = outArg ?? join(root, 'Journal Sync.shortcut');
writeFileSync(out, buildJournalSyncPlist({ endpoint, token }));
console.log(`wrote ${out} (endpoint ${endpoint})`);
