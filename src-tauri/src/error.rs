use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("尚未打开工作区")]
    NoWorkspace,
    #[error("找不到{0}：{1}")]
    NotFound(&'static str, String),
    #[error("{0}")]
    Invalid(String),
    #[error("文件操作失败：{0}")]
    Io(#[from] std::io::Error),
    #[error("数据库错误：{0}")]
    Db(#[from] rusqlite::Error),
    #[error("JSON 解析失败：{0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Tauri(#[from] tauri::Error),
}

/// 命令返回的错误以字符串形式交给前端
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
