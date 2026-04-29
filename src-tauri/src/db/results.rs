//! Result query, label, delete, move/copy, and structure read/write commands.

use chrono::Utc;
use rusqlite::params;
use serde::Serialize;
use uuid::Uuid;

use super::{get_conn, DbState};
use super::util::{
    ELEMENTS, cell_params, element_to_z, formula_from_species, get_text_kv,
    invert_3x3, mat_vec_mul, pack_f64_blob, pack_i32_blob, parse_f64_blob,
    parse_numbers_blob, Mat3,
};

// ---------------------------------------------------------------------------
// Serde types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ResultRow {
    pub id: i64,
    pub formula: String,
    pub label: String,
    pub energy: Option<f64>,
    pub workflow_id: String,
    pub step_id: String,
    pub node_type: String,
    pub natoms: i64,
}

#[derive(Serialize)]
pub struct ResultsResponse {
    pub results: Vec<ResultRow>,
    pub count: usize,
}

#[derive(Serialize)]
pub struct MoveOrCopyResult {
    pub row_id: i64,
    pub project_id: String,
    pub action: String,
}

#[derive(Serialize)]
pub struct SaveStructureResult {
    pub row_id: i64,
    pub formula: String,
}

#[derive(Serialize)]
pub struct ExportStructureResult {
    pub path: String,
    pub name: String,
    pub format: String,
}

#[derive(Serialize)]
pub struct SerializeStructureResult {
    pub content: String,
    pub format: String,
}

// ---------------------------------------------------------------------------
// Tauri commands: Results
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn db_query_results(
    state: tauri::State<'_, DbState>,
    workflow_id: String,
) -> Result<ResultsResponse, String> {
    let conn = get_conn(&state)?;

    // Find all system IDs associated with this workflow_id
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT id FROM text_key_values WHERE key = 'workflow_id' AND value = ?1",
        )
        .map_err(|e| format!("prepare: {e}"))?;

    let sys_ids: Vec<i64> = stmt
        .query_map(params![workflow_id], |r| r.get(0))
        .map_err(|e| format!("query: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let mut results = Vec::new();
    for sys_id in &sys_ids {
        let row = conn.query_row(
            "SELECT id, natoms, energy FROM systems WHERE id = ?1",
            params![sys_id],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<f64>>(2)?,
                ))
            },
        );
        if let Ok((id, natoms, energy)) = row {
            let formula = formula_from_species(&conn, id);
            let label = get_text_kv(&conn, id, "label");
            let wf_id = get_text_kv(&conn, id, "workflow_id");
            let step_id = get_text_kv(&conn, id, "step_id");
            let node_type = get_text_kv(&conn, id, "node_type");

            results.push(ResultRow {
                id,
                formula,
                label,
                energy,
                workflow_id: wf_id,
                step_id,
                node_type,
                natoms,
            });
        }
    }

    let count = results.len();
    Ok(ResultsResponse { results, count })
}

// ---------------------------------------------------------------------------
// Tauri commands: Result label / delete / move-copy
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn db_update_result_label(
    state: tauri::State<'_, DbState>,
    row_id: i64,
    label: String,
) -> Result<serde_json::Value, String> {
    let conn = get_conn(&state)?;

    // Check if a label key-value already exists
    let existing: Option<String> = conn
        .query_row(
            "SELECT value FROM text_key_values WHERE id = ?1 AND key = 'label'",
            params![row_id],
            |r| r.get(0),
        )
        .ok();

    if existing.is_some() {
        conn.execute(
            "UPDATE text_key_values SET value = ?1 WHERE id = ?2 AND key = 'label'",
            params![label, row_id],
        )
        .map_err(|e| format!("update: {e}"))?;
    } else {
        conn.execute(
            "INSERT INTO text_key_values (key, value, id) VALUES ('label', ?1, ?2)",
            params![label, row_id],
        )
        .map_err(|e| format!("insert: {e}"))?;
        // Also add to keys table
        conn.execute(
            "INSERT OR IGNORE INTO keys (key, id) VALUES ('label', ?1)",
            params![row_id],
        )
        .ok();
    }

    Ok(serde_json::json!({"row_id": row_id, "label": label}))
}

#[tauri::command]
pub fn db_delete_result(state: tauri::State<'_, DbState>, row_id: i64) -> Result<(), String> {
    let conn = get_conn(&state)?;
    // Delete from all related tables
    conn.execute("DELETE FROM text_key_values WHERE id = ?1", params![row_id])
        .ok();
    conn.execute(
        "DELETE FROM number_key_values WHERE id = ?1",
        params![row_id],
    )
    .ok();
    conn.execute("DELETE FROM keys WHERE id = ?1", params![row_id])
        .ok();
    conn.execute("DELETE FROM species WHERE id = ?1", params![row_id])
        .ok();
    conn.execute("DELETE FROM systems WHERE id = ?1", params![row_id])
        .map_err(|e| format!("delete: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn db_move_or_copy_result(
    state: tauri::State<'_, DbState>,
    row_id: i64,
    project_id: String,
) -> Result<MoveOrCopyResult, String> {
    let conn = get_conn(&state)?;
    let node_type = get_text_kv(&conn, row_id, "node_type");

    if node_type == "user_save" {
        // Move: update workflow_id
        let existing: Option<String> = conn
            .query_row(
                "SELECT value FROM text_key_values WHERE id = ?1 AND key = 'workflow_id'",
                params![row_id],
                |r| r.get(0),
            )
            .ok();

        if existing.is_some() {
            conn.execute(
                "UPDATE text_key_values SET value = ?1 WHERE id = ?2 AND key = 'workflow_id'",
                params![project_id, row_id],
            )
            .map_err(|e| format!("update: {e}"))?;
        }

        Ok(MoveOrCopyResult {
            row_id,
            project_id,
            action: "moved".to_string(),
        })
    } else {
        // Copy: read the original row and create a new one
        let new_id = copy_system_row(&conn, row_id, &project_id)?;
        Ok(MoveOrCopyResult {
            row_id: new_id,
            project_id,
            action: "copied".to_string(),
        })
    }
}

/// Copy a system row (with all associated data) to a new project.
fn copy_system_row(conn: &rusqlite::Connection, src_id: i64, target_project_id: &str) -> Result<i64, String> {
    // Read source system
    let row = conn.query_row(
        "SELECT numbers, positions, cell, pbc, energy, free_energy, natoms, volume, mass, charge,
                unique_id, calculator, calculator_parameters, forces, stress, data, constraints
         FROM systems WHERE id = ?1",
        params![src_id],
        |r| {
            Ok((
                r.get::<_, Option<Vec<u8>>>(0)?,  // numbers
                r.get::<_, Option<Vec<u8>>>(1)?,  // positions
                r.get::<_, Option<Vec<u8>>>(2)?,  // cell
                r.get::<_, i32>(3)?,               // pbc
                r.get::<_, Option<f64>>(4)?,       // energy
                r.get::<_, Option<f64>>(5)?,       // free_energy
                r.get::<_, i64>(6)?,               // natoms
                r.get::<_, Option<f64>>(7)?,       // volume
                r.get::<_, Option<f64>>(8)?,       // mass
                r.get::<_, Option<f64>>(9)?,       // charge
                r.get::<_, Option<String>>(10)?,   // unique_id (not used for new)
                r.get::<_, Option<String>>(11)?,   // calculator
                r.get::<_, Option<String>>(12)?,   // calculator_parameters
                r.get::<_, Option<Vec<u8>>>(13)?,  // forces
                r.get::<_, Option<Vec<u8>>>(14)?,  // stress
                r.get::<_, Option<Vec<u8>>>(15)?,  // data
                r.get::<_, Option<String>>(16)?,   // constraints
            ))
        },
    )
    .map_err(|e| format!("read src: {e}"))?;

    let now = Utc::now().timestamp() as f64;
    let new_uid = Uuid::new_v4().to_string().replace('-', "");

    conn.execute(
        "INSERT INTO systems (unique_id, ctime, mtime, numbers, positions, cell, pbc,
         energy, free_energy, natoms, volume, mass, charge, calculator, calculator_parameters,
         forces, stress, data, constraints)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
        params![
            new_uid, now, now,
            row.0,  // numbers
            row.1,  // positions
            row.2,  // cell
            row.3,  // pbc
            row.4,  // energy
            row.5,  // free_energy
            row.6,  // natoms
            row.7,  // volume
            row.8,  // mass
            row.9,  // charge
            row.11, // calculator
            row.12, // calculator_parameters
            row.13, // forces
            row.14, // stress
            row.15, // data
            row.16, // constraints
        ],
    )
    .map_err(|e| format!("insert copy: {e}"))?;

    let new_id = conn.last_insert_rowid();

    // Copy species
    conn.execute(
        "INSERT INTO species (Z, n, id) SELECT Z, n, ?1 FROM species WHERE id = ?2",
        params![new_id, src_id],
    )
    .ok();

    // Insert key-value pairs for the copy
    let label = get_text_kv(conn, src_id, "label");
    for (key, value) in [
        ("workflow_id", target_project_id.to_string()),
        ("step_id", "__saved__".to_string()),
        ("node_type", "user_save".to_string()),
        ("label", label),
    ] {
        conn.execute(
            "INSERT INTO text_key_values (key, value, id) VALUES (?1, ?2, ?3)",
            params![key, value, new_id],
        )
        .ok();
        conn.execute(
            "INSERT OR IGNORE INTO keys (key, id) VALUES (?1, ?2)",
            params![key, new_id],
        )
        .ok();
    }

    Ok(new_id)
}

// ---------------------------------------------------------------------------
// Tauri commands: Structure read (BLOB -> PymatgenStructure JSON)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn db_get_result_structure(
    state: tauri::State<'_, DbState>,
    row_id: i64,
) -> Result<serde_json::Value, String> {
    let conn = get_conn(&state)?;

    let (numbers_blob, positions_blob, cell_blob, pbc, energy): (
        Option<Vec<u8>>,
        Option<Vec<u8>>,
        Option<Vec<u8>>,
        i32,
        Option<f64>,
    ) = conn
        .query_row(
            "SELECT numbers, positions, cell, pbc, energy FROM systems WHERE id = ?1",
            params![row_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .map_err(|e| format!("query: {e}"))?;

    let numbers = numbers_blob.map(|b| parse_numbers_blob(&b)).unwrap_or_default();
    let positions_flat = positions_blob.map(|b| parse_f64_blob(&b)).unwrap_or_default();
    let cell_flat = cell_blob.map(|b| parse_f64_blob(&b)).unwrap_or_default();

    let natoms = numbers.len();

    // Parse cell matrix (9 f64 -> 3x3)
    let cell: Mat3 = if cell_flat.len() >= 9 {
        [
            [cell_flat[0], cell_flat[1], cell_flat[2]],
            [cell_flat[3], cell_flat[4], cell_flat[5]],
            [cell_flat[6], cell_flat[7], cell_flat[8]],
        ]
    } else {
        [[0.0; 3]; 3]
    };

    // Check periodicity
    let has_pbc = pbc != 0;
    let (a_len, b_len, c_len, alpha, beta, gamma, volume) = cell_params(&cell);
    let is_periodic = has_pbc && volume > 0.01;

    // Build lattice
    let lattice = if is_periodic {
        let pbc_arr = [pbc & 1 != 0, pbc & 2 != 0, pbc & 4 != 0];
        Some(serde_json::json!({
            "matrix": [[cell[0][0], cell[0][1], cell[0][2]],
                       [cell[1][0], cell[1][1], cell[1][2]],
                       [cell[2][0], cell[2][1], cell[2][2]]],
            "a": a_len,
            "b": b_len,
            "c": c_len,
            "alpha": alpha,
            "beta": beta,
            "gamma": gamma,
            "volume": volume,
            "pbc": pbc_arr,
        }))
    } else {
        None
    };

    // Compute inverse cell for fractional coords
    let inv_cell = if is_periodic { invert_3x3(&cell) } else { None };

    // Build sites
    let mut sites = Vec::with_capacity(natoms);
    for i in 0..natoms {
        let z = numbers[i] as usize;
        let symbol = if z < ELEMENTS.len() {
            ELEMENTS[z]
        } else {
            "X"
        };

        let xyz = if i * 3 + 2 < positions_flat.len() {
            [
                positions_flat[i * 3],
                positions_flat[i * 3 + 1],
                positions_flat[i * 3 + 2],
            ]
        } else {
            [0.0, 0.0, 0.0]
        };

        let abc = if let Some(ref inv) = inv_cell {
            mat_vec_mul(inv, &xyz)
        } else {
            xyz
        };

        sites.push(serde_json::json!({
            "species": [{"element": symbol, "occu": 1.0}],
            "abc": [abc[0], abc[1], abc[2]],
            "xyz": [xyz[0], xyz[1], xyz[2]],
            "label": symbol,
        }));
    }

    let mut structure = serde_json::json!({
        "sites": sites,
    });

    if let Some(lat) = lattice {
        structure["lattice"] = lat;
    }

    if let Some(e) = energy {
        structure["energy"] = serde_json::json!(e);
    }

    Ok(structure)
}

// ---------------------------------------------------------------------------
// Tauri commands: Structure write (PymatgenStructure JSON -> ASE BLOB)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn db_save_structure(
    state: tauri::State<'_, DbState>,
    structure: serde_json::Value,
    name: String,
    project_id: Option<String>,
) -> Result<SaveStructureResult, String> {
    let conn = get_conn(&state)?;

    // Parse lattice
    let lattice = structure.get("lattice");
    let has_lattice = lattice.is_some() && !lattice.unwrap().is_null();

    let (cell, pbc) = if has_lattice {
        let matrix = lattice
            .unwrap()
            .get("matrix")
            .and_then(|m| m.as_array())
            .ok_or("missing lattice.matrix")?;
        let mut cell_flat = Vec::with_capacity(9);
        for row in matrix {
            let arr = row.as_array().ok_or("lattice.matrix row not array")?;
            for val in arr {
                cell_flat.push(val.as_f64().ok_or("lattice value not f64")?);
            }
        }
        if cell_flat.len() != 9 {
            return Err("lattice.matrix must be 3x3".to_string());
        }
        (cell_flat, 7i32) // pbc = 7 means [True, True, True]
    } else {
        (vec![0.0; 9], 0i32)
    };

    // Parse sites
    let sites = structure
        .get("sites")
        .and_then(|s| s.as_array())
        .ok_or("missing sites array")?;

    let natoms = sites.len();
    let mut numbers = Vec::with_capacity(natoms);
    let mut positions = Vec::with_capacity(natoms * 3);
    let mut species_counts: std::collections::BTreeMap<i32, i32> = std::collections::BTreeMap::new();

    for site in sites {
        // Get element symbol
        let species_arr = site
            .get("species")
            .and_then(|s| s.as_array())
            .ok_or("site missing species")?;
        let element = species_arr
            .first()
            .and_then(|s| s.get("element"))
            .and_then(|e| e.as_str())
            .ok_or("species missing element")?;

        let z = element_to_z(element).ok_or(format!("unknown element: {element}"))?;
        numbers.push(z);
        *species_counts.entry(z).or_insert(0) += 1;

        // Get xyz positions
        let xyz = site
            .get("xyz")
            .and_then(|v| v.as_array())
            .ok_or("site missing xyz")?;
        for val in xyz {
            positions.push(val.as_f64().ok_or("xyz value not f64")?);
        }
    }

    // Compute volume and mass
    let cell_mat: Mat3 = [
        [cell[0], cell[1], cell[2]],
        [cell[3], cell[4], cell[5]],
        [cell[6], cell[7], cell[8]],
    ];
    let (_, _, _, _, _, _, volume) = cell_params(&cell_mat);

    // Pack blobs
    let numbers_blob = pack_i32_blob(&numbers);
    let positions_blob = pack_f64_blob(&positions);
    let cell_blob = pack_f64_blob(&cell);

    let now = Utc::now().timestamp() as f64;
    let uid = Uuid::new_v4().to_string().replace('-', "");
    let wf_id = project_id.clone().unwrap_or_else(|| "__user__".to_string());

    conn.execute(
        "INSERT INTO systems (unique_id, ctime, mtime, numbers, positions, cell, pbc, natoms, volume, energy)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)",
        params![uid, now, now, numbers_blob, positions_blob, cell_blob, pbc, natoms as i64, volume],
    )
    .map_err(|e| format!("insert systems: {e}"))?;

    let new_id = conn.last_insert_rowid();

    // Insert species
    for (z, n) in &species_counts {
        conn.execute(
            "INSERT INTO species (Z, n, id) VALUES (?1, ?2, ?3)",
            params![z, n, new_id],
        )
        .map_err(|e| format!("insert species: {e}"))?;
    }

    // Insert key-value pairs
    for (key, value) in [
        ("workflow_id", wf_id.as_str()),
        ("step_id", "__saved__"),
        ("node_type", "user_save"),
        ("label", &name),
    ] {
        conn.execute(
            "INSERT INTO text_key_values (key, value, id) VALUES (?1, ?2, ?3)",
            params![key, value, new_id],
        )
        .map_err(|e| format!("insert tkv: {e}"))?;
        conn.execute(
            "INSERT INTO keys (key, id) VALUES (?1, ?2)",
            params![key, new_id],
        )
        .ok();
    }

    // Compute formula for response
    let formula = formula_from_species(&conn, new_id);

    Ok(SaveStructureResult {
        row_id: new_id,
        formula,
    })
}

#[tauri::command]
pub fn db_export_structure(
    _structure: serde_json::Value,
    _path: String,
    _format: Option<String>,
) -> Result<ExportStructureResult, String> {
    // Structure export requires ASE/pymatgen — forward to Python backend
    Err("Structure export requires Python backend (pymatgen/ASE). Use HTTP mode.".to_string())
}

#[tauri::command]
pub fn db_serialize_structure(
    _structure: serde_json::Value,
    _format: Option<String>,
) -> Result<SerializeStructureResult, String> {
    Err("Structure serialization requires Python backend (pymatgen/ASE). Use HTTP mode.".to_string())
}
