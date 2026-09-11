import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv } from '../dist/index.js';

test('RFC 4180 测试用例 1：单元格内包含换行符（不应切断记录或错位）', () => {
  const input = '"a\nb",c';
  const rows = parseCsv(input);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], ['a\nb', 'c']);
});

test('RFC 4180 测试用例 2：转义双引号 "" 还原为单个 "', () => {
  const input = '"a""b",c';
  const rows = parseCsv(input);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], ['a"b', 'c']);
});

test('RFC 4180 测试用例 3：保留单元格内前后有效空格', () => {
  const input = '" a ",b';
  const rows = parseCsv(input);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], [' a ', 'b']);
});

test('RFC 4180 基础多行与 CRLF 换行', () => {
  const input = 'name,age,city\r\nAlice,30,"New York, NY"\r\nBob,25,Beijing\r\n';
  const rows = parseCsv(input);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], ['name', 'age', 'city']);
  assert.deepEqual(rows[1], ['Alice', '30', 'New York, NY']);
  assert.deepEqual(rows[2], ['Bob', '25', 'Beijing']);
});

test('TSV 制表符分隔自适应检测', () => {
  const input = 'col1\tcol2\tcol3\nval1\tval2\tval3';
  const rows = parseCsv(input);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], ['col1', 'col2', 'col3']);
  assert.deepEqual(rows[1], ['val1', 'val2', 'val3']);
});

test('分号 ; 分隔符自适应检测', () => {
  const input = 'id;name;score\n1;Jack;95\n2;Rose;98';
  const rows = parseCsv(input);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], ['id', 'name', 'score']);
  assert.deepEqual(rows[1], ['1', 'Jack', '95']);
  assert.deepEqual(rows[2], ['2', 'Rose', '98']);
});

test('空字段与空文本容错', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('a,,c\n,,d'), [
    ['a', '', 'c'],
    ['', '', 'd'],
  ]);
});
