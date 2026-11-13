// ST PromptManager.js 中与组装相关的部分：Prompt / PromptCollection / 顺序与开关 / preparePrompt。
import type { SubstituteOptions } from '../../macros/engine.js';
import {
  DEFAULT_INJECTION_ORDER,
  PROMPT_MANAGER_DUMMY_CHARACTER_ID,
  chatCompletionDefaultPrompts,
  promptManagerDefaultPromptOrder,
  type ChatCompletionSettings,
  type PromptDef,
  type PromptOrderEntry,
} from './types.js';

/** Prompt 构造入参：允许显式 undefined（exactOptionalPropertyTypes） */
export interface PromptInput {
  identifier?: string | undefined;
  name?: string | undefined;
  role?: string | undefined;
  content?: string | undefined;
  system_prompt?: boolean | undefined;
  marker?: boolean | undefined;
  position?: string | number | false | undefined;
  injection_position?: number | undefined;
  injection_depth?: number | undefined;
  injection_order?: number | undefined;
  injection_trigger?: string[] | undefined;
  forbid_overrides?: boolean | undefined;
  extension?: boolean | undefined;
}

export class Prompt {
  identifier: string;
  role: string | undefined;
  content: string | undefined;
  name: string | undefined;
  system_prompt: boolean | undefined;
  position: string | number | false | undefined;
  injection_depth: number | undefined;
  injection_position: number | undefined;
  injection_order: number;
  injection_trigger: string[];
  forbid_overrides: boolean | undefined;
  extension: boolean;
  marker?: boolean | undefined;

  constructor(p: PromptInput = {}) {
    this.identifier = p.identifier ?? '';
    this.role = p.role;
    this.content = p.content;
    this.name = p.name;
    this.system_prompt = p.system_prompt;
    this.position = p.position;
    this.injection_depth = p.injection_depth;
    this.injection_position = p.injection_position;
    this.forbid_overrides = p.forbid_overrides;
    this.extension = p.extension ?? false;
    this.injection_order = p.injection_order ?? DEFAULT_INJECTION_ORDER;
    this.injection_trigger = p.injection_trigger ?? [];
    this.marker = p.marker;
  }
}

export class PromptCollection {
  collection: Prompt[] = [];
  overriddenPrompts: string[] = [];
  constructor(...prompts: Prompt[]) {
    this.add(...prompts);
  }
  add(...prompts: Prompt[]): void {
    for (const p of prompts)
      if (!(p instanceof Prompt))
        throw new Error('Only Prompt instances can be added to PromptCollection');
    this.collection.push(...prompts);
  }
  set(prompt: Prompt, position: number): void {
    this.collection[position] = prompt;
  }
  get(identifier: string): Prompt | undefined {
    return this.collection.find((p) => p.identifier === identifier);
  }
  index(identifier: string): number {
    return this.collection.findIndex((p) => p.identifier === identifier);
  }
  has(identifier: string): boolean {
    return this.index(identifier) !== -1;
  }
  override(prompt: Prompt, position: number): void {
    this.set(prompt, position);
    this.overriddenPrompts.push(prompt.identifier);
  }
}

export interface ActiveCharacter {
  id: number | string;
  /** 'character' 策略下群聊时附带的 group（members 为头像文件名） */
  group?: { members?: string[] } | undefined;
}

export interface PromptManagerDeps {
  settings: ChatCompletionSettings;
  substitute: (text: string, options?: SubstituteOptions) => string;
  /** 默认全局策略：{ id: 100001 } */
  activeCharacter?: ActiveCharacter | null | undefined;
}

/** PromptManager 的非 UI 子集 */
export class PromptManager {
  readonly settings: ChatCompletionSettings;
  activeCharacter: ActiveCharacter | null;
  readonly #substitute: PromptManagerDeps['substitute'];

  constructor({ settings, substitute, activeCharacter }: PromptManagerDeps) {
    this.settings = settings;
    this.#substitute = substitute;
    this.activeCharacter =
      activeCharacter === undefined ? { id: PROMPT_MANAGER_DUMMY_CHARACTER_ID } : activeCharacter;
    if (
      this.activeCharacter &&
      this.getPromptOrderForCharacter(this.activeCharacter).length === 0
    ) {
      this.addPromptOrderForCharacter(this.activeCharacter, promptManagerDefaultPromptOrder);
    }
    this.sanitizeServiceSettings();
  }

  /**
   * ST sanitizeServiceSettings：prompts 为空则用默认集；否则补齐缺失的默认 prompt（push 到末尾）；
   * 再删掉当前角色 prompt_order 里引用了不存在 prompt 的条目。
   */
  sanitizeServiceSettings(): void {
    this.settings.prompts ??= [];
    this.settings.prompt_order ??= [];
    if (this.settings.prompts.length === 0) {
      this.settings.prompts = structuredClone(chatCompletionDefaultPrompts);
    } else {
      for (const def of chatCompletionDefaultPrompts) {
        if (!this.settings.prompts.some((p) => p?.identifier === def.identifier)) {
          this.settings.prompts.push(structuredClone(def));
        }
      }
    }
    if (this.activeCharacter) {
      const refs = this.getPromptOrderForCharacter(this.activeCharacter);
      for (let i = refs.length - 1; i >= 0; i--) {
        const ref = refs[i];
        if (ref && !this.settings.prompts.some((p) => p.identifier === ref.identifier)) {
          refs.splice(i, 1);
        }
      }
    }
  }

  getPromptOrderForCharacter(character: ActiveCharacter | null): PromptOrderEntry[] {
    if (!character) return [];
    return (
      this.settings.prompt_order.find((list) => String(list.character_id) === String(character.id))
        ?.order ?? []
    );
  }
  addPromptOrderForCharacter(character: ActiveCharacter, promptOrder: PromptOrderEntry[]): void {
    this.settings.prompt_order.push({
      character_id: character.id,
      order: JSON.parse(JSON.stringify(promptOrder)) as PromptOrderEntry[],
    });
  }
  getPromptOrderEntry(
    character: ActiveCharacter | null,
    identifier: string,
  ): PromptOrderEntry | null {
    return (
      this.getPromptOrderForCharacter(character).find((e) => e.identifier === identifier) ?? null
    );
  }
  getPromptById(identifier: string): PromptDef | null {
    return this.settings.prompts.find((item) => item && item.identifier === identifier) ?? null;
  }
  isPromptDisabledForActiveCharacter(identifier: string): boolean {
    const entry = this.getPromptOrderEntry(this.activeCharacter, identifier);
    if (entry) return !entry.enabled;
    return false;
  }
  getActiveGroupCharacters(): string[] {
    return (this.activeCharacter?.group?.members || []).map(
      (member) => member && member.substring(0, member.lastIndexOf('.')),
    );
  }

  preparePrompt(prompt: PromptInput, original: string | null = null): Prompt {
    const groupMembers = this.getActiveGroupCharacters();
    const prepared = new Prompt(prompt);
    const opts: SubstituteOptions = {};
    if (typeof original === 'string') opts.original = original;
    if (groupMembers.length > 0) opts.groupOverride = groupMembers.join(', ');
    prepared.content = this.#substitute(prompt.content ?? '', opts);
    return prepared;
  }

  isValidName(name: string): boolean {
    return /^[a-zA-Z0-9_]{1,64}$/.test(name);
  }
  sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 64);
  }

  shouldTrigger(prompt: PromptDef | null, generationType: string): boolean {
    if (!Array.isArray(prompt?.injection_trigger)) return true;
    if (!prompt.injection_trigger.length) return true;
    return prompt.injection_trigger.includes(generationType);
  }

  getPromptCollection(generationType: string | null | undefined): PromptCollection {
    const type = String(generationType || 'normal')
      .toLowerCase()
      .trim();
    const collection = new PromptCollection();
    for (const entry of this.getPromptOrderForCharacter(this.activeCharacter)) {
      const prompt = this.getPromptById(entry.identifier);
      if (!prompt) continue;
      const allowedTrigger = entry.enabled && this.shouldTrigger(prompt, type);
      if (allowedTrigger) {
        collection.add(this.preparePrompt(prompt));
      } else if (entry.identifier === 'main') {
        const replacement = structuredClone(prompt);
        replacement.content = '';
        collection.add(this.preparePrompt(replacement));
      }
    }
    return collection;
  }
}
