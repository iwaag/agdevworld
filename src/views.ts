import {
  loadExistingNodes,
  loadWorkspaceRows,
  type ActualDeviceModel,
  type ClusterStatus,
  type DriftTarget,
  type WorkspaceRow,
} from './clusterState'
import type { PanelGridConfig, PanelRowStatus } from './scenes/PanelGridScene'

// A selection carries the full source record so detail views can render
// everything the snapshot knows about the clicked panel. `device` is the
// matching nctl.actual.v2 device (with facts_raw) when a detail snapshot is
// available; main.ts attaches it before showing details.
export type PanelSelection =
  | { view: 'nodes'; target: DriftTarget; device?: ActualDeviceModel }
  | { view: 'workspaces'; row: WorkspaceRow }

const CLUSTER_STATUS_STYLE: Record<ClusterStatus, PanelRowStatus> = {
  converged: { emoji: '✅', color: 0x67e8a5, label: 'CONVERGED' },
  converging: { emoji: '🔄', color: 0x70c7ff, label: 'CONVERGING' },
  drifting: { emoji: '⚠️', color: 0xffc56d, label: 'DRIFTING' },
  unknown: { emoji: '❓', color: 0xb7b5d8, label: 'UNKNOWN' },
}

export function nodesViewConfig(onSelect: (selection: PanelSelection) => void): PanelGridConfig {
  return {
    key: 'nodes',
    title: 'cluster / now',
    loadingText: 'listening for a cluster snapshot…',
    unavailableText: 'cluster snapshot unavailable',
    subtitle: (count) => `${count} nodes are present`,
    footer: 'desired nodes with confirmed actual state',
    switchTo: { key: 'workspaces', label: 'workspaces' },
    loadRows: async () =>
      (await loadExistingNodes()).map((node) => ({
        id: node.id,
        name: node.name,
        status: CLUSTER_STATUS_STYLE[node.status],
        payload: node.entry,
      })),
    onSelect: (row) => onSelect({ view: 'nodes', target: row.payload as DriftTarget }),
  }
}

export function workspacesViewConfig(onSelect: (selection: PanelSelection) => void): PanelGridConfig {
  return {
    key: 'workspaces',
    title: 'workspaces / now',
    loadingText: 'listening for a workspace snapshot…',
    unavailableText: 'workspace snapshot unavailable',
    subtitle: (count) => `${count} workspaces are present`,
    footer: 'desired workspaces and their activity',
    switchTo: { key: 'nodes', label: 'nodes' },
    loadRows: async () =>
      (await loadWorkspaceRows()).map((row) => ({
        id: row.slug,
        name: row.name,
        status: WORKSPACE_ACTIVITY_STYLE[row.activity_class ?? ''] ?? WORKSPACE_ACTIVITY_UNKNOWN,
        detail: row.node,
        payload: row,
      })),
    onSelect: (row) => onSelect({ view: 'workspaces', row: row.payload as WorkspaceRow }),
  }
}

// Panel color/label come from activity_class — the field this envelope exists
// to surface — rather than gap codes.
const WORKSPACE_ACTIVITY_STYLE: Record<string, PanelRowStatus> = {
  active_development: { emoji: '🛠️', color: 0x67e8a5, label: 'ACTIVE DEV' },
  behind_origin: { emoji: '⏳', color: 0xffc56d, label: 'BEHIND ORIGIN' },
  idle: { emoji: '💤', color: 0xb7b5d8, label: 'IDLE' },
}

const WORKSPACE_ACTIVITY_UNKNOWN: PanelRowStatus = { emoji: '❓', color: 0xb7b5d8, label: 'UNKNOWN' }
