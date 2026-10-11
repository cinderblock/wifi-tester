import type { Config } from '../src/config.ts';
import type { RawClient, RawDevice, RawEvent } from '../src/unifi.ts';

export const AGENT_TOKEN = 'test-agent-token-0123456789abcdef';

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    port: 0,
    hostname: '127.0.0.1',
    databasePath: ':memory:',
    publicBaseUrls: ['http://wifi.test', 'https://wifi.example.com'],
    agentToken: AGENT_TOKEN,
    trustProxy: true,
    unifi: { host: 'https://unifi.test', site: 'default', apiKey: 'k' },
    librespeedUrl: null,
    knownSsids: ['Office', "Bob's Wi-Fi"],
    buildSha: 'test',
    ...over,
  };
}

// Synthetic controller data. Locally administered MACs (x2:...), test-net IPs.
export const AP_MAC = '02:00:00:00:a0:01';
export const LAPTOP_MAC = '02:00:00:00:00:11';

export const clients: RawClient[] = [
  {
    mac: LAPTOP_MAC,
    hostname: 'laptop',
    ip: '10.0.0.11',
    is_wired: false,
    essid: 'Office',
    ap_mac: AP_MAC,
    radio: 'ng',
    radio_proto: 'ax',
    channel: 6,
    signal: -71,
    tx_rate: 72000,
    rx_rate: 65000,
    wifi_tx_retries_percentage: 18.5,
    satisfaction: 62,
  },
  { mac: '02:00:00:00:00:22', hostname: 'desk', ip: '10.0.0.22', is_wired: true, last_uplink_name: 'Switch 1' },
  {
    mac: '02:00:00:00:00:33',
    ip: '10.0.0.33',
    ipv6_addresses: ['2001:db8::33'],
    is_wired: false,
    ap_mac: AP_MAC,
    radio: 'na',
  },
];

export const devices: RawDevice[] = [
  {
    mac: AP_MAC,
    name: 'AP West',
    model: 'U7PRO',
    type: 'uap',
    state: 1,
    radio_table_stats: [
      { radio: 'ng', channel: 6, bw: 20, cu_total: 73, cu_self_rx: 10, cu_self_tx: 12, num_sta: 14 },
      { radio: 'na', channel: 44, bw: 80, cu_total: 21, num_sta: 9 },
    ],
    vap_table: [
      { essid: 'Office', radio: '6e', up: true },
      { essid: 'Office', radio: 'ng', up: true },
      { essid: 'Office', radio: 'na', up: true },
      { essid: 'Office Legacy', radio: 'na', up: true },
      { essid: 'Office Legacy', radio: 'ng', up: true },
      { essid: 'Off Air', radio: 'na', up: false },
    ],
  },
  {
    // An offline AP's VAPs must not count.
    mac: '02:00:00:00:a0:02',
    name: 'AP Dead',
    type: 'uap',
    state: 0,
    vap_table: [{ essid: 'Ghost', radio: 'na', up: true }],
  },
  { mac: '02:00:00:00:b0:01', name: 'Switch 1', type: 'usw', state: 1 },
];

export const events: RawEvent[] = [
  {
    id: 'e1',
    key: 'CLIENT_ROAMED_2',
    timestamp: Date.now() - 60_000,
    message_raw: '{CLIENT} roamed from {DEVICE_FROM} to {DEVICE_TO}.',
    parameters: {
      CLIENT: { id: LAPTOP_MAC, name: 'laptop' },
      DEVICE_FROM: { id: 'x', name: 'AP East' },
      DEVICE_TO: { id: AP_MAC, name: 'AP West' },
    },
  },
  {
    id: 'e2',
    key: 'CLIENT_CONNECTED_WIRELESS_2',
    timestamp: Date.now() - 120_000,
    message_raw: '{CLIENT} connected.',
    parameters: { CLIENT: { id: '02:00:00:00:00:33', name: 'other' } },
  },
];

/** A fetch stand-in for the controller. Records every request it served. */
export function fakeController(opts: { fail?: boolean } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (opts.fail) return new Response('bad gateway', { status: 502 });
    if (url.pathname.endsWith('/stat/sta')) return Response.json({ meta: { rc: 'ok' }, data: clients });
    if (url.pathname.endsWith('/stat/device')) return Response.json({ meta: { rc: 'ok' }, data: devices });
    if (url.pathname.endsWith('/system-log/all'))
      return Response.json({ data: events, page_number: 0, total_page_count: 1, total_element_count: events.length });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

export function diagnosticReport(over: Record<string, unknown> = {}) {
  return {
    schema: 1,
    kind: 'diagnostic',
    tool: { name: 'wifi-check.ps1', version: 'test' },
    collectedAt: new Date().toISOString(),
    host: { hostname: 'LAPTOP', platform: 'windows', os: 'Windows 11' },
    wifi: { ssid: 'Office', mac: LAPTOP_MAC.toUpperCase().replace(/:/g, '-'), rssi: '-71', band: '2.4 GHz' },
    interfaces: [{ name: 'Wi-Fi', mac: LAPTOP_MAC, ipv4: '10.0.0.11', gateway: ['10.0.0.1'], dhcp: true }],
    checks: [
      { id: 'wifi.signal', title: 'Signal', status: 'warn', detail: '-71 dBm' },
      { id: 'ip.address', title: 'IP', status: 'ok' },
    ],
    raw: { 'ipconfig /all': 'Windows IP Configuration' },
    ...over,
  };
}
