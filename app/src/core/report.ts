// Turns the progress lines a Journal Sync run posted back into one readable line.

/** "reply deletes=1 creates=1 undated=0", "removed …", "added …", "done" → one readable line. */
export function summariseReport(report: string): string {
  const lines = report.split('\n').filter(Boolean);
  const removed = lines.filter((l) => l.startsWith('removed ')).length;
  const added = lines.filter((l) => l.startsWith('added ')).length;
  const reply = /deletes=(\d+) creates=(\d+) undated=(\d+)/.exec(report);
  const expected = reply ? Number(reply[1]) + Number(reply[2]) + Number(reply[3]) : null;
  const done = lines.at(-1) === 'done';
  if (expected === 0 && done) return 'nothing to change';
  const parts = [removed ? `removed ${removed}` : '', added ? `added ${added}` : ''].filter(Boolean);
  const applied = parts.length ? parts.join(', ') : 'nothing applied';
  if (!done) return `${applied}; the Shortcut stopped before finishing`;
  if (expected !== null && removed + added < expected) return `${applied} of ${expected} expected`;
  return applied;
}
