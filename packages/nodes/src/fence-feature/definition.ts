import {
  type AnyNodeId,
  type FenceFeatureNode,
  FenceGateNode,
  FenceOpeningNode,
  type FloorplanMoveTarget,
  findLevelAncestorId,
  type NodeDefinition,
  type ParametricDescriptor,
} from '@pascal-app/core'
import type { FloorplanNodeExtension } from '@pascal-app/editor'
import { useViewer } from '@pascal-app/viewer'
import {
  AnimationClip,
  type KeyframeTrack,
  type Object3D,
  QuaternionKeyframeTrack,
  VectorKeyframeTrack,
} from 'three'
import { buildFenceFeatureFloorplan } from './floorplan'
import { fenceFeatureAffordance } from './floorplan-affordances'
import { buildFenceFeatureGeometry } from './geometry'
import { fenceFeatureHandles } from './handles'
import { FenceFeatureEditor } from './inspector'
import { toggleFenceGate } from './interaction'
import { fenceGateMechanism } from './mechanism'
import { createFenceFeatureMoveSession } from './move-session'

const floorplanMoveTarget: FloorplanMoveTarget<FenceFeatureNode> = ({ node, sceneApi }) => {
  if (!sceneApi) throw new Error('Fence feature move requires SceneApi')
  const levelId =
    (findLevelAncestorId(node.id as AnyNodeId, sceneApi.nodes()) as AnyNodeId | undefined) ?? null
  const session = createFenceFeatureMoveSession(node, sceneApi, levelId, (id) =>
    useViewer.getState().setSelection({ selectedIds: [id] }),
  )
  return {
    affectedIds: session.affectedIds,
    apply: ({ planPoint }) => session.update(planPoint),
    canCommit: session.canCommit,
    commit: session.commit,
  }
}

const parametrics: ParametricDescriptor<FenceFeatureNode> = {
  groups: [
    {
      label: 'Settings',
      fields: [{ key: 'center', kind: 'custom', component: FenceFeatureEditor }],
    },
  ],
}
const shared = {
  schemaVersion: 1,
  category: 'structure' as const,
  capabilities: {
    exterior: true,
    selectable: { hitVolume: 'bbox' as const },
    deletable: true,
  },
  geometry: buildFenceFeatureGeometry,
  floorplan: buildFenceFeatureFloorplan,
  floorplanDependencies: (node: FenceFeatureNode) =>
    node.parentId ? [node.parentId as AnyNodeId] : [],
  floorplanAffordances: { 'move-feature': fenceFeatureAffordance },
  handles: fenceFeatureHandles,
  floorplanMoveTarget,
  affordanceTools: { move: () => import('./move-tool') },
  affordanceHints: {
    move: [
      { key: 'Left click', label: 'Place on a fence' },
      { key: 'Esc', label: 'Cancel move' },
    ],
  },
  parametrics,
}
export const fenceGateDefinition: NodeDefinition<typeof FenceGateNode | typeof FenceOpeningNode> = {
  ...shared,
  kind: 'fence-gate',
  capabilities: { ...shared.capabilities, mechanism: fenceGateMechanism },
  keyboardActions: {
    e: {
      appliesTo: (node) => node.type === 'fence-gate',
      run: (node) => toggleFenceGate(node.id as AnyNodeId),
    },
  },
  schema: FenceGateNode,
  extensions: {
    'pascal:editor/floorplan': {
      actionMenu: { actions: () => import('./actions') },
    } satisfies FloorplanNodeExtension<FenceFeatureNode>,
  },
  exportAnimation: ({ node, object }) =>
    node.type === 'fence-gate' ? bakeFenceGateClip(node.id, object) : null,
  defaults: () => {
    const { id, type, ...rest } = FenceGateNode.parse({})
    return rest
  },
  presentation: {
    label: 'Gate',
    description: 'A gate hosted by a fence.',
    icon: { kind: 'url', src: '/icons/fence.webp' },
    paletteSection: 'structure',
    hidden: true,
  },
}

function bakeFenceGateClip(id: string, object: Object3D): AnimationClip | null {
  const tracks: KeyframeTrack[] = []
  object.traverse((part) => {
    const marker = part.userData.pascalFenceGateLeaf as
      | {
          openRotationY?: number
          closedPosition?: [number, number, number]
          openPosition?: [number, number, number]
        }
      | undefined
    // A sliding leaf runs along the fence: its clip moves it instead of turning it.
    const { closedPosition: shut, openPosition: slid } = marker ?? {}
    if (shut && slid && Math.hypot(slid[0] - shut[0], slid[2] - shut[2]) > 1e-5) {
      part.position.set(...shut)
      tracks.push(new VectorKeyframeTrack(`${part.uuid}.position`, [0, 1], [...shut, ...slid]))
    }
    if (typeof marker?.openRotationY !== 'number' || Math.abs(marker.openRotationY) < 1e-5) return
    part.rotation.y = 0
    const closed = part.quaternion.clone()
    part.rotation.y = marker.openRotationY
    const open = part.quaternion.clone()
    part.rotation.y = 0
    tracks.push(
      new QuaternionKeyframeTrack(
        `${part.uuid}.quaternion`,
        [0, 1],
        [...closed.toArray(), ...open.toArray()],
      ),
    )
  })
  if (tracks.length === 0) return null
  const clip = new AnimationClip(`${id}: open`, 1, tracks)
  clip.userData = { loop: false }
  return clip
}
export const fenceOpeningDefinition: NodeDefinition<
  typeof FenceGateNode | typeof FenceOpeningNode
> = {
  ...shared,
  kind: 'fence-opening',
  schema: FenceOpeningNode,
  defaults: () => {
    const { id, type, ...rest } = FenceOpeningNode.parse({})
    return rest
  },
  presentation: {
    label: 'Open Passage',
    description: 'An intentional opening in a fence.',
    icon: { kind: 'url', src: '/icons/door.webp' },
    paletteSection: 'structure',
    hidden: true,
  },
}
