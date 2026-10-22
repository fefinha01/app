/* Dashboard (relatórios) — liberado só para planos semanal, mensal, trimestral e vitalício.
   Os dados ficam em data.settings.dashboard (mesmo arquivo data.json do app). */
;(() => {
  const $ = (id) => document.getElementById(id)
  const view = $('view-dashboard')
  const navBtn = $('dashNav')
  if (!view || !navBtn) return

  /* ---------- Acesso por plano ---------- */
  const ALLOWED_PLAN = /seman|mensal|trimes|trimens|vital|lifetime|week|month|quarter/
  const plain = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')

  function planAllowed(state) {
    const u = state && state.user
    if (!state || !state.loggedIn || !u || !state.active) return false
    if (u.lifetime) return true
    return ALLOWED_PLAN.test(plain(`${u.plan} ${u.planLabel}`))
  }

  function applyAccess(state) {
    const ok = planAllowed(state)
    navBtn.hidden = !ok
    if (!ok && view.classList.contains('active')) {
      closeAll()
      document.querySelector('.nav-item[data-view="inicio"]')?.click()
    }
  }

  const lic = window.api && window.api.license
  if (lic) {
    lic.state?.().then(applyAccess).catch(() => {})
    lic.onUpdate?.(applyAccess)
    // auth.js atualiza #accPlan a cada login/renovação/expiração: reavalia o acesso nesses momentos
    const accPlan = $('accPlan')
    if (accPlan) {
      new MutationObserver(() => lic.state?.().then(applyAccess).catch(() => {})).observe(accPlan, {
        childList: true,
        characterData: true,
        subtree: true,
      })
    }
    $('accExpire') &&
      new MutationObserver(() => lic.state?.().then(applyAccess).catch(() => {})).observe($('accExpire'), {
        childList: true,
        characterData: true,
        subtree: true,
      })
  }

  /* ---------- Dados ---------- */
  const CATS = { proxy: 'Proxy', ferramentas: 'Ferramentas', equipe: 'Equipe', aleatorio: 'Aleatório' }

  function store() {
    // `data` vem do app.js (objeto carregado do data.json)
    if (!data.settings) data.settings = {}
    const d = data.settings.dashboard || (data.settings.dashboard = {})
    if (!Array.isArray(d.cycles)) d.cycles = []
    if (!Array.isArray(d.costs)) d.costs = []
    return d
  }
  const save = () => (typeof persist === 'function' ? persist() : Promise.resolve())
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7)

  /* ---------- Formatação ---------- */
  const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
  const money = (n) => brl.format(n || 0)
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + brl.format(Math.abs(n || 0))
  const pad2 = (n) => String(n).padStart(2, '0')
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
  const today = () => ymd(new Date())
  const brDate = (s) => (s ? s.split('-').reverse().join('/') : '—')
  const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '')

  function parseMoney(raw) {
    let s = String(raw || '').replace(/R\$|\s/g, '')
    if (!s) return 0
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
    const n = Number(s)
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN
  }
  const parseInt0 = (raw) => {
    const s = String(raw || '').trim()
    if (!s) return 0
    const n = Number(s)
    return Number.isInteger(n) && n >= 0 ? n : NaN
  }

  /* ---------- Filtro de período ---------- */
  let range = 'all'

  function bounds() {
    const now = new Date()
    if (range === 'day') return { from: today(), to: today(), label: `Hoje, ${brDate(today())}` }
    if (range === 'week') {
      const start = new Date(now)
      start.setDate(now.getDate() - ((now.getDay() + 6) % 7)) // segunda-feira
      const end = new Date(start)
      end.setDate(start.getDate() + 6)
      return { from: ymd(start), to: ymd(end), label: `Semana: ${brDate(ymd(start))} a ${brDate(ymd(end))}` }
    }
    if (range === 'month') {
      const start = new Date(now.getFullYear(), now.getMonth(), 1)
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0)
      const name = now.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
      return { from: ymd(start), to: ymd(end), label: `Mês: ${name}` }
    }
    if (range === 'custom') {
      let from = $('dshFrom').value || ''
      let to = $('dshTo').value || ''
      if (from && to && from > to) [from, to] = [to, from]
      const label =
        from || to ? `Período: ${from ? brDate(from) : 'início'} a ${to ? brDate(to) : 'hoje'}` : 'Período: todo o tempo'
      return { from, to, label }
    }
    return { from: '', to: '', label: 'Todo o tempo' }
  }

  const inRange = (date, b) => (!b.from || date >= b.from) && (!b.to || date <= b.to)

  function summary() {
    const d = store()
    const b = bounds()
    const cycles = d.cycles.filter((c) => inRange(c.date, b)).sort((x, y) => x.date.localeCompare(y.date) || x.createdAt - y.createdAt)
    const costs = d.costs.filter((c) => inRange(c.date, b))
    const sum = (arr, key) => arr.reduce((t, i) => t + (Number(i[key]) || 0), 0)
    const byCat = {}
    for (const k of Object.keys(CATS)) byCat[k] = costs.filter((c) => c.cat === k).reduce((t, c) => t + c.value, 0)
    const t = {
      deposito: sum(cycles, 'deposito'),
      saque: sum(cycles, 'saque'),
      bau: sum(cycles, 'bau'),
      contas: sum(cycles, 'contas'),
      gasto: sum(costs, 'value'),
    }
    t.resultado = t.saque + t.bau - t.deposito - t.gasto
    return { b, cycles, costs, byCat, t }
  }

  /* ---------- Render da página ---------- */
  function cell(text, className) {
    const td = document.createElement('td')
    td.textContent = text
    if (className) td.className = className
    return td
  }

  function render() {
    const { b, cycles, byCat, t } = summary()
    $('dshPeriodLabel').textContent = b.label
    $('dshDeposito').textContent = money(t.deposito)
    $('dshSaque').textContent = money(t.saque)
    $('dshBau').textContent = money(t.bau)
    $('dshGasto').textContent = money(t.gasto)
    $('dshContas').textContent = String(t.contas)
    const res = $('dshResultado')
    res.textContent = signed(t.resultado)
    res.className = `dsh-value ${cls(t.resultado)}`
    $('dshGastoSub').textContent = Object.entries(CATS)
      .filter(([k]) => byCat[k] > 0)
      .map(([k, label]) => `${label} ${money(byCat[k])}`)
      .join(' · ') || 'Sem custos no período'

    const body = $('dshCycleBody')
    body.replaceChildren()
    $('dshCycleEmpty').classList.toggle('hidden', cycles.length > 0)
    $('dshCycleTable').classList.toggle('hidden', cycles.length === 0)
    $('dshCycleCount').textContent = `${cycles.length} ciclo(s)`
    ;[...cycles].reverse().forEach((c) => {
      const net = c.saque + c.bau - c.deposito
      const tr = document.createElement('tr')
      tr.append(
        cell(brDate(c.date)),
        cell(String(c.contas)),
        cell(money(c.deposito)),
        cell(money(c.saque)),
        cell(money(c.bau)),
        cell(signed(net), `strong ${cls(net)}`),
      )
      const act = document.createElement('td')
      act.className = 'dsh-row-actions'
      const edit = document.createElement('button')
      edit.type = 'button'
      edit.className = 'icon-btn'
      edit.textContent = 'Editar'
      edit.addEventListener('click', () => openCycle(c))
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'icon-btn'
      del.textContent = 'Excluir'
      del.addEventListener('click', () =>
        ask('Excluir ciclo', `Excluir o ciclo de ${brDate(c.date)}? Essa ação não pode ser desfeita.`, 'Excluir', async () => {
          const d = store()
          d.cycles = d.cycles.filter((x) => x.id !== c.id)
          await save()
          render()
        }),
      )
      act.append(edit, del)
      tr.append(act)
      body.append(tr)
    })
  }

  document.querySelectorAll('#dshRanges [data-range]').forEach((btn) => {
    btn.addEventListener('click', () => {
      range = btn.dataset.range
      document.querySelectorAll('#dshRanges [data-range]').forEach((b) => {
        b.classList.toggle('active', b === btn)
        b.setAttribute('aria-pressed', String(b === btn))
      })
      $('dshCustom').classList.toggle('hidden', range !== 'custom')
      render()
    })
  })
  $('dshFrom').addEventListener('change', render)
  $('dshTo').addEventListener('change', render)
  navBtn.addEventListener('click', render)

  /* ---------- Pop-ups ---------- */
  const dialogs = ['dshCostModal', 'dshCycleModal', 'dshConfirmModal'].map($)
  function closeAll() {
    dialogs.forEach((m) => m.open && m.close())
  }
  dialogs.forEach((m) =>
    m.addEventListener('click', (e) => {
      if (e.target === m) m.close()
    }),
  )
  document.querySelectorAll('[data-dsh-close]').forEach((btn) =>
    btn.addEventListener('click', () => btn.closest('dialog').close()),
  )

  /* Confirmação genérica */
  let onConfirm = null
  function ask(title, text, okLabel, fn) {
    $('dshConfirmTitle').textContent = title
    $('dshConfirmText').textContent = text
    $('dshConfirmOk').textContent = okLabel
    onConfirm = fn
    $('dshConfirmModal').showModal()
  }
  $('dshConfirmOk').addEventListener('click', async () => {
    const fn = onConfirm
    onConfirm = null
    $('dshConfirmModal').close()
    if (fn) await fn()
  })

  /* ----- Adicionar custo ----- */
  let costCat = 'proxy'
  let editingCost = null

  function setCat(cat) {
    costCat = cat
    document.querySelectorAll('#dshCats [data-cat]').forEach((b) => {
      b.classList.toggle('active', b.dataset.cat === cat)
      b.setAttribute('aria-checked', String(b.dataset.cat === cat))
    })
  }
  document.querySelectorAll('#dshCats [data-cat]').forEach((b) => b.addEventListener('click', () => setCat(b.dataset.cat)))

  function resetCostForm() {
    editingCost = null
    setCat('proxy')
    $('dshCostValue').value = ''
    $('dshCostDate').value = today()
    $('dshCostNote').value = ''
    $('dshCostError').textContent = ''
    $('dshCostSubmit').textContent = 'Salvar custo'
    $('dshCostCancelEdit').classList.add('hidden')
  }

  function renderCostList() {
    const d = store()
    const totals = Object.fromEntries(Object.keys(CATS).map((k) => [k, 0]))
    d.costs.forEach((c) => (totals[c.cat] = (totals[c.cat] || 0) + c.value))
    const chips = $('dshCostTotals')
    chips.replaceChildren()
    for (const [k, label] of Object.entries(CATS)) {
      const chip = document.createElement('div')
      chip.className = 'dsh-chip'
      const a = document.createElement('span')
      a.textContent = label
      const bEl = document.createElement('strong')
      bEl.textContent = money(totals[k])
      chip.append(a, bEl)
      chips.append(chip)
    }
    const list = $('dshCostList')
    list.replaceChildren()
    const items = [...d.costs].sort((x, y) => y.date.localeCompare(x.date) || y.createdAt - x.createdAt)
    $('dshCostEmpty').classList.toggle('hidden', items.length > 0)
    items.forEach((c) => {
      const li = document.createElement('li')
      const info = document.createElement('div')
      info.className = 'dsh-cost-info'
      const top = document.createElement('strong')
      top.textContent = `${CATS[c.cat] || c.cat} — ${money(c.value)}`
      const sub = document.createElement('span')
      sub.className = 'muted'
      sub.textContent = `${brDate(c.date)}${c.note ? ' · ' + c.note : ''}`
      info.append(top, sub)
      const edit = document.createElement('button')
      edit.type = 'button'
      edit.className = 'icon-btn'
      edit.textContent = 'Editar'
      edit.addEventListener('click', () => {
        editingCost = c.id
        setCat(c.cat)
        $('dshCostValue').value = String(c.value).replace('.', ',')
        $('dshCostDate').value = c.date
        $('dshCostNote').value = c.note || ''
        $('dshCostError').textContent = ''
        $('dshCostSubmit').textContent = 'Salvar alterações'
        $('dshCostCancelEdit').classList.remove('hidden')
        $('dshCostValue').focus()
      })
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'icon-btn'
      del.textContent = 'Excluir'
      del.addEventListener('click', async () => {
        d.costs = d.costs.filter((x) => x.id !== c.id)
        if (editingCost === c.id) resetCostForm()
        await save()
        renderCostList()
        render()
      })
      li.append(info, edit, del)
      list.append(li)
    })
  }

  $('dshBtnCost').addEventListener('click', () => {
    resetCostForm()
    renderCostList()
    $('dshCostModal').showModal()
    $('dshCostValue').focus()
  })
  $('dshCostCancelEdit').addEventListener('click', resetCostForm)
  $('dshCostForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const value = parseMoney($('dshCostValue').value)
    const date = $('dshCostDate').value || today()
    if (!(value > 0)) {
      $('dshCostError').textContent = 'Digite um valor válido maior que zero.'
      return
    }
    const d = store()
    const note = $('dshCostNote').value.trim().slice(0, 60)
    if (editingCost) {
      const c = d.costs.find((x) => x.id === editingCost)
      if (c) Object.assign(c, { cat: costCat, value, date, note })
    } else {
      d.costs.push({ id: uid(), cat: costCat, value, date, note, createdAt: Date.now() })
    }
    await save()
    resetCostForm()
    renderCostList()
    render()
  })

  /* ----- Adicionar ciclo ----- */
  let editingCycle = null
  const cycFields = { contas: $('dshCycContas'), deposito: $('dshCycDeposito'), saque: $('dshCycSaque'), bau: $('dshCycBau') }

  function cyclePreview() {
    const dep = parseMoney(cycFields.deposito.value)
    const saq = parseMoney(cycFields.saque.value)
    const bau = parseMoney(cycFields.bau.value)
    const ok = [dep, saq, bau].every(Number.isFinite)
    const d0 = ok ? dep : 0
    const s0 = ok ? saq : 0
    const b0 = ok ? bau : 0
    const afterSaque = s0 - d0
    const final = afterSaque + b0
    $('dshPvDeposito').textContent = money(d0)
    $('dshPvSaque').textContent = money(s0)
    const a = $('dshPvAfter')
    a.textContent = signed(afterSaque)
    a.className = `strong ${cls(afterSaque)}`
    $('dshPvBau').textContent = '+' + money(b0)
    const f = $('dshPvFinal')
    f.textContent = signed(final)
    f.className = `dsh-pv-final ${cls(final)}`
    $('dshPvWord').textContent = final > 0 ? 'Lucro do ciclo' : final < 0 ? 'Prejuízo do ciclo' : 'Resultado do ciclo'
  }
  Object.values(cycFields).forEach((i) => i.addEventListener('input', cyclePreview))

  function openCycle(c) {
    editingCycle = c ? c.id : null
    $('dshCycleTitle').textContent = c ? 'Editar ciclo' : 'Adicionar ciclo'
    $('dshCycleSubmit').textContent = c ? 'Salvar alterações' : 'Confirmar ciclo'
    $('dshCycDate').value = c ? c.date : today()
    cycFields.contas.value = c ? c.contas : ''
    cycFields.deposito.value = c ? String(c.deposito).replace('.', ',') : ''
    cycFields.saque.value = c ? String(c.saque).replace('.', ',') : ''
    cycFields.bau.value = c ? String(c.bau).replace('.', ',') : ''
    $('dshCycleError').textContent = ''
    cyclePreview()
    $('dshCycleModal').showModal()
    cycFields.contas.focus()
  }
  $('dshBtnCycle').addEventListener('click', () => openCycle(null))
  $('dshCycleForm').addEventListener('submit', async (e) => {
    e.preventDefault()
    const contas = parseInt0(cycFields.contas.value)
    const deposito = parseMoney(cycFields.deposito.value)
    const saque = parseMoney(cycFields.saque.value)
    const bau = parseMoney(cycFields.bau.value)
    if (![contas, deposito, saque, bau].every(Number.isFinite)) {
      $('dshCycleError').textContent = 'Confira os campos: use apenas números (contas em número inteiro).'
      return
    }
    if (!contas && !deposito && !saque && !bau) {
      $('dshCycleError').textContent = 'Preencha ao menos um valor para registrar o ciclo.'
      return
    }
    const date = $('dshCycDate').value || today()
    const d = store()
    if (editingCycle) {
      const c = d.cycles.find((x) => x.id === editingCycle)
      if (c) Object.assign(c, { date, contas, deposito, saque, bau })
    } else {
      d.cycles.push({ id: uid(), date, contas, deposito, saque, bau, createdAt: Date.now() })
    }
    await save()
    $('dshCycleModal').close()
    render()
  })

  /* ----- Resetar ----- */
  $('dshBtnReset').addEventListener('click', () =>
    ask(
      'Resetar dashboard',
      'Tem certeza que deseja resetar? Todos os ciclos e custos serão apagados e isso não pode ser desfeito.',
      'Sim, resetar tudo',
      async () => {
        const d = store()
        d.cycles = []
        d.costs = []
        await save()
        render()
        if (typeof appendLog === 'function') appendLog('Dashboard resetado')
      },
    ),
  )

  /* ----- Gerar imagem ----- */
  function theme() {
    const cs = getComputedStyle(document.documentElement)
    const v = (n, f) => cs.getPropertyValue(n).trim() || f
    const dark = document.documentElement.dataset.theme === 'dark'
    return {
      bg: v('--bg', '#f3f6fb'),
      surface: v('--surface', '#ffffff'),
      tint: v('--tint', '#f7f9fd'),
      border: v('--border', '#e1e7f0'),
      text: v('--text', '#16233d'),
      muted: v('--muted', '#6b7890'),
      primary: v('--primary', '#1570ef'),
      pos: dark ? '#4ade80' : '#16a34a',
      neg: dark ? '#f87171' : '#d92d20',
      font: getComputedStyle(document.body).fontFamily || 'sans-serif',
    }
  }

  function drawReport(sum, logo) {
    const T = theme()
    const W = 1100
    const M = 40
    const rowH = 44
    const rows = sum.cycles.length
    const statsH = 2 * 96 + 14
    const headH = 110
    const subH = 38
    const tableTop = headH + statsH + subH + 56
    const tableH = 40 + Math.max(rows, 1) * rowH
    const H = tableTop + tableH + 70
    const scale = H * 2 > 16000 ? 1 : 2
    const cv = document.createElement('canvas')
    cv.width = W * scale
    cv.height = H * scale
    const c = cv.getContext('2d')
    c.scale(scale, scale)
    const f = (size, weight = 400) => `${weight} ${size}px ${T.font}`
    const col = (n) => (n > 0 ? T.pos : n < 0 ? T.neg : T.text)

    c.fillStyle = T.bg
    c.fillRect(0, 0, W, H)

    // Cabeçalho
    c.fillStyle = T.primary
    c.fillRect(0, 0, W, 8)
    let tx = M
    if (logo) {
      c.drawImage(logo, M, 30, 52, 52)
      tx = M + 68
    }
    c.fillStyle = T.text
    c.textBaseline = 'alphabetic'
    c.font = f(28, 700)
    c.fillText('Ravok Bot — Relatório', tx, 60)
    c.font = f(15)
    c.fillStyle = T.muted
    c.fillText(sum.b.label, tx, 84)
    c.textAlign = 'right'
    c.fillText(`Gerado em ${new Date().toLocaleString('pt-BR')}`, W - M, 60)
    c.textAlign = 'left'

    // Caixas de totais
    const items = [
      ['Total de depósito', money(sum.t.deposito), T.text],
      ['Total de saque', money(sum.t.saque), T.text],
      ['Total de baú', money(sum.t.bau), T.text],
      ['Total de gasto', money(sum.t.gasto), T.text],
      ['Total de contas', String(sum.t.contas), T.text],
      ['Resultado final', signed(sum.t.resultado), col(sum.t.resultado)],
    ]
    const gap = 14
    const bw = (W - 2 * M - 2 * gap) / 3
    const bh = 96
    items.forEach(([label, value, color], i) => {
      const x = M + (i % 3) * (bw + gap)
      const y = headH + Math.floor(i / 3) * (bh + gap)
      c.fillStyle = T.surface
      c.fillRect(x, y, bw, bh)
      c.strokeStyle = T.border
      c.lineWidth = 1
      c.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1)
      c.fillStyle = i === 5 ? color : T.primary
      c.fillRect(x, y, 4, bh)
      c.fillStyle = T.muted
      c.font = f(14, 600)
      c.fillText(label.toUpperCase(), x + 22, y + 34)
      c.fillStyle = color
      c.font = f(i === 5 ? 32 : 30, 700)
      c.fillText(value, x + 22, y + 74)
    })

    // Gastos por categoria
    const subY = headH + statsH + 26
    c.fillStyle = T.muted
    c.font = f(14)
    const catText = Object.entries(CATS)
      .map(([k, label]) => `${label}: ${money(sum.byCat[k])}`)
      .join('   •   ')
    c.fillText(`Gastos  —  ${catText}`, M, subY)

    // Tabela de ciclos
    let y = tableTop - 22
    c.fillStyle = T.text
    c.font = f(20, 700)
    c.fillText(`Ciclos (${rows})`, M, y)
    y += 14
    const cols = [
      ['Data', M + 16, 'left'],
      ['Contas', M + 220, 'right'],
      ['Depósito', M + 420, 'right'],
      ['Saque', M + 620, 'right'],
      ['Baú', M + 820, 'right'],
      ['Resultado', W - M - 16, 'right'],
    ]
    c.fillStyle = T.primary
    c.fillRect(M, y, W - 2 * M, 40)
    c.fillStyle = '#ffffff'
    c.font = f(14, 600)
    cols.forEach(([h, x, al]) => {
      c.textAlign = al
      c.fillText(h, x, y + 26)
    })
    y += 40
    if (!rows) {
      c.fillStyle = T.surface
      c.fillRect(M, y, W - 2 * M, rowH)
      c.fillStyle = T.muted
      c.textAlign = 'center'
      c.font = f(15)
      c.fillText('Nenhum ciclo no período', W / 2, y + 28)
    }
    sum.cycles.forEach((cy, i) => {
      const net = cy.saque + cy.bau - cy.deposito
      c.fillStyle = i % 2 ? T.tint : T.surface
      c.fillRect(M, y, W - 2 * M, rowH)
      c.font = f(15)
      c.fillStyle = T.text
      const vals = [brDate(cy.date), String(cy.contas), money(cy.deposito), money(cy.saque), money(cy.bau), signed(net)]
      vals.forEach((v, k) => {
        c.textAlign = cols[k][2]
        c.fillStyle = k === 5 ? col(net) : T.text
        c.font = f(15, k === 5 ? 700 : 400)
        c.fillText(v, cols[k][1], y + 28)
      })
      y += rowH
    })
    c.strokeStyle = T.border
    c.strokeRect(M + 0.5, tableTop - 8 + 0.5, W - 2 * M - 1, y - (tableTop - 8) - 1)

    c.textAlign = 'center'
    c.fillStyle = T.muted
    c.font = f(13)
    c.fillText('Resultado final = saque + baú − depósito − gastos', W / 2, H - 28)
    return cv
  }

  const toBlob = (cv) => new Promise((res) => cv.toBlob(res, 'image/png'))
  const loadLogo = () =>
    new Promise((res) => {
      const img = new Image()
      img.onload = () => res(img)
      img.onerror = () => res(null)
      img.src = 'logo.png'
    })

  $('dshBtnGen').addEventListener('click', async () => {
    const btn = $('dshBtnGen')
    btn.disabled = true
    try {
      const sum = summary()
      let blob = null
      const logo = await loadLogo()
      try {
        blob = await toBlob(drawReport(sum, logo))
      } catch {
        blob = null // canvas "tainted" pela logo em file:// → refaz sem a logo
      }
      if (!blob) blob = await toBlob(drawReport(sum, null))
      if (!blob) throw new Error('falha ao gerar a imagem')
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `ravok-relatorio-${today()}.png`
      document.body.append(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      if (typeof appendLog === 'function') appendLog(`Relatório gerado: ${a.download}`)
    } catch (err) {
      if (typeof appendLog === 'function') appendLog(`Erro ao gerar relatório: ${err.message}`)
    } finally {
      btn.disabled = false
    }
  })

  render()
})()
