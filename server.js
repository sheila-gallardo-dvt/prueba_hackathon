'use strict';
// Tienda "Nido" — servidor HTTP sin dependencias (Node >= 20).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { preguntarAsistente } = require('./asistente');

const PORT = Number(process.env.PORT) || 8080;
const BUZON_URL = process.env.BUZON_URL || '';
const CLAVE = process.env.CLAVE || '';
const TIENDA = 'Nido Hogar';

// ---------- Datos ----------
const CATALOGO = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'catalogo.json'), 'utf8'));
const CATALOGO_JSON = JSON.stringify(CATALOGO);
const PRODUCTOS = CATALOGO.productos;
const POR_SKU = new Map(PRODUCTOS.map((p) => [p.sku, p]));
const CSS = fs.readFileSync(path.join(__dirname, 'public', 'estilos.css'));
const FAVICON = fs.readFileSync(path.join(__dirname, 'public', 'favicon.svg'));

const CATEGORIAS = [
  ['sofa', 'Sofás y sillones'], ['cama', 'Camas'], ['colchon', 'Colchones'], ['mesa', 'Mesas'],
  ['silla', 'Sillas'], ['escritorio', 'Escritorios'], ['silla_oficina', 'Sillas de oficina'],
  ['almacenaje', 'Almacenaje'], ['iluminacion', 'Iluminación'], ['textil', 'Textil'], ['accesorio', 'Accesorios'],
];
const NOMBRE_CAT = Object.fromEntries(CATEGORIAS);
const COMPLEMENTOS = new Set(['iluminacion', 'textil', 'almacenaje', 'accesorio']);

// "Se compra junto con": co-ocurrencias del historial de ventas
const RELACIONADOS = (() => {
  const idASku = new Map();
  for (const p of PRODUCTOS) for (const id of p.ids_origen) idASku.set(id, p.sku);
  const pedidos = new Map();
  const lineas = fs.readFileSync(path.join(__dirname, 'datos-origen', 'historial-ventas.csv'), 'utf8').trim().split('\n').slice(1);
  for (const l of lineas) {
    const [pedido, , id] = l.split(',');
    const sku = idASku.get(id);
    if (!sku) continue;
    if (!pedidos.has(pedido)) pedidos.set(pedido, new Set());
    pedidos.get(pedido).add(sku);
  }
  const cuenta = new Map();
  for (const skus of pedidos.values()) {
    for (const a of skus) for (const b of skus) {
      if (a === b) continue;
      if (!cuenta.has(a)) cuenta.set(a, new Map());
      cuenta.get(a).set(b, (cuenta.get(a).get(b) || 0) + 1);
    }
  }
  const r = new Map();
  for (const [a, m] of cuenta) r.set(a, [...m.entries()].sort((x, y) => y[1] - x[1]).map(([s]) => s));
  return r;
})();

// ---------- Utilidades ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (n) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(n);
const aCent = (n) => Math.round(n * 100);

const CABECERAS = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function leerCookies(req) {
  const out = {};
  for (const par of (req.headers.cookie || '').split(';')) {
    const i = par.indexOf('=');
    if (i > 0) out[par.slice(0, i).trim()] = par.slice(i + 1).trim();
  }
  return out;
}
const cookie = (nombre, valor, maxAge) => `${nombre}=${valor}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;

function enviar(req, res, status, cuerpo, tipo = 'text/html; charset=utf-8', extra = {}) {
  const cabs = { ...CABECERAS, 'Content-Type': tipo, ...extra };
  const setCookies = [].concat(res.galletas || []);
  if (!req.cookies.hk_sesion) setCookies.push(cookie('hk_sesion', crypto.randomBytes(18).toString('base64url'), 60 * 60 * 24 * 30));
  if (setCookies.length) cabs['Set-Cookie'] = setCookies;
  if (!cabs['Cache-Control']) cabs['Cache-Control'] = 'no-store';
  res.writeHead(status, cabs);
  res.end(req.method === 'HEAD' ? undefined : cuerpo);
}
const redirigir = (req, res, donde) => enviar(req, res, 303, '', 'text/plain; charset=utf-8', { Location: donde });

function leerCuerpo(req, limite = 16 * 1024) {
  return new Promise((ok, ko) => {
    let datos = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { datos += c; if (datos.length > limite) { ko(new Error('demasiado grande')); req.destroy(); } });
    req.on('end', () => ok(datos));
    req.on('error', ko);
  });
}
const formulario = (texto) => Object.fromEntries(new URLSearchParams(texto));

// ---------- Carrito (en cookie, sin estado en servidor) ----------
function leerCarrito(req) {
  try {
    const obj = JSON.parse(Buffer.from(req.cookies.carrito || '', 'base64url').toString('utf8') || '{}');
    const limpio = {};
    for (const [sku, q] of Object.entries(obj)) {
      const n = Math.floor(Number(q));
      if (POR_SKU.has(sku) && n >= 1) limpio[sku] = Math.min(n, 20);
    }
    return limpio;
  } catch { return {}; }
}
function guardarCarrito(res, carrito) {
  const v = Buffer.from(JSON.stringify(carrito)).toString('base64url');
  res.galletas = [cookie('carrito', v, 60 * 60 * 24 * 7)];
}
function lineasCarrito(carrito) {
  const lineas = Object.entries(carrito).map(([sku, quantity]) => {
    const p = POR_SKU.get(sku);
    return { sku, name: p.nombre, quantity, unit_price: p.precio, p };
  });
  const totalCent = lineas.reduce((s, l) => s + l.quantity * aCent(l.unit_price), 0);
  return { lineas, total: totalCent / 100, unidades: lineas.reduce((s, l) => s + l.quantity, 0) };
}

// ---------- Plantillas ----------
function pagina({ titulo, descripcion, cuerpo, carrito, buscar = '' }) {
  const n = carrito ? Object.values(carrito).reduce((a, b) => a + b, 0) : 0;
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)}</title>
<meta name="description" content="${esc(descripcion)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/estilos.css">
</head>
<body>
<header class="cabecera">
  <div class="contenedor fila">
    <a class="marca" href="/">${TIENDA}</a>
    <form class="buscador" action="/" method="get" role="search">
      <label for="q" class="oculto">Buscar productos</label>
      <input id="q" name="q" type="search" placeholder="Buscar: sofá, cama, lámpara…" value="${esc(buscar)}">
      <button type="submit">Buscar</button>
    </form>
    <a class="boton-carrito" href="/carrito">Carrito (${n})</a>
  </div>
  <nav class="contenedor categorias" aria-label="Categorías">
    ${CATEGORIAS.map(([k, v]) => `<a href="/?cat=${k}">${v}</a>`).join('')}
  </nav>
</header>
<main class="contenedor">
${cuerpo}
</main>
<footer class="pie">
  <div class="contenedor">
    <p>Envío gratis desde 500 € · Montaje gratis desde 1.500 € · 30 días de devolución · 3 años de garantía (10 en colchones).</p>
    <p><a href="/condiciones">Condiciones de venta</a> · <a href="/asistente">Asistente</a> · <a href="/catalogo.json">Catálogo (JSON)</a></p>
  </div>
</footer>
</body>
</html>`;
}

const atributos = (p) => [
  NOMBRE_CAT[p.categoria],
  p.plazas ? `${p.plazas} ${p.plazas === 1 ? 'plaza' : 'plazas'}` : null,
  p.ancho_cm ? `${p.ancho_cm} cm de ancho` : null,
  p.color, p.material,
].filter(Boolean).join(' · ');

const botonAnadir = (p, texto = 'Añadir al carrito', volver = '/carrito') => `
  <form method="post" action="/carrito/anadir" class="form-anadir">
    <input type="hidden" name="sku" value="${esc(p.sku)}">
    <input type="hidden" name="volver" value="${esc(volver)}">
    <button type="submit" class="boton">${texto}</button>
  </form>`;

const tarjeta = (p) => `
  <article class="tarjeta">
    <div class="muestra color-${esc(p.color)}" aria-hidden="true"></div>
    <h3><a href="/producto/${esc(p.sku)}">${esc(p.nombre)}</a></h3>
    <p class="atributos">${esc(atributos(p))}</p>
    <p class="precio">${eur(p.precio)}</p>
    ${botonAnadir(p)}
  </article>`;

const sinTildes = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function portada(req, res, url) {
  const carrito = leerCarrito(req);
  const q = (url.searchParams.get('q') || '').slice(0, 80).trim();
  const cat = url.searchParams.get('cat') || '';
  let lista = PRODUCTOS;
  let titulo = 'Muebles para toda la casa';
  if (cat && NOMBRE_CAT[cat]) { lista = lista.filter((p) => p.categoria === cat); titulo = NOMBRE_CAT[cat]; }
  if (q) {
    const terminos = sinTildes(q).split(/\s+/).map((t) => t.replace(/(es|s)$/, '')).filter(Boolean);
    lista = lista.filter((p) => {
      const texto = sinTildes(`${p.nombre} ${NOMBRE_CAT[p.categoria]} ${p.categoria} ${p.color} ${p.material} ${p.plazas ? p.plazas + ' plazas' : ''}`);
      return terminos.every((t) => texto.includes(t));
    });
    titulo = `Resultados para «${q}»`;
  }
  let secciones;
  if (q || cat) {
    secciones = lista.length
      ? `<div class="rejilla">${lista.map(tarjeta).join('')}</div>`
      : `<p>No hemos encontrado productos. <a href="/">Ver todo el catálogo</a>.</p>`;
  } else {
    secciones = CATEGORIAS.map(([k, v]) => {
      const ps = PRODUCTOS.filter((p) => p.categoria === k);
      return `<section class="seccion"><h2 id="${k}">${v}</h2><div class="rejilla">${ps.map(tarjeta).join('')}</div></section>`;
    }).join('');
  }
  const cuerpo = `
  <div class="aviso-envio">
    <h1>${esc(TIENDA)}: ${esc(titulo)}</h1>
    <p>Compra como invitado en 3 pasos, sin registro. Pago simulado. <strong>Envío gratis desde 500 €</strong> y <strong>montaje a domicilio gratis desde 1.500 €</strong>.</p>
  </div>
  ${secciones}`;
  enviar(req, res, 200, pagina({
    titulo: `${TIENDA} · ${titulo}`,
    descripcion: 'Tienda online de muebles: sofás, camas, colchones, mesas, iluminación y textil. Compra sin registro.',
    cuerpo, carrito, buscar: q,
  }));
}

function ficha(req, res, sku) {
  const p = POR_SKU.get(sku);
  if (!p) return noEncontrado(req, res);
  const carrito = leerCarrito(req);
  const rel = (RELACIONADOS.get(sku) || []).map((s) => POR_SKU.get(s)).slice(0, 4);
  const cuerpo = `
  <p class="miga"><a href="/">Inicio</a> › <a href="/?cat=${p.categoria}">${esc(NOMBRE_CAT[p.categoria])}</a></p>
  <article class="ficha">
    <div class="muestra grande color-${esc(p.color)}" aria-hidden="true"></div>
    <div>
      <h1>${esc(p.nombre)}</h1>
      <p class="precio grande">${eur(p.precio)} <span class="iva">IVA incluido</span></p>
      <table class="tabla-atributos">
        <tr><th scope="row">Categoría</th><td>${esc(NOMBRE_CAT[p.categoria])}</td></tr>
        ${p.plazas ? `<tr><th scope="row">Plazas</th><td>${p.plazas}</td></tr>` : ''}
        ${p.ancho_cm ? `<tr><th scope="row">Ancho</th><td>${p.ancho_cm} cm</td></tr>` : ''}
        <tr><th scope="row">Color</th><td>${esc(p.color)}</td></tr>
        <tr><th scope="row">Material</th><td>${esc(p.material)}</td></tr>
        <tr><th scope="row">Referencia</th><td>${esc(p.sku)}</td></tr>
      </table>
      <form method="post" action="/carrito/anadir" class="form-ficha">
        <input type="hidden" name="sku" value="${esc(p.sku)}">
        <label for="cantidad">Cantidad</label>
        <input id="cantidad" name="cantidad" type="number" min="1" max="20" value="1">
        <button type="submit" class="boton">Añadir al carrito</button>
      </form>
      <p class="nota">Entrega en 3 a 5 días laborables en península. ${p.categoria === 'colchon' ? '100 noches de prueba y 10 años de garantía.' : '3 años de garantía y 30 días de devolución.'}</p>
    </div>
  </article>
  ${rel.length ? `<section class="seccion"><h2>Los clientes que compraron este producto también se llevaron</h2><div class="rejilla">${rel.map(tarjeta).join('')}</div></section>` : ''}`;
  enviar(req, res, 200, pagina({
    titulo: `${p.nombre} · ${TIENDA}`,
    descripcion: `${p.nombre} por ${eur(p.precio)}. ${atributos(p)}. Envío gratis desde 500 €.`,
    cuerpo, carrito,
  }));
}

function sugerencias(carrito, max = 4) {
  const dentro = new Set(Object.keys(carrito));
  const puntos = new Map();
  for (const sku of dentro) {
    (RELACIONADOS.get(sku) || []).forEach((s, i) => {
      if (!dentro.has(s) && COMPLEMENTOS.has(POR_SKU.get(s).categoria)) puntos.set(s, (puntos.get(s) || 0) + (10 - Math.min(i, 9)));
    });
  }
  let lista = [...puntos.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => POR_SKU.get(s));
  if (lista.length < max) {
    for (const p of PRODUCTOS) if (COMPLEMENTOS.has(p.categoria) && !dentro.has(p.sku) && !lista.includes(p)) lista.push(p);
  }
  return lista.slice(0, max);
}

function vistaCarrito(req, res, mensaje = '') {
  const carrito = leerCarrito(req);
  const { lineas, total } = lineasCarrito(carrito);
  let cuerpo;
  if (!lineas.length) {
    cuerpo = `<h1>Tu carrito</h1><p>Tu carrito está vacío. <a href="/">Ver productos</a>.</p>`;
  } else {
    const faltaEnvio = 500 - total;
    const faltaMontaje = 1500 - total;
    const sug = sugerencias(carrito);
    cuerpo = `
    <h1>Tu carrito</h1>
    ${mensaje ? `<p class="ok" role="status">${esc(mensaje)}</p>` : ''}
    <div class="tabla-scroll"><table class="carrito">
      <thead><tr><th scope="col">Producto</th><th scope="col">Precio</th><th scope="col">Cantidad</th><th scope="col">Subtotal</th></tr></thead>
      <tbody>
      ${lineas.map((l, i) => `<tr>
        <td><a href="/producto/${esc(l.sku)}">${esc(l.name)}</a></td>
        <td>${eur(l.unit_price)}</td>
        <td>
          <form method="post" action="/carrito/actualizar" class="form-cantidad">
            <input type="hidden" name="sku" value="${esc(l.sku)}">
            <label for="c${i}" class="oculto">Cantidad de ${esc(l.name)}</label>
            <input id="c${i}" name="cantidad" type="number" min="0" max="20" value="${l.quantity}">
            <button type="submit" class="boton-sec">Actualizar</button>
          </form>
          <form method="post" action="/carrito/actualizar" class="form-cantidad">
            <input type="hidden" name="sku" value="${esc(l.sku)}">
            <input type="hidden" name="cantidad" value="0">
            <button type="submit" class="boton-sec">Quitar</button>
          </form>
        </td>
        <td>${eur(aCent(l.unit_price) * l.quantity / 100)}</td>
      </tr>`).join('')}
      </tbody>
      <tfoot><tr><th scope="row" colspan="3">Total (IVA incluido)</th><td><strong>${eur(total)}</strong></td></tr></tfoot>
    </table></div>
    <div class="ventajas">
      <p>${faltaEnvio > 0 ? `Te faltan <strong>${eur(faltaEnvio)}</strong> para el envío gratis.` : '✔ Envío gratis incluido.'}
      ${faltaMontaje > 0 ? `Te faltan <strong>${eur(faltaMontaje)}</strong> para el montaje a domicilio gratis.` : '✔ Montaje a domicilio gratis incluido.'}</p>
    </div>
    <p><a class="boton grande" href="/checkout">Finalizar compra</a> <a class="boton-sec" href="/">Seguir comprando</a></p>
    ${sug.length ? `<section class="seccion"><h2>Completa tu compra: lo que más se lleva junto a lo que has elegido</h2><div class="rejilla">${sug.map(tarjeta).join('')}</div></section>` : ''}`;
  }
  enviar(req, res, 200, pagina({ titulo: `Carrito · ${TIENDA}`, descripcion: 'Revisa los productos de tu carrito y finaliza tu compra como invitado.', cuerpo, carrito }));
}

function vistaCheckout(req, res, { error = '', datos = {} } = {}) {
  const carrito = leerCarrito(req);
  const { lineas, total } = lineasCarrito(carrito);
  if (!lineas.length) return redirigir(req, res, '/carrito');
  const cuerpo = `
  <h1>Finalizar compra</h1>
  <p>Compra como invitado. El pago es simulado: no te pediremos ningún dato de tarjeta.</p>
  <div class="resumen">
    <h2>Resumen del pedido</h2>
    <ul>${lineas.map((l) => `<li>${l.quantity} × ${esc(l.name)} — ${eur(aCent(l.unit_price) * l.quantity / 100)}</li>`).join('')}</ul>
    <p><strong>Total: ${eur(total)}</strong> (IVA incluido${total >= 500 ? ', envío gratis' : ', envío de 49 € a la entrega'}${total >= 1500 ? ', montaje gratis' : ''})</p>
    <p><a href="/carrito">Modificar carrito</a></p>
  </div>
  ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
  <form method="post" action="/checkout" class="form-checkout">
    <label for="nombre">Nombre y apellidos</label>
    <input id="nombre" name="nombre" autocomplete="name" required value="${esc(datos.nombre)}">
    <label for="email">Correo electrónico</label>
    <input id="email" name="email" type="email" autocomplete="email" required value="${esc(datos.email)}">
    <label for="direccion">Dirección de entrega (calle, número, código postal y ciudad)</label>
    <input id="direccion" name="direccion" autocomplete="street-address" required value="${esc(datos.direccion)}">
    <button type="submit" class="boton grande">Pagar ${eur(total)} (pago simulado)</button>
  </form>`;
  enviar(req, res, error ? 422 : 200, pagina({ titulo: `Finalizar compra · ${TIENDA}`, descripcion: 'Introduce tus datos de envío y confirma tu pedido. Pago simulado, sin registro.', cuerpo, carrito }));
}

async function enviarPedido(pedido) {
  if (!BUZON_URL || !CLAVE) {
    console.error('BUZON_URL o CLAVE sin configurar; pedido no enviado', pedido.order_id);
    return { ok: false, error: 'La tienda no puede registrar pedidos ahora mismo. Inténtalo de nuevo en unos minutos.' };
  }
  try {
    const r = await fetch(BUZON_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-clave': CLAVE },
      body: JSON.stringify(pedido),
      signal: AbortSignal.timeout(10000),
    });
    const texto = await r.text();
    if (r.ok) return { ok: true };
    console.error('Buzón respondió', r.status, texto.slice(0, 300));
    return { ok: false, error: 'No hemos podido registrar el pedido. Revisa tus datos e inténtalo de nuevo.' };
  } catch (e) {
    console.error('Error enviando pedido', e.message);
    return { ok: false, error: 'No hemos podido registrar el pedido. Inténtalo de nuevo.' };
  }
}

async function procesarCheckout(req, res) {
  const datos = formulario(await leerCuerpo(req));
  const nombre = (datos.nombre || '').trim().slice(0, 120);
  const email = (datos.email || '').trim().slice(0, 120);
  const direccion = (datos.direccion || '').trim().slice(0, 250);
  const carrito = leerCarrito(req);
  const { lineas, total } = lineasCarrito(carrito);
  if (!lineas.length) return redirigir(req, res, '/carrito');
  const errores = [];
  if (!nombre) errores.push('el nombre');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errores.push('un correo electrónico válido');
  if (!direccion) errores.push('la dirección de entrega');
  if (errores.length) return vistaCheckout(req, res, { error: `Falta ${errores.join(', ')}.`, datos: { nombre, email, direccion } });

  const pedido = {
    schema_version: '1.0',
    order_id: crypto.randomUUID(),
    created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    customer: { name: nombre, email, address: direccion },
    items: lineas.map((l) => ({ sku: l.sku, name: l.name, quantity: l.quantity, unit_price: l.unit_price })),
    currency: 'EUR',
    total,
  };
  const r = await enviarPedido(pedido);
  if (!r.ok) return vistaCheckout(req, res, { error: r.error, datos: { nombre, email, direccion } });
  console.log('Pedido enviado', pedido.order_id, pedido.total);
  guardarCarrito(res, {});
  const cuerpo = `
  <h1>¡Pedido confirmado!</h1>
  <p class="ok" role="status">Gracias, ${esc(nombre)}. Tu pedido se ha completado correctamente.</p>
  <p>Número de pedido: <strong>${pedido.order_id}</strong></p>
  <ul>${lineas.map((l) => `<li>${l.quantity} × ${esc(l.name)} — ${eur(aCent(l.unit_price) * l.quantity / 100)}</li>`).join('')}</ul>
  <p><strong>Total pagado: ${eur(total)}</strong></p>
  <p>Lo enviaremos a: ${esc(direccion)}. Recibirás la confirmación en ${esc(email)}.</p>
  <p><a href="/">Volver a la tienda</a></p>`;
  enviar(req, res, 200, pagina({ titulo: `Pedido confirmado · ${TIENDA}`, descripcion: 'Tu pedido se ha completado correctamente. Gracias por comprar en Nido Hogar.', cuerpo, carrito: {} }));
}

async function anadir(req, res) {
  const d = formulario(await leerCuerpo(req));
  const carrito = leerCarrito(req);
  const p = POR_SKU.get(d.sku);
  if (!p) return redirigir(req, res, '/carrito');
  const n = Math.max(1, Math.min(20, Math.floor(Number(d.cantidad) || 1)));
  carrito[p.sku] = Math.min(20, (carrito[p.sku] || 0) + n);
  guardarCarrito(res, carrito);
  redirigir(req, res, `/carrito?anadido=${encodeURIComponent(p.sku)}`);
}

async function actualizar(req, res) {
  const d = formulario(await leerCuerpo(req));
  const carrito = leerCarrito(req);
  if (POR_SKU.has(d.sku)) {
    const n = Math.floor(Number(d.cantidad));
    if (!Number.isFinite(n) || n <= 0) delete carrito[d.sku];
    else carrito[d.sku] = Math.min(20, n);
  }
  guardarCarrito(res, carrito);
  redirigir(req, res, '/carrito');
}

const CONDICIONES_MD = fs.readFileSync(path.join(__dirname, 'datos-origen', 'condiciones-de-venta.md'), 'utf8');
function condiciones(req, res) {
  const html = CONDICIONES_MD.split('\n').map((l) => {
    if (l.startsWith('# ')) return `<h1>${esc(l.slice(2))}</h1>`;
    if (l.startsWith('## ')) return `<h2>${esc(l.slice(3))}</h2>`;
    if (l.startsWith('- ')) return `<li>${esc(l.slice(2))}</li>`;
    return '';
  }).join('\n');
  enviar(req, res, 200, pagina({ titulo: `Condiciones de venta · ${TIENDA}`, descripcion: 'Envíos, montaje, devoluciones, garantía y formas de pago de Nido Hogar.', cuerpo: html, carrito: leerCarrito(req) }));
}

async function vistaAsistente(req, res) {
  let pregunta = '';
  let respuesta = '';
  if (req.method === 'POST') {
    pregunta = (formulario(await leerCuerpo(req)).pregunta || '').slice(0, 500);
    if (pregunta.trim()) respuesta = await preguntarAsistente(pregunta);
  }
  const cuerpo = `
  <h1>Asistente de la tienda</h1>
  <p>Pregúntanos por productos, precios, envíos, montaje, devoluciones, garantía o formas de pago.</p>
  <form method="post" action="/asistente" class="form-checkout">
    <label for="pregunta">Tu pregunta</label>
    <input id="pregunta" name="pregunta" value="${esc(pregunta)}" required>
    <button type="submit" class="boton">Preguntar</button>
  </form>
  ${respuesta ? `<div class="respuesta" role="status"><p>${esc(respuesta).replace(/\n/g, '<br>')}</p></div>` : ''}`;
  enviar(req, res, 200, pagina({ titulo: `Asistente · ${TIENDA}`, descripcion: 'Resuelve tus dudas sobre productos, envíos, montaje y devoluciones con nuestro asistente.', cuerpo, carrito: leerCarrito(req) }));
}

async function apiAsistente(req, res) {
  let pregunta = '';
  try {
    const j = JSON.parse(await leerCuerpo(req, 8 * 1024));
    pregunta = typeof j.pregunta === 'string' ? j.pregunta.slice(0, 2000) : '';
  } catch { /* cuerpo no válido */ }
  if (!pregunta.trim()) {
    return enviar(req, res, 200, JSON.stringify({ respuesta: 'Envía tu pregunta en el campo "pregunta".' }), 'application/json; charset=utf-8');
  }
  const respuesta = await preguntarAsistente(pregunta);
  enviar(req, res, 200, JSON.stringify({ respuesta }), 'application/json; charset=utf-8');
}

function noEncontrado(req, res) {
  enviar(req, res, 404, pagina({ titulo: `Página no encontrada · ${TIENDA}`, descripcion: 'La página que buscas no existe en Nido Hogar. Vuelve a la portada.', cuerpo: '<h1>Página no encontrada</h1><p><a href="/">Volver a la tienda</a></p>', carrito: {} }));
}

// ---------- Enrutador ----------
async function manejar(req, res) {
  req.cookies = leerCookies(req);
  const url = new URL(req.url, 'http://localhost');
  const ruta = url.pathname;
  const m = req.method;
  const lectura = m === 'GET' || m === 'HEAD';

  if (lectura && ruta === '/') return portada(req, res, url);
  if (lectura && ruta.startsWith('/producto/')) return ficha(req, res, ruta.slice(10));
  if (lectura && ruta === '/carrito') return vistaCarrito(req, res, url.searchParams.get('anadido') && POR_SKU.has(url.searchParams.get('anadido')) ? `Añadido: ${POR_SKU.get(url.searchParams.get('anadido')).nombre}` : '');
  if (lectura && ruta === '/checkout') return vistaCheckout(req, res);
  if (lectura && ruta === '/condiciones') return condiciones(req, res);
  if (lectura && ruta === '/asistente') return vistaAsistente(req, res);
  if (lectura && ruta === '/catalogo.json') return enviar(req, res, 200, CATALOGO_JSON, 'application/json; charset=utf-8', { 'Cache-Control': 'public, max-age=300' });
  if (lectura && ruta === '/estilos.css') return enviar(req, res, 200, CSS, 'text/css; charset=utf-8', { 'Cache-Control': 'public, max-age=86400' });
  if (lectura && (ruta === '/favicon.svg' || ruta === '/favicon.ico')) return enviar(req, res, 200, FAVICON, 'image/svg+xml', { 'Cache-Control': 'public, max-age=86400' });
  if (lectura && ruta === '/robots.txt') return enviar(req, res, 200, 'User-agent: *\nAllow: /\n', 'text/plain; charset=utf-8');
  if (lectura && ruta === '/salud') return enviar(req, res, 200, 'ok', 'text/plain; charset=utf-8');
  if (m === 'POST' && ruta === '/carrito/anadir') return anadir(req, res);
  if (m === 'POST' && ruta === '/carrito/actualizar') return actualizar(req, res);
  if (m === 'POST' && ruta === '/checkout') return procesarCheckout(req, res);
  if (m === 'POST' && ruta === '/asistente') return vistaAsistente(req, res);
  if (m === 'POST' && ruta === '/api/asistente') return apiAsistente(req, res);
  return noEncontrado(req, res);
}

const servidor = http.createServer(async (req, res) => {
  try {
    await manejar(req, res);
  } catch (e) {
    console.error('Error', e && e.message);
    if (!res.headersSent) {
      req.cookies = req.cookies || {};
      enviar(req, res, 500, pagina({ titulo: `Error · ${TIENDA}`, descripcion: 'Ha ocurrido un error inesperado. Vuelve a intentarlo en unos segundos.', cuerpo: '<h1>Algo ha fallado</h1><p>Inténtalo de nuevo. <a href="/">Volver a la tienda</a></p>', carrito: {} }));
    } else res.end();
  }
});
servidor.keepAliveTimeout = 65000;
servidor.headersTimeout = 66000;
servidor.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
});
servidor.listen(PORT, () => console.log(`${TIENDA} escuchando en ${PORT}`));
