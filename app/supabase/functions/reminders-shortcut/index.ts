// Supabase Edge Function called by the "Journal Sync" iPhone Shortcut.
//
//   POST /functions/v1/reminders-shortcut
//   Authorization: Bearer <token from the app's Settings>
//   Body: plain text, one reminder per line: "title | list | due | completed"
//
// With `X-Journal-Format: json` it answers
//   { deletes: [{ index, title }], creates: [{ list, title, due, when }], undated: [{ list, title }], count }
// otherwise plain text, one command per line: "delete | index | title | ",
// "create | list | title | due".
// `X-Journal-Shortcut` carries the Shortcut's version, kept so the app can say
// when a phone still runs an old one. `POST …?ack=1` with a line of text
// appends to the run's report (what the Shortcut actually applied).
//
// Deployed with --no-verify-jwt: the Shortcut's token is checked here against
// the shortcut_links table using the service role.

import { createClient } from 'npm:@supabase/supabase-js@2';
import type { ReminderRow } from '../reminders-sync/sync.ts';
import { formatCommands, parseSnapshot, reconcile } from './reconcile.ts';

declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (req: Request) => Promise<Response> | Response): void };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-09-07" → "7 September 2026 at 9:00 am": a date Shortcuts' alert field reads without ambiguity. */
export function alertText(due: string): string {
  const [y, m, d] = due.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y} at 9:00 am`;
}

const text = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'GET') return text('Weekly Journal reminders bridge. POST a snapshot with your token.');
  if (req.method !== 'POST') return text('POST only', 405);

  const url = Deno.env.get('SUPABASE_URL');
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !service) return text('Function is missing configuration', 500);

  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim() || new URL(req.url).searchParams.get('token') || '';
  if (token.length < 16) return text('Missing sync token', 401);

  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { data: link, error: linkErr } = await admin.from('shortcut_links').select('user_id, dinners_list, last_report').eq('token', token).maybeSingle();
  if (linkErr) return text(linkErr.message, 500);
  if (!link) return text('Unknown sync token. Open the app → Settings → Apple Reminders and copy it again.', 401);
  const userId = link.user_id as string;

  if (new URL(req.url).searchParams.get('ack')) {
    // A progress line from the Shortcut: "reply deletes=1 …", "removed 3 Tacos", "added …", "done".
    const line = (await req.text()).trim().slice(0, 300);
    const previous = ((link.last_report as string | null) ?? '').split('\n').filter(Boolean).slice(-40);
    const report = [...previous, line].join('\n');
    await admin.from('shortcut_links').update({ last_report: report, updated_at: new Date().toISOString() }).eq('user_id', userId);
    console.log(`shortcut ack user=${userId} ${line}`);
    return text('ok');
  }

  try {
    const snapshot = parseSnapshot(await req.text());
    const { data, error } = await admin.from('reminders').select('data, updated_at').eq('user_id', userId);
    if (error) throw new Error(error.message);
    const rows: ReminderRow[] = (data ?? []).map((r: { data: ReminderRow; updated_at: string }) => ({ ...r.data, updatedAt: new Date(r.updated_at).toISOString() }));

    const result = reconcile({ rows, snapshot, newId: () => crypto.randomUUID().toUpperCase() });

    if (result.save.length) {
      const payload = result.save.map((r) => ({ user_id: userId, uid: r.uid, data: r, pending: r.pending, updated_at: r.updatedAt }));
      const { error: saveErr } = await admin.from('reminders').upsert(payload, { onConflict: 'user_id,uid' });
      if (saveErr) throw new Error(saveErr.message);
    }
    const shortcutVersion = (req.headers.get('X-Journal-Shortcut') ?? '').trim() || (req.headers.get('X-Journal-Format') ? '2' : '1');
    const current = (link.dinners_list as string) ?? 'Dinners';
    const dinners = result.lists.includes(current) ? current : (result.lists.find((l) => /dinner|meal|food/i.test(l)) ?? current);
    await admin
      .from('shortcut_links')
      .update({ lists: result.lists, dinners_list: dinners, shortcut_version: shortcutVersion, last_report: '', last_sync_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() })
      .eq('user_id', userId);

    console.log(`shortcut sync user=${userId} shortcut=v${shortcutVersion} snapshot=${snapshot.length} pulled=${result.pulled} commands=${result.commands.length} tombstoned=${result.tombstoned}`);
    if ((req.headers.get('X-Journal-Format') ?? '').toLowerCase() === 'json') {
      // Three plain lists: the Shortcut loops over each without any If action.
      const deletes = result.commands.flatMap((c) => (c.op === 'delete' ? [{ index: c.index, title: c.title }] : []));
      const creates = result.commands.flatMap((c) => (c.op === 'create' && c.due ? [{ list: c.list, title: c.title, due: c.due, when: alertText(c.due) }] : []));
      const undated = result.commands.flatMap((c) => (c.op === 'create' && !c.due ? [{ list: c.list, title: c.title }] : []));
      return new Response(JSON.stringify({ deletes, creates, undated, count: result.commands.length }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }
    return text(formatCommands(result.commands));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    await admin.from('shortcut_links').update({ last_error: msg, updated_at: new Date().toISOString() }).eq('user_id', userId);
    return text(`Sync failed: ${msg}`, 500);
  }
});
