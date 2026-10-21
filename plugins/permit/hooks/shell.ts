// Splits a shell command into the simple commands it runs, so each can be
// judged on its own: `a && b | c; d=$(e)` runs a, b, c, `d=$(e)` and e.
// `isOpaque` marks what this cannot take apart safely (a heredoc, an
// unclosed quote): such a command only matches a rule as a whole.
//
// A heredoc's body is read as bash reads it: under a quoted delimiter
// (<<'EOF') it is plain text, under a bare one only its $(…) and `…` run, and
// fed to a shell (bash <<EOF, ssh host <<EOF) it is a script of its own.

export type Split = { segments: string[]; isOpaque: boolean }

const KEYWORD_LEAD = /^(?:then|else|do|elif|if|while|until|!)\s+/
const KEYWORD_ALONE = /^(?:fi|done|esac|then|else|do|\{|\}|\(|\))$/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"(?:[^"\\]|\\.)*"|\$\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)|`[^`]*`|[^\s'"$`]|\$(?!\())*/
const WRAPPERS = /^(?:time|nohup|command|exec|builtin)\s+/
/** Shells, ssh and su run a heredoc they read as commands; so do `source` and `.` as the command itself. */
const SHELLS = /^(?:(?:ba|da|k|a|z|fi)?sh|ssh|su)$/

/** A heredoc waiting for its body: `<<-` strips leading tabs; quoting the delimiter keeps the body literal. */
type Heredoc = { delimiter: string; isQuoted: boolean; isTabbed: boolean; isScript: boolean }

export function splitCommand(command: string): Split {
  const segments: string[] = []
  let isOpaque = false

  const walk = (text: string, depth: number): void => {
    if (depth > 8) {
      isOpaque = true
      return
    }
    let current = ''
    let quote: "'" | '"' | null = null
    const heredocs: Heredoc[] = []
    const push = () => {
      const cleaned = clean(current)
      if (cleaned) segments.push(cleaned)
      current = ''
    }
    // what a bare heredoc's body still runs: its $(…) and `…`
    const expand = (body: string) => {
      for (let j = 0; j < body.length; j++) {
        const c = body[j]
        if (c === '\\') j++
        else if (c === '$' && body[j + 1] === '(') {
          const end = closing(body, j + 1)
          if (end < 0) return void (isOpaque = true)
          walk(body.slice(j + 2, end), depth + 1)
          j = end
        } else if (c === '`') {
          const end = body.indexOf('`', j + 1)
          if (end < 0) return void (isOpaque = true)
          walk(body.slice(j + 1, end), depth + 1)
          j = end
        }
      }
    }

    for (let i = 0; i < text.length; i++) {
      const c = text[i]!
      const next = text[i + 1]

      if (quote === "'") {
        current += c
        if (c === "'") quote = null
        continue
      }
      if (c === '\\') {
        current += c + (next ?? '')
        i++
        continue
      }
      if (quote === '"') {
        if (c === '"') quote = null
        else if (c === '$' && next === '(') {
          const end = closing(text, i + 1)
          if (end < 0) return void (isOpaque = true)
          walk(text.slice(i + 2, end), depth + 1)
          current += text.slice(i, end + 1)
          i = end
          continue
        } else if (c === '`') {
          const end = text.indexOf('`', i + 1)
          if (end < 0) return void (isOpaque = true)
          walk(text.slice(i + 1, end), depth + 1)
          current += text.slice(i, end + 1)
          i = end
          continue
        }
        current += c
        continue
      }
      if (c === "'" || c === '"') {
        quote = c
        current += c
        continue
      }
      if ((c === '$' || c === '<' || c === '>') && next === '(') {
        const end = closing(text, i + 1)
        if (end < 0) return void (isOpaque = true)
        walk(text.slice(i + 2, end), depth + 1)
        current += text.slice(i, end + 1)
        i = end
        continue
      }
      if (c === '`') {
        const end = text.indexOf('`', i + 1)
        if (end < 0) return void (isOpaque = true)
        walk(text.slice(i + 1, end), depth + 1)
        current += text.slice(i, end + 1)
        i = end
        continue
      }
      if (c === '<' && next === '<' && text[i + 2] !== '<') {
        isOpaque = true
        // in (( x << 2 )) it is a shift, not a heredoc
        const word = /^\s*\(\(/.test(current) ? undefined : heredocWord(text, i + 2)
        if (word === undefined) {
          current += c
          continue
        }
        const run = words(normalize(clean(current))).map(w => w.replace(/^.*\//, ''))
        const isScript = run[0] === 'source' || run[0] === '.' || run.some(w => SHELLS.test(w))
        heredocs.push({ ...word.heredoc, isScript })
        current += text.slice(i, word.end)
        i = word.end - 1
        continue
      }
      if (c === '#' && (current === '' || /\s$/.test(current))) {
        const end = text.indexOf('\n', i)
        i = end < 0 ? text.length : end - 1
        continue
      }
      if (c === ';' || c === '\n') {
        push()
        // the bodies of this line's heredocs start on the next line
        if (c === '\n' && heredocs.length > 0) {
          const { end, bodies } = skipBodies(text, i + 1, heredocs.splice(0))
          for (const { body, doc } of bodies) {
            if (doc.isScript) walk(body, depth + 1)
            else if (!doc.isQuoted) expand(body)
          }
          i = end - 1
        }
        continue
      }
      if (c === '&') {
        if (next === '&') {
          push()
          i++
          continue
        }
        if (next === '>' || current.endsWith('>') || current.endsWith('<')) {
          current += c
          continue
        }
        push()
        continue
      }
      if (c === '|') {
        push()
        if (next === '|' || next === '&') i++
        continue
      }
      current += c
    }
    if (quote) isOpaque = true
    push()
  }

  walk(command, 0)
  return { segments, isOpaque }
}

/** The index of the `)` closing the `(` at `open`, quotes and heredoc bodies respected; -1 if none. */
function closing(text: string, open: number): number {
  let depth = 0
  let quote: "'" | '"' | null = null
  const heredocs: Heredoc[] = []
  // $(( … )) is arithmetic, where << is a shift
  const isArithmetic = text[open + 1] === '('
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '\\') i++
    else if (c === "'" || c === '"') quote = c
    else if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<' && !isArithmetic) {
      const word = heredocWord(text, i + 2)
      if (word === undefined) i++
      else {
        heredocs.push({ ...word.heredoc, isScript: false })
        i = word.end - 1
      }
    } else if (c === '\n' && heredocs.length > 0) i = skipBodies(text, i + 1, heredocs.splice(0)).end - 1
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}

/** The delimiter word of a heredoc whose `<<` ends just before `at`, and where that word ends. */
function heredocWord(text: string, at: number): { heredoc: Omit<Heredoc, 'isScript'>; end: number } | undefined {
  let i = at
  const isTabbed = text[i] === '-'
  if (isTabbed) i++
  while (text[i] === ' ' || text[i] === '\t') i++
  let delimiter = ''
  let isQuoted = false
  for (; i < text.length; i++) {
    const c = text[i]!
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1)
      if (close < 0) return undefined
      delimiter += text.slice(i + 1, close)
      isQuoted = true
      i = close
    } else if (c === '\\' && i + 1 < text.length) {
      delimiter += text[++i]
      isQuoted = true
    } else if (/[\s;&|<>()]/.test(c)) break
    else delimiter += c
  }
  return delimiter === '' ? undefined : { heredoc: { delimiter, isQuoted, isTabbed }, end: i }
}

/**
 * The bodies of `heredocs`, read one after another from `start` (the line
 * after their `<<`): each runs to a line that is its delimiter alone, or to
 * the end. `end` is where the shell's own text picks up again.
 */
function skipBodies(text: string, start: number, heredocs: Heredoc[]): { end: number; bodies: { body: string; doc: Heredoc }[] } {
  let at = start
  const bodies: { body: string; doc: Heredoc }[] = []
  for (const doc of heredocs) {
    const from = at
    let to = text.length
    while (at < text.length) {
      const newline = text.indexOf('\n', at)
      const lineEnd = newline < 0 ? text.length : newline
      const line = text.slice(at, lineEnd)
      const next = newline < 0 ? text.length : newline + 1
      if ((doc.isTabbed ? line.replace(/^\t+/, '') : line) === doc.delimiter) {
        to = at
        at = next
        break
      }
      at = next
    }
    bodies.push({ body: text.slice(from, to), doc })
  }
  return { end: at, bodies }
}

function clean(raw: string): string {
  let s = raw.trim()
  while (/^[({]\s*/.test(s)) s = s.replace(/^[({]\s*/, '')
  while (/\s*[)}]$/.test(s) && !/\$\([^)]*\)$/.test(s)) s = s.replace(/\s*[)}]$/, '')
  s = s.trim()
  while (KEYWORD_LEAD.test(s)) s = s.replace(KEYWORD_LEAD, '').trim()
  if (KEYWORD_ALONE.test(s)) return ''
  return s
}

/** The command a segment runs, leading `VAR=x` assignments and wrappers dropped. */
export function normalize(segment: string): string {
  let s = segment.trim()
  for (let guard = 0; guard < 20; guard++) {
    const assignment = ASSIGNMENT.exec(s)
    if (assignment && /^\s/.test(s.slice(assignment[0].length))) {
      s = s.slice(assignment[0].length).trim()
      continue
    }
    if (WRAPPERS.test(s)) {
      s = s.replace(WRAPPERS, '')
      continue
    }
    break
  }
  return s
}

/** True for segments that run nothing worth judging: `cd x`, `export A=b`, `X=$(…)`. */
export function isNeutral(segment: string): boolean {
  const s = segment.trim()
  if (/^(?:cd|pushd|popd)(?:\s|$)/.test(s)) return !/[;&|]/.test(s)
  if (/^(?:true|false|:|wait|set\s+[-+][a-zA-Z]+(?:\s+\w+)?|umask\s+\d+|sleep\s+[\d.]+[smh]?|shopt\s+-[su]\s+\w+)$/.test(s)) return true
  if (/^for\s+[A-Za-z_]\w*\s+in\b/.test(s)) return true
  const assignments = s.replace(/^(?:export|local|readonly|declare(?:\s+-\w+)?)\s+/, '')
  let rest = assignments
  for (let guard = 0; guard < 20 && rest; guard++) {
    const m = ASSIGNMENT.exec(rest)
    if (!m) return false
    rest = rest.slice(m[0].length).trim()
  }
  return rest === ''
}

/** Splits a segment into words, quotes kept off; enough for prefixes and floors. */
export function words(segment: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let has = false
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < segment.length) current += segment[++i]
      else current += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      has = true
      continue
    }
    if (c === '\\' && i + 1 < segment.length) {
      current += segment[++i]
      has = true
      continue
    }
    if (/\s/.test(c)) {
      if (has || current) out.push(current)
      current = ''
      has = false
      continue
    }
    current += c
    has = true
  }
  if (has || current) out.push(current)
  return out
}
