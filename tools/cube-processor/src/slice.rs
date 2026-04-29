//! Slice extraction from volumetric data
//!
//! Generates 2D cross-sections through the 3D scalar field
//! at arbitrary positions along each axis.

use crate::cube::CubeFile;
use image::{ImageBuffer, Rgba, RgbaImage};
use serde::Serialize;

/// Which axis the slice is perpendicular to
#[derive(Debug, Clone, Copy, Serialize)]
pub enum SliceAxis {
    X,
    Y,
    Z,
}

/// A 2D slice through the volumetric data
#[derive(Debug, Serialize)]
pub struct Slice {
    pub axis: SliceAxis,
    /// Index along the axis (0-based)
    pub index: usize,
    /// Dimensions of the slice [width, height]
    pub dims: [usize; 2],
    /// Raw float data (row-major)
    pub data: Vec<f32>,
    pub data_min: f32,
    pub data_max: f32,
}

/// Colormap types for slice rendering
#[derive(Debug, Clone, Copy)]
pub enum Colormap {
    /// Blue-White-Red diverging (good for charge density)
    BlueWhiteRed,
    /// Viridis-like perceptually uniform
    Viridis,
    /// Hot (black-red-yellow-white)
    Hot,
}

impl Slice {
    /// Extract a slice perpendicular to the given axis at the given index
    pub fn extract(cube: &CubeFile, axis: SliceAxis, index: usize) -> Self {
        let [nx, ny, nz] = cube.header.dims;

        let (dims, data) = match axis {
            SliceAxis::X => {
                assert!(index < nx, "X index {} out of range (max {})", index, nx - 1);
                let mut data = Vec::with_capacity(ny * nz);
                for iy in 0..ny {
                    for iz in 0..nz {
                        data.push(cube.get(index, iy, iz));
                    }
                }
                ([ny, nz], data)
            }
            SliceAxis::Y => {
                assert!(index < ny, "Y index {} out of range (max {})", index, ny - 1);
                let mut data = Vec::with_capacity(nx * nz);
                for ix in 0..nx {
                    for iz in 0..nz {
                        data.push(cube.get(ix, index, iz));
                    }
                }
                ([nx, nz], data)
            }
            SliceAxis::Z => {
                assert!(index < nz, "Z index {} out of range (max {})", index, nz - 1);
                let mut data = Vec::with_capacity(nx * ny);
                for ix in 0..nx {
                    for iy in 0..ny {
                        data.push(cube.get(ix, iy, index));
                    }
                }
                ([nx, ny], data)
            }
        };

        let data_min = data.iter().copied().fold(f32::MAX, f32::min);
        let data_max = data.iter().copied().fold(f32::MIN, f32::max);

        Slice {
            axis,
            index,
            dims,
            data,
            data_min,
            data_max,
        }
    }

    /// Extract slice at a fractional position (0.0 = start, 1.0 = end)
    pub fn extract_at_fraction(cube: &CubeFile, axis: SliceAxis, fraction: f64) -> Self {
        let max_idx = match axis {
            SliceAxis::X => cube.header.dims[0],
            SliceAxis::Y => cube.header.dims[1],
            SliceAxis::Z => cube.header.dims[2],
        };
        let index = ((fraction * max_idx as f64) as usize).min(max_idx - 1);
        Self::extract(cube, axis, index)
    }

    /// Render slice to a PNG image using the specified colormap
    pub fn to_png(&self, colormap: Colormap) -> Vec<u8> {
        let width = self.dims[1] as u32; // columns
        let height = self.dims[0] as u32; // rows

        // Symmetric normalization centered at zero
        let abs_max = self.data_min.abs().max(self.data_max.abs());

        let img: RgbaImage = ImageBuffer::from_fn(width, height, |x, y| {
            let val = self.data[y as usize * self.dims[1] + x as usize];
            let t = if abs_max < 1e-12 {
                0.5
            } else {
                ((val / abs_max + 1.0) * 0.5).clamp(0.0, 1.0)
            };
            apply_colormap(t, colormap)
        });

        let mut buf = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut buf);
        image::ImageEncoder::write_image(
            encoder,
            img.as_raw(),
            width,
            height,
            image::ExtendedColorType::Rgba8,
        )
        .expect("Failed to encode PNG");

        buf
    }

    /// Export raw float data as a binary f32 array (for direct use as Float32Array in JS)
    pub fn to_f32_bytes(&self) -> Vec<u8> {
        self.data
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect()
    }
}

/// An arbitrary plane slice through the volumetric data
#[derive(Debug, Serialize)]
pub struct PlaneSlice {
    /// Center of the plane (Angstroms)
    pub center: [f64; 3],
    /// Normal vector of the plane (normalized)
    pub normal: [f64; 3],
    /// U basis vector on the plane
    pub u_axis: [f64; 3],
    /// V basis vector on the plane
    pub v_axis: [f64; 3],
    /// Width and height in pixels
    pub dims: [usize; 2],
    /// Physical extent [u_min, u_max, v_min, v_max] in Angstroms
    pub extent: [f64; 4],
    /// Raw float data (row-major, height × width)
    pub data: Vec<f32>,
    pub data_min: f32,
    pub data_max: f32,
}

impl PlaneSlice {
    /// Extract a slice along an arbitrary plane defined by center and normal.
    ///
    /// The resolution is automatically determined from the voxel size.
    /// `resolution_scale` > 1.0 increases pixel density (higher quality).
    pub fn extract(cube: &CubeFile, center: [f64; 3], normal: [f64; 3], resolution_scale: f64) -> Self {
        // Normalize the normal vector
        let n_len = (normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]).sqrt();
        let n = [normal[0] / n_len, normal[1] / n_len, normal[2] / n_len];

        // Construct orthonormal basis on the plane
        // Pick a hint vector not parallel to normal
        let hint = if n[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
        let u = cross(n, hint);
        let u_len = (u[0] * u[0] + u[1] * u[1] + u[2] * u[2]).sqrt();
        let u = [u[0] / u_len, u[1] / u_len, u[2] / u_len];
        let v = cross(n, u);

        // Focus the slice on atoms near the plane.
        // Project nearby atoms onto u,v to determine extent, then add margin.
        let h = &cube.header;
        let voxel_size = smallest_voxel_step(h);

        // Collect atoms near the plane (within 3 Å)
        let near_threshold = 3.0;
        let mut atom_u: Vec<f64> = Vec::new();
        let mut atom_v: Vec<f64> = Vec::new();
        for atom in &cube.header.atoms {
            let rel = [
                atom.position[0] - center[0],
                atom.position[1] - center[1],
                atom.position[2] - center[2],
            ];
            let plane_dist = rel[0] * n[0] + rel[1] * n[1] + rel[2] * n[2];
            if plane_dist.abs() <= near_threshold {
                atom_u.push(rel[0] * u[0] + rel[1] * u[1] + rel[2] * u[2]);
                atom_v.push(rel[0] * v[0] + rel[1] * v[1] + rel[2] * v[2]);
            }
        }

        // If we found atoms near the plane, use their extent + margin.
        // Otherwise fall back to a fixed window around center.
        let atom_margin = 4.0; // Å margin around outermost atoms
        let (mut u_min, mut u_max, mut v_min, mut v_max) = if atom_u.len() >= 2 {
            let u_lo = atom_u.iter().copied().fold(f64::MAX, f64::min);
            let u_hi = atom_u.iter().copied().fold(f64::MIN, f64::max);
            let v_lo = atom_v.iter().copied().fold(f64::MAX, f64::min);
            let v_hi = atom_v.iter().copied().fold(f64::MIN, f64::max);
            (u_lo - atom_margin, u_hi + atom_margin, v_lo - atom_margin, v_hi + atom_margin)
        } else {
            // Fallback: 10 Å window around center
            (-10.0, 10.0, -10.0, 10.0)
        };

        // Clamp to volume bounds so we don't sample entirely outside
        let corners = bounding_box_corners(h);
        let mut vol_u_min = f64::MAX;
        let mut vol_u_max = f64::MIN;
        let mut vol_v_min = f64::MAX;
        let mut vol_v_max = f64::MIN;
        for corner in &corners {
            let rel = [corner[0] - center[0], corner[1] - center[1], corner[2] - center[2]];
            let up = rel[0] * u[0] + rel[1] * u[1] + rel[2] * u[2];
            let vp = rel[0] * v[0] + rel[1] * v[1] + rel[2] * v[2];
            vol_u_min = vol_u_min.min(up);
            vol_u_max = vol_u_max.max(up);
            vol_v_min = vol_v_min.min(vp);
            vol_v_max = vol_v_max.max(vp);
        }
        u_min = u_min.max(vol_u_min);
        u_max = u_max.min(vol_u_max);
        v_min = v_min.max(vol_v_min);
        v_max = v_max.min(vol_v_max);

        let pixel_size = voxel_size / resolution_scale;

        let width = ((u_max - u_min) / pixel_size).ceil() as usize;
        let height = ((v_max - v_min) / pixel_size).ceil() as usize;

        // Cap at reasonable resolution
        let width = width.max(1).min(2048);
        let height = height.max(1).min(2048);

        // Sample the volumetric data
        let mut data = Vec::with_capacity(width * height);
        let mut data_min = f32::MAX;
        let mut data_max = f32::MIN;

        for row in 0..height {
            let v_coord = v_min + (row as f64 + 0.5) * pixel_size;
            for col in 0..width {
                let u_coord = u_min + (col as f64 + 0.5) * pixel_size;

                // 3D position on the plane
                let pos = [
                    center[0] + u_coord * u[0] + v_coord * v[0],
                    center[1] + u_coord * u[1] + v_coord * v[1],
                    center[2] + u_coord * u[2] + v_coord * v[2],
                ];

                let val = trilinear_sample(cube, pos);
                if val < data_min { data_min = val; }
                if val > data_max { data_max = val; }
                data.push(val);
            }
        }

        PlaneSlice {
            center,
            normal: n,
            u_axis: u,
            v_axis: v,
            dims: [height, width],
            extent: [u_min, u_max, v_min, v_max],
            data,
            data_min,
            data_max,
        }
    }

    /// Render to PNG with a colormap
    pub fn to_png(&self, colormap: Colormap) -> Vec<u8> {
        self.to_png_with_atoms(colormap, &[])
    }

    /// Render to PNG with a colormap, overlaying atoms near the plane
    pub fn to_png_with_atoms(&self, colormap: Colormap, atoms: &[crate::cube::Atom]) -> Vec<u8> {
        let width = self.dims[1] as u32;
        let height = self.dims[0] as u32;
        let [u_min, _u_max, v_min, _v_max] = self.extent;
        let pixel_w = (_u_max - u_min) / width as f64;
        let pixel_h = (_v_max - v_min) / height as f64;

        // Symmetric normalization: center at zero so white = 0
        let abs_max = self.data_min.abs().max(self.data_max.abs());

        let mut img: RgbaImage = ImageBuffer::from_fn(width, height, |x, y| {
            let val = self.data[y as usize * self.dims[1] + x as usize];
            let t = if abs_max < 1e-12 {
                0.5
            } else {
                ((val / abs_max + 1.0) * 0.5).clamp(0.0, 1.0) // -abs_max→0, 0→0.5, +abs_max→1
            };
            apply_colormap(t, colormap)
        });

        // Distance threshold: atoms within this distance from the plane are drawn
        let dist_threshold = pixel_w.max(pixel_h) * 8.0; // ~8 pixels worth of depth

        for atom in atoms {
            let rel = [
                atom.position[0] - self.center[0],
                atom.position[1] - self.center[1],
                atom.position[2] - self.center[2],
            ];

            // Signed distance from plane
            let plane_dist = rel[0] * self.normal[0]
                           + rel[1] * self.normal[1]
                           + rel[2] * self.normal[2];

            if plane_dist.abs() > dist_threshold {
                continue;
            }

            // Project onto u,v
            let u_proj = rel[0] * self.u_axis[0] + rel[1] * self.u_axis[1] + rel[2] * self.u_axis[2];
            let v_proj = rel[0] * self.v_axis[0] + rel[1] * self.v_axis[1] + rel[2] * self.v_axis[2];

            // Convert to pixel coordinates
            let px = ((u_proj - u_min) / pixel_w) as i32;
            let py = ((v_proj - v_min) / pixel_h) as i32;

            // Radius in pixels (based on covalent radius, roughly)
            let radius_ang = element_radius(atom.atomic_number);
            let radius_px = (radius_ang / pixel_w).round() as i32;
            let radius_px = radius_px.max(3).min(30);

            let color = element_color(atom.atomic_number);
            let label = element_symbol(atom.atomic_number);

            // Draw filled circle with slight transparency
            draw_atom_circle(&mut img, px, py, radius_px, color, &label);
        }

        let mut buf = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut buf);
        image::ImageEncoder::write_image(
            encoder,
            img.as_raw(),
            width,
            height,
            image::ExtendedColorType::Rgba8,
        )
        .expect("Failed to encode PNG");
        buf
    }
}

/// Draw an atom as a circle with border and element label
fn draw_atom_circle(img: &mut RgbaImage, cx: i32, cy: i32, r: i32, color: [u8; 3], label: &str) {
    let (w, h) = (img.width() as i32, img.height() as i32);
    let r2 = r * r;
    let inner_r2 = (r - 2).max(0) * (r - 2).max(0);

    for dy in -r..=r {
        for dx in -r..=r {
            let x = cx + dx;
            let y = cy + dy;
            if x < 0 || x >= w || y < 0 || y >= h {
                continue;
            }
            let d2 = dx * dx + dy * dy;
            if d2 <= r2 {
                let px = img.get_pixel_mut(x as u32, y as u32);
                if d2 > inner_r2 {
                    // Border ring: solid element color
                    *px = Rgba([color[0], color[1], color[2], 255]);
                } else {
                    // Inner: semi-transparent fill
                    let bg = *px;
                    let alpha = 0.35f32;
                    let r = (bg[0] as f32 * (1.0 - alpha) + color[0] as f32 * alpha) as u8;
                    let g = (bg[1] as f32 * (1.0 - alpha) + color[1] as f32 * alpha) as u8;
                    let b = (bg[2] as f32 * (1.0 - alpha) + color[2] as f32 * alpha) as u8;
                    *px = Rgba([r, g, b, 255]);
                }
            }
        }
    }

    // Draw a simple cross at center for small radii, or the label letter(s)
    if r >= 6 && !label.is_empty() {
        // Draw label as a simple pixel font (just the first 1-2 chars)
        draw_label(img, cx, cy, label, [255, 255, 255]);
    }
}

/// Minimal 5x7 bitmap font for element symbols (uppercase + lowercase subset)
fn draw_label(img: &mut RgbaImage, cx: i32, cy: i32, text: &str, color: [u8; 3]) {
    let chars: Vec<char> = text.chars().take(2).collect();
    let total_w = chars.len() as i32 * 4; // 3px wide + 1px gap per char
    let start_x = cx - total_w / 2;
    let start_y = cy - 3; // 7px tall, center vertically

    for (i, ch) in chars.iter().enumerate() {
        let bitmap = char_bitmap(*ch);
        let ox = start_x + i as i32 * 4;
        for (row, bits) in bitmap.iter().enumerate() {
            for col in 0..5 {
                if bits & (1 << (4 - col)) != 0 {
                    let x = ox + col;
                    let y = start_y + row as i32;
                    if x >= 0 && x < img.width() as i32 && y >= 0 && y < img.height() as i32 {
                        // Draw with outline for readability
                        img.put_pixel(x as u32, y as u32, Rgba([color[0], color[1], color[2], 255]));
                    }
                }
            }
        }
    }
}

/// 5x7 bitmap for common element symbol characters
fn char_bitmap(ch: char) -> [u8; 7] {
    match ch {
        'H' => [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
        'C' => [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
        'N' => [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
        'O' => [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
        'S' => [0b01110, 0b10001, 0b10000, 0b01110, 0b00001, 0b10001, 0b01110],
        'F' => [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
        'P' => [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
        'M' => [0b10001, 0b11011, 0b10101, 0b10001, 0b10001, 0b10001, 0b10001],
        'Z' => [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
        'R' => [0b11110, 0b10001, 0b10001, 0b11110, 0b10010, 0b10001, 0b10001],
        'A' => [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
        'I' => [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
        'K' => [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
        'L' => [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
        'T' => [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
        'W' => [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
        'B' => [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
        'G' => [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110],
        'D' => [0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100],
        'E' => [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
        'V' => [0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b01010, 0b00100],
        'X' => [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
        'Y' => [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
        'o' => [0b00000, 0b00000, 0b01110, 0b10001, 0b10001, 0b10001, 0b01110],
        'u' => [0b00000, 0b00000, 0b10001, 0b10001, 0b10001, 0b10011, 0b01101],
        'n' => [0b00000, 0b00000, 0b10110, 0b11001, 0b10001, 0b10001, 0b10001],
        'r' => [0b00000, 0b00000, 0b10110, 0b11001, 0b10000, 0b10000, 0b10000],
        'i' => [0b00100, 0b00000, 0b01100, 0b00100, 0b00100, 0b00100, 0b01110],
        'e' => [0b00000, 0b00000, 0b01110, 0b10001, 0b11111, 0b10000, 0b01110],
        'a' => [0b00000, 0b00000, 0b01110, 0b00001, 0b01111, 0b10001, 0b01111],
        't' => [0b00100, 0b00100, 0b01110, 0b00100, 0b00100, 0b00100, 0b00011],
        'd' => [0b00001, 0b00001, 0b01101, 0b10011, 0b10001, 0b10011, 0b01101],
        'l' => [0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
        'g' => [0b00000, 0b00000, 0b01111, 0b10001, 0b01111, 0b00001, 0b01110],
        _ =>   [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110], // default: circle
    }
}

/// Approximate covalent radius in Angstroms for common elements
fn element_radius(z: i32) -> f64 {
    match z {
        1 => 0.31,
        6 => 0.76,
        7 => 0.71,
        8 => 0.66,
        9 => 0.57,
        15 => 1.07,
        16 => 1.05,
        26 => 1.32, // Fe
        27 => 1.26, // Co
        28 => 1.24, // Ni
        29 => 1.32, // Cu
        30 => 1.22, // Zn
        42 => 1.54, // Mo
        44 => 1.46, // Ru
        46 => 1.39, // Pd
        78 => 1.36, // Pt
        79 => 1.36, // Au
        _ => 1.0,
    }
}

/// RGB color for common elements
fn element_color(z: i32) -> [u8; 3] {
    match z {
        1 => [200, 200, 200],  // H: light gray
        6 => [80, 80, 80],     // C: dark gray
        7 => [50, 50, 220],    // N: blue
        8 => [220, 50, 50],    // O: red
        9 => [50, 200, 50],    // F: green
        15 => [200, 130, 0],   // P: orange
        16 => [220, 220, 50],  // S: yellow
        26 => [180, 120, 60],  // Fe: brown-orange
        42 => [84, 181, 181],  // Mo: teal
        44 => [40, 140, 140],  // Ru: dark teal
        46 => [0, 105, 133],   // Pd: dark cyan
        78 => [180, 180, 200], // Pt: silver
        79 => [255, 209, 35],  // Au: gold
        _ => [160, 160, 160],  // default: gray
    }
}

/// Element symbol string
fn element_symbol(z: i32) -> &'static str {
    match z {
        1 => "H", 6 => "C", 7 => "N", 8 => "O", 9 => "F",
        15 => "P", 16 => "S", 26 => "Fe", 27 => "Co", 28 => "Ni",
        29 => "Cu", 30 => "Zn", 42 => "Mo", 44 => "Ru", 46 => "Pd",
        47 => "Ag", 74 => "W", 78 => "Pt", 79 => "Au",
        _ => "?",
    }
}

/// Cross product of two 3D vectors
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// Compute 8 corners of the volumetric data bounding box (in Angstroms)
fn bounding_box_corners(h: &crate::cube::CubeHeader) -> [[f64; 3]; 8] {
    let o = h.origin;
    let [nx, ny, nz] = h.dims;
    let v = h.voxel_axes;

    // End point: origin + nx*vx + ny*vy + nz*vz
    let mut corners = [[0.0; 3]; 8];
    for (idx, (i, j, k)) in [(0,0,0),(1,0,0),(0,1,0),(0,0,1),(1,1,0),(1,0,1),(0,1,1),(1,1,1)].iter().enumerate() {
        let fi = (*i as f64) * (nx as f64);
        let fj = (*j as f64) * (ny as f64);
        let fk = (*k as f64) * (nz as f64);
        corners[idx] = [
            o[0] + fi * v[0][0] + fj * v[1][0] + fk * v[2][0],
            o[1] + fi * v[0][1] + fj * v[1][1] + fk * v[2][1],
            o[2] + fi * v[0][2] + fj * v[1][2] + fk * v[2][2],
        ];
    }
    corners
}

/// Smallest voxel step size (Angstroms)
fn smallest_voxel_step(h: &crate::cube::CubeHeader) -> f64 {
    let mut min_step = f64::MAX;
    for ax in &h.voxel_axes {
        let len = (ax[0] * ax[0] + ax[1] * ax[1] + ax[2] * ax[2]).sqrt();
        if len < min_step && len > 0.0 {
            min_step = len;
        }
    }
    min_step
}

/// Trilinear interpolation of volumetric data at an arbitrary Cartesian position
fn trilinear_sample(cube: &CubeFile, pos: [f64; 3]) -> f32 {
    let h = &cube.header;
    let [nx, ny, nz] = h.dims;

    // Convert Cartesian to fractional grid coordinates
    // pos = origin + fx * vx + fy * vy + fz * vz
    // Solve the 3x3 linear system (for orthogonal grids this is trivial)
    let rel = [pos[0] - h.origin[0], pos[1] - h.origin[1], pos[2] - h.origin[2]];

    // Build 3x3 matrix from voxel axes and solve via Cramer's rule
    let v = &h.voxel_axes;
    let det = v[0][0] * (v[1][1] * v[2][2] - v[1][2] * v[2][1])
            - v[1][0] * (v[0][1] * v[2][2] - v[0][2] * v[2][1])
            + v[2][0] * (v[0][1] * v[1][2] - v[0][2] * v[1][1]);

    if det.abs() < 1e-20 {
        return 0.0;
    }

    let inv_det = 1.0 / det;

    let fx = inv_det * (rel[0] * (v[1][1] * v[2][2] - v[1][2] * v[2][1])
                      - v[1][0] * (rel[1] * v[2][2] - rel[2] * v[2][1])
                      + v[2][0] * (rel[1] * v[1][2] - rel[2] * v[1][1]));
    let fy = inv_det * (v[0][0] * (rel[1] * v[2][2] - rel[2] * v[2][1])
                      - rel[0] * (v[0][1] * v[2][2] - v[0][2] * v[2][1])
                      + v[2][0] * (v[0][1] * rel[2] - v[0][2] * rel[1]));
    let fz = inv_det * (v[0][0] * (v[1][1] * rel[2] - v[1][2] * rel[1])
                      - v[1][0] * (v[0][1] * rel[2] - v[0][2] * rel[1])
                      + rel[0] * (v[0][1] * v[1][2] - v[0][2] * v[1][1]));

    // Check bounds
    if fx < 0.0 || fy < 0.0 || fz < 0.0
        || fx >= (nx - 1) as f64 || fy >= (ny - 1) as f64 || fz >= (nz - 1) as f64
    {
        return 0.0; // Outside the volume
    }

    // Integer indices and fractional parts
    let ix = fx.floor() as usize;
    let iy = fy.floor() as usize;
    let iz = fz.floor() as usize;
    let dx = (fx - ix as f64) as f32;
    let dy = (fy - iy as f64) as f32;
    let dz = (fz - iz as f64) as f32;

    // 8-corner trilinear interpolation
    let c000 = cube.get(ix, iy, iz);
    let c100 = cube.get(ix + 1, iy, iz);
    let c010 = cube.get(ix, iy + 1, iz);
    let c001 = cube.get(ix, iy, iz + 1);
    let c110 = cube.get(ix + 1, iy + 1, iz);
    let c101 = cube.get(ix + 1, iy, iz + 1);
    let c011 = cube.get(ix, iy + 1, iz + 1);
    let c111 = cube.get(ix + 1, iy + 1, iz + 1);

    let c00 = c000 * (1.0 - dx) + c100 * dx;
    let c01 = c001 * (1.0 - dx) + c101 * dx;
    let c10 = c010 * (1.0 - dx) + c110 * dx;
    let c11 = c011 * (1.0 - dx) + c111 * dx;

    let c0 = c00 * (1.0 - dy) + c10 * dy;
    let c1 = c01 * (1.0 - dy) + c11 * dy;

    c0 * (1.0 - dz) + c1 * dz
}

/// Apply a colormap to a normalized value [0, 1] → RGBA
fn apply_colormap(t: f32, colormap: Colormap) -> Rgba<u8> {
    match colormap {
        Colormap::BlueWhiteRed => {
            // Diverging: #cc3333 (negative, t=0) → white (zero, t=0.5) → #3366cc (positive, t=1)
            // Matches isosurface: negative_color=#cc3333, positive_color=#3366cc
            let (r, g, b) = if t < 0.5 {
                let s = t * 2.0; // 0→1 as t goes 0→0.5
                (
                    (204.0 + s * 51.0) as u8,    // 204 → 255
                    (51.0 + s * 204.0) as u8,     // 51  → 255
                    (51.0 + s * 204.0) as u8,     // 51  → 255
                )
            } else {
                let s = (t - 0.5) * 2.0; // 0→1 as t goes 0.5→1
                (
                    (255.0 - s * 204.0) as u8,    // 255 → 51
                    (255.0 - s * 153.0) as u8,    // 255 → 102
                    (255.0 - s * 51.0) as u8,     // 255 → 204
                )
            };
            Rgba([r, g, b, 255])
        }
        Colormap::Viridis => {
            // Simplified viridis approximation
            let r = ((-0.35 * t + 1.5) * t * 255.0).clamp(0.0, 255.0) as u8;
            let g = ((0.8 - (t - 0.5).powi(2) * 4.0) * 255.0).clamp(0.0, 255.0) as u8;
            let b = ((0.9 - t * 0.7) * 255.0).clamp(0.0, 255.0) as u8;
            Rgba([r, g, b, 255])
        }
        Colormap::Hot => {
            // Black → Red → Yellow → White
            let r = (t * 3.0).clamp(0.0, 1.0);
            let g = ((t - 0.333) * 3.0).clamp(0.0, 1.0);
            let b = ((t - 0.667) * 3.0).clamp(0.0, 1.0);
            Rgba([
                (r * 255.0) as u8,
                (g * 255.0) as u8,
                (b * 255.0) as u8,
                255,
            ])
        }
    }
}
