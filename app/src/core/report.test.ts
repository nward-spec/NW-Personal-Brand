import { describe, expect, it } from 'vitest';
import { summariseReport } from './report';

describe('summariseReport', () => {
  it('reads a full run', () => {
    expect(summariseReport('reply deletes=1 creates=1 undated=0\nremoved 3 Tacos\nadded Curry | Dinners | 7 September 2026 at 9:00 am\ndone')).toBe('removed 1, added 1');
  });
  it('says when nothing was needed', () => {
    expect(summariseReport('reply deletes=0 creates=0 undated=0\ndone')).toBe('nothing to change');
  });
  it('flags a run that stopped early or fell short', () => {
    expect(summariseReport('reply deletes=1 creates=1 undated=0\nremoved 3 Tacos')).toBe('removed 1; the Shortcut stopped before finishing');
    expect(summariseReport('reply deletes=2 creates=0 undated=0\nremoved 3 Tacos\ndone')).toBe('removed 1 of 2 expected');
  });
});
