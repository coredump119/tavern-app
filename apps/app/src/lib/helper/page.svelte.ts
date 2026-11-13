/**
 * The app's side of the stand-in page (DEV_NOTES §9.5 第 3 轮 → DOM): the CSS scripts added to
 * it, and what the chat page reports for the realm to mirror (the input box, whether a reply is
 * being generated).
 */
import { scopeScriptCss } from '@tm/ui';

const STYLE_ID = 'tm-script-page-css';
/** style sheets of honest scripts stay far below this */
const MAX_CSS = 500_000;

class HelperPage {
  /** the chat page's input box; '' while the page is not on screen */
  draft = $state('');
  generating = $state(false);

  /** Replace the CSS scripts added to the page; '' removes it */
  setStyle(css: string): void {
    if (css.length > MAX_CSS) throw new Error('样式过大');
    const scoped = scopeScriptCss(css);
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!scoped) {
      style?.remove();
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      document.head.append(style);
    }
    if (style.textContent !== scoped) style.textContent = scoped;
  }

  /** The hub went away: nothing of its scripts stays on the page */
  reset(): void {
    this.setStyle('');
  }
}

export const helperPage = new HelperPage();
