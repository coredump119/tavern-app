# Tavern

移动端优先的 SillyTavern 重写：Tauri 2 + Svelte 5 + Rust。数据都在本机，不需要服务器。

- 数据格式和 SillyTavern 1.18.0 互通：角色卡、聊天记录、世界书、预设、主题可以直接导入导出。
- 兼容 ST 扩展和酒馆助手脚本（还在补，不保证每个都能跑）。
- 目前是早期测试版，只在小范围内试用。

## 安装

- **Android**：到 [Releases](../../releases) 下载 `.apk`（arm64），在手机上允许「安装未知来源应用」后安装。
- **iOS**：通过 TestFlight 邀请安装。

升级时直接装新版本覆盖即可，数据会保留。换手机或想留底，用应用里的「备份」导出。

## 从源码构建

需要 Node 22+、pnpm、Rust；移动端另需 Android Studio（含 NDK）或 Xcode。

```bash
pnpm install
pnpm dev            # 浏览器里跑界面
pnpm tauri dev      # 桌面
pnpm tauri android build --apk --target aarch64
pnpm tauri ios build
pnpm test && pnpm typecheck && pnpm lint
```

对标的 ST 版本见 [COMPAT_TARGET.md](./COMPAT_TARGET.md)，设计规范见 [DESIGN.md](./DESIGN.md)。

## 许可

AGPL-3.0-only。本项目移植了 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 的部分逻辑，沿用其许可。

应用自带的中文衬线字体是 Noto Serif SC，按 SIL Open Font License 1.1 分发，许可全文在 `apps/app/public/licenses/`。
