/**
 * Speed-test endpoints. Kept dumb on purpose: the client times everything,
 * the server just moves bytes as fast as it can and stays out of the way.
 */

const NO_STORE = {
  'Cache-Control': 'no-store, no-transform',
  // Keep any proxy from trying to compress random bytes, and say so.
  'Content-Encoding': 'identity',
} as const;

/**
 * 4 MiB of random bytes, generated once and streamed repeatedly. Random so
 * nothing on the path can compress it; reused so the server spends no CPU
 * per request generating it.
 */
const BLOCK = new Uint8Array(4 * 1024 * 1024);
// getRandomValues is capped at 64 KiB per call; fill in slices.
for (let off = 0; off < BLOCK.length; off += 65536) crypto.getRandomValues(BLOCK.subarray(off, off + 65536));

export const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024; // 1 GiB per request
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

export function ping(): Response {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

export function download(url: URL): Response {
  const raw = url.searchParams.get('bytes') ?? String(25 * 1024 * 1024);
  const bytes = Number(raw);
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > MAX_DOWNLOAD_BYTES)
    return Response.json({ error: `bytes must be an integer 0..${MAX_DOWNLOAD_BYTES}` }, { status: 400 });

  let sent = 0;
  // A default (not "bytes") stream: enqueued chunks are not transferred, so
  // every response can share views of the one block, which is never written.
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const n = Math.min(BLOCK.length, bytes - sent);
      if (n <= 0) return controller.close();
      controller.enqueue(BLOCK.subarray(0, n));
      sent += n;
    },
  });
  return new Response(body, {
    headers: { ...NO_STORE, 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes) },
  });
}

export async function upload(req: Request): Promise<Response> {
  if (!req.body) return Response.json({ bytes: 0, ms: 0 });
  const started = performance.now();
  let bytes = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_UPLOAD_BYTES) {
      await reader.cancel();
      return Response.json({ error: `upload larger than ${MAX_UPLOAD_BYTES} bytes` }, { status: 413 });
    }
  }
  return Response.json({ bytes, ms: performance.now() - started }, { headers: { 'Cache-Control': 'no-store' } });
}
