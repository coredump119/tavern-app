# DESIGN — 设计系统规范

> UI 的所有视觉决策以本文件为准。改视觉先改这里，再改 `packages/ui/src/tokens/`。
> 任何 PR 若在组件里写死颜色 / 字号 / 间距（而非引用令牌），`pnpm lint:tokens` 会失败。

## 0. 原则

1. **令牌驱动，零硬编码。** 组件只引用 `--tm-*` CSS 变量；变量的值来自主题文件。换主题 = 换一组变量，不动组件。
2. **极简，用排版做层级。** 少用边框和阴影，靠字号、字重、留白与对齐区分层级。默认无毛玻璃、无投影，细发丝线分隔。
3. **衬线 / 非衬线双轨。** 正文与 UI 文字分别可选衬线或无衬线；默认正文衬线、UI 无衬线（"读书感 + 工具感"）。
4. **移动端优先，三档分栏。** 手机单栏，平板双栏，桌面三栏；分栏宽度全部是令牌。
5. **ST 主题可导入。** ST 的主题 JSON 直接导入；我们的主题格式是它的超集；导出可无损回到 ST。
6. **安全区与可访问性是默认值。** `env(safe-area-inset-*)`、动态字号、`prefers-reduced-motion`、`prefers-color-scheme` 全部内建。

## 1. 令牌分层

```
原始层 primitives   不直接用。色阶、字号阶、间距阶（在 tokens.css 的 :root 中以 --tm-p-* 定义，仅供语义层引用）
语义层 semantic     组件唯一允许引用的层。--tm-color-*、--tm-font-*、--tm-space-*、--tm-radius-* …
别名层 aliases      ST 兼容：--SmartTheme* 等全部 = var(--tm-*)。只给 ST 扩展与 custom_css 用，我们自己的组件禁止引用
```

主题文件只覆盖**语义层**。运行时 `applyTheme()` 把主题对象写成 `document.documentElement.style.setProperty('--tm-…')`，静态 `tokens.css` 提供首屏默认值，二者键名完全一致。

## 2. 语义令牌全集

### 2.1 颜色 `--tm-color-*`

| 令牌                             | 用途                 | 主题 JSON 键           |
| -------------------------------- | -------------------- | ---------------------- |
| `bg`                             | 页面底色             | `colors.bg`            |
| `surface`                        | 卡片、侧栏、面板     | `colors.surface`       |
| `surface-raised`                 | 弹层、菜单           | `colors.surfaceRaised` |
| `surface-sunken`                 | 输入框内底、代码块底 | `colors.surfaceSunken` |
| `text`                           | 正文                 | `colors.text`          |
| `text-secondary`                 | 次要文字、时间戳     | `colors.textSecondary` |
| `text-muted`                     | 占位符、禁用         | `colors.textMuted`     |
| `text-em`                        | _斜体_ 动作描写      | `colors.textEm`        |
| `text-quote`                     | "引号对白"           | `colors.textQuote`     |
| `text-link`                      | 链接 / 下划线        | `colors.textLink`      |
| `accent`                         | 主操作、选中态、光标 | `colors.accent`        |
| `on-accent`                      | accent 上的文字      | `colors.onAccent`      |
| `border`                         | 发丝分隔线           | `colors.border`        |
| `border-strong`                  | 聚焦框、强分隔       | `colors.borderStrong`  |
| `bubble-user`                    | 用户消息底           | `colors.bubbleUser`    |
| `bubble-bot`                     | 角色消息底           | `colors.bubbleBot`     |
| `danger` / `success` / `warning` | 状态                 | `colors.danger` …      |
| `shadow`                         | 阴影基色（含 alpha） | `colors.shadow`        |
| `scrim`                          | 遮罩                 | `colors.scrim`         |

所有颜色值允许任何 CSS 颜色写法；推荐 `oklch()` 或 `rgba()`。

### 2.2 字体 `--tm-font-*`

| 令牌                                | 说明                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--tm-font-serif`                   | 衬线栈。默认 `"Source Serif 4", "Iowan Old Style", "Noto Serif SC", "Songti SC", "Noto Serif CJK SC", Georgia, serif`；`Noto Serif SC` 随应用自带 |
| `--tm-font-sans`                    | 无衬线栈。默认 `"Inter", -apple-system, "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif`                                                 |
| `--tm-font-mono`                    | 等宽栈                                                                                                                                            |
| `--tm-font-body`                    | 正文实际使用 = serif 或 sans（由 `typography.body` 决定）                                                                                         |
| `--tm-font-ui`                      | UI 文字实际使用（由 `typography.ui` 决定）                                                                                                        |
| `--tm-font-scale`                   | 用户缩放系数，默认 1                                                                                                                              |
| `--tm-os-font-scale`                | 系统字号系数（iOS 动态字号），默认 1，由应用写入，主题不动                                                                                        |
| `--tm-text-xs/sm/md/lg/xl/2xl/3xl`  | 字号阶，`md` = 16px × scale × 系统系数，比率 1.2                                                                                                  |
| `--tm-leading-tight/normal/relaxed` | 1.3 / 1.55 / 1.75                                                                                                                                 |
| `--tm-text-input-min`               | 16px：触屏设备上所有文本输入框的字号下限（`reset.css` 用 `max()` 夹住），否则 iOS 聚焦时会整页放大                                                |
| `--tm-tracking-tight/normal/wide`   | -0.01em / 0 / 0.04em（小标签全大写时用 wide）                                                                                                     |

Phase 0 不捆绑字体文件（安装包预算），走系统字体；`typography.serif/sans/mono` 可覆盖字体栈，后续允许用户导入字体文件。

### 2.3 间距 `--tm-space-*`

4px 基准：`0, 1=2px, 2=4px, 3=8px, 4=12px, 5=16px, 6=20px, 7=24px, 8=32px, 9=40px, 10=48px, 11=64px, 12=80px`。
全部乘以 `--tm-density`（compact 0.85 / comfortable 1 / spacious 1.2）。

### 2.4 形状与线

| 令牌                              | 默认                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `--tm-radius-sm / md / lg / full` | 4 / 8 / 14 / 9999px，随 `shape.radius` 等比缩放                                              |
| `--tm-radius-bubble`              | 气泡样式下消息块圆角，固定 10px × radius-scale（ST bubblechat；ST 没有气泡形状设置，不开放） |
| `--tm-avatar-height`              | 头像高度：`shape.avatar` 为 `rectangle`（ST Rectangle / big-avatars）时 1.5× 宽，其余 = 宽   |
| `--tm-chat-bg-opacity` / `-blur`  | 角色头像背景层的不透明度 / 模糊（`background.opacity` / `blur`）                             |
| `--tm-radius-avatar`              | `shape.avatar`：`circle` 50% / `rounded` = md / `square` 0                                   |
| `--tm-border-width`               | 1px；hi-dpi 下 0.5px（hairline）                                                             |
| `--tm-shadow-1/2/3`               | 由 `--tm-color-shadow` × `--tm-shadow-strength` 派生；strength 0 即无阴影                    |
| `--tm-blur`                       | 毛玻璃半径，默认 0                                                                           |

### 2.5 布局 `--tm-layout-*`

| 令牌                              | 默认                     | 说明                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--tm-sidebar-width`              | 300px                    | 平板及以上左栏（角色 / 聊天列表）                                                                                                                                                                                                                                                                                                                                        |
| `--tm-inspector-width`            | 340px                    | 桌面右栏（世界书 / 预设 / 角色信息）                                                                                                                                                                                                                                                                                                                                     |
| `--tm-chat-measure`               | 68ch                     | 消息列最大行宽；`layout.chatMeasure`                                                                                                                                                                                                                                                                                                                                     |
| `--tm-chat-width`                 | 100%                     | 消息区占可用宽度百分比（映射 ST `chat_width`）                                                                                                                                                                                                                                                                                                                           |
| `--tm-gutter`                     | space-5                  | 内容左右留白（手机 16px；平板 24px；桌面 32px）                                                                                                                                                                                                                                                                                                                          |
| `--tm-avatar-size`                | 40px                     | 消息头像                                                                                                                                                                                                                                                                                                                                                                 |
| `--tm-composer-min-h`             | 44px                     | 输入框最小高                                                                                                                                                                                                                                                                                                                                                             |
| `--tm-safe-top/right/bottom/left` | `env(safe-area-inset-*)` | Android 上 Chromium 的 `env()` 只含刘海，不含系统栏/键盘：`MainActivity.kt` 把 WindowInsets 推给 `apps/app/src/lib/insets.ts` 写入这些令牌（bottom = max(导航栏, 键盘)）。iOS 上 WKWebView 不缩布局视口而是把页面整体上推，`installKeyboardInset()` 用 `visualViewport` 把键盘高度写进 `--tm-safe-bottom` 并把 `scrollY` 钉在 0，键盘期间 `:root[data-tm-keyboard=open]` |

断点（不是令牌，固定）：`sm < 600`、`md ≥ 600`（双栏）、`lg ≥ 1024`（三栏）、`xl ≥ 1440`（三栏 + 更大 gutter）。

### 2.6 动效与层级

`--tm-duration-fast 120ms / normal 200ms / slow 320ms`、`--tm-ease: cubic-bezier(.2,.8,.2,1)`；`prefers-reduced-motion` 或主题 `reducedMotion` 时全部为 0ms。
`--tm-z-sticky 10 / drawer 20 / popover 30 / modal 40 / toast 50`；`--tm-z-system` 只给必须回答的弹窗用，压过扩展画在 `<body>` 上的任何东西。

## 3. 排版规范

- 正文 `--tm-font-body`，字号 `md`，行高 `relaxed`（衬线）或 `normal`（无衬线）——由 `typography.leading` 覆盖。
- 段落间距 `space-4`；消息之间 `space-7`；同一发言者连续消息 `space-3`。
- 角色名：`--tm-font-ui`、`sm`、600、`tracking-wide`、大写可选。时间戳：`xs`、`text-secondary`。
- 斜体动作描写用 `text-em`；引号对白用 `text-quote`；两者的字体跟随正文。
- 标题阶：页面标题 `2xl`/600、分区标题 `lg`/600、小节标签 `xs`/600/`tracking-wide`/`text-secondary`。
- 中英混排：字体栈先西文后中文，同一栈内保证衬线/无衬线一致（Songti ↔ Source Serif；PingFang ↔ Inter）。

## 4. 布局与留白

```
sm (手机)      [        chat        ]      顶栏 + 消息流 + 底部 composer；侧栏为抽屉
md (平板)      [sidebar | chat      ]      sidebar 固定 --tm-sidebar-width
lg (桌面)      [sidebar | chat | inspector]
```

- 消息列居中：手机 / 平板占满可用宽度并以 `--tm-chat-measure` 封顶（ST 在 ≤1000px 同样无视 `chat_width`）；桌面（lg）若主题给了 `layout.chatWidth` < 100 就按百分比占宽、不再叠行宽上限（`--tm-chat-desktop-max: none`），= 100 时仍按行宽封顶。左右 `--tm-gutter`。
- 消息布局 = ST `chat_display`（`layout.chatStyle`）：`flat`（平铺，默认）、`bubbles`（ST bubblechat：10px 圆角、bubble-user / bubble-bot 底色、发丝边）、`document`（ST documentstyle：只剩正文，不显示头像 / 名字 / 时间，消息间距收紧，最后一条仍有工具条）。三种共用 DOM；`:root[data-tm-chat-style]` 驱动。
- 头像形状 = ST `avatar_style`（`shape.avatar`）：`circle` / `square`（2px）/ `rounded`（md）/ `rectangle`（2:3 竖版，ST big-avatars）。
- 角色头像作聊天背景（`background.avatar`，app 独有；ST 的背景是按聊天选图）：`.tm-chat__bg` 绝对定位在消息列表后，`object-fit: cover`，不透明度 `background.opacity`（默认 0.25）、模糊 `background.blur`；图源优先 `backgrounds/character-<stem>.png`（换头像时按 `background.keepOriginal` 保存的大图，最长边 ≤ 2048），没有就退回 512×768 的卡片图。群聊用第一位成员。
- 我的消息位置（`layout.userSide`）：`right`（默认，头像与气泡靠右、文本仍左对齐）或 `left`（ST 习惯，全部靠左）。`:root[data-tm-user-side]` 驱动。
- 顶栏 56px，透明底，滚动后出现底部发丝线。聊天页默认**沉浸式**（`layout.immersiveChat`）：顶栏浮在消息流上方，无标题、无发丝线，只有左右两个图标按钮，按钮垫一层 72% 底色 + 轻模糊的圆盘保证在背景图上可读；消息列表顶部补 `topbar-height + safe-top` 的内边距。角色名 / 聊天文件名由列表顶部的分隔行给出。底部 composer 贴 safe-bottom，无边框，仅上方发丝线。
- 分区之间只用发丝线 `border` 与留白，不用背景色块区分（除 surface-sunken 的输入井）。

## 5. 主题文件格式 `tm-theme` v1

```jsonc
{
  "format": "tm-theme",
  "version": 1,
  "name": "Paper",
  "appearance": "light", // light | dark：未提供的颜色从哪套默认值补齐
  "typography": {
    "body": "serif", // serif | sans
    "ui": "sans", // serif | sans
    "scale": 1, // 0.8 – 1.4
    "leading": "relaxed", // tight | normal | relaxed
    "serif": "...",
    "sans": "...",
    "mono": "...", // 可选：自定义字体栈
  },
  "colors": { "bg": "...", "text": "..." /* §2.1 任意子集 */ },
  "shape": { "radius": 1, "avatar": "circle", "borderWidth": 1 }, // avatar: circle | square | rounded | rectangle；旧文件的 bubble 字段仍可解析但被忽略
  "background": { "avatar": false, "opacity": 0.25, "blur": 0, "keepOriginal": true },
  "layout": {
    "chatMeasure": 68,
    "chatWidth": 100,
    "density": "comfortable",
    "chatStyle": "flat",
    "userSide": "right", // right | left
    "chatStyle": "flat", // flat | bubbles | document（= ST chat_display 0/1/2）
    "immersiveChat": true,
    "showAvatars": true,
    "timestamps": true,
  },
  "effects": { "blur": 0, "shadow": 0, "reducedMotion": false },
  "customCss": "",
  "customCssEnabled": true, // 导入 ST 主题时为 false：ST 的 custom_css 针对 ST 完整 DOM，默认只保留不启用
  "st": {/* 导入 ST 主题时无法映射的字段原样保留，导出时写回 */},
}
```

- 除 `name` 外全部可选；缺省值见 `packages/ui/src/theme/defaults.ts`。
- zod schema：`packages/ui/src/theme/schema.ts`。非法文件拒绝导入并给出字段级错误。
- 内置主题：**Paper**（暖白、衬线正文）、**Ink**（墨黑、无衬线正文）。

## 6. ST 主题导入 / 导出

ST 主题（`getThemeObject()` 产物）→ `tm-theme`：

| ST 字段                      | tm-theme                                                       |
| ---------------------------- | -------------------------------------------------------------- |
| `main_text_color`            | `colors.text`                                                  |
| `italics_text_color`         | `colors.textEm`                                                |
| `underline_text_color`       | `colors.textLink`                                              |
| `quote_text_color`           | `colors.textQuote`                                             |
| `blur_tint_color`            | `colors.surface`（亮度决定 `appearance`）                      |
| `chat_tint_color`            | `colors.bg`                                                    |
| `user_mes_blur_tint_color`   | `colors.bubbleUser`                                            |
| `bot_mes_blur_tint_color`    | `colors.bubbleBot`                                             |
| `border_color`               | `colors.border`                                                |
| `shadow_color`               | `colors.shadow`                                                |
| `shadow_width` / `noShadows` | `effects.shadow`（noShadows → 0）                              |
| `blur_strength`              | `effects.blur`                                                 |
| `font_scale`                 | `typography.scale`                                             |
| `chat_width`                 | `layout.chatWidth`（只在桌面宽度生效，见 §4）                  |
| `chat_display` 0/1/2         | `layout.chatStyle`：flat / bubbles / document（双向无损）      |
| `avatar_style` 0/1/2/3       | `shape.avatar`：circle / rectangle / square / rounded（双向）  |
| `hideChatAvatars_enabled`    | `layout.showAvatars`（取反）                                   |
| `timestamps_enabled`         | `layout.timestamps`                                            |
| `reduced_motion`             | `effects.reducedMotion`                                        |
| `custom_css`                 | `customCss`（`customCssEnabled: false`，用户可在主题面板开启） |
| 其余字段                     | `st.*` 原样保留                                                |

导入时的三步还原（DEV_NOTES §9.26）：

1. **custom_css 里的变量覆盖优先**：美化主题几乎都在 `:root` 里重写 `--SmartTheme*`（常经自己的 `--x` 变量链、`rgba(var(--rgb), calc(...))`），这些值比上表的十个字段更接近作者的意图，先解析它们（`readRootVars` / `resolveCssValue`：`var()` 链、fallback、纯数字 `calc()`）。`@media (prefers-color-scheme: dark)` 里的 `:root` 覆盖若改了任一颜色，就多导出一个「· 夜间」变体。
2. **按 ST 的方式压平透明度**：ST 把这十个颜色叠在页面底色 `--greyCAIbg rgb(36,36,37)`（通常还有背景图）上；`chat_tint_color` 常是全透明的。我们没有背景图层，所以 `bg` = chat_tint 叠在页面色上，其余颜色再叠在 `bg` 上，保证没有一处导入后是透明的。`appearance` 取压平后 `bg` 的亮度。
3. **推导 ST 没有的 11 个令牌**：`textSecondary` / `textMuted` = 正文向底色混 30% / 52%；`surfaceRaised` / `surfaceSunken` = 面板向白 / 向正文（暗色向黑）轻混；`accent` = 下划线色（ST 的链接 / 强调色），`onAccent` 按其明暗取近白或近黑；`borderStrong` = 边框向正文混 35%；`scrim` = `bg` 55% 透明。danger / success / warning 仍用对应明暗的默认值。全透明的 `border_color` 保留为不可见（作者要的就是无边框）。

字体：`.mes_text { font-family }`（没有则 `#send_textarea`，再没有则 `--mainFontFamily`）决定正文字体栈与衬线 / 无衬线轨道；`--mainFontFamily` 决定界面字体；`--monoFontFamily` 决定等宽。

导出：上表反向；十个颜色优先写回 `st.*` 里保存的 ST 原字符串（因此导入即导出是字节等价的），本地新建的主题才用推导后的令牌；`st.*` 其余字段展开写回；未在 `st` 中的 ST 字段用 ST 默认值补齐，保证 ST 能直接加载。
ST 的 `--SmartTheme*` 变量由别名层提供，因此 `custom_css` 里引用这些变量的规则在我们这里同样生效；DOM 选择器按 DEV_NOTES §9.3 契约对齐。

## 7. 组件约定

- 所有组件 class 用 `tm-` 前缀；ST 契约 ID / class 按 §9.3 原样保留。
- 组件只引用语义层令牌；需要新值先加令牌、再写 `DESIGN.md`、再用。
- 触控目标 ≥ 44×44px；聚焦可见（`border-strong` 2px outline，offset 2px）。
- 手感按原生 App：全局 `touch-action: manipulation`（关掉 WebKit 双击缩放，连点两下就是两次点击），去掉灰色点按高亮。不用 viewport 的 `maximum-scale` / `user-scalable=no`：iOS 首次加载时它会让页面底部留白（见 `ios_layout.rs`）。
- 图标：线性、1.5px 描边、`currentColor`，尺寸 16 / 20 / 24。
- 空状态与加载态用文字 + 留白，不用插画。

## 8. 检查清单（PR 自查）

- [ ] `pnpm lint:tokens` 通过（无硬编码颜色 / 像素）
- [ ] 亮暗两套主题下看过
- [ ] 衬线 / 无衬线正文各看过一次
- [ ] 手机宽度无横向滚动，底部 composer 不被安全区遮挡
- [ ] 导入 `packages/ui/tests/fixtures/st-theme-sample.json` 后再导出，ST 可加载
