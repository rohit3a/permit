// What the pane, band, status line and /permit say, with nothing that needs $.
// Everything that reads state or acts lives in register.tsx.
import type { Elements, RenderChildren } from 'claude-code'

import type { PermitBlock, PermitConfigRow, PermitLogKind, PermitProfile, PermitRule, PermitSnapshot, PermitTab } from '../types'
import { BUILT_IN_PROFILES, ago, left } from './rules'

export type Kit = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button'>

export const PANE = 'permit'

export const TABS: { id: PermitTab; label: string }[] = [
  { id: 'home', label: 'Overview' },
  { id: 'rules', label: 'Rules' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'log', label: 'Log' },
  { id: 'config', label: 'Settings' },
]

const LOG_ICON: Record<PermitLogKind, string> = {
  allowed: '✓', floor: '■', approval: '⏳', blocked: '⛔', granted: '+', revoked: '−', profile: '◆', secret: '🔑',
}

export const MODE_LABEL: Record<string, string> = {
  auto: 'auto', default: 'ask', acceptEdits: 'accept edits', plan: 'plan', bypassPermissions: 'bypass', dontAsk: "don't ask",
}

/**
 * A code span. /permit's text shows as typed in the terminal and as Markdown
 * in the desktop app, where a bare `*` or `_` in a pattern turns into
 * emphasis; inside a span both read the same.
 */
export function code(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), m => m[0].length))
  const fence = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/** Text as it is, or a code span where Markdown would change it. */
export const literal = (text: string) => (/[*_`~[\]<>#|\\$]/.test(text) ? code(text) : text)

// One command per line and no columns: the desktop app's font is proportional.
export const HELP = [
  `${code('/permit')} opens the pane`,
  `${code('/permit allow <pattern> [when]')} allows a pattern: ${['"vercel env *"', 'Bash(npm run *)', 'mcp__github__*', 'Read(/srv/data/*)'].map(code).join(', ')}; when is once, session, 30m, 2h, 1d or always (the default)`,
  `${code('/permit trust <profile> [2h|off]')} switches a profile on for a while: ${BUILT_IN_PROFILES.map(p => p.name).join(', ')}`,
  `${code('/permit untrust <profile>')} switches it off`,
  `${code('/permit off')} switches everything temporary off (profiles, session and timed rules)`,
  `${code('/permit revoke <id or pattern>')} removes one of your rules`,
  `${code('/permit approve')} allows the latest block once`,
  `${code('/permit rules')}, ${code('/permit log')}, ${code('/permit floor')} list them`,
  `${code('/permit demo [clear]')} fills the pane with sample data to look at (inert: it never allows anything)`,
].join('\n')

/** Pending blocks worth showing: this session's first, newest first. */
export function pendingBlocks(s: PermitSnapshot): PermitBlock[] {
  return s.blocks
    .filter(b => b.status === 'pending')
    .sort((a, b) => Number(b.sessionId === s.sessionId) - Number(a.sessionId === s.sessionId) || b.at - a.at)
}

export function ruleScope(r: PermitRule, now: number): string {
  if (r.scope === 'always') return 'always'
  if (r.scope === 'session') return 'this session'
  if (r.scope === 'once') return 'once'
  return r.expiresAt ? `${left(r.expiresAt - now)} left` : 'timed'
}

/** How long a chip tap or a bare `/permit trust` switches a profile on. */
export function profileHours(p: PermitProfile): number {
  return p.maxHours ? Math.min(p.maxHours, 2) : 4
}

export function configLabel(row: PermitConfigRow): string {
  if (row.kind === 'boolean') return `${row.value ? '✓' : '○'} ${row.label}`
  if (row.kind === 'choice') return `${row.label}: ${String(row.value)} ▸`
  return `${row.label}: ${Array.isArray(row.value) ? row.value.join(', ') : String(row.value)}`
}

export function statusLine(s: PermitSnapshot): string | undefined {
  const parts: string[] = []
  const pending = s.blocks.filter(b => b.status === 'pending' && b.sessionId === s.sessionId).length
  if (pending) parts.push(`⛔ ${pending} blocked · /permit`)
  const waiting = s.floorRequests.filter(r => r.state === 'pending' && r.sessionId === s.sessionId).length
  if (waiting) parts.push(`⏳ ${waiting} waiting on your device`)
  for (const a of s.active) {
    const p = s.profiles.find(x => x.name === a.name)
    if (p) parts.push(`${p.icon} ${p.name}${a.until ? ` ${left(a.until - s.now)}` : ''}`)
  }
  return parts.length ? parts.join(' · ') : undefined
}

export function Section({ k, title, aside, children }: { k: Kit; title: string; aside?: string; children: RenderChildren }) {
  const { Box, Text } = k
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color="claude">{title}</Text>
        {aside ? <Text dimColor>{aside}</Text> : <Text> </Text>}
      </Box>
      {children}
    </Box>
  )
}

export function LogLines({ k, s, count }: { k: Kit; s: PermitSnapshot; count: number }) {
  const { Box, Text } = k
  const lines = s.log.slice(-count).reverse()
  if (lines.length === 0) return <Text dimColor>Nothing yet.</Text>
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Box key={`log:${i}`} gap={1}>
          {/* A column of its own: ⛔ and 🔑 are wider than ✓ and ■ in the desktop app's font. */}
          <Box width={2} flexShrink={0}>
            <Text color={l.kind === 'floor' || l.kind === 'blocked' ? 'error' : l.kind === 'allowed' ? 'success' : 'subtle'}>{LOG_ICON[l.kind]}</Text>
          </Box>
          <Box width={8} flexShrink={0}>
            <Text dimColor>{ago(s.now - l.at)}</Text>
          </Box>
          <Text wrap="truncate-end">{l.text}</Text>
        </Box>
      ))}
    </Box>
  )
}
