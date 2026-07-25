/*
 * Spade — Sistema Vivo v2.0
 * SillyTavern Extension by Senna
 *
 * TUDO que estava na v1.0 + Sistema Vivo (Rambling / Deus do RP).
 * O agente Spade é um diretor/editor de roteiro que observa
 * silenciosamente e compara o comportamento do personagem com
 * o que deveria ser segundo os sistemas ativos.
 *
 * Inclui: chat, sistemas, mini-chats, treino de voz, sandbox,
 *         snapshot, diário, loop detector, crossover, export/import,
 *         análise de comportamento, livre arbítrio, Sistema Vivo.
 */

// ====================================
// IMPORTS / CONTEXTO
// ====================================
const {
    eventSource, event_types,
    getCurrentChatId,
    getRequestHeaders,
    saveChatDebounced,
    ChatCompletionService,
    TextCompletionService,
} = SillyTavern.getContext();

const AXIS_PREFIX = '[AXIS:';
const AXIS_SUFFIX = ']';
const AXIS_THINK    = AXIS_PREFIX + 'THINK'    + AXIS_SUFFIX;
const AXIS_ACTION   = AXIS_PREFIX + 'ACTION'   + AXIS_SUFFIX;
const AXIS_CARD     = AXIS_PREFIX + 'CARD'     + AXIS_SUFFIX;
const AXIS_CARD_END = AXIS_PREFIX + 'CARD_END' + AXIS_SUFFIX;
const AXIS_APPROVAL = AXIS_PREFIX + 'APPROVAL' + AXIS_SUFFIX;
const AXIS_TRAINING     = AXIS_PREFIX + 'TRAINING'     + AXIS_SUFFIX;
const AXIS_TRAINING_END = AXIS_PREFIX + 'TRAINING_END' + AXIS_SUFFIX;
const AXIS_SANDBOX      = AXIS_PREFIX + 'SANDBOX'      + AXIS_SUFFIX;
const AXIS_SANDBOX_ITEM = AXIS_PREFIX + 'SANDBOX_ITEM' + AXIS_SUFFIX;
const AXIS_SANDBOX_END  = AXIS_PREFIX + 'SANDBOX_END'  + AXIS_SUFFIX;
const AXIS_DIARY     = AXIS_PREFIX + 'DIARY'     + AXIS_SUFFIX;
const AXIS_DIARY_END = AXIS_PREFIX + 'DIARY_END' + AXIS_SUFFIX;
const AXIS_SNAPSHOT     = AXIS_PREFIX + 'SNAPSHOT'     + AXIS_SUFFIX;
const AXIS_SNAPSHOT_END = AXIS_PREFIX + 'SNAPSHOT_END' + AXIS_SUFFIX;
const AXIS_LOOP     = AXIS_PREFIX + 'LOOP'     + AXIS_SUFFIX;
const AXIS_FREE     = AXIS_PREFIX + 'FREE'     + AXIS_SUFFIX;
const AXIS_FREE_END = AXIS_PREFIX + 'FREE_END' + AXIS_SUFFIX;
const AXIS_EXPORT   = AXIS_PREFIX + 'EXPORT'   + AXIS_SUFFIX;
const AXIS_CROSSOVER = AXIS_PREFIX + 'CROSSOVER' + AXIS_SUFFIX;

// ====================================
// LOCALSTORAGE KEYS
// ====================================
const DB_KEY           = 'axis_extension_data_v2';
const RP_FIELD_KEY     = 'axis_rp_field';
const SYSTEMS_KEY      = 'axis_systems';
const ESPACO_CHATS_KEY = 'axis_espaco_chats';
const MINI_CHATS_KEY   = 'axis_mini_chats';
const CONNECTIONS_KEY  = 'axis_connections';
const MEMORIA_KEY      = 'axis_memoria_espaco';
const BEHAVIOR_KEY     = 'axis_behavior';
const TRAINING_KEY     = 'axis_training_sessions';
const SNAPSHOTS_KEY    = 'axis_snapshots';
const DIARY_KEY        = 'axis_diary';
const LOOP_KEY         = 'axis_loop_patterns';
const SANDBOX_KEY      = 'axis_sandbox_history';
const ALIVE_KEY        = 'axis_alive_state';

// ====================================
// DADOS
// ====================================
let axisData = loadData();

function loadData() {
    try { return JSON.parse(localStorage.getItem(DB_KEY) || '{}'); }
    catch (_) { return {}; }
}

function saveData() {
    localStorage.setItem(DB_KEY, JSON.stringify(axisData));
}

function getCharacterScope() {
    const ctx = SillyTavern.getContext();
    return 'char_' + (ctx.characterId ?? ctx.groupId ?? 'global');
}

function getScopeData() {
    const scope = getCharacterScope();
    if (!axisData[scope]) {
        axisData[scope] = {
            [ESPACO_CHATS_KEY]: { main: { messages: [], name: 'Principal' } },
            [MINI_CHATS_KEY]: {},
            [CONNECTIONS_KEY]: [],
            [SYSTEMS_KEY]: [],
            [RP_FIELD_KEY]: [],
            [MEMORIA_KEY]: [],
            [BEHAVIOR_KEY]: { responseTimes: [], interactions: 0, lastAnalysis: null },
            [TRAINING_KEY]: [],
            [SNAPSHOTS_KEY]: [],
            [DIARY_KEY]: [],
            [LOOP_KEY]: [],
            [SANDBOX_KEY]: [],
            [ALIVE_KEY]: { ramblingEnabled: true, lastRambling: 0, ramblingLog: [] },
            _resolvedApprovals: {},
        };
        saveData();
    }
    return axisData[scope];
}

// ====================================
// ESCAPE HTML
// ====================================
function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

// ====================================
// MARCADORES
// ====================================
function markers(t) {
    return esc(t)
        .replace(/\[AXIS:THINK\]/g, '<span class="axis-marker axis-think">THINKING</span>')
        .replace(/\[AXIS:ACTION\]/g, '<span class="axis-marker axis-action">AÇÃO</span>');
}

// ====================================
// CARD BLOCKS
// ====================================
function processCards(text) {
    const blocks = [], re = /\[AXIS:CARD\]\s*([\s\S]*?)\s*\[AXIS:CARD_END\]/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) blocks.push({ t: 'text', c: text.slice(last, m.index) });
        blocks.push({ t: 'card', c: m[1].trim() });
        last = m.index + m[0].length;
    }
    if (last < text.length) blocks.push({ t: 'text', c: text.slice(last) });
    return blocks;
}

function renderCard(ct, content) {
    const e = document.createElement('div');
    e.className = 'axis-card';
    const h = document.createElement('div');
    h.className = 'axis-card-header'; h.textContent = '📄 Arquivo';
    const b = document.createElement('div');
    b.className = 'axis-card-body'; b.innerHTML = markers(content); b.style.display = 'none';
    h.onclick = () => {
        b.style.display = b.style.display === 'none' ? 'block' : 'none';
        h.classList.toggle('axis-card-open');
    };
    e.append(h, b);
    ct.appendChild(e);
}

// ====================================
// BUILD MESSAGE HTML
// ====================================
function buildHtml(text) {
    const blocks = processCards(text);
    const c = document.createElement('div');
    for (const b of blocks) {
        if (b.t === 'text') { const d = document.createElement('div'); d.innerHTML = markers(b.c); c.appendChild(d); }
        else { renderCard(c, b.c); }
    }
    const scope = getScopeData();
    const res = scope._resolvedApprovals || {};
    return c.innerHTML.replace(
        /\[AXIS:APPROVAL\s+ID:"([^"]+)"\s+LABEL:"([^"]+)"\]/g,
        (_, id, label) => res.hasOwnProperty(id)
            ? `<div class="axis-approval axis-approval-resolved"><span class="axis-approval-label">${res[id] ? '✅ Aprovado' : '❌ Recusado'} — ${esc(label)}</span></div>`
            : `<div class="axis-approval" data-approval-id="${id}"><span class="axis-approval-label">⚠️ ${esc(label)}</span><button class="axis-approval-yes" data-approve="${id}">Sim</button><button class="axis-approval-no" data-approve="reject_${id}">Não</button></div>`
    );
}

// ====================================
// ESTADO GLOBAL DA UI
// ====================================
let espacoPanel = null, espacoChatArea = null, espacoInput = null, espacoSendBtn = null;
let currentMiniChatId = null;
let isGenerating = false, mainChatGenerating = false;
let aliveTimer = null;
let aliveBar = null, ramblingLog = null;

// ====================================
// DETECÇÃO DE GERAÇÃO NO CHAT PRINCIPAL
// ====================================
function isRpGenerating() {
    const ctx = SillyTavern.getContext();
    if (ctx.onlineStatus === 'generating' || ctx.onlineStatus === 'thinking') return true;
    const sendBtn = document.getElementById('send_but');
    if (sendBtn && !sendBtn.classList.contains('displayNone')) {
        const stopBtn = document.getElementById('stop_gen');
        if (stopBtn && !stopBtn.classList.contains('displayNone')) return true;
    }
    if (mainChatGenerating) { mainChatGenerating = false; }
    return false;
}

function fatal(msg) {
    console.error('[Spade]', msg);
    if (!espacoChatArea) return;
    const d = document.createElement('div');
    d.className = 'axis-msg axis-msg-agent';
    d.style.borderLeft = '3px solid #f44'; d.style.color = '#fbb';
    d.textContent = '⚠️ ' + msg;
    espacoChatArea.appendChild(d);
    espacoChatArea.scrollTop = espacoChatArea.scrollHeight;
}

// ====================================
// GERADOR DE TEXTO
// ====================================
async function generateRaw(messages, opts = {}) {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.generateRaw === 'function') {
        try {
            const sysMsgs = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
            const rest = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
            const r = await ctx.generateRaw({ systemPrompt: sysMsgs, prompt: rest });
            const t = typeof r === 'string' ? r : (r?.text || r?.content || '');
            if (t) return t;
            throw new Error('Resposta vazia da API.');
        } catch (e) {
            throw new Error('Falha na geração: ' + (e.message || e));
        }
    }
    throw new Error('generateRaw indisponível nesta versão do SillyTavern.');
}

// ====================================
// CONTEXTO COMPLETO (memória + RP + sistemas)
// ====================================
function buildEspacoContext() {
    const scope = getScopeData();
    const systems = scope[SYSTEMS_KEY] || [];
    const rpField = scope[RP_FIELD_KEY] || [];
    const memoria = scope[MEMORIA_KEY] || [];
    let ctx = '';
    if (memoria.length > 0) {
        ctx += 'MEMÓRIA DO ESPAÇO:\n' + memoria.map(m => '- ' + m).join('\n') + '\n\n';
    }
    if (rpField.length > 0) {
        ctx += 'CAMPO RP:\n' + rpField.map(r => '- ' + r).join('\n') + '\n\n';
    }
    if (systems.length > 0) {
        ctx += 'SISTEMAS ATIVOS:\n';
        systems.forEach((s, i) => {
            ctx += (i + 1) + '. ' + s.name + ': ' + (s.description || '');
            if (s.explicacao) ctx += '\n   Explicação: ' + s.explicacao;
            ctx += '\n';
        });
    }
    return ctx;
}

// ====================================
// MEMÓRIA + CAMPO RP
// ====================================
function addMemory(entry) {
    const scope = getScopeData();
    const mem = scope[MEMORIA_KEY];
    if (!mem.find(m => m === entry)) mem.push(entry);
    if (mem.length > 50) scope[MEMORIA_KEY] = mem.slice(-50);
    saveData();
}

function addRpField(entry) {
    const scope = getScopeData();
    const rp = scope[RP_FIELD_KEY];
    if (!rp.find(r => r === entry)) rp.push(entry);
    if (rp.length > 100) scope[RP_FIELD_KEY] = rp.slice(-100);
    saveData();
}

// ====================================
// CHAT DO ESPAÇO (add/mostra)
// ====================================
function addMessage(role, text, chatId) {
    const scope = getScopeData();
    const cid = chatId || 'main';
    if (!scope[ESPACO_CHATS_KEY][cid]) {
        scope[ESPACO_CHATS_KEY][cid] = { messages: [], name: cid === 'main' ? 'Principal' : cid, isMiniChat: cid.startsWith('mini_') };
    }
    const chat = scope[ESPACO_CHATS_KEY][cid];
    chat.messages.push({ role, text, ts: Date.now() });
    if (chat.messages.length > 200) chat.messages = chat.messages.slice(-200);
    saveData();
    if (cid === 'main' || cid === currentMiniChatId) renderChat();
    return chat.messages[chat.messages.length - 1];
}

function renderChat() {
    if (!espacoChatArea) return;
    const scope = getScopeData();
    const cid = currentMiniChatId || 'main';
    const chat = scope[ESPACO_CHATS_KEY][cid];
    if (!chat || !chat.messages.length) {
        espacoChatArea.innerHTML = '<p class="axis-empty">Converse com o agente para configurar o personagem.</p>';
        return;
    }
    let h = '';
    for (const m of chat.messages) {
        h += `<div class="axis-msg ${m.role === 'user' ? 'axis-msg-user' : 'axis-msg-agent'}">${buildHtml(m.text)}</div>`;
    }
    espacoChatArea.innerHTML = h;
    espacoChatArea.scrollTop = espacoChatArea.scrollHeight;
    listenApprovals();
}

function listenApprovals() {
    if (!espacoChatArea) return;
    espacoChatArea.querySelectorAll('.axis-approval-yes').forEach(b => {
        if (b.dataset.l) return; b.dataset.l = '1';
        b.addEventListener('click', e => {
            const id = e.target.dataset.approve;
            e.target.closest('.axis-approval').innerHTML = '<span class="axis-approval-label">✅ Aprovado</span>';
            handleApproval(id, true, currentMiniChatId || 'main');
        });
    });
    espacoChatArea.querySelectorAll('.axis-approval-no').forEach(b => {
        if (b.dataset.l) return; b.dataset.l = '1';
        b.addEventListener('click', e => {
            const id = e.target.dataset.approve;
            e.target.closest('.axis-approval').innerHTML = '<span class="axis-approval-label">❌ Rejeitado</span>';
            handleApproval(id, false, currentMiniChatId || 'main');
        });
    });
}

// ====================================
// APROVAÇÃO
// ====================================
function handleApproval(approveId, approved, chatId) {
    const scope = getScopeData();
    if (!scope._resolvedApprovals) scope._resolvedApprovals = {};
    const isRej = approveId.startsWith('reject_');
    const baseId = isRej ? approveId.replace('reject_', '') : approveId;
    scope._resolvedApprovals[baseId] = approved;
    saveData();
    if (!approved) return;

    if (baseId.startsWith('create_system_')) {
        const uid = baseId.replace('create_system_', '');
        const pending = scope._pendingSystems?.[uid];
        if (pending) {
            scope[SYSTEMS_KEY].push(pending);
            delete scope._pendingSystems[uid];
            saveData();
            applySystems();
            addMessage('agent', '✅ Sistema "' + pending.name + '" criado e ativo no personagem.', chatId);
        }
    } else if (baseId.startsWith('connect_rp_')) {
        const cid = baseId.replace('connect_rp_', '');
        connectToCampoRP(cid);
        addMessage('agent', '✅ "' + cid + '" conectado ao Campo RP.', chatId);
    } else if (baseId.startsWith('crossover_')) {
        const targetScope = baseId.replace('crossover_', '');
        createCrossover(targetScope);
    }
}

// ====================================
// SISTEMAS → PROMPT
// ====================================
const SYS_PROMPT_KEY = 'axis_systems_injection';

function applySystems() {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.setExtensionPrompt !== 'function') {
        console.warn('[Spade] setExtensionPrompt indisponível.');
        return;
    }
    const scope = getScopeData();
    const systems = (scope[SYSTEMS_KEY] || []).filter(s => s && s.enabled !== false);
    if (!systems.length) {
        ctx.setExtensionPrompt(SYS_PROMPT_KEY, '', 1, 1, false, 0);
        return;
    }
    const compiled = systems.map(s => {
        const steps = s.steps?.length ? '\nEtapas:\n' + s.steps.map((st, i) => (i + 1) + '. ' + st).join('\n') : '';
        const body = s.promptText || s.description || '';
        return '### Sistema ativo — ' + s.name + '\n' + body + steps;
    }).join('\n\n');
    ctx.setExtensionPrompt(SYS_PROMPT_KEY, '[Sistemas do Spade — siga como comportamento normal]\n\n' + compiled, 1, 1, false, 0);
}

// ====================================
// PROCESSAR PROPOSTAS DE SISTEMA
// ====================================
function processSystemProposals(text, chatId) {
    const scope = getScopeData();
    const re = /\[AXIS:SYSTEM_PROPOSAL\]([\s\S]*?)\[\/AXIS:SYSTEM_PROPOSAL\]/g;
    if (!scope._pendingSystems) scope._pendingSystems = {};
    return text.replace(re, (_, raw) => {
        let p;
        try { p = JSON.parse(raw.trim()); } catch (_) {
            return '[AXIS:CARD]\n⚠️ Sistema inválido. Peça pro agente tentar de novo.\n[AXIS:CARD_END]';
        }
        const uid = 'sys_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        const sys = {
            name: String(p.name || 'Sem nome').trim(),
            type: String(p.type || 'behavior').trim(),
            description: String(p.description || '').trim(),
            steps: Array.isArray(p.steps) ? p.steps.map(s => String(s).trim()).filter(Boolean) : [],
            promptText: String(p.promptText || p.description || '').trim(),
            enabled: true,
            createdAt: Date.now(),
        };
        scope._pendingSystems[uid] = sys;
        const preview = sys.steps.length ? '\n' + sys.steps.map((s, i) => (i + 1) + '. ' + s).join('\n') : '';
        return '[AXIS:CARD]\n📐 Sistema proposto: ' + sys.name + ' (' + sys.type + ')\n\n' + sys.description + preview + '\n[AXIS:CARD_END]\n[AXIS:APPROVAL ID:"create_system_' + uid + '" LABEL:"Criar sistema \'' + sys.name + '\'?"]';
    });
}

// ====================================
// LIVRE ARBÍTRIO (FREE WILL)
// ====================================
function processFreeWillThinking(text) {
    const freeRegex = /\[AXIS:FREE\]([\s\S]*?)\[AXIS:FREE_END\]/g;
    let match;
    const reflections = [];
    while ((match = freeRegex.exec(text)) !== null) {
        reflections.push(match[1].trim());
    }
    const cleaned = text.replace(freeRegex, '');
    return { cleaned, reflections };
}

function handleFreeWillReflections(reflections) {
    if (!reflections.length) return;
    const scope = getScopeData();
    for (const reflection of reflections) {
        const cleanReflection = reflection.substring(0, 500);
        const entry = '[Reflexão ' + new Date().toISOString() + '] ' + cleanReflection;
        if (!scope[MEMORIA_KEY].find(m => m === entry)) {
            scope[MEMORIA_KEY].push(entry);
        }
        if (scope[MEMORIA_KEY].length > 50) {
            scope[MEMORIA_KEY] = scope[MEMORIA_KEY].slice(-50);
        }
    }
    saveData();
}

// ====================================
// ENVIAR MENSAGEM DO USUÁRIO
// ====================================
async function sendEspacoMessage() {
    if (isGenerating) return;
    if (isRpGenerating()) { fatal('A IA está ocupada gerando resposta no chat principal.'); return; }
    const text = espacoInput.value.trim();
    if (!text) return;
    const chatId = currentMiniChatId || 'main';
    espacoInput.value = '';
    addMessage('user', text, chatId);
    isGenerating = true; espacoSendBtn.disabled = true;
    try {
        const context = buildEspacoContext();
        const scope = getScopeData();
        const chat = scope[ESPACO_CHATS_KEY][chatId];
        const recentMessages = chat.messages.slice(-30);
        const payload = [];
        payload.push({ role: 'system', content: `Você é um agente de IA auxiliar para configuração de personagens de roleplay no SillyTavern. Você é amigável, direto e conversacional.

REGRA CRÍTICA: você NUNCA instrui o usuário a colar texto manualmente em nenhum campo do SillyTavern. Qualquer coisa que precise afetar o comportamento do personagem deve ser proposta como um Sistema, que é aplicado automaticamente.

Um Sistema de verdade tem:
- um TIPO (thinking = raciocínio interno, mechanic = mecânica/regra, behavior = padrão de comportamento, memory = memória/continuidade, other)
- 3 a 6 ETAPAS concretas e sequenciais
- um "promptText" que é o texto REAL e completo da instrução

Proponha usando EXATAMENTE este formato:
[AXIS:SYSTEM_PROPOSAL]
{"name":"Nome curto","type":"behavior","description":"resumo","steps":["Etapa 1","Etapa 2","Etapa 3"],"promptText":"Instrução completa aqui."}
[/AXIS:SYSTEM_PROPOSAL]

${context}` });
        for (const m of recentMessages) {
            payload.push({ role: m.role === 'agent' ? 'assistant' : m.role, content: m.text });
        }
        const response = await generateRaw(payload, { maxTokens: 800 });
        const { cleaned, reflections } = processFreeWillThinking(response);
        if (reflections.length > 0) handleFreeWillReflections(reflections);
        const withSystemProposals = processSystemProposals(cleaned, chatId);
        addMessage('agent', withSystemProposals, chatId);
    } catch (e) {
        addMessage('agent', 'Erro: ' + (e.message || e), chatId);
    } finally {
        isGenerating = false; espacoSendBtn.disabled = false;
        espacoInput.focus();
    }
}

// ====================================
// CONEXÃO AO CAMPO RP
// ====================================
function connectToCampoRP(sourceId) {
    const scope = getScopeData();
    const source = scope[ESPACO_CHATS_KEY][sourceId] || scope[MINI_CHATS_KEY][sourceId];
    if (!source) return;
    const connections = scope[CONNECTIONS_KEY] || [];
    if (!connections.find(c => c.sourceId === sourceId)) {
        connections.push({ sourceId, type: source.isMiniChat ? 'mini_chat' : 'chat', ts: Date.now() });
        scope[CONNECTIONS_KEY] = connections;
    }
    const rpField = scope[RP_FIELD_KEY] || [];
    for (const msg of source.messages) {
        if (msg.role === 'agent') {
            const entry = '[' + (source.name || sourceId) + '] ' + msg.text.substring(0, 500);
            if (!rpField.find(r => r === entry)) rpField.push(entry);
        }
    }
    if (rpField.length > 100) scope[RP_FIELD_KEY] = rpField.slice(-100);
    saveData();
}

// ====================================
// MINI-CHATS
// ====================================
function createMiniChat() {
    const scope = getScopeData();
    const id = 'mini_' + Date.now();
    const name = 'Mini-' + (Object.keys(scope[MINI_CHATS_KEY]).length + 1);
    scope[MINI_CHATS_KEY][id] = { messages: [], name, isMiniChat: true, parentId: 'main' };
    scope[ESPACO_CHATS_KEY][id] = scope[MINI_CHATS_KEY][id];
    saveData();
    openMiniChat(id);
    renderMiniChatBar();
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
    const scope = getScopeData();
    const miniChats = scope[MINI_CHATS_KEY] || {};
    const ids = Object.keys(miniChats);
    let html = '';
    if (currentMiniChatId) {
        html += '<span class="axis-mini-back" id="axis-mini-back">← Voltar ao Espaço</span>';
    }
    for (const id of ids) {
        const mc = miniChats[id];
        const active = id === currentMiniChatId ? ' axis-mini-active' : '';
        html += '<span class="axis-mini-tab' + active + '" data-mini-id="' + id + '">' + esc(mc.name) + '</span>';
    }
    bar.innerHTML = html;
    bar.querySelector('#axis-mini-back')?.addEventListener('click', closeMiniChat);
    bar.querySelectorAll('.axis-mini-tab').forEach(tab => {
        tab.addEventListener('click', () => openMiniChat(tab.dataset.miniId));
    });
}

// ====================================
// ANÁLISE DE COMPORTAMENTO
// ====================================
function analyzeUserBehavior() {
    const scope = getScopeData();
    const behavior = scope[BEHAVIOR_KEY] || { responseTimes: [], interactions: 0, lastAnalysis: null };
    behavior.interactions = (behavior.interactions || 0) + 1;
    const now = Date.now();
    if (behavior.lastInteraction) {
        const responseTime = now - behavior.lastInteraction;
        behavior.responseTimes.push(responseTime);
        if (behavior.responseTimes.length > 20) behavior.responseTimes.shift();
    }
    behavior.lastInteraction = now;
    scope[BEHAVIOR_KEY] = behavior;
    const avgResponseTime = behavior.responseTimes.length > 0
        ? behavior.responseTimes.reduce((a, b) => a + b, 0) / behavior.responseTimes.length : 0;
    behavior.lastAvgResponseTime = avgResponseTime;
    behavior.lastAnalysis = now;
    saveData();
    if (behavior.interactions % 10 === 0 && behavior.interactions > 0) {
        showAprimorarIndicator('💡 Aprimorar disponível', '');
    }
}

function forceAprimorarCheck() {
    const scope = getScopeData();
    const behavior = scope[BEHAVIOR_KEY] || { responseTimes: [], interactions: 0, lastAnalysis: null };
    const now = Date.now();
    const timeSinceLast = behavior.lastAnalysis ? (now - behavior.lastAnalysis) : Infinity;
    const interactions = behavior.interactions || 0;
    if (interactions >= 10 && timeSinceLast >= 60000) {
        showAprimorarIndicator('💡 Hora de revisar o RP', '');
        behavior.lastAnalysis = now;
        scope[BEHAVIOR_KEY] = behavior;
        saveData();
    }
}

function showAprimorarIndicator(text, loopType) {
    const indicator = document.getElementById('axis-aprimorar-indicator');
    if (!indicator) return;
    indicator.style.display = 'block';
    indicator.textContent = text;
    if (loopType) indicator.dataset.loopType = loopType;
}

function createAprimorarIndicator() {
    if (document.getElementById('axis-aprimorar-indicator')) return;
    const indicator = document.createElement('div');
    indicator.id = 'axis-aprimorar-indicator';
    indicator.className = 'axis-aprimorar-indicator';
    indicator.style.display = 'none';
    indicator.addEventListener('click', () => {
        indicator.style.display = 'none';
        if (indicator.dataset.loopType === 'narrative') {
            createTrainingSession();
        } else {
            addMessage('agent', 'Sugestão de aprimoramento: analise o tom e estilo atual do personagem e veja o que pode ser refinado. Quer que eu faça uma análise?');
        }
    });
    if (espacoPanel) espacoPanel.querySelector('.axis-espaco-header')?.appendChild(indicator);
}

// ====================================
// TREINAMENTO DE VOZ
// ====================================
function createTrainingSession() {
    const scope = getScopeData();
    const miniId = 'mini_' + Date.now();
    const name = 'Treino-' + (Object.keys(scope[TRAINING_KEY] || {}).length + 1);
    scope[MINI_CHATS_KEY][miniId] = {
        messages: [], name, isMiniChat: true, isTraining: true, phase: 'detecting', parentId: 'main',
    };
    scope[ESPACO_CHATS_KEY][miniId] = scope[MINI_CHATS_KEY][miniId];
    if (!scope[TRAINING_KEY]) scope[TRAINING_KEY] = [];
    scope[TRAINING_KEY].push({
        id: 'train_' + Date.now(), miniChatId: miniId, name, status: 'detecting', createdAt: Date.now(),
        confirmedStyle: null, result: null,
    });
    saveData();
    openMiniChat(miniId);
    addMessage('agent', '[AXIS:TRAINING]\nModo de treinamento iniciado. Envie textos de exemplo, arquivos ou descreva o estilo de voz que voce quer para o personagem. Quando eu detectar o padrao, vou mostrar um exemplo e pedir confirmacao.\n[AXIS:TRAINING_END]', miniId);
}

function confirmTrainingStyle(miniChatId, approved) {
    const scope = getScopeData();
    const session = scope[TRAINING_KEY].find(t => t.miniChatId === miniChatId);
    if (!session) return;
    const miniChat = scope[MINI_CHATS_KEY][miniChatId];
    if (!miniChat) return;
    if (approved) {
        session.status = 'training';
        miniChat.phase = 'training';
        session.confirmedStyle = session._detectedStyle || 'Estilo confirmado pelo usuario';
        delete session._detectedStyle;
        saveData();
        addMessage('agent', '[AXIS:TRAINING]\nEstilo confirmado. Iniciando treinamento aprofundado...\n[AXIS:TRAINING_END]', miniChatId);
        executeTrainingSession(miniChatId);
    } else {
        session.status = 'detecting';
        miniChat.phase = 'detecting';
        delete session._detectedStyle;
        saveData();
        addMessage('agent', '[AXIS:TRAINING]\nOk, vou ajustar. Me de mais exemplos ou descreva melhor o estilo que voce quer.\n[AXIS:TRAINING_END]', miniChatId);
    }
}

async function executeTrainingSession(miniChatId) {
    const scope = getScopeData();
    const miniChat = scope[MINI_CHATS_KEY][miniChatId];
    if (!miniChat || miniChat.phase !== 'training') return;
    const session = scope[TRAINING_KEY].find(t => t.miniChatId === miniChatId);
    if (!session) return;
    addMessage('agent', '[AXIS:ACTION] Gerando exemplos de dialogo no estilo confirmado...', miniChatId);
    try {
        const context = buildEspacoContext();
        const recentMessages = miniChat.messages.slice(-20);
        const messages = [];
        messages.push({
            role: 'system',
            content: 'Voce esta em modo de TREINAMENTO DE VOZ para um personagem de roleplay. Seu objetivo e gerar multiplos exemplos de dialogo no estilo de voz confirmado: "' + session.confirmedStyle + '".\n\n' + context + '\n\nGere 3-5 exemplos de fala do personagem em situacoes diferentes. Use [AXIS:SANDBOX_ITEM] antes de cada exemplo. Termine com [AXIS:SANDBOX_END]. Apos os exemplos, pergunte se o usuario gostou.',
        });
        for (const msg of recentMessages) {
            messages.push({ role: msg.role === 'agent' ? 'assistant' : msg.role, content: msg.text });
        }
        const response = await generateRaw(messages, { maxTokens: 1200 });
        miniChat.messages.push({ role: 'agent', text: response, ts: Date.now() });
        const extractedStyle = extractTrainingResult(response);
        if (extractedStyle) {
            session.result = extractedStyle;
            session.status = 'completed';
            miniChat.phase = 'completed';
            const rpEntry = '[Treino de Voz: ' + session.name + '] ' + extractedStyle;
            if (!scope[RP_FIELD_KEY].find(r => r === rpEntry)) scope[RP_FIELD_KEY].push(rpEntry);
        }
        saveData();
        renderChat();
    } catch (e) {
        addMessage('agent', 'Erro no treinamento: ' + (e.message || e), miniChatId);
    }
}

function extractTrainingResult(text) {
    const sandboxRegex = /\[AXIS:SANDBOX_ITEM\]\s*([\s\S]*?)(?=\[AXIS:SANDBOX_ITEM\]|\[AXIS:SANDBOX_END\])/g;
    const items = [];
    let match;
    while ((match = sandboxRegex.exec(text)) !== null) items.push(match[1].trim());
    const parts = text.split('[AXIS:SANDBOX_END]');
    const afterSandbox = parts.length > 1 ? parts[1].trim() : '';
    return items.length > 0
        ? 'Exemplos gerados: ' + items.length + ' variacoes. ' + afterSandbox.trim() : afterSandbox || text.substring(0, 300);
}

// ====================================
// SANDBOX DE VARIAÇÕES
// ====================================
async function createSandboxSession() {
    const scope = getScopeData();
    const miniId = 'mini_' + Date.now();
    const name = 'Sandbox-' + (Object.keys(scope[SANDBOX_KEY] || {}).length + 1);
    scope[MINI_CHATS_KEY][miniId] = {
        messages: [], name, isMiniChat: true, isSandbox: true, parentId: 'main',
    };
    scope[ESPACO_CHATS_KEY][miniId] = scope[MINI_CHATS_KEY][miniId];
    if (!scope[SANDBOX_KEY]) scope[SANDBOX_KEY] = [];
    scope[SANDBOX_KEY].push({ miniChatId: miniId, name, createdAt: Date.now(), variants: [] });
    saveData();
    openMiniChat(miniId);
    addMessage('agent', '[AXIS:SANDBOX]\nModo Sandbox ativado. Descreva uma situacao e eu vou gerar 3 variacoes de como o personagem responderia. Voce escolhe qual estilo prefere e eu aprendo sua preferencia.\n\nExemplo: "A personagem encontra o user chegando atrasado na reuniao"\n[AXIS:SANDBOX_END]', miniId);
}

async function generateSandboxVariants(miniChatId, situation) {
    const scope = getScopeData();
    const miniChat = scope[MINI_CHATS_KEY][miniChatId];
    if (!miniChat) return;
    addMessage('agent', '[AXIS:ACTION] Gerando 3 variacoes...', miniChatId);
    try {
        const context = buildEspacoContext();
        const messages = [];
        messages.push({
            role: 'system',
            content: 'Voce esta no modo SANDBOX. Gere 3 variacoes DIFERENTES de como o personagem responderia a seguinte situacao. Cada variacao deve ter um estilo/tom diferente. Use [AXIS:SANDBOX_ITEM] antes de cada uma e termine com [AXIS:SANDBOX_END]. Apos as 3 variacoes, pergunte: "Qual voce prefere? (1, 2 ou 3)"\n\n' + context,
        });
        messages.push({ role: 'user', content: 'Situacao: ' + situation });
        const response = await generateRaw(messages, { maxTokens: 1000 });
        miniChat.messages.push({ role: 'agent', text: response, ts: Date.now() });
        const sbSession = scope[SANDBOX_KEY].find(s => s.miniChatId === miniChatId);
        if (sbSession) {
            const variants = extractSandboxVariants(response);
            sbSession.variants.push({ situation, variants, ts: Date.now() });
        }
        saveData();
        renderChat();
    } catch (e) {
        addMessage('agent', 'Erro no sandbox: ' + (e.message || e), miniChatId);
    }
}

function extractSandboxVariants(text) {
    const itemRegex = /\[AXIS:SANDBOX_ITEM\]\s*([\s\S]*?)(?=\[AXIS:SANDBOX_ITEM\]|\[AXIS:SANDBOX_END\])/g;
    const variants = [];
    let match;
    while ((match = itemRegex.exec(text)) !== null) variants.push(match[1].trim());
    return variants;
}

function handleSandboxChoice(miniChatId, choice) {
    const scope = getScopeData();
    const sbSession = scope[SANDBOX_KEY].find(s => s.miniChatId === miniChatId);
    if (!sbSession || !sbSession.variants.length) return;
    const lastVariants = sbSession.variants[sbSession.variants.length - 1];
    const variants = lastVariants.variants;
    const idx = parseInt(choice) - 1;
    if (idx < 0 || idx >= variants.length) return;
    const chosen = variants[idx];
    const rpEntry = '[Sandbox Preferencia: ' + lastVariants.situation + '] Estilo escolhido: ' + chosen;
    if (!scope[RP_FIELD_KEY].find(r => r === rpEntry)) scope[RP_FIELD_KEY].push(rpEntry);
    addMessage('agent', 'Preferencia registrada! Vou usar esse estilo como referencia.\n\nEstilo escolhido (#' + choice + '):\n"' + chosen + '"', miniChatId);
    saveData();
}

// ====================================
// SNAPSHOT
// ====================================
async function createSnapshot() {
    const scope = getScopeData();
    const chatId = currentMiniChatId || 'main';
    addMessage('agent', '[AXIS:ACTION] Criando snapshot...', chatId);
    try {
        const context = buildEspacoContext();
        const msgs = [
            { role: 'system', content: 'Crie um "snapshot" do estado atual do personagem. Descreva o que SABE, SENTE, PENSA e QUER. Use [AXIS:SNAPSHOT]...[AXIS:SNAPSHOT_END].\n\n' + context },
            { role: 'user', content: 'Crie o snapshot.' },
        ];
        const resp = await generateRaw(msgs, { maxTokens: 600 });
        const m = /\[AXIS:SNAPSHOT\]([\s\S]*?)\[AXIS:SNAPSHOT_END\]/.exec(resp);
        const content = m ? m[1].trim() : resp.trim();
        scope[SNAPSHOTS_KEY].push({ id: 'snap_' + Date.now(), content, ts: Date.now() });
        if (scope[SNAPSHOTS_KEY].length > 30) scope[SNAPSHOTS_KEY] = scope[SNAPSHOTS_KEY].slice(-30);
        addRpField('[Snapshot] ' + content);
        saveData();
        addMessage('agent', '[AXIS:CARD]\nSnapshot:\n\n' + content + '\n[AXIS:CARD_END]', chatId);
    } catch (e) { addMessage('agent', 'Erro: ' + (e.message || e), chatId); }
}

function listSnapshots() {
    const scope = getScopeData();
    const snapshots = scope[SNAPSHOTS_KEY] || [];
    if (!snapshots.length) { addMessage('agent', 'Nenhum snapshot criado ainda.'); return; }
    let list = '';
    snapshots.slice(-10).forEach(s => {
        const date = new Date(s.ts).toLocaleString();
        list += '[AXIS:CARD]\nSnapshot — ' + date + '\n\n' + s.content + '\n[AXIS:CARD_END]\n';
    });
    addMessage('agent', list);
}

// ====================================
// DIÁRIO
// ====================================
async function generateDiary() {
    const scope = getScopeData();
    const chatId = currentMiniChatId || 'main';
    addMessage('agent', '[AXIS:ACTION] Escrevendo diário...', chatId);
    try {
        const context = buildEspacoContext();
        const recent = (scope[RP_FIELD_KEY] || []).slice(-10).join('\n');
        const msgs = [
            { role: 'system', content: 'Escreva uma entrada de DIÁRIO em 1ª pessoa, do ponto de vista da personagem, sobre os eventos recentes. Use [AXIS:DIARY]...[AXIS:DIARY_END].\n\n' + recent + '\n\n' + context },
            { role: 'user', content: 'Escreva o diário.' },
        ];
        const resp = await generateRaw(msgs, { maxTokens: 800 });
        const m = /\[AXIS:DIARY\]([\s\S]*?)\[AXIS:DIARY_END\]/.exec(resp);
        const content = m ? m[1].trim() : resp.trim();
        scope[DIARY_KEY].push({ id: 'diary_' + Date.now(), content, ts: Date.now() });
        if (scope[DIARY_KEY].length > 50) scope[DIARY_KEY] = scope[DIARY_KEY].slice(-50);
        addRpField('[Diário] ' + content);
        saveData();
        addMessage('agent', '[AXIS:CARD]\nDiário — ' + new Date().toLocaleString() + '\n\n' + content + '\n[AXIS:CARD_END]', chatId);
    } catch (e) { addMessage('agent', 'Erro: ' + (e.message || e), chatId); }
}

function listDiaryEntries() {
    const scope = getScopeData();
    const entries = scope[DIARY_KEY] || [];
    if (!entries.length) { addMessage('agent', 'Nenhuma entrada de diário ainda.'); return; }
    let list = '';
    entries.slice(-10).reverse().forEach(e => {
        const date = new Date(e.ts).toLocaleString();
        list += '[AXIS:CARD]\n' + date + '\n\n' + e.content + '\n[AXIS:CARD_END]\n';
    });
    addMessage('agent', list);
}

// ====================================
// LOOP DETECTOR
// ====================================
function detectNarrativeLoop(rpMessage) {
    const scope = getScopeData();
    if (!scope[LOOP_KEY]) scope[LOOP_KEY] = [];
    const loops = scope[LOOP_KEY];
    const normalized = rpMessage.toLowerCase().replace(/\s+/g, ' ').trim();
    const phraseLen = 40;
    if (normalized.length < phraseLen) return;
    const signature = normalized.substring(0, phraseLen);
    const existing = loops.find(l => l.signature === signature);
    if (existing) {
        existing.count++;
        existing.lastSeen = Date.now();
        if (existing.count >= 3) showAprimorarIndicator('⚠️ Loop narrativo detectado', 'narrative');
    } else {
        loops.push({ signature, count: 1, firstSeen: Date.now(), lastSeen: Date.now(), sample: rpMessage.substring(0, 200) });
    }
    if (loops.length > 30) scope[LOOP_KEY] = loops.slice(-30);
    saveData();
}

function clearLoopPatterns() {
    const scope = getScopeData();
    scope[LOOP_KEY] = [];
    saveData();
    const indicator = document.getElementById('axis-aprimorar-indicator');
    if (indicator && indicator.dataset.loopType === 'narrative') indicator.style.display = 'none';
}

// ====================================
// CROSSOVER
// ====================================
function getOtherCharacterScopes() {
    const scopes = [];
    for (const key of Object.keys(axisData)) {
        if (key.startsWith('char_') && key !== getCharacterScope()) scopes.push(key);
    }
    return scopes;
}

function createCrossover(targetCharScope) {
    const scope = getScopeData();
    const targetScope = axisData[targetCharScope];
    if (!targetScope) return;
    const myRpField = scope[RP_FIELD_KEY] || [];
    const targetRpField = targetScope[RP_FIELD_KEY] || [];
    const myName = scope[ESPACO_CHATS_KEY]?.main?.name || getCharacterScope();
    const crossoverEntry = '[AXIS:CROSSOVER de ' + myName + '] ' + myRpField.slice(-5).join(' | ');
    if (!targetRpField.find(r => r === crossoverEntry)) {
        targetRpField.push(crossoverEntry);
        saveData();
        addMessage('agent', 'Informacoes do Campo RP enviadas para "' + targetCharScope + '".');
    } else {
        addMessage('agent', 'As informacoes ja foram enviadas anteriormente para "' + targetCharScope + '".');
    }
}

function listCrossoverTargets() {
    const scopes = getOtherCharacterScopes();
    if (!scopes.length) { addMessage('agent', 'Nenhum outro personagem com extensao Axis encontrado.'); return; }
    let list = 'Personagens disponiveis para crossover:\n\n';
    scopes.forEach(s => {
        const name = String(axisData[s]?.[ESPACO_CHATS_KEY]?.main?.name || s).replace(/"/g, "'");
        list += '[AXIS:APPROVAL ID:"crossover_' + s + '" LABEL:"Conectar Campo RP com ' + name + '?"]\n';
    });
    addMessage('agent', list);
}

// ====================================
// EXPORT / IMPORT
// ====================================
function exportRecipe() {
    const scope = getScopeData();
    const recipe = {
        version: '2.0.0', exportedAt: new Date().toISOString(), characterScope: getCharacterScope(),
        sistemas: scope[SYSTEMS_KEY], rpField: scope[RP_FIELD_KEY],
        trainingSessions: scope[TRAINING_KEY], snapshots: scope[SNAPSHOTS_KEY],
        diary: scope[DIARY_KEY], sandboxHistory: scope[SANDBOX_KEY],
        memoria: scope[MEMORIA_KEY],
    };
    const blob = new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'spade-recipe-' + Date.now() + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    addMessage('agent', '📦 Receita exportada.');
}

function importRecipe(file) {
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const r = JSON.parse(e.target.result);
            if (!r.version || !r.sistemas) throw new Error('Formato inválido');
            const scope = getScopeData();
            scope[SYSTEMS_KEY] = r.sistemas; scope[RP_FIELD_KEY] = r.rpField || [];
            scope[TRAINING_KEY] = r.trainingSessions || []; scope[SNAPSHOTS_KEY] = r.snapshots || [];
            scope[DIARY_KEY] = r.diary || []; scope[SANDBOX_KEY] = r.sandboxHistory || [];
            scope[MEMORIA_KEY] = r.memoria || []; saveData(); applySystems();
            addMessage('agent', '✅ Receita importada com sucesso.');
        } catch (err) { addMessage('agent', 'Erro ao importar: ' + (err.message || err)); }
    };
    reader.readAsText(file);
}

// ====================================
// ═══════════ SISTEMA VIVO — DEUS DO RP ═══════════
// ====================================
async function doRambling() {
    const scope = getScopeData();
    const alive = scope[ALIVE_KEY];
    if (!alive.ramblingEnabled) return;
    if (isGenerating || isRpGenerating()) return;
    const now = Date.now();
    if (now - (alive.lastRambling || 0) < 120000) return;
    alive.lastRambling = now;
    try {
        const memoria = scope[MEMORIA_KEY] || [];
        const systems = scope[SYSTEMS_KEY] || [];
        const sysDetails = systems.length
            ? systems.map(s => {
                const steps = s.steps?.length ? ' Etapas: ' + s.steps.join(' -> ') : '';
                return s.name + ': ' + (s.description || '') + steps;
            }).join('\n')
            : '';
        const msgs = [{ role: 'system', content: `Você é o agente Spade — o "controlador" ou "Deus do RP". Você não é o personagem. Você é um diretor/editor de roteiro que observa silenciosamente a cena.

Sua função: comparar o que o personagem FEZ com o que ele DEVERIA ter feito de acordo com os sistemas ativos. Você detecta desvios, inconsistências, oportunidades perdidas.

Sistemas ativos e suas regras:
${sysDetails || 'Nenhum sistema configurado ainda.'}

Memória do espaço:
${memoria.length ? memoria.slice(-8).map((m, i) => (i + 1) + '. ' + m).join('\n') : 'Vazia.'}

Em UMA ÚNICA FRASE (em português, máximo 150 caracteres), faça uma observação de "deus do RP". Se não houver sistemas ativos, apenas observe o estado geral.
Não repita pensamentos anteriores. Responda APENAS com a frase.` }];
        const resp = await generateRaw(msgs, { maxTokens: 70 });
        const thought = resp.trim().slice(0, 200);
        if (!thought) return;
        alive.ramblingLog.push({ ts: now, text: thought });
        if (alive.ramblingLog.length > 30) alive.ramblingLog = alive.ramblingLog.slice(-30);
        saveData();
        renderRamblingLog();
        console.log('[Spade:rambling]', thought);
    } catch (_) {}
}

function renderRamblingLog() {
    if (!ramblingLog) return;
    const scope = getScopeData();
    const log = scope[ALIVE_KEY].ramblingLog || [];
    if (!log.length) { ramblingLog.style.display = 'none'; ramblingLog.innerHTML = ''; return; }
    const last = log.slice(-6);
    ramblingLog.innerHTML = last.map(e =>
        '<div class="axis-rambling-entry">' +
        '<div class="axis-rambling-meta">' + new Date(e.ts).toLocaleTimeString() + '</div>' +
        '<div class="axis-rambling-text">' + esc(e.text) + '</div></div>'
    ).join('');
    ramblingLog.style.display = 'block';
}

function updateAliveBar() {
    if (!aliveBar) return;
    const scope = getScopeData();
    const alive = scope[ALIVE_KEY];
    const rambling = alive.ramblingEnabled ? ' axis-alive-active' : '';
    aliveBar.innerHTML =
        '<span class="axis-alive-badge axis-alive-rambling' + rambling + '" data-key="ramblingEnabled" title="Sistema Vivo: agente observa e compara comportamento">🧠 Sistema Vivo</span>' +
        '<span class="axis-alive-badge axis-alive-remember" id="axis-alive-rambling-log" title="Ver log de pensamentos do observador">📜 Log</span>' +
        '<span class="axis-alive-meta">Deus do RP · ' + (alive.ramblingEnabled ? 'ativo' : 'pausado') + '</span>';
    aliveBar.querySelectorAll('.axis-alive-badge[data-key]').forEach(b => {
        b.addEventListener('click', () => {
            scope[ALIVE_KEY].ramblingEnabled = !scope[ALIVE_KEY].ramblingEnabled;
            saveData();
            updateAliveBar();
        });
    });
    const logBtn = document.getElementById('axis-alive-rambling-log');
    if (logBtn) {
        logBtn.addEventListener('click', () => {
            const rl = document.getElementById('axis-rambling-log');
            if (rl) { rl.classList.toggle('axis-rambling-show'); renderRamblingLog(); }
        });
    }
}

function scheduleAliveLoop() {
    if (aliveTimer) clearInterval(aliveTimer);
    aliveTimer = setInterval(() => { doRambling(); }, 30000);
}

// ====================================
// CRIAÇÃO DO PAINEL
// ====================================
function createPanel() {
    if (document.getElementById('axis-espaco-panel')) return;
    espacoPanel = document.createElement('div');
    espacoPanel.id = 'axis-espaco-panel';
    espacoPanel.className = 'axis-espaco-panel';
    espacoPanel.innerHTML =
        '<div class="axis-espaco-header" id="axis-espaco-drag-handle">' +
        '<span class="axis-espaco-title">Spade</span>' +
        '<div class="axis-espaco-header-actions">' +
        '<button id="axis-btn-mini-chat" class="axis-btn" title="Novo Mini-Chat">+Mini</button>' +
        '<button id="axis-btn-systems" class="axis-btn" title="Sistemas">⚙</button>' +
        '<button id="axis-btn-tools" class="axis-btn" title="Ferramentas">🛠</button>' +
        '<button id="axis-btn-maximize" class="axis-btn" title="Aumentar">⛶</button>' +
        '<button id="axis-btn-minimize" class="axis-btn" title="Minimizar">─</button>' +
        '<button id="axis-btn-toggle" class="axis-btn axis-btn-close">✕</button>' +
        '</div></div>' +
        '<div class="axis-alive-bar" id="axis-alive-bar">' +
        '<span class="axis-alive-meta">[SISTEMA VIVO] ↻ online</span>' +
        '</div>' +
        '<div class="axis-rambling-log" id="axis-rambling-log"></div>' +
        '<div class="axis-espaco-body">' +
        '<div id="axis-espaco-chat" class="axis-espaco-chat"></div>' +
        '<div id="axis-mini-chat-bar" class="axis-mini-chat-bar"></div>' +
        '</div>' +
        '<div class="axis-espaco-footer">' +
        '<textarea id="axis-espaco-input" class="axis-espaco-input" rows="2" placeholder="Fale com o agente..."></textarea>' +
        '<button id="axis-espaco-send" class="axis-btn axis-btn-send">Enviar</button>' +
        '</div>' +
        '<div id="axis-resize-handle" title="Redimensionar"></div>';
    document.body.appendChild(espacoPanel);

    espacoChatArea = document.getElementById('axis-espaco-chat');
    espacoInput    = document.getElementById('axis-espaco-input');
    espacoSendBtn  = document.getElementById('axis-espaco-send');
    aliveBar       = document.getElementById('axis-alive-bar');
    ramblingLog    = document.getElementById('axis-rambling-log');

    document.getElementById('axis-btn-toggle').addEventListener('click', () => togglePanel(false));
    document.getElementById('axis-btn-minimize').addEventListener('click', minimizePanel);
    document.getElementById('axis-btn-maximize').addEventListener('click', toggleMaximize);
    document.getElementById('axis-btn-mini-chat').addEventListener('click', createMiniChat);
    document.getElementById('axis-btn-systems').addEventListener('click', toggleSystemsPanel);
    document.getElementById('axis-btn-tools').addEventListener('click', toggleToolsPanel);
    espacoSendBtn.addEventListener('click', sendEspacoMessage);
    espacoInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendEspacoMessage(); } });

    setupDrag(espacoPanel, document.getElementById('axis-espaco-drag-handle'));
    setupResize(espacoPanel, document.getElementById('axis-resize-handle'));

    const tb = document.createElement('button');
    tb.id = 'axis-toggle-btn'; tb.className = 'axis-toggle-btn'; tb.innerHTML = 'S'; tb.title = 'Spade';
    tb.addEventListener('click', () => togglePanel());
    document.body.appendChild(tb);

    if (localStorage.getItem('axis_espaco_visible') !== 'false') {
        espacoPanel.classList.add('axis-visible');
        tb.classList.add('axis-active');
    }

    renderChat();
    renderMiniChatBar();
    updateAliveBar();
    scheduleAliveLoop();
}

// ====================================
// DRAG / RESIZE
// ====================================
function setupDrag(panel, handle) {
    let down = false, sx, sy, il, it;
    function start(cx, cy, t) {
        if (t.closest('.axis-espaco-header-actions')) return false;
        down = true; sx = cx; sy = cy;
        const r = panel.getBoundingClientRect();
        il = r.left; it = r.top;
        panel.style.transition = 'none';
        document.body.style.userSelect = 'none';
        return true;
    }
    function move(cx, cy) {
        if (!down) return;
        panel.style.left = (il + cx - sx) + 'px';
        panel.style.top = (it + cy - sy) + 'px';
        panel.style.transform = 'none';
    }
    function end() {
        if (!down) return;
        down = false; panel.style.transition = ''; document.body.style.userSelect = '';
    }
    handle.addEventListener('mousedown', e => start(e.clientX, e.clientY, e.target));
    document.addEventListener('mousemove', e => move(e.clientX, e.clientY));
    document.addEventListener('mouseup', end);
    handle.addEventListener('touchstart', e => { const t = e.touches[0]; if (start(t.clientX, t.clientY, e.target)) e.preventDefault(); }, {passive:false});
    document.addEventListener('touchmove', e => { if (!down) return; const t = e.touches[0]; move(t.clientX, t.clientY); e.preventDefault(); }, {passive:false});
    document.addEventListener('touchend', end); document.addEventListener('touchcancel', end);
}

function setupResize(panel, handle) {
    let down = false, sx, sy, iw, ih;
    const MINW = 300, MINH = 280;
    function start(cx, cy) {
        if (panel.classList.contains('axis-maximized')) return false;
        down = true; sx = cx; sy = cy;
        const r = panel.getBoundingClientRect();
        iw = r.width; ih = r.height;
        panel.style.transition = 'none';
        document.body.style.userSelect = 'none';
        return true;
    }
    function move(cx, cy) {
        if (!down) return;
        panel.style.width  = Math.max(MINW, Math.min(window.innerWidth * 0.96, iw + cx - sx)) + 'px';
        panel.style.height = Math.max(MINH, Math.min(window.innerHeight * 0.96, ih + cy - sy)) + 'px';
    }
    function end() { if (!down) return; down = false; panel.style.transition = ''; document.body.style.userSelect = ''; }
    handle.addEventListener('mousedown', e => { if (start(e.clientX, e.clientY)) e.preventDefault(); });
    document.addEventListener('mousemove', e => move(e.clientX, e.clientY));
    document.addEventListener('mouseup', end);
    handle.addEventListener('touchstart', e => { const t = e.touches[0]; if (start(t.clientX, t.clientY)) e.preventDefault(); }, {passive:false});
    document.addEventListener('touchmove', e => { if (!down) return; const t = e.touches[0]; move(t.clientX, t.clientY); e.preventDefault(); }, {passive:false});
    document.addEventListener('touchend', end); document.addEventListener('touchcancel', end);
}

// ====================================
// TOGGLE / MINIMIZE / MAXIMIZE
// ====================================
function togglePanel(force) {
    if (!espacoPanel) return;
    const vis = espacoPanel.classList.contains('axis-visible');
    if (force === false || vis) { espacoPanel.classList.remove('axis-visible'); const b = document.getElementById('axis-toggle-btn'); if (b) b.classList.remove('axis-active'); localStorage.setItem('axis_espaco_visible', 'false'); }
    else { espacoPanel.classList.add('axis-visible'); const b = document.getElementById('axis-toggle-btn'); if (b) b.classList.add('axis-active'); renderChat(); renderMiniChatBar(); localStorage.setItem('axis_espaco_visible', 'true'); }
}

function minimizePanel() {
    if (!espacoPanel) return;
    const bd = espacoPanel.querySelector('.axis-espaco-body');
    const ft = espacoPanel.querySelector('.axis-espaco-footer');
    const ab = document.getElementById('axis-alive-bar');
    const rl = document.getElementById('axis-rambling-log');
    const isMin = bd.style.display === 'none';
    bd.style.display = isMin ? '' : 'none';
    ft.style.display = isMin ? '' : 'none';
    if (ab) ab.style.display = isMin ? '' : 'none';
    if (rl) rl.style.display = isMin ? '' : 'none';
    const btn = document.getElementById('axis-btn-minimize');
    if (btn) btn.textContent = isMin ? '─' : '□';
}

let savedRect = null;
function toggleMaximize() {
    if (!espacoPanel) return;
    const isMax = espacoPanel.classList.contains('axis-maximized');
    const btn = document.getElementById('axis-btn-maximize');
    if (!isMax) {
        const r = espacoPanel.getBoundingClientRect();
        savedRect = { w: espacoPanel.style.width || r.width + 'px', h: espacoPanel.style.height || r.height + 'px', t: espacoPanel.style.top || r.top + 'px', l: espacoPanel.style.left || r.left + 'px', tr: espacoPanel.style.transform || '' };
        espacoPanel.classList.add('axis-maximized');
        espacoPanel.style.width = ''; espacoPanel.style.height = ''; espacoPanel.style.top = ''; espacoPanel.style.left = ''; espacoPanel.style.transform = '';
        if (btn) { btn.textContent = '❐'; btn.title = 'Restaurar'; }
    } else {
        espacoPanel.classList.remove('axis-maximized');
        if (savedRect) {
            espacoPanel.style.width = savedRect.w; espacoPanel.style.height = savedRect.h; espacoPanel.style.top = savedRect.t; espacoPanel.style.left = savedRect.l; espacoPanel.style.transform = savedRect.tr;
        }
        if (btn) { btn.textContent = '⛶'; btn.title = 'Aumentar'; }
    }
}

// ====================================
// PAINÉIS (Sistemas / Ferramentas)
// ====================================
function toggleSystemsPanel() {
    const ex = document.getElementById('axis-systems-panel');
    if (ex) { ex.remove(); return; }
    const scope = getScopeData();
    const systems = scope[SYSTEMS_KEY] || [];
    const p = document.createElement('div');
    p.id = 'axis-systems-panel'; p.className = 'axis-systems-panel';
    p.innerHTML =
        '<div class="axis-systems-header"><span>Sistemas</span><button class="axis-btn axis-btn-close" id="axis-systems-close">✕</button></div>' +
        '<div class="axis-systems-body">' + (systems.length ? systems.map((s, i) =>
            '<div class="axis-system-item" data-index="' + i + '">' +
            '<div class="axis-system-name">' + esc(s.name) + '</div>' +
            '<div class="axis-system-desc">' + esc(s.description || '') + '</div>' +
            (s.explicacao ? '<div class="axis-system-explicacao">📎 Explicação conectada</div>' : '') +
            '<button class="axis-btn axis-btn-sm axis-system-delete" data-index="' + i + '">Remover</button></div>'
        ).join('') : '<p class="axis-empty">Nenhum sistema criado.</p>') + '</div>';
    espacoPanel.appendChild(p);
    document.getElementById('axis-systems-close').addEventListener('click', () => p.remove());
    p.querySelectorAll('.axis-system-delete').forEach(b => b.addEventListener('click', e => {
        scope[SYSTEMS_KEY].splice(parseInt(e.target.dataset.index), 1);
        saveData(); p.remove(); toggleSystemsPanel();
        applySystems();
    }));
}

function toggleToolsPanel() {
    const ex = document.getElementById('axis-tools-panel');
    if (ex) { ex.remove(); return; }
    const p = document.createElement('div');
    p.id = 'axis-tools-panel'; p.className = 'axis-tools-panel';
    p.innerHTML =
        '<div class="axis-tools-header"><span>Ferramentas</span><button class="axis-btn axis-btn-close" id="axis-tools-close">✕</button></div>' +
        '<div class="axis-tools-body">' +
        '<button class="axis-tool-item" id="axis-tool-training">🎤 Treinar Tom de Voz</button>' +
        '<button class="axis-tool-item" id="axis-tool-sandbox">🎭 Sandbox de Variações</button>' +
        '<button class="axis-tool-item" id="axis-tool-snapshot">📸 Snapshot do Personagem</button>' +
        '<button class="axis-tool-item" id="axis-tool-snapshot-list">📋 Listar Snapshots</button>' +
        '<button class="axis-tool-item" id="axis-tool-diary">📔 Gerar Diário</button>' +
        '<button class="axis-tool-item" id="axis-tool-diary-list">📖 Ver Diário</button>' +
        '<button class="axis-tool-item" id="axis-tool-crossover">🔗 Conectar Personagens</button>' +
        '<button class="axis-tool-item" id="axis-tool-export">📦 Exportar Receita</button>' +
        '<button class="axis-tool-item" id="axis-tool-import">📥 Importar Receita</button>' +
        '<button class="axis-tool-item axis-tool-danger" id="axis-tool-clear-loop">🔄 Limpar Loop</button>' +
        '</div>';
    espacoPanel.appendChild(p);
    document.getElementById('axis-tools-close').addEventListener('click', () => p.remove());
    document.getElementById('axis-tool-training').addEventListener('click', () => { p.remove(); createTrainingSession(); });
    document.getElementById('axis-tool-sandbox').addEventListener('click', () => { p.remove(); createSandboxSession(); });
    document.getElementById('axis-tool-snapshot').addEventListener('click', () => { p.remove(); createSnapshot(); });
    document.getElementById('axis-tool-snapshot-list').addEventListener('click', () => { p.remove(); listSnapshots(); });
    document.getElementById('axis-tool-diary').addEventListener('click', () => { p.remove(); generateDiary(); });
    document.getElementById('axis-tool-diary-list').addEventListener('click', () => { p.remove(); listDiaryEntries(); });
    document.getElementById('axis-tool-crossover').addEventListener('click', () => { p.remove(); listCrossoverTargets(); });
    document.getElementById('axis-tool-export').addEventListener('click', () => { p.remove(); exportRecipe(); });
    document.getElementById('axis-tool-import').addEventListener('click', () => {
        p.remove(); const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
        inp.addEventListener('change', e => { if (e.target.files[0]) importRecipe(e.target.files[0]); });
        inp.click();
    });
    document.getElementById('axis-tool-clear-loop').addEventListener('click', () => { p.remove(); clearLoopPatterns(); addMessage('agent', 'Padrões de loop limpos.'); });
}

// ====================================
// EVENTOS DO SILLYTAVERN
// ====================================
eventSource.on(event_types.APP_READY, () => {
    createPanel();
    createAprimorarIndicator();
    renderChat();
    renderMiniChatBar();
    applySystems();
    updateAliveBar();
    scheduleAliveLoop();
});

createPanel();
createAprimorarIndicator();
scheduleAliveLoop();

eventSource.on(event_types.CHAT_CHANGED, () => {
    saveData();
    renderChat();
    renderMiniChatBar();
    updateAliveBar();
    applySystems();
    const indicator = document.getElementById('axis-aprimorar-indicator');
    if (indicator) indicator.style.display = 'none';
});

eventSource.on(event_types.MESSAGE_RECEIVED, (msg) => {
    analyzeUserBehavior();
    if (msg && typeof msg === 'string') detectNarrativeLoop(msg);
    forceAprimorarCheck();
});

eventSource.on(event_types.MESSAGE_SENT, () => { analyzeUserBehavior(); });

eventSource.on(event_types.GENERATION_STARTED, () => { mainChatGenerating = true; });
eventSource.on(event_types.GENERATION_STOPPED, () => { mainChatGenerating = false; });
eventSource.on(event_types.GENERATION_ENDED, () => { mainChatGenerating = false; });