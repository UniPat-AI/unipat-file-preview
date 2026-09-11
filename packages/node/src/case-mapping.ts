const CAMEL_TO_SNAKE_RE = /[A-Z]/g;

function camelToSnakeKey(key: string): string {
  return key.replace(CAMEL_TO_SNAKE_RE, (m) => `_${m.toLowerCase()}`);
}

function snakeToCamelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase());
}

export function deepCamelToSnake<T = unknown>(value: unknown): T {
  return transform(value, camelToSnakeKey) as T;
}

export function deepSnakeToCamel<T = unknown>(value: unknown): T {
  return transform(value, snakeToCamelKey) as T;
}

function transform(value: unknown, mapKey: (key: string) => string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => transform(item, mapKey));
  }
  if (value && typeof value === 'object' && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[mapKey(k)] = transform(v, mapKey);
    }
    return out;
  }
  return value;
}
