import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from 'ai'
import {
  defaultAssistantModel,
  listAssistantModels,
  resolveAssistantModel,
} from '@/lib/assistant-models'
import { openAssistantSession, runExclusive } from '@/lib/assistant-session'
import {
  guardSceneApiRequest,
  sceneApiJson,
  sceneApiPreflight,
  withSceneApiHeaders,
} from '@/lib/scene-api-security'
import { getSceneOperations } from '@/lib/scene-store-server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

type RouteParams = { params: Promise<{ id: string }> }

/** Model steps per turn: each step is one model call and the tools it runs. */
const MAX_STEPS = 40

const EDITOR_INSTRUCTIONS = `You are the assistant built into the Pascal editor, working on the project the user has open.

- The project is already loaded and bound: every change your tools make is saved and appears in the user's editor right away. Never ask the user to save or reload.
- Before changing something, read what is there (list_levels, get_level_summary, get_zones, get_walls, find_by_type) and keep unrelated work intact.
- Pascal uses metres; X and Z are the floor plan, Y is up.
- Only the common tools are loaded. If you need another one (roofs, stairs, levels, fences, units…), call load_tools with its name first.
- Prefer one batched call (run_batch, place_items with several items) over many single calls. run_batch cannot run apply_patch: call apply_patch on its own.
- paint takes walls, slabs, ceilings, doors, windows, cabinets and items, not zones: paint a room's walls (get_walls) and floor slab.
- add_fence makes the fence only. A gate is a node on a fence: after add_fence, apply_patch [{"op":"create","parentId":"<fence id>","node":{"type":"fence-gate","center":<metres from the fence's start>,"width":1.1}}] (about 3 m wide for a driveway).
- A floor plan or sketch the user attaches: read each room's name and size from it (the printed dimensions; else scale from a door at 0.9 m), say in one line what you read, then build the rooms side by side with create_room, sharing walls, and add the doors and windows it shows.
- If a tool refuses, read its code and message, adjust, and try again; tell the user if you cannot do it.
- Place each piece once, where it fits. Run check_collisions at most twice a turn: move or remove only what it names, and if overlaps remain after the second round, stop and list them rather than placing everything again.
- When you finish, reply in a few short sentences: what you changed, with names and sizes. Do not paste tool output.

# Furnishing

Placing or making furniture is refused until design_brief has recorded the request, once per turn. Where the furniture comes from is the brief's source:
- source "catalog" only when the person's own words name the catalog ("from the catalog", "catalog furniture"). Put those exact words in sourceQuote. Then furnish_room, place_items and place_in_room work.
- Otherwise source is "open": catalog placement is refused and the pieces would have to be designed. Do not loop on it: say so and ask whether catalog furniture is fine.

A design_brief input that is accepted (seven axes, each {kind:"open", design: at least a few words} or {kind:"bounded", quote: the person's words (≤300 characters), reading}; beyond names pieces for at least six of its eight layers):
{"source":"catalog","sourceQuote":"catalog furniture","vision":"A bright kitchen and a calm parlor in oak and linen.","axes":{"action":{"kind":"open","design":"furnish both rooms as a whole"},"size":{"kind":"open","design":"pieces sized to fit each room"},"pieces":{"kind":"open","design":"the pieces each room needs"},"openings":{"kind":"open","design":"keep the doors and windows clear"},"style":{"kind":"open","design":"one calm character throughout"},"materials":{"kind":"open","design":"finishes chosen surface by surface"},"dressing":{"kind":"open","design":"rooms dressed lived-in, stated in beyond"}},"beyond":{"textiles":["linen cushions"],"light":["a floor lamp"],"windows":["light curtains"],"walls":["framed art"],"floor":["a wool rug"],"plants":["a plant by the window"],"objects":["books"],"smallFurniture":{"none":"the rooms are small"}}}`

const NOT_CONFIGURED = {
  error: 'assistant_not_configured',
  message:
    'Set a model key (AI_GATEWAY_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY) in .env at the repository root and restart bun dev, or start Ollama.',
}

export function OPTIONS(request: Request) {
  return sceneApiPreflight(request)
}

/** The models the assistant can use here, for the panel's picker. */
export async function GET(request: Request) {
  const guard = guardSceneApiRequest(request)
  if (guard) return guard
  const models = await listAssistantModels()
  return sceneApiJson(request, { models, defaultModel: defaultAssistantModel(models) })
}

export async function POST(request: Request, { params }: RouteParams) {
  const guard = guardSceneApiRequest(request)
  if (guard) return guard

  const { messages, model: requestedModel } = (await request.json()) as {
    messages: UIMessage[]
    model?: string
  }
  const modelId = requestedModel || defaultAssistantModel(await listAssistantModels())
  if (!modelId) return sceneApiJson(request, NOT_CONFIGURED, { status: 503 })
  const model = resolveAssistantModel(modelId)
  if (!model) {
    return sceneApiJson(
      request,
      { error: 'model_unavailable', message: `The model ${modelId} is not set up on this server.` },
      { status: 400 },
    )
  }

  const { id } = await params
  const operations = await getSceneOperations()
  if (!(await operations.loadStoredScene(id))) {
    return sceneApiJson(request, { error: 'not_found' }, { status: 404 })
  }

  // The turn holds the lock and the MCP session until its stream ends, so the
  // release is tied to the response body rather than to this handler.
  let releaseTurn: () => void = () => {}
  const turnDone = new Promise<void>((resolve) => {
    releaseTurn = resolve
  })
  const session = await new Promise<Awaited<ReturnType<typeof openAssistantSession>>>(
    (resolve, reject) => {
      void runExclusive(async () => {
        try {
          resolve(await openAssistantSession(id))
        } catch (error) {
          reject(error)
          return
        }
        await turnDone
      })
    },
  ).catch((error: unknown) => {
    releaseTurn()
    throw error
  })

  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    void session.close().finally(releaseTurn)
  }
  request.signal.addEventListener('abort', finish, { once: true })

  try {
    const result = streamText({
      model,
      instructions: session.guide
        ? `${EDITOR_INSTRUCTIONS}\n\n# Pascal agent guide\n\n${session.guide}`
        : EDITOR_INSTRUCTIONS,
      messages: await convertToModelMessages(messages, {
        tools: session.tools,
        ignoreIncompleteToolCalls: true,
      }),
      tools: session.tools,
      stopWhen: isStepCount(MAX_STEPS),
      prepareStep: () => ({ activeTools: session.activeTools() }),
      onStepEnd: (step) => {
        const tools = step.toolCalls.map((call) => call.toolName).join(', ')
        console.info(
          `[assistant] step ${step.stepNumber} ${step.model.modelId} ${step.finishReason}${tools ? `: ${tools}` : ''}`,
        )
      },
      abortSignal: request.signal,
    })

    const stream = toUIMessageStream({
      stream: result.stream,
      tools: session.tools,
      onError: (error) => (error instanceof Error ? error.message : String(error)),
    }).pipeThrough(
      new TransformStream({
        flush: finish,
      }),
    )

    return withSceneApiHeaders(request, createUIMessageStreamResponse({ stream }))
  } catch (error) {
    finish()
    throw error
  }
}
