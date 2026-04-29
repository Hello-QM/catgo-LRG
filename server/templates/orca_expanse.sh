#!/bin/bash
#SBATCH --job-name="{{job_name}}"
#SBATCH --output="{{job_name}}.%j.%N.out"
#SBATCH --partition={{partition}}
#SBATCH --nodes={{nodes}}
#SBATCH --ntasks-per-node={{ntasks}}
#SBATCH --mem={{memory}}
{% if account %}#SBATCH --account={{account}}{% endif %}
#SBATCH -t {{walltime}}

# Load modules (Expanse cluster specific)
module purge
module load cpu/0.17.3b
module load gcc/10.2.0/npcyll4
module load openmpi/4.1.1

# ORCA setup
export ORCA_DIR={{orca_dir}}
export PATH=$ORCA_DIR:$PATH
export LD_LIBRARY_PATH=$ORCA_DIR/lib:$LD_LIBRARY_PATH

# Use local scratch for better I/O performance
export SCRATCH_DIR=/scratch/$USER/job_$SLURM_JOB_ID
mkdir -p $SCRATCH_DIR
cd $SCRATCH_DIR

# Copy input files from submission directory
cp $SLURM_SUBMIT_DIR/ORCA.inp .
{% comment %} Copy optional XYZ files for NEB-TS {% endcomment %}
if [ -f "$SLURM_SUBMIT_DIR/reactant.xyz" ]; then
    cp $SLURM_SUBMIT_DIR/reactant.xyz .
fi
if [ -f "$SLURM_SUBMIT_DIR/product.xyz" ]; then
    cp $SLURM_SUBMIT_DIR/product.xyz .
fi

# Run ORCA calculation
$ORCA_DIR/orca ORCA.inp > ORCA.out 2>&1

# Copy all results back to submission directory
cp -r * $SLURM_SUBMIT_DIR/

echo "Job completed at $(date)"
