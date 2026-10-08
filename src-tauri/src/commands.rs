//! 前端调用的全部命令，对应 src/services/tauriBackend.ts
//!
//! 命令都声明为 async，让 Tauri 在线程池上执行，避免导入大文件时卡住界面。

use std::collections::HashSet;
use std::fs;
use std::io::{BufReader, Read};
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::clipboard;
use crate::error::{Error, Result};
use crate::files;
use crate::ocr;
use crate::workspace::{self, new_id, now_ms, AppState, Workspace, WorkspaceInfo};

// ---------------------------------------------------------------------------
// 数据结构（字段名与 src/types/model.ts 一致）
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    id: String,
    name: String,
    color: String,
    icon: Option<String>,
    is_inbox: bool,
    pinned: bool,
    archived: bool,
    created_at: i64,
    updated_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatch {
    name: Option<String>,
    color: Option<String>,
    icon: Option<String>,
    pinned: Option<bool>,
    archived: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasMeta {
    id: String,
    project_id: String,
    title: String,
    element_count: i64,
    created_at: i64,
    updated_at: i64,
    /// 缩略图用的精简布局（JSON 字符串），由前端在保存时生成
    preview: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasPatch {
    title: Option<String>,
    project_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    id: String,
    hash: String,
    path: String,
    name: String,
    mime: String,
    size: i64,
    width: Option<i64>,
    height: Option<i64>,
    imported_at: i64,
    /// 图片中识别出的文字；None 表示尚未识别或不适用
    ocr_text: Option<String>,
    ref_count: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedText {
    element_id: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasIndex {
    element_count: i64,
    texts: Vec<IndexedText>,
    asset_ids: Vec<String>,
    preview: Option<String>,
}

#[derive(Deserialize)]
pub struct ChangeSummary {
    added: i64,
    modified: i64,
    removed: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasDay {
    canvas_id: String,
    date: String,
    change_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    kind: &'static str,
    canvas_id: String,
    canvas_title: String,
    project_id: String,
    element_id: Option<String>,
    /// 命中的是文件或图片时，前端据此在画布上找到对应卡片
    asset_id: Option<String>,
    snippet: String,
}

// ---------------------------------------------------------------------------
// 查询辅助
// ---------------------------------------------------------------------------

const PROJECT_COLS: &str = "id, name, color, is_inbox, pinned, archived, created_at, updated_at, icon";
const CANVAS_COLS: &str = "id, project_id, title, element_count, created_at, updated_at, preview";
const ASSET_SELECT: &str = "SELECT a.id, a.hash, a.path, a.name, a.mime, a.size, a.width, a.height, a.imported_at, a.ocr_text,
    (SELECT COUNT(*) FROM asset_refs r JOIN canvases c ON c.id = r.canvas_id
      WHERE r.asset_id = a.id AND c.deleted_at IS NULL)
  FROM assets a";

fn project_row(r: &Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: r.get(0)?,
        name: r.get(1)?,
        color: r.get(2)?,
        is_inbox: r.get(3)?,
        pinned: r.get(4)?,
        archived: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        icon: r.get(8)?,
    })
}

fn canvas_row(r: &Row) -> rusqlite::Result<CanvasMeta> {
    Ok(CanvasMeta {
        id: r.get(0)?,
        project_id: r.get(1)?,
        title: r.get(2)?,
        element_count: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
        preview: r.get(6)?,
    })
}

fn asset_row(r: &Row) -> rusqlite::Result<Asset> {
    Ok(Asset {
        id: r.get(0)?,
        hash: r.get(1)?,
        path: r.get(2)?,
        name: r.get(3)?,
        mime: r.get(4)?,
        size: r.get(5)?,
        width: r.get(6)?,
        height: r.get(7)?,
        imported_at: r.get(8)?,
        ocr_text: r.get(9)?,
        ref_count: r.get(10)?,
    })
}

fn get_project(conn: &Connection, id: &str) -> Result<Project> {
    conn.query_row(&format!("SELECT {PROJECT_COLS} FROM projects WHERE id = ?1"), [id], project_row)
        .optional()?
        .ok_or_else(|| Error::NotFound("项目", id.into()))
}

fn project_dir(conn: &Connection, id: &str) -> Result<String> {
    conn.query_row("SELECT dir FROM projects WHERE id = ?1", [id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| Error::NotFound("项目", id.into()))
}

fn get_canvas(conn: &Connection, id: &str) -> Result<CanvasMeta> {
    conn.query_row(
        &format!("SELECT {CANVAS_COLS} FROM canvases WHERE id = ?1 AND deleted_at IS NULL"),
        [id],
        canvas_row,
    )
    .optional()?
    .ok_or_else(|| Error::NotFound("画布", id.into()))
}

fn canvas_file(conn: &Connection, id: &str) -> Result<String> {
    conn.query_row("SELECT file FROM canvases WHERE id = ?1 AND deleted_at IS NULL", [id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| Error::NotFound("画布", id.into()))
}

fn get_asset(conn: &Connection, filter: &str, value: &str) -> Result<Option<Asset>> {
    Ok(conn.query_row(&format!("{ASSET_SELECT} WHERE a.{filter} = ?1"), [value], asset_row).optional()?)
}

// ---------------------------------------------------------------------------
// 工作区
// ---------------------------------------------------------------------------

fn open_at(app: &AppHandle, state: &AppState, root: &Path) -> Result<WorkspaceInfo> {
    let (ws, is_new) = Workspace::open(root)?;
    // 允许前端通过 asset:// 协议读取工作区内的图片
    app.asset_protocol_scope().allow_directory(&ws.root, true)?;
    workspace::remember_workspace(app, &ws.root)?;
    // 补做之前没识别完的图片
    ocr::schedule(app.clone(), ws.root.clone());
    let info = ws.info(is_new);
    *state.ws.lock().map_err(|_| Error::Invalid("内部状态异常，请重启栖页".into()))? = Some(ws);
    Ok(info)
}

#[tauri::command]
pub async fn restore_workspace(app: AppHandle, state: State<'_, AppState>) -> Result<Option<WorkspaceInfo>> {
    match workspace::last_workspace(&app) {
        Some(root) if root.is_dir() => open_at(&app, &state, &root).map(Some),
        _ => Ok(None),
    }
}

#[tauri::command]
pub async fn open_workspace(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<WorkspaceInfo> {
    open_at(&app, &state, Path::new(&path))
}

// ---------------------------------------------------------------------------
// 项目
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_projects(state: State<'_, AppState>) -> Result<Vec<Project>> {
    state.with(|ws| {
        let mut stmt =
            ws.conn.prepare(&format!("SELECT {PROJECT_COLS} FROM projects ORDER BY is_inbox DESC, created_at"))?;
        let rows = stmt.query_map([], project_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

#[tauri::command]
pub async fn create_project(state: State<'_, AppState>, name: String, color: String) -> Result<Project> {
    state.with(|ws| {
        let name = name.trim();
        if name.is_empty() {
            return Err(Error::Invalid("项目名称不能为空".into()));
        }
        let dir = files::unique_path(&ws.root.join("projects"), &files::sanitize(name), "", None);
        fs::create_dir_all(&dir)?;
        let dir_name = dir.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let id = new_id();
        let now = now_ms();
        ws.conn.execute(
            "INSERT INTO projects (id, name, color, dir, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, name, color, dir_name, now],
        )?;
        get_project(&ws.conn, &id)
    })
}

#[tauri::command]
pub async fn update_project(state: State<'_, AppState>, id: String, patch: ProjectPatch) -> Result<Project> {
    state.with(|ws| {
        let current = get_project(&ws.conn, &id)?;
        let old_dir = project_dir(&ws.conn, &id)?;
        let mut new_dir = old_dir.clone();

        if current.is_inbox && (patch.name.is_some() || patch.archived == Some(true)) {
            return Err(Error::Invalid("收件箱不能重命名或归档".into()));
        }
        if let Some(name) = patch.name.as_deref().map(str::trim).filter(|n| !n.is_empty() && *n != current.name) {
            let projects = ws.root.join("projects");
            let old_abs = projects.join(&old_dir);
            let target = files::unique_path(&projects, &files::sanitize(name), "", Some(&old_abs));
            if target != old_abs {
                fs::rename(&old_abs, &target)?;
                new_dir = target.file_name().unwrap_or_default().to_string_lossy().into_owned();
            }
        }

        let tx = ws.conn.transaction()?;
        tx.execute(
            "UPDATE projects SET name = COALESCE(?2, name), color = COALESCE(?3, color), pinned = COALESCE(?4, pinned),
               archived = COALESCE(?5, archived), dir = ?6, updated_at = ?7, icon = COALESCE(?8, icon) WHERE id = ?1",
            params![
                id,
                patch.name.as_deref().map(str::trim).filter(|n| !n.is_empty()),
                patch.color,
                patch.pinned,
                patch.archived,
                new_dir,
                now_ms(),
                patch.icon,
            ],
        )?;
        workspace::rewrite_canvas_paths(&tx, &id, &old_dir, &new_dir)?;
        tx.commit()?;
        get_project(&ws.conn, &id)
    })
}

// ---------------------------------------------------------------------------
// 画布
// ---------------------------------------------------------------------------

const EMPTY_CANVAS: &str = "{\n  \"nodes\": [],\n  \"edges\": []\n}\n";

#[tauri::command]
pub async fn list_canvases(state: State<'_, AppState>) -> Result<Vec<CanvasMeta>> {
    state.with(|ws| {
        let mut stmt = ws
            .conn
            .prepare(&format!("SELECT {CANVAS_COLS} FROM canvases WHERE deleted_at IS NULL ORDER BY updated_at DESC"))?;
        let rows = stmt.query_map([], canvas_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

#[tauri::command]
pub async fn create_canvas(state: State<'_, AppState>, project_id: String, title: String) -> Result<CanvasMeta> {
    state.with(|ws| {
        let title = title.trim();
        let title = if title.is_empty() { "未命名画布" } else { title };
        let dir = ws.root.join("projects").join(project_dir(&ws.conn, &project_id)?);
        fs::create_dir_all(&dir)?;
        let path = files::unique_path(&dir, &files::sanitize(title), "canvas", None);
        files::write_atomic(&path, EMPTY_CANVAS.as_bytes())?;
        let id = new_id();
        let now = now_ms();
        ws.conn.execute(
            "INSERT INTO canvases (id, project_id, title, file, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, project_id, title, ws.rel(&path), now],
        )?;
        get_canvas(&ws.conn, &id)
    })
}

/// 改名或移动到其他项目：画布文件跟着改名 / 移动
#[tauri::command]
pub async fn update_canvas(state: State<'_, AppState>, id: String, patch: CanvasPatch) -> Result<CanvasMeta> {
    state.with(|ws| {
        let current = get_canvas(&ws.conn, &id)?;
        let old_abs = ws.abs(&canvas_file(&ws.conn, &id)?);
        let title = patch.title.as_deref().map(str::trim).filter(|t| !t.is_empty()).unwrap_or(&current.title).to_string();
        let project_id = patch.project_id.unwrap_or(current.project_id.clone());

        let mut file_abs = old_abs.clone();
        if title != current.title || project_id != current.project_id {
            let dir = ws.root.join("projects").join(project_dir(&ws.conn, &project_id)?);
            fs::create_dir_all(&dir)?;
            file_abs = files::unique_path(&dir, &files::sanitize(&title), "canvas", Some(&old_abs));
            if file_abs != old_abs {
                fs::rename(&old_abs, &file_abs)?;
            }
        }
        ws.conn.execute(
            "UPDATE canvases SET title = ?2, project_id = ?3, file = ?4 WHERE id = ?1",
            params![id, title, project_id, ws.rel(&file_abs)],
        )?;
        get_canvas(&ws.conn, &id)
    })
}

/// 删除画布：文件移到 .lattira/trash/，元数据标记删除（日后可做回收站恢复）
#[tauri::command]
pub async fn delete_canvas(state: State<'_, AppState>, id: String) -> Result<()> {
    state.with(|ws| {
        let file = ws.abs(&canvas_file(&ws.conn, &id)?);
        let trash = ws.root.join(".lattira").join("trash");
        fs::create_dir_all(&trash)?;
        if file.exists() {
            fs::rename(&file, trash.join(format!("{id}.canvas")))?;
        }
        let tx = ws.conn.transaction()?;
        tx.execute("UPDATE canvases SET deleted_at = ?2 WHERE id = ?1", params![id, now_ms()])?;
        tx.execute("DELETE FROM asset_refs WHERE canvas_id = ?1", [&id])?;
        tx.execute("DELETE FROM element_text WHERE canvas_id = ?1", [&id])?;
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub async fn load_canvas(state: State<'_, AppState>, id: String) -> Result<String> {
    state.with(|ws| {
        let path = ws.abs(&canvas_file(&ws.conn, &id)?);
        fs::read_to_string(&path).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => Error::NotFound("画布文件", path.display().to_string()),
            _ => e.into(),
        })
    })
}

/// 写画布文件，并更新搜索索引、资源引用；有实际变化时记入日历
#[tauri::command]
pub async fn save_canvas(
    state: State<'_, AppState>,
    id: String,
    content: String,
    index: CanvasIndex,
    changes: ChangeSummary,
) -> Result<CanvasMeta> {
    state.with(|ws| {
        let path = ws.abs(&canvas_file(&ws.conn, &id)?);
        files::write_atomic(&path, content.as_bytes())?;

        let now = now_ms();
        let total = changes.added + changes.modified + changes.removed;
        let tx = ws.conn.transaction()?;
        tx.execute(
            "UPDATE canvases SET element_count = ?2, preview = ?3 WHERE id = ?1",
            params![id, index.element_count, index.preview],
        )?;
        if total > 0 {
            tx.execute("UPDATE canvases SET updated_at = ?2 WHERE id = ?1", params![id, now])?;
            tx.execute(
                "INSERT INTO edit_events (id, canvas_id, at, added, modified, removed) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![new_id(), id, now, changes.added, changes.modified, changes.removed],
            )?;
            let today = chrono::Local::now().format("%Y-%m-%d").to_string();
            tx.execute(
                "INSERT INTO canvas_days (canvas_id, date, change_count) VALUES (?1, ?2, ?3)
                 ON CONFLICT (canvas_id, date) DO UPDATE SET change_count = change_count + excluded.change_count",
                params![id, today, total],
            )?;
        }

        tx.execute("DELETE FROM element_text WHERE canvas_id = ?1", [&id])?;
        {
            let mut stmt =
                tx.prepare("INSERT OR REPLACE INTO element_text (canvas_id, element_id, text) VALUES (?1, ?2, ?3)")?;
            for t in &index.texts {
                stmt.execute(params![id, t.element_id, t.text])?;
            }
            tx.execute("DELETE FROM asset_refs WHERE canvas_id = ?1", [&id])?;
            let mut stmt = tx.prepare("INSERT OR IGNORE INTO asset_refs (canvas_id, asset_id) VALUES (?1, ?2)")?;
            for asset_id in &index.asset_ids {
                stmt.execute(params![id, asset_id])?;
            }
        }
        tx.commit()?;
        get_canvas(&ws.conn, &id)
    })
}

// ---------------------------------------------------------------------------
// 资源（导入的文件与图片）
// ---------------------------------------------------------------------------

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash_file(path: &Path) -> Result<String> {
    let mut reader = BufReader::new(fs::File::open(path)?);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

/// 为新文件在 assets/<YYYY-MM>/ 下分配一个不冲突的路径
fn asset_destination(ws: &Workspace, name: &str) -> Result<std::path::PathBuf> {
    let dir = ws.root.join("assets").join(chrono::Local::now().format("%Y-%m").to_string());
    fs::create_dir_all(&dir)?;
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "文件".into());
    let ext = p.extension().map(|s| files::sanitize(&s.to_string_lossy())).unwrap_or_default();
    Ok(files::unique_path(&dir, &files::sanitize(&stem), &ext, None))
}

fn register_asset(ws: &Workspace, hash: &str, dest: &Path, name: &str) -> Result<Asset> {
    let mime = mime_guess::from_path(name).first_or_octet_stream().essence_str().to_string();
    let size = fs::metadata(dest)?.len() as i64;
    let (width, height) = if mime.starts_with("image/") {
        imagesize::size(dest).map(|s| (Some(s.width as i64), Some(s.height as i64))).unwrap_or((None, None))
    } else {
        (None, None)
    };
    let id = new_id();
    ws.conn.execute(
        "INSERT INTO assets (id, hash, path, name, mime, size, width, height, imported_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![id, hash, ws.rel(dest), name, mime, size, width, height, now_ms()],
    )?;
    get_asset(&ws.conn, "id", &id)?.ok_or_else(|| Error::NotFound("资源", id))
}

/// 复制一个外部文件进工作区；内容相同的文件只存一份
fn import_file(ws: &Workspace, src: &Path) -> Result<Asset> {
    if !src.is_file() {
        return Err(Error::Invalid(format!("暂不支持导入文件夹：{}", src.display())));
    }
    let hash = hash_file(src)?;
    if let Some(existing) = get_asset(&ws.conn, "hash", &hash)? {
        return Ok(existing);
    }
    let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "文件".into());
    let dest = asset_destination(ws, &name)?;
    fs::copy(src, &dest)?;
    register_asset(ws, &hash, &dest, &name)
}

/// 导入结果的一项：文件，或文件夹（带着里面的文件和子文件夹）
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImportNode {
    File { asset: Asset },
    Folder { name: String, children: Vec<ImportNode> },
}

/// 一次导入最多的文件数，防止误拖整个磁盘
const MAX_IMPORT_FILES: usize = 1000;

fn skip_entry(name: &str) -> bool {
    name.starts_with('.') || name.eq_ignore_ascii_case("thumbs.db") || name.eq_ignore_ascii_case("desktop.ini")
}

fn count_files(path: &Path, total: &mut usize) -> Result<()> {
    if path.is_file() {
        *total += 1;
    } else if path.is_dir() {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            if !skip_entry(&entry.file_name().to_string_lossy()) {
                count_files(&entry.path(), total)?;
            }
            if *total > MAX_IMPORT_FILES {
                break;
            }
        }
    }
    Ok(())
}

/// 文件夹内：文件在前、子文件夹在后，各自按名称排序
fn import_node(ws: &Workspace, path: &Path) -> Result<ImportNode> {
    if path.is_file() {
        return Ok(ImportNode::File { asset: import_file(ws, path)? });
    }
    let mut entries: Vec<_> = fs::read_dir(path)?
        .filter_map(|e| e.ok())
        .filter(|e| !skip_entry(&e.file_name().to_string_lossy()))
        .map(|e| e.path())
        .collect();
    entries.sort_by_key(|p| (p.is_dir(), p.file_name().map(|n| n.to_string_lossy().to_lowercase())));
    let children = entries.iter().map(|p| import_node(ws, p)).collect::<Result<Vec<_>>>()?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(ImportNode::Folder { name, children })
}

/// 导入文件和文件夹，保留文件夹结构
#[tauri::command]
pub async fn import_tree(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>) -> Result<Vec<ImportNode>> {
    let mut total = 0;
    for p in &paths {
        count_files(Path::new(p), &mut total)?;
    }
    if total > MAX_IMPORT_FILES {
        return Err(Error::Invalid(format!("一次最多导入 {MAX_IMPORT_FILES} 个文件，请分批导入")));
    }
    let (nodes, root) = state.with(|ws| {
        let nodes = paths.iter().map(|p| import_node(ws, Path::new(p))).collect::<Result<Vec<_>>>()?;
        Ok((nodes, ws.root.clone()))
    })?;
    ocr::schedule(app, root);
    Ok(nodes)
}

#[tauri::command]
pub async fn import_paths(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>) -> Result<Vec<Asset>> {
    let (assets, root) = state.with(|ws| {
        let assets = paths.iter().map(|p| import_file(ws, Path::new(p))).collect::<Result<Vec<_>>>()?;
        Ok((assets, ws.root.clone()))
    })?;
    ocr::schedule(app, root);
    Ok(assets)
}

/// 导入剪贴板里的图片等内存数据
#[tauri::command]
pub async fn import_bytes(app: AppHandle, state: State<'_, AppState>, name: String, bytes: Vec<u8>) -> Result<Asset> {
    let (asset, root) = state.with(|ws| {
        let hash = hex(&Sha256::digest(&bytes));
        if let Some(existing) = get_asset(&ws.conn, "hash", &hash)? {
            return Ok((existing, ws.root.clone()));
        }
        let dest = asset_destination(ws, &name)?;
        files::write_atomic(&dest, &bytes)?;
        Ok((register_asset(ws, &hash, &dest, &name)?, ws.root.clone()))
    })?;
    ocr::schedule(app, root);
    Ok(asset)
}

#[tauri::command]
pub async fn list_assets(state: State<'_, AppState>) -> Result<Vec<Asset>> {
    state.with(|ws| {
        let mut stmt = ws.conn.prepare(&format!("{ASSET_SELECT} ORDER BY a.imported_at DESC"))?;
        let rows = stmt.query_map([], asset_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

#[tauri::command]
pub async fn open_asset(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<()> {
    let path = state.with(|ws| {
        let asset = get_asset(&ws.conn, "id", &id)?.ok_or_else(|| Error::NotFound("资源", id.clone()))?;
        Ok(ws.abs(&asset.path))
    })?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| Error::Invalid(format!("无法打开文件：{e}")))
}

// ---------------------------------------------------------------------------
// 资源管理器与对外拖放
// ---------------------------------------------------------------------------

fn reveal(app: &AppHandle, path: &Path) -> Result<()> {
    app.opener().reveal_item_in_dir(path).map_err(|e| Error::Invalid(format!("无法在资源管理器中显示：{e}")))
}

/// 在资源管理器中显示并选中文件
#[tauri::command]
pub async fn reveal_asset(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<()> {
    let path = state.with(|ws| {
        let asset = get_asset(&ws.conn, "id", &id)?.ok_or_else(|| Error::NotFound("资源", id.clone()))?;
        Ok(ws.abs(&asset.path))
    })?;
    reveal(&app, &path)
}

#[tauri::command]
pub async fn reveal_canvas(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<()> {
    let path = state.with(|ws| Ok(ws.abs(&canvas_file(&ws.conn, &id)?)))?;
    reveal(&app, &path)
}

/// 打开工作区根文件夹
#[tauri::command]
pub async fn reveal_workspace(app: AppHandle, state: State<'_, AppState>) -> Result<()> {
    let path = state.with(|ws| Ok(ws.root.clone()))?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| Error::Invalid(format!("无法打开文件夹：{e}")))
}

/// 打开项目对应的文件夹
#[tauri::command]
pub async fn reveal_project(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<()> {
    let path = state.with(|ws| Ok(ws.root.join("projects").join(project_dir(&ws.conn, &id)?)))?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| Error::Invalid(format!("无法打开文件夹：{e}")))
}

/// 把资源另存一份到用户选择的位置
#[tauri::command]
pub async fn copy_asset_to(state: State<'_, AppState>, id: String, dest: String) -> Result<()> {
    state.with(|ws| {
        let asset = get_asset(&ws.conn, "id", &id)?.ok_or_else(|| Error::NotFound("资源", id.clone()))?;
        fs::copy(ws.abs(&asset.path), &dest)?;
        Ok(())
    })
}

/// 重命名资源：磁盘上的文件跟着改名；没写扩展名时沿用原扩展名
#[tauri::command]
pub async fn rename_asset(state: State<'_, AppState>, id: String, name: String) -> Result<Asset> {
    state.with(|ws| rename_asset_in(ws, &id, &name))
}

fn rename_asset_in(ws: &Workspace, id: &str, name: &str) -> Result<Asset> {
    let asset = get_asset(&ws.conn, "id", id)?.ok_or_else(|| Error::NotFound("资源", id.into()))?;
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::Invalid("文件名不能为空".into()));
    }
    let wanted = Path::new(name);
    let old_ext = Path::new(&asset.name).extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
    let (stem, ext) = match wanted.extension() {
        Some(ext) => (
            wanted.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
            ext.to_string_lossy().into_owned(),
        ),
        None => (name.to_string(), old_ext),
    };

    let old_abs = ws.abs(&asset.path);
    let dir = old_abs.parent().map(Path::to_path_buf).unwrap_or_else(|| ws.root.join("assets"));
    let target = files::unique_path(&dir, &files::sanitize(&stem), &files::sanitize(&ext), Some(&old_abs));
    if target != old_abs {
        fs::rename(&old_abs, &target)?;
    }
    let file_name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let rel = ws.rel(&target);
    let mime = mime_guess::from_path(&file_name).first_or_octet_stream().essence_str().to_string();
    ws.conn.execute(
        "UPDATE assets SET name = ?2, path = ?3, mime = ?4 WHERE id = ?1",
        params![id, file_name, rel, mime],
    )?;

    // 画布文件里的 file 字段供 Obsidian 等工具使用，一并更新
    let mut stmt = ws.conn.prepare("SELECT canvas_id FROM asset_refs WHERE asset_id = ?1")?;
    let canvases = stmt.query_map([id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for canvas_id in canvases {
        let Ok(file) = canvas_file(&ws.conn, &canvas_id) else { continue };
        if let Err(e) = set_node_file(&ws.abs(&file), id, &rel) {
            eprintln!("[rename_asset] 跳过画布 {canvas_id}：{e}");
        }
    }
    get_asset(&ws.conn, "id", id)?.ok_or_else(|| Error::NotFound("资源", id.into()))
}

/// 把画布文件中引用某资源的节点的 file 字段改成新路径
fn set_node_file(path: &Path, asset_id: &str, rel: &str) -> Result<()> {
    let mut doc: serde_json::Value = serde_json::from_str(&fs::read_to_string(path)?)?;
    let mut changed = false;
    if let Some(nodes) = doc.get_mut("nodes").and_then(|n| n.as_array_mut()) {
        for node in nodes {
            if node.pointer("/lattira/assetId").and_then(|v| v.as_str()) == Some(asset_id) {
                node["file"] = serde_json::Value::String(rel.to_string());
                changed = true;
            }
        }
    }
    if changed {
        files::write_atomic(path, serde_json::to_string_pretty(&doc)?.as_bytes())?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAssetsResult {
    /// 被移除了卡片的画布
    canvas_ids: Vec<String>,
    /// 一共从画布上移除的卡片数
    removed_cards: usize,
}

/// 从一个画布文件中移除引用了这些资源的卡片及相连的连线；返回移除的卡片数与剩余元素数
fn strip_asset_cards(path: &Path, assets: &HashSet<String>) -> Result<(usize, usize)> {
    let mut doc: serde_json::Value = serde_json::from_str(&fs::read_to_string(path)?)?;
    let mut removed = HashSet::new();
    if let Some(nodes) = doc.get_mut("nodes").and_then(|n| n.as_array_mut()) {
        nodes.retain(|node| {
            let asset = node.pointer("/lattira/assetId").and_then(|v| v.as_str());
            let hit = asset.is_some_and(|a| assets.contains(a));
            if hit {
                if let Some(id) = node.get("id").and_then(|v| v.as_str()) {
                    removed.insert(id.to_string());
                }
            }
            !hit
        });
    }
    if let Some(edges) = doc.get_mut("edges").and_then(|e| e.as_array_mut()) {
        edges.retain(|edge| {
            let ends = ["fromNode", "toNode"].map(|k| edge.get(k).and_then(|v| v.as_str()).unwrap_or_default());
            !ends.iter().any(|id| removed.contains(*id))
        });
    }
    let remaining = doc.get("nodes").and_then(|n| n.as_array()).map_or(0, |n| n.len());
    if !removed.is_empty() {
        files::write_atomic(path, serde_json::to_string_pretty(&doc)?.as_bytes())?;
    }
    Ok((removed.len(), remaining))
}

/// 删除资源：文件移到 .lattira/trash/assets/，并从所有画布上移除引用它们的卡片
#[tauri::command]
pub async fn delete_assets(state: State<'_, AppState>, ids: Vec<String>) -> Result<DeleteAssetsResult> {
    state.with(|ws| {
        let set: HashSet<String> = ids.into_iter().collect();
        let mut canvases = HashSet::new();
        {
            let mut stmt = ws.conn.prepare("SELECT canvas_id FROM asset_refs WHERE asset_id = ?1")?;
            for id in &set {
                for row in stmt.query_map([id], |r| r.get::<_, String>(0))? {
                    canvases.insert(row?);
                }
            }
        }

        let mut removed_cards = 0;
        let mut touched = Vec::new();
        for canvas_id in &canvases {
            let Ok(file) = canvas_file(&ws.conn, canvas_id) else { continue };
            match strip_asset_cards(&ws.abs(&file), &set) {
                Ok((0, _)) => {}
                Ok((n, remaining)) => {
                    removed_cards += n;
                    ws.conn.execute(
                        "UPDATE canvases SET element_count = ?2 WHERE id = ?1",
                        params![canvas_id, remaining as i64],
                    )?;
                    touched.push(canvas_id.clone());
                }
                // 画布文件损坏或缺失时跳过，不影响删除文件本身
                Err(e) => eprintln!("[delete_assets] 跳过画布 {canvas_id}：{e}"),
            }
        }

        let trash = ws.root.join(".lattira").join("trash").join("assets");
        fs::create_dir_all(&trash)?;
        let tx = ws.conn.transaction()?;
        for id in &set {
            let path: Option<String> =
                tx.query_row("SELECT path FROM assets WHERE id = ?1", [id], |r| r.get(0)).optional()?;
            let Some(rel) = path else { continue };
            let src = files::resolve(&ws.root, &rel);
            if src.exists() {
                let name = Path::new(&rel);
                let stem = name.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                let ext = name.extension().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                fs::rename(&src, files::unique_path(&trash, &stem, &ext, None))?;
            }
            tx.execute("DELETE FROM asset_refs WHERE asset_id = ?1", [id])?;
            tx.execute("DELETE FROM assets WHERE id = ?1", [id])?;
        }
        tx.commit()?;
        Ok(DeleteAssetsResult { canvas_ids: touched, removed_cards })
    })
}

#[derive(Deserialize)]
pub struct TextItem {
    name: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyCards {
    /// 文件 / 图片卡片引用的资源
    asset_ids: Vec<String>,
    /// 文本卡片；和文件一起复制时写成临时 .txt，随文件一起粘贴
    texts: Vec<TextItem>,
    /// 文本卡片拼接后的纯文本
    plain_text: String,
    /// 栖页卡片数据（JSON），粘贴回画布用
    cards: String,
}

/// 复制选中的卡片到系统剪贴板（Ctrl+C）
#[tauri::command]
pub async fn copy_cards(state: State<'_, AppState>, payload: CopyCards) -> Result<()> {
    let files = state.with(|ws| {
        let mut files = Vec::new();
        for id in &payload.asset_ids {
            if let Some(asset) = get_asset(&ws.conn, "id", id)? {
                files.push(ws.abs(&asset.path).to_string_lossy().into_owned());
            }
        }
        if !files.is_empty() && !payload.texts.is_empty() {
            let dir = ws.root.join(".lattira").join("tmp");
            fs::create_dir_all(&dir)?;
            for t in &payload.texts {
                let path = files::unique_path(&dir, &files::sanitize(&t.name), "txt", None);
                files::write_atomic(&path, t.text.as_bytes())?;
                files.push(path.to_string_lossy().into_owned());
            }
        }
        Ok(files)
    })?;
    let text = Some(payload.plain_text.as_str()).filter(|t| !t.trim().is_empty());
    clipboard::write(&files, text, Some(&payload.cards))
}

#[tauri::command]
pub async fn read_clipboard() -> Result<clipboard::ClipboardContent> {
    clipboard::read()
}

// ---------------------------------------------------------------------------
// 日历与搜索
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn calendar_days(state: State<'_, AppState>, from: String, to: String) -> Result<Vec<CanvasDay>> {
    state.with(|ws| {
        let mut stmt = ws.conn.prepare(
            "SELECT d.canvas_id, d.date, d.change_count FROM canvas_days d
             JOIN canvases c ON c.id = d.canvas_id
             WHERE c.deleted_at IS NULL AND d.date BETWEEN ?1 AND ?2",
        )?;
        let rows = stmt
            .query_map([from, to], |r| Ok(CanvasDay { canvas_id: r.get(0)?, date: r.get(1)?, change_count: r.get(2)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

fn escape_like(q: &str) -> String {
    q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// 截取命中位置附近的一段文字
fn snippet(text: &str, query: &str) -> String {
    let chars: Vec<char> = text.chars().map(|c| if c.is_whitespace() { ' ' } else { c }).collect();
    let lower: Vec<char> = chars.iter().flat_map(|c| c.to_lowercase()).collect();
    let needle: Vec<char> = query.to_lowercase().chars().collect();
    let pos = if lower.len() == chars.len() {
        lower.windows(needle.len().max(1)).position(|w| w == needle.as_slice()).unwrap_or(0)
    } else {
        0
    };
    let start = pos.saturating_sub(16);
    let end = (pos + needle.len() + 60).min(chars.len());
    let body: String = chars[start..end].iter().collect();
    format!("{}{}{}", if start > 0 { "…" } else { "" }, body.trim(), if end < chars.len() { "…" } else { "" })
}

#[tauri::command]
pub async fn search(state: State<'_, AppState>, query: String) -> Result<Vec<SearchHit>> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(vec![]);
    }
    state.with(|ws| {
        let like = format!("%{}%", escape_like(&q));
        let mut hits = Vec::new();

        let mut stmt = ws.conn.prepare(
            "SELECT id, title, project_id FROM canvases
             WHERE deleted_at IS NULL AND title LIKE ?1 ESCAPE '\\' ORDER BY updated_at DESC LIMIT 20",
        )?;
        for row in stmt.query_map([&like], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))? {
            let (canvas_id, title, project_id) = row?;
            hits.push(SearchHit {
                kind: "canvas",
                snippet: title.clone(),
                canvas_id,
                canvas_title: title,
                project_id,
                element_id: None,
                asset_id: None,
            });
        }

        let mut stmt = ws.conn.prepare(
            "SELECT t.canvas_id, c.title, c.project_id, t.element_id, t.text FROM element_text t
             JOIN canvases c ON c.id = t.canvas_id
             WHERE c.deleted_at IS NULL AND t.text LIKE ?1 ESCAPE '\\' ORDER BY c.updated_at DESC LIMIT 40",
        )?;
        for row in stmt.query_map([&like], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?))
        })? {
            let (canvas_id, canvas_title, project_id, element_id, text) = row?;
            hits.push(SearchHit {
                kind: "text",
                snippet: snippet(&text, &q),
                canvas_id,
                canvas_title,
                project_id,
                element_id: Some(element_id),
                asset_id: None,
            });
        }

        // 文件名与图片中的文字：落在引用了该资源的每个画布上
        for (kind, column) in [("file", "a.name"), ("image", "a.ocr_text")] {
            let mut stmt = ws.conn.prepare(&format!(
                "SELECT r.canvas_id, c.title, c.project_id, a.id, {column} FROM asset_refs r
                 JOIN assets a ON a.id = r.asset_id
                 JOIN canvases c ON c.id = r.canvas_id
                 WHERE c.deleted_at IS NULL AND {column} LIKE ?1 ESCAPE '\\' ORDER BY c.updated_at DESC LIMIT 20"
            ))?;
            for row in stmt.query_map([&like], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?))
            })? {
                let (canvas_id, canvas_title, project_id, asset_id, text) = row?;
                hits.push(SearchHit {
                    kind,
                    snippet: if kind == "image" { snippet(&text, &q) } else { text },
                    canvas_id,
                    canvas_title,
                    project_id,
                    element_id: None,
                    asset_id: Some(asset_id),
                });
            }
        }
        Ok(hits)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippet_centers_on_match() {
        let text = "第一行\n这里有很长的一段前文用来测试截取，然后出现关键字连线，后面还有一些文字";
        let s = snippet(text, "连线");
        assert!(s.contains("连线"));
        assert!(s.starts_with('…'));
        assert!(!s.contains('\n'));
    }

    #[test]
    fn escape_like_escapes_wildcards() {
        assert_eq!(escape_like("50%_a\\b"), "50\\%\\_a\\\\b");
    }

    #[test]
    fn sanitize_and_unique_names() {
        assert_eq!(files::sanitize("a/b:c?"), "a_b_c_");
        assert_eq!(files::sanitize("  CON "), "CON_");
        assert_eq!(files::sanitize("..."), "未命名");
        let dir = std::env::temp_dir().join(format!("lattira-test-{}", new_id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("画布.canvas"), "").unwrap();
        let p = files::unique_path(&dir, "画布", "canvas", None);
        assert_eq!(p.file_name().unwrap().to_string_lossy(), "画布 (2).canvas");
        let same = files::unique_path(&dir, "画布", "canvas", Some(&dir.join("画布.canvas")));
        assert_eq!(same.file_name().unwrap().to_string_lossy(), "画布.canvas");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn workspace_roundtrip() {
        let dir = std::env::temp_dir().join(format!("lattira-ws-{}", new_id()));
        fs::create_dir_all(&dir).unwrap();
        let (ws, is_new) = Workspace::open(&dir).unwrap();
        assert!(is_new);
        let inbox: String = ws.conn.query_row("SELECT dir FROM projects WHERE is_inbox = 1", [], |r| r.get(0)).unwrap();
        assert!(dir.join("projects").join(&inbox).is_dir());

        // 导入同一内容两次只存一份
        let src = dir.join("note.txt");
        fs::write(&src, "hello").unwrap();
        let a = import_file(&ws, &src).unwrap();
        let b = import_file(&ws, &src).unwrap();
        assert_eq!(a.id, b.id);
        assert!(ws.abs(&a.path).is_file());
        assert_eq!(a.mime, "text/plain");
        drop(ws);

        let (_, is_new) = Workspace::open(&dir).unwrap();
        assert!(!is_new);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn strip_asset_cards_removes_cards_and_edges() {
        let path = std::env::temp_dir().join(format!("lattira-strip-{}.canvas", new_id()));
        fs::write(
            &path,
            r#"{"nodes":[
                {"id":"t","type":"text","text":"留下"},
                {"id":"f","type":"file","file":"assets/a.pdf","lattira":{"type":"file","assetId":"A"}},
                {"id":"g","type":"file","file":"assets/b.png","lattira":{"type":"image","assetId":"B"}}
              ],"edges":[{"id":"e1","fromNode":"t","toNode":"f"},{"id":"e2","fromNode":"t","toNode":"g"}]}"#,
        )
        .unwrap();
        let (removed, remaining) = strip_asset_cards(&path, &HashSet::from(["A".to_string()])).unwrap();
        assert_eq!((removed, remaining), (1, 2));
        let doc: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let edges: Vec<&str> = doc["edges"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect();
        assert_eq!(edges, vec!["e2"]);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn import_folder_keeps_structure() {
        let dir = std::env::temp_dir().join(format!("lattira-tree-{}", new_id()));
        let src = dir.join("资料");
        fs::create_dir_all(src.join("图纸")).unwrap();
        fs::write(src.join("b.txt"), "b").unwrap();
        fs::write(src.join("a.txt"), "a").unwrap();
        fs::write(src.join(".hidden"), "x").unwrap();
        fs::write(src.join("Thumbs.db"), "x").unwrap();
        fs::write(src.join("图纸").join("plan.drawio"), "<mxfile/>").unwrap();
        let ws_dir = dir.join("ws");
        fs::create_dir_all(&ws_dir).unwrap();
        let (ws, _) = Workspace::open(&ws_dir).unwrap();

        let ImportNode::Folder { name, children } = import_node(&ws, &src).unwrap() else { panic!("应为文件夹") };
        assert_eq!(name, "资料");
        let names: Vec<String> = children
            .iter()
            .map(|c| match c {
                ImportNode::File { asset } => asset.name.clone(),
                ImportNode::Folder { name, .. } => format!("[{name}]"),
            })
            .collect();
        assert_eq!(names, vec!["a.txt", "b.txt", "[图纸]"]);
        drop(ws);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rename_asset_keeps_extension_and_moves_file() {
        let dir = std::env::temp_dir().join(format!("lattira-rename-{}", new_id()));
        fs::create_dir_all(&dir).unwrap();
        let (ws, _) = Workspace::open(&dir).unwrap();
        let src = dir.join("流程.drawio");
        fs::write(&src, "<mxfile/>").unwrap();
        let a = import_file(&ws, &src).unwrap();

        // 不写扩展名：沿用 .drawio
        let b = rename_asset_in(&ws, &a.id, "部署架构").unwrap();
        assert_eq!(b.name, "部署架构.drawio");
        assert!(ws.abs(&b.path).is_file());
        assert!(!ws.abs(&a.path).exists());

        // 写了扩展名：按新的来
        let c = rename_asset_in(&ws, &a.id, "部署架构.xml").unwrap();
        assert_eq!(c.name, "部署架构.xml");
        assert!(rename_asset_in(&ws, &a.id, "  ").is_err());
        drop(ws);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn legacy_inbox_is_renamed() {
        let dir = std::env::temp_dir().join(format!("lattira-legacy-{}", new_id()));
        fs::create_dir_all(&dir).unwrap();
        {
            // 模拟早期版本创建的「收件箱」以及其中的一个画布
            let (ws, _) = Workspace::open(&dir).unwrap();
            let id: String = ws.conn.query_row("SELECT id FROM projects WHERE is_inbox = 1", [], |r| r.get(0)).unwrap();
            fs::rename(dir.join("projects/未分类"), dir.join("projects/收件箱")).unwrap();
            fs::write(dir.join("projects/收件箱/笔记.canvas"), "{}").unwrap();
            ws.conn.execute("UPDATE projects SET name = '收件箱', dir = '收件箱' WHERE id = ?1", [&id]).unwrap();
            ws.conn
                .execute(
                    "INSERT INTO canvases (id, project_id, title, file, created_at, updated_at) VALUES ('c1', ?1, '笔记', 'projects/收件箱/笔记.canvas', 0, 0)",
                    [&id],
                )
                .unwrap();
        }
        let (ws, _) = Workspace::open(&dir).unwrap();
        let (name, pdir): (String, String) =
            ws.conn.query_row("SELECT name, dir FROM projects WHERE is_inbox = 1", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((name.as_str(), pdir.as_str()), ("未分类", "未分类"));
        let file: String = ws.conn.query_row("SELECT file FROM canvases WHERE id = 'c1'", [], |r| r.get(0)).unwrap();
        assert_eq!(file, "projects/未分类/笔记.canvas");
        assert!(ws.abs(&file).is_file());
        drop(ws);
        fs::remove_dir_all(&dir).ok();
    }

    /// 需要真实图片：`$env:LATTIRA_OCR_SAMPLE="图片路径"; cargo test ocr_sample -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn ocr_sample() {
        let path = std::env::var("LATTIRA_OCR_SAMPLE").expect("设置 LATTIRA_OCR_SAMPLE");
        let text = ocr::recognize(Path::new(&path)).unwrap();
        println!("识别结果：\n{text}");
        assert!(!text.trim().is_empty());
    }
}
