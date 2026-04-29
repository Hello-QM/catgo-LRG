# CatGo Graph Runtime — Rust Architecture Design

## 1. Purpose

CatGo requires a workflow runtime capable of executing scientific workflows as directed graphs.

The runtime should support:

- graph-based workflow representation
- dependency-aware scheduling
- parallel execution of independent nodes
- persistent execution state
- checkpoint and resume
- retry and repair hooks
- AI-agent-facing graph operations

The runtime must remain **domain-agnostic**.  
It should not encode chemistry-specific logic such as OER, NRR, slab generation, SCF strategy, or adsorption rules.  
Those belong to tools, graph templates, and higher-level domain modules.

---

## 2. Scope

### 2.1 In Scope

The runtime is responsible for:

- parsing graph templates
- validating graph structure
- instantiating graph runs
- resolving node dependencies
- resolving node inputs
- scheduling executable nodes
- dispatching tool execution
- tracking node lifecycle states
- persisting run state
- storing artifact references
- supporting retries
- invoking repair hooks
- resuming interrupted runs

### 2.2 Out of Scope

The runtime is not responsible for:

- implementing VASP, ORCA, or chemistry workflows directly
- defining scientific mechanisms
- managing HPC scheduler internals
- validating scientific correctness of tool outputs

---

## 3. Architectural Position

CatGo should be structured in layers:

```text
AI Agent Layer
  └─ Claude Code / Codex / ChatGPT / other agents

Agent Interface Layer
  └─ list_graph_templates
  └─ describe_graph_template
  └─ instantiate_graph
  └─ run_graph
  └─ get_graph_status
  └─ resume_graph
  └─ repair_failed_node

Graph Runtime Layer
  └─ parser
  └─ validator
  └─ scheduler
  └─ executor
  └─ state machine
  └─ persistence
  └─ recovery

Tool Layer
  └─ VASP adaptor
  └─ ORCA adaptor
  └─ analysis adaptor
  └─ mock tool adaptor

Execution Backend
  └─ local execution
  └─ HPC execution
  └─ remote jobs
```

The design separation is:

- **MCP**: tool discovery and agent integration
- **Graph Runtime**: workflow orchestration and state management
- **Tools**: domain actions
- **Execution Backend**: actual compute environment

---

## 4. Design Principles

### 4.1 Domain-Agnostic Runtime

The runtime must never hardcode domain-specific chemistry concepts.

The runtime should only manage:

- graph structure
- dependency resolution
- scheduling
- state transitions
- retries
- persistence
- recovery
- artifact indexing

### 4.2 Separation of Definition and Execution

A reusable workflow definition is different from a concrete workflow execution.

Use:

- `GraphTemplate` for workflow definition
- `GraphRun` for execution instance

This separation enables:

- reproducibility
- parameterized instantiation
- multiple runs from one template
- agent-friendly APIs
- version control of workflows

### 4.3 Explicit Lifecycle State Machine

Each node must have a clearly defined lifecycle state.

This is required for:

- reliable resume
- repair workflows
- observability
- deterministic orchestration
- front-end progress monitoring

### 4.4 Persistent Execution State

Runtime state must survive process termination and restart.

At any point, the system should be able to reconstruct:

- current graph status
- node statuses
- retry counts
- tool attempts
- produced artifacts
- last known error state

### 4.5 Structured Tool Outputs

Tools must return machine-readable results.

The runtime should not rely solely on plain text logs for orchestration decisions.

Structured outputs should include:

- outputs
- artifact references
- metadata
- structured errors

---

## 5. Core Concepts

## 5.1 GraphTemplate

A `GraphTemplate` is a reusable workflow definition.

It defines:

- template id
- version
- description
- input schema
- nodes
- output definitions
- metadata

Typical examples:

- OER workflow
- NRR workflow
- DOS workflow
- band structure workflow

---

## 5.2 GraphRun

A `GraphRun` is one instantiated execution of a graph template.

It contains:

- run id
- template id
- template version
- resolved input values
- node execution records
- graph status
- timestamps
- run directory
- metadata

---

## 5.3 NodeTemplate

A `NodeTemplate` defines one executable step inside a graph template.

It contains:

- node id
- tool name
- dependency list
- input binding rules
- output specification
- retry policy
- repair policy
- timeout
- execution mode
- metadata

---

## 5.4 NodeRun

A `NodeRun` records the execution state of one node in one graph run.

It contains:

- node id
- node status
- resolved inputs
- structured outputs
- artifact references
- attempt history
- timestamps
- last error

---

## 5.5 Tool

A `Tool` is a pluggable executable unit.

Examples:

- `generate_surface`
- `enumerate_adsorbates`
- `run_vasp_relax`
- `run_vasp_freq`
- `parse_outcar`
- `compute_gibbs_free_energy`
- `plot_oer_diagram`

The runtime only assumes that a tool:

- accepts structured input
- runs in a work context
- returns structured output or structured error

---

## 5.6 Artifact

An `Artifact` is a structured reference to output data produced by a node.

Examples:

- file
- JSON result
- numeric value
- table
- image
- plot
- directory

The runtime should track artifact metadata, not just raw file paths.

---

## 6. Recommended Rust Project Structure

```text
catgo-graph/
├─ Cargo.toml
├─ src/
│  ├─ lib.rs
│  ├─ main.rs
│  │
│  ├─ core/
│  │  ├─ mod.rs
│  │  ├─ ids.rs
│  │  ├─ types.rs
│  │  ├─ state.rs
│  │  ├─ errors.rs
│  │  └─ time.rs
│  │
│  ├─ graph/
│  │  ├─ mod.rs
│  │  ├─ template.rs
│  │  ├─ run.rs
│  │  ├─ node.rs
│  │  ├─ edge.rs
│  │  ├─ validate.rs
│  │  └─ resolver.rs
│  │
│  ├─ runtime/
│  │  ├─ mod.rs
│  │  ├─ engine.rs
│  │  ├─ scheduler.rs
│  │  ├─ executor.rs
│  │  ├─ lifecycle.rs
│  │  ├─ checkpoint.rs
│  │  └─ recovery.rs
│  │
│  ├─ tools/
│  │  ├─ mod.rs
│  │  ├─ traits.rs
│  │  ├─ registry.rs
│  │  ├─ result.rs
│  │  ├─ mock.rs
│  │  ├─ vasp.rs
│  │  ├─ orca.rs
│  │  └─ analysis.rs
│  │
│  ├─ storage/
│  │  ├─ mod.rs
│  │  ├─ artifact_store.rs
│  │  ├─ state_store.rs
│  │  ├─ sqlite_store.rs
│  │  └─ file_store.rs
│  │
│  ├─ repair/
│  │  ├─ mod.rs
│  │  ├─ traits.rs
│  │  ├─ policy.rs
│  │  ├─ classifier.rs
│  │  └─ vasp_custodian.rs
│  │
│  ├─ api/
│  │  ├─ mod.rs
│  │  ├─ graph_api.rs
│  │  └─ dto.rs
│  │
│  └─ mcp/
│     ├─ mod.rs
│     ├─ tools.rs
│     └─ mapping.rs
├─ docs/
├─ examples/
└─ tests/
```

---

## 7. Core Data Model

## 7.1 ID Types

```rust
pub type GraphTemplateId = String;
pub type GraphRunId = String;
pub type NodeId = String;
pub type ArtifactId = String;
pub type ToolName = String;
```

These may later be replaced with newtype wrappers.

---

## 7.2 GraphTemplate

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphTemplate {
    pub id: GraphTemplateId,
    pub version: String,
    pub description: Option<String>,
    pub inputs_schema: serde_json::Value,
    pub nodes: Vec<NodeTemplate>,
    pub outputs: Vec<GraphOutputSpec>,
    pub metadata: Metadata,
}
```

### Responsibilities

A `GraphTemplate` should define:

- what inputs a workflow accepts
- what nodes exist
- how nodes depend on one another
- what the workflow returns

---

## 7.3 NodeTemplate

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeTemplate {
    pub id: NodeId,
    pub tool: ToolName,
    pub depends_on: Vec<NodeId>,
    pub input_bindings: serde_json::Value,
    pub output_spec: Option<NodeOutputSpec>,
    pub retry_policy: Option<RetryPolicy>,
    pub timeout_seconds: Option<u64>,
    pub repair_policy: Option<RepairPolicyRef>,
    pub execution_mode: ExecutionMode,
    pub metadata: Metadata,
}
```

### Responsibilities

A `NodeTemplate` should define:

- which tool to call
- which upstream nodes must complete first
- how to build tool inputs
- how to handle failure and retry

---

## 7.4 GraphRun

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphRun {
    pub id: GraphRunId,
    pub template_id: GraphTemplateId,
    pub template_version: String,
    pub status: GraphRunStatus,
    pub inputs: serde_json::Value,
    pub node_runs: Vec<NodeRun>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub run_dir: String,
    pub metadata: Metadata,
}
```

### Responsibilities

A `GraphRun` is the runtime source of truth for one workflow execution.

---

## 7.5 NodeRun

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeRun {
    pub node_id: NodeId,
    pub status: NodeStatus,
    pub resolved_inputs: Option<serde_json::Value>,
    pub outputs: Option<serde_json::Value>,
    pub artifacts: Vec<ArtifactRef>,
    pub attempts: Vec<NodeAttempt>,
    pub current_attempt: u32,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub last_error: Option<StructuredError>,
}
```

### Responsibilities

A `NodeRun` records current execution status and history for a node.

---

## 7.6 NodeAttempt

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeAttempt {
    pub attempt_index: u32,
    pub status: AttemptStatus,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub tool_request: serde_json::Value,
    pub tool_result: Option<ToolExecutionResult>,
    pub logs_path: Option<String>,
    pub error: Option<StructuredError>,
}
```

### Responsibilities

A `NodeAttempt` records one execution attempt, including retries.

---

## 7.7 ArtifactRef

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactRef {
    pub id: ArtifactId,
    pub kind: ArtifactKind,
    pub path: Option<String>,
    pub uri: Option<String>,
    pub metadata: Metadata,
}
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ArtifactKind {
    File,
    Json,
    Number,
    Table,
    Directory,
    Image,
    Plot,
    Unknown,
}
```

---

## 7.8 RetryPolicy

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub backoff: BackoffPolicy,
    pub retry_on: Vec<ErrorCategory>,
}
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BackoffPolicy {
    None,
    Fixed { seconds: u64 },
    Exponential { base_seconds: u64, max_seconds: u64 },
}
```

---

## 7.9 StructuredError

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructuredError {
    pub category: ErrorCategory,
    pub code: Option<String>,
    pub message: String,
    pub retryable: bool,
    pub details: serde_json::Value,
}
```

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ErrorCategory {
    ToolInvocation,
    Validation,
    InputResolution,
    Timeout,
    ExternalProcess,
    Scheduler,
    Storage,
    ScfNonConvergence,
    IonicNonConvergence,
    ParseFailure,
    RepairFailed,
    Unknown,
}
```

---

## 8. State Machine Design

## 8.1 NodeStatus

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum NodeStatus {
    Pending,
    Ready,
    Running,
    Repairing,
    Succeeded,
    Failed,
    Blocked,
    Skipped,
    Cancelled,
}
```

### State Definitions

- `Pending`: waiting for dependencies
- `Ready`: dependencies satisfied, ready to execute
- `Running`: tool is executing
- `Repairing`: repair logic is being applied
- `Succeeded`: execution completed successfully
- `Failed`: permanently failed
- `Blocked`: cannot run due to failed dependency
- `Skipped`: intentionally skipped
- `Cancelled`: manually terminated

---

## 8.2 GraphRunStatus

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum GraphRunStatus {
    Created,
    Validated,
    Running,
    Paused,
    Succeeded,
    Failed,
    Cancelled,
    PartiallySucceeded,
}
```

---

## 8.3 Allowed Node Transitions

```text
Pending   -> Ready
Ready     -> Running
Running   -> Succeeded
Running   -> Failed
Running   -> Repairing
Repairing -> Ready
Repairing -> Failed
Pending   -> Blocked
Ready     -> Skipped
Running   -> Cancelled
```

These transitions should be enforced through dedicated lifecycle functions rather than arbitrary state mutation.

---

## 9. Execution Flow

## 9.1 Graph Instantiation

When creating a `GraphRun`, the runtime should:

1. validate input values against the template input schema
2. validate graph structure and dependencies
3. create a new `GraphRun`
4. create one `NodeRun` per `NodeTemplate`
5. initialize node states
6. persist the run state

Default node initialization:

- all nodes start as `Pending`
- nodes with no dependencies may be promoted to `Ready` during scheduling

---

## 9.2 Scheduler Loop

The scheduler should repeatedly:

1. load current graph state
2. evaluate dependency satisfaction
3. transition eligible nodes from `Pending` to `Ready`
4. select ready nodes within concurrency limit
5. resolve inputs for each selected node
6. dispatch tool execution
7. collect tool results
8. update node and graph states
9. persist updated state
10. stop when graph reaches a terminal state

---

## 9.3 Ready Condition

A node becomes `Ready` if:

- current state is `Pending`
- all dependencies are `Succeeded`

A node becomes `Blocked` if:

- any dependency is `Failed`, `Blocked`, or `Cancelled`
- and no recovery rule allows continuation

---

## 10. Input Binding and Resolution

A node's inputs may come from:

- graph inputs
- outputs of upstream nodes
- constant literal values

### Supported Syntax for MVP

- `${inputs.xxx}`
- `${nodes.node_id.outputs.xxx}`

This limited syntax is sufficient for the first version and keeps the resolver simple and predictable.

---

## 10.1 Resolver Interface

```rust
pub struct InputResolver;

impl InputResolver {
    pub fn resolve(
        graph_run: &GraphRun,
        node_template: &NodeTemplate,
    ) -> Result<serde_json::Value, StructuredError> {
        todo!()
    }
}
```

### Resolver Responsibilities

The resolver should:

- detect placeholders
- retrieve referenced values
- substitute them into structured JSON input
- return resolved input payload
- fail with `InputResolution` error if any reference is invalid

---

## 11. Tool Abstraction

## 11.1 Tool Trait

```rust
#[async_trait::async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;

    async fn execute(
        &self,
        ctx: ToolExecutionContext,
        inputs: serde_json::Value,
    ) -> Result<ToolExecutionResult, StructuredError>;
}
```

### Design Rationale

The runtime must depend only on a stable interface, not on implementation details of VASP, ORCA, or analysis tools.

---

## 11.2 ToolExecutionContext

```rust
pub struct ToolExecutionContext {
    pub run_id: GraphRunId,
    pub node_id: NodeId,
    pub attempt_index: u32,
    pub work_dir: String,
}
```

This context ensures each tool has enough execution metadata to:

- write logs
- create files
- correlate outputs with graph state

---

## 11.3 ToolExecutionResult

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolExecutionResult {
    pub outputs: serde_json::Value,
    pub artifacts: Vec<ArtifactRef>,
    pub logs: Vec<String>,
    pub metadata: Metadata,
}
```

---

## 11.4 ToolRegistry

```rust
pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn Tool>>,
}
```

### Required Methods

- `register`
- `get`
- `list`

---

## 12. Runtime Engine

## 12.1 RuntimeConfig

```rust
pub struct RuntimeConfig {
    pub max_concurrent_nodes: usize,
    pub artifact_root: String,
    pub state_db_path: String,
}
```

---

## 12.2 GraphEngine

```rust
pub struct GraphEngine {
    pub config: RuntimeConfig,
    pub tool_registry: Arc<ToolRegistry>,
    pub state_store: Arc<dyn StateStore>,
    pub artifact_store: Arc<dyn ArtifactStore>,
    pub repair_registry: Arc<RepairRegistry>,
}
```

### Responsibilities

The `GraphEngine` should coordinate:

- instantiation
- scheduling
- execution
- persistence
- retries
- repairs
- resume

---

## 12.3 Core Engine API

```rust
impl GraphEngine {
    pub fn instantiate_graph(
        &self,
        template: GraphTemplate,
        inputs: serde_json::Value,
    ) -> Result<GraphRun, EngineError> {
        todo!()
    }

    pub async fn run_graph(&self, run_id: &str) -> Result<(), EngineError> {
        todo!()
    }

    pub async fn resume_graph(&self, run_id: &str) -> Result<(), EngineError> {
        todo!()
    }

    pub fn get_graph_status(&self, run_id: &str) -> Result<GraphRun, EngineError> {
        todo!()
    }

    pub async fn repair_failed_node(
        &self,
        run_id: &str,
        node_id: &str,
    ) -> Result<(), EngineError> {
        todo!()
    }
}
```

---

## 13. Persistence Design

## 13.1 Separate State Store and Artifact Store

Execution state and scientific output files should be handled separately.

Recommended MVP:

- **SQLite** for execution state
- **filesystem** for artifacts

This keeps the system:

- simple
- inspectable
- portable
- robust enough for early development

---

## 13.2 StateStore Trait

```rust
pub trait StateStore: Send + Sync {
    fn save_graph_run(&self, run: &GraphRun) -> Result<(), EngineError>;
    fn load_graph_run(&self, run_id: &str) -> Result<GraphRun, EngineError>;
    fn update_node_run(&self, run_id: &str, node: &NodeRun) -> Result<(), EngineError>;
    fn list_graph_runs(&self) -> Result<Vec<GraphRun>, EngineError>;
}
```

### Responsibilities

The state store must preserve all information necessary to reconstruct runtime state after restart.

---

## 13.3 ArtifactStore Trait

```rust
pub trait ArtifactStore: Send + Sync {
    fn save_json(
        &self,
        run_id: &str,
        node_id: &str,
        name: &str,
        value: &serde_json::Value,
    ) -> Result<ArtifactRef, EngineError>;

    fn save_file(
        &self,
        run_id: &str,
        node_id: &str,
        src_path: &str,
    ) -> Result<ArtifactRef, EngineError>;

    fn list_node_artifacts(
        &self,
        run_id: &str,
        node_id: &str,
    ) -> Result<Vec<ArtifactRef>, EngineError>;
}
```

---

## 13.4 Recommended Artifact Directory Layout

```text
artifacts/
  <run_id>/
    build_surface/
      structure.json
    relax_OH/
      OUTCAR
      CONTCAR
      vasprun.xml
      result.json
    freq_OH/
      OUTCAR
      vib.json
```

This layout is simple, inspectable, and compatible with later extensions.

---

## 14. Retry and Repair

## 14.1 Retry

Retry should be used for transient failures such as:

- temporary tool crash
- I/O interruption
- remote invocation failure
- short-lived backend unavailability

Retry decisions should be driven by:

- `RetryPolicy`
- structured error category
- current attempt count

---

## 14.2 Repair

Repair should be used for recoverable domain-aware failures such as:

- SCF non-convergence
- ionic non-convergence
- corrupted intermediate state
- restartable parser-detectable failure

Repair logic should live outside the runtime kernel.

The runtime kernel should only decide:

- whether repair is available
- whether repair succeeded
- whether retry should follow repair

---

## 14.3 RepairHandler Trait

```rust
#[async_trait::async_trait]
pub trait RepairHandler: Send + Sync {
    fn name(&self) -> &str;

    async fn repair(
        &self,
        ctx: RepairContext,
        node_run: &NodeRun,
    ) -> Result<RepairOutcome, StructuredError>;
}
```

---

## 14.4 RepairOutcome

```rust
pub struct RepairOutcome {
    pub repaired_inputs: Option<serde_json::Value>,
    pub notes: String,
    pub artifacts: Vec<ArtifactRef>,
}
```

---

## 15. Resume Semantics

When `resume_graph(run_id)` is called, the runtime should:

1. load persisted graph state
2. inspect all node states
3. identify unfinished nodes
4. reevaluate dependency conditions
5. continue from the latest valid checkpoint

### MVP Rule for Interrupted Running Nodes

If a process crashes while a node is marked `Running`, the first version may conservatively reset such nodes to `Pending` with a warning.  
More advanced heartbeat-based recovery can be added later.

---

## 16. Agent-Facing API

AI agents should interact with graph-level operations rather than many low-level domain tools.

Recommended graph-level API surface:

- `list_graph_templates`
- `describe_graph_template`
- `instantiate_graph`
- `run_graph`
- `get_graph_status`
- `resume_graph`
- `repair_failed_node`
- `list_graph_artifacts`

This design improves:

- agent reliability
- abstraction level
- orchestration stability
- interoperability across Claude Code, Codex, and other LLM clients

---

## 17. Relationship Between GraphTemplate, Skill, and MCP

Recommended mapping:

- `GraphTemplate` = reusable workflow definition
- `Skill` = agent-facing abstraction of a graph template
- `MCP tool` = protocol-level exposure of graph or skill operations

Example:

- GraphTemplate: `oer_workflow_v1`
- Skill: `evaluate_oer_activity`
- MCP tool: `run_oer_workflow`

This separation preserves architectural clarity:

- workflow semantics remain inside graph templates
- agent usability is expressed through skills
- interoperability is handled through MCP

---

## 18. Recommended MVP

The first working version should include:

- graph template model
- graph run model
- node lifecycle state machine
- DAG validator
- input resolver
- tool trait
- mock tool
- scheduler
- executor
- SQLite state store
- filesystem artifact store
- run and resume
- basic retry support

This is enough to establish a real workflow kernel.

---

## 19. Features to Defer

The following features should be postponed until after MVP:

- conditional branching
- nested subgraphs
- distributed workers
- resource-aware scheduling
- dynamic graph rewriting
- human approval gates
- advanced remote heartbeats
- adaptive AI-driven replanning

These are valuable, but not required for the first stable kernel.

---

## 20. Recommended Implementation Order

### Phase 1 — Core Model

Implement:

- `GraphTemplate`
- `GraphRun`
- `NodeTemplate`
- `NodeRun`
- `RetryPolicy`
- `StructuredError`
- lifecycle states

### Phase 2 — Validation and Resolution

Implement:

- DAG validation
- dependency checks
- input binding resolver

### Phase 3 — Execution Core

Implement:

- `Tool` trait
- `ToolRegistry`
- mock tool
- scheduler
- executor

### Phase 4 — Persistence

Implement:

- SQLite state store
- filesystem artifact store
- checkpoint persistence
- resume

### Phase 5 — Recovery and Interfaces

Implement:

- retry policy handling
- repair hooks
- graph-level agent APIs
- MCP integration

---

## 21. Recommended Rust Dependencies

Suggested crates:

- `serde`
- `serde_json`
- `serde_yaml`
- `thiserror`
- `tokio`
- `async-trait`
- `chrono`
- `uuid`
- `tracing`
- `rusqlite` or `sqlx`
- `petgraph` (optional)

These provide sufficient support for serialization, async execution, persistence, and graph validation.

---

## 22. Conclusion

The CatGo Graph Runtime should be designed as a reusable, domain-agnostic workflow kernel.

It should not be a chemistry script collection, nor a thin wrapper over tool calls.

Instead, it should become:

- the orchestration core for CatGo workflows
- the execution substrate for AI-generated scientific plans
- the stable interface layer between agent systems and scientific tools

This architecture provides the correct foundation for:

- reproducible workflow execution
- failure recovery
- graph-level AI interaction
- long-term extensibility across computational chemistry workflows
