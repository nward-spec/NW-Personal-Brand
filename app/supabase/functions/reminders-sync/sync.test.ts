import { describe, expect, it } from 'vitest';
import type { Calendar, DavObject } from './caldav';
import { buildVTodo, parseVTodo } from './ics';
import { runSync, type DavLike, type DbLike, type ReminderRow } from './sync';

const HOME = 'https://p12-caldav.icloud.com/123/calendars/';
const NOW = new Date('2026-03-19T05:00:00Z');

/** In-memory iCloud. */
function fakeCloud(lists: Record<string, Record<string, string>>) {
  const cals: Calendar[] = Object.keys(lists).map((name) => ({ href: `${HOME}${name.toLowerCase()}/`, name, supportsTodo: true }));
  cals.push({ href: `${HOME}home/`, name: 'Home', supportsTodo: false });
  const objects = new Map<string, { etag: number; ics: string }>();
  for (const [name, todos] of Object.entries(lists)) {
    for (const [file, ics] of Object.entries(todos)) objects.set(`${HOME}${name.toLowerCase()}/${file}`, { etag: 1, ics });
  }
  const dav: DavLike = {
    async listCalendars() {
      return cals;
    },
    async queryTodos(href) {
      const out: DavObject[] = [];
      for (const [h, o] of objects) if (h.startsWith(href)) out.push({ href: h, etag: `"${o.etag}"`, ics: o.ics });
      return out;
    },
    async put(href, ics, etag) {
      const cur = objects.get(href);
      if (cur && etag && etag !== `"${cur.etag}"`) throw new Error('412');
      const next = (cur?.etag ?? 0) + 1;
      objects.set(href, { etag: next, ics });
      return `"${next}"`;
    },
    async delete(href) {
      objects.delete(href);
    },
  };
  return { dav, objects };
}

function fakeDb(initial: ReminderRow[] = []) {
  const rows = new Map(initial.map((r) => [r.uid, r]));
  const db: DbLike = {
    async loadRows() {
      return [...rows.values()];
    },
    async saveRows(rs) {
      for (const r of rs) rows.set(r.uid, r);
    },
  };
  return { db, rows };
}

const todo = (uid: string, summary: string, due: string | null) => buildVTodo({ uid, summary, due }, new Date('2026-03-01T00:00:00Z'));

describe('runSync', () => {
  it('pulls reminders from every VTODO list into rows', async () => {
    const cloud = fakeCloud({
      Reminders: { 'A.ics': todo('A', 'Childcare list', '2026-03-17'), 'B.ics': todo('B', 'Vaccines', null) },
      Dinners: { 'C.ics': todo('C', 'Tacos', '2026-03-18') },
    });
    const { db, rows } = fakeDb();
    const res = await runSync({ dav: cloud.dav, db, homeUrl: HOME, now: NOW });
    expect(res.lists).toEqual(['Reminders', 'Dinners']);
    expect(res.pulled).toBe(3);
    expect(rows.get('A')).toMatchObject({ list: 'Reminders', title: 'Childcare list', due: '2026-03-17', completed: false, pending: null, etag: '"1"' });
    expect(rows.get('C')).toMatchObject({ list: 'Dinners', title: 'Tacos', listHref: `${HOME}dinners/` });
    // A second run changes nothing.
    const again = await runSync({ dav: cloud.dav, db, homeUrl: HOME, now: new Date(NOW.getTime() + 1000) });
    expect(again.pulled).toBe(0);
    expect(rows.get('A')!.updatedAt).toBe(NOW.toISOString());
  });

  it('pushes a completion to iCloud and clears pending', async () => {
    const cloud = fakeCloud({ Reminders: { 'A.ics': todo('A', 'Nails', '2026-03-19') } });
    const { db, rows } = fakeDb();
    await runSync({ dav: cloud.dav, db, homeUrl: HOME, now: NOW });
    rows.set('A', { ...rows.get('A')!, completed: true, completedAt: NOW.toISOString(), pending: 'update', updatedAt: NOW.toISOString() });
    const later = new Date(NOW.getTime() + 60000);
    const res = await runSync({ dav: cloud.dav, db, homeUrl: HOME, now: later });
    expect(res.pushed).toBe(1);
    expect(res.errors).toEqual([]);
    const cloudTodo = parseVTodo(cloud.objects.get(`${HOME}reminders/A.ics`)!.ics)!;
    expect(cloudTodo.completed).toBe(true);
    expect(rows.get('A')).toMatchObject({ completed: true, pending: null, etag: '"2"', updatedAt: later.toISOString() });
  });

  it('creates a reminder in the named list and deletes one', async () => {
    const cloud = fakeCloud({ Reminders: { 'A.ics': todo('A', 'Nails', '2026-03-19') }, Dinners: {} });
    const { db, rows } = fakeDb();
    await runSync({ dav: cloud.dav, db, homeUrl: HOME, now: NOW });
    rows.set('NEW@weekly-journal', { uid: 'NEW@weekly-journal', list: 'dinners', title: 'Pasta night', notes: '', due: '2026-03-20', completed: false, deleted: false, pending: 'create', updatedAt: NOW.toISOString() });
    rows.set('A', { ...rows.get('A')!, pending: 'delete', updatedAt: NOW.toISOString() });
    const res = await runSync({ dav: cloud.dav, db, homeUrl: HOME, now: new Date(NOW.getTime() + 60000) });
    expect(res.pushed).toBe(2);
    expect(cloud.objects.has(`${HOME}dinners/NEW%40weekly-journal.ics`)).toBe(true);
    expect(cloud.objects.has(`${HOME}reminders/A.ics`)).toBe(false);
    expect(rows.get('NEW@weekly-journal')).toMatchObject({ list: 'Dinners', pending: null, href: `${HOME}dinners/NEW%40weekly-journal.ics`, due: '2026-03-20' });
    expect(rows.get('A')).toMatchObject({ deleted: true, pending: null });
  });

  it('tombstones rows deleted in iCloud, and keeps failed pushes pending', async () => {
    const cloud = fakeCloud({ Reminders: { 'A.ics': todo('A', 'Nails', null), 'B.ics': todo('B', 'Pack', null) } });
    const { db, rows } = fakeDb();
    await runSync({ dav: cloud.dav, db, homeUrl: HOME, now: NOW });
    cloud.objects.delete(`${HOME}reminders/B.ics`); // removed on the phone
    rows.set('A', { ...rows.get('A')!, title: 'Nails + brows', pending: 'update', updatedAt: NOW.toISOString() });
    const flaky: DavLike = { ...cloud.dav, put: async () => { throw new Error('iCloud 503'); } };
    const res = await runSync({ dav: flaky, db, homeUrl: HOME, now: new Date(NOW.getTime() + 60000) });
    expect(rows.get('B')).toMatchObject({ deleted: true });
    expect(res.tombstoned).toBe(1);
    // The put failed: the row keeps its pending edit for next time.
    expect(res.errors).toHaveLength(1);
    expect(rows.get('A')).toMatchObject({ title: 'Nails + brows', pending: 'update' });
  });

  it('skips long-completed reminders it has never seen', async () => {
    const old = buildVTodo({ uid: 'OLD', summary: 'Ancient', due: null }, new Date('2025-01-01T00:00:00Z')).replace('STATUS:NEEDS-ACTION', 'STATUS:COMPLETED\r\nCOMPLETED:20250102T000000Z');
    const cloud = fakeCloud({ Reminders: { 'OLD.ics': old } });
    const { db, rows } = fakeDb();
    await runSync({ dav: cloud.dav, db, homeUrl: HOME, now: NOW });
    expect(rows.size).toBe(0);
  });
});
