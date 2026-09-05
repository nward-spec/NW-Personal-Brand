// Apple Reminders connection state. Apple removed CalDAV access to Reminders
// in iOS 13, so the bridge is an iPhone Shortcut: it posts a snapshot of the
// reminders to the reminders-shortcut function and applies the commands it
// gets back. This module owns the link row (its token, the dinners list,
// last run) and knows how to launch the Shortcut from the app.

import { useSyncExternalStore } from 'react';
import { store } from './app-store';
import { cloud, cloudStore } from './cloud';
import { supabase } from './supabase';

export const SHORTCUT_NAME = 'Journal Sync';

export interface RemindersAccount {
  token: string;
  dinnersList: string;
  /** Reminders list whose undated items join the weekly to-do list. */
  todoList: string;
  lists: string[];
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface RemindersState {
  /** Cloud sync is configured and the user is signed in. */
  available: boolean;
  loading: boolean;
  account: RemindersAccount | null;
  syncing: boolean;
  error: string | null;
}

let state: RemindersState = { available: false, loading: false, account: null, syncing: false, error: null };
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

/** Where the Shortcut posts to. */
export function shortcutEndpoint(): string {
  return `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1/reminders-shortcut`;
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const rowToAccount = (data: Record<string, unknown>): RemindersAccount => ({
  token: data.token as string,
  dinnersList: data.dinners_list as string,
  todoList: (data.todo_list as string) ?? 'Reminders',
  lists: (data.lists as string[]) ?? [],
  lastSyncAt: (data.last_sync_at as string | null) ?? null,
  lastError: (data.last_error as string | null) ?? null,
});

async function refreshAccount() {
  set({ loading: true });
  try {
    const { data, error } = await client().from('shortcut_links').select('token, dinners_list, todo_list, lists, last_sync_at, last_error').maybeSingle();
    if (error) throw new Error(error.message);
    set({ loading: false, account: data ? rowToAccount(data) : null, error: null });
  } catch (err) {
    set({ loading: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Is this an iPhone or iPad, where the Shortcuts app exists? */
export function isApplePhone(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export const reminders = {
  refresh: refreshAccount,

  /** Create the link row with a fresh token. */
  async connect(): Promise<RemindersAccount> {
    const token = randomToken();
    const { data, error } = await client().from('shortcut_links').upsert({ token }, { onConflict: 'user_id' }).select('token, dinners_list, todo_list, lists, last_sync_at, last_error').single();
    if (error) throw new Error(error.message);
    const account = rowToAccount(data);
    set({ account, error: null });
    return account;
  },

  /** Forget the link. Mirrored reminders are removed from the app; nothing changes on the phone. */
  async disconnect() {
    const { error } = await client().from('shortcut_links').delete().neq('token', '');
    if (error) throw new Error(error.message);
    const now = new Date().toISOString();
    for (const r of Object.values(store.get().reminders)) {
      if (!r.deleted) store.setReminder({ ...r, deleted: true, pending: null, updatedAt: now });
    }
    set({ account: null, error: null });
    await cloud.syncNow();
  },

  async setTodoList(list: string) {
    const { error } = await client().from('shortcut_links').update({ todo_list: list, updated_at: new Date().toISOString() }).neq('token', '');
    if (error) throw new Error(error.message);
    if (state.account) set({ account: { ...state.account, todoList: list } });
  },

  async setDinnersList(list: string) {
    const { error } = await client().from('shortcut_links').update({ dinners_list: list, updated_at: new Date().toISOString() }).neq('token', '');
    if (error) throw new Error(error.message);
    if (state.account) set({ account: { ...state.account, dinnersList: list } });
  },

  /**
   * Push the app's edits to the database, then hand over to the Shortcut.
   * On an iPhone this opens the Shortcuts app; come back to the app afterwards
   * and the foreground handler pulls the rewritten rows.
   */
  async runShortcut() {
    set({ syncing: true, error: null });
    try {
      await cloud.syncNow();
      if (!isApplePhone()) throw new Error('The Shortcut runs on your iPhone or iPad. Open the app there and tap Sync.');
      // Plain run-shortcut, no x-callback: a callback URL would reopen the site in
      // Safari, which is a different sign-in from the installed app.
      window.location.href = `shortcuts://run-shortcut?name=${encodeURIComponent(SHORTCUT_NAME)}`;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTimeout(() => set({ syncing: false }), 1500);
    }
  },

  /** Pull whatever the Shortcut wrote, without launching it. */
  async pull() {
    await cloud.syncNow();
    await refreshAccount();
  },
};

// ---- Wiring: react to sign-in and to the app coming back to the foreground ----

if (supabase) {
  let lastUser: string | null = null;
  const check = () => {
    const user = cloudStore.get().user?.id ?? null;
    set({ available: !!user });
    if (user && user !== lastUser) {
      lastUser = user;
      void refreshAccount();
    } else if (!user && lastUser) {
      lastUser = null;
      set({ account: null });
    }
  };
  cloudStore.subscribe(check);
  check();

  // Returning from the Shortcuts app (or any foreground): refresh the link row so
  // "last synced" and the list names are current. The cloud engine pulls rows itself.
  const onForeground = () => {
    if (document.visibilityState === 'visible' && state.account) void refreshAccount();
  };
  document.addEventListener('visibilitychange', onForeground);
  window.addEventListener('focus', onForeground);
}

