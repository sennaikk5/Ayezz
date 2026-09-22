## v7.19.0 — a print confirmou: isso é regenerate/swipe nativo, não o pipeline da Spade

Print mostrando "Thought for 10 seconds ⌄" é a prova: esse widget é UI
NATIVA do próprio SillyTavern (`extra.reasoning`, documentado em
docs.sillytavern.app/usage/prompts/reasoning) — só aparece quando o
PRÓPRIO SillyTavern (não a Spade) detecta e separa reasoning_content.
Spade nunca escreve em `extra.reasoning`. Ou seja: essa mensagem
especifica saiu do caminho nativo (regenerate/swipe — `if (type) return`
no `Spade_interceptGeneration`, documentado desde antes), não do
pipeline próprio, onde o filtro `<think>` da v7.18.0 nem chega a rodar.

**Por que não fui atrás de interceptar regenerate/swipe de vez**: pra
fazer isso direito eu precisaria saber exatamente como o SillyTavern
reorganiza `chat`/`swipes` nesse momento (o último item deixa de ser a
mensagem do usuário — vira a MENSAGEM DO PERSONAGEM sendo trocada), e
escrever de volta *no lugar certo* do jeito que swipe espera, sem editar
por índice às cegas. Sem acesso pra testar isso ao vivo, o risco
real é trocar "às vezes vaza" por "regenerate quebra" — pior, não
melhor. Fica registrado como avaliado e adiado por essa razão específica,
não esquecido.

**O que dá pra fazer com segurança, e fiz**: 4º slot na mesma rede
nativa (`setExtensionPrompt`) que já cobre Espaço/ajustes/repetição —
`SPADE_ANTI_VAZAMENTO`, instrução curta e direta ("responda só como
[nome], nunca narre raciocínio, nunca mostre planejamento") que agora
alcança regenerate/swipe também. Isso ajuda a PARTE influenciável por
prompt (o modelo escolher escrever em estilo "pensando alto" dentro do
content de verdade) — não ajuda a parte que não é (se o backend manda
reasoning_content separado, isso é decisão da API, prompt não muda
isso).

**Ação sua que ajuda mais que qualquer prompt**, direto da documentação
oficial do SillyTavern sobre reasoning: se o modelo configurado é
raciocinador, o "Max Response Length" nativo do ST (painel AI Response
Configuration — diferente do max_tokens que a Spade usa nas próprias
chamadas) geralmente precisa ficar bem mais alto pra reasoning models —
"1024 a 4096", não o padrão baixo. Se estiver baixo, o raciocínio come o
budget inteiro ANTES da resposta de verdade — o que bate exatamente com
"às vezes vem só o pensamento".

**Teste**: `node --check` limpo. Não testado ao vivo.

---

## v7.18.0 — a causa provável de verdade: raciocínio (<think>) nunca filtrado

Reformulação do problema depois do relato "vaza MUITO, às vezes vem só o
pensamento, às vezes parece responder a mensagem anterior": revisei os
fixes da v7.16/17 nos canais (Espaço↔RP) de novo, mas achei uma causa bem
mais direta e que explica os DOIS sintomas com um só mecanismo — nenhuma
das 3 funções de geração (`generate`, `generateWithTools`,
`generateStream`) nunca filtrou `<think>...</think>`. Se o modelo
configurado (via NanoGPT) for um modelo "raciocinador" que emite isso
misturado em `content` (em vez de um campo separado), o código sempre
tratou aquilo como texto de verdade.

Isso explica os dois sintomas com UMA causa, não duas:
- **"Vem o pensamento em vez da resposta"**: se o `max_tokens` (1200 na
  fala do RP) estoura ENQUANTO ainda tá dentro do `<think>`, a resposta
  de verdade nunca chega a ser gerada — o que sobra pra mostrar é só
  raciocínio truncado.
- **"Parece responder a mensagem anterior"**: um bloco de raciocínio
  tipicamente COMEÇA reanalisando o histórico da conversa ("o usuário
  disse X, antes tinha dito Y...") — é exatamente isso que lê como "presa
  numa mensagem antiga", só que é o raciocínio sobre o contexto, não uma
  resposta de verdade fora de ordem.

**Fix**: `filtrarThinking()` (string inteira, pros dois modos sem
streaming) e `criarFiltroThinking()` (stateful, streaming — lida com a
tag cortada no meio entre chunks) cortam `<think>...</think>` fechado OU
aberto-até-o-fim (truncado pelo limite). Aplicado dentro das 3 funções de
geração — cobre RP, Espaço, Pensamento, Construtora, extração de
Ingestão e o classificador de ajuste automático de uma vez, sem precisar
mexer em cada chamada. Em `generateStream` especificamente: se sobrou
bastante conteúdo cru do provider mas nada depois do filtro, agora
lança erro (em vez de devolver vazio) pra cair no retry que já existia —
antes esse caso era tratado como "resposta vazia genuína" e NÃO tentava
de novo.

**Isso não invalida os fixes da v7.16/17** (regenerate sem repetição,
técnica de Espaço mais segura, cadeia de exemplo de diálogo) — continuam
válidos e ativos. É uma causa adicional, mais fundamental, que pode ter
sido a fatia maior do sintoma reportado.

**Se o modelo configurado for reasoning e ele consistentemente gastar o
budget inteiro pensando**: o retry ajuda (tentativa nova, mesma
temperatura, pode não pensar tanto de novo), mas não é garantia — nesse
caso o ajuste real é aumentar `max_tokens` ou trocar de modelo pra RP.
Não fiz isso automaticamente porque não sei qual modelo você tem
configurado nem se você quer pagar por mais tokens.

**Teste**: `node --check` limpo. Não testado ao vivo.

---

## v7.17.0 — escopo mais largo: técnica de "IA uma só" v2 + cadeia de 3 bugs no exemplo de diálogo

Resposta direta a "fez só uma parte, era pra fazer tudo": voltei e ataquei
o que ficou de fora da v7.16.0 — não só reverti a técnica de turno, tentei
uma versão melhor; e o "exemplo de diálogo não funciona" tinha mais duas
causas além da que já tinha achado, achadas indo até o fim da cadeia
Ingestão→Artefato→Biblioteca, não só o primeiro ponto que quebrava.

**1) "IA uma só" — tentativa nova, não só a v7.15.0 de volta.** A
v7.14.0/15.0 injetava TURNOS "assistant" falsos (o motivo do vazamento —
papel lido pelo tom, não pela tag). `notaEspacoParaTurno` faz diferente:
gruda uma nota OOC curta na FRENTE do turno "user" de verdade — ganha o
mesmo peso de "perto do ponto de gerar" que a ideia original buscava, mas
nunca finge ser a personagem falando (é sempre nota do sistema sobre o
turno do usuário). Só a ÚLTIMA troca, só se de verdade recente (20min,
mesmo critério de antes).

**2 e 3) Exemplo de diálogo — a cadeia INTEIRA reescrevia a citação, não só a busca.**
Encontrado achando o rastro completo, ponta a ponta: mesmo depois de
corrigir a busca (v7.16.0), a extração de arquivo (`extrairLote`) reescreve
todo fato "de forma objetiva", e a fusão (`mesclarEmArtefato`) reescreve o
artefato inteiro "em prosa organizada" — as duas destroem uma citação
literal, que é o valor INTEIRO de um exemplo de fala. Três pontos, uma
correção cada:
- `extrairLote`: instrução nova — fala/diálogo vira citação literal no
  campo "fato", não fato reescrito.
- `contextualizarFato`: pula a reescrita inteira pra categoria de
  fala/tom/dialogo (retorna a citação intocada).
- `mesclarEmArtefato`: categoria de fala vira lista deduplicada de
  citações exatas, sem passar por LLM nenhum — nunca mais "prosa
  organizada" pra isso.
Atualizei também a descrição da tool `artefato_escrever` (que antes dizia
literalmente "prosa, não lista seca" sem exceção — instruindo errado pra
esse caso específico).

**Não mexido de novo**: os 4 prompts já auditados (v7.0.4), pílula/cards/
auto-push (descartados). Ainda sem acesso a testar num SillyTavern de
verdade — 3 dos 4 fixes de dialogo são supressão de reescrita (bem menos
risco que reescrita nova), o de nota-no-turno é o mais novo dessa leva.

---

## v7.16.0 — 4 bugs reais reportados ao vivo (primeiro uso de verdade)

Primeiro feedback de uso real (não syntax check): regenerate repetindo
fala, ajuste do Espaço vazando na fala do RP, tom não mudando com
ajuste, exemplo de diálogo do RAG não funcionando. Fui atrás da causa de
cada um em vez de só reagir ao sintoma.

**1) RAG de exemplo de diálogo — causa achada.** `buscarVoz` só procura
`tipo==='fala'/'tom'`, hardcoded. Categoria de artefato é livre desde
v7.x (boa ideia) — mas "exemplo_dialogo" (sugerida no próprio schema da
tool `artefato_escrever`!) nunca batia com isso, então nunca entrava no
slot reservado de voz, só competia solto contra lore no ranking geral.
`sincronizarDocumentoNaBiblioteca` agora mapeia categoria que contém
"fala/tom/voz/dialog" pro tipo certo. Vale pra artefato escrito no
Espaço e pra arquivo subido (mesmo caminho de escrita).

**2) Vazamento do ajuste na fala do RP — revertido.** `turnosEspacoRecentes`
(v7.14.0–7.15.0, nunca testado ao vivo até agora) injetava as últimas
trocas do Espaço como turnos user/assistant de verdade, coladas bem
antes da fala nova. Pesquisei antes de mexer: achei um paper recente
("Prompt Injection as Role Confusion") mostrando que o modelo infere
role pelo TOM do texto, não pela tag — um "turno assistant" com
conteúdo tipo "[...] vou ficar mais fria" logo antes de gerar a próxima
fala é convite a ecoar aquilo, não só absorver a intenção. Removida a
função inteira (ficava duplicada com `compiledEspacoRecenteBlock`, o
bloco de texto mais seguro que já existia e continua). Reforcei também a
instrução final do prompt contra citar/repetir esses blocos.

**3) Regenerate repete a mesma fala — causa achada.**
`Spade_interceptGeneration` pula de propósito quando `type` vem
preenchido (regenerate/swipe é nativo do ST, decisão antiga já
documentada) — só que isso significa que `compiledRepeticaoBlock`
("evite repetir"), que só rodava dentro do pipeline próprio da Spade,
nunca chegava no regenerate nativo. Novo `sincronizarRepeticaoNativo()`
empurra esse bloco pelo `setExtensionPrompt` (mesmo mecanismo nativo já
usado pra Espaço/ajustes fixos), atualizado a cada
`CHARACTER_MESSAGE_RENDERED` — cobre regenerate/swipe agora, não só a
geração normal.

**4) Tom não muda com ajuste — mitigado.** O classificador que reescreve
a Direção de Atuação inteira a cada ajuste tinha instrução vaga
("incorporando + reescrita por inteiro"), o que convida a resumir/perder
especificidade a cada rodada. Reforcei: mantém regra específica que já
existia, acrescenta a nova com o MESMO nível de detalhe concreto que foi
pedida.

**Teste**: `node --check` limpo. Ainda não testado ao vivo — são
mudanças pequenas e cirúrgicas em cima de causa raiz identificada, não
reescrita especulativa, mas o único teste real é você usando.

---

## v7.15.0 — bridge Espaço→RP com recência de verdade; SistemasReais deixou de ser básico

Duas coisas pedidas na mesma mensagem: continuar melhorando a técnica de
turno (v7.14.0) e fazer os sistemas de código de verdade serem "muito
mais avançados", com pesquisa de verdade antes de construir (não só
inventando).

**1) `turnosEspacoRecentes` ganhou recência de verdade.** Revisei a
v7.14.0 e achei uma lacuna real: a função nunca checava HÁ QUANTO TEMPO
a última troca do Espaço aconteceu — uma conversa de ontem entraria como
`[Fora da cena, com você mesma agora há pouco]` do mesmo jeito que uma de
30 segundos atrás. Isso é literalmente falso, e o ponto inteiro da
técnica de turno é que o modelo trata aquilo como "acabou de acontecer
nessa mesma conversa" — uma "lembrança" falsa dessas tem mais chance de
confundir do que ajudar. Corrigido: as 4 gravações de `espacoHistory`
(usuário e resposta, caminho normal e caminho de upload) agora carregam
`ts: Date.now()`, e `turnosEspacoRecentes` só injeta se a ÚLTIMA
mensagem tiver menos de 20 minutos — histórico de antes dessa versão
(sem `ts`) é tratado como velho de propósito, prefere excluir a incluir
errado por falta de dado. Não mexi na lógica de alternância/fallback que
já existia, só adicionei o filtro antes dela.

**2) SistemasReais — pesquisei antes de construir.** O SDK anterior
tinha só UM hookAlvo de verdade (`antesDeGerar`) e nenhuma forma de um
sistema reaproveitar outro — cada um era uma ilha. Fui ver como agentes
de LLM que criam/reusam suas próprias ferramentas fazem isso de verdade
(Voyager — skill library composicional, recuperação antes de escrever
código novo; padrões de "code agent" chamando outras tools already
registradas em vez de duplicar lógica) antes de desenhar isso, não só
inventei em cima da cabeça. Três mudanças reais, SDK_VERSAO 1→2 (contrato
mudou de verdade, invalida aprendizado antigo automaticamente):

- **`sdk.sistemas.chamar(familia, input)`** — composição de verdade: um
  sistema ATIVO pode chamar outro sistema ATIVO e usar o resultado.
  Orquestrado no thread principal (não Worker-dentro-de-Worker, mais
  simples e sem risco de deadlock). Guarda-corpos reais, não cosméticos:
  profundidade máxima 2 (A chama B chama C ok, A chama B chama A não
  roda), sem auto-chamada da própria família, cada nível usa metade do
  teto de tempo do anterior (pior caso previsível, não N× o teto cheio).
- **Segundo hookAlvo real: `antesDePensar`** — até agora só o RP
  alimentava sistema real (`sceneText`); a Sala de Pensamento nunca
  alcançava nenhum. Agora todo `pensarUmaVez` também roda os sistemas
  ativos mirando `antesDePensar`, com `{ultimosPensamentos, cenaRecente}`
  — dá pra fazer sistema que reage ao que ela ANDOU PENSANDO sozinha, não
  só à cena. Generalizei `avaliarSistemasReais` → `avaliarSistemasReaisHook`
  pra servir os dois hooks sem duplicar a mesma lógica de
  `Promise.allSettled`/filtro duas vezes.
- **`sistema_real_buscar_similar`** — busca semântica nos sistemas JÁ
  PUBLICADOS por descrição, antes de escrever um novo do zero. Não é
  estrutura nova: cada publicação indexa um resumo na MESMA Biblioteca
  (busca híbrida já testada) que o resto da extensão usa, tipo
  `sistema_real_indice`, mesmo padrão que `aprendizado_sistema` já usava.
  É o "skill library" do Voyager reaproveitando infraestrutura que já
  existia, não uma segunda estrutura de busca.

Dei acesso à Construtora (`sistema_real_buscar_similar` entrou em
`TOOLS_CONSTRUTORA_NOMES`) e documentei tudo isso no `SDK_DOC_BLOCK` com
exemplo de composição. **Não toquei** na fraseologia já auditada dos 4
prompts de sistema (v7.0.4) — testar antes de publicar, ler antes de
editar, etc. continuam exatamente como estavam, porque aquela sessão já
concluiu (com razão) que isso é necessidade técnica, não comando
arbitrário; só adicionei parágrafo novo descrevendo a capacidade nova, no
mesmo tom.

**Pílula/cards colapsáveis/auto-push GitHub**: não retomei — nota no
topo do LEIA.md (agora abaixo) foi respeitada.

**Teste**: `node --check` limpo depois de cada bloco. **Não testado num
SillyTavern de verdade** — `sdk.sistemas.chamar` é a peça mais nova e
mais arriscada dessa leva (Worker chamando Worker orquestrado por fora,
nunca escrito antes nessa extensão); se `sistema_real_testar` reclamar de
algo relacionado a composição, me manda o erro exato que eu vou direto
nele.

---

## v7.14.0 — técnica diferente de verdade: Espaço entra como TURNO, não só texto no prompt

Usuário pediu explicitamente uma técnica DIFERENTE pra "IA uma só", não
mais um ajuste incremental do que já existia. Revisei a v7.12.0/v7.13.0
primeiro (conferido no código, não só no relato): apagar mensagem no
Espaço, categoria livre de verdade no classificador automático (virou
`sincronizarAjusteAutomatico`, um call só classificando entre direção/
sistema/fato-com-categoria-livre/nenhuma, mais esperto que o meu desenho
original de 2 documentos fixos) e a consciência simétrica de Direção de
Atuação — tudo isso confere com o código, é sólido.

**A técnica nova**: até aqui, tudo que o Espaço "sabe" sobre a cena e tudo
que o RP "sabe" sobre o Espaço chega como TEXTO DENTRO DO SYSTEM PROMPT —
funciona, mas ainda compete por atenção com o resto de um prompt grande.
O canal mais forte que um modelo de chat tem pra dar peso a alguma coisa
não é o que tá escrito num bloco de instrução — é o que foi dito nos
TURNOS de verdade da conversa (user/assistant alternando). É basicamente
a diferença entre "aqui tem uma nota sobre o que ele pediu" e "ele
literalmente acabou de dizer isso pra mim".

`turnosEspacoRecentes` pega a(s) última(s) troca(s) do Espaço e insere
ELAS MESMAS como mensagens de verdade no array que vai pro modelo, logo
antes da fala nova do RP — não como um resumo, como conversa de verdade
que acabou de acontecer. Aditivo, não troca o bloco de texto que já
existia (compiledEspacoRecenteBlock) — os dois juntos, reforço em vez de
substituição, então se um canal falhar o outro ainda segura. Cuidado
técnico: sempre garante alternância user/assistant limpa antes de inserir
(corta pontas soltas) — uma bagunça aqui quebraria justo a fala que mais
importa, a próxima.

Não mexi na direção contrária (RP→Espaço) — lá a cena já entra como
contexto explicativo faz mais sentido que virar turno de conversa
(misturar fala de cena RP na conversa "como você mesma" do Espaço
confundiria o personagem que ela É com o personagem que ela ATUA).
Simetria onde faz sentido, não simetria por regra.

**Sobre "1 array só" — mantenho a análise da v7.13.0**: não é modéstia,
já é a segunda vez que confirmo por código (ctx().chat renderizado pela
UI nativa, chat_agir por índice, regenerate/swipe/export assumindo só
RP) que misturar os dois históricos de verdade quebra o SillyTavern por
baixo. Essa técnica nova é o que dá pra fazer sem esse custo.

**Teste**: `node --check` limpo. Não testado ao vivo — é a peça mais
nova e mais experimental dessa leva. Se ela ainda ignorar um pedido
direto tipo "231 no topo" mesmo com isso, me manda a resposta que ela
deu; isso separa "os dois canais falharam" de "ela ignorou os dois de
propósito", que são bugs bem diferentes de caçar.

---

## v7.13.0 — analisei o merge literal de verdade; não é o alvo certo, fiz o que É seguro e vale

Usuário respondeu "Faça." ao desenho da v7.12.0 sobre RP e Espaço virarem
UM streaming de mensagens só, em vez de dois históricos com ponte.

**Análise de verdade, não só "é arriscado"**: RP e Espaço NÃO podem virar
o mesmo array de mensagens sem quebrar o SillyTavern por baixo — não é
questão de risco alto, é questão de incompatibilidade real:
- `ctx().chat` é renderizado pela UI NATIVA do ST — misturar mensagem do
  Espaço lá dentro faria ela aparecer como se a personagem tivesse
  "falado" aquilo, ou bagunçar a lista de mensagens visível pro usuário.
- `chat_agir` edita/apaga por ÍNDICE da cena — índice pressupõe que só
  tem fala de RP ali; misturar Espaço no meio desalinha todo índice já
  em uso (e qualquer coisa que dependa dele).
- Regenerate/swipe, exportar chat, branching, contagem de token — tudo
  isso do ST nativo assume que `ctx().chat` é só diálogo de RP de
  verdade. O arquivo de chat em si (o que o usuário pode abrir fora da
  extensão, compartilhar, etc.) ficaria poluído com conversa de
  assistente que não é RP nenhum.

Não é "não tentei" — é que o alvo (\"UM array só\") tentaria consertar uma
coisa que já funciona (a ponte) trocando por outra que quebra um monte
de coisa que também já funciona (o SillyTavern nativo). Trade ruim.

**O que É seguro e realmente fecha uma lacuna real**: reparei que a
ponte era ASSIMÉTRICA — o RP já recebia Direção de Atuação automática
(v7.10.0) e conversa recente do Espaço (v7.4.0+), mas o Espaço só recebia
a cena crua do RP, sem saber a Direção de Atuação EM VIGOR agora — teria
que chamar direcao_ler pra descobrir algo que deveria já saber de cara.
Corrigido: `respondEspaco` agora já entra sabendo a direção atual, igual
o RP já sabia. Os dois lados ficam com consciência equivalente um do
outro, não só um lado enxergando o outro.

**Teste**: `node --check` limpo. Pergunta no Espaço "o que você tá
seguindo de direção agora" sem ela precisar chamar tool nenhuma — deve
responder direto, já sabendo.

---

## v7.12.0 — apagar mensagem no Espaço, categoria livre (não mais caixinha fixa)

Usuário pediu 3 coisas: categorização menos "separada em caixinha", apagar
mensagem (sua ou da IA) no Espaço, e insistiu de novo no "IA uma só" —
"até hoje ninguém conseguiu, não é impossível, tenta".

**Apagar mensagem no Espaço** — cada bolha (sua ou da Spade) agora tem um
✕ pequeno (sempre visível, mais forte no hover/toque — não escondia atrás
de hover puro, que não funciona bem em touch). Apaga da lista em memória
E do histórico persistido, pelos dois em paralelo — sincroniza a rede
nativa (setExtensionPrompt) depois, pra não deixar uma versão antiga da
conversa pairando lá se a mensagem apagada era relevante pra isso. Achei
de quebra um desalinhamento real: o log em memória (espacoLocalLog) não
tinha teto, mas o persistido tinha `.slice(-80)` — numa conversa bem
longa os dois saíam de índice diferente, o que quebraria a lógica de
apagar por índice. Corrigido: o mesmo teto de 80 agora também no log em
memória, sempre que renderiza.

**Categoria menos "caixinha"** — o "fato" do classificador automático
(v7.11.0) listava categoria como enum (traço_personalidade | sentimento |
relacionamento | ...), o que lia como taxonomia fixa mesmo sendo string
livre por baixo. Agora o prompt pede escolha livre e curta de verdade,
convida a inventar uma mais específica em vez de forçar numa das
básicas — mesmo espírito que a Ingestão de arquivo já usava.

**Sobre "IA uma só", de novo**: não é modéstia falsa, é honestidade
técnica — hoje Espaço e RP são DUAS conversas (dois arrays de mensagem)
que ficam sincronizadas via ponte (inclusão direta + rede nativa +
classificador automático), não literalmente UM streaming de mensagens só.
Funcionalmente já entrega o que foi pedido (fala no Espaço, vale na
próxima do RP, sem cerimônia) — mas ARQUITETURALMENTE ainda são duas
estruturas de dado ligadas, não uma única. Dá pra ir além disso — fazer
o RP e o Espaço literalmente compartilharem o MESMO histórico de
mensagens em vez de dois históricos sincronizados — mas isso é reescrever
como o chat inteiro é guardado e lido, não mais uma ponte incremental:
risco bem maior, e webshifta como o histórico de RP já existente (meses
de conversa) seria migrado. Vale a pena decidir isso explicitamente, não
enfiar escondido num patch — se for essa a direção, topo desenhar como
ficaria antes de mexer em código.

**Teste**: `node --check` limpo, CSS 239/239. Apaga uma mensagem no
Espaço, confere que sumiu depois de fechar/abrir o painel (persistiu de
verdade, não só visual).

---

## v7.11.1 — fix: retry cego batia mais forte no bloqueio de credencial

Usuário mandou print: NanoGPT bloqueou o cliente por 740s com
"rate limited after repeated invalid credentials". Achado real no meio
da investigação, não só orientação de configurar chave: `comRetentativas`
(usada por TODA chamada de IA na extensão — RP, Espaço, Pensamento,
Construtora, Ingestão, e agora também o classificador automático da
v7.11.0) retentava QUALQUER erro 3x, sem distinguir "rede falhou, tenta
de novo" de "credencial inválida, tentar de novo só piora". Erro de auth
é o oposto de transitório — bater com a mesma chave errada 3x por
chamada, em várias chamadas paralelas (a v7.11.0 dobrou esse número por
mensagem do Espaço), é exatamente o padrão que fez o provider bloquear.

Corrigido: `comRetentativas` agora reconhece erro de autenticação
(401/403/429 do NanoGPT com "auth"/"credential" na mensagem) e desiste
na hora, sem as 2 tentativas extras. Não resolve a causa (chave inválida
continua inválida até o usuário corrigir no Config) — só para de piorar
o bloqueio sozinha.

**Teste**: `node --check` limpo.

---

## v7.11.0 — o automático virou 3 destinos, e arquivo+instrução num envio só

Usuário pediu pra ir além da direção de atuação: a IA devia ser "mais
inteligente" mexendo em sistemas e no resto também, E poder mandar
arquivo + mensagem juntos num envio só, a mensagem guiando como o
arquivo é processado.

**Automático generalizado (era só direção, agora 3 destinos)** —
`sincronizarAjusteAutomatico` substitui `sincronizarDirecaoAutomatico`:
uma classificação só (JSON, não texto solto) decide entre:
- **direção** — regra geral de como atua sempre → mesmo caminho de antes
  (`direcao-de-atuacao`, sempreIncluir, nativo).
- **sistema** — regra CONDICIONAL, só vale quando algo aparece na cena
  (`Sistemas.criar` direto — nome curto, gatilho, ação).
- **fato** — personalidade/sentimento/relacionamento/preferência/lore →
  `mesclarEmArtefato` na categoria certa (mesma função que a Ingestão de
  arquivo já usa, reaproveitada aqui pra texto batido no Espaço).
- **nenhuma** — só conversa/pergunta/ação direta. Na dúvida entre dois
  tipos, cai aqui de propósito: falso negativo é recuperável, falso
  positivo (virou sistema errado, ou artefato com fato mal-entendido) é
  mais chato de desfazer.

Prompt do Espaço atualizado: ela sabe que os três rodam automático agora,
não só direção — não precisa se cobrar por nenhum dos três, só chama a
tool direto quando quiser precisão/reescrita que o automático poderia
não pegar.

**Arquivo + instrução num envio só** — antes, escolher arquivo disparava
upload na hora, sem chance de escrever o que fazer com ele. Agora:
escolher arquivo só anexa (chip visível acima do campo de texto, com X
pra remover), o usuário escreve o que quiser, e só ENVIAR dispara os
dois juntos. O texto vira `instrucaoUsuario`, passado através de
`ingerirArquivo`→`extrairLote`/`mesclarEmArtefato` — literalmente entra
no prompt de extração e de merge, pesando mais que uma leitura genérica
do arquivo. Múltiplos arquivos podem ser anexados antes de mandar.

**Teste**: `node --check` limpo, chaves do CSS batendo (236/236). Peça
algo condicional ("se ela mencionar X, lembra de Y") no Espaço sem chamar
tool nenhuma — devia aparecer `[ajuste automático] sistema "..." criado`
no diagnóstico. Anexa um arquivo, escreve uma instrução, manda os dois
juntos — o resultado devia refletir o que foi pedido, não só um resumo
genérico do arquivo.

---

## v7.10.0 — direção de atuação atualiza sozinha, sem depender da IA chamar a tool

Usuário: a v7.9.0 melhorou mas "não o bastante" — pediu explicitamente pra
elevar o nível de "IA uma só" de verdade, não mais um ajuste de texto.

**O elo fraco que sobrava**: mesmo com UMA decisão só (fato vs direção) e
a ferramenta certa pronta (`direcao_definir`), o mecanismo inteiro ainda
dependia da Espaço RECONHECER que o pedido era direção de atuação E
CHAMAR a tool. Se ela respondesse só conversacionalmente sem chamar (o
mesmo tipo de deriva já visto antes — responder ao invés de agir), nada
era escrito. Isso não é mais bug de entrega nem de prompt fraco — é
estrutural: enquanto a atualização depender de julgamento da conversa,
ela pode falhar em julgar.

**O que mudou**: a atualização deixou de depender da Espaço decidir
qualquer coisa. `sincronizarDirecaoAutomatico` roda por CÓDIGO, sempre,
toda mensagem que o usuário manda no Espaço — em paralelo com a resposta
normal (não atrasa nem compete). Um classificador rápido (mesmo modelo
usado em outras sínteses do pipeline) olha só a mensagem nova + a direção
já definida, decide se é sobre COMO o personagem atua (não fato/lore), e
se for, já reescreve o documento inteiro sozinho — sem a Espaço precisar
chamar nada. Se não for esse tipo de pedido, devolve `SEMMUDANCA` e não
escreve nada (barato, idempotente).

`direcao_definir` continua existindo — a Espaço ainda pode chamar direto
pra reescrever do zero ou fazer ajuste fino que o automático poderia não
pegar bem. O prompt dela agora deixa isso explícito: o automático é rede,
não substituição, e ela não precisa se cobrar quanto a isso.

**Ainda com a mesma honestidade da v7.9.0**: isso não é "zero mecanismo"
— trocou UM ponto de falha (julgamento da conversa) por outro menor
(classificador de código, que pode errar categorização, mas não "esquece
de agir" do jeito que uma resposta conversacional esquece). É a peça que
faltava pra fechar o gap entre "ela falou que ia funcionar" e "funcionou
de verdade", não uma garantia absoluta nova.

**Teste**: `node --check` limpo. Peça um ajuste de ritmo/tom no Espaço —
mesmo sem a IA mencionar que vai guardar nada, deve aparecer uma linha
`[direção automática]` na aba Pensamento, e `direcao-de-atuacao.md` no
servidor deve refletir a mudança.

---

## v7.9.0 — menos decisão pra ela, ferramenta dedicada, log também na rede nativa

Usuário relatou não ter achado a linha de diagnóstico da v7.8.0, e que a
IA já consegue melhorar a atuação, mas só "guardando em artefato" — não
do jeito natural que ele queria. Pediu limpeza: menos decisão/prompt
interno, não mais.

**Achado no log**: `compiledEspacoRecenteBlock`/`compiledAjustesFixosBlock`
(onde o log de diagnóstico vivia) só rodam quando a Spade intercepta a
geração de verdade — por decisão de projeto, ela PULA regenerate/swipe
(`if (type) return`), e a rede de segurança nativa (`setExtensionPrompt`)
cobre esses casos SEM logar nada. Se o teste foi feito por regenerate, ou
o usuário olhou antes da run seguinte, não tinha o que achar. Log agora
também em `sincronizarEspacoComNativo` (roda sempre, em toda sincronização
— app abrindo, trocando de chat, mandando mensagem no Espaço), etiquetado
`[rede nativa]` pra não confundir com os outros dois.

**A raiz do "artefato, não natural"**: o prompt do Espaço pedia pra ela
decidir 3 coisas toda vez que o usuário pedia um ajuste — é fato ou é
direção de atuação? flag sempreIncluir ou não? escopo chat ou personagem?
— com um parágrafo enorme de avisos repetidos pra ela não inventar plano
B. Muita decisão nova o tempo todo é o oposto de "natural"; um humano não
delibera sobre isso, só resolve. Reduzido a duas ferramentas dedicadas:

- `direcao_ler` / `direcao_definir(texto)` — UM documento só, escopo e
  sempreIncluir já fixos por dentro (ela nunca decide isso), substitui o
  texto inteiro (não lista incremental). É a resposta única pra "fala
  menos", "slowburn", "não avança sem eu levar a cena" — qualquer regra de
  COMO ela atua daqui pra frente.
- `artefato_escrever` continua existindo pra fato/lore, exatamente como
  antes.

O parágrafo de instrução caiu de ~28 linhas com avisos repetidos pra ~19
diretas — a ferramenta dedicada faz o trabalho que antes dependia de
prompt insistindo pra ela não fugir do caminho certo.

**O que isso NÃO resolve, com honestidade**: "IA una" no sentido literal
de zero mecanismo por baixo não existe — todo modelo de linguagem só age
via contexto (o que entra no prompt) ou ferramenta (o que ela chama). O
que dá pra melhorar, e foi o alvo real aqui, é ter MENOS decisão exposta
pra ela errar e MENOS chance de inventar um plano que não existe — não
fazer o mecanismo sumir, que é impossível.

**Teste**: `node --check` limpo. Depois de pedir um ajuste no Espaço,
`sincronizarEspacoComNativo` já loga na hora (não precisa nem esperar o
RP gerar) — se AINDA ASSIM não aparecer nada em Pensamento com a tag
`[rede nativa]`, o problema é a extensão não ter recarregado de verdade,
não mais o mecanismo em si.

---

## v7.8.0 — consolidação de duas linhagens + sempreIncluir ligado de ponta a ponta

Esse pacote (v7.7.0) veio de uma sessão diferente da que vinha corrigindo
bug de verdade nas últimas rodadas — trouxe coisas boas que a outra não
tinha (entrega redundante via `setExtensionPrompt` nativo do ST, log de
diagnóstico em toda tentativa de incluir a conversa do Espaço), mas não
tinha os 4 bugs de atividade/vínculo já achados e corrigidos antes. As
duas linhagens nunca se cruzaram. Portados aqui, sem mudar a abordagem
nova que já existia:

1. `garantirEspacoChatEscreve` valida contra o `stChatId` real na hora de
   escrever (não confia cegamente em `espacoChatStPendente`, que podia
   nunca ter sido populada).
2. `resolverEspacoChatAtivo`/`textoEspacoRecente` só caem pro "Espaço mais
   recente" quando NEM SABEMOS o chat atual — sabendo e não batendo,
   admite que não achou em vez de arriscar pegar a conversa errada.
3. `wireRpPresence` não aborta mais nada ao digitar na caixa do RP —
   virou aviso leve (`usuarioDigitandoRp`) só pro Pensamento não começar
   algo novo; só `comecarAtividade` de verdade (enviar, não só digitar)
   troca de atividade. Isso sozinho explicava pedidos que só "iam" depois
   de parar de digitar.
4. `liberarAtividadeRp` (usado em GENERATION_STOPPED/ENDED, pra destravar
   regenerate/swipe) agora é guardado por token — sem isso, corria risco
   de destravar no meio de uma geração de verdade da própria Spade, não
   só nas órfãs.
5. `lastCharMessageIdx` resincroniza em CHARACTER_MESSAGE_RENDERED —
   "editar minha última fala" não erra mais o alvo depois de um
   regenerate/swipe nativo.

**Principal desta rodada — ajuste vago (slowburn, fala dinâmica) não
pegava**: o servidor (`spade-fs`) já sabia persistir um campo chamado
`sempreIncluir` desde muito antes (`/documento/escrever` grava,
`/documento/listar` devolve) — ninguém nunca tinha ligado isso do lado da
extensão. Diferente de `compiledEspacoRecenteBlock` (janela de conversa
que rola e some) e diferente de artefato normal (entra por busca por
similaridade, compete por espaço, e "seja mais dinâmica" não tem
palavra-chave forte pra vencer essa competição):

- `artefato_escrever` ganhou o parâmetro `sempreIncluir` (boolean).
  Marcado, o conteúdo entra INTEIRO em toda cena do RP, sem depender de
  busca, sem prazo — igual `compiledEspacoRecenteBlock`, só que durável.
- Nova função `compiledAjustesFixosBlock`/`textoAjustesFixos`, com o
  mesmo log de diagnóstico que `compiledEspacoRecenteBlock` já tinha.
  Entra em `buildSystemPrompt` na mesma posição de alta ênfase (final do
  prompt), com reforço próprio.
- Mesma rede de segurança nativa (`setExtensionPrompt`, chave separada
  `SPADE_AJUSTES_FIXOS`) — cobre regenerate/swipe também.
- Prompt do Espaço ensinado a diferenciar: fato/lore → artefato normal;
  direção de atuação (ritmo, quanto fala, slowburn, "não avança sem eu
  levar a cena") → `sempreIncluir: true`. Escrever o artefato já continua
  sendo suficiente — sem "vou ficar de olho"/"reforço depois".

**Teste**: `node --check` limpo. Não testado num SillyTavern de verdade.
Diagnóstico ajuda MUITO aqui: depois de pedir um ajuste de ritmo, olha a
aba Pensamento — deve aparecer uma linha `[ajustes fixos→RP]` dizendo se
achou e incluiu, ou por que não. Se não aparecer nenhuma linha nem essa
nem `[espaço→RP]`, o problema não é mais esse mecanismo — é outra coisa,
e agora dá pra saber qual sem adivinhar.

---

## v7.3.1 — repetição nomeada como caso explícito na regra checável

Usuário voltou no "um só" com o exemplo mais concreto possível: pedir no
Espaço pra ela parar de repetir fala e ver isso valer na próxima resposta
do RP. Revisei o mecanismo inteiro de ponta a ponta antes de mexer em
qualquer coisa — não é código novo, é auditoria:

- `compiledAjustesFixosBlock` lê `sempreIncluir` certo, injeta no prompt
  do RP em toda rodada, sem prazo — confirmado lendo o código.
- `spade-fs` (v4) persiste e devolve `sempreIncluir` no frontmatter
  corretamente — testei o round-trip escrever→listar na leitura do código.
- `chatId` usado pra escrever o ajuste (Espaço) e pra ler o ajuste (RP) é
  o MESMO em todo lugar (`stChatIdAtual()`, chamado direto, sem cache) —
  não tem risco de dessincronia entre os dois lados.
- `getRecentSceneText`/`chatRealRecente` já leem `ctx().chat` direto (fix
  de uma sessão anterior) — o Espaço enxerga a cena de verdade, não uma
  cópia que pode estar desatualizada.

Toda essa espinha já tava certa. O que faltava era um detalhe de
instrução: a orientação de "escreva regra checável, não adjetivo vago"
só dava exemplo pra ritmo/tamanho de fala ("fala menos" → "no máximo N
frases") — repetição não tinha exemplo equivalente, e "evite repetição"
sozinho é tão vago quanto "seja mais dinâmica" era antes da v7.2.2 (o
mesmo tipo de instrução fraca que já foi diagnosticado e corrigido uma
vez, só que pra outro caso). Adicionei orientação específica: quando o
ajuste for sobre repetição, ela deve olhar as últimas falas da conversa
atual (já tem acesso — `cena` no prompt do Espaço) e nomear O QUE
especificamente repete (abertura de frase, forma de reagir a um tipo de
cena, um maneirismo) em vez de escrever "varie mais" sem alvo.

**Teste**: `node --check` limpo. Não testado num SillyTavern de
verdade — a auditoria da espinha (chatId, persistência, leitura de cena)
foi feita lendo código com atenção, não rodando; a parte que É nova
(a instrução em si) só um teste real confirma se ficou concreta o
bastante pro modelo seguir, mesma ressalva de sempre pra prompt (é
comportamento de modelo, não é algo que dá pra garantir só lendo).

---



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
