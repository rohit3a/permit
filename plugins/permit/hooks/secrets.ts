// secret_to_clipboard's tool definition and pure helpers. The steps that run
// processes live in register.tsx: a hooks module hands $ only to functions
// in its own file.

export const SECRET_TOOL = 'secret_to_clipboard'
export const SECRET_TOOL_FULL = `mcp__permit__${SECRET_TOOL}`

export type SecretInput = {
  source: 'vault' | 'vercel' | 'env-file'
  key: string
  project?: string
  dir?: string
  environment?: 'production' | 'preview' | 'development'
  file?: string
}

export const SECRET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['source', 'key'],
  properties: {
    source: { type: 'string', enum: ['vault', 'vercel', 'env-file'], description: 'Where the secret lives.' },
    key: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$', description: 'The variable name, e.g. API_TOKEN.' },
    project: { type: 'string', description: 'vault: the VaultOS project name, e.g. "my-app".' },
    dir: { type: 'string', description: 'vercel: an absolute path to a folder linked to the Vercel project (has .vercel/project.json).' },
    environment: { type: 'string', enum: ['production', 'preview', 'development'], description: 'vercel: which environment. Default production.' },
    file: { type: 'string', description: 'env-file: an absolute path to the .env file.' },
  },
} as const

export const SECRET_DESCRIPTION = [
  'Copy one secret (API key, token, password) onto the machine clipboard WITHOUT its value entering this conversation.',
  'Use this whenever a key has to be pasted into an app, a website field or a form: call it, then paste with the GUI (click the field, then paste).',
  'Never print, cat, echo or read secret values yourself; never read the clipboard back.',
  'Sources: vault (VaultOS project + key), vercel (a linked project folder + key + environment), env-file (a .env path + key).',
  'The clipboard is cleared automatically after a short time.',
].join(' ')

export const isKeyName = (key: unknown): key is string => typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)

export function describeSource(i: SecretInput): string {
  if (i.source === 'vault') return `VaultOS (${i.project ?? '?'})`
  if (i.source === 'vercel') return `Vercel ${i.environment ?? 'production'} (${(i.dir ?? '').split('/').filter(Boolean).pop() ?? '?'})`
  return `${(i.file ?? '').split('/').pop() ?? 'env file'}`
}

/** The value of `key` in dotenv text, or undefined; quotes and escapes handled. */
export function dotenvValue(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m || m[1] !== key) continue
    const raw = m[2]!.trim()
    if (raw.startsWith('"')) {
      try {
        return JSON.parse(raw.replace(/\s+#.*$/, '')) as string
      } catch {
        return raw.replace(/^"|"$/g, '')
      }
    }
    if (raw.startsWith("'")) return raw.replace(/^'|'\s*(?:#.*)?$/g, '')
    return raw.replace(/\s+#.*$/, '')
  }
  return undefined
}

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

/** Error text from the CLIs never carries values, but keep it to one short line anyway. */
export function firstLine(text: string): string {
  return (text.split('\n').find(l => l.trim()) ?? '').slice(0, 160)
}
