import { describe, expect, it } from 'vitest';
import { addTodo, emptyTemplates, emptyWeek } from './model';
import { createMemoryStorage } from './persist';
import { Store } from './store';
import { PENDING_KEY, SyncEngine, type RemoteStore } from './sync';
import type { Templates, WeekDoc } from './types';

/** In-memory stand-in for Supabase. */
function fakeRemote() {
  const weeks = new Map<string, WeekDoc>();
  let templates: Templates | null = null;
  const calls: string[] = [];
  const remote: RemoteStore = {
    async fetchAll() {
      calls.push('fetch');
      return { weeks: [...weeks.values()], templates };
    },
    async upsertWeeks(ws) {
      calls.push(`weeks:${ws.map((w) => w.weekStart).join(',')}`);
      for (const w of ws) weeks.set(w.weekStart, w);
    },
    async upsertTemplates(t) {
      calls.push('templates');
      templates = t;
    },
  };
  return { remote, weeks, calls, get templates() { return templates; } };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SyncEngine', () => {
  it('pulls remote data, then pushes local-only documents', async () => {
    const r = fakeRemote();
    r.weeks.set('2026-03-09', emptyWeek('2026-03-09', '2026-03-09T00:00:00.000Z'));
    const store = new Store({ weeks: { '2026-03-16': emptyWeek('2026-03-16', '2026-03-16T00:00:00.000Z') }, templates: emptyTemplates('2026-01-01T00:00:00.000Z') });
    const engine = new SyncEngine(store, r.remote, { debounceMs: 0 });
    await engine.start();
    expect(Object.keys(store.get().weeks).sort()).toEqual(['2026-03-09', '2026-03-16']);
    expect(r.weeks.has('2026-03-16')).toBe(true);
    expect(r.templates).not.toBeNull();
    expect(engine.pendingCount).toBe(0);
    engine.stop();
  });

  it('pushes edits after the debounce and clears the queue', async () => {
    const r = fakeRemote();
    const store = new Store();
    const statuses: string[] = [];
    const engine = new SyncEngine(store, r.remote, { debounceMs: 0, onStatus: (s) => statuses.push(s) });
    await engine.start();
    store.ensureWeek('2026-03-16');
    store.updateWeek('2026-03-16', (w) => addTodo(w, 'Nails'));
    await tick();
    await tick();
    expect(r.weeks.get('2026-03-16')?.todos.map((t) => t.text)).toEqual(['Nails']);
    expect(engine.pendingCount).toBe(0);
    expect(statuses.at(-1)).toBe('synced');
    engine.stop();
  });

  it('keeps the newer local copy and re-pushes it', async () => {
    const r = fakeRemote();
    r.weeks.set('2026-03-16', emptyWeek('2026-03-16', '2026-03-16T00:00:00.000Z'));
    const local = { ...addTodo(emptyWeek('2026-03-16', '2026-03-16T00:00:00.000Z'), 'Pack'), updatedAt: '2026-03-17T00:00:00.000Z' };
    const store = new Store({ weeks: { '2026-03-16': local }, templates: emptyTemplates() });
    const engine = new SyncEngine(store, r.remote, { debounceMs: 0 });
    await engine.start();
    expect(store.get().weeks['2026-03-16'].todos).toHaveLength(1);
    expect(r.weeks.get('2026-03-16')?.todos).toHaveLength(1);
    engine.stop();
  });

  it('remembers pending keys across restarts and reports errors', async () => {
    const storage = createMemoryStorage();
    const failing: RemoteStore = {
      fetchAll: async () => ({ weeks: [], templates: null }),
      upsertWeeks: async () => {
        throw new Error('network down');
      },
      upsertTemplates: async () => {},
    };
    const store = new Store();
    const statuses: string[] = [];
    const engine = new SyncEngine(store, failing, { debounceMs: 0, storage, onStatus: (s) => statuses.push(s) });
    await engine.start();
    store.ensureWeek('2026-03-16');
    await tick();
    await tick();
    expect(statuses.at(-1)).toBe('error');
    expect(JSON.parse(storage.getItem(PENDING_KEY) ?? '[]')).toContain('week:2026-03-16');
    engine.stop();

    const r = fakeRemote();
    const engine2 = new SyncEngine(store, r.remote, { debounceMs: 0, storage });
    expect(engine2.pendingCount).toBeGreaterThan(0);
    await engine2.start();
    expect(r.weeks.has('2026-03-16')).toBe(true);
    expect(engine2.pendingCount).toBe(0);
    engine2.stop();
  });
});
