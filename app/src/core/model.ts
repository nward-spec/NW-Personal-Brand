// Pure functions over the journal data. None of these mutate their input;
// each returns a new document with `updatedAt` stamped, so the store and the
// sync layer can rely on timestamps alone.

import { DAY_KEYS, type DayKey, nowISO } from './week';
import { newId, type AppData, type Day, type Goal, type Habit, type Item, type ReminderRow, type Templates, type WeekDoc } from './types';

export const PRIORITY_SLOTS = 3;

const clone = <T>(v: T): T => (typeof structuredClone === 'function' ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T));

const norm = (s: string) => s.trim().toLowerCase();

export function emptyDays(): Record<DayKey, Day> {
  const days = {} as Record<DayKey, Day>;
  for (const k of DAY_KEYS) days[k] = { items: [], outfit: '' };
  return days;
}

export function emptyWeek(weekStart: string, now: string = nowISO()): WeekDoc {
  return {
    weekStart,
    priorities: Array.from({ length: PRIORITY_SLOTS }, () => ''),
    todos: [],
    goals: [],
    notes: '',
    habits: [],
    days: emptyDays(),
    updatedAt: now,
  };
}

export function emptyTemplates(now: string = nowISO()): Templates {
  return { goals: [], habits: [], updatedAt: now };
}

export function defaultData(): AppData {
  return { weeks: {}, templates: emptyTemplates(), reminders: {} };
}

/** Apply `fn` to a copy of the week and stamp the result. */
export function mutate(week: WeekDoc, fn: (draft: WeekDoc) => void, now: string = nowISO()): WeekDoc {
  const draft = clone(week);
  fn(draft);
  draft.updatedAt = now;
  return draft;
}

function seedGoalItems(draft: WeekDoc, goal: Goal) {
  for (const day of goal.days) {
    const already = draft.days[day].items.some((i) => i.goalId === goal.id);
    if (!already) draft.days[day].items.push({ id: newId(), text: goal.text, done: false, goalId: goal.id });
  }
}

function removeGoalItems(draft: WeekDoc, goalId: string, onlyDays?: DayKey[]) {
  for (const day of DAY_KEYS) {
    if (onlyDays && !onlyDays.includes(day)) continue;
    draft.days[day].items = draft.days[day].items.filter((i) => !(i.goalId === goalId && !i.done));
  }
}

function refreshGoalDone(draft: WeekDoc, goalId: string) {
  const goal = draft.goals.find((g) => g.id === goalId);
  if (!goal) return;
  const linked = DAY_KEYS.flatMap((d) => draft.days[d].items.filter((i) => i.goalId === goalId));
  if (linked.length > 0 && linked.every((i) => i.done)) goal.done = true;
}

/**
 * Build a fresh week: goals and habits come from the templates (goal days are
 * seeded onto the matching days), unfinished to-dos roll over from the most
 * recent earlier week.
 */
export function createWeekFromTemplates(weekStart: string, templates: Templates, previous?: WeekDoc, now: string = nowISO()): WeekDoc {
  const week = emptyWeek(weekStart, now);
  for (const t of templates.goals) {
    const goal: Goal = { id: newId(), text: t.text, days: [...t.days], done: false };
    week.goals.push(goal);
    seedGoalItems(week, goal);
  }
  for (const t of templates.habits) {
    week.habits.push({ id: newId(), text: t.text, target: t.target, checks: DAY_KEYS.map(() => false) });
  }
  if (previous) {
    week.todos = previous.todos.filter((t) => !t.done).map((t) => ({ id: newId(), text: t.text, done: false }));
  }
  return week;
}

export function mostRecentWeekBefore(weeks: Record<string, WeekDoc>, weekStart: string): WeekDoc | undefined {
  const earlier = Object.keys(weeks).filter((k) => k < weekStart).sort();
  const key = earlier[earlier.length - 1];
  return key ? weeks[key] : undefined;
}

// ---- Priorities & notes -------------------------------------------------

export const setPriority = (week: WeekDoc, index: number, text: string) =>
  mutate(week, (d) => {
    while (d.priorities.length < PRIORITY_SLOTS) d.priorities.push('');
    d.priorities[index] = text;
  });

export const setNotes = (week: WeekDoc, text: string) => mutate(week, (d) => void (d.notes = text));

// ---- To-do list -----------------------------------------------------------

export const addTodo = (week: WeekDoc, text: string) =>
  mutate(week, (d) => {
    if (text.trim()) d.todos.push({ id: newId(), text: text.trim(), done: false });
  });

export const toggleTodo = (week: WeekDoc, id: string) =>
  mutate(week, (d) => {
    const t = d.todos.find((x) => x.id === id);
    if (t) t.done = !t.done;
  });

export const editTodo = (week: WeekDoc, id: string, text: string) =>
  mutate(week, (d) => {
    const t = d.todos.find((x) => x.id === id);
    if (t) t.text = text.trim();
  });

export const deleteTodo = (week: WeekDoc, id: string) => mutate(week, (d) => void (d.todos = d.todos.filter((x) => x.id !== id)));

/** Move a to-do onto a specific day (it leaves the to-do list). */
export const sendTodoToDay = (week: WeekDoc, id: string, day: DayKey) =>
  mutate(week, (d) => {
    const t = d.todos.find((x) => x.id === id);
    if (!t) return;
    d.todos = d.todos.filter((x) => x.id !== id);
    d.days[day].items.push({ id: t.id, text: t.text, done: t.done });
  });

// ---- Day entries ---------------------------------------------------------

export const addDayItem = (week: WeekDoc, day: DayKey, text: string) =>
  mutate(week, (d) => {
    if (text.trim()) d.days[day].items.push({ id: newId(), text: text.trim(), done: false });
  });

export const toggleDayItem = (week: WeekDoc, day: DayKey, id: string) =>
  mutate(week, (d) => {
    const it = d.days[day].items.find((x) => x.id === id);
    if (!it) return;
    it.done = !it.done;
    if (it.goalId) refreshGoalDone(d, it.goalId);
  });

export const editDayItem = (week: WeekDoc, day: DayKey, id: string, text: string) =>
  mutate(week, (d) => {
    const it = d.days[day].items.find((x) => x.id === id);
    if (it) it.text = text.trim();
  });

export const deleteDayItem = (week: WeekDoc, day: DayKey, id: string) =>
  mutate(week, (d) => void (d.days[day].items = d.days[day].items.filter((x) => x.id !== id)));

/** Move an entry from one day to another, keeping its done state. */
export const moveDayItem = (week: WeekDoc, from: DayKey, id: string, to: DayKey) =>
  mutate(week, (d) => {
    if (from === to) return;
    const it = d.days[from].items.find((x) => x.id === id);
    if (!it) return;
    d.days[from].items = d.days[from].items.filter((x) => x.id !== id);
    d.days[to].items.push(it);
  });

/** Move a day entry back onto the weekly to-do list. */
export const sendDayItemToTodos = (week: WeekDoc, from: DayKey, id: string) =>
  mutate(week, (d) => {
    const it = d.days[from].items.find((x) => x.id === id);
    if (!it) return;
    d.days[from].items = d.days[from].items.filter((x) => x.id !== id);
    d.todos.push({ id: it.id, text: it.text, done: it.done });
  });

export const setOutfit = (week: WeekDoc, day: DayKey, text: string) => mutate(week, (d) => void (d.days[day].outfit = text));

// ---- Weekly goals -------------------------------------------------------

export const addGoal = (week: WeekDoc, text: string, days: DayKey[]) =>
  mutate(week, (d) => {
    if (!text.trim()) return;
    const goal: Goal = { id: newId(), text: text.trim(), days: [...days], done: false };
    d.goals.push(goal);
    seedGoalItems(d, goal);
  });

export const editGoal = (week: WeekDoc, id: string, text: string, days: DayKey[]) =>
  mutate(week, (d) => {
    const g = d.goals.find((x) => x.id === id);
    if (!g) return;
    const removed = g.days.filter((day) => !days.includes(day));
    g.text = text.trim();
    g.days = [...days];
    removeGoalItems(d, g.id, removed);
    for (const day of DAY_KEYS) for (const it of d.days[day].items) if (it.goalId === g.id) it.text = g.text;
    seedGoalItems(d, g);
  });

export const toggleGoal = (week: WeekDoc, id: string) =>
  mutate(week, (d) => {
    const g = d.goals.find((x) => x.id === id);
    if (g) g.done = !g.done;
  });

export const deleteGoal = (week: WeekDoc, id: string) =>
  mutate(week, (d) => {
    d.goals = d.goals.filter((x) => x.id !== id);
    removeGoalItems(d, id);
  });

/** "1/2" style progress for a goal, from its linked day entries. */
export function goalProgress(week: WeekDoc, goal: Goal): { done: number; total: number } {
  const linked: Item[] = DAY_KEYS.flatMap((d) => week.days[d].items.filter((i) => i.goalId === goal.id));
  return { done: linked.filter((i) => i.done).length, total: linked.length };
}

// ---- Habits ---------------------------------------------------------------

export const addHabit = (week: WeekDoc, text: string, target: string) =>
  mutate(week, (d) => {
    if (text.trim()) d.habits.push({ id: newId(), text: text.trim(), target: target.trim(), checks: DAY_KEYS.map(() => false) });
  });

export const editHabit = (week: WeekDoc, id: string, text: string, target: string) =>
  mutate(week, (d) => {
    const h = d.habits.find((x) => x.id === id);
    if (h) {
      h.text = text.trim();
      h.target = target.trim();
    }
  });

export const deleteHabit = (week: WeekDoc, id: string) => mutate(week, (d) => void (d.habits = d.habits.filter((x) => x.id !== id)));

export const toggleHabitCheck = (week: WeekDoc, id: string, dayIdx: number) =>
  mutate(week, (d) => {
    const h = d.habits.find((x) => x.id === id);
    if (!h) return;
    while (h.checks.length < 7) h.checks.push(false);
    h.checks[dayIdx] = !h.checks[dayIdx];
  });

export function habitCount(h: Habit): number {
  return h.checks.filter(Boolean).length;
}

// ---- Templates ----------------------------------------------------------

/** Add any template goals/habits the week does not already have (matched by name). */
export const applyTemplates = (week: WeekDoc, templates: Templates) =>
  mutate(week, (d) => {
    for (const t of templates.goals) {
      if (d.goals.some((g) => norm(g.text) === norm(t.text))) continue;
      const goal: Goal = { id: newId(), text: t.text, days: [...t.days], done: false };
      d.goals.push(goal);
      seedGoalItems(d, goal);
    }
    for (const t of templates.habits) {
      if (d.habits.some((h) => norm(h.text) === norm(t.text))) continue;
      d.habits.push({ id: newId(), text: t.text, target: t.target, checks: DAY_KEYS.map(() => false) });
    }
  });

/** Replace the templates with this week's goals and habits. */
export function templatesFromWeek(week: WeekDoc, now: string = nowISO()): Templates {
  return {
    goals: week.goals.map((g) => ({ id: newId(), text: g.text, days: [...g.days] })),
    habits: week.habits.map((h) => ({ id: newId(), text: h.text, target: h.target })),
    updatedAt: now,
  };
}

export function mutateTemplates(t: Templates, fn: (draft: Templates) => void, now: string = nowISO()): Templates {
  const draft = clone(t);
  fn(draft);
  draft.updatedAt = now;
  return draft;
}

// ---- Merging (import + sync) --------------------------------------------

export interface MergeResult {
  merged: AppData;
  /** Keys ("week:YYYY-MM-DD" | "templates" | "reminder:<uid>") where the local copy was newer. */
  localNewer: string[];
  /** Keys where the incoming copy won. */
  incomingNewer: string[];
}

/** Last-write-wins merge of two data sets by `updatedAt`. */
export function mergeData(local: AppData, incoming: Partial<AppData>): MergeResult {
  const merged: AppData = { weeks: { ...local.weeks }, templates: local.templates, reminders: { ...local.reminders } };
  const localNewer: string[] = [];
  const incomingNewer: string[] = [];

  for (const [uid, row] of Object.entries(incoming.reminders ?? {})) {
    const mine = merged.reminders[uid];
    if (!mine || row.updatedAt > mine.updatedAt) {
      merged.reminders[uid] = row;
      incomingNewer.push(`reminder:${uid}`);
    } else if (mine.updatedAt > row.updatedAt) {
      localNewer.push(`reminder:${uid}`);
    }
  }

  for (const [key, week] of Object.entries(incoming.weeks ?? {})) {
    const mine = merged.weeks[key];
    if (!mine || week.updatedAt > mine.updatedAt) {
      merged.weeks[key] = week;
      incomingNewer.push(`week:${key}`);
    } else if (mine.updatedAt > week.updatedAt) {
      localNewer.push(`week:${key}`);
    }
  }
  if (incoming.templates) {
    if (incoming.templates.updatedAt > merged.templates.updatedAt) {
      merged.templates = incoming.templates;
      incomingNewer.push('templates');
    } else if (merged.templates.updatedAt > incoming.templates.updatedAt) {
      localNewer.push('templates');
    }
  }
  return { merged, localNewer, incomingNewer };
}

/** Best-effort validation for imported or fetched documents. */
export function isWeekDoc(v: unknown): v is WeekDoc {
  if (!v || typeof v !== 'object') return false;
  const w = v as Partial<WeekDoc>;
  return typeof w.weekStart === 'string' && typeof w.updatedAt === 'string' && Array.isArray(w.todos) && !!w.days && typeof w.days === 'object';
}

export function isReminderRow(v: unknown): v is ReminderRow {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<ReminderRow>;
  return typeof r.uid === 'string' && typeof r.title === 'string' && typeof r.list === 'string' && typeof r.updatedAt === 'string';
}

export function normaliseReminder(r: ReminderRow): ReminderRow {
  return {
    uid: r.uid,
    list: r.list,
    listHref: r.listHref,
    href: r.href,
    etag: r.etag,
    title: r.title,
    notes: typeof r.notes === 'string' ? r.notes : '',
    due: typeof r.due === 'string' && r.due ? r.due.slice(0, 10) : null,
    completed: !!r.completed,
    completedAt: r.completedAt ?? null,
    deleted: !!r.deleted,
    pending: r.pending ?? null,
    dispatchedAt: r.dispatchedAt ?? null,
    updatedAt: r.updatedAt,
  };
}

export function isTemplates(v: unknown): v is Templates {
  if (!v || typeof v !== 'object') return false;
  const t = v as Partial<Templates>;
  return Array.isArray(t.goals) && Array.isArray(t.habits) && typeof t.updatedAt === 'string';
}

/** Fill in anything an older or hand-edited document might be missing. */
export function normaliseWeek(w: WeekDoc): WeekDoc {
  const base = emptyWeek(w.weekStart, w.updatedAt);
  const days = emptyDays();
  for (const k of DAY_KEYS) {
    const d = w.days?.[k];
    if (d) days[k] = { items: Array.isArray(d.items) ? d.items : [], outfit: typeof d.outfit === 'string' ? d.outfit : '' };
  }
  return {
    ...base,
    ...w,
    priorities: Array.isArray(w.priorities) ? w.priorities : base.priorities,
    goals: Array.isArray(w.goals) ? w.goals : [],
    habits: Array.isArray(w.habits) ? w.habits.map((h) => ({ ...h, checks: DAY_KEYS.map((_, i) => !!h.checks?.[i]) })) : [],
    notes: typeof w.notes === 'string' ? w.notes : '',
    days,
  };
}
