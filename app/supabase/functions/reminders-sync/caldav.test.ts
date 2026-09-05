import { describe, expect, it } from 'vitest';
import { CalDav, parseMultistatus, xmlText } from './caldav';

const CALENDARS = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <response><href>/123/calendars/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  <response>
    <href>/123/calendars/home/</href>
    <propstat><prop>
      <displayname>Home</displayname>
      <resourcetype><collection/><C:calendar/></resourcetype>
      <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
    </prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
  <response>
    <href>/123/calendars/tasks/</href>
    <propstat><prop>
      <displayname>Reminders</displayname>
      <resourcetype><collection/><C:calendar/></resourcetype>
      <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
    </prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
  <response>
    <href>/123/calendars/dinners/</href>
    <propstat><prop>
      <displayname>Dinners &amp; Meals</displayname>
      <resourcetype><collection/><C:calendar/></resourcetype>
      <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
    </prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
</multistatus>`;

const TODOS = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/123/calendars/tasks/AAA.ics</D:href>
    <D:propstat><D:prop>
      <D:getetag>"C=12@U=abc"</D:getetag>
      <C:calendar-data>BEGIN:VCALENDAR
BEGIN:VTODO
UID:AAA
SUMMARY:Bake brownies &lt;for Sunday&gt;
DUE;VALUE=DATE:20260319
END:VTODO
END:VCALENDAR</C:calendar-data>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>`;

describe('parseMultistatus', () => {
  it('splits responses and unescapes text', () => {
    const rs = parseMultistatus(CALENDARS);
    expect(rs).toHaveLength(4);
    expect(xmlText(rs[3].body, 'displayname')).toBe('Dinners & Meals');
  });
});

function fakeFetch(routes: Record<string, { status: number; body?: string; headers?: Record<string, string> }>) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? 'GET', url, headers: init.headers as Record<string, string>, body: init.body as string | undefined });
    const r = routes[`${init.method} ${url}`] ?? routes[url];
    if (!r) return new Response('not found', { status: 404 });
    return new Response(r.status === 204 ? null : (r.body ?? ''), { status: r.status, headers: r.headers });
  };
  return { fetcher, calls };
}

describe('CalDav', () => {
  const home = 'https://p12-caldav.icloud.com/123/calendars/';

  it('lists reminder lists (VTODO calendars only)', async () => {
    const { fetcher, calls } = fakeFetch({ [`PROPFIND ${home}`]: { status: 207, body: CALENDARS } });
    const dav = new CalDav(fetcher, { username: 'a@icloud.com', password: 'xxxx-xxxx' });
    const cals = await dav.listCalendars(home);
    expect(cals.map((c) => [c.name, c.supportsTodo])).toEqual([
      ['Home', false],
      ['Reminders', true],
      ['Dinners & Meals', true],
    ]);
    expect(cals[1].href).toBe('https://p12-caldav.icloud.com/123/calendars/tasks/');
    expect(calls[0].headers.Authorization).toBe(`Basic ${btoa('a@icloud.com:xxxx-xxxx')}`);
    expect(calls[0].headers.Depth).toBe('1');
  });

  it('queries VTODOs and resolves hrefs', async () => {
    const list = `${home}tasks/`;
    const { fetcher, calls } = fakeFetch({ [`REPORT ${list}`]: { status: 207, body: TODOS } });
    const dav = new CalDav(fetcher, { username: 'a', password: 'b' });
    const objs = await dav.queryTodos(list);
    expect(objs).toHaveLength(1);
    expect(objs[0].href).toBe(`${home}tasks/AAA.ics`);
    expect(objs[0].etag).toBe('"C=12@U=abc"');
    expect(objs[0].ics).toContain('SUMMARY:Bake brownies <for Sunday>');
    expect(calls[0].body).toContain('comp-filter name="VTODO"');
  });

  it('discovers the principal and calendar home', async () => {
    const { fetcher } = fakeFetch({
      'PROPFIND https://caldav.icloud.com/': { status: 207, body: '<multistatus xmlns="DAV:"><response><href>/</href><propstat><prop><current-user-principal><href>/123/principal/</href></current-user-principal></prop></propstat></response></multistatus>' },
      'PROPFIND https://caldav.icloud.com/123/principal/': {
        status: 207,
        body: '<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response><href>/123/principal/</href><propstat><prop><C:calendar-home-set><href>https://p12-caldav.icloud.com:443/123/calendars/</href></C:calendar-home-set></prop></propstat></response></multistatus>',
      },
    });
    const dav = new CalDav(fetcher, { username: 'a', password: 'b' });
    const principal = await dav.discoverPrincipal();
    expect(principal).toBe('https://caldav.icloud.com/123/principal/');
    expect(await dav.discoverHome(principal)).toBe('https://p12-caldav.icloud.com/123/calendars/');
  });

  it('reports bad credentials clearly', async () => {
    const { fetcher } = fakeFetch({ 'PROPFIND https://caldav.icloud.com/': { status: 401 } });
    const dav = new CalDav(fetcher, { username: 'a', password: 'wrong' });
    await expect(dav.discoverPrincipal()).rejects.toThrow(/app-specific password/);
  });

  it('sends If-Match on updates and If-None-Match on creates', async () => {
    const { fetcher, calls } = fakeFetch({ [`PUT ${home}tasks/AAA.ics`]: { status: 204, headers: { ETag: '"new"' } }, [`PUT ${home}tasks/NEW.ics`]: { status: 201 } });
    const dav = new CalDav(fetcher, { username: 'a', password: 'b' });
    expect(await dav.put(`${home}tasks/AAA.ics`, 'BEGIN:VCALENDAR', '"old"')).toBe('"new"');
    expect(calls[0].headers['If-Match']).toBe('"old"');
    await dav.put(`${home}tasks/NEW.ics`, 'BEGIN:VCALENDAR', null);
    expect(calls[1].headers['If-None-Match']).toBe('*');
  });
});
