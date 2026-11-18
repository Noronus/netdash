import React, { useState } from 'react'
import { Globe } from 'lucide-react'
import { login } from '../api'

export default function Login() {
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="login">
      <form onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true); setErr('')
        try { await login(user, pass) } catch (x: any) { setErr(x.message) } finally { setBusy(false) }
      }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <span className="brand-mark" style={{ width: 40, height: 40, borderRadius: 12 }}><Globe size={22} /></span>
          <div>
            <h2>Netzwerk</h2>
            <div className="dim" style={{ fontSize: 13 }}>Anmelden mit deinem OPNsense-Konto</div>
          </div>
        </div>
        <label>Benutzername<input className="input" autoFocus autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)} /></label>
        <label>Passwort<input className="input" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} /></label>
        {err && <div className="err">{err}</div>}
        <button className="btn primary" disabled={busy || !user || !pass} style={{ justifyContent: 'center', padding: '10px' }}>{busy ? 'Prüfe …' : 'Anmelden'}</button>
      </form>
    </div>
  )
}
