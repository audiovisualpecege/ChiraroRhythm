# Rhythm — extensão para Premiere Pro

> Antigo nome: Automação de Edição. Visual no Design System Chiaro Filmes (tema Noite).

Painel com abas de automação para o Premiere Pro (CEP). Lê o áudio **direto
da timeline**: sem ffmpeg, sem Media Encoder, sem presets.

## Abas

### Silêncios — Cortador de Silêncios
- **Fonte:** sequência inteira ou só os clipes selecionados; você escolhe as
  faixas de áudio analisadas (por padrão, só a primeira faixa com clipes —
  trilha musical na análise impede achar silêncios).
- **Detecção:** sensibilidade (dB) com ajuste automático (pré-analisa o
  áudio: ruído de fundo × fala), silêncio mínimo (s), janela de análise
  (ms, digitável), margem depois/antes da fala (ms).
- **Prévia:** resumo (cortes, segundos a menos, duração antes → depois) e,
  expandida, o **visualizador da timeline**: nível em dB por janela, linha do
  limiar, cortes em vermelho, cursor do Premiere. Clique leva o cursor do
  Premiere ao ponto; roda dá zoom; arrastar navega; duplo clique num corte
  liga/desliga. A lista mostra cada corte (início, fim, duração) com
  checkbox. Mudar qualquer parâmetro atualiza a prévia na hora (o áudio é
  lido uma vez só).
- **Aplicar:** marcadores vermelhos em todos os silêncios (sempre) →
  backup da sequência (opcional) → ripple delete de cada silêncio em todas
  as faixas destravadas, do fim para o começo. Onde o corte deu certo fica
  um marcador "Corte N"; onde falhou, o intervalo vermelho continua para
  corte manual. Faixas travadas não são cortadas.

### Zoom — Alternador de Zoom
- **Cada clipe de vídeo é um corte.** Recebem zoom vídeos, imagens e
  sequências aninhadas; gráficos/MOGRTs, textos e camadas de ajuste ficam de
  fora. Clipes desativados e faixas travadas são pulados.
- **Fonte:** clipes selecionados, uma faixa ou todas. Cada faixa conta o
  ciclo separado; em "selecionados", conta só entre os selecionados.
- **Ciclo:** 100% → escala do zoom (125%) → segunda escala (115%, opcional)
  → repete. "Começar com zoom" avança o ciclo uma posição.
- **Mira X/Y:** o ponto escolhido fica parado na tela; com escala ≥ 100%
  nunca aparece borda. Abaixo de 100% é permitido, com aviso.
- **Modo:** fixo, ou em movimento (keyframes lineares do início ao fim do
  clipe, escala do ciclo ± intensidade, padrão +3%; zoom in, out ou
  alternado). Direção e intensidade só ativam no modo em movimento.
- **Prévia** no painel sobre um frame do clipe selecionado (acompanha a
  seleção), e **Ver no Premiere** para aplicar só nele e dar play.
- O zoom vai num efeito **Transformar** próprio, "assinado" com um ângulo de
  inclinação de 0,0137° (sem efeito visual, inclinação = 0). Assim o app
  reconhece os efeitos dele mesmo depois de razor, copiar/colar ou em outro
  computador: reaplicar **atualiza** em vez de empilhar e **Remover zoom**
  tira só os dele (segue o mesmo seletor de fonte). O Movimento do clipe e
  Transformar adicionados por você nunca são tocados.

### Intercalado — J-Cut / L-Cut
- Faixa de origem e de destino (diferentes). Percorre os clipes em ordem:
  1º fica, 2º **move** para o destino, 3º fica… (move de verdade: mesmo
  clipe, mesmos efeitos — nunca copia).
- J-Cut, L-Cut ou Ambos (N frames de cada lado).
- Sem material (handle) suficiente: estica o máximo possível e lista os
  cortes parciais no resumo (clique leva o cursor até eles).
- **Desfazer Tudo:** reverte só o que a ferramenta fez, sobre o estado atual
  (funciona depois de outras edições e de reabrir o Premiere). O registro
  fica em `%APPDATA%\AutomacaoEdicao\intercalado-desfazer.json`.

## Formatos de áudio lidos

| Formato | Como |
|---|---|
| WAV / BWF / RF64 (16, 24, 32 bits, float) | PCM lido direto |
| MP4 / MOV com PCM (câmeras Sony, Canon, etc.) | PCM lido direto, só os trechos usados |
| MP4 / MOV / M4A com AAC (celular, OBS…) | quadros AAC extraídos e decodificados pelo Chromium do CEP |
| MP3, AAC, OGG, FLAC | arquivo inteiro pelo decodificador nativo |

Clipes que não dão para ler (MXF, aninhados, offline…) são listados na
prévia e tratados como fala — nunca são cortados às cegas.

## O que não está neste repositório

Para não publicar material comercial nem dados de produções:
- **Fontes Altivo** (`extension/fonts/Altivo-*.otf`, licença comercial). Sem elas,
  títulos e botões usam a Archivo (incluída, licença OFL) — o painel funciona igual.
- **Referência da claquete** (`extension/img/claquete-ref.slt`). Sem ela, a
  sincronização por imagem não reconhece a claquete da produtora e usa só a
  detecção por movimento e a boca.
- Certificado de assinatura (`tools/cert/`), `ZXPSignCmd.exe` e ffmpeg (`tools/bin/`).

## Instalar

### Como extensão de verdade (ZXP assinado)
1. Coloque o `ZXPSignCmd.exe` da Adobe em `tools\bin\`
   ([CEP-Resources/ZXPSignCMD](https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD)).
2. `powershell -ExecutionPolicy Bypass -File tools\build-zxp.ps1` → gera `dist\Rhythm-<versão>.zxp`
3. `powershell -ExecutionPolicy Bypass -File tools\install.ps1` → instala com o
   instalador oficial da Adobe (vem com o Creative Cloud).
4. Reabra o Premiere: **Janela › Extensões › Rhythm**.

O `.zxp` pode ser enviado para outras pessoas: elas instalam com o
`tools\install.ps1`, com o próprio Creative Cloud ou com qualquer instalador
de ZXP (ex.: ZXPInstaller / Anastasiy's Extension Manager). Não precisa de
modo desenvolvedor.

### Modo desenvolvimento
`powershell -ExecutionPolicy Bypass -File tools\dev-link.ps1` liga a pasta
`extension\` direto no Premiere (precisa do PlayerDebugMode ligado). Mudou
o código → feche e abra o painel. Depuração: Chrome em `http://localhost:8092`.

## Estrutura

```
extension/                 ← o que vai dentro do .zxp
  CSXS/manifest.xml
  index.html, css/style.css
  jsx/host.jsx             ExtendScript (Premiere): leitura, cortes, mover/esticar clipes
  js/core/                 ponte com o Premiere, utilidades de UI, persistência
  js/audio/containers.js   leitura de WAV / MP4 / MOV (PCM e AAC) direto do disco
  js/audio/levels.js       envelope de energia (1 valor por ms)
  js/audio/decode.js       AAC/MP3 pelo decodificador nativo do Chromium
  js/audio/silence.js      detecção (lógica pura)
  js/views/timelineView.js visualizador da timeline
  js/tools/                uma aba por arquivo (+ interleavePlan.js, lógica pura)
dev/                       prévia da interface no navegador, com Premiere simulado
test/run-tests.js          testes da lógica: node test/run-tests.js
tools/                     dev-link, build-zxp, install
```

## Nova aba de automação
1. `index.html`: nova `<section class="tool-view" id="tool-<id>" data-tool-title="Nome">`.
2. `js/tools/<id>Tool.js`: `window.AETools.<id> = { mount(app) { return { onInfo(info) {}, onShow() {} } } }`.
3. `<script src="js/tools/<id>Tool.js">` antes do `main.js`.
4. Funções novas do Premiere entram no objeto `api` do `jsx/host.jsx` e são chamadas com `AEHost.call("nome", args)`.

## Métodos do Premiere usados (validados no Premiere 26.5)
- QE `sequence.extract(entrada, saída)` — ripple delete do intervalo em todas as faixas destravadas (ignora alvo de faixa; não toca faixas travadas; apaga marcadores dentro do trecho).
- QE `trackItem.moveToTrack(0, Δfaixa, "00;00;00;00", false)` — move de faixa mantendo id, in/out e efeitos.
- DOM `trackItem.start`/`inPoint` e `end`/`outPoint` — esticam o áudio sem mexer no vídeo vinculado. Atenção: o Premiere **não** limita ao tamanho da mídia, por isso o app calcula o handle.
- DOM `sequence.clone()`, `markers`, `setPlayerPosition(ticks)`.
- QE `trackItem.addVideoEffect(qe.project.getVideoEffectByName("Transform"))` — atenção: o efeito novo entra no **topo** da pilha de efeitos (antes dos existentes), por isso o app compara a lista antes/depois para achar o efeito inserido.
- QE `component.remove()` remove um efeito só (os componentes do QE vêm na mesma ordem do DOM); QE `sequence.exportFramePNG(tc, caminhoSemExtensão)` captura o frame composto (≈0,5 s em 4K).
- Transformar: propriedades por índice (iguais em qualquer idioma) — 1 Posição (normalizada), 2 Escala uniforme, 3 Escala, 5 Inclinação, 6 Eixo da inclinação. Keyframes usam o tempo da mídia (in/out do clipe) e saem lineares.

ExtendScript tem fim de suporte anunciado pela Adobe, mas segue funcionando
no Premiere 26.x. Toda chamada ao Premiere está concentrada em `jsx/host.jsx`.
