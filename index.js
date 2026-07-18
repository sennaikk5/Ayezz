const {
    eventSource,
    event_types,
    getCurrentChatId,
    getRequestHeaders,
    saveChatDebounced,
    ChatCompletionService,
    TextCompletionService,
} = SillyTavern.getContext();

const AXIS_PREFIX = '[AXIS:';
const AXIS_SUFFIX = ']';
const AXIS_THINK = `${AXIS_PREFIX}THINK${AXIS_SUFFIX}`;
const AXIS_ACTION = `${AXIS_PREFIX}ACTION${AXIS_SUFFIX}`;
const AXIS_CARD = `${AXIS_PREFIX}CARD${AXIS_SUFFIX}`;
const AXIS_CARD_END = `${AXIS_PREFIX}CARD_END${AXIS_SUFFIX}`;
const AXIS_APPROVAL = `${AXIS_PREFIX}APPROVAL${AXIS_SUFFIX}`;
const AXIS_TRAINING = `${AXIS_PREFIX}TRAINING${AXIS_SUFFIX}`;
const AXIS_TRAINING_END = `${AXIS_PREFIX}TRAINING_END${AXIS_SUFFIX}`;
const AXIS_SANDBOX = `${AXIS_PREFIX}SANDBOX${AXIS_SUFFIX}`;
const AXIS_SANDBOX_ITEM = `${AXIS_PREFIX}SANDBOX_ITEM${AXIS_SUFFIX}`;
const AXIS_SANDBOX_END = `${AXIS_PREFIX}SANDBOX_END${AXIS_SUFFIX}`;
const AXIS_DIARY = `${AXIS_PREFIX}DIARY${AXIS_SUFFIX}`;
const AXIS_DIARY_END = `${AXIS_PREFIX}DIARY_END${AXIS_SUFFIX}`;
const AXIS_SNAPSHOT = `${AXIS_PREFIX}SNAPSHOT${AXIS_SUFFIX}`;
const AXIS_SNAPSHOT_END = `${AXIS_PREFIX}SNAPSHOT_END${AXIS_SUFFIX}`;
const AXIS_LOOP = `${AXIS_PREFIX}LOOP${AXIS_SUFFIX}`;
const AXIS_FREE = `${AXIS_PREFIX}FREE${AXIS_SUFFIX}`;
const AXIS_FREE_END = `${AXIS_PREFIX}FREE_END${AXIS_SUFFIX}`;
const AXIS_EXPORT = `${AXIS_PREFIX}EXPORT${AXIS_SUFFIX}`;
const AXIS_CROSSOVER = `${AXIS_PREFIX}CROSSOVER${AXIS_SUFFIX}`;

const DB_KEY = 'axis_extension_data';
const RP_FIELD_KEY = 'axis_rp_field';
const SYSTEMS_KEY = 'axis_systems';
const ESPACO_CHATS_KEY = 'axis_espaco_chats';
const MINI_CHATS_KEY = 'axis_mini_chats';
const CONNECTIONS_KEY = 'axis_connections';
const MEMORIA_KEY = 'axis_memoria_espaco';
const BEHAVIOR_KEY = 'axis_behavior';
const TRAINING_KEY = 'axis_training_sessions';
const SNAPSHOTS_KEY = 'axis_snapshots';
const DIARY_KEY = 'axis_diary';
const LOOP_KEY = 'axis_loop_patterns';
const SANDBOX_KEY = 'axis_sandbox_history';

let axisData = loadData();

function loadData() {
    try {
        return JSON.parse(localStorage.getItem(DB_KEY) || '{}');
    } catch (e) {
        return {};
    }
}

function saveData() {
    localStorage.setItem(DB_KEY, JSON.stringify(axisData));
}

function getCharacterScope() {
    const ctx = SillyTavern.getContext();
    const charId = ctx.characterId ?? ctx.groupId ?? 'global';
    return `char_${charId}`;
}

function getScopeData() {
    const scope = getCharacterScope();
    if (!axisData[scope]) {
        axisData[scope] = {
            [RP_FIELD_KEY]: [],
            [SYSTEMS_KEY]: [],
            [ESPACO_CHATS_KEY]: {},
            [MINI_CHATS_KEY]: {},
            [CONNECTIONS_KEY]: [],
            [MEMORIA_KEY]: [],
            [TRAINING_KEY]: [],
            [SNAPSHOTS_KEY]: [],
            [DIARY_KEY]: [],
            [LOOP_KEY]: [],
            [SANDBOX_KEY]: [],
            [BEHAVIOR_KEY]: { responseTimes: [], interactions: 0, lastAnalysis: null },
        };
        saveData();
    }
    return axisData[scope];
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function renderMarkers(text) {
    let html = escapeHtml(text);
    html = html.replace(/\[AXIS:THINK\]/g, '<span class="axis-marker axis-think">THINKING</span>');
    html = html.replace(/\[AXIS:ACTION\]/g, '<span class="axis-marker axis-action">AÇÃO</span>');
    return html;
}

function processCardBlocks(text) {
    const blocks = [];
    const cardRegex = /\[AXIS:CARD\]\s*([\s\S]*?)\s*\[AXIS:CARD_END\]/g;
    let lastIndex = 0;
    let match;
    while ((match = cardRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            blocks.push({ type: 'text', content: text.slice(lastIndex, match.index) });
        }
        blocks.push({ type: 'card', content: match[1].trim() });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
        blocks.push({ type: 'text', content: text.slice(lastIndex) });
    }
    return blocks;
}

function renderCardBlock(container, cardContent) {
    const cardEl = document.createElement('div');
    cardEl.className = 'axis-card';
    const header = document.createElement('div');
    header.className = 'axis-card-header';
    header.textContent = '📄 Arquivo';
    const body = document.createElement('div');
    body.className = 'axis-card-body';
    body.innerHTML = renderMarkers(cardContent);
    body.style.display = 'none';
    header.addEventListener('click', () => {
        body.style.display = body.style.display === 'none' ? 'block' : 'none';
        header.classList.toggle('axis-card-open');
    });
    cardEl.appendChild(header);
    cardEl.appendChild(body);
    container.appendChild(cardEl);
}

function renderApprovalBlock(container, approvalId, label) {
    const approvalEl = document.createElement('div');
    approvalEl.className = 'axis-approval';
    approvalEl.dataset.approvalId = approvalId;
    approvalEl.innerHTML = `
        <span class="axis-approval-label">⚠️ ${escapeHtml(label)}</span>
        <button class="axis-approval-yes">Sim</button>
        <button class="axis-approval-no">Não</button>
    `;
    container.appendChild(approvalEl);
    return approvalEl;
}

function buildMessageHtml(text) {
    const blocks = processCardBlocks(text);
    const container = document.createElement('div');
    for (const block of blocks) {
        if (block.type === 'text') {
            const div = document.createElement('div');
            div.innerHTML = renderMarkers(block.content);
            container.appendChild(div);
        } else if (block.type === 'card') {
            renderCardBlock(container, block.content);
        }
    }
    const approvalRegex = /\[AXIS:APPROVAL\s+ID:"([^"]+)"\s+LABEL:"([^"]+)"\]/g;
    const html = container.innerHTML;
    const finalHtml = html.replace(approvalRegex, (_, id, label) => {
        const uid = `approval_${id}_${Date.now()}`;
        return `<div class="axis-approval" data-approval-id="${uid}">
            <span class="axis-approval-label">⚠️ ${escapeHtml(label)}</span>
            <button class="axis-approval-yes" data-approve="${id}">Sim</button>
            <button class="axis-approval-no" data-approve="reject_${id}">Não</button>
        </div>`;
    });
    return finalHtml;
}

let espacoPanel = null;
let espacoChatArea = null;
let espacoInput = null;
let espacoSendBtn = null;
let currentMiniChatId = null;
let isGenerating = false;

function showAxisFatalError(msg) {
    console.error('[Spade]', msg);
    if (!espacoChatArea) return;
    const div = document.createElement('div');
    div.className = 'axis-msg axis-msg-agent';
    div.style.borderLeft = '3px solid #ff4444';
    div.style.color = '#ffb0b0';
    div.textContent = '⚠️ ' + msg;
    espacoChatArea.appendChild(div);
    espacoChatArea.scrollTop = espacoChatArea.scrollHeight;
}

function createEspacoPanel() {
    if (document.getElementById('axis-espaco-panel')) return;
    const body = document.body;
    espacoPanel = document.createElement('div');
    espacoPanel.id = 'axis-espaco-panel';
    espacoPanel.className = 'axis-espaco-panel';
    espacoPanel.innerHTML = `
        <div class="axis-espaco-header" id="axis-espaco-drag-handle">
            <span class="axis-espaco-title">Spade</span>
            <div class="axis-espaco-header-actions">
                <button id="axis-btn-mini-chat" class="axis-btn" title="Novo Mini-Chat">+Mini</button>
                <button id="axis-btn-systems" class="axis-btn" title="Sistemas">⚙</button>
                <button id="axis-btn-tools" class="axis-btn" title="Ferramentas">🛠</button>
                <button id="axis-btn-maximize" class="axis-btn" title="Aumentar/Restaurar">⛶</button>
                <button id="axis-btn-minimize" class="axis-btn" title="Minimizar">─</button>
                <button id="axis-btn-toggle" class="axis-btn axis-btn-close">✕</button>
            </div>
        </div>
        <div class="axis-espaco-body">
            <div id="axis-espaco-chat" class="axis-espaco-chat"></div>
            <div id="axis-mini-chat-bar" class="axis-mini-chat-bar"></div>
        </div>
        <div class="axis-espaco-footer">
            <textarea id="axis-espaco-input" class="axis-espaco-input" rows="2" placeholder="Fale com o agente..."></textarea>
            <button id="axis-espaco-send" class="axis-btn axis-btn-send">Enviar</button>
        </div>
    `;
    body.appendChild(espacoPanel);

    espacoChatArea = document.getElementById('axis-espaco-chat');
    espacoInput = document.getElementById('axis-espaco-input');
    espacoSendBtn = document.getElementById('axis-espaco-send');

    document.getElementById('axis-btn-toggle').addEventListener('click', closeEspacoPanel);
    document.getElementById('axis-btn-minimize').addEventListener('click', minimizeEspacoPanel);
    document.getElementById('axis-btn-maximize').addEventListener('click', toggleMaximizeEspacoPanel);
    document.getElementById('axis-btn-mini-chat').addEventListener('click', createMiniChat);
    document.getElementById('axis-btn-systems').addEventListener('click', toggleSystemsPanel);
    document.getElementById('axis-btn-tools').addEventListener('click', toggleToolsPanel);
    espacoSendBtn.addEventListener('click', () => {
        try {
            sendEspacoMessage();
        } catch (err) {
            showAxisFatalError('Erro ao clicar em Enviar: ' + err.message);
        }
    });
    espacoInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            try {
                sendEspacoMessage();
            } catch (err) {
                showAxisFatalError('Erro ao enviar (Enter): ' + err.message);
            }
        }
    });

    setupDrag(espacoPanel, document.getElementById('axis-espaco-drag-handle'));

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'axis-toggle-btn';
    toggleBtn.className = 'axis-toggle-btn';
    toggleBtn.innerHTML = 'S';
    toggleBtn.title = 'Spade';
    toggleBtn.addEventListener('click', toggleEspacoPanel);
    body.appendChild(toggleBtn);

    const wasVisible = localStorage.getItem('axis_espaco_visible');
    if (wasVisible !== 'false') {
        espacoPanel.classList.add('axis-visible');
        toggleBtn.classList.add('axis-active');
    }

    renderEspacoChat();
    renderMiniChatBar();
    listenApprovalClicks();
}

function setupDrag(panel, handle) {
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    handle.addEventListener('mousedown', (e) => {
        if (e.target.closest('.axis-espaco-header-actions')) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = panel.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        panel.style.transition = 'none';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        panel.style.left = (initialLeft + dx) + 'px';
        panel.style.top = (initialTop + dy) + 'px';
        panel.style.transform = 'none';
    });

    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        panel.style.transition = '';
        document.body.style.userSelect = '';
    });
}

function toggleEspacoPanel() {
    if (!espacoPanel) return;
    const visible = espacoPanel.classList.contains('axis-visible');
    if (visible) {
        closeEspacoPanel();
    } else {
        openEspacoPanel();
    }
}

function openEspacoPanel() {
    if (!espacoPanel) return;
    espacoPanel.classList.add('axis-visible');
    const btn = document.getElementById('axis-toggle-btn');
    if (btn) btn.classList.add('axis-active');
    renderEspacoChat();
    localStorage.setItem('axis_espaco_visible', 'true');
}

function closeEspacoPanel() {
    if (!espacoPanel) return;
    espacoPanel.classList.remove('axis-visible');
    const btn = document.getElementById('axis-toggle-btn');
    if (btn) btn.classList.remove('axis-active');
    localStorage.setItem('axis_espaco_visible', 'false');
}

function minimizeEspacoPanel() {
    if (!espacoPanel) return;
    const bodyEl = espacoPanel.querySelector('.axis-espaco-body');
    const footerEl = espacoPanel.querySelector('.axis-espaco-footer');
    const isMinimized = bodyEl.style.display === 'none';
    bodyEl.style.display = isMinimized ? '' : 'none';
    footerEl.style.display = isMinimized ? '' : 'none';
    const btn = document.getElementById('axis-btn-minimize');
    if (btn) btn.textContent = isMinimized ? '─' : '□';
}

let axisPanelSavedRect = null;

function toggleMaximizeEspacoPanel() {
    if (!espacoPanel) return;
    const isMaximized = espacoPanel.classList.contains('axis-maximized');
    const btn = document.getElementById('axis-btn-maximize');

    if (!isMaximized) {
        const rect = espacoPanel.getBoundingClientRect();
        axisPanelSavedRect = {
            width: espacoPanel.style.width || rect.width + 'px',
            height: espacoPanel.style.height || rect.height + 'px',
            top: espacoPanel.style.top || rect.top + 'px',
            left: espacoPanel.style.left || rect.left + 'px',
            transform: espacoPanel.style.transform || ''
        };
        espacoPanel.classList.add('axis-maximized');
        espacoPanel.style.width = '';
        espacoPanel.style.height = '';
        espacoPanel.style.top = '';
        espacoPanel.style.left = '';
        espacoPanel.style.transform = '';
        if (btn) { btn.textContent = '❐'; btn.title = 'Restaurar tamanho'; }
    } else {
        espacoPanel.classList.remove('axis-maximized');
        if (axisPanelSavedRect) {
            espacoPanel.style.width = axisPanelSavedRect.width;
            espacoPanel.style.height = axisPanelSavedRect.height;
            espacoPanel.style.top = axisPanelSavedRect.top;
            espacoPanel.style.left = axisPanelSavedRect.left;
            espacoPanel.style.transform = axisPanelSavedRect.transform;
        }
        if (btn) { btn.textContent = '⛶'; btn.title = 'Aumentar/Restaurar'; }
    }
}

function toggleToolsPanel() {
    const existing = document.getElementById('axis-tools-panel');
    if (existing) {
        existing.remove();
        return;
    }
    const panel = document.createElement('div');
    panel.id = 'axis-tools-panel';
    panel.className = 'axis-tools-panel';
    panel.innerHTML = `
        <div class="axis-tools-header">
            <span>Ferramentas</span>
            <button class="axis-btn axis-btn-close" id="axis-tools-close">✕</button>
        </div>
        <div class="axis-tools-body">
            <button class="axis-tool-item" id="axis-tool-training">🎤 Treinar Tom de Voz</button>
            <button class="axis-tool-item" id="axis-tool-sandbox">🎭 Sandbox de Variacoes</button>
            <button class="axis-tool-item" id="axis-tool-snapshot">📸 Snapshot do Personagem</button>
            <button class="axis-tool-item" id="axis-tool-snapshot-list">📋 Listar Snapshots</button>
            <button class="axis-tool-item" id="axis-tool-diary">📔 Gerar Diario</button>
            <button class="axis-tool-item" id="axis-tool-diary-list">📖 Ver Diario</button>
            <button class="axis-tool-item" id="axis-tool-crossover">🔗 Conectar Personagens</button>
            <button class="axis-tool-item" id="axis-tool-export">📦 Exportar Receita</button>
            <button class="axis-tool-item" id="axis-tool-import">📥 Importar Receita</button>
            <button class="axis-tool-item axis-tool-danger" id="axis-tool-clear-loop">🔄 Limpar Loop</button>
        </div>
    `;
    document.body.appendChild(panel);
    const anchorBtn = document.getElementById('axis-btn-tools');
    const abr = anchorBtn.getBoundingClientRect();
    panel.style.position = 'fixed';
    panel.style.top = abr.bottom + 'px';
    panel.style.right = (window.innerWidth - abr.right) + 'px';
    document.getElementById('axis-tools-close').addEventListener('click', () => panel.remove());
    document.getElementById('axis-tool-training').addEventListener('click', () => { panel.remove(); createTrainingSession(); });
    document.getElementById('axis-tool-sandbox').addEventListener('click', () => { panel.remove(); createSandboxSession(); });
    document.getElementById('axis-tool-snapshot').addEventListener('click', () => { panel.remove(); createCharacterSnapshot(); });
    document.getElementById('axis-tool-snapshot-list').addEventListener('click', () => { panel.remove(); listSnapshots(); });
    document.getElementById('axis-tool-diary').addEventListener('click', () => { panel.remove(); generateCharacterDiary(); });
    document.getElementById('axis-tool-diary-list').addEventListener('click', () => { panel.remove(); listDiaryEntries(); });
    document.getElementById('axis-tool-crossover').addEventListener('click', () => { panel.remove(); listCrossoverTargets(); });
    document.getElementById('axis-tool-export').addEventListener('click', () => { panel.remove(); exportCharacterRecipe(); });
    document.getElementById('axis-tool-import').addEventListener('click', () => {
        panel.remove();
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.addEventListener('change', (e) => {
            if (e.target.files[0]) importCharacterRecipe(e.target.files[0]);
        });
        input.click();
    });
    document.getElementById('axis-tool-clear-loop').addEventListener('click', () => { panel.remove(); clearLoopPatterns(); addEspacoMessage('agent', 'Padroes de loop limpos.'); });
}

function toggleSystemsPanel() {
    const existing = document.getElementById('axis-systems-panel');
    if (existing) {
        existing.remove();
        return;
    }
    const panel = document.createElement('div');
    panel.id = 'axis-systems-panel';
    panel.className = 'axis-systems-panel';
    const scope = getScopeData();
    const systems = scope[SYSTEMS_KEY] || [];
    panel.innerHTML = `
        <div class="axis-systems-header">
            <span>Sistemas</span>
            <button class="axis-btn axis-btn-close" id="axis-systems-close">✕</button>
        </div>
        <div class="axis-systems-body">
            ${systems.length === 0 ? '<p class="axis-empty">Nenhum sistema criado ainda.</p>' : ''}
            ${systems.map((s, i) => `
                <div class="axis-system-item" data-index="${i}">
                    <div class="axis-system-name">${escapeHtml(s.name)}</div>
                    <div class="axis-system-desc">${escapeHtml(s.description || '')}</div>
                    ${s.explicacao ? `<div class="axis-system-explicacao">📎 Explicação conectada</div>` : ''}
                    <button class="axis-btn axis-btn-sm axis-system-delete" data-index="${i}">Remover</button>
                </div>
            `).join('')}
        </div>
    `;
    document.body.appendChild(panel);
    const anchorBtnSys = document.getElementById('axis-btn-systems');
    const absr = anchorBtnSys.getBoundingClientRect();
    panel.style.position = 'fixed';
    panel.style.top = absr.bottom + 'px';
    panel.style.right = (window.innerWidth - absr.right) + 'px';
    document.getElementById('axis-systems-close').addEventListener('click', () => panel.remove());
    panel.querySelectorAll('.axis-system-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt(e.target.dataset.index);
            scope[SYSTEMS_KEY].splice(idx, 1);
            saveData();
            panel.remove();
            toggleSystemsPanel();
        });
    });
}

function buildEspacoContext() {
    const scope = getScopeData();
    const systems = scope[SYSTEMS_KEY] || [];
    const rpField = scope[RP_FIELD_KEY] || [];
    const memoria = scope[MEMORIA_KEY] || [];
    let ctx = '';
    if (memoria.length > 0) {
        ctx += 'MEMÓRIA DO ESPAÇO:\n' + memoria.map(m => `- ${m}`).join('\n') + '\n\n';
    }
    if (rpField.length > 0) {
        ctx += 'CAMPO RP:\n' + rpField.map(r => `- ${r}`).join('\n') + '\n\n';
    }
    if (systems.length > 0) {
        ctx += 'SISTEMAS ATIVOS:\n';
        systems.forEach((s, i) => {
            ctx += `${i + 1}. ${s.name}: ${s.description || ''}`;
            if (s.explicacao) ctx += `\n   Explicação: ${s.explicacao}`;
            ctx += '\n';
        });
    }
    return ctx;
}

async function generateRaw(messages, options = {}) {
    const { maxTokens = 800, stream = false, signal = null } = options;
    const ctx = SillyTavern.getContext();
    let profileId = options.profileId;
    if (!profileId) {
        const cm = ctx.extensionSettings?.connectionManager;
        profileId = cm?.selectedProfile;
    }
    if (!profileId) throw new Error('Nenhum perfil de conexão selecionado');
    try {
        const result = await ctx.ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, {
            stream,
            signal,
            extractData: true,
            includePreset: false,
            includeInstruct: false,
        });
        return result?.text || result?.content || '';
    } catch (e) {
        const causeMsg = e.cause?.message || (typeof e.cause === 'string' ? e.cause : '');
        throw new Error(`Falha na geração: ${e.message}${causeMsg ? ' — ' + causeMsg : ''}`);
    }
}

function addEspacoMessage(role, text, chatId = null) {
    const scope = getScopeData();
    const cid = chatId || 'main';
    if (!scope[ESPACO_CHATS_KEY][cid]) {
        scope[ESPACO_CHATS_KEY][cid] = { messages: [], name: cid === 'main' ? 'Principal' : cid, isMiniChat: cid.startsWith('mini_') };
    }
    const chat = scope[ESPACO_CHATS_KEY][cid];
    const msg = { role, text, timestamp: Date.now() };
    chat.messages.push(msg);
    if (chat.messages.length > 200) {
        chat.messages = chat.messages.slice(-200);
    }
    saveData();
    if (cid === 'main' || cid === currentMiniChatId) {
        renderEspacoChat();
    }
    return msg;
}

function renderEspacoChat() {
    if (!espacoChatArea) return;
    const scope = getScopeData();
    const chatId = currentMiniChatId || 'main';
    const chat = scope[ESPACO_CHATS_KEY][chatId];
    if (!chat) {
        espacoChatArea.innerHTML = '<p class="axis-empty">Nenhuma conversa ainda. Comece a falar com o agente.</p>';
        return;
    }
    const messages = chat.messages;
    let html = '';
    for (const msg of messages) {
        const roleClass = msg.role === 'user' ? 'axis-msg-user' : 'axis-msg-agent';
        html += `<div class="axis-msg ${roleClass}">${buildMessageHtml(msg.text)}</div>`;
    }
    espacoChatArea.innerHTML = html;
    espacoChatArea.scrollTop = espacoChatArea.scrollHeight;
    listenApprovalClicks();
}

function listenApprovalClicks() {
    if (!espacoChatArea) return;
    espacoChatArea.querySelectorAll('.axis-approval-yes').forEach(btn => {
        if (btn.dataset.listener) return;
        btn.dataset.listener = '1';
        btn.addEventListener('click', async (e) => {
            const approveId = e.target.dataset.approve;
            const approvalEl = e.target.closest('.axis-approval');
            approvalEl.innerHTML = '<span class="axis-approval-label">✅ Aprovado</span>';
            handleApproval(approveId, true);
        });
    });
    espacoChatArea.querySelectorAll('.axis-approval-no').forEach(btn => {
        if (btn.dataset.listener) return;
        btn.dataset.listener = '1';
        btn.addEventListener('click', (e) => {
            const approveId = e.target.dataset.approve;
            const approvalEl = e.target.closest('.axis-approval');
            approvalEl.innerHTML = '<span class="axis-approval-label">❌ Rejeitado</span>';
            handleApproval(approveId, false);
        });
    });
}

function processSystemProposals(text, chatId) {
    const scope = getScopeData();
    const proposalRegex = /\[AXIS:SYSTEM_PROPOSAL\s+NAME:"([^"]+)"\s+DESC:"([^"]+)"\]/g;
    if (!scope._pendingSystems) scope._pendingSystems = {};
    const result = text.replace(proposalRegex, (_, name, desc) => {
        const uid = `sys_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        scope._pendingSystems[uid] = { name: name.trim(), description: desc.trim() };
        return `[AXIS:APPROVAL ID:"create_system_${uid}" LABEL:"Criar sistema \\"${name.trim()}\\"?"]`;
    });
    saveData();
    return result;
}

function handleApproval(approveId, approved) {
    const scope = getScopeData();
    if (approveId.startsWith('reject_')) return;
    if (approveId.startsWith('create_system_')) {
        const uid = approveId.replace('create_system_', '');
        const pending = scope._pendingSystems?.[uid];
        if (pending && approved) {
            scope[SYSTEMS_KEY].push(pending);
            delete scope._pendingSystems[uid];
            saveData();
            addEspacoMessage('agent', `✅ Sistema "${pending.name}" criado com sucesso.`);
        }
    }
    if (approveId.startsWith('connect_rp_')) {
        const chatId = approveId.replace('connect_rp_', '');
        if (approved) {
            connectToCampoRP(chatId);
            addEspacoMessage('agent', `✅ "${chatId}" conectado ao Campo RP.`);
        }
    }
}

async function sendEspacoMessage() {
    if (isGenerating) return;
    const text = espacoInput.value.trim();
    if (!text) return;
    const chatId = currentMiniChatId || 'main';
    espacoInput.value = '';
    try {
        addEspacoMessage('user', text, chatId);
    } catch (err) {
        showAxisFatalError('Falha ao registrar sua mensagem: ' + err.message);
        return;
    }
    isGenerating = true;
    espacoSendBtn.disabled = true;
    try {
        const context = buildEspacoContext();
        const scope = getScopeData();
        const chat = scope[ESPACO_CHATS_KEY][chatId];
        const recentMessages = chat.messages.slice(-30);
        const messages = [];
        const systemContent = `Você é um agente de IA auxiliar para configuração de personagens de roleplay no SillyTavern. Você é amigável, direto e conversacional. Você pode criar sistemas, conectar chats ao Campo RP, treinar tom de voz do personagem e ajudar com configurações.\n\nQuando o usuário pedir para criar um "sistema" (uma regra ou mecânica configurável para o personagem), proponha usando exatamente este formato em algum ponto da resposta: [AXIS:SYSTEM_PROPOSAL NAME:"nome curto" DESC:"descrição do que o sistema faz"]. Não crie o sistema sozinho — apenas proponha com esse marcador, o usuário vai aprovar ou recusar.\n\n${context}`;
        messages.push({ role: 'system', content: systemContent });
        for (const msg of recentMessages) {
            messages.push({ role: msg.role === 'agent' ? 'assistant' : msg.role, content: msg.text });
        }
        const response = await generateRaw(messages, { maxTokens: 800 });

        const { cleaned, reflections } = processFreeWillThinking(response);
        if (reflections.length > 0) {
            handleFreeWillReflections(reflections);
        }
        const withSystemProposals = processSystemProposals(cleaned, chatId);
        addEspacoMessage('agent', withSystemProposals, chatId);
    } catch (e) {
        addEspacoMessage('agent', `Erro: ${e.message}`, chatId);
    } finally {
        isGenerating = false;
        espacoSendBtn.disabled = false;
        espacoInput.focus();
    }
}

function connectToCampoRP(sourceId) {
    const scope = getScopeData();
    const source = scope[ESPACO_CHATS_KEY][sourceId] || scope[MINI_CHATS_KEY][sourceId];
    if (!source) return;
    const connections = scope[CONNECTIONS_KEY] || [];
    if (!connections.find(c => c.sourceId === sourceId)) {
        connections.push({ sourceId, type: source.isMiniChat ? 'mini_chat' : 'chat', timestamp: Date.now() });
        scope[CONNECTIONS_KEY] = connections;
    }
    const rpField = scope[RP_FIELD_KEY] || [];
    for (const msg of source.messages) {
        if (msg.role === 'agent') {
            const entry = `[${source.name || sourceId}] ${msg.text.substring(0, 500)}`;
            if (!rpField.find(r => r === entry)) {
                rpField.push(entry);
            }
        }
    }
    if (rpField.length > 100) {
        scope[RP_FIELD_KEY] = rpField.slice(-100);
    }
    saveData();
}

function createMiniChat() {
    const scope = getScopeData();
    const id = `mini_${Date.now()}`;
    const name = `Mini-${Object.keys(scope[MINI_CHATS_KEY]).length + 1}`;
    scope[MINI_CHATS_KEY][id] = { messages: [], name, isMiniChat: true, parentId: 'main' };
    scope[ESPACO_CHATS_KEY][id] = scope[MINI_CHATS_KEY][id];
    saveData();
    openMiniChat(id);
    renderMiniChatBar();
}

function openMiniChat(id) {
    currentMiniChatId = id;
    renderEspacoChat();
    renderMiniChatBar();
}

function closeMiniChat() {
    currentMiniChatId = null;
    renderEspacoChat();
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
        html += `<span class="axis-mini-back" id="axis-mini-back">← Voltar ao Espaço</span>`;
    }
    for (const id of ids) {
        const mc = miniChats[id];
        const active = id === currentMiniChatId ? ' axis-mini-active' : '';
        html += `<span class="axis-mini-tab${active}" data-mini-id="${id}">${escapeHtml(mc.name)}</span>`;
    }
    bar.innerHTML = html;
    bar.querySelector('#axis-mini-back')?.addEventListener('click', closeMiniChat);
    bar.querySelectorAll('.axis-mini-tab').forEach(tab => {
        tab.addEventListener('click', () => openMiniChat(tab.dataset.miniId));
    });
}

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
    saveData();
    const avgResponseTime = behavior.responseTimes.length > 0
        ? behavior.responseTimes.reduce((a, b) => a + b, 0) / behavior.responseTimes.length
        : 0;
    if (behavior.interactions % 10 === 0 && behavior.interactions > 0) {
        const indicator = document.getElementById('axis-aprimorar-indicator');
        if (indicator) {
            indicator.style.display = 'block';
            indicator.textContent = '💡 Aprimorar disponível';
        }
    }
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
            addEspacoMessage('agent', 'Sugestão de aprimoramento: analise o tom e estilo atual do personagem e veja o que pode ser refinado. Quer que eu faça uma análise?');
        }
    });
    if (espacoPanel) espacoPanel.querySelector('.axis-espaco-header')?.appendChild(indicator);
}

// ============================================================
// TREINAMENTO DE VOZ DEDICADO
// ============================================================

function createTrainingSession() {
    const scope = getScopeData();
    const miniId = `mini_${Date.now()}`;
    const name = `Treino-${Object.keys(scope[TRAINING_KEY] || {}).length + 1}`;

    scope[MINI_CHATS_KEY][miniId] = {
        messages: [],
        name,
        isMiniChat: true,
        isTraining: true,
        phase: 'detecting',
        parentId: 'main',
    };
    scope[ESPACO_CHATS_KEY][miniId] = scope[MINI_CHATS_KEY][miniId];
    if (!scope[TRAINING_KEY]) scope[TRAINING_KEY] = [];
    scope[TRAINING_KEY].push({
        id: `train_${Date.now()}`,
        miniChatId: miniId,
        name,
        status: 'detecting',
        createdAt: Date.now(),
        confirmedStyle: null,
        result: null,
    });
    saveData();
    openMiniChat(miniId);
    addEspacoMessage('agent', `[AXIS:TRAINING]\nModo de treinamento iniciado. Envie textos de exemplo, arquivos ou descreva o estilo de voz que voce quer para o personagem. Quando eu detectar o padrao, vou mostrar um exemplo e pedir confirmacao.\n[AXIS:TRAINING_END]`, miniId);
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
        addEspacoMessage('agent', `[AXIS:TRAINING]\nEstilo confirmado. Iniciando treinamento aprofundado...\n[AXIS:TRAINING_END]`, miniChatId);
        executeTrainingSession(miniChatId);
    } else {
        session.status = 'detecting';
        miniChat.phase = 'detecting';
        delete session._detectedStyle;
        saveData();
        addEspacoMessage('agent', `[AXIS:TRAINING]\nOk, vou ajustar. Me de mais exemplos ou descreva melhor o estilo que voce quer.\n[AXIS:TRAINING_END]`, miniChatId);
    }
}

async function executeTrainingSession(miniChatId) {
    const scope = getScopeData();
    const miniChat = scope[MINI_CHATS_KEY][miniChatId];
    if (!miniChat || miniChat.phase !== 'training') return;

    const session = scope[TRAINING_KEY].find(t => t.miniChatId === miniChatId);
    if (!session) return;

    addEspacoMessage('agent', '[AXIS:ACTION] Gerando exemplos de dialogo no estilo confirmado...', miniChatId);

    try {
        const context = buildEspacoContext();
        const recentMessages = miniChat.messages.slice(-20);
        const messages = [];
        messages.push({
            role: 'system',
            content: `Voce esta em modo de TREINAMENTO DE VOZ para um personagem de roleplay. Seu objetivo e gerar multiplos exemplos de dialogo no estilo de voz confirmado: "${session.confirmedStyle}".\n\n${context}\n\nGere 3-5 exemplos de fala do personagem em situacoes diferentes. Use [AXIS:SANDBOX_ITEM] antes de cada exemplo. Termine com [AXIS:SANDBOX_END]. Apos os exemplos, pergunte se o usuario gostou.`,
        });
        for (const msg of recentMessages) {
            messages.push({ role: msg.role === 'agent' ? 'assistant' : msg.role, content: msg.text });
        }

        const response = await generateRaw(messages, { maxTokens: 1200 });
        miniChat.messages.push({ role: 'agent', text: response, timestamp: Date.now() });

        const extractedStyle = extractTrainingResult(response);
        if (extractedStyle) {
            session.result = extractedStyle;
            session.status = 'completed';
            miniChat.phase = 'completed';
            const rpEntry = `[Treino de Voz: ${session.name}] ${extractedStyle}`;
            if (!scope[RP_FIELD_KEY].find(r => r === rpEntry)) {
                scope[RP_FIELD_KEY].push(rpEntry);
            }
        }
        saveData();
        renderEspacoChat();
    } catch (e) {
        addEspacoMessage('agent', `Erro no treinamento: ${e.message}`, miniChatId);
    }
}

function extractTrainingResult(text) {
    const sandboxRegex = /\[AXIS:SANDBOX_ITEM\]\s*([\s\S]*?)(?=\[AXIS:SANDBOX_ITEM\]|\[AXIS:SANDBOX_END\])/g;
    const items = [];
    let match;
    while ((match = sandboxRegex.exec(text)) !== null) {
        items.push(match[1].trim());
    }
    const parts = text.split('[AXIS:SANDBOX_END]');
    const afterSandbox = parts.length > 1 ? parts[1].trim() : '';
    return items.length > 0
        ? `Exemplos gerados: ${items.length} variacoes. ${afterSandbox}`.trim()
        : afterSandbox || text.substring(0, 300);
}

// ============================================================
// LIVRE ARBITRIO NO THINKING (REFLEXAO INLINE)
// ============================================================

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
        const entry = `[Reflexao ${new Date().toISOString()}] ${cleanReflection}`;
        if (!scope[MEMORIA_KEY].find(m => m === entry)) {
            scope[MEMORIA_KEY].push(entry);
        }
        if (scope[MEMORIA_KEY].length > 50) {
            scope[MEMORIA_KEY] = scope[MEMORIA_KEY].slice(-50);
        }
    }
    saveData();
}

// ============================================================
// SNAPSHOT DE ESTADO DO PERSONAGEM
// ============================================================

async function createCharacterSnapshot() {
    const scope = getScopeData();
    const chatId = currentMiniChatId || 'main';
    addEspacoMessage('agent', '[AXIS:ACTION] Criando snapshot do estado atual do personagem...', chatId);

    try {
        const context = buildEspacoContext();
        const messages = [];
        messages.push({
            role: 'system',
            content: `Crie um "snapshot" do estado atual do personagem de roleplay. Descreva:\n- O que a personagem SABE neste momento\n- O que a personagem SENTE (estado emocional)\n- O que a personagem PENSA sobre os eventos recentes\n- O que a personagem QUER (objetivo imediato)\n- Estado do relacionamento com {{user}}\n\nUse [AXIS:SNAPSHOT] no inicio e [AXIS:SNAPSHOT_END] no final.\n\n${context}`,
        });
        messages.push({ role: 'user', content: 'Crie o snapshot do estado atual do personagem.' });

        const response = await generateRaw(messages, { maxTokens: 600 });
        const snapshotRegex = /\[AXIS:SNAPSHOT\]([\s\S]*?)\[AXIS:SNAPSHOT_END\]/;
        const match = snapshotRegex.exec(response);
        const content = match ? match[1].trim() : response.trim();

        const snapshot = {
            id: `snap_${Date.now()}`,
            content,
            timestamp: Date.now(),
            chatId: getCurrentChatId(),
        };
        scope[SNAPSHOTS_KEY].push(snapshot);
        if (scope[SNAPSHOTS_KEY].length > 30) {
            scope[SNAPSHOTS_KEY] = scope[SNAPSHOTS_KEY].slice(-30);
        }
        const rpEntry = `[Snapshot ${new Date().toLocaleString()}] ${content}`;
        if (!scope[RP_FIELD_KEY].find(r => r === rpEntry)) {
            scope[RP_FIELD_KEY].push(rpEntry);
        }
        saveData();
        addEspacoMessage('agent', `[AXIS:CARD]\nSnapshot do personagem:\n\n${content}\n[AXIS:CARD_END]`, chatId);
    } catch (e) {
        addEspacoMessage('agent', `Erro ao criar snapshot: ${e.message}`, chatId);
    }
}

function listSnapshots() {
    const scope = getScopeData();
    const snapshots = scope[SNAPSHOTS_KEY] || [];
    if (snapshots.length === 0) {
        addEspacoMessage('agent', 'Nenhum snapshot criado ainda.');
        return;
    }
    let list = '';
    snapshots.slice(-10).forEach(s => {
        const date = new Date(s.timestamp).toLocaleString();
        list += `[AXIS:CARD]\nSnapshot - ${date}\n\n${s.content}\n[AXIS:CARD_END]\n`;
    });
    addEspacoMessage('agent', list);
}

// ============================================================
// SANDBOX DE VARIACOES DE FALA
// ============================================================

async function createSandboxSession() {
    const scope = getScopeData();
    const miniId = `mini_${Date.now()}`;
    const name = `Sandbox-${Object.keys(scope[SANDBOX_KEY] || {}).length + 1}`;

    scope[MINI_CHATS_KEY][miniId] = {
        messages: [],
        name,
        isMiniChat: true,
        isSandbox: true,
        parentId: 'main',
    };
    scope[ESPACO_CHATS_KEY][miniId] = scope[MINI_CHATS_KEY][miniId];
    if (!scope[SANDBOX_KEY]) scope[SANDBOX_KEY] = [];
    scope[SANDBOX_KEY].push({ miniChatId: miniId, name, createdAt: Date.now(), variants: [] });
    saveData();
    openMiniChat(miniId);
    addEspacoMessage('agent', `[AXIS:SANDBOX]\nModo Sandbox ativado. Descreva uma situacao e eu vou gerar 3 variacoes de como o personagem responderia. Voce escolhe qual estilo prefere e eu aprendo sua preferencia.\n\nExemplo: "A personagem encontra o user chegando atrasado na reuniao"\n[AXIS:SANDBOX_END]`, miniId);
}

async function generateSandboxVariants(miniChatId, situation) {
    const scope = getScopeData();
    const miniChat = scope[MINI_CHATS_KEY][miniChatId];
    if (!miniChat) return;

    addEspacoMessage('agent', '[AXIS:ACTION] Gerando 3 variacoes...', miniChatId);

    try {
        const context = buildEspacoContext();
        const messages = [];
        messages.push({
            role: 'system',
            content: `Voce esta no modo SANDBOX. Gere 3 variacoes DIFERENTES de como o personagem responderia a seguinte situacao. Cada variacao deve ter um estilo/tom diferente. Use [AXIS:SANDBOX_ITEM] antes de cada uma e termine com [AXIS:SANDBOX_END]. Apos as 3 variacoes, pergunte: "Qual voce prefere? (1, 2 ou 3)"\n\n${context}`,
        });
        messages.push({ role: 'user', content: `Situacao: ${situation}` });

        const response = await generateRaw(messages, { maxTokens: 1000 });
        miniChat.messages.push({ role: 'agent', text: response, timestamp: Date.now() });

        const sbSession = scope[SANDBOX_KEY].find(s => s.miniChatId === miniChatId);
        if (sbSession) {
            const variants = extractSandboxVariants(response);
            sbSession.variants.push({ situation, variants, timestamp: Date.now() });
        }
        saveData();
        renderEspacoChat();
    } catch (e) {
        addEspacoMessage('agent', `Erro no sandbox: ${e.message}`, miniChatId);
    }
}

function extractSandboxVariants(text) {
    const itemRegex = /\[AXIS:SANDBOX_ITEM\]\s*([\s\S]*?)(?=\[AXIS:SANDBOX_ITEM\]|\[AXIS:SANDBOX_END\])/g;
    const variants = [];
    let match;
    while ((match = itemRegex.exec(text)) !== null) {
        variants.push(match[1].trim());
    }
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
    const rpEntry = `[Sandbox Preferencia: ${lastVariants.situation}] Estilo escolhido: ${chosen}`;
    if (!scope[RP_FIELD_KEY].find(r => r === rpEntry)) {
        scope[RP_FIELD_KEY].push(rpEntry);
    }
    addEspacoMessage('agent', `Preferencia registrada! Vou usar esse estilo como referencia.\n\nEstilo escolhido (#${choice}):\n"${chosen}"`, miniChatId);
    saveData();
}

// ============================================================
// DIARIO AUTOMATICO DA PERSONAGEM
// ============================================================

async function generateCharacterDiary() {
    const scope = getScopeData();
    const chatId = currentMiniChatId || 'main';
    addEspacoMessage('agent', '[AXIS:ACTION] Escrevendo diario do ponto de vista da personagem...', chatId);

    try {
        const context = buildEspacoContext();
        const rpField = scope[RP_FIELD_KEY] || [];
        const recentEvents = rpField.slice(-10).join('\n');

        const messages = [];
        messages.push({
            role: 'system',
            content: `Escreva uma entrada de DIARIO do ponto de vista da personagem de roleplay, na PRIMEIRA PESSOA, sobre os eventos recentes. Nao e um resumo seco - e como ELA viveu e sentiu os acontecimentos.\n\nEventos recentes:\n${recentEvents}\n\nUse [AXIS:DIARY] no inicio e [AXIS:DIARY_END] no final. Escreva em portugues, no estilo emocional da personagem.\n\n${context}`,
        });
        messages.push({ role: 'user', content: 'Escreva a entrada de diario da personagem.' });

        const response = await generateRaw(messages, { maxTokens: 800 });
        const diaryRegex = /\[AXIS:DIARY\]([\s\S]*?)\[AXIS:DIARY_END\]/;
        const match = diaryRegex.exec(response);
        const content = match ? match[1].trim() : response.trim();

        const entry = {
            id: `diary_${Date.now()}`,
            content,
            timestamp: Date.now(),
            chatId: getCurrentChatId(),
        };
        scope[DIARY_KEY].push(entry);
        if (scope[DIARY_KEY].length > 50) {
            scope[DIARY_KEY] = scope[DIARY_KEY].slice(-50);
        }
        const rpEntry = `[Diario ${new Date().toLocaleString()}] ${content}`;
        if (!scope[RP_FIELD_KEY].find(r => r === rpEntry)) {
            scope[RP_FIELD_KEY].push(rpEntry);
        }
        saveData();
        addEspacoMessage('agent', `[AXIS:CARD]\nDiario da Personagem - ${new Date().toLocaleString()}\n\n${content}\n[AXIS:CARD_END]`, chatId);
    } catch (e) {
        addEspacoMessage('agent', `Erro ao gerar diario: ${e.message}`, chatId);
    }
}

function listDiaryEntries() {
    const scope = getScopeData();
    const entries = scope[DIARY_KEY] || [];
    if (entries.length === 0) {
        addEspacoMessage('agent', 'Nenhuma entrada de diario ainda.');
        return;
    }
    let list = '';
    entries.slice(-10).reverse().forEach(e => {
        const date = new Date(e.timestamp).toLocaleString();
        list += `[AXIS:CARD]\n${date}\n\n${e.content}\n[AXIS:CARD_END]\n`;
    });
    addEspacoMessage('agent', list);
}

// ============================================================
// DETECTOR DE LOOP NARRATIVO
// ============================================================

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
        if (existing.count >= 3) {
            const indicator = document.getElementById('axis-aprimorar-indicator');
            if (indicator) {
                indicator.style.display = 'block';
                indicator.textContent = 'Loop narrativo detectado';
                indicator.dataset.loopType = 'narrative';
            }
        }
    } else {
        loops.push({ signature, count: 1, firstSeen: Date.now(), lastSeen: Date.now(), sample: rpMessage.substring(0, 200) });
    }

    if (loops.length > 30) {
        scope[LOOP_KEY] = loops.slice(-30);
    }
    saveData();
}

function clearLoopPatterns() {
    const scope = getScopeData();
    scope[LOOP_KEY] = [];
    saveData();
    const indicator = document.getElementById('axis-aprimorar-indicator');
    if (indicator && indicator.dataset.loopType === 'narrative') {
        indicator.style.display = 'none';
    }
}

// ============================================================
// CONEXAO ENTRE PERSONAGENS (CROSSOVER)
// ============================================================

function getOtherCharacterScopes() {
    const scopes = [];
    for (const key of Object.keys(axisData)) {
        if (key.startsWith('char_') && key !== getCharacterScope()) {
            scopes.push(key);
        }
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

    const crossoverEntry = `[AXIS:CROSSOVER de ${myName}] ${myRpField.slice(-5).join(' | ')}`;
    if (!targetRpField.find(r => r === crossoverEntry)) {
        targetRpField.push(crossoverEntry);
        saveData();
        addEspacoMessage('agent', `Informacoes do Campo RP enviadas para "${targetCharScope}".`);
    } else {
        addEspacoMessage('agent', `As informacoes ja foram enviadas anteriormente para "${targetCharScope}".`);
    }
}

function listCrossoverTargets() {
    const scopes = getOtherCharacterScopes();
    if (scopes.length === 0) {
        addEspacoMessage('agent', 'Nenhum outro personagem com extensao Axis encontrado.');
        return;
    }
    let list = 'Personagens disponiveis para crossover:\n\n';
    scopes.forEach(s => {
        const name = axisData[s]?.[ESPACO_CHATS_KEY]?.main?.name || s;
        list += `[AXIS:APPROVAL ID:"crossover_${s}" LABEL:"Conectar Campo RP com ${name}?"]\n`;
    });
    addEspacoMessage('agent', list);
}

// ============================================================
// EXPORTACAO DE PERSONAGEM COMO RECEITA
// ============================================================

function exportCharacterRecipe() {
    const scope = getScopeData();
    const recipe = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        characterScope: getCharacterScope(),
        sistemas: scope[SYSTEMS_KEY] || [],
        rpField: scope[RP_FIELD_KEY] || [],
        trainingSessions: scope[TRAINING_KEY] || [],
        snapshots: scope[SNAPSHOTS_KEY] || [],
        diary: scope[DIARY_KEY] || [],
        sandboxHistory: scope[SANDBOX_KEY] || [],
        memoria: scope[MEMORIA_KEY] || [],
    };

    const blob = new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `axis-recipe-${getCharacterScope()}-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    addEspacoMessage('agent', `[AXIS:CARD]\nReceita do personagem exportada!\n\nInclui: ${scope[SYSTEMS_KEY].length} sistemas, ${scope[RP_FIELD_KEY].length} entradas no Campo RP, ${(scope[TRAINING_KEY] || []).length} sessoes de treino, ${scope[SNAPSHOTS_KEY].length} snapshots, ${scope[DIARY_KEY].length} entradas de diario.\n\nArquivo: .json (importavel por outra instancia da extensao)\n[AXIS:CARD_END]`);
}

function importCharacterRecipe(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const recipe = JSON.parse(e.target.result);
            if (!recipe.version || !recipe.sistemas) {
                throw new Error('Formato invalido');
            }
            const scope = getScopeData();
            scope[SYSTEMS_KEY] = recipe.sistemas;
            scope[RP_FIELD_KEY] = recipe.rpField || [];
            scope[TRAINING_KEY] = recipe.trainingSessions || [];
            scope[SNAPSHOTS_KEY] = recipe.snapshots || [];
            scope[DIARY_KEY] = recipe.diary || [];
            scope[SANDBOX_KEY] = recipe.sandboxHistory || [];
            scope[MEMORIA_KEY] = recipe.memoria || [];
            saveData();
            addEspacoMessage('agent', 'Receita importada com sucesso! Sistemas, Campo RP, treinos e diarios foram carregados.');
        } catch (err) {
            addEspacoMessage('agent', `Erro ao importar receita: ${err.message}`);
        }
    };
    reader.readAsText(file);
}

eventSource.on(event_types.APP_READY, () => {
    createEspacoPanel();
    createAprimorarIndicator();
});

// Garante que o painel apareça mesmo se a extensão for carregada
// depois que o evento APP_READY já disparou (ex: instalação/reload manual)
createEspacoPanel();
createAprimorarIndicator();

eventSource.on(event_types.CHAT_CHANGED, () => {
    saveData();
    renderEspacoChat();
    renderMiniChatBar();
    const indicator = document.getElementById('axis-aprimorar-indicator');
    if (indicator) indicator.style.display = 'none';
});

eventSource.on(event_types.MESSAGE_RECEIVED, (msg) => {
    analyzeUserBehavior();
    if (msg && typeof msg === 'string') {
        detectNarrativeLoop(msg);
    }
});

eventSource.on(event_types.MESSAGE_SENT, () => {
    analyzeUserBehavior();
});

console.log('[Spade] Extensão carregada com sucesso.');