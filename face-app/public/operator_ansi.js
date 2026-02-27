const ESC = '\u001b';

const ANSI_16_COLORS = Object.freeze([
  '#000000',
  '#cd0000',
  '#00cd00',
  '#cdcd00',
  '#0000ee',
  '#cd00cd',
  '#00cdcd',
  '#e5e5e5',
  '#7f7f7f',
  '#ff0000',
  '#00ff00',
  '#ffff00',
  '#5c5cff',
  '#ff00ff',
  '#00ffff',
  '#ffffff'
]);

function createDefaultStyle() {
  return {
    fg: null,
    bg: null,
    bold: false,
    faint: false,
    italic: false,
    underline: false,
    inverse: false
  };
}

function cloneStyle(style) {
  return {
    fg: style.fg,
    bg: style.bg,
    bold: style.bold,
    faint: style.faint,
    italic: style.italic,
    underline: style.underline,
    inverse: style.inverse
  };
}

function resetStyle(style) {
  style.fg = null;
  style.bg = null;
  style.bold = false;
  style.faint = false;
  style.italic = false;
  style.underline = false;
  style.inverse = false;
}

function sameStyle(left, right) {
  return (
    left.fg === right.fg &&
    left.bg === right.bg &&
    left.bold === right.bold &&
    left.faint === right.faint &&
    left.italic === right.italic &&
    left.underline === right.underline &&
    left.inverse === right.inverse
  );
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.floor(value)));
}

function rgbToCss(r, g, b) {
  return `rgb(${clampByte(r)}, ${clampByte(g)}, ${clampByte(b)})`;
}

function parseNumericToken(token) {
  if (typeof token !== 'string' || token === '') {
    return null;
  }
  const value = Number.parseInt(token, 10);
  return Number.isFinite(value) ? value : null;
}

function findCsiCommandIndex(input, startIndex) {
  for (let index = startIndex; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return index;
    }
  }
  return -1;
}

function findOscEnd(input, startIndex) {
  const belIndex = input.indexOf('\u0007', startIndex);
  const stIndex = input.indexOf(`${ESC}\\`, startIndex);
  if (belIndex === -1 && stIndex === -1) {
    return null;
  }
  if (belIndex === -1) {
    return { index: stIndex, length: 2 };
  }
  if (stIndex === -1) {
    return { index: belIndex, length: 1 };
  }
  if (belIndex < stIndex) {
    return { index: belIndex, length: 1 };
  }
  return { index: stIndex, length: 2 };
}

function setIndexedColor(style, target, colorIndex) {
  const cssColor = ansiIndexToCss(colorIndex);
  if (!cssColor) {
    return;
  }
  if (target === 'fg') {
    style.fg = cssColor;
  } else {
    style.bg = cssColor;
  }
}

function applyExtendedColor(style, target, tokens, index) {
  const mode = parseNumericToken(tokens[index + 1]);
  if (mode === 5) {
    const colorIndex = parseNumericToken(tokens[index + 2]);
    if (colorIndex !== null) {
      setIndexedColor(style, target, colorIndex);
    }
    return index + 2;
  }

  if (mode === 2) {
    const red = parseNumericToken(tokens[index + 2]);
    const green = parseNumericToken(tokens[index + 3]);
    const blue = parseNumericToken(tokens[index + 4]);
    if (red !== null && green !== null && blue !== null) {
      const cssColor = rgbToCss(red, green, blue);
      if (target === 'fg') {
        style.fg = cssColor;
      } else {
        style.bg = cssColor;
      }
    }
    return index + 4;
  }

  return index + 1;
}

function applySgrToken(style, code, tokens, index) {
  if (code === 0) {
    resetStyle(style);
    return index;
  }

  if (code === 1) {
    style.bold = true;
    style.faint = false;
    return index;
  }
  if (code === 2) {
    style.faint = true;
    style.bold = false;
    return index;
  }
  if (code === 3) {
    style.italic = true;
    return index;
  }
  if (code === 4) {
    style.underline = true;
    return index;
  }
  if (code === 7) {
    style.inverse = true;
    return index;
  }
  if (code === 21 || code === 22) {
    style.bold = false;
    style.faint = false;
    return index;
  }
  if (code === 23) {
    style.italic = false;
    return index;
  }
  if (code === 24) {
    style.underline = false;
    return index;
  }
  if (code === 27) {
    style.inverse = false;
    return index;
  }
  if (code === 39) {
    style.fg = null;
    return index;
  }
  if (code === 49) {
    style.bg = null;
    return index;
  }

  if (code >= 30 && code <= 37) {
    setIndexedColor(style, 'fg', code - 30);
    return index;
  }
  if (code >= 90 && code <= 97) {
    setIndexedColor(style, 'fg', code - 90 + 8);
    return index;
  }
  if (code >= 40 && code <= 47) {
    setIndexedColor(style, 'bg', code - 40);
    return index;
  }
  if (code >= 100 && code <= 107) {
    setIndexedColor(style, 'bg', code - 100 + 8);
    return index;
  }

  if (code === 38) {
    return applyExtendedColor(style, 'fg', tokens, index);
  }
  if (code === 48) {
    return applyExtendedColor(style, 'bg', tokens, index);
  }

  return index;
}

function applySgrSequence(style, tokenString) {
  const tokens = tokenString === '' ? ['0'] : tokenString.split(';');
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const code = token === '' ? 0 : parseNumericToken(token);
    if (code === null) {
      continue;
    }
    index = applySgrToken(style, code, tokens, index);
  }
}

export function ansiIndexToCss(index) {
  const parsed = Number.parseInt(String(index ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 255) {
    return null;
  }

  if (parsed < 16) {
    return ANSI_16_COLORS[parsed];
  }

  if (parsed <= 231) {
    const value = parsed - 16;
    const redIndex = Math.floor(value / 36);
    const greenIndex = Math.floor((value % 36) / 6);
    const blueIndex = value % 6;
    const levels = [0, 95, 135, 175, 215, 255];
    return rgbToCss(levels[redIndex], levels[greenIndex], levels[blueIndex]);
  }

  const gray = 8 + (parsed - 232) * 10;
  return rgbToCss(gray, gray, gray);
}

export function isDefaultAnsiStyle(style) {
  if (!style || typeof style !== 'object') {
    return true;
  }
  return !style.fg && !style.bg && !style.bold && !style.faint && !style.italic && !style.underline && !style.inverse;
}

export function parseAnsiRuns(value) {
  const input = typeof value === 'string' ? value : String(value ?? '');
  if (input.length === 0) {
    return [];
  }

  const style = createDefaultStyle();
  const runs = [];

  function pushRun(text) {
    if (text === '') {
      return;
    }
    const nextStyle = cloneStyle(style);
    const previous = runs[runs.length - 1];
    if (previous && sameStyle(previous, nextStyle)) {
      previous.text += text;
      return;
    }
    runs.push({ text, ...nextStyle });
  }

  let cursor = 0;

  while (cursor < input.length) {
    const escIndex = input.indexOf(ESC, cursor);
    if (escIndex === -1) {
      pushRun(input.slice(cursor));
      break;
    }

    if (escIndex > cursor) {
      pushRun(input.slice(cursor, escIndex));
    }

    if (escIndex >= input.length - 1) {
      break;
    }

    const marker = input[escIndex + 1];
    if (marker === '[') {
      const commandIndex = findCsiCommandIndex(input, escIndex + 2);
      if (commandIndex === -1) {
        break;
      }
      if (input[commandIndex] === 'm') {
        applySgrSequence(style, input.slice(escIndex + 2, commandIndex));
      }
      cursor = commandIndex + 1;
      continue;
    }

    if (marker === ']') {
      const oscEnd = findOscEnd(input, escIndex + 2);
      if (!oscEnd) {
        break;
      }
      cursor = oscEnd.index + oscEnd.length;
      continue;
    }

    cursor = escIndex + 2;
  }

  return runs;
}
