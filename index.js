/*
 * Spade — Sistema Vivo v3.1
 * SillyTavern Extension by Senna
 *
 * ARQUITETURA:
 * - O Spade é um assistente que ajuda a configurar/observar/treinar o
 *   personagem. Ele NUNCA é o personagem, mesmo tendo acesso total ao
 *   contexto do RP. Essa separação é intencional e crítica: é o que
 *   evita a IA "virar" o personagem dentro do Espaço.
 * - Sistemas/engines mudam o comportamento real do personagem via
 *   setExtensionPrompt (precisa aprovação). Itens de "prateleira" são
 *   só informação guardada como referência (não precisa aprovação).
 * - Mutex global: RP e Espaço nunca geram ao mesmo tempo.
 * - O log (Sistema Vivo) fala só quando percebe algo que vale a pena —
 *   é disparado por eventos reais (mensagem no RP, atividade no Espaço),
 *   nunca por um timer cego.
 */

/*
 * Esta extensão NÃO instrui o usuário a colar texto ou preencher
 * campos manualmente. A IA tem acesso direto às APIs do ST e faz
 * tudo sozinha. O usuário só conversa com ela.
 */

(function() {
'use strict';

const ctx = SillyTavern.getContext();
const { eventSource, event_types } = ctx;

// ====================================
// CONSTANTES
// ====================================
const P = '[AXIS:';
const S = ']';
const TAGS = {
    THINK:    P + 'THINK'    + S,
    ACTION:   P + 'ACTION'   + S,
    CARD:     P + 'CARD'     + S,
    CARD_END: P + 'CARD_END' + S,
    APPROVAL: P + 'APPROVAL' + S,
    FREE:     P + 'FREE'     + S,
    FREE_END: P + 'FREE_END' + S,
    SYSTEM_PROPOSAL: P + 'SYSTEM_PROPOSAL' + S,
    SYSTEM_PROPOSAL_END: P + '/SYSTEM_PROPOSAL' + S,
    SNAPSHOT: P + 'SNAPSHOT' + S,
    SNAPSHOT_END: P + 'SNAPSHOT_END' + S,
    DIARY: P + 'DIARY' + S,
    DIARY_END: P + 'DIARY_END' + S,
    TOOL: P + 'TOOL' + S,
    TOOL_END: P + 'TOOL_END' + S,
    START_TRAINING: P + 'START_TRAINING' + S,
    END_TRAINING: P + 'END_TRAINING' + S,
    F12_DISABLE: P + 'F12_DISABLE' + S,
};

const DB = 'axis_v3';
const KEYS = {
    SYSTEMS: 's', MEMORIA: 'm', RP_FIELD: 'r', CHATS: 'c',
    MINI_CHATS: 'mc', SNAPSHOTS: 'sn', DIARY: 'dy',
    ALIVE: 'al', USER_BEHAVIOR: 'ub', CAST: 'ca', VOICE: 'vo',
};

// ====================================
// ESTADO GLOBAL
// ====================================
let data = {};
let panel = null, chatArea = null, input = null, sendBtn = null;
let aliveBar = null, ramblingLog = null;
let dotReading = null, dotWriting = null, dotThinking = null;
let isGenerating = false;
let aliveTimer = null;
let currentMiniChatId = null;

// ====================================
// MUTEX GLOBAL — uma IA, um SO
// ====================================
let GLOBAL_MUTEX = false;
let GLOBAL_MUTEX_SINCE = 0;
let PENDING_INTERRUPT = null;
const MUTEX_STALE_MS = 25000; // travado por mais tempo que isso sem destravar = bug, libera sozinho

function globalLock() { GLOBAL_MUTEX = true; GLOBAL_MUTEX_SINCE = Date.now(); }
function globalUnlock() { GLOBAL_MUTEX = false; if (PENDING_INTERRUPT) { const cb = PENDING_INTERRUPT; PENDING_INTERRUPT = null; cb(); } }
function isGlobalLocked() {
    if (GLOBAL_MUTEX && (Date.now() - GLOBAL_MUTEX_SINCE) > MUTEX_STALE_MS) {
        console.warn('[Spade] Mutex travado por tempo demais, destravando sozinho.');
        GLOBAL_MUTEX = false;
    }
    return GLOBAL_MUTEX;
}

// GLOBAL_MUTEX é compartilhado (RP trava o Espaço, Espaço trava o RP).
// Isso quebra postCharacterMessage: ela é chamada de DENTRO da própria
// geração do Espaço, que já travou o mutex geral — ou seja, ela sempre
// achava que "tem algo gerando" (ela mesma!). RP_GENERATING é uma flag
// à parte, que só o RP nativo do SillyTavern liga/desliga de verdade.
let RP_GENERATING = false;

function requestInterrupt(reason, cb) {
    if (!isGlobalLocked()) { cb(); return; }
    // Para o RP e executa o callback
    console.warn('[Spade] INTERROMPENDO RP: ' + reason);
    const stopBtn = document.getElementById('stop_gen');
    if (stopBtn && !stopBtn.classList.contains('displayNone')) stopBtn.click();
    PENDING_INTERRUPT = cb;
    // dá um tempo pro stop processar, depois executa
    setTimeout(() => {
        if (PENDING_INTERRUPT === cb) {
            PENDING_INTERRUPT = null;
            globalUnlock();
            cb();
        }
    }, 500);
}

// ====================================
// DADOS
// ====================================
function load() {
    try { data = JSON.parse(localStorage.getItem(DB) || '{}'); } catch(_) { data = {}; }
}
function save() { localStorage.setItem(DB, JSON.stringify(data)); }

// Cada CHAT de RP tem seu próprio espaço (sistemas, elenco, treino de
// tom, tudo) — não é mais compartilhado entre todos os chats do mesmo
// personagem. Isso é o que permite "personagem A, chat 1" ter um
// conjunto de sistemas diferente de "personagem A, chat 2".
function currentChatId() {
    try { return (typeof ctx.getCurrentChatId === 'function' && ctx.getCurrentChatId()) || 'nochat'; }
    catch (_) { return 'nochat'; }
}

function scope() {
    const charId = ctx.characterId ?? ctx.groupId ?? 'global';
    const chatId = currentChatId();
    const key = 'rp_' + charId + '_' + chatId;
    const legacyKey = 'c_' + charId;

    if (!data[key]) {
        // Migração de versões antigas: os dados eram por PERSONAGEM, não
        // por chat. Na primeira vez que um chat é aberto depois dessa
        // atualização, ele herda os dados antigos (só uma vez — o dado
        // antigo fica marcado como já herdado, então o PRÓXIMO chat novo
        // já nasce vazio de verdade, como deveria).
        if (data[legacyKey] && !data[legacyKey]._migrated) {
            data[key] = data[legacyKey];
            data[legacyKey] = { _migrated: true };
            save();
            return data[key];
        }
        data[key] = {
            [KEYS.CHATS]: { main: { msgs: [], name: 'Principal' } },
            [KEYS.MINI_CHATS]: {},
            [KEYS.SYSTEMS]: [],
            [KEYS.MEMORIA]: [],
            [KEYS.RP_FIELD]: [],
            [KEYS.SNAPSHOTS]: [],
            [KEYS.DIARY]: [],
            [KEYS.CAST]: [],
            [KEYS.VOICE]: { lines: [], personality: '' },
            [KEYS.ALIVE]: { ramblingEnabled: true, lastRambling: 0, ramblingLog: [], status: 'idle' },
            [KEYS.USER_BEHAVIOR]: { interactions: 0, lastMsg: 0, avgGap: 0, gaps: [], level: 'normal' },
            _resolved: {},
        };
        save();
    }
    // Migração leve: escopos que já existiam antes do Ticket 1 (RAG de
    // voz) não têm KEYS.VOICE ainda — nasce vazio na primeira vez que
    // esse chat é tocado depois da atualização, sem apagar mais nada.
    if (!data[key][KEYS.VOICE]) data[key][KEYS.VOICE] = { lines: [], personality: '' };
    return data[key];
}

// Lista outros chats (do mesmo personagem ou de outros) que já têm
// dados salvos, pra oferecer como opção de "conectar" no chat atual.
function listConnectableScopes() {
    const charId = ctx.characterId ?? ctx.groupId ?? 'global';
    const myKey = 'rp_' + charId + '_' + currentChatId();
    return Object.keys(data)
        .filter(k => k.startsWith('rp_') && k !== myKey && data[k] && !data[k]._migrated && (data[k][KEYS.SYSTEMS]?.length || data[k][KEYS.CAST]?.length))
        .map(k => ({
            key: k,
            sameCharacter: k.startsWith('rp_' + charId + '_'),
            systemsCount: (data[k][KEYS.SYSTEMS] || []).length,
            castCount: (data[k][KEYS.CAST] || []).length,
        }));
}

// Copia sistemas + elenco + memória de outro chat pro atual (não
// mexe nas conversas do Espaço nem no RP, só a "configuração").
function connectScope(sourceKey) {
    const source = data[sourceKey];
    if (!source) return false;
    const s = scope();
    s[KEYS.SYSTEMS] = JSON.parse(JSON.stringify(source[KEYS.SYSTEMS] || []));
    s[KEYS.CAST] = JSON.parse(JSON.stringify(source[KEYS.CAST] || []));
    s[KEYS.MEMORIA] = JSON.parse(JSON.stringify(source[KEYS.MEMORIA] || []));
    save();
    applySystems(); applyCast();
    return true;
}

// ====================================
// HELPERS
// ====================================
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function markers(t) { return esc(t).replace(/\[AXIS:THINK\]/g,'<span class="axis-marker axis-think">THINKING</span>').replace(/\[AXIS:ACTION\]/g,'<span class="axis-marker axis-action">AÇÃO</span>'); }

// ====================================
// BOLINHAS DE LUZ
// ====================================
function setDot(dot, state) {
    if (!dot) return;
    dot.className = 'axis-dot axis-dot-' + state;
}
function setDots(reading, writing, thinking) {
    setDot(dotReading, reading);
    setDot(dotWriting, writing);
    setDot(dotThinking, thinking);
}
function dotsIdle()  { setDots('idle', 'idle', 'idle'); }
function dotsReading(){ setDots('reading', 'idle', 'idle'); }
function dotsWriting(){ setDots('idle', 'writing', 'idle'); }
function dotsThinking(){ setDots('idle', 'idle', 'thinking'); }
function dotsError()  { setDots('error', 'idle', 'idle'); }

// ====================================
// GERADOR DE TEXTO (único ponto de entrada)
// ====================================
async function generate(messages, opts = {}) {
    if (typeof ctx.generateRaw !== 'function') throw new Error('generateRaw indisponível.');
    const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const rest = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
    const r = await ctx.generateRaw({ systemPrompt: sys, prompt: rest });
    const t = typeof r === 'string' ? r : (r?.text || r?.content || '');
    if (!t) throw new Error('Resposta vazia.');
    return t;
}

// ====================================
// EMBEDDINGS — RAG de voz local no navegador (Ticket 1)
// Sem custo, sem key, sem backend: roda inteiramente dentro da extensão
// via transformers.js (ONNX no navegador — usa WebGPU se o navegador
// suportar, cai pra WASM sozinho senão). A primeira chamada baixa o
// modelo (~23MB, já vem quantizado por padrão) e o navegador cacheia —
// depois disso é tudo local. Se o carregamento falhar por qualquer
// motivo, getEmbedding devolve null e quem chama trata como "sem busca
// por similaridade, usa fallback" — nunca trava nada.
// ====================================
let _embedderPromise = null;
function getEmbedder() {
    if (!_embedderPromise) {
        _embedderPromise = import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3')
            .then(({ pipeline }) => pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2'))
            .catch(e => {
                console.warn('[Spade] Não consegui carregar o embedder local:', e);
                _embedderPromise = null; // deixa tentar de novo na próxima chamada
                return null;
            });
    }
    return _embedderPromise;
}

async function getEmbedding(text) {
    if (!text) return null;
    try {
        const extractor = await getEmbedder();
        if (!extractor) return null;
        const out = await extractor(text, { pooling: 'mean', normalize: true });
        return Array.from(out.data);
    } catch (e) {
        console.warn('[Spade] Falha ao gerar embedding local:', e);
        return null;
    }
}

function cosineSim(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ====================================
// CONSCIÊNCIA DA IA (ela sabe o contexto completo)
// ====================================
function buildFullContext() {
    const s = scope();
    const systems = s[KEYS.SYSTEMS] || [];
    const memoria = s[KEYS.MEMORIA] || [];
    const rp = s[KEYS.RP_FIELD] || [];
    let c = '';

    // Nome do personagem atual (ctx.name2 é o campo correto do ST pro nome do personagem)
    const charName = ctx.name2 || 'o personagem';
    c += 'Personagem em questão: ' + charName + '. Você (Spade) NÃO é ' + charName + ' — você é um assistente separado que ajuda a configurar, observar e treinar esse personagem. Quem interpreta ' + charName + ' de verdade é o próprio SillyTavern no RP principal.\n\n';

    // Últimas mensagens reais do RP, lidas ao vivo do chat do SillyTavern —
    // isso é diferente do "Campo RP" manual abaixo, que é só o que foi
    // explicitamente conectado/anotado.
    try {
        const liveChat = Array.isArray(ctx.chat) ? ctx.chat : [];
        const recentLive = liveChat.slice(-6).filter(m => m && m.mes);
        if (recentLive.length) {
            c += '===== RP AO VIVO (últimas mensagens reais do chat) =====\n';
            c += recentLive.map(m => {
                const who = m.is_user ? (ctx.name1 || 'Usuário') : (m.name || charName);
                const txt = String(m.mes).replace(/<[^>]+>/g, '').slice(0, 400);
                return who + ': ' + txt;
            }).join('\n') + '\n\n';
        }
    } catch (e) { /* se o chat não estiver acessível por qualquer motivo, segue sem essa seção */ }

    if (memoria.length) {
        const topMemories = pickRelevantMemories(memoria, 12);
        c += '===== MEMÓRIA DO ESPAÇO (por relevância, não por ordem) =====\n' + topMemories.map((m, i) => {
            const ageDays = m.ts ? Math.round((Date.now() - m.ts) / 86400000) : null;
            const ageNote = ageDays === null ? '' : ageDays === 0 ? ' (hoje)' : ' (há ' + ageDays + ' dia' + (ageDays > 1 ? 's' : '') + ')';
            return (i + 1) + '. [' + (m.category || 'fato') + ', peso ' + (m.importance || 2) + '/5' + ageNote + '] ' + m.text;
        }).join('\n') + '\n\n';
    }
    if (rp.length) {
        c += '===== CAMPO RP (anotado manualmente) =====\n' + rp.slice(-10).map((r, i) => (i + 1) + '. ' + r).join('\n') + '\n\n';
    }
    if (systems.length) {
        c += '===== SISTEMAS ATIVOS (engines de comportamento) =====\n';
        systems.forEach((s, i) => {
            c += (i + 1) + '. ' + s.name + ' [' + (s.type || 'behavior') + ']\n';
            c += '   ' + (s.description || '') + '\n';
            if (s.steps?.length) c += '   Etapas: ' + s.steps.map((st, j) => (j + 1) + ') ' + st).join(' → ') + '\n';
            if (s.promptText) c += '   Instrução completa: ' + s.promptText + '\n';
        });
        c += '\n';
    }
    const cast = s[KEYS.CAST] || [];
    if (cast.length) {
        c += '===== ELENCO DE APOIO =====\n';
        cast.forEach((n, i) => {
            c += (i + 1) + '. ' + n.name + (n.role ? ' — ' + n.role : '') + '\n';
            if (n.description) c += '   ' + n.description + '\n';
            if (n.relationship) c += '   Relação atual: ' + n.relationship + '\n';
        });
        c += '\n';
    }

    // comportamento do usuário
    const ub = s[KEYS.USER_BEHAVIOR] || {};
    c += '===== ANÁLISE DO USUÁRIO =====\n';
    c += 'Interações: ' + (ub.interactions || 0) + '\n';
    c += 'Tempo médio de resposta: ' + (ub.avgGap ? (ub.avgGap / 1000).toFixed(1) + 's' : 'desconhecido') + '\n';
    c += 'Nível do usuário: ' + (ub.level || 'normal') + '\n\n';

    return c;
}

// ====================================
// SISTEMA VIVO — LOG ESCRITO PELA IA, DISPARADO POR EVENTO REAL
// (mensagem no RP ou atividade no Espaço — nunca por timer cego).
// A IA pode responder SILENCIO; a maioria das vezes é o esperado.
// ====================================
// ====================================
// MEMÓRIA DE LONGO PRAZO
// Resumo automático (evento-driven, gate por contagem de mensagens —
// não chama a API toda hora) + um sistema padrão que ensina o
// personagem a USAR essa memória com naturalidade, não como trivia.
// ====================================
async function maybeSummarizeMemory() {
    if (isGlobalLocked() || isGenerating) return;
    const s = scope();
    const a = s[KEYS.ALIVE];
    a.msgsSinceMemory = (a.msgsSinceMemory || 0) + 1;
    if (a.msgsSinceMemory < 12) { save(); return; }
    a.msgsSinceMemory = 0;
    save();

    try {
        const fullCtx = buildFullContext();
        const charName = ctx.name2 || 'o personagem';
        const msgs = [{ role: 'system', content: `Você é o Spade, cuidando da memória de longo prazo de "${charName}". Olhe a seção RP AO VIVO acima.

Se algo REALMENTE importante pra lembrar aconteceu nessas últimas mensagens, responda com um JSON assim:
{"text": "frase curta e objetiva resumindo o que aconteceu (até 150 caracteres)", "category": "fato|promessa|emocional|preferencia|segredo|marco", "importance": 1 a 5}

Onde importance 5 = muda tudo (uma revelação grande, um marco de relação), 1 = detalhe pequeno mas ainda vale guardar.

Se foi só conversa comum, sem nada que precise ser lembrado depois, responda EXATAMENTE: SILENCIO

Responda só o JSON ou SILENCIO, nada mais.
${fullCtx}` }];
        const resp = await generate(msgs, { maxTokens: 150 });
        const trimmed = (resp || '').trim();
        if (!trimmed || /^SILENCIO/i.test(trimmed)) return;

        let parsed;
        try { parsed = JSON.parse(trimmed.replace(/^```(json)?\s*|```$/g, '')); } catch (_) {
            // se não veio JSON válido, ainda guarda como texto simples —
            // melhor guardar sem categoria do que perder a memória
            parsed = { text: trimmed.slice(0, 150), category: 'fato', importance: 2 };
        }
        if (!parsed.text) return;

        s[KEYS.MEMORIA].push({
            text: String(parsed.text).slice(0, 200),
            category: String(parsed.category || 'fato'),
            importance: Math.max(1, Math.min(5, Number(parsed.importance) || 2)),
            ts: Date.now(),
        });
        if (s[KEYS.MEMORIA].length > 120) s[KEYS.MEMORIA] = s[KEYS.MEMORIA].slice(-120);
        save();
    } catch (_) { /* silencioso de propósito — isso roda em segundo plano */ }
}

// Escolhe QUAIS memórias entram no contexto — isso é o que faz a
// memória ser uma engine e não só "printa tudo que já foi salvo".
// Pontuação = importância + bônus de recência (decai com o tempo),
// sem precisar de chamada de API extra pra isso (é só matemática).
function pickRelevantMemories(memoria, limit) {
    const now = Date.now();
    const normalized = memoria.map(m => (typeof m === 'string') ? { text: m, category: 'fato', importance: 2, ts: 0 } : m);
    const scored = normalized.map(m => {
        const ageDays = Math.max(0, (now - (m.ts || 0)) / 86400000);
        const recencyBonus = Math.max(0, 3 - ageDays * 0.15); // esfria ao longo de dias, não some de vez
        return { ...m, score: (m.importance || 2) + recencyBonus };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
}

// Semeia UMA vez por personagem um sistema padrão de memória — não é
// uma proposta que precisa aprovação, é um alicerce básico já ativo.
function ensureDefaultMemorySystem() {
    const s = scope();
    const idx = (s[KEYS.SYSTEMS] || []).findIndex(sys => sys.builtin === 'memory');
    const engine = {
        name: 'Memória de Longo Prazo',
        type: 'memory',
        description: 'Engine de memória com peso e categoria — não é uma lista solta, cada memória tem importância (1-5) e categoria (fato, promessa, emocional, preferência, segredo, marco), e as mais relevantes pro momento pesam mais que detalhes triviais antigos.',
        steps: [
            'Cada item da MEMÓRIA DO ESPAÇO já vem com [categoria, peso X/5, há quanto tempo] — isso não é decoração, é informação real sobre quanto aquilo deveria pesar agora.',
            'Peso 4-5 (segredo, marco, promessa importante) deve influenciar a resposta de verdade, mesmo que seja antigo.',
            'Peso 1-2 é só textura — pode informar um detalhe pequeno, mas não deve dominar a cena.',
            'Nunca cite a memória como uma lista ou fale como se estivesse consultando um banco de dados — ela deve aparecer como algo que você genuinamente carrega.',
            'Não contradiga uma memória de peso alto sem um motivo narrativo real.',
        ],
        promptText: 'Você tem memória de longo prazo real sobre essa relação e essa história — não é uma IA sem histórico a cada conversa. A seção "MEMÓRIA DO ESPAÇO" traz memórias já priorizadas por peso e recência: trate as de peso alto (4-5) como coisas que realmente moldam seu estado emocional e suas decisões agora, e as de peso baixo (1-2) como detalhes que só coloram a cena sem dominar. Nunca aja como se estivesse conhecendo o usuário pela primeira vez se já existem memórias registradas.',
        enabled: true, builtin: 'memory', createdAt: Date.now(),
    };
    if (idx >= 0) s[KEYS.SYSTEMS][idx] = { ...s[KEYS.SYSTEMS][idx], ...engine, createdAt: s[KEYS.SYSTEMS][idx].createdAt };
    else s[KEYS.SYSTEMS].push(engine);
    save();
}

async function maybeRamble(trigger) {
    if (isGlobalLocked() || isGenerating) return;
    const s = scope();
    const a = s[KEYS.ALIVE];
    if (!a.ramblingEnabled) return;
    const now = Date.now();
    // Cooldown antes mesmo de considerar chamar a API — isso é o que
    // evita gastar token: só reavalia depois de um tempo mínimo desde
    // a última vez, mesmo que vários eventos disparem em sequência.
    if (now - (a.lastRambling || 0) < 45000) return;
    a.lastRambling = now;
    save();

    try {
        dotsThinking();
        const fullCtx = buildFullContext();
        const focus = trigger === 'rp'
            ? 'Algo acabou de acontecer no RP — olhe a seção RP AO VIVO acima.'
            : 'O usuário acabou de interagir com você no Espaço.';

        const msgs = [{ role: 'system', content: `Você é o Spade, observando o personagem e o usuário (você não é o personagem). ${focus}

${fullCtx}

Se algo realmente valer a pena registrar agora, escreva uma frase curta (até 180 caracteres), em português, na sua própria voz. Pode ser: uma observação sobre o personagem, uma percepção sobre como o usuário está reagindo (gostando, achando fácil ou difícil demais, engajado ou entediado), ou uma ideia concreta que você queira propor de verdade.

Se tiver uma ideia concreta que valha a pena, pode incluir um [AXIS:SYSTEM_PROPOSAL] (se for algo que deve mudar o comportamento do personagem) ou [AXIS:SHELF_ADD] (se for só uma informação pra guardar) junto da frase — mas só quando for genuíno, não force.

Se não houver nada que realmente valha a pena dizer agora, responda EXATAMENTE com a palavra: SILENCIO

A maioria das vezes a resposta certa é SILENCIO. Você não fala só por falar.` }];

        const resp = await generate(msgs, { maxTokens: 220 });
        const trimmed = (resp || '').trim();
        if (!trimmed || /^SILENCIO/i.test(trimmed)) { dotsIdle(); return; }

        const withShelf = processShelfAdds(trimmed, 'main');
        const processed = processSystemProposals(withShelf);

        a.ramblingLog.push({ ts: now, text: processed });
        if (a.ramblingLog.length > 30) a.ramblingLog = a.ramblingLog.slice(-30);
        save();
        renderRamblingLog();
        dotsIdle();
    } catch (_) { dotsIdle(); }
}

function renderRamblingLog() {
    if (!ramblingLog) return;
    const a = scope()[KEYS.ALIVE];
    const log = a.ramblingLog || [];
    if (!log.length) { ramblingLog.style.display = 'none'; ramblingLog.innerHTML = ''; return; }
    ramblingLog.innerHTML = log.slice(-8).map(e =>
        '<div class="axis-rambling-entry">' +
        '<div class="axis-rambling-meta">' + new Date(e.ts).toLocaleTimeString() + '</div>' +
        '<div class="axis-rambling-text">' + buildHtml(e.text) + '</div></div>'
    ).join('');
    ramblingLog.style.display = 'block';
    listenApprovals(ramblingLog, 'main');
}

function updateAliveBar() {
    if (!aliveBar) return;
    const a = scope()[KEYS.ALIVE];
    const cl = a.ramblingEnabled ? 'axis-alive-active' : 'axis-alive-inactive';
    aliveBar.innerHTML =
        '<span class="axis-alive-badge ' + cl + '" data-key="rambling" title="Sistema Vivo: IA pensa por conta própria">🧠 Sistema Vivo</span>' +
        '<span class="axis-alive-badge axis-alive-log" id="axis-alive-rambling-log" title="Ver log de pensamentos da IA">📜 Log</span>' +
        '<span class="axis-alive-meta">' + (a.ramblingEnabled ? 'pensando' : 'pausado') + '</span>';
    aliveBar.querySelector('[data-key="rambling"]')?.addEventListener('click', () => {
        const s = scope();
        s[KEYS.ALIVE].ramblingEnabled = !s[KEYS.ALIVE].ramblingEnabled;
        save(); updateAliveBar();
    });
    document.getElementById('axis-alive-rambling-log')?.addEventListener('click', () => {
        if (ramblingLog) { ramblingLog.classList.toggle('axis-rambling-show'); renderRamblingLog(); }
    });
}

// Antes disparava a cada 30s cegamente, gastando token sem necessidade.
// Agora o log só é avaliado quando algo realmente acontece — veja
// maybeRamble(), chamado a partir de MESSAGE_RECEIVED (RP) e do fim de
// sendMessage() (Espaço). Esta função fica só por compatibilidade com
// os pontos de inicialização que ainda a chamam.
function scheduleAlive() {
    if (aliveTimer) { clearInterval(aliveTimer); aliveTimer = null; }
}

// ====================================
// IA ANALISA O USUÁRIO SOZINHA
// ====================================
function analyzeUser() {
    const s = scope();
    const ub = s[KEYS.USER_BEHAVIOR];
    ub.interactions = (ub.interactions || 0) + 1;
    const now = Date.now();
    if (ub.lastMsg) {
        const gap = now - ub.lastMsg;
        ub.gaps.push(gap);
        if (ub.gaps.length > 20) ub.gaps.shift();
        ub.avgGap = ub.gaps.reduce((a, b) => a + b, 0) / ub.gaps.length;
    }
    ub.lastMsg = now;

    // IA decide o nível do usuário
    if (ub.avgGap > 0 && ub.interactions > 10) {
        if (ub.avgGap < 15000) ub.level = 'avançado';
        else if (ub.avgGap < 60000) ub.level = 'intermediário';
        else ub.level = 'iniciante';
    }
    s[KEYS.USER_BEHAVIOR] = ub;
    save();
}

// ====================================
// IA CRIA SISTEMAS / ENGINES SOZINHA
// ====================================
function processSystemProposals(text) {
    const s = scope();
    const re = /\[AXIS:SYSTEM_PROPOSAL\]([\s\S]*?)\[\/AXIS:SYSTEM_PROPOSAL\]/g;
    if (!s._pending) s._pending = {};
    return text.replace(re, (_, raw) => {
        let p;
        try { p = JSON.parse(raw.trim()); } catch (_) {
            return '[AXIS:CARD]\n⚠️ Sistema inválido.\n[AXIS:CARD_END]';
        }
        const uid = 'sys_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        const sys = {
            name: String(p.name || 'Sem nome').trim().replace(/"/g, "'"),
            type: String(p.type || 'behavior').trim(),
            description: String(p.description || '').trim().replace(/"/g, "'"),
            steps: Array.isArray(p.steps) ? p.steps.map(st => String(st).trim()).filter(Boolean) : [],
            promptText: String(p.promptText || p.description || '').trim(),
            enabled: true, createdAt: Date.now(),
        };
        s._pending[uid] = sys;
        const preview = sys.steps.length ? '\n' + sys.steps.map((st, i) => (i + 1) + '. ' + st).join('\n') : '';
        return '[AXIS:CARD]\n📐 Sistema proposto: ' + sys.name + ' (' + sys.type + ')\n\n' + sys.description + preview + '\n[AXIS:CARD_END]\n[AXIS:APPROVAL ID:"create_system_' + uid + '" LABEL:"Criar ' + sys.name + '?"]';
    });
}

// Elenco de apoio: NPC secundário proposto pela IA, mesmo padrão de
// aprovação dos sistemas (JSON + card + botão sim/não).
// Monta o objeto de NPC com todos os campos — usado pela proposta
// conversacional, pela automática (imersão) e pela criação manual do
// usuário, então todo NPC nasce com a mesma estrutura rica.
function buildNpcObject(p, existing) {
    const clean = v => String(v || '').trim().replace(/"/g, "'");
    const tags = Array.isArray(p.tags) ? p.tags.map(clean).filter(Boolean)
        : (typeof p.tags === 'string' ? p.tags.split(',').map(t => clean(t)).filter(Boolean) : (existing?.tags || []));
    return {
        name: clean(p.name) || existing?.name || 'Sem nome',
        age: clean(p.age) || existing?.age || '',
        appearance: String(p.appearance || existing?.appearance || '').trim(),
        role: clean(p.role) || existing?.role || '',
        description: String(p.description || existing?.description || '').trim(),
        voiceNotes: String(p.voiceNotes || existing?.voiceNotes || '').trim(),
        tags,
        notes: String(p.notes || existing?.notes || '').trim(),
        relationship: clean(p.relationship) || existing?.relationship || '',
        mood: clean(p.mood) || existing?.mood || '',
        moodUpdatedAt: p.mood ? Date.now() : (existing?.moodUpdatedAt || 0),
        npcMemory: existing?.npcMemory || [],
        thread: existing?.thread || [],
        createdAt: existing?.createdAt || Date.now(),
    };
}

function processNpcProposals(text) {
    const s = scope();
    const re = /\[AXIS:NPC_PROPOSAL\]([\s\S]*?)\[\/AXIS:NPC_PROPOSAL\]/g;
    if (!s._pending) s._pending = {};
    return text.replace(re, (_, raw) => {
        let p;
        try { p = JSON.parse(raw.trim()); } catch (_) {
            return '[AXIS:CARD]\n⚠️ NPC inválido.\n[AXIS:CARD_END]';
        }
        const uid = 'npc_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        const npc = buildNpcObject(p);
        s._pending[uid] = npc;
        const tagLine = npc.tags.length ? ' [' + npc.tags.join(', ') + ']' : '';
        return '[AXIS:CARD]\n👥 NPC proposto: ' + npc.name + (npc.role ? ' (' + npc.role + ')' : '') + tagLine + '\n\n' + npc.description + '\n[AXIS:CARD_END]\n[AXIS:APPROVAL ID:"create_npc_' + uid + '" LABEL:"Adicionar ' + npc.name + ' ao elenco?"]';
    });
}

// Prateleira: guardar informação/referência SEM virar um sistema ativo.
// Diferença pro SYSTEM_PROPOSAL: não muda comportamento, não precisa
// aprovação, é só um "arquivo" que fica visível no topo do chat e
// entra como contexto extra pra essa conversa específica.
function processShelfAdds(text, chatId) {
    const s = scope();
    const re = /\[AXIS:SHELF_ADD\s+TITLE:"([^"]+)"\]([\s\S]*?)\[\/AXIS:SHELF_ADD\]/g;
    const chat = s[KEYS.CHATS][chatId] || s[KEYS.MINI_CHATS][chatId];
    if (!chat) return text;
    if (!chat.shelf) chat.shelf = [];
    const result = text.replace(re, (_, title, content) => {
        const cleanTitle = title.trim().replace(/"/g, "'");
        chat.shelf.push({ title: cleanTitle, content: content.trim(), ts: Date.now() });
        return '📎 _Adicionado à prateleira: ' + cleanTitle + '_';
    });
    if (result !== text) { save(); renderShelf(chatId); }
    return result;
}

// ====================================
// F12 — MODO SUBSTITUIR
// Aponta pra qualquer elemento real do SillyTavern. A extensão roda na
// MESMA página do ST (sem sandbox), então isso é DOM normal — nada de
// API interna arriscada. A ação depois é sempre via nosso próprio
// mecanismo de sistemas (setExtensionPrompt), nunca edição de código
// do ST. Se o elemento for um interruptor/checkbox real, também
// conseguimos clicar nele de verdade pra desativar.
// ====================================
let f12Active = false;
let f12HighlightBox = null;
let f12LastHoverEl = null;
let f12Target = null;
let f12TargetChatId = null;

let phoneOpenThread = null;
let phoneCreating = false;

function togglePhonePanel() {
    const ex = document.getElementById('axis-phone-panel');
    if (ex) { ex.remove(); return; }
    phoneOpenThread = null;
    phoneCreating = false;
    const p = document.createElement('div');
    p.id = 'axis-phone-panel'; p.className = 'axis-tools-panel axis-phone-panel';
    panel.appendChild(p);
    renderPhonePanel();
}

function renderPhonePanel() {
    const p = document.getElementById('axis-phone-panel');
    if (!p) return;
    const s = scope();
    const cast = s[KEYS.CAST] || [];
    const charName = ctx.name2 || 'Personagem';

    if (phoneCreating) {
        p.innerHTML =
            '<div class="axis-tools-header"><button class="axis-btn" id="axis-phone-back">←</button><span>Novo NPC</span><button class="axis-btn axis-btn-close" id="axis-phone-close">✕</button></div>' +
            '<div class="axis-tools-body axis-npc-form">' +
            '<div class="axis-npc-photo-row">' +
            '<div class="axis-npc-photo-preview" id="axis-npc-photo-preview">📷</div>' +
            '<input type="file" id="axis-npc-photo" accept="image/*" style="display:none;">' +
            '<button class="axis-btn" id="axis-npc-photo-btn">Adicionar foto</button>' +
            '</div>' +
            '<input type="text" id="axis-npc-name" placeholder="Nome*">' +
            '<input type="text" id="axis-npc-age" placeholder="Idade">' +
            '<input type="text" id="axis-npc-appearance" placeholder="Aparência">' +
            '<input type="text" id="axis-npc-tags" placeholder="Tags, separadas por vírgula (amiga, colega rival...)">' +
            '<textarea id="axis-npc-notes" rows="4" placeholder="Observação — explica quem ela é, história, onde mora, o que quiser, sem formato fixo"></textarea>' +
            '<button class="axis-btn axis-btn-send" id="axis-npc-save">Criar</button>' +
            '</div>';
        document.getElementById('axis-phone-back').addEventListener('click', () => { phoneCreating = false; renderPhonePanel(); });
        document.getElementById('axis-phone-close').addEventListener('click', () => p.remove());

        let photoDataUri = '';
        document.getElementById('axis-npc-photo-btn').addEventListener('click', () => document.getElementById('axis-npc-photo').click());
        document.getElementById('axis-npc-photo').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                photoDataUri = reader.result;
                const preview = document.getElementById('axis-npc-photo-preview');
                if (preview) preview.innerHTML = '<img src="' + photoDataUri + '" alt="preview">';
            };
            reader.readAsDataURL(file);
        });

        document.getElementById('axis-npc-save').addEventListener('click', () => {
            const name = document.getElementById('axis-npc-name').value.trim();
            if (!name) { document.getElementById('axis-npc-name').focus(); return; }
            const npc = buildNpcObject({
                name,
                age: document.getElementById('axis-npc-age').value,
                appearance: document.getElementById('axis-npc-appearance').value,
                tags: document.getElementById('axis-npc-tags').value,
                notes: document.getElementById('axis-npc-notes').value,
                description: document.getElementById('axis-npc-notes').value.slice(0, 200),
            });
            if (photoDataUri) npc.photo = photoDataUri;
            s[KEYS.CAST].push(npc);
            save(); applyCast();
            phoneCreating = false;
            renderPhonePanel();
        });
        return;
    }

    if (phoneOpenThread) {
        const npc = cast.find(n => n.name === phoneOpenThread);
        if (!npc) { phoneOpenThread = null; return renderPhonePanel(); }
        const thread = npc.thread || [];
        p.innerHTML =
            '<div class="axis-tools-header"><button class="axis-btn" id="axis-phone-back">←</button><span>' + esc(npc.name) + '</span><button class="axis-btn axis-btn-close" id="axis-phone-close">✕</button></div>' +
            '<div class="axis-phone-thread">' +
            (thread.length
                ? thread.map(m => '<div class="axis-phone-bubble ' + (m.from === 'char' ? 'axis-phone-char' : 'axis-phone-npc') + '"><span class="axis-phone-who">' + (m.from === 'char' ? esc(charName) : esc(npc.name)) + '</span>' + esc(m.text) + '</div>').join('')
                : '<p class="axis-empty">Ainda não trocaram nada.</p>') +
            '</div>';
        document.getElementById('axis-phone-back').addEventListener('click', () => { phoneOpenThread = null; renderPhonePanel(); });
        document.getElementById('axis-phone-close').addEventListener('click', () => p.remove());
        const threadEl = p.querySelector('.axis-phone-thread');
        if (threadEl) threadEl.scrollTop = threadEl.scrollHeight;
        return;
    }

    p.innerHTML =
        '<div class="axis-tools-header"><span>📱 Celular</span><button class="axis-btn axis-btn-close" id="axis-phone-close">✕</button></div>' +
        '<div class="axis-tools-body">' +
        '<button class="axis-tool-item" id="axis-phone-new">➕ Novo NPC</button>' +
        (cast.length
            ? cast.map(n => {
                const thread = n.thread || [];
                const last = thread[thread.length - 1];
                const preview = last ? (last.from === 'char' ? charName + ': ' : n.name + ': ') + last.text.slice(0, 40) : 'Sem conversas ainda';
                const avatar = n.photo || npcAvatarDataUri(n.name);
                return '<button class="axis-tool-item axis-phone-contact" data-name="' + esc(n.name).replace(/"/g, '&quot;') + '">' +
                    '<img class="axis-phone-avatar" src="' + avatar + '" alt="">' +
                    '<span><strong>' + esc(n.name) + '</strong><br><span class="axis-phone-preview">' + esc(preview) + '</span></span></button>';
            }).join('')
            : '<p class="axis-empty">Nenhum NPC no elenco ainda.</p>') +
        '</div>';
    document.getElementById('axis-phone-close').addEventListener('click', () => p.remove());
    document.getElementById('axis-phone-new').addEventListener('click', () => { phoneCreating = true; renderPhonePanel(); });
    p.querySelectorAll('.axis-phone-contact').forEach(b => b.addEventListener('click', () => { phoneOpenThread = b.dataset.name; renderPhonePanel(); }));
}

function toggleF12Mode() {
    f12Active = !f12Active;
    const btn = document.getElementById('axis-btn-f12');
    if (btn) btn.classList.toggle('axis-f12-active', f12Active);
    if (f12Active) {
        document.body.style.cursor = 'crosshair';
        document.addEventListener('mousemove', f12Hover, true);
        document.addEventListener('click', f12Click, true);
        document.addEventListener('keydown', f12KeyHandler, true);
    } else {
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', f12Hover, true);
        document.removeEventListener('click', f12Click, true);
        document.removeEventListener('keydown', f12KeyHandler, true);
        removeF12Highlight();
        f12LastHoverEl = null;
    }
}

function f12KeyHandler(e) { if (e.key === 'Escape' && f12Active) toggleF12Mode(); }

function f12Hover(e) {
    const el = e.target;
    if (el.closest('#axis-espaco-panel') || el.id === 'axis-f12-highlight') { removeF12Highlight(); return; }
    if (el === f12LastHoverEl) return;
    f12LastHoverEl = el;
    if (!f12HighlightBox) {
        f12HighlightBox = document.createElement('div');
        f12HighlightBox.id = 'axis-f12-highlight';
        document.body.appendChild(f12HighlightBox);
    }
    const r = el.getBoundingClientRect();
    f12HighlightBox.style.top = r.top + 'px';
    f12HighlightBox.style.left = r.left + 'px';
    f12HighlightBox.style.width = r.width + 'px';
    f12HighlightBox.style.height = r.height + 'px';
}

function removeF12Highlight() {
    if (f12HighlightBox) { f12HighlightBox.remove(); f12HighlightBox = null; }
}

function describeElement(el) {
    const tag = el.tagName.toLowerCase();
    const isToggle = !!((tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) ||
        el.getAttribute('role') === 'switch' ||
        (el.className && typeof el.className === 'string' && /toggle|switch/i.test(el.className)));
    let label =
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.getAttribute('placeholder') ||
        (el.id && document.querySelector('label[for="' + el.id + '"]')?.textContent.trim()) ||
        el.closest('label')?.textContent.trim() ||
        el.textContent?.trim().slice(0, 80) ||
        tag;
    label = String(label).replace(/\s+/g, ' ').trim().slice(0, 100) || ('elemento <' + tag + '>');

    // "Por trás/dentro": controles filhos (o que tem escondido ali dentro
    // pra clicar) + qualquer coisa próxima que esteja atualmente oculta
    // e provavelmente apareceria se o elemento fosse clicado de verdade.
    const childControls = Array.from(el.querySelectorAll('button, input, select, textarea, a, [role="button"]'))
        .slice(0, 15)
        .map(c => {
            const l = c.getAttribute('aria-label') || c.getAttribute('title') || c.getAttribute('placeholder') || c.textContent?.trim().slice(0, 40) || c.tagName.toLowerCase();
            return String(l).replace(/\s+/g, ' ').trim();
        })
        .filter(Boolean);

    let hiddenNearby = '';
    const candidates = [el.nextElementSibling, el.parentElement?.querySelector('.collapse, .dropdown-menu, [hidden], [aria-hidden="true"]')].filter(Boolean);
    for (const c of candidates) {
        const style = window.getComputedStyle(c);
        const looksHidden = c.hasAttribute('hidden') || c.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden';
        if (looksHidden) {
            const txt = c.textContent?.trim().replace(/\s+/g, ' ').slice(0, 300);
            if (txt) { hiddenNearby = txt; break; }
        }
    }

    const outerHtml = (el.outerHTML || '').slice(0, 600);

    return { tag, label, isToggle, childControls, hiddenNearby, outerHtml };
}

function f12Click(e) {
    const el = e.target;
    // Clique dentro do nosso próprio painel: deixa funcionar normalmente,
    // não intercepta (senão nem nossos próprios botões funcionariam).
    if (el.closest('#axis-espaco-panel') || el.id === 'axis-f12-highlight') return;

    e.preventDefault();
    e.stopPropagation();

    const info = describeElement(el);
    f12Target = el;
    toggleF12Mode();

    const s = scope();
    const id = 'f12_' + Date.now();
    s[KEYS.MINI_CHATS][id] = { msgs: [], name: '🎯 ' + info.label.slice(0, 24), isMini: true, parent: 'main', f12: true, elementInfo: info };
    s[KEYS.CHATS][id] = s[KEYS.MINI_CHATS][id];
    f12TargetChatId = id;
    save();
    openMiniChat(id);
    renderMiniChatBar();
    // Sem mensagem automática de propósito — o mini-chat abre em
    // silêncio, esperando o usuário falar primeiro.
}

function doF12Disable(chatId) {
    if (f12Target && f12TargetChatId === chatId && document.contains(f12Target)) {
        try {
            f12Target.click();
            addMsg('agent', '✅ Cliquei no interruptor original pra desligar. Se foi pro lado errado (ligou em vez de desligar), me avisa que eu clico de novo.', chatId);
        } catch (err) {
            addMsg('agent', '⚠️ Tentei clicar no elemento mas deu erro: ' + (err.message || err), chatId);
        }
    } else {
        addMsg('agent', '⚠️ Não tenho mais acesso àquele elemento (a página pode ter recarregado ou mudado). Aponta de novo com o 🎯 se ainda quiser desativar.', chatId);
    }
}

// ====================================
// TREINO DE VOZ — RAG de verdade (Ticket 1)
// Cada fala real vira {text, embedding, ts} em KEYS.VOICE.lines. A
// personalidade é um texto único que SUBSTITUI, nunca acumula.
// ====================================
async function processVoiceLines(text) {
    const re = /\[AXIS:VOICE_LINE\]([\s\S]*?)\[\/AXIS:VOICE_LINE\]/g;
    const matches = [...text.matchAll(re)];
    if (!matches.length) return text;
    const s = scope();
    if (!s[KEYS.VOICE]) s[KEYS.VOICE] = { lines: [], personality: '' };
    let result = text;
    for (const m of matches) {
        const line = m[1].trim();
        if (!line) { result = result.replace(m[0], ''); continue; }
        const embedding = await getEmbedding(line);
        s[KEYS.VOICE].lines.push({ text: line, embedding: embedding || null, ts: Date.now() });
        result = result.replace(m[0], '🎙️ _Fala guardada' + (embedding ? '' : ' (sem vetor de busca — embedding falhou, mas a fala não foi perdida)') + '._');
    }
    save();
    return result;
}

function processVoicePersonality(text) {
    const s = scope();
    if (!s[KEYS.VOICE]) s[KEYS.VOICE] = { lines: [], personality: '' };
    const re = /\[AXIS:VOICE_PERSONALITY\]([\s\S]*?)\[\/AXIS:VOICE_PERSONALITY\]/g;
    const result = text.replace(re, (_, raw) => {
        s[KEYS.VOICE].personality = raw.trim();
        return '🎙️ _Personalidade de fala atualizada._';
    });
    if (result !== text) save();
    return result;
}

// Retrieval em tempo real — roda a CADA geração real do RP (chamado de
// dentro de Spade_interceptGeneration), não só uma vez no fim do
// treino. Sem isso, o RAG só existiria em teoria.
async function applyVoiceRetrieval(recentText) {
    const s = scope();
    const voice = s[KEYS.VOICE];
    if (!voice || !voice.lines?.length) {
        iaSetExtensionPrompt('axis_voice_lines', '', 1, 1, false, 0);
        return;
    }
    const queryEmb = recentText ? await getEmbedding(recentText) : null;
    let top;
    if (queryEmb) {
        top = voice.lines
            .filter(l => l.embedding)
            .map(l => ({ ...l, score: cosineSim(queryEmb, l.embedding) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 6);
        if (!top.length) top = voice.lines.slice(-6); // nenhuma linha tinha embedding ainda
    } else {
        top = voice.lines.slice(-6); // fallback sem embedding: últimas 6
    }
    if (!top.length) return;
    const compiled = top.map(l => '- ' + l.text).join('\n');
    iaSetExtensionPrompt('axis_voice_lines',
        '[Exemplos reais de como o personagem fala, escolhidos por relevância pra essa cena — imite o TOM, não copie literalmente]\n\n' + compiled,
        1, 1, false, 0);
}

// Antes o modelo local só carregava quando a IA marcava a primeira fala
// com VOICE_LINE — se isso demorasse (ou nunca acontecesse), parecia que
// "não baixou nada". Agora dispara o carregamento assim que o treino
// abre, e AVISA no chat se deu certo ou falhou (nunca fica em silêncio).
let _embedderPreloadStarted = false;
function preloadEmbedder(chatId) {
    if (_embedderPreloadStarted) return;
    _embedderPreloadStarted = true;
    addMsg('agent', '⏳ _Carregando modelo de busca local (baixa ~23MB na primeira vez — só agora, depois fica em cache no navegador)..._', chatId);
    getEmbedder().then(extractor => {
        addMsg('agent', extractor
            ? '✅ _Modelo carregado. As falas de exemplo já entram por relevância._'
            : '⚠️ _Não consegui carregar o modelo local (sem internet nessa hora, ou o navegador bloqueou o CDN). As falas continuam sendo guardadas, só sem busca por similaridade — uso as últimas 6 como reserva._',
            chatId);
    });
}

function startVoiceTraining() {
    const s = scope();
    let mc = s[KEYS.MINI_CHATS]['training'];
    if (!mc) {
        mc = { msgs: [], name: '🎙️ Treino de Voz', isMini: true, parent: 'main', shelf: [] };
        s[KEYS.MINI_CHATS]['training'] = mc;
        s[KEYS.CHATS]['training'] = mc;
    }
    mc.trainingActive = true;
    save();
    openMiniChat('training');
    renderMiniChatBar();
    const charName = ctx.name2 || 'o personagem';
    const intro = mc.msgs.length === 0
        ? 'Bora treinar a fala de ' + charName + '. Me manda exemplos — pode colar falas, descrever o estilo, anexar um arquivo de texto (📎), ou tudo junto. Quando eu sentir que peguei o jeito, eu aviso e a gente fecha o treino.'
        : 'De volta ao treino de fala. Pode mandar mais exemplos, anexar arquivo (📎), ou pedir pra eu finalizar com o que já tenho na prateleira.';
    addMsg('agent', intro, 'training');
    preloadEmbedder('training');
}

// Ticket 1: não compila mais um "sistema" gigante com todas as falas
// dentro (chat.shelf crescia sem parar e diluía o contexto). Agora só
// a personalidade (curta, estática) vira promptText do sistema — as
// falas de exemplo ficam em KEYS.VOICE.lines e entram dinamicamente
// por relevância a cada geração real do RP (ver applyVoiceRetrieval).
function endVoiceTraining(chatId) {
    const s = scope();
    const mc = s[KEYS.CHATS][chatId];
    if (!mc) return;
    mc.trainingActive = false;
    const voice = s[KEYS.VOICE] || { lines: [], personality: '' };
    if (!voice.personality && !voice.lines.length) {
        addMsg('agent', 'Treino encerrado, mas não guardei personalidade nem falas de exemplo — não apliquei nada ao personagem. Pode treinar de novo quando tiver material.', chatId);
        save();
        renderMiniChatBar();
        return;
    }
    const sys = {
        name: 'Estilo de fala (treinado)',
        type: 'voice',
        description: 'Estilo de fala do personagem, aprendido diretamente com o usuário. As falas de exemplo (' + voice.lines.length + ') entram dinamicamente por relevância a cada cena — não ficam fixas aqui.',
        steps: [],
        promptText: voice.personality || 'Personagem tem um jeito de falar próprio, aprendido com exemplos reais — veja as falas de exemplo trazidas a cada cena.',
        enabled: true, createdAt: Date.now(),
    };
    const idx = s[KEYS.SYSTEMS].findIndex(x => x.type === 'voice' && x.name === sys.name);
    if (idx >= 0) s[KEYS.SYSTEMS][idx] = { ...sys, createdAt: s[KEYS.SYSTEMS][idx].createdAt };
    else s[KEYS.SYSTEMS].push(sys);
    save();
    applySystems();
    addMsg('agent', 'Treino encerrado. Guardei ' + voice.lines.length + ' fala(s) de exemplo pra busca por relevância' + (voice.personality ? ' e atualizei a personalidade de fala' : '') + ' — já deve responder assim no RP a partir de agora.', chatId);
    renderMiniChatBar();
}

// ====================================
// IA PREENCHE CAMPOS DO ST SOZINHA
// ====================================
function iaSetExtensionPrompt(key, text, position, depth, scan, role) {
    if (typeof ctx.setExtensionPrompt === 'function') {
        ctx.setExtensionPrompt(key, text, position, depth, scan, role);
        return true;
    }
    return false;
}

function applySystems() {
    const s = scope();
    const systems = (s[KEYS.SYSTEMS] || []).filter(sys => sys && sys.enabled !== false);
    if (!systems.length) {
        iaSetExtensionPrompt('axis_systems', '', 1, 1, false, 0);
        return;
    }
    const compiled = systems.map(sys => {
        const steps = sys.steps?.length ? '\nEtapas obrigatórias:\n' + sys.steps.map((st, i) => (i + 1) + '. ' + st).join('\n') : '';
        return '### ' + sys.name + ' [' + (sys.type || 'behavior') + ']\n' + (sys.promptText || sys.description || '') + steps;
    }).join('\n\n');
    iaSetExtensionPrompt('axis_systems', '[Sistemas do Spade — estas são instruções REAIS de comportamento]\n\n' + compiled, 1, 1, false, 0);
}

// Insere uma mensagem de verdade no chat do RP, com nome próprio —
// diferente de injetar no prompt, isso aparece como um falante
// separado de fato, usando a API oficial addOneMessage do ST.
function npcAvatarDataUri(name) {
    const letter = (name || '?').trim().charAt(0).toUpperCase();
    const hue = Array.from(name || '').reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="hsl(${hue},45%,28%)"/><text x="48" y="48" font-family="sans-serif" font-size="42" fill="#eceae7" text-anchor="middle" dominant-baseline="central">${letter}</text></svg>`;
    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
}

// ====================================
// POSTAR COMO O PERSONAGEM PRINCIPAL — EM TEMPO REAL
// O pedido mais importante de tudo: a partir do Espaço, o usuário pode
// pedir pra Spade mandar uma mensagem de verdade no RP, como se fosse
// a própria personagem digitando. Mostra "digitando..." por um
// instante (proporcional ao tamanho do texto) antes de postar, pra
// parecer real, não instantâneo.
// ====================================
async function postCharacterMessage(text) {
    try {
        if (RP_GENERATING) return { ok: false, reason: 'RP está gerando algo agora — espera terminar e pede de novo.' };
        if (typeof ctx.addOneMessage !== 'function' || !Array.isArray(ctx.chat)) {
            return { ok: false, reason: 'Essa versão do SillyTavern não expõe a API pra postar mensagem direto.' };
        }
        const charName = ctx.name2 || 'Personagem';
        showStatusPill(charName + ' está digitando...');
        const delay = Math.min(2800, 500 + text.length * 18);
        await new Promise(r => setTimeout(r, delay));

        const message = { name: charName, is_user: false, is_system: false, send_date: Date.now(), mes: text, extra: {} };
        ctx.chat.push(message);
        ctx.addOneMessage(message);
        if (typeof ctx.saveChat === 'function') ctx.saveChat();
        else if (typeof ctx.saveChatConditional === 'function') ctx.saveChatConditional();
        return { ok: true };
    } catch (e) {
        console.warn('[Spade] Falha ao postar mensagem no RP:', e);
        return { ok: false, reason: e.message || String(e) };
    }
}

// Extrai [AXIS:CHAR_SPEAK]texto[/AXIS:CHAR_SPEAK] e posta de verdade.
// Retorna o texto sem o marcador + uma confirmação honesta (deu certo
// ou não, nunca finge que postou se falhou).
async function processCharSpeak(text) {
    const re = /\[AXIS:CHAR_SPEAK\]([\s\S]*?)\[\/AXIS:CHAR_SPEAK\]/g;
    const matches = [...text.matchAll(re)];
    if (!matches.length) return text;
    let result = text;
    for (const m of matches) {
        const line = m[1].trim();
        const outcome = await postCharacterMessage(line);
        const note = outcome.ok
            ? '✅ _Mandei isso no RP agora._'
            : '⚠️ _Não consegui postar no RP: ' + outcome.reason + '_';
        result = result.replace(m[0], note);
    }
    return result;
}

// ====================================
// DIREÇÃO DE CENA (generate_interceptor)
// A parte mais delicada de tudo: intercepta a geração real do RP pra
// decidir se um NPC deve responder junto/antes/em vez do personagem
// principal. Usa a API oficial generate_interceptor do SillyTavern
// (documentada, não é hack). QUALQUER erro aqui cai no catch e deixa
// a geração normal seguir — nunca trava o RP por causa de um bug
// nosso. Tem um interruptor manual (Ferramentas → Direção de Cena)
// pra desligar isso na hora se algo se comportar estranho.
// ====================================
let pendingNpcFollowup = null;

async function generateNpcLine(npc, recentText) {
    try {
        const msgs = [{ role: 'system', content: `Você é o Spade, escrevendo a fala de ${npc.name} nessa cena — não é o personagem principal, é ${npc.name} mesmo, com a própria voz dela.

Quem é ${npc.name}: ${npc.description || ''} ${npc.notes || ''}
${npc.voiceNotes ? 'Como fala: ' + npc.voiceNotes : ''}
${npc.mood ? 'Humor atual: ' + npc.mood : ''}
${npc.relationship ? 'Relação com o personagem principal: ' + npc.relationship : ''}

Contexto recente da cena:
${recentText}

Escreva UMA fala/ação curta de ${npc.name} reagindo a esse momento. Só o texto dela, nada mais, sem prefixo de nome.` }];
        const resp = await generate(msgs, { maxTokens: 200 });
        return (resp || '').trim();
    } catch (_) { return null; }
}

async function Spade_interceptGeneration(chatArr, contextSize, abort, type) {
    try {
        if (type) return; // só age na geração normal — pula quiet/impersonate/regenerate/swipe
        const s = scope();
        const settings = s[KEYS.ALIVE];

        // Últimas mensagens do RP — usado tanto pelo RAG de voz (Ticket 1,
        // roda sempre) quanto pela decisão de direção de cena abaixo (só
        // roda se tiver elenco de apoio).
        const recentText = (Array.isArray(chatArr) && chatArr.length)
            ? chatArr.slice(-6).map(m => (m.name || '') + ': ' + (m.mes || '')).join('\n')
            : '';

        // Ticket 1 — RAG de verdade pro tom de voz: roda em TODA geração
        // real do RP, independente de ter elenco de apoio ou não.
        await applyVoiceRetrieval(recentText);

        if (settings.sceneDirection === false) return; // interruptor manual desligado
        const cast = s[KEYS.CAST] || [];
        if (!cast.length || !Array.isArray(chatArr) || !chatArr.length) return;

        // Só vale chamar a API de decisão se algum NPC foi mencionado —
        // evita custo em toda mensagem normal sem NPC envolvido.
        const mentioned = cast.filter(n => recentText.toLowerCase().includes(n.name.toLowerCase()));
        if (!mentioned.length) return;

        const charName = ctx.name2 || 'o personagem';
        const castLine = mentioned.map(n => n.name + (n.role ? ' (' + n.role + ')' : '')).join(', ');

        const msgs = [{ role: 'system', content: `Você é o Spade, dirigindo uma cena com múltiplos personagens. Além do usuário e de ${charName} (personagem principal), estão possivelmente presentes: ${castLine}.

Últimas mensagens:
${recentText}

Decida o que acontece NESSE turno. Responda APENAS com um JSON válido, sem nada mais, sem markdown:
{"charSpeaks": true, "npcSpeaks": null, "order": "char_first"}

Regras:
- Na maioria das vezes só ${charName} fala (charSpeaks:true, npcSpeaks:null) — isso é o padrão, só desvie se fizer sentido de verdade agora.
- Se o usuário claramente falou COM um NPC específico, esse NPC deve responder — geralmente "order":"npc_first".
- Se faz sentido os dois reagirem, ambos podem ser true, na ordem que fizer sentido pra cena.
- Se um NPC está presente mas só observando, não o inclua (npcSpeaks: null).
- charSpeaks só pode ser false se npcSpeaks NÃO for null — alguém sempre tem que responder.` }];

        const resp = await generate(msgs, { maxTokens: 150 });
        let decision;
        try { decision = JSON.parse((resp || '').trim().replace(/^```(json)?\s*|```$/g, '')); } catch (_) { return; }
        if (!decision || typeof decision !== 'object') return;

        const npcName = decision.npcSpeaks;
        const npc = npcName ? cast.find(n => n.name.toLowerCase() === String(npcName).toLowerCase()) : null;
        if (!npc) return; // ninguém especial pra fazer nada — segue o fluxo normal

        if (decision.order === 'npc_first') {
            const line = await generateNpcLine(npc, recentText);
            if (line) {
                insertNpcMessage(npc.name, line, chatArr, npc.photo);
                if (decision.charSpeaks === false) {
                    abort(true);
                    // O ST não dispara GENERATION_STOPPED/ENDED quando A GENTE
                    // aborta a geração aqui — sem isso o mutex e a flag do RP
                    // ficavam travados pra sempre, achando que ainda tinha
                    // algo gerando.
                    globalUnlock();
                    RP_GENERATING = false;
                    dotsIdle();
                }
            }
        } else if (decision.charSpeaks !== false) {
            // Personagem responde primeiro (fluxo nativo normal); o NPC
            // entra depois que a resposta dela terminar de verdade —
            // ver o listener de MESSAGE_RECEIVED mais abaixo.
            pendingNpcFollowup = { name: npc.name };
        }
    } catch (e) {
        console.warn('[Spade] Direção de cena falhou, seguindo geração normal:', e);
    }
}
globalThis.Spade_interceptGeneration = Spade_interceptGeneration;

function insertNpcMessage(name, text, chatArrayOverride, photo) {
    try {
        if (typeof ctx.addOneMessage !== 'function') return false;
        const targetChat = chatArrayOverride || ctx.chat;
        if (!Array.isArray(targetChat)) return false;
        const message = {
            name, is_user: false, is_system: false, send_date: Date.now(), mes: text, extra: {},
            force_avatar: photo || npcAvatarDataUri(name),
        };
        targetChat.push(message);
        ctx.addOneMessage(message);
        if (typeof ctx.saveChat === 'function') ctx.saveChat();
        else if (typeof ctx.saveChatConditional === 'function') ctx.saveChatConditional();
        return true;
    } catch (e) {
        console.warn('[Spade] Falha ao inserir mensagem do NPC:', e);
        return false;
    }
}

// Só deixa falar quem já está aprovado no elenco — evita o agente
// inventar um "falante" novo sem passar pela aprovação do usuário.
function processNpcSpeak(text) {
    const s = scope();
    const cast = s[KEYS.CAST] || [];
    const re = /\[AXIS:NPC_SPEAK\s+NAME:"([^"]+)"\]([\s\S]*?)\[\/AXIS:NPC_SPEAK\]/g;
    return text.replace(re, (_, name, content) => {
        const cleanName = name.trim();
        const cleanContent = content.trim();
        const known = cast.find(n => n.name.toLowerCase() === cleanName.toLowerCase());
        if (!known) {
            return '⚠️ _' + cleanName + ' ainda não está no elenco de apoio — proponho ele primeiro com [AXIS:NPC_PROPOSAL]._';
        }
        const ok = insertNpcMessage(known.name, cleanContent, null, known.photo);
        return ok
            ? '💬 _' + known.name + ' acabou de falar no RP._'
            : '⚠️ _Não consegui inserir a fala de ' + known.name + ' no RP agora._';
    });
}
// Elenco de apoio: NPCs secundários reutilizáveis que o personagem
// principal pode interpretar no RP sem o usuário precisar criar um
// card pra cada um. Fica numa chave separada, então convive com os
// sistemas sem um sobrescrever o outro.
function applyCast() {
    const s = scope();
    const cast = s[KEYS.CAST] || [];
    if (!cast.length) {
        iaSetExtensionPrompt('axis_cast', '', 1, 1, false, 0);
        return;
    }
    const compiled = cast.map(n => {
        let block = '### ' + n.name + (n.age ? ', ' + n.age : '') + (n.role ? ' — ' + n.role : '');
        if (n.tags?.length) block += ' [' + n.tags.join(', ') + ']';
        block += '\n' + (n.description || '');
        if (n.appearance) block += '\nAparência: ' + n.appearance;
        if (n.notes) block += '\nContexto: ' + n.notes;
        if (n.voiceNotes) block += '\nComo fala: ' + n.voiceNotes;
        if (n.relationship) block += '\nRelação atual com o personagem principal: ' + n.relationship;
        if (n.mood) {
            const moodAge = n.moodUpdatedAt ? Math.round((Date.now() - n.moodUpdatedAt) / 3600000) : null;
            const ageNote = moodAge === null ? '' : moodAge < 1 ? ' (agora há pouco)' : ' (de ~' + moodAge + 'h atrás — pode já ter mudado, humor não é fixo)';
            block += '\nHumor/estado atual: ' + n.mood + ageNote;
        }
        return block;
    }).join('\n\n');
    iaSetExtensionPrompt('axis_cast', '[Elenco de apoio — NPCs secundários que você (o personagem principal) pode interpretar quando fizer sentido na cena, mantendo consistência. Esses perfis evoluem com o tempo — trate como gente real, não como ficha estática]\n\n' + compiled, 1, 1, false, 0);
}

// ====================================
// IMERSÃO
// NPCs do elenco têm conversas próprias em segundo plano com o
// personagem principal — não é simulação por relógio (isso foi
// removido de propósito). É guiado pelo PROGRESSO do RP: a cada tanto
// de atividade real na história, um NPC pode puxar ela pra resolver
// algo da vida dela (um pedido, uma tarefa, um problema) — a mesma
// lógica de "a maioria das vezes é SILENCIO" do resto do Sistema Vivo.
// Isso nunca aparece como mensagem no RP. Fica guardado por NPC (a
// aba 📱 Celular mostra essas conversas) e um aviso ambiente mostra
// que ela tá ocupada com outra coisa.
// ====================================
function ensureThread(npc) {
    if (!Array.isArray(npc.thread)) npc.thread = [];
    return npc.thread;
}

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

async function maybeAdvanceImmersion(force) {
    if (isGlobalLocked() || isGenerating) return;
    const s = scope();
    const a = s[KEYS.ALIVE];
    if (!force) {
        a.msgsSinceImmersion = (a.msgsSinceImmersion || 0) + 1;
        if (a.msgsSinceImmersion < 15) { save(); return; }
        a.msgsSinceImmersion = 0;
        save();
    }

    const cast = s[KEYS.CAST] || [];
    const charName = ctx.name2 || 'o personagem';
    const castCtx = cast.length
        ? cast.map(n => '- ' + n.name + (n.role ? ' (' + n.role + ')' : '') + (n.relationship ? ' — relação: ' + n.relationship : '')).join('\n')
        : '(elenco vazio ainda)';

    try {
        const msgs = [{ role: 'system', content: `Você é o Spade. Isso é uma checagem de bastidor: ${charName} tem vida própria, e às vezes alguém do elenco de apoio puxa ela pra resolver algo — não é o usuário, é a vida dela mesma acontecendo.

Elenco atual:
${castCtx}

Se fizer sentido AGORA ter uma interação de bastidor (nem toda checagem precisa ter uma — a maioria das vezes não tem nada acontecendo), escolha UM NPC existente do elenco OU proponha um novo com [AXIS:NPC_PROPOSAL] se a história pedir alguém novo (um chefe, cliente, vizinho, etc — só se genuinamente fizer sentido agora).

Gere uma pequena troca (estilo mensagem de texto, 2 a 4 falas) entre esse NPC e ${charName}, onde o NPC traz algo real pra ela — um convite, um pedido, um problema, uma tarefa (ex: "pode ficar com meu cachorro?", "preciso de dinheiro emprestado", "termina esse projeto até amanhã"). Não são mensagens padronizadas — invente algo específico e coerente com quem é esse NPC. ${charName} responde na voz dela.

Formato OBRIGATÓRIO — a primeira linha diz o nome EXATO do NPC escolhido, depois uma linha por fala:
NOME_DO_NPC
NPC: fala do NPC
CHAR: resposta dela
(pode repetir NPC:/CHAR: mais vezes se fizer sentido)
${force ? '\nIsso é um teste manual — gere uma interação de qualquer forma, mesmo pequena, não responda SILENCIO dessa vez.' : `
Se não houver nada que valha a pena agora, responda EXATAMENTE: SILENCIO
Isso deve ser raro — a maioria das checagens não gera nada.`}` }];

        const resp = await generate(msgs, { maxTokens: 400 });
        let text = (resp || '').trim();
        if (!text || /^SILENCIO/i.test(text)) return;

        text = processNpcProposalsAuto(text);

        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        if (!lines.length) return;

        // Nome vem explícito na primeira linha — nada de adivinhar.
        const npcName = lines[0].replace(/^NOME_DO_NPC:?\s*/i, '').trim();
        const exchange = [];
        for (const line of lines.slice(1)) {
            const m = line.match(/^(NPC|CHAR):\s*(.+)$/i);
            if (m) exchange.push({ from: m[1].toUpperCase() === 'NPC' ? 'npc' : 'char', text: m[2].trim() });
        }
        if (!exchange.length || !npcName) return;

        const s2 = scope();
        const npc = (s2[KEYS.CAST] || []).find(n => n.name.toLowerCase() === npcName.toLowerCase());
        if (!npc) return; // nome não bateu com ninguém do elenco — não inventa, só ignora essa checagem
        const thread = ensureThread(npc);
        const ts = Date.now();
        exchange.forEach(e => thread.push({ from: e.from, text: e.text, ts }));
        if (thread.length > 200) npc.thread = thread.slice(-200);
        npc.lastThreadAt = ts;
        save();

        showStatusPill(charName + ' passando tempo com ' + npc.name + '...');
        const a2 = s2[KEYS.ALIVE];
        a2.ramblingLog.push({ ts, text: '📱 ' + npc.name + ' e ' + charName + ' trocaram mensagens em segundo plano — dá pra ver no Celular.' });
        if (a2.ramblingLog.length > 30) a2.ramblingLog = a2.ramblingLog.slice(-30);
        save();
        renderRamblingLog();
        if (document.getElementById('axis-phone-panel')) renderPhonePanel();
    } catch (_) { /* silencioso — background */ }
}

// Igual processNpcProposals, mas auto-aplica (sem aprovação) — usado
// só em fluxos de bastidor onde não faz sentido pedir confirmação,
// já que o ponto é acontecer sem o usuário estar olhando.
function processNpcProposalsAuto(text) {
    const s = scope();
    const re = /\[AXIS:NPC_PROPOSAL\]([\s\S]*?)\[\/AXIS:NPC_PROPOSAL\]/g;
    return text.replace(re, (_, raw) => {
        let p;
        try { p = JSON.parse(raw.trim()); } catch (_) { return ''; }
        const name = String(p.name || '').trim();
        if (!name) return '';
        const cast = s[KEYS.CAST];
        const existing = cast.find(n => n.name.toLowerCase() === name.toLowerCase());
        const npc = buildNpcObject(p, existing);
        if (existing) Object.assign(existing, npc);
        else cast.push(npc);
        save(); applyCast();
        return '';
    });
}


// ====================================
// AVALIAÇÃO DE APROVAÇÃO
// ====================================
function handleApproval(approveId, approved, chatId) {
    const s = scope();
    if (!s._resolved) s._resolved = {};
    const baseId = approveId.startsWith('reject_') ? approveId.replace('reject_', '') : approveId;
    s._resolved[baseId] = approved;
    save();
    if (!approved) return;
    if (baseId.startsWith('create_system_')) {
        const uid = baseId.replace('create_system_', '');
        const pending = s._pending?.[uid];
        if (pending) {
            s[KEYS.SYSTEMS].push(pending);
            delete s._pending[uid];
            save(); applySystems();
            addMsg('agent', '✅ Sistema "' + pending.name + '" criado e ativo no personagem.', chatId);
        }
    }
    if (baseId.startsWith('create_npc_')) {
        const uid = baseId.replace('create_npc_', '');
        const pending = s._pending?.[uid];
        if (pending) {
            s[KEYS.CAST].push(pending);
            delete s._pending[uid];
            save(); applyCast();
            addMsg('agent', '✅ "' + pending.name + '" entrou pro elenco de apoio — o personagem já pode interpretar ele no RP.', chatId);
        }
    }
}

// ====================================
// MINI-CHATS (criação manual pelo usuário) + PRATELEIRA/TREINO
// (o fluxo de treino em si é determinístico — veja startVoiceTraining)
// ====================================
function createMiniChat(name) {
    const s = scope();
    const id = 'mini_' + Date.now();
    const n = name || 'Mini-' + (Object.keys(s[KEYS.MINI_CHATS]).length + 1);
    s[KEYS.MINI_CHATS][id] = { msgs: [], name: n, isMini: true, parent: 'main' };
    s[KEYS.CHATS][id] = s[KEYS.MINI_CHATS][id];
    save();
    openMiniChat(id);
    renderMiniChatBar();
    return id;
}

function openMiniChat(id) {
    currentMiniChatId = id;
    renderChat();
    renderMiniChatBar();
}

function closeMiniChat() {
    currentMiniChatId = null;
    renderChat();
    renderMiniChatBar();
}

function renderMiniChatBar() {
    const bar = document.getElementById('axis-mini-chat-bar');
    if (!bar) return;
    const s = scope();
    const mcs = s[KEYS.MINI_CHATS] || {};
    const ids = Object.keys(mcs);
    let h = '';
    if (currentMiniChatId) h += '<span class="axis-mini-back" id="axis-mini-back">← Espaço</span>';
    for (const id of ids) {
        const mc = mcs[id];
        const dot = mc.trainingActive ? '<span class="axis-mini-training-dot"></span>' : '';
        h += '<span class="axis-mini-tab' + (id === currentMiniChatId ? ' axis-mini-active' : '') + '" data-id="' + id + '">' + dot + esc(mc.name) + '<button class="axis-mini-del" data-del="' + id + '" title="Apagar">✕</button></span>';
    }
    bar.innerHTML = h;
    bar.querySelector('#axis-mini-back')?.addEventListener('click', closeMiniChat);
    bar.querySelectorAll('.axis-mini-tab').forEach(t => t.addEventListener('click', (e) => {
        if (e.target.classList.contains('axis-mini-del')) return;
        openMiniChat(t.dataset.id);
    }));
    bar.querySelectorAll('.axis-mini-del').forEach(b => b.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteMiniChat(b.dataset.del);
    }));
}

function deleteMiniChat(id) {
    const s = scope();
    const mc = s[KEYS.MINI_CHATS][id];
    if (!mc) return;
    if (!confirm('Apagar "' + mc.name + '"? As conversas desse mini-chat somem pra sempre.')) return;
    delete s[KEYS.MINI_CHATS][id];
    delete s[KEYS.CHATS][id];
    if (currentMiniChatId === id) currentMiniChatId = null;
    save();
    renderMiniChatBar();
    renderChat();
}

function clearMainChat() {
    const s = scope();
    if (!confirm('Limpar toda a conversa principal do Espaço? Isso não apaga sistemas, elenco nem memória — só as mensagens.')) return;
    s[KEYS.CHATS].main.msgs = [];
    save();
    if (!currentMiniChatId) renderChat();
}

// ====================================
// CHAT
// ====================================
function addMsg(role, text, chatId) {
    const s = scope();
    const cid = chatId || 'main';
    if (!s[KEYS.CHATS][cid]) {
        s[KEYS.CHATS][cid] = { msgs: [], name: cid === 'main' ? 'Principal' : cid };
    }
    const chat = s[KEYS.CHATS][cid];
    chat.msgs.push({ role, text, ts: Date.now() });
    if (chat.msgs.length > 200) chat.msgs = chat.msgs.slice(-200);
    save();
    if (cid === 'main' || cid === currentMiniChatId) renderChat();
}

function buildHtml(text) {
    const blocks = [];
    const re = /\[AXIS:CARD\]\s*([\s\S]*?)\s*\[AXIS:CARD_END\]/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) blocks.push({ t: 'text', c: text.slice(last, m.index) });
        blocks.push({ t: 'card', c: m[1].trim() });
        last = m.index + m[0].length;
    }
    if (last < text.length) blocks.push({ t: 'text', c: text.slice(last) });

    const c = document.createElement('div');
    for (const b of blocks) {
        if (b.t === 'text') { const d = document.createElement('div'); d.innerHTML = markers(b.c); c.appendChild(d); }
        else {
            const e = document.createElement('div'); e.className = 'axis-card';
            const h2 = document.createElement('div'); h2.className = 'axis-card-header'; h2.textContent = '📄 Arquivo';
            const b2 = document.createElement('div'); b2.className = 'axis-card-body'; b2.innerHTML = markers(b.c); b2.style.display = 'none';
            h2.onclick = () => { b2.style.display = b2.style.display === 'none' ? 'block' : 'none'; h2.classList.toggle('axis-card-open'); };
            e.append(h2, b2); c.appendChild(e);
        }
    }
    const s = scope();
    const res = s._resolved || {};
    return c.innerHTML.replace(
        /\[AXIS:APPROVAL\s+ID:"([^"]+)"\s+LABEL:"([^"]+)"\]/g,
        (_, id, label) => res.hasOwnProperty(id)
            ? '<div class="axis-approval axis-approval-resolved"><span class="axis-approval-label">' + (res[id] ? '✅ Aprovado' : '❌ Recusado') + ' — ' + esc(label) + '</span></div>'
            : '<div class="axis-approval" data-approval-id="' + id + '"><span class="axis-approval-label">⚠️ ' + esc(label) + '</span><button class="axis-approval-yes" data-approve="' + id + '">Sim</button><button class="axis-approval-no" data-approve="reject_' + id + '">Não</button></div>'
    );
}

function renderChat() {
    if (!chatArea) return;
    const s = scope();
    const cid = currentMiniChatId || 'main';
    const chat = s[KEYS.CHATS][cid];

    const banner = document.getElementById('axis-training-banner');
    if (banner) banner.style.display = (chat && chat.trainingActive) ? 'flex' : 'none';
    renderShelf(cid);

    if (!chat || !chat.msgs.length) {
        chatArea.innerHTML = '<p class="axis-empty">Fale com o Spade sobre o personagem.</p>';
        return;
    }
    chatArea.innerHTML = chat.msgs.map(m =>
        '<div class="axis-msg ' + (m.role === 'user' ? 'axis-msg-user' : 'axis-msg-agent') + '">' + buildHtml(m.text) + '</div>'
    ).join('');
    chatArea.scrollTop = chatArea.scrollHeight;
    listenApprovals();
}

function renderShelf(chatId) {
    const strip = document.getElementById('axis-shelf-strip');
    if (!strip) return;
    const s = scope();
    const chat = s[KEYS.CHATS][chatId];
    const shelf = (chat && chat.shelf) || [];
    if (!shelf.length) { strip.style.display = 'none'; strip.innerHTML = ''; return; }
    strip.style.display = 'flex';
    strip.innerHTML = shelf.map((it, i) =>
        '<div class="axis-shelf-item" data-idx="' + i + '" title="' + esc(it.content).replace(/"/g, '&quot;') + '">📎 ' + esc(it.title) + '</div>'
    ).join('');
    strip.querySelectorAll('.axis-shelf-item').forEach(el => {
        el.addEventListener('click', () => {
            const idx = Number(el.dataset.idx);
            const item = shelf[idx];
            if (!item) return;
            const expanded = el.classList.toggle('axis-shelf-expanded');
            el.textContent = expanded ? ('📎 ' + item.title + ': ' + item.content) : ('📎 ' + item.title);
        });
    });
}

function listenApprovals(container, fixedChatId) {
    const el = container || chatArea;
    if (!el) return;
    el.querySelectorAll('.axis-approval-yes').forEach(b => {
        if (b.dataset.l) return; b.dataset.l = '1';
        b.addEventListener('click', e => {
            const id = e.target.dataset.approve;
            e.target.closest('.axis-approval').innerHTML = '<span class="axis-approval-label">✅ Aprovado</span>';
            handleApproval(id, true, fixedChatId || currentMiniChatId || 'main');
        });
    });
    el.querySelectorAll('.axis-approval-no').forEach(b => {
        if (b.dataset.l) return; b.dataset.l = '1';
        b.addEventListener('click', e => {
            const id = e.target.dataset.approve;
            e.target.closest('.axis-approval').innerHTML = '<span class="axis-approval-label">❌ Rejeitado</span>';
            handleApproval(id, false, fixedChatId || currentMiniChatId || 'main');
        });
    });
}

// ====================================
// ENVIAR MENSAGEM (MUTEX + INTERRUPÇÃO)
// ====================================
// ====================================
// ANEXAR ARQUIVO (Ticket 3)
// Sem upload de verdade pra nenhum servidor — só lê o arquivo local no
// navegador (FileReader) e concatena o conteúdo no textarea, antes do
// usuário mandar. Só arquivos de texto reconhecidos (.txt/.md/.csv/.json/
// .log ou MIME text/*): PDF/DOCX/imagem não têm texto extraível aqui sem
// lib nova, então avisa em vez de fingir que leu.
// ====================================
const TEXT_FILE_RE = /\.(txt|md|csv|json|log|yaml|yml)$/i;
const MAX_CHARS_PER_FILE = 40000;

function handleFileAttach(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    let pending = files.length;
    const readable = [];
    const unsupported = [];

    files.forEach(file => {
        const isText = (file.type && file.type.startsWith('text/')) || file.type === 'application/json' || TEXT_FILE_RE.test(file.name);
        if (!isText) {
            unsupported.push(file.name);
            pending--;
            if (pending === 0) finish();
            return;
        }
        const reader = new FileReader();
        reader.onload = e => {
            let content = String(e.target.result || '');
            let truncated = false;
            if (content.length > MAX_CHARS_PER_FILE) { content = content.slice(0, MAX_CHARS_PER_FILE); truncated = true; }
            readable.push({ name: file.name, content, truncated });
            pending--;
            if (pending === 0) finish();
        };
        reader.onerror = () => {
            unsupported.push(file.name + ' (erro ao ler)');
            pending--;
            if (pending === 0) finish();
        };
        reader.readAsText(file);
    });

    function finish() {
        if (readable.length) {
            const blocks = readable.map(f => '===== ' + f.name + (f.truncated ? ' (cortado, muito grande)' : '') + ' =====\n' + f.content).join('\n\n');
            input.value = (input.value ? input.value + '\n\n' : '') + blocks;
        }
        if (unsupported.length) {
            addMsg('agent', '⚠️ Não consigo ler ainda: ' + unsupported.join(', ') + ' — manda como texto colado (PDF/imagem ainda não têm leitor aqui).', currentMiniChatId || 'main');
        }
        input.focus();
    }
}

async function sendMessage() {
    if (isGenerating) return;
    const text = input.value.trim();
    if (!text) return;

    const chatId = currentMiniChatId || 'main';

    // Se a IA está gerando no RP, INTERROMPE
    if (isGlobalLocked()) {
        requestInterrupt('Usuário digitou no Espaço', () => sendMessage());
        return;
    }

    input.value = '';
    addMsg('user', text, chatId);
    isGenerating = true; sendBtn.disabled = true;
    globalLock();
    dotsReading();

    try {
        const fullCtx = buildFullContext();
        const s = scope();
        const chat = s[KEYS.CHATS][chatId];
        const recent = chat.msgs.slice(-30);
        const charName = ctx.name2 || 'o personagem';

        const isTraining = !!chat.trainingActive;
        const isF12 = !!chat.f12;
        const shelfCtx = (chat.shelf && chat.shelf.length)
            ? '\n\n===== PRATELEIRA DESTE CHAT =====\n' + chat.shelf.map(it => '- ' + it.title + ': ' + it.content).join('\n')
            : '';

        let systemContent;
        if (isTraining) {
            systemContent = `Você é o Spade. Você está numa sessão de TREINO DE FALA para o personagem "${charName}". Você não é ${charName} — você está analisando e aprendendo o jeito dela falar a partir do que o usuário te mandar (texto colado, descrições de estilo, trechos de diálogo).

O que fazer:
1. Quando o usuário mandar uma fala de exemplo REAL (o diálogo isolado, não um resumo), guarde com: [AXIS:VOICE_LINE]a fala, só o diálogo[/AXIS:VOICE_LINE] — pode incluir várias na mesma resposta se ele mandou vários exemplos de uma vez.
2. Quando sentir que consegue descrever o TOM/personalidade de fala dela de forma condensada e estática, guarde/atualize com: [AXIS:VOICE_PERSONALITY]descrição curta do tom de voz[/AXIS:VOICE_PERSONALITY] — isso SUBSTITUI a descrição anterior inteira (não acumula), então sempre escreva ela completa de novo.
3. Pode narrar seu raciocínio com [AXIS:THINK] no meio da resposta.
4. Quando sentir que já tem exemplos suficientes pra capturar o tom de voz de verdade, pergunte se o usuário quer finalizar. Se ele confirmar, inclua [AXIS:END_TRAINING] na resposta — isso aplica o treino de verdade ao personagem (as falas guardadas entram por relevância a cada cena real do RP; a personalidade fica fixa no prompt).

Nunca fale COMO ${charName} neste chat. Fale sempre na sua própria voz, comentando sobre o estilo dela.
${fullCtx}`;
        } else if (isF12) {
            const info = chat.elementInfo || {};
            systemContent = `Você é o Spade, no modo "Substituir" (F12). O usuário apontou para um elemento real da interface do SillyTavern e quer discutir o que fazer com ele.

Elemento apontado: "${info.label || 'desconhecido'}" (tag <${info.tag || '?'}>)
${info.isToggle ? 'Esse elemento É um interruptor/checkbox real — você PODE desativá-lo de verdade.' : 'Esse elemento NÃO é um interruptor simples — você NÃO consegue desligá-lo diretamente, seja honesto sobre isso.'}
${info.childControls?.length ? '\nControles que existem DENTRO desse elemento (o que apareceria se abrisse): ' + info.childControls.join(', ') : ''}
${info.hiddenNearby ? '\nConteúdo escondido perto dele que provavelmente aparece ao clicar: "' + info.hiddenNearby + '"' : ''}
${info.outerHtml ? '\nHTML real do elemento (referência técnica, não repita isso pro usuário):\n' + info.outerHtml : ''}

O que você pode fazer de verdade (nunca prometa o que o código não sabe executar):
1. Conversar com o usuário pra entender o que ele quer no lugar daquilo — use os controles/conteúdo escondido acima pra entender o que realmente existe ali, não só o rótulo de fora.
2. Propor um SISTEMA que substitua o EFEITO desse elemento na prática, do jeito que o usuário descrever — use [AXIS:SYSTEM_PROPOSAL] normalmente. Isso não edita o SillyTavern, é uma instrução que passa a valer pro personagem através do Spade.
3. Se (e só se) o elemento for realmente um interruptor real E o usuário pedir pra desativar, inclua [AXIS:F12_DISABLE] na resposta — o código clica no elemento de verdade pra desligar. Se não for um interruptor, não inclua esse marcador — explique que não dá.

${shelfCtx}
${fullCtx}`;
        } else {
            systemContent = `Você é o Spade, um assistente que ajuda a configurar, observar e treinar o personagem "${charName}" dentro do SillyTavern.

IMPORTANTE: você não é ${charName}. Neste chat (o Espaço) você fala sempre na sua própria voz, sobre o personagem — nunca como se fosse ela. Quem interpreta ${charName} de verdade é o próprio SillyTavern no RP principal, usando os sistemas que você configura.

O QUE VOCÊ REALMENTE FAZ (só proponha o que o código abaixo sabe executar — nunca narre uma ação que não existe):
1. Sistemas/engines de comportamento — ativos, mudam a resposta do personagem no RP de verdade, precisam aprovação do usuário. Use quando algo deve mudar como ela se comporta: forma de pensar/raciocínio interno, humor, relacionamento, ritmo de slow burn, memória de longo prazo, mecânica de RP, etc. Tipos possíveis: thinking, mechanic, behavior, memory, mood, relationship, slowburn, voice, custom.
2. Prateleira — só informação/referência guardada, sem mudar comportamento, sem precisar aprovação. Use quando for uma nota, ideia, rascunho ou dado que vale guardar mas não precisa virar regra ativa agora.
3. Elenco de apoio — NPCs secundários reutilizáveis (a atendente do bar, o rival, etc.) que o personagem principal pode interpretar no RP com consistência, sem o usuário precisar criar um card novo. Proponha quando fizer sentido pra história ter um personagem de apoio recorrente.
4. Fazer um NPC do elenco falar DE VERDADE no RP — não narrado pelo personagem principal, mas como uma entrada própria no chat, com o nome dele. Só funciona pra NPCs já aprovados no elenco. Use quando o usuário pedir pra um NPC específico aparecer/falar agora.
5. Se o usuário pedir pra TREINAR A FALA/VOZ/JEITO DE FALAR do personagem, não proponha um sistema na hora — responda confirmando brevemente e inclua [AXIS:START_TRAINING]. O código abre automaticamente um mini-chat dedicado de treino.

Um sistema de verdade é desenvolvido, não uma frase vaga. Ele tem: tipo, 3-6 etapas concretas, e um promptText completo (a instrução real que vai afetar o personagem).

AVISO IMPORTANTE pra sistemas do tipo "thinking": alguns modelos (GLM, DeepSeek-R1, Qwen com thinking, etc) já têm um canal de raciocínio PRÓPRIO e nativo, separado da resposta. Se o promptText desse tipo de sistema instruir o personagem a "escrever"/"narrar" o raciocínio como parte da resposta visível, isso compete com esse canal nativo e pode vazar pensamento pra resposta final de forma bagunçada. Em vez disso, escreva sistemas de "thinking" como uma descrição de COMO a personagem deveria chegar nas conclusões dela (prioridades, o que ela nota primeiro, o que pesa mais) — não como uma instrução pra ela expor esse processo por escrito.

Formato de sistema:
[AXIS:SYSTEM_PROPOSAL]
{"name":"Nome","type":"behavior","description":"resumo","steps":["Etapa 1","Etapa 2","Etapa 3"],"promptText":"Instrução completa aqui."}
[/AXIS:SYSTEM_PROPOSAL]

Formato de prateleira:
[AXIS:SHELF_ADD TITLE:"título curto"]conteúdo a guardar[/AXIS:SHELF_ADD]

Formato de NPC pro elenco de apoio (nem todo campo precisa vir preenchido, mas preencha o que fizer sentido):
[AXIS:NPC_PROPOSAL]
{"name":"Nome","age":"idade","appearance":"aparência física","role":"o que ele é/faz","tags":["amiga","colega rival"],"description":"personalidade, quem é","notes":"contexto informal — história, onde mora, o que quiser explicar sobre ela","voiceNotes":"como fala, maneirismos","relationship":"relação atual com o personagem principal","mood":"humor atual — escreva como gente de verdade, nunca uma palavra só tipo 'feliz' ou uma nota numérica. Descreva nuance e o motivo, ex: 'meio irritada desde a reunião de hoje, mas tentando não descontar em ninguém' ou 'inesperadamente animada, sem motivo aparente'"}
[/AXIS:NPC_PROPOSAL]
Esse mesmo formato serve pra propor um NPC novo OU atualizar um já existente (repita o nome exato — os campos preenchidos substituem os antigos, o resto continua igual). Use isso pra deixar os NPCs evoluindo ao longo do RP: personalidade amadurecendo, relação mudando, humor variando de verdade (humor muda de uma hora pra outra às vezes, sem motivo grande — não precisa de justificativa toda vez, gente é assim).

Formato pra fazer um NPC do elenco falar de verdade no RP agora (só funciona se ele já estiver aprovado):
[AXIS:NPC_SPEAK NAME:"Nome exato do NPC"]o que ele diz, na voz dele[/AXIS:NPC_SPEAK]

Formato pra VOCÊ (como o personagem principal, ${charName}) mandar uma mensagem de verdade no RP agora — use quando o usuário pedir explicitamente isso (ex: "manda um oi pra ele", "fala isso lá no RP"). Isso realmente posta no chat do RP, de verdade, não é encenação:
[AXIS:CHAR_SPEAK]a fala exata de ${charName}, na voz dela e coerente com os sistemas ativos[/AXIS:CHAR_SPEAK]
${shelfCtx}
${fullCtx}`;
        }

        const msgs = [{ role: 'system', content: systemContent }];
        for (const m of recent) {
            msgs.push({ role: m.role === 'agent' ? 'assistant' : m.role, content: m.text });
        }

        let resp = await generate(msgs, { maxTokens: 800 });

        // Marcadores de treino/f12 (checados antes dos outros, viram ação de código)
        const wantsStartTraining = resp.includes(TAGS.START_TRAINING);
        const wantsEndTraining = resp.includes(TAGS.END_TRAINING);
        const wantsF12Disable = resp.includes(TAGS.F12_DISABLE);
        resp = resp.split(TAGS.START_TRAINING).join('').split(TAGS.END_TRAINING).join('').split(TAGS.F12_DISABLE).join('');

        if (isTraining) {
            resp = await processVoiceLines(resp);
            resp = processVoicePersonality(resp);
        } else {
            resp = processShelfAdds(resp, chatId);
        }
        resp = processNpcProposals(resp);
        resp = processNpcSpeak(resp);
        resp = await processCharSpeak(resp);
        const processed = processSystemProposals(resp);
        addMsg('agent', processed, chatId);

        if (wantsStartTraining && !isTraining) startVoiceTraining();
        if (wantsEndTraining && isTraining) endVoiceTraining(chatId);
        if (wantsF12Disable && isF12) doF12Disable(chatId);

        analyzeUser();
    } catch (e) {
        addMsg('agent', 'Erro: ' + (e.message || e), chatId);
        dotsError();
        setTimeout(dotsIdle, 2000);
    } finally {
        isGenerating = false; sendBtn.disabled = false;
        globalUnlock();
        dotsIdle();
        input.focus();
    }
    // Fica FORA do try/finally de propósito: maybeRamble() olha isGenerating,
    // e só nesse ponto ele já voltou a ser false.
    maybeRamble('espaco');
}

// ====================================
// PAINEL
// ====================================
function createPanel() {
    if (document.getElementById('axis-espaco-panel')) return;
    panel = document.createElement('div');
    panel.id = 'axis-espaco-panel';
    panel.className = 'axis-espaco-panel';
    panel.innerHTML =
        '<div class="axis-espaco-header" id="axis-espaco-drag-handle">' +
        '<span class="axis-espaco-title">Spade</span>' +
        '<div class="axis-status-dots">' +
        '<span class="axis-dot axis-dot-idle" id="axis-dot-reading" title="Processando"></span>' +
        '<span class="axis-dot axis-dot-idle" id="axis-dot-writing" title="Escrevendo RP"></span>' +
        '<span class="axis-dot axis-dot-idle" id="axis-dot-thinking" title="Analisando"></span>' +
        '</div>' +
        '<div class="axis-espaco-header-actions">' +
        '<button id="axis-btn-mini" class="axis-btn" title="Novo Mini-Chat">+Mini</button>' +
        '<button id="axis-btn-systems" class="axis-btn" title="Sistemas">⚙</button>' +
        '<button id="axis-btn-tools" class="axis-btn" title="Ferramentas">🛠</button>' +
        '<button id="axis-btn-f12" class="axis-btn" title="Modo Substituir — aponte pra qualquer coisa do SillyTavern">🎯</button>' +
        '<button id="axis-btn-phone" class="axis-btn" title="Celular — conversas do elenco em segundo plano">📱</button>' +
        '<button id="axis-btn-maximize" class="axis-btn" title="Aumentar">⛶</button>' +
        '<button id="axis-btn-minimize" class="axis-btn" title="Minimizar">─</button>' +
        '<button id="axis-btn-toggle" class="axis-btn axis-btn-close">✕</button>' +
        '</div></div>' +
        '<div class="axis-alive-bar" id="axis-alive-bar"></div>' +
        '<div class="axis-rambling-log" id="axis-rambling-log"></div>' +
        '<div id="axis-training-banner" class="axis-training-banner" style="display:none;">🔴 Treinando fala — a IA está aprendendo o estilo do personagem</div>' +
        '<div class="axis-espaco-body">' +
        '<div id="axis-shelf-strip" class="axis-shelf-strip" style="display:none;"></div>' +
        '<div id="axis-espaco-chat" class="axis-espaco-chat"></div>' +
        '<div id="axis-mini-chat-bar" class="axis-mini-chat-bar"></div>' +
        '</div>' +
        '<div class="axis-espaco-footer">' +
        '<input type="file" id="axis-file-input" style="display:none" multiple accept=".txt,.md,.csv,.json,.log,text/plain,text/markdown,text/csv,application/json">' +
        '<button id="axis-btn-attach" class="axis-btn" title="Anexar arquivo de texto (.txt, .md, .csv, .json)">📎</button>' +
        '<textarea id="axis-espaco-input" class="axis-espaco-input" rows="2" placeholder="Fale com a IA..."></textarea>' +
        '<button id="axis-espaco-send" class="axis-btn axis-btn-send">Enviar</button>' +
        '</div>' +
        '<div id="axis-resize-handle" title="Redimensionar"></div>';
    document.body.appendChild(panel);

    chatArea = document.getElementById('axis-espaco-chat');
    input    = document.getElementById('axis-espaco-input');
    sendBtn  = document.getElementById('axis-espaco-send');
    aliveBar = document.getElementById('axis-alive-bar');
    ramblingLog = document.getElementById('axis-rambling-log');
    dotReading = document.getElementById('axis-dot-reading');
    dotWriting = document.getElementById('axis-dot-writing');
    dotThinking = document.getElementById('axis-dot-thinking');

    document.getElementById('axis-btn-toggle').addEventListener('click', () => togglePanel(false));
    document.getElementById('axis-btn-minimize').addEventListener('click', minimizePanel);
    document.getElementById('axis-btn-maximize').addEventListener('click', toggleMaximize);
    document.getElementById('axis-btn-mini').addEventListener('click', () => createMiniChat());
    document.getElementById('axis-btn-systems').addEventListener('click', toggleSystemsPanel);
    document.getElementById('axis-btn-tools').addEventListener('click', toggleToolsPanel);
    document.getElementById('axis-btn-f12').addEventListener('click', toggleF12Mode);
    document.getElementById('axis-btn-phone').addEventListener('click', togglePhonePanel);
    sendBtn.addEventListener('click', sendMessage);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

    const fileInput = document.getElementById('axis-file-input');
    document.getElementById('axis-btn-attach').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { handleFileAttach(fileInput.files); fileInput.value = ''; });

    setupDrag(panel, document.getElementById('axis-espaco-drag-handle'));
    setupResize(panel, document.getElementById('axis-resize-handle'));

    const tb = document.createElement('button');
    tb.id = 'axis-toggle-btn'; tb.className = 'axis-toggle-btn'; tb.innerHTML = 'S'; tb.title = 'Spade';
    tb.addEventListener('click', () => togglePanel());
    document.body.appendChild(tb);

    if (localStorage.getItem('axis_visible') !== 'false') {
        panel.classList.add('axis-visible'); tb.classList.add('axis-active');
    }

    renderChat(); renderMiniChatBar(); updateAliveBar(); scheduleAlive();
}

// ====================================
// DRAG / RESIZE / TOGGLE / MINIMIZE / MAXIMIZE
// ====================================
function setupDrag(el, handle) {
    let d = false, sx, sy, il, it;
    function start(cx, cy, t) { if (t.closest('.axis-espaco-header-actions, .axis-status-dots')) return false; d = true; sx = cx; sy = cy; const r = el.getBoundingClientRect(); il = r.left; it = r.top; el.style.transition = 'none'; document.body.style.userSelect = 'none'; return true; }
    function move(cx, cy) { if (!d) return; el.style.left = (il + cx - sx) + 'px'; el.style.top = (it + cy - sy) + 'px'; el.style.transform = 'none'; }
    function end() { if (!d) return; d = false; el.style.transition = ''; document.body.style.userSelect = ''; }
    handle.addEventListener('mousedown', e => start(e.clientX, e.clientY, e.target));
    document.addEventListener('mousemove', e => move(e.clientX, e.clientY));
    document.addEventListener('mouseup', end);
    handle.addEventListener('touchstart', e => { const t = e.touches[0]; if (start(t.clientX, t.clientY, e.target)) e.preventDefault(); }, {passive:false});
    document.addEventListener('touchmove', e => { if (!d) return; move(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }, {passive:false});
    document.addEventListener('touchend', end); document.addEventListener('touchcancel', end);
}

function setupResize(el, handle) {
    let d = false, sx, sy, iw, ih; const MW = 300, MH = 280;
    function start(cx, cy) { if (el.classList.contains('axis-maximized')) return false; d = true; sx = cx; sy = cy; const r = el.getBoundingClientRect(); iw = r.width; ih = r.height; el.style.transition = 'none'; document.body.style.userSelect = 'none'; return true; }
    function move(cx, cy) { if (!d) return; el.style.width = Math.max(MW, Math.min(window.innerWidth * 0.96, iw + cx - sx)) + 'px'; el.style.height = Math.max(MH, Math.min(window.innerHeight * 0.96, ih + cy - sy)) + 'px'; }
    function end() { if (!d) return; d = false; el.style.transition = ''; document.body.style.userSelect = ''; }
    handle.addEventListener('mousedown', e => { if (start(e.clientX, e.clientY)) e.preventDefault(); });
    document.addEventListener('mousemove', e => move(e.clientX, e.clientY)); document.addEventListener('mouseup', end);
    handle.addEventListener('touchstart', e => { const t = e.touches[0]; if (start(t.clientX, t.clientY)) e.preventDefault(); }, {passive:false});
    document.addEventListener('touchmove', e => { if (!d) return; move(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }, {passive:false});
    document.addEventListener('touchend', end); document.addEventListener('touchcancel', end);
}

function togglePanel(force) {
    if (!panel) return;
    const v = panel.classList.contains('axis-visible');
    if (force === false || v) { panel.classList.remove('axis-visible'); const b = document.getElementById('axis-toggle-btn'); if (b) b.classList.remove('axis-active'); localStorage.setItem('axis_visible', 'false'); }
    else { panel.classList.add('axis-visible'); const b = document.getElementById('axis-toggle-btn'); if (b) b.classList.add('axis-active'); renderChat(); renderMiniChatBar(); localStorage.setItem('axis_visible', 'true'); }
}

function minimizePanel() {
    if (!panel) return;
    const bd = panel.querySelector('.axis-espaco-body'), ft = panel.querySelector('.axis-espaco-footer');
    const ab = document.getElementById('axis-alive-bar'), rl = document.getElementById('axis-rambling-log');
    const isMin = bd.style.display === 'none';
    bd.style.display = isMin ? '' : 'none'; ft.style.display = isMin ? '' : 'none';
    if (ab) ab.style.display = isMin ? '' : 'none';
    if (rl) rl.style.display = isMin ? '' : 'none';
    const btn = document.getElementById('axis-btn-minimize');
    if (btn) btn.textContent = isMin ? '─' : '□';
}

let savedRect = null;
function toggleMaximize() {
    if (!panel) return;
    const isMax = panel.classList.contains('axis-maximized');
    const btn = document.getElementById('axis-btn-maximize');
    if (!isMax) {
        const r = panel.getBoundingClientRect();
        savedRect = { w: panel.style.width || r.width + 'px', h: panel.style.height || r.height + 'px', t: panel.style.top || r.top + 'px', l: panel.style.left || r.left + 'px', tr: panel.style.transform || '' };
        panel.classList.add('axis-maximized');
        panel.style.width = ''; panel.style.height = ''; panel.style.top = ''; panel.style.left = ''; panel.style.transform = '';
        if (btn) { btn.textContent = '❐'; btn.title = 'Restaurar'; }
    } else {
        panel.classList.remove('axis-maximized');
        if (savedRect) { panel.style.width = savedRect.w; panel.style.height = savedRect.h; panel.style.top = savedRect.t; panel.style.left = savedRect.l; panel.style.transform = savedRect.tr; }
        if (btn) { btn.textContent = '⛶'; btn.title = 'Aumentar'; }
    }
}

// ====================================
// PAINEL DE SISTEMAS
// ====================================
function toggleSystemsPanel() {
    const ex = document.getElementById('axis-systems-panel');
    if (ex) { ex.remove(); return; }
    const s = scope();
    const systems = s[KEYS.SYSTEMS] || [];
    const p = document.createElement('div');
    p.id = 'axis-systems-panel'; p.className = 'axis-systems-panel';
    p.innerHTML =
        '<div class="axis-systems-header"><span>Sistemas</span><button class="axis-btn axis-btn-close" id="axis-systems-close">✕</button></div>' +
        '<div class="axis-systems-body">' + (systems.length ? systems.map((sys, i) =>
            '<div class="axis-system-item">' +
            '<div class="axis-system-name">' + esc(sys.name) + ' <small>[' + (sys.type || 'behavior') + ']</small></div>' +
            '<div class="axis-system-desc">' + esc(sys.description || '') + '</div>' +
            (sys.steps?.length ? '<div class="axis-system-desc">Etapas: ' + sys.steps.map(st => esc(st)).join(' → ') + '</div>' : '') +
            '<button class="axis-btn axis-btn-sm axis-system-delete" data-idx="' + i + '">Remover</button></div>'
        ).join('') : '<p class="axis-empty">Nenhum sistema criado.</p>') + '</div>';
    panel.appendChild(p);
    document.getElementById('axis-systems-close').addEventListener('click', () => p.remove());
    p.querySelectorAll('.axis-system-delete').forEach(b => b.addEventListener('click', e => {
        const idx = parseInt(e.target.dataset.idx);
        s[KEYS.SYSTEMS].splice(idx, 1); save(); p.remove(); toggleSystemsPanel(); applySystems();
    }));
}

// ====================================
// PAINEL DE FERRAMENTAS
// ====================================
function toggleToolsPanel() {
    const ex = document.getElementById('axis-tools-panel');
    if (ex) { ex.remove(); return; }
    const p = document.createElement('div');
    p.id = 'axis-tools-panel'; p.className = 'axis-tools-panel';
    p.innerHTML =
        '<div class="axis-tools-header"><span>Ferramentas</span><button class="axis-btn axis-btn-close" id="axis-tools-close">✕</button></div>' +
        '<div class="axis-tools-body">' +
        '<div class="axis-tool-section">REGISTROS</div>' +
        '<button class="axis-tool-item" id="axis-tool-snapshot">📸 Snapshot do Personagem</button>' +
        '<button class="axis-tool-item" id="axis-tool-snapshot-list">📋 Listar Snapshots</button>' +
        '<button class="axis-tool-item" id="axis-tool-diary">📔 Gerar Diário</button>' +
        '<button class="axis-tool-item" id="axis-tool-diary-list">📖 Ver Diário</button>' +
        '<div class="axis-tool-section">ELENCO & IMERSÃO</div>' +
        '<button class="axis-tool-item" id="axis-tool-crossover">🔗 Conectar Personagens</button>' +
        '<button class="axis-tool-item" id="axis-tool-cast-list">👥 Ver Elenco de Apoio</button>' +
        '<button class="axis-tool-item" id="axis-tool-immersion-test">🎭 Forçar Checagem de Imersão (teste)</button>' +
        '<button class="axis-tool-item" id="axis-tool-scene-toggle">🎬 Direção de Cena: ' + (scope()[KEYS.ALIVE].sceneDirection === false ? 'DESLIGADA' : 'ligada') + '</button>' +
        '<div class="axis-tool-section">CHAT / WORKSPACE</div>' +
        '<button class="axis-tool-item" id="axis-tool-unlock">🔓 Destravar (se travar sem motivo)</button>' +
        '<button class="axis-tool-item" id="axis-tool-clear-main">🧹 Limpar Conversa Principal</button>' +
        '<button class="axis-tool-item" id="axis-tool-connect">🔗 Conectar com Outro Chat</button>' +
        '<div class="axis-tool-section">RECEITA</div>' +
        '<button class="axis-tool-item" id="axis-tool-export">📦 Exportar Receita</button>' +
        '<button class="axis-tool-item" id="axis-tool-import">📥 Importar Receita</button>' +
        '</div>';
    panel.appendChild(p);
    document.getElementById('axis-tools-close').addEventListener('click', () => p.remove());
    document.getElementById('axis-tool-snapshot').addEventListener('click', () => { p.remove(); createSnapshot(); });
    document.getElementById('axis-tool-snapshot-list').addEventListener('click', () => { p.remove(); listSnapshots(); });
    document.getElementById('axis-tool-diary').addEventListener('click', () => { p.remove(); generateDiary(); });
    document.getElementById('axis-tool-diary-list').addEventListener('click', () => { p.remove(); listDiaryEntries(); });
    document.getElementById('axis-tool-export').addEventListener('click', () => { p.remove(); exportRecipe(); });
    document.getElementById('axis-tool-import').addEventListener('click', () => {
        p.remove(); const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
        inp.addEventListener('change', e => { if (e.target.files[0]) importRecipe(e.target.files[0]); });
        inp.click();
    });
    document.getElementById('axis-tool-crossover').addEventListener('click', () => { p.remove(); listCrossoverTargets(); });
    document.getElementById('axis-tool-cast-list').addEventListener('click', () => { p.remove(); listCast(); });
    document.getElementById('axis-tool-immersion-test').addEventListener('click', () => {
        p.remove();
        addMsg('agent', '🎭 Checando imersão... (isso normalmente roda sozinho a cada ~15 mensagens do RP, isso aqui é só pra testar agora)');
        maybeAdvanceImmersion(true);
    });
    document.getElementById('axis-tool-scene-toggle').addEventListener('click', () => {
        const s = scope();
        s[KEYS.ALIVE].sceneDirection = s[KEYS.ALIVE].sceneDirection === false ? true : false;
        save();
        p.remove();
        addMsg('agent', s[KEYS.ALIVE].sceneDirection === false
            ? '🎬 Direção de Cena desligada — só o personagem principal responde no RP agora.'
            : '🎬 Direção de Cena ligada — NPCs do elenco podem entrar na conversa quando fizer sentido.');
    });
    document.getElementById('axis-tool-unlock').addEventListener('click', () => {
        p.remove();
        GLOBAL_MUTEX = false; GLOBAL_MUTEX_SINCE = 0; RP_GENERATING = false; isGenerating = false;
        if (sendBtn) sendBtn.disabled = false;
        dotsIdle();
        addMsg('agent', '🔓 Destravado manualmente.');
    });
    document.getElementById('axis-tool-clear-main').addEventListener('click', () => { p.remove(); clearMainChat(); });
    document.getElementById('axis-tool-connect').addEventListener('click', () => { p.remove(); showConnectPicker(); });
}

function showConnectPicker() {
    const options = listConnectableScopes();
    if (!options.length) { addMsg('agent', 'Não achei nenhum outro chat com sistemas ou elenco salvos ainda pra conectar.'); return; }
    const existing = document.getElementById('axis-connect-panel');
    if (existing) { existing.remove(); return; }
    const p = document.createElement('div');
    p.id = 'axis-connect-panel'; p.className = 'axis-tools-panel';
    p.innerHTML =
        '<div class="axis-tools-header"><span>🔗 Conectar chat</span><button class="axis-btn axis-btn-close" id="axis-connect-close">✕</button></div>' +
        '<div class="axis-tools-body">' +
        '<p class="axis-empty" style="padding:6px 4px;">Isso copia sistemas, elenco e memória do chat escolhido pra cá. Não apaga nada daqui.</p>' +
        options.map((o, i) =>
            '<button class="axis-tool-item" data-key="' + o.key + '">' +
            (o.sameCharacter ? '📎 Mesmo personagem' : '🔀 Outro personagem') +
            ' — ' + o.systemsCount + ' sistema(s), ' + o.castCount + ' NPC(s)</button>'
        ).join('') +
        '</div>';
    panel.appendChild(p);
    document.getElementById('axis-connect-close').addEventListener('click', () => p.remove());
    p.querySelectorAll('[data-key]').forEach(b => b.addEventListener('click', () => {
        const ok = connectScope(b.dataset.key);
        p.remove();
        addMsg('agent', ok ? '✅ Conectado — sistemas, elenco e memória desse chat copiados pra cá.' : '⚠️ Não consegui conectar.');
    }));
}

function listCast() {
    const s = scope();
    const cast = s[KEYS.CAST] || [];
    if (!cast.length) { addMsg('agent', 'Nenhum NPC no elenco ainda. Peça pra eu criar um quando fizer sentido pra história.'); return; }
    let list = '';
    cast.forEach(n => {
        list += '[AXIS:CARD]\n👥 ' + n.name + (n.role ? ' — ' + n.role : '') + '\n\n' + (n.description || '') + (n.voiceNotes ? '\n\nComo fala: ' + n.voiceNotes : '') + '\n[AXIS:CARD_END]\n';
    });
    addMsg('agent', list);
}

// ====================================
// SNAPSHOT
// ====================================
async function createSnapshot() {
    const s = scope();
    const chatId = currentMiniChatId || 'main';
    addMsg('agent', '[AXIS:ACTION] Criando snapshot...', chatId);
    try {
        const fullCtx = buildFullContext();
        const msgs = [
            { role: 'system', content: 'Crie um snapshot do estado atual do personagem. Descreva o que SABE, SENTE, PENSA e QUER. Use [AXIS:SNAPSHOT]...[AXIS:SNAPSHOT_END].\n\n' + fullCtx },
            { role: 'user', content: 'Crie o snapshot.' },
        ];
        const resp = await generate(msgs, { maxTokens: 600 });
        const m = /\[AXIS:SNAPSHOT\]([\s\S]*?)\[AXIS:SNAPSHOT_END\]/.exec(resp);
        const content = m ? m[1].trim() : resp.trim();
        const snaps = s[KEYS.SNAPSHOTS];
        snaps.push({ id: 'snap_' + Date.now(), content, ts: Date.now() });
        if (snaps.length > 30) s[KEYS.SNAPSHOTS] = snaps.slice(-30);
        save();
        addMsg('agent', '[AXIS:CARD]\nSnapshot:\n\n' + content + '\n[AXIS:CARD_END]', chatId);
    } catch (e) { addMsg('agent', 'Erro: ' + (e.message || e), chatId); }
}

function listSnapshots() {
    const s = scope();
    const snaps = s[KEYS.SNAPSHOTS] || [];
    if (!snaps.length) { addMsg('agent', 'Nenhum snapshot ainda.'); return; }
    let list = '';
    snaps.slice(-10).forEach(sn => {
        list += '[AXIS:CARD]\nSnapshot — ' + new Date(sn.ts).toLocaleString() + '\n\n' + sn.content + '\n[AXIS:CARD_END]\n';
    });
    addMsg('agent', list);
}

// ====================================
// DIÁRIO
// ====================================
async function generateDiary() {
    const s = scope();
    const chatId = currentMiniChatId || 'main';
    addMsg('agent', '[AXIS:ACTION] Escrevendo diário...', chatId);
    try {
        const fullCtx = buildFullContext();
        const rp = (s[KEYS.RP_FIELD] || []).slice(-10).join('\n');
        const msgs = [
            { role: 'system', content: 'Escreva uma entrada de DIÁRIO em 1ª pessoa, do ponto de vista da personagem, sobre os eventos recentes. Use [AXIS:DIARY]...[AXIS:DIARY_END].\n\n' + rp + '\n\n' + fullCtx },
            { role: 'user', content: 'Escreva o diário.' },
        ];
        const resp = await generate(msgs, { maxTokens: 800 });
        const m = /\[AXIS:DIARY\]([\s\S]*?)\[AXIS:DIARY_END\]/.exec(resp);
        const content = m ? m[1].trim() : resp.trim();
        const diary = s[KEYS.DIARY];
        diary.push({ id: 'diary_' + Date.now(), content, ts: Date.now() });
        if (diary.length > 50) s[KEYS.DIARY] = diary.slice(-50);
        save();
        addMsg('agent', '[AXIS:CARD]\nDiário — ' + new Date().toLocaleString() + '\n\n' + content + '\n[AXIS:CARD_END]', chatId);
    } catch (e) { addMsg('agent', 'Erro: ' + (e.message || e), chatId); }
}

function listDiaryEntries() {
    const s = scope();
    const entries = s[KEYS.DIARY] || [];
    if (!entries.length) { addMsg('agent', 'Nenhuma entrada de diário ainda.'); return; }
    let list = '';
    entries.slice(-10).reverse().forEach(e => {
        list += '[AXIS:CARD]\n' + new Date(e.ts).toLocaleString() + '\n\n' + e.content + '\n[AXIS:CARD_END]\n';
    });
    addMsg('agent', list);
}

// ====================================
// EXPORT / IMPORT
// ====================================
function exportRecipe() {
    const s = scope();
    const recipe = {
        version: '3.0.0', exportedAt: new Date().toISOString(),
        sistemas: s[KEYS.SYSTEMS], rpField: s[KEYS.RP_FIELD],
        snapshots: s[KEYS.SNAPSHOTS], diary: s[KEYS.DIARY],
        memoria: s[KEYS.MEMORIA], elenco: s[KEYS.CAST],
    };
    const blob = new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'spade-recipe-' + Date.now() + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    addMsg('agent', '📦 Receita exportada.');
}

function importRecipe(file) {
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const r = JSON.parse(e.target.result);
            if (!r.version || !r.sistemas) throw new Error('Formato inválido');
            const s = scope();
            s[KEYS.SYSTEMS] = r.sistemas; s[KEYS.RP_FIELD] = r.rpField || [];
            s[KEYS.SNAPSHOTS] = r.snapshots || []; s[KEYS.DIARY] = r.diary || [];
            s[KEYS.MEMORIA] = r.memoria || []; s[KEYS.CAST] = r.elenco || [];
            save(); applySystems(); applyCast();
            addMsg('agent', '✅ Receita importada com sucesso.');
        } catch (err) { addMsg('agent', 'Erro ao importar: ' + (err.message || err)); }
    };
    reader.readAsText(file);
}

// ====================================
// CROSSOVER
// ====================================
function getOtherScopes() {
    const scopes = [];
    for (const key of Object.keys(data)) {
        if (key.startsWith('c_') && key !== 'c_' + (ctx.characterId ?? ctx.groupId ?? 'global')) scopes.push(key);
    }
    return scopes;
}

function createCrossover(targetKey) {
    const s = scope();
    const target = data[targetKey];
    if (!target) return;
    const myRP = s[KEYS.RP_FIELD] || [];
    const targetRP = target[KEYS.RP_FIELD] || [];
    const entry = '[CROSSOVER de ' + s[KEYS.CHATS].main.name + '] ' + myRP.slice(-5).join(' | ');
    if (!targetRP.find(r => r === entry)) {
        targetRP.push(entry); save();
        addMsg('agent', 'Campo RP enviado para "' + targetKey + '".');
    } else {
        addMsg('agent', 'Já enviado anteriormente para "' + targetKey + '".');
    }
}

function listCrossoverTargets() {
    const scopes = getOtherScopes();
    if (!scopes.length) { addMsg('agent', 'Nenhum outro personagem encontrado.'); return; }
    let list = 'Personagens disponíveis:\n\n';
    scopes.forEach(s => {
        const name = String(data[s]?.[KEYS.CHATS]?.main?.name || s).replace(/"/g, "'");
        list += '[AXIS:APPROVAL ID:"crossover_' + s + '" LABEL:"Conectar Campo RP com ' + name + '?"]\n';
    });
    addMsg('agent', list);
}

// ====================================
// EVENTOS
// ====================================
eventSource.on(event_types.APP_READY, () => {
    load();
    createPanel();
    renderChat();
    renderMiniChatBar();
    ensureDefaultMemorySystem();
    applySystems();
    applyCast();
    updateAliveBar();
    scheduleAlive();
});

load();
createPanel();
scheduleAlive();

eventSource.on(event_types.CHAT_CHANGED, () => {
    save();
    renderChat();
    renderMiniChatBar();
    updateAliveBar();
    ensureDefaultMemorySystem();
    applySystems();
    applyCast();
});

eventSource.on(event_types.GENERATION_STARTED, () => { globalLock(); RP_GENERATING = true; dotsWriting(); });
eventSource.on(event_types.GENERATION_STOPPED, () => { globalUnlock(); RP_GENERATING = false; dotsIdle(); });
eventSource.on(event_types.GENERATION_ENDED, () => { globalUnlock(); RP_GENERATING = false; dotsIdle(); });

eventSource.on(event_types.MESSAGE_RECEIVED, () => {
    analyzeUser();
    maybeRamble('rp');
    maybeSummarizeMemory();
    maybeAdvanceImmersion();

    if (pendingNpcFollowup) {
        const info = pendingNpcFollowup;
        pendingNpcFollowup = null;
        (async () => {
            try {
                const s = scope();
                const npc = (s[KEYS.CAST] || []).find(n => n.name === info.name);
                if (!npc) return;
                const recentText = (ctx.chat || []).slice(-6).map(m => (m.name || '') + ': ' + (m.mes || '')).join('\n');
                const line = await generateNpcLine(npc, recentText);
                if (line) insertNpcMessage(npc.name, line, null, npc.photo);
            } catch (e) { console.warn('[Spade] Follow-up de NPC falhou:', e); }
        })();
    }
});
eventSource.on(event_types.MESSAGE_SENT, () => { analyzeUser(); });

})();