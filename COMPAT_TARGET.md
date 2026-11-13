# COMPAT_TARGET

对标的 SillyTavern 版本。所有兼容性契约（DEV_NOTES §9）以此版本的源码为准。

| 项           | 值                                         |
| ------------ | ------------------------------------------ |
| ST 版本      | 1.18.0                                     |
| commit       | `8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8` |
| commit 日期  | 2026-07-07                                 |
| 本地参考副本 | `../SillyTavern/`（不入库）                |

## 需对齐版本的捆绑库（DEV_NOTES §2）

从 `../SillyTavern/package.json` 与 `public/lib/` 抄录，Phase 6 填表：

| 库          | ST 版本 |
| ----------- | ------- |
| jQuery      | _TBD_   |
| lodash      | _TBD_   |
| DOMPurify   | _TBD_   |
| showdown    | _TBD_   |
| toastr      | _TBD_   |
| moment      | _TBD_   |
| Handlebars  | _TBD_   |
| Fuse.js     | _TBD_   |
| localforage | _TBD_   |

## 主题格式参考

ST 主题对象字段：`public/scripts/power-user.js` → `getThemeObject()`（第 2535 行起）。
ST 主题 CSS 变量契约：`public/style.css` 中 `--SmartTheme*`、`--mainFontSize`、`--sheldWidth`、`--avatar-base-*`。
我们的映射见 `DESIGN.md §6`。
