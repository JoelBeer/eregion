import type { AdapterId } from './agent'
import type { CrewMember } from './runs'

/** A Forge chat: one-off questions to a crew member, or to a Visitor on any model. */
export interface Chat {
  id: number
  projectId: number
  title: string
  /** Null for a Visitor. */
  crewId: number | null
  adapter: AdapterId
  model: string
  /** Repos the chat can read, as a read-only plan checkout. */
  repoIds: number[]
  /** The ticket the chat asks about (sent from the ticket screen): it reads that ticket's work. */
  ticketId: number | null
  createdAt: string
  updatedAt: string
  costUsd: number
  tokens: number
  runIds: number[]
}

export interface NewChat {
  crewId: number | null
  adapter: AdapterId
  model: string
  repoIds: number[]
}

/** The Visitor: a guest with no profile, on whichever model you pick. Its runs have no crew record. */
export function visitor(adapter: AdapterId, model: string): CrewMember {
  return { id: 0, name: 'Visitor', role: 'Forge only', adapter, model, seed: 0x5eed }
}

/** A chat's title from its first message: the first line, cut at 60 characters. */
export function chatTitle(text: string): string {
  const line = text.trim().split('\n')[0].trim()
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line || 'New chat'
}

/** "Today", "Yesterday" or the date, for grouping chats by day. */
export function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(`${iso.replace(' ', 'T')}${iso.endsWith('Z') ? '' : 'Z'}`)
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(date.toDateString()).getTime()) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return date.toLocaleDateString([], { weekday: days < 7 ? 'long' : undefined, day: 'numeric', month: 'short' })
}
