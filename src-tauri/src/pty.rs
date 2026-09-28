//! PTY 封装层：只负责 ConPTY 进程与字节流，不涉及业务语义。
//!
//! 使用 portable-pty（WezTerm 作者出品），Windows 下自动走 ConPTY。
//! 关键约束（来自 portable-pty 源码 lib.rs）：
//!   - `take_writer` 文档标注 "It is invalid to take the writer more than once"。
//!     因此 writer 必须在 spawn 前取出一次并缓存，后续写入共用。
//!   - `try_clone_reader` 可多次调用，每次返回新的 reader。
//!     spawn 前取一份交给 reader 线程。
//!   - child 的 `kill`/`wait` 会互相竞争，需通过 `clone_killer` 拆分。
//!     这里采用：waiter 线程持有 child 调 wait；kill 路径用 clone_killer。

use std::io::Read;
use std::sync::Mutex;
use std::thread;

use anyhow::{Context, Result};
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Runtime};

/// 每个会话持有的 PTY 资源句柄。
pub struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    /// 缓存的 writer，spawn 前取出，之后共用。
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    /// 子进程句柄：用于 wait / process_id。
    /// waiter 线程启动时被 take 走；kill 路径用 clone_killer。
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    /// 独立的 killer，可在 child 被 waiter 持有时安全终止。
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    /// 直接子进程 PID。child 被 waiter take 走后 mutex 里读不到了，
    /// 缓存一份供 kill 按树终止与退出事件甄别使用。
    pid: Option<u32>,
}

impl PtyHandle {
    /// 启动一个 claude 进程到给定 cwd 的 PTY 中。
    pub fn spawn(cmd: CommandBuilder, size: PtySize) -> Result<PtyHandle> {
        let pty_system = portable_pty::native_pty_system();
        let pair = pty_system
            .openpty(size)
            .context("openpty 失败（创建 ConPTY 失败）")?;

        // 顺序很重要：先取 writer，再 spawn。reader 在 spawn 后由 start_reader 再 clone 取。
        let writer = pair
            .master
            .take_writer()
            .context("take_writer 失败")?;

        let child = pair
            .slave
            .spawn_command(cmd)
            .context("spawn_command 失败（启动 claude 失败，检查 claude 是否在 PATH 中）")?;

        // slave 在 spawn 后不再需要。
        drop(pair.slave);

        let pid = child.process_id();
        let killer = child.clone_killer();

        Ok(PtyHandle {
            master: pair.master,
            writer: Mutex::new(writer),
            child: Mutex::new(Some(child)),
            killer: Mutex::new(Some(killer)),
            pid,
        })
    }

    /// 写入用户输入到 PTY（前端 → claude）。
    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut guard = self
            .writer
            .lock()
            .map_err(|_| anyhow::anyhow!("writer mutex 中毒"))?;
        guard.write_all(data).context("写入 PTY 失败")?;
        guard.flush().ok();
        Ok(())
    }

    /// 调整终端尺寸。
    pub fn resize(&self, size: PtySize) -> Result<()> {
        self.master.resize(size).context("resize PTY 失败")
    }

    /// 取出子进程的 PID（供前端显示与退出事件甄别）。
    pub fn process_id(&self) -> Option<u32> {
        self.pid
    }

    /// 启动 reader 线程：持续读 PTY 输出，通过 Channel 推给前端。
    pub fn start_reader<R: Runtime>(&self, _app: AppHandle<R>, channel: Channel<Vec<u8>>) {
        // 再 clone 一份 reader 给这个线程。
        let reader = match self.master.try_clone_reader() {
            Ok(r) => r,
            Err(e) => {
                log::error!("reader 线程：try_clone_reader 失败: {e}");
                return;
            }
        };
        thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = buf[..n].to_vec();
                        if channel.send(chunk).is_err() {
                            break; // 前端已关闭 channel
                        }
                    }
                    Err(e) => {
                        log::warn!("PTY reader 读取错误: {e}");
                        break;
                    }
                }
            }
        });
    }

    /// 启动 waiter 线程：等待子进程退出，触发 on_exit 回调。
    /// 回调带上子进程 PID：重启复用同一会话 id，上层靠 pid 甄别
    /// 旧进程的迟到退出事件，避免污染新会话状态。
    pub fn start_waiter<R: Runtime, F>(
        &self,
        app: AppHandle<R>,
        session_id: String,
        on_exit: F,
    ) where
        F: FnOnce(AppHandle<R>, String, Option<u32>, u32) + Send + 'static,
    {
        let mut guard = match self.child.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let mut child = match guard.take() {
            Some(c) => c,
            None => return,
        };
        drop(guard);
        let pid = self.pid;
        thread::spawn(move || {
            let exit_code = match child.wait() {
                Ok(status) => {
                    if status.success() {
                        0
                    } else {
                        status.exit_code()
                    }
                }
                Err(e) => {
                    log::error!("等待子进程退出失败: {e}");
                    1
                }
            };
            on_exit(app, session_id, pid, exit_code);
        });
    }

    /// 终止子进程。
    /// claude 经 `cmd.exe /c` 垫片启动（见 claude.rs），进程树为 ConPTY → cmd.exe → node.exe，
    /// TerminateProcess 只杀直接子进程 cmd.exe，claude 会成孤儿。
    /// Windows 下先用 taskkill /T /F 按树终止，再用 killer 兜底（非 Windows / taskkill 失败）。
    pub fn kill(&self) -> Result<()> {
        if let Some(pid) = self.pid {
            kill_tree(pid);
        }
        if let Ok(mut g) = self.killer.lock() {
            if let Some(mut k) = g.take() {
                if let Err(e) = k.kill() {
                    log::warn!("kill 子进程失败: {e}");
                }
            }
        }
        Ok(())
    }
}

/// Windows 下按进程树强制终止。
#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    // CREATE_NO_WINDOW：GUI 进程里 spawn taskkill 不能闪控制台黑框。
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(not(windows))]
fn kill_tree(_pid: u32) {}

/// 广播会话退出事件到前端。
/// 前端通过 `listen("pty://exit", ...)` 接收。
pub fn emit_exit<R: Runtime>(app: &AppHandle<R>, session_id: &str, exit_code: u32) {
    use serde_json::json;
    let payload = json!({
        "sessionId": session_id,
        "exitCode": exit_code,
    });
    let _ = app.emit("pty://exit", payload);
}
