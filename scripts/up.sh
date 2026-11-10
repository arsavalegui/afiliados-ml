#!/usr/bin/env bash
# Arranca el stack de afiliados-ml y garantiza que el webhook de Telegram
# apunte a la URL del tunnel vigente. A diferencia de lemut_n8n (donde hay
# que apagar/encender el workflow a mano tras cada refresh), este script
# llama `setWebhook` él mismo con la URL vigente y el secret_token de
# TELEGRAM_WEBHOOK_SECRET (.env), así que no hace falta tocar nada en la UI.
#
#   1. Levanta n8n + cloudflared
#   2. Si la URL guardada en .tunnel.env aún responde, la reusa.
#      Si no responde, reinicia cloudflared y espera URL nueva viva.
#   3. Escribe .tunnel.env con la URL buena
#   4. Recrea n8n con la URL actualizada en su env
#   5. Registra el webhook en Telegram con esa URL (setWebhook) y lo verifica
#
# Uso: ./scripts/up.sh
# Primera vez: antes de este script corre ./scripts/setup.sh (crea el owner,
# el secret del webhook y el workflow — ver README.md).

set -euo pipefail
cd "$(dirname "$0")/.."

touch .tunnel.env

# Path fijo del nodo "Webhook" del workflow (ver
# workflows/afiliados_publicar_telegram.json, parámetro `path`) — si se
# reimporta el workflow con otro path, hay que actualizarlo aquí también.
# El secret_token ya no se deriva de IDs del workflow (era falsificable:
# público en el repo); viene de TELEGRAM_WEBHOOK_SECRET en .env, generado
# por setup.sh.
WEBHOOK_PATH="afiliados-ml-telegram"

# --- helpers (igual criterio que lemut_n8n/scripts/up.sh) ---
url_alive() {
  local url="$1"
  [ -z "$url" ] && return 1
  local code host ip
  # Viva solo si responde /healthz con código <500 (el propio n8n, no
  # cualquier página de error del borde de Cloudflare para un túnel muerto).
  code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$url/healthz" 2>/dev/null)
  if [ -n "$code" ] && [ "$code" != "000" ] && [ "$code" -lt 500 ]; then return 0; fi
  # El DNS local puede cachear "no existe" para subdominios nuevos de
  # trycloudflare; resolvemos directo con 1.1.1.1 antes de dar la URL
  # por muerta (gotcha conocido, mismo que lemut_n8n).
  host="${url#https://}"; host="${host%%/*}"
  ip=$(dig +short @1.1.1.1 "$host" 2>/dev/null | head -1)
  [ -z "$ip" ] && return 1
  code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' \
    --resolve "$host:443:$ip" "https://$host/healthz" 2>/dev/null)
  [ -n "$code" ] && [ "$code" != "000" ] && [ "$code" -lt 500 ]
}

extract_tunnel_url() {
  docker compose logs cloudflared 2>&1 \
    | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' \
    | tail -1
}

# --- pasos ---
echo "▶ Levantando n8n y cloudflared..."
docker compose up -d >/dev/null

echo "▶ Esperando a que n8n local esté listo (timeout 60s)..."
for i in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5679/healthz)" = "200" ] && break
  sleep 1
done
# Sin esto, justo tras un arranque/recreate, cloudflared puede responder con
# un error transitorio mientras n8n sigue levantando — el chequeo de abajo
# marcaría la URL existente como "muerta" y la refrescaría sin necesidad.

EXISTING_URL=$(grep '^WEBHOOK_URL=' .tunnel.env 2>/dev/null | cut -d= -f2- | sed 's:/$::' || true)

if [ -n "$EXISTING_URL" ] && url_alive "$EXISTING_URL"; then
  echo "▶ URL existente sigue viva, la reuso: $EXISTING_URL"
  URL="$EXISTING_URL/"
else
  if [ -n "$EXISTING_URL" ]; then
    echo "▶ URL existente no responde (stale), reiniciando cloudflared..."
    docker compose restart cloudflared >/dev/null
  fi

  echo "▶ Esperando URL del tunnel viva (timeout 120s)..."
  URL=""
  for i in $(seq 1 120); do
    CANDIDATE=$(extract_tunnel_url || true)
    if [ -n "$CANDIDATE" ] && [ "$CANDIDATE" != "$EXISTING_URL" ] && url_alive "$CANDIDATE"; then
      URL="$CANDIDATE/"
      break
    fi
    sleep 1
  done

  if [ -z "$URL" ]; then
    echo "✗ No se obtuvo URL del tunnel viva en 120s. Últimos logs:"
    docker compose logs cloudflared --tail 30
    exit 1
  fi
fi

HOST="${URL#https://}"
HOST="${HOST%/}"

cat > .tunnel.env <<EOF
# Generado automáticamente por scripts/up.sh — NO editar a mano.
WEBHOOK_URL=$URL
N8N_HOST=$HOST
N8N_PROTOCOL=https
EOF

echo "▶ Tunnel listo: $URL"
echo "▶ Recreando n8n con la URL actualizada..."
docker compose up -d --force-recreate n8n >/dev/null

echo "▶ Esperando a que n8n esté listo (timeout 60s)..."
LISTO=""
for i in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5679/healthz)" = "200" ] && { LISTO=1; break; }
  sleep 1
done
[ -n "$LISTO" ] || { echo "✗ n8n no volvió a estar listo en 60s"; exit 1; }

set -a; . ./.env; set +a
if [ -z "${TELEGRAM_WEBHOOK_SECRET:-}" ]; then
  # Normal en el primer arranque: README pide correr up.sh ANTES de
  # setup.sh (para tener n8n arriba y poder crear owner/secret/workflow).
  # Todavía no hay nada que registrar; no es un error fatal.
  echo "▶ Aviso: falta TELEGRAM_WEBHOOK_SECRET en .env (normal en el primer"
  echo "  arranque). Corre ./scripts/setup.sh y luego ./scripts/up.sh otra"
  echo "  vez para registrar el webhook con Telegram."
else
  echo "▶ Registrando webhook en Telegram..."
  WEBHOOK_URL_FULL="${URL}webhook/${WEBHOOK_PATH}"
  SET_RESP=$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
    --data-urlencode "url=${WEBHOOK_URL_FULL}" \
    --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
    --data-urlencode 'allowed_updates=["message"]')
  SET_OK=$(echo "$SET_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok'))" 2>/dev/null || echo "")
  if [ "$SET_OK" != "True" ]; then
    echo "✗ setWebhook no respondió ok:true. Respuesta:"
    echo "$SET_RESP"
    exit 1
  fi

  echo "▶ Verificando con getWebhookInfo (hasta 15s, puede tardar el DNS)..."
  OK=""
  for i in $(seq 1 15); do
    INFO=$(curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo")
    REGISTRADA=$(echo "$INFO" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['url'])" 2>/dev/null || true)
    if [ "$REGISTRADA" = "$WEBHOOK_URL_FULL" ]; then OK=1; break; fi
    sleep 1
  done
  if [ -z "$OK" ]; then
    echo "✗ getWebhookInfo no reporta la URL esperada. Respuesta:"
    echo "$INFO"
    exit 1
  fi
  echo "✓ Webhook de Telegram registrado: $WEBHOOK_URL_FULL"
fi

echo ""
echo "✓ Stack listo."
echo "  • n8n UI (local):    http://localhost:5679"
echo "  • n8n público:       $URL"
echo ""
echo "  Nota: vuelve a correr este script cuando algo deje de funcionar;"
echo "  detecta URL stale, la refresca y re-registra el webhook solito."
