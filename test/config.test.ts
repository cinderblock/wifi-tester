import { describe, expect, test } from 'bun:test';
import { ConfigError, loadConfig } from '../src/config.ts';

const base = {
  PORT: '3000',
  DATABASE_PATH: '/data/wifi.db',
  PUBLIC_BASE_URLS: 'http://wifi.tsl, https://wifi.example.com',
  AGENT_TOKEN: 'x'.repeat(32),
  TRUST_PROXY: 'true',
  UNIFI_ENABLED: 'true',
  UNIFI_HOST: 'https://unifi.example.com',
  UNIFI_SITE: 'default',
  UNIFI_API_KEY: 'key',
  LIBRESPEED_URL: '',
  KNOWN_SSIDS: 'Office, Guest',
};

describe('loadConfig', () => {
  test('parses a complete environment', () => {
    const c = loadConfig(base, 'abc');
    expect(c.publicBaseUrls).toEqual(['http://wifi.tsl', 'https://wifi.example.com']);
    expect(c.unifi).toEqual({ host: 'https://unifi.example.com', site: 'default', apiKey: 'key' });
    expect(c.librespeedUrl).toBeNull();
    expect(c.knownSsids).toEqual(['Office', 'Guest']);
    expect(c.trustProxy).toBe(true);
    expect(c.buildSha).toBe('abc');
  });

  test.each(['PORT', 'DATABASE_PATH', 'PUBLIC_BASE_URLS', 'AGENT_TOKEN', 'TRUST_PROXY', 'UNIFI_ENABLED'])(
    'missing %s is an error',
    (k) => {
      const env: Record<string, string | undefined> = { ...base, [k]: undefined };
      expect(() => loadConfig(env)).toThrow(ConfigError);
    },
  );

  test('UniFi settings are required only when enabled', () => {
    expect(() => loadConfig({ ...base, UNIFI_API_KEY: '' })).toThrow('UNIFI_API_KEY');
    const off = loadConfig({ ...base, UNIFI_ENABLED: 'false', UNIFI_HOST: undefined, UNIFI_API_KEY: undefined });
    expect(off.unifi).toBeNull();
  });

  test('absent LIBRESPEED_URL / KNOWN_SSIDS is an error; empty is a choice', () => {
    expect(() => loadConfig({ ...base, LIBRESPEED_URL: undefined })).toThrow('LIBRESPEED_URL');
    expect(() => loadConfig({ ...base, KNOWN_SSIDS: undefined })).toThrow('KNOWN_SSIDS');
    expect(loadConfig({ ...base, KNOWN_SSIDS: '' }).knownSsids).toEqual([]);
  });

  test('base URLs must be bare origins', () => {
    expect(() => loadConfig({ ...base, PUBLIC_BASE_URLS: 'http://wifi.tsl/app' })).toThrow('origin');
    expect(() => loadConfig({ ...base, PUBLIC_BASE_URLS: 'ftp://wifi.tsl' })).toThrow('http');
    expect(loadConfig({ ...base, PUBLIC_BASE_URLS: 'http://wifi.tsl/' }).publicBaseUrls).toEqual(['http://wifi.tsl']);
  });

  test('short agent tokens are refused', () => {
    expect(() => loadConfig({ ...base, AGENT_TOKEN: 'short' })).toThrow('24');
  });

  test('booleans are strict', () => {
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'yes' })).toThrow('true or false');
  });
});
