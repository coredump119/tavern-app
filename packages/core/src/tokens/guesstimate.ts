import { BYTES_PER_TOKEN } from './types.js';

const textEncoder = new TextEncoder();

/** ST tokenizers.guesstimate：⌈UTF-8 字节数 / 3.35⌉ */
export function guesstimate(str: string): number {
  const byteLength = textEncoder.encode(str).length;
  return Math.ceil(byteLength / BYTES_PER_TOKEN);
}
