/**
 * What a screen reader is told when a reply is in (DEV_NOTES §9.40): the speaker and the start of the
 * message as plain text. The chat list itself is not a live region; reading every streamed token
 * would be noise.
 */
const MAX_CHARS = 300;

/** message source → readable text: no code blocks, tags, link targets or markdown marks */
export function plainText(mes: string): string {
  return mes
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/<(style|script)\b[\s\S]*?(?:<\/\1>|$)/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function replyAnnouncement(name: string, mes: string): string {
  const body = plainText(mes);
  if (!body) return '';
  let text = body;
  if (body.length > MAX_CHARS) {
    // not through the middle of a surrogate pair
    const code = body.charCodeAt(MAX_CHARS - 1);
    const end = code >= 0xd800 && code <= 0xdbff ? MAX_CHARS - 1 : MAX_CHARS;
    text = `${body.slice(0, end)}…`;
  }
  return name ? `${name}：${text}` : text;
}
