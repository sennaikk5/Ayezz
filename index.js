/*
 * Spade v8.9.2 — memória e organização para UMA IA só (SillyTavern).
 * Tudo num arquivo, sem import: o SillyTavern só é lido por SillyTavern.getContext().
 *
 * O que a v8 é (SPEC v8 + adendo A): um prompt SEMPRE na mesma ordem e curto,
 * uma memória em 3 gavetas com orçamento de tokens, uma Biblioteca de arquivos
 * em pastas (a IA lê só a NOTA, nunca o arquivo), chats conectáveis, o pedido
 * do Espaço valendo na próxima fala do RP, e um "estilo guiado" medido por código.
 * Quem GERA a fala é sempre o SillyTavern; a Spade só alimenta o prompt dele.
 *
 * Organização deste arquivo (seções numeradas, na ordem em que dependem uma da outra):
 *  01 base · 02 config · 03 armazenamento (disco via plugin + reserva no navegador)
 *  04 Biblioteca (dados e seleção por orçamento) · 05 Descrição, Memória, conexões
 *  06 regras, repetição, pensamento · 06b relógio da história (8.1.0) · 07 estilo guiado (medir, exemplos, girar, conferir)
 *  08 compositor do prompt · 09 entrega ao SillyTavern (slots, eventos, interceptor)
 *  10 IA e jobs · 11 backup, exportação e migração · 12 Espaço (conversas, 1:1, conexões)
 *  13 interface · 14 início · 15 tempo real (8.6.0: a personagem acompanha o campo de texto e pode cortar a fala do autor)
 *  16 fichas (8.7.0: o Espaço decide sozinho onde guardar o que o autor conta; 8.8.0: Fase 2 — organizar o que já falei, arrumar fichas, passar pra Descrição; fica no fim, antes de iniciar())
 */
(function () {
    'use strict';

    // Erro fatal sempre aparece na tela (nada de catch que engole em silêncio).
    function reportFatalError(err) {
        console.error('[Spade] ERRO:', err);
        try {
            let box = document.getElementById('spd-fatal');
            if (!box) {
                box = document.createElement('div');
                box.id = 'spd-fatal';
                box.style.cssText =
                    'position:fixed;bottom:16px;left:16px;z-index:2147483647;background:#241515;color:#e9b3b3;border:1px solid #b85a5a;border-radius:12px;padding:12px 16px;max-width:min(440px,92vw);font:12px/1.4 monospace;white-space:pre-wrap;box-shadow:0 8px 30px rgba(0,0,0,.6)';
                box.addEventListener('click', () => box.remove());
                document.body.appendChild(box);
            }
            box.textContent = 'Spade — erro (toque pra fechar):\n' + (err && err.stack ? err.stack : String(err));
        } catch (_) {
            /* sem DOM ainda: o console já tem o erro */
        }
    }

    try {
        // ============================================================
        // 01 BASE
        // ============================================================
        function ctx() {
            return SillyTavern.getContext();
        }
        const { eventSource, event_types } = ctx();
        const VERSAO = '8.9.2';

        const esc = (s) =>
            String(s == null ? '' : s).replace(
                /[&<>"']/g,
                (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
            );
        const newId = (pre = 'a') => pre + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        function debounce(fn, ms) {
            let t;
            return (...a) => {
                clearTimeout(t);
                t = setTimeout(() => fn(...a), ms);
            };
        }
        // Estimativa única usada em TODA a conta de orçamento (determinística). A Prévia mostra também a
        // contagem real do SillyTavern quando ela existir, marcando qual é qual.
        const estimarTokens = (t) => Math.ceil(String(t || '').length / 3.5);
        function fmtRel(ts) {
            if (!ts) return '';
            const s = Math.max(0, (Date.now() - ts) / 1000);
            if (s < 60) return 'agora';
            if (s < 3600) return 'há ' + Math.floor(s / 60) + ' min';
            if (s < 86400) return 'há ' + Math.floor(s / 3600) + ' h';
            return 'há ' + Math.floor(s / 86400) + ' d';
        }
        const fmtNum = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.', ',') + 'k' : String(n));
        const semAcento = (s) =>
            String(s || '')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '');

        function resolveCharacterName() {
            const c = ctx();
            if (c.characterId != null && Array.isArray(c.characters) && c.characters[c.characterId]) {
                const nm = c.characters[c.characterId].name;
                if (nm && nm !== 'SillyTavern System' && nm !== 'System') return nm;
            }
            if (c.name2 && c.name2 !== 'SillyTavern System' && c.name2 !== 'System') return c.name2;
            return 'Personagem';
        }
        const personagemAtual = resolveCharacterName; // memória é POR PERSONAGEM (atravessa chats), como na v7
        function stChatIdAtual() {
            return typeof ctx().getCurrentChatId === 'function' ? ctx().getCurrentChatId() || null : null;
        }
        const chatIdParaDisco = () => stChatIdAtual() || 'sem-chat';

        // Ícones: traço fino, pontas arredondadas (família Lucide/Feather), desenhados à mão.
        const IC = {
            plus: 'M12 5v14M5 12h14',
            x: 'M18 6 6 18M6 6l12 12',
            check: 'M5 12.5l4.5 4.5L19 7.5',
            back: 'M15 18l-6-6 6-6',
            next: 'M9 18l6-6-6-6',
            search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>',
            book: 'M3 5.5A1.5 1.5 0 0 1 4.5 4H9c1.7 0 3 1 3 2.6V20c0-1.2-1.2-2-2.6-2H4.5A1.5 1.5 0 0 1 3 16.5zM21 5.5A1.5 1.5 0 0 0 19.5 4H15c-1.7 0-3 1-3 2.6V20c0-1.2 1.2-2 2.6-2h4.9a1.5 1.5 0 0 0 1.5-1.5z',
            chat: 'M20.5 11.5A8 8 0 0 1 9 18.7L4 20l1.4-4.6A8 8 0 1 1 20.5 11.5z',
            panel: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M9.5 4.5v15"/>',
            sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9<circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
            link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
            doc: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
            spark: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16v4M17 18h4',
            eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
            eyeoff: 'M3 3l18 18M10.6 5.2A9.8 9.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.8M6.5 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.5 9.5 0 0 0 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2',
            up: 'M12 19V5M5 12l7-7 7 7',
            trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
            pen: 'M4 20l4-1 11-11-3-3L5 16z',
            copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
            refresh: 'M20 11A8 8 0 0 0 5.6 6.6L4 8M4 4v4h4M4 13a8 8 0 0 0 14.4 4.4L20 16M20 20v-4h-4',
            home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
            layers: 'M12 3l9 5-9 5-9-5zM3 12.5l9 5 9-5M3 17l9 5 9-5',
            list: 'M8 6h12M8 12h12M8 18h12M3.5 6h.01M3.5 12h.01M3.5 18h.01',
            user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
            folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
            star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.7 1-5.9L3.5 9.7l5.9-.8z',
            ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
            play: 'M7 4.5l12 7.5-12 7.5z',
            stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
            wave: 'M5 10v4M9 6v12M13 9v6M17 4v16M21 11v2',
            menu: 'M4 7h16M4 12h16M4 17h16',
            down: 'M6 9l6 6 6-6',
        };
        function ic(nome, tam = 18, extra = '') {
            const d = IC[nome] || '';
            const corpo = d.startsWith('<')
                ? d
                : d.split('<')[0]
                  ? '<path d="' + d.split('<')[0] + '"/>' + (d.includes('<') ? d.slice(d.indexOf('<')) : '')
                  : d;
            return (
                '<svg class="spd-ic ' +
                extra +
                '" width="' +
                tam +
                '" height="' +
                tam +
                '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                corpo +
                '</svg>'
            );
        }

        // ============================================================
        // 02 CONFIG — pequena, em localStorage (a apiKey NUNCA vai pro disco do plugin)
        // ============================================================
        const CFG_KEY = 'spade_config_v6'; // mesma chave da v7: a apiKey do usuário continua valendo
        // 8.9.2 — limite de GERAÇÃO: o tamanho máximo da resposta que a IA do Espaço pode escrever (max_tokens da chamada).
        // NÃO é o orçamento de contexto (limiteGeral / limiteRp / limiteEspaco / limiteBiblioteca), que limita o que a Spade ENVIA.
        const ESP_RESP_TOKENS = { min: 1500, max: 16000, padrao: 8000 };
        const CFG_PADRAO = {
            apiKey: '',
            modelo: 'xiaomi/mimo-v2.6-pro', // "uma IA só" (decisão 1)
            modeloVisao: '', // opcional; vazio = não analisa imagem
            limiteGeral: 8000,
            limiteRp: 3000,
            limiteEspaco: 1500,
            limiteBiblioteca: 3500, // 7.2 — valores iniciais RECOMENDADOS, ajustáveis
            limiteDescricao: 600, // aviso (não corta) na tela da Descrição
            tamanhoNota: 'padrao', // 'curta' | 'padrao' | 'longa' — 8.4 (padrão 120–400 tokens)
            pessoaPensamento: 1, // 11.4 — 1ª, 2ª ou 3ª pessoa
            espacoMaxMensagens: 6, // 12.2
            espacoParaRp: true, // chave geral Espaço→RP
            tiquesCadastrados: [], // 11.2 — "os tiques que enjoei"
            thinkingNosJobs: 'disabled', // 'disabled' | 'enabled' | 'padrao' (não envia o parâmetro) — 14, item 10: NÃO testado
            avisoArquivoTokens: 60000, // 8.1 — acima disso a análise pede confirmação
            estiloModo: 'exemplos', // 8.9.0: 'exemplos' (padrão) | 'desligado'. Antigos 'leve'/'forte' migram para 'exemplos'.
            // 8.9.0 — perfil (dossiê) de UMA personagem, escolhido por chat. Valores iniciais AJUSTÁVEIS, não medidos com o MiMo.
            dossieModo: 'desligado', // 'desligado' | 'hibrido' | 'inteiro'
            dossieLimiteTokens: 60000,
            nucleoLimiteTokens: 1800,
            hibridoTrechosTokens: 2200,
            hibridoMaxTrechos: 4,
            hibridoContextoMsgs: 6,
            modeloNucleo: '', // vazio = usa o modelo das análises
            modoBiblioteca: 'tudo', // 8.3: 'tudo' = todas as notas ativas (por orçamento) · 'cena' = só as que combinam com a cena
            cenaMaxNotas: 4, // 8.3: no modo 'cena', no máximo quantas notas entram além das "sempre incluir" e das regras
            ultimaPasta: null,
            // 8.6.0 — conversa em tempo real (seção 15). Começa DESLIGADO: gasta tokens e precisa de teste no ST do usuário.
            rtLigado: false,
            rtAgressividade: 'baixa', // 'baixa' | 'media' | 'alta'
            rtLeituraPalavrasPorSeg: 2.5, // velocidade do cursor de leitura
            rtEsperaAsteriscoMs: 1400, // espera depois de fechar um bloco *...*
            rtPausaFechaPalavraMs: 700, // quando a última palavra já conta como completa
            rtReproducaoPalavrasPorSeg: 5.5, // velocidade da reprodução no envio
            rtMaxConsultas: 6, // teto de chamadas do decisor por mensagem
            rtFreioMensagens: 2, // depois de cortar, quantas mensagens ficam imunes
            rtGeracaoJunto: true, // a geração do ST começa já no envio (false = só ao fim da reprodução)
            rtIndicadorLeitura: false, // pontinho sutil enquanto a IA "lê" (aparece sempre; nunca revela a decisão)
            // 8.7.0 — Espaço dinâmico (seção 16): a IA do Espaço decide sozinha onde guardar o que o autor conta.
            espacoOrganiza: 'avisar', // 'avisar' (guarda e mostra o cartão) · 'perguntar' (cartão com Guardar/Ignorar) · 'desligado' (= 8.6.0)
            nomeDasFichas: 'Fichas', // nome da pasta padrão e do rótulo; trocar NÃO mexe no que já foi criado (acha-se por origem)
            fichasMaxPorResposta: 3,
            fichasMaxPastasAuto: 6,
            fichasMaxArquivosAuto: 40,
            espacoMaxTokensResposta: 8000, // 8.9.2: máx. de tokens da RESPOSTA da IA do Espaço (geração; era 1500 fixo no código). Não confundir com limiteEspaco (contexto).
        };
        const CFG_REMOVIDOS = [
            'modeloEmbed',
            'cooldownOciosoMs',
            'decayDiasMin',
            'maxIteracoesAgente',
            'modeloRapido',
            'modeloConstrutor',
        ]; // somem do que é salvo (15.3 / 7.4)
        function getConfig() {
            let cfg = {};
            try {
                cfg = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
            } catch (_) {
                cfg = {};
            }
            if (!cfg.modelo && cfg.modeloEscritor) cfg.modelo = cfg.modeloEscritor; // 15.3: modeloEscritor → modelo
            if (cfg.estiloModo === 'leve' || cfg.estiloModo === 'forte') cfg.estiloModo = 'exemplos'; // 8.9.0
            return Object.assign({}, CFG_PADRAO, cfg);
        }
        function setConfig(patch) {
            const base = getConfig();
            const prox = Object.assign(base, patch);
            CFG_REMOVIDOS.forEach((k) => delete prox[k]);
            delete prox.modeloEscritor;
            localStorage.setItem(CFG_KEY, JSON.stringify(prox));
            return prox;
        }
        // 8.9.2 — sempre dentro de [1500, 16000]; valor ausente, inválido ou apagado volta ao padrão (8000)
        function maxTokensRespostaEspaco() {
            const n = Math.round(Number(getConfig().espacoMaxTokensResposta));
            if (!Number.isFinite(n) || n <= 0) return ESP_RESP_TOKENS.padrao;
            return Math.min(ESP_RESP_TOKENS.max, Math.max(ESP_RESP_TOKENS.min, n));
        }

        // Tipos de arquivo: 4 fixos (cores medidas nas imagens) + os que o usuário criar (índice da Biblioteca).
        const TIPOS_BASE = [
            { id: 'tom', nome: 'tom', cor: '#a99cff', icone: 'wave', base: true },
            { id: 'lore', nome: 'lore', cor: '#e2b873', icone: 'book', base: true },
            { id: 'regra', nome: 'regra', cor: '#6fcfbc', icone: 'check', base: true }, // `regra` tem significado especial (8.6)
            { id: 'documento', nome: 'documento', cor: '#8fb4ee', icone: 'lines', base: true },
            { id: 'dossie', nome: 'dossiê', cor: '#f0a6c0', icone: 'user', base: true }, // 8.9.0: perfil de personagem; fora da Biblioteca comum
        ];
        const CORES_PASTA = ['#f6bace', '#9498b0', '#f6f6f8', '#c4c6d2', '#a99cff', '#e2b873', '#6fcfbc', '#8fb4ee'];
        const EXTENSOES_TEXTO = ['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.yaml', '.yml', '.log'];

        // ============================================================
        // 03 ARMAZENAMENTO
        // Disco (plugin spade-fs) é a fonte da verdade; o navegador (IndexedDB) é só RESERVA quando o plugin não
        // responde — e quando isso acontece a tela mostra uma faixa (16.4). Nunca finge que salvou no disco.
        // ============================================================
        const IDB_NAME = 'spade_db_v6'; // mesmo banco da v7: o histórico do Espaço e os dados antigos continuam lá, intocados
        const IDB_VERSION = 2;
        let _idb = null;
        function idb() {
            if (_idb) return _idb;
            _idb = new Promise((resolve, reject) => {
                const req = indexedDB.open(IDB_NAME, IDB_VERSION);
                req.onupgradeneeded = () => {
                    // só roda em instalação nova ou banco muito velho; nunca mexe em store que já existe
                    const db = req.result;
                    if (!db.objectStoreNames.contains('estado')) db.createObjectStore('estado', { keyPath: 'chave' });
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            return _idb;
        }
        const idbReq = (r) =>
            new Promise((res, rej) => {
                r.onsuccess = () => res(r.result);
                r.onerror = () => rej(r.error);
            });
        async function idbStore(nome, modo) {
            const db = await idb();
            return db.transaction(nome, modo).objectStore(nome);
        }
        async function idbGet(loja, chave) {
            return idbReq((await idbStore(loja, 'readonly')).get(chave));
        }
        async function idbPut(loja, obj) {
            return idbReq((await idbStore(loja, 'readwrite')).put(obj));
        }
        async function idbDel(loja, chave) {
            return idbReq((await idbStore(loja, 'readwrite')).delete(chave));
        }
        async function idbAll(loja) {
            return idbReq((await idbStore(loja, 'readonly')).getAll());
        }
        // 'estado': chave = '<personagem>:<campo>' (formato da v7, preservado: espacoChats, espacoHistory:<id>)
        async function estadoGet(campo, padrao) {
            const r = await idbGet('estado', personagemAtual() + ':' + campo);
            return r ? r.valor : padrao;
        }
        async function estadoSet(campo, valor) {
            await idbPut('estado', { chave: personagemAtual() + ':' + campo, valor });
            return valor;
        }
        async function estadoDel(campo) {
            await idbDel('estado', personagemAtual() + ':' + campo);
        }
        // reserva v8: chaves 'v8|...' no mesmo store
        const locGet = async (k) => {
            const r = await idbGet('estado', 'v8|' + k);
            return r ? r.valor : undefined;
        };
        const locSet = (k, valor) => idbPut('estado', { chave: 'v8|' + k, valor });
        const locDel = (k) => idbDel('estado', 'v8|' + k);
        const locLista = async (prefixo) =>
            (await idbAll('estado'))
                .filter((r) => r.chave.startsWith('v8|' + prefixo))
                .map((r) => ({ chave: r.chave.slice(3), valor: r.valor }));

        // ---- plugin ----
        const FS_BASE = '/api/plugins/spade-fs';
        const Plug = { ok: null, versao: null, alertas: [], erro: null }; // ok: null = ainda não checou
        async function chamarFs(caminho, corpo, metodo = 'POST') {
            const headers = Object.assign({ 'Content-Type': 'application/json' }, ctx().getRequestHeaders?.() || {}); // CSRF do ST
            let resp;
            try {
                resp = await fetch(
                    FS_BASE + caminho,
                    metodo === 'GET'
                        ? { method: 'GET', headers }
                        : { method: 'POST', headers, body: JSON.stringify(corpo || {}) }
                );
            } catch (e) {
                const er = new Error('o plugin spade-fs não respondeu: ' + e.message);
                er.semPlugin = true;
                throw er;
            }
            let data = {};
            try {
                data = await resp.json();
            } catch (_) {
                /* corpo vazio */
            }
            if (resp.status === 404 && !data.erro) {
                const er = new Error(
                    'plugin spade-fs não encontrado (está em plugins/ e o SillyTavern foi reiniciado?)'
                );
                er.semPlugin = true;
                throw er;
            }
            if (!resp.ok) {
                const er = new Error(data.erro || 'spade-fs devolveu ' + resp.status);
                er.status = resp.status;
                er.conflito = !!data.conflito;
                er.atual = data.atual;
                er.jaExiste = !!data.jaExiste;
                throw er;
            }
            return data;
        }
        async function checarPlugin() {
            try {
                const d = await chamarFs('/saude', null, 'GET');
                Plug.ok = true;
                Plug.versao = d.versao;
                Plug.alertas = d.alertas || [];
                Plug.erro = null;
            } catch (e) {
                Plug.ok = false;
                Plug.erro = e.message;
            }
            return Plug.ok;
        }
        // Tenta o plugin; se ele estiver fora do ar, cai na reserva do navegador e marca a faixa de aviso.
        async function io(viaPlugin, viaLocal) {
            if (Plug.ok !== false) {
                try {
                    return await viaPlugin();
                } catch (e) {
                    if (!e.semPlugin) throw e;
                    Plug.ok = false;
                    Plug.erro = e.message;
                    avisarUI();
                }
            }
            return viaLocal();
        }
        let avisarUI = () => {}; // a interface troca isto (faixa "sem plugin")
        const P = () => personagemAtual();

        const Disco = {
            async indiceLer() {
                return io(
                    async () => {
                        const d = await chamarFs('/biblioteca/indice/ler', { personagem: P() });
                        return { conteudo: d.conteudo, versao: d.versao };
                    },
                    async () => ({ conteudo: (await locGet('indice|' + P())) || null, versao: null })
                );
            },
            async indiceEscrever(c, versao) {
                return io(
                    async () => ({
                        versao: (
                            await chamarFs('/biblioteca/indice/escrever', {
                                personagem: P(),
                                conteudo: c,
                                ifVersion: versao,
                            })
                        ).versao,
                    }),
                    async () => {
                        await locSet('indice|' + P(), c);
                        return { versao: null };
                    }
                );
            },
            async arqListar() {
                return io(
                    async () => (await chamarFs('/biblioteca/arquivo/listar', { personagem: P() })).arquivos,
                    async () =>
                        (await locLista('arq|' + P() + '|'))
                            .filter((r) => r.chave.endsWith('|meta'))
                            .map((r) => {
                                const id = r.chave.split('|')[2];
                                return { id, meta: r.valor, versaoMeta: null, nota: null, versaoNota: null };
                            })
                ); // as notas locais são lidas abaixo
            },
            async arqCriar({ id, original, extensao, meta }) {
                return io(
                    async () => {
                        const d = await chamarFs('/biblioteca/arquivo/criar', {
                            personagem: P(),
                            id,
                            original,
                            extensao,
                            meta,
                        });
                        return { meta: d.meta, versaoMeta: d.versaoMeta };
                    },
                    async () => {
                        const k = 'arq|' + P() + '|' + id + '|';
                        if (await locGet(k + 'meta')) {
                            const er = new Error('esse arquivo já existe.');
                            er.jaExiste = true;
                            throw er;
                        }
                        const m = Object.assign({}, meta, { id, extensao, chars: original.length });
                        await locSet(k + 'original', original);
                        await locSet(k + 'meta', m);
                        return { meta: m, versaoMeta: null };
                    }
                );
            },
            async arqLer(id, partes) {
                return io(
                    async () => {
                        const d = await chamarFs('/biblioteca/arquivo/ler', { personagem: P(), id, partes });
                        return d;
                    },
                    async () => {
                        const k = 'arq|' + P() + '|' + id + '|';
                        const o = { versoes: {} };
                        if (partes.includes('meta')) o.meta = await locGet(k + 'meta');
                        if (partes.includes('nota')) o.nota = (await locGet(k + 'nota')) || null;
                        if (partes.includes('original')) o.original = await locGet(k + 'original');
                        return o;
                    }
                );
            },
            async arqMeta(id, meta, versao) {
                return io(
                    async () => ({
                        versao: (
                            await chamarFs('/biblioteca/arquivo/meta', { personagem: P(), id, meta, ifVersion: versao })
                        ).versao,
                    }),
                    async () => {
                        await locSet('arq|' + P() + '|' + id + '|meta', meta);
                        return { versao: null };
                    }
                );
            },
            async arqNota(id, nota, versao) {
                return io(
                    async () => ({
                        versao: (
                            await chamarFs('/biblioteca/arquivo/nota', { personagem: P(), id, nota, ifVersion: versao })
                        ).versao,
                    }),
                    async () => {
                        await locSet('arq|' + P() + '|' + id + '|nota', nota);
                        return { versao: null };
                    }
                );
            },
            async arqOriginal(id, original, versao) {
                return io(
                    async () => ({
                        versao: (
                            await chamarFs('/biblioteca/arquivo/original', {
                                personagem: P(),
                                id,
                                original,
                                ifVersion: versao,
                            })
                        ).versao,
                    }),
                    async () => {
                        await locSet('arq|' + P() + '|' + id + '|original', original);
                        return { versao: null };
                    }
                );
            },
            async arqApagar(id) {
                return io(
                    () => chamarFs('/biblioteca/arquivo/apagar', { personagem: P(), id }),
                    async () => {
                        for (const s of ['meta', 'nota', 'original']) await locDel('arq|' + P() + '|' + id + '|' + s);
                        return {};
                    }
                );
            },
            async memLer(chatId, nome) {
                return io(
                    async () => {
                        const d = await chamarFs('/memoria/ler', { personagem: P(), chatId, nome });
                        return { conteudo: d.conteudo, versao: d.versao };
                    },
                    async () => ({
                        conteudo:
                            (await locGet('mem|' + P() + '|' + (nome === 'conexoes' ? '' : chatId) + '|' + nome)) ||
                            null,
                        versao: null,
                    })
                );
            },
            async memEscrever(chatId, nome, conteudo, versao) {
                return io(
                    async () => ({
                        versao: (
                            await chamarFs('/memoria/escrever', {
                                personagem: P(),
                                chatId,
                                nome,
                                conteudo,
                                ifVersion: versao,
                            })
                        ).versao,
                    }),
                    async () => {
                        await locSet('mem|' + P() + '|' + (nome === 'conexoes' ? '' : chatId) + '|' + nome, conteudo);
                        return { versao: null };
                    }
                );
            },
            async descLer() {
                return io(
                    async () => {
                        const d = await chamarFs('/descricao/ler', { personagem: P() });
                        return { conteudo: d.conteudo, versao: d.versao };
                    },
                    async () => ({ conteudo: (await locGet('desc|' + P())) || null, versao: null })
                );
            },
            async descEscrever(c, versao) {
                return io(
                    async () => ({
                        versao: (
                            await chamarFs('/descricao/escrever', { personagem: P(), conteudo: c, ifVersion: versao })
                        ).versao,
                    }),
                    async () => {
                        await locSet('desc|' + P(), c);
                        return { versao: null };
                    }
                );
            },
        };
        // Na reserva do navegador a listagem precisa trazer as notas também (o plugin já devolve junto).
        const _arqListarOriginal = Disco.arqListar;
        Disco.arqListar = async function () {
            const lista = await _arqListarOriginal.call(Disco);
            if (Plug.ok === false)
                for (const a of lista) a.nota = (await locGet('arq|' + P() + '|' + a.id + '|nota')) || null;
            return lista;
        };

        // Controle de versão otimista na ponta do navegador: se outra aba mudou o arquivo, o plugin devolve 409
        // e a tela recarrega — nunca sobrescreve em silêncio.
        function avisoConflito(e) {
            return e && e.conflito
                ? 'Outra aba mudou isto depois que você abriu. Recarreguei o que está no disco — refaça a edição.'
                : null;
        }

        // ============================================================
        // 04 BIBLIOTECA — pastas, arquivos, notas, grupos e a seleção por orçamento (8.2 a 8.6)
        // Regra de ouro (8.1): o arquivo ORIGINAL nunca entra no prompt; só a NOTA.
        // ============================================================
        const Bib = { carregada: false, personagem: null, indice: null, versaoIndice: null, arquivos: new Map() };
        const indicePadrao = () => ({
            versaoEsquema: 8,
            pastas: [{ id: 'entrada', nome: 'Entrada', ordem: 0, cor: CORES_PASTA[0] }],
            grupos: [],
            tipos: [],
            ordem: {},
            tagGatilhos: {}, // 8.5: por tag, as palavras que mostram que a CENA é desse tipo ({ lista: [], removidos: [] })
        });
        function normalizarArquivo(a) {
            const m = a.meta || {};
            a.meta = Object.assign(
                {
                    nome: 'sem nome',
                    pastaId: 'entrada',
                    tipo: 'documento',
                    estado: 'novo',
                    explicacoes: [],
                    observacao: '',
                    observacaoVisivelParaIA: true,
                    prioridade: 'media',
                    sempreAtivo: false,
                    ativo: true,
                    grupoId: null,
                    ligacoes: [],
                    escopo: 'personagem',
                    usarComoEstilo: false,
                    enviadoEm: Date.now(),
                },
                m
            );
            return a;
        }
        async function bibCarregar(forcar) {
            const p = P();
            if (Bib.carregada && Bib.personagem === p && !forcar) return;
            const r = await Disco.indiceLer();
            Bib.indice = Object.assign(indicePadrao(), r.conteudo || {});
            Bib.versaoIndice = r.versao;
            Bib.arquivos = new Map((await Disco.arqListar()).map((a) => [a.id, normalizarArquivo(a)]));
            Bib.personagem = p;
            Bib.carregada = true;
            if (!r.conteudo) await bibSalvarIndice();
        }
        async function bibSalvarIndice() {
            try {
                Bib.versaoIndice = (await Disco.indiceEscrever(Bib.indice, Bib.versaoIndice)).versao;
            } catch (e) {
                if (e.conflito) {
                    await bibCarregar(true);
                    throw new Error(avisoConflito(e));
                }
                throw e;
            }
            sincronizarSoon();
        }
        const tiposTodos = () => TIPOS_BASE.filter((t) => t.id !== 'dossie').concat(Bib.indice ? Bib.indice.tipos : []); // dossiê não aparece nos seletores comuns
        const tipoInfo = (id) => TIPOS_BASE.concat(Bib.indice ? Bib.indice.tipos : []).find((t) => t.id === id) || TIPOS_BASE[3];
        const pastaInfo = (id) => (Bib.indice ? Bib.indice.pastas : []).find((p) => p.id === id);
        const listaArquivos = () => Array.from(Bib.arquivos.values()).filter((a) => !a.meta || a.meta.tipo !== 'dossie'); // 8.9.0: dossiê nunca entra em notas/análises/organizar
        async function salvarMetaArq(a) {
            try {
                a.versaoMeta = (await Disco.arqMeta(a.id, a.meta, a.versaoMeta)).versao;
            } catch (e) {
                if (e.conflito) {
                    await recarregarArq(a.id);
                    throw new Error(avisoConflito(e));
                }
                throw e;
            }
            sincronizarSoon();
        }
        async function salvarNotaArq(a) {
            try {
                a.versaoNota = (await Disco.arqNota(a.id, a.nota, a.versaoNota)).versao;
            } catch (e) {
                if (e.conflito) {
                    await recarregarArq(a.id);
                    throw new Error(avisoConflito(e));
                }
                throw e;
            }
            sincronizarSoon();
        }
        async function recarregarArq(id) {
            const d = await Disco.arqLer(id, ['meta', 'nota']);
            const a = Bib.arquivos.get(id) || { id };
            a.meta = d.meta;
            a.nota = d.nota;
            a.versaoMeta = d.versoes.meta;
            a.versaoNota = d.versoes.nota;
            Bib.arquivos.set(id, normalizarArquivo(a));
        }
        async function criarArquivo({ nome, texto, pastaId, explicacao, tipo, escopo, importado, id, extra }) {
            const ext = (nome.match(/\.([a-z0-9]{1,8})$/i) || [, 'txt'])[1].toLowerCase();
            const meta = Object.assign(
                {
                    nome,
                    pastaId: pastaId || Bib.indice.pastas[0].id,
                    tipo: tipo || 'documento',
                    tipoOriginal: ext,
                    estado: 'novo',
                    explicacoes: explicacao ? [{ id: newId('e'), texto: explicacao, criadoEm: Date.now() }] : [],
                    enviadoEm: Date.now(),
                    escopo: escopo || 'personagem',
                    importado: !!importado,
                    editadoEm: Date.now(),
                },
                extra || {}
            );
            const r = await Disco.arqCriar({ id: id || newId('a'), original: texto, extensao: ext, meta });
            const a = normalizarArquivo({
                id: r.meta.id,
                meta: r.meta,
                versaoMeta: r.versaoMeta,
                nota: null,
                versaoNota: null,
            });
            Bib.arquivos.set(a.id, a);
            sincronizarSoon();
            return a;
        }
        async function apagarArquivo(a) {
            await Disco.arqApagar(a.id);
            Bib.arquivos.delete(a.id);
            Bib.indice.grupos.forEach((g) => {
                g.arquivoIds = g.arquivoIds.filter((x) => x !== a.id);
            });
            await bibSalvarIndice();
        }
        // 'desatualizado' = o usuário mudou Explicação/Observação/arquivo depois da última análise. NÃO reanalisa sozinho (custa token).
        function estadoEfetivo(a) {
            const m = a.meta;
            if (m.estado === 'analisando' || m.estado === 'erro') return m.estado;
            if (a.nota)
                return (m.editadoEm || 0) > (m.analisadoEm || 0) + 1000 && m.analisadoEm ? 'desatualizado' : 'pronto';
            return 'novo';
        }
        // Pastas e grupos
        async function criarPasta(nome, cor, extra) {
            const p = {
                id: newId('p'),
                nome: nome.trim() || 'Pasta',
                ordem: Bib.indice.pastas.length,
                cor: cor || CORES_PASTA[Bib.indice.pastas.length % CORES_PASTA.length],
            };
            if (extra) Object.assign(p, extra); // 8.7.0: { origem: 'espaco' } marca a pasta criada pelo Espaço
            Bib.indice.pastas.push(p);
            await bibSalvarIndice();
            return p;
        }
        async function mudarPasta(id, patch) {
            Object.assign(pastaInfo(id), patch);
            await bibSalvarIndice();
        }
        async function apagarPasta(id) {
            const resto = Bib.indice.pastas.filter((p) => p.id !== id);
            if (!resto.length) throw new Error('É preciso ter pelo menos uma pasta.');
            for (const a of listaArquivos().filter((x) => x.meta.pastaId === id)) {
                a.meta.pastaId = resto[0].id;
                await salvarMetaArq(a);
            } // arquivos nunca somem junto com a pasta: vão pra primeira que sobrar
            Bib.indice.pastas = resto;
            await bibSalvarIndice();
        }
        async function criarTipo(nome, cor) {
            const id =
                't-' +
                semAcento(nome)
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-|-$/g, '');
            if (!id || tiposTodos().some((t) => t.id === id)) throw new Error('Já existe um tipo com esse nome.');
            Bib.indice.tipos.push({ id, nome: nome.trim(), cor: cor || '#c4c6d2', icone: 'lines' });
            await bibSalvarIndice();
            return id;
        }
        async function ligarGrupo(ids, nome) {
            const g = { id: newId('g'), nome: nome || 'Grupo', arquivoIds: ids.slice(), nota: null };
            Bib.indice.grupos.push(g);
            ids.forEach((id) => {
                const a = Bib.arquivos.get(id);
                if (a) a.meta.grupoId = g.id;
            });
            await bibSalvarIndice();
            for (const id of ids) {
                const a = Bib.arquivos.get(id);
                if (a) await salvarMetaArq(a);
            }
            return g;
        }
        async function desfazerGrupo(gid) {
            const g = Bib.indice.grupos.find((x) => x.id === gid);
            if (!g) return;
            for (const id of g.arquivoIds) {
                const a = Bib.arquivos.get(id);
                if (a) {
                    a.meta.grupoId = null;
                    await salvarMetaArq(a);
                }
            }
            Bib.indice.grupos = Bib.indice.grupos.filter((x) => x.id !== gid);
            await bibSalvarIndice();
        }

        // ---- formato do item no prompt (9.2): "### título" + linhas curtas "- ..." ----
        function linhasCurtas(texto) {
            return String(texto || '')
                .split(/\r?\n/)
                .map((l) => l.replace(/^\s*(?:[-•*]|\d+[.)])\s+/, '').trim())
                .filter(Boolean)
                .map((l) => '- ' + l);
        }
        const formatarItem = (titulo, texto) => '### ' + titulo + (texto ? '\n' + linhasCurtas(texto).join('\n') : '');

        // ---- 8.4 TAGS: a IA escolhe ao analisar (reaproveitando as que já existem); você pode tirar e pôr.
        // Efetivas = tags da IA (nota.tags) − as que você tirou (meta.tagsRemovidas) + as que você pôs (meta.tagsUsuario).
        // Reanalisar renova as da IA e NUNCA desfaz o que você mexeu.
        const normTag = (t) =>
            String(t || '')
                .toLowerCase()
                .replace(/^#+/, '')
                .replace(/[,;|\n\r]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 24);
        function tagsDe(a) {
            const tira = new Set((a.meta.tagsRemovidas || []).map(normTag));
            const out = [];
            for (const t of ((a.nota && a.nota.tags) || []).concat(a.meta.tagsUsuario || [])) {
                const n = normTag(t);
                if (n && !tira.has(n) && !out.includes(n)) out.push(n);
            }
            return out;
        }
        // tags usadas na Biblioteca, da mais usada pra menos (a IA recebe esta lista pra reaproveitar nomes)
        function tagsDaBiblioteca(max = 30) {
            const c = new Map();
            listaArquivos().forEach((a) => tagsDe(a).forEach((t) => c.set(t, (c.get(t) || 0) + 1)));
            return [...c.entries()]
                .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
                .slice(0, max)
                .map(([t, n]) => ({ tag: t, n }));
        }

        // ---- 8.5 CENA → TAG. Cada tag de situação (intimidade, medo, briga…) tem GATILHOS: palavras que, quando aparecem
        // nas últimas falas, mostram que a cena é daquele tipo. A IA escreve os gatilhos ao analisar (junto das tags),
        // o código traz umas sementes pras tags comuns, e você edita. Reconheceu a cena → os arquivos com a tag entram.
        // Tags de forma (tom, falas, lore, regra…) ficam sem gatilho: não são "tipo de cena".
        const SEMENTES_GATILHOS = {
            intimidade: ['beijo', 'beijar', 'abraço', 'abraçar', 'cama', 'quarto', 'pele', 'toque', 'tocar', 'carícia', 'acariciar', 'sussurrar', 'ofegante', 'desejo', 'nua', 'despir', 'lençol', 'arrepio', 'colo', 'corpo', 'excitação'],
            medo: ['medo', 'pavor', 'assustar', 'susto', 'tremer', 'trovão', 'tempestade', 'escuro', 'pânico', 'apavorada', 'pesadelo', 'gritar'],
            briga: ['briga', 'brigar', 'discussão', 'discutir', 'raiva', 'gritar', 'irritada', 'furiosa', 'bravo', 'berrar', 'xingar'],
            ciúme: ['ciúme', 'ciumenta', 'ciumento', 'traição', 'trair', 'desconfiar', 'possessiva'],
            tristeza: ['chorar', 'choro', 'lágrima', 'triste', 'saudade', 'solidão', 'luto', 'soluçar'],
            família: ['mãe', 'pai', 'irmão', 'irmã', 'avó', 'avô', 'família', 'tio', 'tia', 'filho', 'filha'],
        };
        const normGat = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 40);
        // efetivos = sementes + os da IA/seus − os que você tirou
        function gatilhosDaTag(tag) {
            const g = ((Bib.indice && Bib.indice.tagGatilhos) || {})[tag] || {};
            const tira = new Set((g.removidos || []).map(normGat));
            const out = [];
            for (const w of (SEMENTES_GATILHOS[tag] || []).concat(g.lista || [])) {
                const n = normGat(w);
                if (n && !tira.has(n) && !out.includes(n)) out.push(n);
            }
            return out;
        }
        // a IA devolveu gatilhos: junta aos que já existem (respeitando o que você tirou), no máx. 30 por tag
        async function gatilhosMesclar(porTag) {
            const aplica = () => {
                Bib.indice.tagGatilhos = Bib.indice.tagGatilhos || {};
                for (const [tag, palavras] of Object.entries(porTag)) {
                    const g = Bib.indice.tagGatilhos[tag] || { lista: [], removidos: [] };
                    const tira = new Set((g.removidos || []).map(normGat));
                    const lista = (g.lista || []).slice();
                    for (const w of palavras) {
                        const n = normGat(w);
                        if (n && !tira.has(n) && !lista.map(normGat).includes(n)) lista.push(n);
                    }
                    Bib.indice.tagGatilhos[tag] = { lista: lista.slice(0, 30), removidos: g.removidos || [] };
                }
            };
            aplica();
            try {
                await bibSalvarIndice();
            } catch (_) {
                aplica(); // conflito: recarregou do disco; junta de novo e tenta uma vez
                await bibSalvarIndice();
            }
        }
        const CENA_TAG_MIN = 1.5; // pontuação mínima pra reconhecer o tipo da cena (2 gatilhos na última fala, ou 1 nela + 1 na anterior)
        const CENA_TAGS_MAX = 2; // no máx. quantos tipos de cena ao mesmo tempo
        const CENA_TAG_HITS_POR_FALA = 3; // gatilhos além de 3 numa mesma fala não somam mais
        // Reconhece o tipo da cena: pra cada tag que existe nas notas elegíveis, conta os gatilhos nas últimas falas
        // (mesmos pesos da busca) e nos pedidos recentes do Espaço. Só código, sem IA.
        function tagsDaCena(itens, substituicao) {
            const tags = new Set();
            itens.forEach((it) => (it.tags || []).forEach((t) => tags.add(t)));
            if (!tags.size) return [];
            const msgs = chatRealRecente(8, 600);
            if (substituicao && msgs.length && !msgs[msgs.length - 1].ehUsuario) msgs.pop();
            const fontes = msgs
                .slice(-CENA_MSGS)
                .reverse()
                .map((m, i) => ({ raizes: new Set(raizesDe(m.texto)), peso: CENA_PESOS[i] }))
                .concat(
                    espacoPedidosRecentes()
                        .slice(-3)
                        .map((m) => ({ raizes: new Set(raizesDe(m.texto)), peso: CENA_PESO_PEDIDO }))
                );
            const out = [];
            for (const tag of tags) {
                const gat = new Map(); // raiz → palavra do gatilho
                for (const g of gatilhosDaTag(tag)) for (const r of raizesDe(g)) if (!gat.has(r)) gat.set(r, g);
                if (!gat.size) continue;
                let score = 0;
                const achados = new Set();
                for (const f of fontes) {
                    let hits = 0;
                    for (const [r, g] of gat)
                        if (f.raizes.has(r)) {
                            hits++;
                            achados.add(g);
                        }
                    score += Math.min(hits, CENA_TAG_HITS_POR_FALA) * f.peso;
                }
                if (score >= CENA_TAG_MIN) out.push({ tag, score, gatilhos: [...achados].slice(0, 6) });
            }
            return out.sort((x, y) => y.score - x.score || x.tag.localeCompare(y.tag)).slice(0, CENA_TAGS_MAX);
        }

        // ---- itens elegíveis: arquivos ativos com nota REVISADA; grupo com nota própria representa os membros (8.5, passo 1) ----
        function itensDaBiblioteca() {
            const prio = { alta: 0, media: 1, baixa: 2 };
            const ordemPasta = new Map(Bib.indice.pastas.map((p) => [p.id, p.ordem]));
            const lista = [];
            const emGrupo = new Set();
            for (const g of Bib.indice.grupos) {
                const membros = g.arquivoIds
                    .map((id) => Bib.arquivos.get(id))
                    .filter(Boolean)
                    .filter((a) => a.meta.ativo);
                if (g.nota && g.nota.revisada !== false && (g.nota.completa || g.nota.minima) && membros.length) {
                    membros.forEach((a) => emGrupo.add(a.id));
                    const melhor = membros.slice().sort((x, y) => prio[x.meta.prioridade] - prio[y.meta.prioridade])[0];
                    lista.push({
                        chave: 'g:' + g.id,
                        titulo: g.nome,
                        tipo: melhor.meta.tipo,
                        pastaOrdem: ordemPasta.get(melhor.meta.pastaId) ?? 99,
                        ordemManual: 0,
                        prioridade: melhor.meta.prioridade,
                        sempreAtivo: membros.some((a) => a.meta.sempreAtivo),
                        completa: g.nota.completa || g.nota.minima,
                        minima: g.nota.minima || '',
                        palavras: (g.nota.palavrasChave || []).concat(
                            ...membros.map((a) => (a.nota && a.nota.palavrasChave) || [])
                        ),
                        tags: [...new Set([].concat(...membros.map(tagsDe)))],
                        id: g.id,
                    });
                }
            }
            for (const a of listaArquivos()) {
                if (!a.meta.ativo || emGrupo.has(a.id) || !a.nota || a.nota.revisada === false) continue;
                const ord = (Bib.indice.ordem[a.meta.pastaId] || []).indexOf(a.id);
                lista.push({
                    chave: 'a:' + a.id,
                    titulo: a.meta.titulo || a.meta.nome.replace(/\.[a-z0-9]+$/i, ''),
                    tipo: a.meta.tipo,
                    pastaOrdem: ordemPasta.get(a.meta.pastaId) ?? 99,
                    ordemManual: ord < 0 ? 9999 : ord,
                    prioridade: a.meta.prioridade,
                    sempreAtivo: a.meta.sempreAtivo,
                    completa: a.nota.completa || a.nota.minima || '',
                    minima: a.nota.minima || '',
                    palavras: a.nota.palavrasChave || [],
                    tags: tagsDe(a),
                    id: a.id,
                });
            }
            return lista;
        }
        const textoDoItem = (it, modo) => (modo === 'completa' ? it.completa : modo === 'minima' ? it.minima : '');
        // 8.5: passada 1 = a mínima de TODOS (a IA sabe que cada coisa existe); passada 2 = sobe pra completa enquanto couber.
        // Item sem mínima entra só como título (1 linha). Nada é cortado no meio: o que não couber fica FORA e aparece na tela.
        function selecionarNotas(itens, orcamento) {
            const prio = { alta: 0, media: 1, baixa: 2 };
            const ordem = itens
                .slice()
                .sort(
                    (x, y) =>
                        y.sempreAtivo - x.sempreAtivo ||
                        prio[x.prioridade] - prio[y.prioridade] ||
                        x.pastaOrdem - y.pastaOrdem ||
                        x.ordemManual - y.ordemManual ||
                        String(x.id).localeCompare(String(y.id))
                );
            const modo = new Map();
            let usado = 0;
            const custo = (it, m) => estimarTokens(formatarItem(it.titulo, textoDoItem(it, m))) + 1;
            for (const it of ordem) {
                const m = it.minima ? 'minima' : 'titulo';
                const c = custo(it, m);
                if (usado + c <= orcamento) {
                    modo.set(it.chave, m);
                    usado += c;
                } else modo.set(it.chave, null);
            }
            for (const it of ordem) {
                const atual = modo.get(it.chave);
                if (!atual || !it.completa || atual === 'completa') continue;
                const delta = custo(it, 'completa') - custo(it, atual);
                if (usado + delta <= orcamento) {
                    modo.set(it.chave, 'completa');
                    usado += delta;
                }
            }
            const tiposOrdem = tiposTodos().map((t) => t.id);
            const rank = (t) => (t === 'regra' ? -1 : tiposOrdem.indexOf(t));
            const escolhidos = ordem
                .filter((it) => modo.get(it.chave))
                .sort(
                    (x, y) =>
                        rank(x.tipo) - rank(y.tipo) ||
                        x.pastaOrdem - y.pastaOrdem ||
                        x.ordemManual - y.ordemManual ||
                        String(x.id).localeCompare(String(y.id))
                ) // ordem de saída ESTÁVEL (8.5, passo 5)
                .map((it) => ({
                    it,
                    modo: modo.get(it.chave),
                    texto: formatarItem(it.titulo, textoDoItem(it, modo.get(it.chave))),
                }));
            const fora = ordem
                .filter((it) => !modo.get(it.chave))
                .map((it) => ({ it, motivo: 'não coube nem como nota mínima' }));
            return { escolhidos, fora, usado };
        }

        // ---- 8.3 MODO "POR CENA": a bibliotecária. Só código, sem IA e sem espera, e só nas NOTAS (nunca no arquivo original).
        // Núcleo fixo (sempre incluir + regras) fica no bloco 3 (estável). O resto só entra, no bloco "NOTAS DA CENA"
        // (volátil), se combinar com as últimas falas do chat e com os pedidos recentes do Espaço.
        const CENA_MSGS = 4; // quantas falas recentes formam a "cena"
        const CENA_PESOS = [1, 0.7, 0.5, 0.35]; // a mais recente pesa mais
        const CENA_CORTE = 0.35; // só entra nota com pelo menos 35% da pontuação da melhor
        const CENA_PESO_PEDIDO = 0.8; // peso de cada pedido recente do Espaço (os 3 últimos)
        const raizesDe = (texto) => {
            const out = [];
            for (const w of words(texto)) {
                if (w.length < 3 || /^\d+$/.test(w) || ehStop(w)) continue;
                out.push(radicalPtBr(w));
            }
            return out;
        };
        // Consulta = raízes das últimas falas (pesos decrescentes) + pedidos recentes do Espaço. Cada palavra conta 1x por fala.
        function consultaDaCena(substituicao) {
            const msgs = chatRealRecente(8, 600);
            // regenerar/swipe: a fala que está sendo trocada não faz parte da cena
            if (substituicao && msgs.length && !msgs[msgs.length - 1].ehUsuario) msgs.pop();
            const q = new Map();
            const soma = (texto, peso) => {
                for (const r of new Set(raizesDe(texto))) q.set(r, (q.get(r) || 0) + peso);
            };
            msgs.slice(-CENA_MSGS)
                .reverse()
                .forEach((m, i) => soma(m.texto, CENA_PESOS[i]));
            espacoPedidosRecentes()
                .slice(-3)
                .forEach((m) => soma(m.texto, CENA_PESO_PEDIDO));
            return q;
        }
        // BM25 simplificado: raridade da palavra entre as notas × frequência na nota. Título e palavras-chave pesam 3x.
        function pontuarNotas(itens, q) {
            const docs = itens.map((it) => {
                const tf = new Map();
                let len = 0;
                const add = (txt, peso) => {
                    for (const r of raizesDe(txt)) {
                        tf.set(r, (tf.get(r) || 0) + peso);
                        len += peso;
                    }
                };
                add(it.titulo, 3);
                add((it.palavras || []).join(' '), 3);
                add((it.tags || []).join(' '), 3);
                add(it.minima, 1);
                add(it.completa, 1);
                return { it, tf, len: Math.max(1, len) };
            });
            const N = docs.length;
            const media = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, N);
            const df = new Map();
            docs.forEach((d) => d.tf.forEach((_v, r) => df.set(r, (df.get(r) || 0) + 1)));
            const k1 = 1.2;
            const b = 0.5;
            const prio = { alta: 1.15, media: 1, baixa: 0.85 };
            return docs.map((d) => {
                let score = 0;
                const termos = [];
                q.forEach((peso, r) => {
                    const f = d.tf.get(r);
                    if (!f) return;
                    const n = df.get(r) || 1;
                    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
                    score += peso * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / Math.max(1, media))));
                    termos.push(r);
                });
                return { it: d.it, score: score * (prio[d.it.prioridade] || 1), termos };
            });
        }
        // 8.4 — "chamar pela tag": se um pedido recente seu NO ESPAÇO cita a tag inteira ("usa o de falas"), a nota entra
        // garantida (só pedidos do Espaço contam; a conversa do RP não, porque "tom" e "fala" aparecem em qualquer texto).
        function itensChamadosPorTag(itens) {
            const limpa = (t) => ' ' + semAcento(String(t || '').toLowerCase()).replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + ' ';
            const txt = limpa(
                espacoPedidosRecentes()
                    .slice(-3)
                    .map((m) => m.texto)
                    .join(' . ')
            );
            const out = [];
            for (const it of itens) {
                const achadas = (it.tags || []).filter((t) => limpa(t).trim() && txt.includes(limpa(t)));
                if (achadas.length) out.push({ it, achadas });
            }
            return out;
        }
        function selecionarPorCena(itens, orcamento, opts = {}) {
            const prio = { alta: 0, media: 1, baixa: 2 };
            const maxN = Math.max(1, Math.round(opts.max || 4));
            const nucleo = itens.filter((it) => it.sempreAtivo || it.tipo === 'regra');
            const resto = itens.filter((it) => !nucleo.includes(it));
            const selN = selecionarNotas(nucleo, orcamento);
            const q = consultaDaCena(!!opts.substituicao);
            const pont = pontuarNotas(resto, q)
                .filter((x) => x.score > 0)
                .sort((x, y) => y.score - x.score || String(x.it.id).localeCompare(String(y.it.id)));
            const topo = pont.length ? pont[0].score : 0;
            const chamados = itensChamadosPorTag(resto).map((c) => ({
                it: c.it,
                score: Infinity,
                termos: c.achadas.map((t) => '#' + t),
                chamada: true,
            }));
            const jaChamado = new Set(chamados.map((c) => c.it.chave));
            // 8.5 — o tipo da cena foi reconhecido (ex.: intimidade): os arquivos com essa tag entram, antes da busca por palavra
            const reconhecidas = tagsDaCena(resto, !!opts.substituicao);
            const scoreBusca = new Map(pont.map((x) => [x.it.chave, x.score]));
            const porTag = [];
            for (const r of reconhecidas) {
                resto
                    .filter(
                        (it) =>
                            (it.tags || []).includes(r.tag) &&
                            !jaChamado.has(it.chave) &&
                            !porTag.some((c) => c.it.chave === it.chave)
                    )
                    .sort(
                        (x, y) =>
                            (scoreBusca.get(y.chave) || 0) - (scoreBusca.get(x.chave) || 0) ||
                            prio[x.prioridade] - prio[y.prioridade] ||
                            x.pastaOrdem - y.pastaOrdem ||
                            x.ordemManual - y.ordemManual
                    )
                    .forEach((it) =>
                        porTag.push({ it, score: Infinity, termos: ['#' + r.tag].concat(r.gatilhos), viaTag: r.tag })
                    );
            }
            const jaTag = new Set(porTag.map((c) => c.it.chave));
            const porBusca = pont.filter(
                (x) => x.score >= topo * CENA_CORTE && !jaChamado.has(x.it.chave) && !jaTag.has(x.it.chave)
            );
            // a busca por palavra sempre guarda 1 vaga se tiver candidata (as tags não ocupam tudo)
            const vagasTag = porBusca.length ? Math.max(0, maxN - chamados.length - 1) : maxN;
            let cand = chamados.concat(porTag.slice(0, vagasTag), porBusca).slice(0, maxN);
            let semCasamento = false;
            if (!cand.length) {
                // nada combinou (chat novo, cena curta): entram as de prioridade ALTA, pra personagem nunca ficar "vazia"
                semCasamento = true;
                cand = resto
                    .filter((it) => it.prioridade === 'alta')
                    .sort((x, y) => x.pastaOrdem - y.pastaOrdem || x.ordemManual - y.ordemManual)
                    .slice(0, maxN)
                    .map((it) => ({ it, score: 0, termos: [] }));
            }
            const selC = selecionarNotas(
                cand.map((x) => x.it),
                Math.max(0, orcamento - selN.usado)
            );
            const termosDe = new Map(cand.map((x) => [x.it.chave, x.termos]));
            const viaTagDe = new Map(cand.map((x) => [x.it.chave, x.viaTag || null]));
            const cenaEscolhidos = selC.escolhidos.map((e) => ({
                ...e,
                viaCena: true,
                viaTag: viaTagDe.get(e.it.chave) || null,
                termos: termosDe.get(e.it.chave) || [],
                semCasamento,
            }));
            const usadas = new Set(cand.map((x) => x.it.chave));
            const foraCena = resto
                .filter((it) => !usadas.has(it.chave))
                .sort((x, y) => prio[x.prioridade] - prio[y.prioridade])
                .map((it) => ({ it, motivo: 'não combinou com a cena' }));
            return {
                nucleo: selN,
                escolhidos: selN.escolhidos,
                cenaEscolhidos,
                fora: selN.fora.concat(selC.fora), // só o que não coube no orçamento
                foraCena,
                usado: selN.usado + selC.usado,
                semCasamento,
                tagsReconhecidas: reconhecidas,
            };
        }

        // ============================================================
        // 05 DESCRIÇÃO, MEMÓRIA EM 3 GAVETAS E CONEXÕES
        // ============================================================
        const Desc = { v: null, versao: null, personagem: null };
        const descPadrao = () => ({
            aparencia: '',
            temperamento: '',
            oQueMudaHumor: '',
            exemplosFrios: [],
            comoFala: '',
            oQueSabe: '',
            atualizadoEm: null,
            importadaDoCartaoEm: null,
            textoOriginalImportado: null,
        });
        async function descCarregar(forcar) {
            if (Desc.v && Desc.personagem === P() && !forcar) return Desc.v;
            const r = await Disco.descLer();
            Desc.v = Object.assign(descPadrao(), r.conteudo || {});
            Desc.versao = r.versao;
            Desc.personagem = P();
            return Desc.v;
        }
        async function descSalvar() {
            Desc.v.atualizadoEm = Date.now();
            try {
                Desc.versao = (await Disco.descEscrever(Desc.v, Desc.versao)).versao;
            } catch (e) {
                if (e.conflito) {
                    await descCarregar(true);
                    throw new Error(avisoConflito(e));
                }
                throw e;
            }
            sincronizarSoon();
        }
        const cartaoAtual = () => {
            const c = ctx();
            return c.characterId != null && Array.isArray(c.characters) ? c.characters[c.characterId] : null;
        };
        // 10.1: só UMA descrição pode chegar à IA. Caminho (c)+(a): importa a do cartão UMA vez (guardando o original) e o usuário esvazia o campo no cartão.
        const cartaoTemDescricao = () => {
            const c = cartaoAtual();
            return !!(c && String(c.description || '').trim());
        };
        const cartaoTemOutrosCampos = () => {
            const c = cartaoAtual();
            if (!c) return [];
            return [
                ['Personality', c.personality],
                ['Scenario', c.scenario],
                ['Example Dialogues', c.mes_example],
                ['First Message', c.first_mes],
            ]
                .filter(([, v]) => String(v || '').trim())
                .map(([k]) => k);
        };
        async function descImportarDoCartao() {
            const c = cartaoAtual();
            if (!c || !String(c.description || '').trim()) throw new Error('O cartão não tem descrição pra importar.');
            await descCarregar();
            Desc.v.textoOriginalImportado = c.description;
            Desc.v.importadaDoCartaoEm = Date.now();
            if (!Desc.v.aparencia.trim()) Desc.v.aparencia = c.description;
            else Desc.v.aparencia += '\n' + c.description;
            await descSalvar();
        }
        function blocoDescricao() {
            const d = Desc.v;
            if (!d) return '';
            const partes = [];
            if (d.aparencia.trim()) partes.push(formatarItem('Aparência', d.aparencia));
            const hum = [];
            if (d.temperamento.trim())
                hum.push('Temperamento base: ' + d.temperamento.trim().replace(/\s*\n\s*/g, ' '));
            if (d.oQueMudaHumor.trim())
                hum.push('O que muda o humor dela: ' + d.oQueMudaHumor.trim().replace(/\s*\n\s*/g, ' '));
            const frios = (d.exemplosFrios || []).map((x) => String(x).trim()).filter(Boolean);
            if (frios.length) hum.push('Exemplos dela em momento frio: ' + frios.map((x) => '“' + x + '”').join(' · '));
            if (hum.length) partes.push(formatarItem('Humor e temperamento', hum.join('\n')));
            if (d.comoFala.trim()) partes.push(formatarItem('Como fala', d.comoFala));
            if (d.oQueSabe.trim()) partes.push(formatarItem('O que sabe', d.oQueSabe));
            return partes.length ? '## QUEM ELA É\n' + partes.join('\n') : '';
        }

        // ---- gavetas RP e Espaço (por chat do ST) + conexões (por personagem) ----
        const Mem = {
            chatId: null,
            rp: { fatos: [], ultimoIdx: 0 },
            versaoRp: null,
            espaco: { pedidos: [] },
            versaoEsp: null,
            con: { grupos: [] },
            versaoCon: null,
            vizinhas: [],
            relogio: null,
            versaoRel: null,
        };
        async function memCarregar(forcar) {
            const chat = chatIdParaDisco();
            if (Mem.chatId === chat && Mem.personagem === P() && !forcar) return;
            const [rp, esp, con, rel] = await Promise.all([
                Disco.memLer(chat, 'rp'),
                Disco.memLer(chat, 'espaco'),
                Disco.memLer(chat, 'conexoes'),
                Disco.memLer(chat, 'relogio'),
            ]);
            Mem.chatId = chat;
            Mem.personagem = P();
            Mem.rp = Object.assign({ fatos: [], ultimoIdx: 0 }, rp.conteudo || {});
            Mem.versaoRp = rp.versao;
            Mem.espaco = Object.assign({ pedidos: [] }, esp.conteudo || {});
            Mem.versaoEsp = esp.versao;
            Mem.con = Object.assign({ grupos: [] }, con.conteudo || {});
            Mem.versaoCon = con.versao;
            Mem.versaoRel = rel.versao;
            let relC = rel.conteudo;
            let migrou = false;
            if (!relC) {
                relC = await relMigrarLegado();
                migrou = !!relC;
            } // 12.6: o relógio da v7 (por personagem) vai pro primeiro chat aberto
            Mem.relogio = relNormalizar(relC || { ultimoIdx: (ctx().chat || []).length });
            if (migrou) memSalvar('relogio').catch(relFalha);
            await memCarregarVizinhas();
        }
        async function memSalvar(qual) {
            const chat = Mem.chatId || chatIdParaDisco();
            try {
                if (qual === 'rp') Mem.versaoRp = (await Disco.memEscrever(chat, 'rp', Mem.rp, Mem.versaoRp)).versao;
                else if (qual === 'espaco')
                    Mem.versaoEsp = (await Disco.memEscrever(chat, 'espaco', Mem.espaco, Mem.versaoEsp)).versao;
                else if (qual === 'relogio')
                    Mem.versaoRel = (await Disco.memEscrever(chat, 'relogio', Mem.relogio, Mem.versaoRel)).versao;
                else Mem.versaoCon = (await Disco.memEscrever(chat, 'conexoes', Mem.con, Mem.versaoCon)).versao;
            } catch (e) {
                if (e.conflito) {
                    await memCarregar(true);
                    throw new Error(avisoConflito(e));
                }
                throw e;
            }
            sincronizarSoon();
        }
        const sabeFato = (f) => {
            const n = semAcento(personagemAtual()).toLowerCase();
            return (f.sabem || []).some((x) => {
                const s = semAcento(x).toLowerCase();
                return s === n || s === 'todos' || s === '*';
            });
        };
        // Bloco 4 — só entram os fatos que a personagem SABE (11.1); os outros ficam só na tela. Ordem cronológica estável.
        // Estourou? Entram os mais recentes inteiros (nunca corta no meio); o resto vira "fora do orçamento" na tela.
        function blocoMemoria(orcamento) {
            const proprios = Mem.rp.fatos.filter(sabeFato);
            const vizinhos = Mem.vizinhas
                .map((v) => ({ titulo: v.titulo, fatos: (v.fatos || []).filter(sabeFato) }))
                .filter((v) => v.fatos.length);
            const teto = vizinhos.length ? Math.floor(orcamento * 0.7) : orcamento;
            const caber = (lista, limite) => {
                const dentro = new Set();
                let usado = 0;
                for (const f of lista.slice().reverse()) {
                    const c = estimarTokens('- ' + f.texto) + 1;
                    if (usado + c > limite) continue;
                    dentro.add(f.id);
                    usado += c;
                }
                return { dentro, usado };
            };
            const r = caber(proprios, teto);
            const linhas = [];
            const fora = [];
            proprios.forEach((f) => {
                if (r.dentro.has(f.id)) linhas.push('- ' + f.texto);
                else fora.push({ texto: f.texto, motivo: 'fora do orçamento da memória do RP' });
            });
            let usadoViz = 0;
            const restante = Math.max(0, orcamento - r.usado);
            const fatia = vizinhos.length ? Math.floor(restante / vizinhos.length) : 0;
            const secoes = [];
            if (linhas.length) secoes.push('### O que aconteceu\n' + linhas.join('\n'));
            for (const v of vizinhos) {
                const rv = caber(v.fatos, fatia);
                const ls = v.fatos.filter((f) => rv.dentro.has(f.id)).map((f) => '- ' + f.texto);
                v.fatos
                    .filter((f) => !rv.dentro.has(f.id))
                    .forEach((f) => fora.push({ texto: f.texto, motivo: 'fora do orçamento (chat conectado)' }));
                if (ls.length) {
                    secoes.push('### Em outro chat\n' + ls.join('\n'));
                    usadoViz += rv.usado;
                }
            }
            return {
                texto: secoes.length ? '## MEMÓRIA\n' + secoes.join('\n') : '',
                fora,
                naoSabe: Mem.rp.fatos.filter((f) => !sabeFato(f)),
            };
        }
        // Conexões (12.3): grupos { id, chats:[idDaConversa...] }; uma conversa em no máximo um grupo.
        const grupoDaConversa = (convId) => Mem.con.grupos.find((g) => g.chats.includes(convId));
        async function memCarregarVizinhas() {
            Mem.vizinhas = [];
            try {
                const chats = await obterEspacoChats();
                const atual = chats.find((c) => c.stChatId && c.stChatId === stChatIdAtual());
                const g = atual && grupoDaConversa(atual.id);
                if (!g) return;
                for (const cid of g.chats.filter((x) => x !== atual.id)) {
                    const outra = chats.find((c) => c.id === cid);
                    if (!outra || !outra.stChatId || outra.stChatId === atual.stChatId) continue;
                    const r = await Disco.memLer(outra.stChatId, 'rp');
                    Mem.vizinhas.push({
                        convId: cid,
                        titulo: outra.titulo,
                        fatos: (r.conteudo && r.conteudo.fatos) || [],
                    });
                }
            } catch (e) {
                console.warn('[Spade] vizinhas:', e.message);
            }
        }

        // ============================================================
        // 06 REGRAS PROFISSIONAIS (seção 11): cada regra = parte FIXA (texto curto) + parte MEDIDA pelo código
        // ============================================================
        // Português simples, nenhuma palavra da extensão (9.2). O texto muda quase nunca (prefixo estável, 9.3).
        const REGRAS_ITENS = [
            [
                'Quem sabe o quê',
                'A personagem só sabe o que viveu na cena, o que está na própria descrição e o que o usuário disse ou fez na frente dela.\nNotas do autor não são conhecimento dela.\nNa dúvida, reage com dúvida e não deduz.',
            ],
            [
                'Humor',
                'O humor da personagem muda por fato da cena, nunca por simpatia ao usuário.\nElogio, insistência ou carinho do usuário, sozinhos, não mudam o humor dela.\nSegue o padrão emocional da personagem: nem mais feliz, nem menos.',
            ],
            [
                'Prioridade',
                'O que o usuário disse por último vale mais que as notas.\nEntre as notas, as de regra valem mais que as de referência.',
            ],
            [
                'Estilo',
                'O estilo mostrado define COMO ela soa; a descrição e o temperamento definem O QUE ela diria.\nExemplos de fala são só referência de jeito: nunca copie uma frase deles.',
            ],
        ];
        const blocoRegras = () => '## REGRAS\n' + REGRAS_ITENS.map(([t, x]) => formatarItem(t, x)).join('\n');

        // ---- base de palavras (herdada da v7: medir repetição por radical, sem IA) ----
        const STOPWORDS_PT = new Set([
            'a',
            'o',
            'as',
            'os',
            'de',
            'da',
            'do',
            'das',
            'dos',
            'em',
            'no',
            'na',
            'nos',
            'nas',
            'um',
            'uma',
            'uns',
            'umas',
            'e',
            'é',
            'ou',
            'que',
            'se',
            'com',
            'por',
            'para',
            'pra',
            'pro',
            'como',
            'mais',
            'mas',
            'ao',
            'aos',
            'à',
            'às',
            'sua',
            'seu',
            'suas',
            'seus',
            'isso',
            'esse',
            'essa',
            'este',
            'esta',
            'isto',
            'ele',
            'ela',
            'eles',
            'elas',
            'eu',
            'tu',
            'você',
            'vc',
            'nós',
            'minha',
            'meu',
            'tinha',
            'tem',
            'ter',
            'foi',
            'ser',
            'estar',
            'está',
            'tá',
            'não',
            'sim',
            'já',
            'ainda',
            'também',
            'muito',
            'bem',
            'só',
            'vai',
            'vou',
            'me',
            'te',
            'lhe',
            'the',
            'is',
            'was',
            'sem',
            'até',
            'quando',
            'onde',
            'então',
            'ali',
            'aqui',
            'lá',
            'dela',
            'dele',
            'num',
            'numa',
        ]);
        const SUF_V = [
            'ássemos',
            'êssemos',
            'íssemos',
            'aríamos',
            'eríamos',
            'iríamos',
            'assem',
            'essem',
            'issem',
            'arão',
            'erão',
            'irão',
            'aram',
            'eram',
            'iram',
            'avam',
            'iam',
            'ando',
            'endo',
            'indo',
            'ado',
            'ada',
            'ados',
            'adas',
            'ido',
            'ida',
            'idos',
            'idas',
            'ará',
            'erá',
            'irá',
            'arei',
            'erei',
            'irei',
            'asse',
            'esse',
            'isse',
            'arem',
            'erem',
            'irem',
            'amos',
            'emos',
            'imos',
            'ava',
            'ia',
            'eu',
            'iu',
            'ou',
            'ar',
            'er',
            'ir',
        ];
        const SUF_N = [
            'izações',
            'ização',
            'amentos',
            'amento',
            'imentos',
            'imento',
            'íssimos',
            'íssimas',
            'íssimo',
            'íssima',
            'inhos',
            'inhas',
            'inho',
            'inha',
            'zinhos',
            'zinhas',
            'zinho',
            'zinha',
            'ável',
            'ível',
            'osos',
            'osas',
            'oso',
            'osa',
            'dades',
            'dade',
            'ções',
            'ção',
            'mente',
            'es',
            's',
        ];
        function radicalPtBr(palavra) {
            // stemmer reduzido: une "corre/correu/correndo" na mesma raiz
            let p = semAcento(palavra.toLowerCase());
            if (p.length <= 3) return p;
            for (const s of SUF_V) {
                const q = semAcento(s);
                if (p.endsWith(q) && p.length - q.length >= 3) {
                    p = p.slice(0, -q.length);
                    break;
                }
            }
            for (const s of SUF_N) {
                const q = semAcento(s);
                if (p.endsWith(q) && p.length - q.length >= 3) {
                    p = p.slice(0, -q.length);
                    break;
                }
            }
            if (/[bcdfghjklmnpqrstvxz][eo]$/.test(p) && p.length >= 5) p = p.slice(0, -1);
            return p;
        }
        const words = (t) =>
            String(t || '')
                .toLowerCase()
                .match(/[\p{L}\p{N}]+/gu) || [];
        const ehStop = (w) => STOPWORDS_PT.has(w) || STOPWORDS_PT.has(semAcento(w));

        // ---- chat real (fonte única da verdade: ctx().chat) ----
        function chatRealRecente(n = 12, maxChars = 1200) {
            const arr = ctx().chat;
            if (!Array.isArray(arr) || !arr.length) return [];
            const ini = Math.max(0, arr.length - n);
            return arr
                .slice(ini)
                .map((m, i) => ({
                    idx: ini + i,
                    nome: m.name,
                    ehUsuario: !!m.is_user,
                    ehSistema: !!m.is_system,
                    texto: String(m.mes || '')
                        .trim()
                        .slice(0, maxChars),
                    swipes: Array.isArray(m.swipes) ? m.swipes.map((s) => String(s || '').slice(0, maxChars)) : [],
                }))
                .filter((m) => m.texto && !m.ehSistema);
        }
        // Falas da personagem que contam pra repetição. Em regenerate/swipe a fala sendo substituída (e os swipes antigos dela)
        // ENTRAM na lista (9.5) — senão a IA devolve a mesma. `ultimasFalasCache` guarda o estado de antes do ST apagar a mensagem.
        let ultimasFalasCache = [];
        function atualizarCacheFalas() {
            ultimasFalasCache = chatRealRecente(24)
                .filter((m) => !m.ehUsuario)
                .slice(-6);
        }
        function falasParaRepeticao(substituicao) {
            let falas = chatRealRecente(24)
                .filter((m) => !m.ehUsuario)
                .slice(-6);
            if (substituicao && ultimasFalasCache.length) {
                // o ST pode já ter tirado a fala do array: usa o que a gente guardou
                const textos = new Set(falas.map((f) => f.texto));
                ultimasFalasCache.slice(-1).forEach((f) => {
                    if (!textos.has(f.texto)) falas.push(f);
                });
                falas = falas.concat(...ultimasFalasCache.slice(-1).map((f) => f.swipes.map((s) => ({ texto: s }))));
            }
            return falas.slice(-9).map((f) => f.texto);
        }
        // 11.2 — o CÓDIGO mede, a IA recebe a lista real. Sem "varie o vocabulário" genérico.
        function medirRepeticao(falas, tiques) {
            const r = { frases: [], palavras: [], comecos: [], tiques: [] };
            if (falas.length >= 2) {
                const cont = new Map();
                falas.forEach((f) => {
                    const w = words(f);
                    const vistos = new Set();
                    for (let n = 4; n <= 6; n++)
                        for (let i = 0; i + n <= w.length; i++) {
                            const seg = w.slice(i, i + n);
                            if (seg.every(ehStop)) continue;
                            vistos.add(seg.join(' '));
                        }
                    vistos.forEach((g) => cont.set(g, (cont.get(g) || 0) + 1));
                });
                const rep = [...cont.entries()]
                    .filter(([, c]) => c >= 2)
                    .map(([g]) => g)
                    .sort((a, b) => b.length - a.length);
                const mantidas = [];
                for (const g of rep) if (!mantidas.some((m) => m.includes(g))) mantidas.push(g); // funde sobrepostas na mais longa
                r.frases = mantidas.slice(0, 5);
            }
            const base = falas.slice(-6);
            if (base.length >= 3) {
                const porRad = new Map();
                base.forEach((f) => {
                    const rs = new Map();
                    words(f).forEach((w) => {
                        if (w.length < 4 || ehStop(w)) return;
                        const rd = radicalPtBr(w);
                        if (!rs.has(rd)) rs.set(rd, w);
                    });
                    rs.forEach((w, rd) => {
                        const o = porRad.get(rd) || { n: 0, w };
                        o.n++;
                        porRad.set(rd, o);
                    });
                });
                r.palavras = [...porRad.values()]
                    .filter((o) => o.n >= 3)
                    .sort((a, b) => b.n - a.n)
                    .map((o) => o.w)
                    .slice(0, 6);
            }
            if (base.length >= 2) {
                const ini = new Map();
                base.forEach((f) => {
                    const k = words(f).slice(0, 3).join(' ');
                    if (k) ini.set(k, (ini.get(k) || 0) + 1);
                });
                r.comecos = [...ini.entries()]
                    .filter(([, c]) => c >= 2)
                    .map(([k]) => k)
                    .slice(0, 3);
            }
            r.tiques = (tiques || []).map((t) => String(t).trim()).filter(Boolean);
            // teto de 12 itens e ~150 tokens, na ordem de importância
            let total = 0;
            for (const k of ['frases', 'palavras', 'comecos', 'tiques']) {
                r[k] = r[k].filter(() => total++ < 12);
            }
            return r;
        }
        function textoEvitar(rep) {
            const rot = [
                ['frases', 'frases'],
                ['palavras', 'palavras'],
                ['comecos', 'começos'],
                ['tiques', 'tiques'],
            ];
            const ls = rot
                .filter(([k]) => rep[k].length)
                .map(([k, nome]) => '- ' + nome + ': ' + rep[k].map((x) => '“' + x + '”').join(', '));
            let txt = ls.join('\n');
            while (estimarTokens(txt) > 150 && ls.length) {
                ls.pop();
                txt = ls.join('\n');
            }
            return txt;
        }
        // 11.4 — pensamento em primeira pessoa: pede o CONTEÚDO, não um formato rígido. Funciona ou não: T11 só mede.
        function instrucaoPensamento() {
            const p = getConfig().pessoaPensamento;
            if (p === 2)
                return 'Antes de responder, pense como se falasse com ela: o que você percebe, o que você quer e o que você vai fazer agora.';
            if (p === 3)
                return 'Antes de responder, pense nela em terceira pessoa: o que ela percebe, o que ela quer e o que ela vai fazer agora.';
            return 'Antes de responder, pense como ela, em primeira pessoa: o que percebo, o que quero e o que vou fazer agora. Pense em português.';
        }
        const INSTRUCAO_RESPOSTA =
            'Responda só como a personagem, em prosa de RP. Não mostre planejamento, listas nem comentários fora da cena.';

        // ============================================================
        // 07 ESTILO GUIADO (adendo A) — "empurrar, não algemar"
        // 4 peças, TODAS por código (a IA só entra UMA vez, na análise do arquivo):
        //   1 impressão de estilo (números medidos) · 2 banco de exemplos (copiados literalmente e conferidos)
        //   3 entrega rotativa (poucos exemplos que giram a cada resposta) · 4 conferência e cutucada (só se houver desvio)
        // O arquivo recebido do adendo terminava na A5.3: A6–A11 foram reconstruídas pela lógica das referências
        // (A6 faixas de tamanho, A7 rotação, A8 conferência/cópia, A9 modo forte, A10 conflito com a Descrição, A11 tela).
        // Limite honesto: o código só mede a SUPERFÍCIE (tamanho, pontuação, gíria). Não mede humor nem subtexto.
        // ============================================================
        function percentil(arr, p) {
            if (!arr.length) return 0;
            const a = arr.slice().sort((x, y) => x - y);
            const i = (a.length - 1) * p;
            const lo = Math.floor(i),
                hi = Math.ceil(i);
            return a[lo] + (a[hi] - a[lo]) * (i - lo);
        }
        const contaPalavras = (t) => (String(t || '').match(/[\p{L}\p{N}'’-]+/gu) || []).length;
        const norm = (t) =>
            String(t || '')
                .replace(/\s+/g, ' ')
                .trim();

        // ---- A5.2 segmentação (heurística; o usuário pode corrigir). Narração = trechos entre *…* ou (…) ----
        function separarNarracao(linha) {
            const narr = [];
            let fala = linha.replace(/\*([^*\n]{2,})\*|\(([^)\n]{2,})\)/g, (_, a, b) => {
                narr.push((a || b).trim());
                return ' ';
            });
            return { fala: norm(fala), narr };
        }
        function segmentarEstilo(texto, vozAlvo) {
            const linhas = String(texto || '')
                .split(/\r?\n/)
                .map((l) => l.trim())
                .filter(Boolean);
            const unidades = [];
            let formato = 'corrido',
                confianca = 'alta';
            const falantes = {};
            const RE_LOG = /^(?:\[\d{1,2}:\d{2}(?::\d{2})?\]\s*)?([^\s:—–][^:—–\n]{0,28}?)\s*[:—–]\s+(\S.*)$/;
            const logs = linhas.map((l) => RE_LOG.exec(l));
            const nLog = logs.filter(Boolean).length;
            const add = (txt, extra) => {
                const { fala, narr } = separarNarracao(txt);
                if (fala) unidades.push(Object.assign({ canal: 'fala', texto: fala }, extra));
                narr.forEach((n) => unidades.push(Object.assign({ canal: 'narracao', texto: n }, extra)));
            };
            if (linhas.length >= 4 && nLog / linhas.length >= 0.6) {
                formato = 'log';
                logs.forEach((m) => {
                    if (m) falantes[m[1].trim()] = (falantes[m[1].trim()] || 0) + 1;
                });
                logs.forEach((m) => {
                    if (m && (!vozAlvo || vozAlvo === 'todas' || m[1].trim() === vozAlvo))
                        add(m[2], { falante: m[1].trim() });
                });
            } else if (linhas.filter((l) => /^[—–]/.test(l)).length / Math.max(1, linhas.length) >= 0.3) {
                formato = 'travessao';
                linhas.forEach((l) => {
                    if (/^[—–]/.test(l)) add(l.replace(/^[—–]\s*/, ''));
                    else unidades.push({ canal: 'narracao', texto: l });
                });
            } else if ((texto.match(/["“«][^"”»\n]{2,}["”»]/g) || []).length >= 3) {
                formato = 'aspas';
                linhas.forEach((l) => {
                    const resto = l.replace(/["“«]([^"”»\n]{2,})["”»]/g, (_, f) => {
                        add(f);
                        return ' ';
                    });
                    const r = norm(resto);
                    if (r) {
                        const s = separarNarracao(r);
                        s.narr.forEach((n) => unidades.push({ canal: 'narracao', texto: n }));
                        if (s.fala.length > 3) unidades.push({ canal: 'narracao', texto: s.fala });
                    }
                });
            } else if (linhas.length >= 8 && linhas.filter((l) => l.length <= 220).length / linhas.length >= 0.7) {
                formato = 'linhas';
                linhas.forEach((l) => add(l));
            } else {
                formato = 'corrido';
                confianca = 'baixa';
                linhas.forEach((l) =>
                    (l.match(/[^.!?…]+[.!?…]+["”»]?|[^.!?…]+$/g) || [l]).forEach((s) => add(s.trim()))
                );
            }
            return { unidades: unidades.filter((u) => contaPalavras(u.texto) >= 1), formato, confianca, falantes };
        }
        // ---- A5.1 medidas por canal ----
        const RE_EMOJI = /\p{Extended_Pictographic}/gu;
        function medirCanal(unidades, lexico) {
            const n = unidades.length;
            if (!n) return null;
            const pal = unidades.map((u) => contaPalavras(u.texto));
            const totalPal = pal.reduce((a, b) => a + b, 0) || 1;
            const pct = (fn) => Math.round((100 * unidades.filter((u) => fn(u.texto)).length) / n);
            const frases = unidades.flatMap((u) =>
                u.texto
                    .split(/[.!?…]+/)
                    .map(contaPalavras)
                    .filter(Boolean)
            );
            const lex = (lexico || []).map((l) => semAcento(l).toLowerCase());
            const todasPal = unidades.flatMap((u) => words(semAcento(u.texto)));
            return {
                n,
                palavrasPorFala: {
                    p10: Math.round(percentil(pal, 0.1)),
                    p50: Math.round(percentil(pal, 0.5)),
                    p90: Math.round(percentil(pal, 0.9)),
                },
                palavrasPorFrase: { p50: Math.round(percentil(frases, 0.5)), p90: Math.round(percentil(frases, 0.9)) },
                pctPergunta: pct((t) => /\?["”»')\]]*\s*$/.test(t)),
                pctReticencias: pct((t) => /…|\.\.\./.test(t)),
                pctExclamacao: pct((t) => /!/.test(t)),
                pctInicioMinuscula: pct((t) => /^\p{Ll}/u.test(t)),
                pctSemPontoFinal: pct((t) => !/[.!?…]["”»')\]]*\s*$/.test(t)),
                virgulasPor100: +(
                    (100 * unidades.reduce((a, u) => a + (u.texto.match(/,/g) || []).length, 0)) /
                    totalPal
                ).toFixed(1),
                pctCaps: pct((t) => /\b\p{Lu}{3,}\b/u.test(t)),
                emojiPorFala: +(unidades.reduce((a, u) => a + (u.texto.match(RE_EMOJI) || []).length, 0) / n).toFixed(
                    2
                ),
                lexicoPor100: lex.length
                    ? +((100 * todasPal.filter((w) => lex.includes(w)).length) / totalPal).toFixed(1)
                    : 0,
            };
        }
        // ---- A5.3 banda-alvo: P50 e P10–P90; para taxas: taxa ± max(15 pontos, 50% da taxa). n < 20 = medida pouco confiável ----
        function bandaDe(medidas) {
            if (!medidas) return null;
            const b = { n: medidas.n, confiavel: medidas.n >= 20 };
            b.palavrasPorFala = {
                alvo: medidas.palavrasPorFala.p50,
                min: medidas.palavrasPorFala.p10,
                max: medidas.palavrasPorFala.p90,
            };
            for (const k of [
                'pctPergunta',
                'pctReticencias',
                'pctExclamacao',
                'pctInicioMinuscula',
                'pctSemPontoFinal',
                'pctCaps',
            ]) {
                const v = medidas[k];
                const d = Math.max(15, v * 0.5);
                b[k] = { alvo: v, min: Math.max(0, Math.round(v - d)), max: Math.min(100, Math.round(v + d)) };
            }
            for (const [k, piso] of [
                ['virgulasPor100', 1],
                ['emojiPorFala', 0.15],
                ['lexicoPor100', 1],
            ]) {
                const v = medidas[k];
                const d = Math.max(piso, v * 0.5);
                b[k] = { alvo: v, min: Math.max(0, +(v - d).toFixed(2)), max: +(v + d).toFixed(2) };
            }
            return b;
        }
        // A6 (reconstruída): faixas por tercis do tamanho em palavras, por canal.
        function faixasDe(unidades) {
            const pal = unidades.map((u) => contaPalavras(u.texto));
            const a = percentil(pal, 1 / 3),
                b = percentil(pal, 2 / 3);
            return (u) => {
                const n = contaPalavras(u.texto);
                return n <= a ? 'curta' : n <= b ? 'media' : 'longa';
            };
        }
        const LIMITE_PALAVRAS = { fala: 25, narracao: 35 };
        function candidatosDe(unidades) {
            const out = [];
            const faixa = {
                fala: faixasDe(unidades.filter((u) => u.canal === 'fala')),
                narracao: faixasDe(unidades.filter((u) => u.canal === 'narracao')),
            };
            unidades.forEach((u) => {
                const n = contaPalavras(u.texto);
                if (n < 2 || n > LIMITE_PALAVRAS[u.canal]) return;
                out.push({
                    cand: out.length + 1,
                    canal: u.canal,
                    texto: u.texto,
                    palavras: n,
                    faixa: faixa[u.canal](u),
                });
            });
            return out;
        }
        // Passo 0 (código, antes da IA): segmenta, mede o texto INTEIRO (âncora objetiva) e monta candidatos numerados.
        function estiloPasso0(texto, vozAlvo) {
            const seg = segmentarEstilo(texto, vozAlvo);
            const impressao = {
                fala: medirCanal(seg.unidades.filter((u) => u.canal === 'fala')),
                narracao: medirCanal(seg.unidades.filter((u) => u.canal === 'narracao')),
            };
            let cands = candidatosDe(seg.unidades);
            if (cands.length > 320) {
                const passo = cands.length / 320;
                cands = Array.from({ length: 320 }, (_, i) => cands[Math.floor(i * passo)]).map((c, i) =>
                    Object.assign(c, { cand: i + 1 })
                );
            } // amostra espaçada, só pra caber no pedido
            return { seg, impressao, cands };
        }
        function resumoImpressao(imp) {
            const f = imp.fala;
            if (!f) return '(sem falas medidas)';
            return (
                'falas: n=' +
                f.n +
                ', palavras/fala P10-P50-P90=' +
                f.palavrasPorFala.p10 +
                '-' +
                f.palavrasPorFala.p50 +
                '-' +
                f.palavrasPorFala.p90 +
                ', perguntas ' +
                f.pctPergunta +
                '%, reticências ' +
                f.pctReticencias +
                '%, exclamação ' +
                f.pctExclamacao +
                '%, início minúsculo ' +
                f.pctInicioMinuscula +
                '%, sem ponto final ' +
                f.pctSemPontoFinal +
                '%' +
                (imp.narracao
                    ? '; narração: n=' + imp.narracao.n + ', palavras/trecho P50=' + imp.narracao.palavrasPorFala.p50
                    : '')
            );
        }
        // Passo 1 — o que a IA recebe pra ESTILO (entra no mesmo pedido da análise da nota). Ela escolhe POR NÚMERO: não digita exemplos.
        function pedidoEstiloParaIA(p0) {
            const lista = p0.cands
                .map((c) => c.cand + ' [' + c.canal + ',' + c.palavras + 'p] ' + c.texto.replace(/\s+/g, ' '))
                .join('\n');
            return (
                'ESTILO GUIADO. Impressão JÁ MEDIDA por código (não invente números): ' +
                resumoImpressao(p0.impressao) +
                '.\n' +
                'Candidatos a exemplo (numerados; escolha POR NÚMERO, nunca reescreva):\n' +
                lista +
                '\n' +
                'Devolva no JSON, além da nota, o campo "estilo": {"principios":["3 a 6 linhas curtas: o que caracteriza o jeito e o que evitar"],"exemplares":[{"cand":12,"situacao":"seca|provocação|dúvida|carinho|raiva|deboche|..."}],"lexico":["gírias/marcadores que aparecem"],"lixo":[{"cand":7,"motivo":"nome de pessoa real, dado pessoal, outra língua, fala cortada"}],"avisos":[]}. Escolha entre 12 e 40 exemplares variados (curtos, médios, longos).'
            );
        }
        const RE_LIXO = /[\w.+-]+@[\w-]+\.[\w.]+|https?:\/\/\S+|www\.\S+|(?:^|\s)@\w{2,}|\+?\d[\d\s().-]{7,}\d|\d{6,}/i;
        // Passo 2 — validação por código (DEVE): literal, saneado, limites, diversidade, sem duplicata, avisos.
        function estiloPasso2(resp, p0, textoOriginal) {
            const avisos = (resp && Array.isArray(resp.avisos) ? resp.avisos : []).map(String);
            const originalNorm = norm(textoOriginal);
            const lixo = new Set(((resp && resp.lixo) || []).map((l) => Number(l.cand)));
            const lexico = ((resp && resp.lexico) || []).map(String).slice(0, 40);
            const lexSet = new Set(lexico.map((l) => semAcento(l).toLowerCase()));
            const porNum = new Map(p0.cands.map((c) => [c.cand, c]));
            const escolhidos = [];
            let descartados = 0;
            const vistoIni = new Set();
            const tenta = (c, situacao) => {
                if (!c || escolhidos.length >= 40) return;
                if (!originalNorm.includes(norm(c.texto))) {
                    descartados++;
                    return;
                } // literal
                if (lixo.has(c.cand) || RE_LIXO.test(c.texto)) {
                    descartados++;
                    return;
                }
                const ini = words(c.texto).slice(0, 4).join(' ');
                if (vistoIni.has(ini)) return; // sem quase-duplicata
                vistoIni.add(ini);
                const nomeProprio = c.texto.split(/(?<=[.!?…]\s)|\n/).some((fr) =>
                    fr
                        .trim()
                        .split(/\s+/)
                        .slice(1)
                        .some(
                            (w) =>
                                /^\p{Lu}\p{Ll}{2,}$/u.test(w.replace(/[^\p{L}]/gu, '')) &&
                                !lexSet.has(semAcento(w).toLowerCase())
                        )
                );
                escolhidos.push({
                    id: 'x' + c.cand,
                    canal: c.canal,
                    texto: c.texto,
                    palavras: c.palavras,
                    faixa: c.faixa,
                    situacao: String(situacao || '').slice(0, 24),
                    favorito: false,
                    bloqueado: false,
                    revisar: nomeProprio,
                });
            };
            ((resp && resp.exemplares) || []).forEach((e) => tenta(porNum.get(Number(e.cand)), e.situacao));
            // diversidade: ao menos 1/4 de cada faixa (por canal) quando ela existir no arquivo
            for (const canal of ['fala', 'narracao']) {
                const doCanal = p0.cands.filter((c) => c.canal === canal);
                if (!doCanal.length) continue;
                const cota = Math.ceil(Math.min(40, Math.max(12, escolhidos.length)) / 4);
                for (const f of ['curta', 'media', 'longa']) {
                    const pool = doCanal.filter((c) => c.faixa === f);
                    if (!pool.length) continue;
                    let tem = escolhidos.filter((e) => e.canal === canal && e.faixa === f).length;
                    for (let i = 0; tem < cota && i < pool.length; i += Math.max(1, Math.floor(pool.length / cota))) {
                        const antes = escolhidos.length;
                        tenta(pool[i], '');
                        if (escolhidos.length > antes) tem++;
                    }
                }
            }
            if (descartados)
                avisos.push(
                    descartados + ' exemplo(s) descartado(s) na conferência (não eram literais ou tinham dado pessoal).'
                );
            if (escolhidos.length < 5)
                avisos.push('Pouco material de estilo neste arquivo (' + escolhidos.length + ' exemplos).');
            if (p0.seg.confianca === 'baixa')
                avisos.push(
                    'A separação das falas foi incerta (texto corrido). Se não ficou bom, use "tratar cada linha como fala".'
                );
            const bandaFala = bandaDe(p0.impressao.fala),
                bandaNarr = bandaDe(p0.impressao.narracao);
            if (bandaFala && !bandaFala.confiavel)
                avisos.push('Poucas falas medidas (' + bandaFala.n + '): as medidas não serão usadas na conferência.');
            return {
                versao: 1,
                analisadoEm: Date.now(),
                formato: p0.seg.formato,
                confianca: p0.seg.confianca,
                vozAlvo: null,
                falantes: p0.seg.falantes,
                medidas: { fala: p0.impressao.fala, narracao: p0.impressao.narracao },
                bandas: { fala: bandaFala, narracao: bandaNarr },
                principios: ((resp && resp.principios) || []).map(String).slice(0, 6),
                lexico,
                exemplos: escolhidos,
                avisos,
                editadaPeloUsuario: false,
                ignorar: {},
            };
        }

        // ---- fontes: arquivos que entram no Estilo guiado (A3): tipo 'tom' ativo, ou "usar como estilo" ligado ----
        function fontesDeEstilo() {
            return listaArquivos().filter(
                (a) =>
                    a.meta.ativo &&
                    a.nota &&
                    a.nota.revisada !== false &&
                    a.nota.estilo &&
                    (a.meta.tipo === 'tom' || a.meta.usarComoEstilo)
            );
        }
        // ---- A7 rotação: poucos exemplos por resposta, que mudam de uma resposta pra outra ----
        const ROT_KEY = 'spade_rot_v8';
        const Rot = { n: -1, salt: 0, ids: [], hist: [], reforco: false };
        (function () {
            try {
                Object.assign(Rot, JSON.parse(localStorage.getItem(ROT_KEY) || '{}'));
            } catch (_) {
                /* começa limpo */
            }
        })();
        const salvarRot = () => {
            try {
                localStorage.setItem(
                    ROT_KEY,
                    JSON.stringify({ n: Rot.n, salt: Rot.salt, ids: Rot.ids, hist: Rot.hist.slice(-24), cut: Rot.cut })
                );
            } catch (_) {
                /* cheio: perde só a rotação */
            }
        };
        function prng(seed) {
            let a = seed >>> 0;
            return () => {
                a = (a + 0x6d2b79f5) >>> 0;
                let t = a;
                t = Math.imul(t ^ (t >>> 15), t | 1);
                t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        }
        const hashStr = (s) => {
            let h = 2166136261;
            for (let i = 0; i < s.length; i++) {
                h ^= s.charCodeAt(i);
                h = Math.imul(h, 16777619);
            }
            return h >>> 0;
        };
        const respostaIndice = () =>
            Array.isArray(ctx().chat) ? ctx().chat.filter((m) => !m.is_user && !m.is_system).length : 0;
        function poolDeExemplos() {
            const out = [];
            fontesDeEstilo().forEach((a) =>
                a.nota.estilo.exemplos.forEach((e) => {
                    if (!e.bloqueado) out.push(Object.assign({ fonte: a.id }, e));
                })
            );
            return out;
        }
        function escolherExemplos(qtd) {
            const pool = poolDeExemplos();
            if (!pool.length) return [];
            const n = respostaIndice();
            const sig = pool.length + ':' + qtd;
            if (
                Rot.n === n &&
                Rot.sig === sig &&
                Rot.ids.length &&
                Rot.ids.every((id) => pool.some((p) => p.fonte + '|' + p.id === id))
            )
                return Rot.ids.map((id) => pool.find((p) => p.fonte + '|' + p.id === id)).filter(Boolean);
            if (Rot.n !== n && Rot.ids.length) Rot.hist.push(...Rot.ids); // a resposta avançou: o que foi entregue vira "recente"
            const rnd = prng(hashStr(chatIdParaDisco() + '|' + n + '|' + Rot.salt));
            const recentes = new Set(Rot.hist.slice(-12));
            const temNarr =
                pool.some((p) => p.canal === 'narracao') && pool.filter((p) => p.canal === 'narracao').length >= 5;
            const quer = [];
            const faixas = ['curta', 'media', 'longa'];
            const falas = pool.filter((p) => p.canal === 'fala'),
                narr = pool.filter((p) => p.canal === 'narracao');
            const nFala = temNarr && qtd >= 3 ? qtd - 1 : qtd;
            const usadas = new Set();
            const sit = new Set();
            const peso = (p) =>
                (recentes.has(p.fonte + '|' + p.id) ? 0.05 : 1) *
                (p.favorito ? 3 : 1) *
                (p.situacao && sit.has(p.situacao) ? 0.3 : 1);
            const sorteia = (lista) => {
                const cand = lista.filter((p) => !usadas.has(p.fonte + '|' + p.id));
                if (!cand.length) return null;
                const tot = cand.reduce((a, p) => a + peso(p), 0);
                let r = rnd() * tot;
                for (const p of cand) {
                    r -= peso(p);
                    if (r <= 0) return p;
                }
                return cand[cand.length - 1];
            };
            for (let i = 0; i < nFala; i++) {
                const faixa = faixas[i % 3];
                const p = sorteia(falas.filter((x) => x.faixa === faixa)) || sorteia(falas);
                if (p) {
                    quer.push(p);
                    usadas.add(p.fonte + '|' + p.id);
                    if (p.situacao) sit.add(p.situacao);
                }
            }
            if (temNarr && qtd >= 3) {
                const p = sorteia(narr);
                if (p) quer.push(p);
            }
            Rot.n = n;
            Rot.sig = sig;
            Rot.ids = quer.map((p) => p.fonte + '|' + p.id);
            salvarRot();
            return quer;
        }
        function linhaPerfil() {
            const fs = fontesDeEstilo();
            if (!fs.length) return '';
            const b = bandaDasFontes(fs);
            if (!b) return '';
            const r = [];
            if (b.palavrasPorFala)
                r.push(
                    'falas de cerca de ' +
                        b.palavrasPorFala.alvo +
                        ' palavras (costumam ir de ' +
                        b.palavrasPorFala.min +
                        ' a ' +
                        b.palavrasPorFala.max +
                        ')'
                );
            const taxa = (k, sim, nao) => {
                if (!b[k]) return;
                const v = b[k].alvo;
                if (v >= 15) r.push('cerca de ' + v + '% ' + sim);
                else if (v <= 4) r.push(nao);
            };
            taxa('pctPergunta', 'terminam em pergunta', 'quase nunca pergunta');
            taxa('pctReticencias', 'têm reticências', 'quase sem reticências');
            taxa('pctExclamacao', 'têm exclamação', 'quase sem exclamação');
            if (b.pctInicioMinuscula && b.pctInicioMinuscula.alvo >= 40)
                r.push('começa com letra minúscula, jeito de chat');
            if (b.pctSemPontoFinal && b.pctSemPontoFinal.alvo >= 40) r.push('muitas falas sem ponto final');
            return r.join('; ');
        }
        // ---- A8 conferência: compara as últimas falas dela com a impressão; só cutuca se houver desvio ----
        const KW_SECA =
            /\b(seca|secas|monossil\w*|fala pouco|lac[oô]nic\w*|calad[ao]|reservad[ao]|contid[ao]|curt[ao]s?|econ[oô]mic\w*)\b/i;
        const KW_FALANTE = /\b(tagarela|fala muito|prolix\w*|expansiv\w*|falante|extrovertid\w*|verborr\w*)\b/i;
        // A10: a Descrição vence. Se ela declara o OPOSTO do arquivo no tamanho das falas, não cutuca o tamanho.
        function conflitoDeTamanho(b) {
            const d = Desc.v;
            if (!d) return null;
            const txt = [d.comoFala, d.temperamento, d.aparencia].join(' ');
            if (b.palavrasPorFala.alvo >= 18 && KW_SECA.test(txt))
                return 'A Descrição diz que ela fala pouco, mas o arquivo é de gente que fala muito: o tamanho não será cutucado.';
            if (b.palavrasPorFala.alvo <= 7 && KW_FALANTE.test(txt))
                return 'A Descrição diz que ela fala muito, mas o arquivo é de falas curtas: o tamanho não será cutucado.';
            return null;
        }
        const ROTULO_MEDIDA = {
            palavrasPorFala: 'palavras por fala',
            pctPergunta: 'falas terminando em pergunta',
            pctReticencias: 'falas com reticências',
            pctExclamacao: 'falas com exclamação',
            pctSemPontoFinal: 'falas sem ponto final',
            pctInicioMinuscula: 'falas começando em minúscula',
        };
        // >>ESTILO-PURO (sem DOM, sem ST, sem IA: os testes em testes/ leem este trecho)
        const ESTILO_MEDIDAS = [
            'palavrasPorFala',
            'pctPergunta',
            'pctReticencias',
            'pctExclamacao',
            'pctSemPontoFinal',
            'pctInicioMinuscula',
        ];
        const ESTILO_PESO_PRIORIDADE = { alta: 1.5, media: 1, baixa: 0.7 };
        // Vários arquivos de estilo ativos: a conferência olha TODOS, não só o primeiro.
        // Banda combinada = a mais LARGA entre eles (menor mínimo, maior máximo): só se cutuca quando ela sai do jeito de todos.
        // O alvo (o número que aparece no texto) é a média ponderada pelo tamanho da amostra e pela prioridade do arquivo.
        // Medida que o usuário ignorou num arquivo sai só daquele arquivo; se todos ignoram, a medida some.
        function combinarBandas(fontes) {
            const uteis = (fontes || []).filter((f) => f && f.bandas && f.bandas.confiavel);
            if (!uteis.length) return null;
            const out = { n: uteis.reduce((a, f) => a + (f.bandas.n || 0), 0), confiavel: true, fontes: uteis.length };
            for (const k of ESTILO_MEDIDAS) {
                const bs = uteis.filter((f) => !(f.ignorar && f.ignorar[k]) && f.bandas[k]);
                if (!bs.length) continue;
                const pesos = bs.map((f) => Math.max(1, f.bandas.n || 1) * (ESTILO_PESO_PRIORIDADE[f.prioridade] || 1));
                const soma = pesos.reduce((a, b) => a + b, 0);
                out[k] = {
                    alvo: Math.round(bs.reduce((a, f, i) => a + f.bandas[k].alvo * pesos[i], 0) / soma),
                    min: Math.min(...bs.map((f) => f.bandas[k].min)),
                    max: Math.max(...bs.map((f) => f.bandas[k].max)),
                };
            }
            return out;
        }
        // Trava da cutucada. Sem ela, uma medida que continua fora do jeito geraria o aviso em TODA resposta.
        //  - uma medida aparece no máximo ESTILO_TRAVA.maxSeguidas respostas seguidas; se continua fora, DESCANSA ESTILO_TRAVA.descanso respostas e só depois volta;
        //  - voltar pra dentro da banda 1 resposta não zera nada (evita o vai-e-vem); só depois de ESTILO_TRAVA.folgaVolta respostas dentro é que o "crédito" renova;
        //  - os contadores só andam quando a RESPOSTA muda (n): redesenhar a Prévia, regenerar ou dar swipe não gastam o crédito.
        // `est` = { ultimaN, itens: { medida: { mostradas, dentro, ate } }, visiveis: [medida] } (guardado entre respostas).
        const ESTILO_TRAVA = { maxSeguidas: 3, descanso: 4, folgaVolta: 2 };
        function travarCutucada(est, desvios, n, cap) {
            const fora = new Map((desvios || []).map((d) => [d.medida, d]));
            if (est.ultimaN !== n) {
                for (const [k, it] of Object.entries(est.itens)) {
                    if (it.ate != null) {
                        if (n >= it.ate) delete est.itens[k];
                        continue;
                    } // acabou o descanso: recomeça do zero se ainda estiver fora
                    it.dentro = fora.has(k) ? 0 : it.dentro + 1;
                    if (it.dentro >= ESTILO_TRAVA.folgaVolta) delete est.itens[k];
                    else if (it.mostradas >= ESTILO_TRAVA.maxSeguidas) {
                        it.ate = n + ESTILO_TRAVA.descanso;
                        it.mostradas = 0;
                    }
                }
                for (const k of fora.keys()) if (!est.itens[k]) est.itens[k] = { mostradas: 0, dentro: 0, ate: null };
                const elegiveis = [...fora.values()]
                    .filter((d) => est.itens[d.medida] && est.itens[d.medida].ate == null)
                    .sort((a, b) => b.peso - a.peso)
                    .slice(0, cap);
                elegiveis.forEach((d) => {
                    est.itens[d.medida].mostradas++;
                });
                est.visiveis = elegiveis.map((d) => d.medida);
                est.ultimaN = n;
            }
            return est.visiveis.filter((k) => fora.has(k)); // nunca mostra número velho de medida que já não está fora
        }
        // <<ESTILO-PURO
        // A conferência olha TODOS os arquivos de estilo ativos (banda combinada, ver combinarBandas), não só o primeiro.
        const bandaDasFontes = (fs) =>
            combinarBandas(
                fs.map((a) => ({
                    bandas: a.nota.estilo.bandas && a.nota.estilo.bandas.fala,
                    ignorar: a.nota.estilo.ignorar,
                    prioridade: a.meta.prioridade,
                }))
            );
        function conferirEstilo(falasTexto) {
            const modo = getConfig().estiloModo;
            const saida = { desvios: [], enviados: [], copias: [], conflitos: [], medidoEm: 0, fontes: 0 };
            const fs = fontesDeEstilo();
            if (!fs.length || modo === 'desligado') return saida;
            const b = bandaDasFontes(fs);
            if (!b) return saida;
            saida.fontes = b.fontes;
            const lexico = Array.from(new Set(fs.flatMap((a) => a.nota.estilo.lexico || [])));
            const unid = falasTexto.flatMap((t) =>
                segmentarEstilo(t.replace(/^\s+/, '')).unidades.filter((u) => u.canal === 'fala')
            );
            const falas =
                unid.length >= 3
                    ? unid
                    : falasTexto.map((t) => ({ canal: 'fala', texto: separarNarracao(t).fala })).filter((u) => u.texto);
            saida.medidoEm = falas.length;
            if (falas.length < 3) return saida;
            const m = medirCanal(falas, lexico);
            const conf = b.palavrasPorFala ? conflitoDeTamanho(b) : null;
            if (conf) saida.conflitos.push(conf);
            const folga = modo === 'forte' ? 0 : 0.25; // leve só reclama quando passa 25% além da borda da banda
            const checa = (k, atual, band, unidade) => {
                if (!band) return; // medida ignorada em todos os arquivos
                const amp = Math.max(1, band.max - band.min);
                const fora =
                    atual < band.min - amp * folga ? 'abaixo' : atual > band.max + amp * folga ? 'acima' : null;
                if (fora)
                    saida.desvios.push({
                        medida: k,
                        atual,
                        alvo: band.alvo,
                        min: band.min,
                        max: band.max,
                        direcao: fora,
                        unidade,
                        peso: Math.abs(atual - band.alvo) / amp,
                    });
            };
            if (!conf) checa('palavrasPorFala', m.palavrasPorFala.p50, b.palavrasPorFala, 'palavras');
            for (const k of [
                'pctPergunta',
                'pctReticencias',
                'pctExclamacao',
                'pctSemPontoFinal',
                'pctInicioMinuscula',
            ])
                checa(k, m[k], b[k], '%');
            saida.desvios.sort((x, y) => y.peso - x.peso); // TODOS os desvios; quem decide o que vai pra IA é a trava (travaDoEstilo)
            // cópia: 5 palavras seguidas de um exemplo aparecendo numa fala recente dela (o código mede, em vez de pedir "não copie")
            const gramas = new Set();
            poolDeExemplos().forEach((e) => {
                const w = words(e.texto);
                for (let i = 0; i + 5 <= w.length; i++) gramas.add(w.slice(i, i + 5).join(' '));
            });
            for (const t of falasTexto.slice(-3)) {
                const w = words(t);
                for (let i = 0; i + 5 <= w.length; i++) {
                    const g = w.slice(i, i + 5).join(' ');
                    if (gramas.has(g) && !ehStop(g.split(' ')[0]) && !saida.copias.includes(g)) saida.copias.push(g);
                }
            }
            saida.copias = saida.copias.slice(0, 2);
            return saida;
        }
        // Trava da cutucada (ver travarCutucada): o estado vai pro localStorage junto com a rotação, por chat.
        function travaDoEstilo(desvios, cap) {
            const chat = chatIdParaDisco();
            if (!Rot.cut || Rot.cut.chat !== chat) Rot.cut = { chat, ultimaN: null, itens: {}, visiveis: [] };
            const antes = JSON.stringify(Rot.cut);
            const vis = travarCutucada(Rot.cut, desvios, respostaIndice(), cap);
            if (JSON.stringify(Rot.cut) !== antes) salvarRot();
            return desvios.filter((d) => vis.includes(d.medida));
        }
        function textoCutucada(c) {
            const ls = c.desvios.map(
                (d) =>
                    '- ' +
                    (d.direcao === 'acima' ? 'Nas últimas falas, ' : 'Nas últimas falas, ') +
                    ROTULO_MEDIDA[d.medida] +
                    ': ' +
                    (d.unidade === '%' ? d.atual + '%' : d.atual + ' palavras (mediana)') +
                    '; o jeito é ' +
                    (d.unidade === '%'
                        ? '~' + d.alvo + '% (' + d.min + '–' + d.max + '%)'
                        : '~' + d.alvo + ' (' + d.min + '–' + d.max + ')') +
                    '.'
            );
            c.copias.forEach((g) =>
                ls.push(
                    '- Um trecho dos exemplos apareceu quase igual numa fala sua: “' + g + '”. Diga de outro jeito.'
                )
            );
            if (Rot.reforco) ls.push('- A última tentativa saiu fora do jeito mostrado: aproxime-se dele agora.');
            return ls.join('\n');
        }
        // Bloco 7 — ESTILO (volátil: gira a cada resposta, por isso fica no FIM do prompt, nunca no prefixo estável)
        function blocoEstilo() {
            // 8.9.0: sem conferência/cutucada e sem a linha "Jeito de falar". Só os exemplos (rotação preservada).
            const modo = getConfig().estiloModo;
            if (modo === 'desligado' || !fontesDeEstilo().length) return { texto: '', exemplos: [], conferencia: null };
            const exemplos = escolherExemplos(3);
            const partes = [];
            if (exemplos.length)
                partes.push(
                    '### Exemplos de jeito (só referência, não copie)\n' +
                        exemplos.map((e) => '- “' + e.texto + '”').join('\n')
                );
            return { texto: partes.length ? '## ESTILO\n' + partes.join('\n') : '', exemplos, conferencia: null };
        }

        // ============================================================
        // 06b RELÓGIO DA HISTÓRIA (seção 12.6, decisão 14) — dia/hora DENTRO do RP.
        // O usuário escreve "*passaram dois dias*" na narração e o relógio anda. Sem IA: o salto é lido por código
        // (a v7 chamava um 2º modelo para isso). Por chat, em disco: memoria/<personagem>/<chat>/relogio.json.
        // Só dispara sozinho com salto CLARO dentro de *asteriscos*; vago, hora exata sem "volto às…", texto fora dos asteriscos
        // e qualquer coisa dita no Espaço viram um botão de confirmação (chip). Todo salto automático tem "Desfazer".
        // ============================================================
        // >>RELOGIO-PURO (sem DOM, sem ST, sem IA: os testes em testes/ leem este trecho)
        const REL_MIN_RODADA = 5; // avanço normal por resposta (igual à v7)
        const REL_MAX_AUTO_DIAS = 60; // saltos maiores que isso nunca são automáticos
        const REL_NUMS = {
            um: 1,
            uma: 1,
            dois: 2,
            duas: 2,
            tres: 3,
            quatro: 4,
            cinco: 5,
            seis: 6,
            sete: 7,
            oito: 8,
            nove: 9,
            dez: 10,
            onze: 11,
            doze: 12,
            treze: 13,
            quatorze: 14,
            catorze: 14,
            quinze: 15,
            vinte: 20,
            trinta: 30,
            quarenta: 40,
            cinquenta: 50,
        };
        const REL_NUM_RE = '(\\d{1,3}|meia|' + Object.keys(REL_NUMS).join('|') + ')';
        const REL_UNID_RE = '(minutos?|horas?|dias?|semanas?)';
        const REL_UNID_MIN = { minuto: 1, hora: 60, dia: 1440, semana: 10080 };
        const REL_FAIXAS = { madrugada: [3, 0], manha: [8, 0], tarde: [14, 0], noite: [20, 0] };
        const pad2 = (n) => String(n).padStart(2, '0');
        const relSemAc = (s) =>
            String(s == null ? '' : s)
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '');
        const relNorm = (s) => relSemAc(s).toLowerCase().replace(/[-–—]/g, ' ').replace(/\s+/g, ' ').trim();
        function relQtd(tok) {
            if (tok === 'meia') return 0.5;
            return /^\d+$/.test(tok) ? parseInt(tok, 10) : REL_NUMS[tok] || 0;
        }
        function relUnidade(u) {
            return u.replace(/s$/, '');
        }
        function relRotuloMin(min) {
            const m = Math.round(min);
            if (m >= 1440) {
                const d = Math.floor(m / 1440),
                    r = m % 1440;
                return '+' + d + (d === 1 ? ' dia' : ' dias') + (r >= 60 ? ' e ' + Math.floor(r / 60) + ' h' : '');
            }
            if (m >= 60) {
                const h = Math.floor(m / 60),
                    r = m % 60;
                return '+' + h + ' h' + (r ? ' ' + r + ' min' : '');
            }
            return '+' + m + ' min';
        }
        const relTexto = (r) => 'dia ' + r.dia + ', ' + r.hora + 'h' + pad2(r.minuto); // vai pro prompt
        const relUI = (r) => 'Dia ' + r.dia + ' · ' + pad2(r.hora) + ':' + pad2(r.minuto); // vai pra tela
        function relFaixaEm(s) {
            // "de manhã", "à noite"... só vale junto com um salto de dias
            const m = s.match(/\b(?:de|pela|na|a|ao|naquela|durante a)\s+(madrugada|manha|tarde|noite)\b/);
            if (m) return REL_FAIXAS[m[1]];
            if (/\bamanhecer\b/.test(s)) return [6, 0];
            if (/\banoitecer\b/.test(s)) return [19, 0];
            if (/\bmeio dia\b/.test(s)) return [12, 0];
            return null;
        }
        function relHoraAbs(s) {
            // "às 13:46", "as 18h", "às 7h30", "são 18 horas"
            const m = s.match(/\b(?:as|pelas|por volta das|ja sao|sao)\s+(\d{1,2})\s*(?::|h|horas?)\s*(\d{2})?(?!\d)/);
            if (!m) return null;
            const h = parseInt(m[1], 10),
                mi = m[2] ? parseInt(m[2], 10) : 0;
            if (h > 23 || mi > 59) return null;
            return { h, m: mi, cue: /\b(volto|retorno|retornei|chego|cheguei|aparec\w*|ja sao|sao)\b/.test(s) };
        }
        // Acha UM salto de tempo num trecho. nivel 'auto' = claro; 'chip' = vago/absoluto sem verbo de retorno (só pergunta).
        function relAcharEm(seg) {
            let s = relNorm(seg).replace(/\bmais tarde\b/g, 'maistarde');
            // passado/duração ("faz dois dias", "há dois dias", "desde", "durante") NÃO é salto: tira antes de procurar
            s = s.replace(
                new RegExp(
                    '\\b(?:faz|fazia|faziam|fazem|ha|havia|haviam|desde|durante|por)\\s+(?:cerca de\\s+|quase\\s+|mais de\\s+)?' +
                        REL_NUM_RE +
                        '\\s+' +
                        REL_UNID_RE,
                    'g'
                ),
                ' '
            );
            const emeia = '(\\s+e meia)?';
            let m,
                add = null,
                trecho = '',
                vago = false,
                abs = null;
            const dur = (q, u, meia) => {
                let v = relQtd(q);
                if (!v) return null;
                const mi = u === 'hora' || u === 'minuto' || u === 'dia' || u === 'semana' ? REL_UNID_MIN[u] : 0;
                if (q === 'meia' && u !== 'hora') return null;
                return v * mi + (meia ? Math.round(mi / 2) : 0);
            }; // "e meia" = mais meia unidade (1h e meia = +30 min; 2 dias e meia = +12 h)
            if (
                (m = s.match(
                    new RegExp(
                        '\\bpass(?:aram|ou|am|a|ando)\\s+(?:se\\s+)?(?:cerca de\\s+|quase\\s+|mais de\\s+|uns\\s+|umas\\s+)?' +
                            REL_NUM_RE +
                            '\\s+' +
                            REL_UNID_RE +
                            emeia
                    )
                ))
            ) {
                add = dur(m[1], relUnidade(m[2]), m[3]);
                trecho = m[0];
            } else if (
                (m = s.match(
                    new RegExp('\\b' + REL_NUM_RE + '\\s+' + REL_UNID_RE + emeia + '\\s+(?:depois|maistarde|apos)\\b')
                ))
            ) {
                add = dur(m[1], relUnidade(m[2]), m[3]);
                trecho = m[0];
            } else if ((m = s.match(new RegExp('\\bdaqui a\\s+' + REL_NUM_RE + '\\s+' + REL_UNID_RE + emeia)))) {
                add = dur(m[1], relUnidade(m[2]), m[3]);
                trecho = m[0];
            } else if (
                (m = s.match(/\b(dia|manha|tarde|noite|madrugada) seguinte\b|\bno outro dia\b|\bno dia posterior\b/))
            ) {
                add = 1440;
                trecho = m[0];
                if (m[1] && m[1] !== 'dia') abs = { h: REL_FAIXAS[m[1]][0], m: 0, dia: true };
            }
            if (add == null && !abs) {
                // vago: só chip, com um palpite que o usuário confirma
                if (
                    (m = s.match(
                        /\b(?:algumas|poucas|varias|muitas)\s+(horas|minutos|dias)\s+(?:depois|maistarde|apos)\b|\b(horas|minutos|dias)\s+depois\b/
                    ))
                ) {
                    const u = m[1] || m[2];
                    add = u === 'horas' ? 120 : u === 'minutos' ? 20 : 2880;
                    vago = true;
                    trecho = m[0];
                } else if ((m = s.match(/\b(?:algum|um) tempo depois\b|\bpassado algum tempo\b|\bmaistarde\b/))) {
                    add = 60;
                    vago = true;
                    trecho = m[0];
                }
            }
            const faixa = relFaixaEm(s);
            const ha = relHoraAbs(s);
            if (add != null && add >= 1440 && !vago) {
                // dias + (faixa do dia | hora exata)
                if (ha) abs = { h: ha.h, m: ha.m, dia: true };
                else if (faixa && !abs) abs = { h: faixa[0], m: faixa[1], dia: true };
            }
            if (add == null && !abs) {
                if (ha)
                    return {
                        nivel: ha.cue ? 'auto' : 'chip',
                        tipo: 'abs',
                        addMin: 0,
                        setHora: [ha.h, ha.m],
                        abs: true,
                        vago: false,
                        trecho: 'às ' + ha.h + 'h' + (ha.m ? pad2(ha.m) : ''),
                    };
                return null;
            }
            return {
                nivel: vago ? 'chip' : 'auto',
                tipo: vago ? 'vago' : 'delta',
                addMin: add || 0,
                setHora: abs ? [abs.h, abs.m] : null,
                abs: false,
                vago,
                trecho,
            };
        }
        // Lê uma mensagem. 'rp': só a NARRAÇÃO entre *asteriscos* pode saltar sozinha; fora dela ou falas entre aspas, no máximo pergunta.
        // 'espaco': nunca é automático (é conversa de bastidor): sempre pergunta.
        function relInterpretar(texto, origem) {
            const t = String(texto || '');
            let segs = [],
                fora = t;
            if (origem === 'rp') {
                const re = /\*+([^*]+?)\*+/g;
                let m;
                while ((m = re.exec(t))) segs.push(m[1]);
                fora = t.replace(/\*+[^*]+?\*+/g, ' ');
            }
            fora = fora.replace(/["“”«»][^"“”«»]*["“”«»]/g, ' ');
            if (origem === 'rp')
                for (const s of segs) {
                    const r = relAcharEm(s);
                    if (r) return r;
                }
            const rf = relAcharEm(fora);
            if (rf) {
                rf.nivel = 'chip';
                return rf;
            }
            return null;
        }
        // Calcula o novo relógio e decide se pode ser automático. Não muda nada.
        function relPlanejar(rel, salto) {
            const antes = rel.dia * 1440 + rel.hora * 60 + rel.minuto;
            let total = antes,
                nivel = salto.nivel,
                rotulo;
            if (salto.addMin) total += salto.addMin;
            if (salto.setHora) {
                const alvoNoDia = Math.floor(total / 1440) * 1440 + salto.setHora[0] * 60 + salto.setHora[1];
                if (!salto.addMin && alvoNoDia <= antes) {
                    total = alvoNoDia + 1440;
                    nivel = 'chip';
                    rotulo = 'para o dia seguinte';
                } // "às 7h" quando já passou das 7h
                else total = alvoNoDia;
            }
            const delta = total - antes;
            if (delta > REL_MAX_AUTO_DIAS * 1440) nivel = 'chip';
            if (salto.abs && !salto.addMin && delta > 14 * 60) nivel = 'chip';
            const dia = Math.max(1, Math.floor(total / 1440)),
                resto = total - Math.floor(total / 1440) * 1440;
            return {
                nivel,
                para: { dia, hora: Math.floor(resto / 60), minuto: resto % 60 },
                deltaMin: delta,
                rotulo: rotulo || relRotuloMin(delta),
            };
        }

        // <<RELOGIO-PURO
        const relFalha = (e) => console.warn('[Spade] relógio:', e && e.message ? e.message : e);
        const relPadrao = () => ({ ligado: false, dia: 1, hora: 9, minuto: 0, historico: [], ultimoIdx: 0 });
        function relNormalizar(c) {
            const r = Object.assign(relPadrao(), c || {});
            r.ligado = !!r.ligado;
            r.dia = Math.max(1, Math.round(+r.dia) || 1);
            r.hora = Math.min(23, Math.max(0, Math.round(+r.hora) || 0));
            r.minuto = Math.min(59, Math.max(0, Math.round(+r.minuto) || 0));
            r.historico = Array.isArray(r.historico) ? r.historico.slice(-20) : [];
            r.ultimoIdx = Math.max(0, Math.round(+r.ultimoIdx) || 0);
            return r;
        }
        const relAtual = () => Mem.relogio || relPadrao();
        // v7 guardava UM relógio por personagem (banco antigo, só leitura aqui). Copia uma vez, pro primeiro chat que abrir.
        async function relMigrarLegado() {
            try {
                const marca = 'relmig|' + P();
                if (await locGet(marca)) return null;
                await locSet(marca, Date.now());
                const v7 = await estadoGet('mundo', null);
                if (!v7 || !(v7.dia >= 1)) return null;
                return {
                    ligado: true,
                    dia: v7.dia,
                    hora: v7.hora,
                    minuto: v7.minuto || 0,
                    ultimoIdx: (ctx().chat || []).length,
                    migradoDaV7: true,
                };
            } catch (_) {
                return null;
            }
        }
        async function relAplicarPlano(plano, motivo, { ligar } = {}) {
            await memCarregar();
            const r = Mem.relogio;
            const de = { dia: r.dia, hora: r.hora, minuto: r.minuto, ligado: r.ligado };
            r.dia = plano.para.dia;
            r.hora = plano.para.hora;
            r.minuto = plano.para.minuto;
            if (ligar) {
                r.ligado = true;
                r.ultimoIdx = (ctx().chat || []).length;
            }
            r.historico.push({ ts: Date.now(), de, para: Object.assign({}, plano.para), motivo: motivo || 'ajuste' });
            r.historico = r.historico.slice(-20);
            relSaltouNaRodada = true;
            await memSalvar('relogio');
            refrescarUI();
        }
        async function relDesfazer() {
            await memCarregar();
            const r = Mem.relogio;
            const h = r.historico.pop();
            if (!h) {
                toast('Nada para desfazer.');
                return;
            }
            r.dia = h.de.dia;
            r.hora = h.de.hora;
            r.minuto = h.de.minuto;
            r.ligado = !!h.de.ligado;
            await memSalvar('relogio');
            refrescarUI();
            toast('Voltei para ' + relUI(r) + '.');
        }
        let relSaltouNaRodada = false;
        // +5 min por RESPOSTA nova da personagem (swipe/regenerate não contam; salto narrado e +5 nunca juntos, como na v7)
        async function relRodada() {
            await memCarregar();
            const r = Mem.relogio;
            const n = (ctx().chat || []).length;
            if (n < r.ultimoIdx) {
                r.ultimoIdx = n;
                return;
            }
            if (n === r.ultimoIdx) return;
            r.ultimoIdx = n;
            if (!r.ligado) return;
            if (relSaltouNaRodada) relSaltouNaRodada = false;
            else {
                const p = relPlanejar(r, { addMin: REL_MIN_RODADA, nivel: 'auto' });
                r.dia = p.para.dia;
                r.hora = p.para.hora;
                r.minuto = p.para.minuto;
            }
            await memSalvar('relogio');
        }
        async function relLerMensagemUsuario(id) {
            const chat = ctx().chat || [];
            let m = chat[id];
            if (!m || !m.is_user)
                m = chat
                    .slice()
                    .reverse()
                    .find((x) => x.is_user && !x.is_system);
            if (!m) return;
            const salto = relInterpretar(m.mes, 'rp');
            if (!salto) return;
            await memCarregar();
            const r = Mem.relogio;
            if (!r.ligado && salto.nivel !== 'auto') return; // relógio desligado: só um salto claro liga (com "Desfazer")
            const plano = relPlanejar(r, salto);
            if (plano.nivel === 'auto') {
                const ligar = !r.ligado;
                await relAplicarPlano(plano, salto.trecho, { ligar });
                relChip({
                    texto: (ligar ? 'Relógio ligado · ' : '') + relUI(plano.para) + ' (' + plano.rotulo + ')',
                    botoes: [{ rotulo: 'Desfazer', fn: relDesfazer }],
                    ms: 12000,
                });
            } else
                relChip({
                    texto: 'Avançar ' + plano.rotulo + '? → ' + relUI(plano.para),
                    botoes: [
                        { rotulo: 'Avançar', fn: () => relAplicarPlano(plano, salto.trecho, { ligar: true }) },
                        { rotulo: 'Ignorar' },
                    ],
                    ms: 30000,
                });
        }
        async function relSugerirDoEspaco(texto) {
            const salto = relInterpretar(texto, 'espaco');
            if (!salto) return;
            await memCarregar();
            const plano = relPlanejar(Mem.relogio, salto);
            relChip({
                texto: 'Avançar ' + plano.rotulo + '? → ' + relUI(plano.para),
                botoes: [
                    { rotulo: 'Avançar', fn: () => relAplicarPlano(plano, salto.trecho, { ligar: true }) },
                    { rotulo: 'Ignorar' },
                ],
                ms: 30000,
            });
        }
        // ---- botão de confirmação (fica fora da janela: aparece mesmo com o painel fechado) ----
        const Chip = { el: null, timer: null, acoes: [] };
        function relChip({ texto, botoes, ms }) {
            if (!Chip.el) {
                Chip.el = document.createElement('div');
                Chip.el.id = 'spd-chip';
                document.body.appendChild(Chip.el);
                Chip.el.addEventListener('click', (e) => {
                    const b = e.target.closest('[data-i]');
                    if (!b) return;
                    const f = Chip.acoes[+b.dataset.i];
                    relChipFechar();
                    if (f)
                        Promise.resolve()
                            .then(f)
                            .catch((er) => {
                                console.warn('[Spade]', er);
                                toast(er.message || String(er), true);
                            });
                });
            }
            Chip.acoes = (botoes || []).map((b) => b.fn);
            Chip.el.innerHTML =
                '<span>' +
                esc(texto) +
                '</span>' +
                (botoes || []).map((b, i) => '<button data-i="' + i + '">' + esc(b.rotulo) + '</button>').join('');
            Chip.el.classList.add('on');
            clearTimeout(Chip.timer);
            Chip.timer = setTimeout(relChipFechar, ms || 15000);
        }
        function relChipFechar() {
            clearTimeout(Chip.timer);
            if (Chip.el) Chip.el.classList.remove('on');
        }
        // ---- cartão da tela Início ----
        function relCardHtml() {
            const r = relAtual();
            const h = r.historico.slice(-3).reverse();
            return (
                '<div class="spd-rel"><div class="spd-rel-topo"><div><small>Relógio da história</small><b>' +
                (r.ligado ? esc(relUI(r)) : 'desligado') +
                '</b></div><div class="spd-rel-bt">' +
                '<button class="spd-btn" data-a="rel-ajustar">Ajustar</button>' +
                (r.historico.length ? '<button class="spd-btn" data-a="rel-desfazer">Desfazer</button>' : '') +
                '<button class="spd-btn ' +
                (r.ligado ? '' : 'prim') +
                '" data-a="rel-toggle">' +
                (r.ligado ? 'Desligar' : 'Ligar') +
                '</button></div></div>' +
                (h.length
                    ? '<div class="spd-rel-h">' +
                      h.map((x) => esc(relUI(x.para) + ' · ' + (x.motivo || 'ajuste'))).join('<br>') +
                      '</div>'
                    : '') +
                '<div class="sub" style="margin-top:10px">Escreva <i>*passaram dois dias*</i> na narração e o relógio avança. Se for vago, ou estiver fora dos asteriscos, eu só pergunto.</div></div>'
            );
        }

        // ============================================================
        // 08 COMPOSITOR DO PROMPT (seção 9) — ordem FIXA, formato idêntico, nenhuma palavra da extensão
        //  1 QUEM ELA É · 2 REGRAS · 3 NOTAS · 4 MEMÓRIA · 5 NOTAS DO AUTOR · (6 chat: é do SillyTavern) · 7 ESTILO · 8 AGORA
        // O adendo A acrescentou o ESTILO; ele muda a cada resposta, então vai no FIM (volátil) e AGORA virou o 8.
        // Blocos 1–5 são o PREFIXO ESTÁVEL: idênticos byte a byte enquanto o usuário não mexer em nada (sem data, id ou contador).
        // ============================================================
        // ============================================================
        // 08D DOSSIÊ (8.9.0) — perfil grande de UMA personagem, escolhido pelo autor POR CHAT.
        //  · Inteiro: o texto normalizado completo vai no bloco 2.5 (sem resumo, sem corte).
        //  · Híbrido: SÓ com núcleo aceito para a versão atual do arquivo → núcleo (2.6) + trechos literais (6b).
        //  · Sem IA por turno. O seletor só ESCOLHE trechos (slice por offsets); nunca interpreta nem escreve instruções.
        // ============================================================
        // >>DOSSIE-PURO (sem DOM e sem ST: os testes leem as funções por globalThis.__SPADE_DOSSIE)
        const DOS_MODOS = ['desligado', 'hibrido', 'inteiro'];
        const DOS_CHAVES = ['SPADE_2D_PERFIL', 'SPADE_2H_NUCLEO', 'SPADE_6H_TRECHOS'];
        const dosNormalizar = (t) => String(t == null ? '' : t).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
        // hash de 53 bits (cyrb53) + tamanho: identifica a versão do texto
        function dosHash(s) {
            s = String(s);
            let h1 = 0xdeadbeef,
                h2 = 0x41c6ce57;
            for (let i = 0; i < s.length; i++) {
                const ch = s.charCodeAt(i);
                h1 = Math.imul(h1 ^ ch, 2654435761);
                h2 = Math.imul(h2 ^ ch, 1597334677);
            }
            h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
            h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
            return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + '.' + s.length;
        }
        const dosNormTitulo = (t) =>
            semAcento(String(t || ''))
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, ' ')
                .trim();
        const DOS_RE_NUM = /^\s{0,3}(?:#{1,6}\s*)?(\d{1,3})\s*[.)\-–—:]\s+(\S.{0,110})$/;
        const DOS_RE_MD = /^\s{0,3}#{1,3}\s+(\S.{0,110})$/;
        const DOS_RE_CONTINUA =
            /^\s*[-*•]?\s*(mas|por[eé]m|contudo|entretanto|no entanto|exceto|exce[cç][aã]o|salvo|somente|apenas|s[oó] |se |quando |caso |nunca|jamais|n[aã]o |ainda assim|por[eé]m)\b/i;
        // 8.9.1 — Entre os candidatos numerados, fica só a MAIOR sequência de números crescentes (os títulos de verdade
        // vão 1, 2, 3…; um item de lista dentro de uma seção reinicia em 1 ou repete um número e fica fora da cadeia).
        // Desempate: passos de +1, mesmo formato do resto ("34." ≠ "1)"), linha em branco antes. Nada é apagado: o item
        // descartado continua dentro do texto da seção em que está. Se a cadeia cobre ≤ metade dos candidatos
        // (numeração que reinicia por partes, por exemplo), não filtra: mantém o comportamento anterior.
        function dosCadeiaNumerada(cand) {
            const n = cand.length;
            if (n < 2) return cand;
            const freq = {};
            cand.forEach((c) => (freq[c.sig] = (freq[c.sig] || 0) + 1));
            const dom = Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0];
            const melhorQue = (a, b) => a.len - b.len || a.seq - b.seq || a.sg - b.sg || a.br - b.br;
            const dp = [];
            for (let j = 0; j < n; j++) {
                let b = { len: 1, seq: 0, sg: cand[j].sig === dom ? 1 : 0, br: cand[j].branco ? 1 : 0, prev: -1 };
                for (let i = 0; i < j; i++) {
                    if (cand[i].num >= cand[j].num) continue;
                    const p = dp[i];
                    const t = {
                        len: p.len + 1,
                        seq: p.seq + (cand[j].num === cand[i].num + 1 ? 1 : 0),
                        sg: p.sg + (cand[j].sig === dom ? 1 : 0),
                        br: p.br + (cand[j].branco ? 1 : 0),
                        prev: i,
                    };
                    if (melhorQue(t, b) > 0) b = t;
                }
                dp.push(b);
            }
            let fim = 0;
            for (let j = 1; j < n; j++) if (melhorQue(dp[j], dp[fim]) > 0) fim = j;
            if (dp[fim].len * 2 <= n) return cand;
            const ficam = [];
            for (let k = fim; k >= 0; k = dp[k].prev) ficam.push(k);
            return ficam.reverse().map((k) => cand[k]);
        }
        // Divide em Abertura + seções do corpo. Offsets `de`/`ate` valem para o texto NORMALIZADO (\r\n → \n).
        function dividirDossie(bruto) {
            const texto = dosNormalizar(bruto);
            const ls = [];
            let pos = 0;
            for (const l of texto.split('\n')) {
                ls.push({ txt: l, de: pos, fim: pos + l.length });
                pos += l.length + 1;
            }
            // candidatos numerados ("01. Título")
            let cand = [];
            ls.forEach((l, i) => {
                const m = l.txt.match(DOS_RE_NUM);
                if (m && l.txt.trim().length <= 120) {
                    const sg = l.txt.match(/^\s{0,3}(#{1,6})?\s*\d{1,3}\s*([.)\-–—:])/); // formato: com/sem # + pontuação ('.' ≠ ')')
                    cand.push({ i, titulo: m[2].trim(), de: l.de, fim: l.fim, num: +m[1], sig: (sg && (sg[1] ? '#' : '') + sg[2]) || '', branco: i === 0 || !ls[i - 1].txt.trim() });
                }
            });
            let usaNum = cand.length >= 3;
            let indice = null;
            if (usaNum) {
                // corridas de ≥3 candidatos adjacentes (só linhas vazias entre eles) = lista, não seções
                const runs = [];
                let run = [];
                const soVazio = (a, b) => {
                    for (let k = a + 1; k < b; k++) if (ls[k].txt.trim()) return false;
                    return true;
                };
                cand.forEach((c, k) => {
                    if (run.length && soVazio(run[run.length - 1].i, c.i)) run.push(c);
                    else {
                        if (run.length) runs.push(run);
                        run = [c];
                    }
                });
                if (run.length) runs.push(run);
                const listas = runs.filter((r) => r.length >= 3);
                const reais = runs.filter((r) => r.length < 3).flat();
                const nl = (t) => dosNormTitulo(t);
                for (const r of listas) {
                    const fimR = r[r.length - 1].i;
                    const depois = reais.filter((c) => c.i > fimR).map((c) => nl(c.titulo));
                    // também aceita títulos de outras corridas longas posteriores (corpo com seções coladas)
                    listas.forEach((o) => {
                        if (o !== r && o[0].i > fimR) o.forEach((c) => depois.push(nl(c.titulo)));
                    });
                    const bate = r.filter((c) => {
                        const t = nl(c.titulo);
                        return t.length >= 3 && depois.some((d) => d === t || (Math.min(d.length, t.length) >= 4 && (d.startsWith(t) || t.startsWith(d))));
                    }).length;
                    if (bate >= Math.ceil(r.length * 0.5) && !indice) indice = { de: r[0].de, ate: r[r.length - 1].fim, run: r };
                }
                // corpo = candidatos fora de corridas longas de lista, MAIS corridas longas que não são o índice mas
                // cujo corpo tem texto entre os itens (nunca: corrida longa sem texto entre itens = lista comum)
                cand = reais;
                if (indice) {
                    // outra corrida longa posterior não vira seção: é lista do corpo
                }
                // 8.9.1: lista numerada DENTRO de uma seção (ex.: "1) … 2) …" na seção 34) reinicia a contagem: não é título
                cand = dosCadeiaNumerada(cand);
            }
            let heads;
            if (usaNum && cand.length >= 1) heads = cand;
            else {
                heads = [];
                ls.forEach((l, i) => {
                    const m = l.txt.match(DOS_RE_MD);
                    if (m) heads.push({ i, titulo: m[1].trim(), de: l.de, fim: l.fim });
                });
                if (heads.length < 2) heads = [];
                usaNum = false;
            }
            const secoes = [];
            const fimUtil = (a, b) => {
                let e = b;
                while (e > a && /\s/.test(texto[e - 1])) e--;
                return e;
            };
            const add = (titulo, tipo, de, ate) => {
                const e = fimUtil(de, ate);
                let d = de;
                while (d < e && /\s/.test(texto[d])) d++;
                if (e > d) secoes.push({ id: 's' + secoes.length, titulo, tipo, de: d, ate: e });
            };
            if (!heads.length) {
                // sem títulos: blocos de parágrafos
                const ps = [];
                const re = /\S[\s\S]*?(?=\n\s*\n|$)/g;
                let m;
                while ((m = re.exec(texto))) ps.push({ de: m.index, ate: m.index + m[0].length });
                let atual = null;
                let n = 0;
                for (const p of ps) {
                    if (atual && p.ate - atual.de > 1500) {
                        add('Trecho ' + ++n, 'bloco', atual.de, atual.ate);
                        atual = null;
                    }
                    atual = atual ? { de: atual.de, ate: p.ate } : { de: p.de, ate: p.ate };
                }
                if (atual) add('Trecho ' + ++n, 'bloco', atual.de, atual.ate);
                return { texto, secoes, estrutura: 'paragrafos' };
            }
            const primeiro = heads[0].de;
            if (indice && indice.de < primeiro) {
                add('Abertura', 'abertura', 0, indice.de);
                add('Índice', 'indice', indice.de, indice.ate + 1);
                add('Abertura (continuação)', 'abertura', indice.ate + 1, primeiro);
            } else add('Abertura', 'abertura', 0, primeiro);
            heads.forEach((h, k) => add(h.titulo, 'secao', h.de, k + 1 < heads.length ? heads[k + 1].de : texto.length));
            return { texto, secoes, estrutura: usaNum ? 'numerado' : 'markdown' };
        }
        // Subtrechos por parágrafo (não corta frase, não separa "mas/exceto/somente quando…" do que veio antes)
        function dosTrechos(texto, secoes, maxChars) {
            maxChars = maxChars || 1500;
            const chunks = [];
            for (const s of secoes) {
                if (s.tipo === 'indice') continue;
                const ps = [];
                const re = /\S[\s\S]*?(?=\n\s*\n|$)/g;
                const base = texto.slice(s.de, s.ate);
                let m;
                while ((m = re.exec(base))) ps.push({ de: s.de + m.index, ate: s.de + m.index + m[0].length });
                // parágrafo gigante: parte em frases (nunca antes de continuação "mas…")
                const spans = [];
                for (const p of ps) {
                    if (p.ate - p.de <= maxChars * 2) {
                        spans.push(p);
                        continue;
                    }
                    const t = texto.slice(p.de, p.ate);
                    const rf = /[.!?…]+["”')\]]*\s+/g;
                    let ini = 0;
                    let mm;
                    const cortes = [];
                    while ((mm = rf.exec(t))) {
                        const fim = mm.index + mm[0].length;
                        if (DOS_RE_CONTINUA.test(t.slice(fim, fim + 40))) continue;
                        cortes.push(fim);
                    }
                    let corte0 = 0;
                    for (const c of cortes) {
                        if (c - corte0 >= maxChars) {
                            let fimC = c;
                            while (fimC > corte0 && /\s/.test(t[fimC - 1])) fimC--;
                            spans.push({ de: p.de + corte0, ate: p.de + fimC });
                            corte0 = c;
                        }
                    }
                    spans.push({ de: p.de + corte0, ate: p.ate });
                    void ini;
                }
                let atual = null;
                let k = 0;
                const fecha = () => {
                    if (!atual) return;
                    chunks.push({ id: s.id + '.' + k++, secId: s.id, secTitulo: s.titulo, de: atual.de, ate: atual.ate });
                    atual = null;
                };
                spans.forEach((p, idx) => {
                    if (atual) {
                        const soTitulo = idx === 1 && /^\s{0,3}(#{1,6}\s*)?\d{0,3}\s*[.)\-–—:]?\s*\S.{0,110}$/.test(texto.slice(atual.de, atual.ate)) && !/\n/.test(texto.slice(atual.de, atual.ate));
                        const cont = DOS_RE_CONTINUA.test(texto.slice(p.de, p.de + 40));
                        if (!soTitulo && !cont && p.ate - atual.de > maxChars) fecha();
                    }
                    atual = atual ? { de: atual.de, ate: p.ate } : { de: p.de, ate: p.ate };
                });
                fecha();
            }
            return chunks;
        }
        // Raízes significativas de um texto, na ordem (para bigramas)
        function dosRaizes(txt, ignorar) {
            const out = [];
            for (const w of words(txt)) {
                if (w.length < 3 || /^\d+$/.test(w) || ehStop(w)) continue;
                const r = radicalPtBr(w);
                if (ignorar && ignorar.has(r)) continue;
                out.push({ r, f: semAcento(w) });
            }
            return out;
        }
        function dosIndexar(texto, secoes, ignorar) {
            const chunks = dosTrechos(texto, secoes);
            const df = new Map();
            for (const c of chunks) {
                const rs = dosRaizes(texto.slice(c.de, c.ate), ignorar);
                c.raizes = new Map();
                c.formas = new Set();
                for (const x of rs) {
                    c.raizes.set(x.r, (c.raizes.get(x.r) || 0) + 1);
                    c.formas.add(x.f);
                }
                c.bigr = new Set();
                for (let i = 0; i + 1 < rs.length; i++) c.bigr.add(rs[i].r + '|' + rs[i + 1].r);
                c.tit = new Set(dosRaizes(c.secTitulo, ignorar).map((x) => x.r));
                c.tokens = estimarTokens(texto.slice(c.de, c.ate)) + 2;
                for (const r of c.raizes.keys()) df.set(r, (df.get(r) || 0) + 1);
            }
            return { chunks, df, N: chunks.length };
        }
        // consulta: { atual: texto, recentes: [texto mais recente primeiro], fatos: [texto] }
        function dosConsulta(q, ignorar) {
            const mapa = new Map(); // raiz → { peso, formas:Set, atual }
            const bigr = []; // { chave, peso }
            const PESO_ATUAL = 4;
            const PESOS_REC = [1.2, 0.8, 0.5, 0.35, 0.25, 0.2, 0.15, 0.1];
            const soma = (txt, peso, ehAtual) => {
                const rs = dosRaizes(txt, ignorar);
                const vistos = new Set();
                for (const x of rs) {
                    let e = mapa.get(x.r);
                    if (!e) mapa.set(x.r, (e = { peso: 0, formas: new Set(), atual: false }));
                    e.formas.add(x.f);
                    if (!vistos.has(x.r)) {
                        e.peso += peso;
                        vistos.add(x.r);
                    }
                    if (ehAtual) e.atual = true;
                }
                for (let i = 0; i + 1 < rs.length; i++) bigr.push({ chave: rs[i].r + '|' + rs[i + 1].r, peso });
            };
            if (q.atual) soma(q.atual, PESO_ATUAL, true);
            (q.recentes || []).forEach((t, i) => soma(t, PESOS_REC[Math.min(i, PESOS_REC.length - 1)], false));
            (q.fatos || []).forEach((t) => soma(t, 0.3, false));
            const atualInformativo = q.atual ? dosRaizes(q.atual, ignorar).length >= 2 : false;
            return { mapa, bigr, atualInformativo };
        }
        function dosPontuar(c, idx, cons) {
            let score = 0;
            const achadas = new Map(); // raiz → { exata, atual }
            for (const [r, e] of cons.mapa) {
                const n = c.raizes.get(r);
                if (!n) continue;
                const df = idx.df.get(r) || 1;
                if (idx.N >= 8 && df / idx.N > 0.35) continue; // palavra comum demais no perfil (nome, empresa…)
                const idf = Math.log(1 + idx.N / df);
                const exata = [...e.formas].some((f) => c.formas.has(f));
                let s = e.peso * idf * Math.min(2, 1 + Math.log(n)) * (exata ? 1 : 0.6);
                if (c.tit.has(r)) s += e.peso * idf * 0.8;
                score += s;
                achadas.set(r, { exata, atual: e.atual, df, formas: [...e.formas] });
            }
            let bonus = 0;
            for (const b of cons.bigr) if (c.bigr.has(b.chave)) bonus += b.peso * 1.2;
            score += bonus;
            const distintas = achadas.size;
            let qualifica = distintas >= 2;
            if (!qualifica && distintas === 1) {
                const [, a] = [...achadas.entries()][0];
                qualifica = a.exata && idx.N > 0 && a.df / idx.N <= 0.15;
            }
            if (qualifica && cons.atualInformativo && ![...achadas.values()].some((a) => a.atual)) qualifica = false;
            return { score, achadas, qualifica };
        }
        const dosJaccard = (a, b) => {
            const A = new Set(a.raizes.keys());
            let inter = 0;
            for (const x of b.raizes.keys()) if (A.has(x)) inter++;
            const uni = A.size + b.raizes.size - inter;
            return uni ? inter / uni : 0;
        };
        // Escolhe 2–4 trechos (padrão) dentro do orçamento. Devolve só IDs/offsets/motivos; o texto vem do slice().
        function dosSelecionar(texto, idx, q, opts) {
            opts = opts || {};
            const maxTrechos = opts.maxTrechos || 4;
            const orcamento = opts.orcamento || 2200;
            const cons = dosConsulta(q, opts.ignorar);
            const pont = idx.chunks
                .map((c) => ({ c, p: dosPontuar(c, idx, cons) }))
                .filter((x) => x.p.qualifica && x.p.score >= 2)
                .sort((a, b) => b.p.score - a.p.score || a.c.de - b.c.de);
            const avisos = [];
            const escolhidos = [];
            if (!pont.length) {
                avisos.push('Nenhum trecho do perfil combinou com esta cena: só o núcleo e a memória foram usados.');
                return { escolhidos, avisos, tokens: 0, candidatos: 0 };
            }
            const topo = pont[0].p.score;
            let usado = 0;
            const porSecao = new Map();
            for (const x of pont) {
                if (escolhidos.length >= maxTrechos) break;
                if (x.p.score < topo * 0.3) break;
                if ((porSecao.get(x.c.secId) || 0) >= 2) continue;
                if (usado + x.c.tokens > orcamento) continue;
                if (escolhidos.some((e) => dosJaccard(e._c, x.c) > 0.6)) continue;
                const motivo =
                    'palavras: ' +
                    [...x.p.achadas.values()]
                        .flatMap((a) => a.formas)
                        .slice(0, 5)
                        .join(', ');
                escolhidos.push({
                    id: x.c.id,
                    secao: x.c.secTitulo,
                    de: x.c.de,
                    ate: x.c.ate,
                    texto: texto.slice(x.c.de, x.c.ate),
                    tokens: x.c.tokens,
                    score: Math.round(x.p.score * 10) / 10,
                    motivo,
                    _c: x.c,
                });
                usado += x.c.tokens;
                porSecao.set(x.c.secId, (porSecao.get(x.c.secId) || 0) + 1);
            }
            escolhidos.forEach((e) => delete e._c);
            if (!escolhidos.length) avisos.push('Os trechos encontrados não couberam no orçamento: só o núcleo e a memória foram usados.');
            if (escolhidos.length && topo < 6) avisos.push('Combinação fraca com a cena (baixa confiança).');
            return { escolhidos, avisos, tokens: usado, candidatos: pont.length };
        }
        // Texto final dos blocos (puro): modo + estado → { perfil, nucleo, trechos, info }
        function dosTextoInteiro(texto) {
            return '## PERFIL COMPLETO\n' + texto;
        }
        function dosTextoNucleo(n) {
            return '## PERFIL DA PERSONAGEM\n' + String(n).trim();
        }
        function dosTextoTrechos(escolhidos) {
            return escolhidos.length ? '## TRECHOS DO PERFIL\n' + escolhidos.map((e) => e.texto).join('\n\n---\n\n') : '';
        }
        // Mensagens pro job de preparar o núcleo (sem chamada aqui)
        const DOS_INSTRUCAO_NUCLEO =
            'Você prepara o NÚCLEO PERMANENTE de uma personagem de roleplay a partir do perfil completo dela. ' +
            'Escreva em português do Brasil, em terceira pessoa e no presente, entre 900 e 1.400 tokens (nunca mais de 1.800). ' +
            'Explique: identidade, papel profissional, valores, motivações, padrões de comportamento, exceções importantes e como a relação com outras pessoas pode evoluir. ' +
            'Descreva PRINCÍPIOS de comportamento, não frases de exemplo para copiar; não faça lista mecânica de comandos, clichês ou proibições. ' +
            'Preserve condições e exceções ("faz X, mas só quando Y"). Não invente nada que não esteja no perfil. ' +
            'Responda apenas com o texto do núcleo, sem título, sem comentários e sem blocos de código.';
        function dosAgruparParaNucleo(texto, secoes, maxTokens) {
            const grupos = [];
            let atual = '';
            for (const s of secoes) {
                if (s.tipo === 'indice') continue;
                const t = texto.slice(s.de, s.ate);
                if (atual && estimarTokens(atual + '\n\n' + t) > maxTokens) {
                    grupos.push(atual);
                    atual = '';
                }
                atual = atual ? atual + '\n\n' + t : t;
            }
            if (atual) grupos.push(atual);
            return grupos;
        }
        // <<DOSSIE-PURO

        // ---- estado, cache e associação (por chat) ----
        const DOS_CHAT_KEY = 'spade_dossie_chat_v1';
        const Dos = { cache: null, promessa: null, erro: '', preparando: null, verId: null, verTexto: '' };
        function dosAssocLer() {
            try {
                return JSON.parse(localStorage.getItem(DOS_CHAT_KEY) || '{}') || {};
            } catch (_) {
                return {};
            }
        }
        function dosAssocDe(chatId) {
            const m = dosAssocLer()[chatId];
            return m && m.personagem === P() ? m.arq : null;
        }
        function dosAssocSet(chatId, arqId) {
            const m = dosAssocLer();
            if (!arqId) delete m[chatId];
            else m[chatId] = { arq: arqId, personagem: P() };
            try {
                localStorage.setItem(DOS_CHAT_KEY, JSON.stringify(m));
            } catch (e) {
                throw new Error('Não consegui guardar a escolha do perfil deste chat: ' + e.message);
            }
        }
        const listaDossies = () => Array.from(Bib.arquivos.values()).filter((a) => a.meta && a.meta.tipo === 'dossie');
        const dosRev = (a) => String(a.meta.editadoEm || 0) + '|' + String(a.meta.dossieRev || 0);
        // Quem é o perfil deste chat AGORA (sempre reconsultado; nunca "o último usado")
        function dosResolver() {
            const chatId = stChatIdAtual();
            if (!chatId) return { ok: false, motivo: 'Este chat não tem identificação segura: nenhum perfil será usado.' };
            if (!Bib.carregada || Bib.personagem !== P()) return { ok: false, chatId, motivo: 'A Biblioteca ainda está carregando.' };
            const id = dosAssocDe(chatId);
            if (!id) return { ok: false, chatId, nenhum: true, motivo: 'Nenhum perfil escolhido para este chat.' };
            const arq = Bib.arquivos.get(id);
            if (!arq || !arq.meta || arq.meta.tipo !== 'dossie')
                return { ok: false, chatId, arqId: id, motivo: 'O perfil escolhido para este chat não existe mais. Escolha outro ou “Nenhum”.' };
            return { ok: true, chatId, arqId: id, arq };
        }
        const dosCacheBate = (r) =>
            !!(Dos.cache && r.ok && Dos.cache.chatId === r.chatId && Dos.cache.arqId === r.arqId && Dos.cache.personagem === P() && Dos.cache.rev === dosRev(r.arq));
        function dosIgnorarNomes() {
            const s = new Set();
            const c = ctx();
            [personagemAtual(), c.name1, c.name2].forEach((n) => words(n || '').forEach((w) => s.add(radicalPtBr(w))));
            return s;
        }
        async function dossieSincronizar(forcar) {
            if (Dos.promessa && !forcar) return Dos.promessa;
            const rodar = async () => {
                const r = dosResolver();
                if (!r.ok) {
                    Dos.cache = null;
                    return r;
                }
                if (!forcar && dosCacheBate(r)) return r;
                const d = await Disco.arqLer(r.arqId, ['original']);
                const texto0 = dosNormalizar(d.original || '');
                const dv = dividirDossie(texto0);
                const ign = dosIgnorarNomes();
                const idx = dosIndexar(dv.texto, dv.secoes, ign);
                const r2 = dosResolver(); // o chat pode ter mudado durante a leitura
                if (!r2.ok || r2.arqId !== r.arqId || r2.chatId !== r.chatId) {
                    Dos.cache = null;
                    return r2;
                }
                Dos.cache = {
                    chatId: r.chatId,
                    personagem: P(),
                    arqId: r.arqId,
                    rev: dosRev(r.arq),
                    hash: dosHash(dv.texto),
                    texto: dv.texto,
                    tokens: estimarTokens(dv.texto),
                    secoes: dv.secoes,
                    estrutura: dv.estrutura,
                    idx,
                    ignorar: ign,
                    nome: r.arq.meta.titulo || r.arq.meta.nome,
                };
                Dos.erro = '';
                return r2;
            };
            Dos.promessa = rodar()
                .catch((e) => {
                    Dos.cache = null;
                    Dos.erro = e.message || String(e);
                    console.warn('[Spade] dossiê:', e);
                    return { ok: false, motivo: 'Falha ao ler o perfil: ' + Dos.erro };
                })
                .finally(() => {
                    Dos.promessa = null;
                });
            return Dos.promessa;
        }
        const dosNucleoDe = (a) => (a && a.meta && a.meta.dossie && a.meta.dossie.nucleo) || {};
        const dosNucleoAceitoValido = (a, hash) => {
            const n = dosNucleoDe(a).aceito;
            return !!(n && n.texto && String(n.texto).trim() && hash && n.hash === hash);
        };
        // Consulta da cena para o Híbrido (só o chat atual; respostas descartadas ficam de fora)
        function dosConsultaDaCena(cfg, substituicao) {
            const msgs = chatRealRecente(Math.max(2, cfg.hibridoContextoMsgs | 0) + 2, 700);
            if (substituicao && msgs.length && !msgs[msgs.length - 1].ehUsuario) msgs.pop();
            let ia = -1;
            for (let i = msgs.length - 1; i >= 0; i--)
                if (msgs[i].ehUsuario) {
                    ia = i;
                    break;
                }
            const atual = ia >= 0 ? msgs[ia].texto : '';
            const recentes = msgs
                .filter((_, i) => i !== ia)
                .slice(-Math.max(1, cfg.hibridoContextoMsgs | 0))
                .reverse()
                .map((m) => m.texto);
            let fatos = [];
            if (Mem.chatId && Mem.chatId === chatIdParaDisco() && Mem.personagem === P())
                fatos = (Mem.rp.fatos || []).filter(sabeFato).slice(-8).map((f) => f.texto);
            return { atual, recentes, fatos };
        }
        // Síncrona: só lê o cache já preparado. Devolve os 3 textos + o que a Prévia mostra.
        function dosBlocos(cfg, opts) {
            opts = opts || {};
            const modo = DOS_MODOS.includes(cfg.dossieModo) ? cfg.dossieModo : 'desligado';
            const info = { modo, estado: 'desligado', motivo: '', avisos: [], chatId: stChatIdAtual(), nome: null, perfilTokens: 0, nucleoTokens: 0, trechos: [], hash: null, secoes: 0, pct: null, contextSize: Diag.contextSize || null };
            const vazio = { perfil: '', nucleo: '', trechos: '', info };
            if (modo === 'desligado') return vazio;
            const r = dosResolver();
            if (!r.ok) {
                info.estado = 'sem-perfil';
                info.motivo = r.motivo;
                return vazio;
            }
            info.nome = r.arq.meta.titulo || r.arq.meta.nome;
            if (!dosCacheBate(r)) {
                info.estado = 'carregando';
                info.motivo = Dos.erro ? 'Falha ao ler o perfil: ' + Dos.erro : 'O perfil ainda não foi lido do disco.';
                return vazio;
            }
            const c = Dos.cache;
            info.hash = c.hash;
            info.secoes = c.secoes.filter((s) => s.tipo === 'secao').length;
            if (modo === 'inteiro') {
                info.perfilTokens = c.tokens;
                const cs = Diag.contextSize;
                if (c.tokens > cfg.dossieLimiteTokens) {
                    info.estado = 'inativo';
                    info.motivo = 'O perfil (~' + c.tokens + ' tokens) passa do limite configurado (' + cfg.dossieLimiteTokens + '). Nada foi cortado nem enviado: aumente o limite, escolha outro perfil ou mude de modo.';
                    return vazio;
                }
                if (cs && c.tokens >= cs) {
                    info.estado = 'inativo';
                    info.motivo = 'O perfil (~' + c.tokens + ' tokens) não cabe no contexto configurado (' + cs + '). Nada foi cortado nem enviado: aumente o contexto no SillyTavern, escolha outro perfil ou mude de modo.';
                    return vazio;
                }
                if (cs) {
                    info.pct = Math.round((c.tokens / cs) * 100);
                    if (c.tokens / cs > 0.4)
                        info.avisos.push('O perfil ocupa aproximadamente ' + info.pct + '% do contexto configurado (' + c.tokens + ' de ' + cs + ' tokens). Conversas antigas podem ser cortadas.');
                } else info.avisos.push('O tamanho real do contexto ainda não foi confirmado (gere uma fala para a Spade ler): não dá para garantir que o perfil cabe.');
                info.estado = 'ativo';
                return { perfil: dosTextoInteiro(c.texto), nucleo: '', trechos: '', info };
            }
            // híbrido
            const aceito = dosNucleoDe(r.arq).aceito;
            if (!dosNucleoAceitoValido(r.arq, c.hash)) {
                info.estado = 'inativo';
                info.motivo = aceito && aceito.texto
                    ? 'Híbrido inativo: o perfil mudou desde que o núcleo foi aceito. Revise e aceite o núcleo de novo.'
                    : 'Híbrido inativo: falta aceitar o núcleo. Prepare e aceite um núcleo para ativar a memória adaptativa.';
                return vazio;
            }
            const nuc = dosTextoNucleo(aceito.texto);
            info.nucleoTokens = estimarTokens(nuc);
            const q = dosConsultaDaCena(cfg, !!opts.substituicao);
            let sel;
            try {
                sel = dosSelecionar(c.texto, c.idx, q, { maxTrechos: cfg.hibridoMaxTrechos || 4, orcamento: cfg.hibridoTrechosTokens || 2200, ignorar: c.ignorar });
            } catch (e) {
                console.warn('[Spade] seleção do perfil:', e);
                sel = { escolhidos: [], avisos: ['A busca local falhou (' + e.message + '): só o núcleo e a memória foram usados.'], tokens: 0 };
            }
            info.trechos = sel.escolhidos;
            info.avisos.push(...sel.avisos);
            info.estado = 'ativo';
            return { perfil: '', nucleo: nuc, trechos: dosTextoTrechos(sel.escolhidos), info };
        }
        function dosLimparSlots() {
            try {
                const c = ctx();
                if (typeof c.setExtensionPrompt !== 'function') return;
                const T = tiposDoST();
                const topo = getConfig().posicaoTopo === 'before_prompt' ? T.BEFORE_PROMPT : T.IN_PROMPT;
                c.setExtensionPrompt('SPADE_2D_PERFIL', '', topo, 0, false, T.SYSTEM);
                c.setExtensionPrompt('SPADE_2H_NUCLEO', '', topo, 0, false, T.SYSTEM);
                c.setExtensionPrompt('SPADE_6H_TRECHOS', '', T.IN_CHAT, 0, false, T.SYSTEM);
                DOS_CHAVES.forEach((k) => {
                    Diag.slotsAplicados[k] = { tokens: 0 };
                });
            } catch (e) {
                console.warn('[Spade] limpar slots do perfil:', e.message);
            }
        }
        // ---- preparar o núcleo (clique do autor; nunca por turno) ----
        async function dossiePrepararNucleo(a) {
            const cfg = getConfig();
            const d = await Disco.arqLer(a.id, ['original']);
            const texto = dosNormalizar(d.original || '');
            if (!texto.trim()) throw new Error('O arquivo está vazio.');
            const dv = dividirDossie(texto);
            const modelo = cfg.modeloNucleo || cfg.modelo;
            let saida;
            let partes = 1;
            const tk = estimarTokens(texto);
            if (tk <= 45000) {
                saida = await generate(
                    [
                        { role: 'system', content: DOS_INSTRUCAO_NUCLEO },
                        { role: 'user', content: 'PERFIL COMPLETO:\n\n' + texto },
                    ],
                    { model: modelo, maxTokens: 3000, timeoutMs: 300000 }
                );
            } else {
                const grupos = dosAgruparParaNucleo(dv.texto, dv.secoes, 30000);
                partes = grupos.length;
                const parciais = [];
                for (let i = 0; i < grupos.length; i++)
                    parciais.push(
                        await generate(
                            [
                                { role: 'system', content: DOS_INSTRUCAO_NUCLEO.replace('entre 900 e 1.400 tokens (nunca mais de 1.800)', 'em até 700 tokens (é uma PARTE do perfil)') },
                                { role: 'user', content: 'PARTE ' + (i + 1) + ' DE ' + grupos.length + ' DO PERFIL:\n\n' + grupos[i] },
                            ],
                            { model: modelo, maxTokens: 2000, timeoutMs: 300000 }
                        )
                    );
                saida = await generate(
                    [
                        { role: 'system', content: DOS_INSTRUCAO_NUCLEO + ' Você recebe notas parciais, uma por parte do perfil: una tudo num único núcleo coerente.' },
                        { role: 'user', content: 'NOTAS PARCIAIS:\n\n' + parciais.map((p, i) => '[Parte ' + (i + 1) + ']\n' + p).join('\n\n') },
                    ],
                    { model: modelo, maxTokens: 3000, timeoutMs: 300000 }
                );
            }
            const meta = a.meta;
            meta.dossie = meta.dossie || {};
            meta.dossie.nucleo = Object.assign({}, meta.dossie.nucleo, {
                proposta: { texto: String(saida).trim(), hash: dosHash(dv.texto), em: Date.now(), partes },
            });
            // o rascunho editado pelo autor NÃO é sobrescrito se ele já tinha editado algo diferente da proposta antiga
            if (!meta.dossie.nucleo.rascunho) meta.dossie.nucleo.rascunho = String(saida).trim();
            await salvarMetaArq(a);
            return { partes, tokens: estimarTokens(saida) };
        }
        async function dossieAceitarNucleo(a, texto) {
            const cfg = getConfig();
            const t = String(texto || '').trim();
            if (!t) throw new Error('O núcleo está vazio.');
            const tk = estimarTokens(t);
            if (tk > cfg.nucleoLimiteTokens)
                throw new Error('O núcleo tem ~' + tk + ' tokens e o limite é ' + cfg.nucleoLimiteTokens + '. Encurte ou aumente o limite na aba Dossiê.');
            const d = await Disco.arqLer(a.id, ['original']);
            const hash = dosHash(dosNormalizar(d.original || ''));
            const meta = a.meta;
            meta.dossie = meta.dossie || {};
            const antigo = (meta.dossie.nucleo || {}).aceito;
            meta.dossie.nucleo = Object.assign({}, meta.dossie.nucleo, {
                rascunho: t,
                aceito: { texto: t, hash, em: Date.now() },
                anterior: antigo || (meta.dossie.nucleo || {}).anterior || null,
            });
            await salvarMetaArq(a);
        }
        // Prévia: o que o interceptor entregou ao ST (para achar resíduo de outro modo)
        function dosResiduos(p) {
            const o = [];
            if (!Diag.ultimoPrompt) return o;
            const tit = { SPADE_2D_PERFIL: 'PERFIL COMPLETO', SPADE_2H_NUCLEO: 'PERFIL DA PERSONAGEM', SPADE_6H_TRECHOS: 'TRECHOS DO PERFIL' };
            for (const k of DOS_CHAVES) {
                const b = p.blocos.find((x) => x.chave === k);
                let n = 0;
                Diag.ultimoPrompt.forEach((m) => {
                    n += String(m.content).split('## ' + tit[k] + '\n').length - 1;
                });
                if (n > 1) o.push('“' + tit[k] + '” aparece ' + n + ' vezes no último prompt enviado (duplicado).');
                if (n >= 1 && (!b || !b.texto)) o.push('“' + tit[k] + '” estava no último prompt enviado, mas não está ativo agora (resíduo de modo/chat anterior; gere uma fala para atualizar).');
            }
            return o;
        }
        globalThis.__SPADE_DOSSIE = { dividirDossie, dosCadeiaNumerada, dosTrechos, dosIndexar, dosSelecionar, dosHash, dosNormalizar, dosTextoInteiro, dosTextoNucleo, dosTextoTrechos };

        const BLOCOS = [
            { n: 1, chave: 'SPADE_1_QUEM', titulo: 'QUEM ELA É', zona: 'topo' },
            { n: 2, chave: 'SPADE_2_REGRAS', titulo: 'REGRAS', zona: 'topo' },
            // 8.9.0 — perfil (só com um dossiê escolhido para ESTE chat). 2.5 = Inteiro · 2.6 = núcleo aceito (Híbrido)
            { n: 2.5, chave: 'SPADE_2D_PERFIL', titulo: 'PERFIL COMPLETO', zona: 'topo' },
            { n: 2.6, chave: 'SPADE_2H_NUCLEO', titulo: 'PERFIL DA PERSONAGEM', zona: 'topo' },
            { n: 3, chave: 'SPADE_3_NOTAS', titulo: 'NOTAS', zona: 'topo' },
            { n: 4, chave: 'SPADE_4_MEMORIA', titulo: 'MEMÓRIA', zona: 'topo' },
            { n: 5, chave: 'SPADE_5_AUTOR', titulo: 'NOTAS DO AUTOR', zona: 'fim1' },
            // 8.3: só tem texto no modo "por cena". Muda a cada resposta, então fica no FIM (volátil), antes do ESTILO.
            { n: '6a', chave: 'SPADE_6_CENA', titulo: 'NOTAS DA CENA', zona: 'fim0' },
            { n: '6b', chave: 'SPADE_6H_TRECHOS', titulo: 'TRECHOS DO PERFIL', zona: 'fim0' }, // 8.9.0: volátil (muda com a cena)
            { n: 7, chave: 'SPADE_7_ESTILO', titulo: 'ESTILO', zona: 'fim0' },
            { n: 8, chave: 'SPADE_8_AGORA', titulo: 'AGORA', zona: 'fim0' },
        ];
        // Bloco 5 — pedidos do usuário no Espaço, LITERAIS (12.2). Respostas da IA do Espaço nunca entram.
        function blocoAutor(orcamento) {
            const duraveis = (Mem.espaco.pedidos || []).map((p) => p.texto);
            const recentes = espacoPedidosRecentes().map((m) => m.texto);
            const fmt = (t) => {
                const ls = String(t)
                    .split(/\r?\n/)
                    .map((l) => l.trim())
                    .filter(Boolean);
                return ls.length ? '- ' + ls.join('\n  ') : '';
            };
            const fora = [];
            let usado = 0;
            const manter = (lista, rotulo) => {
                const ok = [];
                for (const t of lista.slice().reverse()) {
                    const c = estimarTokens(fmt(t)) + 1;
                    if (usado + c > orcamento) {
                        fora.push({ texto: t, motivo: 'fora do orçamento (' + rotulo + ')' });
                        continue;
                    }
                    usado += c;
                    ok.unshift(t);
                }
                return ok;
            };
            const rec = manter(recentes, 'pedido recente');
            const dur = manter(duraveis, 'pedido duradouro'); // o mais novo vale mais: recentes primeiro
            const secoes = [];
            if (dur.length) secoes.push('### Pedidos que continuam valendo\n' + dur.map(fmt).join('\n'));
            if (rec.length) secoes.push('### Pedidos recentes do autor\n' + rec.map(fmt).join('\n'));
            return { texto: secoes.length ? '## NOTAS DO AUTOR\n' + secoes.join('\n') : '', fora };
        }
        function blocoAgora(substituicao) {
            const rep = medirRepeticao(falasParaRepeticao(substituicao), getConfig().tiquesCadastrados);
            const ev = textoEvitar(rep);
            const partes = [formatarItem('Antes de responder', instrucaoPensamento())];
            const rel = relAtual();
            if (rel.ligado) partes.unshift(formatarItem('Momento da história', relTexto(rel) + '.')); // 12.6 (sem palavras da extensão)
            const rtTextos = rtTextosAgora(); // 15 (8.6.0): "### Interrupção" e "### Pensamento adiantado", só no bloco AGORA
            if (rtTextos.length) partes.splice(rel.ligado ? 1 : 0, 0, ...rtTextos);
            if (ev) partes.push('### Evitar\n' + ev);
            partes.push(formatarItem('Resposta', INSTRUCAO_RESPOSTA));
            return { texto: '## AGORA\n' + partes.join('\n'), repeticao: rep };
        }
        function montarPrompt(opts = {}) {
            const cfg = getConfig();
            const avisos = [];
            const modoBib = cfg.modoBiblioteca === 'cena' ? 'cena' : 'tudo';
            let sel;
            let cenaSel = [];
            let foraCena = [];
            let cenaTags = [];
            if (modoBib === 'cena') {
                const r = selecionarPorCena(itensDaBiblioteca(), cfg.limiteBiblioteca, {
                    max: cfg.cenaMaxNotas,
                    substituicao: !!opts.substituicao,
                });
                sel = { escolhidos: r.escolhidos, fora: r.fora, usado: r.usado };
                cenaSel = r.cenaEscolhidos;
                foraCena = r.foraCena;
                cenaTags = r.tagsReconhecidas || [];
            } else sel = selecionarNotas(itensDaBiblioteca(), cfg.limiteBiblioteca);
            const mem = blocoMemoria(cfg.limiteRp);
            const autor = blocoAutor(cfg.limiteEspaco);
            const agora = blocoAgora(!!opts.substituicao);
            const estilo = blocoEstilo();
            const dos = dosBlocos(cfg, opts);
            const textos = {
                1: blocoDescricao(),
                2: blocoRegras(),
                '2.5': dos.perfil,
                '2.6': dos.nucleo,
                3: sel.escolhidos.length ? '## NOTAS\n' + sel.escolhidos.map((e) => e.texto).join('\n') : '',
                4: mem.texto,
                5: autor.texto,
                '6a': cenaSel.length ? '## NOTAS DA CENA\n' + cenaSel.map((e) => e.texto).join('\n') : '',
                '6b': dos.trechos,
                7: estilo.texto,
                8: agora.texto,
            };
            const blocos = BLOCOS.map((b) => ({
                n: b.n,
                chave: b.chave,
                titulo: b.titulo,
                zona: b.zona,
                texto: textos[b.n] || '',
                tokens: textos[b.n] ? estimarTokens(textos[b.n]) : 0,
            }));
            // 8.9.0: o perfil fica FORA do limite geral (só interface); continua contando na janela real e no custo
            const total = blocos.filter((b) => !DOS_CHAVES.includes(b.chave)).reduce((a, b) => a + b.tokens, 0);
            const totalDossie = blocos.filter((b) => DOS_CHAVES.includes(b.chave)).reduce((a, b) => a + b.tokens, 0);
            const bloco = (k) => blocos.find((b) => b.chave === k) || { tokens: 0 };
            const soma = cfg.limiteRp + cfg.limiteEspaco + cfg.limiteBiblioteca;
            if (soma > cfg.limiteGeral)
                avisos.push(
                    'A soma dos limites das gavetas (' + soma + ') passa do limite geral (' + cfg.limiteGeral + ').'
                );
            if (total > cfg.limiteGeral)
                avisos.push(
                    'O que a Spade injeta (' +
                        total +
                        ' tokens) passa do limite geral (' +
                        cfg.limiteGeral +
                        '). Nada foi cortado: ajuste os limites ou desligue notas.'
                );
            const dt = bloco('SPADE_1_QUEM').tokens;
            if (dt > cfg.limiteDescricao)
                avisos.push('A Descrição tem ' + dt + ' tokens (sugerido: até ' + cfg.limiteDescricao + ').');
            dos.info.avisos.forEach((v) => avisos.push(v));
            if (dos.info.modo !== 'desligado' && dos.info.estado !== 'ativo' && dos.info.motivo) avisos.push(dos.info.motivo);
            return {
                blocos,
                total,
                totalDossie,
                dossie: dos.info,
                limite: cfg.limiteGeral,
                avisos,
                modoBiblioteca: modoBib,
                foraCena,
                cenaTags,
                gavetas: {
                    biblioteca: {
                        usado: bloco('SPADE_3_NOTAS').tokens + bloco('SPADE_6_CENA').tokens,
                        limite: cfg.limiteBiblioteca,
                    },
                    rp: { usado: bloco('SPADE_4_MEMORIA').tokens, limite: cfg.limiteRp },
                    espaco: { usado: bloco('SPADE_5_AUTOR').tokens, limite: cfg.limiteEspaco },
                },
                fora: { biblioteca: sel.fora, memoria: mem.fora, espaco: autor.fora },
                naoSabe: mem.naoSabe,
                selecionadas: sel.escolhidos.concat(cenaSel),
                estilo,
                repeticao: agora.repeticao,
            };
        }
        const prefixoEstavel = (p) =>
            p.blocos
                .filter((b) => b.n <= 5)
                .map((b) => b.texto)
                .join('\n\n');
        const promptComoTexto = (p) =>
            p.blocos
                .filter((b) => b.texto)
                .map((b) => b.texto)
                .join('\n\n');

        // ============================================================
        // 09 ENTREGA AO SILLYTAVERN (9.4 e 9.5) — quem GERA a fala é sempre o SillyTavern; a Spade só alimenta os slots
        // ============================================================
        const Diag = {
            eventosFaltando: [],
            ultimoPrompt: null,
            ultimoPromptEm: 0,
            ultimoSync: 0,
            ultimaOrdem: null,
            slotsAplicados: {},
            contextSize: null, // 8.9.0: último valor confiável recebido no interceptor
        };
        function tiposDoST() {
            const c = ctx();
            const t = c.extension_prompt_types || c.extensionPromptTypes;
            const r = c.extension_prompt_roles || c.extensionPromptRoles;
            // Se esta instalação não expõe as constantes, usa os números conhecidos (IN_PROMPT=0, IN_CHAT=1, BEFORE_PROMPT=2; SYSTEM=0) — NÃO verificado aqui: a Prévia confere a posição real.
            return {
                IN_PROMPT: t?.IN_PROMPT ?? 0,
                IN_CHAT: t?.IN_CHAT ?? 1,
                BEFORE_PROMPT: t?.BEFORE_PROMPT ?? 2,
                SYSTEM: r?.SYSTEM ?? 0,
                deConstantes: !!t,
            };
        }
        function aplicarSlots(p) {
            const c = ctx();
            if (typeof c.setExtensionPrompt !== 'function') {
                Diag.slotsAplicados = { erro: 'setExtensionPrompt não existe nesta versão do SillyTavern' };
                return;
            }
            const T = tiposDoST();
            const topo = getConfig().posicaoTopo === 'before_prompt' ? T.BEFORE_PROMPT : T.IN_PROMPT;
            for (const b of p.blocos) {
                // insere SEMPRE nesta ordem: o ST junta slots da mesma posição na ordem em que as chaves nasceram
                const pos = b.zona === 'topo' ? topo : T.IN_CHAT;
                const depth = b.zona === 'fim1' ? 1 : 0;
                try {
                    c.setExtensionPrompt(b.chave, b.texto, pos, depth, false, T.SYSTEM);
                    Diag.slotsAplicados[b.chave] = { tokens: b.tokens, posicao: pos, depth };
                } catch (e) {
                    Diag.slotsAplicados[b.chave] = { erro: e.message };
                    console.warn('[Spade] slot', b.chave, e.message);
                }
            }
            Diag.ultimoSync = Date.now();
        }
        let _syncRodando = null;
        async function sincronizar() {
            if (_syncRodando) return _syncRodando;
            _syncRodando = (async () => {
                try {
                    await Promise.all([bibCarregar(), descCarregar(), memCarregar()]);
                    await espacoCarregarParaRp();
                    await dossieSincronizar(false); // 8.9.0: prepara o cache (montarPrompt é síncrona)
                    aplicarSlots(montarPrompt());
                    refrescarUI();
                } catch (e) {
                    console.warn('[Spade] sincronizar:', e);
                    reportFatalError(e);
                } finally {
                    _syncRodando = null;
                }
            })();
            return _syncRodando;
        }
        const sincronizarSoon = debounce(() => sincronizar().catch(reportFatalError), 120);
        // Gancho de leitura antes de gerar: recalcula SÓ os blocos voláteis (5, 7 e 8), síncrono, e NUNCA chama abort() (9.5).
        function sincronizarVolateis(type) {
            const substituicao = type === 'regenerate' || type === 'swipe';
            if (substituicao) {
                Rot.salt++;
                salvarRot();
            }
            const p = montarPrompt({ substituicao });
            const c = ctx();
            const T = tiposDoST();
            const topoPos = getConfig().posicaoTopo === 'before_prompt' ? T.BEFORE_PROMPT : T.IN_PROMPT;
            // 8.9.0: os slots do perfil (estáveis, topo) também são reafirmados aqui: trocou de chat/modo/arquivo = nunca sobra resíduo
            for (const b of p.blocos.filter((x) => x.zona !== 'topo' || DOS_CHAVES.includes(x.chave))) {
                try {
                    const pos = b.zona === 'topo' ? topoPos : T.IN_CHAT;
                    c.setExtensionPrompt(b.chave, b.texto, pos, b.zona === 'fim1' ? 1 : 0, false, T.SYSTEM);
                    Diag.slotsAplicados[b.chave] = { tokens: b.tokens, posicao: pos, depth: b.zona === 'fim1' ? 1 : 0 };
                } catch (e) {
                    console.warn(e.message);
                }
            }
            return p;
        }
        // O ST chama isto antes de montar o prompt (declarado no manifest). Sem abort(): quem gera é o próprio ST, então regenerate/swipe funcionam.
        async function Spade_interceptGeneration(chatArr, contextSize, abort, type) {
            try {
                const cs = Number(contextSize);
                if (Number.isFinite(cs) && cs > 0) Diag.contextSize = cs;
            } catch (_) {}
            try {
                // só se o cache do perfil não estiver pronto (normalmente o sincronizar() já deixou pronto)
                if (getConfig().dossieModo && getConfig().dossieModo !== 'desligado') {
                    await bibCarregar();
                    await dossieSincronizar(false);
                }
            } catch (e) {
                console.warn('[Spade] perfil antes de gerar:', e);
            }
            try {
                sincronizarVolateis(type);
            } catch (e) {
                reportFatalError(e);
            }
            await rtAguardarReproducao(type); // só espera com rtGeracaoJunto desligado; nunca chama abort()
        }
        globalThis.Spade_interceptGeneration = Spade_interceptGeneration;

        // ---- conferência da ordem real (T1): lê o prompt FINAL quando o ST avisa que ele ficou pronto ----
        function conferirOrdemNoPromptFinal(msgs) {
            const achados = [];
            const faltando = [];
            for (const b of BLOCOS) {
                let achou = null;
                msgs.forEach((m, i) => {
                    if (achou) return;
                    const pos = String(m.content).indexOf('## ' + b.titulo + '\n');
                    if (pos >= 0) achou = { n: b.n, titulo: b.titulo, msg: i, pos };
                });
                if (achou) achados.push(achou);
                else if (Diag.slotsAplicados[b.chave] && Diag.slotsAplicados[b.chave].tokens) faltando.push(b.titulo);
            }
            const emOrdem = achados.every(
                (a, i) =>
                    i === 0 ||
                    a.msg > achados[i - 1].msg ||
                    (a.msg === achados[i - 1].msg && a.pos > achados[i - 1].pos)
            );
            return { achados, faltando, emOrdem, totalMensagens: msgs.length };
        }
        function capturarPromptFinal(dados) {
            try {
                const msgs = (dados && (dados.chat || dados.messages)) || [];
                if (!Array.isArray(msgs)) return;
                Diag.ultimoPrompt = msgs.map((m) => ({
                    role: m.role,
                    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                }));
                Diag.ultimoPromptEm = Date.now();
                Diag.ultimaOrdem = conferirOrdemNoPromptFinal(Diag.ultimoPrompt);
                refrescarUI();
            } catch (e) {
                console.warn('[Spade] captura do prompt final:', e.message);
            }
        }
        function ligarEventos() {
            const on = (nome, fn) => {
                if (event_types && event_types[nome])
                    eventSource.on(event_types[nome], (...a) => {
                        try {
                            fn(...a);
                        } catch (e) {
                            reportFatalError(e);
                        }
                    });
                else Diag.eventosFaltando.push(nome);
            };
            on('APP_READY', () => {
                atualizarCacheFalas();
                sincronizarSoon();
            });
            on('CHAT_CHANGED', () => {
                Dos.cache = null; // 8.9.0: nada do perfil do chat anterior pode sobrar
                dosLimparSlots();
                rtAoTrocarChat();
                atualizarCacheFalas();
                Mem.chatId = null;
                espacoTrocouChat();
                sincronizarSoon();
            });
            on('MESSAGE_SENT', (id) => {
                rtAplicarNoEnvio(id); // 8.6.0: SÍNCRONO e PRIMEIRO (o ST monta o prompt logo depois; o relógio lê o texto já cortado)
                relLerMensagemUsuario(id).catch(relFalha);
                sincronizarSoon();
            });
            on('USER_MESSAGE_RENDERED', (id) => rtAoRenderizar(id));
            on('MESSAGE_SWIPED', () => sincronizarSoon());
            on('MESSAGE_DELETED', () => {
                atualizarCacheFalas();
                sincronizarSoon();
            });
            on('MESSAGE_EDITED', () => {
                atualizarCacheFalas();
                sincronizarSoon();
            });
            on('CHARACTER_MESSAGE_RENDERED', () => {
                atualizarCacheFalas();
                Rot.reforco = false;
                relRodada().catch(relFalha);
                sincronizarSoon();
                espacoVerLimiarMemoria();
            });
            on('GENERATION_STARTED', () => {
                /* a recomputação de verdade acontece no interceptor, que recebe o `type` */
            });
            on('CHAT_COMPLETION_PROMPT_READY', capturarPromptFinal);
        }

        // ============================================================
        // 10 IA E JOBS (12.4) — a MESMA IA, só por evento (clique, mensagem com arquivo ou limiar), visível na tela. Sem timer, sem loop.
        // ============================================================
        const NANOGPT_BASE = 'https://nano-gpt.com/api/v1';
        const Pensa = { recusado: false }; // 14, item 10: a NanoGPT repassa `thinking`? Não testado — se a API recusar, paramos de enviar e avisamos.
        function anySignal(sinais) {
            const v = sinais.filter(Boolean);
            if (v.length <= 1) return v[0];
            if (typeof AbortSignal.any === 'function') return AbortSignal.any(v);
            const c = new AbortController();
            v.forEach((s) => {
                if (s.aborted) c.abort();
                else s.addEventListener('abort', () => c.abort(), { once: true });
            });
            return c.signal;
        }
        const ehErroDeAutenticacao = (e) => /^NanoGPT \((401|403)\)/.test(String(e && e.message));
        async function comRetentativas(fn, { tentativas = 2, esperaMs = 1500 } = {}) {
            let ultimo;
            for (let i = 0; i < tentativas; i++) {
                try {
                    return await fn();
                } catch (e) {
                    ultimo = e;
                    if (ehErroDeAutenticacao(e) || e.name === 'AbortError' || e.naoTentarDeNovo) break;
                    if (i < tentativas - 1) await sleep(esperaMs * (i + 1));
                }
            }
            throw ultimo;
        }
        const filtrarThinking = (t) =>
            String(t || '')
                .replace(/<think>[\s\S]*?<\/think>/gi, '')
                .replace(/<think>[\s\S]*$/i, '')
                .trim();
        async function generate(messages, opts = {}) {
            const cfg = getConfig();
            if (!cfg.apiKey) throw new Error('Falta a API key da NanoGPT. Cole a key em Configurações.');
            return comRetentativas(
                async () => {
                    const ctrl = new AbortController();
                    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 180000);
                    try {
                        const corpo = {
                            model: opts.model || cfg.modelo,
                            messages,
                            max_tokens: opts.maxTokens ?? 2500,
                            temperature: opts.temperature ?? 0.3,
                        };
                        const th = opts.thinking ?? cfg.thinkingNosJobs;
                        if ((th === 'disabled' || th === 'enabled') && !Pensa.recusado) corpo.thinking = { type: th };
                        const resp = await fetch(NANOGPT_BASE + '/chat/completions', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
                            signal: anySignal([ctrl.signal, opts.signal]),
                            body: JSON.stringify(corpo),
                        });
                        if (!resp.ok) {
                            const txt = (await resp.text()).slice(0, 300);
                            if (resp.status === 400 && corpo.thinking && /thinking/i.test(txt)) {
                                Pensa.recusado = true;
                                const e = new Error(
                                    'A API não aceitou o parâmetro "thinking"; tentando de novo sem ele.'
                                );
                                throw e;
                            }
                            const e = new Error('NanoGPT (' + resp.status + '): ' + txt);
                            if (resp.status === 400 || resp.status === 413) e.naoTentarDeNovo = true;
                            throw e;
                        }
                        const d = await resp.json();
                        const ch = d.choices && d.choices[0];
                        const conteudo = filtrarThinking(ch && ch.message && ch.message.content);
                        if (ch && (ch.finish_reason === 'length' || ch.finish_reason === 'max_tokens')) {
                            const e = new Error(
                                'A resposta foi cortada antes de terminar (limite de ' +
                                    corpo.max_tokens +
                                    ' tokens de resposta). Nada foi aplicado.'
                            );
                            e.naoTentarDeNovo = true;
                            e.truncada = true; // 8.9.2: a tela do Espaço usa isto pra dizer onde aumentar o limite
                            e.maxTokens = corpo.max_tokens;
                            throw e;
                        }
                        if (!conteudo) throw new Error('A IA devolveu vazio.');
                        return conteudo;
                    } finally {
                        clearTimeout(timer);
                    }
                },
                { tentativas: opts.tentativas ?? 3 }
            );
        }
        function parseJsonObjetoSeguro(t) {
            const m = String(t || '').match(/\{[\s\S]*\}/);
            if (!m) return null;
            try {
                const o = JSON.parse(m[0]);
                return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
            } catch (_) {
                return null;
            }
        }

        // ---- fila de jobs: um de cada vez, com estado, tokens estimados, cancelar e resultado revisável ----
        const Jobs = { lista: [], fila: Promise.resolve() };
        function criarJob({ nome, tipo, tokens, rodar, alvoId }) {
            const job = {
                id: newId('j'),
                nome,
                tipo,
                tokens: tokens || 0,
                estado: 'fila',
                criadoEm: Date.now(),
                ctrl: new AbortController(),
                resultado: null,
                erro: null,
                desfazer: null,
                detalhe: '',
                alvoId: alvoId || null,
            };
            Jobs.lista.unshift(job);
            Jobs.lista.length = Math.min(Jobs.lista.length, 40);
            Jobs.fila = Jobs.fila.then(async () => {
                if (job.estado === 'cancelado') return;
                job.estado = 'rodando';
                job.iniciadoEm = Date.now();
                refrescarUI();
                try {
                    job.resultado = await rodar(job);
                    if (job.estado !== 'cancelado') job.estado = 'ok';
                } catch (e) {
                    job.estado = job.ctrl.signal.aborted ? 'cancelado' : 'erro';
                    job.erro = job.ctrl.signal.aborted ? 'Cancelado.' : e.message;
                }
                job.fimEm = Date.now();
                refrescarUI();
            });
            refrescarUI();
            return job;
        }
        function cancelarJob(job) {
            job.ctrl.abort();
            if (job.estado === 'fila') job.estado = 'cancelado';
            refrescarUI();
        }
        const jobsAtivos = () => Jobs.lista.filter((j) => j.estado === 'fila' || j.estado === 'rodando');

        // ---- análise de arquivo (8.4 + adendo A passo 1) ----
        const TAMANHO_NOTA = { curta: '80 a 200 tokens', padrao: '120 a 400 tokens', longa: '300 a 700 tokens' };
        async function textoOriginalDe(a) {
            const d = await Disco.arqLer(a.id, ['original']);
            return d.original || '';
        }
        const entraNoEstilo = (a) => a.meta.tipo === 'tom' || a.meta.usarComoEstilo;
        function notasExistentesParaAnalise(a, orcamento) {
            const out = [];
            let usado = 0;
            for (const o of listaArquivos()) {
                if (o.id === a.id || !o.nota) continue;
                const mesmo =
                    (a.meta.grupoId && o.meta.grupoId === a.meta.grupoId) || o.meta.pastaId === a.meta.pastaId;
                const t = (mesmo ? o.nota.completa : o.nota.minima) || o.nota.completa || '';
                if (!t) continue;
                const linha =
                    '[' +
                    o.id +
                    '] ' +
                    (o.meta.titulo || o.meta.nome) +
                    ' (' +
                    o.meta.tipo +
                    '): ' +
                    t.replace(/\s+/g, ' ');
                const c = estimarTokens(linha);
                if (usado + c > orcamento) continue;
                usado += c;
                out.push(linha);
            }
            return out;
        }
        async function montarPedidoAnalise(a, original, p0) {
            await descCarregar();
            const exp =
                a.meta.explicacoes.map((e, i) => i + 1 + '. ' + e.texto).join('\n') ||
                '(sem explicação: deduza só pelo conteúdo e avise)';
            const obs = a.meta.observacaoVisivelParaIA && a.meta.observacao ? a.meta.observacao : '(nenhuma)';
            const existentes = notasExistentesParaAnalise(a, 3500).join('\n') || '(nenhuma)';
            const cfg = getConfig();
            const sistema =
                'Você organiza arquivos de uma história de RP para uma IA que vai interpretar uma personagem. Escreva NOTAS curtas, em português do Brasil, sem emojis. Responda SOMENTE com um JSON válido, sem texto fora dele.';
            const usuario = [
                '## ARQUIVO (inteiro, nome: ' + a.meta.nome + ')\n' + original,
                '## EXPLICAÇÕES do usuário (leia juntas, na ordem)\n' + exp,
                '## OBSERVAÇÃO do usuário\n' + obs,
                '## DESCRIÇÃO da personagem (não repita o que já está nela)\n' + (blocoDescricao() || '(vazia)'),
                '## NOTAS QUE JÁ EXISTEM (id entre colchetes)\n' + existentes,
                '## TAGS QUE JÁ EXISTEM NA BIBLIOTECA (quantos arquivos usam)\n' +
                    (tagsDaBiblioteca()
                        .map((x) => {
                            const g = gatilhosDaTag(x.tag).slice(0, 12);
                            return x.tag + ' (' + x.n + ')' + (g.length ? ' [gatilhos: ' + g.join(', ') + ']' : '');
                        })
                        .join('\n') || '(nenhuma ainda)'),
                '## REGRAS FIRMES DO PROMPT\n' +
                    REGRAS_ITENS.map(([t, x]) => t + ': ' + x.replace(/\n/g, ' ')).join('\n'),
                '## O QUE PRODUZIR\nEscreva a nota NOVA dizendo COMO ela complementa as existentes, sem repetir o que elas já dizem; se algo contradiz uma nota existente, aponte em "avisos". "nota_completa": ' +
                    TAMANHO_NOTA[cfg.tamanhoNota] +
                    ', 4 partes curtas em linhas separadas, na ordem: "O que é", "Como usar", "Fatos-chave", "Complementa". "nota_minima": 1 a 2 linhas (máx. ~50 tokens), só para a IA saber que isto existe e quando importa. Falas e trechos de exemplo do arquivo são ILUSTRAÇÃO do jeito da personagem, não texto para repetir: descreva o jeito e, se citar exemplo, que seja curto e marcado como "ex.:". "palavras_chave": 6 a 12 palavras ou nomes curtos (assuntos, lugares, pessoas, situações, emoções) que, quando aparecerem na cena, mostram que esta nota importa; o código usa isso para achar a nota certa sem gastar token. "tags": 2 a 5 etiquetas curtas (1 a 2 palavras, minúsculas, sem #) que dizem O QUE é este arquivo e DO QUE trata (ex.: tom, falas, lore, regra, cena, família, medo). REUSE as tags que já existem sempre que servirem, para arquivos parecidos ficarem juntos; crie tag nova só se nenhuma serve. "gatilhos": para cada tag que descreve um TIPO DE CENA ou ASSUNTO (intimidade, medo, briga, ciúme, família…), 6 a 12 palavras que costumam aparecer numa cena desse tipo (verbos, objetos, gestos, emoções; ex.: intimidade → beijo, cama, toque, sussurrar). O código usa isso para reconhecer a cena e trazer este arquivo na hora certa. Se a tag já tem gatilhos na lista acima, só acrescente os que faltam. NÃO ponha gatilhos em tags de forma (tom, falas, lore, regra, documento, cena). Se o autor explicou o arquivo nas explicações ou na observação, use as palavras dele. Formato do JSON: {"titulo":"…","tipo_sugerido":"tom|lore|regra|documento","nota_completa":"…","nota_minima":"…","palavras_chave":["…"],"tags":["…"],"gatilhos":{"<tag>":["…"]},"complementa":[{"arquivoId":"…","como":"…"}],"grupo_sugerido":["arquivoId"],"avisos":["…"]' +
                    (p0 ? ',"estilo":{…}' : '') +
                    '}.',
            ];
            if (p0) usuario.push('## ' + pedidoEstiloParaIA(p0));
            return [
                { role: 'system', content: sistema },
                { role: 'user', content: usuario.join('\n\n') },
            ];
        }
        function rodarAnalise(a, { vozAlvo } = {}) {
            return criarJob({
                nome: (a.nota ? 'Reanalisar: ' : 'Analisar: ') + a.meta.nome,
                tipo: 'analisar',
                alvoId: a.id,
                tokens: Math.ceil((a.meta.chars || 0) / 3.5) + 2500,
                rodar: async (job) => {
                    a.meta.estado = 'analisando';
                    refrescarUI();
                    try {
                        const original = await textoOriginalDe(a);
                        if (!original.trim()) throw new Error('O arquivo está vazio.');
                        const p0 = entraNoEstilo(a)
                            ? estiloPasso0(
                                  original,
                                  vozAlvo || (a.nota && a.nota.estilo && a.nota.estilo.vozAlvo) || null
                              )
                            : null; // passo 0: código, antes da IA
                        const msgs = await montarPedidoAnalise(a, original, p0);
                        job.tokens = estimarTokens(msgs.map((m) => m.content).join(''));
                        job.detalhe = 'enviado inteiro: ' + original.length + ' caracteres';
                        const bruto = await generate(msgs, {
                            signal: job.ctrl.signal,
                            maxTokens: p0 ? 7000 : 3500,
                            temperature: 0.3,
                        });
                        const r = parseJsonObjetoSeguro(bruto);
                        if (!r || !(r.nota_completa || r.nota_minima))
                            throw new Error('A IA não devolveu a nota no formato esperado. Nada foi aplicado.');
                        const nova = {
                            completa: String(r.nota_completa || r.nota_minima).trim(),
                            minima: String(r.nota_minima || '').trim(),
                            tags: [...new Set((Array.isArray(r.tags) ? r.tags : []).map(normTag).filter(Boolean))].slice(0, 5),
                            palavrasChave: (Array.isArray(r.palavras_chave) ? r.palavras_chave : [])
                                .map((x) => String(x).trim().slice(0, 40))
                                .filter(Boolean)
                                .slice(0, 12),
                            geradaEm: Date.now(),
                            modelo: getConfig().modelo,
                            editadaPeloUsuario: false,
                            revisada: false,
                            complementa: Array.isArray(r.complementa) ? r.complementa : [],
                            avisos: (Array.isArray(r.avisos) ? r.avisos : []).map(String),
                            grupoSugerido: Array.isArray(r.grupo_sugerido) ? r.grupo_sugerido : [],
                            tipoSugerido: r.tipo_sugerido || null,
                            titulo: r.titulo || null,
                            historico: [],
                        };
                        if (p0) {
                            nova.estilo = estiloPasso2(r.estilo || {}, p0, original);
                            nova.estilo.vozAlvo = vozAlvo || (a.nota && a.nota.estilo && a.nota.estilo.vozAlvo) || null;
                            if (a.nota && a.nota.estilo && a.nota.estilo.editadaPeloUsuario)
                                nova.estiloEditadoAnterior = a.nota.estilo;
                        }
                        if (a.nota && a.nota.editadaPeloUsuario) {
                            a.nota.proposta = nova;
                        } // reanálise NUNCA sobrescreve o que o usuário editou sem perguntar
                        else {
                            nova.historico = a.nota
                                ? [{ completa: a.nota.completa, minima: a.nota.minima, em: a.nota.geradaEm }]
                                      .concat(a.nota.historico || [])
                                      .slice(0, 5)
                                : [];
                            a.nota = nova;
                            if (!a.meta.titulo && nova.titulo) a.meta.titulo = nova.titulo;
                        }
                        a.meta.estado = 'pronto';
                        a.meta.analisadoEm = Date.now();
                        a.meta.tipoSugerido = nova.tipoSugerido;
                        await salvarNotaArq(a);
                        await salvarMetaArq(a);
                        // 8.5: gatilhos das tags (só das tags que este arquivo ganhou); se falhar, a nota já está salva
                        try {
                            const bruto = r.gatilhos && typeof r.gatilhos === 'object' && !Array.isArray(r.gatilhos) ? r.gatilhos : {};
                            const porTag = {};
                            for (const [k, v] of Object.entries(bruto)) {
                                const t = normTag(k);
                                if (!t || !nova.tags.includes(t) || !Array.isArray(v)) continue;
                                const ws = [...new Set(v.map(normGat).filter((w) => w && w !== t))].slice(0, 12);
                                if (ws.length) porTag[t] = ws;
                            }
                            if (Object.keys(porTag).length) await gatilhosMesclar(porTag);
                        } catch (_) {
                            /* sem gatilhos novos; as sementes e os que você pôs continuam valendo */
                        }
                        return { arquivoId: a.id, aviso: (nova.avisos || []).join(' · ') };
                    } catch (e) {
                        a.meta.estado = 'erro';
                        a.meta.erro = e.message;
                        try {
                            await salvarMetaArq(a);
                        } catch (_) {
                            /* o erro original é o que importa */
                        }
                        throw e;
                    }
                },
            });
        }
        // nota mínima que faltou (notas importadas): job pequeno e visível
        function rodarMinima(a) {
            return criarJob({
                nome: 'Gerar nota mínima: ' + a.meta.nome,
                tipo: 'minima',
                alvoId: a.id,
                tokens: estimarTokens(a.nota.completa) + 300,
                rodar: async (job) => {
                    const bruto = await generate(
                        [
                            {
                                role: 'system',
                                content:
                                    'Responda SOMENTE com JSON: {"minima":"1 a 2 linhas, máx. ~50 tokens, só pra IA saber que isto existe e quando importa"}.',
                            },
                            { role: 'user', content: (a.meta.titulo || a.meta.nome) + '\n\n' + a.nota.completa },
                        ],
                        { signal: job.ctrl.signal, maxTokens: 400 }
                    );
                    const r = parseJsonObjetoSeguro(bruto);
                    if (!r || !r.minima) throw new Error('A IA não devolveu a nota mínima.');
                    a.nota.minima = String(r.minima).trim();
                    await salvarNotaArq(a);
                    return { arquivoId: a.id };
                },
            });
        }
        function rodarNotaDeGrupo(g) {
            const membros = g.arquivoIds.map((id) => Bib.arquivos.get(id)).filter((a) => a && a.nota);
            return criarJob({
                nome: 'Nota do grupo: ' + g.nome,
                tipo: 'grupo',
                tokens: estimarTokens(membros.map((a) => a.nota.completa).join('')) + 400,
                rodar: async (job) => {
                    const bruto = await generate(
                        [
                            {
                                role: 'system',
                                content:
                                    'Una as notas abaixo numa NOTA ÚNICA, sem repetir o que se repete entre elas, em português do Brasil, linhas curtas. Responda SOMENTE com JSON: {"completa":"…","minima":"1 a 2 linhas"}.',
                            },
                            {
                                role: 'user',
                                content: membros
                                    .map((a) => '### ' + (a.meta.titulo || a.meta.nome) + '\n' + a.nota.completa)
                                    .join('\n\n'),
                            },
                        ],
                        { signal: job.ctrl.signal, maxTokens: 1800 }
                    );
                    const r = parseJsonObjetoSeguro(bruto);
                    if (!r || !r.completa) throw new Error('A IA não devolveu a nota do grupo.');
                    g.nota = {
                        completa: String(r.completa).trim(),
                        minima: String(r.minima || '').trim(),
                        geradaEm: Date.now(),
                        editadaPeloUsuario: false,
                        revisada: false,
                    };
                    await bibSalvarIndice();
                    return {};
                },
            });
        }
        // ---- memória do RP (12.5): fatos curtos com "quem sabe", sempre com diff e desfazer ----
        function mensagensNovasDoChat() {
            const arr = ctx().chat || [];
            return arr
                .slice(Mem.rp.ultimoIdx || 0)
                .map((m, i) => ({
                    idx: (Mem.rp.ultimoIdx || 0) + i,
                    quem: m.is_user ? ctx().name1 || 'Usuário' : m.name || personagemAtual(),
                    texto: String(m.mes || '')
                        .trim()
                        .slice(0, 1400),
                }))
                .filter((m) => m.texto);
        }
        function rodarMemoriaRp() {
            const msgs = mensagensNovasDoChat().slice(-80);
            return criarJob({
                nome: 'Atualizar memória do RP',
                tipo: 'memoria',
                tokens: estimarTokens(msgs.map((m) => m.texto).join('') + JSON.stringify(Mem.rp.fatos)) + 800,
                rodar: async (job) => {
                    await Promise.all([memCarregar(true), descCarregar()]);
                    const estourou = estimarTokens(Mem.rp.fatos.map((f) => f.texto).join('\n')) > getConfig().limiteRp;
                    const nome = personagemAtual();
                    const sis =
                        'Você mantém a MEMÓRIA de uma história de RP: fatos curtos (uma frase), concretos, em português do Brasil. Para cada fato diga QUEM SABE (lista de nomes: quem estava presente ou ficou sabendo). Responda SOMENTE com JSON: {"novos":[{"texto":"…","sabem":["nome"],"quandoMsgIdx":12}],"substituir":[{"id":"…","texto":"…","sabem":["nome"]}],"remover":["id"]}.' +
                        (estourou
                            ? ' A memória passou do orçamento: COMPRIMA — funda fatos parecidos, remova duplicados, mantenha o mais recente e preserve o que a personagem ' +
                              nome +
                              ' sabe.'
                            : '');
                    const usu =
                        '## PERSONAGEM\n' +
                        nome +
                        '\n\n## DESCRIÇÃO\n' +
                        (blocoDescricao() || '(vazia)') +
                        '\n\n## MEMÓRIA ATUAL (id: fato | quem sabe)\n' +
                        (Mem.rp.fatos
                            .map((f) => f.id + ': ' + f.texto + ' | ' + (f.sabem || []).join(', '))
                            .join('\n') || '(vazia)') +
                        '\n\n## MENSAGENS NOVAS (índice, quem: texto)\n' +
                        msgs.map((m) => '[' + m.idx + '] ' + m.quem + ': ' + m.texto).join('\n');
                    const bruto = await generate(
                        [
                            { role: 'system', content: sis },
                            { role: 'user', content: usu },
                        ],
                        { signal: job.ctrl.signal, maxTokens: 3000 }
                    );
                    const r = parseJsonObjetoSeguro(bruto);
                    if (!r) throw new Error('A IA não devolveu a memória no formato esperado. Nada foi aplicado.');
                    const antes = JSON.parse(JSON.stringify(Mem.rp));
                    const ids = new Set(Mem.rp.fatos.map((f) => f.id));
                    const rem = new Set((r.remover || []).filter((id) => ids.has(id)));
                    const sub = new Map(
                        (r.substituir || []).filter((s) => ids.has(s.id) && s.texto).map((s) => [s.id, s])
                    );
                    let fatos = Mem.rp.fatos
                        .filter((f) => !rem.has(f.id))
                        .map((f) =>
                            sub.has(f.id)
                                ? Object.assign({}, f, {
                                      texto: String(sub.get(f.id).texto).trim(),
                                      sabem: sub.get(f.id).sabem || f.sabem,
                                  })
                                : f
                        );
                    const novos = (r.novos || [])
                        .filter((n) => n && n.texto)
                        .map((n) => ({
                            id: newId('f'),
                            texto: String(n.texto).trim(),
                            sabem: Array.isArray(n.sabem) && n.sabem.length ? n.sabem.map(String) : [nome],
                            quandoMsgIdx: n.quandoMsgIdx ?? null,
                            criadoEm: Date.now(),
                        }));
                    Mem.rp.fatos = fatos.concat(novos);
                    Mem.rp.ultimoIdx = (ctx().chat || []).length;
                    await memSalvar('rp');
                    job.desfazer = async () => {
                        Mem.rp = antes;
                        await memSalvar('rp');
                    };
                    return {
                        novos: novos.map((n) => n.texto),
                        substituidos: [...sub.values()].map((s) => s.texto),
                        removidos: Array.from(rem)
                            .map((id) => (antes.fatos.find((f) => f.id === id) || {}).texto)
                            .filter(Boolean),
                    };
                },
            });
        }
        function rodarConsolidarEspaco(textosAntigos) {
            return criarJob({
                nome: 'Consolidar pedidos do Espaço',
                tipo: 'espaco',
                tokens: estimarTokens(textosAntigos.join('')) + 600,
                rodar: async (job) => {
                    await memCarregar(true);
                    const bruto = await generate(
                        [
                            {
                                role: 'system',
                                content:
                                    'Do que o usuário pediu nas mensagens antigas, extraia só PEDIDOS DURADOUROS (ajustes que continuam valendo), curtos, literais no sentido. O ÚLTIMO pedido vale mais: pedidos conflitantes são substituídos pelo mais novo. Responda SOMENTE com JSON: {"pedidos":["…"]} contendo a lista COMPLETA e final (inclua os atuais que continuam valendo).',
                            },
                            {
                                role: 'user',
                                content:
                                    '## PEDIDOS DURADOUROS ATUAIS\n' +
                                    (Mem.espaco.pedidos.map((p) => '- ' + p.texto).join('\n') || '(nenhum)') +
                                    '\n\n## MENSAGENS ANTIGAS (da mais velha à mais nova)\n' +
                                    textosAntigos.map((t) => '- ' + t).join('\n'),
                            },
                        ],
                        { signal: job.ctrl.signal, maxTokens: 1500 }
                    );
                    const r = parseJsonObjetoSeguro(bruto);
                    if (!r || !Array.isArray(r.pedidos))
                        throw new Error('A IA não devolveu os pedidos no formato esperado. Nada foi aplicado.');
                    const antes = JSON.parse(JSON.stringify(Mem.espaco));
                    Mem.espaco.pedidos = r.pedidos
                        .map((t) => String(t).trim())
                        .filter(Boolean)
                        .map((texto) => ({ id: newId('q'), texto, criadoEm: Date.now() }));
                    Mem.espaco.consolidadoEm = Date.now();
                    await memSalvar('espaco');
                    job.desfazer = async () => {
                        Mem.espaco = antes;
                        await memSalvar('espaco');
                    };
                    return { pedidos: Mem.espaco.pedidos.map((p) => p.texto) };
                },
            });
        }

        // ============================================================
        // 11 BACKUP, EXPORTAÇÃO E MIGRAÇÃO (15.2 e 15.3)
        // ============================================================
        function baixarArquivo(nome, texto, tipo = 'application/json') {
            const url = URL.createObjectURL(new Blob([texto], { type: tipo }));
            const a = document.createElement('a');
            a.href = url;
            a.download = nome;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
        }
        // Exportar tudo: UM arquivo com a Biblioteca (originais inclusos), memória, Descrição, Espaço e config SEM a apiKey.
        async function exportarTudo() {
            await Promise.all([bibCarregar(true), descCarregar(true), memCarregar(true)]);
            const cfg = getConfig();
            delete cfg.apiKey;
            const arquivos = [];
            for (const a of listaArquivos())
                arquivos.push({
                    id: a.id,
                    meta: a.meta,
                    nota: a.nota,
                    original: await textoOriginalDe(a).catch(() => null),
                });
            const chats = await obterEspacoChats();
            const historicos = {};
            const memorias = {};
            for (const c of chats) {
                historicos[c.id] = await estadoGet('espacoHistory:' + c.id, []);
                if (c.stChatId && !memorias[c.stChatId]) {
                    const [rp, es] = await Promise.all([
                        Disco.memLer(c.stChatId, 'rp'),
                        Disco.memLer(c.stChatId, 'espaco'),
                    ]);
                    memorias[c.stChatId] = { rp: rp.conteudo, espaco: es.conteudo };
                }
            }
            const dados = {
                spade: VERSAO,
                exportadoEm: new Date().toISOString(),
                personagem: P(),
                config: cfg,
                biblioteca: { indice: Bib.indice, arquivos },
                descricao: Desc.v,
                memorias,
                conexoes: Mem.con,
                espaco: { chats, historicos },
            };
            baixarArquivo(
                'spade-' +
                    semAcento(P())
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '-') +
                    '-' +
                    new Date().toISOString().slice(0, 10) +
                    '.json',
                JSON.stringify(dados, null, 1)
            );
            return { arquivos: arquivos.length, conversas: chats.length };
        }
        async function backupAgora() {
            if (Plug.ok === false)
                throw new Error('Backup no disco precisa do plugin spade-fs (ele não respondeu). Use "Exportar tudo".');
            return chamarFs('/backup/criar', { rotulo: 'manual' });
        }

        // ---- migração dos documentos da v7 (idempotente: rodar duas vezes não duplica nada) ----
        const MAPA_CATEGORIA = [
            [/regra|rule/i, 'regra'],
            [/lore|mundo|world|cen[aá]rio/i, 'lore'],
            [/tom|estilo|voz|style/i, 'tom'],
        ];
        const hash6 = (s) => hashStr(String(s)).toString(36).slice(0, 6);
        async function migrarDocumentos(aoProgresso) {
            if (Plug.ok === false)
                throw new Error('A migração lê os documentos antigos do disco e precisa do plugin spade-fs.');
            await bibCarregar(true);
            const lista = (await chamarFs('/documento/listar', { personagem: P(), todosOsChats: true })).documentos;
            const rel = {
                total: lista.length,
                criados: 0,
                jaExistiam: 0,
                comNota: 0,
                semNota: 0,
                erros: [],
                backup: null,
            };
            if (!lista.length) return rel;
            rel.backup = (await chamarFs('/backup/criar', { rotulo: 'pre-migracao' })).nome; // rede de segurança ANTES de mexer
            let pasta = Bib.indice.pastas.find((p) => p.nome === 'Importados');
            if (!pasta) pasta = await criarPasta('Importados', CORES_PASTA[1]);
            let i = 0;
            for (const d of lista) {
                i++;
                aoProgresso && aoProgresso(i, lista.length);
                const id = d.escopo === 'chat' ? 'mig-c' + hash6(d.chatId) + '-' + d.slug : 'mig-' + d.slug; // chave estável = escopo + slug original
                const idSeguro = id
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, '-')
                    .slice(0, 150);
                if (Bib.arquivos.has(idSeguro)) {
                    rel.jaExistiam++;
                    continue;
                }
                try {
                    const doc = await chamarFs('/documento/ler', {
                        personagem: P(),
                        slug: d.slug,
                        chatId: d.escopo === 'chat' ? d.chatId : undefined,
                    });
                    const tipo = (MAPA_CATEGORIA.find(([re]) => re.test(doc.categoria || '')) || [, 'documento'])[1];
                    const a = await criarArquivo({
                        id: idSeguro,
                        nome: (doc.titulo || d.slug).replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.md',
                        texto: doc.corpo,
                        pastaId: pasta.id,
                        tipo,
                        escopo: d.escopo === 'chat' ? 'chat' : 'personagem',
                        importado: true,
                        extra: {
                            sempreAtivo: !!doc.sempreIncluir,
                            chatId: d.escopo === 'chat' ? d.chatId : null,
                            titulo: doc.titulo || null,
                            migradoDe: { slug: d.slug, escopo: d.escopo, categoria: doc.categoria || null },
                        },
                    });
                    if (estimarTokens(doc.corpo) <= 400) {
                        a.nota = {
                            completa: doc.corpo.trim(),
                            minima: '',
                            geradaEm: Date.now(),
                            editadaPeloUsuario: false,
                            revisada: true,
                            importada: true,
                            historico: [],
                        };
                        a.meta.estado = 'pronto';
                        a.meta.analisadoEm = Date.now();
                        await salvarNotaArq(a);
                        await salvarMetaArq(a);
                        rel.comNota++;
                    } else rel.semNota++;
                    rel.criados++;
                } catch (e) {
                    if (e.jaExiste) rel.jaExistiam++;
                    else rel.erros.push(d.slug + ': ' + e.message);
                }
            }
            return rel;
        }

        // ============================================================
        // 12 ESPAÇO (seção 12): conversa com a IA nos bastidores. Fala COM a IA; o RP é falado PELA IA através do ST.
        // Os pedidos que o usuário escreve aqui valem na próxima fala do RP (bloco 5). As respostas da IA do Espaço NUNCA entram no RP.
        // ============================================================
        const Esp = {
            chats: null,
            abertaId: null,
            msgs: [],
            paraRp: [],
            pendentes: [],
            respondendo: false,
            sugestaoMemoria: false,
            busca: '',
        };
        async function obterEspacoChats() {
            if (!Esp.chats) Esp.chats = await estadoGet('espacoChats', []);
            return Esp.chats;
        }
        const salvarEspacoChats = () => estadoSet('espacoChats', Esp.chats);
        async function lerHistorico(id) {
            return estadoGet('espacoHistory:' + id, []);
        }
        async function salvarHistorico(id, msgs) {
            await estadoSet('espacoHistory:' + id, msgs.slice(-200));
        }
        function espacoTrocouChat() {
            Esp.chats = null;
            Esp.abertaId = null;
            Esp.msgs = [];
            Esp.paraRp = [];
            Esp.sugestaoMemoria = false;
        }
        // Mensagens do usuário (de TODAS as conversas ligadas ao chat atual do ST) que valem pro RP — em memória, pra o interceptor ler sem await.
        async function espacoCarregarParaRp() {
            const chats = (await obterEspacoChats()).filter((c) => c.stChatId && c.stChatId === stChatIdAtual());
            const todas = [];
            for (const c of chats)
                (await lerHistorico(c.id)).forEach((m, i) => {
                    if (m.role === 'user')
                        todas.push({
                            id: c.id + ':' + i,
                            convId: c.id,
                            idx: i,
                            texto: m.content,
                            ts: m.ts || 0,
                            enviar: m.enviarAoRp !== false && !m.guardada, // 8.7.0: guardada como "sempre" já entra pelo bloco 3 (não vai duas vezes)
                        });
                });
            Esp.paraRp = todas.sort((a, b) => a.ts - b.ts);
        }
        function espacoPedidosRecentes() {
            const cfg = getConfig();
            if (!cfg.espacoParaRp) return [];
            return Esp.paraRp.filter((m) => m.enviar && String(m.texto).trim()).slice(-cfg.espacoMaxMensagens);
        }
        const msgVaiPraRp = (convId, idx) => espacoPedidosRecentes().some((m) => m.convId === convId && m.idx === idx);
        async function espacoAbrir(id) {
            Esp.abertaId = id;
            Esp.msgs = id ? await lerHistorico(id) : [];
            refrescarUI();
        }
        async function novaConversa(titulo) {
            await obterEspacoChats();
            const c = {
                id: newId('esp'),
                titulo: titulo || 'Novo chat',
                criadoEm: Date.now(),
                atualizadoEm: Date.now(),
                stChatId: stChatIdAtual() || null,
            };
            Esp.chats.unshift(c);
            await salvarEspacoChats();
            await espacoAbrir(c.id);
            return c;
        }
        async function apagarConversa(id) {
            Esp.chats = (await obterEspacoChats()).filter((c) => c.id !== id);
            await salvarEspacoChats();
            await estadoDel('espacoHistory:' + id);
            const g = grupoDaConversa(id);
            if (g) {
                g.chats = g.chats.filter((x) => x !== id);
                Mem.con.grupos = Mem.con.grupos.filter((x) => x.chats.length >= 2);
                await memSalvar('con');
            }
            if (Esp.abertaId === id) await espacoAbrir(null);
            await espacoCarregarParaRp();
            sincronizarSoon();
        }
        // ---- conexões entre conversas (12.3): grupos; a IA de uma enxerga a outra; o RP recebe a memória RP do vizinho ----
        async function adicionarMsgSistema(convId, texto, tipo) {
            const h = await lerHistorico(convId);
            h.push({
                role: tipo === 'divisor' ? 'divisor' : 'assistant',
                content: texto,
                ts: Date.now(),
                sistema: true,
                enviarAoRp: false,
            });
            await salvarHistorico(convId, h);
            if (Esp.abertaId === convId) Esp.msgs = h;
        }
        async function conectarConversas(idA, idB) {
            const a = Esp.chats.find((c) => c.id === idA),
                b = Esp.chats.find((c) => c.id === idB);
            if (!a || !b || idA === idB) return;
            const ga = grupoDaConversa(idA),
                gb = grupoDaConversa(idB);
            if (ga && gb && ga !== gb)
                throw new Error('Uma das conversas já está conectada a outro grupo. Desconecte primeiro.');
            const g = ga || gb || Mem.con.grupos[Mem.con.grupos.push({ id: newId('g'), chats: [] }) - 1];
            [idA, idB].forEach((x) => {
                if (!g.chats.includes(x)) g.chats.push(x);
            });
            await memSalvar('con');
            await adicionarMsgSistema(idA, 'Conectado a ' + b.titulo, 'divisor');
            await adicionarMsgSistema(idB, 'Conectado a ' + a.titulo, 'divisor');
            await adicionarMsgSistema(
                idA,
                'Conectado a “' +
                    b.titulo.replace(/[.\s]+$/, '') +
                    '”. Agora eu enxergo o que foi conversado lá e uso aqui, sem você copiar nada.'
            );
            await memCarregarVizinhas();
            sincronizarSoon();
            refrescarUI();
        }
        async function desconectarConversa(id) {
            const g = grupoDaConversa(id);
            if (!g) return;
            const c = Esp.chats.find((x) => x.id === id);
            g.chats = g.chats.filter((x) => x !== id);
            if (g.chats.length < 2) Mem.con.grupos = Mem.con.grupos.filter((x) => x !== g);
            await memSalvar('con');
            await adicionarMsgSistema(id, 'Desconectado' + (g.chats.length ? '' : ''), 'divisor');
            await memCarregarVizinhas();
            sincronizarSoon();
            refrescarUI();
        }
        // ---- enviar e responder ----
        async function enviarMensagemEspaco(texto, anexos) {
            texto = String(texto || '').trim();
            if (!texto && !(anexos && anexos.length)) return;
            if (!Esp.abertaId) await novaConversa(texto.slice(0, 40) || 'Novo chat');
            const conv = Esp.chats.find((c) => c.id === Esp.abertaId);
            const h = Esp.msgs.slice();
            const msg = { role: 'user', content: texto || '(arquivo)', ts: Date.now(), enviarAoRp: true, anexos: [] };
            h.push(msg);
            Esp.msgs = h;
            if (conv && (conv.titulo === 'Novo chat' || !conv.titulo))
                conv.titulo = (texto || anexos[0].nome).slice(0, 40);
            conv.atualizadoEm = Date.now();
            await salvarEspacoChats();
            for (const f of anexos || []) {
                // arquivo anexado: cai na pasta padrão e a análise começa (job visível); a mensagem vira a Explicação
                try {
                    await bibCarregar();
                    const pasta =
                        Bib.indice.pastas.find((p) => p.id === getConfig().ultimaPasta) || Bib.indice.pastas[0];
                    const a = await criarArquivo({
                        nome: f.nome,
                        texto: f.texto,
                        pastaId: pasta.id,
                        explicacao: texto || '',
                    });
                    msg.anexos.push({ arquivoId: a.id, nome: f.nome });
                    h.push({
                        role: 'assistant',
                        content:
                            'Guardei “' +
                            f.nome +
                            '” na pasta ' +
                            pasta.nome +
                            ' e mandei analisar (acompanhe em Jobs). A nota só entra no prompt depois que você revisar.',
                        ts: Date.now(),
                        sistema: true,
                        enviarAoRp: false,
                    });
                    if (!(estimarTokens(f.texto) > getConfig().avisoArquivoTokens)) rodarAnalise(a);
                    else
                        h.push({
                            role: 'assistant',
                            content:
                                '“' +
                                f.nome +
                                '” é grande (~' +
                                fmtNum(estimarTokens(f.texto)) +
                                ' tokens). Abra o arquivo e confirme a análise.',
                            ts: Date.now(),
                            sistema: true,
                            enviarAoRp: false,
                        });
                } catch (e) {
                    h.push({
                        role: 'assistant',
                        content: 'Não consegui guardar “' + f.nome + '”: ' + e.message,
                        ts: Date.now(),
                        sistema: true,
                        enviarAoRp: false,
                    });
                }
            }
            await salvarHistorico(conv.id, h);
            await espacoCarregarParaRp();
            sincronizarVolateis();
            sincronizarSoon();
            refrescarUI(); // "✓ vale na próxima fala do RP" já é verdade aqui
            if (texto) relSugerirDoEspaco(texto).catch(relFalha); // 12.6: "passaram dois dias" dito aqui só PERGUNTA (nunca é automático)
            if (texto) await responderEspaco(conv);
        }
        // >>ACOES-PURO (sem acesso direto ao SillyTavern nem ao DOM: tudo entra por `dep`; testado por testes/test_acoes.js)
        // A IA do Espaço pode editar, apagar e mandar falas DA PERSONAGEM no RP. Nunca mexe nas falas do autor.
        // Ela escreve a ação no fim da resposta ([[editar 12]]…[[/editar]], [[apagar 13]], [[enviar]]…[[/enviar]]);
        // o CÓDIGO confere (número visto, fala não mudou, conversa ligada ao chat aberto, RP não gerando) antes de mexer.
        const ACOES_MAX = 3;
        const ACOES_TEXTO_MAX = 6000;
        const CENA_JANELA = 8;
        const CENA_FALA_MAX = 2500;
        function hashTexto(s) {
            const t = String(s == null ? '' : s);
            let h = 5381;
            for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
            return h.toString(36) + ':' + t.length;
        }
        function textoDaFala(m) {
            return String((m && m.mes) || '').trim();
        }
        const RE_ACOES =
            /\[\[\s*editar\s+#?(\d+)\s*\]\]([\s\S]*?)\[\[\s*\/\s*editar\s*\]\]|\[\[\s*enviar\s*\]\]([\s\S]*?)\[\[\s*\/\s*enviar\s*\]\]|\[\[\s*apagar\s+#?(\d+)\s*\]\]/gi;
        function extrairAcoes(bruto) {
            const acoes = [];
            let t = String(bruto || '').replace(RE_ACOES, (_m, ie, te, tv, ia) => {
                if (ie !== undefined) acoes.push({ tipo: 'editar', idx: +ie, texto: te.trim() });
                else if (tv !== undefined) acoes.push({ tipo: 'enviar', texto: tv.trim() });
                else acoes.push({ tipo: 'apagar', idx: +ia });
                return '';
            });
            let incompletas = 0;
            // etiqueta aberta e nunca fechada, ou sobra solta: some do texto e NÃO vira ação
            t = t.replace(/\[\[\s*(editar|enviar)\b[\s\S]*$/i, () => (incompletas++, ''));
            t = t.replace(/\[\[\s*\/?\s*(editar|enviar|apagar)[^\]]*\]\]/gi, () => (incompletas++, ''));
            return { limpo: t.replace(/\n{3,}/g, '\n\n').trim(), acoes, incompletas };
        }
        // A cena que a IA enxerga: as últimas falas, com o número REAL de cada uma (é o que ela cita nas ações).
        function montarCena(chat) {
            const lista = [];
            (Array.isArray(chat) ? chat : []).forEach((m, idx) => {
                if (!m || m.is_system) return;
                const t = textoDaFala(m);
                if (t) lista.push({ idx, m, t });
            });
            const snap = {};
            const linhas = lista.slice(-CENA_JANELA).map(({ idx, m, t }) => {
                const longa = t.length > CENA_FALA_MAX;
                snap[idx] = { h: hashTexto(t), user: !!m.is_user, longa };
                const marca = m.is_user ? ' (do autor — não mexa)' : longa ? ' (longa demais: só dá pra apagar)' : '';
                return '#' + idx + ' ' + (m.name || '?') + marca + ': ' + (longa ? t.slice(0, CENA_FALA_MAX) + ' […]' : t);
            });
            return { texto: linhas.join('\n'), snap };
        }
        // Decide o que pode ser feito. Ordem de execução: editar (número crescente), apagar (número DECRESCENTE, pra
        // não mudar o número das outras), e por último enviar.
        function planejarAcoes(acoes, snap, podeAgir) {
            const ok = [];
            const recusadas = [];
            const recusa = (a, motivo) => recusadas.push({ tipo: a.tipo, idx: a.idx, motivo });
            const usados = new Set();
            (acoes || []).forEach((a, n) => {
                if (!podeAgir) return recusa(a, 'esta conversa não está ligada ao chat aberto do RP');
                if (n >= ACOES_MAX) return recusa(a, 'mais de ' + ACOES_MAX + ' ações numa resposta');
                if (a.tipo !== 'apagar' && String(a.texto || '').length > ACOES_TEXTO_MAX) return recusa(a, 'texto grande demais');
                if (a.tipo === 'enviar') {
                    if (!a.texto) return recusa(a, 'a fala veio vazia');
                    return ok.push(a);
                }
                const s = snap && snap[a.idx];
                if (!s) return recusa(a, 'a fala #' + a.idx + ' não estava na cena que a IA viu');
                if (s.user) return recusa(a, 'só mexo nas falas da personagem, não nas suas');
                if (usados.has(a.idx)) return recusa(a, 'duas ações na mesma fala');
                if (a.tipo === 'editar' && s.longa) return recusa(a, 'a fala #' + a.idx + ' é longa demais pra editar');
                if (a.tipo === 'editar' && !a.texto) return recusa(a, 'o texto novo veio vazio');
                usados.add(a.idx);
                ok.push(a);
            });
            const peso = { editar: 0, apagar: 1, enviar: 2 };
            ok.sort((a, b) => peso[a.tipo] - peso[b.tipo] || (a.tipo === 'apagar' ? b.idx - a.idx : a.idx - b.idx));
            return { ok, recusadas };
        }
        // Mexe no SillyTavern de verdade. dep = { ctx(), emitir(nome, ...args), estaGerando(), personagem(), apos() }
        function criarOperacoesRp(dep) {
            const C = () => dep.ctx();
            const salvar = async () => {
                const c = C();
                if (typeof c.saveChat === 'function') await c.saveChat();
            };
            const recarregar = async () => {
                const c = C();
                if (typeof c.reloadCurrentChat === 'function') await c.reloadCurrentChat();
            };
            const clone = (o) => JSON.parse(JSON.stringify(o));
            const mesma = (m, texto) => !!m && hashTexto(textoDaFala(m)) === hashTexto(String(texto || '').trim());
            async function editar(idx, novo) {
                const c = C();
                const m = c.chat[idx];
                m.mes = novo;
                if (Array.isArray(m.swipes)) {
                    const s = Number.isInteger(m.swipe_id) ? m.swipe_id : 0;
                    if (s < m.swipes.length) m.swipes[s] = novo;
                }
                if (m.extra && m.extra.display_text) delete m.extra.display_text;
                const tinhaBloco = typeof c.updateMessageBlock === 'function';
                if (tinhaBloco) c.updateMessageBlock(idx, m);
                await salvar();
                if (!tinhaBloco) await recarregar();
                await dep.emitir('MESSAGE_EDITED', idx);
            }
            async function apagar(idx) {
                const c = C();
                const antes = c.chat.length;
                const h0 = hashTexto(textoDaFala(c.chat[idx]));
                let feito = false;
                if (typeof c.executeSlashCommandsWithOptions === 'function') {
                    try {
                        await c.executeSlashCommandsWithOptions('/cut ' + idx, {
                            handleParserErrors: false,
                            handleExecutionErrors: false,
                        });
                    } catch (_) {
                        /* cai no plano B abaixo */
                    }
                    feito = c.chat.length < antes || !c.chat[idx] || hashTexto(textoDaFala(c.chat[idx])) !== h0;
                }
                if (!feito) {
                    c.chat.splice(idx, 1);
                    await salvar();
                    await recarregar();
                    await dep.emitir('MESSAGE_DELETED', c.chat.length);
                }
                await salvar();
            }
            async function enviar(texto) {
                const c = C();
                const chara = c.characters && c.characters[c.characterId];
                const msg = {
                    name: dep.personagem(),
                    is_user: false,
                    is_system: false,
                    send_date: new Date().toISOString(),
                    mes: texto,
                    extra: {},
                };
                if (chara && chara.avatar) msg.original_avatar = chara.avatar;
                c.chat.push(msg);
                const idx = c.chat.length - 1;
                if (typeof c.addOneMessage === 'function') {
                    await c.addOneMessage(msg); // o próprio ST avisa que a fala foi desenhada
                    await salvar();
                } else {
                    await salvar();
                    await recarregar();
                    await dep.emitir('CHARACTER_MESSAGE_RENDERED', idx);
                }
                return idx;
            }
            // Executa o plano. Devolve os "cartões" que aparecem na conversa do Espaço (feita / recusada).
            async function executar(plano, snap) {
                const cards = [];
                const gerando = plano.ok.length && dep.estaGerando();
                for (const a of plano.ok) {
                    if (gerando) {
                        cards.push({ tipo: a.tipo, idx: a.idx, estado: 'recusada', motivo: 'o RP está gerando agora; peça de novo quando acabar' });
                        continue;
                    }
                    try {
                        if (a.tipo === 'enviar') {
                            const idx = await enviar(a.texto);
                            cards.push({ tipo: 'enviar', idx, estado: 'feita', depois: a.texto });
                            continue;
                        }
                        const m = C().chat[a.idx];
                        if (!m || hashTexto(textoDaFala(m)) !== snap[a.idx].h) {
                            cards.push({ tipo: a.tipo, idx: a.idx, estado: 'recusada', motivo: 'a fala #' + a.idx + ' mudou depois que a IA leu; peça de novo' });
                            continue;
                        }
                        if (a.tipo === 'editar') {
                            const antes = String(m.mes);
                            await editar(a.idx, a.texto);
                            cards.push({ tipo: 'editar', idx: a.idx, estado: 'feita', antes, depois: a.texto });
                        } else {
                            const msgSalva = clone(m);
                            await apagar(a.idx);
                            cards.push({ tipo: 'apagar', idx: a.idx, estado: 'feita', msgSalva });
                        }
                    } catch (e) {
                        cards.push({ tipo: a.tipo, idx: a.idx, estado: 'recusada', motivo: 'deu erro: ' + (e && e.message) });
                    }
                }
                plano.recusadas.forEach((a) => cards.push({ tipo: a.tipo, idx: a.idx, estado: 'recusada', motivo: a.motivo }));
                if (plano.ok.length) dep.apos();
                return cards;
            }
            function achar(card) {
                const c = C();
                if (mesma(c.chat[card.idx], card.depois)) return card.idx;
                for (let j = c.chat.length - 1; j >= 0; j--) if (mesma(c.chat[j], card.depois)) return j;
                return -1;
            }
            async function desfazer(card) {
                if (!card || card.estado !== 'feita') return { ok: false, motivo: 'não há o que desfazer' };
                if (dep.estaGerando()) return { ok: false, motivo: 'o RP está gerando agora' };
                const c = C();
                if (card.tipo === 'editar') {
                    const i = achar(card);
                    if (i < 0) return { ok: false, motivo: 'a fala foi mexida depois (por você ou pelo RP)' };
                    await editar(i, card.antes);
                } else if (card.tipo === 'apagar') {
                    c.chat.splice(Math.min(card.idx, c.chat.length), 0, clone(card.msgSalva));
                    await salvar();
                    await recarregar();
                } else if (card.tipo === 'enviar') {
                    const i = achar(card);
                    if (i < 0) return { ok: false, motivo: 'a fala foi mexida depois (por você ou pelo RP)' };
                    await apagar(i);
                } else return { ok: false, motivo: 'ação desconhecida' };
                dep.apos();
                return { ok: true };
            }
            return { executar, desfazer };
        }
        // <<ACOES-PURO

        const opsRp = criarOperacoesRp({
            ctx: () => ctx(),
            emitir: (nome, ...a) => eventSource.emit(event_types[nome], ...a),
            estaGerando: () => {
                try {
                    const el = document.getElementById('mes_stop'); // o botão "parar" do ST só aparece enquanto ele gera
                    return !!el && getComputedStyle(el).display !== 'none';
                } catch (_) {
                    return false;
                }
            },
            personagem: () => personagemAtual(),
            apos: () => {
                atualizarCacheFalas();
                sincronizarSoon();
            },
        });
        const INSTRUCAO_ACOES =
            '\n\n## O QUE VOCÊ PODE FAZER NO RP\n' +
            'Se o autor pedir (ou concordar), você mexe nas falas DA PERSONAGEM listadas em CENA ATUAL, pelo número (#). Escreva a ação no FIM da resposta, uma por linha, exatamente assim:\n' +
            '[[editar 12]]texto novo e COMPLETO da fala[[/editar]]\n[[apagar 13]]\n[[enviar]]fala nova da personagem[[/enviar]]\n' +
            'Regras: no máximo ' + ACOES_MAX + ' ações por resposta. Antes, diga em uma frase o que vai fazer. Use só números da lista. Nunca mexa nas falas do autor. ' +
            'Na edição, escreva a fala INTEIRA (não só o trecho mudado) e mantenha o formato do RP (*ação* entre asteriscos, fala, tamanho). ' +
            'Falas marcadas "longa demais" só podem ser apagadas. Se o autor só conversou ou perguntou, não use ação. Na dúvida, pergunte antes: isso muda o RP de verdade (o autor pode desfazer por um botão).';
        const INSTRUCAO_SEM_ACOES =
            '\n\nNesta conversa você NÃO pode mexer nas falas do RP (ela não está ligada ao chat aberto).';
        function resumoAcoesParaIA(m) {
            return (m.acoes || [])
                .map(
                    (a) =>
                        a.tipo === 'guardar'
                            ? resumoGuardarParaIA(a)
                            : '[' +
                        (a.estado === 'feita' ? 'feito' : a.estado === 'desfeita' ? 'desfeito pelo autor' : 'não feito: ' + a.motivo) +
                        ' — ' + a.tipo + (a.idx != null ? ' #' + a.idx : '') + ']'
                )
                .join(' ');
        }
        async function desfazerAcaoEspaco(convId, i, k) {
            const h = await lerHistorico(convId);
            const card = h[i] && h[i].acoes && h[i].acoes[k];
            if (!card) return;
            const r = await opsRp.desfazer(card);
            if (!r.ok) return toast('Não deu pra desfazer: ' + r.motivo + '.', true);
            card.estado = 'desfeita';
            await salvarHistorico(convId, h);
            if (Esp.abertaId === convId) Esp.msgs = h;
            refrescarUI();
            toast('Desfeito.');
        }

        function contextoDoEspaco() {
            const p = montarPrompt();
            const cena = chatRealRecente(6, 500)
                .map((m) => m.nome + ': ' + m.texto)
                .join('\n');
            const g = Esp.abertaId && grupoDaConversa(Esp.abertaId);
            const vizinho = [];
            if (g)
                for (const cid of g.chats.filter((x) => x !== Esp.abertaId)) {
                    const c = Esp.chats.find((x) => x.id === cid);
                    if (c) vizinho.push(c);
                }
            const conv = (Esp.chats || []).find((x) => x.id === Esp.abertaId);
            const cenaNum = montarCena(ctx().chat);
            return {
                notas: p.blocos
                    .filter((b) => (b.n <= 5 || b.chave === 'SPADE_6_CENA') && b.texto && !DOS_CHAVES.includes(b.chave)) // 8.9.0: perfil só vai pro RP
                    .map((b) => b.texto)
                    .join('\n\n'),
                cena,
                cenaNum: cenaNum.texto,
                snap: cenaNum.snap,
                podeAgir: !!(conv && conv.stChatId && conv.stChatId === stChatIdAtual()),
                vizinho,
            };
        }
        // 8.4 — a IA do Espaço sabe quais arquivos existem e com que tags (uma linha por arquivo)
        function indiceParaEspaco() {
            const l = listaArquivos()
                .filter((a) => a.meta.ativo)
                .map((a) => {
                    const t = tagsDe(a);
                    return '- ' + (a.meta.titulo || a.meta.nome.replace(/\.[a-z0-9]+$/i, '')) + (t.length ? ' [' + t.join(', ') + ']' : '');
                });
            if (!l.length) return '';
            return (
                '\n\n## ARQUIVOS DA BIBLIOTECA (título [tags])\n' +
                l.join('\n') +
                (getConfig().modoBiblioteca === 'cena'
                    ? '\n(O autor pode chamar um arquivo pela tag: se ele citar a tag inteira num pedido aqui, a nota entra na próxima fala.)'
                    : '')
            );
        }
        async function responderEspaco(conv) {
            Esp.respondendo = true;
            let guardouNaResposta = false;
            refrescarUI();
            try {
                const cx = contextoDoEspaco();
                // 8.7.0 (seção 16): com espacoOrganiza ligado, a IA também recebe as fichas, a Descrição resumida e a instrução de organizar
                let org = organizaModo() !== 'desligado';
                let orgTxt = '';
                if (org) {
                    try {
                        await bibCarregar();
                        await descCarregar();
                        await memCarregar();
                        orgTxt = fichasTextoParaIA(cx.podeAgir);
                    } catch (_) {
                        org = false;
                    }
                }
                let vizTxt = '';
                for (const v of cx.vizinho) {
                    const hv = (await lerHistorico(v.id)).filter((m) => m.role !== 'divisor' && !m.sistema).slice(-12);
                    vizTxt +=
                        '\n## CONVERSA CONECTADA: ' +
                        v.titulo +
                        '\n' +
                        hv
                            .map((m) => (m.role === 'user' ? 'Usuário' : 'IA') + ': ' + String(m.content).slice(0, 600))
                            .join('\n');
                }
                const sis =
                    'Você é a IA que interpreta ' +
                    personagemAtual() +
                    ' num RP, conversando agora com o autor NOS BASTIDORES. Aqui você não é a personagem: responda em português do Brasil, curto e direto. Os pedidos do autor aqui valem para a próxima fala dela no RP. Se pedirem algo que só um arquivo da Biblioteca resolve, diga isso. ' +
                    (org
                        ? 'Você só guarda informações nas Fichas, pelo jeito descrito abaixo; não mexe em mais nada da Biblioteca.'
                        : 'Você não altera arquivos da Biblioteca.') +
                    (cx.podeAgir ? INSTRUCAO_ACOES : INSTRUCAO_SEM_ACOES) +
                    '\n\n## O QUE VOCÊ SABE\n' +
                    (cx.notas || '(nada ainda)') +
                    indiceParaEspaco() +
                    (org ? orgTxt : '') +
                    '\n\n## CENA ATUAL\n' +
                    (cx.cenaNum || cx.cena || '(sem cena)') +
                    vizTxt;
                const hist = Esp.msgs
                    .filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.sistema))
                    .slice(-24)
                    .map((m) => ({
                        role: m.role,
                        content: ((String(m.content).slice(0, 4000) || '(sem texto)') + ' ' + resumoAcoesParaIA(m)).trim(),
                    }));
                const maxTok = maxTokensRespostaEspaco(); // 8.9.2: era 1500 fixo
                const resp = await generate([{ role: 'system', content: sis }].concat(hist), {
                    maxTokens: maxTok,
                    temperature: 0.7,
                    thinking: 'padrao',
                    timeoutMs: Math.max(90000, maxTok * 25), // teto maior = mais tempo (≈40 tokens/s); com 1500 continua 90 s
                });
                const pre = org ? extrairGuardados(resp) : { limpo: resp, guardados: [], incompletas: 0 };
                const ext = extrairAcoes(pre.limpo);
                let cards = [];
                if (ext.acoes.length || ext.incompletas) {
                    cards = await opsRp.executar(planejarAcoes(ext.acoes, cx.snap, cx.podeAgir), cx.snap);
                    if (ext.incompletas)
                        cards.push({ tipo: '?', estado: 'recusada', motivo: 'uma ação veio incompleta e não foi feita' });
                }
                if (org && (pre.guardados.length || pre.incompletas)) {
                    let iu = -1;
                    for (let q = Esp.msgs.length - 1; q >= 0; q--)
                        if (Esp.msgs[q].role === 'user') {
                            iu = q;
                            break;
                        }
                    try {
                        const g = await guardarDoEspaco(pre, conv, iu, cx.podeAgir);
                        cards = cards.concat(g.cards);
                        if (g.sempreGuardada && iu >= 0) {
                            guardouNaResposta = true;
                            Esp.msgs = Esp.msgs.map((m, q) => (q === iu ? Object.assign({}, m, { guardada: true }) : m));
                        }
                    } catch (e) {
                        cards.push({ tipo: 'guardar', estado: 'recusada', motivo: 'deu erro: ' + (e && e.message) });
                    }
                }
                const nova = { role: 'assistant', content: ext.limpo, ts: Date.now(), enviarAoRp: false };
                if (cards.length) nova.acoes = cards;
                Esp.msgs = Esp.msgs.concat([nova]);
            } catch (e) {
                let aviso = 'Não consegui responder: ' + e.message;
                if (e && e.truncada) // 8.9.2: nada foi aplicado (a resposta nem chega a ser lida); diz onde mexer
                    aviso +=
                        Number(e.maxTokens) < ESP_RESP_TOKENS.max
                            ? ' Aumente “Máximo de tokens da resposta do Espaço” em Configurações → Geral (agora ' +
                              e.maxTokens +
                              '; vai até ' +
                              ESP_RESP_TOKENS.max +
                              ') ou mande o pedido em partes menores.'
                            : ' O limite já está no máximo (' + ESP_RESP_TOKENS.max + '): mande o pedido em partes menores.';
                Esp.msgs = Esp.msgs.concat([
                    {
                        role: 'assistant',
                        content: aviso,
                        ts: Date.now(),
                        sistema: true,
                        erro: true,
                        enviarAoRp: false,
                    },
                ]);
            } finally {
                Esp.respondendo = false;
                await salvarHistorico(conv.id, Esp.msgs);
                if (guardouNaResposta) {
                    try {
                        await espacoCarregarParaRp();
                        sincronizarVolateis();
                        sincronizarSoon();
                    } catch (_) {
                        /* o próximo envio recarrega */
                    }
                }
                refrescarUI();
            }
        }
        async function alternarEnvioAoRp(convId, idx) {
            const h = await lerHistorico(convId);
            if (!h[idx]) return;
            h[idx].enviarAoRp = h[idx].enviarAoRp === false;
            await salvarHistorico(convId, h);
            if (Esp.abertaId === convId) Esp.msgs = h;
            await espacoCarregarParaRp();
            sincronizarVolateis();
            sincronizarSoon();
            refrescarUI();
        }
        function espacoVerLimiarMemoria() {
            const novas = (ctx().chat || []).length - (Mem.rp.ultimoIdx || 0);
            const antes = Esp.sugestaoMemoria;
            Esp.sugestaoMemoria = novas >= 12;
            if (antes !== Esp.sugestaoMemoria) refrescarUI();
        }

        // ============================================================
        // 13 INTERFACE — janela única (design das 4 imagens). Uma tela por vez; eventos delegados por data-a="ação".
        // ============================================================
        const UI = {
            raiz: null,
            fab: null,
            aberto: false,
            tela: 'espaco',
            lateral: false,
            arqId: null,
            pastaSel: 'todas',
            filtroTipo: 'todos',
            filtroTag: '',
            busca: '',
            buscaConv: '',
            buscandoConv: false,
            modoGrupo: false,
            selGrupo: new Set(),
            expSel: 0,
            abaArq: 'texto',
            rasc: {},
            anexos: [],
            original: new Map(),
            verTudo: false,
            vozAlvo: {},
            scroll: {},
            ultTela: null,
        };
        const TELAS = {
            espaco: 'Espaço',
            pastas: 'Arquivos',
            lista: 'Artefatos',
            arquivo: 'Arquivo',
            descricao: 'Descrição',
            memoria: 'Memória',
            previa: 'Prévia do prompt',
            jobs: 'Jobs',
            revisar: 'Revisão',
            config: 'Configurações',
            inicio: 'Início',
        };
        function iconeDoc(tipo) {
            const g =
                {
                    tom: 'M12 25v4M16 21v12M20 24v6M24 22v10',
                    lore: 'M10 22c3-1.4 5-1.4 8 0v10c-3-1.4-5-1.4-8 0zM18 22c3-1.4 5-1.4 8 0v10c-3-1.4-5-1.4-8 0z',
                    regra: 'M11 24l1.8 1.8L16 22.5M19 24h7M11 31l1.8 1.8L16 29.5M19 31h7',
                }[tipo] || 'M11 24h14M11 28h14M11 32h9';
            return (
                '<svg class="spd-doc" viewBox="0 0 36 42" fill="none"><path d="M6 2h16l10 10v26a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3z" fill="#fafafc"/><path d="M22 2v7a3 3 0 0 0 3 3h7" stroke="#d3d3da" stroke-width="1.5"/><path d="' +
                g +
                '" stroke="#52525d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            );
        }
        const pastaIcone = (cor) =>
            '<svg width="56" height="44" viewBox="0 0 56 44" aria-hidden="true"><rect x="0" y="0" width="24" height="16" rx="5" fill="' +
            cor +
            '" opacity=".78"/><rect x="0" y="7" width="56" height="37" rx="7" fill="' +
            cor +
            '"/></svg>';
        const pilulaTipo = (id) => {
            const t = tipoInfo(id);
            return (
                '<span class="spd-ptipo" style="color:' +
                t.cor +
                '"><i></i><span style="color:#b6b6c2">' +
                esc(t.nome) +
                '</span></span>'
            );
        };
        function mdLite(t) {
            // só o suficiente pra respostas da IA: parágrafos, listas numeradas/com marcador e **negrito**
            const inline = (s) =>
                esc(s)
                    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
                    .replace(/`([^`]+)`/g, '<code>$1</code>');
            const blocos = String(t || '').split(/\n{2,}/);
            return blocos
                .map((b) => {
                    const ls = b.split('\n');
                    const num = ls.every((l) => /^\s*\d+[.)]\s+/.test(l));
                    const bul = ls.every((l) => /^\s*[-*•]\s+/.test(l));
                    if (num)
                        return (
                            '<ol>' +
                            ls
                                .map(
                                    (l, i) =>
                                        '<li><span class="n">' +
                                        (i + 1) +
                                        '</span><span>' +
                                        inline(l.replace(/^\s*\d+[.)]\s+/, '')) +
                                        '</span></li>'
                                )
                                .join('') +
                            '</ol>'
                        );
                    if (bul)
                        return (
                            '<ul>' +
                            ls
                                .map(
                                    (l) =>
                                        '<li><span class="n">•</span><span>' +
                                        inline(l.replace(/^\s*[-*•]\s+/, '')) +
                                        '</span></li>'
                                )
                                .join('') +
                            '</ul>'
                        );
                    return '<p>' + ls.map(inline).join('<br>') + '</p>';
                })
                .join('');
        }
        function toast(msg, erro) {
            const j = UI.raiz && UI.raiz.querySelector('.spd-janela');
            if (!j) {
                console.log('[Spade]', msg);
                return;
            }
            let box = j.querySelector('.spd-toasts');
            if (!box) {
                box = document.createElement('div');
                box.className = 'spd-toasts';
                j.appendChild(box);
            }
            const el = document.createElement('div');
            el.className = 'spd-toast' + (erro ? ' err' : '');
            el.textContent = msg;
            box.appendChild(el);
            setTimeout(() => el.remove(), erro ? 7000 : 3200);
        }
        const falhou = (e) => {
            console.warn('[Spade]', e);
            toast(e && e.message ? e.message : String(e), true);
        };
        function perguntar(texto, botoes) {
            // modal simples (nada de alert/confirm do navegador)
            return new Promise((resolve) => {
                const j = UI.raiz.querySelector('.spd-janela');
                const m = document.createElement('div');
                m.className = 'spd-modal';
                m.innerHTML =
                    '<div><p>' +
                    esc(texto) +
                    '</p><div class="bt">' +
                    botoes
                        .map(
                            (b, i) =>
                                '<button class="spd-btn ' +
                                (b.cls || '') +
                                '" data-i="' +
                                i +
                                '">' +
                                esc(b.rotulo) +
                                '</button>'
                        )
                        .join('') +
                    '</div></div>';
                m.addEventListener('click', (e) => {
                    const bt = e.target.closest('button[data-i]');
                    if (bt) {
                        m.remove();
                        resolve(botoes[+bt.dataset.i].valor);
                    } else if (e.target === m) {
                        m.remove();
                        resolve(null);
                    }
                });
                j.appendChild(m);
            });
        }
        function modalForm(titulo, html, aoSalvar, extra) {
            const j = UI.raiz.querySelector('.spd-janela');
            const m = document.createElement('div');
            m.className = 'spd-modal';
            m.innerHTML =
                '<div><p style="font-weight:600;font-size:17px;color:#fff">' +
                esc(titulo) +
                '</p>' +
                html +
                '<div class="bt" style="margin-top:16px">' +
                (extra
                    ? '<button class="spd-btn perigo" data-x="1" style="margin-right:auto">' +
                      esc(extra.rotulo) +
                      '</button>'
                    : '') +
                '<button class="spd-btn" data-x="c">Cancelar</button><button class="spd-btn prim" data-x="s">Salvar</button></div></div>';
            m.addEventListener('click', async (e) => {
                const b = e.target.closest('[data-x]');
                if (!b && e.target !== m) {
                    const sw = e.target.closest('[data-cor]');
                    if (sw) {
                        m.querySelectorAll('[data-cor]').forEach((x) => (x.style.outline = ''));
                        sw.style.outline = '2px solid #fff';
                        m.dataset.cor = sw.dataset.cor;
                    }
                    return;
                }
                if (!b || b.dataset.x === 'c' || e.target === m) {
                    m.remove();
                    return;
                }
                try {
                    if (b.dataset.x === 's') await aoSalvar(m);
                    else if (b.dataset.x === '1') await extra.fn();
                    m.remove();
                } catch (er) {
                    falhou(er);
                }
            });
            j.appendChild(m);
            const i = m.querySelector('input');
            if (i) i.focus();
        }
        const swatches = (atual) =>
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">' +
            CORES_PASTA.map(
                (c) =>
                    '<button data-cor="' +
                    c +
                    '" style="width:30px;height:30px;border-radius:9px;border:0;background:' +
                    c +
                    ';cursor:pointer;' +
                    (c === atual ? 'outline:2px solid #fff' : '') +
                    '"></button>'
            ).join('') +
            '</div>';

        // ---- shell ----
        function barraAviso() {
            let h = '';
            if (Plug.ok === false)
                h +=
                    '<div class="spd-faixa">Sem o plugin spade-fs: o que você salvar fica só neste navegador (reserva). Instale/reinicie o plugin e recarregue. ' +
                    esc(Plug.erro || '') +
                    '</div>';
            (Plug.alertas || []).forEach((a) => {
                h += '<div class="spd-faixa">' + esc(a.mensagem) + ' (' + esc(a.caminho) + ')</div>';
            });
            return h;
        }
        function lateralHtml() {
            const nav = (t, ic_, rot, extra) =>
                '<button class="spd-nav ' +
                (UI.tela === t || (t === 'pastas' && (UI.tela === 'lista' || UI.tela === 'arquivo')) ? 'on' : '') +
                '" data-a="nav" data-t="' +
                t +
                '">' +
                ic(ic_, 19) +
                '<span>' +
                rot +
                '</span>' +
                (extra || '') +
                '</button>';
            const ativos = jobsAtivos().length;
            const convs = (Esp.chats || [])
                .slice()
                .sort((a, b) => b.atualizadoEm - a.atualizadoEm)
                .filter(
                    (c) =>
                        !UI.buscaConv ||
                        semAcento(c.titulo).toLowerCase().includes(semAcento(UI.buscaConv).toLowerCase())
                );
            const atual = Esp.abertaId;
            const grupoAtual = atual && grupoDaConversa(atual);
            return (
                '<aside class="spd-lateral"><div class="spd-lat-topo"><button class="spd-voltar" data-a="nav" data-t="inicio" title="Início" style="font-size:19px;color:#dcdee1">♠</button><button class="spd-voltar" data-a="fechar" title="Fechar" style="color:#9a9da4">' +
                ic('panel', 20) +
                '</button></div>' +
                '<button class="spd-nav dest" data-a="novo-chat">' +
                ic('plus', 19) +
                '<span>Novo chat</span></button>' +
                (UI.buscandoConv
                    ? '<div style="padding:6px 4px"><input class="spd-in" data-campo="buscaConv" placeholder="Buscar conversas" value="' +
                      esc(UI.buscaConv) +
                      '"></div>'
                    : '<button class="spd-nav" data-a="buscar-conv">' +
                      ic('search', 19) +
                      '<span>Buscar</span></button>') +
                nav('pastas', 'book', 'Biblioteca') +
                nav('descricao', 'user', 'Descrição') +
                nav('memoria', 'layers', 'Memória') +
                nav('previa', 'eye', 'Prévia') +
                nav('jobs', 'list', 'Jobs', ativos ? '<span class="b">' + ativos + '</span>' : '') +
                '<div class="spd-sep"></div><div class="spd-rot">Recentes</div><div class="spd-lista">' +
                (convs.length
                    ? convs
                          .map((c) => {
                              const g = grupoDaConversa(c.id);
                              return (
                                  '<div class="spd-conv ' +
                                  (c.id === atual && UI.tela === 'espaco' ? 'on' : '') +
                                  '" data-a="conv" data-id="' +
                                  c.id +
                                  '">' +
                                  ic('chat', 19) +
                                  '<span class="t">' +
                                  esc(c.titulo) +
                                  '</span><button class="spd-caixa ' +
                                  (g ? 'lig' : '') +
                                  '" data-a="caixa" data-id="' +
                                  c.id +
                                  '" title="' +
                                  (g ? 'Conectada — tocar desconecta' : 'Conectar com a conversa aberta') +
                                  '"></button></div>'
                              );
                          })
                          .join('')
                    : '<div class="spd-vazio" style="padding:20px 10px;font-size:13.5px">Nenhuma conversa ainda.</div>') +
                '</div><div class="spd-lat-pe"><button class="spd-nav ' +
                (UI.tela === 'config' ? 'on' : '') +
                '" data-a="nav" data-t="config">' +
                ic('sliders', 19) +
                '<span>Configurações</span></button></div></aside>'
            );
        }
        function topoHtml(t) {
            const voltar = t.voltar
                ? '<button class="spd-voltar" data-a="voltar" data-t="' + t.voltar + '">' + ic('back', 22) + '</button>'
                : '';
            return (
                '<div class="spd-topo"><button class="spd-menu" data-a="lateral">' +
                ic('menu', 22) +
                '</button>' +
                voltar +
                (t.icone || '') +
                '<h2>' +
                esc(t.titulo) +
                '</h2><span class="esp"></span>' +
                (t.direita || '') +
                '</div>'
            );
        }
        function htmlJanela() {
            const tela = renderTela();
            UI.ultTela = UI.tela + (UI.arqId || '');
            return (
                '<div class="spd-janela ' +
                (UI.lateral ? 'lat' : '') +
                '">' +
                lateralHtml() +
                '<div class="spd-lat-veu" data-a="lateral"></div><main class="spd-principal">' +
                barraAviso() +
                topoHtml(tela) +
                '<div class="spd-corpo ' +
                (tela.cls || '') +
                '" data-sc="corpo">' +
                tela.corpo +
                '</div></main></div>'
            );
        }
        let _rend = 0;
        function render() {
            if (!UI.raiz || !UI.aberto) return;
            const ativo = document.activeElement;
            const campo = ativo && ativo.dataset && ativo.dataset.campo;
            const sel = campo && ativo.selectionStart != null ? [ativo.selectionStart, ativo.selectionEnd] : null;
            const salvarScroll = () => {
                UI.raiz.querySelectorAll('[data-sc]').forEach((e) => {
                    UI.scroll[e.dataset.sc] = e.scrollTop;
                });
            };
            salvarScroll();
            const mesma = UI.ultTela === UI.tela + (UI.arqId || '');
            const msgsDoFim = (() => {
                const m = UI.raiz.querySelector('.spd-msgs');
                return !m || m.scrollHeight - m.scrollTop - m.clientHeight < 80;
            })();
            UI.raiz.innerHTML = htmlJanela();
            UI.raiz.querySelectorAll('[data-sc]').forEach((e) => {
                if (mesma && UI.scroll[e.dataset.sc] != null) e.scrollTop = UI.scroll[e.dataset.sc];
            });
            const m = UI.raiz.querySelector('.spd-msgs');
            if (m && (msgsDoFim || !mesma)) m.scrollTop = m.scrollHeight;
            if (campo) {
                const n = UI.raiz.querySelector('[data-campo="' + campo + '"]');
                if (n) {
                    n.focus();
                    if (sel && n.setSelectionRange)
                        try {
                            n.setSelectionRange(sel[0], sel[1]);
                        } catch (_) {
                            /* tipo sem seleção */
                        }
                }
            }
            desenharFiosVerdes();
            autoAltura();
        }
        function desenharFiosVerdes() {
            const lista = UI.raiz.querySelector('.spd-lista');
            if (!lista) return;
            const base = lista.getBoundingClientRect();
            for (const g of Mem.con.grupos) {
                const caixas = g.chats
                    .map((id) => lista.querySelector('.spd-caixa[data-id="' + id + '"]'))
                    .filter(Boolean)
                    .map((c) => c.getBoundingClientRect());
                if (caixas.length < 2) continue;
                const ys = caixas.map((r) => r.top + r.height / 2 - base.top + lista.scrollTop);
                const x = caixas[0].left + caixas[0].width / 2 - base.left - 1;
                const f = document.createElement('div');
                f.className = 'spd-fioverde';
                f.style.cssText =
                    'left:' +
                    x +
                    'px;top:' +
                    Math.min(...ys) +
                    'px;height:' +
                    (Math.max(...ys) - Math.min(...ys)) +
                    'px';
                lista.appendChild(f);
            }
        }
        function autoAltura() {
            const t = UI.raiz.querySelector('.spd-comp textarea');
            if (t) {
                t.style.height = 'auto';
                t.style.height = Math.min(160, t.scrollHeight) + 'px';
            }
        }
        let _agenda = null;
        function refrescarUI() {
            atualizarFab();
            if (!UI.raiz || !UI.aberto) return;
            const a = document.activeElement;
            if (
                a &&
                UI.raiz.contains(a) &&
                a.dataset &&
                a.dataset.campo &&
                (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')
            ) {
                clearTimeout(_agenda);
                _agenda = setTimeout(refrescarUI, 900);
                return;
            } // não derruba o que você está digitando
            clearTimeout(_agenda);
            _agenda = setTimeout(render, 30);
        }
        avisarUI = refrescarUI;
        function atualizarFab() {
            if (!UI.fab) return;
            const n = jobsAtivos().length;
            UI.fab.innerHTML = '♠' + (n ? '<span class="n">' + n + '</span>' : '');
        }
        function abrir(tela, extra) {
            UI.aberto = true;
            if (tela) UI.tela = tela;
            if (extra) Object.assign(UI, extra);
            UI.raiz.classList.add('aberto');
            UI.lateral = false;
            Promise.all([bibCarregar(), descCarregar(), memCarregar(), obterEspacoChats()])
                .then(async () => {
                    if (UI.tela === 'espaco' && !Esp.abertaId) {
                        const c = (Esp.chats || [])
                            .filter((x) => x.stChatId === stChatIdAtual())
                            .sort((a, b) => b.atualizadoEm - a.atualizadoEm)[0];
                        if (c) await espacoAbrir(c.id);
                    }
                    await espacoCarregarParaRp();
                    render();
                })
                .catch(falhou);
            render();
        }
        function fechar() {
            UI.aberto = false;
            UI.raiz.classList.remove('aberto');
        }
        function irPara(tela, extra) {
            UI.tela = tela;
            Object.assign(UI, extra || {});
            UI.lateral = false;
            render();
        }

        // ---- tela: Espaço (imagem 4) ----
        function msgHtml(m, i, conv) {
            if (m.role === 'divisor')
                return '<div class="spd-divisor"><span>' + ic('link', 14) + esc(m.content) + '</span></div>';
            if (m.role === 'user') {
                const ligado = conv && conv.stChatId && conv.stChatId === stChatIdAtual();
                const vai = ligado && msgVaiPraRp(conv.id, i);
                let nota = '';
                if (m.guardada)
                    nota =
                        '<span class="spd-vale off" style="cursor:default">' +
                        ic('check', 13) +
                        'guardada numa ficha: já entra em toda fala</span>';
                else if (getConfig().espacoParaRp && ligado && m.enviarAoRp !== false && !vai)
                    nota =
                        '<button class="spd-vale off" data-a="vale" data-i="' +
                        i +
                        '" title="Tocar para não enviar ao RP">já passou do limite de ' +
                        getConfig().espacoMaxMensagens +
                        ' mensagens</button>';
                else if (ligado && getConfig().espacoParaRp)
                    nota = vai
                        ? '<button class="spd-vale" data-a="vale" data-i="' +
                          i +
                          '" title="Tocar para NÃO enviar este pedido ao RP">' +
                          ic('check', 13) +
                          'vale na próxima fala do RP</button>'
                        : '<button class="spd-vale off" data-a="vale" data-i="' +
                          i +
                          '">não enviado ao RP — tocar para enviar</button>';
                else if (!ligado)
                    nota =
                        '<span class="spd-vale off" style="cursor:default">esta conversa é de outro chat do RP</span>';
                else
                    nota =
                        '<span class="spd-vale off" style="cursor:default">envio ao RP desligado nas configurações</span>';
                return (
                    '<div class="spd-user">' +
                    esc(m.content) +
                    (m.anexos && m.anexos.length
                        ? '<div class="spd-anexos" style="margin-top:8px;padding:0">' +
                          m.anexos
                              .map((a) => '<span class="spd-anexo">' + ic('doc', 14) + esc(a.nome) + '</span>')
                              .join('') +
                          '</div>'
                        : '') +
                    '</div>' +
                    nota
                );
            }
            const cartoes = (m.acoes || []).map((a, k) => cartaoAcaoHtml(a, i, k)).join('');
            return '<div class="spd-ia ' + (m.erro ? 'erro' : '') + '">' + mdLite(m.content) + cartoes + '</div>';
        }
        function cartaoAcaoHtml(a, i, k) {
            if (a.tipo === 'guardar') return cartaoGuardarHtml(a, i, k); // 8.7.0
            const previa = (t) => {
                const x = String(t || '').replace(/\s+/g, ' ').trim();
                return x.length > 140 ? x.slice(0, 140) + '…' : x;
            };
            if (a.estado === 'recusada')
                return (
                    '<div class="spd-acao off">' + ic('ban', 14) + '<div class="spd-acao-c">Não fiz: ' + esc(a.motivo || 'não deu') + '</div></div>'
                );
            const nomes = { editar: 'Editei a fala', apagar: 'Apaguei a fala', enviar: 'Mandei uma fala no RP' };
            const desfeita = a.estado === 'desfeita';
            const trecho = previa(a.tipo === 'apagar' ? a.msgSalva && a.msgSalva.mes : a.depois);
            return (
                '<div class="spd-acao ' + (desfeita ? 'off' : '') + '">' +
                ic(desfeita ? 'x' : 'check', 14) +
                '<div class="spd-acao-c"><b>' +
                esc((nomes[a.tipo] || 'Ação') + (a.tipo === 'enviar' ? '' : ' #' + a.idx) + (desfeita ? ' — desfeito' : '')) +
                '</b>' +
                (trecho ? '<div class="spd-acao-t">“' + esc(trecho) + '”</div>' : '') +
                '</div>' +
                (desfeita ? '' : '<button class="spd-acao-b" data-a="desfazer-acao" data-i="' + i + '" data-k="' + k + '">Desfazer</button>') +
                '</div>'
            );
        }
        function telaEspaco() {
            const conv = (Esp.chats || []).find((c) => c.id === Esp.abertaId);
            const g = conv && grupoDaConversa(conv.id);
            const vizinhos = g
                ? g.chats
                      .filter((x) => x !== conv.id)
                      .map((id) => (Esp.chats.find((c) => c.id === id) || {}).titulo)
                      .filter(Boolean)
                : [];
            const mensagens = Esp.msgs.map((m, i) => msgHtml(m, i, conv)).join('');
            const fala = Esp.sugestaoMemoria
                ? '<button class="spd-chip" data-a="job-memoria">' +
                  ic('layers', 15) +
                  'Atualizar memória do RP</button>'
                : '';
            const antigos = Esp.paraRp.filter((m) => m.enviar).length - getConfig().espacoMaxMensagens;
            const consolida =
                antigos >= 2 && conv
                    ? '<button class="spd-chip" data-a="job-espaco">' +
                      ic('list', 15) +
                      'Consolidar ' +
                      antigos +
                      ' pedidos antigos</button>'
                    : '';
            const anexos = UI.anexos.length
                ? '<div class="spd-anexos" style="max-width:760px;margin:0 auto 8px;width:calc(100% - 44px)">' +
                  UI.anexos
                      .map(
                          (a, i) =>
                              '<span class="spd-anexo">' +
                              ic('doc', 14) +
                              esc(a.nome) +
                              '<button data-a="rm-anexo" data-i="' +
                              i +
                              '">' +
                              ic('x', 14) +
                              '</button></span>'
                      )
                      .join('') +
                  '</div>'
                : '';
            const vazio = !Esp.msgs.length
                ? '<div class="spd-vazio" style="margin:auto">Converse com a IA nos bastidores.<br>O que você pedir aqui vale na próxima fala do RP.</div>'
                : '';
            const corpo =
                '<div class="spd-chat"><div class="spd-msgs" data-sc="msgs">' +
                vazio +
                '<div class="spd-msgs-in">' +
                mensagens +
                (Esp.respondendo ? '<div class="spd-ia spd-pensando">pensando</div>' : '') +
                '</div></div>' +
                (fala || consolida ? '<div class="spd-chips">' + fala + consolida + '</div>' : '') +
                anexos +
                '<div class="spd-comp"><button class="spd-mais" data-a="anexar" title="Anexar arquivo">' +
                ic('plus', 20) +
                '</button><textarea rows="1" data-campo="composer" placeholder="Digite sua mensagem…">' +
                esc(UI.rasc.composer || '') +
                '</textarea><button class="spd-env" data-a="enviar" ' +
                (Esp.respondendo ? 'disabled' : '') +
                '>' +
                ic('up', 20) +
                '</button></div><input type="file" id="spd-file" multiple style="display:none" accept=".txt,.md,.markdown,.json,.csv,.tsv,.yaml,.yml,.log"></div>';
            return {
                titulo: conv ? conv.titulo : 'Novo chat',
                corpo,
                cls: 'sem-rolagem',
                direita:
                    (vizinhos.length
                        ? '<span class="spd-pillcon">' +
                          ic('link', 15) +
                          'Conectado a ' +
                          esc(vizinhos.join(', ')) +
                          '</span>'
                        : '') +
                    (conv
                        ? '<button class="spd-voltar" data-a="renomear-conv" title="Renomear">' +
                          ic('pen', 18) +
                          '</button><button class="spd-voltar" data-a="apagar-conv" title="Apagar conversa">' +
                          ic('trash', 18) +
                          '</button>'
                        : ''),
            };
        }

        // ---- tela: Biblioteca — pastas (imagem 5, tema cinza próprio) ----
        const totalPorTipo = (t) => listaArquivos().filter((a) => a.meta.tipo === t).length;
        function telaPastas() {
            const pastas = Bib.indice.pastas.slice().sort((a, b) => a.ordem - b.ordem);
            const total = listaArquivos().length;
            const recente = (pid) =>
                Math.max(
                    0,
                    ...listaArquivos()
                        .filter((a) => a.meta.pastaId === pid)
                        .map((a) => a.meta.editadoEm || a.meta.enviadoEm || 0)
                );
            const ordenadas = pastas.slice().sort((a, b) => recente(b.id) - recente(a.id) || a.ordem - b.ordem);
            const lat =
                '<div class="spd-pl"><div class="spd-pl-i on" data-a="ir-lista" data-p="todas" data-tp="todos"><i></i>Recentes</div>' +
                tiposTodos()
                    .map(
                        (t) =>
                            '<div class="spd-pl-i" data-a="ir-lista" data-p="todas" data-tp="' +
                            t.id +
                            '"><i></i>' +
                            esc(t.nome[0].toUpperCase() + t.nome.slice(1)) +
                            '</div>'
                    )
                    .join('') +
                '<div class="spd-pl-i" data-a="ir-lista" data-p="todas" data-tp="todos"><i></i>Todos</div></div>';
            const grade =
                ordenadas
                    .map(
                        (p) =>
                            '<div class="spd-pasta" data-a="ir-lista" data-p="' +
                            p.id +
                            '" data-tp="todos">' +
                            pastaIcone(p.cor) +
                            '<div><div class="nome">' +
                            esc(p.nome) +
                            '</div><div class="qtd">' +
                            listaArquivos().filter((a) => a.meta.pastaId === p.id).length +
                            ' itens' +
                            (p.origem === 'espaco' ? ' · criada pelo Espaço' : '') +
                            '</div></div><button class="spd-voltar" data-a="editar-pasta" data-id="' +
                            p.id +
                            '" style="position:absolute;top:10px;right:10px;color:#a8a8b4" title="Editar pasta">' +
                            ic('pen', 16) +
                            '</button></div>'
                    )
                    .join('') +
                '<div class="spd-pasta nova" data-a="nova-pasta">' +
                ic('plus', 26) +
                '<span style="font-size:16px">Nova pasta</span></div>';
            return {
                titulo: 'Arquivos',
                corpo:
                    '<div class="spd-pastas">' +
                    lat +
                    '<div class="spd-pp"><div class="spd-grade-p" data-sc="grade">' +
                    grade +
                    '</div><div class="spd-pe"><span>' +
                    pastas.length +
                    (pastas.length === 1 ? ' pasta' : ' pastas') +
                    '</span><span>' +
                    total +
                    (total === 1 ? ' arquivo' : ' arquivos') +
                    '</span></div></div></div>',
                cls: 'sem-rolagem',
            };
        }
        // ---- tela: Artefatos (imagem 3) ----
        function cardHtml(a) {
            const est = estadoEfetivo(a);
            const rotEst = {
                novo: 'sem nota — analise',
                analisando: 'analisando…',
                pronto: a.nota && a.nota.revisada === false ? 'revise a nota' : '',
                desatualizado: 'desatualizado',
                erro: 'erro',
            }[est];
            const prev = a.nota
                ? (a.nota.minima || a.nota.completa || '').replace(/\s+/g, ' ')
                : 'Ainda sem nota. Abra o arquivo, explique o que ele é e mande analisar.';
            const g = a.meta.grupoId && Bib.indice.grupos.find((x) => x.id === a.meta.grupoId);
            return (
                '<div class="spd-card ' +
                (UI.selGrupo.has(a.id) ? 'sel' : '') +
                '" data-a="abrir-arq" data-id="' +
                a.id +
                '"><div class="spd-card-top">' +
                iconeDoc(a.meta.tipo) +
                pilulaTipo(a.meta.tipo) +
                '</div><h3>' +
                esc(a.meta.titulo || a.meta.nome.replace(/\.[a-z0-9]+$/i, '')) +
                '</h3>' +
                (tagsDe(a).length
                    ? '<div class="spd-tags mini">' +
                      tagsDe(a)
                          .slice(0, 4)
                          .map((t) => '<span class="spd-tag">' + esc(t) + '</span>')
                          .join('') +
                      '</div>'
                    : '') +
                '<div class="meta">' +
                (est === 'novo' ? 'enviado ' : 'atualizado ') +
                fmtRel(a.meta.editadoEm || a.meta.enviadoEm) +
                (g ? ' · grupo ' + esc(g.nome) : '') +
                (a.meta.origem === 'espaco' ? ' · criado pelo Espaço' : '') +
                (a.meta.ativo ? '' : ' · desligado') +
                '</div><div class="prev">' +
                esc(prev.slice(0, 260)) +
                '</div><div class="sempre">' +
                (a.meta.sempreAtivo ? ic('spark', 20) + 'sempre incluir' : '') +
                (rotEst
                    ? '<span class="est ' +
                      (est === 'erro' ? 'err' : est === 'pronto' ? 'ok' : '') +
                      '">' +
                      rotEst +
                      '</span>'
                    : '') +
                '</div></div>'
            );
        }
        function telaLista() {
            const todos = listaArquivos().filter((a) => UI.pastaSel === 'todas' || a.meta.pastaId === UI.pastaSel);
            const q = semAcento(UI.busca).toLowerCase();
            const vis = todos
                .filter(
                    (a) =>
                        (UI.filtroTipo === 'todos' || a.meta.tipo === UI.filtroTipo) &&
                        (!UI.filtroTag || tagsDe(a).includes(UI.filtroTag)) &&
                        (!q ||
                            semAcento(
                                (a.meta.titulo || '') +
                                    ' ' +
                                    a.meta.nome +
                                    ' ' +
                                    tagsDe(a).join(' ') +
                                    ' ' +
                                    (a.nota ? a.nota.completa : '')
                            )
                                .toLowerCase()
                                .includes(q))
                )
                .sort(
                    (x, y) => (y.meta.editadoEm || y.meta.enviadoEm || 0) - (x.meta.editadoEm || x.meta.enviadoEm || 0)
                );
            const tipos = tiposTodos().filter((t) => t.base || todos.some((a) => a.meta.tipo === t.id));
            const tabs =
                '<button class="spd-tab ' +
                (UI.filtroTipo === 'todos' ? 'on' : '') +
                '" data-a="filtro" data-t="todos">Todos<b>' +
                todos.length +
                '</b></button>' +
                tipos
                    .map(
                        (t) =>
                            '<button class="spd-tab ' +
                            (UI.filtroTipo === t.id ? 'on' : '') +
                            '" data-a="filtro" data-t="' +
                            t.id +
                            '">' +
                            esc(
                                t.id === 'regra'
                                    ? 'Regras'
                                    : t.id === 'documento'
                                      ? 'Documentos'
                                      : t.nome[0].toUpperCase() + t.nome.slice(1)
                            ) +
                            '<b>' +
                            todos.filter((a) => a.meta.tipo === t.id).length +
                            '</b></button>'
                    )
                    .join('');
            const cont = new Map();
            todos.forEach((a) => tagsDe(a).forEach((t) => cont.set(t, (cont.get(t) || 0) + 1)));
            const tagsLinha = cont.size
                ? '<div class="spd-tags" style="margin:2px 0 14px">' +
                  [...cont.entries()]
                      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
                      .slice(0, 24)
                      .map(
                          ([t, n]) =>
                              '<button class="spd-tag btn ' +
                              (UI.filtroTag === t ? 'on' : '') +
                              '" data-a="filtro-tag" data-t="' +
                              esc(t) +
                              '">' +
                              esc(t) +
                              '<b>' +
                              n +
                              '</b></button>'
                      )
                      .join('') +
                  '</div>'
                : '';
            const pasta = pastaInfo(UI.pastaSel);
            const grupos = Bib.indice.grupos.length
                ? '<h3 style="color:#f0f1f3;font-size:17px;margin:34px 0 14px">Grupos</h3>' +
                  Bib.indice.grupos
                      .map(
                          (g) =>
                              '<div class="spd-job" data-a="editar-grupo" data-id="' +
                              g.id +
                              '" style="cursor:pointer"><div class="l"><span class="n">' +
                              ic('link', 16) +
                              ' ' +
                              esc(g.nome) +
                              '</span><span class="st">' +
                              g.arquivoIds.length +
                              ' arquivos · ' +
                              (g.nota
                                  ? g.nota.revisada === false
                                      ? 'revise a nota'
                                      : 'nota do grupo'
                                  : 'sem nota própria') +
                              '</span></div></div>'
                      )
                      .join('')
                : '';
            const barraGrupo = UI.modoGrupo
                ? '<div class="spd-aviso bom" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap"><span style="flex:1">Escolha 2 ou mais arquivos para ligar num grupo (' +
                  UI.selGrupo.size +
                  ' escolhidos). A nota do grupo substitui as notas dos membros no prompt.</span><button class="spd-btn pq" data-a="criar-grupo" ' +
                  (UI.selGrupo.size < 2 ? 'disabled' : '') +
                  '>Criar grupo</button><button class="spd-btn pq" data-a="cancelar-grupo">Cancelar</button></div>'
                : '';
            const corpo =
                '<div class="spd-art"><div class="spd-art-topo"><label class="spd-busca">' +
                ic('search', 20) +
                '<input data-campo="busca" placeholder="Buscar artefatos" value="' +
                esc(UI.busca) +
                '"></label><div class="spd-tabs">' +
                tabs +
                '</div><span class="spd-cont">' +
                vis.length +
                ' artefatos</span></div>' +
                tagsLinha +
                barraGrupo +
                (vis.length
                    ? '<div class="spd-cards">' + vis.map(cardHtml).join('') + '</div>'
                    : '<div class="spd-vazio">Nenhum arquivo aqui ainda.<br>Toque em “Adicionar arquivo” ou anexe um arquivo no Espaço.</div>') +
                grupos +
                '<input type="file" id="spd-file-bib" multiple style="display:none" accept=".txt,.md,.markdown,.json,.csv,.tsv,.yaml,.yml,.log"></div>';
            return {
                titulo: 'Artefatos' + (pasta ? ' · ' + pasta.nome : ''),
                voltar: 'pastas',
                corpo,
                direita:
                    '<button class="spd-btn pq" data-a="modo-grupo">' +
                    ic('link', 15) +
                    'Agrupar</button><button class="spd-btn pq prim" data-a="adicionar-arq">' +
                    ic('plus', 15) +
                    'Adicionar arquivo</button>',
            };
        }
        // ---- tela: Arquivo (imagem 2) ----
        const rotuloEstado = {
            novo: 'sem nota ainda',
            analisando: 'analisando…',
            pronto: 'pronto',
            desatualizado: 'desatualizado — reanalise quando quiser',
            erro: 'erro',
        };
        function secaoTags(a) {
            const ts = tagsDe(a);
            return (
                '<div class="spd-secao"><div class="spd-icbtn">' +
                ic('spark', 22) +
                '</div><div><h4>Tags</h4><div class="sub">A IA escolhe ao analisar e usa para achar este arquivo na hora certa. Você pode tirar ou pôr as suas.</div><div class="spd-tags">' +
                (ts.length
                    ? ts
                          .map(
                              (t) =>
                                  '<span class="spd-tag">' +
                                  esc(t) +
                                  '<button data-a="tag-del" data-id="' +
                                  a.id +
                                  '" data-t="' +
                                  esc(t) +
                                  '" title="Tirar">×</button></span>'
                          )
                          .join('')
                    : '<span class="sub" style="margin:0">Sem tags — analise o arquivo ou ponha a sua.</span>') +
                '<button class="spd-btn pq" data-a="tag-add" data-id="' +
                a.id +
                '">+ tag</button>' +
                (ts.length
                    ? '<button class="spd-btn pq" data-a="tag-gatilhos" data-id="' + a.id + '">gatilhos</button>'
                    : '') +
                '</div></div></div>'
            );
        }
        function secaoNota(a) {
            const est = estadoEfetivo(a);
            const n = a.nota;
            const pend = n && n.revisada === false;
            let h =
                '<div class="spd-secao"><button class="spd-icbtn" data-a="analisar" data-id="' +
                a.id +
                '" title="' +
                (n ? 'Reanalisar' : 'Analisar com IA') +
                '">' +
                ic(n ? 'refresh' : 'spark', 24) +
                '</button><div><h4>Nota para a IA</h4><div class="sub">A IA lê só a nota, nunca o arquivo · ' +
                rotuloEstado[est] +
                '</div>';
            if (a.meta.erro && est === 'erro') h += '<div class="spd-aviso ruim">' + esc(a.meta.erro) + '</div>';
            if (n) {
                if (pend)
                    h +=
                        '<div class="spd-aviso">A nota ainda NÃO está no prompt. Leia, ajuste se quiser e toque em “Aceitar nota”.</div>';
                (n.avisos || []).forEach((v) => (h += '<div class="spd-aviso">' + esc(v) + '</div>'));
                if (n.proposta)
                    h +=
                        '<div class="spd-aviso bom"><b>Nova análise pronta</b> (a nota atual foi editada por você, então não troquei nada).<div class="acoes" style="display:flex;gap:8px;margin-top:10px"><button class="spd-btn pq" data-a="proposta-usar" data-id="' +
                        a.id +
                        '">Usar a nova</button><button class="spd-btn pq" data-a="proposta-descartar" data-id="' +
                        a.id +
                        '">Descartar</button></div><div style="margin-top:8px;white-space:pre-wrap;color:#cfe9d8">' +
                        esc(n.proposta.completa) +
                        '</div></div>';
                h +=
                    '<div class="spd-campo"><label>Nota completa · ' +
                    estimarTokens(n.completa) +
                    ' tokens</label><textarea class="spd-ta" data-campo="nota.completa" style="min-height:150px">' +
                    esc(UI.rasc['nota.completa'] ?? n.completa) +
                    '</textarea></div><div class="spd-campo"><label>Nota mínima · ' +
                    estimarTokens(n.minima) +
                    ' tokens' +
                    (n.minima ? '' : ' — sem mínima, entra só o título') +
                    '</label><textarea class="spd-ta peq" data-campo="nota.minima">' +
                    esc(UI.rasc['nota.minima'] ?? n.minima) +
                    '</textarea></div><div class="acoes">' +
                    (!n.minima
                        ? '<button class="spd-btn" data-a="gerar-minima" data-id="' +
                          a.id +
                          '">Gerar mínima com IA</button>'
                        : '') +
                    (pend
                        ? '<button class="spd-btn ciano" data-a="aceitar-nota" data-id="' +
                          a.id +
                          '">Aceitar nota</button>'
                        : '') +
                    '<button class="spd-btn" data-a="salvar-nota" data-id="' +
                    a.id +
                    '">Salvar</button></div>';
            } else
                h +=
                    '<div class="acoes" style="justify-content:flex-start"><button class="spd-btn ciano" data-a="analisar" data-id="' +
                    a.id +
                    '">Analisar com IA</button></div>';
            return h + '</div></div>';
        }
        function secaoEstilo(a) {
            const e = a.nota && a.nota.estilo;
            if (!e)
                return entraNoEstilo(a)
                    ? '<div class="spd-aviso">Este arquivo entra no estilo guiado. Analise-o para medir o jeito de falar e escolher exemplos.</div>'
                    : '';
            const f = e.bandas && e.bandas.fala;
            const linha = (k, rot, max) => {
                if (!f || !f[k]) return '';
                const b = f[k];
                const esc_ = max || 100;
                return (
                    '<div class="spd-medida"><span>' +
                    rot +
                    '</span><div class="spd-banda"><i style="left:' +
                    Math.min(100, (b.min / esc_) * 100) +
                    '%;width:' +
                    Math.max(2, Math.min(100, ((b.max - b.min) / esc_) * 100)) +
                    '%"></i><b style="left:' +
                    Math.min(100, (b.alvo / esc_) * 100) +
                    '%"></b></div><span>' +
                    b.alvo +
                    ' (' +
                    b.min +
                    '–' +
                    b.max +
                    ')</span></div>'
                );
            };
            const falantes = Object.keys(e.falantes || {});
            const vozes =
                falantes.length > 1
                    ? '<div class="spd-campo"><label>Voz alvo (o arquivo tem vários falantes)</label><select class="spd-sel" data-a="voz" data-id="' +
                      a.id +
                      '"><option value="todas">todas</option>' +
                      falantes
                          .map((x) => '<option ' + (e.vozAlvo === x ? 'selected' : '') + '>' + esc(x) + '</option>')
                          .join('') +
                      '</select></div>'
                    : '';
            return (
                '<div class="spd-secao"><div class="spd-icbtn">' +
                ic('wave', 24) +
                '</div><div><h4>Estilo medido</h4><div class="sub">Números tirados do texto por código — a IA só ajudou a escolher exemplos.</div>' +
                (e.avisos || []).map((v) => '<div class="spd-aviso">' + esc(v) + '</div>').join('') +
                (e.principios.length
                    ? '<div style="margin:0 0 12px">' +
                      linhasCurtas(e.principios.join('\n'))
                          .map((l) => '<div style="color:#d5dbe8;font-size:14px;margin:4px 0">' + esc(l) + '</div>')
                          .join('') +
                      '</div>'
                    : '') +
                vozes +
                (f
                    ? (f.confiavel
                          ? ''
                          : '<div class="spd-aviso">Poucas falas medidas (' +
                            f.n +
                            '): estas medidas não são usadas na conferência.</div>') +
                      linha('palavrasPorFala', 'palavras por fala', Math.max(40, f.palavrasPorFala.max * 1.2)) +
                      linha('pctPergunta', 'terminam em ?') +
                      linha('pctReticencias', 'reticências') +
                      linha('pctExclamacao', 'exclamação') +
                      linha('pctInicioMinuscula', 'início minúsculo') +
                      linha('pctSemPontoFinal', 'sem ponto final')
                    : '<div class="spd-aviso">Nenhuma fala foi medida neste arquivo.</div>') +
                '<h4 style="font-size:15px;margin:18px 0 4px">Exemplos (' +
                e.exemplos.length +
                ')</h4><div class="sub" style="margin-bottom:6px">⭐ aparece mais · 🚫 nunca aparece. O texto é cópia literal do arquivo.</div>' +
                e.exemplos
                    .map(
                        (x) =>
                            '<div class="spd-ex ' +
                            (x.bloqueado ? 'blq' : '') +
                            '"><div class="tx">“' +
                            esc(x.texto) +
                            '”<small>' +
                            x.canal +
                            ' · ' +
                            x.palavras +
                            ' palavras' +
                            (x.situacao ? ' · ' + esc(x.situacao) : '') +
                            (x.revisar ? ' · conferir nome próprio' : '') +
                            '</small></div><button class="' +
                            (x.favorito ? 'on' : '') +
                            '" data-a="ex-fav" data-id="' +
                            a.id +
                            '" data-x="' +
                            x.id +
                            '" title="Favoritar">' +
                            ic('star', 18) +
                            '</button><button data-a="ex-blq" data-id="' +
                            a.id +
                            '" data-x="' +
                            x.id +
                            '" title="Bloquear">' +
                            ic('ban', 18) +
                            '</button></div>'
                    )
                    .join('') +
                '</div></div>'
            );
        }
        function telaArquivo() {
            const a = Bib.arquivos.get(UI.arqId);
            if (!a)
                return {
                    titulo: 'Arquivo',
                    voltar: 'lista',
                    corpo: '<div class="spd-vazio">Arquivo não encontrado.</div>',
                };
            const t = tipoInfo(a.meta.tipo);
            const titulo = a.meta.titulo || a.meta.nome.replace(/\.[a-z0-9]+$/i, '');
            const orig = UI.original.get(a.id);
            if (orig === undefined) {
                UI.original.set(a.id, null);
                textoOriginalDe(a)
                    .then((x) => {
                        UI.original.set(a.id, x);
                        refrescarUI();
                    })
                    .catch((e) => {
                        UI.original.set(a.id, '(não consegui ler o original: ' + e.message + ')');
                        refrescarUI();
                    });
            }
            const MAXV = 60000;
            const texto =
                orig == null
                    ? 'Carregando…'
                    : UI.verTudo || orig.length <= MAXV
                      ? orig
                      : orig.slice(0, MAXV) + '\n\n… (' + (orig.length - MAXV) + ' caracteres a mais)';
            const exps = a.meta.explicacoes;
            const sel = Math.min(UI.expSel, Math.max(0, exps.length - 1));
            const cadeia =
                '<div class="spd-cadeia"><button class="spd-icbtn" data-a="exp-add" title="Nova explicação">' +
                ic('plus', 26) +
                '</button>' +
                exps
                    .map(
                        (e, i) =>
                            '<div class="spd-fio"></div><button class="spd-no ' +
                            (i === sel ? 'sel' : '') +
                            '" data-a="exp-sel" data-i="' +
                            i +
                            '" title="Explicação ' +
                            (i + 1) +
                            '"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/></svg></button>'
                    )
                    .join('') +
                '</div>';
            const eVal = exps[sel] ? (UI.rasc['exp.' + sel] ?? exps[sel].texto) : '';
            const painel =
                '<div class="spd-painel" data-sc="painel"><div class="spd-secao">' +
                cadeia +
                '<div><h4>Explicação</h4><div class="sub">Como a IA deve usar estas informações</div>' +
                (exps.length
                    ? '<textarea class="spd-ta" data-campo="exp.' +
                      sel +
                      '" placeholder="Escreva aqui como esta informação deve ser interpretada e utilizada pela IA...">' +
                      esc(eVal) +
                      '</textarea><div class="acoes"><button class="spd-btn pq perigo" data-a="exp-del">Remover esta</button><button class="spd-btn" data-a="exp-salvar">Salvar</button></div>'
                    : '<div class="spd-vazio" style="padding:20px 0;text-align:left">Toque em + para escrever a primeira explicação. Pode ter várias: a IA lê todas, na ordem.</div>') +
                '</div></div>' +
                '<div class="spd-secao"><button class="spd-icbtn" data-a="obs-olho" title="' +
                (a.meta.observacaoVisivelParaIA ? 'A IA vê esta observação' : 'A IA NÃO vê esta observação') +
                '">' +
                ic(a.meta.observacaoVisivelParaIA ? 'eye' : 'eyeoff', 26) +
                '</button><div><h4>Observação</h4><div class="sub">Notas adicionais sobre o conteúdo' +
                (a.meta.observacaoVisivelParaIA ? '' : ' · a IA não vê') +
                '</div><textarea class="spd-ta" data-campo="obs" placeholder="Adicione observações, alertas ou informações importantes...">' +
                esc(UI.rasc.obs ?? a.meta.observacao) +
                '</textarea><div class="acoes"><button class="spd-btn" data-a="obs-salvar">Salvar</button></div></div></div>' +
                secaoTags(a) +
                secaoNota(a) +
                secaoEstilo(a) +
                '<div class="spd-secao"><div class="spd-icbtn">' +
                ic('sliders', 22) +
                '</div><div><h4>Uso no prompt</h4><div class="sub">Como este arquivo entra na conversa</div>' +
                '<div class="spd-bar-sw"><span>Ligado<small>desligar não apaga nada</small></span><button class="spd-sw ' +
                (a.meta.ativo ? 'on' : '') +
                '" data-a="tg" data-k="ativo" data-id="' +
                a.id +
                '"></button></div><div class="spd-bar-sw"><span>Sempre incluir<small>é a última nota a sair se faltar espaço</small></span><button class="spd-sw ' +
                (a.meta.sempreAtivo ? 'on' : '') +
                '" data-a="tg" data-k="sempreAtivo" data-id="' +
                a.id +
                '"></button></div>' +
                (a.meta.tipo !== 'tom'
                    ? '<div class="spd-bar-sw"><span>Usar como estilo<small>mede o jeito de falar deste arquivo</small></span><button class="spd-sw ' +
                      (a.meta.usarComoEstilo ? 'on' : '') +
                      '" data-a="tg" data-k="usarComoEstilo" data-id="' +
                      a.id +
                      '"></button></div>'
                    : '') +
                '<div class="spd-grid2" style="margin-top:14px"><div class="spd-campo"><label>Prioridade</label><select class="spd-sel" data-a="sel" data-k="prioridade" data-id="' +
                a.id +
                '">' +
                ['alta', 'media', 'baixa']
                    .map(
                        (p) =>
                            '<option value="' +
                            p +
                            '" ' +
                            (a.meta.prioridade === p ? 'selected' : '') +
                            '>' +
                            { alta: 'alta', media: 'média', baixa: 'baixa' }[p] +
                            '</option>'
                    )
                    .join('') +
                '</select></div><div class="spd-campo"><label>Tipo</label><select class="spd-sel" data-a="sel" data-k="tipo" data-id="' +
                a.id +
                '">' +
                tiposTodos()
                    .map(
                        (x) =>
                            '<option value="' +
                            x.id +
                            '" ' +
                            (a.meta.tipo === x.id ? 'selected' : '') +
                            '>' +
                            esc(x.nome) +
                            '</option>'
                    )
                    .join('') +
                '<option value="__novo">+ novo tipo…</option></select></div></div>' +
                '<div class="spd-campo"><label>Pasta</label><select class="spd-sel" data-a="sel" data-k="pastaId" data-id="' +
                a.id +
                '">' +
                Bib.indice.pastas
                    .map(
                        (p) =>
                            '<option value="' +
                            p.id +
                            '" ' +
                            (a.meta.pastaId === p.id ? 'selected' : '') +
                            '>' +
                            esc(p.nome) +
                            '</option>'
                    )
                    .join('') +
                '</select></div></div></div>' +
                '<div class="spd-secao"><div class="spd-icbtn">' +
                ic('trash', 22) +
                '</div><div><h4>Apagar</h4><div class="sub">Remove o arquivo, a nota e as explicações (fica um backup no disco).</div><div class="acoes" style="justify-content:flex-start"><button class="spd-btn perigo" data-a="apagar-arq" data-id="' +
                a.id +
                '">Apagar arquivo</button></div></div></div></div>';
            const leitura =
                '<div class="spd-leitura" data-sc="leitura"><h1>' +
                esc(titulo) +
                '</h1><div class="txt">' +
                esc(texto) +
                '</div>' +
                (orig && orig.length > MAXV && !UI.verTudo
                    ? '<p><button class="spd-btn" data-a="ver-tudo">Mostrar tudo</button></p>'
                    : '') +
                '</div>';
            return {
                titulo,
                voltar: 'lista',
                icone: '<span style="color:#aab4f0;display:grid">' + ic('doc', 20) + '</span>',
                direita: pilulaTipo(a.meta.tipo),
                corpo:
                    '<div class="spd-arq m-' +
                    UI.abaArq +
                    '"><div class="spd-mtabs"><button class="spd-tab ' +
                    (UI.abaArq === 'texto' ? 'on' : '') +
                    '" data-a="aba" data-t="texto">Texto</button><button class="spd-tab ' +
                    (UI.abaArq === 'notas' ? 'on' : '') +
                    '" data-a="aba" data-t="notas">Explicação e nota</button></div>' +
                    leitura +
                    painel +
                    '</div>',
                cls: 'sem-rolagem',
            };
        }

        // ---- tela: Descrição (10) ----
        const CAMPOS_DESC = [
            ['aparencia', 'Aparência', 'Como ela é, em linhas curtas.', false],
            ['temperamento', 'Temperamento base', 'O jeito dela quando nada aconteceu.', false],
            [
                'oQueMudaHumor',
                'O que muda o humor dela',
                'Fatos da cena que a deixam melhor ou pior — nunca simpatia ao usuário.',
                false,
            ],
            ['exemplosFrios', 'Exemplos dela em momento frio', 'Duas ou três falas. Uma por linha.', true],
            ['comoFala', 'Como fala', 'Jeito de falar, vícios, o que nunca diria.', false],
            ['oQueSabe', 'O que sabe', 'O que ela sabe de si e do mundo antes da história.', false],
        ];
        function telaDescricao() {
            const d = Desc.v || descPadrao();
            const tk = estimarTokens(blocoDescricao());
            const lim = getConfig().limiteDescricao;
            const outros = cartaoTemOutrosCampos();
            let h =
                '<div class="spd-tela"><p class="sub">A Descrição é a ÚNICA fonte de quem ela é. Escreva curto: a IA recebe isto em todo prompt (' +
                tk +
                ' de ~' +
                lim +
                ' tokens sugeridos).</p>';
            if (cartaoTemDescricao() && !d.importadaDoCartaoEm)
                h +=
                    '<div class="spd-aviso">O cartão da personagem tem uma descrição. Se ela continuar lá E aqui, vai duplicada no prompt. <button class="spd-btn pq" data-a="desc-importar" style="margin-left:8px">Importar do cartão</button></div>';
            if (d.importadaDoCartaoEm && cartaoTemDescricao())
                h +=
                    '<div class="spd-aviso ruim">A descrição já foi importada, mas o cartão ainda tem texto na Descrição. Esvazie o campo no cartão do SillyTavern pra não ir duplicada.</div>';
            if (outros.length)
                h +=
                    '<div class="spd-aviso">O cartão também tem texto em: ' +
                    esc(outros.join(', ')) +
                    '. O que estiver lá também chega à IA; se já está aqui, esvazie lá.</div>';
            if (tk > lim)
                h +=
                    '<div class="spd-aviso">A Descrição passou de ~' +
                    lim +
                    ' tokens. Nada foi cortado; considere encurtar.</div>';
            h += CAMPOS_DESC.map(
                ([k, rot, sub, lista]) =>
                    '<div class="spd-campo"><label>' +
                    rot +
                    ' <span style="color:#6f7278">· ' +
                    sub +
                    '</span></label><textarea class="spd-ta peq" data-campo="desc.' +
                    k +
                    '">' +
                    esc(UI.rasc['desc.' + k] ?? (lista ? (d[k] || []).join('\n') : d[k])) +
                    '</textarea></div>'
            ).join('');
            return {
                titulo: 'Descrição',
                corpo:
                    h +
                    '<div style="display:flex;justify-content:flex-end"><button class="spd-btn prim" data-a="desc-salvar">Salvar descrição</button></div></div>',
            };
        }
        // ---- tela: Memória (3 gavetas, 7.1) ----
        function telaMemoria() {
            const p = montarPrompt();
            const g = p.gavetas;
            const barra = (x) =>
                '<div class="spd-barra" style="margin:10px 0 4px"><i class="' +
                (x.usado > x.limite ? 'ruim' : '') +
                '" style="width:' +
                Math.min(100, (x.usado / x.limite) * 100) +
                '%"></i></div>';
            const fatos = Mem.rp.fatos
                .map((f) => {
                    const sabe = sabeFato(f);
                    const fora = p.fora.memoria.some((x) => x.texto === f.texto);
                    return (
                        '<div class="spd-fato ' +
                        (fora ? 'fora' : '') +
                        '"><div class="tx">' +
                        esc(f.texto) +
                        '<small>sabem: ' +
                        esc((f.sabem || []).join(', ') || '—') +
                        (sabe ? '' : ' · ELA NÃO SABE (não vai pro prompt)') +
                        (fora ? ' · fora do orçamento' : '') +
                        '</small></div><button data-a="mem-edit" data-id="' +
                        f.id +
                        '" title="Editar">' +
                        ic('pen', 16) +
                        '</button><button data-a="mem-del" data-id="' +
                        f.id +
                        '" title="Apagar">' +
                        ic('trash', 16) +
                        '</button></div>'
                    );
                })
                .join('');
            const pedidos = (Mem.espaco.pedidos || [])
                .map(
                    (q) =>
                        '<div class="spd-fato"><div class="tx">' +
                        esc(q.texto) +
                        '</div><button data-a="pedido-del" data-id="' +
                        q.id +
                        '" title="Apagar">' +
                        ic('trash', 16) +
                        '</button></div>'
                )
                .join('');
            const rec = espacoPedidosRecentes()
                .map(
                    (m) =>
                        '<div class="spd-fato"><div class="tx">' +
                        esc(m.texto) +
                        '<small>pedido recente · vai na próxima fala</small></div></div>'
                )
                .join('');
            const notas =
                p.selecionadas
                    .map(
                        (e) =>
                            '<div class="spd-fato"><div class="tx">' +
                            esc(e.it.titulo) +
                            '<small>' +
                            { completa: 'nota completa', minima: 'nota mínima', titulo: 'só o título' }[e.modo] +
                            ' · ' +
                            esc(e.it.tipo) +
                            (e.viaCena
                                ? ' · da cena' +
                                  (e.viaTag
                                      ? ', tipo #' + esc(e.viaTag) + ' (gatilhos: ' + esc(e.termos.slice(1, 7).join(', ')) + ')'
                                      : e.termos && e.termos.length
                                        ? ' (combinou: ' + esc(e.termos.slice(0, 6).join(', ')) + ')'
                                        : ' (nada combinou: prioridade alta)')
                                : p.modoBiblioteca === 'cena'
                                  ? ' · sempre'
                                  : '') +
                            '</small></div></div>'
                    )
                    .join('') +
                p.fora.biblioteca
                    .map(
                        (f) =>
                            '<div class="spd-fato fora"><div class="tx">' +
                            esc(f.it.titulo) +
                            '<small>fora do orçamento — ' +
                            esc(f.motivo) +
                            '</small></div></div>'
                    )
                    .join('') +
                (p.foraCena || [])
                    .map(
                        (f) =>
                            '<div class="spd-fato fora"><div class="tx">' +
                            esc(f.it.titulo) +
                            '<small>' +
                            esc(f.motivo) +
                            ' · volta se a cena puxar o assunto</small></div></div>'
                    )
                    .join('');
            const cenaModo = p.modoBiblioteca === 'cena';
            const linhaCena =
                cenaModo && (p.cenaTags || []).length
                    ? '<div class="spd-aviso bom"><b>Cena reconhecida:</b> ' +
                      p.cenaTags
                          .map((x) => '#' + esc(x.tag) + ' (' + esc(x.gatilhos.join(', ')) + ')')
                          .join(' · ') +
                      '. Os arquivos com essa tag entram.</div>'
                    : '';
            const seletorModo =
                '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 4px">' +
                [
                    ['tudo', 'Todas as notas'],
                    ['cena', 'Só as da cena'],
                ]
                    .map(
                        ([v, r]) =>
                            '<button class="spd-btn ' +
                            (p.modoBiblioteca === v ? 'prim' : '') +
                            '" data-a="modo-bib" data-v="' +
                            v +
                            '">' +
                            r +
                            '</button>'
                    )
                    .join('') +
                '</div>';
            const pct = Math.round((p.total / p.limite) * 100);
            return {
                titulo: 'Memória',
                corpo:
                    '<div class="spd-tela"><div style="display:flex;gap:20px;align-items:center;margin-bottom:6px"><div class="spd-anel ' +
                    (pct > 100 ? 'ruim' : '') +
                    '" style="--p:' +
                    Math.min(100, pct) +
                    '"><div><span><b>' +
                    pct +
                    '%</b>do limite</span></div></div><div><div style="font-size:17px;color:#f0f1f3">' +
                    fmtNum(p.total) +
                    ' de ' +
                    fmtNum(p.limite) +
                    ' tokens</div><div class="sub" style="margin:4px 0 0">É o que a Spade injeta a cada fala (nada além disto).</div></div></div>' +
                    p.avisos.map((v) => '<div class="spd-aviso">' + esc(v) + '</div>').join('') +
                    '<div class="spd-gaveta"><h4>RP — o que aconteceu <span class="u">' +
                    g.rp.usado +
                    ' / ' +
                    g.rp.limite +
                    '</span></h4>' +
                    barra(g.rp) +
                    '<div class="sub">Fatos curtos com “quem sabe”. Só o que a personagem sabe chega à IA.</div>' +
                    (fatos || '<div class="spd-vazio" style="padding:14px">Ainda sem fatos.</div>') +
                    '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="spd-btn ciano" data-a="job-memoria">' +
                    ic('refresh', 16) +
                    'Atualizar com IA</button><button class="spd-btn" data-a="mem-add">' +
                    ic('plus', 16) +
                    'Adicionar fato</button></div></div>' +
                    '<div class="spd-gaveta"><h4>Espaço — pedidos ao RP <span class="u">' +
                    g.espaco.usado +
                    ' / ' +
                    g.espaco.limite +
                    '</span></h4>' +
                    barra(g.espaco) +
                    '<div class="sub">O que você pede no Espaço. As respostas da IA de lá nunca entram aqui.</div>' +
                    (pedidos || '') +
                    (rec || (pedidos ? '' : '<div class="spd-vazio" style="padding:14px">Nenhum pedido ainda.</div>')) +
                    '</div>' +
                    '<div class="spd-gaveta"><h4>Biblioteca — notas ativas <span class="u">' +
                    g.biblioteca.usado +
                    ' / ' +
                    g.biblioteca.limite +
                    '</span></h4>' +
                    barra(g.biblioteca) +
                    seletorModo +
                    '<div class="sub">' +
                    (cenaModo
                        ? 'A IA lê só a nota. Entram as marcadas “sempre incluir”, as regras, e as poucas notas que combinam com as últimas falas (a busca é por código, sem IA).'
                        : 'A IA lê só a nota. A mínima de todas entra primeiro; a completa sobe enquanto couber.') +
                    '</div>' +
                    linhaCena +
                    (notas || '<div class="spd-vazio" style="padding:14px">Nenhuma nota ativa e revisada.</div>') +
                    '</div></div>',
            };
        }
        // ---- tela: Prévia (13.5) ----
        function telaPrevia() {
            const p = montarPrompt();
            const o = Diag.ultimaOrdem;
            const T = tiposDoST();
            const ordem = o
                ? '<div class="spd-aviso ' +
                  (o.emOrdem && !o.faltando.length ? 'bom' : 'ruim') +
                  '"><b>Último prompt enviado (' +
                  fmtRel(Diag.ultimoPromptEm) +
                  '):</b> ' +
                  (o.emOrdem ? 'os blocos estão na ordem certa' : 'os blocos NÃO estão na ordem esperada') +
                  (o.faltando.length ? '; não achei no prompt final: ' + esc(o.faltando.join(', ')) : '') +
                  '<br>' +
                  o.achados.map((a) => a.n + ' ' + esc(a.titulo) + ' → mensagem ' + (a.msg + 1)).join(' · ') +
                  '</div>'
                : '<div class="spd-aviso">Ainda não vi nenhum prompt sair. Gere uma fala no RP e volte aqui: eu confiro a ordem real em que o SillyTavern montou tudo.</div>';
            const blocos = p.blocos
                .map(
                    (b) =>
                        '<details class="spd-bloco"><summary><span style="color:#8f929a;font:12px ui-monospace,monospace">' +
                        b.n +
                        '</span><span>' +
                        esc(b.titulo) +
                        '</span><span class="tk">' +
                        (b.texto ? b.tokens + ' tokens' : 'vazio') +
                        '</span></summary>' +
                        (b.texto ? '<pre>' + esc(b.texto) + '</pre>' : '') +
                        '</details>'
                )
                .join('');
            const fora = p.fora.biblioteca.concat(
                p.fora.memoria.map((x) => ({ it: { titulo: x.texto }, motivo: x.motivo })),
                p.fora.espaco.map((x) => ({ it: { titulo: x.texto }, motivo: x.motivo }))
            );
            const st =
                (Diag.eventosFaltando.length
                    ? 'Eventos que esta versão do SillyTavern não tem: ' + Diag.eventosFaltando.join(', ') + '. '
                    : '') +
                (T.deConstantes
                    ? 'Constantes de posição lidas do SillyTavern.'
                    : 'Constantes de posição NÃO expostas por esta versão: usei os números conhecidos (0/1/2) — confira a ordem acima.');
            return {
                titulo: 'Prévia do prompt',
                corpo:
                    '<div class="spd-tela"><p class="sub">É exatamente o que a Spade entrega ao SillyTavern, na ordem, com os tokens de cada bloco (estimados em ~3,5 caracteres por token). O chat em si (bloco 6) é do SillyTavern.</p>' +
                    p.avisos.map((v) => '<div class="spd-aviso">' + esc(v) + '</div>').join('') +
                    dosPreviaHtml(p) +
                    ordem +
                    '<div style="display:flex;justify-content:space-between;align-items:center;margin:14px 0"><span style="font-size:16px;color:#f0f1f3">Total: ' +
                    p.total +
                    ' de ' +
                    p.limite +
                    ' tokens' +
                    (p.totalDossie ? ' + perfil ' + p.totalDossie + ' (fora do limite geral, mas conta na janela real)' : '') +
                    '</span><button class="spd-btn pq" data-a="copiar-prompt">' +
                    ic('copy', 15) +
                    'Copiar</button></div>' +
                    blocos +
                    (fora.length
                        ? '<h3>Fora do orçamento (' +
                          fora.length +
                          ')</h3>' +
                          fora
                              .map(
                                  (f) =>
                                      '<div class="spd-fato fora"><div class="tx">' +
                                      esc(String(f.it.titulo).slice(0, 160)) +
                                      '<small>' +
                                      esc(f.motivo) +
                                      '</small></div></div>'
                              )
                              .join('')
                        : '') +
                    (p.naoSabe.length
                        ? '<h3>Fatos que ela NÃO sabe (' +
                          p.naoSabe.length +
                          ')</h3><p class="sub">Ficam só na tela; não vão pro prompt.</p>'
                        : '') +
                    '<details class="spd-bloco"><summary><span>Ver o texto final do prompt da Spade</span></summary><pre>' +
                    esc(promptComoTexto(p)) +
                    '</pre></details>' +
                    '<p class="sub" style="margin-top:22px">' +
                    esc(st) +
                    '</p></div>',
            };
        }
        // ---- tela: Jobs (12.4) ----
        function telaJobs() {
            const rot = { fila: 'na fila', rodando: 'rodando', ok: 'pronto', erro: 'erro', cancelado: 'cancelado' };
            const det = (j) => {
                const r = j.resultado;
                if (!r) return '';
                const l = [];
                if (r.novos && r.novos.length) l.push('+ ' + r.novos.join(' · '));
                if (r.substituidos && r.substituidos.length) l.push('~ ' + r.substituidos.join(' · '));
                if (r.removidos && r.removidos.length) l.push('− ' + r.removidos.join(' · '));
                if (r.pedidos) l.push(r.pedidos.length + ' pedido(s) duradouro(s)');
                if (r.aviso) l.push(r.aviso);
                return l.join('\n');
            };
            const lista = Jobs.lista
                .map(
                    (j) =>
                        '<div class="spd-job"><div class="l"><span class="n">' +
                        esc(j.nome) +
                        '</span><span class="st ' +
                        j.estado +
                        '">' +
                        rot[j.estado] +
                        '</span></div><div class="s">~' +
                        fmtNum(j.tokens) +
                        ' tokens' +
                        (j.detalhe ? ' · ' + esc(j.detalhe) : '') +
                        (j.fimEm ? ' · ' + fmtRel(j.fimEm) : '') +
                        '</div>' +
                        (j.erro
                            ? '<div class="spd-aviso ruim" style="margin:10px 0 0">' + esc(j.erro) + '</div>'
                            : '') +
                        (det(j)
                            ? '<div class="s" style="white-space:pre-wrap;color:#b6c0d3">' + esc(det(j)) + '</div>'
                            : '') +
                        '<div style="display:flex;gap:8px;margin-top:10px">' +
                        (j.estado === 'fila' || j.estado === 'rodando'
                            ? '<button class="spd-btn pq" data-a="job-cancelar" data-id="' +
                              j.id +
                              '">Cancelar</button>'
                            : '') +
                        (j.alvoId && j.estado === 'ok'
                            ? '<button class="spd-btn pq" data-a="abrir-arq" data-id="' +
                              j.alvoId +
                              '">Abrir arquivo</button>'
                            : '') +
                        (j.resultado && j.resultado.revisar && j.estado === 'ok'
                            ? '<button class="spd-btn prim pq" data-a="job-revisar" data-id="' +
                              j.id +
                              '">Revisar</button>'
                            : '') +
                        (j.desfazer && j.estado === 'ok'
                            ? '<button class="spd-btn pq" data-a="job-desfazer" data-id="' +
                              j.id +
                              '">Desfazer</button>'
                            : '') +
                        '</div></div>'
                )
                .join('');
            return {
                titulo: 'Jobs',
                corpo:
                    '<div class="spd-tela"><p class="sub">Tudo que usa a IA fora do RP aparece aqui. Nada roda sozinho: começa quando você toca num botão ou anexa um arquivo.</p>' +
                    (lista || '<div class="spd-vazio">Nenhum job nesta sessão.</div>') +
                    '</div>',
            };
        }
        // ---- Dossiê: telas (aba "Dossiê", cartão no Início, bloco na Prévia) ----
        const DOS_ROTULOS = [
            ['desligado', 'Desligado'],
            ['hibrido', 'Memória adaptativa (Híbrido)'],
            ['inteiro', 'Uma IA vê tudo (Inteiro)'],
        ];
        const DOS_DESC = {
            desligado: 'Desligado: a Spade não envia nenhum perfil por este recurso.',
            hibrido:
                'Memória adaptativa: núcleo que você aprovou + trechos literais do perfil que combinam com a cena. Só liga depois de aceitar o núcleo. A busca é local e pode deixar passar alguma nuance.',
            inteiro:
                'Uma IA vê tudo: o perfil completo vai em toda resposta, sem resumo. É o mais fiel, mas ocupa muito contexto e pode custar mais tokens.',
        };
        function dosEstadoTexto(info) {
            if (info.modo === 'desligado') return 'Desligado.';
            if (info.estado === 'ativo') return info.modo === 'inteiro' ? 'Ativo: perfil completo sendo enviado.' : 'Ativo: núcleo aceito + trechos da cena.';
            return 'Inativo — ' + info.motivo;
        }
        function dosCardHtml() {
            const cfg = getConfig();
            const info = dosBlocos(cfg).info;
            return (
                '<div class="spd-dos"><h3 style="margin-top:0">Perfil da personagem</h3>' +
                campoCfg('dossieModo', 'Modo', 'select', DOS_ROTULOS) +
                '<p class="sub">' +
                esc(DOS_DESC[info.modo] || DOS_DESC.desligado) +
                '</p><p class="sub">Perfil deste chat: <b>' +
                esc(info.nome || 'Nenhum') +
                '</b> · ' +
                esc(dosEstadoTexto(info)) +
                '</p><button class="spd-btn" data-a="nav-dossie">Abrir Dossiê</button></div>'
            );
        }
        function dosTabHtml() {
            const cfg = getConfig();
            const r = dosResolver();
            const info = dosBlocos(cfg).info;
            const lista = listaDossies();
            const chatId = stChatIdAtual();
            const sel =
                '<div class="spd-campo"><label>Perfil deste chat: Nenhum / arquivos</label><select class="spd-sel" data-a="dos-chat">' +
                '<option value="">Nenhum</option>' +
                lista.map((a) => '<option value="' + esc(a.id) + '" ' + (r.arqId === a.id ? 'selected' : '') + '>' + esc(a.meta.titulo || a.meta.nome) + '</option>').join('') +
                '</select></div>' +
                (chatId ? '' : '<div class="spd-aviso ruim">Este chat não tem identificação segura: nenhum perfil pode ser escolhido nem enviado.</div>');
            const cards = lista
                .map((a) => {
                    const n = dosNucleoDe(a);
                    const escolhido = r.arqId === a.id;
                    const c = escolhido && dosCacheBate(r) ? Dos.cache : null;
                    let st = 'Núcleo: nenhum.';
                    if (n.aceito && n.aceito.texto) {
                        if (c) st = c.hash === n.aceito.hash ? 'Núcleo aceito e válido para esta versão do arquivo.' : 'Precisa de revisão: o arquivo mudou depois do aceite (injeção suspensa).';
                        else st = 'Núcleo aceito em ' + new Date(n.aceito.em).toLocaleString('pt-BR') + ' (validade conferida quando o perfil for escolhido neste chat).';
                    } else if (n.proposta || n.rascunho) st = 'Núcleo em rascunho: falta aceitar.';
                    const txt = n.rascunho != null ? n.rascunho : (n.proposta && n.proposta.texto) || (n.aceito && n.aceito.texto) || '';
                    return (
                        '<div class="spd-dos" data-id="' +
                        esc(a.id) +
                        '"><div style="font-size:16px;color:#f0f1f3">' +
                        esc(a.meta.titulo || a.meta.nome) +
                        (escolhido ? ' <small>(deste chat)</small>' : '') +
                        '</div><p class="sub">' +
                        esc(a.meta.nome) +
                        ' · ' +
                        fmtNum(a.meta.dossieBytes || 0) +
                        ' bytes · ~' +
                        fmtNum(a.meta.dossieTokens || 0) +
                        ' tokens (estimativa)' +
                        (c ? ' · ' + c.secoes.filter((s) => s.tipo === 'secao').length + ' seções' + ' · versão ' + esc(c.hash) : '') +
                        '</p><div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">' +
                        '<button class="spd-btn" data-a="dos-ver" data-id="' + esc(a.id) + '">Ver perfil original</button>' +
                        '<button class="spd-btn" data-a="dos-preparar" data-id="' + esc(a.id) + '"' + (Dos.preparando ? ' disabled' : '') + '>' + (Dos.preparando === a.id ? 'Preparando…' : 'Preparar núcleo') + '</button>' +
                        '<button class="spd-btn" data-a="dos-reindexar" data-id="' + esc(a.id) + '">Reindexar</button>' +
                        '<button class="spd-btn" data-a="dos-previa">Prévia</button>' +
                        '<button class="spd-btn" data-a="dos-apagar" data-id="' + esc(a.id) + '">Apagar</button></div>' +
                        '<div class="spd-aviso ' + (st.startsWith('Núcleo aceito e válido') ? 'bom' : '') + '">' + esc(st) + '</div>' +
                        '<div class="spd-campo"><label>Núcleo (editável; nada entra no RP antes de Aceitar)</label><textarea class="spd-ta" rows="10" data-dos-nucleo="' + esc(a.id) + '">' + esc(txt) + '</textarea></div>' +
                        '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="spd-btn" data-a="dos-salvar" data-id="' + esc(a.id) + '">Editar (salvar rascunho)</button><button class="spd-btn pq" data-a="dos-aceitar" data-id="' + esc(a.id) + '">Aceitar</button></div>' +
                        (Dos.verId === a.id ? '<details open class="spd-bloco"><summary><span>Perfil original</span></summary><pre>' + esc(Dos.verTexto) + '</pre></details>' : '') +
                        '</div>'
                    );
                })
                .join('');
            return (
                '<h3 style="margin-top:0">Modo</h3>' +
                campoCfg('dossieModo', 'Como a IA do RP recebe o perfil', 'select', DOS_ROTULOS) +
                '<p class="sub">' + esc(DOS_DESC[info.modo] || DOS_DESC.desligado) + '</p>' +
                '<div class="spd-aviso ' + (info.estado === 'ativo' ? 'bom' : '') + '">' + esc(dosEstadoTexto(info)) + '</div>' +
                info.avisos.map((v) => '<div class="spd-aviso">' + esc(v) + '</div>').join('') +
                '<h3>Perfil deste chat</h3>' +
                sel +
                '<p class="sub">Só o perfil escolhido aqui é enviado, e só neste chat. Outros chats não recebem nada a menos que você escolha.</p>' +
                '<h3>Arquivos de perfil</h3>' +
                '<div style="margin-bottom:8px"><button class="spd-btn pq" data-a="dos-importar">Importar perfil (.txt ou .md)</button><input type="file" id="spd-file-dos" accept=".txt,.md,text/plain,text/markdown" hidden></div>' +
                (cards || '<div class="spd-vazio">Nenhum perfil importado.</div>') +
                '<h3>Limites (valores iniciais, ajustáveis)</h3><div class="spd-grid2">' +
                campoCfg('dossieLimiteTokens', 'Limite do perfil no Inteiro (tokens)', 'number') +
                campoCfg('nucleoLimiteTokens', 'Limite do núcleo (tokens)', 'number') +
                campoCfg('hibridoTrechosTokens', 'Orçamento dos trechos (tokens)', 'number') +
                campoCfg('hibridoMaxTrechos', 'Máx. de trechos por resposta', 'number') +
                campoCfg('hibridoContextoMsgs', 'Mensagens recentes consideradas', 'number') +
                '</div>' +
                (getConfig().diretor ? '<div class="spd-aviso">Existe uma configuração antiga “diretor”: está inativa nesta versão e não faz nenhuma chamada.</div>' : '')
            );
        }
        function dosPreviaHtml(p) {
            const i = p.dossie;
            if (!i) return '';
            const res = dosResiduos(p);
            const L = [];
            L.push('Modo: <b>' + esc((DOS_ROTULOS.find((x) => x[0] === i.modo) || [, i.modo])[1]) + '</b>');
            L.push('Chat: <b>' + esc(i.chatId || '(sem identificação)') + '</b>');
            L.push('Perfil escolhido: <b>' + esc(i.nome || 'Nenhum') + '</b>' + (i.hash ? ' · versão ' + esc(i.hash) : ''));
            L.push('Estado: ' + esc(dosEstadoTexto(i)));
            if (i.modo === 'inteiro' && i.perfilTokens)
                L.push('Perfil enviado: ~' + i.perfilTokens + ' tokens' + (i.pct != null ? ' (' + i.pct + '% de ' + i.contextSize + ')' : ' (contexto real não confirmado)'));
            if (i.modo === 'hibrido' && i.estado === 'ativo') {
                L.push('Núcleo: ~' + i.nucleoTokens + ' tokens');
                L.push('Trechos (' + i.trechos.length + '): ' + (i.trechos.length ? i.trechos.map((t) => esc(t.secao) + ' [' + t.tokens + ' tk · ' + t.score + ' · ' + esc(t.motivo) + ']').join(' · ') : 'nenhum'));
                const m = p.blocos.find((b) => b.chave === 'SPADE_4_MEMORIA');
                L.push('Memória do RP: ' + (m && m.texto ? '~' + m.tokens + ' tokens' : 'vazia'));
            }
            return (
                '<div class="spd-dos"><h3 style="margin-top:0">Perfil da personagem</h3><p class="sub">' +
                L.join('<br>') +
                '</p>' +
                i.avisos.map((v) => '<div class="spd-aviso">' + esc(v) + '</div>').join('') +
                res.map((v) => '<div class="spd-aviso ruim">' + esc(v) + '</div>').join('') +
                '</div>'
            );
        }
        async function dossieImportar(files) {
            await bibCarregar();
            let n = 0;
            for (const f of files) {
                try {
                    if (!/\.(txt|md)$/i.test(f.name)) throw new Error(f.name + ': só aceito .txt ou .md.');
                    const buf = await f.arrayBuffer();
                    let texto;
                    try {
                        texto = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
                    } catch (_) {
                        throw new Error(f.name + ': não está em UTF-8. Salve o arquivo como UTF-8 e tente de novo.');
                    }
                    if (texto.includes('\u0000')) throw new Error(f.name + ' não parece texto.');
                    await criarArquivo({
                        nome: f.name,
                        texto,
                        tipo: 'dossie',
                        importado: true,
                        extra: { dossieBytes: buf.byteLength, dossieTokens: estimarTokens(texto), dossie: { nucleo: {} } },
                    });
                    n++;
                } catch (e) {
                    falhou(e);
                }
            }
            if (n) toast(n + ' perfil(is) importado(s). Escolha o perfil deste chat para usar.');
            render();
        }
        const DOS_ACOES = {
            'nav-dossie': () => {
                UI.cfgAba = 'dossie';
                irPara('config');
            },
            'cfg-aba': (el) => {
                UI.cfgAba = el.dataset.v;
                render();
            },
            'dos-importar': () => {
                const i = UI.raiz.querySelector('#spd-file-dos');
                if (i) i.click();
            },
            'dos-chat': async (el) => {
                const chatId = stChatIdAtual();
                if (!chatId) return toast('Este chat não tem identificação segura: não dá para escolher um perfil.', true);
                dosAssocSet(chatId, el.value || null);
                Dos.cache = null;
                dosLimparSlots();
                await bibCarregar();
                await dossieSincronizar(true);
                aplicarSlots(montarPrompt());
                toast(el.value ? 'Perfil escolhido para este chat.' : 'Este chat ficou sem perfil.');
                render();
            },
            'dos-ver': async (el) => {
                if (Dos.verId === el.dataset.id) Dos.verId = null;
                else {
                    const d = await Disco.arqLer(el.dataset.id, ['original']);
                    Dos.verTexto = d.original || '';
                    Dos.verId = el.dataset.id;
                }
                render();
            },
            'dos-preparar': async (el) => {
                const a = Bib.arquivos.get(el.dataset.id);
                if (!a || Dos.preparando) return;
                Dos.preparando = a.id;
                render();
                try {
                    const r = await dossiePrepararNucleo(a);
                    toast('Proposta pronta (~' + r.tokens + ' tokens' + (r.partes > 1 ? ', usou ' + r.partes + ' partes do perfil' : '') + '). Revise, edite e toque em Aceitar.');
                } catch (e) {
                    falhou(e);
                } finally {
                    Dos.preparando = null;
                    render();
                }
            },
            'dos-salvar': async (el) => {
                const a = Bib.arquivos.get(el.dataset.id);
                const ta = UI.raiz.querySelector('[data-dos-nucleo="' + el.dataset.id + '"]');
                if (!a || !ta) return;
                a.meta.dossie = a.meta.dossie || {};
                a.meta.dossie.nucleo = Object.assign({}, a.meta.dossie.nucleo, { rascunho: ta.value });
                await salvarMetaArq(a);
                toast('Rascunho salvo. Ainda não vale para o RP: toque em Aceitar.');
                render();
            },
            'dos-aceitar': async (el) => {
                const a = Bib.arquivos.get(el.dataset.id);
                const ta = UI.raiz.querySelector('[data-dos-nucleo="' + el.dataset.id + '"]');
                if (!a || !ta) return;
                await dossieAceitarNucleo(a, ta.value);
                await dossieSincronizar(true);
                aplicarSlots(montarPrompt());
                toast('Núcleo aceito.');
                render();
            },
            'dos-reindexar': async (el) => {
                await recarregarArq(el.dataset.id);
                Dos.cache = null;
                const r = await dossieSincronizar(true);
                aplicarSlots(montarPrompt());
                toast(Dos.cache ? 'Reindexado: ' + Dos.cache.secoes.filter((s) => s.tipo === 'secao').length + ' seções.' : r && r.motivo ? r.motivo : 'Só o perfil escolhido neste chat é lido e indexado.');
                render();
            },
            'dos-previa': () => irPara('previa'),
            'dos-apagar': async (el) => {
                const a = Bib.arquivos.get(el.dataset.id);
                if (!a) return;
                const ok = await perguntar('Apagar o perfil “' + (a.meta.titulo || a.meta.nome) + '” da Biblioteca? Isso não dá para desfazer.', [
                    { rotulo: 'Cancelar', valor: false },
                    { rotulo: 'Apagar', valor: true, cls: 'prim' },
                ]);
                if (!ok) return;
                await apagarArquivo(a);
                Dos.cache = null;
                dosLimparSlots();
                render();
            },
        };
        Object.assign(globalThis.__SPADE_DOSSIE, {
            importar: dossieImportar,
            acoes: DOS_ACOES,
            aceitar: dossieAceitarNucleo,
            preparar: dossiePrepararNucleo,
            sincronizar: dossieSincronizar,
            lerOriginal: (id) => Disco.arqLer(id, ['original']).then((d) => d.original),
            arquivo: (id) => Bib.arquivos.get(id),
            montarPrompt: (o) => montarPrompt(o),
            aplicarSlots: () => aplicarSlots(montarPrompt()),
            contextoDoEspaco: () => contextoDoEspaco(),
            Dos,
        });
        // ---- tela: Configurações ----
        const campoCfg = (k, rot, tipo, extra) => {
            const c = getConfig();
            const v = c[k];
            const sel = (opts) =>
                '<select class="spd-sel" data-cfg="' +
                k +
                '">' +
                opts
                    .map(
                        ([val, r]) =>
                            '<option value="' +
                            val +
                            '" ' +
                            (String(v) === String(val) ? 'selected' : '') +
                            '>' +
                            r +
                            '</option>'
                    )
                    .join('') +
                '</select>';
            let inp;
            if (tipo === 'select') inp = sel(extra);
            else if (tipo === 'sw')
                inp = '<button class="spd-sw ' + (v ? 'on' : '') + '" data-a="cfg-sw" data-k="' + k + '"></button>';
            else if (tipo === 'ta')
                inp =
                    '<textarea class="spd-ta peq" data-cfg="' +
                    k +
                    '" placeholder="uma por linha">' +
                    esc((v || []).join('\n')) +
                    '</textarea>';
            else
                inp =
                    '<input class="spd-in" data-cfg="' +
                    k +
                    '" type="' +
                    tipo +
                    '"' +
                    (RT_DECIMAIS.includes(k) ? ' step="any"' : '') +
                    ' value="' +
                    esc(v) +
                    '">';
            return '<div class="spd-campo"><label>' + rot + '</label>' + inp + '</div>';
        };
        function telaConfigBase() {
            const T = tiposDoST();
            return {
                titulo: 'Configurações',
                corpo:
                    '<div class="spd-tela"><h3 style="margin-top:0">Disco</h3><div class="spd-aviso ' +
                    (Plug.ok ? 'bom' : 'ruim') +
                    '">' +
                    (Plug.ok
                        ? 'Plugin spade-fs ' +
                          esc(Plug.versao) +
                          ' conectado. Seus arquivos e memória ficam no disco do SillyTavern.'
                        : 'Plugin spade-fs não respondeu: ' +
                          esc(Plug.erro || 'não testado') +
                          '. Sem ele, tudo fica só neste navegador.') +
                    '</div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"><button class="spd-btn" data-a="checar-plugin">' +
                    ic('refresh', 16) +
                    'Testar plugin</button><button class="spd-btn" data-a="exportar">Exportar tudo</button><button class="spd-btn" data-a="backup">Backup no disco</button><button class="spd-btn" data-a="migrar">Migrar documentos antigos</button></div>' +
                    '<!--M--><h3>IA</h3>' +
                    campoCfg('apiKey', 'API key da NanoGPT (fica só neste navegador)', 'password') +
                    campoCfg('modelo', 'Modelo das análises e jobs (o modelo do RP é o do SillyTavern)', 'text') +
                    campoCfg('modeloNucleo', 'Modelo para preparar o núcleo do perfil (vazio = o mesmo das análises)', 'text') +
                    '<div class="spd-grid2">' +
                    campoCfg('tamanhoNota', 'Tamanho da nota', 'select', [
                        ['curta', 'curta (80–200 tokens)'],
                        ['padrao', 'padrão (120–400)'],
                        ['longa', 'longa (300–700)'],
                    ]) +
                    campoCfg('thinkingNosJobs', 'Raciocínio da IA nos jobs', 'select', [
                        ['disabled', 'desligado (mais rápido)'],
                        ['enabled', 'ligado'],
                        ['padrao', 'padrão do modelo'],
                    ]) +
                    '</div><!--/M-->' +
                    '<h3>Orçamento de tokens</h3><p class="sub">A soma das 3 gavetas não pode passar do limite geral.</p><div class="spd-grid2">' +
                    campoCfg('limiteGeral', 'Limite geral', 'number') +
                    campoCfg('limiteDescricao', 'Descrição (aviso)', 'number') +
                    campoCfg('limiteRp', 'Gaveta RP', 'number') +
                    campoCfg('limiteEspaco', 'Gaveta Espaço', 'number') +
                    campoCfg('limiteBiblioteca', 'Gaveta Biblioteca', 'number') +
                    campoCfg('avisoArquivoTokens', 'Avisar arquivo acima de (tokens)', 'number') +
                    campoCfg('modoBiblioteca', 'Notas da Biblioteca', 'select', [
                        ['tudo', 'todas as notas ativas (por orçamento)'],
                        ['cena', 'só as que combinam com a cena'],
                    ]) +
                    campoCfg('cenaMaxNotas', 'Modo cena: máx. de notas por fala', 'number') +
                    '</div>' +
                    '<h3>RP</h3><div class="spd-bar-sw"><span>Pedidos do Espaço valem no RP<small>chave geral</small></span><button class="spd-sw ' +
                    (getConfig().espacoParaRp ? 'on' : '') +
                    '" data-a="cfg-sw" data-k="espacoParaRp"></button></div><div class="spd-grid2" style="margin-top:14px">' +
                    campoCfg('espacoMaxMensagens', 'Mensagens recentes do Espaço enviadas ao RP', 'number') +
                    campoCfg('pessoaPensamento', 'Pensamento da personagem', 'select', [
                        ['1', '1ª pessoa'],
                        ['2', '2ª pessoa'],
                        ['3', '3ª pessoa'],
                    ]) +
                    campoCfg('estiloModo', 'Estilo', 'select', [
                        ['exemplos', 'exemplos (3 por resposta, girando)'],
                        ['desligado', 'desligado (sem exemplos)'],
                    ]) +
                    campoCfg('posicaoTopo', 'Posição dos blocos 1–4', 'select', [
                        ['in_prompt', 'no prompt'],
                        ['before_prompt', 'antes do prompt'],
                    ]) +
                    '</div>' +
                    campoCfg('tiquesCadastrados', 'Tiques que enjoei (palavras ou frases a evitar)', 'ta') +
                    '<h3>Resposta da IA do Espaço</h3><p class="sub">Tamanho máximo do que a IA do Espaço pode ESCREVER de volta (geração). Não é o “Orçamento de tokens” lá em cima, que limita o que a Spade ENVIA ao RP. Se a resposta passar do limite, ela é descartada inteira e nada é aplicado. Vai de ' +
                    ESP_RESP_TOKENS.min +
                    ' a ' +
                    ESP_RESP_TOKENS.max +
                    '; padrão ' +
                    ESP_RESP_TOKENS.padrao +
                    '.</p>' +
                    campoCfg('espacoMaxTokensResposta', 'Máximo de tokens da resposta do Espaço', 'number') +
                    '<h3>Espaço dinâmico</h3><div class="spd-aviso">Você só fala no Espaço; a IA decide sozinha se guarda e onde (numa ficha ou na memória da história) e mostra um cartão com Desfazer, Mover e Ver. Só acrescenta, só mexe no que ela mesma criou e nunca escreve na Descrição.</div><div class="spd-grid2">' +
                    campoCfg('espacoOrganiza', 'Organizar sozinha', 'select', [
                        ['avisar', 'avisar (guarda e mostra o cartão)'],
                        ['perguntar', 'perguntar (cartão com Guardar / Ignorar)'],
                        ['desligado', 'desligado (igual à 8.6.0)'],
                    ]) +
                    campoCfg('nomeDasFichas', 'Nome da pasta padrão', 'text') +
                    campoCfg('fichasMaxPorResposta', 'Máx. de anotações por resposta', 'number') +
                    campoCfg('fichasMaxPastasAuto', 'Máx. de pastas criadas sozinhas', 'number') +
                    campoCfg('fichasMaxArquivosAuto', 'Máx. de arquivos criados sozinhos', 'number') +
                    '</div>' +
                    rtPainelHtml() +
                    '<h3>Diagnóstico</h3><p class="sub">Spade ' +
                    VERSAO +
                    ' · constantes do SillyTavern: ' +
                    (T.deConstantes ? 'lidas' : 'padrão (0/1/2)') +
                    ' · eventos ausentes: ' +
                    (Diag.eventosFaltando.join(', ') || 'nenhum') +
                    ' · raciocínio ' +
                    (Pensa.recusado ? 'RECUSADO pela API (não enviado)' : 'não recusado') +
                    (Plug.ok ? ' · pasta de dados: ' + esc(Plug.pasta || '') : '') +
                    '</p></div>',
            };
        }
        function telaConfig() {
            const base = telaConfigBase();
            const h = base.corpo;
            const m = h.match(/<!--M-->([\s\S]*?)<!--\/M-->/);
            const modelos = m ? m[1] : '';
            const geral = h.replace(/<!--M-->[\s\S]*?<!--\/M-->/, '');
            const aba = ['geral', 'modelos', 'dossie'].includes(UI.cfgAba) ? UI.cfgAba : 'geral';
            const abas =
                '<div style="display:flex;gap:8px;margin-bottom:12px">' +
                [['geral', 'Geral'], ['modelos', 'Modelos'], ['dossie', 'Dossiê']]
                    .map(([k, r]) => '<button class="spd-tab ' + (aba === k ? 'on' : '') + '" data-a="cfg-aba" data-v="' + k + '">' + r + '</button>')
                    .join('') +
                '</div>';
            let corpo;
            if (aba === 'modelos') corpo = '<div class="spd-tela">' + abas + modelos + '</div>';
            else if (aba === 'dossie') corpo = '<div class="spd-tela">' + abas + dosTabHtml() + '</div>';
            else corpo = geral.replace('<div class="spd-tela">', '<div class="spd-tela">' + abas);
            return { titulo: base.titulo, corpo };
        }
        // ---- tela: Início (13.5) — só o que tem dado real ----
        function telaInicio() {
            const p = montarPrompt();
            const pct = Math.round((p.total / p.limite) * 100);
            const rec = listaArquivos()
                .sort((a, b) => (b.meta.editadoEm || 0) - (a.meta.editadoEm || 0))
                .slice(0, 4);
            const at = (t, i, r, s) =>
                '<button class="spd-atalho" data-a="nav" data-t="' +
                t +
                '">' +
                ic(i, 22) +
                '<span style="font-size:16px">' +
                r +
                '</span><small>' +
                s +
                '</small></button>';
            return {
                titulo: 'Início',
                corpo:
                    '<div class="spd-tela"><div style="display:flex;gap:22px;align-items:center"><div class="spd-anel ' +
                    (pct > 100 ? 'ruim' : '') +
                    '" style="--p:' +
                    Math.min(100, pct) +
                    '"><div><span><b>' +
                    pct +
                    '%</b>contexto</span></div></div><div><div style="font-size:20px;color:#f0f1f3">' +
                    esc(personagemAtual()) +
                    '</div><div class="sub" style="margin:6px 0 0">' +
                    p.total +
                    ' de ' +
                    p.limite +
                    ' tokens vão na próxima fala · ' +
                    listaArquivos().length +
                    ' arquivos · ' +
                    Mem.rp.fatos.length +
                    ' fatos na memória</div></div></div>' +
                    dosCardHtml() +
                    relCardHtml() +
                    rtCardHtml() +
                    fichasCardHtml() +
                    '<div class="spd-atalhos">' +
                    at('espaco', 'chat', 'Espaço', 'falar com a IA') +
                    at('pastas', 'book', 'Biblioteca', listaArquivos().length + ' arquivos') +
                    at('memoria', 'layers', 'Memória', '3 gavetas') +
                    at('descricao', 'user', 'Descrição', 'quem ela é') +
                    at('previa', 'eye', 'Prévia', 'o prompt real') +
                    at('jobs', 'list', 'Jobs', jobsAtivos().length + ' rodando') +
                    '</div>' +
                    (rec.length
                        ? '<h3>Recentes</h3><div class="spd-cards" style="grid-template-columns:repeat(auto-fill,minmax(240px,1fr))">' +
                          rec.map(cardHtml).join('') +
                          '</div>'
                        : '') +
                    '</div>',
            };
        }
        function renderTela() {
            try {
                switch (UI.tela) {
                    case 'pastas':
                        return telaPastas();
                    case 'lista':
                        return telaLista();
                    case 'arquivo':
                        return telaArquivo();
                    case 'descricao':
                        return telaDescricao();
                    case 'memoria':
                        return telaMemoria();
                    case 'previa':
                        return telaPrevia();
                    case 'jobs':
                        return telaJobs();
                    case 'revisar':
                        return telaRevisar();
                    case 'config':
                        return telaConfig();
                    case 'inicio':
                        return telaInicio();
                    default:
                        return telaEspaco();
                }
            } catch (e) {
                console.error('[Spade] tela', UI.tela, e);
                return {
                    titulo: 'Erro',
                    corpo:
                        '<div class="spd-vazio">Esta tela deu erro: ' +
                        esc(e.message) +
                        '<br><br><button class="spd-btn" data-a="nav" data-t="espaco">Voltar ao Espaço</button></div>',
                };
            }
        }

        // ---- ações (delegadas por data-a) ----
        async function lerArquivoTexto(f) {
            if (f.size > 8 * 1024 * 1024) throw new Error(f.name + ': passa de 8 MB.');
            const t = await f.text();
            if (t.includes('\u0000'))
                throw new Error(f.name + ' não parece texto (PDF e imagem ainda não são suportados).');
            return t;
        }
        const arq = (el) => Bib.arquivos.get(el.dataset.id || UI.arqId);
        const coletar = (prefixo, atual) => (UI.rasc[prefixo] != null ? UI.rasc[prefixo] : atual);
        const limpaRasc = (...ks) => ks.forEach((k) => delete UI.rasc[k]);
        async function salvarMetaToast(a, msg) {
            a.meta.editadoEm = Date.now();
            await salvarMetaArq(a);
            toast(msg || 'Salvo.');
            refrescarUI();
        }
        const ACOES = {
            fechar: () => fechar(),
            lateral: () => {
                UI.lateral = !UI.lateral;
                render();
            },
            nav: (el) => irPara(el.dataset.t),
            voltar: (el) => irPara(el.dataset.t),
            'rel-toggle': async () => {
                await memCarregar();
                const r = Mem.relogio;
                r.ligado = !r.ligado;
                r.ultimoIdx = (ctx().chat || []).length;
                await memSalvar('relogio');
                refrescarUI();
            },
            'rel-desfazer': () => relDesfazer(),
            'rel-ajustar': async () => {
                await memCarregar();
                const r = Mem.relogio;
                const campo = (rot, v, min, max) =>
                    '<div class="spd-campo" style="margin-top:12px"><label>' +
                    rot +
                    '</label><input class="spd-in" type="number" inputmode="numeric" min="' +
                    min +
                    '" max="' +
                    max +
                    '" value="' +
                    v +
                    '"></div>';
                modalForm(
                    'Ajustar o relógio da história',
                    campo('Dia', r.dia, 1, 9999) +
                        campo('Hora (0 a 23)', r.hora, 0, 23) +
                        campo('Minuto (0 a 59)', r.minuto, 0, 59),
                    async (m) => {
                        const [d, h, mi] = [...m.querySelectorAll('input')].map((x) => Number(x.value));
                        if (
                            !(d >= 1) ||
                            !(h >= 0 && h <= 23) ||
                            !(mi >= 0 && mi <= 59) ||
                            [d, h, mi].some((x) => !Number.isInteger(x))
                        )
                            throw new Error('Use números inteiros: dia ≥ 1, hora de 0 a 23, minuto de 0 a 59.');
                        await relAplicarPlano({ para: { dia: d, hora: h, minuto: mi } }, 'ajuste manual', {
                            ligar: true,
                        });
                        toast('Relógio ajustado.');
                    }
                );
            },
            'novo-chat': async () => {
                await novaConversa();
                irPara('espaco');
            },
            'buscar-conv': () => {
                UI.buscandoConv = true;
                render();
                const i = UI.raiz.querySelector('[data-campo="buscaConv"]');
                i && i.focus();
            },
            conv: async (el) => {
                await espacoAbrir(el.dataset.id);
                irPara('espaco');
            },
            caixa: async (el, ev) => {
                ev.stopPropagation();
                const id = el.dataset.id;
                if (grupoDaConversa(id)) {
                    await desconectarConversa(id);
                    return toast('Conversa desconectada.');
                }
                if (!Esp.abertaId) return toast('Abra uma conversa e toque na caixinha de OUTRA para conectar.');
                if (id === Esp.abertaId) return toast('Toque na caixinha de OUTRA conversa para conectar com esta.');
                await conectarConversas(Esp.abertaId, id);
                toast('Conversas conectadas.');
            },
            'renomear-conv': () => {
                const c = Esp.chats.find((x) => x.id === Esp.abertaId);
                if (!c) return;
                modalForm('Renomear conversa', '<input class="spd-in" value="' + esc(c.titulo) + '">', async (m) => {
                    c.titulo = m.querySelector('input').value.trim() || c.titulo;
                    await salvarEspacoChats();
                    refrescarUI();
                });
            },
            'apagar-conv': async () => {
                const ok = await perguntar('Apagar esta conversa do Espaço? Os pedidos dela deixam de valer no RP.', [
                    { rotulo: 'Cancelar', valor: false },
                    { rotulo: 'Apagar', valor: true, cls: 'perigo' },
                ]);
                if (ok) {
                    await apagarConversa(Esp.abertaId);
                    render();
                }
            },
            vale: async (el) => {
                const c = Esp.chats.find((x) => x.id === Esp.abertaId);
                if (c) await alternarEnvioAoRp(c.id, +el.dataset.i);
            },
            'desfazer-acao': async (el) => {
                const c = Esp.chats.find((x) => x.id === Esp.abertaId);
                if (!c) return;
                if (!c.stChatId || c.stChatId !== stChatIdAtual())
                    return toast('Abra o chat do RP ao qual esta conversa está ligada.', true);
                await desfazerAcaoEspaco(c.id, +el.dataset.i, +el.dataset.k);
            },
            // 8.7.0 — cartões de "guardar" (fichas do Espaço)
            'guardar-desfazer': async (el) => {
                const c = Esp.chats.find((x) => x.id === Esp.abertaId);
                if (!c) return;
                const h = await lerHistorico(c.id);
                const card = h[+el.dataset.i] && h[+el.dataset.i].acoes && h[+el.dataset.i].acoes[+el.dataset.k];
                if (card && card.onde === 'memoria' && (!c.stChatId || c.stChatId !== stChatIdAtual()))
                    return toast('Abra o chat do RP ao qual esta conversa está ligada.', true);
                await desfazerGuardarEspaco(c.id, +el.dataset.i, +el.dataset.k);
            },
            'guardar-mover': async (el) => {
                const c = Esp.chats.find((x) => x.id === Esp.abertaId);
                if (!c) return;
                const i = +el.dataset.i;
                const k = +el.dataset.k;
                const h = await lerHistorico(c.id);
                const card = h[i] && h[i].acoes && h[i].acoes[k];
                if (!card) return;
                const outras = fichasDoEspaco().filter((x) => x.id !== card.arquivoId);
                modalForm(
                    'Mover para outra ficha',
                    '<div class="spd-campo"><label>Ficha</label><select class="spd-sel" data-mv="alvo">' +
                        outras
                            .map(
                                (a) =>
                                    '<option value="' +
                                    a.id +
                                    '">' +
                                    esc(((pastaInfo(a.meta.pastaId) || {}).nome || '') + ' › ' + tituloArq(a)) +
                                    '</option>'
                            )
                            .join('') +
                        '<option value="">(nenhuma: criar uma nova)</option></select></div><div class="spd-campo" style="margin-top:12px"><label>Nome de uma ficha nova na mesma pasta (se preencher, vale este)</label><input class="spd-in" data-mv="novo" placeholder="Ex.: Jeito com parceiros"></div>',
                    async (m) => {
                        const alvo = m.querySelector('[data-mv="alvo"]').value;
                        const novo = m.querySelector('[data-mv="novo"]').value.trim();
                        if (!alvo && !novo) throw new Error('Escolha uma ficha ou dê um nome à nova.');
                        await moverGuardadoEspaco(c.id, i, k, novo ? { novo } : { arquivoId: alvo });
                    }
                );
            },
            'guardar-ver': async (el) => {
                const c = Esp.chats.find((x) => x.id === Esp.abertaId);
                if (!c) return;
                const h = await lerHistorico(c.id);
                const card = h[+el.dataset.i] && h[+el.dataset.i].acoes && h[+el.dataset.i].acoes[+el.dataset.k];
                if (!card) return;
                if (card.onde === 'memoria') return irPara('memoria');
                if (!Bib.arquivos.has(card.arquivoId)) return toast('Esta ficha não existe mais.', true);
                UI.rasc = {};
                irPara('arquivo', { arqId: card.arquivoId, expSel: 0, abaArq: 'texto', verTudo: false });
            },
            'guardar-confirmar': async (el) => {
                const c = Esp.chats.find((x) => x.id === Esp.abertaId);
                if (c) await guardarConfirmar(c.id, +el.dataset.i, +el.dataset.k);
            },
            'guardar-ignorar': async (el) => {
                const c = Esp.chats.find((x) => x.id === Esp.abertaId);
                if (c) await guardarIgnorar(c.id, +el.dataset.i, +el.dataset.k);
            },
            'guardar-resumir': async (el) => {
                const c = Esp.chats.find((x) => x.id === Esp.abertaId);
                if (!c) return;
                const h = await lerHistorico(c.id);
                const card = h[+el.dataset.i] && h[+el.dataset.i].acoes && h[+el.dataset.i].acoes[+el.dataset.k];
                const a = card && Bib.arquivos.get(card.arquivoId);
                if (!a) return toast('Esta ficha não existe mais.', true);
                rodarAnalise(a);
                toast('Resumo na fila (veja em Jobs). A nota resumida só entra depois que você revisar.');
            },
            'fichas-ver': () => {
                const meus = Bib.indice.pastas.filter((x) => x.origem === 'espaco');
                const p = meus.find((x) => nomesEquivalentes(x.nome, nomePadraoFichas())) || meus[0];
                if (!p) return toast('Ainda não há fichas criadas pelo Espaço.');
                irPara('lista', {
                    pastaSel: p.id,
                    filtroTipo: 'todos',
                    filtroTag: '',
                    busca: '',
                    modoGrupo: false,
                    selGrupo: new Set(),
                });
            },
            // 8.8.0 — Fase 2 do Espaço dinâmico
            'fichas-organizar': () => {
                rodarOrganizar();
                toast('Lendo suas conversas antigas — acompanhe em Jobs. Nada é guardado sem você revisar.');
            },
            'fichas-arrumar': () => {
                rodarArrumar();
                toast('Procurando fichas pra juntar — acompanhe em Jobs. Nada é mexido sem você aprovar.');
            },
            'job-revisar': (el) => irPara('revisar', { revJobId: el.dataset.id }),
            'rev-marca': (el) => {
                const j = revJob();
                const p = j && j.resultado && j.resultado.revisar && j.resultado.revisar.propostas.find((x) => x.id === el.dataset.id);
                if (p && p.estado === 'pendente') {
                    p.marcada = !p.marcada;
                    render();
                }
            },
            'rev-todas': () => {
                const j = revJob();
                const rv = j && j.resultado && j.resultado.revisar;
                rv && rv.propostas.forEach((p) => p.estado === 'pendente' && (p.marcada = true));
                render();
            },
            'rev-nenhuma': () => {
                const j = revJob();
                const rv = j && j.resultado && j.resultado.revisar;
                rv && rv.propostas.forEach((p) => p.estado === 'pendente' && (p.marcada = false));
                render();
            },
            'rev-aplicar': async () => {
                const j = revJob();
                if (j) await revisaoAplicar(j);
            },
            'rev-desfazer': async (el) => {
                const j = revJob();
                if (j) await revisaoDesfazer(j, el.dataset.id);
            },
            'rev-ver': (el) => {
                const j = revJob();
                const p = j && j.resultado && j.resultado.revisar && j.resultado.revisar.propostas.find((x) => x.id === el.dataset.id);
                if (!p || !p.card || !Bib.arquivos.has(p.card.arquivoId)) return toast('Esta ficha não existe mais.', true);
                UI.rasc = {};
                irPara('arquivo', { arqId: p.card.arquivoId, expSel: 0, abaArq: 'texto', verTudo: false });
            },
            'guardar-desc': async (el) => {
                const c = Esp.chats.find((x) => x.id === Esp.abertaId);
                if (!c) return;
                const h = await lerHistorico(c.id);
                const card = h[+el.dataset.i] && h[+el.dataset.i].acoes && h[+el.dataset.i].acoes[+el.dataset.k];
                if (!card || !card.texto) return;
                modalCopiar(
                    'Passar pra Descrição',
                    'A Spade não escreve na Descrição. Copie este texto e cole no campo certo (Aparência, Temperamento, O que muda o humor, Como fala, O que sabe). Depois, se quiser, use Desfazer no cartão pra tirar da ficha e não ficar duas vezes.',
                    card.texto,
                    () => irPara('descricao')
                );
            },
            'fichas-toggle': () => {
                setConfig({ espacoOrganiza: organizaModo() === 'desligado' ? 'avisar' : 'desligado' });
                toast(organizaModo() === 'desligado' ? 'Espaço dinâmico desligado.' : 'Espaço dinâmico ligado.');
                render();
            },
            anexar: () => {
                const f = UI.raiz.querySelector('#spd-file');
                f && f.click();
            },
            'rm-anexo': (el) => {
                UI.anexos.splice(+el.dataset.i, 1);
                render();
            },
            enviar: async () => {
                const t = UI.rasc.composer || '';
                const an = UI.anexos;
                if (!t.trim() && !an.length) return;
                UI.rasc.composer = '';
                UI.anexos = [];
                render();
                await enviarMensagemEspaco(t, an);
            },
            'job-memoria': () => {
                rodarMemoriaRp();
                toast('Atualizando a memória — veja em Jobs.');
            },
            'job-espaco': () => {
                const textos = Esp.paraRp
                    .filter((m) => m.enviar)
                    .slice(0, Math.max(0, Esp.paraRp.filter((m) => m.enviar).length - getConfig().espacoMaxMensagens))
                    .map((m) => m.texto);
                rodarConsolidarEspaco(textos);
                toast('Consolidando pedidos — veja em Jobs.');
            },
            // biblioteca
            'ir-lista': (el) =>
                irPara('lista', {
                    pastaSel: el.dataset.p,
                    filtroTipo: el.dataset.tp || 'todos',
                    filtroTag: '',
                    busca: '',
                    modoGrupo: false,
                    selGrupo: new Set(),
                }),
            'nova-pasta': () =>
                modalForm(
                    'Nova pasta',
                    '<input class="spd-in" placeholder="Nome da pasta">' + swatches(CORES_PASTA[0]),
                    async (m) => {
                        const n = m.querySelector('input').value.trim();
                        if (!n) throw new Error('Dê um nome à pasta.');
                        await criarPasta(n, m.dataset.cor);
                        render();
                    }
                ),
            'editar-pasta': (el) => {
                const p = pastaInfo(el.dataset.id);
                modalForm(
                    'Editar pasta',
                    '<input class="spd-in" value="' + esc(p.nome) + '">' + swatches(p.cor),
                    async (m) => {
                        await mudarPasta(p.id, {
                            nome: m.querySelector('input').value.trim() || p.nome,
                            cor: m.dataset.cor || p.cor,
                        });
                        render();
                    },
                    {
                        rotulo: 'Apagar pasta',
                        fn: async () => {
                            const ok = await perguntar(
                                'Apagar a pasta “' +
                                    p.nome +
                                    '”? Os arquivos dela vão para a primeira pasta que sobrar — nada é apagado.',
                                [
                                    { rotulo: 'Cancelar', valor: false },
                                    { rotulo: 'Apagar pasta', valor: true, cls: 'perigo' },
                                ]
                            );
                            if (ok) {
                                await apagarPasta(p.id);
                                render();
                            }
                        },
                    }
                );
            },
            filtro: (el) => {
                UI.filtroTipo = el.dataset.t;
                render();
            },
            'filtro-tag': (el) => {
                UI.filtroTag = UI.filtroTag === el.dataset.t ? '' : el.dataset.t;
                render();
            },
            'tag-add': (el) => {
                const a = arq(el);
                modalForm('Nova tag', '<input class="spd-in" placeholder="Ex.: falas">', async (m) => {
                    const t = normTag(m.querySelector('input').value);
                    if (!t) return;
                    a.meta.tagsRemovidas = (a.meta.tagsRemovidas || []).filter((x) => normTag(x) !== t);
                    if (!(a.meta.tagsUsuario || []).map(normTag).includes(t)) a.meta.tagsUsuario = (a.meta.tagsUsuario || []).concat(t);
                    await salvarMetaToast(a);
                });
            },
            // 8.5: editar os gatilhos (palavras que mostram o tipo da cena) das tags deste arquivo
            'tag-gatilhos': (el) => {
                const a = arq(el);
                const ts = tagsDe(a);
                if (!ts.length) return;
                const campos = ts
                    .map(
                        (t) =>
                            '<label class="sub" style="display:block;margin:10px 0 4px">#' +
                            esc(t) +
                            '</label><textarea class="spd-in" data-tag="' +
                            esc(t) +
                            '" rows="3" placeholder="Deixe vazio se não for um tipo de cena (ex.: tom, falas)">' +
                            esc(gatilhosDaTag(t).join(', ')) +
                            '</textarea>'
                    )
                    .join('');
                modalForm(
                    'Gatilhos das tags',
                    '<div class="sub">Palavras que, aparecendo nas últimas falas, mostram que a cena é desse tipo. Quando a cena bate, os arquivos com a tag entram. Separe por vírgula.</div>' +
                        campos,
                    async (m) => {
                        Bib.indice.tagGatilhos = Bib.indice.tagGatilhos || {};
                        m.querySelectorAll('textarea[data-tag]').forEach((tx) => {
                            const t = tx.dataset.tag;
                            const novos = [...new Set(tx.value.split(/[,;\n]/).map(normGat).filter(Boolean))].slice(0, 30);
                            const antes = Bib.indice.tagGatilhos[t] || {};
                            const tinha = gatilhosDaTag(t).concat(antes.lista || [], antes.removidos || []);
                            Bib.indice.tagGatilhos[t] = {
                                lista: novos,
                                removidos: [...new Set(tinha.map(normGat))].filter((w) => w && !novos.includes(w)),
                            };
                        });
                        await bibSalvarIndice();
                        toast('Gatilhos salvos.');
                        refrescarUI();
                    }
                );
            },
            'tag-del': async (el) => {
                const a = arq(el);
                const t = normTag(el.dataset.t);
                a.meta.tagsUsuario = (a.meta.tagsUsuario || []).filter((x) => normTag(x) !== t);
                if (((a.nota && a.nota.tags) || []).map(normTag).includes(t))
                    a.meta.tagsRemovidas = (a.meta.tagsRemovidas || []).concat(t);
                await salvarMetaToast(a);
            },
            'modo-grupo': () => {
                UI.modoGrupo = !UI.modoGrupo;
                UI.selGrupo = new Set();
                render();
            },
            'cancelar-grupo': () => {
                UI.modoGrupo = false;
                UI.selGrupo = new Set();
                render();
            },
            'criar-grupo': () =>
                modalForm('Nome do grupo', '<input class="spd-in" placeholder="Ex.: Família da Hanna">', async (m) => {
                    await ligarGrupo([...UI.selGrupo], m.querySelector('input').value.trim() || 'Grupo');
                    UI.modoGrupo = false;
                    UI.selGrupo = new Set();
                    toast('Grupo criado. Escreva ou gere a nota do grupo.');
                    render();
                }),
            'editar-grupo': (el) => {
                const g = Bib.indice.grupos.find((x) => x.id === el.dataset.id);
                const n = g.nota || { completa: '', minima: '' };
                modalForm(
                    'Grupo: ' + g.nome,
                    '<p class="sub" style="color:#8f929a;margin:0 0 10px">' +
                        g.arquivoIds.length +
                        ' arquivos. Com nota própria, só ela entra no prompt (as dos membros ficam de fora).</p><div class="spd-campo"><label>Nota completa</label><textarea class="spd-ta peq" id="gc">' +
                        esc(n.completa) +
                        '</textarea></div><div class="spd-campo"><label>Nota mínima</label><textarea class="spd-ta peq" id="gm" style="min-height:70px">' +
                        esc(n.minima) +
                        '</textarea></div><button class="spd-btn pq" id="gia">Gerar com IA</button>',
                    async (m) => {
                        const c = m.querySelector('#gc').value.trim();
                        g.nota = c
                            ? {
                                  completa: c,
                                  minima: m.querySelector('#gm').value.trim(),
                                  geradaEm: Date.now(),
                                  editadaPeloUsuario: true,
                                  revisada: true,
                              }
                            : null;
                        await bibSalvarIndice();
                        render();
                    },
                    {
                        rotulo: 'Desfazer grupo',
                        fn: async () => {
                            await desfazerGrupo(g.id);
                            render();
                        },
                    }
                );
                const bt = UI.raiz.querySelector('#gia');
                if (bt)
                    bt.onclick = () => {
                        rodarNotaDeGrupo(g);
                        toast('Gerando a nota do grupo — veja em Jobs.');
                    };
            },
            'adicionar-arq': () => {
                const f = UI.raiz.querySelector('#spd-file-bib');
                f && f.click();
            },
            'abrir-arq': (el) => {
                if (UI.modoGrupo && UI.tela === 'lista') {
                    const id = el.dataset.id;
                    UI.selGrupo.has(id) ? UI.selGrupo.delete(id) : UI.selGrupo.add(id);
                    return render();
                }
                UI.rasc = {};
                irPara('arquivo', { arqId: el.dataset.id, expSel: 0, abaArq: 'texto', verTudo: false });
            },
            aba: (el) => {
                UI.abaArq = el.dataset.t;
                render();
            },
            'ver-tudo': () => {
                UI.verTudo = true;
                render();
            },
            // arquivo: explicação / observação
            'exp-add': async () => {
                const a = arq({ dataset: {} });
                a.meta.explicacoes.push({ id: newId('e'), texto: '', criadoEm: Date.now() });
                UI.expSel = a.meta.explicacoes.length - 1;
                await salvarMetaToast(a, 'Explicação criada. Escreva e salve.');
            },
            'exp-sel': (el) => {
                UI.expSel = +el.dataset.i;
                render();
            },
            'exp-salvar': async () => {
                const a = arq({ dataset: {} });
                const i = Math.min(UI.expSel, a.meta.explicacoes.length - 1);
                a.meta.explicacoes[i].texto = coletar('exp.' + i, a.meta.explicacoes[i].texto);
                limpaRasc('exp.' + i);
                await salvarMetaToast(a);
            },
            'exp-del': async () => {
                const a = arq({ dataset: {} });
                a.meta.explicacoes.splice(UI.expSel, 1);
                UI.expSel = Math.max(0, UI.expSel - 1);
                UI.rasc = {};
                await salvarMetaToast(a, 'Explicação removida.');
            },
            'obs-olho': async () => {
                const a = arq({ dataset: {} });
                a.meta.observacaoVisivelParaIA = !a.meta.observacaoVisivelParaIA;
                await salvarMetaToast(
                    a,
                    a.meta.observacaoVisivelParaIA ? 'A IA vê a observação.' : 'A IA não vê a observação.'
                );
            },
            'obs-salvar': async () => {
                const a = arq({ dataset: {} });
                a.meta.observacao = coletar('obs', a.meta.observacao);
                limpaRasc('obs');
                await salvarMetaToast(a);
            },
            // arquivo: nota e análise
            analisar: async (el) => {
                const a = arq(el);
                const cfg = getConfig();
                if ((a.meta.chars || 0) / 3.5 > cfg.avisoArquivoTokens) {
                    const ok = await perguntar(
                        'Este arquivo é grande (~' +
                            fmtNum(Math.round(a.meta.chars / 3.5)) +
                            ' tokens) e vai INTEIRO para a IA. Analisar mesmo assim?',
                        [
                            { rotulo: 'Cancelar', valor: false },
                            { rotulo: 'Analisar', valor: true, cls: 'prim' },
                        ]
                    );
                    if (!ok) return;
                }
                rodarAnalise(a);
                toast('Análise na fila — acompanhe em Jobs.');
            },
            'salvar-nota': async (el) => {
                const a = arq(el);
                a.nota.completa = coletar('nota.completa', a.nota.completa);
                a.nota.minima = coletar('nota.minima', a.nota.minima);
                a.nota.editadaPeloUsuario = true;
                a.nota.revisada = true;
                limpaRasc('nota.completa', 'nota.minima');
                await salvarNotaArq(a);
                toast('Nota salva.');
                refrescarUI();
            },
            'aceitar-nota': async (el) => {
                const a = arq(el);
                a.nota.completa = coletar('nota.completa', a.nota.completa);
                a.nota.minima = coletar('nota.minima', a.nota.minima);
                a.nota.revisada = true;
                limpaRasc('nota.completa', 'nota.minima');
                await salvarNotaArq(a);
                toast('Nota aceita — já pode entrar no prompt.');
                refrescarUI();
            },
            'gerar-minima': (el) => {
                rodarMinima(arq(el));
                toast('Gerando a mínima — veja em Jobs.');
            },
            'proposta-usar': async (el) => {
                const a = arq(el);
                const velha = a.nota;
                const nova = velha.proposta;
                nova.historico = [{ completa: velha.completa, minima: velha.minima, em: velha.geradaEm }]
                    .concat(velha.historico || [])
                    .slice(0, 5);
                a.nota = nova;
                a.meta.analisadoEm = Date.now();
                await salvarNotaArq(a);
                await salvarMetaArq(a);
                refrescarUI();
            },
            'proposta-descartar': async (el) => {
                const a = arq(el);
                delete a.nota.proposta;
                await salvarNotaArq(a);
                refrescarUI();
            },
            tg: async (el) => {
                const a = arq(el);
                const k = el.dataset.k;
                a.meta[k] = !a.meta[k];
                await salvarMetaToast(a, 'Salvo.');
            },
            sel: async (el) => {
                const a = arq(el);
                const k = el.dataset.k;
                let v = el.value;
                if (k === 'tipo' && v === '__novo') {
                    modalForm(
                        'Novo tipo de arquivo',
                        '<input class="spd-in" placeholder="Ex.: cenário">' + swatches('#c4c6d2'),
                        async (m) => {
                            const id = await criarTipo(m.querySelector('input').value, m.dataset.cor);
                            a.meta.tipo = id;
                            await salvarMetaToast(a);
                        }
                    );
                    return render();
                }
                a.meta[k] = v;
                if (k === 'pastaId') setConfig({ ultimaPasta: v });
                await salvarMetaToast(a);
            },
            voz: async (el) => {
                const a = arq(el);
                const v = el.value;
                const ok = await perguntar(
                    'Reanalisar medindo só a voz “' +
                        v +
                        '”? Os exemplos e medidas serão refeitos (a nota que você editou não é trocada sem perguntar).',
                    [
                        { rotulo: 'Cancelar', valor: false },
                        { rotulo: 'Reanalisar', valor: true, cls: 'prim' },
                    ]
                );
                if (ok) {
                    rodarAnalise(a, { vozAlvo: v });
                    toast('Reanálise na fila.');
                } else render();
            },
            'ex-fav': async (el) => {
                const a = arq(el);
                const e = a.nota.estilo.exemplos.find((x) => x.id === el.dataset.x);
                e.favorito = !e.favorito;
                if (e.favorito) e.bloqueado = false;
                a.nota.estilo.editadaPeloUsuario = true;
                await salvarNotaArq(a);
                refrescarUI();
            },
            'ex-blq': async (el) => {
                const a = arq(el);
                const e = a.nota.estilo.exemplos.find((x) => x.id === el.dataset.x);
                e.bloqueado = !e.bloqueado;
                if (e.bloqueado) e.favorito = false;
                a.nota.estilo.editadaPeloUsuario = true;
                await salvarNotaArq(a);
                refrescarUI();
            },
            'apagar-arq': async (el) => {
                const a = arq(el);
                const ok = await perguntar('Apagar “' + a.meta.nome + '” e a nota dele? Fica um backup no disco.', [
                    { rotulo: 'Cancelar', valor: false },
                    { rotulo: 'Apagar', valor: true, cls: 'perigo' },
                ]);
                if (!ok) return;
                await apagarArquivo(a);
                UI.original.delete(a.id);
                toast('Arquivo apagado.');
                irPara('lista');
            },
            // descrição / memória
            'desc-salvar': async () => {
                await descCarregar();
                for (const [k, , , lista] of CAMPOS_DESC) {
                    const v = UI.rasc['desc.' + k];
                    if (v != null)
                        Desc.v[k] = lista
                            ? v
                                  .split('\n')
                                  .map((x) => x.trim())
                                  .filter(Boolean)
                            : v;
                }
                UI.rasc = {};
                await descSalvar();
                toast('Descrição salva.');
                refrescarUI();
            },
            'desc-importar': async () => {
                await descImportarDoCartao();
                toast('Descrição importada. Esvazie o campo no cartão do SillyTavern.');
                render();
            },
            'mem-add': () =>
                modalForm(
                    'Novo fato',
                    '<textarea class="spd-ta peq" placeholder="Uma frase curta e concreta"></textarea><div class="spd-campo" style="margin-top:12px"><label>Quem sabe (separe por vírgula)</label><input class="spd-in" value="' +
                        esc(personagemAtual()) +
                        '"></div>',
                    async (m) => {
                        const t = m.querySelector('textarea').value.trim();
                        if (!t) throw new Error('Escreva o fato.');
                        Mem.rp.fatos.push({
                            id: newId('f'),
                            texto: t,
                            sabem: m
                                .querySelector('input')
                                .value.split(',')
                                .map((x) => x.trim())
                                .filter(Boolean),
                            criadoEm: Date.now(),
                        });
                        await memSalvar('rp');
                        render();
                    }
                ),
            'mem-edit': (el) => {
                const f = Mem.rp.fatos.find((x) => x.id === el.dataset.id);
                modalForm(
                    'Editar fato',
                    '<textarea class="spd-ta peq">' +
                        esc(f.texto) +
                        '</textarea><div class="spd-campo" style="margin-top:12px"><label>Quem sabe (separe por vírgula)</label><input class="spd-in" value="' +
                        esc((f.sabem || []).join(', ')) +
                        '"></div>',
                    async (m) => {
                        f.texto = m.querySelector('textarea').value.trim() || f.texto;
                        f.sabem = m
                            .querySelector('input')
                            .value.split(',')
                            .map((x) => x.trim())
                            .filter(Boolean);
                        await memSalvar('rp');
                        render();
                    }
                );
            },
            'mem-del': async (el) => {
                Mem.rp.fatos = Mem.rp.fatos.filter((x) => x.id !== el.dataset.id);
                await memSalvar('rp');
                render();
            },
            'pedido-del': async (el) => {
                Mem.espaco.pedidos = Mem.espaco.pedidos.filter((x) => x.id !== el.dataset.id);
                await memSalvar('espaco');
                render();
            },
            // jobs / prévia / config
            'job-cancelar': (el) => {
                const j = Jobs.lista.find((x) => x.id === el.dataset.id);
                j && cancelarJob(j);
            },
            'job-desfazer': async (el) => {
                const j = Jobs.lista.find((x) => x.id === el.dataset.id);
                if (j && j.desfazer) {
                    await j.desfazer();
                    j.desfazer = null;
                    toast('Desfeito.');
                    render();
                }
            },
            'copiar-prompt': async () => {
                try {
                    await navigator.clipboard.writeText(promptComoTexto(montarPrompt()));
                    toast('Prompt copiado.');
                } catch (e) {
                    toast('Não consegui copiar: ' + e.message, true);
                }
            },
            'modo-bib': (el) => {
                setConfig({ modoBiblioteca: el.dataset.v === 'cena' ? 'cena' : 'tudo' });
                sincronizarSoon();
                render();
            },
            'cfg-sw': (el) => {
                setConfig({ [el.dataset.k]: !getConfig()[el.dataset.k] });
                if (el.dataset.k === 'rtLigado') rtAoMudarLigado();
                sincronizarSoon();
                render();
            },
            'rt-toggle': () => {
                setConfig({ rtLigado: !getConfig().rtLigado });
                rtAoMudarLigado();
                toast(getConfig().rtLigado ? 'Tempo real ligado.' : 'Tempo real desligado.');
                render();
            },
            'checar-plugin': async () => {
                await checarPlugin();
                toast(Plug.ok ? 'Plugin conectado (v' + Plug.versao + ').' : 'Plugin não respondeu.', !Plug.ok);
                render();
            },
            exportar: async () => {
                const r = await exportarTudo();
                toast('Exportado: ' + r.arquivos + ' arquivos e ' + r.conversas + ' conversas.');
            },
            backup: async () => {
                const r = await backupAgora();
                toast('Backup criado: ' + r.nome + ' (' + r.arquivos + ' arquivos).');
            },
            migrar: async () => {
                const ok = await perguntar(
                    'Trazer os documentos antigos (da versão 7) para a Biblioteca? Faço um backup antes e rodar de novo não duplica nada.',
                    [
                        { rotulo: 'Cancelar', valor: false },
                        { rotulo: 'Migrar', valor: true, cls: 'prim' },
                    ]
                );
                if (!ok) return;
                toast('Migrando…');
                const r = await migrarDocumentos();
                await perguntar(
                    'Migração: ' +
                        r.criados +
                        ' criados, ' +
                        r.jaExistiam +
                        ' já existiam' +
                        (r.erros.length ? ', ' + r.erros.length + ' com erro' : '') +
                        '. ' +
                        r.comNota +
                        ' já com nota (curtos) e ' +
                        r.semNota +
                        ' esperando análise. Backup: ' +
                        (r.backup || '—') +
                        '.',
                    [{ rotulo: 'Ok', valor: true, cls: 'prim' }]
                );
                render();
            },
        };
        Object.assign(ACOES, DOS_ACOES);
        function salvarCfg(el) {
            const k = el.dataset.cfg;
            let v = el.value;
            const digitado = el.value; // 8.9.2: pra avisar quando o valor foi ajustado à faixa
            const atual = getConfig();
            if (RT_DECIMAIS.includes(k)) v = Math.min(20, Math.max(0.5, Number(String(v).replace(',', '.')) || CFG_PADRAO[k]));
            else if (RT_LIMITES[k]) {
                const [mn, mx] = RT_LIMITES[k];
                v = Math.min(mx, Math.max(mn, Math.round(Number(v)) || CFG_PADRAO[k]));
            } else if (k === 'nomeDasFichas') v = fNome(v, 30) || CFG_PADRAO[k];
            else if (el.type === 'number') v = Math.max(0, Math.round(Number(v) || 0));
            else if (k === 'pessoaPensamento') v = Number(v);
            else if (k === 'tiquesCadastrados')
                v = v
                    .split('\n')
                    .map((x) => x.trim())
                    .filter(Boolean);
            const prox = Object.assign({}, atual, { [k]: v });
            if (
                ['limiteRp', 'limiteEspaco', 'limiteBiblioteca', 'limiteGeral'].includes(k) &&
                prox.limiteRp + prox.limiteEspaco + prox.limiteBiblioteca > prox.limiteGeral
            ) {
                toast(
                    'A soma das 3 gavetas (' +
                        (prox.limiteRp + prox.limiteEspaco + prox.limiteBiblioteca) +
                        ') passa do limite geral (' +
                        prox.limiteGeral +
                        '). Não salvei.',
                    true
                );
                return render();
            }
            setConfig({ [k]: v });
            if (/^(dossie|hibrido|nucleo)/.test(k)) aplicarSlots(montarPrompt()); // 8.9.0: troca de modo limpa os slots NA HORA
            sincronizarSoon();
            if (k === 'espacoMaxTokensResposta' && Math.round(Number(digitado)) !== v) {
                render(); // redesenha o campo com o valor ajustado
                // o aviso vem depois do redesenho que o sincronizarSoon (120 ms) faz; antes disso a tela o apagaria
                setTimeout(() => toast('Ajustei para ' + v + ' tokens (o limite vai de ' + ESP_RESP_TOKENS.min + ' a ' + ESP_RESP_TOKENS.max + ').'), 300);
                return;
            }
            toast('Salvo.');
            if (/^(dossie|hibrido|nucleo)/.test(k)) render();
        }
        function ligarUI() {
            const r = UI.raiz;
            let tBusca;
            r.addEventListener('click', (e) => {
                const el = e.target.closest('[data-a]');
                if (!el || el.tagName === 'SELECT') return;
                const f = ACOES[el.dataset.a];
                if (f)
                    Promise.resolve()
                        .then(() => f(el, e))
                        .catch(falhou);
            });
            r.addEventListener('input', (e) => {
                const t = e.target;
                const c = t.dataset && t.dataset.campo;
                if (!c) return;
                UI.rasc[c] = t.value;
                if (c === 'composer') autoAltura();
                if (c === 'busca' || c === 'buscaConv') {
                    UI[c] = t.value;
                    clearTimeout(tBusca);
                    tBusca = setTimeout(render, 160);
                }
            });
            r.addEventListener('change', async (e) => {
                const t = e.target;
                try {
                    if (t.dataset.cfg) return salvarCfg(t);
                    if (t.dataset.a === 'sel' || t.dataset.a === 'voz' || t.dataset.a === 'dos-chat') return ACOES[t.dataset.a](t, e);
                    if (t.id === 'spd-file-dos') {
                        await dossieImportar(Array.from(t.files));
                        t.value = '';
                        return;
                    }
                    if (t.id === 'spd-file') {
                        for (const f of t.files) {
                            try {
                                UI.anexos.push({ nome: f.name, texto: await lerArquivoTexto(f) });
                            } catch (er) {
                                falhou(er);
                            }
                        }
                        t.value = '';
                        render();
                    }
                    if (t.id === 'spd-file-bib') {
                        await bibCarregar();
                        const pasta = Bib.indice.pastas.find((p) => p.id === UI.pastaSel) || Bib.indice.pastas[0];
                        let n = 0;
                        for (const f of t.files) {
                            try {
                                await criarArquivo({
                                    nome: f.name,
                                    texto: await lerArquivoTexto(f),
                                    pastaId: pasta.id,
                                });
                                n++;
                            } catch (er) {
                                falhou(er);
                            }
                        }
                        t.value = '';
                        if (n) toast(n + ' arquivo(s) adicionados em “' + pasta.nome + '”. Abra e mande analisar.');
                        render();
                    }
                } catch (er) {
                    falhou(er);
                }
            });
            r.addEventListener('keydown', (e) => {
                const t = e.target;
                if (
                    t.dataset &&
                    t.dataset.campo === 'composer' &&
                    e.key === 'Enter' &&
                    !e.shiftKey &&
                    !(ctx().isMobile && ctx().isMobile())
                ) {
                    e.preventDefault();
                    ACOES.enviar();
                }
                if (e.key === 'Escape' && !r.querySelector('.spd-modal')) fechar();
                e.stopPropagation();
            });
        }

        // ============================================================
        // 14 INÍCIO
        // ============================================================
        function criarRaiz() {
            if (document.getElementById('spd-root')) return;
            UI.raiz = document.createElement('div');
            UI.raiz.id = 'spd-root';
            document.body.appendChild(UI.raiz);
            UI.fab = document.createElement('button');
            UI.fab.id = 'spd-fab';
            UI.fab.title = 'Spade';
            UI.fab.textContent = '♠';
            UI.fab.addEventListener('click', () =>
                UI.aberto ? fechar() : abrir(UI.tela === 'arquivo' && !UI.arqId ? 'espaco' : UI.tela)
            );
            document.body.appendChild(UI.fab);
            ligarUI();
        }
        async function iniciar() {
            criarRaiz();
            ligarEventos();
            rtIniciar();
            await checarPlugin();
            try {
                const d = await chamarFs('/saude', null, 'GET');
                Plug.pasta = d.pastaDados;
            } catch (_) {
                /* sem plugin: a faixa avisa */
            }
            await sincronizar();
            atualizarFab();
            console.log(
                '[Spade] v' +
                    VERSAO +
                    ' pronto · plugin: ' +
                    (Plug.ok ? 'ok' : 'FORA') +
                    ' · slots: ' +
                    Object.keys(Diag.slotsAplicados).length
            );
        }
        // ============================================================
        // 15 TEMPO REAL (8.6.0) — a personagem "acompanha" o que o autor escreve e pode cortar a fala dele no envio.
        // Quem GERA a fala continua sendo o SillyTavern; aqui só se decide SE e ONDE a mensagem do autor é cortada,
        // e o que a IA da Spade "já entendeu" (bloco AGORA, volátil, no fim: nunca nos blocos 1–5).
        // Exceção consciente à 12.4 ("IA só por evento, sem timer"): ler o campo enquanto o autor digita pede timer/debounce.
        // Só roda com rtLigado, chat de UM personagem, rascunho em uso e dentro dos tetos (rtMaxConsultas).
        // Falhou = comportamento normal: a mensagem vai inteira. Nunca se perde texto do autor.
        // ============================================================
        // >>TEMPO-REAL-PURO (sem DOM, sem SillyTavern, sem relógio: tudo entra por argumento; testado por testes/teste_tempo_real.js)
        const RT_ASPAS = { '"': '"', '“': '”', '«': '»' };
        const RT_TIPOS = ['gesto', 'pensamento', 'narracao', 'incerto'];
        const RT_GRAVIDADES = ['nenhuma', 'leve', 'grave'];
        const RT_MIN_CHARS = 8;
        // Quebra o rascunho em UNIDADES: uma palavra (fora de asteriscos) ou um bloco inteiro `*...*` (atômico, T6).
        // Uma corrida de `*` abre ou fecha (`**negrito**` também é bloco, como no leitor do relógio). Asterisco dentro de
        // aspas (fala citada) é texto comum (T9). Bloco sem fechamento vira UMA unidade `fechado: false` até o fim do texto.
        function rtUnidades(texto) {
            const t = String(texto == null ? '' : texto);
            const n = t.length;
            const un = [];
            let palIni = -1;
            let ate = -1; // posição do fecho da fala citada em curso (-1 = fora de aspas)
            const fechaPalavra = (fim) => {
                if (palIni >= 0) {
                    un.push({ k: 'p', ini: palIni, fim, t: t.slice(palIni, fim) });
                    palIni = -1;
                }
            };
            let i = 0;
            while (i < n) {
                const ch = t[i];
                if (i > ate) ate = -1;
                if (ate < 0 && RT_ASPAS[ch]) {
                    const f = t.indexOf(RT_ASPAS[ch], i + 1);
                    if (f > i) ate = f;
                }
                if (ate < 0 && ch === '*') {
                    fechaPalavra(i);
                    let j = i;
                    while (j < n && t[j] === '*') j++;
                    const k = t.indexOf('*', j);
                    if (k < 0) {
                        un.push({ k: 'b', ini: i, fim: n, t: t.slice(i), fechado: false });
                        return un;
                    }
                    let m = k;
                    while (m < n && t[m] === '*') m++;
                    un.push({ k: 'b', ini: i, fim: m, t: t.slice(i, m), fechado: true });
                    i = m;
                    continue;
                }
                if (/\s/.test(ch)) fechaPalavra(i);
                else if (palIni < 0) palIni = i;
                i++;
            }
            fechaPalavra(n);
            return un;
        }
        const rtMiolo = (u) => u.t.replace(/^\*+|\*+$/g, '').trim();
        const rtChaveBloco = (u) => u.ini + '|' + rtMiolo(u); // quando o bloco ficou fechado (espera do asterisco)
        const rtChaveTipo = (u) => rtMiolo(u).toLowerCase().slice(0, 200); // classificação do bloco, por texto (não reclassifica)
        const rtVisto = (un, n) => un.slice(0, n).map((u) => u.k + ':' + u.t);
        const rtLimpaLinha = (s, max) =>
            String(s == null ? '' : s)
                .replace(/\s+/g, ' ')
                .replace(/\[\[|\]\]/g, '')
                .replace(/^#+\s*/, '')
                .trim()
                .slice(0, max);
        // Palavra completa: tem algo depois dela (espaço ou bloco) ou termina em pontuação (T3).
        const rtPalavraCompleta = (texto, u) => u.fim < texto.length || /[.,;:!?…)\]"”»]$/.test(u.t);
        // Até onde o cursor de leitura PODE ir agora (nunca no meio de palavra, nunca em bloco aberto ou recém-fechado).
        // o.fechadoEm(u) devolve quando o bloco ficou fechado (ms) ou null.
        function rtLimite(texto, o = {}) {
            const t = String(texto == null ? '' : texto);
            const un = rtUnidades(t);
            const agora = o.agora == null ? Date.now() : o.agora;
            const espera = o.esperaAsteriscoMs == null ? 1400 : o.esperaAsteriscoMs;
            const pausaPalavra = o.pausaFechaPalavraMs == null ? 700 : o.pausaFechaPalavraMs;
            let limite = un.length;
            let parou = null;
            for (let i = 0; i < un.length; i++) {
                const u = un[i];
                if (u.k !== 'b') continue;
                if (!u.fechado) {
                    limite = i;
                    parou = 'bloco-aberto';
                    break;
                }
                const em = o.fechadoEm ? o.fechadoEm(u) : null;
                if (em == null || agora - em < espera) {
                    limite = i;
                    parou = 'bloco-recente';
                    break;
                }
            }
            if (limite === un.length && un.length) {
                const u = un[un.length - 1];
                if (u.k === 'p' && !rtPalavraCompleta(t, u) && agora - (o.ultimaDigitacaoEm || 0) < pausaPalavra) {
                    limite = un.length - 1;
                    parou = 'palavra-incompleta';
                }
            }
            return { unidades: un, limite, parou };
        }
        function rtPrefixoComum(a, b) {
            const x = String(a == null ? '' : a);
            const y = String(b == null ? '' : b);
            const m = Math.min(x.length, y.length);
            let i = 0;
            while (i < m && x[i] === y[i]) i++;
            return i;
        }
        const rtUnidadesAte = (texto, chars) => rtUnidades(texto).filter((u) => u.fim <= chars).length;
        // T4: apagou ou editou para trás → o cursor recua para o fim do maior prefixo em comum.
        const rtRecuarCursor = (cursor, antigo, novo) =>
            Math.min(cursor, rtUnidadesAte(novo, rtPrefixoComum(antigo, novo)));
        // T2: anda em palavras/s, nunca passa do limite (= do que foi digitado e já pode ser lido).
        const rtAvancarCursor = (cursor, dtMs, porSeg, limite) =>
            Math.min(limite, cursor + (Math.max(0, dtMs) * Math.max(0, porSeg)) / 1000);
        // Uma decisão sobrevive à edição? Corte: o texto até ele não mudou. Esperar: tudo o que foi lido continua igual.
        function rtDecisaoSobrevive(d, prefixoChars) {
            if (!d) return false;
            return d.acao === 'interromper' ? d.corteChars <= prefixoChars : d.lidoChars <= prefixoChars;
        }
        // Entrada do decisor (compacta, ~700–1200 tokens). p = { descricao, falas: [{ nome, texto }], unidades (as LIDAS), agressividade }
        function rtMontarDecisor(p) {
            const lidas = p.unidades || [];
            const numerado = lidas.map((u, i) => '[' + (i + 1) + '] ' + u.t + (u.k === 'b' ? ' (bloco fechado)' : '')).join(' ');
            const falas = (p.falas || [])
                .slice(-4)
                .map((f) => '- ' + (f.nome || '?') + ': ' + String(f.texto || '').slice(0, 300))
                .join('\n');
            const sistema =
                'Você decide se a personagem interrompe o autor AGORA, enquanto ele ainda escreve. Na dúvida, esperar. ' +
                'Interrompa só se faria sentido para ESTA personagem (personalidade, relação, o que está em jogo).\n' +
                'O autor escreve em unidades numeradas: palavras e blocos entre asteriscos.\n' +
                'Pensamento (reflexão, pergunta interna, "penso…") NÃO é percebido pela personagem e NÃO justifica interromper. ' +
                'Gesto (ação física em 1ª pessoa no presente, como "Bato nela") é percebido. ' +
                'Narração (descrição de cena, passagem de tempo) também não é uma ação dirigida a ela. Se não souber qual é, use "incerto".\n' +
                '"depois_de" = quantas unidades FICAM (as demais não foram ditas). "letras" = quantas letras da próxima palavra foram ' +
                'ditas antes do corte (0 = corte entre palavras; use só se a personagem cortou brusca no meio da palavra).\n' +
                'Agressividade baixa: só gesto grave, provocação direta ou algo que a personagem não aguentaria ouvir. ' +
                'media: também discordância forte ou urgência. alta: também intromissões comuns de conversa.\n' +
                'Responda SÓ com JSON puro, sem texto fora dele, neste formato:\n' +
                '{"blocos":[{"u":2,"tipo":"gesto|pensamento|narracao|incerto","gravidade":"nenhuma|leve|grave"}],' +
                '"acao":"esperar|interromper","depois_de":5,"letras":0,"motivo":"até 12 palavras",' +
                '"leitura":"até 25 palavras: o que a personagem entendeu até aqui"}';
            const usuario =
                'Personagem (resumo):\n' +
                (String(p.descricao || '').trim().slice(0, 900) || '(sem descrição)') +
                '\n\nÚltimas falas:\n' +
                (falas || '(nenhuma)') +
                '\n\nO que o autor já escreveu:\n' +
                numerado +
                '\n\nAgressividade: ' +
                (p.agressividade || 'baixa') +
                '.';
            return [
                { role: 'system', content: sistema },
                { role: 'user', content: usuario },
            ];
        }
        // A IA propõe; o CÓDIGO confere (6.4). c = { unidades (as LIDAS), tipos (classificações já conhecidas), freio, tipoGeracao }
        // Qualquer coisa fora do combinado = rejeitada (= esperar). Devolve também os tipos dos blocos, que valem mesmo se a ação cair.
        function rtValidarDecisao(raw, c = {}) {
            let o = raw;
            if (typeof raw === 'string') {
                const m = raw.match(/\{[\s\S]*\}/);
                try {
                    o = m ? JSON.parse(m[0]) : null;
                } catch (_) {
                    o = null;
                }
            }
            if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, motivo: 'JSON inválido', tipos: {} };
            const un = c.unidades || [];
            const n = un.length;
            const novos = {};
            (Array.isArray(o.blocos) ? o.blocos : []).forEach((b) => {
                const u = Number(b && b.u);
                if (!Number.isInteger(u) || u < 1 || u > n || un[u - 1].k !== 'b') return;
                novos[rtChaveTipo(un[u - 1])] = {
                    tipo: RT_TIPOS.includes(b.tipo) ? b.tipo : 'incerto',
                    gravidade: RT_GRAVIDADES.includes(b.gravidade) ? b.gravidade : 'nenhuma',
                };
            });
            const tipos = Object.assign({}, novos, c.tipos || {}); // o que já estava classificado não é reclassificado
            const rej = (motivo) => ({ ok: false, motivo, tipos });
            if (o.acao === 'esperar')
                return { ok: true, acao: 'esperar', tipos, motivo: rtLimpaLinha(o.motivo, 120), leitura: rtLimpaLinha(o.leitura, 200) };
            if (o.acao !== 'interromper') return rej('ação desconhecida');
            if (c.freio) return rej('freio ativo');
            if (c.tipoGeracao && c.tipoGeracao !== 'normal') return rej('geração ' + c.tipoGeracao + ' nunca interrompe');
            if (un.some((u) => u.k === 'b' && !u.fechado)) return rej('bloco ainda aberto');
            const depoisDe = Number(o.depois_de);
            if (!Number.isInteger(depoisDe) || depoisDe < 1 || depoisDe > n) return rej('depois_de fora do que foi lido');
            const letras = o.letras == null || o.letras === '' ? 0 : Number(o.letras);
            if (!Number.isInteger(letras) || letras < 0) return rej('letras inválido');
            if (letras > 0) {
                const prox = un[depoisDe]; // a próxima unidade (precisa ter sido lida)
                if (!prox || prox.k !== 'p') return rej('letras só vale no meio de uma palavra comum');
                if (letras >= prox.t.length) return rej('letras passa do tamanho da palavra');
                const cod = prox.t.charCodeAt(letras);
                if (cod >= 0xdc00 && cod <= 0xdfff) return rej('corte no meio de um caractere');
            }
            const ultima = un[depoisDe - 1];
            if (ultima.k === 'b') {
                if (!ultima.fechado) return rej('corte dentro de bloco aberto');
                const info = tipos[rtChaveTipo(ultima)] || { tipo: 'incerto' };
                if (info.tipo !== 'gesto') return rej('corte logo depois de ' + info.tipo + ' (não é um gesto)');
            }
            return {
                ok: true,
                acao: 'interromper',
                tipos,
                depoisDe,
                letras,
                nLidas: n,
                motivo: rtLimpaLinha(o.motivo, 120),
                leitura: rtLimpaLinha(o.leitura, 200),
                corteChars: letras > 0 ? un[depoisDe].ini + letras : ultima.fim,
            };
        }
        // No envio (7.1): decide SE corta e O QUÊ vai pro chat. e = { corte, ultima, freioRestantes, freioMensagens, tipoGeracao, em }
        // `corte` e `ultima` são decisões já validadas, com `visto` (as unidades lidas) pra conferir com o texto FINAL (T13).
        // `leitura` só vai se TODO o lido continua igual e, havendo corte, se o corte não deixou nada do lido de fora
        // (senão a "leitura" contaria o que a personagem não ouviu).
        function rtPlanejarEnvio(texto, e = {}) {
            const t = String(texto == null ? '' : texto);
            const freio = Math.max(0, e.freioRestantes | 0);
            const saida = { cortar: null, leitura: '', freioDepois: freio > 0 ? freio - 1 : 0, motivoNaoCortou: '' };
            if (!t.trim()) return saida;
            if (e.tipoGeracao && e.tipoGeracao !== 'normal') {
                saida.motivoNaoCortou = 'geração ' + e.tipoGeracao;
                return saida;
            }
            const un = rtUnidades(t);
            const casa = (d, n) =>
                !!d &&
                Array.isArray(d.visto) &&
                n >= 1 &&
                n <= d.visto.length &&
                n <= un.length &&
                d.visto.slice(0, n).every((v, i) => v === un[i].k + ':' + un[i].t);
            const d = e.corte;
            if (freio > 0) saida.motivoNaoCortou = 'freio de realismo';
            else if (d && d.acao === 'interromper') {
                const preciso = d.depoisDe + (d.letras > 0 ? 1 : 0);
                if (!casa(d, preciso)) saida.motivoNaoCortou = 'o texto mudou antes do corte';
                else {
                    const ultima = un[d.depoisDe - 1];
                    const corteChars = d.letras > 0 ? un[d.depoisDe].ini + d.letras : ultima.fim;
                    if (corteChars >= t.replace(/\s+$/, '').length) saida.motivoNaoCortou = 'nada escrito depois do corte';
                    else {
                        const meio = d.letras > 0;
                        const naoDito = t.slice(corteChars).replace(/^\s+/, '');
                        const leitura = !meio && d.depoisDe === d.nLidas && casa(d, d.nLidas) ? d.leitura || '' : '';
                        saida.cortar = {
                            mes: t.slice(0, corteChars).replace(/\s+$/, '') + (meio ? '-' : ' —'),
                            original: t,
                            naoDito,
                            extra: {
                                cortado: true,
                                original: t,
                                naoDito,
                                motivo: d.motivo || '',
                                leitura,
                                em: e.em || new Date().toISOString(),
                            },
                        };
                        saida.leitura = leitura;
                        saida.freioDepois = Math.max(0, e.freioMensagens == null ? 2 : e.freioMensagens | 0);
                        return saida;
                    }
                }
            }
            const u = e.ultima;
            if (u && u.leitura && casa(u, u.visto.length)) saida.leitura = u.leitura;
            return saida;
        }
        function rtUltimaMensagemUsuario(chat) {
            const arr = Array.isArray(chat) ? chat : [];
            for (let i = arr.length - 1; i >= 0; i--) if (arr[i] && arr[i].is_user && !arr[i].is_system) return arr[i];
            return null;
        }
        // 7.5 — deriva da ÚLTIMA mensagem do autor (não de variável): sobrevive a swipe/reload e some com a próxima mensagem.
        function rtTextoInterrupcao(m) {
            const r = m && m.extra && m.extra.spade_rt;
            if (!r || !r.cortado) return '';
            const palavras = String(m.mes || '')
                .trim()
                .split(/\s+/)
                .filter(Boolean);
            if (!palavras.length) return '';
            const trecho = '«' + (palavras.length > 8 ? '…' : '') + palavras.slice(-8).join(' ') + '»';
            const motivo = rtLimpaLinha(r.motivo, 120);
            return (
                '### Interrupção\nVocê cortou a fala do autor no meio: ' +
                trecho +
                '.\nComece sua resposta interrompendo ali (ex.: "Espera," / "Para."), reagindo ao que ele disse até aí. ' +
                'Você NÃO ouviu o resto.' +
                (motivo ? '\nMotivo: ' + motivo + '.' : '')
            );
        }
        function rtTextoLeitura(m) {
            const r = m && m.extra && m.extra.spade_rt;
            const l = r ? rtLimpaLinha(r.leitura, 200) : '';
            return l ? '### Pensamento adiantado\n' + l : '';
        }
        // 7.4 — quando cada unidade aparece na reprodução (só visual). itens: [{ t, bloco }]. Teto de tempo total.
        function rtPlanoReproducao(itens, porSeg, tetoMs) {
            const base = 1000 / Math.max(0.5, porSeg || 5.5);
            let acc = 0;
            const tempos = [];
            (itens || []).forEach((it) => {
                tempos.push(acc);
                let d = base;
                if (it.bloco) d += 250;
                else if (/[.!?…]$/.test(it.t)) d += 320;
                else if (/[,;:]$/.test(it.t)) d += 180;
                acc += d;
            });
            const escala = acc > (tetoMs || 6000) ? (tetoMs || 6000) / acc : 1;
            return { tempos: tempos.map((x) => Math.round(x * escala)), total: Math.round(acc * escala), escala };
        }
        // <<TEMPO-REAL-PURO

        // ---- estado (só na memória; do disco/localStorage vai apenas o freio de realismo, por chat) ----
        const RT_FREIO_KEY = 'spade_rt_v86';
        const RT_DECIMAIS = ['rtLeituraPalavrasPorSeg', 'rtReproducaoPalavrasPorSeg'];
        const RT_LIMITES = {
            rtEsperaAsteriscoMs: [200, 5000],
            rtPausaFechaPalavraMs: [200, 3000],
            rtMaxConsultas: [1, 20],
            rtFreioMensagens: [0, 10],
            fichasMaxPorResposta: [1, 10], // 8.7.0
            fichasMaxPastasAuto: [1, 30],
            fichasMaxArquivosAuto: [1, 200],
            espacoMaxTokensResposta: [ESP_RESP_TOKENS.min, ESP_RESP_TOKENS.max], // 8.9.2
        };
        const RT = {
            texto: '', // rascunho como o campo está agora
            ultimaDigitacao: 0,
            cursor: 0, // unidades lidas (fracionário; vale o piso)
            tickEm: 0,
            timer: null,
            fechadoEm: new Map(), // bloco → quando ficou fechado
            tipos: {}, // classificação dos blocos (por texto), vale na sessão
            corte: null, // decisão "interromper" válida
            ultima: null, // última decisão válida (pode ter "leitura")
            consulta: null, // { ctrl, base, n, lidoChars } em andamento
            consultasNaMsg: 0,
            ultimaConsultaN: 0,
            arquivo: null, // o rascunho que o ST acabou de esvaziar no envio (guardado por segundos)
            pendentes: new Set(), // mensagens recém-enviadas que ainda vão ser reproduzidas
            repro: null,
            semKeyAvisado: false,
            falhaAvisoEm: 0,
        };
        Diag.rt = { consultas: 0, falhas: 0, ultimaFalha: '', ultimaFalhaEm: 0, decisoes: [], cortes: 0, ultimoEnvio: null };
        function rtCfg() {
            const c = getConfig();
            const num = (v, d, min, max) => {
                const x = Number(v);
                return Number.isFinite(x) && x >= min && x <= max ? x : d;
            };
            return {
                ligado: !!c.rtLigado,
                agressividade: ['baixa', 'media', 'alta'].includes(c.rtAgressividade) ? c.rtAgressividade : 'baixa',
                palavrasPorSeg: num(c.rtLeituraPalavrasPorSeg, 2.5, 0.5, 20),
                esperaAsteriscoMs: num(c.rtEsperaAsteriscoMs, 1400, 200, 5000),
                pausaFechaPalavraMs: num(c.rtPausaFechaPalavraMs, 700, 200, 3000),
                reproducaoPorSeg: num(c.rtReproducaoPalavrasPorSeg, 5.5, 0.5, 20),
                maxConsultas: Math.round(num(c.rtMaxConsultas, 6, 1, 20)),
                freioMensagens: Math.round(num(c.rtFreioMensagens, 2, 0, 10)),
                geracaoJunto: c.rtGeracaoJunto !== false,
                indicador: !!c.rtIndicadorLeitura,
            };
        }
        // T1: só chat de UM personagem (grupo: desligado nesta versão).
        function rtChatOk() {
            const c = ctx();
            if (c.groupId) return false;
            return c.characterId != null;
        }
        function rtFreioLer() {
            try {
                const o = JSON.parse(localStorage.getItem(RT_FREIO_KEY) || '{}');
                return Math.max(0, (o.freio && o.freio[chatIdParaDisco()]) | 0);
            } catch (_) {
                return 0;
            }
        }
        function rtFreioGravar(n) {
            try {
                let o = {};
                try {
                    o = JSON.parse(localStorage.getItem(RT_FREIO_KEY) || '{}') || {};
                } catch (_) {
                    o = {};
                }
                o.freio = o.freio || {};
                const k = chatIdParaDisco();
                if (n > 0) o.freio[k] = n;
                else delete o.freio[k];
                const ks = Object.keys(o.freio);
                if (ks.length > 60) ks.slice(0, ks.length - 60).forEach((x) => delete o.freio[x]);
                localStorage.setItem(RT_FREIO_KEY, JSON.stringify(o));
            } catch (_) {
                /* sem espaço: perde só o freio */
            }
        }
        function rtCancelarConsulta() {
            if (!RT.consulta) return;
            try {
                RT.consulta.ctrl.abort();
            } catch (_) {
                /* já tinha acabado */
            }
            RT.consulta = null;
        }
        function rtIndicador(ligado, campo) {
            let d = document.getElementById('spd-rt-dot');
            if (!ligado) {
                if (d) d.style.display = 'none';
                return;
            }
            const alvo = campo || document.getElementById('send_textarea');
            if (!alvo) return;
            if (!d) {
                d = document.createElement('div');
                d.id = 'spd-rt-dot';
                document.body.appendChild(d);
            }
            const b = alvo.getBoundingClientRect();
            d.style.left = Math.round(b.right - 14) + 'px';
            d.style.top = Math.round(b.top + 8) + 'px';
            d.style.display = 'block';
        }
        function rtPararTimer() {
            if (RT.timer) {
                clearInterval(RT.timer);
                RT.timer = null;
            }
            RT.tickEm = 0;
            rtIndicador(false);
        }
        function rtLimparRascunho() {
            rtCancelarConsulta();
            rtPararTimer();
            RT.texto = '';
            RT.cursor = 0;
            RT.corte = null;
            RT.ultima = null;
            RT.consultasNaMsg = 0;
            RT.ultimaConsultaN = 0;
            RT.fechadoEm.clear();
            if (Object.keys(RT.tipos).length > 300) RT.tipos = {};
        }
        function rtFalha(msg) {
            Diag.rt.falhas++;
            Diag.rt.ultimaFalha = String(msg || '').slice(0, 160);
            Diag.rt.ultimaFalhaEm = Date.now();
            if (Date.now() - RT.falhaAvisoEm > 60000) {
                RT.falhaAvisoEm = Date.now();
                toast('Tempo real: a IA não respondeu (' + Diag.rt.ultimaFalha.slice(0, 80) + '). Sigo sem ela.', true);
            }
        }
        function rtRegistrar(reg) {
            Diag.rt.decisoes.unshift(Object.assign({ em: Date.now() }, reg));
            Diag.rt.decisoes.length = Math.min(Diag.rt.decisoes.length, 20);
        }
        // O campo mudou (evento `input` do #send_textarea).
        function rtOnInput(campo) {
            const cfg = rtCfg();
            const texto = String(campo.value || '');
            if (!cfg.ligado || !rtChatOk()) {
                rtLimparRascunho();
                RT.arquivo = null;
                return;
            }
            if (!texto.trim() || /^\s*\//.test(texto)) {
                // O ST esvazia o campo no envio ANTES do MESSAGE_SENT: guarda o que havia (decisões) por alguns segundos.
                // T5 zera tudo, mas sem perder o envio.
                if (RT.texto.trim()) RT.arquivo = { em: Date.now(), corte: RT.corte, ultima: RT.ultima };
                else if (RT.arquivo && Date.now() - RT.arquivo.em >= 4000) RT.arquivo = null;
                rtLimparRascunho();
                return;
            }
            if (texto === RT.texto) return;
            const antigo = RT.texto;
            const agora = Date.now();
            RT.arquivo = null;
            RT.texto = texto;
            RT.ultimaDigitacao = agora;
            const un = rtUnidades(texto);
            const vivos = new Set();
            un.forEach((u) => {
                if (u.k !== 'b' || !u.fechado) return;
                const k = rtChaveBloco(u);
                vivos.add(k);
                if (!RT.fechadoEm.has(k)) RT.fechadoEm.set(k, agora);
            });
            Array.from(RT.fechadoEm.keys()).forEach((k) => {
                if (!vivos.has(k)) RT.fechadoEm.delete(k);
            });
            // T4: editou para trás → recua o cursor e descarta o que ficou além do prefixo em comum
            const pref = rtPrefixoComum(antigo, texto);
            RT.cursor = rtRecuarCursor(RT.cursor, antigo, texto);
            if (RT.corte && !rtDecisaoSobrevive(RT.corte, pref)) RT.corte = null;
            if (RT.ultima && !rtDecisaoSobrevive(RT.ultima, pref)) RT.ultima = null;
            if (RT.consulta && RT.consulta.lidoChars > pref) rtCancelarConsulta();
            RT.ultimaConsultaN = Math.min(RT.ultimaConsultaN, Math.floor(RT.cursor));
            if (texto.trim().length >= RT_MIN_CHARS) {
                if (!RT.timer) RT.timer = setInterval(rtTick, 250);
            } else rtPararTimer();
        }
        function rtTick() {
            try {
                const cfg = rtCfg();
                const campo = document.getElementById('send_textarea');
                if (!cfg.ligado || !rtChatOk() || !campo || RT.texto.trim().length < RT_MIN_CHARS) return rtPararTimer();
                const agora = Date.now();
                if (agora - RT.ultimaDigitacao > 30000 && !RT.consulta) return rtPararTimer(); // ocioso: volta no próximo input
                const dt = RT.tickEm ? agora - RT.tickEm : 0;
                RT.tickEm = agora;
                const lim = rtLimite(RT.texto, {
                    agora,
                    ultimaDigitacaoEm: RT.ultimaDigitacao,
                    fechadoEm: (u) => RT.fechadoEm.get(rtChaveBloco(u)),
                    esperaAsteriscoMs: cfg.esperaAsteriscoMs,
                    pausaFechaPalavraMs: cfg.pausaFechaPalavraMs,
                });
                RT.cursor = rtAvancarCursor(Math.min(RT.cursor, lim.limite), dt, cfg.palavrasPorSeg, lim.limite);
                rtTalvezConsultar(cfg, lim, agora);
                rtIndicador(cfg.indicador, campo);
            } catch (e) {
                console.warn('[Spade] tempo real:', e.message);
            }
        }
        // 6.1 — só consulta se tudo estiver em ordem; uma consulta por vez; teto por mensagem.
        function rtTalvezConsultar(cfg, lim, agora) {
            if (RT.consulta || RT.corte) return; // já há decisão de cortar: não gasta mais
            if (RT.consultasNaMsg >= cfg.maxConsultas) return;
            if (rtFreioLer() > 0) return;
            const n = Math.floor(RT.cursor);
            if (n < 1) return;
            if (RT.cursor >= lim.limite && (lim.parou === 'bloco-aberto' || lim.parou === 'bloco-recente')) return;
            const novas = n - RT.ultimaConsultaN;
            const pausa = agora - RT.ultimaDigitacao >= 900;
            if (!(novas >= 3 || (pausa && novas >= 1))) return;
            if (!getConfig().apiKey) {
                if (!RT.semKeyAvisado) {
                    RT.semKeyAvisado = true;
                    toast('Tempo real sem API key: só a reprodução palavra por palavra funciona. Cole a key em Configurações.', true);
                }
                return;
            }
            rtConsultar(cfg, lim.unidades.slice(0, n), n).catch((e) => console.warn('[Spade] tempo real:', e.message));
        }
        function rtFalasRecentes() {
            return (ctx().chat || [])
                .filter((m) => m && !m.is_system && textoDaFala(m))
                .slice(-4)
                .map((m) => ({ nome: m.is_user ? 'Autor' : m.name || '?', texto: textoDaFala(m) }));
        }
        async function rtConsultar(cfg, lidas, n) {
            const ctrl = new AbortController();
            const consulta = { ctrl, base: RT.texto, n, lidoChars: lidas[n - 1].fim };
            RT.consulta = consulta;
            RT.consultasNaMsg++;
            RT.ultimaConsultaN = n;
            Diag.rt.consultas++;
            let bruto = null;
            let falha = '';
            try {
                bruto = await generate(
                    rtMontarDecisor({
                        descricao: blocoDescricao(),
                        falas: rtFalasRecentes(),
                        unidades: lidas,
                        agressividade: cfg.agressividade,
                    }),
                    { maxTokens: 200, temperature: 0.4, thinking: 'disabled', signal: ctrl.signal, timeoutMs: 8000, tentativas: 1 }
                );
            } catch (e) {
                falha = ctrl.signal.aborted ? '' : e.name === 'AbortError' ? 'tempo esgotado (8 s)' : e.message || String(e);
            }
            if (RT.consulta !== consulta) return; // cancelada (autor apagou, enviou ou limpou o campo) ou superada
            RT.consulta = null;
            const lido = lidas.map((u) => u.t).join(' ');
            if (falha) {
                rtRegistrar({ lido, acao: '—', rejeitada: 'falha: ' + falha });
                return rtFalha(falha);
            }
            const v = rtValidarDecisao(parseJsonObjetoSeguro(bruto), {
                unidades: lidas,
                tipos: RT.tipos,
                freio: rtFreioLer() > 0,
                tipoGeracao: 'normal',
            });
            Object.assign(RT.tipos, v.tipos || {});
            const tiposLidos = lidas
                .filter((u) => u.k === 'b' && (v.tipos || {})[rtChaveTipo(u)])
                .map((u) => rtMiolo(u) + ' → ' + v.tipos[rtChaveTipo(u)].tipo + '/' + v.tipos[rtChaveTipo(u)].gravidade);
            if (!v.ok) {
                rtRegistrar({ lido, tipos: tiposLidos, acao: 'esperar', rejeitada: v.motivo });
                return;
            }
            if (rtPrefixoComum(RT.texto, consulta.base) < consulta.lidoChars) {
                rtRegistrar({ lido, tipos: tiposLidos, acao: v.acao, rejeitada: 'o autor mexeu no que foi lido' });
                return;
            }
            const d = {
                acao: v.acao,
                depoisDe: v.depoisDe,
                letras: v.letras || 0,
                nLidas: n,
                motivo: v.motivo,
                leitura: v.leitura,
                corteChars: v.corteChars,
                lidoChars: consulta.lidoChars,
                visto: rtVisto(lidas, n),
            };
            if (v.acao === 'interromper') RT.corte = d;
            if (v.acao === 'interromper' || v.leitura) RT.ultima = d;
            rtRegistrar({
                lido,
                tipos: tiposLidos,
                acao: v.acao,
                corte: v.acao === 'interromper' ? 'depois de ' + v.depoisDe + ' unidade(s)' + (d.letras ? ' + ' + d.letras + ' letra(s)' : '') : '',
                motivo: v.motivo,
                leitura: v.leitura,
            });
        }
        // 7.1 — SÍNCRONO (o `on()` não espera promise e o ST monta o prompt logo depois): nada de await antes de trocar `mes`.
        // Falhou = a mensagem vai inteira, do jeito de sempre.
        function rtAplicarNoEnvio(id) {
            try {
                const cfg = rtCfg();
                if (!cfg.ligado || !rtChatOk()) {
                    rtLimparRascunho();
                    RT.arquivo = null;
                    return false;
                }
                let corte = RT.corte;
                let ultima = RT.ultima;
                let veioDoCampo = !!RT.texto.trim();
                if (!veioDoCampo && RT.arquivo && Date.now() - RT.arquivo.em < 4000) {
                    corte = RT.arquivo.corte;
                    ultima = RT.arquivo.ultima;
                    veioDoCampo = true;
                }
                rtLimparRascunho(); // T12: nada novo começa depois do envio; consulta em andamento é cancelada
                RT.arquivo = null;
                const m = (ctx().chat || [])[id];
                if (!veioDoCampo || !m || !m.is_user || m.is_system || !String(m.mes || '').trim()) return false;
                const plano = rtPlanejarEnvio(m.mes, {
                    corte,
                    ultima,
                    freioRestantes: rtFreioLer(),
                    freioMensagens: cfg.freioMensagens,
                    tipoGeracao: 'normal',
                });
                m.extra = m.extra && typeof m.extra === 'object' ? m.extra : {};
                const marca = { reproduzir: true };
                if (plano.cortar) {
                    m.mes = plano.cortar.mes;
                    m.extra.spade_rt = Object.assign(marca, plano.cortar.extra);
                    Diag.rt.cortes++;
                    atualizarCacheFalas();
                } else m.extra.spade_rt = plano.leitura ? Object.assign(marca, { leitura: plano.leitura }) : marca;
                rtFreioGravar(plano.freioDepois);
                RT.pendentes.add(id);
                Diag.rt.ultimoEnvio = { em: Date.now(), cortou: !!plano.cortar, motivo: plano.motivoNaoCortou };
                return !!plano.cortar;
            } catch (e) {
                console.warn('[Spade] tempo real (envio):', e.message);
                return false;
            }
        }
        // 7.4 — reprodução (só visual). Tudo que falhar aqui = mostra a mensagem normal e revela a bolha da IA.
        function rtFecharReproducao(imediato) {
            const rep = RT.repro;
            if (!rep || rep.feito) return;
            rep.feito = true;
            RT.repro = null;
            rep.timers.forEach(clearTimeout);
            try {
                if (rep.txt && rep.txt.isConnected !== false) rep.txt.innerHTML = rep.html; // restaura o HTML original
            } catch (_) {
                /* o ST redesenhou a mensagem: nada a restaurar */
            }
            const liberar = () => {
                try {
                    rep.mesEl.classList.remove('spd-rt-repro');
                    rtChipNaoDito(rep.mesEl, rep.r);
                } catch (_) {
                    /* sem DOM: tudo bem */
                }
                if (rep.fim) rep.fim();
            };
            if (!imediato && rep.r && rep.r.cortado) setTimeout(liberar, 350);
            else liberar();
        }
        function rtReproduzir(mesEl, txt, r, cfg) {
            rtFecharReproducao(true);
            const html = txt.innerHTML;
            const itens = [];
            const visita = (no) => {
                if (no.nodeType === 3) {
                    const partes = no.nodeValue.match(/\s*\S+\s*/g);
                    if (!partes) return;
                    const frag = document.createDocumentFragment();
                    partes.forEach((p) => {
                        const s = document.createElement('span');
                        s.className = 'spd-rt-w';
                        s.textContent = p;
                        s.style.opacity = '0'; // opacity (não display): a altura da mensagem não pula
                        frag.appendChild(s);
                        itens.push({ el: s, t: p.trim(), bloco: false });
                    });
                    no.parentNode.replaceChild(frag, no);
                } else if (no.nodeType === 1) {
                    if (/^(EM|I)$/.test(no.tagName)) {
                        no.style.opacity = '0'; // bloco de asterisco = uma unidade, aparece inteiro
                        itens.push({ el: no, t: no.textContent, bloco: true });
                        return;
                    }
                    Array.from(no.childNodes).forEach(visita);
                }
            };
            const rep = { mesEl, txt, html, r, timers: [], feito: false, fim: null, promessa: null };
            rep.promessa = new Promise((res) => (rep.fim = res));
            RT.repro = rep;
            mesEl.classList.add('spd-rt-repro'); // CSS: esconde as mensagens DEPOIS desta (a bolha da IA) até o fim
            Array.from(txt.childNodes).forEach(visita);
            const plano = rtPlanoReproducao(itens, cfg.reproducaoPorSeg, 6000);
            itens.forEach((it, i) => rep.timers.push(setTimeout(() => (it.el.style.opacity = ''), plano.tempos[i])));
            rep.timers.push(setTimeout(() => rtFecharReproducao(false), plano.total + 80));
            rep.timers.push(setTimeout(() => rtFecharReproducao(true), 9000)); // cinto e suspensório
        }
        // 7.6 — chip "não dito": Retomar ACRESCENTA ao campo (nunca apaga o que já está lá, nunca envia sozinho); Descartar remove.
        function rtChipNaoDito(mesEl, r) {
            if (!mesEl || !r || !r.cortado || !r.naoDito) return;
            Array.from(mesEl.querySelectorAll('.spd-rt-nd')).forEach((x) => x.remove());
            const chip = document.createElement('div');
            chip.className = 'spd-rt-nd';
            const rotulo = document.createElement('span');
            rotulo.textContent = 'Você ia dizer mais…';
            const bt = (txt, fn) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.textContent = txt;
                b.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    try {
                        fn();
                    } finally {
                        chip.remove();
                    }
                });
                return b;
            };
            chip.appendChild(rotulo);
            chip.appendChild(
                bt('Retomar', () => {
                    const campo = document.getElementById('send_textarea');
                    if (!campo) return;
                    const atual = String(campo.value || '');
                    campo.value = atual.trim() ? atual.replace(/\s+$/, '') + ' ' + r.naoDito : r.naoDito;
                    campo.dispatchEvent(new Event('input', { bubbles: true }));
                    if (typeof campo.focus === 'function') campo.focus();
                })
            );
            chip.appendChild(bt('Descartar', () => {}));
            (mesEl.querySelector('.mes_block') || mesEl).appendChild(chip);
        }
        // Plano B (5.2): se o ST desenhou a mensagem ANTES do corte, redesenha com o texto cortado.
        function rtGarantirTextoCortado(id, m, txt) {
            try {
                const r = m.extra.spade_rt;
                if (!r.cortado || !r.naoDito || typeof ctx().updateMessageBlock !== 'function') return;
                const limpa = (s) => String(s || '').replace(/[\s*]+/g, '');
                const cauda = limpa(r.naoDito).slice(-24);
                if (cauda && limpa(txt.textContent).includes(cauda)) ctx().updateMessageBlock(id, m);
            } catch (e) {
                console.warn('[Spade] tempo real (redesenho):', e.message);
            }
        }
        function rtAoRenderizar(id) {
            let mesEl = null;
            try {
                const m = (ctx().chat || [])[id];
                if (!m || !m.is_user || !RT.pendentes.has(id)) return;
                RT.pendentes.delete(id);
                const r = m.extra && m.extra.spade_rt;
                const cfg = rtCfg();
                if (!r || !cfg.ligado) return;
                mesEl = document.querySelector('#chat .mes[mesid="' + id + '"]');
                const txt = mesEl && mesEl.querySelector('.mes_text');
                if (!txt) {
                    if (mesEl) rtChipNaoDito(mesEl, r);
                    return;
                }
                rtGarantirTextoCortado(id, m, txt);
                rtReproduzir(mesEl, txt, r, cfg);
            } catch (e) {
                console.warn('[Spade] tempo real (reprodução):', e.message);
                rtFecharReproducao(true);
                try {
                    if (mesEl) mesEl.classList.remove('spd-rt-repro');
                } catch (_) {
                    /* sem DOM */
                }
            }
        }
        // 7.4 — com `rtGeracaoJunto` desligado, a geração do ST só começa ao fim da reprodução (o interceptor espera).
        async function rtAguardarReproducao(type) {
            try {
                if (type && type !== 'normal') return;
                const rep = RT.repro;
                if (!rep || rtCfg().geracaoJunto) return;
                await Promise.race([rep.promessa, sleep(8000)]);
            } catch (_) {
                /* seguir sem esperar */
            }
        }
        // Textos do bloco AGORA (8): só com a feature ligada; derivam da última mensagem do autor.
        function rtTextosAgora() {
            try {
                if (!rtCfg().ligado) return [];
                const m = rtUltimaMensagemUsuario(ctx().chat);
                if (!m) return [];
                return [rtTextoInterrupcao(m), rtTextoLeitura(m)].filter(Boolean);
            } catch (_) {
                return [];
            }
        }
        function rtAoMudarLigado() {
            if (rtCfg().ligado) return;
            rtLimparRascunho();
            RT.arquivo = null;
            rtFecharReproducao(true);
        }
        function rtAoTrocarChat() {
            rtLimparRascunho();
            RT.arquivo = null;
            RT.pendentes.clear();
            rtFecharReproducao(true);
        }
        function rtObservarChat(tentativa = 0) {
            const chat = document.getElementById('chat');
            if (!chat) {
                if (tentativa < 5) setTimeout(() => rtObservarChat(tentativa + 1), 2000);
                return;
            }
            new MutationObserver((muts) => {
                muts.forEach((mu) =>
                    Array.from(mu.addedNodes).forEach((n) => {
                        if (n.nodeType === 1 && n.matches && n.matches('.mes[is_user="true"]'))
                            rtAoRenderizar(Number(n.getAttribute('mesid')));
                    })
                );
            }).observe(chat, { childList: true });
        }
        function rtIniciar() {
            document.addEventListener(
                'input',
                (e) => {
                    const t = e.target;
                    if (t && t.id === 'send_textarea')
                        try {
                            rtOnInput(t);
                        } catch (er) {
                            console.warn('[Spade] tempo real:', er.message);
                        }
                },
                true
            );
            if (!(event_types && event_types.USER_MESSAGE_RENDERED)) rtObservarChat(); // 5.2: plano B sem o evento
        }
        // ---- interface: cartão da tela Início e painel em Configurações ----
        function rtCardHtml() {
            const lig = rtCfg().ligado;
            return (
                '<div class="spd-rel"><div class="spd-rel-topo"><div><small>Conversa em tempo real</small><b>' +
                (lig ? 'ligada' : 'desligada') +
                '</b></div><div class="spd-rel-bt"><button class="spd-btn ' +
                (lig ? '' : 'prim') +
                '" data-a="rt-toggle">' +
                (lig ? 'Desligar' : 'Ligar') +
                '</button></div></div><div class="sub" style="margin-top:10px">A personagem acompanha o que você escreve e pode cortar a sua fala no envio. Gasta tokens e só vale em chat de um personagem. Ajustes em Configurações → Tempo real.</div></div>'
            );
        }
        function rtPainelHtml() {
            const d = Diag.rt;
            const faltam = Diag.eventosFaltando.filter((x) => x === 'MESSAGE_SENT' || x === 'USER_MESSAGE_RENDERED');
            const linhas = d.decisoes
                .map(
                    (x) =>
                        '<details class="spd-bloco"><summary><span style="color:#8f929a;font:12px ui-monospace,monospace">' +
                        esc(x.acao) +
                        '</span><span>' +
                        esc(String(x.lido || '').slice(0, 60)) +
                        '</span><span class="tk">' +
                        esc(fmtRel(x.em)) +
                        '</span></summary><pre>' +
                        esc(
                            'lido: ' +
                                (x.lido || '') +
                                '\nblocos: ' +
                                ((x.tipos || []).join(' · ') || '—') +
                                '\ncorte: ' +
                                (x.corte || '—') +
                                '\nmotivo: ' +
                                (x.motivo || '—') +
                                '\nleitura: ' +
                                (x.leitura || '—') +
                                (x.rejeitada ? '\nrejeitada: ' + x.rejeitada : '')
                        ) +
                        '</pre></details>'
                )
                .join('');
            const ult = d.ultimoEnvio;
            return (
                '<h3>Tempo real</h3><div class="spd-aviso">A personagem “lê” o campo de texto enquanto você escreve (mais devagar do que você digita) e pode cortar a sua fala no envio. A IA só decide SE e ONDE; quem escreve a fala dela continua sendo o SillyTavern. Começa desligado: gasta tokens (até ' +
                rtCfg().maxConsultas +
                ' chamadas por mensagem).</div><div class="spd-grid2">' +
                campoCfg('rtLigado', 'Tempo real ligado', 'sw') +
                campoCfg('rtAgressividade', 'Agressividade', 'select', [
                    ['baixa', 'baixa (só gesto grave ou provocação direta)'],
                    ['media', 'média (também discordância forte)'],
                    ['alta', 'alta (também intromissões comuns)'],
                ]) +
                campoCfg('rtLeituraPalavrasPorSeg', 'Velocidade da leitura (palavras/s)', 'number') +
                campoCfg('rtReproducaoPalavrasPorSeg', 'Velocidade da reprodução (palavras/s)', 'number') +
                campoCfg('rtEsperaAsteriscoMs', 'Espera depois de fechar *asteriscos* (ms)', 'number') +
                campoCfg('rtPausaFechaPalavraMs', 'Pausa que fecha a última palavra (ms)', 'number') +
                campoCfg('rtMaxConsultas', 'Máximo de consultas por mensagem', 'number') +
                campoCfg('rtFreioMensagens', 'Mensagens imunes depois de cortar', 'number') +
                campoCfg('rtGeracaoJunto', 'Geração começa já no envio', 'sw') +
                campoCfg('rtIndicadorLeitura', 'Pontinho enquanto a IA lê', 'sw') +
                '</div><p class="sub">Diagnóstico · eventos que faltam: ' +
                esc(faltam.join(', ') || 'nenhum') +
                ' · consultas: ' +
                d.consultas +
                ' · falhas: ' +
                d.falhas +
                (d.ultimaFalha ? ' (última: ' + esc(d.ultimaFalha) + ', ' + esc(fmtRel(d.ultimaFalhaEm)) + ')' : '') +
                ' · cortes: ' +
                d.cortes +
                ' · freio: ' +
                rtFreioLer() +
                ' mensagem(ns)' +
                (ult
                    ? ' · último envio: ' +
                      (ult.cortou ? 'cortado' : 'inteiro' + (ult.motivo ? ' (' + esc(ult.motivo) + ')' : '')) +
                      ', ' +
                      esc(fmtRel(ult.em))
                    : '') +
                '</p>' +
                (linhas ||
                    '<div class="spd-vazio">Nenhuma decisão ainda. Este painel é a única forma de ver o que a IA decidiu antes do envio.</div>')
            );
        }

        // ============================================================
        // 16 FICHAS (8.7.0) — Espaço dinâmico: o autor só fala; a IA do Espaço decide SE guarda e ONDE.
        // A IA propõe (etiqueta [[guardar]]{json}[[/guardar]] no fim da resposta); o CÓDIGO confere e grava.
        // Só ACRESCENTA, só mexe no que a própria Spade criou (meta.origem === 'espaco') e nunca escreve na Descrição.
        // O ORIGINAL da ficha (com <!-- i:… -->) é só pro autor ler; no prompt entra apenas a NOTA, montada por código.
        // ============================================================
        // >>FICHAS-PURO (sem DOM, sem ctx() e sem disco; usa só normTag, semAcento, estimarTokens e parseJsonObjetoSeguro; testado por testes/teste_espaco_dinamico.js)
        const FICHA_TEXTO_MAX = 600;
        const FICHA_TEXTO_MIN = 8;
        const FICHA_NOME_MAX = 40;
        const FICHA_TAGS_MAX = 4;
        const FICHA_TAGS_POR_FICHA = 8;
        const FICHA_ITENS_MAX = 30;
        const FICHA_NOTA_MAX_TOKENS = 400;
        const FICHA_MINIMA_TOKENS = 120;
        const FICHA_OUTRAS = 'Outras anotações';
        const FICHAS_LIM = { porResposta: 3, pastasAuto: 6, arquivosAuto: 40 };
        const RE_GUARDAR = /\[\[\s*guardar\s*\]\]([\s\S]*?)\[\[\s*\/\s*guardar\s*\]\]/gi;

        // Lê as etiquetas [[guardar]]{json}[[/guardar]]. Aberta e nunca fechada, JSON quebrado ou sobra solta: NÃO vira
        // anotação, some do texto visível e conta como incompleta (mesma ideia do extrairAcoes). Roda ANTES de extrairAcoes.
        function extrairGuardados(bruto) {
            const guardados = [];
            let incompletas = 0;
            let t = String(bruto || '').replace(RE_GUARDAR, (_m, corpo) => {
                const o = parseJsonObjetoSeguro(corpo);
                if (o) guardados.push(o);
                else incompletas++;
                return '';
            });
            t = t.replace(/\[\[\s*guardar\b[\s\S]*$/i, () => (incompletas++, ''));
            t = t.replace(/\[\[\s*\/\s*guardar[^\]]*\]\]/gi, () => (incompletas++, ''));
            return { limpo: t.replace(/\n{3,}/g, '\n\n').trim(), guardados, incompletas };
        }

        // ---- limpeza de textos e nomes ----
        const fLimpa = (s) =>
            String(s == null ? '' : s)
                .replace(/<!--|-->/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
        const fNome = (s, max = FICHA_NOME_MAX) =>
            fLimpa(s)
                .replace(/[\\/:*?"<>|]+/g, ' ')
                .replace(/\.md$/i, '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, max)
                .trim();
        // o nome do arquivo vira o título da nota no prompt: nenhuma palavra da extensão vai pra lá (regra de ouro 9)
        const fNomeArquivo = (s) =>
            fNome(s)
                .replace(/\b(?:fichas?|espa[cç]o|spade)\b/gi, ' ')
                .replace(/\s+/g, ' ')
                .trim();
        const fNorm = (s) =>
            semAcento(String(s == null ? '' : s))
                .toLowerCase()
                .replace(/[^a-z0-9\s]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
        // T8: "Ciclo e TPM" ≈ "ciclo e tpm" ≈ "Ciclo" (um contido no outro, por palavra inteira). "Ciclo" ≠ "Ciclos".
        function nomesEquivalentes(a, b) {
            const na = fNorm(a);
            const nb = fNorm(b);
            if (!na || !nb) return false;
            if (na === nb) return true;
            const [curto, longo] = na.length <= nb.length ? [na, nb] : [nb, na];
            return curto.length >= 3 && (' ' + longo + ' ').includes(' ' + curto + ' ');
        }
        // T9: igual, ou um contém o outro (sem acento, maiúscula e pontuação)
        function ehDuplicado(novo, lista) {
            const n = fNorm(novo);
            if (!n) return false;
            return (lista || []).some((e) => {
                const m = fNorm(e);
                if (!m) return false;
                if (n === m) return true;
                return Math.min(n.length, m.length) >= 6 && (n.includes(m) || m.includes(n));
            });
        }

        // ---- trava de conteúdo (T12): rede de segurança SIMPLES; o filtro principal é a instrução do prompt ----
        const F_NUM_EXT = '(?:um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|catorze|quatorze|quinze|dezesseis|dezasseis|dezessete|dezassete)';
        const F_RE_MENOR =
            /\b(?:crianc\w*|menin[oa]s?|garot[oa]s?|adolescent\w*|pre-?adolescent\w*|colegia\w+|menor(?:es)? de (?:idade|18)|abaixo de 18|menos de 18|loli|lolita|lolis|shota|novinh[ao]s?|pirralh\w*|guri[as]?)\b/;
        const F_RE_ROMANTICO =
            /\b(?:beij\w*|namor\w*|romanc\w*|romantic\w*|sexo|sexual\w*|sexuais|sexy|sensual\w*|seduc\w*|seduz\w*|intimidad\w*|intim[oa]s?|nu|nua|nuas|nus|nudez|despi\w*|excit\w*|tesao|paixao|apaixon\w*|caric\w*|flert\w*|transa\w*|amante\w*|ficante\w*|pelad[oa]s?|safad\w*|virgem|virgens|virgindade|gostos[oa]s?|erotic\w*|libido|orgasm\w*|masturb\w*|pornograf\w*)\b/;
        function idadeMenorDe18(t) {
            const re = new RegExp('(?:^|[^a-z0-9])(?:(\\d{1,2})|(' + F_NUM_EXT + '))\\s*(?:anos?|aninhos)\\b', 'g');
            let m;
            while ((m = re.exec(t))) {
                const antes = t.slice(0, m.index).trim().split(/\s+/).slice(-2).join(' ');
                // "há 10 anos", "por 5 anos", "depois de 3 anos": é duração, não idade
                if (/(?:^|\s)(?:ha|faz|fazem|por|durante|apos|desde|em|cada|daqui a|depois de|nos ultimos|mais de|quase)$/.test(antes)) continue;
                const n = m[1] ? +m[1] : F_NUM_EXT_VALOR[m[2]];
                if (n >= 1 && n < 18) return true;
            }
            const em = /(\d{1,2})[- ]?(?:year|yr)s?[- ]?old/.exec(t);
            if (em && +em[1] < 18) return true;
            const aos = /\baos\s+(\d{1,2})\b/.exec(t);
            return !!aos && +aos[1] < 18;
        }
        const F_NUM_EXT_VALOR = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, catorze: 14, quatorze: 14, quinze: 15, dezesseis: 16, dezasseis: 16, dezessete: 17, dezassete: 17 };
        // true = NÃO guardar: idade menor que 18 (ou palavra de menor) JUNTO com palavra romântica/sexual. Na dúvida, recusa.
        function travaConteudo(texto) {
            const t = semAcento(String(texto == null ? '' : texto)).toLowerCase();
            const menor = F_RE_MENOR.test(t) || idadeMenorDe18(t);
            return menor && F_RE_ROMANTICO.test(t);
        }

        // ---- 5.2/5.3: a etiqueta bruta vira um objeto confiável (ou um motivo de recusa) ----
        function normalizarGuardado(g) {
            const inc = { ok: false, incompleta: true, motivo: 'uma anotação veio incompleta e não foi guardada' };
            if (!g || typeof g !== 'object' || Array.isArray(g)) return inc;
            const onde = String(g.onde == null ? '' : g.onde)
                .trim()
                .toLowerCase();
            const texto = fLimpa(g.texto).replace(/^[-*•]\s+/, '');
            if (!onde || !texto) return inc;
            if (onde !== 'ficha' && onde !== 'memoria')
                return { ok: false, motivo: 'não sei guardar em “' + onde.slice(0, 20) + '”' };
            if (texto.length < FICHA_TEXTO_MIN) return { ok: false, motivo: 'a anotação ficou curta demais' };
            if (texto.length > FICHA_TEXTO_MAX)
                return { ok: false, motivo: 'a anotação passa de ' + FICHA_TEXTO_MAX + ' caracteres' };
            if (
                String(g.confianca == null ? 'alta' : g.confianca)
                    .trim()
                    .toLowerCase() === 'baixa'
            )
                return { ok: false, baixa: true, motivo: 'preciso confirmar' }; // T6: não grava; a IA pergunta no texto
            if (onde === 'memoria') return { ok: true, g: { onde, texto, confianca: 'alta' } };
            if (!fNome(g.pasta) || !fNome(g.arquivo)) return inc;
            const pasta = fNome(g.pasta);
            const arquivo = fNomeArquivo(g.arquivo);
            if (!arquivo) return { ok: false, motivo: 'o nome do arquivo ficou vazio' };
            const tipo = String(g.tipo || '').toLowerCase() === 'funcionamento' ? 'funcionamento' : 'apoio';
            const q = String(g.quando || '').toLowerCase();
            let quando = q === 'sempre' || q === 'cena' ? q : tipo === 'funcionamento' ? 'sempre' : 'cena';
            if (tipo === 'apoio') quando = 'cena'; // T11: apoio nunca vira "sempre"
            const brutas = Array.isArray(g.tags) ? g.tags : String(g.tags == null ? '' : g.tags).split(/[,;]/);
            const tags = [];
            brutas.forEach((t) => {
                const n = normTag(t);
                if (n && !tags.includes(n)) tags.push(n);
            });
            return {
                ok: true,
                g: { onde, texto, pasta, arquivo, tipo, quando, tags: tags.slice(0, FICHA_TAGS_MAX), confianca: 'alta' },
            };
        }

        // ---- 5.3 (7) e (8): aonde vai. Reaproveita o equivalente; só mexe no que a Spade criou; tetos desviam pra "Outras anotações" ----
        function fPreferir(lista, nome) {
            const nm = fNorm(nome);
            const exato = (x) => fNorm(x.nome || x.titulo) === nm;
            const meu = (x) => x.origem === 'espaco';
            return (
                lista.find((x) => exato(x) && meu(x)) || lista.find(meu) || lista.find(exato) || lista[0] || null
            );
        }
        function planejarDestino(g, estado, lim) {
            const L = Object.assign({}, FICHAS_LIM, lim || {});
            const pastas = estado.pastas || [];
            const arquivos = estado.arquivos || [];
            const meu = (x) => !!x && x.origem === 'espaco';
            const resolver = (nomePasta, nomeArq) => {
                const pasta = fPreferir(
                    pastas.filter((p) => nomesEquivalentes(p.nome, nomePasta)),
                    nomePasta
                );
                if (pasta && !meu(pasta))
                    return { recusa: 'a pasta “' + pasta.nome + '” não foi criada por mim, então não mexo nela' };
                let arquivo = null;
                if (pasta) {
                    arquivo = fPreferir(
                        arquivos.filter((a) => a.pastaId === pasta.id && nomesEquivalentes(a.titulo, nomeArq)),
                        nomeArq
                    );
                    if (arquivo && !meu(arquivo))
                        return { recusa: 'o arquivo “' + arquivo.titulo + '” não foi criado por mim, então não mexo nele' };
                }
                return { pasta, arquivo };
            };
            const montar = (r, nomePasta, nomeArq, extra) =>
                Object.assign(
                    {
                        pasta: r.pasta
                            ? { id: r.pasta.id, nome: r.pasta.nome, criar: false }
                            : { id: null, nome: nomePasta, criar: true },
                        arquivo: r.arquivo
                            ? {
                                  id: r.arquivo.id,
                                  titulo: r.arquivo.titulo,
                                  criar: false,
                                  itens: (r.arquivo.itens || []).length,
                                  tipo: r.arquivo.tipo || 'apoio',
                                  quando: r.arquivo.quando || 'cena',
                              }
                            : { id: null, titulo: nomeArq, criar: true, itens: 0, tipo: g.tipo, quando: g.quando },
                    },
                    extra
                );
            const r = resolver(g.pasta, g.arquivo);
            if (r.recusa) return r;
            const nMeus = (lista) => lista.filter(meu).length;
            let desvio = null;
            if (!r.pasta && nMeus(pastas) >= L.pastasAuto) desvio = 'passou do limite de ' + L.pastasAuto + ' pastas automáticas';
            else if (!r.arquivo && nMeus(arquivos) >= L.arquivosAuto)
                desvio = 'passou do limite de ' + L.arquivosAuto + ' fichas automáticas';
            else if (r.arquivo && (r.arquivo.itens || []).length >= FICHA_ITENS_MAX)
                desvio = 'a ficha “' + r.arquivo.titulo + '” já tem ' + FICHA_ITENS_MAX + ' itens';
            if (!desvio) return montar(r, g.pasta, g.arquivo, {});
            // vai pra "Outras anotações" da pasta padrão (essa não esbarra nos tetos de criação)
            const nomePadrao = estado.nomePadrao || 'Fichas';
            const r2 = resolver(nomePadrao, FICHA_OUTRAS);
            if (r2.recusa) return r2;
            if (r2.arquivo && (r2.arquivo.itens || []).length >= FICHA_ITENS_MAX)
                return { recusa: desvio + ', e “' + FICHA_OUTRAS + '” também está cheia' };
            const p = montar(r2, nomePadrao, FICHA_OUTRAS, {
                aviso: desvio + ': guardei em “' + FICHA_OUTRAS + '”',
                desviou: true,
            });
            if (!r2.arquivo) {
                p.arquivo.tipo = 'apoio';
                p.arquivo.quando = 'cena';
            }
            return p;
        }
        // 5.3: a IA propõe, o código confere. Devolve { ok:true, g, plano } ou { ok:false, motivo, ... }.
        // `estado` = { nomePadrao, pastas:[{id,nome,origem}], arquivos:[{id,titulo,pastaId,origem,tipo,quando,tags,itens:[texto]}], fatos:[texto] }
        function validarGuardado(bruto, estado, lim) {
            const n = normalizarGuardado(bruto);
            if (!n.ok) return n;
            const g = n.g;
            if (travaConteudo([g.texto, g.pasta || '', g.arquivo || ''].join(' ')))
                return { ok: false, motivo: 'não vou guardar isso', trava: true };
            if (g.onde === 'memoria') {
                if (ehDuplicado(g.texto, estado.fatos)) return { ok: false, motivo: 'já tinha isso' };
                return { ok: true, g, plano: { onde: 'memoria' } };
            }
            const plano = planejarDestino(g, estado, lim);
            if (plano.recusa) return { ok: false, motivo: plano.recusa };
            const pool = plano.pasta.criar
                ? []
                : (estado.arquivos || [])
                      .filter((a) => a.pastaId === plano.pasta.id && a.origem === 'espaco')
                      .reduce((acc, a) => acc.concat(a.itens || []), []);
            if (ehDuplicado(g.texto, pool)) return { ok: false, motivo: 'já tinha isso' };
            return { ok: true, g, plano: Object.assign({ onde: 'ficha' }, plano) };
        }
        // Põe o que foi guardado no `estado` (ids reais, ou temporários na simulação) pro próximo item da resposta enxergar.
        function aplicarNoEstado(estado, plano, g, ids) {
            if (g.onde === 'memoria') {
                estado.fatos.push(g.texto);
                return;
            }
            let pid = plano.pasta.id;
            if (plano.pasta.criar) {
                pid = (ids && ids.pastaId) || 'p~' + (estado.pastas.length + 1);
                estado.pastas.push({ id: pid, nome: plano.pasta.nome, origem: 'espaco' });
            }
            let a = plano.arquivo.id ? estado.arquivos.find((x) => x.id === plano.arquivo.id) : null;
            if (plano.arquivo.criar) {
                a = {
                    id: (ids && ids.arquivoId) || 'a~' + (estado.arquivos.length + 1),
                    titulo: plano.arquivo.titulo,
                    pastaId: pid,
                    origem: 'espaco',
                    tipo: plano.arquivo.tipo,
                    quando: plano.arquivo.quando,
                    tags: [],
                    itens: [],
                };
                estado.arquivos.push(a);
            }
            if (a) {
                a.itens = (a.itens || []).concat([g.texto]);
                a.tags = a.tags || [];
                (g.tags || []).forEach((t) => {
                    if (!a.tags.includes(t)) a.tags.push(t);
                });
            }
        }
        // T10: no máximo `porResposta` etiquetas; as outras são recusadas, na ordem em que vieram.
        function validarLote(brutos, estado, lim) {
            const L = Object.assign({}, FICHAS_LIM, lim || {});
            const sim = JSON.parse(JSON.stringify(estado));
            return (brutos || []).map((b, i) => {
                if (i >= L.porResposta)
                    return { ok: false, motivo: 'mais de ' + L.porResposta + ' anotações numa resposta' };
                const r = validarGuardado(b, sim, L);
                if (r.ok) aplicarNoEstado(sim, r.plano, r.g, null);
                return r;
            });
        }

        // ---- 5.4: o ORIGINAL da ficha (pro autor ler; nunca vai ao prompt) ----
        const F_RE_LINHA = /^\s*[-*]\s+(.*?)\s*(?:<!--\s*i:([A-Za-z0-9_-]+)(?:\s*·\s*esp:([^\s>]+))?\s*-->)?\s*$/;
        const linhaItem = (it) => '- ' + it.texto + ' <!-- i:' + it.id + (it.ref ? ' · esp:' + it.ref : '') + ' -->';
        const montarOriginalInicial = (titulo, linhas) => '# ' + titulo + '\n' + linhas.join('\n') + '\n';
        function acrescentarLinha(original, linha) {
            const base = String(original || '').replace(/\s+$/, '');
            return (base ? base + '\n' : '') + linha + '\n';
        }
        // Itens = linhas "- texto". As que o autor escreveu à mão (sem comentário) também contam, com id nulo.
        function lerItensOriginal(original) {
            const itens = [];
            String(original || '')
                .split(/\r?\n/)
                .forEach((linha, n) => {
                    const m = linha.match(F_RE_LINHA);
                    if (m && m[1]) itens.push({ id: m[2] || null, texto: m[1].trim(), ref: m[3] || null, linha: n });
                });
            return itens;
        }
        function removerLinhaItem(original, itemId) {
            const ls = String(original || '').split(/\r?\n/);
            const i = ls.findIndex((l) => {
                const m = l.match(F_RE_LINHA);
                return !!m && m[2] === itemId;
            });
            if (i < 0) return { ok: false, original: String(original || '') };
            ls.splice(i, 1);
            return { ok: true, original: ls.join('\n') };
        }
        // O item ainda está lá e o autor não mexeu nele? (T15: sem isso, o Desfazer/Mover recusa em vez de pisar no que ele editou)
        function conferirItem(original, card) {
            const it = lerItensOriginal(original).find((x) => x.id === card.itemId);
            if (!it) return { ok: false, motivo: 'o item não está mais na ficha (ela foi mexida depois)' };
            if (fNorm(it.texto) !== fNorm(card.texto)) return { ok: false, motivo: 'você editou esse item depois, então não mexo' };
            return { ok: true, item: it };
        }

        // ---- 6.3: a nota (o que entra no prompt) montada POR CÓDIGO, direto dos itens: sem IA, sem id, sem data, sem a palavra "ficha" ----
        function notaDaFicha(textos, tags, agora) {
            const lista = (textos || []).map(fLimpa).filter(Boolean);
            const completa = lista.join('\n');
            const m = [];
            let usado = 0;
            for (const t of lista) {
                const c = estimarTokens(t) + 1;
                if (m.length && usado + c > FICHA_MINIMA_TOKENS) break;
                m.push(t);
                usado += c;
            }
            return {
                nota: {
                    completa,
                    minima: m.join('\n'),
                    tags: (tags || []).slice(),
                    palavrasChave: [],
                    geradaEm: agora || 0,
                    editadaPeloUsuario: false,
                    revisada: true,
                    geradaPorCodigo: true,
                    historico: [],
                },
                longa: estimarTokens(completa) > FICHA_NOTA_MAX_TOKENS, // passou: NÃO entra em loop; o cartão oferece "Resumir"
            };
        }
        // Nota que o autor editou (ou que a IA resumiu) NÃO é reescrita (regra de ouro 6): o item novo só entra no fim dela.
        const fNotaDeCodigo = (nota) => !nota || (nota.geradaPorCodigo === true && !nota.editadaPeloUsuario);
        function notaAcrescentando(notaAtual, textosDepois, texto, tags, agora) {
            if (fNotaDeCodigo(notaAtual)) return notaDaFicha(textosDepois, tags, agora);
            const n = Object.assign({}, notaAtual);
            n.completa = (String(n.completa || '').trim() ? String(n.completa).trim() + '\n' : '') + fLimpa(texto);
            return { nota: n, longa: estimarTokens(n.completa) > FICHA_NOTA_MAX_TOKENS };
        }
        function notaRemovendo(notaAtual, textosDepois, texto, tags, agora) {
            if (!notaAtual) return null;
            if (fNotaDeCodigo(notaAtual)) return notaDaFicha(textosDepois, tags, agora).nota;
            const n = Object.assign({}, notaAtual);
            const sem = (campo) => {
                const ls = String(n[campo] || '').split('\n');
                const i = ls.map(fLimpa).lastIndexOf(fLimpa(texto));
                if (i >= 0) ls.splice(i, 1);
                return ls.join('\n');
            };
            n.completa = sem('completa');
            n.minima = sem('minima');
            return n;
        }

        // ---- 5.1: o que a IA do Espaço recebe ----
        function indiceFichasTexto(estado) {
            const meu = (x) => x.origem === 'espaco';
            const pastas = (estado.pastas || []).filter(meu);
            const nomePasta = (id) => (pastas.find((p) => p.id === id) || {}).nome;
            const linhas = (estado.arquivos || [])
                .filter((a) => meu(a) && nomePasta(a.pastaId))
                .map(
                    (a) =>
                        '- ' +
                        nomePasta(a.pastaId) +
                        ' › ' +
                        a.titulo +
                        ' [' +
                        (a.tipo || 'apoio') +
                        ', ' +
                        (a.quando || 'cena') +
                        ']' +
                        ((a.tags || []).length ? ' (' + a.tags.join(', ') + ')' : '')
                );
            return (
                '\n\n## FICHAS (pasta › arquivo [tipo, quando] (tags))\n' +
                (linhas.length ? linhas.join('\n') : '(nenhuma ainda)') +
                '\nPastas que você pode usar: ' +
                (pastas.length
                    ? pastas.map((p) => p.nome).join(', ')
                    : '(nenhuma ainda; a pasta padrão é “' + (estado.nomePadrao || 'Fichas') + '”)')
            );
        }
        // só os títulos dos campos preenchidos e ~80 caracteres de cada (nunca a Descrição inteira)
        function descricaoParaIA(d) {
            if (!d) return '';
            const campos = [
                ['Aparência', d.aparencia],
                ['Temperamento', d.temperamento],
                ['O que muda o humor', d.oQueMudaHumor],
                ['Como fala', d.comoFala],
                ['O que sabe', d.oQueSabe],
                ['Exemplos em momento frio', (d.exemplosFrios || []).join(' · ')],
            ];
            const l = campos
                .filter(([, v]) => String(v || '').trim())
                .map(([k, v]) => '- ' + k + ': ' + String(v).replace(/\s+/g, ' ').trim().slice(0, 80));
            return (
                '\n\n## DESCRIÇÃO (campos preenchidos; não guarde de novo o que já está aqui)\n' +
                (l.length ? l.join('\n') : '(vazia)')
            );
        }
        function instrucaoOrganizar(podeMemoria) {
            return [
                '\n\n## ORGANIZAR O QUE O AUTOR CONTA',
                'Quando o autor contar algo DURÁVEL sobre a personagem (como ela é, como age, o que a afeta), ou algo que ajude a interpretá-la, guarde por conta própria, SEM esperar ele pedir. Escreva uma etiqueta por informação, no FIM da resposta:',
                '[[guardar]]{"onde":"ficha","pasta":"nome da pasta","arquivo":"nome do arquivo","tipo":"funcionamento|apoio","quando":"sempre|cena","tags":["ciclo","tpm"],"texto":"a informação, curta, na 3ª pessoa","confianca":"alta|baixa"}[[/guardar]]',
                podeMemoria
                    ? '[[guardar]]{"onde":"memoria","texto":"fato que aconteceu na história","confianca":"alta"}[[/guardar]]'
                    : '(Nesta conversa não dá pra guardar fatos na memória da história: só em fichas.)',
                'Regras:',
                '- Reaproveite uma pasta ou arquivo da lista FICHAS quando o tema for o mesmo. Só crie um novo se nada servir.',
                '- "funcionamento" = núcleo (como ela é e age). "apoio" = informação secundária que ajuda (corpo, rotina, hábitos, reações em situações específicas).',
                '- "sempre" só para o que vale em toda cena. O resto é "cena".',
                '- Escreva "texto" curto, fiel ao que o autor disse. Não invente nada. Se ele deu várias informações, uma etiqueta para cada (no máximo 3 por resposta).',
                '- Se for só conversa, pergunta ou pedido para a PRÓXIMA fala, não guarde nada.',
                '- Se não tiver certeza de ONDE ou SE guarda, não use a etiqueta: pergunte em uma frase.',
                '- Não guarde o que já está nos campos da DESCRIÇÃO. Se for personalidade básica, guarde como "funcionamento" e pergunte UMA vez, em texto, se o autor quer passar para a Descrição (ele mesmo faz; você não escreve lá).',
                '- O nome do arquivo não pode ter as palavras ficha, espaço nem spade.',
                '- Nunca guarde comportamento romântico ou sexual que envolva personagem menor de 18 anos.',
                '- Depois de guardar, diga em UMA frase curta o que guardou e onde.',
            ].join('\n');
        }
        // ---- Fase 2 (8.8.0): organizar o que já falei, arrumar fichas. Aqui só o PURO (ler a resposta da IA e conferir); gravar fica mais abaixo ----
        const LOTE_MSG_MAX = 120; // mensagens antigas lidas por rodada (as mais recentes)
        const LOTE_CHARS_MSG = 500; // cada mensagem é cortada aqui
        const LOTE_CHARS_PARTE = 6000; // uma chamada de IA por parte
        const LOTE_PARTES_MAX = 5;
        const LOTE_PROPOSTAS_MAX = 40;
        const ARRUMAR_MAX = 10;

        // msgs = [{ ref, texto }] do mais antigo para o mais novo → partes numeradas ([1], [2]…) que a IA lê
        function dividirLoteConversas(msgs, charsParte) {
            const lim = charsParte || LOTE_CHARS_PARTE;
            const partes = [];
            let atual = { itens: [], chars: 0 };
            (msgs || []).forEach((m) => {
                const t = fLimpa(m && m.texto).slice(0, LOTE_CHARS_MSG);
                if (t.length < FICHA_TEXTO_MIN) return;
                if (atual.itens.length && atual.chars + t.length > lim) {
                    partes.push(atual);
                    atual = { itens: [], chars: 0 };
                }
                atual.itens.push({ n: atual.itens.length + 1, ref: m.ref, texto: t });
                atual.chars += t.length;
            });
            if (atual.itens.length) partes.push(atual);
            return partes.map((p) => ({ itens: p.itens, texto: p.itens.map((i) => '[' + i.n + '] ' + i.texto).join('\n') }));
        }
        function promptOrganizarLote(estado, desc, parte) {
            const sistema = [
                'Você organiza as anotações de um autor de RP. Abaixo estão mensagens ANTIGAS que ele escreveu para uma IA nos bastidores (numeradas). Procure só informação DURÁVEL sobre a personagem (como ela é, como age, o que a afeta, corpo, rotina, hábitos, reações em situações específicas) e proponha guardá-la em fichas.',
                'Responda SOMENTE com um JSON, sem texto em volta: {\"anotacoes\":[{\"msg\":3,\"onde\":\"ficha\",\"pasta\":\"nome da pasta\",\"arquivo\":\"nome do arquivo\",\"tipo\":\"funcionamento|apoio\",\"quando\":\"sempre|cena\",\"tags\":[\"ciclo\",\"tpm\"],\"texto\":\"a informação, curta, na 3ª pessoa\",\"confianca\":\"alta|baixa\"}]}',
                'Regras:',
                '- \"msg\" é o número da mensagem de onde a informação saiu. Uma mensagem pode gerar mais de uma anotação.',
                '- Reaproveite pasta e arquivo da lista FICHAS quando o tema for o mesmo. Só crie um novo se nada servir.',
                '- \"funcionamento\" = núcleo (como ela é e age). \"apoio\" = informação secundária que ajuda. \"sempre\" só para o que vale em toda cena; o resto é \"cena\".',
                '- Ignore conversa, perguntas, pedidos para a próxima fala e o que já está na DESCRIÇÃO. Não invente nada; seja fiel ao que o autor escreveu.',
                '- O nome do arquivo não pode ter as palavras ficha, espaço nem spade.',
                '- Se não houver nada a guardar, responda {\"anotacoes\":[]}. No máximo 15 anotações.',
            ].join('\n');
            const usuario = indiceFichasTexto(estado).trim() + '\n\n' + descricaoParaIA(desc).trim() + '\n\n## MENSAGENS ANTIGAS DO AUTOR\n' + parte.texto;
            return [
                { role: 'system', content: sistema },
                { role: 'user', content: usuario },
            ];
        }
        // Lê a resposta de UMA parte. Só vale \"ficha\" (a memória é por chat). Devolve as anotações brutas já com a referência da mensagem.
        function lerAnotacoesLote(resp, parte) {
            const o = parseJsonObjetoSeguro(resp);
            const lista = o && Array.isArray(o.anotacoes) ? o.anotacoes : null;
            const itens = [];
            let descartadas = 0;
            (lista || []).forEach((x) => {
                const it = x && typeof x === 'object' ? parte.itens.find((i) => i.n === Number(x.msg)) : null;
                if (!it || String(x.onde == null ? 'ficha' : x.onde).trim().toLowerCase() !== 'ficha') {
                    descartadas++;
                    return;
                }
                itens.push(Object.assign({}, x, { onde: 'ficha', _ref: it.ref, _fonte: it.texto }));
            });
            return { itens, descartadas, formatoRuim: !lista };
        }
        // O código confere TODAS as anotações (as mesmas travas da 8.7.0, mais a lista que vai crescendo: não repete nem entre as propostas)
        function validarAnotacoesLote(brutos, estado, lim) {
            const res = validarLote(brutos, estado, Object.assign({}, lim || {}, { porResposta: LOTE_PROPOSTAS_MAX }));
            return res.map((r, i) => Object.assign({}, r, { ref: brutos[i] && brutos[i]._ref, fonte: brutos[i] && brutos[i]._fonte }));
        }
        // ficha que a Spade criou e que ficou sem item nenhum e sem nada escrito à mão (só o título): pode ir embora
        function fichaVazia(original) {
            return String(original || '')
                .split(/\r?\n/)
                .every((l) => !l.trim() || /^\s*#/.test(l));
        }
        // fichas = [{ key:'F1', id, titulo, pastaNome, origem, tipo, quando, itens:[{ n, id, texto }] }]
        function promptArrumar(fichas) {
            const sistema = [
                'Você arruma as fichas de um autor de RP. Cada ficha é uma lista curta de itens sobre a personagem. Proponha SÓ o que melhora de verdade: juntar fichas que tratam do mesmo assunto, ou mover um item para a ficha onde ele combina mais. Se estiver tudo certo, não proponha nada.',
                'Responda SOMENTE com um JSON, sem texto em volta: {\"juntar\":[{\"de\":\"F2\",\"para\":\"F1\",\"motivo\":\"curto\"}],\"mover\":[{\"item\":\"F3.2\",\"para\":\"F1\",\"motivo\":\"curto\"}]}',
                'Regras: \"de\", \"para\" e \"item\" usam os códigos da lista (F1, F2…; item = ficha ponto número, ex.: F3.2). Nunca invente código. Só se mexe em fichas da lista. No máximo ' + ARRUMAR_MAX + ' sugestões no total. Nada é apagado: juntar leva os itens da ficha \"de\" para a ficha \"para\".',
            ].join('\n');
            const linhas = fichas.map(
                (f) =>
                    f.key +
                    ' · ' +
                    f.pastaNome +
                    ' › ' +
                    f.titulo +
                    ' [' +
                    f.tipo +
                    ', ' +
                    f.quando +
                    ']\n' +
                    (f.itens.filter((i) => i.id).map((i) => '  ' + f.key + '.' + i.n + ' ' + i.texto).join('\n') || '  (sem itens)')
            );
            return [
                { role: 'system', content: sistema },
                { role: 'user', content: '## FICHAS\n' + linhas.join('\n') },
            ];
        }
        function lerPlanoArrumar(resp) {
            const o = parseJsonObjetoSeguro(resp);
            return { ok: !!o, juntar: o && Array.isArray(o.juntar) ? o.juntar : [], mover: o && Array.isArray(o.mover) ? o.mover : [] };
        }
        // A IA propõe; o código só deixa passar o que faz sentido: fichas da Spade, códigos que existem, sem encadear, sem estourar o teto de itens, sem duplicar.
        function validarPlanoArrumar(plano, fichas) {
            const porKey = new Map((fichas || []).map((f) => [String(f.key).toUpperCase(), f]));
            const ficha = (k) => porKey.get(String(k == null ? '' : k).trim().toUpperCase());
            const props = [];
            const descartadas = [];
            const sumiu = new Set(); // fichas que serão esvaziadas (origem de um juntar)
            const recebe = new Map(); // quantos itens cada ficha recebe nesta rodada
            const movidos = new Set();
            const motivo = (x) => fLimpa(x && x.motivo).slice(0, 160);
            const muda = (a, b) => a.tipo !== b.tipo || a.quando !== b.quando;
            const cabe = (B, n) => B.itens.length + (recebe.get(B.key) || 0) + n <= FICHA_ITENS_MAX;
            (plano && plano.juntar ? plano.juntar : []).forEach((x) => {
                if (props.length >= ARRUMAR_MAX) return;
                const A = ficha(x && x.de);
                const B = ficha(x && x.para);
                if (!A || !B || A === B || A.origem !== 'espaco' || B.origem !== 'espaco') return descartadas.push('juntar com código inválido');
                if (sumiu.has(A.key) || sumiu.has(B.key) || recebe.has(A.key)) return descartadas.push('juntar encadeado');
                const mov = A.itens.filter((i) => i.id);
                if (!mov.length) return descartadas.push('juntar sem itens');
                if (!cabe(B, mov.length)) return descartadas.push('juntar passaria do teto de itens');
                sumiu.add(A.key);
                recebe.set(B.key, (recebe.get(B.key) || 0) + mov.length);
                props.push({ tipo: 'juntar', deId: A.id, paraId: B.id, deNome: A.titulo, paraNome: B.titulo, n: mov.length, muda: muda(A, B), motivo: motivo(x) });
            });
            (plano && plano.mover ? plano.mover : []).forEach((x) => {
                if (props.length >= ARRUMAR_MAX) return;
                const m = String(x && x.item == null ? '' : x.item)
                    .trim()
                    .match(/^([A-Za-z]+\d+)\s*[.:#/-]\s*(\d+)$/);
                const A = m && ficha(m[1]);
                const B = ficha(x && x.para);
                if (!A || !B || A === B || A.origem !== 'espaco' || B.origem !== 'espaco') return descartadas.push('mover com código inválido');
                const it = A.itens.find((i) => i.n === Number(m[2]));
                if (!it || !it.id) return descartadas.push('mover um item que não existe');
                if (sumiu.has(A.key) || sumiu.has(B.key)) return descartadas.push('mover de/para ficha que vai ser juntada');
                if (movidos.has(A.key + '.' + it.n)) return descartadas.push('item repetido');
                if (ehDuplicado(it.texto, B.itens.map((i) => i.texto))) return descartadas.push('a outra ficha já tem isso');
                if (!cabe(B, 1)) return descartadas.push('mover passaria do teto de itens');
                movidos.add(A.key + '.' + it.n);
                recebe.set(B.key, (recebe.get(B.key) || 0) + 1);
                props.push({ tipo: 'mover', deId: A.id, paraId: B.id, deNome: A.titulo, paraNome: B.titulo, itemId: it.id, texto: it.texto, muda: muda(A, B), motivo: motivo(x) });
            });
            return { props, descartadas };
        }

        // <<FICHAS-PURO

        // ---- configuração e estado atual (lê a Biblioteca e a Memória; não grava nada) ----
        const organizaModo = () => {
            const m = getConfig().espacoOrganiza;
            return m === 'perguntar' || m === 'desligado' ? m : 'avisar';
        };
        const nomePadraoFichas = () => fNome(getConfig().nomeDasFichas) || 'Fichas';
        const limitesFichas = () => {
            const c = getConfig();
            return { porResposta: c.fichasMaxPorResposta, pastasAuto: c.fichasMaxPastasAuto, arquivosAuto: c.fichasMaxArquivosAuto };
        };
        const tituloArq = (a) => a.meta.titulo || a.meta.nome.replace(/\.[a-z0-9]+$/i, '');
        const refDaMensagem = (convId, idx) => convId + ':' + idx;
        function estadoFichas() {
            return {
                nomePadrao: nomePadraoFichas(),
                pastas: Bib.indice.pastas.map((p) => ({ id: p.id, nome: p.nome, origem: p.origem || null })),
                arquivos: listaArquivos().map((a) => ({
                    id: a.id,
                    titulo: tituloArq(a),
                    pastaId: a.meta.pastaId,
                    origem: a.meta.origem || null,
                    tipo: (a.meta.ficha && a.meta.ficha.tipo) || null,
                    quando: (a.meta.ficha && a.meta.ficha.quando) || null,
                    tags: tagsDe(a),
                    itens: [],
                })),
                fatos: Mem.rp.fatos.map((f) => f.texto),
            };
        }
        // os itens vêm do ORIGINAL no disco (é ele que o autor pode ter editado); só das fichas criadas pelo Espaço
        async function carregarItensFichas(estado) {
            for (const a of estado.arquivos.filter((x) => x.origem === 'espaco')) {
                try {
                    const d = await Disco.arqLer(a.id, ['original']);
                    a.itens = lerItensOriginal(d.original).map((x) => x.texto);
                } catch (_) {
                    const arq = Bib.arquivos.get(a.id);
                    a.itens = String((arq && arq.nota && arq.nota.completa) || '')
                        .split('\n')
                        .filter(Boolean);
                }
            }
            return estado;
        }
        function fichasTextoParaIA(podeMemoria) {
            return indiceFichasTexto(estadoFichas()) + descricaoParaIA(Desc.v) + instrucaoOrganizar(podeMemoria);
        }
        const fichasDoEspaco = () => listaArquivos().filter((a) => a.meta.origem === 'espaco');

        // ---- gravar: pasta → arquivo (original + meta) → nota. Falhou no meio = desfaz o que já criou nesta ação ----
        async function fichaCriarArquivo({ pastaId, titulo, tipo, quando, tags, item }) {
            const r = notaDaFicha([item.texto], tags, Date.now());
            const a = await criarArquivo({
                nome: titulo + '.md',
                texto: montarOriginalInicial(titulo, [linhaItem(item)]),
                pastaId,
                tipo: tipo === 'funcionamento' ? 'lore' : 'documento', // nunca 'regra' (tem significado na 8.6) nem tipo novo
                escopo: 'personagem',
                extra: {
                    titulo,
                    estado: 'pronto',
                    origem: 'espaco',
                    ficha: { tipo, quando },
                    sempreAtivo: quando === 'sempre',
                    prioridade: tipo === 'funcionamento' ? 'alta' : 'baixa',
                    tagsUsuario: (tags || []).slice(),
                    ativo: true,
                },
            });
            try {
                a.nota = r.nota;
                await salvarNotaArq(a);
            } catch (e) {
                await apagarArquivo(a).catch(() => {});
                throw e;
            }
            return { arquivo: a, longa: r.longa };
        }
        async function fichaAcrescentar(a, item, tags) {
            const d = await Disco.arqLer(a.id, ['original']);
            const antes = lerItensOriginal(d.original);
            if (antes.length >= FICHA_ITENS_MAX) throw new Error('a ficha já tem ' + FICHA_ITENS_MAX + ' itens');
            if (ehDuplicado(item.texto, antes.map((x) => x.texto))) {
                const e = new Error('já tinha isso');
                e.duplicado = true;
                throw e;
            }
            const novo = acrescentarLinha(d.original, linhaItem(item));
            let ver;
            try {
                ver = (await Disco.arqOriginal(a.id, novo, d.versoes && d.versoes.original)).versao;
            } catch (e) {
                if (e.conflito) {
                    await recarregarArq(a.id);
                    throw new Error(avisoConflito(e));
                }
                throw e;
            }
            try {
                const removidas = new Set((a.meta.tagsRemovidas || []).map(normTag)); // o que o autor tirou não volta
                const atuais = tagsDe(a);
                const tagsAntes = a.meta.tagsUsuario || [];
                const espaco = Math.max(0, FICHA_TAGS_POR_FICHA - tagsAntes.length);
                const novas = (tags || []).filter((t) => !removidas.has(t) && !atuais.includes(t)).slice(0, espaco);
                const tagsDepois = tagsAntes.concat(novas);
                const r = notaAcrescentando(a.nota, lerItensOriginal(novo).map((x) => x.texto), item.texto, tagsDepois, Date.now());
                a.nota = r.nota;
                await salvarNotaArq(a);
                a.meta.tagsUsuario = tagsDepois;
                a.meta.editadoEm = Date.now();
                await salvarMetaArq(a);
                return { longa: r.longa, tagsNovas: novas };
            } catch (e) {
                await Disco.arqOriginal(a.id, d.original, ver).catch(() => {}); // melhor esforço: não deixa o item sem nota
                throw e;
            }
        }
        // tira o item da ficha (Desfazer e Mover). Ficha que a ação criou e ficou vazia: devolve vazia:true (quem chamou apaga).
        async function fichaRemoverItem(a, card) {
            const d = await Disco.arqLer(a.id, ['original']);
            const c = conferirItem(d.original, card);
            if (!c.ok) return c;
            const rm = removerLinhaItem(d.original, card.itemId);
            try {
                await Disco.arqOriginal(a.id, rm.original, d.versoes && d.versoes.original);
            } catch (e) {
                if (e.conflito) {
                    await recarregarArq(a.id);
                    return { ok: false, motivo: avisoConflito(e) };
                }
                throw e;
            }
            const textos = lerItensOriginal(rm.original).map((x) => x.texto);
            if (!textos.length && card.criouArquivo) return { ok: true, vazia: true };
            const tirar = new Set(card.tagsNovas || []);
            a.meta.tagsUsuario = (a.meta.tagsUsuario || []).filter((t) => !tirar.has(t));
            const nota = notaRemovendo(a.nota, textos, card.texto, a.meta.tagsUsuario, Date.now());
            if (nota) {
                a.nota = nota;
                await salvarNotaArq(a);
            }
            a.meta.editadoEm = Date.now();
            await salvarMetaArq(a);
            return { ok: true, restantes: textos.length };
        }
        async function apagarPastaSeVazia(pastaId) {
            if (pastaInfo(pastaId) && !listaArquivos().some((x) => x.meta.pastaId === pastaId)) await apagarPasta(pastaId);
        }

        // Valida DE NOVO (o estado pode ter mudado) e grava um item. Devolve os campos do cartão.
        async function fichasExecutar(g, ref, estado, podeMemoria) {
            const r = validarGuardado(g, estado, limitesFichas());
            if (!r.ok) return { estado: 'recusada', motivo: r.motivo, trava: !!r.trava };
            if (g.onde === 'memoria') {
                if (!podeMemoria) return { estado: 'recusada', motivo: 'esta conversa não está ligada ao chat aberto do RP' };
                await memCarregar();
                const fato = {
                    id: newId('f'),
                    texto: g.texto,
                    sabem: [personagemAtual()],
                    criadoEm: Date.now(),
                }; // mesmo formato do botão "Novo fato"
                Mem.rp.fatos.push(fato);
                try {
                    await memSalvar('rp');
                } catch (e) {
                    Mem.rp.fatos = Mem.rp.fatos.filter((x) => x.id !== fato.id);
                    throw e;
                }
                aplicarNoEstado(estado, r.plano, g, null);
                return { estado: 'feita', onde: 'memoria', fatoId: fato.id, texto: g.texto, ref };
            }
            const plano = r.plano;
            const item = { id: newId('fi'), texto: g.texto, ref };
            let pastaCriada = null;
            let arq = null;
            let criouArquivo = false;
            let longa = false;
            let tagsNovas = [];
            try {
                let pastaId = plano.pasta.id;
                if (plano.pasta.criar) {
                    pastaCriada = await criarPasta(plano.pasta.nome, null, { origem: 'espaco' });
                    pastaId = pastaCriada.id;
                }
                if (plano.arquivo.criar) {
                    const x = await fichaCriarArquivo({
                        pastaId,
                        titulo: plano.arquivo.titulo,
                        tipo: plano.arquivo.tipo,
                        quando: plano.arquivo.quando,
                        tags: g.tags,
                        item,
                    });
                    arq = x.arquivo;
                    longa = x.longa;
                    criouArquivo = true;
                    tagsNovas = (g.tags || []).slice();
                } else {
                    arq = Bib.arquivos.get(plano.arquivo.id);
                    const x = await fichaAcrescentar(arq, item, g.tags);
                    longa = x.longa;
                    tagsNovas = x.tagsNovas;
                }
            } catch (e) {
                if (pastaCriada) await apagarPasta(pastaCriada.id).catch(() => {}); // nada de pasta órfã
                if (e.duplicado) return { estado: 'recusada', motivo: 'já tinha isso' };
                throw e;
            }
            aplicarNoEstado(estado, plano, g, { pastaId: arq.meta.pastaId, arquivoId: arq.id });
            const aviso = [plano.aviso, Plug.ok === false ? 'sem o plugin: ficou só neste navegador' : '']
                .filter(Boolean)
                .join(' · ');
            return {
                estado: 'feita',
                onde: 'ficha',
                texto: g.texto,
                ref,
                itemId: item.id,
                arquivoId: arq.id,
                arquivoNome: tituloArq(arq),
                pastaId: arq.meta.pastaId,
                pastaNome: (pastaInfo(arq.meta.pastaId) || {}).nome || '',
                tipoFicha: plano.arquivo.tipo,
                quando: plano.arquivo.quando,
                sempre: plano.arquivo.quando === 'sempre',
                tags: g.tags,
                tagsNovas,
                criouArquivo,
                criouPasta: !!pastaCriada,
                longa,
                aviso: aviso || undefined,
            };
        }
        // Processa as etiquetas de UMA resposta. avisar = guarda e mostra o cartão · perguntar = cartão com Guardar/Ignorar
        async function guardarDoEspaco(ext, conv, iu, podeMemoria) {
            const modo = organizaModo();
            await bibCarregar();
            const estado = estadoFichas();
            await carregarItensFichas(estado);
            const lote = validarLote(ext.guardados, estado, limitesFichas());
            const ref = refDaMensagem(conv.id, iu);
            const base = { tipo: 'guardar', convId: conv.id, msgIdx: iu };
            const cards = [];
            let sempreGuardada = false;
            for (const r of lote) {
                if (!r.ok) {
                    cards.push(Object.assign({}, base, { estado: 'recusada', motivo: r.motivo, trava: !!r.trava }));
                    continue;
                }
                if (modo === 'perguntar') {
                    cards.push(
                        Object.assign({}, base, {
                            estado: 'pendente',
                            onde: r.g.onde,
                            g: r.g,
                            ref,
                            texto: r.g.texto,
                            pastaNome: r.plano.pasta && r.plano.pasta.nome,
                            arquivoNome: r.plano.arquivo && r.plano.arquivo.titulo,
                            aviso: r.plano.aviso,
                        })
                    );
                    continue;
                }
                try {
                    const c = await fichasExecutar(r.g, ref, estado, podeMemoria);
                    cards.push(Object.assign({}, base, c));
                    if (c.estado === 'feita' && c.sempre) sempreGuardada = true;
                } catch (e) {
                    cards.push(Object.assign({}, base, { estado: 'recusada', motivo: 'deu erro: ' + (e && e.message) }));
                }
            }
            if (ext.incompletas)
                cards.push(
                    Object.assign({}, base, {
                        estado: 'recusada',
                        motivo:
                            ext.incompletas === 1
                                ? 'uma anotação veio incompleta e não foi guardada'
                                : ext.incompletas + ' anotações vieram incompletas e não foram guardadas',
                    })
                );
            return { cards, sempreGuardada };
        }
        // a mensagem do autor guardada como "sempre" não vai de novo como pedido recente (bloco 5); como "cena", continua valendo
        function recalcularGuardada(h, msgIdx) {
            const m = h[msgIdx];
            if (!m || m.role !== 'user') return;
            m.guardada = h.some((x) =>
                (x.acoes || []).some((a) => a.tipo === 'guardar' && a.msgIdx === msgIdx && a.estado === 'feita' && a.sempre)
            );
            if (!m.guardada) delete m.guardada;
        }
        async function guardarDesfazer(card) {
            if (card.estado !== 'feita') return { ok: false, motivo: 'não há o que desfazer' };
            if (card.onde === 'memoria') {
                await memCarregar();
                const f = Mem.rp.fatos.find((x) => x.id === card.fatoId);
                if (!f) return { ok: false, motivo: 'o fato não está mais na memória' };
                if (fNorm(f.texto) !== fNorm(card.texto)) return { ok: false, motivo: 'você editou esse fato depois, então não mexo' };
                Mem.rp.fatos = Mem.rp.fatos.filter((x) => x.id !== card.fatoId);
                await memSalvar('rp');
                return { ok: true };
            }
            await bibCarregar();
            const a = Bib.arquivos.get(card.arquivoId);
            if (!a) return { ok: false, motivo: 'a ficha não existe mais' };
            const r = await fichaRemoverItem(a, card);
            if (!r.ok) return r;
            if (r.vazia) {
                await apagarArquivo(a);
                if (card.criouPasta) await apagarPastaSeVazia(card.pastaId);
            }
            return { ok: true };
        }
        // destino = { arquivoId } (outra ficha criada pelo Espaço) ou { novo: 'Nome' } (ficha nova na mesma pasta)
        async function guardarMover(card, destino) {
            if (card.estado !== 'feita' || card.onde !== 'ficha') return { ok: false, motivo: 'não dá pra mover isto' };
            await bibCarregar();
            const A = Bib.arquivos.get(card.arquivoId);
            if (!A) return { ok: false, motivo: 'a ficha não existe mais' };
            const dA = await Disco.arqLer(A.id, ['original']);
            const c = conferirItem(dA.original, card);
            if (!c.ok) return c;
            const item = { id: card.itemId, texto: card.texto, ref: c.item.ref || card.ref };
            let B;
            let criouB = false;
            let longaB = false;
            let tagsNovasB = [];
            if (destino.novo) {
                const titulo = fNomeArquivo(destino.novo);
                if (!titulo) return { ok: false, motivo: 'dê um nome à ficha' };
                if (travaConteudo(titulo + ' ' + card.texto)) return { ok: false, motivo: 'não vou guardar isso' };
                const igual = fichasDoEspaco().find((x) => x.meta.pastaId === A.meta.pastaId && nomesEquivalentes(tituloArq(x), titulo));
                if (igual) B = igual;
                else {
                    const x = await fichaCriarArquivo({
                        pastaId: A.meta.pastaId,
                        titulo,
                        tipo: card.tipoFicha,
                        quando: card.quando,
                        tags: card.tags || [],
                        item,
                    });
                    B = x.arquivo;
                    criouB = true;
                    longaB = x.longa;
                    tagsNovasB = (card.tags || []).slice();
                }
            } else {
                B = Bib.arquivos.get(destino.arquivoId);
                if (!B || B.meta.origem !== 'espaco') return { ok: false, motivo: 'só movo entre fichas criadas pelo Espaço' };
            }
            if (B.id === A.id) return { ok: false, motivo: 'já está nessa ficha' };
            if (!criouB) {
                try {
                    const x = await fichaAcrescentar(B, item, card.tags || []);
                    longaB = x.longa;
                    tagsNovasB = x.tagsNovas;
                } catch (e) {
                    if (e.duplicado) return { ok: false, motivo: 'essa ficha já tem isso' };
                    throw e;
                }
            }
            const rm = await fichaRemoverItem(A, card);
            if (!rm.ok) {
                // a origem não deixou tirar: devolve o que entrou no destino (nada fica nos dois lugares)
                const volta = await fichaRemoverItem(B, { itemId: card.itemId, texto: card.texto, tagsNovas: tagsNovasB, criouArquivo: criouB }).catch(() => null);
                if (volta && volta.vazia) await apagarArquivo(B).catch(() => {});
                return rm;
            }
            if (rm.vazia) {
                await apagarArquivo(A);
                if (card.criouPasta) await apagarPastaSeVazia(card.pastaId);
            }
            const ficha = B.meta.ficha || { tipo: card.tipoFicha, quando: card.quando };
            Object.assign(card, {
                arquivoId: B.id,
                arquivoNome: tituloArq(B),
                pastaId: B.meta.pastaId,
                pastaNome: (pastaInfo(B.meta.pastaId) || {}).nome || '',
                tipoFicha: ficha.tipo,
                quando: ficha.quando,
                sempre: ficha.quando === 'sempre',
                tagsNovas: tagsNovasB,
                criouArquivo: criouB,
                criouPasta: false,
                longa: longaB,
            });
            return { ok: true };
        }
        // o autor decide um cartão "pendente" (modo perguntar)
        async function guardarConfirmar(convId, i, k) {
            const h = await lerHistorico(convId);
            const card = h[i] && h[i].acoes && h[i].acoes[k];
            if (!card || card.estado !== 'pendente') return;
            const conv = (Esp.chats || []).find((c) => c.id === convId);
            const podeMemoria = !!(conv && conv.stChatId && conv.stChatId === stChatIdAtual());
            await bibCarregar();
            const estado = estadoFichas();
            await carregarItensFichas(estado);
            let c;
            try {
                c = await fichasExecutar(card.g, card.ref, estado, podeMemoria);
            } catch (e) {
                c = { estado: 'recusada', motivo: 'deu erro: ' + (e && e.message) };
            }
            Object.assign(card, c);
            delete card.g;
            recalcularGuardada(h, card.msgIdx);
            await guardarPersistir(convId, h);
            if (c.estado === 'recusada') toast('Não guardei: ' + c.motivo + '.', true);
        }
        async function guardarIgnorar(convId, i, k) {
            const h = await lerHistorico(convId);
            const card = h[i] && h[i].acoes && h[i].acoes[k];
            if (!card || card.estado !== 'pendente') return;
            card.estado = 'ignorada';
            delete card.g;
            await guardarPersistir(convId, h);
        }
        async function guardarPersistir(convId, h) {
            await salvarHistorico(convId, h);
            if (Esp.abertaId === convId) Esp.msgs = h;
            await espacoCarregarParaRp();
            sincronizarVolateis();
            sincronizarSoon();
            refrescarUI();
        }
        async function desfazerGuardarEspaco(convId, i, k) {
            const h = await lerHistorico(convId);
            const card = h[i] && h[i].acoes && h[i].acoes[k];
            if (!card) return;
            const r = await guardarDesfazer(card);
            if (!r.ok) return toast('Não deu pra desfazer: ' + r.motivo + '.', true);
            card.estado = 'desfeita';
            recalcularGuardada(h, card.msgIdx);
            await guardarPersistir(convId, h);
            toast('Desfeito.');
        }
        async function moverGuardadoEspaco(convId, i, k, destino) {
            const h = await lerHistorico(convId);
            const card = h[i] && h[i].acoes && h[i].acoes[k];
            if (!card) return;
            const r = await guardarMover(card, destino);
            if (!r.ok) throw new Error('Não deu pra mover: ' + r.motivo + '.');
            recalcularGuardada(h, card.msgIdx);
            await guardarPersistir(convId, h);
            toast('Movido.');
        }
        function resumoGuardarParaIA(a) {
            const onde = a.onde === 'memoria' ? 'memória da história' : (a.pastaNome || '') + ' › ' + (a.arquivoNome || '');
            if (a.estado === 'feita') return '[guardado em ' + onde + ']';
            if (a.estado === 'desfeita') return '[desfeito pelo autor: ' + onde + ']';
            if (a.estado === 'pendente') return '[anotação esperando o autor decidir]';
            if (a.estado === 'ignorada') return '[o autor não quis guardar]';
            return '[não guardei: ' + (a.motivo || 'não deu') + ']';
        }
        // ============ Fase 2 (8.8.0) — organizar o que já falei · arrumar fichas · passar pra Descrição ============
        // Tudo pede aprovação: o job só PROPÕE (aparece em Jobs → Revisar); nada grava antes de você tocar em Guardar/Aplicar.
        function refPartes(ref) {
            const k = String(ref || '').lastIndexOf(':');
            return k < 0 ? null : { convId: ref.slice(0, k), idx: +ref.slice(k + 1) };
        }
        // mensagens suas, de TODAS as conversas do Espaço, que ainda não passaram por um cartão nem por uma revisão em lote
        async function coletarMensagensAntigas() {
            const todas = [];
            for (const c of await obterEspacoChats()) {
                const h = await lerHistorico(c.id);
                const tratadas = new Set();
                h.forEach((m) =>
                    (m.acoes || []).forEach((a) => {
                        if (a && a.tipo === 'guardar' && a.estado !== 'recusada') tratadas.add(a.msgIdx);
                    })
                );
                h.forEach((m, i) => {
                    if (m.role !== 'user' || m.sistema || m.lidaLote || tratadas.has(i)) return;
                    if (String(m.content || '').trim().length < FICHA_TEXTO_MIN) return;
                    todas.push({ ref: refDaMensagem(c.id, i), texto: m.content, ts: m.ts || 0 });
                });
            }
            todas.sort((a, b) => a.ts - b.ts);
            return todas.slice(-LOTE_MSG_MAX);
        }
        async function alterarMensagens(refs, fn) {
            const porConv = new Map();
            (refs || []).forEach((r) => {
                const p = refPartes(r);
                if (p) porConv.set(p.convId, (porConv.get(p.convId) || []).concat([p.idx]));
            });
            let mudou = false;
            for (const [convId, idxs] of porConv) {
                const h = await lerHistorico(convId);
                let alt = false;
                idxs.forEach((i) => {
                    if (h[i] && h[i].role === 'user') {
                        fn(h[i]);
                        alt = true;
                    }
                });
                if (alt) {
                    await salvarHistorico(convId, h);
                    if (Esp.abertaId === convId) Esp.msgs = h;
                    mudou = true;
                }
            }
            return mudou;
        }
        function rodarOrganizar() {
            return criarJob({
                nome: 'Organizar o que já falei',
                tipo: 'organizar',
                tokens: 6000,
                rodar: async (job) => {
                    await bibCarregar();
                    await descCarregar();
                    const msgs = await coletarMensagensAntigas();
                    if (!msgs.length) return { aviso: 'Não achei mensagens suas no Espaço que ainda não tenham sido organizadas.' };
                    const todas = dividirLoteConversas(msgs);
                    const partes = todas.slice(-LOTE_PARTES_MAX);
                    const estado = estadoFichas();
                    await carregarItensFichas(estado);
                    const brutos = [];
                    let descartadas = 0;
                    let ruins = 0;
                    for (let p = 0; p < partes.length; p++) {
                        job.detalhe = 'parte ' + (p + 1) + ' de ' + partes.length;
                        refrescarUI();
                        const resp = await generate(promptOrganizarLote(estado, Desc.v, partes[p]), {
                            temperature: 0.2,
                            maxTokens: 3000,
                            timeoutMs: 120000,
                            signal: job.ctrl.signal,
                        });
                        const l = lerAnotacoesLote(resp, partes[p]);
                        brutos.push(...l.itens);
                        descartadas += l.descartadas;
                        if (l.formatoRuim) ruins++;
                    }
                    job.detalhe = '';
                    const val = validarAnotacoesLote(brutos, estado, limitesFichas());
                    const propostas = val
                        .filter((r) => r.ok)
                        .map((r, i) => ({
                            id: 'o' + i,
                            estado: 'pendente',
                            marcada: true,
                            g: r.g,
                            ref: r.ref,
                            fonte: r.fonte,
                            texto: r.g.texto,
                            pastaNome: r.plano.pasta.nome,
                            arquivoNome: r.plano.arquivo.titulo,
                            tipoFicha: r.plano.arquivo.tipo,
                            quando: r.plano.arquivo.quando,
                            aviso: r.plano.aviso,
                        }));
                    const recusadas = val.length - propostas.length + descartadas;
                    const refsLidas = partes.reduce((acc, p) => acc.concat(p.itens.map((i) => i.ref)), []);
                    const lidas = refsLidas.length;
                    const aviso =
                        'Li ' +
                        lidas +
                        ' mensagem(ns)' +
                        (todas.length > partes.length ? ' (as mais recentes; rode de novo pra ler as mais antigas depois de revisar)' : '') +
                        ' · ' +
                        propostas.length +
                        ' anotação(ões) pra você revisar' +
                        (recusadas ? ' · ' + recusadas + ' o código recusou (repetida, regra, limite ou formato)' : '') +
                        (ruins ? ' · ' + ruins + ' parte(s) a IA respondeu fora do formato' : '');
                    return { aviso, revisar: propostas.length ? { tipo: 'organizar', propostas, refsLidas } : null };
                },
            });
        }
        async function fichasParaArrumar() {
            await bibCarregar();
            const out = [];
            let n = 0;
            for (const a of fichasDoEspaco()) {
                let itens;
                try {
                    itens = lerItensOriginal((await Disco.arqLer(a.id, ['original'])).original);
                } catch (_) {
                    continue; // sem o original no disco não dá pra arrumar com segurança
                }
                n++;
                out.push({
                    key: 'F' + n,
                    id: a.id,
                    titulo: tituloArq(a),
                    pastaNome: (pastaInfo(a.meta.pastaId) || {}).nome || '',
                    origem: 'espaco',
                    tipo: (a.meta.ficha && a.meta.ficha.tipo) || 'apoio',
                    quando: (a.meta.ficha && a.meta.ficha.quando) || 'cena',
                    itens: itens.map((it, q) => ({ n: q + 1, id: it.id, texto: it.texto })),
                });
            }
            return out;
        }
        function rodarArrumar() {
            return criarJob({
                nome: 'Arrumar fichas',
                tipo: 'arrumar',
                tokens: 3000,
                rodar: async (job) => {
                    const fichas = await fichasParaArrumar();
                    if (fichas.length < 2) return { aviso: 'Preciso de pelo menos 2 fichas criadas pelo Espaço pra sugerir uma arrumação.' };
                    const resp = await generate(promptArrumar(fichas), { temperature: 0.2, maxTokens: 2000, timeoutMs: 120000, signal: job.ctrl.signal });
                    const plano = lerPlanoArrumar(resp);
                    if (!plano.ok) return { aviso: 'A IA respondeu fora do formato; nada a revisar. Tente de novo.' };
                    const v = validarPlanoArrumar(plano, fichas);
                    if (!v.props.length)
                        return { aviso: 'A IA não achou nada que valha juntar ou mover' + (v.descartadas.length ? ' (' + v.descartadas.length + ' sugestão(ões) o código recusou)' : '') + '.' };
                    return {
                        aviso: v.props.length + ' sugestão(ões) pra você revisar' + (v.descartadas.length ? ' · ' + v.descartadas.length + ' o código recusou' : ''),
                        revisar: { tipo: 'arrumar', propostas: v.props.map((p, i) => Object.assign({ id: 'r' + i, estado: 'pendente', marcada: false }, p)) },
                    };
                },
            });
        }
        // tira a ficha se ela ficou sem nada (só o título); some a pasta junto só se a Spade a criou e ela ficou vazia
        async function apagarFichaSeVazia(a) {
            const d = await Disco.arqLer(a.id, ['original']);
            if (!fichaVazia(d.original)) return false;
            const pastaId = a.meta.pastaId;
            await apagarArquivo(a);
            const pi = pastaInfo(pastaId);
            if (pi && pi.origem === 'espaco') await apagarPastaSeVazia(pastaId).catch(() => {}); // a ficha já saiu; pasta que não dá pra tirar fica
            return true;
        }
        // 'juntar' leva todos os itens da ficha "de" para a "para"; 'mover' leva um. Usa o mesmo Mover do cartão (confere se você editou o item).
        async function arrumarExecutar(p) {
            await bibCarregar();
            const A = Bib.arquivos.get(p.deId);
            const B = Bib.arquivos.get(p.paraId);
            if (!A || !B || A.meta.origem !== 'espaco' || B.meta.origem !== 'espaco') return { ok: false, motivo: 'uma das fichas mudou ou sumiu' };
            const dA = await Disco.arqLer(A.id, ['original']);
            let itens = lerItensOriginal(dA.original).filter((i) => i.id);
            if (p.tipo === 'mover') {
                const it = itens.find((i) => i.id === p.itemId);
                if (!it || fNorm(it.texto) !== fNorm(p.texto)) return { ok: false, motivo: 'o item mudou ou sumiu' };
                itens = [it];
            }
            const tags = (A.meta.tagsUsuario || []).slice();
            let movidos = 0;
            let repetidos = 0;
            let ficaram = 0;
            for (const it of itens) {
                const card = {
                    estado: 'feita',
                    onde: 'ficha',
                    arquivoId: A.id,
                    itemId: it.id,
                    texto: it.texto,
                    ref: it.ref,
                    tipoFicha: (A.meta.ficha && A.meta.ficha.tipo) || 'apoio',
                    quando: (A.meta.ficha && A.meta.ficha.quando) || 'cena',
                    tags,
                    tagsNovas: [],
                    criouArquivo: false,
                    criouPasta: false,
                    pastaId: A.meta.pastaId,
                };
                const r = await guardarMover(card, { arquivoId: B.id });
                if (r.ok) movidos++;
                else if (/já tem isso/.test(r.motivo || '')) {
                    // já existe igual na outra ficha: tira daqui (nada se perde, o texto continua lá)
                    const rm = await fichaRemoverItem(A, card);
                    if (rm.ok) repetidos++;
                    else ficaram++;
                } else ficaram++;
            }
            let apagada = false;
            if (p.tipo === 'juntar') apagada = await apagarFichaSeVazia(A);
            else await apagarFichaSeVazia(A);
            return { ok: movidos + repetidos > 0, movidos, repetidos, ficaram, apagada, motivo: movidos + repetidos > 0 ? '' : 'nenhum item pôde ser movido (você editou ou a outra ficha está cheia)' };
        }
        const revJob = () => Jobs.lista.find((j) => j.id === UI.revJobId);
        async function revisaoAplicar(job) {
            const rv = job.resultado && job.resultado.revisar;
            if (!rv) return;
            const marcadas = rv.propostas.filter((p) => p.estado === 'pendente' && p.marcada);
            if (!marcadas.length) return toast('Marque pelo menos uma.', true);
            let feitas = 0;
            let falhas = 0;
            let mexeuMsgs = false;
            if (rv.tipo === 'organizar') {
                await bibCarregar();
                const estado = estadoFichas();
                await carregarItensFichas(estado);
                for (const p of marcadas) {
                    try {
                        const c = await fichasExecutar(p.g, p.ref, estado, false);
                        if (c.estado === 'feita') {
                            p.estado = 'feita';
                            p.card = Object.assign({ tipo: 'guardar' }, c);
                            feitas++;
                            if (c.sempre && (await alterarMensagens([p.ref], (m) => (m.guardada = true)))) mexeuMsgs = true;
                        } else {
                            p.estado = 'recusada';
                            p.motivo = c.motivo;
                            falhas++;
                        }
                    } catch (e) {
                        p.estado = 'recusada';
                        p.motivo = 'deu erro: ' + (e && e.message);
                        falhas++;
                    }
                }
                // as mensagens que a IA leu não voltam na próxima rodada (as não marcadas ficam aqui na tela, ainda dá pra marcar)
                if (await alterarMensagens(rv.refsLidas, (m) => (m.lidaLote = true))) mexeuMsgs = true;
            } else {
                for (const p of marcadas) {
                    try {
                        const r = await arrumarExecutar(p);
                        p.estado = r.ok ? 'feita' : 'recusada';
                        p.motivo = r.motivo;
                        p.resumo = r.ok
                            ? r.movidos + ' item(ns) movido(s)' + (r.repetidos ? ', ' + r.repetidos + ' repetido(s) tirado(s)' : '') + (r.ficaram ? ', ' + r.ficaram + ' ficaram onde estavam' : '') + (r.apagada ? ', ficha vazia removida' : '')
                            : '';
                        r.ok ? feitas++ : falhas++;
                    } catch (e) {
                        p.estado = 'recusada';
                        p.motivo = 'deu erro: ' + (e && e.message);
                        falhas++;
                    }
                }
            }
            if (mexeuMsgs) {
                await espacoCarregarParaRp();
                sincronizarVolateis();
                sincronizarSoon();
            }
            toast(feitas + ' feita(s)' + (falhas ? ' · ' + falhas + ' recusada(s)' : '') + '.', falhas > 0 && !feitas);
            render();
        }
        async function revisaoDesfazer(job, id) {
            const rv = job.resultado && job.resultado.revisar;
            const p = rv && rv.propostas.find((x) => x.id === id);
            if (!p || p.estado !== 'feita' || !p.card) return;
            const r = await guardarDesfazer(p.card);
            if (!r.ok) return toast('Não deu pra desfazer: ' + r.motivo + '.', true);
            p.estado = 'desfeita';
            const outra = rv.propostas.some((x) => x !== p && x.estado === 'feita' && x.ref === p.ref && x.card && x.card.sempre);
            if (p.card.sempre && !outra && (await alterarMensagens([p.ref], (m) => delete m.guardada))) {
                await espacoCarregarParaRp();
                sincronizarVolateis();
            }
            sincronizarSoon();
            toast('Desfeito.');
            render();
        }
        function telaRevisar() {
            const job = revJob();
            const rv = job && job.resultado && job.resultado.revisar;
            const volta = '<button class="spd-btn" data-a="nav" data-t="jobs">Voltar a Jobs</button>';
            if (!rv) return { titulo: 'Revisão', corpo: '<div class="spd-tela"><div class="spd-vazio">Esta revisão não está mais aqui (os jobs só duram até a página recarregar).<br><br>' + volta + '</div></div>' };
            const org = rv.tipo === 'organizar';
            const pend = rv.propostas.filter((p) => p.estado === 'pendente');
            const marc = pend.filter((p) => p.marcada).length;
            const trecho = (t, n) => {
                const x = String(t || '').replace(/\s+/g, ' ').trim();
                return x.length > (n || 160) ? x.slice(0, n || 160) + '…' : x;
            };
            const linhas = rv.propostas
                .map((p) => {
                    let corpo;
                    if (org)
                        corpo =
                            '<div>“' + esc(trecho(p.texto)) + '”</div><div class="s">→ ' + esc(p.pastaNome) + ' › ' + esc(p.arquivoNome) + ' (' + (p.tipoFicha === 'funcionamento' ? 'funcionamento' : 'apoio') + ', ' + (p.quando === 'sempre' ? 'em toda fala' : 'só quando a cena pedir') + ')' + (p.aviso ? ' · ' + esc(p.aviso) : '') + '</div>' + (p.fonte ? '<div class="s">da sua mensagem: “' + esc(trecho(p.fonte, 110)) + '”</div>' : '');
                    else if (p.tipo === 'juntar')
                        corpo = '<div>Juntar <b>' + esc(p.deNome) + '</b> dentro de <b>' + esc(p.paraNome) + '</b> (' + p.n + ' item(ns))</div>' + (p.motivo ? '<div class="s">' + esc(p.motivo) + '</div>' : '');
                    else corpo = '<div>Mover “' + esc(trecho(p.texto)) + '”</div><div class="s">de <b>' + esc(p.deNome) + '</b> para <b>' + esc(p.paraNome) + '</b></div>' + (p.motivo ? '<div class="s">' + esc(p.motivo) + '</div>' : '');
                    const aviso = !org && p.muda ? '<div class="s" style="color:#e9b3b3">As duas fichas têm tipo/quando diferentes: o que for movido passa a valer como a ficha de destino.</div>' : '';
                    let st = '';
                    if (p.estado === 'pendente')
                        st = '<button class="spd-btn pq ' + (p.marcada ? 'prim' : '') + '" data-a="rev-marca" data-id="' + p.id + '">' + (p.marcada ? 'Marcada' : 'Marcar') + '</button>';
                    else if (p.estado === 'feita')
                        st = '<span class="s">Feito' + (p.resumo ? ': ' + esc(p.resumo) : '') + '</span>' + (org ? '<button class="spd-btn pq" data-a="rev-ver" data-id="' + p.id + '">Ver</button><button class="spd-btn pq" data-a="rev-desfazer" data-id="' + p.id + '">Desfazer</button>' : '');
                    else if (p.estado === 'desfeita') st = '<span class="s">Desfeito</span>';
                    else st = '<span class="s">Não fiz: ' + esc(p.motivo || 'não deu') + '</span>';
                    return '<div class="spd-job">' + corpo + aviso + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px">' + st + '</div></div>';
                })
                .join('');
            return {
                titulo: org ? 'Organizar o que já falei' : 'Arrumar fichas',
                corpo:
                    '<div class="spd-tela"><p class="sub">' +
                    (org
                        ? 'A IA leu suas conversas antigas e propõe estas anotações. Nada foi gravado: marque o que quiser e toque em Guardar.'
                        : 'A IA propõe estas arrumações. Nada foi mexido: marque o que quiser e toque em Aplicar. Os itens são movidos, não apagados.') +
                    '</p><div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0">' +
                    (pend.length ? '<button class="spd-btn prim" data-a="rev-aplicar">' + (org ? 'Guardar' : 'Aplicar') + ' as marcadas (' + marc + ')</button><button class="spd-btn" data-a="rev-todas">Marcar todas</button><button class="spd-btn" data-a="rev-nenhuma">Desmarcar todas</button>' : '') +
                    volta +
                    '</div>' +
                    linhas +
                    '</div>',
            };
        }
        // Passar pra Descrição: a Spade NUNCA escreve lá; ela só deixa o texto copiado e abre a tela pra você colar
        function modalCopiar(titulo, intro, texto, aoAbrir) {
            const j = UI.raiz.querySelector('.spd-janela');
            const m = document.createElement('div');
            m.className = 'spd-modal';
            m.innerHTML =
                '<div><p style="font-weight:600;font-size:17px;color:#fff">' + esc(titulo) + '</p><p class="sub" style="margin:8px 0 12px">' + esc(intro) + '</p><textarea rows="5" readonly data-cp="t" style="width:100%">' + esc(texto) + '</textarea><div class="bt" style="margin-top:16px"><button class="spd-btn" data-x="c">Fechar</button><button class="spd-btn" data-x="cp">Copiar</button><button class="spd-btn prim" data-x="ab">Copiar e abrir a Descrição</button></div></div>';
            const copiar = async () => {
                try {
                    await navigator.clipboard.writeText(texto);
                    toast('Copiado.');
                } catch (_) {
                    const t = m.querySelector('[data-cp="t"]');
                    t.focus();
                    t.select();
                    toast('Selecionei o texto: copie manualmente.', true);
                }
            };
            m.addEventListener('click', async (e) => {
                const b = e.target.closest('[data-x]');
                if (e.target === m || (b && b.dataset.x === 'c')) return m.remove();
                if (!b) return;
                if (b.dataset.x === 'cp') await copiar();
                if (b.dataset.x === 'ab') {
                    await copiar();
                    m.remove();
                    aoAbrir();
                }
            });
            j.appendChild(m);
        }

        function cartaoGuardarHtml(a, i, k) {
            const previa = (t) => {
                const x = String(t || '')
                    .replace(/\s+/g, ' ')
                    .trim();
                return x.length > 140 ? x.slice(0, 140) + '…' : x;
            };
            const caixa = (cls, icone, corpo, botoes) =>
                '<div class="spd-acao ' + cls + '">' + ic(icone, 14) + '<div class="spd-acao-c">' + corpo + '</div>' + (botoes || '') + '</div>';
            const bt = (acao, rot) =>
                '<button class="spd-acao-b" data-a="' + acao + '" data-i="' + i + '" data-k="' + k + '">' + rot + '</button>';
            const onde =
                a.onde === 'memoria'
                    ? 'Memória do RP'
                    : esc(a.pastaNome || '') + ' › ' + esc(a.arquivoNome || '');
            if (a.estado === 'recusada')
                return caixa('off', 'ban', 'Não guardei: ' + esc(a.motivo || 'não deu'));
            if (a.estado === 'ignorada') return caixa('off', 'x', 'Você não quis guardar' + (a.texto ? ': “' + esc(previa(a.texto)) + '”' : ''));
            if (a.estado === 'desfeita')
                return caixa('off', 'x', '<b>Guardado em <i>' + onde + '</i> — desfeito</b>');
            const trecho = a.texto ? '<div class="spd-acao-t">“' + esc(previa(a.texto)) + '”</div>' : '';
            const aviso = a.aviso ? '<div class="spd-acao-t">' + esc(a.aviso) + '</div>' : '';
            if (a.estado === 'pendente')
                return caixa(
                    '',
                    'spark',
                    '<b>Guardar em <i>' + onde + '</i>?</b>' + trecho + aviso,
                    '<div class="spd-acao-bs">' + bt('guardar-confirmar', 'Guardar') + bt('guardar-ignorar', 'Ignorar') + '</div>'
                );
            const modo =
                a.onde === 'memoria'
                    ? ''
                    : ' (' + (a.tipoFicha === 'funcionamento' ? 'funcionamento' : 'apoio') + ', ' + (a.quando === 'sempre' ? 'entra em toda fala' : 'só quando a cena pedir') + ')';
            return caixa(
                '',
                'check',
                '<b>' +
                    (a.criouArquivo && a.onde === 'ficha' ? 'Criei o arquivo <i>' + esc(a.arquivoNome) + '</i> e guardei em ' : 'Guardei em ') +
                    '<i>' +
                    onde +
                    '</i>' +
                    modo +
                    '</b>' +
                    trecho +
                    aviso,
                '<div class="spd-acao-bs">' +
                    bt('guardar-desfazer', 'Desfazer') +
                    (a.onde === 'ficha' ? bt('guardar-mover', 'Mover') : '') +
                    bt('guardar-ver', 'Ver') +
                    (a.onde === 'ficha' ? bt('guardar-desc', 'Passar pra Descrição') : '') +
                    (a.longa ? bt('guardar-resumir', 'Resumir esta ficha') : '') +
                    '</div>'
            );
        }
        function fichasCardHtml() {
            const n = fichasDoEspaco().length;
            const lig = organizaModo() !== 'desligado';
            return (
                '<div class="spd-rel"><div class="spd-rel-topo"><div><small>' +
                esc(nomePadraoFichas()) +
                ' · ' +
                n +
                (n === 1 ? ' arquivo criado' : ' arquivos criados') +
                ' pelo Espaço</small><b>' +
                (lig ? 'organizando sozinha' : 'desligado') +
                '</b></div><div class="spd-rel-bt"><button class="spd-btn" data-a="fichas-ver">Abrir</button><button class="spd-btn ' +
                (lig ? '' : 'prim') +
                '" data-a="fichas-toggle">' +
                (lig ? 'Desligar' : 'Ligar') +
                '</button></div></div><div class="sub" style="margin-top:10px">Você só fala no Espaço; a IA decide se guarda e onde, e mostra um cartão com Desfazer, Mover e Ver. Ajustes em Configurações → Espaço dinâmico.</div>' +
                '<div class="spd-rel-bt" style="margin-top:12px;flex-wrap:wrap"><button class="spd-btn" data-a="fichas-organizar">Organizar o que já falei</button><button class="spd-btn" data-a="fichas-arrumar">Arrumar fichas</button></div></div>'
            );
        }

        iniciar().catch(reportFatalError);
    } catch (e) {
        reportFatalError(e);
    }
})();
