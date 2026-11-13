<script lang="ts">
  /**
   * Extensions page (DEV_NOTES §9.34): what is installed, on / off, install from a zip or a GitHub address, update, remove,
   * why something did not load, which ST interfaces the loaded ones miss, and the panels the
   * extensions draw themselves. Stays mounted while hidden: `#extensions_settings` belongs to them.
   */
  import { permissionSummary, type ExtensionManifest } from '@tm/st-compat';
  import Button from '@tm/ui/components/Button.svelte';
  import { extensionHost as host } from '../lib/ext/host.svelte';
  import { pickFiles, withStagedPick } from '../lib/files';
  import type { ExtensionInfo } from '../lib/ipc';
  import { askPopup } from '../lib/popup.svelte';

  interface Props {
    /** this page is the one on screen */
    active: boolean;
  }
  let { active }: Props = $props();

  const INSTALL_WARNING =
    '扩展是别人写的代码。装上以后它能读写这个应用里的全部数据（聊天、角色、设置），也能联网。只装你信得过的来源。';
  const KIND_LABEL: Record<string, string> = {
    context: 'getContext',
    module: '模块导入',
    api: '服务端接口',
    global: '全局对象',
  };

  interface Row {
    name: string;
    displayName: string;
    meta: string;
    on: boolean;
    /** enabled, but it cannot load: the switch would do nothing */
    stuck: boolean;
    problem: string | null;
  }
  const rows = $derived.by((): Row[] => {
    const { load, disabled, skipped } = host.plan;
    const meta = (version: unknown, author: unknown) =>
      [typeof version === 'string' && version ? `v${version}` : '', author]
        .filter((part) => typeof part === 'string' && part)
        .join(' · ');
    return [
      ...load.map((e) => ({
        name: e.name,
        displayName: e.displayName,
        meta: meta(e.manifest.version, e.manifest.author),
        on: true,
        stuck: false,
        problem: host.errors[e.name] ?? null,
      })),
      ...skipped.map((e) => ({
        name: e.name,
        displayName: e.displayName,
        meta: '',
        on: true,
        stuck: true,
        problem: e.reason,
      })),
      ...disabled.map((e) => ({
        name: e.name,
        displayName: e.displayName,
        meta: meta(e.manifest.version, e.manifest.author),
        on: false,
        stuck: false,
        problem: null,
      })),
    ];
  });

  async function install() {
    const [path] = await pickFiles({ extensions: ['zip'], title: '选择扩展 zip' });
    if (!path) return;
    // the confirm can stay open longer than the picker keeps its file
    const info = await withStagedPick(path, async (zip) => {
      const ok = await askPopup({
        kind: 'confirm',
        title: '安装扩展',
        text: INSTALL_WARNING,
        okButton: '安装',
      });
      return ok === true ? host.install(zip) : null;
    });
    await installed(info);
  }

  /** Files are in place and nothing of it has run yet: say what it is, offer the reload. */
  async function installed(info: ExtensionInfo | null) {
    if (!info) return;
    const manifest = (info.manifest ?? null) as ExtensionManifest | null;
    const title = manifest?.display_name || info.name;
    const by = [manifest?.version && `v${manifest.version}`, manifest?.author]
      .filter(Boolean)
      .join(' · ');
    const lines = permissionSummary(manifest, info.imports).map((line) => `· ${line}`);
    const reload = await askPopup({
      kind: 'confirm',
      title: `已安装「${title}」`,
      text: [by, ...lines, '重新载入页面后它才开始运行。'].filter(Boolean).join('\n'),
      okButton: '重新载入',
      cancelButton: '稍后',
    });
    if (reload === true) await host.reload();
  }

  /** name → the repository address it came from (only those installed from one) */
  const sources = $derived(new Map(host.installed.map((e) => [e.name, e.source])));

  async function installFromGithub() {
    const url = await askPopup({
      kind: 'input',
      title: '从 GitHub 地址安装',
      text: `粘贴扩展的仓库地址，例如 https://github.com/作者/仓库。\n${INSTALL_WARNING}`,
      okButton: '安装',
      literal: true,
    });
    if (typeof url === 'string' && url.trim())
      await installed(await host.installFromGithub(url.trim()));
  }

  async function update(row: Row, source: string) {
    const ok = await askPopup({
      kind: 'confirm',
      title: '更新扩展',
      text: `从 ${source} 重新下载「${row.displayName}」并替换现有文件？存在设置里的配置保留。`,
      okButton: '更新',
    });
    if (ok === true) await installed(await host.installFromGithub(source));
  }

  async function remove(row: Row) {
    const ok = await askPopup({
      kind: 'confirm',
      title: '删除扩展',
      text: `删除「${row.displayName}」？它的文件会从数据目录里删掉，存在设置里的配置保留。`,
      okButton: '删除',
    });
    if (ok === true) await host.remove(row.name);
  }
</script>

<section class="tm-form drawer-content" class:tm-ext--hidden={!active} id="rm_extensions_block">
  {#if host.status === 'unavailable' && !host.error}
    <p class="tm-form__hint">扩展需要在 app 里运行。</p>
  {:else}
    {#if host.error}
      <p class="tm-form__error" role="alert">
        <span>{host.error}</span><button class="tm-form__link" onclick={() => (host.error = null)}
          >关闭</button
        >
      </p>
    {/if}
    {#if host.reloadNeeded}
      <p class="tm-form__notice">
        <span>改动要重新载入页面才生效（已加载的扩展没法原地卸掉）。</span>
        <button class="tm-form__link" onclick={() => host.reload()}>重新载入</button>
      </p>
    {/if}

    <div class="tm-form__section">
      <h2 class="tm-form__heading"><span>已安装</span><small>{rows.length}</small></h2>
      {#if rows.length === 0}
        <p class="tm-form__hint">还没有扩展。</p>
      {:else}
        <div class="tm-form__list">
          {#each rows as row (row.name)}
            <div class="tm-form__item" class:is-off={!row.on}>
              <input
                type="checkbox"
                aria-label="启用"
                checked={row.on}
                disabled={row.stuck || host.busy}
                onchange={(e) => host.setEnabled(row.name, e.currentTarget.checked)}
              />
              <span class="tm-ext__text">
                <span class="tm-form__item-name">{row.displayName}</span>
                {#if row.meta}<span class="tm-form__item-meta">{row.meta}</span>{/if}
                {#if row.problem}<span class="tm-form__item-meta tm-ext__problem"
                    >{row.problem}</span
                  >{/if}
              </span>
              <span class="tm-form__item-actions">
                {#if sources.get(row.name)}
                  {@const source = sources.get(row.name) ?? ''}
                  <button
                    class="tm-form__chip"
                    disabled={host.busy}
                    onclick={() => update(row, source)}>更新</button
                  >
                {/if}
                <button
                  class="tm-form__chip tm-form__chip--danger"
                  disabled={host.busy}
                  onclick={() => remove(row)}>删除</button
                >
              </span>
            </div>
          {/each}
        </div>
      {/if}
      <div class="tm-form__actions">
        <Button variant="outline" size="sm" disabled={host.busy} onclick={install}
          >从 zip 安装</Button
        >
        <Button variant="outline" size="sm" disabled={host.busy} onclick={installFromGithub}
          >从 GitHub 地址安装</Button
        >
        {#if host.busy}<span class="tm-form__hint">处理中…</span>{/if}
        {#if host.status === 'starting'}<span class="tm-form__hint">正在加载扩展…</span>{/if}
      </div>
      <p class="tm-form__hint">
        装的是酒馆的第三方扩展（<code>manifest.json</code> + 入口脚本）。兼容层按酒馆 1.18.0 的接口一项项补，没补到的会列在下面。
      </p>
    </div>

    {#if host.crashes.length > 0}
      <details class="tm-form__section tm-ext__missing">
        <summary class="tm-form__heading"
          ><span>运行时报错</span><small>{host.crashes.length}</small></summary
        >
        <p class="tm-form__hint">扩展加载以后自己抛出、没人接的错误；每个扩展只留最早的几条。</p>
        <ul class="tm-ext__missing-list">
          {#each host.crashes as crash (crash.name + crash.message)}
            <li>
              <span class="tm-form__item-meta">{crash.name}</span>
              <code class="tm-ext__problem">{crash.message}</code>
            </li>
          {/each}
        </ul>
      </details>
    {/if}

    {#if host.missing.length > 0}
      <details class="tm-form__section tm-ext__missing">
        <summary class="tm-form__heading"
          ><span>缺的接口</span><small>{host.missing.length}</small></summary
        >
        <p class="tm-form__hint">
          已加载的扩展用到了、但这个应用还没有的酒馆接口；对应的功能可能不工作。
        </p>
        <ul class="tm-ext__missing-list">
          {#each host.missing as entry (entry.kind + entry.name)}
            <li>
              <span class="tm-form__item-meta">{KIND_LABEL[entry.kind] ?? entry.kind}</span>
              <code>{entry.name}</code>
              {#if entry.count > 1}<span class="tm-form__item-meta">×{entry.count}</span>{/if}
            </li>
          {/each}
        </ul>
      </details>
    {/if}
  {/if}

  <!-- ST's two settings columns; extensions append their own panels -->
  <div class="extensions_block tm-ext__panels">
    <div id="extensions_settings"></div>
    <div id="extensions_settings2"></div>
  </div>
</section>

<style>
  .tm-ext--hidden {
    display: none;
  }
  .tm-ext__text {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-1);
    min-width: 0;
  }
  .tm-ext__problem {
    color: var(--tm-color-danger);
    overflow-wrap: anywhere;
  }
  .tm-ext__missing > summary {
    cursor: pointer;
  }
  /* the label sits next to the disclosure marker, the count stays at the far end */
  .tm-ext__missing > summary > span {
    flex: 1;
  }
  .tm-ext__missing-list {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-1);
    font-size: var(--tm-text-xs);
  }
  .tm-ext__missing-list li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--tm-space-2);
  }
  .tm-ext__missing-list code {
    font-family: var(--tm-font-mono);
    overflow-wrap: anywhere;
  }
  .tm-ext__panels {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-3);
  }
</style>
