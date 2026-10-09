/**
 * Runtime configuration, all from the environment.
 *
 * Deployment-specific values (names, URLs, SSIDs) have no defaults: the
 * deployment's compose file is where they are declared, and a missing one is
 * an error at boot rather than a quietly wrong instance.
 */

export interface UnifiConfig {
  /** Controller base URL, e.g. https://unifi.example.com */
  host: string;
  /** Site internal reference (the `s/<site>` path segment), e.g. "default" */
  site: string;
  apiKey: string;
}

export interface Config {
  port: number;
  /** Bind address. Inside a container this is 0.0.0.0; compose maps it to loopback. */
  hostname: string;
  databasePath: string;
  /**
   * Every URL this instance is reachable at. The first is canonical: it is
   * baked into the diagnostic scripts unless the request arrived on another
   * listed one, in which case that one is used (so an https name, once added,
   * serves scripts that report back over https).
   */
  publicBaseUrls: string[];
  /** Bearer token for the agent API (list/stream/triage). */
  agentToken: string;
  /**
   * Trust X-Real-IP / X-Forwarded-For from the proxy. Only safe when the app
   * port is reachable solely through that proxy (loopback-bound behind Caddy).
   */
  trustProxy: boolean;
  /** null only when UNIFI_ENABLED=false was set explicitly. */
  unifi: UnifiConfig | null;
  /** LibreSpeed backend base URL offered as an extra internet target, or null. */
  librespeedUrl: string | null;
  /** SSIDs that belong to this site; joining anything else is flagged. */
  knownSsids: string[];
  /** Short build id shown in the UI and stamped into scripts. */
  buildSha: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name];
  if (v === undefined || v.trim() === '') throw new ConfigError(`${name} is required`);
  return v.trim();
}

function bool(env: Env, name: string): boolean {
  const v = required(env, name).toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new ConfigError(`${name} must be true or false, got ${JSON.stringify(v)}`);
}

function url(name: string, value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new ConfigError(`${name}: ${JSON.stringify(value)} is not a URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigError(`${name}: must be http(s)`);
  if (u.pathname !== '/' || u.search || u.hash) throw new ConfigError(`${name}: must be an origin with no path`);
  return u.origin;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: Env, buildSha = 'dev'): Config {
  const portRaw = required(env, 'PORT');
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new ConfigError(`PORT is not a port: ${portRaw}`);

  const publicBaseUrls = list(required(env, 'PUBLIC_BASE_URLS')).map((u, i) => url(`PUBLIC_BASE_URLS[${i}]`, u));
  if (publicBaseUrls.length === 0) throw new ConfigError('PUBLIC_BASE_URLS lists no URLs');

  const agentToken = required(env, 'AGENT_TOKEN');
  if (agentToken.length < 24) throw new ConfigError('AGENT_TOKEN must be at least 24 characters');

  let unifi: UnifiConfig | null = null;
  if (bool(env, 'UNIFI_ENABLED')) {
    unifi = {
      host: url('UNIFI_HOST', required(env, 'UNIFI_HOST')),
      site: required(env, 'UNIFI_SITE'),
      apiKey: required(env, 'UNIFI_API_KEY'),
    };
  }

  // Explicitly empty means "not offered"; absent is a mistake.
  if (env.LIBRESPEED_URL === undefined) throw new ConfigError('LIBRESPEED_URL must be set (empty to disable)');
  const librespeedUrl = env.LIBRESPEED_URL.trim() ? url('LIBRESPEED_URL', env.LIBRESPEED_URL.trim()) : null;

  if (env.KNOWN_SSIDS === undefined) throw new ConfigError('KNOWN_SSIDS must be set (empty to skip the SSID check)');

  return {
    port,
    hostname: env.HOST?.trim() || '0.0.0.0',
    databasePath: required(env, 'DATABASE_PATH'),
    publicBaseUrls,
    agentToken,
    trustProxy: bool(env, 'TRUST_PROXY'),
    unifi,
    librespeedUrl,
    knownSsids: list(env.KNOWN_SSIDS),
    buildSha,
  };
}
