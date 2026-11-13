/**
 * ST's extension-facing slash command classes (DEV_NOTES §9.34 第 2 轮): what
 * `/scripts/slash-commands/{SlashCommandParser,SlashCommand,SlashCommandArgument}.js` export, as far
 * as registering a command goes. A registered command runs in the executor of §9.5.
 */
import type { CommandContext, Named, SlashCommand as RunnerCommand } from '../slash/executor.js';
import { ARGUMENT_TYPE } from './context.js';

type Props = Record<string, unknown>;

const list = (value: unknown): unknown[] =>
  value == null ? [] : Array.isArray(value) ? value : [value];

/** ST `SlashCommandArgument`: the unnamed argument's description (constructor order as in ST) */
export class SlashCommandArgument {
  description: string;
  typeList: string[];
  isRequired: boolean;
  acceptsMultiple: boolean;
  defaultValue: unknown;
  enumList: unknown[];
  enumProvider: unknown;
  forceEnum: boolean;

  constructor(
    description: unknown = '',
    types: unknown = ARGUMENT_TYPE.STRING,
    isRequired: unknown = false,
    acceptsMultiple: unknown = false,
    defaultValue: unknown = null,
    enums: unknown = [],
    enumProvider: unknown = null,
    forceEnum: unknown = false,
  ) {
    this.description = String(description ?? '');
    this.typeList = list(types).map(String);
    this.isRequired = !!isRequired;
    this.acceptsMultiple = !!acceptsMultiple;
    this.defaultValue = defaultValue ?? null;
    this.enumList = list(enums);
    this.enumProvider = enumProvider ?? null;
    this.forceEnum = !!forceEnum;
  }

  static fromProps(props: Props): SlashCommandArgument {
    return new SlashCommandArgument(
      props['description'],
      props['typeList'] ?? [ARGUMENT_TYPE.STRING],
      props['isRequired'],
      props['acceptsMultiple'],
      props['defaultValue'],
      props['enumList'],
      props['enumProvider'],
      props['forceEnum'],
    );
  }
}

/** ST `SlashCommandNamedArgument` */
export class SlashCommandNamedArgument extends SlashCommandArgument {
  name: string;
  aliasList: string[];

  constructor(
    name: unknown = '',
    description: unknown = '',
    types: unknown = ARGUMENT_TYPE.STRING,
    isRequired: unknown = false,
    acceptsMultiple: unknown = false,
    defaultValue: unknown = null,
    enums: unknown = [],
    aliases: unknown = [],
    enumProvider: unknown = null,
    forceEnum: unknown = false,
  ) {
    super(
      description,
      types,
      isRequired,
      acceptsMultiple,
      defaultValue,
      enums,
      enumProvider,
      forceEnum,
    );
    this.name = String(name ?? '');
    this.aliasList = list(aliases).map(String);
  }

  static override fromProps(props: Props): SlashCommandNamedArgument {
    return new SlashCommandNamedArgument(
      props['name'],
      props['description'],
      props['typeList'] ?? [ARGUMENT_TYPE.STRING],
      props['isRequired'],
      props['acceptsMultiple'],
      props['defaultValue'],
      props['enumList'],
      props['aliasList'],
      props['enumProvider'],
      props['forceEnum'],
    );
  }
}

type StCallback = (named: Named, unnamed: unknown) => unknown;

/** ST `SlashCommand` (exported to extensions under that name) */
export class StSlashCommand {
  name = '';
  callback: StCallback = () => '';
  helpString = '';
  splitUnnamedArgument = false;
  splitUnnamedArgumentCount: number | undefined = undefined;
  rawQuotes = false;
  aliases: string[] = [];
  returns = '';
  namedArgumentList: SlashCommandNamedArgument[] = [];
  unnamedArgumentList: SlashCommandArgument[] = [];
  isExtension = true;
  isThirdParty = true;
  source = '';

  static fromProps(props: Props): StSlashCommand {
    return Object.assign(new StSlashCommand(), props);
  }
}

/** The executor's view of an ST command object */
export function toRunnerCommand(command: StSlashCommand): RunnerCommand {
  const named = Array.isArray(command.namedArgumentList) ? command.namedArgumentList : [];
  const repeatable = named.filter((arg) => arg?.acceptsMultiple).map((arg) => arg.name);
  const aliased = named.filter((arg) => arg?.aliasList?.length);
  const run = (args: Named, unnamed: unknown, context: CommandContext): unknown => {
    const given: Named = { ...args };
    for (const arg of aliased) {
      if (given[arg.name] !== undefined) continue;
      const alias = arg.aliasList.find((name) => given[name] !== undefined);
      if (alias !== undefined) given[arg.name] = given[alias];
    }
    given['_scope'] = context.scope;
    given['_hasUnnamedArgument'] = context.hasUnnamed;
    given['_abortController'] = {
      abort: () => context.abort(),
      get signal() {
        return { aborted: context.aborted };
      },
    };
    return command.callback(given, unnamed);
  };
  return {
    split: command.splitUnnamedArgument || undefined,
    splitCount: command.splitUnnamedArgumentCount,
    ...(repeatable.length > 0 ? { repeatable } : {}),
    run,
  };
}

/** ST refuses names its parser reads as syntax */
const RESERVED = ['/', '#', ':', 'parser-flag', 'breakpoint'];

export interface SlashCommandParserStatic {
  /** ST `SlashCommandParser.commands`: the commands extensions registered, by name and alias */
  readonly commands: Record<string, StSlashCommand>;
  addCommandObject(command: StSlashCommand): void;
  addCommandObjectUnsafe(command: StSlashCommand): void;
  /** the pre-1.12 form; also `registerSlashCommand` */
  addCommand(name: string, callback: StCallback, aliases?: string[], helpString?: string): void;
}

/** ST's static `SlashCommandParser` registration surface, writing into `registry` (name → runner command). */
export function createSlashCommandParser(
  registry: Map<string, RunnerCommand>,
): SlashCommandParserStatic {
  const commands: Record<string, StSlashCommand> = {};
  const names = (command: StSlashCommand) => [command.name, ...list(command.aliases).map(String)];
  const addCommandObjectUnsafe = (command: StSlashCommand): void => {
    if (typeof command?.name !== 'string' || !command.name)
      throw new Error('Slash command needs a name');
    if (typeof command.callback !== 'function')
      throw new Error(`Slash command "${command.name}" needs a callback`);
    const runner = toRunnerCommand(command);
    for (const name of names(command)) {
      if (Object.hasOwn(commands, name)) console.warn('[ext] 斜杠命令重复注册', name);
      commands[name] = command;
      registry.set(name, runner);
    }
  };
  const addCommandObject = (command: StSlashCommand): void => {
    for (const name of names(command)) {
      const start = RESERVED.find((prefix) => String(name).toLowerCase().startsWith(prefix));
      if (start) throw new Error(`Illegal Name. Slash command name cannot begin with "${start}".`);
    }
    addCommandObjectUnsafe(command);
  };
  return {
    commands,
    addCommandObject,
    addCommandObjectUnsafe,
    addCommand: (name, callback, aliases = [], helpString = '') =>
      addCommandObject(StSlashCommand.fromProps({ name, callback, aliases, helpString })),
  };
}
