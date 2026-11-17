// @tm/core — prompt 组装、宏、世界书扫描、正则、上下文裁剪、消息渲染（Markdown）。禁止 import Svelte / Tauri / DOM。
export const PACKAGE = '@tm/core' as const;
export * from './state.js';
export * from './macros/index.js';
export * from './util/index.js';
export {
  baseChatReplace,
  collapseNewlines,
  createLazyFields,
  getCharacterCardFields,
  getCharacterCardFieldsLazy,
  getGroupCharacterCardsLazy,
  type CharacterCardFields,
  type BaseSubstitute,
} from './prompt/character-fields.js';
export {
  parseMesExamples,
  parseExampleIntoIndividual,
  formatInstructModeExamples,
  getGroupNames,
  type ExampleMessage,
} from './prompt/examples.js';
export * from './world-info/index.js';
export * from './prompt/extension-prompts.js';
export * from './prompt/authors-note.js';
export * from './prompt/persona.js';
export * from './prompt/depth-prompts.js';
export * from './prompt/reasoning.js';
export * from './prompt/chat-completion/index.js';
export * from './prompt/core-chat.js';
export * from './prompt/text-completion/index.js';
export * from './regex/index.js';
export * from './tokens/index.js';
export * from './group/index.js';
export * from './prompt/connection.js';
export * from './render/index.js';
export * from './tags/index.js';
export * from './presets/index.js';
export * from './presets/textgen.js';
export * from './prompt/clean-up.js';
export * from './persona/index.js';
export * from './background/index.js';
export * from './chat/bookmarks.js';
export * from './chat/import.js';
export * from './chat/hidden.js';
