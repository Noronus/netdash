import React, { useState } from 'react'
import { Ban, CircleCheck, EyeOff } from 'lucide-react'
import { api, hideDomain } from '../api'
import { num } from '../format'

/** list of [domain, count] rows with hide / block / allow buttons per row */
export default function DomainList({ rows, bad, empty = 'Keine Einträge', onHidden, onChanged }: {
  rows: [string, number][]; bad?: boolean; empty?: string; onHidden?: () => void; onChanged?: (msg: string) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  if (!rows.length) return <div className="empty">{empty}</div>
  const rule = async (d: string, action: 'block' | 'allow') => {
    if (action === 'block' && !confirm(`${d} für alle Geräte sperren?`)) return
    setBusy(d)
    try { await api('/api/adguard/domain', { method: 'POST', body: JSON.stringify({ domain: d, action }) }); onChanged?.(`${d} ${action === 'block' ? 'gesperrt' : 'erlaubt'}`) }
    catch (e: any) { onChanged?.('Fehler: ' + e.message) } finally { setBusy(null) }
  }
  return (
    <div className="list">
      {rows.map(([d, n]) => (
        <div key={d} className="li dom-row">
          <span className="mono ell grow" style={{ color: bad ? 'var(--bad)' : undefined }} title={d}>{d}</span>
          <span className="num dim">{num(n)}</span>
          {bad
            ? <button className="icon-btn hide-btn" title="erlauben (Ausnahme in AdGuard)" disabled={busy === d} onClick={() => rule(d, 'allow')}><CircleCheck size={14} /></button>
            : <button className="icon-btn hide-btn" title="für alle sperren (AdGuard)" disabled={busy === d} onClick={() => rule(d, 'block')}><Ban size={14} /></button>}
          <button className="icon-btn hide-btn" title="in Listen ausblenden" disabled={busy === d}
            onClick={async () => { setBusy(d); try { await hideDomain(d); onHidden?.() } finally { setBusy(null) } }}>
            <EyeOff size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
