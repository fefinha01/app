;(() => {
  const splash = document.getElementById('splash')
  const splashStage = splash.querySelector('.splash-stage')
  let splashMinMs = 800
  let splashShownAt = performance.now()
  let splashHideTimer
  let firstHideDone = false
  window.hideSplash = () => {
    firstHideDone = true
    clearTimeout(splashHideTimer)
    const wait = Math.max(0, splashMinMs - (performance.now() - splashShownAt))
    splashHideTimer = setTimeout(() => splash.classList.add('done'), wait)
  }
  window.showSplash = (minMs = 1200) => {
    clearTimeout(splashHideTimer)
    splashMinMs = minMs
    splashShownAt = performance.now()
    splashStage.classList.remove('splash-shake')
    splashStage.style.animation = 'none'
    void splashStage.offsetWidth
    splashStage.style.animation = ''
    splash.classList.remove('done')
    return new Promise((resolve) => setTimeout(resolve, 260))
  }
  if (window.appReady) window.hideSplash()
  setTimeout(() => {
    if (!firstHideDone) window.hideSplash()
  }, 2500)

  const boltLayer = document.getElementById('splashBolts')
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const boltPath = (startX, startY, length, spread) => {
    const points = [[startX, startY]]
    let x = startX
    let y = startY
    const steps = 12 + Math.floor(Math.random() * 6)
    for (let i = 0; i < steps; i++) {
      y += length / steps
      x += (Math.random() - 0.5) * spread
      points.push([x, y])
    }
    return points
  }
  const toD = (points) => points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ')
  const addPath = (svg, d, cls) => {
    const p = document.createElementNS(SVG_NS, 'path')
    p.setAttribute('d', d)
    p.setAttribute('class', cls)
    p.setAttribute('vector-effect', 'non-scaling-stroke')
    svg.appendChild(p)
  }
  function strike(layer = boltLayer, stage = splashStage, shakeClass = 'splash-shake') {
    const main = boltPath(10 + Math.random() * 80, -2, 75 + Math.random() * 25, 9)
    const wrap = document.createElement('div')
    wrap.className = 'bolt-strike'
    const flash = document.createElement('div')
    flash.className = 'strike-flash'
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'bolt-real')
    svg.setAttribute('viewBox', '0 0 100 100')
    svg.setAttribute('preserveAspectRatio', 'none')
    addPath(svg, toD(main), 'bolt-glow')
    addPath(svg, toD(main), 'bolt-core')
    for (let i = 0; i < 2; i++) {
      const from = main[3 + Math.floor(Math.random() * 6)]
      addPath(svg, toD(boltPath(from[0], from[1], 15 + Math.random() * 20, 7)), 'bolt-branch')
    }
    wrap.append(flash, svg)
    layer.appendChild(wrap)
    stage.classList.remove(shakeClass)
    void stage.offsetWidth
    stage.classList.add(shakeClass)
    setTimeout(() => wrap.remove(), 900)
  }
  window.ravokStrike = strike
  let boltTimer
  function boltLoop() {
    clearTimeout(boltTimer)
    if (splash.classList.contains('done')) return
    strike()
    boltTimer = setTimeout(boltLoop, 550 + Math.random() * 700)
  }
  if (boltLayer && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    boltTimer = setTimeout(boltLoop, 180)
    new MutationObserver(() => {
      if (!splash.classList.contains('done')) {
        clearTimeout(boltTimer)
        boltTimer = setTimeout(boltLoop, 180)
      }
    }).observe(splash, { attributes: true, attributeFilter: ['class'] })
  }

  const content = document.querySelector('.content')
  const SCROLL_VIEWS = new Set(['view-proxy', 'view-contas', 'view-dashboard'])
  function fitView() {
    const view = content.querySelector('.view.active')
    if (!view) return
    content.querySelectorAll('.view').forEach((v) => {
      if (v !== view) v.style.zoom = ''
    })
    const scrolls = SCROLL_VIEWS.has(view.id)
    content.classList.toggle('scroll', scrolls)
    view.style.zoom = ''
    if (scrolls) return
    const cs = getComputedStyle(content)
    const availW = content.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    const availH = content.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
    const zoom = Math.min(1, availW / view.scrollWidth, availH / view.scrollHeight)
    if (zoom < 1) view.style.zoom = String(Math.max(0.4, zoom - 0.005))
  }
  window.fitView = fitView
  new ResizeObserver(() => requestAnimationFrame(fitView)).observe(content)
  new MutationObserver(() => requestAnimationFrame(fitView)).observe(content, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  })

  const qty = document.getElementById('accountQty')
  document.querySelectorAll('.step-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = (Number(qty.value) || 0) + Number(btn.dataset.step)
      qty.value = Math.max(1, next)
    })
  })

  document.querySelectorAll('.win-btn').forEach((btn) => {
    btn.addEventListener('click', () => window.api?.windowControl?.(btn.dataset.win))
  })

  const modal = document.getElementById('soonModal')
  const modalText = document.getElementById('soonText')
  document.querySelectorAll('[data-soon]').forEach((node) => {
    const open = (e) => {
      e.preventDefault()
      node.checked = false
      modalText.textContent = `A função "${node.dataset.soon}" ainda não está disponível.`
      modal.showModal()
    }
    node.addEventListener('click', open)
  })
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.close()
  })

  const speed = document.getElementById('speedHack')
  const speedValue = document.getElementById('speedValue')
  speed.addEventListener('input', () => (speedValue.textContent = `${speed.value}x`))
})()
