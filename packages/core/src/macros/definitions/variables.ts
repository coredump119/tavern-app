// ST variable-macros.js 移植：setvar/getvar/… 及 global 版本。
import { MacroCategory, MacroValueType, type MacroRegistry } from '../registry.js';

export function registerVariableMacros(registry: MacroRegistry): void {
  const nameArg = (what: string) => ({
    name: 'name',
    type: MacroValueType.STRING,
    description: `The name of the ${what} variable.`,
  });
  const valueArg = (what: string) => ({
    name: 'value',
    type: [MacroValueType.STRING, MacroValueType.NUMBER] as ('string' | 'number')[],
    description: `The value for the ${what} variable.`,
  });

  for (const scope of ['local', 'global'] as const) {
    const g = scope === 'global' ? 'global' : '';
    const vars = (env: import('../env.js').MacroEnv) => env.runtime.variables[scope];

    registry.registerMacro(`set${g}var`, {
      category: MacroCategory.VARIABLE,
      unnamedArgs: [nameArg(scope), valueArg(scope)],
      description: `Sets a ${scope} variable to the given value.`,
      returns: '',
      exampleUsage: [`{{set${g}var::myvar::foo}}`, `{{set${g}var::myintvar::3}}`],
      handler: ({ unnamedArgs: [name = '', value = ''], env }) => {
        vars(env).set(name, value);
        return '';
      },
    });
    registry.registerMacro(`add${g}var`, {
      category: MacroCategory.VARIABLE,
      unnamedArgs: [nameArg(scope), valueArg(scope)],
      description: `Adds a value to an existing ${scope} variable (numeric or string append). If the variable does not exist, it will be created.`,
      returns: '',
      exampleUsage: [`{{add${g}var::mystrvar::foo}}`, `{{add${g}var::myintvar::3}}`],
      handler: ({ unnamedArgs: [name = '', value = ''], env }) => {
        vars(env).add(name, value);
        return '';
      },
    });
    registry.registerMacro(`inc${g}var`, {
      category: MacroCategory.VARIABLE,
      unnamedArgs: [nameArg(scope)],
      description: `Increments a ${scope} variable by 1 and returns the new value. If the variable does not exist, it will be created.`,
      returns: `The new value of the ${scope} variable.`,
      returnType: MacroValueType.NUMBER,
      exampleUsage: [`{{inc${g}var::myintvar}}`],
      handler: ({ unnamedArgs: [name = ''], env, normalize }) => normalize(vars(env).inc(name)),
    });
    registry.registerMacro(`dec${g}var`, {
      category: MacroCategory.VARIABLE,
      unnamedArgs: [nameArg(scope)],
      description: `Decrements a ${scope} variable by 1 and returns the new value. If the variable does not exist, it will be created.`,
      returns: `The new value of the ${scope} variable.`,
      returnType: MacroValueType.NUMBER,
      exampleUsage: [`{{dec${g}var::myintvar}}`],
      handler: ({ unnamedArgs: [name = ''], env, normalize }) => normalize(vars(env).dec(name)),
    });
    registry.registerMacro(`get${g}var`, {
      category: MacroCategory.VARIABLE,
      unnamedArgs: [nameArg(scope)],
      description: `Gets the value of a ${scope} variable.`,
      returns: `The value of the ${scope} variable.`,
      returnType: [MacroValueType.STRING, MacroValueType.NUMBER],
      exampleUsage: [`{{get${g}var::myvar}}`],
      handler: ({ unnamedArgs: [name = ''], env, normalize }) => normalize(vars(env).get(name)),
    });
    registry.registerMacro(`has${g}var`, {
      aliases: [{ alias: `${g}varexists` }],
      category: MacroCategory.VARIABLE,
      unnamedArgs: [nameArg(scope)],
      description: `Checks if a ${scope} variable exists.`,
      returns: '"true" if the variable exists, "false" otherwise.',
      returnType: MacroValueType.STRING,
      exampleUsage: [`{{has${g}var::myvar}}`],
      handler: ({ unnamedArgs: [name = ''], env }) => (vars(env).has(name) ? 'true' : 'false'),
    });
    registry.registerMacro(`delete${g}var`, {
      aliases: [{ alias: `flush${g}var` }],
      category: MacroCategory.VARIABLE,
      unnamedArgs: [nameArg(scope)],
      description: `Deletes a ${scope} variable.`,
      returns: '',
      exampleUsage: [`{{delete${g}var::myvar}}`],
      handler: ({ unnamedArgs: [name = ''], env }) => {
        vars(env).del(name);
        return '';
      },
    });
  }
}
