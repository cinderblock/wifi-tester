import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ReportStore } from '../src/db.ts';
import { startServer } from '../src/server.ts';
import { Unifi } from '../src/unifi.ts';
import { AGENT_TOKEN, diagnosticReport, fakeController, testConfig } from './helpers.ts';

let server: ReturnType<typeof startServer>;
let base: string;
const agent = { Authorization: `Bearer ${AGENT_TOKEN}` };
// The app sits behind Caddy, which sets these; tests play the proxy.
const viaProxy = (ip: string, host = 'wifi.test') => ({ 'X-Real-IP': ip, Host: host });

beforeAll(() => {
  const config = testConfig();
  server = startServer({
    config,
    store: new ReportStore(':memory:'),
    unifi: new Unifi(config.unifi!, fakeController().impl),
    rateLimit: { max: 5, windowMs: 60_000 },
  });
  base = server.url.origin;
});
afterAll(() => server.stop(true));

async function post(body: unknown, ip = '10.0.0.11') {
  return fetch(`${base}/api/reports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...viaProxy(ip) },
    body: JSON.stringify(body),
  });
}

describe('scripts and pages', () => {
  test('/ps1 is the PowerShell script for the host it was asked for', async () => {
    const res = await fetch(`${base}/ps1`, { headers: viaProxy('10.0.0.11', 'wifi.test') });
    expect(res.headers.get('content-type')).toStartWith('text/plain');
    expect(await res.text()).toContain("$BaseUrl = 'http://wifi.test'");
  });

  test('/sh and the downloads', async () => {
    expect(await (await fetch(`${base}/sh`, { headers: viaProxy('x') })).text()).toStartWith('#!/bin/sh');
    const cmd = await fetch(`${base}/download/wifi-check.cmd`, { headers: viaProxy('x') });
    expect(cmd.headers.get('content-disposition')).toContain('wifi-check.cmd');
  });

  test('the page and the report page both serve the app', async () => {
    for (const p of ['/', '/r/abc']) {
      const res = await fetch(base + p);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Wi-Fi check');
    }
  });

  test('llms.txt documents the agent API', async () => {
    expect(await (await fetch(`${base}/llms.txt`, { headers: viaProxy('x') })).text()).toContain('/api/reports/stream');
  });
});

describe('speed endpoints', () => {
  test('download sends exactly the bytes asked for, uncompressed and uncached', async () => {
    const res = await fetch(`${base}/api/download?bytes=10000000`);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect((await res.arrayBuffer()).byteLength).toBe(10_000_000);
  });

  test('download refuses silly sizes', async () => {
    expect((await fetch(`${base}/api/download?bytes=-1`)).status).toBe(400);
    expect((await fetch(`${base}/api/download?bytes=1e12`)).status).toBe(400);
  });

  test('upload counts what it received', async () => {
    const res = await fetch(`${base}/api/upload`, { method: 'POST', body: new Uint8Array(3_000_000) });
    expect((await res.json()).bytes).toBe(3_000_000);
  });

  test('ping', async () => {
    expect((await fetch(`${base}/api/ping`)).status).toBe(204);
  });
});

describe('reports', () => {
  let id: string;

  test('POST stores, enriches from UniFi, returns code + link', async () => {
    const res = await post(diagnosticReport({ description: 'drops every few minutes' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.code).toMatch(/^[0-9A-Z]{6}$/);
    expect(body.url).toBe(`http://wifi.test/r/${body.id}`);
    id = body.id;

    const full = await (await fetch(`${base}/api/reports/${id}`)).json();
    expect(full.clientIp).toBe('10.0.0.11');
    expect(full.worst).toBe('warn');
    expect(full.description).toBe('drops every few minutes');
    expect(full.unifi.client.hostname).toBe('laptop');
    expect(full.unifi.radio.utilizationPct).toBe(73);
  });

  test('bad reports are rejected with the reason', async () => {
    const res = await post(diagnosticReport({ kind: 'nonsense' }), '10.0.0.50');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('kind');
  });

  test('unknown ids are 404', async () => {
    expect((await fetch(`${base}/api/reports/nope`)).status).toBe(404);
  });

  test('listing, streaming and triage need the agent token', async () => {
    expect((await fetch(`${base}/api/reports`)).status).toBe(401);
    expect((await fetch(`${base}/api/reports`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(`${base}/api/reports/stream`)).status).toBe(401);
    expect((await fetch(`${base}/api/reports/${id}`, { method: 'PATCH', body: '{}' })).status).toBe(401);
    expect((await fetch(`${base}/api/unifi/aps`)).status).toBe(401);
  });

  test('list returns summaries without raw output', async () => {
    const body = await (await fetch(`${base}/api/reports`, { headers: agent })).json();
    expect(body.reports[0].id).toBe(id);
    expect(body.reports[0].payload).toBeUndefined();
    expect(body.reports[0].unifi).toEqual({ ap: 'AP West', band: 'ng', channel: 6, signal: -71 });
    expect(body.cursor).toBeGreaterThan(0);
  });

  test('long-poll wakes on the next report', async () => {
    const { cursor } = await (await fetch(`${base}/api/reports`, { headers: agent })).json();
    const waiting = fetch(`${base}/api/reports?since=${cursor}&wait=10`, { headers: agent }).then((r) => r.json());
    await Bun.sleep(100);
    const created = await (await post(diagnosticReport(), '10.0.0.12')).json();
    const got = await waiting;
    expect(got.reports.map((r: { id: string }) => r.id)).toEqual([created.id]);
    expect(got.cursor).toBeGreaterThan(cursor);
  });

  test('long-poll times out empty with the same cursor', async () => {
    const { cursor } = await (await fetch(`${base}/api/reports`, { headers: agent })).json();
    const got = await (await fetch(`${base}/api/reports?since=${cursor}&wait=1`, { headers: agent })).json();
    expect(got).toEqual({ cursor, reports: [] });
  });

  test('SSE replays after the cursor, then streams live', async () => {
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/reports/stream?since=0`, { headers: agent, signal: ctl.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const until = async (pred: () => boolean) => {
      while (!pred()) buf += dec.decode((await reader.read()).value);
    };
    await until(() => (buf.match(/event: report/g) ?? []).length >= 2);
    const live = await (await post(diagnosticReport(), '10.0.0.13')).json();
    await until(() => buf.includes(live.id));
    ctl.abort();
  });

  test('triage: status and appended notes', async () => {
    const patch = (body: unknown) =>
      fetch(`${base}/api/reports/${id}`, {
        method: 'PATCH',
        headers: { ...agent, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await patch({ status: 'bogus' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    await patch({ status: 'ack', note: 'on 2.4 GHz at 73% util', by: 'claude' });
    const r = await (await patch({ note: 'moved to 5 GHz, fixed' })).json();
    expect(r.status).toBe('ack');
    expect(r.notes.map((n: { note: string }) => n.note)).toEqual(['on 2.4 GHz at 73% util', 'moved to 5 GHz, fixed']);
    const filtered = await (await fetch(`${base}/api/reports?status=ack`, { headers: agent })).json();
    expect(filtered.reports.map((x: { id: string }) => x.id)).toEqual([id]);
  });

  test('lookup by the code a person reads out', async () => {
    const created = await (await post(diagnosticReport(), '10.0.0.14')).json();
    const got = await (
      await fetch(`${base}/api/reports?code=${created.code.toLowerCase()}`, { headers: agent })
    ).json();
    expect(got.reports.some((r: { id: string }) => r.id === created.id)).toBe(true);
  });

  test('rate limit per client IP', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await post(diagnosticReport(), '10.0.0.99')).status);
    expect(codes.slice(0, 5).every((c) => c === 201)).toBe(true);
    expect(codes[6]).toBe(429);
  });

  test('UniFi AP overview for agents', async () => {
    const body = await (await fetch(`${base}/api/unifi/aps`, { headers: agent })).json();
    expect(body.aps).toHaveLength(1);
    expect(body.aps[0].radios[0]).toMatchObject({ band: '2.4 GHz', utilizationPct: 73 });
  });
});

test('whoami finds the caller by IP', async () => {
  const body = await (await fetch(`${base}/api/whoami`, { headers: viaProxy('10.0.0.22') })).json();
  expect(body.ip).toBe('10.0.0.22');
  expect(body.unifi.client).toMatchObject({ wired: true, uplinkName: 'Switch 1' });
});
