import { useState } from 'react';
import {
  addGoal,
  addHabit,
  addTodo,
  deleteGoal,
  deleteHabit,
  deleteTodo,
  editGoal,
  editHabit,
  editTodo,
  goalProgress,
  sendTodoToDay,
  setNotes,
  setPriority,
  toggleGoal,
  toggleHabitCheck,
  toggleTodo,
  PRIORITY_SLOTS,
} from '../core/model';
import type { Goal, Habit } from '../core/types';
import type { DayKey } from '../core/week';
import { store, updateWeek, useAppData, useWeek } from '../web/app-store';
import { DEFAULT_DINNERS_LIST, deleteReminder, renameReminder, setReminderDue, toggleReminder, undatedReminders } from '../core/reminders';
import { useReminders } from '../web/reminders';
import { weekDates } from '../core/week';
import { DayPick, daysLabel } from './Chips';
import { GoalSheet, HabitSheet, ItemSheet } from './EditorSheets';
import { HabitGrid } from './HabitGrid';
import { AddRow, CheckRow } from './Rows';

type SheetState = { kind: 'todo'; id: string } | { kind: 'goal'; goal?: Goal } | { kind: 'habit'; habit?: Habit } | null;

export function WeekScreen({ weekStart }: { weekStart: string }) {
  const week = useWeek(weekStart);
  const data = useAppData();
  const { account } = useReminders();
  const undated = undatedReminders(data, { excludeList: account?.dinnersList ?? DEFAULT_DINNERS_LIST });
  const [sheet, setSheet] = useState<SheetState>(null);
  const [rsheet, setRsheet] = useState<string | null>(null);
  const rem = rsheet ? data.reminders[rsheet] : undefined;
  const close = () => setSheet(null);
  const edit = (fn: Parameters<typeof updateWeek>[1]) => updateWeek(weekStart, fn);

  const todo = sheet?.kind === 'todo' ? week.todos.find((t) => t.id === sheet.id) : undefined;
  const goalsDone = week.goals.filter((g) => g.done).length;

  return (
    <>
      <section className="card" aria-labelledby="priorities">
        <div className="card-head">
          <h2 className="card-title" id="priorities">
            Top priorities
          </h2>
        </div>
        <div className="priorities">
          {Array.from({ length: PRIORITY_SLOTS }, (_, i) => (
            <label className="priority" key={i}>
              <span className="num" aria-hidden="true">
                {i + 1}
              </span>
              <input
                value={week.priorities[i] ?? ''}
                placeholder={i === 0 ? 'What matters most this week?' : ''}
                onChange={(e) => edit((w) => setPriority(w, i, e.target.value))}
                aria-label={`Priority ${i + 1}`}
                autoComplete="off"
              />
            </label>
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby="todos">
        <div className="card-head">
          <h2 className="card-title" id="todos">
            To do list
          </h2>
          {week.todos.length + undated.length > 0 && (
            <span className="hint">
              {week.todos.filter((t) => t.done).length + undated.filter((r) => r.completed).length}/{week.todos.length + undated.length}
            </span>
          )}
        </div>
        <ul className="rows">
          {week.todos.map((t) => (
            <CheckRow key={t.id} done={t.done} text={t.text} onToggle={() => edit((w) => toggleTodo(w, t.id))} onMore={() => setSheet({ kind: 'todo', id: t.id })} />
          ))}
          {undated.map((r) => (
            <CheckRow
              key={r.uid}
              done={r.completed}
              text={r.title}
              sub={
                <>
                  <span className={`tag${r.pending ? ' pending' : ''}`}>Reminders</span> {r.list}
                </>
              }
              onToggle={() => store.updateReminder(r.uid, toggleReminder)}
              onMore={() => setRsheet(r.uid)}
            />
          ))}
        </ul>
        <AddRow placeholder="Add a to-do" onAdd={(text) => edit((w) => addTodo(w, text))} />
      </section>

      <section className="card" aria-labelledby="goals">
        <div className="card-head">
          <h2 className="card-title" id="goals">
            Weekly goals
          </h2>
          {week.goals.length > 0 && (
            <span className="hint">
              {goalsDone}/{week.goals.length}
            </span>
          )}
        </div>
        {week.goals.length === 0 && <div className="empty">Plan the week: e.g. Walk on Tue &amp; Thu, Pilates on Wed.</div>}
        <ul className="rows">
          {week.goals.map((g) => {
            const p = goalProgress(week, g);
            return (
              <CheckRow
                key={g.id}
                done={g.done}
                text={g.text}
                sub={
                  g.days.length > 0 ? (
                    <>
                      {daysLabel(g.days)}
                      {p.total > 0 && (
                        <>
                          {' · '}
                          <span className="linked">
                            {p.done}/{p.total} done
                          </span>
                        </>
                      )}
                    </>
                  ) : undefined
                }
                onToggle={() => edit((w) => toggleGoal(w, g.id))}
                onMore={() => setSheet({ kind: 'goal', goal: g })}
              />
            );
          })}
        </ul>
        <div className="btnrow">
          <button type="button" className="btn sm" onClick={() => setSheet({ kind: 'goal' })}>
            + Add goal
          </button>
        </div>
      </section>

      <section className="card notes" aria-labelledby="notes">
        <div className="card-head">
          <h2 className="card-title" id="notes">
            Notes
          </h2>
        </div>
        <textarea value={week.notes} placeholder="Anything to remember this week…" onChange={(e) => edit((w) => setNotes(w, e.target.value))} aria-label="Notes" />
      </section>

      <section className="card" aria-labelledby="habits">
        <div className="card-head">
          <h2 className="card-title" id="habits">
            Weekly habits
          </h2>
          <span className="hint">tap a dot</span>
        </div>
        <HabitGrid habits={week.habits} weekStart={weekStart} onToggle={(id, i) => edit((w) => toggleHabitCheck(w, id, i))} onEdit={(h) => setSheet({ kind: 'habit', habit: h })} />
        <div className="btnrow">
          <button type="button" className="btn sm" onClick={() => setSheet({ kind: 'habit' })}>
            + Add habit
          </button>
        </div>
      </section>

      <ItemSheet
        open={sheet?.kind === 'todo' && !!todo}
        title="To-do"
        text={todo?.text ?? ''}
        onClose={close}
        onSave={(text) => todo && edit((w) => editTodo(w, todo.id, text))}
        onDelete={() => todo && edit((w) => deleteTodo(w, todo.id))}
      >
        <div className="section">
          <div className="card-title">Send to a day</div>
          <DayPick
            onPick={(day: DayKey) => {
              if (todo) edit((w) => sendTodoToDay(w, todo.id, day));
              close();
            }}
          />
          <p className="note">Moves it off the to-do list and onto {`that day's`} plan.</p>
        </div>
      </ItemSheet>

      <ItemSheet
        open={!!rem}
        title={rem ? `Reminder · ${rem.list}` : ''}
        text={rem?.title ?? ''}
        onClose={() => setRsheet(null)}
        onSave={(text) => rem && store.updateReminder(rem.uid, (r) => renameReminder(r, text))}
        onDelete={() => rem && store.updateReminder(rem.uid, deleteReminder)}
      >
        {rem && (
          <div className="section">
            <div className="card-title">Give it a day</div>
            <DayPick
              onPick={(day) => {
                store.updateReminder(rem.uid, (r) => setReminderDue(r, weekDates(weekStart)[['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(day)]));
                setRsheet(null);
              }}
            />
            <p className="note">Sets the due date in Apple Reminders, so it moves onto that day.</p>
          </div>
        )}
      </ItemSheet>

      <GoalSheet
        open={sheet?.kind === 'goal'}
        initial={sheet?.kind === 'goal' && sheet.goal ? { text: sheet.goal.text, days: sheet.goal.days } : undefined}
        onClose={close}
        onSave={(text, days) => {
          const g = sheet?.kind === 'goal' ? sheet.goal : undefined;
          edit((w) => (g ? editGoal(w, g.id, text, days) : addGoal(w, text, days)));
        }}
        onDelete={sheet?.kind === 'goal' && sheet.goal ? () => edit((w) => deleteGoal(w, (sheet as { goal: Goal }).goal.id)) : undefined}
      />

      <HabitSheet
        open={sheet?.kind === 'habit'}
        initial={sheet?.kind === 'habit' && sheet.habit ? { text: sheet.habit.text, target: sheet.habit.target } : undefined}
        onClose={close}
        onSave={(text, target) => {
          const h = sheet?.kind === 'habit' ? sheet.habit : undefined;
          edit((w) => (h ? editHabit(w, h.id, text, target) : addHabit(w, text, target)));
        }}
        onDelete={sheet?.kind === 'habit' && sheet.habit ? () => edit((w) => deleteHabit(w, (sheet as { habit: Habit }).habit.id)) : undefined}
      />
    </>
  );
}
