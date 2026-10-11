/**
 * Browser speed test against one or more targets.
 *
 * Measures idle latency and jitter, download, upload, and latency *under load*
 * (pings sent while the link is saturated). The gap between idle and loaded
 * latency is bufferbloat or airtime contention, and is often what people
 * actually feel as "the wifi is bad".
 */

export interface Target {
  id: string;
  name: string;
  kind: 'self' | 'cloudflare' | 'librespeed';
  base?: string;
}

export interface Result {
  target: string;
  name: string;
  pingMs?: number;
  jitterMs?: number;
  loadedPingMs?: number;
  downMbps?: number;
  upMbps?: number;
  error?: string;
}

export type Phase = 'ping' | 'download' | 'upload' | 'done' | 'error';

export interface Progress {
  target: string;
  phase: Phase;
  /** Live throughput for the running phase. */
  mbps?: number;
  /** 0..1 within the running phase. */
  fraction?: number;
  result: Result;
}

export interface Options {
  mode: 'parallel' | 'sequential';
  durationMs?: number;
  onProgress: (p: Progress) => void;
  signal?: AbortSignal;
}

const DEFAULT_DURATION = 8_000;
/** Throughput from the first part of a transfer is TCP ramp-up, not capacity. */
const WARMUP_FRACTION = 0.2;
const PING_SAMPLES = 12;

function endpoints(t: Target) {
  const r = () => Math.random().toString(36).slice(2);
  switch (t.kind) {
    case 'self':
      return {
        ping: () => `/api/ping?r=${r()}`,
        down: (bytes: number) => `/api/download?bytes=${bytes}&r=${r()}`,
        up: () => `/api/upload?r=${r()}`,
        chunk: 64 * 1024 * 1024,
        upChunk: 16 * 1024 * 1024,
        streams: 4,
      };
    case 'cloudflare':
      return {
        ping: () => `${t.base}/__down?bytes=0&r=${r()}`,
        down: (bytes: number) => `${t.base}/__down?bytes=${bytes}&r=${r()}`,
        up: () => `${t.base}/__up?r=${r()}`,
        // __down answers 403 at 100 MB; stay well under and repeat instead.
        chunk: 25_000_000,
        upChunk: 8 * 1024 * 1024,
        streams: 6,
      };
    case 'librespeed':
      // caddy-librespeed answers LibreSpeed's endpoints by their bare names at
      // any prefix; the PHP backend's backend/*.php paths work there too.
      return {
        ping: () => `${t.base}/empty?cors&r=${r()}`,
        // garbage sends ckSize MiB.
        down: (bytes: number) => `${t.base}/garbage?cors&ckSize=${Math.ceil(bytes / 1048576)}&r=${r()}`,
        up: () => `${t.base}/empty?cors&r=${r()}`,
        chunk: 25 * 1024 * 1024,
        upChunk: 8 * 1024 * 1024,
        streams: 6,
      };
  }
}

/** Everyone on a site shares one public address, so a 429 is the network's quota, not this device. */
function httpError(what: string, status: number): Error {
  if (status === 429)
    return new Error(`${what}: the server is rate-limiting this network (HTTP 429); try again in a few minutes`);
  return new Error(`${what} HTTP ${status}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length === 0 ? NaN : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

async function pingOnce(url: string, signal?: AbortSignal): Promise<number> {
  const t0 = performance.now();
  const res = await fetch(url, { cache: 'no-store', signal });
  await res.arrayBuffer();
  if (!res.ok) throw new Error(`ping HTTP ${res.status}`);
  return performance.now() - t0;
}

async function measurePing(t: Target, signal?: AbortSignal) {
  const ep = endpoints(t);
  // The first requests pay for DNS, TCP and TLS; warm the connection first.
  await pingOnce(ep.ping(), signal);
  await pingOnce(ep.ping(), signal);
  const samples: number[] = [];
  for (let i = 0; i < PING_SAMPLES; i++) {
    samples.push(await pingOnce(ep.ping(), signal));
    await sleep(60);
  }
  let jitter = 0;
  for (let i = 1; i < samples.length; i++) jitter += Math.abs(samples[i]! - samples[i - 1]!);
  jitter /= samples.length - 1;
  return { pingMs: round(median(samples)), jitterMs: round(jitter) };
}

/** Pings every 400 ms until stopped; returns the median. */
function loadedPinger(t: Target, stop: AbortSignal) {
  const ep = endpoints(t);
  const samples: number[] = [];
  const done = (async () => {
    while (!stop.aborted) {
      try {
        samples.push(await pingOnce(ep.ping(), stop));
      } catch {
        // An abort mid-ping at the end of the phase is expected; a failing
        // ping under load is visible as missing samples, not hidden.
      }
      await sleep(400);
    }
  })();
  return async () => {
    await done;
    return samples.length ? round(median(samples)) : undefined;
  };
}

/**
 * Bytes moved over time, shared by all streams of one phase, so throughput is
 * computed over the steady-state window only.
 */
class Meter {
  private total = 0;
  /** Bytes and time at the first sample after warm-up: the steady-state origin. */
  private origin: { bytes: number; at: number } | null = null;
  private warmupAt: number;
  constructor(
    private start: number,
    duration: number,
  ) {
    this.warmupAt = start + duration * WARMUP_FRACTION;
  }
  add(n: number) {
    const now = performance.now();
    if (this.origin === null && now >= this.warmupAt) this.origin = { bytes: this.total, at: now };
    this.total += n;
  }
  mbps(now = performance.now()): number {
    if (this.origin === null || now - this.origin.at < 250) {
      const el = (now - this.start) / 1000;
      return el > 0 ? (this.total * 8) / el / 1e6 : 0;
    }
    return ((this.total - this.origin.bytes) * 8) / ((now - this.origin.at) / 1000) / 1e6;
  }
}

async function measureDownload(
  t: Target,
  duration: number,
  signal: AbortSignal | undefined,
  live: (mbps: number, f: number) => void,
) {
  const ep = endpoints(t);
  const stop = new AbortController();
  signal?.addEventListener('abort', () => stop.abort());
  const start = performance.now();
  const meter = new Meter(start, duration);
  const timer = setTimeout(() => stop.abort(), duration);
  const tick = setInterval(() => live(meter.mbps(), Math.min(1, (performance.now() - start) / duration)), 250);
  const getLoaded = loadedPinger(t, stop.signal);
  let firstError: unknown;

  const stream = async () => {
    while (!stop.signal.aborted) {
      try {
        const res = await fetch(ep.down(ep.chunk), { cache: 'no-store', signal: stop.signal });
        if (!res.ok || !res.body) throw httpError('download', res.status);
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          meter.add(value.byteLength);
        }
      } catch (e) {
        if (stop.signal.aborted) return;
        firstError ??= e;
        stop.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: ep.streams }, stream));
  clearTimeout(timer);
  clearInterval(tick);
  const end = performance.now();
  if (firstError) throw firstError;
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  return { downMbps: round(meter.mbps(end)), loadedPingMs: await getLoaded() };
}

let uploadBlob: Blob | null = null;
function randomBlob(bytes: number): Blob {
  if (uploadBlob && uploadBlob.size >= bytes) return uploadBlob.slice(0, bytes);
  const buf = new Uint8Array(bytes);
  for (let off = 0; off < bytes; off += 65536) crypto.getRandomValues(buf.subarray(off, Math.min(bytes, off + 65536)));
  uploadBlob = new Blob([buf]);
  return uploadBlob;
}

async function measureUpload(
  t: Target,
  duration: number,
  signal: AbortSignal | undefined,
  live: (mbps: number, f: number) => void,
) {
  const ep = endpoints(t);
  const stop = new AbortController();
  signal?.addEventListener('abort', () => stop.abort());
  const start = performance.now();
  const meter = new Meter(start, duration);
  const timer = setTimeout(() => stop.abort(), duration);
  const tick = setInterval(() => live(meter.mbps(), Math.min(1, (performance.now() - start) / duration)), 250);
  const getLoaded = loadedPinger(t, stop.signal);
  const blob = randomBlob(ep.upChunk);
  let firstError: unknown;

  // XHR, not fetch: fetch has no upload progress, and without it a 16 MB
  // chunk would only be counted once it had finished.
  const one = () =>
    new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let sent = 0;
      xhr.upload.onprogress = (e) => {
        meter.add(e.loaded - sent);
        sent = e.loaded;
      };
      xhr.onload = () => (xhr.status < 400 ? resolve() : reject(httpError('upload', xhr.status)));
      xhr.onerror = () => reject(new Error('upload failed (network error or blocked by CORS)'));
      xhr.onabort = () => resolve();
      stop.signal.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.open('POST', ep.up());
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.send(blob);
    });

  const stream = async () => {
    while (!stop.signal.aborted) {
      try {
        await one();
      } catch (e) {
        if (stop.signal.aborted) return;
        firstError ??= e;
        stop.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: ep.streams }, stream));
  clearTimeout(timer);
  clearInterval(tick);
  const end = performance.now();
  if (firstError) throw firstError;
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  return { upMbps: round(meter.mbps(end)), loadedPingMs: await getLoaded() };
}

async function runPhase(
  targets: Target[],
  results: Map<string, Result>,
  phase: Exclude<Phase, 'done' | 'error'>,
  opts: Options,
) {
  const duration = opts.durationMs ?? DEFAULT_DURATION;
  const one = async (t: Target) => {
    const r = results.get(t.id)!;
    if (r.error) return;
    const report = (mbps?: number, fraction?: number) =>
      opts.onProgress({ target: t.id, phase, mbps, fraction, result: { ...r } });
    report();
    try {
      if (phase === 'ping') Object.assign(r, await measurePing(t, opts.signal));
      else if (phase === 'download') {
        const d = await measureDownload(t, duration, opts.signal, report);
        r.downMbps = d.downMbps;
        r.loadedPingMs = d.loadedPingMs;
      } else {
        const u = await measureUpload(t, duration, opts.signal, report);
        r.upMbps = u.upMbps;
        // Keep the worse of the two loaded latencies: that's the one people feel.
        if (u.loadedPingMs !== undefined) r.loadedPingMs = Math.max(r.loadedPingMs ?? 0, u.loadedPingMs);
      }
      report();
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      r.error = `${phase}: ${e instanceof Error ? e.message : String(e)}`;
      opts.onProgress({ target: t.id, phase: 'error', result: { ...r } });
    }
  };
  if (opts.mode === 'parallel') await Promise.all(targets.map(one));
  else for (const t of targets) await one(t);
}

export async function runSpeedTest(targets: Target[], opts: Options): Promise<Result[]> {
  const results = new Map(targets.map((t) => [t.id, { target: t.id, name: t.name } as Result]));
  for (const phase of ['ping', 'download', 'upload'] as const) await runPhase(targets, results, phase, opts);
  for (const t of targets) {
    const r = results.get(t.id)!;
    if (!r.error) opts.onProgress({ target: t.id, phase: 'done', result: { ...r } });
  }
  return [...results.values()];
}
