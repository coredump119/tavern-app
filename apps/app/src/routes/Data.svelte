<script lang="ts">
  /**
   * Data & backup page (DEV_NOTES §9.27, §9.38): where the data lives, backup in / out (plain zip
   * or password-sealed), index rebuild, the local crash log.
   */
  import { onMount } from 'svelte';
  import Button from '@tm/ui/components/Button.svelte';
  import { chatStore } from '../lib/chat/store.svelte';
  import {
    crashLogClear,
    crashLogRead,
    dataBackupSealed,
    dataList,
    indexScan,
    isTauri,
    type CrashEntry,
    type ScanReport,
  } from '../lib/ipc';
  import { pickFiles, withStagedPick } from '../lib/files';
  import {
    backupPasswordProblem,
    exportBackup,
    exportDir,
    importBackup,
    isMobilePlatform,
    WRONG_BACKUP_PASSWORD,
  } from '../lib/backup';
  import { crashLogFileName, formatCrashLog } from '../lib/crashlog';
  import { describeExport, exportText } from '../lib/export';
  import { listUserAvatars } from '../lib/personas';

  const store = chatStore;
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let counts = $state<{
    worlds: number;
    personas: number;
    ccPresets: number;
    tcPresets: number;
  } | null>(null);
  let mobileExportDir = $state<string | null>(null);
  let lastScan = $state<ScanReport | null>(null);
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // sealed export: the password lives only in these fields and is dropped after the export
  let sealExport = $state(false);
  let password = $state('');
  let passwordRepeat = $state('');
  const passwordProblem = $derived(
    sealExport ? backupPasswordProblem(password, passwordRepeat) : null,
  );
  // sealed import: the picked file waits (as our own copy) until this is answered; null = cancelled
  let passwordAsk = $state<((password: string | null) => void) | null>(null);
  let importPassword = $state('');
  /** the last password tried did not open the backup; said next to the field, where the eyes are */
  let passwordWrong = $state(false);
  let errorEl = $state<HTMLElement>();
  let noticeEl = $state<HTMLElement>();
  // the outcome is written at the top of the page, which may be scrolled away by now
  $effect(() => {
    (error ? errorEl : notice ? noticeEl : undefined)?.scrollIntoView({ block: 'nearest' });
  });

  /** entries shown in the viewer; the export carries all of them */
  const CRASH_VIEW_MAX = 20;
  let crashes = $state<CrashEntry[]>([]);
  let crashOpen = $state(false);
  let crashClearArmed = $state(false);
  const crashText = $derived(crashOpen ? formatCrashLog(crashes.slice(-CRASH_VIEW_MAX)) : '');

  async function refreshCounts() {
    if (!store.root) return;
    const [worlds, personas, cc, tc] = await Promise.all([
      dataList(store.root, 'worlds', 'json'),
      listUserAvatars(store.root),
      dataList(store.root, 'OpenAI Settings', 'json'),
      dataList(store.root, 'TextGen Settings', 'json'),
    ]);
    counts = {
      worlds: worlds.length,
      personas: personas.length,
      ccPresets: cc.length,
      tcPresets: tc.length,
    };
  }
  onMount(async () => {
    await store.init();
    try {
      await refreshCounts();
      if (await isMobilePlatform()) mobileExportDir = await exportDir();
      crashes = await crashLogRead();
    } catch (e) {
      error = msg(e);
    }
  });

  async function doExport() {
    if (!store.root) return;
    busy = '打包…';
    error = null;
    try {
      // scripts may have left changes that are not in the files yet (DEV_NOTES §9.5)
      await store.flushDeferred();
      const where = await exportBackup(store.root, sealExport ? password : null);
      notice = where ?? '已取消';
      if (where) password = passwordRepeat = '';
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }
  function askImportPassword(): Promise<string | null> {
    importPassword = '';
    return new Promise((resolve) => {
      passwordAsk = (answer) => {
        passwordAsk = null;
        importPassword = '';
        resolve(answer);
      };
    });
  }
  /** the prompt appears below the fold on a phone: bring it into view and put the caret in it */
  function revealPrompt(node: HTMLElement) {
    node.scrollIntoView({ block: 'center' });
    node.querySelector('input')?.focus({ preventScroll: true });
  }
  async function doImport() {
    const [picked] = await pickFiles({ extensions: ['zip', 'tmbackup'], title: '备份' });
    if (!picked) return;
    error = null;
    passwordWrong = false;
    try {
      // the password prompt can outlast the picker's own copy of the file
      await withStagedPick(picked, async (file) => {
        const sealed = await dataBackupSealed(file);
        for (;;) {
          const pass = sealed ? await askImportPassword() : null;
          if (sealed && pass === null) {
            notice = '已取消';
            return;
          }
          busy = sealed ? '解密并导入…' : '导入…';
          try {
            // scripts may have left changes that are not in the files yet (DEV_NOTES §9.5)
            await store.flushDeferred();
            const r = await importBackup(file, pass);
            await refreshCounts();
            notice = `导入完成：${r.files} 个文件${r.skipped.length ? `，跳过 ${r.skipped.length} 个` : ''}${
              r.secrets ? '；备份里的密钥没有写入，请在「API 连接」重新录入' : ''
            }`;
            error = null;
            return;
          } catch (e) {
            if (msg(e) !== WRONG_BACKUP_PASSWORD) throw e;
            passwordWrong = true;
          } finally {
            busy = null;
          }
        }
      });
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }
  async function exportCrashLog() {
    error = null;
    try {
      const t = await exportText(crashLogFileName(), formatCrashLog(crashes));
      notice = t ? await describeExport(t) : '已取消';
    } catch (e) {
      error = msg(e);
    }
  }
  async function clearCrashLog() {
    if (!crashClearArmed) {
      crashClearArmed = true;
      return;
    }
    crashClearArmed = false;
    try {
      await crashLogClear();
      crashes = [];
      crashOpen = false;
    } catch (e) {
      error = msg(e);
    }
  }
  async function rebuildIndex() {
    if (!store.root) return;
    busy = '重建索引…';
    error = null;
    try {
      lastScan = await indexScan(store.root, true);
      await store.refreshCharacters();
      notice = `索引已重建：${lastScan.characters_updated} 个角色、${lastScan.chats_updated} 个聊天`;
    } catch (e) {
      error = msg(e);
    } finally {
      busy = null;
    }
  }
</script>

{#if !isTauri()}
  <section class="tm-form"><p class="tm-form__hint">数据页需要在 app 里运行。</p></section>
{:else}
  <section class="tm-form drawer-content" id="data-page">
    {#if error}
      <p class="tm-form__error" role="alert" bind:this={errorEl}>
        <span>{error}</span><button class="tm-form__link" onclick={() => (error = null)}
          >关闭</button
        >
      </p>
    {/if}
    {#if notice}
      <p class="tm-form__notice" bind:this={noticeEl}>
        <span>{notice}</span><button class="tm-form__link" onclick={() => (notice = null)}
          >关闭</button
        >
      </p>
    {/if}

    <div class="tm-form__section">
      <h2 class="tm-form__heading"><span>数据目录</span></h2>
      <p class="tm-form__hint tm-data__path">{store.root}</p>
      <p class="tm-form__hint">
        和酒馆 <code>data/default-user/</code> 同一套布局：角色 {store.characters.length} · 群聊 {store
          .groups.length}{counts
          ? ` · 世界书 ${counts.worlds} · 用户设定 ${counts.personas} · 预设 ${counts.ccPresets + counts.tcPresets}`
          : ''}
      </p>
    </div>

    <div class="tm-form__section">
      <h2 class="tm-form__heading"><span>备份</span></h2>
      <label class="tm-form__check">
        <input type="checkbox" bind:checked={sealExport} disabled={!!busy} />
        <span>加密导出（设一个密码）</span>
      </label>
      {#if sealExport}
        <label class="tm-form__field">
          <span class="tm-form__label">备份密码</span>
          <input
            class="text_pole tm-form__input"
            type="password"
            autocomplete="new-password"
            autocapitalize="off"
            placeholder="至少 8 个字符"
            bind:value={password}
          />
        </label>
        <label class="tm-form__field">
          <span class="tm-form__label">再输一次</span>
          <input
            class="text_pole tm-form__input"
            type="password"
            autocomplete="new-password"
            autocapitalize="off"
            bind:value={passwordRepeat}
          />
        </label>
        <p class="tm-form__hint">
          {#if password && passwordProblem}{passwordProblem}。{/if}密码不会保存在任何地方，忘了就打不开这份备份。
        </p>
      {/if}
      <div class="tm-form__actions">
        <Button
          variant="primary"
          size="sm"
          disabled={!!busy || !!passwordAsk || !!passwordProblem}
          onclick={doExport}>{sealExport ? '导出加密备份' : '导出备份 zip'}</Button
        >
        <Button variant="outline" size="sm" disabled={!!busy || !!passwordAsk} onclick={doImport}
          >导入备份</Button
        >
      </div>
      {#if passwordAsk}
        <form
          class="tm-form__field"
          use:revealPrompt
          onsubmit={(e) => {
            e.preventDefault();
            passwordAsk?.(importPassword);
          }}
        >
          <label class="tm-form__label" for="tm-data-import-password"
            >这份备份加了密，输入密码</label
          >
          <span class="tm-form__inline">
            <input
              id="tm-data-import-password"
              class="text_pole tm-form__input"
              type="password"
              autocomplete="off"
              autocapitalize="off"
              bind:value={importPassword}
            />
            <Button variant="primary" type="submit" disabled={!importPassword}>解密并导入</Button>
            <Button variant="outline" type="button" onclick={() => passwordAsk?.(null)}>取消</Button
            >
          </span>
          {#if passwordWrong}
            <span class="tm-form__hint tm-data__wrong" role="alert">密码不对，再输一次。</span>
          {/if}
        </form>
      {/if}
      <p class="tm-form__hint">
        导出的 zip 就是整个数据目录（不含索引和密钥），可以直接解压进酒馆的
        <code>data/default-user/</code>；加密导出是同一份内容加了密码（<code>.tmbackup</code
        >），只有这个 app 能导入。导入支持酒馆导出的备份和这里导出的两种文件，同名文件会覆盖。
      </p>
      {#if mobileExportDir}
        <p class="tm-form__hint">
          手机上没有保存对话框，导出的文件放在「文件」app → 我的 iPhone → Tavern。
        </p>
      {/if}
    </div>

    <div class="tm-form__section">
      <h2 class="tm-form__heading"><span>索引</span></h2>
      <div class="tm-form__actions">
        <Button variant="outline" size="sm" disabled={!!busy} onclick={rebuildIndex}
          >重建索引</Button
        >
        {#if busy}<span class="tm-form__hint">{busy}</span>{/if}
      </div>
      <p class="tm-form__hint">
        角色列表和聊天搜索来自本地 SQLite 索引；手动往数据目录放了文件、或列表对不上时重建一次。
      </p>
    </div>

    <div class="tm-form__section">
      <h2 class="tm-form__heading"><span>崩溃日志</span></h2>
      <p class="tm-form__hint">
        {crashes.length
          ? `记了 ${crashes.length} 条，最近一条在 ${new Date(crashes[crashes.length - 1]!.t).toLocaleString()}。`
          : '还没有记录。'}日志只存在这台设备上，不会自动上传；要反馈问题时在这里手动导出。
      </p>
      {#if crashes.length}
        <div class="tm-form__actions">
          <Button
            variant="outline"
            size="sm"
            aria-expanded={crashOpen}
            onclick={() => (crashOpen = !crashOpen)}>{crashOpen ? '收起' : '查看'}</Button
          >
          <Button variant="outline" size="sm" onclick={exportCrashLog}>导出</Button>
          <Button variant="outline" size="sm" onclick={clearCrashLog}
            >{crashClearArmed ? '再点一次清空' : '清空'}</Button
          >
        </div>
        {#if crashOpen}
          <pre class="tm-data__crash">{crashText}</pre>
        {/if}
      {/if}
    </div>
  </section>
{/if}

<style>
  .tm-data__path {
    font-family: var(--tm-font-mono);
    font-size: var(--tm-text-xs);
    overflow-wrap: anywhere;
  }
  .tm-data__wrong {
    color: var(--tm-color-danger);
  }
  .tm-data__crash {
    max-height: calc(var(--tm-touch-target) * 7);
    overflow: auto;
    padding: var(--tm-space-3) var(--tm-space-4);
    border-radius: var(--tm-radius-md);
    background: var(--tm-color-surface-sunken);
    color: var(--tm-color-text-secondary);
    font-family: var(--tm-font-mono);
    font-size: var(--tm-text-xs);
    line-height: var(--tm-leading-normal);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
    -webkit-user-select: text;
  }
</style>
