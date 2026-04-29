//! Workflow, project, and folder Tauri commands.

use chrono::Utc;
use rusqlite::{params, types::ToSql};
use serde::Serialize;
use uuid::Uuid;

use super::{get_conn, DbState};

// ---------------------------------------------------------------------------
// Serde types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub ase_db_path: Option<String>,
    pub parent_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub workflow_count: i64,
}

#[derive(Serialize)]
pub struct WorkflowSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub template_id: Option<String>,
    pub project_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub step_count: i64,
    pub completed_steps: i64,
}

#[derive(Serialize)]
pub struct WorkflowFolderSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub parent_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
pub struct ProjectDetail {
    pub id: String,
    pub name: String,
    pub description: String,
    pub ase_db_path: Option<String>,
    pub parent_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub workflows: Vec<ProjectWorkflowEntry>,
}

#[derive(Serialize)]
pub struct ProjectWorkflowEntry {
    pub id: String,
    pub name: String,
    pub status: String,
    pub step_count: i64,
    pub completed_steps: i64,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct WorkflowFolderDetail {
    pub id: String,
    pub name: String,
    pub description: String,
    pub parent_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub workflows: Vec<WorkflowFolderWorkflow>,
}

#[derive(Serialize)]
pub struct WorkflowFolderWorkflow {
    pub id: String,
    pub name: String,
    pub status: String,
    pub step_count: i64,
    pub completed_steps: i64,
}

#[derive(Serialize)]
pub struct WorkflowDetail {
    pub id: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub template_id: Option<String>,
    pub project_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub step_count: i64,
    pub completed_steps: i64,
    pub graph_json: String,
    pub metadata: String,
}

#[derive(Serialize)]
pub struct StepInfo {
    pub id: String,
    pub node_id: String,
    pub node_type: String,
    pub label: String,
    pub status: String,
    pub config_json: String,
}

#[derive(Serialize)]
pub struct StepStatusInfo {
    pub id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hpc_job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Serialize)]
pub struct WorkflowRunStatusResult {
    pub workflow_id: String,
    pub status: String,
    pub progress: f64,
    pub steps: Vec<StepStatusInfo>,
}

// ---------------------------------------------------------------------------
// Tauri commands: Projects
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn db_list_projects(state: tauri::State<'_, DbState>) -> Result<Vec<ProjectSummary>, String> {
    let conn = get_conn(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT p.*,
                    (SELECT COUNT(*) FROM workflows WHERE project_id = p.id) as workflow_count
             FROM projects p ORDER BY p.updated_at DESC",
        )
        .map_err(|e| format!("prepare: {e}"))?;

    let rows = stmt
        .query_map([], |r| {
            Ok(ProjectSummary {
                id: r.get("id")?,
                name: r.get("name")?,
                description: r.get("description")?,
                ase_db_path: r.get("ase_db_path")?,
                parent_id: r.get("parent_id")?,
                created_at: r.get("created_at")?,
                updated_at: r.get("updated_at")?,
                workflow_count: r.get("workflow_count")?,
            })
        })
        .map_err(|e| format!("query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

#[tauri::command]
pub fn db_create_project(
    state: tauri::State<'_, DbState>,
    name: String,
    description: Option<String>,
    parent_id: Option<String>,
) -> Result<ProjectSummary, String> {
    let conn = get_conn(&state)?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let desc = description.unwrap_or_default();

    conn.execute(
        "INSERT INTO projects (id, name, description, parent_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, name, desc, parent_id, now, now],
    )
    .map_err(|e| format!("insert: {e}"))?;

    // Return the created project with workflow_count
    let wf_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM workflows WHERE project_id = ?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap_or(0);

    Ok(ProjectSummary {
        id,
        name,
        description: desc,
        ase_db_path: None,
        parent_id,
        created_at: now.clone(),
        updated_at: now,
        workflow_count: wf_count,
    })
}

#[tauri::command]
pub fn db_update_project(
    state: tauri::State<'_, DbState>,
    id: String,
    name: Option<String>,
    description: Option<String>,
    parent_id: Option<String>,
    unset_parent: Option<bool>,
) -> Result<ProjectSummary, String> {
    let conn = get_conn(&state)?;
    let now = Utc::now().to_rfc3339();

    let mut sets = Vec::new();
    let mut vals: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(ref n) = name {
        sets.push("name = ?");
        vals.push(Box::new(n.clone()));
    }
    if let Some(ref d) = description {
        sets.push("description = ?");
        vals.push(Box::new(d.clone()));
    }
    if unset_parent == Some(true) {
        sets.push("parent_id = NULL");
    } else if let Some(ref pid) = parent_id {
        sets.push("parent_id = ?");
        vals.push(Box::new(pid.clone()));
    }

    if !sets.is_empty() {
        sets.push("updated_at = ?");
        vals.push(Box::new(now));

        let sql = format!("UPDATE projects SET {} WHERE id = ?", sets.join(", "));
        vals.push(Box::new(id.clone()));

        let params: Vec<&dyn rusqlite::types::ToSql> = vals.iter().map(|v| v.as_ref()).collect();
        conn.execute(&sql, params.as_slice())
            .map_err(|e| format!("update: {e}"))?;
    }

    // Return updated project
    let mut stmt = conn
        .prepare(
            "SELECT p.*, (SELECT COUNT(*) FROM workflows WHERE project_id = p.id) as workflow_count FROM projects p WHERE p.id = ?1",
        )
        .map_err(|e| format!("prepare: {e}"))?;

    stmt.query_row(params![id], |r| {
        Ok(ProjectSummary {
            id: r.get("id")?,
            name: r.get("name")?,
            description: r.get("description")?,
            ase_db_path: r.get("ase_db_path")?,
            parent_id: r.get("parent_id")?,
            created_at: r.get("created_at")?,
            updated_at: r.get("updated_at")?,
            workflow_count: r.get("workflow_count")?,
        })
    })
    .map_err(|e| format!("query: {e}"))
}

#[tauri::command]
pub fn db_delete_project(state: tauri::State<'_, DbState>, id: String) -> Result<(), String> {
    let conn = get_conn(&state)?;

    // Collect all descendant project IDs (recursive BFS)
    let mut ids_to_delete = vec![id.clone()];
    let mut queue = vec![id];
    while let Some(pid) = queue.pop() {
        let mut stmt = conn
            .prepare("SELECT id FROM projects WHERE parent_id = ?1")
            .map_err(|e| format!("prepare: {e}"))?;
        let children: Vec<String> = stmt
            .query_map(params![pid], |r| r.get(0))
            .map_err(|e| format!("query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        ids_to_delete.extend(children.clone());
        queue.extend(children);
    }

    // Un-assign workflows
    let placeholders: String = ids_to_delete.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "UPDATE workflows SET project_id = NULL WHERE project_id IN ({placeholders})"
    );
    let params: Vec<&dyn rusqlite::types::ToSql> =
        ids_to_delete.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
    conn.execute(&sql, params.as_slice())
        .map_err(|e| format!("update wf: {e}"))?;

    // Delete projects
    let sql = format!("DELETE FROM projects WHERE id IN ({placeholders})");
    conn.execute(&sql, params.as_slice())
        .map_err(|e| format!("delete: {e}"))?;

    Ok(())
}

#[tauri::command]
pub fn db_get_project(state: tauri::State<'_, DbState>, id: String) -> Result<ProjectDetail, String> {
    let conn = get_conn(&state)?;

    let project = conn
        .query_row(
            "SELECT * FROM projects WHERE id = ?1",
            params![id],
            |r| {
                Ok((
                    r.get::<_, String>("id")?,
                    r.get::<_, String>("name")?,
                    r.get::<_, String>("description")?,
                    r.get::<_, Option<String>>("ase_db_path")?,
                    r.get::<_, Option<String>>("parent_id")?,
                    r.get::<_, String>("created_at")?,
                    r.get::<_, String>("updated_at")?,
                ))
            },
        )
        .map_err(|e| format!("Project not found: {e}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT w.id, w.name, w.status,
                    (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id) as step_count,
                    (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id AND status = 'completed') as completed_steps,
                    w.created_at
             FROM workflows w WHERE w.project_id = ?1 ORDER BY w.updated_at DESC",
        )
        .map_err(|e| format!("prepare: {e}"))?;

    let workflows = stmt
        .query_map(params![project.0], |r| {
            Ok(ProjectWorkflowEntry {
                id: r.get("id")?,
                name: r.get("name")?,
                status: r.get("status")?,
                step_count: r.get("step_count")?,
                completed_steps: r.get("completed_steps")?,
                created_at: r.get("created_at")?,
            })
        })
        .map_err(|e| format!("query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(ProjectDetail {
        id: project.0,
        name: project.1,
        description: project.2,
        ase_db_path: project.3,
        parent_id: project.4,
        created_at: project.5,
        updated_at: project.6,
        workflows,
    })
}

#[tauri::command]
pub fn db_get_enriched_results(
    state: tauri::State<'_, DbState>,
    project_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = get_conn(&state)?;

    // Find all workflow IDs belonging to this project
    let mut stmt = conn
        .prepare("SELECT id FROM workflows WHERE project_id = ?1")
        .map_err(|e| format!("prepare: {e}"))?;
    let wf_ids: Vec<String> = stmt
        .query_map(params![project_id], |r| r.get(0))
        .map_err(|e| format!("query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    if wf_ids.is_empty() {
        return Ok(vec![]);
    }

    // Find system IDs associated with these workflows via text_key_values
    let placeholders: String = wf_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT DISTINCT id FROM text_key_values WHERE key = 'workflow_id' AND value IN ({placeholders})"
    );
    let params: Vec<&dyn ToSql> = wf_ids.iter().map(|s| s as &dyn ToSql).collect();

    let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare: {e}"))?;
    let sys_ids: Vec<i64> = stmt
        .query_map(params.as_slice(), |r| r.get(0))
        .map_err(|e| format!("query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let mut results = Vec::new();
    for sys_id in sys_ids {
        let row = conn.query_row(
            "SELECT id, natoms, energy, volume FROM systems WHERE id = ?1",
            params![sys_id],
            |r| {
                Ok((
                    r.get::<_, i64>("id")?,
                    r.get::<_, i64>("natoms")?,
                    r.get::<_, Option<f64>>("energy")?,
                    r.get::<_, Option<f64>>("volume")?,
                ))
            },
        );
        let (id, natoms, energy, volume) = match row {
            Ok(r) => r,
            Err(_) => continue,
        };

        // Get text key-values
        let get_kv = |key: &str| -> String {
            conn.query_row(
                "SELECT value FROM text_key_values WHERE id = ?1 AND key = ?2",
                params![id, key],
                |r| r.get(0),
            )
            .unwrap_or_default()
        };

        let formula = conn
            .query_row(
                "SELECT GROUP_CONCAT(symbol || CASE WHEN count > 1 THEN count ELSE '' END, '')
                 FROM (SELECT Z, CASE Z WHEN 1 THEN 'H' WHEN 2 THEN 'He' WHEN 3 THEN 'Li' WHEN 4 THEN 'Be' WHEN 5 THEN 'B' WHEN 6 THEN 'C' WHEN 7 THEN 'N' WHEN 8 THEN 'O' WHEN 9 THEN 'F' WHEN 10 THEN 'Ne' WHEN 11 THEN 'Na' WHEN 12 THEN 'Mg' WHEN 13 THEN 'Al' WHEN 14 THEN 'Si' WHEN 15 THEN 'P' WHEN 16 THEN 'S' WHEN 17 THEN 'Cl' WHEN 18 THEN 'Ar' WHEN 19 THEN 'K' WHEN 20 THEN 'Ca' WHEN 22 THEN 'Ti' WHEN 23 THEN 'V' WHEN 24 THEN 'Cr' WHEN 25 THEN 'Mn' WHEN 26 THEN 'Fe' WHEN 27 THEN 'Co' WHEN 28 THEN 'Ni' WHEN 29 THEN 'Cu' WHEN 30 THEN 'Zn' WHEN 31 THEN 'Ga' WHEN 32 THEN 'Ge' WHEN 33 THEN 'As' WHEN 34 THEN 'Se' WHEN 35 THEN 'Br' WHEN 36 THEN 'Kr' WHEN 40 THEN 'Zr' WHEN 41 THEN 'Nb' WHEN 42 THEN 'Mo' WHEN 44 THEN 'Ru' WHEN 45 THEN 'Rh' WHEN 46 THEN 'Pd' WHEN 47 THEN 'Ag' WHEN 48 THEN 'Cd' WHEN 49 THEN 'In' WHEN 50 THEN 'Sn' WHEN 51 THEN 'Sb' WHEN 52 THEN 'Te' WHEN 53 THEN 'I' WHEN 54 THEN 'Xe' WHEN 72 THEN 'Hf' WHEN 73 THEN 'Ta' WHEN 74 THEN 'W' WHEN 75 THEN 'Re' WHEN 76 THEN 'Os' WHEN 77 THEN 'Ir' WHEN 78 THEN 'Pt' WHEN 79 THEN 'Au' WHEN 80 THEN 'Hg' WHEN 82 THEN 'Pb' ELSE 'X' END as symbol, COUNT(*) as count FROM species WHERE id = ?1 GROUP BY Z ORDER BY Z)",
                params![id],
                |r| r.get::<_, Option<String>>(0),
            )
            .unwrap_or(None)
            .unwrap_or_default();

        let energy_per_atom = energy.map(|e| if natoms > 0 { e / natoms as f64 } else { e });

        results.push(serde_json::json!({
            "id": id,
            "formula": formula,
            "energy": energy,
            "energy_per_atom": energy_per_atom,
            "natoms": natoms,
            "volume": volume,
            "a": null,
            "b": null,
            "c": null,
            "alpha": null,
            "beta": null,
            "gamma": null,
            "workflow_id": get_kv("workflow_id"),
            "workflow_name": "",
            "step_id": get_kv("step_id"),
            "step_label": get_kv("label"),
            "node_type": get_kv("node_type"),
        }));
    }

    Ok(results)
}

#[tauri::command]
pub fn db_assign_workflow_to_project(
    state: tauri::State<'_, DbState>,
    workflow_id: String,
    project_id: String,
) -> Result<(), String> {
    let conn = get_conn(&state)?;
    conn.execute(
        "UPDATE workflows SET project_id = ?1, updated_at = ?3 WHERE id = ?2",
        params![project_id, workflow_id, Utc::now().to_rfc3339()],
    )
    .map_err(|e| format!("assign: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands: Workflow Folders
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn db_list_workflow_folders(
    state: tauri::State<'_, DbState>,
) -> Result<Vec<WorkflowFolderSummary>, String> {
    let conn = get_conn(&state)?;
    let mut stmt = conn
        .prepare("SELECT * FROM workflow_folders ORDER BY updated_at DESC")
        .map_err(|e| format!("prepare: {e}"))?;

    let rows = stmt
        .query_map([], |r| {
            Ok(WorkflowFolderSummary {
                id: r.get("id")?,
                name: r.get("name")?,
                description: r.get("description")?,
                parent_id: r.get("parent_id")?,
                created_at: r.get("created_at")?,
                updated_at: r.get("updated_at")?,
            })
        })
        .map_err(|e| format!("query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

#[tauri::command]
pub fn db_create_workflow_folder(
    state: tauri::State<'_, DbState>,
    name: String,
    description: Option<String>,
    parent_id: Option<String>,
) -> Result<WorkflowFolderSummary, String> {
    let conn = get_conn(&state)?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let desc = description.unwrap_or_default();

    conn.execute(
        "INSERT INTO workflow_folders (id, name, description, parent_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, name, desc, parent_id, now, now],
    )
    .map_err(|e| format!("insert: {e}"))?;

    Ok(WorkflowFolderSummary {
        id,
        name,
        description: desc,
        parent_id,
        created_at: now.clone(),
        updated_at: now,
    })
}

#[tauri::command]
pub fn db_get_workflow_folder(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<WorkflowFolderDetail, String> {
    let conn = get_conn(&state)?;

    let folder = conn
        .query_row(
            "SELECT * FROM workflow_folders WHERE id = ?1",
            params![id],
            |r| {
                Ok(WorkflowFolderSummary {
                    id: r.get("id")?,
                    name: r.get("name")?,
                    description: r.get("description")?,
                    parent_id: r.get("parent_id")?,
                    created_at: r.get("created_at")?,
                    updated_at: r.get("updated_at")?,
                })
            },
        )
        .map_err(|e| format!("not found: {e}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT w.id, w.name, w.status,
                    (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id) as step_count,
                    (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id AND status = 'completed') as completed_steps
             FROM workflows w WHERE w.project_id = ?1 ORDER BY w.updated_at DESC",
        )
        .map_err(|e| format!("prepare: {e}"))?;

    let workflows: Vec<WorkflowFolderWorkflow> = stmt
        .query_map(params![id], |r| {
            Ok(WorkflowFolderWorkflow {
                id: r.get("id")?,
                name: r.get("name")?,
                status: r.get("status")?,
                step_count: r.get("step_count")?,
                completed_steps: r.get("completed_steps")?,
            })
        })
        .map_err(|e| format!("query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(WorkflowFolderDetail {
        id: folder.id,
        name: folder.name,
        description: folder.description,
        parent_id: folder.parent_id,
        created_at: folder.created_at,
        updated_at: folder.updated_at,
        workflows,
    })
}

#[tauri::command]
pub fn db_update_workflow_folder(
    state: tauri::State<'_, DbState>,
    id: String,
    name: Option<String>,
    description: Option<String>,
    parent_id: Option<String>,
    unset_parent: Option<bool>,
) -> Result<WorkflowFolderSummary, String> {
    let conn = get_conn(&state)?;
    let now = Utc::now().to_rfc3339();

    let mut sets = Vec::new();
    let mut vals: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(ref n) = name {
        sets.push("name = ?");
        vals.push(Box::new(n.clone()));
    }
    if let Some(ref d) = description {
        sets.push("description = ?");
        vals.push(Box::new(d.clone()));
    }
    if unset_parent == Some(true) {
        sets.push("parent_id = NULL");
    } else if let Some(ref pid) = parent_id {
        sets.push("parent_id = ?");
        vals.push(Box::new(pid.clone()));
    }

    if !sets.is_empty() {
        sets.push("updated_at = ?");
        vals.push(Box::new(now));

        let sql = format!("UPDATE workflow_folders SET {} WHERE id = ?", sets.join(", "));
        vals.push(Box::new(id.clone()));

        let params: Vec<&dyn rusqlite::types::ToSql> = vals.iter().map(|v| v.as_ref()).collect();
        conn.execute(&sql, params.as_slice())
            .map_err(|e| format!("update: {e}"))?;
    }

    // Return updated folder
    let mut stmt = conn
        .prepare("SELECT * FROM workflow_folders WHERE id = ?1")
        .map_err(|e| format!("prepare: {e}"))?;

    stmt.query_row(params![id], |r| {
        Ok(WorkflowFolderSummary {
            id: r.get("id")?,
            name: r.get("name")?,
            description: r.get("description")?,
            parent_id: r.get("parent_id")?,
            created_at: r.get("created_at")?,
            updated_at: r.get("updated_at")?,
        })
    })
    .map_err(|e| format!("query: {e}"))
}

#[tauri::command]
pub fn db_delete_workflow_folder(state: tauri::State<'_, DbState>, id: String) -> Result<(), String> {
    let conn = get_conn(&state)?;

    // Collect all descendant folder IDs (recursive BFS)
    let mut ids_to_delete = vec![id.clone()];
    let mut queue = vec![id];
    while let Some(pid) = queue.pop() {
        let mut stmt = conn
            .prepare("SELECT id FROM workflow_folders WHERE parent_id = ?1")
            .map_err(|e| format!("prepare: {e}"))?;
        let children: Vec<String> = stmt
            .query_map(params![pid], |r| r.get(0))
            .map_err(|e| format!("query: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        ids_to_delete.extend(children.clone());
        queue.extend(children);
    }

    // Un-assign workflows
    let placeholders: String = ids_to_delete.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "UPDATE workflows SET project_id = NULL WHERE project_id IN ({placeholders})"
    );
    let params: Vec<&dyn rusqlite::types::ToSql> =
        ids_to_delete.iter().map(|s| s as &dyn rusqlite::types::ToSql).collect();
    conn.execute(&sql, params.as_slice())
        .map_err(|e| format!("update wf: {e}"))?;

    // Delete folders
    let sql = format!("DELETE FROM workflow_folders WHERE id IN ({placeholders})");
    conn.execute(&sql, params.as_slice())
        .map_err(|e| format!("delete: {e}"))?;

    Ok(())
}

#[tauri::command]
pub fn db_assign_workflow_to_folder(
    state: tauri::State<'_, DbState>,
    workflow_id: String,
    folder_id: String,
) -> Result<(), String> {
    let conn = get_conn(&state)?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE workflows SET project_id = ?1, updated_at = ?2 WHERE id = ?3",
        params![folder_id, now, workflow_id],
    )
    .map_err(|e| format!("update: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_unassign_workflow_from_folder(
    state: tauri::State<'_, DbState>,
    workflow_id: String,
) -> Result<(), String> {
    let conn = get_conn(&state)?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE workflows SET project_id = NULL, updated_at = ?1 WHERE id = ?2",
        params![now, workflow_id],
    )
    .map_err(|e| format!("update: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands: Workflows
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn db_list_workflows(
    state: tauri::State<'_, DbState>,
) -> Result<Vec<WorkflowSummary>, String> {
    let conn = get_conn(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT w.*,
                    (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id) as step_count,
                    (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id AND status = 'completed') as completed_steps
             FROM workflows w ORDER BY w.updated_at DESC",
        )
        .map_err(|e| format!("prepare: {e}"))?;

    let rows = stmt
        .query_map([], |r| {
            Ok(WorkflowSummary {
                id: r.get("id")?,
                name: r.get("name")?,
                description: r.get("description")?,
                status: r.get("status")?,
                template_id: r.get("template_id")?,
                project_id: r.get("project_id")?,
                created_at: r.get("created_at")?,
                updated_at: r.get("updated_at")?,
                step_count: r.get("step_count")?,
                completed_steps: r.get("completed_steps")?,
            })
        })
        .map_err(|e| format!("query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

#[tauri::command]
pub fn db_create_workflow(
    state: tauri::State<'_, DbState>,
    name: String,
    graph_json: String,
    description: Option<String>,
    template_id: Option<String>,
) -> Result<WorkflowDetail, String> {
    let conn = get_conn(&state)?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let desc = description.unwrap_or_default();

    conn.execute(
        "INSERT INTO workflows (id, name, description, graph_json, status, template_id, project_id, created_at, updated_at, metadata) VALUES (?1, ?2, ?3, ?4, 'draft', ?5, NULL, ?6, ?7, '{}')",
        params![id, name, desc, graph_json, template_id, now, now],
    )
    .map_err(|e| format!("insert: {e}"))?;

    // Sync workflow steps from graph
    sync_steps_from_graph(&conn, &id, &graph_json)?;

    Ok(WorkflowDetail {
        id: id.clone(),
        name,
        description: desc,
        status: "draft".to_string(),
        template_id,
        project_id: None,
        created_at: now.clone(),
        updated_at: now,
        step_count: 0,
        completed_steps: 0,
        graph_json,
        metadata: "{}".to_string(),
    })
}

#[tauri::command]
pub fn db_get_workflow_detail(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<WorkflowDetail, String> {
    let conn = get_conn(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT w.*,
                    (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id) as step_count,
                    (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id AND status = 'completed') as completed_steps
             FROM workflows w WHERE w.id = ?1",
        )
        .map_err(|e| format!("prepare: {e}"))?;

    let result = stmt
        .query_map(params![&id], |r| {
            Ok(WorkflowDetail {
                id: r.get("id")?,
                name: r.get("name")?,
                description: r.get("description")?,
                status: r.get("status")?,
                template_id: r.get("template_id")?,
                project_id: r.get("project_id")?,
                created_at: r.get("created_at")?,
                updated_at: r.get("updated_at")?,
                step_count: r.get("step_count")?,
                completed_steps: r.get("completed_steps")?,
                graph_json: r.get::<_, Option<String>>("graph_json")?.unwrap_or_default(),
                metadata: r.get::<_, Option<String>>("metadata")?.unwrap_or_default(),
            })
        })
        .map_err(|e| format!("query: {e}"))?
        .next()
        .ok_or_else(|| "Workflow not found".to_string())?
        .map_err(|e| format!("get row: {e}"))?;

    Ok(result)
}

#[tauri::command]
pub fn db_update_workflow(
    state: tauri::State<'_, DbState>,
    id: String,
    name: Option<String>,
    description: Option<String>,
    graph_json: Option<String>,
    status: Option<String>,
    metadata: Option<String>,
) -> Result<WorkflowDetail, String> {
    let conn = get_conn(&state)?;
    let now = Utc::now().to_rfc3339();

    // Build dynamic UPDATE query
    let mut updates: Vec<String> = vec!["updated_at = ?1".to_string()];
    let mut param_idx = 2;

    if name.is_some() {
        updates.push(format!("name = ?{}", param_idx));
        param_idx += 1;
    }
    if description.is_some() {
        updates.push(format!("description = ?{}", param_idx));
        param_idx += 1;
    }
    if graph_json.is_some() {
        updates.push(format!("graph_json = ?{}", param_idx));
        param_idx += 1;
    }
    if status.is_some() {
        updates.push(format!("status = ?{}", param_idx));
        param_idx += 1;
    }
    if metadata.is_some() {
        updates.push(format!("metadata = ?{}", param_idx));
        param_idx += 1;
    }

    let sql = format!("UPDATE workflows SET {} WHERE id = ?{}", updates.join(", "), param_idx + 1);

    let mut vals: Vec<Box<dyn ToSql>> = Vec::new();
    vals.push(Box::new(now));
    if let Some(ref n) = name { vals.push(Box::new(n.clone())); }
    if let Some(ref d) = description { vals.push(Box::new(d.clone())); }
    if let Some(ref g) = graph_json { vals.push(Box::new(g.clone())); }
    if let Some(ref s) = status { vals.push(Box::new(s.clone())); }
    if let Some(ref m) = metadata { vals.push(Box::new(m.clone())); }
    vals.push(Box::new(id.clone()));

    let params: Vec<&dyn ToSql> = vals.iter().map(|v| v.as_ref()).collect();
    conn.execute(&sql, params.as_slice())
        .map_err(|e| format!("update: {e}"))?;

    // Sync workflow steps if graph_json changed
    if let Some(ref g) = graph_json {
        sync_steps_from_graph(&conn, &id, g)?;
    }

    db_get_workflow_detail(state, id)
}

#[tauri::command]
pub fn db_delete_workflow(
    state: tauri::State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    let conn = get_conn(&state)?;

    // Delete workflow steps and edges first (foreign key cascade should handle this, but be explicit)
    conn.execute("DELETE FROM workflow_edges WHERE workflow_id = ?1", params![&id])
        .map_err(|e| format!("delete edges: {e}"))?;
    conn.execute("DELETE FROM workflow_steps WHERE workflow_id = ?1", params![&id])
        .map_err(|e| format!("delete steps: {e}"))?;

    // Delete workflow
    conn.execute("DELETE FROM workflows WHERE id = ?1", params![&id])
        .map_err(|e| format!("delete: {e}"))?;

    Ok(())
}

#[tauri::command]
pub fn db_list_steps(
    state: tauri::State<'_, DbState>,
    workflow_id: String,
) -> Result<Vec<StepInfo>, String> {
    let conn = get_conn(&state)?;
    let mut stmt = conn
        .prepare("SELECT id, node_id, node_type, label, status, config_json FROM workflow_steps WHERE workflow_id = ?1 ORDER BY id")
        .map_err(|e| format!("prepare: {e}"))?;

    let steps = stmt
        .query_map(params![&workflow_id], |r| {
            Ok(StepInfo {
                id: r.get("id")?,
                node_id: r.get("node_id")?,
                node_type: r.get("node_type")?,
                label: r.get("label")?,
                status: r.get("status")?,
                config_json: r.get::<_, Option<String>>("config_json")?.unwrap_or_default(),
            })
        })
        .map_err(|e| format!("query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(steps)
}

/// Helper: sync workflow_steps and workflow_edges from graph_json
fn sync_steps_from_graph(conn: &rusqlite::Connection, workflow_id: &str, graph_json: &str) -> Result<(), String> {
    let graph: serde_json::Value = serde_json::from_str(graph_json)
        .map_err(|e| format!("parse graph_json: {e}"))?;

    let nodes = graph["nodes"].as_array().ok_or("nodes not an array")?;
    let edges = graph["edges"].as_array().ok_or("edges not an array")?;

    // Delete old steps and edges
    conn.execute("DELETE FROM workflow_edges WHERE workflow_id = ?1", params![workflow_id])
        .map_err(|e| format!("delete old edges: {e}"))?;
    conn.execute("DELETE FROM workflow_steps WHERE workflow_id = ?1", params![workflow_id])
        .map_err(|e| format!("delete old steps: {e}"))?;

    // Insert steps
    for node in nodes {
        let id = node["id"].as_str().ok_or("node.id missing")?;
        let node_type = node["type"].as_str().ok_or("node.type missing")?;
        let label = node["label"].as_str().unwrap_or("");
        let config_json = if let Some(params) = node.get("params") {
            serde_json::to_string(params).unwrap_or_default()
        } else {
            "{}".to_string()
        };

        conn.execute(
            "INSERT INTO workflow_steps (id, workflow_id, node_id, node_type, label, config_json, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending')",
            params![id, workflow_id, id, node_type, label, config_json],
        ).map_err(|e| format!("insert step: {e}"))?;
    }

    // Insert edges
    for edge in edges {
        let id = edge["id"].as_str().ok_or("edge.id missing")?;
        let source = edge["from"].as_str().ok_or("edge.from missing")?;
        let target = edge["to"].as_str().ok_or("edge.to missing")?;

        conn.execute(
            "INSERT INTO workflow_edges (id, workflow_id, source_node_id, target_node_id) VALUES (?1, ?2, ?3, ?4)",
            params![id, workflow_id, source, target],
        ).map_err(|e| format!("insert edge: {e}"))?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Workflow run status (local DB query)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn db_get_run_status(
    db_state: tauri::State<'_, DbState>,
    workflow_id: String,
) -> Result<WorkflowRunStatusResult, String> {
    let db_path = db_state.resolve_path()?;
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| format!("sqlite: {e}"))?;
    conn.execute_batch("PRAGMA busy_timeout=5000;")
        .map_err(|e| format!("pragma: {e}"))?;

    let status: String = conn
        .query_row(
            "SELECT COALESCE(status, 'draft') FROM workflows WHERE id = ?1",
            [&workflow_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("workflow status: {e}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT id, COALESCE(status, 'pending'), hpc_job_id, tool, label \
             FROM workflow_steps WHERE workflow_id = ?1 ORDER BY id",
        )
        .map_err(|e| format!("prepare: {e}"))?;

    let steps: Vec<StepStatusInfo> = stmt
        .query_map([&workflow_id], |row| {
            Ok(StepStatusInfo {
                id: row.get(0)?,
                status: row.get(1)?,
                hpc_job_id: row.get(2)?,
                tool: row.get(3)?,
                label: row.get(4)?,
            })
        })
        .map_err(|e| format!("query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let total = steps.len() as f64;
    let completed = steps.iter().filter(|s| s.status == "completed").count() as f64;
    let progress = if total > 0.0 { completed / total } else { 0.0 };

    Ok(WorkflowRunStatusResult {
        workflow_id,
        status,
        progress,
        steps,
    })
}
