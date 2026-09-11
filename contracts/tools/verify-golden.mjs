#!/usr/bin/env node
// 最小 JSON Schema 校验器（仅覆盖本仓 schema 用到的关键字），零依赖。
// 校验 contracts/golden/*.json 是否符合 contracts/schemas/*.schema.json。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const schemas = {
  previewState: loadJson(join(root, 'schemas', 'preview-state.schema.json')),
  manifest: loadJson(join(root, 'schemas', 'manifest.schema.json')),
  sheetWindow: loadJson(join(root, 'schemas', 'sheet-window.schema.json')),
};

const cases = [
  { file: 'state.ready.json', schema: schemas.previewState },
  { file: 'manifest.pdf.json', schema: schemas.manifest },
  { file: 'sheet-window.csv.json', schema: schemas.sheetWindow },
];

let failures = 0;
for (const { file, schema } of cases) {
  const data = loadJson(join(root, 'golden', file));
  const errors = [];
  validate(data, schema, schema, '#', errors);
  if (errors.length === 0) {
    console.log(`[ok] ${file}`);
  } else {
    failures += 1;
    console.error(`[fail] ${file}`);
    for (const e of errors) console.error(`  - ${e}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} golden file(s) failed schema validation.`);
  process.exit(1);
}
console.log(`\nall ${cases.length} golden files passed schema validation.`);

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref: ${ref}`);
  const parts = ref.slice(2).split('/');
  let cur = root;
  for (const seg of parts) {
    cur = cur[seg];
    if (cur === undefined)
      throw new Error(`ref not found: ${ref} (missing ${seg})`);
  }
  return cur;
}

function validate(data, schema, root, path, errors) {
  if (schema.$ref) {
    validate(data, resolveRef(schema.$ref, root), root, path, errors);
    return;
  }
  if (schema.oneOf) {
    const matched = schema.oneOf.filter((sub) => {
      const errs = [];
      validate(data, sub, root, path, errs);
      return errs.length === 0;
    });
    if (matched.length !== 1) {
      errors.push(
        `${path}: expected exactly one of oneOf to match, got ${matched.length}`,
      );
    }
    return;
  }
  if (schema.enum) {
    if (!schema.enum.includes(data)) {
      errors.push(
        `${path}: value ${JSON.stringify(data)} not in enum ${JSON.stringify(
          schema.enum,
        )}`,
      );
      return;
    }
  }
  if (schema.type) {
    const actual = typeOf(data);
    const expected = schema.type;
    const ok =
      expected === 'number'
        ? actual === 'number' || actual === 'integer'
        : actual === expected;
    if (!ok) {
      errors.push(`${path}: expected type ${expected}, got ${actual}`);
      return;
    }
  }
  const t = typeOf(data);
  if (t === 'string') {
    if (typeof schema.minLength === 'number' && data.length < schema.minLength)
      errors.push(`${path}: string shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && data.length > schema.maxLength)
      errors.push(`${path}: string longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(data))
      errors.push(`${path}: string does not match /${schema.pattern}/`);
  }
  if (t === 'number' || t === 'integer') {
    if (typeof schema.minimum === 'number' && data < schema.minimum)
      errors.push(`${path}: number smaller than ${schema.minimum}`);
  }
  if (t === 'array') {
    if (typeof schema.minItems === 'number' && data.length < schema.minItems)
      errors.push(`${path}: array shorter than ${schema.minItems}`);
    if (schema.items) {
      for (let i = 0; i < data.length; i++) {
        validate(data[i], schema.items, root, `${path}/[${i}]`, errors);
      }
    }
  }
  if (t === 'object') {
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in data))
          errors.push(`${path}: missing required property "${key}"`);
      }
    }
    const props = schema.properties ?? {};
    const allowAdditional = schema.additionalProperties !== false;
    for (const key of Object.keys(data)) {
      if (props[key]) {
        validate(data[key], props[key], root, `${path}/${key}`, errors);
      } else if (!allowAdditional) {
        errors.push(`${path}: unexpected property "${key}"`);
      }
    }
  }
}
