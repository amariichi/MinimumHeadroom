#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  createReadStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';

function usage() {
  process.stdout.write(`Usage: node scripts/write-model-install-manifest.mjs [options]

Options:
  --root PATH       Installed model snapshot or cache root
  --output PATH     Manifest JSON path
  --model ID        Repository/model identifier
  --revision SHA    Pinned model revision
  -h, --help        Show this help
`);
}

const options = {};
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === '-h' || argument === '--help') {
    usage();
    process.exit(0);
  }
  if (!['--root', '--output', '--model', '--revision'].includes(argument)) {
    throw new Error(`unknown option: ${argument}`);
  }
  const value = process.argv[index + 1];
  if (!value) {
    throw new Error(`${argument} requires a value`);
  }
  options[argument.slice(2)] = value;
  index += 1;
}

for (const required of ['root', 'output', 'model', 'revision']) {
  if (!options[required]) {
    throw new Error(`--${required} is required`);
  }
}

const root = path.resolve(options.root);
const output = path.resolve(options.output);
if (!statSync(root).isDirectory()) {
  throw new Error(`root is not a directory: ${root}`);
}

function listFiles(directory, prefix = '') {
  const files = [];
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(absolute, relative));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      const metadata = entry.isSymbolicLink()
        ? statSync(realpathSync(absolute))
        : lstatSync(absolute);
      if (metadata.isFile()) {
        files.push({ absolute, relative, bytes: metadata.size });
      }
    }
  }
  return files;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

const fileRecords = [];
let totalBytes = 0;
for (const file of listFiles(root)) {
  fileRecords.push({
    path: file.relative,
    bytes: file.bytes,
    sha256: await sha256(file.absolute)
  });
  totalBytes += file.bytes;
}

const manifest = {
  schemaVersion: 1,
  model: options.model,
  revision: options.revision,
  installedRoot: root,
  generatedAt: new Date().toISOString(),
  totalBytes,
  files: fileRecords
};

mkdirSync(path.dirname(output), { recursive: true });
const temporary = `${output}.tmp-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600
});
renameSync(temporary, output);
process.stdout.write(
  `[model-manifest] ${options.model}@${options.revision} files=${fileRecords.length} bytes=${totalBytes} output=${output}\n`
);
