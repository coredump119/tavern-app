<script lang="ts">
  /** Line icons (1.5px stroke, currentColor) — DESIGN.md §7. Names mirror the Font Awesome ones ST uses. */
  export type IconName =
    | 'ellipsis'
    | 'pencil'
    | 'check'
    | 'copy'
    | 'trash'
    | 'chevron-up'
    | 'chevron-down'
    | 'chevron-left'
    | 'chevron-right'
    | 'xmark'
    | 'eye'
    | 'eye-slash'
    | 'bars'
    | 'wand'
    | 'arrow-right'
    | 'mask'
    | 'stop'
    | 'plus'
    | 'ghost'
    | 'star'
    | 'tag'
    | 'image'
    | 'user'
    | 'file-export'
    | 'file-lines'
    | 'flag'
    | 'flag-checkered'
    | 'code-branch'
    | 'paperclip'
    | 'arrow-left'
    | 'expand'
    | 'code';
  interface Props {
    name: IconName;
    size?: 'sm' | 'md' | 'lg';
    label?: string | undefined;
  }
  let { name, size = 'md', label }: Props = $props();
  /** Font Awesome names ST uses for the same glyphs: theme CSS selects icons by these (DEV_NOTES §9.3) */
  const FA: Record<IconName, string> = {
    ellipsis: 'fa-ellipsis',
    pencil: 'fa-pencil',
    check: 'fa-check',
    copy: 'fa-copy',
    trash: 'fa-trash-can',
    'chevron-up': 'fa-chevron-up',
    'chevron-down': 'fa-chevron-down',
    'chevron-left': 'fa-chevron-left',
    'chevron-right': 'fa-chevron-right',
    xmark: 'fa-xmark',
    eye: 'fa-eye',
    'eye-slash': 'fa-eye-slash',
    bars: 'fa-bars',
    wand: 'fa-wand-magic-sparkles',
    'arrow-right': 'fa-arrow-right',
    mask: 'fa-user-secret',
    stop: 'fa-circle-stop',
    plus: 'fa-plus',
    ghost: 'fa-ghost',
    star: 'fa-star',
    tag: 'fa-tag',
    image: 'fa-image',
    user: 'fa-user',
    'file-export': 'fa-file-export',
    'file-lines': 'fa-file-lines',
    flag: 'fa-flag',
    'flag-checkered': 'fa-flag-checkered',
    'code-branch': 'fa-code-branch',
    paperclip: 'fa-paperclip',
    'arrow-left': 'fa-arrow-left',
    expand: 'fa-magnifying-glass',
    code: 'fa-code',
  };
  const paths: Record<IconName, string> = {
    ellipsis: 'M5 12h.01M12 12h.01M19 12h.01',
    pencil: 'M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3zM13.5 6.5l3 3',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    copy: 'M9 9h10v11H9zM5 15V4h10',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
    'chevron-up': 'M6 15l6-6 6 6',
    'chevron-down': 'M6 9l6 6 6-6',
    'chevron-left': 'M15 6l-6 6 6 6',
    'chevron-right': 'M9 6l6 6-6 6',
    xmark: 'M6 6l12 12M18 6L6 18',
    eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'eye-slash':
      'M3 3l18 18M10.6 10.6A3 3 0 0 0 13.4 13.4M6.7 6.7C4 8.4 2 12 2 12s4 7 10 7c1.8 0 3.4-.4 4.8-1.1M9.9 5.2C10.6 5.1 11.3 5 12 5c6 0 10 7 10 7s-.9 1.6-2.6 3.3',
    bars: 'M4 7h16M4 12h16M4 17h16',
    wand: 'M15 4l5 5L7 22l-5-5zM14 9l1 1M19 2v2M22 5h-2M17 2l-1 1',
    'arrow-right': 'M5 12h13M13 6l6 6-6 6',
    mask: 'M4 8c0-2 3-4 8-4s8 2 8 4v4c0 5-4 8-8 8s-8-3-8-8zM8 11h2M14 11h2M9 15c1 1 5 1 6 0',
    stop: 'M7 7h10v10H7z',
    plus: 'M12 5v14M5 12h14',
    ghost: 'M5 20V11a7 7 0 0 1 14 0v9l-2.3-2-2.4 2-2.3-2-2.3 2-2.4-2zM9.5 10h.01M14.5 10h.01',
    star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.2 1 5.9L12 17l-5.2 2.8 1-5.9-4.3-4.2 5.9-.8z',
    tag: 'M3 12V4h8l9 9-8 8zM7.5 8h.01',
    image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 9h.01',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c0-3.5 3.6-6 8-6s8 2.5 8 6',
    'file-export': 'M13 3H6v18h12V8zM13 3v5h5M11 14h9M17 11l3 3-3 3',
    'file-lines': 'M13 3H6v18h12V8zM13 3v5h5M9 12h6M9 16h6',
    flag: 'M5 21V4M5 4h12l-2 4 2 4H5',
    'flag-checkered': 'M5 21V4M5 4h12l-2 4 2 4H5M9 4v8M13 4v8M5 8h12',
    'code-branch':
      'M7 4v12M7 16a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM17 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM17 10c0 4-10 2-10 6',
    paperclip:
      'M20 12.5l-7.5 7.5a5 5 0 0 1-7-7l8-8a3.3 3.3 0 0 1 4.7 4.7L10.5 17.5a1.6 1.6 0 0 1-2.3-2.3L15 8.5',
    'arrow-left': 'M19 12H6M11 6l-6 6 6 6',
    expand: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5L21 21M8 10.5h5M10.5 8v5',
    code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14',
  };
</script>

<svg
  class="tm-icon tm-icon--{size} fa-solid {FA[name]}"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden={label ? undefined : true}
  role={label ? 'img' : undefined}
  aria-label={label}
>
  <path d={paths[name]} />
</svg>

<style>
  .tm-icon {
    flex: none;
    display: inline-block;
    vertical-align: middle;
  }
  .tm-icon--sm {
    width: var(--tm-icon-sm);
    height: var(--tm-icon-sm);
  }
  .tm-icon--md {
    width: var(--tm-icon-md);
    height: var(--tm-icon-md);
  }
  .tm-icon--lg {
    width: var(--tm-icon-lg);
    height: var(--tm-icon-lg);
  }
</style>
