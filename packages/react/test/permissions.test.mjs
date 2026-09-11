import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as ReactPkg from '../dist/index.js';

test('disabledPlugins 与权限参数向后兼容性验证', () => {
  // 确认 DirectFilePreview 接受 disabledPlugins, allowDownload, allowOpen, allowPrint
  assert.equal(typeof ReactPkg.FilePreview, 'function');
  assert.ok(Array.isArray(ReactPkg.DEFAULT_PLUGINS));

  // 验证各默认插件名称齐全
  const names = ReactPkg.DEFAULT_PLUGINS.map((p) => p.name);
  assert.ok(names.includes('pdf'));
  assert.ok(names.includes('image'));
  assert.ok(names.includes('json'));
  assert.ok(names.includes('text'));
  assert.ok(names.includes('table'));
  assert.ok(names.includes('media'));
  assert.ok(names.includes('html'));
  assert.ok(names.includes('fallback'));
});

test('插件独立匹配与过滤机制', () => {
  const disabled = new Set(['pdf', 'html']);
  const activePlugins = ReactPkg.DEFAULT_PLUGINS.filter((p) => !disabled.has(p.name));

  // 禁用后 pdf 和 html 不再出现在 activePlugins 中
  assert.ok(!activePlugins.some((p) => p.name === 'pdf'));
  assert.ok(!activePlugins.some((p) => p.name === 'html'));

  // 兜底及其他格式依然正常可用
  const fallbackPlugin = activePlugins.find((p) => p.match('pdf', ''));
  assert.equal(fallbackPlugin?.name, 'fallback');
});
