// Lógica pura del nodo "Armar caption" del workflow "Afiliados - Publicar en
// Telegram". Testeable con `node workflows/src/motor_caption.js` por fuera de
// n8n. El Code node del workflow pega este archivo tal cual (función +
// bloque de invocación con $input/$env de abajo), mismo patrón que
// validar_mensaje.js.
//
// Entra aquí DESPUÉS de "Analizar imagen" (HTTP Request a Ollama local, el
// mismo proveedor que usa lemut_n8n para el LLM que lee documentos — ver
// README). La respuesta del modelo es texto libre que DEBERÍA ser un JSON
// (Ollama con `temperature:0`, sin `format` forzado porque el endpoint es el
// OpenAI-compatible /v1/chat/completions); se valida y arma el caption con
// una plantilla fija en código (el LLM NO redacta texto, solo extrae datos).
//
// Regla dura del negocio: si el modelo falla, tarda, o el JSON es inválido/
// incompleto, se cae a fallback = se publica el caption ORIGINAL que mandó
// el afiliado (nunca se bloquea la publicación por un problema del LLM).

const LIMITE_CAPTION = 1024; // mismo límite que validar_mensaje.js (caption de foto en Telegram).

// Defensa en profundidad: el único link que debe salir en el caption es
// original.link (el que mandó el afiliado); ningún campo que devuelva el
// LLM (nombre, tienda, promociones...) debe poder colar un link distinto.
// Genérica a propósito: no solo http(s):// ni solo meli.la/
// mercadolibre.com.mx, también dominio.tld(/ruta) sin esquema (bit.ly/abc,
// t.me/canal, www.otro.com...). El TLD final debe ser solo letras (2+)
// para no atrapar precios/decimales ("13,229.02"). Misma regex que
// validar_mensaje.js/motor_cupones.js (duplicada: cada Code node de n8n es
// autocontenido).
const URL_GENERICA_RE = /https?:\/\/\S+|\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?:\/\S*)?\b/gi;
function quitarLinks(texto) {
  return String(texto || '')
    .replace(URL_GENERICA_RE, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Solo string/number se tratan como texto; cualquier otro tipo (objeto,
// array...) que el LLM devuelva en un campo de texto se descarta como ''
// en vez de colarse via String() como "[object Object]" (reportado en
// revisión).
function aTextoSeguro(valor) {
  if (typeof valor === 'string') return valor;
  if (typeof valor === 'number' && Number.isFinite(valor)) return String(valor);
  return '';
}

// El modelo a veces envuelve el JSON en fences de markdown pese a la
// instrucción de no hacerlo (típico en modelos chicos) — se despoja antes
// de intentar JSON.parse.
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

// El modelo a veces agrega texto suelto alrededor del número ("13,039.02 con
// Cupón" en vez de solo "13039.02") pese a la instrucción de mandar solo el
// número — se limpia aquí en vez de pedir un tercer intento de prompt.
// Devuelve un number o null (nunca inventa: si no hay dígitos, no hay monto).
function parsearMonto(valor) {
  if (valor === null || valor === undefined) return null;
  const limpio = String(valor).replace(/[^\d.,]/g, '').replace(/,/g, '');
  if (!limpio) return null;
  const n = parseFloat(limpio);
  return Number.isFinite(n) ? n : null;
}

// Formato mexicano: separador de miles con coma, sin decimales si el monto
// es entero (ej. "$190" en vez de "$190.00").
function formatearMonto(n) {
  const esEntero = Number.isInteger(n);
  const [entero, decimales] = n.toFixed(esEntero ? 0 : 2).split('.');
  const conComas = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decimales ? `${conComas}.${decimales}` : conComas;
}

// Arma la línea de precio: varias combinaciones según qué haya visto el
// modelo (nunca inventa "antes"/"%" si no vienen de la imagen). Cada precio
// se valida con parsearMonto (formato numérico) antes de mostrarlo — el
// LLM nunca interpola texto libre suyo aquí, solo números ya verificados
// (defensa BAJA pedida por el revisor: así un precio con basura/un link
// alrededor nunca se publica tal cual).
function lineaPrecio(datos) {
  const actual = parsearMonto(datos.precio_actual);
  if (actual === null) return null;
  const anterior = parsearMonto(datos.precio_anterior);
  const descuento = parsearMonto(datos.descuento_pct);
  if (anterior !== null) {
    let linea = `💲 Ahora $${formatearMonto(actual)} (antes $${formatearMonto(anterior)}`;
    if (descuento !== null) linea += `, -${formatearMonto(descuento)}%`;
    return linea + ')';
  }
  if (descuento !== null) return `💲 $${formatearMonto(actual)} (-${formatearMonto(descuento)}%)`;
  return `💲 $${formatearMonto(actual)}`;
}

// El ahorro se calcula aquí (en código), nunca lo redacta el modelo: si
// precio_actual y precio_con_cupon son números válidos y el cupón sí baja el
// precio, arma "de $X a $Y (ahorras $Z)"; si no se puede calcular (falta el
// precio_actual o el cupón no baja el precio), cae a la forma simple.
function lineaCupon(datos) {
  const conCupon = parsearMonto(datos.precio_con_cupon);
  if (conCupon !== null) {
    const actual = parsearMonto(datos.precio_actual);
    if (actual !== null && actual > conCupon) {
      const ahorro = Math.round((actual - conCupon) * 100) / 100;
      return `🎟️ Con cupón: de $${formatearMonto(actual)} a $${formatearMonto(conCupon)} (ahorras $${formatearMonto(ahorro)})`;
    }
    return `🎟️ Con cupón: $${formatearMonto(conCupon)}`;
  }
  if (datos.cupon_disponible) return '🎟️ Tiene cupón disponible';
  return null;
}

// Meli Dólar es la stablecoin 1:1 con el dólar de Mercado Pago (ver
// Términos y condiciones de Ripio / Meli Dólar): el cashback solo se
// acredita pagando con Tarjeta de Crédito Mercado Pago siendo Meli+ — se
// deja explícito en la línea para que no se confunda con pesos ni con un
// descuento directo. Monto con 2 decimales, sin signo $ (es dólares, no
// pesos).
function lineaCashback(datos) {
  const monto = parsearMonto(datos.cashback_monto);
  if (monto === null) return null;
  return `💰 ${monto.toFixed(2)} dólares de cashback en Meli Dólar (con Meli+ y Tarjeta de Crédito Mercado Pago)`;
}

// El modelo a veces devuelve el renglón completo del banner ("Visita la
// Tienda oficial de Samsung") en vez de solo el nombre — se recorta el
// prefijo conocido, sin inventar ni cambiar el nombre que sí reportó.
function limpiarTienda(valorCrudo) {
  const valor = aTextoSeguro(valorCrudo);
  if (!valor) return null;
  const limpio = quitarLinks(valor.replace(/^\s*visita\s+la\s+tienda\s+oficial\s+de\s*/i, ''));
  return limpio || null;
}

// El modelo a veces pierde las comillas de pulgadas en nombre_corto (las
// cambia por un espacio: "70 4K" en vez de "70\" 4K") aunque sí las ponga
// en nombre_completo. Se agrega aquí, en código, SOLO si el número ya
// aparece tal cual en nombre_corto (nunca inventa un tamaño que el modelo
// no haya reportado ahí).
function normalizarPulgadas(nombreCorto, nombreCompleto) {
  if (!nombreCorto || !nombreCompleto) return nombreCorto;
  const conComillas = /(\d+)\s*"/.exec(nombreCompleto);
  if (!conComillas) return nombreCorto;
  const numero = conComillas[1];
  if (new RegExp(`${numero}\\s*"`).test(nombreCorto)) return nombreCorto; // ya las tiene.
  const sinComillas = new RegExp(`\\b${numero}\\b(?!\\s*")`);
  if (!sinComillas.test(nombreCorto)) return nombreCorto; // el número ni aparece, no tocar.
  return nombreCorto.replace(sinComillas, `${numero}"`);
}

function fallback(motivo, original) {
  return { caption: String((original && original.caption) || ''), fallback: true, motivo };
}

// original: { caption, link, textoUsuario } — vienen de "Validar mensaje"
// (ver validar_mensaje.js). respuestaModelo: el texto crudo que mandó el LLM
// (o undefined/null si la llamada falló o se cayó por timeout). Todo el
// cuerpo va en try/catch: el LLM puede devolver tipos inesperados (número o
// array donde se esperaba string) y aunque cada campo se normaliza con
// String()/Array.isArray(), cualquier caso no previsto cae a fallback en
// vez de tirar el Code node completo (reportado MEDIA por el revisor).
function armarCaption(respuestaModelo, original) {
  try {
    if (!original || !original.link) return fallback('sin_link_original', original || {});

    const datos = parsearDatos(respuestaModelo);
    if (!datos) return fallback('json_invalido', original);

    let nombre = quitarLinks((aTextoSeguro(datos.nombre_corto) || aTextoSeguro(datos.nombre_completo)).trim());
    nombre = normalizarPulgadas(nombre, aTextoSeguro(datos.nombre_completo));
    if (!nombre) return fallback('sin_nombre_producto', original);

    const tienda = limpiarTienda(datos.tienda_oficial);
    const promos = Array.isArray(datos.promociones)
      ? datos.promociones.filter((x) => typeof x === 'string' && x.trim()).map((x) => quitarLinks(x)).filter(Boolean)
      : [];
    const encabezado = [
      `🔥 ¡Ofertota! ${nombre}`,
      lineaPrecio(datos),
      lineaCupon(datos),
      lineaCashback(datos),
      promos.length ? `✅ ${promos.join(' · ')}` : null,
      tienda ? `🏬 Tienda oficial ${tienda}` : null,
    ].filter(Boolean).join('\n');

    const bloques = [encabezado];

    const nombreCompleto = quitarLinks(aTextoSeguro(datos.nombre_completo).trim());
    if (nombreCompleto && nombreCompleto !== nombre) bloques.push(nombreCompleto);

    const textoUsuario = String(original.textoUsuario || '').trim();
    if (textoUsuario) bloques.push(textoUsuario);

    bloques.push(`👉 Cómpralo aquí: ${original.link}`);

    const caption = bloques.join('\n\n');
    if (caption.length > LIMITE_CAPTION) return fallback('caption_muy_largo', original);

    return { caption, fallback: false, motivo: null };
  } catch (e) {
    return fallback('error_inesperado', original || {});
  }
}

if (typeof module !== 'undefined') {
  module.exports = { armarCaption, parsearDatos, parsearMonto, formatearMonto, quitarLinks, aTextoSeguro, LIMITE_CAPTION };
}

// --- Bloque de invocación dentro de n8n (Code node "Armar caption") ---
// Fuera de n8n, $input/$env no existen y este bloque no corre (ver demo()).
if (typeof $input !== 'undefined') {
  // Salida de "Analizar imagen" (HTTP Request, formato OpenAI-compatible de
  // Ollama): éxito → { choices: [{ message: { content: "<json>" } }] };
  // si falló o tardó más de 120s, "onError: continueRegularOutput" deja un
  // objeto con `.error` en vez de `.choices` (no revienta el workflow).
  const respuesta = $input.first().json;
  const textoModelo = respuesta && respuesta.choices && respuesta.choices[0]
    ? respuesta.choices[0].message?.content
    : null;

  const original = $('Validar mensaje').first().json; // { chatId, fileId, caption, link, textoUsuario }
  // try/catch extra (defensa en profundidad): armarCaption ya no debería
  // tirar nunca, pero si algo fuera de su try/catch interno fallara (ej.
  // original con forma rara), igual cae a fallback en vez de reventar el nodo.
  let resultado;
  try {
    resultado = armarCaption(textoModelo, original);
  } catch (e) {
    resultado = { caption: String(original.caption || ''), fallback: true, motivo: 'error_inesperado_nodo' };
  }

  return [{
    json: {
      accion: 'publicar',
      chatId: original.chatId,
      fileId: original.fileId,
      caption: resultado.caption,
      fallback: resultado.fallback,
      motivo: resultado.motivo,
    },
  }];
}

// --- Self-check mínimo (node workflows/src/motor_caption.js) ---
// Datos 100% sintéticos (repo público): ningún precio/cupón real de Mercado
// Libre, solo valores de prueba.
function demo() {
  const assert = require('assert');
  const original = (extra) => ({
    caption: 'Oferta https://meli.la/abc123',
    link: 'https://meli.la/abc123',
    textoUsuario: 'Oferta',
    ...extra,
  });

  // Todo completo: cupón con ahorro calculado en código, cashback, tienda
  // limpiada del renglón completo del banner, promociones.
  let r = armarCaption(JSON.stringify({
    nombre_corto: 'Bocina X100',
    nombre_completo: 'Bocina Bluetooth X100 Pro 20W Resistente al Agua',
    marca: 'MarcaDemo',
    precio_actual: '1,500.00',
    precio_anterior: null,
    descuento_pct: null,
    precio_con_cupon: '1300',
    cupon_disponible: true,
    cashback_monto: '20.50',
    promociones: ['3 meses sin intereses', 'Envío gratis'],
    tienda_oficial: 'Visita la Tienda oficial de MarcaDemo',
  }), original());
  assert.strictEqual(r.fallback, false);
  assert.ok(r.caption.includes('🔥 ¡Ofertota! Bocina X100'));
  assert.ok(r.caption.includes('💲 $1,500'));
  assert.ok(r.caption.includes('🎟️ Con cupón: de $1,500 a $1,300 (ahorras $200)'));
  assert.ok(r.caption.includes('💰 20.50 dólares de cashback en Meli Dólar (con Meli+ y Tarjeta de Crédito Mercado Pago)'));
  assert.ok(r.caption.includes('3 meses sin intereses · Envío gratis'));
  assert.ok(r.caption.includes('🏬 Tienda oficial MarcaDemo')); // sin el "Visita la Tienda oficial de".
  assert.ok(r.caption.includes('Bocina Bluetooth X100 Pro 20W Resistente al Agua'));
  assert.ok(r.caption.includes('Oferta')); // texto del usuario.
  assert.ok(r.caption.endsWith('👉 Cómpralo aquí: https://meli.la/abc123'));

  // Cupón disponible pero SIN poder leer el precio con cupón.
  r = armarCaption(JSON.stringify({
    nombre_corto: 'Bocina X100',
    precio_actual: '999',
    precio_con_cupon: null,
    cupon_disponible: true,
    promociones: [],
  }), original());
  assert.ok(r.caption.includes('🎟️ Tiene cupón disponible'));

  // Sin cupón ni cashback en absoluto.
  r = armarCaption(JSON.stringify({
    nombre_corto: 'Bocina X100',
    nombre_completo: null,
    precio_actual: '999',
    precio_anterior: null,
    descuento_pct: null,
    precio_con_cupon: null,
    cupon_disponible: false,
    cashback_monto: null,
    promociones: [],
    tienda_oficial: null,
  }), original());
  assert.strictEqual(r.fallback, false);
  assert.ok(!r.caption.includes('Cupón') && !r.caption.includes('cupón'));
  assert.ok(!r.caption.includes('cashback'));

  // precio_con_cupon con texto suelto alrededor (lo que de verdad manda el
  // modelo a veces, ej. "13,039.02 con Cupón") -- se limpia solo, sin
  // necesitar reintentar el prompt.
  r = armarCaption(JSON.stringify({
    nombre_corto: 'TV Demo',
    precio_actual: '13,229.02',
    precio_con_cupon: '13,039.02 con Cupón',
  }), original());
  assert.ok(r.caption.includes('🎟️ Con cupón: de $13,229.02 a $13,039.02 (ahorras $190)'));

  // Cashback con monto entero: siempre 2 decimales ("15.00", no "15").
  r = armarCaption(JSON.stringify({
    nombre_corto: 'Bocina X100',
    precio_actual: '999',
    cashback_monto: '15',
  }), original());
  assert.ok(r.caption.includes('💰 15.00 dólares de cashback en Meli Dólar (con Meli+ y Tarjeta de Crédito Mercado Pago)'));

  // nombre_corto sin comillas de pulgadas pero nombre_completo sí las
  // trae, y el número SÍ aparece en nombre_corto → se agregan las
  // comillas (normalizarPulgadas), nunca lo deja el LLM.
  r = armarCaption(JSON.stringify({
    nombre_corto: 'TV Samsung 70 4K',
    nombre_completo: 'Samsung Pantalla 70" Crystal UHD 4K Smart TV',
    precio_actual: '999',
  }), original());
  assert.ok(r.caption.includes('TV Samsung 70" 4K'));

  // nombre_corto ya trae las comillas → no se duplican.
  r = armarCaption(JSON.stringify({
    nombre_corto: 'TV Samsung 70" 4K',
    nombre_completo: 'Samsung Pantalla 70" Crystal UHD 4K Smart TV',
    precio_actual: '999',
  }), original());
  assert.ok(r.caption.includes('TV Samsung 70" 4K'));
  assert.ok(!r.caption.includes('70"" 4K'));

  // El número de pulgadas NO aparece en nombre_corto (otro tamaño, u otro
  // dato) → no se inventa nada; el encabezado (línea "¡Ofertota!") se deja
  // tal cual lo mandó el modelo, aunque nombre_completo sí traiga "70\"".
  r = armarCaption(JSON.stringify({
    nombre_corto: 'Smart TV 4K',
    nombre_completo: 'Samsung Pantalla 70" Crystal UHD 4K Smart TV',
    precio_actual: '999',
  }), original());
  const encabezadoLinea = r.caption.split('\n')[0];
  assert.strictEqual(encabezadoLinea, '🔥 ¡Ofertota! Smart TV 4K');

  // Sin precio anterior (no debe decir "Ahora" ni dejar paréntesis vacíos).
  r = armarCaption(JSON.stringify({
    nombre_corto: 'Bocina X100',
    precio_actual: '999',
    precio_anterior: null,
    descuento_pct: null,
    promociones: [],
    tienda_oficial: null,
  }), original());
  assert.ok(r.caption.includes('💲 $999'));
  assert.ok(!r.caption.includes('Ahora'));
  assert.ok(!r.caption.includes('('));

  // Ningún campo del LLM debe poder colar un link (solo original.link
  // puede salir) — ni en promociones, ni en nombre_completo, ni en tienda,
  // y ni siquiera un link SIN esquema (bit.ly, no solo http(s)://) (bug
  // BAJA reportado por el revisor).
  r = armarCaption(JSON.stringify({
    nombre_corto: 'Bocina X100',
    nombre_completo: 'Bocina X100, detalles en bit.ly/promo',
    precio_actual: '999',
    promociones: ['Envío gratis', 'más info en t.me/canal'],
    tienda_oficial: 'Visita la Tienda oficial de MarcaDemo (www.otro.com)',
  }), original());
  assert.strictEqual(r.fallback, false);
  assert.ok(!r.caption.includes('bit.ly'));
  assert.ok(!r.caption.includes('t.me'));
  assert.ok(!r.caption.includes('www.otro.com'));
  assert.ok(r.caption.includes('👉 Cómpralo aquí: https://meli.la/abc123')); // el único link permitido.

  // precio_actual con basura/link alrededor (lo que de verdad manda un LLM
  // a veces) → se valida como número (parsearMonto), nunca se interpola
  // texto libre ni se cuela un link por ese campo.
  r = armarCaption(JSON.stringify({
    nombre_corto: 'Bocina X100',
    precio_actual: '999 (ver http://evil.com)',
  }), original());
  assert.ok(r.caption.includes('💲 $999'));
  assert.ok(!r.caption.includes('evil.com'));

  // Tipos inesperados del LLM (number donde se esperaba string, o un array
  // donde se esperaba lista de strings) no deben tirar el motor: antes,
  // `(datos.nombre_corto || ...).trim()` con un number lanzaba TypeError;
  // ahora se coacciona con String() y, aunque no fuera así, el try/catch
  // cae a fallback.
  r = armarCaption(JSON.stringify({
    nombre_corto: 2026,
    precio_actual: 999,
    descuento_pct: 10,
    promociones: 'no es una lista',
  }), original());
  assert.strictEqual(r.fallback, false);
  assert.ok(r.caption.includes('🔥 ¡Ofertota! 2026'));
  assert.ok(r.caption.includes('💲 $999 (-10%)'));

  // Tipo que NO es string/number (objeto) en nombre_corto → se trata como
  // vacío (aTextoSeguro) y cae al siguiente campo disponible
  // (nombre_completo), nunca se publica "[object Object]" (bug detectado
  // en revisión: String(obj) sí lo filtraba, pero no debía aceptarlo).
  r = armarCaption(JSON.stringify({
    nombre_corto: { raro: true },
    nombre_completo: 'Bocina X100 Pro',
    precio_actual: '999',
  }), original());
  assert.strictEqual(r.fallback, false);
  assert.ok(!r.caption.includes('[object Object]'));
  assert.ok(r.caption.includes('🔥 ¡Ofertota! Bocina X100 Pro'));

  // Error inesperado no previsto (ej. original con una propiedad que
  // truena al leerla) → el try/catch de armarCaption cae a fallback en vez
  // de tirar el Code node completo (defensa en profundidad pedida por el
  // revisor, más allá de las normalizaciones puntuales de arriba).
  const originalRaro = {
    caption: 'orig', link: 'https://meli.la/abc123',
    get textoUsuario() { throw new Error('boom'); },
  };
  r = armarCaption(JSON.stringify({ nombre_corto: 'Bocina X100', precio_actual: '999' }), originalRaro);
  assert.strictEqual(r.fallback, true);
  assert.strictEqual(r.motivo, 'error_inesperado');
  assert.strictEqual(r.caption, 'orig');

  // JSON inválido → fallback al caption original.
  r = armarCaption('esto no es json', original());
  assert.strictEqual(r.fallback, true);
  assert.strictEqual(r.motivo, 'json_invalido');
  assert.strictEqual(r.caption, 'Oferta https://meli.la/abc123');

  // Respuesta vacía/null (timeout o error de red) → fallback.
  r = armarCaption(null, original());
  assert.strictEqual(r.fallback, true);

  // JSON envuelto en fences de markdown → se limpia y parsea igual.
  r = armarCaption('```json\n{"nombre_corto":"Bocina X100","precio_actual":"999"}\n```', original());
  assert.strictEqual(r.fallback, false);

  // nombre_corto y nombre_completo ambos null → no hay nombre, fallback.
  r = armarCaption(JSON.stringify({ nombre_corto: null, nombre_completo: null, precio_actual: '999' }), original());
  assert.strictEqual(r.fallback, true);
  assert.strictEqual(r.motivo, 'sin_nombre_producto');

  // Caption resultante > 1024 (promociones/nombre larguísimos) → fallback,
  // no se rechaza la publicación, se publica el original.
  r = armarCaption(JSON.stringify({
    nombre_corto: 'Producto',
    nombre_completo: 'N'.repeat(500),
    promociones: ['P'.repeat(600)],
    precio_actual: '999',
  }), original());
  assert.strictEqual(r.fallback, true);
  assert.strictEqual(r.motivo, 'caption_muy_largo');

  console.log('OK: motor_caption.js — 19 casos pasaron');
}

if (typeof require !== 'undefined' && require.main === module) {
  demo();
}
