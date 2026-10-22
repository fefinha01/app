const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const KEY_RE = /^RB(-[A-Z0-9]{4}){4}$/
const lic = window.api.license

const authEl = document.getElementById('auth')
const loginForm = document.getElementById('loginForm')
const registerForm = document.getElementById('registerForm')
const lockEl = document.getElementById('lockScreen')
const lockForm = document.getElementById('lockForm')
const tokenModal = document.getElementById('tokenModal')
const tokenForm = document.getElementById('tokenForm')

let current = { loggedIn: false, active: false, user: null }

function showAuthForm(which) {
  loginForm.hidden = which !== 'login'
  registerForm.hidden = which !== 'register'
  document.getElementById('loginError').textContent = ''
  document.getElementById('registerError').textContent = ''
  const first = (which === 'login' ? loginForm : registerForm).querySelector('input')
  first?.focus({ preventScroll: true })
}

const fmtDate = (ts) =>
  new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

function remaining(ms) {
  if (ms <= 0) return 'vencida'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  return d > 0 ? `${d}d ${pad(h)}h ${pad(m)}m` : `${pad(h)}:${pad(m)}:${pad(sec)}`
}

const accExpire = document.getElementById('accExpire')
const accLeft = document.getElementById('accLeft')

window.api.getVersion?.().then((v) => {
  if (v) document.getElementById('appVersion').textContent = `v${v}`
})

function tick() {
  const u = current.user
  if (!u) return
  if (u.lifetime) {
    accLeft.textContent = 'Nunca expira'
    return
  }
  const left = u.expiresAt - Date.now()
  accLeft.textContent = remaining(left)
  if (left <= 0 && current.active) render({ ...current, active: false })
}
setInterval(tick, 1000)

function render(state) {
  current = state
  const u = state.user
  const canCompact = Boolean(state.loggedIn && u && state.active)
  document.body.classList.toggle('can-compact', canCompact)
  if (!canCompact && document.body.classList.contains('compact-mode')) window.api.windowControl?.('expand')
  if (!state.loggedIn || !u) {
    lockEl.hidden = true
    authEl.classList.remove('hidden')
    document.getElementById('loginError').textContent = state.configError || state.error || ''
    tick()
    return
  }
  const name = u.email.split('@')[0]
  document.getElementById('userName').textContent = name
  document.getElementById('accEmail').textContent = u.email
  document.getElementById('accPlan').textContent = u.planLabel
  accExpire.textContent = u.lifetime ? 'Vitalício' : fmtDate(u.expiresAt)
  document.querySelector('.account').classList.toggle('is-active', state.active)
  authEl.classList.add('hidden')

  const locked = !state.active
  lockEl.hidden = !locked
  document.body.classList.toggle('locked', locked)
  if (locked) {
    tokenModal.open && tokenModal.close()
    document.getElementById('lockText').textContent = state.offline
      ? 'Não foi possível validar sua key com o servidor. Verifique sua internet ou digite uma nova key.'
      : `Sua key ${u.planLabel} expirou${u.expiresAt ? ` em ${fmtDate(u.expiresAt)}` : ''}. Digite uma nova key para continuar usando o RavokBot.`
    setTimeout(() => document.getElementById('lockKey').focus(), 50)
  }
  tick()
}

async function withSplash(work) {
  await window.showSplash(900)
  try {
    return await work()
  } finally {
    window.hideSplash()
  }
}

function validateCredentials(email, password) {
  if (!EMAIL_RE.test(email)) return 'Digite um e-mail válido.'
  if (password.length < 8) return 'A senha precisa ter pelo menos 8 caracteres.'
  return ''
}

const normalizeKey = (v) => v.toUpperCase().replace(/[^A-Z0-9-]/g, '').trim()

function busy(form, on) {
  form.querySelectorAll('button, input').forEach((el) => (el.disabled = on))
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const email = document.getElementById('loginEmail').value.trim().toLowerCase()
  const password = document.getElementById('loginPass').value
  const errorEl = document.getElementById('loginError')
  const error = validateCredentials(email, password)
  errorEl.textContent = error
  if (error) return
  const remember = document.getElementById('rememberMe').checked
  busy(loginForm, true)
  const res = await withSplash(() => lic.login({ email, password, remember }))
  busy(loginForm, false)
  if (!res.ok) {
    errorEl.textContent = res.error
    return
  }
  document.getElementById('loginPass').value = ''
  render(res.state)
  appendLog(`Login: ${email} — ${res.state.user.planLabel}`)
})

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const email = document.getElementById('regEmail').value.trim().toLowerCase()
  const password = document.getElementById('regPass').value
  const phone = document.getElementById('regPhone').value.replace(/\D/g, '')
  const key = normalizeKey(document.getElementById('regToken').value)
  const errorEl = document.getElementById('registerError')
  let error = validateCredentials(email, password)
  if (!error && (phone.length < 10 || phone.length > 13)) error = 'Digite um telefone válido com DDD.'
  if (!error && !KEY_RE.test(key)) error = 'Token inválido. Use o formato RB-XXXX-XXXX-XXXX-XXXX.'
  errorEl.textContent = error
  if (error) return
  busy(registerForm, true)
  const res = await withSplash(() => lic.register({ email, password, phone, key }))
  busy(registerForm, false)
  if (!res.ok) {
    errorEl.textContent = res.error
    return
  }
  registerForm.reset()
  render(res.state)
  appendLog(`Conta criada: ${email} — ${res.state.user.planLabel}`)
})

async function redeem(input, errorEl, form) {
  const key = normalizeKey(input.value)
  if (!KEY_RE.test(key)) {
    errorEl.textContent = 'Key inválida. Use o formato RB-XXXX-XXXX-XXXX-XXXX.'
    return false
  }
  errorEl.textContent = ''
  busy(form, true)
  const res = await lic.redeem(key)
  busy(form, false)
  if (!res.ok) {
    errorEl.textContent = res.error
    return false
  }
  input.value = ''
  render(res.state)
  appendLog(`Key ativada: ${res.state.user.planLabel}`)
  return true
}

lockForm.addEventListener('submit', (e) => {
  e.preventDefault()
  redeem(document.getElementById('lockKey'), document.getElementById('lockError'), lockForm)
})

tokenForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  if (await redeem(document.getElementById('tokenKey'), document.getElementById('tokenError'), tokenForm)) {
    tokenModal.close()
  }
})

document.getElementById('tokenBtn').addEventListener('click', () => {
  document.getElementById('tokenError').textContent = ''
  const u = current.user
  document.getElementById('tokenCurrent').textContent = u
    ? `Plano atual: ${u.planLabel} — ${u.lifetime ? 'vitalício' : `expira em ${fmtDate(u.expiresAt)}`}. O tempo da nova key é somado ao que resta.`
    : ''
  tokenModal.showModal()
})
document.getElementById('cancelToken').addEventListener('click', () => tokenModal.close())

document.querySelectorAll('[data-key-input]').forEach((input) => {
  input.addEventListener('input', () => {
    const raw = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^RB/, '').slice(0, 16)
    input.value = raw ? `RB-${raw.match(/.{1,4}/g).join('-')}` : ''
  })
})

async function openSupport() {
  const res = await lic.support()
  if (!res.ok) appendLog(`Suporte: ${res.error}`)
}
document.getElementById('supportBtn').addEventListener('click', openSupport)

const STORE_URL = 'https://bot.ravok.shop/#loja'
document.getElementById('storeBtn').addEventListener('click', () => {
  if (window.api.openStore) window.api.openStore()
  else window.open(STORE_URL, '_blank', 'noopener')
})
document.getElementById('lockSupport').addEventListener('click', openSupport)

document.querySelectorAll('[data-auth-go]').forEach((btn) => {
  btn.addEventListener('click', () => showAuthForm(btn.dataset.authGo))
})

document.querySelectorAll('[data-eye]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.eye)
    const show = input.type === 'password'
    input.type = show ? 'text' : 'password'
    btn.classList.toggle('on', show)
    btn.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha')
  })
})

async function logout() {
  await withSplash(() => lic.logout())
  loginForm.reset()
  registerForm.reset()
  render({ loggedIn: false, active: false, user: null })
  showAuthForm('login')
}
document.getElementById('logoutBtn').addEventListener('click', logout)
document.getElementById('lockLogout').addEventListener('click', logout)

lic.onUpdate((state) => {
  const wasLogged = current.loggedIn
  render(state)
  if (wasLogged && !state.loggedIn) showAuthForm('login')
})

window.initAuth = async () => {
  const state = await lic.state()
  render(state)
  if (!state.loggedIn) showAuthForm('login')
}
