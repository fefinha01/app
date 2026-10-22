#!/usr/bin/env bash
# Gera o instalador .exe do Windows num servidor Linux (aaPanel) usando Docker.
# O Docker é necessário porque gerar .exe no Linux exige o Wine, que já vem na imagem.
set -e
cd "$(dirname "$0")"

# A interface fica em ../public/renderer; copia para dentro do app antes de empacotar.
if [ -d ../public/renderer ]; then
  mkdir -p renderer
  cp -r ../public/renderer/. renderer/
fi

if [ ! -f app-config.json ]; then
  echo "ERRO: crie desktop/app-config.json (copie de app-config.example.json) com apiUrl e appSecret da sua API."
  exit 1
fi

docker run --rm \
  -v "$PWD":/project \
  -v multitelas-electron-cache:/root/.cache/electron \
  -v multitelas-builder-cache:/root/.cache/electron-builder \
  -w /project \
  electronuserland/builder:wine \
  bash -c "npm install && npm run dist:win && npm run dist:installer"

echo ""
echo "Pronto! Arquivos gerados em: $PWD/dist"
ls -lh dist/*.exe
