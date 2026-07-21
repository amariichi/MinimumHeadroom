import path from 'node:path';

const PLAIN_SHELL_COMMANDS = new Set(['bash', 'zsh', 'sh', 'dash', 'fish']);

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function isPlainShellCommand(command) {
  const source = asNonEmptyString(command);
  if (!source) {
    return false;
  }
  const firstWord = source.split(/\s+/)[0] ?? '';
  const basename = path.basename(firstWord).replace(/^-+/, '').toLowerCase();
  return PLAIN_SHELL_COMMANDS.has(basename);
}
