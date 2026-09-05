import { useMemo, useSyncExternalStore } from 'react';
import { defaultData, emptyWeek } from '../core/model';
import { attachPersistence, loadData } from '../core/persist';
import { Store } from '../core/store';
import type { AppData, WeekDoc } from '../core/types';

function safeLocalStorage(): Storage | null {
  try {
    const s = window.localStorage;
    s.getItem('__probe__');
    return s;
  } catch {
    return null;
  }
}

const storage = safeLocalStorage();

export const store = new Store((storage && loadData(storage)) ?? defaultData());
if (storage) attachPersistence(store, storage);

const subscribe = (l: () => void) => store.subscribe(l);
const snapshot = () => store.get();

export function useAppData(): AppData {
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * The week document for `weekStart`. Until the store has created it (see
 * App's effect calling ensureWeek) a stable empty placeholder is returned so
 * the first paint never flashes.
 */
export function useWeek(weekStart: string): WeekDoc {
  const data = useAppData();
  const placeholder = useMemo(() => emptyWeek(weekStart), [weekStart]);
  return data.weeks[weekStart] ?? placeholder;
}

export const updateWeek = (weekStart: string, fn: (w: WeekDoc) => WeekDoc) => store.updateWeek(weekStart, fn);
