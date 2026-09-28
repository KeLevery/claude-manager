import { useState } from "react";
import { basename, type SessionKind } from "../types";
import { FolderPlus, X } from "lucide-react";
import { KindSelector } from "./KindSelector";

interface DropPickerProps {
  /** 拖入的目录列表。 */
  dirs: string[];
  onClose: () => void;
  onCreate: (dirs: string[], kind: SessionKind) => void;
}

/**
 * 拖放创建确认框：把文件夹拖入窗口后弹出，
 * 选择会话类型后按目录批量创建（名称默认取目录名）。
 */
export function DropPicker({ dirs, onClose, onCreate }: DropPickerProps) {
  const [kind, setKind] = useState<SessionKind>("claude");

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
          width: 480,
          maxWidth: "90vw",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          border: "1px solid #4a8af055",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            为 {dirs.length} 个目录创建会话
          </h3>
          <button onClick={onClose} title="关闭" style={iconBtn}>
            <X size={16} />
          </button>
        </div>

        <label style={labelStyle}>会话类型</label>
        <KindSelector value={kind} onChange={setKind} />

        <label style={labelStyle}>目录（名称默认取目录名）</label>
        <div
          style={{
            maxHeight: 180,
            overflowY: "auto",
            border: "1px solid #3a3a3a",
            borderRadius: 6,
            marginBottom: 18,
            padding: 6,
          }}
        >
          {dirs.map((d) => (
            <div
              key={d}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 8px",
                fontSize: 12,
              }}
            >
              <FolderPlus size={13} color="#9cdcfe" style={{ flexShrink: 0 }} />
              <span style={{ color: "#e6e6e6", fontWeight: 500 }}>
                {basename(d)}
              </span>
              <span
                style={{ color: "#777", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={d}
              >
                {d}
              </span>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={ghostBtn}>
            取消
          </button>
          <button onClick={() => onCreate(dirs, kind)} style={primaryBtn}>
            创建 {dirs.length} 个会话
          </button>
        </div>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "#9aa0a6",
  marginBottom: 6,
};
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
  cursor: "pointer",
};
