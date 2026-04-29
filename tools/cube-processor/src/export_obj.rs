//! OBJ (Wavefront) mesh exporter

use crate::marching_cubes::Mesh;
use std::io::Write;

/// Export a mesh to OBJ format
pub fn write_obj<W: Write>(mesh: &Mesh, writer: &mut W, name: &str) -> std::io::Result<()> {
    writeln!(writer, "# Cube Processor - Isosurface Mesh")?;
    writeln!(writer, "# Vertices: {}", mesh.vertex_count())?;
    writeln!(writer, "# Triangles: {}", mesh.triangle_count())?;
    writeln!(writer, "o {}", name)?;
    writeln!(writer)?;

    // Write vertices
    for i in 0..mesh.vertex_count() {
        let x = mesh.positions[i * 3];
        let y = mesh.positions[i * 3 + 1];
        let z = mesh.positions[i * 3 + 2];
        writeln!(writer, "v {:.6} {:.6} {:.6}", x, y, z)?;
    }
    writeln!(writer)?;

    // Write normals
    for i in 0..mesh.vertex_count() {
        let nx = mesh.normals[i * 3];
        let ny = mesh.normals[i * 3 + 1];
        let nz = mesh.normals[i * 3 + 2];
        writeln!(writer, "vn {:.6} {:.6} {:.6}", nx, ny, nz)?;
    }
    writeln!(writer)?;

    // Write faces (OBJ is 1-indexed)
    for tri in mesh.indices.chunks(3) {
        let a = tri[0] + 1;
        let b = tri[1] + 1;
        let c = tri[2] + 1;
        writeln!(writer, "f {}//{} {}//{} {}//{}", a, a, b, b, c, c)?;
    }

    Ok(())
}

/// Export dual (positive + negative) isosurfaces to a single OBJ with two groups
pub fn write_dual_obj<W: Write>(
    pos_mesh: &Mesh,
    neg_mesh: &Mesh,
    writer: &mut W,
    isovalue: f32,
) -> std::io::Result<()> {
    writeln!(writer, "# Cube Processor - Dual Isosurface")?;
    writeln!(writer, "# Isovalue: ±{:.6e}", isovalue)?;
    writeln!(writer)?;

    // MTL reference
    writeln!(writer, "mtllib isosurface.mtl")?;
    writeln!(writer)?;

    // Positive isosurface
    writeln!(writer, "o positive_isosurface")?;
    writeln!(writer, "usemtl positive")?;
    for i in 0..pos_mesh.vertex_count() {
        writeln!(
            writer,
            "v {:.6} {:.6} {:.6}",
            pos_mesh.positions[i * 3],
            pos_mesh.positions[i * 3 + 1],
            pos_mesh.positions[i * 3 + 2]
        )?;
    }
    for i in 0..pos_mesh.vertex_count() {
        writeln!(
            writer,
            "vn {:.6} {:.6} {:.6}",
            pos_mesh.normals[i * 3],
            pos_mesh.normals[i * 3 + 1],
            pos_mesh.normals[i * 3 + 2]
        )?;
    }
    for tri in pos_mesh.indices.chunks(3) {
        let a = tri[0] + 1;
        let b = tri[1] + 1;
        let c = tri[2] + 1;
        writeln!(writer, "f {}//{} {}//{} {}//{}", a, a, b, b, c, c)?;
    }

    // Negative isosurface (offset indices)
    let offset = pos_mesh.vertex_count() as u32;
    writeln!(writer)?;
    writeln!(writer, "o negative_isosurface")?;
    writeln!(writer, "usemtl negative")?;
    for i in 0..neg_mesh.vertex_count() {
        writeln!(
            writer,
            "v {:.6} {:.6} {:.6}",
            neg_mesh.positions[i * 3],
            neg_mesh.positions[i * 3 + 1],
            neg_mesh.positions[i * 3 + 2]
        )?;
    }
    for i in 0..neg_mesh.vertex_count() {
        writeln!(
            writer,
            "vn {:.6} {:.6} {:.6}",
            neg_mesh.normals[i * 3],
            neg_mesh.normals[i * 3 + 1],
            neg_mesh.normals[i * 3 + 2]
        )?;
    }
    for tri in neg_mesh.indices.chunks(3) {
        let a = tri[0] + 1 + offset;
        let b = tri[1] + 1 + offset;
        let c = tri[2] + 1 + offset;
        writeln!(writer, "f {}//{} {}//{} {}//{}", a, a, b, b, c, c)?;
    }

    Ok(())
}
