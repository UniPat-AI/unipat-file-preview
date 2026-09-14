import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FilePreview } from '../../packages/react/src/index';
function Demo() {
  const [name, setName] = useState('target_roster.tsv.gz');
  return <main style={{ fontFamily: 'sans-serif', maxWidth: 1000, margin: '24px auto' }}>
    <h1>压缩文件只读预览验收</h1>
    <label>预览样例 <select value={name} onChange={e => setName(e.target.value)}>
      <option>target_roster.tsv.gz</option><option>review.zip</option><option>sample.tar</option><option>sample.tar.gz</option><option>sample.tgz</option>
    </select></label>
    <p>本示例关闭下载、外跳及打印。ZIP 内含子目录、JSON、HTML 和 GZIP 表格。</p>
    <FilePreview src={`/${name}${name.endsWith(".gz") ? ".bin" : ""}`} fileName={name} allowDownload={false} allowOpen={false} allowPrint={false} style={{ minHeight: 480 }} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Demo />);
