// ST variables.js 的 get/set/add/inc/dec/has/del 移植（不含 index/as 参数，宏不使用）。
import type { VariableScopeApi } from '../state.js';

export type VariableStore = Record<string, unknown>;

/**
 * 创建一个作用域 API。store 会被就地修改（对应 chat_metadata.variables / extension_settings.variables.global），
 * 每次写入后调用 onChange（对应 saveMetadataDebounced / saveSettingsDebounced）。
 */
export function createVariableScope(
  store: VariableStore,
  onChange?: () => void,
  warn?: (msg: string) => void,
): VariableScopeApi {
  const get = (name: string): string | number => {
    const v = store[name] as { trim?: () => string } | string | number | undefined;
    const trimmed = typeof v === 'string' ? v.trim() : undefined;
    return trimmed === '' || isNaN(Number(v))
      ? (v as string | number | undefined) || ''
      : Number(v);
  };
  const set = (name: string, value: unknown): unknown => {
    if (!name) throw new Error('Variable name cannot be empty or undefined.');
    store[name] = value;
    onChange?.();
    return value;
  };
  const has = (name: string): boolean => store[name] !== undefined;
  const del = (name: string): string => {
    if (!has(name)) {
      warn?.(`The variable "${name}" does not exist.`);
      return '';
    }
    delete store[name];
    onChange?.();
    return '';
  };
  const add = (name: string, value: unknown): unknown => {
    const currentValue = get(name) || 0;
    try {
      const parsedValue: unknown = JSON.parse(String(currentValue));
      if (Array.isArray(parsedValue)) {
        parsedValue.push(value);
        set(name, JSON.stringify(parsedValue));
        return parsedValue;
      }
    } catch {
      // ignore non-array values
    }
    const increment = Number(value);
    if (isNaN(increment) || isNaN(Number(currentValue))) {
      const stringValue = String(currentValue || '') + String(value);
      set(name, stringValue);
      return stringValue;
    }
    const newValue = Number(currentValue) + increment;
    if (isNaN(newValue)) return '';
    set(name, newValue);
    return newValue;
  };
  return {
    get,
    set,
    del,
    add,
    inc: (name) => add(name, 1),
    dec: (name) => add(name, -1),
    has,
  };
}

/** chat_metadata.variables（缺失时创建）+ 全局变量存储 → { local, global } */
export function createVariableScopes(
  chatMetadata: Record<string, unknown>,
  globalStore: VariableStore,
  callbacks: {
    onLocalChange?: () => void;
    onGlobalChange?: () => void;
    warn?: (msg: string) => void;
  } = {},
): { local: VariableScopeApi; global: VariableScopeApi } {
  if (!chatMetadata['variables'] || typeof chatMetadata['variables'] !== 'object')
    chatMetadata['variables'] = {};
  return {
    local: createVariableScope(
      chatMetadata['variables'] as VariableStore,
      callbacks.onLocalChange,
      callbacks.warn,
    ),
    global: createVariableScope(globalStore, callbacks.onGlobalChange, callbacks.warn),
  };
}
