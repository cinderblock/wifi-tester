import { describe, expect, test } from 'bun:test';
import { loadTemplates, psQuote, renderScripts, requestBaseUrl, shQuote } from '../src/scripts.ts';
import { testConfig } from './helpers.ts';

const cfg = testConfig();
const templates = loadTemplates();

describe('quoting', () => {
  test('PowerShell', () => {
    expect(psQuote("Bob's")).toBe("'Bob''s'");
  });
  test('sh', () => {
    expect(shQuote("Bob's")).toBe(`'Bob'\\''s'`);
  });
});

describe('renderScripts', () => {
  const s = renderScripts(templates, cfg, cfg.publicBaseUrls[0]!);

  test('fills every placeholder', () => {
    for (const body of [s.ps1, s.sh, s.cmd]) expect(body).not.toMatch(/__WIFI_[A-Z0-9_]+__/);
    expect(s.ps1).toContain("$BaseUrl = 'http://wifi.test'");
    expect(s.ps1).toContain("$FallbackUrls = @('https://wifi.example.com')");
    expect(s.ps1).toContain(`$KnownSsids = @('Office', 'Bob''s Wi-Fi')`);
    expect(s.sh).toContain("BASE_URL='http://wifi.test'");
  });

  test('PowerShell stays ASCII (5.1 reads irm text as Latin-1)', () => {
    const bad = [...s.ps1].findIndex((c) => c.charCodeAt(0) > 127);
    expect(bad === -1 ? null : s.ps1.slice(Math.max(0, bad - 40), bad + 10)).toBeNull();
  });

  test('line endings: sh is LF, cmd is CRLF throughout', () => {
    expect(s.sh).not.toContain('\r');
    expect(s.cmd.replace(/\r\n/g, '')).not.toContain('\n');
    expect(s.cmd.startsWith('<# :\r\n@echo off')).toBe(true);
  });

  test('a hostile SSID cannot escape its string', () => {
    const evil = renderScripts(templates, { ...cfg, knownSsids: [`x'; rm -rf / #`, `$(reboot)`] }, 'http://wifi.test');
    expect(evil.sh).toContain(`KNOWN_SSIDS='x'\\''; rm -rf / #\n$(reboot)'`);
    expect(evil.ps1).toContain(`@('x''; rm -rf / #', '$(reboot)')`);
  });
});

describe('requestBaseUrl', () => {
  const req = (host: string, proto?: string) =>
    new Request('http://127.0.0.1/ps1', { headers: { host, ...(proto ? { 'x-forwarded-proto': proto } : {}) } });

  test('uses the URL the request came in on when it is one of ours', () => {
    expect(requestBaseUrl(req('wifi.example.com', 'https'), cfg, true)).toBe('https://wifi.example.com');
  });

  test('anything else gets the canonical URL', () => {
    expect(requestBaseUrl(req('evil.example'), cfg, true)).toBe('http://wifi.test');
    // Not trusting the proxy: the forwarded proto is ignored.
    expect(requestBaseUrl(req('wifi.example.com', 'https'), cfg, false)).toBe('http://wifi.test');
  });
});
