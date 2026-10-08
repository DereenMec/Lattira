//! 文件名与磁盘写入相关的小工具

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::Result;

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1",
    "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// 把任意标题变成 Windows 上合法的文件名（不含扩展名）
pub fn sanitize(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect();
    s = s.trim().trim_end_matches(['.', ' ']).to_string();
    if s.chars().count() > 80 {
        s = s.chars().take(80).collect();
    }
    if s.is_empty() {
        s = "未命名".into();
    }
    if RESERVED.contains(&s.to_uppercase().as_str()) {
        s.push('_');
    }
    s
}

/// 在 dir 下找一个不冲突的文件名：name.ext、name (2).ext……
/// `allow` 为当前文件自身的路径（重命名时它不算冲突）
pub fn unique_path(dir: &Path, stem: &str, ext: &str, allow: Option<&Path>) -> PathBuf {
    let make = |n: usize| {
        let base = if n == 1 { stem.to_string() } else { format!("{stem} ({n})") };
        dir.join(if ext.is_empty() { base } else { format!("{base}.{ext}") })
    };
    let mut n = 1;
    loop {
        let p = make(n);
        let taken = p.exists() && allow.is_none_or(|a| !same_path(a, &p));
        if !taken {
            return p;
        }
        n += 1;
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

/// 先写临时文件再改名，避免写到一半断电导致画布文件损坏
pub fn write_atomic(path: &Path, content: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// 相对路径（/ 分隔）转绝对路径
pub fn resolve(root: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(root.to_path_buf(), |p, part| p.join(part))
}

/// 绝对路径转相对路径（/ 分隔）
pub fn relative(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .unwrap_or(abs)
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}
