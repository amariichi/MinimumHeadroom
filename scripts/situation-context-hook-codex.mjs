#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const plainHookPath = join(scriptDir, 'situation-context-hook.sh');

async function readStdin(stream) {
  if (!stream || stream.isTTY) {
    return '';
  }
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  }
  return chunks.join('');
}

function runPlainHook({ input, env = process.env, hookPath = plainHookPath, stderr = process.stderr }) {
  return new Promise((resolve) => {
    const child = spawn(hookPath, [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let childStderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      childStderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      stderr.write(`[situation-context-hook-codex] failed to run plain hook: ${error.message}\n`);
      resolve('');
    });
    child.on('exit', () => {
      if (childStderr.trim()) {
        stderr.write(childStderr);
      }
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}

export function buildCodexUserPromptSubmitOutput(additionalContext) {
  const context = typeof additionalContext === 'string' ? additionalContext.trimEnd() : '';
  if (!context.trim()) {
    return null;
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context
    }
  };
}

export async function runCodexSituationContextHook(options = {}) {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  const input = options.input ?? (await readStdin(stdin));
  const text = await runPlainHook({
    input,
    env,
    hookPath: options.hookPath ?? plainHookPath,
    stderr
  });
  const output = buildCodexUserPromptSubmitOutput(text);
  if (output) {
    stdout.write(`${JSON.stringify(output)}\n`);
  }
  return output;
}

async function main() {
  try {
    await runCodexSituationContextHook();
  } catch (error) {
    process.stderr.write(`[situation-context-hook-codex] unexpected error: ${error?.message ?? error}\n`);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
