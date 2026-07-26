import type { EngineOptions, HandlerContext, TagHandler, TagOverride } from './types'
import {
  BLOCKQUOTE_SPACING,
  isInsideRawHtmlBlock,
  LIST_ITEM_SPACING,
  MARKDOWN_CODE_BLOCK,
  MARKDOWN_EMPHASIS,
  MARKDOWN_HORIZONTAL_RULE,
  MARKDOWN_INLINE_CODE,
  MARKDOWN_STRIKETHROUGH,
  MARKDOWN_STRONG,
  NO_SPACING,
  TABLE_ROW_SPACING,
  TAG_A,
  TAG_ABBR,
  TAG_ADDRESS,
  TAG_AREA,
  TAG_ARTICLE,
  TAG_ASIDE,
  TAG_AUDIO,
  TAG_B,
  TAG_BASE,
  TAG_BDO,
  TAG_BLOCKQUOTE,
  TAG_BODY,
  TAG_BR,
  TAG_BUTTON,
  TAG_CANVAS,
  TAG_CENTER,
  TAG_CITE,
  TAG_CODE,
  TAG_COL,
  TAG_DATALIST,
  TAG_DD,
  TAG_DEL,
  TAG_DETAILS,
  TAG_DFN,
  TAG_DIALOG,
  TAG_DIV,
  TAG_DL,
  TAG_DT,
  TAG_EM,
  TAG_EMBED,
  TAG_FIELDSET,
  TAG_FIGCAPTION,
  TAG_FIGURE,
  TAG_FOOTER,
  TAG_FORM,
  TAG_H1,
  TAG_H2,
  TAG_H3,
  TAG_H4,
  TAG_H5,
  TAG_H6,
  TAG_HEAD,
  TAG_HEADER,
  TAG_HR,
  TAG_I,
  TAG_IFRAME,
  TAG_IMG,
  TAG_INPUT,
  TAG_INS,
  TAG_KBD,
  TAG_KEYGEN,
  TAG_LABEL,
  TAG_LEGEND,
  TAG_LI,
  TAG_LINK,
  TAG_MAIN,
  TAG_MAP,
  TAG_MARK,
  TAG_META,
  TAG_METER,
  TAG_NAV,
  TAG_NOFRAMES,
  TAG_NOSCRIPT,
  TAG_OL,
  TAG_OPTGROUP,
  TAG_OPTION,
  TAG_P,
  TAG_PARAM,
  TAG_PLAINTEXT,
  TAG_PRE,
  TAG_PROGRESS,
  TAG_Q,
  TAG_RP,
  TAG_RT,
  TAG_RUBY,
  TAG_S,
  TAG_SAMP,
  TAG_SCRIPT,
  TAG_SECTION,
  TAG_SELECT,
  TAG_SMALL,
  TAG_SOURCE,
  TAG_SPAN,
  TAG_STRIKE,
  TAG_STRONG,
  TAG_STYLE,
  TAG_SUB,
  TAG_SUMMARY,
  TAG_SUP,
  TAG_SVG,
  TAG_TABLE,
  TAG_TBODY,
  TAG_TD,
  TAG_TEMPLATE,
  TAG_TEXTAREA,
  TAG_TFOOT,
  TAG_TH,
  TAG_THEAD,
  TAG_TIME,
  TAG_TITLE,
  TAG_TR,
  TAG_TRACK,
  TAG_U,
  TAG_UL,
  TAG_VAR,
  TAG_VIDEO,
  TAG_WBR,
  TAG_XMP,
  TagIdMap,
} from './const'
import { continuationPrefix, isEmptyLinkHref, orderedItemNumber } from './utils'

const TRACKING_PARAM_RE = /^(?:utm_|fbclid|gclid|mc_eid|msclkid|oly_)/
const URL_SCHEME_RE = /^[\dA-Z+.-]+:/i

function stripTrackingParams(url: string): string {
  const queryStart = url.indexOf('?')
  const fragmentStart = url.indexOf('#')
  if (queryStart === -1 || (fragmentStart !== -1 && fragmentStart < queryStart))
    return url

  const queryEnd = fragmentStart === -1 ? url.length : fragmentStart
  const query = url.slice(queryStart + 1, queryEnd)
    .split('&')
    .filter(parameter => !TRACKING_PARAM_RE.test(parameter))
    .join('&')
  return `${url.slice(0, queryStart)}${query ? `?${query}` : ''}${url.slice(queryEnd)}`
}

export function resolveUrl(url: string, origin?: string, clean?: EngineOptions['clean']): string {
  if (!url || url[0] === '#')
    return url

  let resolved = url
  if (url.startsWith('//')) {
    resolved = `https:${url}`
  }
  else if (origin && !URL_SCHEME_RE.test(url)) {
    const path = url.startsWith('./') ? url.slice(2) : url
    while (origin.endsWith('/'))
      origin = origin.slice(0, -1)
    resolved = `${origin}${path[0] === '/' ? '' : '/'}${path}`
  }

  const cleansUrls = clean === true || (!!clean && clean.urls === true)
  return cleansUrls && resolved.includes('?') ? stripTrackingParams(resolved) : resolved
}

function serializeMarkdownDestination(destination: string): string {
  if (!/[\t\n\f\r ()\\<>]/.test(destination))
    return destination

  const escaped = /[\\<>]/.test(destination)
    ? destination.replace(/[\\<>]/g, '\\$&')
    : destination
  return `<${escaped}>`
}

function stripsEmptyLink(state: HandlerContext['state'], href: string): boolean {
  const clean = state.options?.clean
  if (!(clean === true || (typeof clean === 'object' && clean.emptyLinks)))
    return false
  return isEmptyLinkHref(href)
}

function serializeMarkdownTitle(title: string): string {
  return /[\\"]/.test(title)
    ? title.replace(/[\\"]/g, '\\$&')
    : title
}

function serializeMarkdownResource(destination: string, title?: string): string {
  const serializedTitle = title ? ` "${serializeMarkdownTitle(title)}"` : ''
  return `(${serializeMarkdownDestination(destination)}${serializedTitle})`
}

function serializeImageDescription(alt: string): string {
  return /[\\[\]*_`~<&]/.test(alt)
    ? alt.replace(/[\\[\]*_`~<&]/g, '\\$&')
    : alt
}

// GFM autolink shorthand: only inline-syntax-safe absolute URIs are eligible
// for `<url>` rendering. Conservative scheme list matches the Rust core.
function isAutolinkUri(s: string): boolean {
  if (!(s.startsWith('http://') || s.startsWith('https://')
    || s.startsWith('ftp://') || s.startsWith('mailto:'))) {
    return false
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 32 || c === 60 || c === 62 || c === 10 || c === 13 || c === 9)
      return false
  }
  return true
}

// Helper function to check if we're inside a table cell
/** Whether the buffer is at the start of a line, i.e. a row needs its indent. */
function bufferEndsWithNewlineForRow(state: HandlerContext['state']): boolean {
  for (let index = state.buffer.length - 1; index >= 0; index--) {
    const fragment = state.buffer[index]!
    if (fragment.length === 0)
      continue
    return fragment.charCodeAt(fragment.length - 1) === 10
  }
  return false
}

/**
 * How many table columns a cell occupies. GFM has no `colspan`, so a spanned
 * cell is written as its content followed by empty cells: without them the
 * delimiter row is too narrow and GFM drops every cell past it.
 */
function cellSpan(node: { attributes?: Record<string, string> }): number {
  const raw = node.attributes?.colspan
  if (raw === undefined)
    return 1
  const span = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(span) || span < 1)
    return 1
  return span > 64 ? 64 : span
}

/** Empty cells standing in for the columns a `colspan` swallowed. */
function spanFiller(node: { attributes?: Record<string, string> }): string | undefined {
  const span = cellSpan(node)
  return span > 1 ? ' |'.repeat(span - 1) : undefined
}

/** Whether the cell about to open sits past the promised column count. */
function cellOverflowsHeader(state: HandlerContext['state']): boolean {
  const header = state.tableHeaderCells ?? 0
  return header > 0 && (state.tableCurrentRowCells ?? 0) >= header
}

function isInsideTableCell(state: HandlerContext['state']): boolean {
  const depthMap = state.depthMap!
  return depthMap[TAG_TD]! > 0 || depthMap[TAG_TH]! > 0
}

export function renderBreak(node: HandlerContext['node'], state: HandlerContext['state']): string {
  // A literal newline would terminate a table row/ATX heading or collapse
  // inside a raw HTML block, so preserve the inline HTML there.
  const depthMap = state.depthMap!
  if (isInsideTableCell(state) || isInsideRawHtmlBlock(depthMap)
    || depthMap[TAG_H1]
    || depthMap[TAG_H2]
    || depthMap[TAG_H3]
    || depthMap[TAG_H4]
    || depthMap[TAG_H5]
    || depthMap[TAG_H6]) {
    return '<br>'
  }
  // Hard-break markers are literal content inside code.
  if (depthMap[TAG_PRE] || depthMap[TAG_CODE])
    return '\n'

  const prefix = continuationPrefix(
    node,
    state.listIndentWidths || [],
    !state.bufferedBlockquoteDepth,
  )
  return `\\\n${prefix}`
}

export const breakHandler: TagHandler = {
  enter: ({ node, state }) => renderBreak(node, state),
  isSelfClosing: true,
  spacing: NO_SPACING,
  collapsesInnerWhiteSpace: true,
  isInline: true,
}

// Helper function to get language from code class attribute
function getLanguageFromClass(className: string | undefined): string {
  if (!className)
    return ''

  const langParts = className
    .split(' ')
    .map(c => c.split('language-')[1])
    .filter(Boolean)

  return (langParts && langParts.length > 0) ? langParts[0]!.trim() : ''
}

/**
 * Fence language for a `<pre>`/`<code>`: `class="language-x"` first, then
 * `lang="x"`, the form cmark-gfm itself emits. A `lang` carrying a subtag
 * (`en-US`, `zh-Hans`) is a human language, never an info string.
 */
function fenceLanguage(attributes: Record<string, string> | undefined): string {
  const fromClass = getLanguageFromClass(attributes?.class)
  if (fromClass)
    return fromClass
  const lang = attributes?.lang?.trim()
  if (!lang || lang.includes('-') || /\s/.test(lang))
    return ''
  return lang
}

function handleHeading(depth: number): TagHandler {
  return {
    enter: ({ state }) => {
      // A `#` prefix needs its own line, which a GFM row cannot give it.
      if ((state.depthMap?.[TAG_A] || 0) > 0 || isInsideTableCell(state)) {
        return `<h${depth}>`
      }
      return `${'#'.repeat(depth)} `
    },
    exit: ({ state }) => {
      if ((state.depthMap?.[TAG_A] || 0) > 0 || isInsideTableCell(state)) {
        return `</h${depth}>`
      }
    },
    collapsesInnerWhiteSpace: true,
  }
}

const Strong: TagHandler = {
  enter: ({ state }) => {
    // we are already bold
    if ((state.depthMap?.[TAG_B] || 0) > 1) {
      return ''
    }
    return MARKDOWN_STRONG
  },
  exit: ({ node, state }) => {
    // we are already bold
    if ((state.depthMap?.[TAG_B] || 0) + (node.tagId === TAG_B ? 1 : 0) > 1) {
      return ''
    }
    return MARKDOWN_STRONG
  },
  collapsesInnerWhiteSpace: true,
  spacing: NO_SPACING,
  isInline: true,
}

const Emphasis: TagHandler = {
  enter: ({ state }) => {
    // we are already italic
    if ((state.depthMap?.[TAG_I] || 0) > 1) {
      return ''
    }
    return MARKDOWN_EMPHASIS
  },
  exit: ({ node, state }) => {
    // we are already italic
    if ((state.depthMap?.[TAG_I] || 0) + (node.tagId === TAG_I ? 1 : 0) > 1) {
      return ''
    }
    return MARKDOWN_EMPHASIS
  },
  collapsesInnerWhiteSpace: true,
  spacing: NO_SPACING,
  isInline: true,
}

const Strikethrough: TagHandler = {
  enter: () => MARKDOWN_STRIKETHROUGH,
  exit: () => MARKDOWN_STRIKETHROUGH,
  collapsesInnerWhiteSpace: true,
  spacing: NO_SPACING,
  isInline: true,
}

// Tag handlers with metadata
export const tagHandlers: Record<number, TagHandler> = {
  // Numeric tag constants
  [TAG_HEAD]: {
    // No special handling for head - plugins will handle frontmatter
    spacing: NO_SPACING,
    collapsesInnerWhiteSpace: true,
  },
  [TAG_DETAILS]: {
    // Inside a table cell the trailing block break would split the GFM row, so
    // emit the raw tags with no newlines (issue #147).
    enter: () => '<details>',
    exit: ({ state }) => isInsideTableCell(state) ? '</details>' : '</details>\n\n',
  },
  [TAG_SUMMARY]: {
    enter: () => '<summary>',
    exit: ({ state }) => isInsideTableCell(state) ? '</summary>' : '</summary>\n\n',
  },
  [TAG_TITLE]: {
    // No special handling for title - plugins will handle frontmatter
    collapsesInnerWhiteSpace: true,
    isNonNesting: true,
    spacing: NO_SPACING,
  },
  [TAG_SCRIPT]: {
    excludesTextNodes: true,
    isNonNesting: true,
  },
  [TAG_STYLE]: {
    isNonNesting: true,
    excludesTextNodes: true,
  },
  [TAG_META]: {
    // No special handling for meta - plugins will handle frontmatter
    collapsesInnerWhiteSpace: true,
    isSelfClosing: true,
    spacing: NO_SPACING,
  },
  [TAG_BR]: breakHandler,
  [TAG_H1]: handleHeading(1),
  [TAG_H2]: handleHeading(2),
  [TAG_H3]: handleHeading(3),
  [TAG_H4]: handleHeading(4),
  [TAG_H5]: handleHeading(5),
  [TAG_H6]: handleHeading(6),
  [TAG_HR]: {
    enter: () => MARKDOWN_HORIZONTAL_RULE,
    isSelfClosing: true,
  },
  [TAG_STRONG]: Strong,
  [TAG_B]: Strong,
  [TAG_EM]: Emphasis,
  [TAG_I]: Emphasis,
  [TAG_DEL]: Strikethrough,
  [TAG_S]: Strikethrough,
  [TAG_STRIKE]: Strikethrough,
  [TAG_SUB]: {
    enter: () => '<sub>',
    exit: () => '</sub>',
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_SUP]: {
    enter: () => '<sup>',
    exit: () => '</sup>',
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_INS]: {
    enter: () => '<ins>',
    exit: () => '</ins>',
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_BLOCKQUOTE]: {
    enter: ({ state }) => {
      // The processor prefixes the completed subtree once every structural
      // newline is known. Preserve the list marker's trailing space here.
      const output = (state.depthMap?.[TAG_LI] || 0) > 0 ? '\n' : undefined
      return { _tag: 'BlockquoteEnter', output }
    },
    exit: () => ({ _tag: 'BlockquoteExit' }),
    spacing: BLOCKQUOTE_SPACING,
  },
  // A bare <pre> (no <code> child) becomes a fenced code block (issue #97).
  // The opening fence is deferred to the first non-whitespace child by the
  // processor (flushPreFence) so empty/whitespace-only blocks emit nothing and a
  // <pre><code> keeps its existing fence. Only the closing fence lives here.
  [TAG_PRE]: {
    enter: ({ node, state }) => {
      // Inside a table cell a fenced code block would split the GFM row; emit
      // raw <pre> and let the content newlines become <br> (issue #147).
      if (isInsideTableCell(state)) {
        return '<pre>'
      }
      return {
        _tag: 'PreEnter',
        language: fenceLanguage(node.attributes),
      }
    },
    exit: ({ state }) => {
      if (isInsideTableCell(state)) {
        return '</pre>'
      }
      return { _tag: 'PreExit' }
    },
  },
  [TAG_CODE]: {
    enter: ({ node, state }) => {
      if ((state.depthMap?.[TAG_PRE] || 0) > 0) {
        // Inside a table cell emit raw <code> so no fence newline splits the
        // GFM row (issue #147). The enclosing <pre> emitted raw <pre>.
        if (isInsideTableCell(state)) {
          return '<code>'
        }
        // The enclosing <pre> already opened its own fence (e.g. <pre> with
        // mixed text and <code> children); don't emit a nested fence.
        if (state.preOwnFence) {
          return undefined
        }
        // A `<code>` with no language of its own inherits the `<pre>`'s.
        const language = fenceLanguage(node.attributes) || state.preFenceLang || ''
        const liDepth = state.depthMap?.[TAG_LI] || 0
        if (liDepth > 0) {
          const indent = state.listIndent
          return {
            _tag: 'CodeFenceEnter',
            language,
            output: `\n\n${indent}${MARKDOWN_CODE_BLOCK}${language}\n`,
          }
        }
        return {
          _tag: 'CodeFenceEnter',
          language,
          output: `${MARKDOWN_CODE_BLOCK}${language}\n`,
        }
      }
      if (isInsideRawHtmlBlock(state.depthMap!)) {
        return '<code>'
      }
      // Inline code inside a list item: collapse the paragraph boundary with a
      // separator space when following text, but not when the buffer just
      // emitted a wrapper opener where a leading space would break the
      // pairing or leak into the wrapper content. Covers emphasis (`*`, `_`),
      // strikethrough (`~`), link text (`[`), HTML passthrough (`>`), and
      // whitespace. A trailing backtick does NOT suppress: two adjacent
      // `<code>` elements must be separated with a space so CommonMark parses
      // them as two code spans rather than merging into one.
      if ((state.depthMap?.[TAG_LI] || 0) > 0) {
        const lastEntry = state.buffer.at(-1)
        const lastChar = lastEntry?.charAt(lastEntry.length - 1) || ''
        if (lastChar && lastChar !== ' ' && lastChar !== '\n' && lastChar !== '\t'
          && lastChar !== '*' && lastChar !== '_' && lastChar !== '~'
          && lastChar !== '[' && lastChar !== '>') {
          return { _tag: 'CodeSpanEnter', output: ` ${MARKDOWN_INLINE_CODE}` }
        }
      }
      return { _tag: 'CodeSpanEnter', output: MARKDOWN_INLINE_CODE }
    },
    exit: ({ state }) => {
      if ((state.depthMap?.[TAG_PRE] || 0) > 0) {
        // Raw <code> close inside a table cell (issue #147).
        if (isInsideTableCell(state)) {
          return '</code>'
        }
        // The enclosing <pre> owns the fence; this <code> emitted no opener.
        if (state.preOwnFence) {
          return undefined
        }
        const liDepth = state.depthMap?.[TAG_LI] || 0
        // Content that already ends in a newline would otherwise gain a blank
        // line before the closing fence.
        if (liDepth > 0) {
          const indent = state.listIndent
          return {
            _tag: 'CodeFenceExit',
            output: `\n${indent}${MARKDOWN_CODE_BLOCK}\n\n${indent}`,
          }
        }
        return { _tag: 'CodeFenceExit', output: `\n${MARKDOWN_CODE_BLOCK}` }
      }
      if (isInsideRawHtmlBlock(state.depthMap!)) {
        return '</code>'
      }
      return { _tag: 'CodeSpanExit' }
    },
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_UL]: {
    enter: ({ state }) => isInsideTableCell(state) ? '<ul>' : undefined,
    exit: ({ state }) => isInsideTableCell(state) ? '</ul>' : undefined,
  },
  [TAG_OL]: {
    enter: ({ state }) => isInsideTableCell(state) ? '<ol>' : undefined,
    exit: ({ state }) => isInsideTableCell(state) ? '</ol>' : undefined,
  },
  [TAG_LI]: {
    enter: ({ node, state }) => {
      if (isInsideTableCell(state)) {
        return '<li>'
      }

      // Parent determines marker: "N. " if <ol>, else "- ". The emitted indent
      // is the parent's accumulated listIndent — this <li>'s own marker width
      // is pushed onto state.listIndent after the enter output is written
      // (see markdown-processor.ts).
      const isOrdered = node.parent?.tagId === TAG_OL
      // `<ol start>` carries over to Markdown: GFM numbers from the first
      // item's marker, so only that one has to be right.
      const marker = isOrdered ? `${orderedItemNumber(node)}. ` : '- '
      return `${state.listIndent}${marker}`
    },
    exit: ({ state }) => isInsideTableCell(state) ? '</li>' : undefined,
    spacing: LIST_ITEM_SPACING,
  },
  [TAG_A]: {
    enter: ({ node, state }) => {
      if (node.attributes?.href !== undefined) {
        if (stripsEmptyLink(state, node.attributes.href))
          return
        return '['
      }
    },
    exit: ({ node, state }) => {
      if (node.attributes?.href === undefined) {
        return ''
      }
      if (stripsEmptyLink(state, node.attributes.href))
        return ''
      const href = resolveUrl(node.attributes.href, state.options?.origin, state.options?.clean)
      let title = node.attributes?.title
      // Check if title matches the last content to avoid duplication
      const lastContent = state.lastContentCache
      if (lastContent === title) {
        title = ''
      }
      // GFM autolink shorthand: when the link text equals href and href is a
      // bare absolute URI, emit `<href>` instead of `[href](href)`. Mirrors
      // the Rust core (crates/core/src/convert.rs).
      if (!title && isAutolinkUri(href)) {
        const buf = state.buffer
        let i = buf.length - 1
        // Sum the link-text length while scanning back for `[`, so the
        // slice/join allocation only happens when the text could equal href.
        let textLen = 0
        while (i >= 0) {
          const entry = buf[i]!
          if (entry === '[')
            break
          textLen += entry.length
          i--
        }
        if (i >= 0 && textLen === href.length && buf.slice(i + 1).join('') === href) {
          buf.length = i
          const auto = `<${href}>`
          buf.push(auto)
          state.lastContentCache = auto
          return ''
        }
      }
      return `]${serializeMarkdownResource(href, title)}`
    },
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_IMG]: {
    enter: ({ node, state }) => {
      const alt = node.attributes?.alt || ''
      const src = resolveUrl(node.attributes?.src || '', state.options?.origin, state.options?.clean)
      return `![${serializeImageDescription(alt)}]${serializeMarkdownResource(src, node.attributes?.title)}`
    },
    collapsesInnerWhiteSpace: true,
    isSelfClosing: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_TABLE]: {
    enter: ({ state }) => {
      if (isInsideTableCell(state)) {
        return '<table>'
      }
      if ((state.depthMap?.[TAG_TABLE] || 0) <= 1) {
        state.tableRenderedTable = false
        state.tableHeaderCells = 0
      }
      // Initialize table state
      state.tableColumnAlignments = []
    },
    exit: ({ state }) => isInsideTableCell(state) ? '</table>' : undefined,
  },
  [TAG_THEAD]: {
    enter: ({ state }) => {
      if (isInsideTableCell(state)) {
        return '<thead>'
      }
    },
    exit: ({ state }) => isInsideTableCell(state) ? '</thead>' : undefined,
    spacing: TABLE_ROW_SPACING,
    excludesTextNodes: true,
  },
  [TAG_TR]: {
    enter: ({ state }) => {
      if (isInsideTableCell(state)) {
        return '<tr>'
      }
      state.tableCurrentRowCells = 0
      if ((state.depthMap?.[TAG_LI] || 0) > 0 && state.listIndent && bufferEndsWithNewlineForRow(state))
        return `${state.listIndent}| `
      return '| '
    },
    exit: ({ state }) => {
      if (isInsideTableCell(state) || (state.depthMap?.[TAG_TABLE] || 0) > 1) {
        return '</tr>'
      }

      // Handle header row separator
      if (!state.tableRenderedTable) {
        state.tableRenderedTable = true

        // Ensure we have alignments for all columns
        const alignments = state.tableColumnAlignments!
        while (alignments.length < state.tableCurrentRowCells!) {
          alignments.push('')
        }

        // Map alignment values to markdown syntax
        const alignmentMarkers = alignments.map((align) => {
          switch (align) {
            case 'left': return ':---'
            case 'center': return ':---:'
            case 'right': return '---:'
            default: return '---'
          }
        })

        state.tableHeaderCells = alignmentMarkers.length
        const rowIndent = (state.depthMap?.[TAG_LI] || 0) > 0 ? state.listIndent : ''
        return ` |\n${rowIndent}| ${alignmentMarkers.join(' | ')} |`
      }

      return ' |'
    },
    excludesTextNodes: true,
    spacing: TABLE_ROW_SPACING,
  },
  [TAG_TH]: {
    enter: ({ node, state }) => {
      if ((state.depthMap?.[TAG_TABLE] || 0) > 1) {
        return '<th>'
      }

      // A spanned header covers several columns; each needs its own delimiter
      // entry or the row loses the cells past the span.
      const align = node.attributes?.align?.toLowerCase()
      for (let column = 0; column < cellSpan(node); column++) {
        if (align) {
          state.tableColumnAlignments!.push(align)
        }
        else if (state.tableColumnAlignments!.length <= state.tableCurrentRowCells!) {
          state.tableColumnAlignments!.push('')
        }
      }

      if (node.index === 0)
        return ''
      // GFM discards cells past the delimiter row's width, so fold this one
      // into the previous cell instead of losing its content.
      return cellOverflowsHeader(state) ? ' ' : ' | '
    },
    exit: ({ node, state }) => {
      if ((state.depthMap?.[TAG_TABLE] || 0) > 1) {
        return '</th>'
      }
      state.tableCurrentRowCells! += cellSpan(node)
      return spanFiller(node)
    },
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
  },
  [TAG_TD]: {
    enter: ({ node, state }) => {
      if ((state.depthMap?.[TAG_TABLE] || 0) > 1) {
        return '<td>'
      }
      if (node.index === 0)
        return ''
      return cellOverflowsHeader(state) ? ' ' : ' | '
    },
    exit: ({ node, state }) => {
      if ((state.depthMap?.[TAG_TABLE] || 0) > 1) {
        return '</td>'
      }
      state.tableCurrentRowCells! += cellSpan(node)
      return spanFiller(node)
    },
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
  },
  [TAG_P]: {
    enter: ({ state }) => {
      if ((state.depthMap?.[TAG_LI] || 0) > 0 && !isInsideTableCell(state)) {
        const lastEntry = state.buffer.at(-1)
        const lastChar = lastEntry?.charAt(lastEntry.length - 1) || ''
        if (lastChar && lastChar !== ' ' && lastChar !== '\n') {
          return `\n\n${state.listIndent}`
        }
      }
    },
  },
  [TAG_DIV]: {},
  [TAG_SPAN]: {
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_NAV]: {
  },
  [TAG_LABEL]: {
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_BUTTON]: {
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_BODY]: { spacing: NO_SPACING },
  [TAG_CENTER]: {
    // if in table cell we preserve
    enter: ({ state }) => {
      if ((state.depthMap?.[TAG_TABLE] || 0) > 1) {
        return '<center>'
      }
    },
    exit: ({ state }) => {
      if ((state.depthMap?.[TAG_TABLE] || 0) > 1) {
        return '</center>'
      }
    },
    spacing: NO_SPACING,
  },
  [TAG_TBODY]: {
    spacing: NO_SPACING,
    excludesTextNodes: true,
  },
  [TAG_TFOOT]: {
    spacing: TABLE_ROW_SPACING,
    excludesTextNodes: true,
  },
  [TAG_KBD]: {
    enter: () => '`',
    exit: () => '`',
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_FOOTER]: {
    spacing: NO_SPACING,
  },
  [TAG_FORM]: {
    spacing: NO_SPACING,
  },
  [TAG_LINK]: {
    isSelfClosing: true,
    spacing: NO_SPACING,
    collapsesInnerWhiteSpace: true,
    isInline: true,
  },
  [TAG_AREA]: {
    isSelfClosing: true,
    spacing: NO_SPACING,
    isInline: true,
    collapsesInnerWhiteSpace: true,
  },
  [TAG_BASE]: {
    isSelfClosing: true,
    spacing: NO_SPACING,
    isInline: true,
    collapsesInnerWhiteSpace: true,
  },
  [TAG_COL]: {
    isSelfClosing: true,
    spacing: NO_SPACING,
  },
  [TAG_EMBED]: {
    isSelfClosing: true,
    spacing: NO_SPACING,
  },
  [TAG_INPUT]: {
    isSelfClosing: true,
    spacing: NO_SPACING,
    isInline: true,
    collapsesInnerWhiteSpace: true,
  },
  [TAG_KEYGEN]: {
    isSelfClosing: true,
    spacing: NO_SPACING,
    isInline: true,
    collapsesInnerWhiteSpace: true,
  },
  [TAG_PARAM]: {
    isSelfClosing: true,
    spacing: NO_SPACING,
  },
  [TAG_SOURCE]: {
    isSelfClosing: true,
    spacing: NO_SPACING,
  },
  [TAG_TRACK]: {
    isSelfClosing: true,
    spacing: NO_SPACING,
  },
  [TAG_WBR]: {
    isSelfClosing: true,
    spacing: NO_SPACING,
    isInline: true,
    collapsesInnerWhiteSpace: true,
  },
  [TAG_SVG]: {
    spacing: NO_SPACING,
  },
  [TAG_SELECT]: {
    spacing: NO_SPACING,
  },
  [TAG_TEXTAREA]: {
    isNonNesting: true,
    spacing: NO_SPACING,
  },
  [TAG_OPTION]: {
    spacing: NO_SPACING,
  },
  [TAG_OPTGROUP]: {
    spacing: NO_SPACING,
  },
  [TAG_FIELDSET]: {
    spacing: NO_SPACING,
  },
  [TAG_LEGEND]: {
    spacing: NO_SPACING,
  },
  [TAG_AUDIO]: {
    spacing: NO_SPACING,
  },
  [TAG_VIDEO]: {
    spacing: NO_SPACING,
  },
  [TAG_CANVAS]: {
    spacing: NO_SPACING,
  },
  [TAG_IFRAME]: {
    isNonNesting: true,
    spacing: NO_SPACING,
  },
  [TAG_MAP]: {
    spacing: NO_SPACING,
  },
  [TAG_DIALOG]: {
    spacing: NO_SPACING,
  },
  [TAG_METER]: {
    spacing: NO_SPACING,
  },
  [TAG_PROGRESS]: {
    spacing: NO_SPACING,
  },
  [TAG_TEMPLATE]: {
    // <template> content is parsed (including nested templates) but remains
    // inert, so its subtree is excluded from Markdown by the parser/processor.
    excludesTextNodes: true,
    spacing: NO_SPACING,
  },
  [TAG_ABBR]: {
    enter: () => '',
    exit: () => '',
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_MARK]: {
    enter: () => '<mark>',
    exit: () => '</mark>',
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_Q]: {
    enter: () => '"',
    exit: () => '"',
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_SAMP]: {
    enter: () => '`',
    exit: () => '`',
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_SMALL]: {
    enter: () => '',
    exit: () => '',
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_NOSCRIPT]: {
    excludesTextNodes: true,
    spacing: NO_SPACING,
  },
  [TAG_DATALIST]: {
    // <datalist> holds <option> autocomplete data that browsers never render.
    // Treat the whole body as inert and drop it, mirroring <template>.
    isNonNesting: true,
    excludesTextNodes: true,
    spacing: NO_SPACING,
  },
  [TAG_NOFRAMES]: {
    isNonNesting: true,
    spacing: NO_SPACING,
  },
  [TAG_XMP]: {
    isNonNesting: true,
    spacing: NO_SPACING,
  },
  [TAG_PLAINTEXT]: {
    isNonNesting: true,
    spacing: NO_SPACING,
  },
  [TAG_ASIDE]: {
    spacing: NO_SPACING,
  },
  [TAG_U]: {
    enter: () => {
      return '<u>'
    },
    exit: () => {
      return '</u>'
    },
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_CITE]: {
    enter: () => '*',
    exit: () => '*',
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_DFN]: {
    enter: () => '**',
    exit: () => '**',
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_VAR]: {
    enter: () => '`',
    exit: () => '`',
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_TIME]: {
    enter: () => '',
    exit: () => '',
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_BDO]: {
    enter: () => '',
    exit: () => '',
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_RUBY]: {
    enter: () => '',
    exit: () => '',
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_RT]: {
    enter: () => '',
    exit: () => '',
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
  [TAG_RP]: {
    enter: () => '',
    exit: () => '',
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },

  [TAG_ADDRESS]: {
    enter: () => '<address>',
    exit: () => '</address>',
    spacing: NO_SPACING,
    collapsesInnerWhiteSpace: true,
  },

  [TAG_DL]: {
    spacing: NO_SPACING,
    enter: () => '<dl>',
    exit: () => '</dl>',
  },

  [TAG_DT]: {
    // Definition term
    enter: () => '<dt>',
    exit: () => '</dt>',
    collapsesInnerWhiteSpace: true,
    spacing: [0, 1],
  },

  [TAG_DD]: {
    // Definition term
    enter: () => '<dd>',
    exit: () => '</dd>',
    spacing: [0, 1],
  },

  [TAG_ARTICLE]: {},
  [TAG_SECTION]: {},
  [TAG_HEADER]: {},
  [TAG_MAIN]: {},
  [TAG_FIGURE]: {},

  [TAG_FIGCAPTION]: {
    enter: () => MARKDOWN_EMPHASIS,
    exit: () => MARKDOWN_EMPHASIS,
    collapsesInnerWhiteSpace: true,
    spacing: NO_SPACING,
    isInline: true,
  },
}

/**
 * Build a map of tag name → TagHandler from declarative tagOverrides config.
 * For alias (string value): clone the handler for the aliased tag.
 * For override object: overlay fields onto the base handler (if tag is known).
 */
export function buildTagOverrideHandlers(overrides: Record<string, TagOverride | string>): Map<string, TagHandler> {
  const result = new Map<string, TagHandler>()

  for (const tagName in overrides) {
    const override = overrides[tagName]
    if (!override)
      continue

    if (typeof override === 'string') {
      // Alias: look up the target tag's handler
      const targetId = TagIdMap[override as keyof typeof TagIdMap]
      if (targetId !== undefined) {
        const baseHandler = tagHandlers[targetId]
        if (baseHandler) {
          result.set(tagName, { ...baseHandler, aliasTagId: targetId })
        }
      }
    }
    else {
      // Override object: start with base handler if tag is known
      const baseId = TagIdMap[tagName as keyof typeof TagIdMap]
      const baseHandler = baseId !== undefined ? tagHandlers[baseId] : undefined
      const handler: TagHandler = baseHandler ? { ...baseHandler } : {}

      if (override.enter !== undefined) {
        const enterStr = override.enter
        handler.enter = () => enterStr
        handler.literalEnter = true
      }
      if (override.exit !== undefined) {
        const exitStr = override.exit
        handler.exit = () => exitStr
        handler.literalExit = true
      }
      if (override.spacing !== undefined) {
        handler.spacing = override.spacing
      }
      if (override.isInline !== undefined) {
        handler.isInline = override.isInline
      }
      if (override.isSelfClosing !== undefined) {
        handler.isSelfClosing = override.isSelfClosing
      }
      if (override.collapsesInnerWhiteSpace !== undefined) {
        handler.collapsesInnerWhiteSpace = override.collapsesInnerWhiteSpace
      }

      result.set(tagName, handler)
    }
  }

  return result
}
