//! 回收站：删除的画布与文件先放在 .lattira/trash/，可以恢复或永久删除
//!
//! ```text
//! .lattira/trash/
//! ├─ <画布 id>.canvas     删除的画布（canvases 表里 deleted_at 不为空）
//! └─ assets/<文件名>      删除的文件（记录在 trashed_assets 表）
//! ```

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::{self, Asset, CanvasMeta};
use crate::error::{Error, Result};
use crate::files;
use crate::workspace::{new_id, now_ms, AppState, Workspace};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    kind: TrashKind,
    id: String,
    /// 画布标题或文件名
    name: String,
    deleted_at: i64,
    /// 回收站中文件的字节数
    size: i64,
    /// 画布：原来所属的项目
    project_id: Option<String>,
    element_count: Option<i64>,
    preview: Option<String>,
    /// 文件：类型
    mime: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TrashKind {
    Canvas,
    Asset,
}

#[derive(Deserialize)]
pub struct TrashRef {
    kind: TrashKind,
    id: String,
}

#[derive(Serialize, Default)]
pub struct RestoreResult {
    canvases: Vec<CanvasMeta>,
    assets: Vec<Asset>,
}

fn trash_dir(ws: &Workspace) -> PathBuf {
    ws.root.join(".lattira").join("trash")
}

fn canvas_trash_file(ws: &Workspace, id: &str) -> PathBuf {
    trash_dir(ws).join(format!("{id}.canvas"))
}

fn file_size(path: &Path) -> i64 {
    fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0)
}

/// 早期版本删除文件时只把文件移进 trash/assets/，没有留下记录；补登记，让它们也能恢复
fn adopt_orphans(ws: &Workspace) -> Result<()> {
    let dir = trash_dir(ws).join("assets");
    let Ok(entries) = fs::read_dir(&dir) else { return Ok(()) };
    let known: HashSet<String> = {
        let mut stmt = ws.conn.prepare("SELECT trash_file FROM trashed_assets")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<_>>()?;
        rows
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let rel = ws.rel(&path);
        if !path.is_file() || known.contains(&rel) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let mime = mime_guess::from_path(&name).first_or_octet_stream().essence_str().to_string();
        let (width, height) = if mime.starts_with("image/") {
            imagesize::size(&path).map(|s| (Some(s.width as i64), Some(s.height as i64))).unwrap_or((None, None))
        } else {
            (None, None)
        };
        let now = now_ms();
        ws.conn.execute(
            "INSERT INTO trashed_assets (id, hash, name, mime, size, width, height, imported_at, original_path, trash_file, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '', ?9, ?8)",
            params![new_id(), commands::hash_file(&path)?, name, mime, file_size(&path), width, height, now, rel],
        )?;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_trash(state: State<'_, AppState>) -> Result<Vec<TrashItem>> {
    state.with(|ws| {
        adopt_orphans(ws)?;
        let mut items = Vec::new();

        let mut stmt = ws.conn.prepare(
            "SELECT id, project_id, title, element_count, deleted_at, preview FROM canvases WHERE deleted_at IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        })?;
        for row in rows {
            let (id, project_id, title, element_count, deleted_at, preview) = row?;
            items.push(TrashItem {
                kind: TrashKind::Canvas,
                size: file_size(&canvas_trash_file(ws, &id)),
                id,
                name: title,
                deleted_at,
                project_id: Some(project_id),
                element_count: Some(element_count),
                preview,
                mime: None,
            });
        }

        let mut stmt = ws.conn.prepare("SELECT id, name, mime, size, deleted_at FROM trashed_assets")?;
        let rows = stmt.query_map([], |r| {
            Ok(TrashItem {
                kind: TrashKind::Asset,
                id: r.get(0)?,
                name: r.get(1)?,
                mime: Some(r.get(2)?),
                size: r.get(3)?,
                deleted_at: r.get(4)?,
                project_id: None,
                element_count: None,
                preview: None,
            })
        })?;
        for row in rows {
            items.push(row?);
        }

        items.sort_by_key(|i| std::cmp::Reverse(i.deleted_at));
        Ok(items)
    })
}

/// 放回原来的项目；项目已归档时放进「未分类」
fn restore_canvas(ws: &Workspace, id: &str) -> Result<CanvasMeta> {
    let (project_id, title): (String, String) = ws
        .conn
        .query_row("SELECT project_id, title FROM canvases WHERE id = ?1 AND deleted_at IS NOT NULL", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?
        .ok_or_else(|| Error::NotFound("回收站中的画布", id.into()))?;
    let src = canvas_trash_file(ws, id);
    if !src.is_file() {
        return Err(Error::Invalid(format!("回收站里找不到「{title}」的画布文件")));
    }
    let archived: Option<bool> =
        ws.conn.query_row("SELECT archived FROM projects WHERE id = ?1", [&project_id], |r| r.get(0)).optional()?;
    let project_id = if archived == Some(false) {
        project_id
    } else {
        ws.conn.query_row("SELECT id FROM projects WHERE is_inbox = 1", [], |r| r.get(0))?
    };
    let dir = ws.root.join("projects").join(commands::project_dir(&ws.conn, &project_id)?);
    fs::create_dir_all(&dir)?;
    let dest = files::unique_path(&dir, &files::sanitize(&title), "canvas", None);
    fs::rename(&src, &dest)?;
    // 搜索索引与资源引用由前端重新保存一次画布时重建
    ws.conn.execute(
        "UPDATE canvases SET deleted_at = NULL, project_id = ?2, file = ?3 WHERE id = ?1",
        params![id, project_id, ws.rel(&dest)],
    )?;
    commands::get_canvas(&ws.conn, id)
}

/// 尽量放回原来的位置；同样内容的文件已经重新导入过时，直接用现有的那份
fn restore_asset(ws: &Workspace, id: &str) -> Result<Asset> {
    let (hash, name, original, trash_file): (String, String, String, String) = ws
        .conn
        .query_row("SELECT hash, name, original_path, trash_file FROM trashed_assets WHERE id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .optional()?
        .ok_or_else(|| Error::NotFound("回收站中的文件", id.into()))?;
    let src = ws.abs(&trash_file);

    if let Some(existing) = commands::get_asset(&ws.conn, "hash", &hash)? {
        if src.exists() {
            fs::remove_file(&src)?;
        }
        ws.conn.execute("DELETE FROM trashed_assets WHERE id = ?1", [id])?;
        return Ok(existing);
    }
    if !src.is_file() {
        return Err(Error::Invalid(format!("回收站里找不到文件「{name}」")));
    }
    let dest = match (!original.is_empty()).then(|| ws.abs(&original)) {
        Some(p) if !p.exists() => p,
        _ => commands::asset_destination(ws, &name)?,
    };
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(&src, &dest)?;
    ws.conn.execute(
        "INSERT INTO assets (id, hash, path, name, mime, size, width, height, imported_at, ocr_text)
         SELECT id, hash, ?2, name, mime, size, width, height, imported_at, ocr_text FROM trashed_assets WHERE id = ?1",
        params![id, ws.rel(&dest)],
    )?;
    ws.conn.execute("DELETE FROM trashed_assets WHERE id = ?1", [id])?;
    commands::get_asset(&ws.conn, "id", id)?.ok_or_else(|| Error::NotFound("资源", id.into()))
}

#[tauri::command]
pub async fn restore_trash(state: State<'_, AppState>, items: Vec<TrashRef>) -> Result<RestoreResult> {
    state.with(|ws| {
        let mut out = RestoreResult::default();
        for item in &items {
            match item.kind {
                TrashKind::Canvas => out.canvases.push(restore_canvas(ws, &item.id)?),
                TrashKind::Asset => out.assets.push(restore_asset(ws, &item.id)?),
            }
        }
        Ok(out)
    })
}

fn remove_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// 永久删除；只处理确实在回收站里的条目
fn purge(ws: &mut Workspace, item: &TrashRef) -> Result<()> {
    match item.kind {
        TrashKind::Canvas => {
            let trashed: Option<i64> = ws
                .conn
                .query_row("SELECT deleted_at FROM canvases WHERE id = ?1", [&item.id], |r| r.get(0))
                .optional()?
                .flatten();
            if trashed.is_none() {
                return Ok(());
            }
            remove_if_exists(&canvas_trash_file(ws, &item.id))?;
            let tx = ws.conn.transaction()?;
            for table in ["canvas_days", "edit_events", "asset_refs", "element_text"] {
                tx.execute(&format!("DELETE FROM {table} WHERE canvas_id = ?1"), [&item.id])?;
            }
            tx.execute("DELETE FROM canvases WHERE id = ?1", [&item.id])?;
            tx.commit()?;
        }
        TrashKind::Asset => {
            let file: Option<String> = ws
                .conn
                .query_row("SELECT trash_file FROM trashed_assets WHERE id = ?1", [&item.id], |r| r.get(0))
                .optional()?;
            if let Some(file) = file {
                remove_if_exists(&ws.abs(&file))?;
                ws.conn.execute("DELETE FROM trashed_assets WHERE id = ?1", [&item.id])?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn purge_trash(state: State<'_, AppState>, items: Vec<TrashRef>) -> Result<()> {
    state.with(|ws| items.iter().try_for_each(|item| purge(ws, item)))
}

/// 清空回收站：永久删除全部条目，连同回收站文件夹里没有记录的残留文件
#[tauri::command]
pub async fn empty_trash(state: State<'_, AppState>) -> Result<()> {
    state.with(|ws| {
        let canvases: Vec<String> = {
            let mut stmt = ws.conn.prepare("SELECT id FROM canvases WHERE deleted_at IS NOT NULL")?;
            let rows = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
            rows
        };
        let assets: Vec<String> = {
            let mut stmt = ws.conn.prepare("SELECT id FROM trashed_assets")?;
            let rows = stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
            rows
        };
        for id in canvases {
            purge(ws, &TrashRef { kind: TrashKind::Canvas, id })?;
        }
        for id in assets {
            purge(ws, &TrashRef { kind: TrashKind::Asset, id })?;
        }
        let dir = trash_dir(ws);
        if dir.exists() {
            fs::remove_dir_all(&dir)?;
        }
        fs::create_dir_all(&dir)?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_ws(tag: &str) -> (PathBuf, Workspace) {
        let dir = std::env::temp_dir().join(format!("lattira-{tag}-{}", new_id()));
        fs::create_dir_all(&dir).unwrap();
        let (ws, _) = Workspace::open(&dir).unwrap();
        (dir, ws)
    }

    fn inbox(ws: &Workspace) -> String {
        ws.conn.query_row("SELECT id FROM projects WHERE is_inbox = 1", [], |r| r.get(0)).unwrap()
    }

    /// 模拟 delete_canvas：文件移进回收站并标记删除
    fn trash_canvas(ws: &Workspace, title: &str) -> String {
        let id = new_id();
        let project = inbox(ws);
        let file = format!("projects/未分类/{title}.canvas");
        files::write_atomic(&ws.abs(&file), br#"{"nodes":[],"edges":[]}"#).unwrap();
        ws.conn
            .execute(
                "INSERT INTO canvases (id, project_id, title, file, created_at, updated_at, deleted_at) VALUES (?1, ?2, ?3, ?4, 0, 0, 1)",
                params![id, project, title, file],
            )
            .unwrap();
        fs::create_dir_all(trash_dir(ws)).unwrap();
        fs::rename(ws.abs(&file), canvas_trash_file(ws, &id)).unwrap();
        id
    }

    #[test]
    fn canvas_restore_and_purge() {
        let (dir, mut ws) = temp_ws("trash-canvas");
        let a = trash_canvas(&ws, "笔记");
        let b = trash_canvas(&ws, "草稿");
        // 原位置已有同名画布时改名放回
        files::write_atomic(&ws.root.join("projects/未分类/笔记.canvas"), b"{}").unwrap();

        let meta = restore_canvas(&ws, &a).unwrap();
        assert_eq!(meta.title, "笔记");
        let file = commands::canvas_file(&ws.conn, &a).unwrap();
        assert_eq!(file, "projects/未分类/笔记 (2).canvas");
        assert!(ws.abs(&file).is_file());
        assert!(!canvas_trash_file(&ws, &a).exists());

        // 不在回收站里的画布不会被永久删除
        purge(&mut ws, &TrashRef { kind: TrashKind::Canvas, id: a.clone() }).unwrap();
        assert!(commands::get_canvas(&ws.conn, &a).is_ok());

        purge(&mut ws, &TrashRef { kind: TrashKind::Canvas, id: b.clone() }).unwrap();
        let left: i64 = ws.conn.query_row("SELECT COUNT(*) FROM canvases WHERE id = ?1", [&b], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
        assert!(!canvas_trash_file(&ws, &b).exists());
        drop(ws);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn asset_restore_roundtrip_and_orphans() {
        let (dir, ws) = temp_ws("trash-asset");
        let src = dir.join("报告.pdf");
        fs::write(&src, "pdf").unwrap();
        let asset = commands::import_file(&ws, &src).unwrap();
        let original = ws.abs(&asset.path);

        // 模拟 delete_assets
        let dest = trash_dir(&ws).join("assets").join("报告.pdf");
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::rename(&original, &dest).unwrap();
        ws.conn
            .execute(
                "INSERT INTO trashed_assets (id, hash, name, mime, size, width, height, imported_at, ocr_text, original_path, trash_file, deleted_at)
                 SELECT id, hash, name, mime, size, width, height, imported_at, ocr_text, path, ?2, 1 FROM assets WHERE id = ?1",
                params![asset.id, ws.rel(&dest)],
            )
            .unwrap();
        ws.conn.execute("DELETE FROM assets WHERE id = ?1", [&asset.id]).unwrap();

        // 早期版本留下的、没有记录的文件
        fs::write(trash_dir(&ws).join("assets").join("旧图.png"), "png").unwrap();
        adopt_orphans(&ws).unwrap();
        adopt_orphans(&ws).unwrap();
        let n: i64 = ws.conn.query_row("SELECT COUNT(*) FROM trashed_assets", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);

        let restored = restore_asset(&ws, &asset.id).unwrap();
        assert_eq!(restored.id, asset.id);
        assert_eq!(restored.path, asset.path);
        assert!(original.is_file());

        let orphan: String =
            ws.conn.query_row("SELECT id FROM trashed_assets WHERE name = '旧图.png'", [], |r| r.get(0)).unwrap();
        let restored = restore_asset(&ws, &orphan).unwrap();
        assert!(restored.path.starts_with("assets/"));
        assert!(ws.abs(&restored.path).is_file());
        drop(ws);
        fs::remove_dir_all(&dir).ok();
    }
}
