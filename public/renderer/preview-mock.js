// Only active in a plain browser (v0 preview). In Electron, the preload already defines window.api.
if (!window.api) {
  const store = {
    proxies: [],
    settings: {
      adblock: false,
      alwaysOnTop: false,
      proxyMode: 'none',
    proxyEscalate: false,
      fixedProxyId: null,
      rows: 2,
      cols: 3,
      displayId: null,
      url: '',
    },
  }
  window.api = {
    getData: async () => store,
    saveData: async () => {},
    listDisplays: async () => [{ id: 1, primary: true, width: 1920, height: 1080 }],
    listScreens: async () => [],
    startScreens: async () => {},
    closeAllScreens: async () => {},
    focusScreen: () => {},
    reloadScreen: () => {},
    rotateScreen: () => {},
    reloadAll: async () => 0,
    withdrawAll: async () => 0,
    goHome: async () => 0,
  gotoSitePage: async () => 0,
  searchSlot: async () => 0,
  openLog: async () => null,
    openAccount: async () => true,
    closeAccount: async () => true,
    listRunningAccounts: async () => [],
    onAccountsRunning: () => {},
    setControl: async () => {},
  toggleProxyScoped: async () => 0,
  toggleBotScoped: async () => ({ count: 0, off: false }),
  botState: async () => ({ count: 0, off: false }),
  toggleMute: async () => ({ muted: false }),
  muteState: async () => ({ muted: false }),
    onLog: () => {},
    onScreens: () => {},
    onHotkey: () => {},
    listAccounts: async () => [
      { id: 'a1', createdAt: Date.now() - 60000, casa: '832bet1.com', url: 'https://832bet1.com', user: 'lucasalv4821', pass: 'Kp7mQx2rTa', name: 'Lucas Alves', saque: '', siteId: '', proxy: 'Sem proxy' },
      { id: 'a2', createdAt: Date.now() - 3600000, casa: '832bet1.com', url: 'https://832bet1.com', user: 'beatrsouz93', pass: 'r8ZcV3nwE5h', name: '', saque: '', siteId: '', proxy: '177.47.202.200:8080' },
    ],
    saveAccounts: async () => true,
    backupAccounts: async () => false,
    onAccounts: () => {},
  }

  let licState = { loggedIn: false, active: false, user: null }
  const licListeners = []
  const ok = (state) => ({ ok: true, state })
  const makeUser = (email, plan, planLabel, days) => ({
    email,
    plan,
    planLabel,
    lifetime: plan === 'vitalicio',
    expiresAt: plan === 'vitalicio' ? null : Date.now() + days * 86400000,
    active: true,
  })
  window.api.license = {
    state: async () => licState,
    refresh: async () => ok(licState),
    login: async ({ email }) => {
      licState = { loggedIn: true, active: true, user: makeUser(email, 'teste', 'Teste', 1) }
      return ok(licState)
    },
    register: async ({ email }) => {
      licState = { loggedIn: true, active: true, user: makeUser(email, 'teste', 'Teste', 1) }
      return ok(licState)
    },
    logout: async () => {
      licState = { loggedIn: false, active: false, user: null }
      return ok(licState)
    },
    redeem: async () => {
      const email = licState.user?.email || 'preview@ravokbot.com'
      licState = { loggedIn: true, active: true, user: makeUser(email, 'mensal', 'Mensal', 30) }
      return ok(licState)
    },
    support: async () => {
      window.open('https://wa.me/', '_blank', 'noopener')
      return ok(licState)
    },
    audit: async () => {},
    onUpdate: (cb) => licListeners.push(cb),
  }
  window.previewExpire = () => {
    if (!licState.user) return
    licState = { ...licState, active: false, user: { ...licState.user, expiresAt: Date.now() - 1000, active: false } }
    licListeners.forEach((cb) => cb(licState))
  }
}
