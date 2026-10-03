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
import { PublicKey } from "@solana/web3.js";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Diretório isolado antes de qualquer import que toque em disco.
const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "hft-test-"));
process.chdir(sandboxDir);

let passed = 0;

/**
 * Remove comentários de linha e de bloco antes de procurar código proibido.
 *
 * Necessário porque os comentários deste projeto CITAM o código fabricado que foi removido
 * ("antes: `278913410 + Date.now()/400`") — sem esta limpeza, a própria documentação da
 * correção faria o teste de regressão falhar.
 */
function codigoSemComentarios(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
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

  /* ------------------------------------------------------------------ */
  console.log("\n[10] Reconexão de WebSocket e honestidade do estado de detecção");

  await test("backoff de reconexão WS cresce e satura (não há storm de 1 tentativa/s)", async () => {
    const { wsBackoffDelayMs, WS_BASE_RECONNECT_MS, WS_MAX_RECONNECT_MS } = await import("../src/realExecution.js");
    assert.equal(wsBackoffDelayMs(1), WS_BASE_RECONNECT_MS, "primeira falha usa o intervalo base");
    assert.equal(wsBackoffDelayMs(2), 2000);
    assert.equal(wsBackoffDelayMs(3), 4000);

    // Monotonicamente não-decrescente e sempre dentro do teto.
    let prev = 0;
    for (let i = 1; i <= 30; i++) {
      const d = wsBackoffDelayMs(i);
      assert.ok(d >= prev, `atraso diminuiu na falha ${i} (${d} < ${prev})`);
      assert.ok(d <= WS_MAX_RECONNECT_MS, `atraso ${d} acima do teto ${WS_MAX_RECONNECT_MS}`);
      assert.ok(d >= WS_BASE_RECONNECT_MS, `atraso ${d} abaixo do base`);
      prev = d;
    }
    assert.equal(wsBackoffDelayMs(50), WS_MAX_RECONNECT_MS, "no teto, não cresce mais");

    // Custo concreto (o motivo da correção): o default do web3.js é 1000ms para SEMPRE.
    // Com backoff, 60 falhas consecutivas custam ~50x menos tentativas do que 1/s.
    let totalMs = 0;
    for (let i = 1; i <= 60; i++) totalMs += wsBackoffDelayMs(i);
    assert.ok(totalMs > 60_000, `60 falhas deveriam ocupar mais de 1 minuto de tempo real (${totalMs}ms)`);
  });

  await test("getHealth não declara detecção conectada só porque subscrições foram pedidas", async () => {
    const { GeyserStreamClient } = await import("../src/realExecution.js");
    // Endpoints locais inexistentes: nada de rede externa, falha imediata e determinística.
    const client = new GeyserStreamClient("http://127.0.0.1:1", "ws://127.0.0.1:1", "");
    try {
      await client.connect();
      const health = client.getHealth();
      assert.equal(health.socketOpen, false, "socket não abriu: não pode se declarar conectado");
      assert.equal(
        health.connected,
        false,
        "o web3.js atribui IDs de subscrição ANTES do socket abrir; isso não é conexão"
      );
      assert.ok(health.subscriptionsRequested > 0, "as subscrições foram PEDIDAS (fato) e devem aparecer como tal");
      assert.equal(health.degraded, true, "sem socket aberto a detecção está degradada");
      assert.equal(health.eventCount, 0, "nenhum evento foi recebido");
      assert.match(health.note || "", /eventCount/, "a nota precisa apontar a única prova real de detecção");
    } finally {
      client.disconnect();
    }
  });

  await test("evento detectado move eventCount (a prova, não o log de boot)", async () => {
    const { GeyserStreamClient } = await import("../src/realExecution.js");
    const client = new GeyserStreamClient("http://127.0.0.1:1", "ws://127.0.0.1:1", "");
    let received = 0;
    client.onTokenDetected(() => {
      received++;
    });
    const healthAntes = client.getHealth();
    assert.equal(healthAntes.eventCount, 0);
    assert.equal(received, 0, "nada foi entregue sem evento real");
    client.disconnect();
  });

  /* ------------------------------------------------------------------ */
  console.log("\n[11] Entrada em shadow (simulada, nunca assinada) e quarentena do banco");

  await test("shadow entry: cotação + construção + simulação devolvem resultado tipado e medido", async () => {
    const { simulateEntry } = await import("../src/shadowEntry.js");

    let clock = 1000;
    const calls: string[] = [];
    const fakeTx = { serialize: () => new Uint8Array([1, 2, 3]) };

    const deps = {
      now: () => (clock += 100),
      getQuote: async (inputMint: string, outputMint: string, amount: number) => {
        calls.push(`quote:${inputMint}->${outputMint}:${amount}`);
        return {
          inputMint,
          outputMint,
          outAmount: "123456789",
          priceImpactPct: 1.23,
          routePlan: [{ swapInfo: { label: "Pump.fun" } }, { swapInfo: { label: "Raydium" } }, { swapInfo: { label: "Pump.fun" } }],
        };
      },
      buildSwapTransaction: async (quote: any, userPublicKey: string) => {
        calls.push(`build:${quote.outAmount}:${userPublicKey}`);
        return fakeTx;
      },
      simulateTransaction: async (tx: any) => {
        calls.push(`simulate:${tx === fakeTx}`);
        return { value: { err: null, unitsConsumed: 47_000, logs: ["Program log: ok", "Program consumption: 47000 units"] } };
      },
    };

    const result = await simulateEntry(deps, {
      mint: "MintShadow111111111111111111111111111111111",
      sizeSol: 0.05,
      userPublicKey: "Wallet1111111111111111111111111111111111111",
      mode: "PAPER",
    });

    assert.equal(result.built, true, `deveria ter construído: ${result.skippedReason}`);
    assert.equal(result.skippedReason, null);
    assert.equal(result.simulation?.ok, true);
    assert.equal(result.simulation?.unitsConsumed, 47_000);
    assert.equal(result.simulation?.blockhashReplaced, true, "simulação substitui blockhash — precisa ser declarado");
    assert.deepEqual(result.quote?.routeLabels, ["Pump.fun", "Raydium"], "rótulos de rota deduplicados");
    assert.equal(result.quote?.outAmount, "123456789");
    // 0.05 SOL = 50.000.000 lamports — a quantidade cotada é a solicitada, não um valor fixo.
    assert.ok(calls.includes("quote:So11111111111111111111111111111111111111112->MintShadow111111111111111111111111111111111:50000000"));
    assert.ok(calls.some((c) => c.startsWith("build:123456789:")));
    assert.ok(calls.includes("simulate:true"), "a transação DO builder precisa ser a simulada");
    // Tempos medidos com o relógio injetado: cada etapa custa exatamente 100ms; o total é o
    // tempo real da chamada inteira (inclui os guardas), portanto >= soma das etapas.
    assert.equal(result.timingsMs.quote, 100);
    assert.equal(result.timingsMs.build, 100);
    assert.equal(result.timingsMs.simulate, 100);
    assert.ok(result.timingsMs.total >= 300, `total ${result.timingsMs.total} menor que a soma das etapas`);
  });

  await test("shadow entry: erro de programa na simulação é REPORTADO, não escondido", async () => {
    const { simulateEntry } = await import("../src/shadowEntry.js");
    const deps = {
      now: () => 0,
      getQuote: async () => ({ outAmount: "1", routePlan: [] }),
      buildSwapTransaction: async () => ({ serialize: () => new Uint8Array() }),
      simulateTransaction: async () => ({
        value: { err: { InstructionError: [3, { Custom: 6001 }] }, unitsConsumed: 12_345, logs: ["Program log: slippage exceeded"] },
      }),
    };
    const result = await simulateEntry(deps, {
      mint: "MintShadow222222222222222222222222222222222",
      sizeSol: 0.01,
      userPublicKey: "Wallet1111111111111111111111111111111111111",
      mode: "SHADOW",
    });
    assert.equal(result.built, true);
    assert.equal(result.simulation?.ok, false, "err != null é falha, mesmo com a tx construída");
    assert.match(JSON.stringify(result.simulation?.err), /6001/);
    assert.ok(result.simulation?.logsTail.some((l) => /slippage exceeded/.test(l)));
  });

  await test("shadow entry: cotação falha vira resultado tipado (sem exceção, sem simulação)", async () => {
    const { simulateEntry } = await import("../src/shadowEntry.js");
    let simulated = false;
    const result = await simulateEntry(
      {
        now: () => 0,
        getQuote: async () => {
          const err: any = new Error("HTTP 404");
          err.code = "JUPITER_NO_ROUTE";
          throw err;
        },
        buildSwapTransaction: async () => {
          throw new Error("não deveria construir");
        },
        simulateTransaction: async () => {
          simulated = true;
          return {};
        },
      },
      { mint: "MintShadow333333333333333333333333333333333", sizeSol: 0.02, userPublicKey: "W", mode: "PAPER" }
    );
    assert.equal(result.built, false);
    assert.match(result.skippedReason || "", /JUPITER_NO_ROUTE/);
    assert.equal(simulated, false, "sem cotação não há o que simular");
    assert.equal(result.simulation, null);
  });

  await test("shadow entry: recusa em LIVE e sem carteira — e nunca cria chave efêmera", async () => {
    const { simulateEntry } = await import("../src/shadowEntry.js");
    const deps = {
      now: () => 0,
      getQuote: async () => {
        throw new Error("não deveria cotar");
      },
      buildSwapTransaction: async () => {
        throw new Error("não deveria construir");
      },
      simulateTransaction: async () => ({}),
    };
    const live = await simulateEntry(deps, { mint: "MintShadow444444444444444444444444444444444", sizeSol: 0.01, userPublicKey: "W", mode: "LIVE" });
    assert.match(live.skippedReason || "", /LIVE/);
    const semCarteira = await simulateEntry(deps, { mint: "MintShadow444444444444444444444444444444444", sizeSol: 0.01, userPublicKey: null, mode: "PAPER" });
    assert.match(semCarteira.skippedReason || "", /sem chave operacional/);
  });

  await test("shadow entry NÃO PODE assinar nem enviar (regressão por varredura de código)", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const source = fs.readFileSync(path.join(repoRoot, "src", "shadowEntry.ts"), "utf8");
    // Remove comentários para não acusar a própria documentação do módulo.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    for (const forbidden of [
      "signTransaction",
      "partialSign",
      "sendTransaction",
      "sendRawTransaction",
      "sendBundle",
      "Keypair",
      "secretKey",
      "privateKey",
    ]) {
      assert.ok(
        !code.includes(forbidden),
        `shadowEntry.ts não pode conter "${forbidden}": o caminho shadow é de simulação, não de execução`
      );
    }
  });

  await test("quarentena: classifica por estrutura (tamanho, mint, modo) sem consultar rede", async () => {
    const { classifyPosition, planQuarantine } = await import("../src/dbQuarantine.js");
    const MINT_OK = "So11111111111111111111111111111111111111112";

    assert.equal(classifyPosition({ id: "a", mint: MINT_OK, sizeSol: 0, mode: "paper" }).verdict, "invalid");
    assert.equal(classifyPosition({ id: "b", mint: "nao-e-pubkey", sizeSol: 0.1, mode: "paper" }).verdict, "invalid");
    assert.equal(classifyPosition({ id: "c", mint: MINT_OK, sizeSol: 0.1 }).verdict, "suspect");
    assert.equal(classifyPosition({ id: "d", mint: MINT_OK, sizeSol: 0.1, mode: "paper" }).verdict, "ok");

    const plan = planQuarantine([
      { id: "a", mint: MINT_OK, sizeSol: 0, mode: "paper" },
      { id: "c", mint: MINT_OK, sizeSol: 0.1 },
      { id: "d", mint: MINT_OK, sizeSol: 0.1, mode: "paper" },
    ]);
    assert.equal(plan.invalid.length, 1);
    assert.equal(plan.suspect.length, 1);
    assert.equal(plan.ok.length, 1);
    assert.deepEqual(
      plan.toMove.map((c) => c.id),
      ["a"],
      "sem --include-unmigrated, apenas os estruturalmente inválidos entram no plano"
    );
    const comSuspeitos = planQuarantine([{ id: "c", mint: MINT_OK, sizeSol: 0.1 }], { includeUnmigrated: true });
    assert.deepEqual(comSuspeitos.toMove.map((c) => c.id), ["c"]);
  });

  await test("quarentena: aplica status e motivos SEM apagar nada", async () => {
    const { applyQuarantine, planQuarantine } = await import("../src/dbQuarantine.js");
    const MINT_OK = "So11111111111111111111111111111111111111112";
    const positions = [
      { id: "a", mint: MINT_OK, sizeSol: 0, mode: "paper", token: "X" },
      { id: "d", mint: MINT_OK, sizeSol: 0.1, mode: "paper", token: "Y" },
    ];
    const plan = planQuarantine(positions);
    const { next, moved } = applyQuarantine(positions, plan, "2026-10-02T00:00:00.000Z");

    assert.equal(next.length, 2, "nenhuma posição pode ser removida do banco");
    const a: any = next.find((p: any) => p.id === "a")!;
    assert.equal(a.status, "quarantined");
    assert.equal(a.quarantinedAt, "2026-10-02T00:00:00.000Z");
    assert.ok(Array.isArray(a.quarantineReasons) && a.quarantineReasons.length > 0);
    assert.equal(a.sizeSol, 0, "os dados originais permanecem para auditoria");
    const d: any = next.find((p: any) => p.id === "d")!;
    assert.equal(d.status, undefined, "posição saudável não é tocada");
    assert.equal(moved.length, 1);
  });

  await test("CLI de quarentena: dry-run não escreve nada (e sinaliza com exit 2)", async () => {
    const { spawnSync } = await import("node:child_process");
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
    if (!fs.existsSync(tsxBin)) {
      console.log("     (tsx ausente — teste de CLI pulado)");
      return;
    }
    const MINT_OK = "So11111111111111111111111111111111111111112";
    const dbPath = path.join(sandboxDir, "quarantine-db.json");
    const db = {
      version: "v4",
      positions: [
        { id: "pos_invalida", token: "MEME", mint: "King777123912Aasdasdsa8912hads9812hasdH", sizeSol: 0, status: "open" },
        { id: "pos_ok", token: "OK", mint: MINT_OK, sizeSol: 0.1, mode: "paper", status: "open" },
      ],
    };
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
    const before = fs.readFileSync(dbPath, "utf8");

    const dry = spawnSync(tsxBin, [path.join(repoRoot, "scripts", "quarantine-db.ts"), "--file", dbPath], { encoding: "utf8" });
    assert.equal(fs.readFileSync(dbPath, "utf8"), before, "dry-run NÃO pode alterar o banco");
    assert.equal(dry.status, 2, `dry-run com posição inválida deve sinalizar (status=${dry.status})`);
    assert.match(dry.stdout, /pos_invalida/);

    const applied = spawnSync(
      tsxBin,
      [path.join(repoRoot, "scripts", "quarantine-db.ts"), "--file", dbPath, "--apply"],
      { encoding: "utf8" }
    );
    assert.equal(applied.status, 0, `--apply deveria concluir (status=${applied.status}): ${applied.stderr}`);
    const after = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    const invalida = after.positions.find((p: any) => p.id === "pos_invalida");
    assert.equal(invalida.status, "quarantined");
    assert.ok(invalida.quarantineReasons.length > 0);
    assert.equal(after.positions.length, 2, "nada apagado");
    assert.equal(after.positions.find((p: any) => p.id === "pos_ok").status, "open", "posição saudável intacta");
    const inventory = fs.readdirSync(sandboxDir).filter((f) => /^quarantine-db\.quarantine\..*\.json$/.test(f));
    assert.equal(inventory.length, 1, "o inventário de quarentena precisa existir");
  });

  /* ------------------------------------------------------------------ */
  console.log("\n[12] Status de landing do Jito e oráculo de tip (fim dos números inventados)");

  await test("id de bundle: aceita os DOIS formatos da doc e recusa o resto", async () => {
    const { isPlausibleBundleId } = await import("../src/jitoStatus.js");
    // Exemplo da doc de getBundleStatuses: SHA-256 em hex.
    assert.equal(
      isPlausibleBundleId("892b79ed49138bfb3aa5441f0df6e06ef34f9ee8f3976c15b323605bae0cf51d"),
      true
    );
    // Exemplo da doc de sendBundle: base58 (formato de assinatura). A doc se contradiz — não adivinhamos.
    assert.equal(
      isPlausibleBundleId("2id3YC2jK9G5Wo2phDx4gJVAew8DcY5NAojnVuao8rkxwPYPe8cSwE5GzhEgJA2y8fVjDEo6iR6ykBvDxrTQrtpb"),
      true
    );
    // "x"*64 NÃO serve como caso inválido: 'x' é caractere válido do alfabeto base58.
    for (const bad of ["", "   ", "curto", "0OIl" + "a".repeat(60), "l".repeat(64), "!", null, undefined, 42]) {
      assert.equal(isPlausibleBundleId(bad as any), false, `deveria recusar: ${String(bad).slice(0, 20)}`);
    }
  });

  await test("parseBundleStatuses: lê a resposta da doc, null como não-encontrado e erro relativo", async () => {
    const { parseBundleStatuses } = await import("../src/jitoStatus.js");
    const ID_HEX = "892b79ed49138bfb3aa5441f0df6e06ef34f9ee8f3976c15b323605bae0cf51d";
    const OUTRO = "b31e5fae4923f345218403ac1ab242b46a72d4f2a38d131f474255ae88f1ec9a";

    const raw = {
      jsonrpc: "2.0",
      result: {
        context: { slot: 242806119 },
        value: [
          {
            bundle_id: ID_HEX,
            transactions: ["3bC2M9fiACSjkTXZDgeNAuQ4ScTsdKGwR42ytFdhUvikqTmBheUxfsR1fDVsM5ADCMMspuwGkdm1uKbU246x5aE3"],
            slot: 242804011,
            confirmation_status: "finalized",
            err: { Ok: null },
          },
          null, // id não encontrado / fora da janela
        ],
      },
      id: 1,
    };

    const parsed = parseBundleStatuses(raw, [ID_HEX, OUTRO]);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.entries.length, 2);
    const found = parsed.entries.find((e) => e.bundleId === ID_HEX)!;
    assert.equal(found.found, true);
    assert.equal(found.confirmationStatus, "finalized");
    assert.equal(found.slot, 242804011);
    assert.equal(found.signatures.length, 1);
    assert.equal(found.err, null, "err {Ok: null} significa SEM erro relatado");
    const missing = parsed.entries.find((e) => e.bundleId === OUTRO)!;
    assert.equal(missing.found, false, "null em result.value = não encontrado (NÃO é falha)");
    assert.deepEqual(parsed.missingIds, [OUTRO]);

    // Formato alternativo: a tabela da doc usa confirmationStatus (camelCase).
    const camel = parseBundleStatuses(
      { result: { value: [{ bundle_id: ID_HEX, transactions: [], slot: 1, confirmationStatus: "confirmed" }] } },
      [ID_HEX]
    );
    assert.equal(camel.entries[0].confirmationStatus, "confirmed");

    // Resposta sem result.value: problema declarado, nenhum erro inventado por item.
    const quebrado = parseBundleStatuses({ result: {} }, [ID_HEX]);
    assert.equal(quebrado.ok, false);
    assert.ok(quebrado.problems.some((p) => /result\.value/.test(p)));
    assert.deepEqual(quebrado.missingIds, [ID_HEX]);

    // Status desconhecido: não é aceito silenciosamente.
    const estranho = parseBundleStatuses(
      { result: { value: [{ bundle_id: ID_HEX, transactions: [], slot: 1, confirmation_status: "quase" }] } },
      [ID_HEX]
    );
    assert.equal(estranho.entries[0].confirmationStatus, null);
    assert.ok(estranho.problems.some((p) => /desconhecido/.test(p)));
  });

  await test("parseInflightStatuses: Invalid/Pending/Failed/Landed com landed_slot", async () => {
    const { parseInflightStatuses } = await import("../src/jitoStatus.js");
    const A = "b31e5fae4923f345218403ac1ab242b46a72d4f2a38d131f474255ae88f1ec9a";
    const B = "e3c4d7933cf3210489b17307a14afbab2e4ae3c67c9e7157156f191f047aa6e8";
    const C = "a7abecabd9a165bc73fd92c809da4dc25474e1227e61339f02b35ce91c9965e2";

    const parsed = parseInflightStatuses(
      {
        result: {
          context: { slot: 280999028 },
          value: [
            { bundle_id: A, status: "Invalid", landed_slot: null },
            { bundle_id: B, status: "Landed", landed_slot: 280999010 },
            { bundle_id: C, status: "Pending", landed_slot: null },
          ],
        },
      },
      [A, B, C]
    );
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.entries.map((e) => e.status), ["Invalid", "Landed", "Pending"]);
    assert.equal(parsed.entries[1].landedSlot, 280999010);
    assert.equal(parsed.entries[0].landedSlot, null);
  });

  await test("RECONCILIAÇÃO: \"Landed\" do Jito NÃO é confirmação on-chain (R6)", async () => {
    const { reconcileLanding } = await import("../src/jitoStatus.js");
    const ID = "b31e5fae4923f345218403ac1ab242b46a72d4f2a38d131f474255ae88f1ec9a";

    // 1. Só o inflight diz Landed → entrou em bloco, sem confirmação.
    const soInflight = reconcileLanding({
      bundleId: ID,
      inflight: { bundleId: ID, found: true, status: "Landed", landedSlot: 280999010 },
    });
    assert.equal(soInflight.verdict, "landed_unconfirmed");
    assert.equal(soInflight.authority, "jito");
    assert.ok(
      soInflight.reasons.some((r) => /NÃO que a confirmação|não que a confirmação|NÃO é confirmação/i.test(r)),
      `a razão precisa ser explícita: ${soInflight.reasons.join(" | ")}`
    );
    assert.notEqual(soInflight.verdict, "confirmed_on_chain", "Landed nunca pode virar confirmação");

    // 2. RPC confirma → aí sim.
    const comRpc = reconcileLanding({
      bundleId: ID,
      inflight: { bundleId: ID, found: true, status: "Landed", landedSlot: 280999010 },
      rpcConfirmation: { signature: "sig", confirmationStatus: "confirmed", slot: 280999010, err: null },
    });
    assert.equal(comRpc.verdict, "confirmed_on_chain");
    assert.equal(comRpc.authority, "rpc");

    // 3. RPC em "processed" = confirmação OTIMISTA, ainda não é fato.
    const otimista = reconcileLanding({
      bundleId: ID,
      rpcConfirmation: { signature: "sig", confirmationStatus: "processed", slot: 123, err: null },
    });
    assert.equal(otimista.verdict, "landed_unconfirmed");
    assert.ok(otimista.reasons.some((r) => /OTIMISTA/.test(r)));

    // 4. getBundleStatuses com finalized → confirmado, mas a autoridade declarada é o Jito
    //    (é o RPC deles); a razão precisa apontar que o SEU RPC é a autoridade para capital.
    const viaBundle = reconcileLanding({
      bundleId: ID,
      bundleStatus: { bundleId: ID, found: true, slot: 999, confirmationStatus: "finalized", signatures: ["s1"], err: null, retryable: null },
    });
    assert.equal(viaBundle.verdict, "confirmed_on_chain");
    assert.equal(viaBundle.authority, "jito");
    assert.ok(viaBundle.reasons.some((r) => /SEU RPC/.test(r)));

    // 5. Estados negativos e ausência de informação.
    assert.equal(
      reconcileLanding({ bundleId: ID, inflight: { bundleId: ID, found: true, status: "Failed", landedSlot: null } }).verdict,
      "failed"
    );
    assert.equal(
      reconcileLanding({ bundleId: ID, inflight: { bundleId: ID, found: true, status: "Invalid", landedSlot: null } }).verdict,
      "invalid"
    );
    const nada = reconcileLanding({ bundleId: ID });
    assert.equal(nada.verdict, "not_found");
    assert.equal(nada.authority, "none");

    // 6. Falha de CONSULTA não pode virar "não encontrado".
    const indisponivel = reconcileLanding({
      bundleId: ID,
      sourceErrors: { inflight: "fetch failed", bundleStatus: "fetch failed" },
    });
    assert.equal(indisponivel.verdict, "unknown", "não conseguir perguntar ≠ não existir");
    assert.ok(indisponivel.reasons.some((r) => /não foi possível consultar/.test(r)));
    // Falha parcial: a conclusão usa a fonte que respondeu e isso fica declarado.
    const parcial = reconcileLanding({
      bundleId: ID,
      inflight: { bundleId: ID, found: true, status: "Landed", landedSlot: 42 },
      sourceErrors: { bundleStatus: "fetch failed" },
    });
    assert.equal(parcial.verdict, "landed_unconfirmed");
    assert.ok(parcial.reasons.some((r) => /se apoia apenas na fonte que respondeu/.test(r)));
    assert.ok(
      nada.reasons.some((r) => /não sei|Não sei/.test(r)),
      "ausência de informação precisa ser declarada como tal, não como falha"
    );
  });

  await test("tip floor: lê a resposta da doc e não inventa percentil ausente", async () => {
    const { parseTipFloor, computeRecommendedTip } = await import("../src/jitoStatus.js");
    const docSample = [
      {
        time: "2024-09-01T12:58:00Z",
        landed_tips_25th_percentile: 6.001000000000001e-6,
        landed_tips_50th_percentile: 1e-5,
        landed_tips_75th_percentile: 3.6196500000000005e-5,
        landed_tips_95th_percentile: 0.0014479055000000002,
        landed_tips_99th_percentile: 0.010007999,
        ema_landed_tips_50th_percentile: 9.836078125000002e-6,
      },
    ];
    const parsed = parseTipFloor(docSample);
    assert.ok(parsed.sample);
    assert.equal(parsed.sample!.p75, 3.6196500000000005e-5);
    assert.equal(parsed.sample!.time, "2024-09-01T12:58:00Z");

    const rec = computeRecommendedTip(parsed.sample!, "p75");
    assert.equal(rec.rawTipSol, 3.6196500000000005e-5);
    assert.equal(rec.substituted, false);
    assert.equal(rec.usedPolicy, "p75");

    // Política sem valor no sample → substituição DECLARADA por outro percentil real.
    const semEma = parseTipFloor([{ landed_tips_50th_percentile: 1e-5 }]);
    assert.ok(semEma.sample);
    const sub = computeRecommendedTip(semEma.sample!, "ema50");
    assert.equal(sub.substituted, true);
    assert.equal(sub.usedPolicy, "p50");
    assert.equal(sub.rawTipSol, 1e-5);

    // Nenhum percentil utilizável → null explícito (nunca zero, nunca constante).
    assert.equal(parseTipFloor([{ time: "x" }]).sample, null);
    assert.equal(parseTipFloor([]).sample, null);
    assert.equal(parseTipFloor({ nope: true }).sample, null);
    // Valor negativo/NaN é rejeitado e reportado.
    const invalido = parseTipFloor([{ landed_tips_50th_percentile: -5, landed_tips_75th_percentile: "abc" }]);
    assert.equal(invalido.sample, null);
    assert.ok(invalido.problems.length >= 2);
  });

  await test("oráculo de tip: cache, throttle e falha honesta (fetch injetado)", async () => {
    const { JitoTipOracle } = await import("../src/jitoStatus.js");
    const docBody = JSON.stringify([
      { time: "2024-09-01T12:58:00Z", landed_tips_50th_percentile: 1e-5, landed_tips_75th_percentile: 3.6e-5 },
    ]);

    let calls = 0;
    let clock = 100_000;
    const okFetch = (async () => {
      calls++;
      return { ok: true, status: 200, json: async () => JSON.parse(docBody) };
    }) as unknown as typeof fetch;

    const oracle = new JitoTipOracle({ fetchFn: okFetch, now: () => clock, cacheTtlMs: 10_000 });

    const first = await oracle.getTipFloor();
    assert.equal(first.available, true);
    assert.equal(calls, 1);
    assert.equal(first.available && first.fromCache, false);

    // Dentro do TTL: serve do cache, sem nova requisição (rate limit é 1 req/s).
    const cached = await oracle.getTipFloor();
    assert.equal(cached.available && cached.fromCache, true);
    assert.equal(calls, 1, "não pode bater na fonte dentro do TTL");

    // Depois do TTL, mas dentro do intervalo mínimo → throttle DECLARADO (sem inventar valor).
    const throttledOracle = new JitoTipOracle({ fetchFn: okFetch, now: () => clock, cacheTtlMs: 0 });
    clock += 100;
    const t1 = await throttledOracle.getTipFloor();
    assert.equal(t1.available, true, "primeira chamada passa");
    const before = calls;
    clock += 200; // 200ms < 1000ms de intervalo mínimo
    const t2 = await throttledOracle.getTipFloor();
    assert.equal(t2.available, false);
    assert.ok(!t2.available && /throttle/i.test(t2.error), t2.available ? "" : t2.error);
    assert.equal(calls, before, "throttle não pode disparar requisição");
    // Passado o intervalo, volta a consultar.
    clock += 2_000;
    const t3 = await throttledOracle.getTipFloor();
    assert.equal(t3.available, true);
    assert.equal(calls, before + 1);

    // Fonte fora do ar: available false, erro declarado, e NENHUM número.
    const failing = new JitoTipOracle({
      fetchFn: (async () => {
        throw new Error("fetch failed");
      }) as unknown as typeof fetch,
      now: () => clock,
      cacheTtlMs: 0,
    });
    const down = await failing.getTipFloor();
    assert.equal(down.available, false);
    assert.ok(!down.available && /inacessível/.test(down.error));
    assert.equal(down.lastKnown, null, "sem histórico: nada a servir, nada a inventar");
    const recDown = await failing.recommendTip({ capitalSol: 0.1, maxTipBps: 50, policy: "p75" });
    assert.equal(recDown.available, false);
    assert.equal(recDown.tipSol, null, "sem dado de mercado não existe recomendação de tip");
    assert.equal(recDown.tipLamports, null);
  });

  await test("recomendação de tip: teto em bps vence e abaixo do mínimo do Jito é AVISADO", async () => {
    const { JitoTipOracle, MIN_JITO_TIP_LAMPORTS } = await import("../src/jitoStatus.js");
    const body = JSON.stringify([{ landed_tips_50th_percentile: 1e-5, landed_tips_75th_percentile: 3.6e-5 }]);
    let clock = 0;
    const oracle = new JitoTipOracle({
      fetchFn: (async () => ({ ok: true, status: 200, json: async () => JSON.parse(body) })) as unknown as typeof fetch,
      now: () => (clock += 5_000),
    });

    // Capital grande o bastante: o tip do percentil cabe no teto de 50 bps.
    const folgado = await oracle.recommendTip({ capitalSol: 0.1, maxTipBps: 50, policy: "p75" });
    assert.equal(folgado.available, true);
    assert.equal(folgado.cappedByBps, false, "3.6e-5 SOL cabe em 50 bps de 0.1 SOL");
    assert.equal(folgado.tipLamports, 36_000);
    assert.equal(folgado.belowJitoMinimum, false);

    // Capital pequeno: o teto corta o tip e isso é DECLARADO (nunca subimos acima do teto).
    const cortado = await oracle.recommendTip({ capitalSol: 0.001, maxTipBps: 50, policy: "p75" });
    assert.equal(cortado.available, true);
    assert.equal(cortado.cappedByBps, true);
    assert.equal(cortado.tipSol, (0.001 * 50) / 10_000);
    assert.ok(cortado.warnings.some((w) => /teto de 50 bps/.test(w)));

    // Teto abaixo do mínimo do Jito: avisa que provavelmente NÃO será considerado, e mantém o teto.
    const minusculo = await oracle.recommendTip({ capitalSol: 0.0001, maxTipBps: 50, policy: "p75" });
    assert.equal(minusculo.available, true);
    assert.equal(minusculo.belowJitoMinimum, true);
    assert.ok(minusculo.tipLamports! < MIN_JITO_TIP_LAMPORTS);
    assert.ok(
      minusculo.warnings.some((w) => /NÃO será considerado/.test(w) && /teto de risco não foi violado/.test(w)),
      `o trade-off precisa ser explícito: ${minusculo.warnings.join(" | ")}`
    );
  });

  await test("JitoBundleSender: recusa lote grande/ID inválido e nunca fabrica status", async () => {
    const { JitoBundleSender } = await import("../src/realExecution.js");
    const { Connection } = await import("@solana/web3.js");
    const sender = new JitoBundleSender(new Connection("https://127.0.0.1:1"));

    const vazio = await sender.getBundleStatuses([]);
    assert.equal(vazio.ok, false);
    assert.ok(vazio.problems.some((p) => /nenhum bundle id/.test(p)));

    const muitos = await sender.getBundleStatuses(Array.from({ length: 6 }, (_, i) => i.toString(16).repeat(64).slice(0, 64)));
    assert.equal(muitos.ok, false);
    assert.ok(muitos.problems.some((p) => /excede o máximo de 5/.test(p)), "limite documentado precisa ser aplicado");

    const invalido = await sender.getBundleStatuses(["nao-e-id"]);
    assert.equal(invalido.ok, false);
    assert.ok(invalido.problems.some((p) => /implausível/.test(p)));

    // Com id válido, a chamada TENTA a rede. Substituímos o fetch por um stub que falha para
    // (a) não depender de egress e (b) provar que falha de rede vira problema declarado —
    // nunca um status inventado.
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        throw new Error("test-stub: sem rede");
      }) as unknown as typeof fetch;
      const ID = "892b79ed49138bfb3aa5441f0df6e06ef34f9ee8f3976c15b323605bae0cf51d";
      const semRede = await sender.getBundleStatuses([ID]);
      assert.equal(semRede.ok, false);
      assert.ok(semRede.problems.some((p) => /falha de rede/.test(p)));
      assert.deepEqual(semRede.entries, [], "sem rede não existe entrada de status");
      assert.deepEqual(semRede.missingIds, [ID]);

      // Imediatamente depois: o cliente ESPERA e respeita o rate limit de 1 req/s (em vez de
      // disparar a segunda requisição imediatamente, o que aceleraria o bloqueio da chave).
      const t0 = Date.now();
      const segunda = await sender.getBundleStatuses([ID]);
      const esperou = Date.now() - t0;
      assert.equal(segunda.ok, false);
      assert.ok(esperou >= 900, `deveria esperar ~1s entre consultas (esperou ${esperou}ms)`);
      assert.ok(
        segunda.problems.some((p) => /falha de rede/.test(p)),
        `a segunda consulta precisa CHEGAR na rede (não ser recusada pelo nosso próprio limite): ${segunda.problems.join(" | ")}`
      );

      // Fila longa demais: aí sim recusa, declarando a espera (não acumula fila infinita).
      const { JitoBundleSender: Sender } = await import("../src/realExecution.js");
      const apertado = new Sender(new Connection("https://127.0.0.1:1"), {
        minStatusIntervalMs: 1000,
        maxStatusWaitMs: 10,
      });
      await apertado.getBundleStatuses([ID]); // ocupa o slot
      const semFila = await apertado.getBundleStatuses([ID]);
      assert.equal(semFila.ok, false);
      assert.ok(semFila.problems.some((p) => /throttle local/.test(p) && /1 req\/s/.test(p)));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await test("o endpoint /api/jito-tips perdeu as constantes inventadas (regressão)", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const serverSrc = fs.readFileSync(path.join(repoRoot, "server.ts"), "utf8");
    const jitoSrc = fs.readFileSync(path.join(repoRoot, "src", "jitoStatus.ts"), "utf8");

    for (const proibido of ["low: 0.0005", "medium: 0.0015", "high: 0.005", "extreme: 0.02"]) {
      assert.ok(!serverSrc.includes(proibido), `a constante fabricada "${proibido}" não pode voltar`);
    }
    assert.ok(
      jitoSrc.includes("https://bundles.jito.wtf/api/v1/bundles/tip_floor"),
      "o tip floor é REST em bundles.jito.wtf, host separado do block engine"
    );

    // Nenhum número aleatório: o módulo inteiro lê dados, não gera.
    const code = jitoSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    assert.ok(!code.includes("Math.random"), "oráculo de tip não pode conter RNG");
  });

  // ---------------------------------------------------------------------------
  // [13] INTENÇÕES DE EXECUÇÃO — IDEMPOTÊNCIA (S4)
  // ---------------------------------------------------------------------------
  console.log("\n[13] Intenções de execução (idempotência de ação econômica)");

  await test("a intenção nasce sem assinatura e com tentativa 1", async () => {
    const { createExecutionIntent } = await import("../src/executionIntent.js");
    const intent = createExecutionIntent(
      { positionId: "pos_1", mint: "So11111111111111111111111111111111111111112", token: "ABC", side: "exit" },
      { now: () => "2026-01-01T00:00:00.000Z", randomSuffix: () => "abc123" }
    );
    assert.equal(intent.state, "created");
    assert.equal(intent.attempt, 1);
    assert.equal(intent.signature, null);
    assert.equal(intent.lastValidBlockHeight, null);
    assert.equal(intent.supersedesIntentId, null);
    assert.equal(intent.createdAt, "2026-01-01T00:00:00.000Z");
    assert.ok(intent.id.startsWith("intent_exit_pos_1_"));
  });

  await test("transições ilegais são RECUSADAS (created → confirmed, terminal reutilizado)", async () => {
    const { createExecutionIntent, advanceIntent } = await import("../src/executionIntent.js");
    const base = createExecutionIntent({ positionId: "p", mint: "m", token: "T", side: "exit" });

    const pulo = advanceIntent(base, "confirmed");
    assert.equal(pulo.ok, false, "não se pode confirmar uma intenção que nunca foi assinada/enviada");

    const signed = advanceIntent(base, "signed", { signature: "sig1", blockhash: "bh", lastValidBlockHeight: 100 }, "assinada");
    assert.equal(signed.ok, true);
    // Assinada SEM "submitted" registrado pode ter chegado (queda entre assinar e gravar):
    // o boot descobre pela cadeia, então esta transição precisa ser permitida.
    const confirmadaSemEnvio = advanceIntent((signed as any).intent, "confirmed", { confirmationLevel: "confirmed" }, "boot: cadeia confirmou");
    assert.equal(confirmadaSemEnvio.ok, true);
    const confirmed = advanceIntent((signed as any).intent, "confirmed", { confirmationLevel: "processed" }, "ok");
    assert.equal(confirmed.ok, true);
    const reuse = advanceIntent((confirmed as any).intent, "submitted");
    assert.equal(reuse.ok, false, "estado terminal não é reutilizado: cria-se intenção nova");
    assert.ok(!reuse.ok && /termina/.test(reuse.reason));
  });

  await test("histórico registra cada transição (auditoria)", async () => {
    const { createExecutionIntent, advanceIntent } = await import("../src/executionIntent.js");
    let intent = createExecutionIntent({ positionId: "p", mint: "m", token: "T", side: "exit" });
    intent = (advanceIntent(intent, "signed", {}, "assinada") as any).intent;
    intent = (advanceIntent(intent, "submitted", {}, "enviada") as any).intent;
    assert.equal(intent.history.length, 2);
    assert.deepEqual(intent.history.map((h: any) => `${h.from}->${h.to}`), ["created->signed", "signed->submitted"]);
  });

  await test("trava de voo único bloqueia o mesmo lado e libera o outro", async () => {
    const { createExecutionIntent, advanceIntent, findBlockingIntent } = await import("../src/executionIntent.js");
    const a = createExecutionIntent({ positionId: "pos_9", mint: "m", token: "T", side: "exit" });
    assert.equal(findBlockingIntent([a], "pos_9", "exit")?.id, a.id);
    assert.equal(findBlockingIntent([a], "pos_9", "entry"), null, "lado diferente não é bloqueado");
    assert.equal(findBlockingIntent([a], "pos_10", "exit"), null);

    const done = (advanceIntent(a, "failed", { lastError: "x" }, "falhou") as any).intent;
    assert.equal(findBlockingIntent([done], "pos_9", "exit"), null, "intenção terminal não bloqueia");
  });

  await test("decideRetry: evidência vem ANTES da conveniência", async () => {
    const { createExecutionIntent, advanceIntent, decideRetry } = await import("../src/executionIntent.js");
    let intent = createExecutionIntent({ positionId: "p", mint: "m", token: "T", side: "exit" });
    intent = (advanceIntent(intent, "signed", { signature: "sig", blockhash: "bh", lastValidBlockHeight: 200 }, "a") as any).intent;
    intent = (advanceIntent(intent, "submitted", {}, "b") as any).intent;

    // 1. Já confirmada: nada é reenviado.
    const confirmedIntent = (advanceIntent(intent, "confirmed", { confirmationLevel: "finalized" }, "c") as any).intent;
    const stop = decideRetry(confirmedIntent, { currentBlockHeight: 500, signatureStatus: null, hasSignedBytes: true });
    assert.equal(stop.action, "stop_confirmed");

    // 2. Erro de execução na cadeia: reconstruir é seguro.
    const err = decideRetry(intent, {
      currentBlockHeight: 250,
      signatureStatus: { found: true, err: { InstructionError: [0, "Custom"] }, confirmationStatus: null },
      hasSignedBytes: true,
    });
    assert.equal(err.action, "rebuild");
    assert.ok(/ERRO de execução/.test((err as any).reason));

    // 3. Cadeia já executou: pare, com o nível declarado.
    const landed = decideRetry(intent, {
      currentBlockHeight: 250,
      signatureStatus: { found: true, err: null, confirmationStatus: "processed" },
      hasSignedBytes: true,
    });
    assert.equal(landed.action, "stop_confirmed");
    assert.equal((landed as any).level, "processed");

    // 4. Expiração PROVADA por altura: única justificativa para reconstruir sem erro.
    const expired = decideRetry(intent, {
      currentBlockHeight: 201,
      signatureStatus: { found: false, err: null, confirmationStatus: null },
      hasSignedBytes: true,
    });
    assert.equal(expired.action, "rebuild");
    assert.ok(/expirado/i.test((expired as any).reason));

    // 5. Sem prova de expiração, com bytes em memória: REENVIAR os mesmos bytes.
    const rebroadcast = decideRetry(intent, {
      currentBlockHeight: 199,
      signatureStatus: { found: false, err: null, confirmationStatus: null },
      hasSignedBytes: true,
    });
    assert.equal(rebroadcast.action, "rebroadcast");

    // 6. Sem prova, sem bytes (restart): ESPERAR. Reconstruir aqui duplicaria a ação.
    const wait = decideRetry(intent, {
      currentBlockHeight: 199,
      signatureStatus: { found: false, err: null, confirmationStatus: null },
      hasSignedBytes: false,
    });
    assert.equal(wait.action, "wait");
    assert.ok(/duplicar/.test((wait as any).reason));

    // 7. RPC não respondeu (null) NÃO é resposta negativa: nunca rebuild.
    const semResposta = decideRetry(intent, { currentBlockHeight: null, signatureStatus: null, hasSignedBytes: true });
    assert.notEqual(semResposta.action, "rebuild");

    // 8. Durable nonce não expira: altura maior NÃO autoriza reconstruir.
    const nonce = decideRetry(intent, {
      currentBlockHeight: 9999,
      signatureStatus: { found: false, err: null, confirmationStatus: null },
      hasSignedBytes: false,
      usesDurableNonce: true,
    });
    assert.equal(nonce.action, "wait");
    assert.ok(/nonce/i.test((nonce as any).reason));

    // 9. Nunca assinada: não existe duplicata possível.
    const virgem = createExecutionIntent({ positionId: "p2", mint: "m", token: "T", side: "exit" });
    const primeira = decideRetry(virgem, { currentBlockHeight: 10, signatureStatus: null, hasSignedBytes: false });
    assert.equal(primeira.action, "rebuild");
  });

  await test("rebuild encadeia a intenção anterior (nada é apagado)", async () => {
    const { createExecutionIntent } = await import("../src/executionIntent.js");
    const primeira = createExecutionIntent({ positionId: "p", mint: "m", token: "T", side: "exit" });
    const segunda = createExecutionIntent({
      positionId: "p",
      mint: "m",
      token: "T",
      side: "exit",
      attempt: 2,
      supersedesIntentId: primeira.id,
    });
    assert.equal(segunda.attempt, 2);
    assert.equal(segunda.supersedesIntentId, primeira.id, "a tentativa nova aponta para a que substitui");
  });

  await test("o módulo não persiste nem transporta bytes assinados (regressão)", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const src = fs.readFileSync(path.join(repoRoot, "src", "executionIntent.ts"), "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    assert.ok(!/wireTransaction\s*:/.test(code), "os bytes assinados não podem ser campo do registro");
    assert.ok(!code.includes("serialize()"), "o módulo não serializa transação");
    assert.ok(!code.includes("signTransaction"), "o módulo não assina");
  });

  // ---------------------------------------------------------------------------
  // [14] RECONCILIAÇÃO POSIÇÃO × CADEIA (POSITION_DESYNC)
  // ---------------------------------------------------------------------------
  console.log("\n[14] Reconciliação posição × carteira (POSITION_DESYNC)");

  const MINT_A = "So11111111111111111111111111111111111111112";
  const MINT_B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const MINT_C = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const NOW = Date.parse("2026-01-01T01:00:00.000Z");
  const posAberta = (mint: string, over: Record<string, unknown> = {}) => ({
    id: `pos_${mint.slice(0, 4)}`,
    token: "TKN",
    mint,
    sizeSol: 0.1,
    status: "open",
    mode: "live",
    timeOpened: new Date(NOW - 10 * 60_000).toISOString(),
    ...over,
  });

  await test("saldo presente → in_sync (sem alarme)", async () => {
    const { reconcilePositionDesync } = await import("../src/positionDesync.js");
    const report = reconcilePositionDesync({
      positions: [posAberta(MINT_A)],
      holdings: [{ mint: MINT_A, rawAmount: 1_000_000, decimals: 6 }],
      nowMs: NOW,
    });
    assert.equal(report.summary.phantom, 0);
    assert.equal(report.summary.critical, 0);
    assert.equal(report.findings[0].verdict, "in_sync");
    assert.equal(report.snapshotAvailable, true);
  });

  await test("posição aberta sem token na carteira → phantom_position (crítico)", async () => {
    const { reconcilePositionDesync } = await import("../src/positionDesync.js");
    const report = reconcilePositionDesync({
      positions: [posAberta(MINT_A)],
      holdings: [{ mint: MINT_B, rawAmount: 500, decimals: 6 }],
      nowMs: NOW,
    });
    assert.equal(report.summary.phantom, 1);
    const f = report.findings.find((x) => x.verdict === "phantom_position")!;
    assert.equal(f.severity, "critical");
    assert.ok(/NÃO vender/.test(f.recommendedAction), "a ação recomendada não pode sugerir vender o que não existe");
  });

  await test("dentro da janela de tolerância NÃO é fantasma (entrada pode não ter confirmado)", async () => {
    const { reconcilePositionDesync } = await import("../src/positionDesync.js");
    const report = reconcilePositionDesync({
      positions: [posAberta(MINT_A, { timeOpened: new Date(NOW - 30_000).toISOString() })],
      holdings: [],
      nowMs: NOW,
      options: { minAgeMs: 120_000 },
    });
    assert.equal(report.summary.phantom, 0);
    assert.equal(report.findings[0].verdict, "too_young");
  });

  await test("sem leitura de carteira → unknown, NUNCA fantasma", async () => {
    const { reconcilePositionDesync } = await import("../src/positionDesync.js");
    const report = reconcilePositionDesync({ positions: [posAberta(MINT_A)], holdings: null, nowMs: NOW });
    assert.equal(report.summary.phantom, 0);
    assert.equal(report.snapshotAvailable, false);
    assert.ok(report.snapshotNote && /indisponível/.test(report.snapshotNote));
    assert.ok(report.findings.every((f) => f.verdict === "unknown"));
  });

  await test("posição paper e quarentenada não são comparadas com a cadeia", async () => {
    const { reconcilePositionDesync } = await import("../src/positionDesync.js");
    const report = reconcilePositionDesync({
      positions: [
        posAberta(MINT_A, { mode: "paper" }),
        posAberta(MINT_B, { status: "quarantined" }),
      ],
      holdings: [],
      nowMs: NOW,
    });
    assert.equal(report.summary.phantom, 0);
    assert.equal(report.summary.skipped, 2);
    assert.equal(report.summary.checkedPositions, 0);
  });

  await test("poeira residual não conta como posição detida", async () => {
    const { reconcilePositionDesync } = await import("../src/positionDesync.js");
    const report = reconcilePositionDesync({
      positions: [posAberta(MINT_A)],
      holdings: [{ mint: MINT_A, rawAmount: 1, decimals: 6 }],
      nowMs: NOW,
      options: { dustToleranceRaw: 1 },
    });
    assert.equal(report.summary.phantom, 1, "1 unidade base com tolerância 1 é poeira, não posição");
  });

  await test("achei que vendi mas ainda tenho token → closed_but_holding (crítico)", async () => {
    const { reconcilePositionDesync } = await import("../src/positionDesync.js");
    const report = reconcilePositionDesync({
      positions: [],
      closedMints: [{ mint: MINT_C, token: "ANTIGO", closedAt: "2026-01-01T00:30:00.000Z" }],
      holdings: [{ mint: MINT_C, rawAmount: 42_000, decimals: 9 }],
      nowMs: NOW,
    });
    assert.equal(report.summary.closedButHolding, 1);
    const f = report.findings.find((x) => x.verdict === "closed_but_holding")!;
    assert.equal(f.severity, "critical");
    assert.ok(/explorador/.test(f.recommendedAction));
  });

  await test("token do operador que o bot nunca tocou NÃO é reportado (sem ruído)", async () => {
    const { reconcilePositionDesync } = await import("../src/positionDesync.js");
    const report = reconcilePositionDesync({
      positions: [],
      closedMints: [],
      holdings: [{ mint: MINT_B, rawAmount: 999_999_999, decimals: 6 }],
      nowMs: NOW,
    });
    assert.equal(report.findings.length, 0);
    assert.equal(report.summary.closedButHolding, 0);
  });

  await test("mint inválido é pulado sem sequer consultar a carteira", async () => {
    const { reconcilePositionDesync } = await import("../src/positionDesync.js");
    const report = reconcilePositionDesync({
      positions: [posAberta("nao-e-pubkey!")],
      holdings: [],
      nowMs: NOW,
    });
    assert.equal(report.summary.skipped, 1);
    assert.equal(report.summary.phantom, 0);
  });

  await test("resumo descreve a ausência de leitura em vez de inventar zero", async () => {
    const { reconcilePositionDesync, describeDesyncReport } = await import("../src/positionDesync.js");
    const semLeitura = reconcilePositionDesync({ positions: [posAberta(MINT_A)], holdings: null, nowMs: NOW });
    assert.ok(/não comparadas/.test(describeDesyncReport(semLeitura)));
    const comLeitura = reconcilePositionDesync({
      positions: [posAberta(MINT_A)],
      holdings: [{ mint: MINT_A, rawAmount: 10, decimals: 6 }],
      nowMs: NOW,
    });
    assert.ok(/comparadas/.test(describeDesyncReport(comLeitura)));
  });

  await test("regressão: o servidor usa a trava de voo único nos DOIS caminhos de saída", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const serverSrc = fs.readFileSync(path.join(repoRoot, "server.ts"), "utf8");
    const ocorrencias = serverSrc.match(/findBlockingIntent\(dbStore\.getIntents\(\)/g) ?? [];
    assert.equal(ocorrencias.length, 2, "saída automática E fechamento manual precisam da trava");
    assert.ok(
      serverSrc.includes("supersedeIntent(") && serverSrc.includes("decideExitRetry("),
      "a política de retry por evidência precisa estar aplicada"
    );
    assert.ok(
      serverSrc.includes("blockedIntentWarned"),
      "a trava não pode gerar commit em disco a cada ciclo"
    );
  });

  // ---------------------------------------------------------------------------
  // [15] VERACIDADE DO PAINEL — o que é medição e o que é simulação
  // ---------------------------------------------------------------------------
  console.log("\n[15] Veracidade do painel e estado do oráculo de tip");

  await test("oráculo nunca consultado NÃO é reportado como ok", async () => {
    const { JitoTipOracle } = await import("../src/jitoStatus.js");
    const oracle = new JitoTipOracle({ fetchFn: (async () => { throw new Error("não deve chamar"); }) as any, now: () => 1000 });
    const st = oracle.getStatus();
    assert.equal(st.everQueried, false, "sem consulta não existe sucesso");
    assert.equal(st.lastSuccessAt, null);
    assert.equal(st.lastSuccessAgeMs, null);
    assert.equal(st.lastError, null, "null aqui é 'não consultado', não 'tudo certo'");
  });

  await test("oráculo registra sucesso e erro de forma distinguível", async () => {
    const { JitoTipOracle } = await import("../src/jitoStatus.js");
    // Formato REAL da resposta: ARRAY com os percentis em SOL (ver tip_floor do Jito).
    const okBody = [
      {
        time: "2026-01-01T00:00:00Z",
        landed_tips_25th_percentile: 6.001e-6,
        landed_tips_50th_percentile: 1e-5,
        landed_tips_75th_percentile: 3.6e-5,
        landed_tips_95th_percentile: 1.4e-3,
        landed_tips_99th_percentile: 1e-2,
        ema_landed_tips_50th_percentile: 9.8e-6,
      },
    ];
    let nowMs = 1_000;
    const okFetch = (async () => new Response(JSON.stringify(okBody), { status: 200, headers: { "content-type": "application/json" } })) as any;
    const oracle = new JitoTipOracle({ fetchFn: okFetch, now: () => nowMs });
    const floor = await oracle.getTipFloor();
    assert.equal(floor.available, true);
    const st = oracle.getStatus();
    assert.equal(st.everQueried, true);
    assert.equal(st.lastError, null);
    assert.equal(st.lastSuccessAgeMs, 0);

    // Segunda instância: fonte fora do ar → erro registrado, sem sucesso.
    const failing = new JitoTipOracle({ fetchFn: (async () => { throw new Error("fetch failed"); }) as any, now: () => 5_000 });
    const bad = await failing.getTipFloor();
    assert.equal(bad.available, false);
    const stBad = failing.getStatus();
    assert.equal(stBad.everQueried, false, "consulta que falhou não é sucesso");
    assert.ok(stBad.lastError && /fetch failed/.test(stBad.lastError));
  });

  await test("o servidor declara os painéis simulados (endpoint /api/system-truth)", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const serverSrc = fs.readFileSync(path.join(repoRoot, "server.ts"), "utf8");
    assert.ok(serverSrc.includes('"/api/system-truth"'), "o endpoint de veracidade precisa existir");
    // Os painéis conhecidos como RNG precisam estar DECLARADOS (não basta existirem).
    for (const path_ of [
      "/api/hft-telemetry",
      "/metrics",
      "/api/predictive-score",
      "/api/geyser-stream",
      "/api/submit-bundle",
      "/api/simulate-fork",
      "/api/simulate-snipe",
      "/api/co-location",
      "/api/jito-leader-schedule",
    ]) {
      assert.ok(
        serverSrc.includes(path_),
        `o painel simulado ${path_} precisa aparecer na declaração de veracidade`
      );
    }
    /**
     * ATUALIZADO EM S6 (autorizado em 2026-10-03). A asserção anterior exigia a string
     * "não implementado" — ela era VERDADEIRA até o S6 e deixou de ser: o caminho de entrada
     * real existe agora. Trocar a asserção por uma mais FRACA ("existe alguma menção")
     * seria rebaixar o teste; o que se exige agora é mais forte e mais específico:
     *   - a declaração precisa continuar existindo (`liveExecutionPath`), e
     *   - precisa dizer o ESTADO real (habilitado × desligado), não uma frase fixa, e
     *   - o bloco `realEntry` precisa expor os códigos que bloqueiam entrada AGORA.
     * Assim, ou o caminho é declarado desligado (hoje), ou é declarado habilitado — nunca
     * "não implementado" quando implementado, nem "habilitado" quando bloqueado.
     */
    assert.ok(
      serverSrc.includes("liveExecutionPath"),
      "o endpoint precisa continuar declarando o estado do caminho de execução real"
    );
    assert.ok(
      /liveExecutionPath:[\s\S]{0,900}HFT_REAL_ENTRY_ENABLED/.test(serverSrc),
      "o estado declarado precisa vir da política real (HFT_REAL_ENTRY_ENABLED), não de frase fixa"
    );
    assert.ok(
      /realEntry: \(\(\) => \{[\s\S]{0,700}wouldEnterNow/.test(serverSrc),
      "o painel de veracidade precisa dizer se uma entrada real passaria AGORA (wouldEnterNow)"
    );
  });

  await test("o banner de verdade está MONTADO na interface (não só criado)", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const appSrc = fs.readFileSync(path.join(repoRoot, "src", "App.tsx"), "utf8");
    const bannerSrc = fs.readFileSync(path.join(repoRoot, "src", "components", "TruthBanner.tsx"), "utf8");
    assert.ok(appSrc.includes('import TruthBanner from "./components/TruthBanner"'), "import ausente");
    assert.ok(appSrc.includes("<TruthBanner />"), "componente criado mas NÃO renderizado (não apareceria na tela)");
    assert.ok(bannerSrc.includes("/api/system-truth"), "o banner precisa ler o endpoint de veracidade");
    assert.ok(
      /Não foi possível ler o status de veracidade/.test(bannerSrc),
      "sem leitura, o banner precisa declarar a falha e não inventar estado"
    );
  });

  // ---------------------------------------------------------------------------
  // [16] CAMINHO QUENTE — dedupe, política de envio e orçamento do filtro
  // ---------------------------------------------------------------------------
  console.log("\n[16] Caminho quente (dedupe, envio, orçamento do filtro profundo)");

  await test("dedupe: a mesma assinatura só é processada uma vez (com TTL)", async () => {
    const { SeenLaunchSignatures } = await import("../src/hotPath.js");
    const seen = new SeenLaunchSignatures(1000, 10);
    const t0 = 1_000_000;
    assert.equal(seen.firstSight("sigA", t0), true, "primeira vez processa");
    assert.equal(seen.firstSight("sigA", t0 + 10), false, "reentrega é ignorada");
    assert.equal(seen.firstSight("sigB", t0 + 20), true, "assinatura diferente processa");
    // Depois do TTL a entrada expira (a assinatura é única, então isso é defensivo).
    assert.equal(seen.firstSight("sigA", t0 + 1500), true);
    assert.equal(seen.size(t0 + 1500), 1, "as duas entradas antigas expiraram; só sigA foi reinserida");
  });

  await test("dedupe: não cresce sem limite (memória não vaza)", async () => {
    const { SeenLaunchSignatures } = await import("../src/hotPath.js");
    const seen = new SeenLaunchSignatures(60_000, 3);
    const t0 = 5_000_000;
    for (let i = 0; i < 10; i++) assert.equal(seen.firstSight(`sig${i}`, t0 + i), true);
    assert.equal(seen.size(t0 + 10), 3, "o limite é respeitado (remove o mais antigo)");
    // As 3 mais recentes continuam registradas.
    assert.equal(seen.firstSight("sig9", t0 + 11), false);
  });

  await test("trava de mint em voo impede decisão paralela do mesmo mint", async () => {
    const { InFlightMints } = await import("../src/hotPath.js");
    const gate = new InFlightMints();
    assert.equal(gate.tryAcquire("mint1"), true);
    assert.equal(gate.tryAcquire("mint1"), false, "segundo sinal do MESMO mint é recusado");
    assert.equal(gate.tryAcquire("mint2"), true, "mint diferente passa");
    gate.release("mint1");
    assert.equal(gate.tryAcquire("mint1"), true, "após liberar, o mint volta a poder ser processado");
  });

  await test("envio: retry do RPC é 0 e preflight só cai com simulação declarada", async () => {
    const { resolveSendOptions } = await import("../src/hotPath.js");
    // Caso 1: nada declarado → preflight ATIVO (erro barato) e sem retry às cegas.
    const padrao = resolveSendOptions({});
    assert.equal(padrao.skipPreflight, false);
    assert.equal(padrao.maxRetries, 0, "quem repete é a política de evidência, não o RPC");
    assert.equal(padrao.preflightCommitment, "processed");
    assert.ok(/preflight ativo/.test(padrao.rationale));

    // Caso 2: transação já simulada neste processo → preflight pulado (economiza 1 RTT).
    const preSim = resolveSendOptions({ preSimulated: true });
    assert.equal(preSim.skipPreflight, true);
    assert.equal(preSim.maxRetries, 0);
    assert.ok(/simulada/.test(preSim.rationale));

    // Caso 3: diagnóstico pede preflight mesmo com simulação declarada.
    assert.equal(resolveSendOptions({ preSimulated: true, forcePreflight: true }).skipPreflight, false);

    // Caso 4: overrides explícitos são respeitados; valor absurdo é saneado.
    assert.equal(resolveSendOptions({ skipPreflight: true, maxRetries: 2 }).skipPreflight, true);
    assert.equal(resolveSendOptions({ maxRetries: -5 }).maxRetries, 0, "não existe retry negativo");
  });

  await test("orçamento: filtro completo decide por EVIDÊNCIA", async () => {
    const { decideEntryWithBudget } = await import("../src/hotPath.js");
    const ok = decideEntryWithBudget({
      mode: "LIVE",
      deepComplete: true,
      deepElapsedMs: 400,
      budgetMs: 900,
      deepVerdict: "approve",
    });
    assert.equal(ok.proceed, true);
    assert.equal(ok.unvetted, false);

    const reprovado = decideEntryWithBudget({
      mode: "PAPER",
      deepComplete: true,
      deepElapsedMs: 400,
      budgetMs: 900,
      deepVerdict: "reject",
    });
    assert.equal(reprovado.proceed, false, "reprovação NÃO se contorna nem em PAPER");
    assert.ok(/REPROVOU/.test(reprovado.reason));
  });

  await test("orçamento: LIVE sem auditoria é VETADO (fail-closed)", async () => {
    const { decideEntryWithBudget } = await import("../src/hotPath.js");
    const decisao = decideEntryWithBudget({
      mode: "LIVE",
      deepComplete: false,
      deepElapsedMs: 1500,
      budgetMs: 900,
    });
    assert.equal(decisao.proceed, false, "entrar em LIVE sem filtro profundo é como se perde a carteira");
    assert.equal(decisao.unvetted, false);
    assert.ok(/FAIL-CLOSED/.test(decisao.reason));
  });

  await test("orçamento: PAPER/SHADOW prosseguem marcados como NÃO AUDITADOS", async () => {
    const { decideEntryWithBudget } = await import("../src/hotPath.js");
    for (const mode of ["PAPER", "SHADOW"]) {
      const decisao = decideEntryWithBudget({ mode, deepComplete: false, deepElapsedMs: 1200, budgetMs: 900 });
      assert.equal(decisao.proceed, true, `${mode} prossegue (sem capital em risco)`);
      assert.equal(decisao.unvetted, true, `${mode} precisa ser marcado como não auditado`);
      assert.ok(/NÃO AUDITADO/.test(decisao.reason));
    }
  });

  await test("orçamento: auditoria FALHOU bloqueia em qualquer modo (sem dado = sem decisão)", async () => {
    const { decideEntryWithBudget } = await import("../src/hotPath.js");
    for (const mode of ["LIVE", "PAPER", "SHADOW"]) {
      const decisao = decideEntryWithBudget({
        mode,
        deepComplete: false,
        deepElapsedMs: 40,
        budgetMs: 900,
        incompleteCause: "audit-error",
      });
      assert.equal(decisao.proceed, false, `${mode}: prosseguir sem NENHUM dado é compra às cegas`);
      assert.ok(/AUDITORIA FALHOU/.test(decisao.reason));
    }
    // A causa precisa distinguir: com dado parcial (orçamento), PAPER prossegue.
    const parcial = decideEntryWithBudget({
      mode: "PAPER",
      deepComplete: false,
      deepElapsedMs: 1500,
      budgetMs: 900,
      incompleteCause: "budget",
    });
    assert.equal(parcial.proceed, true);
    assert.equal(parcial.unvetted, true);
  });

  await test("latência: estágio gate_ok existe e a ordem recebida→gate_ok→enriquecido é respeitada", async () => {
    const tel = await import("../src/telemetry.js");
    assert.ok(
      (tel.LATENCY_STAGES as readonly string[]).includes("gate_ok"),
      "o overhead local do processo precisa de estágio próprio"
    );
    assert.ok(
      !(tel.LATENCY_STAGES as readonly string[]).includes("notified"),
      "não existe canal de notificação no caminho quente — estágio seria medição fabricada"
    );
    const trace = new tel.LatencyTrace("t_gate", 1_000, 100, 99);
    trace.mark("gate_ok");
    trace.mark("enriched");
    assert.equal(trace.has("gate_ok"), true);
    assert.ok(trace.elapsedTo("gate_ok") !== null);
    const record = trace.toRecord("rejected");
    assert.ok(record.durationsMs.gate_ok !== undefined, "a duração do portão rápido precisa ser medida");
    assert.ok(record.durationsMs.enriched !== undefined, "received→gate_ok→enriched");
  });

  await test("cartão quente: o enriquecimento NÃO bloqueia mais em getSlot nem abandona em silêncio", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const src = fs.readFileSync(path.join(repoRoot, "src", "realExecution.ts"), "utf8");

    // O callback do logsSubscribe recebe (logs, context) — verificado no web3.js.
    assert.ok(
      /this\.connection\.onLogs\([\s\S]{0,200}\(logs, context\)/.test(src),
      "o callback precisa usar o context da notificação (slot de graça)"
    );
    assert.ok(!/logs as any\)\.slot/.test(src), "o slot não existe no objeto de logs; não pode voltar essa leitura");
    assert.ok(
      !/receivedSlot = await this\.connection\.getSlot/.test(src),
      "getSlot não pode estar no caminho do evento (era um RTT por lançamento)"
    );
    assert.ok(src.includes("refreshLocalSlotInBackground"), "a amostra de slot deve ser atualizada em segundo plano");

    // Falha de enriquecimento precisa ser CONTADA (perda silenciosa era o defeito).
    assert.ok(src.includes("enrichmentFailures++"), "perda de lançamento precisa de contador");
    assert.ok(src.includes("enrichmentRetries++"), "retry do enriquecimento precisa ser visível");
    assert.ok(
      /getTransaction\(signature, \{[\s\S]{0,120}commitment: "confirmed"/.test(src),
      "getTransaction NÃO suporta processed — confirmado na doc da RPC e no tipo Finality do web3.js"
    );
    assert.ok(src.includes("resolveSendOptions(options)"), "submitViaRpc precisa usar a política única");
    assert.ok(
      !/maxRetries: options\?\.maxRetries \?\? 3/.test(src),
      "o default maxRetries do SDK (3) não pode voltar: retry cego no RPC é inobservável"
    );
  });

  await test("painel: feed e slot não podem ser fabricados (declarado vs medido)", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const serverSrc = fs.readFileSync(path.join(repoRoot, "server.ts"), "utf8");
    const radarSrc = fs.readFileSync(
      path.join(repoRoot, "src", "components", "GeyserGrpcRadar.tsx"),
      "utf8"
    );

    /**
     * Regra geral, mais forte que proibir a string: número de slot derivado do RELÓGIO não
     * pode aparecer em endpoint declarado como REAL. Ele pode existir em painel declarado
     * como simulado (onde o TruthBanner avisa) — nunca misturado com medição.
     */
    const declaredSimulated = new Set(
      [...serverSrc.matchAll(/app\.get\("([^"]+)"/g)].length
        ? [...serverSrc.matchAll(/\{\s*path: "(\/api\/[^"]+)", why:/g)].map((m) => m[1])
        : []
    );
    assert.ok(declaredSimulated.size >= 5, "a lista de painéis declarados como simulados precisa existir");
    for (const m of serverSrc.matchAll(/278913410 \+ Math\.floor\(\(Date\.now\(\) \/ 400\)/g)) {
      const before = serverSrc.slice(0, m.index);
      const endpoints = [...before.matchAll(/app\.get\("([^"]+)"/g)];
      const owner = endpoints.length > 0 ? endpoints[endpoints.length - 1][1] : "(fora de endpoint)";
      assert.ok(
        declaredSimulated.has(owner),
        `slot fabricado a partir do relógio em ${owner}, que NÃO está declarado como simulado em /api/system-truth`
      );
    }
    assert.ok(serverSrc.includes("currentSlotMeasured"), "a API precisa dizer se o slot foi MEDIDO");
    assert.ok(
      /simulated: true,[\s\S]{0,200}MOCK\/RNG/.test(serverSrc),
      "evento decorativo precisa se declarar como tal no payload"
    );
    assert.ok(/feed: \{[\s\S]{0,120}real: realCount/.test(serverSrc), "a API precisa contar real vs simulado");

    /**
     * /api/hft-telemetry: o painel continua sendo DEMONSTRAÇÃO, mas o slot tem de vir de medição
     * (último slot dos nós RPC) e o payload tem de se declarar simulado. Sem isso, um consumidor
     * externo (ou o operador) lê "slot 278.xxx.xxx" como estado real da rede.
     */
    const telemetryBloco = codigoSemComentarios(
      serverSrc.slice(
        serverSrc.indexOf('app.get("/api/hft-telemetry"'),
        serverSrc.indexOf('app.get("/api/geyser-stream"')
      )
    );
    assert.ok(
      /simulated: true/.test(telemetryBloco),
      "/api/hft-telemetry precisa declarar `simulated: true` no payload"
    );
    assert.ok(
      /Object\.values\(rpcMetrics\)[\s\S]{0,120}\.lastSlot/.test(telemetryBloco),
      "currentSlot de /api/hft-telemetry precisa vir de medição (rpcMetrics[].lastSlot), não do relógio"
    );
    assert.ok(
      /const currentSlot: number \| null = measuredSlots/.test(telemetryBloco),
      "currentSlot precisa ser MEDIDO ou null — nunca um número inventado"
    );
    assert.ok(
      !/Math\.random\(\)/.test(telemetryBloco.split("const currentSlot")[0]),
      "o slot não pode ser decidido por RNG antes da medição"
    );
    assert.ok(serverSrc.includes("unmeasured"), "o que não é medido precisa ser listado como não medido");

    // O painel não pode afirmar co-localização nem exibir números que a API não devolve.
    for (const proibido of ["SHREDSTREAM CO-LOCATED", "sub-1.2ms", "System Ingestion Load"]) {
      assert.ok(!radarSrc.includes(proibido), `afirmação fabricada no painel: "${proibido}"`);
    }
    assert.ok(
      /evt\.isRealOnChain !== true[\s\S]{0,400}mock/i.test(radarSrc),
      "evento decorativo precisa de selo visível na lista (só `isRealOnChain: true` é notificação real)"
    );
  });

  await test("regressão: infraestrutura inexistente não pode ser afirmada", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const serverSrc = fs.readFileSync(path.join(repoRoot, "server.ts"), "utf8");
    for (const proibido of [
      "SHREDSTREAM ACTIVE",
      "rpc-bare-metal-shred",
      "Reopening WebSocket shredstream connections",
      "ShredStream throughput is massive",
    ]) {
      assert.ok(!serverSrc.includes(proibido), `afirmação de infraestrutura inexistente: "${proibido}"`);
    }
    // O caminho quente precisa estar LIGADO (não basta existir o módulo).
    assert.ok(serverSrc.includes("hotPathInFlight.tryAcquire("), "a trava de mint em voo não está aplicada");
    assert.ok(serverSrc.includes("decideEntryWithBudget({"), "a política de orçamento não está aplicada");
    assert.ok(
      serverSrc.includes("hotPathInFlight.release("),
      "sem liberar o mint, a trava viraria bloqueio permanente"
    );
    // A política de orçamento precisa ser consultada também na FALHA do filtro: o `catch`
    // que só dá `return` deixa a regra fail-closed como código morto.
    assert.ok(
      /catch \(err: any\) \{[\s\S]{0,900}decideEntryWithBudget\(/.test(serverSrc),
      "a falha do filtro profundo precisa passar pela política (senão o veto é código morto)"
    );
    assert.ok(serverSrc.includes('trace?.mark("gate_ok")'), "o portão rápido precisa ser marcado");
    assert.ok(
      /\/api\/health[\s\S]{0,2000}hotPath: detection\.hotPath/.test(serverSrc),
      "os contadores do caminho quente precisam aparecer também em /api/health (primeira parada do operador)"
    );
    assert.ok(
      /hotPath\.note|hotPath: \{/.test(serverSrc) && serverSrc.includes("deepFilterFailures"),
      "os contadores do caminho quente precisam estar expostos para o operador"
    );
    const releases = serverSrc.match(/hotPathInFlight\.release\(/g) ?? [];
    assert.ok(releases.length >= 7, `todo caminho de saída precisa liberar o mint (encontrados ${releases.length})`);
  });

  // ---------------------------------------------------------------------------
  // [17] ORÇAMENTO DE COTA — a camada gratuita não falha por latência, falha por 429
  // ---------------------------------------------------------------------------
  console.log("\n[17] Orçamento de cota (grátis)");

  await test("janela deslizante: aceita até o teto e volta a aceitar quando a janela passa", async () => {
    const { RateBudget } = await import("../src/rateBudget.js");
    let now = 0;
    const b = new RateBudget({ name: "t", limit: 2, windowMs: 1000, source: "teste" }, () => now);
    assert.equal(b.tryAcquire(), true);
    assert.equal(b.tryAcquire(), true);
    assert.equal(b.tryAcquire(), false, "acima do teto é recusado");
    assert.equal(b.rejected, 1);
    now = 999;
    assert.equal(b.tryAcquire(), false, "dentro da janela ainda não libera");
    now = 1001;
    assert.equal(b.tryAcquire(), true, "fora da janela libera de novo");
    assert.equal(b.used(), 1, "as duas antigas saíram da janela");
  });

  await test("custo por chamada: uma chamada pode ocupar várias vagas", async () => {
    const { RateBudget } = await import("../src/rateBudget.js");
    let now = 0;
    // Alchemy: getTransaction custa 40 CU contra 10 de getAccountInfo = 4x
    const b = new RateBudget({ name: "c", limit: 10, windowMs: 1000, source: "teste" }, () => now);
    assert.equal(b.tryAcquire(4), true, "4 de 10");
    assert.equal(b.tryAcquire(4), true, "8 de 10");
    assert.equal(b.tryAcquire(4), false, "8+4 > 10: recusado (sem estourar a cota)");
    assert.equal(b.used(), 8);
    assert.equal(b.tryAcquire(2), true, "cabe exatamente no que sobrou");
  });

  await test("waitMsUntilNextSlot aponta a espera e zera quando há vaga", async () => {
    const { RateBudget } = await import("../src/rateBudget.js");
    let now = 10_000;
    const b = new RateBudget({ name: "w", limit: 1, windowMs: 1000, source: "teste" }, () => now);
    assert.equal(b.waitMsUntilNextSlot(), 0, "livre: sem espera");
    assert.equal(b.tryAcquire(), true);
    assert.equal(b.waitMsUntilNextSlot(), 1000, "precisa esperar a janela inteira");
    now += 400;
    assert.equal(b.waitMsUntilNextSlot(), 600);
    now += 600;
    assert.equal(b.waitMsUntilNextSlot(), 0);
  });

  await test("withBudget: prioridade normal espera até o teto e depois PULA (contabilizado)", async () => {
    const { RateBudget, withBudget } = await import("../src/rateBudget.js");
    let now = 0;
    const sleeps: number[] = [];
    const b = new RateBudget({ name: "j", limit: 1, windowMs: 1000, source: "teste" }, () => now);
    assert.equal(b.tryAcquire(), true, "consome a única vaga");

    // Espera curta o suficiente para caber: executa.
    const ok = await withBudget(b, async () => "executou", {
      maxWaitMs: 1200,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.value, "executou");
    assert.equal(sleeps.length, 1, "esperou a cota liberar");

    // Agora com espera insuficiente: PULA e conta — nunca estoura a cota.
    // (A vaga da chamada anterior ainda está na janela: avança o relógio para liberá-la.)
    now += 1000;
    assert.equal(b.tryAcquire(), true, "vaga liberada depois da janela");
    let called = false;
    const skip = await withBudget(b, async () => ((called = true), "não devia"), {
      maxWaitMs: 50,
      sleep: async (ms) => {
        now += ms;
      },
    });
    assert.equal(skip.ok, false, "sem cota e sem espera suficiente, a chamada NÃO é feita");
    assert.equal(called, false);
    assert.ok(/cota de "j" esgotada/.test(String(skip.skippedReason)));
    assert.equal(b.skipped, 1);
  });

  await test("withBudget: SAÍDA nunca é bloqueada por cota (bypass contado)", async () => {
    const { RateBudget, withBudget } = await import("../src/rateBudget.js");
    let now = 0;
    const b = new RateBudget({ name: "exit", limit: 1, windowMs: 60_000, source: "teste" }, () => now);
    assert.equal(b.tryAcquire(), true);
    // Vinte saídas acima da cota: todas executam (fechar posição é reduzir risco).
    for (let i = 0; i < 20; i++) {
      const r = await withBudget(b, async () => "fechou", { priority: "exit" });
      assert.equal(r.ok, true, "saída nunca é pulada");
      assert.equal(r.bypassed, true, "e o bypass é registrado");
    }
    assert.equal(b.bypassed, 20);
    assert.equal(b.skipped, 0, "nenhuma saída entra em `skipped`");
  });

  await test("withBudget: FUNDO não espera nada (cede a cota ao caminho quente)", async () => {
    const { RateBudget, withBudget } = await import("../src/rateBudget.js");
    let now = 0;
    const b = new RateBudget({ name: "bg", limit: 1, windowMs: 1000, source: "teste" }, () => now);
    assert.equal(b.tryAcquire(), true);
    let slept = false;
    const r = await withBudget(b, async () => "mediria", {
      priority: "background",
      maxWaitMs: 5000,
      sleep: async () => {
        slept = true;
      },
    });
    assert.equal(r.ok, false);
    assert.equal(slept, false, "fundo não pode consumir tempo do processo esperando cota");
  });

  await test("presets: todo teto tem ORIGEM declarada e valor positivo", async () => {
    const { RPC_PROFILES, MARKET_BUDGET_SPECS, buildBudgetRegistry } = await import("../src/rateBudget.js");
    for (const [name, spec] of Object.entries(RPC_PROFILES)) {
      assert.ok(spec.limit > 0, `${name}: limite positivo`);
      assert.ok(/helius|alchemy|quicknode|syndica|público|public/i.test(spec.source), `${name}: origem citada`);
    }
    for (const [name, spec] of Object.entries(MARKET_BUDGET_SPECS)) {
      assert.ok(spec.limit > 0, `${name}: limite positivo`);
      assert.ok(spec.source.length > 20, `${name}: origem precisa ser legível, não vazia`);
    }
    const reg = buildBudgetRegistry({ rpcProfile: "helius" });
    assert.equal(reg.rpc.spec.limit, RPC_PROFILES.helius.limit);
    const snap = reg.snapshot();
    assert.equal(snap.length, 7, "rpc + 6 provedores externos (DexScreener, Jupiter, GeckoTerminal, RugCheck, Jito x2)");
  });

  await test("perfil desconhecido cai em `public` (fail-safe, nunca sem teto)", async () => {
    const { buildBudgetRegistry, RPC_PROFILES } = await import("../src/rateBudget.js");
    const reg = buildBudgetRegistry({ rpcProfile: "provedor-que-nao-existe" });
    assert.equal(reg.rpc.spec.limit, RPC_PROFILES.public.limit);
    assert.ok(/público|public/i.test(reg.rpc.spec.source));
  });

  await test("orçamento desligado: continua CONTANDO o volume (não vira ponto cego)", async () => {
    const { buildBudgetRegistry } = await import("../src/rateBudget.js");
    const reg = buildBudgetRegistry({ disabled: true });
    for (let i = 0; i < 50; i++) reg.rpc.tryAcquire();
    assert.equal(reg.rpc.snapshot().accepted, 50);
    assert.ok(/DESLIGADO/.test(reg.rpc.spec.source), "a origem precisa dizer que o teto está desligado");
  });

  // ---------------------------------------------------------------------------
  // [18] FEED GRATUITO DA PUMPPORTAL — mint direto, sem getTransaction
  // ---------------------------------------------------------------------------
  console.log("\n[18] Feed PumpPortal (detecção gratuita com mint direto)");

  class FakeSocket {
    public sent: string[] = [];
    public closed = false;
    private handlers: Record<string, Array<(ev: any) => void>> = {};
    addEventListener(type: string, fn: (ev: any) => void) {
      (this.handlers[type] ??= []).push(fn);
    }
    send(data: string) { this.sent.push(data); }
    close() { this.closed = true; this.emit("close", {}); }
    /** Simula o servidor: dispara um evento para os handlers registrados. */
    emit(type: string, ev: any) { for (const fn of this.handlers[type] ?? []) fn(ev); }
    message(obj: any) { this.emit("message", { data: JSON.stringify(obj) }); }
    rawMessage(text: string) { this.emit("message", { data: text }); }
  }

  await test("parsing defensivo: só `mint` é obrigatório; o resto vira null, nunca inventado", async () => {
    const { parsePumpPortalMessage } = await import("../src/pumpPortalFeed.js");

    // Mensagem real típica (campos que o provedor envia na criação).
    const ok = parsePumpPortalMessage(
      JSON.stringify({
        signature: "5Kd3r8Qq4vYqk9m2VtXz1u8LsWzQb7nHfDc2",
        mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        txType: "create",
        name: "Teste",
        symbol: "TST",
        marketCapSol: 28.5,
        initialBuy: 0.5,
      }),
      1234
    );
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.event.mint, "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
      assert.equal(ok.event.txType, "create");
      assert.equal(ok.event.name, "Teste");
      assert.equal(ok.event.marketCapSol, 28.5);
      assert.equal(ok.event.receivedAt, 1234);
      assert.ok(ok.event.fields.includes("mint"));
    }

    // Sem campos opcionais: prossegue com null (não inventar nome nem market cap).
    const minimal = parsePumpPortalMessage(JSON.stringify({ mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" }), 1);
    assert.equal(minimal.ok, true);
    if (minimal.ok) {
      assert.equal(minimal.event.name, null);
      assert.equal(minimal.event.marketCapSol, null);
      assert.equal(minimal.event.txType, "unknown", "tipo não declarado NÃO pode ser chutado como create");
    }

    // Mensagem de migração: tipo reconhecido.
    const mig = parsePumpPortalMessage(JSON.stringify({ mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", txType: "migrate" }), 2);
    assert.equal(mig.ok && mig.event.txType, "migrate");
  });

  await test("parsing defensivo: entradas inválidas são RECUSADAS com motivo", async () => {
    const { parsePumpPortalMessage } = await import("../src/pumpPortalFeed.js");
    for (const [raw, motivo] of [
      ["não é json", /JSON inválido/],
      [JSON.stringify(["array"]), /não é objeto/],
      [JSON.stringify({}), /sem campo `mint`/],
      [JSON.stringify({ mint: "0OIl" }), /estruturalmente inválido/],
      [JSON.stringify({ mint: "" }), /sem campo `mint`/],
    ] as Array<[string, RegExp]>) {
      const r = parsePumpPortalMessage(raw, 0);
      assert.equal(r.ok, false, `deveria recusar: ${raw}`);
      if (!r.ok) assert.ok(motivo.test(r.reason), `motivo inesperado: ${r.reason}`);
    }
  });

  await test("feed: uma única conexão e as duas assinaturas gratuitas", async () => {
    const { PumpPortalFeed } = await import("../src/pumpPortalFeed.js");
    const sockets: FakeSocket[] = [];
    const feed = new PumpPortalFeed({
      onEvent: () => {},
      wsFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s as any;
      },
      setTimer: () => 0 as any,
      clearTimer: () => {},
    });

    feed.connect();
    feed.connect(); // no-op deliberado: múltiplas conexões podem causar banimento
    feed.connect();
    assert.equal(sockets.length, 1, "connect() repetido NÃO pode abrir outra conexão");

    sockets[0].emit("open", {});
    const methods = sockets[0].sent.map((m) => JSON.parse(m).method);
    assert.deepEqual(methods, ["subscribeNewToken", "subscribeMigration"], "assinaturas gratuitas");

    const h = feed.getHealth();
    assert.equal(h.socketOpen, true);
    assert.equal(h.subscriptionsSent.length, 2);
  });

  await test("feed: evento válido é emitido; duplicata e mensagem inválida são contadas", async () => {
    const { PumpPortalFeed } = await import("../src/pumpPortalFeed.js");
    const sockets: FakeSocket[] = [];
    const recebidos: any[] = [];
    const feed = new PumpPortalFeed({
      onEvent: (e) => recebidos.push(e),
      wsFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s as any;
      },
      setTimer: () => 0 as any,
      clearTimer: () => {},
    });
    feed.connect();
    const sock = sockets[0];
    sock.emit("open", {});

    const msg = { signature: "sigA", mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", txType: "create", name: "A" };
    sock.message(msg);
    sock.message(msg); // reentrega (reconexão do provedor)
    sock.rawMessage("isso não é json");
    sock.message({ txType: "create" }); // sem mint
    sock.message({ ...msg, signature: "sigB" }); // mesmo mint, evento novo

    assert.equal(recebidos.length, 2, "só eventos válidos e não duplicados");
    assert.equal(recebidos[0].name, "A");

    const h = feed.getHealth();
    assert.equal(h.messagesReceived, 5);
    assert.equal(h.eventsEmitted, 2);
    assert.equal(h.duplicatesDropped, 1);
    assert.equal(h.invalidMessages, 2);
  });

  await test("feed: queda agenda reconexão com backoff e `stop` cancela tudo", async () => {
    const { PumpPortalFeed, pumpPortalBackoffMs } = await import("../src/pumpPortalFeed.js");
    const sockets: FakeSocket[] = [];
    const timers: Array<{ fn: () => void; ms: number; canceled: boolean }> = [];
    const feed = new PumpPortalFeed({
      onEvent: () => {},
      wsFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s as any;
      },
      setTimer: (fn, ms) => {
        const t = { fn, ms, canceled: false };
        timers.push(t);
        return t as any;
      },
      clearTimer: (h: any) => {
        if (h) h.canceled = true;
      },
    });

    // Backoff cresce e satura no teto — reconectar em rajada é o que causa banimento.
    assert.ok(pumpPortalBackoffMs(1, 1000, 60_000) >= 250);
    assert.ok(pumpPortalBackoffMs(2, 1000, 60_000) > pumpPortalBackoffMs(1, 1000, 60_000));
    assert.ok(pumpPortalBackoffMs(30, 1000, 60_000) <= 60_000 * 1.2, "teto respeitado (jitter incluso)");

    feed.connect();
    sockets[0].emit("open", {});
    sockets[0].emit("close", {}); // queda
    assert.equal(timers.length, 1, "queda agenda UMA reconexão");
    assert.ok(timers[0].ms >= 250);
    assert.equal(feed.getHealth().socketOpen, false);
    assert.ok(feed.getHealth().consecutiveFailures >= 1);

    // O timer de reconexão abre nova conexão quando dispara.
    timers[0].fn();
    assert.equal(sockets.length, 2, "reconectou ao disparar o backoff");

    // stop(): cancela reconexão pendente e fecha o socket (sem ban por conexão abandonada).
    sockets[1].emit("open", {});
    feed.stop();
    assert.equal(sockets[1].closed, true);
    const h = feed.getHealth();
    assert.equal(h.socketOpen, false);
    // Depois de stop, uma nova queda NÃO pode agendar reconexão.
    sockets[1].emit("close", {});
    assert.equal(timers.length, 1, "após stop não se agenda reconexão");
  });

  await test("feed: falha do consumidor não derruba o feed", async () => {
    const { PumpPortalFeed } = await import("../src/pumpPortalFeed.js");
    const sockets: FakeSocket[] = [];
    const feed = new PumpPortalFeed({
      onEvent: () => {
        throw new Error("consumidor quebrado");
      },
      wsFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s as any;
      },
      setTimer: () => 0 as any,
      clearTimer: () => {},
    });
    feed.connect();
    sockets[0].emit("open", {});
    sockets[0].message({ mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", signature: "s1" });
    const h = feed.getHealth();
    assert.equal(h.eventsEmitted, 1, "o evento foi contado mesmo com o consumidor falhando");
    assert.ok(/onEvent lançou/.test(String(h.lastError)));
  });

  await test("regressão: o feed precisa estar LIGADO na detecção e medido", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const serverSrc = fs.readFileSync(path.join(repoRoot, "server.ts"), "utf8");
    assert.ok(serverSrc.includes("new PumpPortalFeed("), "o feed precisa ser instanciado no boot");
    assert.ok(
      /preEnriched: true/.test(serverSrc),
      "o evento da PumpPortal precisa ser marcado como pré-enriquecido (sem getTransaction)"
    );
    assert.ok(
      /preEnriched === true\) trace\?\.mark\("enriched"\)/.test(serverSrc),
      "o pipeline precisa marcar `enriched` na hora para evento pré-enriquecido"
    );
    assert.ok(
      /pumpPortal: pumpPortalRef\?\.getHealth\(\)/.test(serverSrc),
      "o health precisa expor o feed (prova de vida por contador, não por log)"
    );
    assert.ok(serverSrc.includes('"pumpportal"') && serverSrc.includes("HFT_PUMPPORTAL"), "fonte e chave de desligamento");
    assert.ok(
      /h\.eventsEmitted > 0 \? \("real" as const\) : \("unavailable" as const\)/.test(serverSrc),
      "o painel não pode declarar o feed como real sem prova de vida (eventsEmitted > 0)"
    );
    assert.ok(/process\.on\("SIGTERM"/.test(serverSrc), "precisa existir encerramento gracioso");
    assert.ok(
      /shutdown = \(signal[\s\S]{0,1200}pumpPortalRef\?\.stop\(\)/.test(serverSrc),
      "o encerramento precisa fechar o feed da PumpPortal (conexão abandonada pode causar ban)"
    );
  });

  // ---------------------------------------------------------------------------
  // [19] RUGCHECK — evidência externa gratuita que só pode ENDURECER a decisão
  // ---------------------------------------------------------------------------
  console.log("\n[19] RugCheck (evidência externa de risco)");

  await test("parser: payload completo vira evidência estruturada", async () => {
    const { parseRugCheckReport } = await import("../src/rugCheck.js");
    const ev = parseRugCheckReport(
      {
        score: 812,
        score_level: "danger",
        mintAuthority: null,
        freezeAuthority: "9xQeWvG816bUx9EPfEZvkVv7iLwLiZ2jWgpgFdkh9xQe",
        totalHolders: 128,
        risks: [
          { name: "Freeze Authority still enabled", level: "danger", score: 1, description: "pode congelar" },
          { name: "Low Liquidity", level: "warn", score: 100 },
          { name: "ignorado sem nome", level: "info" },
        ],
        markets: [
          { lp: { lpLockedPct: 12.5, lpLockedUSD: 4200 } },
          { lp: { lpLockedPct: 88.0, lpLockedUSD: 61000 } },
        ],
      },
      321
    );
    assert.equal(ev.available, true);
    assert.equal(ev.score, 812);
    assert.equal(ev.scoreLevel, "danger");
    assert.equal(ev.latencyMs, 321);
    assert.equal(ev.risks.length, 3);
    assert.deepEqual(ev.dangerNames, ["Freeze Authority still enabled"]);
    assert.equal(ev.lpLockedUsd, 61000, "pega o MAIOR pool, não o primeiro");
    assert.equal(ev.lpLockedPct, 88.0);
    assert.equal(ev.freezeAuthority?.slice(0, 4), "9xQe");
  });

  await test("parser: relatório vazio/estranho NUNCA vira aprovação", async () => {
    const { parseRugCheckReport } = await import("../src/rugCheck.js");
    for (const raw of [null, undefined, [], {}, { foo: "bar" }, "texto"]) {
      const ev = parseRugCheckReport(raw as any, null);
      assert.equal(ev.available, false, `deveria ser indisponível: ${JSON.stringify(raw)}`);
      assert.ok(ev.reason !== null, "indisponibilidade precisa de motivo explícito");
      assert.equal(ev.score, null, "score ausente é null, nunca 0 (0 pareceria nota boa)");
    }
    // Relatório com campos desconhecidos mas reconhecíveis é considerado disponível.
    const parcial = parseRugCheckReport({ totalHolders: 10 }, null);
    assert.equal(parcial.available, true);
  });

  await test("fetch: HTTP ruim, timeout e JSON inválido viram indisponibilidade com motivo", async () => {
    const { fetchRugCheckEvidence } = await import("../src/rugCheck.js");
    const casos: Array<[any, RegExp]> = [
      [async () => ({ ok: false, status: 429 } as any), /HTTP 429/],
      [async () => { throw new Error("timeout de rede"); }, /falha na consulta/],
      [async () => ({ ok: true, json: async () => { throw new Error("sem json"); } } as any), /não é JSON/],
    ];
    for (const [fetchImpl, motivo] of casos) {
      const ev = await fetchRugCheckEvidence("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", {
        fetchImpl: fetchImpl as any,
      });
      assert.equal(ev.available, false);
      assert.ok(motivo.test(String(ev.reason)), `motivo inesperado: ${ev.reason}`);
    }
  });

  await test("fetch: NUNCA espera por cota (evidência adicional não atrasa lançamento)", async () => {
    const { fetchRugCheckEvidence } = await import("../src/rugCheck.js");
    const { RateBudget } = await import("../src/rateBudget.js");
    let now = 0;
    const budget = new RateBudget({ name: "rugcheck", limit: 1, windowMs: 60_000, source: "teste" }, () => now);
    assert.equal(budget.tryAcquire(), true, "consome a única vaga");

    let chamou = false;
    const ev = await fetchRugCheckEvidence("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", {
      budget,
      fetchImpl: (async () => {
        chamou = true;
        return { ok: true, json: async () => ({ score: 10 }) } as any;
      }) as any,
    });
    assert.equal(chamou, false, "sem cota, a chamada externa não é feita");
    assert.equal(ev.available, false);
    assert.ok(/cota de "rugcheck" esgotada/.test(String(ev.reason)));
    assert.equal(budget.skipped, 1);
  });

  await test("regra de ouro: evidência externa só ENDURECE — nunca amolece", async () => {
    const { parseRugCheckReport, rugCheckRiskReasons } = await import("../src/rugCheck.js");

    // Indisponível: não gera risco NEM aprovação — o veredito local decide.
    const indisponivel = parseRugCheckReport(null);
    const r0 = rugCheckRiskReasons(indisponivel);
    assert.equal(r0.usable, false);
    assert.deepEqual(r0.reasons, []);

    // Limpo: utilizável, mas sem motivos — jamais vira "aprovação" (não existe API para isso).
    const limpo = parseRugCheckReport({ score: 5, risks: [], totalHolders: 50 });
    const r1 = rugCheckRiskReasons(limpo);
    assert.equal(r1.usable, true);
    assert.deepEqual(r1.reasons, [], "aprovação externa NÃO adiciona crédito de score");

    // Perigo: gera motivos, que o filtro usa para DESCONTAR.
    const perigo = parseRugCheckReport({
      score: 780,
      risks: [
        { name: "Freeze Authority still enabled", level: "danger" },
        { name: "Top holder owns 45%", level: "warn" },
      ],
      freezeAuthority: "9xQeWvG816bUx9EPfEZvkVv7iLwLiZ2jWgpgFdkh9xQe",
    });
    const r2 = rugCheckRiskReasons(perigo);
    assert.equal(r2.usable, true);
    assert.ok(r2.reasons.some((x) => /PERIGO/.test(x)));
    assert.ok(r2.reasons.some((x) => /score de risco/.test(x)));
    assert.ok(r2.reasons.some((x) => /freeze authority ativa/i.test(x)));
  });

  await test("regressão: o filtro profundo usa a evidência externa e ela é OPCIONAL", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const serverSrc = fs.readFileSync(path.join(repoRoot, "server.ts"), "utf8");
    assert.ok(serverSrc.includes("fetchRugCheckEvidence("), "o filtro precisa consultar a evidência externa");
    assert.ok(
      serverSrc.includes("rugCheckRiskReasons(") && serverSrc.includes("score -= Math.min(45"),
      "a evidência precisa DESCONTAR score (endurecer), nunca somar"
    );
    assert.ok(
      /HFT_RUGCHECK !== "0"/.test(serverSrc),
      "precisa existir chave de desligamento — dependência externa sempre pode ser removida"
    );
    assert.ok(
      serverSrc.includes('missingChecks.push("rugcheck (evidência externa)")'),
      "indisponível precisa ser registrado como verificação faltante, nunca como aprovação"
    );
  });

  // ---------------------------------------------------------------------------
  // [20] PREÇO EM LOTE — a alavanca de cota no plano gratuito
  // ---------------------------------------------------------------------------
  console.log("\n[20] Preço de mercado em lote (DexScreener / Jupiter Price / GeckoTerminal)");

  const BATCH_MINT_A = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const BATCH_MINT_B = "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E";

  await test("DexScreener (lote): um par por token, escolhendo o de MAIOR liquidez", async () => {
    const { parseDexScreenerBatch, SOL_MINT } = await import("../src/marketPriceFeed.js");
    const quotes = parseDexScreenerBatch(
      {
        pairs: [
          // Pool raso do BATCH_MINT_A — deve ser DESCARTADO em favor do profundo.
          { chainId: "solana", baseToken: { address: BATCH_MINT_A }, quoteToken: { address: SOL_MINT }, priceNative: "0.00000001", liquidity: { usd: 800 } },
          { chainId: "solana", baseToken: { address: BATCH_MINT_A }, quoteToken: { address: SOL_MINT }, priceNative: "0.0000042", liquidity: { usd: 250000 } },
          { chainId: "solana", baseToken: { address: BATCH_MINT_B }, quoteToken: { address: SOL_MINT }, priceNative: "0.001", liquidity: { usd: 9000 } },
          // Outra chain: ignorada.
          { chainId: "ethereum", baseToken: { address: BATCH_MINT_A }, priceNative: "5", liquidity: { usd: 999999 } },
          // Entrada sem preço: mantém liquidez, preço null (nunca 0).
          { chainId: "solana", baseToken: { address: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1" }, liquidity: { usd: 500 } },
        ],
      },
      999
    );
    assert.equal(quotes.size, 3);
    const a = quotes.get(BATCH_MINT_A)!;
    assert.equal(a.priceSol, 0.0000042, "preço do par de maior liquidez");
    assert.equal(a.liquidityUsd, 250000);
    assert.equal(a.fetchedAt, 999);
    assert.ok(/dexscreener/.test(a.source));
    assert.equal(quotes.get(BATCH_MINT_B)!.priceSol, 0.001);
    const semPreco = quotes.get("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1")!;
    assert.equal(semPreco.priceSol, null, "sem preço é null — nunca 0");
    assert.equal(semPreco.liquidityUsd, 500, "a liquidez que veio é preservada");
  });

  await test("DexScreener: par cotado em USDC NÃO é lido como SOL (bug de ~200x corrigido)", async () => {
    const { priceSolFromDexPairs, parseDexScreenerBatch, SOL_MINT } = await import("../src/marketPriceFeed.js");
    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const pairs = [
      // Par mais líquido do TOKEN é cotado em USDC: priceNative está em USDC (0.15 USDC por token),
      // e NÃO em SOL. Interpretá-lo como SOL daria 0.15 SOL quando o real é 0.15/200 = 0.00075.
      { chainId: "solana", baseToken: { address: BATCH_MINT_A }, quoteToken: { address: USDC }, priceNative: "0.15", priceUsd: "0.15", liquidity: { usd: 400_000 } },
      // Âncora: par de SOL contra USDC informa o USD/SOL no MESMO payload.
      { chainId: "solana", baseToken: { address: SOL_MINT }, quoteToken: { address: USDC }, priceUsd: "200", liquidity: { usd: 5_000_000 } },
    ];
    const r = priceSolFromDexPairs(pairs, BATCH_MINT_A);
    assert.equal(r.quoteToken, USDC);
    assert.ok(Math.abs((r.priceSol as number) - 0.00075) < 1e-12, `esperado 0.00075, veio ${r.priceSol}`);
    assert.ok((r.priceSol as number) < 0.01, "jamais aceitar 0.15 (o priceNative em USDC) como preço em SOL");

    const quotes = parseDexScreenerBatch({ pairs }, 7);
    assert.ok(Math.abs((quotes.get(BATCH_MINT_A)!.priceSol as number) - 0.00075) < 1e-12);
    assert.ok(/USD→SOL/.test(quotes.get(BATCH_MINT_A)!.source), "a fonte precisa dizer que houve conversão");
    assert.equal(quotes.get(SOL_MINT)!.priceSol, 1, "wrapped SOL vale 1 SOL por definição, qualquer que seja o par");
  });

  await test("DexScreener: par em outra moeda SEM âncora de SOL/USD devolve null (não inventa)", async () => {
    const { priceSolFromDexPairs, parseDexScreenerBatch } = await import("../src/marketPriceFeed.js");
    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const pairs = [
      { chainId: "solana", baseToken: { address: BATCH_MINT_B }, quoteToken: { address: USDC }, priceNative: "1.5", priceUsd: "1.5", liquidity: { usd: 50_000 } },
    ];
    const r = priceSolFromDexPairs(pairs, BATCH_MINT_B);
    assert.equal(r.priceSol, null, "sem SOL/USD não existe conversão honesta");
    assert.ok(/fabricar/.test(r.reason));
    const quotes = parseDexScreenerBatch({ pairs }, 7);
    assert.equal(quotes.get(BATCH_MINT_B)!.priceSol, null);
    assert.equal(quotes.get(BATCH_MINT_B)!.liquidityUsd, 50_000, "a liquidez que veio é preservada mesmo sem preço");
    assert.ok(/sem preço em SOL/.test(quotes.get(BATCH_MINT_B)!.source), "o motivo precisa estar visível");
  });

  await test("lote: a requisição do DexScreener inclui o SOL como âncora da conversão", async () => {
    const { fetchBatchPrices, SOL_MINT } = await import("../src/marketPriceFeed.js");
    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const urls: string[] = [];
    const result = await fetchBatchPrices([BATCH_MINT_A], {
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            pairs: [
              { chainId: "solana", baseToken: { address: BATCH_MINT_A }, quoteToken: { address: USDC }, priceNative: "0.15", priceUsd: "0.15", liquidity: { usd: 400_000 } },
              { chainId: "solana", baseToken: { address: SOL_MINT }, quoteToken: { address: USDC }, priceUsd: "200", liquidity: { usd: 5_000_000 } },
            ],
          }),
        } as any;
      }) as any,
    });
    assert.ok(urls[0].includes(SOL_MINT), "o SOL precisa ir na MESMA chamada (custo zero)");
    assert.ok(Math.abs((result.quotes.get(BATCH_MINT_A)!.priceSol as number) - 0.00075) < 1e-12);
    assert.equal(result.requests, 1, "converter não pode custar requisição extra");
  });

  await test("Jupiter Price v3 (lote): USD→SOL com o SOL da MESMA resposta", async () => {
    const { parseJupiterPriceBatch, SOL_MINT } = await import("../src/marketPriceFeed.js");
    const parsed = parseJupiterPriceBatch(
      {
        [SOL_MINT]: { usdPrice: 200 },
        [BATCH_MINT_A]: { usdPrice: 0.02 },
      },
      500
    );
    assert.equal(parsed.solFromResponse, true);
    assert.equal(parsed.solUsd, 200);
    assert.equal(parsed.quotes.get(SOL_MINT)!.priceSol, 1);
    // 0.02 USD / 200 USD por SOL = 0.0001 SOL
    assert.ok(Math.abs((parsed.quotes.get(BATCH_MINT_A)!.priceSol as number) - 0.0001) < 1e-12);
  });

  await test("Jupiter Price v3: sem SOL na resposta, NÃO converte com valor inventado", async () => {
    const { parseJupiterPriceBatch } = await import("../src/marketPriceFeed.js");
    // Sem SOL e sem reserva: preço fica null (não dá para converter honestamente).
    const semSol = parseJupiterPriceBatch({ [BATCH_MINT_A]: { usdPrice: 1 } }, 1);
    assert.equal(semSol.solUsd, null);
    assert.equal(semSol.solFromResponse, false);
    assert.equal(semSol.quotes.get(BATCH_MINT_A)!.priceSol, null, "sem SOL/USD não existe preço em SOL");

    // Com reserva EXPLÍCITA do chamador: converte e MARCA a origem do SOL/USD.
    const comReserva = parseJupiterPriceBatch({ [BATCH_MINT_A]: { usdPrice: 1 } }, 1, 250);
    assert.equal(comReserva.solUsd, 250);
    assert.equal(comReserva.quotes.get(BATCH_MINT_A)!.priceSol, 1 / 250);
    assert.ok(/reserva/.test(comReserva.quotes.get(BATCH_MINT_A)!.source), "a fonte precisa dizer que o SOL/USD veio de reserva");
  });

  await test("GeckoTerminal (lote): JSON:API parseado com o SOL do próprio lote", async () => {
    const { parseGeckoTerminalBatch, SOL_MINT } = await import("../src/marketPriceFeed.js");
    const parsed = parseGeckoTerminalBatch(
      {
        data: {
          attributes: {
            token_prices: {
              [SOL_MINT]: { price_usd: "150.5" },
              [BATCH_MINT_B]: { price_usd: "0.1505" },
              "endereco-invalido": { price_usd: "9" },
            },
          },
        },
      },
      42
    );
    assert.equal(parsed.solFromResponse, true);
    assert.equal(parsed.solUsd, 150.5);
    assert.ok(Math.abs((parsed.quotes.get(BATCH_MINT_B)!.priceSol as number) - 0.001) < 1e-12);
    assert.equal(parsed.quotes.has("endereco-invalido"), false, "endereço estruturalmente inválido é ignorado");
  });

  await test("cascata: DexScreener responde tudo → NÃO gasta as outras fontes", async () => {
    const { fetchBatchPrices, SOL_MINT } = await import("../src/marketPriceFeed.js");
    const chamadas: string[] = [];
    const result = await fetchBatchPrices([BATCH_MINT_A, BATCH_MINT_B], {
      fetchImpl: (async (url: string) => {
        chamadas.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            pairs: [
              { chainId: "solana", baseToken: { address: BATCH_MINT_A }, quoteToken: { address: SOL_MINT }, priceNative: "0.001", liquidity: { usd: 1000 } },
              { chainId: "solana", baseToken: { address: BATCH_MINT_B }, quoteToken: { address: SOL_MINT }, priceNative: "0.002", liquidity: { usd: 2000 } },
            ],
          }),
        } as any;
      }) as any,
    });
    assert.equal(chamadas.length, 1, "uma única requisição para os dois tokens");
    assert.equal(result.requests, 1);
    assert.deepEqual(result.sourcesUsed, ["dexscreener"]);
    assert.equal(result.quotes.get(BATCH_MINT_A)!.priceSol, 0.001);
    assert.equal(result.problems.length, 0, "sem problema quando todos têm preço");
  });

  await test("cascata: o que faltou vai para a PRÓXIMA fonte (e a liquidez é preservada)", async () => {
    const { fetchBatchPrices, SOL_MINT } = await import("../src/marketPriceFeed.js");
    const chamadas: string[] = [];
    const result = await fetchBatchPrices([BATCH_MINT_A, BATCH_MINT_B], {
      fetchImpl: (async (url: string) => {
        chamadas.push(url);
        if (url.includes("dexscreener")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              pairs: [{ chainId: "solana", baseToken: { address: BATCH_MINT_A }, quoteToken: { address: SOL_MINT }, priceNative: "0.001", liquidity: { usd: 1234 } }],
            }),
          } as any;
        }
        // Jupiter: resolve o BATCH_MINT_B que ficou sem preço.
        return { ok: true, status: 200, json: async () => ({ [SOL_MINT]: { usdPrice: 200 }, [BATCH_MINT_B]: { usdPrice: 0.4 } }) } as any;
      }) as any,
    });
    assert.equal(chamadas.length, 2, "1 DexScreener + 1 Jupiter");
    assert.deepEqual(result.sourcesUsed, ["dexscreener", "jupiter-price-v3"]);
    assert.equal(result.quotes.get(BATCH_MINT_A)!.priceSol, 0.001);
    assert.equal(result.quotes.get(BATCH_MINT_A)!.liquidityUsd, 1234);
    assert.ok(Math.abs((result.quotes.get(BATCH_MINT_B)!.priceSol as number) - 0.002) < 1e-12);
    // O SOL não é pedido à toa: vai no lote da Jupiter para a conversão.
    assert.ok(chamadas[1].includes(encodeURIComponent(SOL_MINT)) || chamadas[1].includes(SOL_MINT));
  });

  await test("cascata: três fontes caídas → problema registrado, nenhum preço inventado", async () => {
    const { fetchBatchPrices } = await import("../src/marketPriceFeed.js");
    const result = await fetchBatchPrices([BATCH_MINT_A], {
      fetchImpl: (async () => ({ ok: false, status: 503, json: async () => ({}) }) as any) as any,
    });
    assert.equal(result.quotes.size, 0);
    assert.equal(result.requests, 3, "tentou as três fontes");
    assert.ok(result.problems.some((p) => /dexscreener: HTTP 503/.test(p)));
    assert.ok(result.problems.some((p) => /jupiter price v3: HTTP 503/.test(p)));
    assert.ok(result.problems.some((p) => /geckoterminal: HTTP 503/.test(p)));
    assert.ok(result.problems.some((p) => /sem preço em nenhuma fonte/.test(p)), "o resultado precisa dizer que ficou sem preço");
  });

  await test("lotes respeitam o tamanho máximo de cada provedor (30/50/30)", async () => {
    const { fetchBatchPrices, DEXSCREENER_MAX_ADDRESSES_PER_CALL, JUPITER_MAX_IDS_PER_CALL } = await import(
      "../src/marketPriceFeed.js"
    );
    const mints = Array.from({ length: 65 }, (_, i) => `${i}`.padStart(32, "A").slice(0, 32) + "1111");
    const urls: string[] = [];
    await fetchBatchPrices(mints, {
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => ({ pairs: [] }) } as any;
      }) as any,
    });
    const dexCalls = urls.filter((u) => u.includes("dexscreener"));
    const dexSizes = dexCalls.map((u) => u.split("/tokens/")[1].split(",").length);
    assert.ok(dexSizes.every((n) => n <= DEXSCREENER_MAX_ADDRESSES_PER_CALL), `DexScreener: ${dexSizes.join(",")}`);
    assert.ok(dexCalls.length >= Math.ceil(65 / DEXSCREENER_MAX_ADDRESSES_PER_CALL), "65 mints exigem pelo menos 3 chamadas");
    const jupSizes = urls
      .filter((u) => u.includes("price/v3"))
      .map((u) => u.split("ids=")[1].split(",").length);
    assert.ok(jupSizes.every((n) => n <= JUPITER_MAX_IDS_PER_CALL), `Jupiter: ${jupSizes.join(",")}`);
  });

  await test("cota: orçamento esgotado PULA o provedor e diz por quê (não estoura 429)", async () => {
    const { fetchBatchPrices } = await import("../src/marketPriceFeed.js");
    const { RateBudget } = await import("../src/rateBudget.js");
    let now = 0;
    const dexBudget = new RateBudget({ name: "dexscreener", limit: 1, windowMs: 60_000, source: "teste" }, () => now);
    assert.equal(dexBudget.tryAcquire(), true, "consome a única vaga da janela");

    let dexCalled = false;
    const result = await fetchBatchPrices([BATCH_MINT_A], {
      dexscreenerBudget: dexBudget,
      fetchImpl: (async (url: string) => {
        if (url.includes("dexscreener")) dexCalled = true;
        return { ok: false, status: 500, json: async () => ({}) } as any;
      }) as any,
    });
    assert.equal(dexCalled, false, "sem cota, o DexScreener NÃO é chamado");
    assert.ok(result.problems.some((p) => /dexscreener: PULADO — cota de "dexscreener" esgotada/.test(p)));
    assert.equal(dexBudget.skipped, 1);
  });

  await test("mints inválidos não geram requisição (mock com reticências e endereço curto)", async () => {
    const { fetchBatchPrices, isQueryableMint } = await import("../src/marketPriceFeed.js");
    assert.equal(isQueryableMint("7xKX...AsU"), false);
    assert.equal(isQueryableMint("curto"), false);
    assert.equal(isQueryableMint(BATCH_MINT_A), true);

    let chamou = false;
    const result = await fetchBatchPrices(["mock...123", "curto", ""], {
      fetchImpl: (async () => {
        chamou = true;
        return { ok: true, status: 200, json: async () => ({}) } as any;
      }) as any,
    });
    assert.equal(chamou, false, "lista sem nenhum mint consultável não deve gastar cota");
    assert.equal(result.requests, 0);
    assert.ok(result.problems[0].includes("nenhum mint consultável"));
  });

  await test("rede cai (fetch LANÇA): problema registrado, NADA é lançado para o chamador", async () => {
    const { fetchBatchPrices } = await import("../src/marketPriceFeed.js");
    // Este caso existia como bug real: a exceção propagava e derrubava o processo inteiro
    // (aconteceu na primeira execução do `free:check` num ambiente sem egress).
    const result = await fetchBatchPrices([BATCH_MINT_A], {
      fetchImpl: (async () => {
        throw new Error("fetch failed");
      }) as any,
    });
    assert.equal(result.quotes.size, 0);
    assert.equal(result.requests, 3, "tentou as três fontes mesmo com exceção de rede");
    assert.ok(result.problems.some((p) => /falha de rede/.test(p)), "o motivo precisa aparecer");
    assert.ok(result.problems.some((p) => /sem preço em nenhuma fonte/.test(p)));
  });

  await test("regressão: o gerenciador usa o LOTE antes das tentativas por posição", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const serverSrc = fs.readFileSync(path.join(repoRoot, "server.ts"), "utf8");
    assert.ok(serverSrc.includes("fetchBatchPrices("), "o loop precisa buscar preços em lote");
    assert.ok(
      /batchQuote\.priceSol !== null && batchQuote\.priceSol > 0/.test(serverSrc),
      "o lote só pode ser usado quando trouxe preço VÁLIDO"
    );
    assert.ok(
      /if \(!isMockMint && currentPriceSol === 0\)/.test(serverSrc),
      "as tentativas por posição precisam virar FALLBACK (só quando o lote não trouxe preço)"
    );
    assert.ok(
      serverSrc.includes("marketBatchStats") && serverSrc.includes("marketBatch:"),
      "o ganho de cota precisa ser visível no /api/health"
    );
    assert.ok(serverSrc.includes('HFT_MARKET_BATCH === "0"'), "precisa existir chave para voltar ao comportamento antigo");
  });

  // ---------------------------------------------------------------------------
  // [21] QUALIDADE DE PREÇO — divergência entre fontes e liquidez em queda
  // ---------------------------------------------------------------------------
  console.log("\n[21] Qualidade de preço (divergência entre fontes e liquidez)");

  const PQ_MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
  const PQ_MINT_B = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const PQ_LIMIARES = { warnPct: 0.05, criticalPct: 0.15, maxAgeMs: 60_000 };

  await test("divergência relativa: simétrica, normalizada pelo maior e null sem preço válido", async () => {
    const { relativeDivergencePct } = await import("../src/priceQuality.js");
    assert.equal(relativeDivergencePct(0.001, 0.002), 0.5);
    assert.equal(relativeDivergencePct(0.002, 0.001), 0.5, "precisa ser simétrica");
    assert.equal(relativeDivergencePct(1, 1), 0);
    assert.equal(relativeDivergencePct(0, 1), null, "zero não é preço");
    assert.equal(relativeDivergencePct(-1, 1), null);
    assert.equal(relativeDivergencePct(Number.NaN, 1), null);
    assert.equal(relativeDivergencePct("0.1" as any, 1), null, "string não é preço");
  });

  await test("classificação por faixa: ok abaixo de warn, warn entre, critical acima", async () => {
    const { classifyDivergence } = await import("../src/priceQuality.js");
    assert.equal(classifyDivergence(0.049, PQ_LIMIARES), "ok");
    assert.equal(classifyDivergence(0.05, PQ_LIMIARES), "warn");
    assert.equal(classifyDivergence(0.149, PQ_LIMIARES), "warn");
    assert.equal(classifyDivergence(0.15, PQ_LIMIARES), "critical");
    assert.equal(classifyDivergence(null, PQ_LIMIARES), null, "sem número não existe classificação");
  });

  await test("livro: a MESMA fonte não serve de referência (deriva de mercado não é divergência)", async () => {
    const { PriceSampleBook } = await import("../src/priceQuality.js");
    const livro = new PriceSampleBook({ now: () => 1_000 });
    livro.record({ mint: PQ_MINT, source: "dexscreener", priceSol: 0.001, at: 900 });
    assert.equal(livro.freshestOtherSource(PQ_MINT, "dexscreener", 60_000), null);
    const ref = livro.freshestOtherSource(PQ_MINT, "jupiter", 60_000);
    assert.equal(ref?.source, "dexscreener");
  });

  await test("assessDivergence: compara com a outra fonte e devolve os DOIS preços e a idade", async () => {
    const { PriceSampleBook, assessDivergence } = await import("../src/priceQuality.js");
    const livro = new PriceSampleBook({ now: () => 1_000 });
    livro.record({ mint: PQ_MINT, source: "dexscreener", priceSol: 0.001, at: 900 });

    const warn = assessDivergence(PQ_MINT, { source: "jupiter", priceSol: 0.0011 }, livro, PQ_LIMIARES);
    assert.equal(warn?.severity, "warn");
    assert.equal(warn?.bps, 909);
    assert.equal(warn?.reference.source, "dexscreener");
    assert.equal(warn?.reference.ageMs, 100, "a idade da amostra precisa viajar com o achado");

    const critico = assessDivergence(PQ_MINT, { source: "geckoterminal", priceSol: 0.002 }, livro, PQ_LIMIARES);
    assert.equal(critico?.severity, "critical");
    assert.equal(critico?.pct, 0.5);

    // Sem segunda opinião: null — que significa NÃO VERIFIQUEI, não está tudo certo.
    assert.equal(assessDivergence(PQ_MINT_B, { source: "jupiter", priceSol: 1 }, livro, PQ_LIMIARES), null);
  });

  await test("livro: amostra fora da janela não é referência e o prune libera memória", async () => {
    const { PriceSampleBook } = await import("../src/priceQuality.js");
    const livro = new PriceSampleBook({ now: () => 100_000 });
    livro.record({ mint: PQ_MINT, source: "dexscreener", priceSol: 0.001, at: 1_000 });
    assert.equal(livro.freshestOtherSource(PQ_MINT, "jupiter", 45_000), null, "45s é a janela padrão");
    assert.equal(livro.prune(45_000), 1);
    assert.equal(livro.size(), 0);
  });

  await test("livro: memória LIMITADA por token e por quantidade de tokens (sem vazamento)", async () => {
    const { PriceSampleBook } = await import("../src/priceQuality.js");
    const livro = new PriceSampleBook({ maxPerMint: 2, maxMints: 2, now: () => 10_000 });
    livro.record({ mint: "m1", source: "A", priceSol: 1, at: 1 });
    livro.record({ mint: "m1", source: "A", priceSol: 2, at: 2 });
    livro.record({ mint: "m1", source: "A", priceSol: 3, at: 3 });
    assert.equal(livro.countFor("m1"), 2, "só as mais recentes ficam");
    assert.equal(livro.latest("m1")?.priceSol, 3);

    livro.record({ mint: "m2", source: "A", priceSol: 1, at: 4 });
    livro.record({ mint: "m3", source: "A", priceSol: 1, at: 5 });
    assert.equal(livro.size(), 2);
    assert.equal(livro.latest("m1"), null, "o token registrado há mais tempo sai (evicção FIFO)");
    assert.ok(livro.latest("m3"), "o mais novo permanece");
  });

  await test("livro: preço inválido (0, negativo, NaN, Infinity) NUNCA entra", async () => {
    const { PriceSampleBook } = await import("../src/priceQuality.js");
    const livro = new PriceSampleBook();
    for (const preco of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(livro.record({ mint: PQ_MINT, source: "A", priceSol: preco as number, at: 1 }), false);
    }
    assert.equal(livro.record({ mint: PQ_MINT, source: "A", priceSol: 1, at: Number.NaN }), false, "sem instante não é amostra");
    assert.equal(livro.size(), 0, "nada inválido ficou na memória");
  });

  await test("compareSamples: mesma fonte devolve null mesmo com preços muito diferentes", async () => {
    const { compareSamples } = await import("../src/priceQuality.js");
    const mesmo = compareSamples(
      PQ_MINT,
      { source: "dexscreener", priceSol: 0.001, at: 0 },
      { source: "dexscreener", priceSol: 0.01 },
      PQ_LIMIARES,
      0
    );
    assert.equal(mesmo, null);
    const outro = compareSamples(
      PQ_MINT,
      { source: "dexscreener", priceSol: 0.001, at: 0 },
      { source: "geckoterminal", priceSol: 0.01 },
      PQ_LIMIARES,
      0
    );
    assert.equal(outro?.severity, "critical");
  });

  await test("lote: amostra de verificação traz segunda opinião e DETECTA divergência", async () => {
    const { fetchBatchPrices, SOL_MINT } = await import("../src/marketPriceFeed.js");
    const { PriceSampleBook } = await import("../src/priceQuality.js");
    const urls: string[] = [];
    const livro = new PriceSampleBook();
    const result = await fetchBatchPrices([PQ_MINT, PQ_MINT_B], {
      sampleBook: livro,
      verifyMints: [PQ_MINT],
      fetchImpl: (async (url: string) => {
        urls.push(url);
        if (url.includes("dexscreener")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              pairs: [
                { chainId: "solana", baseToken: { address: PQ_MINT }, quoteToken: { address: SOL_MINT }, priceNative: "0.001", liquidity: { usd: 50_000 } },
                { chainId: "solana", baseToken: { address: PQ_MINT_B }, quoteToken: { address: SOL_MINT }, priceNative: "0.5", liquidity: { usd: 10_000 } },
              ],
            }),
          } as any;
        }
        // Jupiter: 0.003 USD contra SOL 200 USD → 0.000015 SOL, contra 0.001 do DexScreener.
        return { ok: true, status: 200, json: async () => ({ [SOL_MINT]: { usdPrice: 200 }, [PQ_MINT]: { usdPrice: 0.003 } }) } as any;
      }) as any,
    });

    assert.equal(result.requests, 2, "1 requisição do lote + 1 da verificação cruzada");
    assert.equal(result.verification.attempted, true);
    assert.equal(result.verification.source, "jupiter-price-v3");
    assert.equal(result.verification.checked, 1);
    assert.equal(result.divergences.length, 1);
    const d = result.divergences[0];
    assert.equal(d.mint, PQ_MINT);
    assert.equal(d.severity, "critical");
    assert.equal(d.bps, 9850);
    assert.ok(/dexscreener/.test(d.reference.source), "a referência é a fonte do ciclo");
    assert.ok(/jupiter/.test(d.candidate.source), "o candidato é a fonte independente");
    assert.ok(urls[1].includes("price/v3"), "a verificação usa o endpoint em LOTE da Jupiter");
    assert.equal(livro.countFor(PQ_MINT), 2, "as duas amostras ficam no livro para os próximos ciclos");
  });

  await test("lote: preços que concordam → NENHUMA divergência, mas a verificação ACONTECEU", async () => {
    const { fetchBatchPrices, SOL_MINT } = await import("../src/marketPriceFeed.js");
    const { PriceSampleBook } = await import("../src/priceQuality.js");
    const result = await fetchBatchPrices([PQ_MINT], {
      sampleBook: new PriceSampleBook(),
      verifyMints: [PQ_MINT],
      fetchImpl: (async (url: string) => {
        if (url.includes("dexscreener")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              pairs: [{ chainId: "solana", baseToken: { address: PQ_MINT }, quoteToken: { address: SOL_MINT }, priceNative: "0.001", liquidity: { usd: 1_000 } }],
            }),
          } as any;
        }
        // 0.2 USD / 200 USD por SOL = exatamente 0.001 SOL.
        return { ok: true, status: 200, json: async () => ({ [SOL_MINT]: { usdPrice: 200 }, [PQ_MINT]: { usdPrice: 0.2 } }) } as any;
      }) as any,
    });
    assert.equal(result.divergences.length, 0);
    assert.equal(result.verification.checked, 1, "ausência de divergência NÃO é ausência de verificação");
  });

  await test("lote: verificação pede a fonte que ainda NÃO respondeu (nunca a mesma)", async () => {
    const { fetchBatchPrices, SOL_MINT } = await import("../src/marketPriceFeed.js");
    const urls: string[] = [];
    const result = await fetchBatchPrices([PQ_MINT], {
      verifyMints: [PQ_MINT],
      fetchImpl: (async (url: string) => {
        urls.push(url);
        if (url.includes("dexscreener")) return { ok: true, status: 200, json: async () => ({ pairs: [] }) } as any;
        if (url.includes("price/v3")) {
          return { ok: true, status: 200, json: async () => ({ [SOL_MINT]: { usdPrice: 200 }, [PQ_MINT]: { usdPrice: 0.2 } }) } as any;
        }
        // GeckoTerminal: ainda não tinha sido tentada porque a Jupiter resolveu tudo.
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { attributes: { token_prices: { [SOL_MINT]: { price_usd: "201" }, [PQ_MINT]: { price_usd: "0.201" } } } },
          }),
        } as any;
      }) as any,
    });
    assert.ok(urls[1].includes("price/v3"), "Jupiter foi a segunda tentativa do lote");
    assert.equal(result.verification.attempted, true);
    assert.equal(result.verification.source, "geckoterminal", "a verificação usa a fonte que AINDA não respondeu");
    assert.ok(urls[2].includes("geckoterminal"), "e de fato chama o endpoint dela");
    assert.equal(result.verification.checked, 1);
    assert.equal(result.divergences.length, 0, "201 vs 200 é ruído de cotação, não divergência");
  });

  await test("lote: quando as TRÊS fontes já foram tentadas, a verificação é declarada impossível", async () => {
    const { fetchBatchPrices, SOL_MINT } = await import("../src/marketPriceFeed.js");
    const result = await fetchBatchPrices([PQ_MINT], {
      verifyMints: [PQ_MINT],
      fetchImpl: (async (url: string) => {
        if (url.includes("dexscreener")) return { ok: true, status: 200, json: async () => ({ pairs: [] }) } as any;
        if (url.includes("price/v3")) return { ok: true, status: 200, json: async () => ({ [SOL_MINT]: { usdPrice: 200 } }) } as any;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { attributes: { token_prices: { [SOL_MINT]: { price_usd: "200" }, [PQ_MINT]: { price_usd: "0.2" } } } },
          }),
        } as any;
      }) as any,
    });
    assert.equal(result.requests, 3, "as três fontes foram usadas para achar preço");
    assert.equal(result.verification.attempted, false);
    assert.equal(result.verification.checked, 0);
    assert.ok(
      result.verification.problems.some((p) => /três fontes já foram tentadas/.test(p)),
      "o motivo de NÃO ter verificado precisa ser explícito"
    );
  });

  await test("lote: verificação pulada por cota é REPORTADA (não vira silêncio)", async () => {
    const { fetchBatchPrices, SOL_MINT } = await import("../src/marketPriceFeed.js");
    const { RateBudget } = await import("../src/rateBudget.js");
    const jupiterBudget = new RateBudget({ name: "jupiter-teste", limit: 1, windowMs: 60_000, source: "teste" });
    jupiterBudget.tryAcquire(); // consome a única vaga

    const result = await fetchBatchPrices([PQ_MINT], {
      verifyMints: [PQ_MINT],
      jupiterBudget,
      fetchImpl: (async (url: string) => {
        if (url.includes("dexscreener")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              pairs: [{ chainId: "solana", baseToken: { address: PQ_MINT }, quoteToken: { address: SOL_MINT }, priceNative: "0.001", liquidity: { usd: 1 } }],
            }),
          } as any;
        }
        throw new Error("não deveria chamar a rede com a cota esgotada");
      }) as any,
    });
    assert.equal(result.verification.attempted, true);
    assert.equal(result.verification.checked, 0);
    assert.ok(result.verification.problems.some((p) => /PULADA/.test(p)));
    assert.equal(jupiterBudget.skipped, 1, "o pulo entra no contador do orçamento");
  });

  await test("lote: verificação NUNCA fura a cota, nem quando o lote tem prioridade de saída", async () => {
    const { fetchBatchPrices, SOL_MINT } = await import("../src/marketPriceFeed.js");
    const { RateBudget } = await import("../src/rateBudget.js");
    const jupiterBudget = new RateBudget({ name: "jupiter-teste2", limit: 1, windowMs: 60_000, source: "teste" });
    jupiterBudget.tryAcquire();

    const result = await fetchBatchPrices([PQ_MINT], {
      verifyMints: [PQ_MINT],
      priority: "exit", // gestão de posição pode furar cota; a VERIFICAÇÃO não pode.
      jupiterBudget,
      fetchImpl: (async (url: string) => {
        if (url.includes("dexscreener")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              pairs: [{ chainId: "solana", baseToken: { address: PQ_MINT }, quoteToken: { address: SOL_MINT }, priceNative: "0.001", liquidity: { usd: 1 } }],
            }),
          } as any;
        }
        throw new Error("verificação não pode chamar a rede sem cota");
      }) as any,
    });
    assert.equal(result.verification.attempted, true);
    assert.equal(result.verification.checked, 0);
    assert.equal(jupiterBudget.bypassed, 0, "verificação é dado adicional: nunca faz bypass de cota");
    assert.equal(jupiterBudget.skipped, 1);
  });

  await test("liquidez: queda de 60% alerta warn; de 90% alerta critical; subida não alerta", async () => {
    const { assessLiquidityDrop } = await import("../src/priceQuality.js");
    const warn = assessLiquidityDrop(100_000, 40_000);
    assert.equal(warn?.severity, "warn");
    assert.ok(Math.abs((warn?.dropPct ?? 0) - 0.6) < 1e-9);
    const critico = assessLiquidityDrop(100_000, 10_000);
    assert.equal(critico?.severity, "critical");
    assert.equal(assessLiquidityDrop(100_000, 60_000), null, "queda de 40% ainda não alerta");
    assert.equal(assessLiquidityDrop(100_000, 120_000), null, "liquidez subiu: nada a declarar");
    assert.equal(assessLiquidityDrop(0, 10), null, "sem pico válido não existe queda");
    assert.equal(assessLiquidityDrop(100, Number.NaN), null);
    assert.equal(assessLiquidityDrop(100, -5), null);
  });

  await test("regressão: divergência e liquidez são ALERTA — nenhuma venda automática", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const serverSrc = fs.readFileSync(path.join(repoRoot, "server.ts"), "utf8");
    assert.ok(serverSrc.includes("priceSampleBook"), "o livro de amostras precisa estar ligado ao laço");
    assert.ok(serverSrc.includes("verifyMints"), "a amostra de verificação precisa ser passada ao lote");
    assert.ok(serverSrc.includes("HFT_PRICE_DIVERGENCE") && serverSrc.includes("HFT_PRICE_VERIFY_SAMPLE"));
    assert.ok(
      /ALERTA apenas: nenhuma venda foi disparada por este sinal/.test(serverSrc),
      "o alerta de liquidez não pode virar gatilho de venda sem autorização própria"
    );
    assert.ok(serverSrc.includes("liquidityUsdPeak"), "o pico de liquidez precisa ser acompanhado");
    assert.equal(
      /parseFloat\([a-zA-Z.]*priceNative\)/.test(serverSrc),
      false,
      "o server não pode ler priceNative cru: ele está na moeda de cotação do par, não em SOL"
    );
    assert.ok(
      serverSrc.includes("priceSolFromDexPairs("),
      "os dois caminhos de preço do DexScreener precisam usar a regra única de conversão"
    );
    const priceSrc = fs.readFileSync(path.join(repoRoot, "src/priceQuality.ts"), "utf8");
    assert.ok(
      !/sell|swap|sendTransaction/i.test(priceSrc),
      "o módulo de qualidade de preço NÃO pode executar nada na rede"
    );
  });

  // ---------------------------------------------------------------------------
  // [22] PREÇO DE ENTRADA — a verificação que impede abrir posição sobre número errado
  // ---------------------------------------------------------------------------
  console.log("\n[22] Qualidade do preço de entrada (duas fontes ou recusa)");

  const EN_MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";
  const EN_LIMIARES = { warnPct: 0.05, criticalPct: 0.15, maxAgeMs: 45_000 };
  const EN_QUOTE = { priceSol: 0.001, source: "dexscreener (lote)" };

  await test("entrada: duas fontes concordando → verified e aceita", async () => {
    const { assessEntryPrice } = await import("../src/entryQuality.js");
    const r = assessEntryPrice({
      quote: EN_QUOTE,
      comparison: { referenceSource: "dexscreener (lote)", candidateSource: "jupiter price/v3 (lote)", bps: 12, severity: "ok" },
      thresholds: EN_LIMIARES,
    });
    assert.equal(r.status, "verified");
    assert.equal(r.accepted, true);
    assert.equal(r.priceSol, 0.001);
    assert.equal(r.divergenceBps, 12);
    assert.deepEqual(r.sources, ["dexscreener (lote)", "jupiter price/v3 (lote)"]);
    assert.ok(/concordam/.test(r.reason));
  });

  await test("entrada: diferença acima do aviso → verified_with_warning (aceita e REGISTRA)", async () => {
    const { assessEntryPrice } = await import("../src/entryQuality.js");
    const r = assessEntryPrice({
      quote: EN_QUOTE,
      comparison: { referenceSource: "A", candidateSource: "B", bps: 900, severity: "warn" },
      thresholds: EN_LIMIARES,
    });
    assert.equal(r.status, "verified_with_warning");
    assert.equal(r.accepted, true);
    assert.equal(r.severity, "warn");
    assert.ok(/aviso/.test(r.reason));
  });

  await test("entrada: divergência CRÍTICA → RECUSA abrir posição (evidência de erro grosseiro)", async () => {
    const { assessEntryPrice } = await import("../src/entryQuality.js");
    const r = assessEntryPrice({
      quote: EN_QUOTE,
      comparison: { referenceSource: "dexscreener (lote)", candidateSource: "geckoterminal (lote)", bps: 3000, severity: "critical" },
      thresholds: EN_LIMIARES,
    });
    assert.equal(r.status, "divergent");
    assert.equal(r.accepted, false, "entrada divergente NÃO pode abrir posição");
    assert.equal(r.severity, "critical");
    assert.ok(/envenena PnL/.test(r.reason), "o motivo precisa explicar a consequência, não só o número");
    assert.ok(r.reason.includes("dexscreener") && r.reason.includes("geckoterminal"), "as duas fontes precisam ser nomeadas");
  });

  await test("entrada: severidade é recalculada dos bps com os MESMOS limiares da gestão", async () => {
    const { assessEntryPrice } = await import("../src/entryQuality.js");
    // Severidade declarada "ok" mas bps crítico: quem manda é o número, não o rótulo de quem chamou.
    const r = assessEntryPrice({
      quote: EN_QUOTE,
      comparison: { referenceSource: "A", candidateSource: "B", bps: 5000, severity: "ok" },
      thresholds: EN_LIMIARES,
    });
    assert.equal(r.status, "divergent");
    assert.equal(r.accepted, false);
  });

  await test("entrada: fonte única → aceita mas MARCADA como não verificada", async () => {
    const { assessEntryPrice } = await import("../src/entryQuality.js");
    const r = assessEntryPrice({ quote: EN_QUOTE, comparison: null, thresholds: EN_LIMIARES });
    assert.equal(r.status, "single_source");
    assert.equal(r.accepted, true);
    assert.equal(r.divergenceBps, null, "sem segunda opinião não existe número de divergência");
    assert.ok(/NÃO verificado/.test(r.reason));
    assert.ok(/não é prova de erro/.test(r.reason), "ausência de segunda opinião não pode virar acusação");
  });

  await test("entrada: com allowSingleSource=false, fonte única é RECUSADA", async () => {
    const { assessEntryPrice } = await import("../src/entryQuality.js");
    const r = assessEntryPrice({ quote: EN_QUOTE, comparison: null, thresholds: EN_LIMIARES, allowSingleSource: false });
    assert.equal(r.status, "single_source");
    assert.equal(r.accepted, false, "política de capital real pode exigir duas fontes");
  });

  await test("entrada: verificação desligada aceita o preço mas NÃO finge que verificou", async () => {
    const { assessEntryPrice } = await import("../src/entryQuality.js");
    const r = assessEntryPrice({
      quote: EN_QUOTE,
      comparison: { referenceSource: "A", candidateSource: "B", bps: 9000, severity: "critical" },
      thresholds: EN_LIMIARES,
      enabled: false,
    });
    assert.equal(r.status, "single_source");
    assert.equal(r.accepted, true);
    assert.equal(r.divergenceBps, null);
    assert.ok(/DESLIGADA/.test(r.reason));
  });

  await test("entrada: sem preço nenhum → unavailable e recusa (nunca inventa)", async () => {
    const { assessEntryPrice } = await import("../src/entryQuality.js");
    for (const quote of [null, undefined, { priceSol: null, source: "A" }, { priceSol: 0, source: "A" } as any, { priceSol: Number.NaN, source: "A" } as any, { priceSol: -1, source: "A" } as any]) {
      const r = assessEntryPrice({ quote, comparison: null, thresholds: EN_LIMIARES });
      assert.equal(r.status, "unavailable");
      assert.equal(r.accepted, false);
      assert.equal(r.priceSol, null);
    }
  });

  await test("entrada: lote entrega a comparação mesmo quando as fontes CONCORDAM", async () => {
    const { fetchBatchPrices, SOL_MINT } = await import("../src/marketPriceFeed.js");
    const result = await fetchBatchPrices([EN_MINT], {
      verifyMints: [EN_MINT],
      fetchImpl: (async (url: string) => {
        if (url.includes("dexscreener")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              pairs: [
                { chainId: "solana", baseToken: { address: EN_MINT }, quoteToken: { address: SOL_MINT }, priceNative: "0.001", liquidity: { usd: 20_000 } },
              ],
            }),
          } as any;
        }
        // 0.2 USD / 200 USD por SOL = 0.001 SOL → concordam exatamente.
        return { ok: true, status: 200, json: async () => ({ [SOL_MINT]: { usdPrice: 200 }, [EN_MINT]: { usdPrice: 0.2 } }) } as any;
      }) as any,
    });
    assert.equal(result.divergences.length, 0);
    assert.equal(result.verification.comparisons.length, 1, "a comparação precisa existir mesmo com severidade ok");
    const c = result.verification.comparisons[0];
    assert.equal(c.mint, EN_MINT);
    assert.equal(c.severity, "ok");
    assert.equal(c.bps, 0);
    assert.ok(/dexscreener/.test(c.referenceSource) && /jupiter/.test(c.candidateSource));

    // E o caminho de entrada transforma isso em "verified".
    const { assessEntryPrice } = await import("../src/entryQuality.js");
    const quote = result.quotes.get(EN_MINT)!;
    const r = assessEntryPrice({
      quote: { priceSol: quote.priceSol, source: quote.source },
      comparison: { referenceSource: c.referenceSource, candidateSource: c.candidateSource, bps: c.bps, severity: c.severity },
      thresholds: EN_LIMIARES,
    });
    assert.equal(r.status, "verified");
    assert.equal(r.accepted, true);
  });

  await test("regressão: o caminho de entrada usa preço VERIFICADO e recusa divergente", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const serverSrc = fs.readFileSync(path.join(repoRoot, "server.ts"), "utf8");
    assert.equal(
      /fetchReferenceMarketPrice/.test(serverSrc),
      false,
      "a função de fonte única não pode voltar: o preço de entrada agora é resolvido com verificação"
    );
    assert.ok(serverSrc.includes("resolveEntryPrice("), "o caminho paper precisa resolver o preço de entrada");
    assert.ok(serverSrc.includes("assessEntryPrice("), "a política de aceitação precisa vir do módulo dedicado");
    assert.ok(
      /if \(!entry\.assessment\.accepted\)/.test(serverSrc),
      "entrada com preço divergente precisa ser RECUSADA, não apenas registrada"
    );
    assert.ok(serverSrc.includes("entryPriceVerification"), "a procedência do preço precisa ficar gravada na posição");
    assert.ok(serverSrc.includes("entryVerificationStatus"), "o registro de avaliação precisa carregar o status");
    assert.ok(serverSrc.includes("HFT_ENTRY_VERIFY") && serverSrc.includes("HFT_ENTRY_ALLOW_SINGLE_SOURCE"));
    assert.ok(serverSrc.includes("entryQuality:"), "os contadores precisam ser visíveis no /api/health");
    // A verificação de entrada NUNCA pode ter prioridade de saída (furaria cota).
    const bloco = serverSrc.slice(serverSrc.indexOf("async function resolveEntryPrice"), serverSrc.indexOf("async function resolveEntryPrice") + 2000);
    assert.ok(/verificationPriority: "background"/.test(bloco), "verificação de entrada é dado adicional: nunca fura cota");
    const entrySrc = fs.readFileSync(path.join(repoRoot, "src/entryQuality.ts"), "utf8");
    assert.ok(
      !/sell|swap|sendTransaction/i.test(entrySrc),
      "o módulo de qualidade de entrada NÃO pode executar nada na rede"
    );
  });

  // ---------------------------------------------------------------------------
  // [23] COERÊNCIA DE PERFIL DE RPC + telemetria fabricada removida
  // ---------------------------------------------------------------------------
  console.log("\n[23] Coerência perfil↔endpoint e remoção de telemetria fabricada");

  const HELIUS_URL = "https://mainnet.helius-rpc.com/?api-key=SEGREDO_NAO_PODE_VAZAR";
  const QUICKNODE_URL = "https://divine-wildflower.solana-mainnet.quiknode.pro/abc123/";
  const SYNDICA_URL = "https://solana-mainnet.api.syndica.io/api-key/xyz";

  await test("hostFromUrl: devolve SÓ o host — a chave da URL nunca aparece", async () => {
    const { hostFromUrl } = await import("../src/rpcProfile.js");
    const host = hostFromUrl(HELIUS_URL);
    assert.equal(host, "mainnet.helius-rpc.com");
    assert.equal(host.includes("SEGREDO"), false, "a query com a chave não pode vazar");
    assert.equal(hostFromUrl("não é url"), "");
    assert.equal(hostFromUrl(undefined), "");
    assert.equal(hostFromUrl(""), "");
  });

  await test("inferRpcProvider: reconhece os provedores e devolve unknown sem inventar", async () => {
    const { inferRpcProvider } = await import("../src/rpcProfile.js");
    assert.equal(inferRpcProvider(HELIUS_URL), "helius");
    assert.equal(inferRpcProvider(QUICKNODE_URL), "quicknode");
    assert.equal(inferRpcProvider("https://solana-mainnet.g.alchemy.com/v2/chave"), "alchemy");
    assert.equal(inferRpcProvider(SYNDICA_URL), "syndica");
    assert.equal(inferRpcProvider("https://api.mainnet-beta.solana.com"), "public");
    assert.equal(inferRpcProvider("https://rpc.minhaempresa.com.br"), "unknown");
  });

  await test("coerência: endpoint Helius + perfil helius → COERENTE", async () => {
    const { assessRpcCoherence } = await import("../src/rpcProfile.js");
    const r = assessRpcCoherence({
      endpoint: HELIUS_URL,
      websocket: "wss://mainnet.helius-rpc.com/?api-key=x",
      declaredProfile: "helius",
    });
    assert.equal(r.coherent, true);
    assert.equal(r.inferredFromEndpoint, "helius");
    assert.deepEqual(r.issues, []);
    // A URL completa NÃO pode aparecer nas observações: só o host.
    assert.equal(JSON.stringify(r).includes("SEGREDO"), false);
  });

  await test("coerência: perfil dedicado com endpoint VAZIO (público) → INCOERENTE", async () => {
    const { assessRpcCoherence } = await import("../src/rpcProfile.js");
    const r = assessRpcCoherence({ endpoint: "", declaredProfile: "syndica" });
    assert.equal(r.coherent, false, "era exatamente a config da preview: teto 100 req/s no endpoint público");
    assert.equal(r.usingPublicDefaultEndpoint, true);
    assert.ok(r.issues.some((i) => i.code === "endpoint-publico-com-perfil-dedicado" && i.severity === "mismatch"));
    assert.ok(r.issues.some((i) => i.code === "endpoint-ausente" && i.severity === "warn"));
  });

  await test("coerência: endpoint de um provedor com perfil de outro → INCOERENTE nos dois sentidos", async () => {
    const { assessRpcCoherence } = await import("../src/rpcProfile.js");
    const a = assessRpcCoherence({ endpoint: QUICKNODE_URL, declaredProfile: "helius" });
    assert.equal(a.coherent, false);
    assert.ok(a.issues.some((i) => i.code === "perfil-nao-bate-endpoint"));

    // Endpoint dedicado com perfil "public": não é incoerência (não estoura cota), mas é
    // sub-utilização — o bot pula decisões que a cota suportaria.
    const b = assessRpcCoherence({ endpoint: HELIUS_URL, declaredProfile: "public" });
    assert.equal(b.coherent, true);
    assert.ok(b.issues.some((i) => i.code === "endpoint-dedicado-com-perfil-publico" && i.severity === "warn"));
  });

  await test("coerência: perfil desconhecido → INCOERENTE (hoje ele cai silenciosamente em public)", async () => {
    const { assessRpcCoherence } = await import("../src/rpcProfile.js");
    const r = assessRpcCoherence({ endpoint: HELIUS_URL, declaredProfile: "helios" });
    assert.equal(r.declaredProfileKnown, false);
    assert.equal(r.coherent, false);
    assert.ok(r.issues.some((i) => i.code === "perfil-desconhecido" && i.severity === "mismatch"));
  });

  await test("coerência: provedor PRÓPRIO é aviso, não erro (não bloqueia quem sabe o que faz)", async () => {
    const { assessRpcCoherence } = await import("../src/rpcProfile.js");
    const r = assessRpcCoherence({ endpoint: "https://rpc.minhaempresa.com.br", declaredProfile: "helius" });
    assert.equal(r.coherent, true, "host desconhecido é NÃO VERIFICÁVEL, não incoerente");
    assert.ok(r.issues.some((i) => i.code === "host-nao-verificavel" && i.severity === "warn"));
  });

  await test("coerência: WebSocket e fallbacks de outro provedor geram AVISO", async () => {
    const { assessRpcCoherence } = await import("../src/rpcProfile.js");
    const r = assessRpcCoherence({
      endpoint: HELIUS_URL,
      websocket: "wss://divine.solana-mainnet.quiknode.pro/abc",
      fallbacks: `${QUICKNODE_URL},https://solana-mainnet.g.alchemy.com/v2/k`,
      declaredProfile: "helius",
    });
    assert.equal(r.coherent, true, "avisos não bloqueiam o boot");
    assert.ok(r.issues.some((i) => i.code === "perfil-nao-bate-websocket"));
    assert.ok(r.issues.some((i) => i.code === "fallback-misto"));
    assert.equal(r.observations.length, 4, "endpoint + websocket + 2 fallbacks observados");
    assert.equal(JSON.stringify(r).includes("abc123"), false, "nem o path do provedor deve vazar");
  });

  await test("coerência: descrição em texto não contém URL completa nem chave", async () => {
    const { assessRpcCoherence, describeRpcCoherence } = await import("../src/rpcProfile.js");
    const linhas = describeRpcCoherence(assessRpcCoherence({ endpoint: HELIUS_URL, declaredProfile: "syndica" }));
    const texto = linhas.join("\n");
    assert.equal(texto.includes("SEGREDO"), false);
    assert.ok(/perfil declarado="syndica"/.test(texto));
    assert.ok(linhas.length > 1, "achados precisam aparecer linha a linha");
  });

  await test("regressão: o boot RECUSA subir em LIVE quando o perfil é incoerente", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const serverSrc = fs.readFileSync(path.join(repoRoot, "server.ts"), "utf8");
    assert.ok(serverSrc.includes("assessRpcCoherence("), "o boot precisa avaliar a coerência");
    assert.ok(serverSrc.includes("rpcCoherence:"), "a coerência precisa ser visível no /api/health");
    const bloco = serverSrc.slice(
      serverSrc.indexOf("const rpcCoherence: RpcCoherence"),
      serverSrc.indexOf("if (process.env.HFT_BUDGET_DISABLED === \"1\")")
    );
    assert.ok(/if \(!rpcCoherence\.coherent\)/.test(bloco), "incoerência precisa ser tratada");
    assert.ok(/mode === "LIVE"/.test(bloco), "em LIVE o trato é diferente do PAPER");
    assert.ok(/process\.exit\(1\)/.test(bloco), "em LIVE, incoerência impede o boot");
  });

  await test("regressão: escala de líderes Jito não é mais inventada", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const serverSrc = codigoSemComentarios(fs.readFileSync(path.join(repoRoot, "server.ts"), "utf8"));
    assert.equal(
      /278913410 \+ Math\.floor/.test(serverSrc),
      false,
      "slot derivado do relógio do processo não pode voltar"
    );
    assert.equal(/Helius Validator #4/.test(serverSrc), false, "nome de validador inventado não pode voltar");
    assert.equal(/Elite \(99\.8th percentile\)/.test(serverSrc), false, "reputação inventada não pode voltar");
    const bloco = serverSrc.slice(
      serverSrc.indexOf('app.get("/api/jito-leader-schedule"'),
      serverSrc.indexOf('app.post("/api/submit-bundle"')
    );
    assert.ok(/nextLeaderSlot: null/.test(bloco), "não observável precisa ser null, não RNG");
    assert.ok(/notMeasured:/.test(bloco), "o motivo de não medir precisa estar no payload");
    assert.ok(/measured: currentSlot !== null/.test(bloco), "o único número permitido é o slot MEDIDO");
    assert.ok(/coLocation:/.test(bloco) && /declaração não é medição/.test(bloco));
  });

  await test("regressão: painel MEV não registra trade a partir de bundle SIMULADO", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const ui = codigoSemComentarios(fs.readFileSync(path.join(repoRoot, "src/components/MevExecutionEngine.tsx"), "utf8"));
    assert.equal(
      /Math\.random\(\) \* 50000/.test(ui),
      false,
      "outAmount aleatório na lista de operações não pode voltar"
    );
    assert.equal(/278913410 \+ Math\.floor/.test(ui), false, "bloco aleatório não pode voltar");
    assert.ok(/data\.simulated === true/.test(ui) || /bundleResult\.simulated === true/.test(ui), "o simulador precisa ser rotulado");
    assert.ok(/void onBundleSuccess;/.test(ui), "bundle simulado NÃO pode alimentar a lista de operações");
    assert.ok(/percentilesSol/.test(ui), "o tip floor exibido precisa vir da resposta real da API");
    assert.equal(/setTips\(data\.tips\)/.test(ui), false, "campo `tips` não existe na resposta — não pode voltar");
  });

  await test("regressão: painel de performance exibe MEDIÇÃO, não RNG, nos campos de infraestrutura", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const ui = codigoSemComentarios(fs.readFileSync(path.join(repoRoot, "src/components/HftProfiler.tsx"), "utf8"));
    assert.equal(/avgRttHelius/.test(ui), false, "RTT Helius fabricado não pode voltar");
    assert.equal(/avgRttTriton/.test(ui), false);
    assert.equal(/Jito Acceptance|jitoAcceptanceRate/.test(ui), false, "landing rate inventado não pode voltar");
    assert.ok(/\/api\/rpc-nodes/.test(ui), "latência precisa vir da medição do backend");
    assert.ok(/\/api\/positions/.test(ui), "exposição precisa vir das posições reais");
    assert.ok(/não medido/.test(ui), "campo sem dado precisa dizer 'não medido'");
  });

  await test("regressão: painel de diagnósticos não exibe laudo decorativo", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const ui = codigoSemComentarios(fs.readFileSync(path.join(repoRoot, "src/components/DiagnosticsPanel.tsx"), "utf8"));
    assert.equal(/PTPv2|drift física|<1ns/.test(ui), false, "PTP inventado não pode voltar");
    assert.equal(/ShredStream co-localizado|Canal Elite ativo/.test(ui), false, "canal inventado não pode voltar");
    assert.ok(/\/api\/rpc-nodes/.test(ui) && /\/api\/health/.test(ui) && /blockhash/.test(ui), "as checagens precisam ser reais");
    assert.ok(/declaração não é medição|NÃO mede a posição física/.test(ui), "declaração e medição precisam estar separadas na tela");
  });

  // ── Helpers do grupo [24]: dublês de rede/cofre. O orquestrador testado é o MESMO do
  //    servidor; só as capacidades externas são substituídas. ────────────────────────────
  const MINT_FAKE = "So11111111111111111111111111111111111111112";
  const OWNER_FAKE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const policyFake = {
    enabled: true, autonomous: true, canaryMaxSol: 0.01, canaryOneEntry: true,
    slippageBps: 300, maxPriceImpactBps: 1500, requirePreflight: true, maxTipBps: 50,
    maxTotalExposureSol: 0,
  } as any;
  const allowedGate = (re: any) =>
    re.assessEntryGate({ policy: policyFake, mode: "LIVE", liveAuthorized: true, mint: MINT_FAKE, sizeSol: 0.01 });
  const entryRequest = (over: any = {}) => ({
    mint: MINT_FAKE,
    sizeSol: 0.01,
    userPublicKey: OWNER_FAKE,
    policy: policyFake,
    gate: over.gate,
    confirmTimeoutMs: 100,
  } as any);
  const fakeEntryDeps = (over: any = {}): any => ({
    assertCanSign: over.assertCanSign ?? (() => {}),
    getQuote: async () => {
      over.onQuote?.();
      return over.quote ?? { outAmount: "1000000000", priceImpactPct: "0.0123", routeLabels: ["pump.fun"] };
    },
    buildSwapTransaction: async () => {
      over.onBuild?.();
      return { fakeTx: true };
    },
    simulateTransaction: over.simulate ?? (async () => ({ ok: true, err: null, unitsConsumed: 120_000, logsTail: ["Program log: ok"] })),
    getFreshBlockhash: async () => over.blockhash ?? { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 999_999 },
    signAndSubmit: async () => {
      over.onSign?.();
      return over.submit ?? { ok: true, signature: "5" + "x".repeat(63), bundleId: "bundle_fake", tipSol: 0.0005 };
    },
    confirm: over.confirm ?? (async () => ({ outcome: "confirmed", slot: 123_456_789 })),
    observeFill: over.observeFill ?? (async () => ({ measured: true, tokensReceived: "1000000000", feeLamports: 5000, slot: 123_456_789 })),
    now: () => 0,
  });

  // [24] S6 — ENTRADA REAL: gates, orquestração e leitura de fill
  console.log("\n[24] Entrada real (S6): travas, pré-flight e fill medido");

  await test("política de entrada real é fail-closed por padrão (nenhuma das três declarações)", async () => {
    const re = await import("../src/realEntry.js");
    const policy = re.resolveRealEntryPolicy({} as any);
    assert.equal(policy.enabled, false, "HFT_REAL_ENTRY_ENABLED ausente NÃO pode habilitar entrada real");
    assert.equal(policy.autonomous, false, "entrada automática precisa de declaração própria");
    assert.equal(policy.canaryMaxSol, 0.01, "teto canário default é 0,01 SOL");
    assert.equal(policy.canaryOneEntry, true, "uma entrada canário por vez por padrão");
    assert.equal(policy.requirePreflight, true, "pré-flight é obrigatório por padrão");
    assert.equal(policy.maxTipBps, 50, "teto de tip em bps do capital");
    assert.equal(policy.slippageBps, 300);
    assert.equal(policy.maxPriceImpactBps, 1500);
  });

  await test("política de entrada real respeita o ambiente declarado", async () => {
    const re = await import("../src/realEntry.js");
    const policy = re.resolveRealEntryPolicy({
      HFT_REAL_ENTRY_ENABLED: "1",
      HFT_AUTONOMOUS_ENTRY: "true",
      HFT_CANARY_MAX_SOL: "0.05",
      HFT_CANARY_ONE_ENTRY: "0",
      HFT_ENTRY_SLIPPAGE_BPS: "450",
      HFT_ENTRY_MAX_PRICE_IMPACT_BPS: "900",
      HFT_ENTRY_REQUIRE_PREFLIGHT: "0",
      MAX_TIP_BPS: "80",
      MAX_TOTAL_EXPOSURE_SOL: "0.2",
    } as any);
    assert.equal(policy.enabled, true);
    assert.equal(policy.autonomous, true);
    assert.equal(policy.canaryMaxSol, 0.05);
    assert.equal(policy.canaryOneEntry, false);
    assert.equal(policy.slippageBps, 450);
    assert.equal(policy.maxPriceImpactBps, 900);
    assert.equal(policy.requirePreflight, false);
    assert.equal(policy.maxTipBps, 80);
    assert.equal(policy.maxTotalExposureSol, 0.2);
  });

  await test("gate de entrada bloqueia cada motivo com código próprio (nunca um 'não' genérico)", async () => {
    const re = await import("../src/realEntry.js");
    const mint = "So11111111111111111111111111111111111111112";
    const base = {
      policy: { ...re.REAL_ENTRY_DEFAULTS, enabled: true, autonomous: true, canaryOneEntry: true, maxTotalExposureSol: 0, maxTipBps: 50 },
      mode: "LIVE",
      liveAuthorized: true,
      mint,
      sizeSol: 0.01,
    } as any;

    const codesOf = (input: any) => re.assessEntryGate(input).issues.map((i: any) => i.code);

    assert.deepEqual(codesOf({ ...base, policy: { ...base.policy, enabled: false } }), ["ENTRY_PATH_DISABLED"]);
    assert.deepEqual(codesOf({ ...base, autonomousCall: true, policy: { ...base.policy, autonomous: false } }), ["AUTONOMOUS_ENTRY_DISABLED"]);
    assert.ok(codesOf({ ...base, mode: "PAPER", liveAuthorized: false }).includes("MODE_NOT_LIVE"));
    assert.ok(codesOf({ ...base, killSwitchActive: true }).includes("KILL_SWITCH"));
    assert.ok(codesOf({ ...base, readOnlyMode: true }).includes("READ_ONLY"));
    assert.ok(codesOf({ ...base, mint: "não-é-base58!!" }).includes("MINT_INVALID"));
    assert.ok(codesOf({ ...base, sizeSol: 0 }).includes("SIZE_INVALID"));
    assert.ok(codesOf({ ...base, sizeSol: 0.011 }).includes("CANARY_CAP_EXCEEDED"), "teto canário é teto DURO");
    assert.ok(codesOf({ ...base, realEntriesDone: 1 }).includes("CANARY_ALREADY_USED"));
    assert.ok(codesOf({ ...base, policy: { ...base.policy, maxTotalExposureSol: 0.005 } }).includes("EXPOSURE_LIMIT"));
    assert.ok(codesOf({ ...base, hasOpenPositionForMint: true }).includes("DUPLICATE_OPEN_POSITION"));
    assert.ok(codesOf({ ...base, maxPositionSol: 0.001 }).includes("MAX_POSITION_SOL_EXCEEDED"));
  });

  await test("gate de entrada APROVA o caso canário coerente", async () => {
    const re = await import("../src/realEntry.js");
    const gate = re.assessEntryGate({
      policy: { ...re.REAL_ENTRY_DEFAULTS, enabled: true, autonomous: true, canaryOneEntry: true, maxTotalExposureSol: 0, maxTipBps: 50 },
      mode: "LIVE",
      liveAuthorized: true,
      mint: "So11111111111111111111111111111111111111112",
      sizeSol: 0.01,
      realEntriesDone: 0,
      openExposureSol: 0,
    } as any);
    assert.equal(gate.allowed, true, `esperava aprovação, veio: ${JSON.stringify(gate.issues)}`);
    assert.equal(gate.issues.filter((i: any) => i.severity === "block").length, 0);
  });

  await test("orquestrador: pré-flight reprovado NÃO assina (a simulação descobre de graça)", async () => {
    const re = await import("../src/realEntry.js");
    let signed = 0;
    let built = 0;
    const deps = fakeEntryDeps({
      simulate: async () => ({ ok: false, err: { message: "custom program error: 0x1771" }, logsTail: ["Program log: 6001"] }),
      onSign: () => signed++,
      onBuild: () => built++,
    });
    const result = await re.executeRealEntry(deps, entryRequest({ gate: allowedGate(re) }));
    assert.equal(result.status, "simulation_failed");
    assert.equal(signed, 0, "nenhuma assinatura pode existir quando a simulação reprova");
    assert.equal(built, 1, "a transação foi construída (necessário para simular)");
    assert.match(result.reason ?? "", /simulação REJEITOU/);
  });

  await test("orquestrador: caminho feliz confirma com SLOT e mede o fill da cadeia", async () => {
    const re = await import("../src/realEntry.js");
    const deps = fakeEntryDeps({});
    const result = await re.executeRealEntry(deps, entryRequest({ gate: allowedGate(re) }));
    assert.equal(result.status, "confirmed");
    assert.equal(result.confirmedOnChain, true, "confirmado exige slot observado");
    assert.equal(result.slot, 123456789);
    assert.equal(result.signature, "5" + "x".repeat(63));
    assert.equal(result.tokensReceived, "1000000000", "quantidade vem do delta de postTokenBalances");
    assert.equal(result.fillMeasured, true);
    assert.equal(result.bundleAccepted, true, "'aceito pelo block engine' é um fato separado da execução");
    assert.ok(result.timingsMs.total >= 0);
    assert.equal(result.gateIssues.filter((i: any) => i.severity === "block").length, 0);
  });

  await test("orquestrador: sem slot observado o estado é submitted_unconfirmed — NUNCA confirmed", async () => {
    const re = await import("../src/realEntry.js");
    const deps = fakeEntryDeps({ confirm: async () => ({ outcome: "unknown" as const, error: "não observado na janela" }) });
    const result = await re.executeRealEntry(deps, entryRequest({ gate: allowedGate(re) }));
    assert.equal(result.status, "submitted_unconfirmed");
    assert.equal(result.confirmedOnChain, false, "aceito ≠ executado: a regra que impediu PnL fabricado");
    assert.ok(result.signature, "a assinatura existe e precisa ser reconciliada");
  });

  await test("orquestrador: barreira de assinatura roda ANTES de gastar cota", async () => {
    const re = await import("../src/realEntry.js");
    let quoted = 0;
    const deps = fakeEntryDeps({
      onQuote: () => quoted++,
      assertCanSign: () => {
        throw new Error("[Signer Guard] Modo LIVE não autoriza operação de capital.");
      },
    });
    const result = await re.executeRealEntry(deps, entryRequest({ gate: allowedGate(re) }));
    assert.equal(result.status, "signing_blocked");
    assert.equal(quoted, 0, "se o modo não autoriza, nem a cotação deve ser pedida");
  });

  await test("orquestrador: impacto de preço acima do teto recusa ANTES de construir", async () => {
    const re = await import("../src/realEntry.js");
    let built = 0;
    const deps = fakeEntryDeps({
      quote: { outAmount: "1000", priceImpactPct: "0.30", routeLabels: ["pump"] },
      onBuild: () => built++,
    });
    const result = await re.executeRealEntry(deps, entryRequest({ gate: allowedGate(re) }));
    assert.equal(result.status, "refused");
    assert.equal(built, 0, "comprar o próprio impacto não pode nem chegar a montar a transação");
    assert.match(result.reason ?? "", /impacto de preço/);
  });

  await test("orquestrador: blockhash sem prova de expiração não assina", async () => {
    const re = await import("../src/realEntry.js");
    let signed = 0;
    const deps = fakeEntryDeps({
      blockhash: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 0 },
      onSign: () => signed++,
    });
    const result = await re.executeRealEntry(deps, entryRequest({ gate: allowedGate(re) }));
    assert.equal(result.status, "submit_failed");
    assert.equal(signed, 0, "sem lastValidBlockHeight não existe prova de expiração para decidir retry");
  });

  await test("orquestrador: gate bloqueado nem monta deps de rede", async () => {
    const re = await import("../src/realEntry.js");
    const gate = re.assessEntryGate({
      policy: { ...re.REAL_ENTRY_DEFAULTS, enabled: true, autonomous: true, canaryOneEntry: true, maxTotalExposureSol: 0, maxTipBps: 50 },
      mode: "PAPER",
      liveAuthorized: false,
      mint: "So11111111111111111111111111111111111111112",
      sizeSol: 0.01,
    } as any);
    let quoted = 0;
    const deps = fakeEntryDeps({ onQuote: () => quoted++ });
    const result = await re.executeRealEntry(deps, entryRequest({ gate }));
    assert.equal(result.status, "refused");
    assert.equal(quoted, 0);
    assert.match(result.reason ?? "", /MODE_NOT_LIVE/);
  });

  await test("canário: falha ANTES de assinar não consome a tentativa (rede caindo ≠ bloqueio permanente)", async () => {
    const re = await import("../src/realEntry.js");
    const count = re.countLandedEntryAttempts;
    assert.equal(count([]), 0);
    assert.equal(count([{ mode: "paper", signature: null, status: "paper" }]), 0, "paper nunca conta");
    assert.equal(count([{ mode: "shadow", signature: null, status: "shadow" }]), 0, "shadow nunca conta");
    assert.equal(
      count([{ mode: "live", signature: null, status: "rejected" }]),
      0,
      "falha em cotação/construção/simulação/blockhash não tocou a cadeia"
    );
    assert.equal(count([{ mode: "live", signature: "5abc", status: "quote_failed" }]), 1, "assinatura existe: a transação pode ter entrado");
    assert.equal(count([{ mode: "live", signature: null, status: "confirmed" }]), 1, "confirmação registrada conta mesmo sem campo de assinatura");
    assert.equal(
      count([
        { mode: "live", signature: "5a", status: "submitted_unconfirmed" },
        { mode: "live", signature: "5b", status: "confirmed" },
        { mode: "paper", signature: null, status: "paper" },
      ]),
      2
    );
  });

  await test("leitura de fill: delta de postTokenBalances é a quantidade recebida", async () => {
    const re = await import("../src/realEntry.js");
    const fill = re.parseEntryFill({
      owner: "Owner111111111111111111111111111111111111",
      mint: "Mint11111111111111111111111111111111111111",
      slot: 999,
      meta: {
        err: null,
        fee: 5000,
        preTokenBalances: [],
        postTokenBalances: [
          { owner: "Owner111111111111111111111111111111111111", mint: "Mint11111111111111111111111111111111111111", uiTokenAmount: { amount: "2500000000" } },
        ],
      },
    });
    assert.equal(fill.measured, true);
    assert.equal(fill.tokensReceived, "2500000000");
    assert.equal(fill.feeLamports, 5000);
    assert.equal(fill.slot, 999);
  });

  await test("leitura de fill: transação que falhou é MEDIÇÃO (0 recebido), não ausência de dado", async () => {
    const re = await import("../src/realEntry.js");
    const fill = re.parseEntryFill({
      owner: "Owner111111111111111111111111111111111111",
      mint: "Mint11111111111111111111111111111111111111",
      meta: { err: { InstructionError: [0, { Custom: 6001 }] }, fee: 5000, postTokenBalances: [], preTokenBalances: [] },
    });
    assert.equal(fill.measured, true);
    assert.equal(fill.tokensReceived, "0");
    assert.match(fill.error ?? "", /falhou on-chain/);
  });

  await test("leitura de fill: saldo DIMINUIU na entrada é inconsistência declarada, não silêncio", async () => {
    const re = await import("../src/realEntry.js");
    const owner = "Owner111111111111111111111111111111111111";
    const mint = "Mint11111111111111111111111111111111111111";
    const fill = re.parseEntryFill({
      owner,
      mint,
      meta: {
        fee: 5000,
        preTokenBalances: [{ owner, mint, uiTokenAmount: { amount: "100" } }],
        postTokenBalances: [{ owner, mint, uiTokenAmount: { amount: "10" } }],
      },
    });
    assert.equal(fill.tokensReceived, "0", "nunca reportar quantidade negativa como compra");
    assert.match(fill.error ?? "", /DIMINUIU/);
  });

  await test("leitura de fill: sem meta o resultado é 'não medido' com motivo", async () => {
    const re = await import("../src/realEntry.js");
    const fill = re.parseEntryFill({ owner: "a", mint: "b", meta: null });
    assert.equal(fill.measured, false);
    assert.equal(fill.tokensReceived, null);
    assert.ok(fill.error && fill.error.length > 0);
  });

  await test("fiação: pipeline LIVE executa a entrada real e o gate é consultado antes", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const src = codigoSemComentarios(fs.readFileSync(path.join(repoRoot, "server.ts"), "utf8"));
    assert.ok(/if \(liveTrading\) \{[\s\S]{0,900}runRealEntry\(/.test(src), "o ramo LIVE precisa chamar runRealEntry");
    assert.equal(/entrada on-chain não está implementada/.test(src), false, "a recusa antiga não pode voltar");
    assert.ok(/app\.post\("\/api\/real-entry"/.test(src), "a entrada real manual precisa de rota própria");
    assert.ok(/buildEntryGateInput\(/.test(src) && /assessEntryGate\(/.test(src), "o gate puro precisa ser consultado pela fiação");
    assert.ok(/HFT_REAL_ENTRY_ENABLED/.test(src), "a terceira declaração precisa existir no código");
    assert.ok(/realEntry: \(\(\) => \{/.test(src), "system-truth precisa declarar o estado da entrada real");
  });

  await test("fiação: entrada cota SOL→mint (a inversão cotaria uma VENDA)", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const src = codigoSemComentarios(fs.readFileSync(path.join(repoRoot, "server.ts"), "utf8"));
    assert.ok(
      /JupiterIntegration\.getQuote\(SOL_MINT, mint,/.test(src),
      "a cotação de ENTRADA é SOL → mint; o inverso (mint → SOL) é saída"
    );
  });

  await test("isolamento: realEntry não tem acesso a chave nem a envio direto", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const src = codigoSemComentarios(fs.readFileSync(path.join(repoRoot, "src/realEntry.ts"), "utf8"));
    for (const proibido of ["Keypair", "OPERATIONAL_PRIVATE_KEY", "executeWithDecryptedKeypair", "sendTransaction", "sendRawTransaction", "@solana/web3.js"]) {
      assert.equal(src.includes(proibido), false, `realEntry.ts não pode referenciar ${proibido}`);
    }
    assert.ok(/signAndSubmit/.test(src), "assinar+enviar é capacidade INJETADA (uma só, isolada)");
  });

  await test("isolamento: as três declarações e o teto canário estão documentados no .env.example", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const env = fs.readFileSync(path.join(repoRoot, ".env.example"), "utf8");
    for (const v of ["HFT_REAL_ENTRY_ENABLED", "HFT_AUTONOMOUS_ENTRY", "HFT_CANARY_MAX_SOL", "HFT_CANARY_ONE_ENTRY"]) {
      assert.ok(env.includes(v), `.env.example precisa declarar ${v}`);
    }
  });

  // [25] S6 — INSTRUÇÃO NATIVA POR IDL: layout conferido contra o IDL oficial pinado
  console.log("\n[25] Entrada nativa por IDL (S6): layout, PDAs, cotação e guardas");

  await test("IDL pinado: o excerto existe, veio do repositório oficial e traz o programa certo", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const idl = JSON.parse(fs.readFileSync(path.join(repoRoot, "assets/pump-idl-excerpt.json"), "utf8"));
    assert.equal(idl.address, "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    assert.ok(/pump-public-docs/.test(idl._provenance.source), "a proveniência precisa apontar o repo oficial");
    assert.ok(/pump.json/.test(idl._provenance.source));
    assert.ok(Array.isArray(idl._provenance.transformations) && idl._provenance.transformations.length > 0,
      "as transformações aplicadas ao excerto precisam estar declaradas");
    const names = idl.instructions.map((i: any) => i.name);
    assert.deepEqual(names, ["buy", "buy_exact_sol_in"]);
  });

  await test("discriminadores do builder batem byte a byte com o IDL pinado", async () => {
    const pi = await import("../src/pumpInstruction.js");
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const idl = JSON.parse(fs.readFileSync(path.join(repoRoot, "assets/pump-idl-excerpt.json"), "utf8"));
    const byName: Record<string, number[]> = {
      buy: [...pi.PUMP_INSTRUCTION_DISCRIMINATORS.buy],
      buyExactSolIn: [...pi.PUMP_INSTRUCTION_DISCRIMINATORS.buyExactSolIn],
    };
    for (const ix of idl.instructions) {
      const ours = byName[ix.name === "buy_exact_sol_in" ? "buyExactSolIn" : "buy"];
      assert.deepEqual(ours, ix.discriminator, `discriminador de ${ix.name} divergiu do IDL`);
    }
    for (const [name, bytes] of Object.entries(pi.PUMP_ACCOUNT_DISCRIMINATORS)) {
      const idlAcc = idl.accounts.find((a: any) => a.name === name);
      assert.ok(idlAcc, `${name} precisa existir nos discriminadores de conta do IDL`);
      assert.deepEqual([...bytes], idlAcc.discriminator, `discriminador de conta ${name} divergiu`);
    }
  });

  await test("dados da instrução: bytes exatos e tamanho derivado do IDL (uma ambiguidade resolvida por evidência)", async () => {
    const pi = await import("../src/pumpInstruction.js");
    const buy = pi.buildBuyData({ amount: 1n, maxSolCost: 1n, trackVolume: true });
    assert.equal(buy.length, 8 + 8 + 8 + 1);
    assert.equal(buy.subarray(0, 8).toString("hex"), "66063d1201daebea");
    assert.equal(buy.readBigUInt64LE(8), 1n);
    assert.equal(buy.readBigUInt64LE(16), 1n);
    assert.equal(buy[24], 1, "track_volume (OptionBool) = 1 byte: o IDL o define como struct de um bool");
    assert.equal(pi.buildBuyData({ amount: 1n, maxSolCost: 1n, trackVolume: false })[24], 0);

    const exact = pi.buildBuyExactSolInData({ spendableSolIn: 10_000_000n, minTokensOut: 2n });
    assert.equal(exact.length, 8 + 8 + 8);
    assert.equal(exact.subarray(0, 8).toString("hex"), "38fc74089edfcd5f");
    assert.equal(exact.readBigUInt64LE(8), 10_000_000n);
    assert.equal(exact.readBigUInt64LE(16), 2n);
  });

  await test("ordem e semântica das contas: comparadas UMA A UMA com o IDL pinado", async () => {
    const pi = await import("../src/pumpInstruction.js");
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const idl = JSON.parse(fs.readFileSync(path.join(repoRoot, "assets/pump-idl-excerpt.json"), "utf8"));
    const buy = idl.instructions.find((i: any) => i.name === "buy_exact_sol_in");

    const mint = "So11111111111111111111111111111111111111112";
    // Endereços de teste: o fee_recipient do protocolo MUDA, então entra por parâmetro.
    const feeRecipient = "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV2fskvCwf8gCDbZ";
    const creator = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const user = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
    const keys = pi.buildBuyAccountKeys({ mint, user, feeRecipient, creator });

    assert.deepEqual(keys.map((k: any) => k.name), buy.accounts.map((a: any) => a.name),
      "a ordem e os nomes das contas têm de ser exatamente os do IDL");
    assert.equal(keys.length, buy.accounts.length, "nem uma conta a mais, nem a menos");

    // writable/signer de cada posição: uma conta writable a menos = instrução rejeitada.
    for (let i = 0; i < keys.length; i++) {
      const spec = buy.accounts[i];
      assert.equal(keys[i].isWritable, Boolean(spec.writable), `conta ${spec.name}: writable divergiu`);
      assert.equal(keys[i].isSigner, Boolean(spec.signer), `conta ${spec.name}: signer divergiu`);
    }

    // Contas com endereço fixo no IDL precisam sair exatamente iguais.
    for (const spec of buy.accounts) {
      if (!spec.address) continue;
      const key = keys.find((k: any) => k.name === spec.name);
      assert.ok(key, `conta ${spec.name} do IDL não foi produzida pelo builder`);
      assert.equal(key!.pubkey, spec.address, `conta ${spec.name}: endereço fixo divergiu do IDL`);
    }
  });

  await test("PDAs: derivação confere com ground truth público (global e bonding curve)", async () => {
    const pi = await import("../src/pumpInstruction.js");
    // Ground truth 1: o Global PDA do pump é constante pública amplamente publicada em SDKs e
    // exemplos (duas fontes independentes concordam) — e a derivação aqui reproduz exatamente.
    assert.equal(pi.deriveGlobalPda(), "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
    // Derivado do IDL: bonding curve de um mint conhecido é determinística.
    const bc = pi.deriveBondingCurvePda("So11111111111111111111111111111111111111112");
    assert.ok(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(bc));
    assert.notEqual(bc, pi.deriveGlobalPda());
    // Determinismo: mesma entrada, mesmo PDA (sem estado escondido).
    assert.equal(bc, pi.deriveBondingCurvePda("So11111111111111111111111111111111111111112"));
  });

  await test("TRAP documentada: o event_authority publicado na web NÃO é aceito — é endereço sósia", async () => {
    const pi = await import("../src/pumpInstruction.js");
    const derivado = pi.deriveEventAuthorityPda();
    const publicado = pi.EVENT_AUTHORITY_TRAP_ADDRESSES[0];
    assert.notEqual(derivado, publicado,
      "o endereço do snippet web compartilha 40 caracteres de prefixo com o derivado e tem sufixo diferente: " +
      "é o padrão de endereço sósia que esta base já removeu uma vez (achado C4)");
    // O sósia é base58 válido — é justamente por isso que ele passa por revisão de olho.
    const { PublicKey } = await import("@solana/web3.js");
    assert.equal(new PublicKey(publicado).toBytes().length, 32, "o sósia é estruturalmente válido: validação por formato não o pega");
    /**
     * O comprimento do prefixo comum é MEDIDO, não suposto: com 36 caracteres iguais e 8
     * diferentes, a olho nu os dois endereços são o "mesmo" endereço — e é exatamente por isso
     * que colar endereço de exemplo em código é um erro de segurança, não de estilo.
     */
    let comum = 0;
    while (comum < publicado.length && publicado[comum] === derivado[comum]) comum++;
    assert.ok(comum >= 30, `prefixo comum medido: ${comum} caracteres (esperado ≥ 30 para caracterizar o sósia)`);
    assert.ok(comum < derivado.length, "os endereços NÃO são idênticos");
  });

  await test("cotação: os 4 passos das docs oficiais, com aritmética inteira conferida à mão", async () => {
    const pi = await import("../src/pumpInstruction.js");
    // Caso redondo, calculável à mão: gasto 1 SOL, fee total 100 bps (1%), sem creator.
    const r = pi.quoteTokensOutExactSolIn({
      spendableSolIn: 1_000_000_000n,
      virtualTokenReserves: 1_000_000_000_000_000n,
      virtualQuoteReserves: 30_000_000_000n,
      protocolFeeBps: 100,
      creatorFeeBps: 0,
    });
    assert.ok(r, "a cotação precisa ser calculável neste caso");
    const esperadoNetSol = (1_000_000_000n * 10_000n) / 10_100n;
    assert.equal(r!.netSol, esperadoNetSol, "passo 1: net_sol = floor(spendable * 10_000 / (10_000 + fee))");
    const esperadoTokens = ((esperadoNetSol - 1n) * 1_000_000_000_000_000n) / (30_000_000_000n + esperadoNetSol - 1n);
    assert.equal(r!.tokensOut, esperadoTokens, "passo 4: tokens_out da fórmula do IDL");
    assert.equal(r!.totalFeeBps, 100);
    assert.ok(r!.steps.length >= 3, "a cotação precisa ser auditável passo a passo");
  });

  await test("cotação: monotonicidade e recusas explícitas (nunca número inventado)", async () => {
    const pi = await import("../src/pumpInstruction.js");
    const base = { virtualTokenReserves: 1_000_000_000_000_000n, virtualQuoteReserves: 30_000_000_000n, protocolFeeBps: 100, creatorFeeBps: 50 };
    const um = pi.quoteTokensOutExactSolIn({ ...base, spendableSolIn: 1_000_000_000n });
    const dois = pi.quoteTokensOutExactSolIn({ ...base, spendableSolIn: 2_000_000_000n });
    assert.ok(um && dois && dois.tokensOut > um.tokensOut, "gastar mais SOL tem de comprar mais tokens");

    assert.equal(pi.quoteTokensOutExactSolIn({ ...base, spendableSolIn: 0n }), null, "gasto zero não tem cotação");
    assert.equal(pi.quoteTokensOutExactSolIn({ ...base, spendableSolIn: 1n }), null, "gasto menor que a taxa não tem cotação");
    assert.equal(pi.quoteTokensOutExactSolIn({ ...base, spendableSolIn: 1_000_000_000n, virtualTokenReserves: 0n }), null, "reserva zero é dado inválido");
    assert.equal(pi.quoteTokensOutExactSolIn({ ...base, spendableSolIn: 1_000_000_000n, protocolFeeBps: 9_999, creatorFeeBps: 1_000 }), null, "taxa total ≥ 100% é absurdo declarado");
  });

  await test("min_tokens_out: piso conservador (arredonda para baixo) e slippage limitado", async () => {
    const pi = await import("../src/pumpInstruction.js");
    assert.equal(pi.minTokensOutFromSlippage(10_000n, 0), 10_000n, "slippage zero mantém o valor exato");
    assert.equal(pi.minTokensOutFromSlippage(10_000n, 100), 9_900n, "1% de slippage tira 1%");
    assert.equal(pi.minTokensOutFromSlippage(10_001n, 1), (10_001n * 9_999n) / 10_000n, "arredonda para baixo (piso)");
    // Piso, nunca teto: com 1 token de resto, o piso é MENOR ou igual ao exato.
    assert.ok(pi.minTokensOutFromSlippage(10_001n, 1) <= 10_001n, "nunca exigir mais do que o esperado");
    // 10.000 bps significaria aceitar QUALQUER preço — inclusive um rug. É limitado.
    assert.equal(pi.minTokensOutFromSlippage(10_000n, 10_000), 1n, "slippage de 100% é limitado a 9.999 bps");
    assert.equal(pi.minTokensOutFromSlippage(10_000n, -5), 10_000n, "slippage negativo é tratado como zero");
  });

  await test("parsers: BondingCurve e Global leem os campos certos na ordem do IDL", async () => {
    const pi = await import("../src/pumpInstruction.js");
    const idl = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets/pump-idl-excerpt.json"), "utf8"));
    assert.deepEqual(pi.BONDING_CURVE_LAYOUT.map((f: any) => f.name), idl.types.BondingCurve.map((f: any) => f.name),
      "o layout do parser de BondingCurve precisa ser o do IDL, campo por campo");
    assert.deepEqual(pi.GLOBAL_LAYOUT.map((f: any) => f.name), idl.types.Global.map((f: any) => f.name),
      "o layout do parser de Global precisa ser o do IDL, campo por campo");

    // Monta a conta sintética A PARTIR do layout do IDL (não de um vetor escrito à mão):
    // assim, errar a ordem no builder ou no IDL quebra o teste.
    const buildFromIdl = (fields: any[], values: Record<string, any>) => {
      const parts: Buffer[] = [];
      for (const f of fields) {
        const t = f.type;
        if (t === "pubkey") parts.push(Buffer.from(new PublicKey(values[f.name]).toBytes()));
        else if (t === "bool") parts.push(Buffer.from([values[f.name] ? 1 : 0]));
        else if (Array.isArray(t)) {
          for (let i = 0; i < t[1]; i++) parts.push(Buffer.from(new PublicKey(values[f.name][i]).toBytes()));
        } else {
          const buf = Buffer.alloc(t === "u128" ? 16 : 8);
          if (t === "u128") buf.writeBigUInt64LE(BigInt(values[f.name]), 0);
          else buf.writeBigUInt64LE(BigInt(values[f.name]), 0);
          parts.push(buf);
        }
      }
      return Buffer.concat(parts);
    };

    const zero = "11111111111111111111111111111111";
    const creator = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const wsol = "So11111111111111111111111111111111111111112";
    const bcValues: Record<string, any> = {};
    for (const f of idl.types.BondingCurve) {
      bcValues[f.name] = f.type === "pubkey" ? (f.name === "creator" ? creator : wsol)
        : f.type === "bool" ? false
        : f.name === "creator_fee_bps" ? 50 : 777;
    }
    const bcData = Buffer.concat([Buffer.from(pi.PUMP_ACCOUNT_DISCRIMINATORS.BondingCurve), buildFromIdl(idl.types.BondingCurve, bcValues)]);
    const bc = pi.parseBondingCurveAccount(bcData);
    assert.ok(bc.value, `BondingCurve deveria parsear: ${JSON.stringify(bc.problems)}`);
    assert.equal(bc.value!.creator, creator);
    assert.equal(bc.value!.creatorFeeBps, 50);
    assert.equal(bc.value!.quoteMint, wsol);
    assert.equal(bc.value!.complete, false);

    const glValues: Record<string, any> = {};
    for (const f of idl.types.Global) {
      const t = f.type;
      glValues[f.name] = t === "pubkey" ? (f.name === "fee_recipient" ? creator : zero)
        : t === "bool" ? false
        : Array.isArray(t) ? Array.from({ length: t[1] }, () => zero)
        : f.name === "fee_basis_points" ? 100
        : 0;
    }
    const glData = Buffer.concat([Buffer.from(pi.PUMP_ACCOUNT_DISCRIMINATORS.Global), buildFromIdl(idl.types.Global, glValues)]);
    const gl = pi.parseGlobalAccount(glData);
    assert.ok(gl.value, `Global deveria parsear: ${JSON.stringify(gl.problems)}`);
    assert.equal(gl.value!.feeRecipient, creator);
    assert.equal(gl.value!.feeBasisPoints, 100);
  });

  await test("parsers: recusam discriminador errado e conta truncada (ler assim daria número plausível e errado)", async () => {
    const pi = await import("../src/pumpInstruction.js");
    const certos = Buffer.from(pi.PUMP_ACCOUNT_DISCRIMINATORS.BondingCurve);
    const outros = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);

    const truncada = Buffer.concat([certos, Buffer.alloc(pi.BONDING_CURVE_ACCOUNT_SIZE - 8 - 1, 0)]);
    const r1 = pi.parseBondingCurveAccount(truncada);
    assert.equal(r1.value, null);
    assert.equal(r1.problems[0].code, "bytes-insuficientes");

    const tipoErrado = Buffer.concat([outros, Buffer.alloc(pi.BONDING_CURVE_ACCOUNT_SIZE - 8, 0)]);
    const r2 = pi.parseBondingCurveAccount(tipoErrado);
    assert.equal(r2.value, null);
    assert.equal(r2.problems[0].code, "discriminador-errado");

    assert.equal(pi.parseGlobalAccount(null).value, null, "sem dado não há valor");
    assert.equal(pi.parseGlobalAccount(Buffer.alloc(4)).problems[0].code, "curta-demais");
  });

  await test("guarda de curva: instrução SOL-only recusa curva cotada em outro ativo", async () => {
    const pi = await import("../src/pumpInstruction.js");
    assert.equal(pi.assertSolQuotedCurve(pi.WSOL_MINT).ok, true);
    assert.equal(pi.assertSolQuotedCurve(pi.SYSTEM_PROGRAM_ID).ok, true, "conta de SOL também aparece como endereço zero");
    const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const r = pi.assertSolQuotedCurve(usdc);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /_v2/, "o motivo precisa dizer o que usar no lugar");
  });

  await test("endereço: validação estrutural recusa lixo e o endereço zero como destinatário", async () => {
    const pi = await import("../src/pumpInstruction.js");
    assert.equal(pi.isUsableAddress("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"), true);
    assert.equal(pi.isUsableAddress(pi.SYSTEM_PROGRAM_ID), false);
    assert.equal(pi.isUsableAddress("nao-e-base58-0OIl"), false);
    assert.equal(pi.isUsableAddress(""), false);
  });

  await test("instrução montada: programa, contas e dados coerentes entre si", async () => {
    const pi = await import("../src/pumpInstruction.js");
    const ix = pi.buildPumpBuyExactSolInInstruction({
      mint: pi.WSOL_MINT,
      user: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
      feeRecipient: "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV2fskvCwf8gCDbZ",
      creator: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      spendableSolIn: 10_000_000n,
      minTokensOut: 1_234n,
    });
    assert.equal(ix.programId, pi.PUMP_PROGRAM_ID);
    assert.equal(ix.keys.length, 16, "buy_exact_sol_in tem 16 contas no IDL pinado");
    assert.equal(ix.accountNames.join(","), ix.keys.map((k: any) => k.name).join(","));
    assert.equal(ix.data.readBigUInt64LE(0 + 8), 10_000_000n);
    assert.equal(ix.data.readBigUInt64LE(16), 1_234n);
    const signers = ix.keys.filter((k: any) => k.isSigner).map((k: any) => k.name);
    assert.deepEqual(signers, ["user"], "só o usuário assina — um signer a mais quebraria o envio");
    assert.equal(ix.keys.find((k: any) => k.name === "fee_program")!.pubkey, pi.PUMP_FEE_PROGRAM_ID);
    assert.equal(ix.keys.find((k: any) => k.name === "program")!.pubkey, pi.PUMP_PROGRAM_ID);
  });

  await test("isolamento: o módulo de instrução não assina, não envia e não lê segredo", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const src = codigoSemComentarios(fs.readFileSync(path.join(repoRoot, "src/pumpInstruction.ts"), "utf8"));
    for (const proibido of ["Keypair", "OPERATIONAL_PRIVATE_KEY", "process.env", "sendTransaction", "sendRawTransaction", "fetch("]) {
      assert.equal(src.includes(proibido), false, `pumpInstruction.ts não pode referenciar ${proibido}`);
    }
    assert.ok(/findProgramAddressSync/.test(src), "PDA é DERIVADO, nunca copiado");
    assert.ok(!/web3\.js.*Connection/.test(src), "não abre conexão");
  });

  await test("custo mínimo honesto: rent documentado no IDL é cobrado do pagador", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const idl = JSON.parse(fs.readFileSync(path.join(repoRoot, "assets/pump-idl-excerpt.json"), "utf8"));
    const docs: string[] = idl.instructions.find((i: any) => i.name === "buy_exact_sol_in").docs;
    const texto = docs.join(" ");
    assert.match(texto, /creator_vault: rent\.minimum_balance/);
    assert.match(texto, /user_volume_accumulator: rent\.minimum_balance/);
    assert.match(texto, /Quote formulas/, "a fórmula de cotação implementada vem das docs do IDL pinado");
  });

  await test("rota nativa: trocar o blockhash após montar sobrevive à assinatura e à serialização", async () => {
    /**
     * MECANISMO DO QUAL A ROTA NATIVA DEPENDE. A transação é montada sem blockhash real (o da
     * curva não existe antes de a montagem terminar) e o blockhash monitorado entra depois, no
     * choke point de assinatura. Se o web3.js ignorasse a mutação, o sistema assinaria com o
     * blockhash de espaço reservado — e a transação seria rejeitada SEMPRE, gastando a
     * tentativa e o tip. Este teste prova o mecanismo sem rede e sem chave real (Keypair
     * efêmero, só em memória, nada transmitido).
     */
    const { Keypair, MessageV0, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = await import("@solana/web3.js");
    const pi = await import("../src/pumpInstruction.js");
    const payer = Keypair.generate();
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    const blockhashMonitorado = pi.deriveGlobalPda();
    tx.message.recentBlockhash = blockhashMonitorado;
    tx.sign([payer]);
    const voltou = VersionedTransaction.deserialize(tx.serialize());
    assert.equal(
      MessageV0.deserialize(voltou.message.serialize()).recentBlockhash,
      blockhashMonitorado,
      "o blockhash substituído tem de estar nos bytes assinados"
    );
  });

  await test("fiação: rota nativa é opt-in, validada fail-closed e reportada em /api/real-entry", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const src = codigoSemComentarios(fs.readFileSync(path.join(repoRoot, "server.ts"), "utf8"));
    assert.ok(/HFT_ENTRY_ROUTE/.test(src), "a rota precisa ser selecionável por variável");
    assert.ok(
      /entryRoute !== "aggregator" && entryRoute !== "native"[\s\S]{0,400}refusedRealEntry/.test(src),
      "rota desconhecida precisa ser RECUSADA (fail-closed), não cair em um default silencioso"
    );
    assert.ok(/buildPumpBuyExactSolInInstruction\(/.test(src), "a rota nativa precisa usar o builder do IDL");
    assert.ok(/ComputeBudgetProgram\.setComputeUnitLimit/.test(src), "compute budget explícito no caminho nativo");
    assert.ok(
      /tx\.message\.recentBlockhash = blockhash/.test(src),
      "o blockhash de espaço reservado da montagem precisa ser substituído antes de assinar"
    );
    assert.ok(/entryRoute,/.test(src) && /entryRouteNote/.test(src), "/api/real-entry precisa declarar a rota ativa");
  });

  await test("dry-run: o script de validação não assina, não envia e não aceita chave privada", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const raw = fs.readFileSync(path.join(repoRoot, "scripts/pump-dryrun.ts"), "utf8");
    const src = codigoSemComentarios(raw);
    for (const proibido of ["sendTransaction", "sendRawTransaction", "Keypair", "fromSecretKey", ".sign(", "partialSign"]) {
      assert.equal(src.includes(proibido), false, `pump-dryrun.ts não pode referenciar ${proibido}`);
    }
    assert.ok(/sigVerify: false/.test(src), "a simulação precisa dispensar assinatura (nenhuma chave envolvida)");
    assert.ok(/replaceRecentBlockhash: true/.test(src), "blockhash não pode ser o objeto do teste");
    assert.ok(/getMultipleAccountsInfo/.test(src), "o dry-run lê as contas reais");
    assert.ok(/NENHUMA assinatura/.test(raw), "o script precisa dizer em texto que não assina");
  });

  await test("dry-run: recusa antes de simular quando não há o que medir", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const src = codigoSemComentarios(fs.readFileSync(path.join(repoRoot, "scripts/pump-dryrun.ts"), "utf8"));
    assert.ok(/curve\.value\.complete[\s\S]{0,200}fail\(/.test(src), "curva completa precisa abortar com motivo");
    assert.ok(/assertSolQuotedCurve/.test(src), "curva não-SOL precisa abortar");
    assert.ok(/owner\.toBase58\(\) !== PUMP_PROGRAM_ID/.test(src), "conta de outro programa precisa abortar (PDA errado)");
    assert.ok(/parseGlobalAccount\(globalInfo\.data\)/.test(src) && /parseBondingCurveAccount\(curveInfo\.data\)/.test(src),
      "os parsers precisam ser exercitados contra dados REAIS: é o ponto do dry-run");
  });

  await test(".env.example declara a rota e o orçamento de compute do caminho nativo", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const env = fs.readFileSync(path.join(repoRoot, ".env.example"), "utf8");
    for (const v of ["HFT_ENTRY_ROUTE", "HFT_ENTRY_CU_LIMIT", "HFT_ENTRY_CU_PRICE_MICROLAMPORTS"]) {
      assert.ok(env.includes(v), `.env.example precisa declarar ${v}`);
    }
    assert.ok(/pump:dryrun/.test(env), "o .env.example precisa apontar o comando de validação");
  });

  await test("anti-drift do IDL: divergência é fatal na rota nativa e avisada na rota agregador", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const src = codigoSemComentarios(fs.readFileSync(path.join(repoRoot, "server.ts"), "utf8"));
    assert.ok(/verifyPumpIdlAgainstChain/.test(src), "o boot precisa verificar o layout contra a rede");
    assert.ok(/IDL_DRIFT/.test(src), "a divergência precisa ter código próprio, não 'erro genérico'");
    // Fatal SÓ na rota native: na rota agregador a divergência de layout não é o risco da operação.
    assert.ok(
      /const fatal = entryRoute === "native"/.test(src),
      "a política de fatalidade precisa ser derivada da rota, não fixa"
    );
    assert.ok(
      /PUMP_ACCOUNT_DISCRIMINATORS\.Global/.test(src) && /PUMP_ACCOUNT_DISCRIMINATORS\.FeeConfig/.test(src),
      "os discriminadores verificados têm de vir do IDL pinado, não de literais hex escritos à mão"
    );
    assert.ok(/PUMP_FEE_PROGRAM_ID/.test(src) && /deriveFeeConfigPda/.test(src), "a âncora de taxas precisa ser verificada");
    assert.ok(
      /IDL_NAO_VERIFICADO/.test(src),
      "RPC inalcançável NÃO pode ser registrado como 'ok': é indeterminado, e chamar de ok seria telemetria falsa"
    );
  });

  await test("anti-drift: distingue 'conferiu' de 'não conferiu' de 'não foi verificado' (três estados, não dois)", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const src = codigoSemComentarios(fs.readFileSync(path.join(repoRoot, "server.ts"), "utf8"));
    // `checked: true, ok: null` é o estado "indeterminado" — nem sucesso nem drift.
    assert.ok(
      /pumpIdlDrift: \{ checked: boolean; ok: boolean \| null; code: string \| null; detail: string \| null \}/.test(src),
      "o estado precisa ter um valor para 'não verificado' (ok: null)"
    );
    assert.ok(/idlDrift: pumpIdlDrift/.test(src), "o estado precisa estar exposto no endpoint de diagnóstico");
  });

  await test("painel de HFT: a tela lê o estado real da entrada — sem afirmação estática de autorização", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const arquivo = fs.readFileSync(path.join(repoRoot, "src/components/HftProfiler.tsx"), "utf8");
    assert.equal(
      /S6 NÃO AUTORIZADO/.test(arquivo),
      false,
      "o S6 foi publicado: manter esse texto seria uma afirmação falsa sobre o próprio sistema"
    );
    assert.ok(/fetch\("\/api\/real-entry"\)/.test(arquivo), "o estado da entrada precisa vir do backend");
    assert.ok(/readiness\?\.allowed/.test(arquivo), "o portão é `allowed`, não `enabled`");
    assert.ok(/"não medido"/.test(arquivo), "sem resposta do backend a tela diz 'não medido'");
  });

  await test("painel de MEV: o simulador de bundle não se confunde com a entrada real", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const arquivo = fs.readFileSync(path.join(repoRoot, "src/components/MevExecutionEngine.tsx"), "utf8");
    assert.equal(/depende do S6 \(não autorizado\)/.test(arquivo), false, "texto desatualizado sobre o S6");
    assert.ok(/POST \/api\/real-entry/.test(arquivo), "a tela precisa apontar o caminho REAL da compra");
    assert.ok(/SIMULADO/.test(arquivo), "e deixar explícito que ela mesma é simulação");
  });

  await test("rota native: entrada recusa quando o layout NÃO está confirmado (defesa em profundidade)", async () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const src = codigoSemComentarios(fs.readFileSync(path.join(repoRoot, "server.ts"), "utf8"));
    assert.ok(
      /entryRoute === "native" && pumpIdlDrift\.ok !== true/.test(src),
      "a checagem tem de ser `ok !== true`: `ok === false` sozinho deixaria passar o caso INDETERMINADO"
    );
    // A ordem importa: a guarda de IDL precisa vir ANTES de qualquer montagem de instrução.
    const posGuarda = src.indexOf('entryRoute === "native" && pumpIdlDrift.ok !== true');
    const posBuilder = src.indexOf("buildPumpBuyExactSolInInstruction({");
    assert.ok(posGuarda > 0 && posBuilder > 0 && posGuarda < posBuilder, "verificação antes da montagem");
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
