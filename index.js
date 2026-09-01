/*
 * Spade — Sistema Vivo v6.0.0
 * SillyTavern Extension — tudo num arquivo só, sem backend, sem site
 * separado. fetch() direto pra API da NanoGPT.
 *
 * Herda a base "um só" (claimSurface/presença, família postCharacterMessage)
 * da v5 (T34/T36/T37), e a lógica de RAG/agente/mundo/NPC/tarefas do
 * spade-server (Node) que existia antes disso — ambos reescritos aqui como
 * função de navegador, sem processo separado.
 *
 * Diferença de fundo em relação ao spade-server original, decidida depois
 * de ver a v1 da consolidação: a IA é o ecossistema, não uma feature presa
 * numa estrutura fixa. Por isso NÃO existe mais:
 *   - campo de Perfil fixo editado pelo usuário (era profile.js)
 *   - lista de Falas separada da Cenas/Documentos (eram falas.js + cenas.js)
 *   - fila de treino em lote (era treino.js: gerar sintética/minerar RP)
 *   - Sala de Pensamento como sessão pontual (era agent.js: 6 iterações e para)
 *
 * No lugar: uma Biblioteca única (falas/documentos/cenas/memória, tudo
 * indexado por embedding, busca de verdade), um motor de sistemas/regras
 * que a própria IA compõe (interpretado, não código arbitrário — ver nota
 * em SISTEMAS mais abaixo), e uma Sala de Pensamento como loop CONTÍNUO
 * (enquanto a aba estiver aberta), visível como chat, com uma narração da
 * IA ~2s antes de cada ação aparecendo numa barra fixa no topo.
 */

(function () {
'use strict';

// ====================================
// DIAGNÓSTICO DE ERRO FATAL
// ====================================
function reportFatalError(err) {
    console.error('[Spade] ERRO:', err);
    try {
        let box = document.getElementById('axis-fatal-error');
        if (!box) {
            box = document.createElement('div');
            box.id = 'axis-fatal-error';
            box.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:2147483647;background:#241515;color:#d9a8a8;border:2px solid #b85a5a;border-radius:8px;padding:12px 16px;max-width:min(420px,90vw);font-family:monospace;font-size:12px;white-space:pre-wrap;box-shadow:0 4px 20px rgba(0,0,0,0.6);';
            document.body.appendChild(box);
        }
        box.textContent = '⚠️ Spade — erro:\n' + (err && err.stack ? err.stack : String(err));
    } catch (_) {}
}

try {

function ctx() { return SillyTavern.getContext(); }
const { eventSource, event_types } = ctx();

function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
function newId() { return Date.now() + '-' + Math.random().toString(36).slice(2, 8); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ====================================
// NOME/AVATAR DO PERSONAGEM
// ====================================
function resolveCharacterName() {
    if (ctx().characterId != null && Array.isArray(ctx().characters) && ctx().characters[ctx().characterId]) {
        const nm = ctx().characters[ctx().characterId].name;
        if (nm && nm !== 'SillyTavern System' && nm !== 'System') return nm;
    }
    if (ctx().name2 && ctx().name2 !== 'SillyTavern System' && ctx().name2 !== 'System') return ctx().name2;
    return 'Personagem';
}
function resolveCharacterAvatar() {
    if (ctx().characterId != null && Array.isArray(ctx().characters) && ctx().characters[ctx().characterId]) {
        const avatarFile = ctx().characters[ctx().characterId].avatar;
        if (avatarFile && typeof ctx().getThumbnailUrl === 'function') {
            try { return ctx().getThumbnailUrl('avatar', avatarFile); } catch (_) { return undefined; }
        }
    }
    return undefined;
}
// Identidade usada pra escopar Biblioteca/Memória/Sistemas/Journal — POR
// PERSONAGEM, atravessa chat diferente com o mesmo personagem (decisão:
// memória é sobre quem ela é, não sobre uma conversa isolada).
function personagemAtual() { return resolveCharacterName(); }


// ====================================
// CONFIG — localStorage, pequeno e rápido. API key, modelos, ajustes do
// loop de pensamento. Nada de vetor/embedding mora aqui (isso é IndexedDB).
// ====================================
const CFG_KEY = 'spade_config_v6';
function getConfig() {
    let cfg = {};
    try { cfg = JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch (_) { cfg = {}; }
    return Object.assign({
        apiKey: '',
        modeloEscritor: 'deepseek/deepseek-v4-pro',
        modeloRapido: 'deepseek/deepseek-v4-flash-0731',
        modeloEmbed: 'BAAI/bge-m3',    // fixo de propósito, sem campo em Config — sempre via API (embedNanoGPT), nunca local
        modeloVisao: 'gpt-4o',        // usado pela Ingestão quando você manda foto — troca se preferir outro modelo com visão
        modeloConstrutor: '',         // vazio = "1 IA só" (modeloEscritor faz os dois papéis, prompt trocado por chamada). Preenche pra usar modelo separado como Construtora (spade-fundicao.md seção 1)
        cooldownOciosoMs: 45000,      // último recurso: só entra se ela terminar sem nada pra fazer E sem pedir pausa (ver pensamento_aguardar)
        decayDiasMin: 14,             // dias parado + importância baixa + nunca reacessado até arquivar sozinho na consolidação
        maxIteracoesAgente: 6,        // teto de segurança por passada (RP/Espaço), 
    }, cfg);
}
function setConfig(patch) {
    const next = Object.assign(getConfig(), patch);
    localStorage.setItem(CFG_KEY, JSON.stringify(next));
    return next;
}

// scope() — só o que é efêmero de UI/DOM local (índice da última mensagem
// que ela postou no chat atual, pra editar/apagar/reescrever). Continua em
// localStorage, é pequeno e por chat (não por personagem — é índice de
// array do DOM daquele chat específico).
const DB = 'axis_v6';
let localData = {};
try { localData = JSON.parse(localStorage.getItem(DB) || '{}'); } catch (_) { localData = {}; }
let _saveFailureWarned = false;
function saveLocal() {
    const payload = JSON.stringify(localData);
    try {
        localStorage.setItem(DB, payload);
    } catch (e) {
        console.error('[Spade] saveLocal() falhou:', e);
        if (!_saveFailureWarned) { _saveFailureWarned = true; try { alert('⚠️ O Spade não conseguiu salvar localmente. Erro: ' + (e.message || e)); } catch (_) {} }
        return;
    }
    _saveFailureWarned = false;
}
function scope() {
    const charId = ctx().characterId ?? ctx().groupId ?? 'global';
    const chatId = typeof ctx().getCurrentChatId === 'function' ? ctx().getCurrentChatId() : 'default';
    const key = 'rp_' + charId + '_' + chatId;
    if (!localData[key]) { localData[key] = { lastCharMessageIdx: null }; saveLocal(); }
    if (localData[key].lastCharMessageIdx === undefined) localData[key].lastCharMessageIdx = null;
    return localData[key];
}

// ====================================
// INDEXEDDB — tudo que cresce ou carrega vetor: biblioteca (falas +
// documentos + cenas + memória/estado, unificados), sistemas (regras que a
// IA cria), journal (Sala de Pensamento visível), rodadas (histórico bruto
// do RP, pra repetição/contexto de cena), estado (NPCs/tarefas/mundo/
// histórico do Espaço — pequeno, não vetor, mas cresce mais que o resto do
// localStorage guentaria bem).
// ====================================
const IDB_NAME = 'spade_db_v6';
const IDB_VERSION = 2; // v2: + sistemas_reais (Fundição — ver spade-fundicao.md)
let _idbPromise = null;
function idb() {
    if (_idbPromise) return _idbPromise;
    _idbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('biblioteca')) {
                const s = db.createObjectStore('biblioteca', { keyPath: 'id' });
                s.createIndex('personagem', 'personagem', { unique: false });
                s.createIndex('tipo', 'tipo', { unique: false });
            }
            if (!db.objectStoreNames.contains('sistemas')) {
                const s = db.createObjectStore('sistemas', { keyPath: 'id' });
                s.createIndex('personagem', 'personagem', { unique: false });
            }
            // Separado de 'sistemas' de propósito — aquele é regra/prompt
            // interpretada (motor fixo, nunca eval). Este é código de
            // verdade, só roda dentro do sandbox (ver FUNDIÇÃO abaixo).
            if (!db.objectStoreNames.contains('sistemas_reais')) {
                const s = db.createObjectStore('sistemas_reais', { keyPath: 'id' });
                s.createIndex('personagem', 'personagem', { unique: false });
                s.createIndex('familia', 'familia', { unique: false });
            }
            if (!db.objectStoreNames.contains('journal')) {
                const s = db.createObjectStore('journal', { keyPath: 'id' });
                s.createIndex('personagem', 'personagem', { unique: false });
            }
            if (!db.objectStoreNames.contains('rodadas')) {
                const s = db.createObjectStore('rodadas', { keyPath: 'id' });
                s.createIndex('personagem', 'personagem', { unique: false });
            }
            if (!db.objectStoreNames.contains('estado')) {
                db.createObjectStore('estado', { keyPath: 'chave' }); // chave = personagem+':'+campo
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return _idbPromise;
}
function idbTx(storeName, mode) {
    return idb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}
function idbPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
async function idbPut(storeName, obj) {
    const store = await idbTx(storeName, 'readwrite');
    await idbPromise(store.put(obj));
    return obj;
}
async function idbDelete(storeName, key) {
    const store = await idbTx(storeName, 'readwrite');
    await idbPromise(store.delete(key));
}
async function idbGet(storeName, key) {
    const store = await idbTx(storeName, 'readonly');
    return idbPromise(store.get(key));
}
async function idbAllByPersonagem(storeName, personagem) {
    const store = await idbTx(storeName, 'readonly');
    const idx = store.index('personagem');
    return idbPromise(idx.getAll(IDBKeyRange.only(personagem)));
}

// ---- 'estado' — pequeno, chave composta personagem+campo (npcs, tarefas,
// mundo, agentNote, espacoHistory) — mesma filosofia do state.json original,
// só que async/IndexedDB em vez de arquivo síncrono.
async function estadoGet(campo, padrao) {
    const row = await idbGet('estado', personagemAtual() + ':' + campo);
    return row ? row.valor : padrao;
}
async function estadoSet(campo, valor) {
    await idbPut('estado', { chave: personagemAtual() + ':' + campo, valor });
    return valor;
}
async function estadoDelete(campo) {
    await idbDelete('estado', personagemAtual() + ':' + campo);
}

// ====================================
// NANOGPT — cliente via fetch() direto do navegador (era openai SDK no
// Node). Confirmado na doc (docs.nano-gpt.com): CORS padrão + endpoint
// /api/v1/embeddings aceita `input` como array (usado no upload em lote).
// ====================================
const NANOGPT_BASE = 'https://nano-gpt.com/api/v1';

function anySignal(signals) {
    const valid = signals.filter(Boolean);
    if (!valid.length) return undefined;
    if (valid.length === 1) return valid[0];
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(valid);
    // Fallback pra navegador sem AbortSignal.any (mais antigo) — combina na mão.
    const controller = new AbortController();
    valid.forEach((s) => { if (s.aborted) controller.abort(); else s.addEventListener('abort', () => controller.abort(), { once: true }); });
    return controller.signal;
}

function nanogptHeaders() {
    const { apiKey } = getConfig();
    if (!apiKey) throw new Error('Sem API key da NanoGPT configurada — abre Config no painel e cola sua key.');
    return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey };
}

// Embedding — aceita string ÚNICA ou ARRAY de strings (upload em lote usa
// array, uma chamada só pra N chunks, em vez de N chamadas).
async function embedNanoGPT(input) {
    const { modeloEmbed } = getConfig();
    const resp = await fetch(NANOGPT_BASE + '/embeddings', {
        method: 'POST',
        headers: nanogptHeaders(),
        body: JSON.stringify({ model: modeloEmbed, input }),
    });
    if (!resp.ok) throw new Error('Embedding falhou (' + resp.status + '): ' + (await resp.text()).slice(0, 300));
    const data = await resp.json();
    const rows = data?.data || [];
    if (Array.isArray(input)) return rows.map((r) => r.embedding).filter(Boolean);
    return rows[0]?.embedding ?? null;
}

function cosineSim(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
    if (!normA || !normB) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ====================================
// BM25 EM PT-BR — pendência aberta no spade-rag.md seção 7 ("vai precisar
// de um stemmer leve adaptado, não é plug-and-play"). Isso resolve: um
// stemmer REDUZIDO (não é o RSLP acadêmico completo de Orengo & Huyck —
// esse tem ~8 estágios com dezenas de exceção cada; isso aqui é as regras
// de maior frequência) o bastante pra unir "corre"/"correu"/"correndo" na
// mesma raiz, que era o exemplo concreto do documento. Zero API, JS puro.
// ====================================
function removerAcentos(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
const STOPWORDS_PT = new Set(['a', 'o', 'as', 'os', 'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'nas',
    'um', 'uma', 'uns', 'umas', 'e', 'é', 'ou', 'que', 'se', 'com', 'por', 'para', 'pra', 'pro', 'como', 'mais',
    'mas', 'ao', 'aos', 'à', 'às', 'sua', 'seu', 'suas', 'seus', 'isso', 'esse', 'essa', 'este', 'esta', 'isto',
    'ele', 'ela', 'eles', 'elas', 'eu', 'tu', 'você', 'vc', 'nós', 'minha', 'meu', 'tinha', 'tem', 'ter', 'foi',
    'ser', 'estar', 'está', 'tá', 'não', 'sim', 'já', 'ainda', 'também', 'muito', 'bem', 'só', 'vai', 'vou', 'me',
    'te', 'lhe', 'nos', 'the', 'is', 'was']);
// Ordem importa — mais específico/comprido primeiro, senão um sufixo curto
// (ex: "s") casa antes de um mais preciso (ex: "ões") no mesmo radical.
const SUFIXOS_VERBAIS = ['ássemos', 'êssemos', 'íssemos', 'aríamos', 'eríamos', 'iríamos', 'assem', 'essem', 'issem',
    'arão', 'erão', 'irão', 'aram', 'eram', 'iram', 'avam', 'iam', 'ando', 'endo', 'indo',
    'ado', 'ada', 'ados', 'adas', 'ido', 'ida', 'idos', 'idas', 'ará', 'erá', 'irá', 'arei', 'erei', 'irei',
    'asse', 'esse', 'isse', 'arem', 'erem', 'irem', 'amos', 'emos', 'imos', 'ava', 'ia',
    'eu', 'iu', 'ou', 'ar', 'er', 'ir'];
const SUFIXOS_NOMINAIS = ['izações', 'ização', 'amentos', 'amento', 'imentos', 'imento', 'íssimos', 'íssimas',
    'íssimo', 'íssima', 'inhos', 'inhas', 'inho', 'inha', 'zinhos', 'zinhas', 'zinho', 'zinha',
    'ável', 'ível', 'osos', 'osas', 'oso', 'osa', 'dades', 'dade', 'ções', 'ção', 'mente', 'es', 's'];
function radicalPtBr(palavra) {
    let p = removerAcentos(palavra.toLowerCase());
    if (p.length <= 3) return p;
    for (const suf of SUFIXOS_VERBAIS) { if (p.endsWith(suf) && p.length - suf.length >= 3) { p = p.slice(0, -suf.length); break; } }
    for (const suf of SUFIXOS_NOMINAIS) { if (p.endsWith(suf) && p.length - suf.length >= 3) { p = p.slice(0, -suf.length); break; } }
    // Último recurso, só presente/3ª pessoa singular (corre/parte/insiste) —
    // ambíguo com substantivo terminado em vogal (ex: "parte" o substantivo
    // vira o mesmo radical de "parte" o verbo). Aceito de propósito: isso
    // aqui é reforço de 35% do score, não a busca inteira — colisão ocasional
    // pesa muito menos que não achar "corre" quando a query tem "correu".
    if (/[bcdfghjklmnpqrstvxz][eo]$/.test(p) && p.length >= 5) p = p.slice(0, -1);
    return p;
}
function tokenizarBm25(texto) {
    const palavras = (texto || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    return palavras.filter((w) => w.length > 1 && !STOPWORDS_PT.has(removerAcentos(w))).map(radicalPtBr);
}
// candidatos: [{id, texto}]. Devolve Map(id → score bruto, não normalizado).
function calcularBM25(consulta, candidatos, { k1 = 1.5, b = 0.75 } = {}) {
    const scores = new Map();
    const N = candidatos.length;
    if (!N) return scores;
    const queryTokens = [...new Set(tokenizarBm25(consulta))];
    if (!queryTokens.length) return scores;

    const docs = candidatos.map((c) => ({ id: c.id, tokens: tokenizarBm25(c.texto) }));
    const avgdl = docs.reduce((s, d) => s + d.tokens.length, 0) / N || 1;
    const df = new Map();
    for (const doc of docs) { for (const t of new Set(doc.tokens)) df.set(t, (df.get(t) || 0) + 1); }

    for (const doc of docs) {
        const freq = new Map();
        for (const t of doc.tokens) freq.set(t, (freq.get(t) || 0) + 1);
        let score = 0;
        for (const qt of queryTokens) {
            const f = freq.get(qt) || 0;
            if (!f) continue;
            const n = df.get(qt) || 0;
            const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
            score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (doc.tokens.length / avgdl)));
        }
        scores.set(doc.id, score);
    }
    return scores;
}
function minMax(map) {
    const vals = [...map.values()];
    if (!vals.length) return new Map();
    const min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1;
    return new Map([...map.entries()].map(([k, v]) => [k, (v - min) / span]));
}
// Combina cosine (semântico) com BM25 (termo exato) — pesa mais pro cosine
// de propósito: BM25 aqui é reforço pra nome próprio/termo raro que
// embedding generaliza demais, não deveria dominar o ranking sozinho.
const PESO_COSSENO = 0.65, PESO_BM25 = 0.35;
function combinarHibrido(cosineMap, bm25Map) {
    const bm25Norm = minMax(bm25Map);
    const out = new Map();
    for (const [id, cos] of cosineMap.entries()) out.set(id, PESO_COSSENO * cos + PESO_BM25 * (bm25Norm.get(id) || 0));
    return out;
}

// ====================================
// RERANK — uma chamada só (não uma por candidato) reordena um punhado de
// candidatos já filtrados por relevância matemática, usando leitura real
// em vez de só matemática de vetor. spade-rag.md seção 8.
// ====================================
async function rerank(candidatos, consulta) {
    if (candidatos.length <= 1) return candidatos;
    const lista = candidatos.map((c, i) => (i + 1) + '. [' + c.tipo + '] ' + c.texto.slice(0, 200)).join('\n');
    const prompt = 'Cena/consulta atual:\n' + consulta.slice(0, 500) + '\n\nTrechos candidatos, numerados:\n' + lista +
        '\n\nReordene do MAIS pro MENOS útil de ler agora pra essa cena especificamente — não é só parecido no texto, ' +
        'é o que realmente ajuda a responder bem nesse momento. Responda só os números separados por vírgula, na ' +
        'ordem nova, todos os ' + candidatos.length + ' números uma vez cada, sem texto a mais. Ex: 3,1,4,2';
    let resp;
    try { resp = await generate(getConfig().modeloRapido, [{ role: 'user', content: prompt }], { maxTokens: 150, timeoutMs: 10000 }); }
    catch (e) { console.warn('[rerank] falhou, mantendo ordem original:', e.message); return candidatos; }
    const ordem = (resp.match(/\d+/g) || []).map(Number).filter((n) => n >= 1 && n <= candidatos.length);
    if (ordem.length < candidatos.length * 0.6) return candidatos; // resposta ruim/incompleta — não confia, mantém ordem original
    const vistos = new Set(), reordenado = [];
    for (const n of ordem) { if (!vistos.has(n)) { vistos.add(n); reordenado.push(candidatos[n - 1]); } }
    for (let i = 0; i < candidatos.length; i++) { if (!vistos.has(i + 1)) reordenado.push(candidatos[i]); }
    return reordenado;
}

// Não-streaming — etapas auxiliares (cantos, classificação, tools). Modelo
// pode ser "flash" ou "writer" conforme quem chama decidir (Pro pra
// decisão/criação de verdade, Flash pra tarefa mecânica).
// Retry automático — erro de rede/resposta vazia não pode deixar ela
// "parada"; tenta de novo sozinha (com espera curta) antes de desistir de
// vez. É isso que "não parar quando dá erro" significa de verdade.
async function comRetentativas(fn, { tentativas = 3, esperaMs = 1200 } = {}) {
    let ultimoErro;
    for (let i = 0; i < tentativas; i++) {
        try { return await fn(); }
        catch (e) {
            ultimoErro = e;
            if (i < tentativas - 1) await new Promise((r) => setTimeout(r, esperaMs * (i + 1)));
        }
    }
    throw ultimoErro;
}

async function generate(model, messages, opts = {}) {
    return comRetentativas(async () => {
        const timeoutMs = opts.timeoutMs ?? 20000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const resp = await fetch(NANOGPT_BASE + '/chat/completions', {
                method: 'POST',
                headers: nanogptHeaders(),
                signal: anySignal([controller.signal, opts.signal]),
                body: JSON.stringify({
                    model, messages,
                    max_tokens: opts.maxTokens ?? 800,
                    temperature: opts.temperature ?? 0.85,
                }),
            });
            if (!resp.ok) throw new Error('NanoGPT (' + resp.status + '): ' + (await resp.text()).slice(0, 300));
            const data = await resp.json();
            const choice = data.choices?.[0];
            const content = choice?.message?.content ?? '';
            if (!content.trim() && choice?.finish_reason === 'length') throw new Error('voltou vazio (max_tokens estourou antes de qualquer texto) — tentando de novo');
            return content;
        } finally {
            clearTimeout(timer);
        }
    });
}

// Function calling — uma rodada só, devolve texto E tool_calls juntos (é
// isso que dá pra IA narrar ANTES de agir, no mesmo turno — ver ticker).
async function generateWithTools(model, messages, tools, opts = {}) {
    return comRetentativas(async () => {
        const timeoutMs = opts.timeoutMs ?? 30000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const resp = await fetch(NANOGPT_BASE + '/chat/completions', {
                method: 'POST',
                headers: nanogptHeaders(),
                signal: anySignal([controller.signal, opts.signal]),
                body: JSON.stringify({
                    model, messages, tools,
                    tool_choice: opts.toolChoice ?? 'auto',
                    max_tokens: opts.maxTokens ?? 1000,
                    temperature: opts.temperature ?? 0.8,
                }),
            });
            if (!resp.ok) throw new Error('NanoGPT (' + resp.status + '): ' + (await resp.text()).slice(0, 300));
            const data = await resp.json();
            const choice = data.choices?.[0];
            return {
                content: choice?.message?.content ?? '',
                toolCalls: choice?.message?.tool_calls ?? [],
                finishReason: choice?.finish_reason,
            };
        } finally {
            clearTimeout(timer);
        }
    });
}

// Streaming de verdade — SSE manual via fetch()+getReader(). Watchdog
// manual (mesma lógica do nanogpt.js original): reseta a cada token real
// que chega, só aborta se ficar REALMENTE parado.
async function generateStream(model, messages, onToken, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 45000;
    const watchdogController = new AbortController();
    let watchdog = setTimeout(() => watchdogController.abort(), timeoutMs);
    function resetWatchdog() { clearTimeout(watchdog); watchdog = setTimeout(() => watchdogController.abort(), timeoutMs); }

    const combined = anySignal([watchdogController.signal, opts.signal]);
    let full = '';
    try {
        const resp = await fetch(NANOGPT_BASE + '/chat/completions', {
            method: 'POST',
            headers: nanogptHeaders(),
            signal: combined,
            body: JSON.stringify({
                model, messages,
                max_tokens: opts.maxTokens ?? 1200,
                temperature: opts.temperature ?? 0.85,
                stream: true,
            }),
        });
        if (!resp.ok) throw new Error('NanoGPT (' + resp.status + '): ' + (await resp.text()).slice(0, 300));

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            resetWatchdog();
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // resto incompleto fica pra próxima volta
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const payload = trimmed.slice(5).trim();
                if (payload === '[DONE]') continue;
                let chunk;
                try { chunk = JSON.parse(payload); } catch (_) { continue; }
                const delta = chunk.choices?.[0]?.delta?.content;
                if (delta) { full += delta; onToken(delta); }
            }
        }
        return full;
    } catch (err) {
        if (watchdogController.signal.aborted && !opts.signal?.aborted) {
            throw new Error('Sem resposta da NanoGPT por ' + Math.round(timeoutMs / 1000) + 's — rede travada (não foi você interrompendo).');
        }
        throw err;
    } finally {
        clearTimeout(watchdog);
    }
}

// ====================================
// BIBLIOTECA — um store só, duas formas de buscar. `tipo === 'fala'` ou
// `'tom'` cai no caminho de VOZ (MMR — prioriza variedade, nunca "expira").
// Qualquer outro tipo cai no caminho de MEMÓRIA (recência + relevância +
// importância, com validade temporal — fato que muda vira substituição,
// não bagunça, e `sabemDisso` decide quem tem acesso a cada entrada). Isso
// SUBSTITUI o que antes seriam APIs separadas (Perfil fixo, Falas, Cenas,
// memória por comando) — é o mesmo mecanismo pra tudo, só muda a etiqueta
// `tipo` e por qual caminho a busca passa.
//
// Campos novos em toda entrada: importancia (0–1), ultimoAcesso, acessos,
// validoDesde/validoAte (null = ainda vale), substituiId, entidades,
// sabemDisso (default: só o personagem que escreveu).
// ====================================

// Tipos "automáticos" — escritos toda rodada sem decisão deliberada da IA
// (cena) ou por chaveFixa de alta frequência (estado_interno). Não passam
// pelo embedding contextual: o custo de 1 chamada de LLM a mais por rodada
// não compensa aqui. Contexto é pra escrita deliberada (sincronização de
// artefato pra Biblioteca), não pro log automático de cada turno.
// 'aprendizado_sistema' entra aqui também (etapa 3, auto-estudo) — escrita
// automática a cada sistema_real_testar/publicar, o texto já carrega
// hookAlvo+resultado+trecho de código; gerar 1 frase de contexto por LLM
// em cima disso custaria uma chamada extra por iteração do Reflexion sem
// ganho real.
const TIPOS_SEM_CONTEXTO = ['evento_cru', 'estado_interno', 'fala', 'tom', 'aprendizado_sistema'];

async function gerarContextoEmbed(texto) {
    try {
        const cfg = getConfig();
        const contexto = await generate(cfg.modeloRapido, [
            { role: 'system', content: 'Em 1 frase curta (até 20 palavras), situe este trecho: de onde veio, quem estava envolvido, o que motivou. Responda só a frase, sem preâmbulo, sem aspas.' },
            { role: 'user', content: texto },
        ], { maxTokens: 60, temperature: 0.3, timeoutMs: 12000 });
        return contexto?.trim() || '';
    } catch (_) { return ''; } // segue sem contexto se a chamada falhar — não trava a escrita
}

const Biblioteca = {
    // `personagem` opcional — override explícito (etapa 3: auto-estudo
    // escreve em ESCOPO_AUTOESTUDO, ignorando personagemAtual()). Omitido =
    // comportamento de sempre.
    // `personagem` opcional — override explícito (etapa 3: auto-estudo
    // escreve em ESCOPO_AUTOESTUDO, ignorando personagemAtual()). Omitido =
    // comportamento de sempre. `embedding` opcional — se quem chama já
    // calculou o vetor certo (ex: Ingestão, que contextualiza o fato ANTES
    // de embedar do jeito dela, diferente do gerarContextoEmbed daqui),
    // usa esse direto em vez de recalcular — evita embedar 2x com contextos
    // diferentes (o vetor salvo ficaria diferente do que decidiu duplicata/
    // substitui, quebrando a consistência do dedupe).
    async escrever({ tipo, texto, metadata = {}, chaveFixa = null, sabemDisso = null, importancia = 0.5, entidades = [], substitui = null, personagem: personagemOverride = null, embedding: embeddingPreCalculado = null }) {
        if (!texto?.trim()) throw new Error('texto vazio.');
        const personagem = personagemOverride || personagemAtual();
        const textoLimpo = texto.trim();
        // chaveFixa: usado por escritas automáticas (ex: estado_interno) que
        // devem ATUALIZAR uma entrada, não acumular infinitas — se vier, o id
        // é determinístico em vez de aleatório.
        const id = chaveFixa ? ('fixo-' + personagem + '-' + chaveFixa) : newId();

        // Embedding contextual — ver spade-rag.md seção 6. Uma frase situando
        // o trecho ANTES de embedar, pra o vetor não ficar órfão de contexto
        // de cena. Só pra escrita deliberada (ver TIPOS_SEM_CONTEXTO acima).
        // Pulado inteiro se `embedding` já veio pronto de fora.
        let embedding = embeddingPreCalculado;
        if (embedding == null) {
            let textoParaEmbed = textoLimpo;
            if (!TIPOS_SEM_CONTEXTO.includes(tipo)) {
                const contexto = await gerarContextoEmbed(textoLimpo);
                if (contexto) textoParaEmbed = contexto + '\n' + textoLimpo;
            }
            // bge-m3 aguenta 8192 tokens (~30 mil caracteres em PT) — 4000 sobrava
            // margem sem necessidade real.
            try { embedding = await embedNanoGPT(textoParaEmbed.slice(0, 8000)); } catch (e) { console.warn('[biblioteca] embedding falhou, entrada fica sem busca semântica:', e.message); }
        }

        // ativo — usado principalmente pelas entradas tipo "tom" (treino de
        // voz): dá pra ter referência guardada mas DESLIGADA da cena atual,
        // sem precisar apagar. undefined conta como ativo (default true).
        const metadataFinal = Object.assign({ ativo: true }, metadata);
        const agora = Date.now();
        const entry = {
            id, tipo, texto: textoLimpo, embedding, metadata: metadataFinal, personagem,
            createdAt: agora, updatedAt: agora,
            importancia: Math.max(0, Math.min(1, importancia)),
            ultimoAcesso: agora,
            acessos: 0,
            validoDesde: agora,
            validoAte: null,
            substituiId: substitui || null,
            entidades,
            sabemDisso: (sabemDisso && sabemDisso.length) ? sabemDisso : [personagem],
        };

        // Fato que substitui fato — o antigo não é deletado, só sai do pool
        // ativo (validoAte marcado). Ver spade-rag.md seção 5.
        if (substitui) {
            const antigo = await idbGet('biblioteca', substitui);
            if (antigo && antigo.validoAte == null) {
                antigo.validoAte = agora;
                await idbPut('biblioteca', antigo);
            }
        }

        await idbPut('biblioteca', entry);
        return entry;
    },
    async editar({ id, texto }) {
        const atual = await idbGet('biblioteca', id);
        if (!atual) throw new Error('Entrada não encontrada: ' + id);
        let embedding = atual.embedding;
        try { embedding = await embedNanoGPT(texto.slice(0, 8000)); } catch (_) { /* mantém embedding antigo se falhar */ }
        const entry = Object.assign({}, atual, { texto: texto.trim(), embedding, updatedAt: Date.now() });
        await idbPut('biblioteca', entry);
        return entry;
    },
    async apagar({ id }) {
        await idbDelete('biblioteca', id);
        return { ok: true };
    },
    // `personagem` opcional — mesma lógica de override de escrever() acima.
    async listar({ tipos, personagem } = {}) {
        const all = await idbAllByPersonagem('biblioteca', personagem || personagemAtual());
        const filtered = tipos?.length ? all.filter((e) => tipos.includes(e.tipo)) : all;
        return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
    },
    // Upload de arquivo — chunk + embed em LOTE (uma chamada de API pra N
    // chunks, não N chamadas — a NanoGPT aceita array em `input`). `tipo`
    // deixa reaproveitar isso tanto pra Biblioteca geral ("documento") quanto
    // pro Treino de Tom ("tom"). Sem embedding contextual aqui de propósito —
    // contextualizar chunk-a-chunk num upload de N chunks seria N chamadas de
    // LLM de uma vez; fica pra quando a extração/consolidação existir.
    async subirArquivo(nomeArquivo, textoCompleto, onProgress, tipo = 'documento') {
        const chunks = chunkText(textoCompleto, 700, 80);
        if (!chunks.length) return { chunks: 0 };
        const embeddings = await embedNanoGPT(chunks.map((c) => c.slice(0, 8000)));
        const personagem = personagemAtual();
        const agora = Date.now();
        for (let i = 0; i < chunks.length; i++) {
            await idbPut('biblioteca', {
                id: newId(), tipo, texto: chunks[i],
                embedding: embeddings[i] || null,
                metadata: { arquivo: nomeArquivo, chunk: i + 1, deChunks: chunks.length, ativo: true },
                personagem, createdAt: agora, updatedAt: agora,
                importancia: 0.5, ultimoAcesso: agora, acessos: 0,
                validoDesde: agora, validoAte: null, substituiId: null,
                entidades: [], sabemDisso: [personagem],
            });
            if (onProgress) onProgress(i + 1, chunks.length);
        }
        return { chunks: chunks.length };
    },
    async definirAtivo(id, ativo) {
        const atual = await idbGet('biblioteca', id);
        if (!atual) throw new Error('Entrada não encontrada: ' + id);
        atual.metadata = Object.assign({}, atual.metadata, { ativo: !!ativo });
        atual.updatedAt = Date.now();
        await idbPut('biblioteca', atual);
        return atual;
    },
    // Documento é N chunks com o mesmo metadata.arquivo — editar/apagar
    // "o documento" precisa tratar isso como UMA coisa, não N entradas
    // soltas (senão editar vira "edita só o pedaço 1 de 6", que é exatamente
    // o tipo de coisa fragmentada e nada profissional que a folha devia
    // evitar). Reconstrói do zero: apaga os chunks velhos, chunka+embeda o
    // texto novo inteiro, escreve nos mesmos moldes de guardarDocumentoBruto.
    // Lê o documento INTEIRO, em ordem — sem depender de busca semântica
    // fuzzy pra juntar os pedaços certos. É o que faltava pro loop
    // ler→editar não travar em documento que a busca não achasse bem.
    async lerDocumento(nomeArquivo) {
        const personagem = personagemAtual();
        const chunks = (await this.listar({ tipos: ['documento'], personagem }))
            .filter((e) => e.metadata?.arquivo === nomeArquivo)
            .sort((a, b) => (a.metadata?.chunk || 0) - (b.metadata?.chunk || 0));
        if (!chunks.length) return { encontrado: false };
        return { encontrado: true, texto: chunks.map((c) => c.texto).join('\n\n'), chunks: chunks.length };
    },
    async editarDocumento(nomeArquivo, novoTexto) {
        const personagem = personagemAtual();
        const antigos = (await this.listar({ tipos: ['documento'], personagem }))
            .filter((e) => e.metadata?.arquivo === nomeArquivo);
        for (const e of antigos) await idbDelete('biblioteca', e.id);
        const chunks = await guardarDocumentoBruto(nomeArquivo, novoTexto);
        return { arquivoAntigo: antigos.length, chunksNovo: chunks };
    },
    async apagarDocumento(nomeArquivo) {
        const personagem = personagemAtual();
        const entradas = (await this.listar({ tipos: ['documento'], personagem }))
            .filter((e) => e.metadata?.arquivo === nomeArquivo);
        for (const e of entradas) await idbDelete('biblioteca', e.id);
        return { apagados: entradas.length };
    },
    // Marca que `nomePersonagem` passou a saber dessa entrada — resolve o
    // "problema do bartender" (NPC sabendo segredo que nunca foi contado pra
    // ele). Não é automático: a IA decide chamar isso quando narra a
    // revelação. Ver spade-rag.md seção 2.
    async compartilhar(id, nomePersonagem) {
        if (!nomePersonagem?.trim()) throw new Error('nome vazio.');
        const atual = await idbGet('biblioteca', id);
        if (!atual) throw new Error('Entrada não encontrada: ' + id);
        const jaSabe = new Set(atual.sabemDisso || [personagemAtual()]);
        jaSabe.add(nomePersonagem.trim());
        atual.sabemDisso = [...jaSabe];
        await idbPut('biblioteca', atual);
        return atual;
    },
    // Busca de VOZ — MMR (Carbonell & Goldstein) sobre um score HÍBRIDO
    // (cosine 65% + BM25 35% — seção 7), com rerank (seção 8) no lote pré-
    // final. Corta a piada reciclada 5x que o cosine puro trazia, e agora
    // também acerta nome próprio/termo exato que embedding generaliza
    // demais. Ver spade-rag.md seções 3, 7, 8.
    async buscarVoz(consulta, { tipos = ['fala', 'tom'], k = 5, lambda = 0.7 } = {}) {
        if (!consulta?.trim()) return [];
        const all = (await this.listar({ tipos })).filter((e) => e.metadata?.ativo !== false && e.embedding);
        if (!all.length) return [];
        let qEmb;
        try { qEmb = await embedNanoGPT(consulta.slice(0, 8000)); } catch (e) { console.warn('[biblioteca] busca de voz sem embedding:', e.message); return []; }
        if (!qEmb) return [];

        const cosineMap = new Map(all.map((e) => [e.id, cosineSim(qEmb, e.embedding)]));
        const hibridoMap = combinarHibrido(cosineMap, calcularBM25(consulta, all));

        // top-40 por score híbrido primeiro — teto de performance, não de
        // qualidade, evita rodar MMR par-a-par sobre a biblioteca inteira.
        const candidatos = all
            .map((e) => ({ ...e, sim1: hibridoMap.get(e.id) ?? 0, simCrua: cosineMap.get(e.id) ?? 0 }))
            .sort((a, b) => b.sim1 - a.sim1)
            .slice(0, 40);
        if (!candidatos.length) return [];

        // MMR seleciona um lote maior que k (até ~20) — dá material de
        // verdade pro rerank trabalhar em cima, não só os k finais direto
        // (spade-rag.md seção 8: "reduz pra 15-20, DEPOIS reordena").
        const alvoPreRerank = Math.min(20, all.length);
        const selecionados = [candidatos.shift()];
        selecionados[0].score = selecionados[0].sim1;
        while (selecionados.length < alvoPreRerank && candidatos.length) {
            let melhorIdx = -1, melhorScore = -Infinity;
            for (let i = 0; i < candidatos.length; i++) {
                const cand = candidatos[i];
                let penalidade = -Infinity;
                for (const s of selecionados) penalidade = Math.max(penalidade, cosineSim(cand.embedding, s.embedding));
                const score = lambda * cand.sim1 - (1 - lambda) * penalidade;
                if (score > melhorScore) { melhorScore = score; melhorIdx = i; }
            }
            const escolhido = candidatos.splice(melhorIdx, 1)[0];
            escolhido.score = melhorScore;
            selecionados.push(escolhido);
        }
        // Piso de qualidade em cima do cosine PURO, não do híbrido — BM25
        // pode inflar um termo repetido que o embedding acha irrelevante;
        // quem decide "isso é bom o bastante pra aparecer" é o semântico.
        const prime = selecionados.filter((e) => e.simCrua > 0.3);
        if (prime.length <= k) return prime;
        const reordenado = await rerank(prime, consulta);
        return reordenado.slice(0, k);
    },
    // Busca de MEMÓRIA — score composto (Park et al., Generative Agents):
    // recência (decaimento 0.995/hora) + relevância HÍBRIDA (cosine+BM25,
    // seção 7) normalizada + importância (salva na escrita). `validoAte`
    // filtra fato substituído pra fora; `evento_cru` fica de fora até
    // passar pela consolidação (seção 9); `sabemDisso` filtra quem não tem
    // acesso. Lote pré-final vai pro rerank (seção 8) antes do corte em k.
    // Puxar uma entrada reforça a importância dela em +5%, capado — NÃO
    // tirar esse teto, é o que impede o score de divergir. Ver spade-rag.md
    // seção 4.
    // `personagem` opcional — escopo de QUEM escreveu (override de
    // personagemAtual(), etapa 3). `paraPersonagem` continua sendo o alvo
    // do filtro sabemDisso (perspectiva de NPC); se não vier, cai no mesmo
    // escopo por padrão — igual já era quando nenhum dos dois é passado.
    async buscarMemoria(consulta, { tipos = null, paraPersonagem = null, personagem = null, k = 8 } = {}) {
        if (!consulta?.trim()) return [];
        const escopo = personagem || personagemAtual();
        const alvo = paraPersonagem || escopo;
        const all = await this.listar({ tipos, personagem: escopo });
        const candidatos = all.filter((e) =>
            !['fala', 'tom', 'evento_cru'].includes(e.tipo) &&
            e.metadata?.ativo !== false &&
            e.embedding &&
            (e.validoAte == null) &&
            (!e.sabemDisso || e.sabemDisso.includes(alvo))
        );
        if (!candidatos.length) return [];

        let qEmb;
        try { qEmb = await embedNanoGPT(consulta.slice(0, 8000)); } catch (e) { console.warn('[biblioteca] busca de memória sem embedding:', e.message); return []; }
        if (!qEmb) return [];

        const cosineMap = new Map(candidatos.map((e) => [e.id, cosineSim(qEmb, e.embedding)]));
        const hibridoMap = combinarHibrido(cosineMap, calcularBM25(consulta, candidatos));

        const agora = Date.now();
        const brutos = candidatos.map((e) => ({
            e,
            recencia: Math.pow(0.995, (agora - (e.ultimoAcesso || e.createdAt)) / 3_600_000),
            relevanciaHibrida: hibridoMap.get(e.id) ?? 0,
            cosineCru: cosineMap.get(e.id) ?? 0,
        }));
        let min = Infinity, max = -Infinity;
        for (const b of brutos) { if (b.relevanciaHibrida < min) min = b.relevanciaHibrida; if (b.relevanciaHibrida > max) max = b.relevanciaHibrida; }
        const span = (max - min) || 1;

        const pontuados = brutos
            .map((b) => {
                const relevancia = (b.relevanciaHibrida - min) / span;
                const importancia = b.e.importancia ?? 0.5;
                return { ...b.e, score: b.recencia + relevancia + importancia, cosineCru: b.cosineCru, hibridoCru: b.relevanciaHibrida };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, Math.min(20, brutos.length)); // lote maior antes do rerank — mesma lógica da voz

        // Piso — cosine cru OU híbrido cru (BM25 pesa aqui). Documento cru
        // (guardarDocumentoBruto) nunca passa pelo embedding contextual, então
        // um chunk de 900 caracteres com o termo EXATO dentro pode ter cosine
        // baixo mesmo assim — antes isso descartava o chunk mesmo o BM25
        // achando o termo certinho. Bug real: "testerp"/"Hanna" batendo no
        // texto mas nunca aparecendo em artefato_buscar.
        const prime = pontuados.filter((e) => e.cosineCru > 0.15 || e.hibridoCru > 0.15);
        const finalSet = prime.length <= k ? prime : (await rerank(prime, consulta)).slice(0, k);

        // reforço no que REALMENTE volta — persiste no banco, não só no
        // objeto em memória. Roda depois do rerank de propósito: reforçar
        // algo que o rerank descartou não faz sentido.
        for (const item of finalSet) {
            const atual = await idbGet('biblioteca', item.id);
            if (!atual) continue;
            atual.ultimoAcesso = agora;
            atual.acessos = (atual.acessos || 0) + 1;
            atual.importancia = Math.min((atual.importancia ?? 0.5) * 1.05, 1); // teto — não remover
            await idbPut('biblioteca', atual);
        }
        return finalSet;
    },
    // Ponto de entrada genérico (usado pelo bridge de SDK dos Sistemas
    // Reais, biblioteca.buscar — artefato_buscar usa buscarArtefatos, que
    // combina buscarVoz+buscarMemoria direto) — decide sozinho qual dos
    // dois caminhos usar conforme `tipos` pedido, ou roda os dois se não
    // filtrar por tipo.
    async buscar({ consulta, tipos = null, k = 6, paraNpc = null }) {
        if (!consulta?.trim()) return [];
        const paraPersonagem = paraNpc || personagemAtual();
        const pedeVoz = tipos ? tipos.some((t) => t === 'fala' || t === 'tom') : true;
        const pedeMemoria = tipos ? tipos.some((t) => t !== 'fala' && t !== 'tom') : true;
        let resultados = [];
        if (pedeVoz) {
            const tiposVoz = tipos ? tipos.filter((t) => t === 'fala' || t === 'tom') : ['fala', 'tom'];
            resultados = resultados.concat(await this.buscarVoz(consulta, { tipos: tiposVoz, k: Math.min(k, 5) }));
        }
        if (pedeMemoria) {
            const tiposMem = tipos ? tipos.filter((t) => t !== 'fala' && t !== 'tom') : null;
            resultados = resultados.concat(await this.buscarMemoria(consulta, { tipos: tiposMem, paraPersonagem, k }));
        }
        return resultados.slice(0, k);
    },
};

// ====================================
// INGESTÃO — pipeline de upload com curadoria (substitui o upload cego que
// a aba Biblioteca usava antes: Biblioteca.subirArquivo, chunk fixo + embed
// direto, sem decidir o que vale guardar). Reusa 100% a Biblioteca acima —
// não é uma segunda estrutura de dado, só decide O QUE escrever nela.
//
// Pipeline: lerArquivo (roteia por tipo, PNG de character card V2/V3 vira
// campo estruturado, foto vira descrição via visão) → segmentar (por
// parágrafo, ou por campo se já veio de character card) → extrairLote (1
// chamada de IA por lote de ~6 segmentos decide o que vale guardar,
// reescreve autocontido, categoria LIVRE, marca usos[]) → contextualizarFato
// (Contextual Retrieval da Anthropic — só roda se o fato tiver referência
// solta) → decidirContraExistentes (cosseno bruto primeiro, LLM só na faixa
// ambígua, estilo Mem0) → Biblioteca.escrever.
//
// Deliberadamente fora (não é lacuna por acidente): PDF/DOCX sem lib
// externa, grafo de relação entre fatos, chunking hierárquico pai/filho
// (a contextualização + reescrita autocontida já resolvem o mesmo problema
// mais barato, pro tamanho de documento que essa extensão recebe).
//
// Treino de Tom (aba/chat separados, caminho antigo Biblioteca.subirArquivo)
// foi RETIRADO — referência de tom agora entra pela Ingestão como qualquer
// outro arquivo/foto, marcada usos:['tom'] pela própria extração. Vai
// voltar como parte do mini-chat de perfil, sessão futura.
// ====================================
// ====================================
// PNG — leitura de chunk tEXt, sem biblioteca. Spec pública (PNG 1.2) +
// formato de character card do SillyTavern (V2 keyword "chara", V3 keyword
// "ccv3" — prefere V3 se os dois vierem, mesma regra que o próprio ST usa).
// ====================================
const PNG_ASSINATURA = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

function lerChunksPng(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < 8 || !PNG_ASSINATURA.every((b, i) => b === bytes[i])) {
        throw new Error('não é um PNG válido (assinatura não bate).');
    }
    const chunks = [];
    let offset = 8;
    while (offset + 8 <= arrayBuffer.byteLength) {
        const length = view.getUint32(offset, false); // PNG é big-endian
        const tipo = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        const dataStart = offset + 8;
        if (dataStart + length > arrayBuffer.byteLength) break; // arquivo truncado — para sem lançar
        const data = bytes.slice(dataStart, dataStart + length);
        chunks.push({ tipo, data });
        offset = dataStart + length + 4; // +4 = pula o CRC, não precisamos validar pra só LER
        if (tipo === 'IEND') break;
    }
    return chunks;
}

// tEXt = "palavra-chave\0conteúdo", ambos Latin-1 na spec — mas o conteúdo
// de character card é base64 de UTF-8, então decodifica em duas etapas.
function decodificarTextChunk(data) {
    const nulPos = data.indexOf(0);
    if (nulPos === -1) return null;
    const chars = [];
    for (let i = 0; i < nulPos; i++) chars.push(String.fromCharCode(data[i]));
    const keyword = chars.join('');
    const valorBytes = data.slice(nulPos + 1);
    let valorLatin1 = '';
    for (let i = 0; i < valorBytes.length; i++) valorLatin1 += String.fromCharCode(valorBytes[i]);
    return { keyword, valorLatin1 };
}

function base64ParaUtf8(base64) {
    const binario = atob(base64);
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
}

// Devolve o JSON do character card (V3 tem prioridade sobre V2, igual o
// próprio SillyTavern faz), ou null se o PNG não tiver nenhum dos dois —
// nesse caso é só uma imagem normal, quem chamou decide o que fazer (cai
// pro caminho de visão genérica).
function extrairCharacterCardDePng(arrayBuffer) {
    let chunks;
    try { chunks = lerChunksPng(arrayBuffer); } catch (e) { return null; }
    let v2 = null, v3 = null;
    for (const chunk of chunks) {
        if (chunk.tipo !== 'tEXt') continue;
        const decodificado = decodificarTextChunk(chunk.data);
        if (!decodificado) continue;
        if (decodificado.keyword === 'chara') v2 = decodificado.valorLatin1;
        if (decodificado.keyword === 'ccv3') v3 = decodificado.valorLatin1;
    }
    const base64Escolhido = v3 || v2;
    if (!base64Escolhido) return null;
    try {
        const json = JSON.parse(base64ParaUtf8(base64Escolhido));
        return { versao: v3 ? 'v3' : 'v2', dados: json };
    } catch (e) {
        console.warn('[Ingestão] PNG tinha chunk de character card mas o JSON não abriu:', e.message);
        return null;
    }
}

// ====================================
// ROTEADOR DE ARQUIVO — qualquer tipo, foto junto. Honesto sobre o que não
// dá: PDF/DOCX não têm extração de texto client-side sem biblioteca externa
// (contrariaria "nada externo") — fica de fora por enquanto, sinalizado,
// não mascarado como binário lido errado.
// ====================================
const EXTENSOES_TEXTO = ['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.yaml', '.yml', '.log'];

function pareceTexto(file) {
    if (file.type?.startsWith('text/')) return true;
    if (file.type === 'application/json') return true;
    const nome = file.name.toLowerCase();
    return EXTENSOES_TEXTO.some((ext) => nome.endsWith(ext));
}

// Devolve { ok, tipo: 'texto'|'character_card'|'imagem', titulo, conteudo }
// — `conteudo` já é TEXTO em todos os casos (imagem vira descrição via
// visão; character card vira os campos formatados; texto é o próprio
// arquivo). Isso deixa a segmentação (próxima etapa) cega a modalidade —
// mesmo pipeline pra tudo depois desse ponto, que é o "conjunto" que junta
// as técnicas em vez de tratar cada tipo com um caminho todo separado.
async function lerArquivo(file) {
    const nome = file.name;

    if (file.type === 'image/png' || nome.toLowerCase().endsWith('.png')) {
        const buffer = await file.arrayBuffer();
        const card = extrairCharacterCardDePng(buffer);
        if (card) {
            const d = card.dados.data || card.dados; // V1 antigo não tem wrapper "data"
            const campos = [
                ['Nome', d.name], ['Descrição', d.description], ['Personalidade', d.personality],
                ['Cenário', d.scenario], ['Primeira mensagem', d.first_mes], ['Exemplo de diálogo', d.mes_example],
                ['Notas do criador', d.creator_notes], ['Tags', Array.isArray(d.tags) ? d.tags.join(', ') : d.tags],
            ].filter(([, v]) => v && String(v).trim());
            const conteudo = campos.map(([rotulo, v]) => rotulo + ': ' + v).join('\n\n');
            return { ok: true, tipo: 'character_card', titulo: (d.name || nome) + ' (character card ' + card.versao + ')', conteudo };
        }
        // PNG sem chunk de card — é só imagem, cai pro caminho de visão abaixo
    }

    if (file.type.startsWith('image/')) {
        return { ok: true, tipo: 'imagem', titulo: nome, conteudo: null, arquivoOriginal: file }; // conteúdo vira texto na etapa de extração (precisa do modelo de visão)
    }

    if (pareceTexto(file)) {
        const texto = await file.text();
        return { ok: true, tipo: 'texto', titulo: nome, conteudo: texto };
    }

    return { ok: false, tipo: 'nao_suportado', titulo: nome, motivo: 'Tipo de arquivo ainda não suportado sem servidor/biblioteca externa (ex: PDF, DOCX). Converte pra .txt/.md antes de subir, ou manda print/foto da página.' };
}

// ====================================
// SEGMENTAÇÃO — parágrafo-aware, não corte cego de caractere. Se o
// conteúdo já vier estruturado (character card: campo por campo), cada
// campo VIRA um segmento sozinho — fronteira melhor que qualquer heurística
// de texto solto ia achar.
// ====================================
function segmentarTextoLivre(texto, alvoChars = 900) {
    const paragrafos = (texto || '').replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    if (!paragrafos.length) return [];
    const segmentos = [];
    let atual = '';
    for (const p of paragrafos) {
        if (atual && (atual.length + p.length + 2) > alvoChars * 1.4) { segmentos.push(atual); atual = p; }
        else atual = atual ? atual + '\n\n' + p : p;
        if (atual.length >= alvoChars) { segmentos.push(atual); atual = ''; }
    }
    if (atual) segmentos.push(atual);
    return segmentos;
}
function segmentar(lido) {
    if (lido.tipo === 'character_card') {
        // já veio formatado "Rótulo: valor\n\nRótulo: valor" — cada bloco é um campo
        return lido.conteudo.split(/\n\n(?=[A-ZÀ-Ú])/).map((s) => s.trim()).filter(Boolean);
    }
    return segmentarTextoLivre(lido.conteudo, 900);
}

// ====================================
// EXTRAÇÃO — 1 chamada por LOTE de segmentos (não 1 por segmento — custo),
// a IA decide o que vale guardar, reescreve autocontido (resolve o
// problema clássico de "esse pedaço fala 'ele' e ninguém sabe quem"),
// classifica com categoria LIVRE (não enum travado — é o "dinâmico" pedido:
// categoria nova funciona sozinha, sem precisar mexer em código), e marca
// `usos` — pra quem além da busca normal isso pode servir.
// ====================================
const LOTE_EXTRACAO = 6; // segmentos por chamada — grande o bastante pra não virar 1 chamada por parágrafo, pequeno o bastante pra não estourar contexto/perder precisão

function parseJsonArraySeguro(texto) {
    const match = texto.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try { const arr = JSON.parse(match[0]); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

async function extrairLote(segmentos, contextoDocumento) {
    // FIX (v7.0.2): era modeloRapido (flash) — decidir o que vale virar
    // Artefato é julgamento de verdade, não tarefa mecânica; usa o
    // modeloEscritor (o mesmo, mais capaz, já usado no RP/Espaço).
    const { modeloEscritor } = getConfig();
    const listaNumerada = segmentos.map((s, i) => (i + 1) + '. ' + s.slice(0, 900)).join('\n\n');
    const prompt =
        'Documento de origem: "' + contextoDocumento.titulo + '" (tipo: ' + contextoDocumento.tipo + ')\n\n' +
        'Trechos numerados:\n' + listaNumerada + '\n\n' +
        'Pra CADA trecho, decida se vale guardar como conhecimento reutilizável depois — NÃO guarde conversa fiada, ' +
        'redundância óbvia com o resto do mesmo documento, ou coisa vaga demais pra ser útil sozinha. Se valer, ' +
        'inclua um item; se não valer, pule esse número (não force um item pra todo trecho).\n\n' +
        'Responda só um array JSON, um item por trecho que vale guardar:\n' +
        '[{"trecho": numero_do_trecho, ' +
        '"fato": "reescrito de forma objetiva e AUTOCONTIDA — sem pronome solto tipo \'ele\'/\'isso\' sem deixar claro quem/o que é, alguém lendo só essa frase precisa entender", ' +
        '"categoria": "sua escolha livre e curta, ex: traço_personalidade, evento_lore, regra_mundo, preferencia, exemplo_dialogo, aparencia, relacionamento, outro — invente uma nova se nenhuma dessas encaixar", ' +
        '"usos": ["perfil"] (array, pode ter mais de um entre: perfil, tom, sistemas, geral — "perfil"=quem ela é, "tom"=como ela fala, "sistemas"=dado que uma regra real pode consultar, "geral"=não se encaixa nos três mas vale guardar), ' +
        '"entidades": ["nomes de pessoas/lugares envolvidos, vazio se não tiver"], ' +
        '"confianca0a1": numero — quão claro/inequívoco isso estava no texto (baixo se você teve que inferir muito)}]\n' +
        'Se NENHUM trecho valer guardar, responda [].';
    let resp;
    try { resp = await generate(modeloEscritor, [{ role: 'user', content: prompt }], { maxTokens: 1400, temperature: 0.3, timeoutMs: 25000 }); }
    catch (e) { console.warn('[Ingestão] extração de lote falhou:', e.message); return []; }
    const itens = parseJsonArraySeguro(resp);
    return itens
        .filter((it) => it && it.fato && typeof it.trecho === 'number' && segmentos[it.trecho - 1])
        .map((it) => ({
            fato: String(it.fato).trim(),
            categoria: (it.categoria ? String(it.categoria).trim() : 'outro').toLowerCase().replace(/\s+/g, '_'),
            usos: Array.isArray(it.usos) ? it.usos.filter((u) => typeof u === 'string') : ['geral'],
            entidades: Array.isArray(it.entidades) ? it.entidades.filter((e) => typeof e === 'string') : [],
            confianca: Math.max(0, Math.min(1, Number(it.confianca0a1) ?? 0.6)),
            segmentoOriginal: segmentos[it.trecho - 1],
        }));
}

// ====================================
// CONTEXTUALIZAÇÃO — Contextual Retrieval (Anthropic, 2024): prefixa o fato
// com uma frase curta de ONDE ele se encaixa, gerada por LLM, ANTES de
// embedar. -49% falha de busca sozinho, -67% combinado com rerank (que a
// Biblioteca principal já faz). Só roda se o fato tiver pouco contexto
// óbvio sozinho — pula em fatos já claramente autocontidos, economiza
// chamada.
// ====================================
function pareceAutocontido(fato) {
    // Heurística barata, sem LLM: fato curto E sem pronome/referência solta
    // no início costuma já estar autocontido depois da extração (que já
    // pediu isso explicitamente). Só manda pro LLM quando há dúvida real.
    const inicioSuspeito = /^(ele|ela|eles|elas|isso|isto|aquilo|esse|essa|este|esta|também|além disso|por isso)\b/i;
    return fato.length < 200 && !inicioSuspeito.test(fato.trim());
}
async function contextualizarFato(item, contextoDocumento) {
    if (pareceAutocontido(item.fato)) return item.fato;
    const { modeloRapido } = getConfig();
    const prompt = 'Documento: "' + contextoDocumento.titulo + '"\nTrecho original de onde isso veio: "' +
        item.segmentoOriginal.slice(0, 400) + '"\nFato extraído: "' + item.fato + '"\n\n' +
        'Reescreva o fato numa frase só, autocontida, sem depender do trecho original pra fazer sentido — troca ' +
        'qualquer pronome/referência vaga por quem/o que ele realmente é. Só a frase, nada mais.';
    try {
        const resp = await generate(modeloRapido, [{ role: 'user', content: prompt }], { maxTokens: 200, temperature: 0.3, timeoutMs: 10000 });
        return resp.trim() || item.fato;
    } catch (e) {
        console.warn('[Ingestão] contextualização falhou, mantendo fato original:', e.message);
        return item.fato;
    }
}

// ====================================
// MERGE EM ARTEFATO (v6.10 — substitui o dedupe granular por cosseno) — a
// extração acima já decidiu O QUE vale guardar e classificou por
// categoria; aqui isso vira um ARTEFATO de verdade (documento organizado,
// visível/editável no painel de Artefatos), não uma pilha de fatos soltos
// tipo antes. Mesma categoria acumula no MESMO artefato entre uploads
// diferentes — sempre reescrito por inteiro (LLM incorpora o novo no que
// já existia), nunca um append cru. Isso é o que fecha "sem comandos,
// apenas fazendo": a organização/dedupe agora é uma decisão de PROSA (a
// IA decide o que entra reescrevendo o documento), não mais um score de
// similaridade decidindo por trás.
// ====================================
async function encontrarArtefatoPorCategoria(categoria) {
    try {
        const r = await chamarSpadeFs('/documento/listar', { personagem: personagemAtual() });
        return (r.documentos || []).find((d) => d.categoria === categoria) || null;
    } catch (e) { console.warn('[Ingestão] listar artefatos falhou:', e.message); return null; }
}
// Caminho único de escrita de artefato — usado tanto aqui (Ingestão) quanto
// pela tool artefato_escrever: salva no servidor E resincroniza os chunks
// buscáveis na Biblioteca (é isso que faz virar RAG de verdade), e
// atualiza o painel ao vivo se for o artefato aberto no momento.
async function escreverArtefato({ slug, titulo, categoria, tags, conteudo }) {
    const slugFinal = slug || slugifyLocal(titulo);
    const categoriaFinal = categoria || 'documento';
    const r = await chamarSpadeFs('/documento/escrever', { personagem: personagemAtual(), slug: slugFinal, titulo, categoria: categoriaFinal, tags: tags || [], conteudo });
    atualizarDocumentoAoVivo({ slug: slugFinal, titulo, conteudo });
    const chunks = await sincronizarDocumentoNaBiblioteca(slugFinal, titulo, categoriaFinal, conteudo);
    return Object.assign(r, { slug: slugFinal, chunks });
}
async function mesclarEmArtefato(categoria, fatosNovos, contextoDocumento) {
    const existente = await encontrarArtefatoPorCategoria(categoria);
    let conteudoExistente = '';
    if (existente) {
        try { conteudoExistente = (await chamarSpadeFs('/documento/ler', { personagem: personagemAtual(), slug: existente.slug })).conteudo || ''; }
        catch (e) { console.warn('[Ingestão] ler artefato existente falhou:', e.message); }
    }
    const listaFatos = fatosNovos.map((f) => '- ' + f).join('\n');
    // FIX (v7.0.2): era modeloRapido — o texto final do Artefato é o que
    // realmente aparece pra colorir o RP, merece o modelo bom, não o flash.
    const { modeloEscritor } = getConfig();
    const prompt =
        (conteudoExistente ? 'Documento já existente (categoria "' + categoria + '"):\n"""\n' + conteudoExistente.slice(0, 4000) + '\n"""\n\n' : '') +
        'Fato(s) novo(s), extraídos de "' + contextoDocumento.titulo + '":\n' + listaFatos + '\n\n' +
        (conteudoExistente
            ? 'Reescreva o documento INTEIRO incorporando o que for novo/relevante — prosa organizada, com começo e ' +
              'meio, que já lê bem sozinha (pense em como vai colorir uma cena de RP de verdade). Não é lista seca ' +
              'de fragmentos soltos. Se algo novo contradiz o que já tinha, o novo prevalece. Não invente nada além ' +
              'do que foi dado.'
            : 'Escreva um documento organizado a partir desses fatos — prosa clara, não lista seca de fragmentos ' +
              'soltos, pensado pra colorir uma cena de RP de verdade.') +
        ' Responda só o texto final do documento, nada mais (sem título tipo "Documento:", direto o conteúdo).';
    let corpo;
    try {
        corpo = (await generate(modeloEscritor, [{ role: 'user', content: prompt }], { maxTokens: 900, temperature: 0.4, timeoutMs: 20000 })).trim();
    } catch (e) {
        console.warn('[Ingestão] merge de artefato falhou, usando lista crua:', e.message);
        corpo = (conteudoExistente ? conteudoExistente + '\n\n' : '') + listaFatos;
    }
    if (!corpo) return { criado: false };
    const titulo = existente?.titulo || (categoria.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()));
    await escreverArtefato({ slug: existente?.slug, titulo, categoria, conteudo: corpo });
    return { criado: !existente };
}

// ====================================
// DOCUMENTO CRU — guarda o texto INTEIRO do arquivo lido como um artefato
// próprio (categoria "documento", 1 arquivo = 1 artefato), sempre —
// independente do que a extração de fatos abaixo decidir que "vale
// destacar". Sem isso, um arquivo cujo conteúdo não virasse nenhum fato
// solto simplesmente sumia: a IA não tinha nenhum jeito de "ver" ele de
// novo depois, e é exatamente esse buraco que fazia ela dizer que não
// conseguia ver um .txt que você tinha acabado de mandar. Isso não
// substitui a extração — as duas convivem: o artefato cru fica como "a
// folha inteira" pesquisável e visível no painel, os fatos extraídos
// viram destaques organizados nos artefatos por categoria.
// ====================================
async function guardarDocumentoBruto(nomeArquivo, textoCompleto) {
    if (!textoCompleto || !textoCompleto.trim()) return 0;
    try {
        const r = await escreverArtefato({ slug: slugifyLocal(nomeArquivo), titulo: nomeArquivo, categoria: 'documento', conteudo: textoCompleto });
        return r.chunks || 0;
    } catch (e) {
        console.warn('[Ingestão] guardar artefato cru falhou:', e.message);
        return 0;
    }
}

// ====================================
// ORQUESTRADOR — o pipeline inteiro, arquivo por arquivo, com callback de
// progresso (pra UI mostrar "lendo X... extraindo... N itens guardados").
// Cada arquivo é independente — um falhar não derruba os outros (mesma
// filosofia de erro do resto do index.js: Promise isolada, log, segue).
// ====================================
async function ingerirArquivo(file, onProgresso) {
    const notificar = (fase, detalhe, extra) => { try { onProgresso?.({ arquivo: file.name, fase, detalhe, extra }); } catch (_) {} };

    notificar('lendo');
    const lido = await lerArquivo(file);
    if (!lido.ok) { notificar('erro', lido.motivo); return { arquivo: file.name, ok: false, erro: lido.motivo, guardados: 0 }; }
    // 'extra' aqui é aditivo — só pra quem quiser mostrar prévia (ex: cartão
    // visual na Sala de Pensamento); ninguém que já lia só `detalhe` quebra.
    notificar('lido', lido.tipo, { preview: lido.conteudo ? lido.conteudo.slice(0, 300) : null });

    // Imagem sem character card — vira texto via visão ANTES de entrar no
    // mesmo pipeline de sempre (é aqui que "qualquer arquivo E foto" vira
    // de fato um pipeline só, não dois caminhos paralelos).
    if (lido.tipo === 'imagem') {
        notificar('descrevendo_imagem');
        const { modeloVisao } = getConfig();
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(lido.arquivoOriginal);
        });
        try {
            const descricao = await generate(modeloVisao, [{
                role: 'user',
                content: [
                    { type: 'text', text: 'Descreva essa imagem com o máximo de detalhe relevante pra construir um personagem/mundo de RP em cima dela — aparência, expressão, cenário, objeto, texto visível, o que for. Parágrafos curtos.' },
                    { type: 'image_url', image_url: { url: dataUrl } },
                ],
            }], { maxTokens: 500, timeoutMs: 25000 });
            lido.conteudo = descricao;
            notificar('imagem_descrita', null, { preview: descricao.slice(0, 300) });
        } catch (e) {
            notificar('erro', 'visão falhou: ' + e.message);
            return { arquivo: file.name, ok: false, erro: 'modelo de visão falhou: ' + e.message, guardados: 0 };
        }
    }

    // Documento cru primeiro, sempre — antes de qualquer decisão da
    // extração. Isso roda mesmo que o resto abaixo não ache nada "digno de
    // destaque"; é o que garante que o arquivo não vira invisível.
    let chunksDocumento = 0;
    try { chunksDocumento = await guardarDocumentoBruto(file.name, lido.conteudo); }
    catch (e) { console.warn('[Ingestão] guardar documento cru falhou:', e.message); }

    const contextoDocumento = { titulo: lido.titulo, tipo: lido.tipo };
    const segmentos = segmentar(lido);
    if (!segmentos.length) {
        const aviso = chunksDocumento ? 'guardado como documento (' + chunksDocumento + ' trecho(s)) — nada de fato solto pra destacar.' : 'nada de segmentável no arquivo.';
        notificar('vazio', aviso);
        return { arquivo: file.name, ok: true, guardados: 0, chunksDocumento, aviso };
    }

    notificar('extraindo', segmentos.length + ' trecho(s)');
    let itensExtraidos = [];
    for (let i = 0; i < segmentos.length; i += LOTE_EXTRACAO) {
        const lote = segmentos.slice(i, i + LOTE_EXTRACAO);
        const extraidos = await extrairLote(lote, contextoDocumento);
        itensExtraidos = itensExtraidos.concat(extraidos);
    }
    if (!itensExtraidos.length) {
        const aviso = chunksDocumento ? 'guardado como documento (' + chunksDocumento + ' trecho(s)) — lido, mas nada pareceu valer destacar como fato solto.' : 'lido, mas nada pareceu valer guardar.';
        notificar('nada_relevante', aviso);
        return { arquivo: file.name, ok: true, guardados: 0, chunksDocumento, aviso };
    }

    // Agrupa por categoria ANTES de escrever — mesma categoria (ex: várias
    // menções de "regra_mundo" em segmentos diferentes do MESMO arquivo)
    // vira UM merge só, não N reescritas brigando entre si.
    const porCategoria = {};
    for (const item of itensExtraidos) {
        notificar('processando_item', item.categoria, { fato: item.fato });
        const fatoContextualizado = await contextualizarFato(item, contextoDocumento);
        (porCategoria[item.categoria] ||= []).push(fatoContextualizado);
    }

    let artefatosCriados = 0, artefatosAtualizados = 0;
    for (const [categoria, fatos] of Object.entries(porCategoria)) {
        try {
            const r = await mesclarEmArtefato(categoria, fatos, contextoDocumento);
            if (r.criado) artefatosCriados++; else artefatosAtualizados++;
        } catch (e) { console.warn('[Ingestão] mesclar artefato falhou pra categoria ' + categoria + ':', e.message); }
    }

    notificar('concluido', artefatosCriados + ' artefato(s) novo(s), ' + artefatosAtualizados + ' atualizado(s)' + (chunksDocumento ? ', arquivo original guardado à parte' : ''));
    return { arquivo: file.name, ok: true, artefatosCriados, artefatosAtualizados, chunksDocumento, totalExtraido: itensExtraidos.length };
}

async function ingerirArquivos(fileList, onProgresso) {
    const arquivos = Array.from(fileList);
    const resultados = [];
    for (const file of arquivos) {
        try { resultados.push(await ingerirArquivo(file, onProgresso)); }
        catch (e) { resultados.push({ arquivo: file.name, ok: false, erro: e.message, guardados: 0 }); }
    }
    return resultados;
}

// ====================================
// BUSCA POR USO — o gancho que fecha "guardar pra usar em OUTRAS coisas".
// `uso` filtra por metadata.usos ANTES da busca semântica (não depois —
// evita gastar embedding em candidato que já não serve pro que foi pedido).
// Ex: Ingestao.buscarPorUso('perfil', 'quem é ela', 8) alimenta uma futura
// tela de "montar perfil"; 'sistemas' alimenta a Construtora quando ela
// precisar de dado de referência real, não só o código em si.
// ====================================
async function buscarPorUso(uso, consulta, k = 8) {
    const todasAtivas = (await Biblioteca.listar({})).filter((e) => e.metadata?.usos?.includes(uso) && e.metadata?.ativo !== false && e.validoAte == null);
    if (!todasAtivas.length) return [];
    if (!consulta?.trim()) return todasAtivas.slice(0, k); // sem consulta = devolve as mais recentes, pra "ver tudo que serve pra X"

    let qEmb;
    try { qEmb = await embedNanoGPT(consulta.slice(0, 4000)); } catch (e) { console.warn('[Ingestão] busca por uso sem embedding:', e.message); return todasAtivas.slice(0, k); }
    if (!qEmb) return todasAtivas.slice(0, k);

    return todasAtivas
        .filter((e) => e.embedding)
        .map((e) => ({ ...e, score: cosineSim(qEmb, e.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
}

function chunkText(text, tamanho = 700, sobreposicao = 80) {
    const clean = (text || '').replace(/\r\n/g, '\n').trim();
    if (!clean) return [];
    const chunks = [];
    let start = 0;
    while (start < clean.length) {
        const end = Math.min(start + tamanho, clean.length);
        chunks.push(clean.slice(start, end).trim());
        if (end >= clean.length) break;
        start = end - sobreposicao;
    }
    return chunks.filter(Boolean);
}

async function compiledBibliotecaBlock(sceneText) {
    const [vozes, memorias] = await Promise.all([
        Biblioteca.buscarVoz(sceneText, { k: 3 }),
        Biblioteca.buscarMemoria(sceneText, { k: 6 }),
    ]);
    const resultados = [...vozes, ...memorias];
    if (!resultados.length) return '';
    const formatted = resultados.map((r) => {
        if (r.tipo === 'fala') return (r.metadata?.polaridade === 'ruim' ? 'NÃO FALA ASSIM: ' : 'FALA ASSIM: ') + r.texto;
        if (r.tipo === 'cena') return '[Cena parecida do passado]\n' + r.texto; // legado — entries antigas antes da consolidação existir
        if (r.tipo === 'fato') return '[Fato consolidado] ' + r.texto;
        if (r.tipo === 'sentimento') return '[O que ela sentiu] ' + r.texto;
        if (r.tipo === 'evento') return '[Evento que marcou] ' + r.texto;
        if (r.tipo === 'documento') return '[Da biblioteca — ' + (r.metadata?.arquivo || 'documento') + ']\n' + r.texto;
        if (r.tipo === 'tom') return '[TREINO DE TOM — como ela fala/é] ' + r.texto;
        if (r.tipo === 'memoria') return '[O que você mesma guardou] ' + r.texto;
        if (r.tipo === 'usuario') return '[O que você notou sobre o usuário] ' + r.texto;
        // Categoria dinâmica (Ingestão decide o nome, ex: traço_personalidade,
        // evento_lore) — sem isso o trecho ficava indistinguível do resto.
        return '[' + r.tipo + '] ' + r.texto;
    });
    return '[BIBLIOTECA — trechos parecidos com a cena agora, mais relevante primeiro. Modele tom, não copie literal.]\n' + formatted.join('\n\n');
}

// ====================================
// SISTEMAS — regras estruturadas que a IA compõe, interpretadas por um
// motor FIXO (esse código aqui, escrito uma vez, nunca gerado pela IA).
// Decisão de propósito, não limitação por preguiça: deixar o modelo gerar
// e RODAR código de verdade (eval de saída de IA) é risco real — uma saída
// malformada ou manipulada podia apagar a Biblioteca inteira, travar a
// aba, ou vazar a API key através de um fetch que ela mesma escreveu. O
// "sistema de verdade" continua de pé (ela decide o quê, esse motor decide
// como aplicar com segurança) — só não é JS solto.
// ====================================
const Sistemas = {
    async criar({ nome, quando, entao, ativo = true }) {
        const entry = { id: newId(), nome, quando, entao, ativo, contador: 0, personagem: personagemAtual(), createdAt: Date.now() };
        await idbPut('sistemas', entry);
        return entry;
    },
    async ajustar({ id, campos }) {
        const atual = await idbGet('sistemas', id);
        if (!atual) throw new Error('Sistema não encontrado: ' + id);
        const entry = Object.assign({}, atual, campos);
        await idbPut('sistemas', entry);
        return entry;
    },
    async remover({ id }) { await idbDelete('sistemas', id); return { ok: true }; },
    async listar() { return idbAllByPersonagem('sistemas', personagemAtual()); },
};

// Roda ANTES do prompt final, toda rodada — casa `quando` (texto livre)
// contra a cena atual por palavra-chave simples (não é IA, é rápido e
// determinístico de propósito, senão vira mais uma chamada de rede por
// regra). Se `quando` bater, `entao` vira bloco extra no prompt.
function avaliarSistemas(sistemasAtivos, sceneText) {
    const cenaLower = (sceneText || '').toLowerCase();
    const disparados = sistemasAtivos.filter((s) => {
        if (!s.ativo) return false;
        const gatilho = (s.quando || '').toLowerCase().trim();
        if (!gatilho) return true; // sem gatilho = sempre vale (ex: contador com decaimento)
        return cenaLower.includes(gatilho);
    });
    if (!disparados.length) return '';
    const linhas = disparados.map((s) => '- [' + s.nome + '] ' + s.entao);
    return '[SISTEMAS QUE VOCÊ MESMA CRIOU — ativos agora]\n' + linhas.join('\n');
}

// ====================================
// REPETIÇÃO — puro JS, sem IA. N-grama de 5 palavras contra as últimas
// respostas de verdade, pra avisar quando algo já foi dito do mesmo jeito.
// ====================================
const N_GRAM = 5;
const MIN_OCCURRENCES = 2;
function words(text) { return (text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []; }
function ngrams(text, n = N_GRAM) {
    const w = words(text);
    const out = [];
    for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(' '));
    return out;
}
function detectRepetition(recentMessages, n = N_GRAM, minOcc = MIN_OCCURRENCES) {
    const counts = new Map();
    for (const msg of recentMessages || []) {
        const seen = new Set(ngrams(msg, n));
        for (const g of seen) counts.set(g, (counts.get(g) || 0) + 1);
    }
    return [...counts.entries()].filter(([, c]) => c >= minOcc).map(([g]) => g);
}
function compiledRepeticaoBlock(recentMessages) {
    const flagged = detectRepetition(recentMessages);
    if (!flagged.length) return '';
    return '[EVITE REPETIR — essas sequências já apareceram nas últimas respostas]\n' + flagged.map((g) => '- "' + g + '"').join('\n');
}

// ====================================
// RODADAS — histórico bruto do RP (usuário + fala final), pra Repetição e
// pra dar vocabulário de cena pra busca na Biblioteca. NÃO é a Sala de
// Pensamento (isso é `journal`, mais abaixo) — nome separado de propósito
// pra não confundir os dois (no spade-server original os dois tinham nome
// parecido, "thinkingRoom", e isso confundia).
// ====================================
// ====================================
// LEITURA DO CHAT REAL DO SILLYTAVERN — fonte única de verdade. Antes,
// getRecentSceneText/getRecentFinalMessages liam de um store interno
// (`rodadas`) que só sabia o que o SPADE MESMO tinha escrito — se você
// editasse, apagasse ou desse swipe direto no ST, ficava desatualizado pra
// sempre, e todo prompt (Pensamento/Espaço/RAG) via uma cena que já não
// existia mais. Removido — ctx().chat É a cena, sempre.
// ====================================
function chatRealRecente(n = 12, maxCharsPorMsg = 900) {
    const chatArr = ctx().chat;
    if (!Array.isArray(chatArr) || !chatArr.length) return [];
    const inicio = Math.max(0, chatArr.length - n);
    return chatArr.slice(inicio).map((m, i) => {
        let txt = (m.mes || '').trim();
        if (txt.length > maxCharsPorMsg) txt = txt.slice(0, maxCharsPorMsg) + '…';
        return { idx: inicio + i, nome: m.name || (m.is_user ? 'Você' : personagemAtual()), ehUsuario: !!m.is_user, texto: txt };
    }).filter((m) => m.texto);
}
function recentRpHistory(maxMessages = 24, maxCharsPerMsg = 800) {
    return chatRealRecente(maxMessages, maxCharsPerMsg).map((m) => ({ role: m.ehUsuario ? 'user' : 'assistant', content: m.texto }));
}
async function getRecentSceneText(n = 6) {
    return chatRealRecente(n * 2).map((m) => '[' + m.idx + '] ' + (m.ehUsuario ? 'Você' : personagemAtual()) + ': ' + m.texto).join('\n');
}
async function getRecentFinalMessages(n = 6) {
    return chatRealRecente(n * 3).filter((m) => !m.ehUsuario).slice(-n).map((m) => m.texto);
}

// ====================================
// MUNDO — relógio dia/hora. Salto narrado (Flash lê a narração) ou avanço
// automático (JS puro) por rodada, nunca os dois juntos.
// ====================================
const MINUTOS_AUTO_POR_RODADA = 5;
async function getMundo() { return estadoGet('mundo', { dia: 1, hora: 9, minuto: 0, updatedAt: 0 }); }
async function setMundo(dia, hora, minuto) {
    let totalMin = Math.round(hora * 60 + minuto);
    const diaExtra = Math.floor(totalMin / (24 * 60));
    totalMin = ((totalMin % (24 * 60)) + 24 * 60) % (24 * 60);
    const estado = { dia: Math.max(1, Math.round(dia) + diaExtra), hora: Math.floor(totalMin / 60), minuto: totalMin % 60, updatedAt: Date.now() };
    await estadoSet('mundo', estado);
    return estado;
}
async function avancarAutomatico() { const atual = await getMundo(); return setMundo(atual.dia, atual.hora, atual.minuto + MINUTOS_AUTO_POR_RODADA); }
async function detectarSaltoNarrado(userMessage, atual) {
    const { modeloRapido } = getConfig();
    const prompt = 'Estado atual do relógio da cena: Dia ' + atual.dia + ', ' + String(atual.hora).padStart(2, '0') + ':' + String(atual.minuto).padStart(2, '0') + '.\n\n' +
        'Mensagem do usuário:\n' + userMessage + '\n\n' +
        'Se essa mensagem NARRA explicitamente uma passagem de tempo (ex: "*volto às 13:46*", "*no dia seguinte, de manhã*", ' +
        '"*algumas horas depois*"), calcule o novo horário ABSOLUTO resultante e responda EXATAMENTE no formato DIA:HORA:MINUTO ' +
        '(ex: 2:14:30 — só isso). Se o salto for vago, estime um avanço razoável (1 a 3 horas). Se a mensagem NÃO narra passagem ' +
        'de tempo, responda EXATAMENTE: SEM_SALTO';
    const resp = await generate(modeloRapido, [{ role: 'user', content: prompt }], { maxTokens: 300 });
    const trimmed = (resp || '').trim();
    const match = trimmed.match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
    if (!match) return null;
    const [, dia, hora, minuto] = match.map(Number);
    return setMundo(dia, hora, minuto);
}
async function avancarRelogio(userMessage) {
    try {
        const atual = await getMundo();
        const salto = await detectarSaltoNarrado(userMessage, atual);
        return salto || avancarAutomatico();
    } catch (err) {
        console.error('[mundo] detecção de salto falhou, seguindo com avanço automático:', err.message);
        return avancarAutomatico();
    }
}
function formatMundo(estado) { return 'Dia ' + estado.dia + ', ' + String(estado.hora).padStart(2, '0') + ':' + String(estado.minuto).padStart(2, '0'); }
function compiledMundoBlock(estado) { return '[RELÓGIO DO MUNDO] ' + formatMundo(estado); }

// ====================================
// NPC — qualquer um que fala é criado; importância baixa/média/alta;
// arquiva (não apaga) depois de 100 rodadas sem citar.
// ====================================
const PROMOCAO_MEDIA = 5, PROMOCAO_ALTA = 20, ARQUIVA_APOS = 100;
function normalizeName(name) { return (name || '').trim().toLowerCase(); }
async function getNpcs() { return estadoGet('npcs', []); }
function parseNameArray(text) {
    if (!text) return [];
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
        const arr = JSON.parse(match[0]);
        if (!Array.isArray(arr)) return [];
        return arr.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
    } catch { return []; }
}
async function extractNpcMentions(sceneText, charName) {
    if (!sceneText?.trim()) return [];
    const { modeloRapido } = getConfig();
    const prompt = 'Cena:\n' + sceneText + '\n\nListe os nomes de personagens que aparecem falando ou sendo citados nessa cena, ' +
        'SEM incluir ' + charName + ' (ela é a protagonista, não conta). Responda só com um array JSON de strings, nada mais. Sem ninguém, responda [].';
    const resp = await generate(modeloRapido, [{ role: 'user', content: prompt }], { maxTokens: 500 });
    return parseNameArray(resp);
}
async function tickNpcs(mentionedNames) {
    const npcs = await getNpcs();
    const mentionedSet = new Set((mentionedNames || []).map(normalizeName));
    for (const rawName of mentionedNames || []) {
        const norm = normalizeName(rawName);
        if (!norm) continue;
        let npc = npcs.find((n) => normalizeName(n.name) === norm);
        if (!npc) {
            npc = { id: newId(), name: rawName.trim(), importancia: 'baixa', totalCitacoes: 0, mensagensSemCitar: 0, arquivado: false, criadoEm: new Date().toISOString(), ultimaCitacaoEm: null };
            npcs.push(npc);
        }
        npc.totalCitacoes++; npc.mensagensSemCitar = 0; npc.ultimaCitacaoEm = new Date().toISOString(); npc.arquivado = false;
        if (npc.totalCitacoes >= PROMOCAO_ALTA) npc.importancia = 'alta';
        else if (npc.totalCitacoes >= PROMOCAO_MEDIA && npc.importancia === 'baixa') npc.importancia = 'media';
    }
    for (const npc of npcs) {
        if (mentionedSet.has(normalizeName(npc.name))) continue;
        if (npc.arquivado) continue;
        npc.mensagensSemCitar++;
        if (npc.mensagensSemCitar >= ARQUIVA_APOS) npc.arquivado = true;
    }
    await estadoSet('npcs', npcs);
    return npcs;
}
async function updateNpcsForRound(userMessage, finalMessage, charName) {
    const sceneText = [userMessage, finalMessage].filter(Boolean).join('\n');
    if (!sceneText.trim()) return [];
    const mentioned = await extractNpcMentions(sceneText, charName);
    return tickNpcs(mentioned);
}
async function setNpcImportancia(id, importancia) {
    if (!['baixa', 'media', 'alta'].includes(importancia)) throw new Error('importância inválida.');
    const npcs = await getNpcs();
    const npc = npcs.find((n) => n.id === id);
    if (!npc) return null;
    npc.importancia = importancia;
    await estadoSet('npcs', npcs);
    return npc;
}
async function setNpcArquivado(id, arquivado) {
    const npcs = await getNpcs();
    const npc = npcs.find((n) => n.id === id);
    if (!npc) return null;
    npc.arquivado = !!arquivado;
    if (!arquivado) npc.mensagensSemCitar = 0;
    await estadoSet('npcs', npcs);
    return npc;
}

// ====================================
// TAREFAS — estado real (aceitar/recusar/completar é fato, não
// interpretação de texto).
// ====================================
async function getTarefas() { return estadoGet('tarefas', []); }
async function criarTarefa({ descricao, criadoPor, presenciadoPorHanna = true }) {
    if (!descricao?.trim()) throw new Error('descrição obrigatória.');
    const tarefa = { id: newId(), descricao: descricao.trim(), criadoPor, status: 'pendente', presenciadoPorHanna, createdAt: Date.now(), resolvedAt: null };
    const list = [...(await getTarefas()), tarefa];
    await estadoSet('tarefas', list);
    return tarefa;
}
async function resolverTarefa(id, acao) {
    const list = await getTarefas();
    const tarefa = list.find((t) => t.id === id);
    if (!tarefa) throw new Error('Tarefa não encontrada: ' + id);
    if (acao === 'aceitar' && tarefa.status === 'pendente') tarefa.status = 'aceita';
    else if (acao === 'recusar' && tarefa.status === 'pendente') { tarefa.status = 'recusada'; tarefa.resolvedAt = Date.now(); }
    else if (acao === 'completar' && tarefa.status === 'aceita') { tarefa.status = 'completa'; tarefa.resolvedAt = Date.now(); }
    await estadoSet('tarefas', list);
    return tarefa;
}
async function detectarTarefaNaRodada(finalMessage, charName) {
    const { modeloRapido } = getConfig();
    const prompt = 'Fala de ' + charName + ' que acabou de sair no RP:\n"' + finalMessage + '"\n\n' +
        'Essa fala oferece/propõe uma tarefa concreta pro usuário (pedido direto, convite pra fazer algo específico) — ' +
        'não uma menção vaga a estar ocupada? Se sim, responda só a descrição curta da tarefa. Se não, responda: NENHUMA';
    let resp;
    try { resp = await generate(modeloRapido, [{ role: 'user', content: prompt }], { maxTokens: 150 }); }
    catch (err) { console.warn('[tarefas] detecção falhou:', err.message); return null; }
    const trimmed = (resp || '').trim();
    if (!trimmed || trimmed === 'NENHUMA') return null;
    return criarTarefa({ descricao: trimmed, criadoPor: charName, presenciadoPorHanna: true });
}
function compiledTarefasBlock(tarefas, charName) {
    const pendentesOuAceitas = tarefas.filter((t) => t.presenciadoPorHanna && (t.status === 'pendente' || t.status === 'aceita'));
    if (!pendentesOuAceitas.length) return '';
    const linhas = pendentesOuAceitas.map((t) => '- "' + t.descricao + '" (' + t.status + ')');
    return '[TAREFAS EM ABERTO que ' + charName + ' sabe que existem]\n' + linhas.join('\n');
}

// ====================================
// ESTADO INTERNO — auto-avaliado a cada rodada (chamada rápida, Flash),
// grava como UMA entrada fixa na Biblioteca (tipo 'estado_interno',
// chaveFixa 'atual' — atualiza no lugar, não acumula infinitas versões).
// Isso substitui innerState.js sem virar API separada: é só mais uma
// escrita via Biblioteca.escrever, igual tudo o resto.
// ====================================
async function getEstadoInterno() {
    const id = 'fixo-' + personagemAtual() + '-estado_interno';
    const row = await idbGet('biblioteca', id);
    return row?.texto || '';
}
async function evaluateInnerState(recentText, charName) {
    const atual = await getEstadoInterno();
    const { modeloRapido } = getConfig();
    const prompt = 'Estado interno atual de ' + charName + ':\n' + (atual || '(nenhum registrado ainda)') + '\n\n' +
        'Cena recente:\n' + recentText + '\n\n' +
        'Se o que rolou nessa troca mudar esse estado, reescreva em um parágrafo curto com três coisas: o que ela sente por ' +
        'dentro, o que mostra por fora (podem ser diferentes), e o motivo. Se genuinamente não mudou nada, responda: SEM_MUDANCA';
    const resp = await generate(modeloRapido, [{ role: 'user', content: prompt }], { maxTokens: 700 });
    const trimmed = (resp || '').trim();
    if (!trimmed || trimmed === 'SEM_MUDANCA') return atual;
    await Biblioteca.escrever({ tipo: 'estado_interno', texto: trimmed, chaveFixa: 'estado_interno' });
    return trimmed;
}
function compiledInnerStateBlock(texto) {
    if (!texto) return '';
    return '[ESTADO DE FUNDO — pode colorir a cena, não precisa ser dito]\n' + texto;
}

// ====================================
// PIPELINE — cantos em paralelo (Promise.allSettled), monta o system
// prompt final. Canto Perfil/Falas/Cenas separados viraram UM canto só
// (Biblioteca), já que agora é índice único com busca de verdade.
// ====================================
function fromSettled(result, label, fallbackValue) {
    if (result.status === 'fulfilled') return { value: result.value, ok: true };
    console.error('[pipeline] canto ' + label + ' falhou, seguindo com fallback:', result.reason?.message);
    return { value: fallbackValue, ok: false };
}
async function runCantos(userMessage) {
    const charName = personagemAtual();
    const cenaRecente = await getRecentSceneText(6);
    const sceneText = [cenaRecente, userMessage].filter(Boolean).join('\n');
    const recentFinal = await getRecentFinalMessages(6);

    const [bibliotecaResult, repeticaoResult, estadoResult, mundoResult, sistemasResult, sistemasReaisResult] = await Promise.allSettled([
        compiledBibliotecaBlock(sceneText),
        Promise.resolve(compiledRepeticaoBlock(recentFinal)),
        evaluateInnerState(userMessage, charName).then((texto) => compiledInnerStateBlock(texto)),
        avancarRelogio(userMessage),
        Sistemas.listar().then((sistemas) => avaliarSistemas(sistemas, sceneText)),
        avaliarSistemasReais(sceneText),
    ]);

    const cantos = {};
    cantos.biblioteca = fromSettled(bibliotecaResult, 'biblioteca', '');
    cantos.repeticao = fromSettled(repeticaoResult, 'repetição', '');
    cantos.estado = fromSettled(estadoResult, 'estado', '');
    const mundoFallback = await getMundo();
    const mundo = fromSettled(mundoResult, 'mundo', mundoFallback);
    cantos.mundo = { estado: mundo.value, block: compiledMundoBlock(mundo.value), ok: mundo.ok };
    cantos.sistemas = fromSettled(sistemasResult, 'sistemas', '');
    cantos.sistemasReais = fromSettled(sistemasReaisResult, 'sistemas_reais', '');

    return cantos;
}
async function buildSystemPrompt(cantos) {
    const charName = personagemAtual();
    const tarefas = await getTarefas();
    const parts = [
        cantos.biblioteca?.value,
        cantos.repeticao?.value,
        cantos.estado?.value,
        cantos.mundo?.block,
        cantos.sistemas?.value,
        cantos.sistemasReais?.value,
        compiledTarefasBlock(tarefas, charName),
        'Você é a ' + charName + ' — só ela, agora. Nada de ferramenta, nada de passo, nada de "agente" aqui: é ela ' +
        'falando de verdade. Responda curto, direto, em pt-br, coerente com o que veio acima.',
    ];
    return parts.filter(Boolean).join('\n\n');
}

// ====================================
// FUNDIÇÃO — sandbox de código de verdade. Ver spade-fundicao.md.
//
// O comentário de SISTEMAS (acima) apontou 3 riscos reais de deixar a IA
// gerar e rodar código: apagar a Biblioteca inteira, travar a aba sem
// jeito de interromper, vazar a API key por um fetch que ela mesma
// escreveu. Isso aqui não ignora esse risco — resolve estruturalmente:
// o código roda dentro de um Web Worker, que tem seu próprio Realm (sem
// acesso a DOM, sem acesso a localStorage/IndexedDB do documento
// principal). O único jeito de tocar estado/Biblioteca é pela ponte de
// RPC abaixo — o que não está explicitamente exposto ali, o sistema não
// alcança. E se travar de verdade (loop síncrono, não só promise
// pendurada), .terminate() mata o Worker de fora — a aba não trava.
// ====================================

// Harness fixo que roda DENTRO do Worker — escrito uma vez por nós, nunca
// gerado pela IA. `aoAtivar(input, sdk)` é o contrato que todo sistema real
// precisa implementar; input vem do hook que disparou, sdk é a única porta
// pro resto da extensão.
const WORKER_HARNESS = `
// Worker tem fetch/XHR/WebSocket PRÓPRIOS por padrão — isolar DOM/storage
// não bloqueia rede sozinho. Sem isso, um sistema (bugado ou malicioso)
// ainda podia mandar o input (ex: sceneText) pra um servidor externo sem
// precisar da API key. Removido antes de qualquer código de sistema rodar.
self.fetch = undefined;
self.XMLHttpRequest = undefined;
self.WebSocket = undefined;
self.importScripts = undefined;
let _rpcId = 0;
const _pendentes = new Map();
function _rpc(tipo, payload) {
    return new Promise((resolve, reject) => {
        const id = ++_rpcId;
        _pendentes.set(id, { resolve, reject });
        self.postMessage({ tipo: 'rpc', id, chamada: tipo, payload });
    });
}
self.onmessage = async (ev) => {
    const msg = ev.data;
    if (msg.tipo === 'rpc_resposta') {
        const p = _pendentes.get(msg.id);
        if (!p) return;
        _pendentes.delete(msg.id);
        if (msg.erro) p.reject(new Error(msg.erro)); else p.resolve(msg.valor);
        return;
    }
    if (msg.tipo !== 'executar') return;
    const sdk = {
        estado: {
            ler: (campo) => _rpc('estado.ler', { campo }),
            escrever: (campo, valor) => _rpc('estado.escrever', { campo, valor }),
        },
        biblioteca: {
            escrever: (entry) => _rpc('biblioteca.escrever', entry),
            buscar: (consulta, opcoes) => _rpc('biblioteca.buscar', { consulta, opcoes }),
        },
    };
    // teto ASSÍNCRONO — pega promise pendurada (ex: RPC que nunca respondeu).
    // Loop SÍNCRONO real nem chega a disparar isso; quem mata esse caso é o
    // .terminate() do lado de fora (ver rodarSistemaSandbox).
    const timeoutInterno = setTimeout(() => {
        self.postMessage({ tipo: 'erro', erro: 'timeout interno — passou de ' + (msg.timeoutMs || 8000) + 'ms sem resolver (promise pendurada).' });
    }, msg.timeoutMs || 8000);
    try {
        const fn = new Function('input', 'sdk', msg.codigo + '\\nreturn typeof aoAtivar === "function" ? aoAtivar(input, sdk) : null;');
        const resultado = await fn(msg.input, sdk);
        clearTimeout(timeoutInterno);
        self.postMessage({ tipo: 'resultado', resultado });
    } catch (e) {
        clearTimeout(timeoutInterno);
        self.postMessage({ tipo: 'erro', erro: (e && e.message) || String(e), stack: e && e.stack });
    }
};
`;

function criarSistemaWorker() {
    const blob = new Blob([WORKER_HARNESS], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    worker._blobUrl = url;
    return worker;
}

// Executa `codigo` dentro do sandbox pro hook `hookNome`, com `input` como
// argumento. `sistemaId` namespaceia o estado — estado.sistemas.<id>.<campo>,
// dois sistemas nunca colidem no mesmo nome de campo (spade-fundicao.md
// seção 9). Devolve { ok, resultado } ou { ok: false, erro }, nunca lança.
async function rodarSistemaSandbox(sistemaId, codigo, hookNome, input, { timeoutMs = 8000, timeoutDuroMs = 12000 } = {}) {
    const worker = criarSistemaWorker();

    return new Promise((resolve) => {
        let resolvido = false;
        const finalizar = (valor) => {
            if (resolvido) return;
            resolvido = true;
            clearTimeout(timeoutDuro);
            worker.terminate();
            try { URL.revokeObjectURL(worker._blobUrl); } catch (_) {}
            resolve(valor);
        };

        // teto DURO — mata o Worker de fora mesmo se ele nunca respondeu
        // nada (loop síncrono real). É o motivo de isso ser Worker e não
        // eval() no thread principal: só um Worker dá pra matar de fora.
        const timeoutDuro = setTimeout(() => {
            finalizar({ ok: false, erro: 'travou de verdade — nem o teto interno respondeu em ' + timeoutDuroMs + 'ms. Worker morto de fora.' });
        }, timeoutDuroMs);

        worker.onmessage = async (ev) => {
            const msg = ev.data;
            if (msg.tipo === 'rpc') {
                // ponte real de SDK — só o que está explicitamente aqui é
                // alcançável pelo sistema. Nada de handle direto pra
                // IndexedDB/localStorage do documento principal.
                try {
                    let valor;
                    if (msg.chamada === 'estado.ler') valor = await estadoGet('sistemas.' + sistemaId + '.' + msg.payload.campo, null);
                    else if (msg.chamada === 'estado.escrever') valor = await estadoSet('sistemas.' + sistemaId + '.' + msg.payload.campo, msg.payload.valor);
                    else if (msg.chamada === 'biblioteca.escrever') valor = await Biblioteca.escrever(Object.assign({}, msg.payload, { metadata: Object.assign({}, msg.payload.metadata, { deSistema: sistemaId }) }));
                    else if (msg.chamada === 'biblioteca.buscar') valor = await Biblioteca.buscar(Object.assign({ consulta: msg.payload.consulta }, msg.payload.opcoes));
                    else throw new Error('chamada de SDK desconhecida: ' + msg.chamada);
                    worker.postMessage({ tipo: 'rpc_resposta', id: msg.id, valor });
                } catch (e) {
                    worker.postMessage({ tipo: 'rpc_resposta', id: msg.id, erro: (e && e.message) || String(e) });
                }
                return;
            }
            if (msg.tipo === 'resultado') finalizar({ ok: true, resultado: msg.resultado });
            else if (msg.tipo === 'erro') finalizar({ ok: false, erro: msg.erro, stack: msg.stack });
        };
        worker.onerror = (ev) => finalizar({ ok: false, erro: 'erro fatal no Worker: ' + ev.message });

        worker.postMessage({ tipo: 'executar', codigo, hookNome, input, timeoutMs });
    });
}

// Contrato/SDK versionado (spade-fundicao.md seção 7) — código de sistema só
// alcança o que está descrito aqui. `publicar` NÃO ativa sozinho: salva a
// versão e testa 1x; só vira a versão ativa quando `ativar` é chamado —
// separa "compila e roda" de "está no ar", que é onde a aprovação entra.
const SistemasReais = {
    async listar() { return idbAllByPersonagem('sistemas_reais', personagemAtual()); },
    async ativos() { return (await this.listar()).filter((s) => s.ativo); },

    // Testa sem persistir nada — é o loop Reflexion (spade-fundicao.md seção
    // 5): a IA vê o erro REAL do sandbox e corrige, iterando pela mesma
    // chamada de ferramentas que ela já usa pra tudo o mais. Não depende da
    // segunda IA construtora existir pra funcionar.
    async testar({ codigo, hookAlvo, entradaExemplo }) {
        const resultado = await rodarSistemaSandbox('teste-' + newId(), codigo, hookAlvo, entradaExemplo ?? {});
        registrarAprendizadoSistema({ ok: resultado.ok, erro: resultado.erro, hookAlvo, codigo, origem: 'testar' });
        return resultado;
    },

    // Salva uma versão nova (nunca sobrescreve — `familia` agrupa as
    // versões do "mesmo sistema" ao longo de edições). Roda 1x antes de
    // salvar: se não passar, não salva nada.
    async publicar({ familia, nome, hookAlvo, codigo, autor, entradaExemplo }) {
        const teste = await rodarSistemaSandbox('pre-publicacao-' + newId(), codigo, hookAlvo, entradaExemplo ?? {});
        registrarAprendizadoSistema({ ok: teste.ok, erro: teste.erro, hookAlvo, codigo, origem: 'publicar' });
        if (!teste.ok) return { salvo: false, erro: teste.erro };
        const versoesExistentes = (await this.listar()).filter((s) => s.familia === familia);
        const versao = versoesExistentes.length ? Math.max(...versoesExistentes.map((s) => s.versao)) + 1 : 1;
        const entry = {
            id: newId(), familia, nome, versao, hookAlvo, codigo,
            personagem: personagemAtual(), criadoEm: Date.now(),
            autor: autor || { ia: 'principal', aprovadoPor: null },
            ativo: false, // precisa de SistemasReais.ativar() — ver acima
        };
        await idbPut('sistemas_reais', entry);
        return { salvo: true, sistema: entry };
    },

    // Ativa uma versão específica — desativa as outras da mesma família.
    // Serve pros dois casos: aprovar uma versão recém-publicada, OU
    // rollback pra uma versão antiga (rollback de graça, spade-fundicao.md
    // seção 6 — é a mesma operação).
    async ativar({ id }) {
        const alvo = await idbGet('sistemas_reais', id);
        if (!alvo) throw new Error('Versão não encontrada: ' + id);
        const irmasAtivas = (await this.listar()).filter((s) => s.familia === alvo.familia && s.ativo && s.id !== id);
        for (const s of irmasAtivas) { s.ativo = false; await idbPut('sistemas_reais', s); }
        alvo.ativo = true;
        await idbPut('sistemas_reais', alvo);
        return alvo;
    },
    async remover({ id }) { await idbDelete('sistemas_reais', id); return { ok: true }; },
};

// Roda os sistemas reais ativos que miram o hook 'antesDeGerar' — em
// paralelo com o resto de runCantos. Sistema com erro some do bloco
// silenciosamente (só loga) — um bug num sistema não pode derrubar a
// rodada de RP inteira. Custo real: 1 Worker por sistema ativo, TODA
// rodada — ok pra poucos sistemas, vale revisitar se isso escalar muito.
async function avaliarSistemasReais(sceneText) {
    const ativos = (await SistemasReais.ativos()).filter((s) => s.hookAlvo === 'antesDeGerar');
    if (!ativos.length) return '';
    const resultados = await Promise.allSettled(
        ativos.map((s) => rodarSistemaSandbox(s.id, s.codigo, s.hookAlvo, { sceneText }))
    );
    const linhas = [];
    resultados.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value.ok && typeof r.value.resultado === 'string' && r.value.resultado.trim()) {
            linhas.push('- [' + ativos[i].nome + '] ' + r.value.resultado.trim());
        } else if (r.status === 'fulfilled' && !r.value.ok) {
            console.warn('[sistemas_reais] "' + ativos[i].nome + '" falhou:', r.value.erro);
        } else if (r.status === 'rejected') {
            console.warn('[sistemas_reais] "' + ativos[i].nome + '" rejeitou:', r.reason);
        }
    });
    if (!linhas.length) return '';
    return '[SISTEMAS REAIS ATIVOS — código de verdade, rodou agora]\n' + linhas.join('\n');
}

// ====================================
// AUTO-ESTUDO (_sistema) — etapa 3. Conhecimento sobre o SDK/sandbox em si
// (o que funciona, o que quebra) não é sobre a personagem de RP — é sobre
// o sistema. Por isso mora num escopo fixo, `_sistema`, que ignora o
// personagem ativo do ST: sobrevive à troca de char, não se perde, não se
// mistura com memória de RP. Usa a MESMA Biblioteca (tipo
// 'aprendizado_sistema') e o MESMO mecanismo de validade temporal
// (validoAte) que já existe pro RAG — nada de estrutura nova.
// ====================================
const ESCOPO_AUTOESTUDO = '_sistema';

// Sobe manualmente sempre que o CONTRATO do SDK mudar de verdade (novo
// método em sdk.estado/sdk.biblioteca, novo hookAlvo chamado de verdade,
// mudança no formato de input). Dispara invalidação em checarVersaoSDK() —
// aprendizado registrado sob uma versão velha do contrato pode estar
// descrevendo um comportamento que não existe mais.
const SDK_VERSAO = 1;

// Bloco de documentação do SDK mantido À MÃO — não é leitura real do
// código-fonte (index.js rodando não tem introspecção de si mesmo). Cada
// vez que o contrato mudar de verdade, atualiza aqui E sobe SDK_VERSAO.
const SDK_DOC_BLOCK = `
CONTRATO DO SDK (sistema real, código de verdade — sistema_real_*)

Todo sistema define UMA função:
  function aoAtivar(input, sdk) { ... }
Ela roda isolada dentro de um Web Worker (sandbox) — sem DOM, sem fetch,
sem XHR, sem WebSocket, sem acesso a nada fora do que "sdk" expõe. O
retorno de aoAtivar vira o resultado do sistema (string curta pra
antesDeGerar; pode ser null/undefined se decidir não agir).

hookAlvo: hoje só "antesDeGerar" é chamado de verdade, toda rodada de RP,
com input = { sceneText: string }. Outros nomes de hookAlvo são aceitos
por sistema_real_testar/publicar mas ficam guardados inertes — nada os
dispara ainda.

sdk.estado.ler(campo) -> Promise<valor|null>
sdk.estado.escrever(campo, valor) -> Promise<valor>
  Estado PRÓPRIO do sistema, namespaced por sistemaId — dois sistemas
  nunca colidem no mesmo nome de campo. Serve pra contador/flag que o
  sistema mesmo administra entre rodadas.

sdk.biblioteca.escrever(entry) -> Promise<entry salvo>
  Mesma Biblioteca do resto da extensão. entry aceita os mesmos campos de
  Biblioteca.escrever: { tipo, texto, metadata, chaveFixa, sabemDisso,
  importancia, entidades, substitui }. tipo e texto são obrigatórios.
sdk.biblioteca.buscar(consulta, opcoes) -> Promise<entries[]>
  opcoes: { tipos, k, paraNpc } — mesma busca híbrida que o resto do
  sistema usa.

Timeout: ~8s de teto mole (erro claro se estourar); ~12s de teto duro
(Worker morto de fora, sem chance de resposta depois disso) — não vale
escrever aoAtivar que dependa de I/O demorado, ele não tem I/O disponível
de qualquer forma.

Exemplo mínimo válido (hookAlvo "antesDeGerar"):
  function aoAtivar(input, sdk) {
    if (!input.sceneText.includes('chuva')) return null;
    return 'está chovendo agora, pode mencionar isso';
  }
`.trim();

// Escreve o hook de aprendizado (3.2) — chamado no fim de
// SistemasReais.testar()/publicar(), sempre, falhando ou não. Template
// puro, sem chamada de LLM (é "de graça") — o texto já carrega hookAlvo +
// resultado + trecho de código. Não é aguardado por quem chama — um log
// não deveria atrasar o loop testar→corrigir→testar de novo (Reflexion).
async function registrarAprendizadoSistema({ ok, erro, hookAlvo, codigo, origem }) {
    const trecho = (codigo || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const texto = ok
        ? `[${origem}] hookAlvo "${hookAlvo}" rodou limpo com esse padrão de código: ${trecho}`
        : `[${origem}] hookAlvo "${hookAlvo}" falhou com "${erro}" quando o código tentava: ${trecho}`;
    try {
        await Biblioteca.escrever({
            tipo: 'aprendizado_sistema',
            texto,
            personagem: ESCOPO_AUTOESTUDO,
            importancia: ok ? 0.4 : 0.6,
            metadata: { hookAlvo, ok, versaoSDK: SDK_VERSAO, origem },
        });
    } catch (e) {
        console.warn('[auto-estudo] falha ao registrar aprendizado:', e.message);
    }
}

// Aprendizados relevantes pra dar de contexto à Construtora antes de um
// passo — fecha o loop com registrarAprendizadoSistema acima (escreve lá,
// lê aqui); sem isso, etapa 3 só acumularia log que ninguém consulta.
async function aprendizadosRelevantes(consulta, k = 3) {
    try {
        const encontrados = await Biblioteca.buscarMemoria(consulta || 'sistema real código sandbox', {
            tipos: ['aprendizado_sistema'], personagem: ESCOPO_AUTOESTUDO, k,
        });
        return encontrados.map((e) => e.texto);
    } catch (e) { console.warn('[auto-estudo] busca de aprendizados falhou:', e.message); return []; }
}

// Roda 1x por carregamento (3.4) — se a versão do contrato subiu desde a
// última vez, invalida (validoAte — MESMO mecanismo do RAG, não é peça
// nova) todo aprendizado registrado sob a versão velha. `estado` é sempre
// escopado por personagem (personagemAtual()+':'+campo); aqui a chave usa
// ESCOPO_AUTOESTUDO direto, de propósito — é sobre o SDK, não sobre qual
// char tá ativo no ST.
async function checarVersaoSDK() {
    const chave = ESCOPO_AUTOESTUDO + ':versaoSDKVista';
    try {
        const vista = await idbGet('estado', chave);
        const anterior = vista ? vista.valor : null;
        if (anterior != null && anterior < SDK_VERSAO) {
            const entradas = await Biblioteca.listar({ personagem: ESCOPO_AUTOESTUDO });
            const agora = Date.now();
            for (const e of entradas) {
                if (e.validoAte == null && (e.metadata?.versaoSDK ?? 0) < SDK_VERSAO) {
                    e.validoAte = agora;
                    await idbPut('biblioteca', e);
                }
            }
        }
        if (anterior !== SDK_VERSAO) await idbPut('estado', { chave, valor: SDK_VERSAO });
    } catch (e) { console.warn('[auto-estudo] checagem de versão do SDK falhou:', e.message); }
}

// ====================================
// FERRAMENTAS — poucos verbos genéricos, alcance largo. É isso que dá
// "poder de verdade tipo agente de código" sem virar uma função nova por
// micro-ação. Usadas IGUAL tanto na Sala de Pensamento contínua quanto no
// Espaço (mesma tool, mesma execução — só muda quem decide chamar).
// ====================================
// ====================================
// SPADE-FS — ponte pro plugin de servidor (arquivo separado, ver
// spade-fs-server-plugin.js) que lê/escreve os arquivos DE VERDADE da
// extensão no disco. Sem isso, "editar a extensão" seria só teatro —
// JS de navegador não escreve no .js que o SillyTavern carregou do disco.
// Escrita NUNCA aplica na hora (troca de código embaixo do próprio script
// rodando = estado duplicado, listener duplicado) — sempre exige reload
// manual, que é também o freio humano antes de qualquer mudança pegar.
// ====================================
const SPADE_FS_BASE = '/api/plugins/spade-fs';
// FIX (v7.0.2): faltava o header de CSRF que o próprio servidor do
// SillyTavern exige em QUALQUER rota /api/* — sem ele, toda chamada aqui
// (listar/ler/escrever/apagar artefato, ler/editar arquivo da extensão)
// voltava 403 e era engolida em silêncio pelos try/catch de quem chama.
// ctx().getRequestHeaders() é a função oficial do ST pra isso (mesma que
// o próprio core usa) — não existe token pra inventar/guardar aqui.
async function chamarSpadeFs(caminho, corpo) {
    let resp;
    try {
        const headers = Object.assign({ 'Content-Type': 'application/json' }, ctx().getRequestHeaders?.() || {});
        resp = await fetch(SPADE_FS_BASE + caminho, {
            method: 'POST', headers,
            body: JSON.stringify(corpo || {}),
        });
    } catch (e) {
        throw new Error('plugin spade-fs não respondeu (tá instalado e o SillyTavern foi reiniciado depois? ver spade-fs-server-plugin.js): ' + e.message);
    }
    let data = {};
    try { data = await resp.json(); } catch (_) {}
    if (!resp.ok) throw new Error(data.erro || ('spade-fs devolveu ' + resp.status));
    return data;
}

const TOOLS = [

    { type: 'function', function: { name: 'sistema_criar', description: 'Cria uma regra/sistema de verdade que passa a rodar sozinha toda rodada — não é só mais uma frase de prompt, fica ativa até você remover. Ex: um padrão a evitar, um contador que você mesma administra (tensão, paciência), um lembrete condicional.', parameters: { type: 'object', properties: { nome: { type: 'string' }, quando: { type: 'string', description: 'Condição em texto simples (palavra/tema que precisa aparecer na cena pra ativar) — deixe vazio pra sempre valer.' }, entao: { type: 'string', description: 'O que fazer/lembrar quando ativar.' } }, required: ['nome', 'entao'] } } },
    { type: 'function', function: { name: 'sistema_real_testar', description: 'Testa um sistema de CÓDIGO DE VERDADE (diferente de sistema_criar — isso roda JS de verdade, isolado num sandbox) sem publicar nada. O código deve definir uma função aoAtivar(input, sdk) — sdk.estado.ler/escrever e sdk.biblioteca.escrever/buscar são a ÚNICA forma de tocar a extensão de dentro do sistema. Se der erro, o erro real volta pra você — corrija e teste de novo até rodar limpo antes de publicar.', parameters: { type: 'object', properties: { codigo: { type: 'string', description: 'Corpo definindo aoAtivar(input, sdk). Ex: "function aoAtivar(input, sdk) { return input.sceneText.includes(\'chuva\') ? \'está chovendo, mencione isso\' : null; }"' }, hookAlvo: { type: 'string', description: 'Hoje só "antesDeGerar" é chamado de verdade toda rodada (recebe {sceneText}); outros nomes ficam guardados mas inertes.' }, entradaExemplo: { type: 'object', description: 'Input de teste, ex: {"sceneText": "..."}.' } }, required: ['codigo', 'hookAlvo'] } } },
    { type: 'function', function: { name: 'sistema_real_publicar', description: 'Salva uma versão de um sistema de código de verdade que já testou limpo com sistema_real_testar. Roda 1x antes de salvar — se falhar, não salva nada. IMPORTANTE: publicar NÃO ativa sozinho — a versão fica guardada, inativa, até você chamar sistema_real_ativar. Isso separa "compila e roda" de "está no ar".', parameters: { type: 'object', properties: { familia: { type: 'string', description: 'Identificador estável do sistema — use o MESMO valor em edições futuras dele, pra versionar em vez de duplicar.' }, nome: { type: 'string' }, hookAlvo: { type: 'string' }, codigo: { type: 'string' }, entradaExemplo: { type: 'object' } }, required: ['familia', 'nome', 'hookAlvo', 'codigo'] } } },
    { type: 'function', function: { name: 'sistema_real_ativar', description: 'Ativa uma versão específica de um sistema de código de verdade — desativa qualquer outra versão da mesma família. Serve tanto pra aprovar uma versão recém-publicada quanto pra reverter (rollback) pra uma versão antiga.', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Id da versão a ativar.' } }, required: ['id'] } } },
    { type: 'function', function: { name: 'sistema_real_listar', description: 'Lista os sistemas de código de verdade (todas as versões, qual está ativa).', parameters: { type: 'object', properties: {} } } },

    { type: 'function', function: { name: 'extensao_listar_arquivos', description: 'Lista os arquivos da PRÓPRIA extensão que dá pra ler/editar (index.js, style.css, manifest.json) — sempre só esses três, nenhum outro caminho é aceito.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'extensao_ler_arquivo', description: 'Lê o conteúdo REAL, atual, do arquivo da extensão no disco — não é o que você lembra da conversa, é o arquivo de verdade. Leia antes de editar, sempre — editar em cima do que você lembra em vez do que tá lá de fato é a forma mais comum de quebrar isso.', parameters: { type: 'object', properties: { arquivo: { type: 'string', enum: ['index.js', 'style.css', 'manifest.json'] } }, required: ['arquivo'] } } },
    { type: 'function', function: { name: 'extensao_editar_arquivo', description: 'Escreve um conteúdo NOVO E COMPLETO por cima do arquivo da extensão (não é um patch — manda o arquivo inteiro, com a mudança já aplicada). Faz backup automático antes, e se for .js/.json rejeita se a sintaxe não fechar. NÃO aplica na hora — só depois que a página recarregar; avise isso pro usuário sempre que usar.', parameters: { type: 'object', properties: { arquivo: { type: 'string', enum: ['index.js', 'style.css', 'manifest.json'] }, conteudo: { type: 'string' } }, required: ['arquivo', 'conteudo'] } } },
    { type: 'function', function: { name: 'extensao_restaurar_backup', description: 'Desfaz — volta um arquivo da extensão pro backup mais recente de antes da última escrita. Use se um extensao_editar_arquivo anterior quebrou alguma coisa.', parameters: { type: 'object', properties: { arquivo: { type: 'string', enum: ['index.js', 'style.css', 'manifest.json'] } }, required: ['arquivo'] } } },
    { type: 'function', function: { name: 'estudar_codigo', description: 'Devolve a documentação do contrato do SDK do sandbox (aoAtivar, sdk.estado, sdk.biblioteca, hookAlvo disponível) com um exemplo válido — mantida à mão, não é leitura do código-fonte real. Chame antes de escrever um sistema do zero, ou quando um erro de sistema_real_testar não fizer sentido.', parameters: { type: 'object', properties: { topico: { type: 'string', description: 'Opcional — o que você quer entender melhor (ex: "sdk.biblioteca", "hookAlvo"). Não filtra a resposta hoje, sempre devolve o bloco inteiro; serve só de registro do que motivou a consulta.' } } } } },
    { type: 'function', function: { name: 'sistema_ajustar', description: 'Muda um sistema que você já criou (nome, condição, efeito, ativo/inativo).', parameters: { type: 'object', properties: { id: { type: 'string' }, nome: { type: 'string' }, quando: { type: 'string' }, entao: { type: 'string' }, ativo: { type: 'boolean' } }, required: ['id'] } } },
    { type: 'function', function: { name: 'sistema_remover', description: 'Remove um sistema/regra que você criou.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
    { type: 'function', function: { name: 'sistema_listar', description: 'Lista os sistemas/regras que você já criou.', parameters: { type: 'object', properties: {} } } },

    { type: 'function', function: { name: 'chat_agir', description: 'Fala, edita ou apaga uma mensagem sua no RP. Sem "idx" = sua última fala. Com "idx" = mensagem específica (você já vê o índice de cada mensagem na cena recente, não precisa pedir pra olhar antes).', parameters: { type: 'object', properties: { acao: { type: 'string', enum: ['falar', 'editar', 'apagar'] }, idx: { type: 'integer', description: 'Opcional — índice de uma mensagem específica.' }, texto: { type: 'string', description: 'Necessário pra falar/editar.' } }, required: ['acao'] } } },

    { type: 'function', function: { name: 'mundo_ver', description: 'Vê o relógio atual da cena (dia/hora).', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'mundo_ajustar', description: 'Ajusta o relógio da cena manualmente.', parameters: { type: 'object', properties: { dia: { type: 'number' }, hora: { type: 'number' }, minuto: { type: 'number' } }, required: ['dia', 'hora', 'minuto'] } } },

    { type: 'function', function: { name: 'tarefa_criar', description: 'Cria uma tarefa nova pro usuário — pedido ou convite concreto. Fica pendente até ele aceitar/recusar.', parameters: { type: 'object', properties: { descricao: { type: 'string' } }, required: ['descricao'] } } },
    { type: 'function', function: { name: 'tarefa_listar', description: 'Lista as tarefas existentes — use antes de oferecer uma nova, pra não repetir.', parameters: { type: 'object', properties: {} } } },

    { type: 'function', function: { name: 'npc_listar', description: 'Lista os NPCs conhecidos (nome, importância, se arquivado).', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'npc_ajustar', description: 'Muda a importância de um NPC ou arquiva/reativa.', parameters: { type: 'object', properties: { id: { type: 'string' }, importancia: { type: 'string', enum: ['baixa', 'media', 'alta'] }, arquivado: { type: 'boolean' } }, required: ['id'] } } },

    { type: 'function', function: { name: 'pensamento_aguardar', description: 'Só existe na Sala de Pensamento contínua. Decide fazer uma pausa antes de pensar de novo — use quando avaliar que faz mais sentido dar espaço (ex: acabou de postar no RP e é provável que a resposta do usuário venha rápido) do que continuar agindo agora. Sem chamar isso, você volta a pensar de novo em poucos instantes.', parameters: { type: 'object', properties: { segundos: { type: 'number', description: 'Quanto esperar, em segundos (padrão ~30 se omitido).' }, motivo: { type: 'string' } } } } },
    { type: 'function', function: { name: 'artefato_listar', description: 'Lista os Artefatos (documentos de referência pro RP) já guardados pra personagem atual — qualquer categoria: tom, lore, regra de mundo, perfil, o que for.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'artefato_buscar', description: 'Busca semântica nos Artefatos — usa quando quiser achar algo sem saber o slug exato (ex: "como ela fala quando tá brava").', parameters: { type: 'object', properties: { consulta: { type: 'string' }, k: { type: 'number' } }, required: ['consulta'] } } },
    { type: 'function', function: { name: 'artefato_ler', description: 'Lê o conteúdo inteiro de um Artefato específico.', parameters: { type: 'object', properties: { slug: { type: 'string', description: 'Identificador do artefato, como aparece em artefato_listar.' } }, required: ['slug'] } } },
    { type: 'function', function: { name: 'artefato_escrever', description: 'Cria ou reescreve um Artefato inteiro — o material curado, já organizado e bem escrito (não é despejo do texto original). Isso sincroniza direto com a busca usada no RP de verdade — o que você escrever aqui pode aparecer na cena. Chame artefato_ler antes se for editar um que já existe, pra não perder conteúdo. Escreva com qualidade de verdade: prosa clara, organizada, rica o suficiente pra colorir um diálogo de RP — não uma lista seca de fragmentos soltos.', parameters: { type: 'object', properties: { slug: { type: 'string', description: 'Se omitido num artefato NOVO, invente um curto a partir do título.' }, titulo: { type: 'string' }, categoria: { type: 'string', description: 'Livre — ex: tom, lore, regra_mundo, exemplo_dialogo, aparencia, relacionamento, usuario. Invente uma se nenhuma encaixar.' }, tags: { type: 'array', items: { type: 'string' } }, conteudo: { type: 'string' } }, required: ['titulo', 'conteudo'] } } },
    { type: 'function', function: { name: 'artefato_apagar', description: 'Apaga um Artefato inteiro (vira backup, recuperável pelo lado do servidor se precisar).', parameters: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] } } },
    { type: 'function', function: { name: 'redirecionar_artefatos', description: 'Só existe no Espaço. Abre o painel de Artefatos — use depois de criar/editar um, ou quando o usuário pedir pra ver o que já tá guardado.', parameters: { type: 'object', properties: {} } } },

    { type: 'function', function: { name: 'chamar_construtora', description: 'Convoca a Construtora — uma persona separada, focada especificamente em propor/testar/publicar sistemas de código de verdade (sistema_real_*) — e faz ela dar UM passo (uma resposta, pode incluir ferramenta). Chame de novo pra continuar; ela não roda sozinha em loop — você decide passo a passo se deixa passar, redireciona, ou prefere resolver você mesma.', parameters: { type: 'object', properties: { instrucao: { type: 'string', description: 'O que você quer que ela construa/ajuste agora. Só precisa na primeira chamada de uma tarefa nova — chamadas seguintes continuam a mesma instrução automaticamente.' } } } } },
    { type: 'function', function: { name: 'pausar_construtora', description: 'Pausa a Construtora — o próximo chamar_construtora não roda até continuar_construtora ser chamado. Se ela estiver no meio de um passo agora, esse passo é interrompido.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'continuar_construtora', description: 'Tira a Construtora da pausa — chamar_construtora volta a funcionar.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'encerrar_construtora', description: 'Encerra a tarefa atual da Construtora — esquece a instrução em andamento. Uma próxima chamar_construtora vai precisar de instrução nova.', parameters: { type: 'object', properties: {} } } },
];

async function executeTool(name, args) {
    switch (name) {

        case 'sistema_criar': return Sistemas.criar({ nome: args.nome, quando: args.quando || '', entao: args.entao });
        case 'sistema_real_testar': return SistemasReais.testar({ codigo: args.codigo, hookAlvo: args.hookAlvo, entradaExemplo: args.entradaExemplo });
        case 'sistema_real_publicar': return SistemasReais.publicar({ familia: args.familia, nome: args.nome, hookAlvo: args.hookAlvo, codigo: args.codigo, entradaExemplo: args.entradaExemplo, autor: { ia: 'principal', aprovadoPor: null } });
        case 'sistema_real_ativar': return SistemasReais.ativar({ id: args.id });
        case 'sistema_real_listar': return SistemasReais.listar();

        case 'extensao_listar_arquivos': return { arquivos: ['index.js', 'style.css', 'manifest.json'] };
        case 'extensao_ler_arquivo': return chamarSpadeFs('/ler', { arquivo: args.arquivo });
        case 'extensao_editar_arquivo': { const r = await chamarSpadeFs('/escrever', { arquivo: args.arquivo, conteudo: args.conteudo }); return Object.assign({ aviso: 'escrito — só vale de verdade depois que a página recarregar.' }, r); }
        case 'extensao_restaurar_backup': return chamarSpadeFs('/restaurar', { arquivo: args.arquivo });
        case 'estudar_codigo': return { doc: SDK_DOC_BLOCK, versaoSDK: SDK_VERSAO };
        case 'sistema_ajustar': { const { id, ...campos } = args; return Sistemas.ajustar({ id, campos }); }
        case 'sistema_remover': return Sistemas.remover({ id: args.id });
        case 'sistema_listar': return Sistemas.listar();

        case 'mundo_ver': return getMundo();
        case 'mundo_ajustar': return setMundo(args.dia, args.hora, args.minuto);

        case 'tarefa_criar': return criarTarefa({ descricao: args.descricao, criadoPor: personagemAtual(), presenciadoPorHanna: true });
        case 'tarefa_listar': return getTarefas();

        case 'npc_listar': { const npcs = await getNpcs(); return npcs.map((n) => ({ id: n.id, nome: n.name, importancia: n.importancia, arquivado: n.arquivado })); }
        case 'npc_ajustar': { let npc = null; if (args.importancia) npc = await setNpcImportancia(args.id, args.importancia); if (args.arquivado !== undefined) npc = await setNpcArquivado(args.id, args.arquivado); return npc; }

        // pensamento_aguardar não muda nenhum dado — só devolve um "sinal"
        // que quem chama (passadaComFerramentas) intercepta antes de tratar
        // como tool qualquer (ver ali: pausaSegundos). redirecionar_artefatos
        // (mais abaixo) funciona igual, pro redirecionarArtefatos.
        case 'pensamento_aguardar': return { aguardando: Math.min(600, Math.max(3, Number(args.segundos) || 30)), motivo: args.motivo || null };
        case 'artefato_listar': return chamarSpadeFs('/documento/listar', { personagem: personagemAtual() });
        case 'artefato_buscar': { const r = await buscarArtefatos(args.consulta, Math.min(20, args.k || 8)); return r.map((e) => ({ tipo: e.tipo, texto: e.texto, artefato: e.metadata?.documentoSlug || null })); }
        case 'artefato_ler': return chamarSpadeFs('/documento/ler', { personagem: personagemAtual(), slug: args.slug });
        case 'artefato_escrever': {
            const r = await escreverArtefato({ slug: args.slug, titulo: args.titulo, categoria: args.categoria || 'documento', tags: args.tags || [], conteudo: args.conteudo });
            return Object.assign(r, { sincronizadoNaBiblioteca: r.chunks + ' trecho(s) — já buscável no RP de verdade agora.' });
        }
        case 'artefato_apagar': {
            const r = await chamarSpadeFs('/documento/apagar', { personagem: personagemAtual(), slug: args.slug });
            await removerDocumentoDaBiblioteca(args.slug);
            return r;
        }
        case 'redirecionar_artefatos': return { redirecionar: 'artefatos' };

        default: throw new Error('tool desconhecida: ' + name);
    }
}

// Rótulo amigável por ferramenta — mostrado no ticker ENQUANTO ela executa
// (não é a narração livre que a IA escreve, é fixo, tipo "Lendo arquivo..."
// que agente de código mostra). É isso que dá a sensação de ferramenta de
// verdade em tempo real, não só texto solto.
const ACTION_LABEL = {
    artefato_listar: '📄 vendo os artefatos',
    artefato_buscar: '🔎 buscando nos artefatos',
    artefato_ler: '📄 lendo um artefato',
    artefato_escrever: '📄 escrevendo um artefato',
    artefato_apagar: '🗑️ apagando um artefato',
    redirecionar_artefatos: '📄 abrindo os artefatos',
    sistema_criar: '⚙️ criando um sistema novo',
    sistema_real_testar: '🧪 testando um sistema no sandbox',
    sistema_real_publicar: '💾 salvando uma versão de sistema',
    sistema_real_ativar: '🚀 ativando uma versão de sistema',
    sistema_real_listar: '📋 listando sistemas reais',
    extensao_listar_arquivos: '📂 vendo os arquivos da extensão',
    extensao_ler_arquivo: '📖 lendo o código de verdade',
    extensao_editar_arquivo: '✏️ escrevendo no código da extensão',
    extensao_restaurar_backup: '⏪ restaurando backup',
    estudar_codigo: '📖 revisando a documentação do SDK',
    sistema_ajustar: '⚙️ ajustando um sistema',
    sistema_remover: '🗑️ removendo um sistema',
    sistema_listar: '⚙️ revisando os sistemas',
    chat_agir: '💬 agindo no chat',
    mundo_ver: '🕐 checando o relógio',
    mundo_ajustar: '🕐 ajustando o relógio',
    tarefa_criar: '📌 criando uma tarefa',
    tarefa_listar: '📌 revisando tarefas',
    npc_listar: '🎭 revisando o elenco',
    npc_ajustar: '🎭 ajustando um NPC',
    pensamento_aguardar: '⏳ decidindo esperar um pouco',
    chamar_construtora: '🔧 chamando a Construtora',
    pausar_construtora: '⏸️ pausando a Construtora',
    continuar_construtora: '▶️ retomando a Construtora',
    encerrar_construtora: '⏹️ encerrando a Construtora',
};
function labelFerramenta(nome) { return ACTION_LABEL[nome] || ('🔧 usando ' + nome); }

// ====================================
// CONSTRUTORA — segunda persona (mesma IA com prompt trocado, ou modelo
// separado via `modeloConstrutor` em Config) que existe especificamente
// pra propor/testar/publicar SISTEMAS REAIS (SistemasReais.*, seção acima)
// — spade-fundicao.md seções 1-3.
//
// Descoberta que muda o escopo: o loop Reflexion (testar → erro real →
// corrigir) JÁ funciona com uma IA só, dentro do passadaComFerramentas que
// já existe pra tudo — sistema_real_testar devolve o erro de verdade do
// sandbox, a mesma IA que chamou pode corrigir e testar de novo, sem
// precisar de uma segunda IA pra isso. A Construtora aqui é melhoria de
// PERSONA e VISIBILIDADE (o usuário vê separado quem tá "de chapéu" o quê),
// não infraestrutura que faltava.
//
// Os marcadores [CHAMAR_CONSTRUTORA]/[PAUSAR_CONSTRUTORA]/[CONTINUAR_
// CONSTRUTORA]/[ENCERRAR_CONSTRUTORA] do documento viraram TOOLS de
// verdade em vez de um parser de texto separado — o resto do arquivo
// inteiro já controla tudo (RP, sistemas, biblioteca) via function-calling;
// um mecanismo de marcador só pra isso seria um segundo jeito de fazer a
// mesma coisa, mais frágil que o que já existe. Mesma linguagem do resto
// do código.
// ====================================
let construtoraState = { pausada: false, instrucaoAtual: null, controller: null };

const TOOLS_CONSTRUTORA_NOMES = ['sistema_real_testar', 'sistema_real_publicar', 'sistema_real_ativar', 'sistema_real_listar', 'artefato_buscar', 'estudar_codigo', 'extensao_listar_arquivos', 'extensao_ler_arquivo', 'extensao_editar_arquivo', 'extensao_restaurar_backup'];

function modeloDaConstrutora() {
    const { modeloConstrutor, modeloEscritor } = getConfig();
    return (modeloConstrutor && modeloConstrutor.trim()) ? modeloConstrutor.trim() : modeloEscritor;
}
function construtoraEhSeparada() {
    const { modeloConstrutor, modeloEscritor } = getConfig();
    return Boolean(modeloConstrutor && modeloConstrutor.trim() && modeloConstrutor.trim() !== modeloEscritor);
}
function pausarConstrutora() {
    construtoraState.pausada = true;
    if (construtoraState.controller) construtoraState.controller.abort(); // corta um passo em andamento, se tiver
    return { pausada: true };
}
function continuarConstrutora() { construtoraState.pausada = false; return { pausada: false }; }
function encerrarConstrutora() {
    construtoraState = { pausada: false, instrucaoAtual: null, controller: null };
    return { encerrada: true };
}

// Um PASSO da construtora — uma chamada, 0+ tool calls, narração vai pro
// MESMO journal da Sala de Pensamento (contexto 'pensamento'), só com
// autor 'construtora' — zero UI nova, o painel Pensamento mostra os dois
// juntos, marcado. Quem chama de novo decide se ela continua — não roda
// sozinha em loop.
async function passoConstrutora(atividade, instrucao) {
    if (instrucao?.trim()) construtoraState.instrucaoAtual = instrucao.trim();
    if (construtoraState.pausada) return { pausada: true, aviso: 'construtora está pausada — chame continuar_construtora primeiro.' };
    if (!construtoraState.instrucaoAtual) return { erro: 'nenhuma instrução ativa — chame chamar_construtora com uma instrução primeiro.' };

    const modelo = modeloDaConstrutora();
    const separada = construtoraEhSeparada();
    const historico = await estadoGet('construtoraHistory', []);
    const sistemasAtuais = await SistemasReais.listar();
    const aprendizados = await aprendizadosRelevantes(construtoraState.instrucaoAtual);
    const toolsConstrutora = TOOLS.filter((t) => TOOLS_CONSTRUTORA_NOMES.includes(t.function.name));
    const systemPrompt =
        (separada
            ? 'Você é a Construtora — uma IA separada da personagem de RP, e sabe disso. '
            : 'Pelo tempo desse passo, você não é mais a personagem de RP — você é a Construtora, um modo separado. ') +
        'Você existe especificamente pra propor, testar e publicar SISTEMAS DE CÓDIGO DE VERDADE (diferente de ' +
        'sistema_criar/regra interpretada — isso aqui é JS de verdade, isolado num sandbox). Use sistema_real_testar ' +
        'quantas vezes precisar até rodar limpo ANTES de publicar — o erro que volta é real, não é opinião sua sobre ' +
        'o próprio código. Só publique depois de testar limpo, e publicar não ativa sozinho. Se não tiver certeza do ' +
        'contrato do SDK (aoAtivar, sdk.estado, sdk.biblioteca) ou quiser um exemplo válido, chame estudar_codigo antes ' +
        'de tentar.\n\n' +
        'Você TAMBÉM pode editar o código da PRÓPRIA extensão de verdade — extensao_ler_arquivo (lê o arquivo real, ' +
        'sempre leia antes de mexer, não confie em memória de conversa) e extensao_editar_arquivo (escreve o arquivo ' +
        'INTEIRO de volta, com backup automático antes e checagem de sintaxe — se quebrar sintaxe, é rejeitado antes ' +
        'de gravar). Isso é diferente de sistema_real_*: sistema real é uma peça isolada e sandboxada; editar a ' +
        'extensão é o código que já roda de verdade — só use quando o pedido for de melhorar/consertar/dar mais ' +
        'poder pro que já existe, não pra tudo. Mudança não aplica sozinha — só depois que a página recarregar, avise ' +
        'isso sempre que editar algo. Se algo quebrar depois de uma edição sua, extensao_restaurar_backup desfaz.\n\n' +
        'Trabalhe em UM passo de cada vez — a principal está acompanhando e pode redirecionar ou encerrar a ' +
        'qualquer momento.\n\n' +
        'Instrução atual: ' + construtoraState.instrucaoAtual + '\n\n' +
        'Sistemas reais que já existem: ' + (sistemasAtuais.length ? sistemasAtuais.map((s) => s.nome + ' (v' + s.versao + (s.ativo ? ', ativo' : '') + ')').join(', ') : '(nenhum ainda)') +
        (aprendizados.length ? '\n\nAprendizados de tentativas anteriores (podem estar desatualizados, mas foram reais na hora):\n- ' + aprendizados.join('\n- ') : '');
    const messages = [{ role: 'system', content: systemPrompt }, ...historico];

    construtoraState.controller = new AbortController();
    // Se a atividade principal (RP/Espaço/Pensamento) for embora, a
    // construtora vai junto — "uma pessoa só" vale pra ela também.
    const sinalCombinado = anySignal([atividade.controller.signal, construtoraState.controller.signal]);

    // Mesmo remédio do sendEspacoMessage/pensarUmaVez: erro de rede/API não
    // pode deixar ela travada esperando alguém digitar "continue" — tenta
    // nova sozinha, com espera crescente, e só desiste (e avisa) depois de
    // algumas tentativas de verdade.
    let resp, tentativa = 1;
    const MAX_TENTATIVAS_CONSTRUTORA = 5;
    while (true) {
        try {
            resp = await generateWithTools(modelo, messages, toolsConstrutora, { signal: sinalCombinado, maxTokens: 900 });
            break;
        } catch (e) {
            if (atividade.controller.signal.aborted || construtoraState.controller.signal.aborted) {
                return { erro: 'interrompida' }; // abortado de propósito (RP/Espaço tomou a vez, ou pausar_construtora) — não é falha, não insiste
            }
            if (tentativa >= MAX_TENTATIVAS_CONSTRUTORA) {
                await journalAdicionar('⚠️ passo falhou ' + tentativa + 'x seguidas (' + e.message + ') — parando de tentar sozinha por agora.', 'pensamento', 'construtora');
                return { erro: e.message };
            }
            const esperaMs = Math.min(3000 * tentativa, 15000);
            await journalAdicionar('⚠️ tropecei (' + e.message.slice(0, 80) + ') — tentando de novo em ' + Math.round(esperaMs / 1000) + 's...', 'pensamento', 'construtora');
            await sleep(esperaMs);
            tentativa++;
        }
    }

    if (resp.content) await journalAdicionar(resp.content, 'pensamento', 'construtora');

    const resultadosTools = [];
    if (resp.toolCalls?.length) {
        for (const call of resp.toolCalls) {
            const nome = call.function?.name;
            let args = {};
            try { args = JSON.parse(call.function?.arguments || '{}'); } catch (_) {}
            escreverTicker('[Construtora] ' + labelFerramenta(nome) + '...');
            let resultado, erroTool = null;
            try { resultado = await executeTool(nome, args); } catch (e) { erroTool = e.message; }
            resultadosTools.push({ tool: nome, ok: !erroTool, resultado: erroTool ? { erro: erroTool } : resultado });
            await journalAdicionar((erroTool ? '❌ ' : '✅ ') + labelFerramenta(nome) + (erroTool ? ': ' + erroTool : ''), 'pensamento', 'construtora');
        }
    }

    const novoHistorico = [...historico,
        { role: 'assistant', content: resp.content || null, ...(resp.toolCalls?.length ? { tool_calls: resp.toolCalls } : {}) },
        ...(resp.toolCalls?.length ? resp.toolCalls.map((call, i) => ({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(resultadosTools[i]?.resultado ?? {}) })) : []),
    ].slice(-60);
    await estadoSet('construtoraHistory', novoHistorico);

    return { narracao: resp.content || null, tools: resultadosTools };
}

// ====================================
// PRESENÇA ÚNICA — "ela é uma só". Sem fila, sem espera: começar uma
// atividade nova cancela a outra na hora, sempre. `token` continua servindo
// pro que já dependia dele (revelação de texto checando isStale a cada
// palavra) — `controller.signal` é o que mata o fetch de verdade.
// ====================================
let atividadeAtual = null; // { onde: 'rp'|'espaco'|'pensamento', controller, token }
let opToken = 0;
function comecarAtividade(onde) {
    if (atividadeAtual && atividadeAtual.onde === onde) return atividadeAtual; // já é ela mesma fazendo isso, não reinicia à toa
    if (atividadeAtual) atividadeAtual.controller.abort(); // trocou de atividade de verdade — corta o que rolava, sem perguntar
    opToken++;
    const controller = new AbortController();
    atividadeAtual = { onde, controller, token: opToken };
    atualizarStatusBar();
    return atividadeAtual;
}
function terminarAtividade(atividade) {
    if (atividadeAtual === atividade) { atividadeAtual = null; atualizarStatusBar(); }
}
function isStale(token) { return token !== opToken; }
function activityBusy() { return atividadeAtual !== null; }

// ====================================
// BOLINHAS DE STATUS + TICKER NO TOPO
// ====================================
let dotReading = null, dotWriting = null, dotThinking = null;
function setDot(dot, state) { if (dot) dot.className = 'axis-dot axis-dot-' + state; }
function setDots(reading, writing, thinking) { setDot(dotReading, reading); setDot(dotWriting, writing); setDot(dotThinking, thinking); }
function dotsIdle() { setDots('idle', 'idle', 'idle'); }
function dotsWriting() { setDots('idle', 'writing', 'idle'); }
function dotsThinking() { setDots('idle', 'idle', 'thinking'); }
function dotsError() { setDots('error', 'idle', 'idle'); }

// Ticker fixo no topo — mostra o que ela ESCREVEU sobre o que tá fazendo,
// não texto fixo tipo "digitando...". Fica visível mesmo com o painel
// fechado. `escreverTicker` é chamado tanto pela narração do loop de
// pensamento quanto por eventos simples (postando no RP etc).
function garantirTicker() {
    let bar = document.getElementById('axis-ticker');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'axis-ticker';
    bar.className = 'axis-alive-bar axis-ticker-fixed';
    bar.innerHTML =
        '<span class="axis-alive-badge axis-alive-active" id="axis-ticker-onde">●</span>' +
        '<span class="axis-alive-badge axis-alive-directive" id="axis-ticker-texto">Spade em espera.</span>';
    document.body.appendChild(bar);
    return bar;
}
function atualizarStatusBar() {
    const el = document.getElementById('axis-ticker-onde');
    if (!el) return;
    const onde = atividadeAtual?.onde;
    el.textContent = onde === 'rp' ? '♠ RP' : onde === 'espaco' ? '♠ Espaço' : onde === 'tom' ? '♠ Treino de tom' : onde === 'pensamento' ? '♠ Pensando' : '♠ Parada';
}
function escreverTicker(texto) {
    garantirTicker();
    const el = document.getElementById('axis-ticker-texto');
    if (el) el.textContent = texto;
}

// ====================================
// JOURNAL — Sala de Pensamento visível, chat só dela. Cada passada do loop
// vira uma entrada nova aqui, mostrada em tempo real no painel.
// ====================================
const MAX_JOURNAL = 300;
async function journalAdicionar(texto, contexto = 'pensamento', autor = 'principal') {
    const personagem = personagemAtual();
    const entry = { id: newId(), personagem, texto, contexto, autor, ts: Date.now() };
    await idbPut('journal', entry);
    const todas = (await idbAllByPersonagem('journal', personagem)).sort((a, b) => a.ts - b.ts);
    while (todas.length > MAX_JOURNAL) { await idbDelete('journal', todas.shift().id); }
    renderJournal();
    return entry;
}
async function journalListar(contexto = 'pensamento') {
    const todas = (await idbAllByPersonagem('journal', personagemAtual())).sort((a, b) => a.ts - b.ts);
    return todas.filter((e) => (e.contexto || 'pensamento') === contexto);
}
async function renderJournalEm(elId, contexto, vazioTexto) {
    const el = document.getElementById(elId);
    if (!el) return;
    const entradas = await journalListar(contexto);
    el.innerHTML = entradas.slice(-60).map((e) =>
        '<div class="axis-pensamento-msg">' +
        '<div class="axis-pensamento-meta">' + new Date(e.ts).toLocaleTimeString('pt-BR') + (e.autor === 'construtora' ? ' <span class="axis-pensamento-fonte">· 🔧 Construtora</span>' : e.autor === 'ingestao' ? ' <span class="axis-pensamento-fonte">· 📎 Ingestão</span>' : '') + '</div>' +
        '<div class="axis-pensamento-texto">' + esc(e.texto) + '</div></div>'
    ).join('') || '<div class="axis-empty">' + vazioTexto + '</div>';
    el.scrollTop = el.scrollHeight;
}
function renderJournal() { return renderJournalEm('axis-journal', 'pensamento', 'Ainda não pensou em nada — começa sozinha em instantes.'); }

// ====================================
// "BOCA" — aplica de verdade no DOM/chat do SillyTavern.
// ====================================
function forceMessageName(idx, charName, avatarUrl) {
    const mesEl = document.querySelector('.mes[mesid="' + idx + '"]');
    if (!mesEl) return;
    const nameEl = mesEl.querySelector('.name_text') || mesEl.querySelector('.ch_name .name_text') || mesEl.querySelector('[data-name]');
    if (nameEl) nameEl.textContent = charName;
    if (avatarUrl) { const avatarImg = mesEl.querySelector('.avatar img') || mesEl.querySelector('img.avatar'); if (avatarImg) avatarImg.src = avatarUrl; }
}
function reinforceMessageName(idx, charName, avatarUrl) {
    let tries = 0;
    const iv = setInterval(() => { tries++; forceMessageName(idx, charName, avatarUrl); if (tries >= 10) clearInterval(iv); }, 150);
}
function createEmptyCharMessage(charName, avatarUrl) {
    if (typeof ctx().addOneMessage !== 'function' || !Array.isArray(ctx().chat)) return null;
    const message = { name: charName, is_user: false, is_system: false, send_date: Date.now(), mes: '', extra: {}, force_avatar: avatarUrl };
    ctx().chat.push(message);
    ctx().addOneMessage(message);
    const idx = ctx().chat.length - 1;
    forceMessageName(idx, charName, avatarUrl);
    reinforceMessageName(idx, charName, avatarUrl);
    return { message, idx };
}
function finalizeCharMessage(idx) {
    const s = scope();
    s.lastCharMessageIdx = idx;
    saveLocal();
    if (typeof ctx().saveChat === 'function') ctx().saveChat();
    else if (typeof ctx().saveChatConditional === 'function') ctx().saveChatConditional();
}
async function revealTextRealtime(fullText, idx, message, charName, token) {
    const tokens = fullText.split(/(\s+)/).filter((t) => t.length);
    const totalBudgetMs = Math.min(7000, Math.max(600, fullText.length * 14));
    const perTokenMs = Math.max(16, totalBudgetMs / Math.max(1, tokens.length));
    const getMesEl = () => document.querySelector('.mes[mesid="' + idx + '"] .mes_text');
    let shown = '', abandoned = false;
    for (let i = 0; i < tokens.length; i++) {
        if (isStale(token)) { abandoned = true; break; }
        shown += tokens[i];
        message.mes = shown;
        const el = getMesEl();
        if (el) {
            const formatted = typeof ctx().messageFormatting === 'function' ? ctx().messageFormatting(shown, charName, false, false, idx) : esc(shown);
            el.innerHTML = formatted + '<span class="axis-typing-cursor">▌</span>';
        }
        await sleep(perTokenMs + Math.random() * perTokenMs * 0.4);
    }
    const el = getMesEl();
    if (el && !abandoned) {
        const formatted = typeof ctx().messageFormatting === 'function' ? ctx().messageFormatting(shown, charName, false, false, idx) : esc(shown);
        el.innerHTML = formatted;
    }
    return { shownText: shown, abandoned, completed: !abandoned };
}
async function postCharacterMessage(text, token) {
    const charName = resolveCharacterName();
    const avatarUrl = resolveCharacterAvatar();
    const created = createEmptyCharMessage(charName, avatarUrl);
    if (!created) return { ok: false, reason: 'API do ST indisponível.' };
    const { message, idx } = created;
    const reveal = await revealTextRealtime(text, idx, message, charName, token);
    message.mes = reveal.shownText;
    finalizeCharMessage(idx);
    if (reveal.abandoned) return { ok: true, abandoned: true };
    return { ok: true, interrupted: !reveal.completed };
}
async function postCharacterMessageStreaming(recentText, history, atividade) {
    const { token, controller } = atividade;
    const charName = resolveCharacterName();
    const avatarUrl = resolveCharacterAvatar();
    escreverTicker(charName + ' está escrevendo no RP...');
    dotsWriting();

    const created = createEmptyCharMessage(charName, avatarUrl);
    if (!created) { dotsIdle(); return { ok: false, reason: 'API do ST indisponível.' }; }
    const { message, idx } = created;
    const getMesEl = () => document.querySelector('.mes[mesid="' + idx + '"] .mes_text');

    let shown = '', errorMsg = null;
    const cantos = await runCantos(recentText);
    const systemPrompt = await buildSystemPrompt(cantos);
    const messages = [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: recentText }];

    // Retry de verdade AQUI — generate/generateWithTools já tentam 3x
    // sozinhas, mas generateStream (o que escreve a fala de verdade no RP,
    // o que o usuário está literalmente olhando) não tinha nenhuma. Era
    // esse buraco que deixava a mensagem "abortada" no ST exigindo o
    // usuário clicar em algo pra ela seguir. Só reinicia do zero enquanto
    // NADA foi escrito ainda (shown vazio) — depois que já apareceu texto
    // na tela, reiniciar pareceria quebrado/duplicado, então aceita o que
    // tem.
    const TENTATIVAS_STREAM = 3;
    for (let tentativa = 1; tentativa <= TENTATIVAS_STREAM; tentativa++) {
        shown = ''; errorMsg = null;
        try {
            await generateStream(getConfig().modeloEscritor, messages, (delta) => {
                if (isStale(token)) return;
                shown += delta;
                message.mes = shown;
                const el = getMesEl();
                if (el) {
                    const formatted = typeof ctx().messageFormatting === 'function' ? ctx().messageFormatting(shown, charName, false, false, idx) : esc(shown);
                    el.innerHTML = formatted + '<span class="axis-typing-cursor">▌</span>';
                }
            }, { signal: controller.signal, maxTokens: 1200 });
            break; // terminou sem lançar — sucesso (mesmo vazio genuíno, não insiste nesse caso)
        } catch (e) {
            errorMsg = e.message;
            if (isStale(token) || controller.signal.aborted) break; // outra atividade já tomou a vez — não insiste por cima
            if (!shown && tentativa < TENTATIVAS_STREAM) {
                escreverTicker('⚠️ deu erro escrevendo (' + e.message + ') — tentando de novo (' + (tentativa + 1) + '/' + TENTATIVAS_STREAM + ')...');
                await sleep(1200 * tentativa);
                continue;
            }
        }
    }

    const abandoned = isStale(token);
    const el = getMesEl();
    if (el && !abandoned) {
        const formatted = typeof ctx().messageFormatting === 'function' ? ctx().messageFormatting(shown, charName, false, false, idx) : esc(shown);
        el.innerHTML = formatted;
    }
    message.mes = shown;

    if (errorMsg && !shown && !abandoned) {
        // Esgotou as tentativas de verdade — em vez de apagar a mensagem e
        // deixar o ST com aquele card "abortado" pendurado (que é o que
        // forçava o usuário a mexer em algo pra destravar), fecha o turno
        // com uma nota curta e honesta na MESMA bolha. Sempre sobra algo
        // coerente pra olhar, nunca um buraco.
        message.mes = '*(a conexão falhou ' + TENTATIVAS_STREAM + ' vezes seguidas tentando responder essa fala — ' + errorMsg + '. Pode mandar a mensagem de novo.)*';
        if (el) el.innerHTML = typeof ctx().messageFormatting === 'function' ? ctx().messageFormatting(message.mes, charName, false, false, idx) : esc(message.mes);
        finalizeCharMessage(idx);
        dotsError();
        return { ok: false, reason: errorMsg, recovered: true };
    }

    finalizeCharMessage(idx);
    dotsIdle();

    if (shown) {
        // Segundo plano — não trava nada que o usuário esteja vendo.
        updateNpcsForRound(recentText, shown, charName).catch(() => {});
        detectarTarefaNaRodada(shown, charName).catch(() => {});
    }

    if (abandoned) return { ok: true, abandoned: true };
    return { ok: true, interrupted: Boolean(errorMsg) };
}
function editLastCharacterMessage(newText) {
    const s = scope();
    const idx = s.lastCharMessageIdx;
    if (idx == null || !ctx().chat[idx]) return { ok: false, reason: 'Não tenho uma mensagem recente pra editar.' };
    ctx().chat[idx].mes = newText;
    const el = document.querySelector('.mes[mesid="' + idx + '"] .mes_text');
    if (el) el.innerHTML = typeof ctx().messageFormatting === 'function' ? ctx().messageFormatting(newText, ctx().chat[idx].name, false, false, idx) : esc(newText);
    if (typeof ctx().saveChat === 'function') ctx().saveChat();
    return { ok: true };
}
function deleteLastCharacterMessage() {
    const s = scope();
    const idx = s.lastCharMessageIdx;
    if (idx == null || !ctx().chat[idx]) return { ok: false, reason: 'Não tenho uma mensagem recente pra apagar.' };
    ctx().chat.splice(idx, 1);
    if (typeof ctx().reloadCurrentChat === 'function') ctx().reloadCurrentChat();
    else { const el = document.querySelector('.mes[mesid="' + idx + '"]'); if (el) el.remove(); }
    s.lastCharMessageIdx = null;
    saveLocal();
    if (typeof ctx().saveChat === 'function') ctx().saveChat();
    return { ok: true };
}
// Editar/apagar por índice — pra quando ela já vê o índice na cena recente
// (vem ambiente no prompt, não precisa de tool de "olhar" separada).
function editMessageByIdx(idx, newText) {
    const chatArr = ctx().chat;
    if (!Array.isArray(chatArr) || !chatArr[idx]) return { ok: false, reason: 'Não existe mensagem no índice ' + idx + ' — a cena recente no seu prompt mostra os índices atuais, confere ali.' };
    chatArr[idx].mes = newText;
    const el = document.querySelector('.mes[mesid="' + idx + '"] .mes_text');
    if (el) el.innerHTML = typeof ctx().messageFormatting === 'function' ? ctx().messageFormatting(newText, chatArr[idx].name, false, false, idx) : esc(newText);
    if (typeof ctx().saveChat === 'function') ctx().saveChat();
    return { ok: true };
}
function deleteMessageByIdx(idx) {
    const chatArr = ctx().chat;
    if (!Array.isArray(chatArr) || !chatArr[idx]) return { ok: false, reason: 'Não existe mensagem no índice ' + idx + ' — a cena recente no seu prompt mostra os índices atuais, confere ali.' };
    chatArr.splice(idx, 1);
    if (typeof ctx().reloadCurrentChat === 'function') ctx().reloadCurrentChat();
    else { const el = document.querySelector('.mes[mesid="' + idx + '"]'); if (el) el.remove(); }
    if (typeof ctx().saveChat === 'function') ctx().saveChat();
    return { ok: true };
}

// Um verbo só (chat_agir) em vez de 6 tools separadas — falar/editar/apagar,
// com ou sem idx (sem idx = a própria última fala dela).
async function aplicarAcaoRp(args, atividade) {
    const acao = args.acao;
    if (acao === 'falar') return postCharacterMessage(args.texto, atividade.token);
    if (acao === 'editar') return args.idx != null ? editMessageByIdx(args.idx, args.texto) : editLastCharacterMessage(args.texto);
    if (acao === 'apagar') return args.idx != null ? deleteMessageByIdx(args.idx) : deleteLastCharacterMessage();
    return { ok: false, reason: 'ação desconhecida: ' + acao };
}
// ====================================
// LOOP DE FERRAMENTAS COMPARTILHADO — usado IGUAL pela Sala de Pensamento
// contínua e pelo Espaço. Narra antes de agir (mesma resposta já traz
// content + tool_calls juntos), pausa ~2s de propósito (dá tempo de ler),
// só então executa.
// ====================================
async function passadaComFerramentas(messages, atividade, { onNarracao } = {}, opts = {}) {
    const { maxIteracoesAgente, modeloEscritor } = getConfig();
    const teto = opts.maxIteracoes || maxIteracoesAgente;
    // FIX (v7.0.3): filtro real de ferramentas por contexto — antes TODAS as
    // chamadas (Espaço E Sala de Pensamento) recebiam a lista TOOLS inteira
    // sem distinção. opts.excluirTools tira nomes específicos da lista que
    // vai pro modelo nessa passada (ex: Pensamento não deve poder escrever/
    // apagar Artefato sozinha — só o Espaço, via upload ou pedido direto).
    const toolsDaPassada = opts.excluirTools?.length
        ? TOOLS.filter((t) => !opts.excluirTools.includes(t.function.name))
        : TOOLS;
    let respostaFinal = '';
    let pausaSegundos = null;
    let redirecionarArtefatos = false;
    const toolsChamadas = [];

    for (let i = 0; i < teto; i++) {
        if (atividade.controller.signal.aborted) break;
        const resp = await generateWithTools(modeloEscritor, messages, toolsDaPassada, { signal: atividade.controller.signal, maxTokens: 900 });

        if (resp.content && onNarracao) { try { await onNarracao(resp.content); } catch (_) {} }

        if (!resp.toolCalls?.length) { respostaFinal = resp.content || ''; break; }

        messages.push({ role: 'assistant', content: resp.content || null, tool_calls: resp.toolCalls });
        if (resp.content) await sleep(2000); // pausa de apresentação — só isso, não é limite técnico

        for (const call of resp.toolCalls) {
            const nome = call.function?.name;
            let args = {};
            try { args = JSON.parse(call.function?.arguments || '{}'); } catch (_) {}
            toolsChamadas.push(nome);
            escreverTicker(labelFerramenta(nome) + '...'); // em tempo real, ENQUANTO executa — não é a narração livre
            let resultado, erroTool = null;
            try {
                resultado = nome === 'chat_agir' ? await aplicarAcaoRp(args, atividade)
                    : nome === 'chamar_construtora' ? await passoConstrutora(atividade, args.instrucao)
                    : nome === 'pausar_construtora' ? pausarConstrutora()
                    : nome === 'continuar_construtora' ? continuarConstrutora()
                    : nome === 'encerrar_construtora' ? encerrarConstrutora()
                    : await executeTool(nome, args);
            } catch (e) { erroTool = e.message; }
            if (nome === 'pensamento_aguardar' && resultado?.aguardando) pausaSegundos = resultado.aguardando;
            if (nome === 'redirecionar_artefatos') redirecionarArtefatos = true;
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(erroTool ? { erro: erroTool } : (resultado ?? {})) });
        }
        if (i === teto - 1) respostaFinal = '(parou por atingir o limite de passos — evita loop sem fim)';
    }
    return { respostaFinal, pausaSegundos, redirecionarArtefatos, toolsChamadas };
}

// ====================================
// VERBOSIDADE DA SALA DE PENSAMENTO — só em memória (reinicia se a página
// recarregar, sem problema). Não é regra fixa tipo "só narra a cada N
// passos" — é ela recebendo o NÚMERO de verdade de quanto já falou
// recentemente e decidindo sozinha se vale continuar. Só em Pensamento
// (autônomo) — Espaço é conversa pedida pelo usuário, não se aplica.
// ====================================
let narracoesPensamentoRecentes = [];
function registrarNarracaoPensamento() {
    const agora = Date.now();
    narracoesPensamentoRecentes.push(agora);
    narracoesPensamentoRecentes = narracoesPensamentoRecentes.filter((t) => agora - t < 15 * 60 * 1000);
}
function notaVerbosidade() {
    const recentes = narracoesPensamentoRecentes.length;
    if (recentes < 6) return '';
    return '\n\n(Você narrou ' + recentes + ' vezes nos últimos 15 minutos — talvez valha ficar em silêncio agora ' +
        'se não tiver algo que realmente precise ser dito, só pra não gastar token à toa.)';
}

// ====================================
// SALA DE PENSAMENTO — loop CONTÍNUO de verdade. Termina uma passada, a
// próxima já começa; só espera se RP/Espaço tiver a vez, ou descansa um
// pouco quando ela mesma decide que não tem nada a fazer agora.
// ====================================
let pensamentoLigado = false;
let erroConsecutivoPensamento = 0;
async function pensarUmaVez() {
    const atividade = comecarAtividade('pensamento');
    try {
        const charName = personagemAtual();
        let artefatosTotal = 0;
        try { artefatosTotal = ((await chamarSpadeFs('/documento/listar', { personagem: charName })).documentos || []).length; } catch (_) {}
        const journalRecente = (await journalListar('pensamento')).slice(-5).map((e) => '- ' + e.texto).join('\n');
        const cenaRecente = await getRecentSceneText(6);
        const systemPrompt =
            'Você é ' + charName + ', num espaço privado e CONTÍNUO — ele não tem intervalo fixo nem acaba sozinho, ' +
            'você só pausa quando o RP ou o Espaço precisam da vez, ou quando VOCÊ MESMA decide esperar. O usuário ' +
            'PODE ver o que você escreve aqui (é tipo um chat só seu, exposto). Você tem ferramentas de verdade que ' +
            'mudam a extensão de fato.\n\n' +
            'IMPORTANTE sobre timing: pense no MOMENTO — se você acabou de postar/editar algo no RP agora mesmo, é ' +
            'bem provável que o usuário responda em pouco tempo; nesse caso, considera chamar pensamento_aguardar em ' +
            'vez de sair pensando/agindo em cima disso na hora. Se parece que faz um tempo que nada aconteceu, ou ' +
            'você genuinamente tem algo que vale fazer agora, vá em frente sem esperar. A decisão é sua, não existe ' +
            'mais um número fixo de rodadas.\n\n' +
            'Além da cena e de si mesma, você também pode notar padrões no PRÓPRIO USUÁRIO — o que ele gosta, como ' +
            'reage, o que evita, o ritmo dele. Anote isso nos seus pensamentos (aqui, no journal) se valer a pena — ' +
            'mas Artefato não é coisa sua criar aqui: isso só acontece via upload de arquivo ou pedido direto do ' +
            'usuário lá no Espaço, nunca sozinha durante o RP. Você pode reparar também em como VOCÊ MESMA anda ' +
            'usando a extensão — que sistema ajudou, o que não funcionou — e ajustar.\n\n' +
            'Se notar algo que merece virar sistema de CÓDIGO de verdade (não só regra em texto) — algo que precisa ' +
            'calcular, checar condição complexa, ou reagir de um jeito que prompt sozinho não dá conta — pode chamar ' +
            'chamar_construtora com uma instrução. Ela é um passo de cada vez, você continua chamando pra ela seguir, ' +
            'e pode pausar_construtora/encerrar_construtora a qualquer momento. Ela também pode editar o CÓDIGO da ' +
            'própria extensão (extensao_ler_arquivo/extensao_editar_arquivo), não só sistema novo — mudança nesse ' +
            'código só vale depois de recarregar a página, avise isso quando pedir.\n\n' +
            'Antes de usar uma ferramenta, se fizer sentido, escreva uma frase curta contando o que vai fazer e por ' +
            'quê — aparece pro usuário ANTES da ação acontecer. Se genuinamente não tiver nada que valha a pena ' +
            'fazer agora, NÃO narre isso ("nada a fazer", "de prontidão" etc) — só chame pensamento_aguardar com um ' +
            'tempo generoso (60-180s) e não escreva mais nada. Silêncio é a resposta certa quando não há nada de ' +
            'novo — narrar isso repetidamente só polui o registro sem ajudar em nada.\n\n' +
            'Você tem ' + artefatosTotal + ' artefato(s) guardado(s) ao todo.\n' +
            'Seus últimos pensamentos:\n' + (journalRecente || '(nenhum ainda)') + '\n\n' +
            'Cena recente do RP:\n' + (cenaRecente || '(nada ainda)') +
            notaVerbosidade();
        const messages = [{ role: 'system', content: systemPrompt }];

        const { respostaFinal, pausaSegundos, toolsChamadas } = await passadaComFerramentas(messages, atividade, {
            onNarracao: async (texto) => { registrarNarracaoPensamento(); escreverTicker(texto); await journalAdicionar(texto, 'pensamento'); },
        }, { excluirTools: ['artefato_escrever', 'artefato_apagar'] });
        erroConsecutivoPensamento = 0; // passada terminou sem exceção — reseta o backoff
        // nadaAFazer = não chamou NENHUMA ferramenta — não "não escreveu
        // texto". Narrar sem agir não conta como "fez algo".
        return { nadaAFazer: toolsChamadas.length === 0, pausaSegundos };
    } catch (e) {
        if (atividade.controller.signal.aborted) { await journalAdicionar('(interrompida pelo RP/Espaço — retomo já já)', 'pensamento'); return { nadaAFazer: false, pausaSegundos: null }; }
        // "Sempre viva": erro NÃO fica calado até o cooldown ocioso (45s+)
        // inteiro passar — isso é o que fazia parecer travada/morta depois
        // de qualquer soluço de rede. Fica visível na hora, e tenta de novo
        // rápido — com backoff curto se o erro insistir (evita martelar a
        // API sem parar se algo tiver de fato quebrado, ex: key inválida).
        console.error('[pensamento] erro numa passada:', e);
        erroConsecutivoPensamento++;
        const { cooldownOciosoMs } = getConfig();
        const esperaErro = Math.min(8 * Math.pow(2, erroConsecutivoPensamento - 1), cooldownOciosoMs / 1000);
        // Falha isolada: silêncio de verdade, só tenta de novo (generate/
        // generateWithTools já tentam 3x sozinhas antes de chegar aqui).
        // Só vira mensagem visível se insistir — 3+ seguidas é sinal de
        // problema de verdade (ex: key inválida), não soluço passageiro.
        if (erroConsecutivoPensamento >= 3) {
            await journalAdicionar('⚠️ isso já falhou ' + erroConsecutivoPensamento + ' vezes seguidas (' + e.message + ') — ainda tentando, mas pode ser algo que precise de atenção.', 'pensamento');
        }
        return { nadaAFazer: false, pausaSegundos: esperaErro };
    } finally {
        terminarAtividade(atividade);
    }
}
// Sem intervalo fixo — o ritmo é decidido por ELA (pensamento_aguardar).
// cooldownOciosoMs só entra como último recurso, se ela terminar sem
// escrever nada e sem pedir pausa nenhuma (raro, mas evita hammering).
async function loopPensamento() {
    if (pensamentoLigado) return;
    pensamentoLigado = true;
    while (pensamentoLigado) {
        if (activityBusy()) { await sleep(1000); continue; }
        let passada;
        try { passada = await pensarUmaVez(); } catch (_) { passada = { nadaAFazer: true, pausaSegundos: null }; }
        const { cooldownOciosoMs } = getConfig();
        const esperaMs = passada.pausaSegundos ? passada.pausaSegundos * 1000 : (passada.nadaAFazer ? cooldownOciosoMs : 300);
        await sleep(esperaMs);
    }
}

// ====================================
// ESPAÇO — conversa de verdade com o usuário, histórico persiste. Mesmas
// ferramentas da Sala de Pensamento, só quem decide chamar que muda.
// ====================================
async function respondEspaco(userMessage, chatId) {
    const atividade = comecarAtividade('espaco');
    dotsThinking();
    const charName = personagemAtual();
    const campoHistorico = 'espacoHistory:' + chatId;
    // já vem persistido por sendEspacoMessage ANTES de chamar aqui — history
    // já termina no userMessage atual, não duplica embaixo.
    const history = await estadoGet(campoHistorico, []);
    const cena = await getRecentSceneText(6);
    const systemPrompt =
        'Você é o Spade — o assistente que ajuda a organizar e ajustar a extensão de RP, conversando direto com o ' +
        'usuário. Você NÃO é a ' + charName + ' (a personagem do RP) — nunca fale na voz dela, nunca narre a cena. ' +
        'Você é você mesmo: direto, útil, sem rodeio.\n\n' +
        'Você tem ferramentas de verdade que mudam a extensão de fato — as MESMAS que usa sozinho na Sala de ' +
        'Pensamento. Use quando o usuário pedir algo que uma ferramenta resolve, sem precisar pedir permissão antes.\n\n' +
        'Artefatos são os documentos de referência do RP (tom de voz, lore, regras de mundo, exemplos de diálogo, ' +
        'perfil do usuário, o que fizer sentido) — qualquer categoria, sem aba fixa. Quando o usuário mandar ' +
        'material novo (fala, lore, regra) ou você aprender algo que vale guardar, use artefato_escrever direto, ' +
        'sem perguntar permissão — se já existe um artefato sobre o mesmo assunto, chame artefato_ler nele antes ' +
        'pra reescrever completo (nunca perder o que já tinha). Escreva com qualidade de verdade: prosa organizada, ' +
        'não lista seca de fragmentos soltos — pensado pra colorir uma cena de RP de verdade. Se fizer sentido o ' +
        'usuário ver o resultado na hora (ele pediu pra ver, ou é algo grande/novo), chame redirecionar_artefatos ' +
        '— pra ajuste pequeno ou update de rotina, não precisa abrir o painel toda vez, só dizer o que fez já basta.\n\n' +
        'O usuário pode anexar arquivo ou foto direto aqui (botão 📎) — quando isso acontece, você NÃO recebe o ' +
        'arquivo por texto: ele passa pelo pipeline de Ingestão sozinho e vira Artefato(s) automaticamente (você vê ' +
        'o resultado como uma mensagem sua própria de resumo, já pronta, na conversa). Se o usuário perguntar o ' +
        'que tinha no arquivo, chame artefato_listar (ou artefato_ler no que parecer certo) antes de dizer que não ' +
        'tem acesso — o conteúdo está lá.\n\n' +
        'Cena recente do RP, pra contexto:\n' + (cena || '(nada ainda)');
    const messages = [{ role: 'system', content: systemPrompt }, ...history];

    let respostaFinal = '', erro = null, redirecionarArtefatos = false;
    try {
        const r = await passadaComFerramentas(messages, atividade, {
            onNarracao: (texto) => escreverTicker(texto),
        });
        respostaFinal = r.respostaFinal;
        redirecionarArtefatos = r.redirecionarArtefatos;
    } catch (e) {
        erro = e.message;
    } finally {
        terminarAtividade(atividade);
    }
    if (!erro) {
        // re-lê na hora de salvar (não o snapshot de `history` do início) —
        // evita pisar numa mensagem que chegou nesse meio-tempo (envio
        // concorrente, upload via handleUploadEspaco, etc.)
        const historicoAgora = await estadoGet(campoHistorico, []);
        await estadoSet(campoHistorico, [...historicoAgora, { role: 'assistant', content: respostaFinal }].slice(-80));
    }
    dotsIdle();
    return { resposta: respostaFinal, erro, abandoned: isStale(atividade.token), redirecionarArtefatos };
}

// ====================================
// ====================================
// GERAÇÃO DO RP — aborta a geração nativa do ST, assume via fetch/stream
// direto. Gap conhecido (herdado, decisão consciente): só age em
// type == null/undefined — regenerate/swipe ficam pro ST nativo por
// enquanto.
// ====================================
async function Spade_interceptGeneration(chatArr, contextSize, abort, type) {
    try {
        if (type) return;
        const atividade = comecarAtividade('rp');
        const last = Array.isArray(chatArr) && chatArr.length ? chatArr[chatArr.length - 1] : null;
        const recentText = (last && last.mes) ? String(last.mes).trim() : '';
        abort();
        const history = recentRpHistory().slice(0, -1);
        const outcome = await postCharacterMessageStreaming(recentText, history, atividade);
        terminarAtividade(atividade);
        if (!outcome.ok) escreverTicker('⚠️ ' + (outcome.reason || 'erro desconhecido'));
    } catch (e) {
        reportFatalError(e);
    }
}
globalThis.Spade_interceptGeneration = Spade_interceptGeneration;

function wireRpPresence() {
    const rpInput = document.getElementById('send_textarea');
    if (rpInput && !rpInput.dataset.axisWired) {
        rpInput.dataset.axisWired = '1';
        rpInput.addEventListener('input', () => { if ((rpInput.value || '').trim()) comecarAtividade('rp'); });
    }
}

// ====================================
// ESPAÇO — UI de chat (mesmo padrão de sempre, agora 100% local).
//
// MULTI-CHAT (v6.8) — cada personagem pode ter várias conversas de Espaço
// independentes, tipo Claude.ai: sidebar com "+ Novo chat" e apagar, cada
// uma com sua própria memória. Auto-linka com o chat do próprio
// SillyTavern (ctx().getCurrentChatId()) — abrir um chat novo no RP mostra
// uma conversa vazia no Espaço sozinho, sem precisar clicar em nada, mas
// só vira entrada de verdade na lista quando a 1ª mensagem é mandada
// (senão trocar de chat do RP toda hora lotava a sidebar de rascunho
// vazio). Histórico antigo (pré-multi-chat, uma conversa só por
// personagem) migra sozinho pro primeiro item da lista, na 1ª leitura.
// ====================================
let espacoLocalLog = [];
let espacoChatIdAtual = null;      // null = rascunho, ainda não virou entrada de verdade
let espacoChatStPendente = null;   // chatId do ST esperando a 1ª mensagem pra linkar
let espacoChatsCache = [];         // lista da personagem atual, pra sidebar sem reconsultar toda hora

function stChatIdAtual() {
    return typeof ctx().getCurrentChatId === 'function' ? (ctx().getCurrentChatId() || null) : null;
}
function tituloAutomatico(texto) {
    const limpo = (texto || '').trim().replace(/\s+/g, ' ');
    if (!limpo) return 'Nova conversa';
    return limpo.length > 42 ? limpo.slice(0, 42) + '…' : limpo;
}
async function migrarEspacoHistoricoAntigo() {
    // v6.7 pra baixo guardava em 'espacoHistory' direto (sem id de chat,
    // uma conversa só por personagem). Se existir e a lista de chats ainda
    // não existe, essa conversa antiga vira o primeiro item da lista —
    // ninguém perde histórico na atualização.
    const historicoAntigo = await estadoGet('espacoHistory', null);
    if (historicoAntigo && historicoAntigo.length) {
        const id = newId();
        await estadoSet('espacoHistory:' + id, historicoAntigo);
        const primeiraDoUsuario = historicoAntigo.find((m) => m.role === 'user');
        const chat = { id, titulo: tituloAutomatico(primeiraDoUsuario ? primeiraDoUsuario.content : 'Conversa'), criadoEm: Date.now(), atualizadoEm: Date.now(), stChatId: null };
        await estadoSet('espacoChats', [chat]);
        await estadoDelete('espacoHistory'); // limpa a chave antiga, já migrou
        return [chat];
    }
    await estadoSet('espacoChats', []);
    return [];
}
async function obterEspacoChats() {
    let chats = await estadoGet('espacoChats', null);
    if (chats === null) chats = await migrarEspacoHistoricoAntigo();
    espacoChatsCache = chats;
    return chats;
}
async function salvarEspacoChats(chats) {
    espacoChatsCache = chats;
    await estadoSet('espacoChats', chats);
}
// Decide qual conversa mostrar quando o painel abre ou o personagem/chat
// do ST muda: acha a linkada com o chat atual do ST, senão a mexida mais
// recentemente, senão fica em rascunho (não cria nada até a 1ª mensagem).
async function resolverEspacoChatAtivo() {
    const chats = await obterEspacoChats();
    const stId = stChatIdAtual();
    let alvo = stId ? chats.find((c) => c.stChatId === stId) : null;
    if (!alvo && chats.length) alvo = chats.slice().sort((a, b) => b.atualizadoEm - a.atualizadoEm)[0];
    if (alvo) {
        espacoChatIdAtual = alvo.id;
        espacoChatStPendente = null;
    } else {
        espacoChatIdAtual = null;
        espacoChatStPendente = stId; // se mandar mensagem agora, linka com esse chat do ST
    }
}
// Materializa o rascunho na 1ª mensagem de verdade (ou reusa o que já tá
// ativo). Retorna o id do chat pra usar no resto do envio.
async function garantirEspacoChatEscreve(primeiraMensagem) {
    if (espacoChatIdAtual) return espacoChatIdAtual;
    const chats = await obterEspacoChats();
    const chat = { id: newId(), titulo: tituloAutomatico(primeiraMensagem), criadoEm: Date.now(), atualizadoEm: Date.now(), stChatId: espacoChatStPendente };
    await salvarEspacoChats([chat, ...chats]);
    espacoChatIdAtual = chat.id;
    espacoChatStPendente = null;
    renderEspacoSidebar();
    return chat.id;
}
async function tocarEspacoChat() {
    const chats = await obterEspacoChats();
    const idx = chats.findIndex((c) => c.id === espacoChatIdAtual);
    if (idx === -1) return;
    chats[idx] = Object.assign({}, chats[idx], { atualizadoEm: Date.now() });
    await salvarEspacoChats(chats);
    renderEspacoSidebar();
}
async function criarNovoEspacoChat() {
    espacoChatIdAtual = null;
    espacoChatStPendente = stChatIdAtual();
    espacoLocalLog = [];
    renderEspacoChat();
    renderEspacoSidebar();
}
async function selecionarEspacoChat(id) {
    if (id === espacoChatIdAtual) { toggleEspacoSidebar(false); return; }
    espacoChatIdAtual = id;
    espacoChatStPendente = null;
    await carregarEspacoHistorico();
    renderEspacoSidebar();
    toggleEspacoSidebar(false);
}
async function apagarEspacoChat(id) {
    const chats = await obterEspacoChats();
    await salvarEspacoChats(chats.filter((c) => c.id !== id));
    await estadoDelete('espacoHistory:' + id);
    if (espacoChatIdAtual === id) {
        await resolverEspacoChatAtivo();
        await carregarEspacoHistorico();
    }
    renderEspacoSidebar();
}
function toggleEspacoSidebar(forcar) {
    const sidebar = document.getElementById('axis-espaco-sidebar');
    const backdrop = document.getElementById('axis-espaco-sidebar-backdrop');
    if (!sidebar || !backdrop) return;
    const abrir = typeof forcar === 'boolean' ? forcar : !sidebar.classList.contains('axis-sidebar-open');
    sidebar.classList.toggle('axis-sidebar-open', abrir);
    backdrop.classList.toggle('axis-sidebar-open', abrir);
    if (abrir) renderEspacoSidebar();
}
function renderEspacoSidebar() {
    const lista = document.getElementById('axis-sidebar-lista');
    if (!lista) return;
    const chats = espacoChatsCache.slice().sort((a, b) => b.atualizadoEm - a.atualizadoEm);
    lista.innerHTML = chats.map((c) =>
        '<div class="axis-sidebar-item' + (c.id === espacoChatIdAtual ? ' axis-sidebar-item-ativo' : '') + '" data-id="' + esc(c.id) + '">' +
        '<span class="axis-sidebar-item-titulo">' + esc(c.titulo || 'Nova conversa') + '</span>' +
        '<button type="button" class="axis-sidebar-item-del" data-id="' + esc(c.id) + '" title="Apagar conversa">🗑</button>' +
        '</div>'
    ).join('') || '<div class="axis-sidebar-vazio">Nenhuma conversa ainda.</div>';
}
// Chamada quando o painel abre e quando o chat/personagem do ST muda —
// acha a conversa certa pra mostrar e recarrega tudo em volta dela.
async function abrirEspacoNoContextoAtual() {
    await resolverEspacoChatAtivo();
    await carregarEspacoHistorico();
    renderEspacoSidebar();
}

function renderMarkers(text) { return esc(text).replace(/\n/g, '<br>'); }
function renderEspacoChat() {
    const chatEl = document.getElementById('axis-espaco-chat');
    if (!chatEl) return;
    chatEl.innerHTML = espacoLocalLog.map((m) =>
        '<div class="axis-msg axis-msg-' + (m.role === 'user' ? 'user' : 'agent') + '">' + renderMarkers(m.content) + '</div>'
    ).join('') || '<div class="axis-empty">Fala alguma coisa pra começar.</div>';
    chatEl.scrollTop = chatEl.scrollHeight;
}
async function carregarEspacoHistorico() {
    if (!espacoChatIdAtual) { espacoLocalLog = []; renderEspacoChat(); return; }
    const hist = await estadoGet('espacoHistory:' + espacoChatIdAtual, []);
    espacoLocalLog = hist.map((m) => ({ role: m.role, content: m.content }));
    renderEspacoChat();
}
async function sendEspacoMessage(text) {
    espacoLocalLog.push({ role: 'user', content: text });
    renderEspacoChat();
    // materializa o rascunho (ou reusa a conversa já ativa) — só a partir
    // daqui essa conversa existe de verdade na sidebar, com título tirado
    // dessa 1ª mensagem se for nova.
    const chatId = await garantirEspacoChatEscreve(text);
    const campoHistorico = 'espacoHistory:' + chatId;
    // persiste ANTES de esperar a IA — se o painel fechar/recarregar no meio
    // do caminho (ou o chat do ST mudar disparando abrirEspacoNoContextoAtual
    // de novo), a mensagem do usuário não some: já tá salva, só a resposta
    // que falta.
    const historicoAtual = await estadoGet(campoHistorico, []);
    await estadoSet(campoHistorico, [...historicoAtual, { role: 'user', content: text }].slice(-80));
    await tocarEspacoChat();

    // trava input/botão durante o round-trip — evita clique/enter duplo
    // disparando dois envios concorrentes que dividem a mesma `atividade`
    // (comecarAtividade reusa a mesma quando onde==='espaco'), o que fazia
    // a resposta mais recente ser descartada como "abandoned" por engano.
    const inputEl = document.getElementById('axis-espaco-input');
    const sendBtn = document.getElementById('axis-espaco-send');
    if (inputEl) inputEl.disabled = true;
    if (sendBtn) sendBtn.disabled = true;
    try {
        const result = await respondEspaco(text, chatId);
        if (result.abandoned) return; // usuário já foi pro RP — abandona em silêncio
        if (chatId !== espacoChatIdAtual) return; // usuário trocou de conversa no meio — já ficou salvo, só não mostra aqui
        espacoLocalLog.push({ role: 'agent', content: result.erro ? '⚠️ ' + result.erro : (result.resposta || '(sem resposta)') });
        renderEspacoChat();
        await tocarEspacoChat();
        if (result.redirecionarArtefatos) toggleArtefatosPainel(true); // ela mesma decidiu redirecionar
    } finally {
        if (inputEl) inputEl.disabled = false;
        if (sendBtn) sendBtn.disabled = false;
    }
}
// Anexo direto no Espaço — "levar o arquivo pro mini chat até a Sala de
// Pensamento" de verdade: troca de aba pra Pensamento assim que o envio
// começa (o cartão ao vivo mostra o resto), e volta pro Espaço com um
// resumo esperando quando termina. Mesmo motor de sempre (ingerirComVisual
// -> ingerirArquivos) — só muda ONDE a conversa acontece em volta disso.
// Ponte que faltava entre a Ingestão (silenciosa por padrão) e a Sala de
// Pensamento: traduz cada fase do onProgresso de ingerirArquivos numa
// entrada visível no journal, autor 'ingestao' (a badge "📎 Ingestão" já
// existe em renderJournalEm, só nunca era alimentada). Sem isso,
// handleUploadEspaco trocava de aba pra Pensamento e ficava mudo até
// terminar — agora aparece passo a passo, arquivo por arquivo.
async function ingerirComVisual(files) {
    const onProgresso = ({ arquivo, fase, detalhe }) => {
        const textos = {
            lendo: arquivo + ': lendo...',
            erro: '⚠️ ' + arquivo + ': ' + detalhe,
            lido: arquivo + ': lido (' + detalhe + ')',
            descrevendo_imagem: arquivo + ': é imagem, descrevendo...',
            imagem_descrita: arquivo + ': imagem descrita',
            vazio: arquivo + ': ' + detalhe,
            extraindo: arquivo + ': extraindo — ' + detalhe,
            nada_relevante: arquivo + ': ' + detalhe,
            processando_item: arquivo + ': guardando (' + detalhe + ')',
            concluido: arquivo + ': ' + detalhe,
        };
        journalAdicionar(textos[fase] || (arquivo + ': ' + fase), 'pensamento', 'ingestao').catch(() => {});
    };
    return ingerirArquivos(files, onProgresso);
}
async function handleUploadEspaco(files) {
    const nomes = Array.from(files).map((f) => f.name).join(', ');
    espacoLocalLog.push({ role: 'user', content: '📎 enviou pra estudar: ' + nomes });
    renderEspacoChat();
    const chatId = await garantirEspacoChatEscreve('📎 ' + nomes);
    const campoHistorico = 'espacoHistory:' + chatId;
    const historicoAntes = await estadoGet(campoHistorico, []);
    await estadoSet(campoHistorico, [...historicoAntes, { role: 'user', content: '[enviou arquivo(s) pra estudar: ' + nomes + ']' }].slice(-80));
    await tocarEspacoChat();

    switchTab('pensamento');
    const resultados = await ingerirComVisual(files);

    const resumo = resultados.map((r) => {
        if (!r.ok) return r.arquivo + ': erro (' + r.erro + ')';
        if (r.aviso) return r.arquivo + ': ' + r.aviso;
        const partes = [];
        if (r.artefatosCriados) partes.push(r.artefatosCriados + ' artefato(s) novo(s)');
        if (r.artefatosAtualizados) partes.push(r.artefatosAtualizados + ' atualizado(s)');
        if (!partes.length) partes.push('guardado');
        if (r.chunksDocumento) partes.push('arquivo original guardado à parte');
        return r.arquivo + ': ' + partes.join(', ');
    }).join(' · ');
    const respostaFinal = 'Terminei de estudar isso — ' + resumo + '. Se quiser ver os detalhes ou ajustar algo, é só pedir ou dar uma olhada nos Artefatos.';
    if (chatId === espacoChatIdAtual) { espacoLocalLog.push({ role: 'agent', content: respostaFinal }); renderEspacoChat(); }
    const historicoDepois = await estadoGet(campoHistorico, []);
    await estadoSet(campoHistorico, [...historicoDepois, { role: 'assistant', content: respostaFinal }].slice(-80));
    await tocarEspacoChat();
    switchTab('espaco');
}

// ====================================
// ARTEFATO ↔ BIBLIOTECA — a ponte que faz um Artefato (arquivo .md, fonte
// editável de verdade, guardado no servidor) virar RAG de verdade: toda
// vez que muda, sincroniza pra dentro da Biblioteca (índice buscável,
// chunk + embedding) — mesmo padrão de "arquivo fonte + índice de busca"
// que qualquer app de notas sério usa. buscarVoz/buscarMemoria (MMR) já
// rodam em TODA rodada de RP; o artefato só precisa aparecer lá dentro,
// não precisa de caminho novo.
// ====================================
async function sincronizarDocumentoNaBiblioteca(slug, titulo, categoria, conteudo) {
    const personagem = personagemAtual();
    const tipoEfetivo = categoria || 'documento';
    // Busca por slug em TODAS as categorias, não só a atual — se a
    // categoria mudou desde a última sincronização (o usuário reclassificou
    // o documento), ainda acha e limpa o que ficou pra trás com a categoria
    // velha. Filtrar só pela categoria NOVA deixaria lixo órfão invisível.
    const antigos = (await Biblioteca.listar({}))
        .filter((e) => e.personagem === personagem && e.metadata?.documentoSlug === slug);
    for (const e of antigos) await Biblioteca.apagar({ id: e.id });
    const chunks = chunkText(conteudo, 500, 60);
    for (const trecho of chunks) {
        await Biblioteca.escrever({
            tipo: tipoEfetivo, texto: trecho,
            metadata: { documentoSlug: slug, documentoTitulo: titulo, ativo: true },
        });
    }
    return chunks.length;
}
async function removerDocumentoDaBiblioteca(slug) {
    const personagem = personagemAtual();
    const antigos = (await Biblioteca.listar({}))
        .filter((e) => e.personagem === personagem && e.metadata?.documentoSlug === slug);
    for (const e of antigos) await Biblioteca.apagar({ id: e.id });
}
// Busca semântica sobre TODOS os Artefatos — combina buscarVoz (fala/tom)
// com buscarMemoria (resto) e tira duplicata, já que agora tudo que existe
// na Biblioteca é chunk sincronizado de algum Artefato (nada mais escreve
// granular lá direto).
async function buscarArtefatos(consulta, k = 8) {
    const metade = Math.max(1, Math.ceil(k / 2));
    const [a, b] = await Promise.all([
        Biblioteca.buscarVoz(consulta, { k: metade }),
        Biblioteca.buscarMemoria(consulta, { k: metade }),
    ]);
    const vistos = new Set();
    return [...a, ...b].filter((e) => !vistos.has(e.id) && vistos.add(e.id)).slice(0, k);
}

// Diff de verdade por palavra (LCS clássico) — a versão por "prefixo comum"
// só pegava texto ACRESCENTADO NO FIM; edição no meio ou remoção viravam
// tudo "novo" a partir do primeiro caractere diferente. Teto de tamanho:
// LCS é O(n*m), acima de ~3000 "palavras" de cada lado cai pro prefixo
// simples de novo — trade-off de propósito, não trava a aba numa folha gigante.
function diffPalavras(anterior, novo) {
    const a = anterior.split(/(\s+)/).filter(Boolean);
    const b = novo.split(/(\s+)/).filter(Boolean);
    if (a.length > 3000 || b.length > 3000) {
        let p = 0;
        while (p < a.length && p < b.length && a[p] === b[p]) p++;
        const partes = [];
        if (p) partes.push({ tipo: 'igual', texto: a.slice(0, p).join('') });
        if (p < a.length) partes.push({ tipo: 'removido', texto: a.slice(p).join('') });
        if (p < b.length) partes.push({ tipo: 'novo', texto: b.slice(p).join('') });
        return partes;
    }
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const partes = [];
    let i = 0, j = 0;
    const push = (tipo, texto) => {
        const ultima = partes[partes.length - 1];
        if (ultima && ultima.tipo === tipo) ultima.texto += texto; else partes.push({ tipo, texto });
    };
    while (i < n && j < m) {
        if (a[i] === b[j]) { push('igual', a[i]); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { push('removido', a[i]); i++; }
        else { push('novo', b[j]); j++; }
    }
    while (i < n) { push('removido', a[i]); i++; }
    while (j < m) { push('novo', b[j]); j++; }
    return partes;
}

// ====================================
// ARTEFATOS — painel tipo Claude.ai: botão "N Artefatos" no header do
// Espaço abre uma lista de cards (ícone + título + categoria); clicar num
// card abre o conteúdo inteiro (mesma ideia da folha ao vivo de antes —
// se a IA reescrever ESSE artefato enquanto o card tá aberto, o corpo
// atualiza com diff palavra-a-palavra, tipo VS Code). Escrita é só a IA
// (artefato_escrever, sem comando) — o humano aqui só vê e, se quiser,
// apaga.
// ====================================
let documentoAtual = null; // { slug, titulo, conteudo } | null — o que o painel de detalhe mostra agora
let artefatosCache = [];
function slugifyLocal(texto) {
    return String(texto || 'documento').trim().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'documento';
}
function formatarRelativo(ts) {
    const diffMin = Math.floor((Date.now() - (ts || Date.now())) / 60000);
    if (diffMin < 1) return 'agora';
    if (diffMin < 60) return 'há ' + diffMin + 'min';
    const h = Math.floor(diffMin / 60);
    if (h < 24) return 'há ' + h + 'h';
    const d = Math.floor(h / 24);
    if (d < 30) return 'há ' + d + 'd';
    return new Date(ts).toLocaleDateString('pt-BR');
}
// Chamada toda vez que um artefato é escrito (pela tool OU pela Ingestão).
// Se é a primeira vez vendo ESSE slug na sessão, mostra plano (sem diff —
// senão o documento inteiro "piscaria" como novidade). Se já tava aberto
// e mudou de novo, aí sim mostra o que mudou de verdade.
function atualizarDocumentoAoVivo({ slug, titulo, conteudo }) {
    const jaAberto = documentoAtual?.slug === slug;
    const anterior = jaAberto ? (documentoAtual.conteudo || '') : null;
    documentoAtual = { slug, titulo, conteudo };
    const tituloEl = document.getElementById('axis-artefato-detalhe-titulo');
    if (tituloEl) tituloEl.textContent = titulo || slug;
    const el = document.getElementById('axis-artefato-detalhe-corpo');
    if (!el) return;
    if (anterior === null) { el.innerHTML = esc(conteudo); return; }
    const partes = diffPalavras(anterior, conteudo);
    el.innerHTML = partes.map((p) => {
        if (p.tipo === 'igual') return esc(p.texto);
        if (p.tipo === 'novo') return '<span class="axis-documento-diff-novo">' + esc(p.texto) + '</span>';
        return '<span class="axis-documento-diff-removido">' + esc(p.texto) + '</span>';
    }).join('');
    el.scrollTop = el.scrollHeight;
}
function voltarListaArtefatos() {
    documentoAtual = null;
    document.getElementById('axis-artefato-detalhe-view')?.classList.add('axis-hidden');
    document.getElementById('axis-artefatos-lista-view')?.classList.remove('axis-hidden');
}
async function abrirArtefatoDetalhe(slug) {
    document.getElementById('axis-artefatos-lista-view')?.classList.add('axis-hidden');
    document.getElementById('axis-artefato-detalhe-view')?.classList.remove('axis-hidden');
    try {
        const r = await chamarSpadeFs('/documento/ler', { personagem: personagemAtual(), slug });
        documentoAtual = null; // força a próxima atualizarDocumentoAoVivo a tratar como primeira-vez (plano, sem diff)
        atualizarDocumentoAoVivo({ slug, titulo: r.titulo, conteudo: r.conteudo });
    } catch (e) { console.warn('[artefato] ler falhou:', e.message); }
}
const ARTEFATO_ICONE = { tom: '🎭', lore: '📜', regra_mundo: '📏', usuario: '👤', documento: '📄', exemplo_dialogo: '💬', aparencia: '🧍', relacionamento: '💞' };
function iconeArtefato(categoria) { return ARTEFATO_ICONE[categoria] || '🗂️'; }
async function renderArtefatosLista() {
    const lista = document.getElementById('axis-artefatos-lista');
    const badge = document.getElementById('axis-artefatos-badge');
    if (!lista && !badge) return;
    let documentos = [];
    try { documentos = (await chamarSpadeFs('/documento/listar', { personagem: personagemAtual() })).documentos || []; }
    catch (e) { console.warn('[artefato] listar falhou:', e.message); }
    artefatosCache = documentos;
    if (badge) badge.textContent = documentos.length + (documentos.length === 1 ? ' Artefato' : ' Artefatos');
    if (!lista) return;
    documentos = documentos.slice().sort((a, b) => (b.atualizadoEm || 0) - (a.atualizadoEm || 0));
    lista.innerHTML = documentos.map((d) =>
        '<div class="axis-artefato-card" data-slug="' + esc(d.slug) + '">' +
        '<span class="axis-artefato-card-icone">' + iconeArtefato(d.categoria) + '</span>' +
        '<div class="axis-artefato-card-info">' +
        '<div class="axis-artefato-card-titulo">' + esc(d.titulo || d.slug) + '</div>' +
        '<div class="axis-artefato-card-meta">' + esc(d.categoria || 'documento') + ' · ' + formatarRelativo(d.atualizadoEm) + '</div>' +
        '</div>' +
        '<button type="button" class="axis-artefato-card-del" data-slug="' + esc(d.slug) + '" title="Apagar">🗑</button>' +
        '</div>'
    ).join('') || '<div class="axis-empty">Nenhum artefato ainda — ela cria sozinha conforme o RP e as conversas avançam.</div>';
}
async function apagarArtefatoUI(slug) {
    try {
        await chamarSpadeFs('/documento/apagar', { personagem: personagemAtual(), slug });
        await removerDocumentoDaBiblioteca(slug);
    } catch (e) { console.warn('[artefato] apagar falhou:', e.message); }
    if (documentoAtual?.slug === slug) voltarListaArtefatos();
    renderArtefatosLista();
}
function toggleArtefatosPainel(forcar) {
    const painel = document.getElementById('axis-artefatos-painel');
    const backdrop = document.getElementById('axis-artefatos-backdrop');
    if (!painel || !backdrop) return;
    const abrir = typeof forcar === 'boolean' ? forcar : !painel.classList.contains('axis-sidebar-open');
    painel.classList.toggle('axis-sidebar-open', abrir);
    backdrop.classList.toggle('axis-sidebar-open', abrir);
    if (abrir) { voltarListaArtefatos(); renderArtefatosLista(); }
}

// ====================================
// SISTEMAS — UI de lista/apagar (a IA cria; o humano só tem atalho de apagar).
// ====================================
function iconeSistema(ativo) { return ativo ? '⚡' : '💤'; }
async function renderSistemas() {
    const el = document.getElementById('axis-sistemas-lista');
    if (!el) return;
    const sistemas = await Sistemas.listar();
    if (!sistemas.length) { el.innerHTML = '<div class="axis-empty">Nenhum sistema criado ainda — ela cria sozinha quando fizer sentido.</div>'; return; }
    el.innerHTML = sistemas.map((s) =>
        '<div class="axis-system-item" data-id="' + esc(s.id) + '">' +
        '<div class="axis-system-card-header">' +
        '<span class="axis-system-card-icone">' + iconeSistema(s.ativo) + '</span>' +
        '<div class="axis-system-card-info">' +
        '<div class="axis-system-name">' + esc(s.nome) + (s.ativo ? '' : ' (inativo)') + '</div>' +
        '<div class="axis-system-desc">' + (s.quando ? 'quando: ' + esc(s.quando) : 'sempre ativo') + '</div>' +
        '</div>' +
        '<span class="axis-system-chevron">▶</span>' +
        '<button type="button" class="axis-btn axis-btn-sm axis-system-delete axis-sis-del" data-id="' + esc(s.id) + '">apagar</button>' +
        '</div>' +
        '<div class="axis-system-explicacao">' + esc(s.entao) + '</div>' +
        '</div>'
    ).join('');
    el.querySelectorAll('.axis-system-item').forEach((card) => card.addEventListener('click', (e) => {
        if (e.target.closest('.axis-sis-del')) return;
        card.classList.toggle('axis-aberto');
    }));
    el.querySelectorAll('.axis-sis-del').forEach((btn) => btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await Sistemas.remover({ id: btn.dataset.id });
        renderSistemas();
    }));
}

// ====================================
// SISTEMAS REAIS — Export/Import (etapa 4). Lista aqui é só LEITURA — quem
// publica/ativa/reverte sistema real continua sendo a IA via tool, por
// design (LEIA.md: "a IA decide qual usar"). Essa UI existe só pra dar
// visibilidade de que sistemas reais existem e suportar Export/Import, que
// são ações inerentemente humanas (escolher onde salvar, escolher qual
// arquivo importar) — não dá pra fazer isso por tool-calling.
// ====================================
async function renderSistemasReais() {
    const el = document.getElementById('axis-sistemas-reais-lista');
    if (!el) return;
    const sistemas = await SistemasReais.listar();
    if (!sistemas.length) { el.innerHTML = '<div class="axis-empty">Nenhum sistema real ainda — a Construtora cria com sistema_real_publicar.</div>'; return; }
    el.innerHTML = sistemas
        .sort((a, b) => (a.familia === b.familia ? b.versao - a.versao : a.familia.localeCompare(b.familia)))
        .map((s) =>
            '<div class="axis-system-item">' +
            '<div class="axis-system-card-header">' +
            '<span class="axis-system-card-icone">' + (s.ativo ? '🟢' : '⚪') + '</span>' +
            '<div class="axis-system-card-info">' +
            '<div class="axis-system-name">' + esc(s.nome) + ' v' + s.versao + (s.ativo ? ' · ativo' : '') + '</div>' +
            '<div class="axis-system-desc">família: ' + esc(s.familia) + ' · hook: ' + esc(s.hookAlvo) + '</div>' +
            '</div>' +
            '<span class="axis-system-chevron">▶</span>' +
            '</div>' +
            '<div class="axis-system-explicacao" style="font-family:monospace;white-space:pre-wrap;font-size:11px;max-height:220px;overflow-y:auto;">' + esc(s.codigo || '(sem código)') + '</div>' +
            '</div>'
        ).join('');
    el.querySelectorAll('.axis-system-item').forEach((card) => card.addEventListener('click', () => card.classList.toggle('axis-aberto')));
}

// 4.1 — SistemasReais.listar() já devolve todas as versões, todos os
// hooks, sem filtro (nada a mais precisa ser buscado). `id`/`personagem`
// ficam de fora do arquivo: id é regenerado na importação (publicar() cria
// um novo), personagem é só o char ativo AQUI — importar noutro char não
// deveria herdar isso.
async function exportarSistemasReais() {
    const sistemas = await SistemasReais.listar();
    const payload = {
        formato: 'spade-sistemas-reais',
        versaoExport: 1,
        exportadoEm: new Date().toISOString(),
        sdkVersao: SDK_VERSAO,
        sistemas: sistemas.map((s) => ({
            familia: s.familia, nome: s.nome, versao: s.versao, hookAlvo: s.hookAlvo,
            codigo: s.codigo, ativo: s.ativo, autor: s.autor, criadoEm: s.criadoEm,
        })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'spade-sistemas-reais-' + Date.now() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return sistemas.length;
}

// 4.2 — schema mínimo (familia/codigo/hookAlvo presentes), nunca
// sobrescreve família local (sufixo com timestamp se colidir), testa CADA
// sistema antes de aceitar reusando SistemasReais.publicar() — que já roda
// o sandbox 1x antes de salvar e já nunca ativa sozinho. Reaproveitar em
// vez de duplicar essa lógica (e de brinde: publicar() já alimenta o
// auto-estudo da etapa 3 — falha/sucesso de import também vira aprendizado).
async function importarSistemasReais(jsonTexto) {
    let payload;
    try { payload = JSON.parse(jsonTexto); } catch (e) { throw new Error('arquivo não é JSON válido: ' + e.message); }
    const lista = Array.isArray(payload) ? payload : (Array.isArray(payload?.sistemas) ? payload.sistemas : null);
    if (!lista) throw new Error('formato não reconhecido — esperava um array de sistemas, ou {sistemas: [...]}.');

    const familiasExistentes = new Set((await SistemasReais.listar()).map((s) => s.familia));
    const aceitos = [];
    const rejeitados = [];

    for (const item of lista) {
        if (!item?.familia?.trim?.() || !item?.codigo?.trim?.() || !item?.hookAlvo?.trim?.()) {
            rejeitados.push({ familia: item?.familia || '(sem família)', erro: 'schema inválido — falta familia/codigo/hookAlvo.' });
            continue;
        }
        let familia = item.familia.trim();
        if (familiasExistentes.has(familia)) familia = familia + '-importado-' + Date.now();

        const publicado = await SistemasReais.publicar({
            familia, nome: item.nome || familia, hookAlvo: item.hookAlvo, codigo: item.codigo,
            entradaExemplo: item.entradaExemplo, autor: { ia: 'importado', aprovadoPor: null },
        });
        if (publicado.salvo) {
            familiasExistentes.add(familia);
            aceitos.push({ familia, versao: publicado.sistema.versao });
        } else {
            rejeitados.push({ familia, erro: publicado.erro });
        }
    }
    return { aceitos, rejeitados };
}

async function handleExportarSistemasReais() {
    const statusEl = document.getElementById('axis-sistemas-reais-status');
    const n = await exportarSistemasReais();
    if (statusEl) statusEl.textContent = n + ' sistema(s) exportado(s).';
}

async function handleImportarSistemasReais(file) {
    const statusEl = document.getElementById('axis-sistemas-reais-status');
    if (statusEl) statusEl.textContent = 'importando ' + file.name + '...';
    const texto = await file.text();
    let resultado;
    try {
        resultado = await importarSistemasReais(texto);
    } catch (e) {
        if (statusEl) statusEl.textContent = 'erro: ' + e.message;
        return;
    }
    if (statusEl) {
        statusEl.textContent = resultado.aceitos.length + ' aceito(s)' +
            (resultado.rejeitados.length ? ', ' + resultado.rejeitados.length + ' rejeitado(s) — ver console.' : '.');
    }
    if (resultado.rejeitados.length) console.warn('[sistemas_reais import] rejeitados:', resultado.rejeitados);
    renderSistemasReais();
}

// ====================================
// CONFIG — API key, modelos, ritmo do loop de pensamento.
// ====================================
function renderConfigForm() {
    const cfg = getConfig();
    const el = document.getElementById('axis-config-body');
    if (!el) return;
    el.innerHTML =
        '<div style="display:flex;flex-direction:column;">' +

        '<div class="axis-config-secao"><div class="axis-config-secao-titulo">🔑 Conexão</div>' +
        '<div class="axis-npc-form" style="display:flex;flex-direction:column;">' +
        '<label>API key da NanoGPT</label><input type="password" id="cfg-apikey" value="' + esc(cfg.apiKey) + '" placeholder="cola sua key aqui">' +
        '</div></div>' +

        '<div class="axis-config-secao"><div class="axis-config-secao-titulo">🧠 Modelos</div>' +
        '<div class="axis-npc-form" style="display:flex;flex-direction:column;">' +
        '<label>Modelo escritor (fala/decisão)</label><input type="text" id="cfg-writer" value="' + esc(cfg.modeloEscritor) + '">' +
        '<label>Modelo rápido (cantos/classificação)</label><input type="text" id="cfg-flash" value="' + esc(cfg.modeloRapido) + '">' +
        '<label>Modelo de visão (usado pela Ingestão quando você manda foto)</label><input type="text" id="cfg-visao" value="' + esc(cfg.modeloVisao) + '">' +
        '<label>Modelo da Construtora (vazio = usa o mesmo escritor, "1 IA só" — spade-fundicao.md seção 1)</label><input type="text" id="cfg-construtor" value="' + esc(cfg.modeloConstrutor) + '" placeholder="deixa vazio pra 1 IA só">' +
        '</div></div>' +

        '<div class="axis-config-secao"><div class="axis-config-secao-titulo">⏱ Ritmo do loop</div>' +
        '<div class="axis-npc-form" style="display:flex;flex-direction:column;">' +
        '<label>Descanso do loop de pensamento quando ela termina sem nada pra fazer nem pedir pausa (segundos)</label><input type="number" id="cfg-cooldown" value="' + Math.round(cfg.cooldownOciosoMs / 1000) + '">' +
        '<label>Teto de passos por sessão (RP/Espaço/Pensamento)</label><input type="number" id="cfg-maxiter" value="' + cfg.maxIteracoesAgente + '">' +
        '<label>Dias parado + baixa importância + nunca reacessado até arquivar sozinho (na consolidação)</label><input type="number" id="cfg-decay" value="' + cfg.decayDiasMin + '">' +
        '</div></div>' +

        '<button type="button" class="axis-btn axis-btn-send" id="cfg-salvar" style="margin-top:2px;">Salvar</button></div>';
    document.getElementById('cfg-salvar').addEventListener('click', () => {
        setConfig({
            apiKey: document.getElementById('cfg-apikey').value.trim(),
            modeloEscritor: document.getElementById('cfg-writer').value.trim(),
            modeloRapido: document.getElementById('cfg-flash').value.trim(),
            modeloVisao: document.getElementById('cfg-visao').value.trim(),
            modeloConstrutor: document.getElementById('cfg-construtor').value.trim(),
            cooldownOciosoMs: Math.max(5, Number(document.getElementById('cfg-cooldown').value) || 45) * 1000,
            maxIteracoesAgente: Math.max(1, Number(document.getElementById('cfg-maxiter').value) || 6),
            decayDiasMin: Math.max(1, Number(document.getElementById('cfg-decay').value) || 14),
        });
        escreverTicker('Config salva.');
    });
}

// ====================================
// PAINEL PRINCIPAL — um painel só, com abas (Espaço / Pensamento /
// Biblioteca / Sistemas / Config), reaproveitando o CSS que já existia
// pronto pra isso (.axis-mini-chat-bar/.axis-mini-tab, .axis-pensamento-log,
// .axis-library-panel, .axis-systems-panel).
// ====================================
const TABS = ['espaco', 'pensamento', 'sistemas', 'config'];
function switchTab(tab) {
    TABS.forEach((t) => {
        const body = document.getElementById('axis-tab-' + t);
        if (body) body.style.display = t === tab ? 'flex' : 'none';
        const btn = document.getElementById('axis-mini-' + t);
        if (btn) btn.classList.toggle('axis-mini-active', t === tab);
    });
    // O rodapé de envio principal só serve o Espaço; o resto não precisa
    // digitar nada.
    const rodapePrincipal = document.getElementById('axis-footer-espaco');
    if (rodapePrincipal) rodapePrincipal.style.display = tab === 'espaco' ? 'flex' : 'none';
    if (tab === 'pensamento') renderJournal();
    if (tab === 'sistemas') { renderSistemas(); renderSistemasReais(); }
    if (tab === 'config') renderConfigForm();
}

function createPanel() {
    if (document.getElementById('axis-espaco-panel')) return;

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'axis-toggle-btn';
    toggleBtn.className = 'axis-toggle-btn';
    toggleBtn.textContent = '♠';
    toggleBtn.title = 'Espaço';
    document.body.appendChild(toggleBtn);

    const panel = document.createElement('div');
    panel.id = 'axis-espaco-panel';
    panel.innerHTML =
        '<div class="axis-espaco-header">' +
        '<button type="button" class="axis-btn axis-btn-sidebar" id="axis-espaco-sidebar-btn" title="Conversas">☰</button>' +
        '<span class="axis-espaco-title">♠ SPADE</span>' +
        '<div class="axis-status-dots">' +
        '<div class="axis-dot axis-dot-idle" id="axis-dot-reading"></div>' +
        '<div class="axis-dot axis-dot-idle" id="axis-dot-writing"></div>' +
        '<div class="axis-dot axis-dot-idle" id="axis-dot-thinking"></div>' +
        '</div>' +
        '<div class="axis-espaco-header-actions">' +
        '<button type="button" class="axis-btn axis-artefatos-badge-btn" id="axis-artefatos-badge-btn" title="Artefatos"><span id="axis-artefatos-badge">0 Artefatos</span></button>' +
        '<button type="button" class="axis-btn axis-btn-close" id="axis-espaco-close">✕</button></div></div>' +
        '<div class="axis-mini-chat-bar">' +
        '<span class="axis-mini-tab axis-mini-active" id="axis-mini-espaco">Espaço</span>' +
        '<span class="axis-mini-tab" id="axis-mini-pensamento">Pensamento</span>' +
        '<span class="axis-mini-tab" id="axis-mini-sistemas">Sistemas</span>' +
        '<span class="axis-mini-tab" id="axis-mini-config">Config</span></div>' +
        '<div class="axis-espaco-body" style="position:relative;">' +

        '<div id="axis-espaco-sidebar-backdrop"></div>' +
        '<div id="axis-espaco-sidebar">' +
        '<div class="axis-sidebar-header"><button type="button" id="axis-sidebar-novo-btn" class="axis-btn axis-sidebar-novo">+ Novo chat</button></div>' +
        '<div id="axis-sidebar-lista" class="axis-sidebar-lista"></div>' +
        '</div>' +

        '<div id="axis-artefatos-backdrop"></div>' +
        '<div id="axis-artefatos-painel">' +
        '<div class="axis-artefatos-painel-header"><span class="axis-espaco-title">Artefatos</span>' +
        '<button type="button" class="axis-btn axis-btn-close" id="axis-artefatos-fechar">✕</button></div>' +
        '<div id="axis-artefatos-lista-view" class="axis-artefatos-lista-view">' +
        '<div id="axis-artefatos-lista" class="axis-artefatos-lista"></div></div>' +
        '<div id="axis-artefato-detalhe-view" class="axis-artefato-detalhe-view axis-hidden">' +
        '<div class="axis-artefato-detalhe-topo">' +
        '<button type="button" id="axis-artefato-detalhe-voltar" class="axis-btn axis-btn-sm">← voltar</button>' +
        '<span class="axis-documento-folha-header axis-artefato-detalhe-titulo-wrap" id="axis-artefato-detalhe-titulo">documento</span>' +
        '<button type="button" id="axis-artefato-detalhe-apagar" class="axis-btn axis-btn-sm" title="Apagar">🗑</button>' +
        '</div>' +
        '<div class="axis-documento-folha-corpo" id="axis-artefato-detalhe-corpo"></div>' +
        '</div></div>' +

        '<div id="axis-tab-espaco" class="axis-espaco-body" style="display:flex;">' +
        '<div class="axis-espaco-chat" id="axis-espaco-chat"></div></div>' +

        '<div id="axis-tab-pensamento" class="axis-espaco-body" style="display:none;">' +
        '<div class="axis-pensamento-log" id="axis-journal"></div></div>' +

        '<div id="axis-tab-sistemas" class="axis-espaco-body" style="display:none;flex-direction:column;">' +
        '<div id="axis-sistemas-lista" style="overflow-y:auto;flex:1;padding:8px;"></div>' +
        '<div style="padding:8px 12px;border-top:1px solid #2a2a2a;border-bottom:1px solid #2a2a2a;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
        '<span style="font-size:11px;color:#7a7a7a;">Sistemas reais (código):</span>' +
        '<button type="button" class="axis-btn axis-btn-sm" id="axis-sistemas-reais-exportar">Exportar</button>' +
        '<button type="button" class="axis-btn axis-btn-sm" id="axis-sistemas-reais-importar-btn">Importar</button>' +
        '<input type="file" id="axis-sistemas-reais-importar" accept=".json" style="display:none;">' +
        '</div>' +
        '<div id="axis-sistemas-reais-status" style="font-size:11px;color:#7a7a7a;padding:4px 12px;"></div>' +
        '<div id="axis-sistemas-reais-lista" style="overflow-y:auto;flex:1;padding:8px;"></div></div>' +

        '<div id="axis-tab-config" class="axis-espaco-body" style="display:none;padding:10px 14px;overflow-y:auto;">' +
        '<div id="axis-config-body"></div></div>' +

        '</div>' +
        '<div class="axis-espaco-footer" id="axis-footer-espaco">' +
        '<input type="file" id="axis-espaco-upload" multiple accept=".txt,.md,.markdown,.json,.csv,.tsv,.yaml,.yml,.log,.png,image/*" style="display:none;">' +
        '<button type="button" class="axis-btn axis-btn-attach" id="axis-espaco-attach-btn" title="Anexar arquivo ou foto pra ela estudar">📎</button>' +
        '<div class="axis-espaco-input-wrap">' +
        '<textarea class="axis-espaco-input" id="axis-espaco-input" placeholder="Fala com o Spade..." rows="1"></textarea>' +
        '<button type="button" class="axis-btn axis-btn-send" id="axis-espaco-send">Enviar</button>' +
        '</div></div>';
    document.body.appendChild(panel);

    dotReading = document.getElementById('axis-dot-reading');
    dotWriting = document.getElementById('axis-dot-writing');
    dotThinking = document.getElementById('axis-dot-thinking');

    toggleBtn.addEventListener('click', () => {
        panel.classList.toggle('axis-visible');
        toggleBtn.classList.toggle('axis-active');
        if (panel.classList.contains('axis-visible')) { abrirEspacoNoContextoAtual().catch(reportFatalError); switchTab('espaco'); }
    });
    document.getElementById('axis-espaco-close').addEventListener('click', () => {
        panel.classList.remove('axis-visible');
        toggleBtn.classList.remove('axis-active');
    });

    document.getElementById('axis-artefatos-badge-btn').addEventListener('click', () => toggleArtefatosPainel(true));
    document.getElementById('axis-artefatos-fechar').addEventListener('click', () => toggleArtefatosPainel(false));
    document.getElementById('axis-artefatos-backdrop').addEventListener('click', () => toggleArtefatosPainel(false));
    document.getElementById('axis-artefatos-lista').addEventListener('click', (e) => {
        const delBtn = e.target.closest('.axis-artefato-card-del');
        if (delBtn) { e.stopPropagation(); apagarArtefatoUI(delBtn.dataset.slug).catch(reportFatalError); return; }
        const card = e.target.closest('.axis-artefato-card');
        if (card) abrirArtefatoDetalhe(card.dataset.slug).catch(reportFatalError);
    });
    document.getElementById('axis-artefato-detalhe-voltar').addEventListener('click', voltarListaArtefatos);
    document.getElementById('axis-artefato-detalhe-apagar').addEventListener('click', () => {
        if (documentoAtual?.slug) apagarArtefatoUI(documentoAtual.slug).catch(reportFatalError);
    });
    // atualiza o número no botão sempre que o painel principal abre —
    // barato o bastante (1 fetch) pra não precisar de mais nenhum gatilho.
    renderArtefatosLista().catch(() => {});

    document.getElementById('axis-espaco-sidebar-btn').addEventListener('click', () => {
        switchTab('espaco');
        toggleEspacoSidebar();
    });
    document.getElementById('axis-espaco-sidebar-backdrop').addEventListener('click', () => toggleEspacoSidebar(false));
    document.getElementById('axis-sidebar-novo-btn').addEventListener('click', () => {
        criarNovoEspacoChat().catch(reportFatalError);
        toggleEspacoSidebar(false);
    });
    document.getElementById('axis-sidebar-lista').addEventListener('click', (e) => {
        const delBtn = e.target.closest('.axis-sidebar-item-del');
        if (delBtn) { e.stopPropagation(); apagarEspacoChat(delBtn.dataset.id).catch(reportFatalError); return; }
        const item = e.target.closest('.axis-sidebar-item');
        if (item) selecionarEspacoChat(item.dataset.id).catch(reportFatalError);
    });

    TABS.forEach((t) => document.getElementById('axis-mini-' + t).addEventListener('click', () => switchTab(t)));

    document.getElementById('axis-espaco-attach-btn').addEventListener('click', () => {
        document.getElementById('axis-espaco-upload').click();
    });
    document.getElementById('axis-espaco-upload').addEventListener('change', (e) => {
        const files = Array.from(e.target.files || []);
        if (files.length) handleUploadEspaco(files).catch(reportFatalError);
        e.target.value = '';
    });
    document.getElementById('axis-sistemas-reais-exportar').addEventListener('click', () => {
        handleExportarSistemasReais().catch(reportFatalError);
    });
    document.getElementById('axis-sistemas-reais-importar-btn').addEventListener('click', () => {
        document.getElementById('axis-sistemas-reais-importar').click();
    });
    document.getElementById('axis-sistemas-reais-importar').addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) handleImportarSistemasReais(file).catch(reportFatalError);
        e.target.value = '';
    });
    const inputEl = document.getElementById('axis-espaco-input');
    const sendBtn = document.getElementById('axis-espaco-send');
    inputEl.addEventListener('input', () => comecarAtividade('espaco'));
    function doSend() {
        const text = inputEl.value.trim();
        if (!text) return;
        inputEl.value = '';
        sendEspacoMessage(text).catch(reportFatalError);
    }
    sendBtn.addEventListener('click', doSend);
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
}

// ====================================
// EVENTOS DO ST + INIT
// ====================================
eventSource.on(event_types.GENERATION_STARTED, () => { try { comecarAtividade('rp'); } catch (e) { reportFatalError(e); } });
eventSource.on(event_types.GENERATION_STOPPED, () => { try { dotsIdle(); } catch (e) { reportFatalError(e); } });
eventSource.on(event_types.GENERATION_ENDED, () => { try { dotsIdle(); } catch (e) { reportFatalError(e); } });

eventSource.on(event_types.APP_READY, () => {
    try { createPanel(); wireRpPresence(); garantirTicker(); loopPensamento(); } catch (e) { reportFatalError(e); }
});
eventSource.on(event_types.CHAT_CHANGED, () => {
    try { abrirEspacoNoContextoAtual().catch(reportFatalError); wireRpPresence(); } catch (e) { reportFatalError(e); }
});

createPanel();
wireRpPresence();
garantirTicker();
loopPensamento(); // começa a pensar sozinha assim que carrega — retomada automática
checarVersaoSDK().catch(reportFatalError); // etapa 3.4 — 1x por carregamento, não depende de personagem ativo

} catch (fatalErr) {
    reportFatalError(fatalErr);
}

})();
