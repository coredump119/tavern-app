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

class ThemeStore {
  current = $state<Theme>(load());
  readonly builtins = BUILTIN_THEMES;
  imported = $state<Theme[]>(loadImported());

  constructor() {
    $effect.root(() => {
      $effect(() => {
        applyTheme(this.current);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(this.current));
        } catch {
          /* storage unavailable */
        }
      });
      // edits to an imported theme stick to its list entry (matched by name)
      $effect(() => {
        const cur = $state.snapshot(this.current) as Theme;
        untrack(() => {
          const i = this.imported.findIndex((t) => t.name === cur.name);
          if (i >= 0) this.imported[i] = cur;
        });
      });
      $effect(() => {
        try {
          localStorage.setItem(IMPORTED_KEY, JSON.stringify(this.imported));
        } catch {
          /* storage unavailable or full */
        }
      });
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
