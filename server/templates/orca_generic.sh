#!/bin/bash
#SBATCH --job-name="{{job_name}}"
#SBATCH --nodes={{nodes}}
#SBATCH --ntasks-per-node={{ntasks}}
{% if partition %}#SBATCH --partition={{partition}}{% endif %}
{% if memory %}#SBATCH --mem={{memory}}{% endif %}
{% if account %}#SBATCH --account={{account}}{% endif %}
#SBATCH --time={{walltime}}
#SBATCH --output={{job_name}}.log
#SBATCH --error={{job_name}}.err

# Set up environment (customize as needed for your cluster)
{% if module_loads %}{{module_loads}}{% endif %}

# ORCA setup
{% if orca_dir %}export ORCA_DIR={{orca_dir}}
export PATH=$ORCA_DIR:$PATH
export LD_LIBRARY_PATH=$ORCA_DIR/lib:$LD_LIBRARY_PATH{% endif %}

# Work directory
cd {{work_dir}}

# Run ORCA calculation
{{calc_command}}
