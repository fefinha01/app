// Instalador proprio do RavokBot (uma unica copia do Electron, sem instalador do Windows por tras).
// Este programa usa o MESMO runtime do app: instalar = copiar o runtime + o app.asar real para a pasta
// escolhida, criar atalhos, registrar em "Aplicativos instalados" e abrir o RavokBot.
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
// 'original-fs' = fs do Electron SEM tratar .asar como pasta (essencial para copiar o app.asar como arquivo)
const ofs = require('original-fs')
const os = require('os')
const { spawn, execFile } = require('child_process')

app.setName('RavokBot Instalador')
// Nao usar a pasta de dados do RavokBot de verdade (%APPDATA%\RavokBot).
app.setPath('userData', path.join(os.tmpdir(), 'ravokbot-setup-data'))
if (process.platform === 'win32') app.setAppUserModelId('com.ravokbot.installer')

// UI simples: nao precisa subir o processo de GPU (abre mais rapido)
app.disableHardwareAcceleration()

if (!app.requestSingleInstanceLock()) app.quit()

const T0 = Date.now()
function log(msg) {
  try {
    fs.appendFileSync(path.join(os.tmpdir(), 'ravokbot-setup.log'), new Date().toISOString() + ' ' + msg + '\n')
  } catch {}
}
log('processo iniciado (uptime do processo: ' + Math.round(process.uptime() * 1000) + ' ms)')

const APP_EXE = 'RavokBot.exe'
const APP_FOLDER = 'RavokBot'
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\RavokBot'

let meta = { version: '1.0.0' }
try {
  meta = { ...meta, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'meta.json'), 'utf8')) }
} catch {}

const RUNTIME_DIR = path.dirname(process.execPath) // runtime do Electron (igual ao do app)
const PAYLOAD_DIR = path.join(process.resourcesPath || '', 'payload') // app.asar real do RavokBot

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
const ROAMING = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
const DEFAULT_DIR = path.join(LOCAL, 'Programs', APP_FOLDER)

let win = null
let installing = false
let cancelled = false

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data)
}

function normalizeDir(input) {
  let dir = String(input || '').trim().replace(/^"+|"+$/g, '')
  if (!dir) return DEFAULT_DIR
  dir = path.resolve(dir)
  if (path.basename(dir).toLowerCase() !== APP_FOLDER.toLowerCase()) dir = path.join(dir, APP_FOLDER)
  return dir
}

function validateDir(dir) {
  if (process.platform === 'win32' && !/^[a-zA-Z]:\\/.test(dir)) return 'Escolha uma pasta em uma unidade do computador (por exemplo C:\\).'
  if (path.dirname(dir) === dir) return 'Escolha uma pasta, não a raiz da unidade.'
  if (/[<>"|?*]/.test(dir.slice(2))) return 'O caminho contém caracteres inválidos.'
  const inside = path.resolve(dir).toLowerCase()
  if (inside.startsWith(path.resolve(RUNTIME_DIR).toLowerCase())) return 'Escolha uma pasta fora do instalador.'
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, '.ravok-write-test')
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
  } catch {
    return 'Não foi possível gravar nessa pasta. Escolha outro local.'
  }
  return null
}

// ---------- processos do RavokBot ja instalado (so os que estao na pasta de destino) ----------
function ps(command) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('')
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 20000 }, (err, out) => resolve(err ? '' : String(out)))
  })
}
const psPath = (dir) => dir.replace(/'/g, "''")
async function isRunning(dir) {
  const out = await ps(`(Get-Process -Name RavokBot -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${psPath(dir)}\\*' } | Measure-Object).Count`)
  return parseInt(out.trim(), 10) > 0
}
async function stopApp(dir) {
  await ps(`Get-Process -Name RavokBot -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${psPath(dir)}\\*' } | Stop-Process -Force`)
  await new Promise((r) => setTimeout(r, 700))
}

// Mesma limpeza da "instalacao limpa" de antes.
function wipeOldData() {
  const targets = [
    path.join(ROAMING, 'RavokBot'),
    path.join(ROAMING, 'ravokbot'),
    path.join(LOCAL, 'RavokBot'),
    path.join(LOCAL, 'ravokbot'),
    path.join(LOCAL, 'ravokbot-updater'),
    path.join(os.tmpdir(), 'RavokBot'),
  ]
  for (const target of targets) {
    try {
      fs.rmSync(target, { recursive: true, force: true })
    } catch {}
  }
}

// ---------- lista de arquivos a instalar ----------
function listFiles(root, base, skip) {
  const out = []
  const walk = (dir) => {
    for (const entry of ofs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full)
      if (skip && skip(rel)) continue
      if (entry.isDirectory()) walk(full)
      else out.push({ src: full, rel: path.join(base, rel), size: ofs.statSync(full).size })
    }
  }
  walk(root)
  return out
}

function buildFileList() {
  const norm = (p) => p.replace(/\\/g, '/').toLowerCase()
  const skip = (rel) => {
    const r = norm(rel)
    return r === 'resources/app.asar' || r.startsWith('resources/app.asar.unpacked') || r.startsWith('resources/payload') || r.endsWith('.log')
  }
  const files = listFiles(RUNTIME_DIR, '', skip)
  if (ofs.existsSync(PAYLOAD_DIR)) files.push(...listFiles(PAYLOAD_DIR, 'resources', null))
  return files
}

function copyWithProgress(src, dst, onBytes) {
  return new Promise((resolve, reject) => {
    const rs = ofs.createReadStream(src, { highWaterMark: 4 * 1024 * 1024 })
    const ws = ofs.createWriteStream(dst)
    rs.on('data', (chunk) => onBytes(chunk.length))
    rs.on('error', reject)
    ws.on('error', reject)
    ws.on('close', resolve)
    rs.pipe(ws)
  })
}

function reg(name, type, value) {
  return new Promise((resolve) => {
    execFile('reg.exe', ['add', UNINSTALL_KEY, '/v', name, '/t', type, '/d', String(value), '/f'], { windowsHide: true }, () => resolve())
  })
}

async function register(target, totalBytes) {
  const exe = path.join(target, APP_EXE)
  // desinstalador
  try {
    fs.copyFileSync(path.join(__dirname, 'assets', 'uninstall.ps1'), path.join(target, 'uninstall.ps1'))
  } catch {}
  const uninstallCmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${path.join(target, 'uninstall.ps1')}"`
  await reg('DisplayName', 'REG_SZ', 'RavokBot')
  await reg('DisplayVersion', 'REG_SZ', meta.version)
  await reg('Publisher', 'REG_SZ', 'RavokBot')
  await reg('InstallLocation', 'REG_SZ', target)
  await reg('DisplayIcon', 'REG_SZ', exe)
  await reg('UninstallString', 'REG_SZ', uninstallCmd)
  await reg('EstimatedSize', 'REG_DWORD', Math.round(totalBytes / 1024))
  await reg('NoModify', 'REG_DWORD', 1)
  await reg('NoRepair', 'REG_DWORD', 1)
  // atalhos
  const opts = { target: exe, cwd: target, icon: exe, iconIndex: 0, description: 'RavokBot', appUserModelId: 'com.ravokbot.app' }
  const desktop = path.join(os.homedir(), 'Desktop')
  const links = [path.join(app.getPath('desktop') || desktop, 'RavokBot.lnk'), path.join(ROAMING, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'RavokBot.lnk')]
  for (const link of links) {
    try {
      shell.writeShortcutLink(link, 'create', opts)
    } catch {}
  }
}

function stageText(pct) {
  if (pct < 8) return 'Preparando a instalação…'
  if (pct < 92) return 'Copiando os arquivos do RavokBot…'
  if (pct < 98) return 'Criando atalhos…'
  return 'Finalizando…'
}

async function runInstall({ dir, clean }) {
  if (installing) return { ok: false, error: 'Instalação já em andamento.' }
  if (!app.isPackaged) return { ok: false, error: 'O instalador só funciona no arquivo gerado pelo build.' }
  const target = normalizeDir(dir)
  const problem = validateDir(target)
  if (problem) return { ok: false, error: problem }

  installing = true
  cancelled = false
  let shown = 1
  const push = (pct, text) => {
    shown = Math.max(shown, Math.min(100, pct))
    send('progress', { pct: shown, text: text || stageText(shown) })
  }

  const fail = (error) => {
    installing = false
    send('done', cancelled ? { ok: false, cancelled: true } : { ok: false, error })
  }

  try {
    push(2, 'Preparando a instalação…')
    await stopApp(target)
    if (clean) wipeOldData()
    // instalacao antiga do proprio RavokBot nessa pasta: limpa para nao sobrar arquivo velho
    if (ofs.existsSync(path.join(target, APP_EXE))) {
      try {
        ofs.rmSync(target, { recursive: true, force: true })
        ofs.mkdirSync(target, { recursive: true })
      } catch {
        return fail('Não foi possível substituir a instalação antiga. Feche o RavokBot e tente de novo.')
      }
    }
    push(4)

    const files = buildFileList()
    const total = files.reduce((sum, f) => sum + f.size, 0) || 1
    let done = 0
    let lastSent = 0
    for (const file of files) {
      if (cancelled) return fail()
      const dst = path.join(target, file.rel)
      ofs.mkdirSync(path.dirname(dst), { recursive: true })
      await copyWithProgress(file.src, dst, (n) => {
        done += n
        const now = Date.now()
        if (now - lastSent > 120) {
          lastSent = now
          push(5 + 87 * (done / total))
        }
      })
    }
    if (cancelled) return fail()

    // o runtime copiado pode ter outro nome de exe; o app precisa se chamar RavokBot.exe
    const copiedExe = path.join(target, path.basename(process.execPath))
    const finalExe = path.join(target, APP_EXE)
    if (path.basename(process.execPath).toLowerCase() !== APP_EXE.toLowerCase() && ofs.existsSync(copiedExe)) ofs.renameSync(copiedExe, finalExe)
    if (!ofs.existsSync(finalExe) || !ofs.existsSync(path.join(target, 'resources', 'app.asar'))) {
      return fail('Arquivos do instalador incompletos. Baixe o instalador novamente.')
    }

    push(94, 'Criando atalhos…')
    await register(target, total)
    push(100, 'Instalação concluída!')
    installing = false
    send('done', { ok: true, dir: target })
  } catch (err) {
    fail('Falha durante a instalação: ' + (err && err.message ? err.message : err))
  }
  return { ok: true }
}

function createWindow() {
  win = new BrowserWindow({
    width: 880,
    height: 580,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#00000000',
    title: 'RavokBot Instalador',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.setMenu(null)
  win.once('ready-to-show', () => {
    win.show()
    log('janela visivel apos ' + (Date.now() - T0) + ' ms do inicio do codigo')
  })
  win.loadFile(path.join(__dirname, 'index.html'))
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(() => {
  ipcMain.handle('init', async () => {
    let installedBytes = 0
    try {
      installedBytes = buildFileList().reduce((sum, f) => sum + f.size, 0)
    } catch {}
    return {
      version: meta.version,
      dir: DEFAULT_DIR,
      installedBytes: installedBytes || 260 * 1024 * 1024,
      hasOldData: fs.existsSync(path.join(ROAMING, 'RavokBot')) || fs.existsSync(path.join(ROAMING, 'ravokbot')),
      isUpdate: fs.existsSync(path.join(DEFAULT_DIR, APP_EXE)),
      running: await isRunning(DEFAULT_DIR),
    }
  })
  ipcMain.handle('normalize-dir', (_e, dir) => normalizeDir(dir))
  ipcMain.handle('pick-dir', async (_e, current) => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Escolha onde instalar o RavokBot',
      defaultPath: path.dirname(normalizeDir(current)),
      properties: ['openDirectory', 'createDirectory'],
    })
    if (res.canceled || !res.filePaths[0]) return null
    return normalizeDir(res.filePaths[0])
  })
  ipcMain.handle('install', (_e, options) => runInstall(options || {}))
  ipcMain.handle('cancel', () => {
    cancelled = true
  })
  ipcMain.handle('launch', async (_e, dir) => {
    const target = normalizeDir(dir)
    const exe = path.join(target, APP_EXE)
    if (fs.existsSync(exe) && !(await isRunning(target))) {
      try {
        spawn(exe, [], { detached: true, stdio: 'ignore', cwd: target }).unref()
      } catch {}
    }
    app.quit()
  })
  ipcMain.on('win-minimize', () => win && win.minimize())
  ipcMain.on('win-close', () => {
    cancelled = true
    app.quit()
  })
  createWindow()
})

app.on('window-all-closed', () => app.quit())
