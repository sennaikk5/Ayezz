# Spade v6.8 — refeito seguindo as imagens de referência

Isso substitui a passada anterior — dessa vez segui as imagens que você
mandou (Claude.ai) em vez de focar só no backend.

## O que mudou de verdade

- **Bolhas sem listra**: Espaço, Treino e Pensamento agora usam o mesmo
  visual — usuário em bolha preenchida, IA em texto solto serifado, sem
  cor por autor. Autor só aparece como rótulo discreto (ex: "🔧
  Construtora") quando não é a personagem principal falando.
- **Barra de topo**: ☰ abre a sidebar de chats, "+" cria chat novo,
  pílula "📄 N" abre a lista de documentos (artefatos).
- **Sidebar de chats** ("colunas" tipo Claude.ai): cada chat tem memória
  própria de Espaço e Treino — trocar de chat no RP já troca aqui
  também (automático), e dá pra criar/trocar/apagar chat só na extensão
  também, sem precisar abrir RP novo pra isso. Testei isolado: memória
  não vaza entre chats, trocar preserva histórico, apagar limpa de
  verdade.
- **Pílula de Treino**: "🎭 Treino" no rodapé do Espaço entra no
  mini-chat; "← Espaço" dentro dele volta — substituindo a aba de texto
  fixa por um botão no estilo do seletor de modelo da imagem.
- **Documento como artefato**: a pílula de documentos abre um
  visualizador de painel cheio (não é mais só o painel dividido dentro do
  Treino) — clica num card, abre o texto inteiro.
- **Card de passos** ("N passos", expansível) antes da resposta, quando
  ela usou ferramenta — mesmo padrão da imagem do Claude Code. Usei
  `<details>/<summary>` nativo do HTML de propósito: o chat inteiro é
  redesenhado do zero a cada mensagem nova (era assim desde antes), um
  listener de clique individual se perderia a cada vez — o navegador
  resolve abrir/fechar sozinho sem precisar de JS pra isso.

Testei isolado o que dava pra testar sem navegador: geração de HTML das
bolhas/card de passos (saída bem formada, sem `<details>` vazio quando
não tem passo), e o fluxo inteiro de múltiplos chats (criar, trocar,
apagar, isolamento de memória).

## O que ainda NÃO entrou

- Commit/push automático pro GitHub ao editar a extensão — precisa do
  repo já configurado (remote + autenticação), não dá pra eu configurar
  isso daqui.
- Reaproveitar a paleta nova em TODA a extensão (Biblioteca/Sistemas/
  Config ainda têm alguma cor antiga solta aqui e ali) — o esforço foi
  todo pras superfícies de chat, que é onde a diferença mais aparece.
- Não consigo ver a extensão rodando de verdade (sem SillyTavern/
  navegador aqui) — o visual pode precisar de ajuste fino depois de ver
  ao vivo, principalmente espaçamento/tamanho em tela pequena.
