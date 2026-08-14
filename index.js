/*
 * Spade — Sistema Vivo v6.0.0
 * SillyTavern Extension by Senna
 *
 * TICKET 38 — decisão de arquitetura: backend Node separado (spade-server)
 * e site Lovable removidos. Tudo volta pra dentro de UM arquivo só, carregado
 * pela extensão do SillyTavern — exatamente como era antes do backend existir.
 * Motivo: custo operacional alto demais pro ambiente (DroidDesk) — CORS,
 * múltiplos processos, confusão de qual pasta/versão tá rodando, npm install
 * quebrando com dependência nativa (onnxruntime-node, 2x). O trabalho do
 * backend não se perde: é lógica JS pura, só muda de onde ela roda — de
 * chamada Node (SDK openai, fs) pra chamada de navegador (fetch, localStorage).
 *
 * O que muda de verdade em relação ao T37 (v5.0.0, WS pro spade-server):
 * 1) SEM WebSocket, SEM servidor. Toda função que antes mandava mensagem
 *    por WS e esperava evento de volta agora é uma chamada de função direta,
 *    no mesmo processo, síncrona onde dá e async/await onde precisa (IA).
 * 2) SEM data/state.json (fs do Node) — dois localStorage: um blob principal
 *    ("axis_brain_v1": perfil, falas, npcs, tarefas, fila de treino, mundo,
 *    nota do agente, log do agente, sala de pensamento, histórico do Espaço,
 *    config) e um separado só pra cenas indexadas ("axis_cenas_v1" — cresce
 *    sem parar e carrega vetor de embedding, não faz sentido reescrever o
 *    blob principal inteiro toda vez que ele muda, mesma razão que já
 *    separava cenas.json do state.json no backend).
 * 3) SEM SDK `openai` do Node — client próprio via fetch() direto pra
 *    https://nano-gpt.com/api/v1 (mesma base URL que o SDK já usava), com
 *    parsing manual de SSE pro streaming (fetch + ReadableStream, sem
 *    `for await` de stream de objeto que só existe no SDK). Chave da API
 *    mora em localStorage agora, digitada no painel ⚙ Config — mesmo modelo
 *    de risco (visível no DevTools) que a versão de 3000 linhas de antes do
 *    backend já tinha.
 * 4) O painel do Espaço ganhou uma segunda aba (⚙ Config) — é onde moram
 *    Perfil, Falas, Elenco (NPCs), Tarefas, Treino e Sala de Pensamento
 *    (o que antes eram janelas separadas no site Lovable). Não é o mesmo
 *    visual do site, mas cobre a mesma função — sem processo separado pra
 *    manter rodando.
 * 5) claimSurface/isStale, a família "boca" (postCharacterMessage etc.),
 *    wireRpPresence — continuam iguais, ideia de "um só" não mudou nada.
 *
 * GAP CONHECIDO, de propósito, não esquecimento: regenerate/swipe ainda
 * não passam pelo Spade (só age em type == null/undefined). Diálogo em
 * tempo real (pausa/interrupção de verdade durante geração) — a peça de
 * abort já existe (runRpTurn aborta a rodada anterior quando uma nova
 * começa), mas não tem UI pra interromper no meio ainda; fica pra depois.
 */

(function() {
'use strict';

// ====================================
// DIAGNÓSTICO DE ERRO FATAL — inalterado de sempre.
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

// ctx() é função, chamada de novo a cada uso — nunca guardada.
function ctx() { return SillyTavern.getContext(); }
const { eventSource, event_types } = ctx();

function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
// Pra dentro de atributo HTML (value="..."): esc() já cobre &/</>, mas não
// aspas (textContent->innerHTML não escapa aspas, elas só importam dentro
// de atributo, não em texto solto) — sem isso, um perfil/fala com aspas
// duplas quebrava o atributo no meio.
function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

// ====================================
// ESCOPO POR CHAT — só lastCharMessageIdx continua sendo estado
// puramente local (índice de array do DOM/chat do ST, efêmero). Tudo o
// mais (Perfil, Falas, NPCs, Tarefas...) é global (mesma personagem em
// qualquer chat) e mora no "cérebro" (ver ARMAZENAMENTO abaixo).
// ====================================
const SCOPE_DB = 'axis_v5';
let scopeData = {};
try { scopeData = JSON.parse(localStorage.getItem(SCOPE_DB) || '{}'); } catch (_) { scopeData = {}; }

let _scopeSaveFailureWarned = false;
function saveScope() {
    const payload = JSON.stringify(scopeData);
    try {
        localStorage.setItem(SCOPE_DB, payload);
    } catch (e) {
        console.error('[Spade] saveScope() falhou:', e);
        if (!_scopeSaveFailureWarned) {
            _scopeSaveFailureWarned = true;
            try { alert('⚠️ O Spade não conseguiu salvar. Erro: ' + (e.message || e)); } catch (_) {}
        }
        return;
    }
    _scopeSaveFailureWarned = false;
}

function scope() {
    const charId = ctx().characterId ?? ctx().groupId ?? 'global';
    const chatId = typeof ctx().getCurrentChatId === 'function' ? ctx().getCurrentChatId() : 'default';
    const key = 'rp_' + charId + '_' + chatId;
    if (!scopeData[key]) {
        scopeData[key] = { lastCharMessageIdx: null };
        saveScope();
    }
    if (scopeData[key].lastCharMessageIdx === undefined) scopeData[key].lastCharMessageIdx = null;
    return scopeData[key];
}

// ====================================
// NOME/AVATAR REAL DO PERSONAGEM — inalterado. Agora também usado como
// CHAR_NAME dentro da pipeline/agent/espaço (o backend antigo hardcodeava
// "Hanna" porque não tinha acesso ao ST; a extensão tem, então usa o nome
// de verdade — na prática dá no mesmo, já que é sempre a Hanna, mas fica
// certo pra qualquer outra personagem também).
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

// ====================================
// PRESENÇA UNIFICADA — "um só". Inalterado.
// ====================================
let activeSurface = null; // 'rp' | 'espaco' | null
let opToken = 0;

function claimSurface(surface) {
    if (activeSurface !== surface) opToken++;
    activeSurface = surface;
    return opToken;
}
function isStale(token) { return token !== opToken; }

// ====================================
// BOLINHAS DE STATUS + PÍLULA — inalterado.
// ====================================
let dotReading = null, dotWriting = null, dotThinking = null;
function setDot(dot, state) { if (dot) dot.className = 'axis-dot axis-dot-' + state; }
function setDots(reading, writing, thinking) { setDot(dotReading, reading); setDot(dotWriting, writing); setDot(dotThinking, thinking); }
function dotsIdle() { setDots('idle', 'idle', 'idle'); }
function dotsWriting() { setDots('idle', 'writing', 'idle'); }
function dotsThinking() { setDots('idle', 'idle', 'thinking'); }
function dotsError() { setDots('error', 'idle', 'idle'); }

function showStatusPill(text) {
    let pill = document.getElementById('axis-status-pill');
    if (!pill) {
        pill = document.createElement('div');
        pill.id = 'axis-status-pill';
        document.body.appendChild(pill);
    }
    pill.textContent = '💭 ' + text;
    pill.classList.add('axis-status-visible');
    clearTimeout(showStatusPill._t);
    showStatusPill._t = setTimeout(() => pill.classList.remove('axis-status-visible'), 5 * 60 * 1000);
}

// ====================================
// ARMAZENAMENTO — "cérebro". Substitui data/state.json (fs do Node).
// Dois localStorage separados pelo mesmo motivo que já separava
// state.json de cenas.json no backend: cenas crescem sem parar e cada
// uma carrega um vetor de embedding — não faz sentido reescrever o blob
// principal (que muda toda hora, coisas pequenas) só porque uma cena
// nova foi indexada.
// ====================================
const BRAIN_KEY = 'axis_brain_v1';
const CENAS_KEY = 'axis_cenas_v1';

function readBrain() {
    try { return JSON.parse(localStorage.getItem(BRAIN_KEY) || '{}'); } catch (_) { return {}; }
}
let _brainSaveFailureWarned = false;
function writeBrain(patch) {
    const next = Object.assign({}, readBrain(), patch);
    try {
        localStorage.setItem(BRAIN_KEY, JSON.stringify(next));
        _brainSaveFailureWarned = false;
    } catch (e) {
        console.error('[Spade] writeBrain() falhou (localStorage cheio/bloqueado?):', e);
        if (!_brainSaveFailureWarned) {
            _brainSaveFailureWarned = true;
            try { alert('⚠️ O Spade não conseguiu salvar (localStorage cheio ou bloqueado). Erro: ' + (e.message || e)); } catch (_) {}
        }
    }
    return next;
}

function readCenas() {
    try { return JSON.parse(localStorage.getItem(CENAS_KEY) || '[]'); } catch (_) { return []; }
}
function writeCenas(list) {
    try { localStorage.setItem(CENAS_KEY, JSON.stringify(list)); } catch (e) {
        console.error('[Spade] writeCenas() falhou:', e);
    }
}

// ====================================
// CONFIG — substitui config.js + .env. Editável no painel ⚙ Config › 🔑.
// ====================================
const DEFAULT_MODELS = {
    writer: 'deepseek/deepseek-v4-pro',
    flash: 'deepseek/deepseek-v4-flash-0731',
    embed: 'BAAI/bge-m3',
};
function getConfig() {
    const c = readBrain().config || {};
    return {
        apiKey: c.apiKey || '',
        modelWriter: c.modelWriter || DEFAULT_MODELS.writer,
        modelFlash: c.modelFlash || DEFAULT_MODELS.flash,
        modelEmbed: c.modelEmbed || DEFAULT_MODELS.embed,
    };
}
function setConfig(partial) {
    const current = readBrain().config || {};
    return writeBrain({ config: Object.assign({}, current, partial) }).config;
}

// ====================================
// CLIENTE NANOGPT — substitui nanogpt.js (SDK openai do Node) por fetch()
// direto. Mesma base URL que o SDK usava. Streaming: parsing manual de
// SSE (linhas "data: {...}\n\n", termina com "data: [DONE]") via
// response.body.getReader() — não existe stream de objeto pronto fora
// do SDK, então isso é reimplementado aqui à mão.
// ====================================
const NANOGPT_BASE = 'https://nano-gpt.com/api/v1';

function makeTimeoutSignal(ms, externalSignal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const onExternalAbort = () => ctrl.abort();
    if (externalSignal) {
        if (externalSignal.aborted) ctrl.abort();
        else externalSignal.addEventListener('abort', onExternalAbort);
    }
    function cancel() {
        clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
    return { signal: ctrl.signal, cancel };
}

async function ngRequest(path, body, opts) {
    opts = opts || {};
    const apiKey = getConfig().apiKey;
    if (!apiKey) throw new Error('Chave da NanoGPT não configurada — abre ⚙ Config › 🔑 Chave.');
    let resp;
    try {
        resp = await fetch(NANOGPT_BASE + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
            body: JSON.stringify(body),
            signal: opts.signal,
        });
    } catch (err) {
        if (err.name === 'AbortError') throw err;
        throw new Error('Falha de rede falando com a NanoGPT: ' + err.message);
    }
    if (!resp.ok) {
        let detail = '';
        try { detail = (await resp.json())?.error?.message || ''; } catch (_) {}
        throw new Error('NanoGPT respondeu ' + resp.status + (detail ? ' — ' + detail : ''));
    }
    return resp;
}

// Não-streaming — pra etapas auxiliares (cantos, classificação).
async function generate(model, messages, opts) {
    opts = opts || {};
    const { signal, cancel } = makeTimeoutSignal(opts.timeoutMs ?? 20000, opts.signal);
    try {
        const resp = await ngRequest('/chat/completions', {
            model, messages,
            max_tokens: opts.maxTokens ?? 800,
            temperature: opts.temperature ?? 0.85,
        }, { signal });
        const data = await resp.json();
        const choice = data.choices?.[0];
        const content = choice?.message?.content ?? '';
        if (!content.trim() && choice?.finish_reason === 'length') {
            console.warn('[Spade] "' + model + '" voltou content vazio com finish_reason=length — provável estouro de max_tokens (' + (opts.maxTokens ?? 800) + ') ainda "pensando".');
        }
        return content;
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Sem resposta da NanoGPT em ' + Math.round((opts.timeoutMs ?? 20000) / 1000) + 's.');
        throw err;
    } finally {
        cancel();
    }
}

// Function calling de verdade — uma rodada só, devolve texto + tool_calls.
async function generateWithTools(model, messages, tools, opts) {
    opts = opts || {};
    const { signal, cancel } = makeTimeoutSignal(opts.timeoutMs ?? 30000, opts.signal);
    try {
        const resp = await ngRequest('/chat/completions', {
            model, messages, tools,
            tool_choice: opts.toolChoice ?? 'auto',
            max_tokens: opts.maxTokens ?? 1000,
            temperature: opts.temperature ?? 0.8,
        }, { signal });
        const data = await resp.json();
        const choice = data.choices?.[0];
        return {
            content: choice?.message?.content ?? '',
            toolCalls: choice?.message?.tool_calls ?? [],
            finishReason: choice?.finish_reason,
        };
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Sem resposta da NanoGPT em ' + Math.round((opts.timeoutMs ?? 30000) / 1000) + 's.');
        throw err;
    } finally {
        cancel();
    }
}

// Streaming de verdade — token por token via SSE manual. Watchdog manual
// (reseta a cada token que chega de verdade, só aborta se ficar REALMENTE
// parado por timeoutMs) — mesma lógica que já existia no backend Node,
// só que ali era `for await` de stream de objeto do SDK, aqui é
// getReader()/TextDecoder à mão.
async function generateStream(model, messages, onToken, opts) {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs ?? 45000;
    const watchdogCtrl = new AbortController();
    let watchdogTimer = setTimeout(() => watchdogCtrl.abort(), timeoutMs);
    function resetWatchdog() {
        clearTimeout(watchdogTimer);
        watchdogTimer = setTimeout(() => watchdogCtrl.abort(), timeoutMs);
    }

    const combinedCtrl = new AbortController();
    const onWatchdogAbort = () => combinedCtrl.abort();
    const onExternalAbort = () => combinedCtrl.abort();
    watchdogCtrl.signal.addEventListener('abort', onWatchdogAbort);
    if (opts.signal) {
        if (opts.signal.aborted) combinedCtrl.abort();
        else opts.signal.addEventListener('abort', onExternalAbort);
    }

    try {
        const resp = await ngRequest('/chat/completions', {
            model, messages,
            max_tokens: opts.maxTokens ?? 1200,
            temperature: opts.temperature ?? 0.85,
            stream: true,
        }, { signal: combinedCtrl.signal });

        const reader = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buf = '';
        let full = '';
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            resetWatchdog();
            buf += decoder.decode(value, { stream: true });
            let nlIdx;
            while ((nlIdx = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, nlIdx).trim();
                buf = buf.slice(nlIdx + 1);
                if (!line.startsWith('data:')) continue;
                const payload = line.slice(5).trim();
                if (payload === '[DONE]') continue;
                let evt;
                try { evt = JSON.parse(payload); } catch (_) { continue; }
                const delta = evt.choices?.[0]?.delta?.content;
                if (delta) { full += delta; onToken(delta); }
            }
        }
        return full;
    } catch (err) {
        if (watchdogCtrl.signal.aborted && !(opts.signal && opts.signal.aborted)) {
            throw new Error('Sem resposta da NanoGPT por ' + Math.round(timeoutMs / 1000) + 's — rede travada (não foi você interrompendo).');
        }
        throw err;
    } finally {
        clearTimeout(watchdogTimer);
        watchdogCtrl.signal.removeEventListener('abort', onWatchdogAbort);
        if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
    }
}

// Embedding via API (BAAI/bge-m3) — deixa propagar o erro; getEmbedding()
// (seção CENAS abaixo) é quem decide devolver null em vez de derrubar
// quem chama, igual já era a separação embeddings.js/nanogpt.js no backend.
async function embedNanoGPT(model, text) {
    const { signal, cancel } = makeTimeoutSignal(15000);
    try {
        const resp = await ngRequest('/embeddings', { model, input: text }, { signal });
        const data = await resp.json();
        return data?.data?.[0]?.embedding ?? null;
    } finally {
        cancel();
    }
}

// ====================================
// PERFIL (item 11) — cópia direta de profile.js, sem chamada de rede.
// ====================================
function splitIntoStages(text) {
    if (!text || !text.trim()) return [];
    const parts = text.split(/\n\s*(?:-{3,}\s*){3,}\n/g).map((p) => p.trim()).filter(Boolean);
    return parts.length ? parts : [text.trim()];
}
function compileStagedBlock(text, label) {
    const stages = splitIntoStages(text);
    if (stages.length <= 1) return stages[0] || '';
    return stages.map((s, i) => '[' + label + ' — parte ' + (i + 1) + '/' + stages.length + ']\n' + s).join('\n\n');
}
function getProfile() { return readBrain().profile || { text: '', updatedAt: 0 }; }
function setProfile(text) { return writeBrain({ profile: { text, updatedAt: Date.now() } }).profile; }
function compiledProfileBlock(charName) {
    const { text } = getProfile();
    if (!text || !text.trim()) return '';
    return '[QUEM ' + charName + ' É — leia por inteiro, isso é fundação, não detalhe solto pra ignorar]\n' + compileStagedBlock(text, 'PERFIL');
}

// ====================================
// CANTO PERFIL — resumo curto (Flash) do Perfil pra cena atual.
// ====================================
async function summarizeProfileForScene(recentText, charName) {
    const { text } = getProfile();
    if (!text || !text.trim()) return '';
    const prompt =
        'Perfil completo de ' + charName + ':\n' + text + '\n\n' +
        'Cena atual:\n' + recentText + '\n\n' +
        'Resuma em até 4 frases só o que desse perfil importa pra ESSA cena ' +
        'específica — mantém o essencial de quem ela é, sem repetir tudo. ' +
        'Responda só com o resumo, sem comentário nem título.';
    const resp = await generate(getConfig().modelFlash, [{ role: 'user', content: prompt }], { maxTokens: 700 });
    return (resp || '').trim();
}
function compiledPerfilCantoBlock(resumo, charName) {
    if (!resumo) return '';
    return '[QUEM ' + charName + ' É NESSA CENA — resumo do Perfil, não o texto inteiro]\n' + resumo;
}

// ====================================
// CANTO FALAS — RAG melhor: manda TODAS sempre, só reordena por categoria.
// ====================================
const FALA_TAG_RE = /^\[([^\]:]+)(?::(boa|ruim))?\]\s*(.+)$/;
function newId() { return Date.now() + '-' + Math.random().toString(36).slice(2, 8); }

function normalizeFalaItem(item) {
    if (typeof item === 'string') {
        const m = item.match(FALA_TAG_RE);
        if (m) {
            const category = m[1], polaridade = m[2], text = m[3];
            return { id: newId(), text: text.trim(), category: category.trim(), polaridade: polaridade || 'boa', origem: 'usuario', createdAt: Date.now() };
        }
        return { id: newId(), text: item.trim(), category: null, polaridade: 'boa', origem: 'usuario', createdAt: Date.now() };
    }
    return {
        id: item.id || newId(),
        text: String(item.text || '').trim(),
        category: item.category || null,
        polaridade: item.polaridade === 'ruim' ? 'ruim' : 'boa',
        origem: item.origem === 'ia' ? 'ia' : 'usuario',
        createdAt: item.createdAt || Date.now(),
    };
}
function getFalas() {
    const raw = readBrain().falas;
    const lines = (raw?.lines || []).map(normalizeFalaItem).filter((f) => f.text);
    return { lines, updatedAt: raw?.updatedAt || 0 };
}
function setFalas(rawLines) {
    const clean = (Array.isArray(rawLines) ? rawLines : [])
        .map((l) => String(l).trim())
        .filter(Boolean)
        .map(normalizeFalaItem);
    return writeBrain({ falas: { lines: clean, updatedAt: Date.now() } }).falas;
}
function addFala(opts) {
    opts = opts || {};
    const state = getFalas();
    const nova = normalizeFalaItem({ text: opts.text, category: opts.category ?? null, polaridade: opts.polaridade || 'boa', origem: opts.origem || 'usuario' });
    const lines = state.lines.concat([nova]);
    return writeBrain({ falas: { lines, updatedAt: Date.now() } }).falas;
}
function existingFalaCategories(lines) {
    return Array.from(new Set(lines.map((f) => f.category).filter(Boolean)));
}
async function classifySceneCategory(sceneText, categories) {
    if (!categories.length) return null;
    const prompt =
        'Categorias disponíveis: ' + categories.join(', ') + '\n\n' +
        'Cena:\n' + sceneText + '\n\n' +
        'Qual categoria combina mais com o clima dessa cena? Responda só com ' +
        'o nome exato de uma das categorias listadas, ou "nenhuma" se nenhuma combinar.';
    const resp = await generate(getConfig().modelFlash, [{ role: 'user', content: prompt }], { maxTokens: 50 });
    const answer = (resp || '').trim();
    return categories.find((c) => c.toLowerCase() === answer.toLowerCase()) || null;
}
async function organizarFalas() {
    const { lines } = getFalas();
    const categorias = existingFalaCategories(lines);
    const semCategoria = lines.filter((f) => !f.category);
    if (!categorias.length || !semCategoria.length) return { organizadas: 0 };

    let organizadas = 0;
    for (const fala of semCategoria) {
        let categoria = null;
        try { categoria = await classifySceneCategory(fala.text, categorias); } catch (_) {}
        if (categoria) { fala.category = categoria; organizadas += 1; }
    }
    if (organizadas > 0) writeBrain({ falas: { lines, updatedAt: Date.now() } });
    return { organizadas };
}
async function selectFalas(sceneText) {
    const { lines } = getFalas();
    if (!lines.length) return { lines: [], categoriaDetectada: null };
    const categories = existingFalaCategories(lines);
    let categoriaDetectada = null;
    try { categoriaDetectada = await classifySceneCategory(sceneText, categories); }
    catch (err) { console.warn('[Spade][falas] classificação de categoria falhou, seguindo sem ordenar:', err.message); }
    if (!categoriaDetectada) return { lines, categoriaDetectada: null };
    const match = lines.filter((f) => f.category === categoriaDetectada);
    const rest = lines.filter((f) => f.category !== categoriaDetectada);
    return { lines: match.concat(rest), categoriaDetectada };
}
async function compiledFalasBlock(sceneText) {
    const { lines, categoriaDetectada } = await selectFalas(sceneText);
    if (!lines.length) return '';
    const formatted = lines.map((f) => (f.polaridade === 'ruim' ? 'NÃO FALA ASSIM: ' : 'FALA ASSIM: ') + f.text);
    const header = categoriaDetectada
        ? '[EXEMPLOS DE VOZ — categoria "' + categoriaDetectada + '" primeiro, por combinar com a cena; todas as outras seguem depois. Modele tom/ritmo, não copie literal.]'
        : '[EXEMPLOS DE VOZ — modele tom/ritmo, não copie literal.]';
    return header + '\n' + formatted.join('\n');
}
function serializeFalaLine(f) {
    const tag = f.category ? '[' + f.category + (f.polaridade === 'ruim' ? ':ruim' : '') + '] ' : '';
    return tag + f.text;
}

// ====================================
// CANTO REPETIÇÃO — puro JS, sem IA.
// ====================================
const N_GRAM = 5;
const MIN_OCCURRENCES = 2;
function repWords(text) { return (text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []; }
function repNgrams(text, n) {
    n = n || N_GRAM;
    const w = repWords(text);
    const out = [];
    for (let i = 0; i + n <= w.length; i++) out.push(w.slice(i, i + n).join(' '));
    return out;
}
function detectRepetition(recentMessages, n, minOcc) {
    n = n || N_GRAM; minOcc = minOcc || MIN_OCCURRENCES;
    const counts = new Map();
    for (const msg of recentMessages || []) {
        const seenInThisMessage = new Set(repNgrams(msg, n));
        for (const g of seenInThisMessage) counts.set(g, (counts.get(g) || 0) + 1);
    }
    return Array.from(counts.entries()).filter((e) => e[1] >= minOcc).map((e) => e[0]);
}
function compiledRepeticaoBlock(recentMessages) {
    const flagged = detectRepetition(recentMessages);
    if (!flagged.length) return '';
    return '[EVITE REPETIR — essas sequências já apareceram nas últimas respostas]\n' + flagged.map((g) => '- "' + g + '"').join('\n');
}

// ====================================
// ESTADO INTERNO (item 3) — chamada separada, ANTES da fala de verdade,
// pra marcador nunca vazar no meio de streaming ao vivo.
// ====================================
function getInnerState() { return readBrain().innerState || { text: '', updatedAt: 0 }; }
function setInnerStateRaw(text) { return writeBrain({ innerState: { text, updatedAt: Date.now() } }).innerState; }
function applyInnerState(text) { return setInnerStateRaw(text); }
async function evaluateInnerState(recentText, charName) {
    const current = getInnerState();
    const prompt = 'Estado interno atual de ' + charName + ':\n' + (current.text || '(nenhum registrado ainda)') + '\n\n' +
        'Cena recente:\n' + recentText + '\n\n' +
        'Se o que rolou nessa troca mudar esse estado (de leve, por acúmulo, ou de vez, por algo específico), ' +
        'reescreva em um parágrafo curto com três coisas sempre: o que ela sente por dentro, o que mostra por ' +
        'fora (podem ser diferentes — geralmente são, ela guarda a compostura), e o motivo. Se ela perceber que ' +
        'baixou a guarda demais, isso pode ser o próprio motivo da próxima mudança — ela se fecha como reação. ' +
        'Se genuinamente não mudou nada, responda exatamente: SEM_MUDANCA';
    const resp = await generate(getConfig().modelFlash, [{ role: 'user', content: prompt }], { maxTokens: 700 });
    const trimmed = (resp || '').trim();
    if (!trimmed || trimmed === 'SEM_MUDANCA') return current;
    return setInnerStateRaw(trimmed);
}
function compiledInnerStateBlock() {
    const { text } = getInnerState();
    if (!text) return '';
    return '[ESTADO DE FUNDO — pode colorir a cena, não precisa ser dito]\n' + text;
}

// ====================================
// EMBEDDINGS + CENAS (item 5c) — busca de verdade (cosseno) no histórico
// de RP indexado. Fica no localStorage separado (axis_cenas_v1).
// ====================================
async function getEmbedding(text) {
    if (!text || !text.trim()) return null;
    try { return await embedNanoGPT(getConfig().modelEmbed, text); }
    catch (err) { console.warn('[Spade][embeddings] falhou:', err.message); return null; }
}
function cosineSim(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
    if (!normA || !normB) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
const MAX_CENAS = 2000;
async function indexScene(userMessage, finalMessage) {
    const text = [userMessage, finalMessage].filter(Boolean).join('\n');
    if (!text.trim()) return null;
    const embedding = await getEmbedding(text);
    if (!embedding) return null;
    const cenas = readCenas();
    cenas.push({ id: newId(), text, embedding, timestamp: Date.now() });
    while (cenas.length > MAX_CENAS) cenas.shift();
    writeCenas(cenas);
    return cenas[cenas.length - 1];
}
async function searchScenes(queryText, k) {
    k = k || 2;
    if (!queryText || !queryText.trim()) return [];
    const cenas = readCenas();
    if (!cenas.length) return [];
    const queryEmbedding = await getEmbedding(queryText);
    if (!queryEmbedding) return [];
    return cenas
        .map((c) => Object.assign({}, c, { score: cosineSim(queryEmbedding, c.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .filter((c) => c.score > 0.3);
}
async function compiledScenesBlock(sceneText) {
    const top = await searchScenes(sceneText);
    if (!top.length) return '';
    const formatted = top.map((c, i) => '[Cena parecida ' + (i + 1) + ']\n' + c.text).join('\n\n');
    return '[REFERÊNCIA DO PASSADO — cena parecida com agora, pode ajudar a manter continuidade]\n' + formatted;
}

// ====================================
// MUNDO — relógio dia/hora avançando de verdade.
// ====================================
const MINUTOS_AUTO_POR_RODADA = 5;
const MUNDO_INICIAL = { dia: 1, hora: 9, minuto: 0 };
function getMundo() { return readBrain().mundo || Object.assign({}, MUNDO_INICIAL, { updatedAt: 0 }); }
function setMundo(dia, hora, minuto) {
    let totalMin = Math.round(hora * 60 + minuto);
    const diaExtra = Math.floor(totalMin / (24 * 60));
    totalMin = ((totalMin % (24 * 60)) + 24 * 60) % (24 * 60);
    const estado = {
        dia: Math.max(1, Math.round(dia) + diaExtra),
        hora: Math.floor(totalMin / 60),
        minuto: totalMin % 60,
        updatedAt: Date.now(),
    };
    return writeBrain({ mundo: estado }).mundo;
}
function avancarAutomatico() {
    const atual = getMundo();
    return setMundo(atual.dia, atual.hora, atual.minuto + MINUTOS_AUTO_POR_RODADA);
}
async function detectarSaltoNarrado(userMessage, atual) {
    const prompt = 'Estado atual do relógio da cena: Dia ' + atual.dia + ', ' + String(atual.hora).padStart(2, '0') + ':' + String(atual.minuto).padStart(2, '0') + '.\n\n' +
        'Mensagem do usuário:\n' + userMessage + '\n\n' +
        'Se essa mensagem NARRA explicitamente uma passagem de tempo (ex: "*volto às 13:46*", ' +
        '"*no dia seguinte, de manhã*", "*algumas horas depois*", "*saio e volto só à noite*"), calcule ' +
        'o novo horário ABSOLUTO resultante e responda EXATAMENTE no formato DIA:HORA:MINUTO ' +
        '(ex: 2:14:30 — só isso, sem texto extra, sem explicação). Se o salto for vago ("mais tarde", ' +
        '"depois de um tempo"), estime um avanço razoável (1 a 3 horas). Se a mensagem NÃO narra ' +
        'passagem de tempo — é só fala, ação ou gesto no presente, sem indicar salto — responda ' +
        'EXATAMENTE: SEM_SALTO';
    const resp = await generate(getConfig().modelFlash, [{ role: 'user', content: prompt }], { maxTokens: 300 });
    const trimmed = (resp || '').trim();
    const match = trimmed.match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
    if (!match) return null;
    const dia = Number(match[1]), hora = Number(match[2]), minuto = Number(match[3]);
    return setMundo(dia, hora, minuto);
}
async function avancarRelogio(userMessage) {
    try {
        const atual = getMundo();
        const salto = await detectarSaltoNarrado(userMessage, atual);
        return salto || avancarAutomatico();
    } catch (err) {
        console.error('[Spade][mundo] detecção de salto falhou, seguindo com avanço automático:', err.message);
        return avancarAutomatico();
    }
}
function formatMundo(estado) {
    estado = estado || getMundo();
    return 'Dia ' + estado.dia + ', ' + String(estado.hora).padStart(2, '0') + ':' + String(estado.minuto).padStart(2, '0');
}
function compiledMundoBlock(estado) {
    return '[RELÓGIO DO MUNDO] ' + formatMundo(estado);
}

// ====================================
// NPC (item 2) — regra: qualquer um que fala é criado, ganha
// importância, arquiva (não apaga) depois de 100 rodadas sem citar.
// ====================================
const PROMOCAO_MEDIA = 5, PROMOCAO_ALTA = 20, ARQUIVA_APOS = 100;
function normalizeNpcName(name) { return (name || '').trim().toLowerCase(); }
function getNpcs(filter) {
    filter = filter || {};
    const npcs = readBrain().npcs || [];
    if (filter.arquivado === undefined) return npcs;
    return npcs.filter((n) => n.arquivado === filter.arquivado);
}
function parseNameArray(text) {
    if (!text) return [];
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
        const arr = JSON.parse(match[0]);
        if (!Array.isArray(arr)) return [];
        return arr.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
    } catch (_) { return []; }
}
async function extractNpcMentions(sceneText, charName) {
    if (!sceneText || !sceneText.trim()) return [];
    const prompt = 'Cena:\n' + sceneText + '\n\n' +
        'Liste os nomes de personagens que aparecem falando ou sendo citados ' +
        'nessa cena, SEM incluir ' + charName + ' (ela é a protagonista, não conta). ' +
        'Responda só com um array JSON de strings, nada mais. Sem ninguém, responda [].';
    const resp = await generate(getConfig().modelFlash, [{ role: 'user', content: prompt }], { maxTokens: 500 });
    return parseNameArray(resp);
}
function tickNpcs(mentionedNames) {
    const npcs = readBrain().npcs || [];
    const mentionedSet = new Set((mentionedNames || []).map(normalizeNpcName));
    for (const rawName of mentionedNames || []) {
        const norm = normalizeNpcName(rawName);
        if (!norm) continue;
        let npc = npcs.find((n) => normalizeNpcName(n.name) === norm);
        if (!npc) {
            npc = { id: newId(), name: rawName.trim(), importancia: 'baixa', totalCitacoes: 0, mensagensSemCitar: 0, arquivado: false, criadoEm: new Date().toISOString(), ultimaCitacaoEm: null };
            npcs.push(npc);
        }
        npc.totalCitacoes++;
        npc.mensagensSemCitar = 0;
        npc.ultimaCitacaoEm = new Date().toISOString();
        npc.arquivado = false;
        if (npc.totalCitacoes >= PROMOCAO_ALTA) npc.importancia = 'alta';
        else if (npc.totalCitacoes >= PROMOCAO_MEDIA && npc.importancia === 'baixa') npc.importancia = 'media';
    }
    for (const npc of npcs) {
        if (mentionedSet.has(normalizeNpcName(npc.name))) continue;
        if (npc.arquivado) continue;
        npc.mensagensSemCitar++;
        if (npc.mensagensSemCitar >= ARQUIVA_APOS) npc.arquivado = true;
    }
    writeBrain({ npcs });
    return npcs;
}
async function updateNpcsForRound(userMessage, finalMessage, charName) {
    const sceneText = [userMessage, finalMessage].filter(Boolean).join('\n');
    if (!sceneText.trim()) return [];
    const mentioned = await extractNpcMentions(sceneText, charName);
    return tickNpcs(mentioned);
}
function setNpcImportancia(id, importancia) {
    if (['baixa', 'media', 'alta'].indexOf(importancia) === -1) throw new Error('importância inválida (use "baixa", "media" ou "alta")');
    const npcs = readBrain().npcs || [];
    const npc = npcs.find((n) => n.id === id);
    if (!npc) return null;
    npc.importancia = importancia;
    writeBrain({ npcs });
    return npc;
}
function setNpcArquivado(id, arquivado) {
    const npcs = readBrain().npcs || [];
    const npc = npcs.find((n) => n.id === id);
    if (!npc) return null;
    npc.arquivado = !!arquivado;
    if (!arquivado) npc.mensagensSemCitar = 0;
    writeBrain({ npcs });
    return npc;
}

// ====================================
// TAREFAS — aceitar/recusar/completar são FATO, não passam por IA.
// ====================================
function getTarefas(filter) {
    filter = filter || {};
    const list = readBrain().tarefas || [];
    return filter.status ? list.filter((t) => t.status === filter.status) : list;
}
function saveTarefas(list) { return writeBrain({ tarefas: list }).tarefas; }
function findTarefa(id) {
    const list = getTarefas();
    const tarefa = list.find((t) => t.id === id);
    if (!tarefa) throw new Error('Tarefa não encontrada: ' + id);
    return { list, tarefa };
}
function criarTarefa(opts) {
    opts = opts || {};
    if (!opts.descricao || !opts.descricao.trim()) throw new Error('Campo "descricao" é obrigatório.');
    const tarefa = {
        id: newId(), descricao: opts.descricao.trim(), criadoPor: opts.criadoPor || resolveCharacterName(),
        status: 'pendente', presenciadoPorHanna: opts.presenciadoPorHanna !== false,
        createdAt: Date.now(), resolvedAt: null,
    };
    const list = getTarefas().concat([tarefa]);
    saveTarefas(list);
    return tarefa;
}
function aceitarTarefa(id) {
    const { list, tarefa } = findTarefa(id);
    if (tarefa.status !== 'pendente') return tarefa;
    tarefa.status = 'aceita';
    saveTarefas(list);
    return tarefa;
}
function recusarTarefa(id) {
    const { list, tarefa } = findTarefa(id);
    if (tarefa.status !== 'pendente') return tarefa;
    tarefa.status = 'recusada';
    tarefa.resolvedAt = Date.now();
    saveTarefas(list);
    return tarefa;
}
function completarTarefa(id) {
    const { list, tarefa } = findTarefa(id);
    if (tarefa.status !== 'aceita') return tarefa;
    tarefa.status = 'completa';
    tarefa.resolvedAt = Date.now();
    saveTarefas(list);
    return tarefa;
}
function revelarTarefa(id) {
    const { list, tarefa } = findTarefa(id);
    tarefa.presenciadoPorHanna = true;
    saveTarefas(list);
    return tarefa;
}
async function detectarTarefaNaRodada(finalMessage, charName) {
    const prompt = 'Fala de ' + charName + ' que acabou de sair no RP:\n"' + finalMessage + '"\n\n' +
        'Essa fala oferece/propõe uma tarefa concreta pro usuário (pedido direto, convite pra fazer algo ' +
        'específico junto ou pra ele) — não uma menção vaga a estar ocupada ou ter afazeres? Se sim, responda ' +
        'só a descrição curta da tarefa (o que exatamente foi pedido/oferecido), sem mais nada. Se não, ' +
        'responda exatamente: NENHUMA';
    let resp;
    try { resp = await generate(getConfig().modelFlash, [{ role: 'user', content: prompt }], { maxTokens: 150 }); }
    catch (err) { console.warn('[Spade][tarefas] detecção falhou, seguindo sem criar tarefa:', err.message); return null; }
    const trimmed = (resp || '').trim();
    if (!trimmed || trimmed === 'NENHUMA') return null;
    return criarTarefa({ descricao: trimmed, criadoPor: charName, presenciadoPorHanna: true });
}
function compiledTarefasBlock(charName) {
    const pendentesOuAceitas = getTarefas().filter((t) => t.presenciadoPorHanna && (t.status === 'pendente' || t.status === 'aceita'));
    if (!pendentesOuAceitas.length) return '';
    const linhas = pendentesOuAceitas.map((t) => '- "' + t.descricao + '" (' + t.status + ')');
    return '[TAREFAS EM ABERTO que ' + charName + ' sabe que existem]\n' + linhas.join('\n');
}

// ====================================
// SALA DE PENSAMENTO — histórico das rodadas do pipeline em cantos.
// ====================================
const MAX_ROUNDS = 50;
function getThinkingRoomRounds() { return readBrain().thinkingRoom || []; }
function getRecentFinalMessages(n) {
    n = n || 6;
    return getThinkingRoomRounds().filter((r) => r.finalMessage).slice(-n).map((r) => r.finalMessage);
}
function getRecentSceneText(n) {
    n = n || 6;
    return getThinkingRoomRounds().slice(-n).flatMap((r) => [r.userMessage, r.finalMessage]).filter(Boolean).join('\n');
}
function startRound(userMessage, cantos) {
    return { id: newId(), timestamp: new Date().toISOString(), userMessage, cantos, finalMessage: '', aborted: false };
}
function saveThinkingRoomRound(round) {
    const rounds = getThinkingRoomRounds();
    rounds.push(round);
    while (rounds.length > MAX_ROUNDS) rounds.shift();
    writeBrain({ thinkingRoom: rounds });
    return round;
}

// ====================================
// TREINO (itens 8+9) — sintética + minerada, mesma fila de aprovação.
// ====================================
function getQueue() { return readBrain().treinoQueue || []; }
function pushToQueue(items) {
    const queue = getQueue().concat(items);
    writeBrain({ treinoQueue: queue });
    return items;
}
async function gerarFalasSinteticas(opts) {
    opts = opts || {};
    const { lines } = getFalas();
    if (!lines.length) throw new Error('Sem falas cadastradas ainda — nada pra aprender o estilo.');
    let alvo = opts.categoria || null;
    if (!alvo) {
        const contagem = {};
        lines.forEach((f) => { if (f.category) contagem[f.category] = (contagem[f.category] || 0) + 1; });
        const categorias = Object.keys(contagem);
        alvo = categorias.length ? categorias.reduce((a, b) => (contagem[a] <= contagem[b] ? a : b)) : null;
    }
    const referencia = lines.filter((f) => f.polaridade === 'boa' && (!alvo || f.category === alvo));
    const base = (referencia.length ? referencia : lines.filter((f) => f.polaridade === 'boa')).map((f) => '- ' + f.text).join('\n');
    const prompt = 'Falas reais da ' + resolveCharacterName() + (alvo ? ' (categoria "' + alvo + '")' : '') + ', pra você estudar o estilo:\n' + base + '\n\n' +
        'Escreva ' + (opts.quantidade || 3) + ' falas NOVAS que nunca existiram, no mesmo estilo — mesmo tom, ritmo, ' +
        'nível de contenção emocional. Não repita nem reescreva as de cima, crie situações diferentes ' +
        'que ela diria. Uma fala por linha, sem numeração, sem aspas, sem comentário.';
    const resp = await generate(getConfig().modelWriter, [{ role: 'user', content: prompt }], { maxTokens: 500 });
    const novas = (resp || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!novas.length) throw new Error('Modelo não devolveu nenhuma fala — tenta de novo.');
    const items = novas.map((text) => ({ id: newId(), text, category: alvo, polaridade: 'boa', origem: 'sintetica', status: 'pendente', createdAt: Date.now() }));
    return pushToQueue(items);
}
async function minerarFalasDoRP(opts) {
    opts = opts || {};
    const rounds = getThinkingRoomRounds().filter((r) => r.finalMessage).slice(-(opts.quantidade || 30));
    if (!rounds.length) throw new Error('Sem rodadas de RP registradas ainda pra minerar.');
    const transcript = rounds.map((r) => '- ' + r.finalMessage.replace(/\n+/g, ' ')).join('\n');
    const prompt = 'Falas da ' + resolveCharacterName() + ' em cenas reais de RP:\n' + transcript + '\n\n' +
        'Escolha até 5 dessas falas que soam MAIS autenticamente "ela" — marcantes, no tom certo, ' +
        'que valeriam virar exemplo permanente de voz. Copie o texto EXATO da fala escolhida, uma por ' +
        'linha, sem numeração, sem comentário. Se nenhuma se destacar o suficiente, responda: NENHUMA';
    const resp = await generate(getConfig().modelFlash, [{ role: 'user', content: prompt }], { maxTokens: 600 });
    const trimmed = (resp || '').trim();
    if (!trimmed || trimmed === 'NENHUMA') return [];
    const escolhidas = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
    const items = escolhidas.map((text) => ({ id: newId(), text, category: null, polaridade: 'boa', origem: 'minerada', status: 'pendente', createdAt: Date.now() }));
    return pushToQueue(items);
}
function resolverItem(id, decisao) {
    const queue = getQueue();
    const item = queue.find((i) => i.id === id);
    if (!item) return null;
    if (item.status !== 'pendente') return item;
    item.status = decisao === 'aprovada' ? 'aprovada' : 'rejeitada';
    item.resolvedAt = Date.now();
    writeBrain({ treinoQueue: queue });
    if (decisao === 'aprovada') {
        addFala({ text: item.text, category: item.category, polaridade: item.polaridade, origem: item.origem === 'sintetica' ? 'ia' : 'usuario' });
    }
    return item;
}

// ====================================
// PIPELINE EM CANTOS — Perfil, Falas, Cenas, Repetição, Estado, Mundo,
// todos em paralelo, ANTES da fala de verdade.
// ====================================
function fromSettled(result, label, fallbackValue) {
    if (result.status === 'fulfilled') return { value: result.value, ok: true };
    console.error('[Spade][pipeline] canto ' + label + ' falhou, seguindo com fallback:', result.reason?.message);
    return { value: fallbackValue, ok: false };
}
async function runCantos(userMessage, charName) {
    const sceneText = [getRecentSceneText(6), userMessage].filter(Boolean).join('\n');

    const [perfilResult, falasResult, repeticaoResult, estadoResult, cenasResult, mundoResult] = await Promise.allSettled([
        summarizeProfileForScene(userMessage, charName),
        compiledFalasBlock(sceneText),
        Promise.resolve(compiledRepeticaoBlock(getRecentFinalMessages(6))),
        evaluateInnerState(userMessage, charName).then(() => compiledInnerStateBlock()),
        compiledScenesBlock(sceneText),
        avancarRelogio(userMessage),
    ]);

    const cantos = {};

    const perfil = fromSettled(perfilResult, 'perfil', null);
    const resumoUtilizavel = perfil.ok && perfil.value && perfil.value.trim();
    if (perfil.ok && !resumoUtilizavel) {
        console.warn('[Spade][pipeline] canto perfil voltou vazio (sem erro) — usando bloco cru como fallback.');
    }
    cantos.perfil = resumoUtilizavel
        ? { resumo: perfil.value, block: compiledPerfilCantoBlock(perfil.value, charName), ok: true }
        : { resumo: null, block: compiledProfileBlock(charName), ok: false };

    const falas = fromSettled(falasResult, 'falas', '');
    cantos.falas = { block: falas.value, ok: falas.ok };

    const repeticao = fromSettled(repeticaoResult, 'repetição', '');
    cantos.repeticao = { block: repeticao.value, ok: repeticao.ok };

    const estado = fromSettled(estadoResult, 'estado', '');
    cantos.estado = { block: estado.value, ok: estado.ok };

    const cenas = fromSettled(cenasResult, 'cenas', '');
    cantos.cenas = { block: cenas.value, ok: cenas.ok };

    const mundo = fromSettled(mundoResult, 'mundo', getMundo());
    cantos.mundo = { estado: mundo.value, block: compiledMundoBlock(mundo.value), ok: mundo.ok };

    return cantos;
}
function buildSystemPrompt(cantos, charName) {
    const parts = [
        cantos.perfil?.block || '(Perfil ainda vazio — configure em ⚙ Config › 👤 Perfil)',
        cantos.falas?.block,
        cantos.cenas?.block,
        cantos.repeticao?.block,
        cantos.estado?.block,
        cantos.mundo?.block,
        compiledTarefasBlock(charName),
        compiledAgentNoteBlock(),
        'Você é a ' + charName + '. Responda curto, direto, em pt-br, coerente com o que veio acima.',
    ];
    return parts.filter(Boolean).join('\n\n');
}

// ====================================
// SALA DE PENSAMENTO DE VERDADE (agente) — function calling real, a IA
// decide sozinha, com ferramentas que mudam a extensão de fato.
// ====================================
function getAgentNote() { return readBrain().agentNote || { text: '', updatedAt: 0 }; }
function setAgentNote(text) { return writeBrain({ agentNote: { text, updatedAt: Date.now() } }).agentNote; }
function compiledAgentNoteBlock() {
    const { text } = getAgentNote();
    if (!text) return '';
    return '[AJUSTE QUE VOCÊ MESMA DECIDIU — prioridade alta, aplique já]\n' + text;
}

const TOOLS = [
    { type: 'function', function: { name: 'ajustar_estado_interno', description: 'Reescreve seu próprio estado interno atual (o que sente por dentro, o que mostra por fora, o motivo). Use quando, pensando sozinha, perceber que o estado registrado não reflete mais a realidade.', parameters: { type: 'object', properties: { texto: { type: 'string', description: 'Novo estado interno completo, substituindo o atual.' } }, required: ['texto'] } } },
    { type: 'function', function: { name: 'ajustar_rp_agora', description: 'Deixa uma nota de ajuste (ritmo, tom, o que evitar) pro seu PRÓPRIO próximo turno no RP — igual um Directive, só que decidido por você mesma, não pelo usuário. Some com o Directive do usuário, não substitui.', parameters: { type: 'object', properties: { instrucao: { type: 'string', description: 'Ajuste curto e concreto.' } }, required: ['instrucao'] } } },
    { type: 'function', function: { name: 'buscar_cena_parecida', description: 'Busca no histórico de RP já indexado por cenas parecidas com uma descrição — útil pra checar continuidade antes de decidir algo.', parameters: { type: 'object', properties: { descricao: { type: 'string' } }, required: ['descricao'] } } },
    { type: 'function', function: { name: 'ver_biblioteca_de_voz', description: 'Lista quantas falas existem, por categoria, e quais categorias têm pouco exemplo — pra decidir se vale gerar/minerar mais.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'gerar_falas_sinteticas', description: 'Autoaprimoramento: pede pra escrever falas novas no seu próprio estilo, mirando uma categoria com pouco exemplo. Cai numa fila de aprovação do usuário — não entra direto na biblioteca (proposital, evita degradar a própria voz sozinha).', parameters: { type: 'object', properties: { categoria: { type: 'string', description: 'Categoria alvo. Se omitido, escolhe a com menos exemplo sozinha.' }, quantidade: { type: 'number', description: 'Quantas falas gerar (padrão 3).' } } } } },
    { type: 'function', function: { name: 'minerar_falas_do_rp', description: 'Autoaprimoramento: revisa cenas reais de RP recentes e sugere falas suas que soaram autenticamente você, pra virarem exemplo permanente. Também cai na fila de aprovação.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'ver_elenco', description: 'Lista os NPCs conhecidos (nome, importância, se está arquivado).', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'ajustar_npc', description: 'Muda a importância de um NPC ou arquiva/reativa ele — julgamento seu sobre quem ainda importa na história.', parameters: { type: 'object', properties: { id: { type: 'string' }, importancia: { type: 'string', enum: ['baixa', 'media', 'alta'] }, arquivado: { type: 'boolean' } }, required: ['id'] } } },
    { type: 'function', function: { name: 'ver_tarefas', description: 'Lista as tarefas existentes (pendentes, aceitas, recusadas, completas) — use antes de oferecer uma nova, pra não repetir algo já em aberto.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'oferecer_tarefa', description: 'Cria uma tarefa nova pro usuário — pedido ou convite concreto. Fica pendente até ele aceitar/recusar (fato registrado, não interpretação de texto).', parameters: { type: 'object', properties: { descricao: { type: 'string', description: 'O que exatamente está sendo pedido/oferecido.' } }, required: ['descricao'] } } },
    { type: 'function', function: { name: 'postar_na_rp', description: 'Posta uma fala sua nova no RP por iniciativa própria, fora do fluxo normal de resposta — como se você tivesse decidido falar sem ter sido chamada.', parameters: { type: 'object', properties: { texto: { type: 'string', description: 'O texto da fala a ser postada.' } }, required: ['texto'] } } },
    { type: 'function', function: { name: 'editar_ultima_fala_rp', description: 'Ajusta pontualmente sua última fala já postada no RP (corrige/afina algo específico, mantém o resto do espírito da fala). Pra trocar a fala inteira do zero, use reescrever_ultima_fala_rp.', parameters: { type: 'object', properties: { texto: { type: 'string', description: 'Novo texto completo da última fala, já com o ajuste aplicado.' } }, required: ['texto'] } } },
    { type: 'function', function: { name: 'apagar_ultima_fala_rp', description: 'Apaga sua última fala do RP — usa quando ela não devia ter sido dita e não dá pra consertar editando.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'reescrever_ultima_fala_rp', description: 'Substitui sua última fala do RP inteira, do zero — troca completa, não ajuste pontual (pra isso, editar_ultima_fala_rp).', parameters: { type: 'object', properties: { texto: { type: 'string', description: 'Texto novo que substitui a fala inteira.' } }, required: ['texto'] } } },
];

// Execução de verdade de cada tool. As 4 de RP (postar/editar/apagar/
// reescrever) só devolvem um "pedido" estruturado — quem de fato aplica
// no DOM/chat é forwardRpActions, chamado depois do loop terminar (ver
// seção FORWARD RP ACTIONS mais abaixo). Isso não muda em relação ao
// backend: lá era porque o processo Node não tinha acesso ao chat do
// ST; aqui é só pra manter "decidir" e "executar" separados, mesmo
// rodando tudo no mesmo processo agora.
async function executeTool(name, args) {
    switch (name) {
        case 'ajustar_estado_interno': return applyInnerState(args.texto);
        case 'ajustar_rp_agora': return setAgentNote(args.instrucao);
        case 'buscar_cena_parecida': {
            const cenas = await searchScenes(args.descricao, 3);
            return cenas.map((c) => ({ texto: c.text, similaridade: Number(c.score.toFixed(2)) }));
        }
        case 'ver_biblioteca_de_voz': {
            const { lines } = getFalas();
            const porCategoria = {};
            lines.forEach((f) => { const c = f.category || '(sem categoria)'; porCategoria[c] = (porCategoria[c] || 0) + 1; });
            return { total: lines.length, porCategoria };
        }
        case 'gerar_falas_sinteticas': return gerarFalasSinteticas({ categoria: args.categoria || null, quantidade: args.quantidade || 3 });
        case 'minerar_falas_do_rp': return minerarFalasDoRP({});
        case 'ver_elenco': return getNpcs().map((n) => ({ id: n.id, nome: n.name, importancia: n.importancia, arquivado: n.arquivado }));
        case 'ajustar_npc': {
            let npc = null;
            if (args.importancia) npc = setNpcImportancia(args.id, args.importancia);
            if (args.arquivado !== undefined) npc = setNpcArquivado(args.id, args.arquivado);
            return npc;
        }
        case 'ver_tarefas': return getTarefas();
        case 'oferecer_tarefa': return criarTarefa({ descricao: args.descricao, criadoPor: resolveCharacterName(), presenciadoPorHanna: true });
        case 'postar_na_rp': case 'editar_ultima_fala_rp': case 'apagar_ultima_fala_rp': case 'reescrever_ultima_fala_rp':
            return { pedido: true, texto: args.texto ?? null };
        default:
            throw new Error('tool desconhecida: ' + name);
    }
}

const MAX_LOG = 20;
function getAgentLog() { return readBrain().agentLog || []; }
function pushAgentLog(session) {
    const log = [session].concat(getAgentLog()).slice(0, MAX_LOG);
    writeBrain({ agentLog: log });
}
function buildContextSnapshot(charName) {
    const profile = getProfile();
    const inner = getInnerState();
    const { lines } = getFalas();
    const npcs = getNpcs();
    const recentScenes = getRecentFinalMessages(3);
    return [
        'Perfil (resumo): ' + (profile.text || '(vazio)').slice(0, 300),
        'Estado interno atual: ' + (inner.text || '(nenhum)'),
        'Biblioteca de voz: ' + lines.length + ' falas cadastradas.',
        'NPCs conhecidos: ' + npcs.length + ' (' + npcs.filter((n) => !n.arquivado).length + ' ativos).',
        'Últimas falas suas no RP:\n' + (recentScenes.map((s) => '- ' + s).join('\n') || '(nenhuma ainda)'),
    ].join('\n\n');
}
const MAX_ITERACOES_AGENT = 6;
async function runAgentSession(gatilho) {
    gatilho = gatilho || 'manual';
    const charName = resolveCharacterName();
    const systemPrompt =
        'Você é ' + charName + ', pensando sozinha, num espaço privado que só você acessa — ninguém mais vê isso ' +
        'acontecendo. Você tem ferramentas de verdade que mudam a extensão de verdade, não é só imaginação. ' +
        'Use o que fizer sentido, na ordem que fizer sentido; pode não usar nenhuma se não tiver o que fazer ' +
        'agora. Quando terminar de agir, escreva uma reflexão curta (2-4 frases) resumindo o que decidiu e por quê.\n\n' +
        'Seu contexto atual:\n' + buildContextSnapshot(charName) + '\n\n' +
        'Motivo dessa sessão: ' + gatilho;

    const messages = [{ role: 'system', content: systemPrompt }];
    const acoes = [];
    let reflexaoFinal = '';
    let erro = null;

    try {
        for (let i = 0; i < MAX_ITERACOES_AGENT; i++) {
            const resp = await generateWithTools(getConfig().modelWriter, messages, TOOLS, { maxTokens: 800 });
            if (!resp.toolCalls || !resp.toolCalls.length) { reflexaoFinal = resp.content || ''; break; }

            messages.push({ role: 'assistant', content: resp.content || null, tool_calls: resp.toolCalls });

            for (const call of resp.toolCalls) {
                const nome = call.function?.name;
                let args = {};
                try { args = JSON.parse(call.function?.arguments || '{}'); } catch (_) {}
                let resultado, erroTool = null;
                try { resultado = await executeTool(nome, args); } catch (e) { erroTool = e.message; }
                acoes.push({ tool: nome, args, resultado, erro: erroTool, ts: Date.now() });
                messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(erroTool ? { erro: erroTool } : (resultado ?? {})) });
            }
            if (i === MAX_ITERACOES_AGENT - 1) reflexaoFinal = '(parou por atingir o limite de passos — evita loop sem fim)';
        }
    } catch (e) { erro = e.message; }

    const session = { id: newId(), gatilho, acoes, reflexaoFinal, erro, ts: Date.now() };
    pushAgentLog(session);
    return session;
}

// ====================================
// ESPAÇO — conversa COM o Spade (não com a personagem), reaproveitando
// as mesmas TOOLS/executeTool da Sala de Pensamento. Diferença real:
// aqui é o USUÁRIO perguntando/pedindo, histórico persiste entre
// mensagens (conversa, não sessão isolada).
// ====================================
const MAX_ITERACOES_ESPACO = 6;
const MAX_HISTORICO_ESPACO = 40;
function getEspacoHistory() { return readBrain().espacoHistory || []; }
function saveEspacoHistory(history) {
    const trimmed = history.slice(-MAX_HISTORICO_ESPACO);
    writeBrain({ espacoHistory: trimmed });
    return trimmed;
}
function limparEspaco() { return saveEspacoHistory([]); }
function buildEspacoSystemPrompt() {
    const charName = resolveCharacterName();
    const cena = getRecentSceneText(6);
    return 'Você é o Spade — o assistente que ajuda a organizar e ajustar a extensão de RP, conversando ' +
        'diretamente com o usuário. Você NÃO é a ' + charName + ' (a personagem do RP) — nunca fale na voz dela, nunca ' +
        'narre a cena. Você é você mesmo: direto, útil, sem rodeio.\n\n' +
        'Você tem ferramentas de verdade que mudam a extensão de fato (ajustar estado interno da personagem, ' +
        'buscar cena parecida, gerar/minerar fala nova, ver e ajustar NPC, ver e oferecer tarefa). ' +
        'Use quando o usuário pedir algo que uma ferramenta resolve — não precisa perguntar permissão antes de ' +
        'usar, só não invente uso sem necessidade.\n\n' +
        'Cena recente do RP, pra ter contexto do que está acontecendo:\n' + (cena || '(nada ainda)');
}
async function respondEspaco(userMessage) {
    const history = getEspacoHistory();
    const messages = [{ role: 'system', content: buildEspacoSystemPrompt() }].concat(history, [{ role: 'user', content: userMessage }]);

    const acoes = [];
    let respostaFinal = '';
    let erro = null;

    try {
        for (let i = 0; i < MAX_ITERACOES_ESPACO; i++) {
            const resp = await generateWithTools(getConfig().modelWriter, messages, TOOLS, { maxTokens: 800 });
            if (!resp.toolCalls || !resp.toolCalls.length) { respostaFinal = resp.content || ''; break; }

            messages.push({ role: 'assistant', content: resp.content || null, tool_calls: resp.toolCalls });

            for (const call of resp.toolCalls) {
                const nome = call.function?.name;
                let args = {};
                try { args = JSON.parse(call.function?.arguments || '{}'); } catch (_) {}
                let resultado, erroTool = null;
                try { resultado = await executeTool(nome, args); } catch (e) { erroTool = e.message; }
                acoes.push({ tool: nome, args, resultado, erro: erroTool });
                messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(erroTool ? { erro: erroTool } : (resultado ?? {})) });
            }
            if (i === MAX_ITERACOES_ESPACO - 1) respostaFinal = '(parei de usar ferramenta pra não entrar em loop — me pergunta de novo se precisar continuar)';
        }
    } catch (e) {
        erro = e.message;
        respostaFinal = '';
    }

    if (!erro) saveEspacoHistory(history.concat([{ role: 'user', content: userMessage }, { role: 'assistant', content: respostaFinal }]));
    return { resposta: respostaFinal, acoes, erro };
}

// ====================================
// RODADA DE RP — equivalente local ao que era o handler `chat:send` do
// WebSocket em server.js. Roda o pipeline em cantos, depois a fala de
// verdade (streaming), depois NPC/cena/tarefa em segundo plano.
//
// Tudo dentro de UM try/catch que cobre a rodada inteira — lição de uma
// versão anterior (WS): quando runCantos ficava FORA do try/catch, uma
// exceção ali morria silenciosa (nenhum erro visível, nenhuma rodada
// salva). Sem isso, um bug de rede também deixava a Sala de Pensamento
// sem nada pra mostrar mesmo com mensagens de RP sendo mandadas de
// verdade — parecia "não enxergo nada do RP" sem pista nenhuma do motivo.
// ====================================
let rpController = null; // só aborta quando uma NOVA rodada de RP começa — trocar de superfície (ir pro Espaço) não aborta, só para de atualizar a tela (ver postCharacterMessageStreaming)

async function runRpTurn(userMessage, history, onToken) {
    if (rpController) rpController.abort();
    const myController = new AbortController();
    rpController = myController;

    const charName = resolveCharacterName();
    let round = null;
    try {
        const cantos = await runCantos(userMessage, charName);
        const systemPrompt = buildSystemPrompt(cantos, charName);
        round = startRound(userMessage, cantos);

        const messages = [{ role: 'system', content: systemPrompt }]
            .concat(Array.isArray(history) ? history : [])
            .concat([{ role: 'user', content: userMessage }]);

        const full = await generateStream(getConfig().modelWriter, messages, onToken, { signal: myController.signal });
        round.finalMessage = full;
        return { ok: true, text: full };
    } catch (err) {
        if (round) round.aborted = true;
        console.error('[Spade] erro na rodada de RP:', err);
        return { ok: false, error: err.message || String(err) };
    } finally {
        if (round) saveThinkingRoomRound(round);
        if (rpController === myController) rpController = null;

        if (round && round.finalMessage) {
            updateNpcsForRound(userMessage, round.finalMessage, charName).catch((e) => console.error('[Spade][npc]', e.message));
            indexScene(userMessage, round.finalMessage).catch((e) => console.error('[Spade][cenas]', e.message));
            detectarTarefaNaRodada(round.finalMessage, charName).catch((e) => console.error('[Spade][tarefas]', e.message));
        }
    }
}

// ====================================
// MENSAGENS DO PERSONAGEM NO RP — família "boca", inalterada na forma.
// ====================================
function forceMessageName(idx, charName, avatarUrl) {
    const mesEl = document.querySelector('.mes[mesid="' + idx + '"]');
    if (!mesEl) return;
    const nameEl = mesEl.querySelector('.name_text') || mesEl.querySelector('.ch_name .name_text') || mesEl.querySelector('[data-name]');
    if (nameEl) nameEl.textContent = charName;
    if (avatarUrl) {
        const avatarImg = mesEl.querySelector('.avatar img') || mesEl.querySelector('img.avatar');
        if (avatarImg) avatarImg.src = avatarUrl;
    }
}
function reinforceMessageName(idx, charName, avatarUrl) {
    let tries = 0;
    const iv = setInterval(() => {
        tries++;
        forceMessageName(idx, charName, avatarUrl);
        if (tries >= 10) clearInterval(iv);
    }, 150);
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
    saveScope();
    if (typeof ctx().saveChat === 'function') ctx().saveChat();
    else if (typeof ctx().saveChatConditional === 'function') ctx().saveChatConditional();
}

// Post de UMA VEZ SÓ (texto já pronto) — usado quando o Espaço/Sala de
// Pensamento decide postar por iniciativa própria (ver forwardRpActions).
async function postCharacterMessage(text, token) {
    const charName = resolveCharacterName();
    const avatarUrl = resolveCharacterAvatar();
    showStatusPill(charName + ' está digitando...');

    const created = createEmptyCharMessage(charName, avatarUrl);
    if (!created) return { ok: false, reason: 'API do ST indisponível (addOneMessage/chat).' };
    const { message, idx } = created;

    const reveal = await revealTextRealtime(text, idx, message, charName, token);
    message.mes = reveal.shownText;
    finalizeCharMessage(idx);

    if (reveal.abandoned) return { ok: true, abandoned: true };
    return { ok: true, interrupted: !reveal.completed };
}

// Revelação progressiva FAKE (texto já pronto, sem token real) — usada
// só por postCharacterMessage acima (ações de fora do fluxo principal).
async function revealTextRealtime(fullText, idx, message, charName, token) {
    const tokens = fullText.split(/(\s+)/).filter((t) => t.length);
    const totalBudgetMs = Math.min(7000, Math.max(600, fullText.length * 14));
    const perTokenMs = Math.max(16, totalBudgetMs / Math.max(1, tokens.length));
    const getMesEl = () => document.querySelector('.mes[mesid="' + idx + '"] .mes_text');
    let shown = '';
    let abandoned = false;
    for (let i = 0; i < tokens.length; i++) {
        if (isStale(token)) { abandoned = true; break; }
        shown += tokens[i];
        message.mes = shown;
        const el = getMesEl();
        if (el) {
            const formatted = typeof ctx().messageFormatting === 'function' ? ctx().messageFormatting(shown, charName, false, false, idx) : esc(shown);
            el.innerHTML = formatted + '<span class="axis-typing-cursor">▌</span>';
        }
        await new Promise((r) => setTimeout(r, perTokenMs + Math.random() * perTokenMs * 0.4));
    }
    const el = getMesEl();
    if (el && !abandoned) {
        const formatted = typeof ctx().messageFormatting === 'function' ? ctx().messageFormatting(shown, charName, false, false, idx) : esc(shown);
        el.innerHTML = formatted;
    }
    return { shownText: shown, abandoned, completed: !abandoned };
}

// Streaming DE VERDADE — token vindo direto de generateStream (via
// runRpTurn), sem WS no meio. É o fluxo principal do RP.
async function postCharacterMessageStreaming(recentText, history, token) {
    const charName = resolveCharacterName();
    const avatarUrl = resolveCharacterAvatar();
    showStatusPill(charName + ' está digitando...');
    dotsWriting();

    const created = createEmptyCharMessage(charName, avatarUrl);
    if (!created) { dotsIdle(); return { ok: false, reason: 'API do ST indisponível.' }; }
    const { message, idx } = created;
    const getMesEl = () => document.querySelector('.mes[mesid="' + idx + '"] .mes_text');

    let shown = '';
    function onToken(delta) {
        // Fica stale se o usuário já foi pra outra superfície (Espaço) —
        // aqui só para de atualizar a TELA; a geração em si (runRpTurn)
        // continua até o fim mesmo assim, porque NPC/cena/Sala de
        // Pensamento precisam da rodada completa independente do que
        // o usuário está olhando agora.
        if (isStale(token)) return;
        shown += delta;
        message.mes = shown;
        const el = getMesEl();
        if (el) {
            const formatted = typeof ctx().messageFormatting === 'function' ? ctx().messageFormatting(shown, charName, false, false, idx) : esc(shown);
            el.innerHTML = formatted + '<span class="axis-typing-cursor">▌</span>';
        }
    }

    const result = await runRpTurn(recentText, history, onToken);
    const abandoned = isStale(token);

    if (!abandoned) {
        const el = getMesEl();
        if (el) {
            const formatted = typeof ctx().messageFormatting === 'function' ? ctx().messageFormatting(shown, charName, false, false, idx) : esc(shown);
            el.innerHTML = formatted;
        }
        message.mes = shown;
    }

    if (!result.ok && !shown) {
        if (!abandoned) {
            // Erro logo de cara, nada gerado — antes de mais nada, deixa
            // uma nota VISÍVEL no chat em vez de sumir com a bolha sem
            // rastro nenhum (sem isso, um erro e "não mandei mensagem
            // nenhuma ainda" pareciam exatamente a mesma coisa: silêncio
            // total). Não chama finalizeCharMessage — isso é só uma nota
            // de erro, não uma fala de verdade que editar/apagar devam
            // poder tocar depois.
            const errorText = '⚠️ *(Spade não respondeu — ' + result.error + ')*';
            message.mes = errorText;
            const el = getMesEl();
            if (el) {
                el.innerHTML = typeof ctx().messageFormatting === 'function' ? ctx().messageFormatting(errorText, charName, false, false, idx) : esc(errorText);
            }
            if (typeof ctx().saveChat === 'function') ctx().saveChat();
            dotsError();
        }
        return { ok: false, reason: result.error };
    }

    if (!abandoned) {
        finalizeCharMessage(idx);
        dotsIdle();
    }
    return { ok: true, abandoned, interrupted: !result.ok };
}

function editLastCharacterMessage(newText) {
    const s = scope();
    const idx = s.lastCharMessageIdx;
    if (idx == null || !ctx().chat[idx]) return { ok: false, reason: 'Não tenho uma mensagem recente pra editar.' };
    ctx().chat[idx].mes = newText;
    const el = document.querySelector('.mes[mesid="' + idx + '"] .mes_text');
    if (el) {
        el.innerHTML = typeof ctx().messageFormatting === 'function' ? ctx().messageFormatting(newText, ctx().chat[idx].name, false, false, idx) : esc(newText);
    }
    if (typeof ctx().saveChat === 'function') ctx().saveChat();
    return { ok: true };
}
function deleteLastCharacterMessage() {
    const s = scope();
    const idx = s.lastCharMessageIdx;
    if (idx == null || !ctx().chat[idx]) return { ok: false, reason: 'Não tenho uma mensagem recente pra apagar.' };
    ctx().chat.splice(idx, 1);
    if (typeof ctx().reloadCurrentChat === 'function') ctx().reloadCurrentChat();
    else {
        const el = document.querySelector('.mes[mesid="' + idx + '"]');
        if (el) el.remove();
    }
    s.lastCharMessageIdx = null;
    saveScope();
    if (typeof ctx().saveChat === 'function') ctx().saveChat();
    return { ok: true };
}

function recentRpHistory(maxMessages, maxCharsPerMsg) {
    maxMessages = maxMessages || 24; maxCharsPerMsg = maxCharsPerMsg || 800;
    const chatArr = ctx().chat;
    if (!Array.isArray(chatArr) || !chatArr.length) return [];
    return chatArr.slice(-maxMessages).map((m) => {
        let txt = (m.mes || '').trim();
        if (txt.length > maxCharsPerMsg) txt = txt.slice(0, maxCharsPerMsg) + '…';
        return { role: m.is_user ? 'user' : 'assistant', content: txt };
    }).filter((m) => m.content);
}

// ====================================
// FORWARD RP ACTIONS — traduz `acoes` (devolvido por respondEspaco/
// runAgentSession) em ação de verdade no chat. Equivalente local ao que
// era forwardRpActions+evento WS rp:* em server.js.
// ====================================
const RP_ACTION_MAP = {
    postar_na_rp: 'post',
    editar_ultima_fala_rp: 'edit',
    apagar_ultima_fala_rp: 'delete',
    reescrever_ultima_fala_rp: 'rewrite',
};
async function forwardRpActions(acoes) {
    for (const acao of acoes || []) {
        const kind = RP_ACTION_MAP[acao.tool];
        if (!kind || acao.erro) continue;
        try {
            if (kind === 'post') await postCharacterMessage(acao.args?.texto ?? '', claimSurface('rp'));
            else if (kind === 'edit' || kind === 'rewrite') editLastCharacterMessage(acao.args?.texto ?? '');
            else if (kind === 'delete') deleteLastCharacterMessage();
        } catch (e) { reportFatalError(e); }
    }
}

// ====================================
// ESPAÇO — UI de chat (visual inalterado).
// ====================================
let espacoLocalLog = [];
function renderMarkers(text) { return esc(text).replace(/\n/g, '<br>'); }
function renderEspacoChat() {
    const chatEl = document.getElementById('axis-espaco-chat');
    if (!chatEl) return;
    chatEl.innerHTML = espacoLocalLog.map((m) =>
        '<div class="axis-msg axis-msg-' + (m.role === 'user' ? 'user' : 'agent') + '">' + renderMarkers(m.content) + '</div>'
    ).join('');
    chatEl.scrollTop = chatEl.scrollHeight;
}
function loadEspacoHistoryLocal() {
    const hist = getEspacoHistory();
    espacoLocalLog = (Array.isArray(hist) ? hist : []).map((m) => ({ role: m.role, content: m.content, ts: Date.now() }));
    renderEspacoChat();
}
async function sendEspacoMessage(text) {
    const token = claimSurface('espaco');
    espacoLocalLog.push({ role: 'user', content: text, ts: Date.now() });
    renderEspacoChat();
    dotsThinking();

    let resultado;
    try {
        resultado = await respondEspaco(text);
    } catch (e) {
        if (!isStale(token)) {
            espacoLocalLog.push({ role: 'agent', content: '⚠️ Erro: ' + e.message, ts: Date.now() });
            renderEspacoChat();
            dotsError();
        }
        return;
    }
    if (isStale(token)) return;

    await forwardRpActions(resultado.acoes);

    const acoesFeitas = (resultado.acoes || []).filter((a) => !a.erro).length;
    let display = resultado.erro ? '⚠️ ' + resultado.erro : (resultado.resposta || '(sem resposta)');
    if (acoesFeitas > 0) display += '\n\n_' + acoesFeitas + ' ação' + (acoesFeitas > 1 ? 'ões' : '') + ' tomada' + (acoesFeitas > 1 ? 's' : '') + '._';

    espacoLocalLog.push({ role: 'agent', content: display, ts: Date.now() });
    renderEspacoChat();
    dotsIdle();
}

// ====================================
// PAINEL — CONFIG (substitui as janelas do site Lovable: Perfil, Falas,
// Elenco, Tarefas, Treino, Sala de Pensamento, + Chave/modelos).
// ====================================
let panelMode = 'espaco'; // 'espaco' | 'config'
let configTab = 'chave';  // 'chave'|'perfil'|'falas'|'elenco'|'tarefas'|'treino'|'sala'
const CONFIG_TABS = [
    ['chave', '🔑 Chave'],
    ['perfil', '👤 Perfil'],
    ['falas', '🗣️ Falas'],
    ['elenco', '🎭 Elenco'],
    ['tarefas', '✅ Tarefas'],
    ['treino', '🎓 Treino'],
    ['sala', '🧠 Sala'],
];

function showConfigStatus(text) {
    const el = document.getElementById('axis-config-status');
    if (!el) return;
    el.textContent = text;
    clearTimeout(showConfigStatus._t);
    showConfigStatus._t = setTimeout(() => { if (el) el.textContent = ''; }, 5000);
}

function renderConfigChave() {
    const cfg = getConfig();
    return (
        '<div class="axis-config-section">' +
        '<label>Chave da API (NanoGPT)</label>' +
        '<input type="password" id="cfg-apikey" value="' + escAttr(cfg.apiKey) + '" placeholder="sk-..." />' +
        '<label>Modelo — Escritor (fala de verdade, Pro)</label>' +
        '<input type="text" id="cfg-writer" value="' + escAttr(cfg.modelWriter) + '" />' +
        '<label>Modelo — Auxiliar (Flash, tarefas mecânicas)</label>' +
        '<input type="text" id="cfg-flash" value="' + escAttr(cfg.modelFlash) + '" />' +
        '<label>Modelo — Embedding (busca de cena)</label>' +
        '<input type="text" id="cfg-embed" value="' + escAttr(cfg.modelEmbed) + '" />' +
        '<div class="axis-config-row"><button type="button" class="axis-btn axis-btn-send" data-action="save-config">Salvar</button></div>' +
        '<div class="axis-config-hint">Fica salva em localStorage deste navegador (não sai daqui), mas fica visível pra quem abrir o DevTools nesse mesmo navegador — mesmo modelo de risco que a versão de antes do backend já tinha.</div>' +
        '</div>'
    );
}
function renderConfigPerfil() {
    const { text } = getProfile();
    return (
        '<div class="axis-config-section">' +
        '<div class="axis-config-hint">Separe seções com uma linha "---" (3+ traços) — cada uma vira um bloco próprio no prompt.</div>' +
        '<textarea id="cfg-perfil-text" rows="10">' + esc(text) + '</textarea>' +
        '<div class="axis-config-row"><button type="button" class="axis-btn axis-btn-send" data-action="save-perfil">Salvar Perfil</button></div>' +
        '</div>'
    );
}
function renderConfigFalas() {
    const { lines } = getFalas();
    const raw = lines.map(serializeFalaLine).join('\n');
    return (
        '<div class="axis-config-section">' +
        '<div class="axis-config-hint">Uma fala por linha. Tag opcional: [Categoria] texto, ou [Categoria:ruim] texto pra "não fala assim".</div>' +
        '<textarea id="cfg-falas-text" rows="10">' + esc(raw) + '</textarea>' +
        '<div class="axis-config-row">' +
        '<button type="button" class="axis-btn axis-btn-send" data-action="save-falas">Salvar Falas</button>' +
        '<button type="button" class="axis-btn" data-action="organizar-falas">🪄 Organizar automaticamente</button>' +
        '</div>' +
        '<div class="axis-config-hint">' + lines.length + ' fala(s) cadastrada(s).</div>' +
        '</div>'
    );
}
function renderConfigElenco() {
    const npcs = getNpcs();
    if (!npcs.length) return '<div class="axis-empty">Nenhum NPC ainda — aparecem sozinhos quando alguém fala/é citado no RP.</div>';
    const rows = npcs.map((n) =>
        '<div class="axis-config-list-item">' +
        '<div><strong>' + esc(n.name) + '</strong><br><span class="axis-config-hint">' + n.totalCitacoes + ' citação(ões)' + (n.arquivado ? ' · arquivado' : '') + '</span></div>' +
        '<div class="axis-config-row">' +
        '<select data-action="npc-importancia" data-id="' + n.id + '">' +
        ['baixa', 'media', 'alta'].map((imp) => '<option value="' + imp + '"' + (n.importancia === imp ? ' selected' : '') + '>' + imp + '</option>').join('') +
        '</select>' +
        '<button type="button" class="axis-btn axis-btn-sm" data-action="npc-toggle-arquivado" data-id="' + n.id + '">' + (n.arquivado ? 'Reativar' : 'Arquivar') + '</button>' +
        '</div></div>'
    ).join('');
    return '<div class="axis-config-section">' + rows + '</div>';
}
function renderConfigTarefas() {
    const tarefas = getTarefas().slice().sort((a, b) => b.createdAt - a.createdAt);
    if (!tarefas.length) return '<div class="axis-empty">Nenhuma tarefa ainda.</div>';
    const rows = tarefas.map((t) => {
        let actions = '';
        if (t.status === 'pendente') {
            actions = '<button type="button" class="axis-btn axis-btn-sm" data-action="tarefa-aceitar" data-id="' + t.id + '">Aceitar</button>' +
                '<button type="button" class="axis-btn axis-btn-sm" data-action="tarefa-recusar" data-id="' + t.id + '">✕ Recusar</button>';
        } else if (t.status === 'aceita') {
            actions = '<button type="button" class="axis-btn axis-btn-sm" data-action="tarefa-completar" data-id="' + t.id + '">Completar</button>';
        }
        return '<div class="axis-config-list-item"><div>' + esc(t.descricao) +
            '<br><span class="axis-config-hint">' + t.status + ' · ' + esc(t.criadoPor) + '</span></div>' +
            '<div class="axis-config-row">' + actions + '</div></div>';
    }).join('');
    return '<div class="axis-config-section">' + rows + '</div>';
}
function renderConfigTreino() {
    const queue = getQueue();
    const pendentes = queue.filter((i) => i.status === 'pendente');
    const resolvidas = queue.filter((i) => i.status !== 'pendente');
    const rows = pendentes.map((item) =>
        '<div class="axis-config-list-item"><div>' + esc(item.text) +
        '<br><span class="axis-config-hint">' + item.origem + (item.category ? ' · ' + esc(item.category) : '') + '</span></div>' +
        '<div class="axis-config-row">' +
        '<button type="button" class="axis-btn axis-btn-sm" data-action="treino-resolver" data-id="' + item.id + '" data-decisao="aprovada">✅</button>' +
        '<button type="button" class="axis-btn axis-btn-sm" data-action="treino-resolver" data-id="' + item.id + '" data-decisao="rejeitada">❌</button>' +
        '</div></div>'
    ).join('') || '<div class="axis-empty">Fila vazia.</div>';
    return (
        '<div class="axis-config-section">' +
        '<div class="axis-config-row">' +
        '<button type="button" class="axis-btn axis-btn-send" data-action="treino-gerar">✨ Gerar 3 sintéticas</button>' +
        '<button type="button" class="axis-btn" data-action="treino-minerar">⛏️ Minerar do RP</button>' +
        '</div>' +
        rows +
        '<div class="axis-config-hint">' + resolvidas.length + ' já resolvida(s).</div>' +
        '</div>'
    );
}
function renderConfigSala() {
    const estado = getInnerState();
    const mundo = getMundo();
    const nota = getAgentNote();
    const log = getAgentLog();
    const logHtml = log.length ? log.map((s, i) =>
        '<div class="axis-card' + (i === 0 ? ' axis-card-open' : '') + '">' +
        '<div class="axis-card-header" data-action="card-toggle">' + new Date(s.ts).toLocaleString('pt-BR') + ' — ' + esc(s.gatilho || 'manual') + '</div>' +
        '<div class="axis-card-body">' + esc(s.erro ? '⚠️ ' + s.erro : (s.reflexaoFinal || '(sem reflexão)')) +
        (s.acoes && s.acoes.length ? '<br><br><em>' + s.acoes.length + ' ação(ões): ' + esc(s.acoes.map((a) => a.tool).join(', ')) + '</em>' : '') +
        '</div></div>'
    ).join('') : '<div class="axis-empty">Nenhuma sessão ainda.</div>';

    return (
        '<div class="axis-config-section">' +
        '<div class="axis-config-readout"><strong>Estado interno:</strong> ' + esc(estado.text || '(nenhum)') + '</div>' +
        '<div class="axis-config-readout"><strong>Relógio:</strong> ' + esc(formatMundo(mundo)) + '</div>' +
        '<div class="axis-config-readout"><strong>Nota do agente:</strong> ' + esc(nota.text || '(nenhuma)') + '</div>' +
        '<div class="axis-config-row"><button type="button" class="axis-btn axis-btn-send" data-action="agente-pensar">🧠 Pensar agora</button></div>' +
        logHtml +
        '</div>'
    );
}
function renderConfigBody() {
    const el = document.getElementById('axis-config-body');
    if (!el) return;
    if (configTab === 'chave') el.innerHTML = renderConfigChave();
    else if (configTab === 'perfil') el.innerHTML = renderConfigPerfil();
    else if (configTab === 'falas') el.innerHTML = renderConfigFalas();
    else if (configTab === 'elenco') el.innerHTML = renderConfigElenco();
    else if (configTab === 'tarefas') el.innerHTML = renderConfigTarefas();
    else if (configTab === 'treino') el.innerHTML = renderConfigTreino();
    else if (configTab === 'sala') el.innerHTML = renderConfigSala();
    else el.innerHTML = '';
}
function renderConfigTabs() {
    const el = document.getElementById('axis-config-tabs');
    if (!el) return;
    el.innerHTML = CONFIG_TABS.map((pair) =>
        '<button type="button" class="axis-mini-tab' + (configTab === pair[0] ? ' axis-mini-active' : '') + '" data-action="switch-config-tab" data-tab="' + pair[0] + '">' + pair[1] + '</button>'
    ).join('');
}
function renderPanelChrome() {
    const tabEspaco = document.getElementById('axis-tab-espaco');
    const tabConfig = document.getElementById('axis-tab-config');
    if (tabEspaco) tabEspaco.classList.toggle('axis-mini-active', panelMode === 'espaco');
    if (tabConfig) tabConfig.classList.toggle('axis-mini-active', panelMode === 'config');

    const bodyEl = document.getElementById('axis-panel-body');
    const footerEl = document.getElementById('axis-espaco-footer');
    if (!bodyEl) return;

    if (panelMode === 'espaco') {
        if (footerEl) footerEl.style.display = '';
        bodyEl.innerHTML = '<div class="axis-espaco-chat" id="axis-espaco-chat"></div>';
        renderEspacoChat();
    } else {
        if (footerEl) footerEl.style.display = 'none';
        bodyEl.innerHTML =
            '<div class="axis-config-tabs" id="axis-config-tabs"></div>' +
            '<div class="axis-config-status" id="axis-config-status"></div>' +
            '<div class="axis-config-body" id="axis-config-body"></div>';
        renderConfigTabs();
        renderConfigBody();
    }
}

async function handlePanelAction(action, dataset, el) {
    if (action === 'switch-panel-mode') {
        if (panelMode === dataset.mode) return;
        panelMode = dataset.mode;
        renderPanelChrome();
        return;
    }
    if (action === 'switch-config-tab') {
        if (configTab === dataset.tab) return;
        configTab = dataset.tab;
        renderConfigTabs();
        renderConfigBody();
        return;
    }
    if (action === 'card-toggle') {
        const card = el.closest('.axis-card');
        if (card) card.classList.toggle('axis-card-open');
        return;
    }
    if (action === 'save-config') {
        setConfig({
            apiKey: document.getElementById('cfg-apikey').value.trim(),
            modelWriter: document.getElementById('cfg-writer').value.trim() || DEFAULT_MODELS.writer,
            modelFlash: document.getElementById('cfg-flash').value.trim() || DEFAULT_MODELS.flash,
            modelEmbed: document.getElementById('cfg-embed').value.trim() || DEFAULT_MODELS.embed,
        });
        showConfigStatus('Salvo.');
        return;
    }
    if (action === 'save-perfil') {
        setProfile(document.getElementById('cfg-perfil-text').value);
        showConfigStatus('Perfil salvo.');
        return;
    }
    if (action === 'save-falas') {
        setFalas(document.getElementById('cfg-falas-text').value.split('\n'));
        showConfigStatus('Falas salvas.');
        renderConfigBody();
        return;
    }
    if (action === 'organizar-falas') {
        showConfigStatus('Organizando...');
        try { const r = await organizarFalas(); showConfigStatus(r.organizadas + ' fala(s) organizada(s).'); }
        catch (e) { showConfigStatus('⚠️ ' + e.message); }
        renderConfigBody();
        return;
    }
    if (action === 'npc-importancia') {
        setNpcImportancia(dataset.id, el.value);
        return;
    }
    if (action === 'npc-toggle-arquivado') {
        const npc = getNpcs().find((n) => n.id === dataset.id);
        setNpcArquivado(dataset.id, !(npc && npc.arquivado));
        renderConfigBody();
        return;
    }
    if (action === 'tarefa-aceitar') { aceitarTarefa(dataset.id); renderConfigBody(); return; }
    if (action === 'tarefa-recusar') { recusarTarefa(dataset.id); renderConfigBody(); return; }
    if (action === 'tarefa-completar') { completarTarefa(dataset.id); renderConfigBody(); return; }
    if (action === 'treino-gerar') {
        showConfigStatus('Gerando...');
        try { await gerarFalasSinteticas({}); showConfigStatus('Geradas — revisa na fila.'); }
        catch (e) { showConfigStatus('⚠️ ' + e.message); }
        renderConfigBody();
        return;
    }
    if (action === 'treino-minerar') {
        showConfigStatus('Minerando...');
        try { const r = await minerarFalasDoRP({}); showConfigStatus(r.length + ' sugestão(ões) — revisa na fila.'); }
        catch (e) { showConfigStatus('⚠️ ' + e.message); }
        renderConfigBody();
        return;
    }
    if (action === 'treino-resolver') {
        resolverItem(dataset.id, dataset.decisao);
        renderConfigBody();
        return;
    }
    if (action === 'agente-pensar') {
        showConfigStatus('Pensando...');
        try {
            const session = await runAgentSession('manual');
            await forwardRpActions(session.acoes);
            showConfigStatus(session.erro ? '⚠️ ' + session.erro : 'Sessão concluída.');
        } catch (e) { showConfigStatus('⚠️ ' + e.message); }
        renderConfigBody();
        return;
    }
}

// ====================================
// CRIAÇÃO DO PAINEL
// ====================================
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
        '<div class="axis-panel-tabs">' +
        '<button type="button" class="axis-mini-tab axis-mini-active" id="axis-tab-espaco" data-action="switch-panel-mode" data-mode="espaco" title="Espaço">💬</button>' +
        '<button type="button" class="axis-mini-tab" id="axis-tab-config" data-action="switch-panel-mode" data-mode="config" title="Config">⚙</button>' +
        '</div>' +
        '<div class="axis-status-dots">' +
        '<div class="axis-dot axis-dot-idle" id="axis-dot-reading"></div>' +
        '<div class="axis-dot axis-dot-idle" id="axis-dot-writing"></div>' +
        '<div class="axis-dot axis-dot-idle" id="axis-dot-thinking"></div>' +
        '</div>' +
        '<div class="axis-espaco-header-actions">' +
        '<button type="button" class="axis-btn axis-btn-close" id="axis-espaco-close">✕</button>' +
        '</div></div>' +
        '<div class="axis-espaco-body" id="axis-panel-body">' +
        '<div class="axis-espaco-chat" id="axis-espaco-chat"></div>' +
        '</div>' +
        '<div class="axis-espaco-footer" id="axis-espaco-footer">' +
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
    });
    document.getElementById('axis-espaco-close').addEventListener('click', () => {
        panel.classList.remove('axis-visible');
        toggleBtn.classList.remove('axis-active');
    });

    const inputEl = document.getElementById('axis-espaco-input');
    const sendBtn = document.getElementById('axis-espaco-send');
    inputEl.addEventListener('input', () => claimSurface('espaco'));
    function doSend() {
        const text = inputEl.value.trim();
        if (!text) return;
        inputEl.value = '';
        sendEspacoMessage(text);
    }
    sendBtn.addEventListener('click', doSend);
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });

    panel.addEventListener('click', (e) => {
        const target = e.target.closest('[data-action]');
        if (!target) return;
        handlePanelAction(target.dataset.action, target.dataset, target).catch(reportFatalError);
    });
    panel.addEventListener('change', (e) => {
        const target = e.target.closest('[data-action]');
        if (!target) return;
        handlePanelAction(target.dataset.action, target.dataset, target).catch(reportFatalError);
    });

    loadEspacoHistoryLocal();

    if (!getConfig().apiKey) {
        showStatusPill('Configura a chave da NanoGPT em ⚙ Config › 🔑 Chave pra ativar.');
    }
}

// ====================================
// PRESENÇA DO LADO DO RP — inalterado.
// ====================================
function wireRpPresence() {
    const rpInput = document.getElementById('send_textarea'); // ⚠️ id padrão do ST — confirmar ao vivo se o tema mudar isso
    if (rpInput && !rpInput.dataset.axisWired) {
        rpInput.dataset.axisWired = '1';
        rpInput.addEventListener('input', () => {
            if ((rpInput.value || '').trim()) claimSurface('rp');
        });
    }
}

// ====================================
// GERAÇÃO DO RP — aborta a geração NATIVA do ST e assume via runRpTurn
// (local, sem WS). Gap conhecido: só age em type == null/undefined.
// ====================================
async function Spade_interceptGeneration(chatArr, contextSize, abort, type) {
    try {
        if (type) return;
        const token = claimSurface('rp');
        const last = Array.isArray(chatArr) && chatArr.length ? chatArr[chatArr.length - 1] : null;
        const recentText = (last && last.mes) ? String(last.mes).trim() : '';
        abort();
        const history = recentRpHistory().slice(0, -1);
        await postCharacterMessageStreaming(recentText, history, token);
    } catch (e) {
        reportFatalError(e);
    }
}
globalThis.Spade_interceptGeneration = Spade_interceptGeneration;

// ====================================
// EVENTOS DO ST
// ====================================
eventSource.on(event_types.GENERATION_STARTED, () => { try { claimSurface('rp'); } catch (e) { reportFatalError(e); } });
eventSource.on(event_types.GENERATION_STOPPED, () => { try { dotsIdle(); } catch (e) { reportFatalError(e); } });
eventSource.on(event_types.GENERATION_ENDED, () => { try { dotsIdle(); } catch (e) { reportFatalError(e); } });

eventSource.on(event_types.APP_READY, () => {
    try { createPanel(); wireRpPresence(); } catch (e) { reportFatalError(e); }
});
eventSource.on(event_types.CHAT_CHANGED, () => {
    try { renderEspacoChat(); wireRpPresence(); } catch (e) { reportFatalError(e); }
});

createPanel();
wireRpPresence();

} catch (fatalErr) {
    reportFatalError(fatalErr);
}

})();
