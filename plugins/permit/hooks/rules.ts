import type { PermitActivation, PermitFloorCheck, PermitLocalConfig, PermitLocalProfile, PermitPattern, PermitProfile, PermitRule } from '../types'
import { isNeutral, normalize, splitCommand, words } from './shell'

export const HOUR = 3_600_000
export const ONCE_TTL = 30 * 60_000
export const SESSION_TTL = 3 * 24 * HOUR

// ── Globs ────────────────────────────────────────────────────────────────

const globCache = new Map<string, RegExp>()

/** `*` is any run of characters (slashes and spaces too), `?` one. `x *` also matches bare `x`. */
export function glob(pattern: string): RegExp {
  let re = globCache.get(pattern)
  if (re) return re
  const body = pattern
    .split('')
    .map(c => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('')
  const tail = pattern.endsWith(' *') ? `(?:${body.slice(0, -3)}|${body})` : body
  re = new RegExp(`^${tail}$`, 's')
  globCache.set(pattern, re)
  return re
}

export const matches = (pattern: string, value: string) => glob(pattern).test(value)

// ── What a call is about ─────────────────────────────────────────────────

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** The one string a rule's `match` is held against: the command, the path, the URL. */
export function subjectOf(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof i[k] === 'string') return i[k] as string
    return ''
  }
  if (tool === 'Bash') return pick('command')
  if (FILE_TOOLS.has(tool)) return pick('file_path', 'notebook_path')
  if (tool === 'WebFetch') return pick('url')
  if (tool === 'WebSearch') return pick('query')
  if (tool === 'Skill') return pick('skill')
  if (tool === 'Agent' || tool === 'Task') return pick('subagent_type')
  if (tool === 'Glob' || tool === 'Grep') return pick('path', 'pattern')
  try {
    return JSON.stringify(input ?? {}).slice(0, 2000)
  } catch {
    return ''
  }
}

export function describeRule(r: PermitPattern): string {
  if (r.match === undefined) return r.tool === '*' ? 'every tool' : r.tool
  return r.tool === 'Bash' ? r.match : `${r.tool}(${r.match})`
}

/** `Bash(vercel env *)`, `vercel env *`, `mcp__x__*`, `Read(/home/*)` → a pattern. */
export function parsePattern(text: string): PermitPattern | undefined {
  const t = text.trim()
  if (!t) return undefined
  const call = /^([A-Za-z_][\w.*?-]*)\((.*)\)$/s.exec(t)
  if (call) return { tool: call[1]!, match: call[2]!.trim() || undefined }
  if (/^(?:mcp__\S+|[A-Z][A-Za-z]+|\*)$/.test(t)) return { tool: t }
  return { tool: 'Bash', match: t }
}

// ── Rules in force ───────────────────────────────────────────────────────

export function isLive(r: PermitRule, now: number, sessionId: string): boolean {
  if (r.expiresAt !== undefined && r.expiresAt <= now) return false
  if ((r.scope === 'session' || r.scope === 'once') && r.sessionId !== sessionId) return false
  return true
}

export function liveActivations(active: PermitActivation[], now: number): PermitActivation[] {
  return active.filter(a => a.until === 0 || a.until > now)
}

/** Every pattern in force: live rules plus the rules of switched-on profiles. */
export function patternsInForce(
  rules: PermitRule[],
  active: PermitActivation[],
  profiles: PermitProfile[],
  now: number,
  sessionId: string,
): { pattern: PermitPattern; source: string; ruleId?: string }[] {
  const out: { pattern: PermitPattern; source: string; ruleId?: string }[] = []
  for (const r of rules) {
    if (r.scope === 'once' || r.id.startsWith('demo-') || !isLive(r, now, sessionId)) continue
    out.push({ pattern: { tool: r.tool, match: r.match }, source: describeRule(r), ruleId: r.id })
  }
  for (const a of liveActivations(active, now)) {
    if (a.isDemo) continue
    const p = profiles.find(x => x.name === a.name)
    if (p) for (const pattern of p.rules) out.push({ pattern, source: `${p.icon} ${p.name}` })
  }
  return out
}

export type Verdict =
  | { kind: 'allow'; sources: string[]; ruleIds: string[] }
  | { kind: 'partial'; sources: string[]; ruleIds: string[]; unresolved: string[] }
  | { kind: 'none' }

/**
 * Whether the patterns cover a call. For Bash every simple command must be
 * covered (or be neutral); the ones left over come back as `unresolved` so the
 * caller can ask the engine about each alone.
 */
export function judge(
  tool: string,
  input: unknown,
  patterns: { pattern: PermitPattern; source: string; ruleId?: string }[],
): Verdict {
  const forTool = patterns.filter(p => matches(p.pattern.tool, tool))
  if (forTool.length === 0) return { kind: 'none' }
  const whole = forTool.find(p => p.pattern.match === undefined)
  if (whole) return { kind: 'allow', sources: [whole.source], ruleIds: whole.ruleId ? [whole.ruleId] : [] }

  const subject = subjectOf(tool, input)
  if (tool !== 'Bash') {
    const hit = forTool.find(p => matches(p.pattern.match!, subject))
    return hit ? { kind: 'allow', sources: [hit.source], ruleIds: hit.ruleId ? [hit.ruleId] : [] } : { kind: 'none' }
  }

  const { segments, isOpaque } = splitCommand(subject)
  if (isOpaque) {
    const hit = forTool.find(p => matches(p.pattern.match!, subject.trim()))
    return hit ? { kind: 'allow', sources: [hit.source], ruleIds: hit.ruleId ? [hit.ruleId] : [] } : { kind: 'none' }
  }
  const sources = new Set<string>()
  const ruleIds = new Set<string>()
  const unresolved: string[] = []
  for (const seg of segments) {
    if (isNeutral(seg)) continue
    const run = normalize(seg)
    if (isNeutral(run)) continue
    const hit = forTool.find(p => matches(p.pattern.match!, run) || matches(p.pattern.match!, seg))
    if (hit) {
      sources.add(hit.source)
      if (hit.ruleId) ruleIds.add(hit.ruleId)
    } else unresolved.push(run)
  }
  if (sources.size === 0) return { kind: 'none' }
  if (unresolved.length === 0) return { kind: 'allow', sources: [...sources], ruleIds: [...ruleIds] }
  return { kind: 'partial', sources: [...sources], ruleIds: [...ruleIds], unresolved }
}

// ── Suggestions: what "always allow this kind" means ────────────────────

const INTERPRETERS = new Set(['node', 'python', 'python3', 'bash', 'sh', 'zsh', 'npx', 'bunx', 'bun', 'deno', 'ruby', 'perl', 'tsx', 'ts-node', 'uv', 'uvx', 'pnpm', 'yarn', 'npm'])

/** The prefix pattern for one simple command: `vercel env *`, `wl-copy *`, `node scripts/x.mjs *`. */
export function prefixFor(segment: string): string {
  const w = words(normalize(segment))
  if (w.length === 0) return segment
  const [head, ...rest] = w
  if (INTERPRETERS.has(head!)) {
    // Inline code (node -e, python -c) only ever matches itself, never by wildcard.
    if (rest.some(x => /^(?:-e|-c|-p|--eval|--print|-E)$/.test(x))) return normalize(segment)
    const at = rest.findIndex(x => !x.startsWith('-'))
    if (at < 0) return `${head} *`
    const arg = rest[at]!
    const isPackageManager = head === 'npm' || head === 'pnpm' || head === 'yarn'
    const target = isPackageManager && arg === 'run' && rest[at + 1] ? `run ${rest[at + 1]}` : arg
    return at === 0 ? `${head} ${target} *` : `${head} * ${target} *`
  }
  const sub = rest[0]
  if (sub && /^[a-z][\w-]*$/.test(sub) && rest.length > 0) {
    const third = rest[1]
    if ((head === 'gh' || head === 'vercel' || head === 'docker' || head === 'git' || head === 'kubectl' || head === 'gcloud' || head === 'aws') && third && /^[a-z][\w-]*$/.test(third)) {
      return `${head} ${sub} ${third} *`
    }
    return `${head} ${sub} *`
  }
  return `${head} *`
}

/** What "always allow" should grant for a blocked call: the narrowest useful patterns. */
export function suggest(tool: string, input: unknown, isCovered: (segment: string) => boolean): PermitPattern[] {
  const subject = subjectOf(tool, input)
  if (tool === 'Bash') {
    const { segments, isOpaque } = splitCommand(subject)
    if (isOpaque) return [{ tool, match: subject.trim() }]
    const out: PermitPattern[] = []
    for (const seg of segments) {
      if (isNeutral(seg) || isNeutral(normalize(seg)) || isCovered(normalize(seg))) continue
      const match = prefixFor(seg)
      if (!out.some(p => p.match === match)) out.push({ tool, match })
    }
    return out.length ? out : [{ tool, match: prefixFor(segments[0] ?? subject) }]
  }
  if (FILE_TOOLS.has(tool) && subject) {
    const cut = subject.lastIndexOf('/')
    return [{ tool, match: cut > 0 ? `${subject.slice(0, cut)}/*` : subject }]
  }
  if (tool === 'WebFetch' && subject) {
    const host = /^https?:\/\/[^/]+/.exec(subject)?.[0]
    return [{ tool, match: host ? `${host}/*` : subject }]
  }
  if (tool === 'Skill' && subject) return [{ tool, match: subject }]
  return [{ tool }]
}

// ── Profiles ─────────────────────────────────────────────────────────────

const b = (match: string): PermitPattern => ({ tool: 'Bash', match })

export const BUILT_IN_PROFILES: PermitProfile[] = [
  {
    name: 'secrets',
    icon: '🔑',
    title: 'Secrets',
    blurb: 'VaultOS, Vercel env, and handing keys to apps via the clipboard',
    rules: [
      b('vaultos-agent *'), b('vercel env *'), b('wl-copy *'), b('pbcopy *'),
      { tool: 'mcp__vaultos__*' }, { tool: 'mcp__permit__secret_to_clipboard' },
    ],
    maxHours: 8,
  },
  {
    name: 'desktop',
    icon: '💻',
    title: 'Desktop & Chrome',
    blurb: 'Claude in Chrome: clicks, typing and tabs',
    rules: [{ tool: 'mcp__claude-in-chrome__*' }],
  },
  {
    name: 'deploy',
    icon: '🚀',
    title: 'Ship it',
    blurb: 'Vercel deploys, git push (never force to main), PRs and CI',
    rules: [b('vercel deploy *'), b('vercel --prod *'), b('vercel promote *'), b('git push *'), b('gh pr *'), b('gh run *'), b('gh workflow *')],
    maxHours: 8,
  },
  {
    name: 'ops',
    icon: '🔧',
    title: 'Ops',
    blurb: 'User services, logs and docker',
    rules: [b('systemctl --user *'), b('systemctl status *'), b('journalctl *'), b('docker *')],
  },
  {
    name: 'mail',
    icon: '📨',
    title: 'Mail & messages',
    blurb: 'Gmail and Resend sends you asked for',
    rules: [{ tool: 'mcp__claude_ai_Gmail__*' }, b('curl * https://api.resend.com/*')],
    maxHours: 4,
  },
  {
    name: 'all',
    icon: '⚡',
    title: 'Trust everything',
    blurb: 'Every tool runs without asking. The hard floor still holds.',
    rules: [{ tool: '*' }],
    maxHours: 2,
  },
]

// ── This machine's own additions ─────────────────────────────────────────

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim()) : [])

function pattern(v: unknown): PermitPattern | undefined {
  if (!v || typeof v !== 'object') return undefined
  const { tool, match } = v as Record<string, unknown>
  if (typeof tool !== 'string' || tool.trim() === '') return undefined
  return typeof match === 'string' && match.trim() !== '' ? { tool: tool.trim(), match: match.trim() } : { tool: tool.trim() }
}

/** config.json as written by hand, with anything malformed left out. */
export function toLocalConfig(raw: unknown): PermitLocalConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const profiles: PermitLocalProfile[] = []
  for (const p of Array.isArray(r.profiles) ? r.profiles : []) {
    if (!p || typeof p !== 'object') continue
    const x = p as Record<string, unknown>
    if (typeof x.name !== 'string' || !/^[a-z][\w-]{0,30}$/.test(x.name)) continue
    profiles.push({
      name: x.name,
      rules: (Array.isArray(x.rules) ? x.rules : []).map(pattern).filter((y): y is PermitPattern => y !== undefined),
      ...(typeof x.icon === 'string' && x.icon.trim() ? { icon: x.icon.trim() } : {}),
      ...(typeof x.title === 'string' && x.title.trim() ? { title: x.title.trim() } : {}),
      ...(typeof x.blurb === 'string' ? { blurb: x.blurb.trim() } : {}),
      ...(typeof x.maxHours === 'number' && x.maxHours > 0 ? { maxHours: x.maxHours } : {}),
    })
  }
  const vaultCommand = typeof r.vaultCommand === 'string' && /^[\w./~+-]+$/.test(r.vaultCommand.trim()) ? r.vaultCommand.trim() : undefined
  // false or a list only ever narrows which floor checks may be approved
  const floorApprovals = r.floorApprovals === false ? [] : Array.isArray(r.floorApprovals) ? strings(r.floorApprovals) : undefined
  return { protect: strings(r.protect), keepAlive: strings(r.keepAlive), profiles, ...(vaultCommand ? { vaultCommand } : {}), ...(floorApprovals ? { floorApprovals } : {}) }
}

/** The built-in profiles with this machine's added: one named like a built-in adds its rules to it. */
export function mergeProfiles(builtIn: PermitProfile[], local: PermitLocalProfile[] = []): PermitProfile[] {
  const out = builtIn.map(p => ({ ...p, rules: [...p.rules] }))
  for (const l of local) {
    const same = out.find(p => p.name === l.name)
    if (same) {
      for (const r of l.rules) if (!same.rules.some(x => x.tool === r.tool && x.match === r.match)) same.rules.push(r)
      if (l.icon) same.icon = l.icon
      if (l.title) same.title = l.title
      if (l.blurb !== undefined) same.blurb = l.blurb
      if (l.maxHours) same.maxHours = l.maxHours
    } else if (l.rules.length > 0) {
      out.push({ name: l.name, icon: l.icon ?? '◆', title: l.title ?? l.name, blurb: l.blurb ?? '', rules: l.rules, ...(l.maxHours ? { maxHours: l.maxHours } : {}) })
    }
  }
  return out
}

// ── The hard floor ───────────────────────────────────────────────────────

/**
 * The checks the person may let through once, by approving the exact command
 * on a device of their own (approvals.ts). Every other check is never let
 * through, and config.json can only narrow this list.
 */
export const APPROVABLE: readonly string[] = ['force-main', 'power', 'keep-alive']

export const isApprovable = (id: string, local: PermitLocalConfig = {}) =>
  APPROVABLE.includes(id) && (local.floorApprovals === undefined || local.floorApprovals.includes(id))

/** The floor's checks, with this machine's protected paths and keep-alive list named in them. */
export function floorChecks(local: PermitLocalConfig = {}): PermitFloorCheck[] {
  const protect = local.protect ?? []
  const keepAlive = local.keepAlive ?? []
  const checks: PermitFloorCheck[] = [
    { id: 'secret-print', title: 'Print a secret into the chat (.env files, bare printenv, echo $…TOKEN)' },
    { id: 'credentials', title: "Touch Claude's own login (.credentials.json, claude auth logout)" },
    { id: 'wipe', title: `rm -r on /, ~, $HOME or a whole home folder${protect.length ? `, or ${protect.join(', ')}` : ''}` },
    { id: 'force-main', title: 'Force-push main or master' },
    { id: 'sudo-password', title: 'sudo -S, askpass or pkexec workarounds' },
    { id: 'power', title: 'Power off or suspend the machine' },
    ...(keepAlive.length ? [{ id: 'keep-alive', title: `Stop or kill what must keep running: ${keepAlive.join(', ')}` }] : []),
    { id: 'clipboard', title: 'Read the clipboard while a copied secret is on it' },
  ]
  return checks.map(c => (isApprovable(c.id, local) ? { ...c, isApprovable: true } : c))
}

const ENV_FILE = /(^|\/)\.env(?:\.(?!example$|sample$|template$|defaults$)[\w.-]+)?$/
const SHOWS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'batcat', 'nl', 'strings', 'xxd', 'od', 'hexdump', 'tac', 'sed', 'awk'])
const SECRET_VARIABLE = /\$\{?[A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)\w*\}?/i
// /, the home folder by any name, and any one person's home folder
const DANGER_ROOT = /^(?:\/\*?|~(?:\/\*?)?|\$HOME(?:\/\*?)?|\$\{HOME\}(?:\/\*?)?|\/(?:home|Users)(?:\/\*?)?|\/(?:home|Users)\/[^/*]+(?:\/\*?)?)$/

/** Whether `rm -r` on `arg` takes a whole home folder, the root, or a path this machine protects. */
function isDangerRoot(arg: string, protect: string[]): boolean {
  if (DANGER_ROOT.test(arg)) return true
  const bare = arg.replace(/\/\*?$/, '')
  return protect.some(p => p.replace(/\/+$/, '') === bare)
}

const base = (word: string) => word.replace(/^.*\//, '')

/** The options of each wrapper that take a value, so `sudo -u x git …` reads as `git …`. */
const WRAPPERS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-U', '--other-user']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '--class', '-n', '--classdata']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  stdbuf: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
  time: new Set(['-f', '--format', '-o', '--output']),
  nohup: new Set(),
  command: new Set(),
  exec: new Set(['-a']),
  builtin: new Set(),
}

/** The words a wrapper runs: `sudo -u x env A=b timeout 30 git push` → `git push`. */
function unwrap(w: string[]): string[] {
  let out = w
  for (let guard = 0; guard < 8; guard++) {
    const head = base(out[0] ?? '')
    const takesValue = WRAPPERS[head]
    if (!takesValue) return out
    let i = 1
    for (; i < out.length; i++) {
      const a = out[i]!
      if (a === '--') {
        i++
        break
      }
      if (a.startsWith('-') && a.length > 1) {
        if (takesValue.has(a)) i++
      } else if (!(/^[A-Za-z_]\w*=/.test(a) && (head === 'env' || head === 'sudo' || head === 'doas'))) break
    }
    if (head === 'timeout') i++
    if (i >= out.length) return out
    out = out.slice(i)
  }
  return out
}

const SHELL = /^(?:(?:ba|da|k|z)?sh)$/

/** Each command a segment runs, as words: itself, what its wrappers run, and the script of `bash -c '…'` or `eval`. */
function runsOf(segment: string, depth = 0): string[][] {
  const raw = words(normalize(segment))
  const inner = unwrap(raw)
  const runs = inner === raw ? [raw] : [raw, inner]
  const head = base(inner[0] ?? '')
  let script: string | undefined
  if (SHELL.test(head)) {
    const at = inner.findIndex((a, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
    if (at > 0) script = inner[at + 1]
  } else if (head === 'eval') script = inner.slice(1).join(' ')
  if (script !== undefined && depth < 4) for (const seg of splitCommand(script).segments) runs.push(...runsOf(seg, depth + 1))
  return runs
}

const joinDir = (dir: string, next: string) => (next.startsWith('/') || next.startsWith('~') || !dir ? next : `${dir}/${next}`)

/** Each command a line runs, with the directory it runs in as far as its `cd`s say (`''`: the session's). */
function eachRun(subject: string, visit: (w: string[], dir: string, segment: string) => void) {
  let dir = ''
  for (const segment of splitCommand(subject).segments) {
    const w = words(normalize(segment))
    if (w[0] === 'cd' || w[0] === 'pushd') {
      dir = joinDir(dir, w.slice(1).find(a => !a.startsWith('-')) ?? '~')
      continue
    }
    for (const run of runsOf(segment)) visit(run, dir, segment)
  }
}

const MAIN = /^(?:main|master)$/
const GIT_TAKES_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'])
const PUSH_TAKES_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])

/**
 * A force push and where it lands: `isMain` when it names main or master
 * (or pushes everything), `needsBranch` when the branch checked out in `dir`
 * decides (`git push -f`, `git push -f origin HEAD`).
 */
type ForcePush = { dir: string; isMain: boolean; needsBranch: boolean }

function forcePushOf(w: string[], dir: string): ForcePush | undefined {
  if (base(w[0] ?? '') !== 'git') return undefined
  let at = dir
  let i = 1
  for (; i < w.length && w[i]!.startsWith('-'); i++) {
    if (w[i] === '-C' && w[i + 1] !== undefined) at = joinDir(at, w[i + 1]!)
    if (GIT_TAKES_VALUE.has(w[i]!)) i++
  }
  if (w[i] !== 'push') return undefined
  let isForce = false
  let isEverything = false
  const positional: string[] = []
  for (let j = i + 1; j < w.length; j++) {
    const a = w[j]!
    if (a === '--') {
      positional.push(...w.slice(j + 1))
      break
    }
    if (PUSH_TAKES_VALUE.has(a)) j++
    else if (a === '--mirror') return { dir: at, isMain: true, needsBranch: false }
    else if (a === '--force' || a.startsWith('--force-with-lease') || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) isForce = true
    else if (a === '--all' || a === '--branches') isEverything = true
    else if (!a.startsWith('-')) positional.push(a)
  }
  // remote first, then refspecs: `+src:dst`, where dst is what lands
  const forced = positional.slice(1).filter(r => isForce || r.startsWith('+')).map(r => {
    const spec = r.replace(/^\+/, '')
    return spec.slice(spec.indexOf(':') + 1).replace(/^refs\/heads\//, '')
  })
  if (isForce && isEverything) return { dir: at, isMain: true, needsBranch: false }
  if (forced.some(to => MAIN.test(to))) return { dir: at, isMain: true, needsBranch: false }
  if ((isForce && positional.length <= 1) || forced.some(to => to === 'HEAD' || to === '@')) return { dir: at, isMain: false, needsBranch: true }
  return undefined
}

/** The directories whose checked-out branch decides whether a force push in `subject` lands on main. */
export function branchDirs(tool: string, input: unknown): string[] {
  if (tool !== 'Bash') return []
  const dirs = new Set<string>()
  eachRun(subjectOf(tool, input), (w, dir) => {
    const push = forcePushOf(w, dir)
    if (push?.needsBranch) dirs.add(push.dir)
  })
  return [...dirs]
}

/**
 * Every floor check a call trips, those never let through first.
 * `secretOnClipboard`: a copy is live. `branches`: the branch checked out in
 * each of `branchDirs`, where it could be read.
 */
export function floorHits(
  tool: string,
  input: unknown,
  secretOnClipboard: boolean,
  local: PermitLocalConfig = {},
  branches: ReadonlyMap<string, string> = new Map(),
): PermitFloorCheck[] {
  const checks = floorChecks(local)
  const protect = local.protect ?? []
  const keepAlive = (local.keepAlive ?? []).map(k => k.toLowerCase())
  const isKept = (a: string) => !a.startsWith('-') && keepAlive.some(k => a.toLowerCase().includes(k))
  const subject = subjectOf(tool, input)
  const found = new Set<string>()

  if (FILE_TOOLS.has(tool)) {
    if (/\/\.claude\/\.credentials\.json$/.test(subject)) found.add('credentials')
    else if (tool === 'Read' && ENV_FILE.test(subject)) found.add('secret-print')
  } else if (tool === 'Bash') {
    if (/\.credentials\.json\b/.test(subject)) found.add('credentials')
    eachRun(subject, (w, dir, segment) => {
      const head = base(w[0] ?? '')
      const args = w.slice(1)
      const text = w.join(' ')
      if (head === 'claude' && /^(?:auth\s+)?logout\b/.test(args.join(' '))) found.add('credentials')
      if (SHOWS.has(head) && args.some(a => !a.startsWith('-') && ENV_FILE.test(a))) found.add('secret-print')
      if ((head === 'printenv' || head === 'env') && args.length === 0) found.add('secret-print')
      if ((head === 'echo' || head === 'printf') && SECRET_VARIABLE.test(text)) found.add('secret-print')
      if (head === 'rm' && args.some(a => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive') && args.some(a => isDangerRoot(a, protect))) found.add('wipe')
      const push = forcePushOf(w, dir)
      if (push && (push.isMain || (push.needsBranch && MAIN.test(branches.get(push.dir) ?? '')))) found.add('force-main')
      if (head === 'sudo' && args.some(a => a === '-S' || a === '--stdin' || a === '-A' || a === '--askpass')) found.add('sudo-password')
      if (head === 'pkexec' || /\bSUDO_ASKPASS=/.test(segment)) found.add('sudo-password')
      // a reboot (`shutdown -r`) or a cancelled shutdown is not one
      if (['poweroff', 'shutdown', 'halt'].includes(head) && !args.some(a => a === '-r' || a === '--reboot' || a === '-c')) found.add('power')
      if ((head === 'systemctl' || head === 'loginctl') && args.some(a => /^(?:poweroff|suspend|hibernate|hybrid-sleep|suspend-then-hibernate|halt)$/.test(a))) found.add('power')
      if (keepAlive.length && head === 'systemctl' && args.some(a => /^(?:stop|disable|mask|kill)$/.test(a)) && args.some(isKept)) found.add('keep-alive')
      if (keepAlive.length && (head === 'pkill' || head === 'killall') && args.some(isKept)) found.add('keep-alive')
      if (secretOnClipboard && (['wl-paste', 'pbpaste'].includes(head) || (['xclip', 'xsel'].includes(head) && args.some(a => a === '-o' || a === '--output')))) found.add('clipboard')
    })
  }
  return checks.filter(c => found.has(c.id)).sort((a, b) => Number(APPROVABLE.includes(a.id)) - Number(APPROVABLE.includes(b.id)))
}

// ── Formatting ───────────────────────────────────────────────────────────

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function left(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `${h}h ${rest}m` : `${h}h`
}

/** `90m`, `2h`, `1d`, `session`, `once`, `always` → a scope and an expiry. */
export function parseDuration(text: string | undefined, now: number): { scope: PermitRule['scope']; expiresAt?: number } | undefined {
  const t = (text ?? '').trim().toLowerCase()
  if (t === '' || t === 'always' || t === 'forever') return { scope: 'always' }
  if (t === 'session') return { scope: 'session', expiresAt: now + SESSION_TTL }
  if (t === 'once') return { scope: 'once', expiresAt: now + ONCE_TTL }
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|mins|h|hr|hrs|hours?|d|days?)$/.exec(t)
  if (!m) return undefined
  const n = Number(m[1])
  const unit = m[2]!.startsWith('m') ? 60_000 : m[2]!.startsWith('h') ? HOUR : 24 * HOUR
  return { scope: 'timed', expiresAt: now + n * unit }
}

export function short(text: string, max = 60): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

export function newId(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('')
}

export function category(reason: string): string {
  return /\[([^\]]+)\]/.exec(reason)?.[1] ?? 'Blocked'
}
