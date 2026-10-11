import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server } from 'bun';
import index from '../web/index.html';
import { ReportBus } from './bus.ts';
import type { Config } from './config.ts';
import { ReportStore, summarize, TRIAGE_STATUSES, type StoredReport, type TriageStatus } from './db.ts';
import { newReportCode, newReportId } from './ids.ts';
import { llmsTxt } from './llms.ts';
import { LIMITS, parseReport, ReportError, reportedMacs, worstStatus, type ReportPayload } from './report.ts';
import { loadTemplates, renderScripts, requestBaseUrl } from './scripts.ts';
import * as speed from './speed.ts';
import { Unifi } from './unifi.ts';

export interface AppDeps {
  config: Config;
  store: ReportStore;
  unifi: Unifi | null;
  bus?: ReportBus;
  templates?: { ps1: string; sh: string };
  /** Reports per client IP per window, to keep a misbehaving script from filling the disk. */
  rateLimit?: { max: number; windowMs: number };
}

const json = (body: unknown, init?: ResponseInit) =>
  Response.json(body, { ...init, headers: { 'Cache-Control': 'no-store', ...init?.headers } });
const error = (status: number, message: string) => json({ error: message }, { status });

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

export function createApp(deps: AppDeps) {
  const { config, store, unifi } = deps;
  const bus = deps.bus ?? new ReportBus();
  const templates = deps.templates ?? loadTemplates();
  const rate = deps.rateLimit ?? { max: 30, windowMs: 10 * 60_000 };
  const recent = new Map<string, number[]>();
  const tokenHash = sha256(config.agentToken);

  // Render once per base URL up front, so a broken template fails at boot.
  const scripts = new Map(config.publicBaseUrls.map((u) => [u, renderScripts(templates, config, u)]));

  function clientIp(req: Request, server: Server<undefined>): string {
    if (config.trustProxy) {
      const real = req.headers.get('x-real-ip')?.trim();
      if (real) return real;
      const xff = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
      if (xff) return xff;
    }
    return server.requestIP(req)?.address ?? 'unknown';
  }

  function isAgent(req: Request): boolean {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
    return !!m && timingSafeEqual(sha256(m[1]!.trim()), tokenHash);
  }

  function limited(ip: string): boolean {
    const now = Date.now();
    const hits = (recent.get(ip) ?? []).filter((t) => now - t < rate.windowMs);
    if (hits.length >= rate.max) {
      recent.set(ip, hits);
      return true;
    }
    hits.push(now);
    recent.set(ip, hits);
    return false;
  }

  function scriptFor(req: Request) {
    return scripts.get(requestBaseUrl(req, config, config.trustProxy))!;
  }

  const text = (body: string, type: string, extra?: Record<string, string>) =>
    new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra } });

  async function createReport(req: Request, server: Server<undefined>): Promise<Response> {
    const ip = clientIp(req, server);
    if (limited(ip)) return error(429, `too many reports from ${ip}; try again in a few minutes`);

    const len = Number(req.headers.get('content-length') ?? 0);
    if (len > LIMITS.bodyBytes) return error(413, `report larger than ${LIMITS.bodyBytes} bytes`);
    const raw = await req.arrayBuffer();
    if (raw.byteLength > LIMITS.bodyBytes) return error(413, `report larger than ${LIMITS.bodyBytes} bytes`);

    let payload: ReportPayload;
    try {
      // Non-UTF-8 bytes from a shell script become U+FFFD rather than a rejection.
      const body = new TextDecoder('utf-8', { fatal: false }).decode(raw).replace(/^﻿/, '');
      payload = parseReport(JSON.parse(body));
    } catch (e) {
      if (e instanceof ReportError || e instanceof SyntaxError) return error(400, e.message);
      throw e;
    }

    const snapshot = unifi
      ? await unifi.snapshot({ macs: reportedMacs(payload), ip, since: new Date(payload.collectedAt) })
      : null;

    const report = store.insert({
      id: newReportId(),
      code: newReportCode(),
      createdAt: new Date().toISOString(),
      kind: payload.kind,
      clientIp: ip,
      hostname: payload.kind === 'diagnostic' ? (payload.host.hostname ?? null) : null,
      platform: payload.kind === 'diagnostic' ? payload.host.platform : 'browser',
      ssid:
        (payload.kind === 'diagnostic' ? payload.wifi?.ssid : undefined) ??
        (snapshot && 'client' in snapshot ? snapshot.client?.ssid : undefined) ??
        null,
      worst: worstStatus(payload),
      description: payload.description ?? null,
      payload,
      unifi: snapshot,
    });
    bus.publish(report);
    const base = requestBaseUrl(req, config, config.trustProxy);
    // Kept flat on purpose: the sh script reads it with sed, not a JSON parser.
    return json({ id: report.id, code: report.code, url: `${base}/r/${report.id}` }, { status: 201 });
  }

  function parseListQuery(url: URL) {
    const p = url.searchParams;
    const num = (k: string, min: number, max: number, dflt?: number) => {
      const v = p.get(k);
      if (v === null || v === '') return dflt;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) throw new ReportError(`${k} must be an integer ${min}..${max}`);
      return n;
    };
    const status = p.get('status') || undefined;
    if (status && !TRIAGE_STATUSES.includes(status as TriageStatus))
      throw new ReportError(`status must be one of ${TRIAGE_STATUSES.join(', ')}`);
    const kind = p.get('kind') || undefined;
    if (kind && kind !== 'diagnostic' && kind !== 'speedtest')
      throw new ReportError('kind must be diagnostic or speedtest');
    return {
      since: num('since', 0, Number.MAX_SAFE_INTEGER),
      limit: num('limit', 1, 500, 50)!,
      wait: num('wait', 0, 120, 0)!,
      status: status as TriageStatus | undefined,
      kind: kind as ReportPayload['kind'] | undefined,
      code: p.get('code') || undefined,
      full: p.get('full') === '1',
    };
  }

  async function listReports(req: Request, server: Server<undefined>): Promise<Response> {
    let q: ReturnType<typeof parseListQuery>;
    try {
      q = parseListQuery(new URL(req.url));
    } catch (e) {
      if (e instanceof ReportError) return error(400, e.message);
      throw e;
    }
    let rows = store.list(q);
    // Long-poll: nothing new after the cursor → wait for the next report.
    if (rows.length === 0 && q.since !== undefined && q.wait > 0) {
      server.timeout(req, q.wait + 15);
      await bus.next(q.wait * 1000, req.signal);
      rows = store.list(q);
    }
    const cursor = rows.reduce((m, r) => Math.max(m, r.seq), q.since ?? 0) || store.latestSeq();
    return json({ cursor, reports: rows.map((r) => (q.full ? r : summarize(r))) });
  }

  function streamReports(req: Request, server: Server<undefined>): Response {
    const url = new URL(req.url);
    const sinceRaw = url.searchParams.get('since') ?? req.headers.get('last-event-id');
    const since = sinceRaw === null ? store.latestSeq() : Number(sinceRaw);
    if (!Number.isInteger(since) || since < 0) return error(400, 'since must be a non-negative integer');
    const full = url.searchParams.get('full') === '1';
    server.timeout(req, 0);

    const enc = new TextEncoder();
    let cleanup = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (r: StoredReport) =>
          controller.enqueue(
            enc.encode(`id: ${r.seq}\nevent: report\ndata: ${JSON.stringify(full ? r : summarize(r))}\n\n`),
          );
        controller.enqueue(enc.encode(`retry: 5000\n: connected, replaying after seq ${since}\n\n`));
        // Subscribe before replaying so nothing lands in the gap between the two.
        let last = since;
        const pending: StoredReport[] = [];
        let replaying = true;
        const unsubscribe = bus.subscribe((r) => {
          if (replaying) pending.push(r);
          else if (r.seq > last) {
            last = r.seq;
            send(r);
          }
        });
        for (
          let batch = store.list({ since: last, limit: 500 });
          batch.length;
          batch = store.list({ since: last, limit: 500 })
        )
          for (const r of batch) {
            last = r.seq;
            send(r);
          }
        replaying = false;
        for (const r of pending)
          if (r.seq > last) {
            last = r.seq;
            send(r);
          }
        const heartbeat = setInterval(() => controller.enqueue(enc.encode(': keepalive\n\n')), 20_000);
        cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
        };
        req.signal.addEventListener('abort', () => {
          cleanup();
          try {
            controller.close();
          } catch {
            // already closed by the client going away
          }
        });
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(body, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' },
    });
  }

  async function triage(req: Request, id: string): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return error(400, 'body must be JSON');
    }
    if (typeof body !== 'object' || body === null) return error(400, 'body must be an object');
    const { status, note, by } = body as Record<string, unknown>;
    if (status !== undefined && !TRIAGE_STATUSES.includes(status as TriageStatus))
      return error(400, `status must be one of ${TRIAGE_STATUSES.join(', ')}`);
    if (note !== undefined && (typeof note !== 'string' || !note.trim() || note.length > 8000))
      return error(400, 'note must be a non-empty string up to 8000 characters');
    if (by !== undefined && (typeof by !== 'string' || by.length > 100)) return error(400, 'by must be a short string');
    if (status === undefined && note === undefined) return error(400, 'nothing to change: give status and/or note');
    const updated = store.triage(id, {
      status: status as TriageStatus | undefined,
      note: note
        ? { at: new Date().toISOString(), by: (by as string | undefined) ?? 'agent', note: note as string }
        : undefined,
    });
    return updated ? json(updated) : error(404, 'no such report');
  }

  const agentOnly =
    (h: (req: Request, server: Server<undefined>) => Response | Promise<Response>) =>
    (req: Request, server: Server<undefined>) =>
      isAgent(req) ? h(req, server) : error(401, 'agent token required (Authorization: Bearer …)');

  const routes = {
    '/': index,
    // The page a submitter is sent to; the SPA reads the id from the path.
    '/r/:id': index,

    '/ps1': (req: Request) => text(scriptFor(req).ps1, 'text/plain; charset=utf-8'),
    '/win': (req: Request) => text(scriptFor(req).ps1, 'text/plain; charset=utf-8'),
    '/sh': (req: Request) => text(scriptFor(req).sh, 'text/x-shellscript; charset=utf-8'),
    '/mac': (req: Request) => text(scriptFor(req).sh, 'text/x-shellscript; charset=utf-8'),
    '/linux': (req: Request) => text(scriptFor(req).sh, 'text/x-shellscript; charset=utf-8'),
    '/download/wifi-check.cmd': (req: Request) =>
      text(scriptFor(req).cmd, 'application/octet-stream', {
        'Content-Disposition': 'attachment; filename="wifi-check.cmd"',
      }),
    '/download/wifi-check.ps1': (req: Request) =>
      text(scriptFor(req).ps1, 'application/octet-stream', {
        'Content-Disposition': 'attachment; filename="wifi-check.ps1"',
      }),
    '/download/wifi-check.sh': (req: Request) =>
      text(scriptFor(req).sh, 'application/octet-stream', {
        'Content-Disposition': 'attachment; filename="wifi-check.sh"',
      }),
    '/llms.txt': (req: Request) =>
      text(llmsTxt(requestBaseUrl(req, config, config.trustProxy)), 'text/plain; charset=utf-8'),

    '/api/health': () => json({ ok: true, version: config.buildSha }),
    '/api/config': (req: Request) =>
      json({
        version: config.buildSha,
        baseUrl: requestBaseUrl(req, config, config.trustProxy),
        unifi: unifi !== null,
        targets: [
          { id: 'lan', name: 'LAN (this server)', kind: 'self' },
          { id: 'cloudflare', name: 'Internet (Cloudflare)', kind: 'cloudflare', base: 'https://speed.cloudflare.com' },
          ...(config.librespeedUrl
            ? [{ id: 'librespeed', name: 'Internet (LibreSpeed)', kind: 'librespeed', base: config.librespeedUrl }]
            : []),
        ],
      }),
    '/api/ping': speed.ping,
    '/api/download': (req: Request) => speed.download(new URL(req.url)),
    '/api/upload': { POST: speed.upload },
    // Which bands each SSID is on air in. Public: SSIDs are broadcast anyway.
    // The scripts use the .txt form ("<bands>\t<ssid>" per line) to tell a
    // device on 5 GHz that this network also offers 6 GHz; sh has no JSON parser.
    '/api/network/ssids': async () => {
      if (!unifi) return error(503, 'UniFi lookup is disabled on this instance (UNIFI_ENABLED=false)');
      try {
        return json({ ssids: await unifi.ssids() });
      } catch (e) {
        return error(502, `network controller: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    '/api/network/ssids.txt': async () => {
      if (!unifi) return error(503, 'UniFi lookup is disabled on this instance (UNIFI_ENABLED=false)');
      try {
        const lines = (await unifi.ssids()).map((s) => `${s.bands.join(',')}\t${s.ssid}\n`);
        return text(lines.join(''), 'text/plain; charset=utf-8');
      } catch (e) {
        return error(502, `network controller: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    '/api/whoami': async (req: Request, server: Server<undefined>) => {
      const ip = clientIp(req, server);
      return json({ ip, unifi: unifi ? await unifi.snapshot({ macs: [], ip }) : null });
    },

    '/api/reports': {
      GET: agentOnly(listReports),
      POST: createReport,
    },
    '/api/reports/stream': agentOnly(streamReports),
    '/api/reports/:id': {
      GET: (req: Request & { params: { id: string } }) => {
        const r = store.get(req.params.id);
        return r ? json(r) : error(404, 'no such report');
      },
      PATCH: agentOnly((req) => triage(req, (req as Request & { params: { id: string } }).params.id)),
    },
    '/api/unifi/aps': agentOnly(async () => {
      if (!unifi) return error(503, 'UniFi lookup is disabled on this instance (UNIFI_ENABLED=false)');
      return json({ aps: await unifi.aps() });
    }),
  };

  return { routes, bus };
}

export function startServer(deps: AppDeps) {
  const { routes } = createApp(deps);
  return Bun.serve({
    port: deps.config.port,
    hostname: deps.config.hostname,
    // Uploads for the speed test are streamed and counted, up to this size.
    maxRequestBodySize: speed.MAX_UPLOAD_BYTES + 1024,
    idleTimeout: 60,
    development: process.env.NODE_ENV !== 'production',
    routes,
    fetch() {
      return error(404, 'not found');
    },
    error(e) {
      console.error(e);
      return error(500, 'internal error');
    },
  });
}
