# Spade v6.8 — o que mudou nessa passada

## Feito nessa passada

**Sidebar de múltiplos chats no Espaço, tipo Claude.ai** — cada
personagem agora pode ter várias conversas de Espaço independentes, cada
uma com sua própria memória. Botão ☰ no header abre um drawer com a
lista, "+ Novo chat" começa uma vazia, cada item tem "apagar". Título de
cada conversa é tirado automaticamente da primeira mensagem (igual
Claude.ai — sem precisar nomear nada na mão).

**Auto-link com o chat do próprio SillyTavern** — abrir/trocar de chat no
RP (`CHAT_CHANGED`) já mostra a conversa do Espaço linkada com aquele
chat, se existir uma; se não existir, mostra uma conversa vazia (sem
criar nada na lista ainda — só quando a 1ª mensagem é mandada é que ela
vira entrada de verdade e linka com aquele chat do ST). É por isso que
trocar de chat no RP só pra olhar não lota a sidebar de rascunho vazio.

**Migração automática do histórico antigo** — quem já tinha conversa no
Espaço antes dessa versão não perde nada: na primeira leitura depois de
atualizar, aquele histórico vira o primeiro item da lista, com título
tirado da primeira mensagem de verdade que já existia.

**O que NÃO mudou de propósito**: a memória da Biblioteca (falas,
documentos, cenas) continua por personagem, atravessando chats diferentes
— só o Espaço (a conversa com o Spade em si) passou a ser por chat. Isso
segue a mesma lógica que já existia no código pra Biblioteca (ver
comentário de `personagemAtual()`), só que agora explícita: memória de
RP é sobre quem a personagem é, conversa com o assistente é sobre aquele
papo específico.

**Estado dos testes**: sintaxe validada (`node --check`), toda a lógica
nova revisada linha por linha contra o fluxo existente (concorrência
entre trocar de chat no meio de um envio, `abandoned`, etc.). Não rodei
dentro de um SillyTavern de verdade nessa passada (sem acesso a esse
ambiente aqui) — o primeiro teste real no seu Termux é o que vale.

## O que NÃO entrou ainda (do pedido original)

- **Redesenho visual da Sala de Pensamento** (chat bonito tipo Claude,
  sem as "listras" de cor por autor) — não toquei no CSS dela.
- **Botão-pílula** tipo "Sonnet 5 Alto" pra entrar/sair do mini-chat de
  Treino — a aba continua no formato de sempre (mini-tab no topo).
- **Animação tipo Claude/VS Code** (cards colapsáveis "N passos") pro que
  ela vai fazendo — o ticker+journal atual mostra a mesma informação, mas
  não nesse formato visual.
- **Atualizar até o GitHub sozinho** com botão de aviso forte — o
  `spade-fs` já escreve/valida/faz backup no disco; commit+push
  automático pro GitHub é bloco novo, precisa do repo já configurado com
  remote/autenticação (não dá pra configurar isso daqui) — não
  implementado.
- **"Tirar quase todos os comandos"** — ainda não fiz uma auditoria
  completa de todo prompt do arquivo trocando instrução prescritiva por
  "ela decide".

Qual desses é o próximo?
