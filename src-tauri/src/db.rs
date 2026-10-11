//! 工作区元数据库：.lattira/lattira.db
//!
//! 画布内容存放在 projects/ 下的 .canvas 文件里，这里只存元数据、索引与编辑记录，
//! 删除这个数据库不会丢失画布和文件（日后可从磁盘重建）。

use rusqlite::Connection;

use crate::error::Result;

/// 每个版本一段迁移脚本，按顺序执行；版本号记录在 PRAGMA user_version
const MIGRATIONS: &[&str] = &[
    r#"
CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL,
    dir         TEXT NOT NULL,              -- projects/ 下的文件夹名
    is_inbox    INTEGER NOT NULL DEFAULT 0,
    pinned      INTEGER NOT NULL DEFAULT 0,
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE canvases (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id),
    title         TEXT NOT NULL,
    file          TEXT NOT NULL,            -- 相对工作区根目录，/ 分隔
    element_count INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    deleted_at    INTEGER
);

CREATE TABLE assets (
    id          TEXT PRIMARY KEY,
    hash        TEXT NOT NULL UNIQUE,       -- SHA-256，用于去重
    path        TEXT NOT NULL,
    name        TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    width       INTEGER,
    height      INTEGER,
    imported_at INTEGER NOT NULL
);

-- 画布引用了哪些资源，保存画布时整体替换
CREATE TABLE asset_refs (
    canvas_id TEXT NOT NULL,
    asset_id  TEXT NOT NULL,
    PRIMARY KEY (canvas_id, asset_id)
);

-- 搜索用的文本索引，保存画布时整体替换
CREATE TABLE element_text (
    canvas_id  TEXT NOT NULL,
    element_id TEXT NOT NULL,
    text       TEXT NOT NULL,
    PRIMARY KEY (canvas_id, element_id)
);

-- 每次有实际变化的保存记一条
CREATE TABLE edit_events (
    id        TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL,
    at        INTEGER NOT NULL,
    added     INTEGER NOT NULL,
    modified  INTEGER NOT NULL,
    removed   INTEGER NOT NULL
);

-- 日历的数据来源：编辑事件按「画布 × 本地日期」聚合
CREATE TABLE canvas_days (
    canvas_id    TEXT NOT NULL,
    date         TEXT NOT NULL,             -- YYYY-MM-DD，本地时区
    change_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (canvas_id, date)
);
CREATE INDEX canvas_days_date ON canvas_days(date);
"#,
    r#"
-- 图片中识别出的文字；NULL 表示尚未识别，空串表示识别过但没有文字
ALTER TABLE assets ADD COLUMN ocr_text TEXT;
-- 画布缩略图数据（前端生成的精简布局 JSON）
ALTER TABLE canvases ADD COLUMN preview TEXT;
"#,
    r#"
-- 项目图标（图标名），为空时显示圆点
ALTER TABLE projects ADD COLUMN icon TEXT;
"#,
    r#"
-- 回收站里的文件：删除时从 assets 移到这里，恢复时再移回去
CREATE TABLE trashed_assets (
    id            TEXT PRIMARY KEY,
    hash          TEXT NOT NULL,
    name          TEXT NOT NULL,
    mime          TEXT NOT NULL,
    size          INTEGER NOT NULL,
    width         INTEGER,
    height        INTEGER,
    imported_at   INTEGER NOT NULL,
    ocr_text      TEXT,
    original_path TEXT NOT NULL,            -- 删除前的位置，恢复时尽量放回原处；空串表示未知
    trash_file    TEXT NOT NULL,            -- 回收站中的文件，相对工作区根目录
    deleted_at    INTEGER NOT NULL
);
"#,
    r#"
-- 文件最后一次登记时的修改时间（毫秒）；用来发现文件被外部程序改过，见 commands::check_asset_changes。
-- 为 NULL 时（升级前导入的）首次检查只记下当前时间
ALTER TABLE assets ADD COLUMN modified_at INTEGER;
"#,
    r#"
ALTER TABLE assets ADD COLUMN ocr_retry_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assets ADD COLUMN ocr_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assets ADD COLUMN trash_snapshot INTEGER NOT NULL DEFAULT 0;
UPDATE assets SET ocr_text=NULL WHERE mime LIKE 'image/%' AND ocr_text='';
CREATE TABLE pending_files(path TEXT PRIMARY KEY);
CREATE INDEX asset_refs_asset ON asset_refs(asset_id);
CREATE VIRTUAL TABLE search_docs USING fts5(canvas_id UNINDEXED, element_id UNINDEXED, asset_id UNINDEXED, kind UNINDEXED, content, tokenize='trigram');
INSERT INTO search_docs SELECT id, NULL, NULL, 'canvas', title FROM canvases;
INSERT INTO search_docs SELECT canvas_id, element_id, NULL, 'text', text FROM element_text;
INSERT INTO search_docs SELECT '', NULL, id, 'file', name FROM assets;
INSERT INTO search_docs SELECT '', NULL, id, 'image', ocr_text FROM assets WHERE ocr_text IS NOT NULL;
CREATE TRIGGER search_canvas_insert AFTER INSERT ON canvases BEGIN
 INSERT INTO search_docs VALUES(new.id,NULL,NULL,'canvas',new.title); END;
CREATE TRIGGER search_canvas_update AFTER UPDATE OF title ON canvases BEGIN
 DELETE FROM search_docs WHERE canvas_id=old.id AND kind='canvas';
 INSERT INTO search_docs VALUES(new.id,NULL,NULL,'canvas',new.title); END;
CREATE TRIGGER search_canvas_delete AFTER DELETE ON canvases BEGIN
 DELETE FROM search_docs WHERE canvas_id=old.id; END;
CREATE TRIGGER search_text_insert AFTER INSERT ON element_text BEGIN
 INSERT INTO search_docs VALUES(new.canvas_id,new.element_id,NULL,'text',new.text); END;
CREATE TRIGGER search_text_delete AFTER DELETE ON element_text BEGIN
 DELETE FROM search_docs WHERE canvas_id=old.canvas_id AND element_id=old.element_id AND kind='text'; END;
CREATE TRIGGER search_asset_insert AFTER INSERT ON assets BEGIN
 INSERT INTO search_docs VALUES('',NULL,new.id,'file',new.name);
 INSERT INTO search_docs VALUES('',NULL,new.id,'image',new.ocr_text); END;
CREATE TRIGGER search_asset_update AFTER UPDATE OF name,ocr_text ON assets BEGIN
 DELETE FROM search_docs WHERE asset_id=old.id;
 INSERT INTO search_docs VALUES('',NULL,new.id,'file',new.name);
 INSERT INTO search_docs VALUES('',NULL,new.id,'image',new.ocr_text); END;
CREATE TRIGGER search_asset_delete AFTER DELETE ON assets BEGIN
 DELETE FROM search_docs WHERE asset_id=old.id; END;
"#,
];

pub fn open(path: &std::path::Path) -> Result<Connection> {
    let mut conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // 后台 OCR 线程使用独立连接写库，遇到锁时等待而不是立即报错
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&mut conn)?;
    Ok(conn)
}

fn migrate(conn: &mut Connection) -> Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (i, sql) in (0_i64..).zip(MIGRATIONS).skip(version.max(0) as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", i + 1)?;
        tx.commit()?;
    }
    Ok(())
}
