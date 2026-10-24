import { type AnyNode, type AnyNodeId, useInteractive, useScene } from '@pascal-app/core'

/**
 * One switch for every light in the project: the catalog lamps' shared default (each lamp's own
 * toggle follows it), and the lights that store a `lightOn` of their own, as streetscape's garden,
 * porch and street lights do. The lamps' state is a session value, so the choice is kept per
 * project in this browser and restored when the project opens; a `lightOn` is saved with the scene.
 */
const storageKey = () => `pascal:house-lights:${window.location.pathname}`

function hasOwnSwitch(node: AnyNode): node is AnyNode & { lightOn: boolean } {
  return typeof (node as { lightOn?: unknown }).lightOn === 'boolean'
}

export function areHouseLightsOn(): boolean {
  return useInteractive.getState().lampDefault
}

export function setHouseLights(on: boolean): void {
  useInteractive.getState().setLampDefault(on, true)
  const updates = Object.values(useScene.getState().nodes)
    .filter((node) => hasOwnSwitch(node) && node.lightOn !== on)
    .map((node) => ({ id: node.id as AnyNodeId, data: { lightOn: on } as Partial<AnyNode> }))
  if (updates.length > 0) useScene.getState().updateNodes(updates)
  try {
    window.localStorage.setItem(storageKey(), on ? 'on' : 'off')
  } catch {
    // Storage blocked: the switch still works for this session.
  }
}

export function toggleHouseLights(): boolean {
  const on = !areHouseLightsOn()
  setHouseLights(on)
  return on
}

/** Puts the lamps back as they were last left in this project. Writes nothing to the scene. */
export function restoreHouseLights(): void {
  let saved: string | null = null
  try {
    saved = window.localStorage.getItem(storageKey())
  } catch {
    return
  }
  if (saved === 'on' || saved === 'off') useInteractive.getState().setLampDefault(saved === 'on', true)
}
