import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, deflateRawSync } from 'node:zlib';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { FilePreview } from '../dist/index.js';
import { archiveLimits, readGzip, readZip, readArchiveSource } from '../dist/plugins/archive.js';

function crc32(data) { let c=0xffffffff; for(const b of data){c^=b;for(let n=0;n<8;n++)c=(c>>>1)^(0xedb88320&-(c&1));}return (c^0xffffffff)>>>0; }
export function zip(items) {
  const local=[], central=[]; let offset=0;
  for (const item of items) {
    const name=Buffer.from(item.name), bytes=Buffer.from(item.text ?? ''), data=item.store ? bytes : deflateRawSync(bytes), method=item.store ? 0 : 8;
    const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(0x800,6);h.writeUInt16LE(method,8);h.writeUInt32LE(crc32(bytes),14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(bytes.length,22);h.writeUInt16LE(name.length,26);
    local.push(h,name,data);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x800,8);c.writeUInt16LE(method,10);c.writeUInt32LE(crc32(bytes),16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(bytes.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(item.symlink ? 0xa1ff0000 : 0,38);c.writeUInt32LE(offset,42);central.push(c,name);offset+=h.length+name.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(items.length,8);end.writeUInt16LE(items.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,directory,end]);
}
const limits=archiveLimits();
test('gzip TSV/JSON bytes retained, corrupted gzip and expansion over limit rejected',async()=>{
  for(const text of ['id\t姓名\n1\t甲\n','{"ok":true}']) assert.equal(await (await readGzip(gzipSync(text),limits)).text(),text);
  await assert.rejects(readGzip(gzipSync('x'.repeat(4096)),archiveLimits({maxEntryBytes:128})),/限制/);
  const broken=gzipSync('hello');broken[broken.length-8]^=1;await assert.rejects(readGzip(broken,limits));
});
test('ZIP directory enumeration and lazy stored/deflate member reading',async()=>{
  const entries=readZip(zip([{name:'data/'},{name:'data/表.tsv',text:'a\tb\n1\t2'},{name:'readme.txt',text:'hello',store:true}]),limits);
  assert.equal(entries.length,3);assert.equal(entries[0].directory,true);assert.equal(await(await entries[1].read()).text(),'a\tb\n1\t2');assert.equal(await(await entries[2].read()).text(),'hello');
});
test('ZIP rejects traversal, symlink, duplicate names and expansion/count limits',()=>{
  for(const name of ['../escape','/root','C:/bad','a\\b','a/../b'])assert.throws(()=>readZip(zip([{name}]),limits),/路径/);
  assert.throws(()=>readZip(zip([{name:'link',symlink:true}]),limits),/符号链接/);
  assert.throws(()=>readZip(zip([{name:'a'},{name:'a'}]),limits),/重复/);
  assert.throws(()=>readZip(zip([{name:'a',text:'x'.repeat(100)}]),archiveLimits({maxEntryBytes:10})),/大小/);
  assert.throws(()=>readZip(zip([{name:'a'},{name:'b'}]),archiveLimits({maxEntries:1})),/数量/);
});
test('truncation, altered member CRC and local-header mismatch rejected',async()=>{
  const data=zip([{name:'a',text:'hello',store:true}]);assert.throws(()=>readZip(data.subarray(0,data.length-1),limits));
  const changed=Buffer.from(data);changed[31]^=1;await assert.rejects(readZip(changed,limits)[0].read(),/校验/);
  const badName=Buffer.from(data);badName[30]=98;assert.throws(()=>readZip(badName,limits),/不一致/);
});
test('source bounds and cancellation are enforced',async()=>{
  await assert.rejects(readArchiveSource(new Blob(['a'.repeat(20)]),archiveLimits({maxInputBytes:10})),/大小/);
  const ac=new AbortController();ac.abort();await assert.rejects(readGzip(gzipSync('a'),limits,ac.signal),/abort/i);
});
async function settle(){await act(async()=>{await new Promise(r=>setTimeout(r,30));});}
test('gzip dispatches decompressed content to existing TSV plugin',async()=>{
  let root;await act(async()=>{root=create(React.createElement(FilePreview,{src:new Blob([gzipSync('name\tvalue\nfoo\t123')]),fileName:'table.tsv.gz'}));});await settle();await settle();
  const text=JSON.stringify(root.toJSON());assert.match(text,/foo/);assert.match(text,/123/);assert.match(text,/只读/);await act(()=>root.unmount());
});
test('ZIP browsing, permission and custom plugin options survive nested preview',async()=>{
  let seen;const plugin={name:'probe',match:t=>t==='txt',Component:p=>{seen=p;return React.createElement('div',null,'custom preview');}};
  let root;await act(async()=>{root=create(React.createElement(FilePreview,{src:new Blob([zip([{name:'folder/a.txt',text:'hi'}])]),fileName:'a.zip',plugins:[plugin],disabledPlugins:['html'],allowDownload:false,allowOpen:false,allowPrint:false}));});await settle();
  await act(()=>root.root.findAllByType('button').find(b=>b.props.children.includes('folder')).props.onClick());
  await act(()=>root.root.findAllByType('button').find(b=>b.props.children.includes('a.txt')).props.onClick());await settle();
  assert.equal(seen.allowDownload,false);assert.equal(seen.allowOpen,false);assert.equal(seen.allowPrint,false);assert.deepEqual(seen.disabledPlugins,['html']);assert.equal(await seen.src.text(),'hi');await act(()=>root.unmount());
});
test('nested gzip depth is limited with a visible error',async()=>{
  let root;await act(async()=>{root=create(React.createElement(FilePreview,{src:new Blob([gzipSync(gzipSync('hi'))]),fileName:'a.txt.gz.gz',archiveLimits:{maxDepth:1}}));});await settle();await settle();assert.match(JSON.stringify(root.toJSON()),/嵌套层数/);await act(()=>root.unmount());
});
