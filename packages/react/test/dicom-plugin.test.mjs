import { test } from 'node:test';
import assert from 'node:assert/strict';
import dicomParser from 'dicom-parser';
import { DicomPlugin } from '../dist/index.js';

test('DicomPlugin 基本属性与匹配', () => {
  assert.equal(DicomPlugin.name, 'dicom');
  assert.equal(typeof DicomPlugin.Component, 'function');
  assert.equal(DicomPlugin.match('dcm', ''), true);
  assert.equal(DicomPlugin.match('dicom', ''), true);
  assert.equal(DicomPlugin.match('png', ''), false);
  assert.equal(DicomPlugin.match('pdf', ''), false);
});

test('dicom-parser 正常解析 DICOM Tag 与图像元数据', () => {
  const parts = [];
  // 128 字节 preamble + 'DICM'
  parts.push(Buffer.alloc(128));
  parts.push(Buffer.from('DICM', 'ascii'));

  function addEl(group, elem, vr, dataBuf) {
    const head = Buffer.alloc(8);
    head.writeUInt16LE(group, 0);
    head.writeUInt16LE(elem, 2);
    head.write(vr, 4, 2, 'ascii');
    let pad = 0;
    if (dataBuf.length % 2 === 1) pad = 1;
    head.writeUInt16LE(dataBuf.length + pad, 6);
    parts.push(head);
    parts.push(dataBuf);
    if (pad) parts.push(Buffer.from([0]));
  }

  // 0002,0010: TransferSyntaxUID (Explicit VR Little Endian)
  const tsUid = Buffer.from('1.2.840.10008.1.2.1\0');
  
  // 0002,0000: FileMetaInformationGroupLength (UL, 4 bytes)
  const glBuf = Buffer.alloc(4);
  glBuf.writeUInt32LE(8 + tsUid.length, 0);
  const glHead = Buffer.alloc(8);
  glHead.writeUInt16LE(0x0002, 0);
  glHead.writeUInt16LE(0x0000, 2);
  glHead.write('UL', 4, 2, 'ascii');
  glHead.writeUInt16LE(4, 6);
  parts.push(glHead);
  parts.push(glBuf);

  addEl(0x0002, 0x0010, 'UI', tsUid);
  addEl(0x0008, 0x0060, 'CS', Buffer.from('CT'));
  addEl(0x0010, 0x0010, 'PN', Buffer.from('ANON^TEST'));
  addEl(0x0010, 0x0020, 'LO', Buffer.from('PID12345'));

  const rows = Buffer.alloc(2); rows.writeUInt16LE(8, 0);
  addEl(0x0028, 0x0010, 'US', rows);
  const cols = Buffer.alloc(2); cols.writeUInt16LE(8, 0);
  addEl(0x0028, 0x0011, 'US', cols);

  const bits = Buffer.alloc(2); bits.writeUInt16LE(16, 0);
  addEl(0x0028, 0x0100, 'US', bits);

  addEl(0x0028, 0x1050, 'DS', Buffer.from('40'));
  addEl(0x0028, 0x1051, 'DS', Buffer.from('400'));

  // PixelData 7FE0,0010 (OW) - 64 像素 (8x8) * 2 字节 = 128 字节
  const pixelBuf = Buffer.alloc(128);
  for (let i = 0; i < 64; i++) {
    pixelBuf.writeInt16LE(i * 10 - 200, i * 2);
  }

  const pHead = Buffer.alloc(12);
  pHead.writeUInt16LE(0x7fe0, 0);
  pHead.writeUInt16LE(0x0010, 2);
  pHead.write('OW', 4, 2, 'ascii');
  pHead.writeUInt16LE(0, 6);
  pHead.writeUInt32LE(128, 8);
  parts.push(pHead);
  parts.push(pixelBuf);

  const fullBuf = Buffer.concat(parts);
  const dataSet = dicomParser.parseDicom(fullBuf);

  assert.equal(dataSet.string('x00080060'), 'CT');
  assert.equal(dataSet.string('x00100010'), 'ANON^TEST');
  assert.equal(dataSet.string('x00100020'), 'PID12345');
  assert.equal(dataSet.uint16('x00280010'), 8);
  assert.equal(dataSet.uint16('x00280011'), 8);
  assert.equal(dataSet.floatString('x00281050'), 40);
  assert.equal(dataSet.floatString('x00281051'), 400);

  const pixelEl = dataSet.elements.x7fe00010;
  assert.ok(pixelEl != null);
  assert.equal(pixelEl.length, 128);

  const pixelBufAligned = new ArrayBuffer(pixelEl.length);
  new Uint8Array(pixelBufAligned).set(fullBuf.subarray(pixelEl.dataOffset, pixelEl.dataOffset + pixelEl.length));
  const rawPixels = new Int16Array(pixelBufAligned);
  assert.equal(rawPixels.length, 64);
  assert.equal(rawPixels[0], -200);
});

test('DICOM WW / WL 窗宽窗位映射算法验证', () => {
  const ww = 400;
  const wl = 40;
  const low = wl - ww / 2; // -160
  const high = wl + ww / 2; // +240

  function mapPixelToIntensity(val) {
    if (val <= low) return 0;
    if (val >= high) return 255;
    return Math.round(((val - low) / ww) * 255);
  }

  assert.equal(mapPixelToIntensity(-300), 0); // 低于窗位下限，全黑
  assert.equal(mapPixelToIntensity(-160), 0);
  assert.equal(mapPixelToIntensity(40), 128);  // 中心窗位，中度灰
  assert.equal(mapPixelToIntensity(240), 255); // 高于窗位上限，全白
  assert.equal(mapPixelToIntensity(1000), 255);
});
