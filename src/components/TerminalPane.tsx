import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { RotateCcw } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import type { PtyExitPayload, SessionKind, SessionStatus } from "../types";

interface TerminalPaneProps {
  /** 会话 id。由前端生成（crypto.randomUUID），后端 create 沿用同一 id。 */
  sessionId: string;
  /** 已知的 claude session-id；null 表示新会话（由 claude --session-id 分配）。 */
  claudeSessionId: string | null;
  cwd: string;
  name: string;
  /** 会话类型，决定后端拉起 claude / powershell / cmd。 */
  kind: SessionKind;
  /** 会话当前状态。挂载时为 "pending" 才触发 spawn；"exited" 显示恢复遮罩。 */
  status: SessionStatus;
  /** spawn 成功后回填 claudeSessionId（会话 id 不变，无需回填）。 */
  onSpawned?: (claudeSessionId: string) => void;
  /** spawn 失败：把会话标记为 exited，允许用户重试。 */
  onSpawnError?: (err: string) => void;
  /** 进程退出回调，通知父组件更新状态。 */
  onExit?: (exitCode: number) => void;
  /** 会话未运行时，点击"恢复会话"重新拉起（带 claudeSessionId 续接）。 */
  onRestart?: () => void;
}

/**
 * xterm.js 终端封装。
 *
 * 数据流：
 *   前端输入 → xterm.onData → invoke("session_write", {id, data})
 *   后端输出 → Channel.onmessage → xterm.write(Uint8Array)
 *   后端退出 → listen("pty://exit") → onExit 回调
 *
 * 挂载时若 status === "pending"，则调用 session_create 启动 claude 进程
 * （传前端生成的 id，保证后端记录与本组件的 key 一致，切走再切回不重挂载）。
 *
 * StrictMode 双挂载说明：React 18 开发模式会「挂载→卸载→再挂载」同一实例，
 * refs 跨卸载保留。因此：
 *   - spawnedRef 在 cleanup 中不能重置，否则会 spawn 两次；
 *   - 所有异步回调（channel / 事件监听）必须写 termRef.current，
 *     不能引用闭包里的旧 term 实例（它已被 dispose）。
 */
export function TerminalPane({
  sessionId,
  claudeSessionId,
  cwd,
  name,
  kind,
  status,
  onSpawned,
  onSpawnError,
  onExit,
  onRestart,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // 防止重复 spawn（StrictMode 双挂载 / status 变化导致 effect 重跑）。
  const spawnedRef = useRef(false);

  // 回调经 ref 转发，保证异步回调拿到的是最新闭包。
  const onSpawnedRef = useRef(onSpawned);
  const onSpawnErrorRef = useRef(onSpawnError);
  const onExitRef = useRef(onExit);
  onSpawnedRef.current = onSpawned;
  onSpawnErrorRef.current = onSpawnError;
  onExitRef.current = onExit;

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
      fontSize: 14,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    // 监听该会话的退出事件。写 termRef 而非闭包 term（见组件头注释）。
    let unlistenExit: UnlistenFn | null = null;
    let exitListenerDisposed = false;
    listen<PtyExitPayload>("pty://exit", (e) => {
      if (e.payload.sessionId !== sessionId) return;
      const code = e.payload.exitCode;
      termRef.current?.write(
        `\r\n\x1b[31m[进程已退出，退出码 ${code}]\x1b[0m\r\n`
      );
      onExitRef.current?.(code);
    }).then((u) => {
      // 卸载先于 promise resolve 时立即反注册，否则监听器泄漏
      // （StrictMode 双挂载下每次必漏一个）。
      if (exitListenerDisposed) u();
      else unlistenExit = u;
    });

    // ResizeObserver 同步 fit + 通知后端 PTY 尺寸。
    const ro = new ResizeObserver(() => {
      try {
        fitRef.current?.fit();
        const t = termRef.current;
        if (t && spawnedRef.current) {
          invoke("session_resize", { id: sessionId, cols: t.cols, rows: t.rows }).catch(
            () => {}
          );
        }
      } catch {
        // 容器不可见/未布局时 fit 会抛错，忽略。
      }
    });
    ro.observe(containerRef.current);

    // 输入：xterm.onData 给出字符串（已处理控制字符），编码为 UTF-8 字节回传后端。
    const inputDisp = term.onData((data) => {
      if (!spawnedRef.current) return;
      const bytes = new TextEncoder().encode(data);
      invoke("session_write", { id: sessionId, data: Array.from(bytes) }).catch(
        () => {}
      );
    });

    // 仅当挂载时即为 pending（新建占位 / 重启）才 spawn。
    // spawn 过一次后 spawnedRef 置位，status 变化不再触发。
    if (status === "pending" && !spawnedRef.current) {
      spawnedRef.current = true;
      // 后端 Vec<u8> 经 Channel 以 JSON 数组到达，写入前包成 Uint8Array。
      const channel = new Channel<number[]>();
      channel.onmessage = (data) => {
        termRef.current?.write(new Uint8Array(data));
      };
      invoke<{ id: string; claudeSessionId: string | null }>("session_create", {
        id: sessionId,
        cwd,
        name,
        kind,
        claudeSessionId: claudeSessionId ?? null,
        cols: termRef.current?.cols ?? 80,
        rows: termRef.current?.rows ?? 24,
        channel,
      })
        .then((view) => {
          if (view.claudeSessionId) {
            onSpawnedRef.current?.(view.claudeSessionId);
          }
        })
        .catch((err) => {
          termRef.current?.write(
            `\r\n\x1b[31m[启动 claude 失败: ${String(err)}]\x1b[0m\r\n`
          );
          onSpawnErrorRef.current?.(String(err));
        });
    }

    // 清理。注意：不重置 spawnedRef（见组件头注释）。
    return () => {
      inputDisp.dispose();
      ro.disconnect();
      exitListenerDisposed = true;
      if (unlistenExit) unlistenExit();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: "#0c0c0c",
      }}
    >
      <div
        ref={containerRef}
        style={{
          position: "absolute",
          inset: 0,
          padding: "6px",
          boxSizing: "border-box",
          overflow: "hidden",
        }}
      />
      {/* 已退出的会话：半透明提示 + 恢复按钮，不遮挡滚动回看历史输出。 */}
      {status === "exited" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              pointerEvents: "auto",
              display: "flex",
              alignItems: "center",
              gap: 12,
              background: "rgba(20,20,20,0.92)",
              border: "1px solid #333",
              borderRadius: 8,
              padding: "10px 16px",
              color: "#9aa0a6",
              fontSize: 13,
            }}
          >
            会话未运行
            <button onClick={onRestart} style={restartBtn}>
              <RotateCcw size={13} /> 恢复会话
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const restartBtn: React.CSSProperties = {
  background: "#262626",
  border: "1px solid #3a3a3a",
  borderRadius: 5,
  color: "#ccc",
  padding: "4px 10px",
  fontSize: 12,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
};
