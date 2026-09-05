import { useState } from 'react';
import { DEFAULT_DINNERS_LIST, createReminder, deleteReminder, dinnersForWeek, renameReminder, setReminderDue, toggleReminder } from '../core/reminders';
import type { ReminderRow } from '../core/types';
import { DAY_KEYS, DAY_LABELS, DAY_SHORT, dayKeyOf, parseISODate, todayISO, weekDates } from '../core/week';
import { store, useAppData } from '../web/app-store';
import { useCloud } from '../web/cloud';
import { useReminders } from '../web/reminders';
import { DayPick } from './Chips';
import { ItemSheet } from './EditorSheets';
import { Sheet } from './Sheet';

type SheetState = { kind: 'edit'; uid: string } | { kind: 'add'; date: string } | { kind: 'idea'; uid: string } | null;

/** What's for dinner, Monday to Sunday, straight from the dinners list in Apple Reminders. */
export function DinnersScreen({ weekStart }: { weekStart: string }) {
  const data = useAppData();
  const c = useCloud();
  const r = useReminders();
  const list = r.account?.dinnersList ?? DEFAULT_DINNERS_LIST;
  const week = dinnersForWeek(data, weekStart, list);
  const dates = weekDates(weekStart);
  const today = todayISO();
  const [sheet, setSheet] = useState<SheetState>(null);
  const [draft, setDraft] = useState('');
  const close = () => setSheet(null);

  const editing: ReminderRow | undefined = sheet?.kind === 'edit' || sheet?.kind === 'idea' ? data.reminders[sheet.uid] : undefined;

  const add = (date: string | null, title: string) => {
    if (!title.trim()) return;
    store.setReminder(createReminder({ list, title, due: date }));
  };

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Dinners</h2>
          <span className="hint">{r.account ? `Reminders · ${list}` : 'not connected'}</span>
        </div>
        {!r.account && (
          <p className="note">
            {c.configured && c.user
              ? `Connect Apple Reminders in Settings and this tab shows the "${list}" list, one dinner per night. You can still plan here now; dinners you add sync once connected.`
              : c.configured
                ? 'Sign in and connect Apple Reminders in Settings to pull in your dinners list.'
                : 'Dinners are planned here. Cloud sync and Apple Reminders are not configured in this build.'}
          </p>
        )}
        <div>
          {DAY_KEYS.map((day, i) => {
            const meals = week.days[day];
            const isToday = dates[i] === today;
            const d = parseISODate(dates[i]);
            return (
              <div key={day} className={`dinner-row${isToday ? ' today' : ''}`}>
                <div className="day">
                  {DAY_SHORT[day]}
                  <small>{d.getDate()}</small>
                </div>
                <div className="meal">
                  {meals.length === 0 ? (
                    <button type="button" className="empty-meal" onClick={() => setSheet({ kind: 'add', date: dates[i] })} aria-label={`Plan dinner for ${DAY_LABELS[day]}`}>
                      + Plan dinner
                    </button>
                  ) : (
                    <div className="stack" style={{ gap: 2 }}>
                      {meals.map((m) => (
                        <button key={m.uid} type="button" className={m.completed ? 'done' : undefined} style={{ textAlign: 'left' }} onClick={() => setSheet({ kind: 'edit', uid: m.uid })}>
                          {m.title}
                          {m.pending && c.configured && <span className="tag pending" style={{ marginLeft: 6 }}>syncing</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  {meals.length > 0 && (
                    <button type="button" className="more" aria-label={`Options for ${DAY_LABELS[day]} dinner`} onClick={() => setSheet({ kind: 'edit', uid: meals[0].uid })} style={{ width: 36, height: 36, color: 'var(--muted)', fontSize: 20 }}>
                      ···
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card ideas">
        <div className="card-head">
          <h2 className="card-title">Ideas</h2>
          <span className="hint">undated in the list · tap to plan</span>
        </div>
        {week.ideas.length === 0 && <div className="empty">Add meal ideas here; give one a day when you plan the week.</div>}
        <div className="daychips" style={{ marginBottom: 8 }}>
          {week.ideas.map((m) => (
            <button key={m.uid} type="button" className="chip" onClick={() => setSheet({ kind: 'idea', uid: m.uid })}>
              {m.title}
            </button>
          ))}
        </div>
        <form
          className="addrow"
          onSubmit={(e) => {
            e.preventDefault();
            add(null, draft);
            setDraft('');
          }}
        >
          <span className="plus" aria-hidden="true">
            +
          </span>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a meal idea" aria-label="Add a meal idea" autoComplete="off" enterKeyHint="done" />
          {draft.trim() && (
            <button type="submit" className="go">
              Add
            </button>
          )}
        </form>
      </section>

      {/* Plan a dinner for a specific night */}
      <Sheet open={sheet?.kind === 'add'} title={sheet?.kind === 'add' ? `Dinner · ${DAY_LABELS[dayKeyOf(sheet.date)]}` : ''} onClose={close}>
        {sheet?.kind === 'add' && <AddDinner ideas={week.ideas} onPick={(idea) => (store.updateReminder(idea.uid, (x) => setReminderDue(x, sheet.date)), close())} onNew={(t) => (add(sheet.date, t), close())} />}
      </Sheet>

      {/* Edit a planned dinner or an idea */}
      <ItemSheet
        open={!!editing}
        title={editing ? (editing.due ? `Dinner · ${DAY_LABELS[dayKeyOf(editing.due)]}` : 'Meal idea') : ''}
        text={editing?.title ?? ''}
        onClose={close}
        onSave={(text) => editing && store.updateReminder(editing.uid, (x) => renameReminder(x, text))}
        onDelete={() => editing && store.updateReminder(editing.uid, deleteReminder)}
      >
        {editing && (
          <div className="section">
            <div className="card-title">{editing.due ? 'Move to' : 'Plan for'}</div>
            <DayPick
              exclude={editing.due ? dayKeyOf(editing.due) : undefined}
              onPick={(to) => {
                store.updateReminder(editing.uid, (x) => setReminderDue(x, dates[DAY_KEYS.indexOf(to)]));
                close();
              }}
            />
            <div className="btnrow">
              {editing.due && (
                <button type="button" className="btn ghost" onClick={() => (store.updateReminder(editing.uid, (x) => setReminderDue(x, null)), close())}>
                  Back to ideas
                </button>
              )}
              <button type="button" className="btn ghost" onClick={() => (store.updateReminder(editing.uid, toggleReminder), close())}>
                {editing.completed ? 'Mark not cooked' : 'Mark cooked'}
              </button>
            </div>
          </div>
        )}
      </ItemSheet>
    </>
  );
}

function AddDinner({ ideas, onPick, onNew }: { ideas: ReminderRow[]; onPick: (idea: ReminderRow) => void; onNew: (title: string) => void }) {
  const [text, setText] = useState('');
  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) onNew(text.trim());
        }}
      >
        <div className="field">
          <label htmlFor="dinner-text">What's for dinner?</label>
          <input id="dinner-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Tacos" autoComplete="off" autoFocus />
        </div>
        <button type="submit" className="btn primary" disabled={!text.trim()}>
          Plan it
        </button>
      </form>
      {ideas.length > 0 && (
        <div className="section">
          <div className="card-title">Or pick an idea</div>
          <div className="daychips">
            {ideas.map((m) => (
              <button key={m.uid} type="button" className="chip" onClick={() => onPick(m)}>
                {m.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
