/**
 * ST's `Popup` for extensions (popup.js contract, DEV_NOTES §9.34): a real `<dialog class="popup">`
 * with ST's class names, because extensions put their own HTML and controls into it and reach for
 * `popup.dlg` / `popup.content`. Text, confirm, input and display types; no cropper.
 */
import { POPUP_RESULT, POPUP_TYPE } from '@tm/st-compat';

type PopupValue = string | number | boolean | null | undefined;

export interface CustomPopupButton {
  text: string;
  result?: number | null;
  classes?: string[];
  action?: () => void;
  appendAtEnd?: boolean;
}

export interface PopupOptions {
  okButton?: string | boolean | null;
  cancelButton?: string | boolean | null;
  rows?: number;
  placeholder?: string | null;
  wide?: boolean;
  wider?: boolean;
  large?: boolean;
  transparent?: boolean;
  allowHorizontalScrolling?: boolean;
  allowVerticalScrolling?: boolean;
  leftAlign?: boolean;
  defaultResult?: number;
  customButtons?: (string | CustomPopupButton)[] | null;
  allowEscapeClose?: boolean;
  onClosing?: ((popup: Popup) => boolean | Promise<boolean>) | null;
  onClose?: ((popup: Popup) => void | Promise<void>) | null;
  onOpen?: ((popup: Popup) => void) | null;
}

const SIZE_CLASSES: readonly [keyof PopupOptions, string][] = [
  ['wide', 'wide_dialogue_popup'],
  ['wider', 'wider_dialogue_popup'],
  ['large', 'large_dialogue_popup'],
  ['transparent', 'transparent_dialogue_popup'],
  ['allowHorizontalScrolling', 'horizontal_scrolling_dialogue_popup'],
  ['allowVerticalScrolling', 'vertical_scrolling_dialogue_popup'],
  ['leftAlign', 'left_aligned_dialogue_popup'],
];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string) => {
  const node = document.createElement(tag);
  node.className = className;
  return node;
};

/** jQuery objects come from the extension's own copy of `$`: told apart by shape, not by class */
const isJQuery = (value: unknown): value is { get(): HTMLElement[] } =>
  typeof value === 'object' && value !== null && 'jquery' in value;

export class Popup {
  static readonly util = {
    popups: [] as Popup[],
    lastResult: null as { value: PopupValue; result: number | null } | null,
    isPopupOpen: () => Popup.util.popups.some((popup) => popup.dlg.open),
    getTopmostModalLayer: () =>
      Popup.util.popups.findLast((popup) => popup.dlg.open)?.dlg ?? document.body,
  };

  static readonly show = {
    input: async (
      header: string | null,
      text: string | null,
      value = '',
      options: PopupOptions = {},
    ): Promise<string | null> => {
      const answer = await new Popup(
        withHeader(header, text),
        POPUP_TYPE.INPUT,
        value,
        options,
      ).show();
      // an empty string is an answer; false / null / undefined are "cancelled"
      return answer === '' ? '' : answer ? String(answer) : null;
    },
    confirm: (header: string | null, text: string | null, options: PopupOptions = {}) =>
      new Popup(withHeader(header, text), POPUP_TYPE.CONFIRM, '', options).show(),
    text: (header: string | null, text: string | null, options: PopupOptions = {}) =>
      new Popup(withHeader(header, text), POPUP_TYPE.TEXT, '', options).show(),
  };

  readonly id = crypto.randomUUID();
  readonly dlg = el('dialog', 'popup');
  readonly body = el('div', 'popup-body');
  readonly content = el('div', 'popup-content');
  readonly mainInput = el('textarea', 'popup-input text_pole result-control auto-select');
  readonly buttonControls = el('div', 'popup-controls');
  readonly okButton = el('div', 'popup-button-ok menu_button result-control');
  readonly cancelButton = el('div', 'popup-button-cancel menu_button result-control');
  readonly closeButton = el('div', 'popup-button-close right_menu_button');
  readonly defaultResult: number;
  onClosing: PopupOptions['onClosing'];
  onClose: PopupOptions['onClose'];
  onOpen: PopupOptions['onOpen'];
  value: PopupValue;
  result: number | null | undefined;
  private resolve: ((value: PopupValue) => void) | null = null;
  private promise: Promise<PopupValue> | null = null;

  constructor(
    content: unknown,
    readonly type: number,
    inputValue = '',
    options: PopupOptions = {},
  ) {
    const { okButton = null, cancelButton = null } = options;
    this.defaultResult = options.defaultResult ?? POPUP_RESULT.AFFIRMATIVE;
    this.onClosing = options.onClosing ?? null;
    this.onClose = options.onClose ?? null;
    this.onOpen = options.onOpen ?? null;

    this.dlg.dataset['id'] = this.id;
    for (const [option, cls] of SIZE_CLASSES) if (options[option]) this.dlg.classList.add(cls);

    this.okButton.dataset['result'] = String(POPUP_RESULT.AFFIRMATIVE);
    this.cancelButton.dataset['result'] = String(POPUP_RESULT.NEGATIVE);
    this.closeButton.dataset['result'] = String(POPUP_RESULT.NEGATIVE);
    this.closeButton.title = '关闭';
    this.closeButton.textContent = '×';
    this.okButton.textContent = typeof okButton === 'string' ? okButton : '确定';
    this.cancelButton.textContent = typeof cancelButton === 'string' ? cancelButton : '取消';
    this.buttonControls.append(this.okButton, this.cancelButton);

    options.customButtons?.forEach((entry, index) => {
      const button = typeof entry === 'string' ? { text: entry, result: index + 2 } : entry;
      const node = el('div', 'menu_button popup-button-custom result-control');
      node.classList.add(...(button.classes ?? []));
      // 'null' is cancel, 'undefined' is "no result": ST writes both into the attribute
      node.dataset['result'] = String(button.result);
      node.tabIndex = 0;
      node.textContent = button.text;
      if (button.appendAtEnd) this.buttonControls.append(node);
      else this.buttonControls.insertBefore(node, this.okButton);
      if (typeof button.action === 'function') node.addEventListener('click', button.action);
    });

    this.mainInput.style.display = 'none';
    this.closeButton.style.display = 'none';
    const hide = (node: HTMLElement) => (node.style.display = 'none');
    switch (type) {
      case POPUP_TYPE.TEXT:
        if (okButton === false) hide(this.okButton);
        if (!cancelButton) hide(this.cancelButton);
        break;
      case POPUP_TYPE.CONFIRM:
        if (okButton === false) hide(this.okButton);
        if (cancelButton === false) hide(this.cancelButton);
        if (!okButton) this.okButton.textContent = '是';
        if (!cancelButton) this.cancelButton.textContent = '否';
        break;
      case POPUP_TYPE.INPUT:
        this.mainInput.style.display = 'block';
        if (okButton === false) hide(this.okButton);
        if (cancelButton === false) hide(this.cancelButton);
        if (!okButton) this.okButton.textContent = '保存';
        break;
      case POPUP_TYPE.DISPLAY:
        hide(this.buttonControls);
        this.closeButton.style.display = 'block';
        break;
      default:
        console.warn('[ext] unsupported popup type', type);
    }
    this.buttonControls
      .querySelector(`[data-result="${this.defaultResult}"]`)
      ?.classList.add('menu_button_default');

    this.mainInput.value = inputValue;
    this.mainInput.rows = options.rows ?? 1;
    if (type === POPUP_TYPE.INPUT) this.mainInput.placeholder = options.placeholder ?? '';

    if (isJQuery(content)) this.content.append(...content.get());
    else if (content instanceof Node) this.content.append(content);
    else if (typeof content === 'string') this.content.innerHTML = content;

    this.body.append(this.content, this.mainInput, this.buttonControls);
    this.dlg.append(this.body, this.closeButton);

    for (const control of this.dlg.querySelectorAll<HTMLElement>('[data-result]')) {
      const raw = control.dataset['result'];
      if (raw === 'undefined') continue;
      const result = raw === 'null' ? null : Number(raw);
      if (result !== null && Number.isNaN(result)) continue;
      control.addEventListener('click', () => void this.complete(result));
    }
    // Escape / the Android back gesture
    this.dlg.addEventListener('cancel', (event) => {
      event.preventDefault();
      if (options.allowEscapeClose !== false) void this.complete(POPUP_RESULT.CANCELLED);
    });
    Popup.util.popups.push(this);
  }

  show(): Promise<PopupValue> {
    document.body.append(this.dlg);
    this.dlg.showModal();
    if (this.type === POPUP_TYPE.INPUT) this.mainInput.focus();
    this.onOpen?.(this);
    this.promise = new Promise((resolve) => (this.resolve = resolve));
    return this.promise;
  }

  async complete(result: number | null): Promise<PopupValue> {
    let value: PopupValue = result;
    if (this.type === POPUP_TYPE.INPUT) {
      if (result !== null && result >= POPUP_RESULT.AFFIRMATIVE) value = this.mainInput.value;
      else value = result === POPUP_RESULT.CANCELLED ? null : false;
    }
    this.value = value;
    this.result = result;
    if (this.onClosing && !(await this.onClosing(this))) {
      this.value = undefined;
      this.result = undefined;
      return undefined;
    }
    Popup.util.lastResult = { value, result };
    this.dlg.close();
    await this.onClose?.(this);
    this.dlg.remove();
    const at = Popup.util.popups.indexOf(this);
    if (at >= 0) Popup.util.popups.splice(at, 1);
    this.resolve?.(value);
    return this.promise ?? value;
  }
  completeAffirmative(): Promise<PopupValue> {
    return this.complete(POPUP_RESULT.AFFIRMATIVE);
  }
  completeNegative(): Promise<PopupValue> {
    return this.complete(POPUP_RESULT.NEGATIVE);
  }
  completeCancelled(): Promise<PopupValue> {
    return this.complete(POPUP_RESULT.CANCELLED);
  }
}

/** ST PopupUtils.BuildTextWithHeader: both parts are the extension's own HTML */
const withHeader = (header: string | null, text: string | null): string =>
  header ? `<h3>${header}</h3>${text ?? ''}` : (text ?? '');

/** ST callGenericPopup */
export function callGenericPopup(
  content: unknown,
  type: number,
  inputValue = '',
  options: PopupOptions = {},
): Promise<PopupValue> {
  return new Popup(content, type, inputValue, options).show();
}

const LEGACY_TYPES: Readonly<Record<string, number>> = {
  text: POPUP_TYPE.TEXT,
  confirm: POPUP_TYPE.CONFIRM,
  input: POPUP_TYPE.INPUT,
};

/**
 * ST's old `callPopup(text, type, inputValue, options)`: `confirm` answers true / false, `input`
 * the text or false. Other legacy types (avatar crop, delete character…) are ST's own pages.
 */
export async function callPopup(
  text: unknown,
  type: string,
  inputValue = '',
  options: PopupOptions = {},
): Promise<PopupValue> {
  const value = await callGenericPopup(
    text,
    LEGACY_TYPES[type] ?? POPUP_TYPE.TEXT,
    inputValue,
    options,
  );
  if (type === 'input') return typeof value === 'string' ? value : false;
  return value === POPUP_RESULT.AFFIRMATIVE;
}
