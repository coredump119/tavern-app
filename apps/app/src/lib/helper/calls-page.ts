/**
 * Calls of the stand-in page and of the bundled libraries (DEV_NOTES §9.5 第 3 轮 → DOM、显示接口):
 * what scripts did to the page they see is carried over to the real one here, one narrow
 * operation at a time.
 */
import { chatPage } from '../chat/page-actions';
import type { CallTable } from './calls';
import { helperDisplay } from './display.svelte';
import { helperPage } from './page.svelte';

/** one line above the input box holds about this much */
const MAX_TOAST = 300;
const MAX_DRAFT = 1_000_000;
const TOAST_KINDS = new Set(['success', 'info', 'warning', 'error']);

const str = (value: unknown, what: string): string => {
  if (typeof value !== 'string') throw new Error(`${what}需要是字符串`);
  return value;
};

/** toastr takes HTML; the app's notice line is plain text */
const plain = (html: string): string =>
  (new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '').trim();

export const pageCalls: CallTable = {
  toast: ([kind, message, title]) => {
    if (!TOAST_KINDS.has(str(kind, '类型'))) throw new Error('未知的提示类型');
    const body = plain(str(message, '内容'));
    const head = plain(str(title ?? '', '标题'));
    const line = (head && body ? `${head}：${body}` : head || body).slice(0, MAX_TOAST);
    // nowhere to show it while the chat page is closed (the caller does not wait for an answer)
    if (line) chatPage().notify(line);
  },
  copy: ([text]) => navigator.clipboard.writeText(str(text, '文本')),
  'page.style': ([css]) => helperPage.setStyle(str(css, '样式')),
  'page.draft': ([text]) => {
    const draft = str(text, '输入框内容');
    if (draft.length > MAX_DRAFT) throw new Error('输入框内容过大');
    chatPage().setDraft(draft);
  },
  'page.click': ([action]) => {
    const page = chatPage();
    switch (action) {
      case 'send':
        return page.send();
      case 'stop':
        return page.stop();
      case 'regenerate':
      case 'continue':
        return page.generate(action);
      default:
        throw new Error('未知的按钮');
    }
  },
  'display.set': ([index, html]) => {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      throw new Error('楼层需要是非负整数');
    }
    helperDisplay.set(index, html === null ? null : str(html, '消息内容'));
  },
};
