//! 图片文字识别：使用 Windows 自带的 OCR 引擎（Windows.Media.Ocr），离线、免费。
//!
//! 导入图片后在后台线程逐张识别，结果写入 assets.ocr_text，供全局搜索使用。
//! 识别语言取决于系统已安装的 OCR 语言包（中文系统默认带简体中文）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, Emitter};
use windows::core::HSTRING;
use windows::Graphics::Imaging::{
    BitmapAlphaMode, BitmapDecoder, BitmapInterpolationMode, BitmapPixelFormat, BitmapTransform, ColorManagementMode,
    ExifOrientationMode,
};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::{FileAccessMode, StorageFile};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

use crate::db;
use crate::files;

/// Windows 图像解码器（WIC）能读取的格式
pub const OCR_MIMES: &[&str] = &["image/png", "image/jpeg", "image/bmp", "image/gif", "image/tiff", "image/webp"];

/// 识别完一张图片后通知前端刷新资源信息
pub const EVENT_ASSET_UPDATED: &str = "asset-updated";

static RUNNING: AtomicBool = AtomicBool::new(false);

/// 在后台处理工作区里所有尚未识别的图片；已在运行时直接返回（运行中的线程会接着处理新加入的图片）
pub fn schedule(app: AppHandle, root: PathBuf) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        // WinRT 调用需要先初始化线程的套间
        unsafe {
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
        }
        loop {
            if let Err(e) = drain(&app, &root) {
                eprintln!("[ocr] 后台识别中断：{e}");
            }
            RUNNING.store(false, Ordering::SeqCst);
            // 收尾时再检查一次，避免刚好在退出前导入的图片被漏掉
            let more = db::open(&root.join(".lattira").join("lattira.db"))
                .ok()
                .and_then(|c| next_pending(&c).ok().flatten())
                .is_some();
            if !more || RUNNING.swap(true, Ordering::SeqCst) {
                break;
            }
        }
    });
}

fn next_pending(conn: &Connection) -> rusqlite::Result<Option<(String, String)>> {
    let placeholders = OCR_MIMES.iter().map(|m| format!("'{m}'")).collect::<Vec<_>>().join(",");
    conn.query_row(
        &format!(
            "SELECT id, path FROM assets WHERE ocr_text IS NULL AND mime IN ({placeholders})
             ORDER BY imported_at DESC LIMIT 1"
        ),
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
}

fn drain(app: &AppHandle, root: &Path) -> crate::error::Result<()> {
    let conn = db::open(&root.join(".lattira").join("lattira.db"))?;
    while let Some((id, rel)) = next_pending(&conn)? {
        let text = match recognize(&files::resolve(root, &rel)) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("[ocr] {rel} 识别失败：{e}");
                String::new() // 记为空串，不再重试
            }
        };
        conn.execute("UPDATE assets SET ocr_text = ?2 WHERE id = ?1", params![id, text])?;
        let _ = app.emit(EVENT_ASSET_UPDATED, &id);
    }
    Ok(())
}

/// 识别一张图片中的文字，按行返回
pub fn recognize(path: &Path) -> windows::core::Result<String> {
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path.as_os_str()))?.join()?;
    let stream = file.OpenAsync(FileAccessMode::Read)?.join()?;
    let decoder = BitmapDecoder::CreateAsync(&stream)?.join()?;

    // 超过引擎上限的大图按比例缩小
    let max = OcrEngine::MaxImageDimension()?;
    let (w, h) = (decoder.OrientedPixelWidth()?, decoder.OrientedPixelHeight()?);
    let transform = BitmapTransform::new()?;
    if w > max || h > max {
        let scale = max as f64 / w.max(h) as f64;
        transform.SetScaledWidth(((w as f64 * scale) as u32).max(1))?;
        transform.SetScaledHeight(((h as f64 * scale) as u32).max(1))?;
        transform.SetInterpolationMode(BitmapInterpolationMode::Fant)?;
    }
    let bitmap = decoder
        .GetSoftwareBitmapTransformedAsync(
            BitmapPixelFormat::Bgra8,
            BitmapAlphaMode::Premultiplied,
            &transform,
            ExifOrientationMode::RespectExifOrientation,
            ColorManagementMode::DoNotColorManage,
        )?
        .join()?;

    let result = engine.RecognizeAsync(&bitmap)?.join()?;
    let mut lines = Vec::new();
    for line in result.Lines()? {
        let text = collapse_cjk_spaces(&line.Text()?.to_string());
        if !text.trim().is_empty() {
            lines.push(text);
        }
    }
    Ok(lines.join("\n"))
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3000..=0x303F | 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF)
}

/// Windows OCR 会在中文字之间插入空格，去掉它们，搜索「项目计划」才能命中
pub fn collapse_cjk_spaces(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    for (i, &c) in chars.iter().enumerate() {
        if c == ' ' {
            let prev = out.chars().last();
            let next = chars[i + 1..].iter().find(|&&n| n != ' ').copied();
            if let (Some(p), Some(n)) = (prev, next) {
                if is_cjk(p) || is_cjk(n) {
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_spaces_between_cjk() {
        assert_eq!(collapse_cjk_spaces("项 目 计 划 Q3"), "项目计划Q3");
        assert_eq!(collapse_cjk_spaces("hello world"), "hello world");
        assert_eq!(collapse_cjk_spaces("版本 v0.1 发布"), "版本v0.1发布");
    }
}
