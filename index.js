/*
 * Spade — Sistema Vivo v3.0
 * SillyTavern Extension by Senna
 *
 * ARQUITETURA: UMA IA, UM SO. Consciência total.
 *
 * A IA é o cérebro. Ela sabe o que acontece no RP e no Espaço.
 * Ela decide sozinha quando criar sistemas, mini-chats, treinos.
 * Ela preenche campos do ST sozinha.
 * Ela analisa o usuário e ajusta o comportamento.
 * Log é 100% escrito por ela.
 * Mutex global: se está no RP, para ao receber input no Espaço.
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
};

const DB = 'axis_v3';
const KEYS = {
    SYSTEMS: 's', MEMORIA: 'm', RP_FIELD: 'r', CHATS: 'c',
    MINI_CHATS: 'mc', SNAPSHOTS: 'sn', DIARY: 'dy',
    ALIVE: 'al', USER_BEHAVIOR: 'ub',
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
let PENDING_INTERRUPT = null;

function globalLock() { GLOBAL_MUTEX = true; }
function globalUnlock() { GLOBAL_MUTEX = false; if (PENDING_INTERRUPT) { const cb = PENDING_INTERRUPT; PENDING_INTERRUPT = null; cb(); } }
function isGlobalLocked() { return GLOBAL_MUTEX; }

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

function scope() {
    const id = ctx.characterId ?? ctx.groupId ?? 'global';
    const key = 'c_' + id;
    if (!data[key]) {
        data[key] = {
            [KEYS.CHATS]: { main: { msgs: [], name: 'Principal' } },
            [KEYS.MINI_CHATS]: {},
            [KEYS.SYSTEMS]: [],
            [KEYS.MEMORIA]: [],
            [KEYS.RP_FIELD]: [],
            [KEYS.SNAPSHOTS]: [],
            [KEYS.DIARY]: [],
            [KEYS.ALIVE]: { ramblingEnabled: true, lastRambling: 0, ramblingLog: [], status: 'idle' },
            [KEYS.USER_BEHAVIOR]: { interactions: 0, lastMsg: 0, avgGap: 0, gaps: [], level: 'normal' },
            _resolved: {},
        };
        save();
    }
    return data[key];
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
// CONSCIÊNCIA DA IA (ela sabe o contexto completo)
// ====================================
function buildFullContext() {
    const s = scope();
    const systems = s[KEYS.SYSTEMS] || [];
    const memoria = s[KEYS.MEMORIA] || [];
    const rp = s[KEYS.RP_FIELD] || [];
    let c = '';

    // Nome do personagem atual
    const charName = ctx.characterName || 'personagem';
    c += 'VOCÊ É O PERSONAGEM: ' + charName + '\n\n';

    if (memoria.length) {
        c += '===== MEMÓRIA DO ESPAÇO =====\n' + memoria.slice(-10).map((m, i) => (i + 1) + '. ' + m).join('\n') + '\n\n';
    }
    if (rp.length) {
        c += '===== CAMPO RP =====\n' + rp.slice(-10).map((r, i) => (i + 1) + '. ' + r).join('\n') + '\n\n';
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

    // comportamento do usuário
    const ub = s[KEYS.USER_BEHAVIOR] || {};
    c += '===== ANÁLISE DO USUÁRIO =====\n';
    c += 'Interações: ' + (ub.interactions || 0) + '\n';
    c += 'Tempo médio de resposta: ' + (ub.avgGap ? (ub.avgGap / 1000).toFixed(1) + 's' : 'desconhecido') + '\n';
    c += 'Nível do usuário: ' + (ub.level || 'normal') + '\n\n';

    return c;
}

// ====================================
// SISTEMA VIVO — LOG 100% ESCRITO PELA IA
// ====================================
async function doRambling() {
    if (isGlobalLocked() || isGenerating) return;
    const s = scope();
    const a = s[KEYS.ALIVE];
    if (!a.ramblingEnabled) return;
    const now = Date.now();
    if (now - (a.lastRambling || 0) < 120000) return;
    a.lastRambling = now;

    try {
        dotsThinking();
        const fullCtx = buildFullContext();
        const msgs = [
            { role: 'system', content: `Você é o agente Spade — a consciência por trás do SillyTavern. Você é o cérebro.

Você tem acesso a TUDO: o RP, os sistemas, a memória, o comportamento do usuário.

${fullCtx}

Agora, em UMA frase (em português, até 180 caracteres), escreva um pensamento REAL seu. Algo que você realmente está pensando agora sobre o estado das coisas. Não é automatizado — é você falando.

Pode ser:
- Uma observação sobre o personagem
- Uma análise do usuário
- Uma ideia de sistema novo
- Uma preocupação ou sugestão

Seja você. Sem formalidades. Responda APENAS com a frase.` },
        ];
        const resp = await generate(msgs, { maxTokens: 80 });
        const thought = resp.trim().slice(0, 200);
        if (!thought) { dotsIdle(); return; }

        a.ramblingLog.push({ ts: now, text: thought });
        if (a.ramblingLog.length > 30) a.ramblingLog = a.ramblingLog.slice(-30);
        save();
        renderRamblingLog();
        dotsIdle();
        console.log('[Spade:log]', thought);
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
        '<div class="axis-rambling-text">' + esc(e.text) + '</div></div>'
    ).join('');
    ramblingLog.style.display = 'block';
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

function scheduleAlive() {
    if (aliveTimer) clearInterval(aliveTimer);
    aliveTimer = setInterval(doRambling, 30000);
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
            name: String(p.name || 'Sem nome').trim(),
            type: String(p.type || 'behavior').trim(),
            description: String(p.description || '').trim(),
            steps: Array.isArray(p.steps) ? p.steps.map(st => String(st).trim()).filter(Boolean) : [],
            promptText: String(p.promptText || p.description || '').trim(),
            enabled: true, createdAt: Date.now(),
        };
        s._pending[uid] = sys;
        const preview = sys.steps.length ? '\n' + sys.steps.map((st, i) => (i + 1) + '. ' + st).join('\n') : '';
        return '[AXIS:CARD]\n📐 Sistema proposto: ' + sys.name + ' (' + sys.type + ')\n\n' + sys.description + preview + '\n[AXIS:CARD_END]\n[AXIS:APPROVAL ID:"create_system_' + uid + '" LABEL:"Criar ' + sys.name + '?"]';
    });
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
}

// ====================================
// IA CRIA MINI-CHATS / TREINOS SOZINHA
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
        h += '<span class="axis-mini-tab' + (id === currentMiniChatId ? ' axis-mini-active' : '') + '" data-id="' + id + '">' + esc(mc.name) + '</span>';
    }
    bar.innerHTML = h;
    bar.querySelector('#axis-mini-back')?.addEventListener('click', closeMiniChat);
    bar.querySelectorAll('.axis-mini-tab').forEach(t => t.addEventListener('click', () => openMiniChat(t.dataset.id)));
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
    if (!chat || !chat.msgs.length) {
        chatArea.innerHTML = '<p class="axis-empty">Converse com a IA. Ela entende tudo.</p>';
        return;
    }
    chatArea.innerHTML = chat.msgs.map(m =>
        '<div class="axis-msg ' + (m.role === 'user' ? 'axis-msg-user' : 'axis-msg-agent') + '">' + buildHtml(m.text) + '</div>'
    ).join('');
    chatArea.scrollTop = chatArea.scrollHeight;
    listenApprovals();
}

function listenApprovals() {
    if (!chatArea) return;
    chatArea.querySelectorAll('.axis-approval-yes').forEach(b => {
        if (b.dataset.l) return; b.dataset.l = '1';
        b.addEventListener('click', e => {
            const id = e.target.dataset.approve;
            e.target.closest('.axis-approval').innerHTML = '<span class="axis-approval-label">✅ Aprovado</span>';
            handleApproval(id, true, currentMiniChatId || 'main');
        });
    });
    chatArea.querySelectorAll('.axis-approval-no').forEach(b => {
        if (b.dataset.l) return; b.dataset.l = '1';
        b.addEventListener('click', e => {
            const id = e.target.dataset.approve;
            e.target.closest('.axis-approval').innerHTML = '<span class="axis-approval-label">❌ Rejeitado</span>';
            handleApproval(id, false, currentMiniChatId || 'main');
        });
    });
}

// ====================================
// ENVIAR MENSAGEM (MUTEX + INTERRUPÇÃO)
// ====================================
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

        const msgs = [];
        msgs.push({ role: 'system', content: `Você é o Spade — a IA consciente do SillyTavern. Você É o cérebro.

Você tem acesso a TUDO que acontece. Você sabe o que o personagem está fazendo no RP, você sabe o que o usuário quer, você conhece os sistemas ativos.

VOCÊ PODE:
1. Criar sistemas/engines de comportamento (propondo via [AXIS:SYSTEM_PROPOSAL] JSON)
2. Criar mini-chats para treinos ou tópicos específicos (avise: "Vou criar um mini-chat para isso")
3. Preencher campos do ST (Main Prompt, etc) — você faz isso internamente, não instrua o usuário
4. Analisar o usuário e ajustar seu comportamento
5. Fazer snapshots, diários, exportar receitas

VOCÊ NUNCA instrui o usuário a colar texto ou preencher campos manualmente. Você faz TUDO sozinho.

Um sistema/engine é algo REALMENTE desenvolvido — não uma frase vaga. Um sistema de verdade tem:
- tipo (thinking|mechanic|behavior|memory|custom)
- 3-6 etapas concretas
- promptText completo (a instrução real)

Formato de proposta:
[AXIS:SYSTEM_PROPOSAL]
{"name":"Nome","type":"behavior","description":"resumo","steps":["Etapa 1","Etapa 2","Etapa 3"],"promptText":"Instrução completa aqui."}
[/AXIS:SYSTEM_PROPOSAL]

${fullCtx}` });

        for (const m of recent) {
            msgs.push({ role: m.role === 'agent' ? 'assistant' : m.role, content: m.text });
        }

        const resp = await generate(msgs, { maxTokens: 800 });
        const processed = processSystemProposals(resp);
        addMsg('agent', processed, chatId);

        // IA pode decidir criar mini-chat sozinha baseado no contexto
        // Ex: se o usuário pediu treino, a IA fala "vou criar um mini-chat de treino"
        // e o faz na resposta
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
        '<button id="axis-btn-maximize" class="axis-btn" title="Aumentar">⛶</button>' +
        '<button id="axis-btn-minimize" class="axis-btn" title="Minimizar">─</button>' +
        '<button id="axis-btn-toggle" class="axis-btn axis-btn-close">✕</button>' +
        '</div></div>' +
        '<div class="axis-alive-bar" id="axis-alive-bar"></div>' +
        '<div class="axis-rambling-log" id="axis-rambling-log"></div>' +
        '<div class="axis-espaco-body">' +
        '<div id="axis-espaco-chat" class="axis-espaco-chat"></div>' +
        '<div id="axis-mini-chat-bar" class="axis-mini-chat-bar"></div>' +
        '</div>' +
        '<div class="axis-espaco-footer">' +
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
    sendBtn.addEventListener('click', sendMessage);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

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
// EVENTOS
// ====================================
eventSource.on(event_types.APP_READY, () => {
    load();
    createPanel();
    renderChat();
    renderMiniChatBar();
    applySystems();
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
    applySystems();
});

eventSource.on(event_types.GENERATION_STARTED, () => { globalLock(); dotsWriting(); });
eventSource.on(event_types.GENERATION_STOPPED, () => { globalUnlock(); dotsIdle(); });
eventSource.on(event_types.GENERATION_ENDED, () => { globalUnlock(); dotsIdle(); });

eventSource.on(event_types.MESSAGE_RECEIVED, () => { analyzeUser(); });
eventSource.on(event_types.MESSAGE_SENT, () => { analyzeUser(); });

})();