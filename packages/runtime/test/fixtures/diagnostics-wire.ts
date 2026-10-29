import { createConnection } from 'node:net';

/** One complete raw HTTP response, with framing removed from its body. */
export interface DiagnosticsWireResponse {
  raw: string;
  status: number;
  headers: Headers;
  body: string;
}

/** Writes the supplied bytes unchanged and reads until the peer closes. */
export async function exchangeDiagnosticsWire(
  port: number,
  request: string,
  timeoutMs = 2_000,
): Promise<DiagnosticsWireResponse> {
  const socket = createConnection({ host: '127.0.0.1', port });
  const chunks: Uint8Array[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Raw diagnostics response timed out'));
      }, timeoutMs);
      socket.once('connect', () => socket.write(request));
      socket.on('data', (chunk: Uint8Array) => chunks.push(chunk));
      socket.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        // A parser refusal may be followed by a reset after its bytes arrive.
        // Retain them for the caller's exact response assertions.
        if (error.code !== 'ECONNRESET' || chunks.length === 0) reject(error);
      });
      socket.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    return parseDiagnosticsWire(Buffer.concat(chunks).toString('utf8'));
  } finally {
    socket.destroy();
  }
}

/** Parses a complete response, retaining its original bytes beside the decoded body. */
export function parseDiagnosticsWire(raw: string): DiagnosticsWireResponse {
  const separator = raw.indexOf('\r\n\r\n');
  if (separator === -1) throw new Error('No complete HTTP response');
  const lines = raw.slice(0, separator).split('\r\n');
  const status = Number(lines.shift()!.split(' ')[1]);
  const headers = new Headers();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error('Invalid response header');
    headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  let body = raw.slice(separator + 4);
  if (headers.get('transfer-encoding') === 'chunked') {
    const decoded: Buffer[] = [];
    let remaining = Buffer.from(body);
    let terminated = false;
    while (remaining.length > 0) {
      const end = remaining.indexOf('\r\n');
      const size = remaining.subarray(0, end).toString('ascii').split(';', 1)[0]!;
      const length = Number.parseInt(size, 16);
      if (end === -1 || !/^[0-9a-f]+$/i.test(size) || !Number.isSafeInteger(length)) {
        throw new Error('Invalid chunk framing');
      }
      if (length === 0) {
        const trailers = remaining.subarray(end + 2).toString('ascii');
        if (trailers !== '\r\n' && !trailers.endsWith('\r\n\r\n'))
          throw new Error('Incomplete chunk terminator');
        terminated = true;
        break;
      }
      if (
        remaining.length < end + 2 + length + 2 ||
        remaining.subarray(end + 2 + length, end + 2 + length + 2).toString('ascii') !== '\r\n'
      ) {
        throw new Error('Incomplete chunk body');
      }
      decoded.push(remaining.subarray(end + 2, end + 2 + length));
      remaining = remaining.subarray(end + 2 + length + 2);
    }
    if (!terminated) throw new Error('Incomplete chunk terminator');
    body = Buffer.concat(decoded).toString('utf8');
  }
  return { raw, status, headers, body };
}
