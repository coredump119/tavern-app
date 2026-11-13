/**
 * Prompt injections and macro-likes (DEV_NOTES §9.5 第 3 轮 → 注入). The injection table lives in
 * the app; what cannot leave the realm stays here — a prompt's `filter` closure and the
 * macro-like replacers — and the app asks for their verdict right before a generation.
 */
import _ from 'lodash';
import { stringify } from 'yaml';
import type { Variables } from '../../protocol.js';
import type { ApiModule, Hub } from '../hub.js';
import { isRecord } from '../util.js';
import { messageVariables } from '../variables.js';
import { records, text } from './shared.js';

interface InjectionPrompt {
  id: string;
  position: 'in_chat' | 'none';
  depth: number;
  role: 'system' | 'assistant' | 'user';
  content: string;
  filter?: () => unknown;
  should_scan?: boolean;
}

interface MacroLikeContext {
  message_id?: number;
  role?: 'user' | 'assistant' | 'system';
}
type Replacer = (context: MacroLikeContext, substring: string, ...args: unknown[]) => unknown;
interface MacroLike {
  regex: RegExp;
  replace: Replacer;
  owner: object;
}

const sameRegex = (a: RegExp, b: RegExp): boolean => a.source === b.source && a.flags === b.flags;

type MacroScope = 'message' | 'chat' | 'character' | 'preset' | 'global';
const SCOPES = 'message|chat|character|preset|global';
const GET_VARIABLE = new RegExp(`\\{\\{get_(${SCOPES})_variable::(.*?)\\}\\}`, 'gi');
/** group 1 is what stands before the macro on its line: the YAML is indented to line up with it */
const formatVariable = (suffix: string, flags: string): RegExp =>
  new RegExp(`^(.*)\\{\\{format_(${SCOPES})_variable${suffix}::(.*?)\\}\\}`, flags);

/** keys starting with `$` are a script's own bookkeeping (MVU's `$meta`): never shown */
const visible = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(visible);
  if (!isRecord(value)) return value;
  const shown: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key.startsWith('$')) shown[key] = visible(item);
  }
  return shown;
};

export function injectModule(hub: Hub): ApiModule {
  /** the filters of injected prompts by id, with the frame whose closure it is */
  const filters = new Map<string, { filter: () => unknown; owner: object }>();

  // ---- the variable macros every script can count on (upstream ships the same three) ----
  /** A message macro without a 楼层 reads the latest message that has variables */
  const variablesOf = (scope: MacroScope, context: MacroLikeContext): Variables => {
    if (scope !== 'message') return hub.stored(scope);
    let index = context.message_id ?? hub.chat.length - 1;
    if (context.message_id === undefined) {
      while (index >= 0 && !Object.keys(messageVariables(hub.chat[index]!)).length) index--;
    }
    const message = hub.chat[index];
    return message ? messageVariables(message) : {};
  };
  const valueAt = (context: MacroLikeContext, scope: unknown, path: unknown): unknown =>
    visible(_.get(variablesOf(scope as MacroScope, context), _.unescape(String(path)), null));
  const formatter = (suffix: string, quoted: boolean): MacroLike => {
    const inner = formatVariable(suffix, 'im');
    const replace: Replacer = (context, _all, before, scope, path) => {
      // the same macro earlier on the line comes first: where it ends decides the indentation
      const prefix = String(before).replace(inner, (all: string, ...args: unknown[]) =>
        String(replace(context, all, ...args)),
      );
      const value = valueAt(context, scope, path);
      const yaml =
        typeof value === 'string'
          ? value
          : stringify(value, {
              blockQuote: 'literal',
              ...(quoted ? { defaultKeyType: 'PLAIN', defaultStringType: 'QUOTE_DOUBLE' } : {}),
            }).trimEnd();
      return prefix + yaml.replaceAll('\n', `\n${' '.repeat(prefix.length)}`);
    };
    return { regex: formatVariable(suffix, 'gim'), replace, owner: hub };
  };
  let macros: MacroLike[] = [
    {
      regex: GET_VARIABLE,
      replace: (context, _all, scope, path) => {
        const value = valueAt(context, scope, path);
        return typeof value === 'string' ? value : JSON.stringify(value);
      },
      owner: hub,
    },
    formatter('_quoted', true),
    formatter('', false),
  ];

  /**
   * The app is told whenever the scripts' own list changes: it skips texts without braces unless
   * a script registered an expression, and shows the messages on screen with the new list.
   */
  const setMacros = (next: MacroLike[]): void => {
    const changed = next.length !== macros.length || next.some((macro, i) => macro !== macros[i]);
    macros = next;
    if (!changed) return;
    const custom = next.some((macro) => macro.owner !== hub);
    void hub.call('macro.changed', [custom]).catch(() => undefined);
  };

  const uninject = (ids: readonly string[]): void => {
    for (const id of ids) filters.delete(id);
    if (ids.length) void hub.call('inject.remove', [ids]).catch(() => undefined);
  };

  const applyMacros = (input: string, context: MacroLikeContext): string => {
    let output = input;
    for (const macro of macros) {
      try {
        output = output.replace(macro.regex, (substring: string, ...args: unknown[]) =>
          String(macro.replace(context, substring, ...args)),
        );
      } catch (e) {
        console.warn('[TavernHelper] registerMacroLike 的替换函数出错', e);
      }
    }
    return output;
  };

  const roleOf = (index: number): MacroLikeContext['role'] => {
    const message = hub.chat[index];
    if (!message) return undefined;
    if (message.is_user) return 'user';
    return message.is_system ? 'system' : 'assistant';
  };
  const contextOf = (index: number): MacroLikeContext => {
    const role = roleOf(index);
    return { ...(index >= 0 ? { message_id: index } : {}), ...(role ? { role } : {}) };
  };

  // a frame that goes away takes its closures with it
  hub.onRelease((owner) => {
    setMacros(macros.filter((macro) => macro.owner !== owner));
    uninject([...filters].filter(([, entry]) => entry.owner === owner).map(([id]) => id));
  });

  // card documents get the macro-likes applied to their source, like upstream's rendering hook
  hub.cardFilters.push((html, messageId) => applyMacros(html, contextOf(messageId)));

  hub.provide('injects.active', async (id) => {
    const entry = filters.get(text(id));
    if (!entry) return true;
    try {
      return !!(await entry.filter());
    } catch (e) {
      console.warn('[TavernHelper] injectPrompts 的 filter 出错，按生效处理', e);
      return true;
    }
  });

  /** `[{ text, index? , role? }]` → the texts with every macro-like applied */
  hub.provide('macro.apply', (items) =>
    records(items).map((item) => {
      const input = text(item['text']);
      const index = typeof item['index'] === 'number' ? item['index'] : -1;
      const role = item['role'];
      return applyMacros(input, {
        ...contextOf(index),
        ...(role === 'user' || role === 'assistant' || role === 'system' ? { role } : {}),
      });
    }),
  );

  return ({ owner, frame }) => {
    const uninjectPrompts = (ids: unknown): void => {
      uninject(Array.isArray(ids) ? ids.map(String) : []);
    };
    return {
      injectPrompts: (
        prompts: InjectionPrompt[],
        option: { once?: boolean } = {},
      ): { uninject: () => void } => {
        const list = (Array.isArray(prompts) ? prompts : []).filter(isRecord);
        const ids = list.map((prompt) => String(prompt.id));
        const plain = list.map((prompt) => {
          const id = String(prompt.id);
          if (typeof prompt.filter === 'function')
            filters.set(id, { filter: prompt.filter, owner });
          else filters.delete(id);
          return {
            id,
            position: prompt.position === 'none' ? 'none' : 'in_chat',
            depth: Number(prompt.depth) || 0,
            role: String(prompt.role ?? 'system'),
            content: String(prompt.content ?? ''),
            scan: !!prompt.should_scan,
            filtered: typeof prompt.filter === 'function',
          };
        });
        void hub
          .call('inject.add', [plain, !!option.once], frame.name)
          .catch((e: unknown) => console.warn('[TavernHelper] injectPrompts', e));
        return { uninject: () => uninjectPrompts(ids) };
      },
      uninjectPrompts,
      registerMacroLike: (regex: RegExp, replace: Replacer): { unregister: () => void } => {
        const entry: MacroLike = { regex, replace, owner };
        // registering the same expression again replaces the earlier replacer
        setMacros([...macros.filter((macro) => !sameRegex(macro.regex, regex)), entry]);
        return {
          unregister: () => setMacros(macros.filter((macro) => macro !== entry)),
        };
      },
      unregisterMacroLike: (regex: RegExp): void => {
        setMacros(macros.filter((macro) => !sameRegex(macro.regex, regex)));
      },
    };
  };
}
