'use client'

import { Chat, useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type FileUIPart, type UIMessage } from 'ai'
import {
  ArrowUp,
  Check,
  CircleAlert,
  ImagePlus,
  LoaderCircle,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
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
// tabs (which unmounts the panel) keeps the thread; it is also kept in this
// browser, so a reload comes back to it.
const chats = new Map<string, Chat<UIMessage>>()

const HISTORY_LIMIT = 60
// A tool's result can be a large scene dump; the stored thread only needs enough to show it.
const STORED_OUTPUT_CHARS = 4000

const historyKey = (sceneId: string) => `pascal.assistant.chat:${sceneId}`

function storedHistory(sceneId: string): UIMessage[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(historyKey(sceneId)) ?? '[]')
    return Array.isArray(parsed) ? (parsed as UIMessage[]) : []
  } catch {
    return []
  }
}

function storeHistory(sceneId: string, messages: UIMessage[]) {
  const trimmed = messages.slice(-HISTORY_LIMIT).map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      // An attached image is a data URL of megabytes: the thread keeps a note of it, which the
      // model can also read when the conversation goes on.
      if (part.type === 'file')
        return { type: 'text' as const, text: `[Attached image ${part.filename ?? ''} — not kept]\n` }
      const output = (part as { output?: unknown }).output
      if (output === undefined) return part
      const text = typeof output === 'string' ? output : JSON.stringify(output)
      return text.length > STORED_OUTPUT_CHARS
        ? { ...part, output: `${text.slice(0, STORED_OUTPUT_CHARS)}…` }
        : part
    }),
  }))
  try {
    if (trimmed.length === 0) localStorage.removeItem(historyKey(sceneId))
    else localStorage.setItem(historyKey(sceneId), JSON.stringify(trimmed))
  } catch {
    // Full or blocked storage: the thread still lasts for this page.
  }
}

function chatFor(sceneId: string): Chat<UIMessage> {
  let chat = chats.get(sceneId)
  if (!chat) {
    chat = new Chat({
      id: `assistant-${sceneId}`,
      messages: storedHistory(sceneId),
      transport: new DefaultChatTransport({ api: `/api/scenes/${sceneId}/assistant` }),
    })
    chats.set(sceneId, chat)
  }
  return chat
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** The attached image as a chat file part (a data URL the model reads). */
async function imagePart(file: File): Promise<FileUIPart[]> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
  return [{ type: 'file', mediaType: file.type, filename: file.name, url }]
}

type SceneSnapshot = { version: number; graph: unknown }

// The project as it was before the last request, so its changes can be taken back.
const snapshots = new Map<string, SceneSnapshot>()

async function fetchScene(sceneId: string): Promise<SceneSnapshot | null> {
  const response = await fetch(`/api/scenes/${sceneId}`, { cache: 'no-store' })
  if (!response.ok) return null
  const { version, graph } = (await response.json()) as SceneSnapshot
  return { version, graph }
}

/**
 * Puts the snapshot back as a new version. The editor picks it up over its live connection, as
 * it does the assistant's own changes; edits made in the editor since the request go with it.
 */
async function restoreSnapshot(sceneId: string, snapshot: SceneSnapshot): Promise<string | null> {
  const current = await fetchScene(sceneId)
  if (!current) return 'The project could not be read.'
  const response = await fetch(`/api/scenes/${sceneId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-Match': String(current.version) },
    // Announced on the live feed, so the editor loads it as it does the assistant's changes.
    body: JSON.stringify({ graph: snapshot.graph, announce: true }),
  })
  return response.ok ? null : `Undo failed (${response.status}).`
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
    const images = message.parts.filter((part) => part.type === 'file')
    return (
      <div className="ml-6 flex flex-col gap-1.5 self-end rounded-xl bg-muted px-3 py-2 text-sm">
        {images.map((image, index) => (
          <img
            alt={image.filename ?? 'Attached image'}
            className="max-h-40 rounded-md object-contain"
            key={index}
            src={image.url}
          />
        ))}
        {text && <span className="whitespace-pre-wrap">{text}</span>}
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
  // A floor plan, sketch or room photo for the model to read and build from.
  const [image, setImage] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [undoable, setUndoable] = useState(false)
  const [undoNote, setUndoNote] = useState<string | null>(null)
  const startingRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const busy = status === 'submitted' || status === 'streaming'
  const notConfigured =
    models?.length === 0 || (error?.message.includes('assistant_not_configured') ?? false)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, status])

  useEffect(() => {
    if (status === 'ready' || status === 'error') storeHistory(sceneId, messages)
  }, [messages, status, sceneId])

  // Once a request is done, its changes can be undone if it made any.
  useEffect(() => {
    if (busy) return
    const snapshot = snapshots.get(sceneId)
    if (!snapshot) {
      setUndoable(false)
      return
    }
    let live = true
    void fetchScene(sceneId)
      .then((current) => {
        if (live)
          setUndoable(
            !!current && JSON.stringify(current.graph) !== JSON.stringify(snapshot.graph),
          )
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [busy, sceneId])

  const send = async (text: string) => {
    const attached = image
    const trimmed =
      text.trim() || (attached ? 'Build this floor plan in the project, room by room.' : '')
    if (!trimmed || busy || startingRef.current) return
    startingRef.current = true
    setInput('')
    setImage(null)
    setUndoNote(null)
    if (error) clearError()
    try {
      const snapshot = await fetchScene(sceneId).catch(() => null)
      if (snapshot) snapshots.set(sceneId, snapshot)
      else snapshots.delete(sceneId)
      const files = attached ? await imagePart(attached) : undefined
      void sendMessage(
        { text: trimmed, ...(files ? { files } : {}) },
        model ? { body: { model } } : undefined,
      )
    } finally {
      startingRef.current = false
    }
  }

  const undo = async () => {
    const snapshot = snapshots.get(sceneId)
    if (!snapshot) return
    setUndoable(false)
    const failure = await restoreSnapshot(sceneId, snapshot).catch(() => 'Undo failed.')
    if (failure) {
      setUndoable(true)
      setUndoNote(failure)
      return
    }
    snapshots.delete(sceneId)
    setUndoNote('The last request’s changes were undone.')
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void send(input)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Keep editor shortcuts (V, M, Delete…) from firing while typing.
    event.stopPropagation()
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send(input)
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
          {undoable && !busy && (
            <button
              aria-label="Undo the last request's changes"
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => void undo()}
              title="Undo the last request's changes"
              type="button"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </button>
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
                onClick={() => void send(suggestion)}
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
        {undoNote && <p className="text-muted-foreground text-xs">{undoNote}</p>}
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
        {image && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5 text-muted-foreground text-xs">
            <span className="truncate">{image.name}</span>
            <button
              aria-label="Remove image"
              className="rounded p-0.5 hover:bg-muted hover:text-foreground"
              onClick={() => setImage(null)}
              type="button"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        <div className="flex items-end gap-2 rounded-xl border border-border bg-background px-3 py-2 focus-within:ring-2 focus-within:ring-ring">
          <input
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              if (file.size > MAX_IMAGE_BYTES) {
                setUndoNote('That image is over 8 MB; attach a smaller one.')
                return
              }
              setImage(file)
            }}
            ref={fileRef}
            type="file"
          />
          <button
            aria-label="Attach a floor plan or photo"
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            title="Attach a floor plan or photo"
            type="button"
          >
            <ImagePlus className="h-3.5 w-3.5" />
          </button>
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
              disabled={!input.trim() && !image}
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
