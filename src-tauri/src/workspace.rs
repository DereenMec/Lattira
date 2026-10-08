//! 工作区：磁盘上的一个普通文件夹
//!
//! ```text
//! 工作区/
//! ├─ .lattira/lattira.db   元数据与索引
//! ├─ .lattira/trash/       删除的画布
//! ├─ projects/<项目>/<画布>.canvas
//! └─ assets/<YYYY-MM>/<原文件名>
//! ```

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::db;
use crate::error::{Error, Result};
use crate::files;

pub const INBOX_NAME: &str = "收件箱";
const INBOX_COLOR: &str = "#2F5D50";

pub struct Workspace {
    pub root: PathBuf,
    pub conn: Connection,
}

#[derive(Default)]
pub struct AppState {
    pub ws: Mutex<Option<Workspace>>,
}

impl AppState {
    /// 在已打开的工作区上执行操作
    pub fn with<T>(&self, f: impl FnOnce(&mut Workspace) -> Result<T>) -> Result<T> {
        let mut guard = self.ws.lock().map_err(|_| Error::Invalid("内部状态异常，请重启栖页".into()))?;
        let ws = guard.as_mut().ok_or(Error::NoWorkspace)?;
        f(ws)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub path: String,
    pub name: String,
    pub is_new: bool,
}

impl Workspace {
    /// 打开（必要时初始化）一个工作区，返回是否为新建
    pub fn open(root: &Path) -> Result<(Self, bool)> {
        if !root.is_dir() {
            return Err(Error::Invalid(format!("文件夹不存在：{}", root.display())));
        }
        let meta_dir = root.join(".lattira");
        let db_path = meta_dir.join("lattira.db");
        let is_new = !db_path.exists();
        fs::create_dir_all(&meta_dir)?;
        fs::create_dir_all(root.join("projects"))?;
        fs::create_dir_all(root.join("assets"))?;

        let ws = Workspace { root: root.to_path_buf(), conn: db::open(&db_path)? };
        ws.ensure_inbox()?;
        Ok((ws, is_new))
    }

    fn ensure_inbox(&self) -> Result<()> {
        let exists: Option<String> =
            self.conn.query_row("SELECT id FROM projects WHERE is_inbox = 1", [], |r| r.get(0)).optional()?;
        if exists.is_none() {
            let now = now_ms();
            fs::create_dir_all(self.root.join("projects").join(INBOX_NAME))?;
            self.conn.execute(
                "INSERT INTO projects (id, name, color, dir, is_inbox, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)",
                params![new_id(), INBOX_NAME, INBOX_COLOR, INBOX_NAME, now],
            )?;
        }
        Ok(())
    }

    pub fn abs(&self, rel: &str) -> PathBuf {
        files::resolve(&self.root, rel)
    }

    pub fn rel(&self, abs: &Path) -> String {
        files::relative(&self.root, abs)
    }

    pub fn info(&self, is_new: bool) -> WorkspaceInfo {
        WorkspaceInfo {
            path: self.root.to_string_lossy().into_owned(),
            name: self.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            is_new,
        }
    }
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

// ---- 应用设置：记住上次打开的工作区 ----

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Settings {
    last_workspace: Option<String>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_config_dir()?.join("settings.json"))
}

pub fn last_workspace(app: &AppHandle) -> Option<PathBuf> {
    let raw = fs::read_to_string(settings_path(app).ok()?).ok()?;
    let s: Settings = serde_json::from_str(&raw).ok()?;
    s.last_workspace.map(PathBuf::from)
}

pub fn remember_workspace(app: &AppHandle, root: &Path) -> Result<()> {
    let s = Settings { last_workspace: Some(root.to_string_lossy().into_owned()) };
    files::write_atomic(&settings_path(app)?, serde_json::to_string_pretty(&s)?.as_bytes())
}
