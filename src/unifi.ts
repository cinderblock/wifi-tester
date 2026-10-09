/**
 * Read-only lens on the UniFi Network controller.
 *
 * Everything here is a GET, except the system-log query: that one is a POST
 * whose body is the query itself, and it changes nothing. This module never
 * calls an endpoint that writes. Give it a key from a View Only admin and it
 * physically can't.
 *
 * Endpoints (verified against UniFi OS Server, Network 9.x, 2026-10):
 *   GET  /proxy/network/api/s/<site>/stat/sta        connected clients
 *   GET  /proxy/network/api/s/<site>/stat/device     devices, incl. AP radio stats
 *   POST /proxy/network/v2/api/site/<site>/system-log/all   events
 *        (legacy stat/event is gone; `searchText` is ignored, so we filter here)
 */
import type { UnifiConfig } from './config.ts';
import { normalizeMac } from './report.ts';

// ── Raw controller shapes (only the fields we read) ─────────────────────────

export interface RawClient {
  mac: string;
  hostname?: string;
  name?: string;
  ip?: string;
  ipv6_addresses?: string[];
  is_wired?: boolean;
  essid?: string;
  bssid?: string;
  ap_mac?: string;
  radio?: string;
  radio_proto?: string;
  channel?: number;
  channel_width?: number;
  signal?: number;
  noise?: number;
  rssi?: number;
  tx_rate?: number;
  rx_rate?: number;
  wifi_tx_retries_percentage?: number;
  satisfaction?: number;
  satisfaction_reason?: number;
  uptime?: number;
  network?: string;
  powersave_enabled?: boolean;
  last_uplink_name?: string;
  anomalies?: number;
  nss?: number;
  is_11r?: boolean;
  is_mlo?: boolean;
  oui?: string;
}

export interface RawRadioStats {
  name?: string;
  radio: string;
  channel?: number;
  bw?: number;
  cu_total?: number;
  cu_self_rx?: number;
  cu_self_tx?: number;
  num_sta?: number;
  satisfaction?: number;
  tx_retries_pct?: number;
  tx_power?: number;
  state?: string;
}

export interface RawDevice {
  mac: string;
  name?: string;
  model?: string;
  type: string;
  ip?: string;
  state?: number;
  uptime?: number;
  num_sta?: number;
  satisfaction?: number;
  radio_table_stats?: RawRadioStats[];
}

export interface RawEvent {
  id: string;
  key: string;
  event?: string;
  category?: string;
  severity?: string;
  timestamp: number;
  message?: string;
  message_raw?: string;
  parameters?: Record<string, { id?: string; name?: string } | undefined>;
}

// ── What we store and serve ─────────────────────────────────────────────────

export interface ClientView {
  mac: string;
  hostname?: string;
  name?: string;
  ip?: string;
  wired: boolean;
  ssid?: string;
  bssid?: string;
  apMac?: string;
  /** ng = 2.4 GHz, na = 5 GHz, 6e = 6 GHz */
  radio?: string;
  band?: string;
  radioProto?: string;
  channel?: number;
  channelWidth?: number;
  signal?: number;
  noise?: number;
  txRateMbps?: number;
  rxRateMbps?: number;
  txRetriesPct?: number;
  satisfaction?: number;
  uptimeSec?: number;
  network?: string;
  powersave?: boolean;
  uplinkName?: string;
  nss?: number;
  fastRoaming?: boolean;
  mlo?: boolean;
  vendor?: string;
}

export interface RadioView {
  radio: string;
  band: string;
  channel?: number;
  widthMhz?: number;
  /** Channel utilization, percent of airtime busy (all sources). */
  utilizationPct?: number;
  /** Of that, this AP's own receive/transmit. The rest is neighbours and noise. */
  selfRxPct?: number;
  selfTxPct?: number;
  clients?: number;
  satisfaction?: number;
  txRetriesPct?: number;
  txPower?: number;
}

export interface ApView {
  mac: string;
  name?: string;
  model?: string;
  ip?: string;
  online: boolean;
  uptimeSec?: number;
  clients?: number;
  satisfaction?: number;
  radios: RadioView[];
}

export interface EventView {
  at: string;
  key: string;
  severity?: string;
  message: string;
}

export type UnifiSnapshot =
  | { fetchedAt: string; error: string }
  | {
      fetchedAt: string;
      /** How the client was found, or null when it wasn't. */
      matchedBy: 'mac' | 'ip' | null;
      reason?: string;
      client: ClientView | null;
      ap?: ApView;
      /** The AP radio this client is on. */
      radio?: RadioView;
      events: EventView[];
      eventsTruncated: boolean;
    };

export function bandName(radio: string | undefined): string | undefined {
  switch (radio) {
    case 'ng':
      return '2.4 GHz';
    case 'na':
      return '5 GHz';
    case '6e':
      return '6 GHz';
    default:
      return radio;
  }
}

export function clientView(c: RawClient): ClientView {
  const wired = c.is_wired === true;
  return strip({
    mac: c.mac,
    hostname: c.hostname,
    name: c.name,
    ip: c.ip,
    wired,
    ssid: wired ? undefined : c.essid,
    bssid: wired ? undefined : c.bssid,
    apMac: wired ? undefined : c.ap_mac,
    radio: wired ? undefined : c.radio,
    band: wired ? undefined : bandName(c.radio),
    radioProto: wired ? undefined : c.radio_proto,
    channel: wired ? undefined : c.channel,
    channelWidth: wired ? undefined : c.channel_width,
    signal: wired ? undefined : c.signal,
    noise: wired ? undefined : c.noise,
    txRateMbps: wired || c.tx_rate === undefined ? undefined : c.tx_rate / 1000,
    rxRateMbps: wired || c.rx_rate === undefined ? undefined : c.rx_rate / 1000,
    txRetriesPct: wired ? undefined : c.wifi_tx_retries_percentage,
    satisfaction: c.satisfaction,
    uptimeSec: c.uptime,
    network: c.network,
    powersave: wired ? undefined : c.powersave_enabled,
    uplinkName: c.last_uplink_name,
    nss: wired ? undefined : c.nss,
    fastRoaming: wired ? undefined : c.is_11r,
    mlo: wired ? undefined : c.is_mlo,
    vendor: c.oui || undefined,
  });
}

export function radioView(r: RawRadioStats): RadioView {
  return strip({
    radio: r.radio,
    band: bandName(r.radio) ?? r.radio,
    channel: r.channel,
    widthMhz: r.bw,
    utilizationPct: r.cu_total,
    selfRxPct: r.cu_self_rx,
    selfTxPct: r.cu_self_tx,
    clients: r.num_sta,
    satisfaction: r.satisfaction,
    txRetriesPct: r.tx_retries_pct,
    txPower: r.tx_power,
  });
}

export function apView(d: RawDevice): ApView {
  return strip({
    mac: d.mac,
    name: d.name,
    model: d.model,
    ip: d.ip,
    // state 1 = connected; anything else (disconnected, upgrading, adopting…) is "not serving normally".
    online: d.state === 1,
    uptimeSec: d.uptime,
    clients: d.num_sta,
    satisfaction: d.satisfaction,
    radios: (d.radio_table_stats ?? []).map(radioView),
  });
}

/** "{CLIENT} roamed from {DEVICE_FROM} to {DEVICE_TO}" → names filled in. */
export function renderEvent(e: RawEvent): EventView {
  const template = e.message_raw ?? e.message ?? e.key;
  const message = template.replace(/\{([A-Z0-9_]+)\}/g, (whole, k: string) => e.parameters?.[k]?.name ?? whole);
  return strip({ at: new Date(e.timestamp).toISOString(), key: e.key, severity: e.severity, message });
}

export function eventMac(e: RawEvent): string | null {
  const id = e.parameters?.CLIENT?.id;
  return id ? normalizeMac(id) : null;
}

/** Find the reporting machine among connected clients. MAC beats IP: IPs move. */
export function findClient(
  clients: RawClient[],
  macs: string[],
  ip: string | null,
): { client: RawClient; matchedBy: 'mac' | 'ip' } | null {
  const wanted = new Set(macs.map(normalizeMac).filter((m): m is string => m !== null));
  if (wanted.size) {
    // Prefer a wireless match when a machine is on wifi and a dock at once.
    const hits = clients.filter((c) => wanted.has(normalizeMac(c.mac) ?? ''));
    const hit = hits.find((c) => !c.is_wired) ?? hits[0];
    if (hit) return { client: hit, matchedBy: 'mac' };
  }
  if (ip) {
    const bare = ip.replace(/^::ffff:/, '').toLowerCase();
    const hit = clients.find((c) => c.ip === bare || c.ipv6_addresses?.some((a) => a.toLowerCase() === bare));
    if (hit) return { client: hit, matchedBy: 'ip' };
  }
  return null;
}

function strip<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

// ── Client with small TTL caches ────────────────────────────────────────────

export class UnifiError extends Error {
  override name = 'UnifiError';
}

interface CacheEntry<T> {
  at: number;
  value: Promise<T>;
}

const EVENT_PAGE_SIZE = 500;
const EVENT_MAX_PAGES = 8;

export class Unifi {
  private cache = new Map<string, CacheEntry<unknown>>();

  constructor(
    private readonly cfg: UnifiConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.cfg.host + path, {
      method,
      headers: {
        'X-API-Key': this.cfg.apiKey,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) throw new UnifiError(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new UnifiError(`${method} ${path} → not JSON: ${text.slice(0, 200)}`);
    }
  }

  private cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key) as CacheEntry<T> | undefined;
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = load();
    this.cache.set(key, { at: Date.now(), value });
    // A failed load must not be served from cache for the whole TTL.
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    return value;
  }

  private async legacy<T>(endpoint: string): Promise<T[]> {
    const j = await this.request<{ meta?: { rc?: string; msg?: string }; data?: T[] }>(
      'GET',
      `/proxy/network/api/s/${encodeURIComponent(this.cfg.site)}/${endpoint}`,
    );
    if (j.meta?.rc !== 'ok' || !Array.isArray(j.data))
      throw new UnifiError(`${endpoint}: controller said ${j.meta?.rc ?? '?'} ${j.meta?.msg ?? ''}`.trim());
    return j.data;
  }

  clients(): Promise<RawClient[]> {
    return this.cached('sta', 10_000, () => this.legacy<RawClient>('stat/sta'));
  }

  devices(): Promise<RawDevice[]> {
    return this.cached('device', 30_000, () => this.legacy<RawDevice>('stat/device'));
  }

  async aps(): Promise<ApView[]> {
    return (await this.devices()).filter((d) => d.type === 'uap').map(apView);
  }

  /** The last `hours` of system-log events, newest first. */
  events(hours: number): Promise<{ events: RawEvent[]; truncated: boolean }> {
    return this.cached(`events:${hours}`, 60_000, async () => {
      const to = Date.now();
      const from = to - hours * 3_600_000;
      const events: RawEvent[] = [];
      let truncated = false;
      for (let page = 0; ; page++) {
        const j = await this.request<{ data?: RawEvent[]; total_page_count?: number }>(
          'POST',
          `/proxy/network/v2/api/site/${encodeURIComponent(this.cfg.site)}/system-log/all`,
          { timestampFrom: from, timestampTo: to, pageNumber: page, pageSize: EVENT_PAGE_SIZE },
        );
        if (!Array.isArray(j.data)) throw new UnifiError('system-log/all: no data array in response');
        events.push(...j.data);
        const pages = j.total_page_count ?? 0;
        if (page + 1 >= pages) break;
        if (page + 1 >= EVENT_MAX_PAGES) {
          truncated = true;
          break;
        }
      }
      return { events, truncated };
    });
  }

  /**
   * Everything the controller knows about one machine, captured now. Errors
   * are returned as `{error}`, not thrown: a report must still be stored when
   * the controller is down, and the snapshot then says so.
   */
  async snapshot(opts: { macs: string[]; ip: string | null; since?: Date }): Promise<UnifiSnapshot> {
    const fetchedAt = new Date().toISOString();
    try {
      const [clients, devices] = await Promise.all([this.clients(), this.devices()]);
      const found = findClient(clients, opts.macs, opts.ip);
      if (!found)
        return {
          fetchedAt,
          matchedBy: null,
          client: null,
          reason: `no connected client matches ${[...opts.macs, opts.ip].filter(Boolean).join(', ') || 'nothing (no MAC or IP to match)'}`,
          events: [],
          eventsTruncated: false,
        };

      const client = clientView(found.client);
      const dev = client.apMac ? devices.find((d) => d.mac === client.apMac) : undefined;
      const ap = dev ? apView(dev) : undefined;
      const radio = ap?.radios.find((r) => r.radio === client.radio);

      // Look back from whichever is earlier: the report's collection time (a
      // report saved offline and uploaded later) or a day ago, capped at 3 days.
      const since = opts.since ? Math.min(opts.since.getTime(), Date.now() - 86_400_000) : Date.now() - 86_400_000;
      const hours = Math.min(72, Math.ceil((Date.now() - since) / 3_600_000) + 1);
      const { events, truncated } = await this.events(hours);
      const mac = normalizeMac(client.mac);
      const mine = events
        .filter((e) => eventMac(e) === mac)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 50)
        .map(renderEvent);

      return strip({
        fetchedAt,
        matchedBy: found.matchedBy,
        client,
        ap,
        radio,
        events: mine,
        eventsTruncated: truncated,
      });
    } catch (e) {
      return { fetchedAt, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
