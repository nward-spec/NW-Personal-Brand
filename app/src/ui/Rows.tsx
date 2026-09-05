import { useState, type ReactNode } from 'react';
import { useLongPress } from './useLongPress';

const Tick = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 8.5l3.2 3L13 4.5" />
  </svg>
);

interface RowProps {
  done: boolean;
  text: string;
  sub?: ReactNode;
  onToggle: () => void;
  /** Opens the row's options; also fired by a long press. */
  onMore?: () => void;
}

/** A checkable line. Tap toggles, long-press or the dots open options. */
export function CheckRow({ done, text, sub, onToggle, onMore }: RowProps) {
  const lp = useLongPress(() => onMore?.());
  const handlers = onMore ? lp.handlers : {};
  return (
    <li className={`row${done ? ' done' : ''}`} {...handlers}>
      <button
        type="button"
        className="main"
        style={{ display: 'flex', alignItems: 'center', gap: 10, flexDirection: 'row' }}
        onClick={() => {
          if (!lp.consumed()) onToggle();
        }}
        aria-pressed={done}
      >
        <span className="check" aria-hidden="true">
          <Tick />
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
          <span className="text">{text}</span>
          {sub && <span className="sub">{sub}</span>}
        </span>
      </button>
      {onMore && (
        <button type="button" className="more" aria-label={`Options for ${text}`} onClick={onMore}>
          ···
        </button>
      )}
    </li>
  );
}

/** Inline "add a line" input. */
export function AddRow({ placeholder, onAdd }: { placeholder: string; onAdd: (text: string) => void }) {
  const [text, setText] = useState('');
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onAdd(t);
    setText('');
  };
  return (
    <form
      className="addrow"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <span className="plus" aria-hidden="true">
        +
      </span>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={placeholder} enterKeyHint="done" autoComplete="off" />
      {text.trim() && (
        <button type="submit" className="go">
          Add
        </button>
      )}
    </form>
  );
}
