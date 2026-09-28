//! JSON 持久化层：只负责会话元数据的落盘与读取。
//!
//! 存储位置：`app_data_dir` 下的 `sessions.json`。
//! 存储内容：项目目录列表 + 上次激活会话 ID + 各会话的 claude session-id。

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::claude::ShellKind;

/// 单条持久化的会话元数据。
/// 注意：运行时状态（pid、退出码、child 句柄）不落盘，只落盘可重建信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub id: Uuid,
    /// 项目工作目录（spawn 的 cwd）
    pub cwd: String,
    /// 用户可见名称（默认取目录名，可改名）
    pub name: String,
    /// 会话类型。旧版记录无此字段时按 Claude 处理。
    #[serde(default)]
    pub kind: ShellKind,
    /// Claude CLI 自身的 session-id（用于 `--resume <uuid>` 续接）。
    /// 首次启动时为 None；若启动时用 `--session-id` 指定则为该值。
    /// PowerShell / cmd 会话恒为 None（无续接语义）。
    pub claude_session_id: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Store {
    pub sessions: Vec<SessionRecord>,
    pub active: Option<Uuid>,
}

impl Store {
    /// 解析存储文件路径。落在用户级 app data 目录下，目录不存在则创建。
    pub fn path() -> Result<PathBuf> {
        let base = dirs::data_dir()
            .context("无法定位用户数据目录（dirs::data_dir 返回 None）")?;
        let dir = base.join("com.kele.claude-manager");
        if !dir.exists() {
            fs::create_dir_all(&dir)
                .with_context(|| format!("创建数据目录失败: {}", dir.display()))?;
        }
        Ok(dir.join("sessions.json"))
    }

    /// 读取持久化记录。文件不存在视为空 Store。
    pub fn load() -> Result<Store> {
        let path = Self::path()?;
        if !path.exists() {
            return Ok(Store::default());
        }
        let raw = fs::read_to_string(&path)
            .with_context(|| format!("读取 sessions.json 失败: {}", path.display()))?;
        if raw.trim().is_empty() {
            return Ok(Store::default());
        }
        let store: Store = serde_json::from_str(&raw)
            .with_context(|| format!("解析 sessions.json 失败: {}", path.display()))?;
        Ok(store)
    }

    /// 原子写入：先写临时文件再 rename，避免崩溃导致损坏。
    pub fn save(&self) -> Result<()> {
        let path = Self::path()?;
        let tmp = path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(self)
            .context("序列化 sessions.json 失败")?;
        fs::write(&tmp, json)
            .with_context(|| format!("写入临时文件失败: {}", tmp.display()))?;
        fs::rename(&tmp, &path)
            .with_context(|| format!("重命名到 {} 失败", path.display()))?;
        Ok(())
    }
}
