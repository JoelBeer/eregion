import type { ReactElement, ReactNode } from 'react'

/** Bold and inline code inside a line. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return <code key={index} className="mono">{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>
    return part
  })
}

/**
 * A small markdown renderer for the files agents write (plan.md, build-notes.md, PR descriptions):
 * headings, lists, checkboxes, code blocks and paragraphs. Text is never rendered as HTML.
 */
export function Markdown({ source }: { source: string }): ReactElement {
  const blocks: ReactElement[] = []
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.startsWith('```')) {
      const code: string[] = []
      index++
      while (index < lines.length && !lines[index].startsWith('```')) code.push(lines[index++])
      index++
      blocks.push(
        <pre key={blocks.length} className="mono" style={{ background: 'var(--surface-25, #F7F8FB)', padding: '10px 12px', borderRadius: 8, overflowX: 'auto', margin: 0 }}>
          {code.join('\n')}
        </pre>
      )
      continue
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/)
    if (heading) {
      const size = { 1: 19, 2: 15, 3: 14 }[heading[1].length as 1 | 2 | 3]
      blocks.push(
        <div key={blocks.length} role="heading" aria-level={heading[1].length} style={{ fontFamily: heading[1].length === 1 ? 'var(--font-display)' : undefined, fontSize: size, fontWeight: 600, marginTop: heading[1].length > 1 ? 6 : 0 }}>
          {inline(heading[2])}
        </div>
      )
      index++
      continue
    }
    if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line)
      const items: ReactElement[] = []
      while (index < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[index])) {
        const text = lines[index].replace(/^\s*([-*]|\d+[.)])\s+/, '')
        const check = text.match(/^\[([ xX])\]\s+(.*)$/)
        items.push(
          <li key={items.length} style={check ? { listStyle: 'none', marginLeft: -18 } : undefined}>
            {check ? (
              <span style={{ display: 'inline-flex', gap: 8, alignItems: 'baseline' }}>
                <span aria-label={check[1] === ' ' ? 'Open' : 'Answered'} style={{ color: check[1] === ' ' ? 'var(--amber-800, #92400E)' : 'var(--primary-600)' }}>
                  {check[1] === ' ' ? '○' : '✓'}
                </span>
                <span style={{ textDecoration: check[1] === ' ' ? undefined : 'none' }}>{inline(check[2])}</span>
              </span>
            ) : (
              inline(text)
            )}
          </li>
        )
        index++
      }
      blocks.push(ordered ? <ol key={blocks.length} style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>{items}</ol> : <ul key={blocks.length} style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>{items}</ul>)
      continue
    }
    if (line.trim()) {
      const paragraph: string[] = []
      while (index < lines.length && lines[index].trim() && !/^(#{1,3}\s|```|\s*([-*]|\d+[.)])\s)/.test(lines[index])) paragraph.push(lines[index++])
      blocks.push(
        <p key={blocks.length} style={{ margin: 0 }}>
          {inline(paragraph.join(' '))}
        </p>
      )
      continue
    }
    index++
  }
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 14, lineHeight: 1.55 }}>{blocks}</div>
}
