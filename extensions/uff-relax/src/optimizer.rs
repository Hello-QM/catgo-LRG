use crate::forcefield::{EnergyTerms, System};
use glam::DVec3;

/// Per-step record from an optimization run.
#[derive(Debug, Clone)]
pub struct StepRecord {
    pub step: usize,
    pub energy: f64,
    pub fmax: f64,
    pub converged: bool,
    /// Snapshot of atom positions at this step (for trajectory export).
    /// Only populated at snapshot_interval steps to save memory.
    pub positions: Option<Vec<DVec3>>,
}

/// Result returned by `optimize_with_history`.
#[derive(Debug, Clone)]
pub struct OptimizeResult {
    pub converged: bool,
    pub iterations: usize,
    pub final_energy: EnergyTerms,
    pub final_fmax: f64,
    pub history: Vec<StepRecord>,
}

/// Optimizer for molecular structures using the FIRE (Fast Iterative Relaxation Engine) algorithm.
pub struct UffOptimizer {
    /// Maximum number of iterations to perform.
    pub max_iterations: usize,
    /// Threshold for the maximum force on any atom (kcal/mol/Å).
    pub force_threshold: f64,
    /// Whether to print optimization progress to stdout.
    pub verbose: bool,
    /// Number of threads to use. 0 means automatic based on system size.
    pub num_threads: usize,
    /// Cutoff distance for non-bonded interactions (Å).
    pub cutoff: f64,
    /// Number of steps to average for convergence criteria.
    pub history_size: usize,
    /// Optional list of atom indices that are allowed to move.
    /// If None, all atoms move. If Some, only listed atoms move.
    pub mobile_indices: Option<Vec<usize>>,
    /// Interval at which to save position snapshots for trajectory export.
    /// 1 = every step, 10 = every 10th step, etc. First and last steps are always saved.
    pub snapshot_interval: usize,
}

impl UffOptimizer {
    /// Creates a new optimizer with default settings.
    ///
    /// # Arguments
    /// * `max_iterations` - Maximum number of steps.
    /// * `force_threshold` - Convergence threshold for forces.
    pub fn new(max_iterations: usize, force_threshold: f64) -> Self {
        Self {
            max_iterations,
            force_threshold,
            verbose: false,
            num_threads: 0,
            cutoff: 6.0,
            history_size: 10,
            mobile_indices: None,
            snapshot_interval: 1,
        }
    }

    pub fn with_num_threads(mut self, num_threads: usize) -> Self {
        self.num_threads = num_threads;
        self
    }

    pub fn with_cutoff(mut self, cutoff: f64) -> Self {
        self.cutoff = cutoff;
        self
    }

    pub fn with_history_size(mut self, size: usize) -> Self {
        self.history_size = size;
        self
    }

    pub fn with_verbose(mut self, verbose: bool) -> Self {
        self.verbose = verbose;
        self
    }

    pub fn with_mobile_indices(mut self, indices: Option<Vec<usize>>) -> Self {
        self.mobile_indices = indices;
        self
    }

    pub fn with_snapshot_interval(mut self, interval: usize) -> Self {
        self.snapshot_interval = if interval == 0 { 1 } else { interval };
        self
    }

    /// Optimized structural geometry using the FIRE algorithm.
    pub fn optimize(&self, system: &mut System) {
        let n = system.atoms.len();
        let mut velocities = vec![DVec3::ZERO; n];

        // Build a boolean mask: true = atom can move
        let is_mobile: Vec<bool> = match &self.mobile_indices {
            Some(indices) => {
                let mut mask = vec![false; n];
                for &idx in indices {
                    if idx < n { mask[idx] = true; }
                }
                mask
            }
            None => vec![true; n],
        };
        
        let mut dt = 0.02;
        let dt_max = 0.2;
        let mut n_pos = 0;
        let mut alpha = 0.1;
        let alpha_start = 0.1;

        // Convergence history
        let mut fmax_history = std::collections::VecDeque::with_capacity(self.history_size);
        let mut frms_history = std::collections::VecDeque::with_capacity(self.history_size);
        let mut ediff_history = std::collections::VecDeque::with_capacity(self.history_size);
        let mut last_energy: Option<f64> = None;
        
        #[cfg(not(target_arch = "wasm32"))]
        let start_time = std::time::Instant::now();

        if self.verbose {
            let version_str = format!(" uff-relax v{} ", env!("CARGO_PKG_VERSION"));
            println!("\n{:=^80}", version_str);
            println!("{:<10} {:<10} | {:<10} {:<10}", "Atoms:", n, "Bonds:", system.bonds.len());
            println!("{:<10} {:<10.1} | {:<10} {:<10.4} kcal/mol/Å", "Cutoff:", self.cutoff, "Threshold:", self.force_threshold);
            println!("{:<10} {:<10} | {:<10} {:<10}", "Max Iter:", self.max_iterations, "Threads:", if self.num_threads == 0 { "Auto".to_string() } else { self.num_threads.to_string() });
            println!("{:-<80}", "");
            println!("{:<6} | {:<14} | {:<14} | {:<16} | {:<10}", "", "Fmax", "FRMS", "Total E", "");
            println!("{:<6} | {:<14} | {:<14} | {:<16} | {:<10}", "Iter", "(kcal/mol/Å)", "(kcal/mol/Å)", "(kcal/mol)", "Status");
            println!("{:-<80}", "");
        }

        let mut final_iter = 0;
        let mut final_status = "Max-Iter";

        for iter in 0..self.max_iterations {
            final_iter = iter;
            let energy = system.compute_forces_with_threads(self.num_threads, self.cutoff);

            // Zero out forces on frozen atoms so they never move
            for i in 0..n {
                if !is_mobile[i] {
                    system.atoms[i].force = DVec3::ZERO;
                }
            }

            // Calculate Fmax and FRMS
            let mut max_f_sq: f64 = 0.0;
            let mut sum_f_sq: f64 = 0.0;
            for atom in &system.atoms {
                let f_sq = atom.force.length_squared();
                max_f_sq = f64::max(max_f_sq, f_sq);
                sum_f_sq += f_sq;
            }
            let f_max = max_f_sq.sqrt();
            let f_rms = (sum_f_sq / (3.0 * n as f64)).sqrt();

            // Update history
            if fmax_history.len() >= self.history_size { fmax_history.pop_front(); }
            fmax_history.push_back(f_max);
            
            if frms_history.len() >= self.history_size { frms_history.pop_front(); }
            frms_history.push_back(f_rms);

            if let Some(prev_e) = last_energy {
                if ediff_history.len() >= self.history_size { ediff_history.pop_front(); }
                ediff_history.push_back((energy.total - prev_e).abs() / n as f64);
            }
            last_energy = Some(energy.total);

            // Convergence Check
            let mut converged = false;
            let mut status = "";
            if fmax_history.len() >= self.history_size {
                let avg_fmax: f64 = fmax_history.iter().sum::<f64>() / self.history_size as f64;
                let avg_frms: f64 = frms_history.iter().sum::<f64>() / self.history_size as f64;
                let avg_ediff: f64 = if ediff_history.is_empty() { 1.0 } else { ediff_history.iter().sum::<f64>() / ediff_history.len() as f64 };

                if avg_fmax < self.force_threshold {
                    converged = true;
                    status = "Fmax-Conv";
                } else if avg_fmax < self.force_threshold * 2.0 && avg_frms < self.force_threshold * 0.5 {
                    converged = true;
                    status = "FRMS-Conv";
                } else if !ediff_history.is_empty() && avg_ediff < 1e-7 {
                    converged = true;
                    status = "E-Stalled";
                }
            }
            
            if self.verbose && (iter % 10 == 0 || converged) {
                println!("{:>6} | {:>14.4} | {:>14.4} | {:>16.4} | {:<10}", iter, f_max, f_rms, energy.total, status);
            }

            if converged {
                final_status = status;
                break;
            }

            // FIRE logic
            let mut p = 0.0;
            for i in 0..n {
                p += velocities[i].dot(system.atoms[i].force);
            }

            for i in 0..n {
                let f_norm = system.atoms[i].force.length();
                if f_norm > 1e-9 {
                    velocities[i] = (1.0 - alpha) * velocities[i] + alpha * (system.atoms[i].force / f_norm) * velocities[i].length();
                }
            }

            if p > 0.0 {
                n_pos += 1;
                if n_pos > 5 {
                    dt = f64::min(dt * 1.1, dt_max);
                    alpha *= 0.99;
                }
            } else {
                n_pos = 0;
                dt *= 0.5;
                alpha = alpha_start;
                for v in &mut velocities {
                    *v = DVec3::ZERO;
                }
            }

            // Verlet integration (Simplified)
            for i in 0..n {
                velocities[i] += system.atoms[i].force * dt;
                system.atoms[i].position += velocities[i] * dt;
            }
        }

        if self.verbose {
            let final_energy = system.compute_forces_with_threads(self.num_threads, self.cutoff);
            println!("{:-<80}", "");
            println!("=== Optimization Finished ===");
            println!("Reason: {:<20}", final_status);
            #[cfg(not(target_arch = "wasm32"))]
            {
                let duration = start_time.elapsed();
                println!("Total Time: {:<10.3?} (Avg: {:.3?} / step)", duration, duration / (final_iter + 1) as u32);
            }
            println!("Final Energy: {:<15.4} kcal/mol", final_energy.total);
            println!("Final Fmax:   {:<15.4} kcal/mol/Å", fmax_history.back().unwrap_or(&0.0));
            println!("Final FRMS:   {:<15.4} kcal/mol/Å", frms_history.back().unwrap_or(&0.0));
            println!("{:>80}", "(c) 2026 Forblaze Project");
            println!("{:-<80}\n", "");
        }
    }

    /// Like `optimize`, but returns per-step history for visualization.
    pub fn optimize_with_history(&self, system: &mut System) -> OptimizeResult {
        let n = system.atoms.len();
        let mut velocities = vec![DVec3::ZERO; n];
        let mut history = Vec::with_capacity(self.max_iterations);

        let is_mobile: Vec<bool> = match &self.mobile_indices {
            Some(indices) => {
                let mut mask = vec![false; n];
                for &idx in indices {
                    if idx < n { mask[idx] = true; }
                }
                mask
            }
            None => vec![true; n],
        };

        let mut dt = 0.02;
        let dt_max = 0.2;
        let mut n_pos = 0;
        let mut alpha = 0.1;
        let alpha_start = 0.1;

        let mut fmax_history = std::collections::VecDeque::with_capacity(self.history_size);
        let mut frms_history = std::collections::VecDeque::with_capacity(self.history_size);
        let mut ediff_history = std::collections::VecDeque::with_capacity(self.history_size);
        let mut last_energy: Option<f64> = None;

        let mut actual_iterations = 0;
        let mut did_converge = false;

        for iter in 0..self.max_iterations {
            actual_iterations = iter + 1;
            let energy = system.compute_forces_with_threads(self.num_threads, self.cutoff);

            for i in 0..n {
                if !is_mobile[i] {
                    system.atoms[i].force = DVec3::ZERO;
                }
            }

            let mut max_f_sq: f64 = 0.0;
            let mut sum_f_sq: f64 = 0.0;
            for atom in &system.atoms {
                let f_sq = atom.force.length_squared();
                max_f_sq = f64::max(max_f_sq, f_sq);
                sum_f_sq += f_sq;
            }
            let f_max = max_f_sq.sqrt();
            let f_rms = (sum_f_sq / (3.0 * n as f64)).sqrt();

            if fmax_history.len() >= self.history_size { fmax_history.pop_front(); }
            fmax_history.push_back(f_max);
            if frms_history.len() >= self.history_size { frms_history.pop_front(); }
            frms_history.push_back(f_rms);
            if let Some(prev_e) = last_energy {
                if ediff_history.len() >= self.history_size { ediff_history.pop_front(); }
                ediff_history.push_back((energy.total - prev_e).abs() / n as f64);
            }
            last_energy = Some(energy.total);

            let mut converged = false;
            if fmax_history.len() >= self.history_size {
                let avg_fmax: f64 = fmax_history.iter().sum::<f64>() / self.history_size as f64;
                let avg_frms: f64 = frms_history.iter().sum::<f64>() / self.history_size as f64;
                let avg_ediff: f64 = if ediff_history.is_empty() { 1.0 } else { ediff_history.iter().sum::<f64>() / ediff_history.len() as f64 };
                if avg_fmax < self.force_threshold {
                    converged = true;
                } else if avg_fmax < self.force_threshold * 2.0 && avg_frms < self.force_threshold * 0.5 {
                    converged = true;
                } else if !ediff_history.is_empty() && avg_ediff < 1e-7 {
                    converged = true;
                }
            }

            // Save position snapshots at configured interval (first + last always saved)
            let save_snapshot = iter == 0 || iter % self.snapshot_interval == 0 || converged;
            let positions = if save_snapshot {
                Some(system.atoms.iter().map(|a| a.position).collect())
            } else {
                None
            };

            history.push(StepRecord {
                step: iter,
                energy: energy.total,
                fmax: f_max,
                converged,
                positions,
            });

            if converged {
                did_converge = true;
                break;
            }

            // FIRE logic
            let mut p = 0.0;
            for i in 0..n {
                p += velocities[i].dot(system.atoms[i].force);
            }
            for i in 0..n {
                let f_norm = system.atoms[i].force.length();
                if f_norm > 1e-9 {
                    velocities[i] = (1.0 - alpha) * velocities[i] + alpha * (system.atoms[i].force / f_norm) * velocities[i].length();
                }
            }
            if p > 0.0 {
                n_pos += 1;
                if n_pos > 5 {
                    dt = f64::min(dt * 1.1, dt_max);
                    alpha *= 0.99;
                }
            } else {
                n_pos = 0;
                dt *= 0.5;
                alpha = alpha_start;
                for v in &mut velocities {
                    *v = DVec3::ZERO;
                }
            }

            for i in 0..n {
                velocities[i] += system.atoms[i].force * dt;
                system.atoms[i].position += velocities[i] * dt;
            }
        }

        let final_energy = system.compute_forces_with_threads(self.num_threads, self.cutoff);
        let final_fmax = system.atoms.iter()
            .map(|a| a.force.length())
            .fold(0.0_f64, f64::max);

        OptimizeResult {
            converged: did_converge,
            iterations: actual_iterations,
            final_energy,
            final_fmax,
            history,
        }
    }
}