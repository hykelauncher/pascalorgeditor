import { anthropic } from '@ai-sdk/anthropic'
import { google } from '@ai-sdk/google'
import { openai } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { gateway, type LanguageModel } from 'ai'
import { ModelPool } from './assistant-model-pool'

/**
 * Model providers the in-editor assistant can use. A provider is offered once
 * its key is set; model ids are `<provider>:<model>`, e.g.
 * `google:gemini-3.8-flash`. `PASCAL_ASSISTANT_MODEL` picks the default and
 * `PASCAL_ASSISTANT_MODELS` (comma separated) adds models to the picker.
 */

export type AssistantModelOption = {
  id: string
  label: string
  provider: string
}

type Provider = {
  label: string
  configured: () => boolean
  /** Models offered in the picker, as [model id, label]. */
  models: () => Promise<[string, string][]>
  create: (modelId: string) => LanguageModel
}

const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434'

function ollamaUrl(): string {
  return (process.env.OLLAMA_BASE_URL || OLLAMA_DEFAULT_URL).replace(/\/+$/, '')
}

/** Models pulled into the local Ollama, or none when it is not running. */
async function ollamaModels(): Promise<[string, string][]> {
  try {
    const response = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return []
    const { models } = (await response.json()) as { models?: { name: string }[] }
    return (models ?? []).map(({ name }) => [name, name])
  } catch {
    return []
  }
}

// Picker order. Without PASCAL_ASSISTANT_MODEL the first model offered is the
// default, so Google (which has a free tier) leads and the gateway, which
// needs a card on file before it serves requests, comes after the direct keys.
/**
 * Members of `google:auto`, best first. Each has its own free-tier limit of
 * 5 requests a minute, so the pool keeps a turn moving where one model stalls.
 * 3.8 and 3.7 Flash are left out: on the free tier they take 30–90 s a call.
 */
const GEMINI_POOL = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite-preview',
]

const PROVIDERS: Record<string, Provider> = {
  google: {
    label: 'Google',
    configured: () => Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY),
    models: async () => [
      ['auto', 'Gemini Auto (fastest on the free tier)'],
      ['gemini-3.6-flash', 'Gemini 3.6 Flash'],
      ['gemini-3.8-flash', 'Gemini 3.8 Flash'],
      ['gemini-4-argon', 'Gemini 4 Argon'],
    ],
    create: (modelId) =>
      modelId === 'auto'
        ? new ModelPool(
            'google:auto',
            GEMINI_POOL.map((id) => google(id)),
          )
        : google(modelId),
  },
  anthropic: {
    label: 'Anthropic',
    configured: () => Boolean(process.env.ANTHROPIC_API_KEY),
    models: async () => [
      ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
      ['claude-opus-5-5', 'Claude Opus 5.5'],
      ['claude-haiku-5-5', 'Claude Haiku 5.5'],
    ],
    create: (modelId) => anthropic(modelId),
  },
  openai: {
    label: 'OpenAI',
    configured: () => Boolean(process.env.OPENAI_API_KEY),
    models: async () => [
      ['gpt-6.1-sol', 'GPT-6.1 Sol'],
      ['gpt-5.5', 'GPT-5.5'],
    ],
    create: (modelId) => openai(modelId),
  },
  gateway: {
    label: 'Vercel AI Gateway',
    configured: () => Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN),
    models: async () => [
      ['anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5'],
      ['anthropic/claude-opus-5.5', 'Claude Opus 5.5'],
      ['openai/gpt-6.1-sol', 'GPT-6.1 Sol'],
      ['google/gemini-4-argon', 'Gemini 4 Argon'],
    ],
    create: (modelId) => gateway(modelId),
  },
  ollama: {
    label: 'Ollama (local)',
    // Offered whenever the local server answers; see ollamaModels.
    configured: () => true,
    models: ollamaModels,
    create: (modelId) =>
      createOpenAICompatible({ name: 'ollama', baseURL: `${ollamaUrl()}/v1` }).chatModel(modelId),
  },
}

/** Splits `provider:model`; a bare `vendor/model` is a gateway id, as before. */
function parseModelId(id: string): { provider: string; model: string } | null {
  const colon = id.indexOf(':')
  if (colon > 0) return { provider: id.slice(0, colon), model: id.slice(colon + 1) }
  if (id.includes('/')) return { provider: 'gateway', model: id }
  return null
}

function extraModels(): string[] {
  return (process.env.PASCAL_ASSISTANT_MODELS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
}

/** Every model whose provider is set up, in picker order. */
export async function listAssistantModels(): Promise<AssistantModelOption[]> {
  const options: AssistantModelOption[] = []
  const seen = new Set<string>()
  const add = (provider: string, model: string, label: string) => {
    const id = `${provider}:${model}`
    if (seen.has(id)) return
    seen.add(id)
    options.push({ id, label, provider: PROVIDERS[provider]!.label })
  }

  const lists = await Promise.all(
    Object.entries(PROVIDERS).map(async ([name, provider]) =>
      provider.configured() ? ([name, await provider.models()] as const) : ([name, []] as const),
    ),
  )
  const available = new Set<string>()
  for (const [name, models] of lists) {
    if (name === 'ollama' ? models.length > 0 : PROVIDERS[name]!.configured()) available.add(name)
    for (const [model, label] of models) add(name, model, label)
  }
  for (const id of [process.env.PASCAL_ASSISTANT_MODEL ?? '', ...extraModels()]) {
    const parsed = parseModelId(id)
    if (parsed && available.has(parsed.provider)) add(parsed.provider, parsed.model, parsed.model)
  }
  return options
}

/** `PASCAL_ASSISTANT_MODEL` when its provider is set up, else the first model offered. */
export function defaultAssistantModel(options: AssistantModelOption[]): string | null {
  const preferred = parseModelId(process.env.PASCAL_ASSISTANT_MODEL ?? '')
  if (preferred) {
    const id = `${preferred.provider}:${preferred.model}`
    if (options.some((option) => option.id === id)) return id
  }
  return options[0]?.id ?? null
}

/** The model for a `provider:model` id, or null when that provider is not set up. */
export function resolveAssistantModel(id: string): LanguageModel | null {
  const parsed = parseModelId(id)
  const provider = parsed ? PROVIDERS[parsed.provider] : undefined
  if (!parsed || !provider?.configured() || !parsed.model) return null
  return provider.create(parsed.model)
}
