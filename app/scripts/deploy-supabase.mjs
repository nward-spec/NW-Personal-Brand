// One-shot backend setup through the Supabase Management API.
//
//   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/deploy-supabase.mjs
//
// Creates (or reuses) a project called "weekly-journal", applies
// supabase/schema.sql, sets the ICLOUD_KEY secret, deploys the
// reminders-sync edge function, turns off email confirmation so sign-up is
// instant, and writes .env.production with the project URL and anon key.
//
// Optional env: SUPABASE_ORG_ID, SUPABASE_PROJECT_NAME, SUPABASE_REGION
// (default ap-southeast-2 Sydney), SITE_URL (for auth redirects).

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.supabase.com/v1';
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) {
  console.error('SUPABASE_ACCESS_TOKEN is required (create one at https://supabase.com/dashboard/account/tokens)');
  process.exit(1);
}
const NAME = process.env.SUPABASE_PROJECT_NAME ?? 'weekly-journal';
const REGION = process.env.SUPABASE_REGION ?? 'ap-southeast-2';

async function api(method, path, body, raw = false) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  if (raw) return text;
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);

async function main() {
  // 1. Organisation
  const orgs = await api('GET', '/organizations');
  const org = process.env.SUPABASE_ORG_ID ? orgs.find((o) => o.id === process.env.SUPABASE_ORG_ID) : orgs[0];
  if (!org) throw new Error('No Supabase organisation found for this token');
  log(`Organisation: ${org.name} (${org.id})`);

  // 2. Project (reuse by name)
  const projects = await api('GET', '/projects');
  let project = projects.find((p) => p.name === NAME && p.organization_id === org.id);
  let dbPass = process.env.SUPABASE_DB_PASSWORD;
  if (!project) {
    dbPass = dbPass ?? randomBytes(24).toString('base64url');
    log(`Creating project "${NAME}" in ${REGION}…`);
    project = await api('POST', '/projects', { organization_id: org.id, name: NAME, db_pass: dbPass, region: REGION, plan: 'free' });
    const secretsFile = join(root, '.supabase-project.json');
    writeFileSync(secretsFile, JSON.stringify({ ref: project.id, db_pass: dbPass, created: new Date().toISOString() }, null, 2));
    log(`Project ${project.id} created. Database password saved to ${secretsFile} (git-ignored).`);
  } else {
    log(`Reusing project ${project.id}`);
  }
  const ref = project.id;

  // 3. Wait until healthy
  for (let i = 0; i < 60; i++) {
    const p = await api('GET', `/projects/${ref}`);
    if (p.status === 'ACTIVE_HEALTHY') break;
    log(`  status ${p.status}, waiting…`);
    await sleep(10000);
  }

  // 4. Schema
  const sql = readFileSync(join(root, 'supabase', 'schema.sql'), 'utf8');
  log('Applying schema…');
  await api('POST', `/projects/${ref}/database/query`, { query: sql });

  // 5. Secrets
  const existing = await api('GET', `/projects/${ref}/secrets`);
  if (!existing.some((s) => s.name === 'ICLOUD_KEY')) {
    log('Setting ICLOUD_KEY secret…');
    await api('POST', `/projects/${ref}/secrets`, [{ name: 'ICLOUD_KEY', value: randomBytes(32).toString('base64') }]);
  } else log('ICLOUD_KEY already set');

  // 6. Edge function (Supabase CLI bundles and uploads via the API)
  log('Deploying reminders-sync function…');
  execSync(`npx --yes supabase@latest functions deploy reminders-sync --project-ref ${ref} --use-api --no-verify-jwt=false`, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: token },
  });

  // 7. Auth: instant sign-up, redirect URLs
  const siteUrl = process.env.SITE_URL;
  log('Configuring auth…');
  await api('PATCH', `/projects/${ref}/config/auth`, {
    mailer_autoconfirm: true,
    ...(siteUrl ? { site_url: siteUrl, uri_allow_list: [siteUrl, `${siteUrl}*`, 'http://localhost:5173/*', 'http://localhost:4173/*'].join(',') } : {}),
  });

  // 8. Front-end env
  const keys = await api('GET', `/projects/${ref}/api-keys`);
  const anon = keys.find((k) => k.name === 'anon')?.api_key;
  if (!anon) throw new Error('Could not read the anon key');
  const url = `https://${ref}.supabase.co`;
  const envFile = join(root, '.env.production');
  writeFileSync(envFile, `VITE_SUPABASE_URL=${url}\nVITE_SUPABASE_ANON_KEY=${anon}\n`);
  log(`Wrote ${envFile}`);
  if (!existsSync(join(root, '.env.local'))) writeFileSync(join(root, '.env.local'), readFileSync(envFile));

  console.log(`\nDone.\n  Project: ${url}\n  Dashboard: https://supabase.com/dashboard/project/${ref}\n`);
}

main().catch((e) => {
  console.error('\nFailed:', e.message);
  process.exit(1);
});
