// Minimal iCalendar VTODO handling: parse what the app needs, and patch a
// reminder's text/date/completion while leaving every other property Apple
// wrote (alarms, priorities, X-APPLE-* fields) untouched.

export interface VTodo {
  uid: string;
  summary: string;
  description: string;
  /** YYYY-MM-DD or null. */
  due: string | null;
  completed: boolean;
  /** ISO timestamp, when known. */
  completedAt: string | null;
  lastModified: string | null;
}

interface Line {
  name: string;
  params: string;
  value: string;
}

/** Unfold continuation lines (CRLF followed by a space or tab). */
export function unfold(ics: string): string[] {
  return ics
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .filter((l) => l.length > 0);
}

/** Fold to 74 octets-ish (by characters; fine for the content we write). */
export function fold(lines: string[]): string {
  return (
    lines
      .map((l) => {
        if (l.length <= 74) return l;
        const parts: string[] = [];
        let rest = l;
        parts.push(rest.slice(0, 74));
        rest = rest.slice(74);
        while (rest.length) {
          parts.push(' ' + rest.slice(0, 73));
          rest = rest.slice(73);
        }
        return parts.join('\r\n');
      })
      .join('\r\n') + '\r\n'
  );
}

function splitLine(line: string): Line | null {
  // NAME;PARAM=VALUE;PARAM="quoted":value
  let i = 0;
  let inQuote = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ':' && !inQuote) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const semi = head.indexOf(';');
  const name = (semi === -1 ? head : head.slice(0, semi)).toUpperCase();
  const params = semi === -1 ? '' : head.slice(semi + 1);
  return { name, params, value: line.slice(i + 1) };
}

export function unescapeText(v: string): string {
  return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

export function escapeText(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Indices of the top-level VTODO property lines (skipping nested VALARM etc). */
function todoPropertyIndices(lines: string[]): { start: number; end: number; props: number[] } | null {
  const start = lines.findIndex((l) => l.toUpperCase() === 'BEGIN:VTODO');
  if (start === -1) return null;
  const props: number[] = [];
  let depth = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const u = lines[i].toUpperCase();
    if (u === 'END:VTODO' && depth === 0) return { start, end: i, props };
    if (u.startsWith('BEGIN:')) depth++;
    else if (u.startsWith('END:')) depth--;
    else if (depth === 0) props.push(i);
  }
  return null;
}

/** "20260317", "20260317T090000", "20260317T090000Z" → YYYY-MM-DD (date part as written). */
function dateOf(value: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(value.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function isoOf(value: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value.trim());
  if (!m) return dateOf(value);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? '.000Z' : ''}`;
}

export function parseVTodo(ics: string): VTodo | null {
  const lines = unfold(ics);
  const block = todoPropertyIndices(lines);
  if (!block) return null;
  const todo: VTodo = { uid: '', summary: '', description: '', due: null, completed: false, completedAt: null, lastModified: null };
  let status = '';
  let percent = -1;
  for (const i of block.props) {
    const l = splitLine(lines[i]);
    if (!l) continue;
    switch (l.name) {
      case 'UID':
        todo.uid = l.value.trim();
        break;
      case 'SUMMARY':
        todo.summary = unescapeText(l.value);
        break;
      case 'DESCRIPTION':
        todo.description = unescapeText(l.value);
        break;
      case 'DUE':
        todo.due = dateOf(l.value);
        break;
      case 'STATUS':
        status = l.value.trim().toUpperCase();
        break;
      case 'COMPLETED':
        todo.completedAt = isoOf(l.value);
        break;
      case 'PERCENT-COMPLETE':
        percent = Number(l.value);
        break;
      case 'LAST-MODIFIED':
        todo.lastModified = isoOf(l.value);
        break;
    }
  }
  todo.completed = status === 'COMPLETED' || percent === 100 || (!!todo.completedAt && status !== 'NEEDS-ACTION' && status !== 'IN-PROCESS');
  if (!todo.uid) return null;
  return todo;
}

const pad = (n: number) => String(n).padStart(2, '0');
export function utcStamp(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

export interface TodoPatch {
  summary?: string;
  description?: string;
  /** YYYY-MM-DD to set the due date (time of day is kept if there was one); null clears it. */
  due?: string | null;
  completed?: boolean;
}

/** Replace the date digits in a DUE/DTSTART value, keeping any time and params. */
function withDate(line: Line, ymd: string): string {
  const digits = ymd.replace(/-/g, '');
  const value = line.value.replace(/^\d{8}/, digits);
  const hasTime = /T\d{6}/.test(value);
  const params = line.params ? `;${line.params}` : hasTime ? '' : ';VALUE=DATE';
  return `${line.name}${params}:${value}`;
}

/** Apply a patch to an existing VTODO, preserving everything else. */
export function updateVTodo(ics: string, patch: TodoPatch, now: Date = new Date()): string {
  const lines = unfold(ics);
  const block = todoPropertyIndices(lines);
  if (!block) throw new Error('No VTODO in calendar object');
  const out: string[] = lines.slice(0, block.start + 1);
  const seen = new Set<string>();
  const stamp = utcStamp(now);

  const emit = (name: string, value: string | null) => {
    seen.add(name);
    if (value !== null) out.push(value);
  };

  for (let i = block.start + 1; i < block.end; i++) {
    if (!block.props.includes(i)) {
      out.push(lines[i]); // nested component line
      continue;
    }
    const l = splitLine(lines[i]);
    if (!l) {
      out.push(lines[i]);
      continue;
    }
    switch (l.name) {
      case 'SUMMARY':
        emit('SUMMARY', patch.summary !== undefined ? `SUMMARY:${escapeText(patch.summary)}` : lines[i]);
        break;
      case 'DESCRIPTION':
        emit('DESCRIPTION', patch.description !== undefined ? `DESCRIPTION:${escapeText(patch.description)}` : lines[i]);
        break;
      case 'DUE':
      case 'DTSTART':
        if (patch.due === undefined) emit(l.name, lines[i]);
        else if (patch.due === null) emit(l.name, null);
        else emit(l.name, withDate(l, patch.due));
        break;
      case 'STATUS':
        emit('STATUS', patch.completed === undefined ? lines[i] : `STATUS:${patch.completed ? 'COMPLETED' : 'NEEDS-ACTION'}`);
        break;
      case 'COMPLETED':
        if (patch.completed === undefined) emit('COMPLETED', lines[i]);
        else emit('COMPLETED', patch.completed ? `COMPLETED:${stamp}` : null);
        break;
      case 'PERCENT-COMPLETE':
        emit('PERCENT-COMPLETE', patch.completed === undefined ? lines[i] : `PERCENT-COMPLETE:${patch.completed ? 100 : 0}`);
        break;
      case 'LAST-MODIFIED':
      case 'DTSTAMP':
        emit(l.name, `${l.name}:${stamp}`);
        break;
      case 'SEQUENCE': {
        const n = Number(l.value) || 0;
        emit('SEQUENCE', `SEQUENCE:${n + 1}`);
        break;
      }
      default:
        out.push(lines[i]);
    }
  }
  // Properties that were not present but the patch needs.
  if (patch.summary !== undefined && !seen.has('SUMMARY')) out.push(`SUMMARY:${escapeText(patch.summary)}`);
  if (patch.description !== undefined && !seen.has('DESCRIPTION')) out.push(`DESCRIPTION:${escapeText(patch.description)}`);
  if (patch.due && !seen.has('DUE')) out.push(`DUE;VALUE=DATE:${patch.due.replace(/-/g, '')}`);
  if (patch.completed !== undefined) {
    if (!seen.has('STATUS')) out.push(`STATUS:${patch.completed ? 'COMPLETED' : 'NEEDS-ACTION'}`);
    if (patch.completed && !seen.has('COMPLETED')) out.push(`COMPLETED:${stamp}`);
    if (!seen.has('PERCENT-COMPLETE')) out.push(`PERCENT-COMPLETE:${patch.completed ? 100 : 0}`);
  }
  if (!seen.has('LAST-MODIFIED')) out.push(`LAST-MODIFIED:${stamp}`);
  if (!seen.has('DTSTAMP')) out.push(`DTSTAMP:${stamp}`);
  out.push(...lines.slice(block.end));
  return fold(out);
}

/** A brand-new reminder. */
export function buildVTodo(v: { uid: string; summary: string; due: string | null; description?: string }, now: Date = new Date()): string {
  const stamp = utcStamp(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Weekly Journal//EN',
    'BEGIN:VTODO',
    `UID:${v.uid}`,
    `DTSTAMP:${stamp}`,
    `CREATED:${stamp}`,
    `LAST-MODIFIED:${stamp}`,
    `SUMMARY:${escapeText(v.summary)}`,
    'STATUS:NEEDS-ACTION',
    'PERCENT-COMPLETE:0',
  ];
  if (v.description) lines.push(`DESCRIPTION:${escapeText(v.description)}`);
  if (v.due) lines.push(`DUE;VALUE=DATE:${v.due.replace(/-/g, '')}`);
  lines.push('END:VTODO', 'END:VCALENDAR');
  return fold(lines);
}
