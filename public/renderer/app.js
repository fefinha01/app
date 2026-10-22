const $ = (id) => document.getElementById(id)

let data = { proxies: [], settings: {} }
let displays = []

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'className') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value)
  }
  for (const child of [].concat(children)) if (child) node.append(child)
  return node
}

async function persist() {
  await window.api.saveData(data)
}

function proxyLabel(p) {
  return p.label || `${p.host}:${p.port}`
}

/* ---------- Navegação ---------- */
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b === btn))
    document
      .querySelectorAll('.view')
      .forEach((v) => v.classList.toggle('active', v.id === `view-${btn.dataset.view}`))
  })
})

/* ---------- Log ---------- */
function appendLog(message) {
  const log = $('log')
  log.textContent += message + '\n'
  log.scrollTop = log.scrollHeight
}

$('clearLog').addEventListener('click', () => {
  $('log').textContent = ''
})

/* ---------- Início ---------- */
function renderConfig() {
  const s = data.settings
  $('alwaysOnTop').checked = s.alwaysOnTop
  const isDark = s.theme === 'dark'
  $('themeToggle').checked = isDark
  document.documentElement.dataset.theme = isDark ? 'dark' : 'light'
  applyAccent(s.accentColor)

  const hasActiveProxy = data.proxies.some((p) => p.active !== false)
  const proxyOn = hasActiveProxy && s.proxyMode !== 'none'
  const toggle = $('proxyToggle')
  toggle.checked = proxyOn
  toggle.disabled = !hasActiveProxy
  $('proxyToggleLabel').title = hasActiveProxy ? '' : 'Ative uma proxy na aba Proxy para habilitar'
  const status = $('proxyStatus')
  status.textContent = proxyOn ? 'ONLINE' : 'OFF'
  status.className = `status-badge ${proxyOn ? 'on' : 'off'}`
  const escalate = $('proxyEscalate')
  escalate.checked = proxyOn && Boolean(s.proxyEscalate)
  escalate.disabled = !proxyOn
  $('proxyEscalateLabel').title = proxyOn ? '' : 'Ligue a Proxy para usar o escalonamento'

  const f8 = $('opProxyToggle')
  f8.disabled = !hasActiveProxy
  f8.classList.toggle('danger-outline', proxyOn)
  f8.classList.toggle('success-outline', hasActiveProxy && !proxyOn)
  f8.textContent = !hasActiveProxy
    ? '[F8] Sem proxy'
    : proxyOn
      ? '[F8] Desativar Proxy'
      : '[F8] Ativar Proxy'
  syncCompact()

  $('portraitMode').checked = Boolean(s.portraitMode)
  const emulation = s.emulation || 'app'
  document.querySelectorAll('#emulationList .switch').forEach((sw) => {
    sw.checked = sw.dataset.emuKey === emulation
  })

  if (document.activeElement !== $('url')) $('url').value = s.url || ''

  const total = (Number(s.rows) || 1) * (Number(s.cols) || 1)
  $('gridSummary').replaceChildren(
    'Ao clicar em Abrir telas, serão abertas ',
    el('strong', { text: String(total) }),
    ` janela(s) em grade ${s.rows}×${s.cols}.`,
  )
}

$('proxyToggle').addEventListener('change', async (e) => {
  await setProxyEnabled(e.target.checked)
})

async function setProxyEnabled(enabled) {
  data.settings.proxyMode = enabled ? 'list' : 'none'
  data.settings.fixedProxyId = null
  await persist()
  renderConfig()
  appendLog(`Proxy: ${enabled ? 'online' : 'off'}`)
}

function hasActiveProxy() {
  return data.proxies.some((p) => p.active !== false)
}

async function toggleProxyHotkey() {
  if (!hasActiveProxy()) {
    appendLog('[F8] Nenhuma proxy ativa cadastrada')
    return
  }
  const targets = $('windowTargets').value.trim()
  if (targets && openScreenCount > 0 && window.api.toggleProxyScoped) {
    const count = await window.api.toggleProxyScoped(targets)
    appendLog(`Proxy alternada em ${count || 0} tela(s) (${targets})`)
    return
  }
  await setProxyEnabled(data.settings.proxyMode === 'none')
}

$('opProxyToggle').addEventListener('click', toggleProxyHotkey)

let openScreenCount = 0

function sendControl() {
  window.api.setControl?.({
    mirror: $('mirrorToggle').checked,
    speed: Number($('speedHack').value) || 1,
    targets: $('windowTargets').value.trim(),
  })
}

function toggleMirror() {
  $('mirrorToggle').checked = !$('mirrorToggle').checked
  sendControl()
  syncCompact()
}

$('mirrorToggle').addEventListener('change', sendControl)
$('speedHack').addEventListener('change', sendControl)
let targetsTimer
$('windowTargets').addEventListener('input', () => {
  clearTimeout(targetsTimer)
  targetsTimer = setTimeout(sendControl, 400)
})

document.addEventListener('keydown', (e) => {
  if ((e.key !== 'F8' && e.key !== 'F2') || e.repeat) return
  e.preventDefault()
  // With screens open, the main process owns F2/F8 as global shortcuts and notifies us via onHotkey.
  if (openScreenCount > 0) return
  if (e.key === 'F8') toggleProxyHotkey()
  else toggleMirror()
})

window.api.onHotkey?.((key) => {
  if (key === 'F8') toggleProxyHotkey()
  if (key === 'F2') toggleMirror()
})

async function reloadScreens() {
  if (openScreenCount === 0) {
    appendLog('Nenhuma tela aberta para atualizar')
    return
  }
  const targets = $('windowTargets').value.trim()
  const count = await window.api.reloadAll(targets)
  appendLog(`Atualizando ${count} tela(s)`)
}

$('opReload').addEventListener('click', reloadScreens)

$('opPixSetup').addEventListener('click', async () => {
  if (openScreenCount === 0) {
    appendLog('Nenhuma tela aberta para cadastrar a chave PIX')
    return
  }
  const count = await window.api.setupPix?.($('windowTargets').value.trim(), { pixType: $('pixType').value })
  appendLog(`Cadastro de chave PIX iniciado em ${count || 0} tela(s)`)
})
$('opWithdraw').addEventListener('click', async () => {
  if (openScreenCount === 0) {
    appendLog('Nenhuma tela aberta para sacar')
    return
  }
  const count = await window.api.withdrawAll?.($('windowTargets').value.trim())
  appendLog(`Saque total iniciado em ${count || 0} tela(s)`)
})
$('cpWithdraw')?.addEventListener('click', () => $('opWithdraw').click())

$('opHome').addEventListener('click', async () => {
  if (openScreenCount === 0) {
    appendLog('Nenhuma tela aberta para voltar ao início')
    return
  }
  const count = await window.api.goHome?.($('windowTargets').value.trim())
  appendLog(`Voltando ao início em ${count || 0} tela(s)`)
})
$('cpHome')?.addEventListener('click', () => $('opHome').click())

async function openSitePage(key, label) {
  if (openScreenCount === 0) {
    appendLog(`Nenhuma tela aberta para abrir ${label}`)
    return
  }
  const count = await window.api.gotoSitePage?.($('windowTargets').value.trim(), key)
  appendLog(`Abrindo ${label} em ${count || 0} tela(s)`)
}
$('opReport')?.addEventListener('click', () => openSitePage('report', 'Relatório de Apostas'))
$('cpReport')?.addEventListener('click', () => openSitePage('report', 'Relatório de Apostas'))
$('opEvent')?.addEventListener('click', () => openSitePage('event', 'Página de Promoções'))
$('opSms')?.addEventListener('click', () => openSitePage('sms', 'Cadastrar SMS'))

async function runSlotSearch(query) {
  const text = String(query || '').trim()
  if (!text) {
    appendLog('Digite o nome do slot para buscar')
    return
  }
  if (openScreenCount === 0) {
    appendLog('Nenhuma tela aberta para buscar o slot')
    return
  }
  const count = await window.api.searchSlot?.($('windowTargets').value.trim(), text)
  appendLog(`Buscando slot "${text}" em ${count || 0} tela(s)`)
}
const slotKeyHandler = (e) => {
  if (e.key !== 'Enter' || e.nativeEvent?.isComposing || e.isComposing || e.keyCode === 229) return
  e.preventDefault()
  runSlotSearch(e.target.value)
}
$('slotSearchBtn')?.addEventListener('click', () => runSlotSearch($('slotSearch').value))
$('slotSearch')?.addEventListener('keydown', slotKeyHandler)
$('cpSlotBtn')?.addEventListener('click', () => runSlotSearch($('cpSlot').value))
$('cpSlot')?.addEventListener('keydown', slotKeyHandler)
$('openLog')?.addEventListener('click', async () => {
  const file = await window.api.openLog?.()
  if (file) appendLog(`Log completo: ${file}`)
})
$('refreshBtn').addEventListener('click', reloadScreens)

document.querySelectorAll('#emulationList .switch').forEach((sw) => {
  sw.addEventListener('change', async () => {
    if (!sw.checked) {
      sw.checked = true
      return
    }
    data.settings.emulation = sw.dataset.emuKey
    await persist()
    renderConfig()
    appendLog(`Emulação: ${sw.dataset.emu} (vale para as próximas telas abertas)`)
  })
})

$('proxyEscalate').addEventListener('change', async (e) => {
  data.settings.proxyEscalate = e.target.checked
  await persist()
  appendLog(`Escalar proxy: ${e.target.checked ? 'ligado' : 'desligado'}`)
})

const escalatedScreens = new Map()

function escalateFailedScreens(list) {
  if (!data.settings.proxyEscalate || data.settings.proxyMode === 'none') return
  for (const s of list) {
    if (!s.ipError) {
      escalatedScreens.delete(s.number)
      continue
    }
    if (escalatedScreens.get(s.number) === s.proxyLabel) continue
    escalatedScreens.set(s.number, s.proxyLabel)
    appendLog(`Tela ${s.number}: proxy falhou, escalando para a próxima`)
    window.api.rotateScreen(s.number)
  }
}

$('themeToggle').addEventListener('change', async (e) => {
  data.settings.theme = e.target.checked ? 'dark' : 'light'
  document.documentElement.dataset.theme = data.settings.theme
  await persist()
})

/* ---------- Tema (cor principal) ---------- */
const DEFAULT_ACCENT = '#1570ef'
const ACCENT_PRESETS = [
  ['Azul', '#1570ef'],
  ['Roxo', '#7c3aed'],
  ['Verde', '#16a34a'],
  ['Vermelho', '#dc2626'],
  ['Laranja', '#ea580c'],
  ['Rosa', '#db2777'],
  ['Ciano', '#0891b2'],
  ['Âmbar', '#ca8a04'],
  ['Grafite', '#475569'],
]

function normalizeHex(value) {
  return /^#[0-9a-f]{6}$/i.test(value || '') ? value.toLowerCase() : DEFAULT_ACCENT
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function mixHex(hex, withHex, amount) {
  const a = hexToRgb(hex)
  const b = hexToRgb(withHex)
  const out = a.map((c, i) => Math.round(c * amount + b[i] * (1 - amount)))
  return '#' + out.map((c) => c.toString(16).padStart(2, '0')).join('')
}

const ACCENT_VARS = ['--primary', '--primary-soft', '--primary-line', '--primary-hover', '--bolt-glow', '--sea-top', '--sea-bottom']
let currentAccent = DEFAULT_ACCENT

// The page CSP (style-src 'self') blocks injected <style> tags, so the accent is set through the CSSOM instead.
function applyAccent(color) {
  const hex = normalizeHex(color)
  currentAccent = hex
  const root = document.documentElement
  if (hex === DEFAULT_ACCENT) {
    ACCENT_VARS.forEach((name) => root.style.removeProperty(name))
  } else {
    const dark = root.dataset.theme === 'dark'
    const vars = dark
      ? {
          '--primary': mixHex(hex, '#ffffff', 0.82),
          '--primary-soft': mixHex(hex, '#121b2d', 0.25),
          '--primary-line': mixHex(hex, '#121b2d', 0.55),
          '--primary-hover': mixHex(hex, '#ffffff', 0.65),
          '--bolt-glow': mixHex(hex, '#ffffff', 0.82),
          '--sea-top': mixHex(hex, '#0b1220', 0.22),
          '--sea-bottom': mixHex(hex, '#0b1220', 0.1),
        }
      : {
          '--primary': hex,
          '--primary-soft': mixHex(hex, '#ffffff', 0.12),
          '--primary-line': mixHex(hex, '#ffffff', 0.35),
          '--primary-hover': mixHex(hex, '#000000', 0.85),
          '--bolt-glow': mixHex(hex, '#ffffff', 0.82),
          '--sea-top': mixHex(hex, '#ffffff', 0.18),
          '--sea-bottom': mixHex(hex, '#ffffff', 0.07),
        }
    Object.entries(vars).forEach(([name, value]) => root.style.setProperty(name, value))
  }
  renderAccentPicker(hex)
}

new MutationObserver(() => applyAccent(currentAccent)).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme'],
})

function renderAccentPicker(hex) {
  const grid = $('accentGrid')
  if (!grid) return
  if (!grid.childElementCount) {
    for (const [name, value] of ACCENT_PRESETS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'accent-swatch'
      btn.dataset.color = value
      btn.setAttribute('role', 'radio')
      btn.setAttribute('aria-label', name)
      btn.title = name
      btn.style.setProperty('--swatch', value)
      btn.innerHTML = `<span class="accent-dot" aria-hidden="true"></span><span class="accent-name">${name}</span>`
      btn.addEventListener('click', () => setAccent(value))
      grid.append(btn)
    }
  }
  grid.querySelectorAll('.accent-swatch').forEach((b) => {
    const on = b.dataset.color === hex
    b.classList.toggle('selected', on)
    b.setAttribute('aria-checked', String(on))
  })
  $('accentCustom').value = hex
  $('accentHex').textContent = hex.toUpperCase()
}

async function setAccent(color) {
  const hex = normalizeHex(color)
  data.settings.accentColor = hex
  applyAccent(hex)
  await persist()
}

$('accentCustom').addEventListener('input', (e) => applyAccent(e.target.value))
$('accentCustom').addEventListener('change', (e) => setAccent(e.target.value))
$('accentReset').addEventListener('click', () => setAccent(DEFAULT_ACCENT))

$('alwaysOnTop').addEventListener('change', async (e) => {
  data.settings.alwaysOnTop = e.target.checked
  await persist()
})

function renderScreens(list) {
  openScreenCount = list.length
  updatePlayButton()
  const ul = $('screenList')
  ul.replaceChildren()
  $('screenEmpty').classList.toggle('hidden', list.length > 0)
  escalateFailedScreens(list)
  for (const s of list) {
    const ipText = s.ip
      ? `${s.ip}${s.country ? ` (${s.country})` : ''}`
      : s.ipError
        ? 'falhou'
        : 'verificando...'
    ul.append(
      el('li', { className: 'screen-item' }, [
        el('div', { className: 'screen-top' }, [
          el('span', { className: 'screen-name', text: `Tela ${s.number}${s.device ? ` · ${s.device}` : ''}` }),
          el('span', {
            className: `screen-ip${s.ipError ? ' err' : s.ip ? (s.proxied ? ' on' : ' off') : ''}`,
            text: ipText,
          }),
        ]),
        el('span', { className: 'screen-proxy', text: s.proxyLabel, title: s.proxyLabel }),
        el('div', { className: 'screen-actions' }, [
          el('button', {
            className: 'btn small',
            text: 'Mostrar',
            onclick: () => window.api.focusScreen(s.number),
          }),
          el('button', {
            className: 'btn small',
            text: 'Recarregar',
            onclick: () => window.api.reloadScreen(s.number),
          }),
          el('button', {
            className: 'btn small',
            text: 'Trocar proxy',
            onclick: () => window.api.rotateScreen(s.number),
          }),
        ]),
      ]),
    )
  }
}

const PLAY_ICON = '<path d="M7 4v16l13-8z" />'
const CLOSE_ICON = '<path d="M6 6l12 12M18 6L6 18" />'
let playBusy = false

function updatePlayButton() {
  const btn = $('playBtn')
  const svg = btn.querySelector('svg')
  const label = btn.querySelector('span')
  const open = openScreenCount > 0
  btn.disabled = playBusy
  btn.classList.toggle('danger', open && !playBusy)
  btn.classList.toggle('primary', !open || playBusy)
  svg.classList.toggle('fill', !open)
  svg.innerHTML = open ? CLOSE_ICON : PLAY_ICON
  if (!playBusy) label.textContent = open ? 'Fechar' : 'Play'
}

$('launchForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  if (playBusy) return
  const label = $('playBtn').querySelector('span')
  if (openScreenCount > 0) {
    playBusy = true
    label.textContent = 'Fechando...'
    updatePlayButton()
    await window.api.closeAllScreens().catch(() => {})
    playBusy = false
    updatePlayButton()
    return
  }
  const url = $('url').value.trim()
  data.settings.url = url
  await persist()
  playBusy = true
  label.textContent = 'Abrindo...'
  updatePlayButton()
  try {
    await window.api.startScreens(url, {
      delayPerLink: $('delayPerLink').checked,
      delaySec: Math.max(1, Number($('accountQty').value) || 1),
      depositMin: Number($('depositMin').value) || 0,
      depositMax: Number($('depositMax').value) || 0,
    })
  } catch (err) {
    appendLog(`Erro: ${String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`)
  } finally {
    playBusy = false
    updatePlayButton()
  }
})

$('closeAllBtn').addEventListener('click', () => window.api.closeAllScreens())

/* ---------- Proxy ---------- */
function proxyLink(p) {
  return p.raw || [p.host, p.port, p.user, p.pass].filter(Boolean).join(':')
}

function renderProxies() {
  const list = $('proxyList')
  list.replaceChildren()
  const activeCount = data.proxies.filter((p) => p.active !== false).length
  $('proxyCount').textContent = `${data.proxies.length} proxy(ies) cadastrada(s) · ${activeCount} ativa(s)`
  $('proxyEmpty').classList.toggle('hidden', data.proxies.length > 0)

  for (const p of data.proxies) {
    const isActive = p.active !== false
    const address = `${p.host}:${p.port}`
    const hasAuth = Boolean(p.user)
    list.append(
      el('tr', { className: isActive ? '' : 'inactive' }, [
        el('td', {}, [
          iconButton(isActive ? ICONS.on : ICONS.off, isActive ? 'Desativar proxy' : 'Ativar proxy', isActive ? 'on' : '', async () => {
            p.active = !isActive
            if (!data.proxies.some((x) => x.active !== false)) data.settings.proxyMode = 'none'
            await persist()
            renderAll()
          }),
        ]),
        el('td', { className: 'proxy-label', text: p.label || address }),
        el('td', { className: 'proxy-proto', text: (p.protocol || 'http').toUpperCase() }),
        el('td', { className: 'proxy-addr', text: address }),
        authCell(hasAuth),
        el('td', { className: 'proxy-country', text: p.country || '—' }),
        el('td', {}, [
          el('div', { className: 'row-actions' }, [
            iconButton(ICONS.edit, 'Editar proxy', '', () => openProxyModal(p)),
            iconButton(ICONS.trash, 'Excluir proxy', 'del', async () => {
              data.proxies = data.proxies.filter((x) => x.id !== p.id)
              if (!data.proxies.some((x) => x.active !== false)) data.settings.proxyMode = 'none'
              await persist()
              renderAll()
            }),
          ]),
        ]),
      ]),
    )
  }
}

const ICONS = {
  on: '<path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/>',
  off: '<path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M2 8.82a15 15 0 0 1 4.17-2.65M10.66 5c4.01-.36 8.14.9 11.34 3.76M16.85 11.25a10 10 0 0 1 2.22 1.68M5 13a10 10 0 0 1 5.24-2.76M12 20h.01"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
}

function authCell(hasAuth) {
  const td = el('td', { className: `proxy-auth${hasAuth ? ' ok' : ''}` })
  if (!hasAuth) {
    td.textContent = '—'
    return td
  }
  td.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'
  td.append('autenticado')
  return td
}

function iconButton(paths, label, variant, onclick) {
  const btn = el('button', {
    type: 'button',
    className: `icon-action${variant ? ` ${variant}` : ''}`,
    title: label,
    'aria-label': label,
    onclick,
  })
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`
  return btn
}

function parseProxyLine(rawLine, defaultProtocol) {
  let line = rawLine.trim()
  if (!line || line.startsWith('#')) return null

  let protocol = defaultProtocol
  const protoMatch = line.match(/^(https?|socks5|socks4):\/\//i)
  if (protoMatch) {
    protocol = protoMatch[1].toLowerCase()
    line = line.slice(protoMatch[0].length)
  }

  let host, port, user = '', pass = ''
  const at = line.lastIndexOf('@')
  if (at !== -1) {
    const cred = line.slice(0, at)
    const sep = cred.indexOf(':')
    user = sep === -1 ? cred : cred.slice(0, sep)
    pass = sep === -1 ? '' : cred.slice(sep + 1)
    ;[host, port] = line.slice(at + 1).split(':')
  } else {
    const parts = line.split(':')
    host = parts[0]
    port = parts[1]
    user = parts[2] || ''
    pass = parts.slice(3).join(':')
  }

  const portNum = Number(port)
  if (!host || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return null
  return { id: crypto.randomUUID(), protocol, host, port: portNum, user, pass, label: '', active: true }
}

const proxyModal = $('proxyModal')

let editingProxyId = null

function openProxyModal(proxy = null) {
  editingProxyId = proxy?.id ?? null
  $('addProxyForm').reset()
  $('proxyError').classList.add('hidden')
  $('proxyModalTitle').textContent = proxy ? 'Editar proxy' : 'Adicionar proxy'
  $('proxySubmit').textContent = proxy ? 'Salvar' : 'Adicionar'
  if (proxy) $('proxyLink').value = proxyLink(proxy)
  proxyModal.showModal()
}

$('openAddProxy').addEventListener('click', () => openProxyModal())

$('cancelProxy').addEventListener('click', () => proxyModal.close())

proxyModal.addEventListener('click', (e) => {
  if (e.target === proxyModal) proxyModal.close()
})

$('addProxyForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const raw = $('proxyLink').value.trim()
  const parsed = parseProxyLine(raw, 'http')
  if (!parsed) {
    $('proxyError').classList.remove('hidden')
    return
  }
  const existing = data.proxies.find((x) => x.id === editingProxyId)
  if (existing) {
    Object.assign(existing, { ...parsed, id: existing.id, active: existing.active, label: existing.label, raw })
  } else {
    data.proxies.push({ ...parsed, raw })
  }
  await persist()
  proxyModal.close()
  appendLog(existing ? 'Proxy atualizada' : 'Proxy adicionada')
  renderAll()
})

const proxyListModal = $('proxyListModal')

$('openProxyList').addEventListener('click', () => {
  $('proxyListForm').reset()
  $('proxyListError').classList.add('hidden')
  proxyListModal.showModal()
})

$('cancelProxyList').addEventListener('click', () => proxyListModal.close())

proxyListModal.addEventListener('click', (e) => {
  if (e.target === proxyListModal) proxyListModal.close()
})

$('proxyListForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const lines = $('proxyListInput').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const valid = []
  let invalid = 0
  for (const raw of lines) {
    const parsed = parseProxyLine(raw, 'http')
    if (parsed) valid.push({ ...parsed, raw })
    else invalid++
  }
  if (!valid.length) {
    const error = $('proxyListError')
    error.textContent = 'Nenhuma proxy válida. Use uma por linha: host:porta:usuario:senha'
    error.classList.remove('hidden')
    return
  }
  data.proxies.push(...valid)
  await persist()
  proxyListModal.close()
  appendLog(`${valid.length} proxy(ies) adicionada(s) da lista${invalid ? ` · ${invalid} inválida(s) ignorada(s)` : ''}`)
  renderAll()
})

/* ---------- Telas ---------- */
function clampInput(input, min, max) {
  const n = Math.min(Math.max(Number(input.value) || min, min), max)
  input.value = n
  return n
}

function renderGridPreview(rows, cols) {
  const preview = $('gridPreview')
  preview.style.gridTemplateColumns = `repeat(${cols}, 1fr)`
  preview.style.gridTemplateRows = `repeat(${rows}, 1fr)`
  preview.replaceChildren()
  for (let i = 0; i < rows * cols; i++) {
    preview.append(el('div', { className: 'preview-cell', text: `Tela ${i + 1}` }))
  }
  $('gridCount').textContent = `= ${rows * cols} tela(s)`
}

function renderTelas() {
  const s = data.settings
  const select = $('display')
  select.replaceChildren()
  displays.forEach((d, i) => {
    const opt = el('option', {
      value: String(d.id),
      text: `Monitor ${i + 1}${d.primary ? ' (Principal)' : ''}: ${d.width}x${d.height}`,
    })
    if (d.id === s.displayId || (!s.displayId && d.primary)) opt.selected = true
    select.append(opt)
  })
  $('rows').value = s.rows
  $('cols').value = s.cols
  renderGridPreview(s.rows, s.cols)
}

;['rows', 'cols'].forEach((id) => {
  $(id).addEventListener('input', () => {
    const rows = Math.min(Math.max(Number($('rows').value) || 1, 1), 6)
    const cols = Math.min(Math.max(Number($('cols').value) || 1, 1), 8)
    renderGridPreview(rows, cols)
  })
})

$('saveGrid').addEventListener('click', async () => {
  data.settings.rows = clampInput($('rows'), 1, 6)
  data.settings.cols = clampInput($('cols'), 1, 8)
  data.settings.displayId = Number($('display').value) || null
  await persist()
  appendLog(`Grade salva: ${data.settings.rows}×${data.settings.cols}`)
  renderAll()
})

/* ---------- Múltiplos Links ---------- */
let editingLinkId = null

function multiLinks() {
  const ml = data.settings.multiLinks
  if (!ml || !Array.isArray(ml.links)) data.settings.multiLinks = { enabled: Boolean(ml?.enabled), links: [] }
  return data.settings.multiLinks
}

function validLink(value) {
  try {
    const u = new URL(String(value).trim())
    return ['http:', 'https:'].includes(u.protocol) ? u.href : null
  } catch {
    return null
  }
}

function showView(name) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name))
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`))
}

function linkDistribution(total, count) {
  const counts = new Array(count).fill(0)
  for (let i = 0; i < total; i++) counts[Math.min(count - 1, Math.floor((i * count) / total))]++
  return counts
}

function resetLinkForm() {
  editingLinkId = null
  $('linkInput').value = ''
  $('linkSubmit').textContent = 'Adicionar'
  $('linkCancel').classList.add('hidden')
  $('linkError').classList.add('hidden')
}

function renderLinks() {
  const ml = multiLinks()
  const active = ml.enabled && ml.links.length > 0
  $('multiLinksToggle').checked = ml.enabled
  $('linksStatus').textContent = !ml.enabled
    ? 'Desativado — as telas usam o link da tela Início.'
    : ml.links.length
      ? `Ativado — ${ml.links.length} link(s) serão usados ao clicar em Play.`
      : 'Ativado — cadastre pelo menos um link abaixo.'

  const btn = $('multiLinksBtn')
  btn.classList.toggle('ml-on', active)
  btn.lastChild.textContent = active ? ` Múltiplos Links (${ml.links.length})` : ' Múltiplos Links'
  $('url').required = !active
  $('url').disabled = active
  $('url').placeholder = active ? 'Usando Múltiplos Links' : 'https://site.com'

  const list = $('linksList')
  list.replaceChildren()
  $('linksEmpty').classList.toggle('hidden', ml.links.length > 0)
  ml.links.forEach((link, i) => {
    list.append(
      el('li', { className: `link-item${editingLinkId === link.id ? ' editing' : ''}` }, [
        el('span', { className: 'link-num', text: String(i + 1) }),
        el('span', { className: 'link-url', text: link.url, title: link.url }),
        el('button', {
          type: 'button',
          className: 'btn small',
          text: 'Editar',
          onclick: () => {
            editingLinkId = link.id
            $('linkInput').value = link.url
            $('linkSubmit').textContent = 'Salvar'
            $('linkCancel').classList.remove('hidden')
            $('linkError').classList.add('hidden')
            $('linkInput').focus()
            renderLinks()
          },
        }),
        el('button', {
          type: 'button',
          className: 'btn small danger-outline',
          text: 'Excluir',
          onclick: async () => {
            ml.links = ml.links.filter((l) => l.id !== link.id)
            if (editingLinkId === link.id) resetLinkForm()
            await persist()
            renderLinks()
            appendLog(`Link removido: ${link.url}`)
          },
        }),
      ]),
    )
  })

  const total = (Number(data.settings.rows) || 1) * (Number(data.settings.cols) || 1)
  const preview = $('linksPreview')
  if (ml.links.length && total) {
    const counts = linkDistribution(total, ml.links.length)
    preview.replaceChildren(
      `Com ${total} tela(s): `,
      ...counts.flatMap((c, i) => [i ? ' · ' : '', el('strong', { text: `Link ${i + 1}: ${c}` })]),
    )
  } else preview.replaceChildren()
}

$('multiLinksBtn').addEventListener('click', () => {
  renderLinks()
  showView('links')
})
$('linksBack').addEventListener('click', () => showView('inicio'))
$('linkCancel').addEventListener('click', () => {
  resetLinkForm()
  renderLinks()
})

$('multiLinksToggle').addEventListener('change', async (e) => {
  multiLinks().enabled = e.target.checked
  await persist()
  renderLinks()
  appendLog(`Múltiplos Links: ${e.target.checked ? 'ativado' : 'desativado'}`)
})

$('linkForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const url = validLink($('linkInput').value)
  if (!url) {
    $('linkError').classList.remove('hidden')
    return
  }
  const ml = multiLinks()
  const editing = ml.links.find((l) => l.id === editingLinkId)
  if (editing) editing.url = url
  else ml.links.push({ id: crypto.randomUUID(), url })
  appendLog(`${editing ? 'Link editado' : 'Link adicionado'}: ${url}`)
  resetLinkForm()
  await persist()
  renderLinks()
})

/* ---------- Preencher Dados (chaves PIX) ---------- */
let editingPixKeyId = null
const PIX_HINTS = {
  CPF: 'Somente números (11 dígitos)',
  Telefone: 'DDD + número, ex.: 11987654321',
  'E-mail': 'email@exemplo.com',
  'Chave aleatória': 'Chave aleatória (EVP)',
}

function pixData() {
  const pd = data.settings.pixData
  if (!pd || !Array.isArray(pd.keys)) data.settings.pixData = { enabled: Boolean(pd?.enabled), keys: [] }
  return data.settings.pixData
}

function normalizePixKey(type, raw) {
  const value = String(raw || '').trim()
  if (type === 'CPF') {
    const digits = value.replace(/\D/g, '')
    return digits.length === 11 ? digits : null
  }
  if (type === 'Telefone') {
    const digits = value.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '')
    return digits.length === 10 || digits.length === 11 ? digits : null
  }
  if (type === 'E-mail') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value.toLowerCase() : null
  return value.length >= 8 ? value : null
}

function resetPixKeyForm() {
  editingPixKeyId = null
  $('pixKeyInput').value = ''
  $('pixKeySubmit').textContent = 'Adicionar'
  $('pixKeyCancel').classList.add('hidden')
  $('pixKeyError').classList.add('hidden')
}

function updatePixKeyHint() {
  $('pixKeyInput').placeholder = PIX_HINTS[$('pixKeyType').value] || ''
}

function renderPixKeys() {
  const pd = pixData()
  $('pixDataToggle').checked = pd.enabled
  $('pixSameKey').checked = Boolean(data.settings.pixSameKey)
  $('pixDataStatus').textContent = !pd.enabled
    ? 'Desativado — o bot cadastra a senha e para no modal Adicionar PIX.'
    : pd.keys.length
      ? 'Ativado — o bot preenche a chave e clica em Adicionar.'
      : 'Ativado — cadastre pelo menos uma chave abaixo.'

  const list = $('pixKeysList')
  list.replaceChildren()
  $('pixKeysEmpty').classList.toggle('hidden', pd.keys.length > 0)
  pd.keys.forEach((k, i) => {
    list.append(
      el('li', { className: `link-item${editingPixKeyId === k.id ? ' editing' : ''}` }, [
        el('span', { className: 'link-num', text: String(i + 1) }),
        el('span', { className: 'pix-tag', text: k.type }),
        el('span', { className: 'link-url', text: k.value, title: k.value }),
        el('button', {
          type: 'button',
          className: 'btn small',
          text: 'Editar',
          onclick: () => {
            editingPixKeyId = k.id
            $('pixKeyType').value = k.type
            $('pixKeyInput').value = k.value
            $('pixKeySubmit').textContent = 'Salvar'
            $('pixKeyCancel').classList.remove('hidden')
            $('pixKeyError').classList.add('hidden')
            updatePixKeyHint()
            $('pixKeyInput').focus()
            renderPixKeys()
          },
        }),
        el('button', {
          type: 'button',
          className: 'btn small danger-outline',
          text: 'Excluir',
          onclick: async () => {
            pd.keys = pd.keys.filter((x) => x.id !== k.id)
            if (editingPixKeyId === k.id) resetPixKeyForm()
            await persist()
            renderPixKeys()
            appendLog(`Chave PIX removida: ${k.type} ${k.value}`)
          },
        }),
      ]),
    )
  })

  const counts = pd.keys.reduce((acc, k) => ({ ...acc, [k.type]: (acc[k.type] || 0) + 1 }), {})
  $('pixKeysSummary').replaceChildren(
    ...Object.entries(counts).flatMap(([type, c], i) => [i ? ' · ' : '', el('strong', { text: `${type}: ${c}` })]),
  )
}

function openPixData() {
  renderPixKeys()
  updatePixKeyHint()
  if (document.body.classList.contains('compact-mode')) $('cpExpand')?.click()
  showView('dados')
}

$('opPixData').addEventListener('click', openPixData)
$('cpPixData').addEventListener('click', openPixData)
$('dadosBack').addEventListener('click', () => showView('operacao'))
$('pixKeyType').addEventListener('change', updatePixKeyHint)
$('pixKeyCancel').addEventListener('click', () => {
  resetPixKeyForm()
  renderPixKeys()
})

$('pixDataToggle').addEventListener('change', async (e) => {
  pixData().enabled = e.target.checked
  await persist()
  renderPixKeys()
  appendLog(`Preencher Dados: ${e.target.checked ? 'ativado' : 'desativado'}`)
})

$('pixSameKey').addEventListener('change', async (e) => {
  data.settings.pixSameKey = e.target.checked
  await persist()
  appendLog(`Mesmas chaves para links diferentes: ${e.target.checked ? 'ativado' : 'desativado'}`)
})

$('pixKeyForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const type = $('pixKeyType').value
  const value = normalizePixKey(type, $('pixKeyInput').value)
  const showError = (msg) => {
    $('pixKeyError').textContent = msg
    $('pixKeyError').classList.remove('hidden')
  }
  if (!value) return showError(`Chave inválida. ${PIX_HINTS[type]}.`)
  const pd = pixData()
  if (pd.keys.some((k) => k.id !== editingPixKeyId && k.type === type && k.value === value)) {
    return showError('Essa chave já está cadastrada.')
  }
  const editing = pd.keys.find((k) => k.id === editingPixKeyId)
  if (editing) Object.assign(editing, { type, value })
  else pd.keys.push({ id: crypto.randomUUID(), type, value })
  appendLog(`${editing ? 'Chave PIX editada' : 'Chave PIX adicionada'}: ${type} ${value}`)
  resetPixKeyForm()
  await persist()
  renderPixKeys()
})

/* ---------- Modo compacto ---------- */
function syncCompact() {
  const pairs = [
    ['cpDepMin', 'depositMin'],
    ['cpDepMax', 'depositMax'],
    ['cpTargets', 'windowTargets'],
    ['cpPixType', 'pixType'],
  ]
  for (const [cp, src] of pairs) if (document.activeElement !== $(cp)) $(cp).value = $(src).value

  const mirrorOn = $('mirrorToggle').checked
  $('cpMirror').setAttribute('aria-pressed', String(mirrorOn))

  const f8 = $('opProxyToggle')
  const cpProxy = $('cpProxy')
  cpProxy.textContent = f8.textContent.replace('[F8] ', '')
  cpProxy.disabled = f8.disabled
  cpProxy.classList.toggle('cp-danger', f8.classList.contains('danger-outline'))
  cpProxy.classList.toggle('cp-success', f8.classList.contains('success-outline'))

  const speed = String(Number($('speedHack').value) || 1)
  document.querySelectorAll('.cp-speed button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.speed === speed))
  })
}

function bindCompactInput(cpId, srcId, eventName) {
  $(cpId).addEventListener(eventName, () => {
    $(srcId).value = $(cpId).value
    $(srcId).dispatchEvent(new Event(eventName, { bubbles: true }))
  })
}
bindCompactInput('cpDepMin', 'depositMin', 'input')
bindCompactInput('cpDepMax', 'depositMax', 'input')
bindCompactInput('cpTargets', 'windowTargets', 'input')
bindCompactInput('cpPixType', 'pixType', 'change')

$('cpMirror').addEventListener('click', toggleMirror)
$('cpProxy').addEventListener('click', toggleProxyHotkey)
$('cpReload').addEventListener('click', reloadScreens)

function paintBotButton(off) {
  const btn = $('cpBot')
  if (!btn) return
  btn.setAttribute('aria-pressed', String(off))
  btn.textContent = off ? 'Ativar Bot' : 'Desativar Bot'
}

async function refreshBotButton() {
  const res = await window.api.botState?.($('windowTargets').value.trim())
  paintBotButton(Boolean(res?.off))
}

$('cpBot')?.addEventListener('click', async () => {
  if (openScreenCount === 0) {
    appendLog('Nenhuma tela aberta para desativar o bot')
    return
  }
  const targets = $('windowTargets').value.trim()
  const res = await window.api.toggleBotScoped?.(targets)
  if (!res?.count) {
    appendLog(`Nenhuma tela encontrada em "${targets || 'todas'}"`)
    return
  }
  paintBotButton(res.off)
})
$('windowTargets').addEventListener('input', () => setTimeout(refreshBotButton, 450))

function paintMuteButton(muted) {
  const btn = $('cpMute')
  if (!btn) return
  btn.setAttribute('aria-pressed', String(muted))
  btn.textContent = muted ? 'Ativar som' : 'Silenciar'
}
window.api.muteState?.().then((res) => paintMuteButton(Boolean(res?.muted))).catch(() => {})
$('cpMute')?.addEventListener('click', async () => {
  const res = await window.api.toggleMute?.()
  paintMuteButton(Boolean(res?.muted))
})
$('cpPixSetup').addEventListener('click', () => $('opPixSetup').click())
$('cpExpand').addEventListener('click', () => window.api.windowControl?.('expand'))
document.querySelectorAll('.cp-speed button').forEach((b) => {
  b.addEventListener('click', () => {
    const speed = $('speedHack')
    speed.value = b.dataset.speed
    speed.dispatchEvent(new Event('input', { bubbles: true }))
    speed.dispatchEvent(new Event('change', { bubbles: true }))
  })
})
;['mirrorToggle', 'speedHack', 'pixType', 'windowTargets', 'depositMin', 'depositMax'].forEach((id) => {
  $(id).addEventListener('change', syncCompact)
  $(id).addEventListener('input', syncCompact)
})

let cpBoltTimer
function cpBoltLoop() {
  clearTimeout(cpBoltTimer)
  if (!document.body.classList.contains('compact-mode') || !window.ravokStrike) return
  window.ravokStrike($('cpBolts'), $('cpLogoStage'), 'cp-shake')
  cpBoltTimer = setTimeout(cpBoltLoop, 900 + Math.random() * 1400)
}

function bgBoltLoop() {
  const body = document.body
  const visible =
    window.ravokStrike &&
    !document.hidden &&
    body.classList.contains('can-compact') &&
    !body.classList.contains('compact-mode') &&
    !body.classList.contains('locked')
  if (visible) window.ravokStrike($('bgBolts'), $('bgLogoStage'), 'bg-shake')
  setTimeout(bgBoltLoop, 1100 + Math.random() * 1600)
}
if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) setTimeout(bgBoltLoop, 1500)

window.api.onCompact?.((on) => {
  document.body.classList.toggle('compact-mode', on)
  $('compactPanel').hidden = !on
  clearTimeout(cpBoltTimer)
  if (on) {
    syncCompact()
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) cpBoltTimer = setTimeout(cpBoltLoop, 300)
  }
})

window.api.onCompactPin?.((pinned) => {
  document.body.classList.toggle('compact-pinned', pinned)
  $('cpPin').setAttribute('aria-pressed', String(pinned))
  const label = pinned ? 'Desafixar posição' : 'Fixar posição'
  $('cpPin').setAttribute('aria-label', label)
  $('cpPin').title = label
  $('cpHint').textContent = pinned ? 'Posição fixada' : 'Arraste para mover'
})
$('cpPin').addEventListener('click', () => {
  const pinned = $('cpPin').getAttribute('aria-pressed') === 'true'
  window.api.windowControl?.(pinned ? 'unpin' : 'pin')
})

$('portraitMode').addEventListener('change', async (e) => {
  data.settings.portraitMode = e.target.checked
  await persist()
  appendLog(`Modo Retrato ${e.target.checked ? 'ativado' : 'desativado'} (vale para as próximas telas abertas)`)
})

/* ---------- Inicialização ---------- */
function renderAll() {
  renderConfig()
  renderProxies()
  renderTelas()
  renderLinks()
  renderPixKeys()
}

window.api.onLog(appendLog)
window.api.onScreens(renderScreens)

;(async () => {
  data = await window.api.getData()
  displays = await window.api.listDisplays()
  renderAll()
  window.initAuth?.()
  renderScreens(await window.api.listScreens())
  const activeEmu = document.querySelector('#emulationList .switch:checked')
  appendLog(`Emulação: ${activeEmu ? activeEmu.dataset.emu : 'Modo Aplicativo'}`)
  window.appReady = true
  window.hideSplash?.()
})()
