// Roda depois de "dist:win": gera o INSTALADOR PROPRIO (telas do RavokBot).
// Usa o mesmo Electron do app (uma unica copia) e leva dentro o app.asar real do RavokBot.
// Resultado: dist/RavokBot-Setup-<versao>.exe  <- entregue este arquivo aos clientes.
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..')
const dist = path.join(root, 'dist')
const ui = path.join(root, 'installer-ui')
const pkg = require(path.join(root, 'package.json'))

const resources = path.join(dist, 'win-unpacked', 'resources')
const asar = path.join(resources, 'app.asar')
if (!fs.existsSync(asar)) {
  console.error('\nERRO: nao achei ' + asar + '\nO "npm run dist:win" precisa terminar antes de gerar o instalador proprio.\n')
  process.exit(1)
}

// payload = so o app (o runtime do Electron ja vem no proprio instalador)
const payload = path.join(ui, 'payload')
fs.rmSync(payload, { recursive: true, force: true })
fs.mkdirSync(payload, { recursive: true })
fs.copyFileSync(asar, path.join(payload, 'app.asar'))
const unpacked = path.join(resources, 'app.asar.unpacked')
if (fs.existsSync(unpacked)) fs.cpSync(unpacked, path.join(payload, 'app.asar.unpacked'), { recursive: true })

fs.writeFileSync(path.join(ui, 'meta.json'), JSON.stringify({ version: pkg.version }, null, 2))
const uiPkgPath = path.join(ui, 'package.json')
const uiPkg = JSON.parse(fs.readFileSync(uiPkgPath, 'utf8'))
uiPkg.version = pkg.version
fs.writeFileSync(uiPkgPath, JSON.stringify(uiPkg, null, 2) + '\n')

let electronVersion = ''
try {
  electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version
} catch {}

const cli = path.join(root, 'node_modules', 'electron-builder', 'cli.js')
if (!fs.existsSync(cli)) {
  console.error('\nERRO: electron-builder nao encontrado em ' + cli + '\n')
  process.exit(1)
}
const args = [cli, '--projectDir', ui, '--win', 'portable', '--x64']
if (electronVersion) args.push('-c.electronVersion=' + electronVersion)

console.log('Gerando o instalador proprio (RavokBot-Setup-' + pkg.version + '.exe)...')
const run = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
if (run.status !== 0) process.exit(run.status || 1)

const built = path.join(dist, '_installer', `RavokBot-Setup-${pkg.version}.exe`)
if (!fs.existsSync(built)) {
  console.error('\nERRO: o instalador proprio nao foi gerado em ' + built + '\n')
  process.exit(1)
}
fs.copyFileSync(built, path.join(dist, `RavokBot-Setup-${pkg.version}.exe`))
fs.rmSync(path.join(dist, '_installer'), { recursive: true, force: true })
fs.rmSync(payload, { recursive: true, force: true })
console.log('\nPronto: dist/RavokBot-Setup-' + pkg.version + '.exe')
