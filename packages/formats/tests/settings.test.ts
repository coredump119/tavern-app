import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AppSettingsSchema, parseSettings, scrubSecrets } from '../src/index.js';

const raw = JSON.parse(
  readFileSync(new URL('./fixtures/settings-default.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('settings.json', () => {
  it('parses ST default settings losslessly', () => {
    const s = parseSettings(raw);
    expect(JSON.parse(JSON.stringify(s))).toEqual(raw);
    expect(s.power_user).toBeDefined();
    expect(s.oai_settings).toBeDefined();
  });
  it('scrubs secrets the same way as Rust', () => {
    const v = {
      oai_settings: { proxy_password: 'p1', reverse_proxy: 'x' },
      proxies: [
        { name: 'a', password: 'p2' },
        { name: 'b', password: '' },
      ],
      extension_settings: { apiKey: 'k', caption: { api_key: 'c' } },
      username: 'me',
    };
    expect(scrubSecrets(v)).toEqual([
      'oai_settings.proxy_password',
      'proxies[0].password',
      'extension_settings.apiKey',
      'extension_settings.caption.api_key',
    ]);
    expect(v.oai_settings.proxy_password).toBe('');
    expect(v.oai_settings.reverse_proxy).toBe('x');
    expect(scrubSecrets(parseSettings(raw))).toEqual([]);
  });
  it('app settings default to version 1', () => {
    expect(AppSettingsSchema.parse({}).version).toBe(1);
  });
});
