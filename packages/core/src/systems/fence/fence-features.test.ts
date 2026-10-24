import { describe, expect, test } from 'bun:test'
import { FenceNode } from '../../schema'
import {
  canPlaceFenceFeature,
  fenceFeaturePlacementIssue,
  getFenceGateLeaves,
  projectPointToFence,
  resolveFenceFeatures,
} from './fence-features'

const fence = () => FenceNode.parse({ start: [0, 0], end: [10, 0] })
const gate = (center = 4) => ({ id: 'gate-test', kind: 'gate' as const, center, width: 2 })

describe('fence features', () => {
  test('places at the requested distance without choosing a different gap', () => {
    const node = { ...fence(), features: [gate(7)] }
    expect(resolveFenceFeatures(node)[0]?.centerT).toBeCloseTo(0.7)
    expect(canPlaceFenceFeature(node, { ...gate(7.2), id: 'other' })).toBe(false)
    expect(canPlaceFenceFeature(node, gate(0.3))).toBe(false)
  })
  test('explains a rejected placement without changing the placement rule', () => {
    const node = { ...fence(), features: [gate(7)] }
    expect(fenceFeaturePlacementIssue(node, { ...gate(7.2), id: 'other' })).toBe('overlap')
    expect(fenceFeaturePlacementIssue(node, gate(0.3))).toBe('end')
    expect(fenceFeaturePlacementIssue(node, { ...gate(4), width: 0.2 })).toBe('width')
    expect(fenceFeaturePlacementIssue(node, gate(4))).toBeNull()
  })
  test('projects a cursor onto a mixed path by distance along the path', () => {
    const node = {
      ...fence(),
      path: [
        [0, 0],
        [4, 0],
        [4, 6],
      ] as [number, number][],
      spanModes: ['straight', 'straight'] as const,
    }
    const result = projectPointToFence({ ...node, spanModes: [...node.spanModes] }, [4.2, 3])
    expect(result.center).toBeCloseTo(7)
    expect(result.distance).toBeCloseTo(0.2)
  })
  test('double leaves hinge at opposite jambs and preserve their widths while opening', () => {
    const node = fence()
    const feature = {
      ...gate(),
      leafType: 'double' as const,
      leafSplit: 0.6,
      openAngle: 90,
      startT: 0.3,
      endT: 0.5,
      centerT: 0.4,
    }
    const leaves = getFenceGateLeaves(node, feature)
    expect(leaves).toHaveLength(2)
    expect(leaves[0]!.hinge.x).toBeLessThan(leaves[1]!.hinge.x)
    expect(leaves[0]!.width).toBeGreaterThan(leaves[1]!.width)
    for (const leaf of leaves) {
      expect(Math.hypot(leaf.end.x - leaf.hinge.x, leaf.end.y - leaf.hinge.y)).toBeCloseTo(
        leaf.width,
      )
      expect(leaf.end.y).toBeGreaterThan(0)
    }
  })
  test('outward swing reverses the leaf direction', () => {
    const feature = { ...gate(), openAngle: 90, startT: 0.3, endT: 0.5, centerT: 0.4 }
    const inward = getFenceGateLeaves(fence(), feature)[0]!
    const outward = getFenceGateLeaves(fence(), { ...feature, swing: 'outward' })[0]!
    expect(inward.end.y).toBeCloseTo(-outward.end.y)
  })
  test('sliding leaves run along the fence beside it and part in the middle', () => {
    const feature = {
      ...gate(),
      operation: 'slide' as const,
      leafType: 'double' as const,
      startT: 0.3,
      endT: 0.5,
      centerT: 0.4,
    }
    const closed = getFenceGateLeaves(fence(), { ...feature, openAngle: 0 })
    const open = getFenceGateLeaves(fence(), { ...feature, openAngle: 90 })
    for (const [index, leaf] of open.entries()) {
      // Parallel to the fence, on the inward side, clear of the opening.
      expect(leaf.rotation).toBeCloseTo(closed[index]!.rotation)
      expect(leaf.hinge.y).toBeGreaterThan(0.05)
      expect(closed[index]!.hinge.y).toBeCloseTo(0)
    }
    expect(Math.max(open[0]!.hinge.x, open[0]!.end.x)).toBeLessThanOrEqual(3)
    expect(Math.min(open[1]!.hinge.x, open[1]!.end.x)).toBeGreaterThanOrEqual(5)
    const outward = getFenceGateLeaves(fence(), { ...feature, openAngle: 90, swing: 'outward' })
    expect(outward[0]!.hinge.y).toBeCloseTo(-open[0]!.hinge.y)
  })
})
