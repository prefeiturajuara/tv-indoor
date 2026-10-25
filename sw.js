/* =====================================================================
 *  TV INDOOR - "Service worker"
 *  Guarda a própria página do player no aparelho, para que a TV consiga
 *  abrir o player mesmo se for ligada sem internet.
 *  (As fotos e vídeos são guardados à parte, pelo player.js.)
 * ===================================================================== */
const CACHE = 'tvindoor-v1';
const ESSENCIAIS = [
  './', './index.html', './player.js', './config.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
];
// Endereços externos que também podem ser guardados
const EXTERNOS_OK = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) =>
    Promise.all(ESSENCIAIS.map((u) => c.add(u).catch(() => null)))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((nomes) =>
    Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n)))));
  self.clients.claim();
});

// Primeiro tenta a internet (para receber atualizações); se falhar, usa o guardado
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const permitido = url.origin === self.location.origin || EXTERNOS_OK.includes(url.hostname);
  if (!permitido) return; // Apps Script e YouTube passam direto

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const resp = await Promise.race([
        fetch(req),
        new Promise((_, erro) => setTimeout(() => erro(new Error('lento')), 8000))
      ]);
      if (resp && (resp.ok || resp.type === 'opaque')) cache.put(req, resp.clone());
      return resp;
    } catch (err) {
      const guardado = await cache.match(req, { ignoreSearch: url.origin === self.location.origin });
      return guardado || Response.error();
    }
  })());
});
