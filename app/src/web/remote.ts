import type { SupabaseClient } from '@supabase/supabase-js';
import { isTemplates, isWeekDoc, normaliseWeek } from '../core/model';
import type { RemoteStore } from '../core/sync';
import type { Templates, WeekDoc } from '../core/types';

/** RemoteStore backed by the `weeks` and `templates` tables in supabase/schema.sql. */
export function createSupabaseRemote(client: SupabaseClient, userId: string): RemoteStore {
  return {
    async fetchAll() {
      const [weeksRes, templatesRes] = await Promise.all([
        client.from('weeks').select('week_start, data, updated_at').eq('user_id', userId),
        client.from('templates').select('data, updated_at').eq('user_id', userId).maybeSingle(),
      ]);
      if (weeksRes.error) throw new Error(weeksRes.error.message);
      if (templatesRes.error) throw new Error(templatesRes.error.message);

      const weeks: WeekDoc[] = [];
      for (const row of weeksRes.data ?? []) {
        const doc = row.data as unknown;
        if (isWeekDoc(doc)) weeks.push(normaliseWeek(doc));
      }
      const t = templatesRes.data?.data as unknown;
      return { weeks, templates: isTemplates(t) ? t : null };
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
