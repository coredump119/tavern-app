# sample-extension

自己写的一个最小酒馆第三方扩展，用来在真机 / 模拟器上验收扩展兼容层（DEV_NOTES §9.34）。它只用酒馆公开的扩展接口，不含任何别人扩展的代码。

用法：把 `tm-sample/` 整个文件夹放进应用数据目录的 `extensions/` 下（或打成 zip 在「扩展」页安装），重新载入。

它会依次检查：

- 入口脚本、样式、`activate` 钩子、`import` 酒馆模块（`/script.js`、`/scripts/extensions.js`、`/scripts/popup.js`）
- `SillyTavern.getContext()`、`extension_settings` 读写、事件（`APP_READY`、`CHAT_CHANGED`、消息事件）
- 往 `#extensions_settings` 加一个抽屉面板、往 `#extensionsMenu` 加一项、`toastr`、`callGenericPopup`、模板
- 用酒馆的 slash 模块登记一条命令并执行、两种写法登记宏、`generateRaw` / `generateQuietPrompt` 在不在、manifest 的 `generate_interceptor`
- `#qr--bar` 不在聊天页时也找得到、往里加的按钮进聊天页后还在；`#top-settings-holder` 找得到
- `/api/images/upload` 存一张自己拼的 1×1 图（落在 `user/images/tm-sample/`）、拒收别的格式；`/api/extensions/version` 回得出来
- 登记一个函数工具（`tm_sample_clock`）并直接调一次、`swipe.to` 在不在；每次生成结束在控制台打一行 `[tm-sample] 事件顺序 …`
- 故意用一个不存在的导出、一个不存在的 context 成员、一个没做的服务端接口，看「缺的接口」有没有列出来

结果写在它自己的设置面板里，也挂在 `window.tmSample` 上，并在控制台打一行 `[tm-sample] N/M 通过`。
