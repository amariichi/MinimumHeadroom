#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const HELPER_PRESETS = new Set(['reviewer', 'implementer', 'full']);

function asNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function extractCommandLine(payload) {
  const args = payload?.toolCall?.args;
  if (!args || typeof args !== 'object') return null;
  return asNonEmptyString(args.CommandLine)
    ?? asNonEmptyString(args.commandLine)
    ?? asNonEmptyString(args.command)
    ?? asNonEmptyString(args.cmd);
}

function shellWords(commandLine) {
  return String(commandLine ?? '')
    .match(/(?:[^\s"';|&]+|"[^"]*"|'[^']*')+/g)
    ?.map((word) => word.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2'))
    ?? [];
}

export function isGitPushCommand(commandLine) {
  const words = shellWords(commandLine);
  for (let index = 0; index < words.length; index += 1) {
    if (words[index].split('/').at(-1)?.toLowerCase() !== 'git') continue;
    for (let cursor = index + 1; cursor < words.length; cursor += 1) {
      const word = words[cursor];
      if ((word === '-C' || word === '-c' || word === '--git-dir' || word === '--work-tree')
          && cursor + 1 < words.length) {
        cursor += 1;
        continue;
      }
      if (word.startsWith('-')) continue;
      if (word.toLowerCase() === 'push') return true;
      break;
    }
  }
  return false;
}

export function isReviewerReadCommand(commandLine) {
  const command = asNonEmptyString(commandLine);
  if (!command || /[;&|<>`$()\n\r]/.test(command)) return false;
  const words = shellWords(command);
  if (words.length === 0) return false;
  const executable = words[0].split('/').at(-1)?.toLowerCase();
  if (executable === 'rg') {
    return !words.slice(1).some((word) => word === '--pre' || word.startsWith('--pre='));
  }
  if (['cat', 'ls'].includes(executable)) return true;
  if (executable === 'sed') {
    const args = words.slice(1);
    if (!['-n', '--quiet', '--silent'].includes(args[0])) return false;
    const scriptIndex = args[1] === '-e' ? 2 : 1;
    const script = args[scriptIndex];
    if (!/^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(script ?? '')) return false;
    return !args.slice(scriptIndex + 1).some((word) => word !== '--' && word.startsWith('-'));
  }
  if (executable !== 'git') return false;
  let cursor = 1;
  while (cursor < words.length) {
    if (words[cursor] === '-C' && cursor + 1 < words.length) {
      cursor += 2;
      continue;
    }
    if (words[cursor] === '-c' || /^-c.+/.test(words[cursor]) || words[cursor].startsWith('--config-env')) {
      return false;
    }
    if (words[cursor].startsWith('-')) {
      cursor += 1;
      continue;
    }
    const subcommand = words[cursor].toLowerCase();
    if (!['status', 'diff', 'log'].includes(subcommand)) return false;
    return !words.slice(cursor + 1).some((word) => (
      word === '--ext-diff'
      || word === '--textconv'
      || word === '--output'
      || word.startsWith('--output=')
    ));
  }
  return false;
}

export function evaluateAgyHelperPolicy(payload, presetValue) {
  const preset = asNonEmptyString(presetValue);
  if (!preset || !HELPER_PRESETS.has(preset)) return {};
  const commandLine = extractCommandLine(payload);
  if (isGitPushCommand(commandLine)) {
    return { decision: 'deny', reason: 'Minimum Headroom helpers must not run git push.' };
  }
  if (preset === 'reviewer') {
    if (isReviewerReadCommand(commandLine)) return { decision: 'allow' };
    return {
      decision: 'force_ask',
      reason: 'Reviewer preset requires owner approval for commands outside the read-only allowlist.'
    };
  }
  // Implementer/full use agy's --dangerously-skip-permissions for ordinary
  // commands. Returning no decision preserves that session-level behavior.
  return {};
}

export async function runAgyHelperPolicy(options = {}) {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  let text = '';
  if (stdin && !stdin.isTTY) {
    for await (const chunk of stdin) text += chunk.toString();
  }
  let payload = null;
  try {
    payload = text.trim() ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  const result = evaluateAgyHelperPolicy(payload, env.MH_AGY_PERMISSION_PRESET);
  stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

async function main() {
  try {
    await runAgyHelperPolicy();
  } catch {
    process.stdout.write('{}\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
