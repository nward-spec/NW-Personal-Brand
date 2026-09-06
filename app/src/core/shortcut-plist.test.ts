import { describe, expect, it } from 'vitest';
import { SHORTCUT_VERSION, buildJournalSyncActions, buildJournalSyncPlist } from './shortcut-plist';

const opts = { endpoint: 'https://example.test/functions/v1/reminders-shortcut', token: 'tok_0123456789abcdef' };

describe('buildJournalSyncActions', () => {
  const actions = buildJournalSyncActions(opts);
  const ifs = actions.filter((a) => a.WFWorkflowActionIdentifier === 'is.workflow.actions.conditional' && a.WFWorkflowActionParameters.WFControlFlowMode === 0);

  it('wraps every If input the way Shortcuts expects, or the branch never runs', () => {
    expect(ifs.map((a) => a.WFWorkflowActionParameters.WFConditionalActionString)).toEqual(['delete', 'create', 'create-undated']);
    for (const a of ifs) {
      const input = a.WFWorkflowActionParameters.WFInput as { Type: string; Variable: { WFSerializationType: string; Value: { Type: string } } };
      expect(input.Type).toBe('Variable');
      expect(input.Variable.WFSerializationType).toBe('WFTextTokenAttachment');
      expect(input.Variable.Value.Type).toBe('ActionOutput');
      expect(a.WFWorkflowActionParameters.WFCondition).toBe(4);
    }
  });

  it('closes every If and Repeat it opens', () => {
    const open = new Map<string, number>();
    for (const a of actions) {
      const p = a.WFWorkflowActionParameters as { GroupingIdentifier?: string; WFControlFlowMode?: number };
      if (!p.GroupingIdentifier) continue;
      open.set(p.GroupingIdentifier, (open.get(p.GroupingIdentifier) ?? 0) + (p.WFControlFlowMode === 0 ? 1 : p.WFControlFlowMode === 2 ? -1 : 0));
    }
    expect([...open.values()].every((n) => n === 0)).toBe(true);
  });

  it('sends the token, asks for JSON and reports its version', () => {
    const post = actions.find((a) => a.WFWorkflowActionIdentifier === 'is.workflow.actions.downloadurl')!;
    const headers = (post.WFWorkflowActionParameters.WFHTTPHeaders as { Value: { WFDictionaryFieldValueItems: { WFKey: { Value: { string: string } }; WFValue: { Value: { string: string } } }[] } }).Value.WFDictionaryFieldValueItems;
    const map = Object.fromEntries(headers.map((h) => [h.WFKey.Value.string, h.WFValue.Value.string]));
    expect(map).toEqual({ Authorization: `Bearer ${opts.token}`, 'Content-Type': 'text/plain; charset=utf-8', 'X-Journal-Format': 'json', 'X-Journal-Shortcut': SHORTCUT_VERSION });
    expect(post.WFWorkflowActionParameters.WFURL).toBe(opts.endpoint);
  });
});

describe('buildJournalSyncPlist', () => {
  it('produces an XML plist with the actions', () => {
    const xml = buildJournalSyncPlist(opts);
    expect(xml.startsWith('<?xml version="1.0"')).toBe(true);
    expect(xml).toContain('<key>WFWorkflowActions</key>');
    expect(xml).toContain('is.workflow.actions.removereminders');
    expect(xml).toContain('is.workflow.actions.addnewreminder');
    expect(xml).not.toContain('WFWorkflowActionIdentifier</key>\n\t\t\t<string>is.workflow.actions.$');
  });
});
