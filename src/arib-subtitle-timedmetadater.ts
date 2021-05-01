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
program.parse(process.argv);
const options = program.opts();

// ffmpeg が UDP 受けで descriptor を保持するようになったらUDP対応を外す (これは ffmpeg 4.5 で確定なはず)
const src = new PassThrough(); 
const dst = options.output == null || options.output === '-' ? process.stdout : fs.createWriteStream(options.output);

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
