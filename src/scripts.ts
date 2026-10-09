/**
 * Serves the diagnostic scripts with this instance's settings baked in.
 *
 * The templates in scripts/ carry placeholders; nothing in them is specific to
 * one deployment. Values are quoted for the target language here, so no SSID
 * (which can contain anything) can break out of its string.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';

const SCRIPTS_DIR = join(import.meta.dir, '..', 'scripts');

export interface ScriptSet {
  ps1: string;
  sh: string;
  cmd: string;
}

/** PowerShell single-quoted literal: only ' needs escaping (as ''). */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** POSIX sh single-quoted literal: close, escaped quote, reopen. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function substitute(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(values)) {
    if (!out.includes(k)) throw new Error(`script template is missing placeholder ${k}`);
    out = out.split(k).join(v);
  }
  const leftover = out.match(/__WIFI_[A-Z0-9_]+__/);
  if (leftover) throw new Error(`script template has an unfilled placeholder ${leftover[0]}`);
  return out;
}

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const crlf = (s: string) => lf(s).replace(/\n/g, '\r\n');

export function loadTemplates(dir = SCRIPTS_DIR): { ps1: string; sh: string } {
  return {
    ps1: readFileSync(join(dir, 'wifi-check.ps1'), 'utf8'),
    sh: readFileSync(join(dir, 'wifi-check.sh'), 'utf8'),
  };
}

/**
 * A .cmd that is also a PowerShell script, so a Windows user can double-click
 * one downloaded file, and run it again later even with the network down.
 * cmd.exe reads line 1 (`<# :`) as a no-op redirect + label and runs the batch
 * part; PowerShell reads `<# ... #>` as a block comment and runs the rest.
 * -ExecutionPolicy Bypass applies to this one process only; nothing on the
 * machine changes.
 */
function cmdWrapper(ps1: string): string {
  const header = [
    '<# :',
    '@echo off',
    'setlocal',
    'set "WIFI_CHECK_SELF=%~f0"',
    'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "& ([ScriptBlock]::Create([IO.File]::ReadAllText($env:WIFI_CHECK_SELF)))"',
    'echo.',
    'pause',
    'exit /b',
    '#>',
    '',
  ].join('\n');
  return crlf(header + lf(ps1));
}

export function renderScripts(
  templates: { ps1: string; sh: string },
  cfg: Pick<Config, 'publicBaseUrls' | 'knownSsids' | 'buildSha'>,
  baseUrl: string,
): ScriptSet {
  const fallbacks = cfg.publicBaseUrls.filter((u) => u !== baseUrl);
  const ps1 = substitute(templates.ps1, {
    __WIFI_BASE_URL__: psQuote(baseUrl),
    __WIFI_FALLBACK_URLS__: fallbacks.length ? fallbacks.map(psQuote).join(', ') : '',
    __WIFI_KNOWN_SSIDS__: cfg.knownSsids.length ? cfg.knownSsids.map(psQuote).join(', ') : '',
    __WIFI_VERSION__: psQuote(cfg.buildSha),
  });
  const sh = substitute(templates.sh, {
    __WIFI_BASE_URL__: shQuote(baseUrl),
    __WIFI_FALLBACK_URLS__: shQuote(fallbacks.join(' ')),
    // Newline-separated: the one character an SSID can't usefully contain.
    __WIFI_KNOWN_SSIDS__: shQuote(cfg.knownSsids.join('\n')),
    __WIFI_VERSION__: shQuote(cfg.buildSha),
  });
  return { ps1: crlf(ps1), sh: lf(sh), cmd: cmdWrapper(ps1) };
}

/** Which of our public URLs this request came in on, else the canonical one. */
export function requestBaseUrl(req: Request, cfg: Pick<Config, 'publicBaseUrls'>, trustProxy: boolean): string {
  const host = req.headers.get('host');
  const url = new URL(req.url);
  const proto = (trustProxy && req.headers.get('x-forwarded-proto')) || url.protocol.replace(':', '');
  if (host) {
    const origin = `${proto}://${host}`.toLowerCase();
    const match = cfg.publicBaseUrls.find((u) => u.toLowerCase() === origin);
    if (match) return match;
  }
  return cfg.publicBaseUrls[0]!;
}
