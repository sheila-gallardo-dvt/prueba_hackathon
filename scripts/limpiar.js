// Limpia y fusiona los catálogos de los proveedores A y B -> data/catalogo.json
// Uso: node scripts/limpiar.js
const fs = require('fs');
const path = require('path');

const ORIGEN = path.join(__dirname, '..', 'datos-origen');
const DESTINO = path.join(__dirname, '..', 'data', 'catalogo.json');

const sinTildes = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const cents = (n) => Math.round(n * 100);
// Precio con IVA a 2 decimales. Los netos de los proveedores vienen redondeados al céntimo, así que
// al añadir el 21 % puede salir 429,0055 en vez de 429: si queda a menos de 1 céntimo de un euro
// exacto, es ese euro (el historial de ventas lo confirma: 429,00 y 35,00).
const conIva = (precio, incluido) => {
  if (incluido) return cents(precio) / 100;
  const bruto = precio * 1.21;
  if (Math.abs(bruto - Math.round(bruto)) < 0.0101) return Math.round(bruto);
  return Math.round(bruto * 100) / 100;
};

// ---------- Vocabularios ----------
const CATEGORIA_A = {
  'ALMACENAJE': 'almacenaje', 'TEXTIL HOGAR': 'textil', 'DORMITORIO / CAMAS': 'cama',
  'DESCANSO': 'colchon', 'SOFAS Y SILLONES': 'sofa', 'ILUMINACION': 'iluminacion',
  'DESPACHO - SILLAS': 'silla_oficina', 'COMEDOR - MESAS': 'mesa', 'COMEDOR - SILLAS': 'silla',
  'DESPACHO': 'escritorio',
};
const CATEGORIA_B = {
  sofa: 'sofa', storage: 'almacenaje', bed: 'cama', dining_chair: 'silla', textile: 'textil',
  mattress: 'colchon', dining_table: 'mesa', office_chair: 'silla_oficina', accessory: 'accesorio',
  lighting: 'iluminacion', desk: 'escritorio',
};
const COLOR = {
  blanco: 'blanco', white: 'blanco', negro: 'negro', black: 'negro', gris: 'gris', grey: 'gris', gray: 'gris',
  beige: 'beige', marron: 'marron', brown: 'marron', azul: 'azul', blue: 'azul', verde: 'verde', green: 'verde',
  roble: 'roble', oak: 'roble', nogal: 'nogal', walnut: 'nogal', natural: 'natural',
};
const MATERIAL = {
  tela: 'tela', fabric: 'tela', lino: 'lino', linen: 'lino', piel: 'piel', leather: 'piel',
  terciopelo: 'terciopelo', velvet: 'terciopelo', madera: 'madera', wood: 'madera', metal: 'metal',
  melamina: 'melamina', melamine: 'melamina', espuma: 'espuma', foam: 'espuma',
  muelles: 'muelles', 'pocket springs': 'muelles', 'muelles ensacados': 'muelles',
  algodon: 'algodon', cotton: 'algodon', lana: 'lana', wool: 'lana', malla: 'malla', mesh: 'malla',
  ceramica: 'ceramica', ceramic: 'ceramica',
};
const NUM_PALABRA = { una: 1, un: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5 };
const vocab = (mapa, v, campo, id) => {
  const k = sinTildes(String(v).trim().toLowerCase());
  if (!(k in mapa)) throw new Error(`${id}: ${campo} desconocido "${v}"`);
  return mapa[k];
};

// "Sofá NÓRDICO 3 PLAZAS" -> "sofa nordico"  (clave para detectar duplicados)
const clave = (nombre) => sinTildes(nombre.toLowerCase())
  .replace(/\b(\d+|una|un|uno|dos|tres|cuatro|cinco)\s+plazas?\b/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const plazasDe = (texto) => {
  const t = sinTildes(texto.toLowerCase());
  const m = t.match(/\b(\d+|una|un|uno|dos|tres|cuatro|cinco)\s+plazas?\b/);
  if (!m) return null;
  return /^\d+$/.test(m[1]) ? Number(m[1]) : NUM_PALABRA[m[1]];
};

// Nombre bonito: si viene todo en mayúsculas, a formato frase conservando nombres propios
const PROPIOS = ['Sol', 'Roca', 'Tajo', 'Luna', 'Lund', 'Malmö', 'Duero', 'Viena', 'Aarhus', 'Arena',
  'Nórdico', 'Trenzada', 'Cerámica', 'Descanso', 'Confort', 'Basic', 'Classic', 'Industrial', 'Nogal',
  'Trabajo', 'Ejecutivo', 'Sil'];
const bonito = (s) => {
  s = s.trim().replace(/\s+/g, ' ');
  if (s !== s.toUpperCase()) return (s.charAt(0).toUpperCase() + s.slice(1)).replace(/\bPLAZAS?\b/g, (w) => w.toLowerCase());
  let r = s.toLowerCase();
  r = r.charAt(0).toUpperCase() + r.slice(1);
  for (const p of PROPIOS) r = r.replace(new RegExp(`(^|\\s)${p.toLowerCase()}(?=\\s|$)`, 'g'), `$1${p}`);
  return r.replace(/(\d+)x(\d+)/gi, '$1x$2');
};

// ---------- Proveedor A (CSV latin-1, ; , coma decimal, fechas DD/MM/AAAA) ----------
function leerA() {
  const texto = fs.readFileSync(path.join(ORIGEN, 'proveedor-a.csv')).toString('latin1');
  const [cab, ...filas] = texto.split(/\r?\n/).filter((l) => l.trim());
  const cols = cab.split(';');
  return filas.map((l) => {
    const v = l.split(';');
    const r = Object.fromEntries(cols.map((c, i) => [c, (v[i] || '').trim()]));
    const precio = Number(r.PVP.replace(/\./g, '').replace(',', '.'));
    const [d, m, a] = r.F_ACT.split('/');
    // medidas: "1,50 x 0,60 x 2,00 m" o "160x230x1 cm" -> ancho en cm
    const med = r.MEDIDAS.toLowerCase();
    const nums = med.replace(/\s*(mm|cm|m)\s*$/, '').split('x').map((x) => Number(x.trim().replace(',', '.')));
    const factor = /\bm$/.test(med.trim()) && !/cm/.test(med) ? 100 : /mm/.test(med) ? 0.1 : 1;
    const familia = sinTildes(r.FAMILIA.toUpperCase());
    const nombre = bonito(r.DESCRIPCION);
    let categoria = CATEGORIA_A[familia];
    if (!categoria) throw new Error(`${r.REF}: familia ${r.FAMILIA}`);
    return {
      id: r.REF, fuente: 'A', nombre,
      categoria, precio: conIva(precio, r.IVA_INCL.toUpperCase() === 'S'),
      plazas: plazasDe(r.DESCRIPCION),
      ancho_cm: Math.round(nums[0] * factor),
      color: vocab(COLOR, r.COLOR, 'color', r.REF),
      material: vocab(MATERIAL, r.ACABADO, 'material', r.REF),
      activo: r.ESTADO.toUpperCase() === 'ACTIVO',
      fecha: new Date(`${a}-${m}-${d}T00:00:00Z`),
    };
  });
}

// ---------- Proveedor B (JSON, inglés, céntimos, mm/cm, medidas a veces en descripción) ----------
function leerB() {
  const json = JSON.parse(fs.readFileSync(path.join(ORIGEN, 'proveedor-b.json'), 'utf8'));
  return json.products.map((p) => {
    let ancho = null;
    if (p.dimensions) ancho = p.dimensions.unit === 'mm' ? p.dimensions.w / 10 : p.dimensions.w;
    else {
      const m = p.description.match(/Medidas:\s*([\d.,]+)\s*x/i);
      if (m) ancho = Number(m[1].replace(',', '.'));
    }
    return {
      id: p.id, fuente: 'B', nombre: bonito(p.title),
      categoria: CATEGORIA_B[p.category],
      precio: conIva(p.price_cents / 100, p.tax_included),
      plazas: plazasDe(p.description) ?? plazasDe(p.title),
      ancho_cm: ancho == null ? null : Math.round(ancho),
      color: vocab(COLOR, p.color, 'color', p.id),
      material: vocab(MATERIAL, p.material, 'material', p.id),
      activo: p.status === 'active',
      fecha: new Date(p.updated_at),
    };
  });
}

// ---------- Fusión ----------
const todos = [...leerA(), ...leerB()];
const grupos = new Map();
for (const p of todos) {
  const k = clave(p.nombre);
  if (!grupos.has(k)) grupos.set(k, []);
  grupos.get(k).push(p);
}

const slug = (s) => sinTildes(s.toLowerCase()).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const productos = [];
const informe = [];
for (const [k, g] of grupos) {
  g.sort((a, b) => b.fecha - a.fecha);
  const reciente = g[0];
  const ids = g.map((x) => x.id);
  if (!reciente.activo) { informe.push(`DESCARTADO (descatalogado) ${ids.join('+')} ${reciente.nombre}`); continue; }
  let plazas = reciente.plazas ?? g.find((x) => x.plazas != null)?.plazas ?? null;
  // Plazas solo en sofás y sillones (categoría sofa). Sillón de 1 plaza sin número explícito
  if (reciente.categoria === 'sofa' && plazas == null && /sill[oó]n/i.test(reciente.nombre)) plazas = 1;
  if (reciente.categoria !== 'sofa') plazas = null;
  const prod = {
    sku: slug(k),
    ids_origen: ids.sort(),
    nombre: reciente.nombre,
    categoria: reciente.categoria,
    precio: reciente.precio,
    plazas,
    ancho_cm: reciente.ancho_cm ?? g.find((x) => x.ancho_cm != null)?.ancho_cm ?? null,
    color: reciente.color,
    material: reciente.material,
  };
  productos.push(prod);
  if (g.length > 1) informe.push(`FUSIONADO ${ids.join('+')} -> ${reciente.id} (${reciente.fecha.toISOString().slice(0, 10)}) ${prod.nombre} ${prod.precio}€ [otros: ${g.slice(1).map((x) => `${x.id} ${x.precio}€ ${x.fecha.toISOString().slice(0, 10)}`).join(', ')}]`);
}
productos.sort((a, b) => a.categoria.localeCompare(b.categoria) || a.nombre.localeCompare(b.nombre));

// ---------- Comprobación contra historial (precios reales con IVA) ----------
const hist = fs.readFileSync(path.join(ORIGEN, 'historial-ventas.csv'), 'utf8').trim().split('\n').slice(1);
const ultimoPrecio = {};
for (const l of hist) {
  const [, fecha, id, , pu] = l.split(',');
  if (!ultimoPrecio[id] || ultimoPrecio[id].fecha < fecha) ultimoPrecio[id] = { fecha, pu: Number(pu) };
}
for (const p of productos) {
  const hs = p.ids_origen.map((i) => ultimoPrecio[i]).filter(Boolean);
  for (const h of hs) if (Math.abs(h.pu - p.precio) > 0.001) informe.push(`  aviso precio ${p.sku}: catálogo ${p.precio} vs historial ${h.pu} (${h.fecha})`);
}

fs.writeFileSync(DESTINO, JSON.stringify({ productos }, null, 2) + '\n');
console.log(informe.join('\n'));
console.log(`\n${productos.length} productos publicados`);
for (const p of productos) console.log(`${p.sku.padEnd(42)} ${p.categoria.padEnd(13)} ${String(p.precio).padStart(8)} pl=${p.plazas ?? '-'} an=${p.ancho_cm} ${p.color}/${p.material} ${p.ids_origen.join(',')}`);
