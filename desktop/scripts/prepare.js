// Runs automatically before "npm run dist:win": copies the interface into the app and blocks a broken build.
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const source = path.join(root, '..', 'public', 'renderer')
const target = path.join(root, 'renderer')

if (fs.existsSync(source)) {
  fs.rmSync(target, { recursive: true, force: true })
  fs.cpSync(source, target, { recursive: true })
  console.log('Interface copiada de public/renderer para desktop/renderer')
}

const required = ['renderer/index.html', 'renderer/logo.png', 'renderer/styles.css', 'build/icon.ico', 'app-config.json']
const missing = required.filter((file) => !fs.existsSync(path.join(root, file)))

if (missing.length) {
  console.error('\nERRO: faltam arquivos, o .exe sairia com tela branca:')
  for (const file of missing) console.error('  - desktop/' + file)
  console.error('\nEnvie a pasta "public/renderer" junto com a pasta "desktop" (mesmo nível) e crie o app-config.json.\n')
  process.exit(1)
}

console.log('Tudo certo para gerar o instalador.')
