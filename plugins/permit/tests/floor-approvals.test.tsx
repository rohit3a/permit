import { expect, mock, test } from 'claude-code/testing'

import { isRootListener } from '../hooks/approvals'
import { floorHits } from '../hooks/rules'

const DATA = '/home/test/.claude/permit/data.json'
const CONFIG = '/home/test/.claude/permit/config.json'
const SERVICE = 'http://127.0.0.1:47800'
const PUSH = 'git push --force origin main'

/** /proc/net/tcp with 127.0.0.1:47800 listening, owned by `uid`. */
const sockets = (uid: number) =>
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n' +
  `   0: 0100007F:BAB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  ${uid}        0 35290 1 0000000000000000 100 0 0 10 0\n`

type Request = { id: string; key: string; state: string; used: boolean; note: string }

// The session beneath Permit, and an approval service that holds and decides
// floor requests as the real one does: the same command, directory and
// session find their live request; an approval is spent on one run.
function world(on: any, { uid = 0, disk = new Map<string, string>(), branch = 'feature' } = {}) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/test' })
  disk.set('/proc/net/tcp', sockets(uid))
  on('fs.read', (_$: unknown, e: { path: string }) => (disk.has(e.path) ? { value: disk.get(e.path) } : { deny: `ENOENT: ${e.path}` }))
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: disk.has(e.path) }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => {
    disk.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', (_$: unknown, e: { argv: string[] }) => {
    const [cmd, ...args] = e.argv
    const paths = args.filter(a => !a.startsWith('-'))
    if (cmd === 'mv' && disk.has(paths[0]!)) {
      disk.set(paths[1]!, disk.get(paths[0]!)!)
      disk.delete(paths[0]!)
    } else if (cmd === 'rm') paths.forEach(x => disk.delete(x))
    else if (cmd === 'git' && args.includes('rev-parse')) return { value: { exitCode: 0, stdout: `${branch}\n`, stderr: '' } }
    else return { value: { exitCode: 127, stdout: '', stderr: `${cmd}: not here` } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  const prompts: string[] = []
  on('prompt.submit', (_$: unknown, e: { text: string }) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  for (const [event, answer] of [
    ['session.id', { value: 'test-session' }], ['session.cwd', { value: '/home/test/app' }], ['session.start', { cwd: '/home/test/app' }],
    ['command.register', { value: { command: 'permit' } }], ['tool.register', { value: {} }], ['ui.open', { value: { isPlaced: true } }],
    ['config.list', { value: [] }], ['settings.read', { value: {} }], ['ui.status', { value: null }], ['ui.toast', { value: null }],
  ] as const) on(event as never, (() => answer) as never)

  const requests: Request[] = []
  const reply = (status: number, payload: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(payload) } })
  const view = (r: Request) => ({ id: r.id, state: r.state, used: r.used, note: r.note })
  on('http.fetch', (_$: unknown, e: { url: string; init?: { method?: string; body?: string; headers?: Record<string, string> } }) => {
    if (!e.url.startsWith(SERVICE)) return reply(404, {})
    const path = e.url.slice(SERVICE.length)
    if (path === '/v1/permit/requests' && e.init?.method === 'POST') {
      if (e.init.headers?.['Content-Type'] !== 'application/json') return reply(403, {})
      const b = JSON.parse(e.init.body ?? '{}')
      const key = JSON.stringify([b.floor, b.command, b.cwd, b.session])
      const live = requests.find(r => r.key === key && (r.state === 'pending' || r.state === 'denied' || (r.state === 'approved' && !r.used)))
      if (live) return reply(200, view(live))
      const r = { id: (requests.length + 1).toString(16).padStart(8, 'a'), key, state: 'pending', used: false, note: '' }
      requests.push(r)
      return reply(200, view(r))
    }
    const use = /^\/v1\/permit\/requests\/([0-9a-f]{8})\/use$/.exec(path)
    const r = requests.find(x => x.id === (use?.[1] ?? /^\/v1\/permit\/requests\/([0-9a-f]{8})$/.exec(path)?.[1]))
    if (!r) return reply(404, {})
    if (!use) return reply(200, view(r))
    if (r.state !== 'approved' || r.used) return reply(409, view(r))
    r.used = true
    return reply(200, { ok: true, ...view(r) })
  })
  /** What only the person's own device can do. */
  const decide = (id: string, state: 'approved' | 'denied', note = '') => {
    const r = requests.find(x => x.id === id)!
    r.state = state
    r.note = note
  }
  return { disk, clock, prompts, requests, decide }
}

/** A call the model makes, as a session checks it: with its tool_use_id. */
const call = ($: any, command: string, id = 'toolu_1') => $.tool.check({ tool: 'Bash', input: { command }, tool_use_id: id } as never)

test('a floor action waits for the person, once per exact command', async ($, on) => {
  const w = world(on)
  on('tool.check', () => ({ decision: 'allow' as const }))
  await $.session.start({ source: 'startup', cwd: '/home/test/app' } as never)

  const first = await call($, PUSH)
  expect(first.decision).toBe('deny')
  expect(first.reason).toContain(`Request ${w.requests[0]!.id} for this exact command is waiting`)
  expect((await call($, PUSH, 'toolu_2')).reason).toContain(w.requests[0]!.id)
  expect(w.requests.length).toBe(1)
  const saved = JSON.parse(w.disk.get(DATA)!)
  expect(saved.floorRequests).toEqual([expect.objectContaining({ id: w.requests[0]!.id, subject: PUSH, state: 'pending' })])

  // a query (no tool_use_id) is refused without asking anyone
  const query = await $.tool.check({ tool: 'Bash', input: { command: 'git push -f origin master' } })
  expect(query.reason).toContain('never allowed here')
  expect(w.requests.length).toBe(1)
})

test('an approval lets that exact command through once, and Permit says when to run it', async ($, on) => {
  const w = world(on)
  on('tool.check', () => ({ decision: 'ask' as const }))
  await $.session.start({ source: 'startup', cwd: '/home/test/app' } as never)
  await call($, PUSH)
  const id = w.requests[0]!.id

  await w.clock.advance(5_000)
  expect(w.prompts).toEqual([])
  w.decide(id, 'approved')
  await w.clock.advance(5_000)
  expect(w.prompts).toEqual([expect.stringContaining(`I approved floor request ${id}`)])

  const run = await call($, PUSH, 'toolu_2')
  expect(run.decision).toBe('allow')
  expect(run.reason).toContain(id)
  expect(w.requests[0]!.used).toBe(true)
  // spent: the same command again needs a new approval, and no second nudge comes
  const again = await call($, PUSH, 'toolu_3')
  expect(again.decision).toBe('deny')
  expect(again.reason).toContain(`Request ${w.requests[1]!.id}`)
  await w.clock.advance(5_000)
  expect(w.prompts.length).toBe(1)
})

test('rewording the command, or claims of approval anywhere Permit can be written, lift nothing', async ($, on) => {
  const w = world(on)
  on('tool.check', () => ({ decision: 'allow' as const }))
  await $.session.start({ source: 'startup', cwd: '/home/test/app' } as never)
  await call($, PUSH)
  w.decide(w.requests[0]!.id, 'approved')

  for (const reworded of ['git push -f origin main', 'git -C . push --force origin main', 'sudo -u test git push --force origin main']) {
    const verdict = await call($, reworded)
    expect(verdict.decision).toBe('deny')
    expect(verdict.reason).not.toContain(w.requests[0]!.id)
  }
  expect(w.requests[0]!.used).toBe(false)

  // data.json saying approved, config.json widening the list: neither is asked
  const saved = JSON.parse(w.disk.get(DATA)!)
  saved.floorRequests = saved.floorRequests.map((r: object) => ({ ...r, state: 'approved' }))
  w.disk.set(DATA, JSON.stringify(saved))
  w.disk.set(CONFIG, JSON.stringify({ floorApprovals: ['force-main', 'secret-print', 'wipe'] }))
  await w.clock.advance(30_000)
  const secret = await call($, 'cat .env')
  expect(secret.reason).toContain('never allowed here')
  expect(w.requests.every(r => !r.key.includes('.env'))).toBe(true)
  // a never-approvable check in the same command keeps the whole command refused
  const mixed = await call($, `${PUSH} && rm -rf ~`)
  expect(mixed.reason).toContain('never allowed here')
})

test('a denial is passed on, and the same command stays refused', async ($, on) => {
  const w = world(on)
  on('tool.check', () => ({ decision: 'allow' as const }))
  await $.session.start({ source: 'startup', cwd: '/home/test/app' } as never)
  await call($, PUSH)
  w.decide(w.requests[0]!.id, 'denied', 'push to a branch')
  await w.clock.advance(5_000)
  expect(w.prompts).toEqual([expect.stringContaining('I denied floor request')])
  const verdict = await call($, PUSH, 'toolu_2')
  expect(verdict.decision).toBe('deny')
  expect(verdict.reason).toContain('The user denied request')
  expect(verdict.reason).toContain('push to a branch')
})

test('an approval never outranks a settings deny, and is not spent on one', async ($, on) => {
  const w = world(on)
  on('tool.check', () => ({ decision: 'deny' as const, reason: 'Bash(git push:*) is denied in settings' }))
  await $.session.start({ source: 'startup', cwd: '/home/test/app' } as never)
  await call($, PUSH)
  w.decide(w.requests[0]!.id, 'approved')
  const verdict = await call($, PUSH, 'toolu_2')
  expect(verdict.reason).toBe('Bash(git push:*) is denied in settings')
  expect(w.requests[0]!.used).toBe(false)
})

test('without a root approval service, or with approvals narrowed off, the floor is final', async ($, on) => {
  // something of the session's own user listening where the service should be
  const w = world(on, { uid: 1000 })
  on('tool.check', () => ({ decision: 'allow' as const }))
  await $.session.start({ source: 'startup', cwd: '/home/test/app' } as never)
  expect((await call($, PUSH)).reason).toContain('never allowed here')
  expect((await $.command.run({ command: 'permit', args: 'floor' } as never)).text).toContain('No approval service runs here')

  w.disk.set('/proc/net/tcp', sockets(0))
  w.disk.set(CONFIG, JSON.stringify({ floorApprovals: false }))
  await w.clock.advance(30_000)
  expect((await call($, PUSH)).reason).toContain('never allowed here')
  expect(w.requests).toEqual([])
  const floor = (await $.command.run({ command: 'permit', args: 'floor' } as never)).text
  expect(floor).toContain('An approval service runs here')
  expect(floor).not.toContain('(approvable)')
})

test('a bare force push is judged by the branch checked out', async ($, on) => {
  world(on, { branch: 'main' })
  on('tool.check', () => ({ decision: 'allow' as const }))
  await $.session.start({ source: 'startup', cwd: '/home/test/app' } as never)
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'git push -f' } })).decision).toBe('deny')
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'git push -f origin feature' } })).decision).toBe('allow')
})

test('the floor sees through rewordings, and lets a reboot by', () => {
  const ids = (command: string, branch?: string) =>
    floorHits('Bash', { command }, false, {}, new Map(branch ? [['', branch]] : [])).map(h => h.id)
  for (const command of [
    'git -C ~/app push --force origin main', 'git push -f origin feature:main', 'git push origin +HEAD:refs/heads/master',
    'sudo -u test git push -f origin main', 'env GIT_TRACE=1 git push -f origin main', "bash -lc 'git push -f origin main'",
    'timeout 60 git push --force-with-lease origin main', '/usr/bin/git push -uf origin master', 'git push --mirror', 'git push --all --force',
  ]) expect(ids(command)).toEqual(['force-main'])
  expect(ids('git push -f', 'main')).toEqual(['force-main'])
  expect(ids('git push -f', 'feature')).toEqual([])
  expect(ids('git push -f origin feature')).toEqual([])
  expect(ids('git push -u origin main')).toEqual([])
  expect(ids('shutdown -r now')).toEqual([])
  expect(ids('sudo poweroff')).toEqual(['power'])
  expect(ids('sudo cat .env.local')).toEqual(['secret-print'])
  // the one never let through comes first
  expect(ids(`${PUSH}; cat .env`)).toEqual(['secret-print', 'force-main'])
})

test('only root listening on the service address counts', () => {
  expect(isRootListener(sockets(0))).toBe(true)
  expect(isRootListener(sockets(1000))).toBe(false)
  expect(isRootListener(sockets(0).replace('0100007F:BAB8', '0100007F:BAB9'))).toBe(false)
  expect(isRootListener('')).toBe(false)
})
