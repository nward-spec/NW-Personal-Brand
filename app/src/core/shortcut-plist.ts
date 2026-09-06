// Builds the "Journal Sync" iPhone Shortcut as an unsigned .shortcut plist.
//
// What the Shortcut does:
//   1. Find Reminders that are not completed (newest 400 by creation date).
//   2. For each, write one line "title | list | due | completed".
//   3. POST the lines to the reminders-shortcut function with the sync token.
//      The JSON reply has three lists:
//        deletes: [{ index, title }]        → nth reminder from step 1 → Remove Reminders
//        creates: [{ list, title, when }]   → Add New Reminder, alert at `when`
//        undated: [{ list, title }]         → Add New Reminder with no date
//   4. Loop over each list. Every applied change posts a one-line report back
//      (…?ack=1) and shows a notification, so a run leaves a trail in Settings.
//
// Every action shape here was checked against shortcuts exported by the
// Shortcuts app itself. Things that matter:
//   - No If actions: their input must be wrapped as { Type: Variable, Variable }
//     and a value from JSON needs a text coercion before "is" matches. A loop
//     over an empty list simply does nothing, so the server splits the work.
//   - A number field holding one variable (Get Item from List's index) is a
//     WFTextTokenAttachment, not a token string.
//   - Remove Reminders takes the previous action's output; it has no parameters.
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

/** Sent as X-Journal-Shortcut so the app can tell which Shortcut a phone runs. Bump when the Shortcut changes. */
export const SHORTCUT_VERSION = '4';

export interface ShortcutOptions {
  endpoint: string;
  token: string;
  limit?: number;
}

export function buildJournalSyncActions(opts: ShortcutOptions): Action[] {
  const limit = opts.limit ?? 400;
  const REM = uuid(); // Find Reminders
  const LINE = uuid(); // Text per reminder
  const LOOP1 = uuid();
  const LOOP1_END = uuid();
  const COMBINED = uuid();
  const RESPONSE = uuid();
  const DELETES = uuid();
  const CREATES = uuid();
  const UNDATED = uuid();
  const N_DELETES = uuid();
  const N_CREATES = uuid();
  const N_UNDATED = uuid();
  const LOOP_D = uuid();
  const LOOP_C = uuid();
  const LOOP_U = uuid();
  const IDX = uuid();
  const TARGET = uuid();
  const D_TITLE = uuid();
  const C_LIST = uuid();
  const C_TITLE = uuid();
  const C_WHEN = uuid();
  const U_LIST = uuid();
  const U_TITLE = uuid();

  const headers = (contentType: string): PlistValue => ({
    Value: {
      WFDictionaryFieldValueItems: [
        { WFItemType: 0, WFKey: plain('Authorization'), WFValue: plain(`Bearer ${opts.token}`) },
        { WFItemType: 0, WFKey: plain('Content-Type'), WFValue: plain(contentType) },
        { WFItemType: 0, WFKey: plain('X-Journal-Format'), WFValue: plain('json') },
        { WFItemType: 0, WFKey: plain('X-Journal-Shortcut'), WFValue: plain(SHORTCUT_VERSION) },
      ],
    },
    WFSerializationType: 'WFDictionaryFieldValue',
  });
  const post = (url: string, body: Ref, id?: string) =>
    action('downloadurl', {
      ...(id ? { UUID: id } : {}),
      WFURL: url,
      WFHTTPMethod: 'POST',
      ShowHeaders: true,
      WFHTTPHeaders: headers('text/plain; charset=utf-8'),
      WFHTTPBodyType: 'File',
      WFRequestVariable: attachment(body),
    });
  /** Text → POST …?ack=1, so the server (and Settings) can show what the run did. */
  const report = (parts: (string | Ref)[]) => {
    const id = uuid();
    return [action('gettext', { UUID: id, WFTextActionText: tokenText(parts) }), post(`${opts.endpoint}?ack=1`, output(id, 'Text'))];
  };
  const field = (id: string, key: string) => action('getvalueforkey', { UUID: id, WFInput: attachment(repeatItem()), WFGetDictionaryValueType: 'Value', WFDictionaryKey: key });
  const listOf = (id: string, key: string) => action('getvalueforkey', { UUID: id, WFInput: attachment(output(RESPONSE, 'Contents of URL')), WFGetDictionaryValueType: 'Value', WFDictionaryKey: key });
  const count = (id: string, source: string, name: string) => action('count', { UUID: id, WFCountType: 'Items', Input: attachment(output(source, name)) });
  const loop = (group: string, source: string, name: string) => action('repeat.each', { GroupingIdentifier: group, WFControlFlowMode: 0, WFInput: attachment(output(source, name)) });
  const loopEnd = (group: string) => action('repeat.each', { GroupingIdentifier: group, WFControlFlowMode: 2 });
  const notify = (parts: (string | Ref)[]) =>
    action('notification', { WFNotificationActionTitle: 'Journal Sync', WFNotificationActionBody: tokenText(parts), WFNotificationActionSound: false });

  return [
    action('comment', {
      WFCommentActionText: `Journal Sync v${SHORTCUT_VERSION} — generated by Weekly Journal. Keep the name "Journal Sync". Sends your reminders to the journal and applies its changes.`,
    }),

    // 1. Snapshot
    action('filter.reminders', {
      UUID: REM,
      // Open reminders only: a recurring list spawns a completed copy per tick,
      // which would otherwise crowd out everything else.
      WFContentItemFilter: {
        Value: {
          WFActionParameterFilterPrefix: 1,
          WFActionParameterFilterTemplates: [{ Operator: 4, Property: 'Is Completed', Removable: true, Bool: false, Values: { Bool: false }, VariableOverrides: {} }],
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
    post(opts.endpoint, output(COMBINED, 'Combined Text'), RESPONSE),
    listOf(DELETES, 'deletes'),
    listOf(CREATES, 'creates'),
    listOf(UNDATED, 'undated'),
    count(N_DELETES, DELETES, 'Dictionary Value'),
    count(N_CREATES, CREATES, 'Dictionary Value'),
    count(N_UNDATED, UNDATED, 'Dictionary Value'),
    ...report(['reply deletes=', output(N_DELETES, 'Count'), ' creates=', output(N_CREATES, 'Count'), ' undated=', output(N_UNDATED, 'Count')]),

    // 3a. Deletes: nth reminder of the snapshot → Remove Reminders
    loop(LOOP_D, DELETES, 'Dictionary Value'),
    field(IDX, 'index'),
    action('getitemfromlist', { UUID: TARGET, WFInput: attachment(output(REM, 'Reminders')), WFItemSpecifier: 'Item At Index', WFItemIndex: attachment(output(IDX, 'Dictionary Value')) }),
    action('removereminders', {}),
    field(D_TITLE, 'title'),
    notify(['Removed ', output(D_TITLE, 'Dictionary Value')]),
    ...report(['removed ', output(IDX, 'Dictionary Value'), ' ', output(D_TITLE, 'Dictionary Value')]),
    loopEnd(LOOP_D),

    // 3b. Dated creates: Add New Reminder with an alert at `when`
    loop(LOOP_C, CREATES, 'Dictionary Value'),
    field(C_LIST, 'list'),
    field(C_TITLE, 'title'),
    field(C_WHEN, 'when'),
    action('addnewreminder', {
      WFCalendarItemTitle: tokenText([output(C_TITLE, 'Dictionary Value')]),
      WFCalendarItemCalendar: attachment(output(C_LIST, 'Dictionary Value')),
      WFCalendarItemAlert: true,
      WFAlertTrigger: 'At Time',
      WFAlertCustomTime: tokenText([output(C_WHEN, 'Dictionary Value')]),
    }),
    notify(['Added ', output(C_TITLE, 'Dictionary Value'), ' for ', output(C_WHEN, 'Dictionary Value')]),
    ...report(['added ', output(C_TITLE, 'Dictionary Value'), ' | ', output(C_LIST, 'Dictionary Value'), ' | ', output(C_WHEN, 'Dictionary Value')]),
    loopEnd(LOOP_C),

    // 3c. Undated creates
    loop(LOOP_U, UNDATED, 'Dictionary Value'),
    field(U_LIST, 'list'),
    field(U_TITLE, 'title'),
    action('addnewreminder', {
      WFCalendarItemTitle: tokenText([output(U_TITLE, 'Dictionary Value')]),
      WFCalendarItemCalendar: attachment(output(U_LIST, 'Dictionary Value')),
    }),
    notify(['Added ', output(U_TITLE, 'Dictionary Value')]),
    ...report(['added ', output(U_TITLE, 'Dictionary Value'), ' | ', output(U_LIST, 'Dictionary Value'), ' | ']),
    loopEnd(LOOP_U),

    ...report(['done']),
  ];
}

export function buildJournalSyncPlist(opts: ShortcutOptions): string {
  const root: { [key: string]: PlistValue } = {
    WFWorkflowClientVersion: '2607.0.3',
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowIcon: { WFWorkflowIconStartColor: 4282601983, WFWorkflowIconGlyphNumber: 59511 },
    WFWorkflowImportQuestions: [],
    WFWorkflowTypes: ['WFWorkflowTypeShowInSearch'],
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
