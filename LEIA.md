## v7.3.0 — "ajuste na hora" virou geral, não só de fala

Usuário foi direto: as v7.2.0-v7.2.2 erraram o alvo inteiro, não só o
enquadramento do texto. A ideia nunca foi "categoria tom tem tratamento
especial" — é "qualquer ajuste que o usuário pedir, sobre qualquer
coisa, vale na hora, porque Espaço e RP são uma IA só, não dois chats
precisando de ponte". Categoria era um detalhe incidental do primeiro
exemplo que ele deu (tom de voz); eu especializei o mecanismo inteiro em
cima desse detalhe em vez de generalizar.

Removido: qualquer menção a `categoria === 'tom'` como caso especial —
tom voltou a ser uma categoria comum, buscável por similaridade como
lore/regra_mundo/o-que-for.

Adicionado: campo `sempreIncluir` (boolean) no `artefato_escrever` —
ortogonal à categoria, disponível pra qualquer artefato. Marcado assim,
o conteúdo entra inteiro em toda cena do RP, sem depender de busca, sem
prazo pra expirar. Prompt do Espaço reescrito pra tratar isso como
mecanismo geral: fala, comportamento, relação, regra de mundo, plot —
qualquer coisa que seja "pedido direto, vale já" usa a flag, não só tom.
`compiledTomFixoBlock` virou `compiledAjustesFixosBlock` (filtra por
`sempreIncluir`, não por categoria); `spade-fs` ganhou o campo no
frontmatter (`/documento/escrever` grava, `/documento/listar` devolve).

Mantido: o enquadramento imperativo e o reminder no final do prompt da
v7.2.2 (isso ainda vale, só não é mais exclusivo de tom) — e o aviso pra
escrever regra checável em vez de adjetivo solto quando o ajuste for
sobre ritmo de fala.

**Teste**: `node --check` limpo nos dois arquivos (extensão + spade-fs).
Não testado num SillyTavern de verdade.

---

## v7.2.2 — regra de tom fraca demais, reforçada

Usuário reportou: pediu no Espaço pra personagem falar menos/mais
dinâmica, artefato de tom foi escrito, mas o RP continuou verboso —
o mecanismo da v7.2.1 (inclusão fixa) tava funcionando tecnicamente,
mas fraco demais pra vencer a tendência do modelo de escrever bastante.
Três reforços, sem mexer na arquitetura de novo:

1. Enquadramento do bloco de tom virou imperativo — de "[TOM DE VOZ —
   como ela fala]" pra "[REGRA DE FALA OBRIGATÓRIA — siga à risca... isso
   pesa mais que hábito antigo ou o que pareceria natural pra ela]".
2. Reminder curto no FINAL do prompt (posição de mais peso, mais perto
   de onde a geração começa) apontando de volta pra regra — antes só
   existia lá no topo, competindo com biblioteca/estado/sistemas/tarefas
   até chegar na hora de responder de verdade.
3. Instrução do Espaço explica a diferença entre regra checável ("no
   máximo N frases") e adjetivo solto ("mais dinâmica") — pediu pra
   escrever a primeira quando o ajuste for sobre ritmo/tamanho, porque
   regra concreta muda comportamento e elogio vago não.

Também aproveitou pra reforçar o "responda curto, direto" que já existia
por padrão (agora com "se ficar em dúvida entre longo e curto, escolha o
curto"), pra ajudar mesmo sem artefato de tom nenhum.

**Teste**: `node --check` limpo. Não testado num SillyTavern de
verdade — isso especificamente só um teste real confirma se resolveu ou
se o modelo ainda ignora.

---

## v7.2.1 — corrigindo dois erros de entendimento da v7.2.0

O usuário corrigiu direto: a v7.2.0 errou em duas partes.

**Tom não é diretiva temporária, é inclusão fixa.** A v7.2.0 tratou
ajuste de tom como uma "diretiva" separada — escrever categoria tom
disparava um estado à parte (`diretivaTom:chatId`) que forçava inclusão
por 15 turnos e depois expirava, o conteúdo voltando a competir por
ranking normal feito qualquer outra memória. Isso tratava Espaço e RP
como dois sistemas que precisam de ponte — não é o que foi pedido. O
usuário foi claro: "é literalmente ele, não dois chats, é um só". Tirei
o mecanismo de diretiva inteiro (sem timer, sem estado guardado à parte)
e troquei por inclusão direta e permanente: `compiledTomFixoBlock` lê o
artefato de tom (ou os artefatos, se houver mais de um) direto do
`spade-fs` a cada turno do RP e inclui o conteúdo inteiro, sempre — sem
prazo, sem competir com nada, sem precisar vencer busca nenhuma. `tom`
saiu do `buscarVoz` do RP (não faz mais sentido buscar por ranking algo
que já entra garantido de outro jeito).

**Artefatos não precisavam de botão de baixar.** Tirei os botões de
baixar por item e o "Baixar tudo" do cabeçalho que a v7.2.0 acrescentou
sem ter sido pedido — o redesign visual (ícone maior, cartão mais
limpo) ficou, só o download saiu.

**Teste**: `node --check` limpo, CSS balanceado. Mesma ressalva de
sempre — não rodei num SillyTavern de verdade.

---

## v7.2.0 — ajuste de tom imediato, memória por chat, Artefatos redesenhados

Três pedidos numa sessão só:

**1. Ajuste de tom com efeito imediato ("1:1").** Antes, escrever um
Artefato categoria "tom" só fazia efeito se ele vencesse o ranking do
`buscarVoz` (top 3 por similaridade) — podia demorar a aparecer, ou nunca
aparecer. Agora, todo artefato "tom" dispara uma diretiva que força esse
conteúdo a entrar garantido nos próximos 15 turnos do RP
(`compiledDiretivaTomBlock`, injetado no topo do prompt em
`buildSystemPrompt`), sem depender de busca nenhuma. Fluxo pretendido:
usuário fala no Espaço "ela tá falando desse jeito, fala mais assim" →
Spade chama `artefato_escrever` categoria tom na hora → já vale a partir
da próxima fala do RP. O conteúdo continua existindo como Artefato normal
depois que a diretiva expira, só perde a prioridade garantida.

**2. Memória por chat.** Artefatos agora têm dois escopos: `chat`
(padrão — só essa conversa enxerga) e `personagem` (compartilhado com
toda conversa desse personagem, pra tom/traço central). Mudança em duas
pontas:
- Cliente: `Biblioteca.escrever/listar/buscarVoz/buscarMemoria` ganharam
  `chatId`; listar faz união (chat específico + personagem inteiro,
  nunca exclusivo) — nada que já existia (tudo tem `chatId` implícito
  `null`) deixou de aparecer em lugar nenhum.
- Servidor (`spade-fs`): pasta nova `_chats/<chatId>/` dentro da pasta do
  personagem; as 4 rotas de `/documento/*` aceitam `chatId` opcional.
  `ler`/`apagar` tentam o escopo do chat primeiro e caem pro personagem
  inteiro se não achar — 100% retrocompatível, sem migração.
- `chatId` usado em todo lugar é `stChatIdAtual()` (o chat de verdade do
  SillyTavern), não o chatId interno do Espaço — memória segue a
  história, não a aba de conversa com o Spade sobre ela.
- Prompt do Espaço reescrito: busca proativa (`artefato_buscar`) quando o
  usuário citar algo, em vez de só abrir o painel ou dizer "não tenho
  acesso" — isso já devia funcionar antes (a tool existia), só não tava
  instruído com força suficiente.

**3. Artefatos redesenhados** — referência: foto que o usuário mandou
mostrando o padrão "lista de arquivo" do Claude.ai. Ícone virou uma
caixinha com efeito de pasta/documento (antes só um emoji solto), botão
de baixar por item (`.md` com o conteúdo) e "Baixar tudo" no cabeçalho do
painel (baixa tudo concatenado num arquivo só). Continua com editar/ler/
apagar de antes, e a IA continua com o mesmo acesso.

**De brinde:** limpei os dois achados de código morto que vinham sendo
registrados desde a v7.1.1 — caso `onde === 'tom'` no ticker de status
(impossível desde que Treino saiu) e o CSS órfão `#axis-status-pill`
(nunca foi chamado por nada no JS).

**Teste**: `node --check` limpo nos dois arquivos (extensão + spade-fs),
chaves do CSS balanceadas. **Não rodei num SillyTavern de verdade** — e
dessa vez a ressalva pesa mais que o normal: o escopo por chat mexe numa
peça central (onde a memória mora), e não dá pra validar só lendo código
se o merge personagem+chat se comporta como esperado num RP de verdade.
Testar isso é prioridade zero antes de emendar mais coisa em cima.

---

## v7.1.1 — Sistemas, Sistemas Reais e Config viram cards de verdade

Pedido: item pendente desde a v7.0.0 — a paleta cinza/neutra (v7.1.0)
cobriu a extensão inteira, mas era só troca de cor: Sistemas e Config
continuavam em lista/form simples, sem o padrão de card (ícone, hover,
clicável) que Artefatos já tinha. Pílula/ticker e auto commit+push pro
GitHub foram descartados nessa sessão a pedido explícito — não são mais
escopo.

- **Sistemas**: cada item virou um card no estilo `axis-artefato-card`
  (ícone ⚡/💤 conforme ativo, header compacto com nome + gatilho
  "quando"). A explicação completa (`então`) não fica mais sempre
  visível — o card é clicável e expande/colapsa, mesmo padrão de
  interação que abrir um Artefato.
- **Sistemas Reais**: mesmo tratamento visual (ícone 🟢/⚪), e de
  brinde ficou clicável pra expandir e mostrar o código publicado
  (`s.codigo`) — antes esse código só existia no JSON de export, nunca
  aparecia na UI.
- **Config**: os campos soltos (9 no total) foram agrupados em 3 cards
  de seção — 🔑 Conexão, 🧠 Modelos, ⏱ Ritmo do loop — em vez de um
  form único despejando tudo junto. IDs dos inputs e o handler de
  salvar não mudaram, só o agrupamento visual.
- CSS: reaproveitado o mesmo raio de borda (10px) e cor de borda
  (`#333333`) do card de Artefato pra ficar consistente; nenhuma classe
  nova ficou órfã (removi uma que criei e não acabei usando).

**Teste**: `node --check` limpo e chaves do CSS balanceadas (231/231).
Não rodei num SillyTavern de verdade ainda — mesma ressalva de sempre.

---

## v7.0.4 — auditoria de "tirar quase todos os comandos"

Pedido original (primeira mensagem desta conversa): reduzir instrução
prescritiva rígida em favor do julgamento dela. Revisei os 4 prompts de
sistema que regem comportamento autônomo (RP, Construtora, Sala de
Pensamento, Espaço) linha por linha procurando "sempre faça X"/"chame Y
antes de Z" que não fossem necessidade técnica real.

**Resultado honesto: achei só UM caso genuíno.** No Espaço, ela era
instruída a chamar `redirecionar_artefatos` (abrir o painel) TODA vez
que escrevia um artefato, sem julgamento — virou "se fizer sentido o
usuário ver na hora, chame; ajuste pequeno/rotina, só diz o que fez".

O resto que parecia comando rígido, ao olhar de perto, é necessidade
técnica ou limite de identidade, não "comando" no sentido que o pedido
original mirava — e removê-los pioraria a extensão, não deixaria ela
"mais livre":
- Construtora: testar antes de publicar sistema real, ler antes de
  editar código da extensão, avisar que precisa recarregar a página
  depois de editar — são fatos sobre como o sistema funciona, não
  preferência de estilo.
- Sala de Pensamento: não criar/apagar Artefato sozinha durante o RP —
  decisão deliberada da v7.0.3 (ver abaixo), não sobrou de versão antiga.
- Espaço: nunca falar na voz da personagem, nunca perder conteúdo ao
  reescrever um artefato — limite de identidade e prevenção de perda de
  dado, não rigidez arbitrária.

Se o pedido original mirava algo mais específico que não apareceu numa
leitura linha-a-linha dos prompts, me diz o caso concreto (ela travou
em quê, pediu permissão pra quê) que eu vou direto nele.

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

## Estado real do que ficou pendente (lista abaixo estava desatualizada)

Essa seção ficou parada desde a v7.0.0 e não acompanhou o que foi
resolvido nas versões seguintes — corrigindo:

- **Auditoria de comandos**: CONCLUÍDA na v7.0.4 (ver acima).
- **UI geral tipo Claude.ai**: a paleta cinza/neutra já cobre a extensão
  inteira desde a v7.1.0 (mesmos 140 seletores de CSS, só recoloridos —
  não é só o painel de Artefatos). Sistemas e Sistemas Reais viraram
  cards de verdade na v7.1.1 (ver acima), Config também. Espaço e
  Pensamento continuam com o layout estrutural de antes (só a cor
  mudou) — se "tipo Claude.ai" pra você envolve mexer na estrutura
  deles também, isso ainda não entrou.
- **Botão-pílula + cards colapsáveis nas ações da IA** e **auto
  commit+push pro GitHub**: descartados a pedido explícito do usuário
  — não são mais escopo desse projeto, não retomar sem pedido novo.
