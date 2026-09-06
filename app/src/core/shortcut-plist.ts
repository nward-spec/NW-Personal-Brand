// Builds the "Journal Sync" iPhone Shortcut as an unsigned .shortcut plist.
//
// What the Shortcut does:
//   1. Find Reminders that are not completed (newest 400 by creation date).
//   2. For each, write one line "title | list | due | completed".
//   3. POST the lines to the reminders-shortcut function with the sync token.
//   4. For each command in the JSON reply ({ commands: [{ op, index, list, title, due }] }):
//        delete         → nth reminder from step 1 → Remove Reminders
//        create         → Add New Reminder in the list, due on the given day
//        create-undated → Add New Reminder in the list, no date
//      Each applied command posts a small notification so a run is visible.
//
// Plist shapes worth knowing: the If action wants its input wrapped as
// { Type: 'Variable', Variable: <attachment> }; a bare attachment imports fine
// but never matches, so every branch is skipped without an error.
//
// iOS only imports signed shortcut files. Sign on a Mac with:
//   shortcuts sign --mode anyone --input "Journal Sync.shortcut" --output "Journal Sync (signed).shortcut"

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

const uuid = (): string => {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID().toUpperCase();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16).toUpperCase();
  });
};

// ---- Variable references -------------------------------------------------

interface Aggrandizement {
  Type: string;
  PropertyName?: string;
  WFDateFormatStyle?: string;
  WFDateFormat?: string;
}

type Ref = { OutputUUID: string; OutputName: string; Type: 'ActionOutput'; Aggrandizements?: Aggrandizement[] } | { VariableName: string; Type: 'Variable'; Aggrandizements?: Aggrandizement[] };

const output = (id: string, name: string): Ref => ({ OutputUUID: id, OutputName: name, Type: 'ActionOutput' });
const repeatItem = (aggr?: Aggrandizement[]): Ref => ({ VariableName: 'Repeat Item', Type: 'Variable', ...(aggr ? { Aggrandizements: aggr } : {}) });
const property = (name: string): Aggrandizement => ({ Type: 'WFPropertyVariableAggrandizement', PropertyName: name });

/** A parameter holding exactly one variable. */
const attachment = (ref: Ref): PlistValue => ({ Value: ref as unknown as PlistValue, WFSerializationType: 'WFTextTokenAttachment' });

/** Text with variables spliced in. Each `Ref` in `parts` becomes one attachment. */
function tokenText(parts: (string | Ref)[]): PlistValue {
  let str = '';
  const byRange: { [key: string]: PlistValue } = {};
  for (const p of parts) {
    if (typeof p === 'string') {
      str += p;
    } else {
      byRange[`{${str.length}, 1}`] = p as unknown as PlistValue;
      str += '￼';
    }
  }
  return { Value: { string: str, attachmentsByRange: byRange }, WFSerializationType: 'WFTextTokenString' };
}

const plain = (s: string): PlistValue => ({ Value: { string: s, attachmentsByRange: {} }, WFSerializationType: 'WFTextTokenString' });

// ---- Actions ----------------------------------------------------------------

interface Action {
  WFWorkflowActionIdentifier: string;
  WFWorkflowActionParameters: { [key: string]: PlistValue };
}

const action = (id: string, params: { [key: string]: PlistValue }): Action => ({ WFWorkflowActionIdentifier: `is.workflow.actions.${id}`, WFWorkflowActionParameters: params });

/** WFCondition code used by the If action: "is". */
const IS = 4;

/** Sent as X-Journal-Shortcut so the app can tell which Shortcut a phone runs. Bump when the Shortcut changes. */
export const SHORTCUT_VERSION = '3';

export interface ShortcutOptions {
  endpoint: string;
  token: string;
  limit?: number;
}

export function buildJournalSyncActions(opts: ShortcutOptions): Action[] {
  const limit = opts.limit ?? 400;
  const REM = uuid(); // Find Reminders
  const LINE = uuid(); // Text per reminder
  const LOOP1 = uuid(); // grouping for the first repeat
  const LOOP1_END = uuid(); // its "Repeat Results"
  const COMBINED = uuid();
  const RESPONSE = uuid();
  const LINES = uuid();
  const LOOP2 = uuid();
  const OP = uuid();
  const IDX = uuid();
  const ARG2 = uuid();
  const ARG3 = uuid();
  const ARG4 = uuid();
  const IF_DELETE = uuid();
  const TARGET = uuid();
  const DELETED_TITLE = uuid();
  const IF_CREATE = uuid();
  const IF_UNDATED = uuid();
  const ARG5 = uuid();
  const ARG6 = uuid();

  const item = (source: string, sourceName: string, index: number | Ref, id: string) =>
    action('getitemfromlist', {
      UUID: id,
      WFInput: attachment(output(source, sourceName)),
      WFItemSpecifier: 'Item At Index',
      WFItemIndex: typeof index === 'number' ? index : tokenText([index]),
    });

  const ifStart = (group: string, input: Ref, condition: number, value: string) =>
    action('conditional', {
      GroupingIdentifier: group,
      WFControlFlowMode: 0,
      WFInput: { Type: 'Variable', Variable: attachment(input) },
      WFCondition: condition,
      WFConditionalActionString: value,
    });
  const ifEnd = (group: string, id?: string) => action('conditional', { GroupingIdentifier: group, WFControlFlowMode: 2, ...(id ? { UUID: id } : {}) });
  const notify = (parts: (string | Ref)[]) =>
    action('notification', { WFNotificationActionTitle: 'Journal Sync', WFNotificationActionBody: tokenText(parts), WFNotificationActionSound: false });
  const field = (id: string, key: string) => action('getvalueforkey', { UUID: id, WFInput: attachment(repeatItem()), WFGetDictionaryValueType: 'Value', WFDictionaryKey: key });

  return [
    action('comment', {
      WFCommentActionText: 'Journal Sync — generated by Weekly Journal. Keep the name "Journal Sync". Sends your reminders to the journal and applies its changes.',
    }),

    // 1. Snapshot
    action('filter.reminders', {
      UUID: REM,
      // Open reminders only: a recurring list spawns a completed copy per tick,
      // which would otherwise crowd out everything else.
      WFContentItemFilter: {
        Value: {
          WFActionParameterFilterPrefix: 1,
          WFActionParameterFilterTemplates: [{ Operator: 4, Property: 'Is Completed', Removable: true, Values: { Bool: false } }],
          WFContentPredicateBoundedDate: false,
        },
        WFSerializationType: 'WFContentPredicateTableTemplate',
      },
      WFContentItemSortProperty: 'Creation Date',
      WFContentItemSortOrder: 'Latest First',
      WFContentItemLimitEnabled: true,
      WFContentItemLimitNumber: limit,
    }),
    action('repeat.each', { GroupingIdentifier: LOOP1, WFControlFlowMode: 0, WFInput: attachment(output(REM, 'Reminders')) }),
    action('gettext', {
      UUID: LINE,
      WFTextActionText: tokenText([
        repeatItem([property('Title')]),
        ' | ',
        repeatItem([property('List')]),
        ' | ',
        repeatItem([property('Due Date'), { Type: 'WFDateFormatVariableAggrandizement', WFDateFormatStyle: 'Custom', WFDateFormat: 'yyyy-MM-dd' }]),
        ' | ',
        repeatItem([property('Is Completed')]),
      ]),
    }),
    action('repeat.each', { GroupingIdentifier: LOOP1, WFControlFlowMode: 2, UUID: LOOP1_END }),
    action('text.combine', { UUID: COMBINED, text: attachment(output(LOOP1_END, 'Repeat Results')), WFTextSeparator: 'New Lines' }),

    // 2. Exchange with the journal
    action('downloadurl', {
      UUID: RESPONSE,
      WFURL: opts.endpoint,
      WFHTTPMethod: 'POST',
      ShowHeaders: true,
      WFHTTPHeaders: {
        Value: {
          WFDictionaryFieldValueItems: [
            { WFItemType: 0, WFKey: plain('Authorization'), WFValue: plain(`Bearer ${opts.token}`) },
            { WFItemType: 0, WFKey: plain('Content-Type'), WFValue: plain('text/plain; charset=utf-8') },
            { WFItemType: 0, WFKey: plain('X-Journal-Format'), WFValue: plain('json') },
            { WFItemType: 0, WFKey: plain('X-Journal-Shortcut'), WFValue: plain(SHORTCUT_VERSION) },
          ],
        },
        WFSerializationType: 'WFDictionaryFieldValue',
      },
      WFHTTPBodyType: 'File',
      WFRequestVariable: attachment(output(COMBINED, 'Combined Text')),
    }),

    // 3. Apply commands. The reply is JSON ({ commands: [{ op, index, list, title, due }] }),
    //    which Get Contents of URL hands over as a dictionary.
    action('getvalueforkey', { UUID: LINES, WFInput: attachment(output(RESPONSE, 'Contents of URL')), WFGetDictionaryValueType: 'Value', WFDictionaryKey: 'commands' }),
    action('repeat.each', { GroupingIdentifier: LOOP2, WFControlFlowMode: 0, WFInput: attachment(output(LINES, 'Dictionary Value')) }),
    field(OP, 'op'),

    // delete: nth reminder of the snapshot → Remove Reminders
    ifStart(IF_DELETE, output(OP, 'Dictionary Value'), IS, 'delete'),
    field(IDX, 'index'),
    item(REM, 'Reminders', output(IDX, 'Dictionary Value'), TARGET),
    action('removereminders', { WFInputReminders: attachment(output(TARGET, 'Item from List')) }),
    field(DELETED_TITLE, 'title'),
    notify(['Removed ', output(DELETED_TITLE, 'Dictionary Value')]),
    ifEnd(IF_DELETE),

    // create: Add New Reminder in the list, due at 9 am on the given day
    ifStart(IF_CREATE, output(OP, 'Dictionary Value'), IS, 'create'),
    field(ARG2, 'list'),
    field(ARG3, 'title'),
    field(ARG4, 'due'),
    action('addnewreminder', {
      WFCalendarItemTitle: tokenText([output(ARG3, 'Dictionary Value')]),
      WFCalendarItemCalendar: attachment(output(ARG2, 'Dictionary Value')),
      WFCalendarItemAlert: true,
      WFAlertTrigger: 'At Time',
      WFAlertCustomTime: tokenText([output(ARG4, 'Dictionary Value'), ' 09:00']),
    }),
    notify(['Added ', output(ARG3, 'Dictionary Value'), ' for ', output(ARG4, 'Dictionary Value')]),
    ifEnd(IF_CREATE),

    // create-undated: Add New Reminder in the list with no date
    ifStart(IF_UNDATED, output(OP, 'Dictionary Value'), IS, 'create-undated'),
    field(ARG5, 'list'),
    field(ARG6, 'title'),
    action('addnewreminder', {
      WFCalendarItemTitle: tokenText([output(ARG6, 'Dictionary Value')]),
      WFCalendarItemCalendar: attachment(output(ARG5, 'Dictionary Value')),
    }),
    notify(['Added ', output(ARG6, 'Dictionary Value')]),
    ifEnd(IF_UNDATED),
    action('repeat.each', { GroupingIdentifier: LOOP2, WFControlFlowMode: 2 }),
  ];
}

export function buildJournalSyncPlist(opts: ShortcutOptions): string {
  const root: { [key: string]: PlistValue } = {
    WFWorkflowClientVersion: '2607.0.3',
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowIcon: { WFWorkflowIconStartColor: 4282601983, WFWorkflowIconGlyphNumber: 59511 },
    WFWorkflowImportQuestions: [],
    WFWorkflowTypes: ['NCWidget', 'WatchKit'],
    WFWorkflowInputContentItemClasses: ['WFAppStoreAppContentItem', 'WFArticleContentItem', 'WFContactContentItem', 'WFDateContentItem', 'WFEmailAddressContentItem', 'WFGenericFileContentItem', 'WFImageContentItem', 'WFiTunesProductContentItem', 'WFLocationContentItem', 'WFDCMapsLinkContentItem', 'WFAVAssetContentItem', 'WFPDFContentItem', 'WFPhoneNumberContentItem', 'WFRichTextContentItem', 'WFSafariWebPageContentItem', 'WFStringContentItem', 'WFURLContentItem'],
    WFWorkflowHasShortcutInputVariables: false,
    WFWorkflowHasOutputFallback: false,
    WFWorkflowOutputContentItemClasses: [],
    WFQuickActionSurfaces: [],
    WFWorkflowActions: buildJournalSyncActions(opts) as unknown as PlistValue[],
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plist(root, 0)}</plist>\n`;
}

// ---- Minimal XML plist serialiser --------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist(v: PlistValue, depth: number): string {
  const pad = '\t'.repeat(depth);
  if (typeof v === 'string') return `${pad}<string>${esc(v)}</string>\n`;
  if (typeof v === 'boolean') return `${pad}<${v ? 'true' : 'false'}/>\n`;
  if (typeof v === 'number') return Number.isInteger(v) ? `${pad}<integer>${v}</integer>\n` : `${pad}<real>${v}</real>\n`;
  if (Array.isArray(v)) return `${pad}<array>\n${v.map((x) => plist(x, depth + 1)).join('')}${pad}</array>\n`;
  const entries = Object.entries(v);
  return `${pad}<dict>\n${entries.map(([k, x]) => `${pad}\t<key>${esc(k)}</key>\n${plist(x, depth + 1)}`).join('')}${pad}</dict>\n`;
}
