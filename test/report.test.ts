import { describe, expect, test } from 'bun:test';
import { LIMITS, normalizeMac, parseReport, ReportError, reportedMacs, worstStatus } from '../src/report.ts';
import { diagnosticReport, LAPTOP_MAC } from './helpers.ts';

describe('parseReport', () => {
  test('accepts a diagnostic report and normalizes PowerShell-isms', () => {
    const p = parseReport(diagnosticReport());
    if (p.kind !== 'diagnostic') throw new Error('kind');
    // "-71" (string) → -71; a scalar ipv4 → one-element list.
    expect(p.wifi?.rssi).toBe(-71);
    expect(p.interfaces?.[0]?.ipv4).toEqual(['10.0.0.11']);
    expect(p.checks).toHaveLength(2);
  });

  test('null optional fields are dropped, not stored as null', () => {
    const p = parseReport(diagnosticReport({ wifi: { ssid: null, rssi: null, band: '5 GHz' } }));
    if (p.kind !== 'diagnostic') throw new Error('kind');
    expect(p.wifi).toEqual({ band: '5 GHz' });
  });

  test('a single check object (ConvertTo-Json flattening) is accepted as a list', () => {
    const p = parseReport(diagnosticReport({ checks: { id: 'a', title: 'A', status: 'ok' } }));
    if (p.kind !== 'diagnostic') throw new Error('kind');
    expect(p.checks).toHaveLength(1);
  });

  test.each([
    [{ schema: 2 }, 'schema'],
    [{ kind: 'nope' }, 'kind'],
    [{ checks: [{ id: 'a', title: 'A', status: 'great' }] }, 'checks[0].status'],
    [{ host: { platform: 'amiga' } }, 'host.platform'],
    [{ collectedAt: 'yesterday' }, 'collectedAt'],
    [{ wifi: { rssi: 'strong' } }, 'wifi.rssi'],
    [{ raw: { big: 'x'.repeat(LIMITS.rawSection + 1) } }, 'raw'],
  ])('rejects %j naming %s', (over, path) => {
    expect(() => parseReport(diagnosticReport(over))).toThrow(ReportError);
    expect(() => parseReport(diagnosticReport(over))).toThrow(path);
  });

  test('speedtest reports need at least one result', () => {
    const base = { schema: 1, kind: 'speedtest', collectedAt: new Date().toISOString(), mode: 'parallel' };
    expect(() => parseReport({ ...base, results: [] })).toThrow('results is empty');
    const p = parseReport({ ...base, results: [{ target: 'lan', name: 'LAN', downMbps: 400 }] });
    expect(worstStatus(p)).toBe('ok');
  });
});

describe('derived fields', () => {
  test('worstStatus picks the most severe check', () => {
    expect(worstStatus(parseReport(diagnosticReport()))).toBe('warn');
    const failing = diagnosticReport({
      checks: [
        { id: 'a', title: 'A', status: 'info' },
        { id: 'b', title: 'B', status: 'fail' },
        { id: 'c', title: 'C', status: 'error' },
      ],
    });
    expect(worstStatus(parseReport(failing))).toBe('fail');
  });

  test('reportedMacs normalizes and dedupes', () => {
    expect(reportedMacs(parseReport(diagnosticReport()))).toEqual([LAPTOP_MAC]);
  });

  test('normalizeMac', () => {
    expect(normalizeMac('AA-BB-CC-DD-EE-FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('aabb.ccdd.eeff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('00:00:00:00:00:00')).toBeNull();
    expect(normalizeMac('nonsense')).toBeNull();
  });
});
