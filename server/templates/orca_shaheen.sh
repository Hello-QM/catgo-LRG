#!/bin/bash
#SBATCH --job-name="{{job_name}}"
#SBATCH --output="{{job_name}}.%j.out"
#SBATCH --partition={{partition}}
#SBATCH --nodes={{nodes}}
#SBATCH --ntasks-per-node={{ntasks}}
{% if memory %}#SBATCH --mem={{memory}}{% endif %}
{% if account %}#SBATCH --account={{account}}{% endif %}
#SBATCH --time={{walltime}}

# Shaheen II specific modules
module purge
module load intel
module load impi
module load mkl

# ORCA setup for Shaheen II
export ORCA_DIR={{orca_dir}}
export PATH=$ORCA_DIR:$PATH
export LD_LIBRARY_PATH=$ORCA_DIR/lib:$LD_LIBRARY_PATH
export LD_LIBRARY_PATH=$MKL_HOME/lib/intel64:$LD_LIBRARY_PATH

# Set MPI environment
export I_MPI_PMI_LIBRARY=/usr/lib64/libpmi.so

# Use local scratch for performance
export SCRATCH_DIR=$TMPDIR/catgo_job_$SLURM_JOB_ID
mkdir -p $SCRATCH_DIR
cd $SCRATCH_DIR

# Copy input files
cp $SLURM_SUBMIT_DIR/ORCA.inp .
if [ -f "$SLURM_SUBMIT_DIR/reactant.xyz" ]; then
    cp $SLURM_SUBMIT_DIR/reactant.xyz .
fi
if [ -f "$SLURM_SUBMIT_DIR/product.xyz" ]; then
    cp $SLURM_SUBMIT_DIR/product.xyz .
fi

# Run ORCA with Intel MPI
$ORCA_DIR/orca ORCA.inp > ORCA.out 2>&1

# Copy results back
cp -r * $SLURM_SUBMIT_DIR/
