## v7.2.0 — ITEM 1: linguagem visual do Artefatos aplicada no resto

Pedido: em vez de escopo novo/print de referência, seguir a linguagem
visual que já existia no painel de Artefatos (raio 10px, fundo #12122c,
borda #22224a, hover próprio, badges tipo pill) e aplicar no que ainda
usava o layout mais antigo.

- **Sistemas**: `.axis-system-item` trocou o card antigo (raio 6px, sem
  hover, cores mais escuras) pela família visual do `.axis-artefato-card`.
  O subheader "Sistemas reais (código): Exportar/Importar", que era tudo
  inline style em index.js, virou `.axis-sistemas-subheader` de verdade.
- **Config**: reescrito de label-gigante-fazendo-duas-coisas pra
  label curto + texto de ajuda separado embaixo (`.axis-config-label` +
  `.axis-config-help`), agrupado em duas seções ("Modelos" e
  "Comportamento") com o mesmo estilo de título de seção que os Tools já
  usavam (`.axis-tool-section`, reaproveitado como `.axis-config-section-
  titulo`). Inputs full-width, raio 8px, borda #22224a.
- **Barra de abas** (Espaço/Pensamento/Sistemas/Config): texto inativo
  saiu do cinza apagado (#888) pro tom já usado no badge de Artefatos
  (#a0a0c0), padding um pouco maior.
- **Bolhas do Espaço**: raio subiu de 8px pra 10px, só pra bater exato
  com o raio das bolhas da Sala de Pensamento (que já eram 10px).
- Não mexi nas bolhas de chat em si (Espaço/Pensamento) além do raio —
  bolha de conversa não é card (não tem borda nem é clicável), então
  copiar a borda do Artefato ali seria inconsistente com a própria
  linguagem do Claude.ai, não o contrário.

---

## v7.1.0 — ITEM 3 (cards colapsáveis) + ITEM 5 (auditoria de linguagem prescritiva)

**Item 3 — card "N passos ⌄" na Sala de Pensamento:**
- `passadaComFerramentas` agora junta os tool calls de uma mesma iteração
  numa lista (`passosIteracao`: nome, ok/erro, resuminho do retorno via
  `resumoResultado()`) e entrega isso pra um novo callback `onPasso`, além
  do `onNarracao` que já existia (esse continua igual, narrando ANTES da
  ação — o card de passos vem DEPOIS, resumindo o que rodou).
- `journalAdicionar` aceita um 4º parâmetro opcional `passos`; quando
  presente, a entrada carrega isso e `renderJournalEm` desenha um
  `<details>`/`<summary>` nativo — "N passos" com chevron, expande pra ver
  cada ferramenta chamada com ✅/❌ e o resuminho. Zero JS de toggle, só CSS
  (`.axis-passos` no style.css, mesma paleta da bolha).
- Aplicado na Sala de Pensamento (`pensarUmaVez`) e na Construtora
  (`passoConstrutora`, que antes soltava 1 bolha por tool call — agora
  agrupa tudo num card só). Não mexi no Espaço — ele tem chat próprio,
  fora do escopo que o próximos-passos.md pedia.

**Item 5 — auditoria de "tirar quase todos os comandos":** passada pelos
prompts em `systemPrompt =` (Construtora, Espaço, Pensamento, curadoria).
A Pensamento já tinha sido bem trabalhada numa sessão anterior ("a decisão
é sua, não existe mais número fixo de rodadas") e a curadoria
(`extrairLote`/`mesclarEmArtefato`) é spec de tarefa pontual, não prompt
de agência — deixei como tava. Reescrito de verdade:
- Construtora: "só publique depois de testar" virou explicação de por que
  vale testar antes (o erro é real, não vai ter quem revise depois) em vez
  de regra; "sempre leia antes de mexer" virou explicação do mecanismo
  (`extensao_editar_arquivo` reescreve o arquivo INTEIRO, o que não vier
  junto some — por isso ler ajuda, não é regra externa); "avise isso
  sempre" virou "vale avisar, senão o usuário espera efeito e não vê".
- Espaço: "chame artefato_ler nele antes (nunca perder o que já tinha)"
  virou "ler antes evita perder o que já tinha" — mesma ideia, sem o tom
  de ordem.

---

## v7.0.3 — Artefato só via Espaço, nunca sozinha durante o RP

Pedido: a Sala de Pensamento (loop autônomo) tinha instrução pra notar
padrões do usuário durante o RP e guardar isso sozinha num Artefato
(categoria "usuario", via `artefato_escrever`) — sem upload, sem pedido
do usuário. Tirado.

- `passadaComFerramentas` agora aceita `opts.excluirTools` (lista de
  nomes) e filtra a lista de ferramentas que vai pro modelo naquela
  passada — antes Espaço e Pensamento recebiam a mesma lista `TOOLS`
  inteira, sem distinção nenhuma entre os dois contextos.
- A chamada da Sala de Pensamento agora passa
  `excluirTools: ['artefato_escrever', 'artefato_apagar']` — ela ainda
  pode LER/buscar/listar Artefato pra ter contexto, mas não cria/edita/
  apaga nenhum sozinha.
- O parágrafo do prompt que mandava ela guardar padrão do usuário num
  Artefato foi reescrito: agora ela pode notar o padrão e anotar isso
  nos PRÓPRIOS pensamentos (journal), mas Artefato explicitamente não é
  "coisa dela" ali.
- Espaço (`respondEspaco`) não mudou — continua com acesso total,
  inclusive `artefato_escrever/apagar`, porque é exatamente ali (upload
  ou pedido direto) que Artefato deve nascer.

---

## v7.0.2 — fix: nenhum Artefato era criado (403 silencioso) + modelo da Ingestão

**Causa raiz real do "artefato nunca é extraído de verdade":** `chamarSpadeFs`
(a função que fala com o plugin `spade-fs` — listar/ler/escrever/apagar
Artefato, e também ler/editar o próprio código da extensão) não mandava o
header de CSRF que o servidor do SillyTavern exige em TODA rota `/api/*`.
Toda chamada — inclusive `/documento/escrever`, chamada no fim da
ingestão — voltava 403, e o try/catch de quem chamava engolia isso em
silêncio (`console.warn`, nunca aparecia pro usuário). É por isso que
`artefato_listar` deu 403 pra você E nenhum Artefato apareceu depois do
upload: a extração podia até estar rodando, mas salvar sempre falhava.
Corrigido usando `ctx().getRequestHeaders()` (a função oficial do ST) em
todas as chamadas ao plugin.

**Modelo da Ingestão trocado de `modeloRapido` (flash) pro `modeloEscritor`**
nas duas etapas que decidem/escrevem o conteúdo real do Artefato
(`extrairLote` — o que vale guardar — e `mesclarEmArtefato` — a prosa
final do documento). Motivo: são as duas etapas que definem se o
Artefato existe e a qualidade dele — não é tarefa mecânica tipo
classificação/rerank, que continuam no flash. `contextualizarFato` (só
reescreve 1 frase pra tirar pronome solto) ficou no flash de propósito.

---

## v7.0.1 — fix: upload no Espaço não enviava

Erro real de uso (primeiro teste num SillyTavern de verdade, como esse
documento já avisava que faltava): `handleUploadEspaco` chamava uma
função `ingerirComVisual` que só existia citada num comentário — nunca
foi escrita. Resultado: qualquer anexo no 📎 do Espaço estourava
`ingerirComVisual is not defined` e nada era enviado.

Corrigido escrevendo `ingerirComVisual` de verdade: ela chama a
`ingerirArquivos` que já existia e traduz o `onProgresso` dela em
entradas no journal da Sala de Pensamento (autor `'ingestao'` — a badge
"📎 Ingestão" já existia em `renderJournalEm`, só nunca era alimentada).
De brinde, o upload agora aparece passo a passo na Sala de Pensamento
em vez de ficar mudo até terminar.

---

# Spade v7.0 — Biblioteca e Tom saíram, entraram os Artefatos

Essa é a maior mudança até agora — mexeu em praticamente toda a espinha
de memória/RAG da extensão. Vale ler inteiro antes de usar.

## O que mudou, resumo

**Biblioteca (aba de fatos soltos) e Tom (mini-chat de treino) foram
retirados.** No lugar entrou um sistema único: **Artefatos** — documentos
de referência (tom de voz, lore, regra de mundo, o que fizer sentido),
mostrados tipo Claude.ai: botão "N Artefatos" no header do Espaço abre
uma lista de cards, clicar num card mostra o conteúdo inteiro. A IA cria
e edita sozinha (`artefato_escrever`, sem comando) — o humano só vê e,
se quiser, apaga.

**Sistemas e Fundição não foram tocados** — como combinado, continuam do
jeito que estavam, com suas próprias abas e storage.

## Por trás dos panos — por que foi mais rápido do que parecia

Descoberta importante no meio do caminho: o "Documento" (o antigo Tom já
generalizado) **já sincronizava com a busca usada no RP de verdade**
(`sincronizarDocumentoNaBiblioteca`, de uma sessão anterior) — cada
documento vira chunks embedados na mesma Biblioteca que alimenta
`buscarVoz`/`buscarMemoria`. Isso significa que o motor de busca (MMR,
híbrido cosseno+BM25, rerank) **não precisou ser tocado** — só parei de
alimentar ele com fatos soltos e passei a alimentar só com Artefatos.
Isso é literalmente "o novo RAG" que você pediu: mesma qualidade de
busca, fonte diferente (documento organizado, não fragmento solto).

## O que foi retirado de vez

- Todas as tools `biblioteca_*` (escrever/editar/apagar/buscar/listar/
  ler_documento/editar_documento) e `consolidar_memoria`.
- A captura automática de `evento_cru` a cada rodada de RP, e todo o
  mecanismo de "consolidação/sono" (fato/sentimento/evento) — dependia
  do modelo antigo, não fazia mais sentido sem ele.
- As entradas antigas da Biblioteca — **descartadas**, como você pediu
  ("começa do zero"). Não tentei migrar nada.
- Aba Tom (mini-chat dedicado + folha lado a lado) e aba Biblioteca
  (lista/filtro/arquivar). O upload de arquivo agora só existe no 📎 do
  Espaço — era 3 pontos de upload fazendo praticamente a mesma coisa.

## O que mudou por baixo (pipeline de Ingestão)

Upload de arquivo → extração de fatos → **em vez de virar entrada solta
na Biblioteca, os fatos são agrupados por categoria e mesclados num
Artefato** (a IA reescreve o documento inteiro incorporando o que for
novo, mesma categoria acumula no mesmo artefato entre uploads
diferentes). O arquivo original também vira um Artefato próprio
(categoria "documento"), sempre — é a rede de segurança que já existia,
só que agora visível/editável no painel em vez de chunk invisível.

## Coisas que ficaram mais simples de propósito

- O dedupe por cosseno fato-a-fato (que existia pra decidir "isso é
  duplicata ou atualização?") saiu — agora quem decide o que entra é a
  reescrita do documento inteiro pela IA, não um score. Mais caro (1
  chamada de LLM a mais por categoria por upload), mas mais coerente com
  "prosa organizada" em vez de "pilha de fragmentos".
- `biblioteca_compartilhar` (marcar que um NPC específico sabe de algo)
  não tem equivalente em nível de artefato — essa granularidade fina se
  perdeu. Se isso for importante, me avisa que dá pra pensar em algo.
- Dentro do objeto `Biblioteca` no código, sobraram alguns métodos não
  usados por ninguém agora (`definirAtivo`, etc.) — não removi, são
  inofensivos, mas se quiser uma limpeza de código puramente estética
  depois, é rápido.

## Estado dos testes

Sintaxe do JS validada (`node --check`) e chaves do CSS balanceadas
(221/221) depois de cada bloco de mudança — não fiz tudo de uma vez sem
checar. Revisei manualmente cada ponto de acoplamento (tools, dispatcher,
prompts do Espaço e da Sala de Pensamento, wiring de eventos do painel).
**Não rodei isso dentro de um SillyTavern de verdade** — é a mudança mais
arriscada até agora, então o teste real no seu Termux importa mais que
nunca dessa vez. Se algo quebrar, me manda o erro exato (console do
navegador, F12) que eu conserto rápido.

## O que NÃO entrou ainda (pedido original, ainda pendente)

- **UI geral da extensão "bem parecida com Claude.ai"** — fiz o painel de
  Artefatos nesse estilo, mas o resto (Espaço, Pensamento, Sistemas,
  Config) ainda não passou por esse redesenho completo.
- Botão-pílula + animação tipo cards colapsáveis.
- Auto commit+push pro GitHub.
- Auditoria de "tirar quase todos os comandos".

Qual desses é o próximo?
