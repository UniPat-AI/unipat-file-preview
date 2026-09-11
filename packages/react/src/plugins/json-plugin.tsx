import React, { useMemo, useState } from 'react';
import type { PreviewPlugin, PreviewPluginProps } from './types.js';
import { useSourceText, inferFileName } from './utils.js';

export const JsonPlugin: PreviewPlugin = {
  name: 'json',
  match: (fileType) => fileType === 'json',
  Component: JsonComponent,
};

type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
interface JsonObject {
  [key: string]: JsonValue;
}
type JsonArray = JsonValue[];

function JsonComponent({ src, className, style, fileName, onLoad, onError }: PreviewPluginProps) {
  const { text, loading, error } = useSourceText(src);
  const [viewMode, setViewMode] = useState<'tree' | 'raw'>('tree');
  const [searchQuery, setSearchQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const [expandAllSignal, setExpandAllSignal] = useState<boolean | null>(null);

  const displayName = inferFileName(src, fileName);

  const parsed = useMemo(() => {
    if (!text) return { data: null, error: null };
    try {
      const data = JSON.parse(text) as JsonValue;
      return { data, error: null };
    } catch (err) {
      return { data: null, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }, [text]);

  if (error) {
    onError?.(error);
    return <div style={styles.errorBox}>JSON 读取失败：{error.message}</div>;
  }

  if (loading) {
    return <div style={styles.loading}>解析 JSON 数据中…</div>;
  }

  const handleCopyRaw = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  // 如果 JSON 语法不合法，降级展示错误并展示原始文本
  if (parsed.error) {
    return (
      <div className={className} style={{ ...styles.container, ...style }}>
        <div style={styles.syntaxErrorBanner}>
          <strong>JSON 格式无效：</strong> {parsed.error.message}
        </div>
        <div style={styles.rawHost}>
          <pre style={styles.rawPre}>{text}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className={className} style={{ ...styles.container, ...style }}>
      {/* 顶部工具栏 */}
      <div style={styles.toolbar}>
        <div style={styles.headerLeft}>
          <span style={styles.fileName}>{displayName}</span>
          <div style={styles.modeTabs}>
            <button
              type="button"
              style={{ ...styles.modeTab, ...(viewMode === 'tree' ? styles.modeTabActive : {}) }}
              onClick={() => setViewMode('tree')}
            >
              树形结构
            </button>
            <button
              type="button"
              style={{ ...styles.modeTab, ...(viewMode === 'raw' ? styles.modeTabActive : {}) }}
              onClick={() => setViewMode('raw')}
            >
              原始代码
            </button>
          </div>
        </div>

        <div style={styles.headerRight}>
          {viewMode === 'tree' ? (
            <>
              <input
                type="text"
                placeholder="搜索键或值…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={styles.searchInput}
              />
              <button
                type="button"
                onClick={() => setExpandAllSignal(true)}
                style={styles.actionBtn}
                title="展开所有节点"
              >
                全部展开
              </button>
              <button
                type="button"
                onClick={() => setExpandAllSignal(false)}
                style={styles.actionBtn}
                title="折叠所有节点"
              >
                全部折叠
              </button>
            </>
          ) : null}
          <button type="button" onClick={handleCopyRaw} style={styles.actionBtn}>
            {copied ? '已复制 ✓' : '复制全文'}
          </button>
        </div>
      </div>

      {/* 视图内容区 */}
      <div style={styles.contentHost}>
        {viewMode === 'tree' ? (
          <div style={styles.treeRoot}>
            <JsonNode
              name=""
              value={parsed.data}
              depth={0}
              searchQuery={searchQuery.toLowerCase().trim()}
              expandSignal={expandAllSignal}
            />
          </div>
        ) : (
          <div style={styles.rawHost}>
            <pre style={styles.rawPre}>
              <code>{JSON.stringify(parsed.data, null, 2)}</code>
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// 交互式 JSON 节点组件（支持折叠、悬浮复制与高亮）
// ------------------------------------------------------------
interface JsonNodeProps {
  name: string;
  value: JsonValue;
  depth: number;
  searchQuery: string;
  expandSignal: boolean | null;
}

function JsonNode({ name, value, depth, searchQuery, expandSignal }: JsonNodeProps) {
  // 默认前 2 层展开
  const isContainer = value !== null && typeof value === 'object';
  const [collapsed, setCollapsed] = useState(depth >= 2);
  const [copiedTip, setCopiedTip] = useState(false);

  // 监听全局展开/折叠信号
  React.useEffect(() => {
    if (expandSignal !== null) {
      setCollapsed(!expandSignal);
    }
  }, [expandSignal]);

  const copyValue = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const textToCopy = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
      await navigator.clipboard.writeText(textToCopy);
      setCopiedTip(true);
      setTimeout(() => setCopiedTip(false), 1500);
    } catch {
      // ignore
    }
  };

  const isArray = Array.isArray(value);

  // 渲染 Key（带搜索命中背景）
  const renderKey = () => {
    if (!name && depth === 0) return null;
    const matchKey = searchQuery && name.toLowerCase().includes(searchQuery);
    return (
      <span style={{ ...styles.keyName, ...(matchKey ? styles.highlightSearch : {}) }}>
        &quot;{name}&quot;:&nbsp;
      </span>
    );
  };

  if (!isContainer) {
    // 基础标量值渲染
    let valStyle = styles.valString;
    let valText = JSON.stringify(value);
    if (typeof value === 'number') {
      valStyle = styles.valNumber;
      valText = String(value);
    } else if (typeof value === 'boolean') {
      valStyle = styles.valBoolean;
      valText = String(value);
    } else if (value === null) {
      valStyle = styles.valNull;
      valText = 'null';
    }

    const matchVal = searchQuery && valText.toLowerCase().includes(searchQuery);

    return (
      <div style={{ ...styles.lineItem, paddingLeft: depth * 18 }}>
        {renderKey()}
        <span
          style={{ ...valStyle, ...(matchVal ? styles.highlightSearch : {}) }}
          onClick={copyValue}
          title="点击复制该值"
        >
          {valText}
        </span>
        {copiedTip ? <span style={styles.miniBadge}>已复制!</span> : null}
      </div>
    );
  }

  // 容器（对象 / 数组）渲染
  const keys = Object.keys(value as object);
  const size = isArray ? (value as JsonArray).length : keys.length;
  const countLabel = isArray ? `${size} items` : `${size} keys`;

  return (
    <div style={styles.containerNode}>
      <div
        style={{ ...styles.lineItem, paddingLeft: depth * 18, cursor: 'pointer' }}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span style={styles.arrowIcon}>{collapsed ? '▶' : '▼'}</span>
        {renderKey()}
        <span style={styles.brace}>{isArray ? '[' : '{'}</span>
        {collapsed ? (
          <>
            <span style={styles.collapsedBadge}>{countLabel}</span>
            <span style={styles.brace}>{isArray ? ']' : '}'}</span>
          </>
        ) : (
          <span style={styles.badge}>{countLabel}</span>
        )}
      </div>

      {!collapsed ? (
        <div style={styles.childrenHost}>
          {keys.map((key) => {
            const childVal = (value as Record<string, JsonValue>)[key]!;
            return (
              <JsonNode
                key={key}
                name={isArray ? '' : key}
                value={childVal}
                depth={depth + 1}
                searchQuery={searchQuery}
                expandSignal={expandSignal}
              />
            );
          })}
          <div style={{ ...styles.lineItem, paddingLeft: depth * 18 }}>
            <span style={styles.brace}>{isArray ? ']' : '}'}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------
// 样式定义（清爽现代的 DevTools / IDE 风格）
// ------------------------------------------------------------
const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    minHeight: 450,
    background: '#ffffff',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 13,
  },
  toolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    background: '#f8fafc',
    borderBottom: '1px solid #e2e8f0',
    flexWrap: 'wrap',
    gap: 8,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  fileName: {
    fontWeight: 600,
    color: '#334155',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  modeTabs: {
    display: 'flex',
    background: '#e2e8f0',
    padding: 2,
    borderRadius: 5,
  },
  modeTab: {
    border: 'none',
    background: 'transparent',
    padding: '3px 10px',
    fontSize: 12,
    borderRadius: 4,
    cursor: 'pointer',
    color: '#64748b',
  },
  modeTabActive: {
    background: '#ffffff',
    color: '#1e293b',
    fontWeight: 600,
    boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
  },
  searchInput: {
    padding: '4px 8px',
    border: '1px solid #cbd5e1',
    borderRadius: 4,
    fontSize: 12,
    outline: 'none',
    width: 140,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  actionBtn: {
    padding: '4px 10px',
    border: '1px solid #cbd5e1',
    background: '#fff',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    color: '#334155',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  contentHost: {
    flex: 1,
    overflow: 'auto',
    background: '#fcfcfc',
    padding: '12px 16px',
  },
  treeRoot: {
    lineHeight: '1.7',
  },
  containerNode: {
    display: 'flex',
    flexDirection: 'column',
  },
  childrenHost: {
    display: 'flex',
    flexDirection: 'column',
  },
  lineItem: {
    display: 'flex',
    alignItems: 'center',
    whiteSpace: 'nowrap',
    borderRadius: 3,
    paddingRight: 8,
  },
  arrowIcon: {
    display: 'inline-block',
    width: 14,
    fontSize: 9,
    color: '#94a3b8',
    userSelect: 'none',
    marginRight: 2,
  },
  keyName: {
    color: '#8b5cf6',
    fontWeight: 500,
  },
  valString: {
    color: '#16a34a',
    cursor: 'copy',
  },
  valNumber: {
    color: '#2563eb',
    cursor: 'copy',
  },
  valBoolean: {
    color: '#d97706',
    fontWeight: 600,
    cursor: 'copy',
  },
  valNull: {
    color: '#94a3b8',
    fontStyle: 'italic',
    cursor: 'copy',
  },
  brace: {
    color: '#475569',
    fontWeight: 600,
  },
  badge: {
    fontSize: 11,
    color: '#94a3b8',
    marginLeft: 8,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  collapsedBadge: {
    fontSize: 11,
    background: '#f1f5f9',
    border: '1px solid #e2e8f0',
    color: '#64748b',
    borderRadius: 3,
    padding: '0 6px',
    margin: '0 4px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  miniBadge: {
    fontSize: 10,
    background: '#dcfce7',
    color: '#166534',
    borderRadius: 3,
    padding: '0 4px',
    marginLeft: 6,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  highlightSearch: {
    background: '#fef08a',
    borderRadius: 2,
  },
  rawHost: {
    flex: 1,
    overflow: 'auto',
  },
  rawPre: {
    margin: 0,
    padding: 0,
    fontFamily: 'inherit',
    fontSize: 13,
    lineHeight: '1.6',
    color: '#334155',
  },
  syntaxErrorBanner: {
    padding: '8px 12px',
    background: '#fee2e2',
    color: '#991b1b',
    borderBottom: '1px solid #fecaca',
    fontSize: 12,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  loading: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: 300,
    color: '#94a3b8',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  errorBox: {
    padding: 16,
    color: '#dc2626',
    background: '#fef2f2',
    borderRadius: 6,
    margin: 16,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
};
