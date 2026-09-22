//! Persistent Cube grids and Marching Cubes meshes for browser workers.

use cube_processor::cube::CubeFile;
use cube_processor::marching_cubes::{Mesh, extract_isosurface, normalize_normals};
use wasm_bindgen::prelude::*;

/// A parsed, single-dataset Cube volume retained in WASM memory.
#[wasm_bindgen]
pub struct WasmCubeVolume {
    cube: CubeFile,
}

#[wasm_bindgen]
impl WasmCubeVolume {
    /// Parse Cube text, converting Bohr coordinates to Angstroms.
    #[wasm_bindgen(constructor)]
    pub fn new(text: &str) -> Result<WasmCubeVolume, JsError> {
        CubeFile::parse(text.as_bytes())
            .map(|cube| Self { cube })
            .map_err(|err| JsError::new(&err.to_string()))
    }

    /// Return the serializable CubeHeader, with coordinates in Angstroms.
    pub fn header(&self) -> Result<JsValue, JsError> {
        serde_wasm_bindgen::to_value(&self.cube.header)
            .map_err(|err| JsError::new(&err.to_string()))
    }

    /// Copy the z-fastest scalar values to a JavaScript Float32Array.
    pub fn data(&self) -> Vec<f32> {
        self.cube.data.clone()
    }

    /// Minimum scalar value in the volume.
    pub fn data_min(&self) -> f32 {
        self.cube.data_min
    }

    /// Maximum scalar value in the volume.
    pub fn data_max(&self) -> f32 {
        self.cube.data_max
    }

    /// Construct an atom-free grid from Angstrom coordinates and z-fastest data.
    /// The three voxel vectors are flattened in row-major order.
    pub fn from_grid(
        dims: Vec<u32>,
        origin: Vec<f64>,
        voxel_axes: Vec<f64>,
        data: Vec<f32>,
    ) -> Result<WasmCubeVolume, JsError> {
        let dims: [u32; 3] = dims
            .try_into()
            .map_err(|_| JsError::new("Expected exactly three grid dimensions"))?;
        let origin: [f64; 3] = origin
            .try_into()
            .map_err(|_| JsError::new("Expected exactly three origin coordinates"))?;
        let axes: [f64; 9] = voxel_axes
            .try_into()
            .map_err(|_| JsError::new("Expected exactly nine voxel-axis components"))?;
        let voxel_axes = [
            [axes[0], axes[1], axes[2]],
            [axes[3], axes[4], axes[5]],
            [axes[6], axes[7], axes[8]],
        ];
        CubeFile::from_grid(dims.map(|dim| dim as usize), origin, voxel_axes, data)
            .map(|cube| Self { cube })
            .map_err(|err| JsError::new(&err.to_string()))
    }

    /// Extract an owned mesh. Copy its arrays, then call the generated free().
    pub fn extract(&self, isovalue: f32) -> Result<WasmCubeMesh, JsError> {
        if !isovalue.is_finite() {
            return Err(JsError::new("Isovalue must be finite"));
        }
        let mut mesh = extract_isosurface(&self.cube, isovalue);
        // Match the browser renderer's area-weighted Cartesian face normals.
        // Grid-index gradients would shade rotated or skewed voxel axes wrongly.
        mesh.normals.fill(0.0);
        for triangle in mesh.indices.chunks_exact(3) {
            let [a, b, c] = [triangle[0], triangle[1], triangle[2]].map(|i| i as usize * 3);
            let ab: [f32; 3] =
                std::array::from_fn(|i| mesh.positions[b + i] - mesh.positions[a + i]);
            let ac: [f32; 3] =
                std::array::from_fn(|i| mesh.positions[c + i] - mesh.positions[a + i]);
            let face = [
                ab[1] * ac[2] - ab[2] * ac[1],
                ab[2] * ac[0] - ab[0] * ac[2],
                ab[0] * ac[1] - ab[1] * ac[0],
            ];
            for base in [a, b, c] {
                for (i, value) in face.into_iter().enumerate() {
                    mesh.normals[base + i] += value;
                }
            }
        }
        normalize_normals(&mut mesh);
        if !mesh
            .positions
            .iter()
            .chain(&mesh.normals)
            .all(|v| v.is_finite())
        {
            return Err(JsError::new(
                "Grid geometry produced non-finite mesh coordinates",
            ));
        }
        Ok(WasmCubeMesh { mesh })
    }
}

/// An isosurface mesh retained in WASM memory until the generated free() call.
#[wasm_bindgen]
pub struct WasmCubeMesh {
    mesh: Mesh,
}

#[wasm_bindgen]
impl WasmCubeMesh {
    /// Copy flat Angstrom vertex coordinates to a JavaScript Float32Array.
    pub fn positions(&self) -> Vec<f32> {
        self.mesh.positions.clone()
    }

    /// Copy flat unit vertex normals to a JavaScript Float32Array.
    pub fn normals(&self) -> Vec<f32> {
        self.mesh.normals.clone()
    }

    /// Copy triangle indices to a JavaScript Uint32Array.
    pub fn indices(&self) -> Vec<u32> {
        self.mesh.indices.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volume_retains_data_across_mesh_extractions() {
        let volume = WasmCubeVolume::from_grid(
            vec![2, 2, 2],
            vec![0.0; 3],
            vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            vec![0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0],
        )
        .unwrap();
        assert_eq!((volume.data_min(), volume.data_max()), (0.0, 1.0));
        let mut copy = volume.data();
        copy[0] = 9.0;
        assert_eq!(volume.data()[0], 0.0);
        for level in [0.25, 0.75] {
            let mesh = volume.extract(level).unwrap();
            assert_eq!(mesh.indices().len(), 6);
            assert_eq!(mesh.normals().len(), mesh.positions().len());
            assert!(mesh.positions().chunks_exact(3).all(|v| v[0] == level));
        }
    }

    #[test]
    fn mesh_normals_follow_cartesian_faces_for_rotated_and_skewed_grids() {
        for (axes, expected) in [
            (
                [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
                [1.0, 0.0, 0.0],
            ),
            (
                [0.0, 2.0, 0.0, -3.0, 0.0, 0.0, 0.0, 0.0, 4.0],
                [0.0, 1.0, 0.0],
            ),
            (
                [2.0, 0.0, 0.0, 1.0, 3.0, 0.0, 0.0, 0.0, 4.0],
                [3.0 / 10.0_f32.sqrt(), -1.0 / 10.0_f32.sqrt(), 0.0],
            ),
        ] {
            let volume = WasmCubeVolume::from_grid(
                vec![2, 2, 2],
                vec![0.0; 3],
                axes.to_vec(),
                vec![-1.0, -1.0, -1.0, -1.0, 1.0, 1.0, 1.0, 1.0],
            )
            .unwrap();
            for level in [-0.5, 0.5] {
                let mesh = volume.extract(level).unwrap();
                assert_eq!(mesh.indices().len(), 6);
                for normal in mesh.normals().chunks_exact(3) {
                    for (actual, expected) in normal.iter().zip(expected) {
                        assert!((actual - expected).abs() < 1e-6);
                    }
                }
            }
        }
    }
}
