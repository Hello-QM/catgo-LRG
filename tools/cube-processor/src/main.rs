//! cube-processor CLI
//!
//! High-performance Gaussian cube file processing tool.
//!
//! Usage:
//!   cube-processor isosurface input.cube --iso 0.02 --format glb -o output.glb
//!   cube-processor isosurface input.cube --iso 0.02 --dual --format obj -o output.obj
//!   cube-processor slice input.cube --axis z --position 0.5 -o slice.png
//!   cube-processor info input.cube
//!   cube-processor json input.cube --iso 0.02  (outputs JSON mesh for frontend)

use anyhow::Result;
use clap::{Parser, Subcommand, ValueEnum};
use cube_processor::chgcar::{self, VaspFileType};
use cube_processor::cube::CubeFile;
use cube_processor::export_glb;
use cube_processor::export_obj;
use cube_processor::marching_cubes::{self, normalize_normals, decimate_mesh};
use cube_processor::slice::{Colormap, PlaneSlice, Slice, SliceAxis};
use indicatif::{ProgressBar, ProgressStyle};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::time::Instant;

#[derive(Parser)]
#[command(name = "cube-processor")]
#[command(about = "High-performance Gaussian cube file processor")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Display cube file metadata
    Info {
        /// Input cube file path
        input: String,
    },

    /// Extract isosurface mesh using Marching Cubes
    Isosurface {
        /// Input cube file path
        input: String,

        /// Isovalue threshold
        #[arg(long, short)]
        iso: f32,

        /// Generate dual (±) isosurfaces
        #[arg(long, default_value_t = false)]
        dual: bool,

        /// Output format
        #[arg(long, short, default_value = "glb")]
        format: OutputFormat,

        /// Output file path
        #[arg(long, short)]
        output: Option<String>,

        /// Decimation grid size (Å). Set > 0 to reduce mesh complexity.
        #[arg(long)]
        decimate: Option<f32>,
    },

    /// Extract 2D cross-section slice
    Slice {
        /// Input cube file path
        input: String,

        /// Slice axis (x, y, or z)
        #[arg(long, short, default_value = "z")]
        axis: AxisArg,

        /// Fractional position along axis (0.0-1.0)
        #[arg(long, short, default_value_t = 0.5)]
        position: f64,

        /// Colormap
        #[arg(long, short, default_value = "blue-white-red")]
        colormap: ColormapArg,

        /// Output file path (PNG or raw f32 binary)
        #[arg(long, short)]
        output: Option<String>,
    },

    /// Extract arbitrary plane slice (defined by normal + center)
    PlaneSlice {
        /// Input cube file path
        input: String,

        /// Normal vector (3 floats: nx,ny,nz)
        #[arg(long, num_args = 3, value_delimiter = ',', allow_negative_numbers = true)]
        normal: Vec<f64>,

        /// Center point in Angstroms (3 floats: cx,cy,cz)
        #[arg(long, num_args = 3, value_delimiter = ',', allow_negative_numbers = true)]
        center: Vec<f64>,

        /// Colormap
        #[arg(long, short, default_value = "blue-white-red")]
        colormap: ColormapArg,

        /// Resolution scale (>1 = higher quality)
        #[arg(long, default_value_t = 1.0)]
        resolution: f64,

        /// Output file path (PNG)
        #[arg(long, short)]
        output: Option<String>,
    },

    /// Convert a VASP CHGCAR/LOCPOT/ELFCAR to Gaussian cube format
    ConvertChgcar {
        /// Input CHGCAR/LOCPOT/ELFCAR file path
        input: String,

        /// Output cube file path (stdout if omitted)
        #[arg(long, short)]
        output: Option<String>,
    },

    /// Compute difference charge density from three CHGCAR files (AB - A - B)
    Chgdiff {
        /// CHGCAR of combined system (AB)
        input_ab: String,

        /// CHGCAR of subsystem A
        input_a: String,

        /// CHGCAR of subsystem B
        input_b: String,

        /// Output cube file path (stdout if omitted)
        #[arg(long, short)]
        output: Option<String>,
    },

    /// Convert CHGCAR and extract isosurface as JSON in one step
    ChgcarJson {
        /// Input CHGCAR/LOCPOT/ELFCAR file path
        input: String,

        /// Isovalue threshold
        #[arg(long, short)]
        iso: f32,

        /// Generate dual (±) isosurfaces
        #[arg(long, default_value_t = false)]
        dual: bool,

        /// Decimation grid size (Å)
        #[arg(long)]
        decimate: Option<f32>,

        /// Output file (or stdout if omitted)
        #[arg(long, short)]
        output: Option<String>,
    },

    /// Output isosurface mesh as JSON (for frontend integration)
    Json {
        /// Input cube file path
        input: String,

        /// Isovalue threshold
        #[arg(long, short)]
        iso: f32,

        /// Generate dual (±) isosurfaces
        #[arg(long, default_value_t = false)]
        dual: bool,

        /// Decimation grid size (Å)
        #[arg(long)]
        decimate: Option<f32>,

        /// Output file (or stdout if omitted)
        #[arg(long, short)]
        output: Option<String>,
    },
}

#[derive(Clone, ValueEnum)]
enum OutputFormat {
    Glb,
    Obj,
}

#[derive(Clone, ValueEnum)]
enum AxisArg {
    X,
    Y,
    Z,
}

#[derive(Clone, ValueEnum)]
enum ColormapArg {
    BlueWhiteRed,
    Viridis,
    Hot,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Info { input } => cmd_info(&input),
        Commands::Isosurface {
            input,
            iso,
            dual,
            format,
            output,
            decimate,
        } => cmd_isosurface(&input, iso, dual, format, output, decimate),
        Commands::Slice {
            input,
            axis,
            position,
            colormap,
            output,
        } => cmd_slice(&input, axis, position, colormap, output),
        Commands::PlaneSlice {
            input,
            normal,
            center,
            colormap,
            resolution,
            output,
        } => cmd_plane_slice(&input, normal, center, colormap, resolution, output),
        Commands::ConvertChgcar { input, output } => cmd_convert_chgcar(&input, output),
        Commands::Chgdiff {
            input_ab,
            input_a,
            input_b,
            output,
        } => cmd_chgdiff(&input_ab, &input_a, &input_b, output),
        Commands::ChgcarJson {
            input,
            iso,
            dual,
            decimate,
            output,
        } => cmd_chgcar_json(&input, iso, dual, decimate, output),
        Commands::Json {
            input,
            iso,
            dual,
            decimate,
            output,
        } => cmd_json(&input, iso, dual, decimate, output),
    }
}

fn load_cube(path: &str) -> Result<CubeFile> {
    let start = Instant::now();
    let pb = ProgressBar::new_spinner();
    pb.set_style(
        ProgressStyle::default_spinner()
            .template("{spinner:.green} {msg}")
            .unwrap(),
    );
    pb.set_message(format!("Loading {}...", path));
    pb.enable_steady_tick(std::time::Duration::from_millis(100));

    let file = File::open(path)?;
    let cube = CubeFile::parse(file)?;

    pb.finish_with_message(format!(
        "Loaded {} in {:.1}s",
        path,
        start.elapsed().as_secs_f64()
    ));
    Ok(cube)
}

fn cmd_info(input: &str) -> Result<()> {
    let cube = load_cube(input)?;
    let h = &cube.header;

    println!("=== Cube File Info ===");
    println!("Comment 1: {}", h.comment1);
    println!("Comment 2: {}", h.comment2);
    println!("Atoms:     {}", h.n_atoms);
    println!(
        "Origin:    [{:.4}, {:.4}, {:.4}] Å",
        h.origin[0], h.origin[1], h.origin[2]
    );
    println!("Grid:      {}×{}×{}", h.dims[0], h.dims[1], h.dims[2]);
    println!(
        "Voxels:    {} ({:.1} M)",
        h.dims[0] * h.dims[1] * h.dims[2],
        (h.dims[0] * h.dims[1] * h.dims[2]) as f64 / 1e6
    );
    println!(
        "Voxel X:   [{:.6}, {:.6}, {:.6}] Å",
        h.voxel_axes[0][0], h.voxel_axes[0][1], h.voxel_axes[0][2]
    );
    println!(
        "Voxel Y:   [{:.6}, {:.6}, {:.6}] Å",
        h.voxel_axes[1][0], h.voxel_axes[1][1], h.voxel_axes[1][2]
    );
    println!(
        "Voxel Z:   [{:.6}, {:.6}, {:.6}] Å",
        h.voxel_axes[2][0], h.voxel_axes[2][1], h.voxel_axes[2][2]
    );
    println!(
        "Data range: [{:.6e}, {:.6e}]",
        cube.data_min, cube.data_max
    );
    println!();

    println!("--- Atoms ---");
    for (i, atom) in h.atoms.iter().enumerate() {
        let symbol = atomic_symbol(atom.atomic_number);
        println!(
            "  {:3}: {} (Z={}) at [{:.4}, {:.4}, {:.4}] Å",
            i + 1,
            symbol,
            atom.atomic_number,
            atom.position[0],
            atom.position[1],
            atom.position[2]
        );
    }

    Ok(())
}

fn cmd_isosurface(
    input: &str,
    iso: f32,
    dual: bool,
    format: OutputFormat,
    output: Option<String>,
    decimate: Option<f32>,
) -> Result<()> {
    let cube = load_cube(input)?;

    let start = Instant::now();
    if dual {
        let (mut pos_mesh, mut neg_mesh) = marching_cubes::extract_dual_isosurface(&cube, iso);
        normalize_normals(&mut pos_mesh);
        normalize_normals(&mut neg_mesh);

        if let Some(grid) = decimate {
            let pos_mesh_d = decimate_mesh(&pos_mesh, grid);
            let neg_mesh_d = decimate_mesh(&neg_mesh, grid);
            pos_mesh = pos_mesh_d;
            neg_mesh = neg_mesh_d;
        }

        eprintln!("Marching Cubes completed in {:.2}s", start.elapsed().as_secs_f64());

        let out_path = output.unwrap_or_else(|| {
            match format {
                OutputFormat::Glb => "isosurface.glb".to_string(),
                OutputFormat::Obj => "isosurface.obj".to_string(),
            }
        });
        let mut file = BufWriter::new(File::create(&out_path)?);

        match format {
            OutputFormat::Glb => export_glb::write_dual_glb(&pos_mesh, &neg_mesh, &mut file, iso)?,
            OutputFormat::Obj => export_obj::write_dual_obj(&pos_mesh, &neg_mesh, &mut file, iso)?,
        }

        eprintln!("Written to {}", out_path);
    } else {
        let mut mesh = marching_cubes::extract_isosurface(&cube, iso);
        normalize_normals(&mut mesh);

        if let Some(grid) = decimate {
            mesh = decimate_mesh(&mesh, grid);
        }

        eprintln!("Marching Cubes completed in {:.2}s", start.elapsed().as_secs_f64());

        let out_path = output.unwrap_or_else(|| {
            match format {
                OutputFormat::Glb => "isosurface.glb".to_string(),
                OutputFormat::Obj => "isosurface.obj".to_string(),
            }
        });
        let mut file = BufWriter::new(File::create(&out_path)?);

        match format {
            OutputFormat::Glb => {
                export_glb::write_glb(&mesh, &mut file, [0.2, 0.6, 0.9, 0.8], "isosurface")?;
            }
            OutputFormat::Obj => {
                export_obj::write_obj(&mesh, &mut file, "isosurface")?;
            }
        }

        eprintln!("Written to {}", out_path);
    }

    Ok(())
}

fn cmd_slice(
    input: &str,
    axis: AxisArg,
    position: f64,
    colormap: ColormapArg,
    output: Option<String>,
) -> Result<()> {
    let cube = load_cube(input)?;

    let slice_axis = match axis {
        AxisArg::X => SliceAxis::X,
        AxisArg::Y => SliceAxis::Y,
        AxisArg::Z => SliceAxis::Z,
    };

    let cmap = match colormap {
        ColormapArg::BlueWhiteRed => Colormap::BlueWhiteRed,
        ColormapArg::Viridis => Colormap::Viridis,
        ColormapArg::Hot => Colormap::Hot,
    };

    let slice = Slice::extract_at_fraction(&cube, slice_axis, position);
    eprintln!(
        "Slice {:?} at index {} (fraction {:.2}): {}×{}, range [{:.6e}, {:.6e}]",
        slice.axis, slice.index, position, slice.dims[0], slice.dims[1],
        slice.data_min, slice.data_max,
    );

    let out_path = output.unwrap_or_else(|| "slice.png".to_string());

    if out_path.ends_with(".bin") || out_path.ends_with(".raw") {
        // Write raw f32 binary
        let bytes = slice.to_f32_bytes();
        std::fs::write(&out_path, bytes)?;
        eprintln!("Written raw f32 data to {}", out_path);
    } else {
        // Write PNG
        let png_data = slice.to_png(cmap);
        std::fs::write(&out_path, png_data)?;
        eprintln!("Written PNG to {}", out_path);
    }

    Ok(())
}

fn cmd_plane_slice(
    input: &str,
    normal: Vec<f64>,
    center: Vec<f64>,
    colormap: ColormapArg,
    resolution: f64,
    output: Option<String>,
) -> Result<()> {
    let cube = load_cube(input)?;

    let cmap = match colormap {
        ColormapArg::BlueWhiteRed => Colormap::BlueWhiteRed,
        ColormapArg::Viridis => Colormap::Viridis,
        ColormapArg::Hot => Colormap::Hot,
    };

    let n = [normal[0], normal[1], normal[2]];
    let c = [center[0], center[1], center[2]];

    let slice = PlaneSlice::extract(&cube, c, n, resolution);
    eprintln!(
        "Plane slice: {}×{}, normal=[{:.3},{:.3},{:.3}], center=[{:.3},{:.3},{:.3}], range [{:.6e}, {:.6e}]",
        slice.dims[1], slice.dims[0],
        slice.normal[0], slice.normal[1], slice.normal[2],
        slice.center[0], slice.center[1], slice.center[2],
        slice.data_min, slice.data_max,
    );

    let out_path = output.unwrap_or_else(|| "plane_slice.png".to_string());
    let png_data = slice.to_png_with_atoms(cmap, &cube.header.atoms);
    std::fs::write(&out_path, png_data)?;
    eprintln!("Written PNG to {}", out_path);

    Ok(())
}

fn cmd_json(
    input: &str,
    iso: f32,
    dual: bool,
    decimate: Option<f32>,
    output: Option<String>,
) -> Result<()> {
    let cube = load_cube(input)?;

    let start = Instant::now();

    #[derive(serde::Serialize)]
    struct JsonOutput {
        header: cube_processor::cube::CubeHeader,
        positive: Option<marching_cubes::Mesh>,
        negative: Option<marching_cubes::Mesh>,
        isovalue: f32,
        elapsed_ms: u64,
    }

    let (positive, negative) = if dual {
        let (mut pos, mut neg) = marching_cubes::extract_dual_isosurface(&cube, iso);
        normalize_normals(&mut pos);
        normalize_normals(&mut neg);
        if let Some(grid) = decimate {
            pos = decimate_mesh(&pos, grid);
            neg = decimate_mesh(&neg, grid);
        }
        (Some(pos), Some(neg))
    } else {
        let mut mesh = marching_cubes::extract_isosurface(&cube, iso);
        normalize_normals(&mut mesh);
        if let Some(grid) = decimate {
            mesh = decimate_mesh(&mesh, grid);
        }
        (Some(mesh), None)
    };

    let elapsed = start.elapsed().as_millis() as u64;

    let json_out = JsonOutput {
        header: cube.header,
        positive,
        negative,
        isovalue: iso,
        elapsed_ms: elapsed,
    };

    match output {
        Some(path) => {
            let file = BufWriter::new(File::create(&path)?);
            serde_json::to_writer(file, &json_out)?;
            eprintln!("JSON written to {}", path);
        }
        None => {
            serde_json::to_writer(std::io::stdout().lock(), &json_out)?;
        }
    }

    Ok(())
}

fn load_chgcar(path: &str) -> Result<CubeFile> {
    let start = Instant::now();
    let pb = ProgressBar::new_spinner();
    pb.set_style(
        ProgressStyle::default_spinner()
            .template("{spinner:.green} {msg}")
            .unwrap(),
    );
    pb.set_message(format!("Loading CHGCAR {}...", path));
    pb.enable_steady_tick(std::time::Duration::from_millis(100));

    let file_type = VaspFileType::from_filename(path);
    let file = File::open(path)?;
    let cube = chgcar::parse_chgcar(file, file_type)?;

    pb.finish_with_message(format!(
        "Loaded {} ({:?}) in {:.1}s",
        path, file_type,
        start.elapsed().as_secs_f64()
    ));
    Ok(cube)
}

fn cmd_convert_chgcar(input: &str, output: Option<String>) -> Result<()> {
    let cube = load_chgcar(input)?;
    let text = chgcar::write_cube_text(&cube);

    match output {
        Some(path) => {
            std::fs::write(&path, &text)?;
            eprintln!("Written cube file to {}", path);
        }
        None => {
            print!("{}", text);
        }
    }
    Ok(())
}

fn cmd_chgdiff(
    input_ab: &str,
    input_a: &str,
    input_b: &str,
    output: Option<String>,
) -> Result<()> {
    let ab = load_chgcar(input_ab)?;
    let a = load_chgcar(input_a)?;
    let b = load_chgcar(input_b)?;

    let diff = chgcar::compute_chgdiff(&ab, &a, &b)?;
    let text = chgcar::write_cube_text(&diff);

    match output {
        Some(path) => {
            std::fs::write(&path, &text)?;
            eprintln!("Written difference cube to {}", path);
        }
        None => {
            print!("{}", text);
        }
    }
    Ok(())
}

fn cmd_chgcar_json(
    input: &str,
    iso: f32,
    dual: bool,
    decimate: Option<f32>,
    output: Option<String>,
) -> Result<()> {
    let cube = load_chgcar(input)?;

    let start = Instant::now();

    #[derive(serde::Serialize)]
    struct JsonOutput {
        header: cube_processor::cube::CubeHeader,
        positive: Option<marching_cubes::Mesh>,
        negative: Option<marching_cubes::Mesh>,
        isovalue: f32,
        elapsed_ms: u64,
    }

    let (positive, negative) = if dual {
        let (mut pos, mut neg) = marching_cubes::extract_dual_isosurface(&cube, iso);
        normalize_normals(&mut pos);
        normalize_normals(&mut neg);
        if let Some(grid) = decimate {
            pos = decimate_mesh(&pos, grid);
            neg = decimate_mesh(&neg, grid);
        }
        (Some(pos), Some(neg))
    } else {
        let mut mesh = marching_cubes::extract_isosurface(&cube, iso);
        normalize_normals(&mut mesh);
        if let Some(grid) = decimate {
            mesh = decimate_mesh(&mesh, grid);
        }
        (Some(mesh), None)
    };

    let elapsed = start.elapsed().as_millis() as u64;

    let json_out = JsonOutput {
        header: cube.header,
        positive,
        negative,
        isovalue: iso,
        elapsed_ms: elapsed,
    };

    match output {
        Some(path) => {
            let file = BufWriter::new(File::create(&path)?);
            serde_json::to_writer(file, &json_out)?;
            eprintln!("JSON written to {}", path);
        }
        None => {
            serde_json::to_writer(std::io::stdout().lock(), &json_out)?;
        }
    }

    Ok(())
}

fn atomic_symbol(z: i32) -> &'static str {
    match z {
        1 => "H",
        2 => "He",
        3 => "Li",
        4 => "Be",
        5 => "B",
        6 => "C",
        7 => "N",
        8 => "O",
        9 => "F",
        10 => "Ne",
        11 => "Na",
        12 => "Mg",
        13 => "Al",
        14 => "Si",
        15 => "P",
        16 => "S",
        17 => "Cl",
        18 => "Ar",
        19 => "K",
        20 => "Ca",
        22 => "Ti",
        23 => "V",
        24 => "Cr",
        25 => "Mn",
        26 => "Fe",
        27 => "Co",
        28 => "Ni",
        29 => "Cu",
        30 => "Zn",
        42 => "Mo",
        44 => "Ru",
        46 => "Pd",
        47 => "Ag",
        74 => "W",
        78 => "Pt",
        79 => "Au",
        _ => "??",
    }
}
