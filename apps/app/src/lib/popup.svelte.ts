/**
 * Dialogs asked for from outside a page: slash commands (`/popup`, `/input`, `/buttons`) and the
 * `custom_api` confirmation (DEV_NOTES §9.5 第 3 轮). One at a time: a second request waits for
 * the first to close. `PopupHost.svelte` draws `popups.current`.
 */

interface PopupBase {
  /** plain text, shown as is */
  text: string;
  /** small line above the text */
  title?: string;
}

export type PopupRequest =
  | (PopupBase & { kind: 'confirm'; okButton?: string; cancelButton?: string })
  | (PopupBase & {
      kind: 'input';
      value?: string;
      /** an address or an id: no auto-capitalising, no autocorrect, no spell check */
      literal?: boolean;
      rows?: number;
      okButton?: string;
      cancelButton?: string;
    })
  | (PopupBase & { kind: 'buttons'; labels: readonly string[] });

/** `confirm`: true / false; `input`: the text; `buttons`: the chosen label. Null when dismissed. */
export type PopupResult = boolean | string | null;

interface Pending {
  request: PopupRequest;
  resolve(result: PopupResult): void;
}

class Popups {
  private queue = $state.raw<readonly Pending[]>([]);

  get current(): PopupRequest | null {
    return this.queue[0]?.request ?? null;
  }

  ask(request: PopupRequest): Promise<PopupResult> {
    return new Promise((resolve) => {
      this.queue = [...this.queue, { request, resolve }];
    });
  }

  /** Close the dialog on screen with its answer */
  answer(result: PopupResult): void {
    const [head, ...rest] = this.queue;
    if (!head) return;
    this.queue = rest;
    head.resolve(result);
  }
}

export const popups = new Popups();

export const askPopup = (request: PopupRequest): Promise<PopupResult> => popups.ask(request);
