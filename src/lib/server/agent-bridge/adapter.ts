import type { AgentType, AgentEvent, StreamParams, SessionInfo } from './types.js'

export interface AgentAdapter {
  readonly agent: AgentType
  stream(params: StreamParams): AsyncGenerator<AgentEvent>
  listSessions(): Promise<SessionInfo[]>
}

const adapters = new Map<AgentType, () => AgentAdapter>()

export function registerAdapter(agent: AgentType, factory: () => AgentAdapter): void {
  adapters.set(agent, factory)
}

export function createAdapter(agent: AgentType): AgentAdapter {
  const factory = adapters.get(agent)
  if (!factory) throw new Error(`Unknown agent: ${agent}`)
  return factory()
}
