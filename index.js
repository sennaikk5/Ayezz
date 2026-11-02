/*
 * Spade v8.1.0 — memória e organização para UMA IA só (SillyTavern).
 * Tudo num arquivo, sem import: o SillyTavern só é lido por SillyTavern.getContext().
 *
 * O que a v8 é (SPEC v8 + adendo A): um prompt SEMPRE na mesma ordem e curto,
 * uma memória em 3 gavetas com orçamento de tokens, uma Biblioteca de arquivos
 * em pastas (a IA lê só a NOTA, nunca o arquivo), chats conectáveis, o pedido
 * do Espaço valendo na próxima fala do RP, e um "estilo guiado" medido por código.
 * Quem GERA a fala é sempre o SillyTavern; a Spade só alimenta o prompt dele.
 *
 * Organização deste arquivo (seções numeradas, na ordem em que dependem uma da outra):
 *  01 base · 02 config · 03 armazenamento (disco via plugin + reserva no navegador)
 *  04 Biblioteca (dados e seleção por orçamento) · 05 Descrição, Memória, conexões
 *  06 regras, repetição, pensamento · 06b relógio da história (8.1.0) · 07 estilo guiado (medir, exemplos, girar, conferir)
 *  08 compositor do prompt · 09 entrega ao SillyTavern (slots, eventos, interceptor)
 *  10 IA e jobs · 11 backup, exportação e migração · 12 Espaço (conversas, 1:1, conexões)
 *  13 interface · 14 início
 */
(function () {
'use strict';

// Erro fatal sempre aparece na tela (nada de catch que engole em silêncio).
function reportFatalError(err) {
    console.error('[Spade] ERRO:', err);
    try {
        let box = document.getElementById('spd-fatal');
        if (!box) {
            box = document.createElement('div');
            box.id = 'spd-fatal';
            box.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:2147483647;background:#241515;color:#e9b3b3;border:1px solid #b85a5a;border-radius:12px;padding:12px 16px;max-width:min(440px,92vw);font:12px/1.4 monospace;white-space:pre-wrap;box-shadow:0 8px 30px rgba(0,0,0,.6)';
            box.addEventListener('click', () => box.remove());
            document.body.appendChild(box);
        }
        box.textContent = 'Spade — erro (toque pra fechar):\n' + (err && err.stack ? err.stack : String(err));
    } catch (_) { /* sem DOM ainda: o console já tem o erro */ }
}

try {

// ============================================================
// 01 BASE
// ============================================================
function ctx() { return SillyTavern.getContext(); }
const { eventSource, event_types } = ctx();
const VERSAO = '8.1.0';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newId = (pre = 'a') => pre + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
// Estimativa única usada em TODA a conta de orçamento (determinística). A Prévia mostra também a
// contagem real do SillyTavern quando ela existir, marcando qual é qual.
const estimarTokens = (t) => Math.ceil(String(t || '').length / 3.5);
function fmtRel(ts) {
    if (!ts) return '';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'agora';
    if (s < 3600) return 'há ' + Math.floor(s / 60) + ' min';
    if (s < 86400) return 'há ' + Math.floor(s / 3600) + ' h';
    return 'há ' + Math.floor(s / 86400) + ' d';
}
const fmtNum = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.', ',') + 'k' : String(n));
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function resolveCharacterName() {
    const c = ctx();
    if (c.characterId != null && Array.isArray(c.characters) && c.characters[c.characterId]) {
        const nm = c.characters[c.characterId].name;
        if (nm && nm !== 'SillyTavern System' && nm !== 'System') return nm;
    }
    if (c.name2 && c.name2 !== 'SillyTavern System' && c.name2 !== 'System') return c.name2;
    return 'Personagem';
}
const personagemAtual = resolveCharacterName; // memória é POR PERSONAGEM (atravessa chats), como na v7
function stChatIdAtual() { return typeof ctx().getCurrentChatId === 'function' ? (ctx().getCurrentChatId() || null) : null; }
const chatIdParaDisco = () => stChatIdAtual() || 'sem-chat';

// Ícones: traço fino, pontas arredondadas (família Lucide/Feather), desenhados à mão.
const IC = {
    plus: 'M12 5v14M5 12h14', x: 'M18 6 6 18M6 6l12 12', check: 'M5 12.5l4.5 4.5L19 7.5', back: 'M15 18l-6-6 6-6', next: 'M9 18l6-6-6-6',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>',
    book: 'M3 5.5A1.5 1.5 0 0 1 4.5 4H9c1.7 0 3 1 3 2.6V20c0-1.2-1.2-2-2.6-2H4.5A1.5 1.5 0 0 1 3 16.5zM21 5.5A1.5 1.5 0 0 0 19.5 4H15c-1.7 0-3 1-3 2.6V20c0-1.2 1.2-2 2.6-2h4.9a1.5 1.5 0 0 0 1.5-1.5z',
    chat: 'M20.5 11.5A8 8 0 0 1 9 18.7L4 20l1.4-4.6A8 8 0 1 1 20.5 11.5z',
    panel: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M9.5 4.5v15"/>',
    sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9<circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    doc: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
    spark: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16v4M17 18h4',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeoff: 'M3 3l18 18M10.6 5.2A9.8 9.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.8M6.5 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.5 9.5 0 0 0 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2',
    up: 'M12 19V5M5 12l7-7 7 7', trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
    pen: 'M4 20l4-1 11-11-3-3L5 16z', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    refresh: 'M20 11A8 8 0 0 0 5.6 6.6L4 8M4 4v4h4M4 13a8 8 0 0 0 14.4 4.4L20 16M20 20v-4h-4',
    home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10', layers: 'M12 3l9 5-9 5-9-5zM3 12.5l9 5 9-5M3 17l9 5 9-5',
    list: 'M8 6h12M8 12h12M8 18h12M3.5 6h.01M3.5 12h.01M3.5 18h.01', user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.7 1-5.9L3.5 9.7l5.9-.8z',
    ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>', play: 'M7 4.5l12 7.5-12 7.5z', stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    wave: 'M5 10v4M9 6v12M13 9v6M17 4v16M21 11v2', menu: 'M4 7h16M4 12h16M4 17h16', down: 'M6 9l6 6 6-6',
};
function ic(nome, tam = 18, extra = '') {
    const d = IC[nome] || '';
    const corpo = d.startsWith('<') ? d : d.split('<')[0] ? '<path d="' + d.split('<')[0] + '"/>' + (d.includes('<') ? d.slice(d.indexOf('<')) : '') : d;
    return '<svg class="spd-ic ' + extra + '" width="' + tam + '" height="' + tam + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + corpo + '</svg>';
}

// ============================================================
// 02 CONFIG — pequena, em localStorage (a apiKey NUNCA vai pro disco do plugin)
// ============================================================
const CFG_KEY = 'spade_config_v6'; // mesma chave da v7: a apiKey do usuário continua valendo
const CFG_PADRAO = {
    apiKey: '',
    modelo: 'xiaomi/mimo-v2.6-pro',   // "uma IA só" (decisão 1)
    modeloVisao: '',                  // opcional; vazio = não analisa imagem
    limiteGeral: 8000, limiteRp: 3000, limiteEspaco: 1500, limiteBiblioteca: 3500, // 7.2 — valores iniciais RECOMENDADOS, ajustáveis
    limiteDescricao: 600,             // aviso (não corta) na tela da Descrição
    tamanhoNota: 'padrao',            // 'curta' | 'padrao' | 'longa' — 8.4 (padrão 120–400 tokens)
    pessoaPensamento: 1,              // 11.4 — 1ª, 2ª ou 3ª pessoa
    espacoMaxMensagens: 6,            // 12.2
    espacoParaRp: true,               // chave geral Espaço→RP
    tiquesCadastrados: [],            // 11.2 — "os tiques que enjoei"
    thinkingNosJobs: 'disabled',      // 'disabled' | 'enabled' | 'padrao' (não envia o parâmetro) — 14, item 10: NÃO testado
    avisoArquivoTokens: 60000,        // 8.1 — acima disso a análise pede confirmação
    estiloModo: 'leve',               // adendo A: 'desligado' | 'leve' | 'forte'
    ultimaPasta: null,
};
const CFG_REMOVIDOS = ['modeloEmbed', 'cooldownOciosoMs', 'decayDiasMin', 'maxIteracoesAgente', 'modeloRapido', 'modeloConstrutor']; // somem do que é salvo (15.3 / 7.4)
function getConfig() {
    let cfg = {};
    try { cfg = JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch (_) { cfg = {}; }
    if (!cfg.modelo && cfg.modeloEscritor) cfg.modelo = cfg.modeloEscritor; // 15.3: modeloEscritor → modelo
    return Object.assign({}, CFG_PADRAO, cfg);
}
function setConfig(patch) {
    const base = getConfig();
    const prox = Object.assign(base, patch);
    CFG_REMOVIDOS.forEach((k) => delete prox[k]);
    delete prox.modeloEscritor;
    localStorage.setItem(CFG_KEY, JSON.stringify(prox));
    return prox;
}

// Tipos de arquivo: 4 fixos (cores medidas nas imagens) + os que o usuário criar (índice da Biblioteca).
const TIPOS_BASE = [
    { id: 'tom', nome: 'tom', cor: '#a99cff', icone: 'wave', base: true },
    { id: 'lore', nome: 'lore', cor: '#e2b873', icone: 'book', base: true },
    { id: 'regra', nome: 'regra', cor: '#6fcfbc', icone: 'check', base: true },     // `regra` tem significado especial (8.6)
    { id: 'documento', nome: 'documento', cor: '#8fb4ee', icone: 'lines', base: true },
];
const CORES_PASTA = ['#f6bace', '#9498b0', '#f6f6f8', '#c4c6d2', '#a99cff', '#e2b873', '#6fcfbc', '#8fb4ee'];
const EXTENSOES_TEXTO = ['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.yaml', '.yml', '.log'];

// ============================================================
// 03 ARMAZENAMENTO
// Disco (plugin spade-fs) é a fonte da verdade; o navegador (IndexedDB) é só RESERVA quando o plugin não
// responde — e quando isso acontece a tela mostra uma faixa (16.4). Nunca finge que salvou no disco.
// ============================================================
const IDB_NAME = 'spade_db_v6'; // mesmo banco da v7: o histórico do Espaço e os dados antigos continuam lá, intocados
const IDB_VERSION = 2;
let _idb = null;
function idb() {
    if (_idb) return _idb;
    _idb = new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => { // só roda em instalação nova ou banco muito velho; nunca mexe em store que já existe
            const db = req.result;
            if (!db.objectStoreNames.contains('estado')) db.createObjectStore('estado', { keyPath: 'chave' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return _idb;
}
const idbReq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function idbStore(nome, modo) { const db = await idb(); return db.transaction(nome, modo).objectStore(nome); }
async function idbGet(loja, chave) { return idbReq((await idbStore(loja, 'readonly')).get(chave)); }
async function idbPut(loja, obj) { return idbReq((await idbStore(loja, 'readwrite')).put(obj)); }
async function idbDel(loja, chave) { return idbReq((await idbStore(loja, 'readwrite')).delete(chave)); }
async function idbAll(loja) { return idbReq((await idbStore(loja, 'readonly')).getAll()); }
// 'estado': chave = '<personagem>:<campo>' (formato da v7, preservado: espacoChats, espacoHistory:<id>)
async function estadoGet(campo, padrao) { const r = await idbGet('estado', personagemAtual() + ':' + campo); return r ? r.valor : padrao; }
async function estadoSet(campo, valor) { await idbPut('estado', { chave: personagemAtual() + ':' + campo, valor }); return valor; }
async function estadoDel(campo) { await idbDel('estado', personagemAtual() + ':' + campo); }
// reserva v8: chaves 'v8|...' no mesmo store
const locGet = async (k) => { const r = await idbGet('estado', 'v8|' + k); return r ? r.valor : undefined; };
const locSet = (k, valor) => idbPut('estado', { chave: 'v8|' + k, valor });
const locDel = (k) => idbDel('estado', 'v8|' + k);
const locLista = async (prefixo) => (await idbAll('estado')).filter((r) => r.chave.startsWith('v8|' + prefixo)).map((r) => ({ chave: r.chave.slice(3), valor: r.valor }));

// ---- plugin ----
const FS_BASE = '/api/plugins/spade-fs';
const Plug = { ok: null, versao: null, alertas: [], erro: null }; // ok: null = ainda não checou
async function chamarFs(caminho, corpo, metodo = 'POST') {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, ctx().getRequestHeaders?.() || {}); // CSRF do ST
    let resp;
    try { resp = await fetch(FS_BASE + caminho, metodo === 'GET' ? { method: 'GET', headers } : { method: 'POST', headers, body: JSON.stringify(corpo || {}) }); }
    catch (e) { const er = new Error('o plugin spade-fs não respondeu: ' + e.message); er.semPlugin = true; throw er; }
    let data = {}; try { data = await resp.json(); } catch (_) { /* corpo vazio */ }
    if (resp.status === 404 && !data.erro) { const er = new Error('plugin spade-fs não encontrado (está em plugins/ e o SillyTavern foi reiniciado?)'); er.semPlugin = true; throw er; }
    if (!resp.ok) { const er = new Error(data.erro || ('spade-fs devolveu ' + resp.status)); er.status = resp.status; er.conflito = !!data.conflito; er.atual = data.atual; er.jaExiste = !!data.jaExiste; throw er; }
    return data;
}
async function checarPlugin() {
    try { const d = await chamarFs('/saude', null, 'GET'); Plug.ok = true; Plug.versao = d.versao; Plug.alertas = d.alertas || []; Plug.erro = null; }
    catch (e) { Plug.ok = false; Plug.erro = e.message; }
    return Plug.ok;
}
// Tenta o plugin; se ele estiver fora do ar, cai na reserva do navegador e marca a faixa de aviso.
async function io(viaPlugin, viaLocal) {
    if (Plug.ok !== false) {
        try { return await viaPlugin(); }
        catch (e) { if (!e.semPlugin) throw e; Plug.ok = false; Plug.erro = e.message; avisarUI(); }
    }
    return viaLocal();
}
let avisarUI = () => {}; // a interface troca isto (faixa "sem plugin")
const P = () => personagemAtual();

const Disco = {
    async indiceLer() { return io(async () => { const d = await chamarFs('/biblioteca/indice/ler', { personagem: P() }); return { conteudo: d.conteudo, versao: d.versao }; }, async () => ({ conteudo: (await locGet('indice|' + P())) || null, versao: null })); },
    async indiceEscrever(c, versao) { return io(async () => ({ versao: (await chamarFs('/biblioteca/indice/escrever', { personagem: P(), conteudo: c, ifVersion: versao })).versao }), async () => { await locSet('indice|' + P(), c); return { versao: null }; }); },
    async arqListar() {
        return io(async () => (await chamarFs('/biblioteca/arquivo/listar', { personagem: P() })).arquivos,
            async () => (await locLista('arq|' + P() + '|')).filter((r) => r.chave.endsWith('|meta')).map((r) => { const id = r.chave.split('|')[2]; return { id, meta: r.valor, versaoMeta: null, nota: null, versaoNota: null }; })
                ); // as notas locais são lidas abaixo
    },
    async arqCriar({ id, original, extensao, meta }) {
        return io(async () => { const d = await chamarFs('/biblioteca/arquivo/criar', { personagem: P(), id, original, extensao, meta }); return { meta: d.meta, versaoMeta: d.versaoMeta }; },
            async () => { const k = 'arq|' + P() + '|' + id + '|'; if (await locGet(k + 'meta')) { const er = new Error('esse arquivo já existe.'); er.jaExiste = true; throw er; } const m = Object.assign({}, meta, { id, extensao, chars: original.length }); await locSet(k + 'original', original); await locSet(k + 'meta', m); return { meta: m, versaoMeta: null }; });
    },
    async arqLer(id, partes) {
        return io(async () => { const d = await chamarFs('/biblioteca/arquivo/ler', { personagem: P(), id, partes }); return d; },
            async () => { const k = 'arq|' + P() + '|' + id + '|'; const o = { versoes: {} }; if (partes.includes('meta')) o.meta = await locGet(k + 'meta'); if (partes.includes('nota')) o.nota = (await locGet(k + 'nota')) || null; if (partes.includes('original')) o.original = await locGet(k + 'original'); return o; });
    },
    async arqMeta(id, meta, versao) { return io(async () => ({ versao: (await chamarFs('/biblioteca/arquivo/meta', { personagem: P(), id, meta, ifVersion: versao })).versao }), async () => { await locSet('arq|' + P() + '|' + id + '|meta', meta); return { versao: null }; }); },
    async arqNota(id, nota, versao) { return io(async () => ({ versao: (await chamarFs('/biblioteca/arquivo/nota', { personagem: P(), id, nota, ifVersion: versao })).versao }), async () => { await locSet('arq|' + P() + '|' + id + '|nota', nota); return { versao: null }; }); },
    async arqOriginal(id, original, versao) { return io(async () => ({ versao: (await chamarFs('/biblioteca/arquivo/original', { personagem: P(), id, original, ifVersion: versao })).versao }), async () => { await locSet('arq|' + P() + '|' + id + '|original', original); return { versao: null }; }); },
    async arqApagar(id) { return io(() => chamarFs('/biblioteca/arquivo/apagar', { personagem: P(), id }), async () => { for (const s of ['meta', 'nota', 'original']) await locDel('arq|' + P() + '|' + id + '|' + s); return {}; }); },
    async memLer(chatId, nome) { return io(async () => { const d = await chamarFs('/memoria/ler', { personagem: P(), chatId, nome }); return { conteudo: d.conteudo, versao: d.versao }; }, async () => ({ conteudo: (await locGet('mem|' + P() + '|' + (nome === 'conexoes' ? '' : chatId) + '|' + nome)) || null, versao: null })); },
    async memEscrever(chatId, nome, conteudo, versao) { return io(async () => ({ versao: (await chamarFs('/memoria/escrever', { personagem: P(), chatId, nome, conteudo, ifVersion: versao })).versao }), async () => { await locSet('mem|' + P() + '|' + (nome === 'conexoes' ? '' : chatId) + '|' + nome, conteudo); return { versao: null }; }); },
    async descLer() { return io(async () => { const d = await chamarFs('/descricao/ler', { personagem: P() }); return { conteudo: d.conteudo, versao: d.versao }; }, async () => ({ conteudo: (await locGet('desc|' + P())) || null, versao: null })); },
    async descEscrever(c, versao) { return io(async () => ({ versao: (await chamarFs('/descricao/escrever', { personagem: P(), conteudo: c, ifVersion: versao })).versao }), async () => { await locSet('desc|' + P(), c); return { versao: null }; }); },
};
// Na reserva do navegador a listagem precisa trazer as notas também (o plugin já devolve junto).
const _arqListarOriginal = Disco.arqListar;
Disco.arqListar = async function () {
    const lista = await _arqListarOriginal.call(Disco);
    if (Plug.ok === false) for (const a of lista) a.nota = (await locGet('arq|' + P() + '|' + a.id + '|nota')) || null;
    return lista;
};

// Controle de versão otimista na ponta do navegador: se outra aba mudou o arquivo, o plugin devolve 409
// e a tela recarrega — nunca sobrescreve em silêncio.
function avisoConflito(e) { return e && e.conflito ? 'Outra aba mudou isto depois que você abriu. Recarreguei o que está no disco — refaça a edição.' : null; }

// ============================================================
// 04 BIBLIOTECA — pastas, arquivos, notas, grupos e a seleção por orçamento (8.2 a 8.6)
// Regra de ouro (8.1): o arquivo ORIGINAL nunca entra no prompt; só a NOTA.
// ============================================================
const Bib = { carregada: false, personagem: null, indice: null, versaoIndice: null, arquivos: new Map() };
const indicePadrao = () => ({ versaoEsquema: 8, pastas: [{ id: 'entrada', nome: 'Entrada', ordem: 0, cor: CORES_PASTA[0] }], grupos: [], tipos: [], ordem: {} });
function normalizarArquivo(a) {
    const m = a.meta || {};
    a.meta = Object.assign({ nome: 'sem nome', pastaId: 'entrada', tipo: 'documento', estado: 'novo', explicacoes: [], observacao: '', observacaoVisivelParaIA: true, prioridade: 'media', sempreAtivo: false, ativo: true, grupoId: null, ligacoes: [], escopo: 'personagem', usarComoEstilo: false, enviadoEm: Date.now() }, m);
    return a;
}
async function bibCarregar(forcar) {
    const p = P();
    if (Bib.carregada && Bib.personagem === p && !forcar) return;
    const r = await Disco.indiceLer();
    Bib.indice = Object.assign(indicePadrao(), r.conteudo || {}); Bib.versaoIndice = r.versao;
    Bib.arquivos = new Map((await Disco.arqListar()).map((a) => [a.id, normalizarArquivo(a)]));
    Bib.personagem = p; Bib.carregada = true;
    if (!r.conteudo) await bibSalvarIndice();
}
async function bibSalvarIndice() {
    try { Bib.versaoIndice = (await Disco.indiceEscrever(Bib.indice, Bib.versaoIndice)).versao; }
    catch (e) { if (e.conflito) { await bibCarregar(true); throw new Error(avisoConflito(e)); } throw e; }
    sincronizarSoon();
}
const tiposTodos = () => TIPOS_BASE.concat(Bib.indice ? Bib.indice.tipos : []);
const tipoInfo = (id) => tiposTodos().find((t) => t.id === id) || TIPOS_BASE[3];
const pastaInfo = (id) => (Bib.indice ? Bib.indice.pastas : []).find((p) => p.id === id);
const listaArquivos = () => Array.from(Bib.arquivos.values());
async function salvarMetaArq(a) {
    try { a.versaoMeta = (await Disco.arqMeta(a.id, a.meta, a.versaoMeta)).versao; }
    catch (e) { if (e.conflito) { await recarregarArq(a.id); throw new Error(avisoConflito(e)); } throw e; }
    sincronizarSoon();
}
async function salvarNotaArq(a) {
    try { a.versaoNota = (await Disco.arqNota(a.id, a.nota, a.versaoNota)).versao; }
    catch (e) { if (e.conflito) { await recarregarArq(a.id); throw new Error(avisoConflito(e)); } throw e; }
    sincronizarSoon();
}
async function recarregarArq(id) { const d = await Disco.arqLer(id, ['meta', 'nota']); const a = Bib.arquivos.get(id) || { id }; a.meta = d.meta; a.nota = d.nota; a.versaoMeta = d.versoes.meta; a.versaoNota = d.versoes.nota; Bib.arquivos.set(id, normalizarArquivo(a)); }
async function criarArquivo({ nome, texto, pastaId, explicacao, tipo, escopo, importado, id, extra }) {
    const ext = (nome.match(/\.([a-z0-9]{1,8})$/i) || [, 'txt'])[1].toLowerCase();
    const meta = Object.assign({ nome, pastaId: pastaId || Bib.indice.pastas[0].id, tipo: tipo || 'documento', tipoOriginal: ext, estado: 'novo', explicacoes: explicacao ? [{ id: newId('e'), texto: explicacao, criadoEm: Date.now() }] : [], enviadoEm: Date.now(), escopo: escopo || 'personagem', importado: !!importado, editadoEm: Date.now() }, extra || {});
    const r = await Disco.arqCriar({ id: id || newId('a'), original: texto, extensao: ext, meta });
    const a = normalizarArquivo({ id: r.meta.id, meta: r.meta, versaoMeta: r.versaoMeta, nota: null, versaoNota: null });
    Bib.arquivos.set(a.id, a); sincronizarSoon();
    return a;
}
async function apagarArquivo(a) {
    await Disco.arqApagar(a.id); Bib.arquivos.delete(a.id);
    Bib.indice.grupos.forEach((g) => { g.arquivoIds = g.arquivoIds.filter((x) => x !== a.id); });
    await bibSalvarIndice();
}
// 'desatualizado' = o usuário mudou Explicação/Observação/arquivo depois da última análise. NÃO reanalisa sozinho (custa token).
function estadoEfetivo(a) {
    const m = a.meta;
    if (m.estado === 'analisando' || m.estado === 'erro') return m.estado;
    if (a.nota) return (m.editadoEm || 0) > (m.analisadoEm || 0) + 1000 && m.analisadoEm ? 'desatualizado' : 'pronto';
    return 'novo';
}
// Pastas e grupos
async function criarPasta(nome, cor) { const p = { id: newId('p'), nome: nome.trim() || 'Pasta', ordem: Bib.indice.pastas.length, cor: cor || CORES_PASTA[Bib.indice.pastas.length % CORES_PASTA.length] }; Bib.indice.pastas.push(p); await bibSalvarIndice(); return p; }
async function mudarPasta(id, patch) { Object.assign(pastaInfo(id), patch); await bibSalvarIndice(); }
async function apagarPasta(id) {
    const resto = Bib.indice.pastas.filter((p) => p.id !== id); if (!resto.length) throw new Error('É preciso ter pelo menos uma pasta.');
    for (const a of listaArquivos().filter((x) => x.meta.pastaId === id)) { a.meta.pastaId = resto[0].id; await salvarMetaArq(a); } // arquivos nunca somem junto com a pasta: vão pra primeira que sobrar
    Bib.indice.pastas = resto; await bibSalvarIndice();
}
async function criarTipo(nome, cor) { const id = 't-' + semAcento(nome).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); if (!id || tiposTodos().some((t) => t.id === id)) throw new Error('Já existe um tipo com esse nome.'); Bib.indice.tipos.push({ id, nome: nome.trim(), cor: cor || '#c4c6d2', icone: 'lines' }); await bibSalvarIndice(); return id; }
async function ligarGrupo(ids, nome) {
    const g = { id: newId('g'), nome: nome || 'Grupo', arquivoIds: ids.slice(), nota: null };
    Bib.indice.grupos.push(g); ids.forEach((id) => { const a = Bib.arquivos.get(id); if (a) a.meta.grupoId = g.id; });
    await bibSalvarIndice(); for (const id of ids) { const a = Bib.arquivos.get(id); if (a) await salvarMetaArq(a); } return g;
}
async function desfazerGrupo(gid) {
    const g = Bib.indice.grupos.find((x) => x.id === gid); if (!g) return;
    for (const id of g.arquivoIds) { const a = Bib.arquivos.get(id); if (a) { a.meta.grupoId = null; await salvarMetaArq(a); } }
    Bib.indice.grupos = Bib.indice.grupos.filter((x) => x.id !== gid); await bibSalvarIndice();
}

// ---- formato do item no prompt (9.2): "### título" + linhas curtas "- ..." ----
function linhasCurtas(texto) {
    return String(texto || '').split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-•*]|\d+[.)])\s+/, '').trim()).filter(Boolean).map((l) => '- ' + l);
}
const formatarItem = (titulo, texto) => '### ' + titulo + (texto ? '\n' + linhasCurtas(texto).join('\n') : '');

// ---- itens elegíveis: arquivos ativos com nota REVISADA; grupo com nota própria representa os membros (8.5, passo 1) ----
function itensDaBiblioteca() {
    const prio = { alta: 0, media: 1, baixa: 2 };
    const ordemPasta = new Map(Bib.indice.pastas.map((p) => [p.id, p.ordem]));
    const lista = [];
    const emGrupo = new Set();
    for (const g of Bib.indice.grupos) {
        const membros = g.arquivoIds.map((id) => Bib.arquivos.get(id)).filter(Boolean).filter((a) => a.meta.ativo);
        if (g.nota && g.nota.revisada !== false && (g.nota.completa || g.nota.minima) && membros.length) {
            membros.forEach((a) => emGrupo.add(a.id));
            const melhor = membros.slice().sort((x, y) => prio[x.meta.prioridade] - prio[y.meta.prioridade])[0];
            lista.push({ chave: 'g:' + g.id, titulo: g.nome, tipo: melhor.meta.tipo, pastaOrdem: ordemPasta.get(melhor.meta.pastaId) ?? 99, ordemManual: 0, prioridade: melhor.meta.prioridade, sempreAtivo: membros.some((a) => a.meta.sempreAtivo), completa: g.nota.completa || g.nota.minima, minima: g.nota.minima || '', id: g.id });
        }
    }
    for (const a of listaArquivos()) {
        if (!a.meta.ativo || emGrupo.has(a.id) || !a.nota || a.nota.revisada === false) continue;
        const ord = (Bib.indice.ordem[a.meta.pastaId] || []).indexOf(a.id);
        lista.push({ chave: 'a:' + a.id, titulo: a.meta.titulo || a.meta.nome.replace(/\.[a-z0-9]+$/i, ''), tipo: a.meta.tipo, pastaOrdem: ordemPasta.get(a.meta.pastaId) ?? 99, ordemManual: ord < 0 ? 9999 : ord, prioridade: a.meta.prioridade, sempreAtivo: a.meta.sempreAtivo, completa: a.nota.completa || a.nota.minima || '', minima: a.nota.minima || '', id: a.id });
    }
    return lista;
}
const textoDoItem = (it, modo) => (modo === 'completa' ? it.completa : modo === 'minima' ? it.minima : '');
// 8.5: passada 1 = a mínima de TODOS (a IA sabe que cada coisa existe); passada 2 = sobe pra completa enquanto couber.
// Item sem mínima entra só como título (1 linha). Nada é cortado no meio: o que não couber fica FORA e aparece na tela.
function selecionarNotas(itens, orcamento) {
    const prio = { alta: 0, media: 1, baixa: 2 };
    const ordem = itens.slice().sort((x, y) => (y.sempreAtivo - x.sempreAtivo) || (prio[x.prioridade] - prio[y.prioridade]) || (x.pastaOrdem - y.pastaOrdem) || (x.ordemManual - y.ordemManual) || String(x.id).localeCompare(String(y.id)));
    const modo = new Map(); let usado = 0;
    const custo = (it, m) => estimarTokens(formatarItem(it.titulo, textoDoItem(it, m))) + 1;
    for (const it of ordem) { const m = it.minima ? 'minima' : 'titulo'; const c = custo(it, m); if (usado + c <= orcamento) { modo.set(it.chave, m); usado += c; } else modo.set(it.chave, null); }
    for (const it of ordem) {
        const atual = modo.get(it.chave); if (!atual || !it.completa || atual === 'completa') continue;
        const delta = custo(it, 'completa') - custo(it, atual);
        if (usado + delta <= orcamento) { modo.set(it.chave, 'completa'); usado += delta; }
    }
    const tiposOrdem = tiposTodos().map((t) => t.id); const rank = (t) => (t === 'regra' ? -1 : tiposOrdem.indexOf(t));
    const escolhidos = ordem.filter((it) => modo.get(it.chave)).sort((x, y) => (rank(x.tipo) - rank(y.tipo)) || (x.pastaOrdem - y.pastaOrdem) || (x.ordemManual - y.ordemManual) || String(x.id).localeCompare(String(y.id))) // ordem de saída ESTÁVEL (8.5, passo 5)
        .map((it) => ({ it, modo: modo.get(it.chave), texto: formatarItem(it.titulo, textoDoItem(it, modo.get(it.chave))) }));
    const fora = ordem.filter((it) => !modo.get(it.chave)).map((it) => ({ it, motivo: 'não coube nem como nota mínima' }));
    return { escolhidos, fora, usado };
}

// ============================================================
// 05 DESCRIÇÃO, MEMÓRIA EM 3 GAVETAS E CONEXÕES
// ============================================================
const Desc = { v: null, versao: null, personagem: null };
const descPadrao = () => ({ aparencia: '', temperamento: '', oQueMudaHumor: '', exemplosFrios: [], comoFala: '', oQueSabe: '', atualizadoEm: null, importadaDoCartaoEm: null, textoOriginalImportado: null });
async function descCarregar(forcar) {
    if (Desc.v && Desc.personagem === P() && !forcar) return Desc.v;
    const r = await Disco.descLer(); Desc.v = Object.assign(descPadrao(), r.conteudo || {}); Desc.versao = r.versao; Desc.personagem = P(); return Desc.v;
}
async function descSalvar() {
    Desc.v.atualizadoEm = Date.now();
    try { Desc.versao = (await Disco.descEscrever(Desc.v, Desc.versao)).versao; }
    catch (e) { if (e.conflito) { await descCarregar(true); throw new Error(avisoConflito(e)); } throw e; }
    sincronizarSoon();
}
const cartaoAtual = () => { const c = ctx(); return c.characterId != null && Array.isArray(c.characters) ? c.characters[c.characterId] : null; };
// 10.1: só UMA descrição pode chegar à IA. Caminho (c)+(a): importa a do cartão UMA vez (guardando o original) e o usuário esvazia o campo no cartão.
const cartaoTemDescricao = () => { const c = cartaoAtual(); return !!(c && String(c.description || '').trim()); };
const cartaoTemOutrosCampos = () => { const c = cartaoAtual(); if (!c) return []; return [['Personality', c.personality], ['Scenario', c.scenario], ['Example Dialogues', c.mes_example], ['First Message', c.first_mes]].filter(([, v]) => String(v || '').trim()).map(([k]) => k); };
async function descImportarDoCartao() {
    const c = cartaoAtual(); if (!c || !String(c.description || '').trim()) throw new Error('O cartão não tem descrição pra importar.');
    await descCarregar(); Desc.v.textoOriginalImportado = c.description; Desc.v.importadaDoCartaoEm = Date.now();
    if (!Desc.v.aparencia.trim()) Desc.v.aparencia = c.description; else Desc.v.aparencia += '\n' + c.description;
    await descSalvar();
}
function blocoDescricao() {
    const d = Desc.v; if (!d) return '';
    const partes = [];
    if (d.aparencia.trim()) partes.push(formatarItem('Aparência', d.aparencia));
    const hum = [];
    if (d.temperamento.trim()) hum.push('Temperamento base: ' + d.temperamento.trim().replace(/\s*\n\s*/g, ' '));
    if (d.oQueMudaHumor.trim()) hum.push('O que muda o humor dela: ' + d.oQueMudaHumor.trim().replace(/\s*\n\s*/g, ' '));
    const frios = (d.exemplosFrios || []).map((x) => String(x).trim()).filter(Boolean);
    if (frios.length) hum.push('Exemplos dela em momento frio: ' + frios.map((x) => '“' + x + '”').join(' · '));
    if (hum.length) partes.push(formatarItem('Humor e temperamento', hum.join('\n')));
    if (d.comoFala.trim()) partes.push(formatarItem('Como fala', d.comoFala));
    if (d.oQueSabe.trim()) partes.push(formatarItem('O que sabe', d.oQueSabe));
    return partes.length ? '## QUEM ELA É\n' + partes.join('\n') : '';
}

// ---- gavetas RP e Espaço (por chat do ST) + conexões (por personagem) ----
const Mem = { chatId: null, rp: { fatos: [], ultimoIdx: 0 }, versaoRp: null, espaco: { pedidos: [] }, versaoEsp: null, con: { grupos: [] }, versaoCon: null, vizinhas: [], relogio: null, versaoRel: null };
async function memCarregar(forcar) {
    const chat = chatIdParaDisco();
    if (Mem.chatId === chat && Mem.personagem === P() && !forcar) return;
    const [rp, esp, con, rel] = await Promise.all([Disco.memLer(chat, 'rp'), Disco.memLer(chat, 'espaco'), Disco.memLer(chat, 'conexoes'), Disco.memLer(chat, 'relogio')]);
    Mem.chatId = chat; Mem.personagem = P();
    Mem.rp = Object.assign({ fatos: [], ultimoIdx: 0 }, rp.conteudo || {}); Mem.versaoRp = rp.versao;
    Mem.espaco = Object.assign({ pedidos: [] }, esp.conteudo || {}); Mem.versaoEsp = esp.versao;
    Mem.con = Object.assign({ grupos: [] }, con.conteudo || {}); Mem.versaoCon = con.versao;
    Mem.versaoRel = rel.versao; let relC = rel.conteudo; let migrou = false;
    if (!relC) { relC = await relMigrarLegado(); migrou = !!relC; } // 12.6: o relógio da v7 (por personagem) vai pro primeiro chat aberto
    Mem.relogio = relNormalizar(relC || { ultimoIdx: (ctx().chat || []).length });
    if (migrou) memSalvar('relogio').catch(relFalha);
    await memCarregarVizinhas();
}
async function memSalvar(qual) {
    const chat = Mem.chatId || chatIdParaDisco();
    try {
        if (qual === 'rp') Mem.versaoRp = (await Disco.memEscrever(chat, 'rp', Mem.rp, Mem.versaoRp)).versao;
        else if (qual === 'espaco') Mem.versaoEsp = (await Disco.memEscrever(chat, 'espaco', Mem.espaco, Mem.versaoEsp)).versao;
        else if (qual === 'relogio') Mem.versaoRel = (await Disco.memEscrever(chat, 'relogio', Mem.relogio, Mem.versaoRel)).versao;
        else Mem.versaoCon = (await Disco.memEscrever(chat, 'conexoes', Mem.con, Mem.versaoCon)).versao;
    } catch (e) { if (e.conflito) { await memCarregar(true); throw new Error(avisoConflito(e)); } throw e; }
    sincronizarSoon();
}
const sabeFato = (f) => { const n = semAcento(personagemAtual()).toLowerCase(); return (f.sabem || []).some((x) => { const s = semAcento(x).toLowerCase(); return s === n || s === 'todos' || s === '*'; }); };
// Bloco 4 — só entram os fatos que a personagem SABE (11.1); os outros ficam só na tela. Ordem cronológica estável.
// Estourou? Entram os mais recentes inteiros (nunca corta no meio); o resto vira "fora do orçamento" na tela.
function blocoMemoria(orcamento) {
    const proprios = Mem.rp.fatos.filter(sabeFato);
    const vizinhos = Mem.vizinhas.map((v) => ({ titulo: v.titulo, fatos: (v.fatos || []).filter(sabeFato) })).filter((v) => v.fatos.length);
    const teto = vizinhos.length ? Math.floor(orcamento * 0.7) : orcamento;
    const caber = (lista, limite) => { const dentro = new Set(); let usado = 0; for (const f of lista.slice().reverse()) { const c = estimarTokens('- ' + f.texto) + 1; if (usado + c > limite) continue; dentro.add(f.id); usado += c; } return { dentro, usado }; };
    const r = caber(proprios, teto);
    const linhas = []; const fora = [];
    proprios.forEach((f) => { if (r.dentro.has(f.id)) linhas.push('- ' + f.texto); else fora.push({ texto: f.texto, motivo: 'fora do orçamento da memória do RP' }); });
    let usadoViz = 0; const restante = Math.max(0, orcamento - r.usado); const fatia = vizinhos.length ? Math.floor(restante / vizinhos.length) : 0;
    const secoes = [];
    if (linhas.length) secoes.push('### O que aconteceu\n' + linhas.join('\n'));
    for (const v of vizinhos) { const rv = caber(v.fatos, fatia); const ls = v.fatos.filter((f) => rv.dentro.has(f.id)).map((f) => '- ' + f.texto); v.fatos.filter((f) => !rv.dentro.has(f.id)).forEach((f) => fora.push({ texto: f.texto, motivo: 'fora do orçamento (chat conectado)' })); if (ls.length) { secoes.push('### Em outro chat\n' + ls.join('\n')); usadoViz += rv.usado; } }
    return { texto: secoes.length ? '## MEMÓRIA\n' + secoes.join('\n') : '', fora, naoSabe: Mem.rp.fatos.filter((f) => !sabeFato(f)) };
}
// Conexões (12.3): grupos { id, chats:[idDaConversa...] }; uma conversa em no máximo um grupo.
const grupoDaConversa = (convId) => Mem.con.grupos.find((g) => g.chats.includes(convId));
async function memCarregarVizinhas() {
    Mem.vizinhas = [];
    try {
        const chats = await obterEspacoChats();
        const atual = chats.find((c) => c.stChatId && c.stChatId === stChatIdAtual());
        const g = atual && grupoDaConversa(atual.id);
        if (!g) return;
        for (const cid of g.chats.filter((x) => x !== atual.id)) {
            const outra = chats.find((c) => c.id === cid); if (!outra || !outra.stChatId || outra.stChatId === atual.stChatId) continue;
            const r = await Disco.memLer(outra.stChatId, 'rp');
            Mem.vizinhas.push({ convId: cid, titulo: outra.titulo, fatos: (r.conteudo && r.conteudo.fatos) || [] });
        }
    } catch (e) { console.warn('[Spade] vizinhas:', e.message); }
}

// ============================================================
// 06 REGRAS PROFISSIONAIS (seção 11): cada regra = parte FIXA (texto curto) + parte MEDIDA pelo código
// ============================================================
// Português simples, nenhuma palavra da extensão (9.2). O texto muda quase nunca (prefixo estável, 9.3).
const REGRAS_ITENS = [
    ['Quem sabe o quê', 'A personagem só sabe o que viveu na cena, o que está na própria descrição e o que o usuário disse ou fez na frente dela.\nNotas do autor não são conhecimento dela.\nNa dúvida, reage com dúvida e não deduz.'],
    ['Humor', 'O humor da personagem muda por fato da cena, nunca por simpatia ao usuário.\nElogio, insistência ou carinho do usuário, sozinhos, não mudam o humor dela.\nSegue o padrão emocional da personagem: nem mais feliz, nem menos.'],
    ['Prioridade', 'O que o usuário disse por último vale mais que as notas.\nEntre as notas, as de regra valem mais que as de referência.'],
    ['Estilo', 'O estilo mostrado define COMO ela soa; a descrição e o temperamento definem O QUE ela diria.\nExemplos de fala são só referência de jeito: nunca copie uma frase deles.'],
];
const blocoRegras = () => '## REGRAS\n' + REGRAS_ITENS.map(([t, x]) => formatarItem(t, x)).join('\n');

// ---- base de palavras (herdada da v7: medir repetição por radical, sem IA) ----
const STOPWORDS_PT = new Set(['a', 'o', 'as', 'os', 'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'nas', 'um', 'uma', 'uns', 'umas', 'e', 'é', 'ou', 'que', 'se', 'com', 'por', 'para', 'pra', 'pro', 'como', 'mais', 'mas', 'ao', 'aos', 'à', 'às', 'sua', 'seu', 'suas', 'seus', 'isso', 'esse', 'essa', 'este', 'esta', 'isto', 'ele', 'ela', 'eles', 'elas', 'eu', 'tu', 'você', 'vc', 'nós', 'minha', 'meu', 'tinha', 'tem', 'ter', 'foi', 'ser', 'estar', 'está', 'tá', 'não', 'sim', 'já', 'ainda', 'também', 'muito', 'bem', 'só', 'vai', 'vou', 'me', 'te', 'lhe', 'the', 'is', 'was', 'sem', 'até', 'quando', 'onde', 'então', 'ali', 'aqui', 'lá', 'dela', 'dele', 'num', 'numa']);
const SUF_V = ['ássemos', 'êssemos', 'íssemos', 'aríamos', 'eríamos', 'iríamos', 'assem', 'essem', 'issem', 'arão', 'erão', 'irão', 'aram', 'eram', 'iram', 'avam', 'iam', 'ando', 'endo', 'indo', 'ado', 'ada', 'ados', 'adas', 'ido', 'ida', 'idos', 'idas', 'ará', 'erá', 'irá', 'arei', 'erei', 'irei', 'asse', 'esse', 'isse', 'arem', 'erem', 'irem', 'amos', 'emos', 'imos', 'ava', 'ia', 'eu', 'iu', 'ou', 'ar', 'er', 'ir'];
const SUF_N = ['izações', 'ização', 'amentos', 'amento', 'imentos', 'imento', 'íssimos', 'íssimas', 'íssimo', 'íssima', 'inhos', 'inhas', 'inho', 'inha', 'zinhos', 'zinhas', 'zinho', 'zinha', 'ável', 'ível', 'osos', 'osas', 'oso', 'osa', 'dades', 'dade', 'ções', 'ção', 'mente', 'es', 's'];
function radicalPtBr(palavra) { // stemmer reduzido: une "corre/correu/correndo" na mesma raiz
    let p = semAcento(palavra.toLowerCase()); if (p.length <= 3) return p;
    for (const s of SUF_V) { const q = semAcento(s); if (p.endsWith(q) && p.length - q.length >= 3) { p = p.slice(0, -q.length); break; } }
    for (const s of SUF_N) { const q = semAcento(s); if (p.endsWith(q) && p.length - q.length >= 3) { p = p.slice(0, -q.length); break; } }
    if (/[bcdfghjklmnpqrstvxz][eo]$/.test(p) && p.length >= 5) p = p.slice(0, -1);
    return p;
}
const words = (t) => (String(t || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
const ehStop = (w) => STOPWORDS_PT.has(w) || STOPWORDS_PT.has(semAcento(w));

// ---- chat real (fonte única da verdade: ctx().chat) ----
function chatRealRecente(n = 12, maxChars = 1200) {
    const arr = ctx().chat; if (!Array.isArray(arr) || !arr.length) return [];
    const ini = Math.max(0, arr.length - n);
    return arr.slice(ini).map((m, i) => ({ idx: ini + i, nome: m.name, ehUsuario: !!m.is_user, ehSistema: !!m.is_system, texto: String(m.mes || '').trim().slice(0, maxChars), swipes: Array.isArray(m.swipes) ? m.swipes.map((s) => String(s || '').slice(0, maxChars)) : [] })).filter((m) => m.texto && !m.ehSistema);
}
// Falas da personagem que contam pra repetição. Em regenerate/swipe a fala sendo substituída (e os swipes antigos dela)
// ENTRAM na lista (9.5) — senão a IA devolve a mesma. `ultimasFalasCache` guarda o estado de antes do ST apagar a mensagem.
let ultimasFalasCache = [];
function atualizarCacheFalas() { ultimasFalasCache = chatRealRecente(24).filter((m) => !m.ehUsuario).slice(-6); }
function falasParaRepeticao(substituicao) {
    let falas = chatRealRecente(24).filter((m) => !m.ehUsuario).slice(-6);
    if (substituicao && ultimasFalasCache.length) { // o ST pode já ter tirado a fala do array: usa o que a gente guardou
        const textos = new Set(falas.map((f) => f.texto));
        ultimasFalasCache.slice(-1).forEach((f) => { if (!textos.has(f.texto)) falas.push(f); });
        falas = falas.concat(...ultimasFalasCache.slice(-1).map((f) => f.swipes.map((s) => ({ texto: s }))));
    }
    return falas.slice(-9).map((f) => f.texto);
}
// 11.2 — o CÓDIGO mede, a IA recebe a lista real. Sem "varie o vocabulário" genérico.
function medirRepeticao(falas, tiques) {
    const r = { frases: [], palavras: [], comecos: [], tiques: [] };
    if (falas.length >= 2) {
        const cont = new Map();
        falas.forEach((f) => { const w = words(f); const vistos = new Set(); for (let n = 4; n <= 6; n++) for (let i = 0; i + n <= w.length; i++) { const seg = w.slice(i, i + n); if (seg.every(ehStop)) continue; vistos.add(seg.join(' ')); } vistos.forEach((g) => cont.set(g, (cont.get(g) || 0) + 1)); });
        const rep = [...cont.entries()].filter(([, c]) => c >= 2).map(([g]) => g).sort((a, b) => b.length - a.length);
        const mantidas = []; for (const g of rep) if (!mantidas.some((m) => m.includes(g))) mantidas.push(g); // funde sobrepostas na mais longa
        r.frases = mantidas.slice(0, 5);
    }
    const base = falas.slice(-6);
    if (base.length >= 3) {
        const porRad = new Map();
        base.forEach((f) => { const rs = new Map(); words(f).forEach((w) => { if (w.length < 4 || ehStop(w)) return; const rd = radicalPtBr(w); if (!rs.has(rd)) rs.set(rd, w); }); rs.forEach((w, rd) => { const o = porRad.get(rd) || { n: 0, w }; o.n++; porRad.set(rd, o); }); });
        r.palavras = [...porRad.values()].filter((o) => o.n >= 3).sort((a, b) => b.n - a.n).map((o) => o.w).slice(0, 6);
    }
    if (base.length >= 2) {
        const ini = new Map(); base.forEach((f) => { const k = words(f).slice(0, 3).join(' '); if (k) ini.set(k, (ini.get(k) || 0) + 1); });
        r.comecos = [...ini.entries()].filter(([, c]) => c >= 2).map(([k]) => k).slice(0, 3);
    }
    r.tiques = (tiques || []).map((t) => String(t).trim()).filter(Boolean);
    // teto de 12 itens e ~150 tokens, na ordem de importância
    let total = 0; for (const k of ['frases', 'palavras', 'comecos', 'tiques']) { r[k] = r[k].filter(() => (total++) < 12); }
    return r;
}
function textoEvitar(rep) {
    const rot = [['frases', 'frases'], ['palavras', 'palavras'], ['comecos', 'começos'], ['tiques', 'tiques']];
    const ls = rot.filter(([k]) => rep[k].length).map(([k, nome]) => '- ' + nome + ': ' + rep[k].map((x) => '“' + x + '”').join(', '));
    let txt = ls.join('\n'); while (estimarTokens(txt) > 150 && ls.length) { ls.pop(); txt = ls.join('\n'); }
    return txt;
}
// 11.4 — pensamento em primeira pessoa: pede o CONTEÚDO, não um formato rígido. Funciona ou não: T11 só mede.
function instrucaoPensamento() {
    const p = getConfig().pessoaPensamento;
    if (p === 2) return 'Antes de responder, pense como se falasse com ela: o que você percebe, o que você quer e o que você vai fazer agora.';
    if (p === 3) return 'Antes de responder, pense nela em terceira pessoa: o que ela percebe, o que ela quer e o que ela vai fazer agora.';
    return 'Antes de responder, pense como ela, em primeira pessoa: o que percebo, o que quero e o que vou fazer agora. Pense em português.';
}
const INSTRUCAO_RESPOSTA = 'Responda só como a personagem, em prosa de RP. Não mostre planejamento, listas nem comentários fora da cena.';

// ============================================================
// 07 ESTILO GUIADO (adendo A) — "empurrar, não algemar"
// 4 peças, TODAS por código (a IA só entra UMA vez, na análise do arquivo):
//   1 impressão de estilo (números medidos) · 2 banco de exemplos (copiados literalmente e conferidos)
//   3 entrega rotativa (poucos exemplos que giram a cada resposta) · 4 conferência e cutucada (só se houver desvio)
// O arquivo recebido do adendo terminava na A5.3: A6–A11 foram reconstruídas pela lógica das referências
// (A6 faixas de tamanho, A7 rotação, A8 conferência/cópia, A9 modo forte, A10 conflito com a Descrição, A11 tela).
// Limite honesto: o código só mede a SUPERFÍCIE (tamanho, pontuação, gíria). Não mede humor nem subtexto.
// ============================================================
function percentil(arr, p) { if (!arr.length) return 0; const a = arr.slice().sort((x, y) => x - y); const i = (a.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); }
const contaPalavras = (t) => (String(t || '').match(/[\p{L}\p{N}'’-]+/gu) || []).length;
const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();

// ---- A5.2 segmentação (heurística; o usuário pode corrigir). Narração = trechos entre *…* ou (…) ----
function separarNarracao(linha) {
    const narr = []; let fala = linha.replace(/\*([^*\n]{2,})\*|\(([^)\n]{2,})\)/g, (_, a, b) => { narr.push((a || b).trim()); return ' '; });
    return { fala: norm(fala), narr };
}
function segmentarEstilo(texto, vozAlvo) {
    const linhas = String(texto || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const unidades = []; let formato = 'corrido', confianca = 'alta'; const falantes = {};
    const RE_LOG = /^(?:\[\d{1,2}:\d{2}(?::\d{2})?\]\s*)?([^\s:—–][^:—–\n]{0,28}?)\s*[:—–]\s+(\S.*)$/;
    const logs = linhas.map((l) => RE_LOG.exec(l));
    const nLog = logs.filter(Boolean).length;
    const add = (txt, extra) => { const { fala, narr } = separarNarracao(txt); if (fala) unidades.push(Object.assign({ canal: 'fala', texto: fala }, extra)); narr.forEach((n) => unidades.push(Object.assign({ canal: 'narracao', texto: n }, extra))); };
    if (linhas.length >= 4 && nLog / linhas.length >= 0.6) {
        formato = 'log'; logs.forEach((m) => { if (m) falantes[m[1].trim()] = (falantes[m[1].trim()] || 0) + 1; });
        logs.forEach((m) => { if (m && (!vozAlvo || vozAlvo === 'todas' || m[1].trim() === vozAlvo)) add(m[2], { falante: m[1].trim() }); });
    } else if (linhas.filter((l) => /^[—–]/.test(l)).length / Math.max(1, linhas.length) >= 0.3) {
        formato = 'travessao'; linhas.forEach((l) => { if (/^[—–]/.test(l)) add(l.replace(/^[—–]\s*/, '')); else unidades.push({ canal: 'narracao', texto: l }); });
    } else if ((texto.match(/["“«][^"”»\n]{2,}["”»]/g) || []).length >= 3) {
        formato = 'aspas'; linhas.forEach((l) => { const resto = l.replace(/["“«]([^"”»\n]{2,})["”»]/g, (_, f) => { add(f); return ' '; }); const r = norm(resto); if (r) { const s = separarNarracao(r); s.narr.forEach((n) => unidades.push({ canal: 'narracao', texto: n })); if (s.fala.length > 3) unidades.push({ canal: 'narracao', texto: s.fala }); } });
    } else if (linhas.length >= 8 && linhas.filter((l) => l.length <= 220).length / linhas.length >= 0.7) {
        formato = 'linhas'; linhas.forEach((l) => add(l));
    } else {
        formato = 'corrido'; confianca = 'baixa';
        linhas.forEach((l) => (l.match(/[^.!?…]+[.!?…]+["”»]?|[^.!?…]+$/g) || [l]).forEach((s) => add(s.trim())));
    }
    return { unidades: unidades.filter((u) => contaPalavras(u.texto) >= 1), formato, confianca, falantes };
}
// ---- A5.1 medidas por canal ----
const RE_EMOJI = /\p{Extended_Pictographic}/gu;
function medirCanal(unidades, lexico) {
    const n = unidades.length; if (!n) return null;
    const pal = unidades.map((u) => contaPalavras(u.texto)); const totalPal = pal.reduce((a, b) => a + b, 0) || 1;
    const pct = (fn) => Math.round((100 * unidades.filter((u) => fn(u.texto)).length) / n);
    const frases = unidades.flatMap((u) => u.texto.split(/[.!?…]+/).map(contaPalavras).filter(Boolean));
    const lex = (lexico || []).map((l) => semAcento(l).toLowerCase());
    const todasPal = unidades.flatMap((u) => words(semAcento(u.texto)));
    return {
        n, palavrasPorFala: { p10: Math.round(percentil(pal, .1)), p50: Math.round(percentil(pal, .5)), p90: Math.round(percentil(pal, .9)) },
        palavrasPorFrase: { p50: Math.round(percentil(frases, .5)), p90: Math.round(percentil(frases, .9)) },
        pctPergunta: pct((t) => /\?["”»')\]]*\s*$/.test(t)), pctReticencias: pct((t) => /…|\.\.\./.test(t)), pctExclamacao: pct((t) => /!/.test(t)),
        pctInicioMinuscula: pct((t) => /^\p{Ll}/u.test(t)), pctSemPontoFinal: pct((t) => !/[.!?…]["”»')\]]*\s*$/.test(t)),
        virgulasPor100: +((100 * unidades.reduce((a, u) => a + (u.texto.match(/,/g) || []).length, 0)) / totalPal).toFixed(1),
        pctCaps: pct((t) => /\b\p{Lu}{3,}\b/u.test(t)), emojiPorFala: +(unidades.reduce((a, u) => a + (u.texto.match(RE_EMOJI) || []).length, 0) / n).toFixed(2),
        lexicoPor100: lex.length ? +((100 * todasPal.filter((w) => lex.includes(w)).length) / totalPal).toFixed(1) : 0,
    };
}
// ---- A5.3 banda-alvo: P50 e P10–P90; para taxas: taxa ± max(15 pontos, 50% da taxa). n < 20 = medida pouco confiável ----
function bandaDe(medidas) {
    if (!medidas) return null; const b = { n: medidas.n, confiavel: medidas.n >= 20 };
    b.palavrasPorFala = { alvo: medidas.palavrasPorFala.p50, min: medidas.palavrasPorFala.p10, max: medidas.palavrasPorFala.p90 };
    for (const k of ['pctPergunta', 'pctReticencias', 'pctExclamacao', 'pctInicioMinuscula', 'pctSemPontoFinal', 'pctCaps']) { const v = medidas[k]; const d = Math.max(15, v * 0.5); b[k] = { alvo: v, min: Math.max(0, Math.round(v - d)), max: Math.min(100, Math.round(v + d)) }; }
    for (const [k, piso] of [['virgulasPor100', 1], ['emojiPorFala', 0.15], ['lexicoPor100', 1]]) { const v = medidas[k]; const d = Math.max(piso, v * 0.5); b[k] = { alvo: v, min: Math.max(0, +(v - d).toFixed(2)), max: +(v + d).toFixed(2) }; }
    return b;
}
// A6 (reconstruída): faixas por tercis do tamanho em palavras, por canal.
function faixasDe(unidades) {
    const pal = unidades.map((u) => contaPalavras(u.texto)); const a = percentil(pal, 1 / 3), b = percentil(pal, 2 / 3);
    return (u) => { const n = contaPalavras(u.texto); return n <= a ? 'curta' : n <= b ? 'media' : 'longa'; };
}
const LIMITE_PALAVRAS = { fala: 25, narracao: 35 };
function candidatosDe(unidades) {
    const out = []; const faixa = { fala: faixasDe(unidades.filter((u) => u.canal === 'fala')), narracao: faixasDe(unidades.filter((u) => u.canal === 'narracao')) };
    unidades.forEach((u) => { const n = contaPalavras(u.texto); if (n < 2 || n > LIMITE_PALAVRAS[u.canal]) return; out.push({ cand: out.length + 1, canal: u.canal, texto: u.texto, palavras: n, faixa: faixa[u.canal](u) }); });
    return out;
}
// Passo 0 (código, antes da IA): segmenta, mede o texto INTEIRO (âncora objetiva) e monta candidatos numerados.
function estiloPasso0(texto, vozAlvo) {
    const seg = segmentarEstilo(texto, vozAlvo);
    const impressao = { fala: medirCanal(seg.unidades.filter((u) => u.canal === 'fala')), narracao: medirCanal(seg.unidades.filter((u) => u.canal === 'narracao')) };
    let cands = candidatosDe(seg.unidades);
    if (cands.length > 320) { const passo = cands.length / 320; cands = Array.from({ length: 320 }, (_, i) => cands[Math.floor(i * passo)]).map((c, i) => Object.assign(c, { cand: i + 1 })); } // amostra espaçada, só pra caber no pedido
    return { seg, impressao, cands };
}
function resumoImpressao(imp) {
    const f = imp.fala; if (!f) return '(sem falas medidas)';
    return 'falas: n=' + f.n + ', palavras/fala P10-P50-P90=' + f.palavrasPorFala.p10 + '-' + f.palavrasPorFala.p50 + '-' + f.palavrasPorFala.p90 + ', perguntas ' + f.pctPergunta + '%, reticências ' + f.pctReticencias + '%, exclamação ' + f.pctExclamacao + '%, início minúsculo ' + f.pctInicioMinuscula + '%, sem ponto final ' + f.pctSemPontoFinal + '%' + (imp.narracao ? '; narração: n=' + imp.narracao.n + ', palavras/trecho P50=' + imp.narracao.palavrasPorFala.p50 : '');
}
// Passo 1 — o que a IA recebe pra ESTILO (entra no mesmo pedido da análise da nota). Ela escolhe POR NÚMERO: não digita exemplos.
function pedidoEstiloParaIA(p0) {
    const lista = p0.cands.map((c) => c.cand + ' [' + c.canal + ',' + c.palavras + 'p] ' + c.texto.replace(/\s+/g, ' ')).join('\n');
    return 'ESTILO GUIADO. Impressão JÁ MEDIDA por código (não invente números): ' + resumoImpressao(p0.impressao) + '.\n' +
        'Candidatos a exemplo (numerados; escolha POR NÚMERO, nunca reescreva):\n' + lista + '\n' +
        'Devolva no JSON, além da nota, o campo "estilo": {"principios":["3 a 6 linhas curtas: o que caracteriza o jeito e o que evitar"],"exemplares":[{"cand":12,"situacao":"seca|provocação|dúvida|carinho|raiva|deboche|..."}],"lexico":["gírias/marcadores que aparecem"],"lixo":[{"cand":7,"motivo":"nome de pessoa real, dado pessoal, outra língua, fala cortada"}],"avisos":[]}. Escolha entre 12 e 40 exemplares variados (curtos, médios, longos).';
}
const RE_LIXO = /[\w.+-]+@[\w-]+\.[\w.]+|https?:\/\/\S+|www\.\S+|(?:^|\s)@\w{2,}|\+?\d[\d\s().-]{7,}\d|\d{6,}/i;
// Passo 2 — validação por código (DEVE): literal, saneado, limites, diversidade, sem duplicata, avisos.
function estiloPasso2(resp, p0, textoOriginal) {
    const avisos = (resp && Array.isArray(resp.avisos) ? resp.avisos : []).map(String); const originalNorm = norm(textoOriginal);
    const lixo = new Set(((resp && resp.lixo) || []).map((l) => Number(l.cand)));
    const lexico = ((resp && resp.lexico) || []).map(String).slice(0, 40); const lexSet = new Set(lexico.map((l) => semAcento(l).toLowerCase()));
    const porNum = new Map(p0.cands.map((c) => [c.cand, c])); const escolhidos = []; let descartados = 0;
    const vistoIni = new Set();
    const tenta = (c, situacao) => {
        if (!c || escolhidos.length >= 40) return;
        if (!originalNorm.includes(norm(c.texto))) { descartados++; return; } // literal
        if (lixo.has(c.cand) || RE_LIXO.test(c.texto)) { descartados++; return; }
        const ini = words(c.texto).slice(0, 4).join(' '); if (vistoIni.has(ini)) return; // sem quase-duplicata
        vistoIni.add(ini);
        const nomeProprio = c.texto.split(/(?<=[.!?…]\s)|\n/).some((fr) => (fr.trim().split(/\s+/).slice(1).some((w) => /^\p{Lu}\p{Ll}{2,}$/u.test(w.replace(/[^\p{L}]/gu, '')) && !lexSet.has(semAcento(w).toLowerCase()))));
        escolhidos.push({ id: 'x' + c.cand, canal: c.canal, texto: c.texto, palavras: c.palavras, faixa: c.faixa, situacao: String(situacao || '').slice(0, 24), favorito: false, bloqueado: false, revisar: nomeProprio });
    };
    ((resp && resp.exemplares) || []).forEach((e) => tenta(porNum.get(Number(e.cand)), e.situacao));
    // diversidade: ao menos 1/4 de cada faixa (por canal) quando ela existir no arquivo
    for (const canal of ['fala', 'narracao']) {
        const doCanal = p0.cands.filter((c) => c.canal === canal); if (!doCanal.length) continue;
        const cota = Math.ceil(Math.min(40, Math.max(12, escolhidos.length)) / 4);
        for (const f of ['curta', 'media', 'longa']) {
            const pool = doCanal.filter((c) => c.faixa === f); if (!pool.length) continue;
            let tem = escolhidos.filter((e) => e.canal === canal && e.faixa === f).length;
            for (let i = 0; tem < cota && i < pool.length; i += Math.max(1, Math.floor(pool.length / cota))) { const antes = escolhidos.length; tenta(pool[i], ''); if (escolhidos.length > antes) tem++; }
        }
    }
    if (descartados) avisos.push(descartados + ' exemplo(s) descartado(s) na conferência (não eram literais ou tinham dado pessoal).');
    if (escolhidos.length < 5) avisos.push('Pouco material de estilo neste arquivo (' + escolhidos.length + ' exemplos).');
    if (p0.seg.confianca === 'baixa') avisos.push('A separação das falas foi incerta (texto corrido). Se não ficou bom, use "tratar cada linha como fala".');
    const bandaFala = bandaDe(p0.impressao.fala), bandaNarr = bandaDe(p0.impressao.narracao);
    if (bandaFala && !bandaFala.confiavel) avisos.push('Poucas falas medidas (' + bandaFala.n + '): as medidas não serão usadas na conferência.');
    return { versao: 1, analisadoEm: Date.now(), formato: p0.seg.formato, confianca: p0.seg.confianca, vozAlvo: null, falantes: p0.seg.falantes, medidas: { fala: p0.impressao.fala, narracao: p0.impressao.narracao }, bandas: { fala: bandaFala, narracao: bandaNarr }, principios: ((resp && resp.principios) || []).map(String).slice(0, 6), lexico, exemplos: escolhidos, avisos, editadaPeloUsuario: false, ignorar: {} };
}

// ---- fontes: arquivos que entram no Estilo guiado (A3): tipo 'tom' ativo, ou "usar como estilo" ligado ----
function fontesDeEstilo() {
    return listaArquivos().filter((a) => a.meta.ativo && a.nota && a.nota.revisada !== false && a.nota.estilo && (a.meta.tipo === 'tom' || a.meta.usarComoEstilo));
}
// ---- A7 rotação: poucos exemplos por resposta, que mudam de uma resposta pra outra ----
const ROT_KEY = 'spade_rot_v8';
const Rot = { n: -1, salt: 0, ids: [], hist: [], reforco: false };
(function () { try { Object.assign(Rot, JSON.parse(localStorage.getItem(ROT_KEY) || '{}')); } catch (_) { /* começa limpo */ } })();
const salvarRot = () => { try { localStorage.setItem(ROT_KEY, JSON.stringify({ n: Rot.n, salt: Rot.salt, ids: Rot.ids, hist: Rot.hist.slice(-24) })); } catch (_) { /* cheio: perde só a rotação */ } };
function prng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const respostaIndice = () => (Array.isArray(ctx().chat) ? ctx().chat.filter((m) => !m.is_user && !m.is_system).length : 0);
function poolDeExemplos() {
    const out = []; fontesDeEstilo().forEach((a) => a.nota.estilo.exemplos.forEach((e) => { if (!e.bloqueado) out.push(Object.assign({ fonte: a.id }, e)); })); return out;
}
function escolherExemplos(qtd) {
    const pool = poolDeExemplos(); if (!pool.length) return [];
    const n = respostaIndice(); const sig = pool.length + ':' + qtd;
    if (Rot.n === n && Rot.sig === sig && Rot.ids.length && Rot.ids.every((id) => pool.some((p) => (p.fonte + '|' + p.id) === id))) return Rot.ids.map((id) => pool.find((p) => (p.fonte + '|' + p.id) === id)).filter(Boolean);
    if (Rot.n !== n && Rot.ids.length) Rot.hist.push(...Rot.ids); // a resposta avançou: o que foi entregue vira "recente"
    const rnd = prng(hashStr(chatIdParaDisco() + '|' + n + '|' + Rot.salt));
    const recentes = new Set(Rot.hist.slice(-12));
    const temNarr = pool.some((p) => p.canal === 'narracao') && pool.filter((p) => p.canal === 'narracao').length >= 5;
    const quer = [];
    const faixas = ['curta', 'media', 'longa'];
    const falas = pool.filter((p) => p.canal === 'fala'), narr = pool.filter((p) => p.canal === 'narracao');
    const nFala = temNarr && qtd >= 3 ? qtd - 1 : qtd;
    const usadas = new Set(); const sit = new Set();
    const peso = (p) => (recentes.has(p.fonte + '|' + p.id) ? 0.05 : 1) * (p.favorito ? 3 : 1) * (p.situacao && sit.has(p.situacao) ? 0.3 : 1);
    const sorteia = (lista) => { const cand = lista.filter((p) => !usadas.has(p.fonte + '|' + p.id)); if (!cand.length) return null; const tot = cand.reduce((a, p) => a + peso(p), 0); let r = rnd() * tot; for (const p of cand) { r -= peso(p); if (r <= 0) return p; } return cand[cand.length - 1]; };
    for (let i = 0; i < nFala; i++) { const faixa = faixas[i % 3]; const p = sorteia(falas.filter((x) => x.faixa === faixa)) || sorteia(falas); if (p) { quer.push(p); usadas.add(p.fonte + '|' + p.id); if (p.situacao) sit.add(p.situacao); } }
    if (temNarr && qtd >= 3) { const p = sorteia(narr); if (p) quer.push(p); }
    Rot.n = n; Rot.sig = sig; Rot.ids = quer.map((p) => p.fonte + '|' + p.id); salvarRot();
    return quer;
}
function linhaPerfil() {
    const fs = fontesDeEstilo(); if (!fs.length) return '';
    const b = fs.map((a) => a.nota.estilo.bandas && a.nota.estilo.bandas.fala).filter((x) => x && x.confiavel)[0]; if (!b) return '';
    const r = [];
    r.push('falas de cerca de ' + b.palavrasPorFala.alvo + ' palavras (costumam ir de ' + b.palavrasPorFala.min + ' a ' + b.palavrasPorFala.max + ')');
    const taxa = (k, sim, nao) => { const v = b[k].alvo; if (v >= 15) r.push('cerca de ' + v + '% ' + sim); else if (v <= 4) r.push(nao); };
    taxa('pctPergunta', 'terminam em pergunta', 'quase nunca pergunta'); taxa('pctReticencias', 'têm reticências', 'quase sem reticências'); taxa('pctExclamacao', 'têm exclamação', 'quase sem exclamação');
    if (b.pctInicioMinuscula.alvo >= 40) r.push('começa com letra minúscula, jeito de chat'); if (b.pctSemPontoFinal.alvo >= 40) r.push('muitas falas sem ponto final');
    return r.join('; ');
}
// ---- A8 conferência: compara as últimas falas dela com a impressão; só cutuca se houver desvio ----
const KW_SECA = /\b(seca|secas|monossil\w*|fala pouco|lac[oô]nic\w*|calad[ao]|reservad[ao]|contid[ao]|curt[ao]s?|econ[oô]mic\w*)\b/i;
const KW_FALANTE = /\b(tagarela|fala muito|prolix\w*|expansiv\w*|falante|extrovertid\w*|verborr\w*)\b/i;
// A10: a Descrição vence. Se ela declara o OPOSTO do arquivo no tamanho das falas, não cutuca o tamanho.
function conflitoDeTamanho(b) {
    const d = Desc.v; if (!d) return null; const txt = [d.comoFala, d.temperamento, d.aparencia].join(' ');
    if (b.palavrasPorFala.alvo >= 18 && KW_SECA.test(txt)) return 'A Descrição diz que ela fala pouco, mas o arquivo é de gente que fala muito: o tamanho não será cutucado.';
    if (b.palavrasPorFala.alvo <= 7 && KW_FALANTE.test(txt)) return 'A Descrição diz que ela fala muito, mas o arquivo é de falas curtas: o tamanho não será cutucado.';
    return null;
}
const ROTULO_MEDIDA = { palavrasPorFala: 'palavras por fala', pctPergunta: 'falas terminando em pergunta', pctReticencias: 'falas com reticências', pctExclamacao: 'falas com exclamação', pctSemPontoFinal: 'falas sem ponto final', pctInicioMinuscula: 'falas começando em minúscula' };
function conferirEstilo(falasTexto) {
    const modo = getConfig().estiloModo; const saida = { desvios: [], copias: [], conflitos: [], medidoEm: 0 };
    const fs = fontesDeEstilo(); if (!fs.length || modo === 'desligado') return saida;
    const alvo = fs.map((a) => a.nota.estilo).find((e) => e.bandas && e.bandas.fala && e.bandas.fala.confiavel); if (!alvo) return saida;
    const b = alvo.bandas.fala;
    const unid = falasTexto.flatMap((t) => segmentarEstilo(t.replace(/^\s+/, '')).unidades.filter((u) => u.canal === 'fala'));
    const falas = unid.length >= 3 ? unid : falasTexto.map((t) => ({ canal: 'fala', texto: separarNarracao(t).fala })).filter((u) => u.texto);
    saida.medidoEm = falas.length; if (falas.length < 3) return saida;
    const m = medirCanal(falas, alvo.lexico);
    const conf = conflitoDeTamanho(b); if (conf) saida.conflitos.push(conf);
    const folga = modo === 'forte' ? 0 : 0.25; // leve só reclama quando passa 25% além da borda da banda
    const checa = (k, atual, band, unidade) => {
        if (alvo.ignorar && alvo.ignorar[k]) return;
        const amp = Math.max(1, band.max - band.min); const fora = atual < band.min - amp * folga ? 'abaixo' : atual > band.max + amp * folga ? 'acima' : null;
        if (fora) saida.desvios.push({ medida: k, atual, alvo: band.alvo, min: band.min, max: band.max, direcao: fora, unidade, peso: Math.abs(atual - band.alvo) / amp });
    };
    if (!conf) checa('palavrasPorFala', m.palavrasPorFala.p50, b.palavrasPorFala, 'palavras');
    for (const k of ['pctPergunta', 'pctReticencias', 'pctExclamacao', 'pctSemPontoFinal', 'pctInicioMinuscula']) checa(k, m[k], b[k], '%');
    saida.desvios.sort((x, y) => y.peso - x.peso); saida.desvios = saida.desvios.slice(0, modo === 'forte' ? 3 : 2);
    // cópia: 5 palavras seguidas de um exemplo aparecendo numa fala recente dela (o código mede, em vez de pedir "não copie")
    const gramas = new Set(); poolDeExemplos().forEach((e) => { const w = words(e.texto); for (let i = 0; i + 5 <= w.length; i++) gramas.add(w.slice(i, i + 5).join(' ')); });
    for (const t of falasTexto.slice(-3)) { const w = words(t); for (let i = 0; i + 5 <= w.length; i++) { const g = w.slice(i, i + 5).join(' '); if (gramas.has(g) && !ehStop(g.split(' ')[0]) && !saida.copias.includes(g)) saida.copias.push(g); } }
    saida.copias = saida.copias.slice(0, 2);
    return saida;
}
function textoCutucada(c) {
    const ls = c.desvios.map((d) => '- ' + (d.direcao === 'acima' ? 'Nas últimas falas, ' : 'Nas últimas falas, ') + ROTULO_MEDIDA[d.medida] + ': ' + (d.unidade === '%' ? d.atual + '%' : d.atual + ' palavras (mediana)') + '; o jeito é ' + (d.unidade === '%' ? '~' + d.alvo + '% (' + d.min + '–' + d.max + '%)' : '~' + d.alvo + ' (' + d.min + '–' + d.max + ')') + '.');
    c.copias.forEach((g) => ls.push('- Um trecho dos exemplos apareceu quase igual numa fala sua: “' + g + '”. Diga de outro jeito.'));
    if (Rot.reforco) ls.push('- A última tentativa saiu fora do jeito mostrado: aproxime-se dele agora.');
    return ls.join('\n');
}
// Bloco 7 — ESTILO (volátil: gira a cada resposta, por isso fica no FIM do prompt, nunca no prefixo estável)
function blocoEstilo() {
    const modo = getConfig().estiloModo; if (modo === 'desligado' || !fontesDeEstilo().length) return { texto: '', exemplos: [], conferencia: null };
    const exemplos = escolherExemplos(modo === 'forte' ? 5 : 3);
    const conferencia = conferirEstilo(falasParaRepeticao(false));
    const partes = [];
    const perfil = linhaPerfil(); if (perfil) partes.push(formatarItem('Jeito de falar', perfil));
    if (exemplos.length) partes.push('### Exemplos de jeito (só referência, não copie)\n' + exemplos.map((e) => '- “' + e.texto + '”').join('\n'));
    const cut = textoCutucada(conferencia); if (cut) partes.push('### Ajuste\n' + cut);
    return { texto: partes.length ? '## ESTILO\n' + partes.join('\n') : '', exemplos, conferencia };
}

// ============================================================
// 06b RELÓGIO DA HISTÓRIA (seção 12.6, decisão 14) — dia/hora DENTRO do RP.
// O usuário escreve "*passaram dois dias*" na narração e o relógio anda. Sem IA: o salto é lido por código
// (a v7 chamava um 2º modelo para isso). Por chat, em disco: memoria/<personagem>/<chat>/relogio.json.
// Só dispara sozinho com salto CLARO dentro de *asteriscos*; vago, hora exata sem "volto às…", texto fora dos asteriscos
// e qualquer coisa dita no Espaço viram um botão de confirmação (chip). Todo salto automático tem "Desfazer".
// ============================================================
// >>RELOGIO-PURO (sem DOM, sem ST, sem IA: os testes em testes-relogio/ leem este trecho)
const REL_MIN_RODADA = 5; // avanço normal por resposta (igual à v7)
const REL_MAX_AUTO_DIAS = 60; // saltos maiores que isso nunca são automáticos
const REL_NUMS = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50 };
const REL_NUM_RE = '(\\d{1,3}|meia|' + Object.keys(REL_NUMS).join('|') + ')';
const REL_UNID_RE = '(minutos?|horas?|dias?|semanas?)';
const REL_UNID_MIN = { minuto: 1, hora: 60, dia: 1440, semana: 10080 };
const REL_FAIXAS = { madrugada: [3, 0], manha: [8, 0], tarde: [14, 0], noite: [20, 0] };
const pad2 = (n) => String(n).padStart(2, '0');
const relSemAc = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const relNorm = (s) => relSemAc(s).toLowerCase().replace(/[-–—]/g, ' ').replace(/\s+/g, ' ').trim();
function relQtd(tok) { if (tok === 'meia') return 0.5; return /^\d+$/.test(tok) ? parseInt(tok, 10) : (REL_NUMS[tok] || 0); }
function relUnidade(u) { return u.replace(/s$/, ''); }
function relRotuloMin(min) {
    const m = Math.round(min); if (m >= 1440) { const d = Math.floor(m / 1440), r = m % 1440; return '+' + d + (d === 1 ? ' dia' : ' dias') + (r >= 60 ? ' e ' + Math.floor(r / 60) + ' h' : ''); }
    if (m >= 60) { const h = Math.floor(m / 60), r = m % 60; return '+' + h + ' h' + (r ? ' ' + r + ' min' : ''); } return '+' + m + ' min';
}
const relTexto = (r) => 'dia ' + r.dia + ', ' + r.hora + 'h' + pad2(r.minuto); // vai pro prompt
const relUI = (r) => 'Dia ' + r.dia + ' · ' + pad2(r.hora) + ':' + pad2(r.minuto); // vai pra tela
function relFaixaEm(s) { // "de manhã", "à noite"... só vale junto com um salto de dias
    const m = s.match(/\b(?:de|pela|na|a|ao|naquela|durante a)\s+(madrugada|manha|tarde|noite)\b/); if (m) return REL_FAIXAS[m[1]];
    if (/\bamanhecer\b/.test(s)) return [6, 0]; if (/\banoitecer\b/.test(s)) return [19, 0]; if (/\bmeio dia\b/.test(s)) return [12, 0]; return null;
}
function relHoraAbs(s) { // "às 13:46", "as 18h", "às 7h30", "são 18 horas"
    const m = s.match(/\b(?:as|pelas|por volta das|ja sao|sao)\s+(\d{1,2})\s*(?::|h|horas?)\s*(\d{2})?(?!\d)/); if (!m) return null;
    const h = parseInt(m[1], 10), mi = m[2] ? parseInt(m[2], 10) : 0; if (h > 23 || mi > 59) return null;
    return { h, m: mi, cue: /\b(volto|retorno|retornei|chego|cheguei|aparec\w*|ja sao|sao)\b/.test(s) };
}
// Acha UM salto de tempo num trecho. nivel 'auto' = claro; 'chip' = vago/absoluto sem verbo de retorno (só pergunta).
function relAcharEm(seg) {
    let s = relNorm(seg).replace(/\bmais tarde\b/g, 'maistarde');
    // passado/duração ("faz dois dias", "há dois dias", "desde", "durante") NÃO é salto: tira antes de procurar
    s = s.replace(new RegExp('\\b(?:faz|fazia|faziam|fazem|ha|havia|haviam|desde|durante|por)\\s+(?:cerca de\\s+|quase\\s+|mais de\\s+)?' + REL_NUM_RE + '\\s+' + REL_UNID_RE, 'g'), ' ');
    const emeia = '(\\s+e meia)?'; let m, add = null, trecho = '', vago = false, abs = null;
    const dur = (q, u, meia) => { let v = relQtd(q); if (!v) return null; const mi = (u === 'hora' || u === 'minuto' || u === 'dia' || u === 'semana') ? REL_UNID_MIN[u] : 0; if (q === 'meia' && u !== 'hora') return null; return v * mi + (meia ? Math.round(mi / 2) : 0); }; // "e meia" = mais meia unidade (1h e meia = +30 min; 2 dias e meia = +12 h)
    if ((m = s.match(new RegExp('\\bpass(?:aram|ou|am|a|ando)\\s+(?:se\\s+)?(?:cerca de\\s+|quase\\s+|mais de\\s+|uns\\s+|umas\\s+)?' + REL_NUM_RE + '\\s+' + REL_UNID_RE + emeia)))) { add = dur(m[1], relUnidade(m[2]), m[3]); trecho = m[0]; }
    else if ((m = s.match(new RegExp('\\b' + REL_NUM_RE + '\\s+' + REL_UNID_RE + emeia + '\\s+(?:depois|maistarde|apos)\\b')))) { add = dur(m[1], relUnidade(m[2]), m[3]); trecho = m[0]; }
    else if ((m = s.match(new RegExp('\\bdaqui a\\s+' + REL_NUM_RE + '\\s+' + REL_UNID_RE + emeia)))) { add = dur(m[1], relUnidade(m[2]), m[3]); trecho = m[0]; }
    else if ((m = s.match(/\b(dia|manha|tarde|noite|madrugada) seguinte\b|\bno outro dia\b|\bno dia posterior\b/))) { add = 1440; trecho = m[0]; if (m[1] && m[1] !== 'dia') abs = { h: REL_FAIXAS[m[1]][0], m: 0, dia: true }; }
    if (add == null && !abs) { // vago: só chip, com um palpite que o usuário confirma
        if ((m = s.match(/\b(?:algumas|poucas|varias|muitas)\s+(horas|minutos|dias)\s+(?:depois|maistarde|apos)\b|\b(horas|minutos|dias)\s+depois\b/))) { const u = m[1] || m[2]; add = u === 'horas' ? 120 : u === 'minutos' ? 20 : 2880; vago = true; trecho = m[0]; }
        else if ((m = s.match(/\b(?:algum|um) tempo depois\b|\bpassado algum tempo\b|\bmaistarde\b/))) { add = 60; vago = true; trecho = m[0]; }
    }
    const faixa = relFaixaEm(s); const ha = relHoraAbs(s);
    if (add != null && add >= 1440 && !vago) { // dias + (faixa do dia | hora exata)
        if (ha) abs = { h: ha.h, m: ha.m, dia: true }; else if (faixa && !abs) abs = { h: faixa[0], m: faixa[1], dia: true };
    }
    if (add == null && !abs) { if (ha) return { nivel: ha.cue ? 'auto' : 'chip', tipo: 'abs', addMin: 0, setHora: [ha.h, ha.m], abs: true, vago: false, trecho: 'às ' + ha.h + 'h' + (ha.m ? pad2(ha.m) : '') }; return null; }
    return { nivel: vago ? 'chip' : 'auto', tipo: vago ? 'vago' : 'delta', addMin: add || 0, setHora: abs ? [abs.h, abs.m] : null, abs: false, vago, trecho };
}
// Lê uma mensagem. 'rp': só a NARRAÇÃO entre *asteriscos* pode saltar sozinha; fora dela ou falas entre aspas, no máximo pergunta.
// 'espaco': nunca é automático (é conversa de bastidor): sempre pergunta.
function relInterpretar(texto, origem) {
    const t = String(texto || ''); let segs = [], fora = t;
    if (origem === 'rp') { const re = /\*+([^*]+?)\*+/g; let m; while ((m = re.exec(t))) segs.push(m[1]); fora = t.replace(/\*+[^*]+?\*+/g, ' '); }
    fora = fora.replace(/["“”«»][^"“”«»]*["“”«»]/g, ' ');
    if (origem === 'rp') for (const s of segs) { const r = relAcharEm(s); if (r) return r; }
    const rf = relAcharEm(fora); if (rf) { rf.nivel = 'chip'; return rf; }
    return null;
}
// Calcula o novo relógio e decide se pode ser automático. Não muda nada.
function relPlanejar(rel, salto) {
    const antes = rel.dia * 1440 + rel.hora * 60 + rel.minuto; let total = antes, nivel = salto.nivel, rotulo;
    if (salto.addMin) total += salto.addMin;
    if (salto.setHora) {
        const alvoNoDia = Math.floor(total / 1440) * 1440 + salto.setHora[0] * 60 + salto.setHora[1];
        if (!salto.addMin && alvoNoDia <= antes) { total = alvoNoDia + 1440; nivel = 'chip'; rotulo = 'para o dia seguinte'; } // "às 7h" quando já passou das 7h
        else total = alvoNoDia;
    }
    const delta = total - antes;
    if (delta > REL_MAX_AUTO_DIAS * 1440) nivel = 'chip';
    if (salto.abs && !salto.addMin && delta > 14 * 60) nivel = 'chip';
    const dia = Math.max(1, Math.floor(total / 1440)), resto = total - Math.floor(total / 1440) * 1440;
    return { nivel, para: { dia, hora: Math.floor(resto / 60), minuto: resto % 60 }, deltaMin: delta, rotulo: rotulo || relRotuloMin(delta) };
}

// <<RELOGIO-PURO
const relFalha = (e) => console.warn('[Spade] relógio:', e && e.message ? e.message : e);
const relPadrao = () => ({ ligado: false, dia: 1, hora: 9, minuto: 0, historico: [], ultimoIdx: 0 });
function relNormalizar(c) {
    const r = Object.assign(relPadrao(), c || {}); r.ligado = !!r.ligado;
    r.dia = Math.max(1, Math.round(+r.dia) || 1); r.hora = Math.min(23, Math.max(0, Math.round(+r.hora) || 0)); r.minuto = Math.min(59, Math.max(0, Math.round(+r.minuto) || 0));
    r.historico = Array.isArray(r.historico) ? r.historico.slice(-20) : []; r.ultimoIdx = Math.max(0, Math.round(+r.ultimoIdx) || 0); return r;
}
const relAtual = () => Mem.relogio || relPadrao();
// v7 guardava UM relógio por personagem (banco antigo, só leitura aqui). Copia uma vez, pro primeiro chat que abrir.
async function relMigrarLegado() {
    try {
        const marca = 'relmig|' + P(); if (await locGet(marca)) return null; await locSet(marca, Date.now());
        const v7 = await estadoGet('mundo', null); if (!v7 || !(v7.dia >= 1)) return null;
        return { ligado: true, dia: v7.dia, hora: v7.hora, minuto: v7.minuto || 0, ultimoIdx: (ctx().chat || []).length, migradoDaV7: true };
    } catch (_) { return null; }
}
async function relAplicarPlano(plano, motivo, { ligar } = {}) {
    await memCarregar(); const r = Mem.relogio; const de = { dia: r.dia, hora: r.hora, minuto: r.minuto, ligado: r.ligado };
    r.dia = plano.para.dia; r.hora = plano.para.hora; r.minuto = plano.para.minuto; if (ligar) { r.ligado = true; r.ultimoIdx = (ctx().chat || []).length; }
    r.historico.push({ ts: Date.now(), de, para: Object.assign({}, plano.para), motivo: motivo || 'ajuste' }); r.historico = r.historico.slice(-20);
    relSaltouNaRodada = true; await memSalvar('relogio'); refrescarUI();
}
async function relDesfazer() {
    await memCarregar(); const r = Mem.relogio; const h = r.historico.pop(); if (!h) { toast('Nada para desfazer.'); return; }
    r.dia = h.de.dia; r.hora = h.de.hora; r.minuto = h.de.minuto; r.ligado = !!h.de.ligado; await memSalvar('relogio'); refrescarUI(); toast('Voltei para ' + relUI(r) + '.');
}
let relSaltouNaRodada = false;
// +5 min por RESPOSTA nova da personagem (swipe/regenerate não contam; salto narrado e +5 nunca juntos, como na v7)
async function relRodada() {
    await memCarregar(); const r = Mem.relogio; const n = (ctx().chat || []).length;
    if (n < r.ultimoIdx) { r.ultimoIdx = n; return; } if (n === r.ultimoIdx) return; r.ultimoIdx = n;
    if (!r.ligado) return;
    if (relSaltouNaRodada) relSaltouNaRodada = false; else { const p = relPlanejar(r, { addMin: REL_MIN_RODADA, nivel: 'auto' }); r.dia = p.para.dia; r.hora = p.para.hora; r.minuto = p.para.minuto; }
    await memSalvar('relogio');
}
async function relLerMensagemUsuario(id) {
    const chat = ctx().chat || []; let m = chat[id]; if (!m || !m.is_user) m = chat.slice().reverse().find((x) => x.is_user && !x.is_system); if (!m) return;
    const salto = relInterpretar(m.mes, 'rp'); if (!salto) return; await memCarregar(); const r = Mem.relogio;
    if (!r.ligado && salto.nivel !== 'auto') return; // relógio desligado: só um salto claro liga (com "Desfazer")
    const plano = relPlanejar(r, salto);
    if (plano.nivel === 'auto') { const ligar = !r.ligado; await relAplicarPlano(plano, salto.trecho, { ligar }); relChip({ texto: (ligar ? 'Relógio ligado · ' : '') + relUI(plano.para) + ' (' + plano.rotulo + ')', botoes: [{ rotulo: 'Desfazer', fn: relDesfazer }], ms: 12000 }); }
    else relChip({ texto: 'Avançar ' + plano.rotulo + '? → ' + relUI(plano.para), botoes: [{ rotulo: 'Avançar', fn: () => relAplicarPlano(plano, salto.trecho, { ligar: true }) }, { rotulo: 'Ignorar' }], ms: 30000 });
}
async function relSugerirDoEspaco(texto) {
    const salto = relInterpretar(texto, 'espaco'); if (!salto) return; await memCarregar(); const plano = relPlanejar(Mem.relogio, salto);
    relChip({ texto: 'Avançar ' + plano.rotulo + '? → ' + relUI(plano.para), botoes: [{ rotulo: 'Avançar', fn: () => relAplicarPlano(plano, salto.trecho, { ligar: true }) }, { rotulo: 'Ignorar' }], ms: 30000 });
}
// ---- botão de confirmação (fica fora da janela: aparece mesmo com o painel fechado) ----
const Chip = { el: null, timer: null, acoes: [] };
function relChip({ texto, botoes, ms }) {
    if (!Chip.el) {
        Chip.el = document.createElement('div'); Chip.el.id = 'spd-chip'; document.body.appendChild(Chip.el);
        Chip.el.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (!b) return; const f = Chip.acoes[+b.dataset.i]; relChipFechar(); if (f) Promise.resolve().then(f).catch((er) => { console.warn('[Spade]', er); toast(er.message || String(er), true); }); });
    }
    Chip.acoes = (botoes || []).map((b) => b.fn);
    Chip.el.innerHTML = '<span>' + esc(texto) + '</span>' + (botoes || []).map((b, i) => '<button data-i="' + i + '">' + esc(b.rotulo) + '</button>').join('');
    Chip.el.classList.add('on'); clearTimeout(Chip.timer); Chip.timer = setTimeout(relChipFechar, ms || 15000);
}
function relChipFechar() { clearTimeout(Chip.timer); if (Chip.el) Chip.el.classList.remove('on'); }
// ---- cartão da tela Início ----
function relCardHtml() {
    const r = relAtual(); const h = r.historico.slice(-3).reverse();
    return '<div class="spd-rel"><div class="spd-rel-topo"><div><small>Relógio da história</small><b>' + (r.ligado ? esc(relUI(r)) : 'desligado') + '</b></div><div class="spd-rel-bt">'
        + '<button class="spd-btn" data-a="rel-ajustar">Ajustar</button>' + (r.historico.length ? '<button class="spd-btn" data-a="rel-desfazer">Desfazer</button>' : '')
        + '<button class="spd-btn ' + (r.ligado ? '' : 'prim') + '" data-a="rel-toggle">' + (r.ligado ? 'Desligar' : 'Ligar') + '</button></div></div>'
        + (h.length ? '<div class="spd-rel-h">' + h.map((x) => esc(relUI(x.para) + ' · ' + (x.motivo || 'ajuste'))).join('<br>') + '</div>' : '')
        + '<div class="sub" style="margin-top:10px">Escreva <i>*passaram dois dias*</i> na narração e o relógio avança. Se for vago, ou estiver fora dos asteriscos, eu só pergunto.</div></div>';
}


// ============================================================
// 08 COMPOSITOR DO PROMPT (seção 9) — ordem FIXA, formato idêntico, nenhuma palavra da extensão
//  1 QUEM ELA É · 2 REGRAS · 3 NOTAS · 4 MEMÓRIA · 5 NOTAS DO AUTOR · (6 chat: é do SillyTavern) · 7 ESTILO · 8 AGORA
// O adendo A acrescentou o ESTILO; ele muda a cada resposta, então vai no FIM (volátil) e AGORA virou o 8.
// Blocos 1–5 são o PREFIXO ESTÁVEL: idênticos byte a byte enquanto o usuário não mexer em nada (sem data, id ou contador).
// ============================================================
const BLOCOS = [
    { n: 1, chave: 'SPADE_1_QUEM', titulo: 'QUEM ELA É', zona: 'topo' }, { n: 2, chave: 'SPADE_2_REGRAS', titulo: 'REGRAS', zona: 'topo' },
    { n: 3, chave: 'SPADE_3_NOTAS', titulo: 'NOTAS', zona: 'topo' }, { n: 4, chave: 'SPADE_4_MEMORIA', titulo: 'MEMÓRIA', zona: 'topo' },
    { n: 5, chave: 'SPADE_5_AUTOR', titulo: 'NOTAS DO AUTOR', zona: 'fim1' },
    { n: 7, chave: 'SPADE_7_ESTILO', titulo: 'ESTILO', zona: 'fim0' }, { n: 8, chave: 'SPADE_8_AGORA', titulo: 'AGORA', zona: 'fim0' },
];
// Bloco 5 — pedidos do usuário no Espaço, LITERAIS (12.2). Respostas da IA do Espaço nunca entram.
function blocoAutor(orcamento) {
    const duraveis = (Mem.espaco.pedidos || []).map((p) => p.texto); const recentes = espacoPedidosRecentes().map((m) => m.texto);
    const fmt = (t) => { const ls = String(t).split(/\r?\n/).map((l) => l.trim()).filter(Boolean); return ls.length ? '- ' + ls.join('\n  ') : ''; };
    const fora = []; let usado = 0; const manter = (lista, rotulo) => { const ok = []; for (const t of lista.slice().reverse()) { const c = estimarTokens(fmt(t)) + 1; if (usado + c > orcamento) { fora.push({ texto: t, motivo: 'fora do orçamento (' + rotulo + ')' }); continue; } usado += c; ok.unshift(t); } return ok; };
    const rec = manter(recentes, 'pedido recente'); const dur = manter(duraveis, 'pedido duradouro'); // o mais novo vale mais: recentes primeiro
    const secoes = [];
    if (dur.length) secoes.push('### Pedidos que continuam valendo\n' + dur.map(fmt).join('\n'));
    if (rec.length) secoes.push('### Pedidos recentes do autor\n' + rec.map(fmt).join('\n'));
    return { texto: secoes.length ? '## NOTAS DO AUTOR\n' + secoes.join('\n') : '', fora };
}
function blocoAgora(substituicao) {
    const rep = medirRepeticao(falasParaRepeticao(substituicao), getConfig().tiquesCadastrados);
    const ev = textoEvitar(rep);
    const partes = [formatarItem('Antes de responder', instrucaoPensamento())];
    const rel = relAtual(); if (rel.ligado) partes.unshift(formatarItem('Momento da história', relTexto(rel) + '.')); // 12.6 (sem palavras da extensão)
    if (ev) partes.push('### Evitar\n' + ev);
    partes.push(formatarItem('Resposta', INSTRUCAO_RESPOSTA));
    return { texto: '## AGORA\n' + partes.join('\n'), repeticao: rep };
}
function montarPrompt(opts = {}) {
    const cfg = getConfig(); const avisos = [];
    const sel = selecionarNotas(itensDaBiblioteca(), cfg.limiteBiblioteca);
    const mem = blocoMemoria(cfg.limiteRp); const autor = blocoAutor(cfg.limiteEspaco); const agora = blocoAgora(!!opts.substituicao); const estilo = blocoEstilo();
    const textos = { 1: blocoDescricao(), 2: blocoRegras(), 3: sel.escolhidos.length ? '## NOTAS\n' + sel.escolhidos.map((e) => e.texto).join('\n') : '', 4: mem.texto, 5: autor.texto, 7: estilo.texto, 8: agora.texto };
    const blocos = BLOCOS.map((b) => ({ n: b.n, chave: b.chave, titulo: b.titulo, zona: b.zona, texto: textos[b.n] || '', tokens: textos[b.n] ? estimarTokens(textos[b.n]) : 0 }));
    const total = blocos.reduce((a, b) => a + b.tokens, 0);
    const soma = cfg.limiteRp + cfg.limiteEspaco + cfg.limiteBiblioteca;
    if (soma > cfg.limiteGeral) avisos.push('A soma dos limites das gavetas (' + soma + ') passa do limite geral (' + cfg.limiteGeral + ').');
    if (total > cfg.limiteGeral) avisos.push('O que a Spade injeta (' + total + ' tokens) passa do limite geral (' + cfg.limiteGeral + '). Nada foi cortado: ajuste os limites ou desligue notas.');
    const dt = blocos[0].tokens; if (dt > cfg.limiteDescricao) avisos.push('A Descrição tem ' + dt + ' tokens (sugerido: até ' + cfg.limiteDescricao + ').');
    return { blocos, total, limite: cfg.limiteGeral, avisos, gavetas: { biblioteca: { usado: blocos[2].tokens, limite: cfg.limiteBiblioteca }, rp: { usado: blocos[3].tokens, limite: cfg.limiteRp }, espaco: { usado: blocos[4].tokens, limite: cfg.limiteEspaco } },
        fora: { biblioteca: sel.fora, memoria: mem.fora, espaco: autor.fora }, naoSabe: mem.naoSabe, selecionadas: sel.escolhidos, estilo, repeticao: agora.repeticao };
}
const prefixoEstavel = (p) => p.blocos.filter((b) => b.n <= 5).map((b) => b.texto).join('\n\n');
const promptComoTexto = (p) => p.blocos.filter((b) => b.texto).map((b) => b.texto).join('\n\n');

// ============================================================
// 09 ENTREGA AO SILLYTAVERN (9.4 e 9.5) — quem GERA a fala é sempre o SillyTavern; a Spade só alimenta os slots
// ============================================================
const Diag = { eventosFaltando: [], ultimoPrompt: null, ultimoPromptEm: 0, ultimoSync: 0, ultimaOrdem: null, slotsAplicados: {} };
function tiposDoST() {
    const c = ctx(); const t = c.extension_prompt_types || c.extensionPromptTypes; const r = c.extension_prompt_roles || c.extensionPromptRoles;
    // Se esta instalação não expõe as constantes, usa os números conhecidos (IN_PROMPT=0, IN_CHAT=1, BEFORE_PROMPT=2; SYSTEM=0) — NÃO verificado aqui: a Prévia confere a posição real.
    return { IN_PROMPT: t?.IN_PROMPT ?? 0, IN_CHAT: t?.IN_CHAT ?? 1, BEFORE_PROMPT: t?.BEFORE_PROMPT ?? 2, SYSTEM: r?.SYSTEM ?? 0, deConstantes: !!t };
}
function aplicarSlots(p) {
    const c = ctx(); if (typeof c.setExtensionPrompt !== 'function') { Diag.slotsAplicados = { erro: 'setExtensionPrompt não existe nesta versão do SillyTavern' }; return; }
    const T = tiposDoST(); const topo = getConfig().posicaoTopo === 'before_prompt' ? T.BEFORE_PROMPT : T.IN_PROMPT;
    for (const b of p.blocos) { // insere SEMPRE nesta ordem: o ST junta slots da mesma posição na ordem em que as chaves nasceram
        const pos = b.zona === 'topo' ? topo : T.IN_CHAT; const depth = b.zona === 'fim1' ? 1 : 0;
        try { c.setExtensionPrompt(b.chave, b.texto, pos, depth, false, T.SYSTEM); Diag.slotsAplicados[b.chave] = { tokens: b.tokens, posicao: pos, depth }; }
        catch (e) { Diag.slotsAplicados[b.chave] = { erro: e.message }; console.warn('[Spade] slot', b.chave, e.message); }
    }
    Diag.ultimoSync = Date.now();
}
let _syncRodando = null;
async function sincronizar() {
    if (_syncRodando) return _syncRodando;
    _syncRodando = (async () => {
        try { await Promise.all([bibCarregar(), descCarregar(), memCarregar()]); await espacoCarregarParaRp(); aplicarSlots(montarPrompt()); refrescarUI(); }
        catch (e) { console.warn('[Spade] sincronizar:', e); reportFatalError(e); }
        finally { _syncRodando = null; }
    })();
    return _syncRodando;
}
const sincronizarSoon = debounce(() => sincronizar().catch(reportFatalError), 120);
// Gancho de leitura antes de gerar: recalcula SÓ os blocos voláteis (5, 7 e 8), síncrono, e NUNCA chama abort() (9.5).
function sincronizarVolateis(type) {
    const substituicao = type === 'regenerate' || type === 'swipe';
    if (substituicao) { Rot.salt++; salvarRot(); }
    const p = montarPrompt({ substituicao }); const c = ctx(); const T = tiposDoST();
    for (const b of p.blocos.filter((x) => x.zona !== 'topo')) { try { c.setExtensionPrompt(b.chave, b.texto, T.IN_CHAT, b.zona === 'fim1' ? 1 : 0, false, T.SYSTEM); } catch (e) { console.warn(e.message); } }
    return p;
}
// O ST chama isto antes de montar o prompt (declarado no manifest). Sem abort(): quem gera é o próprio ST, então regenerate/swipe funcionam.
async function Spade_interceptGeneration(chatArr, contextSize, abort, type) {
    try { sincronizarVolateis(type); } catch (e) { reportFatalError(e); }
}
globalThis.Spade_interceptGeneration = Spade_interceptGeneration;

// ---- conferência da ordem real (T1): lê o prompt FINAL quando o ST avisa que ele ficou pronto ----
function conferirOrdemNoPromptFinal(msgs) {
    const achados = []; const faltando = [];
    for (const b of BLOCOS) {
        let achou = null;
        msgs.forEach((m, i) => { if (achou) return; const pos = String(m.content).indexOf('## ' + b.titulo + '\n'); if (pos >= 0) achou = { n: b.n, titulo: b.titulo, msg: i, pos }; });
        if (achou) achados.push(achou); else if (Diag.slotsAplicados[b.chave] && Diag.slotsAplicados[b.chave].tokens) faltando.push(b.titulo);
    }
    const emOrdem = achados.every((a, i) => i === 0 || a.msg > achados[i - 1].msg || (a.msg === achados[i - 1].msg && a.pos > achados[i - 1].pos));
    return { achados, faltando, emOrdem, totalMensagens: msgs.length };
}
function capturarPromptFinal(dados) {
    try {
        const msgs = (dados && (dados.chat || dados.messages)) || []; if (!Array.isArray(msgs)) return;
        Diag.ultimoPrompt = msgs.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })); Diag.ultimoPromptEm = Date.now();
        Diag.ultimaOrdem = conferirOrdemNoPromptFinal(Diag.ultimoPrompt); refrescarUI();
    } catch (e) { console.warn('[Spade] captura do prompt final:', e.message); }
}
function ligarEventos() {
    const on = (nome, fn) => { if (event_types && event_types[nome]) eventSource.on(event_types[nome], (...a) => { try { fn(...a); } catch (e) { reportFatalError(e); } }); else Diag.eventosFaltando.push(nome); };
    on('APP_READY', () => { atualizarCacheFalas(); sincronizarSoon(); });
    on('CHAT_CHANGED', () => { atualizarCacheFalas(); Mem.chatId = null; espacoTrocouChat(); sincronizarSoon(); });
    on('MESSAGE_SENT', (id) => { relLerMensagemUsuario(id).catch(relFalha); sincronizarSoon(); });
    on('MESSAGE_SWIPED', () => sincronizarSoon());
    on('MESSAGE_DELETED', () => { atualizarCacheFalas(); sincronizarSoon(); });
    on('MESSAGE_EDITED', () => { atualizarCacheFalas(); sincronizarSoon(); });
    on('CHARACTER_MESSAGE_RENDERED', () => { atualizarCacheFalas(); Rot.reforco = false; relRodada().catch(relFalha); sincronizarSoon(); espacoVerLimiarMemoria(); });
    on('GENERATION_STARTED', () => { /* a recomputação de verdade acontece no interceptor, que recebe o `type` */ });
    on('CHAT_COMPLETION_PROMPT_READY', capturarPromptFinal);
}

// ============================================================
// 10 IA E JOBS (12.4) — a MESMA IA, só por evento (clique, mensagem com arquivo ou limiar), visível na tela. Sem timer, sem loop.
// ============================================================
const NANOGPT_BASE = 'https://nano-gpt.com/api/v1';
const Pensa = { recusado: false }; // 14, item 10: a NanoGPT repassa `thinking`? Não testado — se a API recusar, paramos de enviar e avisamos.
function anySignal(sinais) {
    const v = sinais.filter(Boolean); if (v.length <= 1) return v[0];
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(v);
    const c = new AbortController(); v.forEach((s) => { if (s.aborted) c.abort(); else s.addEventListener('abort', () => c.abort(), { once: true }); }); return c.signal;
}
const ehErroDeAutenticacao = (e) => /^NanoGPT \((401|403)\)/.test(String(e && e.message));
async function comRetentativas(fn, { tentativas = 2, esperaMs = 1500 } = {}) {
    let ultimo;
    for (let i = 0; i < tentativas; i++) { try { return await fn(); } catch (e) { ultimo = e; if (ehErroDeAutenticacao(e) || e.name === 'AbortError' || e.naoTentarDeNovo) break; if (i < tentativas - 1) await sleep(esperaMs * (i + 1)); } }
    throw ultimo;
}
const filtrarThinking = (t) => String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim();
async function generate(messages, opts = {}) {
    const cfg = getConfig(); if (!cfg.apiKey) throw new Error('Falta a API key da NanoGPT. Cole a key em Configurações.');
    return comRetentativas(async () => {
        const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 180000);
        try {
            const corpo = { model: opts.model || cfg.modelo, messages, max_tokens: opts.maxTokens ?? 2500, temperature: opts.temperature ?? 0.3 };
            const th = opts.thinking ?? cfg.thinkingNosJobs; if ((th === 'disabled' || th === 'enabled') && !Pensa.recusado) corpo.thinking = { type: th };
            const resp = await fetch(NANOGPT_BASE + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey }, signal: anySignal([ctrl.signal, opts.signal]), body: JSON.stringify(corpo) });
            if (!resp.ok) {
                const txt = (await resp.text()).slice(0, 300);
                if (resp.status === 400 && corpo.thinking && /thinking/i.test(txt)) { Pensa.recusado = true; const e = new Error('A API não aceitou o parâmetro "thinking"; tentando de novo sem ele.'); throw e; }
                const e = new Error('NanoGPT (' + resp.status + '): ' + txt); if (resp.status === 400 || resp.status === 413) e.naoTentarDeNovo = true; throw e;
            }
            const d = await resp.json(); const ch = d.choices && d.choices[0]; const conteudo = filtrarThinking(ch && ch.message && ch.message.content);
            if (ch && ch.finish_reason === 'length') { const e = new Error('A resposta foi cortada antes de terminar (limite de tokens do modelo). Nada foi aplicado.'); e.naoTentarDeNovo = true; throw e; }
            if (!conteudo) throw new Error('A IA devolveu vazio.');
            return conteudo;
        } finally { clearTimeout(timer); }
    }, { tentativas: 3 });
}
function parseJsonObjetoSeguro(t) { const m = String(t || '').match(/\{[\s\S]*\}/); if (!m) return null; try { const o = JSON.parse(m[0]); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (_) { return null; } }

// ---- fila de jobs: um de cada vez, com estado, tokens estimados, cancelar e resultado revisável ----
const Jobs = { lista: [], fila: Promise.resolve() };
function criarJob({ nome, tipo, tokens, rodar, alvoId }) {
    const job = { id: newId('j'), nome, tipo, tokens: tokens || 0, estado: 'fila', criadoEm: Date.now(), ctrl: new AbortController(), resultado: null, erro: null, desfazer: null, detalhe: '', alvoId: alvoId || null };
    Jobs.lista.unshift(job); Jobs.lista.length = Math.min(Jobs.lista.length, 40);
    Jobs.fila = Jobs.fila.then(async () => {
        if (job.estado === 'cancelado') return;
        job.estado = 'rodando'; job.iniciadoEm = Date.now(); refrescarUI();
        try { job.resultado = await rodar(job); if (job.estado !== 'cancelado') job.estado = 'ok'; }
        catch (e) { job.estado = job.ctrl.signal.aborted ? 'cancelado' : 'erro'; job.erro = job.ctrl.signal.aborted ? 'Cancelado.' : e.message; }
        job.fimEm = Date.now(); refrescarUI();
    });
    refrescarUI(); return job;
}
function cancelarJob(job) { job.ctrl.abort(); if (job.estado === 'fila') job.estado = 'cancelado'; refrescarUI(); }
const jobsAtivos = () => Jobs.lista.filter((j) => j.estado === 'fila' || j.estado === 'rodando');

// ---- análise de arquivo (8.4 + adendo A passo 1) ----
const TAMANHO_NOTA = { curta: '80 a 200 tokens', padrao: '120 a 400 tokens', longa: '300 a 700 tokens' };
async function textoOriginalDe(a) { const d = await Disco.arqLer(a.id, ['original']); return d.original || ''; }
const entraNoEstilo = (a) => a.meta.tipo === 'tom' || a.meta.usarComoEstilo;
function notasExistentesParaAnalise(a, orcamento) {
    const out = []; let usado = 0;
    for (const o of listaArquivos()) {
        if (o.id === a.id || !o.nota) continue;
        const mesmo = (a.meta.grupoId && o.meta.grupoId === a.meta.grupoId) || o.meta.pastaId === a.meta.pastaId;
        const t = (mesmo ? o.nota.completa : o.nota.minima) || o.nota.completa || ''; if (!t) continue;
        const linha = '[' + o.id + '] ' + (o.meta.titulo || o.meta.nome) + ' (' + o.meta.tipo + '): ' + t.replace(/\s+/g, ' ');
        const c = estimarTokens(linha); if (usado + c > orcamento) continue; usado += c; out.push(linha);
    }
    return out;
}
async function montarPedidoAnalise(a, original, p0) {
    await descCarregar();
    const exp = a.meta.explicacoes.map((e, i) => (i + 1) + '. ' + e.texto).join('\n') || '(sem explicação: deduza só pelo conteúdo e avise)';
    const obs = a.meta.observacaoVisivelParaIA && a.meta.observacao ? a.meta.observacao : '(nenhuma)';
    const existentes = notasExistentesParaAnalise(a, 3500).join('\n') || '(nenhuma)';
    const cfg = getConfig();
    const sistema = 'Você organiza arquivos de uma história de RP para uma IA que vai interpretar uma personagem. Escreva NOTAS curtas, em português do Brasil, sem emojis. Responda SOMENTE com um JSON válido, sem texto fora dele.';
    const usuario = [
        '## ARQUIVO (inteiro, nome: ' + a.meta.nome + ')\n' + original,
        '## EXPLICAÇÕES do usuário (leia juntas, na ordem)\n' + exp,
        '## OBSERVAÇÃO do usuário\n' + obs,
        '## DESCRIÇÃO da personagem (não repita o que já está nela)\n' + (blocoDescricao() || '(vazia)'),
        '## NOTAS QUE JÁ EXISTEM (id entre colchetes)\n' + existentes,
        '## REGRAS FIRMES DO PROMPT\n' + REGRAS_ITENS.map(([t, x]) => t + ': ' + x.replace(/\n/g, ' ')).join('\n'),
        '## O QUE PRODUZIR\nEscreva a nota NOVA dizendo COMO ela complementa as existentes, sem repetir o que elas já dizem; se algo contradiz uma nota existente, aponte em "avisos". "nota_completa": ' + TAMANHO_NOTA[cfg.tamanhoNota] + ', 4 partes curtas em linhas separadas, na ordem: "O que é", "Como usar", "Fatos-chave", "Complementa". "nota_minima": 1 a 2 linhas (máx. ~50 tokens), só para a IA saber que isto existe e quando importa. Formato do JSON: {"titulo":"…","tipo_sugerido":"tom|lore|regra|documento","nota_completa":"…","nota_minima":"…","complementa":[{"arquivoId":"…","como":"…"}],"grupo_sugerido":["arquivoId"],"avisos":["…"]' + (p0 ? ',"estilo":{…}' : '') + '}.',
    ];
    if (p0) usuario.push('## ' + pedidoEstiloParaIA(p0));
    return [{ role: 'system', content: sistema }, { role: 'user', content: usuario.join('\n\n') }];
}
function rodarAnalise(a, { vozAlvo } = {}) {
    return criarJob({ nome: (a.nota ? 'Reanalisar: ' : 'Analisar: ') + a.meta.nome, tipo: 'analisar', alvoId: a.id, tokens: Math.ceil((a.meta.chars || 0) / 3.5) + 2500, rodar: async (job) => {
        a.meta.estado = 'analisando'; refrescarUI();
        try {
            const original = await textoOriginalDe(a);
            if (!original.trim()) throw new Error('O arquivo está vazio.');
            const p0 = entraNoEstilo(a) ? estiloPasso0(original, vozAlvo || (a.nota && a.nota.estilo && a.nota.estilo.vozAlvo) || null) : null; // passo 0: código, antes da IA
            const msgs = await montarPedidoAnalise(a, original, p0);
            job.tokens = estimarTokens(msgs.map((m) => m.content).join('')); job.detalhe = 'enviado inteiro: ' + original.length + ' caracteres';
            const bruto = await generate(msgs, { signal: job.ctrl.signal, maxTokens: p0 ? 7000 : 3500, temperature: 0.3 });
            const r = parseJsonObjetoSeguro(bruto); if (!r || !(r.nota_completa || r.nota_minima)) throw new Error('A IA não devolveu a nota no formato esperado. Nada foi aplicado.');
            const nova = { completa: String(r.nota_completa || r.nota_minima).trim(), minima: String(r.nota_minima || '').trim(), geradaEm: Date.now(), modelo: getConfig().modelo, editadaPeloUsuario: false, revisada: false, complementa: Array.isArray(r.complementa) ? r.complementa : [], avisos: (Array.isArray(r.avisos) ? r.avisos : []).map(String), grupoSugerido: Array.isArray(r.grupo_sugerido) ? r.grupo_sugerido : [], tipoSugerido: r.tipo_sugerido || null, titulo: r.titulo || null, historico: [] };
            if (p0) { nova.estilo = estiloPasso2(r.estilo || {}, p0, original); nova.estilo.vozAlvo = vozAlvo || (a.nota && a.nota.estilo && a.nota.estilo.vozAlvo) || null; if (a.nota && a.nota.estilo && a.nota.estilo.editadaPeloUsuario) nova.estiloEditadoAnterior = a.nota.estilo; }
            if (a.nota && a.nota.editadaPeloUsuario) { a.nota.proposta = nova; } // reanálise NUNCA sobrescreve o que o usuário editou sem perguntar
            else { nova.historico = a.nota ? [{ completa: a.nota.completa, minima: a.nota.minima, em: a.nota.geradaEm }].concat(a.nota.historico || []).slice(0, 5) : []; a.nota = nova; if (!a.meta.titulo && nova.titulo) a.meta.titulo = nova.titulo; }
            a.meta.estado = 'pronto'; a.meta.analisadoEm = Date.now(); a.meta.tipoSugerido = nova.tipoSugerido;
            await salvarNotaArq(a); await salvarMetaArq(a);
            return { arquivoId: a.id, aviso: (nova.avisos || []).join(' · ') };
        } catch (e) { a.meta.estado = 'erro'; a.meta.erro = e.message; try { await salvarMetaArq(a); } catch (_) { /* o erro original é o que importa */ } throw e; }
    } });
}
// nota mínima que faltou (notas importadas): job pequeno e visível
function rodarMinima(a) {
    return criarJob({ nome: 'Gerar nota mínima: ' + a.meta.nome, tipo: 'minima', alvoId: a.id, tokens: estimarTokens(a.nota.completa) + 300, rodar: async (job) => {
        const bruto = await generate([{ role: 'system', content: 'Responda SOMENTE com JSON: {"minima":"1 a 2 linhas, máx. ~50 tokens, só pra IA saber que isto existe e quando importa"}.' }, { role: 'user', content: (a.meta.titulo || a.meta.nome) + '\n\n' + a.nota.completa }], { signal: job.ctrl.signal, maxTokens: 400 });
        const r = parseJsonObjetoSeguro(bruto); if (!r || !r.minima) throw new Error('A IA não devolveu a nota mínima.');
        a.nota.minima = String(r.minima).trim(); await salvarNotaArq(a); return { arquivoId: a.id };
    } });
}
function rodarNotaDeGrupo(g) {
    const membros = g.arquivoIds.map((id) => Bib.arquivos.get(id)).filter((a) => a && a.nota);
    return criarJob({ nome: 'Nota do grupo: ' + g.nome, tipo: 'grupo', tokens: estimarTokens(membros.map((a) => a.nota.completa).join('')) + 400, rodar: async (job) => {
        const bruto = await generate([{ role: 'system', content: 'Una as notas abaixo numa NOTA ÚNICA, sem repetir o que se repete entre elas, em português do Brasil, linhas curtas. Responda SOMENTE com JSON: {"completa":"…","minima":"1 a 2 linhas"}.' }, { role: 'user', content: membros.map((a) => '### ' + (a.meta.titulo || a.meta.nome) + '\n' + a.nota.completa).join('\n\n') }], { signal: job.ctrl.signal, maxTokens: 1800 });
        const r = parseJsonObjetoSeguro(bruto); if (!r || !r.completa) throw new Error('A IA não devolveu a nota do grupo.');
        g.nota = { completa: String(r.completa).trim(), minima: String(r.minima || '').trim(), geradaEm: Date.now(), editadaPeloUsuario: false, revisada: false }; await bibSalvarIndice(); return {};
    } });
}
// ---- memória do RP (12.5): fatos curtos com "quem sabe", sempre com diff e desfazer ----
function mensagensNovasDoChat() { const arr = ctx().chat || []; return arr.slice(Mem.rp.ultimoIdx || 0).map((m, i) => ({ idx: (Mem.rp.ultimoIdx || 0) + i, quem: m.is_user ? (ctx().name1 || 'Usuário') : (m.name || personagemAtual()), texto: String(m.mes || '').trim().slice(0, 1400) })).filter((m) => m.texto); }
function rodarMemoriaRp() {
    const msgs = mensagensNovasDoChat().slice(-80);
    return criarJob({ nome: 'Atualizar memória do RP', tipo: 'memoria', tokens: estimarTokens(msgs.map((m) => m.texto).join('') + JSON.stringify(Mem.rp.fatos)) + 800, rodar: async (job) => {
        await Promise.all([memCarregar(true), descCarregar()]);
        const estourou = estimarTokens(Mem.rp.fatos.map((f) => f.texto).join('\n')) > getConfig().limiteRp;
        const nome = personagemAtual();
        const sis = 'Você mantém a MEMÓRIA de uma história de RP: fatos curtos (uma frase), concretos, em português do Brasil. Para cada fato diga QUEM SABE (lista de nomes: quem estava presente ou ficou sabendo). Responda SOMENTE com JSON: {"novos":[{"texto":"…","sabem":["nome"],"quandoMsgIdx":12}],"substituir":[{"id":"…","texto":"…","sabem":["nome"]}],"remover":["id"]}.' + (estourou ? ' A memória passou do orçamento: COMPRIMA — funda fatos parecidos, remova duplicados, mantenha o mais recente e preserve o que a personagem ' + nome + ' sabe.' : '');
        const usu = '## PERSONAGEM\n' + nome + '\n\n## DESCRIÇÃO\n' + (blocoDescricao() || '(vazia)') + '\n\n## MEMÓRIA ATUAL (id: fato | quem sabe)\n' + (Mem.rp.fatos.map((f) => f.id + ': ' + f.texto + ' | ' + (f.sabem || []).join(', ')).join('\n') || '(vazia)') + '\n\n## MENSAGENS NOVAS (índice, quem: texto)\n' + msgs.map((m) => '[' + m.idx + '] ' + m.quem + ': ' + m.texto).join('\n');
        const bruto = await generate([{ role: 'system', content: sis }, { role: 'user', content: usu }], { signal: job.ctrl.signal, maxTokens: 3000 });
        const r = parseJsonObjetoSeguro(bruto); if (!r) throw new Error('A IA não devolveu a memória no formato esperado. Nada foi aplicado.');
        const antes = JSON.parse(JSON.stringify(Mem.rp)); const ids = new Set(Mem.rp.fatos.map((f) => f.id));
        const rem = new Set((r.remover || []).filter((id) => ids.has(id)));
        const sub = new Map((r.substituir || []).filter((s) => ids.has(s.id) && s.texto).map((s) => [s.id, s]));
        let fatos = Mem.rp.fatos.filter((f) => !rem.has(f.id)).map((f) => (sub.has(f.id) ? Object.assign({}, f, { texto: String(sub.get(f.id).texto).trim(), sabem: sub.get(f.id).sabem || f.sabem }) : f));
        const novos = (r.novos || []).filter((n) => n && n.texto).map((n) => ({ id: newId('f'), texto: String(n.texto).trim(), sabem: Array.isArray(n.sabem) && n.sabem.length ? n.sabem.map(String) : [nome], quandoMsgIdx: n.quandoMsgIdx ?? null, criadoEm: Date.now() }));
        Mem.rp.fatos = fatos.concat(novos); Mem.rp.ultimoIdx = (ctx().chat || []).length; await memSalvar('rp');
        job.desfazer = async () => { Mem.rp = antes; await memSalvar('rp'); };
        return { novos: novos.map((n) => n.texto), substituidos: [...sub.values()].map((s) => s.texto), removidos: Array.from(rem).map((id) => (antes.fatos.find((f) => f.id === id) || {}).texto).filter(Boolean) };
    } });
}
function rodarConsolidarEspaco(textosAntigos) {
    return criarJob({ nome: 'Consolidar pedidos do Espaço', tipo: 'espaco', tokens: estimarTokens(textosAntigos.join('')) + 600, rodar: async (job) => {
        await memCarregar(true);
        const bruto = await generate([{ role: 'system', content: 'Do que o usuário pediu nas mensagens antigas, extraia só PEDIDOS DURADOUROS (ajustes que continuam valendo), curtos, literais no sentido. O ÚLTIMO pedido vale mais: pedidos conflitantes são substituídos pelo mais novo. Responda SOMENTE com JSON: {"pedidos":["…"]} contendo a lista COMPLETA e final (inclua os atuais que continuam valendo).' }, { role: 'user', content: '## PEDIDOS DURADOUROS ATUAIS\n' + (Mem.espaco.pedidos.map((p) => '- ' + p.texto).join('\n') || '(nenhum)') + '\n\n## MENSAGENS ANTIGAS (da mais velha à mais nova)\n' + textosAntigos.map((t) => '- ' + t).join('\n') }], { signal: job.ctrl.signal, maxTokens: 1500 });
        const r = parseJsonObjetoSeguro(bruto); if (!r || !Array.isArray(r.pedidos)) throw new Error('A IA não devolveu os pedidos no formato esperado. Nada foi aplicado.');
        const antes = JSON.parse(JSON.stringify(Mem.espaco));
        Mem.espaco.pedidos = r.pedidos.map((t) => String(t).trim()).filter(Boolean).map((texto) => ({ id: newId('q'), texto, criadoEm: Date.now() })); Mem.espaco.consolidadoEm = Date.now(); await memSalvar('espaco');
        job.desfazer = async () => { Mem.espaco = antes; await memSalvar('espaco'); };
        return { pedidos: Mem.espaco.pedidos.map((p) => p.texto) };
    } });
}

// ============================================================
// 11 BACKUP, EXPORTAÇÃO E MIGRAÇÃO (15.2 e 15.3)
// ============================================================
function baixarArquivo(nome, texto, tipo = 'application/json') {
    const url = URL.createObjectURL(new Blob([texto], { type: tipo })); const a = document.createElement('a');
    a.href = url; a.download = nome; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
}
// Exportar tudo: UM arquivo com a Biblioteca (originais inclusos), memória, Descrição, Espaço e config SEM a apiKey.
async function exportarTudo() {
    await Promise.all([bibCarregar(true), descCarregar(true), memCarregar(true)]);
    const cfg = getConfig(); delete cfg.apiKey;
    const arquivos = []; for (const a of listaArquivos()) arquivos.push({ id: a.id, meta: a.meta, nota: a.nota, original: await textoOriginalDe(a).catch(() => null) });
    const chats = await obterEspacoChats(); const historicos = {}; const memorias = {};
    for (const c of chats) { historicos[c.id] = await estadoGet('espacoHistory:' + c.id, []); if (c.stChatId && !memorias[c.stChatId]) { const [rp, es] = await Promise.all([Disco.memLer(c.stChatId, 'rp'), Disco.memLer(c.stChatId, 'espaco')]); memorias[c.stChatId] = { rp: rp.conteudo, espaco: es.conteudo }; } }
    const dados = { spade: VERSAO, exportadoEm: new Date().toISOString(), personagem: P(), config: cfg, biblioteca: { indice: Bib.indice, arquivos }, descricao: Desc.v, memorias, conexoes: Mem.con, espaco: { chats, historicos } };
    baixarArquivo('spade-' + semAcento(P()).toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(dados, null, 1));
    return { arquivos: arquivos.length, conversas: chats.length };
}
async function backupAgora() { if (Plug.ok === false) throw new Error('Backup no disco precisa do plugin spade-fs (ele não respondeu). Use "Exportar tudo".'); return chamarFs('/backup/criar', { rotulo: 'manual' }); }

// ---- migração dos documentos da v7 (idempotente: rodar duas vezes não duplica nada) ----
const MAPA_CATEGORIA = [[/regra|rule/i, 'regra'], [/lore|mundo|world|cen[aá]rio/i, 'lore'], [/tom|estilo|voz|style/i, 'tom']];
const hash6 = (s) => hashStr(String(s)).toString(36).slice(0, 6);
async function migrarDocumentos(aoProgresso) {
    if (Plug.ok === false) throw new Error('A migração lê os documentos antigos do disco e precisa do plugin spade-fs.');
    await bibCarregar(true);
    const lista = (await chamarFs('/documento/listar', { personagem: P(), todosOsChats: true })).documentos;
    const rel = { total: lista.length, criados: 0, jaExistiam: 0, comNota: 0, semNota: 0, erros: [], backup: null };
    if (!lista.length) return rel;
    rel.backup = (await chamarFs('/backup/criar', { rotulo: 'pre-migracao' })).nome; // rede de segurança ANTES de mexer
    let pasta = Bib.indice.pastas.find((p) => p.nome === 'Importados'); if (!pasta) pasta = await criarPasta('Importados', CORES_PASTA[1]);
    let i = 0;
    for (const d of lista) {
        i++; aoProgresso && aoProgresso(i, lista.length);
        const id = d.escopo === 'chat' ? 'mig-c' + hash6(d.chatId) + '-' + d.slug : 'mig-' + d.slug; // chave estável = escopo + slug original
        const idSeguro = id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 150);
        if (Bib.arquivos.has(idSeguro)) { rel.jaExistiam++; continue; }
        try {
            const doc = await chamarFs('/documento/ler', { personagem: P(), slug: d.slug, chatId: d.escopo === 'chat' ? d.chatId : undefined });
            const tipo = (MAPA_CATEGORIA.find(([re]) => re.test(doc.categoria || '')) || [, 'documento'])[1];
            const a = await criarArquivo({ id: idSeguro, nome: (doc.titulo || d.slug).replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.md', texto: doc.corpo, pastaId: pasta.id, tipo, escopo: d.escopo === 'chat' ? 'chat' : 'personagem', importado: true, extra: { sempreAtivo: !!doc.sempreIncluir, chatId: d.escopo === 'chat' ? d.chatId : null, titulo: doc.titulo || null, migradoDe: { slug: d.slug, escopo: d.escopo, categoria: doc.categoria || null } } });
            if (estimarTokens(doc.corpo) <= 400) { a.nota = { completa: doc.corpo.trim(), minima: '', geradaEm: Date.now(), editadaPeloUsuario: false, revisada: true, importada: true, historico: [] }; a.meta.estado = 'pronto'; a.meta.analisadoEm = Date.now(); await salvarNotaArq(a); await salvarMetaArq(a); rel.comNota++; }
            else rel.semNota++;
            rel.criados++;
        } catch (e) { if (e.jaExiste) rel.jaExistiam++; else rel.erros.push(d.slug + ': ' + e.message); }
    }
    return rel;
}

// ============================================================
// 12 ESPAÇO (seção 12): conversa com a IA nos bastidores. Fala COM a IA; o RP é falado PELA IA através do ST.
// Os pedidos que o usuário escreve aqui valem na próxima fala do RP (bloco 5). As respostas da IA do Espaço NUNCA entram no RP.
// ============================================================
const Esp = { chats: null, abertaId: null, msgs: [], paraRp: [], pendentes: [], respondendo: false, sugestaoMemoria: false, busca: '' };
async function obterEspacoChats() { if (!Esp.chats) Esp.chats = await estadoGet('espacoChats', []); return Esp.chats; }
const salvarEspacoChats = () => estadoSet('espacoChats', Esp.chats);
async function lerHistorico(id) { return estadoGet('espacoHistory:' + id, []); }
async function salvarHistorico(id, msgs) { await estadoSet('espacoHistory:' + id, msgs.slice(-200)); }
function espacoTrocouChat() { Esp.chats = null; Esp.abertaId = null; Esp.msgs = []; Esp.paraRp = []; Esp.sugestaoMemoria = false; }
// Mensagens do usuário (de TODAS as conversas ligadas ao chat atual do ST) que valem pro RP — em memória, pra o interceptor ler sem await.
async function espacoCarregarParaRp() {
    const chats = (await obterEspacoChats()).filter((c) => c.stChatId && c.stChatId === stChatIdAtual()); const todas = [];
    for (const c of chats) (await lerHistorico(c.id)).forEach((m, i) => { if (m.role === 'user') todas.push({ id: c.id + ':' + i, convId: c.id, idx: i, texto: m.content, ts: m.ts || 0, enviar: m.enviarAoRp !== false }); });
    Esp.paraRp = todas.sort((a, b) => a.ts - b.ts);
}
function espacoPedidosRecentes() {
    const cfg = getConfig(); if (!cfg.espacoParaRp) return [];
    return Esp.paraRp.filter((m) => m.enviar && String(m.texto).trim()).slice(-cfg.espacoMaxMensagens);
}
const msgVaiPraRp = (convId, idx) => espacoPedidosRecentes().some((m) => m.convId === convId && m.idx === idx);
async function espacoAbrir(id) { Esp.abertaId = id; Esp.msgs = id ? await lerHistorico(id) : []; refrescarUI(); }
async function novaConversa(titulo) {
    await obterEspacoChats(); const c = { id: newId('esp'), titulo: titulo || 'Novo chat', criadoEm: Date.now(), atualizadoEm: Date.now(), stChatId: stChatIdAtual() || null };
    Esp.chats.unshift(c); await salvarEspacoChats(); await espacoAbrir(c.id); return c;
}
async function apagarConversa(id) {
    Esp.chats = (await obterEspacoChats()).filter((c) => c.id !== id); await salvarEspacoChats(); await estadoDel('espacoHistory:' + id);
    const g = grupoDaConversa(id); if (g) { g.chats = g.chats.filter((x) => x !== id); Mem.con.grupos = Mem.con.grupos.filter((x) => x.chats.length >= 2); await memSalvar('con'); }
    if (Esp.abertaId === id) await espacoAbrir(null); await espacoCarregarParaRp(); sincronizarSoon();
}
// ---- conexões entre conversas (12.3): grupos; a IA de uma enxerga a outra; o RP recebe a memória RP do vizinho ----
async function adicionarMsgSistema(convId, texto, tipo) {
    const h = await lerHistorico(convId); h.push({ role: tipo === 'divisor' ? 'divisor' : 'assistant', content: texto, ts: Date.now(), sistema: true, enviarAoRp: false }); await salvarHistorico(convId, h);
    if (Esp.abertaId === convId) Esp.msgs = h;
}
async function conectarConversas(idA, idB) {
    const a = Esp.chats.find((c) => c.id === idA), b = Esp.chats.find((c) => c.id === idB); if (!a || !b || idA === idB) return;
    const ga = grupoDaConversa(idA), gb = grupoDaConversa(idB);
    if (ga && gb && ga !== gb) throw new Error('Uma das conversas já está conectada a outro grupo. Desconecte primeiro.');
    const g = ga || gb || (Mem.con.grupos[Mem.con.grupos.push({ id: newId('g'), chats: [] }) - 1]);
    [idA, idB].forEach((x) => { if (!g.chats.includes(x)) g.chats.push(x); }); await memSalvar('con');
    await adicionarMsgSistema(idA, 'Conectado a ' + b.titulo, 'divisor'); await adicionarMsgSistema(idB, 'Conectado a ' + a.titulo, 'divisor');
    await adicionarMsgSistema(idA, 'Conectado a “' + b.titulo.replace(/[.\s]+$/, '') + '”. Agora eu enxergo o que foi conversado lá e uso aqui, sem você copiar nada.');
    await memCarregarVizinhas(); sincronizarSoon(); refrescarUI();
}
async function desconectarConversa(id) {
    const g = grupoDaConversa(id); if (!g) return; const c = Esp.chats.find((x) => x.id === id);
    g.chats = g.chats.filter((x) => x !== id); if (g.chats.length < 2) Mem.con.grupos = Mem.con.grupos.filter((x) => x !== g); await memSalvar('con');
    await adicionarMsgSistema(id, 'Desconectado' + (g.chats.length ? '' : ''), 'divisor'); await memCarregarVizinhas(); sincronizarSoon(); refrescarUI();
}
// ---- enviar e responder ----
async function enviarMensagemEspaco(texto, anexos) {
    texto = String(texto || '').trim(); if (!texto && !(anexos && anexos.length)) return;
    if (!Esp.abertaId) await novaConversa(texto.slice(0, 40) || 'Novo chat');
    const conv = Esp.chats.find((c) => c.id === Esp.abertaId); const h = Esp.msgs.slice();
    const msg = { role: 'user', content: texto || '(arquivo)', ts: Date.now(), enviarAoRp: true, anexos: [] };
    h.push(msg); Esp.msgs = h;
    if (conv && (conv.titulo === 'Novo chat' || !conv.titulo)) conv.titulo = (texto || anexos[0].nome).slice(0, 40);
    conv.atualizadoEm = Date.now(); await salvarEspacoChats();
    for (const f of anexos || []) { // arquivo anexado: cai na pasta padrão e a análise começa (job visível); a mensagem vira a Explicação
        try {
            await bibCarregar(); const pasta = Bib.indice.pastas.find((p) => p.id === getConfig().ultimaPasta) || Bib.indice.pastas[0];
            const a = await criarArquivo({ nome: f.nome, texto: f.texto, pastaId: pasta.id, explicacao: texto || '' }); msg.anexos.push({ arquivoId: a.id, nome: f.nome });
            h.push({ role: 'assistant', content: 'Guardei “' + f.nome + '” na pasta ' + pasta.nome + ' e mandei analisar (acompanhe em Jobs). A nota só entra no prompt depois que você revisar.', ts: Date.now(), sistema: true, enviarAoRp: false });
            if (!(estimarTokens(f.texto) > getConfig().avisoArquivoTokens)) rodarAnalise(a);
            else h.push({ role: 'assistant', content: '“' + f.nome + '” é grande (~' + fmtNum(estimarTokens(f.texto)) + ' tokens). Abra o arquivo e confirme a análise.', ts: Date.now(), sistema: true, enviarAoRp: false });
        } catch (e) { h.push({ role: 'assistant', content: 'Não consegui guardar “' + f.nome + '”: ' + e.message, ts: Date.now(), sistema: true, enviarAoRp: false }); }
    }
    await salvarHistorico(conv.id, h); await espacoCarregarParaRp(); sincronizarVolateis(); sincronizarSoon(); refrescarUI(); // "✓ vale na próxima fala do RP" já é verdade aqui
    if (texto) relSugerirDoEspaco(texto).catch(relFalha); // 12.6: "passaram dois dias" dito aqui só PERGUNTA (nunca é automático)
    if (texto) await responderEspaco(conv);
}
function contextoDoEspaco() {
    const p = montarPrompt(); const cena = chatRealRecente(6, 500).map((m) => m.nome + ': ' + m.texto).join('\n');
    const g = Esp.abertaId && grupoDaConversa(Esp.abertaId); const vizinho = [];
    if (g) for (const cid of g.chats.filter((x) => x !== Esp.abertaId)) { const c = Esp.chats.find((x) => x.id === cid); if (c) vizinho.push(c); }
    return { notas: p.blocos.filter((b) => b.n <= 5 && b.texto).map((b) => b.texto).join('\n\n'), cena, vizinho };
}
async function responderEspaco(conv) {
    Esp.respondendo = true; refrescarUI();
    try {
        const cx = contextoDoEspaco(); let vizTxt = '';
        for (const v of cx.vizinho) { const hv = (await lerHistorico(v.id)).filter((m) => m.role !== 'divisor' && !m.sistema).slice(-12); vizTxt += '\n## CONVERSA CONECTADA: ' + v.titulo + '\n' + hv.map((m) => (m.role === 'user' ? 'Usuário' : 'IA') + ': ' + String(m.content).slice(0, 600)).join('\n'); }
        const sis = 'Você é a IA que interpreta ' + personagemAtual() + ' num RP, conversando agora com o autor NOS BASTIDORES. Aqui você não é a personagem: responda em português do Brasil, curto e direto. Os pedidos do autor aqui valem para a próxima fala dela no RP. Se pedirem algo que só um arquivo da Biblioteca resolve, diga isso. Você não tem ferramentas e não altera arquivos.\n\n## O QUE VOCÊ SABE\n' + (cx.notas || '(nada ainda)') + '\n\n## CENA ATUAL\n' + (cx.cena || '(sem cena)') + vizTxt;
        const hist = Esp.msgs.filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.sistema)).slice(-24).map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
        const resp = await generate([{ role: 'system', content: sis }].concat(hist), { maxTokens: 1500, temperature: 0.7, thinking: 'padrao', timeoutMs: 90000 });
        Esp.msgs = Esp.msgs.concat([{ role: 'assistant', content: resp, ts: Date.now(), enviarAoRp: false }]);
    } catch (e) { Esp.msgs = Esp.msgs.concat([{ role: 'assistant', content: 'Não consegui responder: ' + e.message, ts: Date.now(), sistema: true, erro: true, enviarAoRp: false }]); }
    finally { Esp.respondendo = false; await salvarHistorico(conv.id, Esp.msgs); refrescarUI(); }
}
async function alternarEnvioAoRp(convId, idx) {
    const h = await lerHistorico(convId); if (!h[idx]) return; h[idx].enviarAoRp = h[idx].enviarAoRp === false; await salvarHistorico(convId, h);
    if (Esp.abertaId === convId) Esp.msgs = h; await espacoCarregarParaRp(); sincronizarVolateis(); sincronizarSoon(); refrescarUI();
}
function espacoVerLimiarMemoria() { const novas = (ctx().chat || []).length - (Mem.rp.ultimoIdx || 0); const antes = Esp.sugestaoMemoria; Esp.sugestaoMemoria = novas >= 12; if (antes !== Esp.sugestaoMemoria) refrescarUI(); }

// ============================================================
// 13 INTERFACE — janela única (design das 4 imagens). Uma tela por vez; eventos delegados por data-a="ação".
// ============================================================
const UI = { raiz: null, fab: null, aberto: false, tela: 'espaco', lateral: false, arqId: null, pastaSel: 'todas', filtroTipo: 'todos', busca: '', buscaConv: '', buscandoConv: false, modoGrupo: false, selGrupo: new Set(), expSel: 0, abaArq: 'texto', rasc: {}, anexos: [], original: new Map(), verTudo: false, vozAlvo: {}, scroll: {}, ultTela: null };
const TELAS = { espaco: 'Espaço', pastas: 'Arquivos', lista: 'Artefatos', arquivo: 'Arquivo', descricao: 'Descrição', memoria: 'Memória', previa: 'Prévia do prompt', jobs: 'Jobs', config: 'Configurações', inicio: 'Início' };
function iconeDoc(tipo) {
    const g = { tom: 'M12 25v4M16 21v12M20 24v6M24 22v10', lore: 'M10 22c3-1.4 5-1.4 8 0v10c-3-1.4-5-1.4-8 0zM18 22c3-1.4 5-1.4 8 0v10c-3-1.4-5-1.4-8 0z', regra: 'M11 24l1.8 1.8L16 22.5M19 24h7M11 31l1.8 1.8L16 29.5M19 31h7' }[tipo] || 'M11 24h14M11 28h14M11 32h9';
    return '<svg class="spd-doc" viewBox="0 0 36 42" fill="none"><path d="M6 2h16l10 10v26a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3z" fill="#fafafc"/><path d="M22 2v7a3 3 0 0 0 3 3h7" stroke="#d3d3da" stroke-width="1.5"/><path d="' + g + '" stroke="#52525d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
const pastaIcone = (cor) => '<svg width="56" height="44" viewBox="0 0 56 44" aria-hidden="true"><rect x="0" y="0" width="24" height="16" rx="5" fill="' + cor + '" opacity=".78"/><rect x="0" y="7" width="56" height="37" rx="7" fill="' + cor + '"/></svg>';
const pilulaTipo = (id) => { const t = tipoInfo(id); return '<span class="spd-ptipo" style="color:' + t.cor + '"><i></i><span style="color:#b6b6c2">' + esc(t.nome) + '</span></span>'; };
function mdLite(t) { // só o suficiente pra respostas da IA: parágrafos, listas numeradas/com marcador e **negrito**
    const inline = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const blocos = String(t || '').split(/\n{2,}/); return blocos.map((b) => { const ls = b.split('\n'); const num = ls.every((l) => /^\s*\d+[.)]\s+/.test(l)); const bul = ls.every((l) => /^\s*[-*•]\s+/.test(l));
        if (num) return '<ol>' + ls.map((l, i) => '<li><span class="n">' + (i + 1) + '</span><span>' + inline(l.replace(/^\s*\d+[.)]\s+/, '')) + '</span></li>').join('') + '</ol>';
        if (bul) return '<ul>' + ls.map((l) => '<li><span class="n">•</span><span>' + inline(l.replace(/^\s*[-*•]\s+/, '')) + '</span></li>').join('') + '</ul>'; return '<p>' + ls.map(inline).join('<br>') + '</p>'; }).join('');
}
function toast(msg, erro) {
    const j = UI.raiz && UI.raiz.querySelector('.spd-janela'); if (!j) { console.log('[Spade]', msg); return; }
    let box = j.querySelector('.spd-toasts'); if (!box) { box = document.createElement('div'); box.className = 'spd-toasts'; j.appendChild(box); }
    const el = document.createElement('div'); el.className = 'spd-toast' + (erro ? ' err' : ''); el.textContent = msg; box.appendChild(el); setTimeout(() => el.remove(), erro ? 7000 : 3200);
}
const falhou = (e) => { console.warn('[Spade]', e); toast(e && e.message ? e.message : String(e), true); };
function perguntar(texto, botoes) { // modal simples (nada de alert/confirm do navegador)
    return new Promise((resolve) => {
        const j = UI.raiz.querySelector('.spd-janela'); const m = document.createElement('div'); m.className = 'spd-modal';
        m.innerHTML = '<div><p>' + esc(texto) + '</p><div class="bt">' + botoes.map((b, i) => '<button class="spd-btn ' + (b.cls || '') + '" data-i="' + i + '">' + esc(b.rotulo) + '</button>').join('') + '</div></div>';
        m.addEventListener('click', (e) => { const bt = e.target.closest('button[data-i]'); if (bt) { m.remove(); resolve(botoes[+bt.dataset.i].valor); } else if (e.target === m) { m.remove(); resolve(null); } }); j.appendChild(m);
    });
}
function modalForm(titulo, html, aoSalvar, extra) {
    const j = UI.raiz.querySelector('.spd-janela'); const m = document.createElement('div'); m.className = 'spd-modal';
    m.innerHTML = '<div><p style="font-weight:600;font-size:17px;color:#fff">' + esc(titulo) + '</p>' + html + '<div class="bt" style="margin-top:16px">' + (extra ? '<button class="spd-btn perigo" data-x="1" style="margin-right:auto">' + esc(extra.rotulo) + '</button>' : '') + '<button class="spd-btn" data-x="c">Cancelar</button><button class="spd-btn prim" data-x="s">Salvar</button></div></div>';
    m.addEventListener('click', async (e) => { const b = e.target.closest('[data-x]'); if (!b && e.target !== m) { const sw = e.target.closest('[data-cor]'); if (sw) { m.querySelectorAll('[data-cor]').forEach((x) => (x.style.outline = '')); sw.style.outline = '2px solid #fff'; m.dataset.cor = sw.dataset.cor; } return; }
        if (!b || b.dataset.x === 'c' || e.target === m) { m.remove(); return; }
        try { if (b.dataset.x === 's') await aoSalvar(m); else if (b.dataset.x === '1') await extra.fn(); m.remove(); } catch (er) { falhou(er); } }); j.appendChild(m); const i = m.querySelector('input'); if (i) i.focus();
}
const swatches = (atual) => '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">' + CORES_PASTA.map((c) => '<button data-cor="' + c + '" style="width:30px;height:30px;border-radius:9px;border:0;background:' + c + ';cursor:pointer;' + (c === atual ? 'outline:2px solid #fff' : '') + '"></button>').join('') + '</div>';

// ---- shell ----
function barraAviso() {
    let h = '';
    if (Plug.ok === false) h += '<div class="spd-faixa">Sem o plugin spade-fs: o que você salvar fica só neste navegador (reserva). Instale/reinicie o plugin e recarregue. ' + esc(Plug.erro || '') + '</div>';
    (Plug.alertas || []).forEach((a) => { h += '<div class="spd-faixa">' + esc(a.mensagem) + ' (' + esc(a.caminho) + ')</div>'; });
    return h;
}
function lateralHtml() {
    const nav = (t, ic_, rot, extra) => '<button class="spd-nav ' + (UI.tela === t || (t === 'pastas' && (UI.tela === 'lista' || UI.tela === 'arquivo')) ? 'on' : '') + '" data-a="nav" data-t="' + t + '">' + ic(ic_, 19) + '<span>' + rot + '</span>' + (extra || '') + '</button>';
    const ativos = jobsAtivos().length; const convs = (Esp.chats || []).slice().sort((a, b) => b.atualizadoEm - a.atualizadoEm).filter((c) => !UI.buscaConv || semAcento(c.titulo).toLowerCase().includes(semAcento(UI.buscaConv).toLowerCase()));
    const atual = Esp.abertaId; const grupoAtual = atual && grupoDaConversa(atual);
    return '<aside class="spd-lateral"><div class="spd-lat-topo"><button class="spd-voltar" data-a="nav" data-t="inicio" title="Início" style="font-size:19px;color:#dcdee1">♠</button><button class="spd-voltar" data-a="fechar" title="Fechar" style="color:#9a9da4">' + ic('panel', 20) + '</button></div>' +
        '<button class="spd-nav dest" data-a="novo-chat">' + ic('plus', 19) + '<span>Novo chat</span></button>' +
        (UI.buscandoConv ? '<div style="padding:6px 4px"><input class="spd-in" data-campo="buscaConv" placeholder="Buscar conversas" value="' + esc(UI.buscaConv) + '"></div>' : '<button class="spd-nav" data-a="buscar-conv">' + ic('search', 19) + '<span>Buscar</span></button>') +
        nav('pastas', 'book', 'Biblioteca') + nav('descricao', 'user', 'Descrição') + nav('memoria', 'layers', 'Memória') + nav('previa', 'eye', 'Prévia') + nav('jobs', 'list', 'Jobs', ativos ? '<span class="b">' + ativos + '</span>' : '') +
        '<div class="spd-sep"></div><div class="spd-rot">Recentes</div><div class="spd-lista">' +
        (convs.length ? convs.map((c) => { const g = grupoDaConversa(c.id); return '<div class="spd-conv ' + (c.id === atual && UI.tela === 'espaco' ? 'on' : '') + '" data-a="conv" data-id="' + c.id + '">' + ic('chat', 19) + '<span class="t">' + esc(c.titulo) + '</span><button class="spd-caixa ' + (g ? 'lig' : '') + '" data-a="caixa" data-id="' + c.id + '" title="' + (g ? 'Conectada — tocar desconecta' : 'Conectar com a conversa aberta') + '"></button></div>'; }).join('') : '<div class="spd-vazio" style="padding:20px 10px;font-size:13.5px">Nenhuma conversa ainda.</div>') +
        '</div><div class="spd-lat-pe"><button class="spd-nav ' + (UI.tela === 'config' ? 'on' : '') + '" data-a="nav" data-t="config">' + ic('sliders', 19) + '<span>Configurações</span></button></div></aside>';
}
function topoHtml(t) {
    const voltar = t.voltar ? '<button class="spd-voltar" data-a="voltar" data-t="' + t.voltar + '">' + ic('back', 22) + '</button>' : '';
    return '<div class="spd-topo"><button class="spd-menu" data-a="lateral">' + ic('menu', 22) + '</button>' + voltar + (t.icone || '') + '<h2>' + esc(t.titulo) + '</h2><span class="esp"></span>' + (t.direita || '') + '</div>';
}
function htmlJanela() {
    const tela = renderTela(); UI.ultTela = UI.tela + (UI.arqId || '');
    return '<div class="spd-janela ' + (UI.lateral ? 'lat' : '') + '">' + lateralHtml() + '<div class="spd-lat-veu" data-a="lateral"></div><main class="spd-principal">' + barraAviso() + topoHtml(tela) + '<div class="spd-corpo ' + (tela.cls || '') + '" data-sc="corpo">' + tela.corpo + '</div></main></div>';
}
let _rend = 0;
function render() {
    if (!UI.raiz || !UI.aberto) return;
    const ativo = document.activeElement; const campo = ativo && ativo.dataset && ativo.dataset.campo; const sel = campo && ativo.selectionStart != null ? [ativo.selectionStart, ativo.selectionEnd] : null;
    const salvarScroll = () => { UI.raiz.querySelectorAll('[data-sc]').forEach((e) => { UI.scroll[e.dataset.sc] = e.scrollTop; }); };
    salvarScroll(); const mesma = UI.ultTela === UI.tela + (UI.arqId || ''); const msgsDoFim = (() => { const m = UI.raiz.querySelector('.spd-msgs'); return !m || m.scrollHeight - m.scrollTop - m.clientHeight < 80; })();
    UI.raiz.innerHTML = htmlJanela();
    UI.raiz.querySelectorAll('[data-sc]').forEach((e) => { if (mesma && UI.scroll[e.dataset.sc] != null) e.scrollTop = UI.scroll[e.dataset.sc]; });
    const m = UI.raiz.querySelector('.spd-msgs'); if (m && (msgsDoFim || !mesma)) m.scrollTop = m.scrollHeight;
    if (campo) { const n = UI.raiz.querySelector('[data-campo="' + campo + '"]'); if (n) { n.focus(); if (sel && n.setSelectionRange) try { n.setSelectionRange(sel[0], sel[1]); } catch (_) { /* tipo sem seleção */ } } }
    desenharFiosVerdes(); autoAltura();
}
function desenharFiosVerdes() {
    const lista = UI.raiz.querySelector('.spd-lista'); if (!lista) return; const base = lista.getBoundingClientRect();
    for (const g of Mem.con.grupos) {
        const caixas = g.chats.map((id) => lista.querySelector('.spd-caixa[data-id="' + id + '"]')).filter(Boolean).map((c) => c.getBoundingClientRect()); if (caixas.length < 2) continue;
        const ys = caixas.map((r) => r.top + r.height / 2 - base.top + lista.scrollTop); const x = caixas[0].left + caixas[0].width / 2 - base.left - 1;
        const f = document.createElement('div'); f.className = 'spd-fioverde'; f.style.cssText = 'left:' + x + 'px;top:' + Math.min(...ys) + 'px;height:' + (Math.max(...ys) - Math.min(...ys)) + 'px'; lista.appendChild(f);
    }
}
function autoAltura() { const t = UI.raiz.querySelector('.spd-comp textarea'); if (t) { t.style.height = 'auto'; t.style.height = Math.min(160, t.scrollHeight) + 'px'; } }
let _agenda = null;
function refrescarUI() {
    atualizarFab(); if (!UI.raiz || !UI.aberto) return;
    const a = document.activeElement; if (a && UI.raiz.contains(a) && a.dataset && a.dataset.campo && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) { clearTimeout(_agenda); _agenda = setTimeout(refrescarUI, 900); return; } // não derruba o que você está digitando
    clearTimeout(_agenda); _agenda = setTimeout(render, 30);
}
avisarUI = refrescarUI;
function atualizarFab() { if (!UI.fab) return; const n = jobsAtivos().length; UI.fab.innerHTML = '♠' + (n ? '<span class="n">' + n + '</span>' : ''); }
function abrir(tela, extra) {
    UI.aberto = true; if (tela) UI.tela = tela; if (extra) Object.assign(UI, extra); UI.raiz.classList.add('aberto'); UI.lateral = false;
    Promise.all([bibCarregar(), descCarregar(), memCarregar(), obterEspacoChats()]).then(async () => { if (UI.tela === 'espaco' && !Esp.abertaId) { const c = (Esp.chats || []).filter((x) => x.stChatId === stChatIdAtual()).sort((a, b) => b.atualizadoEm - a.atualizadoEm)[0]; if (c) await espacoAbrir(c.id); } await espacoCarregarParaRp(); render(); }).catch(falhou); render();
}
function fechar() { UI.aberto = false; UI.raiz.classList.remove('aberto'); }
function irPara(tela, extra) { UI.tela = tela; Object.assign(UI, extra || {}); UI.lateral = false; render(); }

// ---- tela: Espaço (imagem 4) ----
function msgHtml(m, i, conv) {
    if (m.role === 'divisor') return '<div class="spd-divisor"><span>' + ic('link', 14) + esc(m.content) + '</span></div>';
    if (m.role === 'user') {
        const ligado = conv && conv.stChatId && conv.stChatId === stChatIdAtual(); const vai = ligado && msgVaiPraRp(conv.id, i);
        let nota = ''; if (getConfig().espacoParaRp && ligado && m.enviarAoRp !== false && !vai) nota = '<button class="spd-vale off" data-a="vale" data-i="' + i + '" title="Tocar para não enviar ao RP">já passou do limite de ' + getConfig().espacoMaxMensagens + ' mensagens</button>';
        else if (ligado && getConfig().espacoParaRp) nota = vai ? '<button class="spd-vale" data-a="vale" data-i="' + i + '" title="Tocar para NÃO enviar este pedido ao RP">' + ic('check', 13) + 'vale na próxima fala do RP</button>' : '<button class="spd-vale off" data-a="vale" data-i="' + i + '">não enviado ao RP — tocar para enviar</button>';
        else if (!ligado) nota = '<span class="spd-vale off" style="cursor:default">esta conversa é de outro chat do RP</span>';
        else nota = '<span class="spd-vale off" style="cursor:default">envio ao RP desligado nas configurações</span>';
        return '<div class="spd-user">' + esc(m.content) + (m.anexos && m.anexos.length ? '<div class="spd-anexos" style="margin-top:8px;padding:0">' + m.anexos.map((a) => '<span class="spd-anexo">' + ic('doc', 14) + esc(a.nome) + '</span>').join('') + '</div>' : '') + '</div>' + nota;
    }
    return '<div class="spd-ia ' + (m.erro ? 'erro' : '') + '">' + mdLite(m.content) + '</div>';
}
function telaEspaco() {
    const conv = (Esp.chats || []).find((c) => c.id === Esp.abertaId); const g = conv && grupoDaConversa(conv.id);
    const vizinhos = g ? g.chats.filter((x) => x !== conv.id).map((id) => (Esp.chats.find((c) => c.id === id) || {}).titulo).filter(Boolean) : [];
    const mensagens = Esp.msgs.map((m, i) => msgHtml(m, i, conv)).join('');
    const fala = Esp.sugestaoMemoria ? '<button class="spd-chip" data-a="job-memoria">' + ic('layers', 15) + 'Atualizar memória do RP</button>' : ''; const antigos = Esp.paraRp.filter((m) => m.enviar).length - getConfig().espacoMaxMensagens;
    const consolida = antigos >= 2 && conv ? '<button class="spd-chip" data-a="job-espaco">' + ic('list', 15) + 'Consolidar ' + antigos + ' pedidos antigos</button>' : '';
    const anexos = UI.anexos.length ? '<div class="spd-anexos" style="max-width:760px;margin:0 auto 8px;width:calc(100% - 44px)">' + UI.anexos.map((a, i) => '<span class="spd-anexo">' + ic('doc', 14) + esc(a.nome) + '<button data-a="rm-anexo" data-i="' + i + '">' + ic('x', 14) + '</button></span>').join('') + '</div>' : '';
    const vazio = !Esp.msgs.length ? '<div class="spd-vazio" style="margin:auto">Converse com a IA nos bastidores.<br>O que você pedir aqui vale na próxima fala do RP.</div>' : '';
    const corpo = '<div class="spd-chat"><div class="spd-msgs" data-sc="msgs">' + vazio + '<div class="spd-msgs-in">' + mensagens + (Esp.respondendo ? '<div class="spd-ia spd-pensando">pensando</div>' : '') + '</div></div>' + ((fala || consolida) ? '<div class="spd-chips">' + fala + consolida + '</div>' : '') + anexos +
        '<div class="spd-comp"><button class="spd-mais" data-a="anexar" title="Anexar arquivo">' + ic('plus', 20) + '</button><textarea rows="1" data-campo="composer" placeholder="Digite sua mensagem…">' + esc(UI.rasc.composer || '') + '</textarea><button class="spd-env" data-a="enviar" ' + (Esp.respondendo ? 'disabled' : '') + '>' + ic('up', 20) + '</button></div><input type="file" id="spd-file" multiple style="display:none" accept=".txt,.md,.markdown,.json,.csv,.tsv,.yaml,.yml,.log"></div>';
    return { titulo: conv ? conv.titulo : 'Novo chat', corpo, cls: 'sem-rolagem', direita: (vizinhos.length ? '<span class="spd-pillcon">' + ic('link', 15) + 'Conectado a ' + esc(vizinhos.join(', ')) + '</span>' : '') + (conv ? '<button class="spd-voltar" data-a="renomear-conv" title="Renomear">' + ic('pen', 18) + '</button><button class="spd-voltar" data-a="apagar-conv" title="Apagar conversa">' + ic('trash', 18) + '</button>' : '') };
}

// ---- tela: Biblioteca — pastas (imagem 5, tema cinza próprio) ----
const totalPorTipo = (t) => listaArquivos().filter((a) => a.meta.tipo === t).length;
function telaPastas() {
    const pastas = Bib.indice.pastas.slice().sort((a, b) => a.ordem - b.ordem); const total = listaArquivos().length;
    const recente = (pid) => Math.max(0, ...listaArquivos().filter((a) => a.meta.pastaId === pid).map((a) => a.meta.editadoEm || a.meta.enviadoEm || 0));
    const ordenadas = pastas.slice().sort((a, b) => recente(b.id) - recente(a.id) || a.ordem - b.ordem);
    const lat = '<div class="spd-pl"><div class="spd-pl-i on" data-a="ir-lista" data-p="todas" data-tp="todos"><i></i>Recentes</div>' + tiposTodos().map((t) => '<div class="spd-pl-i" data-a="ir-lista" data-p="todas" data-tp="' + t.id + '"><i></i>' + esc(t.nome[0].toUpperCase() + t.nome.slice(1)) + '</div>').join('') + '<div class="spd-pl-i" data-a="ir-lista" data-p="todas" data-tp="todos"><i></i>Todos</div></div>';
    const grade = ordenadas.map((p) => '<div class="spd-pasta" data-a="ir-lista" data-p="' + p.id + '" data-tp="todos">' + pastaIcone(p.cor) + '<div><div class="nome">' + esc(p.nome) + '</div><div class="qtd">' + listaArquivos().filter((a) => a.meta.pastaId === p.id).length + ' itens</div></div><button class="spd-voltar" data-a="editar-pasta" data-id="' + p.id + '" style="position:absolute;top:10px;right:10px;color:#a8a8b4" title="Editar pasta">' + ic('pen', 16) + '</button></div>').join('') + '<div class="spd-pasta nova" data-a="nova-pasta">' + ic('plus', 26) + '<span style="font-size:16px">Nova pasta</span></div>';
    return { titulo: 'Arquivos', corpo: '<div class="spd-pastas">' + lat + '<div class="spd-pp"><div class="spd-grade-p" data-sc="grade">' + grade + '</div><div class="spd-pe"><span>' + pastas.length + (pastas.length === 1 ? ' pasta' : ' pastas') + '</span><span>' + total + (total === 1 ? ' arquivo' : ' arquivos') + '</span></div></div></div>', cls: 'sem-rolagem' };
}
// ---- tela: Artefatos (imagem 3) ----
function cardHtml(a) {
    const est = estadoEfetivo(a); const rotEst = { novo: 'sem nota — analise', analisando: 'analisando…', pronto: a.nota && a.nota.revisada === false ? 'revise a nota' : '', desatualizado: 'desatualizado', erro: 'erro' }[est];
    const prev = a.nota ? (a.nota.minima || a.nota.completa || '').replace(/\s+/g, ' ') : 'Ainda sem nota. Abra o arquivo, explique o que ele é e mande analisar.'; const g = a.meta.grupoId && Bib.indice.grupos.find((x) => x.id === a.meta.grupoId);
    return '<div class="spd-card ' + (UI.selGrupo.has(a.id) ? 'sel' : '') + '" data-a="abrir-arq" data-id="' + a.id + '"><div class="spd-card-top">' + iconeDoc(a.meta.tipo) + pilulaTipo(a.meta.tipo) + '</div><h3>' + esc(a.meta.titulo || a.meta.nome.replace(/\.[a-z0-9]+$/i, '')) + '</h3><div class="meta">' + (est === 'novo' ? 'enviado ' : 'atualizado ') + fmtRel(a.meta.editadoEm || a.meta.enviadoEm) + (g ? ' · grupo ' + esc(g.nome) : '') + (a.meta.ativo ? '' : ' · desligado') + '</div><div class="prev">' + esc(prev.slice(0, 260)) + '</div><div class="sempre">' + (a.meta.sempreAtivo ? ic('spark', 20) + 'sempre incluir' : '') + (rotEst ? '<span class="est ' + (est === 'erro' ? 'err' : est === 'pronto' ? 'ok' : '') + '">' + rotEst + '</span>' : '') + '</div></div>';
}
function telaLista() {
    const todos = listaArquivos().filter((a) => UI.pastaSel === 'todas' || a.meta.pastaId === UI.pastaSel); const q = semAcento(UI.busca).toLowerCase();
    const vis = todos.filter((a) => (UI.filtroTipo === 'todos' || a.meta.tipo === UI.filtroTipo) && (!q || semAcento((a.meta.titulo || '') + ' ' + a.meta.nome + ' ' + (a.nota ? a.nota.completa : '')).toLowerCase().includes(q))).sort((x, y) => (y.meta.editadoEm || y.meta.enviadoEm || 0) - (x.meta.editadoEm || x.meta.enviadoEm || 0));
    const tipos = tiposTodos().filter((t) => t.base || todos.some((a) => a.meta.tipo === t.id));
    const tabs = '<button class="spd-tab ' + (UI.filtroTipo === 'todos' ? 'on' : '') + '" data-a="filtro" data-t="todos">Todos<b>' + todos.length + '</b></button>' + tipos.map((t) => '<button class="spd-tab ' + (UI.filtroTipo === t.id ? 'on' : '') + '" data-a="filtro" data-t="' + t.id + '">' + esc(t.id === 'regra' ? 'Regras' : t.id === 'documento' ? 'Documentos' : t.nome[0].toUpperCase() + t.nome.slice(1)) + '<b>' + todos.filter((a) => a.meta.tipo === t.id).length + '</b></button>').join('');
    const pasta = pastaInfo(UI.pastaSel);
    const grupos = Bib.indice.grupos.length ? '<h3 style="color:#f0f1f3;font-size:17px;margin:34px 0 14px">Grupos</h3>' + Bib.indice.grupos.map((g) => '<div class="spd-job" data-a="editar-grupo" data-id="' + g.id + '" style="cursor:pointer"><div class="l"><span class="n">' + ic('link', 16) + ' ' + esc(g.nome) + '</span><span class="st">' + g.arquivoIds.length + ' arquivos · ' + (g.nota ? (g.nota.revisada === false ? 'revise a nota' : 'nota do grupo') : 'sem nota própria') + '</span></div></div>').join('') : '';
    const barraGrupo = UI.modoGrupo ? '<div class="spd-aviso bom" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span style="flex:1">Escolha 2 ou mais arquivos para ligar num grupo (' + UI.selGrupo.size + ' escolhidos). A nota do grupo substitui as notas dos membros no prompt.</span><button class="spd-btn pq" data-a="criar-grupo" ' + (UI.selGrupo.size < 2 ? 'disabled' : '') + '>Criar grupo</button><button class="spd-btn pq" data-a="cancelar-grupo">Cancelar</button></div>' : '';
    const corpo = '<div class="spd-art"><div class="spd-art-topo"><label class="spd-busca">' + ic('search', 20) + '<input data-campo="busca" placeholder="Buscar artefatos" value="' + esc(UI.busca) + '"></label><div class="spd-tabs">' + tabs + '</div><span class="spd-cont">' + vis.length + ' artefatos</span></div>' + barraGrupo + (vis.length ? '<div class="spd-cards">' + vis.map(cardHtml).join('') + '</div>' : '<div class="spd-vazio">Nenhum arquivo aqui ainda.<br>Toque em “Adicionar arquivo” ou anexe um arquivo no Espaço.</div>') + grupos + '<input type="file" id="spd-file-bib" multiple style="display:none" accept=".txt,.md,.markdown,.json,.csv,.tsv,.yaml,.yml,.log"></div>';
    return { titulo: 'Artefatos' + (pasta ? ' · ' + pasta.nome : ''), voltar: 'pastas', corpo, direita: '<button class="spd-btn pq" data-a="modo-grupo">' + ic('link', 15) + 'Agrupar</button><button class="spd-btn pq prim" data-a="adicionar-arq">' + ic('plus', 15) + 'Adicionar arquivo</button>' };
}
// ---- tela: Arquivo (imagem 2) ----
const rotuloEstado = { novo: 'sem nota ainda', analisando: 'analisando…', pronto: 'pronto', desatualizado: 'desatualizado — reanalise quando quiser', erro: 'erro' };
function secaoNota(a) {
    const est = estadoEfetivo(a); const n = a.nota; const pend = n && n.revisada === false;
    let h = '<div class="spd-secao"><button class="spd-icbtn" data-a="analisar" data-id="' + a.id + '" title="' + (n ? 'Reanalisar' : 'Analisar com IA') + '">' + ic(n ? 'refresh' : 'spark', 24) + '</button><div><h4>Nota para a IA</h4><div class="sub">A IA lê só a nota, nunca o arquivo · ' + rotuloEstado[est] + '</div>';
    if (a.meta.erro && est === 'erro') h += '<div class="spd-aviso ruim">' + esc(a.meta.erro) + '</div>';
    if (n) {
        if (pend) h += '<div class="spd-aviso">A nota ainda NÃO está no prompt. Leia, ajuste se quiser e toque em “Aceitar nota”.</div>';
        (n.avisos || []).forEach((v) => (h += '<div class="spd-aviso">' + esc(v) + '</div>'));
        if (n.proposta) h += '<div class="spd-aviso bom"><b>Nova análise pronta</b> (a nota atual foi editada por você, então não troquei nada).<div class="acoes" style="display:flex;gap:8px;margin-top:10px"><button class="spd-btn pq" data-a="proposta-usar" data-id="' + a.id + '">Usar a nova</button><button class="spd-btn pq" data-a="proposta-descartar" data-id="' + a.id + '">Descartar</button></div><div style="margin-top:8px;white-space:pre-wrap;color:#cfe9d8">' + esc(n.proposta.completa) + '</div></div>';
        h += '<div class="spd-campo"><label>Nota completa · ' + estimarTokens(n.completa) + ' tokens</label><textarea class="spd-ta" data-campo="nota.completa" style="min-height:150px">' + esc(UI.rasc['nota.completa'] ?? n.completa) + '</textarea></div><div class="spd-campo"><label>Nota mínima · ' + estimarTokens(n.minima) + ' tokens' + (n.minima ? '' : ' — sem mínima, entra só o título') + '</label><textarea class="spd-ta peq" data-campo="nota.minima">' + esc(UI.rasc['nota.minima'] ?? n.minima) + '</textarea></div><div class="acoes">' + (!n.minima ? '<button class="spd-btn" data-a="gerar-minima" data-id="' + a.id + '">Gerar mínima com IA</button>' : '') + (pend ? '<button class="spd-btn ciano" data-a="aceitar-nota" data-id="' + a.id + '">Aceitar nota</button>' : '') + '<button class="spd-btn" data-a="salvar-nota" data-id="' + a.id + '">Salvar</button></div>';
    } else h += '<div class="acoes" style="justify-content:flex-start"><button class="spd-btn ciano" data-a="analisar" data-id="' + a.id + '">Analisar com IA</button></div>';
    return h + '</div></div>';
}
function secaoEstilo(a) {
    const e = a.nota && a.nota.estilo; if (!e) return entraNoEstilo(a) ? '<div class="spd-aviso">Este arquivo entra no estilo guiado. Analise-o para medir o jeito de falar e escolher exemplos.</div>' : '';
    const f = e.bandas && e.bandas.fala; const linha = (k, rot, max) => { if (!f || !f[k]) return ''; const b = f[k]; const esc_ = max || 100; return '<div class="spd-medida"><span>' + rot + '</span><div class="spd-banda"><i style="left:' + Math.min(100, (b.min / esc_) * 100) + '%;width:' + Math.max(2, Math.min(100, ((b.max - b.min) / esc_) * 100)) + '%"></i><b style="left:' + Math.min(100, (b.alvo / esc_) * 100) + '%"></b></div><span>' + b.alvo + ' (' + b.min + '–' + b.max + ')</span></div>'; };
    const falantes = Object.keys(e.falantes || {}); const vozes = falantes.length > 1 ? '<div class="spd-campo"><label>Voz alvo (o arquivo tem vários falantes)</label><select class="spd-sel" data-a="voz" data-id="' + a.id + '"><option value="todas">todas</option>' + falantes.map((x) => '<option ' + (e.vozAlvo === x ? 'selected' : '') + '>' + esc(x) + '</option>').join('') + '</select></div>' : '';
    return '<div class="spd-secao"><div class="spd-icbtn">' + ic('wave', 24) + '</div><div><h4>Estilo medido</h4><div class="sub">Números tirados do texto por código — a IA só ajudou a escolher exemplos.</div>' + (e.avisos || []).map((v) => '<div class="spd-aviso">' + esc(v) + '</div>').join('') + (e.principios.length ? '<div style="margin:0 0 12px">' + linhasCurtas(e.principios.join('\n')).map((l) => '<div style="color:#d5dbe8;font-size:14px;margin:4px 0">' + esc(l) + '</div>').join('') + '</div>' : '') + vozes +
        (f ? (f.confiavel ? '' : '<div class="spd-aviso">Poucas falas medidas (' + f.n + '): estas medidas não são usadas na conferência.</div>') + linha('palavrasPorFala', 'palavras por fala', Math.max(40, f.palavrasPorFala.max * 1.2)) + linha('pctPergunta', 'terminam em ?') + linha('pctReticencias', 'reticências') + linha('pctExclamacao', 'exclamação') + linha('pctInicioMinuscula', 'início minúsculo') + linha('pctSemPontoFinal', 'sem ponto final') : '<div class="spd-aviso">Nenhuma fala foi medida neste arquivo.</div>') +
        '<h4 style="font-size:15px;margin:18px 0 4px">Exemplos (' + e.exemplos.length + ')</h4><div class="sub" style="margin-bottom:6px">⭐ aparece mais · 🚫 nunca aparece. O texto é cópia literal do arquivo.</div>' + e.exemplos.map((x) => '<div class="spd-ex ' + (x.bloqueado ? 'blq' : '') + '"><div class="tx">“' + esc(x.texto) + '”<small>' + x.canal + ' · ' + x.palavras + ' palavras' + (x.situacao ? ' · ' + esc(x.situacao) : '') + (x.revisar ? ' · conferir nome próprio' : '') + '</small></div><button class="' + (x.favorito ? 'on' : '') + '" data-a="ex-fav" data-id="' + a.id + '" data-x="' + x.id + '" title="Favoritar">' + ic('star', 18) + '</button><button data-a="ex-blq" data-id="' + a.id + '" data-x="' + x.id + '" title="Bloquear">' + ic('ban', 18) + '</button></div>').join('') + '</div></div>';
}
function telaArquivo() {
    const a = Bib.arquivos.get(UI.arqId); if (!a) return { titulo: 'Arquivo', voltar: 'lista', corpo: '<div class="spd-vazio">Arquivo não encontrado.</div>' };
    const t = tipoInfo(a.meta.tipo); const titulo = a.meta.titulo || a.meta.nome.replace(/\.[a-z0-9]+$/i, ''); const orig = UI.original.get(a.id);
    if (orig === undefined) { UI.original.set(a.id, null); textoOriginalDe(a).then((x) => { UI.original.set(a.id, x); refrescarUI(); }).catch((e) => { UI.original.set(a.id, '(não consegui ler o original: ' + e.message + ')'); refrescarUI(); }); }
    const MAXV = 60000; const texto = orig == null ? 'Carregando…' : (UI.verTudo || orig.length <= MAXV ? orig : orig.slice(0, MAXV) + '\n\n… (' + (orig.length - MAXV) + ' caracteres a mais)');
    const exps = a.meta.explicacoes; const sel = Math.min(UI.expSel, Math.max(0, exps.length - 1)); const cadeia = '<div class="spd-cadeia"><button class="spd-icbtn" data-a="exp-add" title="Nova explicação">' + ic('plus', 26) + '</button>' + exps.map((e, i) => '<div class="spd-fio"></div><button class="spd-no ' + (i === sel ? 'sel' : '') + '" data-a="exp-sel" data-i="' + i + '" title="Explicação ' + (i + 1) + '"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/></svg></button>').join('') + '</div>';
    const eVal = exps[sel] ? (UI.rasc['exp.' + sel] ?? exps[sel].texto) : '';
    const painel = '<div class="spd-painel" data-sc="painel"><div class="spd-secao">' + cadeia + '<div><h4>Explicação</h4><div class="sub">Como a IA deve usar estas informações</div>' + (exps.length ? '<textarea class="spd-ta" data-campo="exp.' + sel + '" placeholder="Escreva aqui como esta informação deve ser interpretada e utilizada pela IA...">' + esc(eVal) + '</textarea><div class="acoes"><button class="spd-btn pq perigo" data-a="exp-del">Remover esta</button><button class="spd-btn" data-a="exp-salvar">Salvar</button></div>' : '<div class="spd-vazio" style="padding:20px 0;text-align:left">Toque em + para escrever a primeira explicação. Pode ter várias: a IA lê todas, na ordem.</div>') + '</div></div>' +
        '<div class="spd-secao"><button class="spd-icbtn" data-a="obs-olho" title="' + (a.meta.observacaoVisivelParaIA ? 'A IA vê esta observação' : 'A IA NÃO vê esta observação') + '">' + ic(a.meta.observacaoVisivelParaIA ? 'eye' : 'eyeoff', 26) + '</button><div><h4>Observação</h4><div class="sub">Notas adicionais sobre o conteúdo' + (a.meta.observacaoVisivelParaIA ? '' : ' · a IA não vê') + '</div><textarea class="spd-ta" data-campo="obs" placeholder="Adicione observações, alertas ou informações importantes...">' + esc(UI.rasc.obs ?? a.meta.observacao) + '</textarea><div class="acoes"><button class="spd-btn" data-a="obs-salvar">Salvar</button></div></div></div>' +
        secaoNota(a) + secaoEstilo(a) +
        '<div class="spd-secao"><div class="spd-icbtn">' + ic('sliders', 22) + '</div><div><h4>Uso no prompt</h4><div class="sub">Como este arquivo entra na conversa</div>' +
        '<div class="spd-bar-sw"><span>Ligado<small>desligar não apaga nada</small></span><button class="spd-sw ' + (a.meta.ativo ? 'on' : '') + '" data-a="tg" data-k="ativo" data-id="' + a.id + '"></button></div><div class="spd-bar-sw"><span>Sempre incluir<small>é a última nota a sair se faltar espaço</small></span><button class="spd-sw ' + (a.meta.sempreAtivo ? 'on' : '') + '" data-a="tg" data-k="sempreAtivo" data-id="' + a.id + '"></button></div>' + (a.meta.tipo !== 'tom' ? '<div class="spd-bar-sw"><span>Usar como estilo<small>mede o jeito de falar deste arquivo</small></span><button class="spd-sw ' + (a.meta.usarComoEstilo ? 'on' : '') + '" data-a="tg" data-k="usarComoEstilo" data-id="' + a.id + '"></button></div>' : '') +
        '<div class="spd-grid2" style="margin-top:14px"><div class="spd-campo"><label>Prioridade</label><select class="spd-sel" data-a="sel" data-k="prioridade" data-id="' + a.id + '">' + ['alta', 'media', 'baixa'].map((p) => '<option value="' + p + '" ' + (a.meta.prioridade === p ? 'selected' : '') + '>' + { alta: 'alta', media: 'média', baixa: 'baixa' }[p] + '</option>').join('') + '</select></div><div class="spd-campo"><label>Tipo</label><select class="spd-sel" data-a="sel" data-k="tipo" data-id="' + a.id + '">' + tiposTodos().map((x) => '<option value="' + x.id + '" ' + (a.meta.tipo === x.id ? 'selected' : '') + '>' + esc(x.nome) + '</option>').join('') + '<option value="__novo">+ novo tipo…</option></select></div></div>' +
        '<div class="spd-campo"><label>Pasta</label><select class="spd-sel" data-a="sel" data-k="pastaId" data-id="' + a.id + '">' + Bib.indice.pastas.map((p) => '<option value="' + p.id + '" ' + (a.meta.pastaId === p.id ? 'selected' : '') + '>' + esc(p.nome) + '</option>').join('') + '</select></div></div></div>' +
        '<div class="spd-secao"><div class="spd-icbtn">' + ic('trash', 22) + '</div><div><h4>Apagar</h4><div class="sub">Remove o arquivo, a nota e as explicações (fica um backup no disco).</div><div class="acoes" style="justify-content:flex-start"><button class="spd-btn perigo" data-a="apagar-arq" data-id="' + a.id + '">Apagar arquivo</button></div></div></div></div>';
    const leitura = '<div class="spd-leitura" data-sc="leitura"><h1>' + esc(titulo) + '</h1><div class="txt">' + esc(texto) + '</div>' + (orig && orig.length > MAXV && !UI.verTudo ? '<p><button class="spd-btn" data-a="ver-tudo">Mostrar tudo</button></p>' : '') + '</div>';
    return { titulo, voltar: 'lista', icone: '<span style="color:#aab4f0;display:grid">' + ic('doc', 20) + '</span>', direita: pilulaTipo(a.meta.tipo), corpo: '<div class="spd-arq m-' + UI.abaArq + '"><div class="spd-mtabs"><button class="spd-tab ' + (UI.abaArq === 'texto' ? 'on' : '') + '" data-a="aba" data-t="texto">Texto</button><button class="spd-tab ' + (UI.abaArq === 'notas' ? 'on' : '') + '" data-a="aba" data-t="notas">Explicação e nota</button></div>' + leitura + painel + '</div>', cls: 'sem-rolagem' };
}

// ---- tela: Descrição (10) ----
const CAMPOS_DESC = [['aparencia', 'Aparência', 'Como ela é, em linhas curtas.', false], ['temperamento', 'Temperamento base', 'O jeito dela quando nada aconteceu.', false], ['oQueMudaHumor', 'O que muda o humor dela', 'Fatos da cena que a deixam melhor ou pior — nunca simpatia ao usuário.', false], ['exemplosFrios', 'Exemplos dela em momento frio', 'Duas ou três falas. Uma por linha.', true], ['comoFala', 'Como fala', 'Jeito de falar, vícios, o que nunca diria.', false], ['oQueSabe', 'O que sabe', 'O que ela sabe de si e do mundo antes da história.', false]];
function telaDescricao() {
    const d = Desc.v || descPadrao(); const tk = estimarTokens(blocoDescricao()); const lim = getConfig().limiteDescricao; const outros = cartaoTemOutrosCampos();
    let h = '<div class="spd-tela"><p class="sub">A Descrição é a ÚNICA fonte de quem ela é. Escreva curto: a IA recebe isto em todo prompt (' + tk + ' de ~' + lim + ' tokens sugeridos).</p>';
    if (cartaoTemDescricao() && !d.importadaDoCartaoEm) h += '<div class="spd-aviso">O cartão da personagem tem uma descrição. Se ela continuar lá E aqui, vai duplicada no prompt. <button class="spd-btn pq" data-a="desc-importar" style="margin-left:8px">Importar do cartão</button></div>';
    if (d.importadaDoCartaoEm && cartaoTemDescricao()) h += '<div class="spd-aviso ruim">A descrição já foi importada, mas o cartão ainda tem texto na Descrição. Esvazie o campo no cartão do SillyTavern pra não ir duplicada.</div>';
    if (outros.length) h += '<div class="spd-aviso">O cartão também tem texto em: ' + esc(outros.join(', ')) + '. O que estiver lá também chega à IA; se já está aqui, esvazie lá.</div>';
    if (tk > lim) h += '<div class="spd-aviso">A Descrição passou de ~' + lim + ' tokens. Nada foi cortado; considere encurtar.</div>';
    h += CAMPOS_DESC.map(([k, rot, sub, lista]) => '<div class="spd-campo"><label>' + rot + ' <span style="color:#6f7278">· ' + sub + '</span></label><textarea class="spd-ta peq" data-campo="desc.' + k + '">' + esc(UI.rasc['desc.' + k] ?? (lista ? (d[k] || []).join('\n') : d[k])) + '</textarea></div>').join('');
    return { titulo: 'Descrição', corpo: h + '<div style="display:flex;justify-content:flex-end"><button class="spd-btn prim" data-a="desc-salvar">Salvar descrição</button></div></div>' };
}
// ---- tela: Memória (3 gavetas, 7.1) ----
function telaMemoria() {
    const p = montarPrompt(); const g = p.gavetas; const barra = (x) => '<div class="spd-barra" style="margin:10px 0 4px"><i class="' + (x.usado > x.limite ? 'ruim' : '') + '" style="width:' + Math.min(100, (x.usado / x.limite) * 100) + '%"></i></div>';
    const fatos = Mem.rp.fatos.map((f) => { const sabe = sabeFato(f); const fora = p.fora.memoria.some((x) => x.texto === f.texto); return '<div class="spd-fato ' + (fora ? 'fora' : '') + '"><div class="tx">' + esc(f.texto) + '<small>sabem: ' + esc((f.sabem || []).join(', ') || '—') + (sabe ? '' : ' · ELA NÃO SABE (não vai pro prompt)') + (fora ? ' · fora do orçamento' : '') + '</small></div><button data-a="mem-edit" data-id="' + f.id + '" title="Editar">' + ic('pen', 16) + '</button><button data-a="mem-del" data-id="' + f.id + '" title="Apagar">' + ic('trash', 16) + '</button></div>'; }).join('');
    const pedidos = (Mem.espaco.pedidos || []).map((q) => '<div class="spd-fato"><div class="tx">' + esc(q.texto) + '</div><button data-a="pedido-del" data-id="' + q.id + '" title="Apagar">' + ic('trash', 16) + '</button></div>').join('');
    const rec = espacoPedidosRecentes().map((m) => '<div class="spd-fato"><div class="tx">' + esc(m.texto) + '<small>pedido recente · vai na próxima fala</small></div></div>').join('');
    const notas = p.selecionadas.map((e) => '<div class="spd-fato"><div class="tx">' + esc(e.it.titulo) + '<small>' + { completa: 'nota completa', minima: 'nota mínima', titulo: 'só o título' }[e.modo] + ' · ' + esc(e.it.tipo) + '</small></div></div>').join('') + p.fora.biblioteca.map((f) => '<div class="spd-fato fora"><div class="tx">' + esc(f.it.titulo) + '<small>fora do orçamento — ' + esc(f.motivo) + '</small></div></div>').join('');
    const pct = Math.round((p.total / p.limite) * 100);
    return { titulo: 'Memória', corpo: '<div class="spd-tela"><div style="display:flex;gap:20px;align-items:center;margin-bottom:6px"><div class="spd-anel ' + (pct > 100 ? 'ruim' : '') + '" style="--p:' + Math.min(100, pct) + '"><div><span><b>' + pct + '%</b>do limite</span></div></div><div><div style="font-size:17px;color:#f0f1f3">' + fmtNum(p.total) + ' de ' + fmtNum(p.limite) + ' tokens</div><div class="sub" style="margin:4px 0 0">É o que a Spade injeta a cada fala (nada além disto).</div></div></div>' + p.avisos.map((v) => '<div class="spd-aviso">' + esc(v) + '</div>').join('') +
        '<div class="spd-gaveta"><h4>RP — o que aconteceu <span class="u">' + g.rp.usado + ' / ' + g.rp.limite + '</span></h4>' + barra(g.rp) + '<div class="sub">Fatos curtos com “quem sabe”. Só o que a personagem sabe chega à IA.</div>' + (fatos || '<div class="spd-vazio" style="padding:14px">Ainda sem fatos.</div>') + '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="spd-btn ciano" data-a="job-memoria">' + ic('refresh', 16) + 'Atualizar com IA</button><button class="spd-btn" data-a="mem-add">' + ic('plus', 16) + 'Adicionar fato</button></div></div>' +
        '<div class="spd-gaveta"><h4>Espaço — pedidos ao RP <span class="u">' + g.espaco.usado + ' / ' + g.espaco.limite + '</span></h4>' + barra(g.espaco) + '<div class="sub">O que você pede no Espaço. As respostas da IA de lá nunca entram aqui.</div>' + (pedidos || '') + (rec || (pedidos ? '' : '<div class="spd-vazio" style="padding:14px">Nenhum pedido ainda.</div>')) + '</div>' +
        '<div class="spd-gaveta"><h4>Biblioteca — notas ativas <span class="u">' + g.biblioteca.usado + ' / ' + g.biblioteca.limite + '</span></h4>' + barra(g.biblioteca) + '<div class="sub">A IA lê só a nota. A mínima de todas entra primeiro; a completa sobe enquanto couber.</div>' + (notas || '<div class="spd-vazio" style="padding:14px">Nenhuma nota ativa e revisada.</div>') + '</div></div>' };
}
// ---- tela: Prévia (13.5) ----
function telaPrevia() {
    const p = montarPrompt(); const o = Diag.ultimaOrdem; const T = tiposDoST();
    const ordem = o ? '<div class="spd-aviso ' + (o.emOrdem && !o.faltando.length ? 'bom' : 'ruim') + '"><b>Último prompt enviado (' + fmtRel(Diag.ultimoPromptEm) + '):</b> ' + (o.emOrdem ? 'os blocos estão na ordem certa' : 'os blocos NÃO estão na ordem esperada') + (o.faltando.length ? '; não achei no prompt final: ' + esc(o.faltando.join(', ')) : '') + '<br>' + o.achados.map((a) => a.n + ' ' + esc(a.titulo) + ' → mensagem ' + (a.msg + 1)).join(' · ') + '</div>' : '<div class="spd-aviso">Ainda não vi nenhum prompt sair. Gere uma fala no RP e volte aqui: eu confiro a ordem real em que o SillyTavern montou tudo.</div>';
    const blocos = p.blocos.map((b) => '<details class="spd-bloco"><summary><span style="color:#8f929a;font:12px ui-monospace,monospace">' + b.n + '</span><span>' + esc(b.titulo) + '</span><span class="tk">' + (b.texto ? b.tokens + ' tokens' : 'vazio') + '</span></summary>' + (b.texto ? '<pre>' + esc(b.texto) + '</pre>' : '') + '</details>').join('');
    const fora = p.fora.biblioteca.concat(p.fora.memoria.map((x) => ({ it: { titulo: x.texto }, motivo: x.motivo })), p.fora.espaco.map((x) => ({ it: { titulo: x.texto }, motivo: x.motivo })));
    const st = (Diag.eventosFaltando.length ? 'Eventos que esta versão do SillyTavern não tem: ' + Diag.eventosFaltando.join(', ') + '. ' : '') + (T.deConstantes ? 'Constantes de posição lidas do SillyTavern.' : 'Constantes de posição NÃO expostas por esta versão: usei os números conhecidos (0/1/2) — confira a ordem acima.');
    return { titulo: 'Prévia do prompt', corpo: '<div class="spd-tela"><p class="sub">É exatamente o que a Spade entrega ao SillyTavern, na ordem, com os tokens de cada bloco (estimados em ~3,5 caracteres por token). O chat em si (bloco 6) é do SillyTavern.</p>' + p.avisos.map((v) => '<div class="spd-aviso">' + esc(v) + '</div>').join('') + ordem + '<div style="display:flex;justify-content:space-between;align-items:center;margin:14px 0"><span style="font-size:16px;color:#f0f1f3">Total: ' + p.total + ' de ' + p.limite + ' tokens</span><button class="spd-btn pq" data-a="copiar-prompt">' + ic('copy', 15) + 'Copiar</button></div>' + blocos + (fora.length ? '<h3>Fora do orçamento (' + fora.length + ')</h3>' + fora.map((f) => '<div class="spd-fato fora"><div class="tx">' + esc(String(f.it.titulo).slice(0, 160)) + '<small>' + esc(f.motivo) + '</small></div></div>').join('') : '') + (p.naoSabe.length ? '<h3>Fatos que ela NÃO sabe (' + p.naoSabe.length + ')</h3><p class="sub">Ficam só na tela; não vão pro prompt.</p>' : '') + '<p class="sub" style="margin-top:22px">' + esc(st) + '</p></div>' };
}
// ---- tela: Jobs (12.4) ----
function telaJobs() {
    const rot = { fila: 'na fila', rodando: 'rodando', ok: 'pronto', erro: 'erro', cancelado: 'cancelado' };
    const det = (j) => { const r = j.resultado; if (!r) return ''; const l = []; if (r.novos && r.novos.length) l.push('+ ' + r.novos.join(' · ')); if (r.substituidos && r.substituidos.length) l.push('~ ' + r.substituidos.join(' · ')); if (r.removidos && r.removidos.length) l.push('− ' + r.removidos.join(' · ')); if (r.pedidos) l.push(r.pedidos.length + ' pedido(s) duradouro(s)'); if (r.aviso) l.push(r.aviso); return l.join('\n'); };
    const lista = Jobs.lista.map((j) => '<div class="spd-job"><div class="l"><span class="n">' + esc(j.nome) + '</span><span class="st ' + j.estado + '">' + rot[j.estado] + '</span></div><div class="s">~' + fmtNum(j.tokens) + ' tokens' + (j.detalhe ? ' · ' + esc(j.detalhe) : '') + (j.fimEm ? ' · ' + fmtRel(j.fimEm) : '') + '</div>' + (j.erro ? '<div class="spd-aviso ruim" style="margin:10px 0 0">' + esc(j.erro) + '</div>' : '') + (det(j) ? '<div class="s" style="white-space:pre-wrap;color:#b6c0d3">' + esc(det(j)) + '</div>' : '') + '<div style="display:flex;gap:8px;margin-top:10px">' + ((j.estado === 'fila' || j.estado === 'rodando') ? '<button class="spd-btn pq" data-a="job-cancelar" data-id="' + j.id + '">Cancelar</button>' : '') + (j.alvoId && j.estado === 'ok' ? '<button class="spd-btn pq" data-a="abrir-arq" data-id="' + j.alvoId + '">Abrir arquivo</button>' : '') + (j.desfazer && j.estado === 'ok' ? '<button class="spd-btn pq" data-a="job-desfazer" data-id="' + j.id + '">Desfazer</button>' : '') + '</div></div>').join('');
    return { titulo: 'Jobs', corpo: '<div class="spd-tela"><p class="sub">Tudo que usa a IA fora do RP aparece aqui. Nada roda sozinho: começa quando você toca num botão ou anexa um arquivo.</p>' + (lista || '<div class="spd-vazio">Nenhum job nesta sessão.</div>') + '</div>' };
}
// ---- tela: Configurações ----
const campoCfg = (k, rot, tipo, extra) => { const c = getConfig(); const v = c[k]; const sel = (opts) => '<select class="spd-sel" data-cfg="' + k + '">' + opts.map(([val, r]) => '<option value="' + val + '" ' + (String(v) === String(val) ? 'selected' : '') + '>' + r + '</option>').join('') + '</select>';
    let inp; if (tipo === 'select') inp = sel(extra); else if (tipo === 'sw') inp = '<button class="spd-sw ' + (v ? 'on' : '') + '" data-a="cfg-sw" data-k="' + k + '"></button>'; else if (tipo === 'ta') inp = '<textarea class="spd-ta peq" data-cfg="' + k + '" placeholder="uma por linha">' + esc((v || []).join('\n')) + '</textarea>'; else inp = '<input class="spd-in" data-cfg="' + k + '" type="' + tipo + '" value="' + esc(v) + '">';
    return '<div class="spd-campo"><label>' + rot + '</label>' + inp + '</div>'; };
function telaConfig() {
    const T = tiposDoST();
    return { titulo: 'Configurações', corpo: '<div class="spd-tela"><h3 style="margin-top:0">Disco</h3><div class="spd-aviso ' + (Plug.ok ? 'bom' : 'ruim') + '">' + (Plug.ok ? 'Plugin spade-fs ' + esc(Plug.versao) + ' conectado. Seus arquivos e memória ficam no disco do SillyTavern.' : 'Plugin spade-fs não respondeu: ' + esc(Plug.erro || 'não testado') + '. Sem ele, tudo fica só neste navegador.') + '</div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"><button class="spd-btn" data-a="checar-plugin">' + ic('refresh', 16) + 'Testar plugin</button><button class="spd-btn" data-a="exportar">Exportar tudo</button><button class="spd-btn" data-a="backup">Backup no disco</button><button class="spd-btn" data-a="migrar">Migrar documentos antigos</button></div>' +
        '<h3>IA</h3>' + campoCfg('apiKey', 'API key da NanoGPT (fica só neste navegador)', 'password') + campoCfg('modelo', 'Modelo (uma IA só: jobs e Espaço)', 'text') + '<div class="spd-grid2">' + campoCfg('tamanhoNota', 'Tamanho da nota', 'select', [['curta', 'curta (80–200 tokens)'], ['padrao', 'padrão (120–400)'], ['longa', 'longa (300–700)']]) + campoCfg('thinkingNosJobs', 'Raciocínio da IA nos jobs', 'select', [['disabled', 'desligado (mais rápido)'], ['enabled', 'ligado'], ['padrao', 'padrão do modelo']]) + '</div>' +
        '<h3>Orçamento de tokens</h3><p class="sub">A soma das 3 gavetas não pode passar do limite geral.</p><div class="spd-grid2">' + campoCfg('limiteGeral', 'Limite geral', 'number') + campoCfg('limiteDescricao', 'Descrição (aviso)', 'number') + campoCfg('limiteRp', 'Gaveta RP', 'number') + campoCfg('limiteEspaco', 'Gaveta Espaço', 'number') + campoCfg('limiteBiblioteca', 'Gaveta Biblioteca', 'number') + campoCfg('avisoArquivoTokens', 'Avisar arquivo acima de (tokens)', 'number') + '</div>' +
        '<h3>RP</h3><div class="spd-bar-sw"><span>Pedidos do Espaço valem no RP<small>chave geral</small></span><button class="spd-sw ' + (getConfig().espacoParaRp ? 'on' : '') + '" data-a="cfg-sw" data-k="espacoParaRp"></button></div><div class="spd-grid2" style="margin-top:14px">' + campoCfg('espacoMaxMensagens', 'Mensagens recentes do Espaço enviadas ao RP', 'number') + campoCfg('pessoaPensamento', 'Pensamento da personagem', 'select', [['1', '1ª pessoa'], ['2', '2ª pessoa'], ['3', '3ª pessoa']]) + campoCfg('estiloModo', 'Estilo guiado', 'select', [['leve', 'leve (3 exemplos, cutuca só com desvio grande)'], ['forte', 'forte (5 exemplos, cutuca mais)'], ['desligado', 'desligado']]) + campoCfg('posicaoTopo', 'Posição dos blocos 1–4', 'select', [['in_prompt', 'no prompt'], ['before_prompt', 'antes do prompt']]) + '</div>' + campoCfg('tiquesCadastrados', 'Tiques que enjoei (palavras ou frases a evitar)', 'ta') +
        '<h3>Diagnóstico</h3><p class="sub">Spade ' + VERSAO + ' · constantes do SillyTavern: ' + (T.deConstantes ? 'lidas' : 'padrão (0/1/2)') + ' · eventos ausentes: ' + (Diag.eventosFaltando.join(', ') || 'nenhum') + ' · raciocínio ' + (Pensa.recusado ? 'RECUSADO pela API (não enviado)' : 'não recusado') + (Plug.ok ? ' · pasta de dados: ' + esc(Plug.pasta || '') : '') + '</p></div>' };
}
// ---- tela: Início (13.5) — só o que tem dado real ----
function telaInicio() {
    const p = montarPrompt(); const pct = Math.round((p.total / p.limite) * 100); const rec = listaArquivos().sort((a, b) => (b.meta.editadoEm || 0) - (a.meta.editadoEm || 0)).slice(0, 4);
    const at = (t, i, r, s) => '<button class="spd-atalho" data-a="nav" data-t="' + t + '">' + ic(i, 22) + '<span style="font-size:16px">' + r + '</span><small>' + s + '</small></button>';
    return { titulo: 'Início', corpo: '<div class="spd-tela"><div style="display:flex;gap:22px;align-items:center"><div class="spd-anel ' + (pct > 100 ? 'ruim' : '') + '" style="--p:' + Math.min(100, pct) + '"><div><span><b>' + pct + '%</b>contexto</span></div></div><div><div style="font-size:20px;color:#f0f1f3">' + esc(personagemAtual()) + '</div><div class="sub" style="margin:6px 0 0">' + p.total + ' de ' + p.limite + ' tokens vão na próxima fala · ' + listaArquivos().length + ' arquivos · ' + Mem.rp.fatos.length + ' fatos na memória</div></div></div>' + relCardHtml() + '<div class="spd-atalhos">' + at('espaco', 'chat', 'Espaço', 'falar com a IA') + at('pastas', 'book', 'Biblioteca', listaArquivos().length + ' arquivos') + at('memoria', 'layers', 'Memória', '3 gavetas') + at('descricao', 'user', 'Descrição', 'quem ela é') + at('previa', 'eye', 'Prévia', 'o prompt real') + at('jobs', 'list', 'Jobs', jobsAtivos().length + ' rodando') + '</div>' + (rec.length ? '<h3>Recentes</h3><div class="spd-cards" style="grid-template-columns:repeat(auto-fill,minmax(240px,1fr))">' + rec.map(cardHtml).join('') + '</div>' : '') + '</div>' };
}
function renderTela() {
    try {
        switch (UI.tela) {
            case 'pastas': return telaPastas(); case 'lista': return telaLista(); case 'arquivo': return telaArquivo(); case 'descricao': return telaDescricao(); case 'memoria': return telaMemoria();
            case 'previa': return telaPrevia(); case 'jobs': return telaJobs(); case 'config': return telaConfig(); case 'inicio': return telaInicio(); default: return telaEspaco();
        }
    } catch (e) { console.error('[Spade] tela', UI.tela, e); return { titulo: 'Erro', corpo: '<div class="spd-vazio">Esta tela deu erro: ' + esc(e.message) + '<br><br><button class="spd-btn" data-a="nav" data-t="espaco">Voltar ao Espaço</button></div>' }; }
}

// ---- ações (delegadas por data-a) ----
async function lerArquivoTexto(f) {
    if (f.size > 8 * 1024 * 1024) throw new Error(f.name + ': passa de 8 MB.');
    const t = await f.text(); if (t.includes('\u0000')) throw new Error(f.name + ' não parece texto (PDF e imagem ainda não são suportados).'); return t;
}
const arq = (el) => Bib.arquivos.get(el.dataset.id || UI.arqId);
const coletar = (prefixo, atual) => (UI.rasc[prefixo] != null ? UI.rasc[prefixo] : atual);
const limpaRasc = (...ks) => ks.forEach((k) => delete UI.rasc[k]);
async function salvarMetaToast(a, msg) { a.meta.editadoEm = Date.now(); await salvarMetaArq(a); toast(msg || 'Salvo.'); refrescarUI(); }
const ACOES = {
    fechar: () => fechar(), lateral: () => { UI.lateral = !UI.lateral; render(); },
    nav: (el) => irPara(el.dataset.t), voltar: (el) => irPara(el.dataset.t),
    'rel-toggle': async () => { await memCarregar(); const r = Mem.relogio; r.ligado = !r.ligado; r.ultimoIdx = (ctx().chat || []).length; await memSalvar('relogio'); refrescarUI(); },
    'rel-desfazer': () => relDesfazer(),
    'rel-ajustar': async () => {
        await memCarregar(); const r = Mem.relogio; const campo = (rot, v, min, max) => '<div class="spd-campo" style="margin-top:12px"><label>' + rot + '</label><input class="spd-in" type="number" inputmode="numeric" min="' + min + '" max="' + max + '" value="' + v + '"></div>';
        modalForm('Ajustar o relógio da história', campo('Dia', r.dia, 1, 9999) + campo('Hora (0 a 23)', r.hora, 0, 23) + campo('Minuto (0 a 59)', r.minuto, 0, 59), async (m) => {
            const [d, h, mi] = [...m.querySelectorAll('input')].map((x) => Number(x.value));
            if (!(d >= 1) || !(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59) || [d, h, mi].some((x) => !Number.isInteger(x))) throw new Error('Use números inteiros: dia ≥ 1, hora de 0 a 23, minuto de 0 a 59.');
            await relAplicarPlano({ para: { dia: d, hora: h, minuto: mi } }, 'ajuste manual', { ligar: true }); toast('Relógio ajustado.');
        });
    },
    'novo-chat': async () => { await novaConversa(); irPara('espaco'); },
    'buscar-conv': () => { UI.buscandoConv = true; render(); const i = UI.raiz.querySelector('[data-campo="buscaConv"]'); i && i.focus(); },
    conv: async (el) => { await espacoAbrir(el.dataset.id); irPara('espaco'); },
    caixa: async (el, ev) => {
        ev.stopPropagation(); const id = el.dataset.id;
        if (grupoDaConversa(id)) { await desconectarConversa(id); return toast('Conversa desconectada.'); }
        if (!Esp.abertaId) return toast('Abra uma conversa e toque na caixinha de OUTRA para conectar.');
        if (id === Esp.abertaId) return toast('Toque na caixinha de OUTRA conversa para conectar com esta.');
        await conectarConversas(Esp.abertaId, id); toast('Conversas conectadas.');
    },
    'renomear-conv': () => { const c = Esp.chats.find((x) => x.id === Esp.abertaId); if (!c) return; modalForm('Renomear conversa', '<input class="spd-in" value="' + esc(c.titulo) + '">', async (m) => { c.titulo = m.querySelector('input').value.trim() || c.titulo; await salvarEspacoChats(); refrescarUI(); }); },
    'apagar-conv': async () => { const ok = await perguntar('Apagar esta conversa do Espaço? Os pedidos dela deixam de valer no RP.', [{ rotulo: 'Cancelar', valor: false }, { rotulo: 'Apagar', valor: true, cls: 'perigo' }]); if (ok) { await apagarConversa(Esp.abertaId); render(); } },
    vale: async (el) => { const c = Esp.chats.find((x) => x.id === Esp.abertaId); if (c) await alternarEnvioAoRp(c.id, +el.dataset.i); },
    anexar: () => { const f = UI.raiz.querySelector('#spd-file'); f && f.click(); },
    'rm-anexo': (el) => { UI.anexos.splice(+el.dataset.i, 1); render(); },
    enviar: async () => { const t = UI.rasc.composer || ''; const an = UI.anexos; if (!t.trim() && !an.length) return; UI.rasc.composer = ''; UI.anexos = []; render(); await enviarMensagemEspaco(t, an); },
    'job-memoria': () => { rodarMemoriaRp(); toast('Atualizando a memória — veja em Jobs.'); },
    'job-espaco': () => { const textos = Esp.paraRp.filter((m) => m.enviar).slice(0, Math.max(0, Esp.paraRp.filter((m) => m.enviar).length - getConfig().espacoMaxMensagens)).map((m) => m.texto); rodarConsolidarEspaco(textos); toast('Consolidando pedidos — veja em Jobs.'); },
    // biblioteca
    'ir-lista': (el) => irPara('lista', { pastaSel: el.dataset.p, filtroTipo: el.dataset.tp || 'todos', busca: '', modoGrupo: false, selGrupo: new Set() }),
    'nova-pasta': () => modalForm('Nova pasta', '<input class="spd-in" placeholder="Nome da pasta">' + swatches(CORES_PASTA[0]), async (m) => { const n = m.querySelector('input').value.trim(); if (!n) throw new Error('Dê um nome à pasta.'); await criarPasta(n, m.dataset.cor); render(); }),
    'editar-pasta': (el) => { const p = pastaInfo(el.dataset.id); modalForm('Editar pasta', '<input class="spd-in" value="' + esc(p.nome) + '">' + swatches(p.cor), async (m) => { await mudarPasta(p.id, { nome: m.querySelector('input').value.trim() || p.nome, cor: m.dataset.cor || p.cor }); render(); }, { rotulo: 'Apagar pasta', fn: async () => { const ok = await perguntar('Apagar a pasta “' + p.nome + '”? Os arquivos dela vão para a primeira pasta que sobrar — nada é apagado.', [{ rotulo: 'Cancelar', valor: false }, { rotulo: 'Apagar pasta', valor: true, cls: 'perigo' }]); if (ok) { await apagarPasta(p.id); render(); } } }); },
    filtro: (el) => { UI.filtroTipo = el.dataset.t; render(); },
    'modo-grupo': () => { UI.modoGrupo = !UI.modoGrupo; UI.selGrupo = new Set(); render(); }, 'cancelar-grupo': () => { UI.modoGrupo = false; UI.selGrupo = new Set(); render(); },
    'criar-grupo': () => modalForm('Nome do grupo', '<input class="spd-in" placeholder="Ex.: Família da Hanna">', async (m) => { await ligarGrupo([...UI.selGrupo], m.querySelector('input').value.trim() || 'Grupo'); UI.modoGrupo = false; UI.selGrupo = new Set(); toast('Grupo criado. Escreva ou gere a nota do grupo.'); render(); }),
    'editar-grupo': (el) => {
        const g = Bib.indice.grupos.find((x) => x.id === el.dataset.id); const n = g.nota || { completa: '', minima: '' };
        modalForm('Grupo: ' + g.nome, '<p class="sub" style="color:#8f929a;margin:0 0 10px">' + g.arquivoIds.length + ' arquivos. Com nota própria, só ela entra no prompt (as dos membros ficam de fora).</p><div class="spd-campo"><label>Nota completa</label><textarea class="spd-ta peq" id="gc">' + esc(n.completa) + '</textarea></div><div class="spd-campo"><label>Nota mínima</label><textarea class="spd-ta peq" id="gm" style="min-height:70px">' + esc(n.minima) + '</textarea></div><button class="spd-btn pq" id="gia">Gerar com IA</button>', async (m) => { const c = m.querySelector('#gc').value.trim(); g.nota = c ? { completa: c, minima: m.querySelector('#gm').value.trim(), geradaEm: Date.now(), editadaPeloUsuario: true, revisada: true } : null; await bibSalvarIndice(); render(); }, { rotulo: 'Desfazer grupo', fn: async () => { await desfazerGrupo(g.id); render(); } });
        const bt = UI.raiz.querySelector('#gia'); if (bt) bt.onclick = () => { rodarNotaDeGrupo(g); toast('Gerando a nota do grupo — veja em Jobs.'); };
    },
    'adicionar-arq': () => { const f = UI.raiz.querySelector('#spd-file-bib'); f && f.click(); },
    'abrir-arq': (el) => { if (UI.modoGrupo && UI.tela === 'lista') { const id = el.dataset.id; UI.selGrupo.has(id) ? UI.selGrupo.delete(id) : UI.selGrupo.add(id); return render(); } UI.rasc = {}; irPara('arquivo', { arqId: el.dataset.id, expSel: 0, abaArq: 'texto', verTudo: false }); },
    aba: (el) => { UI.abaArq = el.dataset.t; render(); }, 'ver-tudo': () => { UI.verTudo = true; render(); },
    // arquivo: explicação / observação
    'exp-add': async () => { const a = arq({ dataset: {} }); a.meta.explicacoes.push({ id: newId('e'), texto: '', criadoEm: Date.now() }); UI.expSel = a.meta.explicacoes.length - 1; await salvarMetaToast(a, 'Explicação criada. Escreva e salve.'); },
    'exp-sel': (el) => { UI.expSel = +el.dataset.i; render(); },
    'exp-salvar': async () => { const a = arq({ dataset: {} }); const i = Math.min(UI.expSel, a.meta.explicacoes.length - 1); a.meta.explicacoes[i].texto = coletar('exp.' + i, a.meta.explicacoes[i].texto); limpaRasc('exp.' + i); await salvarMetaToast(a); },
    'exp-del': async () => { const a = arq({ dataset: {} }); a.meta.explicacoes.splice(UI.expSel, 1); UI.expSel = Math.max(0, UI.expSel - 1); UI.rasc = {}; await salvarMetaToast(a, 'Explicação removida.'); },
    'obs-olho': async () => { const a = arq({ dataset: {} }); a.meta.observacaoVisivelParaIA = !a.meta.observacaoVisivelParaIA; await salvarMetaToast(a, a.meta.observacaoVisivelParaIA ? 'A IA vê a observação.' : 'A IA não vê a observação.'); },
    'obs-salvar': async () => { const a = arq({ dataset: {} }); a.meta.observacao = coletar('obs', a.meta.observacao); limpaRasc('obs'); await salvarMetaToast(a); },
    // arquivo: nota e análise
    analisar: async (el) => { const a = arq(el); const cfg = getConfig(); if ((a.meta.chars || 0) / 3.5 > cfg.avisoArquivoTokens) { const ok = await perguntar('Este arquivo é grande (~' + fmtNum(Math.round(a.meta.chars / 3.5)) + ' tokens) e vai INTEIRO para a IA. Analisar mesmo assim?', [{ rotulo: 'Cancelar', valor: false }, { rotulo: 'Analisar', valor: true, cls: 'prim' }]); if (!ok) return; } rodarAnalise(a); toast('Análise na fila — acompanhe em Jobs.'); },
    'salvar-nota': async (el) => { const a = arq(el); a.nota.completa = coletar('nota.completa', a.nota.completa); a.nota.minima = coletar('nota.minima', a.nota.minima); a.nota.editadaPeloUsuario = true; a.nota.revisada = true; limpaRasc('nota.completa', 'nota.minima'); await salvarNotaArq(a); toast('Nota salva.'); refrescarUI(); },
    'aceitar-nota': async (el) => { const a = arq(el); a.nota.completa = coletar('nota.completa', a.nota.completa); a.nota.minima = coletar('nota.minima', a.nota.minima); a.nota.revisada = true; limpaRasc('nota.completa', 'nota.minima'); await salvarNotaArq(a); toast('Nota aceita — já pode entrar no prompt.'); refrescarUI(); },
    'gerar-minima': (el) => { rodarMinima(arq(el)); toast('Gerando a mínima — veja em Jobs.'); },
    'proposta-usar': async (el) => { const a = arq(el); const velha = a.nota; const nova = velha.proposta; nova.historico = [{ completa: velha.completa, minima: velha.minima, em: velha.geradaEm }].concat(velha.historico || []).slice(0, 5); a.nota = nova; a.meta.analisadoEm = Date.now(); await salvarNotaArq(a); await salvarMetaArq(a); refrescarUI(); },
    'proposta-descartar': async (el) => { const a = arq(el); delete a.nota.proposta; await salvarNotaArq(a); refrescarUI(); },
    tg: async (el) => { const a = arq(el); const k = el.dataset.k; a.meta[k] = !a.meta[k]; await salvarMetaToast(a, 'Salvo.'); },
    sel: async (el) => { const a = arq(el); const k = el.dataset.k; let v = el.value; if (k === 'tipo' && v === '__novo') { modalForm('Novo tipo de arquivo', '<input class="spd-in" placeholder="Ex.: cenário">' + swatches('#c4c6d2'), async (m) => { const id = await criarTipo(m.querySelector('input').value, m.dataset.cor); a.meta.tipo = id; await salvarMetaToast(a); }); return render(); } a.meta[k] = v; if (k === 'pastaId') setConfig({ ultimaPasta: v }); await salvarMetaToast(a); },
    voz: async (el) => { const a = arq(el); const v = el.value; const ok = await perguntar('Reanalisar medindo só a voz “' + v + '”? Os exemplos e medidas serão refeitos (a nota que você editou não é trocada sem perguntar).', [{ rotulo: 'Cancelar', valor: false }, { rotulo: 'Reanalisar', valor: true, cls: 'prim' }]); if (ok) { rodarAnalise(a, { vozAlvo: v }); toast('Reanálise na fila.'); } else render(); },
    'ex-fav': async (el) => { const a = arq(el); const e = a.nota.estilo.exemplos.find((x) => x.id === el.dataset.x); e.favorito = !e.favorito; if (e.favorito) e.bloqueado = false; a.nota.estilo.editadaPeloUsuario = true; await salvarNotaArq(a); refrescarUI(); },
    'ex-blq': async (el) => { const a = arq(el); const e = a.nota.estilo.exemplos.find((x) => x.id === el.dataset.x); e.bloqueado = !e.bloqueado; if (e.bloqueado) e.favorito = false; a.nota.estilo.editadaPeloUsuario = true; await salvarNotaArq(a); refrescarUI(); },
    'apagar-arq': async (el) => { const a = arq(el); const ok = await perguntar('Apagar “' + a.meta.nome + '” e a nota dele? Fica um backup no disco.', [{ rotulo: 'Cancelar', valor: false }, { rotulo: 'Apagar', valor: true, cls: 'perigo' }]); if (!ok) return; await apagarArquivo(a); UI.original.delete(a.id); toast('Arquivo apagado.'); irPara('lista'); },
    // descrição / memória
    'desc-salvar': async () => { await descCarregar(); for (const [k, , , lista] of CAMPOS_DESC) { const v = UI.rasc['desc.' + k]; if (v != null) Desc.v[k] = lista ? v.split('\n').map((x) => x.trim()).filter(Boolean) : v; } UI.rasc = {}; await descSalvar(); toast('Descrição salva.'); refrescarUI(); },
    'desc-importar': async () => { await descImportarDoCartao(); toast('Descrição importada. Esvazie o campo no cartão do SillyTavern.'); render(); },
    'mem-add': () => modalForm('Novo fato', '<textarea class="spd-ta peq" placeholder="Uma frase curta e concreta"></textarea><div class="spd-campo" style="margin-top:12px"><label>Quem sabe (separe por vírgula)</label><input class="spd-in" value="' + esc(personagemAtual()) + '"></div>', async (m) => { const t = m.querySelector('textarea').value.trim(); if (!t) throw new Error('Escreva o fato.'); Mem.rp.fatos.push({ id: newId('f'), texto: t, sabem: m.querySelector('input').value.split(',').map((x) => x.trim()).filter(Boolean), criadoEm: Date.now() }); await memSalvar('rp'); render(); }),
    'mem-edit': (el) => { const f = Mem.rp.fatos.find((x) => x.id === el.dataset.id); modalForm('Editar fato', '<textarea class="spd-ta peq">' + esc(f.texto) + '</textarea><div class="spd-campo" style="margin-top:12px"><label>Quem sabe (separe por vírgula)</label><input class="spd-in" value="' + esc((f.sabem || []).join(', ')) + '"></div>', async (m) => { f.texto = m.querySelector('textarea').value.trim() || f.texto; f.sabem = m.querySelector('input').value.split(',').map((x) => x.trim()).filter(Boolean); await memSalvar('rp'); render(); }); },
    'mem-del': async (el) => { Mem.rp.fatos = Mem.rp.fatos.filter((x) => x.id !== el.dataset.id); await memSalvar('rp'); render(); },
    'pedido-del': async (el) => { Mem.espaco.pedidos = Mem.espaco.pedidos.filter((x) => x.id !== el.dataset.id); await memSalvar('espaco'); render(); },
    // jobs / prévia / config
    'job-cancelar': (el) => { const j = Jobs.lista.find((x) => x.id === el.dataset.id); j && cancelarJob(j); },
    'job-desfazer': async (el) => { const j = Jobs.lista.find((x) => x.id === el.dataset.id); if (j && j.desfazer) { await j.desfazer(); j.desfazer = null; toast('Desfeito.'); render(); } },
    'copiar-prompt': async () => { try { await navigator.clipboard.writeText(promptComoTexto(montarPrompt())); toast('Prompt copiado.'); } catch (e) { toast('Não consegui copiar: ' + e.message, true); } },
    'cfg-sw': (el) => { setConfig({ [el.dataset.k]: !getConfig()[el.dataset.k] }); sincronizarSoon(); render(); },
    'checar-plugin': async () => { await checarPlugin(); toast(Plug.ok ? 'Plugin conectado (v' + Plug.versao + ').' : 'Plugin não respondeu.', !Plug.ok); render(); },
    exportar: async () => { const r = await exportarTudo(); toast('Exportado: ' + r.arquivos + ' arquivos e ' + r.conversas + ' conversas.'); },
    backup: async () => { const r = await backupAgora(); toast('Backup criado: ' + r.nome + ' (' + r.arquivos + ' arquivos).'); },
    migrar: async () => { const ok = await perguntar('Trazer os documentos antigos (da versão 7) para a Biblioteca? Faço um backup antes e rodar de novo não duplica nada.', [{ rotulo: 'Cancelar', valor: false }, { rotulo: 'Migrar', valor: true, cls: 'prim' }]); if (!ok) return; toast('Migrando…'); const r = await migrarDocumentos(); await perguntar('Migração: ' + r.criados + ' criados, ' + r.jaExistiam + ' já existiam' + (r.erros.length ? ', ' + r.erros.length + ' com erro' : '') + '. ' + r.comNota + ' já com nota (curtos) e ' + r.semNota + ' esperando análise. Backup: ' + (r.backup || '—') + '.', [{ rotulo: 'Ok', valor: true, cls: 'prim' }]); render(); },
};
function salvarCfg(el) {
    const k = el.dataset.cfg; let v = el.value; const atual = getConfig();
    if (el.type === 'number') v = Math.max(0, Math.round(Number(v) || 0)); else if (k === 'pessoaPensamento') v = Number(v); else if (k === 'tiquesCadastrados') v = v.split('\n').map((x) => x.trim()).filter(Boolean);
    const prox = Object.assign({}, atual, { [k]: v }); if (['limiteRp', 'limiteEspaco', 'limiteBiblioteca', 'limiteGeral'].includes(k) && prox.limiteRp + prox.limiteEspaco + prox.limiteBiblioteca > prox.limiteGeral) { toast('A soma das 3 gavetas (' + (prox.limiteRp + prox.limiteEspaco + prox.limiteBiblioteca) + ') passa do limite geral (' + prox.limiteGeral + '). Não salvei.', true); return render(); }
    setConfig({ [k]: v }); sincronizarSoon(); toast('Salvo.');
}
function ligarUI() {
    const r = UI.raiz; let tBusca;
    r.addEventListener('click', (e) => { const el = e.target.closest('[data-a]'); if (!el || el.tagName === 'SELECT') return; const f = ACOES[el.dataset.a]; if (f) Promise.resolve().then(() => f(el, e)).catch(falhou); });
    r.addEventListener('input', (e) => { const t = e.target; const c = t.dataset && t.dataset.campo; if (!c) return; UI.rasc[c] = t.value; if (c === 'composer') autoAltura(); if (c === 'busca' || c === 'buscaConv') { UI[c] = t.value; clearTimeout(tBusca); tBusca = setTimeout(render, 160); } });
    r.addEventListener('change', async (e) => {
        const t = e.target; try {
            if (t.dataset.cfg) return salvarCfg(t); if (t.dataset.a === 'sel' || t.dataset.a === 'voz') return ACOES[t.dataset.a](t, e);
            if (t.id === 'spd-file') { for (const f of t.files) { try { UI.anexos.push({ nome: f.name, texto: await lerArquivoTexto(f) }); } catch (er) { falhou(er); } } t.value = ''; render(); }
            if (t.id === 'spd-file-bib') { await bibCarregar(); const pasta = Bib.indice.pastas.find((p) => p.id === UI.pastaSel) || Bib.indice.pastas[0]; let n = 0; for (const f of t.files) { try { await criarArquivo({ nome: f.name, texto: await lerArquivoTexto(f), pastaId: pasta.id }); n++; } catch (er) { falhou(er); } } t.value = ''; if (n) toast(n + ' arquivo(s) adicionados em “' + pasta.nome + '”. Abra e mande analisar.'); render(); }
        } catch (er) { falhou(er); }
    });
    r.addEventListener('keydown', (e) => { const t = e.target; if (t.dataset && t.dataset.campo === 'composer' && e.key === 'Enter' && !e.shiftKey && !(ctx().isMobile && ctx().isMobile())) { e.preventDefault(); ACOES.enviar(); } if (e.key === 'Escape' && !r.querySelector('.spd-modal')) fechar(); e.stopPropagation(); });
}

// ============================================================
// 14 INÍCIO
// ============================================================
function criarRaiz() {
    if (document.getElementById('spd-root')) return;
    UI.raiz = document.createElement('div'); UI.raiz.id = 'spd-root'; document.body.appendChild(UI.raiz);
    UI.fab = document.createElement('button'); UI.fab.id = 'spd-fab'; UI.fab.title = 'Spade'; UI.fab.textContent = '♠'; UI.fab.addEventListener('click', () => (UI.aberto ? fechar() : abrir(UI.tela === 'arquivo' && !UI.arqId ? 'espaco' : UI.tela))); document.body.appendChild(UI.fab);
    ligarUI();
}
async function iniciar() {
    criarRaiz(); ligarEventos(); await checarPlugin();
    try { const d = await chamarFs('/saude', null, 'GET'); Plug.pasta = d.pastaDados; } catch (_) { /* sem plugin: a faixa avisa */ }
    await sincronizar(); atualizarFab();
    console.log('[Spade] v' + VERSAO + ' pronto · plugin: ' + (Plug.ok ? 'ok' : 'FORA') + ' · slots: ' + Object.keys(Diag.slotsAplicados).length);
}
iniciar().catch(reportFatalError);

} catch (e) { reportFatalError(e); }
})();
