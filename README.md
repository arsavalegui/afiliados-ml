# afiliados-ml

Bot de Telegram **@Cazagangasmxbot** para publicar ofertas de afiliados de
Mercado Libre en el canal de Telegram "CAZA GANGAS". Primer paso del plan
de automatización con Chino (ver `~/Notes/Projects/afiliados-mercado-libre.md`):
por ahora solo el canal de Telegram, foto + caption (producto puntual) o
texto (anuncio de cupones generales) mandados a mano por un afiliado
autorizado.

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
          ┌────────────┬───────────────┼───────────────────┐
          ▼            ▼               ▼                    ▼
   accion=responder  accion=publicar  accion=cupones   accion=ignorar
          │          (foto + link,    (texto sin foto,      (nada)
          │           ver abajo)       ver abajo)
          ▼                │               │
  Enviar mensaje (HTTP) ◄──┴───────────────┘
```

**Rama `accion=publicar`** (foto + link de Mercado Libre en el caption):

```
Obtener archivo (HTTP getFile) ──► Descargar imagen (HTTP, binario)
  ──► Preparar imagen (Code: a base64)
  ──► Analizar imagen (HTTP a Ollama local, visión, timeout 120s, con fallback)
  ──► Armar caption (Code: plantilla fija + datos del modelo; si falla/
        tarda/JSON inválido → caption ORIGINAL tal cual)
  ──► Publicar en canal (HTTP sendPhoto)
  ──► Preparar confirmación (Code: arma el link t.me/cazagangasmx/<id>;
        si "Armar caption" cayó a fallback, agrega un 2° mensaje
        avisando al dueño) ──► Enviar mensaje
```

**Rama `accion=cupones`** (texto sin foto que parece anuncio de cupones
generales, ver "Anuncio de cupones generales" abajo):

```
Analizar cupones (HTTP a Ollama local, texto, timeout 120s, con fallback)
  ──► Armar cupones (Code: plantilla fija HTML + datos del modelo;
        códigos/montos validados contra el texto original; si falla/
        tarda/JSON inválido/sin cupones válidos → texto ORIGINAL con
        *negritas* de WhatsApp convertidas a <b>, SIN ningún link)
  ──► Publicar cupones (HTTP sendMessage, parse_mode HTML)
  ──► Preparar confirmación cupones (mismo patrón que "Preparar
        confirmación": arma el link al post y avisa al dueño si cayó a
        fallback) ──► Enviar mensaje
```

### Análisis de imagen con IA (antes de publicar)

Antes de mandar `sendPhoto`, el workflow descarga la foto que mandó el
afiliado y la manda a un modelo de **visión** para extraer los datos del
producto y armar un caption con plantilla (el LLM solo extrae datos, nunca
redacta el texto final — la plantilla vive en código, en
`workflows/src/motor_caption.js`).

- **Modelo y proveedor: Ollama LOCAL, el mismo que usa `lemut_n8n` para el
  LLM que lee documentos** (el RAG del bot de la barbería usa la credencial
  "Ollama local" → `http://host.docker.internal:11434/v1`, confirmado
  exportando esa credencial decrypted desde el contenedor de lemut). Acá se
  llama por HTTP Request directo al mismo endpoint (sin credencial de n8n,
  mismo criterio que las llamadas a la API de Telegram), porque es una sola
  llamada de "analiza esta imagen", no una cadena de LangChain con memoria.
- **`qwen2.5:3b-instruct`** (el modelo que usa lemut para RAG) **no tiene
  visión** — se bajó **`qwen2.5vl:3b`** (3.2 GB), el modelo de visión más
  chico de los sugeridos (qwen2.5vl / gemma3 / llama3.2-vision) que además
  es el más fuerte leyendo texto dentro de imágenes (benchmarks de
  OCR/documentos), clave aquí porque casi todo el dato viene de texto
  incrustado en la captura de Mercado Libre.
- **Red:** el contenedor de n8n alcanza Ollama del host vía
  `host.docker.internal` (`extra_hosts: host-gateway` en
  `docker-compose.yml`, mismo mecanismo que usa lemut_n8n para su LLM).
  Ollama corre como servicio systemd de usuario en el host (puerto 11434,
  `OLLAMA_HOST=0.0.0.0:11434`), **no** en un contenedor de este proyecto.
- **Prompt:** pide un JSON estricto (`nombre_corto` con tamaño/pulgadas si
  aplica, `nombre_completo`, `marca`, `precio_actual`, `precio_anterior`,
  `precio_con_cupon`, `cupon_disponible`, `cashback_monto`, `descuento_pct`,
  `promociones`, `tienda_oficial`) pidiendo explícitamente cada recuadro
  visual (precio principal, precio tachado, recuadro azul de cupón,
  cashback/Meli Dólar, banner de tienda oficial, meses sin intereses) y una
  regla general: en Mercado Libre los centavos van chiquitos y elevados
  justo después del precio (ej. "$14⁷⁸" = $14.78) — **un número chiquito
  pegado a un precio es SIEMPRE centavos de ESE precio, nunca un
  porcentaje**. Regla dura de solo reportar lo que se ve (`null`/`false` si
  no está, nunca inventar precios/cupones). No se le pide abrir el link.
  `cupon_disponible` cubre el caso de un cupón visible sin poder leer el
  precio exacto. El **ahorro del cupón** ("ahorras $Z") y la frase fija del
  cashback las arma el código (`motor_caption.js`), nunca el LLM — y el
  campo `tienda_oficial` se limpia en código si el modelo devuelve el
  renglón completo del banner en vez de solo el nombre.
- **Cashback en Meli Dólar, no en pesos:** la línea dice "💰 X.XX dólares de
  cashback en Meli Dólar (con Meli+ y Tarjeta de Crédito Mercado Pago)" —
  sin signo `$` (es dólares) y siempre con 2 decimales. Meli Dólar es la
  stablecoin 1:1 con el dólar de Mercado Pago (ver sección "Meli Dólar" en
  la nota de Obsidian para fuentes oficiales y el tope real de $15 USD por
  ítem / $150 USD mensuales).
- **`nombre_corto` con pulgadas:** si el modelo pierde las comillas (`70 4K`
  en vez de `70" 4K`) pero sí las puso en `nombre_completo`, el código las
  agrega en `nombre_corto` — solo si el número ya aparece ahí tal cual
  (nunca inventa un tamaño que el modelo no haya reportado en ese campo).
- **Timeout 120 s** (`options.timeout` del nodo "Analizar imagen") + los
  tres nodos HTTP de esta cadena (`Obtener archivo`, `Descargar imagen`,
  `Analizar imagen`) usan `onError: continueRegularOutput`: si cualquiera
  falla o el modelo tarda más de 120 s, "Armar caption" cae a **fallback**
  (publica el **caption original**, el que mandó el afiliado, tal cual) y
  se avisa al dueño por Telegram. La publicación **nunca** se bloquea por
  un problema del LLM.
- **Precarga del modelo:** `scripts/up.sh` manda un `keep_alive` a Ollama
  sin generar nada, cada vez que arranca el stack, para que el modelo ya
  esté en RAM antes del primer post real.
- **Medido con la imagen real del post de prueba (TV Samsung)**: con el
  prompt más detallado (pide cada recuadro explícitamente) el análisis tarda
  **~58-63 s con el modelo ya cargado** (no solo en frío — el prompt más
  largo pesa más que el estado de "caliente"/"frío" del modelo), de ahí
  subir el timeout de 60 a 120 s en vez de solo precargar.
- **`qwen2.5vl:3b` (3.2 GB) vs `qwen2.5vl:7b` (6 GB), comparación real**: con
  el mismo prompt, el 7b tardó **89.8 s** (56% más lento que el 3b) y salió
  **menos preciso**: le faltó "IVA incluido" en `promociones` (solo devolvió
  una de las dos promociones reales) y devolvió `tienda_oficial` en
  minúsculas. El 3b extrajo los 11 campos correctos. Se descartó el 7b: más
  lento y no más preciso.
- **Publicación:** sigue usando `sendPhoto` con el `file_id` original (no
  se resube la imagen descargada — se descarga solo para mandarla al
  modelo, no para republicarla), con el caption nuevo (o el original, en
  fallback), respetando el límite de 1024 caracteres (si la plantilla arma
  un caption más largo, también cae a fallback con el original).

### Anuncio de cupones generales (sin foto)

Un segundo tipo de mensaje, aparte de "foto + link de un producto": un
afiliado manda un mensaje de **texto, sin foto**, anunciando cupones
generales (ej. cupones bancarios del Buen Fin) — no es la ficha de un
producto puntual, por eso usa su propia plantilla y su propio motor
(`workflows/src/motor_cupones.js`).

- **Detección (nodo "Validar mensaje"):** un texto sin foto se interpreta
  como anuncio de cupones si menciona la palabra "cupón"/"cupones" o
  "código" — **ya no depende de traer un link** (antes sí; se quitó ese
  requisito porque el link que trae este tipo de mensaje casi siempre es el
  link de afiliado de OTRA persona, no nuestro). Cualquier otro texto sin
  foto sigue el camino de siempre: instrucciones.
- **Nunca se publica ningún link:** cualquier URL se quita del texto en
  `validar_mensaje.js` **antes** de mandarlo al modelo y antes de usarlo en
  el fallback — no solo `http(s)://...` o `meli.la`/`mercadolibre.com.mx`:
  también cualquier dominio sin esquema (`bit.ly/abc`, `t.me/canal`,
  `www.otro.com`, `x.com/...`); la plantilla de cupones no tiene línea de
  link. `motor_cupones.js` vuelve a limpiar cada campo dinámico (título,
  requisitos, emisor, condiciones) con el mismo criterio, como defensa en
  profundidad, por si el modelo repitiera un link.
- **Modelo:** mismo proveedor (Ollama local) que el resto, pero aquí basta
  texto — se usa **`qwen2.5:3b-instruct`** (el mismo modelo que usa
  `lemut_n8n` para su RAG, ya estaba instalado, no hace falta visión).
- **Prompt:** pide un JSON estricto (`titulo`, `requisito_general[]`,
  `cupones[{emisor, porcentaje, codigo, compra_minima, descuento_maximo,
  condiciones[]}]`). Gotcha real encontrado al probar: el modelo confundía
  el título del anuncio con la primera línea de requisitos cuando el texto
  ya no traía el link al final — se corrigió siendo explícito en el prompt:
  "titulo: SOLO la PRIMERA línea del mensaje... las líneas siguientes que
  hablan de Meli+ o de que son combinables NO son el título".
- **Regla dura de dinero:** los **códigos y los montos se validan en
  código** contra el texto original. No basta con que el código aparezca
  como palabra suelta (el nombre del banco, ej. "BBVA", también es una
  palabra real del texto sin ser el código) — se exige que esté **en
  posición de código**: solo en su propia línea (ej. "🎟️ CREDITO40") o
  justo después de la palabra "código"/"cupón" (ej. "usa el código
  ABC123"). Si no, ese cupón se descarta completo (nunca se publica un
  código inventado ni uno real colado por substring, ej. "CREDITO4" dentro
  de "CREDITO40"); un monto/porcentaje que no se pueda verificar se omite
  (no se inventa, pero no tira todo el cupón) y siempre se guarda como
  número, nunca como el string crudo del LLM (para que parse_mode HTML no
  pueda renderizar una etiqueta inyectada). El ahorro no aplica aquí (no hay
  "antes/después" como en el producto), pero el mismo criterio de "nunca lo
  redacta el LLM, siempre se arma en código" se mantiene.
- **Formato real HTML** (no el formato plano del resto del bot): el nodo
  "Publicar cupones" manda `parse_mode: "HTML"` de verdad, con `<b>` para
  títulos/emisores y `<code>` para que los códigos se copien con un toque.
  Todo texto dinámico se escapa (`&`, `<`, `>`) antes de insertar las
  etiquetas.
- **Timeout 120 s**, igual que el análisis de imagen (medido ~54-60 s con
  el modelo ya cargado). Si falla/tarda/el JSON es inválido/no queda ningún
  cupón válido tras la validación: fallback = se publica el **texto
  ORIGINAL** (sin links) convirtiendo `*negritas*` de WhatsApp a `<b>` (con
  el mismo `parse_mode: HTML`), y se avisa al dueño.

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
  para el envío (no se resube nada), con el caption armado por IA (ver
  "Análisis de imagen con IA" abajo) o el caption original tal cual si el
  análisis falla/tarda/cae a fallback, respetando el límite de 1024
  caracteres de Telegram. La imagen SÍ se descarga una vez, aparte, solo
  para mandarla al modelo de visión (no para la publicación en sí).
- **Confirmación:** se responde al remitente "Publicado en el canal:
  https://t.me/cazagangasmx/<message_id>" con el ID real del post.
- Los nodos HTTP Request llaman la API de Telegram directo (no el nodo
  nativo `n8n-nodes-base.telegram`) para evitar que n8n fuerce
  `parse_mode: Markdown` en el caption/texto.
- Extender a Facebook/IG/WhatsApp más adelante: agregar ramas después del
  nodo "Publicar en canal" (o un nodo nuevo en paralelo a la salida del
  Switch), sin tocar la validación.

## Cómo levantarlo

**Requisito adicional (análisis de imagen con IA):** Ollama corriendo en el
HOST (no en Docker), puerto 11434, con el modelo `qwen2.5vl:3b` descargado
(`ollama pull qwen2.5vl:3b`, 3.2 GB) — es el mismo Ollama local que usa
`lemut_n8n` para su LLM de RAG, compartido entre ambos proyectos (nada de
contenedores ni volúmenes en común, solo el mismo proceso del host). Sin
esto, el workflow sigue funcionando, pero cada post cae a fallback
(publica el caption original) y avisa al dueño.

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
  bloqueo, `/quitar` por el dueño y por alguien que no lo es, y la
  extracción de `link`/`textoUsuario` que usa "Armar caption").
- `node workflows/src/motor_caption.js` corre el self-check de la plantilla
  de caption (todo completo, sin cupón, sin precio anterior, JSON inválido
  → fallback, respuesta vacía → fallback, JSON envuelto en fences de
  markdown, sin nombre de producto → fallback, caption resultante > 1024 →
  fallback). Datos 100% sintéticos (repo público).
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
- Prueba E2E del análisis de imagen con IA (sesión del 2026-11-10): se
  reusó el `file_id` y caption del post real de la TV Samsung (último
  `accion=publicar` exitoso en n8n) para publicar un post NUEVO (sin tocar
  el original) con el caption armado por el modelo — ver reporte de esa
  sesión para el JSON extraído y los tiempos. También se probó la ruta de
  fallback con un `file_id` inválido (falla real de Telegram en
  `getFile`/`sendPhoto`, no simulada) confirmando que "Armar caption" cae a
  fallback sin tronar, y un test aislado (con `$input`/`$()`/`$env`
  simulados sobre el `jsCode` real de "Preparar confirmación") que confirma
  que el aviso al dueño se manda cuando la publicación sí fue exitosa pero
  el análisis de imagen cayó a fallback.
- Segunda ronda (mismo día, feedback sobre `t.me/cazagangasmx/8`): prompt
  ajustado (campos `precio_con_cupon`/`cupon_disponible`/`cashback_monto`
  separados, regla de centavos en superíndice, tienda oficial, pulgadas en
  `nombre_corto`) y comparación real `qwen2.5vl:3b` vs `qwen2.5vl:7b` (ver
  "Análisis de imagen con IA" arriba). Se reusó otra vez el mismo `file_id`
  de la TV Samsung para publicar un tercer post (`t.me/cazagangasmx/9`,
  sin tocar los dos anteriores) con el caption corregido.
- Tercera ronda (ajuste final): cashback corregido a dólares (verificado
  con fuentes oficiales de Mercado Pago/Meli+ — ver nota de Obsidian) y
  normalización de pulgadas en `nombre_corto`. Cuarto post de prueba:
  `t.me/cazagangasmx/10` (sin tocar los tres anteriores), análisis en 14.4 s
  (modelo ya caliente).
- Función nueva (anuncio de cupones generales, texto sin foto — ver
  `motor_cupones.js`): probada E2E real con el texto exacto que mandó Chino
  (5 cupones bancarios del Buen Fin). Primer intento salió con el link del
  ejemplo incluido (de otra persona, no nuestro) — se corrigió para que
  nunca lleve ningún link, se borró ese post de prueba (`deleteMessage`) y
  se republicó sin link. Al quitar el link también cambió el texto que veía
  el modelo, lo que destapó un bug real de parseo (el modelo confundía el
  título con la línea de requisitos) — reproducido y corregido fuera de n8n
  antes de volver a probar en el canal real. Post final:
  `t.me/cazagangasmx/14`, con los 5 códigos exactos y sin ningún link.

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
        ├── validar_mensaje.js            Lógica pura + self-check (node)
        ├── motor_caption.js              Plantilla de caption con datos del
        │                                  modelo de visión + self-check (node)
        └── motor_cupones.js              Plantilla HTML de cupones con
                                           datos del modelo de texto +
                                           self-check (node)
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
