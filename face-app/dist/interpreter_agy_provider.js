import { spawn as nodeSpawn } from 'node:child_process';

import { parseInterpreterModelJson } from './interpreter_model_json.js';
import { normalizeInterpreterLanguage } from './interpreter_state.js';

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function createAgyJsonClient(options = {}) {
  const command = asNonEmptyString(options.command) ?? 'agy';
  const model = asNonEmptyString(options.model) ?? 'gemini-3.8-flash-low';
  const effort = asNonEmptyString(options.effort) ?? 'low';
  const printTimeout = asNonEmptyString(options.printTimeout) ?? '45s';
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1_000, Math.floor(options.timeoutMs))
    : 50_000;
  const maxOutputBytes = Number.isFinite(options.maxOutputBytes)
    ? Math.max(1024, Math.floor(options.maxOutputBytes))
    : 1024 * 1024;
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : nodeSpawn;

  async function run(prompt) {
    return new Promise((resolve, reject) => {
      const child = spawnImpl(command, [
        '--model', model,
        '--effort', effort,
        '--print-timeout', printTimeout
      ], {
        cwd: options.cwd ?? process.cwd(),
        env: {
          ...process.env,
          NO_COLOR: '1'
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false
      });
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const finish = (error, value = null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(new Error('agy request timed out'));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          child.kill('SIGTERM');
          finish(new Error('agy stdout exceeded size limit'));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk) => {
        if (stderrBytes >= 16_384) {
          return;
        }
        stderrBytes += chunk.length;
        stderr.push(chunk);
      });
      child.on('error', (error) => finish(error));
      child.on('exit', (code, signal) => {
        if (settled) {
          return;
        }
        if (code !== 0) {
          const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 300);
          finish(new Error(`agy exited code=${code ?? 'null'} signal=${signal ?? 'none'}${detail ? `: ${detail}` : ''}`));
          return;
        }
        const parsed = parseInterpreterModelJson(Buffer.concat(stdout).toString('utf8'));
        if (!parsed) {
          finish(new Error('agy returned invalid JSON'));
          return;
        }
        finish(null, parsed);
      });
      child.stdin.end(prompt);
    });
  }

  return {
    command,
    model,
    effort,
    run
  };
}

function intentPrompt(input) {
  return `Analyze one interpreter turn and prepare a candidate translation.

Source language: ${input.sourceLanguage}
Current anchor: ${input.sessionSnapshot?.anchorLanguage ?? 'unset'}
Current partner: ${input.sessionSnapshot?.partnerLanguage ?? 'unset'}
Default first target: en
Transcript:
${input.transcript}

Return only JSON:
{"content_text":"semantic content with only the language instruction removed","requested_target_language":"primary BCP-47 tag or empty string","command_only":false,"candidate_target_language":"primary BCP-47 tag or empty string","candidate_translation":"faithful translation or empty string"}

command_only is true only if no semantic content remains. Resolve the likely
direction from the current pair and requested target. If the target is
unresolved, equals the source, or command_only is true, leave both candidate
fields empty. Otherwise translate semantic content faithfully without answering
questions or adding commentary. The application validates the direction before
reusing the candidate.`;
}

function translationPrompt(input) {
  return `Translate faithfully from ${input.sourceLanguage} to ${input.targetLanguage}. Do not answer questions, explain, or add text. Preserve names, numbers, register, and intent.

Return only JSON:
{"translation":"..."}

Content:
${input.contentText}`;
}

export function createAgyInterpreterProviders(options = {}) {
  const client = options.client ?? createAgyJsonClient(options);
  return {
    name: 'agy-gemini',
    intent: {
      async analyze(input) {
        const raw = await client.run(intentPrompt(input));
        const commandOnly = raw.command_only === true || raw.commandOnly === true;
        const contentText = commandOnly
          ? ''
          : asNonEmptyString(raw.content_text ?? raw.contentText) ?? input.transcript;
        const providerContext = Object.freeze({
          candidateTargetLanguage: normalizeInterpreterLanguage(
            raw.candidate_target_language ?? raw.candidateTargetLanguage
          ),
          candidateTranslation: asNonEmptyString(
            raw.candidate_translation ?? raw.candidateTranslation
          )
        });
        return {
          contentText,
          requestedTargetLanguage:
            asNonEmptyString(raw.requested_target_language ?? raw.requestedTargetLanguage),
          commandOnly,
          providerContext
        };
      }
    },
    translation: {
      async translate(input) {
        if (
          input.providerContext?.candidateTargetLanguage === input.targetLanguage
          && input.providerContext?.candidateTranslation
        ) {
          return {
            translation: input.providerContext.candidateTranslation,
            reusedCandidate: true
          };
        }
        const raw = await client.run(translationPrompt(input));
        const translation = asNonEmptyString(raw.translation);
        if (!translation) {
          throw new Error('agy translation was empty');
        }
        return {
          translation,
          reusedCandidate: false
        };
      }
    },
    health() {
      return {
        configured: true,
        command: client.command,
        model: client.model,
        effort: client.effort
      };
    }
  };
}
