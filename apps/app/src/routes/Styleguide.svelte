<script lang="ts">
  import { COLOR_KEYS } from '@tm/ui';
  import Button from '@tm/ui/components/Button.svelte';
  const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  const spaces = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const sizes = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl'];
</script>

<div class="tm-page">
  <header class="tm-page__head">
    <h1 class="tm-page__title">设计系统</h1>
    <p class="tm-page__lede">
      所有值来自 <code>--tm-*</code> 令牌。右侧面板改主题，这页实时跟着变。
    </p>
  </header>

  <section class="tm-sec">
    <h2 class="tm-sec__title">颜色</h2>
    <ul class="tm-swatches">
      {#each COLOR_KEYS as k (k)}
        <li class="tm-swatch">
          <span class="tm-swatch__chip" style:background="var(--tm-color-{kebab(k)})"></span>
          <span class="tm-swatch__name">{kebab(k)}</span>
        </li>
      {/each}
    </ul>
  </section>

  <section class="tm-sec">
    <h2 class="tm-sec__title">排版</h2>
    <div class="tm-type-pair">
      <article class="tm-specimen" style:font-family="var(--tm-font-serif)">
        <span class="tm-specimen__tag">serif</span>
        <p class="tm-specimen__text">
          她把信折成一只船，推进夜色里。<em>水面没有回应</em>，只有远处"你还在吗"的回声。
        </p>
        <p class="tm-specimen__latin">The quick brown fox jumps over the lazy dog — 1234567890</p>
      </article>
      <article class="tm-specimen" style:font-family="var(--tm-font-sans)">
        <span class="tm-specimen__tag">sans</span>
        <p class="tm-specimen__text">
          她把信折成一只船，推进夜色里。<em>水面没有回应</em>，只有远处"你还在吗"的回声。
        </p>
        <p class="tm-specimen__latin">The quick brown fox jumps over the lazy dog — 1234567890</p>
      </article>
    </div>
    <ul class="tm-scale">
      {#each sizes as s (s)}
        <li class="tm-scale__row">
          <span class="tm-scale__key">{s}</span>
          <span class="tm-scale__sample" style:font-size="var(--tm-text-{s})">正文与对白 Aa</span>
        </li>
      {/each}
    </ul>
  </section>

  <section class="tm-sec">
    <h2 class="tm-sec__title">间距</h2>
    <ul class="tm-spaces">
      {#each spaces as n (n)}
        <li class="tm-spaces__row">
          <span class="tm-scale__key">{n}</span>
          <span class="tm-spaces__bar" style:width="var(--tm-space-{n})"></span>
        </li>
      {/each}
    </ul>
  </section>

  <section class="tm-sec">
    <h2 class="tm-sec__title">控件</h2>
    <div class="tm-controls">
      <Button variant="primary">发送</Button>
      <Button variant="outline">重新生成</Button>
      <Button>取消</Button>
      <Button disabled>禁用</Button>
    </div>
    <div class="tm-radii">
      <span class="tm-radii__box" style:border-radius="var(--tm-radius-sm)">sm</span>
      <span class="tm-radii__box" style:border-radius="var(--tm-radius-md)">md</span>
      <span class="tm-radii__box" style:border-radius="var(--tm-radius-lg)">lg</span>
      <span class="tm-radii__box" style:border-radius="var(--tm-radius-bubble)">bubble</span>
      <span class="tm-radii__box tm-radii__box--shadow">shadow</span>
    </div>
  </section>
</div>

<style>
  .tm-page {
    flex: 1;
    overflow-y: auto;
    padding: var(--tm-space-9) var(--tm-gutter) var(--tm-space-12);
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-10);
    max-width: calc(var(--tm-chat-measure) + var(--tm-gutter) * 2);
    width: 100%;
    margin: 0 auto;
  }
  .tm-page__head {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-3);
  }
  .tm-page__title {
    font-family: var(--tm-font-ui);
    font-size: var(--tm-text-2xl);
    font-weight: 600;
    letter-spacing: var(--tm-tracking-tight);
    line-height: var(--tm-leading-tight);
  }
  .tm-page__lede {
    color: var(--tm-color-text-secondary);
    font-size: var(--tm-text-sm);
    line-height: var(--tm-leading-normal);
  }
  code {
    font-family: var(--tm-font-mono);
    font-size: 0.9em;
    background: var(--tm-color-surface-sunken);
    padding: 0 var(--tm-space-1);
    border-radius: var(--tm-radius-sm);
  }
  .tm-sec {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-5);
    padding-top: var(--tm-space-7);
    border-top: var(--tm-border-width) solid var(--tm-color-border);
  }
  .tm-sec__title {
    font-family: var(--tm-font-ui);
    font-size: var(--tm-text-xs);
    font-weight: 600;
    letter-spacing: var(--tm-tracking-wide);
    text-transform: uppercase;
    color: var(--tm-color-text-secondary);
  }
  .tm-swatches {
    display: grid;
    grid-template-columns: repeat(
      auto-fill,
      minmax(calc(var(--tm-space-12) + var(--tm-space-8)), 1fr)
    );
    gap: var(--tm-space-4);
  }
  .tm-swatch {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-2);
  }
  .tm-swatch__chip {
    display: block;
    aspect-ratio: 3 / 2;
    border-radius: var(--tm-radius-md);
    border: var(--tm-border-width) solid var(--tm-color-border);
  }
  .tm-swatch__name {
    font-family: var(--tm-font-mono);
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-secondary);
  }
  .tm-type-pair {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(calc(var(--tm-space-12) * 3), 1fr));
    gap: var(--tm-space-6);
  }
  .tm-specimen {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-3);
    padding: var(--tm-space-6);
    background: var(--tm-color-surface);
    border: var(--tm-border-width) solid var(--tm-color-border);
    border-radius: var(--tm-radius-lg);
  }
  .tm-specimen__tag {
    font-family: var(--tm-font-mono);
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
  }
  .tm-specimen__text {
    font-size: var(--tm-text-md);
    line-height: var(--tm-leading-body);
  }
  .tm-specimen__text em {
    color: var(--tm-color-text-em);
  }
  .tm-specimen__latin {
    font-size: var(--tm-text-sm);
    color: var(--tm-color-text-secondary);
  }
  .tm-scale,
  .tm-spaces {
    display: flex;
    flex-direction: column;
    gap: var(--tm-space-3);
  }
  .tm-scale__row,
  .tm-spaces__row {
    display: flex;
    align-items: baseline;
    gap: var(--tm-space-5);
  }
  .tm-spaces__row {
    align-items: center;
  }
  .tm-scale__key {
    width: var(--tm-space-9);
    flex: none;
    font-family: var(--tm-font-mono);
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-muted);
  }
  .tm-scale__sample {
    line-height: var(--tm-leading-tight);
  }
  .tm-spaces__bar {
    height: var(--tm-space-3);
    background: var(--tm-color-accent);
    border-radius: var(--tm-radius-sm);
  }
  .tm-controls,
  .tm-radii {
    display: flex;
    flex-wrap: wrap;
    gap: var(--tm-space-3);
    font-family: var(--tm-font-ui);
  }
  .tm-radii__box {
    display: grid;
    place-items: center;
    width: var(--tm-space-12);
    height: var(--tm-space-11);
    background: var(--tm-color-surface);
    border: var(--tm-border-width) solid var(--tm-color-border);
    font-size: var(--tm-text-xs);
    color: var(--tm-color-text-secondary);
  }
  .tm-radii__box--shadow {
    border-radius: var(--tm-radius-md);
    box-shadow: var(--tm-shadow-2);
  }
</style>
