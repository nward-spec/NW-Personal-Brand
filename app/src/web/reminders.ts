// Apple Reminders connection state, and when to ask the server to sync with
// iCloud. The server function is the only thing that talks to iCloud; this
// module just decides when to call it and shows what it said.

import { useSyncExternalStore } from 'react';
import { store } from './app-store';
import { cloud, cloudStore } from './cloud';
import { supabase } from './supabase';

export interface RemindersAccount {
  appleId: string;
  dinnersList: string;
  lists: string[];
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface SyncSummary {
  lists: string[];
  pushed: number;
  pulled: number;
  tombstoned: number;
  errors: string[];
}

export interface RemindersState {
  /** Cloud sync is configured and the user is signed in. */
  available: boolean;
  loading: boolean;
  account: RemindersAccount | null;
  syncing: boolean;
  error: string | null;
  last: SyncSummary | null;
}

let state: RemindersState = { available: false, loading: false, account: null, syncing: false, error: null, last: null };
const listeners = new Set<() => void>();
function set(patch: Partial<RemindersState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useReminders(): RemindersState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

function client() {
  if (!supabase) throw new Error('Cloud sync is not configured for this build.');
  return supabase;
}

type Action = { action: 'connect'; appleId: string; password: string } | { action: 'sync' } | { action: 'disconnect' } | { action: 'dinners'; list: string };

async function call(body: Action): Promise<{ account?: RemindersAccount; result?: SyncSummary }> {
  const { data, error } = await client().functions.invoke('reminders-sync', { body });
  if (error) {
    // Supabase wraps non-2xx responses; surface the function's own message when it sent one.
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const j = (await ctx.json()) as { error?: string };
        if (j.error) throw new Error(j.error);
      } catch (e) {
        if (e instanceof Error && e.message && !/JSON/.test(e.message)) throw e;
      }
    }
    throw new Error(error.message || 'Sync failed');
  }
  if (data && typeof data === 'object' && 'error' in data && (data as { error?: string }).error) throw new Error((data as { error: string }).error);
  return (data ?? {}) as { account?: RemindersAccount; result?: SyncSummary };
}

let syncTimer: ReturnType<typeof setTimeout> | undefined;
let inFlight: Promise<void> | null = null;

/** Pull the connection row (never the secret) for the signed-in user. */
async function refreshAccount() {
  set({ loading: true });
  try {
    const { data, error } = await client().from('icloud_accounts').select('apple_id, dinners_list, lists, last_sync_at, last_error').maybeSingle();
    if (error) throw new Error(error.message);
    set({
      loading: false,
      account: data
        ? { appleId: data.apple_id as string, dinnersList: data.dinners_list as string, lists: (data.lists as string[]) ?? [], lastSyncAt: (data.last_sync_at as string | null) ?? null, lastError: (data.last_error as string | null) ?? null }
        : null,
    });
  } catch (err) {
    set({ loading: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * One full round: push the app's row edits to the database, have the server
 * talk to iCloud, then pull the rewritten rows back into the app.
 */
async function syncRound() {
  if (!state.account) return;
  if (inFlight) return inFlight;
  set({ syncing: true, error: null });
  inFlight = (async () => {
    try {
      await cloud.syncNow();
      const { result, account } = await call({ action: 'sync' });
      await cloud.syncNow();
      set({ last: result ?? null, account: account ?? state.account, error: result?.errors.length ? result.errors.join(' · ') : null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ syncing: false });
      inFlight = null;
    }
  })();
  return inFlight;
}

function scheduleSync(delayMs: number) {
  if (!state.account) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    void syncRound();
  }, delayMs);
}

export const reminders = {
  refresh: refreshAccount,
  syncNow: () => syncRound(),
  async connect(appleId: string, password: string) {
    set({ syncing: true, error: null });
    try {
      const { account, result } = await call({ action: 'connect', appleId: appleId.trim(), password: password.trim() });
      set({ account: account ?? null, last: result ?? null });
      await cloud.syncNow();
      return result;
    } finally {
      set({ syncing: false });
    }
  },
  async disconnect() {
    await call({ action: 'disconnect' });
    set({ account: null, last: null, error: null });
    await cloud.syncNow();
  },
  async setDinnersList(list: string) {
    const { account } = await call({ action: 'dinners', list });
    set({ account: account ?? (state.account ? { ...state.account, dinnersList: list } : null) });
  },
};

// ---- Wiring: react to sign-in, edits, and the app coming to the foreground ----

if (supabase) {
  let lastUser: string | null = null;
  const subscribe = () => {
    const check = () => {
      const c = cloudStore.get();
      const user = c.user?.id ?? null;
      set({ available: !!user });
      if (user && user !== lastUser) {
        lastUser = user;
        void refreshAccount().then(() => scheduleSync(500));
      } else if (!user && lastUser) {
        lastUser = null;
        set({ account: null, last: null });
      }
    };
    cloudStore.subscribe(check);
    check();
  };
  subscribe();

  // Edits to reminder rows: give the user a moment, then round-trip.
  store.onDirty((key) => {
    if (key.startsWith('reminder:')) scheduleSync(2500);
  });

  const onForeground = () => {
    if (document.visibilityState === 'visible' && state.account) {
      const last = state.account.lastSyncAt ? Date.parse(state.account.lastSyncAt) : 0;
      if (Date.now() - last > 60_000) scheduleSync(300);
    }
  };
  document.addEventListener('visibilitychange', onForeground);
  window.addEventListener('focus', onForeground);
  window.addEventListener('online', onForeground);
}
