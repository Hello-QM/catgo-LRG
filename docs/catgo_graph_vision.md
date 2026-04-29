# CatGo Graph Vision

## 1. Purpose

CatGo is intended to become an AI-native computational catalysis platform.

Its long-term goal is not only to run calculations, but to provide a unified system in which:

- scientific workflows are represented explicitly
- tools are orchestrated consistently
- execution is recoverable and inspectable
- AI agents can plan and trigger workflows at a high level

To support this, CatGo requires a graph-native workflow model.

---

## 2. Problem Statement

Traditional computational chemistry workflows are often implemented as:

- shell scripts
- ad hoc Python scripts
- manually chained calculation steps
- workflow managers primarily designed for human-authored pipelines

These approaches are often sufficient for single-user execution, but they are weak in the following areas:

- poor observability
- weak resume semantics
- limited AI interoperability
- limited portability of workflow definitions
- fragile failure recovery
- unclear separation between workflow logic and execution logic

CatGo needs a workflow system that is explicit, structured, and agent-compatible.

---

## 3. Core Idea

All CatGo workflows should be represented as **directed graphs**.

In this model:

- **nodes** represent executable tasks
- **edges** represent dependencies
- **graph templates** represent reusable workflow definitions
- **graph runs** represent concrete executions of those workflows

This graph-native design allows CatGo to support:

- dependency-aware scheduling
- parallel execution
- checkpointing and resume
- structured artifact tracking
- graph-level APIs for AI agents

---

## 4. Why Graphs

Scientific workflows in computational catalysis are naturally graph-structured.

For example, an OER workflow may look like:

```text
surface construction
        ↓
adsorbate enumeration
        ↓
 ┌──────┬───────┬──────┐
OH      O      OOH
 ↓       ↓       ↓
relax   relax   relax
 ↓       ↓       ↓
freq    freq    freq
  \       |       /
   \      |      /
    free energy assembly
           ↓
   overpotential evaluation
```

This is not a simple linear script. It contains:

- branching
- synchronization points
- reusable subpatterns
- independent tasks that can run in parallel

A graph representation matches this structure directly.

---

## 5. Strategic Vision

CatGo should not be only a collection of chemistry tools.

It should evolve into a system with the following layers:

1. **Graph Templates**  
   Reusable workflow definitions.

2. **Runtime Kernel**  
   A domain-agnostic engine that validates, schedules, executes, persists, and resumes graph runs.

3. **Tool Ecosystem**  
   Pluggable scientific tools such as VASP, ORCA, adsorption generation, Gibbs free energy analysis, structure analysis, and plotting.

4. **Agent Interface Layer**  
   High-level operations that allow Claude Code, Codex, ChatGPT, and similar systems to work with workflows rather than only low-level tools.

This architecture enables CatGo to function as an AI-compatible scientific workflow platform rather than a script collection.

---

## 6. Relationship to AI Systems

Modern AI systems work best when capabilities are exposed at the correct abstraction level.

If CatGo only exposes many low-level tools, agents must manually reconstruct workflow logic every time.

That leads to:

- unstable planning
- repeated reasoning cost
- inconsistent execution
- poor recoverability

Instead, CatGo should expose workflow-level operations such as:

- list available workflow templates
- inspect workflow inputs
- instantiate a workflow
- run a workflow
- inspect workflow status
- resume failed workflows
- repair failed nodes

This allows AI systems to interact with CatGo at the level of **scientific intent**, not just individual commands.

---

## 7. Separation of Responsibilities

CatGo should clearly separate the following concerns.

### 7.1 Runtime responsibility

The runtime should manage:

- graph structure
- dependency resolution
- scheduling
- node state transitions
- persistence
- artifact indexing
- retries
- repair hooks
- resume

### 7.2 Tool responsibility

Tools should manage:

- domain logic
- file generation
- scientific computation
- parsing and data extraction
- plotting and analysis

### 7.3 Agent responsibility

Agents should manage:

- user intent interpretation
- workflow selection
- parameter filling
- monitoring decisions
- optional repair triggering
- high-level orchestration decisions

This separation is essential for long-term maintainability.

---

## 8. Relationship with MCP

CatGo should support MCP, but MCP is not the same thing as the graph runtime.

Their roles are different:

- **MCP** provides protocol-level tool discovery and agent interoperability
- **Graph Runtime** provides workflow orchestration and execution state management
- **Tools** perform domain actions

The intended relationship is:

```text
GraphTemplate → Skill → MCP-exposed operation
```

In practice:

- a graph template defines a reusable workflow
- a skill provides an agent-facing description of what that workflow does
- MCP exposes the corresponding operations to external agent systems

---

## 9. Long-Term Capabilities

Once the graph runtime is stable, CatGo can evolve toward more advanced capabilities, including:

- AI-generated graph instantiation
- graph template libraries for common catalysis workflows
- workflow reuse across multiple projects
- adaptive repair strategies
- nested workflows and subgraphs
- automated monitoring dashboards
- graph-level provenance and reproducibility
- multi-agent collaboration around graph runs

These should be built on top of a stable graph kernel rather than embedded directly into low-level tools.

---

## 10. Design Principles

CatGo's graph-based workflow system should follow these principles:

### 10.1 Domain-agnostic runtime

The runtime should not hardcode chemistry-specific logic.

### 10.2 Explicit workflows

Workflow structure should be represented explicitly as data, not hidden inside scripts.

### 10.3 Recoverable execution

Every workflow should be resumable after interruption.

### 10.4 Structured outputs

Results should be machine-readable and traceable.

### 10.5 Agent-compatible abstraction

Expose workflows to AI systems at a higher level than raw tools.

### 10.6 Extensibility

The architecture should support new tools, new graph templates, and new execution backends without redesigning the runtime.

---

## 11. Target Outcome

The desired outcome is for CatGo to become:

- a graph-native workflow platform
- an execution kernel for computational catalysis workflows
- a structured interface layer between AI agents and scientific tools
- a foundation for future AI-native scientific automation

CatGo should ultimately behave less like a collection of scripts and more like a scientific operating substrate for computational catalysis.
