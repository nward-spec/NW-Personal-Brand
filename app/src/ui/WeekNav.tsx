import { addDays, formatWeekRange, isoWeekNumber, todayISO, weekStartOf } from '../core/week';

interface Props {
  weekStart: string;
  onChange: (weekStart: string) => void;
}

export function WeekNav({ weekStart, onChange }: Props) {
  const thisWeek = weekStartOf(todayISO());
  const isThisWeek = weekStart === thisWeek;
  return (
    <div className="weeknav">
      <button type="button" className="iconbtn" aria-label="Previous week" onClick={() => onChange(addDays(weekStart, -7))}>
        ‹
      </button>
      <div className="title">
        <b>{formatWeekRange(weekStart)}</b>
        <small>
          Week {isoWeekNumber(weekStart)}
          {isThisWeek ? ' · this week' : ''}
        </small>
      </div>
      {!isThisWeek && (
        <button type="button" className="pill accent" onClick={() => onChange(thisWeek)}>
          Today
        </button>
      )}
      <button type="button" className="iconbtn" aria-label="Next week" onClick={() => onChange(addDays(weekStart, 7))}>
        ›
      </button>
    </div>
  );
}
