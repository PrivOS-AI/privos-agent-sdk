import { Agent, type AgentOptions, type WorkingMemory } from '@privos_ai/privos-agent-sdk';
import type { SessionStore } from '@privos_ai/privos-agent-sdk/sessions';

/** The host authenticates the human and binds both adapters before calling this. */
export function privateProjectAgent(
  options: Omit<AgentOptions, 'workingMemory' | 'sessionStore'>,
  workingMemory: WorkingMemory,
  privateSessions: SessionStore,
): Agent {
  return new Agent({ ...options, workingMemory, sessionStore: privateSessions });
}
