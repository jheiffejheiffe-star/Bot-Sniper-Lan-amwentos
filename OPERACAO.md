# OPERAÇÃO — como rodar este bot e o que esperar de cada comando

Este documento existe para uma pergunta só: **"está funcionando?"** — e para que a resposta
venha de medição, não de impressão. Ele não repete a arquitetura (isso está no `AUDIT.md`);
ele diz **o que rodar, o que olhar e o que NÃO concluir**.

Regra que vale para todo o resto: **nenhum número é prova de nada se não tiver sido medido
nesta instalação.** O painel mistura medição real com painéis simulados; a interface agora
declara quais são quais (banner no topo, fonte: `GET /api/system-truth`).

---

## 1. Estado atual do sistema (o que existe e o que NÃO existe)

| Capacidade | Estado | Como verificar |
|---|---|---|
| Detecção de lançamentos (WSS `logsSubscribe`) | ✅ implementada | `GET /api/health` → `detection.socketOpen` e `eventCount` |
| Triagem de token (mint/decimais/estrutura) | ✅ implementada | `GET /api/audit-token?mint=…` |
| Entrada em **shadow** (cotação → montagem → `simulateTransaction`, sem assinar) | ✅ implementada | `GET /api/shadow-entries` |
| Posições **PAPER** com preço real de mercado | ✅ implementada | `GET /api/positions` |
| Saída PAPER (stop/alvo/trailing, sem on-chain) | ✅ implementada | `GET /api/positions` + `GET /api/logs` |
| Idempotência de execução (intenções, trava de voo único) | ✅ implementada | `GET /api/execution-intents` |
| Reconciliação posição × carteira (`POSITION_DESYNC`) | ✅ implementada | `GET /api/positions/desync` |
| Status de landing Jito + tip floor real | ✅ leitura implementada | `GET /api/jito/bundle-status`, `GET /api/jito-tips` |
| **Entrada REAL on-chain (compra, S6)** | ✅ implementada e **DESLIGADA por default** (exige `RUNTIME_MODE=LIVE` + `LIVE_TRADING_ENABLED=true` + `HFT_REAL_ENTRY_ENABLED=1`, com teto canário) | `GET /api/real-entry` → `readiness` |
| Ingestão gRPC/yellowstone (S7, aditiva) | ✅ implementada e opt-in (`HFT_INGEST=grpc` + `GEYSER_GRPC_URL`) | `GET /api/health` → `detection.grpcFastPath` |
| Envio paralelo Jito/staked/RPC (S8, aditiva) | ✅ implementada e opt-in (`HFT_PARALLEL_SEND=1`) | `GET /api/real-entry` → `parallelSend` |
| **Validação estatística da estratégia (S9)** | ✅ implementada — com regra de exclusão explícita; **sem amostra** até acumular desfechos | `GET /api/performance` → `verdict`, `coverage` |
| **Persistência (S10)** | ✅ JSON local (default) ou **Postgres espelhado** opt-in, com voo único entre processos | `GET /api/storage` → `guarantee`, `entryGuard` |
| Painéis de telemetria/score/geyser do dashboard | ⚠️ **simulados (RNG no servidor)** | `GET /api/system-truth` → `simulatedEndpoints` |

Consequência prática: o bot **detecta, analisa, simula, registra, gerencia posições e — quando as
três declarações estão ligadas — compra de verdade** (com canário e travas). No default, ele NÃO
compra e todo "PnL realizado" é de papel. E existe uma diferença que o painel faz questão de
mostrar: há desfecho **medido on-chain** e há **estimativa de preço**; os dois nunca entram na mesma
conta (`GET /api/performance` → `coverage`, `exclusionsByReason`).

---

## 2. Do zero ao rodando (VPS ou máquina local)

```bash
# 1. dependências (node_modules NÃO é versionado)
npm install

# 2. configuração: copie e edite — NUNCA comite o .env
cp .env.example .env
$EDITOR .env

# 3. validação estática + testes (não toca rede nem banco operacional)
npm run lint
npm run test                 # suíte de segurança/regressão (contagem impressa no fim)

# 4. PROVA DE FUNCIONAMENTO no SEU ambiente (read-only: nada é assinado/enviado)
> **Plano gratuito:** para rodar tudo com camadas gratuitas (RPC/mercado/execução),
> siga `GRATIS.md` e meça a sua rede com `npm run free:check` — ele imprime p50/p95 do RPC,
> notificações do WebSocket, latência de DexScreener/Jupiter/Jito e os tetos de cota aplicados.

npm run smoke                # --quick pula os estágios de rede mais lentos

# 5. verificação de endpoints (RPC, programas on-chain, Jito, Jupiter)
npm run verify:endpoints

# 6. servidor (dev, com hot reload da UI)
npm run dev
#    ou produção:  npm run build && npm start
```

O servidor escuta em **127.0.0.1:3000** por padrão. Para expor deliberadamente:
`HFT_BIND_HOST=0.0.0.0` — e, nesse caso, **defina `ADMIN_TOKEN`** (sem ele, os POSTs ficam
bloqueados por fail-closed em produção, e em dev liberados apenas porque não há capital real).

### Variáveis que importam (todas em `.env.example` com comentário)

| Variável | Para que serve | Valor seguro para começar |
|---|---|---|
| `RPC_ENDPOINT` / `RPC_WEBSOCKET` | RPC dedicado (o público é rate-limited) | seu provedor (Helius/Triton/QuickNode…) |
| `RUNTIME_MODE` | `PAPER` / `SHADOW` / `LIVE` (fail-closed: ausente = PAPER) | `PAPER` |
| `LIVE_TRADING_ENABLED` | segunda declaração exigida para LIVE | ausente/`false` |
| `ADMIN_TOKEN` | autentica rotas POST | obrigatório se expuser a porta |
| `OPERATIONAL_PRIVATE_KEY` | chave da hot wallet (**só em LIVE**) | ausente enquanto não houver LIVE |
| `JITO_UUID` | autenticação do block engine (header, nunca na URL) | preencha se tiver plano |
| `JITO_TIP_PERCENTILE` | política de tip derivada do tip floor real | `p75` |
| `MAX_TIP_BPS` | teto do tip em bps do capital | `50` |
| `HFT_DESYNC_INTERVAL_MS` | intervalo da reconciliação posição × carteira | `60000` |
| `HFT_DESYNC_MIN_AGE_MS` | idade mínima para acusar fantasma | `120000` |

---

## 3. "Funcionou?" — o que olhar depois de subir

```bash
curl -s localhost:3000/api/system-truth      | python3 -m json.tool | head -40
curl -s localhost:3000/api/health            | python3 -m json.tool
curl -s localhost:3000/api/positions/desync  | python3 -m json.tool
curl -s localhost:3000/api/execution-intents | python3 -m json.tool
curl -s localhost:3000/api/shadow-entries    | python3 -m json.tool
```

Como LER cada resposta (fato → interpretação):

| Campo | Fato | Interpretação correta | Interpretação ERRADA |
|---|---|---|---|
| `detection.socketOpen` | socket WS aberto ou não | sem socket não há detecção | — |
| `detection.eventCount` | nº de lançamentos vistos | a prova de detecção é este número CRESCER | "degraded=false quer dizer que estou detectando" |
| `shadowEntries.count` | nº de simulações de entrada | prova que cotação+montagem+simulação funcionam | "count>0 quer dizer que comprei" |
| `positions` | posições no banco local | `mode: paper` = papel; `mode: live` = real | somar os dois em PnL |
| `execution-intents.activeCount` | intenções não resolvidas | bloqueiam nova assinatura na mesma posição | "o bot travou" (é proteção) |
| `desync.snapshotAvailable` | consegui ler a carteira? | `false` = NÃO houve comparação | "a carteira está vazia" |
| `desync.summary.phantom` | posições abertas sem token na carteira | confirmar no explorador antes de agir | corrigir automático |
| `tip floor available:false` | fonte não respondeu | a recomendação de tip fica nula (correto) | "o tip é 0" |

---

## 4. Primeira hora, na ordem (checklist)

1. `npm install && npm run test` → todos verdes (o runner imprime `🏆 N TESTES PASSARAM`).
2. `npm run smoke` → todos os estágios ✅ (no seu ambiente com egress).
3. `npm run verify:endpoints` → exit 0. **Se falhar, não ligue nada de LIVE.**
4. `npm run quarantine` (dry-run) → revise as posições classificadas.
   Depois, **com o servidor PARADO**: `npm run quarantine -- --apply`.
5. `npm run dev` → abra o painel, leia o **banner de verdade** no topo.
6. Deixe rodando em PAPER e observe por tempo suficiente para ver `eventCount` subir e
   aparecerem `shadow-entries`. Se `eventCount` ficar em 0 com `socketOpen=true`, o problema
   é a *filtragem* de logs (programas/hints), não a conexão.
7. **Se for usar o fast path gRPC** (S7), prove o canal no SEU ambiente antes de ligar:
   `npm run grpc:check -- --seconds 30` → `VERDICT: canal PROVADO` (updates > 0). Read-only:
   nada é assinado nem enviado. Sem isso, `HFT_INGEST=wss` (o default) já cobre todos os programas.
8. **Se for usar a rota NATIVA de compra** (instrução montada do IDL, sem agregador), valide o
   layout contra a rede antes de tudo:
   `npm run pump:dryrun -- <mint> --payer <sua_chave_PUBLICA>` → verdict `err: null`.
   O script **não assina e não envia nada** (simulação com `sigVerify: false`).
9. Só depois de dias de dado medido — e nunca antes de `npm run replay` mostrar expectativa
   positiva líquida de custos — considere LIVE, que exige as três declarações do item abaixo.

---

## 5. Modos: o que cada um faz de verdade

| Modo | Assina? | Envia? | O que grava |
|---|---|---|---|
| `PAPER` | não | não | posições `mode: paper`, trades `status: paper`, decisões com preço real |
| `SHADOW` | não | não | registro de simulação (`simulateTransaction`), nenhuma transação |
| `LIVE` | sim (exige duas declarações + chave + `ADMIN_TOKEN` + RPC https) | sim, **quando o caminho existir** | trades `mode: live` com assinatura real |

`LIVE` sem todas as condições **não sobe** (exit 1) — é configuração fatal, não aviso.

### 5.0 Transportes: detecção e envio

| Capacidade | Default | Como ligar | O que muda |
|---|---|---|---|
| Detecção WebSocket (logsSubscribe) | **ativa** | — | cobre Raydium/CPMM/pump/Meteora; para o pump exige `getTransaction` (`confirmed`) para obter o mint |
| Fast path gRPC (S7, Yellowstone) | **desligado** | `GEYSER_GRPC_URL` + `GEYSER_GRPC_TOKEN` (e `HFT_INGEST=grpc`) | assina TRANSAÇÕES do pump em `processed`; o mint vem do `CreateEvent` do stream — sem espera de `confirmed` e sem `getTransaction`. É **aditivo**: o WSS continua |
| Envio paralelo (S8) | **desligado** | `HFT_PARALLEL_SEND=1` (+ `HFT_STAKED_SENDER_URL`, `HFT_SEND_RPC_DIRECT`) | os MESMOS bytes assinados saem por Jito + sender com stake + RPC ao mesmo tempo; o primeiro aceite vence |

Os dois são opt-in por um motivo comum: **cada caminho novo é um custo novo (cota, segredo, taxa) e
uma responsabilidade nova**. Ligados, ambos são declarados em `GET /api/real-entry` (`ingest`,
`parallelSend`) — e o que não foi medido aparece como não medido, nunca como número.

`aceito` continua ≠ `executado`: no S8, ganhar a corrida significa "um caminho aceitou os bytes";
a posição só existe com confirmação e slot observados.

### 5.1 Caminho de compra (S6) e a rota de entrada

| Rota (`HFT_ENTRY_ROUTE`) | Como executa | Pré-requisito |
|---|---|---|
| `aggregator` (**default**) | cotação + transação do Jupiter | rota existente para o mint |
| `native` | instrução `buy_exact_sol_in` montada do IDL pinado (`assets/pump-idl-excerpt.json`), sem round-trip de agregador | `npm run pump:dryrun` com `err: null` **e** anti-drift do IDL `ok: true` no boot |

Ligar a entrada real exige **três** declarações: `RUNTIME_MODE=LIVE` + `LIVE_TRADING_ENABLED=true`
+ `HFT_REAL_ENTRY_ENABLED=1`. Entrada automática exige ainda `HFT_AUTONOMOUS_ENTRY=1`.
Estado vigente em `GET /api/real-entry` (`entryRoute`, `idlDrift`, `readiness.allowed`).

**Anti-drift do IDL:** no boot, o bot lê a conta `global` e a `fee_config` e confere owner +
discriminador + tamanho contra o IDL pinado. Resultados possíveis: `confere` (ok), `IDL_DRIFT`
(não confere — **fatal** na rota native) e `IDL_NAO_VERIFICADO` (RPC inalcançável: **não** é
sucesso nem drift, e a rota native fica bloqueada). Na rota `aggregator` o drift é aviso alto,
não derruba o boot — a rota não usa o layout.

---

### 5.2 Validação estatística (S9) — a única resposta honesta para "está funcionando?"

`GET /api/performance` não responde "sim" ou "não": ele monta o conjunto de desfechos com **PnL
líquido medido on-chain**, conta o que ficou de fora com o motivo, e só então dá um veredito
qualificado.

```bash
curl -s localhost:3000/api/performance | python3 -m json.tool | head -40
curl -s "localhost:3000/api/performance?limit=2000"   # amostra maior (exige Postgres ligado)
```

Como ler a resposta, na ordem:

1. **`source`** — de onde vieram os dados (`json local` ou `postgres`), quantos registros foram
   lidos e se houve truncamento. Se a fonte é o JSON local, o teto de 50 trades está na resposta:
   métrica sobre histórico truncado não é métrica da operação.
2. **`coverage`** — quantos desfechos têm número medido, quantos são estimativa de preço e quantos
   não têm número. `missingShare` alto significa que a conclusão é sobre uma minoria.
3. **`exclusionsByReason`** — por que cada registro ficou de fora (perna de entrada, modo paper,
   sem medição on-chain, tentativa falhada). Um motivo que cresce muito é um sinal de processo.
4. **`metrics`** — expectância, win rate, profit factor, drawdown, custos medidos (fees, tips).
5. **`verdict`** — `sem_dados` · `amostra_insuficiente` (piso de 100 desfechos) ·
   `indistinguivel_de_zero` (o IC 95% da média contém zero) · `edge_negativo` · `candidato_a_edge`.
   `candidato_a_edge` **não** é "lucrativo": é "a amostra atual não permite descartar edge positivo".
   `whatWouldChangeIt` diz, em português, o que mudaria a conclusão.

Regras que o endpoint aplica e que você pode conferir no código (`src/outcomeLabels.ts`):

- **o PnL é do CICLO: `ΔSOL(entrada) + ΔSOL(saída)`**, medido nas duas transações (S11). Sem as duas
  pernas, o campo `pnlNetSol` é `null` e o que existe é a **receita da venda** (`saleProceedsSol`),
  com nome próprio — receita não é lucro;
- medição de perna única tem rótulo próprio (`single_leg_*`), aparece em
  `coverage.singleLegMeasured` e fica **fora** da validação;
- percentual de posição é **estimativa de preço** (não inclui tip, priority fee, base fee nem
  rent) → rótulo `estimated_*`, excluído da conclusão, mantido para diagnóstico;
- PnL sem assinatura/medição on-chain vira `unresolved`, nunca zero;
- `mode=paper` não entra, mesmo com PnL positivo;
- empate só com |PnL| ≤ 0,000001 SOL (1 base fee).

**Como saber se o ciclo está sendo medido:** em `coverage`, `measured` é o número de ciclos com as
duas pernas e `singleLegMeasured` é o de medições parciais. Se `singleLegMeasured` crescer, a
cobertura está furada — `coverage.notes` diz o motivo (perna de entrada ausente, RPC sem histórico)
e a correção é medir a entrada, não reinterpretar o número parcial.

**Divergência de janela** aparece quando a carteira move SOL por fora do ciclo (outra posição,
transferência, fee avulsa): o PnL continua exato — cada delta é da sua transação — mas o relatório
declara que a carteira não estava dedicada àquela operação. `HFT_PNL_WINDOW_CHECK=1` acrescenta uma
segunda conferência por `getBalance` (custa 1 RTT na saída; a conferência por saldos das próprias
transações já acontece sem configurar nada).

### 5.3 Postgres (S10) — voo único entre processos e histórico durável

**Por que ligar.** Em JSON o arquivo guarda **50 trades** e a trava de voo único vale **por
processo**: duas instâncias do bot na mesma carteira não se enxergam. Com Postgres, o claim é um
**índice único parcial** no banco — exatamente um processo entra por `(mint, side)` por vez, e o
histórico deixa de ser truncado.

**Ligar, na ordem (custo zero para testar):**

```bash
# 1. teste local, sem nuvem e sem daemon: Postgres em WASM + migração + disputa de claim
npm run storage:selftest

# 2. prepare o banco de verdade (Neon/Supabase free). DATABASE_URL no ambiente:
export DATABASE_URL="postgres://...?sslmode=require"
npm run storage:migrate     # aplica a v1 (idempotente, só aditiva)
npm run storage:check       # somente leitura: versão, contagens, claims, guarda de entrada

# 3. ligue o bot para o banco
HFT_STORAGE=postgres npm run dev
```

**O que você vai ver no boot:**

```
[Boot][Storage] espelho em Postgres ATIVO: voo único entre processos via entry_claims (TTL 300s)…
[Boot][Storage] só WARN/CRITICAL vão para o banco (HFT_STORAGE_MIRROR_LOGS=critical, default)
[Boot][Storage] Postgres pronto: schema v1, 12 trade(s), 3 posição(ões), 1 intenção(ões), 0 claim(s) ativo(s)
```

**Fail-closed (por decisão, não por bug).** Com `HFT_STORAGE=postgres`, o boot **aborta** (`exit 1`)
se: faltar `DATABASE_URL`; o valor do modo não for conhecido; o banco não responder; ou o schema
estiver atrás do esperado. Subir sem o árbitro que você acha que tem é pior do que não subir.

**Quando o banco cai com o bot no ar:** a operação continua (o JSON é sempre escrito; o espelho
apenas registra falhas em `writeFailures`), mas a **entrada real recusa** com
`STORAGE_UNAVAILABLE` enquanto o banco não voltar — porque o voo único entre processos não estar
disponível é uma proteção ausente, e o bot não assina confiando numa proteção ausente. Se o claim
não responder dentro de `HFT_STORAGE_CLAIM_TIMEOUT_MS` (1,5s), a entrada também recusa
(`STORAGE_CLAIM_TIMEOUT`).

**Estados possíveis da entrada, por storage** (visíveis em `GET /api/storage → entryGuard`):

| Situação | `allowSign` | Efeito |
|---|---|---|
| `HFT_STORAGE=json` | `true` | Segue como antes; a resposta declara "voo único POR PROCESSO" |
| Postgres conectado, schema v1 | `true` | Claim atômico antes de assinar; liberado no `finally` |
| Postgres fora do ar | `false` | `STORAGE_UNAVAILABLE` — recusa explicada, não erro genérico |
| Postgres com schema atrás | `false` | `STORAGE_SCHEMA_OUTDATED` + comando que resolve |

**Operação do dia a dia:** `GET /api/storage` mostra modo, saúde, contagens, claims ativos (mint,
dono, expiração) e a garantia vigente. Um claim com `expired: true` é normal depois de um crash: o
próximo processo o retoma automaticamente. **Nunca** libere claim de outro dono — a liberação é por
`claim_id`, e é isso que impede dois processos no mesmo mint.

### 5.4 Saída fail-closed e teto de perda (S12)

O caminho que decide o prejuízo é a SAÍDA. Três invariantes valem nos **dois** caminhos de venda
(fechamento manual e saída autônoma):

1. **Quantidade vem da cadeia.** Leitura do saldo com retry + backoff; se não puder ser lida
   (`EXIT_ABORTED_BALANCE_UNREADABLE`) ou for zero (`EXIT_ABORTED_ZERO_ONCHAIN_BALANCE`), a saída
   ABORTA: nenhuma ordem é construída, nada é estimado e a posição continua aberta. Antes disso, um
   saldo zero/ilegível virava `sizeSol / entryPrice` — e a ordem ia para a rede com essa quantidade.
2. **Fechamento só com prova de resíduo.** A posição só sai do banco quando a carteira comprova que
   não tem mais o token (tolerância declarada em `HFT_RESIDUAL_DUST_RAW`, para Token-2022 com
   transfer fee). Resíduo acima da tolerância ⇒ continua aberta e o resto é vendido no próximo
   ciclo; leitura falhou ⇒ continua aberta (não se apaga o que não se viu).
3. **Posição não-provada não assina.** `mode: live` **e** evidência on-chain de entrada são
   pré-requisito para gerir como real. Posição herdada sem `mode` é `unverified`: não assina saída,
   não é apagada e continua contando para EXPOSIÇÃO (lado conservador).

**Freios por resultado (ENFORÇADOS desde o S12):** `MAX_DAILY_LOSS_SOL` soma **só** PnL de ciclo
medido (as duas pernas) com data legível — ganho não abate perda e medido sem data fica declarado
fora da soma; ao atingir o teto, o kill switch é acionado (entradas param, saídas continuam).
`MAX_OPEN_POSITIONS` limita posições reais abertas. **Os dois estavam no `.env.example` e nunca
eram lidos pelo código** — config morta.

**O que isto NÃO é:** nenhuma configuração garante lucro. `GET /api/system-truth` → `exitSafety`
traz `limits` (declarado × não declarado, um por um), `dailyLoss` (com o motivo e a lacuna
declarada) e `notGuaranteed`.

## 6. Problemas comuns e o que eles NÃO significam

| Sintoma | Provável causa | NÃO conclua |
|---|---|---|
| `fetch failed` em tudo (RPC, Jupiter, Jito) | sem egress/firewall, `RPC_ENDPOINT` ausente | "o bot está quebrado" |
| `detection.degraded: true` | socket WS fechado | "não há lançamentos no mercado" |
| `shadowEntries.count: 0` | nenhum lançamento passou pelo filtro ainda | "a cotação está quebrada" |
| `desync.snapshotAvailable: false` | leitura de carteira falhou | "carteira vazia" |
| `execution-intents.activeCount > 0` | execução anterior sem desfecho provado | "pode vender de novo" (NÃO pode — é proteção) |
| `tip floor inacessível` | fonte fora do ar | "o tip recomendado é zero" |
| Painel mostrando P95/inclusion rate | **RNG do servidor** | qualquer decisão baseada nisso |

---

## 7. Onde está cada evidência (para não confiar em memória)

- `AUDIT.md` — cada achado (C1…C35) com o antes/depois e os limites do que foi verificado.
- `data/events.jsonl` — telemetria por evento (lançamento, avaliação, preço, ciclo de posição,
  entrada shadow). Base do `npm run replay`.
- `hft_operational_db.json` — estado operacional (posições, trades, intenções, logs).
  **Não versionado** (gitignored): dado de runtime pertence ao ambiente, não ao repositório.
- `hft_operational_db.quarantine.*.json` — inventário da quarentena (não destrutiva).
- `GET /api/system-truth` — o que é medição e o que é simulação, agora.
- `GET /api/performance` — validação estatística com `source` (json local × postgres), `coverage`
  (medido × estimado × sem número) e `verdict` qualificado. Um veredito sem cobertura declarada não
  é evidência.
- `GET /api/storage` — modo de persistência, garantia vigente do voo único, contagens e claims
  ativos, mais o `entryGuard` (se o armazenamento permite assinar).
- Evidência executável: `npm run storage:selftest` (Postgres WASM + driver `pg`),
  `npm run storage:check` (banco real, somente leitura) e `AUDIT.md` Adendo 18.

---

## 8. O que NÃO está implementado (e não é segredo)

1. **Entrada real on-chain (S6)** — IMPLEMENTADA e **desligada por default**
   (`HFT_REAL_ENTRY_ENABLED=0`): `POST /api/real-entry` monta, pré-simula, assina e envia a compra
   quando as três declarações estão presentes, com teto de canário. Enquanto a variável não for
   ligada, todo PnL continua simulado. A **saída** continua dependendo das condições de venda já
   implementadas — leia `GET /api/system-truth` antes de tratar qualquer número como dinheiro.
   Limites conhecidos: sem idempotência entre processos; envio paralelo (S8) é opt-in; gRPC (S7)
   é opt-in e exige endpoint do operador.
2. **gRPC Yellowstone (S7)** — IMPLEMENTADO e **desligado por default**: sem `GEYSER_GRPC_URL` o
   runtime usa WebSocket (mais lento, com `getTransaction`). O fast path é aditivo, não substitui o
   WSS. Provedor gRPC de produção costuma ser pago — a ausência dele não impede operar.
3. **Idempotência entre processos** — RESOLVIDA em Postgres (S10): o claim é um índice único
   parcial no banco e vale ENTRE processos. Em `HFT_STORAGE=json` (default) continua valendo só
   POR PROCESSO, e `/api/storage` declara qual dos dois está em vigor. O que ainda NÃO existe é
   guarda NA CADEIA (uma entrada feita por outra ferramenta, fora do bot, é invisível).
4. **Postgres (S10)** — IMPLEMENTADO e opt-in: espelho write-through (o JSON nunca deixa de ser
   escrito), histórico durável, voo único entre processos e boot fail-closed. Não é a fonte
   operacional e não substitui backup do arquivo JSON.
5. **Painéis do dashboard** — 9 endpoints listados em `/api/system-truth` continuam gerando
   números com RNG. Eles estão DECLARADOS, não corrigidos.
6. **Validação estatística (S9)** — o cálculo existe e é honesto, mas **não há amostra**: sem ≥100
   desfechos com PnL líquido medido on-chain, `/api/performance` conclui `sem_dados` ou
   `amostra_insuficiente`. Nenhum resultado deste projeto foi validado estatisticamente ainda.
7. **PnL do ciclo (S11)** — a contabilidade agora exige as DUAS pernas medidas
   (`ΔSOL(entrada) + ΔSOL(saída)`); a versão anterior gravava o ΔSOL da venda como PnL "medido", o
   que inflava todo resultado pelo valor da entrada (ver `AUDIT.md` Adendo 19). Correção de
   aritmética provada por teste, mas **não exercitada com dinheiro real**: exige entrada ligada.
   Posições abertas antes desta versão não têm a perna de entrada e ficam declaradas como não
   medidas.
8. **Garantia de lucro** — NÃO existe e não pode existir por configuração: cada operação paga base
   fee, priority fee, tip, spread e slippage, e o ativo pode cair depois da compra. O que o S12
   garante é o LIMITE da perda (teto diário medido + kill switch + teto de posições) e a AUSÊNCIA
   de resultado fabricado. Painel que mostre "acerto garantido" está listado como RNG em
   `/api/system-truth`. Nada foi validado estatisticamente ainda (item 6).
