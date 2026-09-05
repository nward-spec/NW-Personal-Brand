import { useState } from 'react';
import { createReminder, deleteReminder, renameReminder, setReminderDue, toggleReminder, type DinnerWeek } from '../core/reminders';
import type { ReminderRow } from '../core/types';
import { DAY_KEYS, DAY_LABELS, dayKeyOf } from '../core/week';
import { store, useAppData } from '../web/app-store';
import { DayPick } from './Chips';
import { ItemSheet } from './EditorSheets';
import { Sheet } from './Sheet';

/** Which dinner sheet is open: plan a night, or edit a planned dinner / idea. */
export type DinnerSheet = { kind: 'add'; date: string } | { kind: 'edit'; uid: string } | null;

interface Props {
  sheet: DinnerSheet;
  onClose: () => void;
  /** Reminders list that holds dinners. */
  list: string;
  week: DinnerWeek;
  /** The seven dates of the week being shown, Monday first. */
  dates: string[];
}

/** The bottom sheets for planning and editing dinners, shared by the Days and Dinners tabs. */
export function DinnerSheets({ sheet, onClose, list, week, dates }: Props) {
  const data = useAppData();
  const editing = sheet?.kind === 'edit' ? data.reminders[sheet.uid] : undefined;

  return (
    <>
      <Sheet open={sheet?.kind === 'add'} title={sheet?.kind === 'add' ? `Dinner · ${DAY_LABELS[dayKeyOf(sheet.date)]}` : ''} onClose={onClose}>
        {sheet?.kind === 'add' && (
          <AddDinner
            ideas={week.ideas}
            onPick={(idea) => {
              store.updateReminder(idea.uid, (x) => setReminderDue(x, sheet.date));
              onClose();
            }}
            onNew={(title) => {
              store.setReminder(createReminder({ list, title, due: sheet.date }));
              onClose();
            }}
          />
        )}
      </Sheet>

      <ItemSheet
        open={!!editing}
        title={editing ? (editing.due ? `Dinner · ${DAY_LABELS[dayKeyOf(editing.due)]}` : 'Meal idea') : ''}
        text={editing?.title ?? ''}
        onClose={onClose}
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
                onClose();
              }}
            />
            <div className="btnrow">
              {editing.due && (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    store.updateReminder(editing.uid, (x) => setReminderDue(x, null));
                    onClose();
                  }}
                >
                  Back to ideas
                </button>
              )}
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  store.updateReminder(editing.uid, toggleReminder);
                  onClose();
                }}
              >
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

/** One "Dinner" line for a day card: the planned meal, or a prompt to plan one. */
export function DinnerLine({ meals, dayLabel, onPlan, onEdit, showPending }: { meals: ReminderRow[]; dayLabel: string; onPlan: () => void; onEdit: (uid: string) => void; showPending: boolean }) {
  return (
    <div className="outfit dinner">
      <span className="label">Dinner</span>
      {meals.length === 0 ? (
        <button type="button" className="meal-btn empty" onClick={onPlan} aria-label={`Plan dinner for ${dayLabel}`}>
          + Plan dinner
        </button>
      ) : (
        <div className="meals">
          {meals.map((m) => (
            <button key={m.uid} type="button" className={`meal-btn${m.completed ? ' done' : ''}`} onClick={() => onEdit(m.uid)} aria-label={`Dinner for ${dayLabel}: ${m.title}`}>
              {m.title}
              {m.pending && showPending && (
                <span className="tag pending" style={{ marginLeft: 6 }}>
                  syncing
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
