/**
 * The report format shared by the diagnostic scripts (scripts/wifi-check.*),
 * the browser speed test, and the agent API.
 *
 * Validation is strict about shape and size and says exactly what is wrong:
 * a report that doesn't fit is rejected with a 400, never trimmed to fit.
 * The scripts do their own truncation of raw command output before sending.
 */

export const CHECK_STATUSES = ['ok', 'info', 'warn', 'fail', 'error', 'skip'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const PLATFORMS = ['windows', 'macos', 'linux', 'other', 'browser'] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface Check {
  /** Stable machine id, e.g. "dns.local" */
  id: string;
  title: string;
  status: CheckStatus;
  /** What was observed, in plain language. */
  detail?: string;
  /** What the person could try. Advice only; the scripts never act on it. */
  advice?: string;
  /** Measurements behind the verdict (numbers, lists). */
  data?: unknown;
}

export interface WifiInfo {
  interface?: string;
  state?: string;
  ssid?: string;
  bssid?: string;
  mac?: string;
  band?: string;
  channel?: number;
  radioType?: string;
  signalPercent?: number;
  rssi?: number;
  noise?: number;
  rxMbps?: number;
  txMbps?: number;
  auth?: string;
  driver?: string;
}

export interface InterfaceInfo {
  name?: string;
  description?: string;
  type?: string;
  mac?: string;
  ipv4?: string[];
  ipv6?: string[];
  gateway?: string[];
  dns?: string[];
  dhcp?: boolean;
}

export interface DiagnosticPayload {
  schema: 1;
  kind: 'diagnostic';
  tool: { name: string; version: string };
  collectedAt: string;
  host: { hostname?: string; platform: Platform; os?: string };
  description?: string;
  wifi?: WifiInfo;
  interfaces?: InterfaceInfo[];
  checks: Check[];
  /** Raw command output keyed by the command that produced it. */
  raw?: Record<string, string>;
}

export interface SpeedResult {
  target: string;
  name: string;
  pingMs?: number;
  jitterMs?: number;
  loadedPingMs?: number;
  downMbps?: number;
  upMbps?: number;
  error?: string;
}

export interface SpeedtestPayload {
  schema: 1;
  kind: 'speedtest';
  collectedAt: string;
  mode: 'parallel' | 'sequential';
  description?: string;
  userAgent?: string;
  connection?: { effectiveType?: string; downlinkMbps?: number; rttMs?: number };
  results: SpeedResult[];
}

export type ReportPayload = DiagnosticPayload | SpeedtestPayload;

export const LIMITS = {
  bodyBytes: 1_500_000,
  shortString: 300,
  longString: 4_000,
  rawSection: 128_000,
  rawSections: 40,
  checks: 200,
  interfaces: 64,
  listItems: 64,
  results: 16,
  dataJson: 16_000,
} as const;

export class ReportError extends Error {
  override name = 'ReportError';
}

// ── Small typed readers. Each throws a ReportError naming the path. ─────────

type Obj = Record<string, unknown>;

function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ReportError(`${path} must be an object`);
  return v as Obj;
}

function str(v: unknown, path: string, max: number = LIMITS.shortString): string {
  if (typeof v !== 'string') throw new ReportError(`${path} must be a string`);
  if (v.length > max) throw new ReportError(`${path} is longer than ${max} characters`);
  return v;
}

function optStr(v: unknown, path: string, max: number = LIMITS.shortString): string | undefined {
  return v === undefined || v === null || v === '' ? undefined : str(v, path, max);
}

function optNum(v: unknown, path: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  // PowerShell and sh both find it easier to emit "42" than 42.
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ReportError(`${path} must be a number`);
  return n;
}

function optBool(v: unknown, path: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ReportError(`${path} must be a boolean`);
  return v;
}

function optStrList(v: unknown, path: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  // ConvertTo-Json in Windows PowerShell 5.1 flattens a one-element array to
  // a scalar unless every call site is careful; accept that shape.
  const arr = Array.isArray(v) ? v : [v];
  if (arr.length > LIMITS.listItems) throw new ReportError(`${path} has more than ${LIMITS.listItems} items`);
  return arr.map((x, i) => str(x, `${path}[${i}]`));
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v))
    throw new ReportError(`${path} must be one of ${allowed.join(', ')}`);
  return v as T;
}

function arr(v: unknown, path: string, max: number): unknown[] {
  if (v === undefined || v === null) return [];
  const a = Array.isArray(v) ? v : [v];
  if (a.length > max) throw new ReportError(`${path} has more than ${max} items`);
  return a;
}

function isoDate(v: unknown, path: string): string {
  const s = str(v, path);
  if (Number.isNaN(Date.parse(s))) throw new ReportError(`${path} is not a date`);
  return new Date(s).toISOString();
}

function strip<T extends Obj>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

// ── Payload parsers ─────────────────────────────────────────────────────────

function parseCheck(v: unknown, path: string): Check {
  const o = obj(v, path);
  let data: unknown;
  if (o.data !== undefined && o.data !== null) {
    const json = JSON.stringify(o.data);
    if (json.length > LIMITS.dataJson) throw new ReportError(`${path}.data is larger than ${LIMITS.dataJson} bytes`);
    data = o.data;
  }
  return strip({
    id: str(o.id, `${path}.id`, 80),
    title: str(o.title, `${path}.title`),
    status: oneOf(o.status, CHECK_STATUSES, `${path}.status`),
    detail: optStr(o.detail, `${path}.detail`, LIMITS.longString),
    advice: optStr(o.advice, `${path}.advice`, LIMITS.longString),
    data,
  });
}

function parseWifi(v: unknown, path: string): WifiInfo {
  const o = obj(v, path);
  return strip({
    interface: optStr(o.interface, `${path}.interface`),
    state: optStr(o.state, `${path}.state`),
    ssid: optStr(o.ssid, `${path}.ssid`),
    bssid: optStr(o.bssid, `${path}.bssid`),
    mac: optStr(o.mac, `${path}.mac`),
    band: optStr(o.band, `${path}.band`),
    channel: optNum(o.channel, `${path}.channel`),
    radioType: optStr(o.radioType, `${path}.radioType`),
    signalPercent: optNum(o.signalPercent, `${path}.signalPercent`),
    rssi: optNum(o.rssi, `${path}.rssi`),
    noise: optNum(o.noise, `${path}.noise`),
    rxMbps: optNum(o.rxMbps, `${path}.rxMbps`),
    txMbps: optNum(o.txMbps, `${path}.txMbps`),
    auth: optStr(o.auth, `${path}.auth`),
    driver: optStr(o.driver, `${path}.driver`),
  });
}

function parseInterface(v: unknown, path: string): InterfaceInfo {
  const o = obj(v, path);
  return strip({
    name: optStr(o.name, `${path}.name`),
    description: optStr(o.description, `${path}.description`),
    type: optStr(o.type, `${path}.type`),
    mac: optStr(o.mac, `${path}.mac`),
    ipv4: optStrList(o.ipv4, `${path}.ipv4`),
    ipv6: optStrList(o.ipv6, `${path}.ipv6`),
    gateway: optStrList(o.gateway, `${path}.gateway`),
    dns: optStrList(o.dns, `${path}.dns`),
    dhcp: optBool(o.dhcp, `${path}.dhcp`),
  });
}

function parseRaw(v: unknown, path: string): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined;
  const o = obj(v, path);
  const keys = Object.keys(o);
  if (keys.length > LIMITS.rawSections) throw new ReportError(`${path} has more than ${LIMITS.rawSections} sections`);
  const out: Record<string, string> = {};
  for (const k of keys) {
    str(k, `${path} key`, 200);
    out[k] = str(o[k], `${path}[${JSON.stringify(k)}]`, LIMITS.rawSection);
  }
  return out;
}

function parseDiagnostic(o: Obj): DiagnosticPayload {
  const tool = obj(o.tool, 'tool');
  const host = obj(o.host, 'host');
  return strip({
    schema: 1 as const,
    kind: 'diagnostic' as const,
    tool: { name: str(tool.name, 'tool.name'), version: str(tool.version, 'tool.version') },
    collectedAt: isoDate(o.collectedAt, 'collectedAt'),
    host: strip({
      hostname: optStr(host.hostname, 'host.hostname'),
      platform: oneOf(host.platform, PLATFORMS, 'host.platform'),
      os: optStr(host.os, 'host.os'),
    }),
    description: optStr(o.description, 'description', LIMITS.longString),
    wifi: o.wifi === undefined || o.wifi === null ? undefined : parseWifi(o.wifi, 'wifi'),
    interfaces: arr(o.interfaces, 'interfaces', LIMITS.interfaces).map((x, i) => parseInterface(x, `interfaces[${i}]`)),
    checks: arr(o.checks, 'checks', LIMITS.checks).map((x, i) => parseCheck(x, `checks[${i}]`)),
    raw: parseRaw(o.raw, 'raw'),
  });
}

function parseSpeedResult(v: unknown, path: string): SpeedResult {
  const o = obj(v, path);
  return strip({
    target: str(o.target, `${path}.target`, 40),
    name: str(o.name, `${path}.name`),
    pingMs: optNum(o.pingMs, `${path}.pingMs`),
    jitterMs: optNum(o.jitterMs, `${path}.jitterMs`),
    loadedPingMs: optNum(o.loadedPingMs, `${path}.loadedPingMs`),
    downMbps: optNum(o.downMbps, `${path}.downMbps`),
    upMbps: optNum(o.upMbps, `${path}.upMbps`),
    error: optStr(o.error, `${path}.error`, LIMITS.longString),
  });
}

function parseSpeedtest(o: Obj): SpeedtestPayload {
  let connection: SpeedtestPayload['connection'];
  if (o.connection !== undefined && o.connection !== null) {
    const c = obj(o.connection, 'connection');
    connection = strip({
      effectiveType: optStr(c.effectiveType, 'connection.effectiveType', 20),
      downlinkMbps: optNum(c.downlinkMbps, 'connection.downlinkMbps'),
      rttMs: optNum(c.rttMs, 'connection.rttMs'),
    });
  }
  const results = arr(o.results, 'results', LIMITS.results).map((x, i) => parseSpeedResult(x, `results[${i}]`));
  if (results.length === 0) throw new ReportError('results is empty');
  return strip({
    schema: 1 as const,
    kind: 'speedtest' as const,
    collectedAt: isoDate(o.collectedAt, 'collectedAt'),
    mode: oneOf(o.mode, ['parallel', 'sequential'] as const, 'mode'),
    description: optStr(o.description, 'description', LIMITS.longString),
    userAgent: optStr(o.userAgent, 'userAgent', 500),
    connection,
    results,
  });
}

export function parseReport(input: unknown): ReportPayload {
  const o = obj(input, 'report');
  if (o.schema !== 1) throw new ReportError('schema must be 1');
  const kind = oneOf(o.kind, ['diagnostic', 'speedtest'] as const, 'kind');
  return kind === 'diagnostic' ? parseDiagnostic(o) : parseSpeedtest(o);
}

// ── Derived fields ──────────────────────────────────────────────────────────

const SEVERITY: Record<CheckStatus, number> = { skip: 0, ok: 1, info: 2, warn: 3, error: 4, fail: 5 };

/** The most severe check status, or "ok" for a report without checks. */
export function worstStatus(p: ReportPayload): CheckStatus {
  if (p.kind !== 'diagnostic') return p.results.some((r) => r.error) ? 'error' : 'ok';
  let worst: CheckStatus = 'ok';
  for (const c of p.checks) if (SEVERITY[c.status] > SEVERITY[worst]) worst = c.status;
  return worst;
}

/** MAC addresses the report claims for this machine, normalized. */
export function reportedMacs(p: ReportPayload): string[] {
  if (p.kind !== 'diagnostic') return [];
  const macs = new Set<string>();
  const add = (m?: string) => {
    const n = m && normalizeMac(m);
    if (n) macs.add(n);
  };
  add(p.wifi?.mac);
  for (const i of p.interfaces ?? []) add(i.mac);
  return [...macs];
}

export function normalizeMac(m: string): string | null {
  const hex = m.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12 || /^0+$/.test(hex)) return null;
  return hex.match(/../g)!.join(':');
}
