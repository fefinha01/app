const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const REFRESH_MS = 60 * 1000
const OFFLINE_GRACE_MS = 10 * 60 * 1000
const FLUSH_MS = 15 * 1000
const MAX_QUEUE = 500

function createLicense({ app, safeStorage, onChange }) {
  let config = null
  let configError = ''
  let token = ''
  let user = null
  let lastOkAt = 0
  let offline = false
  let queue = []
  let expiryTimer = null

  const device = `${os.hostname()} | ${os.userInfo().username} | ${crypto
    .createHash('sha256')
    .update(`${os.hostname()}|${os.userInfo().username}|${os.cpus()[0]?.model || ''}`)
    .digest('hex')
    .slice(0, 16)}`.slice(0, 190)

  const tokenFile = () => path.join(app.getPath('userData'), 'session.bin')

  function loadConfig() {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'app-config.json'), 'utf8'))
      const url = new URL(raw.apiUrl)
      const local = ['127.0.0.1', 'localhost'].includes(url.hostname)
      if (url.protocol !== 'https:' && !local) throw new Error('apiUrl precisa ser https://')
      if (!/^[a-f0-9]{64,}$/i.test(raw.appSecret || '')) throw new Error('appSecret inválido')
      config = { apiUrl: url.origin + url.pathname.replace(/\/$/, ''), appSecret: raw.appSecret }
    } catch (err) {
      configError = `Configuração da API ausente ou inválida (desktop/app-config.json): ${err.message}`
    }
  }

  let remembered = false

  // session.bin holds { token, user } encrypted; older versions stored only the raw token string.
  function readSession() {
    try {
      const buf = fs.readFileSync(tokenFile())
      if (!safeStorage.isEncryptionAvailable()) return null
      const text = safeStorage.decryptString(buf)
      if (text.startsWith('{')) {
        const parsed = JSON.parse(text)
        return parsed && typeof parsed.token === 'string' ? parsed : null
      }
      return text ? { token: text, user: null } : null
    } catch {
      return null
    }
  }

  function writeSession() {
    try {
      if (!remembered || !token) return fs.rmSync(tokenFile(), { force: true })
      if (!safeStorage.isEncryptionAvailable()) return
      fs.writeFileSync(tokenFile(), safeStorage.encryptString(JSON.stringify({ token, user })))
    } catch {}
  }

  function writeToken(value) {
    if (!value) remembered = false
    writeSession()
  }

  async function request(method, urlPath, body, withAuth = true) {
    if (!config) throw Object.assign(new Error(configError), { code: 'config' })
    const fullPath = new URL(config.apiUrl + urlPath).pathname
    const raw = body ? JSON.stringify(body) : ''
    const ts = String(Date.now())
    const nonce = crypto.randomBytes(16).toString('hex')
    const bodyHash = crypto.createHash('sha256').update(raw).digest('hex')
    const sig = crypto
      .createHmac('sha256', config.appSecret)
      .update(`${ts}.${nonce}.${method}.${fullPath}.${bodyHash}`)
      .digest('hex')
    const headers = { 'x-rb-ts': ts, 'x-rb-nonce': nonce, 'x-rb-sig': sig, 'x-rb-device': device }
    if (raw) headers['content-type'] = 'application/json'
    if (withAuth && token) headers.authorization = `Bearer ${token}`

    let res
    try {
      res = await fetch(config.apiUrl + urlPath, {
        method,
        headers,
        body: raw || undefined,
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      throw Object.assign(new Error('Sem conexão com o servidor. Verifique sua internet.'), { code: 'network' })
    }
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      const message = json.error || (res.status === 404 ? 'Servidor recusou o aplicativo. Atualize o RavokBot.' : 'Erro no servidor.')
      throw Object.assign(new Error(message), { code: json.code || `http_${res.status}`, status: res.status })
    }
    return json
  }

  function isActive() {
    if (!user || !user.active) return false
    if (offline && Date.now() - lastOkAt > OFFLINE_GRACE_MS) return false
    if (user.lifetime) return true
    return user.expiresAt > Date.now()
  }

  function state() {
    return {
      configError,
      loggedIn: Boolean(user),
      active: isActive(),
      offline: offline && Date.now() - lastOkAt > OFFLINE_GRACE_MS,
      user,
    }
  }

  function scheduleExpiry() {
    clearTimeout(expiryTimer)
    if (!user || user.lifetime || !user.expiresAt) return
    const ms = user.expiresAt - Date.now()
    if (ms > 0 && ms < 2 ** 31 - 1) expiryTimer = setTimeout(emit, ms + 500)
  }

  function emit() {
    onChange(state())
  }

  function setUser(next) {
    user = next
    lastOkAt = Date.now()
    offline = false
    scheduleExpiry()
    writeSession()
    emit()
  }

  function clearSession() {
    token = ''
    user = null
    clearTimeout(expiryTimer)
    writeToken('')
    emit()
  }

  async function refresh() {
    if (!token) return state()
    try {
      const { user: next } = await request('GET', '/v1/me')
      setUser(next)
    } catch (err) {
      if (err.code === 'network') {
        offline = true
        emit()
      } else if (err.code === 'session' || err.code === 'blocked') {
        clearSession()
        return { ...state(), error: err.message }
      }
    }
    return state()
  }

  async function init() {
    loadConfig()
    const saved = readSession()
    if (saved && saved.token) {
      token = saved.token
      remembered = true
      // Keep the user signed in from the cached profile; the server check below confirms it
      // and only a real "session"/"blocked" answer logs out (a slow or offline start does not).
      if (saved.user) {
        user = saved.user
        lastOkAt = Date.now()
        scheduleExpiry()
      }
      await refresh()
      if (token && !user) await new Promise((r) => setTimeout(r, 1500)).then(refresh)
    }
    setInterval(() => refresh().catch(() => {}), REFRESH_MS).unref?.()
    setInterval(() => flush().catch(() => {}), FLUSH_MS).unref?.()
    return state()
  }

  async function login({ email, password, remember }) {
    const res = await request('POST', '/v1/auth/login', { email, password }, false)
    token = res.token
    remembered = remember !== false
    setUser(res.user)
    return state()
  }

  async function register({ email, password, phone, key }) {
    const res = await request('POST', '/v1/auth/register', { email, password, phone, key }, false)
    token = res.token
    remembered = true
    setUser(res.user)
    return state()
  }

  async function logout() {
    await flush().catch(() => {})
    if (token) await request('POST', '/v1/auth/logout', {}).catch(() => {})
    clearSession()
    return state()
  }

  async function redeem(key) {
    const res = await request('POST', '/v1/keys/redeem', { key })
    setUser(res.user)
    return state()
  }

  async function supportUrl() {
    const { supportUrl: url } = await request('GET', '/v1/config')
    if (!/^https:\/\/\S+$/i.test(url || '')) throw new Error('Link de suporte não configurado.')
    return url
  }

  function audit(action, details) {
    if (!token) return
    queue.push({ action, details: details ? String(details).slice(0, 1000) : '', at: Date.now() })
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE)
  }

  async function flush() {
    while (token && queue.length) {
      const batch = queue.slice(0, 50)
      await request('POST', '/v1/logs', { events: batch })
      queue = queue.slice(batch.length)
    }
  }

  return { init, state, isActive, login, register, logout, redeem, refresh, supportUrl, audit, flush }
}

module.exports = { createLicense }
