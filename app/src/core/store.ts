// A tiny framework-agnostic store. The React layer subscribes with
// useSyncExternalStore; an Expo app could use the exact same file.

import { createWeekFromTemplates, defaultData, mostRecentWeekBefore } from './model';
import type { AppData, Templates, WeekDoc } from './types';

export type Listener = () => void;
export type DirtyListener = (key: string) => void;

export const weekKey = (weekStart: string) => `week:${weekStart}`;
export const TEMPLATES_KEY = 'templates';

export class Store {
  private data: AppData;
  private listeners = new Set<Listener>();
  private dirtyListeners = new Set<DirtyListener>();

  constructor(initial: AppData = defaultData()) {
    this.data = initial;
  }

  get(): AppData {
    return this.data;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Called with a key every time a local edit changes a document. */
  onDirty(l: DirtyListener): () => void {
    this.dirtyListeners.add(l);
    return () => this.dirtyListeners.delete(l);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  private markDirty(key: string) {
    for (const l of this.dirtyListeners) l(key);
  }

  /** Replace everything (load from disk, or after a sync pull). Not marked dirty. */
  replace(data: AppData) {
    this.data = data;
    this.emit();
  }

  setWeek(week: WeekDoc, opts: { dirty?: boolean } = {}) {
    this.data = { ...this.data, weeks: { ...this.data.weeks, [week.weekStart]: week } };
    this.emit();
    if (opts.dirty !== false) this.markDirty(weekKey(week.weekStart));
  }

  setTemplates(templates: Templates, opts: { dirty?: boolean } = {}) {
    this.data = { ...this.data, templates };
    this.emit();
    if (opts.dirty !== false) this.markDirty(TEMPLATES_KEY);
  }

  /** Get a week, creating it from the templates if it does not exist yet. */
  ensureWeek(weekStart: string): WeekDoc {
    const existing = this.data.weeks[weekStart];
    if (existing) return existing;
    const previous = mostRecentWeekBefore(this.data.weeks, weekStart);
    const week = createWeekFromTemplates(weekStart, this.data.templates, previous);
    this.setWeek(week);
    return week;
  }

  /** Apply a pure update to a week. No-op if the week does not exist. */
  updateWeek(weekStart: string, fn: (week: WeekDoc) => WeekDoc) {
    const current = this.data.weeks[weekStart];
    if (!current) return;
    const next = fn(current);
    if (next !== current) this.setWeek(next);
  }

  updateTemplates(fn: (t: Templates) => Templates) {
    const next = fn(this.data.templates);
    if (next !== this.data.templates) this.setTemplates(next);
  }
}
