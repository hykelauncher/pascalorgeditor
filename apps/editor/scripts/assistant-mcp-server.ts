/**
 * Pascal MCP sidecar for the in-editor assistant (`app/api/scenes/[id]/assistant`).
 *
 * The scene store is a client module (`'use client'` in @pascal-app/core), so
 * a Next.js route cannot host the MCP bridge itself; `lib/assistant-session.ts`
 * spawns this script with Bun instead. It serves the same tools as
 * `pascal-mcp --http`, on loopback only, behind the bearer token in
 * PASCAL_MCP_HTTP_TOKEN, writing to the same scene store as the editor (so the
 * editor's live events carry every change to open tabs). It reports its port
 * as one JSON line on stdout and exits when the process that started it does.
 */
import '../../../packages/mcp/src/bridge/node-shims'
import { SceneBridge } from '../../../packages/mcp/src/bridge/scene-bridge'
import { createPascalMcpServer } from '../../../packages/mcp/src/server'
import { createSceneStore } from '../../../packages/mcp/src/storage'
import { connectHttp } from '../../../packages/mcp/src/transports/http'

const authToken = process.env.PASCAL_MCP_HTTP_TOKEN
if (!authToken) {
  console.error('[assistant-mcp] PASCAL_MCP_HTTP_TOKEN is required')
  process.exit(1)
}

const store = await createSceneStore(process.env)
const handle = await connectHttp(
  () => {
    const bridge = new SceneBridge()
    bridge.loadDefault()
    bridge.clearHistory()
    return createPascalMcpServer({ bridge, store, name: 'pascal-editor-assistant' })
  },
  0,
  // One trusted local caller drives many tool calls per turn: no rate limit.
  { authToken, rateLimitPerMinute: 0 },
)
console.log(JSON.stringify({ ready: true, port: handle.port }))

const parentPid = process.ppid
const shutdown = async () => {
  try {
    await handle.close()
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
setInterval(() => {
  try {
    process.kill(parentPid, 0)
  } catch {
    void shutdown()
  }
}, 2000).unref()
