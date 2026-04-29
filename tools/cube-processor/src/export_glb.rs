//! GLB (Binary glTF 2.0) mesh exporter
//!
//! Produces a self-contained .glb file with embedded geometry and materials.

use crate::marching_cubes::Mesh;
use anyhow::Result;
use gltf_json as json;
use json::validation::Checked::Valid;
use std::io::Write;

/// Export a single mesh to GLB format
pub fn write_glb<W: Write>(
    mesh: &Mesh,
    writer: &mut W,
    color: [f32; 4],
    name: &str,
) -> Result<()> {
    let meshes = &[(mesh, color, name)];
    write_multi_glb(meshes, writer)
}

/// Export dual isosurfaces to GLB (positive = blue, negative = red)
pub fn write_dual_glb<W: Write>(
    pos_mesh: &Mesh,
    neg_mesh: &Mesh,
    writer: &mut W,
    isovalue: f32,
) -> Result<()> {
    let meshes = &[
        (pos_mesh, [0.2, 0.4, 0.9, 0.7], "positive_isosurface"),
        (neg_mesh, [0.9, 0.2, 0.2, 0.7], "negative_isosurface"),
    ];
    let _ = isovalue;
    write_multi_glb(meshes, writer)
}

/// Write multiple meshes into a single GLB
fn write_multi_glb<W: Write>(
    meshes: &[(&Mesh, [f32; 4], &str)],
    writer: &mut W,
) -> Result<()> {
    // Build binary buffer: [positions | normals | indices] for each mesh
    let mut bin_data: Vec<u8> = Vec::new();
    let mut buffer_views = Vec::new();
    let mut accessors = Vec::new();
    let mut gltf_meshes = Vec::new();
    let mut gltf_nodes = Vec::new();
    let mut materials = Vec::new();

    for (mesh_idx, (mesh, color, _name)) in meshes.iter().enumerate() {
        let pos_offset = bin_data.len();
        for &v in &mesh.positions {
            bin_data.extend_from_slice(&v.to_le_bytes());
        }
        let pos_len = bin_data.len() - pos_offset;

        while bin_data.len() % 4 != 0 {
            bin_data.push(0);
        }

        let norm_offset = bin_data.len();
        for &v in &mesh.normals {
            bin_data.extend_from_slice(&v.to_le_bytes());
        }
        let norm_len = bin_data.len() - norm_offset;

        while bin_data.len() % 4 != 0 {
            bin_data.push(0);
        }

        let idx_offset = bin_data.len();
        for &i in &mesh.indices {
            bin_data.extend_from_slice(&i.to_le_bytes());
        }
        let idx_len = bin_data.len() - idx_offset;

        while bin_data.len() % 4 != 0 {
            bin_data.push(0);
        }

        let bv_base = buffer_views.len() as u32;
        let acc_base = accessors.len() as u32;

        // Buffer views
        buffer_views.push(json::buffer::View {
            buffer: json::Index::new(0),
            byte_length: pos_len.into(),
            byte_offset: Some(pos_offset.into()),
            byte_stride: Some(json::buffer::Stride(12)),
            target: Some(Valid(json::buffer::Target::ArrayBuffer)),
            extensions: Default::default(),
            extras: Default::default(),
        });
        buffer_views.push(json::buffer::View {
            buffer: json::Index::new(0),
            byte_length: norm_len.into(),
            byte_offset: Some(norm_offset.into()),
            byte_stride: Some(json::buffer::Stride(12)),
            target: Some(Valid(json::buffer::Target::ArrayBuffer)),
            extensions: Default::default(),
            extras: Default::default(),
        });
        buffer_views.push(json::buffer::View {
            buffer: json::Index::new(0),
            byte_length: idx_len.into(),
            byte_offset: Some(idx_offset.into()),
            byte_stride: None,
            target: Some(Valid(json::buffer::Target::ElementArrayBuffer)),
            extensions: Default::default(),
            extras: Default::default(),
        });

        // Compute bounding box
        let mut min_pos = [f32::MAX; 3];
        let mut max_pos = [f32::MIN; 3];
        for i in 0..mesh.vertex_count() {
            for j in 0..3 {
                let v = mesh.positions[i * 3 + j];
                if v < min_pos[j] {
                    min_pos[j] = v;
                }
                if v > max_pos[j] {
                    max_pos[j] = v;
                }
            }
        }

        // Accessors (positions)
        accessors.push(json::Accessor {
            buffer_view: Some(json::Index::new(bv_base)),
            byte_offset: Some(0usize.into()),
            count: mesh.vertex_count().into(),
            component_type: Valid(json::accessor::GenericComponentType(
                json::accessor::ComponentType::F32,
            )),
            type_: Valid(json::accessor::Type::Vec3),
            min: Some(json::Value::from(vec![
                json::Value::from(min_pos[0] as f64),
                json::Value::from(min_pos[1] as f64),
                json::Value::from(min_pos[2] as f64),
            ])),
            max: Some(json::Value::from(vec![
                json::Value::from(max_pos[0] as f64),
                json::Value::from(max_pos[1] as f64),
                json::Value::from(max_pos[2] as f64),
            ])),
            normalized: false,
            sparse: None,
            extensions: Default::default(),
            extras: Default::default(),
        });
        // Accessors (normals)
        accessors.push(json::Accessor {
            buffer_view: Some(json::Index::new(bv_base + 1)),
            byte_offset: Some(0usize.into()),
            count: mesh.vertex_count().into(),
            component_type: Valid(json::accessor::GenericComponentType(
                json::accessor::ComponentType::F32,
            )),
            type_: Valid(json::accessor::Type::Vec3),
            min: None,
            max: None,
            normalized: false,
            sparse: None,
            extensions: Default::default(),
            extras: Default::default(),
        });
        // Accessors (indices)
        accessors.push(json::Accessor {
            buffer_view: Some(json::Index::new(bv_base + 2)),
            byte_offset: Some(0usize.into()),
            count: mesh.indices.len().into(),
            component_type: Valid(json::accessor::GenericComponentType(
                json::accessor::ComponentType::U32,
            )),
            type_: Valid(json::accessor::Type::Scalar),
            min: None,
            max: None,
            normalized: false,
            sparse: None,
            extensions: Default::default(),
            extras: Default::default(),
        });

        // Material (PBR metallic-roughness with transparency)
        materials.push(json::Material {
            alpha_cutoff: None,
            alpha_mode: Valid(json::material::AlphaMode::Blend),
            double_sided: true,
            pbr_metallic_roughness: json::material::PbrMetallicRoughness {
                base_color_factor: json::material::PbrBaseColorFactor(*color),
                metallic_factor: json::material::StrengthFactor(0.1),
                roughness_factor: json::material::StrengthFactor(0.6),
                base_color_texture: None,
                metallic_roughness_texture: None,
                extensions: Default::default(),
                extras: Default::default(),
            },
            normal_texture: None,
            occlusion_texture: None,
            emissive_texture: None,
            emissive_factor: json::material::EmissiveFactor([0.0, 0.0, 0.0]),
            extensions: Default::default(),
            extras: Default::default(),
        });

        // Mesh primitive
        let mut attributes = std::collections::BTreeMap::new();
        attributes.insert(
            Valid(json::mesh::Semantic::Positions),
            json::Index::new(acc_base),
        );
        attributes.insert(
            Valid(json::mesh::Semantic::Normals),
            json::Index::new(acc_base + 1),
        );

        gltf_meshes.push(json::Mesh {
            primitives: vec![json::mesh::Primitive {
                attributes,
                indices: Some(json::Index::new(acc_base + 2)),
                material: Some(json::Index::new(mesh_idx as u32)),
                mode: Valid(json::mesh::Mode::Triangles),
                targets: None,
                extensions: Default::default(),
                extras: Default::default(),
            }],
            weights: None,
            extensions: Default::default(),
            extras: Default::default(),
        });

        gltf_nodes.push(json::Node {
            mesh: Some(json::Index::new(mesh_idx as u32)),
            camera: None,
            children: None,
            extensions: Default::default(),
            extras: Default::default(),
            matrix: None,
            rotation: None,
            scale: None,
            translation: None,
            skin: None,
            weights: None,
        });
    }

    // Scene
    let node_indices: Vec<_> = (0..gltf_nodes.len() as u32)
        .map(json::Index::new)
        .collect();

    let root = json::Root {
        asset: json::Asset {
            generator: Some("cube-processor".to_string()),
            version: "2.0".to_string(),
            ..Default::default()
        },
        buffers: vec![json::Buffer {
            byte_length: bin_data.len().into(),
            uri: None,
            extensions: Default::default(),
            extras: Default::default(),
        }],
        buffer_views,
        accessors,
        meshes: gltf_meshes,
        nodes: gltf_nodes,
        scenes: vec![json::Scene {
            nodes: node_indices,
            extensions: Default::default(),
            extras: Default::default(),
        }],
        scene: Some(json::Index::new(0)),
        materials,
        ..Default::default()
    };

    // Serialize JSON chunk
    let json_bytes = json::serialize::to_vec(&root)?;
    let json_len = json_bytes.len();
    let json_pad = (4 - (json_len % 4)) % 4;
    let json_chunk_len = json_len + json_pad;

    let bin_pad = (4 - (bin_data.len() % 4)) % 4;
    let bin_chunk_len = bin_data.len() + bin_pad;

    let total_len = 12 + 8 + json_chunk_len + 8 + bin_chunk_len;

    // Write GLB header
    writer.write_all(b"glTF")?;
    writer.write_all(&2u32.to_le_bytes())?;
    writer.write_all(&(total_len as u32).to_le_bytes())?;

    // JSON chunk
    writer.write_all(&(json_chunk_len as u32).to_le_bytes())?;
    writer.write_all(&0x4E4F534Au32.to_le_bytes())?;
    writer.write_all(&json_bytes)?;
    for _ in 0..json_pad {
        writer.write_all(b" ")?;
    }

    // Binary chunk
    writer.write_all(&(bin_chunk_len as u32).to_le_bytes())?;
    writer.write_all(&0x004E4942u32.to_le_bytes())?;
    writer.write_all(&bin_data)?;
    for _ in 0..bin_pad {
        writer.write_all(&[0u8])?;
    }

    Ok(())
}
