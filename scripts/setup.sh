#!/usr/bin/env bash
# Bootstrap de una sola vez: crea el owner de n8n (si falta), genera el
# secret del webhook (si falta), importa el workflow y lo deja activo. No
# se mete en up.sh porque up.sh corre en cada arranque (tunnel + webhook) y
# esto solo hace falta una vez por volumen de datos nuevo (n8n_data).
#
# Requiere que el stack ya esté arriba: ./scripts/up.sh primero.
# Uso: ./scripts/setup.sh

set -euo pipefail
cd "$(dirname "$0")/.."

CONTENEDOR="afiliados-ml-n8n-1"
WORKFLOW_ID="AfiliadosPubTG01"
WORKFLOW_FILE="workflows/afiliados_publicar_telegram.json"

set -a; . ./.env; set +a

echo "▶ Owner de n8n..."
SHOW_SETUP=$(curl -s http://localhost:5679/rest/settings \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['userManagement']['showSetupOnFirstLoad'])" 2>/dev/null || echo "")
if [ "$SHOW_SETUP" = "True" ]; then
  echo "  Creando owner ($N8N_OWNER_EMAIL)..."
  # Payload armado con json.dumps (no interpolación manual): una password con
  # comillas o backslash rompería el JSON construido a mano.
  PAYLOAD=$(N8N_OWNER_EMAIL="$N8N_OWNER_EMAIL" N8N_OWNER_PASSWORD="$N8N_OWNER_PASSWORD" python3 -c "
import json, os
print(json.dumps({
    'email': os.environ['N8N_OWNER_EMAIL'],
    'firstName': 'Afiliados',
    'lastName': 'ML',
    'password': os.environ['N8N_OWNER_PASSWORD'],
}))
")
  HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:5679/rest/owner/setup \
    -H 'Content-Type: application/json' -d "$PAYLOAD")
  echo "  HTTP $HTTP_CODE"
  [ "$HTTP_CODE" = "200" ] || { echo "✗ No se pudo crear el owner."; exit 1; }
else
  echo "  Ya existe, no hace falta (idempotente)."
fi

echo "▶ Secret del webhook..."
if ! grep -q '^TELEGRAM_WEBHOOK_SECRET=.' .env 2>/dev/null; then
  echo "  No hay uno en .env, generando..."
  WEBHOOK_SECRET=$(openssl rand -hex 32)
  # Si la línea existe vacía (venía de .env.example) se reemplaza; si no, se agrega.
  if grep -q '^TELEGRAM_WEBHOOK_SECRET=' .env 2>/dev/null; then
    sed -i "s/^TELEGRAM_WEBHOOK_SECRET=.*/TELEGRAM_WEBHOOK_SECRET=${WEBHOOK_SECRET}/" .env
  else
    echo "TELEGRAM_WEBHOOK_SECRET=${WEBHOOK_SECRET}" >> .env
  fi
  # El `set -a; . ./.env` de arriba ya exportó la versión vieja (vacía) al
  # shell; docker compose prioriza env del shell sobre el .env del archivo,
  # así que sin este export el force-recreate de abajo seguiría arrancando
  # n8n con el secret vacío (fail-open: cualquier header vacío lo pasaría).
  export TELEGRAM_WEBHOOK_SECRET="$WEBHOOK_SECRET"
else
  echo "  Ya existe en .env, no se toca."
fi

echo "▶ Importando workflow '$WORKFLOW_FILE'..."
docker exec "$CONTENEDOR" rm -rf /tmp/import_wf
docker exec "$CONTENEDOR" mkdir -p /tmp/import_wf
docker cp "$WORKFLOW_FILE" "$CONTENEDOR:/tmp/import_wf/$(basename "$WORKFLOW_FILE")"
docker exec "$CONTENEDOR" n8n import:workflow --separate --input=/tmp/import_wf/

echo "▶ Activando workflow..."
docker exec "$CONTENEDOR" n8n update:workflow --id="$WORKFLOW_ID" --active=true

echo "▶ Recreando n8n para que tome la activación y el secret del webhook..."
# force-recreate (no restart): restart no vuelve a leer .env, dejaría el
# secret nuevo sin aplicar hasta el siguiente up.sh (ventana fail-open).
docker compose up -d --force-recreate n8n >/dev/null

echo "  Esperando a que n8n vuelva a estar listo (timeout 60s)..."
for i in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5679/healthz)" = "200" ] && break
  sleep 1
done

echo "✓ Listo. Corre ./scripts/up.sh para registrar el webhook con la URL del tunnel actual."
