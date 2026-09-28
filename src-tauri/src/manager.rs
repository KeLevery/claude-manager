//! 会话管理器：运行时状态机 + Tauri 命令处理。
//!
//! 职责：
//! - 维护 `HashMap<Uuid, Session>`
//! - 暴露 Tauri 命令：list / create / write / resize / close / restart
//! - 持久化会话元数据（通过 store）
//! - 进程退出时更新状态 + 广播事件
//!
//! 数据流：
//!   前端 invoke create_session(cwd, name, channel)
//!     → manager 新建 Session，spawn PTY，start_reader(channel) + start_waiter
//!   前端 invoke session_write(id, bytes)
//!   前端 invoke session_resize(id, cols, rows)
//!   前端 invoke session_close(id)  → kill + 从 map 移除（记录保留在 store）
//!   PTY 退出 → waiter 回调 → 更新状态 + emit "pty://exit"

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use anyhow::{Context, Result};
use portable_pty::PtySize;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager as TauriManager, Runtime, State};
use uuid::Uuid;

use crate::claude::{self, ShellKind};
use crate::pty::{emit_exit, PtyHandle};
use crate::store::{SessionRecord, Store};

/// 运行时会话状态。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Running,
    Exited,
}

/// 传给前端的会话视图。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub kind: ShellKind,
    pub claude_session_id: Option<String>,
    pub pid: Option<u32>,
    pub status: SessionStatus,
    pub exit_code: Option<u32>,
}

/// 单个会话的运行时句柄。
pub struct Session {
    pub id: Uuid,
    pub cwd: String,
    pub name: String,
    pub kind: ShellKind,
    pub claude_session_id: Option<String>,
    pub pty: Option<PtyHandle>,
    pub pid: Option<u32>,
    pub status: SessionStatus,
    pub exit_code: Option<u32>,
}

impl Session {
    pub fn view(&self) -> SessionView {
        SessionView {
            id: self.id.to_string(),
            name: self.name.clone(),
            cwd: self.cwd.clone(),
            kind: self.kind,
            claude_session_id: self.claude_session_id.clone(),
            pid: self.pid,
            status: self.status,
            exit_code: self.exit_code,
        }
    }
}

/// 全局会话注册表。Tauri State 持有。
pub struct Manager {
    sessions: Mutex<HashMap<Uuid, Session>>,
    store: Mutex<Store>,
}

impl Manager {
    pub fn new() -> Result<Self> {
        let store = Store::load().unwrap_or_default();
        Ok(Self {
            sessions: Mutex::new(HashMap::new()),
            store: Mutex::new(store),
        })
    }

    /// 列出所有会话视图（合并 store 记录与运行时状态）。
    /// 以 store 记录顺序（即创建顺序）输出，保证侧栏顺序稳定：
    /// HashMap 迭代顺序随机，直接遍历 map 会让列表每次启动都重排。
    /// map 中存在而 store 尚未登记的会话（创建竞态兜底）追加在末尾。
    pub fn list(&self) -> Vec<SessionView> {
        let sessions = self.sessions.lock().unwrap();
        let store = self.store.lock().unwrap();
        let mut views = Vec::with_capacity(sessions.len());
        let mut seen = HashSet::new();
        for rec in &store.sessions {
            seen.insert(rec.id);
            if let Some(s) = sessions.get(&rec.id) {
                views.push(s.view());
            } else {
                views.push(SessionView {
                    id: rec.id.to_string(),
                    name: rec.name.clone(),
                    cwd: rec.cwd.clone(),
                    kind: rec.kind,
                    claude_session_id: rec.claude_session_id.clone(),
                    pid: None,
                    status: SessionStatus::Exited,
                    exit_code: None,
                });
            }
        }
        for s in sessions.values() {
            if !seen.contains(&s.id) {
                views.push(s.view());
            }
        }
        views
    }

/// 创建并启动会话。
/// id: 前端生成的会话 UUID（占位记录与真实记录同 id，避免前端 remount）。
/// kind: 会话类型（claude / powershell / cmd）。
/// claude_session_id: 仅 Claude 类型有意义，Some → resume；None → 新分配。
pub fn create<R: Runtime>(
        &self,
        app: AppHandle<R>,
        id: Option<Uuid>,
        cwd: String,
        name: String,
        kind: ShellKind,
        claude_session_id: Option<String>,
        cols: u16,
        rows: u16,
        channel: Channel<Vec<u8>>,
    ) -> Result<SessionView> {
        // 目录校验：不存在的目录会让子进程直接启动失败，提前给出清晰错误。
        if !std::path::Path::new(&cwd).is_dir() {
            anyhow::bail!("目录不存在: {cwd}");
        }
        // 注意：必须把原始 Option 传给 build_command——
        // None 时走 --session-id 新建分支；若先 resolve 再传 Some，
        // 新会话会错误地 --resume 一个随机 UUID 导致 claude 报错。
        // build_command 同时返回它实际使用的 session-id（None → 新生成的 UUID），
        // 必须用这个返回值落盘/回传前端，否则存的 id 与 claude 真实会话不一致，
        // 重启时 --resume 会找不到会话。
        let (cmd, resolved) = claude::build_command(&cwd, kind, claude_session_id.as_deref())?;
        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pty = PtyHandle::spawn(cmd, size)?;
        let pid = pty.process_id();
        let id = id.unwrap_or_else(Uuid::new_v4);

        let session = Session {
            id,
            cwd: cwd.clone(),
            name: name.clone(),
            kind,
            claude_session_id: resolved.clone(),
            pty: Some(pty),
            pid,
            status: SessionStatus::Running,
            exit_code: None,
        };

        // 启动 reader 与 waiter（在加入 map 后，借用 pty）。
        {
            let mut sessions = self.sessions.lock().unwrap();
            let pty = session.pty.as_ref().expect("刚创建的会话必有 pty");
            pty.start_reader(app.clone(), channel);
            let session_id_str = id.to_string();
            let app_for_exit = app.clone();
            pty.start_waiter(app_for_exit, session_id_str, move |app, sid, exited_pid, code| {
                on_exit(&app, &sid, exited_pid, code);
            });
            sessions.insert(id, session);
        }

        // 持久化：upsert 一条记录。
        {
            let mut store = self.store.lock().unwrap();
            store.sessions.retain(|r| r.id != id);
            store.sessions.push(SessionRecord {
                id,
                cwd: cwd.clone(),
                name: name.clone(),
                kind,
                claude_session_id: resolved.clone(),
            });
            store.active = Some(id);
            let _ = store.save();
        }

        // 广播列表更新
        let _ = app.emit("session://list", self.list());

        self.view_of(id)
    }

    /// 向会话写入字节（前端输入）。
    pub fn write(&self, id: Uuid, data: Vec<u8>) -> Result<()> {
        let sessions = self.sessions.lock().unwrap();
        let s = sessions
            .get(&id)
            .with_context(|| format!("会话不存在: {id}"))?;
        if s.status != SessionStatus::Running {
            anyhow::bail!("会话未在运行: {id}");
        }
        let pty = s.pty.as_ref().context("会话无 pty 句柄")?;
        pty.write(&data)
    }

    /// 调整会话 PTY 尺寸。
    pub fn resize(&self, id: Uuid, cols: u16, rows: u16) -> Result<()> {
        let sessions = self.sessions.lock().unwrap();
        let s = sessions
            .get(&id)
            .with_context(|| format!("会话不存在: {id}"))?;
        let pty = s.pty.as_ref().context("会话无 pty 句柄")?;
        pty.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
    }

    /// 关闭会话：kill 进程并从运行时 map 移除（保留 store 记录以便重启）。
    pub fn close(&self, id: Uuid) -> Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(mut s) = sessions.remove(&id) {
            if let Some(pty) = s.pty.as_ref() {
                let _ = pty.kill();
            }
            s.status = SessionStatus::Exited;
        }
        // store 中保留记录（用于重启）；但 active 若指向它则清空。
        {
            let mut store = self.store.lock().unwrap();
            if store.active == Some(id) {
                store.active = None;
                let _ = store.save();
            }
        }
        Ok(())
    }

    /// 重启会话：前端通过 close + remount TerminalPane（带 claude_session_id resume）实现，
    /// 不需要单独命令。保留 close 即可。

    fn view_of(&self, id: Uuid) -> Result<SessionView> {
        let sessions = self.sessions.lock().unwrap();
        let s = sessions
            .get(&id)
            .with_context(|| format!("创建后会话不在 map 中: {id}"))?;
        Ok(s.view())
    }

    /// 设置激活会话（持久化 active）。
    pub fn set_active(&self, id: Option<Uuid>) -> Result<()> {
        let mut store = self.store.lock().unwrap();
        store.active = id;
        let _ = store.save();
        Ok(())
    }

    /// 从 store 中彻底删除记录（用户在列表里"移除项目"）。
    pub fn remove_record(&self, id: Uuid) -> Result<()> {
        // 若在运行中，先 close
        let _ = self.close(id);
        let mut store = self.store.lock().unwrap();
        store.sessions.retain(|r| r.id != id);
        if store.active == Some(id) {
            store.active = None;
        }
        let _ = store.save();
        Ok(())
    }

    /// 应用启动时：把 store 中的记录恢复为 Exited 状态会话（不自动 spawn）。
    /// 由 lib.rs setup hook 调用，并广播初始列表。
    pub fn restore_list<R: Runtime>(&self, app: &AppHandle<R>) {
        let _ = app.emit("session://list", self.list());
    }

    /// 登记一条会话记录但不启动进程（外部会话导入用）。
    /// 前端随后可选中它并走既有的重启流程（claude --resume 恢复上下文）。
    pub fn register<R: Runtime>(
        &self,
        app: AppHandle<R>,
        id: Uuid,
        cwd: String,
        name: String,
        kind: ShellKind,
        claude_session_id: String,
    ) -> Result<()> {
        if !std::path::Path::new(&cwd).is_dir() {
            anyhow::bail!("目录不存在: {cwd}");
        }
        {
            let mut store = self.store.lock().unwrap();
            store.sessions.retain(|r| r.id != id);
            store.sessions.push(SessionRecord {
                id,
                cwd: cwd.clone(),
                name,
                kind,
                claude_session_id: Some(claude_session_id),
            });
            let _ = store.save();
        }
        let _ = app.emit("session://list", self.list());
        Ok(())
    }

    /// 已纳管的 claude session-id 集合（导入列表过滤用）。
    pub fn managed_claude_ids(&self) -> HashSet<String> {
        let store = self.store.lock().unwrap();
        store
            .sessions
            .iter()
            .filter_map(|r| r.claude_session_id.clone())
            .collect()
    }

    /// 应用关闭时的清理：kill 所有运行中的 PTY。
    /// 不移除 store 记录，保留以便下次恢复列表。
    pub fn cleanup_all(&self) {
        let sessions = self.sessions.lock().unwrap();
        for (_, s) in sessions.iter() {
            if let Some(pty) = s.pty.as_ref() {
                let _ = pty.kill();
            }
        }
    }
}

/// 进程退出回调：更新运行时状态 + 广播。
/// exited_pid 用于甄别"旧一代进程"的迟到退出：重启会复用同一会话 id，
/// 旧进程的 waiter 若在新会话插入后才触发，会把退出码写到新会话上
/// （状态变 exited、write 被拒），pid 对不上则忽略本次事件。
fn on_exit<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    exited_pid: Option<u32>,
    exit_code: u32,
) {
    let id = match Uuid::parse_str(session_id) {
        Ok(u) => u,
        Err(_) => return,
    };
    let manager = match app.try_state::<Manager>() {
        Some(m) => m,
        None => return,
    };
    let stale = {
        let mut sessions = manager.sessions.lock().unwrap();
        match sessions.get_mut(&id) {
            Some(s) => {
                if exited_pid.is_some() && s.pid.is_some() && s.pid != exited_pid {
                    true
                } else {
                    s.status = SessionStatus::Exited;
                    s.exit_code = Some(exit_code);
                    false
                }
            }
            None => false,
        }
    };
    if stale {
        return;
    }
    emit_exit(app, session_id, exit_code);
    let views = manager.list();
    let _ = app.emit("session://list", views);
}

// ===== Tauri 命令 =====

#[tauri::command]
pub fn session_list<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Manager>,
) -> Vec<SessionView> {
    let views = state.list();
    let _ = app.emit("session://list", &views);
    views
}

/// async：ConPTY 创建等重活放到异步运行时执行。
/// 非 async 命令默认跑在主线程，会冻结 UI（Tauri v2 文档明确此行为）。
#[tauri::command]
pub async fn session_create<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Manager>,
    id: Option<String>,
    cwd: String,
    name: String,
    kind: ShellKind,
    claude_session_id: Option<String>,
    cols: u16,
    rows: u16,
    channel: Channel<Vec<u8>>,
) -> Result<SessionView, String> {
    let uid = match id {
        Some(s) => Some(Uuid::parse_str(&s).map_err(|e| e.to_string())?),
        None => None,
    };
    state
        .create(
            app,
            uid,
            cwd,
            name,
            kind,
            claude_session_id,
            cols,
            rows,
            channel,
        )
        .map_err(|e| e.to_string())
}

/// 判断路径是否为目录。拖放创建会话前用它过滤掉文件。
#[tauri::command]
pub fn is_directory(path: String) -> bool {
    std::fs::metadata(&path)
        .map(|m| m.is_dir())
        .unwrap_or(false)
}

/// 导入外部会话：只登记记录，不启动进程。
#[tauri::command]
pub fn session_register<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Manager>,
    id: String,
    cwd: String,
    name: String,
    kind: ShellKind,
    claude_session_id: String,
) -> Result<(), String> {
    let uid = Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    state
        .register(app, uid, cwd, name, kind, claude_session_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_write(
    state: State<'_, Manager>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let uid = Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    state.write(uid, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_resize(
    state: State<'_, Manager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let uid = Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    state.resize(uid, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_close<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Manager>,
    id: String,
) -> Result<(), String> {
    let uid = Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    state.close(uid).map_err(|e| e.to_string())?;
    let _ = app.emit("session://list", state.list());
    Ok(())
}

#[tauri::command]
pub fn session_remove<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Manager>,
    id: String,
) -> Result<(), String> {
    let uid = Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    state.remove_record(uid).map_err(|e| e.to_string())?;
    let _ = app.emit("session://list", state.list());
    Ok(())
}

#[tauri::command]
pub fn session_set_active(
    state: State<'_, Manager>,
    id: Option<String>,
) -> Result<(), String> {
    let uid = match id {
        Some(s) => Some(Uuid::parse_str(&s).map_err(|e| e.to_string())?),
        None => None,
    };
    state.set_active(uid).map_err(|e| e.to_string())
}
