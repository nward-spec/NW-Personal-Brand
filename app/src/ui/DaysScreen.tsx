import { useEffect, useRef, useState } from 'react';
import { addDayItem, deleteDayItem, editDayItem, moveDayItem, sendDayItemToTodos, setOutfit, toggleDayItem } from '../core/model';
import { DAY_KEYS, DAY_LABELS, type DayKey, dayKeyOf, formatDayHeading, todayISO, weekDates } from '../core/week';
import { store, updateWeek, useAppData, useWeek } from '../web/app-store';
import { DEFAULT_DINNERS_LIST, deleteReminder, remindersForDay, renameReminder, setReminderDue, toggleReminder } from '../core/reminders';
import { useReminders } from '../web/reminders';
import { DayPick } from './Chips';
import { ItemSheet } from './EditorSheets';
import { AddRow, CheckRow } from './Rows';

export function DaysScreen({ weekStart }: { weekStart: string }) {
  const week = useWeek(weekStart);
  const data = useAppData();
  const { account } = useReminders();
  const [sheet, setSheet] = useState<{ day: DayKey; id: string } | null>(null);
  const [rsheet, setRsheet] = useState<string | null>(null);
  const edit = (fn: Parameters<typeof updateWeek>[1]) => updateWeek(weekStart, fn);
  const dates = weekDates(weekStart);
  const today = todayISO();
  const todayKey = dates.includes(today) ? dayKeyOf(today) : null;
  const todayRef = useRef<HTMLElement>(null);

  // Bring today into view when opening the current week.
  useEffect(() => {
    if (todayKey && todayKey !== 'mon') todayRef.current?.scrollIntoView({ block: 'start' });
  }, [weekStart, todayKey]);

  const item = sheet ? week.days[sheet.day].items.find((i) => i.id === sheet.id) : undefined;
  const rem = rsheet ? data.reminders[rsheet] : undefined;

  return (
    <>
      {DAY_KEYS.map((day, i) => {
        const d = week.days[day];
        const isToday = day === todayKey;
        const rems = remindersForDay(data, dates[i], { excludeList: account?.dinnersList ?? DEFAULT_DINNERS_LIST });
        const done = d.items.filter((x) => x.done).length + rems.filter((r) => r.completed).length;
        const total = d.items.length + rems.length;
        return (
          <section key={day} className={`card${isToday ? ' today' : ''}`} ref={isToday ? todayRef : undefined} style={{ scrollMarginTop: 96 }} aria-label={DAY_LABELS[day]}>
            <div className="card-head">
              <h2 className="card-title day-title">
                {formatDayHeading(dates[i])}
                {isToday && <span className="today-tag">Today</span>}
              </h2>
              {total > 0 && (
                <span className="hint">
                  {done}/{total}
                </span>
              )}
            </div>
            <div className="outfit">
              <span className="label">Wear</span>
              <input value={d.outfit} placeholder="e.g. green dress, sneakers" onChange={(e) => edit((w) => setOutfit(w, day, e.target.value))} aria-label={`Outfit for ${DAY_LABELS[day]}`} autoComplete="off" />
            </div>
            <ul className="rows">
              {d.items.map((it) => (
                <CheckRow
                  key={it.id}
                  done={it.done}
                  text={it.text}
                  sub={it.goalId ? <span className="linked">weekly goal</span> : undefined}
                  onToggle={() => edit((w) => toggleDayItem(w, day, it.id))}
                  onMore={() => setSheet({ day, id: it.id })}
                />
              ))}
              {rems.map((r) => (
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
            <AddRow placeholder={`Add to ${DAY_LABELS[day]}`} onAdd={(text) => edit((w) => addDayItem(w, day, text))} />
          </section>
        );
      })}

      <ItemSheet
        open={!!sheet && !!item}
        title={sheet ? DAY_LABELS[sheet.day] : ''}
        text={item?.text ?? ''}
        onClose={() => setSheet(null)}
        onSave={(text) => sheet && edit((w) => editDayItem(w, sheet.day, sheet.id, text))}
        onDelete={() => sheet && edit((w) => deleteDayItem(w, sheet.day, sheet.id))}
      >
        {sheet && (
          <div className="section">
            <div className="card-title">Move to</div>
            <DayPick
              exclude={sheet.day}
              onPick={(to) => {
                edit((w) => moveDayItem(w, sheet.day, sheet.id, to));
                setSheet(null);
              }}
            />
            <div className="btnrow">
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  edit((w) => sendDayItemToTodos(w, sheet.day, sheet.id));
                  setSheet(null);
                }}
              >
                Back to the to-do list
              </button>
            </div>
          </div>
        )}
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
            <div className="card-title">Move to</div>
            <DayPick
              exclude={rem.due ? dayKeyOf(rem.due) : undefined}
              onPick={(to) => {
                store.updateReminder(rem.uid, (r) => setReminderDue(r, dates[DAY_KEYS.indexOf(to)]));
                setRsheet(null);
              }}
            />
            <p className="note">Changes the due date in Apple Reminders. Deleting removes it there too.</p>
          </div>
        )}
      </ItemSheet>
    </>
  );
}
