// Cloud sync. The engine only knows about the abstract RemoteStore, so the
// Supabase adapter (web) and any future Expo adapter stay thin, and the
// engine itself can be tested with an in-memory remote.
//
// Strategy: whole documents (one per week, plus the templates), last-write-
// wins by `updatedAt`. Local edits are queued as "dirty" keys, persisted so an
// offline session still pushes after a reload, and pushed after a short
// debounce. A pull merges remote rows into the store and re-queues anything
// where the local copy was newer.

import { mergeData } from './model';
import type { KVStorage } from './persist';
import { TEMPLATES_KEY, reminderKey, type Store, weekKey } from './store';
import type { ReminderRow, Templates, WeekDoc } from './types';

export interface RemoteStore {
  fetchAll(): Promise<{ weeks: WeekDoc[]; templates: Templates | null; reminders?: ReminderRow[] }>;
  upsertWeeks(weeks: WeekDoc[]): Promise<void>;
  upsertTemplates(templates: Templates): Promise<void>;
  upsertReminders?(rows: ReminderRow[]): Promise<void>;
}

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error' | 'offline';

export interface SyncOptions {
  /** Where to remember unsynced keys between sessions. */
  storage?: KVStorage;
  onStatus?: (status: SyncStatus, detail?: string) => void;
  debounceMs?: number;
  isOnline?: () => boolean;
}

export const PENDING_KEY = 'weekly-journal:pending:v1';

export class SyncEngine {
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  private readonly debounceMs: number;
  private readonly isOnline: () => boolean;

  constructor(
    private readonly store: Store,
    private readonly remote: RemoteStore,
    private readonly opts: SyncOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 800;
    this.isOnline = opts.isOnline ?? (() => true);
    this.loadPending();
  }

  /** Begin: watch for edits, then do a full pull and push. */
  async start(): Promise<void> {
    this.stopped = false;
    this.unsubscribe = this.store.onDirty((key) => {
      this.dirty.add(key);
      this.savePending();
      this.schedulePush();
    });
    await this.syncNow();
  }

  stop() {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  get pendingCount(): number {
    return this.dirty.size;
  }

  /** Pull remote changes, then push anything still pending. */
  syncNow(): Promise<void> {
    return this.run(async () => {
      await this.pullOnce();
      await this.pushOnce();
    });
  }

  private schedulePush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run(() => this.pushOnce());
    }, this.debounceMs);
  }

  /** Serialise operations; if one is requested while another runs, run again after. */
  private run(op: () => Promise<void>): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    if (this.stopped) return Promise.resolve();
    if (!this.isOnline()) {
      this.setStatus('offline');
      return Promise.resolve();
    }
    this.setStatus('syncing');
    this.running = (async () => {
      try {
        await op();
        // Anything queued while we were busy.
        while (this.again && !this.stopped) {
          this.again = false;
          await this.pushOnce();
        }
        this.setStatus(this.dirty.size === 0 ? 'synced' : 'idle');
      } catch (err) {
        this.setStatus('error', err instanceof Error ? err.message : String(err));
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  private async pullOnce() {
    const remote = await this.remote.fetchAll();
    const weeks: Record<string, WeekDoc> = {};
    for (const w of remote.weeks) weeks[w.weekStart] = w;
    const reminders: Record<string, ReminderRow> = {};
    for (const r of remote.reminders ?? []) reminders[r.uid] = r;
    const { merged, localNewer } = mergeData(this.store.get(), { weeks, templates: remote.templates ?? undefined, reminders });
    for (const key of localNewer) this.dirty.add(key);
    // Documents the remote has never seen must be pushed too.
    for (const key of Object.keys(merged.weeks)) if (!weeks[key]) this.dirty.add(weekKey(key));
    for (const uid of Object.keys(merged.reminders)) if (!reminders[uid]) this.dirty.add(reminderKey(uid));
    if (!remote.templates) this.dirty.add(TEMPLATES_KEY);
    this.savePending();
    this.store.replace(merged);
  }

  private async pushOnce() {
    if (this.dirty.size === 0) return;
    const data = this.store.get();
    const weekKeys = [...this.dirty].filter((k) => k.startsWith('week:'));
    const weeks = weekKeys.map((k) => data.weeks[k.slice('week:'.length)]).filter((w): w is WeekDoc => !!w);
    const stamps = new Map<string, string>();
    for (const w of weeks) stamps.set(weekKey(w.weekStart), w.updatedAt);
    const pushTemplates = this.dirty.has(TEMPLATES_KEY);
    if (pushTemplates) stamps.set(TEMPLATES_KEY, data.templates.updatedAt);
    const reminderKeys = [...this.dirty].filter((k) => k.startsWith('reminder:'));
    const reminders = reminderKeys.map((k) => data.reminders[k.slice('reminder:'.length)]).filter((r): r is ReminderRow => !!r);
    for (const r of reminders) stamps.set(reminderKey(r.uid), r.updatedAt);

    if (weeks.length) await this.remote.upsertWeeks(weeks);
    if (pushTemplates) await this.remote.upsertTemplates(data.templates);
    if (reminders.length && this.remote.upsertReminders) await this.remote.upsertReminders(reminders);

    // Only clear keys that were not edited again while the request was in flight.
    const after = this.store.get();
    const stampOf = (key: string) => {
      if (key === TEMPLATES_KEY) return after.templates.updatedAt;
      if (key.startsWith('reminder:')) return after.reminders[key.slice('reminder:'.length)]?.updatedAt;
      return after.weeks[key.slice('week:'.length)]?.updatedAt;
    };
    for (const [key, stamp] of stamps) {
      const current = stampOf(key);
      if (current === stamp || current === undefined) this.dirty.delete(key);
    }
    for (const key of weekKeys) if (!data.weeks[key.slice('week:'.length)]) this.dirty.delete(key);
    for (const key of reminderKeys) if (!data.reminders[key.slice('reminder:'.length)]) this.dirty.delete(key);
    if (!this.remote.upsertReminders) for (const key of reminderKeys) this.dirty.delete(key);
    this.savePending();
  }

  private setStatus(status: SyncStatus, detail?: string) {
    this.opts.onStatus?.(status, detail);
  }

  private loadPending() {
    try {
      const raw = this.opts.storage?.getItem(PENDING_KEY);
      if (raw) for (const k of JSON.parse(raw) as string[]) this.dirty.add(k);
    } catch {
      /* ignore */
    }
  }

  private savePending() {
    try {
      this.opts.storage?.setItem(PENDING_KEY, JSON.stringify([...this.dirty]));
    } catch {
      /* ignore */
    }
  }
}
