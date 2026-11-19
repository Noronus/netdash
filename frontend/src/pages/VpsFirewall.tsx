import React, { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Lock, Pencil, Plus, ShieldAlert, ShieldHalf, Trash2, X } from 'lucide-react'
import { api, Full, refreshState } from '../api'
import { Badge, Card, SrcError } from '../components/ui'
import { ago, bytes, num } from '../format'

// firewall on the VPS (extras/vps/netdash-vps, chain NETDASH-FW): own rules + fixed and automatic ones from the helper
type Proto = 'tcp' | 'udp' | 'tcpudp' | 'icmp' | 'any'
type URule = { id: string; action: 'accept' | 'drop'; proto: Proto; port: string; source: string; family: 'both' | '4' | '6'; comment: string; enabled: boolean }
type Cfg = { enabled: boolean; ping: boolean; auto: { wg: boolean; forwards: boolean; docker: boolean }; rules: URule[] }
type Eff = { id: string; src: string; action: string; proto: string; port?: string; source?: string; family?: string; comment: string; enabled?: boolean; packets?: number | null; bytes?: number | null }
type Lst = { proto: string; port: number; process: string; state: 'open' | 'limited' | 'blocked'; why: string }
type Fw = { config: Cfg; effective: Eff[]; listeners: Lst[]; pending: boolean; timer: string; active: boolean; wan_if: string; wan_ip: string; file: string }

const SRC: Record<string, string> = { fixed: 'fest', user: 'eigene', wg: 'WireGuard', forward: 'Portfreigabe', docker: 'Docker' }
const PROTO: Record<string, string> = { tcp: 'TCP', udp: 'UDP', tcpudp: 'TCP+UDP', icmp: 'ICMP', ping: 'Ping', any: 'alle' }
const famLabel = (f?: string) => (f === '4' ? ' v4' : f === '6' ? ' v6' : '')

export default function VpsFirewall({ full }: { full: Full }) {
  const v = full.vps as any
  const fw: Fw | undefined = v?.fw
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [toast, setToast] = useState('')
  const [edit, setEdit] = useState<{ r: URule | null; idx: number } | null>(null)
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(''), 6000); return () => clearTimeout(t) } }, [toast])

  if (!v) return <Card title="Firewall-VPS"><SrcError src={full.sources.vps} label="VPS" /></Card>
  if (!fw) return (
    <Card title="Firewall-VPS" icon={<ShieldHalf size={16} />}>
      <div className="err">{v.fw_error || 'Der Helfer auf dem VPS kennt die Firewall noch nicht (netdash-vps aktualisieren, siehe extras/vps).'}</div>
    </Card>
  )
  const cfg = fw.config

  async function push(next: Cfg, msg: string) {
    setBusy(true); setErr('')
    try {
      await api('/api/vps/firewall', { method: 'POST', body: JSON.stringify({ config: next }) })
      await refreshState()
      setToast(msg); setEdit(null)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const setRules = (rules: URule[], msg: string) => push({ ...cfg, rules }, msg)
  const move = (i: number, d: number) => {
    const j = i + d
    if (j < 0 || j >= cfg.rules.length) return
    const r = [...cfg.rules]; [r[i], r[j]] = [r[j], r[i]]
    setRules(r, 'Reihenfolge geändert.')
  }
  const dropped = fw.effective.find((r) => r.id === 'default')
  const open = fw.listeners.filter((l) => l.state !== 'blocked')
  const userIdx = new Map(cfg.rules.map((r, i) => [r.id, i]))

  return (
    <>
      <div className="grid">
        <Card className="c3" title="Status" icon={<ShieldHalf size={16} />}>
          <div className="row" style={{ gap: 10 }}>
            <button className={'switch' + (cfg.enabled ? ' on' : '')} disabled={busy}
              onClick={() => (cfg.enabled ? confirm('Firewall auf dem VPS ausschalten? Dann ist alles erreichbar, was dort lauscht (nur noch die IONOS-Firewall davor).') : true)
                && push({ ...cfg, enabled: !cfg.enabled }, cfg.enabled ? 'Firewall ausgeschaltet.' : 'Firewall eingeschaltet und bestätigt.')}><i /></button>
            <div className="col" style={{ gap: 0 }}>
              <b>{cfg.enabled ? 'aktiv' : 'aus'}</b>
              <span className="dim" style={{ fontSize: 12 }}>{fw.wan_if} · {fw.wan_ip}</span>
            </div>
          </div>
        </Card>
        <Card className="c3" title="Eigene Regeln"><div className="kpi"><div className="v">{cfg.rules.filter((r) => r.enabled).length}<small>/ {cfg.rules.length} aktiv</small></div><div className="s">{fw.effective.filter((r) => ['wg', 'forward', 'docker'].includes(r.src)).length} automatische</div></div></Card>
        <Card className="c3" title="Von außen offen"><div className="kpi"><div className="v">{open.length}<small>/ {fw.listeners.length} Ports</small></div><div className="s">die auf dem VPS lauschen</div></div></Card>
        <Card className="c3" title="Verworfen" icon={<ShieldAlert size={16} />}><div className="kpi"><div className="v" style={{ color: cfg.enabled ? 'var(--bad)' : undefined }}>{dropped?.packets != null && cfg.enabled ? num(dropped.packets) : '–'}</div><div className="s">Pakete seit dem letzten Laden der Regeln</div></div></Card>
      </div>

      {fw.pending && <div className="banner acc"><b>Änderung wird geprüft …</b><span className="dim grow">Ohne Bestätigung nimmt der VPS sie nach 60 s selbst zurück.</span></div>}
      {err && <div className="err">{err}</div>}

      <Card title="Regeln (von oben nach unten, die erste passende gilt)" icon={<ShieldHalf size={16} />} flush
        act={<button className="btn sm primary" disabled={busy} onClick={() => setEdit({ r: null, idx: -1 })}><Plus size={14} />Neue Regel</button>}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th style={{ width: 54 }}></th><th>Aktion</th><th>Richtung</th><th>Protokoll</th><th>Port</th><th>Quelle</th><th>Beschreibung</th><th>Herkunft</th><th className="r">Treffer</th><th></th></tr></thead>
            <tbody>
              <tr style={{ cursor: 'default' }} title="Verbindungen, die der VPS selbst aufbaut (Updates, DNS, NetBird, Tunnel ins Heimnetz), werden nicht gefiltert">
                <td><Lock size={13} className="dim" /></td>
                <td><Badge t="ok">Erlauben</Badge></td>
                <td><span className="badge">out</span></td>
                <td><span className="dim">alle</span></td><td className="mono"><span className="dim">alle</span></td><td className="mono"><span className="dim">alle</span></td>
                <td>ausgehender Verkehr vom VPS (wird nicht gefiltert)</td>
                <td><span className="badge">fest</span></td><td className="r num dim">–</td><td></td>
              </tr>
              {fw.effective.map((r) => {
                const ui = userIdx.get(r.id)
                const own = r.src === 'user' && ui !== undefined
                const u = own ? cfg.rules[ui!] : null
                const on = r.enabled !== false && (r.id !== 'default' || cfg.enabled)
                return (
                  <tr key={r.src + r.id} className={on ? '' : 'off'} style={own ? undefined : { cursor: 'default' }} onClick={() => own && setEdit({ r: u, idx: ui! })}>
                    <td onClick={(e) => e.stopPropagation()}>
                      {own ? <button className={'switch' + (u!.enabled ? ' on' : '')} disabled={busy} title={u!.enabled ? 'deaktivieren' : 'aktivieren'}
                        onClick={() => setRules(cfg.rules.map((x, j) => (j === ui ? { ...x, enabled: !x.enabled } : x)), `Regel ${u!.enabled ? 'deaktiviert' : 'aktiviert'}.`)}><i /></button>
                        : <Lock size={13} className="dim" />}
                    </td>
                    <td><Badge t={!on ? undefined : r.action === 'accept' ? 'ok' : 'bad'}>{r.action === 'accept' ? 'Erlauben' : 'Verwerfen'}</Badge></td>
                    <td>{r.id === 'est'
                      ? <span className="badge" title="Pakete, die zu einer schon erlaubten Verbindung gehören (conntrack ESTABLISHED/RELATED): Antworten auf ausgehende Verbindungen und auf eingehende, die eine Regel unten erlaubt hat. Neue Verbindungen lässt diese Regel nie herein.">reply</span>
                      : <span className="badge">in</span>}</td>
                    <td>{PROTO[r.proto] || r.proto}<span className="dim">{famLabel(r.family)}</span></td>
                    <td className="mono">{r.port || <span className="dim">alle</span>}</td>
                    <td className="mono">{r.source || <span className="dim">alle</span>}</td>
                    <td className="ell" style={{ maxWidth: 340 }} title={r.comment}>{r.comment || <span className="dim">–</span>}</td>
                    <td><span className={'badge' + (r.src === 'user' ? ' acc' : '')}>{SRC[r.src] || r.src}</span></td>
                    <td className="r num dim" title={r.bytes != null ? bytes(r.bytes) : ''}>{r.packets ? num(r.packets) : '–'}</td>
                    <td className="r" onClick={(e) => e.stopPropagation()}>
                      {own && (
                        <div className="row" style={{ gap: 0, justifyContent: 'flex-end' }}>
                          <button className="icon-btn" style={{ width: 26, height: 26 }} disabled={busy} title="nach oben" onClick={() => move(ui!, -1)}><ArrowUp size={13} /></button>
                          <button className="icon-btn" style={{ width: 26, height: 26 }} disabled={busy} title="nach unten" onClick={() => move(ui!, 1)}><ArrowDown size={13} /></button>
                          <button className="icon-btn" style={{ width: 26, height: 26 }} title="bearbeiten" onClick={() => setEdit({ r: u, idx: ui! })}><Pencil size={13} /></button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid">
        <Card className="c6" title="Was lauscht und ist es von außen erreichbar?" flush>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Port</th><th>Dienst</th><th>Von außen</th><th>Warum</th></tr></thead>
              <tbody>
                {fw.listeners.map((l) => (
                  <tr key={l.proto + l.port} style={{ cursor: 'default' }}>
                    <td className="mono">{l.proto.toUpperCase()} {l.port}</td>
                    <td className="dim">{l.process || '–'}</td>
                    <td><Badge t={l.state === 'open' ? 'warn' : l.state === 'limited' ? 'acc' : 'ok'}>{l.state === 'open' ? 'offen' : l.state === 'limited' ? 'eingeschränkt' : 'blockiert'}</Badge></td>
                    <td className="dim ell" style={{ maxWidth: 260, fontSize: 12.5 }} title={l.why}>{l.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="dim" style={{ fontSize: 12, padding: '8px 16px 12px' }}>Portfreigaben ins Heimnetz lauschen nicht auf dem VPS selbst; sie stehen in den Regeln als „Portfreigabe“.</div>
        </Card>
        <Card className="c6" title="Einstellungen">
          <div className="col" style={{ gap: 10 }}>
            <Toggle on={cfg.ping} busy={busy} label="Ping (ICMP Echo) beantworten" onClick={() => push({ ...cfg, ping: !cfg.ping }, cfg.ping ? 'Ping blockiert.' : 'Ping erlaubt.')} />
            <div className="lbl-sm" style={{ marginTop: 4 }}>Automatisch erlauben</div>
            <Toggle on={cfg.auto.wg} busy={busy} label="Ports aller WireGuard-Tunnel (auch NetBird)" onClick={() => push({ ...cfg, auto: { ...cfg.auto, wg: !cfg.auto.wg } }, 'Gespeichert.')} />
            <Toggle on={cfg.auto.forwards} busy={busy} label="Ports der Portfreigaben (neue Freigaben sind sofort offen)" onClick={() => push({ ...cfg, auto: { ...cfg.auto, forwards: !cfg.auto.forwards } }, 'Gespeichert.')} />
            <Toggle on={cfg.auto.docker} busy={busy} label="Von Docker veröffentlichte Ports" onClick={() => push({ ...cfg, auto: { ...cfg.auto, docker: !cfg.auto.docker } }, 'Gespeichert.')} />
            <div className="dim" style={{ fontSize: 12, lineHeight: 1.55 }}>
              Gilt für alles, was über {fw.wan_if} aus dem Internet kommt (IPv4 und IPv6), Tunnel und Docker-Netze bleiben unberührt.
              SSH ist immer offen. Jede Änderung gilt sofort; antwortet der VPS danach nicht mehr über eine neue SSH-Verbindung,
              nimmt er sie nach 60 s selbst zurück. Regeln liegen auf dem VPS in {fw.file}.
              {v.history?.[0] && <> · Zuletzt: {v.history[0].what} {ago(v.history[0].t)}</>}
            </div>
          </div>
        </Card>
      </div>

      {edit && <RuleEditor r={edit.r} busy={busy} err={err} onClose={() => { setEdit(null); setErr('') }}
        onSave={(nr) => setRules(edit.idx >= 0 ? cfg.rules.map((x, j) => (j === edit.idx ? nr : x)) : [...cfg.rules, nr], 'Regel gespeichert und aktiv.')}
        onDelete={edit.idx >= 0 ? () => setRules(cfg.rules.filter((_, j) => j !== edit.idx), 'Regel gelöscht.') : undefined} />}
      {toast && <div className="toast">{toast}</div>}
    </>
  )
}

function Toggle({ on, busy, label, onClick }: { on: boolean; busy: boolean; label: string; onClick: () => void }) {
  return <div className="row" style={{ gap: 10 }}><button className={'switch' + (on ? ' on' : '')} disabled={busy} onClick={onClick}><i /></button><span>{label}</span></div>
}

function RuleEditor({ r, busy, err, onClose, onSave, onDelete }: {
  r: URule | null; busy: boolean; err: string; onClose: () => void; onSave: (r: URule) => void; onDelete?: () => void
}) {
  const [x, setX] = useState<URule>(r ? { ...r } : { id: '', action: 'accept', proto: 'tcp', port: '', source: '', family: 'both', comment: '', enabled: true })
  const [del, setDel] = useState(false)
  const up = (p: Partial<URule>) => setX((o) => ({ ...o, ...p }))
  const hasPort = x.proto === 'tcp' || x.proto === 'udp' || x.proto === 'tcpudp'
  const portOk = !x.port || /^\d{1,5}(-\d{1,5})?$/.test(x.port.trim())
  const srcOk = !x.source || /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(x.source.trim())
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-h">
          <div className="col grow"><b style={{ fontSize: 17 }}>{r ? 'Regel bearbeiten' : 'Neue Regel'}</b><span className="dim" style={{ fontSize: 12.5 }}>Firewall-VPS · eingehend aus dem Internet</span></div>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="drawer-b">
          <div className="form">
            <div className="row" style={{ gap: 10 }}>
              <label className="grow">Aktion<select className="input" value={x.action} onChange={(e) => up({ action: e.target.value as any })}><option value="accept">Erlauben</option><option value="drop">Verwerfen</option></select></label>
              <label className="grow">Protokoll<select className="input" value={x.proto} onChange={(e) => up({ proto: e.target.value as Proto })}>
                <option value="tcp">TCP</option><option value="udp">UDP</option><option value="tcpudp">TCP+UDP</option><option value="icmp">ICMP</option><option value="any">alle</option>
              </select></label>
            </div>
            {hasPort && <label>Port<input className="input mono" value={x.port} placeholder="leer = alle, z. B. 443 oder 8000-8100" onChange={(e) => up({ port: e.target.value.replace(/[^\d-]/g, '') })} /></label>}
            <label>Quelle<input className="input mono" value={x.source} placeholder="leer = alle, z. B. 203.0.113.7 oder 198.51.100.0/24" onChange={(e) => up({ source: e.target.value.trim() })} /></label>
            <label>IP-Version<select className="input" value={x.family} onChange={(e) => up({ family: e.target.value as any })}><option value="both">IPv4 und IPv6</option><option value="4">nur IPv4</option><option value="6">nur IPv6</option></select></label>
            <label>Beschreibung<input className="input" maxLength={60} value={x.comment} onChange={(e) => up({ comment: e.target.value })} placeholder="z. B. Webserver" /></label>
            <label className="check" style={{ alignSelf: 'flex-start', padding: 0 }}><input type="checkbox" checked={x.enabled} onChange={(e) => up({ enabled: e.target.checked })} />aktiv</label>
          </div>
          {err && <div className="err">{err}</div>}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" disabled={busy || !portOk || !srcOk} onClick={() => onSave({ ...x, port: hasPort ? x.port.trim() : '' })}>{busy ? 'Übertrage an VPS …' : 'Speichern'}</button>
            <span className="grow" />
            {onDelete && !del && <button className="btn" style={{ color: 'var(--bad)' }} onClick={() => setDel(true)}><Trash2 size={14} />Löschen</button>}
            {onDelete && del && <button className="btn" style={{ background: 'var(--bad)', color: '#fff', borderColor: 'var(--bad)' }} disabled={busy} onClick={onDelete}>Wirklich löschen</button>}
          </div>
          <div className="dim" style={{ fontSize: 12 }}>Neue Regeln kommen ans Ende der eigenen Regeln, vor die automatischen. Gilt sofort; antwortet der VPS danach nicht mehr, nimmt er die Änderung nach 60 s selbst zurück.</div>
        </div>
      </aside>
    </>
  )
}
