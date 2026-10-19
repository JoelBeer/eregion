import type { ReactElement } from 'react'
import type { CrewMember } from '@shared/runs'
import type { TicketCard } from '@shared/tickets'
import { href } from '../router'
import { Chip, SpeechBubble, StatusPill } from './ui'

export function BoardCard({ card, crew }: { card: TicketCard; crew: CrewMember | undefined }): ReactElement {
  const { ticket } = card
  const tone = card.pill?.status === 'needsYou' ? 'amber' : card.pill?.status === 'failed' || card.pill?.status === 'fixing' ? 'red' : ticket.stage === 'done' ? 'faded' : 'default'
  const repos = ticket.stage === 'backlog' ? [] : ticket.affectedRepos
  return (
    <article className={`er-card${tone !== 'default' ? ` er-card-${tone}` : ''}`} aria-label={`${ticket.key} ${ticket.title}`}>
      <div className="er-spread">
        <span className="er-key">{ticket.key}</span>
        {card.pill && <StatusPill status={card.pill.status}>{card.pill.label}</StatusPill>}
      </div>
      <a className="er-card-title" href={href({ name: 'ticket', projectId: ticket.projectId, ticketId: ticket.id, tab: 'conversation' })}>
        {ticket.title}
      </a>
      {(repos.length > 0 || card.tags.length > 0) && (
        <div className="er-row">
          {repos.map((repo) => (
            <Chip key={repo}>{repo}</Chip>
          ))}
          {card.tags.map((tag) => (
            <Chip key={tag} tone="info">
              {tag}
            </Chip>
          ))}
        </div>
      )}
      {card.bubble && (
        <SpeechBubble seed={crew?.seed} mood={card.mood}>
          {card.bubble}
        </SpeechBubble>
      )}
      {(ticket.slot !== null || card.links.length > 0) && (
        <div className="er-foot">
          {ticket.slot !== null && <span>Slot {ticket.slot}</span>}
          {card.links.map((link) => (
            <a key={link.url} href={link.url} onClick={(event) => {
              event.preventDefault()
              void window.eregion.openExternal(link.url)
            }} style={{ fontFamily: 'var(--font-mono)' }}>
              {link.label}
            </a>
          ))}
          {card.openUrl && (
            <a href={card.openUrl} style={{ marginLeft: 'auto' }} onClick={(event) => {
              event.preventDefault()
              void window.eregion.openExternal(card.openUrl as string)
            }}>
              Open app
            </a>
          )}
        </div>
      )}
    </article>
  )
}
