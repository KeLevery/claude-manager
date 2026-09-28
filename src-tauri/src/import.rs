//! 外部 Claude 会话发现与导入。
//!
//! 数据来源：`~/.claude/projects/<项目目录>/<session-uuid>.jsonl`。
//! Claude Code 把每个会话的完整转录存为 jsonl，文件名即 `--resume` 需要的
//! session-id，正文里的 `"cwd"` 字段给出项目目录（目录名本身是有损编码，
//! 不能反推，必须读内容）。
//!
//! 活跃检测（"运行中"标识）：精确到项目目录。
//! 扫描本机 cmd / powershell 等终端进程，读取每个进程的**真实工作目录**
//! （Windows 进程 PEB 的 CurrentDirectory），凡某项目目录正有终端开着，
//! 该项目下所有可导入会话标为"运行中"——能区分出哪些项目是活的。
//! 说明：WMI 的 WorkingDirectory 与 sysinfo 在本机都取不到这些终端进程的 cwd，
//! 故直接读进程 PEB（NtQueryInformationProcess + NtReadVirtualMemory，x64 布局）。
//!
//! 导入 = 在 store 里登记记录（cwd + claude session-id），
//! 用户打开时走既有的 `claude --resume` 流程恢复完整上下文。
//! 注意：原终端若还开着同一会话，两边会各自向前推进（转录分叉），
//! 建议导入后关闭原终端。

use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::Command;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::State;

use crate::manager::Manager;

/// 暴露给前端的待导入会话。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSession {
    pub claude_session_id: String,
    pub cwd: String,
    /// 项目目录名（前端显示与默认会话名）
    pub name: String,
    /// 最后活跃时间（unix 秒，取转录文件 mtime）
    pub last_active: u64,
    pub size_bytes: u64,
    /// 是否有 claude 进程正开在 这个会话/这个目录 上
    pub active: bool,
}

/// async：扫描要起 PowerShell 枚举全部进程并读大量文件（秒级），
/// 非 async 命令默认跑在主线程，会把 UI 卡死。
#[tauri::command]
pub async fn list_external_sessions(
    state: State<'_, Manager>,
) -> Result<Vec<ExternalSession>, String> {
    scan(&state).map_err(|e| e.to_string())
}

fn scan(manager: &Manager) -> anyhow::Result<Vec<ExternalSession>> {
    let home = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("无法定位用户主目录"))?;
    let projects_dir = home.join(".claude").join("projects");
    if !projects_dir.is_dir() {
        return Ok(Vec::new());
    }

    // 已纳管的会话不出现在导入列表里
    let managed = manager.managed_claude_ids();
    // 正有终端开着的目录集合（cmd/powershell 等进程的真实工作目录）
    let live_cwds = live_terminal_cwds();

    let mut out: Vec<ExternalSession> = Vec::new();
    for entry in fs::read_dir(&projects_dir)? {
        let dir = entry?.path();
        if !dir.is_dir() {
            continue;
        }
        for f in fs::read_dir(&dir)? {
            let p = f?.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let sid = match p.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            if managed.contains(&sid) {
                continue;
            }
            let meta = match fs::metadata(&p) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let last_active = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let cwd = match extract_cwd(&p) {
                Some(c) => c,
                None => continue,
            };
            // 项目目录已不存在的不导入（resume 也会失败）
            if !Path::new(&cwd).is_dir() {
                continue;
            }
            // 运行中判定：该项目目录是否正有终端进程开着（cwd 前缀匹配，忽略大小写）
            let active = live_cwds.iter().any(|c| cwd_eq_prefix(c, &cwd));
            out.push(ExternalSession {
                name: basename(&cwd),
                claude_session_id: sid,
                cwd,
                last_active,
                size_bytes: meta.len(),
                active,
            });
        }
    }
    out.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    out.truncate(100);
    Ok(out)
}

/// 从 jsonl 头部块中提取第一个 `"cwd":"..."` 的值（处理 JSON 转义）。
/// cwd 通常出现在前几条消息里，读 64KB 足够；读不到返回 None。
fn extract_cwd(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 64 * 1024];
    let n = file.read(&mut buf).ok()?;
    buf.truncate(n);
    let text = String::from_utf8_lossy(&buf);
    let key = "\"cwd\":\"";
    let start = text.find(key)? + key.len();
    let rest = &text[start..];
    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => break,
            '\\' => match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('r') => out.push('\r'),
                Some(other) => out.push(other),
                None => break,
            },
            other => out.push(other),
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

// ===== Windows 进程真实工作目录（cwd）读取 =====

/// Windows x64 `PROCESS_BASIC_INFORMATION` 布局（NtQueryInformationProcess 类 0）。
#[repr(C)]
struct ProcessBasicInformation {
    _exception_port: usize,
    peb: usize,
    _affinity: usize,
    _base_priority: i32,
    _pad: u32,
    _unique_pid: usize,
    _inherited: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct UnicodeString {
    length: u16,
    _max_length: u16,
    buffer: usize,
}

const PROCESS_VM_READ: u32 = 0x0010;
const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
// PEB 偏移（x64）：ProcessParameters @ 0x20，其内 CurrentDirectory @ 0x38。
const PEB_OFFSET_PROCESS_PARAMS: usize = 0x20;
const PEB_OFFSET_CURRENT_DIR: usize = 0x38;

extern "system" {
    fn OpenProcess(dw: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
    fn CloseHandle(h: *mut std::ffi::c_void) -> i32;
    fn NtQueryInformationProcess(
        h: *mut std::ffi::c_void,
        cls: u32,
        info: *mut std::ffi::c_void,
        len: u32,
        ret: *mut u32,
    ) -> i32;
    fn NtReadVirtualMemory(
        h: *mut std::ffi::c_void,
        base: *const std::ffi::c_void,
        buf: *mut std::ffi::c_void,
        len: u32,
        got: *mut usize,
    ) -> i32;
}

/// 读单个进程的当前工作目录（PEB → CurrentDirectory）。
fn read_process_cwd(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let result = (|| {
            let mut pbi: ProcessBasicInformation = std::mem::zeroed();
            let st = NtQueryInformationProcess(
                h,
                0,
                &mut pbi as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of::<ProcessBasicInformation>() as u32,
                std::ptr::null_mut(),
            );
            if st != 0 {
                return None;
            }
            let peb = pbi.peb;

            // PEB + 0x20 → RTL_USER_PROCESS_PARAMETERS 指针
            let mut pp_bytes = [0u8; 8];
            if !nt_read(h, peb + PEB_OFFSET_PROCESS_PARAMS, &mut pp_bytes) {
                return None;
            }
            let params = u64::from_ne_bytes(pp_bytes) as usize;

            // params + 0x38 → CurrentDirectory (UNICODE_STRING)
            let mut cs_bytes = [0u8; 16];
            if !nt_read(h, params + PEB_OFFSET_CURRENT_DIR, &mut cs_bytes) {
                return None;
            }
            let cs: UnicodeString =
                std::ptr::read_unaligned(cs_bytes.as_ptr() as *const UnicodeString);
            let len = cs.length as usize;
            if len == 0 {
                return None;
            }
            let mut buf = vec![0u8; len];
            if !nt_read(h, cs.buffer, &mut buf) {
                return None;
            }
            let wide: Vec<u16> = buf
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            let s = String::from_utf16_lossy(&wide);
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        })();
        CloseHandle(h);
        result
    }
}

/// NtReadVirtualMemory 便捷封装：全部读到返回 true。
unsafe fn nt_read(h: *mut std::ffi::c_void, addr: usize, buf: &mut [u8]) -> bool {
    let mut got = 0usize;
    let st = NtReadVirtualMemory(
        h,
        addr as *const std::ffi::c_void,
        buf.as_mut_ptr() as *mut std::ffi::c_void,
        buf.len() as u32,
        &mut got,
    );
    st == 0 && got as usize == buf.len()
}

/// 所有"终端类"进程的真实工作目录集合。
///
/// 用 PowerShell 列进程名+PID（命令行/WMI 的 cwd 在本机不可靠），
/// 过滤出 cmd / powershell 及 claude 相关进程，再逐个读 PEB 取 cwd。
/// 读不到的进程（权限/系统进程）跳过。
fn live_terminal_cwds() -> Vec<String> {
    let script = r#"(Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'cmd\.exe|powershell|pwsh|claude|conhost' } | ForEach-Object { $_.ProcessId }) -join ' '"#;
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    set_create_no_window(&mut cmd);
    let out = cmd.output();
    let text = match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        _ => return Vec::new(),
    };
    let mut cwds: Vec<String> = Vec::new();
    for tok in text.split_whitespace() {
        if let Ok(pid) = tok.parse::<u32>() {
            if let Some(cwd) = read_process_cwd(pid) {
                cwds.push(cwd);
            }
        }
    }
    cwds
}

/// GUI 进程（windows_subsystem = "windows"）里 spawn 控制台程序必须带
/// CREATE_NO_WINDOW，否则每次扫描都会闪一个黑色控制台窗口。
#[cfg(windows)]
fn set_create_no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn set_create_no_window(_cmd: &mut Command) {}

/// cwd 前缀匹配（忽略大小写）：terminal cwd 等于 project cwd，或位于其下。
/// 例如 terminal=`E:\proj\claude-manager\`，project=`E:\proj\claude-manager` → 命中。
fn cwd_eq_prefix(terminal_cwd: &str, project_cwd: &str) -> bool {
    let a = terminal_cwd.trim_end_matches(['/', '\\']).to_lowercase();
    let b = project_cwd.trim_end_matches(['/', '\\']).to_lowercase();
    if a == b {
        return true;
    }
    // 终端可能停在项目子目录。前缀之外必须卡在路径分隔符边界上，
    // 否则 E:\proj 会误匹配 E:\project2。
    a.len() > b.len()
        && a.starts_with(&b)
        && (a.as_bytes()[b.len()] == b'\\' || a.as_bytes()[b.len()] == b'/')
}

/// 路径最后一段（兼容 / 与 \）。
fn basename(path: &str) -> String {
    let clean = path.trim_end_matches(['/', '\\']);
    match clean.rsplit(['/', '\\']).next() {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => clean.to_string(),
    }
}
