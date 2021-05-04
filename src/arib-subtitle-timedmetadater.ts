#!/usr/bin/env node

import fs from 'fs';
import dgram from 'dgram';
import net from 'net';
import { PassThrough } from 'stream';

import MetadataTransform from './index'

import { Command } from 'commander';
const program = new Command();

program
  .option('-i, --input <path>', 'input mpeg2ts path')
  .option('-t, --tcp_port <port>', 'input tcp port')
  .option('-u, --udp_port <port>', 'input udp port')
  .option('-o, --output <path>', 'output mpeg2ts path')
  .option('-h, --output_host <host>', 'output mpeg2ts UDP host')
  .option('-p, --output_port <port>', 'output mpeg2ts UDP port')
  .option('-c, --packet_count <size>', 'output mpeg2ts UDP packet buffer size')

program.parse(process.argv);
const options = program.opts();

// ffmpeg が UDP 受けで descriptor を保持するようになったらUDP対応を外す (これは ffmpeg 4.5 で確定なはず)
const src = new PassThrough(); 
const dst = new PassThrough();

src
  .pipe(new MetadataTransform())
  .pipe(dst);

if (options.tcp_port) {
  const server = net.createServer((socket) => {
    socket.pipe(src);
  });
  server.listen(options.tcp_port);
} else if (options.udp_port) {
  const server = dgram.createSocket('udp4');
  server.on('message', (msg: Buffer) => {
    src.write(msg);
  })
  server.bind(options.udp_port);
} else {
  const stream = options.input == null || options.input === '-' ? process.stdin : fs.createReadStream(options.input);
  stream.pipe(src);
}

if (options.output_port) {
  const socket = dgram.createSocket('udp4')
  const host = options.output_host ?? 'localhost';
  const port = options.output_port ?? 8000
  const count = options.packet_count ?? 100 // MTU 1500 byte だから 7 くらいが限度な気がするけど、ローカルホストだと 100 くらいで安定した

  let block: Buffer = Buffer.from([]);

  dst.on('data', (chunk: Buffer) => {
    block = Buffer.concat([block, chunk]);
    if (block.length >= 188 * count) {
      socket.send(block, 0, block.length, port, host);
      block = Buffer.from([]);
    }
  });
} else {
  const output = options.output == null || options.output === '-' ? process.stdout : fs.createWriteStream(options.output);
  dst.pipe(output)
}
