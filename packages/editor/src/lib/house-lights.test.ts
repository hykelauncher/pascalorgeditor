import { beforeEach, expect, test } from 'bun:test'
import { type AnyNode, type AnyNodeId, ItemNode, useInteractive, useScene } from '@pascal-app/core'
import { areHouseLightsOn, setHouseLights, toggleHouseLights } from './house-lights'

// A catalog lamp follows the shared lamp default; a garden light keeps its own `lightOn`.
const lamp = ItemNode.parse({
  id: 'item_lamp',
  asset: { id: 'floor-lamp', category: 'furniture', name: 'Floor Lamp', src: '/items/floor-lamp/model.glb', thumbnail: '/items/floor-lamp/thumbnail.webp', dimensions: [0.7, 1.86, 0.69] },
})
const gardenLight = {
  object: 'node',
  id: 'path-garden-light_test',
  type: 'streetscape:path-garden-light',
  parentId: null,
  visible: true,
  metadata: {},
  lightOn: false,
} as unknown as AnyNode

beforeEach(() => {
  useInteractive.setState({ lampDefault: false })
  useScene.setState({
    nodes: { [lamp.id]: lamp, [gardenLight.id]: gardenLight } as Record<AnyNodeId, AnyNode>,
  })
})

test('switches the lamps and every light with its own switch together', () => {
  setHouseLights(true)
  expect(areHouseLightsOn()).toBe(true)
  const light = useScene.getState().nodes[gardenLight.id as AnyNodeId] as { lightOn?: boolean }
  expect(light.lightOn).toBe(true)
  // An item without a switch of its own is left as it is.
  expect('lightOn' in useScene.getState().nodes[lamp.id as AnyNodeId]!).toBe(false)
})

test('toggles from the current state', () => {
  expect(toggleHouseLights()).toBe(true)
  expect(toggleHouseLights()).toBe(false)
  const light = useScene.getState().nodes[gardenLight.id as AnyNodeId] as { lightOn?: boolean }
  expect(light.lightOn).toBe(false)
})
