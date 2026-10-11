//! Durable undo journal joining filesystem mutations to the SQLite transaction.
use crate::error::Result;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{
    cell::RefCell,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
enum Undo {
    File {
        path: PathBuf,
        backup: Option<PathBuf>,
    },
    Move {
        from: PathBuf,
        to: PathBuf,
    },
}
struct Journal {
    root: PathBuf,
    dir: PathBuf,
    id: String,
    ops: Vec<Undo>,
}
thread_local! { static CURRENT: RefCell<Option<Journal>> = const { RefCell::new(None) }; }

fn persist(j: &Journal) -> Result<()> {
    fs::create_dir_all(&j.dir)?;
    let mut f = fs::File::create(j.dir.join("undo.new"))?;
    f.write_all(&serde_json::to_vec(&j.ops)?)?;
    f.sync_all()?;
    fs::rename(j.dir.join("undo.new"), j.dir.join("undo.json"))?;
    Ok(())
}

pub fn before(path: &Path) -> Result<()> {
    CURRENT.with(|slot| -> Result<()> {
        let mut slot = slot.borrow_mut();
        let Some(j) = slot.as_mut() else {
            return Ok(());
        };
        if !path.starts_with(&j.root) || path.starts_with(&j.dir) {
            return Ok(());
        }
        fs::create_dir_all(&j.dir)?;
        let backup = if path.is_file() {
            let backup = j.dir.join(format!("{}.bak", j.ops.len()));
            fs::copy(path, &backup)?;
            crate::files::sync_file(&backup)?;
            Some(backup)
        } else {
            None
        };
        j.ops.push(Undo::File {
            path: path.to_path_buf(),
            backup,
        });
        persist(j)
    })
}

pub fn rename(from: impl AsRef<Path>, to: impl AsRef<Path>) -> std::io::Result<()> {
    let (from, to) = (from.as_ref(), to.as_ref());
    if from.is_dir() {
        CURRENT
            .with(|slot| -> Result<()> {
                let mut slot = slot.borrow_mut();
                if let Some(j) = slot.as_mut() {
                    if from.starts_with(&j.root) && to.starts_with(&j.root) {
                        j.ops.push(Undo::Move {
                            from: from.to_path_buf(),
                            to: to.to_path_buf(),
                        });
                        persist(j)?;
                    }
                }
                Ok(())
            })
            .map_err(std::io::Error::other)?;
    } else {
        before(from).map_err(std::io::Error::other)?;
        before(to).map_err(std::io::Error::other)?;
    }
    fs::rename(from, to)
}

pub fn copy(from: impl AsRef<Path>, to: impl AsRef<Path>) -> std::io::Result<u64> {
    before(to.as_ref()).map_err(std::io::Error::other)?;
    let size = fs::copy(from, to.as_ref())?;
    crate::files::sync_file(to.as_ref())?;
    Ok(size)
}
pub fn remove_file(path: impl AsRef<Path>) -> std::io::Result<()> {
    before(path.as_ref()).map_err(std::io::Error::other)?;
    fs::remove_file(path)
}
pub fn create(path: impl AsRef<Path>) -> std::io::Result<fs::File> {
    before(path.as_ref()).map_err(std::io::Error::other)?;
    fs::File::create(path)
}

fn undo(ops: &[Undo]) -> Result<()> {
    for op in ops.iter().rev() {
        match op {
            Undo::File { path, backup } => {
                if let Some(backup) = backup {
                    if let Some(parent) = path.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    fs::copy(backup, path)?;
                    crate::files::sync_file(path)?;
                } else if path.is_file() {
                    fs::remove_file(path)?;
                }
            }
            Undo::Move { from, to } => {
                if to.exists() && !from.exists() {
                    fs::rename(to, from)?;
                }
            }
        }
    }
    Ok(())
}

pub fn recover(root: &Path, conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS file_commits(id TEXT PRIMARY KEY)")?;
    let base = root.join(".lattira/transactions");
    if !base.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(base)? {
        let dir = entry?.path();
        if !dir.is_dir() {
            continue;
        }
        let id = dir.file_name().unwrap_or_default().to_string_lossy();
        let committed: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM file_commits WHERE id=?1)",
            [id.as_ref()],
            |r| r.get(0),
        )?;
        let log = dir.join("undo.json");
        if !committed && log.exists() {
            undo(&serde_json::from_slice::<Vec<Undo>>(&fs::read(log)?)?)?;
        }
        fs::remove_dir_all(&dir)?;
        conn.execute("DELETE FROM file_commits WHERE id=?1", [id.as_ref()])?;
    }
    Ok(())
}

pub fn run<T>(
    ws: &mut crate::workspace::Workspace,
    f: impl FnOnce(&mut crate::workspace::Workspace) -> Result<T>,
) -> Result<T> {
    let root = &ws.root;
    let id = crate::workspace::new_id();
    CURRENT.with(|slot| {
        *slot.borrow_mut() = Some(Journal {
            root: root.to_path_buf(),
            dir: root.join(".lattira/transactions").join(&id),
            id,
            ops: vec![],
        })
    });
    ws.conn.execute_batch("SAVEPOINT file_operation")?;
    let result = f(ws);
    let journal = CURRENT.with(|slot| slot.borrow_mut().take().unwrap());
    let result = match result {
        Ok(value) => {
            let commit = (|| -> Result<()> {
                if !journal.ops.is_empty() {
                    ws.conn
                        .execute("INSERT INTO file_commits(id) VALUES(?1)", [&journal.id])?;
                }
                ws.conn.execute_batch("RELEASE file_operation")?;
                Ok(())
            })();
            commit.map(|()| value)
        }
        Err(e) => Err(e),
    };
    if result.is_err() {
        ws.conn
            .execute_batch("ROLLBACK TO file_operation; RELEASE file_operation")?;
        undo(&journal.ops)?;
    }
    // The mutation is already committed. A cleanup failure leaves its commit
    // marker for recovery on the next open, rather than reporting a false failure.
    let cleanup = (|| -> Result<()> {
        if journal.dir.exists() {
            fs::remove_dir_all(&journal.dir)?;
        }
        if !journal.ops.is_empty() {
            ws.conn
                .execute("DELETE FROM file_commits WHERE id=?1", [&journal.id])?;
        }
        Ok(())
    })();
    if let Err(e) = cleanup {
        eprintln!("[journal] cleanup deferred: {e}");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        error::Error,
        files,
        workspace::{new_id, Workspace},
    };
    fn workspace() -> (PathBuf, Workspace) {
        let root = std::env::temp_dir().join(format!("lattira-journal-{}", new_id()));
        fs::create_dir_all(&root).unwrap();
        let ws = Workspace::open(&root).unwrap().0;
        (root, ws)
    }
    #[test]
    fn failed_database_write_restores_files_and_metadata() {
        let (root, mut ws) = workspace();
        let original = root.join("original.txt");
        let moved = root.join("moved.txt");
        fs::write(&original, "original").unwrap();
        let result = run(&mut ws, |ws| -> Result<()> {
            files::write_atomic(&original, b"draft")?;
            rename(&original, &moved)?;
            ws.conn.execute("UPDATE projects SET name='broken'", [])?;
            Err(Error::Invalid("injected failure".into()))
        });
        assert_eq!(result.unwrap_err().to_string(), "injected failure");
        assert_eq!(fs::read_to_string(&original).unwrap(), "original");
        assert!(!moved.exists());
        let name: String = ws
            .conn
            .query_row("SELECT name FROM projects WHERE is_inbox=1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(name, "未分类");
        drop(ws);
        fs::remove_dir_all(root).unwrap();
    }
    fn interrupted(ws: &Workspace) -> PathBuf {
        let id = new_id();
        let dir = ws.root.join(".lattira/transactions").join(&id);
        CURRENT.with(|slot| {
            *slot.borrow_mut() = Some(Journal {
                root: ws.root.clone(),
                dir: dir.clone(),
                id,
                ops: vec![],
            })
        });
        dir
    }
    #[test]
    fn restart_rolls_back_uncommitted_files() {
        let (root, ws) = workspace();
        let path = root.join("notes.canvas");
        fs::write(&path, "old").unwrap();
        interrupted(&ws);
        files::write_atomic(&path, b"new").unwrap();
        CURRENT.with(|slot| slot.borrow_mut().take());
        drop(ws);
        let ws = Workspace::open(&root).unwrap().0;
        assert_eq!(fs::read_to_string(path).unwrap(), "old");
        drop(ws);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn restart_keeps_committed_files() {
        let (root, ws) = workspace();
        let path = root.join("notes.canvas");
        fs::write(&path, "old").unwrap();
        let dir = interrupted(&ws);
        files::write_atomic(&path, b"new").unwrap();
        let journal = CURRENT.with(|slot| slot.borrow_mut().take().unwrap());
        ws.conn
            .execute("INSERT INTO file_commits VALUES(?1)", [journal.id])
            .unwrap();
        drop(ws);
        let ws = Workspace::open(&root).unwrap().0;
        assert_eq!(fs::read_to_string(path).unwrap(), "new");
        assert!(!dir.exists());
        drop(ws);
        fs::remove_dir_all(root).unwrap();
    }
}
