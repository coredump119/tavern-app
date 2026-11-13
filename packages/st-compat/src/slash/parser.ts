/**
 * Slash script → AST. The grammar follows ST's `SlashCommandParser` (DEV_NOTES §9.5 第 2 轮):
 * commands separated by `|`, `||` to stop the pipe from being injected into the next command,
 * `key=value` named arguments, one unnamed argument running to the end of the command, closures
 * `{: … :}` (optionally with parameters, optionally run on the spot with `()`), `//` `/#` and
 * block comments, and the `/:name` shorthand for `/run name`.
 */

export class SlashError extends Error {
  override name = 'SlashError';
}

export interface ClosureNode {
  type: 'closure';
  /** `{: a=1 b= … :}` — parameters and their defaults */
  params: NamedNode[];
  commands: CommandNode[];
  /** `{: … :}()` — run where it stands; the argument is its pipe */
  immediate: boolean;
}
export type ValueNode = string | ClosureNode;
export interface NamedNode {
  name: string;
  value: ValueNode;
}
export interface CommandNode {
  /** `break` is the parser's own `/break`; everything else is looked up when run */
  name: string;
  named: NamedNode[];
  /** The unnamed argument in parts; a command that does not split gets them joined */
  unnamed: ValueNode[];
  /** false after `||` */
  injectPipe: boolean;
}

/** What the parser needs to know about a command */
export interface CommandShape {
  /** the unnamed argument is a whitespace-separated list */
  split?: boolean | undefined;
  /** …of which only the first `splitCount` are split off; the rest is one value */
  splitCount?: number | undefined;
}
export type CommandLookup = (name: string) => CommandShape | undefined;

/** Parsed and dropped: they only steer ST's own parser and debugger */
const IGNORED = new Set(['parser-flag', 'breakpoint']);
/** A backslash in front of one of these makes it plain text */
const ESCAPABLE = ['{:', ':}', '|', '"'];
const NAMED = /\w+=/y;
const SPACE = /\s/;

class Parser {
  private i = 0;
  private depth = 0;

  constructor(
    private readonly text: string,
    private readonly lookup: CommandLookup,
  ) {}

  parse(): ClosureNode {
    return this.closure(true);
  }

  private get eof(): boolean {
    return this.i >= this.text.length;
  }
  private at(sequence: string): boolean {
    return this.text.startsWith(sequence, this.i);
  }
  private atSpace(): boolean {
    return !this.eof && SPACE.test(this.text[this.i]!);
  }
  private skipSpace(): void {
    while (this.atSpace()) this.i++;
  }
  private closureEnd(): boolean {
    if (this.depth === 0) return this.eof;
    if (this.eof) throw new SlashError('闭包没有结束（缺少 :}）');
    return this.at(':}');
  }
  private commandEnd(): boolean {
    return this.eof || this.at('|') || (this.depth > 0 && this.at(':}'));
  }
  private namedAhead(): boolean {
    NAMED.lastIndex = this.i;
    return NAMED.test(this.text);
  }

  /**
   * One unit of plain text. An odd run of backslashes before a structural symbol escapes it (each
   * pair before that is one backslash); a `{{macro}}` is taken whole so a `|` inside is not a pipe.
   */
  private takeOne(): string {
    const text = this.text;
    if (text[this.i] === '\\') {
      let n = 1;
      while (text[this.i + n] === '\\') n++;
      const symbol = ESCAPABLE.find((s) => text.startsWith(s, this.i + n));
      if (symbol) {
        this.i += n;
        const kept = '\\'.repeat(n >> 1);
        if (n % 2 === 0) return kept;
        this.i++;
        return kept + symbol[0]!;
      }
    } else if (this.at('{{')) {
      const end = this.macroEnd();
      if (end > 0) {
        const macro = text.slice(this.i, end);
        this.i = end;
        return macro;
      }
    }
    return text[this.i++]!;
  }
  /** Index just past the `}}` closing the macro at the cursor; -1 when it never closes */
  private macroEnd(): number {
    let open = 0;
    for (let j = this.i; j < this.text.length - 1; j++) {
      if (this.text.startsWith('{{', j)) {
        open++;
        j++;
      } else if (this.text.startsWith('}}', j)) {
        open--;
        j++;
        if (open === 0) return j + 1;
      }
    }
    return -1;
  }
  private takeUntil(stop: () => boolean): string {
    let out = '';
    while (!this.eof && !stop()) out += this.takeOne();
    return out;
  }

  private closure(root: boolean): ClosureNode {
    if (!root) {
      this.i += 2;
      this.depth++;
    }
    const node: ClosureNode = { type: 'closure', params: [], commands: [], immediate: false };
    this.skipSpace();
    while (this.namedAhead()) {
      node.params.push(this.named());
      this.skipSpace();
    }
    let injectPipe = true;
    while (!this.closureEnd()) {
      if (this.at('/*')) {
        const end = this.text.indexOf('*/', this.i + 2);
        this.i = end < 0 ? this.text.length : end + 2;
      } else if (this.at('//') || this.at('/#')) {
        this.takeUntil(() => this.commandEnd());
      } else if (this.at('/')) {
        const command = this.at('/:') ? this.runShorthand() : this.command();
        if (command) {
          command.injectPipe = injectPipe;
          node.commands.push(command);
        }
        injectPipe = true;
      } else {
        // text that is not a command is dropped, as in ST
        this.takeUntil(() => this.commandEnd());
      }
      this.skipSpace();
      if (this.at('|')) {
        this.i++;
        if (this.at('|')) {
          this.i++;
          injectPipe = false;
        }
      }
      this.skipSpace();
    }
    if (!root) {
      this.i += 2;
      this.depth--;
      if (this.at('()')) {
        this.i += 2;
        node.immediate = true;
      }
    }
    return node;
  }

  private command(): CommandNode | null {
    this.i++;
    let name = '';
    while (!this.atSpace() && !this.commandEnd()) name += this.text[this.i++];
    this.skipSpace();
    if (IGNORED.has(name)) {
      this.takeUntil(() => this.commandEnd());
      return null;
    }
    const shape = name === 'break' ? {} : this.lookup(name);
    if (!shape) throw new SlashError(`未支持的 slash 命令：/${name}`);
    return this.argumentsOf(name, shape);
  }

  /** `/:name args` ≡ `/run name args` */
  private runShorthand(): CommandNode {
    this.i += 2;
    const name = this.at('"')
      ? this.quoted()
      : this.takeUntil(() => this.atSpace() || this.commandEnd());
    this.skipSpace();
    const node = this.argumentsOf('run', {}, false);
    node.unnamed = [name];
    return node;
  }

  private argumentsOf(name: string, shape: CommandShape, unnamed = true): CommandNode {
    const node: CommandNode = { name, named: [], unnamed: [], injectPipe: true };
    while (this.namedAhead()) {
      node.named.push(this.named());
      this.skipSpace();
    }
    if (unnamed && !this.commandEnd()) {
      node.unnamed = this.unnamed(shape.split === true, shape.splitCount ?? 0);
    }
    if (!this.commandEnd()) throw new SlashError(`/${name} 的参数没有正常结束`);
    return node;
  }

  private named(): NamedNode {
    const start = this.i;
    while (this.text[this.i] !== '=') this.i++;
    const name = this.text.slice(start, this.i++);
    let value: ValueNode = '';
    if (this.at('{:')) value = this.closure(false);
    else if (this.at('"')) value = this.quoted();
    else if (this.at('[')) value = this.list();
    else value = this.bare();
    return { name, value };
  }

  private quoted(): string {
    this.i++;
    const value = this.takeUntil(() => this.at('"'));
    if (this.eof) throw new SlashError('引号没有闭合');
    this.i++;
    return value;
  }
  private list(): string {
    const value = this.takeUntil(() => this.at(']'));
    if (this.eof) return value;
    this.i++;
    return `${value}]`;
  }
  private bare(): string {
    return this.takeUntil(() => this.atSpace() || this.commandEnd());
  }

  private unnamed(split: boolean, splitCount: number): ValueNode[] {
    const wasSplit = split;
    const parts: ValueNode[] = [];
    const quoted: boolean[] = [];
    const add = (value: ValueNode, isQuoted: boolean) => {
      parts.push(value);
      quoted.push(isQuoted);
    };
    let isList = split;
    let text = '';
    if (!split && this.at('"')) {
      add(this.quoted(), true);
      isList = true;
    }
    while (!this.commandEnd()) {
      if (split && splitCount > 0 && parts.length >= splitCount) {
        // the rest is one value
        split = false;
        if (this.at('"')) add(this.quoted(), true);
        continue;
      }
      if (this.at('{:')) {
        isList = true;
        if (text) {
          add(text, false);
          text = '';
        }
        add(this.closure(false), false);
        if (split) this.skipSpace();
      } else if (split) {
        if (this.at('"')) add(this.quoted(), true);
        else if (this.at('[')) add(this.list(), false);
        else add(this.bare(), false);
        this.skipSpace();
      } else {
        text += this.takeOne();
      }
    }
    if (!isList) {
      text = text.trim();
      return text ? [text] : [];
    }
    if (text) add(text, false);
    // the ends are trimmed unless they were quoted; an end that trims to nothing is dropped
    const first = parts[0];
    if (typeof first === 'string' && !quoted[0]) {
      parts[0] = first.trimStart();
      if (!parts[0]) {
        parts.shift();
        quoted.shift();
      }
    }
    const last = parts[parts.length - 1];
    if (typeof last === 'string' && !quoted[quoted.length - 1]) {
      parts[parts.length - 1] = last.trimEnd();
      if (!parts[parts.length - 1]) parts.pop();
    }
    if (wasSplit && splitCount > 0 && parts.length > splitCount + 1) {
      const rest = parts.slice(splitCount);
      if (rest.every((part) => typeof part === 'string')) {
        parts.splice(splitCount, rest.length, rest.join(''));
      }
    }
    return parts;
  }
}

export function parseSlash(text: string, lookup: CommandLookup): ClosureNode {
  return new Parser(text, lookup).parse();
}
