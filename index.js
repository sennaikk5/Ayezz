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
        modeloVisao: 'gpt-4o',        // usado só pelo Treino de Tom quando você manda foto — troca se preferir outro modelo com visão
        cooldownOciosoMs: 45000,      // último recurso: só entra se ela terminar sem nada pra fazer E sem pedir pausa (ver pensamento_aguardar)
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
const IDB_VERSION = 1;
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
// BIBLIOTECA — um store só, quatro verbos genéricos, N tipos de entrada
// (fala/documento/cena/memoria/estado_interno). Isso SUBSTITUI o que antes
// seriam APIs separadas (Perfil fixo, Falas, Cenas, memória por comando) —
// é o mesmo mecanismo pra tudo, só muda a etiqueta `tipo`.
// ====================================
const Biblioteca = {
    async escrever({ tipo, texto, metadata = {}, chaveFixa = null }) {
        if (!texto?.trim()) throw new Error('texto vazio.');
        const personagem = personagemAtual();
        // chaveFixa: usado por escritas automáticas (ex: estado_interno) que
        // devem ATUALIZAR uma entrada, não acumular infinitas — se vier, o id
        // é determinístico em vez de aleatório.
        const id = chaveFixa ? ('fixo-' + personagem + '-' + chaveFixa) : newId();
        let embedding = null;
        try { embedding = await embedNanoGPT(texto.slice(0, 4000)); } catch (e) { console.warn('[biblioteca] embedding falhou, entrada fica sem busca semântica:', e.message); }
        // ativo — usado principalmente pelas entradas tipo "tom" (treino de
        // voz): dá pra ter referência guardada mas DESLIGADA da cena atual,
        // sem precisar apagar. undefined conta como ativo (default true).
        const metadataFinal = Object.assign({ ativo: true }, metadata);
        const entry = { id, tipo, texto: texto.trim(), embedding, metadata: metadataFinal, personagem, createdAt: Date.now(), updatedAt: Date.now() };
        await idbPut('biblioteca', entry);
        return entry;
    },
    async editar({ id, texto }) {
        const atual = await idbGet('biblioteca', id);
        if (!atual) throw new Error('Entrada não encontrada: ' + id);
        let embedding = atual.embedding;
        try { embedding = await embedNanoGPT(texto.slice(0, 4000)); } catch (_) { /* mantém embedding antigo se falhar */ }
        const entry = Object.assign({}, atual, { texto: texto.trim(), embedding, updatedAt: Date.now() });
        await idbPut('biblioteca', entry);
        return entry;
    },
    async apagar({ id }) {
        await idbDelete('biblioteca', id);
        return { ok: true };
    },
    async listar({ tipos } = {}) {
        const all = await idbAllByPersonagem('biblioteca', personagemAtual());
        const filtered = tipos?.length ? all.filter((e) => tipos.includes(e.tipo)) : all;
        return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
    },
    // Upload de arquivo — chunk + embed em LOTE (uma chamada de API pra N
    // chunks, não N chamadas — a NanoGPT aceita array em `input`). `tipo`
    // deixa reaproveitar isso tanto pra Biblioteca geral ("documento") quanto
    // pro Treino de Tom ("tom").
    async subirArquivo(nomeArquivo, textoCompleto, onProgress, tipo = 'documento') {
        const chunks = chunkText(textoCompleto, 700, 80);
        if (!chunks.length) return { chunks: 0 };
        const embeddings = await embedNanoGPT(chunks.map((c) => c.slice(0, 4000)));
        const personagem = personagemAtual();
        for (let i = 0; i < chunks.length; i++) {
            await idbPut('biblioteca', {
                id: newId(), tipo, texto: chunks[i],
                embedding: embeddings[i] || null,
                metadata: { arquivo: nomeArquivo, chunk: i + 1, deChunks: chunks.length, ativo: true },
                personagem, createdAt: Date.now(), updatedAt: Date.now(),
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
    // Busca de verdade — embeda a consulta, cosseno contra tudo, top-k.
    // `fala`/`tom` ganham um pequeno boost (referência de voz importa toda
    // cena). Entrada com metadata.ativo === false fica de fora — é assim que
    // o Treino de Tom liga/desliga um lote de referência sem apagar nada.
    async buscar({ consulta, tipos = null, k = 6 }) {
        if (!consulta?.trim()) return [];
        const all = (await this.listar({ tipos })).filter((e) => e.metadata?.ativo !== false);
        const comEmbedding = all.filter((e) => e.embedding);
        if (!comEmbedding.length) return [];
        let queryEmbedding;
        try { queryEmbedding = await embedNanoGPT(consulta.slice(0, 4000)); } catch (e) { console.warn('[biblioteca] busca sem embedding disponível:', e.message); return []; }
        if (!queryEmbedding) return [];
        return comEmbedding
            .map((e) => ({ ...e, score: cosineSim(queryEmbedding, e.embedding) * ((e.tipo === 'fala' || e.tipo === 'tom') ? 1.08 : 1) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, k)
            .filter((e) => e.score > 0.3);
    },
};

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
    const resultados = await Biblioteca.buscar({ consulta: sceneText, k: 8 });
    if (!resultados.length) return '';
    const formatted = resultados.map((r) => {
        if (r.tipo === 'fala') return (r.metadata?.polaridade === 'ruim' ? 'NÃO FALA ASSIM: ' : 'FALA ASSIM: ') + r.texto;
        if (r.tipo === 'cena') return '[Cena parecida do passado]\n' + r.texto;
        if (r.tipo === 'documento') return '[Da biblioteca — ' + (r.metadata?.arquivo || 'documento') + ']\n' + r.texto;
        if (r.tipo === 'tom') return '[TREINO DE TOM — como ela fala/é] ' + r.texto;
        if (r.tipo === 'memoria') return '[O que você mesma guardou] ' + r.texto;
        if (r.tipo === 'usuario') return '[O que você notou sobre o usuário] ' + r.texto;
        return r.texto;
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

    const [bibliotecaResult, repeticaoResult, estadoResult, mundoResult, sistemasResult] = await Promise.allSettled([
        compiledBibliotecaBlock(sceneText),
        Promise.resolve(compiledRepeticaoBlock(recentFinal)),
        evaluateInnerState(userMessage, charName).then((texto) => compiledInnerStateBlock(texto)),
        avancarRelogio(userMessage),
        Sistemas.listar().then((sistemas) => avaliarSistemas(sistemas, sceneText)),
    ]);

    const cantos = {};
    cantos.biblioteca = fromSettled(bibliotecaResult, 'biblioteca', '');
    cantos.repeticao = fromSettled(repeticaoResult, 'repetição', '');
    cantos.estado = fromSettled(estadoResult, 'estado', '');
    const mundoFallback = await getMundo();
    const mundo = fromSettled(mundoResult, 'mundo', mundoFallback);
    cantos.mundo = { estado: mundo.value, block: compiledMundoBlock(mundo.value), ok: mundo.ok };
    cantos.sistemas = fromSettled(sistemasResult, 'sistemas', '');

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
        compiledTarefasBlock(tarefas, charName),
        'Você é a ' + charName + ' — só ela, agora. Nada de ferramenta, nada de passo, nada de "agente" aqui: é ela ' +
        'falando de verdade. Responda curto, direto, em pt-br, coerente com o que veio acima.',
    ];
    return parts.filter(Boolean).join('\n\n');
}

// ====================================
// FERRAMENTAS — poucos verbos genéricos, alcance largo. É isso que dá
// "poder de verdade tipo agente de código" sem virar uma função nova por
// micro-ação. Usadas IGUAL tanto na Sala de Pensamento contínua quanto no
// Espaço (mesma tool, mesma execução — só muda quem decide chamar).
// ====================================
const TOOLS = [
    { type: 'function', function: { name: 'biblioteca_escrever', description: 'Adiciona uma entrada nova na sua Biblioteca — pode ser uma fala/exemplo de voz (tipo "fala"), uma nota sobre você mesma ou o que perceber (tipo "memoria"), ou qualquer outra coisa que valha guardar. Fica buscável por significado, não só por palavra exata.', parameters: { type: 'object', properties: { tipo: { type: 'string', description: 'Etiqueta livre, ex: "fala", "memoria", "observacao".' }, texto: { type: 'string' } }, required: ['tipo', 'texto'] } } },
    { type: 'function', function: { name: 'biblioteca_editar', description: 'Corrige o texto de uma entrada que já existe na Biblioteca.', parameters: { type: 'object', properties: { id: { type: 'string' }, texto: { type: 'string' } }, required: ['id', 'texto'] } } },
    { type: 'function', function: { name: 'biblioteca_apagar', description: 'Remove uma entrada da Biblioteca (ex: uma memória que não faz mais sentido, uma fala ruim).', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
    { type: 'function', function: { name: 'biblioteca_buscar', description: 'Busca na sua Biblioteca (falas, documentos, cenas passadas, memórias) por significado — não precisa da palavra exata.', parameters: { type: 'object', properties: { consulta: { type: 'string' }, tipos: { type: 'array', items: { type: 'string' } } }, required: ['consulta'] } } },
    { type: 'function', function: { name: 'biblioteca_listar', description: 'Visão geral do que já tem guardado na Biblioteca, com contagem por tipo.', parameters: { type: 'object', properties: { tipos: { type: 'array', items: { type: 'string' } } } } } },

    { type: 'function', function: { name: 'sistema_criar', description: 'Cria uma regra/sistema de verdade que passa a rodar sozinha toda rodada — não é só mais uma frase de prompt, fica ativa até você remover. Ex: um padrão a evitar, um contador que você mesma administra (tensão, paciência), um lembrete condicional.', parameters: { type: 'object', properties: { nome: { type: 'string' }, quando: { type: 'string', description: 'Condição em texto simples (palavra/tema que precisa aparecer na cena pra ativar) — deixe vazio pra sempre valer.' }, entao: { type: 'string', description: 'O que fazer/lembrar quando ativar.' } }, required: ['nome', 'entao'] } } },
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
    { type: 'function', function: { name: 'redirecionar_treino_tom', description: 'Só existe no Espaço. Abre a aba de Treino de Tom — use quando o usuário pedir pra treinar seu tom de voz, personalidade ou perfil, ou mandar arquivo/foto de referência pra isso. Isso muda a aba visível pro usuário, tira a conversa do Espaço normal.', parameters: { type: 'object', properties: {} } } },
];

async function executeTool(name, args) {
    switch (name) {
        case 'biblioteca_escrever': return Biblioteca.escrever({ tipo: args.tipo, texto: args.texto });
        case 'biblioteca_editar': return Biblioteca.editar({ id: args.id, texto: args.texto });
        case 'biblioteca_apagar': return Biblioteca.apagar({ id: args.id });
        case 'biblioteca_buscar': { const r = await Biblioteca.buscar({ consulta: args.consulta, tipos: args.tipos || null, k: 6 }); return r.map((e) => ({ id: e.id, tipo: e.tipo, texto: e.texto, similaridade: Number(e.score.toFixed(2)) })); }
        case 'biblioteca_listar': { const all = await Biblioteca.listar({ tipos: args.tipos }); const porTipo = {}; all.forEach((e) => { porTipo[e.tipo] = (porTipo[e.tipo] || 0) + 1; }); return { total: all.length, porTipo }; }

        case 'sistema_criar': return Sistemas.criar({ nome: args.nome, quando: args.quando || '', entao: args.entao });
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
    biblioteca_buscar: '🔎 buscando na biblioteca',
    biblioteca_listar: '📚 revisando a biblioteca',
    sistema_criar: '⚙️ criando um sistema novo',
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
    redirecionar_treino_tom: '🎙️ abrindo o treino de tom',
};
function labelFerramenta(nome) { return ACTION_LABEL[nome] || ('🔧 usando ' + nome); }

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
async function journalAdicionar(texto, contexto = 'pensamento') {
    const personagem = personagemAtual();
    const entry = { id: newId(), personagem, texto, contexto, ts: Date.now() };
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
        '<div class="axis-rambling-entry"><div class="axis-rambling-meta">' + new Date(e.ts).toLocaleTimeString('pt-BR') + '</div>' +
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
        (async () => { try { await Biblioteca.escrever({ tipo: 'cena', texto: [recentText, shown].join('\n') }); } catch (_) {} })();
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
                resultado = nome.startsWith('rp_') ? await aplicarAcaoRp(nome, args.texto, atividade) : await executeTool(nome, args);
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
async function handleUploadArquivos(files) {
    const statusEl = document.getElementById('axis-biblioteca-status');
    for (const file of files) {
        if (statusEl) statusEl.textContent = 'lendo ' + file.name + '...';
        const texto = await file.text();
        const { chunks } = await Biblioteca.subirArquivo(file.name, texto, (feito, total) => {
            if (statusEl) statusEl.textContent = file.name + ': ' + feito + '/' + total + ' pedaços indexados...';
        });
        if (statusEl) statusEl.textContent = file.name + ': ' + chunks + ' pedaços indexados.';
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
        '<label>Descanso do loop de pensamento quando ela termina sem nada pra fazer nem pedir pausa (segundos)</label><input type="number" id="cfg-cooldown" value="' + Math.round(cfg.cooldownOciosoMs / 1000) + '">' +
        '<label>Teto de passos por sessão (RP/Espaço/Pensamento — Treino de Tom usa um teto próprio, mais alto)</label><input type="number" id="cfg-maxiter" value="' + cfg.maxIteracoesAgente + '">' +
        '<button type="button" class="axis-btn axis-btn-send" id="cfg-salvar" style="margin-top:8px;">Salvar</button></div>';
    document.getElementById('cfg-salvar').addEventListener('click', () => {
        setConfig({
            apiKey: document.getElementById('cfg-apikey').value.trim(),
            modeloEscritor: document.getElementById('cfg-writer').value.trim(),
            modeloRapido: document.getElementById('cfg-flash').value.trim(),
            modeloEmbed: document.getElementById('cfg-embed').value.trim(),
            modeloVisao: document.getElementById('cfg-visao').value.trim(),
            cooldownOciosoMs: Math.max(5, Number(document.getElementById('cfg-cooldown').value) || 45) * 1000,
            maxIteracoesAgente: Math.max(1, Number(document.getElementById('cfg-maxiter').value) || 6),
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
    if (tab === 'sistemas') renderSistemas();
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
        '<input type="file" id="axis-biblioteca-upload" multiple accept=".txt,.md,.json" style="color:#a0a0c0;font-size:12px;">' +
        '<div id="axis-biblioteca-status" style="font-size:11px;color:#6a6a8a;margin-top:4px;"></div></div>' +
        '<div id="axis-biblioteca-lista" style="overflow-y:auto;flex:1;padding:8px;"></div></div>' +

        '<div id="axis-tab-sistemas" class="axis-espaco-body" style="display:none;">' +
        '<div id="axis-sistemas-lista" style="overflow-y:auto;flex:1;padding:8px;"></div></div>' +

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

} catch (fatalErr) {
    reportFatalError(fatalErr);
}

})();
