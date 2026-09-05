import { habitCount } from '../core/model';
import type { Habit } from '../core/types';
import { DAY_KEYS, DAY_SHORT, dayIndex, dayKeyOf, todayISO, weekDates } from '../core/week';

interface Props {
  habits: Habit[];
  weekStart: string;
  onToggle: (habitId: string, dayIdx: number) => void;
  onEdit: (habit: Habit) => void;
}

/** Habit name rows against a Mon–Sun grid of tappable dots. */
export function HabitGrid({ habits, weekStart, onToggle, onEdit }: Props) {
  const today = todayISO();
  const todayIdx = weekDates(weekStart).includes(today) ? dayIndex(dayKeyOf(today)) : -1;

  if (habits.length === 0) return <div className="empty">No habits yet. Add one below, e.g. “Read 15 min”.</div>;

  return (
    <table className="habits">
      <thead>
        <tr>
          <th className="name" scope="col">
            <span className="sr-only">Habit</span>
          </th>
          {DAY_KEYS.map((d, i) => (
            <th key={d} scope="col" className={i === todayIdx ? 'today' : undefined} aria-label={DAY_SHORT[d]}>
              {DAY_SHORT[d][0]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {habits.map((h) => {
          const n = habitCount(h);
          return (
            <tr key={h.id}>
              <td className="name">
                <button type="button" onClick={() => onEdit(h)} aria-label={`Edit habit ${h.text}`}>
                  {h.text}
                  <span className="target">
                    {h.target && <>{h.target} · </>}
                    <span className="count">{n}/7</span>
                  </span>
                </button>
              </td>
              {DAY_KEYS.map((d, i) => (
                <td key={d} className={i === todayIdx ? 'today' : undefined}>
                  <button
                    type="button"
                    className={`dot${h.checks[i] ? ' on' : ''}`}
                    aria-pressed={!!h.checks[i]}
                    aria-label={`${h.text} on ${DAY_SHORT[d]}`}
                    onClick={() => onToggle(h.id, i)}
                  />
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
