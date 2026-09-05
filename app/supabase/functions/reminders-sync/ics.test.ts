import { describe, expect, it } from 'vitest';
import { buildVTodo, parseVTodo, unfold, updateVTodo } from './ics';

// Shaped like what iCloud returns for a Reminders item: folded lines, a TZID
// due date with a time, an alarm sub-component, Apple X- properties.
const APPLE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Apple Inc.//iOS 26.0//EN',
  'BEGIN:VTIMEZONE',
  'TZID:Australia/Sydney',
  'END:VTIMEZONE',
  'BEGIN:VTODO',
  'CREATED:20260310T010203Z',
  'DTSTAMP:20260315T220000Z',
  'DTSTART;TZID=Australia/Sydney:20260318T090000',
  'DUE;TZID=Australia/Sydney:20260318T090000',
  'LAST-MODIFIED:20260315T220000Z',
  'SEQUENCE:2',
  'STATUS:NEEDS-ACTION',
  'SUMMARY:Michael appt\\, then hypnobirthing class at the hospital on the other s',
  ' ide of town',
  'UID:9E2C1A54-6B9D-4E12-8B0F-1F2E3D4C5B6A',
  'X-APPLE-SORT-ORDER:12',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:Reminder',
  'TRIGGER;VALUE=DATE-TIME:20260318T080000Z',
  'END:VALARM',
  'END:VTODO',
  'END:VCALENDAR',
].join('\r\n');

describe('parseVTodo', () => {
  it('reads an Apple-style reminder', () => {
    const t = parseVTodo(APPLE)!;
    expect(t.uid).toBe('9E2C1A54-6B9D-4E12-8B0F-1F2E3D4C5B6A');
    expect(t.summary).toBe('Michael appt, then hypnobirthing class at the hospital on the other side of town');
    expect(t.due).toBe('2026-03-18');
    expect(t.completed).toBe(false);
    expect(t.description).toBe(''); // the VALARM description must not leak in
  });

  it('reads completion in its several spellings', () => {
    const base = ['BEGIN:VCALENDAR', 'BEGIN:VTODO', 'UID:x', 'SUMMARY:Nails'];
    expect(parseVTodo([...base, 'STATUS:COMPLETED', 'END:VTODO', 'END:VCALENDAR'].join('\r\n'))!.completed).toBe(true);
    expect(parseVTodo([...base, 'PERCENT-COMPLETE:100', 'END:VTODO', 'END:VCALENDAR'].join('\r\n'))!.completed).toBe(true);
    const c = parseVTodo([...base, 'COMPLETED:20260319T030000Z', 'END:VTODO', 'END:VCALENDAR'].join('\r\n'))!;
    expect(c.completed).toBe(true);
    expect(c.completedAt).toBe('2026-03-19T03:00:00.000Z');
    expect(parseVTodo([...base, 'DUE;VALUE=DATE:20260320', 'END:VTODO', 'END:VCALENDAR'].join('\r\n'))!.due).toBe('2026-03-20');
    expect(parseVTodo([...base, 'END:VTODO', 'END:VCALENDAR'].join('\r\n'))!.due).toBeNull();
  });
});

describe('updateVTodo', () => {
  const now = new Date('2026-03-19T05:00:00Z');

  it('completes a reminder and keeps everything else', () => {
    const out = updateVTodo(APPLE, { completed: true }, now);
    const lines = unfold(out);
    expect(lines).toContain('STATUS:COMPLETED');
    expect(lines).toContain('COMPLETED:20260319T050000Z');
    expect(lines).toContain('PERCENT-COMPLETE:100');
    expect(lines).toContain('SEQUENCE:3');
    expect(lines).toContain('LAST-MODIFIED:20260319T050000Z');
    expect(lines).toContain('X-APPLE-SORT-ORDER:12');
    expect(lines).toContain('TRIGGER;VALUE=DATE-TIME:20260318T080000Z');
    expect(parseVTodo(out)!.completed).toBe(true);
    expect(parseVTodo(out)!.summary).toContain('Michael appt');
  });

  it('un-completes by dropping COMPLETED', () => {
    const done = updateVTodo(APPLE, { completed: true }, now);
    const undone = updateVTodo(done, { completed: false }, now);
    const lines = unfold(undone);
    expect(lines).toContain('STATUS:NEEDS-ACTION');
    expect(lines.some((l) => l.startsWith('COMPLETED:'))).toBe(false);
    expect(parseVTodo(undone)!.completed).toBe(false);
  });

  it('moves the due date but keeps the time of day and time zone', () => {
    const out = updateVTodo(APPLE, { due: '2026-03-17' }, now);
    const lines = unfold(out);
    expect(lines).toContain('DUE;TZID=Australia/Sydney:20260317T090000');
    expect(lines).toContain('DTSTART;TZID=Australia/Sydney:20260317T090000');
    expect(parseVTodo(out)!.due).toBe('2026-03-17');
  });

  it('clears and adds a due date', () => {
    const cleared = updateVTodo(APPLE, { due: null }, now);
    expect(parseVTodo(cleared)!.due).toBeNull();
    expect(unfold(cleared).some((l) => l.startsWith('DTSTART'))).toBe(false);
    const dated = updateVTodo(cleared, { due: '2026-03-22' }, now);
    expect(unfold(dated)).toContain('DUE;VALUE=DATE:20260322');
  });

  it('renames with escaping', () => {
    const out = updateVTodo(APPLE, { summary: 'Bake brownies; buy eggs, milk' }, now);
    expect(unfold(out)).toContain('SUMMARY:Bake brownies\\; buy eggs\\, milk');
    expect(parseVTodo(out)!.summary).toBe('Bake brownies; buy eggs, milk');
  });
});

describe('buildVTodo', () => {
  it('round-trips through the parser', () => {
    const ics = buildVTodo({ uid: 'ABC@weekly-journal', summary: 'Tacos', due: '2026-03-20', description: 'with the good salsa' }, new Date('2026-03-19T05:00:00Z'));
    const t = parseVTodo(ics)!;
    expect(t).toMatchObject({ uid: 'ABC@weekly-journal', summary: 'Tacos', due: '2026-03-20', completed: false, description: 'with the good salsa' });
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
});
