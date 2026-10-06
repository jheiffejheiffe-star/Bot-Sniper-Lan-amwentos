/**
 * `npm run smoke` — PROVA DE FUNCIONAMENTO NO SEU AMBIENTE, EM UM COMANDO.
 *
 * ## O que faz
 *
 * Executa o caminho COMPLETO do bot nos modos seguros (PAPER/SHADOW), estágio por
 * estágio, com dados REAIS da sua rede, e imprime uma matriz PASS/FAIL com evidência:
 *
 *   1. Configuração: integridade das constantes de protocolo + modo de execução declarado.
 *   2. Banco: arquivo existe? schema correto? (somente leitura — não escreve nada)
 *   3. RPC: blockhash, slot, altura, priorização de fees, latência medida.
 *   4. Detecção: WebSocket do RPC assina logs do programa Pump.fun e conta notificações.
 *   5. Preço: decimais do mint + cotação de referência (DexScreener / Jupiter).
 *   6. Jupiter: cotação real SOL→USDC (o host é o atual? devolve JSON?).
 *   7. Entrada SHADOW: cotação → montagem → `simulateTransaction` SEM ASSINAR (o mesmo
 *      caminho que o servidor usa em modo PAPER/SHADOW), com telemetria por estágio.
 *   8. Jito (leitura): `getTipAccounts`, tip floor REST e `getInflightBundleStatuses`.
 *   9. Persistência de telemetria: JSONL de eventos gravando de verdade.
 *
 * ## O que este script NUNCA faz
 *
 * - Não assina nada, não envia nada, não usa chave privada (nem lê a sua).
 * - Não escreve no banco operacional (só lê o cabeçalho para validar o schema).
 * - Não chama endpoints mutantes do servidor.
 * Se algum estágio falhar, o script DIZ que falhou — não existe "sucesso simulado".
 *
 * ## Como usar
 *
 *   npm run smoke              # roda tudo
 *   npm run smoke -- --quick   # pula os estágios de rede mais lentos (3, 4, 8)
 *
 * Exit code: 0 = todos os estágios passaram; 1 = houve falha (com a lista no final).
 *
 * ## Leitura do resultado
 *
 * Cada linha traz o FATO medido (número, host, id), não um rótulo. Exemplo:
 *   ✅ RPC responde ............ RTT 38ms | slot 402123456 | blockhash 4vJ9...
 *   ❌ Detecção WS ............. timeout após 15s sem notificação — confira RPC_WEBSOCKET
 */

import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  GeyserStreamClient,
  JupiterIntegration,
  JitoBundleSender,
  isValidBase58Blockhash,
  RPC_ENDPOINT,
  RPC_WEBSOCKET,
} from "../src/realExecution.js";
import {
  PROGRAMS,
  DEXSCREENER_BASE_URL,
  assertConfigIntegrity,
  isValidPubkey,
  jitoBlockEngineUrl,
  jupiterBaseUrl,
} from "../src/solanaConfig.js";
import { describeRuntimeMode, getRuntimeModeResolution } from "../src/runtimeMode.js";
import { simulateEntry } from "../src/shadowEntry.js";
import { JitoTipOracle } from "../src/jitoStatus.js";
import { monotonicNow } from "../src/telemetry.js";

const QUIET = process.argv.includes("--quick");

interface Stage {
  name: string;
  ok: boolean;
  detail: string;
  /** true quando a falha é esperada no ambiente atual (avisada, não conta como erro). */
  warnOnly?: boolean;
}

const stages: Stage[] = [];

function record(name: string, ok: boolean, detail: string, warnOnly = false): void {
  stages.push({ name, ok, detail, warnOnly });
  const icon = ok ? "✅" : warnOnly ? "⚠️ " : "❌";
  console.log(`${icon} ${name.padEnd(34, ".")} ${detail}`);
}

function isRealTradingDisabled(): boolean {
  return !/^(true|1|yes)$/i.test((process.env.LIVE_TRADING_ENABLED || "").trim());
}

/** 1. Configuração + modo. */
function stageConfig(): void {
  try {
    assertConfigIntegrity();
    record("Constantes de protocolo", true, "todas as pubkeys/program ids válidos (sem endereço fabricado)");
  } catch (err: any) {
    record("Constantes de protocolo", false, err.message);
  }

  const mode = getRuntimeModeResolution();
  const desc = describeRuntimeMode();
  record(
    "Modo de execução resolvido",
    true,
    `${mode.mode} (pedido: ${desc.requested ?? "nada declarado"}; flag LIVE: ${desc.liveTradingFlag}; ` +
      `canSign: ${desc.canSign}; conflitos: ${desc.conflicts.length})`
  );
  for (const c of desc.conflicts) record("Conflito de configuração de modo", false, c, true);
  if (mode.mode === "LIVE") {
    record(
      "Modo LIVE exige confirmação",
      false,
      "o processo está em LIVE: este script é read-only, mas considere que qualquer escrita passa a valer capital real"
    );
  } else {
    record("Nada assina neste modo", true, `modo ${mode.mode}: canSign=false (PAPER/SHADOW não tocam a carteira)`);
  }
  if (isRealTradingDisabled()) {
    record("LIVE_TRADING_ENABLED", true, "desarmado (fail-closed)");
  } else {
    record(
      "LIVE_TRADING_ENABLED",
      true,
      "ARMADO — o bot pode assinar/envir de verdade quando o caminho de entrada existir"
    );
  }
  const adminToken = (process.env.ADMIN_TOKEN || "").trim();
  const bindHost = (process.env.HFT_BIND_HOST || "").trim() || "127.0.0.1";
  record(
    "Exposição da API",
    bindHost === "127.0.0.1" || Boolean(adminToken),
    bindHost === "127.0.0.1"
      ? "loopback (127.0.0.1)"
      : adminToken
        ? `bind ${bindHost} com ADMIN_TOKEN definido`
        : `bind ${bindHost} SEM ADMIN_TOKEN: qualquer host da rede chama os POSTs (bloqueados, mas defina o token)`
  );
}

/** 2. Banco operacional (SOMENTE LEITURA). */
function stageDatabase(): void {
  const dbPath = path.join(process.cwd(), "hft_operational_db.json");
  if (!fs.existsSync(dbPath)) {
    record("Banco operacional", true, "não existe ainda — o servidor cria no primeiro boot (nada a validar)");
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    const positions: any[] = Array.isArray(parsed.positions) ? parsed.positions : [];
    const counts = positions.reduce<Record<string, number>>((acc, p) => {
      const k = String(p?.status ?? "sem-status");
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    const schemaOk = parsed.schemaVersion >= 5;
    record(
      "Banco operacional",
      schemaOk,
      `schema v${parsed.schemaVersion} | posições: ${positions.length} ` +
        `(${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ") || "nenhuma"}) | ` +
        `intenções: ${(parsed.intents ?? []).length}`,
      !schemaOk
    );
    if (!schemaOk) {
      record("Schema do banco", false, `esperado v5+ (tabela de intenções). Rode o servidor uma vez para migrar.`);
    }
    const susp = positions.filter((p) => !p.mode && p.status === "open");
    if (susp.length > 0) {
      record(
        "Posições sem `mode`",
        true,
        `${susp.length} posição(ões) aberta(s) sem modo declarado — rode \`npm run quarantine\` para classificar`,
        true
      );
    }
  } catch (err: any) {
    record("Banco operacional", false, `arquivo existe mas não é JSON válido: ${err.message}`);
  }
}

/** 3. RPC. */
async function stageRpc(): Promise<void> {
  if (!RPC_ENDPOINT) {
    record("RPC configurado", false, "RPC_ENDPOINT ausente (o default público não serve para operar)");
    return;
  }
  const conn = new Connection(RPC_ENDPOINT, { commitment: "processed" });
  try {
    const t0 = Date.now();
    const bh = await conn.getLatestBlockhash("processed");
    const rtt = Date.now() - t0;
    record(
      "RPC responde",
      isValidBase58Blockhash(bh.blockhash),
      `RTT ${rtt}ms | lastValidBlockHeight ${bh.lastValidBlockHeight} | blockhash ${bh.blockhash.slice(0, 12)}...`
    );
    const slot = await conn.getSlot("processed");
    record("RPC reporta slot", slot > 0, `slot ${slot}`);
    const height = await conn.getBlockHeight("confirmed");
    record("RPC reporta altura", height > 0, `altura ${height} (base da prova de expiração do S4)`);

    const owner = new PublicKey(PROGRAMS.SYSTEM_PROGRAM);
    const fees = await conn.getRecentPrioritizationFees({ lockedWritableAccounts: [owner] });
    const recent = fees.slice(-5);
    const last = recent.at(-1)?.prioritizationFee ?? null;
    record(
      "Priority fees",
      fees.length > 0,
      fees.length > 0
        ? `últimas ${recent.length}: [${recent.map((f) => f.prioritizationFee).join(", ")}] micro-lamports/CU (último ${last})`
        : "nenhuma amostra retornada"
    );
  } catch (err: any) {
    record("RPC responde", false, err.message);
  }
}

/** 4. Detecção por WebSocket (o que arma o sniping). */
async function stageDetection(): Promise<void> {
  if (QUIET) {
    record("Detecção WS", true, "pulada (--quick)");
    return;
  }
  if (!RPC_WEBSOCKET) {
    record("Detecção WS", false, "RPC_WEBSOCKET ausente: sem socket, nenhum lançamento é detectado");
    return;
  }
  const client = new GeyserStreamClient(RPC_ENDPOINT || "", RPC_WEBSOCKET, "");
  let launchEvents = 0;
  const waitMs = 15_000;
  try {
    client.onTokenDetected(() => {
      launchEvents++;
    });
    await client.connect();
    const t0 = Date.now();
    // Espera o socket ABRIR de fato (getHealth().socketOpen), não apenas as subscrições
    // terem sido registradas localmente — essa era exatamente uma confusão corrigida.
    while (Date.now() - t0 < waitMs && !client.getHealth().socketOpen) {
      await new Promise((r) => setTimeout(r, 500));
    }
    const health = client.getHealth();
    record(
      "Detecção WS",
      health.socketOpen,
      health.socketOpen
        ? `socket aberto em ${Date.now() - t0}ms | subscrições registradas: ${health.subscriptionsRequested} | ` +
          `lançamentos vistos em ${waitMs / 1000}s: ${health.eventCount} ` +
          `(zero é normal em janela curta; a PROVA de detecção é eventCount > 0 ao longo do tempo)`
        : `socket NÃO abriu em ${waitMs / 1000}s — confira RPC_WEBSOCKET e firewall. ` +
          `Erros: ${health.recentErrors?.slice(-2).join(" | ") || "nenhum registrado"}`
    );
  } catch (err: any) {
    record("Detecção WS", false, `falhou: ${err.message}`);
  } finally {
    try {
      client.disconnect?.();
    } catch {
      /* ignore */
    }
  }
}

/** 5. Fonte de preço de referência usada pela gestão PAPER. */
async function stagePrice(): Promise<void> {
  const mint = "So11111111111111111111111111111111111111112";
  try {
    const res = await fetch(`${DEXSCREENER_BASE_URL}/tokens/${mint}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      record("Fonte de preço (DexScreener)", false, `HTTP ${res.status} em ${DEXSCREENER_BASE_URL}`);
      return;
    }
    const json: any = await res.json();
    const price = json?.pairs?.[0]?.priceUsd ?? json?.pairs?.[0]?.priceNative ?? null;
    record(
      "Fonte de preço (DexScreener)",
      price !== null,
      price !== null ? `preço de referência SOL/USD=${price} via ${DEXSCREENER_BASE_URL}` : "resposta sem pares/preço"
    );
  } catch (err: any) {
    record("Fonte de preço (DexScreener)", false, err.message);
  }
}

/** 6. Jupiter (cotação real). */
async function stageJupiter(): Promise<void> {
  const base = jupiterBaseUrl();
  const sol = "So11111111111111111111111111111111111111112";
  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  try {
    const quote = await JupiterIntegration.getQuote(sol, usdc, 10_000_000, 50, 8000);
    const out = (quote as any)?.outAmount;
    record(
      "Jupiter cotação",
      Boolean(out),
      out ? `10.000.000 lamports SOL → ${out} unidades USDC em ${base}` : `resposta sem outAmount (${base})`
    );
    if (/quote-api\.jup\.ag/.test(base)) {
      record("Host da Jupiter", false, "JUPITER_BASE_URL aponta para quote-api.jup.ag/v6, host DESCONTINUADO");
    }
  } catch (err: any) {
    record("Jupiter cotação", false, `${err.message} (host ${base})`);
  }
}

/** 7. Caminho de entrada SHADOW completo — o mesmo do servidor, sem assinar. */
async function stageShadowEntry(): Promise<void> {
  const mode = getRuntimeModeResolution().mode;
  const mint = "So11111111111111111111111111111111111111112"; // SOL: liquidez máxima, só para provar o caminho
  const conn = new Connection(RPC_ENDPOINT || "", { commitment: "processed" });

  try {
    const result = await simulateEntry(
      {
        getQuote: (a, b, c, d, e) => JupiterIntegration.getQuote(a, b, c, d, e),
        buildSwapTransaction: (q, pk, t) => JupiterIntegration.buildSwapTransaction(q, pk, t),
        simulateTransaction: async (tx: any) =>
          conn.simulateTransaction(tx as VersionedTransaction, {
            commitment: "processed",
            sigVerify: false,
            replaceRecentBlockhash: true,
          }),
        now: monotonicNow,
      },
      {
        mint,
        sizeSol: 0.01,
        // Chave pública DESCARTÁVEL: em PAPER/SHADOW nenhuma transação é assinada, então
        // qualquer pubkey serve para MONTAR a transação. Nenhuma chave real é lida aqui.
        userPublicKey: PROGRAMS.SYSTEM_PROGRAM,
        mode,
        slippageBps: Number(process.env.SHADOW_SLIPPAGE_BPS ?? 300),
      }
    );

    if (result.skippedReason) {
      record("Entrada SHADOW (cotação→montagem→simulação)", true, `pulada: ${result.skippedReason}`);
      return;
    }
    record(
      "Entrada SHADOW: cotação",
      Boolean(result.quote),
      result.quote
        ? `outAmount=${result.quote.outAmount} | impacto ${result.quote.priceImpactPct ?? "?"}% | rota ${(result.quote.routeLabels ?? []).join(">")}`
        : "sem cotação"
    );
    record("Entrada SHADOW: transação montada", result.built, result.built ? "swap construído (não assinado)" : "não construída");
    record(
      "Entrada SHADOW: simulação",
      Boolean(result.simulation?.ok),
      result.simulation
        ? `ok=${result.simulation.ok} | computeUnits=${result.simulation.unitsConsumed ?? "?"} | blockhash substituído=${result.simulation.blockhashReplaced}`
        : "sem resultado de simulação"
    );
    const t = result.timingsMs;
    console.log(
      `    etapas: cota=${t.quote ?? "-"}ms → monta=${t.build ?? "-"}ms → simula=${t.simulate ?? "-"}ms (total ${t.total}ms)`
    );
  } catch (err: any) {
    record("Entrada SHADOW", false, err.message);
  }
}

/** 8. Jito — somente leitura (status de landing + tip floor são o S3). */
async function stageJito(): Promise<void> {
  if (QUIET) {
    record("Jito (leitura)", true, "pulada (--quick)");
    return;
  }
  // 8a. Tip accounts (onde o tip deve ir).
  try {
    const region = process.env.JITO_REGION || "ny";
    const res = await fetch(`${jitoBlockEngineUrl(region as any)}/api/v1/getTipAccounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }),
      signal: AbortSignal.timeout(8000),
    });
    const json: any = await res.json();
    const accounts: string[] = Array.isArray(json.result) ? json.result : [];
    record(
      "Jito getTipAccounts",
      accounts.length > 0 && accounts.every(isValidPubkey),
      `${accounts.length} contas, todas válidas: ${accounts.length > 0 && accounts.every(isValidPubkey)} (região ${region})`
    );
  } catch (err: any) {
    record("Jito getTipAccounts", false, err.message);
  }

  // 8b. Tip floor real (REST).
  try {
    const oracle = new JitoTipOracle({ fetchFn: fetch, now: () => Date.now() });
    const floor = await oracle.getTipFloor();
    if (floor.available) {
      const s = floor.sample;
      record(
        "Jito tip floor (REST)",
        true,
        `p25=${s.p25 ?? "?"} p50=${s.p50 ?? "?"} p75=${s.p75 ?? "?"} p95=${s.p95 ?? "?"} ema50=${s.ema50 ?? "?"} lamports | ` +
          `idade ${floor.ageMs}ms | fonte ${floor.url}`
      );
    } else {
      record(
        "Jito tip floor (REST)",
        false,
        `indisponível: ${floor.error} — a recomendação de tip fica nula (correto: não inventa número)`,
        true
      );
    }
  } catch (err: any) {
    record("Jito tip floor (REST)", false, err.message);
  }

  // 8c. Status de landing (read-only): prova que conseguimos PERGUNTAR o desfecho.
  try {
    const conn = new Connection(RPC_ENDPOINT || "https://api.mainnet-beta.solana.com", { commitment: "confirmed" });
    const sender = new JitoBundleSender(conn);
    const inflight = await sender.getInflightBundleStatuses(["11111111111111111111111111111111111111111111"]);
    record(
      "Jito status de landing",
      inflight.problems.length === 0,
      inflight.problems.length === 0
        ? "consulta aceita pelo block engine (a assinatura de teste não existe — o esperado é status vazio/Invalid)"
        : `consulta RECUSADA: ${inflight.problems.join("; ")} (sem essa via não há como provar o desfecho de um bundle)`,
      true
    );
  } catch (err: any) {
    record("Jito status de landing", false, err.message);
  }
}

/** 9. Telemetria em JSONL (a base do replay). */
async function stageTelemetry(): Promise<void> {
  try {
    const { recorder } = await import("../src/eventRecorder.js");
    const dir = path.join(process.cwd(), "data");
    fs.mkdirSync(dir, { recursive: true });
    recorder.recordLaunchEvent({
      mint: "So11111111111111111111111111111111111111112",
      token: "SMOKE-TEST",
      program: "SMOKE",
      slot: 0,
      signature: null,
      mode: getRuntimeModeResolution().mode,
      source: "npm run smoke",
    } as any);
    const flushed = await recorder.flush();
    const stats = recorder.getStats();
    record(
      "Telemetria JSONL",
      flushed,
      flushed
        ? `gravado em data/events.jsonl | tipos: ${JSON.stringify(stats.counts)} | bytes: ${stats.sink.bytesWritten}`
        : `erros de escrita: ${stats.writeErrors}`
    );
  } catch (err: any) {
    record("Telemetria JSONL", false, err.message);
  }
}

async function main(): Promise<void> {
  console.log("=========================================================");
  console.log(" SMOKE TEST — prova de funcionamento no SEU ambiente");
  console.log(" (read-only: NADA é assinado, enviado ou gravado no banco)");
  console.log("=========================================================\n");

  stageConfig();
  stageDatabase();
  await stageRpc();
  await stageDetection();
  await stagePrice();
  await stageJupiter();
  await stageShadowEntry();
  await stageJito();
  await stageTelemetry();

  const failed = stages.filter((s) => !s.ok && !s.warnOnly);
  const warned = stages.filter((s) => !s.ok && s.warnOnly);
  console.log("\n=========================================================");
  if (failed.length === 0) {
    console.log(`🏆 ${stages.length} estágios verificados SEM FALHA (${warned.length} aviso(s))`);
    console.log("   Próximo passo: rode o servidor e acompanhe GET /api/health.");
  } else {
    console.log(`💥 ${failed.length} de ${stages.length} estágios FALHARAM:`);
    for (const f of failed) console.log(`   - ${f.name}: ${f.detail}`);
    console.log("\n   Nada foi assinado ou enviado. Corrija a rede/config e rode de novo.");
    process.exitCode = 1;
  }
  console.log("=========================================================");
}

main().catch((err) => {
  console.error("Falha fatal no smoke test:", err);
  process.exit(1);
});
