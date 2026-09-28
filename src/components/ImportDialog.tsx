import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ExternalSession } from "../types";
import { ChevronDown, ChevronRight, Download, Folder, X } from "lucide-react";

interface ImportDialogProps {
  onClose: () => void;
  onImport: (list: ExternalSession[]) => void;
}

/** 按项目目录聚合的会话组。list 按活跃时间倒序，组序 = 最新会话的先后。 */
interface SessionGroup {
  cwd: string;
  name: string;
  sessions: ExternalSession[];
}

/**
 * 导入外部 Claude 会话对话框。
 * 数据来自后端扫描 ~/.claude/projects 的会话转录（已排除纳管过的）。
 * 按项目分组展示，组可折叠（点组头）；默认不预选任何会话，
 * 由用户勾选（组头勾选框 = 整组）。顶部有全选/全不选。
 */
export function ImportDialog({ onClose, onImport }: ImportDialogProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // 折叠的组（按 cwd 记）。默认只展开最近的一个项目。
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    invoke<ExternalSession[]>("list_external_sessions")
      .then((sessions) => {
        if (cancelled) return;
        // 按目录分组，保持"最新在前"的组序
        const byCwd = new Map<string, ExternalSession[]>();
        for (const s of sessions) {
          const arr = byCwd.get(s.cwd) ?? [];
          arr.push(s);
          byCwd.set(s.cwd, arr);
        }
        const gs: SessionGroup[] = [];
        for (const [cwd, list] of byCwd) {
          gs.push({ cwd, name: list[0].name, sessions: list });
        }
        setGroups(gs);
        // 默认不预选任何会话：用户勾哪个导哪个
        setSelected(new Set());
        // 默认折叠除最近项目外的所有组
        setCollapsed(new Set(gs.slice(1).map((g) => g.cwd)));
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const total = groups.reduce((n, g) => n + g.sessions.length, 0);
  const allSelected = total > 0 && selected.size === total;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(groups.flatMap((g) => g.sessions.map((s) => s.claudeSessionId))));
  }

  function toggleGroup(g: SessionGroup) {
    setSelected((prev) => {
      const next = new Set(prev);
      const ids = g.sessions.map((s) => s.claudeSessionId);
      const allIn = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allIn) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  function toggleCollapse(cwd: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  }

  const selectedList = groups
    .flatMap((g) => g.sessions)
    .filter((s) => selected.has(s.claudeSessionId));

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1e1e1e",
          color: "#e6e6e6",
          borderRadius: 10,
          padding: 20,
          width: 580,
          maxWidth: "92vw",
          height: "80vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          border: "1px solid #333",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 6,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            导入 Claude Code 会话
          </h3>
          <button onClick={onClose} title="关闭" style={iconBtn}>
            <X size={16} />
          </button>
        </div>
        <div style={{ fontSize: 12, color: "#777", marginBottom: 12 }}>
          来自 ~/.claude/projects 的会话记录（已在管理器中的不重复列出）；
          勾选要导入的会话，导入后可恢复完整对话上下文
        </div>

        {loading && (
          <div style={{ padding: "30px 0", textAlign: "center", color: "#777", fontSize: 13 }}>
            正在扫描会话记录…
          </div>
        )}
        {error && (
          <div style={{ padding: "20px 0", textAlign: "center", color: "#e06c75", fontSize: 13 }}>
            扫描失败: {error}
          </div>
        )}
        {!loading && !error && groups.length === 0 && (
          <div style={{ padding: "30px 0", textAlign: "center", color: "#777", fontSize: 13 }}>
            没有发现可导入的会话
          </div>
        )}

        {!loading && groups.length > 0 && (
          <>
            {/* 全选工具条 */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 8,
              }}
            >
              <button onClick={toggleAll} style={selectAllBtn}>
                {allSelected ? "取消全选" : "全选"}
              </button>
              <span style={{ fontSize: 12, color: "#888" }}>
                已选 {selected.size} / {total} 个会话 · {groups.length} 个项目
              </span>
            </div>

            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: "auto",
                border: "1px solid #3a3a3a",
                borderRadius: 6,
                padding: 4,
              }}
            >
              {groups.map((g) => {
                const ids = g.sessions.map((s) => s.claudeSessionId);
                const allIn = ids.every((id) => selected.has(id));
                const someIn = ids.some((id) => selected.has(id));
                const selCount = ids.filter((id) => selected.has(id)).length;
                const isCollapsed = collapsed.has(g.cwd);
                return (
                  <div key={g.cwd} style={{ marginBottom: 4 }}>
                    {/* 组头：点击折叠/展开；勾选框单独处理整组选择。滚动时吸顶。 */}
                    <div
                      onClick={() => toggleCollapse(g.cwd)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 8px",
                        background: "#232323",
                        borderRadius: 4,
                        cursor: "pointer",
                        position: "sticky",
                        top: 0,
                        zIndex: 1,
                      }}
                    >
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleGroup(g);
                        }}
                        style={checkboxStyle(allIn)}
                        title="整组勾选/取消"
                      >
                        {allIn ? "✓" : someIn ? "–" : ""}
                      </span>
                      {isCollapsed ? (
                        <ChevronRight size={13} color="#888" style={{ flexShrink: 0 }} />
                      ) : (
                        <ChevronDown size={13} color="#888" style={{ flexShrink: 0 }} />
                      )}
                      <Folder size={13} color="#9cdcfe" style={{ flexShrink: 0 }} />
                      <span style={{ fontSize: 13, fontWeight: 600, flexShrink: 0 }}>
                        {g.name}
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          color: "#777",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          flex: 1,
                        }}
                        title={g.cwd}
                      >
                        {g.cwd}
                      </span>
                      <span style={{ fontSize: 11, color: "#666", flexShrink: 0 }}>
                        已选 {selCount} / {g.sessions.length}
                      </span>
                    </div>
                    {/* 组内会话行（折叠时隐藏） */}
                    {!isCollapsed && g.sessions.map((s) => {
                      const checked = selected.has(s.claudeSessionId);
                      return (
                        <div
                          key={s.claudeSessionId}
                          onClick={() => toggle(s.claudeSessionId)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "5px 8px 5px 28px",
                            cursor: "pointer",
                            borderRadius: 4,
                            background: checked ? "#22283a" : "transparent",
                          }}
                        >
                          <span style={checkboxStyle(checked)}>{checked ? "✓" : ""}</span>
                          <span
                            title={s.active ? "有 claude 终端正开在此会话/目录" : ""}
                            style={{
                              width: 7,
                              height: 7,
                              borderRadius: "50%",
                              background: s.active ? "#4ade80" : "#555",
                              boxShadow: s.active ? "0 0 6px #4ade80aa" : "none",
                              flexShrink: 0,
                            }}
                          />
                          <span
                            style={{
                              fontSize: 11,
                              color: "#888",
                              fontFamily: "Consolas, monospace",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              flex: 1,
                            }}
                            title={s.claudeSessionId}
                          >
                            {s.claudeSessionId.slice(0, 8)}…
                          </span>
                          <span style={{ fontSize: 11, color: "#666", flexShrink: 0 }}>
                            {formatSize(s.sizeBytes)}
                          </span>
                          <span
                            style={{
                              fontSize: 11,
                              color: s.active ? "#4ade80" : "#888",
                              flexShrink: 0,
                              width: 76,
                              textAlign: "right",
                            }}
                          >
                            {s.active ? "运行中" : timeAgo(s.lastActive)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                marginTop: 14,
              }}
            >
              <button onClick={onClose} style={ghostBtn}>
                取消
              </button>
              <button
                onClick={() => onImport(selectedList)}
                disabled={selectedList.length === 0}
                style={{
                  ...primaryBtn,
                  opacity: selectedList.length > 0 ? 1 : 0.4,
                  cursor: selectedList.length > 0 ? "pointer" : "not-allowed",
                }}
              >
                <Download size={14} style={{ marginRight: 4 }} />
                导入 {selectedList.length} 个会话
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function checkboxStyle(checked: boolean): React.CSSProperties {
  return {
    width: 14,
    height: 14,
    borderRadius: 3,
    border: checked ? "1px solid #4a8af0" : "1px solid #555",
    background: checked ? "#4a8af0" : "transparent",
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 10,
    lineHeight: 1,
    color: "#fff",
  };
}

function timeAgo(unixSecs: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - unixSecs));
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const iconBtn: React.CSSProperties = {
  background: "#2a2a2a",
  border: "1px solid #3a3a3a",
  borderRadius: 6,
  color: "#e6e6e6",
  padding: "6px 8px",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
};
const selectAllBtn: React.CSSProperties = {
  background: "#2a2a2a",
  border: "1px solid #3a3a3a",
  borderRadius: 6,
  color: "#ccc",
  padding: "5px 12px",
  cursor: "pointer",
  fontSize: 12,
};
const ghostBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #3a3a3a",
  borderRadius: 6,
  color: "#e6e6e6",
  padding: "8px 14px",
  cursor: "pointer",
  fontSize: 13,
};
const primaryBtn: React.CSSProperties = {
  background: "#396cd8",
  border: "1px solid #396cd8",
  borderRadius: 6,
  color: "#fff",
  padding: "8px 14px",
  fontSize: 13,
  display: "inline-flex",
  alignItems: "center",
};
