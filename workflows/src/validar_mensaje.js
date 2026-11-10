// Lógica pura del bot "Afiliados - Publicar en Telegram". Testeable con
// `node workflows/src/validar_mensaje.js` por fuera de n8n. El Code node del
// workflow pega este archivo tal cual (funciones + bloque de invocación con
// $input/$env de abajo), mismo patrón que enviar_mensaje.json en lemut_n8n.
//
// Dos capas:
//   - procesarMensaje(): decide acceso (dueño/aprobado/solicitud de código/
//     comandos de admin) y delega a validarMensaje() cuando el remitente ya
//     tiene acceso. Devuelve 1 o 2 mensajes a mandar (solicitante + dueño).
//   - validarMensaje(): asume que el remitente YA tiene acceso; decide si
//     publica (foto + link válidos) o pide instrucciones.
const LIMITE_CAPTION = 1024; // límite real de Telegram para caption de foto (sendPhoto).
const LIMITE_TEXTO_CUPONES = 4096; // límite real de Telegram para sendMessage (anuncio de cupones).
// Dominios exactos, anclada (^...$) y probada token por token (ver extraerLink):
// evita que "evilmeli.la", "evilmercadolibre.com.mx" o un link ajeno con
// "meli.la" escondido en query string (otro.com/?u=meli.la/x) cuenten como
// link válido — sin anclar, la regex los matcheaba como substring.
const LINK_RE = /^(https?:\/\/)?(meli\.la\/\S+|(?:[\w-]+\.)*mercadolibre\.com\.mx\/\S*)$/i;

const CODIGO_VIGENCIA_MS = 10 * 60 * 1000; // 10 min.
const BLOQUEO_MS = 60 * 60 * 1000; // 1 h tras 3 intentos fallidos.
const MAX_INTENTOS = 3;

// Busca el link real dentro de un texto (caption de foto) probando cada
// palabra por separado (no el texto completo), para que el link pueda venir
// acompañado de texto propio ("Oferta <link>"). Devuelve el token exacto
// (lo necesita motor_caption.js para armar el caption nuevo con el link
// EXACTO como lo mandó el usuario, sin duplicar LINK_RE en otro Code node)
// y el texto restante sin el link.
function extraerLink(texto) {
  const tokens = (texto || '').split(/\s+/);
  const linkToken = tokens.find((token) => LINK_RE.test(token));
  if (!linkToken) return null;
  const textoSinLink = tokens.filter((t) => t !== linkToken).join(' ').trim();
  return { link: linkToken, textoSinLink };
}

// Un mensaje de texto (sin foto) "parece" un anuncio de cupones generales
// si menciona la palabra cupón/cupones o código — con o sin link: el link,
// si trae uno, casi siempre es de OTRA persona (su propio link de
// afiliado), nunca se publica (ver quitarLinks). La validación real de qué
// códigos son legítimos pasa después, en motor_cupones.js, contra el texto
// ya sin links.
const PARECE_CUPONES_RE = /cup[oó]n(es)?|c[oó]digo/i;

// Cualquier URL se quita del texto ANTES de mandarlo al LLM y antes de
// publicar el fallback — nunca se publica un link que no es nuestro.
// Genérica a propósito: no solo http(s):// ni solo meli.la/
// mercadolibre.com.mx, también cualquier dominio.tld(/ruta) SIN esquema
// (bit.ly/abc, t.me/canal, www.otro.com, x.com/algo...). El TLD final debe
// ser solo letras (2+) para no atrapar precios/decimales ("13,229.02").
const URL_GENERICA_RE = /https?:\/\/\S+|\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?:\/\S*)?\b/gi;
function quitarLinks(texto) {
  return (texto || '')
    .replace(URL_GENERICA_RE, '')
    .replace(/[ \t]+$/gm, '') // espacios colgantes al final de línea, tras quitar el link.
    .replace(/\n{3,}/g, '\n\n') // no más de una línea en blanco seguida.
    .trim();
}

// Ya con acceso confirmado (dueño o aprobado): decide publicar (foto+link),
// cupones (texto sin foto + link, ver motor_cupones.js) o pedir instrucciones.
function validarMensaje(update) {
  const message = update.message;
  if (!message || !message.from) return { accion: 'ignorar' };

  const chatId = message.chat.id;
  const foto = message.photo;
  const tieneFoto = Array.isArray(foto) && foto.length > 0;

  if (tieneFoto) {
    const caption = message.caption || '';
    const extraido = extraerLink(caption);
    if (!extraido) {
      return {
        accion: 'responder',
        chatId,
        texto:
          'Manda una foto del producto con el link de Mercado Libre ' +
          '(meli.la/... o mercadolibre.com.mx) en el caption.',
      };
    }
    if (caption.length > LIMITE_CAPTION) {
      return {
        accion: 'responder',
        chatId,
        texto:
          `El caption tiene ${caption.length} caracteres y el límite de Telegram ` +
          `es ${LIMITE_CAPTION}. Acórtalo sin tocar el link y vuelve a mandarlo.`,
      };
    }
    const fileId = foto[foto.length - 1].file_id;
    return {
      accion: 'publicar',
      chatId,
      fileId,
      caption,
      link: extraido.link,
      textoUsuario: extraido.textoSinLink,
    };
  }

  // Sin foto: un mensaje de texto que PAREZCA anuncio de cupones generales
  // (ej. cupones bancarios del Buen Fin) va por motor_cupones.js, no por
  // motor_caption.js — con o sin link (si trae uno, se quita: casi siempre
  // es el link de afiliado de OTRA persona, nunca se publica). Cualquier
  // otro texto sin foto sigue el camino de siempre: instrucciones.
  const texto = message.text || '';
  if (!PARECE_CUPONES_RE.test(texto)) {
    return {
      accion: 'responder',
      chatId,
      texto:
        'Manda una foto del producto con el link de Mercado Libre ' +
        '(meli.la/... o mercadolibre.com.mx) en el caption.',
    };
  }

  const textoSinLinks = quitarLinks(texto);
  if (textoSinLinks.length > LIMITE_TEXTO_CUPONES) {
    return {
      accion: 'responder',
      chatId,
      texto:
        `El mensaje tiene ${textoSinLinks.length} caracteres y el límite de Telegram ` +
        `es ${LIMITE_TEXTO_CUPONES}. Acórtalo y vuelve a mandarlo.`,
    };
  }

  return { accion: 'cupones', chatId, texto: textoSinLinks };
}

// Código de 4 dígitos con crypto.randomInt. require() dentro de la función
// (no al nivel del módulo) para que funcione igual en node llano (self-check)
// y en el Code node de n8n, que necesita NODE_FUNCTION_ALLOW_BUILTIN=crypto
// (ver docker-compose.yml) para permitir este require().
function generarCodigo() {
  return String(require('crypto').randomInt(10000)).padStart(4, '0');
}

function nombreDe(from) {
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Alguien';
}

function usernameDe(from) {
  return from.username ? `@${from.username}` : 'sin username';
}

// Dueño: "/usuarios" lista base (.env) + aprobados. Devuelve null si el
// texto no es ese comando (para que el caller pruebe el siguiente).
function comandoUsuarios(text, allowedIds, estado) {
  if (text !== '/usuarios') return null;
  const base = allowedIds.length ? allowedIds.join(', ') : '(ninguno)';
  const aprobados = estado.aprobados.length ? estado.aprobados.join(', ') : '(ninguno)';
  return `Usuarios con acceso:\nBase (.env): ${base}\nAprobados: ${aprobados}`;
}

// Dueño: "/quitar <id>". Devuelve el id (string) o null si no es ese comando.
function comandoQuitarId(text) {
  const m = /^\/quitar\s+(\d+)\s*$/.exec(text);
  return m ? m[1] : null;
}

function quitarUsuario(estado, id) {
  const estaba = estado.aprobados.includes(id);
  estado.aprobados = estado.aprobados.filter((x) => x !== id);
  return estaba ? `Quitado: ${id}.` : `${id} no estaba en la lista de aprobados.`;
}

// Cuenta un fallo en una ventana propia de 1h por fromId, independiente del
// código/pendiente: así /start (código nuevo) no resetea el conteo y no se
// esquiva el bloqueo de 3 intentos dejando vencer el código.
function registrarFallo(estado, fromId, now) {
  if (!estado.fallos) estado.fallos = {}; // staticData persistido antes de este campo.
  let f = estado.fallos[fromId];
  if (!f || now - f.desde > BLOQUEO_MS) {
    f = { cuenta: 0, desde: now };
    estado.fallos[fromId] = f;
  }
  f.cuenta += 1;
  return f.cuenta;
}

// Remitente sin acceso: bloqueo, /start (pide código), intento de código, o
// ignora cualquier otro mensaje (no reenvía fotos/links ajenos al dueño).
function procesarAcceso(estado, update, ownerId, now) {
  const message = update.message;
  const fromId = String(message.from.id);
  const chatId = message.chat.id;
  const text = (message.text || '').trim();

  const bloqueadoHasta = estado.bloqueados[fromId];
  if (bloqueadoHasta && bloqueadoHasta > now) {
    return { resultados: [{ accion: 'ignorar' }], estado }; // bloqueado: silencio total.
  }

  if (/^\/start\b/.test(text)) {
    const pendienteVigente = estado.pendientes[fromId];
    // Ya hay una solicitud vigente: no generar código nuevo ni volver a
    // avisarle al dueño (si no, /start repetido resetea los intentos y
    // esquiva el bloqueo de 3 fallos, y le llena el chat al dueño de avisos).
    if (pendienteVigente && pendienteVigente.vence >= now) {
      return {
        resultados: [{ accion: 'responder', chatId, texto: 'Ya pediste acceso; pídele el código a Richer.' }],
        estado,
      };
    }

    const codigo = generarCodigo();
    estado.pendientes[fromId] = { codigo, vence: now + CODIGO_VIGENCIA_MS };
    return {
      resultados: [
        { accion: 'responder', chatId, texto: 'Pide el código de acceso a Richer y escríbelo aquí.' },
        {
          accion: 'responder',
          chatId: ownerId,
          texto:
            `Solicitud de acceso: ${nombreDe(message.from)} (${usernameDe(message.from)}, id ${fromId}). ` +
            'Código: ' + codigo + ' (vence en 10 min). Pásaselo solo si lo conoces.',
        },
      ],
      estado,
    };
  }

  if (/^\d{4}$/.test(text)) {
    const pendiente = estado.pendientes[fromId];
    if (!pendiente) return { resultados: [{ accion: 'ignorar' }], estado };

    if (pendiente.vence < now) {
      delete estado.pendientes[fromId];
      return {
        resultados: [{ accion: 'responder', chatId, texto: 'Tu código venció. Escribe /start para pedir uno nuevo.' }],
        estado,
      };
    }

    if (text === pendiente.codigo) {
      delete estado.pendientes[fromId];
      estado.aprobados.push(fromId);
      return {
        resultados: [
          { accion: 'responder', chatId, texto: 'Acceso concedido.' },
          { accion: 'responder', chatId: ownerId, texto: `${nombreDe(message.from)} ya tiene acceso.` },
        ],
        estado,
      };
    }

    const fallos = registrarFallo(estado, fromId, now);
    if (fallos >= MAX_INTENTOS) {
      delete estado.pendientes[fromId];
      delete estado.fallos[fromId];
      estado.bloqueados[fromId] = now + BLOQUEO_MS;
      return {
        resultados: [
          { accion: 'responder', chatId, texto: 'Código incorrecto 3 veces. Espera 1 hora e intenta otra vez con /start.' },
        ],
        estado,
      };
    }
    return {
      resultados: [
        { accion: 'responder', chatId, texto: `Código incorrecto. Te quedan ${MAX_INTENTOS - fallos} intento(s).` },
      ],
      estado,
    };
  }

  return { resultados: [{ accion: 'ignorar' }], estado };
}

// Punto de entrada único: decide acceso y delega. `estado` es el staticData
// global del workflow (aprobados/pendientes/bloqueados); se muta in-place y
// también se devuelve para persistirlo.
function procesarMensaje(estado, update, allowedIds, ownerId, now) {
  const message = update.message;
  if (!message || !message.from) return { resultados: [{ accion: 'ignorar' }], estado };

  const fromId = String(message.from.id);
  const chatId = message.chat.id;
  const text = (message.text || '').trim();
  const esDueño = Boolean(ownerId) && fromId === String(ownerId);
  const aprobado = allowedIds.includes(fromId) || estado.aprobados.includes(fromId);
  const permitido = esDueño || aprobado;

  if (esDueño) {
    const listaUsuarios = comandoUsuarios(text, allowedIds, estado);
    if (listaUsuarios !== null) {
      return { resultados: [{ accion: 'responder', chatId, texto: listaUsuarios }], estado };
    }
    const idAQuitar = comandoQuitarId(text);
    if (idAQuitar !== null) {
      const texto = quitarUsuario(estado, idAQuitar);
      return { resultados: [{ accion: 'responder', chatId, texto }], estado };
    }
  }

  if (permitido) {
    return { resultados: [validarMensaje(update)], estado };
  }

  return procesarAcceso(estado, update, ownerId, now);
}

function estadoVacio() {
  return { aprobados: [], pendientes: {}, bloqueados: {}, fallos: {} };
}

if (typeof module !== 'undefined') {
  module.exports = {
    validarMensaje,
    procesarMensaje,
    estadoVacio,
    extraerLink,
    quitarLinks,
    LIMITE_CAPTION,
    LIMITE_TEXTO_CUPONES,
    LINK_RE,
  };
}

// --- Bloque de invocación dentro de n8n (Code node) ---
// Fuera de n8n, $input/$env no existen y este bloque no corre (ver demo()).
if (typeof $input !== 'undefined') {
  // El Webhook node (no el Telegram Trigger) entrega el update de Telegram
  // dentro de `.body`; headers/query quedan en hermanos de ese campo.
  const update = $input.first().json.body;

  const staticData = $getWorkflowStaticData('global');

  // Dedupe por update_id: Telegram puede reentregar el mismo update (retries
  // de red); sin esto se publicaría/respondería dos veces. Se guarda en
  // staticData global del workflow (persiste entre ejecuciones).
  const vistos = staticData.updateIdsVistos || (staticData.updateIdsVistos = []);
  if (update.update_id !== undefined) {
    if (vistos.includes(update.update_id)) {
      return [{ json: { accion: 'ignorar' } }];
    }
    vistos.push(update.update_id);
    if (vistos.length > 200) vistos.splice(0, vistos.length - 200); // solo últimos ~200.
  }

  const allowedIds = ($env.TELEGRAM_ALLOWED_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const accesos = staticData.accesos || (staticData.accesos = estadoVacio());
  const resultado = procesarMensaje(accesos, update, allowedIds, $env.TELEGRAM_OWNER_ID, Date.now());
  return resultado.resultados.map((r) => ({ json: r }));
}

// --- Self-check mínimo (node workflows/src/validar_mensaje.js) ---
function demo() {
  const assert = require('assert');
  const ALLOWED = ['111111111'];
  const OWNER = '222222222';
  const base = (extra) => ({ message: { from: { id: 111111111 }, chat: { id: 111111111 }, ...extra } });
  const msj = (fromId, extra) => ({ message: { from: { id: fromId, first_name: 'Ana' }, chat: { id: fromId }, ...extra } });

  // --- foto + link, ya con acceso (vía procesarMensaje, flujo real) ---

  // Permitido, foto + link meli.la → publicar.
  let r = procesarMensaje(
    estadoVacio(),
    base({ photo: [{ file_id: 'a' }, { file_id: 'b' }], caption: 'Oferta https://meli.la/1NqM8Rd' }),
    ALLOWED,
    OWNER,
    1000,
  );
  assert.strictEqual(r.resultados.length, 1);
  assert.strictEqual(r.resultados[0].accion, 'publicar');
  assert.strictEqual(r.resultados[0].fileId, 'b'); // la de mayor resolución es la última.
  assert.strictEqual(r.resultados[0].link, 'https://meli.la/1NqM8Rd');
  assert.strictEqual(r.resultados[0].textoUsuario, 'Oferta'); // el link se excluye del texto del usuario.

  // Caption = solo el link (sin texto propio) → textoUsuario vacío.
  r = procesarMensaje(
    estadoVacio(),
    base({ photo: [{ file_id: 'a' }], caption: 'https://meli.la/1NqM8Rd' }),
    ALLOWED,
    OWNER,
    1000,
  );
  assert.strictEqual(r.resultados[0].textoUsuario, '');

  // Permitido, foto + link mercadolibre.com.mx sin https → publicar.
  r = procesarMensaje(
    estadoVacio(),
    base({ photo: [{ file_id: 'x' }], caption: 'Ver articulo.mercadolibre.com.mx/MLM-123' }),
    ALLOWED,
    OWNER,
    1000,
  );
  assert.strictEqual(r.resultados[0].accion, 'publicar');

  // Permitido, sin foto, menciona "cupones" y NO trae ningún link →
  // cupones generales de todos modos (es la ruta nueva para
  // motor_cupones.js; ya no depende de que venga un link).
  r = procesarMensaje(estadoVacio(), base({ text: 'Nuevos cupones del Buen Fin, usa el código ABC123' }), ALLOWED, OWNER, 1000);
  assert.strictEqual(r.resultados[0].accion, 'cupones');
  assert.strictEqual(r.resultados[0].texto, 'Nuevos cupones del Buen Fin, usa el código ABC123');
  assert.ok(!('link' in r.resultados[0])); // ya no se usa ningún link en esta plantilla.

  // Permitido, sin foto, menciona "cupones" y SÍ trae un link (casi
  // siempre de OTRA persona, su link de afiliado) → se quita el link antes
  // de seguir; el texto resultante no debe traer "meli.la" ni "http".
  r = procesarMensaje(estadoVacio(), base({ text: 'Cupones nuevos https://meli.la/1FBrqqE más info' }), ALLOWED, OWNER, 1000);
  assert.strictEqual(r.resultados[0].accion, 'cupones');
  assert.ok(!r.resultados[0].texto.toLowerCase().includes('meli.la'));
  assert.ok(!r.resultados[0].texto.toLowerCase().includes('http'));
  assert.strictEqual(r.resultados[0].texto, 'Cupones nuevos  más info'); // doble espacio donde estaba el link, sin rarezas.

  // Permitido, sin foto, cupones con un link SIN esquema (bit.ly/t.me/
  // dominio.com, no solo http(s):// o meli.la/mercadolibre.com.mx) → igual
  // se quita (bug ALTA reportado por el revisor: antes solo quitaba
  // http(s):// o los dos dominios de Mercado Libre).
  r = procesarMensaje(estadoVacio(), base({ text: 'Cupones: código ABC123, info en bit.ly/promo40' }), ALLOWED, OWNER, 1000);
  assert.strictEqual(r.resultados[0].accion, 'cupones');
  assert.ok(!r.resultados[0].texto.includes('bit.ly'));

  // Permitido, sin foto, sin la palabra cupón/código y sin foto →
  // instrucciones (no todo texto cuenta como cupones).
  r = procesarMensaje(estadoVacio(), base({ text: 'hola, alguna novedad?' }), ALLOWED, OWNER, 1000);
  assert.strictEqual(r.resultados[0].accion, 'responder');

  // Permitido, mensaje de cupones de más de 4096 caracteres → rechaza (no trunca).
  r = procesarMensaje(estadoVacio(), base({ text: 'Cupones: ' + 'a'.repeat(4090) }), ALLOWED, OWNER, 1000);
  assert.strictEqual(r.resultados[0].accion, 'responder');
  assert.ok(r.resultados[0].texto.includes('4096'));

  // Permitido, con foto pero sin link → instrucciones.
  r = procesarMensaje(estadoVacio(), base({ photo: [{ file_id: 'a' }], caption: 'sin link aquí' }), ALLOWED, OWNER, 1000);
  assert.strictEqual(r.resultados[0].accion, 'responder');

  // Permitido, caption de más de 1024 → rechaza (no trunca).
  r = procesarMensaje(
    estadoVacio(),
    base({ photo: [{ file_id: 'a' }], caption: 'https://meli.la/x ' + 'a'.repeat(1030) }),
    ALLOWED,
    OWNER,
    1000,
  );
  assert.strictEqual(r.resultados[0].accion, 'responder');
  assert.ok(r.resultados[0].texto.includes('1024'));

  // Update sin message (ej. edited_message si algún día se suscribe) → ignorar.
  r = procesarMensaje(estadoVacio(), {}, ALLOWED, OWNER, 1000);
  assert.strictEqual(r.resultados[0].accion, 'ignorar');

  // Dominio falsificado "evilmeli.la" (no es meli.la) → no cuenta como link.
  r = procesarMensaje(estadoVacio(), base({ photo: [{ file_id: 'a' }], caption: 'Oferta evilmeli.la/producto' }), ALLOWED, OWNER, 1000);
  assert.strictEqual(r.resultados[0].accion, 'responder');

  // Dominio falsificado "evilmercadolibre.com.mx" → no cuenta como link.
  r = procesarMensaje(estadoVacio(), base({ photo: [{ file_id: 'a' }], caption: 'Ver evilmercadolibre.com.mx/MLM-1' }), ALLOWED, OWNER, 1000);
  assert.strictEqual(r.resultados[0].accion, 'responder');

  // Link ajeno con "meli.la" escondido en query string → el host real es
  // otro.com, no cuenta como link válido.
  r = procesarMensaje(estadoVacio(), base({ photo: [{ file_id: 'a' }], caption: 'https://otro.com/?u=meli.la/x' }), ALLOWED, OWNER, 1000);
  assert.strictEqual(r.resultados[0].accion, 'responder');

  // --- alta de usuarios por código ---

  // No permitido + /start → pide código al solicitante y manda el código al dueño.
  let estado = estadoVacio();
  r = procesarMensaje(estado, msj(999, { text: '/start' }), ALLOWED, OWNER, 1000);
  assert.strictEqual(r.resultados.length, 2);
  assert.strictEqual(r.resultados[0].chatId, 999);
  assert.ok(r.resultados[0].texto.includes('código'));
  assert.strictEqual(r.resultados[1].chatId, OWNER);
  assert.ok(r.resultados[1].texto.includes('Ana') && r.resultados[1].texto.includes('999'));
  const codigoReal = estado.pendientes['999'].codigo;

  // No permitido + cualquier otra cosa (no /start, no código) → se ignora.
  r = procesarMensaje(estadoVacio(), msj(999, { text: 'hola' }), ALLOWED, OWNER, 1000);
  assert.strictEqual(r.resultados[0].accion, 'ignorar');

  // Código correcto antes de vencer → aprobado; avisa a ambos.
  r = procesarMensaje(estado, msj(999, { text: codigoReal }), ALLOWED, OWNER, 1500);
  assert.strictEqual(r.resultados.length, 2);
  assert.ok(r.resultados[0].texto.includes('concedido'));
  assert.strictEqual(r.resultados[1].chatId, OWNER);
  assert.ok(r.resultados[1].texto.includes('Ana'));
  assert.ok(estado.aprobados.includes('999'));

  // Código incorrecto (1er intento) → avisa, no bloquea.
  estado = estadoVacio();
  estado.pendientes['999'] = { codigo: '1234', vence: 100000 };
  r = procesarMensaje(estado, msj(999, { text: '0000' }), ALLOWED, OWNER, 1000);
  assert.strictEqual(r.resultados[0].accion, 'responder');
  assert.ok(r.resultados[0].texto.includes('incorrecto'));
  assert.strictEqual(estado.fallos['999'].cuenta, 1);

  // 3 fallos → bloqueado 1h; mientras dura, hasta el código correcto se ignora.
  estado = estadoVacio();
  estado.pendientes['999'] = { codigo: '1234', vence: 100000 };
  estado.fallos['999'] = { cuenta: 2, desde: 1000 };
  r = procesarMensaje(estado, msj(999, { text: '0000' }), ALLOWED, OWNER, 1000);
  assert.ok(r.resultados[0].texto.includes('1 hora'));
  assert.strictEqual(estado.bloqueados['999'], 1000 + 60 * 60 * 1000);
  r = procesarMensaje(estado, msj(999, { text: '1234' }), ALLOWED, OWNER, 1000 + 10);
  assert.strictEqual(r.resultados[0].accion, 'ignorar');

  // /start con una solicitud YA vigente → no genera código nuevo ni avisa
  // otra vez al dueño, y el contador de fallos (ventana propia, separado
  // del código) tampoco se resetea.
  estado = estadoVacio();
  estado.pendientes['999'] = { codigo: '1234', vence: 100000 };
  estado.fallos['999'] = { cuenta: 2, desde: 1000 };
  r = procesarMensaje(estado, msj(999, { text: '/start' }), ALLOWED, OWNER, 1000);
  assert.strictEqual(r.resultados.length, 1);
  assert.strictEqual(r.resultados[0].chatId, 999);
  assert.strictEqual(estado.pendientes['999'].codigo, '1234');
  assert.strictEqual(estado.fallos['999'].cuenta, 2);
  // Un fallo más SÍ debe bloquearlo (no se esquivó el contador).
  r = procesarMensaje(estado, msj(999, { text: '0000' }), ALLOWED, OWNER, 1000);
  assert.ok(r.resultados[0].texto.includes('1 hora'));
  assert.ok(estado.bloqueados['999']);

  // El mismo caso pero dejando VENCER el código entre fallo y fallo (no solo
  // "vigente"): hasta 20 ciclos de /start + 2 intentos incorrectos — el
  // contador de fallos tiene ventana propia de 1h, independiente del
  // código, así que bloquea aunque cada ciclo pida un código nuevo (antes,
  // /start reseteaba el conteo y el bloqueo se esquivaba indefinidamente).
  estado = estadoVacio();
  let momento = 1000;
  let ciclos = 0;
  for (; ciclos < 20 && !estado.bloqueados['999']; ciclos++) {
    if (estado.pendientes['999']) estado.pendientes['999'].vence = momento - 1; // forzar vencido
    procesarMensaje(estado, msj(999, { text: '/start' }), ALLOWED, OWNER, momento);
    for (let intento = 0; intento < 2 && estado.pendientes['999'] && !estado.bloqueados['999']; intento++) {
      const pend = estado.pendientes['999'];
      const incorrecto = pend.codigo === '0000' ? '1111' : '0000';
      procesarMensaje(estado, msj(999, { text: incorrecto }), ALLOWED, OWNER, momento + 1);
    }
    momento += 3;
  }
  assert.ok(estado.bloqueados['999'], 'debió bloquear antes de 20 ciclos');
  assert.ok(ciclos < 20);

  // Código vencido → no aprueba, pide reiniciar con /start.
  estado = estadoVacio();
  estado.pendientes['999'] = { codigo: '1234', vence: 500 };
  r = procesarMensaje(estado, msj(999, { text: '1234' }), ALLOWED, OWNER, 1000);
  assert.ok(r.resultados[0].texto.includes('venció'));
  assert.ok(!estado.pendientes['999']);
  assert.ok(!estado.aprobados.includes('999'));

  // Dueño: /quitar <id> saca a alguien de aprobados.
  estado = estadoVacio();
  estado.aprobados.push('777');
  r = procesarMensaje(estado, msj(Number(OWNER), { text: '/quitar 777' }), ALLOWED, OWNER, 1000);
  assert.ok(r.resultados[0].texto.includes('Quitado'));
  assert.ok(!estado.aprobados.includes('777'));

  // No-dueño usando /quitar → se ignora, no se quita a nadie.
  estado = estadoVacio();
  estado.aprobados.push('777');
  r = procesarMensaje(estado, msj(999, { text: '/quitar 777' }), ALLOWED, OWNER, 1000);
  assert.strictEqual(r.resultados[0].accion, 'ignorar');
  assert.ok(estado.aprobados.includes('777'));

  console.log('OK: validar_mensaje.js — 28 casos pasaron');
}

if (typeof require !== 'undefined' && require.main === module) {
  demo();
}
