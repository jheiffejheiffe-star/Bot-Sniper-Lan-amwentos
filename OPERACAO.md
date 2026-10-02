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
| **Entrada REAL on-chain (compra)** | ❌ **não implementada** (`LaunchSwapper` desabilitado) | `GET /api/system-truth` → `liveExecutionPath` |
| Painéis de telemetria/score/geyser do dashboard | ⚠️ **simulados (RNG no servidor)** | `GET /api/system-truth` → `simulatedEndpoints` |

Consequência prática: **hoje o bot detecta, analisa, simula, registra e gerencia posições de
papel — mas não compra.** Qualquer número de "PnL realizado" sem o caminho de entrada real é
simulação. O que existe de real é: detecção, cotação, simulação, telemetria e auditoria.

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
npm run test                 # 86 testes de segurança/regressão

# 4. PROVA DE FUNCIONAMENTO no SEU ambiente (read-only: nada é assinado/enviado)
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

1. `npm install && npm run test` → 86/86.
2. `npm run smoke` → todos os estágios ✅ (no seu ambiente com egress).
3. `npm run verify:endpoints` → exit 0. **Se falhar, não ligue nada de LIVE.**
4. `npm run quarantine` (dry-run) → revise as posições classificadas.
   Depois, **com o servidor PARADO**: `npm run quarantine -- --apply`.
5. `npm run dev` → abra o painel, leia o **banner de verdade** no topo.
6. Deixe rodando em PAPER e observe por tempo suficiente para ver `eventCount` subir e
   aparecerem `shadow-entries`. Se `eventCount` ficar em 0 com `socketOpen=true`, o problema
   é a *filtragem* de logs (programas/hints), não a conexão.
7. Só depois de dias de dado medido — e nunca antes de `npm run replay` mostrar expectativa
   positiva líquida de custos — considere LIVE, que hoje **não tem caminho de compra**.

---

## 5. Modos: o que cada um faz de verdade

| Modo | Assina? | Envia? | O que grava |
|---|---|---|---|
| `PAPER` | não | não | posições `mode: paper`, trades `status: paper`, decisões com preço real |
| `SHADOW` | não | não | registro de simulação (`simulateTransaction`), nenhuma transação |
| `LIVE` | sim (exige duas declarações + chave + `ADMIN_TOKEN` + RPC https) | sim, **quando o caminho existir** | trades `mode: live` com assinatura real |

`LIVE` sem todas as condições **não sobe** (exit 1) — é configuração fatal, não aviso.

---

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

---

## 8. O que NÃO está implementado (e não é segredo)

1. **Entrada real on-chain** — não assina nem envia compra. Sem isso não existe execução real;
   todo PnL é simulado.
2. **gRPC Yellowstone** — o canal de baixa latência está declarado como não implementado; o
   runtime cai para WSS (mais lento) e diz isso no log.
3. **Idempotência entre processos** — a trava de voo único vale por processo; duas instâncias
   na mesma carteira não se enxergam (a solução é guarda NA CADEIA, que não existe aqui).
4. **Postgres** — persistência é JSON atômico com backup; suficiente para single-writer, não
   para múltiplos processos.
5. **Painéis do dashboard** — 9 endpoints listados em `/api/system-truth` continuam gerando
   números com RNG. Eles estão DECLARADOS, não corrigidos.
