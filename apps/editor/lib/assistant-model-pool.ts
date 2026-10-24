import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from '@ai-sdk/provider'
import { APICallError } from 'ai'

/**
 * One model id over several interchangeable models with separate rate limits.
 *
 * Free API tiers limit requests per minute per model (Gemini's free tier
 * allows 5), and an assistant turn makes one request per step, so a single
 * model stalls for a minute every few steps. The pool sends each call to the
 * first member that is not cooling down, and when a member answers 429 it is
 * benched for the delay the provider asks for and the call moves on to the
 * next member at once. Only when every member is benched does a call wait.
 */

/** Longest a call waits for a benched member before giving up. */
const MAX_WAIT_MS = 65_000
/** Bench time when a 429 does not say how long to wait. */
const DEFAULT_COOLDOWN_MS = 60_000
/** Daily quotas reset at midnight Pacific; an hour keeps a spent member out of the way. */
const DAILY_COOLDOWN_MS = 60 * 60_000

// Rate limits belong to the API key, not to a request, so the bench is shared
// by every turn in this process.
const benches = new Map<string, number>()

function isRateLimit(error: unknown): error is APICallError {
  return APICallError.isInstance(error) && error.statusCode === 429
}

function cooldownFor(error: APICallError): number {
  const body = error.responseBody ?? ''
  if (/PerDay/i.test(body)) return DAILY_COOLDOWN_MS
  const delay = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/)
  if (delay) return Math.ceil(Number(delay[1]) * 1000) + 500
  const header = Number(error.responseHeaders?.['retry-after'])
  return Number.isFinite(header) && header > 0 ? header * 1000 : DEFAULT_COOLDOWN_MS
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

export class ModelPool implements LanguageModelV4 {
  readonly specificationVersion = 'v4' as const
  readonly provider: string
  readonly modelId: string
  private readonly members: LanguageModelV4[]

  /** `models` in order of preference: the first available one takes each call. */
  constructor(modelId: string, models: LanguageModelV4[]) {
    if (models.length === 0) throw new Error('A model pool needs at least one model')
    this.modelId = modelId
    this.provider = models[0]!.provider
    this.members = models
  }

  get supportedUrls() {
    return this.members[0]!.supportedUrls
  }

  private key(model: LanguageModelV4): string {
    return `${model.provider}:${model.modelId}`
  }

  private async run<T>(
    options: LanguageModelV4CallOptions,
    call: (model: LanguageModelV4) => PromiseLike<T>,
  ): Promise<T> {
    const deadline = Date.now() + MAX_WAIT_MS
    let lastError: unknown
    for (;;) {
      const now = Date.now()
      const ready = this.members.find((model) => (benches.get(this.key(model)) ?? 0) <= now)
      if (ready) {
        try {
          return await call(ready)
        } catch (error) {
          if (!isRateLimit(error)) throw error
          lastError = error
          const cooldown = cooldownFor(error)
          benches.set(this.key(ready), Date.now() + cooldown)
          console.info(
            `[assistant] ${this.key(ready)} is rate limited; resting it ${Math.round(cooldown / 1000)} s`,
          )
          continue
        }
      }
      const nextFree = Math.min(...this.members.map((model) => benches.get(this.key(model)) ?? 0))
      if (nextFree > deadline) {
        throw lastError ?? new Error(`Every model in ${this.modelId} is over its rate limit`)
      }
      await sleep(Math.max(nextFree - Date.now(), 50), options.abortSignal)
    }
  }

  doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    return this.run(options, (model) => model.doGenerate(options))
  }

  doStream(options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> {
    return this.run(options, (model) => model.doStream(options))
  }
}
