import * as dgram from 'node:dgram';

/** Loopback-only DNS fixture derived from the maintainer's working UDP probe. */
export async function startDnsServer(options: { silent?: boolean } = {}): Promise<{
  readonly server: string;
  readonly port: number;
  readonly queries: number;
  stop(): Promise<void>;
}> {
  const socket = dgram.createSocket('udp4');
  let count = 0;
  socket.on('message', (message, remote) => {
    count++;
    if (options.silent || message.length < 17) return;
    const labels: string[] = [];
    let offset = 12;
    while (offset < message.length) {
      const size = message[offset++]!;
      if (size === 0) break;
      labels.push(message.subarray(offset, offset + size).toString());
      offset += size;
    }
    if (offset + 4 > message.length) return;
    const name = labels.join('.');
    const type = message.readUInt16BE(offset);
    if (name.startsWith('hang.')) return;
    const header = Buffer.from(message.subarray(0, 12));
    const question = message.subarray(12, offset + 4);
    let rcode = 0;
    const answers: Buffer[] = [];
    const rr = (recordType: number, data: Buffer): Buffer => {
      const fields = Buffer.alloc(10);
      fields.writeUInt16BE(recordType, 0);
      fields.writeUInt16BE(1, 2);
      fields.writeUInt32BE(30, 4);
      fields.writeUInt16BE(data.length, 8);
      return Buffer.concat([Buffer.from([0xc0, 0x0c]), fields, data]);
    };
    if (name.startsWith('servfail.')) rcode = 2;
    else if (name === 'ok.test') {
      if (type === 1) answers.push(rr(1, Buffer.from([10, 0, 0, 1])));
    } else if (name === 'v6.test') {
      if (type === 28)
        answers.push(rr(28, Buffer.from([0x20, 1, 0xd, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])));
    } else if (name === '_svc._tcp.ok.test' && type === 33) {
      const data = Buffer.alloc(6);
      data.writeUInt16BE(10, 0);
      data.writeUInt16BE(5, 2);
      data.writeUInt16BE(8080, 4);
      answers.push(
        rr(
          33,
          Buffer.concat([
            data,
            Buffer.from([2, ...Buffer.from('ok'), 4, ...Buffer.from('test'), 0]),
          ]),
        ),
      );
    } else rcode = 3;
    header[2] = 0x84 | (message[2]! & 1);
    header[3] = 0x80 | rcode;
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(answers.length, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(0, 10);
    socket.send(Buffer.concat([header, question, ...answers]), remote.port, remote.address);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      socket.off('error', reject);
      resolve();
    });
  });
  const { port } = socket.address();
  return {
    server: `127.0.0.1:${port}`,
    port,
    get queries() {
      return count;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        // dgram's close callback takes no error argument.
        socket.close(() => resolve());
      }),
  };
}
