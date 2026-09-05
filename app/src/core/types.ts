import type { DayKey } from './week';

/** A checkable line: a to-do, or an entry on a day. */
export interface Item {
  id: string;
  text: string;
  done: boolean;
  /** Set when the item was seeded from a weekly goal (e.g. "Walk" on Tue). */
  goalId?: string;
}

/** A weekly goal with the days it is planned for, e.g. Walk x2 on Tue & Thu. */
export interface Goal {
  id: string;
  text: string;
  days: DayKey[];
  done: boolean;
}

/** A habit tracked with one dot per day, e.g. "Read 15 min". */
export interface Habit {
  id: string;
  text: string;
  /** Free text target shown next to the name, e.g. "x4" or "Sun–Thu". */
  target: string;
  /** Seven booleans, Monday first. */
  checks: boolean[];
}

export interface Day {
  items: Item[];
  /** What to wear that day. */
  outfit: string;
}

/** One week of the journal. Keyed by its Monday (YYYY-MM-DD). */
export interface WeekDoc {
  weekStart: string;
  priorities: string[];
  todos: Item[];
  goals: Goal[];
  notes: string;
  habits: Habit[];
  days: Record<DayKey, Day>;
  /** ISO timestamp of the last edit; drives last-write-wins sync. */
  updatedAt: string;
}

export interface GoalTemplate {
  id: string;
  text: string;
  days: DayKey[];
}

export interface HabitTemplate {
  id: string;
  text: string;
  target: string;
}

/** Goals and habits that seed every new week. */
export interface Templates {
  goals: GoalTemplate[];
  habits: HabitTemplate[];
  updatedAt: string;
}

/**
 * A reminder mirrored from Apple Reminders (iCloud CalDAV). Rows are synced
 * per item: the app edits a row and marks it `pending`; the server-side sync
 * pushes the change to iCloud, then rewrites the row with `pending: null`.
 */
export interface ReminderRow {
  /** iCalendar UID; stable across devices. */
  uid: string;
  /** Reminders list name, e.g. "Reminders" or "Dinners". */
  list: string;
  /** CalDAV collection href of the list (set by the server). */
  listHref?: string;
  /** CalDAV object href and ETag (set by the server). */
  href?: string;
  etag?: string;
  title: string;
  notes: string;
  /** Due date as YYYY-MM-DD, or null for an undated reminder. */
  due: string | null;
  completed: boolean;
  completedAt?: string | null;
  /** True once the reminder is gone from iCloud (kept as a tombstone). */
  deleted: boolean;
  /** Change waiting to be pushed to Apple Reminders. */
  pending: 'create' | 'update' | 'delete' | null;
  /** Set by the server when a change was handed to the phone and awaits confirmation. */
  dispatchedAt?: string | null;
  updatedAt: string;
}

export interface AppData {
  weeks: Record<string, WeekDoc>;
  templates: Templates;
  reminders: Record<string, ReminderRow>;
}

export function newId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
