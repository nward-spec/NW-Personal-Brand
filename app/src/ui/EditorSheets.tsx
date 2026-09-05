import { useEffect, useState, type ReactNode } from 'react';
import type { DayKey } from '../core/week';
import { DayChips } from './Chips';
import { Sheet } from './Sheet';

/** Edit/delete a single line of text, with optional extra actions below. */
export function ItemSheet({
  open,
  title,
  text,
  onClose,
  onSave,
  onDelete,
  children,
}: {
  open: boolean;
  title: string;
  text: string;
  onClose: () => void;
  onSave: (text: string) => void;
  onDelete: () => void;
  children?: ReactNode;
}) {
  const [value, setValue] = useState(text);
  useEffect(() => setValue(text), [text, open]);
  const save = () => {
    if (value.trim() && value.trim() !== text) onSave(value.trim());
    onClose();
  };
  return (
    <Sheet open={open} title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="field">
          <label htmlFor="item-text">Text</label>
          <input id="item-text" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" enterKeyHint="done" />
        </div>
        <div className="btnrow">
          <button type="submit" className="btn primary">
            Save
          </button>
          <button
            type="button"
            className="btn danger"
            onClick={() => {
              onDelete();
              onClose();
            }}
          >
            Delete
          </button>
        </div>
      </form>
      {children}
    </Sheet>
  );
}

/** Add or edit a weekly goal: name plus the days it is planned for. */
export function GoalSheet({
  open,
  initial,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean;
  initial?: { text: string; days: DayKey[] };
  onClose: () => void;
  onSave: (text: string, days: DayKey[]) => void;
  onDelete?: () => void;
}) {
  const [text, setText] = useState(initial?.text ?? '');
  const [days, setDays] = useState<DayKey[]>(initial?.days ?? []);
  useEffect(() => {
    setText(initial?.text ?? '');
    setDays(initial?.days ?? []);
  }, [initial, open]);

  return (
    <Sheet open={open} title={initial ? 'Edit goal' : 'New weekly goal'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          onSave(text.trim(), days);
          onClose();
        }}
      >
        <div className="field">
          <label htmlFor="goal-text">Goal</label>
          <input id="goal-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Walk x2" autoComplete="off" autoFocus={!initial} />
        </div>
        <div className="field">
          <label>Planned days (adds it to those days)</label>
          <DayChips value={days} onChange={setDays} />
        </div>
        <div className="btnrow">
          <button type="submit" className="btn primary" disabled={!text.trim()}>
            Save
          </button>
          {onDelete && (
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                onDelete();
                onClose();
              }}
            >
              Delete
            </button>
          )}
        </div>
      </form>
    </Sheet>
  );
}

/** Add or edit a habit: name plus a free-text target such as "x4". */
export function HabitSheet({
  open,
  initial,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean;
  initial?: { text: string; target: string };
  onClose: () => void;
  onSave: (text: string, target: string) => void;
  onDelete?: () => void;
}) {
  const [text, setText] = useState(initial?.text ?? '');
  const [target, setTarget] = useState(initial?.target ?? '');
  useEffect(() => {
    setText(initial?.text ?? '');
    setTarget(initial?.target ?? '');
  }, [initial, open]);

  return (
    <Sheet open={open} title={initial ? 'Edit habit' : 'New habit'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          onSave(text.trim(), target.trim());
          onClose();
        }}
      >
        <div className="field">
          <label htmlFor="habit-text">Habit</label>
          <input id="habit-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Read 15 min" autoComplete="off" autoFocus={!initial} />
        </div>
        <div className="field">
          <label htmlFor="habit-target">Target (optional)</label>
          <input id="habit-target" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="e.g. x4, Sun–Thu, 2×10" autoComplete="off" />
        </div>
        <div className="btnrow">
          <button type="submit" className="btn primary" disabled={!text.trim()}>
            Save
          </button>
          {onDelete && (
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                onDelete();
                onClose();
              }}
            >
              Delete
            </button>
          )}
        </div>
      </form>
    </Sheet>
  );
}
