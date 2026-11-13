# @tm/formats

ST 数据格式的 zod schema 与编解码。原则：**宽松校验、不丢字段**——所有对象 `loose()`，解析不注入默认值，
round-trip 后与原始 JSON 深度相等；需要默认值的地方走单独的 `normalize*()`。

- `card.ts`：角色卡 V1 / V2 / V3（含 character_book、ST extensions），`parseCard` / `toV2` / `toV3`
- `png-text.ts`：PNG tEXt 读写（`chara` / `ccv3`），与 Rust `src-tauri/src/card` 行为一致；浏览器开发模式用
- `chat.ts`：chat jsonl（header / message / swipe），`parseChatJsonl` / `serializeChatJsonl`
- `world-info.ts`：世界书文件 `{entries:{uid:…}}`，与卡内 `character_book` 的双向转换
- `presets.ts`：CC / TC / Kobold / Novel 预设、context / instruct / sysprompt / reasoning 模板，`PRESET_FOLDERS` 目录映射
- `regex.ts`：正则脚本（全局与角色内共用）
- `quick-reply.ts`：Quick Reply 集 v2 与 v1 升级
