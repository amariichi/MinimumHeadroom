#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const NODE_ENGINE_RANGE = '^22.23.4 || ^24.22.1 || ^26.12.1';
const minimums = new Map([[22, [23, 4]], [24, [22, 1]], [26, [12, 1]]]);

export function isSupportedNodeVersion(version) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(version));
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  const minimum = minimums.get(major);
  return Boolean(minimum && (minor > minimum[0] || (minor === minimum[0] && patch >= minimum[1])));
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  if (isSupportedNodeVersion(process.versions.node)) {
    console.log(`[setup] Node.js ${process.versions.node}`);
  } else {
    console.error(`[setup] Unsupported Node.js ${process.versions.node}; requires ${NODE_ENGINE_RANGE} (24.x recommended).`);
    process.exitCode = 2;
  }
}
