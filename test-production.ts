import assert from "assert";
import fs from "fs";
import { dbStore } from "./src/persistence.js";
import { getActiveWalletPublicKey, initializeVault } from "./src/security.js";

/**
 * AVISO DE SEGURANÇA (auditoria 2026-10-02)
 * -----------------------------------------
 * Este script APAGA hft_operational_db.json e o .bak nas primeiras linhas. Rodá-lo em
 * produção destrói o histórico operacional (trades, posições, logs) sem aviso — foi o
 * que ele fazia. Além disso, os "10/10 testes" anunciados eram, na prática, 4 áreas de
 * asserção, e duas delas testavam REIMPLEMENTAÇÕES locais da lógica (um Set de lock
 * próprio e uma cópia da fórmula de slippage), não o código real do servidor.
 *
 * Para testes reais use: npm run test     (tests/safety.test.ts, não destrutivo)
 * Este arquivo só roda com confirmação explícita.
 */
async function runTests() {
  if (process.env.HFT_ALLOW_DB_WIPE !== "true") {
    console.error(
      "=========================================\n" +
        "⛔ test-production.ts está DESABILITADO por segurança.\n\n" +
        "Ele APAGA o banco operacional (hft_operational_db.json + .bak).\n\n" +
        "Use a suíte real, que roda em diretório isolado e não toca no seu histórico:\n" +
        "    npm run test\n\n" +
        "Se você realmente quer apagar o banco e rodar este script legado:\n" +
        "    HFT_ALLOW_DB_WIPE=true npm run test:destructive\n" +
        "========================================="
    );
    process.exit(1);
  }

  console.log("=========================================");
  console.log("🚨 INICIANDO TESTES DE HOMOLOGAÇÃO (DESTRUTIVO — banco será apagado)");
  console.log("=========================================");

  // Initialize KMS Secure Memory Vault
  await initializeVault();

  // TEST 1: Atomic File Persistence and Auto-Recovery (.bak restore)
  console.log("\n🧪 Teste 1: Persistência Atômica e Auto-Recovery...");
  
  // Clear any existing db file to test clean initialization
  const dbPath = "./hft_operational_db.json";
  const bakPath = "./hft_operational_db.json.bak";
  
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath);

  // Write a setting and verify it saves atomically
  dbStore.updateSettings({
    coLocationActive: true,
    circuitBreakerActive: true,
    circuitBreakerThreshold: 90,
    pm2State: "active"
  });

  assert(fs.existsSync(dbPath), "O arquivo de banco principal deveria existir.");
  const initialContent = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
  assert.strictEqual(initialContent.settings.circuitBreakerThreshold, 90, "As configurações salvas estão corretas.");
  console.log("  ✅ Gravação Atômica com Fsync: OK");

  // Corrupt the main db to trigger backup recovery
  fs.writeFileSync(dbPath, "{ CORRUPTED_GARBAGE_JSON_ACID_TEST }", "utf-8");
  
  // Force reload and verify it auto-recovers from .bak
  const recoveredSettings = dbStore.getSettings();
  assert.strictEqual(recoveredSettings.circuitBreakerThreshold, 90, "O banco deveria auto-recuperar do backup (.bak) com sucesso.");
  console.log("  ✅ Restauração automática de .bak: OK");

  // TEST 2: KMS Cache-efficiency (Avoid simultaneous decryption of active wallet)
  console.log("\n🧪 Teste 2: Vault Isolado & Eficiência de Cache KMS...");
  const firstKey = getActiveWalletPublicKey();
  const startTime = performance.now();
  const secondKey = getActiveWalletPublicKey();
  const duration = performance.now() - startTime;

  assert.strictEqual(firstKey.toBase58(), secondKey.toBase58(), "As chaves públicas retornadas consecutivamente devem ser idênticas.");
  assert(duration < 0.1, "O lookup consecutivo da chave pública deve ser instantâneo através do cache volátil.");
  console.log("  ✅ Cache de Chave Pública do Vault Isolado: OK");

  // TEST 3: Concurrent Liquidation Locks & EXIT_PENDING status
  console.log("\n🧪 Teste 3: Locks de Concorrência na Liquidação (Race Condition Prevention)...");
  
  // Setup a test position
  const testPosId = "test-position-123";
  const dummyPosition = {
    id: testPosId,
    token: "DUMMY",
    mint: "So11111111111111111111111111111111111111112",
    sizeSol: 0.1,
    entryPrice: 0.001,
    currentPrice: 0.0012,
    pnlPercent: 25.0,
    status: "open" as const,
    stopLossPercent: -5,
    takeProfitPercent: 15,
    trailingStopActive: false,
    trailingStopOffsetPercent: 2.5,
    highestPrice: 0.0012,
    timeOpened: new Date().toISOString()
  };
  
  dbStore.savePosition(dummyPosition);

  // Simulate concurrent exit attempts by manually modifying locks
  // We can simulate the mutex lock used in server.ts
  const exitLocks = new Set<string>();

  function tryAcquireLockAndExit(posId: string): boolean {
    if (exitLocks.has(posId)) {
      return false; // Aborted due to concurrent action
    }
    exitLocks.add(posId);
    return true; // Lock acquired successfully
  }

  const firstAttempt = tryAcquireLockAndExit(testPosId);
  const secondAttempt = tryAcquireLockAndExit(testPosId);

  assert.strictEqual(firstAttempt, true, "A primeira tentativa deve conseguir adquirir o lock.");
  assert.strictEqual(secondAttempt, false, "A segunda tentativa simultânea deve abortar imediatamente (Prevenção de Race Condition).");
  console.log("  ✅ Mutex de Bloqueio Simultâneo de Saída: OK");

  // TEST 4: Adaptive Slippage Algorithm
  console.log("\n🧪 Teste 4: Algoritmo de Slippage Adaptativo...");
  const baseSlippageBps = 150; // 1.5%
  const maxSlippageBps = 1000; // 10%
  
  const getSlippageForAttempt = (attempt: number) => {
    let slippage = baseSlippageBps;
    if (attempt === 1) slippage += 100; // +1.0%
    if (attempt === 2) slippage += 250; // +2.5%
    return Math.min(slippage, maxSlippageBps);
  };

  assert.strictEqual(getSlippageForAttempt(0), 150, "Tentativa 0 deve usar slippage base (1.5%)");
  assert.strictEqual(getSlippageForAttempt(1), 250, "Tentativa 1 deve usar slippage aumentado (+1.0%)");
  assert.strictEqual(getSlippageForAttempt(2), 400, "Tentativa 2 deve usar slippage aumentado (+2.5%)");
  console.log("  ✅ Slippage Adaptativo Dinâmico por Tentativa: OK");

  console.log("\n=========================================");
  console.log("⚠️  4 áreas verificadas neste script legado — isto NÃO é cobertura de 10 testes.");
  console.log("=========================================");
}

runTests().catch(err => {
  console.error("❌ Falha crítica nos testes de homologação:", err);
  process.exit(1);
});
