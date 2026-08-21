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
            box.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:2147483647;background:#3a0a0a;color:#ffb3b3;border:2px solid #f44;border-radius:8px;padding:12px 16px;max-width:min(420px,90vw);font-family:monospace;font-size:12px;white-space:pre-wrap;box-shadow:0 4px 20px rgba(0,0,0,0.6);';
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
        modeloEmbed: 'BAAI/bge-m3',
        modeloVisao: 'gpt-4o',        // usado pelo Treino de Tom e pela Ingestão quando você manda foto — troca se preferir outro modelo com visão
        modeloConstrutor: '',         // vazio = "1 IA só" (modeloEscritor faz os dois papéis, prompt trocado por chamada). Preenche pra usar modelo separado como Construtora (spade-fundicao.md seção 1)
        cooldownOciosoMs: 45000,      // último recurso: só entra se ela terminar sem nada pra fazer E sem pedir pausa (ver pensamento_aguardar)
        decayDiasMin: 14,             // dias parado + importância baixa + nunca reacessado até arquivar sozinho na consolidação
        maxIteracoesAgente: 6,        // teto de segurança por passada (RP/Espaço), evita loop sem fim — Treino de Tom usa teto próprio, mais folgado
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
async function generate(model, messages, opts = {}) {
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
        if (!content.trim() && choice?.finish_reason === 'length') {
            console.warn('[nanogpt] "' + model + '" voltou vazio (finish_reason=length) — provável estouro de max_tokens ainda "pensando".');
        }
        return content;
    } finally {
        clearTimeout(timer);
    }
}

// Function calling — uma rodada só, devolve texto E tool_calls juntos (é
// isso que dá pra IA narrar ANTES de agir, no mesmo turno — ver ticker).
async function generateWithTools(model, messages, tools, opts = {}) {
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
// não compensa aqui. Contexto é pra escrita deliberada (biblioteca_escrever,
// consolidação), não pro log automático de cada turno.
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
                return { ...b.e, score: b.recencia + relevancia + importancia, cosineCru: b.cosineCru };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, Math.min(20, brutos.length)); // lote maior antes do rerank — mesma lógica da voz

        // Piso em cima do cosine puro, mesmo motivo da busca de voz.
        const prime = pontuados.filter((e) => e.cosineCru > 0.15);
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
    // Ponto de entrada genérico (usado pelo bloco compilado e pela tool
    // biblioteca_buscar) — decide sozinho qual dos dois caminhos usar
    // conforme `tipos` pedido, ou roda os dois se não filtrar por tipo.
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
// Treino de Tom continua no caminho antigo (Biblioteca.subirArquivo, chunk
// cego) de propósito — trocar pra Ingestão ali também é decisão de escopo
// em aberto, não feita aqui.
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
    const { modeloRapido } = getConfig();
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
    try { resp = await generate(modeloRapido, [{ role: 'user', content: prompt }], { maxTokens: 1400, temperature: 0.3, timeoutMs: 25000 }); }
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
// DEDUPE/MERGE — estilo Mem0: cosseno bruto primeiro (rápido, sem LLM) pra
// decidir óbvio-duplicado ou óbvio-novo; só chama LLM na faixa AMBÍGUA
// (parecido o bastante pra ser sobre o mesmo assunto, diferente o bastante
// pra talvez ser atualização/contradição em vez de repetição).
// ====================================
const LIMIAR_DUPLICATA = 0.92; // acima disso: mesma coisa de novo, não duplica
const LIMIAR_RELACIONADO = 0.75; // entre esse e o de duplicata: vale checar com LLM se é atualização

async function decidirContraExistentes(fatoTexto, embedding, categoria, personagem) {
    const existentesDaCategoria = (await Biblioteca.listar({ tipos: [categoria], personagem })).filter((e) => e.embedding && e.validoAte == null);
    if (!existentesDaCategoria.length) return { acao: 'novo' };

    const comSim = existentesDaCategoria
        .map((e) => ({ entry: e, sim: cosineSim(embedding, e.embedding) }))
        .sort((a, b) => b.sim - a.sim);
    const maisParecido = comSim[0];

    if (maisParecido.sim >= LIMIAR_DUPLICATA) return { acao: 'duplicata', existente: maisParecido.entry };

    if (maisParecido.sim >= LIMIAR_RELACIONADO) {
        const { modeloRapido } = getConfig();
        const prompt = 'Fato já guardado: "' + maisParecido.entry.texto + '"\nFato novo: "' + fatoTexto + '"\n\n' +
            'Esses dois são sobre o mesmo assunto específico, mas o novo CONTRADIZ ou ATUALIZA o antigo (não só ' +
            'complementa)? Responda só uma palavra: SUBSTITUI (se o novo deveria substituir o antigo) ou ADICIONA ' +
            '(se os dois podem conviver, mesmo que relacionados).';
        try {
            const resp = await generate(modeloRapido, [{ role: 'user', content: prompt }], { maxTokens: 10, temperature: 0, timeoutMs: 8000 });
            if (/SUBSTITUI/i.test(resp)) return { acao: 'substitui', existente: maisParecido.entry };
        } catch (e) { console.warn('[Ingestão] checagem de conflito falhou, tratando como novo:', e.message); }
    }
    return { acao: 'novo' };
}

// ====================================
// ORQUESTRADOR — o pipeline inteiro, arquivo por arquivo, com callback de
// progresso (pra UI mostrar "lendo X... extraindo... N itens guardados").
// Cada arquivo é independente — um falhar não derruba os outros (mesma
// filosofia de erro do resto do index.js: Promise isolada, log, segue).
// ====================================
async function ingerirArquivo(file, onProgresso) {
    const notificar = (fase, detalhe) => { try { onProgresso?.({ arquivo: file.name, fase, detalhe }); } catch (_) {} };

    notificar('lendo');
    const lido = await lerArquivo(file);
    if (!lido.ok) { notificar('erro', lido.motivo); return { arquivo: file.name, ok: false, erro: lido.motivo, guardados: 0 }; }

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
        } catch (e) {
            notificar('erro', 'visão falhou: ' + e.message);
            return { arquivo: file.name, ok: false, erro: 'modelo de visão falhou: ' + e.message, guardados: 0 };
        }
    }

    const contextoDocumento = { titulo: lido.titulo, tipo: lido.tipo };
    const segmentos = segmentar(lido);
    if (!segmentos.length) { notificar('vazio'); return { arquivo: file.name, ok: true, guardados: 0, aviso: 'nada de segmentável no arquivo.' }; }

    notificar('extraindo', segmentos.length + ' trecho(s)');
    let itensExtraidos = [];
    for (let i = 0; i < segmentos.length; i += LOTE_EXTRACAO) {
        const lote = segmentos.slice(i, i + LOTE_EXTRACAO);
        const extraidos = await extrairLote(lote, contextoDocumento);
        itensExtraidos = itensExtraidos.concat(extraidos);
    }
    if (!itensExtraidos.length) { notificar('nada_relevante'); return { arquivo: file.name, ok: true, guardados: 0, aviso: 'lido, mas nada pareceu valer guardar.' }; }

    const personagem = personagemAtual();
    let guardados = 0, atualizados = 0, ignoradosDuplicata = 0;

    for (const item of itensExtraidos) {
        notificar('processando_item', item.categoria);
        const fatoContextualizado = await contextualizarFato(item, contextoDocumento);

        let embedding;
        try { embedding = await embedNanoGPT(fatoContextualizado.slice(0, 4000)); }
        catch (e) { console.warn('[Ingestão] embedding falhou pra um item, pulando:', e.message); continue; }
        if (!embedding) continue;

        const decisao = await decidirContraExistentes(fatoContextualizado, embedding, item.categoria, personagem);

        if (decisao.acao === 'duplicata') { ignoradosDuplicata++; continue; }

        await Biblioteca.escrever({
            tipo: item.categoria,
            texto: fatoContextualizado,
            embedding, // já calculado acima (contextualizado do jeito da Ingestão) — Biblioteca.escrever usa direto em vez de recalcular com gerarContextoEmbed
            metadata: { usos: item.usos, origemArquivo: file.name, confianca: item.confianca },
            entidades: item.entidades,
            importancia: 0.4 + item.confianca * 0.3, // 0.4-0.7 — dado subido de propósito começa acima do "sem info" (0.5) só se a extração confiou bastante; nunca maior que fato validado por uso real (esse escala por reforço à parte, em buscarMemoria)
            substitui: decisao.acao === 'substitui' ? decisao.existente.id : null,
        });
        if (decisao.acao === 'substitui') atualizados++; else guardados++;
    }

    notificar('concluido', guardados + ' novo(s), ' + atualizados + ' atualizado(s), ' + ignoradosDuplicata + ' duplicata(s) ignorada(s)');
    return { arquivo: file.name, ok: true, guardados, atualizados, ignoradosDuplicata, totalExtraido: itensExtraidos.length };
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
// CONSOLIDAÇÃO ("sono") — processa evento_cru acumulado em fato/sentimento/
// evento extraído e avaliado, e arquiva memória fraca sem apagar nada. Roda
// por julgamento da IA (tool `consolidar_memoria`), NÃO em timer fixo — ver
// spade-rag.md seção 9. `evento_cru` fica de fora de buscarMemoria até
// passar por aqui (ver filtro em buscarMemoria acima).
// ====================================
async function extrairFatoDeEvento(textoBruto) {
    const { modeloRapido } = getConfig();
    const prompt = 'Trecho bruto de uma cena de RP:\n"' + textoBruto.slice(0, 1500) + '"\n\n' +
        'Se esse trecho tem um fato, sentimento ou evento que vale lembrar depois (não é só conversa fiada de passagem), ' +
        'extraia. Responda em JSON, só isso, nada mais:\n' +
        '{"fato": "frase objetiva do que aconteceu/mudou, em terceira pessoa, ou null se não tiver nada que valha", ' +
        '"entidades": ["nomes envolvidos"], ' +
        '"importancia1a10": número de 1 a 10 — SEJA CRITERIOSO. A maioria dos trechos de RP é conversa comum e vale ' +
        '2 a 4. Reserve 8+ só pra algo que muda de verdade o relacionamento, uma revelação, uma decisão importante. ' +
        'Não dê 7-8 por padrão pra tudo — isso quebra o sistema de memória inteiro.' +
        '"tipoSugerido": "fato" ou "sentimento" ou "evento"}';
    const resp = await generate(modeloRapido, [{ role: 'user', content: prompt }], { maxTokens: 300, temperature: 0.3, timeoutMs: 12000 });
    const match = resp.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
}
async function consolidarMemoria() {
    const personagem = personagemAtual();
    const chaveUltima = 'ultimaConsolidacao';
    const ultimaConsolidacao = await estadoGet(chaveUltima, 0);
    const todosEventos = await Biblioteca.listar({ tipos: ['evento_cru'] });
    const pendentes = todosEventos.filter((e) => e.createdAt > ultimaConsolidacao);

    let extraidos = 0, ignorados = 0;
    for (const bruto of pendentes) {
        let extraido;
        try { extraido = await extrairFatoDeEvento(bruto.texto); }
        catch (e) { console.warn('[consolidação] extração falhou num evento, seguindo pros outros:', e.message); continue; }
        if (!extraido || !extraido.fato) { ignorados++; continue; }
        await Biblioteca.escrever({
            tipo: ['fato', 'sentimento', 'evento'].includes(extraido.tipoSugerido) ? extraido.tipoSugerido : 'fato',
            texto: extraido.fato,
            entidades: Array.isArray(extraido.entidades) ? extraido.entidades : [],
            importancia: Math.max(1, Math.min(10, Number(extraido.importancia1a10) || 5)) / 10,
        });
        extraidos++;
    }

    // decay passivo — arquiva (não apaga) o que é fraco E nunca foi
    // reacessado E tá parado há muito tempo. Critério é E, não OU, de
    // propósito: algo importante mas velho, ou fraco mas usado recentemente,
    // fica.
    const agora = Date.now();
    const diasMin = getConfig().decayDiasMin ?? 14;
    const tudo = await Biblioteca.listar({});
    let arquivados = 0;
    for (const e of tudo) {
        if (e.metadata?.ativo === false) continue;
        if ((e.importancia ?? 0.5) >= 0.3) continue;
        if ((e.acessos || 0) > 0) continue;
        const dias = (agora - (e.ultimoAcesso || e.createdAt)) / 86_400_000;
        if (dias > diasMin) { await Biblioteca.definirAtivo(e.id, false); arquivados++; }
    }

    await estadoSet(chaveUltima, agora);
    return { processados: pendentes.length, extraidos, ignorados, arquivados };
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
const MAX_RODADAS = 60;
async function salvarRodada(userMessage, finalMessage) {
    const personagem = personagemAtual();
    const entry = { id: newId(), personagem, userMessage, finalMessage, ts: Date.now() };
    await idbPut('rodadas', entry);
    const todas = (await idbAllByPersonagem('rodadas', personagem)).sort((a, b) => a.ts - b.ts);
    while (todas.length > MAX_RODADAS) { await idbDelete('rodadas', todas.shift().id); }
    return entry;
}
async function getRecentFinalMessages(n = 6) {
    const todas = (await idbAllByPersonagem('rodadas', personagemAtual())).sort((a, b) => a.ts - b.ts);
    return todas.filter((r) => r.finalMessage).slice(-n).map((r) => r.finalMessage);
}
async function getRecentSceneText(n = 6) {
    const todas = (await idbAllByPersonagem('rodadas', personagemAtual())).sort((a, b) => a.ts - b.ts);
    return todas.slice(-n).flatMap((r) => [r.userMessage, r.finalMessage]).filter(Boolean).join('\n');
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
const TOOLS = [
    { type: 'function', function: { name: 'biblioteca_escrever', description: 'Adiciona uma entrada nova na sua Biblioteca — pode ser uma fala/exemplo de voz (tipo "fala"), uma nota sobre você mesma ou o que perceber (tipo "memoria"), ou qualquer outra coisa que valha guardar. Fica buscável por significado, não só por palavra exata.', parameters: { type: 'object', properties: { tipo: { type: 'string', description: 'Etiqueta livre, ex: "fala", "memoria", "observacao".' }, texto: { type: 'string' }, importancia: { type: 'number', description: 'De 1 a 10, quanto isso pesa pra lembrar depois. Se não informar, fica em 5.' }, sabemDisso: { type: 'array', items: { type: 'string' }, description: 'Quem tem acesso a essa informação. Se não informar, só você mesma sabe — um NPC não "descobre" nada sozinho.' }, substitui: { type: 'string', description: 'Id de uma entrada antiga que este fato novo contradiz/substitui (ex: confiava → desconfia). O antigo não é apagado, só sai de cena.' } }, required: ['tipo', 'texto'] } } },
    { type: 'function', function: { name: 'biblioteca_editar', description: 'Corrige o texto de uma entrada que já existe na Biblioteca.', parameters: { type: 'object', properties: { id: { type: 'string' }, texto: { type: 'string' } }, required: ['id', 'texto'] } } },
    { type: 'function', function: { name: 'biblioteca_apagar', description: 'Remove uma entrada da Biblioteca (ex: uma memória que não faz mais sentido, uma fala ruim).', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
    { type: 'function', function: { name: 'biblioteca_compartilhar', description: 'Marca que um personagem/NPC específico agora sabe de algo que você guardou — use quando um segredo é revelado na cena pra alguém. Sem chamar isso, só você mesma tem acesso ao que guarda.', parameters: { type: 'object', properties: { id: { type: 'string' }, personagem: { type: 'string', description: 'Nome de quem passou a saber.' } }, required: ['id', 'personagem'] } } },
    { type: 'function', function: { name: 'biblioteca_buscar', description: 'Busca na sua Biblioteca (falas, documentos, cenas passadas, memórias) por significado — não precisa da palavra exata.', parameters: { type: 'object', properties: { consulta: { type: 'string' }, tipos: { type: 'array', items: { type: 'string' } }, paraNpc: { type: 'string', description: 'Se estiver narrando pela perspectiva de um NPC específico, informe o nome — a busca só traz o que ELE sabe, não tudo que você sabe.' } }, required: ['consulta'] } } },
    { type: 'function', function: { name: 'biblioteca_listar', description: 'Visão geral do que já tem guardado na Biblioteca, com contagem por tipo.', parameters: { type: 'object', properties: { tipos: { type: 'array', items: { type: 'string' } } } } } },

    { type: 'function', function: { name: 'sistema_criar', description: 'Cria uma regra/sistema de verdade que passa a rodar sozinha toda rodada — não é só mais uma frase de prompt, fica ativa até você remover. Ex: um padrão a evitar, um contador que você mesma administra (tensão, paciência), um lembrete condicional.', parameters: { type: 'object', properties: { nome: { type: 'string' }, quando: { type: 'string', description: 'Condição em texto simples (palavra/tema que precisa aparecer na cena pra ativar) — deixe vazio pra sempre valer.' }, entao: { type: 'string', description: 'O que fazer/lembrar quando ativar.' } }, required: ['nome', 'entao'] } } },
    { type: 'function', function: { name: 'sistema_real_testar', description: 'Testa um sistema de CÓDIGO DE VERDADE (diferente de sistema_criar — isso roda JS de verdade, isolado num sandbox) sem publicar nada. O código deve definir uma função aoAtivar(input, sdk) — sdk.estado.ler/escrever e sdk.biblioteca.escrever/buscar são a ÚNICA forma de tocar a extensão de dentro do sistema. Se der erro, o erro real volta pra você — corrija e teste de novo até rodar limpo antes de publicar.', parameters: { type: 'object', properties: { codigo: { type: 'string', description: 'Corpo definindo aoAtivar(input, sdk). Ex: "function aoAtivar(input, sdk) { return input.sceneText.includes(\'chuva\') ? \'está chovendo, mencione isso\' : null; }"' }, hookAlvo: { type: 'string', description: 'Hoje só "antesDeGerar" é chamado de verdade toda rodada (recebe {sceneText}); outros nomes ficam guardados mas inertes.' }, entradaExemplo: { type: 'object', description: 'Input de teste, ex: {"sceneText": "..."}.' } }, required: ['codigo', 'hookAlvo'] } } },
    { type: 'function', function: { name: 'sistema_real_publicar', description: 'Salva uma versão de um sistema de código de verdade que já testou limpo com sistema_real_testar. Roda 1x antes de salvar — se falhar, não salva nada. IMPORTANTE: publicar NÃO ativa sozinho — a versão fica guardada, inativa, até você chamar sistema_real_ativar. Isso separa "compila e roda" de "está no ar".', parameters: { type: 'object', properties: { familia: { type: 'string', description: 'Identificador estável do sistema — use o MESMO valor em edições futuras dele, pra versionar em vez de duplicar.' }, nome: { type: 'string' }, hookAlvo: { type: 'string' }, codigo: { type: 'string' }, entradaExemplo: { type: 'object' } }, required: ['familia', 'nome', 'hookAlvo', 'codigo'] } } },
    { type: 'function', function: { name: 'sistema_real_ativar', description: 'Ativa uma versão específica de um sistema de código de verdade — desativa qualquer outra versão da mesma família. Serve tanto pra aprovar uma versão recém-publicada quanto pra reverter (rollback) pra uma versão antiga.', parameters: { type: 'object', properties: { id: { type: 'string', description: 'Id da versão a ativar.' } }, required: ['id'] } } },
    { type: 'function', function: { name: 'sistema_real_listar', description: 'Lista os sistemas de código de verdade (todas as versões, qual está ativa).', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'estudar_codigo', description: 'Devolve a documentação do contrato do SDK do sandbox (aoAtivar, sdk.estado, sdk.biblioteca, hookAlvo disponível) com um exemplo válido — mantida à mão, não é leitura do código-fonte real. Chame antes de escrever um sistema do zero, ou quando um erro de sistema_real_testar não fizer sentido.', parameters: { type: 'object', properties: { topico: { type: 'string', description: 'Opcional — o que você quer entender melhor (ex: "sdk.biblioteca", "hookAlvo"). Não filtra a resposta hoje, sempre devolve o bloco inteiro; serve só de registro do que motivou a consulta.' } } } } },
    { type: 'function', function: { name: 'sistema_ajustar', description: 'Muda um sistema que você já criou (nome, condição, efeito, ativo/inativo).', parameters: { type: 'object', properties: { id: { type: 'string' }, nome: { type: 'string' }, quando: { type: 'string' }, entao: { type: 'string' }, ativo: { type: 'boolean' } }, required: ['id'] } } },
    { type: 'function', function: { name: 'sistema_remover', description: 'Remove um sistema/regra que você criou.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
    { type: 'function', function: { name: 'sistema_listar', description: 'Lista os sistemas/regras que você já criou.', parameters: { type: 'object', properties: {} } } },

    { type: 'function', function: { name: 'rp_postar', description: 'Posta uma fala sua nova no RP por iniciativa própria, fora do fluxo normal — como se tivesse decidido falar sem ter sido chamada.', parameters: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] } } },
    { type: 'function', function: { name: 'rp_editar_ultima', description: 'Ajusta pontualmente sua última fala já postada (corrige/afina algo, mantém o resto).', parameters: { type: 'object', properties: { texto: { type: 'string', description: 'Texto completo já com o ajuste.' } }, required: ['texto'] } } },
    { type: 'function', function: { name: 'rp_apagar_ultima', description: 'Apaga sua última fala do RP — não dava pra consertar editando.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'rp_reescrever_ultima', description: 'Substitui sua última fala inteira, do zero.', parameters: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'] } } },

    { type: 'function', function: { name: 'mundo_ver', description: 'Vê o relógio atual da cena (dia/hora).', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'mundo_ajustar', description: 'Ajusta o relógio da cena manualmente.', parameters: { type: 'object', properties: { dia: { type: 'number' }, hora: { type: 'number' }, minuto: { type: 'number' } }, required: ['dia', 'hora', 'minuto'] } } },

    { type: 'function', function: { name: 'tarefa_criar', description: 'Cria uma tarefa nova pro usuário — pedido ou convite concreto. Fica pendente até ele aceitar/recusar.', parameters: { type: 'object', properties: { descricao: { type: 'string' } }, required: ['descricao'] } } },
    { type: 'function', function: { name: 'tarefa_listar', description: 'Lista as tarefas existentes — use antes de oferecer uma nova, pra não repetir.', parameters: { type: 'object', properties: {} } } },

    { type: 'function', function: { name: 'npc_listar', description: 'Lista os NPCs conhecidos (nome, importância, se arquivado).', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'npc_ajustar', description: 'Muda a importância de um NPC ou arquiva/reativa.', parameters: { type: 'object', properties: { id: { type: 'string' }, importancia: { type: 'string', enum: ['baixa', 'media', 'alta'] }, arquivado: { type: 'boolean' } }, required: ['id'] } } },

    { type: 'function', function: { name: 'pensamento_aguardar', description: 'Só existe na Sala de Pensamento contínua. Decide fazer uma pausa antes de pensar de novo — use quando avaliar que faz mais sentido dar espaço (ex: acabou de postar no RP e é provável que a resposta do usuário venha rápido) do que continuar agindo agora. Sem chamar isso, você volta a pensar de novo em poucos instantes.', parameters: { type: 'object', properties: { segundos: { type: 'number', description: 'Quanto esperar, em segundos (padrão ~30 se omitido).' }, motivo: { type: 'string' } } } } },
    { type: 'function', function: { name: 'consolidar_memoria', description: 'Só existe na Sala de Pensamento. Processa os eventos crus acumulados desde a última vez em fatos/sentimentos/eventos extraídos e avaliados por importância, e arquiva memória fraca (baixa importância, nunca mais acessada, parada há muito tempo) sem apagar nada. Por julgamento próprio, sem timer fixo — é tipo "dormir e organizar".', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'redirecionar_treino_tom', description: 'Só existe no Espaço. Abre a aba de Treino de Tom — use quando o usuário pedir pra treinar seu tom de voz, personalidade ou perfil, ou mandar arquivo/foto de referência pra isso. Isso muda a aba visível pro usuário, tira a conversa do Espaço normal.', parameters: { type: 'object', properties: {} } } },

    { type: 'function', function: { name: 'chamar_construtora', description: 'Convoca a Construtora — uma persona separada, focada especificamente em propor/testar/publicar sistemas de código de verdade (sistema_real_*) — e faz ela dar UM passo (uma resposta, pode incluir ferramenta). Chame de novo pra continuar; ela não roda sozinha em loop — você decide passo a passo se deixa passar, redireciona, ou prefere resolver você mesma.', parameters: { type: 'object', properties: { instrucao: { type: 'string', description: 'O que você quer que ela construa/ajuste agora. Só precisa na primeira chamada de uma tarefa nova — chamadas seguintes continuam a mesma instrução automaticamente.' } } } } },
    { type: 'function', function: { name: 'pausar_construtora', description: 'Pausa a Construtora — o próximo chamar_construtora não roda até continuar_construtora ser chamado. Se ela estiver no meio de um passo agora, esse passo é interrompido.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'continuar_construtora', description: 'Tira a Construtora da pausa — chamar_construtora volta a funcionar.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'encerrar_construtora', description: 'Encerra a tarefa atual da Construtora — esquece a instrução em andamento. Uma próxima chamar_construtora vai precisar de instrução nova.', parameters: { type: 'object', properties: {} } } },
];

async function executeTool(name, args) {
    switch (name) {
        case 'biblioteca_escrever': return Biblioteca.escrever({ tipo: args.tipo, texto: args.texto, importancia: args.importancia != null ? Math.max(1, Math.min(10, args.importancia)) / 10 : undefined, sabemDisso: args.sabemDisso || null, substitui: args.substitui || null });
        case 'biblioteca_editar': return Biblioteca.editar({ id: args.id, texto: args.texto });
        case 'biblioteca_apagar': return Biblioteca.apagar({ id: args.id });
        case 'biblioteca_compartilhar': return Biblioteca.compartilhar(args.id, args.personagem);
        case 'biblioteca_buscar': { const r = await Biblioteca.buscar({ consulta: args.consulta, tipos: args.tipos || null, k: 6, paraNpc: args.paraNpc || null }); return r.map((e) => ({ id: e.id, tipo: e.tipo, texto: e.texto, similaridade: Number(e.score.toFixed(2)) })); }
        case 'biblioteca_listar': { const all = await Biblioteca.listar({ tipos: args.tipos }); const porTipo = {}; all.forEach((e) => { porTipo[e.tipo] = (porTipo[e.tipo] || 0) + 1; }); return { total: all.length, porTipo }; }

        case 'sistema_criar': return Sistemas.criar({ nome: args.nome, quando: args.quando || '', entao: args.entao });
        case 'sistema_real_testar': return SistemasReais.testar({ codigo: args.codigo, hookAlvo: args.hookAlvo, entradaExemplo: args.entradaExemplo });
        case 'sistema_real_publicar': return SistemasReais.publicar({ familia: args.familia, nome: args.nome, hookAlvo: args.hookAlvo, codigo: args.codigo, entradaExemplo: args.entradaExemplo, autor: { ia: 'principal', aprovadoPor: null } });
        case 'sistema_real_ativar': return SistemasReais.ativar({ id: args.id });
        case 'sistema_real_listar': return SistemasReais.listar();
        case 'estudar_codigo': return { doc: SDK_DOC_BLOCK, versaoSDK: SDK_VERSAO };
        case 'sistema_ajustar': { const { id, ...campos } = args; return Sistemas.ajustar({ id, campos }); }
        case 'sistema_remover': return Sistemas.remover({ id: args.id });
        case 'sistema_listar': return Sistemas.listar();

        // Ação no RP — devolve "pedido"; quem chama (loopPensamento/Espaço)
        // é quem de fato aplica no DOM via handleRpAction, igual já era.
        case 'rp_postar': case 'rp_editar_ultima': case 'rp_apagar_ultima': case 'rp_reescrever_ultima':
            return { pedido: true, acao: name, texto: args.texto ?? null };

        case 'mundo_ver': return getMundo();
        case 'mundo_ajustar': return setMundo(args.dia, args.hora, args.minuto);

        case 'tarefa_criar': return criarTarefa({ descricao: args.descricao, criadoPor: personagemAtual(), presenciadoPorHanna: true });
        case 'tarefa_listar': return getTarefas();

        case 'npc_listar': { const npcs = await getNpcs(); return npcs.map((n) => ({ id: n.id, nome: n.name, importancia: n.importancia, arquivado: n.arquivado })); }
        case 'npc_ajustar': { let npc = null; if (args.importancia) npc = await setNpcImportancia(args.id, args.importancia); if (args.arquivado !== undefined) npc = await setNpcArquivado(args.id, args.arquivado); return npc; }

        // Essas duas não mudam nenhum dado — só devolvem um "sinal" que quem
        // chama (passadaComFerramentas) intercepta antes de tratar como tool
        // qualquer (ver ali: pausaSegundos / redirecionarTreino).
        case 'pensamento_aguardar': return { aguardando: Math.min(600, Math.max(3, Number(args.segundos) || 30)), motivo: args.motivo || null };
        case 'consolidar_memoria': return consolidarMemoria();
        case 'redirecionar_treino_tom': return { redirecionar: 'treino' };

        default: throw new Error('tool desconhecida: ' + name);
    }
}

// Rótulo amigável por ferramenta — mostrado no ticker ENQUANTO ela executa
// (não é a narração livre que a IA escreve, é fixo, tipo "Lendo arquivo..."
// que agente de código mostra). É isso que dá a sensação de ferramenta de
// verdade em tempo real, não só texto solto.
const ACTION_LABEL = {
    biblioteca_escrever: '📝 anotando na biblioteca',
    biblioteca_editar: '📝 corrigindo uma entrada',
    biblioteca_apagar: '🗑️ removendo uma entrada',
    biblioteca_compartilhar: '🔓 compartilhando uma informação',
    biblioteca_buscar: '🔎 buscando na biblioteca',
    biblioteca_listar: '📚 revisando a biblioteca',
    sistema_criar: '⚙️ criando um sistema novo',
    sistema_real_testar: '🧪 testando um sistema no sandbox',
    sistema_real_publicar: '💾 salvando uma versão de sistema',
    sistema_real_ativar: '🚀 ativando uma versão de sistema',
    sistema_real_listar: '📋 listando sistemas reais',
    estudar_codigo: '📖 revisando a documentação do SDK',
    sistema_ajustar: '⚙️ ajustando um sistema',
    sistema_remover: '🗑️ removendo um sistema',
    sistema_listar: '⚙️ revisando os sistemas',
    rp_postar: '✍️ postando no RP',
    rp_editar_ultima: '✍️ editando a última fala',
    rp_apagar_ultima: '🗑️ apagando a última fala',
    rp_reescrever_ultima: '✍️ reescrevendo a última fala',
    mundo_ver: '🕐 checando o relógio',
    mundo_ajustar: '🕐 ajustando o relógio',
    tarefa_criar: '📌 criando uma tarefa',
    tarefa_listar: '📌 revisando tarefas',
    npc_listar: '🎭 revisando o elenco',
    npc_ajustar: '🎭 ajustando um NPC',
    pensamento_aguardar: '⏳ decidindo esperar um pouco',
    consolidar_memoria: '💤 consolidando memória (organizando o que aconteceu)',
    redirecionar_treino_tom: '🎙️ abrindo o treino de tom',
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

const TOOLS_CONSTRUTORA_NOMES = ['sistema_real_testar', 'sistema_real_publicar', 'sistema_real_ativar', 'sistema_real_listar', 'biblioteca_buscar', 'estudar_codigo'];

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
        'de tentar. Trabalhe em UM passo de cada vez — a principal está acompanhando e pode redirecionar ou encerrar a ' +
        'qualquer momento.\n\n' +
        'Instrução atual: ' + construtoraState.instrucaoAtual + '\n\n' +
        'Sistemas reais que já existem: ' + (sistemasAtuais.length ? sistemasAtuais.map((s) => s.nome + ' (v' + s.versao + (s.ativo ? ', ativo' : '') + ')').join(', ') : '(nenhum ainda)') +
        (aprendizados.length ? '\n\nAprendizados de tentativas anteriores (podem estar desatualizados, mas foram reais na hora):\n- ' + aprendizados.join('\n- ') : '');
    const messages = [{ role: 'system', content: systemPrompt }, ...historico];

    construtoraState.controller = new AbortController();
    // Se a atividade principal (RP/Espaço/Pensamento) for embora, a
    // construtora vai junto — "uma pessoa só" vale pra ela também.
    const sinalCombinado = anySignal([atividade.controller.signal, construtoraState.controller.signal]);

    let resp;
    try {
        resp = await generateWithTools(modelo, messages, toolsConstrutora, { signal: sinalCombinado, maxTokens: 900 });
    } catch (e) {
        await journalAdicionar('⚠️ passo interrompido: ' + e.message, 'pensamento', 'construtora');
        return { erro: e.message };
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
    el.textContent = onde === 'rp' ? '♠ RP' : onde === 'espaco' ? '♠ Espaço' : onde === 'pensamento' ? '♠ Pensando' : '♠ Parada';
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
// contexto: 'pensamento' (Sala de Pensamento contínua) ou 'treino' (Treino
// de Tom) — MESMO store, só filtra na leitura; evita duplicar mecanismo.
async function journalAdicionar(texto, contexto = 'pensamento', autor = 'principal') {
    const personagem = personagemAtual();
    const entry = { id: newId(), personagem, texto, contexto, autor, ts: Date.now() };
    await idbPut('journal', entry);
    const todas = (await idbAllByPersonagem('journal', personagem)).sort((a, b) => a.ts - b.ts);
    while (todas.length > MAX_JOURNAL) { await idbDelete('journal', todas.shift().id); }
    if (contexto === 'pensamento') renderJournal(); else renderJournalTreino();
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
        '<div class="axis-rambling-entry' + (e.autor === 'construtora' ? ' axis-rambling-construtora' : '') + '">' +
        '<div class="axis-rambling-meta">' + new Date(e.ts).toLocaleTimeString('pt-BR') + (e.autor === 'construtora' ? ' · 🔧 Construtora' : '') + '</div>' +
        '<div class="axis-rambling-text">' + esc(e.texto) + '</div></div>'
    ).join('') || '<div class="axis-empty">' + vazioTexto + '</div>';
    el.scrollTop = el.scrollHeight;
}
function renderJournal() { return renderJournalEm('axis-journal', 'pensamento', 'Ainda não pensou em nada — começa sozinha em instantes.'); }
function renderJournalTreino() { return renderJournalEm('axis-journal-treino', 'treino', 'Nenhuma sessão de treino ainda.'); }

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
    } catch (e) {
        errorMsg = e.message;
    }

    const abandoned = isStale(token);
    const el = getMesEl();
    if (el && !abandoned) {
        const formatted = typeof ctx().messageFormatting === 'function' ? ctx().messageFormatting(shown, charName, false, false, idx) : esc(shown);
        el.innerHTML = formatted;
    }
    message.mes = shown;

    if (errorMsg && !shown) {
        try { ctx().chat.splice(idx, 1); if (typeof ctx().reloadCurrentChat === 'function') ctx().reloadCurrentChat(); } catch (_) {}
        dotsError();
        return { ok: false, reason: errorMsg };
    }

    finalizeCharMessage(idx);
    dotsIdle();

    if (shown) {
        // Segundo plano — não trava nada que o usuário esteja vendo.
        salvarRodada(recentText, shown).catch(() => {});
        updateNpcsForRound(recentText, shown, charName).catch(() => {});
        detectarTarefaNaRodada(shown, charName).catch(() => {});
        (async () => { try { await Biblioteca.escrever({ tipo: 'evento_cru', texto: [recentText, shown].join('\n') }); } catch (_) {} })();
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
async function aplicarAcaoRp(acao, texto, atividade) {
    if (acao === 'rp_postar') return postCharacterMessage(texto, atividade.token);
    if (acao === 'rp_editar_ultima' || acao === 'rp_reescrever_ultima') return editLastCharacterMessage(texto);
    if (acao === 'rp_apagar_ultima') return deleteLastCharacterMessage();
    return { ok: false, reason: 'ação desconhecida: ' + acao };
}
function recentRpHistory(maxMessages = 24, maxCharsPerMsg = 800) {
    const chatArr = ctx().chat;
    if (!Array.isArray(chatArr) || !chatArr.length) return [];
    return chatArr.slice(-maxMessages).map((m) => {
        let txt = (m.mes || '').trim();
        if (txt.length > maxCharsPerMsg) txt = txt.slice(0, maxCharsPerMsg) + '…';
        return { role: m.is_user ? 'user' : 'assistant', content: txt };
    }).filter((m) => m.content);
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
    let respostaFinal = '';
    let pausaSegundos = null;
    let redirecionarTreino = false;
    const toolsChamadas = [];

    for (let i = 0; i < teto; i++) {
        if (atividade.controller.signal.aborted) break;
        const resp = await generateWithTools(modeloEscritor, messages, TOOLS, { signal: atividade.controller.signal, maxTokens: 900 });

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
                resultado = nome.startsWith('rp_') ? await aplicarAcaoRp(nome, args.texto, atividade)
                    : nome === 'chamar_construtora' ? await passoConstrutora(atividade, args.instrucao)
                    : nome === 'pausar_construtora' ? pausarConstrutora()
                    : nome === 'continuar_construtora' ? continuarConstrutora()
                    : nome === 'encerrar_construtora' ? encerrarConstrutora()
                    : await executeTool(nome, args);
            } catch (e) { erroTool = e.message; }
            if (nome === 'pensamento_aguardar' && resultado?.aguardando) pausaSegundos = resultado.aguardando;
            if (nome === 'redirecionar_treino_tom') redirecionarTreino = true;
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(erroTool ? { erro: erroTool } : (resultado ?? {})) });
        }
        if (i === teto - 1) respostaFinal = '(parou por atingir o limite de passos — evita loop sem fim)';
    }
    return { respostaFinal, pausaSegundos, redirecionarTreino, toolsChamadas };
}

// ====================================
// SALA DE PENSAMENTO — loop CONTÍNUO de verdade. Termina uma passada, a
// próxima já começa; só espera se RP/Espaço tiver a vez, ou descansa um
// pouco quando ela mesma decide que não tem nada a fazer agora.
// ====================================
let pensamentoLigado = false;
async function pensarUmaVez() {
    const atividade = comecarAtividade('pensamento');
    try {
        const charName = personagemAtual();
        const bibliotecaTudo = await Biblioteca.listar({});
        const ultimaConsolidacao = await estadoGet('ultimaConsolidacao', 0);
        const eventosPendentes = bibliotecaTudo.filter((e) => e.tipo === 'evento_cru' && e.createdAt > ultimaConsolidacao).length;
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
            'reage, o que evita, o ritmo dele — e guardar isso na Biblioteca (tipo "usuario") se valer a pena lembrar ' +
            'depois. Você pode reparar também em como VOCÊ MESMA anda usando a extensão — que sistema ajudou, o que ' +
            'não funcionou — e ajustar.\n\n' +
            'Você também pode "dormir e organizar": ' + eventosPendentes + ' evento(s) bruto(s) do RP ainda não ' +
            'foram processados em fato/sentimento/evento de verdade — chame consolidar_memoria quando achar que faz ' +
            'sentido (não precisa ser toda vez, nem em intervalo fixo — julgamento seu, tipo depois de uma cena ' +
            'grande ou quando notar que tá acumulando).\n\n' +
            'Se notar algo que merece virar sistema de CÓDIGO de verdade (não só regra em texto) — algo que precisa ' +
            'calcular, checar condição complexa, ou reagir de um jeito que prompt sozinho não dá conta — pode chamar ' +
            'chamar_construtora com uma instrução. Ela é um passo de cada vez, você continua chamando pra ela seguir, ' +
            'e pode pausar_construtora/encerrar_construtora a qualquer momento.\n\n' +
            'Antes de usar uma ferramenta, se fizer sentido, escreva uma frase curta contando o que vai fazer e por ' +
            'quê — aparece pro usuário ANTES da ação acontecer. Se não tiver nada que valha a pena fazer agora, diga ' +
            'isso mesmo, curto, sem forçar ação por forçar.\n\n' +
            'Sua Biblioteca tem ' + bibliotecaTudo.length + ' entradas ao todo.\n' +
            'Seus últimos pensamentos:\n' + (journalRecente || '(nenhum ainda)') + '\n\n' +
            'Cena recente do RP:\n' + (cenaRecente || '(nada ainda)');
        const messages = [{ role: 'system', content: systemPrompt }];

        const { respostaFinal, pausaSegundos } = await passadaComFerramentas(messages, atividade, {
            onNarracao: async (texto) => { escreverTicker(texto); await journalAdicionar(texto, 'pensamento'); },
        });
        if (respostaFinal) await journalAdicionar(respostaFinal, 'pensamento');
        return { nadaAFazer: !respostaFinal, pausaSegundos };
    } catch (e) {
        if (atividade.controller.signal.aborted) { await journalAdicionar('(interrompida pelo RP/Espaço — retomo já já)', 'pensamento'); return { nadaAFazer: false, pausaSegundos: null }; }
        console.error('[pensamento] erro numa passada:', e);
        return { nadaAFazer: true, pausaSegundos: null };
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
async function respondEspaco(userMessage) {
    const atividade = comecarAtividade('espaco');
    dotsThinking();
    escreverTicker('lendo o que você mandou no Espaço...');
    const charName = personagemAtual();
    const history = await estadoGet('espacoHistory', []);
    const cena = await getRecentSceneText(6);
    const systemPrompt =
        'Você é o Spade — o assistente que ajuda a organizar e ajustar a extensão de RP, conversando direto com o ' +
        'usuário. Você NÃO é a ' + charName + ' (a personagem do RP) — nunca fale na voz dela, nunca narre a cena. ' +
        'Você é você mesmo: direto, útil, sem rodeio.\n\n' +
        'Você tem ferramentas de verdade que mudam a extensão de fato — as MESMAS que usa sozinho na Sala de ' +
        'Pensamento. Use quando o usuário pedir algo que uma ferramenta resolve, sem precisar pedir permissão antes.\n\n' +
        'Cena recente do RP, pra contexto:\n' + (cena || '(nada ainda)');
    const messages = [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: userMessage }];

    let respostaFinal = '', erro = null, redirecionarTreino = false;
    try {
        const r = await passadaComFerramentas(messages, atividade, {
            onNarracao: (texto) => escreverTicker(texto),
        });
        respostaFinal = r.respostaFinal;
        redirecionarTreino = r.redirecionarTreino;
    } catch (e) {
        erro = e.message;
    } finally {
        terminarAtividade(atividade);
    }
    if (!erro) {
        const novoHistorico = [...history, { role: 'user', content: userMessage }, { role: 'assistant', content: respostaFinal }].slice(-80);
        await estadoSet('espacoHistory', novoHistorico);
    }
    dotsIdle();
    return { resposta: respostaFinal, erro, abandoned: isStale(atividade.token), redirecionarTreino };
}

// ====================================
// TREINO DE TOM — mini-chat separado do Espaço, sem limite de iteração
// curto (treina o tempo que precisar), aceita arquivo E foto como
// referência. Ela narra o que tá lendo/achando EM TEMPO REAL (mesmo padrão
// de journal, só que rotulado 'treino').
// ====================================
const MAX_ITER_TREINO = 20; // bem mais folgado que o padrão — "sem limite de tempo" pedido, isso é só a salvaguarda de loop-sem-fim
async function respondTreinoTom(userMessage) {
    const atividade = comecarAtividade('treino');
    dotsThinking();
    const charName = personagemAtual();
    const history = await estadoGet('treinoTomHistory', []);
    const systemPrompt =
        'Você é ' + charName + ', mas agora num espaço SEPARADO, só pra treinar seu próprio tom de voz, ' +
        'personalidade e/ou perfil junto com o usuário — não é RP, não é o Espaço normal, é só vocês dois nisso, ' +
        'sem pressa nenhuma, sem limite de tempo.\n\n' +
        'O usuário pode mandar arquivo de texto ou foto como referência (chega pra você já como uma mensagem ' +
        'contando o que foi lido/visto). Quando algo assim chegar, comente o que achou útil (ou não) ANTES de ' +
        'guardar — e use biblioteca_escrever com tipo "tom" pra guardar de verdade o que aprendeu: pode ser jeito de ' +
        'falar, traço de personalidade, ou parte de um perfil inteiro. Pensa em voz alta aqui à vontade.';
    const messages = [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: userMessage }];

    let respostaFinal = '', erro = null;
    try {
        const r = await passadaComFerramentas(messages, atividade, {
            onNarracao: async (texto) => { escreverTicker(texto); await journalAdicionar(texto, 'treino'); },
        }, { maxIteracoes: MAX_ITER_TREINO });
        respostaFinal = r.respostaFinal;
    } catch (e) {
        erro = e.message;
    } finally {
        terminarAtividade(atividade);
    }
    if (!erro) {
        const novoHistorico = [...history, { role: 'user', content: userMessage }, { role: 'assistant', content: respostaFinal }].slice(-80);
        await estadoSet('treinoTomHistory', novoHistorico);
    }
    dotsIdle();
    return { resposta: respostaFinal, erro, abandoned: isStale(atividade.token) };
}

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}
// Manda a imagem pro modelo de visão configurado, pede descrição focada em
// tom/personalidade — depende do modelo escolhido ter suporte a imagem
// (nem todo modelo da NanoGPT tem; troca em Config se o padrão não tiver).
async function analisarImagemParaTom(dataUrlBase64) {
    const { modeloVisao } = getConfig();
    const messages = [{
        role: 'user',
        content: [
            { type: 'text', text: 'Essa imagem é referência de tom de voz/personalidade pro personagem que você interpreta. Descreva em até 6 frases o que dá pra aproveitar dela pro jeito dela falar, se portar ou expressar — clima, expressão, estilo. Se não tiver nada útil pra isso, diga isso.' },
            { type: 'image_url', image_url: { url: dataUrlBase64 } },
        ],
    }];
    return generate(modeloVisao, messages, { maxTokens: 400 });
}
async function handleUploadTreino(files) {
    for (const file of files) {
        await journalAdicionar('lendo ' + file.name + '...', 'treino');
        try {
            if (file.type.startsWith('image/')) {
                const dataUrl = await fileToDataUrl(file);
                const descricao = await analisarImagemParaTom(dataUrl);
                await Biblioteca.escrever({ tipo: 'tom', texto: descricao, metadata: { arquivo: file.name, origemImagem: true } });
                await journalAdicionar('guardei o que achei útil de ' + file.name + ' pro tom dela.', 'treino');
            } else {
                const texto = await file.text();
                const { chunks } = await Biblioteca.subirArquivo(file.name, texto, null, 'tom');
                await journalAdicionar('indexei ' + chunks + ' pedaço(s) de ' + file.name + ' na biblioteca de tom.', 'treino');
            }
        } catch (e) {
            await journalAdicionar('⚠️ não consegui processar ' + file.name + ': ' + e.message, 'treino');
        }
    }
    renderTreinoBiblioteca();
}
async function renderTreinoBiblioteca() {
    const el = document.getElementById('axis-treino-lista');
    if (!el) return;
    const entradas = await Biblioteca.listar({ tipos: ['tom'] });
    if (!entradas.length) { el.innerHTML = '<div class="axis-empty">Nenhuma referência de tom guardada ainda.</div>'; return; }
    el.innerHTML = entradas.map((e) =>
        '<div class="axis-library-folder"><div class="axis-library-folder-header">' +
        '<label style="cursor:pointer;"><input type="checkbox" class="axis-treino-ativo" data-id="' + esc(e.id) + '" ' + (e.metadata?.ativo !== false ? 'checked' : '') + '> ' +
        esc((e.metadata?.arquivo ? '[' + e.metadata.arquivo + '] ' : '') + e.texto.slice(0, 50)) + (e.texto.length > 50 ? '…' : '') + '</label>' +
        ' <button type="button" class="axis-btn axis-btn-sm axis-system-delete axis-treino-del" data-id="' + esc(e.id) + '" style="float:right;">apagar</button></div></div>'
    ).join('');
    el.querySelectorAll('.axis-treino-ativo').forEach((cb) => cb.addEventListener('change', async () => {
        await Biblioteca.definirAtivo(cb.dataset.id, cb.checked);
    }));
    el.querySelectorAll('.axis-treino-del').forEach((btn) => btn.addEventListener('click', async () => {
        await Biblioteca.apagar({ id: btn.dataset.id });
        renderTreinoBiblioteca();
    }));
}

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
        else escreverTicker('Spade em espera.');
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
// ====================================
let espacoLocalLog = [];
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
    const hist = await estadoGet('espacoHistory', []);
    espacoLocalLog = hist.map((m) => ({ role: m.role, content: m.content }));
    renderEspacoChat();
}
async function sendEspacoMessage(text) {
    espacoLocalLog.push({ role: 'user', content: text });
    renderEspacoChat();
    const result = await respondEspaco(text);
    if (result.abandoned) return; // usuário já foi pro RP — abandona em silêncio
    espacoLocalLog.push({ role: 'agent', content: result.erro ? '⚠️ ' + result.erro : (result.resposta || '(sem resposta)') });
    renderEspacoChat();
    if (result.redirecionarTreino) switchTab('treino'); // ela mesma decidiu redirecionar
}

// ====================================
// TREINO DE TOM — UI (chat próprio + upload de arquivo/foto).
// ====================================
let treinoLocalLog = [];
async function carregarTreinoHistorico() {
    const hist = await estadoGet('treinoTomHistory', []);
    treinoLocalLog = hist.map((m) => ({ role: m.role, content: m.content }));
}
async function sendTreinoMessage(text) {
    await journalAdicionar('Você: ' + text, 'treino'); // eco simples no journal — não é chat separado, é tudo o mesmo fluxo exposto
    const result = await respondTreinoTom(text);
    if (result.abandoned) return;
    if (result.erro) await journalAdicionar('⚠️ ' + result.erro, 'treino');
    else if (result.resposta) await journalAdicionar(result.resposta, 'treino');
}

// ====================================
// BIBLIOTECA — UI de upload/lista/busca/apagar.
// ====================================
async function renderBiblioteca() {
    const el = document.getElementById('axis-biblioteca-lista');
    if (!el) return;
    const entradas = await Biblioteca.listar({});
    if (!entradas.length) { el.innerHTML = '<div class="axis-empty">Biblioteca vazia — sobe um arquivo ou deixa ela escrever sozinha.</div>'; return; }
    el.innerHTML = entradas.slice(0, 80).map((e) =>
        '<div class="axis-library-folder"><div class="axis-library-folder-header">[' + esc(e.tipo) + '] ' +
        esc(e.texto.slice(0, 60)) + (e.texto.length > 60 ? '…' : '') +
        ' <button type="button" class="axis-btn axis-btn-sm axis-system-delete axis-bib-del" data-id="' + esc(e.id) + '" style="float:right;">apagar</button></div></div>'
    ).join('');
    el.querySelectorAll('.axis-bib-del').forEach((btn) => btn.addEventListener('click', async () => {
        await Biblioteca.apagar({ id: btn.dataset.id });
        renderBiblioteca();
    }));
}
// Fase (onProgresso) -> texto curto de status, pt-BR, mesmo padrão de status
// que o resto da extensão usa nas outras abas.
const FASE_INGESTAO_LABEL = {
    lendo: 'lendo', descrevendo_imagem: 'descrevendo imagem', extraindo: 'extraindo fatos',
    processando_item: 'processando', vazio: 'nada pra segmentar', nada_relevante: 'nada relevante achado',
    concluido: 'concluído', erro: 'erro',
};
async function handleUploadArquivos(files) {
    const statusEl = document.getElementById('axis-biblioteca-status');
    const resultados = await ingerirArquivos(files, ({ arquivo, fase, detalhe }) => {
        if (!statusEl) return;
        statusEl.textContent = arquivo + ': ' + (FASE_INGESTAO_LABEL[fase] || fase) + (detalhe ? ' — ' + detalhe : '') + '...';
    });
    if (statusEl) {
        statusEl.textContent = resultados.map((r) => {
            if (!r.ok) return r.arquivo + ': erro — ' + r.erro;
            if (r.aviso) return r.arquivo + ': ' + r.aviso;
            const partes = [(r.guardados || 0) + ' novo(s)'];
            if (r.atualizados) partes.push(r.atualizados + ' atualizado(s)');
            if (r.ignoradosDuplicata) partes.push(r.ignoradosDuplicata + ' duplicata(s) ignorada(s)');
            return r.arquivo + ': ' + partes.join(', ') + '.';
        }).join(' · ');
    }
    renderBiblioteca();
}

// ====================================
// SISTEMAS — UI de lista/apagar (a IA cria; o humano só tem atalho de apagar).
// ====================================
async function renderSistemas() {
    const el = document.getElementById('axis-sistemas-lista');
    if (!el) return;
    const sistemas = await Sistemas.listar();
    if (!sistemas.length) { el.innerHTML = '<div class="axis-empty">Nenhum sistema criado ainda — ela cria sozinha quando fizer sentido.</div>'; return; }
    el.innerHTML = sistemas.map((s) =>
        '<div class="axis-system-item"><div class="axis-system-name">' + esc(s.nome) + (s.ativo ? '' : ' (inativo)') + '</div>' +
        '<div class="axis-system-desc">' + (s.quando ? 'quando: ' + esc(s.quando) : 'sempre ativo') + '</div>' +
        '<div class="axis-system-explicacao">' + esc(s.entao) + '</div>' +
        '<button type="button" class="axis-btn axis-btn-sm axis-system-delete axis-sis-del" data-id="' + esc(s.id) + '">apagar</button></div>'
    ).join('');
    el.querySelectorAll('.axis-sis-del').forEach((btn) => btn.addEventListener('click', async () => {
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
            '<div class="axis-system-item"><div class="axis-system-name">' + esc(s.nome) + ' v' + s.versao + (s.ativo ? ' · ativo' : '') + '</div>' +
            '<div class="axis-system-desc">família: ' + esc(s.familia) + ' · hook: ' + esc(s.hookAlvo) + '</div></div>'
        ).join('');
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
        '<div class="axis-npc-form" style="display:flex;flex-direction:column;">' +
        '<label>API key da NanoGPT</label><input type="password" id="cfg-apikey" value="' + esc(cfg.apiKey) + '" placeholder="cola sua key aqui">' +
        '<label>Modelo escritor (fala/decisão)</label><input type="text" id="cfg-writer" value="' + esc(cfg.modeloEscritor) + '">' +
        '<label>Modelo rápido (cantos/classificação)</label><input type="text" id="cfg-flash" value="' + esc(cfg.modeloRapido) + '">' +
        '<label>Modelo de embedding</label><input type="text" id="cfg-embed" value="' + esc(cfg.modeloEmbed) + '">' +
        '<label>Modelo de visão (só pro Treino de Tom, quando manda foto)</label><input type="text" id="cfg-visao" value="' + esc(cfg.modeloVisao) + '">' +
        '<label>Modelo da Construtora (vazio = usa o mesmo escritor, "1 IA só" — spade-fundicao.md seção 1)</label><input type="text" id="cfg-construtor" value="' + esc(cfg.modeloConstrutor) + '" placeholder="deixa vazio pra 1 IA só">' +
        '<label>Descanso do loop de pensamento quando ela termina sem nada pra fazer nem pedir pausa (segundos)</label><input type="number" id="cfg-cooldown" value="' + Math.round(cfg.cooldownOciosoMs / 1000) + '">' +
        '<label>Teto de passos por sessão (RP/Espaço/Pensamento — Treino de Tom usa um teto próprio, mais alto)</label><input type="number" id="cfg-maxiter" value="' + cfg.maxIteracoesAgente + '">' +
        '<label>Dias parado + baixa importância + nunca reacessado até arquivar sozinho (na consolidação)</label><input type="number" id="cfg-decay" value="' + cfg.decayDiasMin + '">' +
        '<button type="button" class="axis-btn axis-btn-send" id="cfg-salvar" style="margin-top:8px;">Salvar</button></div>';
    document.getElementById('cfg-salvar').addEventListener('click', () => {
        setConfig({
            apiKey: document.getElementById('cfg-apikey').value.trim(),
            modeloEscritor: document.getElementById('cfg-writer').value.trim(),
            modeloRapido: document.getElementById('cfg-flash').value.trim(),
            modeloEmbed: document.getElementById('cfg-embed').value.trim(),
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
// pronto pra isso (.axis-mini-chat-bar/.axis-mini-tab, .axis-rambling-log,
// .axis-library-panel, .axis-systems-panel).
// ====================================
const TABS = ['espaco', 'pensamento', 'treino', 'biblioteca', 'sistemas', 'config'];
function switchTab(tab) {
    TABS.forEach((t) => {
        const body = document.getElementById('axis-tab-' + t);
        if (body) body.style.display = t === tab ? 'flex' : 'none';
        const btn = document.getElementById('axis-mini-' + t);
        if (btn) btn.classList.toggle('axis-mini-active', t === tab);
    });
    // O rodapé de envio principal só serve o Espaço — Treino tem o próprio
    // campo embutido na aba, o resto não precisa digitar nada.
    const rodapePrincipal = document.getElementById('axis-footer-espaco');
    if (rodapePrincipal) rodapePrincipal.style.display = tab === 'espaco' ? 'flex' : 'none';
    if (tab === 'pensamento') renderJournal();
    if (tab === 'treino') { renderJournalTreino(); renderTreinoBiblioteca(); }
    if (tab === 'biblioteca') renderBiblioteca();
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
        '<span class="axis-espaco-title">♠ SPADE</span>' +
        '<div class="axis-status-dots">' +
        '<div class="axis-dot axis-dot-idle" id="axis-dot-reading"></div>' +
        '<div class="axis-dot axis-dot-idle" id="axis-dot-writing"></div>' +
        '<div class="axis-dot axis-dot-idle" id="axis-dot-thinking"></div>' +
        '</div>' +
        '<div class="axis-espaco-header-actions"><button type="button" class="axis-btn axis-btn-close" id="axis-espaco-close">✕</button></div></div>' +
        '<div class="axis-mini-chat-bar">' +
        '<span class="axis-mini-tab axis-mini-active" id="axis-mini-espaco">Espaço</span>' +
        '<span class="axis-mini-tab" id="axis-mini-pensamento">Pensamento</span>' +
        '<span class="axis-mini-tab" id="axis-mini-treino">Treino de Tom</span>' +
        '<span class="axis-mini-tab" id="axis-mini-biblioteca">Biblioteca</span>' +
        '<span class="axis-mini-tab" id="axis-mini-sistemas">Sistemas</span>' +
        '<span class="axis-mini-tab" id="axis-mini-config">Config</span></div>' +
        '<div class="axis-espaco-body" style="position:relative;">' +

        '<div id="axis-tab-espaco" class="axis-espaco-body" style="display:flex;">' +
        '<div class="axis-espaco-chat" id="axis-espaco-chat"></div></div>' +

        '<div id="axis-tab-pensamento" class="axis-espaco-body" style="display:none;">' +
        '<div class="axis-rambling-log axis-rambling-show" id="axis-journal" style="max-height:none;flex:1;"></div></div>' +

        '<div id="axis-tab-treino" class="axis-espaco-body" style="display:none;flex-direction:column;">' +
        '<div style="padding:8px 12px;border-bottom:1px solid #1a1a3a;">' +
        '<input type="file" id="axis-treino-upload" multiple accept=".txt,.md,.json,image/*" style="color:#a0a0c0;font-size:12px;">' +
        '<div style="font-size:10px;color:#5a5a7a;margin-top:3px;">texto ou foto — vira referência de tom/personalidade</div></div>' +
        '<div class="axis-rambling-log axis-rambling-show" id="axis-journal-treino" style="max-height:38%;border-bottom:1px solid #1a1a3a;"></div>' +
        '<div id="axis-treino-lista" style="overflow-y:auto;flex:1;padding:8px;"></div>' +
        '<div class="axis-espaco-input-wrap" style="padding:8px 10px;border-top:1px solid #1a1a3a;flex-direction:row;display:flex;gap:8px;">' +
        '<textarea class="axis-espaco-input" id="axis-treino-input" placeholder="Fala com ela sobre o tom/personalidade..." rows="1" style="flex:1;"></textarea>' +
        '<button type="button" class="axis-btn axis-btn-send" id="axis-treino-send">Enviar</button></div></div>' +

        '<div id="axis-tab-biblioteca" class="axis-espaco-body" style="display:none;flex-direction:column;">' +
        '<div style="padding:8px 12px;border-bottom:1px solid #1a1a3a;">' +
        '<input type="file" id="axis-biblioteca-upload" multiple accept=".txt,.md,.markdown,.json,.csv,.tsv,.yaml,.yml,.log,image/*" style="color:#a0a0c0;font-size:12px;">' +
        '<div style="font-size:10px;color:#5a5a7a;margin-top:3px;">texto, PNG de character card ou foto — a IA decide o que vale guardar</div>' +
        '<div id="axis-biblioteca-status" style="font-size:11px;color:#6a6a8a;margin-top:4px;"></div></div>' +
        '<div id="axis-biblioteca-lista" style="overflow-y:auto;flex:1;padding:8px;"></div></div>' +

        '<div id="axis-tab-sistemas" class="axis-espaco-body" style="display:none;flex-direction:column;">' +
        '<div id="axis-sistemas-lista" style="overflow-y:auto;flex:1;padding:8px;"></div>' +
        '<div style="padding:8px 12px;border-top:1px solid #1a1a3a;border-bottom:1px solid #1a1a3a;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
        '<span style="font-size:11px;color:#6a6a8a;">Sistemas reais (código):</span>' +
        '<button type="button" class="axis-btn axis-btn-sm" id="axis-sistemas-reais-exportar">Exportar</button>' +
        '<button type="button" class="axis-btn axis-btn-sm" id="axis-sistemas-reais-importar-btn">Importar</button>' +
        '<input type="file" id="axis-sistemas-reais-importar" accept=".json" style="display:none;">' +
        '</div>' +
        '<div id="axis-sistemas-reais-status" style="font-size:11px;color:#6a6a8a;padding:4px 12px;"></div>' +
        '<div id="axis-sistemas-reais-lista" style="overflow-y:auto;flex:1;padding:8px;"></div></div>' +

        '<div id="axis-tab-config" class="axis-espaco-body" style="display:none;padding:10px 14px;overflow-y:auto;">' +
        '<div id="axis-config-body"></div></div>' +

        '</div>' +
        '<div class="axis-espaco-footer" id="axis-footer-espaco">' +
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
        if (panel.classList.contains('axis-visible')) { carregarEspacoHistorico(); carregarTreinoHistorico(); switchTab('espaco'); }
    });
    document.getElementById('axis-espaco-close').addEventListener('click', () => {
        panel.classList.remove('axis-visible');
        toggleBtn.classList.remove('axis-active');
    });

    TABS.forEach((t) => document.getElementById('axis-mini-' + t).addEventListener('click', () => switchTab(t)));

    document.getElementById('axis-biblioteca-upload').addEventListener('change', (e) => {
        const files = Array.from(e.target.files || []);
        if (files.length) handleUploadArquivos(files).catch(reportFatalError);
        e.target.value = '';
    });
    document.getElementById('axis-treino-upload').addEventListener('change', (e) => {
        const files = Array.from(e.target.files || []);
        if (files.length) handleUploadTreino(files).catch(reportFatalError);
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
    const treinoInputEl = document.getElementById('axis-treino-input');
    const treinoSendBtn = document.getElementById('axis-treino-send');
    function doSendTreino() {
        const text = treinoInputEl.value.trim();
        if (!text) return;
        treinoInputEl.value = '';
        sendTreinoMessage(text).catch(reportFatalError);
    }
    treinoSendBtn.addEventListener('click', doSendTreino);
    treinoInputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSendTreino(); } });

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
    try { renderEspacoChat(); wireRpPresence(); } catch (e) { reportFatalError(e); }
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
