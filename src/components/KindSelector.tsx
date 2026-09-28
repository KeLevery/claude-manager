import type { SessionKind } from "../types";

interface KindSelectorProps {
  value: SessionKind;
  onChange: (kind: SessionKind) => void;
}

/** 三选一会话类型：Claude Code / PowerShell / CMD。 */
export function KindSelector({ value, onChange }: KindSelectorProps) {
  const options: Array<{ kind: SessionKind; label: string; hint: string }> = [
    { kind: "claude", label: "Claude Code", hint: "AI 编程会话，可续接上下文" },
    { kind: "powershell", label: "PowerShell", hint: "原生 PowerShell 终端" },
    { kind: "cmd", label: "CMD", hint: "原生 cmd 终端" },
  ];
  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
      {options.map((o) => {
        const active = o.kind === value;
        return (
          <button
            key={o.kind}
            title={o.hint}
            onClick={() => onChange(o.kind)}
            style={{
              flex: 1,
              padding: "8px 10px",
              fontSize: 13,
              cursor: "pointer",
              borderRadius: 6,
              border: active ? "1px solid #4a8af0" : "1px solid #3a3a3a",
              background: active ? "#26314a" : "#2a2a2a",
              color: active ? "#e6e6e6" : "#9aa0a6",
              fontWeight: active ? 600 : 400,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
