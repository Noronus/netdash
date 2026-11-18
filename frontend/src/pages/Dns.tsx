import React, { useState } from 'react'
import { Eye, EyeOff, ShieldCheck } from 'lucide-react'
import { Full, hideDomain } from '../api'
import { go, openDevice } from '../App'
import { Bars } from '../components/charts'
import DomainList from '../components/DomainList'
import AdguardSettings from '../components/AdguardSettings'
import { Badge, Card, DevIcon, SrcError } from '../components/ui'
import { clock, num, pct } from '../format'

export default function Dns({ full }: { full: Full }) {
  const ag = full.adguard
  const top = full.dns_top
  const [showHidden, setShowHidden] = useState(false)
  const [pattern, setPattern] = useState('')
  const [toast, setToast] = useState('')
  const say = (m: string) => { setToast(m); setTimeout(() => setToast(''), 5000) }
  if (!ag) return <Card title="AdGuard"><SrcError src={full.sources.adguard} label="AdGuard" /></Card>
  const now = Math.floor(Date.now() / 3600000) * 3600
  const hours = ag.series_q.map((q, i) => ({ label: clock(now - (ag.series_q.length - 1 - i) * 3600), a: q, b: ag.series_b[i] || 0 }))
  const byMac = new Map(full.devices.map((d) => [d.mac, d]))
  const byIp = new Map<string, typeof full.devices[number]>()
  for (const d of full.devices) for (const ip of [...d.ipv4, ...d.ipv6]) byIp.set(ip, d)
  const hidden = top?.hidden || []
  return (
    <>
      <div className="grid">
        <Card className="c3" title="Anfragen (24 Std)"><div className="kpi"><div className="v">{num(ag.queries)}</div><div className="s">{top ? num(top.unique) + ' verschiedene Domains' : ''}</div></div></Card>
        <Card className="c3" title="Blockiert"><div className="kpi"><div className="v" style={{ color: 'var(--bad)' }}>{num(ag.blocked)}<small>{pct((100 * ag.blocked) / Math.max(ag.queries, 1), 1)}</small></div></div></Card>
        <Card className="c3" title="Antwortzeit"><div className="kpi"><div className="v">{ag.avg_ms}<small>ms Ø</small></div></div></Card>
        <Card className="c3" title="Schutz" act={<Badge t={ag.protection ? 'ok' : 'warn'}>{ag.protection ? 'aktiv' : 'aus'}</Badge>}><div className="kpi"><div className="v" style={{ fontSize: 18 }}>AdGuard {ag.version}</div></div></Card>
      </div>
      <Card title="Anfragen pro Stunde" icon={<ShieldCheck size={16} />} act={<div className="legend"><span><i style={{ background: 'var(--violet)' }} />Anfragen</span><span><i style={{ background: 'var(--bad)' }} />Blockiert</span></div>}>
        <Bars h={180} fmt={num} data={hours} a={{ color: 'var(--violet)', label: 'Anfragen' }} b={{ color: 'var(--bad)', label: 'Blockiert' }} />
      </Card>
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn sm" onClick={() => setShowHidden(!showHidden)}>
          {showHidden ? <Eye size={14} /> : <EyeOff size={14} />} Ausgeblendete Domains ({hidden.length})
        </button>
        <span className="dim" style={{ fontSize: 12.5 }}>Ausblenden entfernt eine Domain nur aus den Listen hier, gezählt wird sie weiter.</span>
      </div>
      {showHidden && (
        <Card title="Ausgeblendet">
          <div className="row wrap" style={{ gap: 6, marginBottom: 12 }}>
            {hidden.map((h) => (
              <span key={h} className="chip">{h}<button title="Wieder anzeigen" onClick={() => hideDomain(h, false)}>✕</button></span>
            ))}
            {!hidden.length && <span className="dim">Noch nichts ausgeblendet. Fahr über eine Domain und klick auf das Augen-Symbol.</span>}
          </div>
          <form className="row" onSubmit={async (e) => { e.preventDefault(); if (pattern.trim()) { await hideDomain(pattern.trim()); setPattern('') } }}>
            <input className="input grow mono" placeholder="domain.tld oder *.domain.tld (alle Subdomains)" value={pattern} onChange={(e) => setPattern(e.target.value)} />
            <button className="btn">Ausblenden</button>
          </form>
        </Card>
      )}
      <div className="grid">
        <Card className="c4" title="Top-Domains" flush><DomainList rows={(top?.domains || []).slice(0, 20)} onChanged={say} /></Card>
        <Card className="c4" title="Top blockiert" flush><DomainList rows={(top?.blocked || []).slice(0, 20)} bad onChanged={say} /></Card>
        <Card className="c4" title="Top-Clients" flush>
          <div className="list">{(top?.clients || []).slice(0, 20).map(([key, n, b]) => {
            const d = key.startsWith('ip:') ? byIp.get(key.slice(3)) : byMac.get(key)
            const label = d?.name || (key.startsWith('ip:') ? key.slice(3) : key)
            return (
              <div key={key} className={'li' + (d ? ' click' : '')} onClick={() => d && openDevice(d.mac)}>
                {d && <DevIcon icon={d.icon || d.icon_auto} on={d.online} size={15} />}
                <div className="col grow" style={{ gap: 0 }}><b className="ell">{label}</b>{d && <span className="dim mono" style={{ fontSize: 11.5 }}>{d.ip}</span>}</div>
                <span className="num dim">{num(n)}</span>
                {b > 0 && <span className="num" style={{ color: 'var(--bad)', fontSize: 12, width: 48, textAlign: 'right' }}>{num(b)}</span>}
              </div>
            )
          })}</div>
        </Card>
      </div>
      <AdguardSettings toast={say} />
      {toast && <div className="toast">{toast}</div>}
    </>
  )
}
