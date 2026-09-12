import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { JsonPlugin } from '../dist/index.js';

async function renderJson(value) {
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(JsonPlugin.Component, {
      src: new Blob([JSON.stringify(value)], { type: 'application/json' }),
      fileType: 'json',
    }));
  });
  return renderer;
}

function text(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(text).join('');
  return text(node.children);
}

test('JSON arrays display zero-based indices for scalars and containers', async () => {
  const renderer = await renderJson(['first', { result: true }, null]);
  try {
    const output = text(renderer.toJSON());
    assert.match(output, /\[0\]:\s*"first"/);
    assert.match(output, /\[1\]:\s*\{/);
    assert.match(output, /\[2\]:\s*null/);
    assert.doesNotMatch(output, /"":/);
  } finally { act(() => renderer.unmount()); }
});

test('JSON nested arrays preserve indices while numeric and empty object keys stay quoted', async () => {
  const renderer = await renderJson({ '0': 'object key', '': 'empty key', files: [{ path: 'a.txt' }, 'b.txt'] });
  try {
    const output = text(renderer.toJSON());
    assert.match(output, /"0":\s*"object key"/);
    assert.match(output, /"":\s*"empty key"/);
    assert.match(output, /\[0\]:\s*\{/);
    assert.match(output, /\[1\]:\s*"b.txt"/);
  } finally { act(() => renderer.unmount()); }
});
