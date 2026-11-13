/**
 * Minimal PNG tEXt chunk reader/writer (no image decoding). Mirrors SillyTavern's
 * character-card-parser.js: `chara` = V2 JSON, `ccv3` = V3 JSON, both base64.
 * The Rust implementation in apps/app/src-tauri/src/card is the primary one; this is for
 * browser dev mode and tests.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface PngChunk {
  type: string;
  data: Uint8Array;
}

let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array, seed = 0xffffffff): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = seed;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return c >>> 0;
}

export function readChunks(png: Uint8Array): PngChunk[] {
  if (png.length < 8 || SIGNATURE.some((b, i) => png[i] !== b))
    throw new Error('png-text: not a PNG');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: PngChunk[] = [];
  let pos = 8;
  while (pos + 8 <= png.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(png[pos + 4]!, png[pos + 5]!, png[pos + 6]!, png[pos + 7]!);
    const start = pos + 8;
    if (start + len + 4 > png.length) throw new Error(`png-text: truncated chunk ${type}`);
    chunks.push({ type, data: png.subarray(start, start + len) });
    pos = start + len + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

export function writeChunks(chunks: PngChunk[]): Uint8Array {
  const total = 8 + chunks.reduce((n, c) => n + 12 + c.data.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let pos = 8;
  for (const c of chunks) {
    view.setUint32(pos, c.data.length);
    const typeBytes = new Uint8Array([...c.type].map((ch) => ch.charCodeAt(0)));
    out.set(typeBytes, pos + 4);
    out.set(c.data, pos + 8);
    const crcInput = new Uint8Array(4 + c.data.length);
    crcInput.set(typeBytes, 0);
    crcInput.set(c.data, 4);
    view.setUint32(pos + 8 + c.data.length, (crc32(crcInput) ^ 0xffffffff) >>> 0);
    pos += 12 + c.data.length;
  }
  return out;
}

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');

function decodeText(data: Uint8Array): { keyword: string; text: string } {
  const nul = data.indexOf(0);
  if (nul < 0) throw new Error('png-text: tEXt without separator');
  return {
    keyword: latin1.decode(data.subarray(0, nul)),
    text: latin1.decode(data.subarray(nul + 1)),
  };
}

function encodeText(keyword: string, text: string): Uint8Array {
  const out = new Uint8Array(keyword.length + 1 + text.length);
  for (let i = 0; i < keyword.length; i++) out[i] = keyword.charCodeAt(i) & 0xff;
  out[keyword.length] = 0;
  for (let i = 0; i < text.length; i++) out[keyword.length + 1 + i] = text.charCodeAt(i) & 0xff;
  return out;
}

function b64decode(s: string): string {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return utf8.decode(bytes);
}
function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** All tEXt entries, keyword → decoded (base64-decoded, UTF-8) text. Keywords lower-cased. */
export function readPngText(png: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of readChunks(png)) {
    if (c.type !== 'tEXt') continue;
    const { keyword, text } = decodeText(c.data);
    out.set(keyword.toLowerCase(), text);
  }
  return out;
}

/** Character JSON text from a card PNG: prefers ccv3, falls back to chara (as ST does). */
export function readCardJson(png: Uint8Array): string {
  const texts = readPngText(png);
  const raw = texts.get('ccv3') ?? texts.get('chara');
  if (raw === undefined) throw new Error('png-text: no character data (chara/ccv3) in PNG');
  return b64decode(raw);
}

/**
 * Write character JSON into a PNG the way ST does: drop existing chara/ccv3 chunks, add
 * `chara` (the JSON as given) and `ccv3` (same JSON with spec forced to chara_card_v3) before IEND.
 */
export function writeCardJson(png: Uint8Array, json: string): Uint8Array {
  const chunks = readChunks(png).filter((c) => {
    if (c.type !== 'tEXt') return true;
    const k = decodeText(c.data).keyword.toLowerCase();
    return k !== 'chara' && k !== 'ccv3';
  });
  const iend = chunks.findIndex((c) => c.type === 'IEND');
  const at = iend < 0 ? chunks.length : iend;
  const inserts: PngChunk[] = [{ type: 'tEXt', data: encodeText('chara', b64encode(json)) }];
  try {
    const v3 = JSON.parse(json) as Record<string, unknown>;
    v3['spec'] = 'chara_card_v3';
    v3['spec_version'] = '3.0';
    inserts.push({ type: 'tEXt', data: encodeText('ccv3', b64encode(JSON.stringify(v3))) });
  } catch {
    /* not JSON: ST also silently skips the ccv3 chunk */
  }
  chunks.splice(at, 0, ...inserts);
  return writeChunks(chunks);
}
