import { describe, expect, test } from 'bun:test';
import { findClient, renderEvent, ssidBands, Unifi } from '../src/unifi.ts';
import { AP_MAC, clients, devices, events, fakeController, LAPTOP_MAC } from './helpers.ts';

const cfg = { host: 'https://unifi.test', site: 'default', apiKey: 'k' };

describe('findClient', () => {
  test('MAC beats IP, in any notation', () => {
    const hit = findClient(clients, ['02-00-00-00-00-11'], '10.0.0.22');
    expect(hit?.matchedBy).toBe('mac');
    expect(hit?.client.hostname).toBe('laptop');
  });

  test('falls back to IPv4, IPv4-mapped, then IPv6', () => {
    expect(findClient(clients, [], '10.0.0.22')?.client.hostname).toBe('desk');
    expect(findClient(clients, [], '::ffff:10.0.0.22')?.client.hostname).toBe('desk');
    expect(findClient(clients, [], '2001:DB8::33')?.client.mac).toBe('02:00:00:00:00:33');
  });

  test('no match', () => {
    expect(findClient(clients, ['02:00:00:00:99:99'], '10.9.9.9')).toBeNull();
  });
});

test('ssidBands: bands on air per SSID, online APs only, in band order', () => {
  expect(ssidBands(devices)).toEqual([
    { ssid: 'Office', bands: ['2.4 GHz', '5 GHz', '6 GHz'], aps: 1 },
    { ssid: 'Office Legacy', bands: ['2.4 GHz', '5 GHz'], aps: 1 },
  ]);
});

test('renderEvent fills in parameter names', () => {
  expect(renderEvent(events[0]!).message).toBe('laptop roamed from AP East to AP West.');
});

describe('Unifi.snapshot', () => {
  test('client, its AP radio, and only its events', async () => {
    const ctl = fakeController();
    const u = new Unifi(cfg, ctl.impl);
    const s = await u.snapshot({ macs: [LAPTOP_MAC], ip: null });
    if ('error' in s) throw new Error(s.error);
    expect(s.matchedBy).toBe('mac');
    expect(s.client).toMatchObject({ band: '2.4 GHz', signal: -71, txRateMbps: 72, txRetriesPct: 18.5 });
    expect(s.ap).toMatchObject({ mac: AP_MAC, name: 'AP West', online: true });
    expect(s.radio).toMatchObject({ radio: 'ng', channel: 6, utilizationPct: 73, clients: 14 });
    expect(s.events.map((e) => e.key)).toEqual(['CLIENT_ROAMED_2']);
  });

  test('every controller call is a read', async () => {
    const ctl = fakeController();
    const u = new Unifi(cfg, ctl.impl);
    await u.snapshot({ macs: [LAPTOP_MAC], ip: null });
    await u.aps();
    for (const c of ctl.calls) {
      // The one POST is the system-log query, whose body is a filter.
      if (c.method !== 'GET') {
        expect(c.method).toBe('POST');
        expect(c.path).toEndWith('/system-log/all');
        expect(Object.keys(c.body as object).sort()).toEqual([
          'pageNumber',
          'pageSize',
          'timestampFrom',
          'timestampTo',
        ]);
      }
    }
  });

  test('a down controller yields {error}, not a throw', async () => {
    const u = new Unifi(cfg, fakeController({ fail: true }).impl);
    const s = await u.snapshot({ macs: [LAPTOP_MAC], ip: null });
    expect('error' in s && s.error).toContain('HTTP 502');
  });

  test('a failed load is not cached', async () => {
    let fail = true;
    const ok = fakeController();
    const impl = (async (i: RequestInfo | URL, init?: RequestInit) =>
      fail ? new Response('x', { status: 500 }) : ok.impl(i, init)) as typeof fetch;
    const u = new Unifi(cfg, impl);
    expect('error' in (await u.snapshot({ macs: [LAPTOP_MAC], ip: null }))).toBe(true);
    fail = false;
    expect('error' in (await u.snapshot({ macs: [LAPTOP_MAC], ip: null }))).toBe(false);
  });

  test('unknown client is reported with the reason', async () => {
    const u = new Unifi(cfg, fakeController().impl);
    const s = await u.snapshot({ macs: [], ip: '10.9.9.9' });
    if ('error' in s) throw new Error(s.error);
    expect(s.client).toBeNull();
    expect(s.reason).toContain('10.9.9.9');
  });
});
