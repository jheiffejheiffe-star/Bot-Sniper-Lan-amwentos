# Auditoria Técnica e de Segurança — Bot Sniper Solana (HFT Terminal)

**Data:** 2026-10-02
**Escopo:** `server.ts`, `src/realExecution.ts`, `src/security.ts`, `src/persistence.ts`, `test-production.ts`, componentes de UI que produzem veredito de go-live
**Método:** leitura integral do código, verificação de cada endereço/endpoint/discriminador contra documentação oficial, teste das propriedades de segurança em suíte própria
**Regra aplicada:** `CORREÇÃO > SEGURANÇA > CONFIABILIDADE > PERFORMANCE > LATÊNCIA > CONVENIÊNCIA`

> **Veredito em uma linha:** o sistema tem uma aparência de prontidão de produção que **não corresponde ao comportamento real**. A camada de auditoria é parcialmente real e é *fail-open*; a camada de execução é inteiramente fabricada; e as falhas de execução eram convertidas em **sucessos com PnL inventado**. Operar capital real neste estado produziria perda por três caminhos independentes: SOL enviado para endereços inexistentes, compras que nunca ocorrem, e posições removidas do banco sem terem sido vendidas.

---

## Diagnóstico

| # | Severidade | Achado | Consequência direta |
|---|---|---|---|
| C1 | 🔴 Crítico | Tip accounts do Jito **fabricados** (`src/realExecution.ts`) | SOL enviado para endereços inexistentes: perda permanente do tip |
| C2 | 🔴 Crítico | Program ID da Raydium **inexistente** | Detecção de novos pools da Raydium **nunca** disparava — silenciosamente |
| C3 | 🔴 Crítico | Falha de saída convertida em **sucesso** com bloco/latência/PnL aleatórios | PnL é ficção; circuit breaker nunca dispara; posição é apagada sem venda |
| C4 | 🔴 Crítico | Endpoints Jupiter **descontinuados** (`quote-api.jup.ag/v6`) | A única rota de saída estava morta — e a falha alimentava o C3 |
| C5 | 🔴 Crítico | Motor de risco **fail-open** para mint/freeze authority | Token com freeze authority ativa (venda bloqueável) aprovado quando o RPC falhava |
| C6 | 🔴 Crítico | Selos de segurança **inventados**: LP lock, taxa de compra/venda, alocação do dev | Decisão de compra baseada em indicador fabricado |
| C7 | 🔴 Crítico | Blockhash **falso** gerado por RNG e exposto na UI como real | Transações assinadas com hash inválido; painel de infraestrutura mentia |
| C8 | 🟠 Alto | Compra on-chain **nunca existiu**: assinatura de mensagem de texto + `Math.random()` | Posições registradas a preços inventados, sem compra correspondente |
| C9 | 🟠 Alto | Jito `sendBundle` sem `encoding: base64` (default é base58, deprecado) | Bundle rejeitado pelo block engine |
| C10 | 🟠 Alto | RPC nodes com hostnames **fabricados**; telemetria 100% `Math.random()` | Todo failover falhava → empurrava a execução para o fallback simulado (C3) |
| C11 | 🟠 Alto | Todos os endpoints POST **sem autenticação** | Qualquer host com acesso à porta pode operar a hot wallet |
| C12 | 🟠 Alto | `readOnlyMode` **ignorado** nos endpoints de fechamento | Barreira de segurança contornável |
| C13 | 🟠 Alto | Rejeição de auditoria alimentava o circuit breaker | Kill switch dispara após 3 rejeições legítimas → bot se auto-desliga |
| C14 | 🟠 Alto | PnL calculado sobre **cotação**, sem tip/fees/slippage | Break-even real ignorado; relatório superestima resultado |
| C15 | 🟠 Alto | Tip fixo de 0.003 SOL independente do tamanho | 300 bps em posição de 0.1 SOL (600 bps round-trip) |
| C16 | 🟠 Alto | Preço obsoleto reutilizado em silêncio no gerenciador de posições | Stop-loss nunca dispara; exposição sem gestão |
| C17 | 🟡 Médio | `test-production.ts` **apaga o banco operacional** | "Testar" destrói o histórico; dois testes avaliam reimplementações locais, não o código real |
| C18 | 🟡 Médio | Veredito de go-live gerado por `Math.random()` na UI (`ProductionReadinessReview.tsx`) | O portão que autoriza capital real é um RNG |
| C19 | 🟡 Médio | `getTokenLargestAccounts` tratado como "concentração de holders" | Reprova todo lançamento legítimo com pool (a conta do pool domina o supply) |
| C20 | 🟡 Médio | Conta mint não validada; sufixo do mint usado como heurística de programa | Pode analisar/rotear endereço que não é mint |
| C21 | 🟡 Médio | `.env.example` documenta apenas `GEMINI_API_KEY` | Configuração operacional não documentada; default é RPC público |
| C22 | 🟡 Médio | WebSocket com reconexão suprimida e sem health-check | Listener morto em silêncio por tempo indeterminado |
| C23 | 🟢 Baixo | `Connection.prototype._wsOnError` monkey-patchado | Frágil entre versões; dificulta manutenção |

---

## O que está acontecendo

### 1. A cadeia de causalidade que produz o resultado falso

Os achados não são independentes: eles se encadeiam em um fluxo que **sempre termina em "sucesso"**.

```
RPC nodes apontam para hosts inexistentes (C10)
        ↓ runWithRpcFailover falha sempre
Quote/swap na Jupiter usam endpoint descontinuado (C4)
        ↓ JupiterIntegration lança erro
executeAutonomousExit captura o erro
        ↓ catch escreve um "fechamento simulado"
registra status:"success", block aleatório, PnL = sizeSol*(1+pnl/100) (C3)
        ↓ apaga a posição do banco
reportTradeOutcome(true) → circuit breaker zerado
```

O modo de falha mais perigoso não é o erro: é o **erro reportado como sucesso**. O operador vê "liquidação confirmada", não intervém, e continua exposto ao ativo.

### 2. Detecção de lançamentos estava morta por endereço inválido

`GeyserStreamClient` assinava `onLogs` em `675k1g2EPJ8gS7q9yGP8REukXXhxZ9ReM78D4cifFGL`. O programa da Raydium AMM v4 é `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`. O log dizia `listeners attached successfully` — porque `onLogs` aceita **qualquer** `PublicKey` válida. Nenhum evento real chegaria jamais.

### 3. A execução de compra nunca existiu

`executeAutonomousPipeline` "assinava" `Snipe transaction for <mint> at <timestamp>` — uma **mensagem de texto**, não uma transação. Depois: `Math.random() > 0.05` decidia o sucesso, `278913000 + Math.random()*5000` o bloco, `0.000003 + Math.random()*0.000004` o preço de entrada. Posições reais eram gravadas no banco com esses valores.

### 4. O portão de go-live é um gerador de números aleatórios

Em `src/components/ProductionReadinessReview.tsx`:
- linha 44: `const [prrAuditPassed, setPrrAuditPassed] = useState<boolean>(true); // Queries or assumes L13 audit passes`
- linha 537: `const signatureHex = "sig-0x" + Math.random().toString(16).substring(2, 14) + ...`

A "assinatura criptográfica" da auditoria é uma string aleatória, e o estado inicial assume aprovação. O comentário na UI afirma que "o L14 assume este resultado para dar permissão operacional de escrita on-chain". **O gate que autoriza capital é aleatório e é assumido como aprovado.**

### 5. Custo de execução ignorado por completo

| Item | Valor | Em posição de 0.1 SOL |
|---|---|---|
| Jito tip (entrada+sainda) | 0.001–0.006 SOL | 100–600 bps |
| Base fee (2 tx) | 0.00001 SOL | 1 bps |
| Priority fee | variável | 10–100+ bps |
| Slippage assumido | 1.5% × 2 | 300 bps |
| Taxa AMM | ~25 bps × 2 | 50 bps |

Break-even plausível: **~5–10% antes de o ativo se mover**. Com TP de 15%, os custos consomem um terço a dois terços do alvo. Nada disso aparecia em nenhum relatório do sistema.

---

## Causa provável

1. **Endereços e discriminadores "reconstruídos" por geração de texto em vez de copiados de IDL/documentação.** A assinatura desse fenômeno é inconfundível: valores que *parecem* corretos mas têm os bytes embaralhados.
   - `16927863322537033481` (`0xeaebda01122eff09`) como "buy" do pump.fun: o valor correto é `7351630589278743530` (`0x66063d1201daebea`). Os **últimos 5 bytes coincidem** — assinatura de reconstrução parcial.
   - `96gYZGLnJYVFihjz7mZge1L97McJ79S9Aabbb3BE` vs. o real `96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5`: mesmo prefixo de vaidade, resto inventado.
2. **Ausência de fronteira entre simulação e execução.** O "fallback" não era um modo distinto com rótulo visível: gravava no mesmo banco, com o mesmo `status: "success"`, indistinguível de um fill real.
3. **Falha aberta por default.** Campos de risco inicializados como `true = seguro` em vez de `null = desconhecido`.
4. **Telemetria decorativa.** `Math.random()` em latência, jitter, load, blockhash e assinatura de auditoria — o painel parecia instrumentado sem estar.

---

## Evidências necessárias (para o que **não** verifiquei)

Verifiquei **estruturalmente** o código e **documentalmente** os endereços/endpoints. O sandbox onde trabalhei **não tem egress de rede** (confirmado: `curl` para Solana RPC, `lite-api.jup.ag`, `quote-api.jup.ag` e Jito retornam HTTP 000). Portanto, o que segue precisa de validação no **seu** ambiente:

1. `npm run verify:endpoints` — valida RPC, existência on-chain de cada program ID, `getTipAccounts` e rota Jupiter. **Criei este script.**
2. Latência real decomposta (detecção → parsing → decisão → assinatura → submissão → inclusão) medida com `performance.now()` nos pontos corretos, não estimada.
3. Taxa de inclusão real do Jito medida em mainnet, com o seu `JITO_REGION`.
4. Comportamento real de sell em tokens pump.fun (é o teste que detecta honeypot de verdade).

**Não tenho evidência suficiente para afirmar** qual será sua taxa de execução real, seu slippage médio ou a lucratividade de qualquer estratégia. Nenhum número deste relatório deve ser lido como projeção de retorno.

---

## Arquitetura recomendada

O projeto tem **os componentes certos na ordem errada de maturidade**: construiu o dashboard e a telemetria antes de ter um único fill real verificado.

```
[1] INGESTÃO      gRPC Yellowstone (protobuf) → fallback: logsSubscribe em program IDs VERIFICADOS
[2] PARSER        discriminadores do IDL oficial → evento tipado {programId, mint, pool, reserves}
[3] RISK GATE     FAIL-CLOSED. Dado ausente = reprovar. Sem selo inventado.
[4] DECISÃO       regra explícita + limite de custo: break-even < TP casado com o alvo
[5] EXECUÇÃO      builder verificado (Jupiter swap-instructions ou SDK oficial) + Jito bundle
[6] CONFIRMAÇÃO   confirmed/failed/expired/unknown  → "unknown" NUNCA vira sucesso
[7] CONTABILIDADE PnL = delta de saldo observado on-chain. Cotação é só referência.
[8] POSIÇÃO       mantida aberta até liquidação CONFIRMADA; falha escala alerta e alimenta o breaker
[9] OBSERVABILIDADE  métrica medida ou marcada como indisponível — nunca inventada
```

**Regra arquitetural central:** cada componente declara `metricsSource: measured | partial | unavailable`. Um painel que não sabe deve dizer "não sei".

### O que já corrigi no código (mudanças mínimas e justificadas)

Novos módulos:
- **`src/solanaConfig.ts`** — fonte única de verdade: program IDs verificados (Raydium AMM v4/CPMM/CLMM, pump.fun, PumpSwap, Meteora, Orca, Token/Token-2022, ATA), discriminadores corretos do pump.fun, 8 tip accounts oficiais do Jito, regiões do block engine, endpoints Jupiter. Validação estrutural + `assertConfigIntegrity()` que **derruba o boot** se um endereço fabricado reaparecer (guarda anti-regressão com a lista negra).
- **`src/accounting.ts`** — PnL líquido por delta de saldo, breakdown de custos, break-even, teto de tip em bps, frescor de preço (`fresh/stale/missing`), métricas de estratégia (expectativa, profit factor, drawdown) com piso de amostra explícito.
- **`tests/safety.test.ts`** — 22 testes não destrutivos, incluindo regressões para cada fabricação removida.
- **`scripts/verify-endpoints.ts`** — validação no ambiente do operador.

Correções aplicadas:
1. Tip accounts do Jito: `getTipAccounts` em runtime + fallback oficial validado. **Removidos os 4 endereços fabricados.**
2. Raydium AMM v4 corrigido para `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`; listeners agora nos 4 programas de lançamento verificados.
3. Blockhash: fim do gerador sintético. Cache real com `usable`/`ageMs`; sem hash válido, **nenhuma transação é assinada** e o endpoint devolve 503/erro explícito.
4. Builders nativos (pump.fun/Raydium) **recusam** montar instruções — o layout de 2024 está desatualizado (fee_config, fee_program, volume accumulators) e emitir instrução errada só queima taxa.
5. Falha de saída = falha real: posição permanece `open` com `exitAttempts`/`lastExitError`, registro `status:"failed"` com `block: 0`, log CRITICAL e `reportTradeOutcome(false)`.
6. Rejeição de sinal separada de falha de execução (`reportSignalRejected`) — o bot não se auto-desliga mais por acertar o filtro.
7. Motor de risco fail-closed: `null` para autoridade desconhecida, `dataComplete`, `missingChecks`, `verdict`, teto de score 40 quando falta dado crítico, checagem de extensões Token-2022 (transfer hook / transfer fee / permanent delegate).
8. Removidos os selos inventados: LP lock, taxa de compra/venda e alocação do dev agora são declarados **"não verificado/não medido"** com o que seria necessário para medir.
9. IA com autoridade limitada: pode **baixar** o score, nunca subir, nunca absolver um `isRug`, nunca reverter reprovação por dado ausente.
10. Autenticação `ADMIN_TOKEN` em todos os POSTs; **fail-closed em produção** quando ausente; `readOnlyMode`/kill switch respeitados nos caminhos de capital.
11. `sendBundle` com `encoding: "base64"`, região configurável, checagem de limite de 5 txs, tip limitado a `MAX_TIP_BPS`.
12. Tip limitado por bps do capital (`clampTipSol`) nos dois caminhos de saída.
13. PnL medido via `preBalances/postBalances` da tx confirmada (`measureExitEconomics`), com `measuredOnChain` e `mode: "live"|"paper"` nos registros.
14. Preço obsoleto: sem preço fresco, **não avalia SL/TP**, escala alerta CRITICAL (com throttle de 60s) em vez de congelar em silêncio.
15. Modo PAPER explícito e default: posições `mode:"paper"` são geridas em shadow, com preço de mercado real e resultado rotulado, sem tocar a rede.
16. `test-production.ts` neutralizado (exige `HFT_ALLOW_DB_WIPE=true`) e aviso de que não é cobertura de 10 testes.
17. `vite.config.ts`: `allowedHosts: true` (o preview era bloqueado com HTTP 403).

---

## Estratégia (do sniper, na ordem correta)

Antes de escrever qualquer linha de estratégia, as perguntas obrigatórias:

| Pergunta | Resposta para pump.fun | Resposta para Raydium |
|---|---|---|
| Mecanismo de lançamento | `create` na bonding curve | `initialize2` (AMM v4) / `create_pool` (CPMM) |
| Onde o evento aparece | log `Instruction: Create` + `TradeEvent` | log `initialize2` com mints nas contas 8/9 |
| Melhor ponto de detecção | gRPC shred/Geyser (sub-10 ms) | Geyser; WSS é ~100–400 ms |
| Melhor ponto de execução | primeiro bloco com liquidez da curva | após `initialize2` confirmado, com preço já definido |
| Limitação técnica | layout de contas muda (2025) → exige IDL versionado | 17+ contas derivadas do estado do pool |
| Latência necessária | < 400 ms do evento ao bundle | < 800 ms |
| Risco dominante | dev dump, bundling, honeypot de venda | LP removível, MEV de entrada |

**Não recomendo competir em latência de entrada.** Em pump.fun, o custo fixo (tip + priority + slippage round-trip) e a competição de bots co-localizados tornam o snipe de entrada uma disputa negativa para quem não tem infraestrutura dedicada. O caminho com expectativa positiva mais plausível, dado o que este sistema já tem, é:
1. **Detecção de graduação** (curve → PumpSwap) com entrada na primeira hora pós-migração, onde a competição é menor.
2. **Filtro de execução de venda** (honeypot real): simular o sell antes de comprar. É a única verificação que importa de verdade e hoje **não existe**.
3. **Market making passivo** em pools com spread > custos.

Nenhuma dessas três deve ser implementada antes de existir a infraestrutura de medição — caso contrário repetiremos o erro atual: confundir movimento de preço com edge.

---

## Latência — como medir de verdade

O sistema atual reporta latências `Math.random()`. Decomposição correta, com o ponto de medição:

| Etapa | Medição | Onde instrumentar |
|---|---|---|
| Detecção | `t_event - t_receipt` | callback do gRPC/WSS (hoje: `grpcLatencyMs` medido, mas nunca propagado corretamente) |
| Parsing | `performance.now()` antes/depois do decode | parser de instrução |
| Decisão | entrada/saída do risk gate | `fetchRealOnChainTokenData` |
| Construção | quote → tx deserializada | `JupiterIntegration.buildSwapTransaction` |
| Assinatura | `executeWithDecryptedKeypair` | dentro do vault |
| Submissão | POST → resposta do block engine | `JitoBundleSender.submitBundle` |
| **Inclusão** | slot confirmado − slot de submissão | `ConfirmationMonitor` |

O gargalo real, com alta probabilidade, é **detecção via WSS** (100–400 ms), não a assinatura local (~1 ms). Otimizar o signer antes de medir isso é trabalho desperdiçado.

---

## Testes

- `npm run test` → 22 testes não destrutivos (`tests/safety.test.ts`). Rodam em `os.tmpdir()`, **não tocam o banco operacional**.
- `npm run lint` → `tsc --noEmit` limpo.
- `npm run verify:endpoints` → validação de rede (rode no seu ambiente).
- `npm run test:all` → lint + suíte de segurança.

**Ainda falta (não implementado):** teste de replay com eventos históricos (backtest determinístico), teste de degradação de RPC, teste de honeypot com sell simulado. Sem eles, não existe validação estatística de estratégia — e nenhum resultado histórico deve ser tratado como evidência.

---

## Riscos

**Resolvidos nesta correção:** perda de SOL para endereços fabricados; PnL fictício; circuit breaker sabotado; kill switch acionado por rejeição legítima; barreira read-only contornável; APIs de capital sem autenticação.

**Abertos e relevantes:**
1. **A ingestão gRPC ainda não existe** (o JSON-RPC/WSS não é competitivo; e o cliente protobuf Yellowstone não está implementado — agora declarado explicitamente no log em vez de silenciado).
2. **O caminho de compra on-chain permanece não implementado.** Deliberadamente: prefiro recusar a fabricar. Isso significa que `LIVE_TRADING_ENABLED=true` hoje **não compra nada** — e diz isso.
3. **Sem KMS/HSM**: a chave é decifrada em RAM no mesmo processo do servidor HTTP. Aceitável para hot wallet com capital pequeno; inadequado para capital relevante.
4. **Sem validação de honeypot via sell simulado** — o filtro mais importante de todos.
5. **Risco de MEV na saída** quando o Jito falha e o fallback vai por `sendTransaction` (trade-off necessário: ficar preso no ativo é pior).
6. **DB com histórico fabricado**: `hft_operational_db.json` contém 32 trades e 12 posições gerados pela versão anterior (ex.: mint `King777123912Aasdasdsa8912hads9812hasdH`, que não é um mint real). O dashboard exibe isso como desempenho passado. **Recomendo quarentenar antes de qualquer uso**, mas não apaguei nada — é seu dado.

---

## Otimizações (ordem por retorno)

1. **Cliente gRPC Yellowstone real** (`@triton-one/yellowstone-grpc`): maior ganho de latência do sistema.
2. **Sell simulado no risk gate**: maior ganho de *sobrevivência* do sistema.
3. **Signer isolado em processo separado** com IPC, chave nunca no processo HTTP.
4. **Medição de latência ponta a ponta** com histograma em vez de média.
5. **Backtest com replay** para transformar "ganhou em algumas operações" em "estratégia com expectativa medida".
6. **Address Lookup Tables** para reduzir tamanho de tx e CU.

---

## Próximos passos

1. **Não habilite capital real.** `LIVE_TRADING_ENABLED` está ausente por default e o caminho de compra não existe.
2. Rode `npm run verify:endpoints` no seu servidor e me mande a saída.
3. Rode `npm run test:all` e confirme 22/22 + lint limpo.
4. Decida o destino do `hft_operational_db.json` (quarentena/purge) — ele é histórico fabricado.
5. Defina `ADMIN_TOKEN` e mova a operação para um RPC dedicado.
6. Me diga qual caminho seguimos (graduação, honeypot-first, ou market making) e eu implemento com testes de replay antes de qualquer execução real.

---

## Anexo — verificação documental

| Constante | Valor usado agora | Fonte |
|---|---|---|
| Raydium AMM v4 | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | docs.raydium.io/protocol/developers/addresses |
| pump.fun bonding curve | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | IDL público pump.fun |
| pump.fun `buy` | `0x66063d1201daebea` = `7351630589278743530` | IDL público (bytes `[102,6,61,18,1,218,235,234]`) |
| pump.fun `buy_exact_sol_in` | `0x38fc74089edfcd5f` | IDL público |
| Jito tip accounts (8) | ver `JITO_TIP_ACCOUNTS_FALLBACK` | docs.jito.wtf/lowlatencytxnsend#gettipaccounts |
| Jito `sendBundle` | `POST /api/v1/bundles`, `{encoding:"base64"}`, máx. 5 tx | docs.jito.wtf |
| Jupiter | `lite-api.jup.ag/swap/v1` (v6 foi descontinuado) | developers.jup.ag/docs/changelog |

> **Nota metodológica honesta:** esta verificação foi **documental**. O sandbox de desenvolvimento não tem egress de rede. Endpoints e IDLs mudam — a própria Jupiter tem deprecação de host anunciada no changelog. `npm run verify:endpoints` existe exatamente para fechar essa lacuna no seu ambiente.

---

## Adendo (2026-10-02) — verificação de análise externa independente

Uma análise independente do mesmo código foi submetida à verificação. Resultado completo em
**[`VERIFICACAO-ANALISE-EXTERNA.md`](./VERIFICACAO-ANALISE-EXTERNA.md)**.

Resumo: 31 afirmações confirmadas com evidência; 1 correção factual (a alegação de que
`zeroizeBuffer` não funciona está **invertida** — `Keypair.secretKey` devolve a referência
interna e o zero funciona); 1 número não reproduzível ("161 ocorrências" — as contagens
verificáveis são 82 para `simulat*|mock` e 116 no padrão mais amplo); e 1 achado que a
análise externa deixou passar:

**`exit_pending` não tinha reconciliador.** Posições presas nesse estado eram
permanentemente in-liquidáveis (todo `POST /api/positions/close` devolvia 409) e o lock em
memória desaparecia no restart. Ao subir o reconciliador novo, o banco operacional real
continha **3 posições presas** — o defeito já havia se materializado. Corrigido com
`reconcileStuckExits()`, executado no boot antes de retomar a gestão de risco.

Correções adicionais aplicadas neste adendo:
- `assertExitAllowed()`: gate de saída ligado às rotas de liquidação (paper → 409;
  read-only → permite sair por reduzir exposição; kill switch → configurável).
- `uncaughtException` agora encerra o processo (`process.exit(1)`) para reinício por supervisor,
  em vez de "caught safely" e continuar com estado possivelmente inconsistente.
- Chave operacional malformada/ausente **não** cai mais para keypair aleatório: lança
  `KeyCustodyError` e, em produção, impede o boot.
- `getDatabaseStats()`: `health` e `writeLatencyMs` derivados de contadores reais; política de
  rotação declarada honestamente (contagem, não dias/KB).
- `describeKeyCustody()`: declara explicitamente que a camada **não é KMS** e não protege
  contra acesso ao processo.
- Trades/posições paper agora usam `status: "paper"` — nunca somados como execução real.
- `tsconfig.json` passou a incluir `tests/` e `scripts/` no type-check.

Suíte de testes: **27/27**.

---

## Adendo 2 (2026-10-02) — medição, registro e replay

### O que foi construído (e por quê)

O sistema não tinha como responder "a estratégia tem edge?" nem "onde o tempo é gasto?".
Ambas as perguntas exigiam as mesmas duas coisas: **medir** e **registrar**. Foram
implementadas antes de qualquer tentativa de construir entrada real — ordem deliberada:
sem isso, não existe critério para decidir se a entrada vale a pena.

| Módulo | Papel | Contrato que importa |
|---|---|---|
| `src/telemetry.ts` | Relógio monotônico, `LatencyTrace`, histogramas (p50/p95/p99), `JsonlSink` append-only com rotação de 64 MB | `snapshot()` declara `detection.measurable: false` sob WSS (não há timestamp de origem) e marca a inclusão como **estimativa** por slot × 400 ms |
| `src/eventRecorder.ts` | JSONL em `data/events.jsonl` (gitignored): `launch-event`, `assessment`, `price-observation`, `position-lifecycle` | Dedupe por `eventId` (reentrega de WebSocket não conta duas vezes); `loadBacktestDataset()` inclui **rejeitados** |
| `src/replay.ts` | Compara estratégias de saída contra a linha de base `baseline-hold` | Custos em bps aplicados sobre o bruto; ranking **omitido** quando a amostra é insuficiente; 6 limitações devolvidas junto com cada resultado |
| `scripts/replay.ts` (`npm run replay`) | CLI do replay: tabela legível ou `--json` para `jq` | Mesma verdade do endpoint; `--file`, `--filter`, `--size` |
| `GET /api/latency` | Histogramas do processo | Com zero eventos devolve `traces: 0` e todos os estágios `null` — **não existe número de recheio** |
| `GET /api/replay` | Comparação sobre os dados gravados | `noData: true` explícito quando não há registro; cache invalidado por `mtime+tamanho` porque a leitura é síncrona e bloquearia o event loop |

Estágios instrumentados: `received → enriched → assessed → built → signed → submitted →
confirmed`. O callback do geyser abre a trilha; a saída autônoma mede cotação → construção →
assinatura → envio → confirmação, e grava amostra **inclusive quando falha** (falha é resultado).

### Achados novos desta rodada

**C24 — dois caminhos de SAÍDA apontavam para host morto.** `server.ts` mantinha quatro
chamadas hardcoded a `quote-api.jup.ag/v6/*` (saída manual, saída autônoma, retry de cotação
e swap), host descontinuado pela Jupiter. O cliente correto (`JupiterIntegration`, com host
configurável, `x-api-key` e falha dura quando o retorno não é JSON) já existia — era usado
apenas na entrada. Efeito prático em produção: **toda saída falharia**, deixando capital preso
no ativo; exatamente o modo de falha que já produziu as 3 posições presas. Corrigido: os
quatro pontos agora usam o cliente único, e há teste de regressão (`[8]`) que falha se o host
voltar ao código.

**C25 — cascata de preço morta e matematicamente errada.** As tentativas 2 e 3 liam
`api.jup.ag/v6/price` (host morto) e, quando a segunda chamada falhava, assumiam **USD 140**
por SOL para converter o preço — ou seja, podiam *inventar* o preço do SOL que serve de base
para todos os gatilhos. A terceira tentativa cotava `amount=1000000` cru e dividia por `1e6`,
o que só é correto para mints de **6 decimais**: em um token de 9 decimais o preço sairia
**1000× maior**, disparando stop/alvo na primeira leitura e vendendo a posição por engano.
Corrigido: a cascata passa a ser DexScreener → cotação real de exatamente 1 token inteiro via
`JupiterIntegration`, com os decimais lidos do mint (imutáveis, cacheados por processo).
Se os decimais não puderem ser lidos, a fonte é **descartada** e o fluxo segue para o
tratamento de "sem telemetria de preço" — preço nenhum é melhor que preço errado.

> Não verificado por rede: o sandbox não tem egress. A verificação de que os hosts respondem
> no **seu** ambiente é `npm run verify:endpoints`; a de que a saída funciona de ponta a ponta
> só é possível em modo live com capital mínimo.

### Estado da medição

```
GET /api/latency  → traces: 0, estágios: [], detection.measurable: false
GET /api/replay   → noData: true, ranking: []
```

Zero é o resultado honesto: nenhum evento da rede chegou (egress bloqueado no sandbox) e
`data/events.jsonl` ainda não existe. Qualquer painel que mostrasse percentis aqui estaria
inventando.

Suíte de testes: **36/36** (novos grupos `[7]` medição/replay e `[8]` hosts de mercado).
`npx tsc --noEmit` limpo.


---

## Adendo 3 (2026-10-02) — Modo de execução, barreira única de assinatura e superfície de comando

**Motivação.** Os riscos **R1** (auth fail-open + bind `0.0.0.0`) e **R2** (painel calculando prontidão
com RNG) do `REVISAO-PLANO-GPT.md` apontavam para a mesma ausência de fundo: **o processo não tinha
nenhuma noção declarada de "que tipo de execução ele está autorizado a fazer"**. O código tinha uma
flag solta (`LIVE_TRADING_ENABLED`) que podia estar ligada sem chave, sem RPC e sem token; a barreira
de assinatura estava espalhada em três checagens independentes (`assertExecutionAllowed`,
`assertExitAllowed`, verificação dentro de `assertMutationAuthorized`), cada uma com sua própria
noção de "pode". Barreira duplicada é barreira com furo: **não havia um único ponto por onde toda
assinatura obrigatoriamente passa.**

### O que foi construído (e por quê)

| Peça | Papel | Contrato que importa |
|---|---|---|
| `src/runtimeMode.ts` (**novo**, 432 l.) | Fonte única de verdade do modo (`SIMULATION \| PAPER \| SHADOW \| LIVE`) e da política de permissão de capital | `resolveRuntimeMode(env)` é **função pura** (testável com ambiente sintético); `evaluateCapitalPermission(res, ctx, purpose)` devolve `{ok:true, warnings}` ou `{ok:false, status, error, code}` |
| `assertCanSign(purpose)` | Barreira única: é o **único** ponto que consulta a política para decidir "pode assinar?" | Lança `SigningBlockedError` com `.code`. Nada assina sem passar aqui |
| `executeWithDecryptedKeypair(cb, purpose)` | Choke point dos dois únicos call sites de assinatura (`server.ts`) | Chama `assertCanSign` **antes** de tocar no cofre: em modo proibido, nem a chave é decifrada |
| `JitoBundleSender.submitBundle(..., purpose)` | Defesa em profundidade no ponto de envio | Reavalia a barreira e devolve resultado tipado `{success:false, error, tipSol:0}` — **nunca** reporta sucesso sem ter enviado |
| `validateRuntimeConfiguration(res, env)` | Validação de boot por modo | `{fatal[], warnings[]}`; o boot imprime o estado e chama `process.exit(1)` em fatal |

### Regras de resolução (fail-closed, provadas em teste)

| `RUNTIME_MODE` | `LIVE_TRADING_ENABLED` | Modo efetivo | Observação |
|---|---|---|---|
| ausente | ausente/false | **PAPER** | padrão conservador |
| ausente | `true` | **SHADOW + conflito** | flag sozinha **nunca** vira LIVE por inferência |
| `SIMULATION`/`PAPER`/`SHADOW` | qualquer | o declarado | a flag não promove modo; gera conflito declarado |
| `LIVE` | `false`/ausente | **SHADOW (rebaixado)** | ambíguo ⇒ não assinar |
| `LIVE` | `true` | **LIVE** | exige `OPERATIONAL_PRIVATE_KEY` + `ADMIN_TOKEN` + `RPC_ENDPOINT` https, senão **boot aborta** |
| valor inválido (ex.: `producao`) | qualquer | **PAPER + conflito** | valor inválido nunca é lido como "quase LIVE" |

Assimetria deliberada **entrada vs. saída**: `readOnlyMode` e kill switch **bloqueiam entrada** mas
**permitem saída** (`BLOCK_EXITS_ON_KILL_SWITCH=true` é a exceção explícita). Racional: prender capital
em pânico é o pior resultado. A regra vale igual nos dois sentidos do fluxo porque é a mesma função.

### Achados desta rodada

**C26 — não existia separação de modo; a "flag de trading real" não bastava nem era suficiente.**
Antes: `LIVE_TRADING_ENABLED=true` ligava caminhos de execução sem exigir chave própria, RPC ou token,
e a única trava de assinatura ficava dentro do cofre — de modo que um processo sem cofre provisionado
falhava por *caminho* (`VAULT_NOT_ARMED`) e não por *política*. Agora a recusa acontece por política,
antes do cofre: o teste `[9]` verifica que a mensagem cita o modo (`Modo PAPER...`) e não o cofre.

**C27 — `submitBundle` podia ser chamado sem que o modo tivesse sido avaliado.** O envio Jito não
consultava o modo em nenhum ponto; quem chamasse `JitoBundleSender` diretamente (script, teste, rota
futura) enviava bundle com a configuração que estivesse no ambiente. Agora o guard roda no início do
método e devolve falha tipada — sem rede, sem tip.

**C28 — R1 fechado: bind e autenticação.** O `app.listen` estava em `0.0.0.0` **hardcoded**, e
`assertMutationAuthorized` liberava todos os POSTs sem token sempre que `NODE_ENV !== "production"` — o
que, num container, é o caso comum. Agora: bind default **`127.0.0.1`** (`HFT_BIND_HOST` para expor de
propósito) e fail-open **estreitado**: sem `ADMIN_TOKEN` o POST só passa quando **não existe chave
operacional real E o modo não é LIVE**; fora disso, 503. Com bind não-loopback e chave real, o boot
**exige** token (fatal).

**C29 — posição estruturalmente inválida consumia RPC para sempre.** O loop de gestão consultava
preço a cada 3 s para toda posição "open" — inclusive posições de histórico fabricado (`sizeSol: 0`,
mints que não existem na cadeia). Com RPC pago isso é uma chamada perdida a cada 3 s por posição, sem
possibilidade de resolver. Agora: (a) posições com `sizeSol <= 0` ou mint não-base58 são recusadas
**antes** da consulta, com log único por posição (sem inundar); (b) falha de telemetria de preço entra
em **backoff exponencial** (3 s → 6 s → 12 s … teto de 60 s) que zera na primeira leitura bem-sucedida.
Medição no sandbox (egress bloqueado, portanto 100% de falha): o intervalo entre rodadas de consulta
passou de ~3 s para 3/6/12/24 s. O efeito pretendido não é economizar centavos de RPC — é **impedir que
a perda de telemetria de uma posição consuma a cota que todas as outras precisam**.

### Decisão de ordem registrada (e o motivo)

O teste antigo `"bundle com blockhash inválido é recusado sem risco de SOL"` passou a receber a recusa
do guard em vez da recusa de blockhash. Em vez de "consertar" o teste, a ordem foi fixada:

```
validação de inputs locais  →  barreira de modo  →  rede
```

Motivo: a validação de blockhash é **pura** — não toca em chave, não gasta cota, não pode causar dano;
e um blockhash ausente/inválido é um erro de *input do chamador*, que deve ser diagnosticado antes de
qualquer decisão de política. O guard continua à frente de **tudo que seja efeito colateral** (decifrar
chave, pagar tip, enviar). O teste foi ajustado para **provisionar o mínimo necessário** (modo LIVE
autorizado + cofre armado) para chegar à segunda camada — e o comentário no código diz exatamente isso,
para que ninguém "simplifique" a ordem depois.

### Estado verificado nesta rodada

```
npx tsc --noEmit                  → limpo
npm run test                      → 47/47 (grupos [1]6 [2]3 [3]5 [4]9 [5]3 [6]1 [7]7 [8]2 [9]8 [10]3)
boot com LIVE_TRADING_ENABLED=true e sem RUNTIME_MODE  → exit 1 (fatal declarado)
boot com RUNTIME_MODE=LIVE sem chave/token/RPC https   → exit 1 (três fatais listados)
npm run dev (HFT_BIND_HOST=0.0.0.0) → aviso de bind exposto sem token, servidor sobe
GET /api/runtime-mode             → mode PAPER, liveAuthorized false, canSign false, reasons[]/conflicts[]
GET /api/health                   → inclui runtimeMode
GET /api/operational-security/state → runtimeMode aninhado
POST /api/positions/close (PAPER) → 409 "Modo PAPER não autoriza liquidação on-chain…"
npm run replay -- --file <dataset sintético> → tabela + ranking omitido por amostra insuficiente
```

Extras desta rodada, menores mas necessários para não diagnosticar errado: `EventRecorder.flush()`
(a escrita é assíncrona; quem lia o JSONL logo após registrar podia concluir, errado, que o registro
não aconteceu) e o CLI de replay passou a imprimir `Superaram a base … vs …` somente quando existe
estratégia acima da linha de base — antes o texto de "nada superou a base" podia aparecer junto com
uma tabela em que quatro estratégias superavam.

### O que **não** está verificado

- **Egress continua bloqueado no sandbox**: nada foi executado contra RPC, Jito ou Jupiter. Todas as
  evidências acima são de lógica local, boot e HTTP local.
- **LIVE nunca foi exercido de verdade** — por construção: `RUNTIME_MODE=LIVE` sem chave/token/RPC
  derruba o boot, e não há caminho de COMPRA que assine.
- **`simulateTransaction`/`simulateBundle` seguem com 0 usos** (Etapa 4 do plano: shadow real). Enquanto
  isso, `SHADOW` é uma promessa do modo declarado, **não** uma simulação verificada na cadeia.
- Os endpoints fabricados (`/api/hft-telemetry`, `/api/predictive-score`, `/api/geyser-stream`,
  `/api/simulate-snipe`, `/api/simulate-fork`, `/api/jito-tips`, `/api/submit-bundle`, `/metrics`)
  **continuam existindo** com RNG. O modo PAPER não os torna verdadeiros.


### Complemento do Adendo 3 — C30 e C31 (medidos com o servidor rodando)

**C30 — reconexão de WebSocket sem backoff: 1 tentativa por segundo, para sempre.** O web3.js
1.98.4 instancia o cliente WS com `max_reconnects: Infinity` e `reconnect_interval: 1000`
(constantes internas do `rpc-websockets` 9.3.9). Com o endpoint inacessível — situação medida no
sandbox e igual à de qualquer VPS com egress bloqueado ou RPC fora do ar — o log do servidor
mostrava **20 falhas em 20 s (1/s), indefinidamente**: ~3.600 tentativas TLS por hora contra o
provedor (caminho direto para rate-limit e banimento da chave) e log crescendo sem limite, que é
como um operador deixa de ler os avisos do sistema.

Correção: o patch já existente de `_wsOnError` passou a aplicar **backoff progressivo** no próprio
cliente (`setReconnectInterval`, API pública do `rpc-websockets`): 1s → 2s → 4s → 8s → 16s → 32s →
60s (teto), voltando ao base no primeiro `open`. O log passou a ser **uma linha por estado** (com
contador de falhas e próximo atraso), não uma por tentativa; o handler original do web3.js, que
imprime a cada tentativa, deixa de ser chamado (o único efeito colateral dele —
`_rpcWebSocketConnected = false` — é reproduzido). `wsBackoffDelayMs()` é exportado e testado
(grupo `[10]`): monotônico, dentro do teto, e 60 falhas consecutivas passam a ocupar > 1 minuto de
tempo real em vez de 60 s de tentativas.

**C31 — "conectado" era um número local, não uma conexão.** `GeyserStreamClient.connected` era
`activeSubscriptions.length > 0`, e o web3.js atribui o **ID da subscrição localmente** no momento
em que `onLogs()` é chamado — antes do socket abrir e sem confirmação alguma do RPC. Resultado: o
boot imprimia `Yellowstone Geyser stream pipeline connected.` e o painel mostrava detecção ativa com
o WebSocket inoperante. Um bot cego que se declara saudável é pior do que um bot que diz que não
está vendo nada.

Correção: `getHealth()` passa a expor `socketOpen` (bit real `_rpcWebSocketConnected`, setado em
`_wsOnOpen`), `subscriptionsRequested` (ids locais, explicitamente **não** confirmação) e
`eventCount` (a única prova de detecção), com `degraded` derivado do socket; `/api/health` publica
esse bloco com a nota de interpretação; o log de boot passou a declarar o estado real
(`Detecção armada: socket WS aberto, N subscrição(ões) registrada(s) localmente…` ou
`Detecção DESARMADA…`).

**Correção acoplada — `disconnect()` deixava o processo preso.** O encerramento removia os
listeners mas não desligava o auto-reconectar do cliente WS, de modo que o event loop nunca
esvaziava. Descoberto porque a suíte de testes passou a **não terminar** (timeout de 10 min) ao
exercitar o cliente contra um endpoint local inacessível. Agora `disconnect()` chama
`setAutoReconnect(false)`, limpa o timer pendente e fecha o socket — comportamento correto para
qualquer shutdown gracioso, não só para o teste.

Evidência antes/depois (mesmo cenário, endpoint inacessível):

```
ANTES: 20 linhas "ws error" em 20 s, contínuas, sem teto   (~3600 tentativas/hora)
DEPOIS: 1 linha informativa na 1ª falha; tentativas em 1s, 2s, 4s … 60s (~60 tentativas/hora no teto)
```

O que isso **não** resolve: com o WebSocket fora, não há detecção de lançamentos por nenhum
caminho alternativo — o sistema segue cego e agora **diz isso** em `/api/health`. O caminho para
latência competitiva continua sendo o canal gRPC (Yellowstone), ainda não implementado.


---

## Adendo 4 (2026-10-02) — S0 (quarentena) e S2 (entrada em shadow simulada)

**Contexto.** O plano de sequência (Adendo 3) fixou: antes de qualquer capital, (a) separar o
histórico fabricado do operacional e (b) provar que a entrada é **construível** — rota existe,
transação monta, compute cabe. Sem (b), "pronto para comprar" era uma afirmação sem evidência:
o caminho de entrada aprovada registrava preço de referência e criava posição paper **sem nunca
verificar se havia rota de execução**.

### S0 — quarentena do banco operacional (`src/dbQuarantine.ts` + `npm run quarantine`)

Classificação **estrutural**, sem consulta on-chain:

| Balde | Critério | Efeito |
|---|---|---|
| `invalid` | `sizeSol <= 0` ou mint ausente/não-base58 | entra no plano por padrão |
| `suspect` | sem campo `mode` (`paper`/`live`) | entra só com `--include-unmigrated` |
| `ok` | nada a apontar | nunca tocado |

Dry-run é o comportamento **padrão**: não grava nada e sai com código **2** quando há
`invalid` (o problema aparece em qualquer pipeline em vez de depender de alguém ler a saída).
O `--apply` escreve um **inventário** (`hft_operational_db.quarantine.<timestamp>.json`) e marca
as posições movidas com `status: "quarantined"` + `quarantineReasons` + `quarantinedAt`, em
escrita atômica (`tmp` + `rename`). **Nada é apagado.**

Execução real no banco do repositório (dry-run, sem gravar):

```
Posições: 12 (inválidas: 8, suspeitas: 4, ok: 0)
  [invalid] 8 posições com sizeSol=0 e mint que não é base58 (MEME_KING, PEPE_SOL, ALPHA_AI, ...)
  [suspect] 4 posições (pos_auto_*) sem campo `mode`, mints "…pump" estruturalmente válidos
```

As 4 `suspect` são exatamente as que mantinham o loop de gestão consultando preço a cada rodada
(elas têm `sizeSol = 0.1`, portanto passam pelo corte de tamanho). Quarentená-las exige decisão
explícita do operador (`--include-unmigrated`), porque o critério é "sem modo gravado", não
"impossível de gerir".

### S2 — entrada em shadow (`src/shadowEntry.ts` + `GET /api/shadow-entries`)

Quando um sinal é **aprovado** pelo risk engine, o pipeline agenda (fire-and-forget, fora do
caminho crítico de latência) a validação de construibilidade:

```
cotação REAL (Jupiter) → transação MONTADA → simulateTransaction (sigVerify=false,
replaceRecentBlockhash=true, commitment=processed) → resultado tipado
```

O resultado é gravado em `data/events.jsonl` (`kind: shadow-entry`), no log operacional
(componente `SHADOW_ENTRY`) e num histórico de 20 entradas exposto em `/api/shadow-entries`
com `simulationOnly: true`.

**Garantia por construção de tipo, não por disciplina:** `ShadowEntryDeps` recebe apenas três
capacidades — `getQuote`, `buildSwapTransaction`, `simulateTransaction`. Não existe campo para
assinar ou enviar, e um teste faz **varredura do código-fonte** (`tests/safety.test.ts`, grupo
`[11]`) falhando se aparecerem `signTransaction`, `partialSign`, `sendTransaction`,
`sendRawTransaction`, `sendBundle`, `Keypair`, `secretKey` ou `privateKey` no módulo. Também é
verificado que a transação simulada é a **mesma** que o builder devolveu.

O que a simulação **não** prova, declarado no próprio resultado e no endpoint:

1. **Não é execução** — o estado muda entre simular e enviar (TOCTOU);
2. **Não valida blockhash** — ele é substituído por um recente de propósito (medimos
   programa/compute, não frescor); o campo `blockhashReplaced: true` deixa isso explícito;
3. **Não diz nada sobre lucro** — só que a rota é montável.

`skippedReason` é resposta legítima e esperada em três casos: modo `SIMULATION` (não há dado
real), modo `LIVE` (o caminho é o real, não o shadow) e ausência de chave operacional — este
último porque o módulo **nunca** cria chave efêmera para "ter o que simular".

### Estado verificado

```
npx tsc --noEmit                              → limpo
npm run test                                  → 55/55 (grupo [11] com 8 testes novos)
npm run quarantine                            → dry-run no banco real: 8 inválidas, 4 suspeitas, NADA gravado
npm run quarantine -- --file <fixture> --apply → move, inventaria e preserva as saudáveis (teste automatizado)
```

### O que continua NÃO verificado

- **Egress bloqueado no sandbox**: nenhuma cotação, construção ou simulação real foi executada
  contra a rede. O que está provado é o **encanamento** (tipos, medição, registro, ausência de
  caminho de assinatura) com dependências injetadas — não que o Jupiter responde.
- A primeira execução com rede real é o teste que importa: rode o bot em PAPER/SHADOW e olhe
  `GET /api/shadow-entries` (`built`, `simulation.ok`, `unitsConsumed`) e `data/events.jsonl`.
- O caminho de **entrada real** segue inexistente (nenhuma compra é assinada em nenhum ponto do
  código). O shadow é pré-condição para construí-lo com evidência, não substituto dele.


---

## Adendo 5 (2026-10-02) — S3: status de landing do Jito e oráculo de tip

**Motivação.** `sendBundle()` devolve um `bundle_id`, e a doc do Jito é explícita: *"This does not
guarantee the bundle will be processed or land on-chain."* Mesmo assim o código não tinha NENHUMA
consulta de status: "aceito pelo block engine" era o fim do caminho. E o valor do tip vinha de
quatro constantes fixas expostas como se fossem medição. As duas coisas juntas significam: decisão
de capital baseada em suposição, com número inventado.

### C32 — `/api/jito-tips` servia constantes fabricadas

Antes:

```json
{ "timestamp": …, "tips": { "low": 0.0005, "medium": 0.0015, "high": 0.005, "extreme": 0.02 } }
```

Esses quatro números não vinham de lugar nenhum — não eram um percentil, uma mediana, uma EMA, nem
uma leitura do tip floor. Um operador ajustando tip com base neles estaria calibrando por adivinhação
de terceiro.

Agora: leitura do **tip floor real** (`https://bundles.jito.wtf/api/v1/bundles/tip_floor`, REST em
host SEPARADO do block engine — não é método JSON-RPC), com percentis publicados pelo Jito
(`p25/p50/p75/p95/p99/ema50`) e política configurável (`JITO_TIP_PERCENTILE`, default `p75`).
Quando a fonte não responde, a resposta é `available: false` com o motivo e, se houver, o último
valor conhecido **com a idade declarada** — nunca um número de recheio. Verificado no sandbox:

```
GET /api/jito-tips?capital=0.1  →  available: false, error: "tip floor inacessível: fetch failed",
                                   percentilesSol: null, recommendation.tipSol: null
```

### C33 — não existia status de landing (e "Landed" seria confundido com confirmação)

Novos métodos read-only em `JitoBundleSender` (`getBundleStatuses`, `getInflightBundleStatuses`) e
`src/jitoStatus.ts` com parsers puros e reconciliação. O centro da correção é a **regra de
autoridade**:

| Evidência | Veredito | Autoridade declarada |
|---|---|---|
| `confirmation_status` = confirmed/finalized no **seu** RPC | `confirmed_on_chain` | `rpc` |
| `getBundleStatuses` = confirmed/finalized (RPC do Jito) | `confirmed_on_chain` | `jito` (+ aviso de que o seu RPC é a autoridade) |
| RPC em nível `processed` (confirmação otimista) | `landed_unconfirmed` | `rpc` |
| inflight = **`Landed`** | `landed_unconfirmed` | `jito` |
| inflight = `Failed` / `Pending` / `Invalid` | `failed` / `pending` / `invalid` | `jito` |
| nenhuma das duas fontes respondeu | **`unknown`** | `none` |

Dois modos de erro foram fechados explicitamente, ambos com teste:

1. **`Landed` virava confirmação.** "Entrou em um bloco" não é confirmação no nível
   `confirmed`/`finalized` e não prova o efeito esperado — a própria doc do Jito alerta sobre blocos
   *uncled*, onde as transações podem ser rebroadcast fora da atomicidade do bundle. `Landed` fica em
   `landed_unconfirmed` com a razão escrita na resposta.
2. **Falha de consulta virava "não encontrado".** Se as duas fontes falham, o veredito é `unknown`
   ("não foi possível consultar"), não `not_found`. Verificado no endpoint com o sandbox sem egress:

```
GET /api/jito/bundle-status?ids=<id>  →  verdict: "unknown"
   - Consulta ao inflight falhou: falha de rede ...
   - Consulta a getBundleStatuses falhou: falha de rede ...
   - Nenhuma das duas fontes respondeu. Isto significa "não foi possível consultar", e NÃO
     "o bundle não existe".
```

**Correção acoplada (rate limit).** A doc documenta **1 requisição/segundo/IP/região**. A primeira
versão do meu cliente *falhava* a segunda consulta feita dentro do mesmo segundo — defeito de
cliente: recusar uma consulta legítima por causa de outra consulta nossa não é respeitar limite, é
quebrar o diagnóstico. Passou a usar **reserve-then-wait**: o horário é reservado antes de qualquer
`await` (sem corrida entre chamadas concorrentes) e a requisição espera a vez; só se a espera passar
de `maxStatusWaitMs` (default 1,5 s) o cliente recusa, declarando a fila. Medido no teste: a segunda
consulta espera ~1 s e **chega** na rede.

### Formato do `bundle_id`: a doc se contradiz — e isso está no código

O exemplo de `sendBundle` mostra base58 (`2id3YC2jK9G5Wo2…`, formato de assinatura); o de
`getBundleStatuses` mostra SHA-256 em hex (`892b79ed…`). Em vez de escolher um e rejeitar bundles
legítimos do outro formato, `isPlausibleBundleId` aceita **os dois** e recusa o resto, com o motivo
escrito no código e no teste. O parser nunca depende do formato para inferir mais nada.

### Descoberta operacional: dado gitignored não persiste neste workspace

Ao reiniciar o servidor, o banco operacional não existia mais e o boot registrou
`No valid database or backup found. Creating fresh atomic operational state on disk.` O mesmo
aconteceu com `data/` (o JSONL de medição) e com o inventário de quarentena do Adendo 4. Causa: o
snapshot deste workspace **não carrega conteúdo gitignored** (`node_modules/` também precisa de
`npm install` a cada sessão). Não houve perda de código — só de dados de runtime:

- o banco do repositório (que continha as 12 posições fabricadas quarentenadas) **não existe mais
  aqui**; o banco atual é novo e vazio. Isso é conveniente, mas aconteceu por comportamento do
  ambiente, **não** por decisão de arquitetura;
- a limpeza que importa roda no SEU ambiente: `npm run quarantine` (dry-run) e depois `--apply`;
- `data/events.jsonl` recomeça vazio — o que também significa que qualquer métrica de replay é por
  ambiente, nunca herdada.

### Estado verificado

```
npm run lint        → limpo
npm run test        → 64/64 (novo grupo [12] com 9 testes: ids, parsers, reconciliação,
                       tip floor, oráculo com cache/throttle, recomendação com teto em bps,
                       validação do cliente, regressão das constantes removidas)
GET /api/jito-tips               → available: false honesto (sandbox sem egress), sem números
GET /api/jito/bundle-status?id=… → verdict "unknown" com as duas falhas de consulta declaradas
```

### O que continua NÃO verificado

- **Egress bloqueado**: nenhuma resposta real do tip floor nem do block engine foi lida. Toda a
  evidência de parsing vem dos exemplos da documentação oficial, com `fetch` injetado nos testes.
- O primeiro teste com rede real é: `curl https://bundles.jito.wtf/api/v1/bundles/tip_floor` do
  **seu** servidor e `GET /api/jito-tips` — se `available: true`, os percentis são reais.
- **Nenhum bundle real foi enviado** (o caminho de entrada real ainda não existe), então a
  reconciliação nunca rodou contra um bundle de verdade. Ela está pronta para ser usada em S4/S5.
- `getBundleStatuses` cobre ~300 slots enraizados e o inflight cobre 5 minutos: bundle antigo volta
  `null`/`Invalid`, e isso NÃO é falha — está escrito na resposta do endpoint.


---

## Adendo 6 (2026-10-02) — S4: intenção de execução (idempotência) e reconciliador `POSITION_DESYNC`

### C34 — o retry RECONSTRUÍA a transação: o vetor de execução dupla

Os DOIS loops de saída (automático e fechamento manual) reconstruíam e re-assinavam a
transação em cada uma das 3 tentativas: nova cotação, nova montagem e **novo
`getLatestBlockhash`**. O laço tratava "não confirmei em 30s" como "não aconteceu" e ia
direto para a tentativa seguinte.

O problema é a diferença entre reenviar e reconstruir:

| Operação | Efeito |
|---|---|
| **Reenviar** os mesmos bytes assinados | Mesma mensagem e mesma assinatura. A runtime deduplica por *message hash*: a transação não pode ser processada duas vezes. Idempotente. |
| **Reconstruir** (blockhash novo) | Mensagem e assinatura DIFERENTES. Para a cadeia é uma transação nova. As duas ficam válidas enquanto seus blockhashes valerem — e as duas podem entrar em bloco. |

A própria orientação de produção da Solana aponta isso: uma transação reconstruída tem
nova assinatura, então a idempotência precisa ser preservada NA APLICAÇÃO; e um `null` no
cache recente de status de assinatura é **inconclusivo** (~150 slots), não uma resposta
negativa. Ou seja: o timeout de 30s não era evidência de nada, e o código o usava como se
fosse permissão para criar uma segunda transação válida de venda.

**Correção — intenção de execução (`src/executionIntent.ts`) + política de retry.**

Cada saída agora tem uma INTENÇÃO persistida **antes de assinar**, com `signature`,
`blockhash` e `lastValidBlockHeight` gravados no instante em que existem. A decisão de
retry passa a ser por evidência, nesta ordem:

| Evidência | Decisão |
|---|---|
| Cadeia reportou ERRO de execução para a assinatura | `rebuild` — aquela transação executou e falhou, não pode voltar |
| Cadeia reporta a assinatura como `processed`/`confirmed`/`finalized` | `stop_confirmed` — a ação ocorreu; registra o nível |
| Altura atual > `lastValidBlockHeight` | `rebuild` — blockhash provadamente expirado |
| Nada conclusivo, bytes em memória | `rebroadcast` — reenvia os MESMOS bytes |
| Nada conclusivo, sem os bytes (restart) | `wait` — **não reconstrói**; consultar é a única ação honesta |
| Durable nonce | `wait` — nonce durável não expira por blockhash, a regra de expiração não se aplica |

Sem `lastValidBlockHeight` não existe prova de expiração — e sem prova, a política NUNCA
autoriza reconstruir. Era exatamente esse número que o código não capturava.

**Trava de voo único.** Só pode existir UMA intenção não terminal por posição+lado. O
caminho autônomo recusa e registra (uma vez, não a cada 3s); o fechamento manual devolve
`409` antes de qualquer assinatura. A situação "assinada mas não sei se chegou" agora
BLOQUEIA a segunda assinatura — é o comportamento certo: preferir uma posição travada a
vender duas vezes.

**Recuperação no boot.** `recoverActiveIntents()` roda ANTES de `reconcileStuckExits()` e
só PERGUNTA à cadeia (nenhuma assinatura, nenhum envio). Um intent `created` (morreu antes
de assinar) é encerrado — nada foi transmitido, é seguro. Um intent com assinatura fica com
o desfecho que a cadeia indicar; sem resposta, permanece ATIVO e bloqueando.

**Nível de confirmação literal.** `processed` (inclusão otimista, ainda revertível) é
gravado como `processed`, não como "confirmado". A posição é dada como vendida — não fazer
isso reabriria a porta para uma segunda venda — e a assinatura fica registrada para
verificação.

**O que NUNCA vai para o disco:** os bytes assinados. Uma transação assinada é dinheiro em
movimento (quem a possui pode transmiti-la); ela vive apenas em memória e é o que permite o
`rebroadcast`. O que é persistido basta para CONSULTAR o desfecho na cadeia. Há teste de
regressão proibindo `wireTransaction`, `serialize()` e assinatura dentro do módulo.

### C35 — posição fantasma e exposição não rastreada

Toda a gestão de risco assumia, sem verificar, que o banco descrevia a carteira:

- **fantasma**: banco diz `open`, carteira não tem o token → o bot calcula stop/alvo de um
  ativo que não existe e, no gatilho, tenta vender zero (falha de saída → circuit breaker →
  ruído que esconde as falhas reais);
- **exposição não rastreada**: carteira tem o token e o bot não a considera posição →
  ativo sem stop, sem alvo, sem ninguém olhando.

Novo `src/positionDesync.ts` (puro) + reconciliação no boot e a cada
`HFT_DESYNC_INTERVAL_MS` (default 60s, piso 15s) + `GET /api/positions/desync`. Uma leitura
de carteira por ciclo (`getParsedTokenAccountsByOwner` para Token program **e** Token-2022),
não uma por posição.

Regras de honestidade (todas com teste):

1. **Falha de leitura ≠ desvio.** Sem snapshot, o veredito é `unknown`. "Não consegui ver" não é "a carteira está vazia".
2. **Janela de tolerância** (`HFT_DESYNC_MIN_AGE_MS`, default 120s): entrada recém-disparada pode não ter confirmado; um falso positivo aqui tiraria uma posição saudável da gestão.
3. **Paper/quarentenada nunca são comparadas** com a cadeia (simulação não tem token on-chain).
4. **Exposição não rastreada só para mints que o BOT tocou** — tokens do operador na carteira não geram alarme. Alarme com ruído é alarme ignorado.
5. **Confirmação dupla antes de marcar fantasma**: se o snapshot agregado não vê o mint, uma segunda leitura DIRIGIDA ao mint precisa concordar. Uma leitura errada retiraria uma posição real da gestão de risco — trocar um problema de dados por um de capital.
6. **Marcar, não corrigir**: nada é fechado, apagado ou quarentenado por esta camada (mesmo princípio do S0). A posição marcada deixa de ser gerida (não há o que vender) e a decisão fica com o operador.

Também corrigido no mesmo eixo: o endpoint de simulação criava posições `open` **sem campo
`mode`**, e o gerenciador as tratava como LIVE — um preço `Math.random()` poderia, em modo
LIVE, acionar uma VENDA REAL de um token que o bot nunca comprou. Passaram a ser gravadas
como `mode: "paper"` com `priceSource` explícito (o restante daquele caminho de simulação
segue na lista de fabricações a remover).

### Estado verificado

```
npm run lint  → exit 0
npm run test  → 82/82 (novos grupos [13] intenções e [14] reconciliação)
```

Verificação ao vivo (servidor reiniciado; sandbox SEM egress, resultado esperado):

```
[Intents] 1 intenção(ões) não terminal(is) encontrada(s) no boot. Consultando a cadeia (somente leitura)...
[Intents] Falha ao consultar a assinatura 5j7s6NiJS3JA...: fetch failed
[Intents] Não foi possível ler a altura de bloco: fetch failed
[Desync] Falha ao ler contas de token (Tokenk...): fetch failed
[Desync] Reconciliação sem snapshot de carteira: 1 posição(ões) não comparadas. (disparo: boot)

GET /api/execution-intents   → activeCount: 1, state "signed" — a intenção NÃO foi encerrada sem
                               evidência (encerrar aqui liberaria uma segunda assinatura)
GET /api/positions/desync    → snapshotAvailable: false, phantom: 0, unknown: 1,
                               note: "nenhum veredito de desvio foi emitido"
```

O cenário do teste ao vivo foi montado com um banco local de FIXTURE (uma posição `live`,
uma intenção `signed`), removido em seguida: o banco operacional deste sandbox é gitignored e
descartável, e a fixture nunca foi comitada.

### O que continua NÃO verificado (declarado, não escondido)

- **Nenhum bundle real foi enviado** (não existe caminho de entrada on-chain), então o ciclo
  completo de intenção — assinar → enviar → confirmar → `rebroadcast` — nunca rodou contra a
  cadeia. O que está testado é a MATRIZ DE DECISÃO, com observações injetadas.
- **A expiração por altura nunca foi exercitada de verdade**: depende de `getBlockHeight` +
  `lastValidBlockHeight` de um RPC saudável. No primeiro uso real, confira nos logs se o
  `rebuild` cita as duas alturas antes de confiar na política.
- **A confirmação dupla do fantasma nunca viu uma carteira real** (sem egress). Se você abrir
  o bot em uma VPS com RPC, o primeiro `GET /api/positions/desync` é a prova que falta.
- A trava de voo único vale **por processo**: duas instâncias do bot na mesma carteira não
  enxergam a intenção uma da outra. Idempotência entre processos exige guarda NA CADEIA, que
  este trabalho não implementa.
- Nota de ambiente: este workspace não persiste `node_modules/`, arquivos gitignored
  (`hft_operational_db.json`, `data/`) nem o ponteiro local da branch entre sessões. O código
  e o histórico vêm do remoto; dados de runtime sempre começam vazios aqui.


---

## Adendo 7 (2026-10-02) — "deixar funcionando": prova de funcionamento, veracidade do painel e runbook

Objetivo desta rodada: responder "está funcionando?" com medição, em vez de impressão.

### C36 — o verificador de endpoints tinha uma seção SILENCIOSA

`npm run verify:endpoints` imprimia a seção `[Programas on-chain]` **vazia** quando
`RPC_ENDPOINT` não estava definido. Seção vazia se lê como "nada a reportar", mas ali
significava "não verifiquei" — e os program ids são exatamente o que já foi fabricado uma vez
neste projeto (C2). Agora a ausência vira uma linha explícita:
`NÃO VERIFICADO: sem RPC_ENDPOINT não há como confirmar que os program ids existem e são executáveis (14 endereços não checados)`.

Também confirmado por medição (não por leitura de código): o script **sai com código 1** quando
há falha (`echo $?` → `1`); o `0` que eu havia visto era do `tail` no pipe.

### Build e execução de produção — verificados de ponta a ponta

`npm run build` (vite + esbuild) e `npm start` (`node dist/server.cjs`) eram um caminho nunca
exercitado nesta auditoria. Verificado:

```
npm run build   → dist/server.cjs 301,7kb + dist/ (assets) — 1 aviso conhecido (import.meta em CJS,
                  inócuo: o código usa __filename primeiro nesse formato)
npm start       → UI HTTP 200 (index.html 1447 B), API ok, POST 503 fail-closed sem ADMIN_TOKEN
                  (fail-closed em produção é o comportamento CORRETO, não um defeito)
```

### `npm run smoke` — prova de funcionamento em um comando (`scripts/smoke.ts`)

Existem 13 estágios que só podem ser provados **na rede do operador**: RPC, socket WS de
detecção, fonte de preço, Jupiter, montagem+simulação da entrada shadow, Jito (tip accounts,
tip floor, status de landing) e gravação do JSONL. O script roda todos, imprime **fato medido**
(RTT, slot, contagem, host, id — nunca rótulo vazio) e sai com código 1 se algum falhar.

Garantias: **não assina, não envia, não usa chave, não escreve no banco operacional** (só lê o
cabeçalho para validar schema v5). O estágio de entrada shadow usa uma pubkey descartável
(`SYSTEM_PROGRAM`) porque em PAPER/SHADOW nenhuma transação é assinada — e o próprio caminho de
simulação do servidor é reaproveitado, não uma reimplementação.

Um detalhe de honestidade: "Jito status de landing" é marcado **⚠️**, não ✅, quando a consulta
é recusada — antes o rótulo verde escondia uma consulta que nunca chegou ao block engine.

### C37 — o painel exibia RNG do servidor como se fosse medição

Nove endpoints do dashboard geram números com `Math.random()` **no servidor**: latências
P50/P99, `inclusion_rate`, `bundles_sent`, score preditivo, "geyser stream", veredito de bundle
("Landed"), cenário de fork, RTT por região e escala de líderes. Nada disso é medição — e um
operador lendo "inclusion rate 91,3%" não tem como saber.

Correção (declarar, não esconder):

- **`GET /api/system-truth`** — o próprio servidor enumera `realSources` (com o estado MEDIDO:
  `socketOpen`/`eventCount`, contagens do banco, intenções ativas, estado do oráculo de tip,
  modo) e `simulatedEndpoints` (com o motivo, endpoint por endpoint), mais
  `summary.liveExecutionPath`.
- **`<TruthBanner/>`** montado no topo de `App.tsx`, permanente e recolhível: `N painel(is) desta
  tela são SIMULAÇÃO (números aleatórios no servidor)`. Se `/api/system-truth` não responder, o
  banner **declara a falha** e pede que todos os números sejam tratados como não verificados —
  não assume estado.
- **`JitoTipOracle.getStatus()`** — corrigido um erro meu de leitura: `getLastError() === null`
  significava "sem erro", mas era lido como "tudo certo" mesmo quando o oráculo **nunca havia
  sido consultado**. Agora há `everQueried`/`lastSuccessAt`/`lastSuccessAgeMs`, e o endpoint
  devolve "nunca consultado neste processo (nenhuma leitura de mercado feita ainda)" em vez de
  "real".

### `OPERACAO.md` — runbook de operação

Documento novo com: estado atual de cada capacidade (o que existe / o que NÃO existe), sequência
do zero ao rodando, tabela de variáveis de ambiente com valor seguro para começar, **como ler
cada resposta** (fato → interpretação correta → interpretação ERRADA, incluindo
`eventCount` como única prova de detecção e `snapshotAvailable` como "não houve comparação" e
nunca "carteira vazia"), checklist da primeira hora, tabela de modos (o que cada um assina/envia),
problemas comuns com o que eles NÃO significam, e a lista do que não está implementado.

### Estado verificado nesta rodada

```
npm run lint              → exit 0
npm run test              → 86/86 (novo grupo [15]: 4 testes)
npm run build             → ok
npm start (produção)      → UI 200 + API ok + POST fail-closed 503
npm run smoke -- --quick  → 13 estágios, 3 falhas de REDE declaradas (sandbox sem egress)
npm run verify:endpoints  → exit 1, com a seção vazia corrigida
GET /api/system-truth     → 4 fontes reais + 9 painéis simulados declarados
```

### O que continua NÃO verificado

- **O smoke nunca passou com egress**: nenhum estágio de rede (RPC, WS, Jupiter, Jito) foi
  observado com sucesso aqui. A execução no SEU ambiente é que produz a evidência.
- **A entrada shadow nunca simulou uma transação real** neste sandbox (sem cotação → sem
  montagem → sem simulação). O caminho está implementado e testado com dependências injetadas,
  não observado ponta a ponta.
- **O banner é visual**: verifiquei que o componente está no bundle servido e que o endpoint
  responde em produção, mas não há verificação de renderização (sem browser neste ambiente).
- **Ruído de fundo observado** (não é bug de bloqueio): quando há posição gerível e o RPC está
  inacessível, o gerenciador repete `getParsedAccountInfo ... fetch failed` a cada ~3s. É a
  tentativa de cotação do preço, que falha honestamente — mas em produção, com RPC instável,
  vale considerar backoff por posição para não gastar cota de RPC.

---

## Adendo 8 (2026-10-02) — S5: correções do caminho quente + instrumentação (SEM assinar/enviar)

Autorização 6. Escopo executado: o **caminho quente** — tudo o que acontece entre a notificação
de lançamento e a decisão de entrar — mais a instrumentação necessária para medir o que antes era
invisível. **Nada foi assinado, nada foi enviado, nenhuma chave real foi usada**; o processo rodou
em PAPER e nenhuma linha nova chama `signTransaction`/`sendRawTransaction`.

### 1. Diagnóstico que originou o S5 (medido no código, não em suposição)

| # | Defeito | Efeito real |
|---|---|---|
| 1 | `getSlot("processed")` **por evento**, só para estimar atraso | 1 RTT pago em TODA decisão, para produzir um número que é estimativa |
| 2 | `getTransaction` com resultado `null` → `return` + log | **lançamento perdido em silêncio**; taxa de perda não existia em número nenhum |
| 3 | `logs.slot` lido via `as any` (campo inexistente) | slot do evento sempre `null`; qualquer métrica de arrasto era impossível |
| 4 | Nenhum dedupe de notificação | WebSocket que reconecta reentrega → **segunda auditoria** (e, em modo real, segunda compra) |
| 5 | Nenhuma trava por mint | Dois matchers do MESMO mint (ex.: pool Raydium anunciado em dois logs) → duas decisões paralelas |
| 6 | `submitViaRpc` usava defaults do SDK (`skipPreflight:false`, `maxRetries:3`) | preflight pago em corrida + retry cego do RPC (inobservável, não interrompível) |
| 7 | `"CO-LOCATED (SHREDSTREAM ACTIVE)"`, throughput/carga/canais com `Math.random()` | painel afirmava infraestrutura inexistente |
| 8 | Nós RPC com latência **constante por região** (12/19/45/124ms) e um nó `rpc-bare-metal-shred` que não existe | failover "decidido" por números fabricados |

### 2. O que mudou

**`src/hotPath.ts` (novo, funções puras — testável sem rede)**
- `SeenLaunchSignatures` — dedupe por assinatura com TTL (120 s) e teto (5 000 entradas: o TTL de
  uma assinatura é irrelevante na prática — ela é única —, mas o teto impede crescimento de memória).
- `InFlightMints` — trava por mint: segundo sinal do mesmo mint é recusado enquanto há decisão em voo.
- `resolveSendOptions` — política de envio explícita: `maxRetries` default **0** (retry é da política
  de EVIDÊNCIA do S4, que reenvia os MESMOS bytes; o RPC repetindo por conta própria é inobservável),
  `skipPreflight` só quando o chamador declara `preSimulated: true`.
- `decideEntryWithBudget` — matriz de decisão do orçamento do filtro profundo, agora com **duas causas
  distintas de incompletude**: `budget` (filtro lento, há dado parcial → LIVE veta, PAPER/SHADOW
  prossegue marcado `unvetted`) e `audit-error` (filtro FALHOU, não há dado nenhum → **bloqueia em
  qualquer modo**: prosseguir sem nenhum dado não é "entrar sem auditar", é comprar às cegas).
- `HotPathStats` — contadores do caminho quente.

**`src/realExecution.ts` (`GeyserStreamClient`)**
- Callback do `onLogs` corrigido para `(logs, context)` — contrato **verificado no código do
  `@solana/web3.js`** (`_wsOnLogsNotification` → `_handleServerNotification(sub, [value, context])`,
  `lib/index.cjs.js` ~8656–8684): `context.slot` é o slot da notificação e agora é usado; `logs.slot`
  (que não existe) foi removido. **Um RTT por evento eliminado.**
- Dedupe por assinatura **antes** de qualquer RTT.
- Enriquecimento com até 3 tentativas em `confirmed` + 80 ms de espera, e a perda contada em
  `enrichmentFailures` (fim do abandono silencioso). **Limite estrutural documentado no código:**
  `getTransaction` não aceita `processed` (tipo `Finality` do SDK + doc da RPC) — a espera até
  `confirmed` NÃO tem solução por retry; quem elimina é `transactionSubscribe` (gRPC), S7.
- `refreshLocalSlotInBackground()` — no máximo 1 `getSlot` a cada 2 s, com 1 em voo (nunca enfileira);
  o evento usa a última amostra conhecida ou `null`.
- `submitViaRpc` passa a usar `resolveSendOptions` (devolve `rationale` junto com a assinatura).
- `getHealth()` expõe `hotPath` (eventos, duplicatas, retries, falhas, idade da amostra de slot).

**`server.ts`**
- **Gate rápido** (custo zero, antes de qualquer rede): `isValidPubkey` + trava por mint + contagem
  de sinal; duplicata é logada com o motivo, não descartada em silêncio.
- **Orçamento do filtro profundo** (`HFT_DEEP_FILTER_BUDGET_MS`, default 900 ms) medido por sinal e
  aplicado pela matriz; a **falha do filtro passa pela MESMA política** (`incompleteCause: "audit-error"`).
- Estágio de latência **`gate_ok`** (received → gate_ok → enriched): mede o overhead do próprio
  processo, que é a parte otimizável sem comprar infraestrutura. **Não** foi criado estágio
  `notified`: não existe canal de notificação ao operador no caminho quente (a UI faz polling);
  instrumentar um passo inexistente seria medição fabricada.
- `/api/system-truth` → `hotPath` com `deepFilterBudgetMs`, `inFlightMints`, contadores e a
  **política de envio vigente** (`sendPolicy`), para o operador não descobrir os defaults no dia do
  incidente. A nota do bloco explica o que cada contador significa **hoje** (incluindo
  `unvettedEntries` estar sempre 0 enquanto o filtro for tudo-ou-nada).
- **C40 (fabricações) corrigidas**: `/api/geyser-stream` deixou de afirmar co-localização/stream de
  shreds e de publicar throughput/carga/canais aleatórios — devolve `measured` (uptime, RSS, versão
  do Node), `declared` (o que só o OPERADOR sabe: onde o host está) e `unmeasured` (o que não é
  medido). Os dois logs de auto-recovery que anunciavam "shredstream connections" e "pool de
  blockhash" passaram a descrever o que o código faz. Os nós RPC deixaram de ter latência constante
  por região e o nó fabricado `rpc-bare-metal-shred` foi removido; quem não tem medição aparece como
  `metricsSource: "unavailable"` e a UI mostra **SEM MEDIÇÃO** em vez do selo SHREDSTREAM que só
  existia para um id inexistente.

**`src/telemetry.ts`** — estágio `gate_ok` em `LATENCY_STAGES` (com o comentário explicando por que
`notified` não existe).

**`src/eventRecorder.ts`** — `RecordedAssessment` ganhou `deepFilterMs` e `deepFilterBudgetMs`
(opcionais): sem esses dois números, "por que não entrei nesse lançamento" vira arqueologia.

### 3. Achado de correção: a regra fail-closed era código MORTO

O `catch` de `fetchRealOnChainTokenData` fazia `return` cedo, então `decideEntryWithBudget` só era
chamada com `deepComplete = true` — as linhas "LIVE + filtro incompleto = veta" **nunca executavam**.
Existia a política escrita e não existia a proteção. Agora a falha roteia pela política, o veto
`audit-error` é alcançável e contado (`deepFilterFailures`), e o teste de regressão lê o fonte para
garantir que o `catch` volte a consultar a política se alguém "simplificar" isso no futuro.

Também corrigido: `liveVetoesByBudget` era incrementado em **reprovação por veredito** (filtro
funcionando), não só em veto por fail-closed — o rótulo mentia no diagnóstico. Agora há
`rejectedByVerdict` separado.

E dois **vazamentos da trava por mint** encontrados na revisão (caminho "execução bloqueada por
kill switch/read-only" e caminho LIVE sem entrada implementada): sem o `release`, o mint ficaria
bloqueado para sempre — a trava viraria negação de serviço contra o próprio bot. O teste de
regressão agora exige `release` em todos os caminhos de saída.

### 4. Testes (grupo [16], +11)

Dedupe com TTL e com teto de memória; trava por mint (aquisição, recusa, liberação); matriz de
envio (default, `preSimulated`, `forcePreflight`, override absurdo); matriz do orçamento
(completo/aprovado, completo/reprovado — reprovação não se contorna nem em PAPER —, incompleto/LIVE,
incompleto/PAPER+SHADOW marcado, `audit-error` bloqueando em QUALQUER modo); estágio `gate_ok` e
ordem dos estágios; e três testes de **regressão sobre o FONTE** (o callback precisa usar
`context.slot`; `getSlot` não pode voltar ao caminho do evento; `resolveSendOptions` precisa ser
usado; nenhuma string de infraestrutura fabricada pode reaparecer; todos os caminhos de saída
precisam liberar o mint; o `catch` precisa consultar a política).

### 5. Estado verificado nesta rodada

```
npm run lint              → exit 0
npm run test              → 97/97 (grupo [16]: 11 testes novos)
npm run build             → ok (dist/server.cjs 314.5 kb)
npm start (produção)      → boot PAPER, bind 0.0.0.0:3000, UI + API ok
GET /api/system-truth     → hotPath: deepFilterBudgetMs=900, inFlightMints=0, contadores zerados,
                            sendPolicy { skipPreflight: true, maxRetries: 0, preflightCommitment: "processed" }
npm run smoke -- --quick  → 13 estágios, 3 falhas de REDE declaradas (sandbox sem egress)
```

### 6. O que continua NÃO verificado / aberto

- **O orçamento hoje só MEDE e VETA; não aborta.** Não há deadline real (`Promise.race`) porque
  `fetchRealOnChainTokenData` é tudo-ou-nada: abortar no meio não produziria dado parcial para
  decidir. Quando o caminho passar a ter dado parcial (S7/gRPC), o deadline real passa a fazer
  sentido — e aí a linha "incompleto + PAPER prossegue" deixa de ser política e passa a ser caminho
  exercitado. Hoje `unvettedEntries` fica em 0, e o endpoint declara isso.
- **Nada disso foi exercitado com rede real neste sandbox** (sem egress): o dedupe, o
  enriquecimento e o gate só têm teste unitário e leitura de código; a evidência de campo depende do
  SEU ambiente.
- **Caminho de ENTRADA on-chain continua não implementado** (`LaunchSwapper` → `NATIVE_BUILDER_DISABLED`).
  O S5 arrumou o caminho quente, não criou a compra.
- **Custo real do filtro profundo ainda não medido** (DexScreener + RPCs inacessíveis aqui): o
  default de 900 ms é ponto de partida, não valor calibrado — calibrar com o p95 do seu PAPER.
- Pendências que continuam no roadmap: S6 (entrada real por IDL, com canary de 0,01 SOL — **exige
  autorização**), S7 (gRPC Yellowstone A/B vs WSS), S8 (envio paralelo Jito/staked), S9 (filtro com
  rótulos), S10 (Postgres/multi-processo/guarda on-chain), S11 (ShredStream), S12 (Rust).

### 7. Complemento (commit `000f580`) — feed do geyser e slot de referência

Enquanto validava o S5 na produção, encontrei a mesma família de defeito (C40) no painel do
Geyser e a corrigi no mesmo escopo:

- `/api/geyser-stream` calculava o slot exibido com `278913410 + (Date.now()/400) % 100000`.
  Agora usa a **última medição real** de slot (nós RPC do laço de infraestrutura; fallback para a
  amostra local de `getSlot`) e devolve `currentSlot: null` + `currentSlotMeasured: false` quando
  não há medição — a UI mostra "— (não medido)" em vez de um número que parece telemetria.
- Os eventos decorativos passaram a se declarar no payload (`simulated: true`, `source: "MOCK/RNG"`)
  e a resposta conta `feed: { real, simulated }`. Antes, saber que eram falsos exigia conhecer a
  convenção interna do prefixo `evt_mock_`.
- `GeyserGrpcRadar.tsx`: saíram o selo "CO-LOCATED (SHREDSTREAM ACTIVE)", o subtítulo "sub-50ms",
  o rodapé "SHREDSTREAM CO-LOCATED (EQUINIX LD4) / ingest sub-1.2ms" e os cards "Stream Rate" e
  "System Ingestion Load" (todos alimentados por RNG do servidor). No lugar: ingestão declarada
  como logsSubscribe via WSS, contagem real vs decorativa e selo "MOCK" por evento.
- **Teste por propriedade** (novo): todo slot derivado do relógio no `server.ts` precisa estar
  dentro de endpoint que `/api/system-truth` já declara como SIMULADO. É a forma correta de
  tolerar painel decorativo — proibindo a string, o teste quebraria; permitindo em qualquer lugar,
  a fabricação voltaria a se esconder.

**Limite honesto desta correção:** os painéis `/api/hft-telemetry`, `/api/jito-leader-schedule`,
`/api/submit-bundle`, `/api/co-location`, `/api/predictive-score`, `/api/simulate-*` e
`/api/geyser-stream` (parte decorativa) **continuam fabricados** — eles estão DECLARADOS como
simulados em `/api/system-truth` e o `TruthBanner` avisa na tela. Rotulá-los painel a painel
(em vez de num único banner) é o S9 do roadmap; não foi feito aqui.

`npm run test` → 98/98. `npm run lint` → exit 0. `npm run build` → ok.

### 8. Complemento (mesmo escopo) — contadores também em `/api/health`

O bloco `hotPath` (contadores do caminho quente) existia só em `/api/system-truth`. Como
`/api/health` é a primeira parada do operador e a sonda do smoke test, os contadores foram
expostos lá também — instrumentação que só aparece no segundo endpoint continua invisível para
quem olha o básico. `npm run test` 98/98 (a verificação nova entrou como asserção adicional no
teste de regressão do caminho quente).

---

## Adendo 9 (2026-10-03) — Máquina GRATUITA: orçamento de cota, medição e playbook

Pedido do usuário: *"de início vou usar tudo de graça para testar, então monte a melhor máquina
nessas condições"* — com o reforço de que o produto final deve **identificar lançamentos, comprar
e vender automaticamente** e ser de nível mundial. Nada aqui assina ou envia transação: o escopo é
a camada gratuita de infraestrutura + medição.

### 1. O diagnóstico que orienta a solução

Em plano gratuito o bot **não falha por latência: falha por `429`**. E o padrão de falha é
perverso — o polling de fundo (medir RTT de nós a cada 5 s, consultar preço de posições, oráculo
de tip) consome a mesma cota que a decisão de um lançamento; o erro aparece exatamente na hora em
que a decisão depende daquele dado. Sem orçamento, o limite do provedor vira uma falha aleatória.

### 2. O que foi implementado

**`src/rateBudget.ts` (novo, funções puras, relógio injetável)**
- `RateBudget` — janela deslizante real (guarda os instantes das aquisições aceitas), com
  `tryAcquire()` **sem `await`** (serve ao caminho quente), `waitMsUntilNextSlot()` e `snapshot()`.
- Presets com o limite **publicado** e o campo `source` dizendo de onde veio cada número:
  `public` 8 req/s (conservador para o endpoint compartilhado), `helius` 10 req/s (1M créditos/mês,
  `sendTransaction` 1/s), `alchemy` 25 req/s (30M CU/mês; `getTransaction` custa 4x), `quicknode`
  ~15 req/s, `syndica` 100 req/s (10M req/mês). Mercado: DexScreener 300 req/min; Jupiter
  60 req/min **por organização**; Jito 1 req/s por IP por região.
- `withBudget()` com três prioridades, e a ordem é uma **decisão de risco, não de estilo**:
  - `exit` — nunca bloqueada (fechar posição/reduzir risco não depende de cota); o excesso é
    contado em `bypassed`;
  - `normal` — espera até `maxWaitMs` (250–300 ms nos call sites) e, se ainda não houver vaga,
    **pula e conta** (`skipped`);
  - `background` — não espera nada (medição de infraestrutura cede a cota ao caminho quente).
- Perfil desconhecido cai em `public` (fail-safe: nunca fica sem teto). `HFT_BUDGET_DISABLED=1`
  desliga o teto **mantendo a contagem** — desligar não pode virar ponto cego.

**Fiação (`server.ts`)**
- DexScreener do filtro profundo e do preço de referência: `normal`, 250 ms de espera.
- Preço de posição (DexScreener e fallback Jupiter) e as cotações de saída
  (`fetchJupiterQuoteWithRetry` e o close manual): `exit`.
- Telemetria de RTT dos nós: cede na hora e o adiamento é contado em `rpcMeasureSkippedByBudget`.
- `GET /api/system-truth → budgets` (teto, `source`, `skipped`, `bypassed`, perfil, se está
  desligado) e `GET /api/health → budgets` (resumo).

**`scripts/free-check.ts` + `npm run free:check`** — mede a pilha gratuita no ambiente do operador
em 8 estágios (config → RPC p50/p95 → WebSocket contando notificações do Pump.fun → DexScreener →
Jupiter → tip floor e block engine do Jito → tabela de orçamentos → recomendação de `.env`).
Regras do script: chave de API **nunca** é impressa (só o host); "0 notificações" é reportado como
**não conclusivo**, não como falha de detecção; sem medição de RPC não há recomendação de endpoint.

**`GRATIS.md`** — playbook: o que o gratuito compra e o que não compra, tabela de limites
publicados por serviço, as cinco decisões da máquina gratuita (um processo por chave; orçamento;
VPS gratuito na mesma região do RPC em vez de máquina doméstica; WSS e a opção PumpPortal; PAPER/
SHADOW e nunca LIVE), `.env` de exemplo, aritmética de cota, ordem de medição e a ordem de upgrade
por dólar (gRPC → envio staked → co-location → Postgres).

### 3. Verdade desconfortável registrada junto (para não se perder no otimismo)

- **Compra e venda reais não são gratuitas.** O ciclo completo (detectar → decidir → entrar →
  gerir → sair) roda **automaticamente hoje, de graça, em PAPER**, com preço real de mercado. A
  entrada on-chain (S6) não está implementada e exige hot wallet com SOL para taxas e tip.
- **"Nível mundial" em velocidade não é alcançável em plano gratuito.** Endpoint compartilhado,
  envio sem prioridade e `sendTransaction` limitado a 1/s (Helius Free) tornam inclusão uma
  questão de sorte. O que se constrói sem dinheiro é o motor correto e a medição que diz
  exatamente onde dói — e é isso que este adendo entrega.
- Os tetos são **publicados**, não medidos por nós: provedor muda limite sem avisar. Se aparecer
  `429` com os contadores dentro do teto, o preset é que está desatualizado.

### 4. Estado verificado

```
npm run lint              → exit 0
npm run test              → 107/107 (grupo [17]: 9 testes de orçamento/cota)
npm run build             → ok
npm start (produção)      → PAPER, /api/health.budgets e /api/system-truth.budgets respondendo
npm run free:check -- --quick → 10 estágios; 5 falhas de REDE do sandbox (sem egress), declaradas
```

### 5. O que continua aberto (com autorização, não por decisão minha)

- **Feed gratuito PumpPortal (`subscribeNewToken`)**: entrega o mint direto na criação do token e
  elimina o `getTransaction` do caminho do lançamento — é o maior ganho gratuito de latência e
  custo. Não foi implementado: é uma fonte de dados nova e precisa da sua autorização.
- **S6 — entrada real com canary de 0,01 SOL**: exige capital, carteira dedicada e autorização
  explícita. É o que transforma "compra e vende automaticamente em PAPER" em execução real.

---

## Adendo 10 (2026-10-03) — Melhores ferramentas GRATUITAS integradas (PumpPortal + RugCheck)

Pedido: *"Use as melhores ferramentas gratuitas disponíveis"*. Interpretação registrada: isto
autoriza **integrar fontes gratuitas de dados/evidência** (leitura), não autoriza execução real —
o S6 continua pendente de autorização explícita e de capital (taxa e tip não são grátis). Nada
neste adendo assina, envia ou gasta.

### 1. Escolha das ferramentas (e por que não outras)

| Ferramenta | Custo | Por que entrou |
|---|---|---|
| **PumpPortal** `subscribeNewToken` / `subscribeMigration` | grátis, sem chave | Entrega o **mint na própria notificação** — elimina `getTransaction` e a espera por `confirmed` que o S5 mediu como gargalo estrutural |
| **RugCheck** `/v1/tokens/{mint}/report` | grátis | Segundo par de olhos no filtro de rug/honeypot (score, riscos, freeze authority, LP) |

Descartadas (com motivo): `pumpdev.io` (terceiro sem histórico verificável — não é "o melhor"),
Birdeye/Solana Tracker (exigem chave e cobram acima do free), gRPC gratuito (não existe: Helius
LaserStream começa no plano Business, US$ 499/mês), DexScreener/Jupiter/Jito (já integrados e
orçados no adendo 9).

### 2. `src/pumpPortalFeed.ts` — o feed que elimina o gargalo

- **Uma conexão por processo.** A documentação do provedor é explícita: várias conexões simultâneas
  podem causar banimento (que expira em 1 hora). `connect()` é idempotente por construção, e o
  teste trava isso.
- Backoff exponencial com jitter e teto de 60 s — reconectar em rajada é justamente o que causa ban.
- Dedupe por assinatura reutilizando `SeenLaunchSignatures` do caminho quente.
- **Parsing defensivo:** a página de documentação não lista os campos da mensagem. O parser exige
  apenas `mint` estruturalmente válido (base58) e trata o resto como opcional; campo ausente vira
  `null`, nunca valor inventado, e `fields` registra o que a mensagem realmente trouxe.
- Zero dependências novas: usa o `WebSocket` global (Node ≥ 22) e aceita `wsFactory` injetada — é o
  que permite testar o feed inteiro **sem abrir socket**.

**Fiação:** o evento entra no MESMO pipeline, marcado `preEnriched: true`, e o pipeline marca
`enriched` imediatamente após o portão rápido. Ou seja, `received → gate_ok → enriched` acontece em
microssegundos em vez de esperar confirmação de bloco. O `logsSubscribe` continua ativo porque é
ele que cobre **Raydium e Meteora** — e porque depender de um único terceiro seria fragilidade.
Quando as duas fontes veem o mesmo lançamento, o portão por mint garante **uma** decisão (a
duplicata aparece em `hotPath.inFlightDuplicatesDropped`).

**Honestidade no painel:** o rótulo da fonte só é `real` com prova de vida (`eventsEmitted > 0`).
Feed criado que nunca conectou é `unavailable` — declarar "real" pelo simples fato de o objeto
existir seria repetir o defeito que este trabalho vem corrigindo. Pelo mesmo motivo,
`enrichmentMs: 0` neste caminho é **zero medido** (o mint veio no evento), não "não medido".

### 3. `src/rugCheck.ts` — evidência que só pode ENDURECER

Três regras, todas com teste:

1. **Indisponível ≠ aprovado.** Falha/timeout/HTTP ruim/cota esgotada viram `available: false` com
   **motivo explícito**, registrado em `missingChecks` e em `evidence.rugcheck`.
2. **Limpo ≠ crédito.** Relatório sem riscos é utilizável mas **não eleva** o score local
   (ausência de risco externo não é atestado de segurança).
3. **Perigo desconta.** Riscos `danger`, score ≥ 500/700 e freeze authority ativa reduzem o score
   (teto de −45) e entram nos motivos de risco.

Orçamento de ~5 req/min (teto prático relatado por terceiros; o provedor não publica limite) com
**espera zero**: evidência adicional não pode atrasar a decisão de um lançamento. Desligável por
`HFT_RUGCHECK=0`.

### 4. Encerramento gracioso (o detalhe que evita ban)

O processo não tinha tratador de sinal: matar o bot deixava o WebSocket do RPC tentando reconectar
para sempre (`max_reconnects: Infinity`) e abandonava a conexão da PumpPortal — exatamente o
comportamento que o provedor avisa que pode banir. Agora `SIGTERM`/`SIGINT` desconectam as duas
fontes e fecham o HTTP, com rede de segurança de 5 s.

### 5. Medição (`npm run free:check` agora tem 12 estágios)

Dois estágios novos: **PumpPortal** (conecta, assina, conta eventos — com três desfechos distintos:
socket não abriu = rede; abriu com 0 eventos = INCONCLUSIVO; abriu com N = feed vivo) e **RugCheck**
(consulta real, mostra score/riscos ou o motivo da indisponibilidade). `.env.example` e `GRATIS.md`
atualizados com as chaves `HFT_PUMPPORTAL`, `PUMPPORTAL_WS_URL` e `HFT_RUGCHECK`.

### 6. Estado verificado

```
npm run lint              → exit 0
npm run test              → 120/120 (grupos [18] feed PumpPortal: 7 testes; [19] RugCheck: 6 testes)
npm run build             → ok
npm start (produção)      → PAPER; /api/health.pumpPortal e /api/system-truth.budgets (6 provedores)
                            respondendo; sem rede no sandbox o feed reporta socketOpen=false e
                            agenda reconexão com backoff, sem fingir estar conectado
```

### 7. O que continua NÃO verificado

- **Nenhuma das duas fontes foi exercitada com rede real neste sandbox** (sem egress). O contrato
  da PumpPortal é o documentado pelo provedor e o do RugCheck é inferido de uso público — o parser
  é defensivo justamente por isso. A primeira execução no SEU ambiente é a validação: se
  `pumpPortal.invalidMessages` subir, o formato mudou; o log diz o motivo e o ajuste é guiado por
  dado observado, não por chute.
- **O feed não substitui o WSS**: se a PumpPortal cair, sobram Raydium/Meteora + pump.fun via logs.
- **RugCheck não garante nada** e não substitui as checagens on-chain do próprio bot.
- **Execução real (S6) continua não implementada** — e não é gratuita: taxa de rede e tip são
  custo real, e o `sendTransaction` do plano gratuito da Helius é limitado a 1/s.

---

## Adendo 11 (2026-10-03) — Preço de mercado EM LOTE: escalar o gratuito sem 429

Segundo pedido de *"use as melhores ferramentas gratuitas"*. O que faltava não era outra fonte —
era **usar as fontes que já existem do jeito certo**. Em plano gratuito o limitante é COTA, e o
gerenciador de posições gastava uma requisição POR POSIÇÃO por ciclo de 3 s.

### 1. A conta que estava prestes a quebrar

Com 10 posições abertas: 10 requisições DexScreener + até 10 cotações Jupiter **a cada 3 s** =
mais de **400 req/min** contra um teto público de **300 req/min**. O bug não estava no mercado:
estava garantido na aritmética. O `429` apareceria exatamente quando houvesse posição para
gerenciar — ou seja, sempre no momento em que o bot mais precisa do preço (stop/take/trailing).

### 2. Contratos verificados (e por que estes três)

| Fonte | Chamada em lote | Limite publicado |
|---|---|---|
| DexScreener | `/latest/dex/tokens/{mints}` — **até 30** endereços | 300 req/min |
| Jupiter Price v3 | `/price/v3?ids={mints}` — **até 50 ids** | 60 req/min (mesmo balde da cotação no Free) |
| GeckoTerminal | `/simple/networks/solana/token_price/{mints}` — até 30 | 30 req/min, grátis, sem chave |

`src/marketPriceFeed.ts` (novo) faz **cascata**: DexScreener primeiro (é a única que dá
`priceNative` — preço JÁ em SOL, sem conversão — e liquidez), Jupiter Price para quem ficou sem
preço, GeckoTerminal como terceira opinião independente. O SOL (`So111...`) entra SEMPRE no lote
das duas últimas para que a conversão USD→SOL venha da MESMA resposta: converter com um SOL/USD
velho ou de fora seria fabricar preço — e preço errado dispara venda por engano.

### 3. Fiação e ganho medido

O laço de gestão passou a montar **uma** requisição por provedor por ciclo para todos os mints
geríveis (exit priority: cota não bloqueia gerenciar risco) e a usar o preço individual apenas
como fallback (Attempt 0 → Attempt 1/2 preservados). Com 30 posições: **30 → 1**. Contadores em
`/api/health → marketBatch` (`requests` vs `mintsRequested` mostra na hora se o lote parou de
funcionar). Chave de volta ao comportamento antigo: `HFT_MARKET_BATCH=0`.

### 4. Bug real encontrado pela execução (de novo o mesmo padrão)

`fetchBatchPrices` deixava a exceção de rede **propagar**: a primeira execução do `free:check`
num sandbox sem egress morreu inteira (`falha inesperada: fetch failed`). Um helper de dado de
mercado não pode derrubar o chamador. Agora toda falha de rede/timeout vira `problema` com
motivo, a cascata continua para a próxima fonte e existe teste específico para o caso
("rede cai (fetch LANÇA)"). É o terceiro bug desta natureza que só a execução real revelou.

### 5. Estado verificado

```
npm run lint  → exit 0
npm run test  → 132/132 (grupo [20]: 12 testes — parsing das 3 fontes, escolha do par de maior
                liquidez, conversão USD→SOL com SOL do lote, "sem SOL NÃO converte", cascata com
                parada antecipada, 3 fontes caídas, chunks 30/50/30, pulo por cota, rede que lança)
npm run build → ok
npm run free:check -- --quick → estágio [3c] mede o lote (aqui degrada com motivo, sem derrubar)
GET /api/health → marketBatch + budgets com 7 provedores
```

### 6. O que continua NÃO verificado / aberto

- **Divergência entre fontes não é detectada automaticamente.** O bot usa a primeira que responde
  e registra qual foi; para operar capital real, comparar fontes (e alertar quando divergirem
  acima de um limiar) passa a ser requisito. É o próximo passo natural de dados, não de latência.
- Nenhuma das três fontes foi exercitada com rede real aqui (sandbox sem egress).
- **Execução real (S6) continua pendente de autorização** e não é gratuita.

---

## Adendo 12 — Qualidade de preço: divergência entre fontes, liquidez em queda e um bug de 200x (2026-10-03)

Autorização: *"Faça o melhor com as ferramentas disponíveis, se der certo vou pagar as ferramentas
se necessário"*. Leitura aplicada: **seguir no plano gratuito** e fechar a pendência que o próprio
Adendo 11 registrou como requisito para capital real. A menção a pagar foi tratada como intenção
futura — não como autorização de gasto nem de entrada real.

### 1. O que faltava (e por que não era latência)

O Adendo 11 deixou explícito: os três preços vinham de fontes independentes, mas **nada comparava
uma com a outra**. A cascata para na primeira fonte que responde — eficiente para cota, cega para
auditoria: se o DexScreener responde tudo, nunca existe segunda opinião, e "sem divergência"
passa a significar apenas "sem verificação".

### 2. `src/priceQuality.ts` (novo)

- **`PriceSampleBook`** — últimas cotações por token/fonte, com memória LIMITADA (`maxPerMint` 4,
  `maxMints` 500, evicção FIFO) porque cache de preço sem teto é vazamento de memória em processo
  de semanas. Preço ≤ 0/`NaN`/`Infinity` nunca entra: sem preço não é amostra, e "sem dado" não
  pode virar "concordam".
- **`relativeDivergencePct` / `classifyDivergence` / `compareSamples`** — diferença relativa
  simétrica (normalizada pelo maior), faixas `ok`/`warn`/`critical` (5%/15% por padrão, ajustáveis
  por env) e comparação de duas amostras explícitas. **Mesma fonte nunca é referência**: o mesmo
  provedor responder duas vezes com preços diferentes é deriva de mercado, não divergência.
- **`assessLiquidityDrop`** — queda relativa ao pico observado (50%/80%), usada como ALERTA.
- Amostra mais velha que a janela (45 s padrão) não serve de referência e o achado carrega
  `ageMs`: comparar preço de agora com preço de minutos atrás transformaria movimento normal em
  "divergência" — o operador precisa do número e da idade, não de um veredito opaco.

### 3. Amostra de verificação (a parte que faz a detecção existir de fato)

`fetchBatchPrices` ganhou `sampleBook`, `divergenceThresholds` e `verifyMints`. A cada ciclo, o
gerenciador pede segunda opinião para uma **amostra rotativa** de até 2 tokens
(`HFT_PRICE_VERIFY_SAMPLE`), sempre na **primeira fonte que ainda não respondeu** (Jupiter →
GeckoTerminal). Custo máximo: **1 requisição extra por ciclo**, com prioridade `background` — a
verificação **nunca fura cota**, nem quando o lote roda com prioridade de saída (teste garante
`bypassed === 0`). Se as três fontes já foram tentadas, a verificação é declarada **impossível**
com motivo registrado, em vez de silenciosamente pulada.

Fiação no `server.ts`: contadores `marketBatch.verifications` / `verificationSources` /
`divergences` / `lastDivergences`, `qualityNote` no `/api/health`, e — no laço — `pos.priceDivergence`
+ alerta de liquidez com `pos.liquidityUsdPeak` / `pos.liquidityAlert` (campos novos em
`DBPosition`, para o pós-mortem sobreviver ao log).

**Nada disso vende.** Divergência e queda de liquidez geram log (WARN/CRITICAL), campo na posição
e contador — nunca ordem. Há teste de regressão que falha se alguém transformar o alerta em
gatilho sem autorização própria; há também teste que garante que `priceQuality.ts` não contém
`sell|swap|sendTransaction`.

### 4. Bug real de ~200x no caminho de preço (achado ao escrever os testes do parser)

`priceNative` do DexScreener é o preço do token-base na moeda de **cotação do par**. Só coincide
com "SOL por token" quando o par é cotado em wrapped SOL. Em par TOKEN/USDC, o número está em
**USDC** — ~200x o preço em SOL (SOL ≈ 200 USD). Os três pontos que liam `priceNative` cru
(parser do lote, preço de referência da entrada paper, fallback por posição) podiam, portanto,
gravar um preço ~200x maior: PnL inventado, stop/alvo disparando por ruído de unidade e, com
capital real, **take-profit imediato após a compra**.

Correção (regra única, `priceSolFromDexPairs`): par cotado em SOL → `priceNative`; par cotado em
outra moeda → `priceUsd / (USD/SOL do PRÓPRIO payload)`; sem âncora de SOL/USD → preço **ausente**
com motivo, nunca o número errado. O wrapped SOL passou a ir na mesma requisição do DexScreener
como âncora (custo zero — mesmo endpoint, até 30 endereços) e vale 1 SOL por definição. Testes
travam a regra: par em USDC converte (0,15 USD → 0,00075 SOL, não 0,15), ausência de âncora
devolve `null`, e o `server.ts` não pode voltar a ler `priceNative` cru.

### 5. Estado verificado

```
npm run lint  → exit 0
npm run test  → 151/151 (grupos [20] lote com 3 testes novos de conversão; [21] qualidade de
                preço com 15 testes: livro limitado, mesma fonte, janela, preço inválido,
                amostra rotativa, verificação que detecta divergência, concordância,
                fonte esgotada, cota esgotada, verificação sem bypass, liquidez, regressão
                alerta-only)
npm run build → ok
npm run free:check -- --quick → 15 estágios; [3d] mede a segunda opinião e, sem rede, registra
                "NÃO houve segunda opinião: <motivo>" como PULADO — não como aprovação
```

### 6. O que continua NÃO verificado / aberto

- **Nenhuma fonte foi exercitada com rede real neste sandbox** (sem egress): a primeira execução
  de verdade é `npm run free:check` no VPS do operador.
- **Política sobre divergência não é automática**: hoje é alerta. Vetar entrada, reduzir posição
  ou pausar o par por divergência exige decisão explícita (e, para agir, execução real autorizada).
- **Preço de ENTRADA ainda não tem verificação cruzada**: a amostra cobre o gerenciamento de
  posições; o caminho de entrada (paper hoje) usa uma fonte por vez. Alinhar isso é pré-requisito
  do S6 — junto com o IDL da instrução de compra.
- `HFT_PRICE_DIVERGENCE=0` desliga o livro de amostras, mas a amostra rotativa continua comparando
  (custo de cota e alerta permanecem). Semântica a alinhar caso o operador queira um kill switch
  completo da verificação.

---

## Adendo 13 — Preço de ENTRADA verificado: o último ponto de fonte única (2026-10-03)

Autorização: *"OK, faça seu melhor com as ferramentas disponíveis"* — mesmo escopo do Adendo 12:
seguir no gratuito, sem gasto e sem entrada real. O Adendo 12 fechou a comparação entre fontes no
**gerenciamento** de posições e listou, como pendência explícita, que o **preço de entrada** ainda
vinha de uma fonte só. É essa pendência que este adendo fecha.

### 1. Por que o preço de entrada merece tratamento separado

No gerenciamento, um preço errado dispara uma decisão errada — ruim, mas reversível no ciclo
seguinte. Na ENTRADA, o preço é o **denominador de todo o PnL da posição**: `pnlPercent`,
stop-loss, take-profit, trailing e o ponto zero do replay são todos percentuais dele. Um erro de
leitura na entrada não "piora um pouco" o resultado — ele **define** o resultado e contamina a
estatística que serve para decidir se a estratégia tem edge. Antes, o `priceNative` de um par em
USDC (o bug de ~200x do Adendo 12) podia entrar exatamente por aqui.

### 2. `src/entryQuality.ts` (novo) — cinco classificações, nenhuma implícita

| Status | Quando | Política |
|---|---|---|
| `verified` | duas fontes independentes concordam dentro do aviso | aceita |
| `verified_with_warning` | concordam, diferença ≥ warn (5% padrão) | aceita e REGISTRA |
| `single_source` | só uma fonte respondeu | aceita, mas MARCA a posição como não verificada |
| `divergent` | diferença ≥ crítico (15% padrão) | **RECUSA** |
| `unavailable` | nenhuma fonte com preço | **RECUSA** |

Dois pontos de desenho que são decisão, não detalhe: (a) a severidade é **recalculada dos bps**
com os mesmos limiares da gestão — um chamador que declare `severity: "ok"` com 50% de diferença
não engana o módulo (há teste); (b) `single_source` **aceita** por padrão, porque "sem segunda
opinião" é ausência de prova, não prova de erro — recusar ali faria o bot parar de coletar dados
toda vez que uma API gratuita piscasse. Quem opera capital real vira
`HFT_ENTRY_ALLOW_SINGLE_SOURCE=0` e passa a exigir duas fontes.

### 3. Fiação

`resolveEntryPrice()` substitui `fetchReferenceMarketPrice()` no caminho paper: usa o MESMO
`fetchBatchPrices` do gerenciador (cascata gratuita + `verifyMints`) com a verificação em
prioridade **`background`** — ela nunca fura cota — e o SOL como âncora de conversão na mesma
requisição. A procedência vai para: a posição (`entryPriceVerification`), o registro de avaliação
(`entryVerificationStatus`, `entryDivergenceBps` — para o replay conseguir estratificar depois), o
log (com as duas fontes nomeadas) e os contadores `GET /api/health → entryQuality`.
`BatchVerification` ganhou `comparisons`: **todas** as comparações, inclusive as que concordaram —
sem isso, "sem divergência" e "sem verificação" seriam indistinguíveis justamente no caminho de
entrada.

### 4. Estado verificado

```
npm run lint  → exit 0
npm run test  → 161/161 (grupo [22]: 10 testes novos — as cinco classificações, recusa em
                divergência crítica, severidade recalculada dos bps, fonte única aceita e
                recusada, verificação desligada, preço inválido/ausente, comparação "ok" vinda
                do lote, e regressão estrutural: server sem fonte única + verificação em fundo)
npm run build → ok
npm run free:check → novo estágio [3e] mede a verificação de entrada no SEU ambiente e diz o
                status (verified / single_source / divergent) com o motivo, sem derrubar o script
```

### 5. O que continua aberto (declarado)

- **Nada foi exercitado com rede real neste sandbox** (sem egress): a validação é o
  `npm run free:check` no VPS do operador.
- **A recusa por divergência é a única política automática adicionada**; as demais (vetar por
  `single_source`, reduzir posição em divergência de gestão) continuam decisão do operador.
- O replay **ainda não estratifica** por `entryVerificationStatus`: o campo é gravado, a análise
  comparativa ("as entradas verificadas tiveram expectativa diferente?") fica para quando houver
  amostra — com menos de `MIN_TRADES_FOR_CONFIDENCE` operações isso seria ruído, não estatística.
- Entrada real (S6) segue **não autorizada**, e o gate de entrada roda em paper — isso não muda.

## Adendo 14 — O perfil de RPC agora é CONFERIDO contra o endpoint (e quatro telemetrias fabricadas caíram) (2026-10-03)

Autorização: *"OK, pode implementar"* — escopo declarado em duas partes: (1) guarda de coerência
entre `HFT_RPC_PROFILE` (teto de cota) e o host de `RPC_ENDPOINT`/`RPC_FALLBACKS`; (2) limpeza da
telemetria fabricada em `/api/jito-leader-schedule`, `HftProfiler.tsx` e `DiagnosticsPanel.tsx`.
Nada aqui habilita entrada real: PAPER/SHADOW seguem sendo o único caminho ativo.

### 1. Por que uma "guarda de coerência" e não só um aviso no README

`HFT_RPC_PROFILE` diz ao `rateBudget` quantas requisições por segundo o processo pode gastar. O
`RPC_ENDPOINT` diz onde elas vão. Se os dois discordam, o bot **opera com um teto que não existe**:
`HFT_RPC_PROFILE=helius` + `RPC_ENDPOINT` público significa ~50 req/s declaradas gastas contra um
endpoint gratuito compartilhado — o 429 chega exatamente no lançamento em que a decisão importa. O
erro é assimétrico e silencioso: nada quebra no boot, nada aparece no log, e a perda só se
materializa como *decisões puladas* (o rate limiter segura a requisição) ou como *erro de rede*
tratado como "RPC fora do ar". Não é um erro de digitação: é um erro de configuração com
consequência de execução.

### 2. `src/rpcProfile.ts` (novo, puro) — `assessRpcCoherence`

`assessRpcCoherence({ endpoint, websocket, fallbacks, declaredProfile })` devolve
`{ declaredProfile, declaredProfileKnown, inferredFromEndpoint, coherent, usingPublicDefaultEndpoint,
observations[{role,host,provider}], issues[{severity,code,message}] }`. Nove códigos, duas
severidades:

| Severidade | Códigos | Efeito |
|---|---|---|
| `mismatch` | `perfil-desconhecido`, `endpoint-publico-com-perfil-dedicado`, `perfil-nao-bate-endpoint`, `perfil-nao-bate-*` por provedores divergentes entre endpoint/WebSocket/fallback | em LIVE: `[Boot][RPC][FATAL]` + `exit(1)` |
| `warn` | `endpoint-ausente`, `host-nao-verificavel`, `endpoint-dedicado-com-perfil-publico` (sub-utilização), WebSocket/fallback de provedor conhecido e diferente, `fallback-misto` | registra e segue |

Três decisões de desenho que são escolha, não detalhe:

- **Host desconhecido é `warn`, não `mismatch`.** Provedor próprio, proxy ou domínio customizado é
  legítimo e comum — este código não tem como verificar a cota contratada. Bloquear o boot por não
  conhecer o domínio transformaria a guarda em obstáculo; o texto do aviso diz o que conferir à mão.
- **Sub-utilização avisa mas não bloqueia.** Perfil `public` com endpoint dedicado **não** estoura
  cota — só desperdiça orçamento. É `warn` (o operador deve subir o perfil), não erro fatal.
- **Só `mismatch` bloqueia, e só em LIVE.** PAPER/SHADOW registram `[Boot][RPC]` e seguem: teste não
  deve exigir infraestrutura paga. A guarda protege **capital**, não a conveniência de quem testa.

`hostFromUrl` devolve **somente o host** — nunca a URL completa, que costuma carregar a chave de API
no path (`.../v0/API_KEY`). O log de boot e o `/api/health` podem ser copiados para um ticket sem
vazar credencial; há teste garantindo que a URL com chave não aparece na saída.

### 3. O que a limpeza de telemetria removeu (e a regra que fica)

O critério aplicado foi o desta rodada: **métrica não medida não pode aparecer como se fosse
medição**. Onde não há medição, o valor passa a ser `null` + rótulo "não medido" + o motivo.

| Onde | Antes (fabricado) | Agora |
|---|---|---|
| `/api/jito-leader-schedule` | slot/regiões/reputação de líder Jito por RNG | `measured:false`; `currentSlot` medido dos nós RPC (ou `null`); `nextLeaderSlot`/`currentLeader`/`isJitoNextLeader`/`blockEngineReputation` = `null`; `regions: []`; `notMeasured{}` + `howToMeasure` |
| `HftProfiler.tsx` | eventos/s, RX/TX, renders/s, jitter/GC e exposição por RNG; Jito "LANDED" sem envio | eventos/s = Δ`detection.eventCount`/Δt real; RTT da lista `rpcLatency[]` de `/api/rpc-nodes`; renders/s por contador real do componente (rotulado como do NAVEGADOR); jitter/GC/Jito = "não medido"; faixa no cabeçalho dizendo o que é do navegador |
| `DiagnosticsPanel.tsx` | laudo decorativo (checks que sempre passavam; PTPv2/"drift física"/"< 1ns" sem medição) | 5 verificações reais (`/api/rpc-nodes`, `/api/health` + `rpcCoherence`, `/api/rpc-infra/blockhash`, `/api/operational-security/state` → `keyCustody`); falha de fetch = `failed`, nunca `passed`; aviso de que co-location é **declaração do operador, não medição** |
| `MevExecutionEngine.tsx` | tip presets e transação fabricados a partir do `/api/submit-bundle` simulado | tip presets de `percentilesSol` de `/api/jito-tips` (+ `tipsMeasuredAt`/`tipsSource`); sem `mockTx`; banner SIMULADO; `LeaderSchedule` null-safe |
| `/api/hft-telemetry` | `currentSlot = 278913410 + (Date.now()/400)%100000` (número que "anda" com o relógio do processo) | `currentSlot` = maior `lastSlot` medido em `rpcMetrics` **ou `null`**; payload agora traz `simulated: true` + `simulatedNote`, e o resto do painel continua declarado em `/api/system-truth → fabricatedEndpoints` |

O último item merece nota: o slot não era só decorativo — ele é o mesmo número que aparece em
painéis de execução, e um valor que cresce ~2,5 slots/s **parece** telemetria de rede. Quem lê "slot
278.913.410" não desconfia. O teste de regressão agora limpa comentários antes de procurar código
proibido (a documentação da correção cita o código removido) e, além de proibir a fórmula, exige que
o endpoint **declare** `simulated: true` e que o slot venha de `rpcMetrics[].lastSlot`.

### 4. Testes e evidências

- `npm run lint` → 0 erros (`tsc --noEmit`, incluindo o estreitamento de tipo novo do `rpcProfile`).
- `npm run test` → **175/175** (eram 161 no Adendo 13; o grupo [23] traz 14 testes novos).
- `npm run build` → ok (`dist/server.cjs`).
- Grupo [23] cobre: `hostFromUrl`/`inferRpcProvider` (incluindo URL com chave), os nove códigos de
  coerência, `warn` de sub-utilização, `mismatch` de inverso, host próprio não-verificável, mistura
  de fallbacks (`observations.length === 4`), regressões do boot (`rpcCoherence`, `process.exit(1)`
  só com `mode === "LIVE"`), `/api/jito-leader-schedule`, painel MEV, `HftProfiler` e
  `DiagnosticsPanel`.

### 5. O que NÃO foi feito (limites desta autorização)

- Coleta real de leader schedule Jito, de reputação de block engine e de RTT por região continua
  **não implementada** — requer endpoints pagos ou medição própria; a resposta certa hoje é `null`
  com o caminho de medição descrito em `howToMeasure`.
- `HFT_RPC_PROFILE` continua sendo **declaração** do operador: a guarda verifica **coerência**
  (perfil × host), não a cota contratada. Cota real se confere no painel do provedor.
- Nada muda em PAPER/SHADOW, quarentena ou no gate de entrada — entrada real (S6) segue não autorizada.

## Adendo 15 — S6: entrada real on-chain, com canário de 0,01 SOL e travas declaradas (2026-10-03)

Autorização: *"S6 OK, autorizado"*. O S6 era, desde o Adendo 9, o item que **exige capital**
(nenhum tier gratuito paga taxa de rede ou tip). Ele estava descrito como "entrada real por IDL,
com canary de 0,01 SOL". Este adendo registra o que foi implementado, **o que NÃO foi** e por quê.

### 1. Uma correção de premissa antes de escrever código

A formulação original do S6 dizia "entrada real **por IDL**". Ao levantar o estado real do
programa do pump.fun antes de implementar, o IDL público (`pump-fun/pump-public-docs`) mostrou um
layout **que mudou de novo**: além de `fee_config`/`fee_program` (índices 14/15 no buy) e dos dois
`volume_accumulator` (12/13), há instruções novas (`init_user_volume_accumulator`,
`sync_user_volume_accumulator`), o `global_volume_accumulator` deixou de exigir writable, e a
documentação mais recente afirma que `user_volume_accumulator` passou a ser **obrigatório para
compras e vendas**. O IDL também já traz `quote_mint`/`add_quote_mint` (suporte a outros ativos de
cotação), o que indica mudança de programa em curso.

Montar bytes de instrução "de cabeça" contra um alvo que muda é a forma mais garantida de queimar
taxa e perder a oportunidade — e o próprio código deste repositório já havia decidido isso
(`NATIVE_BUILDER_DISABLED`, achado C4). **Decisão tomada, e ela é a parte mais importante deste
adendo: o caminho real de entrada usa o AGREGADOR (Jupiter), cuja instrução é construída e mantida
por quem opera o programa, e o builder nativo por IDL vira a etapa S6b (otimização de latência),
com o IDL fixado por hash + dry-run em devnet antes de valer dinheiro.** Correção antes de latência
— a ordem de prioridades declarada neste projeto.

### 2. `src/realEntry.ts` (novo) — o caminho de entrada, com o perigo isolado

- **O módulo não tem acesso a chave.** Não importa `@solana/web3.js`, `security`, `telemetry` nem
  toca `process.env`: todo efeito externo é injetado. Assinar+enviar é **uma** capacidade
  (`signAndSubmit`), e o teste [24] varre o arquivo e falha se `Keypair`,
  `OPERATIONAL_PRIVATE_KEY`, `executeWithDecryptedKeypair` ou `sendTransaction` aparecerem ali.
- **Ordem das operações (cada uma com tempo medido):** gate puro → barreira de assinatura →
  cotação SOL→mint → construção → **pré-flight obrigatório** → blockhash monitorado → assinar+enviar
  → confirmar → ler o fill.
- **A cotação de ENTRADA é SOL → mint.** A inversão (mint → SOL) não seria pega pelo pré-flight se
  houvesse saldo: seria uma VENDA cotada como compra. Há teste de regressão específico para a ordem
  dos argumentos, porque este erro é invisível em revisão de código.
- **`confirmed` exige slot.** `submitted_unconfirmed` é estado próprio: o bundle foi aceito pelo
  block engine e a doc do Jito diz que isso não garante execução. Colapsar em "sucesso" é o erro
  que produziu PnL fabricado nesta base (Adendo 2).
- **Fill medido da cadeia** (`parseEntryFill`): delta de `pre/postTokenBalances` do dono e do mint.
  Transação com `meta.err` é **medição** (0 recebido), não ausência de dado. Saldo que DIMINUIU na
  entrada é inconsistência declarada, nunca quantidade negativa "arredondada" para zero.
- **`num()` corrigido por teste:** `Number("")` é 0 e `Number.isFinite(0)` é true — sem um caso
  explícito de ausência, um ambiente sem `HFT_CANARY_MAX_SOL` teria teto canário **0** e sem
  `HFT_ENTRY_SLIPPAGE_BPS` teria slippage **0** (rejeição garantida). O teste de default pegou isso.

### 3. As travas (e por que cada uma existe)

| Trava | Variável / regra | Efeito |
|---|---|---|
| Caminho ligado | `HFT_REAL_ENTRY_ENABLED=1` | default DESLIGADO; sem ela, `ENTRY_PATH_DISABLED` |
| Modo | `RUNTIME_MODE=LIVE` + `LIVE_TRADING_ENABLED=true` | as duas declarações que já existiam |
| Autonomia | `HFT_AUTONOMOUS_ENTRY=1` | sem ela, só `POST /api/real-entry` (operador no comando) |
| Teto canário | `HFT_CANARY_MAX_SOL` (default **0,01 SOL**) | TETO DURO por entrada, conferido no gate |
| Uma tentativa | `HFT_CANARY_ONE_ENTRY=1` (default) | consome a tentativa só quem **assinou** (`countLandedEntryAttempts`) |
| Impacto | `HFT_ENTRY_MAX_PRICE_IMPACT_BPS` (default 1500 = 15%) | recusa antes de construir |
| Slippage | `HFT_ENTRY_SLIPPAGE_BPS` (default 300) | vai NA INSTRUÇÃO: a AMM rejeita fora da banda |
| Tip | `MAX_TIP_BPS` (default 50 bps do capital) | tip clamp que já existia, agora aplicado à entrada |
| Pré-flight | `HFT_ENTRY_REQUIRE_PREFLIGHT=1` (default) | nenhuma taxa gasta para descobrir o que a simulação diria |
| Exposição | `MAX_TOTAL_EXPOSURE_SOL` | soma das posições abertas + esta entrada |

A regra de consumo do canário é uma decisão de operação, não um detalhe: **falha antes de assinar
(cotação, construção, simulação, blockhash) não consome a tentativa**, porque não tocou a cadeia.
Sem isso, uma oscilação de rede bloquearia o canário até alguém editar o banco à mão.

### 4. Fiação no servidor

- O bloco que **recusava** entrada em LIVE ("entrada on-chain não está implementada") virou o
  caminho real: `runRealEntry` é chamado pelo pipeline quando o modo é LIVE, e só registra posição
  com slot observado. Contadores e motivos vão para o log com componente próprio `REAL_ENTRY`.
- **Intenção persistida antes de assinar** (`createExecutionIntent`/`advanceIntentOrKeep`), com
  `blockhash` + `lastValidBlockHeight`: sem prova de expiração, a política de retry não autoriza
  reconstruir — e a trava de voo único impede uma segunda compra.
- **`POST /api/real-entry`** (canário manual, autenticado por `x-admin-token`) e **`GET /api/real-entry`**
  (política vigente + prontidão + resultados). O painel `/api/system-truth` ganhou o bloco
  `realEntry` com `wouldEnterNow` e os códigos que bloqueiam AGORA, e `summary.liveExecutionPath`
  deixou de dizer "não implementado" para dizer o estado real — o teste que exigia a frase antiga
  foi **substituído por asserções mais específicas** (estado + `wouldEnterNow`), não enfraquecido.

### 5. Evidências (medidas, não declaradas)

`npm run lint` → 0 erros · `npm run test` → **195/195** (eram 175; grupo [24] com 20 testes) ·
`npm run build` → ok.

Boot e rota, verificados de verdade:

| Cenário | Resultado observado |
|---|---|
| PAPER, caminho desligado (default) | `POST /api/real-entry` → 409, código `ENTRY_PATH_DISABLED` + `MODE_NOT_LIVE` |
| `/api/system-truth` | `liveExecutionPath="implementado mas DESLIGADO (modo PAPER…)"`; `realEntry.blockingCodes=[ENTRY_PATH_DISABLED, AUTONOMOUS_ENTRY_DISABLED, MODE_NOT_LIVE]` |
| LIVE + 3 declarações, 0,01 SOL | gate **abre**; pipeline avança até a cotação; sem egress no sandbox → `quote_failed: fetch failed` com **`signature: null`** (falhou antes de assinar) |
| Mesma tentativa repetida | permitida de novo: falha pré-assinatura **não** consumiu o canário |
| 0,5 SOL (50× o teto) | 409, `CANARY_CAP_EXCEEDED` — o teto é duro |

### 6. O que continua aberto (e continua exigindo decisão)

- **Rota é o agregador.** Latência maior que um builder nativo; S6b (IDL fixado + hash + dry-run em
  devnet) é a próxima otimização — não implementada aqui de propósito.
- **Primeira entrada real exige o VPS do operador**: este sandbox não tem egress, então a evidência
  acima termina em `quote_failed`, não em fill. O primeiro canário de verdade precisa: chave
  operacional dedicada com ≥ 0,02 SOL (0,01 de entrada + taxa/tip/rent da ATA), `RPC_ENDPOINT` real,
  `RPC_WEBSOCKET` real e `ADMIN_TOKEN`.
- **Custo mínimo não é zero**: taxa de rede, priority fee, tip Jito (mínimo 1.000 lamports) e rent da
  ATA (~0,002 SOL) são gastos reais — nenhum tier gratuito cobre isso, e é por isso que o S6 estava
  bloqueado até aqui.
- **`3 declarações` não é burocracia**: cada uma responde a uma pergunta diferente (posso operar?
  estou em modo real? deve ENTRAR agora?). Um único booleano respondendo às três é como se produz
  um modo paper que assina.

---

## Adendo 16 — S6b: builder nativo por IDL, com anti-drift e dry-run que não assina (2026-10-03)

### 1. Contexto

O S6 fez a entrada real existir — mas **pela rota do agregador** (Jupiter). Isso paga dois custos
evitáveis num sniper: um round-trip HTTP no caminho crítico e a dependência de o agregador **já ter
rota** para um mint criado há segundos (quando ele não tem, a entrada simplesmente não acontece).
O S6b remove os dois montando a instrução localmente a partir do IDL público — e o preço dessa
decisão é que a responsabilidade pelo layout passa a ser NOSSA. Este adendo é sobre como essa
responsabilidade foi endereçada: uma cópia verbatim do IDL como referência, um builder verificado
CONTRA esse IDL, um dry-run contra a mainnet que não assina, e um anti-drift no boot.

### 2. A pergunta que organiza tudo: "por que confiar no layout?"

Sem agregador, um byte errado em `data` ou uma conta a menos na ordem vira rejeição — e
o pior caso não é rejeição: é um `min_tokens_out` calculado de campos lidos no lugar errado,
que faz o bot **aceitar** um preço ruim. Três defesas, em camadas independentes:

1. **Referência pinada.** `assets/pump-idl-excerpt.json` é transcrição verbatim (sem reescrita) das
   instruções `buy` / `buy_exact_sol_in`, dos discriminadores e dos structs `BondingCurve`/`Global`/
   `Fees`/`FeeTier`/`OptionBool`, com um bloco `_provenance` declarando fonte e transformações.
   **Limite declarado:** o hash do arquivo COMPLETO do IDL não foi capturado (o sandbox não tem
   egress; `curl` falha e o conteúdo veio de leitura por página). Confira `sha256sum` no VPS.
2. **Teste [25] — 25 verificações contra a referência.** Discriminadores byte a byte; ordem,
   `writable` e `signer` das 16 contas comparados UM A UM com o IDL; layouts do parser comparados
   campo a campo com os structs; dados sintéticos montados **a partir do IDL** (não de vetor
   escrito à mão, para que um erro de ordem apareça); cotação reproduzida à mão; recusas.
3. **Anti-drift no boot.** Lê `global` e `fee_config` da rede e confere owner + discriminador +
   tamanho. Três resultados possíveis — e aqui está o ponto: **são três, não dois**.

| Resultado | Significado | Efeito |
|---|---|---|
| `confere` | layout pinado = layout da rede, medido agora | rota native liberada |
| `IDL_DRIFT` | não confere | **exit 1** na rota native; WARN alto na aggregator |
| `IDL_NAO_VERIFICADO` | RPC inalcançável | **nenhum veredito**; native bloqueada |

O terceiro estado existe porque transformar "não consegui perguntar" em "está tudo bem" é
exatamente a telemetria fabricada que o Adendo 14 removeu. `ok: null` é um valor, não um vazio.

### 3. Uma armadilha real, encontrada ao derivar os endereços

O `event_authority` publicado em snippets da comunidade
(`Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7Hx6SgqR`) **não é** o derivado das seeds do IDL
(`Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1`): mesmo prefixo de 36 caracteres, sufixo diferente,
**e os dois são base58 válido de 32 bytes**. Validação por formato — inclusive a que nós mesmos
temos em `isUsableAddress` — não distingue os dois. Só a derivação distingue. O módulo expõe
`EVENT_AUTHORITY_TRAP_ADDRESSES` e o teste [25] mede o prefixo comum em vez de supor um número.
O PDA `global` derivado, por outro lado, confere com a constante pública — o que mostra que a
derivação está certa e que a armadilha é específica daquele endereço copiado.

### 4. O que o módulo faz e o que ele deliberadamente NÃO faz

`src/pumpInstruction.ts` é PURO: nenhuma conexão, nenhuma chave, nenhum `fetch`, nenhuma assinatura
(há teste que varre o arquivo procurando esses símbolos). Ele monta: dados de instrução, contas na
ordem do IDL, PDAs por seeds, cotação pela fórmula oficial (4 passos, com `null` quando não dá para
calcular — nunca um número inventado) e `min_tokens_out` conservador (piso, clamp em 9.999 bps,
porque 10.000 bps significaria aceitar qualquer preço, inclusive o de um rug).

Decisão de instrução: `buy_exact_sol_in` (gasta o SOL exato e impõe `min_tokens_out`) em vez de
`buy` (`max_sol_cost`), porque o limite que protege o sniper é o de **token recebido**. `*_v2`
(quote mint não-SOL) não foi implementada: `assertSolQuotedCurve` recusa curva não cotada em SOL.

### 5. Evidências (medidas, não declaradas)

`npm run lint` → 0 erros · `npm run test` → **221/221** (eram 195; grupo [25] com 26 testes) ·
`npm run build` → ok.

| Cenário | Resultado observado |
|---|---|
| Boot PAPER, rota aggregator, RPC inalcançável | `[Boot][IDL] … Isto NÃO é IDL_DRIFT — é indeterminado`; `GET /api/real-entry` → `entryRoute:"aggregator"`, `idlDrift:{checked:true,ok:null,code:"IDL_NAO_VERIFICADO"}` |
| Boot PAPER com `HFT_ENTRY_ROUTE=native`, RPC inalcançável | `[Boot][IDL][FATAL] Rota native exige layout verificado…` → **exit 1** |
| `npm run pump:dryrun` sem rede | falha com diagnóstico de REDE (`confirme egress/firewall`), **sem emitir veredito de layout** — dizer "layout ok" sem ter perguntado seria o pior desfecho possível |
| Teste de mecanismo (sem rede, chave efêmera em memória) | trocar `tx.message.recentBlockhash` depois de montar sobrevive à assinatura e à serialização — é disso que a rota nativa depende |
| Guarda de entrada | `entryRoute === "native" && pumpIdlDrift.ok !== true` → recusa ANTES de montar (defesa em profundidade: o boot é um instante, a variável de ambiente pode mudar) |

### 6. O que continua aberto

- **A validação de layout contra a mainnet depende do VPS do operador.** Este sandbox não tem
  egress: o dry-run terminou em diagnóstico de rede, não em `err: null`. **Nada aqui autoriza ligar
  `HFT_ENTRY_ROUTE=native`:** o primeiro passo fora do sandbox é
  `npm run pump:dryrun -- <mint> --payer <chave-pública>` e `verdict: err: null`.
- **Hash do IDL completo não capturado** (ver §2.1). O excerto é fiel à leitura, mas a conferência
  independente (`sha256sum` do `pump.json` oficial) tem de ser feita onde há rede.
- **Rota native não foi exercitada on-chain**: nem devnet (o pump é mainnet) nem mainnet. Ela está
  implementada, testada estaticamente e *desligada*.
- **S8 (envio paralelo/bundle) segue não implementado** — a rota nativa melhora a montagem, não o
  envio. Sem bundle, o landing continua sujeito ao que o RPC entregar.

---

## Adendo 17 — S7 (ingestão gRPC) e S8 (envio paralelo): o que cada um remove do caminho crítico (2026-10-05)

### 1. Contexto

O S6b tirou o agregador do caminho de MONTAGEM da compra. Restavam dois gargalos declarados:
**detecção** (o mint do pump só era obtido com `getTransaction` em `confirmed`, porque a RPC não
aceita `processed` nessa chamada — uma espera estrutural, não um bug) e **entrega** (a transação
saía por um único caminho — o bundle Jito). Este adendo cobre os dois, com a mesma régua dos
anteriores: o que entra é o que foi medido; o que não foi medido aparece como não medido.

### 2. S7 — ingestão gRPC (Yellowstone)

**O que muda no caminho crítico, em concreto:** a transação chega inteira no próprio update do
stream (mensagem + meta + logs) em `processed`. O mint passa a vir do `CreateEvent` **dentro dos
logs daquela transação**, decodificado do IDL pinado — zero `getTransaction`, zero repetição de
80 ms, zero espera por confirmação para ENRIQUECER. A confirmação continua obrigatória para
DECIDIR (o `realEntry` exige slot observado).

**Decisão de arquitetura: aditivo, não substituto.** O WebSocket continua assinando os 4 programas.
Motivo medido: trocar de transporte não pode custar COBERTURA — Raydium/CPMM/Meteora também criam
pools, e o WSS é o que os cobre. Com os dois ativos, o mesmo lançamento pode chegar duas vezes; por
isso há dedupe por assinatura **entre fontes** (`crossSourceDuplicatesDropped` no health), com teto
de memória e descarte FIFO. Contador alto ali é o comportamento esperado do dedupe, não defeito.

**Segredo:** o token do provedor nunca entra em log — `redactGrpcEndpoint` cobre credencial com e
sem esquema de URL, `sanitizeGrpcError` remove o valor das mensagens, e há teste que varre o código.
O teste pegou uma falha real na primeira versão da redação (só tratava `proto://user:pass@host`).

### 3. S8 — envio paralelo

**O que paraleliza é a ENTREGA, nunca a assinatura.** A transação é assinada UMA vez; os bytes são
idênticos em todos os caminhos, e na Solana a assinatura é o identificador da transação — os mesmos
bytes não podem entrar duas vezes. Duplicar a operação exigiria assinar duas vezes, e isso o sistema
de intenções bloqueia ANTES de assinar. Esta é a razão pela qual a corrida é segura por construção,
e ela está escrita no módulo e fixada por teste.

**Semântica fixada por teste:** todos partem juntos; o primeiro aceite vence; **os perdedores não são
cancelados** (abortar um envio que poderia entrar no próximo bloco destruiria o motivo da corrida);
todos falhando, os motivos são AGREGADOS (`jito=HTTP 429 | staked=HTTP 403`), nunca um erro genérico;
timeout por transporte sem deixar `await` pendurado; transporte duplicado é config inválida.

**Aceite exige prova:** o transporte com stake só considera aceito quando o JSON-RPC devolve
assinatura em `result`. HTTP 200 com corpo estranho, `{error: ...}` ou resposta não-JSON são
RECUSAS declaradas. Aceitar "algo respondeu 200" é como a telemetria vira ficção.

**O que NÃO foi feito, de propósito:** nenhum endpoint de provedor foi inventado. O caminho com
stake exige URL do operador (`HFT_STAKED_SENDER_URL`) e uma relação de stake/tip com o provedor que
é de infraestrutura, não de código. Sem URL, o transporte simplesmente não entra na corrida — e o
fato de estar fora é declarado em `GET /api/real-entry → parallelSend.notes`.

### 4. Progresso do IDL: discriminadores agora são VERIFICADOS, não lidos

O excerto ganhou os eventos (`CreateEvent`, `TradeEvent`, `CompleteEvent`,
`CompletePumpAmmMigrationEvent`, `Shareholder`) — verbatim dos blocos 29/30/32/33 do IDL oficial. E
o teste [25] passou a conferir **todo** discriminador por recálculo de
`sha256("global:nome")` / `sha256("account:Nome")` / `sha256("event:Nome")` (primeiros 8 bytes): o
esquema do Anchor é público e conferível sem rede. Isso é verificação independente da transcrição —
o mesmo tipo de prova que pegou o endereço sósia do `event_authority` no S6b.

### 5. Evidências (medidas, não declaradas)

`npm run lint` → 0 erros · `npm run test` → **244/244** (eram 221; grupos [26] e [27] com 23 testes) ·
`npm run build` → ok.

| Cenário | Resultado observado |
|---|---|
| Boot PAPER com `HFT_INGEST=grpc` + endpoint inexistente | WSS segue assinando **os 4 programas**; gRPC tenta, falha e faz backoff 1s→2s→4s→8s; `/api/real-entry → ingest.active.reconnects` conta as tentativas |
| Token do provedor no ambiente | **0 ocorrências** do valor em todo o log de boot (verificado por `grep -c`) |
| `npm run grpc:check --url <inexistente> --token <segredo>` | verdict honesto (`canal MUDO`), motivos por extenso, `reconnects: 3`, token ausente da saída, e a instrução de manter `wss` |
| `npm run grpc:check` sem endpoint | recusa com motivo e **sem** stack trace: não inventa endpoint |
| Boot PAPER com `HFT_PARALLEL_SEND=1` + sender + RPC direto | `[Boot][Env]` declara `jito + staked + rpc` e as ressalvas (`?swqos_only=true`, cota de envio, base da segurança) |
| `/api/real-entry` em PAPER | `parallelSend.policy` e `ingest.policy` publicados; `idlDrift` continua `IDL_NAO_VERIFICADO` neste sandbox (sem egress) |
| Pacote nativo no bundle CJS | carregado por `import()` dinâmico: o runtime subiu e a falha de conexão veio do provedor, não do módulo |
| Timeout de transporte | transporte pendurado morre no limite configurado e o resultado sai mesmo assim (teste: < 1,5s para timeout de 120ms) |

### 6. O que continua aberto

- **Nenhum dos dois foi exercitado contra infraestrutura real aqui**: não há egress neste sandbox. O
  gRPC precisa de `npm run grpc:check` no VPS; a corrida precisa de um sender com stake configurado
  pelo operador. **Nada disto autoriza ligar `HFT_INGEST=grpc` nem `HFT_PARALLEL_SEND=1` sozinho.**
- **Taxa de aceite por caminho não é medida aqui.** Publicado (RPC público < 30%, mid-tier 70-75%,
  dedicado ~94%) é número de terceiro — o sistema registra CADA tentativa com latência e motivo
  (`[S8] transporte … ACEITOU/recusou … em Nms`), que é o dado bruto para calcular a taxa quando
  houver amostra.
- **`processed` não é final**: detecção em `processed` acelera, mas uma transação pode não entrar no
  bloco. A confirmação com slot observado continua sendo o único caminho para uma posição existir.
- **S9+ seguem fora**: rótulos de resultado, Postgres, ShredStream, Rust.

## Adendo 18 — S9 (rótulos de resultado) e S10 (Postgres com voo único entre processos) (2026-10-05)

### 1. Contexto

O ciclo anterior fechou S7+S8 (`349308f`). A autorização 16 mandou executar os passos 3 e 4 do plano:
**validar a estratégia estatisticamente** (S9) e **tirar a persistência do JSON de 50 trades** (S10).
A pergunta que o S9 existe para responder é a mais desconfortável do projeto: *o que já operou tem
edge?* — e a resposta honesta depende de separar "ganhou em alguns trades" de "estratégia validada".

### 2. Diagnóstico

| Problema | Consequência de não tratar |
|---|---|
| Não havia rótulo para o que cada registro É (medido, estimado, tentativa falhada, perna de entrada) | Percentual de posição e PnL medido on-chain entrariam no mesmo balde e "ganhou em 3 trades" viraria "estratégia lucrativa" |
| `TransactionalStore` guarda **50 trades** e `positions` crescem sem teto | A amostra nunca chegaria ao piso declarado de 100 desfechos: a conclusão estatística era impossível por construção |
| Trava de voo único em memória (`InFlightMints`) | Duas instâncias do bot na mesma carteira entram no mesmo mint; nenhuma vê a outra |
| Sem veredito explícito de "não conclui" | O operador decide com base em n<100 achando que decidiu com base em evidência |

### 3. O que foi implementado

**S9 — rótulos e validação (`src/outcomeLabels.ts`, `src/strategyValidation.ts`, `GET /api/performance`)**

- Cada desfecho carrega `basis` (`net_measured` | `price_estimated` | `none`) e `excluded` com
  motivo. Só `net_measured` + `mode=live` entram na validação. `paper` tem rótulo (diagnóstico) e
  **nunca** conta, mesmo com PnL. `entry_leg` (entrada confirmada sem saída) não é resultado.
  Tentativa falhada é **custo**, não desfecho — o rótulo diz isso.
- PnL sem medição on-chain NÃO é promovido a resultado: o campo sai `null` e o rótulo vira
  `estimated_*`/`unresolved`. Zero e "não medido" nunca se confundem (regra da aut. 12).
- Empate usa epsilon declarado de 1.000 lamports (1 base fee), não `=== 0` com número flutuante.
- Veredito em 5 estados: `sem_dados` · `amostra_insuficiente` (piso declarado de 100, herdado de
  `MIN_TRADES_FOR_CONFIDENCE`) · `indistinguivel_de_zero` (IC 95% da média contém zero) ·
  `edge_negativo` · `candidato_a_edge`. **Nenhum deles afirma "lucrativo"**: `candidato_a_edge` vem
  com a ressalva de que candidato ≠ lucrativo.
- IC de win rate por **Wilson** (não normal): em amostras pequenas o intervalo não sai de [0,1] nem
  dá 0% de erro para 0/10. IC da média com n≥2; com n=1 o desvio-padrão é `null` — melhor "não
  calculável" que número inventado. `skewRatio` avisa quando um único trade domina o resultado, o
  que torna o IC otimista.
- O relatório declara a **fonte** (json-local ou postgres), quantos registros leu, se truncou e
  quantos ficaram de fora por motivo. Sem isso, "expectância" de uma amostra truncada passaria por
  expectância da operação.

**S10 — Postgres (`src/storage/schema.ts`, `src/storage/postgresStorage.ts`, boot, endpoints, scripts)**

- Schema v1 aditivo: `positions`, `trades`, `intents`, `entry_claims`, `decision_logs`, todas com
  `payload JSONB` (o schema não perde campo que ele não conhece). Migração idempotente e
  transacional; **não existe migração destrutiva** — o teste [29] falha se alguém introduzir
  `DROP`/`TRUNCATE`.
- **Voo único entre processos por ÍNDICE ÚNICO PARCIAL** `entry_claims (mint, side) WHERE state='active'`,
  não por "consultar e depois inserir" (que tem corrida) nem por advisory lock (que amarra a
  conexão e quebra com pool). O perdedor recebe **quem** detém e **até quando**.
- Claim com **TTL** (default 300s) e **retomada atômica** (`UPDATE … WHERE expires_at < now()`):
  processo que morre não bloqueia o mint para sempre. Liberação só pelo `claim_id` dono — se fosse
  por `(mint, side)`, o dono antigo liberaria o claim do novo e **dois** processos entrariam.
- Espelho **write-through**: o JSON continua sendo a fonte operacional e recebe as gravações
  normalmente; o banco é cópia. Sink com captura de exceção — banco fora do ar degrada a
  durabilidade, **não** impede a operação nem apaga histórico.
- **Fail-closed no boot**: `HFT_STORAGE=postgres` sem `DATABASE_URL`, com modo desconhecido, ou com
  banco inacessível/schema atrás ⇒ `[Boot][Storage][FATAL]` + `exit 1`. Subir sem o árbitro que o
  operador acha que tem é pior que não subir. `HFT_STORAGE=json` (default) mantém o comportamento
  anterior, com o limite declarado (voo único por processo, 50 trades).
- **Claim com timeout = recusa** (`STORAGE_CLAIM_TIMEOUT`, 1,5s): banco lento não vira "provavelmente
  livre, então assina".
- Modo JSON **não paga** o custo do `pg`: o pacote é carregado por `import()` dinâmico.
- `HFT_STORAGE_HISTORY_LIMIT` com teto de 1.000.000 (histórico ilimitado em memória é
  DoS de si mesmo); `HFT_STORAGE_MIRROR_LOGS=critical|all|off`. Valor inválido cai no default
  **declarado**, nunca em comportamento implícito.

### 4. Quatro defeitos encontrados durante a própria implementação (e corrigidos)

1. **`initialize()` reportava banco NOVO como "sem conexão"**: a consulta a `schema_migrations`
   falhava numa base vazia e o `catch` marcava `connected=false`. Efeito prático: o boot
   abortava (fail-closed) e o log dizia "sem conexão" quando a conexão estava perfeita, tornando
   impossível apontar o bot para um banco limpo. Agora usa `to_regclass` e separa os dois estados.
2. **Modo desconhecido em `HFT_STORAGE` era ignorado** quando `DATABASE_URL` estava ausente — o
   operador ficava acreditando ter configurado um banco. Bloqueio agora existe por si.
3. **A recusa do endpoint `POST /api/real-entry` não era registrada.** A pré-checagem do endpoint
   recusava com 409 **antes** de `runRealEntry` e não gravava nada: log de decisão vazio
   justamente quando alguém tentou operar com o caminho desligado. As duas recusas passaram a usar
   um helper único (`registrarRecusaDeEntrada`).
4. **`listActiveClaims` não devolvia o `claim_id`**, o que convidava a liberar claim por mint no
   encerramento — exatamente o erro que permite dois processos no mesmo mint. Agora devolve o id e
   o shutdown libera por id, aguardando a conclusão antes de sair.

### 5. Evidências (medidas, não declaradas)

`npm run lint` → 0 · `npm run test` → **265/265** (eram 244; grupos [28] com 9 e [29] com 12) ·
`npm run build` → ok.

| Cenário | Resultado observado |
|---|---|
| `npm run storage:selftest` (Postgres WASM + driver `pg` por TCP) | **15/15** · índice parcial conferido no catálogo (`entry_claims_active_unique … WHERE (state = 'active')`) · insert cru concorrente rejeitado com `duplicate key` |
| Boot `HFT_STORAGE=postgres` sem `DATABASE_URL` | `[Boot][Storage][FATAL] … exige DATABASE_URL` + `exit 1` |
| Boot com `HFT_STORAGE=mysql` | `[Boot][Storage][FATAL] … não é um modo conhecido` + `exit 1` |
| Boot com banco inalcançável (`127.0.0.1:1`) | `[Boot][Storage][FATAL] … ECONNREFUSED` + `exit 1` — credencial **não** aparece no log |
| Boot real com Postgres por TCP, banco vazio | `schema em ausente < esperado: aplicando migrações` → `migrações aplicadas: [1]` → `Postgres pronto: schema v1` |
| `/api/storage` | `policy`, `health` (schema, owner, escritas, falhas, claims), `counts`, `activeClaims`, `entryGuard` e a **garantia** declarada por modo |
| `POST /api/real-entry` em PAPER | recusa `ENTRY_PATH_DISABLED`/`MODE_NOT_LIVE` → log espelhado: `writes=1`, `counts.logs=1` |
| `/api/performance` com Postgres ativo | `source.name = "postgres"`, `tradesRead` declarado; sem dados → veredito `sem_dados` |
| `/api/system-truth` | nova fonte `armazenamento (S10)` → `read-only`, com o estado e a ressalva |
| Shutdown (SIGTERM) | libera claims da própria instância por `claim_id` e fecha o pool antes de sair |

### 6. O que continua aberto (e o que NÃO foi provado)

- **O caminho de rede do provedor real não foi exercitado aqui.** O Postgres do sandbox é
  PostgreSQL 18/WASM atrás de um socket local — cobre SQL, índice parcial, intervalo e semântica do
  claim, mas **não** cobre TLS, pooler (PgBouncer/Supavisor), limites de conexão nem permissões do
  provedor. Isso é `npm run storage:check` no VPS.
- **Concorrência simultânea não é testável neste sandbox** (o Postgres WASM atende uma conexão por
  vez). A disputa testada é sequencial — que é a ordem do caso real. A garantia contra dois claims
  no mesmo instante é o índice único, não uma checagem em código.
- **O claim dentro de `runRealEntry` nunca foi executado de verdade**: ele vive depois do gate e
  exige `RUNTIME_MODE=LIVE` + `HFT_REAL_ENTRY_ENABLED=1`. Ligar isso para testar significaria
  assinar e enviar transação real — não foi feito. O que está provado é o adaptador (teste [29] e
  `storage:selftest`) e a **posição** do claim no código (teste de fiação: claim antes de montar,
  `release` no `finally`).
- **S9 não tem amostra nenhuma**: `GET /api/performance` opera corretamente e conclui `sem_dados`.
  Qualquer afirmação sobre edge depende de acumular ≥100 desfechos `net_measured` em live.
- **O banco não é a fonte operacional** — é espelho. Trocar a fonte é uma decisão futura, com
  migração de leitura e reconciliação, não um efeito colateral deste adendo.
- **Nada disto autoriza entrada real.** `HFT_REAL_ENTRY_ENABLED=0` continua o default, e o S10
  apenas torna o voo único verificável entre processos quando a entrada for autorizada.

## Adendo 19 — S11: o "PnL medido" era a RECEITA da venda (defeito de correção, 2026-10-05)

### 1. Como o defeito foi encontrado

Revisando o caminho que alimenta o S9 (`/api/performance`) com a pergunta "o que produz um desfecho
`net_measured`?". A resposta levou a `measureExitEconomics`, e o corpo dela a uma conta de uma linha:

```ts
solDeltaSol: (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9
```

Esse delta é da **transação de saída**. Gravado como `pnlNetSol` com `measuredOnChain: true`.

### 2. Por que isto é grave (e não um arredondamento)

O número medido é o crédito da venda menos os custos DA VENDA. Ele **não contém o custo da compra**.

| Operação | O que o código reportava | PnL real do ciclo |
|---|---|---|
| Compra 0,01 SOL → venda rende 0,02 SOL | `+0,02 SOL` "medido on-chain" | `+0,01 SOL` |
| Compra 0,01 SOL → venda rende 0,01 SOL (empate) | `+0,01 SOL` "medido on-chain" | `0,00 SOL` |
| Compra 0,01 SOL → venda rende 0,005 SOL (perda) | `+0,005 SOL` "medido on-chain" | `−0,005 SOL` |

Três consequências encadeadas:

1. **Erro do tamanho da posição, sempre para cima.** Não há cenário em que a inflação seja pequena.
2. **Perdas apareciam como ganhos.** Uma operação que perde 50% ainda reportava lucro positivo — o
   "lucro" era a entrada de volta.
3. **O S9 validaria a estratégia errada.** Como o número vinha marcado `measuredOnChain: true`, ele
   era classificado `net_measured` e entrava na validação. A estratégia "compra e vende no mesmo
   preço" teria expectância positiva medida on-chain, e o veredito caminharia para
   `candidato_a_edge` com dado **medido**, não estimado. Este era o caminho pelo qual o bot poderia
   "provar" um edge inexistente — exatamente o que o S9 existe para impedir.

Origem do erro: o comentário do próprio extrator dizia *"o fluxo de caixa efetivo, incluindo TODOS
os custos. É a única medida em que confiamos"*. Ele media todos os custos **de uma transação**, e a
transação de venda não tem o custo da compra. A frase estava certa sobre o método e errada sobre o
escopo — e foi essa ambiguidade que sustentou o defeito.

### 3. A correção

`src/roundTrip.ts` (novo): duas funções PURAS — `parseTransactionLeg` (economia de uma transação) e
`computeRoundTrip` (combinação das duas pernas) — mais o wrapper de RPC `measureLeg`/`measureRoundTrip`
no `server.ts`.

```
PnL do ciclo = ΔSOL(entrada) + ΔSOL(saída)
```

Cada delta vem da PRÓPRIA transação, então a soma é imune a movimentações de SOL não relacionadas
que ocorram entre uma e outra (diferente de comparar o saldo da carteira antes e depois, que só é
exato numa carteira dedicada).

**A perna de entrada é medida e gravada na posição** (`entryLeg`) no momento da confirmação da
compra — depois da confirmação, portanto fora do caminho crítico de assinatura (não atrasa nenhuma
decisão: não há transação pendente esperando por ela).

| Situação | Antes | Agora |
|---|---|---|
| Duas pernas medidas | `net_measured` com o valor da venda | `net_measured` com o valor do **ciclo** |
| Só a saída medida | `net_measured` (RECEITA) | `single_leg_measured`, rótulo próprio, **excluído** da validação |
| Procedência não declarada (registro antigo) | `net_measured` | `single_leg_measured` — fail-closed |
| Perna de entrada ausente | somava com zero | `exit_leg_only`: PnL `null`, receita declarada em `saleProceedsSol` |

Regras novas, todas com teste:

- **Procedência obrigatória.** `measuredOnChain: true` sozinho não promove nada: o rótulo exige
  `pnlBasis` igual a `round_trip_legs` ou `round_trip_legs_window_conflict`.
- **`saleProceedsSol`** é o nome próprio da receita da venda. Ela continua sendo reportada (é
  diagnóstico valioso) e nunca é chamada de PnL.
- **Cobertura fecha.** `coverage.singleLegMeasured` conta esses registros; se a soma das categorias
  não fechar com o total, o relatório declara **bug de classificação** (antes eles sumiriam da
  contagem e o operador não saberia onde foram parar).
- **Venda parcial não fecha posição.** O tamanho da posição vem do Δ de tokens da entrada; vender
  menos que isso marca `partialExit` com a fração exata, e vender MAIS gera aviso (pode haver tokens
  do mesmo mint fora desta posição).
- **Divergência de janela, sem RPC extra.** Se as duas pernas têm saldos absolutos, a diferença
  `pre(saída) − post(entrada)` revela movimentação de SOL por fora do ciclo (outra posição,
  transferência, fee avulsa). O PnL continua exato; o fato é declarado. `HFT_PNL_WINDOW_CHECK=1`
  acrescenta a conferência por `getBalance` (com o custo de latência declarado).

### 4. O que mudou para quem já tem dados

Registros gravados antes desta versão têm `measuredOnChain: true` e **não têm** `pnlBasis`. Eles
passam a ser classificados como `single_leg_measured` e ficam **fora** da validação, com o motivo
escrito no próprio rótulo. Isto é intencional: o número deles é a receita da venda, e usá-lo seria
repetir o defeito. O caminho para reabilitá-los é remeasurear a partir das assinaturas (as duas
transações estão na cadeia), não reinterpretar o número antigo.

### 5. Evidências

`npm run lint` → 0 · `npm run test` → **273/273** (eram 265; grupo [30] com 7 testes, e o teste
[28] ganhou a regressão de procedência) · `npm run build` → ok · boot PAPER limpo.

| Cenário | Resultado |
|---|---|
| Compra 0,01 SOL, venda rende 0,02 SOL | PnL do ciclo **+0,01** (não +0,02) · `basis=round_trip_legs` · janela confere |
| Compra 0,01, venda rende 0,01 (empate) | PnL **exatamente 0** lamports (antes: +0,01 "medido") |
| Compra 0,01, venda rende 0,005 (perda) | PnL **−0,005** (antes: +0,005 "medido") |
| Venda que falhou on-chain | PnL medido = custo do fracasso, com nota explícita |
| Só a saída medida | `exit_leg_only`, PnL `null`, receita em `saleProceedsSol`, excluído da validação |
| `measuredOnChain: true` sem `pnlBasis` | `single_leg_measured` (fail-closed), excluído |
| Carteira não dedicada (0,05 SOL movidos no meio) | PnL do ciclo intacto + `windowConflict` + nota |
| Venda de 50% da posição | `partialExit` com a fração, "NÃO está fechada" |
| Fiação | as DUAS saídas reais usam o ciclo; `measureExitEconomics` **não existe mais** |

### 6. O que continua aberto

- **A correção não foi exercitada com dinheiro real.** Exige `RUNTIME_MODE=LIVE` +
  `HFT_REAL_ENTRY_ENABLED=1` e uma transação de verdade; nenhuma foi feita. O que está provado é a
  aritmética (testes puros), a extração (testes contra a forma do RPC) e a fiação (código).
- **Posições abertas antes desta versão não têm `entryLeg`.** O ciclo delas é declarado não medido.
  Reabilitar exige remeasurear as assinaturas na cadeia — não reinterpretar o número antigo.
- **`getTransaction` pode não devolver transações antigas** em nós podados: nesse caso a perna fica
  `measured: false` com o motivo, e o ciclo não é apurado. É o comportamento correto (melhor não
  medido que medido errado), mas significa que a cobertura depende do RPC ter histórico.
- **Nada disto autoriza entrada real.** O S11 corrige a CONTABILIDADE do que for executado; a
  política de habilitação não mudou (`HFT_REAL_ENTRY_ENABLED=0`).

### 7. Dois refinamentos no mesmo ciclo (mesma classe de problema)

Revisando o resto do caminho por números apresentados como medidos sem sê-lo:

1. **`feesSol` do trade somava só a venda.** Agora é a soma das base fees das DUAS pernas
   (`ciclo.feesSol`) — o custo de rede do ciclo, não o de uma transação.
2. **`measuredCosts` do relatório não dizia o que cobria.** Passou a trazer uma `note` explícita:
   tip (Jito) e priority fee **não são decomponíveis** do delta de saldo (aparecem como
   transferência/instrução, não como `meta.fee`). O PnL está correto — o delta os inclui — mas a
   soma de `feesSol` cobre apenas base fee, e o tip só é visível para a SAÍDA. Sem essa ressalva,
   "custo medido" seria lido como "custo total" e o break-even pareceria menor do que é.

Varredura do resto da mesma classe: `replay.ts` produz simulação e alimenta `computeStrategyMetrics`
diretamente — não grava `measuredOnChain` e não entra em `/api/performance`; o registro de entrada do
S6 não tem `pnlNetSol` (vira `entry_leg`); `realEntry.fillMeasured` mede o FILL da entrada (tokens
recebidos), que é outra afirmação, legítima e documentada. Nenhum outro ponto promove número parcial
a medido. Evidência: `lint` 0 · **274/274** · `build` ok.


---

## Adendo 20 — S12: saída fail-closed e teto de perda (o que é garantível)

**Origem:** pedido de "configurar para só ganhar, nunca perder". Não existe configuração que faça
isso — e prometer o contrário seria o defeito mais grave de todos. O que existe é limitar a perda e
proibir resultado fabricado. Este adendo registra a auditoria do *checklist* de terceiros que
apontou a classe de defeito correta (mesmo vindo de outro código), os dois pontos que estavam
**abertos aqui** e a correção.

### 1. Defeitos encontrados NESTE código (herança do scaffold `b6df555`)

| # | Defeito | Onde (antes) | Consequência real |
|---|---|---|---|
| 1 | **Quantidade de venda ESTIMADA** quando a leitura de saldo falhava ou voltava zero: `qtyFloat = sizeSol / entryPrice` + `Math.floor(...)` e SEGUIA para cotar/assinar | `server.ts` (fechamento manual e saída autônoma) — idêntico em `b6df555` | ordem montada sobre número inventado; se o saldo real fosse 0, a "venda" era de um ativo inexistente |
| 2 | **Posição fechada/apagada sem prova de resíduo** | `server.ts` (`pos.status="closed"` + `deletePosition`) | resíduo de token virava exposição sem stop, sem alvo e sem registro (invisível ao radar) |
| 3 | **Posição sem `mode` gerenciada como REAL** (`p.mode !== "paper"`) | `server.ts` (loop de gestão, `collectRealEntryState`) | herança de scaffold entrava no caminho que assina e consumia o canário |
| 4 | **`MAX_DAILY_LOSS_SOL` e `MAX_OPEN_POSITIONS` eram config MORTA** | `.env.example` × código (0 ocorrências) | o operador acreditava estar limitado sem estar — pior do que não ter o campo |

### 2. Correção (S12, `src/exitSafety.ts` + `server.ts`)

1. `readMintBalanceFailClosed`: retry com backoff; **zero contas é FATO**, falha total é "não
   consegui ver" (`ok:false`) — nunca convertido em zero.
2. `decideExitFromBalance`: sem prova ⇒ `EXIT_ABORTED_BALANCE_UNREADABLE` / `..._ZERO_ONCHAIN_BALANCE`
   e a saída ABORTA antes de assinar, com a intenção encerrada como `failed` (sem travar a próxima).
   O aborto é registrado como estado a reconciliar, **não** como falha de execução: no scaffold,
   3 abortos derrubavam o circuit breaker e o kill switch parava o bot inteiro.
3. `decideCloseFromResidual`: `closed` + `deletePosition` só com resíduo ≤ tolerância declarada.
4. `classifyManagedPosition`: `paper` | `live` (com evidência) | `unverified`; `unverified` não
   assina, não é apagada e **continua contando para exposição**.
5. Livro de perda diária: soma **apenas** `round_trip_legs*` com data legível (`closedAtIso` gravado
   agora); ganho não abate perda; medido sem data é declarado e **fica fora** da soma; ao atingir
   `MAX_DAILY_LOSS_SOL` ⇒ kill switch + entradas bloqueadas, saídas liberadas.
6. `MAX_OPEN_POSITIONS` passa a ser lido no caminho de entrada real.
7. `/api/system-truth` → `exitSafety`: `limits` (declarado × `null`), `dailyLoss`, classificação e
   `notGuaranteed`.

### 3. Verificação

`npm run lint` 0 · `npm run test` **284/284** (grupo `[31]`, 10 testes novos) · `npm run build` ok.
O teste de fonte falha se a estimativa voltar (`rawAmount = Math.floor(qtyFloat`, `Using local
calculation`) ou se um dos quatro pontos de verificação desaparecer.

### 4. Limitações declaradas

- **Nada aqui foi exercitado com dinheiro real.** Os caminhos LIVE exigem as três declarações do S6.
- Perda medida sem data legível **não entra** no teto: o limite diário é um **piso verificado**, não
  prova de que nada mais foi perdido (a `note` do estado diz isso).
- Tip/priority fee continuam embutidos no ΔSOL e não decomponíveis (Adendo 19).
- **Lucro não é garantido por configuração nenhuma.** O invariante é: nada é construído sobre
  número adivinhado, nada é apagado sem prova e nenhum resultado é fabricado.


---

## Adendo 21 — S13: entrega da transação (corrida + fallback por RPC)

**Origem:** autorização da opção "envio paralelo" apresentada após o S12. O módulo de corrida
(`src/parallelSend.ts`, S8) já existia e estava fiado **apenas na entrada**.

### 1. O defeito que estava aberto

| # | Defeito | Onde | Consequência |
|---|---|---|---|
| 1 | As DUAS saídas (manual e autônoma) chamavam `jitoSender.submitBundle` e **lançavam erro na recusa** — sem nenhum caminho alternativo | `server.ts` (fechamento manual e `executeAutonomousExit`) | com rate limit do block engine (1 req/s por IP/região no endpoint público) a venda simplesmente não acontecia: **capital preso no token**, preço andando contra, retry de 3 tentativas também preso ao Jito |
| 2 | A entrada, com a corrida desligada (`HFT_PARALLEL_SEND=0`, default), também não tinha alternativa | idem | oportunidade perdida (menos grave que (1), mas mesma causa) |

Também era o **P0-3** do relatório de terceiros ("adicionar fallback imediato para
`sendRawTransaction` tanto no Buy quanto no Exit"), que eu havia classificado como parcialmente
ausente aqui. Estava correto.

### 2. Correção

1. `src/parallelSend.ts`: `resolveRpcFallbackPolicy` (default **LIGADO**, com o motivo declarado)
   e `planSubmission` — decisão PURA de como entregar: `race` | `jito_with_fallback` | `jito_only`,
   com os transportes do plano e a nota do que acontece na recusa.
2. `server.ts`: helper `submitSignedTransaction` — **um único ponto de entrega** para entrada e
   saídas: corrida quando ligada; caso contrário Jito primeiro e, na recusa, `sendRawTransaction`
   com os MESMOS bytes (passando por `assertCanSign(purpose)`).
3. As três chamadas foram migradas (`runRealEntry`, `/api/positions/close`,
   `executeAutonomousExit`); o log de saída agora declara o caminho vencedor (`via`).
4. `/api/system-truth → parallelSend` expõe `plan` e `rpcFallback`.

### 3. Verificação

`npm run lint` 0 · `npm run test` **289/289** (grupo `[32]`, 5 testes novos) · `npm run build` ok.
Teste de fonte falha se: algum dos 3 pontos perder a entrega, a corrida deixar de ser condicionada
à política, o envio direto perder o choke point, ou `jitoRes` (envio solto) voltar ao arquivo.
**Preservados os contratos do S8**: assinatura única ANTES do envio, `aceito ≠ executado`,
`race.note` agregando os motivos.

### 4. Limitações declaradas

- **Nada foi exercitado com dinheiro real** (exige `RUNTIME_MODE=LIVE` + `HFT_REAL_ENTRY_ENABLED=1`).
- O fallback **consome cota de envio** do RPC; em plano gratuito a cota é pequena — por isso ele
  só é pago quando o Jito recusa.
- **Não há caminho com stake na corrida** sem `HFT_STAKED_SENDER_URL` do provedor do operador.
- `skipPreflight: true` no fallback assume simulação prévia (entrada) ou inutilidade do pré-flight
  após confirmação (saída).

---

## Adendo 22 — S14: reconciliação da perna de entrada (fechar o histórico sem inventar vínculo) (2026-10-06)

### 1. Problema observado

O S11 fez o PnL passar a ser do **ciclo** (ΔSOL da entrada + ΔSOL da saída). Mas todo o histórico
anterior — e tudo que o S11 marca como `exit_leg_only` por não ter a compra medida — continua com
`pnlBasis` ausente: o rótulo (S9) não consegue chamá-los de `net_measured`, e a validação
estatística fica sem amostra. O registro pré-S11 é pior do que inútil: `pnlNetSol` guarda o **ΔSOL
da VENDA** (receita), que lido como resultado superestima o ganho em ~100% do tamanho da posição
(defeito do Adendo 19, já corrigido no caminho de escrita — não no número já gravado).

### 2. O que foi feito

1. `src/roundTrip.ts`: `measureLegWith(conn, signature, wallet, mint)` — a medição de perna
   compartilhada com o servidor (uma única definição; o servidor agora delega). `RoundTripBasis`
   ganhou `round_trip_legs_reconciled`.
2. `src/entryLegReconciliation.ts` **(novo, puro)**: `planEntryLegReconciliation` (quem PODE ser
   medido, com o motivo declarado de cada exclusão), `decideEntryLegReconciliation` (fail-closed:
   confere a **releitura** da saída contra o valor registrado, ± `HFT_RECONCILE_TOLERANCE_SOL`) e
   `buildReconciledTrade` (grava o ciclo medido com procedência própria e **preserva** o número
   anterior em `supersededPnlNetSol`).
3. `src/persistence.ts`: `entryLegSignature`, `reconciledAt`, `reconciliationNote`,
   `supersededPnlNetSol` e `leg: "entry" | "exit"` (perna declarada pelo gravador).
4. `src/outcomeLabels.ts`: base reconciliada conta como duas pernas; e o reconhecimento da rota de
   **entrada** real do repositório (`Jupiter → Jito bundle [...]` — formato verificado no gravador,
   sem o qual nenhum registro do histórico seria elegível).
5. `src/exitSafety.ts`: `round_trip_legs_reconciled` entra em `MEASURED_PNL_BASES` (o teto de perda
   diária conta o valor reconciliado como medido).
6. `scripts/reconcile-entry-legs.ts` + `npm run reconcile`: **dry-run por default**, `--apply` para
   gravar, `--json`, `--limit`, `--wallet`. Relê a cadeia (`getTransaction`) e nunca assina, nunca
   envia, nunca lê chave privada. Relatório em `data/reconciliation-<timestamp>.json` (fora do git).
7. `GET /api/reconciliation`: leitura pura do plano (sem rede), com contagens por motivo.

### 3. Invariante central

Medir hoje uma transação do passado é medir a **mesma** transação: o ΔSOL de uma transação
confirmada é imutável. O que **não** é imutável é a afirmação "esta compra é a compra desta venda" —
por isso, em ambiguidade (`AMBIGUOUS_ENTRY`), a reconciliação **recusa**: escolher a candidata "mais
provável" seria inventar o vínculo. O resultado sempre sai rotulado
`pnlBasis: "round_trip_legs_reconciled"` — separável do que foi medido em tempo real — e o número
antigo fica preservado, não apagado.

### 4. Verificação

`npm run lint` 0 · `npm run test` **298/298** (grupo `[33]`, 9 testes novos) · `npm run build` ok.
Os testes de fonte falham se o script ganhar capacidade de assinar/enviar, se houver mais de um
ponto de escrita no banco fora do ramo `--apply`, ou se o dry-run deixar de ser o default.

### 5. Limitações declaradas

- **Nada foi reconciliado com dados reais ainda**: depende de existir histórico no banco do operador
  (o `data/` local está no `.gitignore` e não foi para o repositório).
- Custo: **2 `getTransaction` por registro** — a cota de leitura de plano gratuito é pequena; use
  `--limit` para reconciliar em lotes.
- O script precisa da carteira operacional (`--wallet`, `OPERATIONAL_PUBLIC_KEY` ou o cofre já
  inicializado no processo do servidor) para localizar o saldo DENTRO da transação.
- Reconciliar **não** valida a estratégia: apenas transforma registros existentes em amostra
  legível. Sem ≥100 desfechos `net_measured`, a conclusão estatística continua sendo "não há
  evidência suficiente".

---

## Adendo 23 — B: procedência até a superfície + gate de saída na via autônoma (2026-10-06)

### 1. Item original reavaliado (e por que não foi implementado como estava)

O item pendente dizia `DBSession.label = DBTrade["pnlBasis"]` em `src/persistence.ts`. **Esse tipo
não existe neste repositório**: não há `DBSession` em nenhum arquivo (`grep -rn "DBSession"` → 0
ocorrências). O que existia de verdade era o problema que ele tentava resolver: **o rótulo de
procedência do PnL não chegava à superfície que serve trades ao operador**. Também foi verificado,
e NÃO procede, um defeito suspeitado no espelho Postgres: `mirrorTrade` grava o registro inteiro em
`payload JSONB` e `fetchTrades` lê `payload` — `pnlBasis`, `supersededPnlNetSol`, `entryLegSignature`
sobrevivem ao espelho e à restauração.

### 2. Defeitos REAIS encontrados e corrigidos

1. **`GET /api/snipes` divergia do banco.** Servia `snipedTransactions`: um array em memória semeado
   UMA vez no boot e limitado a 25 entradas por `unshift`/`pop`. Consequência: registro gravado por
   caminho que não passasse por ali (reconciliação do S14, restauração do S10/Postgres) **não
   aparecia**, e o histórico visível ficava truncado em 25. O array foi REMOVIDO (e os 6 pares
   `unshift`/`pop` com ele); a persistência (`saveTrade`) de cada gravador foi mantida — há teste que
   falha se alguma delas sumir.
2. **PnL sem procedência na superfície.** Os registros crus carregavam `pnlNetSol` sem dizer se é
   `net_measured`, de qual perna veio, ou se está fora da validação. `annotateTradeWithOutcome`
   (em `src/outcomeLabels.ts`, puro) anexa `label`/`labelBasis`/`excludedFromValidation`/`labelReason`
   a cada registro servido; `SnipedTransaction` passou a declarar esses campos; e o
   `TransactionLogger` só mostra PnL **quando o rótulo vem junto** (`não medido` no resto) — a
   receita da venda não tem mais por onde ser exibida como lucro.
3. **A via AUTÔNOMA de saída não passava pelo gate.** `assertExitAllowed()` só era chamado no
   fechamento manual; o stop/take-profit/trailing ia direto para a trava de intenção e a assinatura.
   `BLOCK_EXITS_ON_KILL_SWITCH=true` era ignorado exatamente no caminho que decide o prejuízo. Agora
   a chamada fica no topo de `executeAutonomousExit` — **antes** de `exitLocks.add(pos.id)` e de
   `persistIntent(...)`: recusar depois deixaria a posição travada em `exit_pending` à espera de uma
   evidência que nunca viria. Aviso único por posição, com a frase explícita de que a posição
   permanece ABERTA e a exposição continua contando.

### 3. Verificação

`npm run lint` 0 · `npm run test` **302/302** (grupo `[34]`, 4 testes novos) · `npm run build` ok.
Os testes falham se: o array voltar, o endpoint perder a leitura do banco ou o rótulo, alguma
`saveTrade` sumir junto com a remoção, o gate sair de posição (depois da trava/intenção), ou a UI
exibir PnL sem rótulo.

### 4. Limitações declaradas

- O gate usa a MESMA política do caminho manual: se `RUNTIME_MODE` não for LIVE, uma posição real
  herdada tem a saída autônoma recusada (declarada) — comportamento idêntico ao endpoint manual, que
  já era assim. Nada foi exercitado com dinheiro real.
- O painel é o scaffold do projeto: a coluna nova mostra o que o servidor servir, e o resto do
  dashboard continua como declarado em `/api/system-truth` (painéis com RNG).
