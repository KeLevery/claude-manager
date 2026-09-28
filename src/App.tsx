import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask } from "@tauri-apps/plugin-dialog";
import { SessionList } from "./components/SessionList";
import { TerminalPane } from "./components/TerminalPane";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { DropPicker } from "./components/DropPicker";
import { ImportDialog } from "./components/ImportDialog";
import {
  basename,
  KIND_COLOR,
  KIND_LABEL,
  type ExternalSession,
  type SessionKind,
  type SessionView,
} from "./types";
import { SquareTerminal, Power } from "lucide-react";
import "./App.css";

/**
 * 应用主控制器。
 *
 * 状态：
 *   sessions: 全部会话列表（pending 占位 + 运行中 + 已退出的历史记录）
 *   activeId: 当前选中显示的会话
 *   remounts: 每个会话的重启计数，bump 使对应 TerminalPane 换 key 重挂载
 *   dialogOpen: 是否显示新建对话框
 *   dropDirs: 拖入的目录列表（非空时显示 DropPicker）
 *   dragActive: 是否有文件夹正在拖入（显示全窗口提示遮罩）
 *
 * 会话 id 全程由前端生成（crypto.randomUUID），session_create 原样沿用：
 * 占位记录与后端真实记录同 id，React key 稳定，终端实例不会中途重挂载。
 *
 * 终端区渲染所有会话的 TerminalPane，非激活的用 visibility 隐藏——
 * 切换会话不销毁 xterm 实例，输出缓冲与 Channel 绑定都保留。
 *
 * 关键交互：
 *   - 新建会话 → 对话框选类型和目录 → 加 pending 占位并选中 → TerminalPane spawn
 *   - 拖放创建 → 从资源管理器把文件夹拖入窗口 → DropPicker 选类型 → 按目录批量建
 *   - 重启会话 → session_close → 状态回 pending → bump remount →
 *     TerminalPane 重挂载后重新 spawn（claude 带 --resume 续接，shell 全新启动）
 *   - 移除项目 → session_remove（运行中则先 kill）
 */
export default function App() {
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [remounts, setRemounts] = useState<Record<string, number>>({});
  const [dialogOpen, setDialogOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [dropDirs, setDropDirs] = useState<string[] | null>(null);
  const [dragActive, setDragActive] = useState(false);

  // 后端列表与本地 pending 占位合并，而不是整体替换：
  // 1. spawn 进行中的占位记录后端尚不知晓，直接替换会让对应终端被卸载、输出丢失；
  // 2. 重启/导入流程中本地刚翻成 pending 的会话，后端还是旧的 exited 记录——
  //    若被 incoming 覆盖，终端会在 spawn 完成前闪一下"会话未运行"遮罩。
  // 因此本地 pending 一律保留，等 create 完成（onSpawned）再翻正状态。
  const mergeSessions = useCallback(
    (incoming: SessionView[]) => {
      setSessions((prev) => {
        const pendingIds = new Set(
          prev.filter((s) => s.status === "pending").map((s) => s.id)
        );
        const pendingLocal = prev.filter(
          (s) => s.status === "pending" && !incoming.some((n) => n.id === s.id)
        );
        const merged = incoming.map((n) => {
          if (!pendingIds.has(n.id)) return n;
          return prev.find((s) => s.id === n.id) ?? n;
        });
        return [...merged, ...pendingLocal];
      });
    },
    []
  );

  // 拉取初始列表
  const refresh = useCallback(async () => {
    const list = await invoke<SessionView[]>("session_list");
    mergeSessions(list);
    // 若当前无激活会话，且列表非空，选第一个
    setActiveId((cur) => cur ?? list[0]?.id ?? null);
  }, [mergeSessions]);

  useEffect(() => {
    refresh();
    // 监听后端广播的列表更新事件
    let un: UnlistenFn | null = null;
    let disposed = false;
    listen<SessionView[]>("session://list", (e) => {
      mergeSessions(e.payload);
    }).then((u) => {
      // 卸载先于 promise resolve 时立即反注册，否则监听器泄漏。
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      if (un) un();
    };
  }, [refresh]);

  // 文件夹拖放：drop 时过滤出目录，弹出 DropPicker 让用户选会话类型。
  useEffect(() => {
    let un: UnlistenFn | null = null;
    let disposed = false;
    getCurrentWebview().onDragDropEvent(async (e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") {
        setDragActive(true);
      } else if (p.type === "leave") {
        setDragActive(false);
      } else if (p.type === "drop") {
        setDragActive(false);
        const dirs: string[] = [];
        for (const path of p.paths) {
          try {
            if (await invoke<boolean>("is_directory", { path })) dirs.push(path);
          } catch {
            // 无法判断的路径跳过
          }
        }
        if (dirs.length > 0) setDropDirs(dirs);
      }
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      if (un) un();
    };
  }, []);

  // 新建：加 pending 占位并选中，由 TerminalPane 触发实际 spawn。
  function handleCreateFromDialog(cwd: string, name: string, kind: SessionKind) {
    const placeholder: SessionView = {
      id: crypto.randomUUID(),
      name,
      cwd,
      kind,
      claudeSessionId: null,
      pid: null,
      status: "pending",
      exitCode: null,
    };
    setSessions((prev) => [...prev, placeholder]);
    setActiveId(placeholder.id);
    setDialogOpen(false);
  }

  // 拖放确认后：按目录批量创建会话，名称默认取目录名。
  function handleDropCreate(dirs: string[], kind: SessionKind) {
    const added = dirs.map((d) => ({
      id: crypto.randomUUID(),
      name: basename(d),
      cwd: d,
      kind,
      claudeSessionId: null,
      pid: null,
      status: "pending" as const,
      exitCode: null,
    }));
    setSessions((prev) => [...prev, ...added]);
    // 激活最后一个拖入的目录
    setActiveId(added[added.length - 1].id);
    setDropDirs(null);
  }

  // 导入外部 Claude 会话：批量登记（不启动进程），然后自动恢复最近的一个。
  // 记录登记后是 exited 状态；把最近一条翻成 pending 并 bump remount，
  // TerminalPane 会带 claudeSessionId 重新 spawn（claude --resume 续接上下文）。
  async function handleImport(list: ExternalSession[]) {
    setImportOpen(false);
    if (list.length === 0) return;
    // 后端已按最后活跃时间倒序，list[0] 即最近
    const registered: Array<{ id: string }> = [];
    for (const s of list) {
      const id = crypto.randomUUID();
      try {
        await invoke("session_register", {
          id,
          cwd: s.cwd,
          name: s.name,
          kind: "claude",
          claudeSessionId: s.claudeSessionId,
        });
        registered.push({ id });
      } catch (e) {
        console.error("导入会话失败:", s.cwd, e);
      }
    }
    if (registered.length === 0) return;
    // 等列表刷新到位后再翻转状态触发 resume
    await refresh();
    const newest = registered[0].id;
    setSessions((prev) =>
      prev.map((s) =>
        s.id === newest
          ? { ...s, status: "pending", pid: null, exitCode: null }
          : s
      )
    );
    setRemounts((m) => ({ ...m, [newest]: (m[newest] ?? 0) + 1 }));
    setActiveId(newest);
  }

  // TerminalPane spawn 成功后回填 claudeSessionId（id 不变）。
  function handleSpawned(sessionId: string, claudeSessionId: string) {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? { ...s, claudeSessionId, status: "running" }
          : s
      )
    );
  }

  // spawn 失败：标记为 exited，用户可点"恢复会话"重试。
  function handleSpawnError(sessionId: string) {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId ? { ...s, status: "exited", pid: null } : s
      )
    );
  }

  function handleExit(sessionId: string, exitCode: number) {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? { ...s, status: "exited", exitCode, pid: null }
          : s
      )
    );
  }

  // 快速清除：一键清空侧边栏会话记录（批量移除，不删除 claude 转录文件）。
  // 保留正在运行的会话（移除会 kill 进程，运行中应显式用"关闭"而非误清）。
  // 若当前激活的被清掉，优先选一条幸存的非运行会话，其次任意运行会话，否则清空选择。
  async function handleClearAll() {
    const runningIds = new Set(sessions.filter((s) => s.status === "running").map((s) => s.id));
    const survivors = sessions.filter((s) => runningIds.has(s.id));
    const toRemove = sessions.filter((s) => !runningIds.has(s.id)).map((s) => s.id);
    if (toRemove.length === 0) return;
    // 误触成本高（记录与 claude_session_id 的关联会丢），先确认。
    const ok = await ask(
      `确定清空 ${toRemove.length} 条非运行会话记录吗？（不影响 Claude 转录文件）`,
      { title: "清空会话列表", kind: "warning", okLabel: "清空", cancelLabel: "取消" }
    );
    if (!ok) return;
    // 并行移除，单条失败不影响其它（忽略错误）。
    await Promise.all(toRemove.map((id) => invoke("session_remove", { id }).catch(() => {})));
    setSessions(survivors);
    setActiveId((cur) => {
      if (cur && runningIds.has(cur)) return cur;
      const fallback = survivors.find((s) => s.status !== "running") ?? survivors[0];
      return fallback ? fallback.id : null;
    });
    refresh();
  }

  // 重启：关闭旧进程（若在运行）→ 状态回 pending → bump remount 让
  // TerminalPane 重挂载并带 claudeSessionId 重新 spawn（--resume 续接）。
  async function handleRestart(id: string) {
    try {
      await invoke("session_close", { id });
    } catch {
      // 忽略：可能已退出
    }
    setSessions((prev) =>
      prev.map((s) =>
        s.id === id
          ? { ...s, status: "pending", pid: null, exitCode: null }
          : s
      )
    );
    setRemounts((m) => ({ ...m, [id]: (m[id] ?? 0) + 1 }));
    setActiveId(id);
  }

  async function handleRemove(id: string) {
    try {
      await invoke("session_remove", { id });
    } catch {
      // 忽略
    }
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setActiveId((cur) => (cur === id ? null : cur));
    refresh();
  }

  async function selectSession(id: string) {
    setActiveId(id);
    try {
      await invoke("session_set_active", { id });
    } catch {
      // 忽略
    }
  }

  const active = sessions.find((s) => s.id === activeId) || null;

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        width: "100vw",
        overflow: "hidden",
        background: "#0c0c0c",
        color: "#e6e6e6",
      }}
    >
      <SessionList
        sessions={sessions}
        activeId={activeId}
        onSelect={selectSession}
        onNew={() => setDialogOpen(true)}
        onImport={() => setImportOpen(true)}
        onRestart={handleRestart}
        onRemove={handleRemove}
        onClearAll={handleClearAll}
      />

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
        }}
      >
        {/* 顶部工具栏 */}
        <div
          style={{
            height: 38,
            minHeight: 38,
            background: "#161616",
            borderBottom: "1px solid #2a2a2a",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 12px",
            fontSize: 12,
            color: "#9aa0a6",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minWidth: 0,
            }}
          >
            <SquareTerminal size={14} />
            <span
              style={{
                fontWeight: 600,
                color: "#e6e6e6",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {active ? active.name : "Claude Manager"}
            </span>
            {active && (
              <span style={{ ...kindChip, ...(KIND_COLOR[active.kind] ?? KIND_COLOR.cmd) }}>
                {KIND_LABEL[active.kind] ?? active.kind}
              </span>
            )}
            {active && (
              <span
                style={{
                  color: "#666",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={active.cwd}
              >
                · {active.cwd}
              </span>
            )}
            {active?.status === "pending" && (
              <span style={{ color: "#e5c07b" }}>· 启动中…</span>
            )}
            {active?.status === "running" && (
              <span style={{ color: "#4ade80" }}>· 运行中</span>
            )}
            {active?.status === "exited" && (
              <span style={{ color: "#888" }}>
                · 已退出{active.exitCode != null ? ` (${active.exitCode})` : ""}
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {active && active.status !== "pending" && (
              <button
                title="关闭会话进程（保留记录）"
                onClick={() =>
                  invoke("session_close", { id: active.id }).then(() => refresh())
                }
                style={toolbarBtn}
              >
                <Power size={13} /> 关闭
              </button>
            )}
          </div>
        </div>

        {/* 终端区：所有会话的 pane 常驻，仅激活的可见（切走不销毁） */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          {sessions.map((s) => (
            <div
              key={`${s.id}:${remounts[s.id] ?? 0}`}
              style={{
                position: "absolute",
                inset: 0,
                visibility: s.id === activeId ? "visible" : "hidden",
              }}
            >
              <TerminalPane
                sessionId={s.id}
                claudeSessionId={s.claudeSessionId}
                cwd={s.cwd}
                name={s.name}
                kind={s.kind}
                status={s.status}
                onSpawned={(csid) => handleSpawned(s.id, csid)}
                onSpawnError={() => handleSpawnError(s.id)}
                onExit={(code) => handleExit(s.id, code)}
                onRestart={() => handleRestart(s.id)}
              />
            </div>
          ))}
          {sessions.length === 0 && <EmptyState onNew={() => setDialogOpen(true)} />}
        </div>
      </div>

      {dialogOpen && (
        <NewSessionDialog
          onClose={() => setDialogOpen(false)}
          onCreate={handleCreateFromDialog}
        />
      )}

      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onImport={handleImport}
        />
      )}

      {dropDirs && (
        <DropPicker
          dirs={dropDirs}
          onClose={() => setDropDirs(null)}
          onCreate={handleDropCreate}
        />
      )}

      {/* 文件夹拖入提示遮罩 */}
      {dragActive && (
        <div
          style={{
            position: "fixed",
            inset: 10,
            border: "2px dashed #4a8af0",
            borderRadius: 12,
            background: "rgba(74,138,240,0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            zIndex: 90,
            color: "#9ec2f5",
            fontSize: 16,
          }}
        >
          松开鼠标，在拖入的目录创建会话
        </div>
      )}
    </div>
  );
}

/** 会话类型小标签（工具栏用）。 */
const kindChip: React.CSSProperties = {
  fontSize: 10,
  lineHeight: 1,
  padding: "3px 6px",
  borderRadius: 4,
  flexShrink: 0,
  fontWeight: 600,
  letterSpacing: 0.5,
};

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        color: "#555",
      }}
    >
      <SquareTerminal size={48} strokeWidth={1.2} />
      <div style={{ fontSize: 14 }}>还没有打开任何 Claude Code 会话</div>
      <button
        onClick={onNew}
        style={{
          background: "#396cd8",
          border: "none",
          borderRadius: 8,
          color: "#fff",
          padding: "10px 20px",
          fontSize: 13,
          cursor: "pointer",
        }}
      >
        新建会话
      </button>
    </div>
  );
}

const toolbarBtn: React.CSSProperties = {
  background: "#262626",
  border: "1px solid #333",
  borderRadius: 5,
  color: "#ccc",
  padding: "4px 10px",
  fontSize: 12,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
};
