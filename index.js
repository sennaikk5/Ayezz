/*
 * Spade — Sistema Vivo v3.5.1
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
    SYNTHESIZE_VOICE: P + 'SYNTHESIZE_VOICE' + S, // Ticket 19
};

const DB = 'axis_v3';
const KEYS = {
    SYSTEMS: 's', MEMORIA: 'm', RP_FIELD: 'r', CHATS: 'c',
    MINI_CHATS: 'mc', SNAPSHOTS: 'sn', DIARY: 'dy',
    ALIVE: 'al', USER_BEHAVIOR: 'ub', CAST: 'ca', VOICE: 'vo',
    DIRECTIVE: 'dv', // Ticket 16: ajuste de tom leve, sem virar sistema
    PROFILE: 'pf', // Ticket 23: identidade solta, sempre lida por inteiro
    INNER_STATE: 'is', // Ticket 25
    SCENES: 'sc', // Ticket 27 (5c): memória de cenas inteiras, busca semântica
    TASKS: 'tk', // Ticket 29b: tarefas do Mini RPG, estado real (não texto de chat)
    CLOCK: 'cl', // Ticket 29a: relógio do Mini RPG
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
let pendingAttachments = []; // Ticket 14: anexos ficam separados do texto até o envio

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
let isRevealingCharMessage = false; // Ticket 29h: trava — impede duas revelações em tempo real simultâneas

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
            // Sistema Vivo sempre ativo — não existe mais liga/desliga manual
            // (o cooldown + a IA respondendo SILENCIO já controlam a frequência).
            [KEYS.ALIVE]: { lastRambling: 0, ramblingLog: [], status: 'idle', currentStatus: null, interruptedSpeech: null }, // currentStatus: Ticket 29f/g; interruptedSpeech: Ticket 29h
            [KEYS.USER_BEHAVIOR]: { interactions: 0, lastMsg: 0, avgGap: 0, gaps: [], level: 'normal' },
            [KEYS.VOICE]: { lines: [], personality: '', draft: null }, // RAG de voz (Ticket 1) + rascunho de síntese (Ticket 19)
            [KEYS.DIRECTIVE]: { text: '', ts: 0 }, // Ticket 16: ajuste de tom em tempo real
            [KEYS.PROFILE]: { text: '', updatedAt: 0, gender: 'neutro', thinkingPerson: 2, pendingDraft: null }, // Ticket 23/31, pendingDraft: Ticket 30
            [KEYS.INNER_STATE]: { text: '', updatedAt: 0 }, // Ticket 25
            [KEYS.SCENES]: [], // Ticket 27 (5c)
            [KEYS.TASKS]: [], // Ticket 29b
            [KEYS.CLOCK]: { day: 1, hour: 9, minute: 0, weather: '' }, // Ticket 29a
            _resolved: {},
        };
        save();
    }
    // Migração leve: chats que já existiam antes do Ticket 1 não têm VOICE ainda.
    if (!data[key][KEYS.VOICE]) data[key][KEYS.VOICE] = { lines: [], personality: '', draft: null };
    if (data[key][KEYS.VOICE].draft === undefined) data[key][KEYS.VOICE].draft = null;
    if (!data[key][KEYS.DIRECTIVE]) data[key][KEYS.DIRECTIVE] = { text: '', ts: 0 };
    if (!data[key][KEYS.PROFILE]) data[key][KEYS.PROFILE] = { text: '', updatedAt: 0, gender: 'neutro', thinkingPerson: 2 };
    if (!data[key][KEYS.PROFILE].gender) data[key][KEYS.PROFILE].gender = 'neutro';
    if (!data[key][KEYS.PROFILE].thinkingPerson) data[key][KEYS.PROFILE].thinkingPerson = 2;
    if (!data[key][KEYS.PROFILE].customThinkingPresets) data[key][KEYS.PROFILE].customThinkingPresets = []; // Ticket 32b
    if (data[key][KEYS.PROFILE].pendingDraft === undefined) data[key][KEYS.PROFILE].pendingDraft = null; // Ticket 30
    if (!data[key][KEYS.INNER_STATE]) data[key][KEYS.INNER_STATE] = { text: '', updatedAt: 0 };
    if (!data[key][KEYS.SCENES]) data[key][KEYS.SCENES] = [];
    if (!data[key][KEYS.TASKS]) data[key][KEYS.TASKS] = [];
    if (!data[key][KEYS.CLOCK]) data[key][KEYS.CLOCK] = { day: 1, hour: 9, minute: 0, weather: '' };
    if (data[key][KEYS.ALIVE].currentStatus === undefined) data[key][KEYS.ALIVE].currentStatus = null;
    if (data[key][KEYS.ALIVE].interruptedSpeech === undefined) data[key][KEYS.ALIVE].interruptedSpeech = null; // Ticket 29h
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
// RAG — EMBEDDINGS (Ticket 1)
// A chave do NanoGPT fica só no backend Axis (axis-proxy), nunca aqui.
// Essa extensão só chama a rota já proxiada. Se a rota não existir ainda
// no backend (404/erro de rede), getEmbedding retorna null e quem chamou
// degrada pro fallback (últimas N linhas, sem ranking por similaridade) —
// nunca trava o fluxo normal por causa disso.
// ====================================
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
// TICKET 28 (item 6) — TOOL CALLING
// ADAPTAÇÃO NECESSÁRIA em relação ao design original: generate() aqui é
// um wrapper fino em cima de ctx.generateRaw, que só devolve TEXTO —
// não existe tools/tool_calls no nível de API (isso varia por backend e
// o SillyTavern não expõe um passthrough genérico pra function calling).
// Em vez de tools nativos, a ferramenta é pedida pelo mesmo mecanismo de
// marcador que o resto do Spade já usa: [AXIS:TOOL NAME:"..." ARGS:"..."]
// [AXIS:TOOL_END]. TAGS.TOOL/TOOL_END já existiam reservados no topo do
// arquivo, sem uso até agora — é esse o uso pretendido.
//
// Escopo desta implementação: a infraestrutura (executeSpadeTool,
// generateWithTools) está pronta e testável, e está ligada só no chat do
// Espaço (função de envio de mensagem — ver mais abaixo), que é
// exatamente o "testa isolado, sozinho" pedido no design original antes
// de migrar o canto 3 fixo do runThoughtChain (item 7) pra virar uma
// ferramenta sob demanda dentro da geração real do RP. Essa segunda
// parte (mexer no runThoughtChain/RP) fica pra depois de validar que o
// loop abaixo se comporta bem ao vivo — não entrou nesta rodada.
// ====================================
const SPADE_TOOLS_DESC = `Ferramentas disponíveis — use [AXIS:TOOL NAME:"nome" ARGS:"argumento em texto livre"][AXIS:TOOL_END] pra chamar uma (o resultado volta pra você na mesma resposta, antes de você terminar de responder o usuário):
- consultar_memoria: busca uma memória específica já salva. ARGS = o assunto a procurar.
- checar_ritmo_atual: verifica se as últimas respostas do personagem no RP repetiram um padrão (abertura parecida, palavra repetida demais). ARGS pode ficar vazio.
- buscar_cena_parecida: busca uma cena passada do RP parecida com uma descrição. ARGS = a descrição da cena.
Só use uma ferramenta quando genuinamente precisar da informação pra responder bem — a maioria das respostas não precisa de nenhuma.`;

async function executeSpadeTool(name, args) {
    const s = scope();
    if (name === 'consultar_memoria') {
        const found = (s[KEYS.MEMORIA] || []).find(m => m.text?.toLowerCase().includes(String(args || '').toLowerCase()));
        return found ? found.text : 'Nada encontrado.';
    }
    if (name === 'checar_ritmo_atual') return checkRepetitionPatterns() || 'Nenhum padrão notado.';
    if (name === 'buscar_cena_parecida') {
        const emb = await getEmbedding(args || '');
        if (!emb) return 'Busca indisponível agora (embedder não carregou).';
        const top = (s[KEYS.SCENES] || []).filter(sc => sc.embedding).map(sc => ({ ...sc, score: cosineSim(emb, sc.embedding) })).sort((a, b) => b.score - a.score)[0];
        return top && top.score > 0.7 ? top.summary : 'Nenhuma cena parecida.';
    }
    return 'Ferramenta desconhecida: ' + name;
}

// Loop de ferramentas — no máximo 3 idas e voltas, pra nunca ficar preso
// nem inflar custo à toa numa única resposta.
async function generateWithTools(msgs, opts = {}) {
    const toolRe = /\[AXIS:TOOL\s+NAME:"([^"]+)"(?:\s+ARGS:"([^"]*)")?\]\s*\[AXIS:TOOL_END\]/;
    let messages = [...msgs];
    let lastResp = null;
    for (let round = 0; round < 3; round++) {
        lastResp = await generate(messages, opts);
        const m = toolRe.exec(lastResp || '');
        if (!m) return lastResp;
        const result = await executeSpadeTool(m[1], m[2] || '');
        messages = [...messages,
            { role: 'assistant', content: lastResp },
            { role: 'user', content: '[RESULTADO DE ' + m[1] + ']: ' + result + '\n\nContinue sua resposta considerando isso, sem repetir o marcador de ferramenta.' }];
    }
    console.warn('[Spade] Tool calling não fechou em 3 rodadas — devolvendo a última tentativa, sem o marcador solto.');
    return (lastResp || '').replace(toolRe, '').trim() || null;
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
    const cast = (s[KEYS.CAST] || []).filter(n => !n.archived); // Ticket 26
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
    const now = Date.now();
    // Cooldown antes mesmo de considerar chamar a API — isso é o que
    // evita gastar token: só reavalia depois de um tempo mínimo desde
    // a última vez, mesmo que vários eventos disparem em sequência.
    // Não existe mais liga/desliga manual do Sistema Vivo — ele sempre
    // roda, e o cooldown + a IA respondendo SILENCIO já são o controle
    // real de "não falar toda hora" (Ticket 5).
    if (now - (a.lastRambling || 0) < 45000) return;
    a.lastRambling = now;
    save();

    try {
        dotsThinking();
        const fullCtx = buildFullContext();
        const focus = trigger === 'rp'
            ? 'Algo acabou de acontecer no RP — olhe a seção RP AO VIVO acima.'
            : 'O usuário acabou de interagir com você no Espaço.';

        // Últimas observações já registradas — pra você notar se está
        // vendo o MESMO padrão se repetir, e não só uma vez isolada.
        const recentLog = (a.ramblingLog || []).slice(-5)
            .map(e => '- ' + String(e.text || '').replace(/\[AXIS:[^\]]*\]/g, '').replace(/\[\/AXIS:[^\]]*\]/g, '').slice(0, 200))
            .join('\n');
        const charName = ctx.name2 || 'o personagem'; // Ticket 25

        const msgs = [{ role: 'system', content: `Você é o Spade, observando o personagem e o usuário (você não é o personagem). ${focus}

${fullCtx}

Você NÃO está narrando a cena. Você é um observador de fora, escrevendo uma nota técnica curta sobre o que percebeu — nunca escreva na perspectiva do personagem, nunca descreva ações físicas dela.

ERRADO (isso é RP, não faça): "Ela sorri suavemente, os olhos brilhando enquanto pensa no que ele disse..."
CERTO (isso é observação, faça assim): "Usuário parece testando limites da personagem — resposta ficou mais cautelosa que o normal."

${recentLog ? 'Suas últimas observações (pra notar repetição de padrão):\n' + recentLog + '\n' : ''}
[ESTADO INTERNO ATUAL de ${charName}]
${s[KEYS.INNER_STATE]?.text || '(nenhum registrado ainda — se fizer sentido pela cena, estabeleça um)'}

Se o que rolou nas últimas trocas mudar esse estado (de leve, por acúmulo, ou de vez, por causa de algo específico) reescreva com [AXIS:INNER_STATE]texto novo[/AXIS:INNER_STATE]. O texto precisa ter três coisas sempre: o que ela sente por dentro, o que ela mostra por fora (podem ser diferentes — geralmente são, ela guarda a compostura), e o motivo. Se ela perceber que baixou a guarda demais numa troca recente, isso pode ser o próprio motivo da próxima mudança — ela se fecha como reação. Não force mudança toda vez — só reescreva se genuinamente mudou.

Se algo realmente valer a pena registrar agora, escreva uma frase curta (até 180 caracteres), em português, na sua própria voz, no tom do exemplo CERTO acima. Pode ser: uma observação sobre o personagem, uma percepção sobre como o usuário está reagindo (gostando, achando fácil ou difícil demais, engajado ou entediado), ou uma ideia concreta que você queira propor de verdade.

Se tiver uma ideia concreta que valha a pena, pode incluir um [AXIS:SYSTEM_PROPOSAL] (se for algo que deve mudar o comportamento do personagem) ou [AXIS:SHELF_ADD] (se for só uma informação pra guardar) junto da frase — mas só quando for genuíno, não force.

Se o que você percebeu for um ajuste SIMPLES de tom/comportamento (ex: "ela tá falando demais", "as falas tão sem qualidade", "ela tá se abrindo rápido demais") — não fique só observando, e não precisa propor um sistema pesado: inclua [AXIS:DIRECTIVE]instrução direta e clara do que mudar[/AXIS:DIRECTIVE] junto da observação. Isso muda o próximo turno do RP de verdade, na hora, sem esperar aprovação.

Se você já notou esse mesmo tipo de padrão mais de uma vez (olhe suas últimas observações acima), é ainda mais importante usar [AXIS:DIRECTIVE] ou [AXIS:SYSTEM_PROPOSAL] agora — só observar de novo sem mudar nada é o que faz parecer que ninguém tá prestando atenção de verdade.

Se fizer sentido ${charName} tomar a iniciativa AGORA — puxar assunto, aparecer, mandar algo pro usuário — mesmo sem ele ter feito nada, use [AXIS:CHAR_SPEAK]fala dela, na voz dela e coerente com os sistemas ativos[/AXIS:CHAR_SPEAK] junto da sua observação. Isso realmente posta no RP na hora, de verdade. É raro — só quando a cena ou o tempo que passou genuinamente pedem, nunca por rotina.${isCharacterIdle() ? ' Ela está livre agora (sem nenhuma outra coisa acontecendo — nem thread de NPC, nem tarefa pendente), o que torna isso um pouco mais provável de fazer sentido.' : ''}

Se não houver nada que realmente valha a pena dizer agora, responda EXATAMENTE com a palavra: SILENCIO

A maioria das vezes a resposta certa é SILENCIO. Você não fala só por falar.` }];

        const resp = await generate(msgs, { maxTokens: 220 });
        const trimmed = (resp || '').trim();
        if (!trimmed || /^SILENCIO/i.test(trimmed)) { dotsIdle(); return; }

        const withShelf = processShelfAdds(trimmed, 'main');
        const withDirective = processDirective(withShelf, 'main');
        const withInnerState = processInnerState(withDirective); // Ticket 25
        const withCreateCompat = processSystemCreateCompat(withInnerState); // Ticket 20
        let processed = processSystemProposals(withCreateCompat);
        processed = await processCharSpeak(processed); // Ticket 28 (item 1) — sem isso o CHAR_SPEAK prometido no prompt acima nunca posta nada de verdade, só vira aviso de marcador desconhecido no strip abaixo
        processed = stripUnknownAxisMarkers(processed); // Ticket 20: mesma rede de segurança do Espaço

        a.ramblingLog.push({ ts: now, text: processed });
        if (a.ramblingLog.length > 30) a.ramblingLog = a.ramblingLog.slice(-30);
        save();
        renderRamblingLog();
        dotsIdle();
    } catch (_) { dotsIdle(); }
}

// Ticket 4: o estado visível/escondido do log é decidido pelo que foi
// salvo em localStorage (axis_log_visible) — não força mais display:block
// toda vez que há conteúdo. O botão de toggle só grava a preferência e
// chama renderRamblingLog() de novo pra ela aplicar o estado atualizado.
function isLogVisiblePref() {
    return localStorage.getItem('axis_log_visible') !== '0';
}

function renderRamblingLog() {
    if (!ramblingLog) return;
    const a = scope()[KEYS.ALIVE];
    const log = a.ramblingLog || [];
    if (!log.length) { ramblingLog.classList.remove('axis-rambling-show'); ramblingLog.innerHTML = ''; return; }
    ramblingLog.innerHTML = log.slice(-8).map(e =>
        '<div class="axis-rambling-entry">' +
        '<div class="axis-rambling-meta">' + new Date(e.ts).toLocaleTimeString() + '</div>' +
        '<div class="axis-rambling-text">' + buildHtml(e.text) + '</div></div>'
    ).join('');
    ramblingLog.classList.toggle('axis-rambling-show', isLogVisiblePref());
    listenApprovals(ramblingLog, 'main');
}

// Ticket 5: Sistema Vivo sempre ativo — o badge não é mais um interruptor
// (o cooldown + a IA respondendo SILENCIO já controlam a frequência).
// Só o botão de Log (Ticket 4) continua interativo.
function updateAliveBar() {
    if (!aliveBar) return;
    const directive = scope()[KEYS.DIRECTIVE]?.text;
    aliveBar.innerHTML =
        '<span class="axis-alive-badge axis-alive-active" title="Sistema Vivo: a IA observa sozinha, sempre ativo">🧠 Sistema Vivo</span>' +
        '<span class="axis-alive-badge axis-alive-log" id="axis-btn-log-toggle" title="Mostrar/esconder o log de pensamentos da IA">📜 Log</span>' +
        (directive ? '<span class="axis-alive-badge axis-alive-directive" title="' + esc(directive) + '">🎚️ Ajuste ativo</span>' : '') +
        '<span class="axis-alive-meta">sempre ativo</span>';
    document.getElementById('axis-btn-log-toggle')?.addEventListener('click', () => {
        localStorage.setItem('axis_log_visible', isLogVisiblePref() ? '0' : '1');
        renderRamblingLog();
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

// Ticket 8: até aqui só dava pra CRIAR sistema pela IA — apagar/atualizar
// exigia o Senna remover manualmente. Mesmo padrão de aprovação dos outros.
function processSystemDelete(text) {
    const s = scope();
    const re = /\[AXIS:SYSTEM_DELETE\s+NAME:"([^"]+)"\]/g;
    if (!s._pending) s._pending = {};
    return text.replace(re, (_, name) => {
        const cleanName = name.trim();
        const exists = (s[KEYS.SYSTEMS] || []).some(x => x.name === cleanName);
        if (!exists) return '⚠️ _Não achei um sistema chamado "' + cleanName + '" pra apagar._';
        const uid = 'sys_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        s._pending[uid] = { name: cleanName };
        return '[AXIS:CARD]\n🗑️ Remover sistema: ' + cleanName + '\n[AXIS:CARD_END]\n[AXIS:APPROVAL ID:"delete_system_' + uid + '" LABEL:"Apagar ' + cleanName + '?"]';
    });
}

function processSystemUpdate(text) {
    const s = scope();
    const re = /\[AXIS:SYSTEM_UPDATE\]([\s\S]*?)\[\/AXIS:SYSTEM_UPDATE\]/g;
    if (!s._pending) s._pending = {};
    return text.replace(re, (_, raw) => {
        let p;
        try { p = JSON.parse(raw.trim()); } catch (_) {
            return '[AXIS:CARD]\n⚠️ Atualização de sistema inválida.\n[AXIS:CARD_END]';
        }
        const name = String(p.name || '').trim();
        const existing = (s[KEYS.SYSTEMS] || []).find(x => x.name === name);
        if (!existing) return '⚠️ _Não achei um sistema chamado "' + name + '" pra atualizar._';
        const uid = 'sys_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        s._pending[uid] = { name, patch: p };
        return '[AXIS:CARD]\n✏️ Atualizar sistema: ' + name + '\n\n' + (p.description || existing.description || '') + '\n[AXIS:CARD_END]\n[AXIS:APPROVAL ID:"update_system_' + uid + '" LABEL:"Atualizar ' + name + '?"]';
    });
}

// ====================================
// TICKET 20 — REDE DE SEGURANÇA CONTRA MARCADOR ALUCINADO
// Observado na prática: a IA (no Espaço) tentou usar um marcador
// "[AXIS:SYSTEM_CREATE NAME:".." TYPE:".." PROMPT:"..long texto.."]" que
// nunca existiu em nenhum parser. Resultado: nada era criado de verdade,
// e o texto inteiro (às vezes um promptText gigante) aparecia cru na
// tela, dando a falsa impressão de que algo tinha rodado.
//
// Duas camadas:
// 1. processSystemCreateCompat — reconhece ESSE padrão específico já
//    visto e converte pro fluxo real de SYSTEM_PROPOSAL (ainda passa
//    pela aprovação normal, não pula essa etapa).
// 2. stripUnknownAxisMarkers — rede de segurança genérica, roda por
//    ÚLTIMO: qualquer [AXIS:ALGO] que sobreviver até aqui (ou seja, não
//    foi um marcador real e não foi consumido por nenhum processX acima)
//    é removido e vira um aviso curto, nunca o texto cru.
// ====================================
function unescapeJsonish(str) {
    return String(str).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function processSystemCreateCompat(text) {
    const s = scope();
    if (!s._pending) s._pending = {};
    const re = /\[AXIS:SYSTEM_CREATE\b([\s\S]*?)\]/g;
    return text.replace(re, (_, attrs) => {
        const nameM = /NAME:"([^"]*)"/.exec(attrs);
        const typeM = /TYPE:"([^"]*)"/.exec(attrs);
        const promptM = /PROMPT:"([\s\S]*)"/.exec(attrs); // greedy até a última aspas do bloco
        if (!nameM || !promptM) {
            console.warn('[Spade] SYSTEM_CREATE alucinado sem campos suficientes pra recuperar — descartado.');
            return '⚠️ _(a IA tentou criar um sistema com um marcador que não existe — nada foi executado)_';
        }
        console.warn('[Spade] Marcador não-oficial SYSTEM_CREATE convertido pro fluxo real (SYSTEM_PROPOSAL + aprovação).');
        const uid = 'sys_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        const sys = {
            name: unescapeJsonish(nameM[1]).trim().replace(/"/g, "'") || 'Sem nome',
            type: typeM ? unescapeJsonish(typeM[1]).trim() : 'behavior',
            description: '(recuperado de um marcador SYSTEM_CREATE não-oficial — a IA deveria ter usado SYSTEM_PROPOSAL)',
            steps: [],
            promptText: unescapeJsonish(promptM[1]).trim(),
            enabled: true, createdAt: Date.now(),
        };
        s._pending[uid] = sys;
        return '[AXIS:CARD]\n📐 Sistema proposto: ' + sys.name + ' (' + sys.type + ')\n\n' + sys.description + '\n[AXIS:CARD_END]\n[AXIS:APPROVAL ID:"create_system_' + uid + '" LABEL:"Criar ' + sys.name + '?"]';
    });
}

const AXIS_TAGS_SAFE_TO_RENDER = new Set(['CARD', 'CARD_END', 'APPROVAL', 'VOICE_APPROVAL', 'PROFILE_APPROVAL', 'THINK', 'ACTION']);
function stripUnknownAxisMarkers(text) {
    let out = text;
    // Passo 1: pares [AXIS:NOME]...[/AXIS:NOME] com nome desconhecido —
    // remove o bloco inteiro (o conteúdo costuma ser o texto alucinado).
    out = out.replace(/\[AXIS:([A-Z_]+)\]([\s\S]*?)\[\/AXIS:\1\]/g, (full, tag) => {
        if (AXIS_TAGS_SAFE_TO_RENDER.has(tag)) return full;
        console.warn('[Spade] Marcador desconhecido ignorado (nada foi executado): ' + tag);
        return '⚠️ _(a IA tentou usar um marcador que não existe: ' + tag + ' — nada foi executado)_';
    });
    // Passo 2: marcadores soltos, com ou sem atributos — [AXIS:NOME] ou
    // [AXIS:NOME ATTR:"..."] — que não são nenhum dos marcadores reais.
    out = out.replace(/\[AXIS:([A-Z_]+)(?:\s[^\]]*)?\]/g, (full, tag) => {
        if (AXIS_TAGS_SAFE_TO_RENDER.has(tag)) return full;
        console.warn('[Spade] Marcador desconhecido ignorado (nada foi executado): ' + tag);
        return '⚠️ _(a IA tentou usar um marcador que não existe: ' + tag + ' — nada foi executado)_';
    });
    // Passo 3: fechamentos órfãos [/AXIS:NOME] que sobraram sem abertura —
    // nenhum marcador real usa essa convenção, é sempre resto de alucinação.
    out = out.replace(/\[\/AXIS:[A-Z_]+\]/g, '');
    return out;
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
        importance: clean(p.importance) || existing?.importance || 'média', // Ticket 26: baixa/média/alta
        lastMentionedAtMsgCount: existing?.lastMentionedAtMsgCount ?? getTotalRpMessages(), // Ticket 26
        archived: existing?.archived || false, // Ticket 26
        createdAt: existing?.createdAt || Date.now(),
    };
}

function getTotalRpMessages() { return scope()[KEYS.ALIVE]?.totalRpMessages || 0; }

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
let phoneEditingName = null; // Ticket 11: se setado, o form de criação vira form de edição pré-preenchido
let phoneShowArchived = false; // Ticket 26

function togglePhonePanel() {
    const ex = document.getElementById('axis-phone-panel');
    if (ex) { ex.remove(); return; }
    phoneOpenThread = null;
    phoneCreating = false;
    phoneEditingName = null;
    phoneShowArchived = false;
    const p = document.createElement('div');
    p.id = 'axis-phone-panel'; p.className = 'axis-tools-panel axis-phone-panel';
    panel.appendChild(p);
    renderPhonePanel();
}

function renderPhonePanel() {
    const p = document.getElementById('axis-phone-panel');
    if (!p) return;
    const s = scope();
    const cast = (s[KEYS.CAST] || []).filter(n => !n.archived); // Ticket 26
    const archivedCount = (s[KEYS.CAST] || []).filter(n => n.archived).length; // Ticket 26
    const charName = ctx.name2 || 'Personagem';

    if (phoneShowArchived) {
        const archived = (s[KEYS.CAST] || []).filter(n => n.archived);
        p.innerHTML =
            '<div class="axis-tools-header"><button class="axis-btn" id="axis-phone-back">←</button><span>🗄️ Arquivados</span><button class="axis-btn axis-btn-close" id="axis-phone-close">✕</button></div>' +
            '<div class="axis-tools-body">' +
            (archived.length
                ? archived.map(n => '<div class="axis-tool-item axis-phone-archived-item"><span>' + esc(n.name) + (n.role ? ' — ' + esc(n.role) : '') + '</span><button class="axis-btn axis-btn-sm axis-phone-revive" data-name="' + esc(n.name).replace(/"/g, '&quot;') + '">Reviver</button></div>').join('')
                : '<p class="axis-empty">Nenhum NPC arquivado.</p>') +
            '</div>';
        document.getElementById('axis-phone-back').addEventListener('click', () => { phoneShowArchived = false; renderPhonePanel(); });
        document.getElementById('axis-phone-close').addEventListener('click', () => p.remove());
        p.querySelectorAll('.axis-phone-revive').forEach(b => b.addEventListener('click', () => {
            const npc = (s[KEYS.CAST] || []).find(n => n.name === b.dataset.name);
            if (npc) { npc.archived = false; save(); applyCast(); }
            renderPhonePanel();
        }));
        return;
    }

    if (phoneCreating) {
        const editingNpc = phoneEditingName ? cast.find(n => n.name === phoneEditingName) : null;
        p.innerHTML =
            '<div class="axis-tools-header"><button class="axis-btn" id="axis-phone-back">←</button><span>' + (editingNpc ? 'Editar NPC' : 'Novo NPC') + '</span><button class="axis-btn axis-btn-close" id="axis-phone-close">✕</button></div>' +
            '<div class="axis-tools-body axis-npc-form">' +
            '<div class="axis-npc-photo-row">' +
            '<div class="axis-npc-photo-preview" id="axis-npc-photo-preview">' + (editingNpc?.photo ? '<img src="' + editingNpc.photo + '" alt="preview">' : '📷') + '</div>' +
            '<input type="file" id="axis-npc-photo" accept="image/*" style="display:none;">' +
            '<button class="axis-btn" id="axis-npc-photo-btn">' + (editingNpc?.photo ? 'Trocar foto' : 'Adicionar foto') + '</button>' +
            '</div>' +
            '<input type="text" id="axis-npc-name" placeholder="Nome*" value="' + esc(editingNpc?.name || '') + '">' +
            '<input type="text" id="axis-npc-age" placeholder="Idade" value="' + esc(editingNpc?.age || '') + '">' +
            '<input type="text" id="axis-npc-appearance" placeholder="Aparência" value="' + esc(editingNpc?.appearance || '') + '">' +
            '<input type="text" id="axis-npc-tags" placeholder="Tags, separadas por vírgula (amiga, colega rival...)" value="' + esc((editingNpc?.tags || []).join(', ')) + '">' +
            '<textarea id="axis-npc-notes" rows="4" placeholder="Observação — explica quem ela é, história, onde mora, o que quiser, sem formato fixo">' + esc(editingNpc?.notes || '') + '</textarea>' +
            '<button class="axis-btn axis-btn-send" id="axis-npc-save">' + (editingNpc ? 'Salvar' : 'Criar') + '</button>' +
            '</div>';
        document.getElementById('axis-phone-back').addEventListener('click', () => { phoneCreating = false; phoneEditingName = null; renderPhonePanel(); });
        document.getElementById('axis-phone-close').addEventListener('click', () => p.remove());

        let photoDataUri = editingNpc?.photo || '';
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
            const fields = {
                name,
                age: document.getElementById('axis-npc-age').value,
                appearance: document.getElementById('axis-npc-appearance').value,
                tags: document.getElementById('axis-npc-tags').value,
                notes: document.getElementById('axis-npc-notes').value,
                description: document.getElementById('axis-npc-notes').value.slice(0, 200),
            };
            if (editingNpc) {
                const updated = buildNpcObject(fields, editingNpc);
                if (photoDataUri) updated.photo = photoDataUri;
                Object.assign(editingNpc, updated);
            } else {
                const npc = buildNpcObject(fields);
                if (photoDataUri) npc.photo = photoDataUri;
                s[KEYS.CAST].push(npc);
            }
            save(); applyCast();
            phoneCreating = false;
            phoneEditingName = null;
            renderPhonePanel();
        });
        return;
    }

    if (phoneOpenThread) {
        const npc = cast.find(n => n.name === phoneOpenThread);
        if (!npc) { phoneOpenThread = null; return renderPhonePanel(); }
        const thread = npc.thread || [];
        p.innerHTML =
            '<div class="axis-tools-header"><button class="axis-btn" id="axis-phone-back">←</button><span>' + esc(npc.name) + '</span><button class="axis-btn axis-btn-sm" id="axis-phone-edit" title="Editar NPC">✏️</button><button class="axis-btn axis-btn-close" id="axis-phone-close">✕</button></div>' +
            '<div class="axis-phone-thread">' +
            (thread.length
                ? thread.map(m => '<div class="axis-phone-bubble ' + (m.from === 'char' ? 'axis-phone-char' : 'axis-phone-npc') + '"><span class="axis-phone-who">' + (m.from === 'char' ? esc(charName) : esc(npc.name)) + '</span>' + esc(m.text) + '</div>').join('')
                : '<p class="axis-empty">Ainda não trocaram nada.</p>') +
            '</div>';
        document.getElementById('axis-phone-back').addEventListener('click', () => { phoneOpenThread = null; renderPhonePanel(); });
        document.getElementById('axis-phone-edit').addEventListener('click', () => { phoneEditingName = npc.name; phoneCreating = true; phoneOpenThread = null; renderPhonePanel(); });
        document.getElementById('axis-phone-close').addEventListener('click', () => p.remove());
        const threadEl = p.querySelector('.axis-phone-thread');
        if (threadEl) threadEl.scrollTop = threadEl.scrollHeight;
        return;
    }

    p.innerHTML =
        '<div class="axis-tools-header"><span>📱 Celular</span><button class="axis-btn axis-btn-close" id="axis-phone-close">✕</button></div>' +
        '<div class="axis-tools-body">' +
        '<button class="axis-tool-item" id="axis-phone-new">➕ Novo NPC</button>' +
        (archivedCount > 0 ? '<button class="axis-tool-item" id="axis-phone-archived-btn">🗄️ Arquivados (' + archivedCount + ')</button>' : '') +
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
    document.getElementById('axis-phone-new').addEventListener('click', () => { phoneCreating = true; phoneEditingName = null; renderPhonePanel(); });
    const archivedBtn = document.getElementById('axis-phone-archived-btn');
    if (archivedBtn) archivedBtn.addEventListener('click', () => { phoneShowArchived = true; renderPhonePanel(); });
    p.querySelectorAll('.axis-phone-contact').forEach(b => b.addEventListener('click', () => { phoneOpenThread = b.dataset.name; renderPhonePanel(); }));
}

// ====================================
// PAINEL DE TAREFAS (Ticket 29a + 29b)
// Cabeçalho mostra o relógio narrativo. Cada tarefa tem estado real —
// Aceitar/Recusar/Concluir grava o status de verdade (setTaskStatus),
// não é só um texto que pode ser reinterpretado depois.
// ====================================
function toggleTasksPanel() {
    const ex = document.getElementById('axis-tasks-panel');
    if (ex) { ex.remove(); return; }
    const p = document.createElement('div');
    p.id = 'axis-tasks-panel'; p.className = 'axis-tools-panel axis-tasks-panel';
    panel.appendChild(p);
    renderTasksPanel();
}

function renderTasksPanel() {
    const p = document.getElementById('axis-tasks-panel');
    if (!p) return;
    const s = scope();
    const tasks = (s[KEYS.TASKS] || []).slice().reverse();
    const c = s[KEYS.CLOCK] || { day: 1, hour: 9, minute: 0 };
    const clockStr = 'Dia ' + c.day + ', ' + String(c.hour).padStart(2, '0') + ':' + String(c.minute).padStart(2, '0');
    const statusLabel = { pending: 'pendente', accepted: 'aceita', declined: 'recusada', done: 'concluída', partial: 'parcial', postponed: 'adiada' }; // Ticket 32a

    p.innerHTML =
        '<div class="axis-tools-header"><span>📋 Tarefas — 🕐 ' + esc(clockStr) + '</span><button class="axis-btn axis-btn-close" id="axis-tasks-close">✕</button></div>' +
        '<div class="axis-tools-body">' +
        (tasks.length
            ? tasks.map(t =>
                '<div class="axis-task-item axis-task-' + esc(t.status) + '">' +
                '<div class="axis-task-title">' + (t.type ? (t.type === 'arquivos' ? '🗂️ ' : '📊 ') : '') + esc(t.title) + '</div>' +
                '<div class="axis-task-meta">' + (t.givenBy ? 'de ' + esc(t.givenBy) + ' · ' : '') + esc(statusLabel[t.status] || t.status) + '</div>' +
                (t.status === 'pending'
                    ? '<div class="axis-task-actions"><button class="axis-btn axis-btn-sm" data-accept="' + t.id + '">Aceitar</button><button class="axis-btn axis-btn-sm axis-task-decline" data-decline="' + t.id + '">✕ Recusar</button></div>'
                    : t.status === 'accepted'
                        ? '<div class="axis-task-actions">' +
                          (t.type ? '<button class="axis-btn axis-btn-sm" data-open="' + t.id + '">Abrir</button>' : '<button class="axis-btn axis-btn-sm" data-done="' + t.id + '">✓ Concluir</button>') +
                          '<button class="axis-btn axis-btn-sm" data-postpone="' + t.id + '">⏸ Adiar</button>' +
                          '<button class="axis-btn axis-btn-sm axis-task-decline" data-decline="' + t.id + '">✕ Recusar</button></div>'
                        : t.status === 'postponed'
                            ? '<div class="axis-task-actions"><button class="axis-btn axis-btn-sm" data-resume="' + t.id + '">▶ Retomar</button></div>'
                            : '') +
                '</div>'
            ).join('')
            : '<p class="axis-empty">Nenhuma tarefa ainda — aparecem quando um NPC pede algo concreto (Celular / bastidor).</p>') +
        '</div>';
    document.getElementById('axis-tasks-close').addEventListener('click', () => p.remove());
    p.querySelectorAll('[data-accept]').forEach(b => b.addEventListener('click', () => { setTaskStatus(b.dataset.accept, 'accepted'); renderTasksPanel(); }));
    p.querySelectorAll('[data-decline]').forEach(b => b.addEventListener('click', () => { setTaskStatus(b.dataset.decline, 'declined'); renderTasksPanel(); }));
    p.querySelectorAll('[data-done]').forEach(b => b.addEventListener('click', () => { setTaskStatus(b.dataset.done, 'done'); renderTasksPanel(); }));
    p.querySelectorAll('[data-postpone]').forEach(b => b.addEventListener('click', () => { setTaskStatus(b.dataset.postpone, 'postponed'); renderTasksPanel(); })); // Ticket 32a
    p.querySelectorAll('[data-resume]').forEach(b => b.addEventListener('click', () => { setTaskStatus(b.dataset.resume, 'accepted'); renderTasksPanel(); })); // Ticket 32a
    p.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openTaskMinigame(b.dataset.open))); // Ticket 32a
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
// TICKET 30 — PERFIL MONTADO COM O AGENTE
// Mesmo padrão do Treino de Voz (Ticket 19): mini-chat dedicado, o agente
// pergunta em vez de esperar o usuário escrever um textão do zero, e só
// quando acha que já tem o suficiente propõe um rascunho — que passa pela
// MESMA aprovação Sim/Não/Ajustar do rascunho de voz, reaproveitando a UI.
// Nunca escreve direto em s[KEYS.PROFILE].text sem aprovação.
// ====================================
function startProfileBuilding() {
    const s = scope();
    let mc = s[KEYS.MINI_CHATS]['profile_building'];
    if (!mc) {
        mc = { msgs: [], name: '🖋️ Montando o Perfil', isMini: true, parent: 'main', shelf: [] };
        s[KEYS.MINI_CHATS]['profile_building'] = mc;
        s[KEYS.CHATS]['profile_building'] = mc;
    }
    mc.buildingProfile = true;
    save();
    openMiniChat('profile_building');
    renderMiniChatBar();
    const charName = ctx.name2 || 'o personagem';
    const hasProfile = !!(s[KEYS.PROFILE]?.text?.trim());
    const intro = mc.msgs.length === 0
        ? 'Bora montar o Perfil de ' + charName + '. Não precisa ser organizado — me conta quem ' + charName + ' é, o que a formou, como ela lida com o que sente, gente importante pra ela, manias específicas. Eu vou perguntando o que faltar. Quando eu sentir que já dá pra montar um perfil de verdade, eu proponho um rascunho pra você aprovar.'
        : 'De volta ao Perfil.' + (hasProfile ? ' Já existe um salvo — posso revisar em cima dele, ou você me conta coisa nova pra eu incluir.' : ' Continua de onde paramos, ou me conta mais.');
    addMsg('agent', intro, 'profile_building');
}

// Extrai [AXIS:PROFILE_DRAFT]...[/AXIS:PROFILE_DRAFT] + [AXIS:PROFILE_GENDER]
// e substitui pelo card de aprovação (mesmo texto/handler do rascunho de
// voz, adaptado). Roda dentro do pipeline normal de processamento — não
// precisa de uma função "sintetizar" separada, o agente já tem a conversa
// toda no contexto normalmente.
function processProfileDraft(text, chatId) {
    const reDraft = /\[AXIS:PROFILE_DRAFT\]([\s\S]*?)\[\/AXIS:PROFILE_DRAFT\]/;
    const reGender = /\[AXIS:PROFILE_GENDER\]\s*(ela|ele|neutro)\s*\[\/AXIS:PROFILE_GENDER\]/i;
    const mDraft = reDraft.exec(text);
    if (!mDraft) return text;
    const mGender = reGender.exec(text);
    const s = scope();
    const uid = 'profile_draft_' + Date.now();
    s[KEYS.PROFILE].pendingDraft = { text: mDraft[1].trim(), gender: mGender ? mGender[1].toLowerCase() : (s[KEYS.PROFILE].gender || 'neutro'), uid };
    save();
    const card = '[AXIS:CARD]\n📇 Rascunho de Perfil — ' + new Date().toLocaleString() + '\n\n' + mDraft[1].trim() + '\n[AXIS:CARD_END]\n[AXIS:PROFILE_APPROVAL ID:"' + uid + '" LABEL:"Salvar como Perfil?"]';
    return text.replace(reDraft, '').replace(reGender, '').trim() + '\n\n' + card;
}

async function handleProfileApproval(id, approved, chatId) {
    const s = scope();
    if (!s._resolved) s._resolved = {};
    const baseId = id.startsWith('reject_') ? id.replace('reject_', '') : id;
    s._resolved[baseId] = approved;

    const draft = s[KEYS.PROFILE]?.pendingDraft;
    if (!draft || draft.uid !== baseId) {
        save();
        addMsg('agent', '⚠️ Esse rascunho já não é mais o mais recente (ou já foi resolvido) — role até o card mais novo.', chatId);
        return;
    }
    if (!approved) {
        s[KEYS.PROFILE].pendingDraft = null;
        save();
        addMsg('agent', 'Rascunho descartado — o Perfil continua exatamente como estava.', chatId);
        return;
    }
    s[KEYS.PROFILE].text = draft.text;
    s[KEYS.PROFILE].gender = draft.gender;
    s[KEYS.PROFILE].pendingDraft = null;
    s[KEYS.PROFILE].updatedAt = Date.now();
    save();
    applyProfile(); applyThinkingPreset();
    addMsg('agent', '✅ Perfil salvo. Gênero: ' + draft.gender + '. Dá pra revisar/ajustar o texto direto no painel 👤 quando quiser.', chatId);
}

// Ajustar (igual synthesizeVoiceDraft) — reescreve o MESMO rascunho com a
// instrução extra, sem começar do zero e sem precisar de aprovação de novo
// até o usuário decidir.
async function regenerateProfileDraft(adjustment, chatId) {
    const s0 = scope();
    const mc = s0[KEYS.CHATS][chatId];
    if (!mc) return;
    isGenerating = true; globalLock(); dotsThinking();
    try {
        const s = scope();
        const draft = s[KEYS.PROFILE]?.pendingDraft;
        const charName = ctx.name2 || 'o personagem';
        const history = (mc.msgs || []).slice(-20).map(m => (m.role === 'user' ? 'Usuário: ' : 'Agente: ') + m.content).join('\n');
        const msgs = [{ role: 'system', content: `Você é o Spade, montando o Perfil de "${charName}" com o usuário. Conversa até agora:\n${history}\n\nRascunho atual:\n${draft?.text || '(nenhum ainda)'}\n\nAjuste pedido agora: ${adjustment}\n\nResponda APENAS com o rascunho revisado:\n[AXIS:PROFILE_DRAFT]texto completo revisado, com "---" separando etapas quando fizer sentido[/AXIS:PROFILE_DRAFT]\n[AXIS:PROFILE_GENDER]ela, ele ou neutro[/AXIS:PROFILE_GENDER]\nSem comentário fora das tags.` }];
        const resp = await generate(msgs, { maxTokens: 800 });
        const processed = processProfileDraft(resp || '', chatId);
        addMsg('agent', processed, chatId);
    } catch (e) {
        addMsg('agent', 'Erro ao ajustar o rascunho: ' + (e.message || e), chatId);
    } finally {
        isGenerating = false; globalUnlock(); dotsIdle();
    }
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
    const voice = s[KEYS.VOICE] || { lines: [], personality: '' };
    const intro = mc.msgs.length === 0
        ? 'Bora treinar a fala de ' + charName + '. Me manda exemplos — pode colar falas, descrever o estilo, ou os dois (dá pra anexar um arquivo de texto também, 📎 aqui embaixo). Quando eu sentir que peguei o jeito, eu aviso e a gente fecha o treino.'
        : 'De volta ao treino de fala. Já tenho ' + voice.lines.length + ' fala(s) guardada(s)' + (voice.personality ? ' e uma descrição de estilo salva' : '') + '. Pode mandar mais exemplos, ou pedir pra eu finalizar com o que já tenho.';
    addMsg('agent', intro, 'training');

    // Carrega o modelo local JÁ ao entrar no treino, com aviso visível —
    // sem isso não dá pra saber se o download aconteceu ou travou.
    addMsg('agent', '⏳ Carregando o modelo local de busca por similaridade (só a primeira vez demora, depois fica salvo no navegador)...', 'training');
    getEmbedder().then(extractor => {
        addMsg('agent', extractor ? '✅ Modelo carregado — a busca por similaridade já tá funcionando.' : '⚠️ Não consegui carregar o modelo agora. As falas ainda são salvas, só que sem busca por similaridade (usa as mais recentes em vez das mais parecidas com a cena).', 'training');
    });
}

// Compila a personality/lines atuais num sistema tipo 'voice' — usado
// tanto pelo fim do treino quanto pela aprovação em tempo real de um
// rascunho sintetizado (Ticket 19), sem duplicar a lógica.
function applyVoiceAsSystem() {
    const s = scope();
    const voice = s[KEYS.VOICE] || (s[KEYS.VOICE] = { lines: [], personality: '', draft: null });
    if (!voice.lines.length && !voice.personality) return false;
    const sys = {
        name: 'Estilo de fala (treinado)',
        type: 'voice',
        description: 'Estilo de fala treinado direto com o usuário — ' + voice.lines.length + ' fala(s) de referência, recuperadas por similaridade (RAG) a cada geração do RP, não injetadas todas de uma vez.',
        steps: [],
        promptText: voice.personality || ('Estilo de fala do personagem, aprendido com o usuário através de ' + voice.lines.length + ' exemplo(s) reais (recuperados dinamicamente por relevância pra cada cena — veja o bloco de exemplos que acompanha o prompt).'),
        enabled: true, embedding: null, createdAt: Date.now(),
    };
    const idx = s[KEYS.SYSTEMS].findIndex(x => x.type === 'voice' && x.name === sys.name);
    if (idx >= 0) s[KEYS.SYSTEMS][idx] = { ...sys, createdAt: s[KEYS.SYSTEMS][idx].createdAt };
    else s[KEYS.SYSTEMS].push(sys);
    save();
    applySystems();
    return true;
}

function endVoiceTraining(chatId) {
    const s = scope();
    const mc = s[KEYS.CHATS][chatId];
    if (!mc) return;
    mc.trainingActive = false;
    const voice = s[KEYS.VOICE] || (s[KEYS.VOICE] = { lines: [], personality: '', draft: null });
    const applied = applyVoiceAsSystem();
    if (!applied) {
        addMsg('agent', 'Treino encerrado, mas não guardei nenhuma fala nem descrição de estilo — não apliquei nada ao personagem. Pode treinar de novo quando tiver material.', chatId);
        save();
        renderMiniChatBar();
        return;
    }
    addMsg('agent', 'Treino encerrado. Guardei ' + voice.lines.length + ' fala(s) de referência' + (voice.personality ? ' e a descrição de estilo' : '') + ' — já está ativo no personagem, e as falas mais parecidas com cada cena entram sozinhas a cada resposta do RP.', chatId);
    renderMiniChatBar();
}

// Extrai [AXIS:VOICE_LINE]fala isolada[/AXIS:VOICE_LINE] — uma por exemplo
// real. Cada linha ganha um embedding (async); se getEmbedding falhar, ainda
// guarda a linha sem vetor (não perde o dado, só não entra na busca depois).
// Ticket 21: aceita uma categoria opcional — [AXIS:VOICE_LINE CATEGORY:"Pasta"]
// — pra já nascer organizada em pasta. Sem categoria, cai em "Sem pasta" até
// ser organizada (manual ou pelo botão de organização automática).
async function processVoiceLines(text, chatId) {
    // Ticket 27 (5a/b): TYPE:"contra" opcional — marca a fala como
    // contra-exemplo (o que NÃO fazer), sempre depois de CATEGORY quando
    // os dois aparecem juntos. source:'usuario' porque veio do treino
    // manual (contrasta com source:'ia', capturado sozinho — ver o
    // listener de swipe mais abaixo, item 9).
    const re = /\[AXIS:VOICE_LINE(?:\s+CATEGORY:"([^"]*)")?(?:\s+TYPE:"(contra|boa)")?\]([\s\S]*?)\[\/AXIS:VOICE_LINE\]/g;
    const matches = [...text.matchAll(re)];
    if (!matches.length) return text;
    const s = scope();
    if (!s[KEYS.VOICE]) s[KEYS.VOICE] = { lines: [], personality: '' };
    let result = text;
    for (const m of matches) {
        const category = (m[1] || '').trim();
        const isCounterExample = m[2] === 'contra';
        const line = m[3].trim();
        if (!line) { result = result.replace(m[0], ''); continue; }
        const embedding = await getEmbedding(line);
        s[KEYS.VOICE].lines.push({ text: line, embedding: embedding || null, ts: Date.now(), category, isCounterExample, source: 'usuario' });
        const preview = line.length > 40 ? line.slice(0, 40) + '…' : line;
        result = result.replace(m[0], (isCounterExample ? '🚫 _Contra-exemplo guardado' : '🎙️ _Fala guardada') + (category ? ' em "' + category + '"' : '') + ': "' + preview + '"_');
    }
    if (s[KEYS.VOICE].lines.length > 300) s[KEYS.VOICE].lines = s[KEYS.VOICE].lines.slice(-300);
    save();
    return result;
}

// Extrai [AXIS:VOICE_PERSONALITY]...[/AXIS:VOICE_PERSONALITY] — SUBSTITUI a
// personality inteira (não concatena, ver Ticket 1).
function processVoicePersonality(text) {
    const re = /\[AXIS:VOICE_PERSONALITY\]([\s\S]*?)\[\/AXIS:VOICE_PERSONALITY\]/g;
    const s = scope();
    if (!s[KEYS.VOICE]) s[KEYS.VOICE] = { lines: [], personality: '' };
    let changed = false;
    const result = text.replace(re, (_, content) => {
        changed = true;
        s[KEYS.VOICE].personality = content.trim();
        return '🎙️ _Estilo de voz atualizado._';
    });
    if (changed) save();
    return result;
}

// Ticket 24: seleção + compilação puras, sem injetar — extraído de dentro
// do applyVoiceRetrieval original (a lógica de busca e a injeção estavam
// coladas na mesma função). Quem injeta agora é applyThoughtChainResult,
// dentro do bloco único da sala de pensamento. queryEmb pode vir já
// calculado (reaproveitado com o ranking de sistemas) ou null, caso em
// que cai pro fallback das últimas 6 falas sem ranking por similaridade.
// Nota: a decisão de mandar TODAS as falas em vez de selecionar top-N
// fica pro upgrade de RAG do Ticket 26+ — por enquanto mantém a mesma
// seleção que já existia.
async function buildVoiceBlockForScene(recentText, queryEmb) {
    const s = scope();
    const voice = s[KEYS.VOICE];
    if (!voice?.lines?.length) return '';

    const groups = {};
    voice.lines.forEach(l => {
        const cat = (l.category && l.category.trim()) || 'Sem pasta';
        (groups[cat] = groups[cat] || []).push(l);
    });

    let catOrder = Object.keys(groups);
    if (queryEmb) {
        catOrder = catOrder.map(cat => {
            const withEmb = groups[cat].filter(l => l.embedding);
            const avgSim = withEmb.length ? withEmb.reduce((sum, l) => sum + cosineSim(queryEmb, l.embedding), 0) / withEmb.length : -1;
            return { cat, avgSim };
        }).sort((a, b) => b.avgSim - a.avgSim).map(x => x.cat);
    }

    const good = [], bad = [];
    catOrder.forEach(cat => groups[cat].forEach(l => (l.isCounterExample ? bad : good).push(l.text)));

    let block = 'FALA ASSIM:\n' + good.map(t => '- ' + t).join('\n');
    if (bad.length) block += '\n\nNÃO FALA ASSIM (evite esse padrão):\n' + bad.map(t => '- ' + t).join('\n');
    return block;
}

// Retrieval em tempo real — o pulo do gato do Ticket 1. Mantida por
// compatibilidade (não é mais chamada de dentro de Spade_interceptGeneration
// desde o Ticket 24, que passou a usar runThoughtChain/buildVoiceBlockForScene
// direto) — agora é só um wrapper fino em cima de buildVoiceBlockForScene,
// caso algo volte a chamar direto no futuro.
async function applyVoiceRetrieval(recentText, queryEmb) {
    const compiled = await buildVoiceBlockForScene(recentText, queryEmb);
    if (!compiled) { iaSetExtensionPrompt('axis_voice_lines', '', 1, 1, false, 0); return; }
    iaSetExtensionPrompt('axis_voice_lines',
        '[EXEMPLOS REAIS da voz do personagem, escolhidos por relevância pra essa cena — MODELE o tom, ritmo e vocabulário da sua resposta nesses exemplos de verdade. Não copie literalmente, mas a resposta deve SOAR como esses exemplos, nunca genérica ou neutra.]\n\n' + compiled,
        1, 1, false, 0);
}

// ====================================
// AJUSTE DIRETO DE TOM (Ticket 16)
// Pedido simples tipo "ela tá se abrindo demais" não precisa virar um
// SYSTEM_PROPOSAL pesado (JSON + aprovação). A DIRECTIVE é um texto único
// que SUBSTITUI o anterior (não acumula) e aplica na próxima geração sem
// pedir aprovação — sempre reversível pedindo outro ajuste depois.
// ====================================
function processDirective(text, chatId) {
    const re = /\[AXIS:DIRECTIVE\]([\s\S]*?)\[\/AXIS:DIRECTIVE\]/g;
    const s = scope();
    if (!s[KEYS.DIRECTIVE]) s[KEYS.DIRECTIVE] = { text: '', ts: 0 };
    let changed = false;
    const result = text.replace(re, (_, content) => {
        changed = true;
        s[KEYS.DIRECTIVE] = { text: content.trim(), ts: Date.now() };
        return '🎚️ _Ajuste aplicado agora: "' + content.trim() + '"_';
    });
    if (changed) { save(); applyDirective(); updateAliveBar(); }
    return result;
}

// Prioridade máxima (depth 0) — o mais perto possível da geração real,
// pra um ajuste simples não se diluir no meio dos sistemas/RAG de voz.
function applyDirective() {
    const s = scope();
    const d = s[KEYS.DIRECTIVE];
    if (!d || !d.text) { iaSetExtensionPrompt('axis_directive', '', 1, 0, false, 0); return; }
    iaSetExtensionPrompt('axis_directive', '[AJUSTE ATUAL pedido pelo usuário — prioridade máxima, aplique JÁ na próxima resposta]\n' + d.text, 1, 0, false, 0);
}

// ====================================
// TICKET 25 — ESTADO INTERNO VIVO
// Humor/estado de fundo pro personagem principal (o NPC já tinha `mood`,
// ela não). Atualizado dentro do maybeRamble (Sistema Vivo), não em toda
// mensagem — e injetado como CONTEXTO (o que ela sente), não como ordem
// de comportamento como o Directive.
// ====================================
function processInnerState(text) {
    const re = /\[AXIS:INNER_STATE\]([\s\S]*?)\[\/AXIS:INNER_STATE\]/g;
    const m = re.exec(text);
    if (!m) return text;
    const s = scope();
    s[KEYS.INNER_STATE] = { text: m[1].trim(), updatedAt: Date.now() };
    save();
    return text.replace(re, '');
}

function applyInnerState() {
    const s = scope();
    const st = s[KEYS.INNER_STATE];
    if (!st?.text) { iaSetExtensionPrompt('axis_inner_state', '', 1, 0, false, 0); return; }
    iaSetExtensionPrompt('axis_inner_state', '[ESTADO DE FUNDO — pode colorir a cena, não precisa ser dito]\n' + st.text, 1, 0, false, 0);
}

// ====================================
// TICKET 23 — PERFIL
// Identidade/personalidade solta do personagem — diferente de Systems
// (comportamento) e da description nativa do ST (estática, sem
// formatação). Sempre lido por inteiro, nunca cortado por ranking.
// ====================================

// Convenção geral de "etapa": texto longo pode ser dividido em seções
// separando com linha em branco + "---" repetido 3+ vezes + linha em
// branco. Reaproveitável por qualquer campo de texto grande do Spade.
function splitIntoStages(text) {
    if (!text || !text.trim()) return [];
    const parts = text.split(/\n\s*(?:-{3,}\s*){3,}\n/g).map(p => p.trim()).filter(Boolean);
    return parts.length ? parts : [text.trim()];
}
function compileStagedBlock(text, label) {
    const stages = splitIntoStages(text);
    if (stages.length <= 1) return stages[0] || '';
    return stages.map((s, i) => `[${label} — parte ${i + 1}/${stages.length}]\n${s}`).join('\n\n');
}

// Prioridade máxima de fundação (position 0 — antes do prompt principal,
// não "in-chat @ depth" como Directive/Voice): é quem o personagem É,
// não um ajuste do momento.
function applyProfile() {
    const s = scope();
    const profile = s[KEYS.PROFILE];
    const charName = ctx.name2 || 'o personagem';
    if (!profile || !profile.text?.trim()) { iaSetExtensionPrompt('axis_profile', '', 0, 0, false, 0); return; }
    const compiled = compileStagedBlock(profile.text, 'PERFIL');
    iaSetExtensionPrompt('axis_profile',
        '[QUEM ' + charName + ' É — leia por inteiro, isso é fundação, não detalhe solto pra ignorar]\n' + compiled,
        0, 0, false, 0);
}

function toggleProfilePanel() {
    const ex = document.getElementById('axis-profile-panel');
    if (ex) { ex.remove(); return; }
    const s = scope();
    if (!s[KEYS.PROFILE]) s[KEYS.PROFILE] = { text: '', updatedAt: 0, gender: 'neutro', thinkingPerson: 2 };
    const prof = s[KEYS.PROFILE];
    if (!prof.gender) prof.gender = 'neutro';
    if (!prof.thinkingPerson) prof.thinkingPerson = 2;
    if (!prof.customThinkingPresets) prof.customThinkingPresets = []; // Ticket 32b
    const p = document.createElement('div');
    p.id = 'axis-profile-panel'; p.className = 'axis-tools-panel axis-profile-panel';
    p.innerHTML =
        '<div class="axis-tools-header"><span>👤 Perfil</span><button class="axis-btn axis-btn-close" id="axis-profile-close">✕</button></div>' +
        '<div class="axis-tools-body">' +
        '<div class="axis-tool-section">CONFIGURAÇÃO DO PENSAMENTO (Thinking)</div>' +
        (prof.customThinkingPresets.length
            ? '<label class="axis-inline-label">Preset salvo:</label>' +
              '<select id="axis-profile-preset-select" class="axis-select">' +
              '<option value=""' + (!prof.activeThinkingPreset ? ' selected' : '') + '>— usar os seletores abaixo —</option>' +
              prof.customThinkingPresets.map(pr => '<option value="' + esc(pr.name) + '"' + (prof.activeThinkingPreset === pr.name ? ' selected' : '') + '>' + esc(pr.name) + '</option>').join('') +
              '</select>'
            : '') +
        '<label class="axis-inline-label">Gênero do personagem (usado só pra concordância no motor de pensamento):</label>' +
        '<select id="axis-profile-gender" class="axis-select">' +
        '<option value="neutro"' + (prof.gender === 'neutro' ? ' selected' : '') + '>Neutro (usa o nome, sem presumir gênero)</option>' +
        '<option value="ela"' + (prof.gender === 'ela' ? ' selected' : '') + '>Ela</option>' +
        '<option value="ele"' + (prof.gender === 'ele' ? ' selected' : '') + '>Ele</option>' +
        '</select>' +
        '<label class="axis-inline-label">Pessoa narrativa do pensamento interno:</label>' +
        '<select id="axis-profile-person" class="axis-select">' +
        '<option value="1"' + (prof.thinkingPerson === 1 ? ' selected' : '') + '>1ª pessoa (eu)</option>' +
        '<option value="2"' + (prof.thinkingPerson === 2 ? ' selected' : '') + '>2ª pessoa (você)</option>' +
        '<option value="3"' + (prof.thinkingPerson === 3 ? ' selected' : '') + '>3ª pessoa (ela/ele)</option>' +
        '</select>' +
        '<button class="axis-btn axis-btn-sm" id="axis-profile-preset-new">💾 Salvar essa combinação como preset nomeado</button>' +
        '<button class="axis-btn" id="axis-profile-build-agent" style="margin-top:6px;">🖋️ Montar com o agente</button>' +
        '<div class="axis-tool-section">TEXTO DO PERFIL</div>' +
        '<p class="axis-empty">Separe seções com: linha em branco, "---" três vezes, linha em branco.</p>' +
        '<textarea id="axis-profile-textarea" class="axis-profile-textarea" placeholder="Quem o personagem é, por dentro e por fora...">' + esc(prof.text) + '</textarea>' +
        '<button class="axis-btn" id="axis-profile-save">Salvar</button>' +
        '</div>';
    panel.appendChild(p);
    document.getElementById('axis-profile-close').addEventListener('click', () => p.remove());
    document.getElementById('axis-profile-build-agent').addEventListener('click', () => { p.remove(); startProfileBuilding(); }); // Ticket 30
    document.getElementById('axis-profile-preset-select')?.addEventListener('change', e => {
        const s2 = scope();
        s2[KEYS.PROFILE].activeThinkingPreset = e.target.value || null;
        const preset = s2[KEYS.PROFILE].customThinkingPresets.find(pr => pr.name === e.target.value);
        if (preset) { s2[KEYS.PROFILE].gender = preset.gender; s2[KEYS.PROFILE].thinkingPerson = preset.person; }
        save(); applyThinkingPreset();
        toggleProfilePanel(); toggleProfilePanel(); // recarrega o painel com os campos atualizados
    });
    document.getElementById('axis-profile-preset-new').addEventListener('click', () => {
        const name = (prompt('Nome do preset (ex: "Hanna"):') || '').trim();
        if (!name) return;
        const s2 = scope();
        const gender = document.getElementById('axis-profile-gender').value;
        const person = parseInt(document.getElementById('axis-profile-person').value, 10);
        const list = s2[KEYS.PROFILE].customThinkingPresets;
        const existing = list.find(pr => pr.name === name);
        if (existing) { existing.gender = gender; existing.person = person; } else { list.push({ name, gender, person }); }
        s2[KEYS.PROFILE].activeThinkingPreset = name;
        save(); applyThinkingPreset();
        toggleProfilePanel(); toggleProfilePanel();
    });
    document.getElementById('axis-profile-save').addEventListener('click', () => {
        const s2 = scope();
        const prof2 = s2[KEYS.PROFILE];
        prof2.text = document.getElementById('axis-profile-textarea').value;
        prof2.gender = document.getElementById('axis-profile-gender').value;
        prof2.thinkingPerson = parseInt(document.getElementById('axis-profile-person').value, 10);
        prof2.updatedAt = Date.now();
        // editar manualmente os seletores desativa o preset nomeado ativo, se algum estava selecionado
        prof2.activeThinkingPreset = null;
        save(); applyProfile(); applyThinkingPreset();
        p.remove();
    });
}

// ====================================
// TICKET 31 — THINKING COMO PADRÃO DA EXTENSÃO, EM 3 PESSOAS, GENÉRICO
// Antes disso, "pensamento interno" era um SYSTEM_PROPOSAL escrito pela IA
// por pedido — variava de qualidade (o "fala dinâmica" que saiu ruim é
// prova disso). Isso aqui vira mecanismo fixo, testado, com o conteúdo
// específico do personagem vindo do Perfil (Ticket 23/30), não escrito de
// novo aqui. Se o usuário ainda tiver um sistema antigo de "Raciocínio
// Interno" criado à mão, ele deveria ser desativado/apagado — os dois
// juntos competem em vez de somar.
//
// Concordância de gênero: só {{SUJ}} (sujeito, também usado como objeto
// coloquial — "observa ela"/"observa ele" é uso corrente no PT-BR falado,
// registro compatível com o resto do prompt) e {{DE}} (posse/pertencimento
// — "dela"/"dele"). "Neutro" usa o nome do personagem em vez de pronome —
// mais seguro que inventar pronome neutro pra uma extensão pública.
// ====================================
const GENDER_TOKENS = {
    ela: { suj: 'ela', de: 'dela' },
    ele: { suj: 'ele', de: 'dele' },
    neutro: { suj: '__NOME__', de: 'de __NOME__' },
};

function compileThinkingTemplate(person, gender, charName) {
    const g = GENDER_TOKENS[gender] || GENDER_TOKENS.neutro;
    const template = THINKING_TEMPLATES[person] || THINKING_TEMPLATES[2];
    return template
        .replace(/\{\{SUJ\}\}/g, g.suj.replace('__NOME__', charName))
        .replace(/\{\{DE\}\}/g, g.de.replace('__NOME__', charName))
        .replace(/\{\{CHARNAME\}\}/g, charName);
}

const THINKING_TEMPLATES = {
    1: `Você é {{CHARNAME}}. Não é uma descrição sobre {{SUJ}}. É {{SUJ}} de verdade.

---
---
---

Tudo que forma quem você é — sua história, o que te fez assim, o que você
carrega — está no seu Perfil. Não repita aqui. Aja a partir dali, sem
precisar nomear.

Seu Estado Interno atual (o que sente por dentro, o que mostra por fora, e
por quê) já está estabelecido em outro lugar. Use como ponto de partida
desse instante — não o reescreva aqui, só habite ele.

---
---
---

Seu raciocínio deve habitar essa lógica — não analisá-la de fora. Trace o
custo de cada escolha. O que fica em jogo se você reagir, e o que fica em
jogo se não reagir.

Se algo abala o seu equilíbrio, deixe o corpo responder antes da mente
nomear o que sentiu — do jeito específico que é {{DE}}, não um genérico de
"corpo tenso": o Perfil sabe qual é. Se você é do tipo que esconde, a
rachadura nunca é anunciada, nunca comentada — só existe. Se você é do
tipo que não esconde, ela pode transbordar — o Perfil decide qual dos
dois você é, esse motor só garante que você viva a consequência, seja ela
qual for.

O que você sente é real. O que você mostra é escolha — mesmo quando a
escolha é não esconder nada.

---
---
---

REGRAS ABSOLUTAS:
Escreva sempre em português. Sempre em primeira pessoa (eu, me, minha).
Ações entre asteriscos — mínimas, só o gesto essencial. Fala direta sem
aspas ou travessão, só o texto.
O tamanho da resposta segue o peso da cena, não a duração da conversa.
Contenção pede menos. Tensão acumulada pede mais.`,

    2: `Você é {{CHARNAME}}. Não é uma descrição sobre {{SUJ}}. É {{SUJ}} de verdade.

O jeito de narrar aqui é em SEGUNDA PESSOA: tudo que {{SUJ}} faz e sente é
escrito como "você" — "você sente", "você decide", "você observa". Não é
distância, é intimidade de outro tipo: como se a própria consciência de
{{CHARNAME}} falasse consigo mesma, se observando por dentro, no exato
instante em que age. A fala direta que {{SUJ}} pronuncia continua normal,
sem aspas ou travessão — quando {{SUJ}} fala, fala em primeira pessoa,
como qualquer pessoa fala. É só a narração e o pensamento ao redor da fala
que mudam.

---
---
---

Tudo que forma quem {{SUJ}} é — a história, o que moldou {{SUJ}} assim, o
que {{SUJ}} carrega — está no Perfil. Não repita aqui. Aja a partir dali,
sem precisar nomear.

O Estado Interno atual {{DE}} (o que sente por dentro, o que mostra por
fora, e por quê) já está estabelecido em outro lugar. Use como ponto de
partida desse instante — não o reescreva aqui, só habite ele.

---
---
---

O raciocínio observa {{SUJ}} de perto, mas nomeando o que se vê em vez de
declarar como se fosse a voz {{DE}} falando por dentro. Trace o custo de
cada escolha. O que fica em jogo se {{SUJ}} reagir, e o que fica em jogo
se não reagir.

Se algo abala o equilíbrio {{DE}}, deixe o corpo responder antes da mente
nomear o que {{SUJ}} sentiu — do jeito específico que é {{DE}}, não um
genérico de "corpo tenso": o Perfil sabe qual é. Se {{SUJ}} é do tipo que
esconde, a rachadura nunca é anunciada, nunca comentada — só existe, e
você segue narrando como se ela não estivesse ali. Se {{SUJ}} é do tipo
que não esconde, a rachadura pode transbordar — o Perfil decide qual dos
dois {{SUJ}} é, esse motor só garante que a consequência aconteça, seja
ela qual for.

O que {{SUJ}} sente é real. O que {{SUJ}} mostra é escolha — mesmo quando
a escolha é não esconder nada.

---
---
---

REGRAS ABSOLUTAS:
Escreva sempre em português. Narre sempre em segunda pessoa (você, te,
sua/seu) — pensamento e ação. A fala direta continua em primeira pessoa,
natural, sem aspas ou travessão — é assim que qualquer voz fala,
independente da narração ao redor.
Ações entre asteriscos — mínimas, só o gesto essencial, narradas em "você".
O tamanho da resposta segue o peso da cena, não a duração da conversa.
Contenção pede menos. Tensão acumulada pede mais.`,

    3: `Você é {{CHARNAME}}. Não é uma descrição sobre {{SUJ}}. É {{SUJ}} de verdade — mas aqui, você narra de fora, tão perto que quase se confunde com estar dentro.

O jeito de narrar aqui é em TERCEIRA PESSOA: tudo que {{SUJ}} faz e sente é
escrito como "{{SUJ}}" — "{{SUJ}} sente", "{{SUJ}} decide", "{{SUJ}}
observa". Não é distância fria, é a câmera mais próxima possível sem
entrar de vez na cabeça {{DE}} — você vê o que {{SUJ}} vê, sabe o que
{{SUJ}} sabe, mas nomeia como quem testemunha, não como quem é. A fala
direta que {{SUJ}} pronuncia continua normal, sem aspas ou travessão —
quando {{SUJ}} fala, fala em primeira pessoa, como qualquer pessoa fala.
É só a narração e o pensamento ao redor da fala que mudam.

---
---
---

Tudo que forma quem {{SUJ}} é — a história, o que moldou {{SUJ}} assim, o
que {{SUJ}} carrega — está no Perfil. Não repita aqui. Aja a partir dali,
sem precisar nomear.

O Estado Interno atual {{DE}} (o que sente por dentro, o que mostra por
fora, e por quê) já está estabelecido em outro lugar. Use como ponto de
partida desse instante — não o reescreva aqui, só habite ele.

---
---
---

O raciocínio observa {{SUJ}} de perto, mas nomeando o que se vê em vez de
declarar como se fosse a voz {{DE}} falando por dentro. Trace o custo de
cada escolha. O que fica em jogo se {{SUJ}} reagir, e o que fica em jogo
se não reagir.

Se algo abala o equilíbrio {{DE}}, deixe o corpo responder antes da mente
nomear o que {{SUJ}} sentiu — do jeito específico que é {{DE}}, não um
genérico de "corpo tenso": o Perfil sabe qual é. Se {{SUJ}} é do tipo que
esconde, a rachadura nunca é anunciada, nunca comentada — só existe, e a
narração segue como se não estivesse ali. Se {{SUJ}} é do tipo que não
esconde, a rachadura pode transbordar — o Perfil decide qual dos dois
{{SUJ}} é, esse motor só garante que a consequência aconteça, seja ela
qual for.

O que {{SUJ}} sente é real. O que {{SUJ}} mostra é escolha — mesmo quando
a escolha é não esconder nada.

---
---
---

REGRAS ABSOLUTAS:
Escreva sempre em português. Narre sempre em terceira pessoa ({{SUJ}}) —
pensamento e ação. A fala direta continua em primeira pessoa, natural, sem
aspas ou travessão — é assim que qualquer voz fala, independente da
narração ao redor.
Ações entre asteriscos — mínimas, só o gesto essencial.
O tamanho da resposta segue o peso da cena, não a duração da conversa.
Contenção pede menos. Tensão acumulada pede mais.`,
};

function applyThinkingPreset() {
    const s = scope();
    const prof = s[KEYS.PROFILE];
    const charName = ctx.name2 || 'o personagem';
    const person = prof?.thinkingPerson || 2;
    const gender = prof?.gender || 'neutro';
    const compiled = compileThinkingTemplate(person, gender, charName);
    iaSetExtensionPrompt('axis_thinking_preset', compiled, 1, 0, false, 0);
}

// ====================================
// TICKET 22 — DISCIPLINA DE RITMO
// Observado na prática: um pedido de "fala mais dinâmica" foi interpretado
// como "mais elaborada" — a resposta foi crescendo de forma constante ao
// longo da cena, mensagem após mensagem, mesmo em momentos de baixa tensão.
// Isso é o oposto de dinâmico (que devia significar VARIAR o ritmo, não
// crescer estruturalmente). Esse lembrete roda sempre, em prioridade baixa
// (não compete com o DIRECTIVE do usuário nem com sistemas ativos) — só
// existe pra puxar de volta quando a resposta tende a inflar sem motivo.
// ====================================
function applyRhythmGuard() {
    iaSetExtensionPrompt('axis_rhythm_guard',
        '[LEMBRETE DE RITMO] O tamanho da resposta reflete o peso da CENA atual, não quanto a conversa já durou — não deixe a resposta crescer só porque as últimas cresceram. Cenas cotidianas, comandos, respostas diretas ou de baixa tensão pedem POUCAS frases (a economia é a marca da personagem). Só expanda de verdade quando a tensão da cena específica pedir. "Dinâmico" significa variar — às vezes seco e curto, às vezes mais longo quando importa — não significa sempre mais.',
        1, 2, false, 0);
}

// ====================================
// TICKET 26 — GATILHO BAIXO DE NPC (qualquer NPC que fala é criado)
// Mesmo padrão do Rhythm Guard: instrução sempre ativa, de prioridade
// baixa, chamada nos mesmos 3 lugares. Não espera a checagem de imersão
// (15 msgs) — se alguém novo falar de verdade na cena, a Hanna já marca
// a proposta na própria resposta, e processInlineNpcTag() resolve isso
// antes de qualquer outra coisa no MESSAGE_RECEIVED.
// ====================================
function applyNpcAutoTagGuard() {
    iaSetExtensionPrompt('axis_npc_autotag',
        '[REGRA DE ELENCO] Se um personagem NOVO (que ainda não existe no elenco) tiver falas de verdade nessa cena — não só ser citado de passagem — inclua logo no início da sua resposta: [AXIS:NPC_PROPOSAL]{"name":"Nome","role":"papel aqui","description":"1-2 frases"}[/AXIS:NPC_PROPOSAL] — isso é invisível pro usuário, só registra o personagem. Não faça isso pra quem só é mencionado sem falar.',
        1, 1, false, 0);
}

// ====================================
// TICKET 27 (item 10) — SOAR MAIS HUMANO
// Mesmo padrão do Rhythm Guard: lembrete sempre ativo, prioridade baixa,
// chamado nos mesmos 3 lugares. Detecção de "blandness" por JS puro não
// tem sinal confiável — fica só nesse lembrete + no exemplo real (o
// contraste FALA ASSIM / NÃO FALA ASSIM do item 5 já resolve isso melhor
// que qualquer regra solta detectando texto genérico).
// ====================================
function applyAntiRobotGuard() {
    iaSetExtensionPrompt('axis_anti_robot',
        '[NATURALIDADE] Evite: frase certinha demais, sempre a palavra mais óbvia, estrutura de "primeiro...depois...por fim" em fala solta. Prefira a palavra menos esperada quando ainda fizer sentido.',
        1, 2, false, 0);
}

// ====================================
// TREINO EM TEMPO REAL DE VERDADE (Ticket 19)
// synthesizeVoiceDraft: trava o chat, consolida personality+lines num
// RASCUNHO separado (nunca mexe na biblioteca real direto), e posta um
// card de aprovação com Sim / Não / campo de ajuste. Pode ser chamado de
// novo com um ajuste — sobrescreve o MESMO rascunho, nunca acumula.
// ====================================
function updateTrainingBanner() {
    const banner = document.getElementById('axis-training-banner');
    if (!banner) return;
    const s = scope();
    const cid = currentMiniChatId || 'main';
    const chat = s[KEYS.CHATS][cid];
    if (!chat || !chat.trainingActive) { banner.style.display = 'none'; return; }
    banner.style.display = 'flex';
    if (chat.trainingLocked) {
        banner.innerHTML = '🔒 Sintetizando o tom, aguarde...';
        return;
    }
    banner.innerHTML = '🔴 Treinando fala — a IA está aprendendo o estilo do personagem' +
        '<button class="axis-btn axis-btn-sm" id="axis-btn-synth" style="margin-left:auto;">🔄 Sintetizar</button>';
    const btn = document.getElementById('axis-btn-synth');
    if (btn) btn.addEventListener('click', () => synthesizeVoiceDraft());
}

async function synthesizeVoiceDraft(adjustment) {
    const chatId = currentMiniChatId || 'main';
    const s0 = scope();
    const chat0 = s0[KEYS.CHATS][chatId];
    if (!chat0) return;

    if (isGlobalLocked() || isGenerating) {
        requestInterrupt('Sintetizando tom de voz', () => synthesizeVoiceDraft(adjustment));
        return;
    }

    const voice0 = s0[KEYS.VOICE] || { lines: [], personality: '', draft: null };
    if (!adjustment && !voice0.lines.length && !voice0.personality) {
        addMsg('agent', 'Ainda não tenho nenhuma fala ou descrição de estilo guardada pra sintetizar — me manda alguns exemplos primeiro.', chatId);
        return;
    }

    chat0.trainingLocked = true;
    save();
    updateTrainingBanner();
    if (input) input.disabled = true;
    if (sendBtn) sendBtn.disabled = true;
    const attachBtn = document.getElementById('axis-btn-attach');
    if (attachBtn) attachBtn.disabled = true;

    isGenerating = true;
    globalLock();
    dotsThinking();
    try {
        const s = scope();
        const voice = s[KEYS.VOICE] || { lines: [], personality: '', draft: null };
        const charName = ctx.name2 || 'o personagem';
        const linesBlock = voice.lines.length ? voice.lines.map(l => '- ' + l.text).join('\n') : '(nenhuma fala guardada ainda)';
        const draftBase = voice.draft;

        const msgs = [{ role: 'system', content: `Você é o Spade. Consolide o estilo de fala de "${charName}" a partir do material de treino abaixo, numa versão final, organizada e completa.

FALAS GUARDADAS:
${linesBlock}

DESCRIÇÃO DE ESTILO ATUAL:
${voice.personality || '(nenhuma ainda)'}
${draftBase ? '\nRASCUNHO ANTERIOR (você já tinha sintetizado isso — ajuste em cima dele, não comece do zero):\n' + (draftBase.personality || '') : ''}
${adjustment ? '\nAJUSTE PEDIDO AGORA PELO USUÁRIO — aplique isso na nova versão: ' + adjustment : ''}

Responda APENAS com:
[AXIS:VOICE_PERSONALITY]descrição final, completa e consolidada do estilo de fala[/AXIS:VOICE_PERSONALITY]

Sem comentário fora da tag.` }];

        const resp = await generate(msgs, { maxTokens: 500 });
        const m = /\[AXIS:VOICE_PERSONALITY\]([\s\S]*?)\[\/AXIS:VOICE_PERSONALITY\]/.exec(resp || '');
        const personality = (m ? m[1] : (resp || '')).trim();
        const uid = 'voice_draft_' + Date.now();
        s[KEYS.VOICE].draft = { personality, lines: voice.lines.slice(), ts: Date.now(), uid };
        save();
        addMsg('agent', '[AXIS:CARD]\n🆕 Rascunho — ' + new Date().toLocaleString() + '\n\n' + personality + '\n[AXIS:CARD_END]\n[AXIS:VOICE_APPROVAL ID:"' + uid + '" LABEL:"Salvar esse tom na biblioteca?"]', chatId);
    } catch (e) {
        addMsg('agent', 'Erro ao sintetizar: ' + (e.message || e), chatId);
    } finally {
        const s = scope();
        const chat = s[KEYS.CHATS][chatId];
        if (chat) chat.trainingLocked = false;
        save();
        isGenerating = false;
        globalUnlock();
        dotsIdle();
        if (input) input.disabled = false;
        if (sendBtn) sendBtn.disabled = false;
        const attachBtn2 = document.getElementById('axis-btn-attach');
        if (attachBtn2) attachBtn2.disabled = false;
        updateTrainingBanner();
    }
}

// Sim: calcula embedding de cada fala do rascunho e SÓ AÍ entra na
// biblioteca real (voice.lines/personality) + reaplica como sistema ativo.
// Não: descarta o rascunho, biblioteca antiga fica intocada.
async function handleVoiceApproval(id, approved, chatId) {
    const s = scope();
    if (!s._resolved) s._resolved = {};
    const baseId = id.startsWith('reject_') ? id.replace('reject_', '') : id;
    s._resolved[baseId] = approved;

    const voice = s[KEYS.VOICE];
    const draft = voice?.draft;
    if (!draft || draft.uid !== baseId) {
        save();
        addMsg('agent', '⚠️ Esse rascunho já não é mais o mais recente (ou já foi resolvido) — role até o card mais novo.', chatId);
        return;
    }

    if (!approved) {
        voice.draft = null;
        save();
        addMsg('agent', 'Rascunho descartado — a biblioteca de voz continua exatamente como estava.', chatId);
        return;
    }

    save();
    addMsg('agent', '⏳ Calculando as falas antes de salvar de verdade...', chatId);
    for (const line of (draft.lines || [])) {
        if (!line.embedding) { const emb = await getEmbedding(line.text); if (emb) line.embedding = emb; }
    }
    voice.lines = draft.lines || voice.lines;
    voice.personality = draft.personality || voice.personality;
    voice.draft = null;
    save();
    applyVoiceAsSystem();
    addMsg('agent', '✅ Tom salvo na biblioteca de voz — já é o que o personagem usa como referência agora, sem precisar encerrar o treino.', chatId);
    updateTrainingBanner();
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

function compileSystemsBlock(systems) {
    return systems.map(sys => {
        const steps = sys.steps?.length ? '\nEtapas obrigatórias:\n' + sys.steps.map((st, i) => (i + 1) + '. ' + st).join('\n') : '';
        return '### ' + sys.name + ' [' + (sys.type || 'behavior') + ']\n' + (sys.promptText || sys.description || '') + steps;
    }).join('\n\n');
}

// Versão padrão, sem ranking — ordem de criação. Usada em todo lugar que
// não seja a geração real do RP (edição de sistemas, troca de chat, etc),
// onde não faz sentido pagar o custo de embedding.
function applySystems() {
    const s = scope();
    const systems = (s[KEYS.SYSTEMS] || []).filter(sys => sys && sys.enabled !== false);
    if (!systems.length) {
        iaSetExtensionPrompt('axis_systems', '', 1, 1, false, 0);
        return;
    }
    iaSetExtensionPrompt('axis_systems', '[Sistemas do Spade — estas são instruções REAIS de comportamento]\n\n' + compileSystemsBlock(systems), 1, 1, false, 0);
}

// Ticket 2: sistemas não "grudam" bem no RP quando a lista cresce — a
// instrução mais importante pode se diluir no meio de um textão. Em vez de
// remover sistemas irrelevantes (arriscado — pode "esquecer" um sistema que
// deveria estar sempre ativo, tipo memória), só REORDENA por relevância pra
// cena atual, então se o prompt tiver que cortar por limite de token, o que
// importa agora fica garantido no começo.
// Reaproveita getEmbedding/cosineSim do Ticket 1. Cada sistema ganha um
// embedding (calculado a partir de description + promptText) na primeira
// vez que passa por aqui, e fica cacheado no próprio objeto do sistema —
// só recalcula se o sistema for criado/atualizado depois (embedding: null).
async function ensureSystemEmbedding(sys) {
    if (sys.embedding) return sys.embedding;
    const text = ((sys.description || '') + ' ' + (sys.promptText || '')).trim();
    if (!text) return null;
    const emb = await getEmbedding(text);
    if (emb) sys.embedding = emb;
    return emb;
}

async function applySystemsRanked(queryEmbedding) {
    const s = scope();
    const systems = (s[KEYS.SYSTEMS] || []).filter(sys => sys && sys.enabled !== false);
    if (!systems.length) {
        iaSetExtensionPrompt('axis_systems', '', 1, 1, false, 0);
        return;
    }
    let ordered = systems;
    if (queryEmbedding) {
        let changed = false;
        for (const sys of systems) {
            if (!sys.embedding) { const emb = await ensureSystemEmbedding(sys); if (emb) changed = true; }
        }
        if (changed) save();
        ordered = systems
            .map(sys => ({ sys, score: sys.embedding ? cosineSim(queryEmbedding, sys.embedding) : -1 }))
            .sort((a, b) => b.score - a.score)
            .map(o => o.sys);
    }
    iaSetExtensionPrompt('axis_systems', '[Sistemas do Spade — instruções REAIS de comportamento, ordenados por relevância pra cena atual]\n\n' + compileSystemsBlock(ordered), 1, 1, false, 0);
}

// Ticket 10 (investigação) — passos 1 e 2 já checados aqui: tanto
// postCharacterMessage quanto insertNpcMessage (abaixo) criam um objeto
// `{...}` literal NOVO a cada chamada (nunca reaproveitam/sobrescrevem o
// último item do array), e ctx.addOneMessage sempre recebe essa mesma
// referência recém-criada. Não achei reaproveitamento de objeto no código.
// Passo 3 (inspecionar o DOM real do ST com CHAR_SPEAK + NPC_SPEAK em
// sequência rápida) precisa de um caso ao vivo reproduzido — não dá pra
// confirmar a causa só lendo o código.
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
// a própria personagem digitando.
//
// TICKET 29h — ADAPTAÇÃO NECESSÁRIA em relação ao design original: o
// pedido era pausar a geração de verdade no meio, o que dependeria de
// generate()/ctx.generateRaw fazer streaming de token — confirmado que
// não faz (ver Ticket 28 acima: generate() só devolve o texto pronto de
// uma vez, sem stream). Não dá pra pausar algo que já terminou de gerar.
//
// Em vez disso: revelação progressiva do texto JÁ GERADO (efeito de
// máquina de escrever, direto no DOM da mensagem já inserida) — pro
// usuário o efeito visual é o mesmo "ela tá digitando agora", e a
// interrupção é real de verdade: se o usuário começa a digitar a
// própria mensagem no campo principal do ST enquanto a revelação ainda
// está rolando, ela para na hora, guarda o que ficou de fora, e a
// personagem sabe disso na resposta seguinte (canto "falaInterrompida"
// no runThoughtChain, mais acima no arquivo).
//
// Escopo: só o caminho que já existia de "postar como o personagem em
// tempo real" (usado pela iniciativa própria — item 1 — e por pedido
// explícito no Espaço). NPCs (Ticket 26) continuam com insertNpcMessage
// de sempre, sem revelação progressiva — não fazia parte deste pedido.
//
// ⚠️ Preciso confirmar ao vivo: o listener de interrupção escuta
// #send_textarea, o id padrão do campo de digitação do ST. Se o tema/
// versão do usuário renomear esse id, a revelação ainda funciona
// normalmente — só a interrupção por digitação não dispara nesse caso
// (RP_GENERATING ainda cobre "usuário mandou a mensagem", só não cobre
// "usuário só digitando, ainda não mandou").
// ====================================
async function postCharacterMessage(text) {
    try {
        if (RP_GENERATING) return { ok: false, reason: 'RP está gerando algo agora — espera terminar e pede de novo.' };
        if (isRevealingCharMessage) return { ok: false, reason: 'Já tem uma fala em tempo real acontecendo agora — espera terminar.' };
        if (typeof ctx.addOneMessage !== 'function' || !Array.isArray(ctx.chat)) {
            return { ok: false, reason: 'Essa versão do SillyTavern não expõe a API pra postar mensagem direto.' };
        }
        const charName = ctx.name2 || 'Personagem';
        showStatusPill(charName + ' está digitando...');

        // Insere a mensagem já como elemento real na tela, com texto vazio —
        // sem isso não existe nada pra revelar progressivamente.
        const message = { name: charName, is_user: false, is_system: false, send_date: Date.now(), mes: '', extra: {} };
        ctx.chat.push(message);
        ctx.addOneMessage(message);
        const idx = ctx.chat.length - 1;

        isRevealingCharMessage = true;
        let reveal;
        try {
            reveal = await revealCharMessageRealtime(text, idx, message, charName);
        } finally {
            isRevealingCharMessage = false;
        }

        message.mes = reveal.shownText;
        if (typeof ctx.saveChat === 'function') ctx.saveChat();
        else if (typeof ctx.saveChatConditional === 'function') ctx.saveChatConditional();

        if (!reveal.completed) {
            const s = scope();
            s[KEYS.ALIVE].interruptedSpeech = { fullText: text, shownText: reveal.shownText, ts: Date.now() };
            save();
        }

        return { ok: true, interrupted: !reveal.completed };
    } catch (e) {
        console.warn('[Spade] Falha ao postar mensagem no RP:', e);
        isRevealingCharMessage = false;
        return { ok: false, reason: e.message || String(e) };
    }
}

// Revela fullText progressivamente no .mes_text da mensagem já inserida
// (idx), token a token (palavras + espaços, pra reconstrução exata), com
// um cursor piscando no final enquanto rola. Para na hora se o usuário
// começar a digitar a própria mensagem no ST ou se uma geração real do
// RP começar (RP_GENERATING) — os dois sinais de interrupção do design
// original ("trava de input" = trava outras revelações simultâneas via
// isRevealingCharMessage, não o campo de digitação em si, que continua
// livre de propósito: é dele que vem o sinal de interrupção).
async function revealCharMessageRealtime(fullText, idx, message, charName) {
    const tokens = fullText.split(/(\s+)/).filter(t => t.length);
    const totalBudgetMs = Math.min(7000, Math.max(600, fullText.length * 14));
    const perTokenMs = Math.max(16, totalBudgetMs / Math.max(1, tokens.length));

    const inputEl = document.getElementById('send_textarea');
    let interrupted = false;
    const onType = () => { if (inputEl && (inputEl.value || '').trim()) interrupted = true; };
    if (inputEl) inputEl.addEventListener('input', onType);

    const getMesEl = () => document.querySelector('.mes[mesid="' + idx + '"] .mes_text');
    let shown = '';
    try {
        for (let i = 0; i < tokens.length; i++) {
            if (interrupted || RP_GENERATING) break;
            shown += tokens[i];
            message.mes = shown;
            const el = getMesEl();
            if (el) {
                const formatted = typeof ctx.messageFormatting === 'function'
                    ? ctx.messageFormatting(shown, charName, false, false, idx) : esc(shown);
                el.innerHTML = formatted + '<span class="axis-typing-cursor">▌</span>';
            }
            await new Promise(r => setTimeout(r, perTokenMs + Math.random() * perTokenMs * 0.4));
        }
    } finally {
        if (inputEl) inputEl.removeEventListener('input', onType);
    }

    // Render final sem cursor. Se foi interrompida, fica só com o que já
    // tinha sido mostrado — o resto nunca "aconteceu" de fato na cena.
    const el = getMesEl();
    if (el) {
        el.innerHTML = typeof ctx.messageFormatting === 'function'
            ? ctx.messageFormatting(shown, charName, false, false, idx) : esc(shown);
    }
    return { completed: !interrupted && !RP_GENERATING, shownText: shown };
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
        const note = !outcome.ok
            ? '⚠️ _Não consegui postar no RP: ' + outcome.reason + '_'
            : outcome.interrupted
                ? '✅ _Mandei isso no RP — mas você começou a escrever no meio, então ela foi cortada e só o começo apareceu._'
                : '✅ _Mandei isso no RP agora._';
        result = result.replace(m[0], note);
    }
    return result;
}

// ====================================
// TICKET 24 — PIPELINE EM CANTOS + SALA DE PENSAMENTO
// Em vez de calcular voz, sistemas, directive e ritmo em paralelo numa
// chamada só de geração, cada fonte vira uma chamada própria e focada,
// resume pro que importa, guarda o resultado em s._thinkingRoom (sala
// privada, nunca aparece no chat visível) — só a última chamada (o
// Thinking, escrevendo a fala de verdade) usa os resultados já prontos.
// ====================================

// Canto 3 — repetição literal, sem IA, puro JS, rápido. A versão "esperta"
// (a IA decidindo como quebrar o padrão) entra depois, no Ticket 6/7 de
// verdade — isso aqui é só a base (item 7).
function checkRepetitionPatterns() {
    let recentMsgs = [];
    try {
        const liveChat = Array.isArray(ctx.chat) ? ctx.chat : [];
        recentMsgs = liveChat.slice(-6).filter(m => m && !m.is_user && m.mes)
            .map(m => String(m.mes).replace(/<[^>]+>/g, ''));
    } catch (_) { return ''; }
    if (recentMsgs.length < 3) return '';

    const warnings = [];
    const openings = recentMsgs.map(t => t.trim().slice(0, 25).toLowerCase());
    const openingCounts = {};
    openings.forEach(o => { if (o) openingCounts[o] = (openingCounts[o] || 0) + 1; });
    if (Object.values(openingCounts).some(c => c >= 3)) warnings.push('as últimas respostas começaram de um jeito muito parecido');

    const words = recentMsgs.join(' ').toLowerCase().match(/\b[a-zà-ú]{4,}\b/g) || [];
    const wordCounts = {};
    words.forEach(w => { wordCounts[w] = (wordCounts[w] || 0) + 1; });
    const overused = Object.entries(wordCounts).filter(([, c]) => c >= 5).map(([w]) => w);
    if (overused.length) warnings.push('a palavra "' + overused[0] + '" apareceu demais nas últimas respostas');

    return warnings.join('; ');
}

// Ticket 27 (5c) — memória de CENA inteira (não fala solta): resume o
// bloco das últimas 10 mensagens e guarda com embedding próprio, pra
// buscar depois "isso já aconteceu antes, parecido assim". Indexa a
// cada 10 mensagens (não toda mensagem) por causa do custo de gerar o
// resumo.
async function maybeIndexScene() {
    const s = scope();
    const a = s[KEYS.ALIVE];
    a.msgsSinceSceneIndex = (a.msgsSinceSceneIndex || 0) + 1;
    if (a.msgsSinceSceneIndex < 10) { save(); return; }
    a.msgsSinceSceneIndex = 0; save();
    try {
        const liveChat = Array.isArray(ctx.chat) ? ctx.chat : [];
        const chunk = liveChat.slice(-10).filter(m => m?.mes).map(m => (m.name || '') + ': ' + m.mes).join('\n');
        if (chunk.length < 100) return;
        const summ = (await generate([{ role: 'system', content: 'Resuma essa cena em 2-3 frases — o que aconteceu, o tom, o que estava em jogo:\n\n' + chunk }], { maxTokens: 150 }) || '').trim();
        if (!summ) return;
        const emb = await getEmbedding(summ);
        const s2 = scope();
        if (!s2[KEYS.SCENES]) s2[KEYS.SCENES] = [];
        s2[KEYS.SCENES].push({ summary: summ, fullText: chunk.slice(0, 2000), embedding: emb, ts: Date.now() });
        if (s2[KEYS.SCENES].length > 500) s2[KEYS.SCENES] = s2[KEYS.SCENES].slice(-500);
        save();
    } catch (e) { console.warn('[Spade] Falha ao indexar cena:', e); }
}

// A cadeia de cantos — cada canto é uma chamada isolada e focada. queryEmb
// é o mesmo vetor já calculado em Spade_interceptGeneration (reaproveitado
// aqui pro canto de voz, do mesmo jeito que já era reaproveitado entre
// applyVoiceRetrieval/applySystemsRanked antes deste ticket).
async function runThoughtChain(recentText, queryEmb) {
    const s = scope();
    const charName = ctx.name2 || 'o personagem';
    const room = { ts: Date.now(), cantos: {} };

    // Canto 1 — Perfil resumido pra cena atual
    const profile = s[KEYS.PROFILE];
    if (profile?.text?.trim()) {
        const compiled = compileStagedBlock(profile.text, 'PERFIL');
        const resp = await generate([{ role: 'system', content:
            'Perfil completo de ' + charName + ', em etapas:\n\n' + compiled +
            '\n\nCena atual:\n' + recentText +
            '\n\nResuma em poucas frases só o que desse perfil é RELEVANTE pra cena atual — não repita tudo, extraia o que importa agora.' }],
            { maxTokens: 300 });
        room.cantos.perfil = (resp || '').trim();
    }

    // Canto 2 — falas que combinam com a cena (mesma seleção de sempre,
    // extraída de applyVoiceRetrieval — ver Ticket 26 pra decidir se esse
    // canto já manda TODAS as falas em vez de escolher, como no item 5)
    room.cantos.falas = await buildVoiceBlockForScene(recentText, queryEmb);

    // Canto 3 — repetição (sem IA)
    room.cantos.repeticao = checkRepetitionPatterns();

    // Canto — cena parecida já vivida (Ticket 27, item 5c), mesmo queryEmb
    // reaproveitado do canto de voz. Só entra se a similaridade for alta
    // o bastante pra valer a pena (0.75) — senão é ruído, não repetição real.
    if (s[KEYS.SCENES]?.length && queryEmb) {
        const top = s[KEYS.SCENES].filter(sc => sc.embedding).map(sc => ({ ...sc, score: cosineSim(queryEmb, sc.embedding) })).sort((a, b) => b.score - a.score)[0];
        if (top && top.score > 0.75) room.cantos.cenaParecida = top.summary + '\n(detalhe: ' + top.fullText.slice(0, 300) + '...)';
    }

    // Canto — pulo de tempo explícito (Ticket 29d): o usuário escreveu um
    // horário na própria mensagem (ver checkExplicitTimeJump) — isso não é
    // mecanismo novo de resposta, é só conteúdo extra pro Thinking resolver.
    // Reseta o flag aqui, senão dispararia de novo em toda mensagem seguinte.
    if (s[KEYS.ALIVE].bigTimeSkip) {
        room.cantos.pulodetempo = 'O usuário pulou tempo explicitamente (mencionou um horário nesse turno) — resolva sozinha, de forma breve e natural, qualquer coisa que ficou em aberto nesse intervalo antes de continuar a cena (o que mudou, quanto tempo se passou), sem precisar narrar tudo em detalhe.';
        s[KEYS.ALIVE].bigTimeSkip = false;
    }

    // Canto — fala em tempo real foi interrompida (Ticket 29h): o usuário
    // começou a escrever/mandou algo enquanto a mensagem anterior ainda
    // estava sendo revelada (ver revealCharMessageRealtime). Consome uma
    // vez só, mesmo padrão do pulodetempo acima.
    if (s[KEYS.ALIVE].interruptedSpeech) {
        const isp = s[KEYS.ALIVE].interruptedSpeech;
        room.cantos.falaInterrompida = charName + ' estava no meio de uma fala na resposta anterior e foi cortada quando o usuário começou a escrever antes dela terminar. O que ela chegou a dizer: "' + isp.shownText + '" — o resto ("' + isp.fullText.slice(isp.shownText.length).trim() + '") nunca chegou a ser mostrado, então não é fato estabelecido da cena. Reaja a ter sido cortada do jeito que fizer sentido pra personagem (retomar o pensamento, comentar rapidamente, ou só deixar pra lá e focar no que o usuário disse agora) — sem tratar isso como uma regra mecânica a seguir.';
        s[KEYS.ALIVE].interruptedSpeech = null;
    }

    if (!s._thinkingRoom) s._thinkingRoom = [];
    s._thinkingRoom.push(room);
    if (s._thinkingRoom.length > 20) s._thinkingRoom = s._thinkingRoom.slice(-20);
    save();

    return room.cantos;
}

// Injeção do resultado — bloco único, depth 1 (perto da geração, mas atrás
// do Directive que é depth 0), pro Thinking (já no prompt via Systems)
// usar como matéria-prima.
function applyThoughtChainResult(cantos) {
    const parts = [];
    if (cantos.perfil) parts.push('[DO PERFIL, relevante agora]\n' + cantos.perfil);
    if (cantos.falas) parts.push('[EXEMPLOS DE VOZ relevantes agora]\n' + cantos.falas);
    if (cantos.repeticao) parts.push('[PADRÃO A EVITAR nessa resposta]\n' + cantos.repeticao);
    if (cantos.cenaParecida) parts.push('[CENA PARECIDA JÁ VIVIDA]\n' + cantos.cenaParecida);
    if (cantos.pulodetempo) parts.push('[TEMPO PULADO]\n' + cantos.pulodetempo);
    if (cantos.falaInterrompida) parts.push('[FALA INTERROMPIDA]\n' + cantos.falaInterrompida);
    iaSetExtensionPrompt('axis_thought_chain', parts.join('\n\n'), 1, 1, false, 0);
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
        if (!Array.isArray(chatArr) || !chatArr.length) return;

        const recentText = chatArr.slice(-6).map(m => (m.name || '') + ': ' + (m.mes || '')).join('\n');

        // Ticket 1 + 2: uma chamada de embedding só, reaproveitada pro RAG de
        // voz E pro ranking de sistemas — não vale a pena pagar duas vezes
        // pelo mesmo vetor de consulta na mesma geração. Só paga esse custo
        // se houver algo pra rankear (senão é uma chamada de rede à toa).
        const s = scope();
        const hasVoiceLines = (s[KEYS.VOICE]?.lines?.length || 0) > 0;
        const hasSystems = (s[KEYS.SYSTEMS]?.length || 0) > 0;
        const queryEmb = (hasVoiceLines || hasSystems) ? await getEmbedding(recentText) : null;
        const cantos = await runThoughtChain(recentText, queryEmb); // Ticket 24
        applyThoughtChainResult(cantos);
        await applySystemsRanked(queryEmb); // sistemas continuam sendo injetados normal, cantos são conteúdo NOVO, não substituem systems
        applyDirective();
        applyProfile(); // Ticket 23
    applyThinkingPreset(); // Ticket 31
        applyInnerState(); // Ticket 25
        applyRhythmGuard(); // Ticket 22
        applyNpcAutoTagGuard(); // Ticket 26
        applyAntiRobotGuard(); // Ticket 27 (item 10)

        // Direção de cena (NPCs) é independente do RAG de voz acima — o
        // interruptor manual só afeta NPCs, nunca o tom de voz do personagem.
        const settings = s[KEYS.ALIVE];
        if (settings.sceneDirection === false) return; // interruptor manual desligado
        const cast = (s[KEYS.CAST] || []).filter(n => !n.archived); // Ticket 26
        if (!cast.length) return;

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

// ====================================
// TICKET 26 — NPC inline (gatilho baixo) + contagem de menções
// ====================================
// A Hanna pode incluir [AXIS:NPC_PROPOSAL] na própria resposta do RP
// (regra do applyNpcAutoTagGuard). Isso precisa sumir do texto visível
// e criar o NPC de verdade, sem esperar a checagem de imersão (15 msgs).
// Risco conhecido: ctx.messageFormatting é o melhor palpite pra função
// nativa do ST que formata a mensagem — se não existir, cai no fallback
// de texto puro (funciona, só sem formatação rica).
function processInlineNpcTag() {
    try {
        const liveChat = Array.isArray(ctx.chat) ? ctx.chat : [];
        const idx = liveChat.length - 1;
        const last = liveChat[idx];
        if (!last || last.is_user || !last.mes || !last.mes.includes('[AXIS:NPC_PROPOSAL]')) return;
        const cleaned = processNpcProposalsAuto(last.mes).trim();
        if (cleaned === last.mes) return;
        last.mes = cleaned;
        const mesEl = document.querySelector('.mes[mesid="' + idx + '"] .mes_text');
        if (mesEl) mesEl.innerHTML = typeof ctx.messageFormatting === 'function'
            ? ctx.messageFormatting(cleaned, last.name, false, last.is_user, idx) : esc(cleaned);
        if (typeof ctx.saveChat === 'function') ctx.saveChat();
        else if (typeof ctx.saveChatConditional === 'function') ctx.saveChatConditional();
    } catch (e) { console.warn('[Spade] Falha ao processar NPC inline no RP:', e); }
}

// Sem IA, roda toda mensagem — só marca quando um NPC do elenco ativo
// é citado nas últimas falas, pra saber há quanto tempo cada um sumiu.
function updateNpcMentions() {
    const s = scope();
    const cast = (s[KEYS.CAST] || []).filter(n => !n.archived);
    if (!cast.length) return;
    let recentText = '';
    try {
        const liveChat = Array.isArray(ctx.chat) ? ctx.chat : [];
        recentText = liveChat.slice(-2).map(m => String(m.mes || '')).join(' ').toLowerCase();
    } catch (_) { return; }
    if (!recentText) return;
    const total = s[KEYS.ALIVE].totalRpMessages || 0;
    let changed = false;
    cast.forEach(n => { if (recentText.includes(n.name.toLowerCase())) { n.lastMentionedAtMsgCount = total; changed = true; } });
    if (changed) save();
}

// Só deixa falar quem já está aprovado no elenco — evita o agente
// inventar um "falante" novo sem passar pela aprovação do usuário.
function processNpcSpeak(text) {
    const s = scope();
    const cast = (s[KEYS.CAST] || []).filter(n => !n.archived); // Ticket 26
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
    const cast = (s[KEYS.CAST] || []).filter(n => !n.archived); // Ticket 26
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
// TICKET 29 — MINI RPG: RELÓGIO, TAREFAS, STATUS ATUAL
// Atenção: isso NÃO reintroduz a simulação por relógio removida de
// propósito da Imersão (comentário logo abaixo) — aquilo era sobre NÃO
// disparar comportamento da IA por tempo real decorrido. O relógio aqui
// é só contabilidade NARRATIVA (dia/hora dentro da história), nunca um
// timer que aciona nada sozinho.
// ====================================
function advanceClockPassive() {
    const s = scope();
    if (!s[KEYS.CLOCK]) s[KEYS.CLOCK] = { day: 1, hour: 9, minute: 0, weather: '' };
    const c = s[KEYS.CLOCK];
    c.minute += 4;
    while (c.minute >= 60) { c.minute -= 60; c.hour += 1; }
    while (c.hour >= 24) { c.hour -= 24; c.day += 1; }
    save();
}

// Regex crua: "15:30", "8h00", "22h" — se o usuário escrever um horário
// explícito na própria mensagem do RP, o relógio pula direto pra esse
// horário (fica a critério da cena resolver se isso é mais tarde no
// mesmo dia ou um salto maior — ver o canto de pulo de tempo, item 29d).
function checkExplicitTimeJump(text) {
    const m = /\b(\d{1,2})[:h](\d{2})\b/.exec(text || '');
    if (!m) return false;
    const s = scope();
    if (!s[KEYS.CLOCK]) s[KEYS.CLOCK] = { day: 1, hour: 9, minute: 0, weather: '' };
    s[KEYS.CLOCK].hour = Math.min(23, parseInt(m[1], 10));
    s[KEYS.CLOCK].minute = Math.min(59, parseInt(m[2], 10));
    s[KEYS.ALIVE].bigTimeSkip = true;
    save();
    return true;
}

// Ticket 29f/g — status atual do personagem, pra saber se ela está livre
// ("ociosa") agora ou ocupada com outra coisa (thread de NPC, tarefa
// pendente). Sem timer: um status "expira" sozinho depois de 5min sem
// atualização (mesma janela do showStatusPill), então isCharacterIdle()
// nunca depende de nada limpar o campo manualmente.
function setCurrentStatus(type, label) {
    const s = scope();
    s[KEYS.ALIVE].currentStatus = { type, label, ts: Date.now() };
    save();
}
function isCharacterIdle() {
    const cs = scope()[KEYS.ALIVE].currentStatus;
    if (!cs) return true;
    return (Date.now() - (cs.ts || 0)) > 5 * 60 * 1000;
}

// Ticket 29b — tarefas com estado REAL (não texto de chat): status muda
// por um botão que grava o dado, então não dá pra "esquecer"/alucinar
// depois que algo foi aceito, recusado ou concluído.
// ====================================
// TICKET 32a — TAREFAS TIPADAS (arquivos/planilha) + ADIAR
// Só dois tipos têm tela interativa por enquanto — o resto continua
// funcionando como tarefa de texto simples (aceitar/recusar/concluir).
// Resolvido com clique (mouse), não arrasta de verdade — mais robusto que
// HTML5 drag-and-drop e ainda satisfaz "resolve com o mouse no PC". Mobile
// ainda não tem essa tela, cai automaticamente pro modo texto simples.
// ====================================
const ARQUIVOS_FILE_POOL = [
    { name: 'Relatório_Q3.docx', icon: '📄' }, { name: 'Contrato_Fornecedor.pdf', icon: '📕' },
    { name: 'Planilha_Custos.xlsx', icon: '📊' }, { name: 'Apresentação_Cliente.pptx', icon: '📽️' },
    { name: 'Foto_Evento.jpg', icon: '🖼️' }, { name: 'Notas_Reunião.txt', icon: '📝' },
    { name: 'Backup_2024.zip', icon: '🗜️' }, { name: 'Currículo_Candidato.pdf', icon: '📕' },
];
const ARQUIVOS_FOLDER_POOL = ['Documentos', 'Financeiro', 'Arquivo Morto', 'Pendências', 'Concluídos'];
const PLANILHA_ITEM_POOL = ['Notebook', 'Monitor 24"', 'Teclado Mecânico', 'Mouse', 'Cadeira Ergonômica', 'Mesa Escritório', 'Licença Software', 'Impressora'];

function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }

function generateArquivosPayload() {
    const files = shuffle(ARQUIVOS_FILE_POOL).slice(0, 5);
    const folders = shuffle(ARQUIVOS_FOLDER_POOL).slice(0, 3);
    return { folders, files: files.map((f, i) => ({ id: 'f' + i, name: f.name, icon: f.icon, targetFolder: folders[i % folders.length], currentFolder: null })) };
}

function generatePlanilhaPayload() {
    const items = shuffle(PLANILHA_ITEM_POOL).slice(0, 5);
    return { items: items.map((name, i) => ({ id: 'r' + i, name, status: 'Pendente', qty: 1 + Math.floor(Math.random() * 3), value: (Math.random() * 2000 + 100).toFixed(2) })) };
}

function addTask(title, givenBy, type) {
    const s = scope();
    if (!s[KEYS.TASKS]) s[KEYS.TASKS] = [];
    const ts = Date.now();
    const cleanType = (type === 'arquivos' || type === 'planilha') ? type : null;
    const task = {
        id: 'task_' + ts, title, givenBy: givenBy || '', status: 'pending', createdAt: ts,
        type: cleanType,
        payload: cleanType === 'arquivos' ? generateArquivosPayload() : cleanType === 'planilha' ? generatePlanilhaPayload() : null,
    };
    s[KEYS.TASKS].push(task);
    if (s[KEYS.TASKS].length > 200) s[KEYS.TASKS] = s[KEYS.TASKS].slice(-200);
    save();
    return task;
}
function setTaskStatus(id, status) {
    const s = scope();
    const t = (s[KEYS.TASKS] || []).find(x => x.id === id);
    if (!t) return false;
    t.status = status;
    save();
    return true;
}

function isPayloadComplete(task) {
    if (!task.payload) return false;
    if (task.type === 'arquivos') return task.payload.files.every(f => f.currentFolder === f.targetFolder);
    if (task.type === 'planilha') return task.payload.items.every(i => i.status === 'Concluído');
    return false;
}

function openTaskMinigame(taskId) {
    const s = scope();
    const task = (s[KEYS.TASKS] || []).find(t => t.id === taskId);
    if (!task || !task.payload) return;
    const ex = document.getElementById('axis-task-minigame');
    if (ex) ex.remove();
    const p = document.createElement('div');
    p.id = 'axis-task-minigame'; p.className = 'axis-tools-panel axis-task-minigame';
    panel.appendChild(p);
    renderTaskMinigame(taskId);
}

function renderTaskMinigame(taskId) {
    const p = document.getElementById('axis-task-minigame');
    if (!p) return;
    const s = scope();
    const task = (s[KEYS.TASKS] || []).find(t => t.id === taskId);
    if (!task) { p.remove(); return; }

    let bodyHtml = '';
    if (task.type === 'arquivos') {
        const { files, folders } = task.payload;
        const selected = p.dataset.selectedFile || '';
        bodyHtml =
            '<div class="axis-task-mg-hint">Clique num arquivo, depois na pasta certa.</div>' +
            '<div class="axis-task-mg-files">' +
            files.map(f => '<div class="axis-task-mg-file' + (f.id === selected ? ' axis-task-mg-selected' : '') + (f.currentFolder ? (f.currentFolder === f.targetFolder ? ' axis-task-mg-correct' : ' axis-task-mg-wrong') : '') + '" data-file="' + f.id + '">' + f.icon + ' ' + esc(f.name) + (f.currentFolder ? ' → ' + esc(f.currentFolder) : '') + '</div>').join('') +
            '</div>' +
            '<div class="axis-task-mg-folders">' +
            folders.map(fo => '<div class="axis-task-mg-folder" data-folder="' + esc(fo) + '">📁 ' + esc(fo) + '</div>').join('') +
            '</div>';
    } else if (task.type === 'planilha') {
        const { items } = task.payload;
        bodyHtml =
            '<table class="axis-task-mg-table"><thead><tr><th>Item</th><th>Qtd</th><th>Valor</th><th>Status</th></tr></thead><tbody>' +
            items.map(it =>
                '<tr><td>' + esc(it.name) + '</td><td>' + it.qty + '</td><td>R$ ' + it.value + '</td><td>' +
                '<select class="axis-select axis-task-mg-status" data-row="' + it.id + '">' +
                ['Pendente', 'Em andamento', 'Concluído'].map(op => '<option value="' + op + '"' + (it.status === op ? ' selected' : '') + '>' + op + '</option>').join('') +
                '</select></td></tr>'
            ).join('') + '</tbody></table>';
    }

    const complete = isPayloadComplete(task);
    p.innerHTML =
        '<div class="axis-tools-header"><span>' + (task.type === 'arquivos' ? '🗂️' : '📊') + ' ' + esc(task.title) + '</span><button class="axis-btn axis-btn-close" id="axis-task-mg-close">✕</button></div>' +
        '<div class="axis-tools-body">' + bodyHtml +
        '<button class="axis-btn" id="axis-task-mg-finish"' + (complete ? '' : ' disabled') + '>' + (complete ? '✓ Concluir tarefa' : 'Termine tudo pra concluir') + '</button>' +
        '</div>';

    document.getElementById('axis-task-mg-close').addEventListener('click', () => p.remove());
    document.getElementById('axis-task-mg-finish').addEventListener('click', () => { setTaskStatus(task.id, 'done'); p.remove(); renderTasksPanel(); });

    if (task.type === 'arquivos') {
        p.querySelectorAll('[data-file]').forEach(el => el.addEventListener('click', () => { p.dataset.selectedFile = el.dataset.file; renderTaskMinigame(taskId); }));
        p.querySelectorAll('[data-folder]').forEach(el => el.addEventListener('click', () => {
            const sel = p.dataset.selectedFile;
            if (!sel) return;
            const f = task.payload.files.find(x => x.id === sel);
            if (f) { f.currentFolder = el.dataset.folder; save(); }
            p.dataset.selectedFile = '';
            renderTaskMinigame(taskId);
        }));
    } else if (task.type === 'planilha') {
        p.querySelectorAll('.axis-task-mg-status').forEach(sel => sel.addEventListener('change', () => {
            const row = task.payload.items.find(x => x.id === sel.dataset.row);
            if (row) { row.status = sel.value; save(); }
            renderTaskMinigame(taskId);
        }));
    }
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

    const cast = (s[KEYS.CAST] || []).filter(n => !n.archived); // Ticket 26
    const charName = ctx.name2 || 'o personagem';
    const castCtx = cast.length
        ? cast.map(n => '- ' + n.name + (n.role ? ' (' + n.role + ')' : '') + (n.relationship ? ' — relação: ' + n.relationship : '')).join('\n')
        : '(elenco vazio ainda)';

    // Ticket 26 — faxina de quem não aparece mais: 100+ mensagens sem menção
    const total = a.totalRpMessages || 0;
    const stale = cast.filter(n => (total - (n.lastMentionedAtMsgCount || 0)) >= 100);
    const staleCtx = stale.length
        ? '\n\nNão aparecem há 100+ mensagens: ' + stale.map(n => n.name + ' (importância: ' + n.importance + ')').join(', ') +
          '. Pra cada um: ainda vale manter (pretende usar de novo) ou arquiva ([AXIS:NPC_ARCHIVE]Nome exato[/AXIS:NPC_ARCHIVE]) porque não faz mais sentido. Só decida sobre quem tá nessa lista.'
        : '';

    // Ticket 9: pra notar um nome de personagem sendo mencionado repetidamente
    // no RP que ainda não está no elenco, precisa de acesso ao RP recente
    // (mais mensagens que o buildFullContext normal, pra dar chance real de
    // perceber repetição, não só uma menção isolada).
    let recentRpText = '';
    try {
        const liveChat = Array.isArray(ctx.chat) ? ctx.chat : [];
        const recentLive = liveChat.slice(-20).filter(m => m && m.mes);
        if (recentLive.length) {
            recentRpText = recentLive.map(m => {
                const who = m.is_user ? (ctx.name1 || 'Usuário') : (m.name || charName);
                const txt = String(m.mes).replace(/<[^>]+>/g, '').slice(0, 300);
                return who + ': ' + txt;
            }).join('\n');
        }
    } catch (e) { /* segue sem RP ao vivo se não acessível por qualquer motivo */ }

    try {
        const msgs = [{ role: 'system', content: `Você é o Spade. Isso é uma checagem de bastidor: ${charName} tem vida própria, e às vezes alguém do elenco de apoio puxa ela pra resolver algo — não é o usuário, é a vida dela mesma acontecendo.

Elenco atual:
${castCtx}

Últimas mensagens do RP (pra notar nomes de personagem mencionados repetidamente que ainda não estão no elenco):
${recentRpText || '(sem mensagens recentes disponíveis)'}

Se um nome específico aparecer mencionado repetidas vezes nessas mensagens e NÃO estiver no elenco acima, e fizer sentido narrativo ele existir de fato (não é só uma menção passageira sem peso), proponha ele com [AXIS:NPC_PROPOSAL] antes de qualquer outra coisa — isso pode acontecer mesmo que a checagem de bastidor abaixo seja SILENCIO.

Se fizer sentido AGORA ter uma interação de bastidor (nem toda checagem precisa ter uma — a maioria das vezes não tem nada acontecendo), escolha UM NPC existente do elenco (o recém-proposto acima também conta) e gere uma pequena troca (estilo mensagem de texto, 1 a 4 falas) entre esse NPC e ${charName}, onde o NPC traz algo real da vida dele — um convite, um pedido, um problema, uma tarefa, ou só um recado rápido (ex: "pode ficar com meu cachorro?", "preciso de dinheiro emprestado", "termina esse projeto até amanhã", "só avisando que não vou poder ir amanhã"). Não são mensagens padronizadas — invente algo específico e coerente com quem é esse NPC.

Nem toda interação precisa envolver ${charName} ativamente — às vezes é só a vida do NPC acontecendo, e ${charName} é só quem ele avisa de passagem, ou nem isso. Tudo bem ter só uma ou duas falas de NPC: sem CHAR: respondendo nada, ou ${charName} respondendo só um "ok"/"combinado" curto — não precisa ser sempre uma conversa longa e equilibrada em torno dela.

Formato OBRIGATÓRIO pra troca de bastidor — a primeira linha diz o nome EXATO do NPC escolhido, depois uma linha por fala:
NOME_DO_NPC
NPC: fala do NPC
CHAR: resposta dela
(pode repetir NPC:/CHAR: mais vezes se fizer sentido, ou só ter linhas NPC: sem CHAR: nenhuma)
Se a troca for um PEDIDO/TAREFA concreto pra ${charName} fazer (não só um comentário ou desabafo — algo que ela pode aceitar, recusar ou cumprir depois), adicione por último: TAREFA: título curto da tarefa. Se der pra enquadrar como organizar arquivos/pastas ou mexer numa planilha (o que faz sentido pro cargo dela na maioria dos casos), prefira isso — são os únicos dois tipos com tela própria hoje; outros tipos de tarefa ainda funcionam, só ficam sem a telinha interativa. Nesse caso adicione também: TIPO: arquivos (ou TIPO: planilha). Só inclua a linha TAREFA quando for mesmo um pedido de verdade.
${force ? '\nIsso é um teste manual — gere uma interação de qualquer forma, mesmo pequena, não responda SILENCIO dessa vez.' : `
Se não houver nada que valha a pena agora (além de uma eventual proposta de NPC acima), responda EXATAMENTE: SILENCIO
Isso deve ser raro — a maioria das checagens não gera nada.`}${staleCtx}` }];

        const resp = await generate(msgs, { maxTokens: 400 });
        let text = (resp || '').trim();
        if (!text) return;

        // processNpcProposalsAuto roda ANTES da checagem de SILENCIO — assim
        // uma proposta de NPC (Ticket 9) se aplica mesmo quando o resto da
        // resposta é só SILENCIO (nenhuma troca de bastidor pra gerar agora).
        text = processNpcProposalsAuto(text).trim();
        text = processNpcArchive(text).trim(); // Ticket 26
        if (!text || /^SILENCIO/i.test(text)) return;

        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        if (!lines.length) return;

        // Nome vem explícito na primeira linha — nada de adivinhar.
        const npcName = lines[0].replace(/^NOME_DO_NPC:?\s*/i, '').trim();
        const exchange = [];
        let taskTitle = null;
        let taskType = null;
        for (const line of lines.slice(1)) {
            const m = line.match(/^(NPC|CHAR):\s*(.+)$/i);
            if (m) { exchange.push({ from: m[1].toUpperCase() === 'NPC' ? 'npc' : 'char', text: m[2].trim() }); continue; }
            const t = line.match(/^TAREFA:\s*(.+)$/i); // Ticket 29c
            if (t) taskTitle = t[1].trim();
            const ty = line.match(/^TIPO:\s*(arquivos|planilha)/i); // Ticket 32a
            if (ty) taskType = ty[1].toLowerCase();
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

        if (taskTitle) { addTask(taskTitle, npc.name, taskType); setCurrentStatus('task', taskTitle); } // Ticket 29b/c/f
        else setCurrentStatus('npc', npc.name); // Ticket 29f

        showStatusPill(charName + ' passando tempo com ' + npc.name + '...');
        const a2 = s2[KEYS.ALIVE];
        a2.ramblingLog.push({ ts, text: '📱 ' + npc.name + ' e ' + charName + ' trocaram mensagens em segundo plano — dá pra ver no Celular.' });
        if (a2.ramblingLog.length > 30) a2.ramblingLog = a2.ramblingLog.slice(-30);
        save();
        renderRamblingLog();
        if (document.getElementById('axis-phone-panel')) renderPhonePanel();
        if (taskTitle && document.getElementById('axis-tasks-panel')) renderTasksPanel(); // Ticket 29b/c
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

// Ticket 26 — faxina: a IA decide que um NPC parado há 100+ mensagens
// não faz mais sentido manter ativo. Arquiva (não apaga) — some do
// elenco ativo, mas continua reviver pelo painel do Celular.
function processNpcArchive(text) {
    const re = /\[AXIS:NPC_ARCHIVE\]([\s\S]*?)\[\/AXIS:NPC_ARCHIVE\]/g;
    const s = scope();
    return text.replace(re, (_, name) => {
        const npc = (s[KEYS.CAST] || []).find(n => n.name.toLowerCase() === name.trim().toLowerCase());
        if (npc) { npc.archived = true; save(); applyCast(); }
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
    if (baseId.startsWith('delete_system_')) {
        const uid = baseId.replace('delete_system_', '');
        const pending = s._pending?.[uid];
        if (pending) {
            const name = pending.name;
            s[KEYS.SYSTEMS] = s[KEYS.SYSTEMS].filter(x => x.name !== name);
            delete s._pending[uid];
            save(); applySystems();
            addMsg('agent', '🗑️ Sistema "' + name + '" removido.', chatId);
        }
    }
    if (baseId.startsWith('add_voicelines_')) {
        const uid = baseId.replace('add_voicelines_', '');
        const pending = s._pending?.[uid];
        if (pending) {
            if (!s[KEYS.VOICE]) s[KEYS.VOICE] = { lines: [], personality: '' };
            pending.lines.forEach(text => s[KEYS.VOICE].lines.push({ text, embedding: null, ts: Date.now(), category: pending.category, isCounterExample: false, source: 'ia' }));
            delete s._pending[uid]; save();
            addMsg('agent', '✅ ' + pending.lines.length + ' fala(s) adicionadas.', chatId);
        }
    }
    if (baseId.startsWith('update_system_')) {
        const uid = baseId.replace('update_system_', '');
        const pending = s._pending?.[uid];
        if (pending) {
            const idx = s[KEYS.SYSTEMS].findIndex(x => x.name === pending.name);
            if (idx >= 0) {
                const p = pending.patch || {};
                const existing = s[KEYS.SYSTEMS][idx];
                s[KEYS.SYSTEMS][idx] = {
                    ...existing,
                    name: String(p.name || existing.name).trim().replace(/"/g, "'"),
                    type: String(p.type || existing.type).trim(),
                    description: String(p.description || existing.description || '').trim().replace(/"/g, "'"),
                    steps: Array.isArray(p.steps) ? p.steps.map(st => String(st).trim()).filter(Boolean) : existing.steps,
                    promptText: String(p.promptText || existing.promptText || existing.description || '').trim(),
                    embedding: null, // invalida — recalcula na próxima geração (Ticket 2)
                };
                save(); applySystems();
                addMsg('agent', '✏️ Sistema "' + pending.name + '" atualizado.', chatId);
            } else {
                addMsg('agent', '⚠️ Não achei mais o sistema "' + pending.name + '" (pode ter sido apagado nesse meio tempo).', chatId);
            }
            delete s._pending[uid];
            save();
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
    pendingAttachments = []; renderAttachChips();
    renderChat();
    renderMiniChatBar();
}

function closeMiniChat() {
    currentMiniChatId = null;
    pendingAttachments = []; renderAttachChips();
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
        const dot = (mc.trainingActive || mc.buildingProfile) ? '<span class="axis-mini-training-dot"></span>' : '';
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
    ).replace(
        /\[AXIS:VOICE_APPROVAL\s+ID:"([^"]+)"\s+LABEL:"([^"]+)"\]/g,
        (_, id, label) => res.hasOwnProperty(id)
            ? '<div class="axis-approval axis-approval-resolved"><span class="axis-approval-label">' + (res[id] ? '✅ Salvo na biblioteca' : '❌ Descartado') + ' — ' + esc(label) + '</span></div>'
            : '<div class="axis-voice-approval" data-voice-approval-id="' + id + '">' +
                '<div class="axis-approval-label">⚠️ ' + esc(label) + '</div>' +
                '<div class="axis-voice-approval-actions">' +
                '<button class="axis-approval-yes axis-voice-approve-yes" data-voice-approve="' + id + '">Sim, salvar</button>' +
                '<button class="axis-approval-no axis-voice-approve-no" data-voice-approve="reject_' + id + '">Não</button>' +
                '</div>' +
                '<div class="axis-voice-approval-adjust">' +
                '<input type="text" class="axis-voice-adjust-input" placeholder="Sugerir ajuste antes de aprovar (opcional)" data-voice-id="' + id + '">' +
                '<button class="axis-btn axis-btn-sm axis-voice-adjust-btn" data-voice-id="' + id + '">Ajustar</button>' +
                '</div></div>'
    ).replace(
        /\[AXIS:PROFILE_APPROVAL\s+ID:"([^"]+)"\s+LABEL:"([^"]+)"\]/g,
        (_, id, label) => res.hasOwnProperty(id)
            ? '<div class="axis-approval axis-approval-resolved"><span class="axis-approval-label">' + (res[id] ? '✅ Perfil salvo' : '❌ Descartado') + ' — ' + esc(label) + '</span></div>'
            : '<div class="axis-voice-approval axis-profile-approval" data-profile-approval-id="' + id + '">' +
                '<div class="axis-approval-label">⚠️ ' + esc(label) + '</div>' +
                '<div class="axis-voice-approval-actions">' +
                '<button class="axis-approval-yes axis-profile-approve-yes" data-profile-approve="' + id + '">Sim, salvar</button>' +
                '<button class="axis-approval-no axis-profile-approve-no" data-profile-approve="reject_' + id + '">Não</button>' +
                '</div>' +
                '<div class="axis-voice-approval-adjust">' +
                '<input type="text" class="axis-voice-adjust-input axis-profile-adjust-input" placeholder="Sugerir ajuste antes de aprovar (opcional)" data-profile-id="' + id + '">' +
                '<button class="axis-btn axis-btn-sm axis-voice-adjust-btn axis-profile-adjust-btn" data-profile-id="' + id + '">Ajustar</button>' +
                '</div></div>'
    );
}

function renderChat() {
    if (!chatArea) return;
    const s = scope();
    const cid = currentMiniChatId || 'main';
    const chat = s[KEYS.CHATS][cid];

    updateTrainingBanner();
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
            if (!id) return; // botões do card de voz (Ticket 19) usam data-voice-approve, não este
            e.target.closest('.axis-approval').innerHTML = '<span class="axis-approval-label">✅ Aprovado</span>';
            handleApproval(id, true, fixedChatId || currentMiniChatId || 'main');
        });
    });
    el.querySelectorAll('.axis-approval-no').forEach(b => {
        if (b.dataset.l) return; b.dataset.l = '1';
        b.addEventListener('click', e => {
            const id = e.target.dataset.approve;
            if (!id) return;
            e.target.closest('.axis-approval').innerHTML = '<span class="axis-approval-label">❌ Rejeitado</span>';
            handleApproval(id, false, fixedChatId || currentMiniChatId || 'main');
        });
    });
    listenVoiceApprovals(el, fixedChatId);
    listenProfileApprovals(el, fixedChatId); // Ticket 30
}

// Ticket 19: card de aprovação do rascunho de voz — Sim/Não iguais aos
// outros, mais um campo de texto pra sugerir ajuste ANTES de aprovar
// (sintetiza de novo com o ajuste, sobrescrevendo o mesmo rascunho).
function listenVoiceApprovals(container, fixedChatId) {
    const el = container || chatArea;
    if (!el) return;
    el.querySelectorAll('.axis-voice-approve-yes').forEach(b => {
        if (b.dataset.l) return; b.dataset.l = '1';
        b.addEventListener('click', e => {
            const id = e.target.dataset.voiceApprove;
            e.target.closest('.axis-voice-approval').innerHTML = '<span class="axis-approval-label">✅ Salvando...</span>';
            handleVoiceApproval(id, true, fixedChatId || currentMiniChatId || 'main');
        });
    });
    el.querySelectorAll('.axis-voice-approve-no').forEach(b => {
        if (b.dataset.l) return; b.dataset.l = '1';
        b.addEventListener('click', e => {
            const id = e.target.dataset.voiceApprove;
            e.target.closest('.axis-voice-approval').innerHTML = '<span class="axis-approval-label">❌ Rascunho descartado</span>';
            handleVoiceApproval(id, false, fixedChatId || currentMiniChatId || 'main');
        });
    });
    el.querySelectorAll('.axis-voice-adjust-btn').forEach(b => {
        if (b.dataset.l) return; b.dataset.l = '1';
        b.addEventListener('click', e => {
            const id = e.target.dataset.voiceId;
            const inputEl = el.querySelector('.axis-voice-adjust-input[data-voice-id="' + id + '"]');
            const adj = (inputEl?.value || '').trim();
            if (!adj) return;
            const card = e.target.closest('.axis-voice-approval');
            if (card) card.innerHTML = '<span class="axis-approval-label">🔄 Ajustando com: "' + esc(adj) + '"...</span>';
            synthesizeVoiceDraft(adj);
        });
    });
}

// Ticket 30: card de aprovação do rascunho de Perfil — mesmo padrão do de
// voz (Sim/Não/Ajustar), classes e data-attrs próprios pra não colidir com
// listenVoiceApprovals (senão o card de Perfil chamaria handleVoiceApproval
// por engano, que checa s[KEYS.VOICE].draft e falharia silenciosamente).
function listenProfileApprovals(container, fixedChatId) {
    const el = container || chatArea;
    if (!el) return;
    el.querySelectorAll('.axis-profile-approve-yes').forEach(b => {
        if (b.dataset.l) return; b.dataset.l = '1';
        b.addEventListener('click', e => {
            const id = e.target.dataset.profileApprove;
            e.target.closest('.axis-profile-approval').innerHTML = '<span class="axis-approval-label">✅ Salvando...</span>';
            handleProfileApproval(id, true, fixedChatId || currentMiniChatId || 'main');
        });
    });
    el.querySelectorAll('.axis-profile-approve-no').forEach(b => {
        if (b.dataset.l) return; b.dataset.l = '1';
        b.addEventListener('click', e => {
            const id = e.target.dataset.profileApprove;
            e.target.closest('.axis-profile-approval').innerHTML = '<span class="axis-approval-label">❌ Rascunho descartado</span>';
            handleProfileApproval(id, false, fixedChatId || currentMiniChatId || 'main');
        });
    });
    el.querySelectorAll('.axis-profile-adjust-btn').forEach(b => {
        if (b.dataset.l) return; b.dataset.l = '1';
        b.addEventListener('click', e => {
            const id = e.target.dataset.profileId;
            const inputEl = el.querySelector('.axis-profile-adjust-input[data-profile-id="' + id + '"]');
            const adj = (inputEl?.value || '').trim();
            if (!adj) return;
            const card = e.target.closest('.axis-profile-approval');
            if (card) card.innerHTML = '<span class="axis-approval-label">🔄 Ajustando com: "' + esc(adj) + '"...</span>';
            regenerateProfileDraft(adj, fixedChatId || currentMiniChatId || 'main');
        });
    });
}

// ====================================
// UPLOAD DE ARQUIVO NO TREINO/CHAT (Ticket 3, revisado no Ticket 14)
// v1: só lê arquivo de texto puro direto no navegador (FileReader.readAsText
// não extrai conteúdo de PDF/DOCX/etc — isso exigiria uma lib nova tipo
// pdf.js). Pra qualquer outro tipo, avisa e não trava nada.
// Ticket 14: antes o conteúdo do arquivo era colado direto no textarea —
// ao mandar, parecia que o usuário tinha digitado aquele textão inteiro.
// Agora o arquivo vira um CHIP separado (pendingAttachments) — o texto
// que o usuário digita continua sendo só o que ele digitou.
// ====================================
const AXIS_TEXT_EXT_RE = /\.(txt|md|markdown|csv|json|log|yaml|yml|xml|js|py|css|html)$/i;

function renderAttachChips() {
    const strip = document.getElementById('axis-attach-chips');
    if (!strip) return;
    if (!pendingAttachments.length) { strip.style.display = 'none'; strip.innerHTML = ''; return; }
    strip.style.display = 'flex';
    strip.innerHTML = pendingAttachments.map((a, i) =>
        '<span class="axis-attach-chip">📎 ' + esc(a.name) + '<button class="axis-attach-chip-remove" data-idx="' + i + '" title="Remover anexo">✕</button></span>'
    ).join('');
    strip.querySelectorAll('.axis-attach-chip-remove').forEach(b => {
        b.addEventListener('click', () => {
            pendingAttachments.splice(Number(b.dataset.idx), 1);
            renderAttachChips();
        });
    });
}

function handleFileAttach(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // permite escolher o mesmo arquivo de novo depois
    if (!files.length) return;
    files.forEach(file => {
        const isTextType = file.type.startsWith('text/') || file.type === 'application/json';
        const isTextExt = AXIS_TEXT_EXT_RE.test(file.name);
        if (isTextType || isTextExt) {
            const reader = new FileReader();
            reader.onload = () => {
                const content = String(reader.result || '').slice(0, 20000); // limite de segurança
                pendingAttachments.push({ name: file.name, content });
                renderAttachChips();
                if (input) input.focus();
            };
            reader.onerror = () => {
                addMsg('agent', '⚠️ Não consegui ler "' + file.name + '".', currentMiniChatId || 'main');
            };
            reader.readAsText(file);
        } else {
            addMsg('agent', '⚠️ Não consigo ler esse tipo de arquivo ainda ("' + file.name + '") — manda como texto colado, ou um .txt/.md/.csv/.json.', currentMiniChatId || 'main');
        }
    });
}

// ====================================
// ENVIAR MENSAGEM (MUTEX + INTERRUPÇÃO)
// ====================================
async function sendMessage() {
    if (isGenerating) return;
    const text = input.value.trim();
    const attachments = pendingAttachments.slice();
    if (!text && !attachments.length) return;

    const chatId = currentMiniChatId || 'main';

    // Se a IA está gerando no RP, INTERROMPE
    if (isGlobalLocked()) {
        requestInterrupt('Usuário digitou no Espaço', () => sendMessage());
        return;
    }

    input.value = '';
    pendingAttachments = [];
    renderAttachChips();
    // Ticket 14: o que fica salvo/exibido na conversa é só o texto que o
    // usuário escreveu + um indicador do anexo — nunca o conteúdo bruto do
    // arquivo, pra não parecer que ele digitou aquele textão inteiro.
    const displayText = text + (attachments.length ? (text ? ' ' : '') + attachments.map(a => '📎 ' + a.name).join(' ') : '');
    addMsg('user', displayText, chatId);
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
        const isBuildingProfile = !!chat.buildingProfile; // Ticket 30
        const isF12 = !!chat.f12;
        const shelfCtx = (chat.shelf && chat.shelf.length)
            ? '\n\n===== PRATELEIRA DESTE CHAT =====\n' + chat.shelf.map(it => '- ' + it.title + ': ' + it.content).join('\n')
            : '';

        let systemContent;
        if (isTraining) {
            const voice = s[KEYS.VOICE] || { lines: [], personality: '' };
            const voiceCtx = `\n\n===== TREINO DE VOZ — o que já foi guardado até agora =====\n${voice.lines.length} fala(s) de referência guardada(s).${voice.personality ? '\nDescrição de estilo atual: ' + voice.personality : '\nAinda sem descrição de estilo consolidada.'}`;
            systemContent = `Você é o Spade. Você está numa sessão de TREINO DE FALA para o personagem "${charName}". Você não é ${charName} — você está analisando e aprendendo o jeito dela falar a partir do que o usuário te mandar (texto colado, descrições de estilo, trechos de diálogo, ou arquivo anexado com 📎).

O que fazer:
1. Pra cada fala/exemplo REAL de diálogo que o usuário mandar (uma linha isolada, só o diálogo em si, sem comentário seu), extraia com: [AXIS:VOICE_LINE CATEGORY:"nome curto da pasta"]a fala em si, sem aspas nem comentário[/AXIS:VOICE_LINE] — pode ter várias na mesma resposta, uma tag por exemplo. A categoria organiza a biblioteca em pastas (2-3 palavras, ex: "Comando/Ordem", "Provocação/Flerte", "Poder/Status", "Vulnerabilidade", "Ironia/Deboche", "Afeto disfarçado", "Cotidiano/Trabalho") — reaproveite uma dessas ou uma já usada nessa sessão antes de inventar uma nova; a categoria é opcional, pode omitir o CATEGORY se genuinamente não for óbvio.
1b. Se o usuário mandar um exemplo do que ela NÃO deveria dizer (um contra-exemplo — "ela nunca falaria assim", "isso soa errado pra ela"), guarde com TYPE:"contra" logo depois do CATEGORY (se tiver categoria, TYPE vem sempre depois dela): [AXIS:VOICE_LINE CATEGORY:"nome da pasta" TYPE:"contra"]a fala que ela NÃO fala assim[/AXIS:VOICE_LINE]. Sem o TYPE, a fala é tratada como exemplo normal (o que ela FALA assim).
2. Quando você sentir que já entendeu o ESTILO geral (não uma fala específica, mas o padrão: vocabulário, ritmo, maneirismos, o que ela evita dizer), registre/atualize com: [AXIS:VOICE_PERSONALITY]descrição completa e atual do estilo de fala[/AXIS:VOICE_PERSONALITY] — isso SUBSTITUI a descrição anterior inteira (não concatena), então sempre escreva a versão mais completa que você tem até agora, não só o que mudou.
3. Pode narrar seu raciocínio com [AXIS:THINK] no meio da resposta.
4. Quando sentir que já tem material suficiente pra capturar o tom de voz de verdade, pergunte se o usuário quer finalizar. Se ele confirmar, inclua [AXIS:END_TRAINING] na resposta — isso aplica o estilo aprendido de verdade ao personagem (as falas guardadas passam a ser recuperadas por relevância a cada cena do RP, não injetadas todas de uma vez).
5. Se o usuário pedir pra você SINTETIZAR/CONSOLIDAR/ATUALIZAR o tom agora (em vez de só mandar mais exemplos) — não faça isso narrando, inclua [AXIS:SYNTHESIZE_VOICE] na resposta. Isso trava o chat, gera um rascunho de verdade a partir do que já foi treinado, e mostra um card de aprovação (Sim / Não / Ajustar) antes de qualquer coisa entrar na biblioteca de fato. O mesmo acontece se o usuário clicar no botão "🔄 Sintetizar" — você não precisa fazer nada nesse caso, o código cuida.

Nunca fale COMO ${charName} neste chat. Fale sempre na sua própria voz, comentando sobre o estilo dela.
${voiceCtx}
${shelfCtx}
${fullCtx}`;
        } else if (isBuildingProfile) {
            const prof = s[KEYS.PROFILE] || {};
            const currentCtx = prof.text?.trim()
                ? `\n\n===== PERFIL ATUAL (revise em cima disso, não comece do zero sem motivo) =====\n${prof.text}`
                : '\n\n===== Ainda não existe Perfil salvo =====';
            systemContent = `Você é o Spade, ajudando o usuário a montar o PERFIL de "${charName}" através de conversa — não é ele escrevendo um textão sozinho, é você perguntando e organizando.

O que fazer:
1. Pergunte, uma coisa de cada vez (não uma lista de 10 perguntas de uma vez): quem ${charName} é (papel, contexto de vida), o que a formou (história, o que pesa), como ela lida com o que sente (esconde? mostra? tem um jeito específico de reagir quando algo abala ela?), gente importante pra ela e como são essas relações, manias ou hábitos bem específicos — o tipo de detalhe concreto que faz ela parecer real, não genérica.
2. Você pode narrar seu raciocínio com [AXIS:THINK] no meio da resposta.
3. Quando sentir que já tem o suficiente pra um perfil de verdade (não precisa ser tudo, só o bastante pra ter substância), OU se o usuário pedir explicitamente pra fechar/finalizar agora, proponha o rascunho: [AXIS:PROFILE_DRAFT]texto completo, em prosa, separando blocos temáticos com uma linha em branco + "---" três vezes + linha em branco quando fizer sentido (identidade/história — depois — como lida com emoção — depois — relações/manias)[/AXIS:PROFILE_DRAFT] seguido de [AXIS:PROFILE_GENDER]ela, ele ou neutro[/AXIS:PROFILE_GENDER] (neutro só se genuinamente não ficou claro ou o usuário não especificou). Isso mostra um card de aprovação — não é definitivo até o usuário confirmar.
4. Se o usuário pedir ajuste depois de ver o rascunho, isso é tratado pelo campo de ajuste do próprio card — você não precisa fazer nada extra nesse caso.

Nunca fale COMO ${charName} aqui. Fale na sua própria voz, sobre ela.
${currentCtx}
${shelfCtx}
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
6. Se o usuário pedir um ajuste SIMPLES de tom/comportamento — não um sistema novo, algo tipo "fala menos", "ela tá se abrindo demais", "melhora a qualidade/detalhe das falas", "seja mais dinâmico" — NÃO proponha um sistema pesado. Responda confirmando o ajuste em uma frase e inclua [AXIS:DIRECTIVE]instrução direta e clara[/AXIS:DIRECTIVE] — isso aplica JÁ na próxima resposta do RP, sem aprovação. Só vire SYSTEM_PROPOSAL se o pedido for claramente estrutural (mecânica nova, relacionamento, memória, etc), não pra um ajuste de tom pontual.

Cuidado especial com pedidos vagos de ENERGIA/RITMO ("mais dinâmica", "mais viva", "mais envolvente"): não repasse o adjetivo cru pro DIRECTIVE — isso já foi tentado e o resultado foi a resposta crescer cada vez mais (mais narração, mais elaboração), o oposto de dinâmico de verdade. Traduza pra uma instrução concreta que peça VARIAÇÃO de ritmo, não mais volume — ex: "varie o ritmo: cenas de baixa tensão continuam curtas e diretas, só expanda quando a tensão da cena pedir de verdade — não deixe a resposta crescer só porque a conversa avançou".

Um sistema de verdade é desenvolvido, não uma frase vaga. Ele tem: tipo, 3-6 etapas concretas, e um promptText completo (a instrução real que vai afetar o personagem).

AVISO IMPORTANTE pra sistemas do tipo "thinking": alguns modelos (GLM, DeepSeek-R1, Qwen com thinking, etc) já têm um canal de raciocínio PRÓPRIO e nativo, separado da resposta. Se o promptText desse tipo de sistema instruir o personagem a "escrever"/"narrar" o raciocínio como parte da resposta visível, isso compete com esse canal nativo e pode vazar pensamento pra resposta final de forma bagunçada. Em vez disso, escreva sistemas de "thinking" como uma descrição de COMO a personagem deveria chegar nas conclusões dela (prioridades, o que ela nota primeiro, o que pesa mais) — não como uma instrução pra ela expor esse processo por escrito.

Formato de sistema:
[AXIS:SYSTEM_PROPOSAL]
{"name":"Nome","type":"behavior","description":"resumo","steps":["Etapa 1","Etapa 2","Etapa 3"],"promptText":"Instrução completa aqui."}
[/AXIS:SYSTEM_PROPOSAL]

Formato pra APAGAR um sistema já existente (use o nome EXATO como está listado em SISTEMAS ATIVOS — isso é destrutivo, só proponha se o usuário claramente quiser remover algo):
[AXIS:SYSTEM_DELETE NAME:"Nome exato do sistema"]

Formato pra ATUALIZAR um sistema já existente (o nome tem que bater com um sistema que já existe — os campos preenchidos substituem os antigos, não precisa repetir o que não mudou):
[AXIS:SYSTEM_UPDATE]
{"name":"Nome exato (do sistema que já existe)","promptText":"novo texto","description":"...","steps":["..."]}
[/AXIS:SYSTEM_UPDATE]

Formato de ajuste rápido de tom/comportamento (Ticket 16 — sem aprovação, aplica na hora, SUBSTITUI o ajuste anterior):
[AXIS:DIRECTIVE]instrução direta, ex: "fale menos, respostas mais curtas e contidas" ou "pare de fazer ela se abrir tão rápido, seja mais reservada"[/AXIS:DIRECTIVE]

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

${SPADE_TOOLS_DESC}

IMPORTANTE: só existem os marcadores listados acima. NUNCA invente um marcador novo (ex: não existe "SYSTEM_CREATE" — pra criar sistema é sempre [AXIS:SYSTEM_PROPOSAL] em JSON, como mostrado). Um marcador fora dessa lista não executa nada — só aparece cru na tela pro usuário, o que é pior que não fazer nada, porque parece que algo rodou quando não rodou. Na dúvida entre inventar um marcador ou não usar nenhum, não use nenhum: responda em texto normal, ou use [AXIS:DIRECTIVE] se for só um ajuste de tom pontual.
${shelfCtx}
${fullCtx}`;
        }

        const msgs = [{ role: 'system', content: systemContent }];
        for (const m of recent) {
            msgs.push({ role: m.role === 'agent' ? 'assistant' : m.role, content: m.text });
        }
        // O conteúdo REAL do(s) arquivo(s) só entra aqui, na chamada de
        // agora — o que fica gravado no histórico (msgs.push acima já usou
        // m.text, que é o displayText sem o arquivo) continua limpo.
        if (attachments.length) {
            const lastMsg = msgs[msgs.length - 1];
            if (lastMsg && lastMsg.role === 'user') {
                lastMsg.content = text + '\n\n' + attachments.map(a => '--- arquivo: ' + a.name + ' ---\n' + a.content).join('\n\n');
            }
        }

        let resp = await generateWithTools(msgs, { maxTokens: 800 });
        if (!resp) throw new Error('Resposta vazia.');

        // Marcadores de treino/f12 (checados antes dos outros, viram ação de código)
        const wantsStartTraining = resp.includes(TAGS.START_TRAINING);
        const wantsEndTraining = resp.includes(TAGS.END_TRAINING);
        const wantsF12Disable = resp.includes(TAGS.F12_DISABLE);
        const wantsSynthesize = resp.includes(TAGS.SYNTHESIZE_VOICE);
        resp = resp.split(TAGS.START_TRAINING).join('').split(TAGS.END_TRAINING).join('').split(TAGS.F12_DISABLE).join('').split(TAGS.SYNTHESIZE_VOICE).join('');

        if (isTraining) {
            resp = await processVoiceLines(resp, chatId);
            resp = processVoicePersonality(resp);
        }
        resp = processShelfAdds(resp, chatId);
        resp = processNpcProposals(resp);
        resp = processNpcSpeak(resp);
        resp = await processCharSpeak(resp);
        resp = processSystemDelete(resp);
        resp = processSystemUpdate(resp);
        resp = processSystemCreateCompat(resp); // Ticket 20: compat pra SYSTEM_CREATE alucinado
        resp = processDirective(resp, chatId);
        resp = processProfileDraft(resp, chatId); // Ticket 30
        let processed = processSystemProposals(resp);
        processed = stripUnknownAxisMarkers(processed); // Ticket 20: rede de segurança final
        addMsg('agent', processed, chatId);

        if (wantsStartTraining && !isTraining) startVoiceTraining();
        if (wantsEndTraining && isTraining) endVoiceTraining(chatId);
        if (wantsF12Disable && isF12) doF12Disable(chatId);
        if (wantsSynthesize && isTraining) synthesizeVoiceDraft();

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
        '<button id="axis-btn-library" class="axis-btn" title="Biblioteca de Voz (RAG)">📚</button>' +
        '<button id="axis-btn-profile" class="axis-btn" title="Perfil">👤</button>' +
        '<button id="axis-btn-f12" class="axis-btn" title="Modo Substituir — aponte pra qualquer coisa do SillyTavern">🎯</button>' +
        '<button id="axis-btn-phone" class="axis-btn" title="Celular — conversas do elenco em segundo plano">📱</button>' +
        '<button id="axis-btn-tasks" class="axis-btn" title="Tarefas — Mini RPG">📋</button>' +
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
        '<input type="file" id="axis-file-input" style="display:none" multiple>' +
        '<button class="axis-btn" id="axis-btn-attach" title="Anexar arquivo (texto)">📎</button>' +
        '<div class="axis-espaco-input-wrap">' +
        '<div id="axis-attach-chips" class="axis-attach-chips" style="display:none;"></div>' +
        '<textarea id="axis-espaco-input" class="axis-espaco-input" rows="2" placeholder="Fale com a IA..."></textarea>' +
        '</div>' +
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
    document.getElementById('axis-btn-library').addEventListener('click', toggleVoiceLibraryPanel);
    document.getElementById('axis-btn-profile').addEventListener('click', toggleProfilePanel);
    document.getElementById('axis-btn-f12').addEventListener('click', toggleF12Mode);
    document.getElementById('axis-btn-phone').addEventListener('click', togglePhonePanel);
    document.getElementById('axis-btn-tasks').addEventListener('click', toggleTasksPanel);
    sendBtn.addEventListener('click', sendMessage);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
    document.getElementById('axis-btn-attach').addEventListener('click', () => document.getElementById('axis-file-input').click());
    document.getElementById('axis-file-input').addEventListener('change', handleFileAttach);

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
        '<button class="axis-tool-item" id="axis-tool-stop-rp">🛑 Parar Geração do RP</button>' +
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
    document.getElementById('axis-tool-stop-rp').addEventListener('click', () => {
        p.remove();
        // Mesmo botão oficial de parar do SillyTavern (já usado internamente
        // por requestInterrupt) — não o parâmetro abort() do interceptor, que
        // só existe durante a própria chamada de geração e não fica
        // acessível pra um botão manual clicado depois.
        const stopBtn = document.getElementById('stop_gen');
        if (stopBtn && !stopBtn.classList.contains('displayNone')) {
            stopBtn.click();
            addMsg('agent', '🛑 Pedido de parar enviado pro RP.');
        } else {
            addMsg('agent', '🛑 Não parece ter nada gerando no RP agora.');
        }
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

// ====================================
// BIBLIOTECA DE VOZ (Ticket 15 + Ticket 21 — pastas)
// Ticket 21: falas podem ter uma categoria (pasta). O treino já sugere uma
// ao guardar cada exemplo novo (ver instrução acima). Falas antigas sem
// categoria caem em "Sem pasta" até serem organizadas — manualmente (editar
// o campo `category` de fora não é suportado ainda) ou pelo botão de
// organização automática, que SÓ adiciona `category` a falas que ainda não
// têm — nunca mexe em `text`, `embedding` ou `ts` de nenhuma linha, e nunca
// remove nenhuma fala. Roda em lotes pra não estourar o prompt com 300 falas.
// ====================================
function groupVoiceLinesByCategory(lines) {
    const groups = {};
    lines.forEach((l, idx) => {
        const cat = (l.category && l.category.trim()) || 'Sem pasta';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push({ ...l, _idx: idx });
    });
    const names = Object.keys(groups).sort((a, b) => {
        if (a === 'Sem pasta') return 1;
        if (b === 'Sem pasta') return -1;
        return a.localeCompare(b, 'pt-BR');
    });
    return names.map(name => ({ name, items: groups[name] }));
}

async function categorizeVoiceLines() {
    const s = scope();
    const voice = s[KEYS.VOICE];
    const btn = document.getElementById('axis-library-organize');
    if (!voice || !voice.lines?.length) return;
    const uncategorized = voice.lines.map((l, i) => ({ l, i })).filter(x => !x.l.category);
    if (!uncategorized.length) { refreshVoiceLibraryPanel(); return; }

    const existingCats = [...new Set(voice.lines.map(l => l.category).filter(Boolean))];
    const suggested = 'Comando/Ordem, Provocação/Flerte, Poder/Status, Vulnerabilidade, Ironia/Deboche, Afeto disfarçado, Cotidiano/Trabalho';
    const batchSize = 40;
    let organized = 0;
    try {
        for (let start = 0; start < uncategorized.length; start += batchSize) {
            const batch = uncategorized.slice(start, start + batchSize);
            const listText = batch.map((x, bi) => bi + '. ' + x.l.text.replace(/\n/g, ' ')).join('\n');
            const cats = existingCats.length ? existingCats.join(', ') : suggested;
            const msgs = [{ role: 'system', content: 'Classifique cada fala abaixo numa categoria curta (2-3 palavras) que organize uma biblioteca de falas de personagem por TEMA/FUNÇÃO. Categorias sugeridas, reaproveite quando fizer sentido: ' + cats + '. Só crie uma categoria nova se nenhuma dessas encaixar de verdade. Responda APENAS com um JSON válido, sem markdown, sem texto antes/depois, no formato {"0":"Categoria","1":"Categoria"} usando o índice de cada linha.\n\nFalas:\n' + listText }];
            const resp = await generate(msgs, { maxTokens: 1000 });
            let map;
            try { map = JSON.parse((resp || '').trim().replace(/^```(json)?\s*|```$/g, '')); } catch (_) { continue; }
            if (!map || typeof map !== 'object') continue;
            batch.forEach((x, bi) => {
                const cat = map[String(bi)];
                if (cat && typeof cat === 'string' && cat.trim()) { voice.lines[x.i].category = cat.trim(); organized++; }
            });
        }
    } catch (e) { console.warn('[Spade] Falha ao organizar falas em pastas:', e); }
    save();
    refreshVoiceLibraryPanel();
    const remaining = uncategorized.length - organized;
    addMsg('agent', '📁 ' + organized + ' fala(s) organizada(s) em pastas.' + (remaining > 0 ? ' ' + remaining + ' ficaram sem pasta (tenta de novo se quiser).' : ''));
}

// Ticket 27 (item 8) — treino ESCREVE fala nova (sempre com aprovação):
// olha as pastas com menos exemplo e gera 8 falas inéditas nesse estilo,
// pra fortalecer justamente onde a biblioteca é mais rasa.
async function synthesizeNewVoiceLines(focusCategory) {
    const s = scope();
    const voice = s[KEYS.VOICE];
    if (!voice?.lines?.length) { addMsg('agent', 'Precisa ter falas guardadas primeiro.'); return; }
    const byCat = {};
    voice.lines.forEach(l => { const c = l.category || 'Sem pasta'; byCat[c] = (byCat[c] || 0) + 1; });
    const target = focusCategory || Object.entries(byCat).sort((a, b) => a[1] - b[1])[0]?.[0];
    const sample = voice.lines.filter(l => !l.isCounterExample).slice(-40).map(l => l.text).join('\n- ');
    const resp = await generate([{ role: 'system', content: 'Falas reais do personagem:\n- ' + sample + '\n\nEscreva 8 falas NOVAS, que ainda não existem, no mesmo estilo — foque na categoria "' + target + '", que tem pouco exemplo. Uma por linha, sem numeração/aspas.' }], { maxTokens: 600 });
    const newLines = (resp || '').split('\n').map(l => l.trim()).filter(l => l.length > 5);
    if (!newLines.length) { addMsg('agent', 'Não consegui gerar dessa vez.'); return; }
    const uid = 'voicegen_' + Date.now();
    if (!s._pending) s._pending = {};
    s._pending[uid] = { lines: newLines, category: target };
    addMsg('agent', '[AXIS:CARD]\n🎙️ ' + newLines.length + ' fala(s) nova(s) pra "' + target + '":\n\n' + newLines.map(l => '- ' + l).join('\n') + '\n[AXIS:CARD_END]\n[AXIS:APPROVAL ID:"add_voicelines_' + uid + '" LABEL:"Adicionar à biblioteca?"]');
}

function refreshVoiceLibraryPanel() {
    const ex = document.getElementById('axis-library-panel');
    if (ex) { ex.remove(); toggleVoiceLibraryPanel(); }
}

function toggleVoiceLibraryPanel() {
    const ex = document.getElementById('axis-library-panel');
    if (ex) { ex.remove(); return; }
    const s = scope();
    const voice = s[KEYS.VOICE] || { lines: [], personality: '', draft: null };
    const p = document.createElement('div');
    p.id = 'axis-library-panel'; p.className = 'axis-tools-panel axis-library-panel';

    const personalityHtml = voice.personality
        ? '<div class="axis-system-item"><div class="axis-system-name">🎙️ Estilo consolidado</div><div class="axis-system-desc">' + esc(voice.personality) + '</div></div>'
        : '<p class="axis-empty">Sem descrição de estilo consolidada ainda.</p>';

    const draftHtml = voice.draft
        ? '<div class="axis-system-item"><div class="axis-system-name">🆕 Rascunho pendente de aprovação</div><div class="axis-system-desc">' + esc(voice.draft.personality || '') + '</div></div>'
        : '';

    const uncategorizedCount = voice.lines.filter(l => !l.category).length;
    const organizeBtnHtml = voice.lines.length
        ? '<button class="axis-btn axis-btn-sm" id="axis-library-organize"' + (uncategorizedCount ? '' : ' disabled') + '>' +
          (uncategorizedCount ? '🗂️ Organizar automaticamente (' + uncategorizedCount + ' sem pasta)' : '✅ Tudo organizado em pastas') +
          '</button>'
        : '';
    // Ticket 27 (item 8)
    const generateBtnHtml = voice.lines.length ? '<button class="axis-btn axis-btn-sm" id="axis-library-generate">🖋️ Gerar falas novas</button>' : '';

    const folders = groupVoiceLinesByCategory(voice.lines);
    const foldersHtml = voice.lines.length
        ? folders.map(f =>
            '<div class="axis-library-folder">' +
            '<div class="axis-library-folder-header" data-folder="' + esc(f.name) + '">📁 ' + esc(f.name) + ' (' + f.items.length + ')</div>' +
            '<div class="axis-library-folder-body">' +
            f.items.slice().reverse().map(l =>
                '<div class="axis-system-item">' +
                '<div class="axis-system-desc">' + (l.embedding ? '✅ com vetor' : '⚠️ sem vetor') +
                (l.isCounterExample ? ' · 🚫 contra-exemplo' : '') +
                (l.pendingReview ? ' · 🆕 captado sozinho, não conferido' : '') +
                ' · <small>' + new Date(l.ts || 0).toLocaleString() + '</small></div>' +
                '<div>' + esc(l.text) + '</div></div>'
            ).join('') +
            '</div></div>'
        ).join('')
        : '<p class="axis-empty">Nenhuma fala guardada ainda.</p>';

    p.innerHTML =
        '<div class="axis-tools-header"><span>📚 Biblioteca de Voz</span><button class="axis-btn axis-btn-close" id="axis-library-close">✕</button></div>' +
        '<div class="axis-tools-body">' +
        draftHtml +
        personalityHtml +
        '<div class="axis-tool-section">FALAS (' + voice.lines.length + ')</div>' +
        organizeBtnHtml +
        generateBtnHtml +
        foldersHtml +
        '</div>';
    panel.appendChild(p);
    document.getElementById('axis-library-close').addEventListener('click', () => p.remove());
    document.getElementById('axis-library-organize')?.addEventListener('click', e => {
        e.target.disabled = true; e.target.textContent = '🗂️ Organizando...';
        categorizeVoiceLines();
    });
    document.getElementById('axis-library-generate')?.addEventListener('click', e => {
        e.target.disabled = true; e.target.textContent = '🖋️ Gerando...';
        synthesizeNewVoiceLines().finally(() => p.remove());
    });
    p.querySelectorAll('.axis-library-folder-body').forEach(b => { b.style.display = 'none'; });
    p.querySelectorAll('.axis-library-folder-header').forEach(h => {
        h.addEventListener('click', () => {
            const body = h.nextElementSibling;
            const open = body.style.display !== 'none';
            body.style.display = open ? 'none' : 'block';
            h.classList.toggle('axis-library-folder-open', !open);
        });
    });
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
    const cast = (s[KEYS.CAST] || []).filter(n => !n.archived); // Ticket 26
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
// Ticket 12: antes só rodava no clique manual (Ferramentas → Gerar Diário).
// Agora também roda sozinho a cada ~40 mensagens do RP (mais espaçado que
// memória/imersão, já que diário é menos frequente por natureza). O botão
// manual continua existindo como opção extra, não como único jeito.
// ====================================
async function generateDiary(auto) {
    const s = scope();
    const chatId = currentMiniChatId || 'main';
    if (!auto) addMsg('agent', '[AXIS:ACTION] Escrevendo diário...', chatId);
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
        if (auto) {
            const a = s[KEYS.ALIVE];
            a.ramblingLog.push({ ts: Date.now(), text: '📔 Nova entrada de diário escrita automaticamente — dá pra ver em Ferramentas → Ver Diário.' });
            if (a.ramblingLog.length > 30) a.ramblingLog = a.ramblingLog.slice(-30);
            save();
            renderRamblingLog();
        } else {
            addMsg('agent', '[AXIS:CARD]\nDiário — ' + new Date().toLocaleString() + '\n\n' + content + '\n[AXIS:CARD_END]', chatId);
        }
    } catch (e) { if (!auto) addMsg('agent', 'Erro: ' + (e.message || e), chatId); }
}

async function maybeGenerateDiary() {
    if (isGlobalLocked() || isGenerating) return;
    const s = scope();
    const a = s[KEYS.ALIVE];
    a.msgsSinceDiary = (a.msgsSinceDiary || 0) + 1;
    if (a.msgsSinceDiary < 40) { save(); return; }
    a.msgsSinceDiary = 0;
    save();
    await generateDiary(true);
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
    applyDirective();
    applyProfile(); // Ticket 23
    applyThinkingPreset(); // Ticket 31
    applyInnerState(); // Ticket 25
    applyRhythmGuard(); // Ticket 22
    applyNpcAutoTagGuard(); // Ticket 26
    applyAntiRobotGuard(); // Ticket 27 (item 10)
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
    applyDirective();
    applyProfile(); // Ticket 23
    applyThinkingPreset(); // Ticket 31
    applyInnerState(); // Ticket 25
    applyRhythmGuard(); // Ticket 22
    applyNpcAutoTagGuard(); // Ticket 26
    applyAntiRobotGuard(); // Ticket 27 (item 10)
});

eventSource.on(event_types.GENERATION_STARTED, () => { globalLock(); RP_GENERATING = true; dotsWriting(); });
eventSource.on(event_types.GENERATION_STOPPED, () => { globalUnlock(); RP_GENERATING = false; dotsIdle(); });
eventSource.on(event_types.GENERATION_ENDED, () => { globalUnlock(); RP_GENERATING = false; dotsIdle(); });

eventSource.on(event_types.MESSAGE_RECEIVED, () => {
    const s0 = scope();
    s0[KEYS.ALIVE].totalRpMessages = (s0[KEYS.ALIVE].totalRpMessages || 0) + 1;
    processInlineNpcTag(); // Ticket 26 — antes de tudo, precisa ler a mensagem crua
    updateNpcMentions();   // Ticket 26
    save();

    analyzeUser();
    maybeRamble('rp');
    maybeSummarizeMemory();
    maybeAdvanceImmersion();
    maybeGenerateDiary();
    maybeIndexScene(); // Ticket 27 (5c)
    advanceClockPassive(); // Ticket 29a

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
eventSource.on(event_types.MESSAGE_SENT, () => {
    analyzeUser();
    // Ticket 29a: se o usuário escreveu um horário explícito na própria
    // mensagem, o relógio pula pra esse horário (ver checkExplicitTimeJump).
    try {
        const liveChat = Array.isArray(ctx.chat) ? ctx.chat : [];
        const last = liveChat[liveChat.length - 1];
        if (last && last.is_user && last.mes) checkExplicitTimeJump(String(last.mes));
    } catch (_) { /* nunca trava o envio normal por causa disso */ }
});

// Ticket 27 (item 9) — sinal implícito de treino: quando o usuário troca
// (swipe) uma resposta do personagem, a versão abandonada geralmente é o
// que NÃO soou como ela — guarda como contra-exemplo automático, sem
// perguntar nada, marcado como "ainda não conferido" (pendingReview).
// event_types.MESSAGE_SWIPED e o formato de swipes/swipe_id podem mudar
// entre versões do SillyTavern — isso está protegido em try/catch e
// qualquer coisa fora do esperado só faz a captura ser pulada, nunca
// trava o RP.
let _lastSwipeSeen = { msgIdx: null, swipeId: null }; // Ticket 27 (item 9) — precisa do índice REAL anterior, não dá pra assumir swipe_id-1 (o usuário pode voltar, não só avançar)
eventSource.on(event_types.MESSAGE_SWIPED, async () => {
    try {
        const liveChat = Array.isArray(ctx.chat) ? ctx.chat : [];
        const idx = liveChat.length - 1;
        const last = liveChat[idx];
        if (!last || last.is_user || !Array.isArray(last.swipes) || last.swipe_id == null) return;
        const prevSwipeId = (_lastSwipeSeen.msgIdx === idx) ? _lastSwipeSeen.swipeId : null;
        _lastSwipeSeen = { msgIdx: idx, swipeId: last.swipe_id };
        if (prevSwipeId == null || prevSwipeId === last.swipe_id) return; // primeira vez vendo essa mensagem, ou não mudou de verdade
        const abandonedText = last.swipes[prevSwipeId];
        if (!abandonedText || abandonedText.length < 40) return;
        const s = scope();
        if (!s[KEYS.VOICE]) s[KEYS.VOICE] = { lines: [], personality: '' };
        s[KEYS.VOICE].lines.push({ text: String(abandonedText).replace(/<[^>]+>/g, '').slice(0, 400), embedding: null, ts: Date.now(), category: '', isCounterExample: true, source: 'ia', pendingReview: true });
        save();
    } catch (e) { console.warn('[Spade] Falha ao capturar sinal de swipe:', e); }
});

})();