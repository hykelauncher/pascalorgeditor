import type { AnyNodeId, MechanismCapability } from '@pascal-app/core'
import { isFenceGateOpen, toggleFenceGate } from './interaction'

/**
 * A gate's leaves: the walkthrough's E opens and closes it, as the editor's E does on a selected
 * gate. The swing ends in the gate's saved `openAngle`, so a gate left open stays open.
 */
export const fenceGateMechanism: MechanismCapability = {
  verb: 'open',
  icon: 'door',
  has: (node) => node.type === 'fence-gate',
  isOn: (node) => isFenceGateOpen(node.id as AnyNodeId),
  set: (node, on) => {
    if (node.type === 'fence-gate' && isFenceGateOpen(node.id as AnyNodeId) !== on) {
      toggleFenceGate(node.id as AnyNodeId)
    }
  },
}
