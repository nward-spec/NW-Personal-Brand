import { describe, expect, it } from 'vitest';
import {
  addGoal,
  addTodo,
  applyTemplates,
  createWeekFromTemplates,
  deleteGoal,
  editGoal,
  emptyWeek,
  goalProgress,
  mergeData,
  moveDayItem,
  sendTodoToDay,
  templatesFromWeek,
  toggleDayItem,
  toggleHabitCheck,
  toggleTodo,
} from './model';
import type { Templates } from './types';

const templates: Templates = {
  goals: [
    { id: 'g1', text: 'Walk', days: ['tue', 'thu'] },
    { id: 'g2', text: 'Pilates', days: ['wed'] },
  ],
  habits: [
    { id: 'h1', text: 'Read', target: '15 min' },
    { id: 'h2', text: 'After dinner walk', target: 'x4' },
  ],
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('createWeekFromTemplates', () => {
  it('seeds goals, their day entries, and habits', () => {
    const week = createWeekFromTemplates('2026-03-16', templates);
    expect(week.goals.map((g) => g.text)).toEqual(['Walk', 'Pilates']);
    expect(week.days.tue.items.map((i) => i.text)).toEqual(['Walk']);
    expect(week.days.thu.items.map((i) => i.text)).toEqual(['Walk']);
    expect(week.days.wed.items.map((i) => i.text)).toEqual(['Pilates']);
    expect(week.days.mon.items).toEqual([]);
    expect(week.habits.map((h) => h.text)).toEqual(['Read', 'After dinner walk']);
    expect(week.habits[0].checks).toHaveLength(7);
  });

  it('carries unfinished to-dos over from the previous week', () => {
    let prev = emptyWeek('2026-03-09');
    prev = addTodo(prev, 'Childcare list');
    prev = addTodo(prev, 'Vaccines');
    prev = toggleTodo(prev, prev.todos[1].id);
    const week = createWeekFromTemplates('2026-03-16', templates, prev);
    expect(week.todos.map((t) => t.text)).toEqual(['Childcare list']);
    expect(week.todos[0].id).not.toBe(prev.todos[0].id);
  });
});

describe('day entries', () => {
  it('moves an entry between days', () => {
    let week = createWeekFromTemplates('2026-03-16', templates);
    const yoga = week.days.wed.items[0];
    week = moveDayItem(week, 'wed', yoga.id, 'tue');
    expect(week.days.wed.items).toEqual([]);
    expect(week.days.tue.items.map((i) => i.text)).toEqual(['Walk', 'Pilates']);
  });

  it('marks a goal done once all its day entries are done', () => {
    let week = createWeekFromTemplates('2026-03-16', templates);
    const walk = week.goals[0];
    week = toggleDayItem(week, 'tue', week.days.tue.items[0].id);
    expect(goalProgress(week, walk)).toEqual({ done: 1, total: 2 });
    expect(week.goals[0].done).toBe(false);
    week = toggleDayItem(week, 'thu', week.days.thu.items[0].id);
    expect(week.goals[0].done).toBe(true);
  });

  it('sends a to-do onto a day', () => {
    let week = addTodo(emptyWeek('2026-03-16'), 'Childcare list');
    week = sendTodoToDay(week, week.todos[0].id, 'tue');
    expect(week.todos).toEqual([]);
    expect(week.days.tue.items.map((i) => i.text)).toEqual(['Childcare list']);
  });
});

describe('goals', () => {
  it('editing days adds and removes seeded entries but keeps done ones', () => {
    let week = createWeekFromTemplates('2026-03-16', templates);
    const walk = week.goals[0];
    week = toggleDayItem(week, 'tue', week.days.tue.items[0].id); // Tue walk done
    week = editGoal(week, walk.id, 'Walk 30 min', ['tue', 'fri']);
    expect(week.days.thu.items).toEqual([]); // undone Thu entry removed
    expect(week.days.tue.items[0].text).toBe('Walk 30 min'); // done entry kept and renamed
    expect(week.days.fri.items.map((i) => i.text)).toEqual(['Walk 30 min']);
  });

  it('deleting a goal removes its undone entries', () => {
    let week = createWeekFromTemplates('2026-03-16', templates);
    week = addGoal(week, 'Yoga', ['sun']);
    expect(week.days.sun.items).toHaveLength(1);
    week = deleteGoal(week, week.goals[2].id);
    expect(week.days.sun.items).toHaveLength(0);
  });
});

describe('habits & templates', () => {
  it('toggles a habit dot', () => {
    let week = createWeekFromTemplates('2026-03-16', templates);
    week = toggleHabitCheck(week, week.habits[0].id, 3);
    expect(week.habits[0].checks[3]).toBe(true);
    week = toggleHabitCheck(week, week.habits[0].id, 3);
    expect(week.habits[0].checks[3]).toBe(false);
  });

  it('applies missing templates without duplicating existing ones', () => {
    let week = emptyWeek('2026-03-16');
    week = addGoal(week, 'walk', ['mon']);
    week = applyTemplates(week, templates);
    expect(week.goals.map((g) => g.text)).toEqual(['walk', 'Pilates']);
    expect(week.habits).toHaveLength(2);
  });

  it('builds templates from a week', () => {
    const week = createWeekFromTemplates('2026-03-16', templates);
    const t = templatesFromWeek(week);
    expect(t.goals.map((g) => [g.text, g.days])).toEqual([
      ['Walk', ['tue', 'thu']],
      ['Pilates', ['wed']],
    ]);
    expect(t.habits.map((h) => h.target)).toEqual(['15 min', 'x4']);
  });
});

describe('mergeData', () => {
  it('lets the newer copy win and reports the rest', () => {
    const older = emptyWeek('2026-03-16', '2026-03-16T01:00:00.000Z');
    const newer = emptyWeek('2026-03-16', '2026-03-16T02:00:00.000Z');
    const localOnly = emptyWeek('2026-03-09', '2026-03-09T00:00:00.000Z');
    const local = { weeks: { '2026-03-16': older, '2026-03-09': localOnly }, templates: { ...templates, updatedAt: '2026-02-01T00:00:00.000Z' } };
    const incoming = { weeks: { '2026-03-16': newer }, templates };
    const { merged, localNewer, incomingNewer } = mergeData(local, incoming);
    expect(merged.weeks['2026-03-16'].updatedAt).toBe(newer.updatedAt);
    expect(merged.weeks['2026-03-09']).toBe(localOnly);
    expect(merged.templates.updatedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(incomingNewer).toEqual(['week:2026-03-16']);
    expect(localNewer).toEqual(['templates']);
  });
});
