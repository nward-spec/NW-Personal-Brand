# Weekly Journal

A mobile-first web app that replaces the paper weekly planner: top priorities,
a to-do list, weekly goals with planned days, notes, a Mon–Sun habit grid, and a
day-by-day plan with an outfit line per day. Installable on iPhone and Android
as a PWA, works offline, and syncs across devices when signed in.

## How it maps to the journal

| Journal page                         | App                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| Top priorities (3 slots)             | **Week** tab → Top priorities                                                           |
| To do list, highlight = done         | **Week** tab → To do list. Tap to tick. Dots/long-press → edit, delete, send to a day  |
| Weekly goals with days (Walk Tue/Thu) | **Week** tab → Weekly goals. Planned days seed an entry onto each day; progress shown   |
| Notes                                | **Week** tab → Notes                                                                    |
| Weekly habits with M–S dots          | **Week** tab → Weekly habits. Tap a dot; target text (x4, Sun–Thu) shown as a hint     |
| Day columns, arrow to move an item   | **Days** tab. Tap to tick, dots/long-press → move to another day, edit, delete          |
| Outfit scribbles per day             | **Days** tab → "Wear" line on each day                                                  |
| Re-writing goals/habits each week    | **Settings** → Every-week template. New weeks are seeded from it automatically          |
| Copying unfinished to-dos forward    | Automatic: unfinished to-dos roll into the next week when it is first opened            |

Weeks start on Monday and use the device's local time zone.

## Run it locally

```bash
cd app
npm install
npm run dev        # http://localhost:5173, open on your phone via the LAN URL it prints
npm test           # core logic tests (vitest)
npm run build      # typecheck + production build into dist/
npm run preview    # serve the production build
```

Without Supabase configured the app runs in **local-only mode**: everything is
saved in the browser's storage on that device. Settings → Backup can export and
import a JSON file.

## Cloud sync (Supabase)

1. Create a project at supabase.com.
2. Open the SQL editor and run [`supabase/schema.sql`](./supabase/schema.sql).
   It creates `weeks` and `templates` tables with row-level security so each
   user only sees their own rows.
3. Authentication → Providers: keep **Email** enabled. For the "Email me a
   sign-in link" button, add your app's URL to Authentication → URL
   Configuration → Redirect URLs.
4. Copy the project URL and anon key (Project Settings → API) into
   `app/.env.local` (see `.env.example`) for local dev, and into the GitHub
   Actions variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for the
   deployed build.

Sync model: each week is one JSON document, plus one for the template.
Edits are saved locally first, queued, and pushed after a short delay; the
queue survives reloads, so offline edits sync later. On launch, focus, or
reconnect the app pulls and merges by last-write-wins per document.

## Deploy (GitHub Pages)

The workflow in `.github/workflows/deploy-app.yml` builds `app/` and publishes
it on every push to `main` that touches `app/`.

One-time setup: repo **Settings → Pages → Source: GitHub Actions**. The app is
then served at `https://<owner>.github.io/<repo>/`. Add the two Supabase
variables under **Settings → Secrets and variables → Actions → Variables** if
you want sync.

Install on a phone: open the URL in Safari (iPhone) or Chrome (Android) and
choose **Add to Home Screen**.

## Code layout

```
app/
  src/core/     Framework-free logic (no React, no DOM). Reusable from Expo as-is.
    week.ts       Monday-first date maths and formatting
    types.ts      Data model
    model.ts      Pure update functions, week seeding, templates, merge
    store.ts      Tiny observable store with dirty tracking
    persist.ts    Key/value persistence (localStorage now, AsyncStorage later)
    sync.ts       Sync engine over an abstract RemoteStore
    *.test.ts     Vitest tests for the above
  src/web/      Browser wiring: Supabase client, remote adapter, store/auth hooks
  src/ui/       React screens and components
  supabase/     Database schema
  scripts/      Icon generator (pure Node, writes public/*.png)
```

### Adding a native app later (Expo)

`src/core` has no web dependencies, so an Expo app can import it directly and
only needs three adapters: a `KVStorage` backed by AsyncStorage (see
`persist.ts`), the same `createSupabaseRemote` from `src/web/remote.ts` (the
Supabase JS client runs in React Native), and native screens replacing
`src/ui`. Sign-in and sync logic in `src/web/cloud.ts` ports across with the
`window`/`document` listeners swapped for `AppState`/`NetInfo`.
