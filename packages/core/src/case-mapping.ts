export function snakeToCamel(input: string): string {
  return input.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function camelToSnake(input: string): string {
  return input.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function deepSnakeToCamel<T = unknown>(value: unknown): T {
  return transformKeys(value, snakeToCamel) as T;
}

export function deepCamelToSnake<T = unknown>(value: unknown): T {
  return transformKeys(value, camelToSnake) as T;
}

function transformKeys(value: unknown, fn: (key: string) => string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => transformKeys(item, fn));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[fn(k)] = transformKeys(v, fn);
    }
    return out;
  }
  return value;
}
