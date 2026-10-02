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
