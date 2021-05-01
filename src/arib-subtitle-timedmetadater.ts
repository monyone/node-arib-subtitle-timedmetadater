#!/usr/bin/env node

import fs from 'fs';
import dgram from 'dgram';
import { PassThrough } from 'stream';

import MetadataTransform from './index'

import { Command } from 'commander';
const program = new Command();

program
  .option('-i, --input <path>', 'input mpeg2ts path')
  .option('-u, --udp-port <port>', 'input udp port')
  .option('-o, --output <path>', 'output mpeg2ts path')
program.parse(process.argv);
const options = program.opts();

// ffmpeg が UDP 受けで descriptor を保持するようになったらUDP対応を外す (これは ffmpeg 4.5 で確定なはず)
const src = new PassThrough(); 
const dst = options.output == null || options.output === '-' ? process.stdout : fs.createWriteStream(options.output);

src
  .pipe(new MetadataTransform())
  .pipe(dst);

if (options.port) {
  const server = dgram.createSocket('udp4');
  server.on('message', (msg: Buffer) => {
    setImmediate(() => { src.write(msg); });
  })
  server.bind(options.port);
} else {
  const stream = options.input == null || options.input === '-' ? process.stdin : fs.createReadStream(options.input);
  stream.pipe(src);
}
