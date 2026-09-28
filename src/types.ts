// 前端类型定义：与后端 manager.rs 的 SessionView 对齐。
// 字段名用 camelCase，后端通过 #[serde(rename_all = "camelCase")] 已对齐。
// "pending" 是前端独有状态：占位记录已创建但 claude 进程尚未 spawn 成功。

export type SessionStatus = "pending" | "running" | "exited";

/** 会话类型：claude / powershell / cmd，与后端 ShellKind 对齐。 */
export type SessionKind = "claude" | "powershell" | "cmd";

export interface SessionView {
  id: string;
  name: string;
  cwd: string;
  kind: SessionKind;
  claudeSessionId: string | null;
  pid: number | null;
  status: SessionStatus;
  exitCode: number | null;
}

/** 类型 → 列表/工具栏上的短标签。 */
export const KIND_LABEL: Record<SessionKind, string> = {
  claude: "Claude",
  powershell: "PS",
  cmd: "CMD",
};

/** 类型 → 标签配色（前景/背景）。 */
export const KIND_COLOR: Record<SessionKind, { fg: string; bg: string }> = {
  claude: { fg: "#e8a87c", bg: "#3d2f24" },
  powershell: { fg: "#7db3e8", bg: "#243547" },
  cmd: { fg: "#c8c8c8", bg: "#333333" },
};

/** 后端 `pty://exit` 事件负载。 */
export interface PtyExitPayload {
  sessionId: string;
  exitCode: number;
}

/** 待导入的外部 Claude 会话（来自 ~/.claude/projects 转录扫描）。 */
export interface ExternalSession {
  claudeSessionId: string;
  cwd: string;
  name: string;
  /** 最后活跃时间（unix 秒，取转录文件 mtime）。 */
  lastActive: number;
  sizeBytes: number;
  /** 是否有 claude 进程正开在这个会话/目录上。 */
  active: boolean;
}

/** 目录名 → emoji 的启发式映射。命中规则按关键词包含判断。 */
const EMOJI_RULES: Array<{ keywords: string[]; emoji: string }> = [
  { keywords: ["game", "gameplay", "play"], emoji: "🎮" },
  { keywords: ["back", "server", "api", "service"], emoji: "💻" },
  { keywords: ["front", "web", "ui", "client"], emoji: "🌐" },
  { keywords: ["vending", "shop", "store", "mall"], emoji: "🛒" },
  { keywords: ["mobile", "app", "ios", "android"], emoji: "📱" },
  { keywords: ["ai", "ml", "llm", "model"], emoji: "🤖" },
  { keywords: ["data", "db", "database", "sql"], emoji: "🗄️" },
  { keywords: ["tool", "util", "script"], emoji: "🔧" },
  { keywords: ["doc", "docs", "wiki"], emoji: "📄" },
  { keywords: ["test", "spec"], emoji: "🧪" },
];

/** 根据目录名返回 emoji，未命中返回 null（由调用方降级为首字母彩色块）。 */
export function emojiFor(name: string): string | null {
  const lower = name.toLowerCase();
  for (const rule of EMOJI_RULES) {
    if (rule.keywords.some((k) => lower.includes(k))) {
      return rule.emoji;
    }
  }
  return null;
}

/** 从路径取最后一段作为默认会话名。 */
export function basename(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = clean.lastIndexOf("/");
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}
