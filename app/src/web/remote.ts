import type { SupabaseClient } from '@supabase/supabase-js';
import { isReminderRow, isTemplates, isWeekDoc, normaliseReminder, normaliseWeek } from '../core/model';
import type { RemoteStore } from '../core/sync';
import type { ReminderRow, Templates, WeekDoc } from '../core/types';

/** RemoteStore backed by the `weeks` and `templates` tables in supabase/schema.sql. */
export function createSupabaseRemote(client: SupabaseClient, userId: string): RemoteStore {
  return {
    async fetchAll() {
      const [weeksRes, templatesRes, remindersRes] = await Promise.all([
        client.from('weeks').select('week_start, data, updated_at').eq('user_id', userId),
        client.from('templates').select('data, updated_at').eq('user_id', userId).maybeSingle(),
        client.from('reminders').select('uid, data, updated_at').eq('user_id', userId),
      ]);
      if (weeksRes.error) throw new Error(weeksRes.error.message);
      if (templatesRes.error) throw new Error(templatesRes.error.message);
      if (remindersRes.error) throw new Error(remindersRes.error.message);

      const reminders: ReminderRow[] = [];
      for (const row of remindersRes.data ?? []) {
        const doc = row.data as unknown;
        if (isReminderRow(doc)) reminders.push(normaliseReminder({ ...doc, updatedAt: new Date(row.updated_at as string).toISOString() }));
      }

      const weeks: WeekDoc[] = [];
      for (const row of weeksRes.data ?? []) {
        const doc = row.data as unknown;
        if (isWeekDoc(doc)) weeks.push(normaliseWeek(doc));
      }
      const t = templatesRes.data?.data as unknown;
      return { weeks, templates: isTemplates(t) ? t : null, reminders };
    },

    async upsertReminders(rows: ReminderRow[]) {
      const payload = rows.map((r) => ({ user_id: userId, uid: r.uid, data: r, updated_at: r.updatedAt, pending: r.pending }));
      const { error } = await client.from('reminders').upsert(payload, { onConflict: 'user_id,uid' });
      if (error) throw new Error(error.message);
    },

    async upsertWeeks(weeks: WeekDoc[]) {
      const rows = weeks.map((w) => ({ user_id: userId, week_start: w.weekStart, data: w, updated_at: w.updatedAt }));
      const { error } = await client.from('weeks').upsert(rows, { onConflict: 'user_id,week_start' });
      if (error) throw new Error(error.message);
    },

    async upsertTemplates(templates: Templates) {
      const { error } = await client
        .from('templates')
        .upsert({ user_id: userId, data: templates, updated_at: templates.updatedAt }, { onConflict: 'user_id' });
      if (error) throw new Error(error.message);
    },
  };
}
