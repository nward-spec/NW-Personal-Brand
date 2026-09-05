// Two-way sync with Apple Reminders through an iPhone Shortcut.
//
// Apple removed CalDAV access to Reminders in iOS 13, so the phone itself has
// to be the bridge. The Shortcut sends a snapshot of the reminders it can see
// (one per line: title, list, due date, completed), and receives back a short
// list of commands to apply. Reminders are matched by list + title, the only
// stable handle the Shortcuts app gives us, so the app's edits are expressed
// as three operations the Shortcut knows how to run:
//
//   complete | list | title |        Edit Reminder → Is Completed = true
//   create   | list | title | due    Add New Reminder
//   delete   | list | title |        Find Reminders → Remove Reminders
//
// Renames, date changes and un-completing become delete + create.

import type { ReminderRow } from '../reminders-sync/sync.ts';

export interface PhoneReminder {
  list: string;
  title: string;
  due: string | null;
  completed: boolean;
}

export interface Command {
  op: 'complete' | 'create' | 'delete';
  list: string;
  title: string;
  due?: string | null;
}

export interface ReconcileResult {
  /** Rows to write back (only those that changed). */
  save: ReminderRow[];
  commands: Command[];
  lists: string[];
  pulled: number;
  tombstoned: number;
}

/** A row the app pushed to the phone waits this long for the phone to confirm. */
const GRACE_MS = 24 * 3600 * 1000;

const SEP = '';
const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
export const keyOf = (list: string, title: string) => `${norm(list).toLowerCase()}${SEP}${norm(title).toLowerCase()}`;

function parseDue(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // Shortcuts default formats such as "17 Mar 2026 at 9:00 am" or "3/17/26, 9:00 AM".
  const t = Date.parse(s.replace(/\s+at\s+/i, ' '));
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return null;
}

function parseBool(raw: string): boolean {
  return /^(yes|true|1|completed|done)$/i.test(raw.trim());
}

/** Lines of "title<TAB>list<TAB>due<TAB>completed". Blank and malformed lines are skipped. */
export function parseSnapshot(text: string): PhoneReminder[] {
  const out: PhoneReminder[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const parts = raw.includes('\t') ? raw.split('\t') : raw.split(' | ');
    if (parts.length < 2) continue;
    const [title, list, due = '', completed = ''] = parts;
    if (!title.trim() || !list.trim()) continue;
    out.push({ title: norm(title), list: norm(list), due: parseDue(due), completed: parseBool(completed) });
  }
  return out;
}

export function formatCommands(commands: Command[]): string {
  return commands.map((c) => [c.op, c.list, c.title, c.due ?? ''].join(' | ')).join('\n');
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

  for (const row of opts.rows as RowWithDispatch[]) {
    if (row.deleted) continue;
    const oldKey = row.href ?? keyOf(row.list, row.title);
    const newKey = keyOf(row.list, row.title);
    const item = phone.get(oldKey);
    const [oldList, oldTitle] = item ? [item.list, item.title] : [row.list, row.title];

    if (row.pending === 'delete') {
      if (item) commands.push({ op: 'delete', list: oldList, title: oldTitle });
      consumed.add(oldKey);
      save.push({ ...row, deleted: true, pending: null, updatedAt: nowIso });
      continue;
    }

    if (row.pending === 'create') {
      if (!phone.has(newKey)) create(row);
      if (row.completed) commands.push({ op: 'complete', list: row.list, title: row.title });
      consumed.add(newKey);
      save.push({ ...row, pending: null, href: newKey, dispatchedAt: nowIso, updatedAt: nowIso });
      continue;
    }

    if (row.pending === 'update') {
      if (!item) {
        if (recentlyDispatched(row)) continue; // the phone has not caught up yet; keep waiting
        // Edited here but gone from the phone: recreate it there.
        create(row);
        if (row.completed) commands.push({ op: 'complete', list: row.list, title: row.title });
        consumed.add(newKey);
        save.push({ ...row, pending: null, href: newKey, dispatchedAt: nowIso, updatedAt: nowIso });
        continue;
      }
      const moved = newKey !== oldKey || (item.due ?? null) !== (row.due ?? null);
      if (moved || (item.completed && !row.completed)) {
        commands.push({ op: 'delete', list: oldList, title: oldTitle });
        create(row);
        if (row.completed) commands.push({ op: 'complete', list: row.list, title: row.title });
      } else if (row.completed && !item.completed) {
        commands.push({ op: 'complete', list: oldList, title: oldTitle });
      }
      consumed.add(oldKey);
      consumed.add(newKey);
      save.push({ ...row, pending: null, href: newKey, dispatchedAt: nowIso, updatedAt: nowIso });
      continue;
    }

    // No pending edit: the phone is the truth, once its snapshot has caught up.
    if (!item) {
      if (recentlyDispatched(row)) continue;
      save.push({ ...row, deleted: true, pending: null, updatedAt: nowIso });
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
