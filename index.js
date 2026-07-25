/*
 * Spade — Sistema Vivo v2.0
 * SillyTavern Extension by Senna
 *
 * ARQUITETURA do Sistema Vivo — RAMBLING (Deus do RP).
 * O agente Spade é um diretor/editor de roteiro que observa
 * silenciosamente e compara o comportamento do personagem com
 * o que deveria ser segundo os sistemas ativos.
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
const AXIS_FREE     = AXIS_PREFIX + 'FREE'     + AXIS_SUFFIX;
const AXIS_FREE_END = AXIS_PREFIX + 'FREE_END' + AXIS_SUFFIX;
const AXIS_RAMBLE   = AXIS_PREFIX + 'RAMBLE'   + AXIS_SUFFIX;

// ====================================
// LOCALSTORAGE KEYS
// ====================================
const DB_KEY            = 'axis_extension_data_v2';
const RP_FIELD_KEY      = 'axis_rp_field';
const SYSTEMS_KEY       = 'axis_systems';
const ESPACO_CHATS_KEY  = 'axis_espaco_chats';
const MEMORIA_KEY       = 'axis_memoria_espaco';
const TRAINING_KEY      = 'axis_training_sessions';
const SNAPSHOTS_KEY     = 'axis_snapshots';
const DIARY_KEY         = 'axis_diary';
const LOOP_KEY          = 'axis_loop_patterns';
const SANDBOX_KEY       = 'axis_sandbox_history';
const ALIVE_KEY         = 'axis_alive_state';      // estado do sistema vivo

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
            [SYSTEMS_KEY]: [],
            [RP_FIELD_KEY]: [],
            [MEMORIA_KEY]: [],
            [TRAINING_KEY]: [],
            [SNAPSHOTS_KEY]: [],
            [DIARY_KEY]: [],
            [LOOP_KEY]: [],
            [SANDBOX_KEY]: [],
            [ALIVE_KEY]: {
aliveEnabled: true,
ramblingEnabled: true,
lastRambling: 0,
ramblingLog: [],
            },
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
function addMessage(role, text) {
    const scope = getScopeData();
    const chat = scope[ESPACO_CHATS_KEY].main;
    chat.messages.push({ role, text, ts: Date.now() });
    if (chat.messages.length > 200) chat.messages = chat.messages.slice(-200);
    saveData();
    renderChat();
}

function renderChat() {
    if (!espacoChatArea) return;
    const scope = getScopeData();
    const msgs = scope[ESPACO_CHATS_KEY].main.messages;
    if (!msgs.length) {
        espacoChatArea.innerHTML = '<p class="axis-empty">Converse com o agente para configurar o personagem.</p>';
        return;
    }
    let h = '';
    for (const m of msgs) {
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
            handleApproval(id, true);
        });
    });
    espacoChatArea.querySelectorAll('.axis-approval-no').forEach(b => {
        if (b.dataset.l) return; b.dataset.l = '1';
        b.addEventListener('click', e => {
            const id = e.target.dataset.approve;
            e.target.closest('.axis-approval').innerHTML = '<span class="axis-approval-label">❌ Rejeitado</span>';
            handleApproval(id, false);
        });
    });
}

// ====================================
// APROVAÇÃO
// ====================================
function handleApproval(approveId, approved) {
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
            addMessage('agent', '✅ Sistema "' + pending.name + '" criado e ativo no personagem.');
        }
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
function processSystemProposals(text) {
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
// ENVIAR MENSAGEM DO USUÁRIO
// ====================================
async function sendMessage() {
    if (isGenerating) return;
    if (isRpGenerating()) { fatal('A IA está ocupada gerando resposta no chat principal.'); return; }
    const text = espacoInput.value.trim();
    if (!text) return;
    espacoInput.value = '';
    addMessage('user', text);
    isGenerating = true; espacoSendBtn.disabled = true;
    try {
        const scope = getScopeData();
        const systems = scope[SYSTEMS_KEY] || [];
        const memoria = scope[MEMORIA_KEY] || [];
        let ctx = '';
        if (memoria.length) ctx += 'MEMÓRIA:\n' + memoria.map(m => '- ' + m).join('\n') + '\n\n';
        if (systems.length) {
            ctx += 'SISTEMAS ATIVOS:\n' + systems.map((s, i) => (i + 1) + '. ' + s.name + ': ' + (s.description || '')).join('\n') + '\n\n';
        }
        const msgs = scope[ESPACO_CHATS_KEY].main.messages.slice(-30);
        const payload = [];
        payload.push({ role: 'system', content: `Você é um agente auxiliar para configuração de personagens de roleplay no SillyTavern. Amigável, direto, conversacional.

Você NUNCA instrui o usuário a colar texto manualmente. Todo comportamento deve ser proposto como um Sistema, que é aplicado automaticamente.

Um Sistema tem: tipo (thinking|mechanic|behavior|memory|other), 3-6 etapas concretas, e um promptText (a instrução real e completa).

Proponha EXATAMENTE assim (JSON dentro das tags):
[AXIS:SYSTEM_PROPOSAL]
{"name":"Nome","type":"behavior","description":"resumo","steps":["Etapa 1","Etapa 2"],"promptText":"Instrução completa aqui."}
[/AXIS:SYSTEM_PROPOSAL]

${ctx}` });
        for (const m of msgs) payload.push({ role: m.role === 'agent' ? 'assistant' : m.role, content: m.text });
        const response = await generateRaw(payload, { maxTokens: 800 });
        const processed = processSystemProposals(response);
        addMessage('agent', processed);
    } catch (e) {
        addMessage('agent', 'Erro: ' + (e.message || e));
    } finally {
        isGenerating = false; espacoSendBtn.disabled = false;
        espacoInput.focus();
    }
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
    document.getElementById('axis-btn-systems').addEventListener('click', toggleSystemsPanel);
    document.getElementById('axis-btn-tools').addEventListener('click', toggleToolsPanel);
    espacoSendBtn.addEventListener('click', sendMessage);
    espacoInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

    setupDrag(espacoPanel, document.getElementById('axis-espaco-drag-handle'));
    setupResize(espacoPanel, document.getElementById('axis-resize-handle'));

    // botão flutuante
    const tb = document.createElement('button');
    tb.id = 'axis-toggle-btn'; tb.className = 'axis-toggle-btn'; tb.innerHTML = 'S'; tb.title = 'Spade';
    tb.addEventListener('click', () => togglePanel());
    document.body.appendChild(tb);

    if (localStorage.getItem('axis_espaco_visible') !== 'false') {
        espacoPanel.classList.add('axis-visible');
        tb.classList.add('axis-active');
    }

    renderChat();
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
    else { espacoPanel.classList.add('axis-visible'); const b = document.getElementById('axis-toggle-btn'); if (b) b.classList.add('axis-active'); renderChat(); localStorage.setItem('axis_espaco_visible', 'true'); }
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
        '<button class="axis-tool-item" id="axis-tool-snapshot">📸 Snapshot do Personagem</button>' +
        '<button class="axis-tool-item" id="axis-tool-diary">📔 Gerar Diário</button>' +
        '<button class="axis-tool-item" id="axis-tool-export">📦 Exportar Receita</button>' +
        '<button class="axis-tool-item" id="axis-tool-import">📥 Importar Receita</button>' +
        '<button class="axis-tool-item axis-tool-danger" id="axis-tool-clear-loop">🔄 Limpar Loop</button>' +
        '</div>';
    espacoPanel.appendChild(p);
    document.getElementById('axis-tools-close').addEventListener('click', () => p.remove());
    document.getElementById('axis-tool-snapshot').addEventListener('click', () => { p.remove(); createSnapshot(); });
    document.getElementById('axis-tool-diary').addEventListener('click', () => { p.remove(); generateDiary(); });
    document.getElementById('axis-tool-export').addEventListener('click', () => { p.remove(); exportRecipe(); });
    document.getElementById('axis-tool-import').addEventListener('click', () => {
        p.remove(); const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
        inp.addEventListener('change', e => { if (e.target.files[0]) importRecipe(e.target.files[0]); });
        inp.click();
    });
    document.getElementById('axis-tool-clear-loop').addEventListener('click', () => { p.remove(); clearLoop(); addMessage('agent', 'Padrões de loop limpos.'); });
}

// ====================================
// SNAPSHOT / DIÁRIO / EXPORT / IMPORT
// ====================================
async function createSnapshot() {
    const scope = getScopeData();
    addMessage('agent', '[AXIS:ACTION] Criando snapshot...');
    try {
        const msgs = [{ role: 'system', content: 'Crie um snapshot do estado atual do personagem. Descreva o que SABE, SENTE, PENSA e QUER. Use [AXIS:SNAPSHOT]...[AXIS:SNAPSHOT_END].' }, { role: 'user', content: 'Crie o snapshot.' }];
        const resp = await generateRaw(msgs, { maxTokens: 600 });
        const m = /\[AXIS:SNAPSHOT\]([\s\S]*?)\[AXIS:SNAPSHOT_END\]/.exec(resp);
        const content = m ? m[1].trim() : resp.trim();
        scope[SNAPSHOTS_KEY].push({ id: 'snap_' + Date.now(), content, ts: Date.now() });
        if (scope[SNAPSHOTS_KEY].length > 30) scope[SNAPSHOTS_KEY] = scope[SNAPSHOTS_KEY].slice(-30);
        addRpField('[Snapshot] ' + content);
        saveData();
        addMessage('agent', '[AXIS:CARD]\nSnapshot:\n\n' + content + '\n[AXIS:CARD_END]');
    } catch (e) { addMessage('agent', 'Erro: ' + (e.message || e)); }
}

async function generateDiary() {
    const scope = getScopeData();
    addMessage('agent', '[AXIS:ACTION] Escrevendo diário...');
    try {
        const recent = (scope[RP_FIELD_KEY] || []).slice(-10).join('\n');
        const msgs = [{ role: 'system', content: 'Escreva uma entrada de DIÁRIO em 1ª pessoa, do ponto de vista da personagem, sobre os eventos recentes. Use [AXIS:DIARY]...[AXIS:DIARY_END].\n\n' + recent }, { role: 'user', content: 'Escreva o diário.' }];
        const resp = await generateRaw(msgs, { maxTokens: 800 });
        const m = /\[AXIS:DIARY\]([\s\S]*?)\[AXIS:DIARY_END\]/.exec(resp);
        const content = m ? m[1].trim() : resp.trim();
        scope[DIARY_KEY].push({ id: 'diary_' + Date.now(), content, ts: Date.now() });
        if (scope[DIARY_KEY].length > 50) scope[DIARY_KEY] = scope[DIARY_KEY].slice(-50);
        addRpField('[Diário] ' + content);
        saveData();
        addMessage('agent', '[AXIS:CARD]\nDiário — ' + new Date().toLocaleString() + '\n\n' + content + '\n[AXIS:CARD_END]');
    } catch (e) { addMessage('agent', 'Erro: ' + (e.message || e)); }
}

function exportRecipe() {
    const scope = getScopeData();
    const recipe = {
        version: '2.0.0',
        exportedAt: new Date().toISOString(),
        scope: getCharacterScope(),
        sistemas: scope[SYSTEMS_KEY],
        rpField: scope[RP_FIELD_KEY],
        snapshots: scope[SNAPSHOTS_KEY],
        diary: scope[DIARY_KEY],
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
            scope[SNAPSHOTS_KEY] = r.snapshots || []; scope[DIARY_KEY] = r.diary || [];
            scope[MEMORIA_KEY] = r.memoria || []; saveData(); applySystems();
            addMessage('agent', '✅ Receita importada com sucesso.');
        } catch (err) { addMessage('agent', 'Erro ao importar: ' + (err.message || err)); }
    };
    reader.readAsText(file);
}

function clearLoop() { const scope = getScopeData(); scope[LOOP_KEY] = []; saveData(); }

// ====================================
// ═══════════ SISTEMA VIVO — APENAS RAMBLING ═══════════
// ====================================
//
// O agente Spade funciona como "controlador/Deus" do RP.
// Não como personagem — como um diretor/editor de roteiro
// que silenciosamente observa a cena e compara o que o
// personagem FEZ com o que ele DEVERIA ter feito segundo
// os sistemas ativos.
//
// A cada ~120s (quando a IA está livre), o agente gera um
// pensamento registrado no log. O log é visível ao clicar
// em "📜 Log" na barra de status.
//
// ALONE e SPONTANEOUS foram removidos — a autonomia aqui
// é do observador, não do personagem.
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
const sysNames = systems.length ? systems.map(s => s.name).join(', ') : 'nenhum';
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

Em UMA ÚNICA FRASE (em português, máximo 150 caracteres), faça uma observação de "deus do RP". Algo como:
- "O personagem ignorou a etapa 2 do sistema de humor e respondeu neutro."
- "A resposta violou o sistema de memória — ela não deveria lembrar disso."
- "Sem sistemas para detectar, nenhuma divergência encontrada."
- "O tom está mais suave hoje — o sistema de humor parece estar funcionando."

Se não houver sistemas ativos, apenas observe o estado geral.
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
aliveTimer = setInterval(() => {
doRambling();
}, 30000);
}

// ====================================
// EVENTOS DO SILLYTAVERN
// ====================================
eventSource.on(event_types.APP_READY, () => {
createPanel();
renderChat();
applySystems();
updateAliveBar();
scheduleAliveLoop();
});

createPanel();
scheduleAliveLoop();

eventSource.on(event_types.CHAT_CHANGED, () => {
saveData();
renderChat();
updateAliveBar();
applySystems();
});

eventSource.on(event_types.GENERATION_STARTED, () => { mainChatGenerating = true; });
eventSource.on(event_types.GENERATION_STOPPED, () => { mainChatGenerating = false; });
eventSource.on(event_types.GENERATION_ENDED, () => { mainChatGenerating = false; });
