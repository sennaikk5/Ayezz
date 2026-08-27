# Spade v6.9 — paleta em tudo + banner de atualização/GitHub

## O que entrou nessa passada

**Paleta nova em toda a extensão** — Biblioteca, Sistemas e Config
usavam ainda a cor azul/roxa antiga do tema anterior. Migrei os hex
estruturais (fundo, borda, texto) pros tokens novos via script, deixando
INTOCADAS as cores semânticas (vermelho de erro, verde de sucesso, âmbar
de aviso/importância) — troca de tema visual, não de significado.
Conferi depois que nenhuma cor antiga sobrou e que toda variável CSS
usada tem declaração correspondente.

**Banner de atualização + GitHub** — pedido explícito: "aviso bem forte
de botão... atualizar até o do GitHub sozinho". Quando `extensao_editar_
arquivo` ou `extensao_restaurar_backup` roda, aparece uma faixa âmbar
fixa no topo (acima até do ticker) com botão "🔄 Atualizar agora". Ele
faz `git add` + `commit` + `push` de verdade (novo endpoint `/git/
publicar` no `spade-fs`) e recarrega a página.

**Decisão de propósito**: publicar no GitHub é botão que só O HUMANO
aperta — não virou ferramenta que a Construtora chama sozinha. Editar
localmente continua autônomo (já era); subir pro remoto compartilhado é
ação com mais peso, fica como confirmação manual.

**Testado de verdade, não só lido** (com git de verdade, repo real,
remoto real):
- Pasta que não é repo git → recusa com erro claro, não finge sucesso.
- Repo git sem remote → `add`/`commit` funcionam, `push` falha com
  mensagem específica.
- **Bug que só apareceu testando**: `git add arquivo1 arquivo2 arquivo3`
  falha por INTEIRO se qualquer um dos três não existir no disco — corrigi
  pra só mandar pro git os arquivos que existem de fato.
- Fluxo completo (escrever → status → publicar) contra um remoto git
  real: commit chegou lá de verdade, confirmado lendo o log do remoto.

## O que ainda falta (do pedido original, ainda não veio nessa)

- Ver isso tudo rodando ao vivo — sem SillyTavern/navegador aqui, meu
  teste pra visual é ficar de olho na estrutura do CSS/HTML, não
  renderização de verdade.
