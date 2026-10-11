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

pub const INBOX_NAME: &str = "未分类";
/// 早期版本的名字，打开旧工作区时自动改名
const LEGACY_INBOX_NAME: &str = "收件箱";
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
        let mut guard = self
            .ws
            .lock()
            .map_err(|_| Error::Invalid("内部状态异常，请重启栖页".into()))?;
        let ws = guard.as_mut().ok_or(Error::NoWorkspace)?;
        crate::journal::run(ws, f)
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
        // 拖出文本卡片时生成的临时文件，上次会话留下的直接清掉
        let _ = fs::remove_dir_all(meta_dir.join("tmp"));

        let mut ws = Workspace {
            root: root.to_path_buf(),
            conn: db::open(&db_path)?,
        };
        crate::journal::recover(root, &ws.conn)?;
        let pending: Vec<String> = {
            let mut stmt = ws.conn.prepare("SELECT path FROM pending_files")?;
            let rows = stmt
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            rows
        };
        for path in pending {
            let registered: bool = ws.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM assets WHERE path=?1)",
                [&path],
                |r| r.get(0),
            )?;
            if !registered {
                let _ = fs::remove_file(ws.abs(&path));
            }
            ws.conn
                .execute("DELETE FROM pending_files WHERE path=?1", [path])?;
        }
        ws.ensure_inbox()?;
        // Older releases removed reference records when trashing a canvas.
        let mut stmt = ws
            .conn
            .prepare("SELECT id FROM canvases WHERE deleted_at IS NOT NULL")?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        for id in ids {
            let path = root.join(".lattira/trash").join(format!("{id}.canvas"));
            if let Ok(raw) = fs::read_to_string(&path) {
                if let Ok(mut doc) = serde_json::from_str::<serde_json::Value>(&raw) {
                    crate::journal::run(&mut ws, |ws| {
                        let before = doc.clone();
                        crate::commands::snapshot_assets(ws, &mut doc)?;
                        if doc != before {
                            files::write_atomic(
                                &path,
                                serde_json::to_string_pretty(&doc)?.as_bytes(),
                            )?;
                        }
                        ws.conn
                            .execute("DELETE FROM asset_refs WHERE canvas_id=?1", [&id])?;
                        for node in doc["nodes"].as_array().into_iter().flatten() {
                            if let Some(asset) =
                                node.pointer("/lattira/assetId").and_then(|v| v.as_str())
                            {
                                ws.conn.execute("INSERT OR IGNORE INTO asset_refs(canvas_id,asset_id) VALUES(?1,?2)",params![id,asset])?;
                            }
                        }
                        Ok(())
                    })?;
                }
            }
        }
        Ok((ws, is_new))
    }

    /// 确保存在「未分类」项目；旧工作区里的「收件箱」连同文件夹一起改名
    fn ensure_inbox(&self) -> Result<()> {
        let projects = self.root.join("projects");
        let existing: Option<(String, String, String)> = self
            .conn
            .query_row(
                "SELECT id, name, dir FROM projects WHERE is_inbox = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        match existing {
            None => {
                let dir = files::unique_path(&projects, INBOX_NAME, "", None);
                fs::create_dir_all(&dir)?;
                let dir_name = dir
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned();
                self.conn.execute(
                    "INSERT INTO projects (id, name, color, dir, is_inbox, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)",
                    params![new_id(), INBOX_NAME, INBOX_COLOR, dir_name, now_ms()],
                )?;
            }
            Some((id, name, old_dir)) if name == LEGACY_INBOX_NAME => {
                let old_abs = projects.join(&old_dir);
                let target = files::unique_path(&projects, INBOX_NAME, "", Some(&old_abs));
                if old_abs.exists() {
                    fs::rename(&old_abs, &target)?;
                } else {
                    fs::create_dir_all(&target)?;
                }
                let new_dir = target
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned();
                self.conn.execute(
                    "UPDATE projects SET name = ?2, dir = ?3 WHERE id = ?1",
                    params![id, INBOX_NAME, new_dir],
                )?;
                rewrite_canvas_paths(&self.conn, &id, &old_dir, &new_dir)?;
            }
            Some(_) => {}
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
            name: self
                .root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            is_new,
        }
    }
}

/// 项目文件夹改名后，更新其下画布记录的文件路径
pub fn rewrite_canvas_paths(
    conn: &Connection,
    project_id: &str,
    old_dir: &str,
    new_dir: &str,
) -> Result<()> {
    if old_dir == new_dir {
        return Ok(());
    }
    let (old_prefix, new_prefix) = (
        format!("projects/{old_dir}/"),
        format!("projects/{new_dir}/"),
    );
    conn.execute(
        "UPDATE canvases SET file = ?2 || substr(file, length(?1) + 1) WHERE project_id = ?3 AND substr(file, 1, length(?1)) = ?1",
        params![old_prefix, new_prefix, project_id],
    )?;
    Ok(())
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
    let s = Settings {
        last_workspace: Some(root.to_string_lossy().into_owned()),
    };
    files::write_atomic(
        &settings_path(app)?,
        serde_json::to_string_pretty(&s)?.as_bytes(),
    )
}
