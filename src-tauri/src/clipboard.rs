//! 系统剪贴板：复制卡片时同时写入三种格式
//!
//! - 文件列表（CF_HDROP）：与在资源管理器中复制文件相同，可粘贴到微信、邮件、资源管理器
//! - 纯文本（CF_UNICODETEXT）：文本卡片的内容，粘贴到只接受文字的地方
//! - 栖页卡片（自定义格式）：粘贴回画布时保留布局、颜色和连线

use clipboard_win::{options::NoClear, raw, Clipboard};
use serde::Serialize;

use crate::error::{Error, Result};

const CARDS_FORMAT: &str = "Lattira.Cards.v1";
const CF_UNICODETEXT: u32 = 13;
const CF_HDROP: u32 = 15;

fn err(e: impl std::fmt::Display) -> Error {
    Error::Invalid(format!("剪贴板不可用：{e}"))
}

fn cards_format() -> Result<u32> {
    raw::register_format(CARDS_FORMAT)
        .map(|f| f.get())
        .ok_or_else(|| err("无法注册剪贴板格式"))
}

pub fn write(files: &[String], text: Option<&str>, cards: Option<&str>) -> Result<()> {
    let _guard = Clipboard::new_attempts(10).map_err(err)?;
    raw::empty().map_err(err)?;
    if !files.is_empty() {
        raw::set_file_list_with(files, NoClear).map_err(err)?;
    }
    if let Some(text) = text {
        raw::set_string_with(text, NoClear).map_err(err)?;
    }
    if let Some(cards) = cards {
        raw::set_without_clear(cards_format()?, cards.as_bytes()).map_err(err)?;
    }
    Ok(())
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardContent {
    /// 栖页卡片数据（JSON）
    cards: Option<String>,
    /// 剪贴板中的文件路径（例如在资源管理器中复制的文件）
    files: Vec<String>,
    text: Option<String>,
}

pub fn read() -> Result<ClipboardContent> {
    let _guard = Clipboard::new_attempts(10).map_err(err)?;
    let mut content = ClipboardContent::default();

    let fmt = cards_format()?;
    if raw::is_format_avail(fmt) {
        if let Some(size) = raw::size(fmt) {
            let mut buf = vec![0u8; size.get()];
            let n = raw::get(fmt, &mut buf).map_err(err)?;
            buf.truncate(n);
            // 剪贴板内存块可能比数据长，末尾补零
            while buf.last() == Some(&0) {
                buf.pop();
            }
            content.cards = String::from_utf8(buf).ok();
        }
    }
    if raw::is_format_avail(CF_HDROP) {
        raw::get_file_list(&mut content.files).map_err(err)?;
    }
    if raw::is_format_avail(CF_UNICODETEXT) {
        let mut buf = Vec::new();
        raw::get_string(&mut buf).map_err(err)?;
        content.text = String::from_utf8(buf).ok();
    }
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 会临时占用系统剪贴板（结束后恢复原有文字）：`cargo test clipboard -- --ignored`
    #[test]
    #[ignore]
    fn clipboard_roundtrip() {
        let saved = read().ok().and_then(|c| c.text);
        let file = std::env::temp_dir().join("lattira-clipboard-test.txt");
        std::fs::write(&file, "hello").unwrap();
        let path = file.to_string_lossy().into_owned();

        write(
            &[path.clone()],
            Some("卡片文字"),
            Some(r#"{"app":"lattira"}"#),
        )
        .unwrap();
        let c = read().unwrap();
        assert_eq!(c.files, vec![path]);
        assert_eq!(c.text.as_deref(), Some("卡片文字"));
        assert_eq!(c.cards.as_deref(), Some(r#"{"app":"lattira"}"#));

        // 只有文字时不应残留上一次的文件列表
        write(&[], Some("只有文字"), None).unwrap();
        let c = read().unwrap();
        assert!(c.files.is_empty() && c.cards.is_none());
        assert_eq!(c.text.as_deref(), Some("只有文字"));

        if let Some(t) = saved {
            write(&[], Some(&t), None).unwrap();
        }
        std::fs::remove_file(&file).ok();
    }
}
