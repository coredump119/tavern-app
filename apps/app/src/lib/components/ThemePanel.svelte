<script lang="ts">
  import Segmented from '@tm/ui/components/Segmented.svelte';
  import Button from '@tm/ui/components/Button.svelte';
  import { analyzeCustomCss } from '@tm/ui';
  import { themeStore } from '../theme.svelte';
  import { downloadText } from '../download';
  import Icon from './Icon.svelte';

  let error = $state<string | null>(null);
  /** the custom CSS editor is open */
  let cssOpen = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  const t = $derived(themeStore.current);
  /** what the theme's custom_css would change (DEV_NOTES §9.28) */
  const cssReport = $derived(t.customCss ? analyzeCustomCss(t.customCss) : null);

  async function onFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    error = null;
    try {
      themeStore.importJson(await file.text());
    } catch (err) {
      error = err instanceof Error ? err.message.split('\n').slice(0, 3).join(' ') : String(err);
    }
    if (fileInput) fileInput.value = '';
  }
  const slug = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-');
</script>

<div id="user-settings-block" class="tm-panel drawer-content">
  <section class="tm-panel__section">
    <h2 class="tm-label">主题</h2>
    <ul class="tm-theme-list">
      {#each themeStore.builtins as th (th.name)}
        <li>
          <button
            class="tm-theme-item"
            class:is-active={th.name === t.name}
            onclick={() => themeStore.set(th)}
          >
            <span class="tm-theme-item__name">{th.name}</span>
            <span class="tm-theme-item__meta">{th.appearance} · {th.typography.body}</span>
          </button>
        </li>
      {/each}
      {#each themeStore.imported as th (th.name)}
        <li class="tm-theme-row">
          <button
            class="tm-theme-item"
            class:is-active={th.name === t.name}
            onclick={() => themeStore.set(th)}
          >
            <span class="tm-theme-item__name">{th.name}</span>
            <span class="tm-theme-item__meta">{th.appearance} · {th.typography.body}</span>
          </button>
          <button
            class="tm-theme-row__remove"
            aria-label="移除主题 {th.name}"
            title="移除"
            onclick={() => themeStore.removeImported(th.name)}
          >
            <Icon name="trash" />
          </button>
        </li>
      {/each}
    </ul>
    <div class="tm-row">
      <Button size="sm" variant="outline" onclick={() => fileInput?.click()}
        >导入主题（ST / tm）</Button
      >
      <input
        bind:this={fileInput}
        type="file"
        accept="application/json,.json"
        hidden
        onchange={onFile}
      />
    </div>
    {#if error}<p class="tm-error">{error}</p>{/if}
    {#if t.customCss && cssReport}
      <div class="tm-css">
        <label class="checkbox_label tm-check">
          <input
            type="checkbox"
            checked={t.customCssEnabled}
            onchange={(e) => themeStore.patch({ customCssEnabled: e.currentTarget.checked })}
          />
          <span
            >应用主题自带美化 CSS <span class="tm-field__value"
              >{cssReport.rules} 条规则 · {Math.round(t.customCss.length / 1024)} KB</span
            ></span
          >
        </label>
        {#if t.customCssEnabled}
          <Segmented
            label="美化范围"
            value={t.customCssLayout ? 'full' : 'look'}
            options={[
              { value: 'look', label: '只套外观' },
              { value: 'full', label: '完整' },
            ]}
            onchange={(v) => themeStore.patch({ customCssLayout: v === 'full' })}
          />
          <p class="tm-field__hint">
            {#if t.customCssLayout}
              原样应用。主题是照酒馆的页面写的，里面
              {cssReport.layoutDecls} 条改位置 / 尺寸的规则可能把手机布局挤乱；乱了切回「只套外观」。
            {:else}
              颜色、字体、圆角、阴影、背景都会生效；{cssReport.layoutDecls} 条改位置 / 尺寸的规则{cssReport.overlays
                ? `和 ${cssReport.overlays} 个浮动装饰`
                : ''}已忽略，避免挤乱布局。
            {/if}
            {#if cssReport.fontAwesomeGlyphs}
              另有 {cssReport.fontAwesomeGlyphs} 处换图标的规则暂不支持。
            {/if}
            {#if cssReport.imports.length}
              会联网加载 {cssReport.imports.length} 个外部样式（通常是字体）。
            {/if}
          </p>
        {/if}
      </div>
    {/if}
    <details class="tm-css__edit" ontoggle={(e) => (cssOpen = e.currentTarget.open)}>
      <summary class="tm-css__summary">自定义 CSS{t.customCss ? '' : '（当前主题没有）'}</summary>
      {#if cssOpen}
        <!-- only while open: a theme's CSS can be hundreds of KB -->
        <textarea
          aria-label="自定义 CSS"
          class="tm-css__text"
          rows="10"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
          placeholder="/* 写在这里的 CSS 跟着当前主题走 */"
          value={t.customCss}
          onchange={(e) =>
            themeStore.patch({ customCss: e.currentTarget.value, customCssEnabled: true })}
        ></textarea>
        <p class="tm-field__hint">
          改完点一下别处就生效。写在内置主题上的，切到别的主题就没了，想留着先导出主题。
        </p>
      {/if}
    </details>
  </section>

  <section class="tm-panel__section">
    <h2 class="tm-label">外观</h2>
    <Segmented
      label="外观"
      value={t.appearance}
      options={[
        { value: 'light', label: '亮' },
        { value: 'dark', label: '暗' },
      ]}
      onchange={(v) => themeStore.patch({ appearance: v })}
    />
  </section>

  <section class="tm-panel__section">
    <h2 class="tm-label">字体</h2>
    <div class="tm-field">
      <span class="tm-field__name">正文</span>
      <Segmented
        label="正文字体"
        value={t.typography.body}
        options={[
          { value: 'serif', label: '衬线' },
          { value: 'sans', label: '无衬线' },
        ]}
        onchange={(v) => themeStore.patch({ typography: { body: v } })}
      />
    </div>
    <div class="tm-field">
      <span class="tm-field__name">界面</span>
      <Segmented
        label="界面字体"
        value={t.typography.ui}
        options={[
          { value: 'serif', label: '衬线' },
          { value: 'sans', label: '无衬线' },
        ]}
        onchange={(v) => themeStore.patch({ typography: { ui: v } })}
      />
    </div>
    <label class="tm-field">
      <span class="tm-field__name"
        >字号 <span class="tm-field__value">{Math.round(t.typography.scale * 100)}%</span></span
      >
      <input
        class="neo-range-slider tm-range"
        type="range"
        min="0.8"
        max="1.4"
        step="0.05"
        value={t.typography.scale}
        oninput={(e) => themeStore.patch({ typography: { scale: +e.currentTarget.value } })}
      />
    </label>
    <div class="tm-field">
      <span class="tm-field__name">行高</span>
      <Segmented
        label="行高"
        value={t.typography.leading}
        options={[
          { value: 'tight', label: '紧' },
          { value: 'normal', label: '中' },
          { value: 'relaxed', label: '松' },
        ]}
        onchange={(v) => themeStore.patch({ typography: { leading: v } })}
      />
    </div>
  </section>

  <section class="tm-panel__section">
    <h2 class="tm-label">布局</h2>
    <div class="tm-field">
      <span class="tm-field__name">密度</span>
      <Segmented
        label="密度"
        value={t.layout.density}
        options={[
          { value: 'compact', label: '紧凑' },
          { value: 'comfortable', label: '舒适' },
          { value: 'spacious', label: '宽松' },
        ]}
        onchange={(v) => themeStore.patch({ layout: { density: v } })}
      />
    </div>
    <div class="tm-field">
      <span class="tm-field__name">聊天样式 <span class="tm-field__value">ST Chat Style</span></span
      >
      <Segmented
        label="聊天样式"
        value={t.layout.chatStyle}
        options={[
          { value: 'flat', label: '平铺' },
          { value: 'bubbles', label: '气泡' },
          { value: 'document', label: '文档' },
        ]}
        onchange={(v) => themeStore.patch({ layout: { chatStyle: v } })}
      />
      {#if t.layout.chatStyle === 'document'}
        <span class="tm-field__hint">文档：只剩正文，不显示头像、名字和时间（同 ST）。</span>
      {/if}
    </div>
    <div class="tm-field">
      <span class="tm-field__name"
        >头像形状 <span class="tm-field__value">ST Avatar Style</span></span
      >
      <Segmented
        label="头像形状"
        value={t.shape.avatar}
        options={[
          { value: 'circle', label: '圆' },
          { value: 'square', label: '方' },
          { value: 'rounded', label: '圆角' },
          { value: 'rectangle', label: '长方' },
        ]}
        onchange={(v) => themeStore.patch({ shape: { avatar: v } })}
      />
    </div>
    <label class="checkbox_label tm-check">
      <input
        type="checkbox"
        checked={t.layout.immersiveChat}
        onchange={(e) => themeStore.patch({ layout: { immersiveChat: e.currentTarget.checked } })}
      />
      <span>沉浸式聊天顶栏 <span class="tm-field__value">透明、无标题，只留两个按钮</span></span>
    </label>
    <div class="tm-field">
      <span class="tm-field__name">我的消息</span>
      <Segmented
        label="我的消息位置"
        value={t.layout.userSide}
        options={[
          { value: 'right', label: '靠右' },
          { value: 'left', label: '靠左' },
        ]}
        onchange={(v) => themeStore.patch({ layout: { userSide: v } })}
      />
    </div>
    <label class="tm-field">
      <span class="tm-field__name"
        >行宽 <span class="tm-field__value">{t.layout.chatMeasure}ch</span></span
      >
      <input
        class="neo-range-slider tm-range"
        type="range"
        min="40"
        max="120"
        step="2"
        value={t.layout.chatMeasure}
        oninput={(e) => themeStore.patch({ layout: { chatMeasure: +e.currentTarget.value } })}
      />
    </label>
    <label class="tm-field">
      <span class="tm-field__name"
        >桌面聊天栏宽度 <span class="tm-field__value">{t.layout.chatWidth}%</span></span
      >
      <input
        class="neo-range-slider tm-range"
        type="range"
        min="25"
        max="100"
        step="5"
        value={t.layout.chatWidth}
        oninput={(e) => themeStore.patch({ layout: { chatWidth: +e.currentTarget.value } })}
      />
      <span class="tm-field__hint"
        >对应 ST 的 chat_width，只在桌面宽度生效；100% 时按行宽限制。</span
      >
    </label>
  </section>

  <section class="tm-panel__section">
    <h2 class="tm-label">背景</h2>
    <label class="checkbox_label tm-check">
      <input
        type="checkbox"
        checked={t.background.avatar}
        onchange={(e) => themeStore.patch({ background: { avatar: e.currentTarget.checked } })}
      />
      <span>用角色头像作聊天背景</span>
    </label>
    {#if t.background.avatar}
      <label class="tm-field">
        <span class="tm-field__name"
          >不透明度 <span class="tm-field__value">{Math.round(t.background.opacity * 100)}%</span
          ></span
        >
        <input
          class="neo-range-slider tm-range"
          type="range"
          min="0.05"
          max="1"
          step="0.05"
          value={t.background.opacity}
          oninput={(e) => themeStore.patch({ background: { opacity: +e.currentTarget.value } })}
        />
      </label>
      <label class="tm-field">
        <span class="tm-field__name"
          >模糊 <span class="tm-field__value">{t.background.blur}px</span></span
        >
        <input
          class="neo-range-slider tm-range"
          type="range"
          min="0"
          max="40"
          step="2"
          value={t.background.blur}
          oninput={(e) => themeStore.patch({ background: { blur: +e.currentTarget.value } })}
        />
      </label>
    {/if}
    <label class="checkbox_label tm-check">
      <input
        type="checkbox"
        checked={t.background.keepOriginal}
        onchange={(e) =>
          themeStore.patch({ background: { keepOriginal: e.currentTarget.checked } })}
      />
      <span
        >换头像时保留大图 <span class="tm-field__value"
          >存到 backgrounds/，背景用它而不是 512×768 的卡片图</span
        ></span
      >
    </label>
  </section>

  <section class="tm-panel__section">
    <h2 class="tm-label">效果</h2>
    <label class="tm-field">
      <span class="tm-field__name"
        >阴影 <span class="tm-field__value">{Math.round(t.effects.shadow * 100)}%</span></span
      >
      <input
        class="neo-range-slider tm-range"
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={t.effects.shadow}
        oninput={(e) => themeStore.patch({ effects: { shadow: +e.currentTarget.value } })}
      />
    </label>
  </section>

  <section class="tm-panel__section">
    <h2 class="tm-label">导出</h2>
    <div class="tm-row">
      <Button
        size="sm"
        variant="outline"
        onclick={() => downloadText(`${slug(t.name)}.tm-theme.json`, themeStore.exportTm())}
        >tm-theme</Button
      >
      <Button
        size="sm"
        variant="outline"
        onclick={() => downloadText(`${slug(t.name)}.json`, themeStore.exportSt())}>ST 主题</Button
      >
    </div>
    <p class="tm-field__hint">
      <b>tm-theme</b>：这个 app 自己的完整主题文件（颜色 + 字体 / 布局 / 背景等 ST
      没有的设置），给另一台设备或朋友导入用。<b>ST 主题</b>：转换成 SillyTavern 的
      <code>themes/*.json</code>，可以直接放回酒馆用；只带 ST 认识的字段，ST
      导进来时没能对应的字段也会原样写回去。
    </p>
  </section>
</div>

<style>
  .tm-panel {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-8);
    padding: var(--tm-space-7) var(--tm-space-6) var(--tm-space-10);
    font-family: var(--tm-font-ui);
  }
  .tm-panel__section {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-4);
  }
  .tm-label {
    font-size: var(--tm-text-xs);
    font-weight: 600;
    letter-spacing: var(--tm-tracking-wide);
    text-transform: uppercase;
    color: var(--tm-color-text-secondary);
  }
  .tm-theme-list {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-1);
  }
  .tm-theme-item {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--tm-space-3);
    min-height: var(--tm-touch-target);
    padding: 0 var(--tm-space-4);
    border-radius: var(--tm-radius-md);
    text-align: left;
  }
  .tm-theme-row {
    display: flex;
    align-items: center;
    gap: var(--tm-space-1);
  }
  .tm-theme-row .tm-theme-item {
    flex: 1;
    min-width: 0;
  }
  .tm-theme-row__remove {
    flex: none;
    width: var(--tm-touch-target);
    height: var(--tm-touch-target);
    display: inline-grid;
    place-items: center;
    border-radius: var(--tm-radius-md);
    color: var(--tm-color-text-muted);
  }
  .tm-theme-row__remove:hover {
    color: var(--tm-color-danger);
    background: var(--tm-color-surface-sunken);
  }
  .tm-theme-item:hover {
    background: var(--tm-color-surface-sunken);
  }
  .tm-theme-item.is-active {
    background: var(--tm-color-surface-sunken);
    box-shadow: inset 2px 0 0 var(--tm-color-accent);
  }
  .tm-theme-item__name {
    font-size: var(--tm-text-sm);
    font-weight: 500;
  }
  .tm-theme-item__meta {
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
  }
  .tm-field {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-2);
  }
  .tm-field__name {
    display: flex;
    justify-content: space-between;
    font-size: var(--tm-text-sm);
    color: var(--tm-color-text);
  }
  .tm-field__value {
    color: var(--tm-color-text-muted);
    font-variant-numeric: tabular-nums;
  }
  .tm-field__hint {
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
    line-height: var(--tm-leading-normal);
  }
  .tm-range {
    width: 100%;
    accent-color: var(--tm-color-accent);
  }
  .tm-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--tm-space-2);
  }
  .tm-check {
    display: flex;
    align-items: center;
    gap: var(--tm-space-3);
    min-height: var(--tm-touch-target);
    font-size: var(--tm-text-sm);
  }
  .tm-check input {
    accent-color: var(--tm-color-accent);
    width: var(--tm-icon-sm);
    height: var(--tm-icon-sm);
  }
  .tm-css {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-2);
  }
  .tm-css__summary {
    padding: var(--tm-space-2) 0;
    font-size: var(--tm-text-sm);
    color: var(--tm-color-text-secondary);
    cursor: pointer;
  }
  .tm-css__text {
    width: 100%;
    margin-bottom: var(--tm-space-2);
    padding: var(--tm-space-3);
    border: var(--tm-border-width) solid var(--tm-color-border);
    border-radius: var(--tm-radius-md);
    background: var(--tm-color-surface-sunken);
    color: var(--tm-color-text);
    font-family: var(--tm-font-mono);
    font-size: var(--tm-text-xs);
    line-height: var(--tm-leading-normal);
    resize: vertical;
  }
  /* the reset's iOS no-zoom clamp loses to the class rule above; re-apply it for touch */
  @media (pointer: coarse) {
    .tm-css__text {
      font-size: max(var(--tm-text-input-min), var(--tm-text-xs));
    }
  }
  .tm-error {
    font-size: var(--tm-text-xs);
    color: var(--tm-color-danger);
  }
</style>
