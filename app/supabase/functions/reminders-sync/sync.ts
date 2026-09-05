// The two-way sync, with iCloud and the database behind small interfaces so
// it can be tested without either.
//
// 1. Read every reminder list and every VTODO in it from iCloud.
// 2. Push the app's pending changes (create / update / delete) on top.
// 3. Rewrite the database rows from the resulting iCloud state, touching only
//    rows that actually changed (so client last-write-wins stays quiet), and
//    tombstone rows whose reminder has vanished from iCloud.

import type { Calendar, DavObject } from './caldav.ts';
import { buildVTodo, parseVTodo, updateVTodo } from './ics.ts';

/** Mirrors ReminderRow in src/core/types.ts (kept in sync by hand; both are plain JSON). */
export interface ReminderRow {
  uid: string;
  list: string;
  listHref?: string;
  href?: string;
  etag?: string;
  title: string;
  notes: string;
  due: string | null;
  completed: boolean;
  completedAt?: string | null;
  deleted: boolean;
  pending: 'create' | 'update' | 'delete' | null;
  updatedAt: string;
}

export interface DavLike {
  listCalendars(homeUrl: string): Promise<Calendar[]>;
  queryTodos(calendarHref: string): Promise<DavObject[]>;
  put(href: string, ics: string, etag?: string | null): Promise<string | null>;
  delete(href: string, etag?: string | null): Promise<void>;
}

export interface DbLike {
  loadRows(): Promise<ReminderRow[]>;
  saveRows(rows: ReminderRow[]): Promise<void>;
}

export interface SyncResult {
  lists: string[];
  pushed: number;
  pulled: number;
  tombstoned: number;
  errors: string[];
}

/** Completed reminders older than this are left in iCloud and not mirrored. */
const COMPLETED_HORIZON_DAYS = 60;

const sameRow = (a: ReminderRow, b: ReminderRow) =>
  a.list === b.list && a.listHref === b.listHref && a.href === b.href && a.etag === b.etag && a.title === b.title && a.notes === b.notes && a.due === b.due && a.completed === b.completed && a.deleted === b.deleted && a.pending === b.pending;

export async function runSync(opts: { dav: DavLike; db: DbLike; homeUrl: string; now?: Date; log?: (msg: string) => void }): Promise<SyncResult> {
  const { dav, db, homeUrl } = opts;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const log = opts.log ?? (() => {});
  const errors: string[] = [];

  // 1. iCloud state.
  const calendars = (await dav.listCalendars(homeUrl)).filter((c) => c.supportsTodo);
  interface Obj extends DavObject {
    cal: Calendar;
  }
  const objects = new Map<string, Obj>(); // by href
  const byUid = new Map<string, Obj>();
  for (const cal of calendars) {
    for (const o of await dav.queryTodos(cal.href)) {
      const obj = { ...o, cal };
      objects.set(o.href, obj);
      const uid = parseVTodo(o.ics)?.uid;
      if (uid) byUid.set(uid, obj);
    }
  }

  // 2. Push pending changes.
  const existing = await db.loadRows();
  const existingByUid = new Map(existing.map((r) => [r.uid, r]));
  const toSave: ReminderRow[] = [];
  const failed = new Set<string>();
  let pushed = 0;

  for (const row of existing) {
    if (!row.pending) continue;
    try {
      if (row.pending === 'delete') {
        const obj = (row.href && objects.get(row.href)) || byUid.get(row.uid);
        if (obj) {
          await dav.delete(obj.href, obj.etag);
          objects.delete(obj.href);
          byUid.delete(row.uid);
        }
        toSave.push({ ...row, deleted: true, pending: null, updatedAt: nowIso });
        pushed++;
      } else if (row.pending === 'create') {
        const cal = calendars.find((c) => c.name.toLowerCase() === row.list.toLowerCase()) ?? calendars.find((c) => c.href === row.listHref) ?? calendars[0];
        if (!cal) throw new Error('No reminder list found in iCloud to create the reminder in');
        const href = `${cal.href.replace(/\/?$/, '/')}${encodeURIComponent(row.uid)}.ics`;
        const ics = buildVTodo({ uid: row.uid, summary: row.title, due: row.due, description: row.notes }, now);
        const etag = await dav.put(href, ics, null);
        const obj: Obj = { href, etag, ics, cal };
        objects.set(href, obj);
        byUid.set(row.uid, obj);
        pushed++;
      } else {
        const obj = (row.href && objects.get(row.href)) || byUid.get(row.uid);
        if (!obj) {
          // Edited here, but gone from iCloud: iCloud wins, tombstone.
          toSave.push({ ...row, deleted: true, pending: null, updatedAt: nowIso });
          continue;
        }
        const ics = updateVTodo(obj.ics, { summary: row.title, due: row.due, completed: row.completed }, now);
        const etag = await dav.put(obj.href, ics, obj.etag);
        obj.ics = ics;
        obj.etag = etag ?? null;
        pushed++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.add(row.uid);
      errors.push(`${row.title}: ${msg}`);
      log(`push failed for ${row.uid}: ${msg}`);
    }
  }

  // 3. Rows from iCloud state.
  const horizon = new Date(now.getTime() - COMPLETED_HORIZON_DAYS * 86400000).toISOString();
  const seen = new Set<string>();
  let pulled = 0;
  for (const obj of objects.values()) {
    const todo = parseVTodo(obj.ics);
    if (!todo) continue;
    const prev = existingByUid.get(todo.uid);
    if (todo.completed && !prev && (todo.completedAt ?? todo.lastModified ?? '') < horizon) continue;
    seen.add(todo.uid);
    const row: ReminderRow = {
      uid: todo.uid,
      list: obj.cal.name,
      listHref: obj.cal.href,
      href: obj.href,
      etag: obj.etag ?? undefined,
      title: todo.summary,
      notes: todo.description,
      due: todo.due,
      completed: todo.completed,
      completedAt: todo.completedAt,
      deleted: false,
      pending: null,
      updatedAt: nowIso,
    };
    // A push that failed keeps its pending flag so it is retried next time.
    if (failed.has(todo.uid)) continue;
    if (!prev || !sameRow(prev, row)) {
      toSave.push(row);
      pulled++;
    }
  }

  // Tombstone rows whose reminder no longer exists in iCloud.
  let tombstoned = 0;
  for (const row of existing) {
    if (row.deleted || seen.has(row.uid) || failed.has(row.uid) || toSave.some((r) => r.uid === row.uid)) continue;
    toSave.push({ ...row, deleted: true, pending: null, updatedAt: nowIso });
    tombstoned++;
  }

  if (toSave.length) await db.saveRows(toSave);
  return { lists: calendars.map((c) => c.name), pushed, pulled, tombstoned, errors };
}
