# st-oracle

把真实 SillyTavern（`COMPAT_TARGET.md` 锁定的版本）当测试预言机：用临时 config / data 目录无交互拉起 ST，
通过 `reverse_proxy` 把它指向本地的 OpenAI 兼容 mock 后端，捕获 ST 最终发出的请求体，与 `packages/core` 的组装结果逐字节比对（Phase 2）。

```bash
pnpm --filter @tm/tool-st-oracle run setup-st   # 浅取 COMPAT_TARGET commit 到 .st/ 并 npm ci；设 ST_ORACLE_DIR 可改用现有副本
pnpm --filter @tm/tool-st-oracle test    # 没有可用 ST 时自动跳过 ST 用例
```

ST 查找顺序：`$ST_ORACLE_DIR` → `tools/st-oracle/.st` → 仓库旁边的 `../SillyTavern`。

## Phase 2 对拍（`tests/parity.test.ts`）

Playwright 驾驭真实 ST 前端对每个场景点一次 Generate，mock 后端捕获发给上游的原始请求体，与 `@tm/core` 回放结果字节级比对。

```bash
pnpm --filter @tm/tool-st-oracle exec playwright install chromium   # 首次
pnpm --filter @tm/tool-st-oracle test                                # 全部场景（≈2 分钟）
ORACLE_ONLY=world-info pnpm --filter @tm/tool-st-oracle exec vitest run tests/parity.test.ts   # 只跑名字含该子串的场景
ORACLE_HEADED=1 ...                                                  # 显示浏览器
```

场景写在 `tests/scenarios.ts`（ST 原生格式）；差异会以 `toEqual` 的结构 diff 呈现，再做字符串比对。
