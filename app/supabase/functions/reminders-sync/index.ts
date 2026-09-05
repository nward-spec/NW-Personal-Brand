// Supabase Edge Function: the only thing that talks to iCloud.
//
//   POST { action: "connect", appleId, password }  store encrypted credentials, list reminder lists, sync
//   POST { action: "sync" }                          push pending app edits, pull iCloud state
//   POST { action: "dinners", list }                 choose which list is the Dinners tab
//   POST { action: "disconnect" }                    forget credentials and tombstone mirrored rows
//
// Secrets: ICLOUD_KEY (32 random bytes, base64) plus the platform-provided
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { CalDav, CalDavError } from './caldav.ts';
import { decrypt, encrypt } from './crypto.ts';
import { runSync, type ReminderRow } from './sync.ts';

declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (req: Request) => Promise<Response> | Response): void };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

interface AccountRow {
  user_id: string;
  apple_id: string;
  password_enc: string;
  principal_url: string | null;
  home_url: string | null;
  dinners_list: string;
  last_sync_at: string | null;
  last_error: string | null;
  lists: string[];
}

const publicAccount = (a: AccountRow) => ({ appleId: a.apple_id, dinnersList: a.dinners_list, lists: a.lists ?? [], lastSyncAt: a.last_sync_at, lastError: a.last_error });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const key = Deno.env.get('ICLOUD_KEY');
  if (!url || !anon || !service || !key) return json({ error: 'Function is missing configuration (ICLOUD_KEY?)' }, 500);

  // Who is calling? Verify the user's JWT with the anon client.
  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json({ error: 'Not signed in' }, 401);
  const userId = userData.user.id;

  const admin = createClient(url, service, { auth: { persistSession: false } });
  let body: { action?: string; appleId?: string; password?: string; list?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }

  const loadAccount = async (): Promise<AccountRow | null> => {
    const { data, error } = await admin.from('icloud_accounts').select('*').eq('user_id', userId).maybeSingle();
    if (error) throw new Error(error.message);
    return (data as AccountRow | null) ?? null;
  };

  const db = {
    async loadRows(): Promise<ReminderRow[]> {
      const { data, error } = await admin.from('reminders').select('data, updated_at').eq('user_id', userId);
      if (error) throw new Error(error.message);
      return (data ?? []).map((r: { data: ReminderRow; updated_at: string }) => ({ ...r.data, updatedAt: new Date(r.updated_at).toISOString() }));
    },
    async saveRows(rows: ReminderRow[]) {
      const payload = rows.map((r) => ({ user_id: userId, uid: r.uid, data: r, pending: r.pending, updated_at: r.updatedAt }));
      const { error } = await admin.from('reminders').upsert(payload, { onConflict: 'user_id,uid' });
      if (error) throw new Error(error.message);
    },
  };

  const syncWith = async (account: AccountRow) => {
    const password = await decrypt(key, account.password_enc);
    const dav = new CalDav(fetch, { username: account.apple_id, password });
    let home = account.home_url;
    if (!home) {
      const principal = await dav.discoverPrincipal();
      home = await dav.discoverHome(principal);
      await admin.from('icloud_accounts').update({ principal_url: principal, home_url: home }).eq('user_id', userId);
    }
    try {
      const result = await runSync({ dav, db, homeUrl: home, log: (m) => console.log(m) });
      const patch = { last_sync_at: new Date().toISOString(), last_error: result.errors.length ? result.errors.join(' · ') : null, lists: result.lists, updated_at: new Date().toISOString() };
      await admin.from('icloud_accounts').update(patch).eq('user_id', userId);
      return { result, account: publicAccount({ ...account, ...patch }) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await admin.from('icloud_accounts').update({ last_error: msg, updated_at: new Date().toISOString() }).eq('user_id', userId);
      throw err;
    }
  };

  try {
    switch (body.action) {
      case 'connect': {
        const appleId = (body.appleId ?? '').trim();
        const password = (body.password ?? '').trim();
        if (!appleId || !password) return json({ error: 'Apple ID and app-specific password are required' }, 400);
        const dav = new CalDav(fetch, { username: appleId, password });
        const principal = await dav.discoverPrincipal();
        const home = await dav.discoverHome(principal);
        const lists = (await dav.listCalendars(home)).filter((c) => c.supportsTodo).map((c) => c.name);
        if (lists.length === 0) return json({ error: 'Signed in, but iCloud exposed no reminder lists over CalDAV for this account.' }, 422);
        const existing = await loadAccount();
        const dinners = existing?.dinners_list && lists.includes(existing.dinners_list) ? existing.dinners_list : (lists.find((l) => /dinner|meal/i.test(l)) ?? lists[0]);
        const row: AccountRow = {
          user_id: userId,
          apple_id: appleId,
          password_enc: await encrypt(key, password),
          principal_url: principal,
          home_url: home,
          dinners_list: dinners,
          last_sync_at: null,
          last_error: null,
          lists,
        };
        const { error } = await admin.from('icloud_accounts').upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
        if (error) return json({ error: error.message }, 500);
        return json(await syncWith(row));
      }
      case 'sync': {
        const account = await loadAccount();
        if (!account) return json({ error: 'Apple Reminders is not connected' }, 404);
        return json(await syncWith(account));
      }
      case 'dinners': {
        const account = await loadAccount();
        if (!account) return json({ error: 'Apple Reminders is not connected' }, 404);
        const list = (body.list ?? '').trim();
        if (!list) return json({ error: 'List name required' }, 400);
        const { error } = await admin.from('icloud_accounts').update({ dinners_list: list, updated_at: new Date().toISOString() }).eq('user_id', userId);
        if (error) return json({ error: error.message }, 500);
        return json({ account: publicAccount({ ...account, dinners_list: list }) });
      }
      case 'disconnect': {
        const now = new Date().toISOString();
        const rows = await db.loadRows();
        if (rows.length) await db.saveRows(rows.filter((r) => !r.deleted).map((r) => ({ ...r, deleted: true, pending: null, updatedAt: now })));
        const { error } = await admin.from('icloud_accounts').delete().eq('user_id', userId);
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true });
      }
      default:
        return json({ error: `Unknown action "${body.action ?? ''}"` }, 400);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = err instanceof CalDavError ? (err.status === 401 || err.status === 403 ? 401 : 502) : 500;
    console.error(msg);
    return json({ error: msg }, status);
  }
});
