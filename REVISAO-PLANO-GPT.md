# Revisão técnica do plano do GPT (Fase 2 — "Plano de Correção do HFT Terminal")

**Data:** 2026-10-02
**Escopo da revisão:** cada bloco do plano confrontado com **o código que está neste repositório hoje**,
e cada afirmação de protocolo confrontada com **documentação oficial atual** (Jito, pump.fun).
**Regra aplicada:** nenhuma afirmação de protocolo foi aceita sem verificação; nenhum número foi estimado.

---

## Veredito em uma linha

O plano é **filosoficamente correto e operacionalmente atrasado**: ele descreve a correção do
snapshot **pré-auditoria** (o ZIP), não do código atual. Cerca de um terço dos itens marcados
como 🔴 "substituir" **já não existem naquela forma** — e a prioridade número 1 que ele propõe
separar (real × simulação) é de fato o próximo trabalho certo, mas por um motivo que o plano
não enuncia: **hoje qualquer modo pode assinar**, porque o choke point de assinatura não
consulta o modo de execução.

---

## 1. Fact-check bloco a bloco

Legenda: ✅ **JÁ FEITO** · 🟡 **PARCIAL** · 🔴 **ABERTO (e corretamente priorizado)** ·
⚫ **NÃO EXISTE NO CÓDIGO ATUAL** · ⚠️ **PREMISSA INCORRETA**

| # | Bloco do plano | Estado real no repo | Evidência medida |
|---|---|---|---|
| 1 | Separar REAL/PAPER/SHADOW/SIMULATION | 🔴 **ABERTO** — existe `LIVE_TRADING_ENABLED` (binário) + `readOnlyMode` + kill switch, não um `RuntimeMode` de 4 estados | `.env.example:44`; nenhum `RUNTIME_MODE` no código |
| 2 | Signer Guard único | 🟡 **CHOKE POINT JÁ EXISTE, GUARD NÃO** | `executeWithDecryptedKeypair()` em `src/security.ts:278`; **exatamente 2 call sites de assinatura** (`server.ts:835`, `server.ts:3529`). Ele checa *kill switch* e existência do cofre — **não checa o modo** |
| 3 | RBAC (VIEWER/OPERATOR/ADMIN) | 🟡 | POST global com `assertMutationAuthorized()` + `restrictToDev` para simulações. **Fail-open em dev** quando `ADMIN_TOKEN` ausente, e o servidor escuta em **`0.0.0.0`** (`server.ts:3897`) → ver Risco R1 |
| 4 | Configuração única + validação no boot | 🟡 | `assertConfigIntegrity()` roda **antes** de subir; falta a validação *por modo* ("LIVE não sobe sem X, Y, Z") |
| 5 | RPC pool com métricas reais | ✅ **FEITO** | `buildRpcNodeList()` deriva de `RPC_ENDPOINT` + `RPC_FALLBACKS`; latência inicial `NaN`, status `offline`/`degraded`. Não há mais latência sorteada no caminho operacional |
| 6 | Blockhash único e real | 🟡 | `RecentBlockhashCache` com `getLatestBlockhash("processed")`, invalidação por idade (45 s) e recusa de hash inválido. **Falta**: comparar `lastValidBlockHeight` com a altura corrente e reconstruir em `BlockheightExceeded` — hoje a expiração só aparece no timeout de confirmação |
| 7 | Jito Engine com status de landing | 🔴 **ABERTO — A MELHOR CONTRIBUIÇÃO DO PLANO** | `getTipAccounts` existe e é usado em runtime; **`getBundleStatuses` e `getInflightBundleStatuses` não aparecem em lugar nenhum do repositório** |
| 7b | `sendBundle` correto | ✅ | `{ encoding: "base64" }`, máx. 5 tx, tip validado contra conjunto oficial + teto em bps (`src/realExecution.ts:700-745`) — consistente com a doc atual do Jito ("base64 recommended, base58 deprecated") |
| 8 | Geyser/Data Plane real | 🟡 | `GeyserStreamClient` usa **WSS `logsSubscribe`** como plano real (com `GEYSER_GRPC_URL` configurável e handshake declarado). O endpoint `GET /api/geyser-stream` que diz "Geyser" é **fabricado** (12 `Math.random`) |
| 9 | `TokenDiscoveryEvent` normalizado | 🟡 | `LaunchEvent` já tem `mint/program/slot/receivedSlot/source/grpcLatencyMs/signature`. Falta `creator`, `quoteMint`, `tokenProgram` |
| 10 | "Substituir o builder manual do pump.fun" | ⚫ **NÃO EXISTE** | `LaunchSwapper.buildPumpFunBuyInstruction()` **lança `InfrastructureError` por decisão explícita** e não é chamado por ninguém (`src/realExecution.ts:896`) |
| 11 | "Eliminar o swap genérico da Raydium" | ⚫ **NÃO EXISTE** | `LaunchSwapper.buildRaydiumSwapInstruction()` idem (`:913`). Não há nenhum builder Raydium no código |
| 10b | "pump.fun exige `buy_v2`/`sell_v2`" | ⚠️ **RESOLVIDO PELA METADE** | Ver seção 2 — v2 existe, mas **não é obrigatório para pares em SOL** |
| 12 | Manter Jupiter isolado | 🟡 | O caminho **de saída** passou a usar o cliente único nesta rodada (C24). Entrada ainda não constrói transação nenhuma |
| 13 | Risk Engine com snapshot real | 🔴 **ABERTO** | `fetchRealOnChainTokenData()` lê mint/freeze authority via RPC (real) + DexScreener. Não há holders, concentração, idade de pool, clusters, sellability |
| 14 | Máquina de estados de decisão (BUY) | 🟡 | O pipeline tem estágios sequenciais com rejeição auditável, mas não há máquina de estados persistida com transições nomeadas |
| 15 | Máquina de estados de execução + idempotência | 🔴 **ABERTO** | Existe `exitLocks` + `status: "exit_pending"` + reconciliador. **Não existe `executionId` nem `idempotencyKey`** em nenhum lugar |
| 16 | Posição só depois de evidência on-chain | 🟡 | Vale para o caminho de saída (confirm → mede saldo → grava). Não existe caminho de entrada para validar |
| 17 | Exit com verificação de saldo | 🟡 | `measureExitEconomics()` lê `preBalances`/`postBalances` da tx confirmada; `reconcileStuckExits()` no boot. Falta estado explícito `POSITION_DESYNC` |
| 18 | Observabilidade separada real × sintético | 🟡 | **`src/telemetry.ts` (novo)** mede 7 estágios e declara `detection.measurable:false` sob WSS. O painel React continua sintético (≈155 `Math.random`) |
| 19 | Banir `Math.random` do LIVE | 🟡 **MAIS AVANÇADO DO QUE O PLANO SUPÕE** | Ver seção 3 — o caminho operacional está limpo; a sujeira está na camada de apresentação |
| 20 | JSON DB → PostgreSQL | 🔴 (mas **mal priorizado**) | Ver Risco R3 |
| 21 | Audit log por decisão | 🟡 | **`src/eventRecorder.ts` (novo)** grava `launch-event`/`assessment`/`price-observation`/`position-lifecycle` em JSONL. Falta o campo `executionId` correlacionando tudo |
| 22 | Testes em 4 níveis | 🟡 | 36 testes em `tests/safety.test.ts`. Falta o nível *shadow* (que depende da etapa 1) e o nível *replay* real (a infra existe, os dados não) |
| 23 | Shadow mode que constrói e NÃO envia | 🔴 **ABERTO — segunda melhor contribuição** | **`simulateTransaction` não é usado em nenhum lugar do repositório** |
| 24 | Paper sem `Math.random` | 🔴 | Hoje o "paper" registra posição a partir de preço cotado; não modela fill, custos por evento nem latência observada |
| 25 | Canary | 🔴 | Sem gates mensuráveis — ver seção 6 |

---

## 2. Onde o plano precisa de correção factual (verificado)

### 2.1 pump.fun `buy_v2`/`sell_v2` — existem, mas não são o que o plano diz

**Confirmado (documentação oficial `pump-fun/pump-public-docs`):** existem `buy_v2`, `sell_v2`,
`buy_exact_quote_in_v2`. Mas a mesma fonte diz, textualmente:

> *"There are no trade interface changes. **buy, sell, buy_v2, sell_v2**, buy_exact_quote_in_v2 and the
> PumpSwap buy / sell take the same accounts and arguments for every coin."*

> *"When using the new instructions (buy_v2, sell_v2, buy_exact_quote_in_v2) for **SOL-paired meme coins**,
> there will be **no extra cost** compared to the legacy instructions."*

Ou seja: **v2 não é uma obrigação para sniping de pares em SOL** — é o caminho para moedas com
*quote mint* (stable/Token-2022), introduzido junto com `create_v2` (que cria "spl-22" com moeda de
cotação). A implicação prática para o nosso caso:

- Se a estratégia é **sniping de lançamentos pareados em SOL** (é), o `buy` legado continua válido
  e mais barato em complexidade. O adaptador deve **decidir por par**: `NATIVE_MINT` → builder
  SOL-paired; `quote_mint` ≠ SOL → `*_v2` (e aí o risco sobe: Token-2022 traz *extensions*, inclusive
  transfer hooks).
- Discriminadores de v2 (fonte **secundária** — `docs.solanatracker.io`): `buy_v2 = 0xb817ee6167c5d33d`,
  `sell_v2 = 0x5df6823ce7e940b2`. **Não usei estes números em nenhum código** — antes de implementar,
  confirmar no IDL oficial (`pump-public-docs/idl/pump.json`). O IDL que eu **verifiquei** diretamente
  confirma o layout do `buy_exact_sol_in` legado com 16 contas (índices 12/13 volume accumulators,
  14/15 `fee_config`/`fee_program`) — que é o layout que o plano classifica como desatualizado.

### 2.2 `getTipFloor()` não é método do Block Engine

O Jito expõe, no **mesmo host** do block engine, os métodos JSON-RPC `getTipAccounts`, `sendBundle`,
`getBundleStatuses`, `getInflightBundleStatuses` (e `sendTransaction`). O **tip floor** é um
**endpoint REST em outro host**: `https://bundles.jito.wtf/api/v1/bundles/tip_floor` (existe também um
`tip_stream` WebSocket).

Não é um erro fatal — mas implementar `getTipFloor()` "no JitoEngine" como se fosse JSON-RPC do
block engine levaria a um 404 silencioso no meio do cálculo de tip. O plano deve declarar
**dois clientes**: `JitoBlockEngineClient` (JSON-RPC) e `JitoTipOracle` (REST/WS).

### 2.3 "Landing ≠ submissão" — correto, e a doc oficial confirma literalmente

> *"This does not guarantee the bundle will be processed or land on-chain. To check the bundle status,
> use `getBundleStatuses` with the `bundle_id`."* — docs.jito.wtf

E o detalhe que o plano não menciona: **`getBundleStatuses` retornando `Landed` ainda não é o estado
final**. A autoridade sobre o estado da conta é o RPC (`getSignatureStatus`/`getTransaction`), porque
é dele que vem o que está comprometido. O fluxo correto usa **os dois**: Jito para distinguir
"não chegou ao leilão / não foi selecionado / pousou" e RPC para confirmar compromisso. Um
`Landed` do Jito sem confirmação do RPC é **indeterminado**, não sucesso.

### 2.4 Raydium: não existe "opcode + amount" na Solana

O plano fala em não executar "uma instrução genérica baseada apenas em opcode + amount". Solana
não tem opcodes de programa: cada instrução é `program_id + accounts[] + data[]`. O ponto
**substantivo** do plano está certo e o código já o aplica: um swap da AMM v4 exige ~17 contas
derivadas do estado do pool (vaults, OpenBook market, bids/asks, event queue) — o comentário do
próprio repo diz isso ao desabilitar o builder. Não há nada a "remover"; há algo a **implementar
com SDK oficial** ou a **delegar à Jupiter** (ver comparação na seção 4).

---

## 3. O `Math.random()`: a sujeira não está onde o plano procura

Medição direta (linhas de código, excluindo comentários):

| Camada | Ocorrências | Situação |
|---|---:|---|
| `server.ts` — 7 endpoints de apresentação | **76** | `hft-telemetry` (24), `predictive-score` (15), `geyser-stream` (12), `simulate-fork` (11), `simulate-snipe` (8), `metrics` (5), `submit-bundle` (1) |
| `server.ts` — caminho operacional | **1** | sufixo de `correlationId` (`corr_auto_<ts>_<rand>`) — inócuo, mas ainda aleatório |
| Componentes React (`src/components/*`) | **155** | Dashboards inteiros alimentados por RNG: `ProductionReadinessCenter` (23), `MultiChainJupiterBridge` (16), `MissionControl` (14), `HftProfiler` (10), `ShadowVsRealityDashboard` (9), `ObservabilityCenter` (9), `MempoolScanner` (8), `EvidenceCenter` (8)… |
| `src/realExecution.ts` | 1 | em comentário |
| **Total** | **237** | |

Conclusão que muda a prioridade: o Bloco 19 ("banir `Math.random` do LIVE") está **quase satisfeito
no caminho operacional**. O problema real é que **a interface e a API mentem**: existe um
`ShadowVsRealityDashboard` que não tem nem shadow nem reality, um `ProductionReadinessCenter` que
calcula prontidão com RNG, e um `/api/geyser-stream` que devolve hex aleatório. Isso é
**risco de decisão** (o operador olha o painel para decidir) e é o que o Bloco 18 tenta resolver —
mas o plano o coloca em 18º lugar.

---

## 4. Comparação técnica das alternativas (onde o plano escolhe sem comparar)

### 4.1 Execução de entrada: Jupiter-first × adaptadores nativos

| Critério | Jupiter (`/swap` ou `/swap-instructions`) | Adaptador nativo (pump SDK/IDL) |
|---|---|---|
| Correção do layout de contas | Alta — quem monta é o agregador | Depende de **nós** mantermos o layout (mudou 2× em 2025: volume accumulators; fee_config/fee_program) |
| Latência adicional | 1–2 RTT HTTP (~30–120 ms de um host comum; menos colocado) | 0 RTT de terceiro (contas via RPC, que já é necessário) |
| Cobertura | Qualquer rota com liquidez | Só o programa implementado |
| Risco de deprecação | Já ocorreu (v6 sunset) — mitigado por `JUPITER_BASE_URL` | IDL pode mudar sem aviso no changelog |
| Custos | Inclui a rota ótima + fee do agregador embutido no preço | Fee do programa direto |
| Manutenção | Baixa | Alta |
| Adequação a *sniping de lançamento* | Ruim no instante 0 (pool recém-criado pode não ter rota indexada ainda) | **Melhor** — é o caso de uso canônico |

**Recomendação técnica:** **Jupiter-first para tudo o que não é o primeiro segundo**, e adaptador
nativo **apenas** para `pump.fun` em par SOL, construído a partir do IDL oficial (ou via
`@pump-fun/pump-sdk`), validado por `simulateTransaction` **e** por uma tx canary de valor mínimo.
Nada de builder manual "de cabeça" — o repo já decidiu isso por bem (fail-closed) e essa decisão
deve ser preservada até existir SDK verificado.

Observação de dependência: hoje **não há `@solana/spl-token` nem `@pump-fun/pump-sdk`** no
`package.json`. Implementar o adaptador nativo implica adicionar dependência oficial — decisão
consciente, não acidente.

### 4.2 Persistência: JSON × PostgreSQL agora

O plano lista a migração como necessária ("o caminho de trading deverá posteriormente utilizar
PostgreSQL"). **Concordo com o "posteriormente" e discordo do "necessário".** O que quebra capital
não é o formato do armazenamento: é a **atomicidade das transições de estado**. Prova empírica
deste repositório: 3 posições ficaram presas em `EXIT_PENDING` num JSON DB — o defeito era ausência
de reconciliador, não ausência de SQL. Migrar para Postgres sem máquina de estados e idempotência
apenas move o mesmo bug para um banco melhor.

**Ordem correta:** (1) `executionId` + `idempotencyKey` + log append-only por intenção (a base já
existe: `data/events.jsonl`); (2) máquina de estados persistida; (3) só então Postgres, quando
houver necessidade real (múltiplos processos, consultas relacionais, retenção longa).

---

## 5. Contradições internas do plano (a corrigir antes de implementar)

1. **`PAPER` é definido duas vezes, de formas diferentes.** Bloco 1: "dados reais, nenhuma transação
   assinada". Bloco 24: "real data + simulated execution" com preço/liquidez/slippage/fees/latência
   observados. Isso é *shadow* com preenchimento modelado, não a mesma coisa que o Bloco 1 define.
   **Definição que proponho (e que torna os modos testáveis):**
   - `SIMULATION` — dados sintéticos, permite RNG. Nada observado.
   - `SHADOW` — dados reais; **constrói** a transação; **simula** (`simulateTransaction`); **não assina**;
     grava o que teria acontecido e acompanha o resultado real.
   - `PAPER` — dados reais; sem construção de transação; contabilidade com preço observado e custos
     modelados declarados (não é "fill real").
   - `LIVE` — único autorizado a assinar/enviar.
2. **O gate da seção 34 exige `REAL TRANSACTION ✅` *antes* de `SHADOW TEST`, `PAPER TEST` e
   `FAILURE TEST`.** Não é exequível: a única forma de ter transação real é enviar uma — e é
   exatamente para isso que existe o canary, que aparece *depois*. A ordem correta é
   shadow → paper → failure → canary → live.
3. **`Wallet rotation` como operação de ADMIN via API** é uma superfície de ataque, não uma feature:
   rotacionar carteira quente envolve mover SOL, recriar ATAs, encerrar posições e reapontar o vault.
   Deve ser **procedimento fora de banda** (runbook), no máximo com um endpoint que apenas *valida e
   reporta* a prontidão da rotação.
4. **Ausência do item mais urgente:** o plano não menciona a **quarentena do
   `hft_operational_db.json`** (histórico fabricado, 12 posições com tokens que nunca existiram).
   Um dashboard "real" lendo esse banco continua mentindo mesmo depois de toda a Fase 2.

---

## 6. Substituindo a checklist da seção 34 por gates mensuráveis

A lista atual ("REAL DATA ✅, REAL RISK ✅…") é uma lista de adjetivos: não define quem mede, quanto,
nem qual é o limite. Proposta de critério de aceite verificável:

| Gate | Métrica | Limite para avançar |
|---|---|---|
| Detecção | `telemetry.snapshot().perStageMs.enriched.count` e p95 | ≥ 500 eventos; p95 de detecção→auditoria **declarado como não-mensurável** (WSS) ou medido (gRPC) |
| Auditoria de risco | % de decisões com `evidence[]` preenchida | 100% (nenhuma decisão sem razão registrada) |
| Shadow | janela observada com trade counterfactual completo | ≥ 7 dias contínuos, ≥ 100 oportunidades, 0 assinaturas no caminho (verificado por teste) |
| Paper | expectativa líquida vs `baseline-hold` (motor de replay já pronto) | amostra ≥ `MIN_TRADES_FOR_CONFIDENCE`; custos reais e declarados |
| Falha | taxa de falha de saída + tempo de recuperação (`reconcileStuckExits`) | 100% das saídas falhas reconciliadas, 0 posições presas |
| Landing | `getBundleStatuses` × `getSignatureStatus` | 0 divergências não explicadas ("Landed sem confirmação" contabilizado) |
| Auditoria | reconstrução de uma decisão a partir do log (`executionId`) | 100% das decisões reconstruíveis ponta a ponta |
| Canary | capital máximo, perda diária máxima, nº máx. de trades | definidos em config e **aplicados por código**, não em prosa |

---

## 7. Sequência recomendada (merge do plano do GPT com o estado real)

| Etapa | Conteúdo | Por que nesta ordem |
|---|---|---|
| **0** | Medição + registro + replay | ✅ **feito nesta rodada** — é o instrumento de verificação de todas as etapas seguintes |
| **1** | `RuntimeMode` + **Signer Guard** (guardar o choke point que já existe) | 2 call sites de assinatura; mudança pequena, invariante testável, desbloqueia shadow/paper |
| **2** | Bearer/token em rotas sensíveis + **bind em loopback por padrão** + validação de config por modo | Fecha R1 antes de existir qualquer caminho que assine |
| **3** | Jito Engine real: `getBundleStatuses` + `getInflightBundleStatuses` + tip oracle (REST) + estratégia de tipada com feedback | É o que distingue "aceito" de "pousou"; hoje não existe |
| **4** | **Shadow real**: construir transação + `simulateTransaction`, gravar esperado × realizado, **sem assinar** | Valida o builder sem capital; impossível hoje (zero uso de `simulateTransaction`) |
| **5** | Máquina de execução com `executionId`/`idempotencyKey` sobre o log que já existe | Impede compra duplicada; correlaciona tudo |
| **6** | Posição por evidência on-chain + verificação de saída + estado `POSITION_DESYNC` | Generaliza o que já foi feito na saída |
| **7** | Data plane: gRPC Yellowstone para medir detecção (WSS continua fallback) + `TokenDiscoveryEvent` completo | Habilita o único estágio hoje não-mensurável |
| **8** | Inteligência de risco: **gravar features primeiro, pontuar depois** (holders, idade do pool, criador, sellability por simulação) | Sem rótulos não há como calibrar score; gravar é barato, pontuar cedo é perigoso |
| **9** | Adaptadores: Jupiter (pronto, isolar) → pump nativo via SDK/IDL → Raydium via SDK | Onde o capital é gasto, não onde o tempo é gasto |
| **10** | Shadow → Paper → Falha → Canary → Live, com os gates da seção 6 | Só depois de 1–9 |

---

## 8. Riscos que o plano não cobre

**R1 — Autenticação fail-open em servidor exposto.** O servidor escuta em `0.0.0.0` e o guard de
mutação **libera tudo** quando `ADMIN_TOKEN` não está definido e `NODE_ENV !== "production"`
(`src/security.ts:500-511`). Num host com a porta alcançável — a própria pré-visualização deste
ambiente, uma VPS com firewall mal configurado, um container em rede compartilhada — isso expõe
`POST /api/kill-switch`, `/api/positions/close`, `/api/co-location` sem autenticação. Correção
proposta: **bind em `127.0.0.1` por padrão**, com `HFT_BIND_HOST` explícito para expor; e exigir
token sempre que o bind for não-loopback, independentemente de `NODE_ENV`.

**R2 — A UI mentir é risco de decisão, não cosmético.** O plano trata observabilidade como Bloco 18.
Mas `ProductionReadinessCenter` usa RNG para calcular prontidão: o operador pode receber "pronto"
de um sistema que não está pronto. Isso é o mesmo defeito que o `/api/submit-bundle` tinha.

**R3 — Migração de banco como falso consolo.** Ver 4.2.

**R4 — Score de risco com precisão falsa.** "Wallet clusters" e "insider indicators" exigem dados
que não vêm do RPC base (holders, histórico de financiamento, co-ocorrência em bundles). Um score
determinístico alimentado por features ruins é **pior** que nenhum score: ele dá confiança
numérica a uma heurística não calibrada. Daí a ordem da Etapa 8 (gravar → rotular → calibrar).

**R5 — Token-2022 no caminho de sniping.** Se `create_v2` passa a admitir moedas com quote mint de
Token-2022 e extensions (transfer hooks, permanent delegate), o filtro de risco precisa inspecionar
o **token program** e as extensions antes de considerar um lançamento elegível. Um hook de
transferência pode tornar a saída impossível — honeypot nativo.

**R6 — `Landed` ≠ confirmado.** Já discutido em 2.3: não tratar status do Jito como estado final.

**R7 — Histórico fabricado no banco operacional.** Enquanto o `hft_operational_db.json` atual
existir, qualquer métrica de PnL/trades lida dele é lixo — inclusive as novas métricas reais, que
serão misturadas com as antigas.

---

## 9. Otimizações (depois do correto, nunca antes)

1. **Escolher nativo × Jupiter por medida**, não por opinião: com o shadow mode rodando, medir
   `detect → build` e comparar `build` local (pump SDK) contra `quote+swap` (Jupiter) no mesmo host.
2. **Estratégia de tipada com feedback**: registrar `tip pago × landed × slot` e usar os percentis do
   tip floor como entrada — hoje o tip é fixo (0.003 SOL) com teto em bps. "Tip maior" não é
   "melhor execução": é leilão, e o custo é 100% do resultado em posições pequenas.
3. **gRPC para detecção**: é o único estágio hoje estruturalmente não-mensurável
   (`detection.measurable:false` no `/api/latency`). Sem ele, otimizar detecção é adivinhação.
4. **Reduzir o caminho de leitura de preço**: hoje a cascata faz 1 chamada por posição por poll de 3 s;
   com o registro em JSONL já no lugar, dá para avaliar WebSocket de preço (DexScreener/Geyser de
   conta) e comparar cobertura × custo.

---

## 10. O que eu faria no próximo PR (pedindo autorização)

**Etapa 1 + Etapa 2, num único lote coeso** — as duas são pré-requisito uma da outra:

1. `src/runtimeMode.ts`: `RuntimeMode = SIMULATION | PAPER | SHADOW | LIVE`, resolução fail-closed a
   partir de env (`RUNTIME_MODE`, com `LIVE_TRADING_ENABLED` rebaixado a condição *adicional*),
   `assertCanSign()` como barreira única.
2. Ligar `assertCanSign()` dentro de `executeWithDecryptedKeypair()` **e** em
   `JitoBundleSender.submitBundle()` (defesa em profundidade: assinatura e construção de tip).
3. Teste que falha se existir caminho de assinatura fora do guard, e teste que prova
   SIMULATION/PAPER/SHADOW não assinam nem com `LIVE_TRADING_ENABLED=true`.
4. Bind padrão em loopback + token obrigatório quando o bind for não-loopback.
5. Config por modo: `LIVE` recusa subir sem `OPERATIONAL_PRIVATE_KEY`, `RPC_ENDPOINT`, `ADMIN_TOKEN`.

**Não farei**: migrar para Rust, trocar React/Express, adicionar Postgres agora, nem reescrever
componentes que funcionam. O que o plano classifica como "substituir" e que de fato está podre
(7 endpoints fabricados + 155 usos de RNG na UI) será tratado por **reescrita de apresentação** na
mesma esteira em que cada modo passa a exibir o que realmente aconteceu.
