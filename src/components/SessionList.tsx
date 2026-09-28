import { Download, Eraser, Plus, RotateCcw, Trash2 } from "lucide-react";
import { basename, emojiFor, KIND_COLOR, KIND_LABEL, type SessionView } from "../types";

interface SessionListProps {
  sessions: SessionView[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onImport: () => void;
  onRestart: (id: string) => void;
  onRemove: (id: string) => void;
  /** 一键清空侧边栏会话记录（保留运行中的会话）。 */
  onClearAll: () => void;
}

/**
 * 左侧会话列表。
 * 每个会话条目：emoji/首字母 + 名称 + 路径 + 状态点。
 */
export function SessionList({
  sessions,
  activeId,
  onSelect,
  onNew,
  onImport,
  onRestart,
  onRemove,
  onClearAll,
}: SessionListProps) {
  return (
    <div
      style={{
        width: 240,
        minWidth: 240,
        height: "100%",
        background: "#1a1a1a",
        borderRight: "1px solid #2a2a2a",
        display: "flex",
        flexDirection: "column",
        color: "#e6e6e6",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 12px",
          borderBottom: "1px solid #2a2a2a",
        }}
      >
        <span style={{ fontSize: 12, color: "#9aa0a6", letterSpacing: 1 }}>
          会话（{sessions.length}）
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {sessions.length > 0 && (
            <button
              onClick={onClearAll}
              title="一键清空会话列表（保留运行中的会话）"
              style={{
                background: "#262626",
                border: "1px solid #333",
                borderRadius: 6,
                color: "#ccc",
                width: 26,
                height: 26,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Eraser size={13} />
            </button>
          )}
          <button
            onClick={onImport}
            title="导入外部 Claude 会话"
            style={{
              background: "#262626",
              border: "1px solid #333",
              borderRadius: 6,
              color: "#ccc",
              width: 26,
              height: 26,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Download size={13} />
          </button>
          <button
            onClick={onNew}
            title="新建会话"
            style={{
              background: "#396cd8",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              width: 26,
              height: 26,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Plus size={15} />
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {sessions.length === 0 && (
          <div
            style={{
              padding: "24px 12px",
              color: "#666",
              fontSize: 12,
              textAlign: "center",
            }}
          >
            暂无会话
            <br />
            点击右上 + 新建
          </div>
        )}
        {sessions.map((s) => {
          const isActive = s.id === activeId;
          const icon = emojiFor(s.name) ?? null;
          const initial = (s.name || "?").charAt(0).toUpperCase();
          return (
            <div
              key={s.id}
              onClick={() => onSelect(s.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 12px",
                cursor: "pointer",
                background: isActive ? "#26314a" : "transparent",
                borderLeft: isActive ? "3px solid #4a8af0" : "3px solid transparent",
                position: "relative",
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.background = "#222";
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.background = "transparent";
              }}
            >
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 6,
                  background: icon
                    ? "transparent"
                    : colorFromInitial(initial),
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 14,
                  flexShrink: 0,
                  color: icon ? "#fff" : "#fff",
                }}
              >
                {icon ?? initial}
              </div>
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: 1,
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span
                    title={s.kind}
                    style={{
                      fontSize: 9,
                      lineHeight: 1,
                      padding: "3px 5px",
                      borderRadius: 3,
                      fontWeight: 600,
                      letterSpacing: 0.5,
                      flexShrink: 0,
                      color: KIND_COLOR[s.kind]?.fg ?? "#c8c8c8",
                      background: KIND_COLOR[s.kind]?.bg ?? "#333",
                    }}
                  >
                    {KIND_LABEL[s.kind] ?? s.kind}
                  </span>
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {s.name || basename(s.cwd)}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "#777",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  title={s.cwd}
                >
                  {s.cwd}
                </div>
              </div>
              <span
                title={
                  s.status === "running"
                    ? `运行中 (PID ${s.pid ?? "?"})`
                    : s.status === "pending"
                      ? "启动中"
                      : `已退出${s.exitCode != null ? ` (${s.exitCode})` : ""}`
                }
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background:
                    s.status === "running"
                      ? "#4ade80"
                      : s.status === "pending"
                        ? "#e5c07b"
                        : "#666",
                  flexShrink: 0,
                  boxShadow:
                    s.status === "running"
                      ? "0 0 6px #4ade80aa"
                      : s.status === "pending"
                        ? "0 0 6px #e5c07baa"
                        : "none",
                }}
              />
              {/* 悬浮操作按钮 */}
              <div
                style={{
                  position: "absolute",
                  right: 8,
                  top: "50%",
                  transform: "translateY(-50%)",
                  display: "none",
                  gap: 2,
                }}
                ref={(el) => {
                  if (!el) return;
                  const parent = el.parentElement!;
                  parent.onmouseenter = () => {
                    el.style.display = "flex";
                  };
                  parent.onmouseleave = () => {
                    el.style.display = "none";
                  };
                }}
              >
                <button
                  title="重启会话"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRestart(s.id);
                  }}
                  style={miniBtn}
                >
                  <RotateCcw size={12} />
                </button>
                <button
                  title="移除项目"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(s.id);
                  }}
                  style={miniBtn}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const miniBtn: React.CSSProperties = {
  background: "#333",
  border: "1px solid #444",
  borderRadius: 4,
  color: "#ddd",
  width: 20,
  height: 20,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
};

/** 首字母 → 稳定的颜色（无 emoji 时用）。 */
function colorFromInitial(ch: string): string {
  const palette = [
    "#5b8def",
    "#e06c75",
    "#56b6c2",
    "#c678dd",
    "#98c379",
    "#d19a66",
    "#61afef",
  ];
  const code = ch.charCodeAt(0) || 0;
  return palette[code % palette.length];
}
