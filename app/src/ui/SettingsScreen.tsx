import { useRef, useState } from 'react';
import { applyTemplates, mergeData, mutateTemplates, templatesFromWeek } from '../core/model';
import { parseAppData } from '../core/persist';
import type { GoalTemplate, HabitTemplate } from '../core/types';
import { newId } from '../core/types';
import { store, updateWeek, useAppData } from '../web/app-store';
import { cloud, useCloud } from '../web/cloud';
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
      <TemplatesCard weekStart={weekStart} />
      <BackupCard />
      <section className="card">
        <div className="card-head">
          <h3 className="card-title">About</h3>
        </div>
        <p className="note">
          Weekly Journal v{__APP_VERSION__}. To install: open this page in Safari (iPhone) or Chrome (Android), then choose <b>Add to Home Screen</b>. It works offline once installed.
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
