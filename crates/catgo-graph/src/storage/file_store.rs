use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::core::EngineError;
use crate::graph::run::{ArtifactKind, ArtifactRef};
use crate::storage::traits::ArtifactStore;

/// Stores artifacts on the filesystem under a root directory.
///
/// Layout: `{root}/{run_id}/{node_id}/{filename}`
///
/// Each artifact gets a unique file under the node directory.
/// JSON artifacts are stored as `{name}.json`, files keep their
/// original filename (copied from `src_path`).
pub struct FileArtifactStore {
    root: PathBuf,
}

impl FileArtifactStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Build the directory path for a node's artifacts.
    fn node_dir(&self, run_id: &str, node_id: &str) -> PathBuf {
        self.root.join(run_id).join(node_id)
    }

    /// Ensure the node directory exists, creating it recursively if needed.
    fn ensure_node_dir(&self, run_id: &str, node_id: &str) -> Result<PathBuf, EngineError> {
        let dir = self.node_dir(run_id, node_id);
        fs::create_dir_all(&dir).map_err(|e| EngineError::Storage {
            reason: format!("Failed to create artifact directory {}: {}", dir.display(), e),
        })?;
        Ok(dir)
    }

    /// Infer ArtifactKind from a file extension.
    fn kind_from_extension(path: &Path) -> ArtifactKind {
        match path.extension().and_then(|e| e.to_str()) {
            Some("json") => ArtifactKind::Json,
            Some("png") | Some("jpg") | Some("jpeg") | Some("gif") | Some("svg") => {
                ArtifactKind::Image
            }
            Some("csv") | Some("tsv") => ArtifactKind::Table,
            _ => ArtifactKind::File,
        }
    }
}

impl ArtifactStore for FileArtifactStore {
    fn save_json(
        &self,
        run_id: &str,
        node_id: &str,
        name: &str,
        value: &serde_json::Value,
    ) -> Result<ArtifactRef, EngineError> {
        let dir = self.ensure_node_dir(run_id, node_id)?;
        let filename = format!("{}.json", name);
        let file_path = dir.join(&filename);

        let serialized = serde_json::to_string_pretty(value).map_err(|e| {
            EngineError::Storage {
                reason: format!("Failed to serialize JSON artifact '{}': {}", name, e),
            }
        })?;

        fs::write(&file_path, &serialized).map_err(|e| EngineError::Storage {
            reason: format!("Failed to write artifact {}: {}", file_path.display(), e),
        })?;

        Ok(ArtifactRef {
            id: Uuid::new_v4().to_string(),
            kind: ArtifactKind::Json,
            path: Some(file_path.to_string_lossy().into_owned()),
            uri: None,
            metadata: HashMap::new(),
        })
    }

    fn save_file(
        &self,
        run_id: &str,
        node_id: &str,
        src_path: &str,
    ) -> Result<ArtifactRef, EngineError> {
        let src = Path::new(src_path);
        if !src.exists() {
            return Err(EngineError::Storage {
                reason: format!("Source file does not exist: {}", src_path),
            });
        }

        let filename = src
            .file_name()
            .ok_or_else(|| EngineError::Storage {
                reason: format!("Cannot extract filename from: {}", src_path),
            })?
            .to_string_lossy()
            .into_owned();

        let dir = self.ensure_node_dir(run_id, node_id)?;
        let dest = dir.join(&filename);

        fs::copy(src, &dest).map_err(|e| EngineError::Storage {
            reason: format!(
                "Failed to copy {} -> {}: {}",
                src_path,
                dest.display(),
                e
            ),
        })?;

        Ok(ArtifactRef {
            id: Uuid::new_v4().to_string(),
            kind: Self::kind_from_extension(&dest),
            path: Some(dest.to_string_lossy().into_owned()),
            uri: None,
            metadata: HashMap::new(),
        })
    }

    fn load_json(
        &self,
        run_id: &str,
        node_id: &str,
        name: &str,
    ) -> Result<serde_json::Value, EngineError> {
        let dir = self.node_dir(run_id, node_id);
        let file_path = dir.join(format!("{}.json", name));

        let contents = fs::read_to_string(&file_path).map_err(|e| EngineError::Storage {
            reason: format!("Failed to read artifact {}: {}", file_path.display(), e),
        })?;

        serde_json::from_str(&contents).map_err(|e| EngineError::Storage {
            reason: format!(
                "Failed to parse JSON from {}: {}",
                file_path.display(),
                e
            ),
        })
    }

    fn list_node_artifacts(
        &self,
        run_id: &str,
        node_id: &str,
    ) -> Result<Vec<ArtifactRef>, EngineError> {
        let dir = self.node_dir(run_id, node_id);
        if !dir.exists() {
            return Ok(Vec::new());
        }

        let entries = fs::read_dir(&dir).map_err(|e| EngineError::Storage {
            reason: format!("Failed to read directory {}: {}", dir.display(), e),
        })?;

        let mut artifacts = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|e| EngineError::Storage {
                reason: format!("Failed to read directory entry: {}", e),
            })?;
            let path = entry.path();
            if path.is_file() {
                artifacts.push(ArtifactRef {
                    id: Uuid::new_v4().to_string(),
                    kind: Self::kind_from_extension(&path),
                    path: Some(path.to_string_lossy().into_owned()),
                    uri: None,
                    metadata: HashMap::new(),
                });
            }
        }

        Ok(artifacts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn make_store() -> (TempDir, FileArtifactStore) {
        let tmp = TempDir::new().unwrap();
        let store = FileArtifactStore::new(tmp.path());
        (tmp, store)
    }

    #[test]
    fn test_save_and_load_json() {
        let (_tmp, store) = make_store();
        let value = json!({"energy": -42.5, "converged": true});

        let artifact = store
            .save_json("run-1", "node-a", "result", &value)
            .expect("save_json should succeed");

        assert_eq!(artifact.kind, ArtifactKind::Json);
        assert!(artifact.path.is_some());
        assert!(!artifact.id.is_empty());

        let loaded = store
            .load_json("run-1", "node-a", "result")
            .expect("load_json should succeed");
        assert_eq!(loaded, value);
    }

    #[test]
    fn test_save_file() {
        let (tmp, store) = make_store();

        // Create a source file to copy
        let src_dir = tmp.path().join("sources");
        fs::create_dir_all(&src_dir).unwrap();
        let src_path = src_dir.join("input.csv");
        fs::write(&src_path, "x,y\n1,2\n3,4").unwrap();

        let artifact = store
            .save_file("run-1", "node-b", src_path.to_str().unwrap())
            .expect("save_file should succeed");

        assert_eq!(artifact.kind, ArtifactKind::Table); // .csv -> Table
        assert!(artifact.path.is_some());

        // Verify file was actually copied
        let dest = PathBuf::from(artifact.path.unwrap());
        assert!(dest.exists());
        let contents = fs::read_to_string(&dest).unwrap();
        assert_eq!(contents, "x,y\n1,2\n3,4");
    }

    #[test]
    fn test_save_file_nonexistent_source() {
        let (_tmp, store) = make_store();
        let result = store.save_file("run-1", "node-a", "/nonexistent/file.txt");
        assert!(result.is_err());
    }

    #[test]
    fn test_list_node_artifacts_empty() {
        let (_tmp, store) = make_store();
        let artifacts = store
            .list_node_artifacts("run-1", "node-a")
            .expect("listing empty dir should succeed");
        assert!(artifacts.is_empty());
    }

    #[test]
    fn test_list_node_artifacts_with_files() {
        let (_tmp, store) = make_store();

        // Save a couple of artifacts
        store
            .save_json("run-1", "node-a", "output1", &json!({"a": 1}))
            .unwrap();
        store
            .save_json("run-1", "node-a", "output2", &json!({"b": 2}))
            .unwrap();

        let artifacts = store
            .list_node_artifacts("run-1", "node-a")
            .expect("listing should succeed");
        assert_eq!(artifacts.len(), 2);
        assert!(artifacts.iter().all(|a| a.kind == ArtifactKind::Json));
    }

    #[test]
    fn test_load_json_not_found() {
        let (_tmp, store) = make_store();
        let result = store.load_json("run-1", "node-a", "nonexistent");
        assert!(result.is_err());
    }

    #[test]
    fn test_kind_from_extension() {
        assert_eq!(
            FileArtifactStore::kind_from_extension(Path::new("data.json")),
            ArtifactKind::Json
        );
        assert_eq!(
            FileArtifactStore::kind_from_extension(Path::new("photo.png")),
            ArtifactKind::Image
        );
        assert_eq!(
            FileArtifactStore::kind_from_extension(Path::new("results.csv")),
            ArtifactKind::Table
        );
        assert_eq!(
            FileArtifactStore::kind_from_extension(Path::new("script.py")),
            ArtifactKind::File
        );
        assert_eq!(
            FileArtifactStore::kind_from_extension(Path::new("noext")),
            ArtifactKind::File
        );
    }

    #[test]
    fn test_multiple_runs_isolated() {
        let (_tmp, store) = make_store();

        store
            .save_json("run-1", "node-a", "data", &json!({"run": 1}))
            .unwrap();
        store
            .save_json("run-2", "node-a", "data", &json!({"run": 2}))
            .unwrap();

        let v1 = store.load_json("run-1", "node-a", "data").unwrap();
        let v2 = store.load_json("run-2", "node-a", "data").unwrap();

        assert_eq!(v1, json!({"run": 1}));
        assert_eq!(v2, json!({"run": 2}));
    }

    #[test]
    fn test_save_json_large_payload() {
        let (_tmp, store) = make_store();

        // Build a large JSON object with 1000 keys
        let mut map = serde_json::Map::new();
        for i in 0..1000 {
            map.insert(
                format!("key_{:04}", i),
                json!({
                    "index": i,
                    "value": format!("data_for_key_{}", i),
                    "nested": {"a": i * 2, "b": i * 3}
                }),
            );
        }
        let large_value = serde_json::Value::Object(map);

        // Save the large JSON
        let artifact = store
            .save_json("run-large", "node-a", "big_result", &large_value)
            .expect("save_json with 1000 keys should succeed");
        assert_eq!(artifact.kind, ArtifactKind::Json);

        // Load and verify roundtrip
        let loaded = store
            .load_json("run-large", "node-a", "big_result")
            .expect("load_json for large payload should succeed");
        assert_eq!(loaded, large_value);

        // Spot-check a few keys
        assert_eq!(loaded["key_0000"]["index"], json!(0));
        assert_eq!(loaded["key_0500"]["index"], json!(500));
        assert_eq!(loaded["key_0999"]["index"], json!(999));
        assert_eq!(
            loaded["key_0042"]["value"],
            json!("data_for_key_42")
        );
    }

    #[test]
    fn test_save_and_list_multiple_types() {
        let (tmp, store) = make_store();

        // Save a JSON artifact
        let json_artifact = store
            .save_json("run-multi", "node-a", "output", &json!({"result": 42}))
            .expect("save_json should succeed");
        assert_eq!(json_artifact.kind, ArtifactKind::Json);

        // Create a source file to copy
        let src_dir = tmp.path().join("sources");
        fs::create_dir_all(&src_dir).unwrap();
        let src_file = src_dir.join("POSCAR");
        fs::write(&src_file, "Si2\n1.0\n5.43 0.0 0.0\n0.0 5.43 0.0\n0.0 0.0 5.43\nSi\n2\nDirect\n0.0 0.0 0.0\n0.5 0.5 0.5\n").unwrap();

        // Save a file artifact
        let file_artifact = store
            .save_file("run-multi", "node-a", src_file.to_str().unwrap())
            .expect("save_file should succeed");
        assert_eq!(file_artifact.kind, ArtifactKind::File);

        // List all artifacts for node-a in run-multi
        let artifacts = store
            .list_node_artifacts("run-multi", "node-a")
            .expect("list_node_artifacts should succeed");
        assert_eq!(
            artifacts.len(),
            2,
            "Should have exactly 2 artifacts (1 JSON + 1 file)"
        );

        // Verify the kinds present
        let kinds: Vec<&ArtifactKind> = artifacts.iter().map(|a| &a.kind).collect();
        assert!(
            kinds.contains(&&ArtifactKind::Json),
            "Should contain a JSON artifact"
        );
        assert!(
            kinds.contains(&&ArtifactKind::File),
            "Should contain a File artifact"
        );

        // Verify JSON data is still loadable
        let loaded_json = store
            .load_json("run-multi", "node-a", "output")
            .expect("load_json should still work");
        assert_eq!(loaded_json, json!({"result": 42}));
    }
}
