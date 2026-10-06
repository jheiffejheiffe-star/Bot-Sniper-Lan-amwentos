# MÁQUINA GRATUITA — o que dá para montar com R$ 0 (e o que não dá)

Este documento é o plano operacional do bot rodando **100% em camadas gratuitas**, com os
limites **publicados** de cada serviço e o que cada decisão de configuração resolve. Ele não
promete lucro e não vende facilidade: diz o que o dinheiro compra e o que o código compra.

---

## 1. A verdade primeiro: o que o plano gratuito NÃO compra

- **Latência de ponta não é grátis.** Plano gratuito significa endpoint compartilhado, fila de
  envio comum e nenhuma prioridade de inclusão. Ser competitivo em *velocidade* contra quem paga
  por gRPC, conexão *staked* e co-location **não acontece** em plano gratuito — e quem disser o
  contrário está vendendo algo.
- **O que o gratuito compra é o MOTOR.** Detecção → filtro → decisão → entrada (simulada) →
  gestão de saída → registro → replay. Com dados **reais** de mercado. É exatamente esse motor
  que precisa estar certo antes de qualquer capital, e é ele que já está implementado aqui.
- **Compra e venda REAIS não são grátis.** O caminho de entrada on-chain ainda não está
  implementado (S6) e, quando estiver, exige carteira com SOL para pagar taxas e tip. O que roda
  **automaticamente e de graça** hoje é o ciclo completo em **PAPER** (posições simuladas com
  preço real de mercado, stop/alvo/trailing fechando automaticamente) e a validação em
  **SHADOW** (cotação → montagem → `simulateTransaction`, sem assinar nada).

## 2. A pilha gratuita, com limites publicados

| Papel | Serviço gratuito | Limite publicado | O que compra | Onde quebra primeiro |
|---|---|---|---|---|
| RPC HTTP + WS | **Helius Free** | 1M créditos/mês; 10 req/s; `sendTransaction` **1/s** | RPC Solana-nativo + WS estável | 1 envio/s inviabiliza execução real |
| RPC HTTP + WS | **Syndica Free** | 10M req/mês; até **100 req/s** | Maior teto gratuito de **leitura** | sem camada de mercado; parsing é seu |
| RPC HTTP + WS | **Alchemy Free** | 30M CU/mês; 25 req/s | Maior folga em CU | `getTransaction`/`getBlock` custam **4x** |
| RPC HTTP + WS | **QuickNode Free** | 10M créditos/mês; ~15 req/s (fontes divergem — medir) | WS + add-ons | créditos pesam por método |
| Detecção | **WSS `logsSubscribe`** (qualquer plano) | sem custo por notificação | Cobre Pump.fun + Raydium + Meteora | depende do WS do provedor |
| Detecção | **PumpPortal `subscribeNewToken` / `subscribeMigration`** ✅ *implementado* | grátis, sem chave | Entrega o **mint direto** na criação → **sem `getTransaction`** neste caminho | é serviço de terceiro; uma conexão só (a doc avisa que múltiplas podem banir) |
| Filtro de risco | **RugCheck `/report`** ✅ *implementado* | grátis | Segundo par de olhos: score, riscos, freeze authority, LP | ~5 req/min relatado; é evidência ADICIONAL (nunca aprova) |
| Preço/liquidez | **DexScreener API pública** | 300 req/min · **até 30 tokens por chamada** | Preço em SOL + liquidez | 429 em rajada se não houver orçamento |
| Preço (reserva) | **Jupiter Price API v3** | 60 req/min (mesmo balde da cotação) · **até 50 ids** | Preço USD→SOL com o SOL do próprio lote | compartilha cota com as cotações |
| Preço (3ª opinião) | **GeckoTerminal** | 30 req/min, grátis, sem chave · até 30 por chamada | Preço quando as duas acima caem | teto baixo: é reserva, não caminho principal |
| Cotação de saída | **Jupiter Free** | **60 req/min por organização** (≈1/s) | Cotação de swap para preço/saída | criar mais chaves **não** aumenta |
| Execução | **Jito block engine** | 1 req/s por IP por região; tip mínimo 1000 lamports | Bundles e status de landing | 429 ao consultar em loop |
| Servidor | **Oracle Cloud Always Free** | Ampere A1: 4 OCPU / 24 GB / 10 TB saída | Máquina sempre ligada, perto do RPC | "out of host capacity" é comum; Frankfurt/Singapura provisionam melhor |

Os números acima estão codificados em `src/rateBudget.ts` (campo `source` de cada teto) e são
**medidos no seu ambiente** por `npm run free:check`.

## 3. As cinco decisões que fazem a máquina gratuita funcionar

1. **Um processo por chave.** A cota é por chave/organização. Dois processos com a mesma chave
   dobram o consumo e o erro aparece como 429 sem ninguém ter mudado nada.
2. **Orçamento de cota (já implementado).** Cada provedor tem teto com janela deslizante. Ordem
   de prioridade: **saída** (nunca bloqueada — reduzir risco não depende de cota) > **normal**
   (espera até 250–300 ms e depois **pula contando**) > **fundo** (medição de RTT cede na hora).
   `skipped > 0` significa "faltou dado por cota"; `bypassed > 0` significa "a saída passou acima
   da cota de propósito".
2b. **Chamadas em LOTE (já implementado).** Orçamento limita o dano; lote multiplica a
   capacidade. O gerenciador de posições monta **uma** requisição por provedor por ciclo, com
   cascata DexScreener (30 tokens, preço em SOL + liquidez) → Jupiter Price v3 (50 ids) →
   GeckoTerminal (30) e usa o preço individual só como fallback. Sem lote, 10 posições = ~400
   req/min (acima do teto de 300 do DexScreener): o 429 estava garantido antes de qualquer
   problema de mercado. Contadores em `/api/health → marketBatch`.
2c. **Segunda opinião de preço e liquidez (já implementado).** Preço de uma fonte só é preço
   *até* outra discordar. A cada ciclo, **até 2 tokens** (rotativo, `HFT_PRICE_VERIFY_SAMPLE`)
   recebem segunda opinião na primeira fonte que ainda não respondeu; quando a diferença passa de
   5% (warn) / 15% (critical), o bot registra **os dois preços e as duas fontes** no log, na
   posição e em `/api/health → marketBatch.divergences`. Isso importa porque a cascata para na
   primeira fonte que responde: sem amostra, "sem divergência" seria apenas "sem verificação" —
   o campo `verifications` existe exatamente para não deixar essa confusão acontecer. Custo
   máximo: **1 requisição extra por ciclo**, com prioridade `background` (nunca fura cota).
   O DexScreener também informa a **liquidez** no lote (dado já pago em cota): queda ≥ 50% / 80%
   do pico observado gera alerta de remoção de LP. Nada disso vende sozinho — alerta não é
   gatilho, e gatilho de saída por liquidez precisa de execução real autorizada + regra validada.
2d. **`priceNative` NÃO é "preço em SOL" (correção de bug real).** No DexScreener, `priceNative`
   é o preço do token na moeda de **cotação do par**. Em par TOKEN/USDC o número está em USDC e
   vale ~200x o preço em SOL (SOL ≈ 200 USD); lido como SOL, ele inflava o PnL e — com capital
   real — dispararia take-profit logo após a compra. Agora o par cotado em SOL usa `priceNative`,
   par cotado em outra moeda converte por `priceUsd / USD-SOL do próprio payload` (o SOL vai na
   MESMA requisição, custo zero) e, sem âncora, o preço é declarado **ausente** em vez de errado.
2e. **Preço de ENTRADA verificado (já implementado).** O preço de entrada é o denominador de
   TODO o PnL da posição: stop, alvo, trailing e replay são percentuais dele. A entrada resolve o
   preço pela cascata gratuita e pede **segunda opinião** a outra fonte: **duas concordando** →
   entra (`verified` / `verified_with_warning`); **uma só** → entra marcada como `single_source`
   (a posição carrega `entryPriceVerification`); **divergência acima do limiar crítico** →
   **entrada recusada** (`divergent`), porque aí há evidência de erro grosseiro, não de mercado
   em movimento. Contadores em `/api/health → entryQuality`. Para capital real,
   `HFT_ENTRY_ALLOW_SINGLE_SOURCE=0` passa a exigir duas fontes independentes.
3. **Servidor na mesma região do RPC — não a máquina de casa.** Bot rodando em casa (Brasil) até
   um RPC em us-east paga **~120–200 ms por chamada**; o mesmo código numa VPS gratuita da mesma
   região mede **uma ordem de grandeza menos**. É o maior ganho gratuito que existe, e o
   `free:check` mostra o seu número.
4. **Detecção em PARALELO: WSS do RPC + PumpPortal (ambos grátis).** O S5 mediu o gargalo:
   `getTransaction` **não aceita `processed`**, então enriquecer o lançamento sempre espera
   `confirmed`. O feed da PumpPortal entrega o mint na notificação e elimina essa espera (está
   implementado e medido em `pumpPortal` no `/api/health`). O WSS do RPC continua porque é ele
   que cobre **Raydium e Meteora** — e porque depender de um único terceiro para detectar seria
   fragilidade, não velocidade.
5. **PAPER → SHADOW, nunca LIVE.** Em plano gratuito, `sendTransaction` é limitado a ~1/s e não há
   conexão *staked*: comprar caro e não conseguir vender é o cenário provável, não o extremo.

## 4. Configuração exata para começar (copie e preencha)

```bash
# Modo seguro: PAPER não assina nada. (SHADOW valida construibilidade; LIVE exige 2 declarações.)
RUNTIME_MODE=PAPER
# Loopback: o painel é para VOCÊ. Expor na rede exige ADMIN_TOKEN.
HFT_BIND_HOST=127.0.0.1
ADMIN_TOKEN=<openssl rand -hex 32>

# RPC gratuito (exemplo Helius; Syndica tem o maior teto de leitura, Alchemy a maior folga em CU).
# REGRA: NUNCA use api.mainnet-beta.solana.com para decidir — é compartilhado e não tem SLA.
RPC_ENDPOINT=https://mainnet.helius-rpc.com/?api-key=SUA_CHAVE
RPC_WEBSOCKET=wss://mainnet.helius-rpc.com/?api-key=SUA_CHAVE
RPC_FALLBACKS=https://api.mainnet-beta.solana.com
RPC_PRIMARY_LABEL=helius-free
# Perfil de cota: public | helius | alchemy | quicknode | syndica
HFT_RPC_PROFILE=helius

# Capital (só afeta o tamanho NOCIONAL em PAPER; nenhuma ordem real é enviada).
MAX_POSITION_SOL=0.05
# Orçamento do filtro profundo por sinal (LIVE veta se estourar; PAPER prossegue marcado).
HFT_DEEP_FILTER_BUDGET_MS=900

# Ferramentas gratuitas de detecção e evidência (padrão: ligadas).
HFT_PUMPPORTAL=1            # feed PumpPortal (mint direto, sem getTransaction). Requer Node >= 22.
HFT_RUGCHECK=1              # evidência externa de risco no filtro profundo (nunca aprova sozinha).

# NÃO preencha isto agora:
# OPERATIONAL_PRIVATE_KEY=...
# LIVE_TRADING_ENABLED=true
```

Passos: `npm install` → `npm run lint` → `npm run test` → **`npm run free:check`** (mede a rede)
→ `npm run build && npm start` → abra o painel e confira `/api/system-truth` (o que é medido e o
que é simulado) e `/api/health` (`budgets`, `detection.hotPath`).

## 5. Aritmética de cota (para não descobrir o teto no pior momento)

Exemplo com **Helius Free** (1M créditos/mês, 10 req/s):

- Uma decisão de lançamento consome ~5–6 créditos (conta do mint, maiores holders, supply,
  enriquecimento da transação). ≈ **160 mil decisões/mês** no papel — mas o limite que morde
  primeiro é o de **10 req/s durante rajada** (pump.fun lança dezenas por minuto).
- O laço de infraestrutura mede cada nó a cada 5 s (12/min/nó). Com **o orçamento**, essa medição
  **cede** para o caminho quente e o adiamento aparece em `rpcMeasureSkippedByBudget`.
- **DexScreener:** 300/min. O bot usa 1 por decisão + 1 por posição em ciclo (com backoff) — o teto
  por minuto é o que importa, e é o que o orçamento protege.
- **Jupiter:** 60/min é o teto mais apertado; por isso só se cota o que passou pelo filtro (e a
  saída, que tem prioridade).
- **Jito:** 1/s. O oráculo de tip tem cache de 10 s; status de bundle é conferido com throttle.

### 5.1 O caminho novo de detecção (por que ele é mais rápido)

```
ANTES  : logsSubscribe → getTransaction(confirmed, espera!) → mint → decisão
AGORA  : PumpPortal → mint + nome/símbolo/signature → decisão        (0 RTT de enriquecimento)
         logsSubscribe → getTransaction → decisão                      (Raydium/Meteora e redundância)
```

Os dois alimentam o MESMO pipeline; o portão por mint (`InFlightMints`) garante que o mesmo
lançamento visto pelas duas fontes vire **uma** decisão — a duplicata é contada em
`hotPath.inFlightDuplicatesDropped`, e não é erro: é o desenho.

## 6. O que medir, em ordem, e o que cada número decide

| Medição | Onde ver | O que decide |
|---|---|---|
| p95 do RPC | `npm run free:check` | p95 > 250 ms = gargalo é **rede**; otimizar código não resolve |
| Notificações na janela do WSS | `free:check` (estágio 3) | se 0, **não prova** detecção quebrada: aumente a janela e repita em horários diferentes |
| `budgets.*.skipped` | `/api/system-truth` | >0 = plano subdimensionado para o polling atual |
| `hotPath.enrichmentFailures` | `/api/health` | notificação vista e mint **não** obtido: perda real de oportunidade |
| `pumpPortal.eventsEmitted` | `/api/health` | prova de vida do feed gratuito (log de conexão **não** é prova) |
| `pumpPortal.invalidMessages` | `/api/health` | contrato do provedor mudou: ajustar o parser com o dado observado, sem chutar |
| `budgets.rugcheck.skipped` | `/api/system-truth` | evidência externa perdida por cota (o filtro local continua valendo) |
| `marketBatch.requests` vs `mintsRequested` | `/api/health` | custo real de cota por ciclo: se `requests ≈ mintsRequested`, o lote não está sendo usado |
| `marketBatch.lastSources` | `/api/health` | quem está fornecendo preço (cascata funcionando ou fonte principal caída) |
| `marketBatch.verifications` | `/api/health` | **0 com posições abertas = não houve segunda opinião**; >0 = houve comparação cruzada de verdade |
| `marketBatch.divergences` / `lastDivergences` | `/api/health` | fontes discordando acima do limiar — investigar pool/decimal antes de confiar no preço |
| `entryQuality.verified` vs `singleSource` | `/api/health` | proporção de entradas com preço NÃO verificado — se for alta, alguma fonte gratuita está falhando |
| `entryQuality.divergent` | `/api/health` | entradas RECUSADAS por divergência entre fontes: evidência de erro grosseiro (investigar pool/decimal) |
| `liquidityUsdPeak` / `liquidityAlert` (na posição) | banco/`/api/positions` | queda de liquidez = remoção de LP em andamento; alerta, não venda |
| `replay` / PnL paper | `npm run replay` | expectativa da estratégia — **não** "ganhou em 3 trades" |

## 7. Quando pagar: a ordem que rende mais por real

1. **gRPC (S7)** — assina transação no nível `processed` e elimina a espera de `confirmed` no
   enriquecimento. É o maior ganho de latência real do sistema hoje. **Já implementado** (aditivo ao
   WSS): falta apenas um endpoint — `npm run grpc:check` prova o canal antes de ligar. (Helius
   LaserStream entra no plano Business, US$ 499/mês; Triton e QuickNode têm ofertas próprias.)
2. **Envio com conexão *staked* (SWQoS)** — isso muda **inclusão** (a transação entrar no bloco),
   não detecção. É o passo que torna execução real viável. **A corrida de envio já existe**
   (`HFT_PARALLEL_SEND=1`); o que se paga aqui é o ENDPOINT com stake, que é a sua parte.
3. **Co-location / ShredStream** — só depois de medir a janela real em milissegundos (S11).
4. **Postgres / multi-processo** — escala e durabilidade, não velocidade (S10).

## 8. O que NÃO fazer no gratuito

- **Nunca** colocar chave privada real nem usar a carteira principal na máquina de teste. Toda a
  regra de custódia continua valendo (`.env` fora do git, hot wallet isolada, capital limitado).
- **Não** rodar dois processos com a mesma chave.
- **Não** ligar `LIVE`: 1 `sendTransaction`/s e sem *staked* — comprar é fácil, sair é que não.
- **Não** tratar PnL de PAPER como lucro: o modelo cobre taxas e slippage estimados, **não** a
  fila do validator, o sandwich e a mudança de estado entre simular e executar.

## 9. Limites honestos deste playbook

- Os limites da tabela são os **publicados pelos provedores** na data das fontes; provedor muda
  limite sem avisar. Se aparecer `429` com os contadores **dentro** do teto, o preset está
  desatualizado — o lugar de corrigir é `src/rateBudget.ts`.
- `npm run free:check` mede, mas **uma execução não é uma amostra**: rode em horários diferentes,
  com a rede que você vai usar de verdade.
- **Preço pode vir de três fontes — e todas podem discordar.** O bot usa a primeira que responde
  (DexScreener → Jupiter → GeckoTerminal), registra qual foi e agora **compara com uma segunda
  opinião em amostra rotativa** (`marketBatch.verifications` / `divergences`). O que ainda não há:
  decisão automática sobre divergência (vetar entrada/reduzir posição) nem amostragem de TODOS os
  tokens a cada ciclo — a amostra existe para dar evidência barata, não para substituir regra.
- **Dependência de terceiro é risco operacional.** O feed da PumpPortal não é oficial da
  pump.fun; se ele cair ou mudar o formato, o contador `invalidMessages` sobe e a detecção volta
  a depender do WSS. Nada de capital deve repousar na premissa de que ele estará sempre lá.
- **RugCheck não garante nada.** Ele é um segundo par de olhos: ausência de risco apontado **não**
  é atestado de segurança, e um relatório "limpo" não eleva o score local. O que aprova ou reprova
  continua sendo as checagens on-chain feitas pelo próprio bot.
- Nada neste documento autoriza execução real. O caminho de entrada on-chain (S6) continua
  pendente e depende de autorização explícita + capital.

---

## S10 — Postgres de graça: dá para validar o voo único entre processos sem pagar nada?

**Resposta curta:** sim, e em dois níveis. Um deles não precisa nem de internet.

### Nível 0 — Postgres local em WASM, custo zero e sem instalar nada (para TESTAR)

```bash
npm run storage:selftest
```

Sobe um **PostgreSQL 18 compilado para WASM** (`@electric-sql/pglite`, devDependency) atrás de um
servidor de socket que fala o protocolo nativo, e executa pelo driver `pg` — o mesmo do runtime —
migração idempotente, disputa pelo mesmo mint, retomada de claim expirado, liberação só pelo dono,
espelho com upsert e o comportamento com o banco caído. **15/15 verificações** nesta máquina.

O que esse caminho **não** cobre: TLS, pooler do provedor, limites de conexão, permissões e a rede
real. Isso é o nível 1.

### Nível 1 — Postgres gerenciado no tier gratuito (para OPERAR)

Qualquer Postgres gerenciado serve, porque o adaptador usa **SQL padrão** (índice único parcial,
`JSONB`, `TIMESTAMPTZ`): não há dependência de extensão paga nem de recurso específico de provedor.

| Provedor | Tier gratuito (verificar vigência — muda) | Observação prática |
|---|---|---|
| Neon | projeto grátis com limite mensal de armazenamento/compute, escala a zero | `?sslmode=require`; conexão direta para o bot (não precisa de pooler para 1 processo) |
| Supabase | projeto grátis com banco incluído | use a **connection string direta** do banco, não a do pooler, para o bot |
| Railway / Render | créditos/camadas gratuitas limitadas | aceitam Postgres padrão |

**Regra de custo:** o bot usa **uma** conexão (`pg.Client`, sem pool) e escreve por espelho. O
volume é de dezenas de registros por operação, não de milhares por segundo — o tier gratuito é
suficiente para testar e para operar em escala de canário.

**Antes de confiar, valide contra o banco real** (o que o Nível 0 não prova):

```bash
export DATABASE_URL="postgres://...?sslmode=require"
npm run storage:migrate   # idempotente; só aditivo (não existe DROP/TRUNCATE neste schema)
npm run storage:check     # versão do schema, contagens, claims ativos, guarda de entrada
```

Se `storage:check` disser `OK` e `entryGuard.allowSign=true`, o bot pode ser ligado com
`HFT_STORAGE=postgres`. Se o provedor dormir (escala a zero) e a conexão cair, o bot **não** perde
nada: o JSON continua sendo escrito, o espelho registra a falha em `writeFailures` e a entrada real
recusa enquanto o banco não voltar (`STORAGE_UNAVAILABLE`). Nenhum resquício de "caiu o banco,
então ignoramos a trava".

**Aviso de segurança:** a `DATABASE_URL` carrega usuário e senha. Ela vive em variável de ambiente
(nunca em código, nunca comitada, nunca impressa — o log mostra só host/porta/base), e o banco
guarda decisões de operação, então trate a credencial como chave de operação: rotacione se vazar.

### O que o S10 NÃO é

- não é a fonte operacional (o JSON continua sendo; o banco é espelho);
- não substitui backup do arquivo JSON;
- não é guarda NA CADEIA: uma entrada feita por outra ferramenta, fora do bot, continua invisível;
- não autoriza entrada real. `HFT_REAL_ENTRY_ENABLED=0` segue sendo o default.

### S12 — saída fail-closed e teto de perda (custo zero)

O S12 não adiciona nenhuma dependência, serviço ou chamada paga: ele **usa a leitura de saldo que a
saída já fazia** (`getParsedTokenAccountsByOwner`, já coberta pela cota de leitura do plano
gratuito) com retry limitado e um teto de perda diária. A verificação de resíduo acrescenta UMA
leitura por fechamento (com retry só em caso de falha) — no pior caso, 3 leituras. Não há provedor
novo, não há tier pago, e o teto de perda não depende de nenhum dado externo: é aritmética sobre as
pernas já medidas.

### S13 — entrega com fallback: o que muda na camada gratuita

O fallback por RPC (`HFT_RPC_FALLBACK_ON_JITO_FAIL`, default ligado) **não é** um caminho extra
gratuito de landing: ele consome cota de ENVIO do plano de RPC, e no tier gratuito essa cota é
pequena (Helius Free: 1 envio/s). Ele existe para o caso em que a alternativa é pior — **capital
preso** porque o block engine aplicou rate limit. Na prática: com um provider gratuito, conte com
*uma* tentativa de saída por vez, e a corrida Jito+staked (paga) é o upgrade que muda a taxa de
landing — não o fallback.

### S14 — reconciliação do histórico: custo em créditos de leitura

A reconciliação (`npm run reconcile`, §5.5 do `OPERACAO.md`) é **a única parte do projeto que gasta
cota para OLHAR PARA TRÁS**: cada registro reconciliado custa **2 `getTransaction`** (entrada +
saída) — a mesma chamada que o S11 já faz na confirmação. Não há provedor novo, não há tier pago e
nada é enviado à rede.

Na aritmética do plano:

- No Helius Free (1M créditos/mês), `getTransaction` custa 1 crédito cada: **100 desfechos
  reconciliados = 200 créditos** — 0,02% do plano. O teto que morde continua sendo o de **10 req/s**:
  o script é sequencial (2 requisições por item), então não há rajada.
- Use `--limit` para reconciliar em lotes e **sempre comece pelo dry-run** (default): ele mede e
  relata por 2 créditos por item sem gravar nada.
- O que **não** é gasto: nenhuma transação é assinada ou enviada, nenhum priority fee, nenhum tip.
- O relatório é gravado em `data/` (fora do git), então reconciliar não infla o repositório.

**Limite honesto:** reconciliar transforma registro antigo em amostra legível — não transforma
histórico ruim em estratégia validada. Se o histórico for pequeno demais, o resultado honesto
continua sendo "sem dados suficientes".
