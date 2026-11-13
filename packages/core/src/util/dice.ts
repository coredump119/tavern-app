// droll 0.2.1 的 TS 移植（MIT）。{{roll}} 使用 Math.random，与 ST 行为一致。
export interface DiceFormula {
  numDice: number;
  numSides: number;
  modifier: number;
  minResult: number;
  maxResult: number;
  avgResult: number;
}
export interface DiceResult {
  rolls: number[];
  modifier: number;
  total: number;
}

export function parseDice(formula: string): DiceFormula | false {
  const pieces = /^([1-9]\d*)?d([1-9]\d*)([+-]\d+)?$/i.exec(formula);
  if (!pieces) return false;
  const numDice = Number(pieces[1]) || 1;
  const numSides = Number(pieces[2]);
  const modifier = Number(pieces[3]) || 0;
  const minResult = numDice + modifier;
  const maxResult = numDice * numSides + modifier;
  return {
    numDice,
    numSides,
    modifier,
    minResult,
    maxResult,
    avgResult: (maxResult + minResult) / 2,
  };
}

export function validateDice(formula: string): boolean {
  return parseDice(formula) !== false;
}

export function rollDice(formula: string, random: () => number = Math.random): DiceResult | false {
  const pieces = parseDice(formula);
  if (!pieces) return false;
  const rolls: number[] = [];
  for (let a = 0; a < pieces.numDice; a++) rolls.push(1 + Math.floor(random() * pieces.numSides));
  const total = rolls.reduce((s, r) => s + r, 0) + pieces.modifier;
  return { rolls, modifier: pieces.modifier, total };
}
