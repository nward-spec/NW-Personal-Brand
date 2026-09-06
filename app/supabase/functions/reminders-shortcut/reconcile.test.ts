import { describe, expect, it } from 'vitest';
import type { ReminderRow } from '../reminders-sync/sync.ts';
import { formatCommands, keyOf, parseSnapshot, reconcile } from './reconcile.ts';

const NOW = new Date('2026-03-19T05:00:00Z');
let n = 0;
const newId = () => `id${++n}`;

const row = (list: string, title: string, extra: Partial<ReminderRow & { dispatchedAt?: string | null }> = {}): ReminderRow & { dispatchedAt?: string | null } => ({
  uid: `${list}-${title}`,
  list,
  title,
  notes: '',
  due: null,
  completed: false,
  deleted: false,
  pending: null,
  href: keyOf(list, title),
  updatedAt: '2026-03-18T00:00:00.000Z',
  ...extra,
});

describe('parseSnapshot', () => {
  it('reads the lines a Shortcut sends, numbering every non-empty line', () => {
    const text = ['Childcare list | Reminders | 2026-03-17 | No', 'Tacos\tDinners\t17 Mar 2026 at 6:00 pm\tYes', '', 'broken line', 'Vaccines | Reminders |  | false', 'Nails | Reminders | 20/03/2026, 9:00 am | true'].join('\n');
    expect(parseSnapshot(text)).toEqual([
      { index: 1, title: 'Childcare list', list: 'Reminders', due: '2026-03-17', completed: false },
      { index: 2, title: 'Tacos', list: 'Dinners', due: '2026-03-17', completed: true },
      { index: 4, title: 'Vaccines', list: 'Reminders', due: null, completed: false },
      { index: 5, title: 'Nails', list: 'Reminders', due: '2026-03-20', completed: true },
    ]);
  });
});

describe('reconcile', () => {
  it('imports reminders the app has never seen', () => {
    const snap = parseSnapshot('Nails | Reminders | 2026-03-19 | No\nPasta | Dinners |  | No');
    const r = reconcile({ rows: [], snapshot: snap, now: NOW, newId });
    expect(r.pulled).toBe(2);
    expect(r.commands).toEqual([]);
    expect(r.lists).toEqual(['Dinners', 'Reminders']);
    expect(r.save.map((s) => [s.list, s.title, s.due, s.href])).toEqual([
      ['Reminders', 'Nails', '2026-03-19', keyOf('Reminders', 'Nails')],
      ['Dinners', 'Pasta', null, keyOf('Dinners', 'Pasta')],
    ]);
  });

  it('turns app edits into index-based commands and stops re-sending them', () => {
    const rows = [
      row('Reminders', 'Nails', { completed: true, pending: 'update' }),
      row('Dinners', 'Curry', { uid: 'new', due: '2026-03-20', pending: 'create', href: undefined }),
      row('Reminders', 'Vaccines', { pending: 'delete' }),
      row('Reminders', 'Walk', { due: '2026-03-21', pending: 'update' }),
    ];
    const snap = parseSnapshot(['Nails | Reminders |  | No', 'Vaccines | Reminders |  | No', 'Walk | Reminders | 2026-03-19 | No'].join('\n'));
    const r = reconcile({ rows, snapshot: snap, now: NOW, newId });
    expect(formatCommands(r.commands).split('\n')).toEqual([
      'delete | 1 | Nails | ',
      'create | Dinners | Curry | 2026-03-20',
      'delete | 2 | Vaccines | ',
      'delete | 3 | Walk | ',
      'create | Reminders | Walk | 2026-03-21',
    ]);
    const saved = Object.fromEntries(r.save.map((s) => [s.uid, s]));
    expect(saved['Reminders-Nails']).toMatchObject({ pending: null, completed: true, dispatchedAt: NOW.toISOString() });
    expect(saved['new']).toMatchObject({ pending: null, href: keyOf('Dinners', 'Curry') });
    expect(saved['Reminders-Vaccines']).toMatchObject({ deleted: true, pending: null });
    // A second run with the same (not yet updated) snapshot sends nothing and keeps the rows.
    const again = reconcile({ rows: r.save, snapshot: snap, now: new Date(NOW.getTime() + 60000), newId });
    expect(again.commands).toEqual([]);
    expect(again.save.filter((s) => s.deleted)).toEqual([]);
    // Once the phone has removed the ticked reminder, the app still keeps it as done.
    const later = reconcile({ rows: r.save, snapshot: parseSnapshot('Curry | Dinners | 2026-03-20 | No\nWalk | Reminders | 2026-03-21 | No'), now: new Date(NOW.getTime() + 2 * 86400000), newId });
    expect(later.save.find((s) => s.uid === 'Reminders-Nails')).toBeUndefined();
    expect(later.tombstoned).toBe(0);
  });

  it('lets the phone win once the grace period has passed', () => {
    const stale = row('Reminders', 'Nails', { due: '2026-03-20', dispatchedAt: '2026-03-17T00:00:00.000Z' });
    const snap = parseSnapshot('Nails | Reminders | 2026-03-22 | No');
    const r = reconcile({ rows: [stale], snapshot: snap, now: NOW, newId });
    expect(r.save[0]).toMatchObject({ due: '2026-03-22', pending: null });
  });

  it('marks open rows that vanished from the phone as done, and mirrors phone changes', () => {
    const rows = [row('Reminders', 'Gone'), row('Reminders', 'Done', { completed: true }), row('Reminders', 'Ticked'), row('Dinners', 'Tacos', { due: '2026-03-17' })];
    const snap = parseSnapshot('Ticked | Reminders |  | Yes\nTacos | Dinners | 2026-03-18 | No');
    const r = reconcile({ rows, snapshot: snap, now: NOW, newId });
    const saved = Object.fromEntries(r.save.map((s) => [s.uid, s]));
    expect(saved['Reminders-Gone']).toMatchObject({ completed: true, completedAt: NOW.toISOString(), deleted: false });
    expect(saved['Reminders-Done']).toBeUndefined();
    expect(saved['Reminders-Ticked']).toMatchObject({ completed: true, completedAt: NOW.toISOString() });
    expect(saved['Dinners-Tacos']).toMatchObject({ due: '2026-03-18' });
    expect(r.tombstoned).toBe(0);
  });

  it('re-dates a same-named reminder the phone already has, instead of silently linking', () => {
    const rows = [row('Dinners', 'Gozleme', { uid: 'new', due: '2026-03-21', pending: 'create', href: undefined })];
    const snap = parseSnapshot('Gozleme | Dinners |  | No');
    const r = reconcile({ rows, snapshot: snap, now: NOW, newId });
    expect(formatCommands(r.commands).split('\n')).toEqual(['delete | 1 | Gozleme | ', 'create | Dinners | Gozleme | 2026-03-21']);
  });

  it('folds an app-created duplicate into the row the phone already had', () => {
    const rows = [row('Dinners', 'Gozleme'), row('Dinners', 'Gozleme', { uid: 'dup', due: '2026-03-21', pending: 'create', href: undefined })];
    const snap = parseSnapshot('Gozleme | Dinners |  | No');
    const r = reconcile({ rows, snapshot: snap, now: NOW, newId });
    const saved = Object.fromEntries(r.save.map((s) => [s.uid, s]));
    expect(saved['dup']).toMatchObject({ deleted: true });
    expect(saved['Dinners-Gozleme']).toMatchObject({ due: '2026-03-21', pending: null, dispatchedAt: NOW.toISOString() });
    expect(formatCommands(r.commands).split('\n')).toEqual(['delete | 1 | Gozleme | ', 'create | Dinners | Gozleme | 2026-03-21']);
  });

  it('recreates an edited reminder the phone has lost', () => {
    const r = reconcile({ rows: [row('Reminders', 'Pack', { pending: 'update', due: '2026-03-22' })], snapshot: [], now: NOW, newId });
    expect(r.commands).toEqual([{ op: 'create', list: 'Reminders', title: 'Pack', due: '2026-03-22' }]);
  });
});
