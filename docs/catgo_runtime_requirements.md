# CatGo Runtime Requirements

## 1. Purpose

This document defines the functional and architectural requirements for the CatGo workflow runtime.

The runtime is the execution kernel responsible for running graph-based workflows.

It must remain domain-agnostic and should not encode chemistry-specific logic.

---

## 2. Runtime Responsibilities

The runtime must support the following responsibilities:

- parse workflow graph templates
- validate graph structure
- instantiate workflow runs from templates and inputs
- resolve dependencies between nodes
- resolve node inputs from workflow context
- schedule executable nodes
- execute nodes through pluggable tools
- track lifecycle states for nodes and graph runs
- persist state for recovery
- track artifacts
- support retries
- invoke repair hooks
- resume interrupted executions

---

## 3. Non-Goals

The runtime must not be responsible for:

- scientific correctness of chemistry tools
- VASP or ORCA implementation details
- catalyst mechanism definition
- scheduler internals of external HPC systems
- chemistry-specific decisions such as adsorption patterns or OER logic

These belong to graph templates, tools, and domain modules.

---

## 4. Core Data Objects

The runtime must support the following core objects.

### 4.1 GraphTemplate

A reusable workflow definition.

Required fields:

- template id
- version
- description
- input schema
- node definitions
- output definitions
- metadata

### 4.2 GraphRun

A concrete execution instance of a graph template.

Required fields:

- run id
- template id
- template version
- status
- provided inputs
- node run records
- timestamps
- runtime directory
- metadata

### 4.3 NodeTemplate

A node definition inside a workflow template.

Required fields:

- node id
- tool name
- dependencies
- input bindings
- retry policy
- repair policy
- timeout
- execution mode
- metadata

### 4.4 NodeRun

A concrete execution record of one node in one graph run.

Required fields:

- node id
- current status
- resolved inputs
- outputs
- artifacts
- attempt history
- timestamps
- last error

### 4.5 ArtifactRef

A structured reference to produced output.

Artifacts may represent:

- files
- JSON data
- numeric outputs
- tables
- images
- directories

### 4.6 StructuredError

A machine-readable error representation.

Required fields:

- category
- code
- message
- retryable flag
- details

---

## 5. Graph Validation Requirements

Before execution, the runtime must validate graph templates.

Validation must include:

- all referenced dependency nodes exist
- no duplicate node ids
- the dependency structure is acyclic
- all tool references are valid or resolvable
- input binding expressions are syntactically valid
- graph outputs reference valid workflow values

If validation fails, the graph must not be instantiated for execution.

---

## 6. Input Resolution Requirements

The runtime must support structured input resolution for each node.

A node input may be derived from:

- workflow input values
- outputs of upstream nodes
- literal constants

### MVP binding syntax

The first version must support:

- `${inputs.xxx}`
- `${nodes.node_id.outputs.xxx}`

Input resolution must occur before node execution.

If resolution fails, the node must fail with a structured `InputResolution` error.

---

## 7. Node Lifecycle Requirements

Each node must have an explicit lifecycle state.

Required node states:

- `Pending`
- `Ready`
- `Running`
- `Repairing`
- `Succeeded`
- `Failed`
- `Blocked`
- `Skipped`
- `Cancelled`

The runtime must enforce legal state transitions.

The runtime must never rely on implicit state assumptions.

---

## 8. Graph Run Lifecycle Requirements

Each graph run must also have an explicit status.

Required graph run statuses:

- `Created`
- `Validated`
- `Running`
- `Paused`
- `Succeeded`
- `Failed`
- `Cancelled`
- `PartiallySucceeded`

A graph run is terminal when it reaches one of:

- `Succeeded`
- `Failed`
- `Cancelled`
- `PartiallySucceeded`

---

## 9. Scheduling Requirements

The runtime must schedule nodes based on dependency satisfaction.

A node becomes `Ready` when:

- it is currently `Pending`
- all dependency nodes are `Succeeded`

A node becomes `Blocked` when:

- any dependency is `Failed`, `Blocked`, or `Cancelled`
- and no recovery rule allows continuation

The scheduler must support concurrent execution of independent nodes.

At minimum, the runtime must support a configurable global concurrency limit.

---

## 10. Execution Requirements

The runtime must execute nodes only through pluggable tools.

For each node execution, the runtime must:

1. resolve inputs
2. prepare execution context
3. invoke the corresponding tool
4. capture structured output or structured error
5. update node state
6. persist the result
7. register produced artifacts

The runtime must not contain hardcoded logic for specific chemistry tools.

---

## 11. Tool Abstraction Requirements

The runtime must define a stable tool interface.

Each tool must support:

- a stable name
- structured input
- execution context
- structured output
- structured failure

The runtime must also provide a tool registry for:

- registering tools
- resolving tools by name
- listing available tools

This registry must allow both mock tools and real scientific tools.

---

## 12. Persistence Requirements

Execution state must be persisted so that workflow runs survive process restarts.

At minimum, the persisted state must include:

- graph run status
- node states
- resolved inputs
- outputs
- artifact references
- retry counters
- timestamps
- last error state

The recommended MVP design is:

- SQLite for state persistence
- filesystem storage for artifacts

---

## 13. Artifact Requirements

The runtime must track produced artifacts separately from execution state.

Artifact storage must support at least:

- saving JSON outputs
- registering generated files
- listing node artifacts

Artifact references must be structured and must not rely only on ad hoc file naming conventions.

---

## 14. Retry Requirements

The runtime must support node-level retry policies.

A retry policy must include:

- maximum attempts
- backoff policy
- retryable error categories

A failed execution may be retried only if:

- the retry policy allows it
- the error category is retryable
- the maximum attempt count has not been exceeded

All retry attempts must be recorded.

---

## 15. Repair Requirements

The runtime must support repair hooks for recoverable node failures.

Repair is different from retry.

- **Retry** handles transient failures
- **Repair** handles recoverable domain-aware failures

Examples of repair-worthy failures include:

- SCF non-convergence
- ionic non-convergence
- recoverable parser-detectable corruption
- restartable intermediate-state failure

The runtime must not embed chemistry-specific repair logic directly.  
Instead, it must invoke repair handlers through a pluggable repair interface.

---

## 16. Resume Requirements

The runtime must support resuming interrupted workflow runs.

When resuming a graph run, the runtime must:

1. reload persisted graph state
2. reconstruct node states
3. identify unfinished nodes
4. reevaluate dependencies
5. continue scheduling from the latest valid checkpoint

For the MVP, if a node was marked `Running` during a crash, the runtime may conservatively reset it to `Pending` with a warning.

---

## 17. Observability Requirements

The runtime must expose enough structured information for monitoring and debugging.

At minimum, it must be possible to inspect:

- graph run status
- node statuses
- retry counts
- timestamps
- last known errors
- artifact references

The runtime should be designed so that a future UI can easily render progress and failure states.

---

## 18. Agent Interface Requirements

The runtime must expose graph-level operations suitable for AI agents.

Required operations:

- `list_graph_templates`
- `describe_graph_template`
- `instantiate_graph`
- `run_graph`
- `get_graph_status`
- `resume_graph`
- `repair_failed_node`
- `list_graph_artifacts`

These operations are preferred over direct exposure of many low-level domain tools.

---

## 19. MCP Compatibility Requirements

The runtime should be designed so that graph-level operations can be exposed through MCP.

MCP is not the runtime itself.  
MCP is the interoperability layer that allows external agent systems to discover and call CatGo capabilities.

The runtime must therefore expose clean graph-level APIs that can later be wrapped as MCP tools.

---

## 20. MVP Requirements

The first stable version of the runtime must include:

- graph template model
- graph run model
- node lifecycle state machine
- DAG validation
- input resolver
- tool trait
- tool registry
- mock tool
- scheduler
- executor
- SQLite state store
- filesystem artifact store
- run and resume
- basic retry support

This is the minimum acceptable kernel.

---

## 21. Deferred Features

The following are desirable but not required for the MVP:

- conditional branching
- nested subgraphs
- distributed worker pool
- resource-aware scheduling
- human approval nodes
- advanced remote heartbeat tracking
- adaptive AI replanning
- graph rewriting during execution

These should be built on top of the stable runtime core.

---

## 22. Acceptance Criteria

The runtime may be considered successful for the MVP if it can:

1. load and validate a graph template
2. instantiate a graph run with user inputs
3. execute a small multi-node workflow using mock tools
4. persist graph and node state
5. resume an interrupted run
6. record artifacts and structured outputs
7. retry a failed node according to policy
8. expose graph status in a structured form suitable for agent consumption

This defines the minimum operational standard for the first production-oriented kernel.
