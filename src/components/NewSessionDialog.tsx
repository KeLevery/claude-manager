import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { basename, type SessionKind } from "../types";
import { Folder, Plus, X } from "lucide-react";
import { KindSelector } from "./KindSelector";

interface NewSessionDialogProps {
  onClose: () => void;
  onCreate: (cwd: string, name: string, kind: SessionKind) => void;
}

/**
 * 新建会话对话框：选目录 + 会话类型（Claude / PowerShell / CMD）+ 自动命名。
 * 调用 Tauri dialog 插件的原生文件夹选择器。
 */
export function NewSessionDialog({ onClose, onCreate }: NewSessionDialogProps) {
  const [cwd, setCwd] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<SessionKind>("claude");

  async function pickDir() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string" && selected.length > 0) {
      setCwd(selected);
      if (!name) {
        setName(basename(selected));
      }
    }
  }

  function submit() {
    if (!cwd) return;
    onCreate(cwd, name.trim() || basename(cwd), kind);
  }

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
          width: 460,
          maxWidth: "90vw",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          border: "1px solid #333",
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
            新建会话
          </h3>
          <button
            onClick={onClose}
            style={iconBtnStyle}
            title="关闭"
          >
            <X size={16} />
          </button>
        </div>

        <label style={labelStyle}>会话类型</label>
        <KindSelector value={kind} onChange={setKind} />

        <label style={labelStyle}>项目目录</label>
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <input
            value={cwd}
            readOnly
            placeholder="点击右侧按钮选择目录…"
            onChange={() => {}}
            style={{
              ...inputStyle,
              flex: 1,
              cursor: "default",
              color: "#9cdcfe",
            }}
          />
          <button onClick={pickDir} style={iconBtnStyle} title="选择目录">
            <Folder size={16} />
          </button>
        </div>

        <label style={labelStyle}>会话名称（默认取目录名）</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="留空则取目录名"
          style={{ ...inputStyle, width: "100%", marginBottom: 18 }}
          autoFocus
        />

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={ghostBtnStyle}>
            取消
          </button>
          <button
            onClick={submit}
            disabled={!cwd}
            style={{
              ...primaryBtnStyle,
              opacity: cwd ? 1 : 0.4,
              cursor: cwd ? "pointer" : "not-allowed",
            }}
          >
            <Plus size={14} style={{ marginRight: 4 }} />
            创建
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
const inputStyle: React.CSSProperties = {
  background: "#2a2a2a",
  border: "1px solid #3a3a3a",
  borderRadius: 6,
  padding: "8px 10px",
  color: "#e6e6e6",
  fontSize: 13,
  fontFamily: "inherit",
  outline: "none",
};
const iconBtnStyle: React.CSSProperties = {
  background: "#2a2a2a",
  border: "1px solid #3a3a3a",
  borderRadius: 6,
  color: "#e6e6e6",
  padding: "8px 10px",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
};
const ghostBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid #3a3a3a",
  borderRadius: 6,
  color: "#e6e6e6",
  padding: "8px 14px",
  cursor: "pointer",
  fontSize: 13,
};
const primaryBtnStyle: React.CSSProperties = {
  background: "#396cd8",
  border: "1px solid #396cd8",
  borderRadius: 6,
  color: "#fff",
  padding: "8px 14px",
  fontSize: 13,
  display: "inline-flex",
  alignItems: "center",
};
