// ST public/scripts/chats.js addDOMPurifyHooks() 的移植：消息 HTML 消毒（class 加 custom- 前缀、未知元素换行、外链媒体拦截）。
// 需要一个 window（真实 WebView 或测试里的 jsdom），所以放在 @tm/ui 而不是 @tm/core。
import createDOMPurify, { type Config, type DOMPurify } from 'dompurify';

export interface MessageSanitizerOptions {
  /** isExternalMediaAllowed()：按当前角色/群的覆盖决定，缺省 !forbid_external_media */
  mediaAllowed: () => boolean;
}

export interface MessageSanitizeConfig extends Config {
  MESSAGE_SANITIZE?: boolean;
  MESSAGE_ALLOW_SYSTEM_UI?: boolean;
  /** 已经消毒过一遍、又被脚本改过的 HTML（DEV_NOTES §9.5 显示接口）：class 不再加 custom- 前缀 */
  MESSAGE_KEEP_CLASSES?: boolean;
}

export type MessageSanitizer = (html: string, overrides?: MessageSanitizeConfig) => string;

/** ST messageFormatting 里给 DOMPurify 的配置 */
export const MESSAGE_SANITIZE_BASE: MessageSanitizeConfig = {
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
  RETURN_TRUSTED_TYPE: false,
  MESSAGE_SANITIZE: true,
  ADD_TAGS: ['custom-style'],
};

export function createMessageSanitizer(
  win: Window & typeof globalThis,
  options: MessageSanitizerOptions,
): MessageSanitizer {
  const purify: DOMPurify = createDOMPurify(win);
  const doc = win.document;

  // 链接一律新窗口打开
  purify.addHook('afterSanitizeAttributes', (node) => {
    if ('target' in node) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener');
    }
  });

  purify.addHook('uponSanitizeAttribute', (node, data, config) => {
    const cfg = config as MessageSanitizeConfig;
    if (!cfg.MESSAGE_SANITIZE) return;
    const permittedNodeTypes = ['BUTTON', 'DIV'];
    if (
      cfg.MESSAGE_ALLOW_SYSTEM_UI &&
      node.classList.contains('menu_button') &&
      permittedNodeTypes.includes(node.nodeName)
    ) {
      return;
    }
    if (data.attrName === 'class' && data.attrValue && !cfg.MESSAGE_KEEP_CLASSES) {
      data.attrValue = data.attrValue
        .split(' ')
        .map((v) =>
          v.startsWith('fa-') || v.startsWith('note-') || v === 'monospace' ? v : 'custom-' + v,
        )
        .join(' ');
    }
  });

  purify.addHook('uponSanitizeElement', (node, _data, config) => {
    const cfg = config as MessageSanitizeConfig;
    if (!cfg.MESSAGE_SANITIZE) return;

    // 未知元素里的换行 → <br>
    if (node instanceof win.HTMLUnknownElement) {
      node.innerHTML = node.innerHTML.trim();
      const candidates: Text[] = [];
      const walker = doc.createTreeWalker(node, win.NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const textNode = walker.currentNode as Text;
        if (!textNode.data.includes('\n')) continue;
        if (textNode.parentElement && textNode.parentElement.closest('pre')) continue;
        candidates.push(textNode);
      }
      for (const textNode of candidates) {
        const parts = textNode.data.split('\n');
        const frag = doc.createDocumentFragment();
        parts.forEach((part, idx) => {
          if (part.length) frag.appendChild(doc.createTextNode(part));
          if (idx < parts.length - 1) frag.appendChild(doc.createElement('br'));
        });
        textNode.replaceWith(frag);
      }
    }

    if (options.mediaAllowed()) return;
    if (!(node instanceof win.Element)) return;

    let mediaBlocked = false;
    switch (node.tagName) {
      case 'AUDIO':
      case 'VIDEO':
      case 'SOURCE':
      case 'TRACK':
      case 'EMBED':
      case 'OBJECT':
      case 'IMG': {
        const origin = win.location.origin;
        const isExternalUrl = (url: string) =>
          (url.indexOf('://') > 0 || url.indexOf('//') === 0) && !url.startsWith(origin);
        const src = node.getAttribute('src');
        const data = node.getAttribute('data');
        const srcset = node.getAttribute('srcset');
        if (srcset) {
          for (const srcsetUrl of srcset.split(',')) {
            const [url] = srcsetUrl.trim().split(' ');
            if (url && isExternalUrl(url)) {
              node.remove();
              mediaBlocked = true;
              break;
            }
          }
        }
        if (src && isExternalUrl(src)) {
          mediaBlocked = true;
          node.remove();
        }
        if (data && isExternalUrl(data)) {
          mediaBlocked = true;
          node.remove();
        }
        if (mediaBlocked && node instanceof win.HTMLMediaElement) {
          node.autoplay = false;
          node.pause();
        }
        break;
      }
    }
  });

  return (html, overrides = {}) =>
    purify.sanitize(html, { ...MESSAGE_SANITIZE_BASE, ...overrides } as Config) as string;
}
