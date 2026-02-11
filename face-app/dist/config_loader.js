import fs from 'node:fs';
import path from 'node:path';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stripInlineComment(line) {
  let inSingle = false;
  let inDouble = false;

  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (ch === '#' && !inSingle && !inDouble) {
      return line.slice(0, index);
    }
  }

  return line;
}

function parseScalar(rawValue) {
  const value = rawValue.trim();
  if (value === '') {
    return '';
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  if (value === 'null' || value === '~') {
    return null;
  }

  if (/^[-+]?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  if (/^[-+]?\d+\.\d+$/.test(value)) {
    return Number.parseFloat(value);
  }

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    if (value.startsWith('"')) {
      try {
        return JSON.parse(value);
      } catch {
        return value.slice(1, -1);
      }
    }
    return value.slice(1, -1);
  }

  return value;
}

function parseSimpleYamlObject(content) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  const lines = content.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const rawLine = lines[index].replace(/\r$/, '');
    const withoutComment = stripInlineComment(rawLine);

    if (withoutComment.trim() === '') {
      continue;
    }

    if (/\t/.test(withoutComment)) {
      throw new Error(`tab indentation is not supported (line ${lineNumber})`);
    }

    const indentMatch = withoutComment.match(/^ */);
    const indent = indentMatch ? indentMatch[0].length : 0;
    const trimmed = withoutComment.trim();
    const separator = trimmed.indexOf(':');
    if (separator <= 0) {
      throw new Error(`invalid key/value pair (line ${lineNumber})`);
    }

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].node;
    const key = trimmed.slice(0, separator).trim();
    const valueText = trimmed.slice(separator + 1).trim();

    if (!key) {
      throw new Error(`empty key is not allowed (line ${lineNumber})`);
    }

    if (valueText === '') {
      const child = {};
      parent[key] = child;
      stack.push({ indent, node: child });
      continue;
    }

    parent[key] = parseScalar(valueText);
  }

  return root;
}

function toFiniteNumber(value) {
  if (Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pickFirstNumber(source, keys) {
  for (const key of keys) {
    const value = toFiniteNumber(source[key]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

export function mapSpeechGateConfig(rawConfig) {
  if (!isPlainObject(rawConfig)) {
    return {};
  }

  const section = ['speech_gate', 'speechGate', '発話制御']
    .map((key) => rawConfig[key])
    .find((candidate) => isPlainObject(candidate));

  if (!section) {
    return {};
  }

  const mapped = {};

  const minIntervalPriority1Ms = pickFirstNumber(section, [
    'min_interval_priority1_ms',
    'minIntervalPriority1Ms',
    'priority1_最小間隔_ms'
  ]);
  if (Number.isFinite(minIntervalPriority1Ms)) {
    mapped.minIntervalPriority1Ms = minIntervalPriority1Ms;
  }

  const globalWindowMs = pickFirstNumber(section, ['global_window_ms', 'globalWindowMs']);
  if (Number.isFinite(globalWindowMs)) {
    mapped.globalWindowMs = globalWindowMs;
  }

  const globalLimitLowPriority = pickFirstNumber(section, [
    'global_limit_low_priority',
    'globalLimitLowPriority',
    'global_60s_上限'
  ]);
  if (Number.isFinite(globalLimitLowPriority)) {
    mapped.globalLimitLowPriority = globalLimitLowPriority;
  }

  const sessionWindowMs = pickFirstNumber(section, ['session_window_ms', 'sessionWindowMs']);
  if (Number.isFinite(sessionWindowMs)) {
    mapped.sessionWindowMs = sessionWindowMs;
  }

  const sessionLimitLowPriority = pickFirstNumber(section, [
    'session_limit_low_priority',
    'sessionLimitLowPriority',
    'session_60s_上限'
  ]);
  if (Number.isFinite(sessionLimitLowPriority)) {
    mapped.sessionLimitLowPriority = sessionLimitLowPriority;
  }

  const dedupeMsLowPriority = pickFirstNumber(section, [
    'dedupe_ms_low_priority',
    'dedupeMsLowPriority',
    'dedupe_ms'
  ]);
  if (Number.isFinite(dedupeMsLowPriority)) {
    mapped.dedupeMsLowPriority = dedupeMsLowPriority;
  }

  return mapped;
}

export function mapTtsConfig(rawConfig) {
  if (!isPlainObject(rawConfig)) {
    return {};
  }

  const section = ['tts', 'TTS']
    .map((key) => rawConfig[key])
    .find((candidate) => isPlainObject(candidate));

  if (!section) {
    return {};
  }

  const mapped = {};
  const defaultTtlMs = pickFirstNumber(section, ['default_ttl_ms', 'defaultTtlMs', 'TTL_ms']);
  if (Number.isFinite(defaultTtlMs)) {
    mapped.defaultTtlMs = defaultTtlMs;
  }

  const autoInterruptAfterMs = pickFirstNumber(section, [
    'auto_interrupt_after_ms',
    'autoInterruptAfterMs',
    '自動割り込み_ms'
  ]);
  if (Number.isFinite(autoInterruptAfterMs)) {
    mapped.autoInterruptAfterMs = autoInterruptAfterMs;
  }

  return mapped;
}

export function loadFaceAppConfig(options = {}) {
  const log = options.log ?? console;
  const env = options.env ?? process.env;
  const rootDir = typeof options.repoRoot === 'string' && options.repoRoot.trim() !== '' ? options.repoRoot : process.cwd();
  const configPathFromEnv = typeof env.FACE_CONFIG_PATH === 'string' ? env.FACE_CONFIG_PATH.trim() : '';
  const configPath =
    typeof options.configPath === 'string' && options.configPath.trim() !== ''
      ? options.configPath.trim()
      : configPathFromEnv !== ''
        ? configPathFromEnv
        : path.resolve(rootDir, 'config.yaml');

  let content;
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      if (typeof log.info === 'function') {
        log.info(`[face-app] config not found at ${configPath}; using built-in defaults`);
      }
      return { configPath, loaded: false, speechGate: {}, tts: {}, raw: null };
    }
    if (typeof log.warn === 'function') {
      log.warn(`[face-app] failed to read config ${configPath}: ${error.message}`);
    }
    return { configPath, loaded: false, speechGate: {}, tts: {}, raw: null };
  }

  let rawConfig;
  try {
    rawConfig = parseSimpleYamlObject(content);
  } catch (error) {
    if (typeof log.warn === 'function') {
      log.warn(`[face-app] failed to parse config ${configPath}: ${error.message}`);
    }
    return { configPath, loaded: false, speechGate: {}, tts: {}, raw: null };
  }

  const speechGate = mapSpeechGateConfig(rawConfig);
  const tts = mapTtsConfig(rawConfig);
  if (typeof log.info === 'function') {
    const summary = Object.keys(speechGate).length > 0 ? JSON.stringify(speechGate) : '{}';
    const ttsSummary = Object.keys(tts).length > 0 ? JSON.stringify(tts) : '{}';
    log.info(`[face-app] loaded config ${configPath} speech_gate=${summary} tts=${ttsSummary}`);
  }

  return { configPath, loaded: true, speechGate, tts, raw: rawConfig };
}
