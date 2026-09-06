import { describe, expect, it } from 'vitest';
import { SHORTCUT_VERSION, buildJournalSyncActions, buildJournalSyncPlist } from './shortcut-plist';

const opts = { endpoint: 'https://example.test/functions/v1/reminders-shortcut', token: 'tok_0123456789abcdef' };
type Params = Record<string, unknown>;
const params = (a: { WFWorkflowActionParameters: unknown }) => a.WFWorkflowActionParameters as Params;

describe('buildJournalSyncActions', () => {
  const actions = buildJournalSyncActions(opts);
  const ids = actions.map((a) => a.WFWorkflowActionIdentifier);

  it('uses no If action: every branch is a loop over a list the server prepared', () => {
    expect(ids).not.toContain('is.workflow.actions.conditional');
    const loops = actions.filter((a) => a.WFWorkflowActionIdentifier === 'is.workflow.actions.repeat.each' && params(a).WFControlFlowMode === 0);
    expect(loops).toHaveLength(4);
    const keys = actions.filter((a) => a.WFWorkflowActionIdentifier === 'is.workflow.actions.getvalueforkey').map((a) => params(a).WFDictionaryKey);
    expect(keys).toEqual(['deletes', 'creates', 'undated', 'index', 'title', 'list', 'title', 'when', 'list', 'title']);
  });

  it('closes every Repeat it opens', () => {
    const open = new Map<string, number>();
    for (const a of actions) {
      const p = params(a) as { GroupingIdentifier?: string; WFControlFlowMode?: number };
      if (!p.GroupingIdentifier) continue;
      open.set(p.GroupingIdentifier, (open.get(p.GroupingIdentifier) ?? 0) + (p.WFControlFlowMode === 0 ? 1 : p.WFControlFlowMode === 2 ? -1 : 0));
    }
    expect([...open.values()].every((n) => n === 0)).toBe(true);
  });

  it('passes the list index as a variable attachment and lets Remove Reminders take the item', () => {
    const i = ids.indexOf('is.workflow.actions.getitemfromlist');
    const get = params(actions[i]) as { WFItemSpecifier: string; WFItemIndex: { WFSerializationType: string; Value: { OutputName: string } } };
    expect(get.WFItemSpecifier).toBe('Item At Index');
    expect(get.WFItemIndex.WFSerializationType).toBe('WFTextTokenAttachment');
    expect(get.WFItemIndex.Value.OutputName).toBe('Dictionary Value');
    expect(actions[i + 1].WFWorkflowActionIdentifier).toBe('is.workflow.actions.removereminders');
    expect(params(actions[i + 1])).toEqual({});
  });

  it('sends the token, asks for JSON, reports its version and posts progress', () => {
    const posts = actions.filter((a) => a.WFWorkflowActionIdentifier === 'is.workflow.actions.downloadurl');
    expect(posts[0].WFWorkflowActionParameters.WFURL).toBe(opts.endpoint);
    expect(posts.slice(1).every((p) => p.WFWorkflowActionParameters.WFURL === `${opts.endpoint}?ack=1`)).toBe(true);
    expect(posts).toHaveLength(6); // snapshot, reply counts, removed, added, added, done
    const headers = (posts[0].WFWorkflowActionParameters.WFHTTPHeaders as { Value: { WFDictionaryFieldValueItems: { WFKey: { Value: { string: string } }; WFValue: { Value: { string: string } } }[] } }).Value.WFDictionaryFieldValueItems;
    const map = Object.fromEntries(headers.map((h) => [h.WFKey.Value.string, h.WFValue.Value.string]));
    expect(map).toEqual({ Authorization: `Bearer ${opts.token}`, 'Content-Type': 'text/plain; charset=utf-8', 'X-Journal-Format': 'json', 'X-Journal-Shortcut': SHORTCUT_VERSION });
  });

  it('filters to open reminders in both shapes Shortcuts has used', () => {
    const find = params(actions.find((a) => a.WFWorkflowActionIdentifier === 'is.workflow.actions.filter.reminders')!);
    const tpl = (find.WFContentItemFilter as { Value: { WFActionParameterFilterTemplates: Params[] } }).Value.WFActionParameterFilterTemplates[0];
    expect(tpl).toMatchObject({ Property: 'Is Completed', Operator: 4, Bool: false, Values: { Bool: false } });
  });
});

describe('buildJournalSyncPlist', () => {
  it('produces an XML plist with the actions', () => {
    const xml = buildJournalSyncPlist(opts);
    expect(xml.startsWith('<?xml version="1.0"')).toBe(true);
    expect(xml).toContain('<key>WFWorkflowActions</key>');
    expect(xml).toContain('is.workflow.actions.removereminders');
    expect(xml).toContain('is.workflow.actions.addnewreminder');
  });
});
