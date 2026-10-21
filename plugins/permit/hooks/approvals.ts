// Letting one floor action through: the pure half. The person approves the
// exact command on a device of their own, through an approval service on this
// machine that runs as root, so nothing a session can write decides it: not
// data.json, not config.json, not a line in the chat. Permit only asks the
// service, and spends an approval on the one run it allows. The steps that
// call the service live in register.tsx.

import type { PermitFloorCheck, PermitFloorRequest, PermitFloorRequestState } from '../types'
import { short } from './rules'

export const APPROVER = 'http://127.0.0.1:47800'
const APPROVER_SOCKET = `0100007F:${(47800).toString(16).toUpperCase()}`
const LISTEN = '0A'

/**
 * Whether /proc/net/tcp shows the approval service's address listening as
 * root. A process of the session's own user could listen there only while the
 * service is down, and then this says no.
 */
export function isRootListener(procNetTcp: string): boolean {
  return procNetTcp.split('\n').slice(1).some(line => {
    const [, local, , state, , , , uid] = line.trim().split(/\s+/)
    return local === APPROVER_SOCKET && state === LISTEN && uid === '0'
  })
}

export type FloorReply = { id: string; state: PermitFloorRequestState; used: boolean; note: string }

const STATES: readonly string[] = ['pending', 'approved', 'denied', 'expired', 'withdrawn']

/** The service's answer about one request, or undefined when it is not one. */
export function toFloorReply(text: string): FloorReply | undefined {
  try {
    const r = JSON.parse(text) as Record<string, unknown>
    if (typeof r.id !== 'string' || !/^[0-9a-f]{8}$/.test(r.id) || typeof r.state !== 'string' || !STATES.includes(r.state)) return undefined
    return { id: r.id, state: r.state as PermitFloorRequestState, used: r.used === true, note: typeof r.note === 'string' ? short(r.note, 300) : '' }
  } catch {
    return undefined
  }
}

/** What a request asks for: the first check's id, every check's title, the exact command. */
export function requestBody(hits: PermitFloorCheck[], command: string, cwd: string, session: string, isSubagent: boolean) {
  return {
    floor: hits[0]!.id,
    title: hits.map(h => h.title).join('; ').slice(0, 300),
    command,
    cwd,
    session,
    agent: isSubagent ? 'Claude (subagent)' : 'Claude',
  }
}

const titles = (hits: PermitFloorCheck[]) => hits.map(h => h.title).join('; ')

export const flatRefusal = (hit: PermitFloorCheck) =>
  `Permit hard floor: ${hit.title}. This is never allowed here; do it another way or tell the user what you needed.`

export const pendingRefusal = (hits: PermitFloorCheck[], id: string) =>
  `Permit hard floor: ${titles(hits)}. Request ${id} for this exact command is waiting for the user's approval on their own device. Do not reword it or try another way: Permit tells you here when they decide, and then you run the exact same command again. Meanwhile carry on with other work, or tell the user what is waiting.`

export const deniedRefusal = (hits: PermitFloorCheck[], r: FloorReply) =>
  `Permit hard floor: ${titles(hits)}. The user denied request ${r.id}${r.note ? `: ${r.note}` : ''}. Do not retry or reword it; do it another way or ask the user.`

/** The turn Permit queues once a request is decided; Permit never reads it back. */
export function decidedPrompt(r: PermitFloorRequest, reply: FloorReply): string | undefined {
  const what = `(${short(r.subject, 120)})`
  // A retry can beat this turn to the approval; one that already ran must not run twice.
  if (reply.state === 'approved') return `Permit: I approved floor request ${r.id} ${what}. Unless it already ran since you were refused, run that exact command again, unchanged, and carry on.`
  if (reply.state === 'denied') return `Permit: I denied floor request ${r.id} ${what}${reply.note ? `: ${reply.note}` : ''}. Do not run it; do it another way or ask me.`
  return undefined
}
