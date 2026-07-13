#!/usr/bin/env bash
#
# Levanta un túnel público hacia el backend local y (re)registra el webhook de
# Aurinko para todas las casillas conectadas. Pensado para desarrollo.
#
# Uso:
#   ./scripts/dev-tunnel.sh                 # cloudflared (recomendado)
#   TUNNEL=lt ./scripts/dev-tunnel.sh       # localtunnel con subdominio fijo
#   PORT=3001 ./scripts/dev-tunnel.sh
#
# Requisitos:
#   - Backend corriendo en localhost:$PORT (npm run start:dev)
#   - cloudflared instalado  (brew install cloudflared)   [default]
#     o localtunnel           (npm i -g localtunnel)        [TUNNEL=lt]
#
# Ctrl+C corta el túnel limpiamente.

set -euo pipefail

PORT="${PORT:-3001}"
TUNNEL="${TUNNEL:-cloudflared}"
LT_SUBDOMAIN="${LT_SUBDOMAIN:-mails-bot-dev}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="$(mktemp -t mails-bot-tunnel.XXXXXX)"

TUNNEL_PID=""
cleanup() {
  echo ""
  echo "🧹 Cerrando túnel..."
  [[ -n "$TUNNEL_PID" ]] && kill "$TUNNEL_PID" 2>/dev/null || true
  rm -f "$LOG_FILE"
}
trap cleanup EXIT INT TERM

echo "🚀 Levantando túnel ($TUNNEL) hacia http://localhost:$PORT ..."

case "$TUNNEL" in
  cloudflared)
    command -v cloudflared >/dev/null 2>&1 || {
      echo "✖ cloudflared no está instalado. Instalalo con: brew install cloudflared"
      echo "  (o usá localtunnel: TUNNEL=lt ./scripts/dev-tunnel.sh)"
      exit 1
    }
    cloudflared tunnel --url "http://localhost:$PORT" >"$LOG_FILE" 2>&1 &
    TUNNEL_PID=$!
    URL_REGEX='https://[a-zA-Z0-9.-]+\.trycloudflare\.com'
    ;;
  lt)
    command -v lt >/dev/null 2>&1 || {
      echo "✖ localtunnel no está instalado. Instalalo con: npm i -g localtunnel"
      exit 1
    }
    lt --port "$PORT" --subdomain "$LT_SUBDOMAIN" >"$LOG_FILE" 2>&1 &
    TUNNEL_PID=$!
    URL_REGEX='https://[a-zA-Z0-9.-]+\.loca\.lt'
    ;;
  *)
    echo "✖ TUNNEL desconocido: '$TUNNEL' (usá 'cloudflared' o 'lt')"
    exit 1
    ;;
esac

# ── Esperar a que aparezca la URL pública en el log ──────────────────────────
PUBLIC_URL=""
for _ in $(seq 1 30); do
  PUBLIC_URL="$(grep -Eo "$URL_REGEX" "$LOG_FILE" | head -n1 || true)"
  [[ -n "$PUBLIC_URL" ]] && break
  # si el proceso del túnel murió, abortar
  kill -0 "$TUNNEL_PID" 2>/dev/null || { echo "✖ El túnel terminó inesperadamente:"; cat "$LOG_FILE"; exit 1; }
  sleep 1
done

if [[ -z "$PUBLIC_URL" ]]; then
  echo "✖ No se pudo detectar la URL pública tras 30s. Log del túnel:"
  cat "$LOG_FILE"
  exit 1
fi

echo "🌐 URL pública: $PUBLIC_URL"

# ── Esperar propagación DNS + verificar handshake ────────────────────────────
# Usamos el DNS de Cloudflare (DoH) para el chequeo: algunos routers no resuelven
# *.trycloudflare.com (protección anti DNS-rebind), lo que daría un falso negativo.
# Aurinko igual resuelve por internet, así que esperamos a que el token vuelva OK
# antes de registrar, para no pegarle a Aurinko antes de que el host propague.
echo "🔎 Esperando a que el endpoint público responda (propagación DNS)..."
CHALLENGE="ping-$(date +%s)"
HANDSHAKE_OK=""
for _ in $(seq 1 30); do
  RESPONSE="$(curl -s --max-time 10 --doh-url https://1.1.1.1/dns-query \
    -X POST "$PUBLIC_URL/api/aurinko/webhook?validationToken=$CHALLENGE" 2>/dev/null || true)"
  if [[ "$RESPONSE" == "$CHALLENGE" ]]; then
    HANDSHAKE_OK="1"
    break
  fi
  sleep 2
done

if [[ -n "$HANDSHAKE_OK" ]]; then
  echo "   ✅ El endpoint público responde el validationToken correctamente."
else
  echo "   ⚠ El endpoint no respondió el token tras ~60s."
  echo "     ¿Está corriendo el backend en localhost:$PORT? Continuo igual con el registro..."
fi

# ── (Re)registrar el webhook en Aurinko ──────────────────────────────────────
echo "📮 Registrando webhook en Aurinko..."
( cd "$BACKEND_DIR" && npm run --silent webhooks:register -- "$PUBLIC_URL" )

echo ""
echo "✅ Túnel activo y webhook registrado."
echo "   URL: $PUBLIC_URL"
echo "   Dejá esta terminal abierta. Ctrl+C para cortar el túnel."
echo ""

# ── Mantener el túnel vivo en primer plano ───────────────────────────────────
wait "$TUNNEL_PID"
