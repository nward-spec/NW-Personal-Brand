// Sign-in state and the lifetime of the sync engine. Exposed as a small
// external store so any component can show sync status.

import type { Session } from '@supabase/supabase-js';
import { useSyncExternalStore } from 'react';
import { SyncEngine, type SyncStatus } from '../core/sync';
import { store } from './app-store';
import { createSupabaseRemote } from './remote';
import { cloudConfigured, supabase } from './supabase';

export interface CloudState {
  configured: boolean;
  /** True when the app was opened from a password-reset link: show the new-password form. */
  recovery: boolean;
  /** False until the initial session check finishes. */
  ready: boolean;
  user: { id: string; email: string | null } | null;
  status: SyncStatus;
  detail?: string;
  pending: number;
}

let state: CloudState = { configured: cloudConfigured, recovery: false, ready: !cloudConfigured, user: null, status: 'idle', pending: 0 };
const listeners = new Set<() => void>();
let engine: SyncEngine | null = null;

function set(patch: Partial<CloudState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function startEngine(session: Session) {
  if (!supabase) return;
  stopEngine();
  const remote = createSupabaseRemote(supabase, session.user.id);
  engine = new SyncEngine(store, remote, {
    storage: window.localStorage,
    isOnline: () => navigator.onLine,
    onStatus: (status, detail) => set({ status, detail, pending: engine?.pendingCount ?? 0 }),
  });
  set({ user: { id: session.user.id, email: session.user.email ?? null } });
  void engine.start();
}

function stopEngine() {
  engine?.stop();
  engine = null;
}

if (supabase) {
  supabase.auth.getSession().then(({ data }) => {
    if (data.session) startEngine(data.session);
    set({ ready: true });
  });
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') set({ recovery: true });
    if (event === 'SIGNED_OUT' || !session) {
      stopEngine();
      set({ user: null, status: 'idle', pending: 0, detail: undefined });
    } else if (event === 'SIGNED_IN' && (!engine || state.user?.id !== session.user.id)) {
      startEngine(session);
    }
  });
  const resync = () => {
    if (engine && document.visibilityState === 'visible') void engine.syncNow();
  };
  window.addEventListener('online', resync);
  window.addEventListener('focus', resync);
  document.addEventListener('visibilitychange', resync);
}

/** Non-React access to the cloud state (used by the reminders controller). */
export const cloudStore = {
  get: () => state,
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useCloud(): CloudState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

function requireClient() {
  if (!supabase) throw new Error('Cloud sync is not configured for this build.');
  return supabase;
}

export const cloud = {
  async signIn(email: string, password: string) {
    const { error } = await requireClient().auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
  },
  async signUp(email: string, password: string) {
    const { data, error } = await requireClient().auth.signUp({ email, password, options: { emailRedirectTo: window.location.href } });
    if (error) throw new Error(error.message);
    return { needsConfirmation: !data.session };
  },
  async magicLink(email: string) {
    const { error } = await requireClient().auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } });
    if (error) throw new Error(error.message);
  },
  /** Email a password-reset link. It opens in Safari; the new password then works in the installed app. */
  async resetPassword(email: string) {
    const { error } = await requireClient().auth.resetPasswordForEmail(email, { redirectTo: window.location.href.split('#')[0] });
    if (error) throw new Error(error.message);
  },
  async setPassword(password: string) {
    const { error } = await requireClient().auth.updateUser({ password });
    if (error) throw new Error(error.message);
    set({ recovery: false });
  },
  async signOut() {
    const { error } = await requireClient().auth.signOut();
    if (error) throw new Error(error.message);
  },
  async syncNow() {
    await engine?.syncNow();
  },
};
