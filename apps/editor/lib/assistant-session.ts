import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { dynamicTool, jsonSchema, type ToolSet } from 'ai'

/**
 * Tools the in-editor assistant must not see. The session is bound to the open
 * project, so project management, whole-scene replacement and exports stay
 * out; so do tools that need a renderer, a script host or MCP sampling, which
 * this server has none of and would only answer with a refusal.
 */
const EXCLUDED_TOOLS = new Set([
  // Project lifecycle: the assistant works on the project that is open.
  'create_project',
  'list_scenes',
  'load_scene',
  'save_scene',
  'rename_scene',
  'delete_scene',
  'get_project_status',
  // Whole-scene replacement.
  'clear_scene',
  'create_from_template',
  'create_house_from_brief',
  'generate_variants',
  // Large dumps; get_level_summary and find_by_type cover reading.
  'get_scene',
  'export_json',
  'export_glb',
  // No renderer, script host or sampling on this server.
  'view_scene',
  'view_assets',
  'add_object',
  'author_scene',
  'get_source',
  'photo_to_scene',
  'analyze_floorplan_image',
  'analyze_room_photo',
])

/**
 * Tools every step offers: reading the scene, rooms, openings, finishes and
 * furnishing (with `design_brief`, which placement requires). The rest load on
 * request through `load_tools`. Sending all of them costs ~35k input tokens a
 * step, which is slow and burns through free-tier token quotas.
 */
const CORE_TOOLS = [
  'list_levels',
  'get_level_summary',
  'get_zones',
  'get_walls',
  'get_node',
  'find_by_type',
  'measure',
  'create_room',
  'add_wall',
  'add_door',
  'add_window',
  'set_zone',
  'move_zone',
  'delete_node',
  'paint',
  'search_materials',
  'design_brief',
  'search_assets',
  'place_items',
  'place_in_room',
  'furnish_room',
  'place_design',
  'validate_design',
  'apply_patch',
  'run_batch',
  'verify_scene',
  'check_collisions',
  'undo',
  'redo',
]

const LOAD_TOOLS = 'load_tools'

/** Tool results past this length are cut so one read cannot flood the context. */
const MAX_TOOL_RESULT_CHARS = 24_000

const SIDECAR_START_TIMEOUT_MS = 60_000

type Sidecar = { url: URL; token: string }

// Kept on globalThis so dev-server module reloads reuse the running sidecar.
const SIDECAR_KEY = Symbol.for('pascal.assistant.mcpSidecar')
type SidecarGlobal = typeof globalThis & { [SIDECAR_KEY]?: Promise<Sidecar> }

function sidecarScript(): string {
  // `next dev` and `next start` run with apps/editor as the working directory.
  const script = path.join(process.cwd(), 'scripts', 'assistant-mcp-server.ts')
  if (!existsSync(script)) throw new Error(`Assistant MCP sidecar not found at ${script}`)
  return script
}

/**
 * Starts `scripts/assistant-mcp-server.ts` under Bun and resolves once it
 * reports its port. `PASCAL_ASSISTANT_MCP_URL` (with `PASCAL_ASSISTANT_MCP_TOKEN`)
 * points at an already running Pascal MCP HTTP service instead.
 */
function startSidecar(onExit: () => void): Promise<Sidecar> {
  const external = process.env.PASCAL_ASSISTANT_MCP_URL
  if (external) {
    return Promise.resolve({
      url: new URL(external),
      token: process.env.PASCAL_ASSISTANT_MCP_TOKEN ?? '',
    })
  }

  const token = randomBytes(24).toString('hex')
  const windows = process.platform === 'win32'
  // npm installs Bun on Windows as a .cmd shim, which only a shell can run.
  const child: ChildProcess = spawn(
    process.env.PASCAL_BUN_PATH || 'bun',
    [windows ? `"${sidecarScript()}"` : sidecarScript()],
    {
      env: { ...process.env, PASCAL_MCP_HTTP_TOKEN: token },
      stdio: ['ignore', 'pipe', 'inherit'],
      shell: windows,
      windowsHide: true,
    },
  )
  process.once('exit', () => child.kill())

  return new Promise<Sidecar>((resolve, reject) => {
    let ready = false
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('The assistant MCP sidecar did not start within 60 s'))
    }, SIDECAR_START_TIMEOUT_MS)

    createInterface({ input: child.stdout! }).on('line', (line) => {
      if (ready) return
      try {
        const message = JSON.parse(line) as { ready?: boolean; port?: number }
        if (!message.ready || !message.port) return
        ready = true
        clearTimeout(timer)
        resolve({ url: new URL(`http://127.0.0.1:${message.port}/mcp`), token })
      } catch {
        // Not the ready line.
      }
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`Could not start Bun for the assistant: ${error.message}`))
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      onExit()
      if (!ready) reject(new Error(`The assistant MCP sidecar exited (code ${code})`))
    })
  })
}

function getSidecar(): Promise<Sidecar> {
  const g = globalThis as SidecarGlobal
  if (!g[SIDECAR_KEY]) {
    const started = startSidecar(() => {
      if (g[SIDECAR_KEY] === started) delete g[SIDECAR_KEY]
    })
    g[SIDECAR_KEY] = started
    started.catch(() => {
      if (g[SIDECAR_KEY] === started) delete g[SIDECAR_KEY]
    })
  }
  return g[SIDECAR_KEY]
}

/**
 * The sidecar's MCP sessions share one scene store, so two assistant turns
 * must never run at once. Each turn waits for the one before it.
 */
let turnQueue: Promise<void> = Promise.resolve()

export function runExclusive<T>(run: () => Promise<T>): Promise<T> {
  const result = turnQueue.then(run, run)
  turnQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export type AssistantSession = {
  tools: ToolSet
  /** The tools to offer on the next step: the core set plus any loaded since. */
  activeTools: () => string[]
  guide: string
  close: () => Promise<void>
}

type TextContent = { type: string; text?: string }

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const text = (content as TextContent[])
    .map((part) => (part.type === 'text' ? (part.text ?? '') : `[${part.type}]`))
    .join('\n')
  return text.length > MAX_TOOL_RESULT_CHARS
    ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated]`
    : text
}

/**
 * Opens a Pascal MCP session bound to `sceneId` on the sidecar. Every write the
 * tools make is saved to the scene store and published as a live event, so an
 * editor tab open on the project picks it up without a reload.
 */
export async function openAssistantSession(sceneId: string): Promise<AssistantSession> {
  const sidecar = await getSidecar()
  const client = new Client({ name: 'pascal-editor-assistant', version: '0.1.0' })
  const transport = new StreamableHTTPClientTransport(sidecar.url, {
    requestInit: sidecar.token ? { headers: { Authorization: `Bearer ${sidecar.token}` } } : {},
  })
  await client.connect(transport)

  const close = async () => {
    // End the session on the sidecar too, so it drops the session's scene.
    await transport.terminateSession().catch(() => {})
    await client.close().catch(() => {})
  }

  try {
    const loaded = await client.callTool({ name: 'load_scene', arguments: { id: sceneId } })
    if (loaded.isError) throw new Error(resultText(loaded.content) || 'load_scene failed')

    const guideResource = await client
      .readResource({ uri: 'pascal://agent-guide' })
      .catch(() => null)
    const guide =
      guideResource?.contents
        .map((entry) => ('text' in entry && typeof entry.text === 'string' ? entry.text : ''))
        .join('\n') ?? ''

    const { tools: mcpTools } = await client.listTools()
    const tools: ToolSet = {}
    for (const mcpTool of mcpTools) {
      if (EXCLUDED_TOOLS.has(mcpTool.name)) continue
      const { $schema: _dialect, ...inputSchema } = mcpTool.inputSchema as Record<string, unknown>
      tools[mcpTool.name] = dynamicTool({
        description: mcpTool.description ?? mcpTool.name,
        inputSchema: jsonSchema(inputSchema),
        execute: async (input) => {
          const result = await client.callTool({
            name: mcpTool.name,
            arguments: (input ?? {}) as Record<string, unknown>,
          })
          const text = resultText(result.content)
          if (!result.isError) return text
          console.warn(`[assistant] ${mcpTool.name} refused: ${text.slice(0, 500)}`)
          return { error: text || 'The tool refused the call.' }
        },
      })
    }

    const active = new Set(CORE_TOOLS.filter((name) => name in tools))
    const more = Object.keys(tools).filter((name) => !active.has(name))
    if (more.length > 0) {
      tools[LOAD_TOOLS] = dynamicTool({
        description: `Makes more Pascal tools callable from your next step. Not loaded yet: ${more.join(', ')}.`,
        inputSchema: jsonSchema({
          type: 'object',
          properties: {
            names: { type: 'array', items: { type: 'string' }, description: 'Tool names to load' },
          },
          required: ['names'],
        }),
        execute: async (input) => {
          const names = ((input as { names?: unknown }).names ?? []) as unknown[]
          const loaded = names.filter(
            (name): name is string => typeof name === 'string' && more.includes(name),
          )
          for (const name of loaded) active.add(name)
          const unknown = names.filter((name) => !loaded.includes(name as string))
          return { loaded, ...(unknown.length > 0 && { unknown }) }
        },
      })
    }
    const activeTools = () => [...active, ...(more.length > 0 ? [LOAD_TOOLS] : [])]

    return { tools, activeTools, guide, close }
  } catch (error) {
    await close()
    throw error
  }
}
