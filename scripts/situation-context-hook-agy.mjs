#!/usr/bin/env node
// Antigravity (agy) PreInvocation wrapper around situation-context-hook.sh.
//
// agy has no Claude-style UserPromptSubmit hook; its injection point is the
// PreInvocation lifecycle hook, which feeds JSON on stdin (camelCase keys,
// including conversationId) and expects a JSON object on stdout:
//
//     {"injectSteps": [{"ephemeralMessage": "<text>"}]}
//
// An ephemeral message is a transient system message — it reaches the model
// for this invocation but is not persisted into the conversation history, so
// per-invocation injection does not bloat the context.
//
// The camera-digest logic (MH_SITUATION_INJECT gate, watermark state,
// /situation fetch) stays in situation-context-hook.sh; this wrapper only
// adapts stdin/stdout and pins the watermark session key to the agy
// conversation via MH_SITUATION_SESSION_KEY (PreInvocation fires before every
// model invocation, and the plain hook's pid fallback would otherwise start a
// fresh watermark each time).
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

export function extractConversationId(rawInput) {
  try {
    const payload = JSON.parse(rawInput);
    const id = payload?.conversationId;
    if (typeof id === 'string' && id.trim()) {
      return id.trim();
    }
  } catch {
    // Non-JSON stdin is tolerated; the digest is still injectable.
  }
  return null;
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
      stderr.write(`[situation-context-hook-agy] failed to run plain hook: ${error.message}\n`);
      resolve('');
    });
    child.on('exit', () => {
      if (childStderr.trim()) {
        stderr.write(childStderr);
      }
      resolve(stdout);
    });
    // The plain hook exits without reading stdin when MH_SITUATION_INJECT is
    // off; swallow the resulting EPIPE instead of crashing the wrapper.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function buildAgyPreInvocationOutput(digestText) {
  const text = typeof digestText === 'string' ? digestText.trimEnd() : '';
  if (!text.trim()) {
    return null;
  }
  return {
    injectSteps: [{ ephemeralMessage: text }]
  };
}

export async function runAgySituationContextHook(options = {}) {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const baseEnv = options.env ?? process.env;
  const input = options.input ?? (await readStdin(stdin));

  const env = { ...baseEnv };
  const conversationId = extractConversationId(input);
  if (conversationId && !env.MH_SITUATION_SESSION_KEY) {
    env.MH_SITUATION_SESSION_KEY = `agy-${conversationId}`;
  }

  const text = await runPlainHook({
    input,
    env,
    hookPath: options.hookPath ?? plainHookPath,
    stderr
  });
  const output = buildAgyPreInvocationOutput(text) ?? {};
  stdout.write(`${JSON.stringify(output)}\n`);
  return output;
}

async function main() {
  try {
    await runAgySituationContextHook();
  } catch (error) {
    process.stderr.write(`[situation-context-hook-agy] unexpected error: ${error?.message ?? error}\n`);
    // The PreInvocation contract expects a JSON object on stdout even on failure.
    process.stdout.write('{}\n');
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
