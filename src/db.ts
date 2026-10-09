import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CheckStatus, ReportPayload } from './report.ts';
import type { UnifiSnapshot } from './unifi.ts';

export const TRIAGE_STATUSES = ['new', 'ack', 'resolved', 'ignored'] as const;
export type TriageStatus = (typeof TRIAGE_STATUSES)[number];

export interface TriageNote {
  at: string;
  by: string;
  note: string;
}

export interface StoredReport {
  /** Unguessable id; knowing it is what lets the submitter view their report. */
  id: string;
  /** Monotonic cursor for agents: "everything after seq N". */
  seq: number;
  /** Short human code, e.g. "K7Q2M9", for saying out loud or in chat. */
  code: string;
  createdAt: string;
  kind: ReportPayload['kind'];
  clientIp: string;
  hostname: string | null;
  platform: string | null;
  ssid: string | null;
  worst: CheckStatus;
  description: string | null;
  status: TriageStatus;
  notes: TriageNote[];
  payload: ReportPayload;
  unifi: UnifiSnapshot | null;
}

export type ReportSummary = Omit<StoredReport, 'payload' | 'unifi'> & {
  /** Just enough UniFi context to triage from a list. */
  unifi: { ap?: string; band?: string; channel?: number; signal?: number; error?: string } | null;
};

interface Row {
  id: string;
  seq: number;
  code: string;
  created_at: string;
  kind: string;
  client_ip: string;
  hostname: string | null;
  platform: string | null;
  ssid: string | null;
  worst: string;
  description: string | null;
  status: string;
  notes: string;
  payload: string;
  unifi: string | null;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE reports (
     seq         INTEGER PRIMARY KEY AUTOINCREMENT,
     id          TEXT NOT NULL UNIQUE,
     code        TEXT NOT NULL,
     created_at  TEXT NOT NULL,
     kind        TEXT NOT NULL,
     client_ip   TEXT NOT NULL,
     hostname    TEXT,
     platform    TEXT,
     ssid        TEXT,
     worst       TEXT NOT NULL,
     description TEXT,
     status      TEXT NOT NULL DEFAULT 'new',
     notes       TEXT NOT NULL DEFAULT '[]',
     payload     TEXT NOT NULL,
     unifi       TEXT
   );
   CREATE INDEX reports_code ON reports(code);
   CREATE INDEX reports_status ON reports(status, seq);`,
];

export interface ListFilter {
  since?: number;
  limit: number;
  status?: TriageStatus;
  kind?: ReportPayload['kind'];
  code?: string;
}

export class ReportStore {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { strict: true, create: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate() {
    const { user_version } = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!;
    if (user_version > MIGRATIONS.length)
      throw new Error(`database is at schema ${user_version}, newer than this build knows (${MIGRATIONS.length})`);
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      })();
    }
  }

  insert(r: Omit<StoredReport, 'seq' | 'status' | 'notes'>): StoredReport {
    const row = this.db
      .query<Row, Record<string, string | null>>(
        `INSERT INTO reports (id, code, created_at, kind, client_ip, hostname, platform, ssid, worst, description, payload, unifi)
         VALUES ($id, $code, $createdAt, $kind, $clientIp, $hostname, $platform, $ssid, $worst, $description, $payload, $unifi)
         RETURNING *`,
      )
      .get({
        id: r.id,
        code: r.code,
        createdAt: r.createdAt,
        kind: r.kind,
        clientIp: r.clientIp,
        hostname: r.hostname,
        platform: r.platform,
        ssid: r.ssid,
        worst: r.worst,
        description: r.description,
        payload: JSON.stringify(r.payload),
        unifi: r.unifi ? JSON.stringify(r.unifi) : null,
      })!;
    return fromRow(row);
  }

  get(id: string): StoredReport | null {
    const row = this.db.query<Row, [string]>('SELECT * FROM reports WHERE id = ?').get(id);
    return row ? fromRow(row) : null;
  }

  list(f: ListFilter): StoredReport[] {
    const where: string[] = [];
    const params: Record<string, string | number> = { limit: f.limit };
    if (f.since !== undefined) {
      where.push('seq > $since');
      params.since = f.since;
    }
    if (f.status) {
      where.push('status = $status');
      params.status = f.status;
    }
    if (f.kind) {
      where.push('kind = $kind');
      params.kind = f.kind;
    }
    if (f.code) {
      where.push('code = $code');
      params.code = f.code.toUpperCase();
    }
    // Without a cursor, the newest page; with one, oldest-first so a follower
    // never skips anything.
    const order = f.since === undefined ? 'DESC' : 'ASC';
    const sql = `SELECT * FROM reports ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq ${order} LIMIT $limit`;
    return this.db.query<Row, typeof params>(sql).all(params).map(fromRow);
  }

  latestSeq(): number {
    return this.db.query<{ s: number | null }, []>('SELECT MAX(seq) AS s FROM reports').get()!.s ?? 0;
  }

  triage(id: string, update: { status?: TriageStatus; note?: TriageNote }): StoredReport | null {
    return this.db.transaction(() => {
      const cur = this.get(id);
      if (!cur) return null;
      const notes = update.note ? [...cur.notes, update.note] : cur.notes;
      this.db
        .query('UPDATE reports SET status = $status, notes = $notes WHERE id = $id')
        .run({ id, status: update.status ?? cur.status, notes: JSON.stringify(notes) });
      return this.get(id);
    })();
  }

  close() {
    this.db.close();
  }
}

function fromRow(r: Row): StoredReport {
  return {
    id: r.id,
    seq: r.seq,
    code: r.code,
    createdAt: r.created_at,
    kind: r.kind as StoredReport['kind'],
    clientIp: r.client_ip,
    hostname: r.hostname,
    platform: r.platform,
    ssid: r.ssid,
    worst: r.worst as CheckStatus,
    description: r.description,
    status: r.status as TriageStatus,
    notes: JSON.parse(r.notes) as TriageNote[],
    payload: JSON.parse(r.payload) as ReportPayload,
    unifi: r.unifi ? (JSON.parse(r.unifi) as UnifiSnapshot) : null,
  };
}

export function summarize(r: StoredReport): ReportSummary {
  const { payload: _payload, unifi, ...rest } = r;
  let u: ReportSummary['unifi'] = null;
  if (unifi) {
    if ('error' in unifi) u = { error: unifi.error };
    else if (unifi.client)
      u = {
        ap: unifi.ap?.name,
        band: unifi.client.radio,
        channel: unifi.client.channel,
        signal: unifi.client.signal,
      };
    else u = { error: unifi.reason };
  }
  return { ...rest, unifi: u };
}
