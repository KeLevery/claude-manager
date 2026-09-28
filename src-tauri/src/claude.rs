//! CLI 启动逻辑：claude / PowerShell / cmd 三种会话。
//!
//! claude 取证结论（已在本机验证）：
//! - `where claude` 命中多个路径，含 Volta 的 `claude.cmd` 与 `claude`（无扩展名的 shell 脚本垫片）。
//! - ConPTY 不能直接拉起 `.cmd`/无扩展名垫片；必须经 `cmd.exe /c claude` 间接启动，
//!   由 cmd 负责解析 PATHEXT 找到真正的 `.cmd`。
//! - `claude --help` 确认：`--session-id <uuid>` 指定会话 UUID；`--resume <uuid>` 续接。
//!
//! 因此：claude 首次启动分配新 UUID 并传 `--session-id`；重启/恢复时传 `--resume`。
//! （未使用 `--continue`：它会续接"当前目录最近会话"，可能误接同一目录下其他会话。）
//!
//! PowerShell / cmd 是真实 exe，ConPTY 可直接拉起，无需垫片；
//! 二者没有"会话续接"概念，重启即全新进程，claude_session_id 恒为 None。

use anyhow::Result;
use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 会话类型。serde 小写序列化，与前端 SessionKind 对齐。
/// 旧版 sessions.json 无 kind 字段时反序列化为 Claude（serde default）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellKind {
    Claude,
    PowerShell,
    Cmd,
}

impl Default for ShellKind {
    fn default() -> Self {
        ShellKind::Claude
    }
}

/// 构建各类型会话的启动命令。
/// claude_session_id 仅对 Claude 类型有意义：Some → --resume；None → --session-id 新建。
/// 返回值带上本次启动实际生效的 claude session-id，供落盘与后续 --resume 使用：
/// 必须用这个返回值而不是在别处另行生成，否则存下的 id 与 claude 真实会话对不上，
/// 重启续接必然失败。
pub fn build_command(
    cwd: &str,
    kind: ShellKind,
    claude_session_id: Option<&str>,
) -> Result<(CommandBuilder, Option<String>)> {
    let mut cmd = match kind {
        ShellKind::Claude => {
            // Windows 上经 cmd.exe /c claude 间接启动，避免 ConPTY 直接拉起 .cmd 失败。
            if cfg!(target_os = "windows") {
                let mut c = CommandBuilder::new("cmd.exe");
                c.arg("/c");
                c.arg("claude");
                c
            } else {
                CommandBuilder::new("claude")
            }
        }
        ShellKind::PowerShell => {
            let mut c = CommandBuilder::new("powershell.exe");
            c.arg("-NoLogo");
            c
        }
        ShellKind::Cmd => CommandBuilder::new("cmd.exe"),
    };

    // 工作目录：直接设 cwd，不用 `cd` 命令。
    cmd.cwd(cwd);

    // 会话续接：有 id 则 resume，无则分配新 id 并指定。（仅 Claude 分支会进来）
    let mut session_id = None;
    if let ShellKind::Claude = kind {
        match claude_session_id {
            Some(id) => {
                cmd.arg("--resume");
                cmd.arg(id);
                session_id = Some(id.to_string());
            }
            None => {
                let new_id = Uuid::new_v4().to_string();
                cmd.arg("--session-id");
                cmd.arg(&new_id);
                session_id = Some(new_id);
            }
        }
    }

    // 保留继承环境（PATH 等），不 env_clear。
    Ok((cmd, session_id))
}
