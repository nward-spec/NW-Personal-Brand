import { describe, expect, it } from 'vitest';
import { defaultData } from './model';
import { createReminder, deleteReminder, dinnersForWeek, remindersForDay, setReminderDue, toggleReminder, undatedReminders } from './reminders';
import type { ReminderRow } from './types';

const row = (uid: string, title: string, due: string | null, extra: Partial<ReminderRow> = {}): ReminderRow => ({
  uid, list: 'Reminders', title, notes: '', due, completed: false, deleted: false, pending: null, updatedAt: '2026-03-16T00:00:00.000Z', ...extra,
});

function data(rows: ReminderRow[]) {
  const d = defaultData();
  for (const r of rows) d.reminders[r.uid] = r;
  return d;
}

describe('reminder selectors', () => {
  const d = data([
    row('a', 'Childcare list', '2026-03-17'),
    row('b', 'Nails', '2026-03-19', { completed: true }),
    row('c', 'Vaccines', null),
    row('d', 'Old undated done', null, { completed: true, completedAt: '2026-03-10T00:00:00.000Z' }),
    row('e', 'Done today', null, { completed: true, completedAt: '2026-03-19T01:00:00.000Z' }),
    row('f', 'Tacos', '2026-03-17', { list: 'Dinners' }),
    row('g', 'Pasta idea', null, { list: 'Dinners' }),
    row('h', 'Gone', '2026-03-17', { deleted: true }),
    row('i', 'Pending delete', '2026-03-17', { pending: 'delete' }),
  ]);

  it('puts dated reminders on their day, leaving out the dinners list', () => {
    expect(remindersForDay(d, '2026-03-17', { excludeList: 'Dinners' }).map((r) => r.title)).toEqual(['Childcare list']);
    expect(remindersForDay(d, '2026-03-17').map((r) => r.title)).toEqual(['Childcare list', 'Tacos']);
    expect(remindersForDay(d, '2026-03-19').map((r) => r.title)).toEqual(['Nails']);
  });

  it('lists undated reminders, hiding ones completed before today', () => {
    expect(undatedReminders(d, { excludeList: 'Dinners', today: '2026-03-19' }).map((r) => r.title)).toEqual(['Vaccines', 'Done today']);
    expect(undatedReminders(d, { onlyList: 'reminders', today: '2026-03-19' }).map((r) => r.title)).toEqual(['Vaccines', 'Done today']);
    expect(undatedReminders(d, { onlyList: 'Dinners', today: '2026-03-19' }).map((r) => r.title)).toEqual(['Pasta idea']);
  });

  it('lays the dinners list over a week', () => {
    const w = dinnersForWeek(d, '2026-03-16', 'Dinners');
    expect(w.days.tue.map((r) => r.title)).toEqual(['Tacos']);
    expect(w.days.mon).toEqual([]);
    expect(w.ideas.map((r) => r.title)).toEqual(['Pasta idea']);
  });
});

describe('reminder edits', () => {
  it('marks edits pending and stamps them', () => {
    const r = toggleReminder(row('a', 'Nails', null), '2026-03-19T02:00:00.000Z');
    expect(r).toMatchObject({ completed: true, completedAt: '2026-03-19T02:00:00.000Z', pending: 'update', updatedAt: '2026-03-19T02:00:00.000Z' });
    expect(setReminderDue(r, '2026-03-20').due).toBe('2026-03-20');
  });

  it('keeps a new reminder as a create until it is pushed', () => {
    const c = createReminder({ list: 'Dinners', title: 'Curry', due: '2026-03-20' });
    expect(c.pending).toBe('create');
    expect(c.uid.endsWith('@weekly-journal')).toBe(true);
    expect(toggleReminder(c).pending).toBe('create');
    expect(deleteReminder(c)).toMatchObject({ deleted: true, pending: null });
    expect(deleteReminder(row('a', 'Nails', null)).pending).toBe('delete');
  });
});
