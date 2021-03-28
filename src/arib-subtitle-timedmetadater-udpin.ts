#!/usr/bin/env node

import fs from 'fs';
import { PassThrough } from 'stream';

import MetadataTransform from './index'

import dgram from 'dgram';
const server = dgram.createSocket('udp4');

import { Command } from 'commander';
const program = new Command();

program
  .option('-p, --port <port>', 'input udp port')
  .option('-o, --output <path>', 'output mpeg2ts path')
program.parse(process.argv);
const options = program.opts();

const src = new PassThrough();
const dst = options.output == null || options.output === '-' ? process.stdout : fs.createWriteStream(options.output);

src
  .pipe(new MetadataTransform())
  .pipe(dst);

server.on('message', (msg: Buffer) => {
  src.write(msg);
})

server.bind(options.port ?? 8000);
