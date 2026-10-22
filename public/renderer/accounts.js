;(() => {
  const PAGE_SIZE = 15
  const byId = (id) => document.getElementById(id)
  let accounts = []
  let page = 1
  let editing = null
  let running = new Set()
  const selected = new Set()

  const make = (tag, props = {}, children = []) => {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(props)) {
      if (k === 'className') node.className = v
      else if (k === 'text') node.textContent = v
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
      else node.setAttribute(k, v)
    }
    for (const c of [].concat(children)) if (c) node.append(c)
    return node
  }

  const ICON_EDIT = '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>'
  const ICON_SAVE = '<path d="M20 6 9 17l-5-5"/>'
  const ICON_PIN = '<path d="M12 17v5M9 10.76V6h6v4.76a2 2 0 0 0 1.11 1.79l1.78.9A2 2 0 0 1 19 15.24V17H5v-1.76a2 2 0 0 1 1.11-1.79l1.78-.9A2 2 0 0 0 9 10.76zM8 2h8"/>'
  const ICON_DEL = '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>'

  const iconBtn = (paths, label, variant, onclick) => {
    const b = make('button', { type: 'button', className: `icon-action${variant ? ` ${variant}` : ''}`, title: label, 'aria-label': label, onclick })
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`
    return b
  }

  const fmtDate = (ts) =>
    new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })

  const filtered = () => {
    const q = byId('accSearch').value.trim().toLowerCase()
    const list = q
      ? accounts.filter((a) => [a.user, a.casa, a.siteId, a.name, a.proxy].some((v) => String(v || '').toLowerCase().includes(q)))
      : accounts
    return [...list.filter((a) => a.pinned), ...list.filter((a) => !a.pinned)]
  }

  const copyCell = (value, className) => {
    const td = make('td', { className })
    if (!value) {
      td.textContent = '—'
      return td
    }
    td.append(
      make('button', {
        type: 'button',
        className: 'acc-copy',
        title: 'Clique para copiar',
        text: value,
        onclick: async (e) => {
          await navigator.clipboard?.writeText(value).catch(() => {})
          const btn = e.currentTarget
          btn.classList.add('copied')
          setTimeout(() => btn.classList.remove('copied'), 900)
        },
      }),
    )
    return td
  }

  const editCell = (account, key, label) =>
    make('td', {}, [make('input', { className: 'acc-input', 'data-key': key, value: account[key] || '', 'aria-label': label })])

  const persist = () => window.api.saveAccounts?.(accounts)

  function render() {
    const list = filtered()
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
    page = Math.min(Math.max(page, 1), pages)
    const start = (page - 1) * PAGE_SIZE
    const rows = list.slice(start, start + PAGE_SIZE)

    for (const id of [...selected]) if (!accounts.some((a) => a.id === id)) selected.delete(id)
    byId('accCount').textContent = `${accounts.length} registro(s) · ${selected.size} selecionada(s) · armazenamento local criptografado (contas.json)`
    byId('accEmpty').classList.toggle('hidden', list.length > 0)
    byId('accEmpty').textContent = accounts.length
      ? 'Nenhuma conta encontrada para essa busca.'
      : 'Nenhuma conta cadastrada ainda. As contas criadas pelo bot aparecerão aqui automaticamente.'
    byId('accDelSelected').disabled = selected.size === 0
    byId('accDelAll').disabled = accounts.length === 0
    byId('accSelectAll').checked = rows.length > 0 && rows.every((a) => selected.has(a.id))
    byId('accPageInfo').textContent = `Página ${page} de ${pages} · Mostrando ${rows.length} de ${list.length}`
    byId('accPrev').disabled = page <= 1
    byId('accNext').disabled = page >= pages

    const body = byId('accList')
    body.replaceChildren()
    for (const a of rows) {
      const isEditing = editing === a.id
      const check = make('input', { type: 'checkbox', 'aria-label': `Selecionar ${a.user}` })
      check.checked = selected.has(a.id)
      check.addEventListener('change', () => {
        check.checked ? selected.add(a.id) : selected.delete(a.id)
        render()
      })
      const tr = make('tr', a.pinned ? { className: 'acc-pinned' } : {}, [
        make('td', {}, [check]),
        make('td', { className: 'acc-date', text: fmtDate(a.createdAt) }),
        make('td', { className: 'acc-casa', text: a.casa || '—', title: a.url || '' }),
        isEditing ? editCell(a, 'user', 'Usuário') : copyCell(a.user, 'acc-mono'),
        isEditing ? editCell(a, 'pass', 'Senha') : copyCell(a.pass, 'acc-mono'),
        make('td', { text: a.name || '—' }),
        isEditing ? editCell(a, 'saque', 'Senha de saque') : copyCell(a.saque, 'acc-mono'),
        make('td', { className: 'acc-pix', title: a.pix ? `${a.pixType || 'PIX'}: ${a.pix}` : '' }, [
          a.pix ? make('span', { className: 'acc-pix-type', text: a.pixType || 'PIX' }) : '',
          a.pix ? copyCell(a.pix, 'acc-mono').firstChild : make('span', { text: '—' }),
        ]),
        make('td', {}, [
          make('button', {
            type: 'button',
            className: `btn ${running.has(a.id) ? 'outline' : 'primary'} acc-open`,
            text: running.has(a.id) ? 'Fechar' : 'Abrir',
            onclick: async (e) => {
              const btn = e.currentTarget
              btn.disabled = true
              if (running.has(a.id)) await window.api.closeAccount?.(a.id)
              else await window.api.openAccount?.(a.id)
              running = new Set((await window.api.listRunningAccounts?.()) || [])
              render()
            },
          }),
        ]),
        make('td', { className: 'acc-proxy', text: a.proxy || 'Sem proxy' }),
        make('td', {}, [
          make('div', { className: 'row-actions' }, [
            (() => {
              const pinBtn = iconBtn(ICON_PIN, a.pinned ? 'Desafixar do topo' : 'Fixar no topo', a.pinned ? 'pin pinned' : 'pin', async () => {
                a.pinned = !a.pinned
                await persist()
                render()
              })
              pinBtn.setAttribute('aria-pressed', String(Boolean(a.pinned)))
              return pinBtn
            })(),
            iconBtn(isEditing ? ICON_SAVE : ICON_EDIT, isEditing ? 'Salvar' : 'Editar', isEditing ? 'on' : '', async () => {
              if (isEditing) {
                tr.querySelectorAll('.acc-input').forEach((input) => (a[input.dataset.key] = input.value.trim()))
                editing = null
                await persist()
              } else editing = a.id
              render()
            }),
            iconBtn(ICON_DEL, 'Excluir', 'del', async () => {
              accounts = accounts.filter((x) => x.id !== a.id)
              await persist()
              render()
            }),
          ]),
        ]),
      ])
      body.append(tr)
    }
  }

  byId('accSearch').addEventListener('input', () => {
    page = 1
    render()
  })
  byId('accPrev').addEventListener('click', () => {
    page--
    render()
  })
  byId('accNext').addEventListener('click', () => {
    page++
    render()
  })
  byId('accSelectAll').addEventListener('change', (e) => {
    const start = (page - 1) * PAGE_SIZE
    for (const a of filtered().slice(start, start + PAGE_SIZE)) e.target.checked ? selected.add(a.id) : selected.delete(a.id)
    render()
  })
  byId('accDelSelected').addEventListener('click', async () => {
    if (!selected.size || !confirm(`Excluir ${selected.size} conta(s) selecionada(s)?`)) return
    accounts = accounts.filter((a) => !selected.has(a.id))
    selected.clear()
    await persist()
    render()
  })
  byId('accDelAll').addEventListener('click', async () => {
    if (!accounts.length || !confirm(`Excluir todas as ${accounts.length} conta(s)? Faça um backup antes.`)) return
    accounts = []
    selected.clear()
    await persist()
    render()
  })
  byId('accBackup').addEventListener('click', () => window.api.backupAccounts?.())

  const card = byId('accTableCard')
  const topBar = byId('accHScroll')
  const topInner = byId('accHScrollInner')
  let syncing = false

  const syncWidth = () => {
    topInner.style.width = `${card.scrollWidth}px`
    topBar.classList.toggle('hidden', card.scrollWidth <= card.clientWidth + 1)
  }
  new ResizeObserver(syncWidth).observe(card)
  new ResizeObserver(syncWidth).observe(card.querySelector('table'))

  const mirror = (from, to) => () => {
    if (syncing) return
    syncing = true
    to.scrollLeft = from.scrollLeft
    requestAnimationFrame(() => (syncing = false))
  }
  card.addEventListener('scroll', mirror(card, topBar), { passive: true })
  topBar.addEventListener('scroll', mirror(topBar, card), { passive: true })

  const onWheel = (e) => {
    const max = card.scrollWidth - card.clientWidth
    if (max <= 0) return
    const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY)
    if (!e.shiftKey && !horizontal) return
    const delta = horizontal ? e.deltaX : e.deltaY
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? card.clientWidth : 1
    e.preventDefault()
    card.scrollLeft += delta * unit
  }
  card.addEventListener('wheel', onWheel, { passive: false })
  topBar.addEventListener('wheel', onWheel, { passive: false })

  let drag = null
  card.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input, a, select, textarea, label')) return
    if (card.scrollWidth <= card.clientWidth) return
    drag = { x: e.clientX, left: card.scrollLeft, moved: false }
  })
  window.addEventListener('mousemove', (e) => {
    if (!drag) return
    const dx = e.clientX - drag.x
    if (!drag.moved && Math.abs(dx) < 4) return
    drag.moved = true
    card.classList.add('dragging')
    card.scrollLeft = drag.left - dx
  })
  window.addEventListener('mouseup', () => {
    drag = null
    card.classList.remove('dragging')
  })

  window.api.onAccounts?.((list) => {
    accounts = Array.isArray(list) ? list : []
    if (editing && !accounts.some((a) => a.id === editing)) editing = null
    render()
  })
  window.api.onAccountsRunning?.((ids) => {
    running = new Set(Array.isArray(ids) ? ids : [])
    render()
  })
  ;(async () => {
    running = new Set((await window.api.listRunningAccounts?.()) || [])
    accounts = (await window.api.listAccounts?.()) || []
    render()
  })()
})()
