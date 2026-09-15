import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dicomParser from 'dicom-parser';
import type { PreviewPlugin, PreviewPluginProps, FileSource } from './types.js';
import { inferFileName } from './utils.js';

export const DicomPlugin: PreviewPlugin = {
  name: 'dicom',
  match: (fileType) => ['dcm', 'dicom'].includes(fileType),
  Component: DicomComponent,
};

interface DicomMetadata {
  modality: string;
  patientName: string;
  patientId: string;
  studyDate: string;
  seriesDescription: string;
  rows: number;
  cols: number;
  samplesPerPixel: number;
  photometric: string;
  bitsAllocated: number;
  bitsStored: number;
  highBit: number;
  pixelRepresentation: number;
  numberOfFrames: number;
  rescaleSlope: number;
  rescaleIntercept: number;
  defaultWindowCenter: number;
  defaultWindowWidth: number;
  pixelSpacing?: string | undefined;
  sliceThickness?: string | undefined;
  minPixel: number;
  maxPixel: number;
}

const CT_PRESETS: Record<string, { ww: number; wl: number }> = {
  '脑窗 (Brain)': { ww: 80, wl: 40 },
  '肺窗 (Lung)': { ww: 1500, wl: -600 },
  '骨窗 (Bone)': { ww: 2000, wl: 500 },
  '腹部软组织 (Abdomen)': { ww: 350, wl: 40 },
  '纵隔窗 (Mediastinum)': { ww: 350, wl: 40 },
};

function DicomComponent({
  src,
  className,
  style,
  fileName,
  onLoad,
  onError,
}: PreviewPluginProps) {
  const displayName = inferFileName(src, fileName);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const [meta, setMeta] = useState<DicomMetadata | null>(null);
  const [pixelData, setPixelData] = useState<Int16Array | Uint16Array | Uint8Array | null>(null);

  // 图像交互状态
  const [currentFrame, setCurrentFrame] = useState(0);
  const [windowWidth, setWindowWidth] = useState(400);
  const [windowCenter, setWindowCenter] = useState(40);
  const [zoom, setZoom] = useState(1);
  const [invert, setInvert] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const [activePreset, setActivePreset] = useState<string>('default');

  // HUD 探针
  const [hud, setHud] = useState<{ x: number; y: number; val: number; hu: number } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ isDragging: boolean; startX: number; startY: number; startWW: number; startWL: number }>({
    isDragging: false,
    startX: 0,
    startY: 0,
    startWW: 400,
    startWL: 40,
  });

  // 1. 读取并解析 DICOM
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);

    async function loadDicom() {
      try {
        let buffer: ArrayBuffer;
        if (typeof src === 'string') {
          const res = await fetch(src, { signal: ac.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
          buffer = await res.arrayBuffer();
        } else if (typeof Blob !== 'undefined' && src instanceof Blob) {
          buffer = await src.arrayBuffer();
        } else {
          throw new Error('不支持的文件源类型');
        }

        if (ac.signal.aborted) return;

        const byteArray = new Uint8Array(buffer);
        const dataSet = dicomParser.parseDicom(byteArray);

        const rows = dataSet.uint16('x00280010') || 0;
        const cols = dataSet.uint16('x00280011') || 0;
        if (rows === 0 || cols === 0) {
          throw new Error('DICOM 文件缺少有效的图像尺寸信息 (Rows/Columns)');
        }

        const bitsAllocated = dataSet.uint16('x00280100') || 16;
        const bitsStored = dataSet.uint16('x00280101') || bitsAllocated;
        const highBit = dataSet.uint16('x00280102') || bitsStored - 1;
        const pixelRepresentation = dataSet.uint16('x00280103') || 0;
        const samplesPerPixel = dataSet.uint16('x00280002') || 1;
        const photometric = (dataSet.string('x00280004') || 'MONOCHROME2').trim();
        const numberOfFrames = Math.max(1, dataSet.intString('x00280008') || 1);

        const rescaleSlope = dataSet.floatString('x00281053') ?? 1;
        const rescaleIntercept = dataSet.floatString('x00281052') ?? 0;

        // 提取像素数据
        const pixelElement = dataSet.elements.x7fe00010;
        if (!pixelElement || pixelElement.dataOffset == null) {
          throw new Error('未找到 PixelData 图像数据元素');
        }

        const offset = pixelElement.dataOffset;
        const totalPixels = rows * cols * numberOfFrames * samplesPerPixel;
        let pixels: Int16Array | Uint16Array | Uint8Array;

        if (bitsAllocated === 16) {
          const pixelByteLength = totalPixels * 2;
          const pixelArrayBuffer = new ArrayBuffer(pixelByteLength);
          new Uint8Array(pixelArrayBuffer).set(byteArray.subarray(offset, offset + pixelByteLength));
          pixels = pixelRepresentation === 1 ? new Int16Array(pixelArrayBuffer) : new Uint16Array(pixelArrayBuffer);
        } else {
          const pixelArrayBuffer = new ArrayBuffer(totalPixels);
          new Uint8Array(pixelArrayBuffer).set(byteArray.subarray(offset, offset + totalPixels));
          pixels = new Uint8Array(pixelArrayBuffer);
        }

        // 计算极值以确定默认窗位
        let minPixel = Infinity;
        let maxPixel = -Infinity;
        const sampleStep = Math.max(1, Math.floor(pixels.length / 5000));
        for (let i = 0; i < pixels.length; i += sampleStep) {
          const p = pixels[i]!;
          if (p < minPixel) minPixel = p;
          if (p > maxPixel) maxPixel = p;
        }

        const tagWC = dataSet.floatString('x00281050');
        const tagWW = dataSet.floatString('x00281051');

        let defaultWl: number;
        let defaultWw: number;

        if (tagWC != null && tagWW != null && tagWW > 0) {
          defaultWl = tagWC;
          defaultWw = tagWW;
        } else {
          // 根据极值推导 HU / 像素范围
          const minHU = minPixel * rescaleSlope + rescaleIntercept;
          const maxHU = maxPixel * rescaleSlope + rescaleIntercept;
          defaultWw = Math.max(1, maxHU - minHU);
          defaultWl = Math.round(minHU + defaultWw / 2);
        }

        const metadata: DicomMetadata = {
          modality: dataSet.string('x00080060') || 'OT',
          patientName: dataSet.string('x00100010') || 'Anonymous',
          patientId: dataSet.string('x00100020') || 'N/A',
          studyDate: dataSet.string('x00080020') || '',
          seriesDescription: dataSet.string('x0008103e') || '',
          rows,
          cols,
          samplesPerPixel,
          photometric,
          bitsAllocated,
          bitsStored,
          highBit,
          pixelRepresentation,
          numberOfFrames,
          rescaleSlope,
          rescaleIntercept,
          defaultWindowCenter: defaultWl,
          defaultWindowWidth: defaultWw,
          pixelSpacing: dataSet.string('x00280030'),
          sliceThickness: dataSet.string('x00180050'),
          minPixel,
          maxPixel,
        };

        setMeta(metadata);
        setPixelData(pixels);
        setWindowWidth(Math.round(defaultWw));
        setWindowCenter(Math.round(defaultWl));
        setCurrentFrame(0);
        setLoading(false);
        onLoad?.();
      } catch (err) {
        if (!ac.signal.aborted) {
          const errorObj = err instanceof Error ? err : new Error(String(err));
          setError(errorObj);
          setLoading(false);
          onError?.(errorObj);
        }
      }
    }

    void loadDicom();
    return () => ac.abort();
  }, [src, onLoad, onError]);

  // 2. 渲染当前 Frame 到 Canvas
  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !meta || !pixelData) return;

    const { rows, cols, samplesPerPixel, rescaleSlope, rescaleIntercept, photometric } = meta;
    canvas.width = cols;
    canvas.height = rows;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const imageData = ctx.createImageData(cols, rows);
    const data32 = new Uint32Array(imageData.data.buffer);

    const frameOffset = currentFrame * rows * cols * samplesPerPixel;
    const ww = Math.max(1, windowWidth);
    const wl = windowCenter;
    const low = wl - ww / 2;
    const high = wl + ww / 2;
    const isMono1 = photometric === 'MONOCHROME1' || invert;

    if (samplesPerPixel === 1) {
      // 灰度（CT / MR / X-ray）
      for (let i = 0; i < rows * cols; i++) {
        const raw = pixelData[frameOffset + i]!;
        const val = raw * rescaleSlope + rescaleIntercept;
        let intensity: number;
        if (val <= low) {
          intensity = 0;
        } else if (val >= high) {
          intensity = 255;
        } else {
          intensity = Math.round(((val - low) / ww) * 255);
        }

        if (isMono1) intensity = 255 - intensity;

        // ABGR 格式写入 32 位整型（小端序：0xAABBGGRR）
        data32[i] = (255 << 24) | (intensity << 16) | (intensity << 8) | intensity;
      }
    } else if (samplesPerPixel === 3) {
      // 彩色（超声 / 内窥镜）
      for (let i = 0; i < rows * cols; i++) {
        const r = pixelData[frameOffset + i * 3]!;
        const g = pixelData[frameOffset + i * 3 + 1]!;
        const b = pixelData[frameOffset + i * 3 + 2]!;
        data32[i] = (255 << 24) | (b << 16) | (g << 8) | r;
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }, [meta, pixelData, currentFrame, windowWidth, windowCenter, invert]);

  useEffect(() => {
    renderFrame();
  }, [renderFrame]);

  // 3. 鼠标交互：拖拽调窗 (WW / WL)
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // 仅左键拖拽调窗
    dragRef.current = {
      isDragging: true,
      startX: e.clientX,
      startY: e.clientY,
      startWW: windowWidth,
      startWL: windowCenter,
    };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    // 处理调窗拖拽
    if (dragRef.current.isDragging) {
      const deltaX = e.clientX - dragRef.current.startX;
      const deltaY = e.clientY - dragRef.current.startY;
      const step = Math.max(1, Math.round(meta?.defaultWindowWidth ? meta.defaultWindowWidth / 250 : 2));
      const newWW = Math.max(1, dragRef.current.startWW + deltaX * step);
      const newWL = dragRef.current.startWL - deltaY * step;
      setWindowWidth(newWW);
      setWindowCenter(newWL);
      setActivePreset('custom');
    }

    // 处理 HUD 探针
    const canvas = canvasRef.current;
    if (!canvas || !meta || !pixelData) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = meta.cols / rect.width;
    const scaleY = meta.rows / rect.height;
    const imgX = Math.floor((e.clientX - rect.left) * scaleX);
    const imgY = Math.floor((e.clientY - rect.top) * scaleY);

    if (imgX >= 0 && imgX < meta.cols && imgY >= 0 && imgY < meta.rows) {
      const idx = currentFrame * meta.rows * meta.cols + imgY * meta.cols + imgX;
      const raw = pixelData[idx] ?? 0;
      const hu = Math.round(raw * meta.rescaleSlope + meta.rescaleIntercept);
      setHud({ x: imgX, y: imgY, val: raw, hu });
    } else {
      setHud(null);
    }
  };

  const handleMouseUp = () => {
    dragRef.current.isDragging = false;
  };

  // 4. 滚轮事件：多切片切换
  const handleWheel = (e: React.WheelEvent) => {
    if (!meta || meta.numberOfFrames <= 1) return;
    e.preventDefault();
    if (e.deltaY > 0) {
      setCurrentFrame((f) => Math.min(meta.numberOfFrames - 1, f + 1));
    } else {
      setCurrentFrame((f) => Math.max(0, f - 1));
    }
  };

  // 5. 键盘切片
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!meta || meta.numberOfFrames <= 1) return;
      if (['ArrowLeft', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        setCurrentFrame((f) => Math.max(0, f - 1));
      } else if (['ArrowRight', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        setCurrentFrame((f) => Math.min(meta.numberOfFrames - 1, f + 1));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setCurrentFrame(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setCurrentFrame(meta.numberOfFrames - 1);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [meta]);

  const applyPreset = (presetKey: string) => {
    if (presetKey === 'default' && meta) {
      setWindowWidth(Math.round(meta.defaultWindowWidth));
      setWindowCenter(Math.round(meta.defaultWindowCenter));
      setActivePreset('default');
    } else if (presetKey === 'full' && meta) {
      const minHU = meta.minPixel * meta.rescaleSlope + meta.rescaleIntercept;
      const maxHU = meta.maxPixel * meta.rescaleSlope + meta.rescaleIntercept;
      setWindowWidth(Math.round(maxHU - minHU));
      setWindowCenter(Math.round(minHU + (maxHU - minHU) / 2));
      setActivePreset('full');
    } else if (CT_PRESETS[presetKey]) {
      setWindowWidth(CT_PRESETS[presetKey]!.ww);
      setWindowCenter(CT_PRESETS[presetKey]!.wl);
      setActivePreset(presetKey);
    }
  };

  if (error) {
    return (
      <div className={className} style={{ ...styles.container, ...style }}>
        <div style={styles.errorBox}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>⚠️</div>
          <div>DICOM 影像解析失败：{error.message}</div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={className} style={{ ...styles.container, ...style }}>
        <div style={styles.loadingBox}>
          <div style={styles.spinner} />
          <div>正在加载并解析 DICOM 医学影像…</div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={className}
      style={{ ...styles.container, ...style }}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => {
        handleMouseUp();
        setHud(null);
      }}
    >
      {/* 顶部专业状态栏 */}
      <div style={styles.topbar}>
        <div style={styles.topbarLeft}>
          <span style={styles.modalityBadge}>{meta?.modality || 'DICOM'}</span>
          <span style={styles.fileName}>{displayName}</span>
          <span style={styles.dimInfo}>
            {meta?.cols}×{meta?.rows}
            {meta && meta.numberOfFrames > 1 ? ` × ${meta.numberOfFrames} 帧` : ' (单切片)'}
          </span>
        </div>

        <div style={styles.topbarRight}>
          <span style={styles.wwReadout}>
            WW: <b>{windowWidth}</b> / WL: <b>{windowCenter}</b>
          </span>
          <button
            type="button"
            onClick={() => setShowMeta((v) => !v)}
            style={{ ...styles.btn, ...(showMeta ? styles.btnActive : {}) }}
            title="查看 DICOM 标签元数据"
          >
            📋 元数据
          </button>
        </div>
      </div>

      {/* 快捷交互控制栏 */}
      <div style={styles.toolbar}>
        {/* CT 常用窗位预设 */}
        <select
          value={activePreset}
          onChange={(e) => applyPreset(e.target.value)}
          style={styles.select}
          title="选择常用临床窗宽/窗位"
        >
          <option value="default">默认窗位 (Default)</option>
          <option value="full">全动态范围 (Full Range)</option>
          {Object.keys(CT_PRESETS).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
          {activePreset === 'custom' && <option value="custom">自定义 (拖拽微调)</option>}
        </select>

        <button
          type="button"
          onClick={() => applyPreset('default')}
          style={styles.btn}
          title="重置为默认窗宽/窗位"
        >
          ↺ 重置调窗
        </button>

        <button
          type="button"
          onClick={() => setInvert((v) => !v)}
          style={{ ...styles.btn, ...(invert ? styles.btnActive : {}) }}
          title="黑白反转 (Invert LUT)"
        >
          ◐ 反转
        </button>

        <div style={styles.divider} />

        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(0.25, +(z - 0.25).toFixed(2)))}
          style={styles.btn}
          title="缩小"
        >
          -
        </button>
        <span style={styles.zoomLabel}>{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)))}
          style={styles.btn}
          title="放大"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => setZoom(1)}
          style={styles.btn}
          title="100% 原始大小"
        >
          1:1
        </button>
      </div>

      {/* 影像主视口 */}
      <div
        style={styles.viewport}
        onMouseDown={handleMouseDown}
        onWheel={handleWheel}
      >
        <canvas
          ref={canvasRef}
          style={{
            ...styles.canvas,
            transform: `scale(${zoom})`,
          }}
        />

        {/* 交互提示 */}
        <div style={styles.hintTag}>
          按住左键拖拽：横向调 WW，纵向调 WL
          {meta && meta.numberOfFrames > 1 && ' ｜ 滚轮/方向键滚切片'}
        </div>

        {/* HUD 实时探针 */}
        {hud && (
          <div style={styles.hudPanel}>
            <span>X: <b>{hud.x}</b> Y: <b>{hud.y}</b></span>
            <span>HU: <b>{hud.hu}</b></span>
            <span style={{ color: '#8b949e' }}>(Raw: {hud.val})</span>
          </div>
        )}
      </div>

      {/* 多切片滚动导航栏 */}
      {meta && meta.numberOfFrames > 1 && (
        <div style={styles.sliceNav}>
          <button
            type="button"
            onClick={() => setCurrentFrame((f) => Math.max(0, f - 1))}
            disabled={currentFrame <= 0}
            style={styles.sliceBtn}
          >
            ◀
          </button>
          <input
            type="range"
            min={0}
            max={meta.numberOfFrames - 1}
            value={currentFrame}
            onChange={(e) => setCurrentFrame(Number(e.target.value))}
            style={styles.slider}
          />
          <button
            type="button"
            onClick={() => setCurrentFrame((f) => Math.min(meta.numberOfFrames - 1, f + 1))}
            disabled={currentFrame >= meta.numberOfFrames - 1}
            style={styles.sliceBtn}
          >
            ▶
          </button>
          <span style={styles.sliceText}>
            {currentFrame + 1} / {meta.numberOfFrames}
          </span>
        </div>
      )}

      {/* 元数据弹窗/抽屉 */}
      {showMeta && meta && (
        <div style={styles.metaOverlay}>
          <div style={styles.metaDialog}>
            <div style={styles.metaHeader}>
              <h3 style={{ margin: 0, fontSize: 16 }}>📋 DICOM 标签元数据</h3>
              <button
                type="button"
                onClick={() => setShowMeta(false)}
                style={styles.closeBtn}
              >
                ✕
              </button>
            </div>
            <div style={styles.metaBody}>
              <table style={styles.metaTable}>
                <tbody>
                  <tr>
                    <td>检查模态 (Modality)</td>
                    <td><b>{meta.modality}</b></td>
                  </tr>
                  <tr>
                    <td>患者姓名 (Patient)</td>
                    <td>{meta.patientName}</td>
                  </tr>
                  <tr>
                    <td>患者 ID (Patient ID)</td>
                    <td>{meta.patientId}</td>
                  </tr>
                  <tr>
                    <td>检查日期 (Study Date)</td>
                    <td>{meta.studyDate || 'N/A'}</td>
                  </tr>
                  <tr>
                    <td>序列描述 (Series Desc)</td>
                    <td>{meta.seriesDescription || 'N/A'}</td>
                  </tr>
                  <tr>
                    <td>图像分辨率 (Dimensions)</td>
                    <td>{meta.cols} × {meta.rows}</td>
                  </tr>
                  <tr>
                    <td>切片/帧数 (Frames)</td>
                    <td>{meta.numberOfFrames}</td>
                  </tr>
                  <tr>
                    <td>位深 (Bits Stored / Allocated)</td>
                    <td>{meta.bitsStored} / {meta.bitsAllocated} bit</td>
                  </tr>
                  <tr>
                    <td>像素表现 (Pixel Representation)</td>
                    <td>{meta.pixelRepresentation === 1 ? 'Signed (有符号)' : 'Unsigned (无符号)'}</td>
                  </tr>
                  <tr>
                    <td>光度学解释 (Photometric)</td>
                    <td>{meta.photometric}</td>
                  </tr>
                  <tr>
                    <td>HU 变换 (Slope / Intercept)</td>
                    <td>{meta.rescaleSlope} / {meta.rescaleIntercept}</td>
                  </tr>
                  <tr>
                    <td>体素间距 (Pixel Spacing)</td>
                    <td>{meta.pixelSpacing || 'N/A'}</td>
                  </tr>
                  <tr>
                    <td>层厚 (Slice Thickness)</td>
                    <td>{meta.sliceThickness ? `${meta.sliceThickness} mm` : 'N/A'}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    minHeight: 480,
    background: '#0d1117',
    color: '#c9d1d9',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
    position: 'relative',
    userSelect: 'none',
    overflow: 'hidden',
  },
  topbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 14px',
    background: '#161b22',
    borderBottom: '1px solid #30363d',
    fontSize: 13,
  },
  topbarLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    overflow: 'hidden',
  },
  modalityBadge: {
    background: '#1f6feb',
    color: '#ffffff',
    fontSize: 11,
    fontWeight: 'bold',
    padding: '2px 6px',
    borderRadius: 4,
  },
  fileName: {
    fontWeight: 600,
    color: '#f0f6fc',
    maxWidth: 240,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  dimInfo: {
    color: '#8b949e',
    fontSize: 12,
  },
  topbarRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  wwReadout: {
    fontSize: 12,
    color: '#79c0ff',
    fontFamily: 'ui-monospace, monospace',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 14px',
    background: 'rgba(22, 27, 34, 0.85)',
    borderBottom: '1px solid #21262d',
    flexWrap: 'wrap',
  },
  select: {
    background: '#21262d',
    color: '#c9d1d9',
    border: '1px solid #30363d',
    borderRadius: 4,
    padding: '4px 8px',
    fontSize: 12,
    outline: 'none',
    cursor: 'pointer',
  },
  btn: {
    background: '#21262d',
    color: '#c9d1d9',
    border: '1px solid #30363d',
    borderRadius: 4,
    padding: '4px 10px',
    fontSize: 12,
    cursor: 'pointer',
    transition: 'background 0.2s',
  },
  btnActive: {
    background: '#1f6feb',
    borderColor: '#388bfd',
    color: '#ffffff',
  },
  divider: {
    width: 1,
    height: 16,
    background: '#30363d',
    margin: '0 4px',
  },
  zoomLabel: {
    fontSize: 12,
    minWidth: 42,
    textAlign: 'center',
    color: '#8b949e',
  },
  viewport: {
    flex: 1,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
    overflow: 'hidden',
    background: '#000000',
    cursor: 'crosshair',
  },
  canvas: {
    imageRendering: 'pixelated',
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
    boxShadow: '0 0 20px rgba(0, 0, 0, 0.8)',
    transition: 'transform 0.05s ease-out',
  },
  hintTag: {
    position: 'absolute',
    top: 10,
    left: 12,
    background: 'rgba(13, 17, 23, 0.85)',
    padding: '4px 8px',
    borderRadius: 4,
    border: '1px solid #30363d',
    fontSize: 11,
    color: '#8b949e',
    pointerEvents: 'none',
  },
  hudPanel: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    background: 'rgba(13, 17, 23, 0.9)',
    border: '1px solid #30363d',
    borderRadius: 4,
    padding: '4px 10px',
    fontSize: 12,
    fontFamily: 'ui-monospace, monospace',
    display: 'flex',
    gap: 12,
    pointerEvents: 'none',
    color: '#e6edf3',
  },
  sliceNav: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 16px',
    background: '#161b22',
    borderTop: '1px solid #30363d',
  },
  sliceBtn: {
    background: '#21262d',
    color: '#c9d1d9',
    border: '1px solid #30363d',
    borderRadius: 4,
    padding: '4px 8px',
    fontSize: 12,
    cursor: 'pointer',
  },
  slider: {
    flex: 1,
    cursor: 'pointer',
  },
  sliceText: {
    fontSize: 12,
    color: '#79c0ff',
    minWidth: 60,
    textAlign: 'right',
    fontFamily: 'ui-monospace, monospace',
  },
  metaOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0, 0, 0, 0.65)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  metaDialog: {
    background: '#161b22',
    border: '1px solid #30363d',
    borderRadius: 8,
    width: '90%',
    maxWidth: 520,
    maxHeight: '80%',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
  },
  metaHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    borderBottom: '1px solid #30363d',
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: '#8b949e',
    fontSize: 16,
    cursor: 'pointer',
  },
  metaBody: {
    padding: 16,
    overflowY: 'auto',
  },
  metaTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 12,
    lineHeight: '20px',
  },
  errorBox: {
    margin: 'auto',
    padding: 24,
    textAlign: 'center',
    background: '#161b22',
    border: '1px solid #f85149',
    borderRadius: 8,
    color: '#f85149',
    maxWidth: 420,
  },
  loadingBox: {
    margin: 'auto',
    textAlign: 'center',
    color: '#8b949e',
    fontSize: 14,
  },
  spinner: {
    width: 32,
    height: 32,
    border: '3px solid #30363d',
    borderTopColor: '#1f6feb',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
    margin: '0 auto 12px auto',
  },
};
