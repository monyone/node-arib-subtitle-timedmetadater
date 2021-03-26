#!/usr/bin/env node

import fs from 'fs';

import MetadataTransform from './index'

import { Command } from 'commander';
const program = new Command();

program
  .option('-i, --input <path>', 'input mpeg2ts path')
  .option('-o, --output <path>', 'output mpeg2ts path')
program.parse(process.argv);
const options = program.opts();

const src = options.input == null || options.input === '-' ? process.stdin : fs.createReadStream(options.input);
const dst = options.output == null || options.output === '-' ? process.stdout : fs.createWriteStream(options.output);

src
  .pipe(new MetadataTransform())
  .pipe(dst);
