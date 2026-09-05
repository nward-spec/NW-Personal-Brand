// Reminders mirrored from Apple Reminders. Rows live in AppData.reminders and
// sync per row. Edits here only mark the row `pending`; the server-side
// function (supabase/functions/reminders-sync) pushes them to iCloud.

import { newId, type AppData, type ReminderRow } from './types';
import { DAY_KEYS, type DayKey, nowISO, todayISO, weekDates } from './week';

/** List name used for the Dinners tab until the user picks one. */
export const DEFAULT_DINNERS_LIST = 'Dinners';

const byTitle = (a: ReminderRow, b: ReminderRow) => Number(a.completed) - Number(b.completed) || a.title.localeCompare(b.title);

/** Reminders that still exist (not deleted here or in iCloud). */
export function liveReminders(data: AppData): ReminderRow[] {
  return Object.values(data.reminders).filter((r) => !r.deleted && r.pending !== 'delete');
}

/** Reminders due on a given date. */
export function remindersForDay(data: AppData, date: string, opts: { excludeList?: string } = {}): ReminderRow[] {
  return liveReminders(data)
    .filter((r) => r.due === date && (!opts.excludeList || r.list !== opts.excludeList))
    .sort(byTitle);
}

/** Undated reminders: open ones, plus any completed today so the tick is visible. */
export function undatedReminders(data: AppData, opts: { excludeList?: string; today?: string } = {}): ReminderRow[] {
  const today = opts.today ?? todayISO();
  return liveReminders(data)
    .filter((r) => r.due === null && (!opts.excludeList || r.list !== opts.excludeList))
    .filter((r) => !r.completed || (r.completedAt ?? '').slice(0, 10) === today)
    .sort(byTitle);
}

export interface DinnerWeek {
  days: Record<DayKey, ReminderRow[]>;
  /** Undated, uncompleted reminders in the dinners list: ideas to plan in. */
  ideas: ReminderRow[];
}

/** The dinners list laid over a week: one bucket per day plus unplanned ideas. */
export function dinnersForWeek(data: AppData, weekStart: string, list: string): DinnerWeek {
  const dates = weekDates(weekStart);
  const days = {} as Record<DayKey, ReminderRow[]>;
  for (const k of DAY_KEYS) days[k] = [];
  const ideas: ReminderRow[] = [];
  for (const r of liveReminders(data)) {
    if (r.list !== list) continue;
    if (r.due === null) {
      if (!r.completed) ideas.push(r);
      continue;
    }
    const i = dates.indexOf(r.due);
    if (i >= 0) days[DAY_KEYS[i]].push(r);
  }
  for (const k of DAY_KEYS) days[k].sort(byTitle);
  ideas.sort(byTitle);
  return { days, ideas };
}

export function reminderListNames(data: AppData): string[] {
  return [...new Set(liveReminders(data).map((r) => r.list))].sort();
}

// ---- Edits (each marks the row pending and stamps it) ----------------------

function edit(row: ReminderRow, patch: Partial<ReminderRow>, now: string): ReminderRow {
  return { ...row, ...patch, pending: row.pending === 'create' ? 'create' : 'update', updatedAt: now };
}

export const toggleReminder = (row: ReminderRow, now: string = nowISO()) =>
  edit(row, { completed: !row.completed, completedAt: row.completed ? null : now }, now);

export const renameReminder = (row: ReminderRow, title: string, now: string = nowISO()) => edit(row, { title: title.trim() }, now);

export const setReminderDue = (row: ReminderRow, due: string | null, now: string = nowISO()) => edit(row, { due }, now);

/** Queue deletion. A reminder never pushed to iCloud is simply dropped. */
export const deleteReminder = (row: ReminderRow, now: string = nowISO()): ReminderRow =>
  row.pending === 'create' ? { ...row, deleted: true, pending: null, updatedAt: now } : { ...row, pending: 'delete', updatedAt: now };

export function createReminder(input: { list: string; listHref?: string; title: string; due: string | null; notes?: string }, now: string = nowISO()): ReminderRow {
  return {
    uid: `${newId().toUpperCase()}@weekly-journal`,
    list: input.list,
    listHref: input.listHref,
    title: input.title.trim(),
    notes: input.notes ?? '',
    due: input.due,
    completed: false,
    completedAt: null,
    deleted: false,
    pending: 'create',
    updatedAt: now,
  };
}
