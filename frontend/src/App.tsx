import React, { useEffect, useState } from 'react'
import {
  Activity, ArrowLeftRight, BrickWall, Globe, Share2, Stethoscope, Workflow, LayoutDashboard, Settings as SettingsIcon, LogOut, Menu, MonitorSmartphone, Network, Search, Server, ShieldCheck, ShieldHalf, Waypoints, Wifi,
} from 'lucide-react'
import { logout, useStore, Full } from './api'
import { rate } from './format'
import Login from './pages/Login'
import Overview from './pages/Overview'
import Devices from './pages/Devices'
import DeviceDrawer from './pages/DeviceDrawer'
import Networks from './pages/Networks'
import WifiPage from './pages/Wifi'
import Vpn from './pages/Vpn'
import Services from './pages/Services'
import Servers from './pages/Servers'
import Dns from './pages/Dns'
import Proxy from './pages/Proxy'
import Settings from './pages/Settings'
import Firewall from './pages/Firewall'
import Topology from './pages/Topology'
import Forwards from './pages/Forwards'
import VpsFirewall from './pages/VpsFirewall'
import Diag from './pages/Diag'

export type Route = { page: string; arg?: string; q?: string; d?: string }

export function parseHash(): Route {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''))
  const [path, query] = h.split('?')
  const [page, arg] = path.split('/')
  const qs = new URLSearchParams(query || '')
  return { page: page || 'overview', arg, q: qs.get('q') || undefined, d: qs.get('d') || undefined }
}

/** open the device drawer on top of the current page */
export function openDevice(mac: string) {
  const r = parseHash()
  if (r.page === 'devices') return go('devices', mac, r.q)
  location.hash = '#/' + r.page + (r.arg ? '/' + encodeURIComponent(r.arg) : '') + '?d=' + encodeURIComponent(mac)
}

function closeDevice() {
  const r = parseHash()
  location.hash = '#/' + r.page + (r.arg ? '/' + encodeURIComponent(r.arg) : '')
}

export function go(page: string, arg?: string, q?: string) {
  location.hash = '#/' + page + (arg ? '/' + encodeURIComponent(arg) : '') + (q ? '?q=' + encodeURIComponent(q) : '')
}

const NAV: [string, string, React.ComponentType<any>][] = [
  ['overview', 'Übersicht', LayoutDashboard],
  ['devices', 'Geräte', MonitorSmartphone],
  ['topology', 'Netzwerkplan', Workflow],
  ['networks', 'Netzwerke', Network],
  ['wifi', 'WLAN', Wifi],
  ['firewall', 'Firewall', BrickWall],
  ['vpsfw', 'Firewall-VPS', ShieldHalf],
  ['vpn', 'VPN', Waypoints],
  ['services', 'Dienste', Activity],
  ['servers', 'Server', Server],
  ['dns', 'DNS', ShieldCheck],
  ['proxy', 'Reverse Proxy', ArrowLeftRight],
  ['forwards', 'Portfreigaben', Share2],
  ['diag', 'Diagnose', Stethoscope],
  ['settings', 'Einstellungen', SettingsIcon],
]

const MNAV = 4 // pages directly in the phone bottom bar, the rest is under "Mehr"

export function wanRates(full?: Full) {
  let rx = 0, tx = 0
  for (const i of full?.interfaces || []) if (i.wan) { rx += i.rx; tx += i.tx }
  return { rx, tx }
}

export default function App() {
  const s = useStore()
  const [route, setRoute] = useState<Route>(parseHash())
  const [q, setQ] = useState('')
  const [more, setMore] = useState(false)
  useEffect(() => {
    const f = () => { setRoute(parseHash()); setMore(false) }
    window.addEventListener('hashchange', f)
    return () => window.removeEventListener('hashchange', f)
  }, [])

  if (s.auth === 'no') return <Login />
  if (s.auth === 'unknown' || !s.full) return <div className="login"><div className="dim">Lade …</div></div>

  const full = s.full
  const wan = wanRates(full)
  const page = route.page
  const online = full.devices.filter((d) => d.online).length
  const problems = (full.gatus || []).filter((g) => g.ok === false).length +
    (full.services || []).filter((x) => !x.running).length
  const title = NAV.find((n) => n[0] === page)?.[1] || 'Übersicht'

  let body: React.ReactNode
  switch (page) {
    case 'devices': body = <Devices full={full} q={route.q} />; break
    case 'networks': body = <Networks full={full} ifHist={s.ifHist} />; break
    case 'wifi': body = <WifiPage full={full} />; break
    case 'vpn': body = <Vpn full={full} />; break
    case 'services': body = <Services full={full} />; break
    case 'servers': body = <Servers full={full} cpuHist={s.cpuHist} />; break
    case 'dns': body = <Dns full={full} />; break
    case 'proxy': body = <Proxy full={full} />; break
    case 'settings': body = <Settings />; break
    case 'firewall': body = <Firewall full={full} />; break
    case 'topology': body = <Topology full={full} />; break
    case 'forwards': body = <Forwards full={full} />; break
    case 'vpsfw': body = <VpsFirewall full={full} />; break
    case 'diag': body = <Diag full={full} />; break
    default: body = <Overview full={full} ifHist={s.ifHist} />
  }
  const drawerMac = page === 'devices' && route.arg ? route.arg : route.d || null

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <span className="brand-mark"><Globe size={17} strokeWidth={2.2} /></span>
          <span className="txt">Netzwerk<small>OPNsense · {full.system?.model?.split(' ')[1] || ''}</small></span>
        </div>
        {NAV.map(([id, label, Ic]) => (
          <button key={id} className={'nav-item' + (page === id ? ' active' : '')} onClick={() => go(id)} title={label}>
            <Ic size={18} strokeWidth={1.9} />
            <span className="lbl">{label}</span>
            {id === 'devices' && <span className="badge">{online}</span>}
            {id === 'services' && problems > 0 && <span className="badge bad">{problems}</span>}
          </button>
        ))}
        <div className="side-foot">
          <div className="row gap6"><span className={'dot ' + (s.connected ? 'ok' : 'warn')} /><span className="lbl">{s.connected ? 'Live' : 'Verbinde …'}</span></div>
          <button className="nav-item" onClick={logout} title="Abmelden"><LogOut size={17} /><span className="lbl">{s.user} abmelden</span></button>
        </div>
      </aside>
      <div className="main">
        <header className="top">
          <h1>{title}</h1>
          <div className="spacer" />
          <form className="search" onSubmit={(e) => { e.preventDefault(); go('devices', undefined, q) }}>
            <Search size={15} />
            <input placeholder="Gerät, IP oder MAC suchen" value={q} onChange={(e) => { setQ(e.target.value); if (page === 'devices') go('devices', undefined, e.target.value) }} />
          </form>
          <div className="wanpill" title="Internet jetzt">
            <span className="d">↓ {rate(wan.rx)}</span>
            <span className="u">↑ {rate(wan.tx)}</span>
          </div>
        </header>
        <main className="content">
          {full.setup && !full.setup.opnsense_api && page !== 'settings' && (
            <div className="src-err" style={{ cursor: 'pointer' }} onClick={() => go('settings')}>
              Erster Schritt: OPNsense-API-Zugang einrichten. In der OPNsense unter System → Zugang → Benutzer einen API-Schlüssel
              anlegen (Benutzer mit vollen Rechten) und unter Einstellungen → Integrationen → OPNsense-API eintragen. Ohne ihn fehlen
              Dienste, Gateways, Firewall-Regeln und der Reverse Proxy.
            </div>
          )}
          {body}
        </main>
      </div>
      {/* phones: the sidebar is hidden, so the bottom bar has the first pages and "Mehr" has everything the sidebar has */}
      <nav className="mnav">
        {NAV.slice(0, MNAV).map(([id, label, Ic]) => (
          <button key={id} className={page === id && !more ? 'active' : ''} onClick={() => go(id)}><Ic size={20} />{label}</button>
        ))}
        <button className={more || !NAV.slice(0, MNAV).some((n) => n[0] === page) ? 'active' : ''} onClick={() => setMore(!more)}>
          <Menu size={20} />Mehr{problems > 0 && <span className="mbadge">{problems}</span>}
        </button>
      </nav>
      {more && (
        <>
          <div className="scrim msheet-scrim" onClick={() => setMore(false)} />
          <div className="msheet">
            <div className="grab" />
            <form className="msearch" onSubmit={(e) => { e.preventDefault(); setMore(false); go('devices', undefined, q) }}>
              <Search size={15} />
              <input placeholder="Gerät, IP oder MAC suchen" value={q} enterKeyHint="search" onChange={(e) => setQ(e.target.value)} />
            </form>
            <div className="mgrid">
              {NAV.map(([id, label, Ic]) => (
                <button key={id} className={'mitem' + (page === id ? ' active' : '')} onClick={() => { setMore(false); go(id) }}>
                  <Ic size={20} strokeWidth={1.9} />
                  <span>{label}</span>
                  {id === 'devices' && <span className="mcount">{online}</span>}
                  {id === 'services' && problems > 0 && <span className="mbadge">{problems}</span>}
                </button>
              ))}
            </div>
            <div className="mfoot">
              <span className={'dot ' + (s.connected ? 'ok' : 'warn')} />
              <span className="grow">{s.connected ? 'Live' : 'Verbinde …'} · {s.user}</span>
              <button className="btn sm" onClick={logout}><LogOut size={14} />Abmelden</button>
            </div>
          </div>
        </>
      )}
      {drawerMac && <DeviceDrawer mac={drawerMac} full={full} onClose={() => page === 'devices' ? go('devices', undefined, route.q) : closeDevice()} />}
    </div>
  )
}
