const lineFeed = String.fromCharCode(10);
const carriageReturn = String.fromCharCode(13);
const decoder = new TextDecoder('utf-8', { fatal: true });

function uniformLines(bytes: Uint8Array): string[] {
  const source = decoder.decode(bytes);
  let style: 'lf' | 'crlf' | null = null;
  let normalized = '';
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (character === carriageReturn) {
      if (source[index + 1] !== lineFeed || style === 'lf') { throw new Error('Native source line endings are invalid.'); }
      style = 'crlf';
      normalized += lineFeed;
      index++;
    } else {
      if (character === lineFeed) {
        if (style === 'crlf') { throw new Error('Native source line endings are mixed.'); }
        style = 'lf';
      }
      normalized += character;
    }
  }
  if (!normalized.endsWith(lineFeed)) { throw new Error('Native source lacks a final newline.'); }

  return normalized.split(lineFeed);
}

interface SourceParts { readonly usings: readonly string[]; readonly body: string }
function sourceParts(bytes: Uint8Array): SourceParts {
  const lines = uniformLines(bytes);
  if (lines[0] !== '#nullable enable') { throw new Error('Native source nullable contract is invalid.'); }
  const usings: string[] = [];
  let index = 1;
  while (index < lines.length && lines[index] !== 'namespace Companion.Runtime;') {
    const line = lines[index]!;
    if (line !== '') {
      if (!line.startsWith('using ') || !line.endsWith(';')) { throw new Error('Native source header is invalid.'); }
      usings.push(line);
    }
    index++;
  }
  if (lines[index] !== 'namespace Companion.Runtime;') { throw new Error('Native source namespace is invalid.'); }
  const body = lines.slice(index + 1).join(lineFeed).trim();
  if (body.length === 0) { throw new Error('Native source body is empty.'); }

  return { usings, body };
}

/** @internal Compile the two captured, fixed-hash file-scoped sources as one in-memory unit. */
export function bundleNativeImageSources(nativeFiles: Uint8Array, imagePins: Uint8Array): string {
  const files = sourceParts(nativeFiles);
  const pins = sourceParts(imagePins);
  if (!files.body.includes('public static class NativeFiles') || !pins.body.includes('public static class NativeImagePins')) {
    throw new Error('Native image source class names are invalid.');
  }
  const usings = [...new Set([...files.usings, ...pins.usings])];
  const bundled = ['#nullable enable', ...usings, '', 'namespace Companion.Runtime;', '', files.body, '', pins.body, ''].join(lineFeed);
  if (Buffer.byteLength(bundled, 'utf8') > 1_048_576) { throw new Error('Native image source bundle exceeds its bound.'); }

  return bundled;
}
