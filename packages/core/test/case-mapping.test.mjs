import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  snakeToCamel,
  camelToSnake,
  deepSnakeToCamel,
  deepCamelToSnake,
} from '../dist/index.js';

test('snakeToCamel 基本转换', () => {
  assert.equal(snakeToCamel('preview_id'), 'previewId');
  assert.equal(snakeToCamel('published_revision'), 'publishedRevision');
  assert.equal(snakeToCamel('a_b_c'), 'aBC');
  assert.equal(snakeToCamel('already'), 'already');
});

test('camelToSnake 基本转换', () => {
  assert.equal(camelToSnake('previewId'), 'preview_id');
  assert.equal(camelToSnake('publishedRevision'), 'published_revision');
  assert.equal(camelToSnake('id'), 'id');
});

test('deepSnakeToCamel 深度转换 plain object 与数组键', () => {
  const input = {
    preview_id: 'p1',
    nested_obj: {
      inner_key: [
        { row_start: 0, col_end: 5 },
        { row_start: 1, col_end: 6 },
      ],
    },
  };
  const out = deepSnakeToCamel(input);
  assert.deepEqual(out, {
    previewId: 'p1',
    nestedObj: {
      innerKey: [
        { rowStart: 0, colEnd: 5 },
        { rowStart: 1, colEnd: 6 },
      ],
    },
  });
});

test('deepCamelToSnake 深度转换往回', () => {
  const input = { previewId: 'p1', nested: { rowStart: 3 } };
  assert.deepEqual(deepCamelToSnake(input), {
    preview_id: 'p1',
    nested: { row_start: 3 },
  });
});

test('deepSnakeToCamel 不误伤 class 实例', () => {
  class Custom {
    constructor() {
      this.snake_field = 1;
    }
  }
  const instance = new Custom();
  const wrap = { my_field: instance };
  const out = deepSnakeToCamel(wrap);
  // 顶层 key 转换
  assert.equal('myField' in out, true);
  // 但 class 实例应原样透传，其 snake_field 不被改写
  assert.equal(out.myField, instance);
  assert.equal(instance.snake_field, 1);
});

test('deepSnakeToCamel 保留 null / 原始值', () => {
  assert.equal(deepSnakeToCamel(null), null);
  assert.equal(deepSnakeToCamel(3), 3);
  assert.equal(deepSnakeToCamel('x'), 'x');
});
