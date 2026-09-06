// Two-way sync with Apple Reminders through an iPhone Shortcut.
//
// Apple removed CalDAV access to Reminders in iOS 13, so the phone itself has
// to be the bridge. The Shortcut sends a snapshot of the reminders it can see
// (one per line: title, list, due date, completed) and receives back commands
// to apply. Commands refer to reminders by their line number in the snapshot
// the Shortcut just sent, which is also the item's position in the Shortcut's
// own "Find Reminders" result, so the Shortcut never has to search by name:
//
//   delete | <line number> | <title> |        Get Item from List → Remove Reminders
//   create | <list> | <title> | <due>          Add New Reminder
//
// The snapshot holds open reminders only. Ticking a reminder in the app removes
// it from the phone (the app keeps it as done); one that disappears from the
// phone is shown as done here; renames, date changes and un-ticking become
// delete + create.

import type { ReminderRow } from '../reminders-sync/sync.ts';

export interface PhoneReminder {
  /** 1-based line number in the snapshot: the Shortcut's list index. */
  index: number;
  list: string;
  title: string;
  due: string | null;
  completed: boolean;
}

export type Command = { op: 'delete'; index: number; title: string } | { op: 'create'; list: string; title: string; due: string | null };

export interface ReconcileResult {
  /** Rows to write back (only those that changed). */
  save: ReminderRow[];
  commands: Command[];
  lists: string[];
  pulled: number;
  tombstoned: number;
}

/**
 * A change handed to the phone is applied in the same run, so the very next
 * snapshot should show it. Wait this long before assuming the phone failed and
 * sending it again (or, for an untouched row, treating its absence as done).
 */
const GRACE_MS = 10 * 60 * 1000;

const SEP = '';
const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
export const keyOf = (list: string, title: string) => `${norm(list).toLowerCase()}${SEP}${norm(title).toLowerCase()}`;

const pad2 = (n: number) => String(n).padStart(2, '0');

function parseDue(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // Day-first locales (Australia, UK): "17/03/2026, 6:00 pm" or "17/3/26".
  const dmy = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/.exec(s);
  if (dmy) {
    const y = dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
    return `${y}-${pad2(Number(dmy[2]))}-${pad2(Number(dmy[1]))}`;
  }
  // "17 Mar 2026 at 6:00 pm", "Mar 17, 2026 at 6:00 PM".
  const t = Date.parse(s.replace(/\s+at\s+/i, ' '));
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  return null;
}

function parseBool(raw: string): boolean {
  return /^(yes|true|1|completed|done)$/i.test(raw.trim());
}

/**
 * Lines of "title | list | due | completed" (a tab also works as separator).
 * Every non-empty line counts towards the index, even a malformed one, so
 * indices keep matching the Shortcut's list.
 */
export function parseSnapshot(text: string): PhoneReminder[] {
  const out: PhoneReminder[] = [];
  let index = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    index++;
    const parts = raw.includes('\t') ? raw.split('\t') : raw.split(' | ');
    if (parts.length < 2) continue;
    const [title, list, due = '', completed = ''] = parts;
    if (!title.trim() || !list.trim()) continue;
    out.push({ index, title: norm(title), list: norm(list), due: parseDue(due), completed: parseBool(completed) });
  }
  return out;
}

export function formatCommands(commands: Command[]): string {
  return commands.map((c) => (c.op === 'delete' ? ['delete', String(c.index), c.title, ''] : ['create', c.list, c.title, c.due ?? '']).join(' | ')).join('\n');
}

interface RowWithDispatch extends ReminderRow {
  dispatchedAt?: string | null;
}

export function reconcile(opts: { rows: ReminderRow[]; snapshot: PhoneReminder[]; now?: Date; newId: () => string }): ReconcileResult {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const save: RowWithDispatch[] = [];
  const commands: Command[] = [];

  const phone = new Map<string, PhoneReminder>();
  for (const p of opts.snapshot) if (!phone.has(keyOf(p.list, p.title))) phone.set(keyOf(p.list, p.title), p);
  const consumed = new Set<string>();

  const recentlyDispatched = (r: RowWithDispatch) => !!r.dispatchedAt && nowMs - Date.parse(r.dispatchedAt) < GRACE_MS;
  const create = (r: ReminderRow) => commands.push({ op: 'create', list: r.list, title: r.title, due: r.due });
  const remove = (p: PhoneReminder) => commands.push({ op: 'delete', index: p.index, title: p.title });

  // An app-created row whose list + title already belongs to another live row
  // (the phone had it first) is folded into that row: its edits move across
  // and the duplicate is dropped, so the journal never shows two of them.
  const rows: RowWithDispatch[] = (opts.rows as RowWithDispatch[]).map((r) => ({ ...r }));
  const liveByKey = new Map<string, RowWithDispatch>();
  for (const r of rows) if (!r.deleted && r.pending !== 'create') liveByKey.set(r.href ?? keyOf(r.list, r.title), r);
  for (const r of rows) {
    if (r.deleted || r.pending !== 'create') continue;
    const twin = liveByKey.get(keyOf(r.list, r.title));
    if (!twin) continue;
    if ((twin.due ?? null) !== (r.due ?? null) || twin.completed !== r.completed) {
      twin.due = r.due;
      twin.completed = r.completed;
      twin.completedAt = r.completedAt ?? null;
      twin.pending = 'update';
    }
    r.deleted = true;
    r.pending = null;
    r.updatedAt = nowIso;
    save.push(r);
  }

  for (const row of rows) {
    if (row.deleted) continue;
    const oldKey = row.href ?? keyOf(row.list, row.title);
    const newKey = keyOf(row.list, row.title);
    const item = phone.get(oldKey);

    if (row.pending === 'delete') {
      if (item) remove(item);
      consumed.add(oldKey);
      save.push({ ...row, deleted: true, pending: null, updatedAt: nowIso });
      continue;
    }

    if (row.pending === 'create') {
      const existing = phone.get(newKey);
      if (row.completed) {
        if (existing) remove(existing);
      } else if (!existing) {
        create(row);
      } else if ((existing.due ?? null) !== (row.due ?? null)) {
        // Same name already on the phone but with a different date: re-date it.
        remove(existing);
        create(row);
      }
      consumed.add(newKey);
      save.push({ ...row, pending: null, href: newKey, dispatchedAt: nowIso, updatedAt: nowIso });
      continue;
    }

    if (row.pending === 'update') {
      if (!item) {
        if (recentlyDispatched(row)) continue; // the phone has not caught up yet; keep waiting
        if (!row.completed) create(row); // edited here but gone from the phone: put it back
        consumed.add(newKey);
        save.push({ ...row, pending: null, href: newKey, dispatchedAt: nowIso, updatedAt: nowIso });
        continue;
      }
      const moved = newKey !== oldKey || (item.due ?? null) !== (row.due ?? null);
      if (row.completed) {
        // Done in the app: take it off the phone; the app keeps it ticked.
        remove(item);
      } else if (moved || item.completed) {
        remove(item);
        create(row);
      }
      consumed.add(oldKey);
      consumed.add(newKey);
      save.push({ ...row, pending: null, href: newKey, dispatchedAt: nowIso, updatedAt: nowIso });
      continue;
    }

    // No pending edit: the phone is the truth, once its snapshot has caught up.
    if (!item) {
      if (row.completed || recentlyDispatched(row)) continue; // done items live on in the app
      // The snapshot only carries open reminders, so one that is gone was ticked
      // (or deleted) on the phone: show it as done here.
      save.push({ ...row, completed: true, completedAt: nowIso, pending: null, dispatchedAt: null, updatedAt: nowIso });
      continue;
    }
    consumed.add(oldKey);
    if (recentlyDispatched(row) && (item.completed !== row.completed || (item.due ?? null) !== (row.due ?? null))) continue;
    if (item.completed !== row.completed || (item.due ?? null) !== (row.due ?? null) || item.title !== row.title || item.list !== row.list) {
      save.push({
        ...row,
        list: item.list,
        title: item.title,
        due: item.due,
        completed: item.completed,
        completedAt: item.completed ? (row.completed ? row.completedAt : nowIso) : null,
        href: keyOf(item.list, item.title),
        dispatchedAt: null,
        updatedAt: nowIso,
      });
    }
  }

  // Reminders on the phone the app has never seen.
  let pulled = 0;
  for (const [key, p] of phone) {
    if (consumed.has(key)) continue;
    save.push({
      uid: `${opts.newId()}@shortcut`,
      list: p.list,
      title: p.title,
      notes: '',
      due: p.due,
      completed: p.completed,
      completedAt: p.completed ? nowIso : null,
      deleted: false,
      pending: null,
      href: key,
      updatedAt: nowIso,
    });
    pulled++;
  }

  const tombstoned = save.filter((r) => r.deleted && !opts.rows.find((o) => o.uid === r.uid)?.deleted).length;
  const lists = [...new Set(opts.snapshot.map((p) => p.list))].sort();
  return { save, commands, lists, pulled, tombstoned };
}
