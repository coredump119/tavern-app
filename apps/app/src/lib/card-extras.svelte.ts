/**
 * What a card brings besides the character: an embedded world book and regex scripts. ST asks
 * about each the first time the character is opened (world-info.js `checkEmbeddedWorld`, the regex
 * extension's `checkEmbeddedRegexScripts`) and remembers that it asked under the same storage keys.
 * We ask right after an import, and when a chat opens for cards that got in another way
 * (DEV_NOTES §9.41).
 */
import { isScopedRegexAllowed, setScopedRegexAllowed } from '@tm/core';
import { chatStore } from './chat/store.svelte';
import { loadCharacter, saveCharacter } from './characters';
import { askPopup } from './popup.svelte';
import { extOf } from './regex';
import { embeddedWorldName, importEmbeddedWorld, listWorldNames } from './worlds';

type Obj = Record<string, unknown>;
const record = (v: unknown): Obj | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null;

/** ST's "already asked" markers */
const worldKey = (avatar: string) => `AlertWI_${avatar}`;
const regexKey = (avatar: string) => `AlertRegex_${avatar}`;
function asked(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return true; // no storage: do not ask on every open
  }
}
function markAsked(key: string): void {
  try {
    localStorage.setItem(key, 'true');
  } catch {
    /* storage unavailable */
  }
}

/** one card at a time: a second open while a question is up waits for it */
let chain: Promise<unknown> = Promise.resolve();

/**
 * Ask once per card whether to import its embedded world book and whether to turn its regex
 * scripts on. Returns what was done, for a notice.
 */
export function offerCardExtras(avatar: string): Promise<string[]> {
  const run = chain.then(() => offer(avatar));
  chain = run.catch(() => undefined);
  return run;
}

async function offer(avatar: string): Promise<string[]> {
  const store = chatStore;
  const root = store.root;
  const done: string[] = [];
  if (!root) return done;
  let loaded = await loadCharacter(root, avatar);
  const who = loaded.form.ch_name || avatar.replace(/\.png$/i, '');

  const world = embeddedWorldName(loaded.raw);
  if (world && !asked(worldKey(avatar))) {
    const linked = loaded.form.world ?? '';
    if (!linked || !(await listWorldNames(root)).includes(linked)) {
      markAsked(worldKey(avatar));
      const book = record(record(loaded.raw['data'])?.['character_book']);
      const count = Array.isArray(book?.['entries']) ? book['entries'].length : 0;
      const yes = await askPopup({
        kind: 'confirm',
        title: '导入角色自带的世界书',
        text: `「${who}」自带一本世界书（${count} 条）。导入后会存成「${world}」并自动用在这个角色的聊天里。`,
        okButton: '导入',
        cancelButton: '先不导入',
      });
      if (yes === true) {
        const name = await importEmbeddedWorld(root, loaded.raw);
        const out = await saveCharacter(root, loaded, { ...loaded.form, world: name });
        loaded = { ...loaded, raw: out };
        await store.refreshCharacters();
        if (store.character?.avatar === avatar) await store.reloadCharacter();
        done.push(`已导入世界书「${name}」`);
      }
    }
  }

  const ext = record(record(loaded.raw['data'])?.['extensions']);
  const scripts = Array.isArray(ext?.['regex_scripts']) ? ext['regex_scripts'] : [];
  if (scripts.length > 0 && store.settings && !asked(regexKey(avatar))) {
    const current = $state.snapshot(store.settings) as Obj;
    if (!isScopedRegexAllowed(extOf(structuredClone(current)), avatar)) {
      markAsked(regexKey(avatar));
      const yes = await askPopup({
        kind: 'confirm',
        title: '开启角色自带的正则',
        text: `「${who}」自带 ${scripts.length} 条正则脚本（卡片作者配的显示 / 文本处理规则）。开启后这个角色的聊天会用上它们，之后可以在「正则脚本」里关掉。`,
        okButton: '开启',
        cancelButton: '先不开',
      });
      if (yes === true && store.settings) {
        const next = structuredClone($state.snapshot(store.settings)) as Obj;
        setScopedRegexAllowed(extOf(next), avatar, true);
        await store.saveSettings(next);
        done.push(`已开启 ${scripts.length} 条角色正则`);
      }
    }
  }
  return done;
}
