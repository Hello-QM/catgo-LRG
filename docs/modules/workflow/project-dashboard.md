---
title: Project Dashboard
description: Project management and results visualization
source: src/lib/workflow/ProjectDashboard.svelte
---

# Project Dashboard

**Source:** `src/lib/workflow/ProjectDashboard.svelte`, `src/lib/workflow/ResultsTable.svelte`

## Overview

The project dashboard provides an overview of all workflows, their execution status, and collected results. Supports tabular and graphical result comparison.

## Components

### ProjectDashboard

Main dashboard view with project overview.

### ProjectListView

List of all projects with status indicators.

### NodeStatusPanel

Detailed status for individual workflow nodes.

### ResultsTable

Tabular view of computed results across workflow runs.

### ResultsPlot

Interactive scatter/bar plots for result comparison.

## Features

### Workflow Status Tracking

Real-time status updates for running workflows.

### Result Aggregation

Collect and compare results across multiple workflow runs.

### Export

Export results as CSV, JSON, or publication-ready tables.

## Related

- [Workflow Engine](/modules/workflow/workflow-engine)
- [Node Types](/modules/workflow/node-types)
