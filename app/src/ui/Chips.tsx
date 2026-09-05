import { DAY_KEYS, DAY_SHORT, type DayKey } from '../core/week';

/** Multi-select day picker (for goal planning). */
export function DayChips({ value, onChange }: { value: DayKey[]; onChange: (days: DayKey[]) => void }) {
  const toggle = (d: DayKey) => onChange(value.includes(d) ? value.filter((x) => x !== d) : DAY_KEYS.filter((k) => k === d || value.includes(k)));
  return (
    <div className="daychips" role="group" aria-label="Planned days">
      {DAY_KEYS.map((d) => (
        <button key={d} type="button" className={`chip${value.includes(d) ? ' on' : ''}`} aria-pressed={value.includes(d)} onClick={() => toggle(d)}>
          {DAY_SHORT[d]}
        </button>
      ))}
    </div>
  );
}

/** Single-pick day buttons (for moving an entry). */
export function DayPick({ exclude, onPick }: { exclude?: DayKey; onPick: (day: DayKey) => void }) {
  return (
    <div className="daychips" role="group" aria-label="Choose a day">
      {DAY_KEYS.map((d) => (
        <button key={d} type="button" className="chip lg" disabled={d === exclude} onClick={() => onPick(d)}>
          {DAY_SHORT[d]}
        </button>
      ))}
    </div>
  );
}

export function daysLabel(days: DayKey[]): string {
  return DAY_KEYS.filter((d) => days.includes(d))
    .map((d) => DAY_SHORT[d])
    .join(' · ');
}
