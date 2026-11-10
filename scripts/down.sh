#!/usr/bin/env bash
# Apaga el stack de afiliados-ml. El volumen n8n_data (workflow,
# credenciales, ejecuciones) se conserva; para borrarlo: ver README.md.
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose down
