# afiliados-ml

Bot de Telegram **@Cazagangasmxbot** para publicar ofertas de afiliados de
Mercado Libre en el canal de Telegram "CAZA GANGAS". Primer paso del plan
de automatización con Chino (ver `~/Notes/Projects/afiliados-mercado-libre.md`):
por ahora solo el canal de Telegram, foto + caption mandados a mano por un
afiliado autorizado.

Stack **independiente** del Framework Bot de lemut (otro bot, otro
puerto, otro proyecto de Docker Compose) — mismo patrón (n8n + Cloudflared
quick tunnel), sin compartir contenedores, volúmenes ni credenciales.

## Qué hace el workflow "Afiliados - Publicar en Telegram"

```
Webhook ──► ¿Secret correcto? (If)
                 │  true              │  false
                 ▼                    ▼
         Responder 200         Responder 403 (no se procesa)
                 │
                 ▼
       Validar mensaje (Code) ──► ¿Qué hacer? (Switch)
                                       │
          ┌────────────────────────────┼───────────────────┐
          ▼                            ▼                    ▼
   accion=responder              accion=publicar       accion=ignorar
          │                            │                   (nada)
          ▼                            ▼
  Enviar mensaje (HTTP)     Publicar en canal (HTTP sendPhoto)
          ▲                            │
          └────── Preparar confirmación ◄┘
                  (Code: arma el link t.me/cazagangasmx/<id>)
```

- **Autenticidad del webhook:** el nodo "Webhook" recibe cualquier POST al
  path público; el nodo "¿Secret correcto?" verifica el header
  `X-Telegram-Bot-Api-Secret-Token` contra `TELEGRAM_WEBHOOK_SECRET` (random,
  generado por `setup.sh`, nunca entra al repo). Header ausente o incorrecto
  → 403 y no se procesa el mensaje.
- **Dedupe:** Telegram puede reentregar el mismo `update_id` (retries de
  red); se guardan los últimos ~200 vistos en el staticData global del
  workflow para no publicar dos veces.
- **Quién puede publicar:** el dueño (`TELEGRAM_OWNER_ID`) y los IDs de
  Telegram en `TELEGRAM_ALLOWED_IDS` (separados por coma) o aprobados por
  código (ver abajo). Cualquier otro mensaje de alguien sin acceso que no
  sea `/start` ni un código de 4 dígitos se ignora en silencio (no se
  reenvía nada al dueño).
- **Alta de colaboradores por código:** quien no tiene acceso y manda
  `/start` recibe "Pide el código de acceso a Richer y escríbelo aquí"; al
  dueño le llega "Solicitud de acceso: &lt;nombre&gt; (@user, id &lt;id&gt;).
  Código: NNNN (vence en 10 min). Pásaselo solo si lo conoces." El código
  vence a los 10 min; 3 intentos fallidos bloquean al solicitante 1 hora
  (en silencio). Si lo escribe bien a tiempo queda aprobado (persiste en el
  staticData del workflow) y se avisa a ambos. El dueño puede ver la lista
  con `/usuarios` (base de `.env` + aprobados) y quitar acceso con
  `/quitar <id>`; estos comandos no hacen nada si los manda alguien que no
  es el dueño.
- **Qué debe mandar un autorizado:** una foto (la captura del producto) con
  caption que incluya un link a dominio exacto `meli.la/...` o
  `mercadolibre.com.mx/...` (con o sin subdominio, p. ej. `articulo.`). Si
  falta la foto o el link, se responde con instrucciones breves. Dominios
  parecidos pero distintos (`evilmeli.la`, `evilmercadolibre.com.mx`, un link
  ajeno con `meli.la` en la query string) **no cuentan como link válido**. El
  link real **nunca se modifica** (sin acortadores ni parámetros).
- **Publicación:** `sendPhoto` reutilizando el `file_id` que mandó Telegram
  (sin descargar la imagen), caption tal cual, respetando el límite de 1024
  caracteres de Telegram (si se pasa, se rechaza con aviso — no se trunca,
  podría cortar el link).
- **Confirmación:** se responde al remitente "Publicado en el canal:
  https://t.me/cazagangasmx/<message_id>" con el ID real del post.
- Los nodos HTTP Request llaman la API de Telegram directo (no el nodo
  nativo `n8n-nodes-base.telegram`) para evitar que n8n fuerce
  `parse_mode: Markdown` en el caption/texto.
- Extender a Facebook/IG/WhatsApp más adelante: agregar ramas después del
  nodo "Publicar en canal" (o un nodo nuevo en paralelo a la salida del
  Switch), sin tocar la validación.

## Cómo levantarlo

1. **Variables de entorno**

   ```bash
   cp .env.example .env
   # Editar con los valores reales: TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID,
   # TELEGRAM_CHANNEL_USERNAME, TELEGRAM_ALLOWED_IDS, TELEGRAM_OWNER_ID,
   # N8N_OWNER_EMAIL, N8N_OWNER_PASSWORD. TELEGRAM_WEBHOOK_SECRET se deja
   # vacío: setup.sh lo genera solo.
   ```

2. **Arrancar el stack**

   ```bash
   ./scripts/up.sh
   ```

   Levanta n8n (puerto **5679**, SQLite — sin Postgres, un solo workflow no
   lo necesita) + Cloudflared, espera una URL de tunnel viva, la escribe en
   `.tunnel.env` y recrea n8n con ella.

3. **Primera vez: owner + secret + workflow**

   ```bash
   ./scripts/setup.sh
   ```

   Crea el owner de n8n por API (`N8N_OWNER_EMAIL`/`N8N_OWNER_PASSWORD`) si
   todavía no existe (idempotente), genera `TELEGRAM_WEBHOOK_SECRET` en
   `.env` si falta, importa el workflow
   `workflows/afiliados_publicar_telegram.json` por CLI, lo activa y
   reinicia n8n. Solo hace falta una vez por volumen de datos
   (`afiliados-ml_n8n_data`) nuevo (o cuando se genera un secret nuevo).

4. **Registrar el webhook con Telegram**

   ```bash
   ./scripts/up.sh
   ```

   Vuelve a correrlo (ya con el workflow activo y el secret en `.env`):
   recrea n8n para que tome `TELEGRAM_WEBHOOK_SECRET`, registra el webhook
   en Telegram con `setWebhook` usando la URL del tunnel actual y ese
   secret, y lo verifica con `getWebhookInfo`. A diferencia de lemut_n8n,
   **no hace falta activar/desactivar el workflow a mano** tras cada
   refresh del tunnel: `up.sh` siempre vuelve a registrar el webhook
   correcto.

5. **Acceder a la UI de n8n** (opcional, para ver ejecuciones)

   <http://localhost:5679> — login con `N8N_OWNER_EMAIL`/`N8N_OWNER_PASSWORD`.

6. **Detener el stack**

   ```bash
   ./scripts/down.sh
   ```

   El volumen `n8n_data` se conserva (workflow, owner, ejecuciones).

## Sobre el tunnel

Mismas limitaciones que lemut_n8n (quick tunnel de Cloudflare, sin cuenta):
la URL puede caducar y el DNS local puede cachear "no existe" para un
subdominio nuevo. `up.sh` detecta ambos casos (igual que lemut_n8n) y,
además, **re-registra el webhook de Telegram automáticamente** cada vez
que la URL cambia — no requiere tocar nada en la UI.

## Pruebas

- `node workflows/src/validar_mensaje.js` corre el self-check de la lógica
  pura (permitido/no permitido, foto+link, dominios falsificados, límite de
  1024, caption inválido, código correcto/incorrecto/vencido, 3 fallos →
  bloqueo, `/quitar` por el dueño y por alguien que no lo es).
- Prueba E2E real (hecha en esta sesión, ver reporte): `sendPhoto` real
  para obtener un `file_id`, POST de updates simulados al webhook público
  (sin header, con header vacío, con header incorrecto y con el header
  `X-Telegram-Bot-Api-Secret-Token` correcto), confirmación de la
  publicación real en el canal, del dedupe por `update_id`, y del flujo de
  alta por código (solicitud → código real al dueño → aprobación →
  `/quitar`) vía la ejecución en n8n (`GET /rest/executions/<id>`), con
  `deleteMessage` de los mensajes de prueba al terminar. Para repetir:
  construir un update de Telegram a mano (ver estructura en
  `workflows/src/validar_mensaje.js`) y mandarlo por POST a
  `${WEBHOOK_URL}webhook/afiliados-ml-telegram` con ese header.

## Estructura

```
afiliados-ml/
├── README.md
├── .env                  Secretos reales (NO se versiona)
├── .env.example           Plantilla sin valores
├── .tunnel.env            Generado por up.sh (NO se versiona)
├── .gitignore
├── docker-compose.yml     n8n (SQLite) + Cloudflared, proyecto "afiliados-ml"
├── diagrama-flujo.mmd/png Diagrama de la visión completa (ver Notes)
├── fuentes/               T&C del Programa de Afiliados descargados
├── scripts/
│   ├── up.sh              Arranque + refresh de tunnel + registro de webhook
│   ├── down.sh            Apagado
│   └── setup.sh           Bootstrap único: owner + secret + workflow + activar
└── workflows/
    ├── afiliados_publicar_telegram.json  El workflow (sin credenciales)
    └── src/
        └── validar_mensaje.js            Lógica pura + self-check (node)
```

## Notas

- `.env` y `.tunnel.env` nunca entran al repositorio.
- No hay Postgres: un solo workflow, un solo bot — SQLite alcanza (YAGNI).
- IDs fijos en el workflow (`AfiliadosPubTG01` / nodo `Webhook` con
  `webhookId`/`path: afiliados-ml-telegram`): si se reimporta el workflow
  con otro `path`, hay que actualizar `WEBHOOK_PATH` en `scripts/up.sh`. El
  `webhookId` del nodo debe seguir presente (n8n lo necesita para registrar
  la ruta tal cual, sin él antepone `<workflowId>/<nombre del nodo>/` al
  path real).
- El Code node "Validar mensaje" usa `require('crypto')` (para el código de
  acceso de 4 dígitos); por eso `docker-compose.yml` tiene
  `NODE_FUNCTION_ALLOW_BUILTIN=crypto` (el task runner de n8n bloquea
  `require()` de builtins sin esto).
- El `secret_token` del webhook ya no depende de esos IDs (antes era
  determinista y, por estar en un repo público, falsificable); viene de
  `TELEGRAM_WEBHOOK_SECRET` en `.env`, generado una sola vez por
  `scripts/setup.sh`.
