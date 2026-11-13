/**
 * Extension manifests and the load order (ST `extensions.js` `activateExtensions`, DEV_NOTES §9.34).
 * Pure: the app does the script / stylesheet injection.
 */

/** ST's `manifest.json`; every field optional, unknown fields ignored. */
export interface ExtensionManifest {
  display_name?: string;
  loading_order?: number;
  requires?: unknown;
  optional?: unknown;
  dependencies?: unknown;
  js?: string;
  css?: string;
  author?: string;
  version?: string;
  homePage?: string;
  auto_update?: boolean;
  minimum_client_version?: string;
  generate_interceptor?: string;
  hooks?: Record<string, unknown>;
}

/** One installed folder, as `extension_list` reports it. */
export interface InstalledExtension {
  name: string;
  manifest: unknown;
  error: string | null;
}

export interface PlannedExtension {
  /** folder name */
  name: string;
  /** ST's id for a third-party extension: `third-party/<name>` */
  id: string;
  displayName: string;
  manifest: ExtensionManifest;
}

export interface SkippedExtension {
  name: string;
  displayName: string;
  reason: string;
}

export interface LoadPlan {
  /** in load order */
  load: PlannedExtension[];
  skipped: SkippedExtension[];
  disabled: PlannedExtension[];
}

/** ST built-in extensions this app covers natively, so a `dependencies` entry naming one is met. */
const HOST_PROVIDED: ReadonlySet<string> = new Set(['regex']);

export const THIRD_PARTY = 'third-party/';
export const extensionId = (name: string) => `${THIRD_PARTY}${name}`;

/** ST `versionCompare`: true when `version` is at least `minimum`. */
export function versionAtLeast(version: string, minimum: string): boolean {
  return (
    (version || '0.0.0').localeCompare(minimum, undefined, {
      numeric: true,
      sensitivity: 'base',
    }) > -1
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function readManifest(raw: unknown): ExtensionManifest | null {
  return isRecord(raw) ? (raw as ExtensionManifest) : null;
}

/** ST `sortManifestsByOrder`; a missing `loading_order` sorts last instead of poisoning the compare with NaN. */
function byOrder(a: PlannedExtension, b: PlannedExtension): number {
  const order = (m: ExtensionManifest) => {
    const n = Number.parseInt(String(m.loading_order), 10);
    return Number.isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
  };
  return (
    order(a.manifest) - order(b.manifest) ||
    a.displayName.localeCompare(b.displayName) ||
    a.name.localeCompare(b.name)
  );
}

/**
 * Which installed extensions load, in what order, and why the others do not.
 * `disabled` is ST's `extension_settings.disabledExtensions` (`third-party/<name>` ids).
 */
export function planLoad(
  installed: readonly InstalledExtension[],
  disabled: readonly string[],
  clientVersion: string,
): LoadPlan {
  const plan: LoadPlan = { load: [], skipped: [], disabled: [] };
  const off = new Set(disabled);
  const known: PlannedExtension[] = [];
  for (const { name, manifest: raw, error } of installed) {
    const manifest = readManifest(raw);
    if (!manifest) {
      plan.skipped.push({ name, displayName: name, reason: error ?? 'manifest.json 无法读取' });
      continue;
    }
    const displayName =
      typeof manifest.display_name === 'string' && manifest.display_name
        ? manifest.display_name
        : name;
    known.push({ name, id: extensionId(name), displayName, manifest });
  }
  known.sort(byOrder);
  const ids = new Set(known.map((e) => e.id));

  for (const extension of known) {
    const { manifest, name, displayName, id } = extension;
    if (off.has(id)) {
      plan.disabled.push(extension);
      continue;
    }
    const skip = (reason: string) => plan.skipped.push({ name, displayName, reason });
    const minimum = manifest.minimum_client_version;
    if (typeof minimum === 'string' && !versionAtLeast(clientVersion, minimum)) {
      skip(`需要酒馆 ${minimum}，当前兼容到 ${clientVersion}`);
      continue;
    }
    if (Array.isArray(manifest.requires) && manifest.requires.length > 0) {
      skip(`需要 Extras 模块：${manifest.requires.join('、')}（本应用没有 Extras）`);
      continue;
    }
    if (Array.isArray(manifest.dependencies)) {
      const wanted = manifest.dependencies.filter((d): d is string => typeof d === 'string');
      const missing = wanted.filter((d) => !ids.has(d) && !HOST_PROVIDED.has(d));
      if (missing.length > 0) {
        skip(`缺少依赖的扩展：${missing.join('、')}`);
        continue;
      }
      const stopped = wanted.filter((d) => off.has(d));
      if (stopped.length > 0) {
        skip(`依赖的扩展被停用：${stopped.join('、')}`);
        continue;
      }
    }
    plan.load.push(extension);
  }
  return plan;
}

/** URL path of a file inside an extension, the layout ST serves (`/scripts/extensions/third-party/<name>/…`). */
export function extensionPath(name: string, file = ''): string {
  return `/scripts/extensions/${THIRD_PARTY}${name}/${file.replace(/^\.?\/+/, '')}`;
}

/** ST `sanitizeSelector` for the `<script>` / `<link>` ids (`<id>-js`, `<id>-css`). */
export function elementId(id: string, suffix: 'js' | 'css'): string {
  return `${id}-${suffix}`.replace(/[^a-z0-9_-]/gi, '_');
}
