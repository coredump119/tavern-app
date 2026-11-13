/** `TH-message--<楼层>--<序号>`: the id / name TavernHelper gives a rendered block's iframe */
export function slotName(messageId: number, block: number): string {
  return `TH-message--${messageId}--${block}`;
}

/** 楼层号 of a slot name, or null when `name` is not one */
export function slotMessageId(name: string): number | null {
  const m = /^TH-message--(\d+)--\d+$/.exec(name);
  return m ? Number(m[1]) : null;
}

/**
 * TavernHelper's rule for "this code block is a front-end page": its text contains `html>`,
 * `<head>` or `<body`. Cheap on purpose: it runs for every code block of every rendered message.
 */
export function isFrontend(text: string): boolean {
  return text.includes('html>') || text.includes('<head>') || text.includes('<body');
}
