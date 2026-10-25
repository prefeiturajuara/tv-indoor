/* =====================================================================
 *  TV INDOOR - Player (página aberta na TV)  -  Prefeitura de Juara/MT
 * =====================================================================
 *  Endereço: https://.../tv-indoor/?tv=CODIGO      (diagnóstico: &debug=1)
 *
 *  Como funciona:
 *   1. Busca a programação no Apps Script a cada X minutos.
 *   2. Baixa cada foto/vídeo/PDF UMA vez e guarda no aparelho (IndexedDB).
 *   3. Exibe em loop só o que já foi baixado e está dentro do período.
 *   4. Sem internet: continua com a última programação guardada.
 * ===================================================================== */
'use strict';

const PARAMS = new URLSearchParams(location.search);
const CODIGO = (PARAMS.get('tv') || '').trim();
const DEBUG = PARAMS.has('debug');
const CHAVE_PROGRAMA = 'tvindoor_programa_' + CODIGO;
const CHAVE_VERSOES = 'tvindoor_versoes';
const INICIO_PAGINA = Date.now();

const palco = document.getElementById('palco');

// Estado geral do player
const estado = {
  programa: null,          // última programação recebida (ou guardada)
  offsetRelogio: 0,        // diferença entre o relógio do Google e o da TV
  emCache: new Map(),      // id do arquivo -> versão guardada no aparelho
  molduraUrl: null,        // imagem da moldura pronta para uso
  molduraId: null,
  sessao: 0,               // muda a cada troca de mídia (evita "fantasmas")
  chaveAtual: null,        // mídia em exibição
  emEspera: false,
  falhasSeguidas: 0,
  baixando: false,
  codigoInvalido: false,
  timerAtualizacao: null
};

// =====================================================================
//  Utilidades
// =====================================================================
function log(...args) {
  const linha = new Date().toLocaleTimeString('pt-BR') + ' ' + args.join(' ');
  console.log(linha);
  if (!DEBUG) return;
  const d = document.getElementById('debug');
  d.style.display = 'block';
  d.textContent = (linha + '\n' + d.textContent).split('\n').slice(0, 18).join('\n');
}

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));
const agoraServidor = () => Date.now() + estado.offsetRelogio;

function mostrarAviso(titulo, texto) {
  document.getElementById('aviso-titulo').textContent = titulo;
  document.getElementById('aviso-texto').innerHTML = texto;
  document.getElementById('aviso').style.display = 'flex';
}
function esconderAviso() { document.getElementById('aviso').style.display = 'none'; }

/** Mantém o palco 1920x1080 ajustado ao tamanho real da tela */
function ajustarPalco() {
  const escala = Math.min(innerWidth / 1920, innerHeight / 1080);
  palco.style.transform = `translate(-50%, -50%) scale(${escala})`;
}

// =====================================================================
//  Armazenamento local dos arquivos (IndexedDB = "gaveta" do navegador)
// =====================================================================
let bancoPromessa = null;
function abrirBanco() {
  if (!bancoPromessa) {
    bancoPromessa = new Promise((ok, erro) => {
      const req = indexedDB.open('tvindoor', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('arquivos');
      req.onsuccess = () => ok(req.result);
      req.onerror = () => erro(req.error);
    });
  }
  return bancoPromessa;
}
async function operar(modo, acao) {
  const db = await abrirBanco();
  return new Promise((ok, erro) => {
    const tx = db.transaction('arquivos', modo);
    const req = acao(tx.objectStore('arquivos'));
    tx.oncomplete = () => ok(req && req.result);
    tx.onerror = () => erro(tx.error);
    tx.onabort = () => erro(tx.error);
  });
}
const guardarArquivo = (id, blob) => operar('readwrite', (s) => s.put(blob, id));
const pegarArquivo = (id) => operar('readonly', (s) => s.get(id));
const apagarArquivo = (id) => operar('readwrite', (s) => s.delete(id));

function salvarVersoes() {
  try { localStorage.setItem(CHAVE_VERSOES, JSON.stringify([...estado.emCache])); } catch (e) { /* cheio */ }
}
function carregarVersoes() {
  try { estado.emCache = new Map(JSON.parse(localStorage.getItem(CHAVE_VERSOES) || '[]')); }
  catch (e) { estado.emCache = new Map(); }
}

// =====================================================================
//  Comunicação com o Apps Script
// =====================================================================
async function chamarApi(params) {
  const url = API_URL + '?' + new URLSearchParams(params).toString();
  const controle = new AbortController();
  const limite = setTimeout(() => controle.abort(), 90000);
  try {
    const r = await fetch(url, { signal: controle.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(limite); }
}

function agendarAtualizacao(minutos) {
  clearTimeout(estado.timerAtualizacao);
  estado.timerAtualizacao = setTimeout(atualizarPrograma, Math.max(1, minutos) * 60000);
}

/** Busca a programação nova. Não interrompe a mídia em exibição. */
async function atualizarPrograma() {
  let resp;
  try {
    resp = await chamarApi({ acao: 'programa', tv: CODIGO });
  } catch (e) {
    log('Sem conexão com o Google:', e.message, '- tento de novo em 1 min');
    agendarAtualizacao(1);
    return;
  }

  if (!resp.ok) {
    if (resp.codigoInvalido) {
      estado.codigoInvalido = true;
      estado.sessao++;
      try { localStorage.removeItem(CHAVE_PROGRAMA); } catch (e) { /* */ }
      mostrarAviso('Código de TV inválido',
        `O código <b>${CODIGO.replace(/</g, '')}</b> não está cadastrado na aba <b>TVs</b> da planilha.<br>` +
        'Confira o endereço aberto nesta TV.');
      agendarAtualizacao(5);
      return;
    }
    log('Erro do servidor:', resp.erro);
    agendarAtualizacao(2);
    return;
  }

  // Código válido (de novo): volta a exibir
  if (estado.codigoInvalido) { estado.codigoInvalido = false; esconderAviso(); }
  estado.offsetRelogio = resp.agora - Date.now();
  estado.programa = resp;
  try { localStorage.setItem(CHAVE_PROGRAMA, JSON.stringify(resp)); } catch (e) { /* */ }
  log(`Programação: ${resp.itens.length} itens para "${resp.tv.nome}"`);
  agendarAtualizacao(resp.config.intervalo || 5);

  await prepararMoldura();
  if (estado.emEspera || !estado.chaveAtual) proximo();
  baixarPendentes().then(limparArquivosAntigos);
}

// =====================================================================
//  Download dos arquivos (em partes de 4 MB) e limpeza
// =====================================================================
function arquivosNecessarios() {
  const p = estado.programa;
  if (!p) return [];
  const lista = [];
  if (p.moldura) lista.push({ id: p.moldura.id, versao: p.moldura.versao });
  // Primeiro o que já está no período, depois os futuros
  const agora = agoraServidor();
  const ordenados = p.itens.filter((i) => i.tipo !== 'youtube')
    .sort((a, b) => ((a.inicio || 0) > agora) - ((b.inicio || 0) > agora));
  ordenados.forEach((i) => lista.push({ id: i.id, versao: i.versao }));
  const vistos = new Set();
  return lista.filter((a) => !vistos.has(a.id) && vistos.add(a.id));
}

function base64ParaBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function baixarArquivo(id, versao) {
  const partes = [];
  let total = 1, mime = 'application/octet-stream';
  for (let n = 0; n < total; n++) {
    const r = await chamarApi({ acao: 'arquivo', tv: CODIGO, id: id, parte: n });
    if (!r.ok) throw new Error(r.erro || 'falha no download');
    total = r.partes; mime = r.mime;
    partes.push(base64ParaBytes(r.dados));
    log(`Baixando ${id.slice(0, 6)}… parte ${n + 1}/${total}`);
  }
  await guardarArquivo(id, new Blob(partes, { type: mime }));
  estado.emCache.set(id, versao);
  salvarVersoes();
}

async function baixarPendentes() {
  if (estado.baixando) return;
  estado.baixando = true;
  try {
    for (const a of arquivosNecessarios()) {
      if (estado.emCache.get(a.id) === a.versao) continue;
      try {
        await baixarArquivo(a.id, a.versao);
        log('Arquivo guardado:', a.id.slice(0, 6));
        if (estado.programa.moldura && a.id === estado.programa.moldura.id) await prepararMoldura();
        if (estado.emEspera) proximo(); // algo novo já pode ser exibido
      } catch (e) {
        log('Falha ao baixar', a.id.slice(0, 6), e.message);
      }
    }
  } finally { estado.baixando = false; }
}

/** Apaga do aparelho os arquivos que saíram da programação */
async function limparArquivosAntigos() {
  const usados = new Set(arquivosNecessarios().map((a) => a.id));
  for (const id of [...estado.emCache.keys()]) {
    if (!usados.has(id)) {
      try { await apagarArquivo(id); } catch (e) { /* */ }
      estado.emCache.delete(id);
    }
  }
  salvarVersoes();
}

async function prepararMoldura() {
  const m = estado.programa && estado.programa.moldura;
  const novoId = (m && estado.emCache.has(m.id)) ? m.id : null;
  if (novoId === estado.molduraId && (novoId === null || estado.molduraUrl)) return;
  if (estado.molduraUrl) URL.revokeObjectURL(estado.molduraUrl);
  estado.molduraUrl = null;
  estado.molduraId = null;
  if (!novoId) return;
  const blob = await pegarArquivo(novoId).catch(() => null);
  if (blob) { estado.molduraUrl = URL.createObjectURL(blob); estado.molduraId = novoId; }
}

// =====================================================================
//  Sequência de exibição
// =====================================================================
function itensDisponiveis() {
  const p = estado.programa;
  if (!p) return [];
  const agora = agoraServidor();
  return p.itens.filter((it) =>
    (!it.inicio || it.inicio <= agora) && (!it.fim || it.fim >= agora) &&
    (it.tipo === 'youtube' ? navigator.onLine : estado.emCache.has(it.id)));
}

/** Passa para a próxima mídia (chamada ao fim de cada uma) */
function proximo() {
  const token = ++estado.sessao;
  if (estado.codigoInvalido) return;
  const lista = itensDisponiveis();
  if (!lista.length) { mostrarEspera(token); return; }
  if (estado.falhasSeguidas >= lista.length) { // tudo falhou: descansa 30 s
    estado.falhasSeguidas = 0;
    mostrarEspera(token, 30000);
    return;
  }
  const atual = lista.findIndex((it) => it.chave === estado.chaveAtual);
  const item = lista[(atual + 1) % lista.length];
  estado.chaveAtual = item.chave;
  estado.emEspera = false;
  log('Exibindo:', item.tipo, '-', item.titulo);

  exibir(item, token).then(() => { estado.falhasSeguidas = 0; }).catch((e) => {
    if (token !== estado.sessao) return;
    log('Erro em', item.titulo, ':', e.message, '- pulando');
    estado.falhasSeguidas++;
    if (/arquivo/.test(e.message)) { estado.emCache.delete(item.id); salvarVersoes(); }
    limparCamadasInvisiveis();
    setTimeout(() => { if (token === estado.sessao) proximo(); }, 500);
  });
}

function exibir(item, token) {
  switch (item.tipo) {
    case 'foto': return exibirFoto(item, token);
    case 'video': return exibirVideo(item, token);
    case 'pdf': return exibirPdf(item, token);
    case 'youtube': return exibirYoutube(item, token);
    default: return Promise.reject(new Error('tipo desconhecido'));
  }
}

function duracaoDe(item) {
  return (item.duracao || (estado.programa && estado.programa.config.duracaoPadrao) || 10) * 1000;
}
function depoisDe(token, ms) {
  setTimeout(() => { if (token === estado.sessao) proximo(); }, ms);
}

// =====================================================================
//  Camadas (cada mídia entra por cima da anterior com esmaecimento)
// =====================================================================
function novaCamada() {
  const c = document.createElement('div');
  c.className = 'camada';
  c._urls = [];
  palco.appendChild(c);
  return c;
}
function revelarCamada(nova) {
  requestAnimationFrame(() => requestAnimationFrame(() => nova.classList.add('visivel')));
  const antigas = [...palco.querySelectorAll('.camada')].filter((c) => c !== nova);
  setTimeout(() => antigas.forEach(destruirCamada), 1000);
}
function destruirCamada(c) {
  c.querySelectorAll('video').forEach((v) => { v.pause(); v.removeAttribute('src'); v.load(); });
  if (c._yt) { try { c._yt.destroy(); } catch (e) { /* */ } }
  if (c._vigia) clearInterval(c._vigia);
  c._urls.forEach((u) => URL.revokeObjectURL(u));
  c.remove();
}
function limparCamadasInvisiveis() {
  palco.querySelectorAll('.camada:not(.visivel)').forEach(destruirCamada);
}

/** Fundo desfocado feito a partir da própria mídia (miniatura ampliada) */
function fundoDesfocado(el) {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 36;
  try { cv.getContext('2d').drawImage(el, 0, 0, 64, 36); } catch (e) { /* */ }
  cv.className = 'fundo';
  return cv;
}

/**
 * Posiciona a mídia conforme o formato:
 *  - horizontal: tela cheia (com fundo desfocado se não for exatamente 16:9)
 *  - vertical com moldura: dentro da área à direita da moldura
 *  - vertical sem moldura: centralizada sobre fundo desfocado
 * Devolve o elemento onde o texto deve ser colocado.
 */
function posicionar(camada, el, largura, altura) {
  const vertical = altura > largura;
  el.classList.add('cheia');
  if (vertical && estado.molduraUrl) {
    const m = document.createElement('img');
    m.src = estado.molduraUrl; m.className = 'moldura';
    camada.appendChild(m);
    const a = estado.programa.config.area;
    const area = document.createElement('div');
    area.className = 'area';
    Object.assign(area.style, { left: a.x + 'px', top: a.y + 'px', width: a.l + 'px', height: a.a + 'px' });
    area.appendChild(fundoDesfocado(el));
    area.appendChild(el);
    camada.appendChild(area);
    return area;
  }
  camada.appendChild(fundoDesfocado(el));
  camada.appendChild(el);
  return camada;
}

/** Texto animado sobre a mídia (coluna "Texto na tela"). 1ª linha = título. */
function colocarTexto(onde, item, duracaoMs) {
  if (!item.texto) return;
  const linhas = item.texto.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const box = document.createElement('div');
  box.className = 'legenda';
  const faixa = document.createElement('div'); faixa.className = 'faixa';
  const h1 = document.createElement('h1'); h1.textContent = linhas[0] || '';
  box.append(faixa, h1);
  if (linhas.length > 1) {
    const p = document.createElement('p'); p.textContent = linhas.slice(1).join(' ');
    box.appendChild(p);
  }
  onde.appendChild(box);
  // O texto sai um pouco antes da mídia trocar
  if (duracaoMs && duracaoMs > 3000) setTimeout(() => box.classList.add('saindo'), duracaoMs - 1200);
}

async function urlDoArquivo(item, camada) {
  const blob = await pegarArquivo(item.id).catch(() => null);
  if (!blob) throw new Error('arquivo não está no aparelho');
  const url = URL.createObjectURL(blob);
  camada._urls.push(url);
  return url;
}

// =====================================================================
//  Tipos de mídia
// =====================================================================
async function exibirFoto(item, token) {
  const c = novaCamada();
  const img = new Image();
  img.src = await urlDoArquivo(item, c);
  await img.decode().catch(() => { throw new Error('imagem com defeito'); });
  if (token !== estado.sessao) { destruirCamada(c); return; }
  const dur = duracaoDe(item);
  const onde = posicionar(c, img, img.naturalWidth, img.naturalHeight);
  if (estado.programa.config.animacao) {
    img.style.setProperty('--dur', (dur / 1000 + 1) + 's');
    img.classList.add('zoom');
  }
  colocarTexto(onde, item, dur);
  revelarCamada(c);
  depoisDe(token, dur);
}

async function exibirVideo(item, token) {
  const c = novaCamada();
  const v = document.createElement('video');
  v.muted = true; v.defaultMuted = true; v.playsInline = true; v.preload = 'auto';
  v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
  v.src = await urlDoArquivo(item, c);
  await new Promise((ok, erro) => {
    v.onloadeddata = ok;
    v.onerror = () => erro(new Error('vídeo com defeito ou formato não suportado'));
    setTimeout(() => erro(new Error('vídeo demorou para abrir')), 15000);
  });
  if (token !== estado.sessao) { destruirCamada(c); return; }
  const onde = posicionar(c, v, v.videoWidth, v.videoHeight);
  await v.play().catch(() => { throw new Error('o navegador bloqueou o vídeo'); });
  const dur = item.duracao ? item.duracao * 1000 : (v.duration || 0) * 1000;
  colocarTexto(onde, item, dur);
  revelarCamada(c);

  v.onended = () => { if (token === estado.sessao) proximo(); };
  v.onerror = () => { if (token === estado.sessao) proximo(); };
  if (item.duracao) depoisDe(token, item.duracao * 1000);           // duração definida na planilha
  else depoisDe(token, ((v.duration || 600) + 10) * 1000);          // segurança, caso "ended" falhe
  // Vigia: se o vídeo travar por 15 s, pula
  let ultimo = -1, parado = 0;
  c._vigia = setInterval(() => {
    if (token !== estado.sessao) return;
    parado = (v.currentTime === ultimo) ? parado + 1 : 0;
    ultimo = v.currentTime;
    if (parado >= 3) { log('Vídeo travou - pulando'); proximo(); }
  }, 5000);
}

async function exibirPdf(item, token) {
  if (!window.pdfjsLib) throw new Error('leitor de PDF não carregou');
  const blob = await pegarArquivo(item.id).catch(() => null);
  if (!blob) throw new Error('arquivo não está no aparelho');
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const dur = duracaoDe(item);
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      if (token !== estado.sessao) return;
      const pagina = await pdf.getPage(n);
      const vp1 = pagina.getViewport({ scale: 1 });
      const vertical = vp1.height > vp1.width;
      const a = estado.programa.config.area;
      const [alvoL, alvoA] = (vertical && estado.molduraUrl) ? [a.l, a.a] : [1920, 1080];
      const vp = pagina.getViewport({ scale: Math.min(alvoL / vp1.width, alvoA / vp1.height) });
      const cv = document.createElement('canvas');
      cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      await pagina.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
      if (token !== estado.sessao) return;
      const c = novaCamada();
      const onde = posicionar(c, cv, cv.width, cv.height);
      if (n === 1) colocarTexto(onde, item, dur);
      revelarCamada(c);
      await esperar(dur);
    }
  } finally { pdf.destroy(); }
  if (token === estado.sessao) proximo();
}

// ---------- YouTube (só com internet; se falhar, pula) ----------
let apiYoutube = null;
function carregarApiYoutube() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (!apiYoutube) {
    apiYoutube = new Promise((ok, erro) => {
      window.onYouTubeIframeAPIReady = ok;
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { apiYoutube = null; erro(new Error('YouTube indisponível')); };
      document.head.appendChild(s);
      setTimeout(() => { if (!(window.YT && window.YT.Player)) { apiYoutube = null; erro(new Error('YouTube indisponível')); } }, 15000);
    });
  }
  return apiYoutube;
}

async function exibirYoutube(item, token) {
  if (!navigator.onLine) throw new Error('sem internet');
  await carregarApiYoutube();
  if (token !== estado.sessao) return;
  const c = novaCamada();
  let caixa;
  if (item.vertical && estado.molduraUrl) {
    const m = document.createElement('img'); m.src = estado.molduraUrl; m.className = 'moldura';
    c.appendChild(m);
    const a = estado.programa.config.area;
    caixa = document.createElement('div'); caixa.className = 'area youtube';
    Object.assign(caixa.style, { left: a.x + 'px', top: a.y + 'px', width: a.l + 'px', height: a.a + 'px' });
  } else if (item.vertical) {
    caixa = document.createElement('div'); caixa.className = 'area youtube';
    Object.assign(caixa.style, { left: '656px', top: '0', width: '608px', height: '1080px' });
  } else {
    caixa = document.createElement('div'); caixa.className = 'cheia youtube';
  }
  const alvo = document.createElement('div');
  caixa.appendChild(alvo);
  c.appendChild(caixa);

  await new Promise((ok, erro) => {
    let comecou = false, ultimo = -1, parado = 0;
    const limite = setTimeout(() => { if (!comecou) erro(new Error('YouTube não começou a tocar')); }, 20000);
    c._yt = new YT.Player(alvo, {
      videoId: item.id, width: '100%', height: '100%',
      playerVars: { autoplay: 1, mute: 1, controls: 0, rel: 0, playsinline: 1, modestbranding: 1,
        iv_load_policy: 3, disablekb: 1, fs: 0 },
      events: {
        onReady: (e) => { e.target.mute(); e.target.playVideo(); },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.PLAYING && !comecou) {
            comecou = true; clearTimeout(limite);
            revelarCamada(c);
            if (item.duracao) depoisDe(token, item.duracao * 1000);
            // Vigia: se travar por 30 s, pula
            c._vigia = setInterval(() => {
              if (token !== estado.sessao) return;
              const t = c._yt.getCurrentTime ? c._yt.getCurrentTime() : 0;
              parado = (t === ultimo) ? parado + 1 : 0; ultimo = t;
              if (parado >= 3) proximo();
            }, 10000);
            ok();
          }
          if (e.data === YT.PlayerState.ENDED && token === estado.sessao) proximo();
        },
        onError: () => {
          clearTimeout(limite);
          if (comecou) { if (token === estado.sessao) proximo(); } else erro(new Error('erro no YouTube'));
        }
      }
    });
  });
}

// ---------- Tela de espera (nada programado) ----------
function mostrarEspera(token, ms) {
  if (!estado.emEspera || !palco.querySelector('.camada.espera')) {
    const c = novaCamada();
    c.classList.add('espera');
    if (estado.molduraUrl) {
      const m = document.createElement('img'); m.src = estado.molduraUrl; m.className = 'moldura';
      c.appendChild(m);
    } else {
      const t = document.createElement('div'); t.className = 'espera-texto';
      t.textContent = 'Prefeitura de Juara';
      c.appendChild(t);
    }
    revelarCamada(c);
  }
  estado.emEspera = true;
  estado.chaveAtual = null;
  depoisDe(token, ms || 15000);
}

// =====================================================================
//  Manter a tela ligada, reinício diário e início
// =====================================================================
async function manterTelaLigada() {
  try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch (e) { /* */ }
}

function reinicioDiario() {
  // Recarrega a página uma vez por madrugada (03h) para liberar memória
  setInterval(() => {
    if (Date.now() - INICIO_PAGINA > 20 * 3600000 && new Date().getHours() === 3) location.reload();
  }, 10 * 60000);
}

async function iniciar() {
  ajustarPalco();
  addEventListener('resize', ajustarPalco);

  if (!CODIGO) {
    mostrarAviso('Falta o código da TV', 'Abra o endereço com o código no final, por exemplo:<br>' +
      '<b>' + location.origin + location.pathname + '?tv=SEU-CODIGO</b>');
    return;
  }
  if (typeof API_URL === 'undefined' || !/^https?:\/\//.test(API_URL)) {
    mostrarAviso('Player não configurado', 'Edite o arquivo <b>config.js</b> e cole o endereço do Apps Script.');
    return;
  }

  // Guarda a própria página para abrir mesmo sem internet
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  manterTelaLigada();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') manterTelaLigada();
  });
  addEventListener('online', () => { log('Internet voltou'); atualizarPrograma(); });
  reinicioDiario();

  // 1) Começa com a última programação guardada (funciona sem internet)
  carregarVersoes();
  try {
    const salvo = JSON.parse(localStorage.getItem(CHAVE_PROGRAMA) || 'null');
    if (salvo) {
      estado.programa = salvo;
      estado.offsetRelogio = 0;
      log('Usando programação guardada');
      await prepararMoldura();
    }
  } catch (e) { /* */ }
  proximo();

  // 2) Busca a programação atualizada
  atualizarPrograma();
}

iniciar();
