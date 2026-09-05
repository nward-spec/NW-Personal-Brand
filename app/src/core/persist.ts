// Local persistence through a minimal key/value interface, so the same code
// works with localStorage on the web and AsyncStorage-style adapters in Expo.

import { defaultData, isReminderRow, isTemplates, isWeekDoc, normaliseReminder, normaliseWeek } from './model';
import type { Store } from './store';
import type { AppData } from './types';

export interface KVStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DATA_KEY = 'weekly-journal:data:v1';

/** Turn arbitrary JSON into AppData, dropping anything malformed. */
export function parseAppData(raw: unknown): AppData | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<AppData>;
  const data = defaultData();
  if (obj.weeks && typeof obj.weeks === 'object') {
    for (const [key, week] of Object.entries(obj.weeks)) {
      if (isWeekDoc(week) && week.weekStart === key) data.weeks[key] = normaliseWeek(week);
    }
  }
  if (isTemplates(obj.templates)) data.templates = obj.templates;
  if (obj.reminders && typeof obj.reminders === 'object') {
    for (const [uid, row] of Object.entries(obj.reminders)) {
      if (isReminderRow(row) && row.uid === uid) data.reminders[uid] = normaliseReminder(row);
    }
  }
  return data;
}

export function loadData(storage: KVStorage, key: string = DATA_KEY): AppData | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return parseAppData(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveData(storage: KVStorage, data: AppData, key: string = DATA_KEY) {
  storage.setItem(key, JSON.stringify(data));
}

/** Save the store to storage after every change (debounced). Returns a stop function. */
export function attachPersistence(store: Store, storage: KVStorage, key: string = DATA_KEY, debounceMs = 150): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    try {
      saveData(storage, store.get(), key);
    } catch (err) {
      console.warn('Could not save journal locally', err);
    }
  };
  const unsubscribe = store.subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  });
  return () => {
    unsubscribe();
    if (timer) {
      clearTimeout(timer);
      flush();
    }
  };
}

export function createMemoryStorage(): KVStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}
