/**
 * ST 服务端 util.js 的两个 YAML 小工具：「自定义」源的附加请求体 / 请求头 / 排除键。
 * 和酒馆一样，解析失败静默忽略。
 */
import { parse } from 'yaml';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** util.js mergeObjectWithYaml：对象直接并入，数组则逐个并入其中的对象 */
export function mergeObjectWithYaml(obj: Record<string, unknown>, yamlString: unknown): void {
  if (typeof yamlString !== 'string' || !yamlString) return;
  try {
    const parsed: unknown = parse(yamlString);
    if (Array.isArray(parsed)) {
      for (const item of parsed) if (isObject(item)) Object.assign(obj, item);
    } else if (isObject(parsed)) {
      Object.assign(obj, parsed);
    }
  } catch {
    /* 酒馆同样不报错 */
  }
}

/** util.js excludeKeysByYaml：数组的每一项、对象的每个键，或单个字符串 */
export function excludeKeysByYaml(obj: Record<string, unknown>, yamlString: unknown): void {
  if (typeof yamlString !== 'string' || !yamlString) return;
  try {
    const parsed: unknown = parse(yamlString);
    if (Array.isArray(parsed)) {
      for (const key of parsed) delete obj[String(key)];
    } else if (isObject(parsed)) {
      for (const key of Object.keys(parsed)) delete obj[key];
    } else if (typeof parsed === 'string') {
      delete obj[parsed];
    }
  } catch {
    /* 酒馆同样不报错 */
  }
}
