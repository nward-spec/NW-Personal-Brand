import { useEffect, useState } from 'react';
import { formatWeekMonth, todayISO, weekStartOf } from './core/week';
import { store } from './web/app-store';
import { useCloud } from './web/cloud';
import './web/reminders';
import { DaysScreen } from './ui/DaysScreen';
import { DinnersScreen } from './ui/DinnersScreen';
import { SettingsScreen } from './ui/SettingsScreen';
import { TabBar, type Tab } from './ui/TabBar';
import { WeekNav } from './ui/WeekNav';
import { WeekScreen } from './ui/WeekScreen';

const TAB_KEY = 'weekly-journal:tab';

function readTab(): Tab {
  try {
    const t = localStorage.getItem(TAB_KEY);
    if (t === 'week' || t === 'days' || t === 'dinners' || t === 'settings') return t;
  } catch {
    /* ignore */
  }
  return 'days';
}

function CloudPill({ onClick }: { onClick: () => void }) {
  const c = useCloud();
  if (!c.configured) return null;
  let label = 'Sign in to sync';
  let cls = 'pill';
  if (c.user) {
    switch (c.status) {
      case 'syncing':
        label = 'Syncing…';
        break;
      case 'synced':
        label = 'Synced';
        cls = 'pill accent';
        break;
      case 'offline':
        label = 'Offline';
        break;
      case 'error':
        label = 'Sync error';
        cls = 'pill danger';
        break;
      default:
        label = c.pending > 0 ? `${c.pending} to sync` : 'Synced';
    }
  }
  return (
    <button type="button" className={cls} onClick={onClick}>
      {label}
    </button>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>(readTab);
  const [weekStart, setWeekStart] = useState(() => weekStartOf(todayISO()));

  // Make sure the week exists (seeded from the templates) before it is edited.
  useEffect(() => {
    store.ensureWeek(weekStart);
  }, [weekStart]);

  // When the app is reopened after the week has rolled over, follow it to the
  // new week (only if the user was looking at what was then the current week).
  useEffect(() => {
    let shownWeek = weekStartOf(todayISO());
    const onShow = () => {
      if (document.visibilityState !== 'visible') return;
      const nowWeek = weekStartOf(todayISO());
      if (nowWeek !== shownWeek) {
        setWeekStart((ws) => (ws === shownWeek ? nowWeek : ws));
        shownWeek = nowWeek;
      }
    };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, []);

  const changeTab = (t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="app">
      <header className="header">
        {tab !== 'settings' ? (
          <>
            <WeekNav weekStart={weekStart} onChange={setWeekStart} />
            <div className="subbar">
              <span className="month">{formatWeekMonth(weekStart)}</span>
              <CloudPill onClick={() => changeTab('settings')} />
            </div>
          </>
        ) : (
          <div className="weeknav">
            <div className="title">
              <b>Weekly Journal</b>
              <small>Settings</small>
            </div>
          </div>
        )}
      </header>
      <main>
        {tab === 'week' && <WeekScreen weekStart={weekStart} />}
        {tab === 'days' && <DaysScreen weekStart={weekStart} />}
        {tab === 'dinners' && <DinnersScreen weekStart={weekStart} />}
        {tab === 'settings' && <SettingsScreen weekStart={weekStart} />}
      </main>
      <TabBar tab={tab} onChange={changeTab} />
    </div>
  );
}
