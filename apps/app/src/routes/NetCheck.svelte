<script lang="ts">
  import Button from '@tm/ui/components/Button.svelte';
  import { onMount } from 'svelte';
  import {
    generateList,
    generateSnapshot,
    isTauri,
    netUrlPolicy,
    ping,
    type GenEvent,
  } from '../lib/ipc';
  import { runGeneration, type GenerationHandle, type GenerationOutcome } from '../lib/generation';
  import { PERF_BUDGET, perfBench } from '../lib/perf.svelte';
  import { chatStore } from '../lib/chat/store.svelte';

  interface Props {
    /** navigate to the chat page, which performs the perf run (DEV_NOTES §9.31) */
    onOpenChat?: (() => void) | undefined;
  }
  let { onOpenChat }: Props = $props();
  function startPerf() {
    perfBench.error = null;
    perfBench.result = null;
    perfBench.requested = true;
    onOpenChat?.();
  }

  let platform = $state('…');
  let url = $state('http://127.0.0.1:4010/v1/chat/completions');
  let stream = $state(true);
  let output = $state('');
  let status = $state('空闲');
  let log = $state<string[]>([]);
  let handle: GenerationHandle | null = $state(null);
  let outcome: GenerationOutcome | null = $state(null);
  let lastId = $state('');

  const push = (line: string) => {
    log = [`${new Date().toLocaleTimeString()} ${line}`, ...log].slice(0, 40);
  };

  onMount(async () => {
    const p = await ping();
    platform = p.platform;
    if (p.platform === 'android') url = 'http://10.0.2.2:4010/v1/chat/completions';
    const runs = await generateList();
    if (runs.length)
      push(
        `Rust 侧仍持有 ${runs.length} 次生成：${runs.map((r) => `${r.id.slice(-6)}=${r.state}`).join(' ')}`,
      );
  });

  async function start() {
    if (!isTauri()) {
      status = '需要在 Tauri 里运行';
      return;
    }
    output = '';
    outcome = null;
    const policy = await netUrlPolicy(url);
    if (!policy.ok && !policy.needs_confirm) {
      status = `URL 被拒绝：${policy.error}`;
      return;
    }
    status = '连接中…';
    const h = runGeneration(
      {
        url,
        headers: {},
        body: { model: 'oracle-model', messages: [{ role: 'user', content: 'hi' }], stream },
        stream,
        stream_format: 'sse',
        format: { kind: 'chat_completion', source: 'openai' },
        allow_insecure_http: policy.needs_confirm,
      },
      { kind: 'none' },
      {
        onDelta: (text) => {
          output = text;
        },
        onEvent: (e: GenEvent) => {
          if (e.type === 'started') status = `流式中 (HTTP ${e.status})`;
          if (e.type !== 'delta') push(`event ${e.type}`);
        },
        onRecovered: (snap) => push(`从快照补回 ${snap.text.length} 字符（state=${snap.state}）`),
      },
    );
    handle = h;
    h.id.then((id) => {
      lastId = id;
      push(`开始 ${id}`);
    });
    const o = await h.result;
    outcome = o;
    handle = null;
    status = `${o.state}${o.error ? `：${o.error}` : ''}${o.recovered ? '（含快照补回）' : ''}${o.canContinue ? '，可继续生成' : ''}`;
    push(`结束 state=${o.state} 字符=${o.text.length}`);
  }

  async function abort() {
    await handle?.abort();
  }

  async function snapshot() {
    if (!lastId) return;
    const s = await generateSnapshot(lastId);
    push(
      s
        ? `快照 state=${s.state} 字符=${s.text.length} 更新于 ${new Date(s.updated_at).toLocaleTimeString()}`
        : '快照不存在（已释放）',
    );
    if (s && s.text.length > output.length) output = s.text;
  }
</script>

<div class="tm-page">
  <header class="tm-page__head">
    <h1 class="tm-page__title">网络自检</h1>
    <p class="tm-page__lede">
      对 mock 后端做一次流式生成，验证中断、切后台恢复与继续生成。平台：{platform}。 先在电脑上跑
      <code>pnpm --filter @tm/tool-st-oracle run mock</code>。
    </p>
  </header>

  <section class="tm-sec">
    <label class="tm-field">
      <span class="tm-field__label">上游地址</span>
      <input class="tm-input" bind:value={url} spellcheck="false" />
    </label>
    <label class="checkbox_label tm-check">
      <input type="checkbox" bind:checked={stream} />
      <span>流式</span>
    </label>
    <div class="tm-row">
      <Button onclick={start} disabled={!!handle}>开始</Button>
      <Button onclick={abort} disabled={!handle}>中断</Button>
      <Button onclick={snapshot} disabled={!lastId}>拉快照</Button>
    </div>
    <p class="tm-status">{status}</p>
  </section>

  <section class="tm-sec">
    <h2 class="tm-sec__title">性能自检</h2>
    <p class="tm-status">
      给当前角色生成 {perfBench.rows} 条消息的临时聊天，测打开到首帧的时间和滚动掉帧率，然后删掉它。预算：打开
      &lt; {PERF_BUDGET.openMs}ms，掉帧 &lt; {PERF_BUDGET.droppedPct}%。
    </p>
    <div class="tm-row">
      <Button onclick={startPerf} disabled={perfBench.running || !chatStore.character}
        >{perfBench.running ? '测试中…' : '开始'}</Button
      >
      {#if !chatStore.character}<span class="tm-status">先在聊天页打开一个角色（非群聊）</span>{/if}
    </div>
    {#if perfBench.error}<p class="tm-status">失败：{perfBench.error}</p>{/if}
    {#if perfBench.result}
      {@const r = perfBench.result}
      <p class="tm-status">
        {r.rows} 条：打开 {r.openMs.toFixed(0)}ms（{r.openMs <= PERF_BUDGET.openMs
          ? '达标'
          : '超预算'}）· 滚动 {r.frames} 帧掉 {r.dropped} 帧 = {r.droppedPct.toFixed(
          1,
        )}%（{r.droppedPct <= PERF_BUDGET.droppedPct ? '达标' : '超预算'}）
      </p>
    {/if}
  </section>

  <section class="tm-sec">
    <h2 class="tm-sec__title">输出</h2>
    <pre class="tm-output">{output || '（空）'}</pre>
    {#if outcome?.canContinue}
      <p class="tm-status">
        半截回复已保留（{outcome.text.length} 字符），Phase 4 的 UI 会在这里提供"继续生成"。
      </p>
    {/if}
  </section>

  <section class="tm-sec">
    <h2 class="tm-sec__title">事件</h2>
    <ul class="tm-log">
      {#each log as line, i (i)}
        <li>{line}</li>
      {/each}
    </ul>
  </section>
</div>

<style>
  .tm-page {
    padding: var(--tm-space-5);
    display: grid;
    gap: var(--tm-space-5);
  }
  .tm-page__title {
    font-size: var(--tm-text-2xl);
    margin: 0;
  }
  .tm-page__lede {
    color: var(--tm-color-text-muted);
    margin: var(--tm-space-2) 0 0;
  }
  .tm-sec {
    display: grid;
    gap: var(--tm-space-3);
  }
  .tm-sec__title {
    font-size: var(--tm-text-lg);
    margin: 0;
  }
  .tm-field {
    display: grid;
    gap: var(--tm-space-1);
  }
  .tm-field__label {
    font-size: var(--tm-text-sm);
    color: var(--tm-color-text-muted);
  }
  .tm-input {
    font: inherit;
    padding: var(--tm-space-2) var(--tm-space-3);
    border: 1px solid var(--tm-color-border);
    border-radius: var(--tm-radius-md);
    background: var(--tm-color-surface-raised);
    color: var(--tm-color-text);
  }
  .tm-check {
    display: inline-flex;
    gap: var(--tm-space-2);
    align-items: center;
  }
  .tm-row {
    display: flex;
    gap: var(--tm-space-2);
    flex-wrap: wrap;
  }
  .tm-status {
    margin: 0;
    color: var(--tm-color-text-muted);
    font-size: var(--tm-text-sm);
  }
  .tm-output {
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    padding: var(--tm-space-3);
    border: 1px solid var(--tm-color-border);
    border-radius: var(--tm-radius-md);
    background: var(--tm-color-surface-raised);
    min-height: var(--tm-space-12);
    font-family: var(--tm-font-mono, monospace);
    font-size: var(--tm-text-sm);
  }
  .tm-log {
    margin: 0;
    padding-left: var(--tm-space-4);
    font-size: var(--tm-text-sm);
    color: var(--tm-color-text-muted);
  }
</style>
