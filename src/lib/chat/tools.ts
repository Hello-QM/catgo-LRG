// Shared tool-definition shape. (The 12 viewer-control tools that used to live
// here as a dead `TOOL_DEFINITIONS` array — never registered into CLIENT_TOOLS —
// are now real, registered ClientTools in `viewer-tools.ts`.) This interface is
// still used by `workflow-tools.ts` (WORKFLOW_TOOL_DEFINITIONS).
export interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}
