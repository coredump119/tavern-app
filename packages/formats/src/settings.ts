/**
 * settings.json — ST's global settings, field names untouched. Our own settings live in
 * app_settings.json (DEV_NOTES §5.1). Secrets never stay in settings.json on disk:
 * `scrubSecrets` mirrors Rust `tm_data::settings::scrub_secrets`.
 */
import { z } from 'zod';

const str = z.string();
const rec = z.record(z.string(), z.unknown());

/** Top-level keys ST writes (COMPAT_TARGET). All optional: ST fills missing ones from defaults. */
export const SettingsSchema = z.looseObject({
  username: str.optional(),
  user_avatar: str.optional(),
  active_character: str.nullable().optional(),
  active_group: str.nullable().optional(),
  currentVersion: str.optional(),
  firstRun: z.boolean().optional(),
  main_api: str.optional(),
  amount_gen: z.number().optional(),
  max_context: z.number().optional(),
  background: rec.optional(),
  swipes: z.boolean().optional(),
  tags: z.array(rec).optional(),
  tag_map: z.record(z.string(), z.array(z.string())).optional(),
  world_info_settings: rec.optional(),
  power_user: rec.optional(),
  extension_settings: rec.optional(),
  oai_settings: rec.optional(),
  textgenerationwebui_settings: rec.optional(),
  kai_settings: rec.optional(),
  nai_settings: rec.optional(),
  horde_settings: rec.optional(),
  proxies: z.array(rec).optional(),
  selected_proxy: rec.optional(),
  accountStorage: rec.optional(),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Our own settings file. Theme is the tm-theme JSON; everything else is added as phases land. */
export const AppSettingsSchema = z.looseObject({
  version: z.literal(1).default(1),
  theme: z.unknown().optional(),
  lastCharacter: str.optional(),
  lastChat: str.optional(),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export function parseSettings(raw: unknown): Settings {
  return SettingsSchema.parse(raw);
}

export const SETTINGS_SECRET_KEYS = ['proxy_password', 'password', 'api_key', 'apiKey'] as const;

/** Blank secret strings in place; returns the json paths removed (same rule as the Rust side). */
export function scrubSecrets(value: unknown, path = ''): string[] {
  const removed: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => removed.push(...scrubSecrets(v, `${path}[${i}]`)));
  } else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const p = path ? `${path}.${k}` : k;
      if ((SETTINGS_SECRET_KEYS as readonly string[]).includes(k)) {
        if (typeof o[k] === 'string' && o[k] !== '') {
          o[k] = '';
          removed.push(p);
        }
      } else {
        removed.push(...scrubSecrets(o[k], p));
      }
    }
  }
  return removed;
}
