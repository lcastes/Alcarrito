// Actualiza los precios de los productos de Firestore leyendo los enlaces
// guardados en cada opción (campo "u"). Se ejecuta desde GitHub Actions.
//
// Soportado ahora: Mercadona (API interna de su tienda online) y Dia (JSON-LD / meta de la ficha).
// Pendiente: BM y Eroski (necesitan navegador). Lidl no tiene compra online propia.
import admin from 'firebase-admin';

const CP = process.env.POSTAL_CODE || '20013';
const MAX_CHANGE = 0.6; // si el precio cambia más de un 60 %, no se aplica y se avisa
const PAUSA_MS = 700;   // pausa entre peticiones a la misma tienda

const cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || 'null');
if (!cred) { console.error('Falta el secreto FIREBASE_SERVICE_ACCOUNT'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(cred) });
const db = admin.firestore();

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };

// ---------- Mercadona ----------
let mercaWh = process.env.MERCADONA_WH || null;
async function mercadonaWarehouse() {
  if (mercaWh) return mercaWh;
  for (const method of ['POST', 'PUT']) {
    try {
      const r = await fetch('https://tienda.mercadona.es/api/postal-codes/actions/change-pc/', {
        method,
        headers: { 'content-type': 'application/json', 'user-agent': UA, accept: 'application/json' },
        body: JSON.stringify({ new_postal_code: CP }),
      });
      const wh = r.headers.get('x-customer-wh');
      if (wh) { mercaWh = wh; console.log(`Mercadona: código postal ${CP} → almacén ${wh}`); return wh; }
    } catch (e) { /* prueba el siguiente método */ }
  }
  throw new Error(`No se pudo obtener el almacén de Mercadona para el CP ${CP}. Puedes fijarlo con la variable MERCADONA_WH.`);
}
async function precioMercadona(url) {
  const m = new URL(url).pathname.match(/\/product\/(\d+)/);
  if (!m) throw new Error('el enlace no tiene el formato tienda.mercadona.es/product/NUMERO/...');
  const wh = await mercadonaWarehouse();
  const r = await fetch(`https://tienda.mercadona.es/api/products/${m[1]}/?lang=es&wh=${wh}`, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!r.ok) throw new Error(`Mercadona respondió ${r.status}`);
  const j = await r.json();
  const p = num(j?.price_instructions?.unit_price);
  if (p == null) throw new Error('no encontré price_instructions.unit_price');
  return p;
}

// ---------- Dia ----------
function buscarProducto(x) {
  if (!x || typeof x !== 'object') return null;
  if (Array.isArray(x)) { for (const y of x) { const r = buscarProducto(y); if (r) return r } return null; }
  const t = x['@type'];
  if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) return x;
  if (x['@graph']) return buscarProducto(x['@graph']);
  return null;
}
async function precioDia(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'es-ES,es;q=0.9', accept: 'text/html' } });
  if (!r.ok) throw new Error(`Dia respondió ${r.status}`);
  const html = await r.text();
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const prod = buscarProducto(JSON.parse(m[1]));
      const offers = prod && (Array.isArray(prod.offers) ? prod.offers[0] : prod.offers);
      const p = offers && num(offers.price ?? offers.lowPrice);
      if (p != null) return p;
    } catch { /* siguiente bloque */ }
  }
  const meta = html.match(/<meta[^>]+(?:property=["']product:price:amount["']|itemprop=["']price["'])[^>]*content=["']([\d.,]+)["']/i)
    || html.match(/<meta[^>]+content=["']([\d.,]+)["'][^>]+(?:property=["']product:price:amount["']|itemprop=["']price["'])/i);
  if (meta) { const p = num(meta[1]); if (p != null) return p; }
  throw new Error('no encontré el precio en la ficha (Dia puede haber cambiado la web)');
}

const TIENDAS = [
  { id: 'Mercadona', test: h => h.endsWith('mercadona.es'), leer: precioMercadona },
  { id: 'Dia', test: h => h.endsWith('dia.es'), leer: precioDia },
];
const NO_SOPORTADAS = { 'bmsupermercados.es': 'BM', 'eroski.es': 'Eroski', 'lidl.es': 'Lidl' };

// ---------- Proceso ----------
const resumen = { actualizados: 0, sinCambios: 0, errores: 0, saltados: 0, sospechosos: 0, noSoportados: 0 };
const cacheUrl = new Map(); // url → Promise<precio>
const ultima = {};          // tienda → momento de la última petición

async function leerPrecio(tienda, url) {
  if (!cacheUrl.has(url)) {
    cacheUrl.set(url, (async () => {
      const espera = PAUSA_MS - (Date.now() - (ultima[tienda.id] || 0));
      if (espera > 0) await sleep(espera);
      ultima[tienda.id] = Date.now();
      return tienda.leer(url);
    })());
  }
  return cacheUrl.get(url);
}

const snap = await db.collection('products').get();
console.log(`Productos en Firestore: ${snap.size}`);

for (const docSnap of snap.docs) {
  const p = docSnap.data();
  const trabajos = [];
  for (const [sid, e] of Object.entries(p.e || {})) {
    (e.o || []).forEach((o, i) => { if (o && o.u) trabajos.push({ sid, i, url: o.u }) });
  }
  if (!trabajos.length) continue;

  const nuevos = []; // {sid,i,url,precio}
  for (const t of trabajos) {
    let host;
    try { host = new URL(t.url).hostname.replace(/^www\./, '').replace(/^tienda\./, ''); }
    catch { console.warn(`✗ ${p.name}: enlace no válido (${t.url})`); resumen.errores++; continue; }
    const tienda = TIENDAS.find(x => x.test(new URL(t.url).hostname));
    if (!tienda) {
      const k = Object.keys(NO_SOPORTADAS).find(d => host.endsWith(d));
      console.log(`– ${p.name}: ${k ? NO_SOPORTADAS[k] : host} todavía no está soportado, se deja el precio a mano`);
      resumen.noSoportados++; continue;
    }
    try {
      const precio = await leerPrecio(tienda, t.url);
      nuevos.push({ ...t, precio, tienda: tienda.id });
    } catch (err) {
      console.warn(`✗ ${p.name} (${tienda.id}): ${err.message}`);
      resumen.errores++;
    }
  }
  if (!nuevos.length) continue;

  // Escritura con transacción para no pisar cambios hechos desde la app mientras corre el script
  await db.runTransaction(async tx => {
    const fresco = await tx.get(docSnap.ref);
    const e = fresco.data().e || {};
    let cambiado = false;
    for (const n of nuevos) {
      const o = e[n.sid]?.o?.[n.i];
      if (!o || o.u !== n.url) { resumen.saltados++; continue; }
      const viejo = o.price || 0;
      if (viejo > 0 && Math.abs(n.precio - viejo) / viejo > MAX_CHANGE) {
        console.warn(`⚠ ${p.name} (${n.tienda}): ${viejo} → ${n.precio} € parece un error, no se aplica`);
        resumen.sospechosos++; continue;
      }
      o.pu = new Date().toISOString();
      if (Math.abs(n.precio - viejo) < 0.005) { resumen.sinCambios++; cambiado = true; continue; }
      console.log(`✓ ${p.name} (${n.tienda}): ${viejo || '—'} → ${n.precio} €`);
      o.price = Math.round(n.precio * 100) / 100;
      resumen.actualizados++; cambiado = true;
    }
    if (cambiado) tx.update(docSnap.ref, { e });
  });
}

console.log('\nResumen:', resumen);
const total = resumen.actualizados + resumen.sinCambios + resumen.errores + resumen.sospechosos;
if (total > 0 && resumen.errores / total > 0.5) { console.error('Más de la mitad de los precios han fallado.'); process.exit(1); }
