import React, { useEffect, useRef, useState } from 'react'
import { Download, ExternalLink, Gauge, Play, Square, Stethoscope, Trash2 } from 'lucide-react'
import { api, Full } from '../api'
import { Card, Seg } from '../components/ui'
import { bytes } from '../format'

type Tool = 'ping' | 'traceroute' | 'dns' | 'port' | 'route' | 'capture' | 'speedtest'
type Src = { device: string; descr: string; v4: string[]; v6: string[] }
type StEntry = { t: number; down: number; up: number; ping: number; jitter: number; loaded_down: number; loaded_up: number; loss: number | null; isp: string; server: string; iface: string; ip: string; url: string | null }
type StLive = { phase: string; p: number; down?: number; up?: number; ping?: number; server?: string }

const TOOLS: [Tool, string][] = [['ping', 'Ping'], ['traceroute', 'Traceroute'], ['dns', 'DNS-Abfrage'], ['port', 'Port-Test'], ['route', 'Route'], ['capture', 'Paketmitschnitt'], ['speedtest', 'Speedtest']]

const fmtMbps = (v?: number) => (v == null ? '–' : v >= 100 ? v.toFixed(0) : v.toFixed(1))
const when = (t: number) => new Date(t * 1000).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

export default function Diag({ full }: { full: Full }) {
  const [tool, setTool] = useState<Tool>('ping')
  const [srcs, setSrcs] = useState<Src[]>([])
  const [f, setF] = useState<Record<string, string>>({ target: '', iface: '', count: '4', size: '56', family: '', hops: '20', icmp: '0', numeric: '1', type: 'A', server: '127.0.0.1', port: '443', filter: '', seconds: '15', ccount: '50' })
  const [lines, setLines] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState('')
  const [pcap, setPcap] = useState<{ token: string; name: string; size: number } | null>(null)
  const [live, setLive] = useState<StLive | null>(null)
  const [st, setSt] = useState<{ installed?: boolean; servers: { id: number; name: string; location: string }[]; history: StEntry[] }>({ servers: [], history: [] })
  const [stInst, setStInst] = useState(false)
  const es = useRef<EventSource | null>(null)
  const rid = useRef('')
  const box = useRef<HTMLPreElement>(null)
  useEffect(() => { api<{ sources: Src[] }>('/api/diag/sources').then((r) => setSrcs(r.sources)).catch(() => {}) }, [])
  useEffect(() => () => es.current?.close(), [])
  const loadSt = () => api('/api/diag/speedtest').then(setSt).catch(() => {})
  useEffect(() => { if (tool === 'speedtest') loadSt() }, [tool])
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight }, [lines])
  const up = (k: string, v: string) => setF((o) => ({ ...o, [k]: v }))

  function params() {
    const p: Record<string, string> = { tool, target: f.target.trim(), iface: f.iface, family: f.family }
    if (tool === 'ping') Object.assign(p, { count: f.count, size: f.size })
    if (tool === 'traceroute') Object.assign(p, { hops: f.hops, icmp: f.icmp, numeric: f.numeric })
    if (tool === 'dns') Object.assign(p, { type: f.type, server: f.server, reverse: f.type === 'PTR' ? '1' : '0' })
    if (tool === 'port') Object.assign(p, { port: f.port })
    if (tool === 'capture') Object.assign(p, { filter: f.filter, seconds: f.seconds, count: f.ccount })
    if (tool === 'speedtest') { delete p.target; p.server = f.stserver || '' }
    return new URLSearchParams(p).toString()
  }

  async function run() {
    setErr('')
    const qs = params()
    const chk = await api<{ ok: boolean; error?: string }>('/api/diag/check?' + qs).catch((e) => ({ ok: false, error: e.message }))
    if (!chk.ok) { setErr(chk.error || 'Eingabe prüfen'); return }
    es.current?.close()
    setLines((l) => (l.length ? [...l, ''] : l))
    setRunning(true)
    if (tool === 'capture') setPcap(null)
    if (tool === 'speedtest') setLive({ phase: 'start', p: 0 })
    rid.current = Math.random().toString(36).slice(2, 12).padEnd(8, '0')
    const s = new EventSource('/api/diag/run?' + qs + '&rid=' + rid.current)
    es.current = s
    s.addEventListener('line', (e) => setLines((l) => [...l, JSON.parse((e as MessageEvent).data)].slice(-3000)))
    s.addEventListener('progress', (e) => {
      const d = JSON.parse((e as MessageEvent).data)
      setLive((o) => {
        const n: StLive = { ...(o || { phase: 'start', p: 0 }), phase: d.phase, p: d.p ?? 0 }
        if (d.phase === 'start') n.server = d.server
        if (d.phase === 'ping') n.ping = d.ms
        if (d.phase === 'download') n.down = d.mbps
        if (d.phase === 'upload') n.up = d.mbps
        return n
      })
    })
    s.addEventListener('result', (e) => {
      const d: StEntry = JSON.parse((e as MessageEvent).data)
      setLive((o) => ({ ...(o || { p: 1 }), phase: 'done', p: 1, down: d.down, up: d.up, ping: d.ping }))
      setSt((o) => ({ ...o, history: [d, ...o.history].slice(0, 50) }))
    })
    s.addEventListener('done', (e) => {
      const d = JSON.parse((e as MessageEvent).data)
      setLines((l) => [...l, d.code ? `(Ende, Code ${d.code})` : '(fertig)'])
      if (d.pcap) setPcap({ token: d.pcap, name: d.pcap_name, size: d.pcap_size })
      setLive((o) => (o && o.phase !== 'done' ? { ...o, phase: 'stopped' } : o))
      s.close(); setRunning(false)
    })
    s.onerror = () => { s.close(); setRunning(false) }
  }
  async function stop() {
    // ask the box to end the process cleanly, so a capture still gets its pcap file
    const ok = await api<{ ok: boolean }>('/api/diag/stop', { method: 'POST', body: JSON.stringify({ rid: rid.current }) }).then((r) => r.ok).catch(() => false)
    const s = es.current
    setTimeout(() => { if (s && s.readyState !== EventSource.CLOSED) { s.close(); setRunning(false) } }, ok ? 6000 : 0)
    if (!ok) setLines((l) => [...l, '(abgebrochen)'])
  }

  const devs = full.devices.filter((d) => d.ip).sort((a, b) => a.name.localeCompare(b.name))
  const needTarget = tool !== 'capture' && tool !== 'speedtest'
  const srcOpts = srcs.filter((s) => s.v4.length || s.v6.length)
  return (
    <>
      <Card title="Diagnose" icon={<Stethoscope size={16} />} act={<span>läuft auf der OPNsense</span>}>
        <div className="col" style={{ gap: 14 }}>
          <Seg value={tool} onChange={(t) => { setTool(t); setErr('') }} options={TOOLS} />
          <div className="row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
            {needTarget && (
              <label className="dlabel grow" style={{ minWidth: 240 }}>{tool === 'dns' ? 'Name oder IP' : 'Ziel (IP oder Hostname)'}
                <input className="input mono" list="diag-targets" value={f.target} onChange={(e) => up('target', e.target.value)} placeholder={tool === 'dns' ? 'example.com' : '1.1.1.1'}
                  onKeyDown={(e) => e.key === 'Enter' && !running && run()} autoFocus />
                <datalist id="diag-targets">
                  {devs.map((d) => <option key={d.mac} value={d.ip!}>{d.name}</option>)}
                  <option value="1.1.1.1">Cloudflare</option><option value="9.9.9.9">Quad9</option><option value="google.com" />
                </datalist>
              </label>
            )}
            {tool !== 'dns' && tool !== 'route' && (
              <label className="dlabel" style={{ width: 230 }}>{tool === 'capture' ? 'Interface' : 'Quelle (Interface)'}
                <select className="input" value={f.iface} onChange={(e) => up('iface', e.target.value)}>
                  {tool !== 'capture' && <option value="">automatisch (Routing)</option>}
                  {tool === 'capture' && <option value="">– wählen –</option>}
                  {(tool === 'capture' ? srcs : srcOpts).map((s) => <option key={s.device} value={s.device}>{s.descr} · {s.device}{s.v4[0] ? ' · ' + s.v4[0] : ''}</option>)}
                </select>
              </label>
            )}
            {tool === 'speedtest' && (
              <label className="dlabel grow" style={{ minWidth: 240 }}>Server
                <select className="input" value={f.stserver || ''} onChange={(e) => up('stserver', e.target.value)}>
                  <option value="">automatisch (nächster)</option>
                  {st.servers.map((x) => <option key={x.id} value={String(x.id)}>{x.name} · {x.location}</option>)}
                </select>
              </label>
            )}
            {(tool === 'ping' || tool === 'traceroute' || tool === 'port' || tool === 'route' || tool === 'speedtest') && (
              <label className="dlabel" style={{ width: 110 }}>IP-Version
                <select className="input" value={f.family} onChange={(e) => up('family', e.target.value)}><option value="">auto</option><option value="4">IPv4</option><option value="6">IPv6</option></select>
              </label>
            )}
            {tool === 'ping' && <>
              <label className="dlabel" style={{ width: 90 }}>Anzahl<input className="input mono" value={f.count} onChange={(e) => up('count', e.target.value.replace(/\D/g, ''))} /></label>
              <label className="dlabel" style={{ width: 110 }}>Größe (Byte)<input className="input mono" value={f.size} onChange={(e) => up('size', e.target.value.replace(/\D/g, ''))} /></label>
            </>}
            {tool === 'traceroute' && <>
              <label className="dlabel" style={{ width: 90 }}>max. Hops<input className="input mono" value={f.hops} onChange={(e) => up('hops', e.target.value.replace(/\D/g, ''))} /></label>
              <label className="check" style={{ padding: '0 0 9px' }}><input type="checkbox" checked={f.icmp === '1'} onChange={(e) => up('icmp', e.target.checked ? '1' : '0')} />ICMP statt UDP</label>
              <label className="check" style={{ padding: '0 0 9px' }}><input type="checkbox" checked={f.numeric === '1'} onChange={(e) => up('numeric', e.target.checked ? '1' : '0')} />nur IPs</label>
            </>}
            {tool === 'dns' && <>
              <label className="dlabel" style={{ width: 110 }}>Typ<select className="input" value={f.type} onChange={(e) => up('type', e.target.value)}>{['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'PTR', 'SRV', 'SOA', 'CAA'].map((t) => <option key={t}>{t}</option>)}</select></label>
              <label className="dlabel" style={{ width: 230 }}>Server<select className="input" value={f.server} onChange={(e) => up('server', e.target.value)}>
                <option value="127.0.0.1">OPNsense (127.0.0.1)</option>
                <option value="1.1.1.1">Cloudflare 1.1.1.1</option><option value="9.9.9.9">Quad9 9.9.9.9</option><option value="8.8.8.8">Google 8.8.8.8</option>
              </select></label>
            </>}
            {tool === 'port' && <label className="dlabel" style={{ width: 100 }}>Port<input className="input mono" value={f.port} onChange={(e) => up('port', e.target.value.replace(/\D/g, ''))} /></label>}
            {tool === 'capture' && <>
              <label className="dlabel grow" style={{ minWidth: 260 }}>Filter (tcpdump)<input className="input mono" value={f.filter} onChange={(e) => up('filter', e.target.value)} placeholder="host 192.168.1.10 and port 443" /></label>
              <label className="dlabel" style={{ width: 90 }} title="höchstens 5000">Pakete<input className="input mono" value={f.ccount} onChange={(e) => up('ccount', e.target.value.replace(/\D/g, ''))} /></label>
              <label className="dlabel" style={{ width: 90 }} title="höchstens 300">max. Sek.<input className="input mono" value={f.seconds} onChange={(e) => up('seconds', e.target.value.replace(/\D/g, ''))} /></label>
            </>}
            {running ? <button className="btn" onClick={stop}><Square size={13} />Stopp</button>
              : <button className="btn primary" onClick={run} disabled={(needTarget && !f.target.trim()) || (tool === 'speedtest' && st.installed === false)}><Play size={13} />Start</button>}
            <button className="btn ghost" title="Ausgabe leeren" onClick={() => setLines([])}><Trash2 size={13} /></button>
            {tool === 'capture' && pcap && (
              <a className="btn primary" href={'/api/diag/pcap/' + pcap.token} download={pcap.name} title="pcap-Datei, öffnet sich in Wireshark">
                <Download size={13} />Für Wireshark exportieren ({bytes(pcap.size)})
              </a>
            )}
          </div>
          {tool === 'capture' && <div className="dim" style={{ fontSize: 12, marginTop: -6 }}>Jeder Mitschnitt wird zusätzlich als .pcap gespeichert (2 Std. abrufbar, höchstens 200 MB). Stopp beendet sauber, die Datei bleibt vollständig.</div>}
          {tool === 'speedtest' && st.installed === false && (
            <div className="src-err" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span className="grow">Der Speedtest nutzt die offizielle CLI von Ookla (speedtest.net). Sie ist nicht im Paket enthalten und wird von install.speedtest.net
                geladen. Mit der Installation stimmst du der <a href="https://www.speedtest.net/about/eula" target="_blank" rel="noreferrer">Lizenz</a> und
                den <a href="https://www.speedtest.net/about/privacy" target="_blank" rel="noreferrer">Datenschutzbestimmungen</a> von Ookla zu (nur private, nicht kommerzielle Nutzung).</span>
              <button className="btn sm primary" disabled={stInst} onClick={async () => { setStInst(true); setErr(''); try { await api('/api/diag/speedtest/install', { method: 'POST', body: '{}' }); await loadSt() } catch (e: any) { setErr(e.message) } finally { setStInst(false) } }}>
                {stInst ? 'Lade …' : 'Zustimmen und installieren'}</button>
            </div>
          )}
          {tool === 'speedtest' && <SpeedLive live={live ?? (st.history[0] ? { phase: 'last', p: 1, down: st.history[0].down, up: st.history[0].up, ping: st.history[0].ping, server: st.history[0].server } : null)} running={running} lastT={!live ? st.history[0]?.t : undefined} />}
          {err && <div className="err">{err}</div>}
          <pre ref={box} className="console" style={tool === 'speedtest' ? { minHeight: 160 } : undefined}>{lines.length ? lines.join('\n') : tool === 'speedtest' ? 'Misst die Internetleitung der OPNsense über speedtest.net (Ookla). Dauert etwa 25 Sekunden und lastet die Leitung voll aus.' : 'Ausgabe erscheint hier live.'}</pre>
        </div>
      </Card>
      {tool === 'speedtest' && st.history.length > 0 && <SpeedHistory rows={st.history} />}
    </>
  )
}

function SpeedLive({ live, running, lastT }: { live: StLive | null; running: boolean; lastT?: number }) {
  const ph = live?.phase || ''
  const label = !live ? 'bereit' : ph === 'last' ? `letzter Test, ${when(lastT || 0)}` : ph === 'done' ? 'fertig' : ph === 'stopped' ? 'abgebrochen' : ph === 'start' ? 'verbinde …' : ph === 'ping' ? 'Ping …' : ph === 'download' ? 'Download …' : 'Upload …'
  const overall = !live || ph === 'last' ? 0 : ph === 'done' ? 1 : ph === 'ping' ? 0.05 * live.p : ph === 'download' ? 0.05 + 0.5 * live.p : ph === 'upload' ? 0.55 + 0.45 * live.p : 0
  const k = (name: string, v: string, unit: string, act: boolean) => (
    <div className="kpi" style={{ minWidth: 150, opacity: act || ph === 'done' || !running ? 1 : 0.55 }}>
      <span className="dim" style={{ fontSize: 12.5 }}>{name}</span>
      <span className="v">{v}<small>{unit}</small></span>
    </div>
  )
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row wrap" style={{ gap: 28 }}>
        {k('Download', fmtMbps(live?.down), 'Mbit/s', ph === 'download')}
        {k('Upload', fmtMbps(live?.up), 'Mbit/s', ph === 'upload')}
        {k('Ping', live?.ping != null ? live.ping.toFixed(1) : '–', 'ms', ph === 'ping')}
        <div className="col grow" style={{ gap: 6, minWidth: 200, justifyContent: 'flex-end' }}>
          <div className="row dim" style={{ fontSize: 12.5 }}><span className="grow">{label}</span><span>{live?.server || ''}</span></div>
          <div className={'meter' + (ph === 'done' ? ' ok' : '')}><i style={{ width: `${Math.round(overall * 100)}%` }} /></div>
        </div>
      </div>
    </div>
  )
}

function SpeedHistory({ rows }: { rows: StEntry[] }) {
  return (
    <Card title="Letzte Speedtests" icon={<Gauge size={16} />} flush act={<span>{rows.length} gespeichert</span>}>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Zeit</th><th className="r">Download</th><th className="r">Upload</th><th className="r">Ping</th><th className="r">Jitter</th><th className="r">Ping unter Last ↓ / ↑</th><th>Server</th><th>Interface</th><th></th></tr></thead>
          <tbody>
            {rows.slice(0, 15).map((r) => (
              <tr key={r.t} style={{ cursor: 'default' }}>
                <td className="num">{when(r.t)}</td>
                <td className="r num"><b>{fmtMbps(r.down)}</b> <span className="dim">Mbit/s</span></td>
                <td className="r num"><b>{fmtMbps(r.up)}</b> <span className="dim">Mbit/s</span></td>
                <td className="r num">{r.ping} ms</td>
                <td className="r num dim">{r.jitter} ms</td>
                <td className="r num dim">{r.loaded_down} / {r.loaded_up} ms</td>
                <td className="ell" style={{ maxWidth: 260 }} title={r.server + ' · ' + r.isp}>{r.server}</td>
                <td className="mono dim" style={{ fontSize: 12 }} title={r.ip}>{r.iface} · {r.ip?.includes(':') ? 'IPv6' : 'IPv4'}</td>
                <td className="r">{r.url && <a className="icon-btn" href={r.url} target="_blank" rel="noreferrer" title="Ergebnis auf speedtest.net"><ExternalLink size={14} /></a>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
