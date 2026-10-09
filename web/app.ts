import type { StoredReport } from '../src/db.ts';
import type { Check, SpeedtestPayload } from '../src/report.ts';
import type { UnifiSnapshot } from '../src/unifi.ts';
import { runSpeedTest, type Progress, type Result, type Target } from './speedtest.ts';

interface AppConfig {
  version: string;
  baseUrl: string;
  unifi: boolean;
  targets: Target[];
}

// ── Tiny DOM helper ─────────────────────────────────────────────────────────

type Child = Node | string | number | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const c of children)
    if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const fmt = (n: number | undefined, unit: string, digits = 0) =>
  n === undefined || Number.isNaN(n) ? '—' : `${n.toFixed(digits)} ${unit}`;

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

function copyButton(text: string) {
  const b = h(
    'button',
    {
      type: 'button',
      onclick: async () => {
        await navigator.clipboard?.writeText(text).catch(() => {});
        b.textContent = 'Copied';
        setTimeout(() => (b.textContent = 'Copy'), 1500);
      },
    },
    'Copy',
  );
  // navigator.clipboard needs a secure context; on plain http, select instead.
  if (!window.isSecureContext)
    b.onclick = () => {
      const code = b.previousElementSibling as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(code);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      document.execCommand('copy');
      b.textContent = 'Copied';
      setTimeout(() => (b.textContent = 'Copy'), 1500);
    };
  return b;
}

// ── UniFi view ──────────────────────────────────────────────────────────────

function signalWord(dbm?: number) {
  if (dbm === undefined) return '';
  if (dbm >= -65) return ' (good)';
  if (dbm >= -75) return ' (fair)';
  return ' (weak)';
}

function unifiView(s: UnifiSnapshot | null, enabled: boolean): HTMLElement {
  if (!enabled) return h('p', { class: 'muted' }, 'Network controller lookup is not enabled on this server.');
  if (!s) return h('p', { class: 'muted' }, 'No network controller data.');
  if ('error' in s) return h('p', { class: 's-error' }, `Couldn't reach the network controller: ${s.error}`);
  const c = s.client;
  if (!c) return h('p', { class: 'muted' }, `The network controller doesn't see this device right now (${s.reason}).`);
  const rows: [string, Child][] = c.wired
    ? [
        ['Connection', 'Wired'],
        ['Switch', c.uplinkName],
        ['Network', c.network],
        ['IP', c.ip],
      ]
    : [
        ['Network (SSID)', c.ssid],
        ['Access point', s.ap ? `${s.ap.name ?? s.ap.mac}${s.ap.model ? ` (${s.ap.model})` : ''}` : c.apMac],
        [
          'Band / channel',
          `${c.band ?? '?'}, channel ${c.channel ?? '?'}${c.channelWidth ? `, ${c.channelWidth} MHz` : ''}`,
        ],
        ['Signal', c.signal !== undefined ? `${c.signal} dBm${signalWord(c.signal)}` : undefined],
        ['Link rate', `${fmt(c.rxRateMbps, 'Mbps')} down / ${fmt(c.txRateMbps, 'Mbps')} up`],
        ['Retries', c.txRetriesPct !== undefined ? `${c.txRetriesPct.toFixed(1)}% of transmissions` : undefined],
        [
          'Channel busy',
          s.radio?.utilizationPct !== undefined
            ? `${s.radio.utilizationPct}% (${s.radio.clients ?? '?'} devices on this radio)`
            : undefined,
        ],
        ['Experience score', c.satisfaction !== undefined ? `${c.satisfaction}/100` : undefined],
        ['IP', c.ip],
      ];
  return h(
    'div',
    {},
    h(
      'dl',
      { class: 'kv' },
      ...rows.filter(([, v]) => v !== undefined && v !== '').flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]),
    ),
    s.events.length
      ? h(
          'details',
          {},
          h('summary', {}, `${s.events.length} recent connection events`),
          h(
            'ul',
            {},
            ...s.events.slice(0, 20).map((e) => h('li', {}, `${new Date(e.at).toLocaleString()}: ${e.message}`)),
          ),
        )
      : null,
  );
}

// ── Speed test card ─────────────────────────────────────────────────────────

function speedCard(cfg: AppConfig): HTMLElement {
  const enabled = new Set(cfg.targets.map((t) => t.id));
  const rows = new Map<string, { tr: HTMLTableRowElement; bar: HTMLDivElement }>();
  const phaseText: Record<Progress['phase'], string> = {
    ping: 'measuring latency…',
    download: 'download…',
    upload: 'upload…',
    done: 'done',
    error: 'error',
  };

  const table = h(
    'table',
    { class: 'results' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', {}, 'Target'),
        h('th', {}, 'Ping'),
        h('th', {}, 'Jitter'),
        h('th', {}, 'Under load'),
        h('th', {}, 'Download'),
        h('th', {}, 'Upload'),
      ),
    ),
  );
  const tbody = h('tbody', {});
  table.append(tbody);

  function render(id: string, r: Result, phase?: Progress['phase'], live?: number, fraction?: number) {
    const row = rows.get(id)!;
    const cell = (v: Child) => h('td', {}, v);
    const liveCell = (p: 'download' | 'upload', final?: number) =>
      phase === p && live !== undefined
        ? cell(h('span', { class: 'muted' }, fmt(live, 'Mbps')))
        : cell(fmt(final, 'Mbps'));
    const name = h(
      'td',
      {},
      r.name,
      phase && phase !== 'done' ? h('div', { class: 'phase muted' }, r.error ?? phaseText[phase]) : null,
    );
    if (r.error) name.append(h('div', { class: 's-error' }, r.error));
    row.tr.replaceChildren(
      name,
      cell(fmt(r.pingMs, 'ms', 1)),
      cell(fmt(r.jitterMs, 'ms', 1)),
      cell(fmt(r.loadedPingMs, 'ms', 0)),
      liveCell('download', r.downMbps),
      liveCell('upload', r.upMbps),
    );
    row.bar.style.width = `${Math.round((fraction ?? (phase === 'done' ? 1 : 0)) * 100)}%`;
  }

  const mode = h(
    'select',
    {},
    h('option', { value: 'parallel' }, 'all targets at once'),
    h('option', { value: 'sequential' }, 'one target at a time'),
  );
  const share = h('input', { type: 'checkbox', checked: true });
  const start = h('button', { class: 'primary', type: 'button' }, 'Start test');
  const status = h('p', { class: 'muted' });
  const toggles = cfg.targets.map((t) =>
    h(
      'label',
      {},
      h('input', {
        type: 'checkbox',
        checked: true,
        onchange: (e: Event) => ((e.target as HTMLInputElement).checked ? enabled.add(t.id) : enabled.delete(t.id)),
      }),
      ' ',
      t.name,
    ),
  );

  start.addEventListener('click', async () => {
    const targets = cfg.targets.filter((t) => enabled.has(t.id));
    if (!targets.length) return;
    start.disabled = true;
    status.textContent = 'Running… keep this tab in front; it takes about a minute.';
    tbody.replaceChildren();
    rows.clear();
    for (const t of targets) {
      const tr = h('tr', {});
      const bar = h('div', {});
      rows.set(t.id, { tr, bar });
      tbody.append(tr, h('tr', {}, h('td', { colspan: '6' }, h('div', { class: 'bar' }, bar))));
      render(t.id, { target: t.id, name: t.name });
    }
    const m = mode.value as 'parallel' | 'sequential';
    try {
      const results = await runSpeedTest(targets, {
        mode: m,
        onProgress: (p) => render(p.target, p.result, p.phase, p.mbps, p.fraction),
      });
      status.textContent = 'Done.';
      if (share.checked) {
        const payload: SpeedtestPayload = {
          schema: 1,
          kind: 'speedtest',
          collectedAt: new Date().toISOString(),
          mode: m,
          userAgent: navigator.userAgent,
          connection: connectionInfo(),
          results,
        };
        const r = await getJson<{ code: string; url: string }>('/api/reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        status.replaceChildren(
          'Done. Results shared with the network team as report ',
          h('a', { href: r.url }, r.code),
          '.',
        );
      }
    } catch (e) {
      status.textContent = `Test failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      start.disabled = false;
    }
  });

  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'Speed test'),
    h(
      'p',
      { class: 'muted' },
      "LAN measures this device to the server here (that's your Wi-Fi). Internet measures out to the internet. If LAN is fast and internet is slow, the problem is upstream, not your Wi-Fi.",
    ),
    h('div', { class: 'row' }, ...toggles),
    h(
      'div',
      { class: 'row' },
      start,
      h('label', {}, 'Run ', mode),
      h('label', {}, share, ' Share results with the network team'),
    ),
    h(
      'p',
      { class: 'muted' },
      'Running all targets at once shows whether they compete for the same airtime; one at a time gives each its cleanest number.',
    ),
    status,
    table,
  );
}

function connectionInfo(): SpeedtestPayload['connection'] {
  const c = (navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number; rtt?: number } })
    .connection;
  return c ? { effectiveType: c.effectiveType, downlinkMbps: c.downlink, rttMs: c.rtt } : undefined;
}

// ── Diagnostic card ─────────────────────────────────────────────────────────

function guessOs(): 'windows' | 'macos' | 'linux' {
  const p = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('mac')) return 'macos';
  return 'linux';
}

function diagCard(cfg: AppConfig): HTMLElement {
  const base = cfg.baseUrl;
  const panes = {
    windows: h(
      'div',
      {},
      h('p', {}, 'Open ', h('b', {}, 'PowerShell'), ' (Start menu → type "PowerShell") and paste:'),
      h('div', { class: 'oneliner' }, h('code', {}, `irm ${base}/ps1 | iex`), copyButton(`irm ${base}/ps1 | iex`)),
      h(
        'p',
        {},
        'Or download ',
        h('a', { href: '/download/wifi-check.cmd', download: 'wifi-check.cmd' }, 'wifi-check.cmd'),
        ' and double-click it. Keep it: it still runs when the network is down, and saves its report to upload later.',
      ),
    ),
    macos: h(
      'div',
      {},
      h('p', {}, 'Open ', h('b', {}, 'Terminal'), ' and paste:'),
      h(
        'div',
        { class: 'oneliner' },
        h('code', {}, `curl -fsSL ${base}/sh | sh`),
        copyButton(`curl -fsSL ${base}/sh | sh`),
      ),
      h(
        'p',
        {},
        'Or download ',
        h('a', { href: '/download/wifi-check.sh', download: 'wifi-check.sh' }, 'wifi-check.sh'),
        ' and run ',
        h('code', {}, 'sh ~/Downloads/wifi-check.sh'),
        '.',
      ),
    ),
    linux: h(
      'div',
      {},
      h('p', {}, 'In a terminal:'),
      h(
        'div',
        { class: 'oneliner' },
        h('code', {}, `curl -fsSL ${base}/sh | sh`),
        copyButton(`curl -fsSL ${base}/sh | sh`),
      ),
      h(
        'p',
        {},
        'Or download ',
        h('a', { href: '/download/wifi-check.sh', download: 'wifi-check.sh' }, 'wifi-check.sh'),
        ' and run ',
        h('code', {}, 'sh wifi-check.sh'),
        '.',
      ),
    ),
  };
  const labels = { windows: 'Windows', macos: 'macOS', linux: 'Linux' } as const;
  const holder = h('div', {});
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const select = (os: keyof typeof panes) => {
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.getAttribute('data-os') === os));
    holder.replaceChildren(panes[os]);
  };
  for (const os of Object.keys(panes) as (keyof typeof panes)[])
    tabs.append(h('button', { type: 'button', role: 'tab', 'data-os': os, onclick: () => select(os) }, labels[os]));
  select(guessOs());

  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'Check this computer'),
    h(
      'p',
      {},
      "A small script looks at this computer's Wi-Fi and network settings, tells you what looks wrong, and sends a report to the network team. It only reads: ",
      h('b', {}, 'it changes nothing on your computer'),
      ". It asks before sending, and you can add a note about what's going wrong.",
    ),
    tabs,
    holder,
  );
}

function uploadCard(): HTMLElement {
  const status = h('p', { class: 'muted' });
  const input = h('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      const r = await getJson<{ code: string; url: string }>('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: await f.text(),
      });
      status.replaceChildren('Uploaded as report ', h('a', { href: r.url }, r.code), '.');
    } catch (e) {
      status.textContent = `Upload failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  });
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, 'Upload a saved report'),
    h(
      'p',
      { class: 'muted' },
      "If the script couldn't reach this server, it saved a wifi-check-….json file (it tells you where). Upload it here once you're back online.",
    ),
    input,
    status,
  );
}

// ── Report page (/r/<id>) ───────────────────────────────────────────────────

function checkItem(c: Check): HTMLElement {
  return h(
    'li',
    {},
    h('span', { class: `badge s-${c.status}` }, c.status),
    h('b', {}, c.title),
    c.detail ? h('div', {}, c.detail) : null,
    c.advice ? h('div', { class: 'advice' }, c.advice) : null,
  );
}

async function reportPage(id: string, cfg: AppConfig, root: HTMLElement) {
  const r = await getJson<StoredReport>(`/api/reports/${encodeURIComponent(id)}`);
  const p = r.payload;
  const head = h(
    'section',
    { class: 'card' },
    h('h2', {}, `Report ${r.code}`),
    h(
      'dl',
      { class: 'kv' },
      h('dt', {}, 'Received'),
      h('dd', {}, new Date(r.createdAt).toLocaleString()),
      h('dt', {}, 'Kind'),
      h('dd', {}, r.kind),
      r.hostname ? h('dt', {}, 'Computer') : null,
      r.hostname ? h('dd', {}, r.hostname) : null,
      h('dt', {}, 'Status'),
      h('dd', {}, r.status === 'new' ? 'waiting for the network team' : r.status),
    ),
    r.description ? h('p', { class: 'notice' }, r.description) : null,
    ...r.notes.map((n) => h('p', { class: 'notice' }, h('b', {}, `${n.by}: `), n.note)),
  );
  const body: HTMLElement[] = [head];
  if (p.kind === 'diagnostic') {
    body.push(
      h(
        'section',
        { class: 'card' },
        h('h2', {}, 'What the check found'),
        h('ul', { class: 'checks' }, ...p.checks.map(checkItem)),
      ),
    );
    if (p.raw && Object.keys(p.raw).length)
      body.push(
        h(
          'section',
          { class: 'card' },
          h('h2', {}, 'Raw output'),
          ...Object.entries(p.raw).map(([k, v]) => h('details', {}, h('summary', {}, k), h('pre', {}, v))),
        ),
      );
  } else {
    body.push(
      h(
        'section',
        { class: 'card' },
        h('h2', {}, 'Speed test'),
        h(
          'table',
          { class: 'results' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', {}, 'Target'),
              h('th', {}, 'Ping'),
              h('th', {}, 'Jitter'),
              h('th', {}, 'Under load'),
              h('th', {}, 'Download'),
              h('th', {}, 'Upload'),
            ),
          ),
          h(
            'tbody',
            {},
            ...p.results.map((x) =>
              h(
                'tr',
                {},
                h('td', {}, x.name, x.error ? h('div', { class: 's-error' }, x.error) : null),
                h('td', {}, fmt(x.pingMs, 'ms', 1)),
                h('td', {}, fmt(x.jitterMs, 'ms', 1)),
                h('td', {}, fmt(x.loadedPingMs, 'ms')),
                h('td', {}, fmt(x.downMbps, 'Mbps')),
                h('td', {}, fmt(x.upMbps, 'Mbps')),
              ),
            ),
          ),
        ),
      ),
    );
  }
  body.push(h('section', { class: 'card' }, h('h2', {}, 'What the network saw'), unifiView(r.unifi, cfg.unifi)));
  body.push(h('p', {}, h('a', { href: '/' }, '← Back to the Wi-Fi check')));
  root.replaceChildren(...body);
}

// ── Boot ────────────────────────────────────────────────────────────────────

async function main() {
  const root = document.getElementById('app')!;
  const cfg = await getJson<AppConfig>('/api/config');
  document
    .getElementById('footer')!
    .replaceChildren(`build ${cfg.version} · `, h('a', { href: '/llms.txt' }, 'API for agents'));

  const m = /^\/r\/([a-z0-9]+)$/.exec(location.pathname);
  if (m) return reportPage(m[1]!, cfg, root);

  const seen = h(
    'section',
    { class: 'card' },
    h('h2', {}, 'What the network sees for this device'),
    h('p', { class: 'muted' }, 'Looking…'),
  );
  root.replaceChildren(speedCard(cfg), seen, diagCard(cfg), uploadCard());
  try {
    const who = await getJson<{ ip: string; unifi: UnifiSnapshot | null }>('/api/whoami');
    seen.replaceChildren(
      h('h2', {}, 'What the network sees for this device'),
      unifiView(who.unifi, cfg.unifi),
      h('p', { class: 'muted' }, `Your address as seen by this server: ${who.ip}`),
    );
  } catch (e) {
    seen.replaceChildren(h('h2', {}, 'What the network sees for this device'), h('p', { class: 's-error' }, String(e)));
  }
}

main().catch((e) => {
  document
    .getElementById('app')!
    .replaceChildren(h('p', { class: 's-error' }, `Failed to load: ${e instanceof Error ? e.message : String(e)}`));
});
