/**
 * Short notices on top of the page. Drawn by `ToastHost.svelte`; ST extensions reach it through
 * the `toastr` stand-in (DEV_NOTES §9.34).
 */
export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  text: string;
}

const DEFAULT_TIMEOUT = 4000;
/** a burst of notices must not cover the page */
const MAX_SHOWN = 4;

class Toasts {
  list = $state.raw<readonly Toast[]>([]);
  private nextId = 1;

  /** `timeout` 0 keeps it until tapped */
  show(kind: ToastKind, text: string, title = '', timeout = DEFAULT_TIMEOUT): number {
    const id = this.nextId++;
    this.list = [...this.list, { id, kind, title, text }].slice(-MAX_SHOWN);
    if (timeout > 0) setTimeout(() => this.dismiss(id), timeout);
    return id;
  }

  dismiss(id: number): void {
    if (this.list.some((toast) => toast.id === id)) {
      this.list = this.list.filter((toast) => toast.id !== id);
    }
  }

  clear(): void {
    if (this.list.length > 0) this.list = [];
  }
}

export const toasts = new Toasts();
