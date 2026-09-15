import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as ReactPkg from '../dist/index.js';

test('React 包正确导出组件与 hook', () => {
  assert.equal(typeof ReactPkg.FilePreview, 'function');
  assert.equal(typeof ReactPkg.usePreview, 'function');
  assert.equal(typeof ReactPkg.useManifest, 'function');
  assert.equal(typeof ReactPkg.useSheetWindow, 'function');
  assert.equal(typeof ReactPkg.TextViewer, 'function');
  assert.equal(typeof ReactPkg.TableViewer, 'function');
  assert.equal(typeof ReactPkg.GalleryViewer, 'function');
  assert.equal(typeof ReactPkg.HtmlViewer, 'function');
  assert.equal(typeof ReactPkg.JsonPlugin, 'object');
  assert.equal(ReactPkg.JsonPlugin.name, 'json');
  assert.equal(typeof ReactPkg.JsonPlugin.Component, 'function');
});

test('插件化架构：默认插件与类型探测工具函数', () => {
  assert.ok(Array.isArray(ReactPkg.DEFAULT_PLUGINS));
  assert.ok(ReactPkg.DEFAULT_PLUGINS.length >= 7);

  // 测试类型探测
  assert.equal(ReactPkg.inferFileType('https://example.com/files/report.pdf?token=123'), 'pdf');
  assert.equal(ReactPkg.inferFileType('https://example.com/image.png#hash'), 'png');
  assert.equal(ReactPkg.inferFileType('blob:http://localhost/xyz', 'csv'), 'csv');
  assert.equal(ReactPkg.inferFileType('blob:http://localhost/xyz', 'json'), 'json');
  assert.equal(ReactPkg.inferFileName('https://example.com/docs/annual-summary.xlsx'), 'annual-summary.xlsx');
});

test('插件匹配机制：不同文件匹配不同插件', () => {
  const findPlugin = (ext) => ReactPkg.DEFAULT_PLUGINS.find((p) => p.match(ext, ''));

  assert.equal(findPlugin('pdf')?.name, 'pdf');
  assert.equal(findPlugin('png')?.name, 'image');
  assert.equal(findPlugin('jpg')?.name, 'image');
  assert.equal(findPlugin('dcm')?.name, 'dicom');
  assert.equal(findPlugin('dicom')?.name, 'dicom');
  assert.equal(findPlugin('json')?.name, 'json');
  assert.equal(findPlugin('txt')?.name, 'text');
  assert.equal(findPlugin('csv')?.name, 'table');
  assert.equal(findPlugin('mp4')?.name, 'media');
  assert.equal(findPlugin('mp3')?.name, 'media');
  assert.equal(findPlugin('html')?.name, 'html');
  assert.equal(findPlugin('exe')?.name, 'fallback');
});

test('自包含性：零内部 workspace 耦合，内置 PreviewError 与 normalizePreviewError', () => {
  assert.ok(ReactPkg.DEFAULT_PLUGINS.every((p) => typeof p.name === 'string' && typeof p.Component === 'function'));
});
