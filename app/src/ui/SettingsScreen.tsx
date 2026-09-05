import { useRef, useState } from 'react';
import { applyTemplates, mergeData, mutateTemplates, templatesFromWeek } from '../core/model';
import { parseAppData } from '../core/persist';
import type { GoalTemplate, HabitTemplate } from '../core/types';
import { newId } from '../core/types';
import { store, updateWeek, useAppData } from '../web/app-store';
import { cloud, useCloud } from '../web/cloud';
import { SHORTCUT_NAME, reminders, shortcutEndpoint, useReminders } from '../web/reminders';
import { buildJournalSyncPlist } from '../core/shortcut-plist';
import { ACCENT_PRESETS, DEFAULT_ACCENT, loadAccent, saveAccent } from '../web/theme';
import { daysLabel } from './Chips';
import { GoalSheet, HabitSheet } from './EditorSheets';

const STATUS_LABEL: Record<string, string> = {
  idle: 'Waiting to sync',
  syncing: 'Syncing…',
  synced: 'Up to date',
  error: 'Sync error',
  offline: 'Offline — will sync when back online',
};

export function SettingsScreen({ weekStart }: { weekStart: string }) {
  return (
    <>
      <h2 className="section-title">Settings</h2>
      <AccountCard />
      <RemindersCard />
      <AppearanceCard />
      <TemplatesCard weekStart={weekStart} />
      <BackupCard />
      <GuideCard />
      <section className="card">
        <div className="card-head">
          <h3 className="card-title">About</h3>
        </div>
        <p className="note">
          Weekly Journal v{__APP_VERSION__}, built {new Date(__BUILD_TIME__).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}. If a change you were told about is missing, close the app fully and reopen it. To install: open this page in Safari (iPhone) or Chrome (Android), then choose <b>Add to Home Screen</b>. It works offline once installed.
        </p>
      </section>
    </>
  );
}

function AccountCard() {
  const c = useCloud();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const m = await fn();
      if (m) setMessage(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-title">Account &amp; sync</h3>
      </div>
      {!c.configured && (
        <p className="note">
          This build is running in <b>local-only</b> mode: everything is saved on this device. To sync across devices, deploy the app with a Supabase project configured (see the README in the repo).
        </p>
      )}
      {c.configured && !c.ready && <p className="note">Checking sign-in…</p>}
      {c.configured && c.ready && !c.user && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => cloud.signIn(email, password));
          }}
        >
          <p className="note">Sign in to back up your journal and sync it across your devices. Your local data is kept and merged.</p>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && <p className="error">{error}</p>}
          {message && <p className="ok">{message}</p>}
          <div className="stack">
            <button type="submit" className="btn primary" disabled={busy || !email || !password}>
              Sign in
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !email || password.length < 6}
              onClick={() =>
                run(async () => {
                  const r = await cloud.signUp(email, password);
                  return r.needsConfirmation ? 'Account created. Check your email to confirm, then sign in.' : 'Account created and signed in.';
                })
              }
            >
              Create account
            </button>
            <button type="button" className="btn ghost" disabled={busy || !email} onClick={() => run(async () => (await cloud.magicLink(email), 'Magic link sent. Open it on this device.'))}>
              Email me a sign-in link
            </button>
          </div>
          <p className="small" style={{ marginTop: 8 }}>
            Passwords need at least 6 characters.
          </p>
        </form>
      )}
      {c.configured && c.user && (
        <>
          <div className="kv">
            <span className="k">Signed in as</span>
            <span>{c.user.email ?? c.user.id}</span>
          </div>
          <div className="kv">
            <span className="k">Status</span>
            <span className={c.status === 'error' ? 'error' : undefined}>
              {STATUS_LABEL[c.status] ?? c.status}
              {c.pending > 0 && c.status !== 'syncing' ? ` · ${c.pending} pending` : ''}
            </span>
          </div>
          {c.status === 'error' && c.detail && <p className="error">{c.detail}</p>}
          {error && <p className="error">{error}</p>}
          <div className="btnrow">
            <button type="button" className="btn" disabled={busy} onClick={() => run(() => cloud.syncNow())}>
              Sync now
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => run(() => cloud.signOut())}>
              Sign out
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function downloadShortcut(token: string) {
  const blob = new Blob([buildJournalSyncPlist({ endpoint: shortcutEndpoint(), token })], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${SHORTCUT_NAME}.shortcut`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function RemindersCard() {
  const c = useCloud();
  const r = useReminders();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showSteps, setShowSteps] = useState(false);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const m = await fn();
      if (m) setMessage(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'never');

  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-title">Apple Reminders</h3>
        {r.account && <span className="hint">Last run {fmt(r.account.lastSyncAt)}</span>}
      </div>
      {!c.configured && <p className="note">Needs cloud sync, which is not configured in this build.</p>}
      {c.configured && !c.user && <p className="note">Sign in above first. The sync is tied to your account.</p>}
      {c.configured && c.user && !r.account && (
        <>
          <p className="note">
            Reminders sync through a small Shortcut on your iPhone. Reminders with a due date appear on that day, undated ones from your Reminders list join the weekly to-do list, and your dinners list becomes the Dinners tab. Ticking, renaming, moving or deleting here changes them in Apple Reminders when the Shortcut next runs.
          </p>
          {error && <p className="error">{error}</p>}
          <button type="button" className="btn primary" disabled={busy} onClick={() => run(async () => (await reminders.connect(), setShowSteps(true), 'Ready. Follow the steps below to install the Shortcut.'))}>
            Set up Reminders sync
          </button>
        </>
      )}
      {c.configured && c.user && r.account && (
        <>
          <div className="kv">
            <span className="k">Lists seen</span>
            <span>{r.account.lists.length ? r.account.lists.join(', ') : 'none yet — run the Shortcut'}</span>
          </div>
          <div className="kv">
            <span className="k">To-do list from</span>
            <select
              value={r.account.todoList}
              onChange={(e) => run(() => reminders.setTodoList(e.target.value))}
              aria-label="Reminders list for the weekly to-do list"
              style={{ font: 'inherit', padding: '6px 8px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'inherit' }}
            >
              {[r.account.todoList, ...r.account.lists.filter((l) => l !== r.account?.todoList)].map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="kv">
            <span className="k">Dinners list</span>
            <select
              value={r.account.dinnersList}
              onChange={(e) => run(() => reminders.setDinnersList(e.target.value))}
              aria-label="Dinners list"
              style={{ font: 'inherit', padding: '6px 8px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'inherit' }}
            >
              {[r.account.dinnersList, ...r.account.lists.filter((l) => l !== r.account?.dinnersList)].map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          {(r.error || r.account.lastError) && <p className="error">{r.error ?? r.account.lastError}</p>}
          {error && <p className="error">{error}</p>}
          {message && <p className="ok">{message}</p>}
          <div className="btnrow">
            <button type="button" className="btn primary" disabled={busy || r.syncing} onClick={() => run(() => reminders.runShortcut())}>
              {r.syncing ? 'Opening Shortcuts…' : 'Sync now'}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => run(async () => (await reminders.pull(), 'Refreshed.'))}>
              Refresh
            </button>
          </div>
          <div className="btnrow">
            <button type="button" className="btn ghost" onClick={() => setShowSteps((v) => !v)}>
              {showSteps ? 'Hide setup steps' : 'Show setup steps'}
            </button>
            <button
              type="button"
              className="btn ghost danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm('Disconnect Apple Reminders? Reminders disappear from the app; nothing is deleted on your phone.')) void run(() => reminders.disconnect());
              }}
            >
              Disconnect
            </button>
          </div>
          {showSteps && (
            <div className="section">
              <p className="note">
                The Shortcut is generated for you; nothing to build by hand. iOS only installs <b>signed</b> Shortcut files, and signing happens on a Mac.
              </p>
              <ol className="steps">
                <li>
                  On your Mac, open this app in Safari, sign in, and tap <b>Download Shortcut file</b> below. It saves <i>Journal Sync.shortcut</i> to Downloads.
                </li>
                <li>
                  Open <b>Terminal</b> and paste:
                  <pre className="cmd">cd ~/Downloads &amp;&amp; shortcuts sign --mode anyone --input "Journal Sync.shortcut" --output "Journal Sync (signed).shortcut"</pre>
                </li>
                <li>
                  Double-click <i>Journal Sync (signed).shortcut</i> to add it to Shortcuts on the Mac. iCloud syncs it to your iPhone within a minute.
                </li>
                <li>
                  On the iPhone, open Shortcuts and run <b>Journal Sync</b> once to allow access to Reminders. Then come back here and tap <b>Refresh</b>.
                </li>
                <li>
                  Optional: Shortcuts → Automation → New → Time of Day, pick a few times, choose "Run immediately", and select Journal Sync. <b>Sync now</b> above runs it on demand.
                </li>
              </ol>
              <button type="button" className="btn" onClick={() => run(async () => (downloadShortcut(r.account!.token), 'Shortcut file downloading.'))}>
                Download Shortcut file
              </button>
              <div className="field" style={{ marginTop: 12 }}>
                <label>Sync token (already inside the file)</label>
                <input readOnly value={r.account.token} onFocus={(e) => e.currentTarget.select()} />
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function AppearanceCard() {
  const [accent, setAccent] = useState(loadAccent());
  const pick = (hex: string) => {
    setAccent(hex);
    saveAccent(hex);
  };
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-title">Appearance</h3>
        <span className="hint">this device</span>
      </div>
      <div className="swatches" role="radiogroup" aria-label="Accent colour">
        {ACCENT_PRESETS.map((p) => (
          <button key={p.hex} type="button" role="radio" aria-checked={accent.toLowerCase() === p.hex} aria-label={p.name} className={`swatch${accent.toLowerCase() === p.hex ? ' on' : ''}`} style={{ background: p.hex }} onClick={() => pick(p.hex)} />
        ))}
      </div>
      <div className="colorpick">
        <input type="color" value={accent} onChange={(e) => pick(e.target.value)} aria-label="Custom accent colour" />
        <span className="small">Pick any colour</span>
        {accent !== DEFAULT_ACCENT && (
          <button type="button" className="btn sm" onClick={() => pick(DEFAULT_ACCENT)}>
            Reset
          </button>
        )}
      </div>
    </section>
  );
}

function GuideCard() {
  const [open, setOpen] = useState(false);
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-title">Setup guide</h3>
        <button type="button" className="btn sm" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {!open && <p className="note">Step-by-step for a new person: install the app, create an account, connect Apple Reminders. Each person uses their own account and their own Apple ID.</p>}
      {open && (
        <ol className="steps">
          <li>
            <b>Install the app.</b> On your iPhone, open this page in Safari, tap Share, then <i>Add to Home Screen</i>. Open it from the icon from now on.
          </li>
          <li>
            <b>Create your account.</b> Settings → Account & sync → enter an email and a password (6+ characters) → <i>Create account</i>. You are signed in straight away; your data syncs to any device you sign in on. Each person has their own account.
          </li>
          <li>
            <b>Start the Reminders link.</b> Settings → Apple Reminders → <i>Set up Reminders sync</i>. This creates your personal sync key.
          </li>
          <li>
            <b>Get your Shortcut file on a Mac.</b> On any Mac, open this same web address in Safari, sign in with <i>your</i> account, then Settings → Apple Reminders → <i>Show setup steps</i> → <i>Download Shortcut file</i>.
          </li>
          <li>
            <b>Sign it.</b> In Terminal on that Mac:
            <pre className="cmd">cd ~/Downloads &amp;&amp; shortcuts sign --mode anyone --input "Journal Sync.shortcut" --output "Journal Sync (signed).shortcut"</pre>
          </li>
          <li>
            <b>Send it to your iPhone.</b> AirDrop <i>Journal Sync (signed).shortcut</i> from the Mac to your iPhone and tap <i>Add Shortcut</i>. (Do not rely on the Mac's own iCloud sync if the Mac is signed in to someone else's Apple ID.)
          </li>
          <li>
            <b>Allow it to run.</b> On the iPhone: Settings app → Shortcuts → Advanced → turn on <i>Allow Sharing Large Amounts of Data</i> and <i>Allow Deleting Without Confirmation</i>. Then open Shortcuts, run <b>Journal Sync</b> once and allow access to Reminders and to the journal's server (<i>Always Allow</i>).
          </li>
          <li>
            <b>Check it worked.</b> Back in the app, Settings → Apple Reminders → <i>Refresh</i>. Your lists appear; choose which list feeds the to-do list and which one is Dinners.
          </li>
          <li>
            <b>Keep it running.</b> Shortcuts → Automation → New → Time of Day → pick a few times → <i>Run immediately</i> → Journal Sync. <i>Sync now</i> in Settings runs it whenever you like.
          </li>
          <li>
            <b>Make it yours.</b> Settings → Appearance for the colour, and Settings → Every-week template for the goals and habits that seed each new week.
          </li>
        </ol>
      )}
    </section>
  );
}

function TemplatesCard({ weekStart }: { weekStart: string }) {
  const data = useAppData();
  const t = data.templates;
  const [sheet, setSheet] = useState<{ kind: 'goal'; item?: GoalTemplate } | { kind: 'habit'; item?: HabitTemplate } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const close = () => setSheet(null);
  const say = (m: string) => {
    setFlash(m);
    setTimeout(() => setFlash(null), 2500);
  };

  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-title">Every-week template</h3>
      </div>
      <p className="note">These goals and habits are added automatically whenever a new week is opened. Unfinished to-dos roll over on their own.</p>

      <div className="card-title" style={{ marginBottom: 6 }}>
        Goals
      </div>
      {t.goals.length === 0 && <div className="empty">No template goals.</div>}
      {t.goals.map((g) => (
        <div className="kv" key={g.id}>
          <span>
            {g.text}
            {g.days.length > 0 && <span className="small"> · {daysLabel(g.days)}</span>}
          </span>
          <button type="button" className="btn sm" onClick={() => setSheet({ kind: 'goal', item: g })}>
            Edit
          </button>
        </div>
      ))}
      <div className="btnrow">
        <button type="button" className="btn sm" onClick={() => setSheet({ kind: 'goal' })}>
          + Add goal
        </button>
      </div>

      <div className="card-title" style={{ margin: '16px 0 6px' }}>
        Habits
      </div>
      {t.habits.length === 0 && <div className="empty">No template habits.</div>}
      {t.habits.map((h) => (
        <div className="kv" key={h.id}>
          <span>
            {h.text}
            {h.target && <span className="small"> · {h.target}</span>}
          </span>
          <button type="button" className="btn sm" onClick={() => setSheet({ kind: 'habit', item: h })}>
            Edit
          </button>
        </div>
      ))}
      <div className="btnrow">
        <button type="button" className="btn sm" onClick={() => setSheet({ kind: 'habit' })}>
          + Add habit
        </button>
      </div>

      <div className="stack" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="btn"
          onClick={() => {
            const week = store.get().weeks[weekStart];
            if (!week) return;
            store.setTemplates(templatesFromWeek(week));
            say('Template replaced with this week’s goals and habits.');
          }}
        >
          Use this week as the template
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            updateWeek(weekStart, (w) => applyTemplates(w, store.get().templates));
            say('Template items added to this week.');
          }}
        >
          Add template items to this week
        </button>
        {flash && <p className="ok">{flash}</p>}
      </div>

      <GoalSheet
        open={sheet?.kind === 'goal'}
        initial={sheet?.kind === 'goal' && sheet.item ? { text: sheet.item.text, days: sheet.item.days } : undefined}
        onClose={close}
        onSave={(text, days) => {
          const existing = sheet?.kind === 'goal' ? sheet.item : undefined;
          store.updateTemplates((tp) =>
            mutateTemplates(tp, (d) => {
              const g = existing ? d.goals.find((x) => x.id === existing.id) : undefined;
              if (g) {
                g.text = text;
                g.days = days;
              } else d.goals.push({ id: newId(), text, days });
            }),
          );
        }}
        onDelete={
          sheet?.kind === 'goal' && sheet.item
            ? () => {
                const id = sheet.item!.id;
                store.updateTemplates((tp) => mutateTemplates(tp, (d) => void (d.goals = d.goals.filter((x) => x.id !== id))));
              }
            : undefined
        }
      />
      <HabitSheet
        open={sheet?.kind === 'habit'}
        initial={sheet?.kind === 'habit' && sheet.item ? { text: sheet.item.text, target: sheet.item.target } : undefined}
        onClose={close}
        onSave={(text, target) => {
          const existing = sheet?.kind === 'habit' ? sheet.item : undefined;
          store.updateTemplates((tp) =>
            mutateTemplates(tp, (d) => {
              const h = existing ? d.habits.find((x) => x.id === existing.id) : undefined;
              if (h) {
                h.text = text;
                h.target = target;
              } else d.habits.push({ id: newId(), text, target });
            }),
          );
        }}
        onDelete={
          sheet?.kind === 'habit' && sheet.item
            ? () => {
                const id = sheet.item!.id;
                store.updateTemplates((tp) => mutateTemplates(tp, (d) => void (d.habits = d.habits.filter((x) => x.id !== id))));
              }
            : undefined
        }
      />
    </section>
  );
}

function BackupCard() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(store.get(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `weekly-journal-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const importJson = async (file: File) => {
    setErr(null);
    setMsg(null);
    try {
      const parsed = parseAppData(JSON.parse(await file.text()));
      if (!parsed) throw new Error('That file is not a Weekly Journal backup.');
      const { merged, incomingNewer } = mergeData(store.get(), parsed);
      for (const key of incomingNewer) {
        if (key === 'templates') store.setTemplates(merged.templates);
        else store.setWeek(merged.weeks[key.slice('week:'.length)]);
      }
      setMsg(incomingNewer.length ? `Imported ${incomingNewer.length} item${incomingNewer.length === 1 ? '' : 's'}.` : 'Nothing newer to import.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-title">Backup</h3>
      </div>
      <p className="note">Export everything as a JSON file, or import a backup (newer entries win, nothing is lost).</p>
      <div className="btnrow">
        <button type="button" className="btn" onClick={exportJson}>
          Export
        </button>
        <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
          Import
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importJson(f);
            e.target.value = '';
          }}
        />
      </div>
      {msg && <p className="ok">{msg}</p>}
      {err && <p className="error">{err}</p>}
    </section>
  );
}
