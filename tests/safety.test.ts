/**
 * TESTES DE SEGURANÇA E REGRESSÃO — Bot Sniper (auditoria 2026-10-02)
 *
 * Estes testes NÃO são "test theater". Cada um verifica uma propriedade que, se
 * quebrada, faz o sistema perder dinheiro ou mentir no relatório:
 *
 *   1. Nenhuma constante de endereço pode ser fabricada.
 *   2. Discriminadores de programa precisam bater com o IDL oficial.
 *   3. Extração de mint nunca pode inventar um ativo.
 *   4. Contabilidade líquida (não confundir cotação com fill).
 *   5. Tip nunca pode exceder o teto em bps do capital.
 *   6. Trading real é fail-closed (default OFF).
 *   7. Autenticação de endpoints mutantes é fail-closed.
 *   8. Rejeição de sinal NÃO alimenta o circuit breaker.
 *   9. Bundle com blockhash inválido é recusado sem risco de SOL.
 *
 * IMPORTANTE: o teste roda em diretório temporário para NÃO destruir o banco
 * operacional. O antigo test-production.ts apagava hft_operational_db.json como
 * primeira instrução — ou seja, "testar" destruía o histórico de operações.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Diretório isolado antes de qualquer import que toque em disco.
const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "hft-test-"));
process.chdir(sandboxDir);

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    failures.push(`${name}: ${err.message}`);
    console.error(`  ❌ ${name}\n     ${err.message}`);
  }
}

async function main(): Promise<void> {
  console.log("=========================================");
  console.log(" TESTES DE SEGURANÇA — BOT SNIPER SOLANA");
  console.log("=========================================");
  console.log(`Diretório isolado: ${sandboxDir}\n`);

  const cfg = await import("../src/solanaConfig.js");
  const acct = await import("../src/accounting.js");
  const { extractLaunchMint, JitoBundleSender } = await import("../src/realExecution.js");
  const { isValidPubkey, PROGRAMS, JITO_TIP_ACCOUNTS_FALLBACK, DISCRIMINATORS, discriminatorToBytes } = cfg;

  /* ------------------------------------------------------------------ */
  console.log("\n[1] Constantes de protocolo (anti-fabricação)");

  await test("assertConfigIntegrity passa com a configuração atual", () => {
    cfg.assertConfigIntegrity();
  });

  await test("todos os program IDs são endereços base58 válidos de 32 bytes", () => {
    for (const [key, value] of Object.entries(PROGRAMS)) {
      if (key === "SYSTEM_PROGRAM") continue; // endereço zero é válido por definição
      assert.ok(isValidPubkey(value), `${key} não é pubkey válido: ${value}`);
    }
  });

  await test("os 8 tip accounts do Jito são válidos e distintos", () => {
    assert.equal(JITO_TIP_ACCOUNTS_FALLBACK.length, 8);
    const set = new Set(JITO_TIP_ACCOUNTS_FALLBACK);
    assert.equal(set.size, 8, "há tip accounts duplicados");
    for (const acc of JITO_TIP_ACCOUNTS_FALLBACK) {
      assert.ok(isValidPubkey(acc), `tip account inválido: ${acc}`);
    }
  });

  await test("os endereços FABRICADOS removidos na auditoria são rejeitados", () => {
    // Se algum destes voltar ao código, é regressão crítica: SOL enviado para o vazio.
    const fabricated = [
      "Cw8CFBTGowau99vVnKAhZAsfS6D1g6A7B2Xz11G1Zabz",
      "96gYZGLnJYVFihjz7mZge1L97McJ79S9Aabbb3BE",
      "HFqU5x63VTgdaLLwt7Wb97F7tG2S3zD7F64848Z1",
      "ADa6ZsCtf7vD8W9zFda987AsDGaC8aBca8A9Zda",
      "675k1g2EPJ8gS7q9yGP8REukXXhxZ9ReM78D4cifFGL",
    ];
    const configured = [...Object.values(PROGRAMS), ...JITO_TIP_ACCOUNTS_FALLBACK];
    for (const bad of fabricated) {
      assert.ok(!configured.includes(bad), `endereço fabricado presente na config: ${bad}`);
    }

    // LIÇÃO DA AUDITORIA: endereço fabricado por LLM costuma ser base58 ESTRUTURALMENTE
    // VÁLIDO. Ele passa em qualquer validação de formato e só falha quando alguém envia
    // SOL para ele. Validação estrutural NÃO prova autenticidade — é por isso que este
    // projeto exige allowlist com `source`/`verifiedAt` (ver PROGRAMS e
    // JITO_TIP_ACCOUNTS_FALLBACK) em vez de confiar em "parece um endereço".
    assert.ok(
      isValidPubkey("675k1g2EPJ8gS7q9yGP8REukXXhxZ9ReM78D4cifFGL"),
      "documenta que o endereço falso da Raydium passaria em validação de formato"
    );
    // O único controle que funciona é comparação contra o valor oficial verificado.
    assert.notEqual(PROGRAMS.RAYDIUM_AMM_V4, "675k1g2EPJ8gS7q9yGP8REukXXhxZ9ReM78D4cifFGL");
  });

  await test("discriminador de buy do pump.fun bate com o IDL oficial (0x66063d1201daebea)", () => {
    assert.equal(DISCRIMINATORS.PUMP_BUY, 7351630589278743530n);
    assert.equal(discriminatorToBytes(DISCRIMINATORS.PUMP_BUY).toString("hex"), "66063d1201daebea");
    // O valor errado anterior (16927863322537033481) não pode reaparecer.
    assert.notEqual(DISCRIMINATORS.PUMP_BUY, 16927863322537033481n);
  });

  await test("Raydium AMM v4 usa o program ID oficial", () => {
    assert.equal(PROGRAMS.RAYDIUM_AMM_V4, "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
  });

  /* ------------------------------------------------------------------ */
  console.log("\n[2] Extração de mint (nunca inventar ativo)");

  await test("retorna null quando não há evidência suficiente", () => {
    const wk = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    assert.equal(extractLaunchMint("Pump.fun", [wk], null), null);
    assert.equal(extractLaunchMint("Pump.fun", [], { postTokenBalances: [] }), null);
  });

  await test("ignora WSOL e program IDs conhecidos", () => {
    const wsol = "So11111111111111111111111111111111111111112";
    const result = extractLaunchMint("Pump.fun", [wsol, PROGRAMS.PUMP_FUN], {
      postTokenBalances: [{ mint: wsol }],
    });
    assert.equal(result, null);
  });

  await test("prioriza mint com saldo de token na transação", () => {
    const realMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const result = extractLaunchMint("Pump.fun", ["11111111111111111111111111111111", realMint], {
      postTokenBalances: [{ mint: realMint }],
    });
    assert.equal(result, realMint);
  });

  /* ------------------------------------------------------------------ */
  console.log("\n[3] Contabilidade líquida");

  await test("PnL realizado usa delta de saldo e soma custos corretamente", () => {
    const costs = { ...acct.emptyCosts(), jitoTipSol: 0.006, baseFeeSol: 0.00001 };
    // Entrou com 0.1 SOL, saiu com 0.094 SOL => perda líquida de 0.006 SOL.
    const r = acct.realizedFromBalances(1.0, 0.994, 0.1, costs);
    assert.ok(Math.abs(r.pnlNetSol - -0.006) < 1e-9, `pnlNetSol=${r.pnlNetSol}`);
    assert.ok(Math.abs(r.costsSol - 0.00601) < 1e-9);
    assert.ok(r.measuredOnChain);
    assert.ok(Math.abs(r.pnlNetPercent - -6) < 1e-6, `pnlNetPercent=${r.pnlNetPercent}`);
  });

  await test("break-even reflete custos sobre o capital", () => {
    const costs = { ...acct.emptyCosts(), jitoTipSol: 0.006 };
    // 0.006 SOL de custo sobre 0.1 SOL = 6%
    assert.ok(Math.abs(acct.breakEvenPercent(costs, 0.1) - 6) < 1e-9);
  });

  await test("tip é limitado por bps do capital (bug de 300 bps em 0.1 SOL)", () => {
    const clamped = acct.clampTipSol(0.003, 0.1, 50); // 50 bps de 0.1 SOL = 0.0005
    assert.ok(clamped.clamped);
    assert.ok(Math.abs(clamped.tipSol - 0.0005) < 1e-12, `tipSol=${clamped.tipSol}`);
    const notClamped = acct.clampTipSol(0.0001, 0.1, 50);
    assert.equal(notClamped.clamped, false);
  });

  await test("status de preço: fresh / stale / missing (stop-loss não pode congelar)", () => {
    const now = Date.now();
    assert.equal(acct.assessPriceFreshness({ priceSol: 1, source: "x", fetchedAt: now }, 15_000, now), "fresh");
    assert.equal(acct.assessPriceFreshness({ priceSol: 1, source: "x", fetchedAt: now - 60_000 }, 15_000, now), "stale");
    assert.equal(acct.assessPriceFreshness(undefined, 15_000, now), "missing");
    assert.equal(acct.assessPriceFreshness({ priceSol: 0, source: "x", fetchedAt: now }, 15_000, now), "missing");
    assert.equal(acct.riskActionForFreshness("stale"), "escalate");
    assert.equal(acct.riskActionForFreshness("fresh"), "evaluate");
  });

  await test("métricas de estratégia: expectativa, profit factor e drawdown", () => {
    const now = Date.now();
    const records = [
      { pnlNetSol: 0.02, openedAt: now, closedAt: now, failed: false },
      { pnlNetSol: -0.01, openedAt: now, closedAt: now, failed: false },
      { pnlNetSol: 0.03, openedAt: now, closedAt: now, failed: false },
      { pnlNetSol: -0.04, openedAt: now, closedAt: now, failed: true },
    ];
    const m = acct.computeStrategyMetrics(records);
    assert.equal(m.trades, 4);
    assert.equal(m.wins, 2);
    assert.equal(m.losses, 2);
    assert.equal(m.failures, 1);
    assert.equal(m.winRate, 0.5);
    assert.ok(Math.abs(m.expectancySol - 0) < 1e-12);
    assert.ok(Math.abs(m.profitFactor - 1) < 1e-12);
    assert.ok(m.maxDrawdownSol >= 0.04, `drawdown=${m.maxDrawdownSol}`);
  });

  /* ------------------------------------------------------------------ */
  console.log("\n[4] Gates de execução e autenticação (fail-closed)");

  await test("LIVE_TRADING_ENABLED ausente => trading real DESLIGADO", async () => {
    const sec = await import("../src/security.js");
    delete process.env.LIVE_TRADING_ENABLED;
    assert.equal(sec.isLiveTradingEnabled(), false);
    process.env.LIVE_TRADING_ENABLED = "true";
    assert.equal(sec.isLiveTradingEnabled(), true);
    process.env.LIVE_TRADING_ENABLED = "false";
    assert.equal(sec.isLiveTradingEnabled(), false);
    delete process.env.LIVE_TRADING_ENABLED;
  });

  await test("sem ADMIN_TOKEN em produção: POST é NEGADO (fail-closed)", async () => {
    const sec = await import("../src/security.js");
    const prevEnv = process.env.NODE_ENV;
    const prevToken = process.env.ADMIN_TOKEN;
    delete process.env.ADMIN_TOKEN;
    process.env.NODE_ENV = "production";
    const denied = sec.assertMutationAuthorized({ headers: {} });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.status, 503);
    process.env.NODE_ENV = prevEnv;
    if (prevToken) process.env.ADMIN_TOKEN = prevToken;
  });

  await test("com ADMIN_TOKEN: token errado é rejeitado, correto é aceito", async () => {
    const sec = await import("../src/security.js");
    process.env.ADMIN_TOKEN = "token-de-teste-seguro";
    const wrong = sec.assertMutationAuthorized({ headers: { "x-admin-token": "errado" } });
    assert.equal(wrong.ok, false);
    const right = sec.assertMutationAuthorized({ headers: { "x-admin-token": "token-de-teste-seguro" } });
    assert.equal(right.ok, true);
    const bearer = sec.assertMutationAuthorized({ headers: { authorization: "Bearer token-de-teste-seguro" } });
    assert.equal(bearer.ok, true);
    delete process.env.ADMIN_TOKEN;
  });

  await test("rejeição de sinal NÃO incrementa falhas do circuit breaker", async () => {
    const sec = await import("../src/security.js");
    const before = sec.getOperationalSecurityState().consecutiveFailures;
    sec.reportSignalRejected("token com freeze authority ativa");
    sec.reportSignalRejected("liquidez ausente");
    sec.reportSignalRejected("terceiro sinal ruim");
    const after = sec.getOperationalSecurityState().consecutiveFailures;
    assert.equal(after, before, "rejeição de sinal não pode alimentar o breaker de execução");
    // E o kill switch não pode ter disparado por isso.
    assert.equal(sec.getOperationalSecurityState().killSwitchActive, false);
  });

  await test("chave operacional malformada NÃO cai para carteira aleatória", async () => {
    // Regressão: antes, uma OPERATIONAL_PRIVATE_KEY inválida gerava keypair aleatório e o
    // processo seguia — exibindo um endereço diferente do real. Enviar SOL para ele = perda.
    const prev = process.env.OPERATIONAL_PRIVATE_KEY;
    process.env.OPERATIONAL_PRIVATE_KEY = "isto-nao-e-uma-chave-valida";
    const { initializeVault } = await import("../src/security.js");
    await assert.rejects(
      () => initializeVault(),
      (err: any) => /não pôde ser decodificada|nao pode ser decodificada|decodificada/i.test(err.message),
      "initializeVault deveria LANÇAR, não gerar chave aleatória silenciosamente"
    );
    if (prev) process.env.OPERATIONAL_PRIVATE_KEY = prev;
    else delete process.env.OPERATIONAL_PRIVATE_KEY;
  });

  await test("sem chave em produção: recusa iniciar (fail-closed)", async () => {
    const prevKey = process.env.OPERATIONAL_PRIVATE_KEY;
    const prevEnv = process.env.NODE_ENV;
    delete process.env.OPERATIONAL_PRIVATE_KEY;
    process.env.NODE_ENV = "production";
    const sec = await import("../src/security.js");
    await assert.rejects(() => sec.initializeVault(), /ausente em produção|ausente em producao/i);
    process.env.NODE_ENV = prevEnv;
    if (prevKey) process.env.OPERATIONAL_PRIVATE_KEY = prevKey;
  });

  await test("gate de saída: paper bloqueia liquidar on-chain; read-only PERMITE sair", async () => {
    const sec = await import("../src/security.js");
    const prevLive = process.env.LIVE_TRADING_ENABLED;

    delete process.env.LIVE_TRADING_ENABLED;
    const paper = sec.assertExitAllowed();
    assert.equal(paper.ok, false, "em paper mode não há posição on-chain para liquidar");

    // LIVE exige AS DUAS declarações: a flag legada e o modo explícito.
    process.env.LIVE_TRADING_ENABLED = "true";
    process.env.RUNTIME_MODE = "LIVE";
    sec.triggerKillSwitch(false);
    sec.setReadOnlyMode(true);
    const ro = sec.assertExitAllowed();
    assert.equal(ro.ok, true, "read-only deve PERMITIR saída (reduz exposição)");
    if (ro.ok) assert.ok(ro.warnings.length > 0, "a saída em read-only deve avisar");
    sec.setReadOnlyMode(false);

    if (prevLive) process.env.LIVE_TRADING_ENABLED = prevLive;
    else delete process.env.LIVE_TRADING_ENABLED;
    delete process.env.RUNTIME_MODE;
  });

  await test("gate de saída: kill switch bloqueia só se BLOCK_EXITS_ON_KILL_SWITCH=true", async () => {
    const sec = await import("../src/security.js");
    const prevLive = process.env.LIVE_TRADING_ENABLED;
    process.env.LIVE_TRADING_ENABLED = "true";
    process.env.RUNTIME_MODE = "LIVE";
    sec.triggerKillSwitch(true);

    delete process.env.BLOCK_EXITS_ON_KILL_SWITCH;
    const allowExit = sec.assertExitAllowed();
    assert.equal(allowExit.ok, true, "default: poder sair em pânico é o comportamento correto");

    process.env.BLOCK_EXITS_ON_KILL_SWITCH = "true";
    const blockExit = sec.assertExitAllowed();
    assert.equal(blockExit.ok, false, "configuração explícita pode bloquear a saída");

    sec.triggerKillSwitch(false);
    delete process.env.BLOCK_EXITS_ON_KILL_SWITCH;
    if (prevLive) process.env.LIVE_TRADING_ENABLED = prevLive;
    else delete process.env.LIVE_TRADING_ENABLED;
    delete process.env.RUNTIME_MODE;
  });

  await test("keyCustody é declarado honestamente (não é KMS)", async () => {
    const sec = await import("../src/security.js");
    const custody = sec.describeKeyCustody();
    assert.equal(custody.protectedAgainstProcessAccess, false);
    assert.equal(custody.protectedAgainstDiskAccess, false);
    assert.ok(["env-var-in-process", "ephemeral-dev-keypair", "external-kms"].includes(custody.mode));
  });

  /* ------------------------------------------------------------------ */
  console.log("\n[5] Jito: blockhash e tip accounts");

  await test("bundle com blockhash inválido é recusado sem risco de SOL", async () => {
    const { Connection, Keypair } = await import("@solana/web3.js");
    const sender = new JitoBundleSender(new Connection("https://api.mainnet-beta.solana.com"));
    const signer = Keypair.generate();
    // A barreira de modo roda ANTES da checagem de blockhash (é o que impede assinar fora
    // de LIVE). Para testar a segunda camada, esta chamada precisa estar autorizada.
    const prevMode = process.env.RUNTIME_MODE;
    const prevLive = process.env.LIVE_TRADING_ENABLED;
    process.env.RUNTIME_MODE = "LIVE";
    process.env.LIVE_TRADING_ENABLED = "true";
    // Vault armado: sem isso a barreira recusa por cofre ausente (camada anterior), e o
    // teste não chegaria à validação de blockhash que ele existe para verificar.
    const sec = await import("../src/security.js");
    await sec.initializeVault();
    try {
      const res = await sender.submitBundle([], signer, 0.003, "blockhash-falso-123");
      assert.equal(res.success, false);
      assert.equal(res.tipSol, 0, "nenhum tip pode ser associado a um envio recusado");
      assert.match(res.error || "", /[Bb]lockhash/);
    } finally {
      if (prevMode) process.env.RUNTIME_MODE = prevMode; else delete process.env.RUNTIME_MODE;
      if (prevLive) process.env.LIVE_TRADING_ENABLED = prevLive; else delete process.env.LIVE_TRADING_ENABLED;
    }
  });

  await test("tip accounts caem na lista OFICIAL verificada quando offline", async () => {
    const { Connection } = await import("@solana/web3.js");
    const sender = new JitoBundleSender(new Connection("https://api.mainnet-beta.solana.com"));
    const accounts = await sender.getTipAccounts();
    assert.ok(accounts.length > 0);
    for (const acc of accounts) assert.ok(isValidPubkey(acc), `tip account inválido: ${acc}`);
    // Deve conter o conjunto oficial (não os endereços fabricados).
    assert.ok(accounts.includes("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"));
  });

  await test("blockhash cache nunca inventa hash quando o RPC falha", async () => {
    const { RecentBlockhashCache } = await import("../src/realExecution.js");
    const { Connection } = await import("@solana/web3.js");
    const cache = new RecentBlockhashCache(new Connection("https://127.0.0.1:1")); // porta fechada
    const fresh = await cache.getFresh().catch((e: any) => ({ error: e.code || e.name }));
    assert.ok("error" in fresh, "deveria falhar em vez de devolver hash sintético");
    const status = cache.getStatus();
    assert.equal(status.usable, false);
    const cached = cache.get();
    assert.equal(cached.blockhash, "", "cache não pode devolver blockhash fabricado");
  });

  /* ------------------------------------------------------------------ */
  console.log("\n[6] Persistência isolada (sem destruir o banco real)");

  await test("banco de teste é criado no diretório isolado, não no repo", async () => {
    const { dbStore } = await import("../src/persistence.js");
    dbStore.saveTrade({
      id: "t1",
      token: "TEST",
      mint: "So11111111111111111111111111111111111111112",
      amount: "0.1 SOL",
      outAmount: "+0.02 SOL",
      status: "success",
      block: 0,
      tipSol: 0,
      route: "TESTE",
      time: "00:00:00.000",
      latencyMs: 12,
      mode: "paper",
      signature: null,
      measuredOnChain: false,
    });
    const trades = dbStore.getTrades();
    assert.ok(trades.some((t) => t.id === "t1"));
    assert.ok(fs.existsSync(path.join(sandboxDir, "hft_operational_db.json")));
    assert.ok(
      !fs.existsSync(path.join(process.env.HFT_REPO_ROOT || "/nonexistent", "hft_operational_db.json")),
      "o teste não pode escrever no banco do repositório"
    );
  });

  /* ------------------------------------------------------------------ */
  console.log("\n[8] Endpoints de mercado: hosts mortos não podem voltar");

  await test("server.ts não referencia hosts Jupiter/Preço SUNSET", async () => {
    // Os hosts `quote-api.jup.ag/v6` e `api.jup.ag/v6/price` foram descontinuados.
    // Um host morto no caminho de SAÍDA não falha de forma visível: ele falha quando o
    // operador mais precisa vender. Este teste é a catraca contra a regressão.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const source = fs.readFileSync(path.join(repoRoot, "server.ts"), "utf-8");
    // Só CÓDIGO conta: linhas de comentário podem (e devem) citar o host morto para
    // documentar a correção — o que não pode é o host voltar a ser executado.
    const codeOnly = source
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
      })
      .join("\n");
    const forbidden = [
      "quote-api.jup.ag",
      "api.jup.ag/v6",
      "https://api.jup.ag",
      "api.dexscreener.com",
    ];
    for (const host of forbidden) {
      assert.ok(
        !codeOnly.includes(host),
        `server.ts voltou a hardcodar "${host}" — use JupiterIntegration / DEXSCREENER_BASE_URL`
      );
    }
  });

  await test("preço por cotação exige decimais: sem leitura, a fonte é descartada", async () => {
    // Converter outAmount -> preço assumindo decimais fixos erra por potências de 10.
    // O contrato verificável aqui: a conversão usa Math.pow(10, decimals) lido do mint,
    // e desiste quando a leitura falha.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const source = fs.readFileSync(path.join(repoRoot, "server.ts"), "utf-8");
    assert.ok(source.includes("getMintDecimals"), "o preço por cotação deve resolver os decimais do mint");
    assert.ok(
      !/amount=1000000&slippageBps=100/.test(source),
      "não pode existir cotação de preço com 1.000.000 unidades cruas fixas (assume 6 decimais)"
    );
  });

  /* ------------------------------------------------------------------ */
  console.log("\n[7] Medição e replay (telemetria, registro, motor de replay)");

  await test("LatencyTrace ignora marcação fora de ordem (não sobrescreve medição)", async () => {
    const { LatencyTrace } = await import("../src/telemetry.js");
    const trace = new LatencyTrace("evt-ordem");
    trace.mark("assessed");
    const afterFirst = trace.elapsedTo("assessed");
    // Marcação tardia de um estágio ANTERIOR não pode ser aceita nem alterar a primeira.
    trace.mark("enriched");
    assert.equal(trace.elapsedTo("assessed"), afterFirst, "marcação fora de ordem alterou a medição");
    assert.equal(trace.has("enriched"), false, "estágio fora de ordem não pode ser considerado medido");
  });

  await test("snapshot de latência sem eventos é honesto (sem número fabricado)", async () => {
    const { telemetry } = await import("../src/telemetry.js");
    const snap = telemetry.snapshot();
    assert.equal(snap.traces, 0, "nenhum evento foi processado neste processo");
    for (const [stage, hist] of Object.entries(snap.perStageMs)) {
      assert.equal(hist, null, `estágio ${stage} deveria ser null sem amostras`);
    }
    assert.equal(snap.detection.measurable, false, "WSS não fornece timestamp de origem");
    assert.equal(snap.inclusion.estimated, true, "inclusão por slot é estimativa e deve ser declarada");
  });

  await test("recorder deduplica eventId (reentrega de WebSocket não conta duas vezes)", async () => {
    const { EventRecorder } = await import("../src/eventRecorder.js");
    const rec = new EventRecorder({ dir: path.join(sandboxDir, "dedupe") });
    const evt = {
      eventId: "sig-abc:1",
      source: "wss-logs" as const,
      programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      programName: "pump.fun",
      eventType: "initialize2",
      mint: "MintDedupe11111111111111111111111111111111",
      signature: "sig-abc",
      slot: 100,
      enrichmentMs: 12.5,
    };
    assert.equal(rec.recordLaunchEvent(evt), true, "primeiro registro deve gravar");
    assert.equal(rec.recordLaunchEvent(evt), false, "reentrega deve ser ignorada");
    assert.equal(rec.getStats().counts["launch-event"], 1);
  });

  await test("dataset agrupa por mint, conta REJEITADOS e ignora linha corrompida", async () => {
    const fsmod = await import("node:fs");
    const dataDir = path.join(sandboxDir, "ds");
    fsmod.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, "events.jsonl");

    const line = (o: unknown) => JSON.stringify(o);
    const rows = [
      line({ kind: "launch-event", recordedAt: "2026-10-02T10:00:00.000Z", eventId: "e1", source: "wss-logs", programId: "P", programName: "pump.fun", eventType: "buy", mint: "MINT_A", signature: "s1", slot: 1, enrichmentMs: 30 }),
      line({ kind: "assessment", recordedAt: "2026-10-02T10:00:00.100Z", eventId: "e1", mint: "MINT_A", decision: "accepted", rejectionReason: null, score: 80, verdict: "pass", dataComplete: true, missingChecks: [], isRug: false, mintAuthorityDisabled: true, freezeAuthorityDisabled: true, liquidityUsd: 20000, poolSource: "Raydium", entryPriceSol: 0.0001, entryPriceSource: "geyser", estimatedCostsBps: 600 }),
      line({ kind: "price-observation", recordedAt: "2026-10-02T10:00:03.000Z", positionId: "p1", mint: "MINT_A", priceSol: 0.00012, source: "geyser", ageMs: 0, pnlPercent: 20 }),
      line({ kind: "assessment", recordedAt: "2026-10-02T10:00:01.000Z", eventId: "e2", mint: "MINT_B", decision: "rejected", rejectionReason: "score 20 abaixo do limite 50", score: 20, verdict: "reject", dataComplete: false, missingChecks: ["freeze authority"], isRug: false, mintAuthorityDisabled: false, freezeAuthorityDisabled: null, liquidityUsd: 0, poolSource: "Unknown", entryPriceSol: null, entryPriceSource: null, estimatedCostsBps: null }),
      "{ isto não é json válido",
      line({ kind: "position-lifecycle", recordedAt: "2026-10-02T10:00:09.000Z", positionId: "p1", mint: "MINT_A", token: "A", event: "closed", mode: "paper", sizeSol: 0.1, entryPriceSol: 0.0001, exitPriceSol: 0.00012, pnlPercent: 20, reason: "TP shadow", pnlMeasuredOnChain: false }),
    ];
    fsmod.writeFileSync(file, rows.join("\n") + "\n");

    const { loadBacktestDataset } = await import("../src/eventRecorder.js");
    const dataset = loadBacktestDataset(file);
    assert.equal(dataset.corruptedLines, 1, "linha corrompida deve ser contada, não silenciada");
    assert.equal(dataset.stats.assessments, 2);
    assert.equal(dataset.stats.accepted, 1);
    assert.equal(dataset.stats.rejected, 1, "rejeitados precisam entrar no dataset");
    assert.equal(dataset.stats.acceptanceRate, 0.5);
    assert.equal(dataset.episodes.length, 2);
    assert.equal(dataset.stats.mintsWithoutPrices, 1, "MINT_B não tem série de preços");
    const a = dataset.episodes.find((e) => e.mint === "MINT_A")!;
    assert.equal(a.prices.length, 1);
    assert.equal(a.lifecycle.length, 1);
  });

  await test("simulateEpisode: stop tem prioridade sobre alvo na mesma observação", async () => {
    const { simulateEpisode } = await import("../src/replay.js");
    const episode = {
      mint: "MINT_X",
      event: null,
      assessment: null,
      lifecycle: [],
      prices: [
        { kind: "price-observation" as const, recordedAt: "2026-10-02T10:00:00.000Z", positionId: "p", mint: "MINT_X", priceSol: 1, source: "t", ageMs: 0, pnlPercent: 0 },
        // A série é discreta: não sabemos a ordem intra-intervalo. O motor assume o pior caso.
        { kind: "price-observation" as const, recordedAt: "2026-10-02T10:00:03.000Z", positionId: "p", mint: "MINT_X", priceSol: 0.9, source: "t", ageMs: 0, pnlPercent: -10 },
      ],
    };
    const trade = simulateEpisode(episode, {
      name: "ambiguo",
      stopLossPercent: -5,
      takeProfitPercent: 50,
      trailingStopPercent: null,
      maxHoldMs: null,
      costsRoundTripBps: 0,
    });
    assert.ok(trade);
    assert.equal(trade!.exitReason, "stop-loss", "capital primeiro: queda de 10% atinge o stop de -5%");
    assert.equal(trade!.exitPriceSol, 0.9);
  });

  await test("custos reduzem o líquido exatamente em bps/100 pontos percentuais", async () => {
    const { simulateEpisode } = await import("../src/replay.js");
    const mk = (bps: number) => ({
      name: "custo",
      stopLossPercent: null,
      takeProfitPercent: 20,
      trailingStopPercent: null,
      maxHoldMs: null,
      costsRoundTripBps: bps,
    });
    const episode = {
      mint: "MINT_C",
      event: null,
      assessment: null,
      lifecycle: [],
      prices: [
        { kind: "price-observation" as const, recordedAt: "2026-10-02T10:00:00.000Z", positionId: "p", mint: "MINT_C", priceSol: 1, source: "t", ageMs: 0, pnlPercent: 0 },
        { kind: "price-observation" as const, recordedAt: "2026-10-02T10:00:03.000Z", positionId: "p", mint: "MINT_C", priceSol: 1.25, source: "t", ageMs: 0, pnlPercent: 25 },
      ],
    };
    const semCusto = simulateEpisode(episode, mk(0))!;
    const comCusto = simulateEpisode(episode, mk(600))!;
    assert.equal(semCusto.netPnlPercent, semCusto.grossPnlPercent);
    assert.equal(
      Math.round((comCusto.grossPnlPercent - comCusto.netPnlPercent) * 100) / 100,
      6,
      "600 bps de round-trip = 6 pontos percentuais"
    );
  });

  await test("compareStrategies omite ranking com amostra pequena (não ordena ruído)", async () => {
    const { loadBacktestDataset } = await import("../src/eventRecorder.js");
    const { compareStrategies } = await import("../src/replay.js");
    const file = path.join(sandboxDir, "ds", "events.jsonl");
    const dataset = loadBacktestDataset(file);
    const comparison = compareStrategies(dataset);
    const { DEFAULT_STRATEGIES } = await import("../src/replay.js");
    const expected = DEFAULT_STRATEGIES.filter((s) => s.name !== "baseline-hold").length;
    assert.equal(comparison.rows.length, expected, "uma linha por estratégia comparada");
    assert.equal(comparison.ranking.length, 0, "com 1 trade por estratégia não há ranking defensável");
    for (const row of comparison.rows) {
      assert.ok(row.costDragBps >= 0, "custos não podem reduzir o resultado (drag negativo é erro de sinal)");
    }
    assert.ok(
      comparison.notes.some((n) => /ranking|amostra|confian|piso/i.test(n)),
      "a conclusão precisa declarar a limitação de amostra"
    );
    assert.ok(
      comparison.rows.every((r) => r.validStatistically === false),
      "com 1 trade por estratégia, nenhuma linha pode se declarar estatisticamente válida"
    );
  });

  /* ------------------------------------------------------------------ */
  console.log("\n[9] Modo de execução e barreira única de assinatura");

  await test("resolução de modo é fail-closed (flag legada sozinha NUNCA vira LIVE)", async () => {
    const rm = await import("../src/runtimeMode.js");

    const semNada = rm.resolveRuntimeMode({});
    assert.equal(semNada.mode, "PAPER");
    assert.equal(semNada.liveAuthorized, false);

    const soFlag = rm.resolveRuntimeMode({ LIVE_TRADING_ENABLED: "true" });
    assert.notEqual(soFlag.mode, "LIVE", "flag legada sozinha não pode autorizar capital");
    assert.equal(soFlag.liveAuthorized, false);
    assert.ok(soFlag.conflicts.length > 0, "o conflito precisa ser declarado, não silenciado");

    const soModo = rm.resolveRuntimeMode({ RUNTIME_MODE: "LIVE" });
    assert.notEqual(soModo.mode, "LIVE", "RUNTIME_MODE=LIVE sem a flag também é ambíguo");
    assert.equal(soModo.liveAuthorized, false);

    const completo = rm.resolveRuntimeMode({ RUNTIME_MODE: "LIVE", LIVE_TRADING_ENABLED: "true" });
    assert.equal(completo.mode, "LIVE");
    assert.equal(completo.liveAuthorized, true);

    const invalido = rm.resolveRuntimeMode({ RUNTIME_MODE: "producao" });
    assert.equal(invalido.mode, "PAPER", "valor inválido cai para o modo mais conservador");
    assert.ok(invalido.conflicts.some((c) => /não é um modo válido/.test(c)));
  });

  await test("boot de LIVE sem o mínimo obrigatório é FATAL (não sobe pela metade)", async () => {
    const rm = await import("../src/runtimeMode.js");
    const live = rm.resolveRuntimeMode({ RUNTIME_MODE: "LIVE", LIVE_TRADING_ENABLED: "true" });
    const vazio = rm.validateRuntimeConfiguration(live, {});
    assert.ok(vazio.fatal.some((f) => /OPERATIONAL_PRIVATE_KEY/.test(f)));
    assert.ok(vazio.fatal.some((f) => /ADMIN_TOKEN/.test(f)));
    assert.ok(vazio.fatal.some((f) => /RPC_ENDPOINT/.test(f)));

    const completo = rm.validateRuntimeConfiguration(live, {
      OPERATIONAL_PRIVATE_KEY: "x",
      ADMIN_TOKEN: "t",
      RPC_ENDPOINT: "https://mainnet.helius-rpc.com/?api-key=k",
      MAX_POSITION_SOL: "0.05",
    });
    assert.equal(completo.fatal.length, 0, `não deveria haver fatal: ${completo.fatal.join(" | ")}`);

    // Flag de capital ligada sem modo declarado: recusa de boot, não inferência.
    const ambiguo = rm.resolveRuntimeMode({ LIVE_TRADING_ENABLED: "true" });
    const vAmbiguo = rm.validateRuntimeConfiguration(ambiguo, {});
    assert.ok(vAmbiguo.fatal.some((f) => /sem RUNTIME_MODE explícito/.test(f)));
  });

  await test("bind não-loopback com chave real e sem token é FATAL", async () => {
    const rm = await import("../src/runtimeMode.js");
    const paper = rm.resolveRuntimeMode({});
    const expostoComChave = rm.validateRuntimeConfiguration(paper, {
      HFT_BIND_HOST: "0.0.0.0",
      OPERATIONAL_PRIVATE_KEY: "chave-real",
    });
    assert.ok(expostoComChave.fatal.some((f) => /ADMIN_TOKEN/.test(f)), "API exposta + chave real exige token");

    const expostoSemChave = rm.validateRuntimeConfiguration(paper, { HFT_BIND_HOST: "0.0.0.0" });
    assert.equal(expostoSemChave.fatal.length, 0, "dev sem chave pode expor, mas com aviso");
    assert.ok(expostoSemChave.warnings.some((w) => /ADMIN_TOKEN/.test(w)));

    const loopback = rm.validateRuntimeConfiguration(paper, { HFT_BIND_HOST: "127.0.0.1", OPERATIONAL_PRIVATE_KEY: "k" });
    assert.equal(loopback.fatal.length, 0, "loopback com chave real é aceitável sem token");
  });

  await test("barreira de assinatura: fora de LIVE nada assina, nem com a flag ligada", async () => {
    const rm = await import("../src/runtimeMode.js");
    const ctx = { killSwitchActive: false, readOnlyMode: false, vaultArmed: true };

    for (const env of [
      {} as NodeJS.ProcessEnv,
      { LIVE_TRADING_ENABLED: "true" } as NodeJS.ProcessEnv,
      { RUNTIME_MODE: "SIMULATION" } as NodeJS.ProcessEnv,
      { RUNTIME_MODE: "SHADOW", LIVE_TRADING_ENABLED: "true" } as NodeJS.ProcessEnv,
    ]) {
      const res = rm.resolveRuntimeMode(env);
      for (const purpose of ["entry", "exit"] as const) {
        const verdict = rm.evaluateCapitalPermission(res, ctx, purpose);
        assert.equal(verdict.ok, false, `modo ${res.mode} não pode autorizar ${purpose}`);
      }
    }

    const live = rm.resolveRuntimeMode({ RUNTIME_MODE: "LIVE", LIVE_TRADING_ENABLED: "true" });
    assert.equal(rm.evaluateCapitalPermission(live, ctx, "entry").ok, true);
    assert.equal(rm.evaluateCapitalPermission(live, ctx, "exit").ok, true);
  });

  await test("read-only e kill switch bloqueiam ENTRADA mas permitem SAÍDA (assimetria declarada)", async () => {
    const rm = await import("../src/runtimeMode.js");
    const live = rm.resolveRuntimeMode({ RUNTIME_MODE: "LIVE", LIVE_TRADING_ENABLED: "true" });

    const ro = rm.evaluateCapitalPermission(live, { readOnlyMode: true, vaultArmed: true }, "entry");
    assert.equal(ro.ok, false);
    const roExit = rm.evaluateCapitalPermission(live, { readOnlyMode: true, vaultArmed: true }, "exit");
    assert.equal(roExit.ok, true, "read-only não pode prender capital: saída permitida com aviso");
    if (roExit.ok) assert.ok(roExit.warnings.length > 0);

    const ks = rm.evaluateCapitalPermission(live, { killSwitchActive: true, vaultArmed: true }, "entry");
    assert.equal(ks.ok, false);
    delete process.env.BLOCK_EXITS_ON_KILL_SWITCH;
    const ksExit = rm.evaluateCapitalPermission(live, { killSwitchActive: true, vaultArmed: true }, "exit");
    assert.equal(ksExit.ok, true, "default: em pânico, poder sair é o comportamento correto");
    process.env.BLOCK_EXITS_ON_KILL_SWITCH = "true";
    const ksExitBlocked = rm.evaluateCapitalPermission(live, { killSwitchActive: true, vaultArmed: true }, "exit");
    assert.equal(ksExitBlocked.ok, false, "configuração explícita pode bloquear a saída");
    delete process.env.BLOCK_EXITS_ON_KILL_SWITCH;
  });

  await test("o choke point realmente recusa ANTES de tocar no cofre (modo PAPER)", async () => {
    const rm = await import("../src/runtimeMode.js");
    const sec = await import("../src/security.js");
    delete process.env.RUNTIME_MODE;
    delete process.env.LIVE_TRADING_ENABLED;

    // O cofre NÃO está provisionado neste processo de teste. Se a recusa fosse pelo cofre,
    // a mensagem seria "not been provisioned" — o que provaria que a ordem está errada.
    await assert.rejects(
      () => sec.executeWithDecryptedKeypair(async () => "assinado"),
      (err: any) => {
        assert.equal(err.name, "SigningBlockedError", `esperado SigningBlockedError, veio ${err.name}: ${err.message}`);
        assert.ok(/Modo PAPER/.test(err.message), `a mensagem deve citar o modo: ${err.message}`);
        return true;
      }
    );
    assert.equal(rm.getRuntimeMode(), "PAPER");
  });

  await test("JitoBundleSender recusa envio fora de LIVE (sem rede, sem tip)", async () => {
    const { JitoBundleSender } = await import("../src/realExecution.js");
    const { Connection, Keypair, Transaction } = await import("@solana/web3.js");
    delete process.env.RUNTIME_MODE;
    delete process.env.LIVE_TRADING_ENABLED;

    const sender = new JitoBundleSender(new Connection("https://127.0.0.1:1"));
    const resultado = await sender.submitBundle(
      [new Transaction()],
      Keypair.generate(),
      0.001,
      "11111111111111111111111111111111"
    );
    assert.equal(resultado.success, false, "não pode reportar sucesso sem enviar nada");
    assert.ok(/Signer Guard|Modo PAPER/.test(resultado.error || ""), `erro deveria citar a barreira: ${resultado.error}`);
  });

  await test("POST sem token passa apenas quando não há capital real (fail-closed estreito)", async () => {
    const sec = await import("../src/security.js");
    const fakeReq = { headers: {} as Record<string, unknown> };
    const prevToken = process.env.ADMIN_TOKEN;
    const prevKey = process.env.OPERATIONAL_PRIVATE_KEY;
    const prevMode = process.env.RUNTIME_MODE;
    const prevNodeEnv = process.env.NODE_ENV;

    delete process.env.ADMIN_TOKEN;
    delete process.env.RUNTIME_MODE;
    delete process.env.OPERATIONAL_PRIVATE_KEY;
    process.env.NODE_ENV = "development";
    assert.equal(sec.assertMutationAuthorized(fakeReq).ok, true, "dev sem chave: dashboard local continua funcionando");

    process.env.OPERATIONAL_PRIVATE_KEY = "chave-real-em-uso";
    const comChave = sec.assertMutationAuthorized(fakeReq);
    assert.equal(comChave.ok, false, "com chave real, o token passa a ser obrigatório");
    if (!comChave.ok) assert.equal(comChave.status, 503);

    if (prevToken) process.env.ADMIN_TOKEN = prevToken; else delete process.env.ADMIN_TOKEN;
    if (prevKey) process.env.OPERATIONAL_PRIVATE_KEY = prevKey; else delete process.env.OPERATIONAL_PRIVATE_KEY;
    if (prevMode) process.env.RUNTIME_MODE = prevMode; else delete process.env.RUNTIME_MODE;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
  });

  console.log("\n=========================================");
  if (failures.length === 0) {
    console.log(`🏆 ${passed} TESTES PASSARAM`);
    console.log("=========================================");
  } else {
    console.error(`💥 ${failures.length} FALHA(S) de ${passed + failures.length} testes:`);
    for (const f of failures) console.error(`   - ${f}`);
    console.log("=========================================");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Falha fatal na suíte de testes:", err);
  process.exit(1);
});
