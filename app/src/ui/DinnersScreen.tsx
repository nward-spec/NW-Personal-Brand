import { useState } from 'react';
import { DEFAULT_DINNERS_LIST, createReminder, dinnersForWeek } from '../core/reminders';
import { DAY_KEYS, DAY_LABELS, DAY_SHORT, parseISODate, todayISO, weekDates } from '../core/week';
import { store, useAppData } from '../web/app-store';
import { useCloud } from '../web/cloud';
import { useReminders } from '../web/reminders';
import { DinnerSheets, type DinnerSheet } from './DinnerSheets';

/** What's for dinner, Monday to Sunday, straight from the dinners list in Apple Reminders. */
export function DinnersScreen({ weekStart }: { weekStart: string }) {
  const data = useAppData();
  const c = useCloud();
  const r = useReminders();
  const list = r.account?.dinnersList ?? DEFAULT_DINNERS_LIST;
  const week = dinnersForWeek(data, weekStart, list);
  const dates = weekDates(weekStart);
  const today = todayISO();
  const [sheet, setSheet] = useState<DinnerSheet>(null);
  const [draft, setDraft] = useState('');

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
                          {m.pending && c.configured && (
                            <span className="tag pending" style={{ marginLeft: 6 }}>
                              syncing
                            </span>
                          )}
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
            <button key={m.uid} type="button" className="chip" onClick={() => setSheet({ kind: 'edit', uid: m.uid })}>
              {m.title}
            </button>
          ))}
        </div>
        <form
          className="addrow"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) store.setReminder(createReminder({ list, title: draft, due: null }));
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

      <DinnerSheets sheet={sheet} onClose={() => setSheet(null)} list={list} week={week} dates={dates} />
    </>
  );
}
