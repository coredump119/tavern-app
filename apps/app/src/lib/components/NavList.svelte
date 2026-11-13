<script lang="ts">
  export type Route =
    | 'characters'
    | 'character'
    | 'group'
    | 'chat'
    | 'worlds'
    | 'persona'
    | 'regex'
    | 'extensions'
    | 'connection'
    | 'presets'
    | 'data'
    | 'styleguide'
    | 'netcheck';
  interface Props {
    route: Route;
    onNavigate: (r: Route) => void;
    footer?: string | undefined;
  }
  let { route, onNavigate, footer }: Props = $props();
  /** ST drawer button ids for the same panels (DEV_NOTES §9.3) */
  const ST_DRAWER: Partial<Record<Route, string>> = {
    characters: 'rightNavHolder',
    worlds: 'WI-SP-button',
    persona: 'persona-management-button',
    extensions: 'extensions-settings-button',
    connection: 'sys-settings-button',
    presets: 'ai-config-button',
  };
  const items: { id: Route; label: string; hint: string }[] = [
    { id: 'characters', label: '角色', hint: '角色列表 / 导入' },
    { id: 'chat', label: '聊天', hint: '当前对话' },
    { id: 'worlds', label: '世界书', hint: '条目、关键词、全局启用' },
    { id: 'persona', label: '用户设定', hint: '你的名字、头像、描述' },
    { id: 'regex', label: '正则脚本', hint: '全局 / 预设 / 角色' },
    { id: 'extensions', label: '扩展', hint: '酒馆第三方扩展' },
    { id: 'connection', label: 'API 连接', hint: '来源 / 密钥 / 模型' },
    { id: 'presets', label: '预设 / 采样', hint: '预设、采样参数、格式模板' },
    { id: 'data', label: '数据与备份', hint: '备份 zip、导入、索引' },
    { id: 'styleguide', label: '设计系统', hint: '令牌与排版' },
    { id: 'netcheck', label: '网络自检', hint: '流式 / 中断 / 切后台' },
  ];
</script>

<nav class="tm-nav">
  <div class="tm-nav__brand">
    <span class="tm-nav__wordmark">Tavern</span>
    <span class="tm-nav__tag">mobile · 0.0.1</span>
  </div>
  <ul id="top-settings-holder" class="tm-nav__list">
    {#each items as it (it.id)}
      <li id={ST_DRAWER[it.id]} class="drawer">
        <button
          class="tm-nav__item drawer-toggle"
          class:is-active={route === it.id}
          aria-current={route === it.id ? 'page' : undefined}
          onclick={() => onNavigate(it.id)}
        >
          <span class="tm-nav__label">{it.label}</span>
          <span class="tm-nav__hint">{it.hint}</span>
        </button>
      </li>
    {/each}
  </ul>
  {#if footer}<p class="tm-nav__footer">{footer}</p>{/if}
</nav>

<style>
  .tm-nav {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: var(--tm-space-7) var(--tm-space-5) var(--tm-space-6);
    font-family: var(--tm-font-ui);
  }
  .tm-nav__brand {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-1);
    padding: 0 var(--tm-space-4) var(--tm-space-8);
  }
  .tm-nav__wordmark {
    font-family: var(--tm-font-serif);
    font-size: var(--tm-text-xl);
    font-weight: 500;
    letter-spacing: var(--tm-tracking-tight);
  }
  .tm-nav__tag {
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
    letter-spacing: var(--tm-tracking-wide);
  }
  /* scrolls on its own: the list is longer than a short phone screen */
  .tm-nav__list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-1);
  }
  .tm-nav__item {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--tm-space-1);
    padding: var(--tm-space-3) var(--tm-space-4);
    border-radius: var(--tm-radius-md);
    text-align: left;
    color: var(--tm-color-text-secondary);
  }
  .tm-nav__item:hover {
    background: var(--tm-color-surface-sunken);
  }
  .tm-nav__item.is-active {
    color: var(--tm-color-text);
    background: var(--tm-color-surface-sunken);
  }
  .tm-nav__label {
    font-size: var(--tm-text-sm);
    font-weight: 500;
  }
  .tm-nav__hint {
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
  }
  .tm-nav__footer {
    margin-top: auto;
    padding: 0 var(--tm-space-4);
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
  }
</style>
