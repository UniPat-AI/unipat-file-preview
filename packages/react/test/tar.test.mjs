import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { FilePreview } from '../dist/index.js';
import { archiveLimits, readTar, readTarGzip } from '../dist/plugins/archive.js';
const load = name => readFileSync(new URL(`./fixtures/tar/${name}`, import.meta.url));
const limits = archiveLimits();
function headerChange(data, change) {
 const b=Buffer.from(data);change(b);b.fill(32,148,156);const sum=b.subarray(0,512).reduce((a,v)=>a+v,0);b.write(sum.toString(8).padStart(6,'0')+'\0 ',148);return b;
}
test('USTAR, PAX and GNU directories and long names', async()=>{
 for(const name of ['ustar','pax','gnu']) {
  const entries=readTar(load(name+'.tar'),limits);
  assert.equal(entries[0].path,'data/');
  assert.equal(await(await entries.find(e=>e.path==='data/table.tsv').read()).text(),'name\tvalue\nfoo\t123');
  if(name!=='ustar')assert.ok(entries.some(e=>e.path.length>100));
 }
 assert.equal((await readTarGzip(load('sample.tgz'),limits)).length,3);
});
test('TAR checksum, truncation, unsafe paths, links and bounds',()=>{
 const data=load('ustar.tar');
 assert.throws(()=>readTar(headerChange(data,b=>{b.fill(0,0,100);b.write('../evil',0);}),limits),/路径/);
 for(const kind of ['1','2','3','6','S']) assert.throws(()=>readTar(headerChange(data,b=>b.write(kind,156)),limits),/链接|特殊/);
 const bad=Buffer.from(data);bad[0]^=1;assert.throws(()=>readTar(bad,limits),/校验/);
 assert.throws(()=>readTar(data.subarray(0,1200),limits),/不完整|截断/);
 assert.throws(()=>readTar(data,archiveLimits({maxEntries:1})),/数量/);
 assert.throws(()=>readTar(data,archiveLimits({maxEntryBytes:4})),/大小/);
 assert.throws(()=>readTar(data,archiveLimits({maxTotalBytes:10})),/大小/);
 const duplicate=Buffer.concat([data.subarray(0,512),data]);assert.throws(()=>readTar(duplicate,limits),/重复/);
});
test('TAR.GZ expansion and cancellation are bounded',async()=>{
 await assert.rejects(readTarGzip(load('sample.tgz'),archiveLimits({maxTotalBytes:100})),/限制/);
 const ac=new AbortController();ac.abort();await assert.rejects(readTarGzip(load('sample.tgz'),limits,ac.signal));
});
const settle=()=>act(async()=>{await new Promise(r=>setTimeout(r,30));});
test('tar, tar.gz and tgz browse folders and render TSV with inherited permissions',async()=>{
 for(const name of ['sample.tar','sample.tar.gz','sample.tgz']) {
  let root;await act(async()=>{root=create(React.createElement(FilePreview,{src:new Blob([load(name.endsWith('.tar')?'ustar.tar':'sample.tgz')]),fileName:name,allowDownload:false,allowOpen:false,allowPrint:false}));});await settle();
  assert.match(JSON.stringify(root.toJSON()),/请选择包内文件/);
  await act(()=>root.root.findAllByType('button').find(b=>b.props.children.includes('data')).props.onClick());
  await act(()=>root.root.findAllByType('button').find(b=>b.props.children.includes('table.tsv')).props.onClick());await settle();
  assert.match(JSON.stringify(root.toJSON()),/foo/);
  const nested=root.root.findAllByType(FilePreview)[1];assert.equal(nested.props.allowDownload,false);assert.equal(nested.props.allowOpen,false);assert.equal(nested.props.allowPrint,false);
  await act(()=>root.unmount());
 }
});
