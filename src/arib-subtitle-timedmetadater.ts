#!/usr/bin/env node

import fs from 'fs';
import dgram from 'dgram';
import net from 'net';
import http from 'http';
import https from 'https'
import { PassThrough } from 'stream';

import MetadataTransform from './index'

import { Command } from 'commander';
const program = new Command();

program
  .option('-i, --input <path>', 'input mpeg2ts path')
  .option('-t, --tcp_port <port>', 'input tcp port')
  .option('-u, --udp_port <port>', 'input udp port')
  .option('-h, --host <address>', 'bind host address for udp/tcp')
  .option('--http <url>', 'input url for http GET request')
  .option('--https <url>', 'input url for https GET request')
  .option('-b, --recv_buffer_size <size>', 'input udp recvBufferSize')
  .option('-o, --output <path>', 'output mpeg2ts path');

program.parse(process.argv);
const options = program.opts();

// ffmpeg が UDP 受けで descriptor を保持するようになったらUDP対応を外す (これは ffmpeg 4.5 で確定なはず)
const src = new PassThrough(); 
const dst = options.output == null || options.output === '-' ? process.stdout : fs.createWriteStream(options.output);

src
  .pipe(new MetadataTransform())
  .pipe(dst);

if (options.https) {
  https.get(options.https, (res => { res.pipe(src); }));
} else if (options.http) {
  http.get(options.http, (res => { res.pipe(src); }));
} else if (options.tcp_port) {
  const server = net.createServer((socket) => {
    socket.pipe(src);
  });
  server.listen({
    port: options.tcp_port,
    host: options.host ?? 'localhost'
  });
} else if (options.udp_port) {
  const server = dgram.createSocket({
    type: 'udp4',
    recvBufferSize: options.recv_buffer_size ?? 1000000,
  })
  server.on('message', (msg: Buffer) => {
    src.write(msg);
  })
  server.bind(options.udp_port, options.host ?? 'localhost');
} else {
  const stream = options.input == null || options.input === '-' ? process.stdin : fs.createReadStream(options.input);
  stream.pipe(src);
}
