---
title: Job Scripts
description: HPC job script generation and management
source: src/lib/workflow/JobScriptWorkplace.svelte
---

# Job Scripts

**Source:** `src/lib/workflow/JobScriptWorkplace.svelte`, `src/lib/workflow/job-script-store.svelte.ts`

## Overview

Generate and manage HPC job scripts for SLURM, PBS, and other schedulers. Integrates with the workflow engine for automated submission.

## Components

### JobScriptWorkplace

Interactive editor for job script creation and management.

## Scheduler Support

### SLURM

Generate `sbatch` scripts with resource specifications.

### PBS/Torque

Generate `qsub` scripts for PBS-based clusters.

## Features

### Template System

Pre-configured templates for common DFT codes (VASP, QE, LAMMPS).

### Resource Configuration

- Nodes, tasks, memory
- Wall time
- Queue/partition selection
- GPU allocation

### Environment Modules

Configure module loads for software dependencies.

## Server API

**Endpoints:**
- `POST /api/hpc/submit` — Submit a job
- `GET /api/hpc/status` — Check job status

## Related

- [Workflow Engine](/modules/workflow/workflow-engine)
- [Project Dashboard](/modules/workflow/project-dashboard)
