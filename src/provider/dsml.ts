/**
 * Recovery for one upstream defect: the model writes its tool call into the
 * assistant TEXT (`delta.content`) as DSML transcript markup instead of
 * returning a structured `delta.tool_calls`.
 *
 * The tag scanner, ignored-region handling, parameter parser and streaming
 * buffer are a TypeScript port of `src/codebuddy_proxy/dsml_parser.py` from
 * github.com/hawklithm/workbuddy2api (MIT), with the four-gate discipline of
 * dingminhua/dsh-connect-workbuddy's dsml-recovery (MIT):
 *
 *   1. CLOSE BEFORE COMMIT — a call is produced only once its closing tag has
 *      arrived. An unclosed block is handed back as text, never guessed at.
 *   2. NAME MUST BE DECLARED — the tool name must appear in THIS request's
 *      `tools`. A name that was not offered is not a call we may invent.
 *   3. NO TOOLS, NO RECOVERY — when the request declared no tools, the caller
 *      must not run this at all.
 *   4. ANY DOUBT ROLLS BACK — required parameters missing, a name that does
 *      not match a pinned `tool_choice`, anything unparsable: the block is
 *      returned as text, VERBATIM.
 */

import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Marker and tag vocabulary
// ---------------------------------------------------------------------------

/** U+FF5C FULLWIDTH VERTICAL LINE — the marker's reference bar. */
const FULLWIDTH_BAR = '｜'

/** The marker in any spelling (bar count is a spelling variable). */
const MARKUP_RE = new RegExp(`${FULLWIDTH_BAR}${FULLWIDTH_BAR}?DSML${FULLWIDTH_BAR}${FULLWIDTH_BAR}?`, 'g')

/** Spellings a tag may carry before its name, longest first. */
const MARKUP_PREFIXES: readonly string[] = [
  `${FULLWIDTH_BAR}${FULLWIDTH_BAR}DSML${FULLWIDTH_BAR}${FULLWIDTH_BAR}`,
  '||DSML||',
  '|DSML|',
]

/** The full-width marker as ASCII, for mixed-style blocks. */
const ASCII_PREFIXES: readonly string[] = ['||DSML||', '|DSML|']

/** Tag names that can OPEN a block worth recovering. Deliberately tiny. */
const BLOCK_TAGS: readonly string[] = ['tool_calls', 'invoke']

/** Tag names whose content belongs to the markup rather than the answer. */
const KEYWORD_TAGS: readonly string[] = ['tool_calls', 'tool-calls', 'toolcalls', 'invoke', 'parameter', 'calls', 'tool']

/** Tag names normalised to their canonical spelling. */
const CANONICAL_TAG_NAMES: ReadonlyMap<string, string> = new Map([
  ['tool_calls', 'tool_calls'],
  ['tool-calls', 'tool_calls'],
  ['toolcalls', 'tool_calls'],
  ['invoke', 'invoke'],
  ['parameter', 'parameter'],
])

/** Canonical names accepted ONLY in a marker form. */
const MARKER_ONLY_TAG_NAMES: ReadonlySet<string> = new Set(['tool-calls', 'toolcalls'])

const FENCE_MARKERS: readonly string[] = ['```', '~~~']

export interface RecoveredToolCall {
  id: string
  name: string
  /** JSON-encoded arguments object, ready to drop into `function.arguments`. */
  arguments: string
}

export interface RecoveryGate {
  /** Tool names this request offered. Empty means recovery is off (gate 3). */
  declaredNames: ReadonlySet<string>
  /** Required parameter names per tool (gate 4's second half). */
  requiredParameters?: ReadonlyMap<string, readonly string[]>
  /** Parameter names each declared tool accepts, for schema-gated inference. */
  acceptedParameters?: ReadonlyMap<string, ReadonlySet<string>>
  /** A `tool_choice` pinned to one function name. */
  pinnedToolName?: string
}

// ---------------------------------------------------------------------------
// Ignored regions (fences, code spans, CDATA, comments, PIs)
// ---------------------------------------------------------------------------

interface IgnoredSpan {
  start: number
  end: number
  /** True when the span never closed — it runs to end-of-text. */
  open: boolean
}

function ignoredSpans(text: string): IgnoredSpan[] {
  const spans: IgnoredSpan[] = []
  let i = 0
  let fence: string | undefined
  let fenceStart = 0

  while (i < text.length) {
    const atLineStart = i === 0 || text.charAt(i - 1) === '\n'

    if (fence !== undefined) {
      if (atLineStart && text.startsWith(fence, i)) {
        const lineEnd = text.indexOf('\n', i)
        const end = lineEnd === -1 ? text.length : lineEnd + 1
        spans.push({ start: fenceStart, end, open: false })
        fence = undefined
        i = end
        continue
      }
      i += 1
      continue
    }

    if (atLineStart) {
      const marker = FENCE_MARKERS.find(candidate => text.startsWith(candidate, i))
      if (marker !== undefined) {
        fence = marker
        fenceStart = i
        i += marker.length
        continue
      }
    }

    if (text.charAt(i) === '`') {
      const end = codeSpanEnd(text, i)
      if (end === -1) {
        spans.push({ start: i, end: text.length, open: true })
        break
      }
      spans.push({ start: i, end, open: false })
      i = end
      continue
    }

    const xml = xmlIgnoredEnd(text, i)
    if (xml !== undefined) {
      spans.push(xml)
      if (xml.end >= text.length && xml.open) break
      i = xml.end
      continue
    }

    i += 1
  }

  if (fence !== undefined) spans.push({ start: fenceStart, end: text.length, open: true })
  return spans
}

/** End of the inline code span starting at `start`, or -1 when there is none. */
function codeSpanEnd(text: string, start: number): number {
  let ticks = 0
  let i = start
  while (i < text.length && text.charAt(i) === '`') {
    ticks += 1
    i += 1
  }
  if (ticks === 0 || ticks >= 3) return -1

  let end = i
  while (end < text.length) {
    if (text.charAt(end) !== '`') {
      end += 1
      continue
    }
    let closingTicks = 0
    let j = end
    while (j < text.length && text.charAt(j) === '`') {
      closingTicks += 1
      j += 1
    }
    if (closingTicks === ticks) return j
    end = j
  }
  return -1
}

function xmlIgnoredEnd(text: string, index: number): IgnoredSpan | undefined {
  const forms: ReadonlyArray<readonly [string, string]> = [
    ['<![CDATA[', ']]>'],
    ['<!--', '-->'],
    ['<?', '?>'],
  ]
  for (const [open, close] of forms) {
    if (!text.startsWith(open, index)) continue
    const found = text.indexOf(close, index + open.length)
    if (found === -1) return { start: index, end: text.length, open: true }
    return { start: index, end: found + close.length, open: false }
  }
  return undefined
}

function skipIgnored(spans: readonly IgnoredSpan[], index: number, cursor: { at: number }): number {
  while (cursor.at < spans.length) {
    const span = spans[cursor.at]
    if (span === undefined || index < span.start) return index
    if (index < span.end) return span.end
    cursor.at += 1
  }
  return index
}

// ---------------------------------------------------------------------------
// Tag scanning
// ---------------------------------------------------------------------------

/** Full-width ASCII (U+FF01..U+FF5E) mapped to its ASCII counterpart. */
function normalizeFullwidth(text: string): string {
  let normalized = ''
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    normalized += code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : character
  }
  return normalized
}

/** Length of the marker prefix at `index`, or 0 when none is there. */
function prefixLengthAt(text: string, index: number): number {
  for (const prefix of MARKUP_PREFIXES) {
    if (text.startsWith(prefix, index)) return prefix.length
  }
  const normalized = normalizeFullwidth(text.slice(index, index + 8))
  for (const prefix of ASCII_PREFIXES) {
    if (normalized.startsWith(prefix)) return prefix.length
  }
  return 0
}

/** Is this the start of a marker whose remainder has not arrived yet? */
function isPartialMarker(body: string): boolean {
  const trimmed = body.trimStart()
  if (trimmed === '') return true
  const forms = [...MARKUP_PREFIXES, ...ASCII_PREFIXES]
  const candidates = [trimmed, normalizeFullwidth(trimmed.slice(0, 8))]
  return candidates.some(candidate => candidate !== ''
    && forms.some(form => form.startsWith(candidate) && candidate.length < form.length))
}

interface MarkupTag {
  start: number
  end: number
  name: string
  closing: boolean
  selfClosing: boolean
  /** True when a marker prefix preceded the name. */
  marked: boolean
  attributes: string
}

function readName(text: string, index: number): { name: string; end: number; marked: boolean } {
  const prefixLength = prefixLengthAt(text, index)
  const marked = prefixLength > 0
  let position = index + prefixLength
  // Whitespace is allowed between the marker and the name — the shape the
  // model actually emits needs it: `<｜DSML｜ invoke>`.
  while (position < text.length && /\s/.test(text.charAt(position))) position += 1
  const start = position
  while (position < text.length && /[\p{L}\p{N}_-]/u.test(text.charAt(position))) position += 1
  if (position === start) return { name: '', end: index, marked }
  return { name: text.slice(start, position).toLowerCase(), end: position, marked }
}

function scanTag(text: string, index: number): MarkupTag | undefined {
  if (text.charAt(index) !== '<') return undefined
  let position = index + 1

  let closing = false
  if (text.charAt(position) === '/') {
    closing = true
    position += 1
  }
  while (position < text.length && /\s/.test(text.charAt(position))) position += 1

  const read = readName(text, position)
  if (read.name === '') return undefined

  const canonical = CANONICAL_TAG_NAMES.get(read.name)
  const name = canonical !== undefined && !(MARKER_ONLY_TAG_NAMES.has(read.name) && !read.marked)
    ? canonical
    : read.name

  const attributesStart = read.end
  let selfClosing = false
  let cursor = read.end
  while (cursor < text.length) {
    const character = text.charAt(cursor)
    if (character === '>') {
      return { start: index, end: cursor, name, closing, selfClosing, marked: read.marked, attributes: text.slice(attributesStart, cursor).trim() }
    }
    if (character === '/' && text.charAt(cursor + 1) === '>') {
      selfClosing = true
      return { start: index, end: cursor + 1, name, closing, selfClosing, marked: read.marked, attributes: text.slice(attributesStart, cursor).trim() }
    }
    cursor += 1
  }
  return undefined
}

function findTag(text: string, spans: readonly IgnoredSpan[], from: number): MarkupTag | undefined {
  const cursor = { at: 0 }
  let index = Math.max(from, 0)
  while (index < text.length) {
    const skipped = skipIgnored(spans, index, cursor)
    if (skipped !== index) {
      index = skipped
      continue
    }
    if (text.charAt(index) === '<') {
      const tag = scanTag(text, index)
      if (tag !== undefined) return tag
    }
    index += 1
  }
  return undefined
}

/** The close tag matching `open`, with depth counting (gate 1's teeth). */
function findMatchingClose(text: string, spans: readonly IgnoredSpan[], open: MarkupTag): MarkupTag | undefined {
  let depth = 1
  let index = open.end + 1
  while (index < text.length) {
    const tag = findTag(text, spans, index)
    if (tag === undefined) return undefined
    if (tag.name === open.name) {
      if (tag.closing) {
        depth -= 1
        if (depth === 0) return tag
      } else if (!tag.selfClosing) {
        depth += 1
      }
    }
    index = tag.end + 1
  }
  return undefined
}

function findFirstOpener(text: string, spans: readonly IgnoredSpan[]): { open: MarkupTag; close?: MarkupTag } | undefined {
  let index = 0
  while (index < text.length) {
    const tag = findTag(text, spans, index)
    if (tag === undefined) return undefined
    if (!tag.closing && BLOCK_TAGS.includes(tag.name)) {
      const close = findMatchingClose(text, spans, tag)
      return close === undefined ? { open: tag } : { open: tag, close }
    }
    index = tag.end + 1
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Attributes and parameters
// ---------------------------------------------------------------------------

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  const named: ReadonlyMap<string, string> = new Map([
    ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
  ])
  return text.replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body.charAt(1).toLowerCase() === 'x'
      const digits = hex ? body.slice(2) : body.slice(1)
      const code = Number.parseInt(digits, hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      return String.fromCodePoint(code)
    }
    return named.get(body.toLowerCase()) ?? whole
  })
}

function parseAttributes(text: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /([a-z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
  let match = pattern.exec(text)
  while (match !== null) {
    const key = match[1]
    const value = match[2] ?? match[3]
    if (key !== undefined && value !== undefined) attributes[key] = decodeEntities(value)
    match = pattern.exec(text)
  }
  return attributes
}

type ParameterValue = string | Record<string, unknown>

function parseParameters(body: string): Record<string, ParameterValue> {
  const parameters: Record<string, ParameterValue> = {}
  const spans = ignoredSpans(body)
  let index = 0

  while (index < body.length) {
    const tag = findTag(body, spans, index)
    if (tag === undefined) break
    if (tag.closing || tag.selfClosing) {
      index = tag.end + 1
      continue
    }
    const close = findMatchingClose(body, spans, tag)
    if (close === undefined) {
      index = tag.end + 1
      continue
    }
    const value = body.slice(tag.end + 1, close.start).trim()
    const attributes = parseAttributes(tag.attributes)
    const explicitName = tag.name === 'parameter' ? attributes['name'] : undefined
    const name = explicitName ?? tag.name
    if (name !== undefined && name !== '' && (explicitName !== undefined || parameters[name] === undefined)) {
      parameters[name] = value.startsWith('<![CDATA[') && value.endsWith(']]>')
        ? value.slice(9, -3)
        : nestedOrText(value)
    }
    index = close.end + 1
  }

  return parameters
}

/** A value that itself contains a complete tag pair is a nested object. */
function nestedOrText(value: string): ParameterValue {
  if (!value.includes('<') || !value.includes('>')) return decodeEntities(value)
  const nested = parseParameters(value)
  return Object.keys(nested).length > 0 ? nested : decodeEntities(value)
}

// ---------------------------------------------------------------------------
// Gates and the public parse entry
// ---------------------------------------------------------------------------

function parseInvoke(open: MarkupTag, close: MarkupTag, block: string, gate: RecoveryGate): RecoveredToolCall | undefined {
  const attributes = parseAttributes(open.attributes)
  const declared = attributes['name']
  if (declared === undefined || declared === '') return undefined

  // Gate 2: a name the request never offered is not a call we may invent.
  if (!gate.declaredNames.has(declared)) return undefined

  // Gate 2, pinned form: the caller asked for one tool by name.
  const pinned = gate.pinnedToolName
  if (pinned !== undefined && pinned !== 'auto' && pinned !== 'required' && pinned !== 'none' && pinned !== declared) {
    return undefined
  }

  const parameters = parseParameters(block.slice(open.end + 1, close.start))

  // Gate 4: a declared tool missing a required parameter is a truncated call.
  const required = gate.requiredParameters?.get(declared)
  if (required !== undefined && required.some(parameter => parameters[parameter] === undefined)) return undefined

  return {
    id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    name: declared,
    arguments: JSON.stringify(parameters),
  }
}

/**
 * Every call declared by `text`, or an empty list when nothing passes the
 * gates. Stops at the first opener that never closes rather than stepping
 * over it (a broken block means the text after it cannot be trusted).
 */
export function parseToolCalls(text: string, gate: RecoveryGate): RecoveredToolCall[] {
  if (gate.declaredNames.size === 0) return []

  const calls: RecoveredToolCall[] = []
  let remaining = text

  while (remaining !== '') {
    const found = findFirstOpener(remaining, ignoredSpans(remaining))
    if (found === undefined || found.close === undefined) break
    const block = remaining.slice(found.open.start, found.close.end + 1)
    const spans = ignoredSpans(block)
    let index = 0
    while (index < block.length) {
      const tag = findTag(block, spans, index)
      if (tag === undefined) break
      if (!tag.closing && tag.name === 'invoke') {
        const close = findMatchingClose(block, spans, tag)
        if (close === undefined) break
        const call = parseInvoke(tag, close, block, gate)
        if (call !== undefined) calls.push(call)
        index = close.end + 1
        continue
      }
      index = tag.end + 1
    }
    remaining = remaining.slice(found.close.end + 1)
  }

  return calls
}

/** `text` with every marker-bearing tag removed (quoted spans kept). */
export function stripMarkup(text: string): string {
  const spans = ignoredSpans(text)
  const cursor = { at: 0 }
  let result = ''
  let index = 0

  while (index < text.length) {
    const skipped = skipIgnored(spans, index, cursor)
    if (skipped !== index) {
      result += text.slice(index, skipped)
      index = skipped
      continue
    }
    const tag = text.charAt(index) === '<' ? scanTag(text, index) : undefined
    if (tag === undefined || !tag.marked) {
      result += text.charAt(index)
      index += 1
      continue
    }
    const bracketed = !tag.closing && !tag.selfClosing && KEYWORD_TAGS.includes(tag.name)
    const close = bracketed ? findMatchingClose(text, spans, tag) : undefined
    index = close === undefined ? tag.end + 1 : close.end + 1
  }

  return result
}

/** Does `text` carry content outside markup blocks? */
export function hasProse(text: string): boolean {
  return stripMarkup(text).trim() !== ''
}

/** Could this fragment be the beginning of a block-opening tag? */
function looksLikeTagStart(tail: string): boolean {
  if (!tail.startsWith('<')) return false
  if (tail.includes('>')) return false
  let body = tail.slice(1)
  if (body.startsWith('/')) body = body.slice(1)
  if (body === '' || isPartialMarker(body)) return true
  const prefixLength = prefixLengthAt(body, 0)
  if (prefixLength > 0) return true
  body = body.slice(prefixLength).trim().toLowerCase()
  if (body === '' || isPartialMarker(body)) return true
  const openers = ['tool', 'invoke', 'tool_calls', 'tool-calls', 'toolcalls', 'tool_call', 'tool-call']
  return openers.some(opener => opener.startsWith(body) || body.startsWith(opener))
}

/** Which of `text`'s tail must wait for more bytes. */
function holdFrom(text: string, spans: readonly IgnoredSpan[]): number {
  let hold = text.length
  const lastLt = text.lastIndexOf('<')
  if (lastLt !== -1 && looksLikeTagStart(text.slice(lastLt))) hold = Math.min(hold, lastLt)
  for (const span of spans) {
    if (span.open) hold = Math.min(hold, span.start)
  }
  return hold
}

// ---------------------------------------------------------------------------
// Streaming buffer
// ---------------------------------------------------------------------------

export interface BufferOutcome {
  /** Text safe to forward. */
  text: string
  /** Calls committed by this chunk, if any. */
  calls?: RecoveredToolCall[]
  /** True when `text` carries ordinary content outside markup blocks. */
  prose: boolean
}

/**
 * Buffers `delta.content` and commits a call only when the block that declares
 * it is complete. A block with no close tag yet holds the ENTIRE block; only
 * the tail that could still become a tag is held back from finished text. A
 * block that fails the gates is emitted VERBATIM (gate 4), not dropped.
 */
export class DsmlStreamBuffer {
  private pending = ''
  private readonly gate: RecoveryGate

  constructor(gate: RecoveryGate) {
    this.gate = gate
  }

  /** Feed one `delta.content` chunk; returns text and any call it completed. */
  add(chunk: string): BufferOutcome {
    this.pending += chunk

    if (this.gate.declaredNames.size === 0) {
      const text = this.pending
      this.pending = ''
      return { text, prose: hasProse(text) }
    }

    const parts: string[] = []
    const calls: RecoveredToolCall[] = []

    for (;;) {
      const found = findFirstOpener(this.pending, ignoredSpans(this.pending))
      if (found === undefined) break

      if (found.open.start > 0) parts.push(this.pending.slice(0, found.open.start))

      // Gate 1: the close has not arrived, so nothing may be committed.
      if (found.close === undefined) {
        this.pending = this.pending.slice(found.open.start)
        return finish(parts, calls)
      }

      const block = this.pending.slice(found.open.start, found.close.end + 1)
      const blockCalls = parseToolCalls(block, this.gate)
      if (blockCalls.length > 0) calls.push(...blockCalls)
      // Gate 4: refused blocks are shown exactly as they arrived.
      else parts.push(block)

      this.pending = this.pending.slice(found.close.end + 1)
    }

    const hold = holdFrom(this.pending, ignoredSpans(this.pending))
    if (hold > 0) parts.push(this.pending.slice(0, hold))
    this.pending = this.pending.slice(hold)

    return finish(parts, calls)
  }

  /** End of stream: hand back everything still held. */
  flush(): BufferOutcome {
    const text = this.pending
    this.pending = ''
    return { text, prose: hasProse(text) }
  }
}

function finish(
  parts: readonly string[],
  calls: readonly RecoveredToolCall[],
): BufferOutcome {
  const text = parts.join('')
  const outcome: BufferOutcome = { text, prose: hasProse(text) }
  if (calls.length > 0) outcome.calls = [...calls]
  return outcome
}

export { MARKUP_RE }
