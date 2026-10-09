import type { StoredReport } from './db.ts';

type Listener = (r: StoredReport) => void;

/** In-process fan-out of new reports to long-pollers and SSE streams. */
export class ReportBus {
  private listeners = new Set<Listener>();

  publish(r: StoredReport) {
    for (const l of this.listeners) l(r);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Resolves on the next report, or with null after `ms` / on abort. */
  next(ms: number, signal?: AbortSignal): Promise<StoredReport | null> {
    return new Promise((resolve) => {
      const done = (r: StoredReport | null) => {
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
        resolve(r);
      };
      const onAbort = () => done(null);
      const timer = setTimeout(() => done(null), ms);
      const unsubscribe = this.subscribe(done);
      signal?.addEventListener('abort', onAbort);
    });
  }
}
