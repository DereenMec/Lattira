//! 画布的导出与导入
//!
//! 导出为「画布包」：一个 zip，里面是 JSON Canvas 格式的画布文件和它引用的文件，
//! 文件节点的 file 字段改成包内的相对路径，解压后 Obsidian 等工具也能直接打开。
//!
//! ```text
//! 竞品对比.zip
//! ├─ 竞品对比.canvas
//! └─ assets/行业报告.pdf
//! ```
//!
//! 导入既接受画布包，也接受单独的 .canvas 文件（例如 Obsidian 的画布）：
//! 引用的文件会复制进工作区，找不到的文件变成写着原路径的文本卡片。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};

use rusqlite::params;
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::commands::{self, CanvasMeta, MAX_IMPORT_FILES};
use crate::error::{Error, Result};
use crate::files;
use crate::ocr;
use crate::workspace::{new_id, now_ms, AppState, Workspace};

/// 画布包解压后的总大小上限，防止异常的压缩包占满磁盘
const MAX_PACKAGE_BYTES: u64 = 8 << 30;

/// 本身已经压缩过的格式，打包时不再压缩
fn already_compressed(name: &str) -> bool {
    const EXTS: &[&str] = &[
        "jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "mp3", "m4a", "aac", "ogg", "flac", "mp4", "mov", "mkv",
        "webm", "avi", "zip", "7z", "rar", "gz", "xz", "bz2", "zst", "docx", "xlsx", "pptx", "epub", "vsix", "woff2",
    ];
    let ext = Path::new(name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    EXTS.contains(&ext.as_str())
}

/// 包内不重名的文件名（不区分大小写）
fn entry_name(name: &str, used: &mut HashSet<String>) -> String {
    let p = Path::new(name);
    let stem = files::sanitize(&p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default());
    let ext = p.extension().map(|e| files::sanitize(&e.to_string_lossy())).unwrap_or_default();
    let mut n = 1;
    loop {
        let base = if n == 1 { stem.clone() } else { format!("{stem} ({n})") };
        let candidate = if ext.is_empty() { base } else { format!("{base}.{ext}") };
        if used.insert(candidate.to_lowercase()) {
            return candidate;
        }
        n += 1;
    }
}

fn write_package(dest: &Path, title: &str, doc: &Value, files: &[(String, PathBuf)]) -> Result<()> {
    let mut zip = ZipWriter::new(fs::File::create(dest)?);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).large_file(true);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored).large_file(true);
    zip.start_file(format!("{}.canvas", files::sanitize(title)), deflated)?;
    zip.write_all(serde_json::to_string_pretty(doc)?.as_bytes())?;
    for (entry, src) in files {
        zip.start_file(entry.as_str(), if already_compressed(entry) { stored } else { deflated })?;
        io::copy(&mut BufReader::new(fs::File::open(src)?), &mut zip)?;
    }
    zip.finish()?;
    Ok(())
}

/// 把画布导出为画布包，写到用户选择的位置
#[tauri::command]
pub async fn export_canvas(state: State<'_, AppState>, id: String, dest: String) -> Result<()> {
    // 只在读取元数据时占用工作区，打包大文件时不挡住其他操作
    let (title, doc, packed) = state.with(|ws| {
        let meta = commands::get_canvas(&ws.conn, &id)?;
        let path = ws.abs(&commands::canvas_file(&ws.conn, &id)?);
        let mut doc: Value = serde_json::from_str(&fs::read_to_string(path)?)?;
        let mut packed: Vec<(String, PathBuf)> = Vec::new();
        let mut by_asset: HashMap<String, String> = HashMap::new();
        let mut used = HashSet::new();
        if let Some(nodes) = doc.get_mut("nodes").and_then(|n| n.as_array_mut()) {
            for node in nodes {
                let Some(asset_id) = node.pointer("/lattira/assetId").and_then(|v| v.as_str()).map(str::to_string)
                else {
                    continue;
                };
                let entry = match by_asset.get(&asset_id) {
                    Some(entry) => entry.clone(),
                    None => {
                        let Some(asset) = commands::get_asset(&ws.conn, "id", &asset_id)? else { continue };
                        let src = ws.abs(&asset.path);
                        if !src.is_file() {
                            continue;
                        }
                        let entry = format!("assets/{}", entry_name(&asset.name, &mut used));
                        packed.push((entry.clone(), src));
                        by_asset.insert(asset_id, entry.clone());
                        entry
                    }
                };
                node["file"] = Value::String(entry);
            }
        }
        Ok((meta.title, doc, packed))
    })?;

    let dest = PathBuf::from(dest);
    let tmp = dest.with_extension("zip.tmp");
    match write_package(&tmp, &title, &doc, &packed) {
        Ok(()) => Ok(fs::rename(&tmp, &dest)?),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// 解压画布包到 dir，返回其中的 .canvas 文件（按路径排序）
fn extract_package(src: &Path, dir: &Path) -> Result<Vec<PathBuf>> {
    let mut archive = ZipArchive::new(BufReader::new(fs::File::open(src)?))?;
    if archive.len() > MAX_IMPORT_FILES + 100 {
        return Err(Error::Invalid(format!("压缩包里的文件太多，一次最多导入 {MAX_IMPORT_FILES} 个文件")));
    }
    let mut total = 0u64;
    let mut canvases = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        // 跳过目录、带 .. 或绝对路径的条目，以及 macOS 打包时附带的元数据
        let Some(rel) = entry.enclosed_name() else { continue };
        if entry.is_dir() || rel.starts_with("__MACOSX") {
            continue;
        }
        total += entry.size();
        if total > MAX_PACKAGE_BYTES {
            return Err(Error::Invalid("压缩包解压后太大，无法导入".into()));
        }
        let out = dir.join(&rel);
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        let size = entry.size();
        io::copy(&mut entry.by_ref().take(size), &mut fs::File::create(&out)?)?;
        if out.extension().is_some_and(|e| e.eq_ignore_ascii_case("canvas")) {
            canvases.push(out);
        }
    }
    canvases.sort();
    Ok(canvases)
}

/// 找到文件节点引用的文件。
/// 画布包（scope 为解压目录）里只认包内的文件；单独的 .canvas 文件按相对画布所在文件夹查找，
/// Obsidian 的路径相对于仓库根目录，所以再逐级往上找。
fn locate(file: &str, base: &Path, scope: Option<&Path>) -> Option<PathBuf> {
    let file = file.trim();
    if file.is_empty() {
        return None;
    }
    let rel = Path::new(file);
    match scope {
        Some(root) => {
            let escapes = rel.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir));
            if escapes {
                return None;
            }
            [base, root].iter().map(|b| b.join(rel)).find(|p| p.is_file())
        }
        None if rel.is_absolute() => rel.is_file().then(|| rel.to_path_buf()),
        None => base.ancestors().take(8).map(|d| d.join(rel)).find(|p| p.is_file()),
    }
}

fn number(node: &Value, key: &str, fallback: f64) -> Value {
    json!(node.get(key).and_then(Value::as_f64).filter(|v| v.is_finite()).unwrap_or(fallback))
}

/// 导入一个 .canvas 文件：复制引用的文件进工作区，写入项目文件夹并登记
fn import_canvas_file(ws: &Workspace, project_id: &str, path: &Path, scope: Option<&Path>) -> Result<CanvasMeta> {
    let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let invalid = || Error::Invalid(format!("「{file_name}」不是有效的画布文件"));
    let raw = fs::read_to_string(path)?;
    let mut doc: Value = serde_json::from_str(raw.trim_start_matches('\u{feff}')).map_err(|_| invalid())?;
    let obj = doc.as_object_mut().ok_or_else(invalid)?;
    if !obj.get("nodes").is_some_and(Value::is_array) {
        obj.insert("nodes".into(), json!([]));
    }
    if !obj.get("edges").is_some_and(Value::is_array) {
        obj.insert("edges".into(), json!([]));
    }

    let base = path.parent().unwrap_or(Path::new("."));
    let now = now_ms();
    let nodes = doc["nodes"].as_array_mut().ok_or_else(invalid)?;
    nodes.retain(Value::is_object);
    for node in nodes.iter_mut() {
        // 手写或其他工具生成的文件可能缺字段，补齐后前端才能正常显示
        if !node.get("id").is_some_and(Value::is_string) {
            node["id"] = json!(new_id());
        }
        for (key, fallback) in [("x", 0.0), ("y", 0.0), ("width", 250.0), ("height", 60.0)] {
            node[key] = number(node, key, fallback);
        }
        if node.get("type").and_then(Value::as_str) != Some("file") {
            continue;
        }
        let file = node.get("file").and_then(Value::as_str).unwrap_or_default().to_string();
        let created = node.pointer("/lattira/createdAt").and_then(Value::as_i64).unwrap_or(now);
        let updated = node.pointer("/lattira/updatedAt").and_then(Value::as_i64).unwrap_or(now);
        // 所在的文件夹（栖页画布里放在文件夹中的卡片）
        let parent = node.pointer("/lattira/parent").cloned();
        let mut lattira = match locate(&file, base, scope) {
            Some(src) => {
                let asset = commands::import_file(ws, &src)?;
                let kind = if asset.mime.starts_with("image/") { "image" } else { "file" };
                node["file"] = json!(asset.path);
                json!({ "type": kind, "assetId": asset.id, "createdAt": created, "updatedAt": updated })
            }
            None => {
                // 找不到的文件变成文本卡片，写明原来的路径
                let obj = node.as_object_mut().ok_or_else(invalid)?;
                obj.remove("file");
                obj.insert("type".into(), json!("text"));
                obj.insert("text".into(), json!(format!("找不到文件：{file}")));
                json!({ "type": "text", "createdAt": created, "updatedAt": updated })
            }
        };
        if let Some(parent) = parent {
            lattira["parent"] = parent;
        }
        node["lattira"] = lattira;
    }
    let element_count = nodes.len() as i64;

    let title = path.file_stem().map(|s| s.to_string_lossy().trim().to_string()).filter(|s| !s.is_empty());
    let title = title.unwrap_or_else(|| "导入的画布".into());
    // 项目里已有同名画布时加上「(2)」
    let title = commands::unique_canvas_title(&ws.conn, project_id, &title, None)?;
    let dir = ws.root.join("projects").join(commands::project_dir(&ws.conn, project_id)?);
    fs::create_dir_all(&dir)?;
    let dest = files::unique_path(&dir, &files::sanitize(&title), "canvas", None);
    files::write_atomic(&dest, serde_json::to_string_pretty(&doc)?.as_bytes())?;
    let id = new_id();
    ws.conn.execute(
        "INSERT INTO canvases (id, project_id, title, file, element_count, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, project_id, title, ws.rel(&dest), element_count, now],
    )?;
    commands::get_canvas(&ws.conn, &id)
}

fn import_one(state: &AppState, project_id: &str, path: &Path, tmp: &Path) -> Result<Vec<CanvasMeta>> {
    let is_zip = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip"));
    if !is_zip {
        return Ok(vec![state.with(|ws| import_canvas_file(ws, project_id, path, None))?]);
    }
    let dir = tmp.join(format!("import-{}", new_id()));
    let result = (|| {
        let canvases = extract_package(path, &dir)?;
        if canvases.is_empty() {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            return Err(Error::Invalid(format!("「{name}」里没有 .canvas 画布文件")));
        }
        canvases
            .iter()
            .map(|c| state.with(|ws| import_canvas_file(ws, project_id, c, Some(&dir))))
            .collect::<Result<Vec<_>>>()
    })();
    let _ = fs::remove_dir_all(&dir);
    result
}

/// 导入画布包（.zip）或 .canvas 文件到项目
#[tauri::command]
pub async fn import_canvases(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    paths: Vec<String>,
) -> Result<Vec<CanvasMeta>> {
    let root = state.with(|ws| {
        commands::project_dir(&ws.conn, &project_id)?;
        Ok(ws.root.clone())
    })?;
    let tmp = root.join(".lattira").join("tmp");
    let mut out = Vec::new();
    for p in &paths {
        out.extend(import_one(&state, &project_id, Path::new(p), &tmp)?);
    }
    ocr::schedule(app, root);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_then_import_roundtrip() {
        let dir = std::env::temp_dir().join(format!("lattira-transfer-{}", new_id()));
        fs::create_dir_all(dir.join("ws")).unwrap();
        let (ws, _) = Workspace::open(&dir.join("ws")).unwrap();
        let project: String = ws.conn.query_row("SELECT id FROM projects WHERE is_inbox = 1", [], |r| r.get(0)).unwrap();

        // 一个引用了图片的画布
        let src = dir.join("截图.png");
        fs::write(&src, "png-bytes").unwrap();
        let asset = commands::import_file(&ws, &src).unwrap();
        let doc = json!({
            "nodes": [
                { "id": "t", "type": "text", "text": "说明", "x": 0, "y": 0, "width": 200, "height": 80 },
                { "id": "i", "type": "file", "file": asset.path, "x": 300, "y": 0, "width": 200, "height": 120,
                  "lattira": { "type": "image", "assetId": asset.id, "createdAt": 1, "updatedAt": 2 } },
                { "id": "j", "type": "file", "file": asset.path, "x": 600, "y": 0, "width": 200, "height": 120,
                  "lattira": { "type": "image", "assetId": asset.id, "createdAt": 1, "updatedAt": 2 } }
            ],
            "edges": [{ "id": "e", "fromNode": "t", "toNode": "i" }]
        });

        let package = dir.join("导出.zip");
        let packed = vec![("assets/截图.png".to_string(), ws.abs(&asset.path))];
        let mut exported = doc.clone();
        for n in exported["nodes"].as_array_mut().unwrap().iter_mut().skip(1) {
            n["file"] = json!("assets/截图.png");
        }
        write_package(&package, "竞品/对比", &exported, &packed).unwrap();

        // 同一内容的文件导入后与现有资源合并，卡片指向现有资源
        let tmp = dir.join("tmp");
        let state = AppState::default();
        *state.ws.lock().unwrap() = Some(ws);
        let metas = import_one(&state, &project, &package, &tmp).unwrap();
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].title, "竞品_对比");
        state
            .with(|ws| {
                let file = commands::canvas_file(&ws.conn, &metas[0].id)?;
                let saved: Value = serde_json::from_str(&fs::read_to_string(ws.abs(&file))?)?;
                assert_eq!(saved["nodes"][1]["lattira"]["assetId"], json!(asset.id));
                assert_eq!(saved["nodes"][2]["lattira"]["assetId"], json!(asset.id));
                assert_eq!(saved["nodes"][1]["file"], json!(asset.path));
                assert_eq!(saved["edges"].as_array().unwrap().len(), 1);
                Ok(())
            })
            .unwrap();
        assert!(!tmp.read_dir().unwrap().any(|_| true), "临时解压目录应已清理");
        drop(state);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn import_plain_canvas_resolves_vault_paths_and_marks_missing() {
        let dir = std::env::temp_dir().join(format!("lattira-obsidian-{}", new_id()));
        // Obsidian 仓库：画布在子文件夹，文件路径相对仓库根目录
        fs::create_dir_all(dir.join("vault/画布")).unwrap();
        fs::create_dir_all(dir.join("vault/附件")).unwrap();
        fs::write(dir.join("vault/附件/图.png"), "img").unwrap();
        fs::write(
            dir.join("vault/画布/想法.canvas"),
            r#"{"nodes":[
                {"id":"a","type":"file","file":"附件/图.png","x":0,"y":0,"width":100,"height":100,"lattira":{"type":"image","parent":"f"}},
                {"id":"b","type":"file","file":"附件/不存在.pdf","x":0,"y":0,"width":100,"height":100,"lattira":{"type":"file","parent":"f"}},
                {"type":"text","text":"没有 id 和坐标"}
            ]}"#,
        )
        .unwrap();
        fs::create_dir_all(dir.join("ws")).unwrap();
        let (ws, _) = Workspace::open(&dir.join("ws")).unwrap();
        let project: String = ws.conn.query_row("SELECT id FROM projects WHERE is_inbox = 1", [], |r| r.get(0)).unwrap();

        let meta = import_canvas_file(&ws, &project, &dir.join("vault/画布/想法.canvas"), None).unwrap();
        assert_eq!(meta.title, "想法");
        let saved: Value =
            serde_json::from_str(&fs::read_to_string(ws.abs(&commands::canvas_file(&ws.conn, &meta.id).unwrap())).unwrap())
                .unwrap();
        assert_eq!(saved["nodes"][0]["lattira"]["type"], json!("image"));
        assert!(ws.abs(saved["nodes"][0]["file"].as_str().unwrap()).is_file());
        // 放在文件夹里的卡片导入后仍在文件夹里
        assert_eq!(saved["nodes"][0]["lattira"]["parent"], json!("f"));
        assert_eq!(saved["nodes"][1]["lattira"]["parent"], json!("f"));
        assert_eq!(saved["nodes"][1]["type"], json!("text"));
        assert!(saved["nodes"][1]["text"].as_str().unwrap().contains("附件/不存在.pdf"));
        assert!(saved["nodes"][2]["id"].is_string());
        assert_eq!(saved["nodes"][2]["width"], json!(250.0));
        assert!(saved["edges"].is_array());

        // 画布包里的路径不能跳出解压目录
        assert!(locate("../附件/图.png", &dir.join("vault/画布"), Some(&dir.join("vault/画布"))).is_none());
        drop(ws);
        fs::remove_dir_all(&dir).ok();
    }
}
