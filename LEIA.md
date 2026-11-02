# Spade v8.1.0

Reformulação completa (SPEC v8 + adendo "Estilo guiado"). Uma IA só, prompt sempre na mesma ordem e curto,
memória em 3 gavetas, Biblioteca de arquivos em pastas, chats conectáveis, estilo medido por código.
Quem GERA a fala é sempre o SillyTavern; a Spade só alimenta o prompt dele.

## Instalar (nesta ordem)
1. **Plugin primeiro.** Em `SillyTavern/plugins/spade-fs/` SUBSTITUA os arquivos (`index.js`, `package.json`) pelos de `plugin-spade-fs/`.
   **Nunca apague e recrie a pasta `spade-fs`**: nela ficam `_dados/` (seus documentos) e `.git/`.
   Confira que `enableServerPlugins: true` está no `config.yaml` do SillyTavern. Reinicie o SillyTavern.
2. **Extensão.** Substitua os arquivos da pasta da extensão Spade por `index.js`, `style.css` e `manifest.json` desta pasta. Recarregue a página.
3. Abra o ♠ → **Configurações**: cole a API key da NanoGPT, toque em **Testar plugin** (deve dizer "conectado") e em **Migrar documentos antigos**.
4. Em **Descrição**, importe a descrição do cartão e depois **esvazie o campo Description do cartão** no SillyTavern (senão ela vai duplicada).
5. Dê uma olhada em **Prévia**: ali você vê exatamente o que vai pro prompt. Depois de gerar uma fala no RP, a Prévia confere a ordem REAL em que o SillyTavern montou tudo.

**Aviso de segurança.** A versão antiga do plugin gravava backups em `<pasta da extensão>/_spade_backups`, que o SillyTavern serve pela web.
Se essa pasta existir, o app mostra uma faixa de aviso. Faça "Exportar tudo" e depois mova ou apague essa pasta.
Os backups novos ficam em `plugins/spade-fs/_spade_backups/` (não servida).

## O que você vê
- **Espaço** (chat): conversa com a IA nos bastidores. O que você pede ali vale na PRÓXIMA fala do RP (marca "✓ vale na próxima fala do RP"). As respostas da IA do Espaço nunca vão pro RP.
  A caixinha ao lado de cada conversa conecta com a conversa aberta (fio verde); as duas passam a enxergar uma à outra e o RP recebe a memória do vizinho.
- **Biblioteca → Arquivos → Artefatos → Arquivo**: pastas, cartões, e por arquivo: Explicações encadeadas (+), Observação (olho liga/desliga o que a IA vê), nota, estilo e uso no prompt.
  A IA lê só a NOTA, nunca o arquivo. A nota gerada só entra no prompt depois que você toca em **Aceitar nota**.
- **Descrição**, **Memória** (3 gavetas com orçamento), **Prévia**, **Jobs**, **Configurações**.

## Ordem fixa do prompt
`1 QUEM ELA É · 2 REGRAS · 3 NOTAS · 4 MEMÓRIA · 5 NOTAS DO AUTOR · (chat do ST) · 7 ESTILO · 8 AGORA`
Blocos 1–5 são o prefixo estável (idênticos byte a byte se você não mexer em nada). 7 e 8 mudam a cada resposta e ficam no fim.
(O adendo criou o bloco ESTILO; por isso AGORA virou o 8. Evitar fica dentro do AGORA como "### Evitar".)

## Decisões que tomei sozinho (seção 14 da SPEC) — mude se quiser
| Item | O que fiz |
|---|---|
| Mundo / NPCs / tarefas da v7 | **O relógio da história FICA (v8.1.0, abaixo).** NPCs e tarefas NÃO existem na v8 (sem decisão do usuário ainda): os dados antigos ficam intocados no navegador. |
| Documentos antigos | Viram arquivos na pasta "Importados". Os curtos (≤400 tokens) já ganham nota; os outros esperam análise. Backup automático antes. Rodar duas vezes não duplica. |
| Modelo | `xiaomi/mimo-v2.6-pro` para jobs e Espaço (se você tinha `modeloEscritor`, ele foi aproveitado). |
| Raciocínio (thinking) nos jobs | Desligado por padrão. NÃO testado na NanoGPT: se a API recusar o parâmetro, a Spade para de enviar e avisa em Configurações → Diagnóstico. |
| Limites | Geral 8000 · RP 3000 · Espaço 1500 · Biblioteca 3500 · Descrição ~600 (aviso). A soma das gavetas não pode passar do geral. |
| Espaço→RP | Últimas 6 mensagens suas, ligado. Pode desligar por mensagem. |
| Posição dos blocos 1–4 | "no prompt" (muda em Configurações). A Prévia mostra onde o ST realmente colocou. |
| Imagens e PDF | Não suportados na v8.0 (só texto: .txt .md .json .csv .tsv .yaml .log). Cartão PNG não é lido. |
| Conversas do Espaço | Continuam no navegador (IndexedDB), no mesmo formato da v7. "Exportar tudo" salva tudo num JSON. |
| Tela Início | A imagem da Home não veio; fiz uma Início simples só com dados reais (anel de contexto, atalhos, recentes). |

## Relógio da história (novo na 8.1.0 — SPEC 12.6, decisão 14)
O usuário escreve que passou tempo e o relógio avança. **Sem IA** (a v7 chamava um 2º modelo; isto é leitura por código, com 38 casos de teste).
- **+5 min por resposta** da personagem (swipe/regenerate não contam; se acabou de haver salto, não soma os +5).
- **Salto automático** só com frase CLARA **dentro de \*asteriscos\***: "passaram dois dias" (+2 dias, mesma hora), "dois dias depois", "três horas depois", "meia hora depois", "uma semana depois", "no dia seguinte" (+1 dia), "no dia seguinte, de manhã" (08:00; tarde 14:00; noite 20:00; madrugada 03:00), "volto às 18:46" / "já são 19h" (hora exata, se ainda é hoje).
- **Só pergunta** (botão de confirmação): vago ("algumas horas depois" → ~2 h, "mais tarde" → ~1 h), hora exata sem verbo de retorno ("combinamos às 18h"), hora que já passou ("volto às 7h" → dia seguinte), texto **fora** dos asteriscos, saltos acima de 60 dias, e **tudo que você disser no Espaço** (nunca é automático).
- **Não dispara** com passado/duração: "faz dois dias que não como", "chegou há dois dias", "ficou parada durante dois dias"; nem com fala entre aspas.
- O **primeiro salto claro liga o relógio sozinho** (com "Desfazer"); chats novos começam desligados para não inventar "dia 1, 9h". Chats que tinham o relógio da v7 começam **ligados** (copia o relógio antigo para o primeiro chat que abrir, uma vez).
- **Na tela Início:** cartão "Relógio da história" com Ajustar / Desfazer / Ligar-Desligar e os últimos saltos. Os últimos 20 ficam guardados (o "Desfazer" volta um por vez).
- **No prompt:** quando ligado, uma linha no bloco AGORA: `### Momento da história` → `dia 3, 14h20.` Sem palavras da extensão.
- Guardado **por chat** no disco (`memoria/<personagem>/<chat>/relogio.json`, plugin 2.1.0). Sem o plugin, cai na reserva do navegador, como o resto.
- **Não tem** "marcos com nome" (Chegada, Mercado, Festival da imagem 5): não foi pedido.

**Testado de verdade (8.1.0):** o leitor de frases (38 casos, `node`), a sintaxe dos dois arquivos e o fluxo completo num navegador simulado (jsdom) com o plugin REAL (ver "Teste do relógio" no fim).
**NÃO testado:** o evento `MESSAGE_SENT` no SEU SillyTavern (o id que ele manda), o toque no botão de confirmação num celular de verdade, e frases do seu jeito de escrever que eu não previ (se uma não funcionar, me mande o texto).

## Estilo guiado (adendo A)
O arquivo do adendo que recebi terminava na A5.3. **A6–A11 foram reconstruídas pela lógica das referências** (faixas de tamanho por tercis, rotação de exemplos,
conferência e cutucada com números, modo forte, a Descrição vence em caso de conflito, tela de medidas e exemplos). Revise se algo diverge do que você pensou.
Funciona assim: ao analisar um arquivo `tom` (ou com "Usar como estilo"), o código separa falas/narração, MEDE o texto inteiro e numera candidatos; a IA escolhe por número;
o código confere que cada exemplo é cópia literal, tira dado pessoal, limita tamanho e garante variedade. No RP entram 3 exemplos (5 no modo forte) que giram a cada resposta,
uma linha de perfil e, só se as últimas falas saírem da faixa medida (ou copiarem um exemplo), uma cutucada curta com números. O código mede só a superfície: tamanho, pontuação, gíria — não mede humor nem subtexto.

## O que foi testado (de verdade) e o que NÃO foi
Testado num navegador real (Chromium headless) com o plugin REAL e uma cópia dos seus 14 documentos, num SillyTavern **simulado** e NanoGPT **simulada**:
prefixo estável (T1), nota só entra depois de aceita e original nunca vai ao prompt (T2), pedido do Espaço vale na hora e resposta da IA não vai ao RP (T3),
conexão entre conversas em disco (T4), fatos que ela não sabe ficam de fora (T5), orçamento e "fora do orçamento" (T6), grupo substitui os membros (T7),
migração dos 14 documentos sem duplicar (T8), interceptor sem abort em regenerate/swipe (T10), pensamento (T11), segurança do plugin contra caminhos, versão velha e teto (T12),
lista de repetição medida (T13), celular 390 px e plugin fora do ar. Quase 100 verificações automáticas.
**NÃO testado — depende do SEU SillyTavern:** onde o ST coloca os slots em Chat Completion (a Prévia confere sozinha depois da primeira fala),
o evento `CHAT_COMPLETION_PROMPT_READY` na sua versão, o parâmetro `thinking` na NanoGPT, a qualidade real das análises/estilo com o MiMo, e uso no Termux/celular de verdade.
Se a ordem dos blocos sair errada na Prévia, o plano B (reordenar pelo evento de prompt pronto) está descrito na SPEC 9.4 e não foi implementado.

## Limites honestos
- Tokens são estimados (~3,5 caracteres por token). A Prévia usa a mesma conta do orçamento.
- Conversas do Espaço não vão pro disco (só pro navegador); a Biblioteca, memória e descrição vão.
- Segmentação de falas é heurística (log com "Nome:", travessão, aspas, linhas, texto corrido). Texto corrido gera aviso de baixa confiança.
- `localStorage` guarda a config e a rotação de exemplos; limpar os dados do navegador apaga a API key e as conversas do Espaço (o resto está no disco).

## Mapa do código (index.js)
01 base · 02 config · 03 armazenamento · 04 Biblioteca e seleção por orçamento · 05 Descrição/memória/conexões · 06 regras e repetição · 07 estilo guiado ·
08 compositor · 09 entrega ao SillyTavern · 10 IA e jobs · 11 backup/exportar/migrar · 12 Espaço · 13 interface · 14 início.
Histórico das versões antigas: `LEIA-historico-v7.md`.

## Teste do relógio (8.1.0) — o que rodou de verdade
Scripts em `../testes-relogio/` (ver o LEIA de lá). Resultado: **38/38** no leitor de frases e **33/33** no navegador simulado com o plugin 2.1.0 real.
O segundo teste cobre: salto claro liga o relógio e grava em disco · a linha "Momento da história" no bloco AGORA · Desfazer · +5 min por resposta (swipe não soma, salto não soma junto) ·
vago/fora dos asteriscos/Espaço só perguntam · "faz dois dias…" não faz nada · cartão da tela Início, Ajustar (inclusive recusar hora 25), Ligar/Desligar · recarregar a página mantém ·
outro chat começa desligado · migração do relógio da v7 (uma vez, banco antigo intacto) · plugin recusa `..`, nome fora da lista e versão velha (409).
Conferi também que o teste **falha** quando a lógica é estragada de propósito (troquei o +5 por +7: 5 falhas).
**Não prova:** o seu SillyTavern (o `MESSAGE_SENT` real), o celular de verdade, nem frases do seu jeito de escrever que eu não previ.

