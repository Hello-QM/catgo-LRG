//! Filesystem commands: browse, read, write, mkdir, delete, rename, copy, move.

use serde::Serialize;
use std::path::{Path, PathBuf};

use super::util::expand_tilde;

// ---------------------------------------------------------------------------
// Serde types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct BrowseItem {
    pub name: String,
    #[serde(rename = "type")]
    pub item_type: String,
    pub path: String,
}

#[derive(Serialize)]
pub struct BrowseResult {
    pub dir: String,
    pub parent: String,
    pub items: Vec<BrowseItem>,
}

#[derive(Serialize)]
pub struct FileBrowseItem {
    pub name: String,
    #[serde(rename = "type")]
    pub item_type: String, // "dir" or "file"
    pub path: String,
}

#[derive(Serialize)]
pub struct FileBrowseResult {
    pub dir: String,
    pub parent: String,
    pub items: Vec<FileBrowseItem>,
}

#[derive(Serialize)]
pub struct FileReadResult {
    pub path: String,
    pub name: String,
    pub content: String,
}

#[derive(Serialize)]
pub struct FileWriteResult {
    pub path: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct FileOpResult {
    pub success: bool,
    pub message: String,
}

fn path_to_ui_string(path: &Path) -> String {
    strip_windows_verbatim_prefix(&path.to_string_lossy())
}

fn strip_windows_verbatim_prefix(path: &str) -> String {
    if cfg!(windows) {
        if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = path.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::strip_windows_verbatim_prefix;

    #[test]
    fn strips_windows_verbatim_drive_prefix_for_ui() {
        let input = r"\\?\E:\Projects\example\data";
        let expected = if cfg!(windows) {
            r"E:\Projects\example\data"
        } else {
            input
        };
        assert_eq!(strip_windows_verbatim_prefix(input), expected);
    }
}

// ---------------------------------------------------------------------------
// Tauri commands: DB browse directory
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn db_browse_directory(dir: Option<String>) -> Result<BrowseResult, String> {
    let target_str = dir.unwrap_or_else(|| "~".to_string());
    let target = if target_str.starts_with('~') {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/"))
            .join(target_str.trim_start_matches('~').trim_start_matches('/'))
    } else {
        PathBuf::from(&target_str)
    };
    let target = target
        .canonicalize()
        .unwrap_or_else(|_| target.clone());

    if !target.is_dir() {
        return Err(format!("Not a directory: {}", target.display()));
    }

    let mut items: Vec<BrowseItem> = Vec::new();
    let entries = std::fs::read_dir(&target).map_err(|e| format!("readdir: {e}"))?;
    let mut sorted: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    sorted.sort_by(|a, b| {
        let a_dir = a.path().is_dir();
        let b_dir = b.path().is_dir();
        if a_dir != b_dir {
            return if a_dir {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        a.file_name()
            .to_ascii_lowercase()
            .cmp(&b.file_name().to_ascii_lowercase())
    });

    for entry in sorted {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            items.push(BrowseItem {
                name,
                item_type: "dir".to_string(),
                path: path_to_ui_string(&path),
            });
        } else if let Some(ext) = path.extension() {
            let ext_lower = ext.to_string_lossy().to_lowercase();
            if ext_lower == "db" || ext_lower == "sqlite" || ext_lower == "sqlite3" {
                items.push(BrowseItem {
                    name,
                    item_type: "file".to_string(),
                    path: path_to_ui_string(&path),
                });
            }
        }
    }

    let parent = path_to_ui_string(target.parent().unwrap_or(&target));

    Ok(BrowseResult {
        dir: path_to_ui_string(&target),
        parent,
        items,
    })
}

// ---------------------------------------------------------------------------
// Tauri commands: File browsing / read / write
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn db_browse_files(dir: Option<String>) -> Result<FileBrowseResult, String> {
    let dir_str = dir.unwrap_or_else(|| "~".to_string());
    let path = expand_tilde(&dir_str);
    let canonical = std::fs::canonicalize(&path).map_err(|e| format!("resolve path: {e}"))?;

    let parent = canonical
        .parent()
        .map(path_to_ui_string)
        .unwrap_or_default();

    let mut items = Vec::new();
    let entries = std::fs::read_dir(&canonical).map_err(|e| format!("read dir: {e}"))?;
    for entry in entries.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden files
        if name.starts_with('.') {
            continue;
        }
        items.push(FileBrowseItem {
            name: name.clone(),
            item_type: if meta.is_dir() {
                "dir".to_string()
            } else {
                "file".to_string()
            },
            path: path_to_ui_string(&entry.path()),
        });
    }
    // Sort: directories first, then files, alphabetically
    items.sort_by(|a, b| {
        let dir_cmp = (a.item_type == "file").cmp(&(b.item_type == "file"));
        dir_cmp.then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(FileBrowseResult {
        dir: path_to_ui_string(&canonical),
        parent,
        items,
    })
}

#[tauri::command]
pub fn db_read_file(path: String) -> Result<FileReadResult, String> {
    let p = expand_tilde(&path);
    let content = std::fs::read_to_string(&p).map_err(|e| format!("read file: {e}"))?;
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(FileReadResult {
        path: p.to_string_lossy().to_string(),
        name,
        content,
    })
}

#[tauri::command]
pub fn db_write_file(path: String, content: String) -> Result<FileWriteResult, String> {
    let p = expand_tilde(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create parent dirs: {e}"))?;
    }
    std::fs::write(&p, &content).map_err(|e| format!("write file: {e}"))?;
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(FileWriteResult {
        path: p.to_string_lossy().to_string(),
        name,
    })
}

// ---------------------------------------------------------------------------
// Tauri commands: Filesystem operations
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn db_fs_mkdir(path: String) -> Result<FileOpResult, String> {
    let p = expand_tilde(&path);
    std::fs::create_dir_all(&p).map_err(|e| format!("mkdir: {e}"))?;
    Ok(FileOpResult {
        success: true,
        message: format!("Created {}", p.to_string_lossy()),
    })
}

#[tauri::command]
pub fn db_fs_delete(path: String) -> Result<FileOpResult, String> {
    let p = expand_tilde(&path);
    let meta = std::fs::metadata(&p).map_err(|e| format!("stat: {e}"))?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| format!("rmdir: {e}"))?;
    } else {
        std::fs::remove_file(&p).map_err(|e| format!("rm: {e}"))?;
    }
    Ok(FileOpResult {
        success: true,
        message: format!("Deleted {}", p.to_string_lossy()),
    })
}

#[tauri::command]
pub fn db_fs_rename(old_path: String, new_path: String) -> Result<FileOpResult, String> {
    let old = expand_tilde(&old_path);
    let new = expand_tilde(&new_path);
    std::fs::rename(&old, &new).map_err(|e| format!("rename: {e}"))?;
    Ok(FileOpResult {
        success: true,
        message: format!("Renamed to {}", new.to_string_lossy()),
    })
}

#[tauri::command]
pub fn db_fs_copy(source: String, destination: String) -> Result<FileOpResult, String> {
    let src = expand_tilde(&source);
    let dst = expand_tilde(&destination);
    std::fs::copy(&src, &dst).map_err(|e| format!("copy: {e}"))?;
    Ok(FileOpResult {
        success: true,
        message: format!("Copied to {}", dst.to_string_lossy()),
    })
}

#[tauri::command]
pub fn db_fs_move(source: String, destination: String) -> Result<FileOpResult, String> {
    let src = expand_tilde(&source);
    let dst = expand_tilde(&destination);
    std::fs::rename(&src, &dst).map_err(|e| format!("move: {e}"))?;
    Ok(FileOpResult {
        success: true,
        message: format!("Moved to {}", dst.to_string_lossy()),
    })
}
