// Lógica pura del nodo "Armar cupones" del workflow "Afiliados - Publicar en
// Telegram". Testeable con `node workflows/src/motor_cupones.js` por fuera
// de n8n. El Code node del workflow pega este archivo tal cual, mismo
// patrón que motor_caption.js.
//
// Ruta nueva: un remitente con acceso manda un mensaje de TEXTO (sin foto)
// anunciando cupones generales (ej. cupones bancarios del Buen Fin) -- no
// un producto puntual, por eso es un motor aparte de motor_caption.js
// (campos y plantilla distintos). NUNCA lleva link: el link que a veces
// trae el anuncio casi siempre es el link de afiliado de OTRA persona (no
// nuestro) -- se quita en validar_mensaje.js antes de llegar aquí, y
// quitarLinks() se vuelve a aplicar aquí (defensa en profundidad) por si
// el modelo repitiera un link dentro de algún campo.
//
// Entra aquí DESPUÉS de "Analizar cupones" (HTTP Request a Ollama local,
// modelo de TEXTO qwen2.5:3b-instruct -- no hace falta visión, es texto, no
// una foto). Arma el anuncio en HTML real (parse_mode HTML en el
// sendMessage del nodo "Publicar cupones") con <b> y <code> para que los
// códigos se copien con un toque.
//
// Regla dura de negocio (dinero): los MONTOS y los CÓDIGOS de cupón se
// VALIDAN en código contra el texto ORIGINAL -- si un código no aparece
// literal en el texto, ese cupón se descarta completo (nunca se publica un
// código inventado); un monto/porcentaje que no se pueda verificar se omite
// (no se inventa, pero no tira todo el cupón).
//
// Regla dura del negocio (igual que motor_caption.js): si el modelo falla,
// tarda, el JSON es inválido, o no queda ningún cupón válido tras la
// validación, fallback = se publica el TEXTO ORIGINAL que mandó el
// afiliado, convirtiendo *negritas* de WhatsApp a <b> (mismo parse_mode
// HTML, para que al menos esas negritas se vean bien en vez de asteriscos
// sueltos).

const LIMITE_TEXTO_CUPONES = 4096; // límite real de Telegram para sendMessage.

function escaparHTML(texto) {
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Defensa en profundidad: aunque validar_mensaje.js ya quita los links
// ANTES de mandar el texto al modelo, un campo que el modelo devuelva
// (titulo, emisor, condiciones...) nunca debería poder colar un link —
// nunca se publica un link que no sea nuestro. Genérica a propósito (no
// solo http(s):// ni solo meli.la/mercadolibre.com.mx): cualquier token
// "dominio.tld" o "dominio.tld/ruta" sin esquema también cuenta como link
// (bit.ly/abc, t.me/canal, www.otro.com, x.com/algo...) — el TLD final debe
// ser solo letras (2+) para no atrapar precios/decimales ("13,229.02").
// Misma regex que validar_mensaje.js (duplicada a propósito: cada Code node
// de n8n es autocontenido, no puede hacer require() de otro).
const URL_GENERICA_RE = /https?:\/\/\S+|\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?:\/\S*)?\b/gi;
function quitarLinks(texto) {
  return String(texto || '')
    .replace(URL_GENERICA_RE, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// *texto* (WhatsApp) -> <b>texto</b>. Se escapa ANTES de insertar las
// etiquetas: si no, un "&"/"<" dentro del texto en negritas rompería el
// HTML que arma Telegram con parse_mode HTML.
function convertirNegritasWhatsapp(texto) {
  const escapado = escaparHTML(texto);
  return escapado.replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
}

function limpiarRespuesta(texto) {
  if (typeof texto !== 'string') return '';
  return texto.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
}

function parsearDatos(texto) {
  const limpio = limpiarRespuesta(texto);
  if (!limpio) return null;
  try {
    const datos = JSON.parse(limpio);
    if (!datos || typeof datos !== 'object' || Array.isArray(datos)) return null;
    return datos;
  } catch (e) {
    return null;
  }
}

function parsearMonto(valor) {
  if (valor === null || valor === undefined) return null;
  const limpio = String(valor).replace(/[^\d.,]/g, '').replace(/,/g, '');
  if (!limpio) return null;
  const n = parseFloat(limpio);
  return Number.isFinite(n) ? n : null;
}

function formatearMonto(n) {
  const esEntero = Number.isInteger(n);
  const [entero, decimales] = n.toFixed(esEntero ? 0 : 2).split('.');
  const conComas = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decimales ? `${conComas}.${decimales}` : conComas;
}

// Todos los números LITERALES del texto (ej. "$4,500", "10%", "1,000.50")
// a un Set de valores exactos ya parseados -- antes numeroVerificado
// comparaba por SUBSTRING sobre el texto compactado, así que un monto
// falso que fuera substring de uno real pasaba validación sin ser el
// mismo número (ej. porcentaje 50 pasaba por "$500" en el texto, 450
// pasaba por "4500" -- bug MEDIA reportado por el revisor).
const NUMERO_LITERAL_RE = /\d[\d,]*(?:\.\d+)?/g;
function numerosLiteralesDe(textoOriginal) {
  const set = new Set();
  const encontrados = String(textoOriginal).match(NUMERO_LITERAL_RE) || [];
  for (const m of encontrados) {
    const n = parseFloat(m.replace(/,/g, ''));
    if (Number.isFinite(n)) set.add(n);
  }
  return set;
}

// Un número (monto o porcentaje) se considera verificado si su valor
// EXACTO (no un substring suyo) aparece como número literal en el texto
// original -- evita publicar un monto que el modelo haya inventado.
function numeroVerificado(valor, textoOriginal) {
  if (valor === null || valor === undefined) return false;
  const n = parsearMonto(valor);
  if (n === null) return false;
  return numerosLiteralesDe(textoOriginal).has(n);
}

function iconoRequisito(texto) {
  const t = texto.toLowerCase();
  if (t.includes('exclusiv')) return '⭐';
  if (t.includes('combina')) return '✅';
  return 'ℹ️';
}

function iconoCondicion(texto) {
  const t = texto.toLowerCase();
  if (/\bsolo\b|\bunicamente\b|\búnicamente\b|exclusiv/.test(t)) return '⚠️';
  if (/pago|tarjeta|efectivo|exhibici/.test(t)) return '💳';
  return 'ℹ️';
}

// Solo string/number se tratan como texto; cualquier otro tipo (objeto,
// array...) que el LLM devuelva en un campo de texto se descarta como ''
// en vez de colarse via String() como "[object Object]" (reportado por el
// revisor en la ronda de ajustes finos).
function aTextoSeguro(valor) {
  if (typeof valor === 'string') return valor;
  if (typeof valor === 'number' && Number.isFinite(valor)) return String(valor);
  return '';
}

// NO basta con límite de palabra (\b): "BBVA" es un \b-token real pero
// aparece como nombre del banco en "*BBVA (10%)*", no como código -- con
// solo \b, ese texto validaría un cupón alucinado con codigo:"BBVA" (bug
// detectado en revisión: \b no distingue "aparece como palabra" de
// "aparece como código"). Un código real SIEMPRE va solo en su propia
// línea (ej. "🎟️ CREDITO40", con emoji/símbolos antes pero nada más en la
// línea) o justo después de la palabra "código"/"cupón" (forma en línea,
// ej. "usa el código ABC123" -- ver validar_mensaje.js demo). Cualquier
// otra posición (substring, o suelto en medio de una oración) se rechaza.
// El código en sí NUNCA se compara sin distinguir mayúsculas/minúsculas:
// el código publicado es el que mandó el LLM (c.codigo), así que debe
// coincidir EXACTO con el texto real, letra por letra -- antes
// trasPalabraClave llevaba /i en TODO el patrón y dejaba pasar "abc123"
// cuando el texto decía "ABC123" (bug MEDIA reportado por el revisor). La
// palabra "código" sí acepta cualquier casing (no es el dato sensible).
function apareceComoCodigo(codigo, textoOriginal) {
  const escapado = codigo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const soloEnLinea = new RegExp(`^[^\\w\\n]*${escapado}[^\\w\\n]*$`, 'm');
  const trasPalabraClave = new RegExp(`[Cc][OoÓó][Dd][Ii][Gg][Oo]\\s*:?\\s*${escapado}\\b`);
  return soloEnLinea.test(textoOriginal) || trasPalabraClave.test(textoOriginal);
}

// Descarta cupones cuyo código no aparece, literal y en posición de
// código (ver apareceComoCodigo), en el texto original (alucinación).
// Devuelve null si se descarta. Los montos se guardan ya como NÚMERO
// (parsearMonto), nunca el string crudo del LLM: así nada de lo que
// escriba el modelo en porcentaje/compra_minima/descuento_maximo puede
// llegar sin sanear al HTML final (ver bloqueCupon).
function validarCupon(c, textoOriginal) {
  if (!c || !c.codigo) return null;
  const codigo = aTextoSeguro(c.codigo).trim();
  if (!codigo || !apareceComoCodigo(codigo, textoOriginal)) return null;
  return {
    emisor: quitarLinks(aTextoSeguro(c.emisor).trim()) || null,
    porcentaje: numeroVerificado(c.porcentaje, textoOriginal) ? parsearMonto(c.porcentaje) : null,
    codigo,
    compra_minima: numeroVerificado(c.compra_minima, textoOriginal) ? parsearMonto(c.compra_minima) : null,
    descuento_maximo: numeroVerificado(c.descuento_maximo, textoOriginal) ? parsearMonto(c.descuento_maximo) : null,
    condiciones: Array.isArray(c.condiciones)
      ? c.condiciones.filter((x) => typeof x === 'string' && x.trim()).map((x) => quitarLinks(x))
      : [],
  };
}

function bloqueCupon(c) {
  const emisor = c.emisor ? escaparHTML(c.emisor) : 'Cupón';
  // c.porcentaje ya es un number (o null) gracias a validarCupon; se
  // escapa igual (String + escaparHTML) como defensa en profundidad —
  // antes se interpolaba crudo lo que mandara el LLM (bug ALTA reportado
  // por el revisor: un LLM podía meter "<a href=evil>40</a>" y, con
  // parse_mode HTML, Telegram lo renderizaba como link/etiqueta real).
  const pct = c.porcentaje !== null ? ` — ${escaparHTML(String(c.porcentaje))}%` : '';
  const lineas = [`💳 <b>${emisor}${pct}</b>`, `Código: <code>${escaparHTML(c.codigo)}</code>`];

  const minTope = [];
  if (c.compra_minima !== null) {
    const n = parsearMonto(c.compra_minima);
    if (n !== null) minTope.push(`Mín. $${formatearMonto(n)}`);
  }
  if (c.descuento_maximo !== null) {
    const n = parsearMonto(c.descuento_maximo);
    if (n !== null) minTope.push(`Tope $${formatearMonto(n)}`);
  }
  if (minTope.length) lineas.push(minTope.join(' · '));

  for (const cond of c.condiciones) {
    lineas.push(`${iconoCondicion(cond)} ${escaparHTML(cond)}`);
  }
  return lineas.join('\n');
}

function fallback(motivo, original) {
  // fallback() es el último recurso: nunca debe tirar, ni siquiera si
  // original.texto es un valor rarísimo cuyo toString() truene (lo que
  // armarCupones captura en su try/catch justo antes de llamar aquí).
  let texto = '';
  try {
    texto = quitarLinks(String((original && original.texto) || ''));
  } catch (e) {
    texto = '';
  }
  return { caption: convertirNegritasWhatsapp(texto), fallback: true, motivo };
}

// original: { texto } -- viene de "Validar mensaje" (accion='cupones'); ya
// sin links (ver validar_mensaje.js). respuestaModelo: el texto crudo que
// mandó el LLM (o null si falló/tardó). Nunca se arma una línea de link:
// este anuncio de cupones generales no apunta a ningún producto puntual.
// Todo el cuerpo va en try/catch: el LLM puede devolver tipos inesperados
// (un número o un array donde se esperaba string) y aunque se normalizan
// con String()/Array.isArray() en cada campo, cualquier caso no previsto
// cae a fallback en vez de tirar el Code node completo (reportado MEDIA
// por el revisor).
function armarCupones(respuestaModelo, original) {
  try {
    if (!original || !original.texto) return fallback('sin_texto_original', original || {});

    const datos = parsearDatos(respuestaModelo);
    if (!datos) return fallback('json_invalido', original);

    const titulo = quitarLinks(aTextoSeguro(datos.titulo).trim());
    if (!titulo) return fallback('sin_titulo', original);

    const cuponesValidos = Array.isArray(datos.cupones)
      ? datos.cupones.map((c) => validarCupon(c, original.texto)).filter(Boolean)
      : [];
    if (!cuponesValidos.length) return fallback('sin_cupones_validos', original);

    const requisitos = Array.isArray(datos.requisito_general)
      ? datos.requisito_general.filter((x) => typeof x === 'string' && x.trim()).map((x) => quitarLinks(x))
      : [];
    const lineaRequisitos = requisitos.length
      ? requisitos.map((r) => `${iconoRequisito(r)} ${escaparHTML(r)}`).join(' · ')
      : null;

    const encabezado = [`🎟️ <b>${escaparHTML(titulo)}</b>`, lineaRequisitos].filter(Boolean).join('\n');

    const partes = [encabezado, ...cuponesValidos.map(bloqueCupon)];
    const caption = partes.join('\n\n');

    if (caption.length > LIMITE_TEXTO_CUPONES) return fallback('texto_muy_largo', original);

    return { caption, fallback: false, motivo: null };
  } catch (e) {
    return fallback('error_inesperado', original || {});
  }
}

if (typeof module !== 'undefined') {
  module.exports = {
    armarCupones,
    parsearDatos,
    convertirNegritasWhatsapp,
    escaparHTML,
    quitarLinks,
    LIMITE_TEXTO_CUPONES,
  };
}

// --- Bloque de invocación dentro de n8n (Code node "Armar cupones") ---
// Fuera de n8n, $input/$env no existen y este bloque no corre (ver demo()).
if (typeof $input !== 'undefined') {
  // Salida de "Analizar cupones" (HTTP Request, formato OpenAI-compatible
  // de Ollama): éxito → { choices: [{ message: { content: "<json>" } }] };
  // si falló o tardó, "onError: continueRegularOutput" deja un objeto con
  // `.error` en vez de `.choices` (no revienta el workflow).
  const respuesta = $input.first().json;
  const textoModelo = respuesta && respuesta.choices && respuesta.choices[0]
    ? respuesta.choices[0].message?.content
    : null;

  const original = $('Validar mensaje').first().json; // { chatId, texto } (ya sin links).
  // try/catch extra (defensa en profundidad): armarCupones ya no debería
  // tirar nunca, pero si algo fuera de su try/catch interno fallara (ej.
  // original con forma rara), igual cae a fallback en vez de reventar el nodo.
  let resultado;
  try {
    resultado = armarCupones(textoModelo, original);
  } catch (e) {
    resultado = { caption: String(original.texto || ''), fallback: true, motivo: 'error_inesperado_nodo' };
  }

  return [{
    json: {
      accion: 'cupones',
      chatId: original.chatId,
      caption: resultado.caption,
      fallback: resultado.fallback,
      motivo: resultado.motivo,
    },
  }];
}

// --- Self-check mínimo (node workflows/src/motor_cupones.js) ---
// Texto de ejemplo REAL (el que mandó Chino) -- repo público, pero es un
// anuncio de cupones bancarios ya público del propio Mercado Libre, sin
// datos personales.
const TEXTO_EJEMPLO =
  '🎟️ *NUEVOS CUPONES BANCARIOS PRE-BUEN FIN* \n\n' +
  '⭐️ *Exclusivos para miembros MELI+*\n\n' +
  '✅ *COMBINABLES CON CUPONES DEL DIA*\n\n' +
  '🔵 *Mercado Pago T. Crédito (40%)*\n' +
  '🎟️ CREDITO40\n' +
  '✅ Compra mínima $300, Descuento máximo $500\n' +
  '⚠️ *SOLO APLICA SI ES TU PRIMERA COMPRA CON LA TARJETA*\n\n' +
  '🔵 *BBVA (10%)*\n' +
  '🎟️ BBVAPBF\n' +
  '✅ Compra mínima $4,500, Descuento máximo $800\n' +
  '💳 Pago a una sola exhibición. \n\n' +
  '🔴 *Santander (10%)*\n' +
  '🎟️ SANTPBF\n' +
  '✅ Compra mínima $3,000, Descuento máximo $1,000\n' +
  '💳 Pago a una sola exhibición con Tarjeta de Crédito\n\n' +
  '🟢 *Afirme (10%)*\n' +
  '🎟️ AFRMPBF\n' +
  '✅ Compra mínima $3,000, Descuento máximo $1,000\n' +
  '💳 Pago a una sola exhibición con Tarjeta de Crédito\n\n' +
  '🟠 *Oxxo (10%)*\n' +
  '🎟️ OXXOPBF\n' +
  '✅ Compra mínima $1,500, Descuento máximo $750\n' +
  '💳 Pago con efectivo en OXXO\n\n' +
  '🔗 Detalles completos en ML: https://meli.la/1FBrqqE';

// JSON que, en teoría, debería devolver el modelo al leer TEXTO_EJEMPLO
// (datos sintéticos de prueba, pero tomados del texto real de arriba).
const JSON_EJEMPLO = {
  titulo: 'NUEVOS CUPONES BANCARIOS PRE-BUEN FIN',
  requisito_general: ['Exclusivos para miembros MELI+', 'Combinables con cupones del día'],
  cupones: [
    {
      emisor: 'Mercado Pago T. Crédito', porcentaje: 40, codigo: 'CREDITO40',
      compra_minima: 300, descuento_maximo: 500,
      condiciones: ['Solo aplica si es tu primera compra con la tarjeta'],
    },
    {
      emisor: 'BBVA', porcentaje: 10, codigo: 'BBVAPBF',
      compra_minima: 4500, descuento_maximo: 800,
      condiciones: ['Pago a una sola exhibición'],
    },
    {
      emisor: 'Santander', porcentaje: 10, codigo: 'SANTPBF',
      compra_minima: 3000, descuento_maximo: 1000,
      condiciones: ['Pago a una sola exhibición con Tarjeta de Crédito'],
    },
    {
      emisor: 'Afirme', porcentaje: 10, codigo: 'AFRMPBF',
      compra_minima: 3000, descuento_maximo: 1000,
      condiciones: ['Pago a una sola exhibición con Tarjeta de Crédito'],
    },
    {
      emisor: 'Oxxo', porcentaje: 10, codigo: 'OXXOPBF',
      compra_minima: 1500, descuento_maximo: 750,
      condiciones: ['Pago con efectivo en OXXO'],
    },
  ],
};

if (typeof module !== 'undefined') {
  module.exports.TEXTO_EJEMPLO = TEXTO_EJEMPLO;
  module.exports.JSON_EJEMPLO = JSON_EJEMPLO;
}

// En producción, validar_mensaje.js ya quita el link ANTES de que el texto
// llegue a este motor (ver quitarLinks allá) -- las pruebas "normales" usan
// el texto ya así, tal como llegaría de verdad.
const TEXTO_EJEMPLO_SIN_LINK = quitarLinks(TEXTO_EJEMPLO);

function demo() {
  const assert = require('assert');
  const original = (extra) => ({
    texto: TEXTO_EJEMPLO_SIN_LINK,
    ...extra,
  });

  // Ejemplo real completo: 5 cupones, códigos exactos.
  let r = armarCupones(JSON.stringify(JSON_EJEMPLO), original());
  assert.strictEqual(r.fallback, false);
  assert.ok(r.caption.includes('🎟️ <b>NUEVOS CUPONES BANCARIOS PRE-BUEN FIN</b>'));
  assert.ok(r.caption.includes('⭐ Exclusivos para miembros MELI+ · ✅ Combinables con cupones del día'));
  for (const codigo of ['CREDITO40', 'BBVAPBF', 'SANTPBF', 'AFRMPBF', 'OXXOPBF']) {
    assert.ok(r.caption.includes(`<code>${codigo}</code>`), `falta ${codigo}`);
  }
  assert.ok(r.caption.includes('💳 <b>Mercado Pago T. Crédito — 40%</b>'));
  assert.ok(r.caption.includes('Mín. $300 · Tope $500'));
  assert.ok(r.caption.includes('⚠️ Solo aplica si es tu primera compra con la tarjeta'));
  assert.ok(r.caption.includes('💳 <b>BBVA — 10%</b>'));
  assert.ok(r.caption.includes('Mín. $4,500 · Tope $800'));
  assert.ok(r.caption.includes('💳 Pago a una sola exhibición'));
  assert.ok(r.caption.endsWith('💳 Pago con efectivo en OXXO')); // sin línea de link: nunca se publica ningún link.
  assert.ok(!r.caption.toLowerCase().includes('meli.la'));
  assert.ok(!r.caption.toLowerCase().includes('http'));
  assert.ok(r.caption.length <= LIMITE_TEXTO_CUPONES);

  // Caso explícito pedido: el texto SÍ trae el link ajeno (defensa en
  // profundidad, por si algo no lo quitó antes) → el post final no debe
  // contener "meli.la" ni "http" en ningún lado.
  r = armarCupones(JSON.stringify(JSON_EJEMPLO), original({ texto: TEXTO_EJEMPLO }));
  assert.strictEqual(r.fallback, false);
  assert.ok(!r.caption.toLowerCase().includes('meli.la'));
  assert.ok(!r.caption.toLowerCase().includes('http'));

  // Código inventado (alucinado) → se descarta SOLO ese cupón, los demás
  // se publican igual.
  const conInventado = JSON.parse(JSON.stringify(JSON_EJEMPLO));
  conInventado.cupones.push({
    emisor: 'Banco Fantasma', porcentaje: 50, codigo: 'NOEXISTE99',
    compra_minima: 100, descuento_maximo: 100, condiciones: [],
  });
  r = armarCupones(JSON.stringify(conInventado), original());
  assert.strictEqual(r.fallback, false);
  assert.ok(!r.caption.includes('NOEXISTE99'));
  assert.ok(!r.caption.includes('Banco Fantasma'));
  assert.ok(r.caption.includes('CREDITO40')); // los reales siguen.

  // Monto inventado (no aparece en el texto original) → se omite SOLO ese
  // dato, no se descarta el cupón ni se inventa un número distinto.
  const conMontoFalso = JSON.parse(JSON.stringify(JSON_EJEMPLO));
  conMontoFalso.cupones[0].descuento_maximo = 999999; // no está en el texto.
  r = armarCupones(JSON.stringify(conMontoFalso), original());
  assert.ok(r.caption.includes('<code>CREDITO40</code>'));
  assert.ok(!r.caption.includes('999,999'));
  assert.ok(!r.caption.includes('Tope $999')); // se omitió el tope, no se inventó uno nuevo.

  // Monto/porcentaje falso que es SUBSTRING de uno real (ej. 50 dentro de
  // "$500", 450 dentro de "4500") → antes pasaba por comparar substring
  // sobre el texto compactado; ahora se exige que el número exacto esté en
  // el Set de números literales del texto, así que se omite igual que
  // cualquier otro monto inventado (bug MEDIA reportado por el revisor).
  const conMontoSubstring = JSON.parse(JSON.stringify(JSON_EJEMPLO));
  conMontoSubstring.cupones[1].porcentaje = 50; // BBVA es 10%, no 50 ("$500" lo contiene como substring).
  conMontoSubstring.cupones[1].compra_minima = 450; // BBVA es $4,500 ("4500" lo contiene como substring).
  r = armarCupones(JSON.stringify(conMontoSubstring), original());
  assert.strictEqual(r.fallback, false);
  assert.ok(r.caption.includes('<code>BBVAPBF</code>')); // el cupón sigue, solo se omiten los datos falsos.
  assert.ok(!r.caption.includes('50%'));
  assert.ok(!r.caption.includes('Mín. $450'));
  assert.ok(r.caption.includes('💳 <b>BBVA</b>\nCódigo: <code>BBVAPBF</code>\nTope $800')); // sin "— N%" ni "Mín.", solo Tope (real).

  // El código publicado debe coincidir EXACTO (mayúsculas/minúsculas) con
  // el texto real -- si el LLM manda el código con otro casing ("abc123"
  // cuando el texto dice "ABC123"), se descarta: antes trasPalabraClave
  // comparaba con /i y lo dejaba pasar (bug MEDIA reportado por el
  // revisor). La palabra "código" en sí sí acepta cualquier casing.
  const textoInline = 'Cupones del día en Tienda Demo: usa el código ABC123 y ahorra.';
  r = armarCupones(JSON.stringify({
    titulo: 'Cupones del día',
    cupones: [{ emisor: 'Tienda Demo', codigo: 'abc123', condiciones: [] }],
  }), original({ texto: textoInline }));
  assert.strictEqual(r.fallback, true);
  assert.strictEqual(r.motivo, 'sin_cupones_validos'); // "abc123" != "ABC123" letra por letra.

  r = armarCupones(JSON.stringify({
    titulo: 'Cupones del día',
    cupones: [{ emisor: 'Tienda Demo', codigo: 'ABC123', condiciones: [] }],
  }), original({ texto: textoInline }));
  assert.strictEqual(r.fallback, false);
  assert.ok(r.caption.includes('<code>ABC123</code>')); // casing exacto sí valida.

  // Código alucinado que SÍ es una palabra suelta real del texto pero NO
  // está en posición de código ("BBVA" es el nombre del banco en
  // "*BBVA (10%)*", no un código — \b sola no bastaba, bug detectado en
  // revisión), y códigos por SUBSTRING ("CREDITO4" dentro de "CREDITO40",
  // "AFRMPB" dentro de "AFRMPBF", "40"/"OXXO"/"COMBINABLES" sueltos en
  // medio de una línea) → todos se descartan: ninguno está solo en su
  // línea ni tras la palabra "código".
  const conSubstring = JSON.parse(JSON.stringify(JSON_EJEMPLO));
  conSubstring.cupones = [
    { emisor: 'Falso1', porcentaje: 99, codigo: 'BBVA', condiciones: [] }, // palabra real, no en posición de código.
    { emisor: 'Falso2', porcentaje: 99, codigo: 'CREDITO4', condiciones: [] }, // substring de CREDITO40.
    { emisor: 'Falso3', porcentaje: 99, codigo: 'AFRMPB', condiciones: [] }, // substring de AFRMPBF.
    { emisor: 'Falso4', porcentaje: 99, codigo: '40', condiciones: [] }, // suelto en "(40%)", no solo en su línea.
    { emisor: 'Falso5', porcentaje: 99, codigo: 'OXXO', condiciones: [] }, // nombre del comercio ("Oxxo"), no el código real "OXXOPBF".
    { emisor: 'Falso6', porcentaje: 99, codigo: 'COMBINABLES', condiciones: [] }, // palabra suelta de un requisito, no un código.
    conSubstring.cupones[0], // CREDITO40 real, para que no caiga a "sin_cupones_validos".
  ];
  r = armarCupones(JSON.stringify(conSubstring), original());
  assert.strictEqual(r.fallback, false);
  for (const falso of ['Falso1', 'Falso2', 'Falso3', 'Falso4', 'Falso5', 'Falso6']) {
    assert.ok(!r.caption.includes(falso), `no debió colar ${falso}`);
  }
  for (const codigo of ['BBVA', 'CREDITO4', 'AFRMPB', 'OXXO', 'COMBINABLES']) {
    assert.ok(!r.caption.includes(`<code>${codigo}</code>`), `no debió colar <code>${codigo}</code>`);
  }
  assert.ok(r.caption.includes('<code>CREDITO40</code>')); // el real sí.

  // Inyección HTML en porcentaje (el modelo podría devolver cualquier
  // string, no solo un número) → nunca debe publicarse la etiqueta cruda;
  // se guarda ya como number (parsearMonto le queda "40" porque el resto
  // de los caracteres no son dígito/coma/punto) y se escapa al mostrar.
  const conInyeccion = JSON.parse(JSON.stringify(JSON_EJEMPLO));
  conInyeccion.cupones[0].porcentaje = '<a href=evil>40</a>';
  r = armarCupones(JSON.stringify(conInyeccion), original());
  assert.strictEqual(r.fallback, false);
  assert.ok(!r.caption.toLowerCase().includes('<a '));
  assert.ok(!r.caption.toLowerCase().includes('href'));
  assert.ok(r.caption.includes('Mercado Pago T. Crédito — 40%')); // el número limpio sí se muestra.

  // quitarLinks() debe quitar también dominios SIN esquema (bit.ly/abc,
  // t.me/canal, www.otro.com, x.com/...), no solo http(s):// o
  // meli.la/mercadolibre.com.mx (bug ALTA reportado por el revisor). El
  // link puede quedar en medio del texto (doble espacio donde estaba, igual
  // que con http(s)://) o al final (se recorta el espacio colgante).
  assert.strictEqual(quitarLinks('Promo en bit.ly/abc hoy'), 'Promo en  hoy');
  assert.strictEqual(quitarLinks('Canal: t.me/canal'), 'Canal:');
  assert.strictEqual(quitarLinks('Visítanos en www.otro.com ya'), 'Visítanos en  ya');
  assert.strictEqual(quitarLinks('Síguenos en x.com/cazagangasmx'), 'Síguenos en');
  // Pero NO debe tocar precios/decimales (no son dominios): "13,229.02",
  // "40%", "$190" deben quedar intactos.
  assert.strictEqual(quitarLinks('Precio $13,229.02 con -40% de descuento'), 'Precio $13,229.02 con -40% de descuento');

  // Tipos inesperados del LLM (número donde se esperaba string) no deben
  // tirar el motor: antes, `(datos.titulo || '').trim()` con un number
  // lanzaba TypeError ("titulo.trim is not a function"); ahora se coacciona
  // con String() y, aunque no fuera así, el try/catch cae a fallback.
  const conTituloNumero = JSON.parse(JSON.stringify(JSON_EJEMPLO));
  conTituloNumero.titulo = 2026;
  r = armarCupones(JSON.stringify(conTituloNumero), original());
  assert.strictEqual(r.fallback, false);
  assert.ok(r.caption.includes('🎟️ <b>2026</b>'));

  // Tipo inesperado que NO es string/number (objeto/array) en titulo o
  // emisor → se trata como vacío (aTextoSeguro), nunca se publica
  // "[object Object]" (bug reportado en revisión: String(obj) sí lo
  // filtraba, pero no debía aceptar nada que no fuera texto/número).
  const conTituloObjeto = JSON.parse(JSON.stringify(JSON_EJEMPLO));
  conTituloObjeto.titulo = { raro: true };
  r = armarCupones(JSON.stringify(conTituloObjeto), original());
  assert.strictEqual(r.fallback, true);
  assert.strictEqual(r.motivo, 'sin_titulo'); // titulo vacío tras aTextoSeguro.

  const conEmisorObjeto = JSON.parse(JSON.stringify(JSON_EJEMPLO));
  conEmisorObjeto.cupones[0].emisor = { raro: true };
  r = armarCupones(JSON.stringify(conEmisorObjeto), original());
  assert.strictEqual(r.fallback, false);
  assert.ok(!r.caption.includes('[object Object]'));
  assert.ok(r.caption.includes('💳 <b>Cupón — 40%</b>')); // emisor vacío -> etiqueta genérica.

  // Error inesperado no previsto (original.texto con un toString() que
  // truena -- un objeto normal con toString ya no tira nada, porque
  // numeroVerificado/apareceComoCodigo ahora coaccionan con String(); esto
  // prueba el try/catch como última defensa, no la coacción de tipos) →
  // cae a fallback en vez de tirar el Code node completo, y ni fallback()
  // mismo truena al intentar leer ese texto (defensa en profundidad pedida
  // por el revisor).
  const originalRaro = { texto: { toString: () => { throw new Error('boom'); } } };
  r = armarCupones(JSON.stringify(JSON_EJEMPLO), originalRaro);
  assert.strictEqual(r.fallback, true);
  assert.strictEqual(r.motivo, 'error_inesperado');
  assert.strictEqual(r.caption, ''); // no se pudo recuperar ni el texto original; no se cae el nodo.

  // JSON inválido → fallback: texto original con *negritas* -> <b>.
  r = armarCupones('esto no es json', original());
  assert.strictEqual(r.fallback, true);
  assert.strictEqual(r.motivo, 'json_invalido');
  assert.ok(r.caption.includes('<b>NUEVOS CUPONES BANCARIOS PRE-BUEN FIN</b>'));
  assert.ok(!r.caption.includes('*')); // sin asteriscos sueltos.

  // Respuesta vacía/null (timeout o error de red) → fallback.
  r = armarCupones(null, original());
  assert.strictEqual(r.fallback, true);

  // Sin título → fallback.
  r = armarCupones(JSON.stringify({ titulo: '', cupones: JSON_EJEMPLO.cupones }), original());
  assert.strictEqual(r.fallback, true);
  assert.strictEqual(r.motivo, 'sin_titulo');

  // Todos los cupones inventados (ningún código real) → fallback.
  r = armarCupones(JSON.stringify({
    titulo: 'Cupones',
    cupones: [{ emisor: 'X', porcentaje: 10, codigo: 'NOEXISTE', condiciones: [] }],
  }), original());
  assert.strictEqual(r.fallback, true);
  assert.strictEqual(r.motivo, 'sin_cupones_validos');

  // Caption resultante > 4096 (condiciones gigantes) → fallback.
  const gigante = JSON.parse(JSON.stringify(JSON_EJEMPLO));
  gigante.cupones[0].condiciones = ['C'.repeat(5000)];
  r = armarCupones(JSON.stringify(gigante), original());
  assert.strictEqual(r.fallback, true);
  assert.strictEqual(r.motivo, 'texto_muy_largo');

  console.log('OK: motor_cupones.js — 20 casos pasaron');
}

if (typeof require !== 'undefined' && require.main === module) {
  demo();
}
