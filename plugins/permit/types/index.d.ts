export type PermitScope = 'once' | 'session' | 'timed' | 'always'

/** A grant: calls of `tool` whose subject matches `match` run without asking. */
export type PermitRule = {
  id: string
  /** Tool name glob: `Bash`, `mcp__github__*`, `*`. */
  tool: string
  /** Subject glob (a Bash command segment, a path, a URL); absent: the whole tool. */
  match?: string
  /** Exact subject (the whole Bash command): `once` grants carry this instead of `match`. */
  exact?: string
  scope: PermitScope
  expiresAt?: number
  sessionId?: string
  createdAt: number
  uses: number
  lastUsedAt?: number
  from: 'blocked' | 'command' | 'pane'
}

export type PermitPattern = { tool: string; match?: string }

export type PermitProfile = {
  name: string
  icon: string
  title: string
  blurb: string
  rules: PermitPattern[]
  /** Longest it may stay on, in hours; absent: no limit. */
  maxHours?: number
}

/** A profile in config.json: named like a built-in, its rules join that profile's. */
export type PermitLocalProfile = { name: string; rules: PermitPattern[]; icon?: string; title?: string; blurb?: string; maxHours?: number }

/**
 * config.json, beside data.json: this machine's own additions, written by
 * hand. Permit only reads it, and it can only add: protections and profiles.
 */
export type PermitLocalConfig = {
  /** More paths `rm -r` may never take, beside /, ~ and home folders. */
  protect?: string[]
  /** Apps and services that must keep running: never `systemctl stop`ped, `pkill`ed or `killall`ed (matched within the name, any case). */
  keepAlive?: string[]
  profiles?: PermitLocalProfile[]
  /** The VaultOS command secret_to_clipboard runs: `vaultos-agent` unless set. */
  vaultCommand?: string
  /**
   * The floor checks that may be let through with an approval, narrowed to
   * these (of `force-main`, `power`, `keep-alive`); `false` or `[]`: none.
   * Absent: all three. It can never make another check approvable.
   */
  floorApprovals?: string[]
}

/** A profile switched on; `until` 0 means until switched off. */
export type PermitActivation = { name: string; until: number; isDemo?: true }

export type PermitBlockStatus = 'pending' | 'allowed' | 'kept' | 'dismissed'

export type PermitBlock = {
  id: string
  at: number
  sessionId: string
  tool: string
  /** The whole subject (the Bash command), kept for an exact once-grant. */
  subject: string
  reason: string
  category: string
  suggestion: PermitPattern[]
  status: PermitBlockStatus
}

export type PermitLogKind = 'allowed' | 'floor' | 'approval' | 'blocked' | 'granted' | 'revoked' | 'profile' | 'secret'

export type PermitLogEntry = { at: number; kind: PermitLogKind; text: string; isDemo?: true }

/** A floor check; `isApprovable`: it may be let through once with an approval from the person's own device. */
export type PermitFloorCheck = { id: string; title: string; isApprovable?: boolean }

export type PermitFloorRequestState = 'pending' | 'approved' | 'denied' | 'expired' | 'withdrawn'

/**
 * A floor request this machine's approval service holds, as a session last
 * saw it. Only the service decides one: this copy just says what to watch.
 */
export type PermitFloorRequest = { id: string; sessionId: string; floor: string; subject: string; at: number; state: PermitFloorRequestState }

export type PermitSettingsRule = { rule: string; behavior: 'allow' | 'deny' | 'ask'; source: string }

export type PermitConfigRow = {
  key: string
  label: string
  kind: 'boolean' | 'choice' | 'text' | 'number'
  value: boolean | string | number | readonly string[]
  options?: readonly string[]
  isLocked: boolean
}

export type PermitTab = 'home' | 'rules' | 'profiles' | 'log' | 'config'

/** Everything the pane and the band draw, rebuilt whenever anything changes. */
export type PermitSnapshot = {
  now: number
  mode?: string
  sessionId: string
  rules: PermitRule[]
  profiles: PermitProfile[]
  active: PermitActivation[]
  blocks: PermitBlock[]
  log: PermitLogEntry[]
  floor: PermitFloorCheck[]
  floorRequests: PermitFloorRequest[]
  /** An approval service runs here, so the approvable floor checks can be let through. */
  hasApprover: boolean
  floorToday: number
  allowedToday: number
  settingsRules: PermitSettingsRule[]
  defaultMode?: string
  config: PermitConfigRow[]
}
