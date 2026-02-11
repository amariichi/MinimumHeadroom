export function writeFramedMessage(stream, message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
  stream.write(Buffer.concat([header, body]));
}

export function writeMessage(stream, message, format = 'framed') {
  if (format === 'line') {
    stream.write(`${JSON.stringify(message)}\n`);
    return;
  }
  writeFramedMessage(stream, message);
}

function findHeaderTerminator(buffer) {
  const crlfIndex = buffer.indexOf('\r\n\r\n');
  const lfIndex = buffer.indexOf('\n\n');

  if (crlfIndex === -1 && lfIndex === -1) {
    return null;
  }

  if (crlfIndex === -1) {
    return { index: lfIndex, length: 2 };
  }

  if (lfIndex === -1) {
    return { index: crlfIndex, length: 4 };
  }

  if (crlfIndex < lfIndex) {
    return { index: crlfIndex, length: 4 };
  }

  return { index: lfIndex, length: 2 };
}

function trimLeadingWhitespace(buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const byte = buffer[offset];
    if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a) {
      offset += 1;
      continue;
    }
    break;
  }

  if (offset === 0) {
    return buffer;
  }
  return buffer.subarray(offset);
}

function parseJsonLineFallback(buffer, onMessage) {
  if (buffer.length === 0) {
    return { consumed: false, buffer };
  }

  const newlineIndex = buffer.indexOf('\n');
  if (newlineIndex === -1) {
    const text = buffer.toString('utf8').trim();
    if (text === '') {
      return { consumed: true, buffer: Buffer.alloc(0) };
    }
    try {
      const parsed = JSON.parse(text);
      onMessage(parsed, { format: 'line' });
      return { consumed: true, buffer: Buffer.alloc(0) };
    } catch {
      return { consumed: false, buffer };
    }
  }

  const line = buffer.subarray(0, newlineIndex).toString('utf8').trim();
  const rest = buffer.subarray(newlineIndex + 1);
  if (line === '') {
    return { consumed: true, buffer: rest };
  }

  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`Invalid JSON line payload: ${error.message}`);
  }

  onMessage(parsed, { format: 'line' });
  return { consumed: true, buffer: rest };
}

export function createFramedMessageParser(onMessage) {
  let buffer = Buffer.alloc(0);

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      buffer = trimLeadingWhitespace(buffer);
      if (buffer.length === 0) {
        return;
      }

      const terminator = findHeaderTerminator(buffer);
      if (!terminator) {
        const lineFallback = parseJsonLineFallback(buffer, onMessage);
        if (!lineFallback.consumed) {
          return;
        }
        buffer = lineFallback.buffer;
        continue;
      }

      const headerText = buffer.subarray(0, terminator.index).toString('utf8');
      const lengthLine = headerText
        .split(/\r?\n/)
        .find((line) => line.toLowerCase().startsWith('content-length:'));

      if (!lengthLine) {
        const lineFallback = parseJsonLineFallback(buffer, onMessage);
        if (!lineFallback.consumed) {
          throw new Error('Missing Content-Length header');
        }
        buffer = lineFallback.buffer;
        return;
      }

      const contentLengthText = lengthLine.split(':').slice(1).join(':').trim();
      const contentLength = Number.parseInt(contentLengthText, 10);
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        throw new Error(`Invalid Content-Length value: ${contentLengthText}`);
      }

      const messageStart = terminator.index + terminator.length;
      const messageEnd = messageStart + contentLength;
      if (buffer.length < messageEnd) {
        return;
      }

      const jsonText = buffer.subarray(messageStart, messageEnd).toString('utf8');
      buffer = buffer.subarray(messageEnd);

      let parsed;
      try {
        parsed = JSON.parse(jsonText);
      } catch (error) {
        throw new Error(`Invalid JSON payload: ${error.message}`);
      }

      onMessage(parsed, { format: 'framed' });
    }
  };
}
