(() => {
  const $ = (sel) => document.querySelector(sel)
  const api = window.ravok
  const PAGES = ['welcome', 'folder', 'install', 'done', 'error']
  const STEP_OF = { welcome: 0, folder: 1, install: 2, done: 3, error: 2 }

  const state = { page: 'welcome', dir: '', installing: false, target: 0, shown: 0, raf: 0 }

  function show(page) {
    state.page = page
    for (const p of PAGES) $('#page-' + p).hidden = p !== page
    const current = STEP_OF[page]
    document.querySelectorAll('#steps li').forEach((li, i) => {
      li.classList.toggle('active', i === current)
      li.classList.toggle('past', i < current)
    })
  }

  function formatSize(bytes) {
    const mb = bytes / (1024 * 1024)
    return mb >= 1024 ? (mb / 1024).toFixed(1).replace('.', ',') + ' GB' : Math.round(mb) + ' MB'
  }

  // ---- barra de progresso suave ----
  function paint() {
    state.shown += (state.target - state.shown) * 0.18
    if (Math.abs(state.target - state.shown) < 0.05) state.shown = state.target
    const value = Math.max(0, Math.min(100, state.shown))
    $('#bar').style.width = value + '%'
    $('#pct').textContent = Math.floor(value)
    state.raf = state.shown === state.target && !state.installing ? 0 : requestAnimationFrame(paint)
  }
  function setProgress(pct) {
    state.target = Math.max(state.target, pct)
    if (!state.raf) state.raf = requestAnimationFrame(paint)
  }

  // ---- fluxo ----
  async function startInstall() {
    const dir = await api.normalizeDir($('#dir').value)
    $('#dir').value = dir
    state.dir = dir
    $('#dir-error').hidden = true
    state.target = 0
    state.shown = 0
    state.installing = true
    $('#install-text').textContent = 'Preparando a instalação…'
    show('install')
    setProgress(1)
    const res = await api.install({ dir, clean: $('#clean').checked && !$('#clean-row').hidden })
    if (!res.ok) {
      state.installing = false
      show('folder')
      const box = $('#dir-error')
      box.textContent = res.error || 'Não foi possível iniciar a instalação.'
      box.hidden = false
    }
  }

  function bind() {
    $('#btn-min').onclick = () => api.minimize()
    $('#btn-close').onclick = () => (state.installing ? ($('#modal').hidden = false) : api.close())
    $('#modal-no').onclick = () => ($('#modal').hidden = true)
    $('#modal-yes').onclick = () => {
      $('#modal').hidden = true
      api.close()
    }

    $('#btn-start').onclick = () => show('folder')
    $('#btn-back').onclick = () => show('welcome')
    $('#btn-browse').onclick = async () => {
      const picked = await api.pickDir($('#dir').value)
      if (picked) $('#dir').value = picked
    }
    $('#dir').addEventListener('change', async () => {
      $('#dir').value = await api.normalizeDir($('#dir').value)
    })
    $('#btn-install').onclick = startInstall
    $('#btn-cancel').onclick = () => ($('#modal').hidden = false)

    $('#btn-finish').onclick = () => {
      if ($('#open-after').checked) api.launch(state.dir)
      else api.close()
    }
    $('#btn-retry').onclick = () => show('folder')
    $('#btn-error-close').onclick = () => api.close()

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#modal').hidden) $('#modal').hidden = true
    })

    api.onProgress(({ pct, text }) => {
      if (text) $('#install-text').textContent = text
      setProgress(pct)
    })
    api.onDone((res) => {
      state.installing = false
      if (res.ok) {
        state.dir = res.dir || state.dir
        state.target = 100
        if (!state.raf) state.raf = requestAnimationFrame(paint)
        setTimeout(() => show('done'), 650)
      } else if (res.cancelled) {
        api.close()
      } else {
        $('#error-text').textContent = res.error || 'Erro desconhecido.'
        show('error')
      }
    })
  }

  async function init() {
    bind()
    const info = await api.init()
    state.dir = info.dir
    $('#dir').value = info.dir
    $('#version').textContent = 'v' + info.version
    $('#space').textContent = formatSize(info.installedBytes)
    $('#running-note').hidden = !info.running
    $('#clean-row').hidden = !info.hasOldData
    if (info.isUpdate) $('#page-welcome .lead').textContent = 'Vamos atualizar o RavokBot para a versão ' + info.version + '. Seus dados serão mantidos.'
    show('welcome')
  }

  init()
})()
