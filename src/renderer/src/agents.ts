import { BUILT_IN_CONNECTORS, type AgentConnector } from '@shared/connectors'
import { useQuery } from './hooks'

/** Every agent Eregion can run, built-in and yours. Until the list arrives, the built-in ones. */
export function useConnectors(): AgentConnector[] {
  return useQuery(() => window.eregion.listConnectors(), []).data ?? BUILT_IN_CONNECTORS
}

/** An agent's name for the screen; one that's been removed shows its id. */
export function agentName(connectors: AgentConnector[], id: string): string {
  return connectors.find((connector) => connector.id === id)?.name ?? `${id} (removed)`
}
