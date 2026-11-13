/// <reference types="svelte" />
/// <reference types="vite/client" />

/** dice roller ST hands to extensions as `droll`; ships no types */
declare module 'droll' {
  const droll: {
    validate(formula: string): boolean;
    parse(formula: string): unknown;
    roll(formula: string): { total: number; rolls: number[]; modifier: number } | false;
  };
  export default droll;
}
