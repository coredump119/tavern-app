/**
 * `/popup`, `/input`, `/buttons` (ST slash-commands.js). The dialogs are the app's own
 * (`lib/popup.svelte.ts`): plain text, one at a time.
 */
import {
  isTrue,
  resolveVariable,
  SlashClosure,
  SlashError,
  type CommandContext,
  type Named,
} from '@tm/st-compat';
import { record, text, type AddCommand, type SlashEnv } from './shared';

/** ST's default for `/input rows=` */
const INPUT_ROWS = 4;

/** The text arguments that were written, under the names the dialog knows them by */
function written<K extends string>(
  named: Named,
  names: Readonly<Record<K, string>>,
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const key of Object.keys(names) as K[]) {
    const value = named[names[key]];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** `/buttons labels=`: a JSON list of texts or `{ text }` objects; null for anything else, as ST */
function buttonLabels(source: unknown): string[] | null {
  // a variable can hold the list itself
  let parsed = source;
  if (typeof source === 'string') {
    try {
      parsed = JSON.parse(source);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const labels = parsed.map((item) => (typeof item === 'string' ? item : record(item)?.['text']));
  if (!labels.every((label): label is string => typeof label === 'string' && label !== '')) {
    return null;
  }
  // the dialog tells its buttons apart by their text
  return [...new Set(labels)];
}

async function runHandler(name: string, handler: unknown, context: CommandContext): Promise<void> {
  if (handler === undefined) return;
  if (!(handler instanceof SlashClosure)) throw new SlashError(`/input 的 ${name}= 必须是闭包`);
  await context.call(handler);
}

export function popupCommands(add: AddCommand, env: Pick<SlashEnv, 'ask' | 'variables'>): void {
  add(['popup'], {
    run: async (named, unnamed) => {
      const body = text(unnamed);
      const answer = await env.ask({
        kind: 'confirm',
        text: body,
        ...written(named, { title: 'header', okButton: 'okButton', cancelButton: 'cancelButton' }),
      });
      if (!isTrue(named['result'])) return body;
      // ST: 1 for OK, 0 for cancel, nothing when the dialog was closed some other way
      return answer === null ? '' : answer ? '1' : '0';
    },
  });

  add(['input'], {
    run: async (named, unnamed, context) => {
      const rows = Number(named['rows'] ?? INPUT_ROWS);
      const answer = await env.ask({
        kind: 'input',
        text: text(unnamed),
        rows: Number.isNaN(rows) ? INPUT_ROWS : rows,
        ...written(named, { value: 'default', okButton: 'okButton', cancelButton: 'cancelButton' }),
      });
      if (typeof answer === 'string') await runHandler('onSuccess', named['onSuccess'], context);
      else await runHandler('onCancel', named['onCancel'], context);
      return typeof answer === 'string' ? answer : '';
    },
  });

  add(['buttons'], {
    run: async (named, unnamed, context) => {
      if (isTrue(named['multiple'])) throw new SlashError('/buttons 暂不支持 multiple=true');
      const source = resolveVariable(env.variables, text(named['labels']), context.scope);
      const labels = buttonLabels(source);
      if (!labels) return '';
      const answer = await env.ask({ kind: 'buttons', text: text(unnamed), labels });
      return typeof answer === 'string' ? answer : '';
    },
  });
}
