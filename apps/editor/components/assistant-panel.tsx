'use client'

import { Chat, useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { ArrowUp, Check, CircleAlert, LoaderCircle, Sparkles, Square, Trash2 } from 'lucide-react'
import { useParams } from 'next/navigation'
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { AssistantModelOption } from '@/lib/assistant-models'
import { cn } from '@/lib/utils'

const SUGGESTIONS = [
  'Summarise what is on this floor',
  'Add a 4 × 3 m bedroom with a door and a window',
  'Furnish the kitchen with catalog furniture',
  'Paint the living room walls a warm white',
]

// One conversation per project for the life of the page, so switching sidebar
// tabs (which unmounts the panel) keeps the thread.
const chats = new Map<string, Chat<UIMessage>>()

function chatFor(sceneId: string): Chat<UIMessage> {
  let chat = chats.get(sceneId)
  if (!chat) {
    chat = new Chat({
      id: `assistant-${sceneId}`,
      transport: new DefaultChatTransport({ api: `/api/scenes/${sceneId}/assistant` }),
    })
    chats.set(sceneId, chat)
  }
  return chat
}

const MODEL_STORAGE_KEY = 'pascal.assistant.model'

function storedModel(): string | null {
  try {
    return localStorage.getItem(MODEL_STORAGE_KEY)
  } catch {
    return null
  }
}

function storeModel(id: string) {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, id)
  } catch {
    // Remembering the choice is a convenience only.
  }
}

type ModelList = { models: AssistantModelOption[]; defaultModel: string | null }

/** The models the server offers, and the one this viewer picked last. */
function useAssistantModels(sceneId: string) {
  const [list, setList] = useState<ModelList | null>(null)
  const [model, setModelState] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/scenes/${sceneId}/assistant`)
      .then((response) => (response.ok ? (response.json() as Promise<ModelList>) : null))
      .catch(() => null)
      .then((result) => {
        if (cancelled || !result) return
        setList(result)
        const remembered = storedModel()
        setModelState(
          result.models.some((option) => option.id === remembered)
            ? remembered
            : result.defaultModel,
        )
      })
    return () => {
      cancelled = true
    }
  }, [sceneId])

  const setModel = (id: string) => {
    setModelState(id)
    storeModel(id)
  }
  return { models: list?.models ?? null, model, setModel }
}

function toolLabel(name: string): string {
  const words = name.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

type ToolPart = Extract<UIMessage['parts'][number], { type: 'dynamic-tool' }>

/** Why a tool call failed: a thrown error, or the `{ error }` a refusal returns. */
function toolError(part: ToolPart): string | null {
  if (part.state === 'output-error') return part.errorText
  if (
    part.state === 'output-available' &&
    typeof part.output === 'object' &&
    part.output !== null &&
    'error' in part.output
  ) {
    return String((part.output as { error: unknown }).error)
  }
  return null
}

/** A refusal's message, without the JSON envelope the MCP tools wrap it in. */
function refusalMessage(error: string): string {
  try {
    const parsed = JSON.parse(error) as { message?: unknown; error?: unknown }
    if (typeof parsed.message === 'string') return parsed.message
    if (typeof parsed.error === 'string') return parsed.error
  } catch {
    // Plain text already.
  }
  return error
}

function ToolActivity({ part }: { part: ToolPart }) {
  const error = toolError(part)
  const running = part.state === 'input-streaming' || part.state === 'input-available'
  return (
    <div className="flex flex-col text-[11px] text-muted-foreground">
      <div className="flex items-center gap-1.5">
        {running ? (
          <LoaderCircle className="h-3 w-3 animate-spin" />
        ) : error !== null ? (
          <CircleAlert className="h-3 w-3 text-amber-500" />
        ) : (
          <Check className="h-3 w-3 text-emerald-500" />
        )}
        <span className={cn(error !== null && 'text-amber-500/90')}>
          {toolLabel(part.toolName)}
        </span>
      </div>
      {error !== null && (
        <p className="ml-[18px] line-clamp-2 text-muted-foreground/80" title={error}>
          {refusalMessage(error)}
        </p>
      )}
    </div>
  )
}

/** `**bold**` and `` `code` `` inside one line of a reply. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((piece, index) => {
    if (piece.startsWith('**') && piece.endsWith('**') && piece.length > 4)
      return <strong key={index}>{piece.slice(2, -2)}</strong>
    if (piece.startsWith('`') && piece.endsWith('`') && piece.length > 2)
      return (
        <code className="rounded bg-muted px-1 font-mono text-[12px]" key={index}>
          {piece.slice(1, -1)}
        </code>
      )
    return piece
  })
}

/** The little Markdown models reply with: paragraphs, bullet lists, bold and code. */
function ReplyText({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  let bullets: string[] = []
  const flush = () => {
    if (bullets.length === 0) return
    blocks.push(
      <ul className="list-disc space-y-0.5 pl-4" key={blocks.length}>
        {bullets.map((item, index) => (
          <li key={index}>{inline(item)}</li>
        ))}
      </ul>,
    )
    bullets = []
  }
  for (const line of text.split('\n')) {
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/)
    if (bullet) {
      bullets.push(bullet[1]!)
      continue
    }
    flush()
    if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line.replace(/^#+\s*/, ''))}</p>)
  }
  flush()
  return <div className="flex flex-col gap-1.5 text-sm leading-relaxed">{blocks}</div>
}

function MessageView({ message }: { message: UIMessage }) {
  if (message.role === 'user') {
    const text = message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
    return (
      <div className="ml-6 self-end whitespace-pre-wrap rounded-xl bg-muted px-3 py-2 text-sm">
        {text}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      {message.parts.map((part, index) => {
        if (part.type === 'text') {
          return part.text ? <ReplyText key={index} text={part.text} /> : null
        }
        if (part.type === 'dynamic-tool') return <ToolActivity key={index} part={part} />
        return null
      })}
    </div>
  )
}

function SetupNotice() {
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed">
      <p className="font-medium text-foreground">The assistant needs a model</p>
      <p className="mt-1 text-muted-foreground">
        Add a key for any one provider to <code className="font-mono">.env</code> at the repository
        root, then restart <code className="font-mono">bun dev</code>:
      </p>
      <pre className="mt-2 whitespace-pre-wrap rounded-md bg-background px-2 py-1.5 font-mono text-[11px]">
        {`GOOGLE_GENERATIVE_AI_API_KEY=…
ANTHROPIC_API_KEY=…
OPENAI_API_KEY=…
AI_GATEWAY_API_KEY=…`}
      </pre>
      <p className="mt-2 text-muted-foreground">
        Or run <span className="font-medium">Ollama</span> on this computer: its models appear here
        without a key.
      </p>
    </div>
  )
}

export function AssistantPanel() {
  const { id: sceneId } = useParams<{ id: string }>()
  const { messages, sendMessage, status, stop, error, clearError, setMessages } = useChat({
    chat: chatFor(sceneId),
  })
  const { models, model, setModel } = useAssistantModels(sceneId)
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const busy = status === 'submitted' || status === 'streaming'
  const notConfigured =
    models?.length === 0 || (error?.message.includes('assistant_not_configured') ?? false)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, status])

  const send = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    if (error) clearError()
    void sendMessage({ text: trimmed }, model ? { body: { model } } : undefined)
    setInput('')
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    send(input)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Keep editor shortcuts (V, M, Delete…) from firing while typing.
    event.stopPropagation()
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      send(input)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <div className="flex items-center gap-1.5 font-medium text-sm">
          <Sparkles className="h-4 w-4" />
          Assistant
        </div>
        <div className="flex min-w-0 items-center gap-1">
          {models && models.length > 0 && model && (
            <select
              aria-label="Model"
              className="min-w-0 max-w-44 truncate rounded-md border border-border bg-background px-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
              disabled={busy}
              onChange={(event) => setModel(event.target.value)}
              value={model}
            >
              {[...new Set(models.map((option) => option.provider))].map((provider) => (
                <optgroup key={provider} label={provider}>
                  {models
                    .filter((option) => option.provider === provider)
                    .map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          )}
          {messages.length > 0 && (
            <button
              aria-label="Clear conversation"
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              disabled={busy}
              onClick={() => setMessages([])}
              type="button"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-3 pb-3" ref={scrollRef}>
        {messages.length === 0 && !notConfigured && (
          <div className="flex flex-col gap-2 pt-2">
            <p className="text-muted-foreground text-xs leading-relaxed">
              Describe a change and the assistant builds it in this project. Changes save and show
              in the editor as it works.
            </p>
            {SUGGESTIONS.map((suggestion) => (
              <button
                className="rounded-lg bg-muted/40 px-2.5 py-2 text-left text-muted-foreground text-xs hover:bg-muted hover:text-foreground"
                key={suggestion}
                onClick={() => send(suggestion)}
                type="button"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
        {messages.map((message) => (
          <MessageView key={message.id} message={message} />
        ))}
        {status === 'submitted' && (
          <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <LoaderCircle className="h-3 w-3 animate-spin" />
            Thinking…
          </div>
        )}
        {notConfigured ? (
          <SetupNotice />
        ) : (
          error && (
            <div className="rounded-lg border border-destructive/50 px-3 py-2 text-destructive text-xs">
              {error.message || 'The assistant stopped with an error.'}
              {models && models.length > 1 && (
                <p className="mt-1 text-muted-foreground">
                  You can pick another model from the menu above and try again.
                </p>
              )}
            </div>
          )
        )}
      </div>

      <form className="border-border/50 border-t p-3" onSubmit={onSubmit}>
        <div className="flex items-end gap-2 rounded-xl border border-border bg-background px-3 py-2 focus-within:ring-2 focus-within:ring-ring">
          <textarea
            className="max-h-40 min-h-[2.5rem] flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask the assistant to build or change something…"
            rows={2}
            value={input}
          />
          {busy ? (
            <button
              aria-label="Stop"
              className="rounded-lg bg-muted p-1.5 text-foreground hover:bg-muted/80"
              onClick={() => stop()}
              type="button"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              aria-label="Send"
              className="rounded-lg bg-primary p-1.5 text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
              disabled={!input.trim()}
              type="submit"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
