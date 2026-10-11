/**
 * The band advice lives inside the diagnostic scripts, once in PowerShell and
 * once in sh. Each script marks it as a pure "band-verdict" region; this test
 * cuts that region out and runs both versions against the same cases, so the
 * two can't drift apart.
 *
 * Needs a PowerShell (pwsh, or Windows PowerShell) and an sh. GitHub's Ubuntu
 * runners have both; a machine without one reports that test as skipped.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(import.meta.dir, '..', 'scripts');

function region(file: string): string {
  const text = readFileSync(join(SCRIPTS, file), 'utf8').replace(/\r\n/g, '\n');
  const m = /^# region band-verdict.*\n([\s\S]*?)^# endregion band-verdict/m.exec(text);
  if (!m) throw new Error(`${file} has no band-verdict region`);
  return m[1]!;
}

const SSIDS = { Office: ['2.4 GHz', '5 GHz', '6 GHz'], 'Office Legacy': ['2.4 GHz', '5 GHz'] };
const KNOWN = ['Office', 'Office Legacy'];

interface Case {
  name: string;
  current: string;
  device: string[];
  ssid: string;
  /** null: the controller's list is unavailable. */
  ssids: Record<string, string[]> | null;
  status: string | null;
  detail?: RegExp;
}

const CASES: Case[] = [
  {
    name: '2.4 on a 6E laptop',
    current: '2.4 GHz',
    device: ['2.4 GHz', '5 GHz', '6 GHz'],
    ssid: 'Office',
    ssids: SSIDS,
    status: 'warn',
    detail: /both do 6 GHz/,
  },
  {
    name: '2.4 on a 5 GHz laptop',
    current: '2.4 GHz',
    device: ['2.4 GHz', '5 GHz'],
    ssid: 'Office',
    ssids: SSIDS,
    status: 'warn',
    detail: /both do 5 GHz/,
  },
  {
    name: '5 where 6 is possible',
    current: '5 GHz',
    device: ['2.4 GHz', '5 GHz', '6 GHz'],
    ssid: 'Office',
    ssids: SSIDS,
    status: 'info',
    detail: /also do 6 GHz/,
  },
  {
    name: 'SSID without 6, sibling with',
    current: '5 GHz',
    device: ['2.4 GHz', '5 GHz', '6 GHz'],
    ssid: 'Office Legacy',
    ssids: SSIDS,
    status: 'info',
    detail: /"Office" is/,
  },
  {
    name: '5 GHz laptop on 5',
    current: '5 GHz',
    device: ['2.4 GHz', '5 GHz'],
    ssid: 'Office',
    ssids: SSIDS,
    status: 'ok',
  },
  {
    name: '2.4-only adapter',
    current: '2.4 GHz',
    device: ['2.4 GHz'],
    ssid: 'Office',
    ssids: SSIDS,
    status: 'info',
    detail: /only band/,
  },
  {
    name: 'unknown network: never claims 6',
    current: '5 GHz',
    device: ['2.4 GHz', '5 GHz', '6 GHz'],
    ssid: 'Office',
    ssids: null,
    status: 'ok',
  },
  {
    name: 'unknown network: 2.4 still flagged',
    current: '2.4 GHz',
    device: ['2.4 GHz', '5 GHz', '6 GHz'],
    ssid: 'Office',
    ssids: null,
    status: 'warn',
    detail: /both do 5 GHz/,
  },
  {
    name: 'driver list missing the band it is on',
    current: '6 GHz',
    device: ['2.4 GHz'],
    ssid: 'Office',
    ssids: SSIDS,
    status: 'ok',
  },
  { name: 'unknown band', current: '', device: ['2.4 GHz'], ssid: 'Office', ssids: SSIDS, status: null },
];

const RANK: Record<string, number> = { '2.4 GHz': 1, '5 GHz': 2, '6 GHz': 3 };

function check(results: string[]) {
  CASES.forEach((c, i) => {
    const [status, detail] = (results[i] ?? '').split('\t');
    expect({ case: c.name, status: status || null }).toEqual({ case: c.name, status: c.status });
    if (c.detail)
      expect({ case: c.name, detail }).toMatchObject({ case: c.name, detail: expect.stringMatching(c.detail) });
  });
}

const sh = Bun.which('sh');
const ps = Bun.which('pwsh') ?? Bun.which('powershell');

describe('band verdict', () => {
  test.skipIf(!sh)('sh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'band-'));
    try {
      const file = join(dir, 'ssids');
      const script = join(dir, 'v.sh');
      writeFileSync(script, region('wifi-check.sh') + '\nband_verdict "$@"\n');
      const results = CASES.map((c) => {
        writeFileSync(
          file,
          c.ssids
            ? Object.entries(c.ssids)
                .map(([s, b]) => `${b.join(',')}\t${s}\n`)
                .join('')
            : '',
        );
        const ranks = c.device.map((d) => RANK[d]).join(' ');
        const r = Bun.spawnSync([sh!, script, c.current, ranks, c.ssid, file, KNOWN.join('\n')]);
        if (r.exitCode !== 0) throw new Error(`sh failed for ${c.name}: ${r.stderr.toString()}`);
        return r.stdout.toString().trim();
      });
      check(results);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!ps)('PowerShell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'band-'));
    try {
      const script = join(dir, 'v.ps1');
      writeFileSync(
        script,
        region('wifi-check.ps1') +
          `
$cases = $env:BAND_CASES | ConvertFrom-Json
foreach ($c in $cases) {
    $sb = $null
    if ($c.ssids) { $sb = @{}; foreach ($p in $c.ssids.PSObject.Properties) { $sb[$p.Name] = @($p.Value) } }
    $v = Get-BandVerdict $c.current @($c.device) $sb $c.ssid @($c.known)
    if ($v) { Write-Output ($v.status + [char]9 + $v.detail) } else { Write-Output '' }
}
`,
      );
      const input = CASES.map((c) => ({ ...c, detail: undefined, known: KNOWN }));
      const r = Bun.spawnSync([ps!, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        env: { ...process.env, BAND_CASES: JSON.stringify(input) },
      });
      if (r.exitCode !== 0) throw new Error(`PowerShell failed: ${r.stderr.toString()}`);
      check(r.stdout.toString().replace(/\r/g, '').split('\n'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
