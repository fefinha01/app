const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  session,
  safeStorage,
  globalShortcut,
  nativeImage,
  dialog,
  shell,
} = require('electron')
const path = require('path')
const fs = require('fs')
const { randomInt, randomUUID, createHash, randomBytes } = require('crypto')
const { spawn } = require('child_process')
const { createLicense } = require('./license')

let license = null

const APP_NAME = 'RavokBot'
app.setName(APP_NAME)
if (process.platform === 'win32') app.setAppUserModelId('com.ravokbot.app')

const SETUP_TIMEOUT_MS = 15000
const BLOCKER_WAIT_MS = 6000
const STUCK_LOAD_MS = 25000
const OPEN_DELAY_MS = 350
const IP_TIMEOUT_MS = 15000
// Windows 10/11 draws an invisible resize border around top-level windows; without
// compensating, tiled Chrome windows show visible gaps between them.
const WIN_FRAME = process.platform === 'win32' ? { side: 7, bottom: 7 } : { side: 0, bottom: 0 }

const DEFAULT_DATA = {
  proxies: [],
  settings: {
    url: 'https://',
    rows: 1,
    cols: 3,
    displayId: null,
    proxyMode: 'none',
    proxyEscalate: false,
    emulation: 'app',
    adblock: true,
    assistant: true,
    alwaysOnTop: false,
    chromePath: '',
  },
}

const DEVICES = {
  android: [
    { model: 'SM-S918B', version: '14' },
    { model: 'Pixel 8', version: '14' },
    { model: 'moto g84 5G', version: '13' },
    { model: '23078PND5G', version: '13' },
  ],
  ios: ['18_5', '18_3', '17_6'],
}

let controlWin = null
let data = null
let blockerPromise = null
let chromeModules = null
const screens = new Map()
const control = { mirror: false, speed: 1, targets: new Set() }
const mirrorEchoUntil = new Map()

// "Todas" (empty field) covers every open screen, including the ones opened from Contas.
function isControlTarget(number) {
  if (control.targets.size === 0) return screens.has(number)
  return control.targets.has(number)
}

function inTargets(wanted, s) {
  return wanted.size === 0 || wanted.has(s.number)
}

function speedFor(number) {
  return isControlTarget(number) ? control.speed : 1
}

// Runs inside every screen page: makes the page's clock (timers, rAF, Date, performance.now) run `factor` times faster.
function speedShim() {
  if (window.__ravokSetSpeed) return
  const realPerfNow = performance.now.bind(performance)
  const RealDate = Date
  let factor = 1
  let baseReal = realPerfNow()
  let baseFake = baseReal
  let frameTime = null
  const clockNow = () => baseFake + (realPerfNow() - baseReal) * factor
  // performance.now must keep advancing inside animation frames: loaders (Pragmatic Play / PixiJS) parse assets
  // in a time budget like `while (performance.now() - start < 8ms)`. A frozen clock made that loop never end and
  // the loading bar froze halfway. Only the timestamp handed to the frame callbacks is the spaced frame time.
  const fakePerf = () => clockNow()
  const epochOffset = RealDate.now() - realPerfNow()
  const fakeDateNow = () => Math.round(epochOffset + fakePerf())
  Object.defineProperty(window, '__ravokSetSpeed', {
    value: (value) => {
      const next = Number(value)
      if (!(next > 0)) return
      baseFake = clockNow()
      baseReal = realPerfNow()
      factor = next
      for (const [id, timer] of timers) armTimer(id, timer)
      document.querySelectorAll('video,audio').forEach((m) => {
        try {
          m.playbackRate = next
        } catch {}
      })
    },
  })
  performance.now = fakePerf
  function FakeDate(...args) {
    if (!new.target) return new RealDate(fakeDateNow()).toString()
    // Reflect.construct keeps new.target, so `class X extends Date` and instanceof keep working.
    return Reflect.construct(RealDate, args.length ? args : [fakeDateNow()], new.target)
  }
  FakeDate.prototype = RealDate.prototype
  FakeDate.now = fakeDateNow
  FakeDate.parse = RealDate.parse
  FakeDate.UTC = RealDate.UTC
  window.Date = FakeDate
  const nativeTimeout = window.setTimeout.bind(window)
  const nativeClearTimeout = window.clearTimeout.bind(window)
  const nativeClearInterval = window.clearInterval.bind(window)
  // Timers live on the shim's own clock and are re-armed whenever the speed changes. Games (PG Soft / Cocos) create
  // their long timeouts and setInterval loops at boot, while the speed is still 1x; a plain "delay / factor" at
  // creation time never sped those up, so only part of the game reacted to the Speed Hack.
  const timers = new Map()
  let timerSeq = 2e9
  const armTimer = (id, timer) => {
    nativeClearTimeout(timer.native)
    timer.native = nativeTimeout(() => fireTimer(id), Math.max(0, (timer.due - clockNow()) / factor))
  }
  const fireTimer = (id) => {
    const timer = timers.get(id)
    if (!timer) return
    if (timer.repeat === null) timers.delete(id)
    else timer.due = Math.max(timer.due + timer.repeat, clockNow())
    try {
      if (typeof timer.fn === 'function') timer.fn.apply(window, timer.args)
      else (0, eval)(String(timer.fn))
    } catch (err) {
      nativeTimeout(() => {
        throw err
      }, 0)
    }
    if (timer.repeat !== null && timers.has(id)) armTimer(id, timer)
  }
  const addTimer = (fn, ms, args, repeat) => {
    const delay = Math.max(Number(ms) || 0, 0)
    const id = ++timerSeq
    const timer = { fn, args, due: clockNow() + delay, repeat: repeat ? Math.max(delay, 1) : null, native: 0 }
    timers.set(id, timer)
    armTimer(id, timer)
    return id
  }
  const dropTimer = (id, nativeClear) => {
    const timer = typeof id === 'number' ? timers.get(id) : undefined
    if (timer) {
      nativeClearTimeout(timer.native)
      timers.delete(id)
    } else nativeClear(id)
  }
  window.setTimeout = (fn, ms, ...rest) => addTimer(fn, ms, rest, false)
  window.setInterval = (fn, ms, ...rest) => addTimer(fn, ms, rest, true)
  window.clearTimeout = (id) => dropTimer(id, nativeClearTimeout)
  window.clearInterval = (id) => dropTimer(id, nativeClearInterval)
  // Games that advance one step per frame ignore the clock, so each real frame runs the
  // animation callbacks `factor` times, with evenly spaced timestamps that match the faster clock.
  const nativeRaf = window.requestAnimationFrame.bind(window)
  const nativeCancelRaf = window.cancelAnimationFrame.bind(window)
  // Queue ids live far above Chrome's own rAF ids so cancelAnimationFrame knows which one to cancel.
  const QUEUE_ID_BASE = 1e9
  let rafQueue = []
  let rafSeq = QUEUE_ID_BASE
  let rafPending = false
  let stepCarry = 0
  let lastFrame = null
  const STEP_BUDGET_MS = 14
  let stepCost = 1
  let allowedSteps = 12
  let lastRealFrame = null
  const pumpFrames = () => {
    rafPending = false
    const now = clockNow()
    const prev = lastFrame !== null && lastFrame < now ? lastFrame : now - (1000 / 60) * factor
    lastFrame = now
    stepCarry += factor
    const wanted = Math.min(Math.max(Math.floor(stepCarry), 1), 12)
    // Running the game's frame `factor` times per real frame multiplies its CPU/GPU work. Above ~4x that made every
    // real frame longer than the next one, rAF slowed down and the game froze. The number of steps is therefore capped
    // by a time budget (measured cost of one step); the clock still advances at full speed and the timestamps are
    // spread over the whole interval, so time-based games keep their speed and heavy ones just degrade smoothly.
    // GPU/compositor time does not show up in the callbacks' own duration, so the real frame interval also steers it:
    // slow frames shrink the allowed steps quickly, smooth frames give them back slowly.
    const realNow = realPerfNow()
    if (lastRealFrame !== null) {
      const dt = realNow - lastRealFrame
      if (dt > 26) allowedSteps = Math.max(1, allowedSteps * 0.7)
      else if (dt < 20) allowedSteps = Math.min(12, allowedSteps + 0.25)
    }
    lastRealFrame = realNow
    const steps = Math.min(
      wanted,
      Math.max(1, Math.floor(allowedSteps)),
      Math.max(1, Math.floor(STEP_BUDGET_MS / Math.max(stepCost, 0.5))),
    )
    stepCarry = steps < wanted ? stepCarry % 1 : Math.max(stepCarry - steps, 0)
    const startedAt = realPerfNow()
    let ran = 0
    try {
      for (let i = 1; i <= steps && rafQueue.length; i++) {
        ran++
        const batch = rafQueue
        rafQueue = []
        frameTime = prev + ((now - prev) * i) / steps
        for (const entry of batch) {
          try {
            entry.cb(frameTime)
          } catch (err) {
            nativeTimeout(() => {
              throw err
            }, 0)
          }
        }
      }
    } finally {
      frameTime = null
      if (ran > 0) stepCost = stepCost * 0.6 + ((realPerfNow() - startedAt) / ran) * 0.4
    }
    if (rafQueue.length && !rafPending) {
      rafPending = true
      nativeRaf(pumpFrames)
    }
  }
  window.requestAnimationFrame = (cb) => {
    // At 1x the shim is installed from the first script so engines that cache requestAnimationFrame at boot
    // (PG Soft / Cocos) still go through it later; until a speed is chosen it hands frames straight to Chrome,
    // only shifting the timestamp so it matches performance.now after a previous speed change.
    if (factor === 1 && !rafPending && !rafQueue.length) {
      const offset = baseFake - baseReal
      return nativeRaf((t) => cb(t + offset))
    }
    const id = ++rafSeq
    rafQueue.push({ id, cb })
    if (!rafPending) {
      rafPending = true
      nativeRaf(pumpFrames)
    }
    return id
  }
  window.cancelAnimationFrame = (id) => {
    if (typeof id === 'number' && id > QUEUE_ID_BASE) rafQueue = rafQueue.filter((entry) => entry.id !== id)
    else nativeCancelRaf(id)
  }
}

// 1.0.9 clock shim, used until the sign-up is done. Makes the page's clock (timers, rAF, Date, performance.now) run `factor` times faster.
function speedShimLegacy() {
  if (window.__ravokSetSpeed) return
  const realPerfNow = performance.now.bind(performance)
  const RealDate = Date
  let factor = 1
  let baseReal = realPerfNow()
  let baseFake = baseReal
  let frameTime = null
  const clockNow = () => baseFake + (realPerfNow() - baseReal) * factor
  const fakePerf = () => (frameTime ?? clockNow())
  const epochOffset = RealDate.now() - realPerfNow()
  const fakeDateNow = () => Math.round(epochOffset + fakePerf())
  Object.defineProperty(window, '__ravokSetSpeed', {
    value: (value) => {
      const next = Number(value)
      if (!(next > 0)) return
      baseFake = clockNow()
      baseReal = realPerfNow()
      factor = next
      document.querySelectorAll('video,audio').forEach((m) => {
        try {
          m.playbackRate = next
        } catch {}
      })
    },
  })
  performance.now = fakePerf
  function FakeDate(...args) {
    if (!new.target) return new RealDate(fakeDateNow()).toString()
    return args.length ? new RealDate(...args) : new RealDate(fakeDateNow())
  }
  FakeDate.prototype = RealDate.prototype
  FakeDate.now = fakeDateNow
  FakeDate.parse = RealDate.parse
  FakeDate.UTC = RealDate.UTC
  window.Date = FakeDate
  const nativeTimeout = window.setTimeout.bind(window)
  const nativeInterval = window.setInterval.bind(window)
  window.setTimeout = (fn, ms, ...rest) => nativeTimeout(fn, (Number(ms) || 0) / factor, ...rest)
  window.setInterval = (fn, ms, ...rest) => nativeInterval(fn, (Number(ms) || 0) / factor, ...rest)
  // Games that advance one step per frame ignore the clock, so each real frame runs the
  // animation callbacks `factor` times, with evenly spaced timestamps that match the faster clock.
  const nativeRaf = window.requestAnimationFrame.bind(window)
  let rafQueue = []
  let rafSeq = 0
  let rafPending = false
  let stepCarry = 0
  let lastFrame = null
  const STEP_BUDGET_MS = 14
  let stepCost = 1
  let allowedSteps = 12
  let lastRealFrame = null
  const pumpFrames = () => {
    rafPending = false
    const now = clockNow()
    const prev = lastFrame !== null && lastFrame < now ? lastFrame : now - (1000 / 60) * factor
    lastFrame = now
    stepCarry += factor
    const wanted = Math.min(Math.max(Math.floor(stepCarry), 1), 12)
    // Running the game's frame `factor` times per real frame multiplies its CPU/GPU work. Above ~4x that made every
    // real frame longer than the next one, rAF slowed down and the game froze. The number of steps is therefore capped
    // by a time budget (measured cost of one step); the clock still advances at full speed and the timestamps are
    // spread over the whole interval, so time-based games keep their speed and heavy ones just degrade smoothly.
    // GPU/compositor time does not show up in the callbacks' own duration, so the real frame interval also steers it:
    // slow frames shrink the allowed steps quickly, smooth frames give them back slowly.
    const realNow = realPerfNow()
    if (lastRealFrame !== null) {
      const dt = realNow - lastRealFrame
      if (dt > 26) allowedSteps = Math.max(1, allowedSteps * 0.7)
      else if (dt < 20) allowedSteps = Math.min(12, allowedSteps + 0.25)
    }
    lastRealFrame = realNow
    const steps = Math.min(
      wanted,
      Math.max(1, Math.floor(allowedSteps)),
      Math.max(1, Math.floor(STEP_BUDGET_MS / Math.max(stepCost, 0.5))),
    )
    stepCarry = steps < wanted ? stepCarry % 1 : Math.max(stepCarry - steps, 0)
    const startedAt = realPerfNow()
    let ran = 0
    try {
      for (let i = 1; i <= steps && rafQueue.length; i++) {
        ran++
        const batch = rafQueue
        rafQueue = []
        frameTime = prev + ((now - prev) * i) / steps
        for (const entry of batch) {
          try {
            entry.cb(frameTime)
          } catch (err) {
            nativeTimeout(() => {
              throw err
            }, 0)
          }
        }
      }
    } finally {
      frameTime = null
      if (ran > 0) stepCost = stepCost * 0.6 + ((realPerfNow() - startedAt) / ran) * 0.4
    }
    if (rafQueue.length && !rafPending) {
      rafPending = true
      nativeRaf(pumpFrames)
    }
  }
  window.requestAnimationFrame = (cb) => {
    const id = ++rafSeq
    rafQueue.push({ id, cb })
    if (!rafPending) {
      rafPending = true
      nativeRaf(pumpFrames)
    }
    return id
  }
  window.cancelAnimationFrame = (id) => {
    rafQueue = rafQueue.filter((entry) => entry.id !== id)
  }
}

// Runs inside every screen page: reports what the user does in the focused window so it can be replayed on the others.
function mirrorListener() {
  if (window.__ravokMirrorInstalled) return
  window.__ravokMirrorInstalled = true
  const emit = (ev) => {
    if (window.__ravokSynthetic || !document.hasFocus() || typeof window.__ravokMirrorEmit !== 'function') return
    window.__ravokMirrorEmit(ev).catch(() => {})
  }
  const pos = (e) => ({ rx: e.clientX / innerWidth, ry: e.clientY / innerHeight })
  let down = false
  let lastMove = 0
  addEventListener(
    'pointerdown',
    (e) => {
      if (!e.isPrimary) return
      down = true
      emit({ t: 'down', ...pos(e) })
    },
    true,
  )
  addEventListener(
    'pointermove',
    (e) => {
      if (!down || !e.isPrimary || e.timeStamp - lastMove < 16) return
      lastMove = e.timeStamp
      emit({ t: 'move', ...pos(e) })
    },
    true,
  )
  const up = (e) => {
    if (!down) return
    down = false
    emit({ t: 'up', ...pos(e) })
  }
  addEventListener('pointerup', up, true)
  addEventListener('pointercancel', up, true)
  addEventListener('wheel', (e) => emit({ t: 'wheel', ...pos(e), dx: e.deltaX, dy: e.deltaY }), {
    capture: true,
    passive: true,
  })
  addEventListener(
    'keydown',
    (e) => {
      if (/^F\d+$/.test(e.key)) return
      emit({
        t: 'key',
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        text: e.key === 'Enter' ? '\r' : e.key.length === 1 ? e.key : '',
        mods: (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0),
      })
    },
    true,
  )
}

// Speed changes (slider, buttons, new page, new screen) used to run concurrently for the same page: two calls could
// register their "set speed" scripts out of order and leave an old factor winning on the next document, which is the
// intermittent Speed Hack failure. Every call now waits for the previous one on that page and reads the factor only when
// it actually runs, so the last choice always wins.
function applySpeedToPage(state, page) {
  state.speedQueues ||= new WeakMap()
  const previous = state.speedQueues.get(page) || Promise.resolve()
  const next = previous.catch(() => {}).then(() => applySpeedToPageNow(state, page))
  const tail = next.catch(() => {})
  state.speedQueues.set(page, tail)
  return next.catch(() => {})
}

async function applySpeedToPageNow(state, page) {
  if (page.isClosed()) return
  const factor = speedFor(state.number)
  // The clock/timer/animation-frame replacements are only installed once a screen actually uses a speed other
  // than 1x. Running them on every page made game loaders (Pragmatic Play) stall halfway at normal speed.
  state.speedShimPages ||= new WeakSet()
  state.speedBasePages ||= new WeakSet()
  // PG Soft (Cocos) grabs requestAnimationFrame and the frame timestamps when the game boots, so a shim added
  // only after the user picks a speed never reached the running game. The base shim (pass-through at 1x) is
  // therefore registered from the start in every frame except Pragmatic's, which keeps the opt-in path below.
  if (!state.modern) {
    // Sign-up phase: exactly the 1.0.9 clock shim (native timers divided by the factor), nothing else.
    state.legacySpeedIds ||= new WeakMap()
    if (!state.legacySpeedIds.has(page)) {
      state.legacySpeedIds.set(page, null)
      const res = await page.evaluateOnNewDocument(speedShimLegacy).catch(() => null)
      state.legacySpeedIds.set(page, res?.identifier || null)
    }
  }
  if (state.modern && !state.speedBasePages.has(page)) {
    state.speedBasePages.add(page)
    await page.evaluateOnNewDocument(`if (!${GAME_FRAME_CHECK}) (${speedShim})()`).catch(() => {})
  }
  if (state.modern && factor !== 1 && !state.speedShimPages.has(page)) {
    state.speedShimPages.add(page)
    await page.evaluateOnNewDocument(speedShim).catch(() => {})
    await page.evaluateOnNewDocument(stealthShim).catch(() => {})
    await Promise.all(
      page.frames().map((frame) =>
        frame
          .evaluate(speedShim)
          .then(() => frame.evaluate(stealthShim))
          .catch(() => {}),
      ),
    )
  }
  const previous = state.speedScripts.get(page)
  if (previous) await page.removeScriptToEvaluateOnNewDocument(previous).catch(() => {})
  const { identifier } = await page
    .evaluateOnNewDocument((v) => window.__ravokSetSpeed?.(v), factor)
    .catch(() => ({ identifier: null }))
  if (identifier) state.speedScripts.set(page, identifier)
  await Promise.all(
    page.frames().map((frame) => frame.evaluate((v) => window.__ravokSetSpeed?.(v), factor).catch(() => {})),
  )
  const cdp = state.cdps.get(page)
  if (cdp) {
    await cdp.send('Animation.enable').catch(() => {})
    await cdp.send('Animation.setPlaybackRate', { playbackRate: factor }).catch(() => {})
  }
}

let screensMuted = false

function muteShim(on) {
  if (!window.__ravokMute) {
    const contexts = new Set()
    const state = { muted: false }
    const Base = window.BaseAudioContext || window.AudioContext || window.webkitAudioContext
    const proto = Base && Base.prototype
    const track = (ctx) => {
      if (!ctx || contexts.has(ctx)) return
      contexts.add(ctx)
      if (state.muted && ctx.state === 'running') ctx.suspend().catch(() => {})
    }
    if (proto) {
      const timeDesc = Object.getOwnPropertyDescriptor(proto, 'currentTime')
      if (timeDesc && timeDesc.get) {
        Object.defineProperty(proto, 'currentTime', {
          ...timeDesc,
          get() {
            track(this)
            return timeDesc.get.call(this)
          },
        })
      }
      for (const name of ['createBufferSource', 'createGain', 'createOscillator', 'createMediaElementSource', 'decodeAudioData']) {
        const original = proto[name]
        if (typeof original !== 'function') continue
        proto[name] = function (...args) {
          track(this)
          return original.apply(this, args)
        }
      }
    }
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (Ctx && typeof Ctx.prototype.resume === 'function') {
      const originalResume = Ctx.prototype.resume
      Ctx.prototype.resume = function (...args) {
        track(this)
        if (state.muted) return Promise.resolve()
        return originalResume.apply(this, args)
      }
      state.resume = (ctx) => originalResume.call(ctx).catch(() => {})
    }
    const media = window.HTMLMediaElement && HTMLMediaElement.prototype
    if (media) {
      const originalPlay = media.play
      media.play = function (...args) {
        if (state.muted) this.muted = true
        return originalPlay.apply(this, args)
      }
    }
    window.__ravokMute = (value) => {
      state.muted = Boolean(value)
      for (const ctx of contexts) {
        if (ctx.state === 'closed') continue
        if (state.muted) ctx.suspend().catch(() => {})
        else if (state.resume) state.resume(ctx)
      }
      document.querySelectorAll('audio, video').forEach((el) => {
        if (state.muted) {
          if (!el.muted) el.dataset.ravokMuted = '1'
          el.muted = true
        } else if (el.dataset.ravokMuted) {
          el.muted = false
          delete el.dataset.ravokMuted
        }
      })
    }
  }
  window.__ravokMute(on)
}

async function applyMuteToPage(state, page) {
  state.muteScripts ||= new WeakMap()
  const previous = state.muteScripts.get(page)
  if (previous) {
    await page.removeScriptToEvaluateOnNewDocument(previous).catch(() => {})
    state.muteScripts.delete(page)
  }
  if (screensMuted) {
    const { identifier } = await page.evaluateOnNewDocument(muteShim, true).catch(() => ({ identifier: null }))
    if (identifier) state.muteScripts.set(page, identifier)
  }
  await Promise.all(
    page.frames().map((frame) => (frame.client ? syncFrameClientMute(frame.client) : null)),
  )
  await Promise.all(
    page.frames().map((frame) =>
      (screensMuted
        ? frame.evaluate(muteShim, true)
        : frame.evaluate(() => window.__ravokMute?.(false))
      ).catch(() => {}),
    ),
  )
}

async function applyMuteAll() {
  await Promise.all(
    [...screens.values()].map(async (state) => {
      const pages = await state.browser.pages().catch(() => [])
      await Promise.all(pages.map((p) => applyMuteToPage(state, p)))
    }),
  )
}

async function applySpeedAll() {
  await Promise.all(
    [...screens.values()].map(async (state) => {
      try {
        const pages = await state.browser.pages().catch(() => [])
        await Promise.all(pages.map((p) => applySpeedToPage(state, p)))
      } catch {}
    }),
  )
}

async function dispatchMirror(target, ev) {
  const page = target.activePage
  const cdp = page && target.cdps.get(page)
  if (!cdp || page.isClosed()) return
  if (ev.t === 'down' || ev.t === 'wheel' || !target.viewport) {
    target.viewport = await page.evaluate(() => [innerWidth, innerHeight])
  }
  const [w, h] = target.viewport
  const x = ev.rx * w
  const y = ev.ry * h
  if (ev.t === 'down') {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  } else if (ev.t === 'move') {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
  } else if (ev.t === 'up') {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else if (ev.t === 'wheel') {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: ev.dx || 0,
      deltaY: ev.dy || 0,
    })
  } else if (ev.t === 'key') {
    const base = {
      key: ev.key,
      code: ev.code,
      windowsVirtualKeyCode: ev.keyCode,
      nativeVirtualKeyCode: ev.keyCode,
      modifiers: ev.mods || 0,
    }
    await cdp.send('Input.dispatchKeyEvent', {
      ...base,
      type: ev.text ? 'keyDown' : 'rawKeyDown',
      text: ev.text || undefined,
      unmodifiedText: ev.text || undefined,
    })
    await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
  }
}

function onMirrorEvent(state, page, ev) {
  state.activePage = page
  if (!control.mirror || !ev || typeof ev.t !== 'string') return
  // Automatic taps (PIX / saque) must not be copied to the other screens.
  if (state.pixBusy) return
  const now = Date.now()
  if ((mirrorEchoUntil.get(state.number) || 0) > now) return
  if (!isControlTarget(state.number)) return
  for (const other of screens.values()) {
    if (other === state || !isControlTarget(other.number)) continue
    mirrorEchoUntil.set(other.number, now + 300)
    other.mirrorQueue = (other.mirrorQueue || Promise.resolve())
      .then(() => dispatchMirror(other, ev))
      .catch(() => {})
  }
}

const dataFile = () => path.join(app.getPath('userData'), 'data.json')

function encrypt(text) {
  if (!text) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(text).toString('base64')
  }
  return text
}

function decrypt(text) {
  if (!text) return ''
  if (!text.startsWith('enc:')) return text
  try {
    return safeStorage.decryptString(Buffer.from(text.slice(4), 'base64'))
  } catch {
    return ''
  }
}

function loadData() {
  try {
    const raw = JSON.parse(fs.readFileSync(dataFile(), 'utf8'))
    return {
      proxies: (raw.proxies || []).map((p) => ({ ...p, pass: decrypt(p.pass) })),
      settings: { ...DEFAULT_DATA.settings, ...(raw.settings || {}) },
    }
  } catch {
    return structuredClone(DEFAULT_DATA)
  }
}

function saveData() {
  const out = {
    proxies: data.proxies.map((p) => ({ ...p, pass: encrypt(p.pass) })),
    settings: data.settings,
  }
  fs.writeFileSync(dataFile(), JSON.stringify(out, null, 2))
}

function logFilePath() {
  const day = new Date().toISOString().slice(0, 10)
  return path.join(app.getPath('userData'), 'logs', `ravokbot-${day}.log`)
}

function writeLogFile(line) {
  const file = logFilePath()
  fs.promises
    .mkdir(path.dirname(file), { recursive: true })
    .then(() => fs.promises.appendFile(file, line + '\n'))
    .catch(() => {})
}

function log(message) {
  const time = new Date().toLocaleTimeString('pt-BR')
  controlWin?.webContents.send('log', `[${time}] ${message}`)
  writeLogFile(`[${new Date().toLocaleString('pt-BR')}] ${message}`)
  license?.audit('app_log', message)
}

// Technical details only go to the log file (the panel would be flooded by hundreds of game assets).
function logFileOnly(message) {
  writeLogFile(`[${new Date().toLocaleString('pt-BR')}] ${message}`)
}

const shortUrl = (url) => {
  try {
    const u = new URL(url)
    const tail = u.pathname.length > 60 ? '…' + u.pathname.slice(-60) : u.pathname
    return u.host + tail
  } catch {
    return String(url).slice(0, 100)
  }
}

// Records why a page or game stops loading: JS errors, failed/blocked downloads, HTTP errors, crashes
// and a warning when the page goes quiet before finishing.
// Runs inside every frame (including game iframes): sends script errors, failed assets, rejected promises and
// console.error/warn to the log through a binding, without touching DevTools/console so anti-inspector checks stay quiet.
function diagReporter() {
  if (window.__ravokDiagInstalled) return
  try {
    Object.defineProperty(window, '__ravokDiagInstalled', { value: true })
  } catch {}
  const where = () => `${location.host || location.protocol}${location.pathname.slice(0, 40)}`
  const send = (kind, msg) => {
    try {
      if (typeof window.__ravokDiag === 'function') window.__ravokDiag(kind, where(), String(msg).slice(0, 600))
    } catch {}
  }
  const stackOf = (err) => {
    try {
      const lines = String((err && err.stack) || '').split('\n').slice(1, 5)
      return lines.length ? ` | pilha: ${lines.map((s) => s.trim().replace(/https?:\/\/[^/]+/g, '')).join(' <- ')}` : ''
    } catch {
      return ''
    }
  }
  if (window !== window.top) {
    try {
      send(
        'quadro',
        `iframe ${location.href === 'about:srcdoc' ? 'srcdoc' : location.host} | UA ${navigator.userAgent.slice(0, 90)} | tela ${screen.width}x${screen.height} | janela ${innerWidth}x${innerHeight} | toque ${navigator.maxTouchPoints}`,
      )
    } catch {}
  }
  const describe = (v) => {
    if (v instanceof Error) return `${v.name}: ${v.message}`
    if (v && typeof v === 'object') {
      try {
        return JSON.stringify(v).slice(0, 300)
      } catch {
        return Object.prototype.toString.call(v)
      }
    }
    return String(v)
  }
  const describeLite = (v) =>
    v instanceof Error ? `${v.name}: ${v.message}` : typeof v === 'object' && v !== null ? `[${typeof v}]` : String(v)
  addEventListener(
    'error',
    (e) => {
      const t = e.target
      if (t && t !== window && (t.src || t.href)) send('recurso', `não carregou ${t.tagName} ${t.src || t.href}`)
      else
        send(
          'erro',
          `${e.message || describe(e.error)} (${String(e.filename || '').split('/').pop()}:${e.lineno || 0}:${e.colno || 0})${stackOf(e.error)}`,
        )
    },
    true,
  )
  addEventListener('unhandledrejection', (e) => send('promessa', describe(e.reason)))
  window.__ravokDiagConsole = (level, args) => send(`console.${level}`, args.map(describeLite).join(' '))
  document.addEventListener('webglcontextlost', () => send('webgl', 'o contexto WebGL foi perdido'), true)
  if (window === window.top) {
    addEventListener('load', () => {
      try {
        const c = document.createElement('canvas')
        if (!c.getContext('webgl2') && !c.getContext('webgl')) send('webgl', 'WebGL indisponível (jogos não carregam sem ele)')
      } catch {}
    })
  }
}

async function attachPageDiagnostics(state, page, cdp) {
  const n = state.number
  const seen = new Set()
  let shown = 0
  const report = (key, message, { panel = true } = {}) => {
    if (seen.has(key)) return
    seen.add(key)
    logFileOnly(`Tela ${n} [diag] ${message}`)
    if (panel && shown < 15) {
      shown++
      log(`Tela ${n}: ${message}`)
    }
  }
  let lastActivity = Date.now()
  let loading = false
  let quietTimer = null
  const pending = new Map()
  const armQuietTimer = () => {
    clearTimeout(quietTimer)
    quietTimer = setTimeout(() => {
      if (!loading || page.isClosed()) return
      report(
        `quiet:${page.url()}`,
        `a página parou de baixar arquivos há ${Math.round((Date.now() - lastActivity) / 1000)}s sem terminar de carregar (${shortUrl(page.url())}). Veja os erros acima no log.`,
      )
      const now = Date.now()
      const stuck = [...pending.entries()].sort((a, b) => a[1] - b[1]).slice(0, 6)
      if (!stuck.length) logFileOnly(`Tela ${n} [diag] nenhum download pendente: o jogo/site está esperando algo dentro da própria página`)
      for (const [req, since] of stuck) {
        logFileOnly(`Tela ${n} [diag] ainda esperando ${req.resourceType()} ${shortUrl(req.url())} (há ${Math.round((now - since) / 1000)}s)`)
      }
    }, 20000)
  }
  page.on('requestfinished', (req) => pending.delete(req))
  await page
    .exposeFunction('__ravokDiag', (kind, where, msg) => {
      const panel = !kind.startsWith('console.')
      report(`${kind}:${msg}`, `[${kind}] ${msg} (em ${where})`, { panel })
    })
    .catch(() => {})
  if (cdp) {
    const sockets = new Map()
    await cdp.send('Network.enable').catch(() => {})
    cdp.on('Network.webSocketCreated', ({ requestId, url }) => {
      sockets.set(requestId, url)
      logFileOnly(`Tela ${n} [diag] websocket abrindo ${shortUrl(url)}`)
    })
    cdp.on('Network.webSocketHandshakeResponseReceived', ({ requestId, response }) => {
      const url = sockets.get(requestId) || ''
      if (response?.status === 101) logFileOnly(`Tela ${n} [diag] websocket conectado ${shortUrl(url)}`)
      else report(`ws-http:${url}`, `websocket recusado (${response?.status}) ${shortUrl(url)}`)
    })
    cdp.on('Network.webSocketFrameError', ({ requestId, errorMessage }) => {
      const url = sockets.get(requestId) || ''
      report(`ws-err:${url}:${errorMessage}`, `erro no websocket ${shortUrl(url)}: ${errorMessage}`)
    })
    cdp.on('Network.webSocketClosed', ({ requestId }) => {
      logFileOnly(`Tela ${n} [diag] websocket fechou ${shortUrl(sockets.get(requestId) || '')}`)
      sockets.delete(requestId)
    })
  }
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) {
      logFileOnly(`Tela ${n} [diag] iframe carregando ${shortUrl(frame.url())}`)
      return
    }
    seen.clear()
    shown = 0
    loading = true
    lastActivity = Date.now()
    logFileOnly(`Tela ${n} [diag] abrindo ${frame.url()}`)
    armQuietTimer()
  })
  page.on('load', () => {
    loading = false
    clearTimeout(quietTimer)
    logFileOnly(`Tela ${n} [diag] carregou ${shortUrl(page.url())}`)
  })
  page.on('request', (req) => {
    lastActivity = Date.now()
    if (pending.size < 500) pending.set(req, Date.now())
    if (loading) armQuietTimer()
  })
  page.on('pageerror', (err) => {
    let msg = err?.message || ''
    if (!msg && err && typeof err === 'object') {
      try {
        msg = JSON.stringify(err)
      } catch {}
    }
    msg = String(msg || err).split('\n')[0].slice(0, 200)
    report(`err:${msg}`, `erro no script da página: ${msg}`)
  })
  page.on('requestfailed', (req) => {
    pending.delete(req)
    const reason = req.failure()?.errorText || 'falhou'
    if (reason === 'net::ERR_ABORTED') return logFileOnly(`Tela ${n} [diag] cancelado ${shortUrl(req.url())}`)
    const blocked = reason === 'net::ERR_BLOCKED_BY_CLIENT'
    report(
      `fail:${req.url()}`,
      blocked
        ? `bloqueado pelo "Sem anúncios": ${shortUrl(req.url())}`
        : `falha ao baixar ${req.resourceType()} ${shortUrl(req.url())} (${reason})`,
      { panel: !blocked || ['document', 'script', 'xhr', 'fetch', 'websocket'].includes(req.resourceType()) },
    )
  })
  page.on('response', (res) => {
    const status = res.status()
    if (status < 400) return
    const type = res.request().resourceType()
    report(`http:${res.url()}`, `servidor respondeu ${status} para ${type} ${shortUrl(res.url())}`, {
      panel: ['document', 'script', 'xhr', 'fetch'].includes(type),
    })
  })
  page.on('error', (err) => report(`crash:${Date.now()}`, `a aba travou/fechou sozinha (${err?.message || 'crash'})`))
  page.once('close', () => clearTimeout(quietTimer))
}

function activeProxies() {
  return data.proxies.filter((p) => p.active !== false)
}

function proxyEnabled() {
  return data.settings.proxyMode !== 'none' && activeProxies().length > 0
}

function effectiveProxy(state) {
  // Screens reopened from Contas keep the proxy the account was created with, regardless of the global toggle.
  if (state.pinned) return state.pinnedProxy
  if (state.proxyOverride === false) return null
  if (state.proxyOverride === true) return state.proxy || null
  return proxyEnabled() ? state.proxy : null
}

function proxyLabel(proxy) {
  return proxy ? proxy.label || `${proxy.host}:${proxy.port}` : 'Sem proxy'
}

// Rotating gateways keep the same exit IP when the username carries a fixed session id: write {session} in the proxy user and it is replaced per screen/account.
function upstreamUrl(proxy, sessionId = '') {
  const fill = (v) => String(v || '').replace(/\{(session|sessao|sessão)\}/gi, sessionId)
  const auth = proxy.user
    ? `${encodeURIComponent(fill(proxy.user))}:${encodeURIComponent(fill(proxy.pass))}@`
    : ''
  return `${proxy.protocol || 'http'}://${auth}${proxy.host}:${proxy.port}`
}

function screensSnapshot() {
  return [...screens.values()]
    .sort((a, b) => a.number - b.number)
    .map((s) => ({
      number: s.number,
      ip: s.ip,
      country: s.country,
      ipError: s.ipError,
      device: s.device.label,
      proxyLabel: proxyLabel(effectiveProxy(s)),
      proxied: Boolean(effectiveProxy(s)),
      accountId: s.accountId && s.fromAccount ? s.accountId : null,
    }))
}

function notifyScreens() {
  controlWin?.webContents.send('screens:update', screensSnapshot())
}

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)]
}

function buildDevice(kind, standalone) {
  if (kind === 'ios') {
    const v = randomItem(DEVICES.ios)
    return {
      kind,
      label: 'iOS',
      standalone,
      platform: 'iPhone',
      userAgent: `Mozilla/5.0 (iPhone; CPU iPhone OS ${v} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v.split('_').slice(0, 2).join('.')} Mobile/15E148 Safari/604.1`,
    }
  }
  const d = randomItem(DEVICES.android)
  const major = process.versions.chrome.split('.')[0]
  return {
    kind: 'android',
    label: 'Android',
    standalone,
    platform: 'Linux armv81',
    userAgent: `Mozilla/5.0 (Linux; Android ${d.version}; ${d.model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
    metadata: {
      brands: [
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major },
        { brand: 'Not?A_Brand', version: '99' },
      ],
      platform: 'Android',
      platformVersion: `${d.version}.0.0`,
      architecture: '',
      model: d.model,
      mobile: true,
    },
  }
}

function pickDevice() {
  const mode = data.settings.emulation || 'app'
  if (mode === 'android') return buildDevice('android', false)
  if (mode === 'ios') return buildDevice('ios', false)
  const kind = Math.random() < 0.5 ? 'android' : 'ios'
  return buildDevice(kind, mode === 'app' || mode === 'standalone')
}

// Game provider iframes (Pragmatic Play "gs2c" loader and its about:srcdoc child, which inherits the parent's
// base URL) crashed with "Cannot read properties of undefined (reading 'split')" in build.js and froze the
// loading bar. The bot's page scripts (device/stealth shims, auto-click assistant) stay out of these frames;
// the real mobile emulation still applies through the browser itself.
const GAME_FRAME_CHECK = `(() => {
  try {
    if (window === window.top) return false
    return /\\/gs2c\\/|pragmaticplay|ppgames|\\/game\\/load/i.test(String(document.baseURI) + ' ' + location.href)
  } catch { return false }
})()`

function deviceShim(device, legacy = false) {
  return `(() => {
    const def = (obj, key, value) => { try { Object.defineProperty(obj, key, { get: () => value, configurable: true }) } catch {} }
    def(Navigator.prototype, 'maxTouchPoints', 5)
    ${legacy ? '' : `try {
      if (!('orientation' in window)) {
        Object.defineProperty(window, 'orientation', {
          get: () => (window.innerHeight >= window.innerWidth ? 0 : 90),
          enumerable: true,
          configurable: true,
        })
      }
    } catch {}`}
    ${
      device.kind === 'ios'
        ? `def(Navigator.prototype, 'vendor', 'Apple Computer, Inc.')
    def(Navigator.prototype, 'userAgentData', undefined)`
        : ''
    }
    ${
      device.standalone
        ? `def(Navigator.prototype, 'standalone', true)
    const original = window.matchMedia.bind(window)
    window.matchMedia = (query) => {
      if (/display-mode\\s*:\\s*(standalone|fullscreen)/.test(query)) {
        const mql = original('(min-width: 0px)')
        return Object.assign(Object.create(Object.getPrototypeOf(mql)), {
          matches: /standalone/.test(query), media: query, onchange: null,
          addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false },
        })
      }
      return original(query)
    }`
        : ''
    }
  })()`
}

// Runs last in every page. Sites with anti-DevTools scripts (disable-devtool, devtools-detector) thought the
// inspector was open and blocked/redirected the page, because: the automation connection serializes every
// console.log (their getter traps fire), outerWidth/innerWidth differ under mobile emulation, and the bot's
// replaced functions (setTimeout, Date, ...) no longer print "[native code]".
function stealthShim() {
  const nativeToString = Function.prototype.toString
  const masked = new WeakMap()
  const isNative = (fn) => {
    try {
      return /\{\s*\[native code\]\s*\}\s*$/.test(nativeToString.call(fn))
    } catch {
      return true
    }
  }
  const mask = (fn, name) => {
    if (typeof fn === 'function' && !masked.has(fn)) masked.set(fn, `function ${name}() { [native code] }`)
  }
  const setProp = (fn, key, value) => {
    try {
      Object.defineProperty(fn, key, { value, configurable: true })
    } catch {}
  }
  const toString = {
    toString() {
      return masked.has(this) ? masked.get(this) : nativeToString.call(this)
    },
  }.toString
  mask(toString, 'toString')
  try {
    Object.defineProperty(Function.prototype, 'toString', { value: toString, writable: true, configurable: true })
  } catch {}

  const consoleMethods = ['log', 'debug', 'info', 'warn', 'error', 'table', 'dir', 'dirxml', 'trace', 'clear', 'count',
    'countReset', 'group', 'groupCollapsed', 'groupEnd', 'time', 'timeLog', 'timeEnd', 'assert', 'profile', 'profileEnd', 'timeStamp']
  for (const key of consoleMethods) {
    if (typeof console[key] !== 'function') continue
    const forward = key === 'error' || key === 'warn'
    const silent = {
      [key](...args) {
        if (forward && typeof window.__ravokDiagConsole === 'function') {
          try {
            window.__ravokDiagConsole(key, args)
          } catch {}
        }
      },
    }[key]
    mask(silent, key)
    try {
      console[key] = silent
    } catch {}
  }

  for (const [outer, inner] of [['outerWidth', 'innerWidth'], ['outerHeight', 'innerHeight']]) {
    const accessors = {
      get [outer]() {
        return window[inner]
      },
      set [outer](_) {},
    }
    const { get, set } = Object.getOwnPropertyDescriptor(accessors, outer)
    mask(get, `get ${outer}`)
    mask(set, `set ${outer}`)
    try {
      Object.defineProperty(window, outer, { get, set, enumerable: true, configurable: true })
    } catch {}
  }

  const replaced = [
    [window, 'setTimeout'], [window, 'setInterval'], [window, 'clearTimeout'], [window, 'clearInterval'], [window, 'requestAnimationFrame'], [window, 'cancelAnimationFrame'],
    [window, 'Date'], [window.Date, 'now'], [performance, 'now'], [window, 'matchMedia'],
  ]
  for (const [obj, key] of replaced) {
    const fn = obj && obj[key]
    if (typeof fn !== 'function' || isNative(fn)) continue
    mask(fn, key)
    setProp(fn, 'name', key)
  }
  if (!isNative(window.Date)) setProp(window.Date, 'length', 7)

  for (const key of ['maxTouchPoints', 'vendor', 'userAgentData', 'standalone']) {
    const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, key)
    if (desc && desc.get && !isNative(desc.get)) mask(desc.get, `get ${key}`)
  }
  const orientationDesc = Object.getOwnPropertyDescriptor(window, 'orientation')
  if (orientationDesc && orientationDesc.get && !isNative(orientationDesc.get)) mask(orientationDesc.get, 'get orientation')

  for (const key of ['__ravokMirrorEmit', '__ravokAssistReport', '__ravokSetSpeed', '__ravokMirrorInstalled', '__ravokIpTimer']) {
    const desc = Object.getOwnPropertyDescriptor(window, key)
    if (desc && desc.configurable && desc.enumerable) {
      try {
        Object.defineProperty(window, key, { ...desc, enumerable: false })
      } catch {}
    }
  }
}

function ipOverlay(info) {
  const prefix = `Tela ${info.number} · `
  const mount = () => {
    let host = document.getElementById('__ravok_ip')
    if (!host) {
      host = document.createElement('div')
      host.id = '__ravok_ip'
      const root = host.attachShadow({ mode: 'open' })
      root.innerHTML =
        '<style>:host{all:initial;position:fixed;top:8px;right:8px;z-index:2147483647;pointer-events:none}' +
        'span{display:block;padding:3px 9px;border-radius:6px;background:rgba(0,0,0,.8);color:#fff;font:600 12px/1.4 Consolas,ui-monospace,monospace;letter-spacing:.02em;white-space:nowrap}' +
        'b{font-weight:700}b.on{color:#4ade80}b.off{color:#f87171}</style><span><b></b></span>'
    }
    const root = host.shadowRoot
    const ip = root.querySelector('b')
    ip.textContent = info.ip
    ip.className = info.proxied ? 'on' : 'off'
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host)
    const title = document.title.replace(/^Tela \d+ · /, '')
    if (document.title !== prefix + title) document.title = prefix + title
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true })
  else mount()
  clearInterval(window.__ravokIpTimer)
  window.__ravokIpTimer = setInterval(mount, 2000)
}

function findChrome() {
  const env = process.env
  const candidates = []
  if (data.settings.chromePath) candidates.push(data.settings.chromePath)
  if (process.platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)
    for (const r of roots) candidates.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    for (const r of roots) candidates.push(path.join(r, 'Chromium', 'Application', 'chrome.exe'))
    for (const r of roots) candidates.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    )
  }
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  })
}

// Electron exports variables (crashpad pipe, run-as-node, etc.) that make a child Chrome
// attach to the bot's process and paint blank windows grouped under the bot's taskbar icon.
function cleanChromeEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(ELECTRON_|CHROME_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)) continue
    env[key] = value
  }
  return env
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Starts Chrome as its own detached process (like Dolphin/AdsPower) so every screen is a real,
// independent Chrome window with its own taskbar entry, then hands back the DevTools port.
async function launchDetachedChrome(chromePath, userDataDir, args, { keep = false } = {}) {
  // Screens from the main button start from an empty profile; screens reopened from Contas keep theirs (login, cookies).
  const hadProfile = keep && fs.existsSync(path.join(userDataDir, 'Default'))
  if (!hadProfile) {
    await fs.promises.rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {})
  }
  await fs.promises.mkdir(path.join(userDataDir, 'Default'), { recursive: true })
  // Fresh profile without the "Salvar senha?" bubble and with site-triggered downloads blocked.
  const prefs = {
    credentials_enable_service: false,
    credentials_enable_autosignin: false,
    profile: {
      password_manager_enabled: false,
      password_manager_leak_detection: false,
      default_content_setting_values: { automatic_downloads: 2, notifications: 2 },
    },
    download: { prompt_for_download: false, directory_upgrade: true },
    browser: { has_seen_welcome_page: true },
  }
  if (!hadProfile) {
    await fs.promises
      .writeFile(path.join(userDataDir, 'Default', 'Preferences'), JSON.stringify(prefs))
      .catch(() => {})
  }
  const portFile = path.join(userDataDir, 'DevToolsActivePort')
  await fs.promises.rm(portFile, { force: true }).catch(() => {})

  const child = spawn(
    chromePath,
    [...args, `--user-data-dir=${userDataDir}`, '--remote-debugging-port=0', 'about:blank'],
    { detached: true, stdio: 'ignore', env: cleanChromeEnv(), windowsHide: false },
  )
  let spawnError = null
  child.once('error', (err) => {
    spawnError = err
  })
  child.unref()

  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError
    try {
      const [port] = (await fs.promises.readFile(portFile, 'utf8')).split(/\r?\n/)
      if (Number(port) > 0) return { port: Number(port), pid: child.pid }
    } catch {}
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`o Chrome fechou ao iniciar (código ${child.exitCode})`)
    }
    await sleep(200)
  }
  throw new Error('o Chrome não respondeu. Feche todas as janelas do Chrome dessa tela e tente de novo')
}

async function loadChromeModules() {
  if (!chromeModules) {
    const [puppeteer, proxyChain] = await Promise.all([
      import('puppeteer-core'),
      import('proxy-chain'),
    ])
    chromeModules = { puppeteer: puppeteer.default || puppeteer, Server: proxyChain.Server }
  }
  return chromeModules
}

// Ad networks only (no analytics/CDNs, which games and casinos wait for while loading).
const AD_URL_PATTERNS = [
  '*doubleclick.net*',
  '*googlesyndication.com*',
  '*googleadservices.com*',
  '*adservice.google.*',
  '*amazon-adsystem.com*',
  '*adnxs.com*',
  '*criteo.com*',
  '*criteo.net*',
  '*taboola.com*',
  '*outbrain.com*',
  '*popads.net*',
  '*popcash.net*',
  '*propellerads.com*',
  '*adsterra.com*',
  '*exoclick.com*',
  '*juicyads.com*',
  '*hilltopads.net*',
  '*onclickads.net*',
  '*a-ads.com*',
]

function getBlocker() {
  if (!blockerPromise) {
    blockerPromise = import('@ghostery/adblocker-puppeteer')
      .then(({ PuppeteerBlocker }) =>
        PuppeteerBlocker.fromPrebuiltAdsAndTracking(fetch, {
          path: path.join(app.getPath('userData'), 'adblock-engine-chrome.bin'),
          read: fs.promises.readFile,
          write: fs.promises.writeFile,
        }),
      )
      .then((blocker) => {
        // Network filtering needs Puppeteer request interception: every request of the page pauses until
        // Node answers, and the browser cache is turned off. Games with hundreds of assets (PG Soft) loaded
        // very slowly and Pragmatic Play froze halfway through its loading bar. Only the cosmetic part
        // (hiding ad elements) runs here; ad networks are blocked natively by Chrome (AD_URL_PATTERNS).
        blocker.config.loadNetworkFilters = false
        return blocker
      })
      .catch((err) => {
        blockerPromise = null
        throw err
      })
  }
  return blockerPromise
}

function computeCells(display, rows, cols) {
  const area = display.workArea
  const width = Math.floor(area.width / cols)
  const height = Math.floor(area.height / rows)
  const cells = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        x: area.x + c * width - WIN_FRAME.side,
        y: area.y + r * height,
        width: width + WIN_FRAME.side * 2,
        height: height + WIN_FRAME.bottom,
      })
    }
  }
  return cells
}

function setupPage(state, page) {
  // The first page can be announced twice (initial pages + targetcreated). Every caller gets the same
  // promise, so the first navigation always waits for the full setup instead of starting mid-preparation.
  state.preparedPages ||= new WeakMap()
  if (!state.preparedPages.has(page)) state.preparedPages.set(page, preparePage(state, page))
  return state.preparedPages.get(page)
}

// Fallback that does not depend on CDP timing: PG's game iframe loads before its isolated session gets touch
// emulation ("toque 0" in the log), so with an iPhone UA its canvas only listens to touch events and mouse clicks
// never become touches. Inside the frame itself, a press on a <canvas> is re-dispatched as touchstart/move/end.
// If Chrome already converted the click into a real touch, the bridge stays out of the way.
function touchBridge() {
  if (window === window.top || window.__ravokTouchBridge) return
  try {
    Object.defineProperty(window, '__ravokTouchBridge', { value: true })
  } catch {}
  const report = (msg) => {
    try {
      if (typeof window.__ravokDiag === 'function') window.__ravokDiag('toque', location.host + location.pathname.slice(0, 30), msg)
    } catch {}
  }
  let lastRealTouch = 0
  let active = null
  let reported = false
  addEventListener('touchstart', (e) => { if (e.isTrusted) lastRealTouch = Date.now() }, true)
  const makeTouch = (target, e) =>
    new Touch({
      identifier: 1,
      target,
      clientX: e.clientX,
      clientY: e.clientY,
      pageX: e.pageX,
      pageY: e.pageY,
      screenX: e.screenX,
      screenY: e.screenY,
      radiusX: 1,
      radiusY: 1,
      force: 1,
    })
  const fire = (type, target, e, ended) => {
    const touch = makeTouch(target, e)
    const list = ended ? [] : [touch]
    try {
      target.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          touches: list,
          targetTouches: list,
          changedTouches: [touch],
        }),
      )
    } catch (err) {
      report(`falha ao criar toque: ${err && err.message}`)
    }
  }
  addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 0 || !(e.target instanceof HTMLCanvasElement)) return
      if (e.sourceCapabilities?.firesTouchEvents || Date.now() - lastRealTouch < 800) {
        if (!reported) report('o Chrome já converte o clique em toque neste jogo, ponte desligada')
        reported = true
        return
      }
      if (!reported) {
        report(`clique no canvas convertido em toque (toque nativo ${navigator.maxTouchPoints})`)
        reported = true
      }
      active = e.target
      fire('touchstart', active, e, false)
    },
    true,
  )
  addEventListener('mousemove', (e) => { if (active) fire('touchmove', active, e, false) }, true)
  const end = (e) => {
    if (!active) return
    const target = active
    active = null
    fire('touchend', target, e, true)
  }
  addEventListener('mouseup', end, true)
  addEventListener('blur', () => { active = null })
}

// PG games (Cocos) decide once, at startup, how to listen for input: with a phone UA they ignore mouse events,
// and they only register touch listeners if 'ontouchstart' already exists. The game iframe's isolated session
// gets Chrome's touch emulation a moment after its first script runs (log: "toque 0" then "modo celular
// aplicado"), so the game registered neither and the canvas ignored every click while DOM buttons (trophy,
// home) still worked. This runs at document start in every frame, so touch support exists before the game boots.
function touchCapabilityShim() {
  if (window.__ravokTouchCaps) return
  try {
    Object.defineProperty(window, '__ravokTouchCaps', { value: true })
  } catch {}
  try {
    Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5, configurable: true })
  } catch {}
  const handlers = new WeakMap()
  const targets = [window, Document.prototype, HTMLElement.prototype, SVGElement.prototype]
  for (const name of ['ontouchstart', 'ontouchmove', 'ontouchend', 'ontouchcancel']) {
    const type = name.slice(2)
    for (const target of targets) {
      if (Object.prototype.hasOwnProperty.call(target, name)) continue
      try {
        Object.defineProperty(target, name, {
          configurable: true,
          enumerable: true,
          get() {
            return handlers.get(this)?.[name] ?? null
          },
          set(fn) {
            const map = handlers.get(this) || {}
            if (map[name]) this.removeEventListener(type, map[name])
            map[name] = typeof fn === 'function' ? fn : null
            if (map[name]) this.addEventListener(type, map[name])
            handlers.set(this, map)
          },
        })
      } catch {}
    }
  }
}

const emulatedFrameClients = new WeakSet()

async function emulateIsolatedFrame(state, page, frame, pageCdp) {
  const client = frame.client
  if (!client || client === pageCdp || emulatedFrameClients.has(client)) return
  emulatedFrameClients.add(client)
  const { device } = state
  await client
    .send('Network.setUserAgentOverride', {
      userAgent: device.userAgent,
      platform: device.platform,
      ...(device.metadata ? { userAgentMetadata: device.metadata } : {}),
    })
    .catch(() => {})
  // An iPhone/Android UA without touch makes PG's canvas wait for touch events that never come (maxTouchPoints 0),
  // so only DOM buttons (trophy, home, "Iniciar") reacted. Touch support and mouse-to-touch conversion must both
  // be enabled on the isolated frame's own session, exactly like the main page.
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }).catch(() => {})
  await client
    .send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' })
    .catch(() => {})
  log(`Tela ${state.number}: modo celular aplicado no quadro isolado ${frame.url().slice(0, 80) || '(carregando)'}`)
  await syncFrameClientMute(client)
}

const mutedFrameClients = new Map()

async function syncFrameClientMute(client) {
  const scriptId = mutedFrameClients.get(client)
  if (screensMuted && !scriptId) {
    const res = await client
      .send('Page.addScriptToEvaluateOnNewDocument', { source: `(${muteShim})(true)` })
      .catch(() => null)
    if (res?.identifier) mutedFrameClients.set(client, res.identifier)
  } else if (!screensMuted && scriptId) {
    mutedFrameClients.delete(client)
    await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Two page set-ups. Until the sign-up is done a screen is prepared exactly like 1.0.9 ("legacy"): native clock shim,
// user agent through Network.setUserAgentOverride, no touch/console/stealth patches, no frame hooks. Sites that
// create accounts reacted badly (account "anormal ou congelada") to the extra 1.0.12 patches. Once the account
// exists (or on screens that never create one) the "modern" set-up from 1.0.12 is applied: game-frame emulation,
// touch bridge, diagnostics, anti-DevTools masking and the virtual-timer Speed Hack.
// ---------------------------------------------------------------------------------------------------------------

function legacyDeviceSetup(state, cdp) {
  const { device } = state
  return (async () => {
    await cdp.send('Network.setUserAgentOverride', {
      userAgent: device.userAgent,
      platform: device.platform,
      ...(device.metadata ? { userAgentMetadata: device.metadata } : {}),
    })
    if (state.portrait) {
      await cdp
        .send('Emulation.setDeviceMetricsOverride', {
          width: 0,
          height: 0,
          deviceScaleFactor: 0,
          mobile: true,
          screenOrientation: { type: 'portraitPrimary', angle: 0 },
        })
        .catch(() => {})
    }
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' })
  })()
}

// Device emulation of 1.0.12: UA for isolated iframes, portrait screen size, orientation, frame hooks.
async function modernDeviceSetup(state, page, cdp) {
  state.modernDevicePages ||= new WeakSet()
  if (state.modernDevicePages.has(page)) return
  state.modernDevicePages.add(page)
  const { device } = state
  // Puppeteer re-applies this to every isolated iframe session before it starts loading. A raw CDP override
  // only covered the main frame, so cross-site game iframes (Pragmatic) saw a Windows desktop browser,
  // downloaded the desktop build with a mobile config and crashed in ParseConfigFile.
  await page
    .setUserAgent({
      userAgent: device.userAgent,
      platform: device.platform,
      ...(device.metadata ? { userAgentMetadata: device.metadata } : {}),
    })
    .catch(() => {})
  page.on('frameattached', (frame) => emulateIsolatedFrame(state, page, frame, cdp))
  // A frame that starts as about:blank and then navigates to the game's domain gets a new isolated session,
  // which frameattached never reports; without this the PG frame kept a desktop touch setup (toque 0).
  page.on('framenavigated', (frame) => emulateIsolatedFrame(state, page, frame, cdp))
  for (const frame of page.frames()) emulateIsolatedFrame(state, page, frame, cdp)
  if (state.portrait) {
    // The phone's screen must also be portrait: sites compare screen.width/height (the real monitor
    // is landscape) and showed "gire o celular" or stopped loading halfway.
    await cdp
      .send('Emulation.setDeviceMetricsOverride', {
        width: 0,
        height: 0,
        deviceScaleFactor: 0,
        mobile: true,
        screenWidth: state.cell?.width || 0,
        screenHeight: state.cell?.height || 0,
        screenOrientation: { type: 'portraitPrimary', angle: 0 },
      })
      .catch(() => {})
  }
  await page.evaluateOnNewDocument(`if (!${GAME_FRAME_CHECK}) ${deviceShim(device)}`).catch(() => {})
}

// Touch/diagnostic/stealth scripts. `speed` registers the pass-through clock shim, `touch` the touch and diagnostic
// scripts, `stealth` the anti-DevTools masking (it must be registered last).
async function installPageShims(state, page, { speed = true, touch = true, stealth = true } = {}) {
  if (page.isClosed()) return
  if (speed) await applySpeedToPage(state, page)
  if (touch) {
    if (/iPhone|iPad|Android|Mobile/i.test(state.device?.userAgent || '')) {
      await page.evaluateOnNewDocument(`(${touchCapabilityShim})()`).catch(() => {})
    }
    await page.evaluateOnNewDocument(diagReporter).catch(() => {})
    await page.evaluateOnNewDocument(`if (!${GAME_FRAME_CHECK}) (${touchBridge})()`).catch(() => {})
  }
  if (stealth) await page.evaluateOnNewDocument(`if (!${GAME_FRAME_CHECK}) (${stealthShim})()`).catch(() => {})
}

// Called once the sign-up is over: from now on every new document gets the full 1.0.12 set-up.
async function enableModernShims(state) {
  if (state.modern) return
  state.modern = true
  log(`Tela ${state.number}: cadastro concluído, ativando os ajustes de jogo (toque, relógio, anti-inspeção)`)
  const pages = await state.browser.pages().catch(() => [])
  for (const page of pages) {
    try {
      if (page.isClosed()) continue
      const cdp = state.cdps.get(page)
      // Drop the 1.0.9 clock shim for the next documents; the virtual-timer one replaces it.
      const legacyId = state.legacySpeedIds?.get(page)
      if (legacyId) await page.removeScriptToEvaluateOnNewDocument(legacyId).catch(() => {})
      state.legacySpeedIds?.delete(page)
      await attachPageDiagnostics(state, page, cdp)
      await installPageShims(state, page, { stealth: false })
      if (cdp) await modernDeviceSetup(state, page, cdp)
      if (data.settings.adblock && cdp) await cdp.send('Network.setBlockedURLs', { urls: AD_URL_PATTERNS }).catch(() => {})
      await installPageShims(state, page, { speed: false, touch: false })
    } catch {}
  }
}

async function preparePage(state, page) {
  try {
    const cdp = await page.createCDPSession()
  state.cdps.set(page, cdp)
  // Every screen behaves as the focused window, so typing and timers keep running while another screen is in front.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
  state.activePage = page
    page.once('close', () => {
      state.cdps.delete(page)
      state.speedScripts.delete(page)
      if (state.activePage === page) state.activePage = null
    })
    // Screens opened from Contas, or with the assistant off, never create an account: they get the modern set-up at once.
    state.modern = Boolean(state.modern || state.fromAccount || !data.settings.assistant)
    if (state.modern) {
      await attachPageDiagnostics(state, page, cdp)
      await installPageShims(state, page, { speed: false, stealth: false })
    }
    page.on('load', () => {
      const factor = speedFor(state.number)
      cdp.send('Animation.enable').catch(() => {})
      cdp.send('Animation.setPlaybackRate', { playbackRate: factor }).catch(() => {})
    })
    await page
      .exposeFunction('__ravokMirrorEmit', (ev) => onMirrorEvent(state, page, ev))
      .catch(() => {})
    await page.evaluateOnNewDocument(mirrorListener)
    await applySpeedToPage(state, page)
    if (screensMuted) await applyMuteToPage(state, page)
    const { device } = state
    if (state.modern) {
      await modernDeviceSetup(state, page, cdp)
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
      await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' })
    } else {
      await legacyDeviceSetup(state, cdp)
      await page.evaluateOnNewDocument(deviceShim(device, true))
    }
    if (state.ip) await page.evaluateOnNewDocument(ipOverlay, overlayInfo(state))
    await page
      .exposeFunction('__ravokAssistReport', (msg) => onAssistReport(state, page, msg))
      .catch(() => {})
    await page.evaluateOnNewDocument(
      `if (!${GAME_FRAME_CHECK}) (${pageAssistant})(${JSON.stringify(learnedForPage() ?? null)})`,
    )
    if (state.modern) await installPageShims(state, page, { speed: false, touch: false })
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && /google\.[^/]+\/sorry\//.test(frame.url())) {
        log(`Tela ${state.number}: o Google pediu captcha para o IP ${state.ip || ''} (proxy com IP marcado, troque a proxy)`)
      }
    })
    if (data.settings.adblock) {
      if (!state.modern) {
        // 1.0.9 behaviour: never hold the page waiting for the filter lists download.
        getBlocker()
          .then((blocker) => (page.isClosed() ? null : blocker.enableBlockingInPage(page)))
          .catch((err) => {
            log(`Tela ${state.number}: bloqueador de anúncios indisponível (${err.message})`)
          })
      } else {
        await cdp.send('Network.enable').catch(() => {})
        await cdp.send('Network.setBlockedURLs', { urls: AD_URL_PATTERNS }).catch(() => {})
        const blocker = await Promise.race([getBlocker().catch(() => null), sleep(BLOCKER_WAIT_MS).then(() => null)])
        if (blocker && !page.isClosed()) {
          await blocker.enableBlockingInPage(page).catch((err) => {
            log(`Tela ${state.number}: bloqueador de anúncios indisponível (${err.message})`)
          })
        } else if (!blocker) {
          log(`Tela ${state.number}: bloqueador de anúncios ainda carregando, a tela abre sem ele`)
        }
      }
    }
  } catch (err) {
    log(`Tela ${state.number}: falha ao preparar a página (${err.message})`)
  }
}

async function showIpOnPages(state) {
  if (!state.browser?.connected) return
  const pages = await state.browser.pages().catch(() => [])
  for (const page of pages) {
    if (state.overlayScripts.has(page)) {
      await page
        .removeScriptToEvaluateOnNewDocument(state.overlayScripts.get(page))
        .catch(() => {})
    }
    if (!state.ip) continue
    const { identifier } = await page
      .evaluateOnNewDocument(ipOverlay, overlayInfo(state))
      .catch(() => ({ identifier: null }))
    if (identifier) state.overlayScripts.set(page, identifier)
    await page.evaluate(ipOverlay, overlayInfo(state)).catch(() => {})
  }
}

function overlayInfo(state) {
  return { number: state.number, ip: state.ip, proxied: Boolean(effectiveProxy(state)) }
}

let screenLogoPath = null
function getScreenLogo() {
  if (screenLogoPath) return screenLogoPath
  // Written outside the asar so PowerShell can read it.
  const png = nativeImage
    .createFromPath(path.join(__dirname, 'renderer', 'logo.png'))
    .resize({ width: 256, height: 256, quality: 'best' })
    .toPNG()
  screenLogoPath = path.join(app.getPath('userData'), 'tela-logo.png')
  fs.writeFileSync(screenLogoPath, png)
  return screenLogoPath
}

// Gives each screen its own taskbar button (separate AppUserModelID) showing the bot logo
// with the screen number badge, like Dolphin/AdsPower profiles.
const SET_ICON_PS = `
Add-Type -ReferencedAssemblies System.Drawing @'
using System; using System.IO; using System.Text; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Text; using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, Pack=4)] public struct RavokPK { public Guid fmt; public uint pid; public RavokPK(Guid g, uint p) { fmt = g; pid = p; } }
[StructLayout(LayoutKind.Sequential)] public class RavokPV { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr p; public IntPtr p2; }
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface RavokIPS { int GetCount(out uint c); int GetAt(uint i, out RavokPK k); int GetValue(ref RavokPK k, [Out] RavokPV v); int SetValue(ref RavokPK k, [In] RavokPV v); int Commit(); }
public class RavokWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr LoadImage(IntPtr hi, string name, uint type, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h, ref Guid iid, [Out, MarshalAs(UnmanagedType.Interface)] out RavokIPS s);
  static readonly Guid AUM = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

  static void SetStr(RavokIPS s, uint id, string v) {
    var k = new RavokPK(AUM, id); var pv = new RavokPV(); pv.vt = 31; pv.p = Marshal.StringToCoTaskMemUni(v);
    try { s.SetValue(ref k, pv); } finally { Marshal.FreeCoTaskMem(pv.p); }
  }

  static void BuildIcon(string logo, string ico, int n) {
    using (var src = Image.FromFile(logo)) using (var bmp = new Bitmap(256, 256)) using (var g = Graphics.FromImage(bmp)) {
      g.SmoothingMode = SmoothingMode.AntiAlias; g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
      g.DrawImage(src, 0, 0, 256, 256);
      string t = n.ToString();
      int h = 150, w = Math.Min(256, 150 + 60 * (t.Length - 1));
      var r = new Rectangle(256 - w, 256 - h, w - 1, h - 1);
      using (var path = new GraphicsPath()) {
        int d = h - 1; path.AddArc(r.X, r.Y, d, d, 90, 180); path.AddArc(r.Right - d, r.Y, d, d, 270, 180); path.CloseFigure();
        using (var fill = new SolidBrush(Color.FromArgb(220, 38, 38))) g.FillPath(fill, path);
        using (var pen = new Pen(Color.White, 12)) g.DrawPath(pen, path);
      }
      using (var font = new Font("Arial", 112, FontStyle.Bold, GraphicsUnit.Pixel)) using (var fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
        g.DrawString(t, font, Brushes.White, new RectangleF(r.X, r.Y + 6, r.Width, r.Height), fmt);
      byte[] png; using (var ms = new MemoryStream()) { bmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png); png = ms.ToArray(); }
      using (var fs = new FileStream(ico, FileMode.Create)) using (var bw = new BinaryWriter(fs)) {
        bw.Write((short)0); bw.Write((short)1); bw.Write((short)1);
        bw.Write((byte)0); bw.Write((byte)0); bw.Write((byte)0); bw.Write((byte)0);
        bw.Write((short)1); bw.Write((short)32); bw.Write(png.Length); bw.Write(22); bw.Write(png);
      }
    }
  }

  public static void Run(uint pid, int n, string logo, string ico, string relaunch) {
    BuildIcon(logo, ico, n);
    IntPtr big = LoadImage(IntPtr.Zero, ico, 1, 256, 256, 0x10);
    IntPtr small = LoadImage(IntPtr.Zero, ico, 1, 32, 32, 0x10);
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h) || GetWindowTextLength(h) == 0) return true;
      var sb = new StringBuilder(64); GetClassName(h, sb, 64);
      if (!sb.ToString().StartsWith("Chrome_WidgetWin")) return true;
      RavokIPS store;
      if (SHGetPropertyStoreForWindow(h, ref iid, out store) == 0 && store != null) {
        try {
          SetStr(store, 2, relaunch);
          SetStr(store, 3, ico);
          SetStr(store, 4, "Tela " + n);
          SetStr(store, 5, "RavokBot.Tela." + n);
          store.Commit();
        } catch { } finally { Marshal.ReleaseComObject(store); }
      }
      SendMessage(h, 0x80, (IntPtr)1, big);
      SendMessage(h, 0x80, IntPtr.Zero, small);
      return true;
    }, IntPtr.Zero);
  }
}
'@
[RavokWin]::Run(__PID__, __N__, '__LOGO__', '__ICO__', '__CMD__')
`

function applyScreenIcon(pid, number, chromePath, userDataDir) {
  if (process.platform !== 'win32' || !pid) return
  try {
    const quote = (s) => String(s).replace(/'/g, "''")
    const ico = path.join(app.getPath('userData'), `tela-${number}.ico`)
    const relaunch = `"${chromePath}" --user-data-dir="${userDataDir}"`
    const script = SET_ICON_PS.replace('__PID__', String(pid))
      .replace('__N__', String(number))
      .replace('__LOGO__', quote(getScreenLogo()))
      .replace('__ICO__', quote(ico))
      .replace('__CMD__', quote(relaunch))
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: 'ignore' },
    )
    ps.on('error', () => {})
  } catch {}
}

// Runs inside every page: waits for the site to settle, closes promo popups/banners one by one
// (learning which close buttons work), then opens the registration form and stops.
function pageAssistant(learned) {
  if (window.top !== window || window.__ravokAssist) return
  window.__ravokAssist = true

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const report = async (msg) => {
    for (let i = 0; i < 30 && typeof window.__ravokAssistReport !== 'function'; i++) await sleep(100)
    if (typeof window.__ravokAssistReport !== 'function') return null
    return window.__ravokAssistReport(msg).catch(() => null)
  }
  const CLOSE_TEXT = /^(x|×|✕|✖|╳|fechar|close|cancelar|n[aã]o,? obrigad[oa]|agora n[aã]o|mais tarde|pular|skip|ok|entendi|ciente)$/i
  const X_GLYPH = /^[x×✕✖╳]$/i
  const CLOSE_HINT = /close|fechar|dismiss|guanbi|cross|cancel|shut|icon-?x\b|btn-?x\b|\bx-?btn|\bx-?icon/i
  const BLOCK = /registr|cadastr|login|entrar|dep[oó]sit|baixar|download|instalar|adicionar|apost|jogar|sacar|copiar|resgat|receber|abrir|\bapp\b/i
  const REGISTER = /^(registr(o|ar|e-se|ar-se)?|cadastr(o|ar|e-se|ar-se)?|criar conta|inscrev(a-se|er)|abrir conta|sign ?up|register|join now)$/i
  const NAV = 'header,nav,footer,[class*="tabbar" i],[class*="tab-bar" i],[class*="navbar" i],[class*="nav-bar" i],[class*="bottom-nav" i]'
  const tried = new WeakSet()
  const triedMasks = new WeakSet()
  // A tap can be swallowed by another popup opening on top (or by the opening animation),
  // so a close button that failed is retried a few times instead of being ignored forever.
  const closeTries = new WeakMap()
  const MAX_CLOSE_TRIES = 3
  // Scroll indicators (▲▼), carousel arrows and similar small icons look like an X to the heuristics but never close anything.
  const NOT_CLOSE_HINT = /arrow|scroll|caret|chevron|\bup\b|\bdown\b|prev|next|seta|indicator|swiper|carousel|slide|dots?\b|more/i
  const ARROW_GLYPH = /^[▲▼△▽▴▾◀▶◂▸<>‹›«»^ˇ↑↓←→]+$/
  const markCloseTry = (el) => closeTries.set(el, (closeTries.get(el) || 0) + 1)

  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
  const rectOf = (el) => el.getBoundingClientRect()
  const isShown = (el) => {
    if (!el || !el.isConnected) return false
    const r = rectOf(el)
    if (r.width < 6 || r.height < 6 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = getComputedStyle(n)
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return false
    }
    return true
  }
  const onTop = (el) => {
    const r = rectOf(el)
    const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1)
    const y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1)
    const hit = document.elementFromPoint(x, y)
    if (!hit) return false
    if (hit === el || el.contains(hit)) return true
    return hit.contains(el) && rectOf(hit).width <= r.width * 1.6 + 10
  }
  const stillThere = (el) => isShown(el) && onTop(el)
  const isRendered = (el) => {
    if (!el || !el.isConnected) return false
    const r = rectOf(el)
    if (r.width < 6 || r.height < 6 || r.right <= 0 || r.left >= innerWidth) return false
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = getComputedStyle(n)
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return false
    }
    return true
  }
  // Many sites draw the placeholder ("*Insira a senha") or an icon as a separate element over the input.
  // Anything covering the input from inside its own field wrapper still means the field is usable.
  const fieldOnTop = (input) => {
    const r = rectOf(input)
    if (r.bottom <= 0 || r.top >= innerHeight) return false
    const y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1)
    for (const fx of [0.5, 0.25, 0.75]) {
      const hit = document.elementFromPoint(r.left + r.width * fx, y)
      if (!hit) continue
      if (hit === input || input.contains(hit)) return true
      if (hit.contains(input) && rectOf(hit).height <= r.height * 2.5 + 30) return true
      for (let n = input.parentElement, i = 0; n && i < 4; n = n.parentElement, i++) {
        if (rectOf(n).height > r.height * 2.5 + 30) break
        if (n.contains(hit)) return true
      }
    }
    return false
  }
  const attrsOf = (el) =>
    [
      typeof el.className === 'string' ? el.className : el.className?.baseVal,
      el.id,
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('alt'),
      el.getAttribute('src'),
      el.getAttribute('href'),
      el.getAttribute('name'),
      el.querySelector?.('use')?.getAttribute('href'),
      el.querySelector?.('use')?.getAttribute('xlink:href'),
      el.querySelector?.('img')?.getAttribute('src'),
    ]
      .filter((v) => typeof v === 'string')
      .join(' ')

  const alphaOf = (color) => {
    const m = /rgba?\(([^)]+)\)/.exec(color || '')
    if (!m) return 0
    const parts = m[1].split(/[\s,/]+/).filter(Boolean)
    return parts.length > 3 ? Number(parts[3]) : 1
  }

  // The dim layer behind a modal: positioned, semi-transparent, covering most of the visible app.
  const findMask = () => {
    const points = [[0.5, 0.06], [0.5, 0.94], [0.5, 0.3], [0.5, 0.7], [0.3, 0.5], [0.7, 0.5]]
    for (const [px, py] of points) {
      const hit = document.elementFromPoint(innerWidth * px, innerHeight * py)
      for (let n = hit; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
        const s = getComputedStyle(n)
        if (s.position !== 'fixed' && s.position !== 'absolute') continue
        const r = rectOf(n)
        const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0)
        const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)
        if (h < innerHeight * 0.8 || w < Math.min(innerWidth, 320) * 0.9) continue
        const a = alphaOf(s.backgroundColor)
        if ((a >= 0.2 && a < 0.98) || (s.backdropFilter && s.backdropFilter !== 'none')) return n
      }
    }
    return null
  }

  // App shells are often fixed too; a fixed layer that holds the site's register button is the page, not a popup.
  const raisedLayer = (el, mask, shellButton) => {
    for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n)
      if (s.position === 'fixed' || (s.position === 'absolute' && parseInt(s.zIndex, 10) >= 10) || (mask && s.position !== 'static' && parseInt(s.zIndex, 10) >= 1)) {
        if (shellButton && n.contains(shellButton) && !n.contains(el.closest(NAV) || document.body)) {
          const r = rectOf(n)
          if (r.height >= innerHeight * 0.6) return false
        }
        if (shellButton && n.contains(shellButton)) return false
        return true
      }
    }
    return Boolean(mask)
  }

  const learnedElements = () => {
    const set = new Set()
    for (const item of learned) {
      let list
      try {
        list = document.querySelectorAll(item.sel)
      } catch {
        continue
      }
      for (const el of list) if (!item.text || textOf(el).slice(0, 20) === item.text) set.add(el)
    }
    return set
  }

  const drawnX = (el) => {
    const b = getComputedStyle(el, '::before')
    const a = getComputedStyle(el, '::after')
    return b.content !== 'none' && a.content !== 'none' && b.transform !== 'none' && a.transform !== 'none'
  }
  const svgX = (el) => {
    const svg = el.matches('svg') ? el : el.querySelector('svg')
    if (!svg) return false
    const lines = svg.querySelectorAll('line')
    if (lines.length === 2) return true
    const paths = [...svg.querySelectorAll('path')]
    return paths.length >= 1 && paths.length <= 3 && paths.every((p) => (p.getAttribute('d') || '').length < 400)
  }

  const scoreOf = (el, ctx) => {
    if (tried.has(el) || (closeTries.get(el) || 0) >= MAX_CLOSE_TRIES || el.id === '__ravok_ip' || el.closest('#__ravok_ip') || !isShown(el)) return null
    // Never dismiss the layer that holds a sign-up/login form; only popups stacked on top of it.
    if (ctx.formPw) {
      for (let n = el; n && n !== document.body; n = n.parentElement) if (n.contains(ctx.formPw)) return null
    }
    const r = rectOf(el)
    const small = r.width <= 90 && r.height <= 90
    if (!small && !(r.width <= 260 && r.height <= 70)) return null
    const text = textOf(el)
    if (text.length > 24 || BLOCK.test(text)) return null
    const learnedHit = ctx.learnedSet.has(el)
    const textual = Boolean(text) && CLOSE_TEXT.test(text)
    if (text && !textual && !learnedHit) return null
    if (!small && !textual && !learnedHit) return null

    // An icon sitting next to a label ("Baixar APP", tab bar items, game tiles) is part of that button, not a close X.
    if (!textual && !learnedHit) {
      for (let n = el.parentElement, i = 0; n && i < 3 && n !== document.body; n = n.parentElement, i++) {
        const nr = rectOf(n)
        if (nr.width > 170 || nr.height > 120) break
        const t = textOf(n)
        if (t && !X_GLYPH.test(t) && !CLOSE_TEXT.test(t)) return null
      }
    }

    let s = learnedHit ? 100 : 0
    const why = []
    if (learnedHit) why.push('aprendido')
    if (textual) {
      s += 50
      why.push(`texto "${text}"`)
    }
    let hint = CLOSE_HINT.test(attrsOf(el))
    for (let n = el.parentElement, i = 0; !hint && n && i < 2; n = n.parentElement, i++) {
      if (rectOf(n).width <= r.width * 2 + 20 && CLOSE_HINT.test(attrsOf(n))) hint = true
    }
    if (!hint && !textual && !learnedHit) {
      if (NOT_CLOSE_HINT.test(attrsOf(el)) || (el.parentElement && rectOf(el.parentElement).width <= r.width * 2 + 20 && NOT_CLOSE_HINT.test(attrsOf(el.parentElement)))) return null
      const glyph = (text || getComputedStyle(el, '::before').content.replace(/^["']|["']$/g, '')).trim()
      if (glyph && glyph !== 'none' && ARROW_GLYPH.test(glyph)) return null
      // A CSS triangle (zero size box with one colored border) is an arrow, never an X.
      const st = getComputedStyle(el)
      if (r.width < 22 && r.height < 22 && !el.querySelector('svg,img') && st.backgroundImage === 'none' && !drawnX(el)) {
        const bw = [st.borderTopWidth, st.borderRightWidth, st.borderBottomWidth, st.borderLeftWidth].map(parseFloat)
        if (bw.some((w) => w >= 3) && new Set(bw).size > 1) return null
      }
    }
    if (hint) {
      s += 45
      why.push('classe de fechar')
    }
    const ratio = r.width / r.height
    const square = ratio > 0.6 && ratio < 1.7
    const style = getComputedStyle(el)
    const graphic =
      el.matches('svg,img,i,canvas') || Boolean(el.querySelector('svg,img,i')) || style.backgroundImage !== 'none' || drawnX(el)
    if (!text && square && graphic) {
      s += 15
      if (drawnX(el) || svgX(el)) s += 10
      if (parseFloat(style.borderRadius) >= r.width * 0.35 && parseFloat(style.borderTopWidth) >= 1) s += 10
    }
    const raised = raisedLayer(el, ctx.mask, ctx.shellButton)
    if (raised) {
      s += 10
      if (ctx.mask) s += 10
    } else return null
    if (el.closest(NAV) && !hint && !learnedHit) s -= 30

    // Measure the corner against the popup panel itself, not a small inner box (a scroll area's arrows sit in that box's corner).
    let box = null
    const minW = Math.min(200, innerWidth * 0.45)
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const nr = rectOf(n)
      if (nr.width >= Math.max(r.width * 3, minW) && nr.height >= Math.max(r.height * 2.5, 120)) {
        box = nr
        break
      }
    }
    if (box && small) {
      const cx = (r.left + r.right) / 2
      if (r.right >= box.right - Math.max(box.width * 0.22, 50) && r.top <= box.top + Math.max(box.height * 0.25, 60)) {
        s += 15
        why.push('canto do popup')
      } else if (Math.abs(cx - (box.left + box.right) / 2) < 30 && r.top >= box.top + box.height * 0.55) {
        s += 15
        why.push('X embaixo do modal')
      }
    }
    if (s < 40 || !onTop(el)) return null
    // A candidate that was tapped without effect yields to the next best one before being retried.
    s -= (closeTries.get(el) || 0) * 30
    return { score: s, why: why.join(', ') || 'formato de X' }
  }

  const captchaVisible = () =>
    [...document.querySelectorAll('iframe,[class*="captcha" i],[id*="captcha" i],[class*="geetest" i],[class*="verify-slider" i]')].some(
      (el) =>
        isRendered(el) &&
        rectOf(el).width > 30 &&
        (el.tagName !== 'IFRAME' || /captcha|turnstile|challenges\.cloudflare|geetest/i.test(el.src || '')),
    )

  const findClose = (mask, shellButton, formPw) => {
    // A captcha on screen belongs to the person: nothing may be tapped away while it is open.
    if (captchaVisible()) return null
    const ctx = { learnedSet: learnedElements(), mask, shellButton, formPw }
    let best = null
    for (const el of document.querySelectorAll('body *')) {
      const res = scoreOf(el, ctx)
      if (!res) continue
      const er = rectOf(el)
      const area = er.width * er.height
      const top = er.top
      // On a tie the X near the top of the popup wins over icons lower down; same row falls back to the smallest element.
      const better =
        !best ||
        res.score > best.score ||
        (res.score === best.score && (top < best.top - 12 || (Math.abs(top - best.top) <= 12 && area < best.area)))
      if (better) best = { el, area, top, ...res }
    }
    return best
  }

  const findRegister = () => {
    let best = null
    for (const el of document.querySelectorAll('a,button,[role="button"],div,span')) {
      if (!REGISTER.test(textOf(el)) || !isShown(el) || !onTop(el)) continue
      const r = rectOf(el)
      if (!best) {
        best = el
        continue
      }
      const b = rectOf(best)
      const topFirst = (r.top < innerHeight * 0.3) - (b.top < innerHeight * 0.3)
      if (topFirst > 0 || (topFirst === 0 && r.width * r.height < b.width * b.height)) best = el
    }
    return best
  }

  const signature = (el) => {
    const classesOf = (n) =>
      String((typeof n.className === 'string' ? n.className : n.className?.baseVal) || '')
        .split(/\s+/)
        .filter((c) => c && c.length < 40 && !/\d{3,}|active|show|visible|hover|enter|leave/i.test(c))
        .slice(0, 4)
    const sel = (n) => n.tagName.toLowerCase() + classesOf(n).map((c) => '.' + CSS.escape(c)).join('')
    let selector = classesOf(el).length ? sel(el) : null
    if (!selector && el.parentElement && classesOf(el.parentElement).length) selector = `${sel(el.parentElement)} > ${el.tagName.toLowerCase()}`
    return selector ? { sel: selector, text: textOf(el).slice(0, 20) } : null
  }

  const tapSynthetic = (el) => {
    if (window.__ravokBotOff) return
    const r = rectOf(el)
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    const target = document.elementFromPoint(x, y) || el
    const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window }
    window.__ravokSynthetic = true
    try {
      target.dispatchEvent(new PointerEvent('pointerdown', { ...o, pointerType: 'touch', isPrimary: true }))
      target.dispatchEvent(new MouseEvent('mousedown', o))
      target.dispatchEvent(new PointerEvent('pointerup', { ...o, pointerType: 'touch', isPrimary: true }))
      target.dispatchEvent(new MouseEvent('mouseup', o))
      target.dispatchEvent(new MouseEvent('click', o))
    } catch {}
    window.__ravokSynthetic = false
  }

  const tapAt = async (x, y, el) => {
    window.__ravokSynthetic = true
    const ok = await report({ type: 'tap', x, y })
    window.__ravokSynthetic = false
    window.__ravokBotOff = ok === 'off'
    if (!ok && el) tapSynthetic(el)
  }
  const tapReal = (el) => {
    const r = rectOf(el)
    return tapAt(r.left + r.width / 2, r.top + r.height / 2, el)
  }

  const waitFor = async (fn, ms, step = 100) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const v = fn()
      if (v) return v
      await sleep(step)
    }
    return fn()
  }

  const FIELD_TYPES = /^(hidden|checkbox|radio|submit|button|file|image|range|color|reset)$/i
  // Read-only is often an anti-autofill trick removed on focus, and fields below the fold of a scrolling modal still count.
  const visibleInputs = (root) => [...root.querySelectorAll('input')].filter((i) => !FIELD_TYPES.test(i.type) && !i.disabled && isRendered(i))
  const PASS_WORD = /senha|password|passwd|\bpwd\b/i
  const ownAttrs = (i) => [i.placeholder, i.name, i.id, i.getAttribute('aria-label'), i.autocomplete].filter(Boolean).join(' ')
  // Many bet templates use type="text" masked with CSS so the browser never offers to save it.
  const isPassLike = (i) => {
    if (i.type === 'password') return true
    if (i.type && !/^(text|tel|search|)$/i.test(i.type)) return false
    const own = ownAttrs(i)
    if (PASS_WORD.test(own)) return true
    const sec = getComputedStyle(i).webkitTextSecurity
    if (sec && sec !== 'none') return true
    if (own) return false
    for (let n = i.parentElement, k = 0; n && k < 3; n = n.parentElement, k++) {
      const t = textOf(n)
      if (t && t.length < 60) return PASS_WORD.test(t)
    }
    return false
  }
  const passInputs = () => visibleInputs(document).filter(isPassLike)
  const findPassword = () => {
    const list = passInputs()
    return list.find((i) => fieldOnTop(i)) || list.find((i) => !coveredByPopup(i)) || null
  }
  const findAnyPassword = () => passInputs()[0] || null
  // A field scrolled out of view inside its modal is not covered; only something stacked above the modal is.
  function coveredByPopup(input) {
    const r = rectOf(input)
    if (r.bottom > 0 && r.top < innerHeight) return !fieldOnTop(input)
    let box = input.parentElement
    while (box && box !== document.body && rectOf(box).top >= innerHeight - 1) box = box.parentElement
    if (!box || box === document.body) return false
    const br = rectOf(box)
    const hit = document.elementFromPoint(br.left + br.width / 2, Math.min(Math.max(br.top + 10, 1), innerHeight - 1))
    return Boolean(hit && !box.contains(hit) && !hit.contains(box))
  }

  const guardForm = async (ms) => {
    const end = Date.now() + ms
    let closedHere = 0
    while (Date.now() < end) {
      const pw = findAnyPassword()
      const hit = pw && coveredByPopup(pw) ? findClose(null, null, pw) : null
      if (!hit) {
        await sleep(250)
        continue
      }
      markCloseTry(hit.el)
      await tapReal(hit.el)
      if (!(await waitFor(() => !stillThere(hit.el), 700))) tapSynthetic(hit.el)
      if (await waitFor(() => !stillThere(hit.el), 500)) tried.add(hit.el)
      closedHere++
    }
    return closedHere
  }

  const formRoot = (pw) => {
    let best = pw.parentElement || document.body
    for (let n = pw.parentElement, i = 0; n && n !== document.body && i < 12; n = n.parentElement, i++) {
      if (visibleInputs(n).length >= visibleInputs(best).length) best = n
      if (getComputedStyle(n).position === 'fixed') break
    }
    return best
  }
  const isRegisterForm = (root) => {
    const inputs = visibleInputs(root)
    const pwCount = inputs.filter(isPassLike).length
    return pwCount >= 2 || inputs.length >= 3 || inputs.some((i) => /confirm|repet|novamente/i.test(fieldText(i)))
  }

  const fieldText = (input) => {
    const label = input.closest('label') || (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`))
    let near = ''
    for (let n = input.parentElement, i = 0; n && i < 3; n = n.parentElement, i++) {
      const t = textOf(n)
      if (t && t.length < 60) {
        near = t
        break
      }
    }
    return [input.placeholder, input.name, input.id, input.getAttribute('aria-label'), input.autocomplete, label ? textOf(label) : '', near]
      .filter(Boolean)
      .join(' ')
  }
  const classify = (input, s) => {
    if (!s) return 'unknown'
    if (/senha|password|passwd|\bpwd\b/i.test(s)) return 'pass'
    // "Celular/E-mail/Conta" accepts a username, so only skip fields that are e-mail only.
    if (/e-?mail/i.test(s) && !/usu[aá]rio|\bconta\b|account|user|login|celular|telefone|phone/i.test(s)) return null
    if (/nome\s*(real|completo|verdadeiro|do titular)|real\s*name|full\s*name|sobrenome/i.test(s)) return 'name'
    if (/c[oó]digo|\bcode\b|captcha|verifica|convite|invite|indica|refer|promo|cpf|documento|pesquis|search|buscar|pix|banc|chave/i.test(s)) return null
    if (/usu[aá]rio|\bconta\b|account|user|login|apelido|nick/i.test(s)) return 'user'
    if (input.type === 'tel' || /phone|telefone|celular|mobile|whats|\btel\b/i.test(s)) return 'phone'
    if (/nome|name/i.test(s)) return 'name'
    return 'unknown'
  }
  const fieldKind = (input) => {
    if (isPassLike(input)) return 'pass'
    if (input.type === 'email') return null
    const own = [input.placeholder, input.name, input.id, input.getAttribute('aria-label'), input.autocomplete].filter(Boolean).join(' ')
    const kind = classify(input, own)
    if (kind !== 'unknown') return kind
    const fallback = classify(input, fieldText(input))
    if (fallback === 'unknown' && input.type === 'tel') return 'phone'
    return fallback
  }

  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  const typeInto = async (input, value) => {
    const before = rectOf(input)
    if (before.top < 0 || before.bottom > innerHeight) {
      input.scrollIntoView({ block: 'nearest' })
      await sleep(150)
    }
    if (input.readOnly) input.removeAttribute('readonly')
    // Tap the field like a person would so the site's own focus handlers run before typing.
    if (fieldOnTop(input)) {
      await tapReal(input)
      await sleep(120)
    }
    if (input.readOnly) input.removeAttribute('readonly')
    if (document.activeElement !== input) input.focus()
    window.__ravokSynthetic = true
    try {
      if (input.value) {
        input.select?.()
        valueSetter.call(input, '')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      if (document.activeElement === input) await report({ type: 'type', text: value })
      await sleep(80)
      const digits = (s) => String(s).replace(/\D/g, '')
      const typedOk = input.value && (!digits(value) || digits(input.value).includes(digits(value)))
      if (!typedOk) {
        valueSetter.call(input, value)
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
      }
      input.dispatchEvent(new Event('change', { bubbles: true }))
    } finally {
      window.__ravokSynthetic = false
    }
    return input.value
  }

  const openRegisterForm = async () => {
    let pw = findPassword()
    if (!pw) {
      const btn = findRegister()
      if (!btn) return null
      await tapReal(btn)
      pw = await waitFor(findPassword, 3000)
      if (!pw) {
        tapSynthetic(btn)
        pw = await waitFor(findPassword, 3500)
      }
      if (!pw) return null
    }
    let root = formRoot(pw)
    if (isRegisterForm(root)) return root
    // A login form opened: switch to its register tab/link inside the same modal.
    let modal = root
    for (let n = root; n && n !== document.body; n = n.parentElement) {
      modal = n
      if (getComputedStyle(n).position === 'fixed') break
    }
    const tab = [...modal.querySelectorAll('a,button,[role="tab"],[role="button"],div,span')].find(
      (el) => REGISTER.test(textOf(el)) && isShown(el) && onTop(el),
    )
    if (!tab) return null
    await tapReal(tab)
    const ready = await waitFor(() => {
      const p = findPassword()
      return p && isRegisterForm(formRoot(p)) ? p : null
    }, 2500)
    return ready ? formRoot(ready) : null
  }

  const fillForm = async (root) => {
    // Wait for the modal's opening animation so every field is visible and tappable.
    await waitFor(() => visibleInputs(root).length >= 2, 2500)
    await sleep(350)
    const creds = await report({ type: 'creds' })
    if (!creds || !creds.user) {
      report({ type: 'log', text: 'não conseguiu gerar os dados da conta' })
      return null
    }
    const inputs = visibleInputs(root)
    const kinds = inputs.map(fieldKind)
    if (!kinds.includes('user')) {
      const i = kinds.indexOf('unknown')
      if (i >= 0) kinds[i] = 'user'
    }
    const labels = { pass: 'senha', user: 'usuário', name: 'nome real', phone: 'telefone', unknown: '?' }
    report({ type: 'log', text: `campos do cadastro: ${kinds.map((k) => labels[k] || 'ignorado').join(', ')}` })
    const filled = {}
    for (let i = 0; i < inputs.length; i++) {
      const kind = kinds[i]
      if (!kind || kind === 'unknown' || (kind !== 'pass' && filled[kind])) continue
      const typed = await typeInto(inputs[i], creds[kind])
      // Sites with a max length cut the value; save exactly what the field holds.
      if (typed && !filled[kind] && typed !== creds[kind]) creds[kind] = typed
      if (typed) filled[kind] = true
      await sleep(150)
    }
    if (!filled.pass || !(filled.user || filled.phone)) {
      report({ type: 'log', text: 'não encontrou os campos de usuário/senha no cadastro' })
      return null
    }
    await report({
      type: 'account',
      host: location.host,
      url: location.origin,
      ...creds,
      user: filled.user ? creds.user : creds.phone,
      hasName: Boolean(filled.name),
      hasPhone: Boolean(filled.phone),
    })
    // The submit button sits below the last field; the "Registro" tab at the top must not be tapped.
    let modal = root
    for (let n = root; n && n !== document.body; n = n.parentElement) {
      modal = n
      if (getComputedStyle(n).position === 'fixed') break
    }
    const lastBottom = Math.max(...inputs.map((i) => rectOf(i).bottom))
    const submit = [...modal.querySelectorAll('button,a,[role="button"],div,span,uni-button')]
      .filter((el) => REGISTER.test(textOf(el)) && isRendered(el) && rectOf(el).top >= lastBottom - 2)
      .sort((a, b) => rectOf(a).width * rectOf(a).height - rectOf(b).width * rectOf(b).height)
      .pop()
    if (captchaVisible()) {
      await captchaWait()
      if (captchaVisible()) return creds
    }
    if (submit && isRendered(submit)) {
      document.activeElement?.blur?.()
      await sleep(300)
      if (rectOf(submit).bottom > innerHeight || rectOf(submit).top < 0) {
        submit.scrollIntoView({ block: 'center' })
        await sleep(250)
      }
      await tapReal(submit)
      report({ type: 'log', text: 'clicou em Registro' })
    } else report({ type: 'log', text: 'botão Registro do formulário não encontrado' })
    return creds
  }

  async function captchaWait() {
    if (!captchaVisible()) return
    report({ type: 'log', text: 'captcha aberto — finalize na tela, o assistente espera você e não mexe em nada' })
    const end = Date.now() + 20 * 60 * 1000
    while (captchaVisible() && Date.now() < end) await sleep(1000)
    if (!captchaVisible()) {
      report({ type: 'log', text: 'captcha finalizado, continuando' })
      await sleep(700)
    }
  }

  const CONFIRM_TEXT = /^(confirmar|confirmo|sim|sim,? fechar|sim,? sair|tenho certeza|fechar mesmo|sair|desistir|abandonar|confirm|yes|ok)$/i
  const CONFIRM_ASK = /certeza|deseja|realmente|perder|abandon|desist|confirma|ao fechar|lembrete|n[aã]o aparecer/i
  // "Are you sure you want to close?" dialogs: the affirmative button finishes closing; "Cancelar" would reopen the popup.
  const findConfirm = () => {
    for (const el of document.querySelectorAll('button,a,[role="button"],div,span,uni-button')) {
      if (el.children.length > 2 || tried.has(el) || !CONFIRM_TEXT.test(textOf(el)) || !isShown(el) || !onTop(el)) continue
      for (let n = el.parentElement, k = 0; n && n !== document.body && k < 6; n = n.parentElement, k++) {
        const box = textOf(n)
        if (box.length > 400) break
        if (CONFIRM_ASK.test(box)) return el
      }
    }
    return null
  }

  const CHOICE_TEXT = /^(ativar|abrir|escolher|selecionar|resgatar|pegar|coletar|receber|sortear|girar|clique para abrir)$/i
  // "Pick one" popups (Sorteio with several chests): no X until one option is chosen.
  // Only counts when an overlay is up and the same option label repeats, so normal page buttons are never touched.
  const findChoice = (mask) => {
    if (!mask) return null
    const groups = new Map()
    for (const el of document.querySelectorAll('button,a,[role="button"],div,span,p,uni-button,uni-view')) {
      if (el.children.length > 2 || tried.has(el) || !isShown(el) || !onTop(el)) continue
      const t = textOf(el)
      if (!t || t.length > 20 || !CHOICE_TEXT.test(t)) continue
      if (el.closest('form') || el.closest('[class*="regist" i],[class*="login" i]')) continue
      const key = t.toLowerCase()
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(el)
    }
    let best = null
    for (const list of groups.values()) {
      const leaves = list.filter((el) => !list.some((o) => o !== el && el.contains(o)))
      if (leaves.length >= 2 && (!best || leaves.length > best.length)) best = leaves
    }
    return best
  }
  const pickChoice = async (mask) => {
    const options = findChoice(mask)
    if (!options) return false
    for (const el of options) tried.add(el)
    const pick = options[Math.floor(Math.random() * options.length)]
    report({ type: 'log', text: `popup de escolha: escolhendo uma opção (${options.length} opções)` })
    await tapReal(pick)
    await sleep(1200)
    return true
  }

  const afterRegister = async () => {
    let closed = 0
    const outcome = await waitFor(() => (captchaVisible() ? 'captcha' : findAnyPassword() ? null : 'sent'), 12000, 250)
    if (outcome === 'captcha') {
      await captchaWait()
      await waitFor(() => !findAnyPassword(), 10000, 250)
    }
    if (findAnyPassword()) {
      report({ type: 'log', text: 'o cadastro continua aberto (o site pediu algo a mais), deixando com você' })
      return closed
    }
    report({ type: 'log', text: 'cadastro enviado, fechando os popups pós-registro' })
    await sleep(800)
    let idle = 0
    let maskWait = 0
    const end = Date.now() + 30000
    while (Date.now() < end && idle < 8) {
      if (captchaVisible()) {
        await captchaWait()
        continue
      }
      const confirm = findConfirm()
      if (confirm) {
        tried.add(confirm)
        await tapReal(confirm)
        await waitFor(() => !stillThere(confirm), 800)
        report({ type: 'log', text: 'confirmou o fechamento do popup' })
        idle = 0
        continue
      }
      const mask = findMask()
      const hit = findClose(mask, null, null)
      if (!hit) {
        if (await pickChoice(mask)) {
          idle = 0
          continue
        }
        const holdsForm = mask && (mask.parentElement || mask).querySelector('input:not([type="hidden"])')
        if (mask && !holdsForm && !triedMasks.has(mask) && ++maskWait >= 3) {
          triedMasks.add(mask)
          const mr = rectOf(mask)
          const y = Math.max(mr.top, 0) + 14
          const x = (Math.max(mr.left, 0) + Math.min(mr.right, innerWidth)) / 2
          if (document.elementFromPoint(x, y) === mask) {
            await tapAt(x, y, mask)
            await sleep(900)
            if (!mask.isConnected || !isShown(mask)) closed++
          }
          maskWait = 0
          continue
        }
        idle++
        await sleep(500)
        continue
      }
      idle = 0
      maskWait = 0
      markCloseTry(hit.el)
      await tapReal(hit.el)
      let gone = await waitFor(() => !stillThere(hit.el), 700)
      if (!gone) {
        tapSynthetic(hit.el)
        gone = await waitFor(() => !stillThere(hit.el), 700)
      }
      if (gone || findConfirm()) {
        tried.add(hit.el)
        closed++
        report({ type: 'log', text: `popup pós-registro fechado (${hit.why})` })
        // Closing the top popup reveals the one underneath; look again right away.
        await sleep(150)
      } else {
        report({ type: 'log', text: `toque no X não fechou (${hit.why}), tentando de novo` })
        await sleep(350)
      }
    }
    return closed
  }

  // Used by the "Cadastrar Chaves PIX" routine to clear whatever is open before navigating.
  const closeAllPopups = async (ms = 10000) => {
    let closed = 0
    let idle = 0
    const end = Date.now() + ms
    while (Date.now() < end && idle < 4) {
      const confirm = findConfirm()
      if (confirm) {
        tried.add(confirm)
        await tapReal(confirm)
        await waitFor(() => !stillThere(confirm), 800)
        idle = 0
        continue
      }
      const hit = findClose(findMask(), null, null)
      if (!hit) {
        idle++
        await sleep(400)
        continue
      }
      idle = 0
      markCloseTry(hit.el)
      await tapReal(hit.el)
      let gone = await waitFor(() => !stillThere(hit.el), 700)
      if (!gone) {
        tapSynthetic(hit.el)
        gone = await waitFor(() => !stillThere(hit.el), 700)
      }
      if (gone) {
        tried.add(hit.el)
        closed++
      } else await sleep(300)
    }
    return closed
  }
  Object.defineProperty(window, '__ravokCloseAll', { value: closeAllPopups, configurable: true })

  const DEPOSIT_TEXT = /^(dep[oó]sito|depositar|fazer dep[oó]sito|recarga|recarregar|deposit)$/i
  const findDepositButton = () => {
    const hits = []
    for (const el of document.querySelectorAll('button,a,[role="button"],div,span,li,uni-button,uni-view')) {
      if (el.children.length > 3 || !isShown(el) || !onTop(el)) continue
      const t = textOf(el)
      if (t && t.length <= 24 && DEPOSIT_TEXT.test(t)) hits.push(el)
    }
    const leaf = hits.find((el) => !hits.some((o) => o !== el && el.contains(o)))
    return leaf ? leaf.closest('button,a,[role="button"],uni-button') || leaf : null
  }

  const AMOUNT_HINT = /valor|quantia|montante|amount|r\$|m[ií]nimo|dep[oó]sit/i
  const findAmountInput = () => {
    for (const input of document.querySelectorAll('input')) {
      if (input.disabled || !isShown(input)) continue
      if (['hidden', 'password', 'checkbox', 'radio', 'email', 'file'].includes(input.type)) continue
      const box = input.closest('label') || input.parentElement || input
      const hint = [input.placeholder, input.name, input.id, input.getAttribute('aria-label'), textOf(box).slice(0, 80)].join(' ')
      const numeric = ['number', 'tel'].includes(input.type) || /numeric|decimal/.test(input.inputMode || '')
      if (AMOUNT_HINT.test(hint) && (numeric || /valor|quantia|amount|r\$|m[ií]nimo.*m[aá]ximo/i.test(hint))) return input
    }
    return null
  }

  let depositAmount = null
  // Opens the deposit modal and types the amount only; confirming/paying is left to the person.
  const openDeposit = async () => {
    if (findAnyPassword()) return
    let input = await waitFor(findAmountInput, 1500, 250)
    if (!input) {
      const btn = await waitFor(findDepositButton, 8000, 300)
      if (!btn) {
        report({ type: 'log', text: 'botão de depósito não encontrado, deixando com você' })
        return
      }
      report({ type: 'log', text: 'abrindo o modal de depósito' })
      await tapReal(btn)
      input = await waitFor(findAmountInput, 3000, 250)
      if (!input) {
        tapSynthetic(btn)
        input = await waitFor(findAmountInput, 8000, 250)
      }
    }
    if (!input) {
      report({ type: 'log', text: 'campo de valor do depósito não encontrado' })
      return
    }
    depositAmount ||= await report({ type: 'depositAmount' })
    if (!depositAmount) return 'skip'
    const want = String(depositAmount)
    // The site often re-renders the field when the modal opens, so it is looked up again on every check.
    const current = () => (input && input.isConnected && isShown(input) ? input : (input = findAmountInput()))
    const hasAmount = () => {
      const el = current()
      return Boolean(el) && el.value.replace(/\D/g, '').replace(/^0+/, '').startsWith(want)
    }
    const enabledGenerate = () => {
      const el = current()
      const b = el && findGenerateButton(el)
      return b && !isDisabled(b) ? b : null
    }
    let gen = null
    for (let attempt = 0; attempt < 4; attempt++) {
      await waitFor(current, 2000, 150)
      const el = current()
      if (!el) break
      if (!hasAmount()) {
        await typeInto(el, want)
        if (!hasAmount() && current()) {
          const fresh = current()
          fresh.focus()
          valueSetter.call(fresh, want)
          fresh.dispatchEvent(new InputEvent('input', { bubbles: true, data: want, inputType: 'insertText' }))
          fresh.dispatchEvent(new Event('change', { bubbles: true }))
          fresh.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: want.slice(-1) }))
        }
      }
      await sleep(300)
      document.activeElement?.blur?.()
      gen = await waitFor(() => (hasAmount() ? enabledGenerate() : null), 2500, 200)
      if (gen) break
      report({ type: 'log', text: 'valor não ficou no campo, digitando de novo' })
      const stale = current()
      if (stale) {
        valueSetter.call(stale, '')
        stale.dispatchEvent(new Event('input', { bubbles: true }))
      }
      await sleep(400)
    }
    if (!hasAmount()) {
      report({ type: 'log', text: 'não consegui manter o valor no campo de depósito' })
      return
    }
    report({ type: 'log', text: `valor R$ ${want} digitado no depósito` })
    gen ||= enabledGenerate() || (current() && findGenerateButton(current()))
    if (!gen) {
      report({ type: 'log', text: 'botão de gerar dep��sito não encontrado, finalize você' })
      return
    }
    const label = textOf(gen)
    const generated = () => !current() || !gen.isConnected || !isShown(gen) || hasPaymentCode()
    for (let attempt = 0; attempt < 3 && !generated(); attempt++) {
      if (rectOf(gen).bottom > innerHeight || rectOf(gen).top < 0) {
        gen.scrollIntoView({ block: 'center' })
        await sleep(300)
      }
      if (attempt === 0) await tapReal(gen)
      else if (attempt === 1) tapSynthetic(gen)
      else gen.click?.()
      if (await waitFor(generated, 3000, 200)) break
      gen = enabledGenerate() || gen
    }
    const ok = generated()
    report({
      type: 'log',
      text: ok
        ? `clicou em "${label}" — QR code gerado, o pagamento fica com você`
        : `cliquei em "${label}" mas a página não mudou, tentando de novo`,
    })
    return ok
  }

  // Slow screens (several open at once) often miss the first pass, so the whole deposit is retried until the QR code shows up.
  const depositFlow = async () => {
    const end = Date.now() + 60000
    for (let attempt = 1; Date.now() < end; attempt++) {
      if (hasPaymentCode()) {
        report({ type: 'deposited' })
        return true
      }
      const ok = await openDeposit()
      if (ok === true || hasPaymentCode()) {
        report({ type: 'deposited' })
        return true
      }
      if (ok === 'skip') return false
      report({ type: 'log', text: `depósito não concluído, nova tentativa (${attempt + 1})` })
      await sleep(1500)
    }
    report({ type: 'log', text: 'não consegui gerar o depósito, finalize você' })
    return false
  }

  const PAYMENT_HINT = /qr ?code|copia e cola|copiar c[oó]digo|pix copia|c[oó]digo pix|escaneie|aguardando pagamento|pague com pix/i
  const hasPaymentCode = () => {
    if ([...document.querySelectorAll('canvas,img,svg')].some((el) => isShown(el) && /qr/i.test(`${el.className?.baseVal ?? el.className ?? ''} ${el.getAttribute('alt') || ''} ${el.id}`))) return true
    return PAYMENT_HINT.test((document.body.innerText || '').slice(0, 20000))
  }

  const GENERATE_TEXT = /^(gerar|gerar (pix|qr ?code|c[oó]digo|pagamento|dep[oó]sito)|deposit[ae]r?|deposite agora|depositar agora|dep[oó]sito agora|dep[oó]sitar|recarregue( agora)?|recarregar|recarregar agora|confirmar|confirmar dep[oó]sito|continuar|pr[oó]ximo|pagar|pague agora|ir para pagamento)$/i
  const isDisabled = (el) =>
    el.disabled || el.getAttribute('aria-disabled') === 'true' || /\b(disabled|is-disabled|van-button--disabled)\b/i.test(el.className?.baseVal ?? el.className ?? '')
  // The button that turns the typed amount into a payment code: searched from the amount field outwards, lowest match wins.
  const findGenerateButton = (input) => {
    const top = rectOf(input).top
    for (let box = input.parentElement, k = 0; box && box !== document.documentElement && k < 12; box = box.parentElement, k++) {
      const hits = [...box.querySelectorAll('button,a,[role="button"],div,span,uni-button,uni-view')].filter((el) => {
        if (el.children.length > 3 || !isRendered(el)) return false
        const t = textOf(el)
        return t && t.length <= 30 && GENERATE_TEXT.test(t) && rectOf(el).top >= top - 4
      })
      const leaves = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)))
      if (leaves.length) {
        const el = leaves.sort((a, b) => rectOf(b).top - rectOf(a).top)[0]
        return el.closest('button,a,[role="button"],uni-button') || el
      }
    }
    // Deep component trees put the button far from the field: fall back to the closest match below it on the page.
    const below = [...document.querySelectorAll('button,a,[role="button"],div,span,uni-button,uni-view')].filter((el) => {
      if (el.children.length > 3 || !isRendered(el)) return false
      const t = textOf(el)
      return t && t.length <= 30 && GENERATE_TEXT.test(t) && rectOf(el).top >= top - 4
    })
    const leaves = below.filter((el) => !below.some((o) => o !== el && el.contains(o)))
    if (!leaves.length) return null
    const el = leaves.sort((a, b) => rectOf(a).top - rectOf(b).top)[0]
    return el.closest('button,a,[role="button"],uni-button') || el
  }

  const waitReady = async () => {
    if (document.readyState !== 'complete') {
      await Promise.race([new Promise((r) => addEventListener('load', r, { once: true })), sleep(20000)])
    }
    await new Promise((resolve) => {
      let quiet = setTimeout(done, 1000)
      const cap = setTimeout(done, 5000)
      const mo = new MutationObserver(() => {
        clearTimeout(quiet)
        quiet = setTimeout(done, 1000)
      })
      mo.observe(document.documentElement, { childList: true, subtree: true })
      function done() {
        mo.disconnect()
        clearTimeout(quiet)
        clearTimeout(cap)
        resolve()
      }
    })
  }

  const run = async () => {
    const mode = await report({ type: 'start', host: location.host })
    if (!mode) return
    // The account already exists but the page reloaded before the deposit finished: pick the deposit up again.
    if (mode === 'deposit') {
      await waitReady()
      report({ type: 'log', text: 'página recarregou, retomando o depósito' })
      await depositFlow()
      return
    }
    // Hold the page where it opened while popups are handled; only the person's own wheel/touch/keys may scroll it.
    const scroller = document.scrollingElement || document.documentElement
    const startY = scroller.scrollTop
    let userScrolled = false
    const markUser = (e) => {
      if (e.isTrusted && !window.__ravokSynthetic) userScrolled = true
    }
    const holdScroll = () => {
      if (!userScrolled && Math.abs(scroller.scrollTop - startY) > 30) scroller.scrollTop = startY
    }
    const userEvents = ['wheel', 'touchmove', 'keydown']
    for (const t of userEvents) addEventListener(t, markUser, { capture: true, passive: true })
    addEventListener('scroll', holdScroll, { passive: true })
    const releaseScroll = () => {
      holdScroll()
      removeEventListener('scroll', holdScroll)
      for (const t of userEvents) removeEventListener(t, markUser, { capture: true })
    }

    await waitReady()
    holdScroll()
    let closed = 0
    let idle = 0
    let maskWait = 0
    let formSince = 0
    const phaseEnd = Date.now() + 30000
    for (let round = 0; round < 150 && Date.now() < phaseEnd; round++) {
      const formPw = findAnyPassword()
      // Once the sign-up form is visible and usable, stop hunting popups and go fill it.
      if (formPw && isRegisterForm(formRoot(formPw))) {
        formSince ||= Date.now()
        if (!coveredByPopup(formPw) && Date.now() - formSince > 600) break
        if (Date.now() - formSince > 6000) break
      } else formSince = 0
      const confirmClose = findConfirm()
      if (confirmClose) {
        tried.add(confirmClose)
        await tapReal(confirmClose)
        await waitFor(() => !stillThere(confirmClose), 800)
        report({ type: 'log', text: 'confirmou o fechamento do popup' })
        idle = 0
        holdScroll()
        continue
      }
      const shellButton = formPw ? null : findRegister()
      const mask = formPw ? null : findMask()
      const hit = findClose(mask, shellButton, formPw)
      if (!hit) {
        if (await pickChoice(mask)) {
          idle = 0
          maskWait = 0
          holdScroll()
          continue
        }
        // A dim layer behind a sign-up/login form belongs to that form: never tap it away.
        if (mask && (mask.parentElement || mask).querySelector('input[type="password"],input[type="tel"],input[type="text"]')) {
          triedMasks.add(mask)
        }
        if (mask && !triedMasks.has(mask) && ++maskWait >= 3) {
          // No X found but a dim layer is blocking the page: tapping the dim area closes most modals.
          triedMasks.add(mask)
          const mr = rectOf(mask)
          const y = Math.max(mr.top, 0) + 14
          const x = (Math.max(mr.left, 0) + Math.min(mr.right, innerWidth)) / 2
          if (document.elementFromPoint(x, y) === mask) {
            report({ type: 'log', text: 'nenhum X visível, tocando fora do modal' })
            await tapAt(x, y, mask)
            await sleep(900)
            if (!mask.isConnected || !isShown(mask)) closed++
          }
          maskWait = 0
          continue
        }
        const quick = formPw || closed
        if (!mask && ++idle >= (quick ? 3 : 10)) break
        await sleep(quick ? 350 : 600)
        continue
      }
      idle = 0
      maskWait = 0
      const target = hit.el
      tried.add(target)
      await tapReal(target)
      let gone = await waitFor(() => !stillThere(target), 700)
      if (!gone) {
        tapSynthetic(target)
        gone = await waitFor(() => !stillThere(target), 700)
      }
      if (gone) {
        closed++
        report({ type: 'log', text: `popup fechado (${hit.why})` })
        const sig = signature(target)
        if (sig) report({ type: 'learn', ...sig })
      }
      holdScroll()
    }
    releaseScroll()
    const form = await openRegisterForm()
    report({ type: 'log', text: form ? 'formulário de cadastro encontrado, preenchendo' : 'formulário de cadastro não encontrado' })
    if (form) {
      await report({ type: 'turn' })
      closed += await guardForm(400)
    }
    const account = form ? await fillForm(form) : null
    if (account) {
      closed += await afterRegister()
      await depositFlow()
    } else if (form) closed += await guardForm(8000)
    report({ type: 'done', closed, register: Boolean(form), account: Boolean(account) })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true })
  else run()
}

// Runs inside the casino page, one step at a time, so the main process can reload the page between steps.
async function pixStep(step, pin, extra) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const report = (msg) =>
    typeof window.__ravokAssistReport === 'function' ? window.__ravokAssistReport(msg).catch(() => null) : Promise.resolve(null)
  const say = (text) => report({ type: 'log', text })
  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
  const rectOf = (el) => el.getBoundingClientRect()
  const shown = (el) => {
    if (!el || !el.isConnected) return false
    const r = rectOf(el)
    if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = getComputedStyle(n)
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return false
    }
    return true
  }
  const onTop = (el) => {
    const r = rectOf(el)
    const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1)
    const y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1)
    const hit = document.elementFromPoint(x, y)
    return Boolean(hit) && (hit === el || el.contains(hit) || hit.contains(el))
  }
  const isDisabled = (el) =>
    el.disabled || el.getAttribute('aria-disabled') === 'true' || /\b(disabled|is-disabled)\b/i.test(el.className?.baseVal ?? el.className ?? '')
  const waitFor = async (fn, ms, every = 200) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const v = fn()
      if (v) return v
      await sleep(every)
    }
    return fn()
  }
  const tap = async (el) => {
    if (rectOf(el).bottom > innerHeight || rectOf(el).top < 0) {
      el.scrollIntoView({ block: 'center' })
      await sleep(300)
    }
    // The site slides pages in with an animation: tapping where the button was mid-slide hits its neighbour (Juros, Fundo).
    let r = rectOf(el)
    for (let i = 0; i < 12; i++) {
      await sleep(150)
      const now = rectOf(el)
      const moved = Math.abs(now.left - r.left) > 1 || Math.abs(now.top - r.top) > 1
      r = now
      if (!moved) break
    }
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    const ok = await report({ type: 'tap', x, y })
    if (!ok) (document.elementFromPoint(x, y) || el).click?.()
  }
  const CLICKABLE = 'button,a,[role="button"],uni-button'
  const findText = (re, { lowest = false, except = null } = {}) => {
    const hits = []
    for (const el of document.querySelectorAll('button,a,[role="button"],div,span,li,p,label,uni-view,uni-button,uni-text')) {
      if (el.children.length > 4 || (except && (except === el || except.contains(el)))) continue
      const t = textOf(el)
      if (!t || t.length > 40 || !re.test(t) || !shown(el) || !onTop(el)) continue
      hits.push(el)
    }
    const leaves = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)))
    if (!leaves.length) return null
    if (lowest) leaves.sort((a, b) => rectOf(b).top - rectOf(a).top)
    const el = leaves[0]
    return el.closest(CLICKABLE) || el
  }

  // The 6 boxes of the withdrawal password: a row of 6 equal cells side by side.
  const pinRows = () => {
    const rows = []
    for (const el of document.querySelectorAll('div,ul,section,label,form,uni-view')) {
      const kids = [...el.children].filter(shown)
      if (kids.length !== 6) continue
      const r = rectOf(el)
      if (r.width < 120 || r.height < 20 || r.height > 120) continue
      const rs = kids.map(rectOf)
      const { width: w, height: h, top } = rs[0]
      if (w < 16 || h < 16) continue
      const sameRow = rs.every((x) => Math.abs(x.top - top) < 6 && Math.abs(x.width - w) < 6 && Math.abs(x.height - h) < 6)
      const ordered = rs.every((x, i) => i === 0 || x.left > rs[i - 1].left)
      if (!sameRow || !ordered || !onTop(kids[0])) continue
      if (rows.some((o) => o.contains(el) || el.contains(o))) continue
      rows.push(el)
    }
    return rows.sort((a, b) => rectOf(a).top - rectOf(b).top)
  }
  const keypadKey = (d) => {
    for (const el of document.querySelectorAll('button,div,span,li,td,uni-view')) {
      if (el.children.length > 1 || textOf(el) !== d || !shown(el) || !onTop(el)) continue
      const r = rectOf(el)
      if (r.width >= 20 && r.height >= 20) return el.closest(CLICKABLE) || el
    }
    return null
  }
  const hasKeypad = () => [...'0123456789'].every((d) => keypadKey(d))
  const filledCount = (row) => {
    const box = row.parentElement || row
    const inputs = [...box.querySelectorAll('input')]
    if (!inputs.length) return null
    return inputs.reduce((n, i) => n + String(i.value || '').length, 0)
  }
  const fillRow = async (row) => {
    const first = [...row.children].find(shown) || row
    await tap(first)
    await sleep(400)
    if (hasKeypad()) {
      for (const d of pin) {
        const key = keypadKey(d)
        if (key) await tap(key)
        await sleep(180)
      }
      return
    }
    for (const d of pin) {
      await report({ type: 'type', text: d })
      await sleep(150)
    }
    await sleep(250)
    const filled = filledCount(row)
    if (filled !== null && filled < pin.length) {
      // Some sites keep focus on a hidden input that only accepts the whole code at once.
      const input = (row.parentElement || row).querySelector('input')
      if (input) {
        input.focus()
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, pin)
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: pin, inputType: 'insertText' }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }
  }
  const CONFIRM = /^(confirmar|confirmar senha|salvar|enviar|ok|concluir|definir|definir senha|pr[oó]ximo|continuar|confirm)$/i
  const tapConfirm = async () => {
    const btn = findText(CONFIRM, { lowest: true })
    if (btn && !isDisabled(btn)) {
      await tap(btn)
      return true
    }
    return false
  }
  const fillPinScreen = async (maxRows) => {
    const rows = pinRows().slice(0, maxRows)
    for (const row of rows) {
      await fillRow(row)
      await sleep(500)
    }
    document.activeElement?.blur?.()
    await sleep(500)
    if (pinRows().length) await tapConfirm()
    return rows.length
  }

  const WITHDRAW = /^(saques?|sacar|retirar|retirada|retirar fundos|saque r[aá]pido)$/i
  const PROFILE = /^(perfil|meu perfil|minha conta|conta|eu|mine|me|meu|pessoal|usu[aá]rio|centro pessoal)$/i
  const ADD_ACCOUNT = /^\+?\s*(adicionar conta( para saque)?|adicionar conta de saque|vincular conta|adicionar conta banc[aá]ria|adicionar m[eé]todo de saque)$/i
  const ADD = /^\+?\s*adicionar\s*[>›]?$/i

  const ALL_BTN = /^(tudo|todos?|m[aá]ximo|m[aá]x\.?|all)$/i
  // "Tudo" also exists on the home page (Popular > Tudo), so it can never prove we are on the withdrawal screen.
  const onForm = () => Boolean(findText(/^(valor do saque|solicitar saque|conta para recebimento)$/i))
  const MESSAGES = /^(mensagens?|notifica[cç][õo]es?|messages?|inbox|central de mensagens)$/i
  const onMessages = () => {
    const el = findText(MESSAGES)
    return Boolean(el) && rectOf(el).top < 120
  }

  if (step === 'where') {
    return onForm() ? 'form' : onMessages() ? 'messages' : findText(WITHDRAW) ? 'profile' : 'other'
  }

  if (step === 'profile') {
    if (onForm() || findText(WITHDRAW)) return 'ok'
    const btn = findText(/^(perfil|meu perfil)$/i, { lowest: true }) || findText(PROFILE, { lowest: true })
    if (!btn) return onMessages() ? 'messages' : 'noprofile'
    say('abrindo o perfil')
    await sleep(400)
    await tap(btn)
    const landed = await waitFor(() => (onForm() || findText(WITHDRAW) ? 'ok' : null), 6000)
    if (landed) await sleep(800)
    return landed || (onMessages() ? 'messages' : 'nowithdraw')
  }

  if (step === 'withdraw') {
    const onWithdrawPage = () => onForm() || /withdraw/i.test(location.pathname + location.hash)
    const arrived = () => onWithdrawPage() || pinRows().length || findText(ADD_ACCOUNT)
    if (onWithdrawPage()) return 'ok'
    for (let attempt = 0; attempt < 3; attempt++) {
      const btn = await waitFor(() => findText(WITHDRAW), 4000)
      if (!btn) return 'nowithdraw'
      say('abrindo saques')
      const before = location.href
      await tap(btn)
      await waitFor(() => location.href !== before || arrived(), 6000)
      await waitFor(arrived, 3500)
      if (arrived()) return 'ok'
      if (onMessages()) return 'messages'
      if (location.href !== before) {
        say(`o site abriu ${location.pathname} em vez de saques, voltando e tentando de novo`)
        history.back()
        await waitFor(() => (location.href === before ? true : null), 4000)
        await sleep(900)
      }
    }
    return 'nowithdraw'
  }

  if (step === 'records') {
    const REC = /^(registros?|hist[oó]rico|records?)\b/i
    const tabsOf = () => findText(/^conta para recebimento$/i) || findText(/^solicitar saque$/i)
    const looseRecord = () => {
      for (const el of document.querySelectorAll('div,span,li,a,p,uni-view,uni-text')) {
        if (el.children.length > 2) continue
        const t = textOf(el)
        if (t && t.length < 30 && REC.test(t) && rectOf(el).top < 220 && rectOf(el).width > 4) return el
      }
      return null
    }
    for (let i = 0; i < 8; i++) {
      const rec = looseRecord()
      if (rec) {
        rec.scrollIntoView({ inline: 'center', block: 'nearest' })
        await sleep(400)
        say('abrindo o registro de saques')
        await tap(rec.closest(CLICKABLE) || rec)
        return 'ok'
      }
      const anchor = tabsOf()
      let box = anchor && anchor.parentElement
      while (box && box.scrollWidth <= box.clientWidth + 4) box = box.parentElement
      if (box) box.scrollBy({ left: 160, behavior: 'instant' })
      else if (anchor) await tap(anchor)
      await sleep(500)
    }
    return 'norecord'
  }

  if (step === 'password') {
    if (onForm()) {
      // The withdrawal form is open, so the password is already set: its 6 boxes are not the "set password" screen.
      const receiving = findText(/^conta para recebimento$/i)
      if (receiving && !findText(ADD_ACCOUNT)) {
        await tap(receiving)
        await sleep(800)
      }
      return 'already'
    }
    const found = await waitFor(() => (pinRows().length ? 'pin' : findText(ADD_ACCOUNT) ? 'already' : null), 10000, 300)
    if (found === 'already') return 'already'
    if (found !== 'pin') return 'missing'
    say('definindo a senha de saque de 6 dígitos')
    await fillPinScreen(2)
    const gone = await waitFor(() => !pinRows().length || findText(ADD_ACCOUNT), 6000, 300)
    if (!gone) {
      await tapConfirm()
      await waitFor(() => !pinRows().length, 4000, 300)
    }
    return pinRows().length ? 'stuck' : 'set'
  }

  if (step === 'account') {
    const addAccount = await waitFor(() => findText(ADD_ACCOUNT) || findText(ADD), 8000, 300)
    if (!addAccount) return 'noadd'
    let addBtn = ADD.test(textOf(addAccount)) ? addAccount : null
    if (!addBtn) {
      say('clicando em adicionar conta para saque')
      await tap(addAccount)
      const next = await waitFor(() => (pinRows().length ? 'pin' : findText(ADD, { except: addAccount }) ? 'add' : null), 8000, 300)
      if (next === 'pin') {
        await fillPinScreen(1)
        await waitFor(() => !pinRows().length, 5000, 300)
      }
      addBtn = await waitFor(() => findText(ADD, { except: addAccount }), 5000, 300)
    }
    if (!addBtn) return 'nopix'
    say('clicando em adicionar PIX')
    await tap(addBtn)
    const pinAgain = await waitFor(() => pinRows().length, 6000, 300)
    if (pinAgain) {
      say('digitando a senha de saque novamente')
      await fillPinScreen(1)
      await waitFor(() => !pinRows().length, 5000, 300)
    }
    return 'ok'
  }

  if (step === 'pixkey') {
    const { type = 'CPF', key = '', filler = '', holder = '' } = extra || {}
    const TYPES = {
      CPF: /^cpf$/i,
      Telefone: /^(telefone|celular|phone|n[uú]mero de telefone|n[uú]mero de celular)$/i,
      'E-mail': /^e-?mail$/i,
      'Chave aleatória': /^(chave aleat[oó]ria|aleat[oó]ria|evp|chave evp|random)$/i,
    }
    const target = TYPES[type] || TYPES.CPF
    const anyType = new RegExp(
      `^(?:${Object.values(TYPES)
        .map((r) => r.source.replace(/^\^/, '').replace(/\$$/, ''))
        .join('|')})$`,
      'i',
    )
    const SKIP = ['hidden', 'checkbox', 'radio', 'password', 'file', 'submit', 'button']
    const fields = () =>
      [...document.querySelectorAll('input,textarea')]
        .filter((i) => !SKIP.includes(i.type) && !i.readOnly && !i.disabled && shown(i) && onTop(i))
        .sort((a, b) => rectOf(a).top - rectOf(b).top)

    if (!(await waitFor(() => fields().length, 8000, 300))) return 'nofields'

    const native = [...document.querySelectorAll('select')].find(
      (s) => shown(s) && [...s.options].some((o) => anyType.test(textOf(o))),
    )
    if (native) {
      const opt = [...native.options].find((o) => target.test(textOf(o)))
      if (!opt) return 'notype'
      if (native.value !== opt.value) {
        say(`mudando o tipo de chave para ${type}`)
        native.value = opt.value
        native.dispatchEvent(new Event('input', { bubbles: true }))
        native.dispatchEvent(new Event('change', { bubbles: true }))
        await sleep(700)
      }
    } else {
      const current = findText(anyType)
      if (current && !target.test(textOf(current))) {
        say(`mudando o tipo de chave para ${type}`)
        await tap(current)
        const option = await waitFor(() => findText(target, { except: current }), 4000, 250)
        if (!option) return 'notype'
        await tap(option)
        await sleep(800)
      }
    }

    const setValue = async (input, value) => {
      await tap(input)
      await sleep(200)
      input.focus()
      const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value)
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(250)
    }

    const editable = fields()
    if (!editable.length) return 'nofields'
    // Some sites ask for the holder's name before the key: tell the two kinds of field apart by placeholder/label text.
    const contextOf = (input) => {
      const parts = [input.placeholder, input.getAttribute('aria-label'), input.name, input.id]
      let box = input.parentElement
      for (let i = 0; i < 3 && box; i++, box = box.parentElement) {
        const own = [...box.childNodes].filter((n) => n.nodeType === 3 || (n.nodeType === 1 && !n.contains(input) && !n.querySelector('input,textarea')))
        parts.push(own.map((n) => (n.textContent || '').trim()).join(' ').slice(0, 80))
        if (box.querySelectorAll('input,textarea').length > 1) break
      }
      return parts.filter(Boolean).join(' ').toLowerCase()
    }
    const NAME_RE = /\b(nome|name|titular|benefici[aá]rio|holder)\b/
    const KEY_RE = /(chave|pix|cpf|telefone|celular|phone|e-?mail|key|aleat)/
    const isName = (i) => {
      const c = contextOf(i)
      return NAME_RE.test(c) && !(KEY_RE.test(c) && !/nome|name/.test(c.replace(/chave|pix/g, '')))
    }
    const nameFields = editable.filter(isName)
    const keyFields = editable.filter((i) => !nameFields.includes(i))
    const keyField = keyFields.find((i) => KEY_RE.test(contextOf(i))) || keyFields[0] || editable[0]
    say(`preenchendo a chave ${type}`)
    for (const input of nameFields) {
      if (input !== keyField && !String(input.value || '').trim()) await setValue(input, holder || 'Maria Silva')
    }
    await setValue(keyField, key)
    for (const input of editable) {
      if (input === keyField || nameFields.includes(input) || String(input.value || '').trim()) continue
      if (type !== 'CPF') await setValue(input, filler)
    }
    document.activeElement?.blur?.()
    await sleep(400)

    const SUBMIT = /^(adicionar|confirmar|salvar|vincular|enviar|ok|concluir|cadastrar)$/i
    const btn = await waitFor(() => {
      const b = findText(SUBMIT, { lowest: true })
      return b && !isDisabled(b) ? b : null
    }, 4000, 250)
    if (!btn) return 'noconfirm'
    say('clicando em adicionar')
    await tap(btn)
    if (await waitFor(() => pinRows().length, 3000, 300)) {
      say('digitando a senha de saque para confirmar')
      await fillPinScreen(1)
      await waitFor(() => !pinRows().length, 5000, 300)
    }
    return 'added'
  }

  if (step === 'withdrawall') {
    const REQUEST = /^solicitar saque$/i
    const ALL = /^(tudo|todos?|m[aá]ximo|m[aá]x\.?|all)$/i
    const CONFIRM_WD = /^(confirmar saque|confirmar retirada|sacar|solicitar saque|confirmar)$/i
    if (onMessages()) return 'messages'
    const tab = findText(REQUEST)
    if (tab && !pinRows().length && !findText(ALL)) {
      await tap(tab)
      await sleep(700)
    }
    const all = await waitFor(() => (onForm() ? findText(ALL) : null), 8000, 300)
    if (!all) return 'noall'
    say('escolhendo o valor total do saque')
    await tap(all)
    await sleep(800)
    const row = await waitFor(() => pinRows()[0], 6000, 300)
    if (!row) return 'nopin'
    say('digitando a senha de saque')
    await fillRow(row)
    document.activeElement?.blur?.()
    await sleep(600)
    const btn = await waitFor(() => {
      const b = findText(CONFIRM_WD, { lowest: true })
      return b && !isDisabled(b) ? b : null
    }, 5000, 300)
    if (!btn) return 'noconfirm'
    say('confirmando o saque')
    await tap(btn)
    return 'done'
  }
  return 'unknown'
}

const learnFile = () => path.join(app.getPath('userData'), 'assistente-aprendizado.json')
let learnedCache = null
let learnSaveTimer = null

function learnedList() {
  if (!learnedCache) {
    try {
      learnedCache = JSON.parse(fs.readFileSync(learnFile(), 'utf8'))
      if (!Array.isArray(learnedCache)) learnedCache = []
    } catch {
      learnedCache = []
    }
  }
  return learnedCache
}

function learnedForPage() {
  return [...learnedList()]
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 150)
    .map(({ sel, text }) => ({ sel, text }))
}

function rememberClose(sel, text) {
  if (typeof sel !== 'string' || sel.length > 200) return
  const list = learnedList()
  const found = list.find((i) => i.sel === sel && i.text === (text || ''))
  if (found) found.hits++
  else list.push({ sel, text: String(text || '').slice(0, 20), hits: 1 })
  if (list.length > 300) {
    list.sort((a, b) => b.hits - a.hits)
    list.length = 300
  }
  clearTimeout(learnSaveTimer)
  learnSaveTimer = setTimeout(() => {
    fs.promises.writeFile(learnFile(), JSON.stringify(list, null, 2)).catch(() => {})
  }, 1000)
}

// Each logged-in user gets their own accounts file so switching users never shows someone else's accounts.
const legacyAccountsFile = () => path.join(app.getPath('userData'), 'contas.json')
let accountsOwner = ''
const accountsFile = () =>
  path.join(app.getPath('userData'), `contas-${createHash('sha256').update(accountsOwner).digest('hex').slice(0, 16)}.json`)
let accounts = []

function loadAccounts() {
  if (!accountsOwner) return []
  try {
    const raw = JSON.parse(fs.readFileSync(accountsFile(), 'utf8'))
    return Array.isArray(raw) ? raw.map((a) => ({ ...a, pass: decrypt(a.pass) })) : []
  } catch {
    return []
  }
}

function saveAccounts() {
  if (accountsOwner) {
    const out = accounts.map((a) => ({ ...a, pass: encrypt(a.pass) }))
    fs.writeFileSync(accountsFile(), JSON.stringify(out, null, 2))
  }
  controlWin?.webContents.send('accounts:update', accounts)
}

function setAccountsOwner(email) {
  const owner = String(email || '').trim().toLowerCase()
  if (owner === accountsOwner) return
  accountsOwner = owner
  // The old shared contas.json goes to the first user that logs in after this update, once.
  if (owner && !fs.existsSync(accountsFile()) && fs.existsSync(legacyAccountsFile())) {
    try {
      fs.renameSync(legacyAccountsFile(), accountsFile())
    } catch {}
  }
  accounts = loadAccounts()
  controlWin?.webContents.send('accounts:update', accounts)
}

const FIRST_NAMES = [
  'Lucas', 'Gabriel', 'Mateus', 'Pedro', 'Rafael', 'Gustavo', 'Felipe', 'Bruno', 'Thiago', 'Diego',
  'Rodrigo', 'Leonardo', 'Vinicius', 'Eduardo', 'Marcelo', 'Andre', 'Caio', 'Henrique', 'Samuel', 'Daniel',
  'Ana', 'Beatriz', 'Julia', 'Larissa', 'Camila', 'Fernanda', 'Mariana', 'Leticia', 'Amanda', 'Bruna',
  'Gabriela', 'Isabela', 'Carolina', 'Vitoria', 'Rafaela', 'Juliana', 'Patricia', 'Aline', 'Natalia', 'Luana',
]
const LAST_NAMES = [
  'Silva', 'Santos', 'Oliveira', 'Souza', 'Rodrigues', 'Ferreira', 'Alves', 'Pereira', 'Lima', 'Gomes',
  'Costa', 'Ribeiro', 'Martins', 'Carvalho', 'Almeida', 'Lopes', 'Soares', 'Fernandes', 'Vieira', 'Barbosa',
  'Rocha', 'Dias', 'Nascimento', 'Andrade', 'Moreira', 'Nunes', 'Marques', 'Machado', 'Mendes', 'Freitas',
  'Cardoso', 'Ramos', 'Teixeira', 'Araujo', 'Correia', 'Pinto', 'Moura', 'Campos', 'Cavalcanti', 'Monteiro',
]
const pick = (list) => list[randomInt(list.length)]
const plain = (s) => s.normalize('NFD').replace(/[^a-zA-Z]/g, '').toLowerCase()

function randomPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower = 'abcdefghijkmnpqrstuvwxyz'
  const digits = '23456789'
  const all = upper + lower + digits
  const chars = [pick(upper), pick(lower), pick(lower), pick(digits), pick(digits)]
  const length = 9 + randomInt(4)
  while (chars.length < length) chars.push(all[randomInt(all.length)])
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

const DDDS = [11, 12, 13, 15, 16, 17, 19, 21, 24, 27, 31, 32, 34, 35, 41, 43, 44, 47, 48, 51, 54, 61, 62, 67, 71, 75, 79, 81, 83, 84, 85, 91, 92, 98]
function randomPhone() {
  let rest = ''
  for (let i = 0; i < 8; i++) rest += randomInt(i === 0 ? 6 : 0, 10)
  return `${pick(DDDS)}9${rest}`
}

function randomAccount() {
  return { ...randomCredentials(), phone: randomPhone() }
}

function randomCredentials() {
  const taken = new Set(accounts.map((a) => a.user))
  for (let attempt = 0; attempt < 50; attempt++) {
    const first = pick(FIRST_NAMES)
    const last = pick(LAST_NAMES)
    const f = plain(first)
    const l = plain(last)
    const styles = [f + l.slice(0, 3), f.slice(0, 5) + l.slice(0, 4), l + f.slice(0, 2), f + l[0]]
    const base = pick(styles).slice(0, 9)
    const user = (base + String(randomInt(10, 10000))).slice(0, 14)
    if (user.length < 6 || taken.has(user)) continue
    return { name: `${first} ${last}`, user, pass: randomPassword() }
  }
  return { name: `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`, user: `user${randomInt(100000, 999999)}`, pass: randomPassword() }
}

function addAccount(state, msg) {
  if (typeof msg.user !== 'string' || typeof msg.pass !== 'string') return
  const host = String(msg.host || '').replace(/^www\./, '').slice(0, 100)
  const id = randomUUID()
  state.accountId = id
  accounts.unshift({
    id,
    createdAt: Date.now(),
    casa: host,
    url: String(msg.url || '').slice(0, 200),
    user: msg.user.slice(0, 40),
    pass: msg.pass.slice(0, 40),
    name: msg.hasName ? String(msg.name || '').slice(0, 60) : '',
    phone: msg.hasPhone ? String(msg.phone || '').slice(0, 20) : '',
    saque: '',
    siteId: '',
    proxy: effectiveProxy(state) ? proxyLabel(effectiveProxy(state)) : '',
    proxyData: effectiveProxy(state) ? { ...effectiveProxy(state) } : null,
    proxySession: state.sessionId,
    screen: state.number,
  })
  saveAccounts()
  notifyAccountsRunning()
  setTimeout(() => snapshotSession(state), 4000)
  log(`Tela ${state.number}: conta ${msg.user} salva em Contas`)
}

// Screens all open right away; with "Delay por Link" on, each one fills its sign-up only after the previous account + N seconds.
let fillQueue = Promise.resolve()
let fillDelay = { on: false, sec: 0 }
let depositRange = { min: 0, max: 0 }

function randomDeposit() {
  let min = Math.max(0, Math.round(depositRange.min))
  let max = Math.max(0, Math.round(depositRange.max))
  if (min > max) [min, max] = [max, min]
  if (!max) return null
  if (!min) min = max
  return min + randomInt(max - min + 1)
}
const TURN_MAX_MS = 25 * 60 * 1000

async function waitTurn(state) {
  if (!fillDelay.on) return
  const previous = fillQueue
  let release
  const mine = new Promise((r) => (release = r))
  fillQueue = previous.then(() => mine)
  const number = state.number
  const finish = () => {
    clearTimeout(cap)
    clearInterval(alive)
    if (state.releaseTurn === finish) state.releaseTurn = null
    release()
  }
  const cap = setTimeout(finish, TURN_MAX_MS)
  const alive = setInterval(() => {
    if (!screens.has(number)) finish()
  }, 1000)
  state.releaseTurn = finish
  await previous
  log(`Tela ${number}: vez desta tela criar a conta`)
}

async function onAssistReport(state, page, msg) {
  if (!msg || typeof msg !== 'object') return null
  if (msg.type === 'start') {
    if (!data.settings.assistant || !msg.host || state.pixBusy) return false
    // Saved accounts are already registered: hunting popups there only produces clicks the user never asked for.
    if (state.fromAccount || state.botOff) return false
    state.assistFilled ||= new Set()
    if (state.assistFilled.has(msg.host)) return state.depositPending?.has(msg.host) ? 'deposit' : false
    if (state.assistHosts.has(msg.host)) return 'resume'
    state.assistHosts.add(msg.host)
    log(`Tela ${state.number}: assistente aguardando a página carregar para fechar os popups`)
    return true
  }
  if (msg.type === 'tap' || msg.type === 'type' || msg.type === 'creds') state.assistActiveAt = Date.now()
  if (msg.type === 'tap') {
    // 'off' is truthy, so callers skip their synthetic-click fallback too.
    if (state.botOff && !state.pixBusy) return 'off'
    const cdp = state.cdps.get(page)
    if (!cdp || !Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return false
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: msg.x, y: msg.y }] })
      await new Promise((r) => setTimeout(r, 60))
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      return true
    } catch {
      try {
        const base = { x: msg.x, y: msg.y, button: 'left', clickCount: 1 }
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
        return true
      } catch {
        return false
      }
    }
  }
  if (msg.type === 'log') {
    if (typeof msg.text === 'string') log(`Tela ${state.number}: assistente ${msg.text.slice(0, 120)}`)
    return true
  }
  if (msg.type === 'learn') {
    rememberClose(msg.sel, msg.text)
    return true
  }
  if (msg.type === 'creds') return randomAccount()
  if (msg.type === 'depositAmount') {
    const amount = randomDeposit()
    if (amount) log(`Tela ${state.number}: valor de depósito sorteado R$ ${amount}`)
    return amount
  }
  if (msg.type === 'type') {
    const cdp = state.cdps.get(page)
    if (!cdp || typeof msg.text !== 'string' || msg.text.length > 64) return false
    try {
      await cdp.send('Input.insertText', { text: msg.text })
      return true
    } catch {
      return false
    }
  }
  if (msg.type === 'turn') {
    await waitTurn(state)
    return true
  }
  if (msg.type === 'account') {
    state.assistFilled ||= new Set()
    if (msg.host) state.assistFilled.add(String(msg.host))
    if (msg.host && randomDeposit()) (state.depositPending ||= new Set()).add(String(msg.host))
    addAccount(state, msg)
    enableModernShims(state).catch(() => {})
    const release = state.releaseTurn
    if (release) {
      state.releaseTurn = null
      log(`Aguardando ${fillDelay.sec}s para a próxima tela criar a conta`)
      setTimeout(release, fillDelay.sec * 1000)
    }
    return true
  }
  if (msg.type === 'deposited') {
    for (const host of state.depositPending || []) state.depositPending.delete(host)
    return true
  }
  if (msg.type === 'done') {
    enableModernShims(state).catch(() => {})
    state.releaseTurn?.()
    const closed = Number(msg.closed) || 0
    const tail = !msg.register
      ? ', botão de registro não encontrado'
      : msg.account
        ? ', conta criada e salva em Contas'
        : ', registro aberto, aguardando você'
    log(`Tela ${state.number}: ${closed} popup(s) fechado(s)${tail}`)
    return true
  }
  return null
}

async function checkIp(state) {
  state.ip = null
  state.country = null
  state.ipError = false
  notifyScreens()
  try {
    const res = await state.ipSession.fetch('https://api.ipify.org?format=json', {
      cache: 'no-store',
      signal: AbortSignal.timeout(IP_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const { ip } = await res.json()
    state.ip = ip
    try {
      const geo = await fetch(`https://ipwho.is/${ip}?fields=country_code,success`, {
        signal: AbortSignal.timeout(IP_TIMEOUT_MS),
      }).then((r) => r.json())
      if (geo.success !== false) state.country = geo.country_code
    } catch {}
    log(`Tela ${state.number}: IP ${ip}${state.country ? ` (${state.country})` : ''}`)
  } catch {
    state.ipError = true
    log(`Tela ${state.number}: não foi possível verificar o IP (verifique a proxy)`)
  }
  await showIpOnPages(state)
  notifyScreens()
}

async function refreshConnection(state, { reload = true } = {}) {
  state.proxyServer.closeConnections()
  await state.ipSession.closeAllConnections()
  if (reload) {
    state.assistHosts.clear()
    const pages = await state.browser.pages().catch(() => [])
    await Promise.all(pages.map((p) => p.reload().catch(() => {})))
  }
  checkIp(state)
}

function cleanupScreen(state) {
  if (!screens.has(state.number)) return
  screens.delete(state.number)
  clearInterval(state.snapTimer)
  state.proxyServer.close(true).catch(() => {})
  notifyScreens()
  updateHotkey()
  if (state.accountId) notifyAccountsRunning()
}

async function createScreen(index, cell, url, chromePath, extra = {}) {
  const { puppeteer, Server } = await loadChromeModules()
  const number = extra.number || index + 1
  if (screens.has(number)) return
  const list = activeProxies()
  const portrait = Boolean(data.settings.portraitMode)
  if (portrait) {
    // Phone proportions (about 9:19.5) centered inside the screen's grid cell.
    const width = Math.min(cell.width, Math.max(360, Math.round(cell.height * 0.5)))
    cell = { ...cell, x: cell.x + Math.round((cell.width - width) / 2), width }
  }
  const state = {
    portrait,
    cell,
    number,
    proxy: list.length ? list[index % list.length] : null,
    pinned: Boolean(extra.fromAccount),
    pinnedProxy: extra.pinnedProxy || null,
    fromAccount: Boolean(extra.fromAccount),
    accountId: extra.accountId || null,
    sessionId: extra.sessionId || randomBytes(6).toString('hex'),
    homeUrl: url,
    device: pickDevice(),
    ip: null,
    country: null,
    ipError: false,
    browser: null,
    overlayScripts: new Map(),
    assistHosts: new Set(),
    cdps: new Map(),
    speedScripts: new Map(),
    activePage: null,
    viewport: null,
    mirrorQueue: null,
  }

  state.proxyServer = new Server({
    port: 0,
    host: '127.0.0.1',
    prepareRequestFunction: () => {
      const proxy = effectiveProxy(state)
      return { upstreamProxyUrl: proxy ? upstreamUrl(proxy, state.sessionId) : null }
    },
  })
  await state.proxyServer.listen()
  const localProxy = `127.0.0.1:${state.proxyServer.port}`

  state.ipSession = session.fromPartition(`ipcheck-${number}`)
  await state.ipSession.setProxy({ proxyRules: `http://${localProxy}` })

  const profileDir = path.join(
    app.getPath('userData'),
    'chrome-profiles',
    extra.fromAccount && extra.accountId ? `conta-${extra.accountId}` : `tela-${number}`,
  )
  const freshProfile = !fs.existsSync(path.join(profileDir, 'Default'))
  try {
    const { port, pid } = await launchDetachedChrome(
      chromePath,
      profileDir,
      [
        '--new-window',
        `--window-position=${cell.x},${cell.y}`,
        `--window-size=${cell.width},${cell.height}`,
        `--proxy-server=http://${localProxy}`,
        '--proxy-bypass-list=<-loopback>',
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        '--hide-crash-restore-bubble',
        '--disable-extensions',
        '--disable-sync',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,PasswordManagerOnboarding,PasswordLeakDetection,AutofillServerCommunication,IsolateOrigins,site-per-process',
        '--disable-save-password-bubble',
        '--lang=pt-BR',
      ],
      { keep: Boolean(extra.fromAccount && extra.accountId) },
    )
    state.browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${port}`,
      defaultViewport: null,
    })
    state.pid = pid
    try {
      const browserCdp = await state.browser.target().createCDPSession()
      await browserCdp.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: false })
    } catch {}
    const iconArgs = [pid, number, chromePath, profileDir]
    for (const delay of [1500, 4500, 10000]) setTimeout(() => applyScreenIcon(...iconArgs), delay)
  } catch (err) {
    await state.proxyServer.close(true).catch(() => {})
    throw err
  }

  screens.set(number, state)
  state.browser.on('disconnected', () => cleanupScreen(state))
  state.browser.on('targetcreated', async (target) => {
    if (target.type() !== 'page') return
    const page = await target.page().catch(() => null)
    if (page) setupPage(state, page)
  })

  const page =
    (await state.browser.pages())[0] ||
    (await (await state.browser.waitForTarget((t) => t.type() === 'page')).page())
  await Promise.race([setupPage(state, page), new Promise((r) => setTimeout(r, SETUP_TIMEOUT_MS))])
  page.on('close', async () => {
    const remaining = await state.browser.pages().catch(() => [])
    if (remaining.length === 0) state.browser.close().catch(() => {})
  })

  if (state.fromAccount && freshProfile) await restoreSession(state, page)
  if (!state.fromAccount) state.snapTimer = setInterval(() => snapshotSession(state), 20000)

  loadWithRetry(state, page, url)

  const proxy = effectiveProxy(state)
  log(
    `Tela ${number} aberta no Chrome (${state.device.label})${proxy ? ` com proxy ${proxy.host}:${proxy.port}` : ' sem proxy'}`,
  )
  notifyScreens()
  updateHotkey()
  checkIp(state)
}

// Screens opened by the main button have a throwaway profile, so the login (cookies + localStorage) of their account is
// copied here and restored the first time the account is reopened from Contas, which then keeps its own profile.
const sessionFile = (id) => path.join(app.getPath('userData'), 'sessoes', `${String(id).replace(/[^\w-]/g, '')}.json`)

async function snapshotSession(state) {
  if (!state.accountId || state.fromAccount) return
  try {
    const page = await activePageOf(state)
    const cdp = page && state.cdps.get(page)
    if (!cdp || !/^https?:/.test(page.url())) return
    const { cookies } = await cdp.send('Network.getAllCookies')
    const store = await page.evaluate(() => ({
      origin: location.origin,
      local: JSON.parse(JSON.stringify(localStorage)),
    }))
    await fs.promises.mkdir(path.dirname(sessionFile(state.accountId)), { recursive: true })
    await fs.promises.writeFile(sessionFile(state.accountId), JSON.stringify({ cookies, ...store }))
  } catch {}
}

async function restoreSession(state, page) {
  try {
    const saved = JSON.parse(await fs.promises.readFile(sessionFile(state.accountId), 'utf8'))
    const cdp = state.cdps.get(page)
    if (!cdp) return
    const cookies = (saved.cookies || []).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      ...(c.session ? {} : { expires: c.expires }),
    }))
    if (cookies.length) await cdp.send('Network.setCookies', { cookies }).catch(() => {})
    if (saved.origin && saved.local && Object.keys(saved.local).length) {
      await page.evaluateOnNewDocument(
        (origin, local) => {
          if (location.origin !== origin) return
          for (const [k, v] of Object.entries(local)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v)
        },
        saved.origin,
        saved.local,
      )
    }
  } catch {}
}

// The first load of a freshly launched Chrome sometimes never starts (needed a manual refresh); retry until a real page is there.
async function loadWithRetry(state, page, url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (page.isClosed() || !screens.has(state.number)) return
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: attempt === 1 ? 45000 : 30000 })
      if (/^https?:/.test(page.url())) {
        await reloadIfStuck(state, page)
        return
      }
    } catch (err) {
      if (page.isClosed()) return
      // A navigation that was interrupted (redirect, the site's own routing, the assistant acting) already left a
      // real page behind; calling goto again would throw away whatever the assistant had started, like a sign-up.
      if (!/timeout/i.test(String(err && err.message)) && /^https?:/.test(page.url())) return
      if (attempt === 3) log(`Tela ${state.number}: erro ao carregar o link (${err.message.split('\n')[0]})`)
    }
    await new Promise((r) => setTimeout(r, 1200))
  }
}

// Safety net: if the page never finishes loading (stuck on the site's loading screen), do the refresh the user had to do by hand.
async function reloadIfStuck(state, page) {
  const loaded = await page
    .waitForFunction(() => document.readyState === 'complete', { timeout: STUCK_LOAD_MS, polling: 500 })
    .then(() => true)
    .catch(() => false)
  if (loaded || page.isClosed() || !screens.has(state.number)) return
  // The page never reached readyState "complete" (some sites keep a request pending forever), but if the assistant is
  // already tapping or typing, the page is alive: reloading now would wipe the sign-up form in progress.
  if (state.assistActiveAt && Date.now() - state.assistActiveAt < 90000) return
  log(`Tela ${state.number}: o site travou no carregamento, recarregando automaticamente`)
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
}

async function closeAccountScreen(id) {
  const state = [...screens.values()].find((s) => s.accountId === id)
  if (!state) return false
  await state.browser?.close().catch(() => {})
  cleanupScreen(state)
  return true
}

// Closes every screen opened by the main button; screens opened from Contas stay unless includeAccounts is true.
async function closeAllScreens(includeAccounts = true) {
  const all = [...screens.values()].filter((s) => includeAccounts || !s.fromAccount)
  await Promise.all(all.map((s) => s.browser?.close().catch(() => {})))
  for (const s of all) cleanupScreen(s)
}

function parseHttpUrl(value) {
  try {
    const u = new URL(String(value || '').trim())
    return ['http:', 'https:'].includes(u.protocol) ? u : null
  } catch {
    return null
  }
}

function multiLinkList() {
  const ml = data.settings.multiLinks
  if (!ml || !ml.enabled || !Array.isArray(ml.links)) return []
  return ml.links.map((l) => parseHttpUrl(l && l.url)).filter(Boolean).map((u) => u.href)
}

// Screens are split into contiguous blocks: 3 screens / 2 links -> 2 + 1, 6 screens / 2 links -> 3 + 3.
function linkForScreen(index, total, links) {
  return links[Math.min(links.length - 1, Math.floor((index * links.length) / total))]
}

async function startScreens(url, opts = {}) {
  const multi = multiLinkList()
  const parsed = multi.length ? new URL(multi[0]) : parseHttpUrl(url)
  if (!parsed) {
    throw new Error('Link inválido. Use um endereço começando com http:// ou https://')
  }
  const links = multi.length ? multi : [parsed.href]

  const chromePath = findChrome()
  if (!chromePath) {
    throw new Error('Google Chrome não encontrado. Instale o Chrome (ou Chromium/Edge) e tente de novo.')
  }

  if (startBusy) throw new Error('As telas já estão abrindo, aguarde um instante.')
  startBusy = true
  try {
    return await runStart(parsed, links, chromePath, opts)
  } finally {
    startBusy = false
  }
}
let startBusy = false

async function runStart(parsed, links, chromePath, opts) {
  await closeAllScreens(false)

  const rows = Math.min(Math.max(Number(opts.rows ?? data.settings.rows) || 1, 1), 6)
  const cols = Math.min(Math.max(Number(opts.cols ?? data.settings.cols) || 1, 1), 8)
  const displays = screen.getAllDisplays()
  const display =
    displays.find((d) => d.id === data.settings.displayId) || screen.getPrimaryDisplay()
  const cells = computeCells(display, rows, cols)

  if (data.settings.proxyMode !== 'none' && activeProxies().length === 0) {
    log('Nenhuma proxy ativa cadastrada — as telas vão abrir sem proxy')
  }

  const delaySec = Math.min(Math.max(Math.round(Number(opts.delaySec) || 0), 1), 3600)
  const useDelay = Boolean(opts.delayPerLink) && data.settings.assistant
  const runId = ++startRunId

  if (links.length > 1) {
    log(`Múltiplos Links ativo: ${cells.length} tela(s) divididas entre ${links.length} link(s)`)
    links.forEach((link, li) => {
      const count = cells.filter((_, i) => linkForScreen(i, cells.length, links) === link).length
      log(`  Link ${li + 1}: ${count} tela(s) — ${link}`)
    })
  } else {
    log(`Abrindo ${cells.length} tela(s) em ${parsed.href}`)
  }
  log(`Navegador: ${chromePath}`)
  if (data.settings.adblock) {
    // Have the filter lists ready before the first screen loads, so blocking is active from its first request.
    await Promise.race([getBlocker().catch(() => null), sleep(15000)])
  }
  fillQueue = Promise.resolve()
  fillDelay = { on: useDelay, sec: delaySec }
  depositRange = { min: Number(opts.depositMin) || 0, max: Number(opts.depositMax) || 0 }
  if (useDelay) log(`Delay por Link ativo: as telas abrem agora e cada conta é criada ${delaySec}s depois da anterior`)
  for (let i = 0; i < cells.length; i++) {
    if (runId !== startRunId) break
    try {
      await createScreen(i, cells[i], linkForScreen(i, cells.length, links), chromePath)
    } catch (err) {
      log(`Tela ${i + 1}: não foi possível abrir o Chrome (${err.message})`)
    }
    if (i < cells.length - 1) await new Promise((r) => setTimeout(r, OPEN_DELAY_MS))
  }
  return [...screens.values()].filter((s) => !s.fromAccount).length
}
let startRunId = 0

// Reopens a saved account in its own screen, on the same proxy it was created with. Independent of the main Play button.
async function openAccountScreen(id) {
  if (!license.isActive()) {
    log('Acesso bloqueado: key vencida ou sessão inválida')
    return false
  }
  const acc = accounts.find((a) => a.id === id)
  if (!acc) return false
  if ([...screens.values()].some((s) => s.accountId === id)) return true
  const parsed = parseHttpUrl(acc.url) || (acc.casa ? parseHttpUrl(`https://${acc.casa}`) : null)
  if (!parsed) {
    log('Esta conta não tem link salvo para reabrir')
    return false
  }
  const chromePath = findChrome()
  if (!chromePath) {
    log('Google Chrome não encontrado')
    return false
  }
  let number = 101
  while (screens.has(number)) number++
  const rows = 1
  const display = screen.getAllDisplays().find((d) => d.id === data.settings.displayId) || screen.getPrimaryDisplay()
  const cell = computeCells(display, rows, 3)[0]
  const saved = acc.proxyData && acc.proxyData.host ? acc.proxyData : null
  const found = saved ? data.proxies.find((p) => p.id === saved.id) : null
  const pinnedProxy = found || saved || null
  log(`Reabrindo a conta ${acc.user} (${acc.casa || parsed.host})${pinnedProxy ? ` com a proxy ${proxyLabel(pinnedProxy)}` : ' sem proxy'}`)
  if (!acc.proxySession) {
    acc.proxySession = randomBytes(6).toString('hex')
    saveAccounts()
  }
  await createScreen(0, cell, parsed.href, chromePath, {
    number,
    fromAccount: true,
    accountId: id,
    pinnedProxy,
    sessionId: acc.proxySession,
  })
  notifyAccountsRunning()
  return true
}

function openAccountIds() {
  return [...screens.values()].filter((s) => s.accountId).map((s) => s.accountId)
}

function notifyAccountsRunning() {
  controlWin?.webContents.send('accounts:running', openAccountIds())
}

async function rotateProxy(number) {
  const state = screens.get(number)
  if (!state) return
  const list = activeProxies()
  if (list.length === 0) {
    log(`Tela ${number}: nenhuma proxy ativa para trocar`)
    return
  }
  const currentIndex = state.proxy ? list.findIndex((p) => p.id === state.proxy.id) : -1
  state.proxy = list[(currentIndex + 1) % list.length]
  log(`Tela ${number}: proxy trocada para ${state.proxy.host}:${state.proxy.port}`)
  await refreshConnection(state)
}

function parseTargets(text) {
  const wanted = new Set()
  for (const part of String(text || '').split(/[,;\s]+/).filter(Boolean)) {
    const [a, b] = part.split('-').map((n) => parseInt(n, 10))
    if (Number.isNaN(a)) continue
    const last = b === undefined || Number.isNaN(b) ? a : b
    for (let n = Math.min(a, last); n <= Math.max(a, last); n++) wanted.add(n)
  }
  return wanted
}

function randomPin() {
  for (;;) {
    const digits = Array.from({ length: 6 }, () => randomInt(10))
    const pin = digits.join('')
    const steps = digits.slice(1).map((d, i) => d - digits[i])
    if (new Set(digits).size < 3 || /(\d)\1\1/.test(pin)) continue
    if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) continue
    return pin
  }
}

// The withdrawal password is saved in Contas (column "Senha saque") before anything is typed, so it is never lost.
function pixAccount(state, host) {
  let acc = accounts.find((a) => a.id === state.accountId)
  if (!acc) {
    acc = {
      id: randomUUID(),
      createdAt: Date.now(),
      casa: host,
      url: '',
      user: '',
      pass: '',
      name: '',
      phone: '',
      saque: '',
      siteId: '',
      proxy: effectiveProxy(state) ? proxyLabel(effectiveProxy(state)) : '',
      proxyData: effectiveProxy(state) ? { ...effectiveProxy(state) } : null,
      proxySession: state.sessionId,
      screen: state.number,
    }
    accounts.unshift(acc)
    state.accountId = acc.id
    saveAccounts()
    notifyAccountsRunning()
    setTimeout(() => snapshotSession(state), 4000)
  }
  if (!/^\d{6}$/.test(acc.saque || '')) {
    acc.saque = randomPin()
    saveAccounts()
  }
  return acc
}

function siteKey(value) {
  const raw = String(value || '').trim().toLowerCase()
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).host.replace(/^www\./, '')
  } catch {
    return raw.replace(/^www\./, '')
  }
}

// A key is never repeated on the same site. With "Mesmas chaves para links diferentes" off it is never repeated at all.
function pickPixKey(acc, host, type) {
  const keys = (data.settings.pixData?.keys || []).filter((k) => k.type === type && k.value)
  if (acc.pix && keys.some((k) => k.value === acc.pix)) return acc.pix
  const sameAcrossSites = Boolean(data.settings.pixSameKey)
  const site = siteKey(host)
  const used = accounts.filter((a) => a !== acc && a.pix)
  const free = keys.find(
    (k) => !used.some((a) => a.pix === k.value && (!sameAcrossSites || siteKey(a.casa) === site)),
  )
  return free ? free.value : null
}

const randomDigits = (n) => Array.from({ length: n }, (_, i) => (i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10))).join('')

async function setupPix(state, opts = {}) {
  if (state.pixBusy) return
  const n = state.number
  const pages = await state.browser.pages().catch(() => [])
  const page =
    state.activePage && !state.activePage.isClosed() ? state.activePage : pages.find((p) => /^https?:/.test(p.url()))
  if (!page) {
    log(`Tela ${n}: nenhuma página aberta para cadastrar a chave PIX`)
    return
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const step = (name, pin, extra) => page.evaluate(pixStep, name, pin, extra ?? null).catch(() => 'error')
  const closeAll = (ms) => page.evaluate((t) => window.__ravokCloseAll?.(t), ms).catch(() => 0)
  state.pixBusy = true
  let acc = null
  let previousPix = ''
  let pixKey = null
  try {
    let host = ''
    try {
      host = new URL(page.url()).host.replace(/^www\./, '')
    } catch {}
    acc = pixAccount(state, host)
    const pin = acc.saque
    const pixType = opts.pixType || 'CPF'
    const autoKey = Boolean(data.settings.pixData?.enabled)
    if (autoKey && acc.pix && (acc.pixType || pixType) === pixType) {
      log(`Tela ${n}: esta conta já tem a chave ${pixType} ${acc.pix} cadastrada em ${host || 'este site'}, não vou cadastrar de novo`)
      return
    }
    if (autoKey) {
      previousPix = acc.pix || ''
      pixKey = pickPixKey(acc, host, pixType)
      if (pixKey) {
        acc.pix = pixKey
        acc.pixType = pixType
      } else {
        log(`Tela ${n}: nenhuma chave ${pixType} livre para ${host || 'este site'} em Preencher Dados, vou parar no modal`)
      }
    }
    log(`Tela ${n}: cadastrando chave PIX, senha de saque ${pin} salva em Contas`)
    await closeAll(8000)

    // Profile > Saques, retrying once from the home page when the site lands somewhere else.
    const reachWithdraw = async () => {
      let result = await step('profile')
      if (result === 'error') {
        await wait(2500)
        result = await step('profile')
      }
      return result
    }
    // Only this screen goes back to the home page, and only when neither Perfil nor Saques could be found.
    const openWithdraw = async () => {
      const reached = await reachWithdraw()
      if (reached !== 'ok') return reached
      const opened = await step('withdraw')
      return opened === 'ok' ? 'ok' : opened === 'messages' ? 'messages' : 'nowithdraw'
    }
    let profile = await openWithdraw()
    if (profile !== 'ok') {
      log(`Tela ${n}: não achei Perfil nem Saques, voltando ao início desta tela e tentando de novo`)
      await goHome(state, true)
      profile = await openWithdraw()
    }
    if (profile !== 'ok') {
      log(`Tela ${n}: ${profile === 'noprofile' ? 'botão Perfil não encontrado' : 'botão Saque não encontrado no perfil'}, finalize você`)
      return
    }
    await wait(1500)

    let password = await step('password', pin)
    if (password === 'missing' || password === 'error') {
      await closeAll(5000)
      password = await step('password', pin)
    }
    if (password === 'missing' || password === 'error') {
      // Reload only as a last resort, when the password screen never showed up.
      await page.reload({ waitUntil: 'load', timeout: 30000 }).catch(() => {})
      await wait(2500)
      await closeAll(5000)
      password = await step('password', pin)
    }
    if (password === 'set') log(`Tela ${n}: senha de saque ${pin} cadastrada`)
    else if (password === 'already') log(`Tela ${n}: a senha de saque já estava cadastrada, seguindo`)
    else if (password === 'stuck') log(`Tela ${n}: digitei a senha ${pin} mas a tela não avançou, confira`)
    else {
      log(`Tela ${n}: tela de senha de saque não apareceu, finalize você (senha ${pin})`)
      return
    }

    await wait(1200)
    let account = await step('account', pin)
    if (account === 'error') {
      await wait(2500)
      account = await step('account', pin)
    }
    if (account === 'noadd') {
      log(`Tela ${n}: botão Adicionar Conta para Saque não encontrado, finalize você`)
      return
    }
    if (account !== 'ok') {
      log(`Tela ${n}: botão Adicionar do PIX não encontrado, finalize você`)
      return
    }
    if (!pixKey) {
      log(`Tela ${n}: modal Adicionar PIX aberto, preencha a chave`)
      return
    }

    await wait(1000)
    const holder = acc.name || data.settings.pixData?.name || ''
    let added = await step('pixkey', pin, { type: pixType, key: pixKey, filler: randomDigits(12), holder })
    if (added === 'error') {
      await wait(2000)
      added = await step('pixkey', pin, { type: pixType, key: pixKey, filler: randomDigits(12), holder })
    }
    if (added === 'added') {
      log(`Tela ${n}: chave ${pixType} ${pixKey} cadastrada`)
      pixKey = null
    } else if (added === 'notype') log(`Tela ${n}: não consegui mudar o tipo para ${pixType}, finalize você`)
    else if (added === 'noconfirm') log(`Tela ${n}: chave preenchida mas o botão Adicionar não foi encontrado, confira`)
    else log(`Tela ${n}: campo da chave PIX não encontrado, finalize você`)
  } catch (err) {
    log(`Tela ${n}: erro ao cadastrar a chave PIX (${err.message})`)
  } finally {
    // The key stays reserved only when it was actually added.
    if (acc && pixKey) acc.pix = previousPix
    if (acc) saveAccounts()
    state.pixBusy = false
  }
}

async function activePageOf(state) {
  if (state.activePage && !state.activePage.isClosed()) return state.activePage
  const pages = await state.browser.pages().catch(() => [])
  return pages.find((p) => /^https?:/.test(p.url())) || null
}

// Goes back to the original link the screen was opened with and dismisses popups.
async function goHome(state, quiet = false) {
  const page = await activePageOf(state)
  if (!page) return
  if (!quiet) log(`Tela ${state.number}: voltando para a página inicial`)
  await page.goto(state.homeUrl, { waitUntil: 'load', timeout: 30000 }).catch(() => {})
  await new Promise((r) => setTimeout(r, 2000))
  await page.evaluate((t) => window.__ravokCloseAll?.(t), 6000).catch(() => 0)
}

function siteOriginOf(state, page) {
  for (const candidate of [state.homeUrl, page?.url()]) {
    try {
      const u = new URL(candidate)
      if (/^https?:$/.test(u.protocol)) return u.origin
    } catch {}
  }
  return ''
}

// Opens a path of the casino site (e.g. /home/report?reportCurrent=1) on the screen.
async function goPath(state, path, label) {
  const page = await activePageOf(state)
  if (!page) {
    log(`Tela ${state.number}: nenhuma página aberta para ir em ${label}`)
    return null
  }
  const origin = siteOriginOf(state, page)
  if (!origin) {
    log(`Tela ${state.number}: não consegui descobrir o endereço do site para ir em ${label}`)
    return null
  }
  const url = origin + path
  log(`Tela ${state.number}: abrindo ${label} (${url})`)
  state.activePage = page
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => {
    log(`Tela ${state.number}: falha ao abrir ${label}: ${e?.message || e}`)
  })
  return page
}

function markSlotSearchInput() {
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
  }
  const skip = ['hidden', 'checkbox', 'radio', 'password', 'submit', 'button', 'number', 'tel', 'email', 'file']
  const inputs = [...document.querySelectorAll('input')].filter(
    (i) => !skip.includes((i.type || '').toLowerCase()) && !i.disabled && !i.readOnly && visible(i),
  )
  const score = (i) => {
    const text = `${i.type} ${i.placeholder} ${i.name} ${i.id} ${i.className} ${i.getAttribute('aria-label') || ''}`.toLowerCase()
    return /search|pesquis|busca|procur|jogo|game|slot/.test(text) ? 2 : 1
  }
  inputs.sort((a, b) => score(b) - score(a))
  document.querySelectorAll('[data-ravok-slot]').forEach((e) => e.removeAttribute('data-ravok-slot'))
  const el = inputs[0]
  if (!el) return false
  el.setAttribute('data-ravok-slot', '1')
  el.scrollIntoView({ block: 'center' })
  return true
}

function pressSlotSearchButton() {
  const input = document.querySelector('[data-ravok-slot]')
  if (!input) return false
  let box = input.parentElement
  for (let depth = 0; box && depth < 3; depth++, box = box.parentElement) {
    const btn = [...box.querySelectorAll('button, [role="button"], i, span, img, svg')].find((el) => {
      if (el === input || el.contains(input)) return false
      const text = `${el.textContent || ''} ${el.className?.baseVal ?? el.className ?? ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('src') || ''}`.toLowerCase()
      return /search|pesquis|buscar|procur|lupa/.test(text)
    })
    if (btn) {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      return true
    }
  }
  return false
}

async function searchSlot(state, query) {
  const n = state.number
  const page = await goPath(state, '/home/subgame?gameCategoryId=0&platformId=0999', `a busca de slot "${query}"`)
  if (!page) return
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  let found = false
  for (let i = 0; i < 30 && !found; i++) {
    await wait(500)
    found = await page.evaluate(markSlotSearchInput).catch(() => false)
  }
  if (!found) {
    log(`Tela ${n}: campo de pesquisa de slot não encontrado na página`)
    return
  }
  const selector = '[data-ravok-slot]'
  try {
    await page.focus(selector)
    await page.evaluate((sel) => {
      const el = document.querySelector(sel)
      el?.select?.()
    }, selector)
    await page.keyboard.press('Backspace')
    await page.keyboard.type(query, { delay: 40 })
    await wait(300)
    await page.keyboard.press('Enter')
    await wait(400)
    const clicked = await page.evaluate(pressSlotSearchButton).catch(() => false)
    log(`Tela ${n}: slot "${query}" pesquisado${clicked ? ' (botão de busca acionado)' : ''}`)
  } catch (e) {
    log(`Tela ${n}: erro ao digitar o slot: ${e?.message || e}`)
  }
}

async function withdrawAll(state) {
  if (state.pixBusy) return
  const n = state.number
  const page = await activePageOf(state)
  if (!page) {
    log(`Tela ${n}: nenhuma página aberta para sacar`)
    return
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const step = (name, pin) => page.evaluate(pixStep, name, pin, null).catch(() => 'error')
  state.pixBusy = true
  try {
    let host = ''
    try {
      host = new URL(page.url()).host.replace(/^www\./, '')
    } catch {}
    const acc = pixAccount(state, host)
    const pin = acc.saque
    log(`Tela ${n}: iniciando saque total`)
    await page.evaluate((t) => window.__ravokCloseAll?.(t), 8000).catch(() => 0)
    const reach = async () => {
      let r = await step('profile')
      if (r === 'error') {
        await wait(2500)
        r = await step('profile')
      }
      return r
    }
    let profile = await reach()
    if (profile !== 'ok') {
      log(`Tela ${n}: página errada ou botão não encontrado, voltando ao início e tentando de novo`)
      await goHome(state, true)
      profile = await reach()
    }
    if (profile !== 'ok') {
      log(`Tela ${n}: não consegui chegar em Saques, finalize você`)
      return
    }
    const attempt = async () => {
      const opened = await step('withdraw')
      if (opened === 'messages') return 'messages'
      if (opened !== 'ok') return 'noall'
      await wait(2000)
      let r = await step('withdrawall', pin)
      if (r === 'error') {
        await wait(2000)
        r = await step('withdrawall', pin)
      }
      return r
    }
    let result = await attempt()
    for (let retry = 0; retry < 3 && ['noall', 'nopin', 'error', 'messages'].includes(result); retry++) {
      log(`Tela ${n}: não achei a tela de saque, voltando ao início e indo em Perfil > Saques de novo`)
      await goHome(state, true)
      await page.evaluate((t) => window.__ravokCloseAll?.(t), 6000).catch(() => 0)
      if ((await reach()) !== 'ok') continue
      result = await attempt()
    }
    const msgs = {
      done: 'saque total confirmado',
      noall: 'botão Tudo não encontrado, finalize você',
      nopin: 'campo da senha de saque não encontrado, finalize você',
      noconfirm: 'botão Confirmar saque indisponível (saldo abaixo do mínimo?)',
    }
    log(`Tela ${n}: ${msgs[result] || 'não consegui concluir o saque, finalize você'}`)
    if (result === 'done') {
      // Going straight to the records URL: tapping the scrollable tab row used to land on the neighbouring "Juros" tab.
      await wait(3000)
      const opened = await goPath(state, '/home/withdraw?active=3', 'Registro de Saques')
      log(`Tela ${n}: ${opened ? 'registro de saques aberto' : 'não consegui abrir o registro de saques'}`)
    }
  } catch (err) {
    log(`Tela ${n}: erro ao sacar (${err.message})`)
  } finally {
    state.pixBusy = false
  }
}

async function reloadAll(targets) {
  const wanted = parseTargets(targets)
  const list = [...screens.values()].filter((s) => inTargets(wanted, s))
  await Promise.all(
    list.map(async (s) => {
      const pages = await s.browser.pages().catch(() => [])
      await Promise.all(pages.map((p) => p.reload().catch(() => {})))
    }),
  )
  return list.length
}

async function applyProxySettingsChange(previous) {
  const wasOn = previous.proxyMode !== 'none' && previous.hadProxies
  const isOn = proxyEnabled()
  const list = activeProxies()
  let changed = wasOn !== isOn
  for (const state of screens.values()) {
    if (state.fromAccount) continue
    if (state.proxy && !list.some((p) => p.id === state.proxy.id)) {
      // With every proxy off the screen keeps its proxy, so turning it back on reuses the same IP.
      if (list.length) {
        state.proxy = list[(state.number - 1) % list.length]
        changed = true
      }
    } else if (!state.proxy && list.length) {
      state.proxy = list[(state.number - 1) % list.length]
      changed = changed || isOn
    }
  }
  if (!changed || screens.size === 0) return
  log(`Proxy ${isOn ? 'ativada' : 'desativada'} em ${screens.size} tela(s)`)
  await Promise.all([...screens.values()].map((s) => refreshConnection(s)))
}

function updateHotkey() {
  for (const key of ['F2', 'F8']) {
    const registered = globalShortcut.isRegistered(key)
    if (screens.size > 0 && !registered) {
      globalShortcut.register(key, () => controlWin?.webContents.send('hotkey', key))
    } else if (screens.size === 0 && registered) {
      globalShortcut.unregister(key)
    }
  }
}

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 1080,
    height: 700,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    icon: path.join(__dirname, 'renderer', 'logo.png'),
    frame: false,
    backgroundColor: '#f4f7fb',
    autoHideMenuBar: true,
    alwaysOnTop: data.settings.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  })
  controlWin.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  controlWin.on('closed', async () => {
    controlWin = null
    await closeAllScreens()
    app.quit()
  })
}

ipcMain.on('window:control', (_e, action) => {
  if (!controlWin) return
  if (action === 'minimize') controlWin.minimize()
  else if (action === 'maximize') {
    if (controlWin.isMaximized()) controlWin.unmaximize()
    else controlWin.maximize()
  } else if (action === 'close') controlWin.close()
  else if (action === 'compact') setCompact(true)
  else if (action === 'expand') setCompact(false)
  else if (action === 'pin') setCompactPinned(true)
  else if (action === 'unpin') setCompactPinned(false)
})

const COMPACT_SIZE = { width: 1060, height: 208 }
let compactRestore = null
let compactLastBounds = null
let compactPinned = false

function setCompactPinned(pinned) {
  if (!controlWin || !compactRestore) return
  compactPinned = pinned
  controlWin.setMovable(!pinned)
  controlWin.webContents.send('window:compact-pin', pinned)
}

function setCompact(on) {
  if (!controlWin || on === Boolean(compactRestore)) return
  if (on) {
    const wasMaximized = controlWin.isMaximized()
    if (wasMaximized) controlWin.unmaximize()
    compactRestore = { bounds: controlWin.getBounds(), wasMaximized }
    const area = screen.getDisplayMatching(compactRestore.bounds).workArea
    const width = Math.min(COMPACT_SIZE.width, area.width)
    controlWin.setMinimumSize(640, COMPACT_SIZE.height)
    const fallback = {
      x: Math.round(area.x + (area.width - width) / 2),
      y: area.y + 8,
      width,
      height: COMPACT_SIZE.height,
    }
    const last = compactLastBounds
    const lastVisible =
      last && screen.getAllDisplays().some(({ workArea: a }) =>
        last.x + 40 < a.x + a.width && last.x + last.width - 40 > a.x && last.y >= a.y - 4 && last.y < a.y + a.height - 40,
      )
    controlWin.setBounds(lastVisible ? { ...last, height: COMPACT_SIZE.height } : fallback)
    controlWin.setAlwaysOnTop(true, 'screen-saver')
    controlWin.setMovable(!compactPinned)
  } else {
    compactLastBounds = controlWin.getBounds()
    const { bounds, wasMaximized } = compactRestore
    compactRestore = null
    controlWin.setMovable(true)
    controlWin.setAlwaysOnTop(Boolean(data.settings.alwaysOnTop))
    controlWin.setMinimumSize(900, 600)
    controlWin.setBounds(bounds)
    if (wasMaximized) controlWin.maximize()
  }
  controlWin.webContents.send('window:compact', on)
  if (on) controlWin.webContents.send('window:compact-pin', compactPinned)
}

ipcMain.handle('data:get', () => data)
ipcMain.handle('data:save', async (_e, next) => {
  const previous = {
    proxyMode: data.settings.proxyMode,
    hadProxies: activeProxies().length > 0,
  }
  data = {
    proxies: Array.isArray(next.proxies) ? next.proxies : data.proxies,
    settings: { ...data.settings, ...(next.settings || {}) },
  }
  saveData()
  controlWin?.setAlwaysOnTop(Boolean(data.settings.alwaysOnTop))
  if (previous.proxyMode !== data.settings.proxyMode) {
    for (const s of screens.values()) delete s.proxyOverride
  }
  applyProxySettingsChange(previous).catch((err) => log(`Erro ao aplicar proxy: ${err.message}`))
  return true
})
ipcMain.handle('app:version', () => app.getVersion())
ipcMain.handle('app:openStore', () => shell.openExternal('https://bot.ravok.shop/#loja'))
ipcMain.handle('accounts:list', () => accounts)
ipcMain.handle('accounts:save', (_e, next) => {
  if (!Array.isArray(next)) return false
  const byId = new Map(accounts.map((a) => [a.id, a]))
  accounts = next
    .filter((a) => a && byId.has(a.id))
    .map((a) => ({
      ...byId.get(a.id),
      user: String(a.user ?? '').slice(0, 40),
      pass: String(a.pass ?? '').slice(0, 40),
      saque: String(a.saque ?? '').slice(0, 40),
        siteId: String(a.siteId ?? '').slice(0, 40),
        pinned: a.pinned === true,
      }))
  saveAccounts()
  return true
})
ipcMain.handle('accounts:backup', async () => {
  const stamp = new Date().toISOString().slice(0, 10)
  const { canceled, filePath } = await dialog.showSaveDialog(controlWin, {
    title: 'Salvar backup das contas',
    defaultPath: `contas-backup-${stamp}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (canceled || !filePath) return false
  await fs.promises.writeFile(filePath, JSON.stringify(accounts, null, 2))
  log(`Backup de ${accounts.length} conta(s) salvo em ${filePath}`)
  return true
})
ipcMain.handle('displays:list', () =>
  screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label || `Monitor ${i + 1}`,
    primary: d.id === screen.getPrimaryDisplay().id,
    width: d.size.width,
    height: d.size.height,
  })),
)
const licenseCall = (fn) => async (_e, payload) => {
  try {
    return { ok: true, state: await fn(payload && typeof payload === 'object' ? payload : {}) }
  } catch (err) {
    return { ok: false, error: err.message, code: err.code, state: license.state() }
  }
}
const str = (v, max) => String(v ?? '').slice(0, max)

ipcMain.handle('license:state', () => license.state())
ipcMain.handle('license:refresh', licenseCall(() => license.refresh()))
ipcMain.handle(
  'license:login',
  licenseCall((p) => license.login({ email: str(p.email, 254), password: str(p.password, 72), remember: Boolean(p.remember) })),
)
ipcMain.handle(
  'license:register',
  licenseCall((p) =>
    license.register({ email: str(p.email, 254), password: str(p.password, 72), phone: str(p.phone, 20), key: str(p.key, 40) }),
  ),
)
ipcMain.handle(
  'license:logout',
  licenseCall(async () => {
    startRunId++
    await closeAllScreens().catch(() => {})
    return license.logout()
  }),
)
ipcMain.handle('license:redeem', licenseCall((p) => license.redeem(str(p.key, 40))))
ipcMain.handle(
  'license:support',
  licenseCall(async () => {
    const url = await license.supportUrl()
    license.audit('suporte', 'Abriu o suporte')
    await shell.openExternal(url)
    return license.state()
  }),
)
ipcMain.handle('license:audit', (_e, action, details) => {
  if (/^[a-z0-9_.:-]{1,64}$/i.test(String(action || ''))) license.audit(String(action), str(details, 1000))
})

const requireLicense = (fn) => (...args) => {
  if (!license.isActive()) {
    log('Acesso bloqueado: key vencida ou sessão inválida')
    return false
  }
  return fn(...args)
}

ipcMain.handle(
  'screens:start',
  requireLicense((_e, url, opts) => startScreens(url, opts && typeof opts === 'object' ? opts : {})),
)
ipcMain.handle('screens:closeAll', async () => {
  startRunId++
  await closeAllScreens(false)
  log('Todas as telas foram fechadas')
})
ipcMain.handle('control:set', async (_e, next = {}) => {
  const mirror = Boolean(next.mirror)
  const speed = Math.min(Math.max(Number(next.speed) || 1, 1), 10)
  const targetsText = String(next.targets || '')
  const targets = parseTargets(targetsText)
  const targetsChanged =
    targets.size !== control.targets.size || [...targets].some((n) => !control.targets.has(n))
  const scope = targets.size ? `telas ${targetsText}` : 'todas as telas'
  if (mirror !== control.mirror) log(`Modo Espelho ${mirror ? 'ativado' : 'desativado'} (${scope})`)
  if (speed !== control.speed) log(`Speed Hack em ${speed}x (${scope})`)
  else if (targetsChanged) log(`Janelas controladas: ${scope}`)
  const speedChanged = speed !== control.speed || targetsChanged
  control.mirror = mirror
  control.speed = speed
  control.targets = targets
  if (speedChanged) await applySpeedAll()
  return true
})
ipcMain.handle('bot:toggleScoped', (_e, targets) => {
  const wanted = parseTargets(targets)
  const list = [...screens.values()].filter((s) => inTargets(wanted, s))
  if (!list.length) return { count: 0, off: false }
  const off = list.some((s) => !s.botOff)
  for (const s of list) s.botOff = off
  log(`Bot ${off ? 'desativado' : 'ativado'} nas telas ${list.map((s) => s.number).join(', ')}`)
  return { count: list.length, off }
})
ipcMain.handle('audio:toggleMute', async () => {
  screensMuted = !screensMuted
  await applyMuteAll()
  log(screensMuted ? 'Som desativado em todas as telas' : 'Som reativado em todas as telas')
  return { muted: screensMuted }
})
ipcMain.handle('audio:state', () => ({ muted: screensMuted }))
ipcMain.handle('bot:state', (_e, targets) => {
  const wanted = parseTargets(targets)
  const list = [...screens.values()].filter((s) => inTargets(wanted, s))
  return { count: list.length, off: list.length > 0 && list.every((s) => s.botOff) }
})
ipcMain.handle('proxy:toggleScoped', async (_e, targets) => {
  const wanted = parseTargets(targets)
  const list = [...screens.values()].filter((s) => !s.pinned && inTargets(wanted, s))
  if (!list.length) return 0
  const enable = !effectiveProxy(list[0])
  const proxies = activeProxies()
  if (enable && !proxies.length) {
    log('Nenhuma proxy ativa cadastrada')
    return 0
  }
  for (const s of screens.values()) {
    if (!s.pinned && !list.includes(s) && s.proxyOverride === undefined) s.proxyOverride = Boolean(effectiveProxy(s))
  }
  for (const s of list) {
    s.proxyOverride = enable
    if (enable && (!s.proxy || !proxies.some((p) => p.id === s.proxy.id))) s.proxy = proxies[(s.number - 1) % proxies.length]
  }
  log(`Proxy ${enable ? 'ativada' : 'desativada'} só nas telas ${list.map((s) => s.number).join(', ')}`)
  await Promise.all(list.map((s) => refreshConnection(s)))
  return list.length
})
ipcMain.handle('log:open', async () => {
  const file = logFilePath()
  await fs.promises.mkdir(path.dirname(file), { recursive: true }).catch(() => {})
  if (!fs.existsSync(file)) await fs.promises.writeFile(file, '').catch(() => {})
  const error = await shell.openPath(file)
  if (error) shell.showItemInFolder(file)
  return file
})
ipcMain.handle('screens:list', () => screensSnapshot())
ipcMain.handle('screens:reloadAll', (_e, targets) => reloadAll(targets))
ipcMain.handle(
  'pix:setup',
  requireLicense((_e, targets, opts) => {
    const wanted = parseTargets(targets)
    const list = [...screens.values()].filter((s) => inTargets(wanted, s))
    const pixType = ['CPF', 'Telefone', 'E-mail', 'Chave aleatória'].includes(opts?.pixType) ? opts.pixType : 'CPF'
    for (const s of list) setupPix(s, { pixType })
    return list.length
  }),
)
ipcMain.handle(
  'pix:withdraw',
  requireLicense((_e, targets) => {
    const wanted = parseTargets(targets)
    const list = [...screens.values()].filter((s) => inTargets(wanted, s))
    for (const s of list) withdrawAll(s)
    return list.length
  }),
)
ipcMain.handle('screens:home', async (_e, targets) => {
  const wanted = parseTargets(targets)
  const list = [...screens.values()].filter((s) => inTargets(wanted, s))
  await Promise.all(list.map((s) => goHome(s)))
  return list.length
})
const SITE_PAGES = {
  report: { path: '/home/report?reportCurrent=1', label: 'Relatório de Apostas' },
  event: { path: '/home/event?eventCurrent=1', label: 'Página de Promoções' },
  sms: { path: '/home/security?active=0', label: 'Cadastrar SMS' },
}
ipcMain.handle('screens:goto', async (_e, targets, key) => {
  const target = SITE_PAGES[key]
  if (!target) return 0
  const wanted = parseTargets(targets)
  const list = [...screens.values()].filter((s) => inTargets(wanted, s))
  await Promise.all(list.map((s) => goPath(s, target.path, target.label)))
  return list.length
})
ipcMain.handle('screens:slot', async (_e, targets, query) => {
  const text = String(query || '').trim().slice(0, 80)
  if (!text) return 0
  const wanted = parseTargets(targets)
  const list = [...screens.values()].filter((s) => inTargets(wanted, s))
  list.forEach((s) => searchSlot(s, text))
  return list.length
})
ipcMain.handle('accounts:open', (_e, id) => openAccountScreen(String(id)))
ipcMain.handle('accounts:close', (_e, id) => closeAccountScreen(String(id)))
ipcMain.handle('accounts:running', () => openAccountIds())
ipcMain.handle('screen:rotate', (_e, number) => rotateProxy(number))
ipcMain.handle('screen:reload', async (_e, number) => {
  const state = screens.get(number)
  if (!state) return
  const pages = await state.browser.pages().catch(() => [])
  await Promise.all(pages.map((p) => p.reload().catch(() => {})))
})
ipcMain.handle('screen:focus', async (_e, number) => {
  const state = screens.get(number)
  if (!state) return
  const [page] = await state.browser.pages().catch(() => [])
  await page?.bringToFront().catch(() => {})
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (controlWin) {
      if (controlWin.isMinimized()) controlWin.restore()
      controlWin.focus()
    }
  })
  app.on('will-quit', () => globalShortcut.unregisterAll())
  app.on('before-quit', () => {
    license?.audit('app_fechado', 'Aplicativo fechado')
    license?.flush().catch(() => {})
  })
  app.whenReady().then(async () => {
    data = loadData()
    if (data.settings.session) {
      delete data.settings.session
      saveData()
    }
    license = createLicense({
      app,
      safeStorage,
      onChange: (state) => {
        setAccountsOwner(state.user?.email)
        controlWin?.webContents.send('license:update', state)
        if (!license.isActive() && screens.size) {
          startRunId++
          closeAllScreens().catch(() => {})
        }
      },
    })
    await license.init()
    license.audit('app_aberto', `Versão ${app.getVersion()}`)
    createControlWindow()
  })
}
