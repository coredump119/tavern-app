import { untrack } from 'svelte';
import {
  applyTheme,
  BUILTIN_THEMES,
  exportStTheme,
  importAnyThemes,
  parseTheme,
  type Theme,
  type ThemeInput,
} from '@tm/ui';

const STORAGE_KEY = 'tm.theme.v1';
/** imported themes (ST / tm-theme files) so the list survives a relaunch */
const IMPORTED_KEY = 'tm.theme.imported.v1';
/** edits made to a built-in theme, by name, so switching away and back keeps them (DEV_NOTES §9.41) */
const EDITED_KEY = 'tm.theme.edited.v1';

function loadEdited(): Record<string, Theme> {
  const out: Record<string, Theme> = {};
  try {
    const raw = localStorage.getItem(EDITED_KEY);
    const map: unknown = raw ? JSON.parse(raw) : null;
    if (!map || typeof map !== 'object') return out;
    for (const [name, item] of Object.entries(map)) {
      if (!BUILTIN_THEMES.some((t) => t.name === name)) continue;
      try {
        out[name] = parseTheme(item);
      } catch {
        /* skip a corrupt entry */
      }
    }
  } catch {
    /* fall through to none */
  }
  return out;
}

function loadImported(): Theme[] {
  try {
    const raw = localStorage.getItem(IMPORTED_KEY);
    if (!raw) return [];
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const out: Theme[] = [];
    for (const item of list) {
      try {
        out.push(parseTheme(item));
      } catch {
        /* skip a corrupt entry */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function load(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return parseTheme(JSON.parse(raw));
  } catch {
    /* fall through to default */
  }
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  return BUILTIN_THEMES[prefersDark ? 1 : 0]!;
}

/**
 * Keep `key` in step with `value()`, except at startup: what was just loaded is not written back.
 * A read that came back empty or unreadable once (it happened on the simulator) would otherwise
 * replace the stored selection, or the whole list of imported themes, with the fallback
 * (DEV_NOTES §9.44). Call inside an effect root.
 */
function persistAfterStart(key: string, value: () => unknown): void {
  let started = false;
  $effect(() => {
    const text = JSON.stringify(value());
    if (!started) {
      started = true;
      return;
    }
    try {
      localStorage.setItem(key, text);
    } catch {
      /* storage unavailable or full */
    }
  });
}

class ThemeStore {
  current = $state<Theme>(load());
  edited = $state<Record<string, Theme>>(loadEdited());
  /** built-in themes as the list shows them: the user's edited copy when there is one */
  readonly builtins = $derived(BUILTIN_THEMES.map((t) => this.edited[t.name] ?? t));
  imported = $state<Theme[]>(loadImported());

  constructor() {
    $effect.root(() => {
      $effect(() => {
        applyTheme(this.current);
      });
      // edits to an imported theme stick to its list entry (matched by name)
      $effect(() => {
        const cur = $state.snapshot(this.current) as Theme;
        untrack(() => {
          const i = this.imported.findIndex((t) => t.name === cur.name);
          if (i >= 0) {
            this.imported[i] = cur;
            return;
          }
          // same for a built-in one: keep the edited copy, drop it once it matches the original again
          const base = BUILTIN_THEMES.find((t) => t.name === cur.name);
          if (!base) return;
          if (JSON.stringify(cur) === JSON.stringify(base)) delete this.edited[cur.name];
          else this.edited[cur.name] = cur;
        });
      });
      persistAfterStart(STORAGE_KEY, () => this.current);
      persistAfterStart(IMPORTED_KEY, () => this.imported);
      persistAfterStart(EDITED_KEY, () => this.edited);
    });
  }

  set(theme: Theme) {
    this.current = theme;
  }

  /** Shallow-merge a partial edit and re-validate. */
  patch(edit: Partial<ThemeInput>) {
    const next = structuredClone($state.snapshot(this.current)) as Record<string, unknown>;
    for (const [k, v] of Object.entries(edit)) {
      const cur = next[k];
      next[k] = cur && typeof cur === 'object' && v && typeof v === 'object' ? { ...cur, ...v } : v;
    }
    this.current = parseTheme(next);
  }

  /**
   * Accepts a tm-theme or an ST theme JSON text (an ST theme with a dark `custom_css` block yields
   * a light + `· 夜间` pair). Selects the variant matching the system scheme. Throws on invalid input.
   */
  importJson(text: string): Theme[] {
    const themes = importAnyThemes(JSON.parse(text));
    const names = new Set(themes.map((t) => t.name));
    this.imported = [...this.imported.filter((t) => !names.has(t.name)), ...themes];
    const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
    this.current =
      themes.find((t) => t.appearance === (prefersDark ? 'dark' : 'light')) ?? themes[0]!;
    return themes;
  }

  isEdited(name: string): boolean {
    return name in this.edited;
  }

  /** Throw away the edits made to a built-in theme. */
  resetBuiltin(name: string) {
    const base = BUILTIN_THEMES.find((t) => t.name === name);
    if (!base) return;
    delete this.edited[name];
    if (this.current.name === name) this.current = base;
  }

  removeImported(name: string) {
    this.imported = this.imported.filter((t) => t.name !== name);
  }

  exportTm(): string {
    return JSON.stringify($state.snapshot(this.current), null, 2);
  }

  exportSt(): string {
    return JSON.stringify(exportStTheme($state.snapshot(this.current)), null, 2);
  }
}

export const themeStore = new ThemeStore();
