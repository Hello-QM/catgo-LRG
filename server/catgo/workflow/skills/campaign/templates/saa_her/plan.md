# SAA HER screening — plan

> **TL;DR:** Single-atom-alloy HER screening funnel: stability (E_form) -> activity
> (ΔG_H*) -> analysis. Each stage has a decision point; stage 2 only expands stage
> 1 survivors.

## Stages

1. **Stability — formation energy** (`calc/01-stability-formation-energy/`)
   Per candidate SAA slab: geo_opt -> energy -> E_form.
   **decision point:** keep candidates with E_form below the user-set threshold.

2. **Activity — ΔG_H\*** (`calc/02-activity-dGH/`)
   Per survivor: clean slab + *H slab -> geo_opt -> freq -> gibbs -> ΔG_H*.
   **decision point:** rank by |ΔG_H*|; report the top candidates.

3. **Analysis** (`analysis/`)
   E_form ranking + ΔG_H* volcano + funnel summary (P2 aggregation).

## Shared references (`refs/`)

H2 molecule + clean host slab — computed once, reused by every candidate.

## Per-calc recipe

Each candidate folder gets its own `plan.md` (method, params + citation,
convergence, restart strategy, result to extract, dependencies).
