// A small CalDAV client for iCloud reminders. No XML library: iCloud's
// responses are regular enough to read with namespace-agnostic patterns.

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface DavAuth {
  username: string;
  password: string;
}

export interface Calendar {
  href: string;
  name: string;
  supportsTodo: boolean;
}

export interface DavObject {
  href: string;
  etag: string | null;
  ics: string;
}

export interface DavResponse {
  href: string;
  status: string;
  body: string;
}

const NS = 'xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"';

export function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** First element with the given local name (any prefix); returns its inner text. */
export function xmlText(xml: string, localName: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${localName}>`, 'i');
  const m = re.exec(xml);
  return m ? xmlUnescape(m[1].trim()) : null;
}

function xmlHas(xml: string, localName: string, attrs?: RegExp): boolean {
  const re = new RegExp(`<(?:[\\w-]+:)?${localName}(\\s[^>]*)?/?>`, 'ig');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (!attrs || attrs.test(m[1] ?? '')) return true;
  }
  return false;
}

/** Split a multistatus body into per-resource responses. */
export function parseMultistatus(xml: string): DavResponse[] {
  const out: DavResponse[] = [];
  const re = /<(?:[\w-]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const body = m[1];
    const href = xmlText(body, 'href') ?? '';
    const status = xmlText(body, 'status') ?? '';
    out.push({ href, status, body });
  }
  return out;
}

export class CalDavError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export class CalDav {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly auth: DavAuth,
    public readonly base = 'https://caldav.icloud.com/',
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const token = btoa(`${this.auth.username}:${this.auth.password}`);
    return { Authorization: `Basic ${token}`, 'User-Agent': 'WeeklyJournal/1.0', ...extra };
  }

  resolve(href: string, from: string = this.base): string {
    return new URL(href, from).toString();
  }

  private async request(method: string, url: string, body?: string, extra: Record<string, string> = {}): Promise<Response> {
    const res = await this.fetcher(url, {
      method,
      headers: this.headers({ ...(body ? { 'Content-Type': 'application/xml; charset=utf-8' } : {}), ...extra }),
      body,
      redirect: 'follow',
    });
    if (res.status === 401 || res.status === 403) throw new CalDavError('iCloud rejected the Apple ID or app-specific password.', res.status);
    return res;
  }

  /** The signed-in user's principal URL. */
  async discoverPrincipal(): Promise<string> {
    const res = await this.request('PROPFIND', this.base, `<?xml version="1.0" encoding="utf-8"?><D:propfind ${NS}><D:prop><D:current-user-principal/></D:prop></D:propfind>`, { Depth: '0' });
    const xml = await res.text();
    if (res.status >= 400) throw new CalDavError(`Principal lookup failed (${res.status})`, res.status);
    const principal = xmlText(xmlText(xml, 'current-user-principal') ?? '', 'href') ?? xmlText(xml, 'href');
    if (!principal) throw new CalDavError('iCloud did not return a principal URL.', res.status);
    return this.resolve(principal, res.url || this.base);
  }

  /** The calendar home collection that holds the reminder lists. */
  async discoverHome(principalUrl: string): Promise<string> {
    const res = await this.request('PROPFIND', principalUrl, `<?xml version="1.0" encoding="utf-8"?><D:propfind ${NS}><D:prop><C:calendar-home-set/></D:prop></D:propfind>`, { Depth: '0' });
    const xml = await res.text();
    if (res.status >= 400) throw new CalDavError(`Calendar home lookup failed (${res.status})`, res.status);
    const home = xmlText(xmlText(xml, 'calendar-home-set') ?? '', 'href');
    if (!home) throw new CalDavError('iCloud did not return a calendar home.', res.status);
    return this.resolve(home, res.url || principalUrl);
  }

  /** All calendars in the home; reminder lists are the ones supporting VTODO. */
  async listCalendars(homeUrl: string): Promise<Calendar[]> {
    const res = await this.request(
      'PROPFIND',
      homeUrl,
      `<?xml version="1.0" encoding="utf-8"?><D:propfind ${NS}><D:prop><D:displayname/><D:resourcetype/><C:supported-calendar-component-set/></D:prop></D:propfind>`,
      { Depth: '1' },
    );
    const xml = await res.text();
    if (res.status >= 400) throw new CalDavError(`Listing calendars failed (${res.status})`, res.status);
    const out: Calendar[] = [];
    for (const r of parseMultistatus(xml)) {
      const type = (() => {
        const m = /<(?:[\w-]+:)?resourcetype(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?resourcetype>/i.exec(r.body);
        return m ? m[1] : '';
      })();
      if (!xmlHas(type, 'calendar')) continue;
      const comps = (() => {
        const m = /<(?:[\w-]+:)?supported-calendar-component-set(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?supported-calendar-component-set>/i.exec(r.body);
        return m ? m[1] : '';
      })();
      const supportsTodo = xmlHas(comps, 'comp', /name="VTODO"/i);
      const href = this.resolve(r.href, res.url || homeUrl);
      const name = xmlText(r.body, 'displayname') ?? href.split('/').filter(Boolean).pop() ?? 'Reminders';
      out.push({ href, name, supportsTodo });
    }
    return out;
  }

  /** Every VTODO in a list, with its ETag. */
  async queryTodos(calendarHref: string): Promise<DavObject[]> {
    const body = `<?xml version="1.0" encoding="utf-8"?><C:calendar-query ${NS}><D:prop><D:getetag/><C:calendar-data/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VTODO"/></C:comp-filter></C:filter></C:calendar-query>`;
    const res = await this.request('REPORT', calendarHref, body, { Depth: '1' });
    const xml = await res.text();
    if (res.status >= 400) throw new CalDavError(`Reading reminders failed (${res.status})`, res.status);
    const out: DavObject[] = [];
    for (const r of parseMultistatus(xml)) {
      const ics = xmlText(r.body, 'calendar-data');
      if (!ics || !/BEGIN:VTODO/i.test(ics)) continue;
      out.push({ href: this.resolve(r.href, calendarHref), etag: xmlText(r.body, 'getetag'), ics });
    }
    return out;
  }

  /** Create or replace an object. Returns the new ETag when the server sends one. */
  async put(href: string, ics: string, etag?: string | null): Promise<string | null> {
    const res = await this.fetcher(href, {
      method: 'PUT',
      headers: this.headers({ 'Content-Type': 'text/calendar; charset=utf-8', ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }) }),
      body: ics,
      redirect: 'follow',
    });
    if (res.status === 412) throw new CalDavError('Reminder changed in iCloud meanwhile', 412);
    if (res.status >= 400) throw new CalDavError(`Saving reminder failed (${res.status})`, res.status);
    return res.headers.get('ETag');
  }

  async delete(href: string, etag?: string | null): Promise<void> {
    const res = await this.fetcher(href, { method: 'DELETE', headers: this.headers(etag ? { 'If-Match': etag } : {}), redirect: 'follow' });
    if (res.status === 404) return;
    if (res.status >= 400) throw new CalDavError(`Deleting reminder failed (${res.status})`, res.status);
  }
}
