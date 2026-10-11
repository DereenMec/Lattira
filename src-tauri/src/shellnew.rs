//! Windows 右键菜单「新建」里能新建的文件类型，与资源管理器保持一致。
//!
//! 资源管理器的「新建」菜单来自注册表：HKEY_CLASSES_ROOT\.扩展名\ProgID\ShellNew（或 .扩展名\ShellNew），
//! 其中 NullFile 表示新建空文件，Data 是新文件的内容，FileName 是模板文件（Office 等用这种）。
//! 需要运行程序或向导才能新建的（Command / Handler，如快捷方式、联系人）、只在库里出现的（Config\IsOptIn）、
//! 新建出来是文件夹的（Config\IsFolder），栖页里做不了，不列出。
//! 「文件夹」和「快捷方式」在栖页里分别对应画布上的文件夹和链接卡片，由前端菜单提供。

use std::path::{Path, PathBuf};

use serde::Serialize;
use windows::core::{HSTRING, PWSTR};
use windows::Win32::Foundation::{ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};
use windows::Win32::System::Environment::ExpandEnvironmentStringsW;
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CLASSES_ROOT, KEY_READ,
    REG_BINARY, REG_EXPAND_SZ, REG_SZ, REG_VALUE_TYPE,
};
use windows::Win32::UI::Shell::SHLoadIndirectString;

/// 一种可以新建的文件
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NewFileType {
    /// 扩展名，小写，带点，如 ".docx"
    pub ext: String,
    /// 菜单里显示的名字，如「Microsoft Word 文档」（随系统语言）
    pub name: String,
}

/// 新文件的内容从哪里来
#[derive(Debug)]
pub enum Template {
    Empty,
    Bytes(Vec<u8>),
    File(PathBuf),
}

/// 注册表项，离开作用域时关闭
struct Key(HKEY);

impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}

impl Key {
    fn open(parent: HKEY, sub: &str) -> Option<Key> {
        let mut h = HKEY::default();
        let err = unsafe { RegOpenKeyExW(parent, &HSTRING::from(sub), Some(0), KEY_READ, &mut h) };
        (err == ERROR_SUCCESS).then_some(Key(h))
    }

    fn classes_root() -> Option<Key> {
        Key::open(HKEY_CLASSES_ROOT, "")
    }

    fn sub(&self, name: &str) -> Option<Key> {
        Key::open(self.0, name)
    }

    fn subkeys(&self) -> Vec<String> {
        let mut out = Vec::new();
        let mut buf = [0u16; 256];
        for i in 0.. {
            let mut len = buf.len() as u32;
            let err = unsafe {
                RegEnumKeyExW(
                    self.0,
                    i,
                    Some(PWSTR(buf.as_mut_ptr())),
                    &mut len,
                    None,
                    None,
                    None,
                    None,
                )
            };
            if err == ERROR_NO_MORE_ITEMS {
                break;
            }
            // 名字超过 255 个字符的项不会是扩展名，跳过
            if err == ERROR_SUCCESS {
                out.push(String::from_utf16_lossy(&buf[..len as usize]));
            }
        }
        out
    }

    /// 值的类型和原始数据；name 为空串时是默认值。值名不区分大小写
    fn raw(&self, name: &str) -> Option<(REG_VALUE_TYPE, Vec<u8>)> {
        let name = HSTRING::from(name);
        let mut ty = REG_VALUE_TYPE::default();
        let mut size = 0u32;
        let err =
            unsafe { RegQueryValueExW(self.0, &name, None, Some(&mut ty), None, Some(&mut size)) };
        if err != ERROR_SUCCESS {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        let err = unsafe {
            RegQueryValueExW(
                self.0,
                &name,
                None,
                Some(&mut ty),
                Some(data.as_mut_ptr()),
                Some(&mut size),
            )
        };
        if err != ERROR_SUCCESS {
            return None;
        }
        data.truncate(size as usize);
        Some((ty, data))
    }

    fn has(&self, name: &str) -> bool {
        self.raw(name).is_some()
    }

    /// 字符串值；REG_EXPAND_SZ 中的 %环境变量% 会展开
    fn string(&self, name: &str) -> Option<String> {
        let (ty, data) = self.raw(name)?;
        if ty != REG_SZ && ty != REG_EXPAND_SZ {
            return None;
        }
        let s = utf16(&data);
        Some(if ty == REG_EXPAND_SZ { expand(&s) } else { s })
    }
}

fn utf16(data: &[u8]) -> String {
    let wide: Vec<u16> = data
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&wide)
        .trim_end_matches('\0')
        .to_string()
}

fn expand(s: &str) -> String {
    let src = HSTRING::from(s);
    let mut buf = vec![0u16; 512];
    loop {
        let n = unsafe { ExpandEnvironmentStringsW(&src, Some(&mut buf)) } as usize;
        if n == 0 {
            return s.to_string();
        }
        if n <= buf.len() {
            return String::from_utf16_lossy(&buf[..n - 1]);
        }
        buf.resize(n, 0);
    }
}

/// 「@文件.dll,-123」这种指向资源的字符串，读出系统当前语言的文字
fn indirect(s: String) -> Option<String> {
    if !s.starts_with('@') {
        return Some(s);
    }
    let mut buf = [0u16; 512];
    unsafe { SHLoadIndirectString(&HSTRING::from(s.as_str()), &mut buf, None) }.ok()?;
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..len]))
}

/// 模板文件：完整路径，或者在系统的模板文件夹里（与资源管理器查找的位置相同）
fn locate_template(file: &str) -> Option<PathBuf> {
    let p = Path::new(file);
    if p.is_absolute() {
        return p.is_file().then(|| p.to_path_buf());
    }
    let dirs = [
        std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join(r"Microsoft\Windows\Templates")),
        std::env::var_os("ProgramData")
            .map(|d| PathBuf::from(d).join(r"Microsoft\Windows\Templates")),
        std::env::var_os("SystemRoot").map(|d| PathBuf::from(d).join("ShellNew")),
    ];
    dirs.into_iter()
        .flatten()
        .map(|d| d.join(file))
        .find(|f| f.is_file())
}

/// 一个扩展名的「新建」信息；不能在栖页里新建时为 None
fn entry(classes: &Key, ext: &str) -> Option<(NewFileType, Template)> {
    let ext_key = classes.sub(ext)?;
    let progid = ext_key.string("").filter(|p| !p.trim().is_empty());
    let shell_new = progid
        .as_deref()
        .and_then(|p| ext_key.sub(&format!(r"{p}\ShellNew")))
        .or_else(|| ext_key.sub("ShellNew"))?;
    if ["Command", "Handler", "Directory"]
        .iter()
        .any(|v| shell_new.has(v))
    {
        return None;
    }
    if shell_new
        .sub("Config")
        .is_some_and(|c| c.has("IsOptIn") || c.has("IsFolder"))
    {
        return None;
    }
    let template = if let Some((ty, data)) = shell_new.raw("Data") {
        Template::Bytes(if ty == REG_BINARY {
            data
        } else {
            utf16(&data).into_bytes()
        })
    } else if let Some(file) = shell_new.string("FileName") {
        // 模板文件不在了（例如卸载了 Office 但注册表还留着），资源管理器也新建不出来
        Template::File(locate_template(&expand(&file))?)
    } else if shell_new.has("NullFile") {
        Template::Empty
    } else {
        return None;
    };
    let name = shell_new
        .string("MenuText")
        .and_then(indirect)
        .or_else(|| {
            let prog = classes.sub(progid.as_deref()?)?;
            prog.string("FriendlyTypeName")
                .and_then(indirect)
                .or_else(|| prog.string(""))
        })
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())?;
    Some((
        NewFileType {
            ext: ext.to_lowercase(),
            name,
        },
        template,
    ))
}

/// 当前系统「新建」菜单里能在栖页中新建的文件类型，按名字排序
pub fn list() -> Vec<NewFileType> {
    let Some(classes) = Key::classes_root() else {
        return Vec::new();
    };
    let mut out: Vec<NewFileType> = classes
        .subkeys()
        .into_iter()
        .filter(|k| k.starts_with('.') && k.len() > 1)
        .filter_map(|ext| entry(&classes, &ext).map(|(t, _)| t))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out.dedup_by(|a, b| a.ext == b.ext);
    out
}

/// 新建某种文件用的内容；系统里没有这种「新建」项时为 None
pub fn template(ext: &str) -> Option<(NewFileType, Template)> {
    let classes = Key::classes_root()?;
    entry(&classes, ext)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 列出本机「新建」菜单的文件类型（与系统环境有关，手动运行：cargo test shellnew -- --ignored --nocapture）
    #[test]
    #[ignore]
    fn print_new_file_types() {
        let start = std::time::Instant::now();
        let types = list();
        println!("用时 {:?}", start.elapsed());
        for t in &types {
            println!(
                "{} {} {:?}",
                t.ext,
                t.name,
                template(&t.ext).map(|(_, tpl)| tpl)
            );
        }
    }

    #[test]
    fn unknown_extension_has_no_template() {
        assert!(template(".lattira-test-nonexistent").is_none());
        // 快捷方式需要向导，不能直接新建
        assert!(template(".lnk").is_none());
    }
}
