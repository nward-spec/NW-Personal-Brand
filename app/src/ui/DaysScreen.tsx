import { useEffect, useRef, useState } from 'react';
import { addDayItem, deleteDayItem, editDayItem, moveDayItem, sendDayItemToTodos, setOutfit, toggleDayItem } from '../core/model';
import { DAY_KEYS, DAY_LABELS, type DayKey, dayKeyOf, formatDayHeading, todayISO, weekDates } from '../core/week';
import { updateWeek, useWeek } from '../web/app-store';
import { DayPick } from './Chips';
import { ItemSheet } from './EditorSheets';
import { AddRow, CheckRow } from './Rows';

export function DaysScreen({ weekStart }: { weekStart: string }) {
  const week = useWeek(weekStart);
  const [sheet, setSheet] = useState<{ day: DayKey; id: string } | null>(null);
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

  return (
    <>
      {DAY_KEYS.map((day, i) => {
        const d = week.days[day];
        const isToday = day === todayKey;
        const done = d.items.filter((x) => x.done).length;
        return (
          <section key={day} className={`card${isToday ? ' today' : ''}`} ref={isToday ? todayRef : undefined} style={{ scrollMarginTop: 96 }} aria-label={DAY_LABELS[day]}>
            <div className="card-head">
              <h2 className="card-title day-title">
                {formatDayHeading(dates[i])}
                {isToday && <span className="today-tag">Today</span>}
              </h2>
              {d.items.length > 0 && (
                <span className="hint">
                  {done}/{d.items.length}
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
    </>
  );
}
