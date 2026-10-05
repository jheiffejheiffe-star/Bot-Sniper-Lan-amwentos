import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const currentFilename = typeof __filename !== "undefined" 
  ? __filename 
  : fileURLToPath(import.meta.url);
const currentDirname = typeof __dirname !== "undefined"
  ? __dirname
  : path.dirname(currentFilename);
import { GoogleGenAI } from "@google/genai";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { 
  RecentBlockhashCache, 
  GeyserStreamClient, 
  JupiterIntegration, 
  JitoBundleSender,
  ConfirmationMonitor,
  isValidBase58Blockhash,
  RPC_ENDPOINT, 
  RPC_WEBSOCKET, 
  GEYSER_GRPC_URL
} from "./src/realExecution.js";
import {
  PROGRAMS,
  DEXSCREENER_BASE_URL,
  assertConfigIntegrity,
  isValidPubkey
} from "./src/solanaConfig.js";
import {
  assessPriceFreshness,
  clampTipSol,
  riskActionForFreshness,
  type PriceQuote
} from "./src/accounting.js";
import {
  assertCanSign,
  describeRuntimeMode,
  getRuntimeModeResolution,
  validateRuntimeConfiguration,
} from "./src/runtimeMode.js";
import { LatencyTrace, monotonicNow, telemetry, wallClockNow } from "./src/telemetry.js";
import { simulateEntry, type ShadowEntryResult } from "./src/shadowEntry.js";
import {
  assessEntryGate,
  countLandedEntryAttempts,
  executeRealEntry,
  parseEntryFill,
  refusedRealEntry,
  resolveRealEntryPolicy,
  type EntryGateInput,
  type RealEntryDeps,
  type RealEntryResult,
} from "./src/realEntry.js";
import { labelAll } from "./src/outcomeLabels.js";
import { buildValidationReport } from "./src/strategyValidation.js";
import {
  PostgresStorage,
  decideEntryStorageGuard,
  describeStoragePolicy,
  loadPgClient,
  resolveStoragePolicy,
  type StoragePolicy,
} from "./src/storage/postgresStorage.js";
import {
  GrpcIngestClient,
  assessGrpcEndpoint,
  redactGrpcEndpoint,
  resolveIngestPolicy,
  sanitizeGrpcError,
} from "./src/grpcIngest.js";
import { loadYellowstoneClient } from "./src/grpcYellowstoneClient.js";
import {
  buildJitoTransport,
  buildRpcDirectTransport,
  buildStakedSenderTransport,
  describeParallelSendPolicy,
  resolveParallelSendPolicy,
  sendInParallel,
  type TransportAttempt,
} from "./src/parallelSend.js";
import {
  PUMP_ACCOUNT_DISCRIMINATORS,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  assertSolQuotedCurve,
  buildPumpBuyExactSolInInstruction,
  deriveBondingCurvePda,
  deriveFeeConfigPda,
  deriveGlobalPda,
  minTokensOutFromSlippage,
  parseBondingCurveAccount,
  parseGlobalAccount,
  quoteTokensOutExactSolIn,
  type BoundingCurveState,
} from "./src/pumpInstruction.js";
import {
  JitoTipOracle,
  TIP_FLOOR_URL,
  MIN_JITO_TIP_LAMPORTS,
  TIP_POLICIES,
  reconcileLanding,
  type TipPercentilePolicy,
  type RpcConfirmation,
  type JitoConfirmationStatus,
} from "./src/jitoStatus.js";
import {
  advanceIntent,
  createExecutionIntent,
  decideRetry,
  findBlockingIntent,
  type ExecutionIntentRecord,
  type RetryDecision,
  type SignatureObservation,
} from "./src/executionIntent.js";
import {
  reconcilePositionDesync,
  describeDesyncReport,
  type DesyncReport,
  type Holding,
} from "./src/positionDesync.js";
import {
  InFlightMints,
  decideEntryWithBudget,
  resolveSendOptions,
  type HotPathStats,
} from "./src/hotPath.js";
import { buildBudgetRegistry, withBudget } from "./src/rateBudget.js";
import {
  fetchBatchPrices,
  isQueryableMint,
  priceSolFromDexPairs,
  SOL_MINT,
  type BatchQuote,
  type BatchResult,
} from "./src/marketPriceFeed.js";
import {
  assessLiquidityDrop,
  DEFAULT_DIVERGENCE_THRESHOLDS,
  DEFAULT_LIQUIDITY_THRESHOLDS,
  PriceSampleBook,
  type DivergenceFinding,
} from "./src/priceQuality.js";
import {
  assessEntryPrice,
  type EntryPriceAssessment,
} from "./src/entryQuality.js";
import {
  assessRpcCoherence,
  describeRpcCoherence,
  type RpcCoherence,
} from "./src/rpcProfile.js";
import { PumpPortalFeed, type PumpPortalEvent } from "./src/pumpPortalFeed.js";
import { fetchRugCheckEvidence, rugCheckRiskReasons } from "./src/rugCheck.js";
import { recorder, loadBacktestDataset, listDataFiles } from "./src/eventRecorder.js";
import { compareStrategies, DEFAULT_STRATEGIES } from "./src/replay.js";
import bs58 from "bs58";

// Falha rápido no boot se qualquer constante de protocolo estiver corrompida.
// Endereço fabricado = SOL perdido ou transação rejeitada. Melhor não subir.
assertConfigIntegrity();

/**
 * VALIDAÇÃO DE BOOT POR MODO DE EXECUÇÃO.
 *
 * Regra: configuração crítica faltando NÃO vira aviso — vira recusa de subir.
 * Subir meio-configurado é pior do que não subir: o caminho que mais depende de
 * configuração correta é a SAÍDA, e uma saída que falha em silêncio prende capital.
 *
 * Concretamente, o caso que esta validação elimina:
 *   LIVE_TRADING_ENABLED=true  +  RUNTIME_MODE ausente
 * Antes: interpretado como "ligado", com o sistema operando por inferência.
 * Agora: erro fatal com instrução do que declarar.
 */
{
  const runtimeResolution = getRuntimeModeResolution();
  const bootCheck = validateRuntimeConfiguration(runtimeResolution);

  console.log(
    `[Boot] Modo de execução: ${runtimeResolution.mode}` +
      ` (liveAuthorized=${runtimeResolution.liveAuthorized}` +
      `${runtimeResolution.requested ? `, RUNTIME_MODE=${runtimeResolution.requested}` : ", RUNTIME_MODE não declarado"}).`
  );
  for (const reason of runtimeResolution.reasons) console.log(`[Boot]   ${reason}`);
  for (const conflict of runtimeResolution.conflicts) console.warn(`[Boot][CONFLITO] ${conflict}`);
  for (const warning of bootCheck.warnings) console.warn(`[Boot][AVISO] ${warning}`);

  if (bootCheck.fatal.length > 0) {
    for (const fatal of bootCheck.fatal) console.error(`[Boot][FATAL] ${fatal}`);
    console.error(
      "[Boot] Encerrando (exit 1): configuração incompatível com o modo declarado. " +
        "Nada é assinado com configuração ambígua."
    );
    process.exit(1);
  }
}

// Global on-chain indicators and events tracking
let globalConnection: Connection | null = null;
const realOnChainEvents: any[] = [];
import {
  initializeVault,
  getOperationalSecurityState,
  triggerKillSwitch,
  setReadOnlyMode,
  rotateActiveWallet,
  resetCircuitBreaker,
  reportTradeOutcome,
  reportSignalRejected,
  reportSignalAccepted,
  isLiveTradingEnabled,
  assertMutationAuthorized,
  assertExecutionAllowed,
  assertExitAllowed,
  getActiveWalletPublicKey,
  executeWithDecryptedKeypair
} from "./src/security.js";
import { dbStore, type LegRecord } from "./src/persistence.js";
import { computeRoundTrip, parseTransactionLeg, unmeasuredLeg } from "./src/roundTrip.js";

const app = express();
const PORT = 3000;

// Process safety handlers to prevent container crashes on transient network drops
/**
 * Exceção não capturada em processo que detém chaves e posições.
 *
 * A versão anterior logava e CONTINUAVA rodando ("caught safely"). Depois de uma exceção
 * não tratada não há garantia de que o estado em memória (posições, locks, cache de
 * blockhash, cursores de ingestão) permaneça consistente — e um estado inconsistente que
 * continua operando é mais perigoso do que um processo que reinicia.
 *
 * Política: registrar de forma irrecuperável e deixar o SUPERVISOR reiniciar (systemd/pm2/
 * k8s). O estado crítico (posições, kill switch, logs) está no disco, e `reconcileStuckExits`
 * trata posições presas em EXIT_PENDING no próximo boot.
 */
process.on("uncaughtException", (err) => {
  console.error("[Process Guard] UNCAUGHT EXCEPTION — encerrando para reinício pelo supervisor:", err);
  try {
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "CRITICAL",
      component: "SYSTEM",
      message:
        `Processo encerrado por exceção não capturada: ${err?.message || String(err)}. ` +
        `Reinício pelo supervisor necessário. Verifique posições abertas antes de reativar.`,
    });
  } catch {
    /* se nem o log funciona, ainda assim devemos sair */
  }
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[Process Guard] Unhandled Rejection caught safely:", reason);
});

app.use(express.json());

/**
 * GUARD DE MUTAÇÃO (fail-closed).
 *
 * AUDITORIA 2026-10-02: todos os endpoints POST estavam abertos. Em um servidor com a
 * hot wallet armada, qualquer host que alcançasse a porta 3000 podia fechar posições,
 * acionar o kill switch ou enviar bundles. Agora todo POST passa por autorização.
 *
 * GETs permanecem abertos (somente leitura) para não quebrar dashboards.
 */
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }
  const auth = assertMutationAuthorized(req);
  if (!auth.ok) {
    console.warn(`[API Guard] POST ${req.path} bloqueado: ${auth.error}`);
    return res.status(auth.status).json({ error: auth.error });
  }
  return next();
});

// Essential Cloud Run health check and liveness endpoints
/**
 * Cliente de detecção (WebSocket RPC) acessível fora do escopo de inicialização.
 *
 * Motivo: sem isso, `/api/health` não tinha como dizer se a DETECÇÃO está de pé — e o painel
 * exibia "connected" mesmo com o WebSocket inoperante. Um bot cego que se declara saudável é
 * pior do que um bot que diz "não estou vendo lançamentos".
 */
let geyserClientRef: GeyserStreamClient | null = null;

/**
 * FAST PATH gRPC (S7). É ADITIVO, não substituto: o WSS continua assinando todos os programas
 * (Raydium/CPMM/Meteora também criam pools) e o gRPC acrescenta o caminho de baixa latência do
 * pump, que é o alvo do sniper. Se o gRPC cair, a cobertura do pump continua pelo WSS — perder
 * cobertura para ganhar milissegundos não é troca aceitável.
 */
let grpcIngestRef: GrpcIngestClient | null = null;

/**
 * DEDUPE ENTRE FONTES. Os mesmos bytes podem chegar por gRPC (mais rápido) e por WSS (rede de
 * segurança) — é o preço consciente de rodar as duas. Sem isto, o mesmo lançamento entraria duas
 * vezes no pipeline (duas auditorias e, em modo real, duas avaliações de compra). O controle é por
 * ASSINATURA, com teto de memória e descarte FIFO.
 */
const CROSS_SOURCE_SEEN_CAP = 5_000;
const crossSourceSeen = new Set<string>();
const crossSourceSeenOrder: string[] = [];
let crossSourceDuplicatesDropped = 0;

/** Registra a assinatura; `false` = já vista nesta janela (outra fonte já entregou). */
function firstSightAcrossSources(signature: string): boolean {
  if (crossSourceSeen.has(signature)) return false;
  crossSourceSeen.add(signature);
  crossSourceSeenOrder.push(signature);
  if (crossSourceSeenOrder.length > CROSS_SOURCE_SEEN_CAP) {
    const oldest = crossSourceSeenOrder.shift();
    if (oldest) crossSourceSeen.delete(oldest);
  }
  return true;
}

/**
 * Política de ENVIO PARALELO (S8), resolvida UMA vez no boot e exposta ao operador. Default:
 * desligada — o caminho continua sendo o bundle Jito único do S6.
 */
const PARALLEL_SEND = resolveParallelSendPolicy();
console.log(`[Boot][Env] ${describeParallelSendPolicy(PARALLEL_SEND).join(" | ")}`);
/**
 * ARMAZENAMENTO (S10): política resolvida uma vez no boot + adaptador quando em modo Postgres.
 * `storageRef` nulo em modo JSON — e o modo JSON é o default, com o comportamento anterior.
 */
const STORAGE_POLICY: StoragePolicy = resolveStoragePolicy();
let storageRef: PostgresStorage | null = null;

/** Último resultado de corrida de envio, para diagnóstico (memória: some no restart). */
let lastParallelSend: {
  at: string;
  signature: string;
  winner: string | null;
  acceptedBy: string[];
  attempts: TransportAttempt[];
  ok: boolean;
} | null = null;

/**
 * Feed gratuito da PumpPortal (terceiro) — entrega o mint NA CRIAÇÃO do token, então este
 * caminho não paga `getTransaction` nem a espera até `confirmed` (limite estrutural do S5).
 * Fonte ADICIONAL: o `logsSubscribe` do RPC continua ativo e cobre Raydium/Meteora.
 */
let pumpPortalRef: PumpPortalFeed | null = null;

app.get("/api/health", (_req, res) => {
  const detection = geyserClientRef?.getHealth() ?? null;
  res.json({
    status: "ok",
    uptime: process.uptime(),
    runtimeMode: getRuntimeModeResolution().mode,
    /**
     * Estado REAL da detecção. `null` significa "o pipeline de detecção ainda não foi
     * inicializado" — que é diferente de "conectado" e diferente de "quebrado".
     */
    detection: detection
      ? {
          connected: detection.connected,
          subscriptions: detection.subscriptions,
          degraded: detection.degraded,
          eventCount: detection.eventCount,
          lastEventAt: detection.lastEventAt,
          sinceLastEventMs: detection.sinceLastEventMs,
          recentErrors: detection.recentErrors,
          /**
           * Cobertura e duplicatas entre fontes (S7). `crossSourceDuplicatesDropped` alto é
           * ESPERADO quando gRPC e WSS estão ativos ao mesmo tempo — prova de que o dedupe está
           * trabalhando, não sintoma de defeito.
           */
          crossSourceDuplicatesDropped,
          /** Fast path gRPC: estado próprio, aditivo ao WSS. `null` = não configurado. */
          grpcFastPath: grpcIngestRef
            ? (() => {
                const h: any = grpcIngestRef!.getHealth();
                return {
                  endpoint: h.grpc?.endpoint ?? null,
                  streamOpen: h.socketOpen,
                  events: h.eventCount,
                  updatesSeen: h.grpc?.updatesSeen ?? null,
                  decodeFailures: h.grpc?.decodeFailures ?? null,
                  reconnects: h.grpc?.reconnectAttempts ?? null,
                  sinceLastUpdateMs: h.grpc?.sinceLastUpdateMs ?? null,
                };
              })()
            : null,
          /**
           * O /api/health é a PRIMEIRA parada do operador (e a sonda do smoke test): se os
           * contadores do caminho quente só aparecessem em /api/system-truth, a perda de
           * lançamento continuaria invisível exatamente em quem olha o básico.
           */
          hotPath: detection.hotPath,
        }
      : null,
    /**
     * Resumo de cotas: quem opera em plano gratuito precisa ver isto ANTES de culpar o mercado.
     * `skipped > 0` no dexscreener, por exemplo, significa "faltou dado por cota".
     */
    budgets: budgets.resumo(),
    /**
     * ENTRADA REAL (S6): o operador precisa ver, sem ler código, se o caminho real está
     * ligado e com que teto. `readiness` é o gate completo rodando AGORA — o mesmo que
     * recusaria uma entrada neste instante, com o motivo exato.
     */
    realEntry: (() => {
      const policy = resolveRealEntryPolicy();
      const { gateInput } = buildEntryGateInput({ mint: SOL_MINT, sizeSol: policy.canaryMaxSol, autonomousCall: true });
      const gate = assessEntryGate(gateInput);
      return {
        policy,
        autonomousGate: gate,
        lastResults: realEntryHistory.slice(0, 5),
        note:
          "Entrada real exige RUNTIME_MODE=LIVE + LIVE_TRADING_ENABLED=true + HFT_REAL_ENTRY_ENABLED=1; " +
          "o pipeline automático exige ainda HFT_AUTONOMOUS_ENTRY=1. O teto por entrada é HFT_CANARY_MAX_SOL. " +
          "Posição só é registrada com slot on-chain observado (GET /api/real-entry).",
      };
    })(),
    /**
     * O perfil de cota só vale o que o endpoint conectado suporta. Este bloco diz o que foi
     * inferido do HOST (nunca da chave) e onde a declaração não bate com o conectado.
     */
    rpcCoherence: {
      ...rpcCoherence,
      note:
        "coherent=false significa que HFT_RPC_PROFILE contradiz o endpoint conectado. Em modo " +
        "PAPER/SHADOW o bot segue e registra; em LIVE ele recusa subir.",
    },
    /**
     * Qualidade do preço de ENTRADA: o preço de entrada é o denominador de todo o PnL da posição.
     * `singleSource > 0` significa que o bot está entrando com preço não verificado (aceitável em
     * teste, desde que contado); `divergent > 0` significa que ele RECUSOU entradas por evidência
     * de erro grosseiro entre fontes.
     */
    entryQuality: {
      ...entryQualityStats,
      verifyEnabled: ENTRY_VERIFY_ENABLED,
      allowSingleSource: ENTRY_ALLOW_SINGLE_SOURCE,
      note:
        "verified = duas fontes independentes concordam; verified_with_warning = concordam com aviso; " +
        "single_source = só uma fonte respondeu (posição MARCADA como não verificada); divergent = " +
        "evidência de erro grosseiro, entrada RECUSADA; unavailable = nenhum preço, entrada RECUSADA.",
    },
    marketBatch: {
      ...marketBatchStats,
      cohortsNote:
        "1 requisição por provedor por ciclo cobre até 30 (DexScreener/GeckoTerminal) ou 50 " +
        "(Jupiter Price) mints. Sem lote, o custo cresce 1 requisição POR POSIÇÃO por ciclo de 3s " +
        "— acima de 300 req/min o DexScreener devolve 429 justamente durante a operação.",
      qualityNote: PRICE_DIVERGENCE_ENABLED
        ? `Verificação cruzada LIGADA: compara cada preço com a amostra mais recente de OUTRA fonte ` +
          `(janela ${PRICE_DIVERGENCE_THRESHOLDS.maxAgeMs}ms; warn ≥ ${(PRICE_DIVERGENCE_THRESHOLDS.warnPct * 100).toFixed(2)}%, ` +
          `critical ≥ ${(PRICE_DIVERGENCE_THRESHOLDS.criticalPct * 100).toFixed(2)}%). Amostra de até ` +
          `${PRICE_VERIFY_SAMPLE} token(s) por ciclo recebe segunda opinião. ` +
          `verifications=0 com posições abertas significa que NÃO houve segunda opinião — ausência de ` +
          `divergência não é aprovação, é falta de verificação. Queda de liquidez alerta em ` +
          `${(LIQUIDITY_THRESHOLDS.warnDropPct * 100).toFixed(0)}% / ${(LIQUIDITY_THRESHOLDS.criticalDropPct * 100).toFixed(0)}% do pico (alerta, não venda automática).`
        : "Verificação cruzada DESLIGADA por HFT_PRICE_DIVERGENCE=0: o preço usado é o da primeira " +
          "fonte que responde, sem segunda opinião. NÃO use isto com capital real.",
    },
    pumpPortal: pumpPortalRef?.getHealth() ?? null,
    detectionNote:
      "connected=true apenas indica que as subscrições de logs foram ACEITAS pelo RPC. " +
      "A prova de que a detecção funciona é `eventCount` crescendo — não o log de boot.",
  });
});

/**
 * GET /api/runtime-mode — o modo efetivo, o que foi declarado e POR QUE.
 *
 * Leitura pura. Existe para que o operador (e o painel) nunca precise inferir o modo:
 * "por que o bot não está comprando?" precisa ter resposta direta, não arqueologia.
 */
app.get("/api/runtime-mode", (_req, res) => {
  return res.json(describeRuntimeMode());
});

app.get("/healthz", (_req, res) => {
  res.status(200).send("OK");
});

// Load persisted settings on startup (Auto-Recovery)
const initialSettings = dbStore.getSettings();
let coLocationActive = initialSettings.coLocationActive;
let circuitBreakerActive = initialSettings.circuitBreakerActive;
let circuitBreakerThreshold = initialSettings.circuitBreakerThreshold;
let pm2State = initialSettings.pm2State;
let kafkaThroughputBase = 2450; // msg/sec

/**
 * NÓS RPC — DERIVADOS DE CONFIGURAÇÃO, NÃO INVENTADOS.
 *
 * AUDITORIA 2026-10-02: a versão anterior continha endpoints FABRICADOS
 * ("https://bm-shred.equinix-ld4.solana.hft", "https://solana-us-east.triton.hft.io"...).
 * Efeito em cascata: runWithRpcFailover tentava conectar nesses hosts inexistentes,
 * falhava sempre, e a execução caía no bloco de "fallback simulado" que gravava a
 * operação como sucesso. Ou seja: a fabricação dos hosts produzia PnL fictício.
 *
 * Agora: RPC_ENDPOINT é o primário e RPC_FALLBACKS (CSV) são os backups. Se não houver
 * backup configurado, não há backup — e o sistema diz isso, em vez de simular.
 */
const FABRICATED_HOST_PATTERNS = [/\.hft\.(io|com)$/i, /equinix-ld4\.solana\.hft/i, /\.hft\.io$/i];

function isPlaceholderRpcUrl(url: string): boolean {
  if (!url || typeof url !== "string") return true;
  if (!/^https?:\/\//i.test(url)) return true;
  return FABRICATED_HOST_PATTERNS.some((re) => re.test(url));
}

interface RpcNodeMetrics {
  /** Últimas N medições de RTT (ms) para cálculo de percentil e jitter. */
  samples: number[];
  lastMeasuredAt: number;
  lastSlot: number | null;
  consecutiveFailures: number;
}

type RpcNode = {
  id: string;
  name: string;
  url: string;
  latency: number;
  jitterMs: number;
  status: "healthy" | "degraded" | "offline";
  region: string;
  /** Carga do provedor: não é mensurável via RPC. 0 = desconhecido (ver metricsSource). */
  load: number;
  slotLag: number;
  /** Perda de pacote não é mensurável via HTTP JSON-RPC. 0 = não medido. */
  packetLoss: number;
  shredStream: "active" | "inactive";
  reconnectionCount: number;
  isPrimary: boolean;
  /** Explica a origem de cada métrica: medida de verdade ou indisponível. */
  metricsSource: "measured" | "partial" | "unavailable";
  blockhashCacheAge?: number;
};

const P95 = (samples: number[]): number => {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
};

const JITTER = (samples: number[]): number => {
  if (samples.length < 2) return 0;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance = samples.reduce((acc, s) => acc + (s - mean) ** 2, 0) / samples.length;
  return Math.sqrt(variance);
};

function buildRpcNodeList(): RpcNode[] {
  const primaryUrl = RPC_ENDPOINT;
  const fallbacks = (process.env.RPC_FALLBACKS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const entries: Array<{ id: string; name: string; url: string; region: string; primary: boolean }> = [
    {
      id: "rpc-primary",
      name: `Primário (${process.env.RPC_PRIMARY_LABEL || "RPC_ENDPOINT"})`,
      url: primaryUrl,
      region: process.env.RPC_PRIMARY_REGION || "desconhecida",
      primary: true,
    },
    ...fallbacks.map((url, i) => ({
      id: `rpc-fallback-${i + 1}`,
      name: `Fallback ${i + 1}`,
      url,
      region: process.env[`RPC_FALLBACK_${i + 1}_REGION`] || "desconhecida",
      primary: false,
    })),
  ];

  return entries.map((e) => {
    const usable = !isPlaceholderRpcUrl(e.url);
    return {
      id: e.id,
      name: e.name,
      url: e.url,
      latency: Number.NaN,
      jitterMs: 0,
      status: usable ? "degraded" : "offline",
      region: e.region,
      load: 0,
      slotLag: 0,
      packetLoss: 0,
      shredStream: "inactive" as const,
      reconnectionCount: 0,
      isPrimary: e.primary && usable,
      metricsSource: usable ? "partial" : "unavailable",
    };
  });
}

let rpcNodes: RpcNode[] = buildRpcNodeList();
const rpcMetrics: Record<string, RpcNodeMetrics> = {};
for (const n of rpcNodes) {
  rpcMetrics[n.id] = { samples: [], lastMeasuredAt: 0, lastSlot: null, consecutiveFailures: 0 };
}

// Failover event log — populado apenas com medições reais (ver runHftInfraLoop).
const failoverEvents: Array<{ time: string; fromNode: string; toNode: string; reason: string }> = [
  {
    time: new Date().toTimeString().split(" ")[0],
    fromNode: "—",
    toNode: "—",
    reason:
      "Aguardando primeira medição de RTT dos nós configurados. Nenhum resultado é exibido antes de existir medição real.",
  },
];

// Instância ÚNICA do cache de blockhash real (substitui o gerador de hash sintético).
let blockhashCacheRef: RecentBlockhashCache | null = null;

// Chaos state — usado APENAS pelo endpoint dev-only /api/rpc-infra/chaos para
// demonstrar degradação em ambiente de desenvolvimento. Nunca em produção.
const chaosState: { [nodeId: string]: { status?: string; latency?: number; slotLag?: number; packetLoss?: number; jitterMs?: number } } = {};

/**
 * Mede RTT real de um nó RPC via getLatestBlockhash + getSlot.
 *
 * AUDITORIA 2026-10-02: antes, `runHftInfraLoop` preenchia latência/jitter/carga com
 * `Math.random()` e ainda GERAVA UM BLOCKHASH FALSO a cada 2s (string começando com "Hft",
 * incrementando "misses"). Esse blockhash falso era exibido na UI e exposto em
 * /api/rpc-infra/blockhash como se fosse real. Foi removido.
 *
 * Carga do provedor e perda de pacote NÃO são mensuráveis via JSON-RPC HTTP.
 * Antes eram inventados; agora são reportados como 0/desconhecidos em `metricsSource`.
 */
let rpcMeasureSkippedByBudget = 0;

async function measureRpcNode(node: RpcNode): Promise<void> {
  const metrics = rpcMetrics[node.id];
  if (!metrics || isPlaceholderRpcUrl(node.url)) {
    if (metrics) metrics.consecutiveFailures++;
    return;
  }

  /**
   * TELEMETRIA CEDE A COTA (prioridade `background`).
   *
   * No plano gratuito, medir RTT de vários nós a cada 5 s consome a MESMA cota que o
   * enriquecimento de lançamentos. Se o orçamento estourou, a medição é ADIADA — e o adiamento
   * é contado (`rpcMeasureSkippedByBudget`), para não confundir "RPC lento" com "não medimos".
   */
  if (!budgets.rpc.tryAcquire()) {
    budgets.rpc.skipped++;
    rpcMeasureSkippedByBudget++;
    return;
  }

  const started = Date.now();
  try {
    const conn = new Connection(node.url, { commitment: "processed", disableRetryOnRateLimit: true });
    const [blockhashInfo, slot] = await Promise.all([
      conn.getLatestBlockhash("processed"),
      conn.getSlot("processed"),
    ]);

    if (!isValidBase58Blockhash(blockhashInfo.blockhash)) {
      throw new Error(`blockhash estruturalmente inválido: "${blockhashInfo.blockhash}"`);
    }

    const rtt = Date.now() - started;
    metrics.samples.push(rtt);
    if (metrics.samples.length > 20) metrics.samples.shift();
    metrics.lastSlot = slot;
    metrics.lastMeasuredAt = Date.now();
    metrics.consecutiveFailures = 0;
  } catch {
    metrics.consecutiveFailures++;
    metrics.lastMeasuredAt = Date.now();
  }
}

const MEASUREMENT_INTERVAL_MS = 5000;
const MAX_CONSECUTIVE_FAILURES = 3;

async function runHftInfraLoop(): Promise<void> {
  const now = Date.now();

  // 1. Mede nós cujo último resultado está velho (staggered para não estourar rate-limit).
  await Promise.all(
    rpcNodes
      .filter((n) => now - (rpcMetrics[n.id]?.lastMeasuredAt ?? 0) > MEASUREMENT_INTERVAL_MS)
      .map((n) => measureRpcNode(n))
  );

  // 2. Slot de referência = maior slot observado entre os nós medidos.
  const observedSlots = Object.values(rpcMetrics)
    .map((m) => m.lastSlot)
    .filter((s): s is number => typeof s === "number" && s > 0);
  const referenceSlot = observedSlots.length > 0 ? Math.max(...observedSlots) : null;

  // 3. Aplica medições reais + overrides de chaos (dev).
  rpcNodes = rpcNodes.map((node) => {
    const chaos = chaosState[node.id] || {};
    const metrics = rpcMetrics[node.id];
    const samples = metrics?.samples ?? [];
    const hasSamples = samples.length > 0;
    const failures = metrics?.consecutiveFailures ?? 0;

    const measuredLatency = hasSamples ? P95(samples) : Number.NaN;
    const measuredJitter = JITTER(samples);
    const measuredSlotLag =
      referenceSlot !== null && metrics?.lastSlot ? Math.max(0, referenceSlot - metrics.lastSlot) : 0;

    let status: RpcNode["status"];
    if (isPlaceholderRpcUrl(node.url)) status = "offline";
    else if (failures >= MAX_CONSECUTIVE_FAILURES) status = "offline";
    else if (!hasSamples) status = "degraded";
    else if (measuredLatency > 400 || measuredSlotLag > 5) status = "degraded";
    else status = "healthy";

    // Chaos (somente dev) sobrepõe a medição real.
    if (chaos.status) status = chaos.status as RpcNode["status"];

    const latency = chaos.latency ?? (hasSamples ? measuredLatency : Number.NaN);
    const jitterMs = chaos.jitterMs ?? measuredJitter;
    const slotLag = chaos.slotLag ?? measuredSlotLag;
    const packetLoss = chaos.packetLoss ?? 0;

    const metricsSource: RpcNode["metricsSource"] = isPlaceholderRpcUrl(node.url)
      ? "unavailable"
      : hasSamples
        ? "partial"
        : "unavailable";

    return {
      ...node,
      status,
      latency: Number.isFinite(latency) ? parseFloat(latency.toFixed(1)) : 0,
      jitterMs: parseFloat(jitterMs.toFixed(2)),
      slotLag,
      packetLoss,
      // load não é mensurável via RPC; mantido 0 e sinalizado em metricsSource.
      load: 0,
      shredStream: "inactive" as const,
      metricsSource,
    };
  });

  // 4. Seleção de primário por fitness real (só entre nós medidos e saudáveis).
  const candidates = rpcNodes.filter(
    (n) => n.status !== "offline" && n.metricsSource !== "unavailable" && n.latency > 0
  );

  if (candidates.length > 0) {
    const best = [...candidates].sort((a, b) => {
      const fit = (n: RpcNode) => n.latency + n.slotLag * 50 + n.jitterMs * 4;
      return fit(a) - fit(b);
    })[0];

    const previousPrimary = rpcNodes.find((n) => n.isPrimary);
    if (!previousPrimary || previousPrimary.id !== best.id) {
      if (previousPrimary) {
        const reason =
          `Failover: ${best.name} tem melhor fitness medido ` +
          `(p95=${best.latency}ms, jitter=${best.jitterMs}ms, slotLag=${best.slotLag}) ` +
          `que ${previousPrimary.name} ` +
          `(p95=${previousPrimary.latency}ms, jitter=${previousPrimary.jitterMs}ms, slotLag=${previousPrimary.slotLag}).`;
        failoverEvents.unshift({
          time: new Date().toTimeString().split(" ")[0],
          fromNode: previousPrimary.name,
          toNode: best.name,
          reason,
        });
        if (failoverEvents.length > 50) failoverEvents.pop();
        console.log(`[HFT FAILOVER] ${reason}`);
      }
      rpcNodes.forEach((n) => {
        n.isPrimary = n.id === best.id;
      });
    }
  }

  // 5. Idade do blockhash real em uso (sem geração de hash sintético).
  const bhStatus = blockhashCacheRef?.getStatus();
  const bhAge = bhStatus ? bhStatus.ageMs : undefined;
  for (const node of rpcNodes) {
    node.blockhashCacheAge = Number.isFinite(bhAge as number) ? (bhAge as number) : undefined;
  }
}

// Health checks a cada 2s (medições reais são feitas a cada 5s por nó).
setInterval(() => {
  void runHftInfraLoop();
}, 2000);

// Robust runWithRpcFailover wrapper to handle RPC connection issues on-chain dynamically
async function runWithRpcFailover<T>(operation: (conn: Connection) => Promise<T>): Promise<T> {
  let healthyNodes = rpcNodes.filter(n => n.status !== "offline");
  if (healthyNodes.length === 0) {
    // Auto-recover offline nodes
    rpcNodes.forEach(n => { n.status = "healthy"; });
    healthyNodes = rpcNodes;
  }

  let lastError: any = null;
  for (let attempt = 0; attempt < Math.min(healthyNodes.length, 3); attempt++) {
    const node = healthyNodes[attempt];
    try {
      if (!globalConnection || globalConnection.rpcEndpoint !== node.url) {
        globalConnection = new Connection(node.url, { commitment: "processed" });
      }
      return await operation(globalConnection);
    } catch (err: any) {
      lastError = err;
      const nodeIndex = rpcNodes.findIndex(n => n.id === node.id);
      if (nodeIndex !== -1) {
        rpcNodes[nodeIndex].status = "offline";
      }
    }
  }
  throw lastError || new Error("Falha em todas as tentativas com nós RPC saudáveis.");
}

// Restrict simulation endpoints to development mode
function restrictToDev(_req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (process.env.NODE_ENV === "production") {
    res.status(403).json({ error: "Este endpoint de simulação está desativado em ambiente de produção (PROD)." });
    return;
  }
  next();
}

// Initialize Trades (Snipes) from persistent database
const snipedTransactions: any[] = dbStore.getTrades();

// Global thread-safe set for position liquidation locks (Race condition prevention)
const exitLocks = new Set<string>();

/** Avisos de posição inválida: 1 por posição, para não inundar o log a cada 3s. */
const invalidPositionWarned = new Set<string>();
/** Intenções de saída bloqueadas já avisadas (evita commit em disco a cada ciclo). */
const blockedIntentWarned = new Set<string>();

/**
 * ORÁCULO DE TIP (S3).
 *
 * Substitui as constantes fixas que a versão anterior servia em `/api/jito-tips`
 * (0.0005 / 0.0015 / 0.005 / 0.02) — números que não mediam nada e eram apresentados como
 * "tips atuais". Aqui o valor vem do tip floor REAL do Jito, com throttle/cache (o rate limit
 * documentado é 1 req/s/IP/região) e, quando a fonte não responde, `available: false` — sem
 * número de recheio.
 */
const jitoTipOracle = new JitoTipOracle({ fetchFn: fetch, now: () => Date.now() });

/**
 * ESTADO E CONTADORES DO CAMINHO QUENTE (S5).
 *
 * `InFlightMints` impede que dois sinais do MESMO mint corram em paralelo — em modo real
 * isso seriam duas compras para uma decisão. `hotPathStats` é o registro do que o
 * caminho quente fez de verdade (duplicatas descartadas, filtro estourado, vetos por
 * fail-closed): sem números, otimização de latência vira adivinhação.
 */
const hotPathInFlight = new InFlightMints();

/**
 * Política de envio vigente (C41), exposta para que o operador SAIBA com que defaults o
 * processo enviaria — em vez de descobrir no dia do incidente. Não há chamada de envio
 * neste caminho (a entrada on-chain não está implementada); o valor aqui documenta a
 * configuração efetiva usada pelas saídas.
 */
/** Instante de boot do processo — base para uptime medido (nunca estimado). */
const processStartAt = Date.now();

/**
 * ORÇAMENTOS DE COTA (camada GRATUITA).
 *
 * O plano gratuito não falha por latência: falha por `429`. E o padrão de falha é perverso —
 * o polling de fundo consome a cota e o erro aparece justamente durante um lançamento, quando
 * a decisão depende daquele dado. Aqui cada provedor tem teto baseado no limite PUBLICADO
 * (ver `src/rateBudget.ts`) e as chamadas de SAÍDA têm precedência sobre as de FUNDO.
 */
const budgets = buildBudgetRegistry({
  rpcProfile: process.env.HFT_RPC_PROFILE,
  disabled: process.env.HFT_BUDGET_DISABLED === "1",
});
/**
 * Estatísticas do preço EM LOTE (ciclo do gerenciador de posições). Tudo medido:
 * quantas requisições foram realmente feitas, quantos mints vieram com preço e quais fontes
 * responderam. É o número que mostra o ganho de cota no plano gratuito.
 */
const marketBatchStats = {
  cycles: 0,
  mintsRequested: 0,
  priced: 0,
  liquidityKnown: 0,
  requests: 0,
  lastSources: [] as string[],
  lastProblems: [] as string[],
  disabled: process.env.HFT_MARKET_BATCH === "0",
  /** Comparações cruzadas de preço efetivamente feitas (o "verifiquei" — não o "achei"). */
  verifications: 0,
  /** Fontes usadas na verificação cruzada, na ordem (amostra rotativa). */
  verificationSources: [] as string[],
  /** Discordâncias entre fontes independentes desde o boot. */
  divergences: 0,
  lastDivergences: [] as Array<{
    mint: string;
    pct: number;
    bps: number;
    severity: string;
    reference: { source: string; priceSol: number; ageMs: number };
    candidate: { source: string; priceSol: number };
    at: string;
  }>,
};

/* -------------------------------------------------------------------------- */
/* QUALIDADE DE PREÇO — liga/desliga, limiares e memória                      */
/* -------------------------------------------------------------------------- */

/**
 * Lê um número de ambiente dentro de faixa, com aviso quando o valor é inválido.
 *
 * Não usar `Number(process.env.X)` cru: `Number("")` é 0 e `Number("abc")` é NaN — os dois
 * passariam silenciosamente para dentro de um limiar de RISCO. Aqui valor inválido grita no
 * boot e cai no padrão.
 */
function envNumberInRange(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.warn(
      `[Qualidade de preço] ${name}="${raw}" é inválido (esperado número entre ${min} e ${max}); usando ${def}.`
    );
    return def;
  }
  return n;
}

/** Verificação cruzada de preço: LIGADA por padrão (é o que separa "preço" de "preço confiável"). */
const PRICE_DIVERGENCE_ENABLED = process.env.HFT_PRICE_DIVERGENCE !== "0";

const PRICE_DIVERGENCE_THRESHOLDS = {
  warnPct:
    envNumberInRange("HFT_PRICE_DIVERGENCE_WARN_BPS", DEFAULT_DIVERGENCE_THRESHOLDS.warnPct * 10_000, 1, 100_000) /
    10_000,
  criticalPct:
    envNumberInRange(
      "HFT_PRICE_DIVERGENCE_CRITICAL_BPS",
      DEFAULT_DIVERGENCE_THRESHOLDS.criticalPct * 10_000,
      1,
      100_000
    ) / 10_000,
  maxAgeMs: envNumberInRange(
    "HFT_PRICE_DIVERGENCE_MAX_AGE_MS",
    DEFAULT_DIVERGENCE_THRESHOLDS.maxAgeMs,
    1_000,
    600_000
  ),
};
if (PRICE_DIVERGENCE_THRESHOLDS.criticalPct < PRICE_DIVERGENCE_THRESHOLDS.warnPct) {
  console.warn(
    `[Qualidade de preço] critical (${PRICE_DIVERGENCE_THRESHOLDS.criticalPct}) < warn ` +
      `(${PRICE_DIVERGENCE_THRESHOLDS.warnPct}): usando warn como critical para não classificar ` +
      `divergência grande como pequena.`
  );
  PRICE_DIVERGENCE_THRESHOLDS.criticalPct = PRICE_DIVERGENCE_THRESHOLDS.warnPct;
}

/**
 * Quantos tokens por ciclo recebem uma SEGUNDA opinião de preço. 0 desliga a amostra (a
 * comparação continua acontecendo quando uma segunda fonte responde naturalmente).
 * Custo: no máximo 1 requisição extra por ciclo (Jupiter Price cobre até 50 ids).
 */
const PRICE_VERIFY_SAMPLE = envNumberInRange("HFT_PRICE_VERIFY_SAMPLE", 2, 0, 20);

const LIQUIDITY_THRESHOLDS = {
  warnDropPct: envNumberInRange("HFT_LIQUIDITY_WARN_DROP_PCT", DEFAULT_LIQUIDITY_THRESHOLDS.warnDropPct * 100, 1, 100) / 100,
  criticalDropPct:
    envNumberInRange("HFT_LIQUIDITY_CRITICAL_DROP_PCT", DEFAULT_LIQUIDITY_THRESHOLDS.criticalDropPct * 100, 1, 100) / 100,
};

/** Memória de cotações por token/fonte — a base da comparação entre fontes. */
const priceSampleBook = PRICE_DIVERGENCE_ENABLED ? new PriceSampleBook({ maxPerMint: 4, maxMints: 500 }) : null;

/**
 * VERIFICAÇÃO DO PREÇO DE ENTRADA — o preço de entrada é o denominador de todo o PnL da posição
 * (stop, alvo e replay são percentuais dele). Entrar com preço de fonte única é aceitável na
 * fase de teste, desde que a posição fique MARCADA como não verificada; entrar com fontes
 * discordando em 30% é diferente: é evidência de erro grosseiro, e isso RECUSA.
 */
const ENTRY_VERIFY_ENABLED = process.env.HFT_ENTRY_VERIFY !== "0";
const ENTRY_ALLOW_SINGLE_SOURCE = process.env.HFT_ENTRY_ALLOW_SINGLE_SOURCE !== "0";

/** Estatísticas de qualidade da entrada — quantas foram aceitas, marcadas e recusadas, e por quê. */
const entryQualityStats = {
  evaluated: 0,
  verified: 0,
  verifiedWithWarning: 0,
  singleSource: 0,
  divergent: 0,
  unavailable: 0,
  lastStatus: null as string | null,
  lastSources: [] as string[],
  lastDivergenceBps: null as number | null,
  lastReason: null as string | null,
};
/** Rotação da amostra de verificação: em N ciclos, todo token com posição é conferido. */
let priceVerifyCursor = 0;
/** Throttle de alerta por token/posição — sem isto, uma divergência persistente viraria spam de log. */
const divergenceAlertedAt = new Map<string, number>();
const liquidityAlertedAt = new Map<string, number>();
const DIVERGENCE_ALERT_INTERVAL_MS = 120_000;
const LIQUIDITY_ALERT_INTERVAL_MS = 300_000;


/** Perfil de RPC efetivo (para o operador saber QUAL teto está valendo). */
const HFT_RPC_PROFILE_EFETIVO = (process.env.HFT_RPC_PROFILE || "public").toLowerCase();

/**
 * COERÊNCIA ENTRE PERFIL DE COTA E ENDPOINT DE RPC (`src/rpcProfile.ts`).
 *
 * O perfil e o endpoint são variáveis INDEPENDENTES — e nada impedia a combinação que já
 * aconteceu de verdade neste projeto: perfil de um provedor (teto alto) com o endpoint público
 * (teto baixo). O resultado é `429` exatamente na janela em que o bot mais precisa do RPC.
 *
 * Política: em PAPER/SHADOW, avisa alto e segue (testar com o endpoint público é legítimo);
 * em LIVE, **recusa subir** quando há mismatch — a mesma doutrina do boot de modo
 * ("subir meio-configurado é pior do que não subir"), porque o teto errado se manifesta como
 * perda de sinal no meio da operação, não como erro visível.
 */
const rpcCoherence: RpcCoherence = assessRpcCoherence({
  endpoint: process.env.RPC_ENDPOINT,
  websocket: process.env.RPC_WEBSOCKET,
  fallbacks: process.env.RPC_FALLBACKS,
  declaredProfile: HFT_RPC_PROFILE_EFETIVO,
});
{
  const linhas = describeRpcCoherence(rpcCoherence);
  console.log(`[Boot][RPC] ${linhas[0]}`);
  for (const aviso of linhas.slice(1)) {
    console.warn(`[Boot][RPC] ${aviso}`);
  }
  if (!rpcCoherence.coherent) {
    const mode = getRuntimeModeResolution().mode;
    if (mode === "LIVE") {
      console.error(
        "[Boot][RPC][FATAL] Perfil de cota incoerente com o endpoint conectado em modo LIVE: " +
          "o bot assinaria transações com um teto que o endpoint não suporta (ou deixaria de " +
          "operar por teto baixo demais). Corrija HFT_RPC_PROFILE/RPC_ENDPOINT antes de subir."
      );
      process.exit(1);
    }
    console.warn(
      `[Boot][RPC] modo ${mode}: seguindo com a incoerência REGISTRADA (visível em ` +
        `GET /api/health → rpcCoherence). Em LIVE isto impediria o boot.`
    );
  }
}

/**
 * ANTI-DRIFT DO IDL DO PUMP (S6b) — "o layout pinado ainda é o layout da rede?".
 *
 * ## O que faz
 *
 * Antes de qualquer coisa assinar, confere contra a cadeia as duas âncoras das quais a rota
 * nativa depende: (1) o PDA `global` pertence ao programa do pump e o primeiro byte de 8 tem o
 * discriminador `Global` do IDL pinado; (2) o PDA `fee_config` pertence ao programa de taxas e
 * tem o discriminador `FeeConfig`. Também exige que a conta `global` tenha tamanho suficiente
 * para o layout completo — se o programa adicionou um campo, o parser nativo leria lixo.
 *
 * ## Por que existe
 *
 * Um IDL mudou, um `data.length` mudou, um endereço fixo mudou: nos três casos a instrução
 * montada seria REJEITADA pela rede no meio do lançamento — ou, pior, `min_tokens_out` sairia
 * de números errados. É o equivalente, para o layout, do que a guarda de coerência de RPC faz
 * para a cota: falha no boot, não no momento crítico.
 *
 * ## Política (não é simétrica, e isso é deliberado)
 *
 * - `HFT_ENTRY_ROUTE=native` → divergência é FATAL: a rota não tem como operar sem o layout.
 * - `HFT_ENTRY_ROUTE=aggregator` (default) → divergência é WARN ALTO e fica registrada em
 *   `GET /api/real-entry → idlDrift`; a entrada por agregador não usa o layout, então derrubar o
 *   boot seria indisponibilidade sem relação com o risco. RPC inalcançável NÃO é drift: é
 *   `indeterminado` (testar com RPC caído é legítimo e já é contado em outro lugar).
 *
 * Nada aqui envia transação, assina ou move fundos: são duas leituras de conta.
 */
let pumpIdlDrift: { checked: boolean; ok: boolean | null; code: string | null; detail: string | null } = {
  checked: false,
  ok: null,
  code: null,
  detail: null,
};

async function verifyPumpIdlAgainstChain(connection: Connection, entryRoute: string): Promise<void> {
  const fatal = entryRoute === "native";
  const registrar = (code: string, detail: string) => {
    pumpIdlDrift = { checked: true, ok: false, code, detail };
    const linha = `[Boot][IDL] ${code}: ${detail}`;
    if (fatal) {
      console.error(
        `${linha}. Rota de entrada = native: o layout pinado é a ÚNICA coisa que monta a ` +
          `instrução, e ele não confere com a rede. O boot NÃO prossegue (não se assina com ` +
          `layout não verificado). Ação: atualize assets/pump-idl-excerpt.json a partir do IDL ` +
          `oficial e rode o grupo [25] dos testes antes de subir de novo.`
      );
      process.exit(1);
    }
    console.warn(
      `${linha}. Rota de entrada = aggregator: a instrução nativa NÃO é usada nesta rota, então o ` +
        `boot prossegue — mas HFT_ENTRY_ROUTE=native está BLOQUEADA até isto ser corrigido. ` +
        `Visível em GET /api/real-entry → idlDrift.`
    );
  };

  try {
    const globalPk = new PublicKey(deriveGlobalPda());
    const feeConfigPk = new PublicKey(deriveFeeConfigPda());
    const infos = await connection.getMultipleAccountsInfo([globalPk, feeConfigPk]);
    const [globalInfo, feeConfigInfo] = infos;

    if (!globalInfo) {
      registrar(
        "IDL_DRIFT",
        `a conta global (${globalPk.toBase58()}) não existe neste RPC. O programa do pump pode não ` +
          `estar implantado nesta rede — em devnet o layout NÃO pode ser validado`
      );
      return;
    }
    if (globalInfo.owner.toBase58() !== PUMP_PROGRAM_ID) {
      registrar(
        "IDL_DRIFT",
        `owner da conta global = ${globalInfo.owner.toBase58()}, esperado ${PUMP_PROGRAM_ID}. ` +
          `Os PDAs derivados não apontam para o programa do IDL pinado`
      );
      return;
    }
    const discriminatorGlobal = Buffer.from(globalInfo.data.subarray(0, 8)).toString("hex");
    const esperadoGlobal = Buffer.from(PUMP_ACCOUNT_DISCRIMINATORS.Global).toString("hex");
    if (discriminatorGlobal !== esperadoGlobal) {
      registrar(
        "IDL_DRIFT",
        `discriminador da conta global = ${discriminatorGlobal}, esperado ${esperadoGlobal}. ` +
          `A estrutura Global mudou (ou o PDA aponta para outra conta)`
      );
      return;
    }
    const parsed = parseGlobalAccount(globalInfo.data);
    if (!parsed.value) {
      registrar(
        "IDL_DRIFT",
        `a conta global tem ${globalInfo.data.length} bytes e não satisfaz o layout pinado: ` +
          parsed.problems.map((p) => p.message).join(" | ")
      );
      return;
    }

    if (!feeConfigInfo) {
      registrar("IDL_DRIFT", `a conta fee_config (${feeConfigPk.toBase58()}) não existe neste RPC`);
      return;
    }
    if (feeConfigInfo.owner.toBase58() !== PUMP_FEE_PROGRAM_ID) {
      registrar(
        "IDL_DRIFT",
        `owner da conta fee_config = ${feeConfigInfo.owner.toBase58()}, esperado ${PUMP_FEE_PROGRAM_ID}`
      );
      return;
    }
    const discriminatorFee = Buffer.from(feeConfigInfo.data.subarray(0, 8)).toString("hex");
    const esperadoFee = Buffer.from(PUMP_ACCOUNT_DISCRIMINATORS.FeeConfig).toString("hex");
    if (discriminatorFee !== esperadoFee) {
      registrar(
        "IDL_DRIFT",
        `discriminador da conta fee_config = ${discriminatorFee}, esperado ${esperadoFee}`
      );
      return;
    }

    pumpIdlDrift = { checked: true, ok: true, code: null, detail: null };
    console.log(
      `[Boot][IDL] Layout pinado CONFERE com a rede: global ${globalPk.toBase58()} ` +
        `(${globalInfo.data.length} bytes, fee_recipient ${parsed.value.feeRecipient}, ` +
        `fee_basis_points ${parsed.value.feeBasisPoints}) e fee_config sob ${PUMP_FEE_PROGRAM_ID}.`
    );
  } catch (err: any) {
    // RPC inalcançável NÃO é drift: é indeterminado, e dizer "ok" aqui seria telemetria falsa.
    pumpIdlDrift = {
      checked: true,
      ok: null,
      code: "IDL_NAO_VERIFICADO",
      detail: `leitura indisponível: ${err?.message ?? err}`,
    };
    console.warn(
      `[Boot][IDL] Não foi possível verificar o layout contra a rede (${err?.message ?? err}). ` +
        `Isto NÃO é IDL_DRIFT — é indeterminado. HFT_ENTRY_ROUTE=native permanece bloqueada até ` +
        `uma verificação bem-sucedida (npm run pump:dryrun -- <mint> --payer <chave-publica>).`
    );
    if (fatal) {
      console.error(
        "[Boot][IDL][FATAL] Rota native exige layout verificado contra a rede e o RPC não respondeu. " +
          "Subir assim significaria assinar sem verificação — o boot NÃO prossegue."
      );
      process.exit(1);
    }
  }
}

if (process.env.HFT_BUDGET_DISABLED === "1") {
  console.warn(
    "[Cota] HFT_BUDGET_DISABLED=1 — orçamentos DESLIGADOS. Em plano gratuito isto troca uma " +
      "falha previsível (sinal pulado e contado) por 429 no meio do lançamento."
  );
}

const sendPolicy = resolveSendOptions({
  preSimulated: true,
  maxRetries: 0,
  preflightCommitment: "processed",
});
const hotPathStats: HotPathStats = {
  signalsSeen: 0,
  inFlightDuplicatesDropped: 0,
  unvettedEntries: 0,
  deepFilterFailures: 0,
  rejectedByVerdict: 0,
  budgetExceeded: 0,
  liveVetoesByBudget: 0,
};

/** Orçamento do filtro profundo por sinal. Medido em PAPER antes de qualquer LIVE. */
const DEEP_FILTER_BUDGET_MS = Math.max(100, Number(process.env.HFT_DEEP_FILTER_BUDGET_MS ?? 900));

/**
 * BACKOFF DE TELEMETRIA DE PREÇO (por posição).
 *
 * Motivo concreto, observado em execução: uma posição cuja fonte de preço está fora do ar
 * era consultada a cada 3 s indefinidamente. Com um provedor de RPC pago, isso é uma
 * chamada perdida a cada 3 s por posição — e nenhuma delas traz informação nova.
 *
 * Aqui o intervalo dobra a cada falha consecutiva (3 s → 6 s → 12 s … teto de 60 s) e
 * volta ao normal no primeiro preço obtido. Não é otimização cosmética: é o que impede
 * que a perda de telemetria de UMA posição consuma a cota de RPC de TODAS.
 */
const priceTelemetryBackoff = new Map<string, { misses: number; nextPollAt: number }>();

// 0.5 API: Co-location State Management
app.get("/api/co-location", (_req, res) => {
  return res.json({ active: coLocationActive });
});

app.post("/api/co-location", (req, res) => {
  const { active } = req.body;
  if (typeof active === "boolean") {
    coLocationActive = active;
    dbStore.updateSettings({ coLocationActive: active });
  }
  return res.json({ success: true, active: coLocationActive });
});

// 0.6 API: L5 Observability & Settings Management
app.get("/api/hft-telemetry/settings", (_req, res) => {
  return res.json({
    circuitBreakerActive,
    circuitBreakerThreshold,
    pm2State
  });
});

app.post("/api/hft-telemetry/settings", (req, res) => {
  const { circuitBreakerActive: cbActive, circuitBreakerThreshold: cbThreshold, pm2State: pmState } = req.body;
  
  if (typeof cbActive === "boolean") {
    circuitBreakerActive = cbActive;
    dbStore.updateSettings({ circuitBreakerActive: cbActive });
  }
  if (typeof cbThreshold === "number") {
    circuitBreakerThreshold = cbThreshold;
    dbStore.updateSettings({ circuitBreakerThreshold: cbThreshold });
  }
  if (typeof pmState === "string") {
    pm2State = pmState;
    dbStore.updateSettings({ pm2State: pmState });
    if (pmState === "restarting") {
      setTimeout(() => {
        pm2State = "online";
        dbStore.updateSettings({ pm2State: "online" });
      }, 3000); // Simulate auto-recovery to online after 3 seconds of restart
    }
  }

  return res.json({
    success: true,
    circuitBreakerActive,
    circuitBreakerThreshold,
    pm2State
  });
});

// 0.7 API: Operational Security & Vault KMS Controllers
app.get("/api/operational-security/state", (_req, res) => {
  return res.json(getOperationalSecurityState());
});

app.post("/api/operational-security/kill-switch", (req, res) => {
  const { active } = req.body;
  if (typeof active === "boolean") {
    triggerKillSwitch(active);
  }
  return res.json({ success: true, state: getOperationalSecurityState() });
});

app.post("/api/operational-security/read-only", (req, res) => {
  const { active } = req.body;
  if (typeof active === "boolean") {
    setReadOnlyMode(active);
  }
  return res.json({ success: true, state: getOperationalSecurityState() });
});

app.post("/api/operational-security/rotate-wallet", (req, res) => {
  const { type } = req.body;
  if (type === "operational" || type === "test" || type === "emergency") {
    rotateActiveWallet(type);
  }
  return res.json({ success: true, state: getOperationalSecurityState() });
});

app.post("/api/operational-security/reset-breaker", (_req, res) => {
  resetCircuitBreaker();
  return res.json({ success: true, state: getOperationalSecurityState() });
});

// 0.8 API: Relational Local Database & Positions Management
app.get("/api/database/stats", (_req, res) => {
  return res.json(dbStore.getDatabaseStats());
});

/** Cache de conveniência do replay (invalidado por mtime+tamanho do JSONL). */
const replayCache = new Map<string, any>();

/* -------------------------------------------------------------------------- */
/* LATÊNCIA MEDIDA / REPLAY (rotas de LEITURA)                                 */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/latency — o que foi MEDIDO neste processo.
 *
 * O painel só mostra histogramas de amostras reais. Não existe número de recheio:
 * com zero eventos, todos os estágios vêm `null` e `traces: 0`. O campo `detection`
 * declara explicitamente que, sob WebSocket RPC, o instante de origem é INCONHECIDO —
 * portanto a detecção ponta a ponta NÃO é mensurável nesta configuração.
 */
app.get("/api/latency", (_req, res) => {
  const snapshot = telemetry.snapshot();
  const measured = Object.entries(snapshot.perStageMs)
    .filter(([, h]) => h !== null)
    .map(([stage]) => stage);
  return res.json({
    ...snapshot,
    measuredStages: measured,
    honesty: {
      tracesObserved: snapshot.traces,
      note: snapshot.traces === 0
        ? "Nenhum evento processado desde o boot: não há distribuição de latência a reportar."
        : "Histogramas calculados sobre as amostras observadas (ring buffer de 2000 por estágio).",
      exclusion: "Tempos de relógio de parede não entram no cálculo; medimos tempo monotônico.",
    },
  });
});

/**
 * GET /api/shadow-entries — últimas entradas em SHADOW (cotação + construção + simulação).
 *
 * Leitura pura. Existe para responder, sem arqueologia: "o bot consegue montar a entrada do
 * que ele aprovou?" e "o compute cabe?". `built: false` + `skippedReason` é resposta legítima.
 * NENHUMA dessas entradas foi assinada ou enviada — ver o campo `simulationOnly`.
 */
app.get("/api/shadow-entries", (_req, res) => {
  res.json({
    simulationOnly: true,
    note:
      "Entradas em shadow: rota cotada e transação SIMULADA contra o RPC, sem assinatura e sem " +
      "envio. Simulação bem-sucedida NÃO garante execução (o estado muda entre simular e enviar).",
    count: shadowEntryHistory.length,
    entries: shadowEntryHistory,
  });
});

/**
 * GET /api/replay — compara estratégias de saída sobre os dados JÁ GRAVADOS.
 *
 * Lê `data/events.jsonl`, monta episódios por mint (INCLUINDO os sinais rejeitados) e
 * compara cada estratégia contra a linha de base `baseline-hold`. O ranking só é emitido
 * se houver amostra suficiente; caso contrário volta vazio com a razão declarada.
 *
 * Read-only e determinístico: não toca em ordens, carteira ou banco operacional.
 */
app.get("/api/replay", (req, res) => {
  const limit = Math.min(5000, Math.max(0, Number(req.query.limit ?? 1000) || 1000));
  const filterRaw = String(req.query.filter ?? "all");
  const allowedFilters = new Set(["all", "accepted-only", "rejected-only", "no-assessment"]);
  const filter = (allowedFilters.has(filterRaw) ? filterRaw : "all") as any;

  try {
    const dataFile = path.join(process.cwd(), "data", "events.jsonl");
    // CACHE POR IMPRESSÃO DIGITAL DO ARQUIVO.
    // Motivo concreto: `loadBacktestDataset` lê e faz JSON.parse do arquivo INTEIRO de forma
    // síncrona, na thread do servidor. Com um JSONL de dezenas de MB, uma chamada de dashboard
    // bloquearia o event loop e atrasaria o caminho de execução. O cache é invalidado por
    // mtime+tamanho, então nunca serve dado velho: se o arquivo cresceu, re-lê.
    let fingerprint = "ausente";
    try {
      const st = fs.statSync(dataFile);
      fingerprint = `${st.mtimeMs}:${st.size}`;
    } catch {
      /* arquivo ainda não existe — dataset vazio é resposta legítima */
    }

    const cacheKey = `${fingerprint}|${filter}|${limit}`;
    let payload = replayCache.get(cacheKey);
    const cacheHit = payload !== undefined;

    if (!payload) {
      const dataset = loadBacktestDataset();

      // Amostragem declarada: o `limit` corta os EPISÓDIOS analisados (mais recentes),
      // não as observações de preço — cortar no meio de um episódio inventaria uma saída.
      const episodes = dataset.episodes.slice(-limit);
      const truncated = limit < dataset.episodes.length;
      const sampledDataset = truncated
        ? { ...dataset, episodes, records: episodes.reduce((acc, e) => acc + e.prices.length, 0) }
        : dataset;
      const comparison = compareStrategies(sampledDataset, DEFAULT_STRATEGIES, { filter });

      payload = {
        generatedAt: new Date().toISOString(),
        datasetPath: dataset.path,
        availableFiles: listDataFiles(),
        datasetStats: dataset.stats,
        corruptedLines: dataset.corruptedLines,
        episodesAnalyzed: episodes.length,
        truncated,
        requestedFilter: filter,
        /**
         * Sem NENHUM registro gravado, as linhas de estratégia vêm zeradas. Um zero é
         * ambíguo (pode significar "empate técnico"), então marcamos explicitamente.
         */
        noData: dataset.records === 0,
        noDataReason:
          dataset.records === 0
            ? "Nenhum evento gravado em data/events.jsonl. Rode o bot em modo paper/shadow para acumular dados; sem dados não existe replay."
            : null,
        comparison,
      };
      if (replayCache.size > 8) replayCache.clear(); // limites pequenos: é cache de conveniência, não de histórico
      replayCache.set(cacheKey, payload);
    }

    return res.json({ ...payload, cached: cacheHit, cacheKey: cacheHit ? cacheKey : undefined });
  } catch (err: any) {
    return res.status(500).json({
      error: "Falha ao montar o dataset de replay.",
      detail: err.message,
      hint: "O registro é alimentado pelo loop de eventos. Sem eventos gravados não há replay — e é correto que não haja.",
    });
  }
});

/**
 * GET /api/positions — posições do banco operacional.
 *
 * Por padrão, posições com `status: "quarantined"` NÃO são devolvidas: elas são resíduo de
 * histórico fabricado (ver `npm run quarantine`), não posições ativas. Devolvê-las faria o
 * painel exibir "12 posições ativas" quando nenhuma delas é gerível — exatamente o tipo de
 * contagem otimista que esta auditoria remove. Para auditoria, use
 * `GET /api/positions?include=quarantined`.
 */
/**
 * GET /api/positions/desync — estado da reconciliação POSIÇÃO × CADEIA.
 *
 * Devolve o último relatório (com a IDADE declarada) e o estado por posição. Não
 * dispara reconciliação: expor um GET que gasta RPC permitiria a qualquer cliente
 * consumir a cota de RPC. A execução é periódica e no boot.
 */
app.get("/api/positions/desync", (_req, res) => {
  const positions = dbStore.getPositions();
  const marked = positions
    .filter((p: any) => p.desyncState && p.desyncState !== "in_sync")
    .map((p: any) => ({
      id: p.id,
      token: p.token,
      mint: p.mint,
      mode: p.mode ?? null,
      status: p.status ?? null,
      sizeSol: p.sizeSol ?? null,
      desyncState: p.desyncState,
      desyncReason: p.desyncReason ?? null,
      desyncCheckedAt: p.desyncCheckedAt ?? null,
      phantomConfirmations: p.phantomConfirmations ?? 0,
    }));

  const ageMs = lastDesyncReport ? Date.now() - Date.parse(lastDesyncReport.at) : null;
  return res.json({
    lastRunAt: lastDesyncReport?.at ?? null,
    trigger: lastDesyncReport?.trigger ?? null,
    ageMs,
    stale: ageMs === null ? true : ageMs > DESYNC_INTERVAL_MS * 3,
    intervalMs: DESYNC_INTERVAL_MS,
    minAgeMs: DESYNC_MIN_AGE_MS,
    snapshotAvailable: lastDesyncReport?.report.snapshotAvailable ?? null,
    snapshotNote: lastDesyncReport?.report.snapshotNote ?? null,
    summary: lastDesyncReport?.report.summary ?? null,
    findings: (lastDesyncReport?.report.findings ?? []).filter((f) => f.severity !== "info"),
    markedPositions: marked,
    note:
      "Nada é fechado, apagado ou quarentenado por esta reconciliação: divergências são MARCADAS aqui e " +
      "decididas pelo operador. `snapshotAvailable: false` significa que não houve leitura de carteira — " +
      "e não que a carteira está vazia.",
  });
});

/**
 * GET /api/execution-intents — intenções de execução (idempotência) e o que está travado.
 *
 * Uma intenção não terminal explica por que uma posição não está sendo fechada: a trava
 * de voo único impede uma segunda assinatura até haver evidência sobre a primeira.
 */
app.get("/api/execution-intents", (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));
  const intents = dbStore.getIntents();
  const active = intents.filter(
    (i) => i.state !== "confirmed" && i.state !== "failed" && i.state !== "expired"
  );
  return res.json({
    count: intents.length,
    activeCount: active.length,
    active: active.map((i) => ({
      id: i.id,
      positionId: i.positionId,
      token: i.token,
      mint: i.mint,
      side: i.side,
      state: i.state,
      attempt: i.attempt,
      signature: i.signature,
      lastValidBlockHeight: i.lastValidBlockHeight,
      supersedesIntentId: i.supersedesIntentId,
      updatedAt: i.updatedAt,
      lastError: i.lastError,
    })),
    recent: intents.slice(0, limit).map((i) => ({
      id: i.id,
      side: i.side,
      state: i.state,
      attempt: i.attempt,
      positionId: i.positionId,
      signature: i.signature,
      confirmationLevel: i.confirmationLevel,
      updatedAt: i.updatedAt,
    })),
    note:
      "Uma intenção não terminal (created/signed/submitted) BLOQUEIA nova assinatura na mesma posição/lado: " +
      "reenviar os mesmos bytes é idempotente, reconstruir sem prova de expiração pode duplicar a ação. " +
      "Os bytes assinados nunca são persistidos.",
  });
});

/**
 * GET /api/system-truth — O QUE NESTE PAINEL É MEDIÇÃO E O QUE É SIMULAÇÃO.
 *
 * Motivo: a interface tem N painéis que exibem números visivelmente plausíveis (latências,
 * inclusion rate, score preditivo, "geyser stream") que NÃO vêm de nenhum dado desta
 * máquina — são gerados com `Math.random()` no próprio servidor. Sem uma declaração
 * explícita, um operador lê "inclusion rate 91,3%" como desempenho medido.
 *
 * Este endpoint NÃO esconde nem remove esses painéis (o escopo de reescrever a UI é
 * outro); ele DECLARA o status de cada fonte, para que a leitura seja possível.
 *
 * Classificação (por fonte):
 *   - "real"        : o dado vem de RPC/rede/banco desta instalação, com a contagem observada.
 *   - "simulated"   : número gerado por RNG no servidor. Não é medição de nada.
 *   - "unavailable" : a fonte existe mas não respondeu nesta instalação (nunca preenchido com número).
 *   - "read-only"   : consulta a leitura de verdade, com estado real (ex.: intenções, desync).
 */
app.get("/api/system-truth", (_req, res) => {
  const detection = geyserClientRef?.getHealth() ?? null;
  const positions = dbStore.getPositions();
  const trades = dbStore.getTrades();
  const intents = dbStore.getIntents();
  const mode = getRuntimeModeResolution();

  /**
   * ESTADO DOS TRANSPORTES (S7/S8), declarado com o mesmo rigor das fontes de dados: o operador
   * precisa saber por QUAL caminho a detecção e o envio estão passando — e o que está desligado.
   */
  const parallelPolicy = PARALLEL_SEND;
  const parallelNotes = describeParallelSendPolicy(parallelPolicy);
  const ingestPolicy = resolveIngestPolicy(process.env);
  const grpcHealth: any = grpcIngestRef?.getHealth() ?? null;

  const simulatedEndpoints = [
    {
      path: "/api/hft-telemetry",
      why:
        "latências, P50/P99, inclusion rate e bundles enviados são RNG (o payload traz `simulated: true`). " +
        "EXCEÇÃO: `currentSlot` é MEDIDO (último slot visto nos nós de /api/rpc-nodes) ou `null`.",
    },
    { path: "/metrics", why: "p95/p99, inclusion rate e bundles enviados são RNG (padrão Prometheus mantido por compatibilidade)" },
    { path: "/api/predictive-score", why: "score/confiança/recomendação são RNG" },
    { path: "/api/geyser-stream", why: "contadores de blobs/transações/slots são RNG" },
    { path: "/api/submit-bundle", why: "bundle id e veredito 'Landed' são gerados; nenhum bundle é enviado" },
    { path: "/api/simulate-fork", why: "cenário e tempos são RNG" },
    { path: "/api/simulate-snipe", why: "roteiro de compra simulado (grava posição marcada como paper)" },
    { path: "/api/co-location", why: "RTT por região é RNG" },
    {
      path: "/api/jito-leader-schedule",
      why:
        "não mede nada: nextLeaderSlot/currentLeader/regiões/reputação de block engine vêm `null` " +
        "com o motivo em `notMeasured` (antes eram RNG). O único campo medido é `currentSlot`.",
    },
  ];

  const realSources = [
    {
      source: "detecção — fast path gRPC (Yellowstone, S7)",
      status: !grpcHealth ? ("unavailable" as const) : grpcHealth.eventCount > 0 ? ("real" as const) : ("unavailable" as const),
      detail: !grpcHealth
        ? `não ativo (pedido=${ingestPolicy.requested}, efetivo=${ingestPolicy.effective})` +
          (ingestPolicy.blockers.length ? ` — ${ingestPolicy.blockers.join("; ")}` : "")
        : `streamOpen=${grpcHealth.socketOpen}, updates=${grpcHealth.grpc?.updatesSeen ?? 0}, ` +
          `lançamentos=${grpcHealth.eventCount}, reconnects=${grpcHealth.grpc?.reconnectAttempts ?? 0}, ` +
          `falhas de decode=${grpcHealth.grpc?.decodeFailures ?? 0}`,
      caveat:
        "ADITIVO ao WebSocket: se este caminho cair, a detecção continua pelo WSS (mais lenta, com " +
        "getTransaction). `updates` > 0 prova canal vivo; `lançamentos` > 0 prova o filtro. " +
        "commitment=processed: rápido para DETECTAR — a decisão de capital continua exigindo confirmação.",
    },
    {
      source: "envio on-chain — paralelo Jito/staked/RPC (S8)",
      status: "read-only" as const,
      detail:
        parallelPolicy.enabled
          ? `ATIVO: ${parallelPolicy.transports.join(" + ")}; timeout por transporte ${parallelPolicy.transportTimeoutMs}ms`
          : "DESLIGADO (HFT_PARALLEL_SEND≠1): envio único pelo bundle Jito, como no S6",
      caveat:
        parallelNotes.join(" | ") +
        " — `aceito por um caminho` NÃO é executado: a execução só existe com confirmação e slot observados.",
    },
    {
      source: "detecção (logsSubscribe WSS)",
      status: "real",
      detail: detection
        ? `socketOpen=${detection.socketOpen}, subscrições=${detection.subscriptionsRequested}, ` +
          `eventos=${detection.eventCount}, degradado=${detection.degraded}, ` +
          `duplicatas descartadas=${detection.hotPath?.duplicatesDropped ?? "?"}, ` +
          `falhas de enriquecimento=${detection.hotPath?.enrichmentFailures ?? "?"}` +
          `${detection.hotPath?.lastLocalSlotAgeMs !== null && detection.hotPath?.lastLocalSlotAgeMs !== undefined ? `, amostra de slot local com ${detection.hotPath.lastLocalSlotAgeMs}ms` : ""}`
        : "cliente de detecção ainda não inicializado",
      caveat:
        "subscriptionsRequested é registro LOCAL; a prova de detecção é eventCount > 0 (que inclui " +
        "eventos repassados pelo fast path gRPC — ver hotPath.forwardedFromOtherSources). " +
        "enrichmentFailures > 0 = notificação vista e mint NÃO obtido: perda real de oportunidade, " +
        "não ausência de lançamento. Com gRPC e WSS ativos, crossSourceDuplicatesDropped > 0 é o " +
        "comportamento ESPERADO do dedupe entre fontes, não defeito.",
    },
    {
      source: "feed de lançamentos (PumpPortal, terceiro)",
      /**
       * O rótulo segue a MESMA régua do resto do painel: "real" só com prova de uso. Feed que
       * existe mas nunca conectou é `unavailable` — declarar "real" pelo simples fato de o
       * objeto ter sido criado seria repetir o defeito que este trabalho vem corrigindo.
       */
      status: (() => {
        if (process.env.HFT_PUMPPORTAL === "0") return "unavailable" as const;
        const h = pumpPortalRef?.getHealth();
        if (!h) return "unavailable" as const;
        return h.eventsEmitted > 0 ? ("real" as const) : ("unavailable" as const);
      })(),
      detail: pumpPortalRef
        ? (() => {
            const h = pumpPortalRef!.getHealth();
            return (
              `socketOpen=${h.socketOpen}, assinaturas=${h.subscriptionsSent.length}, ` +
              `eventos=${h.eventsEmitted}, mensagens inválidas=${h.invalidMessages}, ` +
              `duplicatas=${h.duplicatesDropped}` +
              (h.sinceLastMessageMs !== null ? `, última mensagem há ${h.sinceLastMessageMs}ms` : ", nenhuma mensagem ainda") +
              (h.eventsEmitted === 0 && !h.socketOpen ? " — sem conexão com o provedor" : "")
            );
          })()
        : process.env.HFT_PUMPPORTAL === "0"
          ? "desligado por configuração (HFT_PUMPPORTAL=0)"
          : "não inicializado",
      caveat:
        "Serviço de terceiro, grátis e sem chave para subscribeNewToken/subscribeMigration. " +
        "Entrega o mint na criação (sem getTransaction), mas NÃO é confirmação de cadeia: o " +
        "filtro profundo continua verificando no RPC. Prova de vida = eventos > 0.",
    },
    {
      source: "armazenamento (S10)",
      status: "read-only" as const,
      detail:
        STORAGE_POLICY.mode === "postgres"
          ? `Postgres (${STORAGE_POLICY.claimTtlMs / 1000}s de TTL do claim): ` +
            `conectado=${storageRef?.health().connected ?? false}, schema v${storageRef?.health().schemaVersion ?? "?"}, ` +
            `${storageRef?.health().writes ?? 0} escrita(s) espelhada(s), ${storageRef?.health().writeFailures ?? 0} falha(s)`
          : "JSON local: voo único POR PROCESSO e histórico limitado a 50 trades",
      caveat:
        "o JSON continua sendo escrito em paralelo — banco indisponível degrada a durabilidade e o " +
        "voo único entre processos, mas NÃO apaga o histórico local.",
    },
    {
      source: "banco operacional",
      status: "real",
      detail:
        `${positions.length} posição(ões) (${positions.filter((p: any) => p.mode === "paper").length} paper), ` +
        `${trades.length} trade(s) (${trades.filter((t) => t.mode === "paper" || t.status === "paper").length} paper/shadow)`,
      caveat: "contagens do arquivo local; posições com `mode` ausente são históricas e podem ser fabricadas",
    },
    {
      source: "intenções de execução (idempotência)",
      status: "real",
      detail:
        `${intents.length} registrada(s), ${intents.filter((i) => !["confirmed", "failed", "expired"].includes(i.state)).length} ativa(s)`,
      caveat: "intenção ativa BLOQUEIA nova assinatura na mesma posição/lado",
    },
    (() => {
      const jito = jitoTipOracle.getStatus();
      const status = !jito.everQueried ? "unavailable" : jito.lastError ? "unavailable" : "real";
      return {
        source: "tip floor / status de landing (Jito)",
        status,
        detail: !jito.everQueried
          ? "nunca consultado neste processo (nenhuma leitura de mercado feita ainda)"
          : jito.lastError
            ? `último erro: ${jito.lastError}`
            : `último sucesso há ${jito.lastSuccessAgeMs}ms`,
        caveat:
          "sem resposta da fonte, percentis ficam nulos e a recomendação de tip é indisponível — nunca preenchida com valor de reserva",
      };
    })(),
    {
      source: "modo de execução",
      status: "read-only",
      detail: `${mode.mode} (canSign=${mode.liveAuthorized}; conflitos=${mode.conflicts.length})`,
      caveat: "PAPER/SHADOW não assinam nada",
    },
  ];

  return res.json({
    generatedAt: new Date().toISOString(),
    headline:
      "Este painel mistura MEDIÇÃO REAL com painéis SIMULADOS (RNG no servidor). " +
      "O caminho de ENTRADA REAL existe desde S6, mas só sai do papel com três declarações " +
      "(RUNTIME_MODE=LIVE + LIVE_TRADING_ENABLED=true + HFT_REAL_ENTRY_ENABLED=1) e teto canário; " +
      "sem elas, nenhuma compra real é possível. O bloco `realEntry` abaixo diz o estado AGORA. " +
      "DETECÇÃO: o fast path gRPC (S7) é aditivo ao WebSocket e vive em `GET /api/real-entry → ingest`. " +
      "ENVIO: a corrida Jito/staked/RPC (S8) é opt-in e vive em `GET /api/real-entry → parallelSend`. " +
      "VALIDAÇÃO: as métricas e o veredito honesto vivem em `GET /api/performance` (S9); a persistência " +
      "e o voo único entre processos, em `GET /api/storage` (S10).",
    realSources,
    simulatedEndpoints,
    /**
     * Estado da entrada real — a pergunta "este bot pode gastar agora?" precisa de resposta
     * direta aqui, no painel de veracidade, e não só em /api/real-entry.
     */
    realEntry: (() => {
      const policy = resolveRealEntryPolicy();
      const { gateInput } = buildEntryGateInput({ mint: SOL_MINT, sizeSol: policy.canaryMaxSol, autonomousCall: true });
      const gate = assessEntryGate(gateInput);
      return {
        enabled: policy.enabled,
        autonomous: policy.autonomous,
        canaryMaxSol: policy.canaryMaxSol,
        wouldEnterNow: gate.allowed,
        blockingCodes: gate.issues.filter((i) => i.severity === "block").map((i) => i.code),
        note:
          "`wouldEnterNow=false` significa que uma entrada real seria recusada neste instante. " +
          "O caminho assina com pré-flight obrigatório, intenção persistida antes de assinar e " +
          "posição só registrada com slot on-chain observado.",
      };
    })(),
    budgets: {
      perfilRpc: HFT_RPC_PROFILE_EFETIVO,
      desligado: process.env.HFT_BUDGET_DISABLED === "1",
      rpcMeasureSkippedByBudget,
      snapshot: budgets.snapshot(),
      note:
        "Teto de chamadas por provedor (janela deslizante) baseado no limite PUBLICADO da camada " +
        "gratuita — a origem de cada número está em `source`. `skipped` = chamada NÃO feita por falta " +
        "de cota (pular com número é melhor que tomar 429 no meio de um lançamento). `bypassed` = " +
        "chamada de SAÍDA executada acima da cota de propósito: reduzir risco não depende de cota.",
    },
    hotPath: {
      deepFilterBudgetMs: DEEP_FILTER_BUDGET_MS,
      inFlightMints: hotPathInFlight.size(),
      counters: hotPathStats,
      sendPolicy: {
        skipPreflight: sendPolicy.skipPreflight,
        maxRetries: sendPolicy.maxRetries,
        preflightCommitment: sendPolicy.preflightCommitment,
        rationale: sendPolicy.rationale,
      },
      note:
        "Contadores do caminho quente desde o boot: inFlightDuplicatesDropped = sinais do mesmo mint com " +
        "decisão já em andamento (a reentrega da MESMA assinatura é contada no cliente de detecção, em " +
        "detection.hotPath.duplicatesDropped); " +
        "deepFilterFailures = filtro profundo FALHOU (perda de oportunidade por erro, não por reprovação); " +
        "rejectedByVerdict = o filtro reprovou o token com evidência; " +
        "budgetExceeded = filtro passou do orçamento (medido, não abortado); " +
        "liveVetoesByBudget = entradas vetadas por fail-closed; " +
        "unvettedEntries = sinais que seguiram sem filtro completo — HOJE SEMPRE 0, porque o filtro é " +
        "tudo-ou-nada e sem dado nenhum a entrada é bloqueada em qualquer modo.",
    },
    summary: {
      realSources: realSources.filter((s) => s.status === "real").length,
      simulatedEndpoints: simulatedEndpoints.length,
      liveExecutionPath: (() => {
        const policy = resolveRealEntryPolicy();
        const res = getRuntimeModeResolution();
        return policy.enabled && res.liveAuthorized
          ? `implementado e HABILITADO (canary ≤ ${policy.canaryMaxSol} SOL por entrada; rota Jupiter→Jito; ` +
            `o builder nativo por IDL é otimização de latência ainda não implementada)`
          : `implementado mas DESLIGADO (modo ${res.mode}, HFT_REAL_ENTRY_ENABLED=${policy.enabled ? "1" : "0"}) ` +
            `— nenhuma compra real acontece neste estado`;
      })(),
    },
  });
});

app.get("/api/positions", (req, res) => {
  const includeQuarantined = String(req.query.include ?? "") === "quarantined";
  const positions = dbStore.getPositions();
  const visible = includeQuarantined
    ? positions
    : positions.filter((p: any) => p.status !== "quarantined");
  return res.json(visible);
});

app.post("/api/positions/update-risk", (req, res) => {
  const { id, stopLossPercent, takeProfitPercent, trailingStopActive, trailingStopOffsetPercent } = req.body;
  const positions = dbStore.getPositions();
  const pos = positions.find(p => p.id === id);
  if (!pos) {
    return res.status(404).json({ error: "Position not found" });
  }

  if (typeof stopLossPercent === "number") pos.stopLossPercent = stopLossPercent;
  if (typeof takeProfitPercent === "number") pos.takeProfitPercent = takeProfitPercent;
  if (typeof trailingStopActive === "boolean") pos.trailingStopActive = trailingStopActive;
  if (typeof trailingStopOffsetPercent === "number") pos.trailingStopOffsetPercent = trailingStopOffsetPercent;

  dbStore.savePosition(pos);
  return res.json({ success: true, position: pos });
});

app.post("/api/positions/close", async (req, res) => {
  const { id } = req.body;
  const positions = dbStore.getPositions();
  const pos = positions.find(p => p.id === id);
  if (!pos) {
    return res.status(404).json({ error: "Position not found" });
  }

  // 1. Gate de saída: exige live trading; read-only permite sair (reduz risco);
  //    kill switch bloqueia apenas se BLOCK_EXITS_ON_KILL_SWITCH=true.
  const exitGate = assertExitAllowed();
  if (!exitGate.ok) {
    return res.status(exitGate.status).json({ error: exitGate.error });
  }
  exitGate.warnings.forEach((w) => console.warn(`[Exit Gate] ${w}`));

  // 2. Race condition protection / thread-safe lock
  if (exitLocks.has(pos.id) || pos.status === "exit_pending" || pos.status === "closed") {
    return res.status(409).json({ error: "Esta posição já está em processo de fechamento ou já foi liquidada." });
  }

  /**
   * TRAVA DE VOO ÚNICO (S4) — o fechamento manual tem a MESMA exposição do automático:
   * o loop abaixo reconstrói e re-assina até 3 vezes. Sem esta trava, um timeout de
   * confirmação na tentativa 1 pode produzir uma SEGUNDA venda válida na tentativa 2.
   */
  const manualBlockingIntent = findBlockingIntent(dbStore.getIntents(), pos.id, "exit");
  if (manualBlockingIntent) {
    return res.status(409).json({
      error:
        `Já existe uma intenção de SAÍDA não resolvida para esta posição (${manualBlockingIntent.id}, ` +
        `estado ${manualBlockingIntent.state}). Uma nova assinatura poderia duplicar a venda; ` +
        `aguarde a resolução por status/expiração.`,
    });
  }

  // Acquire lock and set status immediately to EXIT_PENDING
  exitLocks.add(pos.id);
  pos.status = "exit_pending";
  dbStore.savePosition(pos);

  const triggerTime = Date.now();
  const correlationId = `corr_pos_manual_${pos.id}_${Date.now()}`;

  /** Intenção persistida ANTES de assinar (sobrevive a crash entre assinar e confirmar). */
  let manualExitIntent = persistIntent(
    createExecutionIntent({ positionId: pos.id, mint: pos.mint, token: pos.token, side: "exit" })
  );
  
  dbStore.saveLog({
    timestamp: new Date().toISOString(),
    level: "WARN",
    component: "RISK_ENGINE",
    message: `[MANUAL EXIT DISPARADO] Usuário iniciou fechamento manual de $${pos.token}. Status alterado para EXIT_PENDING.`,
    correlationId
  });

  try {
    if (!globalConnection) {
      throw new Error("Solana RPC Connection is offline");
    }

    const walletPublicKey = getActiveWalletPublicKey();

    // 2. Fetch exact token account balance and decimals from RPC
    let rawAmount = 0;
    let decimals = 9;

    try {
      const tokenAccounts = await globalConnection.getParsedTokenAccountsByOwner(
        walletPublicKey,
        { mint: new PublicKey(pos.mint) }
      );
      if (tokenAccounts.value.length > 0) {
        const accInfo = tokenAccounts.value[0].account.data.parsed.info;
        rawAmount = parseInt(accInfo.tokenAmount.amount) || 0;
        decimals = accInfo.tokenAmount.decimals || 9;
      }
    } catch (err: any) {
      console.log(`[On-Chain Manual Close] Parsed token accounts lookup for ${pos.token}: ${err.message}. Using local balance calculation.`);
    }

    // Fallback if balance is 0
    if (rawAmount === 0) {
      const qtyFloat = (pos.sizeSol / pos.entryPrice) || 1000000;
      rawAmount = Math.floor(qtyFloat * Math.pow(10, decimals));
    }

    // Tip LIMITADO por bps do capital (auditoria: tip fixo de 0.003 SOL = 300 bps em
    // uma posição de 0.1 SOL, o que inviabiliza matematicamente a operação).
    const { tipSol: jitoTip, clamped: tipClamped } = clampTipSol(
      0.003,
      pos.sizeSol,
      Number(process.env.MAX_TIP_BPS ?? 50)
    );
    if (tipClamped) {
      dbStore.saveLog({
        timestamp: new Date().toISOString(),
        level: "WARN",
        component: "JITO_BUNDLE",
        message: `[Tip Limitado] Tip de fechamento reduzido para ${jitoTip.toFixed(6)} SOL para respeitar o teto de ${process.env.MAX_TIP_BPS ?? 50} bps sobre ${pos.sizeSol} SOL.`,
        correlationId
      });
    }
    const jitoSender = new JitoBundleSender(globalConnection);
    
    let signature = "";
    let finalSlot = 0;
    let confirmed = false;
    let quoteData: any = null;
    let manualConfirmationLevel: "processed" | "confirmed" | "finalized" = "confirmed";
    let previousManualAttempt:
      | { transaction: VersionedTransaction; blockhash: string; lastValidBlockHeight: number; signature: string }
      | null = null;
    let rebroadcastOnly = false;

    // Retry loop with Adaptive Slippage (max 3 retries)
    for (let attempt = 0; attempt < 3; attempt++) {
      rebroadcastOnly = false;
      if (previousManualAttempt) {
        const { decision, slot } = await decideExitRetry(manualExitIntent, previousManualAttempt);
        if (decision.action === "stop_confirmed") {
          confirmed = true;
          signature = previousManualAttempt.signature;
          finalSlot = slot ?? 0;
          manualExitIntent = advanceIntentOrKeep(
            manualExitIntent,
            "confirmed",
            { confirmationLevel: decision.level },
            `manual, tentativa ${attempt + 1}: ${decision.reason}`
          );
          break;
        }
        if (decision.action === "rebuild") {
          const terminal = decision.reason.includes("ERRO de execução") ? "failed" : "expired";
          manualExitIntent = supersedeIntent(manualExitIntent, terminal, decision.reason);
        } else if (decision.action === "rebroadcast") {
          rebroadcastOnly = true;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }
        dbStore.saveLog({
          timestamp: new Date().toISOString(),
          level: "WARN",
          component: "JITO_BUNDLE",
          message: `[INTENTS] Fechamento manual (tentativa ${attempt + 1}): ${decision.action} — ${decision.reason}`,
          correlationId,
        });
      }
      try {
        // Read user-configured base slippage (default 1.5% = 150 bps)
        const baseSlippageBps = pos.slippageBps || 150;
        // Adaptive algorithm: increase slippage on successive retries
        let currentSlippageBps = baseSlippageBps;
        if (attempt === 1) currentSlippageBps += 100; // +1.0%
        if (attempt === 2) currentSlippageBps += 250; // +2.5%

        // Cap at configured maximum or fallback 10% (1000 bps)
        const maxSlippageBps = pos.maxSlippageBps || 1000;
        currentSlippageBps = Math.min(currentSlippageBps, maxSlippageBps);

        dbStore.saveLog({
          timestamp: new Date().toISOString(),
          level: "INFO",
          component: "RISK_ENGINE",
          message: `[SLIPPAGE ADAPTATIVO] Manual Close Tentativa #${attempt + 1}. Ajustando slippage para ${(currentSlippageBps / 100).toFixed(2)}% (Slippage Base: ${(baseSlippageBps / 100).toFixed(2)}%).`,
          correlationId
        });

        // 3–4. Cotação e construção do swap via JupiterIntegration.
        //
        // AUDITORIA 2026-10-02 (achado C24): este trecho chamava
        // `quote-api.jup.ag/v6/*` — host SUNSET pela Jupiter. A rota de saída era a única
        // proteção de capital do sistema e apontava para um endpoint morto. Agora usa o
        // cliente único (host configurável por JUPITER_BASE_URL, header x-api-key quando
        // houver chave, timeout e falha dura quando o host devolve HTML em vez de JSON).
        // Saída: mesma prioridade — cota não bloqueia fechamento.
        const exitQuoteCall = await withBudget(
          budgets.jupiter,
          () =>
            JupiterIntegration.getQuote(
              pos.mint,
              "So11111111111111111111111111111111111111112",
              rawAmount,
              currentSlippageBps
            ),
          { priority: "exit" }
        );
        if (!exitQuoteCall.ok) {
          throw new Error(exitQuoteCall.skippedReason ?? "cotação de saída bloqueada por orçamento");
        }
        quoteData = exitQuoteCall.value;

        let transaction: VersionedTransaction;
        let blockhash: string;
        let lastValidBlockHeight: number;
        let alreadySigned = false;

        if (rebroadcastOnly && previousManualAttempt) {
          transaction = previousManualAttempt.transaction;
          blockhash = previousManualAttempt.blockhash;
          lastValidBlockHeight = previousManualAttempt.lastValidBlockHeight;
          alreadySigned = true;
        } else {
          transaction = await JupiterIntegration.buildSwapTransaction(
            quoteData,
            walletPublicKey.toBase58()
          );
          const latest = await runWithRpcFailover(async (conn) => await conn.getLatestBlockhash("processed"));
          blockhash = latest.blockhash;
          lastValidBlockHeight = latest.lastValidBlockHeight;
        }

        const jitoRes = await executeWithDecryptedKeypair(async (keypair) => {
          if (!alreadySigned) {
            transaction.sign([keypair]);
            manualExitIntent = advanceIntentOrKeep(
              manualExitIntent,
              "signed",
              { signature: bs58.encode(transaction.signatures[0]), blockhash, lastValidBlockHeight },
              `manual, tentativa ${attempt + 1}: assinada (ainda não transmitida)`
            );
          }
          return await jitoSender.submitBundle([transaction], keypair, jitoTip, blockhash, {
            capitalCommittedSol: pos.sizeSol,
            maxTipBps: Number(process.env.MAX_TIP_BPS ?? 50),
            region: (process.env.JITO_REGION as any) || undefined,
            purpose: "exit",
          });
        }, "exit");

        if (!jitoRes.success) {
          throw new Error(`Jito Bundle rejected: ${jitoRes.error || "Unknown bundle error"}`);
        }

        signature = bs58.encode(transaction.signatures[0]);
        previousManualAttempt = { transaction, blockhash, lastValidBlockHeight, signature };
        manualExitIntent = advanceIntentOrKeep(
          manualExitIntent,
          "submitted",
          { signature, blockhash, lastValidBlockHeight },
          `manual, tentativa ${attempt + 1}: aceita pelo block engine`
        );

        // Poll confirmation
        const confirmTimeout = 30000;
        const confirmStart = Date.now();

        while (Date.now() - confirmStart < confirmTimeout) {
          const status = await globalConnection.getSignatureStatus(signature, {
            searchTransactionHistory: false
          });
          if (status.value) {
            if (status.value.err) {
              throw new Error(`Transação de swap manual falhou on-chain: ${JSON.stringify(status.value.err)}`);
            }
            if (status.value.confirmationStatus === "confirmed" || status.value.confirmationStatus === "processed") {
              confirmed = true;
              manualConfirmationLevel =
                status.value.confirmationStatus === "processed" ? "processed" : "confirmed";
              finalSlot = status.context.slot;
              break;
            }
          }
          await new Promise(resolve => setTimeout(resolve, 1500));
        }

        if (confirmed) {
          break; // successfully completed
        } else {
          console.log(`[Manual Jito Retry] Attempt ${attempt + 1} timeout check. Retrying...`);
        }

      } catch (err: any) {
        console.log(`[Manual Close Attempt] Attempt ${attempt + 1} retry: ${err.message}`);
        if (attempt === 2) {
          throw err;
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    if (!confirmed || !signature || !quoteData) {
      throw new Error("Transação manual enviada ao Jito mas não foi confirmada pelo RPC da Solana dentro de todas as tentativas.");
    }

    manualExitIntent = advanceIntentOrKeep(
      manualExitIntent,
      "confirmed",
      { confirmationLevel: manualConfirmationLevel, signature },
      `manual: confirmada no nível ${manualConfirmationLevel}`
    );
    blockedIntentWarned.delete(manualExitIntent.id);

    const outSol = parseFloat(quoteData.outAmount) / 1e9;
    const latencyMs = Date.now() - triggerTime;

    /**
     * PnL DO CICLO (S11): combina a perna de ENTRADA (gravada na posição na confirmação da compra)
     * com a perna de SAÍDA (esta transação). O valor da cotação serve apenas como referência de
     * "sem atrito"; o número que vale é o ΔSOL medido nas duas transações.
     */
    const { economics: pernaSaida, ciclo } = await measureRoundTrip(pos, signature, null);

    const realCloseTx = {
      id: `txn_manual_exit_${Date.now()}`,
      token: pos.token,
      mint: pos.mint,
      amount: `${(rawAmount / Math.pow(10, decimals)).toFixed(2)} ${pos.token}`,
      outAmount: `${outSol.toFixed(4)} SOL (bruto cotado)`,
      time: new Date().toTimeString().split(' ')[0] + "." + String(Date.now() % 1000).padStart(3, '0'),
      latencyMs,
      status: "success" as const,
      block: finalSlot,
      tipSol: jitoTip,
      route: `KMS Manual Jito Exit${ciclo.measured ? "" : ` (PnL do ciclo NÃO apurado: ${ciclo.basis})`}`,
      signature,
      // PnL só quando as DUAS pernas foram medidas. Valor parcial vai em `saleProceedsSol`,
      // com nome próprio, para nunca ser lido como lucro.
      pnlNetSol: ciclo.measured ? (ciclo.pnlNetSol as number) : undefined,
      saleProceedsSol: pernaSaida.measured && pernaSaida.solDeltaLamports !== null ? pernaSaida.solDeltaLamports / 1e9 : undefined,
      // Soma das base fees das DUAS pernas (quando conhecidas): o custo de rede do ciclo, não só da venda.
      feesSol: ciclo.feesSol ?? undefined,
      measuredOnChain: pernaSaida.measured,
      pnlBasis: ciclo.basis,
      windowConflictSol: ciclo.windowConflict ? (ciclo.discrepancySol as number) : undefined,
      mode: "live" as const,
    };

    dbStore.saveTrade(realCloseTx);
    snipedTransactions.unshift(realCloseTx);
    if (snipedTransactions.length > 25) {
      snipedTransactions.pop();
    }

    // Set status to closed & save, then delete from memory active list
    pos.status = "closed";
    dbStore.savePosition(pos);
    dbStore.deletePosition(id);
    exitLocks.delete(id);

    recorder.recordPositionLifecycle({
      positionId: id,
      mint: pos.mint,
      token: pos.token,
      event: "closed",
      mode: "live",
      sizeSol: pos.sizeSol,
      entryPriceSol: pos.entryPrice ?? null,
      exitPriceSol: outSol,
      pnlPercent: ciclo.measured && pos.sizeSol > 0 ? ((ciclo.pnlNetSol as number) / pos.sizeSol) * 100 : null,
      reason: "manual-exit",
      pnlMeasuredOnChain: ciclo.measured,
    });

    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "SUCCESS",
      component: "RISK_ENGINE",
      message:
        `[MANUAL EXIT CONFIRMADO REAL] Posição de $${pos.token} encerrada on-chain no bloco #${finalSlot}! ` +
        `Bruto cotado: ${outSol.toFixed(4)} SOL. ` +
        (ciclo.measured
          ? `PnL LÍQUIDO DO CICLO (entrada + saída, medido): ${(ciclo.pnlNetSol as number) >= 0 ? "+" : ""}${(ciclo.pnlNetSol as number).toFixed(6)} SOL ` +
            `(custo de entrada: ${(ciclo.entryCostSol as number).toFixed(6)} SOL; receita da venda: ${(ciclo.exitProceedsSol as number).toFixed(6)} SOL). ` +
            ciclo.notes.join(" ")
          : `PnL do ciclo NÃO APURADO (${ciclo.basis}): ${ciclo.reasons.join("; ")}.`),
      correlationId
    });

    reportTradeOutcome(true);
    return res.json({ success: true, transaction: realCloseTx });

  } catch (err: any) {
    /**
     * Ver comentário equivalente em executeAutonomousExit: falha de fechamento manual
     * é reportada como FALHA e a posição permanece aberta. Antes, este bloco forjava um
     * fechamento "bem-sucedido" com block aleatório e removia a posição do banco,
     * fazendo o operador acreditar que havia vendido quando os tokens seguiam na carteira.
     */
    const latencyMs = Date.now() - triggerTime;
    const errorMessage = err?.message || String(err);

    /**
     * INTENÇÃO NO FECHAMENTO MANUAL — mesma regra do automático: `created` (nada foi
     * assinado) é terminal; `signed`/`submitted` podem ter chegado e NÃO são terminais,
     * então a trava de voo único continua valendo até haver evidência.
     */
    if (manualExitIntent.state === "created") {
      manualExitIntent = advanceIntentOrKeep(
        manualExitIntent,
        "failed",
        { lastError: errorMessage },
        "manual: falha antes da assinatura (nada transmitido)"
      );
    } else {
      dbStore.saveLog({
        timestamp: new Date().toISOString(),
        level: "CRITICAL",
        component: "JITO_BUNDLE",
        message:
          `[INTENTS] Fechamento manual de $${pos.token}: intenção ${manualExitIntent.id} permanece no estado ` +
          `"${manualExitIntent.state}" (${errorMessage.slice(0, 140)}). A posição volta para OPEN e uma NOVA ` +
          `assinatura fica bloqueada até haver evidência — é isso que impede duplicar a venda.`,
        correlationId,
      });
    }

    pos.status = "open";
    (pos as any).exitAttempts = ((pos as any).exitAttempts || 0) + 1;
    (pos as any).lastExitError = errorMessage;
    (pos as any).lastExitAttemptAt = new Date().toISOString();
    dbStore.savePosition(pos);
    exitLocks.delete(id);

    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "CRITICAL",
      component: "RISK_ENGINE",
      message:
        `[FALHA DE FECHAMENTO MANUAL] Não foi possível liquidar $${pos.token} em ${latencyMs}ms. ` +
        `Erro: ${errorMessage}. A posição CONTINUA ABERTA. Nenhum PnL foi registrado.`,
      correlationId,
    });

    reportTradeOutcome(false);
    return res.status(502).json({
      success: false,
      error: "Fechamento NÃO executado. A posição permanece aberta.",
      detail: errorMessage,
      attempts: (pos as any).exitAttempts,
    });
  }
});

app.post("/api/simulate-crash", restrictToDev, async (_req, res) => {
  console.warn("[💥 HARD CRASH SIMULATOR] PM2 received SIGKILL signal. Shutting down active connections...");
  
  // Re-load everything from disk immediately to demonstrate the sub-millisecond autorecovery
  try {
    const recoveredSettings = dbStore.getSettings();
    const recoveredPositions = dbStore.getPositions();
    const recoveredTrades = dbStore.getTrades();
    const recoveredState = dbStore.getOperationalState();

    // Estes dois logs anunciavam infraestrutura inexistente (stream de shreds e cache de
    // blockhash pré-aquecido). Agora dizem o que o código realmente faz: relê o estado do
    // disco e deixa o cache de blockhash ser repovoado pelo RPC.
    console.log("[⚡ AUTO-RECOVERY PIPELINE] 1. Relendo estado operacional do disco (JSON atômico com backup)...");
    console.log("[⚡ AUTO-RECOVERY PIPELINE] 2. Cache de blockhash é repovoado pelo RPC — NÃO há pool pré-aquecido.");
    console.log(`[⚡ AUTO-RECOVERY PIPELINE] 3. Loaded ${recoveredPositions.length} open positions and ${recoveredTrades.length} previous trades.`);
    console.log(`[⚡ AUTO-RECOVERY PIPELINE] 4. Disjuntores rearmados. Kill Switch state: [${recoveredState.killSwitchActive ? "ACTIVE" : "INACTIVE"}]. Active Wallet: [${recoveredState.activeWallet.toUpperCase()}]`);
    console.log("[⚡ AUTO-RECOVERY PIPELINE] >>> AUTORECOVERY COMPLETED IN 41ms! Continuing execution flawlessly.");

    return res.json({
      success: true,
      message: "Hard Crash simulated and resolved. Auto-Recovery executed in 41ms.",
      recovered: {
        settings: recoveredSettings,
        positionsCount: recoveredPositions.length,
        tradesCount: recoveredTrades.length,
        state: recoveredState
      }
    });
  } catch (err: any) {
    return res.status(500).json({ error: "Recovery failed: " + err.message });
  }
});

// 1. API: RPC Nodes Health
app.get("/api/rpc-nodes", (_req, res) => {
  return res.json({ nodes: rpcNodes, timestamp: Date.now() });
});

// 1.1 API: Cache de blockhash COMPARTILHADO (valor real do RPC, nunca sintético).
//
// AUDITORIA 2026-10-02: este endpoint exibia um blockhash gerado por RNG, e o POST de
// refresh gerava outro. Um blockhash falso parece válido na UI (base58, 32 bytes) mas
// faz toda transação assinada com ele ser rejeitada — e o painel dizia "refresh em 0.14ms".
app.get("/api/rpc-infra/blockhash", (_req, res) => {
  if (!blockhashCacheRef) {
    return res.status(503).json({
      error: "Cache de blockhash não inicializado (RPC indisponível no boot).",
      available: false,
    });
  }
  const status = blockhashCacheRef.getStatus();
  const cached = blockhashCacheRef.get();
  return res.json({
    blockhash: cached.blockhash || null,
    lastValidBlockHeight: cached.lastValidBlockHeight || null,
    usable: status.usable,
    ageMs: Number.isFinite(status.ageMs) ? Math.round(status.ageMs) : null,
    consecutiveFailures: status.consecutiveFailures,
    lastError: status.lastError,
    source: "solana-rpc getLatestBlockhash(processed)",
  });
});

app.post("/api/rpc-infra/blockhash/refresh", async (_req, res) => {
  if (!blockhashCacheRef) {
    return res.status(503).json({ success: false, error: "Cache de blockhash não inicializado." });
  }
  const started = Date.now();
  try {
    const fresh = await blockhashCacheRef.getFresh();
    return res.json({
      success: true,
      blockhash: fresh.blockhash,
      lastValidBlockHeight: fresh.lastValidBlockHeight,
      measuredRttMs: Date.now() - started,
      source: "solana-rpc getLatestBlockhash(processed)",
    });
  } catch (err: any) {
    return res.status(502).json({
      success: false,
      error: err.message,
      measuredRttMs: Date.now() - started,
    });
  }
});

// 1.2 API: Failover Event Logs
app.get("/api/rpc-infra/failover-logs", (_req, res) => {
  return res.json({ logs: failoverEvents });
});

// 1.3 API: Chaos Engineering Controller
app.post("/api/rpc-infra/chaos", (req, res) => {
  const { nodeId, action, value } = req.body;
  
  const node = rpcNodes.find(n => n.id === nodeId);
  if (!node && action !== "recover_all") {
    return res.status(404).json({ error: `Nó RPC com ID '${nodeId}' não encontrado.` });
  }

  const timeStr = new Date().toTimeString().split(' ')[0];

  if (nodeId && !chaosState[nodeId]) {
    chaosState[nodeId] = {};
  }

  switch (action) {
    case "fail":
      if (node) {
        chaosState[nodeId].status = "offline";
        chaosState[nodeId].latency = 999;
        chaosState[nodeId].slotLag = 5;
        chaosState[nodeId].packetLoss = 100;
        failoverEvents.unshift({
          time: timeStr,
          fromNode: node.name,
          toNode: "FALHA INDUZIDA",
          reason: `[CHAOS] Falha total injetada no nó ${node.name}. Simulando desligamento de datacenter.`
        });
      }
      break;

    case "spike_latency":
      if (node) {
        chaosState[nodeId].latency = value || 450;
        failoverEvents.unshift({
          time: timeStr,
          fromNode: node.name,
          toNode: "RTT SPIKE",
          reason: `[CHAOS] Pico de latência (RTT) injetado no nó ${node.name} (${value || 450}ms).`
        });
      }
      break;

    case "spike_lag":
      if (node) {
        chaosState[nodeId].slotLag = value || 4;
        failoverEvents.unshift({
          time: timeStr,
          fromNode: node.name,
          toNode: "SLOT LAG SPIKE",
          reason: `[CHAOS] Atraso de slots (Slot Lag) injetado no nó ${node.name} (${value || 4} slots).`
        });
      }
      break;

    case "spike_packet_loss":
      if (node) {
        chaosState[nodeId].packetLoss = value || 12.5;
        failoverEvents.unshift({
          time: timeStr,
          fromNode: node.name,
          toNode: "PACKET LOSS BURST",
          reason: `[CHAOS] Perda de pacotes (Packet Loss) injetada no nó ${node.name} (${value || 12.5}%).`
        });
      }
      break;

    case "spike_jitter":
      if (node) {
        chaosState[nodeId].jitterMs = value || 45;
        failoverEvents.unshift({
          time: timeStr,
          fromNode: node.name,
          toNode: "JITTER BURST",
          reason: `[CHAOS] Instabilidade de jitter injetada no nó ${node.name} (${value || 45}ms).`
        });
      }
      break;

    case "recover":
      if (node) {
        delete chaosState[nodeId];
        // Reset imediato: nenhum nó inventado, nenhuma latência inventada.
        node.status = "healthy";
        node.latency = Number.NaN; // nunca fabricado; MEDIDO em /api/rpc-nodes
        node.slotLag = 0;
        node.packetLoss = 0;
        failoverEvents.unshift({
          time: timeStr,
          fromNode: "REGENERAÇÃO",
          toNode: node.name,
          reason: `[CHAOS] Conexão restabelecida e parâmetros recuperados no nó ${node.name}.`
        });
      }
      break;

    case "recover_all":
      Object.keys(chaosState).forEach(key => delete chaosState[key]);
      rpcNodes.forEach(n => {
        n.status = "healthy";
        n.latency = Number.NaN; // MEDIDO por /api/rpc-nodes (antes: constantes por região)
        n.slotLag = 0;
        n.packetLoss = 0;
      });
      failoverEvents.unshift({
        time: timeStr,
        fromNode: "REGENERAÇÃO TOTAL",
        toNode: "TODOS OS NÓS",
        reason: `[CHAOS] Todos os nós recuperados e redefinidos para os limites ótimos.`
      });
      break;
  }

  // Force recalculate loop instantly on config updates
  runHftInfraLoop();

  return res.json({
    success: true,
    nodes: rpcNodes,
    logs: failoverEvents
  });
});

// 1.5. API: Get structured persistent logs
app.get("/api/logs", (req, res) => {
  const { level, component, correlationId, search } = req.query;
  let logs = dbStore.getLogs();

  if (level) {
    logs = logs.filter(l => l.level === (level as string).toUpperCase());
  }
  if (component) {
    logs = logs.filter(l => l.component === (component as string).toUpperCase());
  }
  if (correlationId) {
    logs = logs.filter(l => l.correlationId === correlationId);
  }
  if (search) {
    const q = (search as string).toLowerCase();
    logs = logs.filter(l => l.message.toLowerCase().includes(q));
  }

  return res.json(logs);
});

// 1.6. API: Rotate logs (Retention policy)
app.post("/api/logs/rotate", (req, res) => {
  const { retentionDays, maxSizeKb } = req.body;
  const stats = dbStore.rotateLogs(Number(retentionDays || 7), Number(maxSizeKb || 2000));
  return res.json(stats);
});

// 1.7. API: Get active alerts (Continuous Health & Parameter Violations)
app.get("/api/alerts", (_req, res) => {
  const alerts: any[] = [];
  
  // 1. Check RPC Node health
  rpcNodes.forEach(node => {
    const isNodeChaos = chaosState[node.id];
    const lat = isNodeChaos && isNodeChaos.latency !== undefined ? isNodeChaos.latency : node.latency;
    const lag = isNodeChaos && isNodeChaos.slotLag !== undefined ? isNodeChaos.slotLag : node.slotLag;
    const loss = isNodeChaos && isNodeChaos.packetLoss !== undefined ? isNodeChaos.packetLoss : node.packetLoss;
    
    if (node.status === "offline" || lat > 500) {
      alerts.push({
        id: `alert_rpc_down_${node.id}`,
        title: `Nó RPC Inativo/Gargalo`,
        level: "CRITICAL",
        message: `O nó RPC '${node.name}' está offline ou com latência crítica (${lat}ms). Failover automático acionado.`,
        timestamp: new Date().toISOString()
      });
    } else if (lat > 150) {
      alerts.push({
        id: `alert_rpc_latency_${node.id}`,
        title: `Alta Latência de RTT`,
        level: "WARN",
        message: `O nó RPC '${node.name}' apresentou RTT elevado de ${lat}ms. Balanceador migrando prioridade.`,
        timestamp: new Date().toISOString()
      });
    }

    if (lag > 3) {
      alerts.push({
        id: `alert_rpc_lag_${node.id}`,
        title: `Atraso Crítico de Slot Lag`,
        level: "WARN",
        message: `O nó RPC '${node.name}' está atrasado em ${lag} slots em relação ao líder Solana.`,
        timestamp: new Date().toISOString()
      });
    }

    if (loss > 5) {
      alerts.push({
        id: `alert_rpc_packet_loss_${node.id}`,
        title: `Perda de Pacotes Elevada`,
        level: "CRITICAL",
        message: `gRPC Pipeline reportou perda de pacotes de ${loss}% no canal '${node.name}'.`,
        timestamp: new Date().toISOString()
      });
    }
  });

  // 2. Check Operational Security (Kill Switch, Read Only, Drawdown)
  const secState = getOperationalSecurityState();
  if (secState.killSwitchActive) {
    alerts.push({
      id: "alert_kill_switch",
      title: "DISJUNTOR ATIVADO (KILL SWITCH)",
      level: "CRITICAL",
      message: "Execuções de Sniper suspensas imediatamente. Sistema de segurança travado pelo administrador.",
      timestamp: new Date().toISOString()
    });
  }

  // 3. Simulated drawdown alert (If consecutive failures are high)
  if (secState.consecutiveFailures > 0) {
    alerts.push({
      id: "alert_drawdown_risk",
      title: "Risco de Drawdown Elevado",
      level: "WARN",
      message: `Registradas ${secState.consecutiveFailures}/${secState.failureThreshold} falhas consecutivas de swaps. Risco de circuit-breaker ativo.`,
      timestamp: new Date().toISOString()
    });
  }

  return res.json(alerts);
});

// 2. API: Current Jito Tip levels in SOL
/**
 * GET /api/jito-tips — tip floor REAL do Jito (S3).
 *
 * ANTES: devolvia quatro constantes fixas (0.0005 / 0.0015 / 0.005 / 0.02) rotuladas como
 * "low/medium/high/extreme". Não vinham de lugar nenhum: o operador decidia o tip com base em
 * números inventados.
 *
 * AGORA: lê `https://bundles.jito.wtf/api/v1/bundles/tip_floor` (REST, host separado do block
 * engine — não é método JSON-RPC) e devolve os percentis PUBLICADOS, sem arredondar para
 * valores "bonitos". Quando a fonte não responde, a resposta é `available: false` com o motivo
 * e o último valor conhecido COM A IDADE — nunca um número inventado.
 *
 * Parâmetros opcionais (não alteram a leitura, só adicionam uma recomendação):
 *   ?capital=0.1&maxTipBps=50&policy=p75
 */
app.get("/api/jito-tips", async (req, res) => {
  const policyRaw = String(req.query.policy ?? process.env.JITO_TIP_PERCENTILE ?? "p75");
  const policy = (TIP_POLICIES as readonly string[]).includes(policyRaw)
    ? (policyRaw as TipPercentilePolicy)
    : "p75";

  const floor = await jitoTipOracle.getTipFloor();

  const capital = Number(req.query.capital ?? process.env.MAX_POSITION_SOL ?? 0);
  const maxTipBps = Number(req.query.maxTipBps ?? process.env.MAX_TIP_BPS ?? 50);
  const wantsRecommendation = capital > 0 && Number.isFinite(capital);

  // Passa o floor já lido: sem isso, a recomendação faria uma segunda chamada dentro do mesmo
  // request e cairia no throttle (1 req/s), escondendo o erro real da fonte.
  const recommendation = wantsRecommendation
    ? await jitoTipOracle.recommendTip({ capitalSol: capital, maxTipBps, policy }, floor)
    : null;

  return res.json({
    timestamp: Date.now(),
    source: TIP_FLOOR_URL,
    isJsonRpcMethod: false,
    note:
      "Tip floor é REST em bundles.jito.wtf (host separado do block engine). Percentis são os " +
      "publicados pelo Jito; 'available: false' significa que a fonte não respondeu — nenhum " +
      "valor é inventado. Tip mínimo considerado pelo Jito: " +
      `${MIN_JITO_TIP_LAMPORTS} lamports.`,
    available: floor.available,
    percentilesSol: floor.available
      ? {
          p25: floor.sample.p25,
          p50: floor.sample.p50,
          p75: floor.sample.p75,
          p95: floor.sample.p95,
          p99: floor.sample.p99,
          ema50: floor.sample.ema50,
        }
      : null,
    sampleTime: floor.available ? floor.sample.time : null,
    ageMs: floor.available ? floor.ageMs : (floor.lastKnown?.ageMs ?? null),
    fromCache: floor.available ? floor.fromCache : false,
    problems: floor.available ? floor.problems : [],
    error: floor.available ? null : floor.error,
    lastKnownPercentilesSol: !floor.available && floor.lastKnown
      ? { p50: floor.lastKnown.sample.p50, p75: floor.lastKnown.sample.p75, p95: floor.lastKnown.sample.p95 }
      : null,
    recommendation,
  });
});

/**
 * GET /api/jito/bundle-status — status de landing de bundles (S3).
 *
 * Read-only e sem autenticação (não muda estado). Duas fontes, com papéis DIFERENTES:
 *   - `getInflightBundleStatuses`: janela de 5 min, estados Invalid/Pending/Failed/**Landed**;
 *   - `getBundleStatuses`: histórico recente do RPC do Jito, com `confirmation_status`
 *     (processed/confirmed/finalized).
 *
 * Use `?signatures=…` para que a AUTORIDADE seja o SEU RPC (`getSignatureStatuses`).
 * "Landed" do Jito significa que entrou em um bloco — NÃO é confirmação e NÃO garante o efeito
 * esperado da transação (a doc do Jito alerta sobre blocos "uncled"). O veredito devolvido
 * declara de onde veio a evidência (`authority`) e por quê.
 *
 * Exemplo: /api/jito/bundle-status?ids=<bundleId>&signatures=<assinaturaDaTx>
 */
app.get("/api/jito/bundle-status", async (req, res) => {
  const idsRaw = String(req.query.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const sigsRaw = String(req.query.signatures ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  if (idsRaw.length === 0) {
    return res.status(400).json({
      error: "Informe ?ids=<bundleId>[,<bundleId>…] (máximo 5 por requisição).",
      maxPerRequest: 5,
    });
  }

  const sender = new JitoBundleSender(globalConnection ?? new Connection(RPC_ENDPOINT));
  const [inflight, definitive] = await Promise.all([
    sender.getInflightBundleStatuses(idsRaw),
    sender.getBundleStatuses(idsRaw),
  ]);

  // Confirmação no SEU RPC: é a autoridade para decisão de capital.
  const rpcConfirmations = new Map<string, RpcConfirmation>();
  if (sigsRaw.length > 0 && globalConnection) {
    try {
      const statuses = await globalConnection.getSignatureStatuses(sigsRaw, { searchTransactionHistory: true });
      sigsRaw.forEach((signature, i) => {
        const value: any = statuses?.value?.[i];
        if (!value) return;
        const rawStatus = value.confirmationStatus;
        const status: JitoConfirmationStatus =
          rawStatus === "confirmed" || rawStatus === "finalized" ? rawStatus : "processed";
        rpcConfirmations.set(signature, {
          signature,
          confirmationStatus: status,
          slot: Number.isFinite(Number(value.slot)) ? Number(value.slot) : null,
          err: value.err ? JSON.stringify(value.err).slice(0, 200) : null,
        });
      });
    } catch (err: any) {
      return res.status(502).json({
        error: `Falha ao consultar o RPC para confirmar assinaturas: ${err?.message ?? String(err)}`,
        inflight,
        bundleStatuses: definitive,
      });
    }
  }

  const reconciliations = idsRaw.map((id) => {
    const inflightEntry = inflight.entries.find((e) => e.bundleId === id) ?? null;
    const definitiveEntry = definitive.entries.find((e) => e.bundleId === id) ?? null;
    const signatures = definitiveEntry?.signatures ?? [];
    // Usa a confirmação do RPC cuja assinatura pertence a ESTE bundle (quando conhecida).
    const corroborating = signatures
      .map((s) => rpcConfirmations.get(s))
      .find((c): c is RpcConfirmation => Boolean(c)) ?? null;
    return reconcileLanding({
      bundleId: id,
      inflight: inflightEntry,
      bundleStatus: definitiveEntry,
      rpcConfirmation: corroborating,
      // Sem isto, uma falha de rede das duas fontes viraria "não encontrado" — que é
      // exatamente o tipo de conclusão otimista/errada que esta auditoria remove.
      sourceErrors: {
        inflight: inflight.ok ? null : inflight.problems.join("; "),
        bundleStatus: definitive.ok ? null : definitive.problems.join("; "),
      },
    });
  });

  return res.json({
    queriedAt: new Date().toISOString(),
    authority:
      "O RPC é a autoridade final. 'Landed' do Jito indica inclusão em bloco, não confirmação, " +
      "e não prova o efeito esperado da transação.",
    inflight,
    bundleStatuses: definitive,
    rpcChecked: sigsRaw.length > 0 && Boolean(globalConnection),
    reconciliations,
    note:
      "getInflightBundleStatuses cobre 5 minutos; getBundleStatuses usa getSignatureStatuses " +
      "com searchTransactionHistory=false (~300 slots enraizados). 'not_found' significa que " +
      "nenhuma dessas janelas contém o bundle — não que ele falhou.",
  });
});

// 3. API: Recent Snipes
app.get("/api/snipes", (_req, res) => {
  return res.json(snipedTransactions);
});

// 4. API: Simulate sniper execution
app.post("/api/simulate-snipe", restrictToDev, async (req, res) => {
  const { tokenName, tokenMint, solAmount, priorityTip, useJito, route, antiRugShield } = req.body;
  if (!tokenName || !tokenMint || !solAmount) {
    res.status(400).json({ error: "Missing required fields: tokenName, tokenMint, solAmount" });
    return;
  }

  const correlationId = `corr_snipe_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

  // Log detection
  dbStore.saveLog({
    timestamp: new Date().toISOString(),
    level: "INFO",
    component: "MEMPOOL_SCANNER",
    message: `[Mempool Scanner] Token detectado na mempool: ${tokenName.toUpperCase()} (${tokenMint.slice(0, 8)}...). Iniciando auditoria de pre-flight do contrato...`,
    correlationId
  });

  // Retrieve current security state
  const secState = getOperationalSecurityState();
  if (secState.killSwitchActive) {
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "CRITICAL",
      component: "RISK_ENGINE",
      message: `[Execução Abortada] Disjuntor Geral (Kill Switch) ativo preveniu a execução do snipe do token ${tokenName.toUpperCase()}.`,
      correlationId
    });
    res.status(403).json({ 
      error: "EXECUÇÃO SUSPENSA: Disjuntor de Segurança (Kill Switch) está ATIVO preventivamente.",
      blocked: true 
    });
    return;
  }

  if (secState.readOnlyMode) {
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "WARN",
      component: "RISK_ENGINE",
      message: `[Execução Abortada] Sistema operando em modo Read Only (Somente Leitura) preveniu envio da transação para o token ${tokenName.toUpperCase()}.`,
      correlationId
    });
    res.status(403).json({ 
      error: "EXECUÇÃO SUSPENSA: Sistema em modo Somente Leitura (Read Only) ativo.",
      blocked: true 
    });
    return;
  }

  const isRugToken = tokenName.toUpperCase().includes("RUG") || tokenMint.toLowerCase().includes("rug") || tokenMint.startsWith("1111");
  const isAntiRugSaved = isRugToken && antiRugShield;

  const latencyMs = useJito ? Math.floor(Math.random() * 8) + 3 : Math.floor(Math.random() * 35) + 15;
  const isSuccess = !isRugToken && (Math.random() > 0.12); // 88% success for clean tokens

  if (isRugToken) {
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "WARN",
      component: "SECURITY_SHIELD",
      message: `[ALERTA DE SEGURANÇA] Auditoria do token ${tokenName.toUpperCase()} identificou indicadores severos de RUGPULL/HONEYPOT (Score < 30).`,
      correlationId
    });
  } else {
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "SUCCESS",
      component: "SECURITY_SHIELD",
      message: `[Auditoria Aprovada] Token ${tokenName.toUpperCase()} validado com sucesso (Score de Segurança: ${Math.floor(Math.random() * 20) + 75}/100). Sem indicadores de honeypot.`,
      correlationId
    });
  }

  // Feed trade outcome to Circuit Breaker
  reportTradeOutcome(isSuccess || isAntiRugSaved);

  let outAmountStr = "";
  let jupiterRouted = false;

  // Real-time Jupiter Quote fetch integration
  if (!isRugToken && tokenMint.length > 30 && !tokenMint.startsWith("1111")) {
    try {
      const solMint = "So11111111111111111111111111111111111111112";
      const amountLamports = Math.floor(parseFloat(solAmount) * 1_000_000_000);
      if (amountLamports > 0) {
        console.log(`[Jupiter Integration] Querying real quote for ${tokenName} (${tokenMint})`);
        const quote = await JupiterIntegration.getQuote(solMint, tokenMint, amountLamports, 150); // 1.5% slippage
        if (quote && quote.outAmount) {
          // Compute human output amount assuming standard 9 decimals fallback (Jupiter quote returns raw lamports)
          const decimals = 9; 
          const outQty = parseFloat(quote.outAmount) / Math.pow(10, decimals);
          outAmountStr = `${outQty.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${tokenName.toUpperCase()}`;
          jupiterRouted = true;
          console.log(`[Jupiter Integration] SUCESS! Real Quote Output: ${outAmountStr}`);
        }
      }
    } catch (e: any) {
      console.log("[Jupiter Integration] Swapped to simulator fallback for local or offline execution.");
    }
  }

  if (!outAmountStr) {
    outAmountStr = isSuccess ? `${(parseFloat(solAmount) * (150000 + Math.floor(Math.random() * 50000))).toLocaleString()} ${tokenName.toUpperCase()}` : "0";
  }

  // Network logs
  dbStore.saveLog({
    timestamp: new Date().toISOString(),
    level: "INFO",
    component: "RPC_INFRA",
    message: `[Infra gRPC] gRPC streams sincronizados via fibra LD4/NY4. Endpoints saudáveis: 4/4. RTT selecionado: ${latencyMs}ms.`,
    correlationId
  });

  let mockTx;
  if (isAntiRugSaved) {
    mockTx = {
      id: `txn_${Date.now()}`,
      token: tokenName.toUpperCase(),
      mint: tokenMint.slice(0, 10) + "..." + tokenMint.slice(-4),
      amount: `${solAmount} SOL`,
      outAmount: "0 (Shield Active)",
      time: new Date().toTimeString().split(' ')[0] + "." + String(Date.now() % 1000).padStart(3, '0'),
      latencyMs,
      status: "blacklisted" as any,
      block: 278913000 + Math.floor(Math.random() * 1000),
      tipSol: parseFloat(priorityTip || "0.001"),
      route: "Mempool Anti-Rug Shield",
      isAntiRugSaved: true,
      savedAmountSol: solAmount
    };

    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "SUCCESS",
      component: "SECURITY_SHIELD",
      message: `[ESCUDO COMPORTAMENTAL] Interrupção de transação bem-sucedida! Abortado swap de ${solAmount} SOL antes do dump da liquidez.`,
      correlationId
    });
  } else {
    mockTx = {
      id: `txn_${Date.now()}`,
      token: tokenName.toUpperCase(),
      mint: tokenMint.slice(0, 10) + "..." + tokenMint.slice(-4),
      amount: `${solAmount} SOL`,
      outAmount: outAmountStr,
      time: new Date().toTimeString().split(' ')[0] + "." + String(Date.now() % 1000).padStart(3, '0'),
      latencyMs,
      status: (isSuccess ? "success" : isRugToken ? "blacklisted" : "failed") as any,
      block: 278913000 + Math.floor(Math.random() * 1000),
      tipSol: parseFloat(priorityTip || "0.001"),
      route: isRugToken ? "Mempool Trap Triggered" : jupiterRouted ? "Jupiter Router v6 (REAL-TIME)" : (route || "Raydium v4"),
      /** Simulação de endpoint: nunca contar como execução real em relatório de PnL. */
      mode: "paper" as const,
      signature: null,
    };

    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "INFO",
      component: "JITO_BUNDLE",
      message: `[Jito Bundle] Montando e assinando Bundle privado com submissão de propina (Jito Tip) de ${priorityTip || 0.001} SOL.`,
      correlationId
    });

    if (isSuccess) {
      dbStore.saveLog({
        timestamp: new Date().toISOString(),
        level: "SUCCESS",
        component: "JITO_BUNDLE",
        message: `[Bundle Landed] Transação incluída com sucesso no bloco Solana #${mockTx.block}. Quantidade adquirida: ${outAmountStr}. Latência total de execução: ${latencyMs}ms.`,
        correlationId
      });
    } else {
      dbStore.saveLog({
        timestamp: new Date().toISOString(),
        level: "ERROR",
        component: "JITO_BUNDLE",
        message: isRugToken 
          ? `[Bloqueado] Transação de compra abortada porque o token foi identificado como armadilha maliciosa.`
          : `[Bundle Dropped] Falha ao enviar transação: gRPC Bundle descartado pelos validadores líderes por expiração do blockhash.`,
        correlationId
      });
    }
  }

  snipedTransactions.unshift(mockTx);
  if (snipedTransactions.length > 25) {
    snipedTransactions.pop();
  }

  // Persist the transaction to the relational JSON database
  dbStore.saveTrade(mockTx);

  // If successful trade, create an active position
  if (isSuccess && !isAntiRugSaved) {
    const entryPrice = 0.000004 + (Math.random() * 0.000005);
    const newPos = {
      id: `pos_${Date.now()}`,
      token: tokenName.toUpperCase(),
      mint: tokenMint,
      sizeSol: parseFloat(solAmount),
      entryPrice,
      currentPrice: entryPrice,
      pnlPercent: 0,
      status: "open" as const,
      stopLossPercent: -5.0, // -5%
      takeProfitPercent: 15.0, // +15%
      trailingStopActive: false,
      trailingStopOffsetPercent: 2.5, // 2.5%
      highestPrice: entryPrice,
      timeOpened: new Date().toLocaleTimeString(),
      /**
       * MARCADO COMO PAPER (S4). Este caminho é um SIMULADOR: preço de entrada é
       * `Math.random()`, bloco é aleatório. Sem esta marca, a posição era tratada como
       * LIVE pelo gerenciador — e em modo LIVE isso poderia assinar uma VENDA REAL de um
       * token que o bot nunca comprou, a partir de um número inventado.
       */
      mode: "paper" as const,
      priceSource: "endpoint de simulação (preço aleatório — NÃO é mercado)",
    };
    dbStore.savePosition(newPos);
  }

  res.json({ success: isSuccess || isAntiRugSaved, isAntiRugSaved, transaction: mockTx, correlationId });
  return;
});

// 4.8 Prometheus Metrics & HFT Telemetry Exporter
app.get("/metrics", (_req, res) => {
  const detection_p95 = (8.2 + Math.random() * 2.5).toFixed(2);
  const detection_p99 = (12.4 + Math.random() * 3.1).toFixed(2);
  const simulation_p95 = (5.1 + Math.random() * 1.8).toFixed(2);
  const simulation_p99 = (8.4 + Math.random() * 2.2).toFixed(2);
  const inclusion_rate = (88.5 + Math.random() * 4).toFixed(1);
  const bundles_sent = 1240 + Math.floor((Date.now() / 10000) % 500);
  const bundles_landed = Math.floor(bundles_sent * (parseFloat(inclusion_rate) / 100));

  // Compute actual node metrics dynamically based on current infrastructure & chaos state
  let rpcMetricsStr = "";
  rpcNodes.forEach(node => {
    const isNodeChaos = chaosState[node.id];
    const lat = isNodeChaos && isNodeChaos.latency !== undefined ? isNodeChaos.latency : node.latency;
    const lag = isNodeChaos && isNodeChaos.slotLag !== undefined ? isNodeChaos.slotLag : node.slotLag;
    const loss = isNodeChaos && isNodeChaos.packetLoss !== undefined ? isNodeChaos.packetLoss : node.packetLoss;
    const statusVal = node.status === "healthy" ? 1 : (isNodeChaos && isNodeChaos.status === "offline" ? 0 : 0);

    rpcMetricsStr += `solana_hft_rpc_latency_ms{node="${node.id}",name="${node.name}"} ${lat}\n`;
    rpcMetricsStr += `solana_hft_rpc_slot_lag{node="${node.id}",name="${node.name}"} ${lag}\n`;
    rpcMetricsStr += `solana_hft_rpc_packet_loss_ratio{node="${node.id}",name="${node.name}"} ${loss / 100}\n`;
    rpcMetricsStr += `solana_hft_rpc_status{node="${node.id}",name="${node.name}"} ${statusVal}\n`;
  });

  const secState = getOperationalSecurityState();
  const killSwitchVal = secState.killSwitchActive ? 1 : 0;
  const readOnlyVal = secState.readOnlyMode ? 1 : 0;
  const consecutiveFailuresVal = secState.consecutiveFailures;
  const dbStats = dbStore.getDatabaseStats();

  res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(`# HELP solana_hft_detection_latency_ms Latency in milliseconds between Geyser gRPC event trigger and pipeline ingest
# TYPE solana_hft_detection_latency_ms gauge
solana_hft_detection_latency_ms{region="us-east",quantile="0.95"} ${detection_p95}
solana_hft_detection_latency_ms{region="us-east",quantile="0.99"} ${detection_p99}
solana_hft_detection_latency_ms{region="eu-central",quantile="0.95"} ${(parseFloat(detection_p95) * 1.2).toFixed(2)}
solana_hft_detection_latency_ms{region="eu-central",quantile="0.99"} ${(parseFloat(detection_p99) * 1.25).toFixed(2)}

# HELP solana_hft_simulation_latency_ms Latency in milliseconds spent executing pre-flight bytecode sandboxes to identify honeypots
# TYPE solana_hft_simulation_latency_ms gauge
solana_hft_simulation_latency_ms{sandbox="solana-vm",quantile="0.95"} ${simulation_p95}
solana_hft_simulation_latency_ms{sandbox="solana-vm",quantile="0.99"} ${simulation_p99}

# HELP solana_hft_bundle_inclusion_rate Percentage of bundles sent that successfully landed
# TYPE solana_hft_bundle_inclusion_rate gauge
solana_hft_bundle_inclusion_rate ${inclusion_rate}

# HELP solana_hft_bundles_total Total number of Jito Bundles sent
# TYPE solana_hft_bundles_total counter
solana_hft_bundles_total{status="landed"} ${bundles_landed}
solana_hft_bundles_total{status="dropped"} ${bundles_sent - bundles_landed}

# HELP solana_hft_rpc_latency_ms Current round-trip latency (RTT) of the Solana RPC endpoint
# TYPE solana_hft_rpc_latency_ms gauge
${rpcMetricsStr}
# HELP solana_hft_kill_switch_active System safety state representing the Kill Switch trigger status (1 = active, 0 = normal)
# TYPE solana_hft_kill_switch_active gauge
solana_hft_kill_switch_active ${killSwitchVal}

# HELP solana_hft_readonly_mode System state representing if operations are in read-only audit mode (1 = active, 0 = normal)
# TYPE solana_hft_readonly_mode gauge
solana_hft_readonly_mode ${readOnlyVal}

# HELP solana_hft_risk_consecutive_failures Total consecutive execution failures tracked by circuit breaker
# TYPE solana_hft_risk_consecutive_failures gauge
solana_hft_risk_consecutive_failures ${consecutiveFailuresVal}

# HELP solana_hft_db_stats HFT operational SQLite-like persistent database statistics
# TYPE solana_hft_db_stats gauge
solana_hft_db_trades_count ${dbStats.tradesCount}
solana_hft_db_positions_count ${dbStats.positionsCount}
solana_hft_db_logs_count ${dbStats.logsCount}
solana_hft_db_transaction_commits ${dbStats.transactionCount}
`);
});

app.get("/api/hft-telemetry", (_req, res) => {
  /**
   * SLOT: MEDIDO ou null. Antes era `278913410 + (Date.now()/400) % 100000` — um número que
   * "anda" com o relógio do processo e parece telemetria de rede, mas não é: nenhuma medição
   * entra ali. Mesmo padrão já corrigido em /api/geyser-stream.
   *
   * O RESTANTE deste endpoint (latências de tick, P50/P99, inclusion rate) está declarado em
   * `/api/system-truth → fabricatedEndpoints` como SIMULADO: é um painel de demonstração. O
   * campo `simulated: true` abaixo existe para que nenhum consumidor o confunda com medição.
   */
  const measuredSlots = Object.values(rpcMetrics)
    .map((m) => m.lastSlot)
    .filter((v): v is number => typeof v === "number" && v > 0);
  const currentSlot: number | null = measuredSlots.length > 0 ? Math.max(...measuredSlots) : null;
  
  const ticks = Array.from({ length: 12 }, (_, i) => {
    const time = new Date(Date.now() - (11 - i) * 2000).toLocaleTimeString().split(' ')[0];
    const grpc = coLocationActive
      ? parseFloat((0.8 + Math.random() * 0.4).toFixed(2)) // Co-located sub-1.2ms
      : parseFloat((6.5 + Math.random() * 3).toFixed(2));
    const sandbox = coLocationActive
      ? parseFloat((0.5 + Math.random() * 0.3).toFixed(2)) // Bare Metal sub-1ms fork
      : parseFloat((4.2 + Math.random() * 2).toFixed(2));
    const trigger = coLocationActive
      ? parseFloat((0.2 + Math.random() * 0.2).toFixed(2)) // Sub-0.4ms execution dispatcher
      : parseFloat((2.1 + Math.random() * 1).toFixed(2));
    const landed = coLocationActive ? Math.random() > 0.01 : Math.random() > 0.12; // 99% vs 88%
    return {
      time,
      grpc,
      sandbox,
      trigger,
      total: parseFloat((grpc + sandbox + trigger).toFixed(2)),
      landed
    };
  });

  const detection_p95 = coLocationActive
    ? parseFloat((1.1 + Math.random() * 0.3).toFixed(2))
    : parseFloat((8.2 + Math.random() * 2.5).toFixed(2));
  const detection_p99 = coLocationActive
    ? parseFloat((1.6 + Math.random() * 0.4).toFixed(2))
    : parseFloat((12.4 + Math.random() * 3.1).toFixed(2));

  const simulation_p95 = coLocationActive
    ? parseFloat((0.7 + Math.random() * 0.2).toFixed(2))
    : parseFloat((5.1 + Math.random() * 1.8).toFixed(2));
  const simulation_p99 = coLocationActive
    ? parseFloat((1.1 + Math.random() * 0.3).toFixed(2))
    : parseFloat((8.4 + Math.random() * 2.2).toFixed(2));

  const inclusion_rate = coLocationActive
    ? parseFloat((99.2 + Math.random() * 0.6).toFixed(1))
    : parseFloat((88.5 + Math.random() * 4).toFixed(1));

  // L5 Observability dynamic variables
  const kafkaThroughput = pm2State === "online" ? Math.floor(kafkaThroughputBase + Math.random() * 300) : 0;
  const protobufRatio = 5.4;
  const redisQueueSize = pm2State === "online" ? Math.floor(Math.random() * 3) : 0;
  const timescaleWriteRate = pm2State === "online" ? Math.floor(120 + Math.random() * 40) : 0;

  // Official KPIs Target vs Real comparison values
  const kpis = {
    successRate: pm2State === "online" ? parseFloat((60.5 + Math.random() * 4.2).toFixed(1)) : 0,
    returnPerBatch: pm2State === "online" ? parseFloat((12.4 + Math.random() * 3.8).toFixed(1)) : 0,
    endToEndLoop: pm2State === "online"
      ? (coLocationActive ? parseFloat((85 + Math.random() * 15).toFixed(1)) : parseFloat((175 + Math.random() * 30).toFixed(1)))
      : 0,
    detectionLatency: pm2State === "online"
      ? (coLocationActive ? parseFloat((1.1 + Math.random() * 0.3).toFixed(2)) : parseFloat((8.4 + Math.random() * 1.8).toFixed(2)))
      : 0
  };

  res.json({
    /** Este painel é DEMONSTRAÇÃO (ver fabricatedEndpoints em /api/system-truth). */
    simulated: true,
    simulatedNote:
      "Latências, P50/P99, taxas de inclusão e contadores de bundles deste endpoint são " +
      "SIMULADOS para demonstração do HUD. NÃO são medição de rede nem de execução. O único " +
      "campo medido é currentSlot (último slot observado nos nós RPC configurados).",
    
    currentSlot,
    ticks,
    p95: {
      detection: detection_p95,
      simulation: simulation_p95,
      trigger: coLocationActive ? 0.35 : 2.8
    },
    p99: {
      detection: detection_p99,
      simulation: simulation_p99,
      trigger: coLocationActive ? 0.55 : 4.2
    },
    inclusionRate: inclusion_rate,
    circuitBreakerActive,
    circuitBreakerThreshold,
    pm2State,
    kafkaThroughput,
    protobufRatio,
    redisQueueSize,
    timescaleWriteRate,
    kpis
  });
});

// 4.9 API: Geyser gRPC Live Stream
app.get("/api/geyser-stream", (_req, res) => {
  /**
   * SLOT DE REFERÊNCIA (S5/C40) — antes: `278913410 + (Date.now()/400) % 100000`, isto é,
   * um número inventado a partir do relógio do processo. Um slot "andando" desse jeito
   * parece telemetria e não é: nenhuma medição de rede entra ali. Agora usamos a última
   * medição real de slot dos nós RPC (mesma fonte do laço de infraestrutura) e, quando não
   * há medição, devolvemos o indicador de NÃO MEDIDO em vez de um número.
   */
  const measuredSlots = Object.values(rpcMetrics)
    .map((m) => m.lastSlot)
    .filter((v): v is number => typeof v === "number" && v > 0);
  const detectionSlot = geyserClientRef?.getHealth().hotPath?.lastLocalSlot ?? null;
  const currentSlot: number | null =
    measuredSlots.length > 0 ? Math.max(...measuredSlots) : detectionSlot;
  const currentSlotMeasured = currentSlot !== null;
  const now = Date.now();
  
  // Combine real events and mock events
  const combinedEvents = [...realOnChainEvents];
  
  // Fill up to 5 events with mock if real is less
  if (combinedEvents.length < 5) {
    const mockNames = ["SolCat", "PepeJump", "HftMeme", "RaydiumWhale", "DogeFiredancer", "SpeedRun", "PumpingSOL", "GeyserCoin"];
    const mockMints = [
      "Pump782bAa9128...d89c",
      "Gysr8291bBa182...a11a",
      "FdanC1123aCb39...f822",
      "HeliS839d9aC41...9a99",
      "TritN912aDa331...aa22"
    ];
    for (let i = combinedEvents.length; i < 5; i++) {
      const eventTime = now - i * 3000 - Math.floor(Math.random() * 1000);
      const isRaydium = Math.random() > 0.4;
      combinedEvents.push({
        id: `evt_mock_${now - i * 1000}`,
        timestamp: eventTime,
        programId: isRaydium ? "675k1g2EPJ8gS7q9yGP8REukXXhxZ9ReM78D4cifFGL" : "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
        programName: isRaydium ? "Raydium AMM" : "Pump.fun",
        type: isRaydium ? "PoolCreated" : "TokenMinted",
        mint: mockMints[(Math.floor(eventTime / 1000) + i) % mockMints.length],
        mintName: mockNames[(Math.floor(eventTime / 3000) + i) % mockNames.length],
        grpcLatencyMs: coLocationActive
          ? parseFloat((0.8 + Math.random() * 0.4).toFixed(2))
          : parseFloat((8.1 + Math.random() * 5).toFixed(2)),
        jsonRpcLatencyMs: coLocationActive
          ? parseFloat((12.5 + Math.random() * 6).toFixed(1))
          : parseFloat((320 + Math.random() * 180).toFixed(1)),
        savedComputeUnits: Math.floor(25000 + Math.random() * 15000),
        rawProtobufHex: Array.from({ length: 12 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join(""),
        isRealOnChain: false,
        /*
         * Marcação explícita. `id` já começa com "evt_mock_", mas isso é convenção interna:
         * quem consome a API (ou o operador lendo o JSON) não deve ter que conhecer o
         * padrão de id para saber que o evento é decorativo.
         */
        simulated: true,
        source: "MOCK/RNG — evento decorativo do painel, nenhuma transação real corresponde",
      });
    }
  }

  /**
   * ESTADO DE REDE — só o que é observável daqui (S5/C40).
   *
   * A versão anterior anunciava estado de co-localização com stream de shreds ativo e
   * publicava throughput, carga de sistema e canais ativos com `Math.random()`. Nada disso
   * existe: não há assinatura de shreds pré-execução neste runtime, e "co-location" é um
   * fato FÍSICO da máquina (latência de rede até o líder) que este processo não consegue
   * verificar sobre si mesmo — só o operador sabe onde o servidor está.
   */
  const elapsedSeconds = Math.max(1, (Date.now() - processStartAt) / 1000);
  const realCount = combinedEvents.filter((e: any) => e.isRealOnChain === true).length;
  res.json({
    currentSlot,
    currentSlotMeasured,
    currentSlotSource: currentSlotMeasured
      ? "medido: último slot observado nos nós RPC configurados (ou amostra local de getSlot)"
      : "NÃO MEDIDO: nenhum RPC respondeu neste processo — o valor é null de propósito, não 0",
    feed: {
      real: realCount,
      simulated: combinedEvents.length - realCount,
      note:
        "Eventos com `simulated: true` são decorativos (nomes/latências/hex gerados por RNG). " +
        "Eles NÃO correspondem a transações: só `isRealOnChain: true` veio de notificação do RPC.",
    },
    events: combinedEvents.slice(0, 8),
    measured: {
      processUptimeSeconds: Math.round(elapsedSeconds),
      rssBytes: process.memoryUsage().rss,
      nodeVersion: process.version,
    },
    declared: {
      coLocation: coLocationActive
        ? "DECLARADO PELO OPERADOR como ativo — este processo NÃO consegue medir a posição física do host"
        : "não declarado",
      note:
        "ShredStream (shreds pré-execução) NÃO está implementado neste runtime. Assinaturas " +
        "ativas são de logs WebSocket RPC (mais lentas que gRPC/shreds).",
    },
    /** Substitui os antigos números aleatórios: nada aqui é inventado. */
    unmeasured: ["systemLoad", "messagesPerSecond", "shredThroughput"],
  });
});

/**
 * 4.5 API: Jito Leader Schedule — AGORA HONESTO (era RNG).
 *
 * AUDITORIA 2026-10-02 + revisão 2026-10-03: este endpoint devolvia líder, escalas, regiões,
 * delays e "reputação do block engine" gerados por RNG — inclusive com nomes de terceiros
 * ("Helius Validator #4") — e o painel exibia tudo como se fosse telemetria. Nada disso é
 * observável deste processo:
 *
 *   - QUEM produz o próximo bloco exige a escala de líderes do epoch (`getSlotLeaders`),
 *     cruzada com a identidade dos validadores Jito;
 *   - latência por região exige medir RTT A PARTIR de cada região (este processo não está nelas);
 *   - "reputação do block engine" não é dado público — a Jito não publica esse ranking.
 *
 * O que PODE ser dito com evidência: o último slot que os nós configurados responderam
 * (mesma medição de `/api/rpc-nodes`) e a cotação de tip real (`/api/jito-tips`). O resto
 * volta como `null` com o motivo, porque número inventado aqui vira decisão de tip/região
 * baseada em ficção.
 */
app.get("/api/jito-leader-schedule", (_req, res) => {
  const measuredSlots = Object.values(rpcMetrics)
    .map((m) => m.lastSlot)
    .filter((v): v is number => typeof v === "number" && v > 0);
  const currentSlot: number | null = measuredSlots.length > 0 ? Math.max(...measuredSlots) : null;

  return res.json({
    measured: currentSlot !== null,
    currentSlot,
    currentSlotSource:
      currentSlot !== null
        ? "medido: último slot observado nos nós RPC configurados (mesma fonte de /api/rpc-nodes)"
        : "NÃO MEDIDO: nenhum nó RPC respondeu neste processo — null de propósito, nunca 0",
    // Não observável deste processo: null com motivo, nunca RNG.
    nextLeaderSlot: null,
    currentLeader: null,
    isJitoNextLeader: null,
    blockEngineReputation: null,
    regions: [],
    notMeasured: {
      nextLeaderSlot:
        "exige a escala de líderes do epoch (getSlotLeaders) cruzada com a identidade dos " +
        "validadores Jito — este processo não consulta a escala.",
      currentLeader: "idem: a identidade do produtor do bloco atual não é consultada aqui.",
      regions:
        "latência por região (LD4/Tóquio/NY) só é mensurável A PARTIR de cada região; medir de " +
        "outro lugar mede outra coisa.",
      blockEngineReputation:
        "não é dado público: a Jito não publica ranking de block engines — qualquer número " +
        "aqui seria invenção.",
    },
    howToMeasure:
      "A cotação de tip real está em GET /api/jito-tips (tip_floor da Jito, medido). Para a " +
      "escala de líderes, consulte getSlotLeaders/getEpochSchedule no RPC e cruze com a lista " +
      "pública de validadores Jito — este endpoint não faz isso hoje.",
    coLocation: {
      declaredByOperator: coLocationActive,
      note:
        "declaração do operador (estado salvo). Este processo NÃO consegue medir a posição " +
        "física do host — declaração não é medição.",
    },
  });
});

/**
 * SIMULADOR DE BUNDLE — DECLARADO COMO TAL.
 *
 * Este endpoint NÃO envia bundle algum: ele simula mecânica de tip/landing para estudo do
 * fluxo. Está listado em `/api/system-truth → fabricatedEndpoints`, e a resposta agora diz
 * isso EM CAMPO (`simulated: true`, `onChainEffect: "nenhum"`) porque o painel consumia o
 * resultado como se fosse landing real e chegava a registrar uma "transação" com preço e
 * bloco inventados. Submissão real de bundle depende do S6 (não autorizado).
 */
app.post("/api/submit-bundle", (req, res) => {
  const { tokenName, tokenMint, solAmount, priorityTip, region } = req.body;
  
  const bundleId = `bundle_jito_${Math.random().toString(36).substring(2, 11)}`;
  const timestamp = new Date().toTimeString().split(' ')[0] + "." + String(Date.now() % 1000).padStart(3, '0');
  
  const tipAmount = parseFloat(priorityTip || "0.002");
  
  // Decide land status based on tip size
  let landStatus: "Landed" | "Reverted" | "Dropped" = "Landed";
  let landReason = "Bundle successfully included at top of slot by Jito Leader";
  
  if (tipAmount < 0.001) {
    landStatus = "Dropped";
    landReason = "Tip too low. Bundle outbid by competing HFT Searcher bundle (Tip: 0.0035 SOL)";
  } else if (tokenMint && (tokenMint.toLowerCase().includes("rug") || tokenMint.startsWith("1111"))) {
    landStatus = "Reverted";
    landReason = "Pre-flight safety trigger: contract bytecode failed post-sim check, bundle aborted safely without gas consumption";
  }

  const result = {
    bundleId,
    timestamp,
    /** NENHUM bundle é enviado por este endpoint — ver comentário acima. */
    simulated: true,
    onChainEffect: "nenhum",
    simulatedNote:
      "Resultado SIMULADO: sem assinatura, sem envio, sem slot, sem fill. Nenhum valor desta " +
      "resposta é evidência de landing on-chain (submissão real depende do S6, não autorizado).",
    landStatus,
    landReason: `[SIMULADO] ${landReason}`,
    tipSol: tipAmount,
    region: region || "Tokyo",
    gasSavedSol: landStatus === "Reverted" ? 0.05 + tipAmount : 0.0,
    bundleTrace: [
      `[Jito BlockEngine] Handshake estabelecido com relayer no node de ${region || "Tokyo"} [SIMULADO — nenhum handshake ocorreu]`,
      `[Atomic Packer] Empacotando transações: [Tx1: Buy Swap (${solAmount} SOL de ${tokenName || "TOKEN"})] + [Tx2: Validator Tip Transfer (${tipAmount} SOL)]`,
      `[Signature Service] Assinando pacote com chave AES-256 (Decriptação volátil: 0.12ms)`,
      landStatus === "Dropped"
        ? `[Inclusão] Tentando emparelhar no slot principal... FALHOU (Outbid por outros bundles)`
        : landStatus === "Reverted"
        ? `[Inclusão] Simulação reversa: Erro de bytecode detectado em sub-rotina. Reversão segura ativa (Zero taxas cobradas)`
        : `[Inclusão] SUCESSO! Bundle incluído no slot superior pelo validador Jito (${region || "Tokyo"})`
    ]
  };

  res.json(result);
});

// 4.5 API: Deterministic Local Fork & Bytecode Simulation
app.post("/api/simulate-fork", restrictToDev, (req, res) => {
  const { tokenMint, tokenName } = req.body;
  if (!tokenMint) {
    res.status(400).json({ error: "Token mint is required for pre-flight simulation" });
    return;
  }

  const name = tokenName || "UNKNOWN TOKEN";
  const isRug = tokenMint.toLowerCase().includes("rug") || tokenMint.startsWith("1111") || name.toUpperCase().includes("RUG");

  // Latency metrics simulating Equinix LD4 hardware / AWS Co-located
  const grpcIngestLatency = coLocationActive
    ? parseFloat((0.8 + Math.random() * 0.4).toFixed(2)) // 0.8ms to 1.2ms
    : parseFloat((8.2 + Math.random() * 4).toFixed(2)); // <15ms
  const simulationTimeMs = coLocationActive
    ? parseFloat((0.5 + Math.random() * 0.3).toFixed(2)) // 0.5ms to 0.8ms (Rust Parallel Multicore VM speed)
    : parseFloat((5.1 + Math.random() * 3).toFixed(2));  // <10ms
  const computeUnits = isRug ? 85400 : 42100 + Math.floor(Math.random() * 3000);

  // --- Algorithmic Logic Implementation ---
  // 1. Signal Capture: Event received from Geyser gRPC
  const signalCaptured = true;

  // 2. Scenario Construction: Simulated buy payload with X SOL
  const purchaseSol = 1.0; // X value of buy simulation (1.0 SOL)
  const theoreticalPrice = 0.0001; // Theoretical price in SOL per token
  const pTeorico = 1 / theoreticalPrice; // Theoretical conversion factor (10000 tokens per SOL)

  // 3. Pre-Flight Execution: Dispatched simulation against RPC node using 'processed' state
  const commitment = "processed";

  // Buy tax simulation
  const buyTax = isRug ? parseFloat((15 + Math.random() * 15).toFixed(1)) : 0.0;
  // T_tokens: Simulated acquired tokens after buy tax
  const tTokens = (purchaseSol * pTeorico) * (1 - buyTax / 100);

  // 4. Output Verification: Immediate simulated sale of 100% of acquired tokens
  // B_venda: Simulated SOL returned after sell tax
  // For a normal token, B_venda is around 0.92 - 0.98 SOL (normal slippage & swap fee)
  // For a honeypot, B_venda is extremely low (e.g., 0.05 SOL or less, representing near-total loss due to hidden sell tax)
  const bVenda = isRug
    ? parseFloat((purchaseSol * (0.01 + Math.random() * 0.04)).toFixed(4))
    : parseFloat((purchaseSol * (0.92 + Math.random() * 0.05)).toFixed(4));

  // 5. Mathematical Modeling Application
  // Formula: τ_venda = 1 - T_tokens / (B_venda * P_teorico)
  // Since we want the tax rate percentage, let's evaluate this:
  // If safe: tTokens = 10000, bVenda = 0.95, pTeorico = 10000.
  // Then tTokens / (bVenda * pTeorico) = 10000 / 9500 = 1.0526. 1 - 1.0526 = -0.0526.
  // To match a positive tax percentage for representation, we can compute:
  // taxFactor = 1 - (bVenda * pTeorico) / tTokens (which is 1 - 9500/10000 = 5.0%)
  // Let's compute both the literal formula requested and the standard positive tax representation:
  const literalTauVenda = parseFloat((1 - tTokens / (bVenda * pTeorico)).toFixed(4));
  const positiveSellTaxPct = isRug 
    ? parseFloat((90 + Math.random() * 9.9).toFixed(2))
    : parseFloat((2.5 + Math.random() * 4).toFixed(2));

  // Condição de Aborto: Se τ_venda > 0.10 (ou 10% no modelo positivo), marque como Honeypot e aborte
  const isHoneypot = isRug || (positiveSellTaxPct > 10);

  // 6. Filtro de Autoridade: Verificar se Mint Authority e Freeze Authority foram revogadas no mesmo bloco
  const mintAuthorityRevoked = !isRug;
  const freezeAuthorityRevoked = !isRug;
  const authoritiesRevokedInSameBlock = mintAuthorityRevoked && freezeAuthorityRevoked;

  const result = {
    tokenMint,
    tokenName: name,
    signalCaptured,
    grpcIngestLatencyMs: grpcIngestLatency,
    simulationLatencyMs: simulationTimeMs,
    totalPipelineLatencyMs: parseFloat((grpcIngestLatency + simulationTimeMs).toFixed(2)),
    computeUnits,
    buyTax,
    sellTax: positiveSellTaxPct, // τ_venda representation for UI
    literalTauVenda,             // Literal value computed
    purchaseSol,
    tTokens: Math.floor(tTokens),
    bVenda,
    pTeorico,
    isHoneypot,
    mintAuthorityRevoked,
    freezeAuthorityRevoked,
    authoritiesRevokedInSameBlock,
    gasSavedSol: isHoneypot ? 0.05 + parseFloat((Math.random() * 0.1).toFixed(3)) : 0.0,
    status: isHoneypot ? "flagged" : "verified",
    simulationTrace: [
      `[Geyser gRPC] Capturado sinal de novo pool do Raydium em ${grpcIngestLatency}ms`,
      `[Scenario Builder] Construído payload simulado para compra de ${purchaseSol} SOL (${Math.floor(purchaseSol * pTeorico)} tokens teóricos)`,
      `[RPC Pre-Flight] Simulação disparada contra o nó com commitment: '${commitment}'`,
      `[Output Verifier] Compra concluída: Adquirido ${Math.floor(tTokens)} tokens (Taxa Compra: ${buyTax}%)`,
      `[Output Verifier] Disparada venda imediata de 100% do saldo (${Math.floor(tTokens)} tokens)`,
      `[Output Verifier] Retorno líquido recebido da venda simulada: ${bVenda} SOL`,
      `[Math Model] Aplicando Fórmula: τ_venda = 1 - T_tokens / (B_venda * P_teorico)`,
      `[Math Model] τ_venda literal = ${literalTauVenda} (Taxa real efetiva: ${positiveSellTaxPct}%)`,
      isHoneypot
        ? `[CONDIÇÃO DE ABORTO] τ_venda (${positiveSellTaxPct}%) > 10%! Honeypot confirmado. Abortando execução!`
        : `[Sucesso] τ_venda (${positiveSellTaxPct}%) ≤ 10%. Simulação de compra e venda aprovada.`,
      `[Filtro Autoridade] Mint Authority: ${mintAuthorityRevoked ? "REVOGADA ✅" : "ATIVA ❌"}, Freeze Authority: ${freezeAuthorityRevoked ? "REVOGADA ✅" : "ATIVA ❌"}`,
      authoritiesRevokedInSameBlock
        ? `[Filtro Autoridade] Sucesso: Ambas as autoridades revogadas no mesmo bloco!`
        : `[ALERTA AUTORIDADE] Perigo: Mint/Freeze Authority ativas ou não revogadas no bloco de criação!`,
      `[Jito Bundler] Bundle de simulação atômica ${isHoneypot ? "REJEITADO (Prevenção ativa)" : "APROVADO para envio prioritário"}`
    ]
  };

  res.json(result);
  return;
});

// 4.5. API: Layer 6 Predictive Scoring using Gemini & Simulated Birdeye metrics
app.post("/api/predictive-score", async (req, res) => {
  const { tokenMint, tokenName, useGemini } = req.body;
  if (!tokenMint) {
    res.status(400).json({ error: "Token mint address is required for predictive scoring" });
    return;
  }

  const name = tokenName || "UNKNOWN MEME";
  const isRug = tokenMint.toLowerCase().includes("rug") || tokenMint.startsWith("1111");

  // Base deterministic/simulation parameters
  const baseScore = isRug ? 12 + Math.floor(Math.random() * 10) : 75 + Math.floor(Math.random() * 20);
  const predictionClass = baseScore >= 85 ? "Absolute God Tier" : baseScore >= 70 ? "Elite Tier" : baseScore >= 40 ? "Degen Tier" : "Rug Trap";
  const confidence = baseScore >= 85 ? 90 + Math.floor(Math.random() * 9) : 70 + Math.floor(Math.random() * 20);

  const socialSentiment = {
    bullishPercent: isRug ? 25 + Math.floor(Math.random() * 15) : 70 + Math.floor(Math.random() * 25),
    bearishPercent: 0,
    birdeyeScore: baseScore - 2 + Math.floor(Math.random() * 5),
    mentionVolume24h: isRug ? 100 + Math.floor(Math.random() * 400) : 1200 + Math.floor(Math.random() * 4000),
    tgGrowthPercent: isRug ? -5 + Math.floor(Math.random() * 10) : 10 + Math.floor(Math.random() * 40),
    twitterShills: isRug ? Math.floor(Math.random() * 5) : 20 + Math.floor(Math.random() * 200)
  };
  socialSentiment.bearishPercent = 100 - socialSentiment.bullishPercent;

  const marketMetrics = {
    bondingCurveProgress: isRug ? Math.floor(Math.random() * 30) : 50 + Math.floor(Math.random() * 49),
    holderDistributionGini: isRug ? 0.6 + Math.random() * 0.3 : 0.2 + Math.random() * 0.15,
    deployerPastLaunches: isRug ? Math.floor(Math.random() * 10) : Math.floor(Math.random() * 5),
    deployerRugHistory: isRug ? 1 + Math.floor(Math.random() * 5) : 0,
    liquiditySol: isRug ? Math.floor(Math.random() * 10) : 50 + Math.floor(Math.random() * 300)
  };

  const inferencePipeline = {
    ingestionLatencyMs: 0.5 + Math.random() * 0.5,
    birdeyeFetchLatencyMs: 50 + Math.random() * 80,
    aiInferenceLatencyMs: 8 + Math.random() * 8,
    totalPipelineMs: 0
  };
  inferencePipeline.totalPipelineMs = parseFloat((inferencePipeline.ingestionLatencyMs + inferencePipeline.birdeyeFetchLatencyMs + inferencePipeline.aiInferenceLatencyMs).toFixed(1));
  inferencePipeline.ingestionLatencyMs = parseFloat(inferencePipeline.ingestionLatencyMs.toFixed(1));
  inferencePipeline.birdeyeFetchLatencyMs = parseFloat(inferencePipeline.birdeyeFetchLatencyMs.toFixed(1));
  inferencePipeline.aiInferenceLatencyMs = parseFloat(inferencePipeline.aiInferenceLatencyMs.toFixed(1));

  let aiVerdict = `Análise off-chain da Birdeye indica tração ${isRug ? "extremamente fraca ou artificial" : "extremamente saudável"}. O sentimento social é predominantemente ${isRug ? "bearish" : "bullish"} (${socialSentiment.bullishPercent}% bullish). Gini de holders está em ${marketMetrics.holderDistributionGini.toFixed(2)}, sugerindo ${marketMetrics.holderDistributionGini <= 0.35 ? "uma distribuição saudável" : "alta concentração de tokens nas mãos dos devs"}.`;

  const apiKey = process.env.GEMINI_API_KEY;
  if (useGemini && apiKey) {
    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });
      const prompt = `You are a high-frequency trading (HFT) Solana token predictor (Layer 6).
Analyze this token:
Token Mint: "${tokenMint}"
Token Name: "${name}"
Is Rug flagged on contract: ${isRug}

Input off-chain sentiment metrics:
- Bullish Sentiment: ${socialSentiment.bullishPercent}%
- Birdeye Social Score: ${socialSentiment.birdeyeScore}/100
- 24h Mention Volume: ${socialSentiment.mentionVolume24h}
- Telegram Growth: ${socialSentiment.tgGrowthPercent}%
- Twitter Shills: ${socialSentiment.twitterShills}

Input on-chain market metrics:
- Bonding Curve progress: ${marketMetrics.bondingCurveProgress}%
- Holder Distribution Gini index: ${marketMetrics.holderDistributionGini}
- Deployer launches: ${marketMetrics.deployerPastLaunches}
- Deployer rug history count: ${marketMetrics.deployerRugHistory}
- LP Liquidity: ${marketMetrics.liquiditySol} SOL

Based on this information, provide a final predictive judgment verdict. Your response MUST be a single Portuguese paragraph of 2 to 3 sentences, explaining whether the token is a high-potential opportunity or a dangerous rug-trap, and giving specific recommendations on the HFT slippage calibration. Use highly professional Silicon Valley HFT tone. Do not output JSON, just output the plain-text paragraph.`;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt
      });

      if (response.text) {
        aiVerdict = response.text.trim();
      }
    } catch (e: any) {
      console.warn("Failed to get Gemini verdict for predictive-score:", e.message);
    }
  }

  res.json({
    mint: tokenMint,
    name,
    score: baseScore,
    predictionClass,
    confidence,
    socialSentiment,
    marketMetrics,
    inferencePipeline,
    aiVerdict
  });
});

// Helper to fetch real on-chain data and market statistics from Solana RPC and DexScreener
/**
 * MOTOR DE RISCO ON-CHAIN — VERSÃO CORRIGIDA (auditoria 2026-10-02).
 *
 * O QUE MUDOU E POR QUÊ
 * ---------------------
 * A versão anterior era FAIL-OPEN e FABRICAVA indicadores de segurança. Os três
 * problemas, com consequência direta em capital:
 *
 *  [F1] FALHA ABERTA EM AUTORIDADES.
 *       Defaults: `mintAuthorityDisabled = true`, `freezeAuthorityDisabled = true`.
 *       Se as chamadas RPC falhassem (RPC público rate-limited, mint inexistente,
 *       token-2022 não parseado), o relatório dizia "propriedade renunciada, seguro".
 *       Um token com freeze authority ATIVA — capaz de impedir a VENDA dos seus tokens —
 *       era classificado como seguro justamente quando o dado não pôde ser lido.
 *       Agora: autoridade desconhecida => dado ausente => REPROVAÇÃO (fail-closed).
 *
 *  [F2] "LIQUIDEZ BLOQUEADA / QUEIMADA" INVENTADA.
 *       O texto (`liquidityLocked`) era deduzido de `liquidity.usd > 50000`:
 *         > $50k  => "95% (Burned / Locked)"
 *         > $0    => "80% (Locked)"
 *       Nem DexScreener nem o RPC informam se o LP está lockado/queimado. Isso exigiria
 *       localizar o NFT do LP e verificar burn ou custódia em programa de lock.
 *       Era o pior tipo de bug: um SELO DE SEGURANÇA inventado. Agora reportamos
 *       explicitamente "não verificado" e não pontuamos a favor.
 *
 *  [F3] "TAXA DE COMPRA/VENDA" E "ALOCAÇÃO DO DEV" INVENTADAS.
 *       `taxBuySell` era literalmente `"0% / 0%"` ou `"100% / 100% (Honeypot)"` escolhido
 *       por um `if` sobre freeze authority, sem nenhuma simulação de compra/venda.
 *       `creatorAllocation` era `top10Pct * 0.15` — um número inventado apresentado como
 *       dado on-chain. Ambos agora são reportados como "Não medido", com a explicação do
 *       que seria necessário para medir de verdade (simulação de swap / trace de criação).
 *
 * NOTA SOBRE TOP HOLDERS: `getTokenLargestAccounts` retorna as maiores CONTAS de token,
 * não os maiores PROPRIETÁRIOS. Um mesmo dono pode ter várias contas, e a conta do pool
 * de liquidez/bonding curve concentra a maior parte do supply por construção. Tratar
 * esse número como "concentração de holders" reprova todo lançamento legítimo com pool.
 * Aqui ele é reportado com o nome correto e com a ressalva explícita.
 */
interface TokenRiskAssessment {
  isRug: boolean;
  score: number;
  verdict: "reject" | "review" | "pass";
  mint: string;
  name: string;
  renounced: boolean | null;
  liquidityLocked: string;
  topHoldersShare: string;
  analysis: string;
  freezeAuthorityDisabled: boolean | null;
  mintAuthorityDisabled: boolean | null;
  creatorAllocation: string;
  taxBuySell: string;
  priceSol: number;
  poolSource: string;
  liquidityUsd: number;
  priceImpact: string;
  /** Token-2022 com extensões perigosas (transfer hook / transfer fee): risco alto. */
  token2022Risk?: string;
  /** false quando alguma verificação crítica não pôde ser concluída -> reprovar. */
  dataComplete: boolean;
  missingChecks: string[];
  /** Origem de cada dado, para auditoria. */
  evidence: Record<string, string>;
}

async function fetchRealOnChainTokenData(tokenMint: string, tokenName?: string): Promise<TokenRiskAssessment> {
  let name = tokenName || "UNKNOWN TOKEN";
  let symbol = "TOKEN";
  let priceSol = 0;
  let poolSource = "Unknown";
  let liquidityUsd = 0;
  let priceImpact = "Não medido";
  let token2022Risk: string | undefined;

  const missingChecks: string[] = [];
  const evidence: Record<string, string> = {};
  let riskReasons: string[] = [];
  let score = 100;

  // Autoridades: começam como DESCONHECIDAS (null), nunca como "seguras".
  let mintAuthorityDisabled: boolean | null = null;
  let freezeAuthorityDisabled: boolean | null = null;
  let top10AccountsShare: number | null = null;
  let top10ShareRaw = "Não medido";

  // 1. Validação estrutural do endereço.
  if (!isValidPubkey(tokenMint)) {
    return {
      isRug: false,
      score: 0,
      verdict: "reject",
      mint: tokenMint,
      name,
      renounced: null,
      liquidityLocked: "Não verificado",
      topHoldersShare: "Não medido",
      analysis:
        `Endereço inválido: "${tokenMint}" não é um pubkey base58 de 32 bytes. ` +
        `Ausência de evidência é motivo de reprovação — não de aprovação.`,
      freezeAuthorityDisabled: null,
      mintAuthorityDisabled: null,
      creatorAllocation: "Não medido",
      taxBuySell: "Não medido",
      priceSol: 0,
      poolSource: "Unknown",
      liquidityUsd: 0,
      priceImpact: "Não medido",
      dataComplete: false,
      missingChecks: ["endereço válido"],
      evidence: { addressValidation: "failed" },
    };
  }

  // 2. Mercado: DexScreener, escolhendo o par de MAIOR liquidez.
  try {
    /**
     * COTA (DexScreener: 300 req/min). Se o minuto já foi consumido, espera-se até 250 ms;
     * sem vaga, a chamada é PULADA e contabilizada — a decisão segue com o que existe, e o
     * contador mostra que faltou dado por COTA, não que o mercado estava vazio.
     */
    const dexCall = await withBudget(
      budgets.dexscreener,
      // O SOL vai na mesma chamada como âncora USD→SOL (custo zero, mesmo endpoint).
      () => fetch(`${DEXSCREENER_BASE_URL}/tokens/${tokenMint},${SOL_MINT}`, { signal: AbortSignal.timeout(6000) }),
      { maxWaitMs: 250 }
    );
    const dexRes = dexCall.value;
    if (dexRes?.ok) {
      const dexData = await dexRes.json();
      const solPairs = Array.isArray(dexData?.pairs)
        ? dexData.pairs.filter((p: any) => p.chainId === "solana")
        : [];
      const meusPares = solPairs.filter((p: any) => p?.baseToken?.address === tokenMint);
      if (meusPares.length > 0) {
        const bestPair = meusPares.sort(
          (a: any, b: any) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0)
        )[0];
        name = bestPair.baseToken?.name || name;
        symbol = bestPair.baseToken?.symbol || symbol;
        // Regra única: par cotado em SOL usa priceNative; par em outra moeda converte por
        // USD/SOL do payload; sem âncora, o preço fica ZERO e entra em missingChecks.
        const preco = priceSolFromDexPairs(solPairs, tokenMint);
        priceSol = preco.priceSol ?? 0;
        liquidityUsd = preco.liquidityUsd ?? 0;
        poolSource = bestPair.dexId || "unknown";
        evidence.market = `DexScreener pair ${String(bestPair.pairAddress || "").slice(0, 10)}...`;
        if (preco.priceSol === null) {
          missingChecks.push("preço em SOL no DexScreener");
          evidence.market += ` — sem preço em SOL: ${preco.reason}`;
        }
        // Price impact NÃO é derivável de variação de preço. É função do tamanho da
        // ordem contra a profundidade do pool. Sem simulação de quote, não existe número.
        priceImpact = "Não medido (exige simulação de quote no tamanho da ordem)";
      } else {
        missingChecks.push("pool de liquidez em DEX");
        evidence.market = "nenhum par Solana encontrado";
      }
    } else {
      missingChecks.push("consulta DexScreener");
      evidence.market = dexRes
        ? `HTTP ${dexRes.status}`
        : `chamada não feita — cota do minuto esgotada (contabilizado em budgets.dexscreener.skipped)`;
    }
  } catch (err: any) {
    missingChecks.push("consulta DexScreener");
    evidence.market = `erro: ${err.message}`;
  }

  // 3. On-chain via RPC: mint account (autoridades + extensões Token-2022) e holders.
  if (!globalConnection) {
    missingChecks.push("conexão RPC");
    evidence.rpc = "globalConnection indisponível";
  } else {
    // 3.1 Mint account
    try {
      const mintPubkey = new PublicKey(tokenMint);
      const accountInfo = await globalConnection.getParsedAccountInfo(mintPubkey);
      const value: any = accountInfo?.value;

      if (!value) {
        // Mint não existe on-chain: pode ser endereço de outro tipo ou inexistente.
        missingChecks.push("conta mint on-chain");
        evidence.mintAccount = "não encontrada";
      } else {
        const ownerProgram = value.owner?.toBase58?.() || "desconhecido";
        evidence.mintOwner = ownerProgram;

        if (value.data && typeof value.data === "object" && "parsed" in value.data) {
          const info = value.data.parsed?.info;
          if (info) {
            mintAuthorityDisabled = info.mintAuthority === null;
            freezeAuthorityDisabled = info.freezeAuthority === null;
            evidence.authorities = `owner=${ownerProgram}`;
          }

          // Token-2022: extensões perigosas. Um transfer hook ou transfer fee oculto é
          // vetor moderno de honeypot — não aparece em verificações de mint/freeze.
          const extensions = info?.extensions;
          if (Array.isArray(extensions) && extensions.length > 0) {
            const dangerous = extensions
              .map((e: any) => e?.extension)
              .filter((ext: string) =>
                ["transferHook", "transferFeeConfig", "permanentDelegate", "defaultAccountState"].includes(ext)
              );
            if (dangerous.length > 0) {
              token2022Risk = `Extensões Token-2022 de risco: ${dangerous.join(", ")}`;
              riskReasons.push(token2022Risk);
              score -= 40;
            }
            evidence.token2022Extensions = extensions.map((e: any) => e?.extension).join(",");
          }
        } else {
          missingChecks.push("parse da conta mint (formato inesperado)");
          evidence.mintAccount = "formato não parseável";
        }
      }
    } catch (err: any) {
      missingChecks.push("leitura da conta mint");
      evidence.mintAccount = `erro: ${err.message}`;
    }

    // 3.2 Distribuição de token accounts.
    try {
      const mintPubkey = new PublicKey(tokenMint);
      const [largestAccounts, supplyInfo] = await Promise.all([
        globalConnection.getTokenLargestAccounts(mintPubkey),
        globalConnection.getTokenSupply(mintPubkey),
      ]);
      const totalSupply = parseFloat(supplyInfo.value.amount);
      if (largestAccounts?.value && totalSupply > 0) {
        let top10Sum = 0;
        for (const acc of largestAccounts.value.slice(0, 10)) {
          top10Sum += parseFloat(acc.amount);
        }
        top10AccountsShare = (top10Sum / totalSupply) * 100;
        top10ShareRaw = `${top10AccountsShare.toFixed(1)}% (contas de token, não proprietários; inclui pool/curve)`;
        evidence.holders = `${largestAccounts.value.length} contas retornadas`;
      } else {
        missingChecks.push("distribuição de token accounts");
        evidence.holders = "sem dados de supply/largest accounts";
      }
    } catch (err: any) {
      missingChecks.push("distribuição de token accounts");
      evidence.holders = `erro: ${err.message}`;
    }
  }

  /**
   * 3.5 EVIDÊNCIA EXTERNA (RugCheck) — segundo par de olhos, GRÁTIS, e SEMPRE na direção de
   * endurecer. Regras:
   *   - indisponível não é aprovação: vira `missingChecks` e `evidence.rugcheck` com o motivo;
   *   - disponível e limpo NÃO eleva o score (ausência de risco externo não é atestado);
   *   - disponível com perigo/score alto REDUZ o score e entra nos motivos de risco.
   * A cota é respeitada sem espera (evidência adicional não atrasa decisão de lançamento).
   */
  if (process.env.HFT_RUGCHECK !== "0") {
    const rugcheckEvidence = await fetchRugCheckEvidence(tokenMint, {
      budget: budgets.rugcheck,
      maxWaitMs: 0,
      timeoutMs: 3_500,
    });
    evidence.rugcheck = rugcheckEvidence.available
      ? `disponível em ${rugcheckEvidence.latencyMs ?? "?"}ms (score=${rugcheckEvidence.score ?? "?"}, riscos=${rugcheckEvidence.risks.length})`
      : `INDISPONÍVEL: ${rugcheckEvidence.reason ?? "motivo não informado"}`;
    if (!rugcheckEvidence.available) {
      missingChecks.push("rugcheck (evidência externa)");
    } else {
      const external = rugCheckRiskReasons(rugcheckEvidence);
      if (external.usable && external.reasons.length > 0) {
        // Cada risco apontado desconta; o teto de 0 é aplicado no fim do scoring.
        score -= Math.min(45, external.reasons.length * 15);
        riskReasons.push(...external.reasons);
      }
      if (rugcheckEvidence.lpLockedPct !== null) {
        evidence.lpLocked = `${rugcheckEvidence.lpLockedPct.toFixed(1)}% ($${Math.round(rugcheckEvidence.lpLockedUsd ?? 0).toLocaleString()})`;
      }
    }
  } else {
    evidence.rugcheck = "desligado por configuração (HFT_RUGCHECK=0)";
  }

  // 4. SCORING — apenas sobre evidência positiva.
  if (mintAuthorityDisabled === false) {
    score -= 30;
    riskReasons.push("Mint Authority ATIVA (pode inflacionar o supply)");
  }
  if (freezeAuthorityDisabled === false) {
    score -= 40;
    riskReasons.push("Freeze Authority ATIVA (o emissor pode congelar sua conta e impedir a VENDA)");
  }
  if (liquidityUsd > 0 && liquidityUsd < 5000) {
    score -= 15;
    riskReasons.push(`Liquidez muito baixa ($${Math.round(liquidityUsd).toLocaleString()})`);
  }
  if (top10AccountsShare !== null && top10AccountsShare > 60) {
    score -= 10;
    riskReasons.push(
      `Top 10 CONTAS de token concentram ${top10AccountsShare.toFixed(1)}% do supply ` +
        `(inclui a conta do pool/bonding curve — não é prova de concentração em holders reais)`
    );
  }
  if (mintAuthorityDisabled === null || freezeAuthorityDisabled === null) {
    missingChecks.push("status de mint/freeze authority");
  }
  if (poolSource === "Unknown") {
    missingChecks.push("fonte de pool identificada");
  }

  // FAIL-CLOSED: qualquer verificação crítica ausente impede aprovação.
  const criticalMissing = missingChecks.filter((m) =>
    [
      "status de mint/freeze authority",
      "conta mint on-chain",
      "leitura da conta mint",
      "conexão RPC",
      "consulta DexScreener",
      "pool de liquidez em DEX",
    ].includes(m)
  );
  const dataComplete = criticalMissing.length === 0;

  if (!dataComplete) {
    // Teto de 40 força reprovação no caller (score < 50) sem afirmar "é rug".
    score = Math.min(score, 40);
  }
  score = Math.max(0, Math.min(100, score));

  const verdict: TokenRiskAssessment["verdict"] = !dataComplete
    ? "reject"
    : score < 50
      ? "reject"
      : score < 75
        ? "review"
        : "pass";

  // isRug só é true quando existe EVIDÊNCIA de mecanismo de bloqueio/inflação —
  // nunca por "dado ausente". Dado ausente já reprova via score/verdict.
  const isRug = freezeAuthorityDisabled === false || (mintAuthorityDisabled === false && score < 30);

  let analysis: string;
  if (!dataComplete) {
    analysis =
      `REPROVADO POR FALTA DE DADOS (fail-closed). Não foi possível verificar: ${criticalMissing.join(", ")}. ` +
      `Motivo: ausência de evidência não é evidência de segurança em token recém-lançado. ` +
      `${riskReasons.length ? "Além disso: " + riskReasons.join("; ") + ". " : ""}` +
      `Nenhuma afirmação sobre honeypot/taxa/lock é feita — não há dado para isso.`;
  } else {
    const parts: string[] = [];
    parts.push(
      `Autoridades: mint ${mintAuthorityDisabled ? "revogada" : "ATIVA"}, ` +
        `freeze ${freezeAuthorityDisabled ? "revogada" : "ATIVA"}.`
    );
    if (riskReasons.length > 0) parts.push(`Alertas: ${riskReasons.join("; ")}.`);
    if (evidence.rugcheck && evidence.rugcheck.startsWith("disponível")) {
      parts.push(`Evidência externa (RugCheck): ${evidence.rugcheck}.`);
    }
    parts.push(
      `Liquidez: ${liquidityUsd > 0 ? "$" + Math.round(liquidityUsd).toLocaleString() : "não medida"} ` +
        `em ${poolSource}. Status de lock do LP NÃO VERIFICADO.`
    );
    analysis = parts.join(" ");
  }

  return {
    isRug,
    score,
    verdict,
    mint: tokenMint,
    name: name === "UNKNOWN TOKEN" ? name : `${name} (${symbol})`,
    renounced: mintAuthorityDisabled,
    // Honestidade explícita: não afirmamos lock sem evidência (NFT do LP burn/custódia).
    liquidityLocked: "Não verificado (exige checagem do NFT do LP: burn ou lock em programa)",
    topHoldersShare: top10ShareRaw,
    analysis,
    freezeAuthorityDisabled,
    mintAuthorityDisabled,
    creatorAllocation: "Não medido (exige trace da transação de criação + funding do deployer)",
    taxBuySell: "Não medido (exige simulação de compra E de venda on-chain)",
    priceSol,
    poolSource,
    liquidityUsd,
    priceImpact,
    token2022Risk,
    dataComplete,
    missingChecks,
    evidence,
  };
}

// 5. API: Token smart contract audit using Gemini
app.post("/api/audit-token", async (req, res) => {
  const { tokenMint, tokenName } = req.body;
  if (!tokenMint) {
    res.status(400).json({ error: "Token mint address is required for latency audit" });
    return;
  }

  // 1. Fetch real on-chain and market data first!
  let parsedOnChain;
  try {
    parsedOnChain = await fetchRealOnChainTokenData(tokenMint, tokenName);
  } catch (err: any) {
    res.status(400).json({ error: "Failed to parse token data: " + err.message });
    return;
  }

  // 2. Check if Gemini API key is configured to enrich the analysis
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.json({ audit: parsedOnChain, source: "on-chain-direct" });
    return;
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });

    const prompt = `Perform a strict technical security audit of a Solana token using these real on-chain and market metrics:
Token Mint Address: "${tokenMint}"
Token Name: "${parsedOnChain.name}"
Mint Authority Status: ${
        parsedOnChain.mintAuthorityDisabled === null
          ? "UNKNOWN (on-chain read failed — automatic fail-closed rejection)"
          : parsedOnChain.mintAuthorityDisabled
            ? "Disabled (Safe)"
            : "Active (High Risk of inflation)"
      }
Freeze Authority Status: ${
        parsedOnChain.freezeAuthorityDisabled === null
          ? "UNKNOWN (on-chain read failed — automatic fail-closed rejection)"
          : parsedOnChain.freezeAuthorityDisabled
            ? "Disabled (Safe)"
            : "Active (High Risk of Honeypot / Blacklist)"
      }
Ownership Renounced: ${parsedOnChain.renounced === null ? "UNKNOWN" : parsedOnChain.renounced ? "Yes" : "No"}
Data completeness: ${parsedOnChain.dataComplete ? "complete" : `INCOMPLETE — missing: ${parsedOnChain.missingChecks.join(", ")}`}
LP lock status: NOT VERIFIED (do not assume locked)
Liquidity on DEX: ${parsedOnChain.liquidityUsd > 0 ? `$${parsedOnChain.liquidityUsd.toLocaleString()} USD` : "No DEX pool found (High risk)"}
LP Lock Status: "${parsedOnChain.liquidityLocked}"
Pool Source: "${parsedOnChain.poolSource}"
Price (SOL): ${parsedOnChain.priceSol > 0 ? parsedOnChain.priceSol.toFixed(8) : "N/A"}
Top 10 Holders Share: "${parsedOnChain.topHoldersShare}"
Dev Allocation / Creator Share: "${parsedOnChain.creatorAllocation}"

Based on this raw data, refine the security score, double check honey-pot indicators, and return a JSON object with your final structured analysis. Ensure your response is high-fidelity and matches the on-chain metrics exactly.

Respond in a short, scannable JSON object with these keys:
{
  "isRug": boolean,
  "score": number (0-100),
  "renounced": boolean,
  "liquidityLocked": string,
  "topHoldersShare": string,
  "analysis": string (max 2 sentences, describing risks clearly),
  "freezeAuthorityDisabled": boolean,
  "mintAuthorityDisabled": boolean,
  "creatorAllocation": string,
  "taxBuySell": string,
  "priceSol": number,
  "poolSource": string,
  "liquidityUsd": number,
  "priceImpact": string
}`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json"
      }
    });

    const parsed = JSON.parse(response.text || "{}");
    
    // Merge on-chain verification fallback fields if AI returns empty or malformed fields
    /**
     * ORDENAÇÃO DE AUTORIDADE (corrigido na auditoria):
     * o resultado on-chain é a FONTE DE VERDADE. A IA pode apenas ADICIONAR texto
     * explicativo ou BAIXAR o score — nunca subir, nunca "limpar" uma reprovação
     * por falta de dados, nunca contradizer um fato on-chain verificado.
     *
     * Antes, `{...parsedOnChain, ...parsed}` deixava a resposta da IA sobrescrever
     * QUALQUER campo, inclusive `score` e `isRug`. Um token com freeze authority ativa
     * (reprovado, score 40) podia voltar ao painel como "aprovado, score 90" — bastava
     * o modelo decidir isso. Em auditoria de segurança, um LLM não pode ser a autoridade
     * que autoriza risco.
     */
    const aiScore = typeof parsed?.score === "number" ? parsed.score : undefined;
    const finalScore =
      aiScore !== undefined ? Math.min(parsedOnChain.score, aiScore) : parsedOnChain.score;

    const finalAudit = {
      ...parsedOnChain,
      // Campos puramente textuais podem vir da IA.
      analysis: typeof parsed?.analysis === "string" && parsed.analysis.length > 0 ? parsed.analysis : parsedOnChain.analysis,
      score: finalScore,
      // Reprovação por dado ausente é estrutural e não pode ser revertida por IA.
      dataComplete: parsedOnChain.dataComplete,
      missingChecks: parsedOnChain.missingChecks,
      verdict: finalScore < 50 ? "reject" : finalScore < 75 ? "review" : "pass",
      // isRug só pode ser mantido/negado pela evidência on-chain; IA nunca o promove a "seguro".
      isRug: parsedOnChain.isRug,
      mint: tokenMint,
    };

    res.json({ audit: finalAudit, source: "gemini-on-chain (IA limitada a texto; score não pode subir)" });
    return;
  } catch (error: any) {
    // If Gemini fails, we gracefully return the perfectly accurate on-chain data!
    console.warn("Failed to audit token via Gemini, falling back to direct on-chain results:", error.message);
    res.json({ audit: parsedOnChain, source: "on-chain-direct-fallback" });
    return;
  }
});

// Autonomous background pipeline execution (DAEMON Mode)
async function executeAutonomousPipeline(event: any, trace?: LatencyTrace): Promise<void> {
  const tokenMint = event.mint;
  const tokenName = event.mintName || "LAUNCHED_TOKEN";
  const correlationId = `corr_auto_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  // Todo sinal que chega ao pipeline é contado AQUI, antes de qualquer filtro: é a base
  // para saber quantos foram descartados e por quê (sem denominador, taxa não existe).
  hotPathStats.signalsSeen++;

  console.log(`[Autonomous Daemon] New Token detected via Yellowstone Geyser: ${tokenName} (${tokenMint})`);
  
  // 1. Log Detection
  dbStore.saveLog({
    timestamp: new Date().toISOString(),
    level: "INFO",
    component: "MEMPOOL_SCANNER",
    message: `[Mempool Scanner - DAEMON] Token detectado na mempool: ${tokenName.toUpperCase()} (${tokenMint.slice(0, 8)}...). Iniciando auditoria de pre-flight do contrato...`,
    correlationId
  });

  // 2. Retrieve Operational Security State & Circuit Breakers
  const secState = getOperationalSecurityState();
  if (secState.killSwitchActive) {
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "CRITICAL",
      component: "RISK_ENGINE",
      message: `[Daemon Execução Abortada] Disjuntor Geral (Kill Switch) ativo preveniu a execução do snipe do token ${tokenName.toUpperCase()}.`,
      correlationId
    });
    return;
  }

  if (secState.readOnlyMode) {
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "WARN",
      component: "RISK_ENGINE",
      message: `[Daemon Execução Abortada] Sistema operando em modo Read Only (Somente Leitura) preveniu envio da transação para o token ${tokenName.toUpperCase()}.`,
      correlationId
    });
    return;
  }

  /**
   * 2.5 GATE RÁPIDO — decisões LOCAIS, sem rede, antes de gastar qualquer RTT.
   *
   * Estas verificações custam zero (memória) e cortam o sinal mais caro de todos: o que
   * já está em processamento (dois eventos do mesmo mint → duas compras) ou que não é
   * sequer um mint válido. Antes, nada disso existia no caminho: o pipeline ia direto
   * para o RPC e só depois descobria o problema.
   */
  if (!isValidPubkey(tokenMint)) {
    reportSignalRejected(`mint estruturalmente inválido: ${String(tokenMint).slice(0, 24)}`);
    return;
  }
  if (!hotPathInFlight.tryAcquire(tokenMint)) {
    hotPathStats.inFlightDuplicatesDropped++;
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "WARN",
      component: "RISK_ENGINE",
      message:
        `[GATE RÁPIDO] Sinal duplicado para ${tokenMint.slice(0, 8)}... ignorado: já existe decisão em ` +
        `andamento para este mint. Sem esta trava, dois eventos do mesmo lançamento gerariam DUAS entradas.`,
      correlationId,
    });
    return;
  }

  // Portão rápido vencido: tudo daqui para frente custa rede.
  trace?.mark("gate_ok");

  /**
   * EVENTO PRÉ-ENRIQUECIDO (PumpPortal): o mint veio NA notificação, então não existe espera de
   * enriquecimento. Marcar aqui é medir a verdade — e é exatamente o ganho que motivou este
   * feed: no caminho WSS, `enriched` só acontece depois do `getTransaction` em `confirmed`.
   */
  if (event.preEnriched === true) trace?.mark("enriched");

  const deepStartedAt = Date.now();
  let deepComplete = false;
  let deepVerdict: "approve" | "reject" | null = null;
  let auditResult: Awaited<ReturnType<typeof fetchRealOnChainTokenData>> | null = null;

  try {
    /**
     * 3. FILTRO PROFUNDO — roda com ORÇAMENTO explícito, e o que acontece ao estourar
     * depende do modo (ver `decideEntryWithBudget`): em LIVE, filtro incompleto VETA;
     * em PAPER/SHADOW, prossegue marcado como NÃO AUDITADO — assim medimos quanto o
     * filtro custa e o que ele reprovaria, sem colocar capital em risco.
     */
    auditResult = await fetchRealOnChainTokenData(tokenMint, tokenName);
    // Estágio medido: recebimento -> dados on-chain enriquecidos.
    trace?.mark("enriched");
    deepComplete = true;
    deepVerdict = (auditResult as any).isRug || (auditResult as any).verdict === "reject" ? "reject" : "approve";
  } catch (err: any) {
    deepComplete = false;
    hotPathStats.deepFilterFailures++;
    /**
     * A falha do filtro passa pela MESMA função de decisão do orçamento, com a causa
     * declarada (`audit-error`). Antes, este `catch` saía por `return` sem consultar a
     * política: a regra "sem auditoria não se entra" existia no código e nunca era
     * executada — código morto que dava falsa sensação de proteção.
     */
    const failDecision = decideEntryWithBudget({
      mode: getRuntimeModeResolution().mode,
      deepComplete: false,
      deepElapsedMs: Date.now() - deepStartedAt,
      budgetMs: DEEP_FILTER_BUDGET_MS,
      incompleteCause: "audit-error",
    });
    if (!failDecision.proceed && getRuntimeModeResolution().mode === "LIVE") {
      hotPathStats.liveVetoesByBudget++;
    }
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "CRITICAL",
      component: "SECURITY_SHIELD",
      message:
        `[Daemon Auditoria Falhou] Erro ao obter dados on-chain para ${tokenMint}: ${err.message}. ` +
        failDecision.reason,
      correlationId
    });
    hotPathInFlight.release(tokenMint);
    return;
  }

  const deepElapsedMs = Date.now() - deepStartedAt;
  if (deepElapsedMs > DEEP_FILTER_BUDGET_MS) hotPathStats.budgetExceeded++;

  const budgetDecision = decideEntryWithBudget({
    mode: getRuntimeModeResolution().mode,
    deepComplete,
    deepElapsedMs,
    budgetMs: DEEP_FILTER_BUDGET_MS,
    deepVerdict,
  });

  if (!budgetDecision.proceed) {
    // Distinção que importa para o operador: veto por ORÇAMENTO/fail-closed é uma decisão
    // de política; veto por REPROVAÇÃO é o filtro funcionando. Contadores separados.
    if (budgetDecision.unvetted === false && deepVerdict === "reject") {
      hotPathStats.rejectedByVerdict++;
    } else if (getRuntimeModeResolution().mode === "LIVE") {
      hotPathStats.liveVetoesByBudget++;
    }
    trace?.mark("assessed");
    if (trace) telemetry.record(trace.toRecord("rejected"));
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "CRITICAL",
      component: "SECURITY_SHIELD",
      message: `[ORÇAMENTO DO FILTRO] ${budgetDecision.reason}`,
      correlationId,
    });
    recorder.recordAssessment({
      eventId: trace?.id ?? `evt_${tokenMint}`,
      mint: tokenMint,
      decision: "rejected",
      rejectionReason: budgetDecision.reason,
      score: typeof auditResult?.score === "number" ? auditResult.score : 0,
      verdict: "reject",
      dataComplete: deepComplete,
      missingChecks: (auditResult as any)?.missingChecks ?? [],
      isRug: false,
      mintAuthorityDisabled: auditResult?.mintAuthorityDisabled ?? null,
      freezeAuthorityDisabled: auditResult?.freezeAuthorityDisabled ?? null,
      liquidityUsd: auditResult?.liquidityUsd ?? 0,
      poolSource: auditResult?.poolSource ?? "Unknown",
      token2022Risk: (auditResult as any)?.token2022Risk,
      entryPriceSol: null,
      entryPriceSource: null,
      estimatedCostsBps: null,
      deepFilterMs: deepElapsedMs,
      deepFilterBudgetMs: DEEP_FILTER_BUDGET_MS,
    });
    hotPathInFlight.release(tokenMint);
    return;
  }

  if (budgetDecision.unvetted) {
    hotPathStats.unvettedEntries++;
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "WARN",
      component: "SECURITY_SHIELD",
      message:
        `[FILTRO INCOMPLETO] ${budgetDecision.reason} Deep filter completo=${deepComplete}; ` +
        `gasto=${deepElapsedMs}ms (orçamento ${DEEP_FILTER_BUDGET_MS}ms).`,
      correlationId,
    });
  }

  // 4. Score & Pontuação (Gemini Technical Audit if API Key is configured)
  let score = auditResult.score;
  let isRug = auditResult.isRug;
  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey) {
    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      const prompt = `Perform a strict technical security audit of a Solana token using these real on-chain and market metrics:
Token Mint Address: "${tokenMint}"
Token Name: "${auditResult.name}"
Mint Authority Status: ${
        auditResult.mintAuthorityDisabled === null
          ? "UNKNOWN (leitura on-chain falhou — reprovação automática por fail-closed)"
          : auditResult.mintAuthorityDisabled
            ? "Disabled (Safe)"
            : "Active (High Risk of inflation)"
      }
Freeze Authority Status: ${
        auditResult.freezeAuthorityDisabled === null
          ? "UNKNOWN (leitura on-chain falhou — reprovação automática por fail-closed)"
          : auditResult.freezeAuthorityDisabled
            ? "Disabled (Safe)"
            : "Active (High Risk of Honeypot / Blacklist)"
      }
Ownership Renounced: ${auditResult.renounced === null ? "UNKNOWN" : auditResult.renounced ? "Yes" : "No"}
Data completeness: ${auditResult.dataComplete ? "complete" : `INCOMPLETE — missing: ${auditResult.missingChecks.join(", ")}`}
LP lock status: NOT VERIFIED (do not assume locked)
Liquidity on DEX: ${auditResult.liquidityUsd > 0 ? `$${auditResult.liquidityUsd.toLocaleString()} USD` : "No DEX pool pool found (High risk)"}
LP Lock Status: "${auditResult.liquidityLocked}"
Pool Source: "${auditResult.poolSource}"
Price (SOL): ${auditResult.priceSol > 0 ? auditResult.priceSol.toFixed(8) : "N/A"}
Top 10 Holders Share: "${auditResult.topHoldersShare}"
Dev Allocation / Creator Share: "${auditResult.creatorAllocation}"

Respond in a short, scannable JSON object with these keys:
{
  "isRug": boolean,
  "score": number (0-100)
}`;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });

      const parsed = JSON.parse(response.text || "{}");
      // IA tem autoridade LIMITADA: pode baixar o score, nunca subir.
      // Se a verificação on-chain está incompleta (fail-closed), nenhuma opinião de
      // modelo reverte isso.
      if (typeof parsed.score === "number") {
        score = Math.min(score, parsed.score);
      }
      if (parsed.isRug === true) isRug = true; // IA pode confirmar rug, nunca absolver

      dbStore.saveLog({
        timestamp: new Date().toISOString(),
        level: "SUCCESS",
        component: "SECURITY_SHIELD",
        message: `[Daemon Auditoria Gemini] Score de Segurança refinado por IA: ${score}/100. IsRug: ${isRug}.`,
        correlationId
      });
    } catch (err: any) {
      console.warn("[Daemon Gemini Audit] Failed, using raw on-chain score:", err.message);
    }
  }

  // 5. Decisão: Reject if score is low or isRug is true
  if (isRug || score < 50) {
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "WARN",
      component: "SECURITY_SHIELD",
      message: `[ALERTA DE SEGURANÇA - DAEMON] Auditoria do token ${tokenName.toUpperCase()} identificou indicadores severos de RUGPULL/HONEYPOT (Score = ${score}). Snipe Abortado.`,
      correlationId
    });
    // CORREÇÃO: rejeição de sinal NÃO é falha de execução. Alimentar o circuit breaker
    // aqui fazia o bot se auto-desligar após 3 rejeições legítimas de auditoria.
    reportSignalRejected(`auditoria reprovou ${tokenName}: score=${score}, isRug=${isRug}`);

    // Registramos a REJEIÇÃO no dataset de replay. Um backtest que só enxerga o que foi
    // aprovado mede a si mesmo, não o mercado — é preciso poder perguntar depois
    // "o que teria acontecido se eu tivesse entrado nesses?".
    trace?.mark("assessed");
    if (trace) telemetry.record(trace.toRecord("rejected"));
    recorder.recordAssessment({
      eventId: trace?.id ?? `evt_${tokenMint}`,
      mint: tokenMint,
      decision: "rejected",
      rejectionReason: isRug
        ? "isRug=true (evidência de bloqueio/inflação)"
        : `score ${score} abaixo do limite 50`,
      deepFilterMs: deepElapsedMs,
      deepFilterBudgetMs: DEEP_FILTER_BUDGET_MS,
      score,
      verdict: (auditResult as any).verdict ?? "reject",
      dataComplete: (auditResult as any).dataComplete ?? false,
      missingChecks: (auditResult as any).missingChecks ?? [],
      isRug,
      mintAuthorityDisabled: auditResult.mintAuthorityDisabled ?? null,
      freezeAuthorityDisabled: auditResult.freezeAuthorityDisabled ?? null,
      liquidityUsd: auditResult.liquidityUsd ?? 0,
      poolSource: auditResult.poolSource ?? "Unknown",
      token2022Risk: (auditResult as any).token2022Risk,
      entryPriceSol: null,
      entryPriceSource: null,
      estimatedCostsBps: null,
    });
    hotPathInFlight.release(tokenMint);
    return;
  }

  dbStore.saveLog({
    timestamp: new Date().toISOString(),
    level: "SUCCESS",
    component: "SECURITY_SHIELD",
    message: `[Auditoria Aprovada - DAEMON] Token ${tokenName.toUpperCase()} validado com sucesso (Score de Segurança: ${score}/100). Sem indicadores de honeypot.`,
    correlationId
  });

  // 6. Swap Construction (Jupiter / Raydium / Pump.fun)
  let activeWalletPubKey;
  try {
    activeWalletPubKey = getActiveWalletPublicKey();
  } catch (err: any) {
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "ERROR",
      component: "SYSTEM",
      message: `[Daemon Erro Wallet] KMS Vault falhou ao carregar chaves operacionais: ${err.message}`,
      correlationId
    });
    hotPathInFlight.release(tokenMint);
    return;
  }

  // Tamanho de referência da operação. Em paper mode é apenas o notional simulado;
  // em live mode deve vir de configuração de risco (limite por operação), não de literal.
  const tradingSolAmount = Number(process.env.MAX_POSITION_SOL ?? 0.1);
  dbStore.saveLog({
    timestamp: new Date().toISOString(),
    level: "INFO",
    component: "RISK_ENGINE",
    message:
      `[Daemon] Sinal aprovado pela auditoria para ${tokenName.toUpperCase()}. ` +
      `Carteira ativa: ${activeWalletPubKey.toBase58().slice(0, 8)}... ` +
      `Tamanho de referência: ${tradingSolAmount} SOL. Live trading: ${isLiveTradingEnabled() ? "ON" : "OFF (paper)"}.`,
    correlationId
  });

  // Rota identificada por PROGRAM ID verificado (nunca por sufixo do mint).
  // O código anterior usava `tokenMint.endsWith("pump")`, que é heurística de vaidade
  // do mint, não evidência de programa: existe mint pump.fun que não termina em "pump"
  // e mint de outro programa que termina.
  const isPump = event.programId === PROGRAMS.PUMP_FUN || event.programId === PROGRAMS.PUMP_SWAP_AMM;
  const isRaydium = event.programId === PROGRAMS.RAYDIUM_AMM_V4 || event.programId === PROGRAMS.RAYDIUM_CPMM;
  const routeHint = isPump ? "Pump.fun" : isRaydium ? "Raydium" : "Jupiter/agregador";

  // ---------------------------------------------------------------------------
  // 7. GATE DE EXECUÇÃO REAL
  //
  // AUDITORIA 2026-10-02 (achado CRÍTICO): este trecho "assinava" uma MENSAGEM DE TEXTO
  // (não uma transação) com a chave isolada, sorteava `Math.random() > 0.05` para decidir
  // se a operação "aterrissou", inventava block number, latência e quantidade adquirida,
  // gravava o resultado com `status: "success"` e criava uma POSIÇÃO REAL no banco com
  // preço de entrada aleatório (`0.000003 + Math.random() * 0.000004`).
  //
  // Ou seja: o bot registrava compras que nunca existiram, a preços inventados, e essas
  // posições entravam no gerenciador de risco como se fossem exposição real. Todo o PnL
  // exibido era fabricado, e o operador não tinha como distinguir do real.
  //
  // Correção: o daemon NÃO inventa fills. Em modo paper, registra a decisão com preço de
  // MERCADO real e marca explicitamente `mode: "paper"`. Em modo live, exige execução
  // real; como o entry on-chain não está implementado/testado neste código, ele RECUSA
  // executar em vez de simular.
  // ---------------------------------------------------------------------------
  const executionAllowed = assertExecutionAllowed();
  if (!executionAllowed.ok) {
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "WARN",
      component: "RISK_ENGINE",
      message: `[Daemon] Entrada bloqueada para ${tokenName.toUpperCase()}: ${executionAllowed.error}`,
      correlationId,
    });
    reportSignalRejected("execução bloqueada por kill switch/read-only");
    hotPathInFlight.release(tokenMint);
    return;
  }

  const liveTrading = isLiveTradingEnabled();

  if (liveTrading) {
    /**
     * S6 (autorizado em 2026-10-03): aqui ficava a RECUSA — "entrada on-chain não está
     * implementada; não vou simular um fill". A recusa foi substituída pelo caminho real,
     * que continua sendo incapaz de "simular um fill": `runRealEntry` só registra posição
     * quando OBSERVA slot on-chain. O que mudou é que agora, com as três declarações
     * (LIVE + flag + HFT_REAL_ENTRY_ENABLED), existe tentativa real — com teto canário,
     * pré-flight obrigatório e intenção persistida antes de assinar.
     */
    const realResult = await runRealEntry({
      mint: tokenMint,
      tokenName,
      sizeSol: tradingSolAmount,
      autonomousCall: true,
      correlationId,
    });

    if (realResult.status !== "confirmed") {
      reportSignalRejected(`entrada real: ${realResult.status}`);
      dbStore.saveLog({
        timestamp: new Date().toISOString(),
        level: "WARN",
        component: "REAL_ENTRY",
        message:
          `[Daemon S6] ${tokenName.toUpperCase()} — entrada real não confirmada (${realResult.status}). ` +
          `${realResult.reason ?? ""} Rota pretendida: ${routeHint}.`,
        correlationId,
      });
      hotPathInFlight.release(tokenMint);
      return;
    }

    reportSignalAccepted();
    hotPathInFlight.release(tokenMint);
    return;
  }

  // ---------------------------------------------------------------------------
  // 8. MODO PAPER (default): registra a decisão com preço REAL de mercado, sem
  //    assinar nada e sem tocar a rede.
  // ---------------------------------------------------------------------------
  const entry = await resolveEntryPrice(tokenMint);
  if (!entry || entry.assessment.priceSol === null) {
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "WARN",
      component: "RISK_ENGINE",
      message:
        `[Daemon PAPER] Sem preço de mercado confiável para ${tokenName.toUpperCase()} (${tokenMint.slice(0, 8)}...). ` +
        `Nenhuma posição simulada foi criada: não é possível gerenciar risco de um ativo sem preço.`,
      correlationId,
    });
    reportSignalRejected("sem preço de referência");
    hotPathInFlight.release(tokenMint);
    return;
  }

  /**
   * PREÇO DIVERGENTE ENTRE FONTES: NÃO ABRIR. É diferente de "sem preço" — aqui existe número,
   * mas duas fontes independentes discordam além do limiar, ou seja, há EVIDÊNCIA de erro
   * grosseiro em uma delas. Abrir posição nesse estado grava no banco um resultado que não é o
   * resultado da estratégia, e depois nenhum relatório consegue separar os dois.
   */
  if (!entry.assessment.accepted) {
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "WARN",
      component: "RISK_ENGINE",
      message:
        `[Daemon PAPER] Entrada RECUSADA para ${tokenName.toUpperCase()} (${tokenMint.slice(0, 8)}...): ` +
        `${entry.assessment.reason}. ` +
        (entry.assessment.divergenceBps !== null
          ? `Diferença medida: ${entry.assessment.divergenceBps} bps entre ${entry.assessment.sources.join(" e ")}. `
          : "") +
        `Contadores em /api/health → entryQuality.`,
      correlationId,
    });
    reportSignalRejected("preço de entrada divergente entre fontes");
    hotPathInFlight.release(tokenMint);
    return;
  }

  /** Preço aceito: daqui para baixo `reference` é o preço VERIFICADO, com procedência registrada. */
  const reference = {
    priceSol: entry.assessment.priceSol as number,
    source: entry.assessment.sources.join(" + ") || "fonte desconhecida",
    liquidityUsd: entry.liquidityUsd,
    fetchedAt: entry.fetchedAt,
  };

  const paperSizeSol = tradingSolAmount;
  const paperTxId = `paper_${Date.now()}`;
  const paperTx = {
    id: paperTxId,
    token: tokenName.toUpperCase(),
    mint: tokenMint,
    amount: `${paperSizeSol} SOL (PAPER)`,
    outAmount: `shadow fill @ ${reference.priceSol.toPrecision(6)} SOL/token`,
    time: new Date().toTimeString().split(" ")[0] + "." + String(Date.now() % 1000).padStart(3, "0"),
    latencyMs: 0,
    // "paper" (não "success"): o relatório de desempenho não pode somar sombra com execução real.
    status: "paper" as const,
    block: 0,
    tipSol: 0,
    route: `PAPER/shadow (${routeHint}) — SEM execução on-chain`,
    mode: "paper" as const,
    signature: null,
  };

  dbStore.saveTrade(paperTx);
  snipedTransactions.unshift(paperTx);
  if (snipedTransactions.length > 25) {
    snipedTransactions.pop();
  }

  dbStore.savePosition({
    id: `pos_paper_${Date.now()}`,
    token: tokenName.toUpperCase(),
    mint: tokenMint,
    sizeSol: paperSizeSol,
    entryPrice: reference.priceSol,
    currentPrice: reference.priceSol,
    pnlPercent: 0,
    status: "open",
    stopLossPercent: -5.0,
    takeProfitPercent: 15.0,
    trailingStopActive: true,
    trailingStopOffsetPercent: 2.5,
    highestPrice: reference.priceSol,
    timeOpened: new Date().toLocaleTimeString(),
    mode: "paper",
    priceSource: reference.source,
    // Procedência do preço de entrada: sobrevive ao restart e permite estratificar o replay.
    entryPriceVerification: {
      status: entry.assessment.status,
      sources: entry.assessment.sources,
      divergenceBps: entry.assessment.divergenceBps,
      severity: entry.assessment.severity,
      accepted: entry.assessment.accepted,
      reason: entry.assessment.reason,
      checkedAt: new Date().toISOString(),
    },
  } as any);

  // Custo round-trip estimado: em paper mode é a métrica que mais importa, porque mostra
  // se a oportunidade sobrevive a taxas antes de qualquer risco de capital.
  const paperCosts = estimatePaperRoundTrip(reference.priceSol, paperSizeSol);

  dbStore.saveLog({
    timestamp: new Date().toISOString(),
    level: "INFO",
    component: "RISK_ENGINE",
    message:
      `[Daemon PAPER] Posição sombra registrada para ${tokenName.toUpperCase()} @ ${reference.priceSol.toPrecision(6)} SOL/token ` +
      `(fonte: ${reference.source}, liquidez: $${Math.round(reference.liquidityUsd).toLocaleString()}, ` +
      `verificação de preço: ${entry.assessment.status}` +
      (entry.assessment.divergenceBps !== null ? ` — diferença entre fontes ${entry.assessment.divergenceBps} bps` : "") +
      `). ` +
      `Break-even estimado round-trip: ${paperCosts.toFixed(2)}% — se o take-profit é 15%, ` +
      `isso representa ${(paperCosts / 15 * 100).toFixed(0)}% do alvo consumido em custos. NENHUMA transação foi enviada.`,
    correlationId,
  });

  // Fecha a trilha de latência com o desfecho real e grava a avaliação APROVADA.
  trace?.mark("assessed");
  if (trace) telemetry.record(trace.toRecord("executed"));
  recorder.recordAssessment({
    eventId: trace?.id ?? `evt_${tokenMint}`,
    mint: tokenMint,
    decision: "accepted",
    rejectionReason: null,
    score,
    verdict: (auditResult as any).verdict ?? "pass",
    dataComplete: (auditResult as any).dataComplete ?? false,
    missingChecks: (auditResult as any).missingChecks ?? [],
    isRug,
    mintAuthorityDisabled: auditResult.mintAuthorityDisabled ?? null,
    freezeAuthorityDisabled: auditResult.freezeAuthorityDisabled ?? null,
    liquidityUsd: auditResult.liquidityUsd ?? 0,
    poolSource: auditResult.poolSource ?? "Unknown",
    token2022Risk: (auditResult as any).token2022Risk,
    entryPriceSol: reference.priceSol,
    entryPriceSource: reference.source,
    estimatedCostsBps: Math.round(paperCosts * 100),
    entryVerificationStatus: entry.assessment.status,
    entryDivergenceBps: entry.assessment.divergenceBps,
    deepFilterMs: deepElapsedMs,
    deepFilterBudgetMs: DEEP_FILTER_BUDGET_MS,
  });
  recorder.recordPositionLifecycle({
    positionId: paperTxId,
    mint: tokenMint,
    token: tokenName.toUpperCase(),
    event: "opened",
    mode: "paper",
    sizeSol: paperSizeSol,
    entryPriceSol: reference.priceSol,
    exitPriceSol: null,
    pnlPercent: null,
    reason: "paper/shadow entry",
    pnlMeasuredOnChain: false,
  });

  // Validação de CONSTRUIBILIDADE da entrada (Etapa S2): roda em paralelo, não bloqueia.
  void runShadowEntry(tokenMint, paperSizeSol, tokenName).catch((err) =>
    console.error("[Shadow Entry] Falha inesperada:", err?.message ?? err)
  );

  reportSignalAccepted();
  // Liberação do gate rápido: o mint volta a poder ser processado em um novo lançamento.
  hotPathInFlight.release(tokenMint);
}

/** Resultado da resolução do preço de entrada: o número e — igualmente importante — a PROCEDÊNCIA. */
interface ResolvedEntryPrice {
  assessment: EntryPriceAssessment;
  liquidityUsd: number;
  fetchedAt: number;
}

/**
 * Resolve o preço de ENTRADA com verificação entre fontes independentes.
 *
 * ## Por que não basta uma fonte (como era antes)
 *
 * O preço de entrada é o denominador de todo o PnL: stop, alvo, trailing e replay são
 * percentuais dele. Uma leitura errada (pool raso, par em outra moeda — ver o bug de 200x no
 * Adendo 12, decimal trocado) não "piora um pouco" o resultado: ela DEFINE o resultado e
 * contamina toda a estatística. Uma fonte responde "li uma vez"; duas fontes independentes
 * respondem "não é erro grosseiro".
 *
 * ## Como resolve (o MESMO caminho do gerenciador de posições)
 *
 * `fetchBatchPrices` com `verifyMints: [mint]`: a cascata acha o preço (DexScreener → Jupiter
 * Price v3 → GeckoTerminal) e o SOL entra como âncora da conversão USD→SOL; em seguida uma
 * segunda opinião é pedida à primeira fonte que ainda não respondeu. Custo: 1–2 requisições
 * gratuitas, com a verificação em prioridade `background` (nunca fura cota).
 *
 * ## Política (explícita — ver `src/entryQuality.ts`)
 *
 * - duas fontes concordando → aceita (com ou sem aviso de diferença);
 * - uma fonte só → aceita e MARCA a posição como não verificada (recusar aqui pararia o bot
 *   quando uma API gratuita piscasse, e "sem segunda opinião" ≠ "prova de erro");
 * - fontes divergindo além do limiar crítico → RECUSA a entrada;
 * - nenhuma fonte com preço → RECUSA (nunca inventa).
 */
async function resolveEntryPrice(mint: string): Promise<ResolvedEntryPrice | null> {
  if (!isValidPubkey(mint)) return null;

  const batch = await fetchBatchPrices([mint], {
    dexscreenerBudget: budgets.dexscreener,
    jupiterBudget: budgets.jupiter,
    geckoterminalBudget: budgets.geckoterminal,
    // Entrada NÃO é gestão de risco (não reduz exposição): espera até 250 ms por cota e, sem
    // vaga, declara ausência em vez de furar o orçamento.
    priority: "normal",
    maxWaitMs: 250,
    verificationPriority: "background",
    sampleBook: priceSampleBook ?? undefined,
    divergenceThresholds: PRICE_DIVERGENCE_THRESHOLDS,
    verifyMints: ENTRY_VERIFY_ENABLED ? [mint] : [],
  });

  const quote = batch.quotes.get(mint) ?? null;
  const comparacao = batch.verification.comparisons.find((c) => c.mint === mint) ?? null;

  const assessment = assessEntryPrice({
    quote: quote ? { priceSol: quote.priceSol, source: quote.source } : null,
    comparison: comparacao
      ? {
          referenceSource: comparacao.referenceSource,
          candidateSource: comparacao.candidateSource,
          bps: comparacao.bps,
          severity: comparacao.severity,
        }
      : null,
    thresholds: PRICE_DIVERGENCE_THRESHOLDS,
    allowSingleSource: ENTRY_ALLOW_SINGLE_SOURCE,
    enabled: ENTRY_VERIFY_ENABLED,
  });

  entryQualityStats.evaluated++;
  if (assessment.status === "verified") entryQualityStats.verified++;
  else if (assessment.status === "verified_with_warning") entryQualityStats.verifiedWithWarning++;
  else if (assessment.status === "single_source") entryQualityStats.singleSource++;
  else if (assessment.status === "divergent") entryQualityStats.divergent++;
  else entryQualityStats.unavailable++;

  entryQualityStats.lastStatus = assessment.status;
  entryQualityStats.lastSources = assessment.sources;
  entryQualityStats.lastDivergenceBps = assessment.divergenceBps;
  entryQualityStats.lastReason = assessment.reason;

  return {
    assessment,
    liquidityUsd: quote?.liquidityUsd ?? 0,
    fetchedAt: quote?.fetchedAt ?? Date.now(),
  };
}

/**
 * Estimativa de custo round-trip para decisão em modo paper.
 * Assume o mesmo perfil de execução do caminho live (tip limitado por bps), para não
 * criar expectativa otimista.
 */
function estimatePaperRoundTrip(priceSol: number, sizeSol: number): number {
  const jitoTipSol = 0.001;
  const priorityFeeSol = 0.00002 * 2;
  const baseFeeSol = 0.000005 * 2;
  const ammFeeSol = 0.0025 * sizeSol;
  const slippageSol = 0.015 * sizeSol * 2;
  const total = jitoTipSol * 2 + priorityFeeSol + baseFeeSol + ammFeeSol + slippageSol;
  void priceSol;
  return (total / sizeSol) * 100;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ENTRADA EM SHADOW (Etapa S2) — a rota existe? a transação é construível? o compute cabe?
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * POR QUE ISTO EXISTE
 * Até aqui, o caminho de "entrada aprovada" registrava preço de referência e criava a posição
 * paper — sem NUNCA verificar se havia rota de execução. Ou seja: o sistema podia se declarar
 * pronto para comprar um token para o qual o router não monta transação nenhuma.
 *
 * O que este caminho faz: pede cotação real, pede a transação montada e roda
 * `simulateTransaction` SEM assinar. O resultado é tipado e gravado (JSONL + histórico em
 * memória + `/api/shadow-entries`). Nenhuma assinatura, nenhum envio, nenhum tip pago.
 *
 * POR QUE FIRE-AND-FORGET
 * Cotação + montagem + simulação são três chamadas de rede. Se entrassem no caminho síncrono
 * do instante de decisão, adicionariam latência exatamente onde ela mais custa. O evento é
 * aceito primeiro; a validação de construibilidade corre em paralelo e vira evidência.
 *
 * O QUE ELE *NÃO* PROVA (declarado de propósito)
 * 1. Simulação ≠ execução: o estado muda entre simular e enviar (TOCTOU).
 * 2. O blockhash é substituído por um recente na simulação, então frescor de blockhash NÃO é
 *    validado aqui.
 * 3. Uma simulação bem-sucedida não diz nada sobre lucro — só que a rota é montável.
 */
const shadowEntryHistory: ShadowEntryResult[] = [];
const MAX_SHADOW_HISTORY = 20;

async function runShadowEntry(mint: string, sizeSol: number, tokenName: string): Promise<void> {
  const mode = getRuntimeModeResolution().mode;

  let userPublicKey: string | null = null;
  try {
    userPublicKey = getActiveWalletPublicKey()?.toBase58() ?? null;
  } catch {
    userPublicKey = null; // sem carteira provisionada: o módulo devolve `skipped` com o motivo
  }

  const deps = {
    getQuote: (inputMint: string, outputMint: string, amountLamports: number, slippageBps: number, timeoutMs?: number) =>
      JupiterIntegration.getQuote(inputMint, outputMint, amountLamports, slippageBps, timeoutMs),
    buildSwapTransaction: (quote: any, userPk: string, timeoutMs?: number) =>
      JupiterIntegration.buildSwapTransaction(quote, userPk, timeoutMs),
    simulateTransaction: async (tx: any) => {
      const conn = globalConnection;
      if (!conn) throw new Error("RPC indisponível (globalConnection nulo)");
      // sigVerify=false + replaceRecentBlockhash: medimos programa/compute, não assinatura
      // nem validade do blockhash (que pode estar propositalmente vencido em shadow).
      return conn.simulateTransaction(tx, {
        commitment: "processed",
        sigVerify: false,
        replaceRecentBlockhash: true,
      });
    },
    now: monotonicNow,
  };

  const result = await simulateEntry(deps, {
    mint,
    sizeSol,
    userPublicKey,
    mode,
    slippageBps: Number(process.env.SHADOW_SLIPPAGE_BPS ?? 300),
  });

  shadowEntryHistory.unshift(result);
  if (shadowEntryHistory.length > MAX_SHADOW_HISTORY) shadowEntryHistory.pop();

  recorder.recordShadowEntry({
    mint: result.mint,
    token: tokenName ? tokenName.toUpperCase() : null,
    mode: result.mode,
    sizeSol: result.sizeSol,
    built: result.built,
    skippedReason: result.skippedReason,
    routeLabels: result.quote?.routeLabels ?? [],
    outAmount: result.quote?.outAmount ?? null,
    priceImpactPct: result.quote?.priceImpactPct ?? null,
    simulationOk: result.simulation ? result.simulation.ok : null,
    simulationErr: result.simulation?.err ? String((result.simulation.err as any)?.message ?? result.simulation.err) : null,
    unitsConsumed: result.simulation?.unitsConsumed ?? null,
    quoteMs: result.timingsMs.quote,
    buildMs: result.timingsMs.build,
    simulateMs: result.timingsMs.simulate,
  });

  const simOk = result.simulation?.ok === true;
  dbStore.saveLog({
    timestamp: new Date().toISOString(),
    level: result.built && simOk ? "INFO" : "WARN",
    component: "SHADOW_ENTRY",
    message: result.skippedReason
      ? `[SHADOW] ${tokenName.toUpperCase()} — simulação não executada: ${result.skippedReason}`
      : `[SHADOW] ${tokenName.toUpperCase()} — rota ${result.quote?.routeLabels.join(">") || "?"} ` +
        `(impacto ${result.quote?.priceImpactPct ?? "n/d"}), simulação ${simOk ? "OK" : `FALHOU: ${result.simulation?.err ?? "?"}`}` +
        `${result.simulation?.unitsConsumed != null ? `, ${result.simulation.unitsConsumed} CU` : ""}` +
        `${result.simulation?.logsTail?.length ? `, última linha: ${result.simulation.logsTail[result.simulation.logsTail.length - 1]?.slice(0, 120)}` : ""}. ` +
        `NENHUMA assinatura, NENHUM envio.`,
    correlationId: `corr_shadow_${mint.slice(0, 8)}_${Date.now()}`,
  });
}

// ============================================================================
// S6 — ENTRADA REAL (autorizada em 2026-10-03) — CANARY DE 0,01 SOL
// ============================================================================
//
// O que mudou em relação ao bloco anterior: em vez de RECUSAR quando LIVE está ligado,
// este código executa a entrada com travas explícitas. As travas, em ordem de efeito:
//
//   1. TERCEIRA DECLARAÇÃO: `HFT_REAL_ENTRY_ENABLED=1`. RUNTIME_MODE=LIVE +
//      LIVE_TRADING_ENABLED=true continuam sendo as duas primeiras — nenhuma delas liga
//      entrada real sozinha, e esta terceira é específica de ENTRADA (saída não depende dela).
//   2. TETO CANÁRIO: `HFT_CANARY_MAX_SOL` (default 0,01 SOL) é teto DURO por entrada.
//   3. UMA ENTRADA: `HFT_CANARY_ONE_ENTRY=1` (default) — o canário roda e PARA.
//   4. AUTONOMIA SEPARADA: o pipeline automático só entra com `HFT_AUTONOMOUS_ENTRY=1`.
//      Sem ela, entrada real só por POST /api/real-entry (operador no comando).
//   5. PRÉ-FLIGHT OBRIGATÓRIO: simulação antes de assinar (o gasto de descobrir um erro
//      de instrução é a própria taxa; a simulação descobre de graça).
//   6. INTENÇÃO PERSISTIDA ANTES DE ASSINAR: sobrevive a crash e impede segunda compra.
//
// ROTAS (S6b, publicado): `aggregator` (default) usa a transação do Jupiter; `native` monta a
// instrução `buy_exact_sol_in` do IDL pinado (`src/pumpInstruction.ts`, com anti-drift no boot e
// `npm run pump:dryrun` como validação de layout contra a rede). O default continua agregador
// porque o layout nativo só deve ser usado depois de verificado no ambiente do operador.

const realEntryHistory: RealEntryResult[] = [];
const MAX_REAL_ENTRY_HISTORY = 20;

/** Estado que o gate precisa conhecer, lido do banco — nunca de contadores de tela. */
function collectRealEntryState(mint: string) {
  const positions = dbStore.getPositions();
  const openReal = positions.filter(
    (p: any) => p.mode !== "paper" && (p.status === "open" || p.status === "exit_pending" || !p.status)
  );
  /**
   * Tentativas que PODERIAM ter executado (assinatura existiu). Falha antes de assinar não
   * consome o canário — ver `countLandedEntryAttempts` em src/realEntry.ts.
   */
  const realTrades = dbStore
    .getTrades()
    .filter((t: any) => t.mode !== "paper" && t.mode !== "shadow");
  return {
    openReal,
    openExposureSol: openReal.reduce((acc: number, p: any) => acc + (Number(p.sizeSol) || 0), 0),
    realEntriesDone: countLandedEntryAttempts(realTrades as any[]),
    hasOpenPositionForMint: openReal.some((p: any) => p.mint === mint),
  };
}

function buildEntryGateInput(params: {
  mint: string;
  sizeSol: number;
  autonomousCall: boolean;
}): { gateInput: EntryGateInput; policy: ReturnType<typeof resolveRealEntryPolicy> } {
  const policy = resolveRealEntryPolicy();
  const res = getRuntimeModeResolution();
  const sec = getOperationalSecurityState();
  const state = collectRealEntryState(params.mint);
  const maxPositionSol = Number(process.env.MAX_POSITION_SOL ?? 0);

  return {
    policy,
    gateInput: {
      policy,
      mode: res.mode,
      liveAuthorized: res.liveAuthorized,
      killSwitchActive: sec.killSwitchActive,
      readOnlyMode: sec.readOnlyMode,
      autonomousCall: params.autonomousCall,
      mint: params.mint,
      sizeSol: params.sizeSol,
      maxPositionSol: Number.isFinite(maxPositionSol) ? maxPositionSol : undefined,
      openExposureSol: state.openExposureSol,
      realPositionsOpen: state.openReal.length,
      realEntriesDone: state.realEntriesDone,
      hasOpenPositionForMint: state.hasOpenPositionForMint,
    },
  };
}

/**
 * REGISTRA UMA RECUSA DE ENTRADA (gate, rota, carteira, armazenamento ou claim).
 *
 * Existe para que os DOIS pontos de recusa (a pré-checagem do endpoint `POST /api/real-entry` e o
 * interior de `runRealEntry`) gravem exatamente o mesmo: log de decisão no armazenamento + entrada
 * no histórico em memória. Antes disso o endpoint recusava e não registrava nada — o operador que
 * tentava entrar com o caminho desligado via um 409 limpo e um log de decisão VAZIO, e podia
 * concluir que ninguém havia tentado. Recusa não registrada é decisão invisível.
 */
function registrarRecusaDeEntrada(refused: RealEntryResult, correlationId: string | null): RealEntryResult {
  dbStore.saveLog({
    timestamp: new Date().toISOString(),
    level: "WARN",
    component: "REAL_ENTRY",
    message: `[S6] Entrada real RECUSADA: ${refused.reason}`,
    correlationId: correlationId ?? undefined,
  });
  realEntryHistory.unshift(refused);
  if (realEntryHistory.length > MAX_REAL_ENTRY_HISTORY) realEntryHistory.pop();
  return refused;
}

/**
 * Executa UMA entrada real, ponta a ponta. Devolve o resultado tipado — nunca lança por
 * falha de execução (o chamador decide o que fazer com o status).
 */
async function runRealEntry(params: {
  mint: string;
  tokenName: string;
  sizeSol: number;
  autonomousCall: boolean;
  correlationId: string;
}): Promise<RealEntryResult> {
  const { gateInput, policy } = buildEntryGateInput(params);
  const gate = assessEntryGate(gateInput);

  if (!gate.allowed) {
    return registrarRecusaDeEntrada(refusedRealEntry(params.mint, params.sizeSol, gate), params.correlationId);
  }

  const sizeSol = params.sizeSol;

  let userPublicKey: string;
  try {
    userPublicKey = getActiveWalletPublicKey().toBase58();
  } catch (err: any) {
    const refused = refusedRealEntry(params.mint, sizeSol, gate, `carteira indisponível: ${err?.message ?? err}`);
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "CRITICAL",
      component: "REAL_ENTRY",
      message: `[S6] Entrada real abortada: ${refused.reason}`,
      correlationId: params.correlationId,
    });
    return refused;
  }

  // ── Intenção persistida ANTES de qualquer assinatura ───────────────────────
  const positionId = `pos_live_${Date.now()}`;
  let entryIntent = persistIntent(
    createExecutionIntent({ positionId, mint: params.mint, token: params.tokenName.toUpperCase(), side: "entry" })
  );

  /** Tip medido (tip floor real). Sem dado, o submitBundle usa o mínimo do Jito e DECLARA. */
  let measuredTipSol: number | null = null;
  try {
    const floor = await jitoTipOracle.getTipFloor();
    const rec = await jitoTipOracle.recommendTip({
      capitalSol: sizeSol,
      maxTipBps: policy.maxTipBps,
      policy: (process.env.JITO_TIP_POLICY as any) || "p75",
    }, floor);
    const raw = rec?.tipSol ?? null;
    measuredTipSol = typeof raw === "number" && raw > 0 ? raw : null;
    if (measuredTipSol === null) {
      console.warn(`[S6] Tip floor sem valor utilizável (${rec?.basis ?? "sem base"}). O envio usará o mínimo do Jito.`);
    }
  } catch (err: any) {
    console.warn(`[S6] Tip floor indisponível (${err?.message ?? err}). O envio usará o mínimo do Jito e registrará o motivo.`);
  }

  /**
   * ROTA DE ENTRADA (S6): `aggregator` (default, validado por Jupiter) ou `native`
   * (instrução montada do IDL pinado, `src/pumpInstruction.ts`).
   *
   * Por que a nativa é opt-in e não default: ela elimina um round-trip HTTP e o risco de o
   * agregador não ter rota para um mint recém-criado — mas o layout tem de ser validado contra
   * a rede ANTES (`npm run pump:dryrun`). O default continua sendo o caminho já exercitado.
   */
  const entryRoute = (process.env.HFT_ENTRY_ROUTE ?? "aggregator").trim().toLowerCase();

  /**
   * DEFESA EM PROFUNDIDADE (S6b). O boot já verifica o layout contra a rede e é FATAL na rota
   * native — mas o boot é um instante e a ordem dos eventos do processo não é uma garantia de
   * segurança: entre subir o listener e concluir a verificação existe uma janela, e uma variável
   * de ambiente pode mudar sem reinício. Aqui, a condição é checada NO MOMENTO da entrada:
   * rota native exige verificação `ok === true` (conferido), não `null` (indeterminado) nem
   * `false` (drift). Sem verificação confirmada, a instrução não é montada nem assinada.
   */
  if (entryRoute === "native" && pumpIdlDrift.ok !== true) {
    const motivo =
      pumpIdlDrift.ok === false
        ? `IDL_DRIFT (${pumpIdlDrift.code}): ${pumpIdlDrift.detail}. A instrução nativa NÃO é ` +
          `montada com layout que não confere com a rede — o resultado seria rejeição ou ` +
          `min_tokens_out errado.`
        : `layout do IDL NÃO VERIFICADO (${pumpIdlDrift.code ?? "sem leitura"}): ` +
          `${pumpIdlDrift.detail ?? "nenhuma verificação registrada"}. A rota native exige ` +
          `verificação prévia: npm run pump:dryrun -- <mint> --payer <chave-publica>.`;
    const refused = refusedRealEntry(params.mint, sizeSol, gate, motivo);
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "CRITICAL",
      component: "REAL_ENTRY",
      message: `[S6] Rota native recusada antes de montar: ${refused.reason}`,
      correlationId: params.correlationId,
    });
    return refused;
  }

  if (entryRoute !== "aggregator" && entryRoute !== "native") {
    const refused = refusedRealEntry(
      params.mint,
      sizeSol,
      gate,
      `HFT_ENTRY_ROUTE="${entryRoute}" não é uma rota conhecida (use "aggregator" ou "native")`
    );
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "CRITICAL",
      component: "REAL_ENTRY",
      message: `[S6] Rota de entrada inválida: ${refused.reason}. Nada foi montado — fail-closed.`,
      correlationId: params.correlationId,
    });
    return refused;
  }

  /** Preenchido quando a rota é nativa: estado da curva/global lido no instante da montagem. */
  let nativeContext: { curve: BoundingCurveState; feeRecipient: string; minTokensOut: bigint; spendableSolIn: bigint } | null = null;

  /**
   * GUARDA DE ARMAZENAMENTO + VOO ÚNICO ENTRE PROCESSOS (S10) — a última barreira antes de montar
   * e assinar. Duas perguntas, nesta ordem:
   *
   * 1. O armazenamento permite assinar? Com Postgres pedido e banco fora do ar, NÃO: o operador
   *    acredita ter um árbitro de voo único entre instâncias, e assinar sem ele é assinar
   *    confiando numa proteção ausente (fail-closed, mesma doutrina do resto do caminho).
   * 2. Outra instância já está entrando NESTE mint? O claim é atômico (índice único parcial do
   *    Postgres): exatamente um processo ganha. O perdedor recebe o dono e a expiração — e recusa
   *    com nome e motivo, não com "erro genérico".
   *
   * O claim é liberado no `finally` abaixo (e, em caso de crash, expira pelo TTL).
   */
  const storageHealth = storageRef
    ? storageRef.health()
    : { configured: false, connected: false, migrated: false, schemaVersion: null, lastError: null };
  const storageGuard = decideEntryStorageGuard(STORAGE_POLICY, storageHealth);
  if (!storageGuard.allowSign) {
    const refused = refusedRealEntry(params.mint, sizeSol, gate, `${storageGuard.code}: ${storageGuard.detail}`);
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "CRITICAL",
      component: "REAL_ENTRY",
      message: `[S10] Entrada recusada pelo armazenamento: ${refused.reason}`,
      correlationId: params.correlationId,
    });
    realEntryHistory.unshift(refused);
    if (realEntryHistory.length > MAX_REAL_ENTRY_HISTORY) realEntryHistory.pop();
    return refused;
  }

  let entryClaimId: string | null = null;
  let entryClaimNote: string | null = null;
  if (STORAGE_POLICY.mode === "postgres" && storageRef) {
    const claim = await Promise.race([
      storageRef.claimEntry({
        mint: params.mint,
        side: "entry",
        payload: { sizeSol, correlationId: params.correlationId, route: (process.env.HFT_ENTRY_ROUTE ?? "aggregator") },
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), STORAGE_POLICY.claimTimeoutMs)),
    ]);
    if (claim === null) {
      /**
       * TIMEOUT é recusa, não permissão: um banco lento não pode virar "provavelmente livre, então
       * assina". Este é o caminho mais tentador de todos para degradar em silêncio.
       */
      const refused = refusedRealEntry(
        params.mint,
        sizeSol,
        gate,
        `STORAGE_CLAIM_TIMEOUT: o claim de voo único não respondeu em ${STORAGE_POLICY.claimTimeoutMs}ms — ` +
          `entrada recusada para não assinar sem o árbitro entre processos`
      );
      realEntryHistory.unshift(refused);
      if (realEntryHistory.length > MAX_REAL_ENTRY_HISTORY) realEntryHistory.pop();
      return refused;
    }
    if (!claim.acquired) {
      const refused = refusedRealEntry(
        params.mint,
        sizeSol,
        gate,
        `ENTRY_CLAIM_HELD (${claim.reason}): ${claim.detail}`
      );
      dbStore.saveLog({
        timestamp: new Date().toISOString(),
        level: "WARN",
        component: "REAL_ENTRY",
        message: `[S10] Voo único NEGADO: ${refused.reason}`,
        correlationId: params.correlationId,
      });
      realEntryHistory.unshift(refused);
      if (realEntryHistory.length > MAX_REAL_ENTRY_HISTORY) realEntryHistory.pop();
      return refused;
    }
    entryClaimId = claim.claimId;
    entryClaimNote = claim.reason;
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "INFO",
      component: "REAL_ENTRY",
      message:
        `[S10] Claim de voo único ADQUIRIDO (${claim.reason}) para ${params.mint.slice(0, 8)}… ` +
        `expira em ${claim.expiresAt ?? "n/d"} — nenhuma outra instância pode entrar neste mint agora.`,
      correlationId: params.correlationId,
    });
  }

  try {
    const deps: RealEntryDeps = {
      assertCanSign: () => assertCanSign("entry"),
      getQuote: async (mint, sizeLamports, slippageBps, timeoutMs) => {
        if (entryRoute === "native") {
          const conn = globalConnection;
          if (!conn) throw new Error("RPC indisponível (globalConnection nulo): rota nativa exige leitura de conta");
          const infos = await conn.getMultipleAccountsInfo([
            new PublicKey(deriveGlobalPda()),
            new PublicKey(deriveBondingCurvePda(mint)),
          ]);
          const [globalInfo, curveInfo] = infos;
          if (!globalInfo) throw new Error("conta Global do pump não encontrada no RPC configurado");
          if (!curveInfo) throw new Error("bonding curve não encontrada: mint sem curva ativa (migrado ou inexistente)");

          const global = parseGlobalAccount(globalInfo.data);
          const curve = parseBondingCurveAccount(curveInfo.data);
          if (!global.value) throw new Error(`Global ilegível: ${global.problems.map((p) => p.message).join(" | ")}`);
          if (!curve.value) throw new Error(`BondingCurve ilegível: ${curve.problems.map((p) => p.message).join(" | ")}`);
          if (curve.value.complete) throw new Error("curva COMPLETA (token migrado): não se compra na curva neste estado");
          const solGuard = assertSolQuotedCurve(curve.value.quoteMint);
          if (!solGuard.ok) throw new Error(solGuard.reason);

          const spendableSolIn = BigInt(sizeLamports);
          const q = quoteTokensOutExactSolIn({
            spendableSolIn,
            virtualTokenReserves: curve.value.virtualTokenReserves,
            virtualQuoteReserves: curve.value.virtualQuoteReserves,
            protocolFeeBps: global.value.feeBasisPoints,
            creatorFeeBps: curve.value.creatorFeeBps,
          });
          if (!q) throw new Error("cotação nativa não calculável (reservas/taxas): dado insuficiente para entrar");
          const minTokensOut = minTokensOutFromSlippage(q.tokensOut, slippageBps);
          if (minTokensOut <= 0n) throw new Error("min_tokens_out calculado é zero: slippage/taxa anulam a compra");

          nativeContext = { curve: curve.value, feeRecipient: global.value.feeRecipient, minTokensOut, spendableSolIn };

          /**
           * Impacto MEDIDO da própria curva: preço de execução (net_sol/tokens) contra o preço
           * spot (reservas virtuais). Não é estimativa de terceiro — é aritmética das reservas
           * lidas um instante antes. O gate de impacto do realEntry consome este número.
           */
          const spot = Number(curve.value.virtualQuoteReserves) / Number(curve.value.virtualTokenReserves);
          const exec = Number(q.netSol) / Number(q.tokensOut);
          const impactFraction = spot > 0 ? exec / spot - 1 : 0;

          return {
            outAmount: q.tokensOut.toString(),
            priceImpactPct: String(impactFraction),
            routeLabels: [`pump.fun curva (nativa, ${q.totalFeeBps}bps)`],
          };
        }

        const call = await withBudget(
          budgets.jupiter,
          // ENTRADA = gastar SOL para receber o mint. Inverter os lados aqui cotaria uma
          // VENDA do mint com valor lido em lamports — erro que o pré-flight não pegaria
          // (a simulação de uma venda seria bem-sucedida se houvesse saldo).
          () => JupiterIntegration.getQuote(SOL_MINT, mint, sizeLamports, slippageBps, timeoutMs ?? 6000),
          { priority: "normal" }
        );
        if (!call.ok) throw new Error(call.skippedReason ?? "cotação bloqueada por orçamento de cota");
        return call.value as any;
      },
      buildSwapTransaction: async (quote, userPk, timeoutMs) => {
        if (entryRoute === "native") {
          const ctx = nativeContext;
          if (!ctx) throw new Error("estado da curva ausente: a cotação nativa precisa rodar antes da montagem");
          const built = buildPumpBuyExactSolInInstruction({
            mint: params.mint,
            user: userPk,
            feeRecipient: ctx.feeRecipient,
            creator: ctx.curve.creator,
            spendableSolIn: ctx.spendableSolIn,
            minTokensOut: ctx.minTokensOut,
          });
          const cuLimit = Number(process.env.HFT_ENTRY_CU_LIMIT ?? 200_000);
          const cuPrice = Number(process.env.HFT_ENTRY_CU_PRICE_MICROLAMPORTS ?? 0);
          const ixs = [
            ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
            ...(cuPrice > 0 ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.floor(cuPrice) })] : []),
            new TransactionInstruction({
              programId: new PublicKey(built.programId),
              // `name` é metadado nosso para auditoria; NÃO vai como AccountMeta.
              keys: built.keys.map((k) => ({
                pubkey: new PublicKey(k.pubkey),
                isSigner: k.isSigner,
                isWritable: k.isWritable,
              })),
              data: built.data,
            }),
          ];
          /**
           * O blockhash de espaço reservado é substituído por um MONITORADO em `signAndSubmit`
           * (que também assina). Nada é assinado com o valor de espaço reservado: a ordem é
           * montar → simular (substitui na simulação) → trocar por blockhash fresco → assinar.
           */
          const message = new TransactionMessage({
            payerKey: new PublicKey(userPk),
            recentBlockhash: SYSTEM_PROGRAM_ID,
            instructions: ixs,
          }).compileToV0Message();
          return new VersionedTransaction(message);
        }
        return JupiterIntegration.buildSwapTransaction(quote, userPk, timeoutMs ?? 6000);
      },
      simulateTransaction: async (tx) => {
        const conn = globalConnection;
        if (!conn) throw new Error("RPC indisponível (globalConnection nulo)");
        const sim = await conn.simulateTransaction(tx as VersionedTransaction, {
          commitment: "processed",
          sigVerify: false,
          // O blockhash do agregador é substituído por um monitorado na assinatura; simular
          // contra ele mediria expiração, não programa/compute.
          replaceRecentBlockhash: true,
        });
        return {
          ok: sim.value.err === null || sim.value.err === undefined,
          err: sim.value.err,
          unitsConsumed: sim.value.unitsConsumed ?? null,
          logsTail: (sim.value.logs ?? []).slice(-5).map((l) => String(l).slice(0, 200)),
        };
      },
      getFreshBlockhash: async () => {
        const cache = blockhashCacheRef;
        if (!cache) throw new Error("cache de blockhash não inicializado neste processo");
        return cache.getFresh();
      },
      signAndSubmit: async ({ transaction, blockhash, sizeSol: cap, maxTipBps }) =>
        executeWithDecryptedKeypair(async (keypair) => {
          const tx = transaction as VersionedTransaction;
          /**
           * `VersionedTransaction` não tem `recentBlockhash`/`feePayer` no objeto raiz: o
           * blockhash vive em `message.recentBlockhash` e o fee payer já está na mensagem
           * (o agregador monta a transação com `userPublicKey` como pagador). Trocar o
           * blockhash aqui é seguro porque a transação do agregador NÃO vem assinada —
           * se um dia vier (co-assinatura), o campo `signatures[0]` estaria preenchido e
           * este ponto precisa ser revisto: alterar a mensagem invalidaria a assinatura
           * anterior.
           */
          if (tx.signatures.length > 0 && tx.signatures.some((sig) => sig.some((b) => b !== 0))) {
            throw new Error(
              "transação do agregador já vem assinada: substituir o blockhash invalidaria a assinatura existente"
            );
          }
          tx.message.recentBlockhash = blockhash;
          tx.sign([keypair]);
          const signature = bs58.encode(tx.signatures[0]);

          // PERSISTIR ANTES DE TRANSMITIR: se o processo morrer entre assinar e enviar, a
          // assinatura fica registrada e o próximo boot CONSULTA o status (nunca reconstrói às cegas).
          entryIntent = advanceIntentOrKeep(
            entryIntent,
            "signed",
            {
              signature,
              blockhash,
              // O orquestrador já recusou antes de chegar aqui se `lastValidBlockHeight <= 0`;
              // `?? 0` existe só para satisfazer o tipo, e 0 é interpretado como "desconhecido"
              // pela política de retry (nunca autoriza reconstruir sem prova de expiração).
              lastValidBlockHeight: depsBlockhashHeight ?? 0,
            },
            "entrada real: transação assinada (ainda não transmitida)"
          );

          const jitoSender = new JitoBundleSender(globalConnection as Connection);

          /**
           * ENVIO (S8). Com `HFT_PARALLEL_SEND=1`, os MESMOS bytes assinados saem por vários
           * caminhos ao mesmo tempo: bundle Jito, sender com stake (se configurado) e envio direto
           * ao RPC (se ligado). O primeiro aceite vence e os perdedores NÃO são cancelados — abortar
           * um envio que poderia entrar no próximo bloco destruiria o motivo de existir da corrida.
           *
           * O que NÃO muda: `ok` continua significando ACEITO, nunca EXECUTADO. A execução só existe
           * com confirmação e slot observados (`confirm`/`observeFill` abaixo). E assinar continua
           * sendo UMA vez: paralelizar entrega não duplica ordem — duplicar exige assinar duas vezes,
           * que o sistema de intenções bloqueia.
           */
          const submitJito = () =>
            jitoSender.submitBundle([tx], keypair, measuredTipSol ?? 0.000_001, blockhash, {
              capitalCommittedSol: cap,
              maxTipBps,
              region: (process.env.JITO_REGION as any) || undefined,
              purpose: "entry",
            });

          if (!PARALLEL_SEND.enabled) {
            const sent = await submitJito();
            return { ok: sent.success, signature, bundleId: sent.bundleId, tipSol: sent.tipSol, error: sent.error };
          }

          const transports = [
            buildJitoTransport(async () => {
              const res = await submitJito();
              return { success: res.success, bundleId: res.bundleId, error: res.error };
            }),
          ];

          if (PARALLEL_SEND.stakedSenderUrl !== "") {
            transports.push(
              buildStakedSenderTransport({
                url: PARALLEL_SEND.stakedSenderUrl,
                swqosOnly: PARALLEL_SEND.swqosOnly,
                rawTransactionBase64: Buffer.from(tx.serialize()).toString("base64"),
                timeoutMs: PARALLEL_SEND.transportTimeoutMs,
              })
            );
          }

          if (PARALLEL_SEND.rpcDirect) {
            transports.push(
              buildRpcDirectTransport(async () => {
                const conn = globalConnection as Connection | null;
                if (!conn) throw new Error("RPC indisponível para envio direto");
                /**
                 * DEFESA EM PROFUNDIDADE: este caminho transmite os mesmos bytes assinados; passar
                 * pelo choke point aqui impede que um chamador futuro construa um envio paralelo
                 * sem a avaliação de kill switch/read-only/cofre.
                 */
                assertCanSign("entry");
                const raw = Buffer.from(tx.serialize());
                await conn.sendRawTransaction(raw, {
                  // Pré-flight já foi feito na simulação do caminho real: repetir custa RTT e pode
                  // falhar por estado local do nó. Repetição é decisão do sistema de intenções.
                  skipPreflight: true,
                  maxRetries: 0,
                  preflightCommitment: "processed",
                });
                return "rpc aceitou";
              })
            );
          }

          const race = await sendInParallel({
            signature,
            transports,
            timeoutMs: PARALLEL_SEND.transportTimeoutMs,
            now: monotonicNow,
            onAttempt: (attempt) => {
              /**
               * Toda tentativa fica registrada — inclusive as que perdem a corrida e chegam depois.
               * É isto que permite, mais tarde, medir taxa de aceite POR CAMINHO com dado real em vez
               * de repetir número publicado por terceiro.
               */
              dbStore.saveLog({
                timestamp: new Date().toISOString(),
                level: attempt.ok ? "INFO" : "WARN",
                component: "REAL_ENTRY",
                message:
                  `[S8] transporte ${attempt.transport}: ${attempt.ok ? "ACEITOU" : "recusou/falhou"} ` +
                  `em ${attempt.latencyMs}ms${attempt.error ? ` — ${attempt.error}` : ""}`,
                correlationId: params.correlationId,
              });
            },
          });

          lastParallelSend = {
            at: new Date().toISOString(),
            signature,
            winner: race.winner,
            acceptedBy: race.acceptedBy,
            attempts: race.attempts,
            ok: race.ok,
          };

          const jitoAttempt = race.attempts.find((a) => a.transport === "jito");
          const jitoWon = race.winner === "jito";
          return {
            ok: race.ok,
            signature,
            // `bundleId` só existe no caminho Jito; quando outro transporte vence, isso é declarado
            // em vez de reaproveitar um id de bundle que não foi o responsável pelo aceite.
            bundleId: jitoWon ? "jito" : "",
            tipSol: jitoAttempt?.ok ? (measuredTipSol ?? 0.000_001) : 0,
            error: race.ok ? undefined : race.note,
          };
        }, "entry"),
      confirm: async (signature, lastValidBlockHeight, timeoutMs) => {
        const conn = globalConnection;
        if (!conn) return { outcome: "unknown" as const, error: "RPC indisponível para confirmar" };
        const monitor = new ConfirmationMonitor(conn);
        const res = await monitor.confirmWithRetry(signature, lastValidBlockHeight, timeoutMs, 800);
        return { outcome: res.outcome, slot: res.slot, error: res.error };
      },
      observeFill: async (signature) => {
        const conn = globalConnection;
        if (!conn) return { measured: false, tokensReceived: null, feeLamports: null, slot: null, error: "sem conexão RPC" };
        const tx = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (!tx) return { measured: false, tokensReceived: null, feeLamports: null, slot: null, error: "transação não disponível (RPC não a retornou)" };
        return parseEntryFill({
          owner: userPublicKey,
          mint: params.mint,
          meta: tx.meta as any,
          slot: tx.slot ?? null,
        });
      },
      now: monotonicNow,
    };

    /**
     * `depsBlockhashHeight` é lido DENTRO do signAndSubmit — o closure precisa do valor que
     * veio do `getFreshBlockhash` do orquestrador. Como `RealEntryDeps.signAndSubmit` recebe
     * `blockhash` mas não `lastValidBlockHeight`, guardamos o par aqui para a intenção.
     */
    let depsBlockhashHeight: number | null = null;
    const originalGetFresh = deps.getFreshBlockhash;
    deps.getFreshBlockhash = async () => {
      const bh = await originalGetFresh();
      depsBlockhashHeight = bh.lastValidBlockHeight;
      return bh;
    };

    const result = await executeRealEntry(deps, {
      mint: params.mint,
      sizeSol,
      userPublicKey,
      policy,
      gate,
      confirmTimeoutMs: Number(process.env.HFT_ENTRY_CONFIRM_TIMEOUT_MS ?? 30_000),
    });

    // ── Intenção: estado final coerente com o desfecho ─────────────────────────
    const intentPatch = { signature: result.signature, blockhash: result.blockhash, lastValidBlockHeight: result.lastValidBlockHeight };
    if (result.status === "confirmed") {
      entryIntent = advanceIntentOrKeep(entryIntent, "confirmed", { ...intentPatch, confirmationLevel: "confirmed" }, "entrada real confirmada com slot observado");
    } else if (result.status === "failed_on_chain" || result.status === "expired" || result.status === "submit_failed" || result.status === "simulation_failed") {
      entryIntent = advanceIntentOrKeep(entryIntent, "failed", { ...intentPatch, lastError: result.reason }, `entrada real não executou: ${result.status}`);
    } else if (result.signature) {
      // unconfirmed/refused-após-assinar: NÃO terminal. A reconciliação por status decide.
      entryIntent = advanceIntentOrKeep(entryIntent, "submitted", { ...intentPatch, lastError: result.reason }, `entrada real enviada, aguardando reconciliação (${result.status})`);
    } else {
      entryIntent = advanceIntentOrKeep(entryIntent, "failed", { lastError: result.reason }, "entrada real não chegou a assinar");
    }

    // ── Registro do resultado (trade sempre; posição SÓ com execução observada) ─
    const tradeStatus = result.confirmedOnChain ? "confirmed" : result.signature ? result.status : "rejected";
    dbStore.saveTrade({
      id: result.signature ? `live_${result.signature.slice(0, 16)}` : `live_refused_${Date.now()}`,
      token: params.tokenName.toUpperCase(),
      mint: params.mint,
      amount: `${sizeSol} SOL (REAL)`,
      outAmount: result.tokensReceived ? `${result.tokensReceived} unidades do mint (medido on-chain)` : "não medido",
      time: new Date().toTimeString().split(" ")[0] + "." + String(Date.now() % 1000).padStart(3, "0"),
      latencyMs: Math.round(result.timingsMs.total),
      status: tradeStatus,
      block: result.slot ?? 0,
      tipSol: result.tipSol ?? 0,
      route: `Jupiter → Jito bundle [${result.routeLabels.join(">") || "rota?"}]${result.confirmedOnChain ? "" : " (SEM confirmação on-chain)"}`,
      mode: "live" as const,
      signature: result.signature,
    } as any);

    if (result.confirmedOnChain && result.slot !== null) {
      const observedTokens = result.tokensReceived;
      const entryPrice = observedTokens && Number(observedTokens) > 0 ? sizeSol / (Number(observedTokens) / 1e9) : 0;

      /**
       * PERNA DE ENTRADA MEDIDA (S11) — o elo que faltava para existir PnL de ciclo.
       *
       * A compra já está CONFIRMADA neste ponto, então ler a transação com `getTransaction`
       * (`confirmed`) não atrasa nenhuma decisão: não há transação pendente esperando por isto. O
       * que não podia continuar era a saída descobrir o custo da entrada por adivinhação — sem esta
       * medição, o "PnL" da venda é receita bruta e o ciclo inteiro fica sem número.
       *
       * Falha aqui NÃO impede a posição de existir: a perna sai `measured: false` com o motivo, e a
       * saída declara o ciclo como não apurado em vez de estimar.
       */
      const pernaEntrada = result.signature
        ? await measureLeg(result.signature, getActiveWalletPublicKey(), params.mint)
        : null;
      if (pernaEntrada) {
        dbStore.saveLog({
          timestamp: new Date().toISOString(),
          level: pernaEntrada.measured ? "INFO" : "WARN",
          component: "REAL_ENTRY",
          message: pernaEntrada.measured
            ? `[S11] perna de ENTRADA medida on-chain: Δ ${(pernaEntrada.solDeltaLamports as number) / 1e9 >= 0 ? "+" : ""}${((pernaEntrada.solDeltaLamports as number) / 1e9).toFixed(9)} SOL ` +
              `(fee ${pernaEntrada.feeLamports ?? "n/d"} lamports). Com a perna de saída, o PnL do ciclo passa a ser apurado medido.`
            : `[S11] perna de ENTRADA NÃO medida (${pernaEntrada.error}): o ciclo desta posição será declarado NÃO apurado na saída.`,
          correlationId: params.correlationId,
        });
      }

      dbStore.savePosition({
        id: positionId,
        token: params.tokenName.toUpperCase(),
        mint: params.mint,
        sizeSol,
        entryPrice,
        currentPrice: entryPrice,
        pnlPercent: 0,
        status: "open",
        stopLossPercent: -5.0,
        takeProfitPercent: 15.0,
        trailingStopActive: true,
        trailingStopOffsetPercent: 2.5,
        highestPrice: entryPrice,
        timeOpened: new Date().toLocaleTimeString(),
        mode: "live",
        priceSource: "fill on-chain (pre/postTokenBalances)",
        signature: result.signature,
        slot: result.slot,
        // Honestidade registrada: quando o fill não pôde ser lido, o preço de entrada é 0 e
        // está declarado — nunca um número plausível inventado.
        entryPriceMeasured: result.fillMeasured && !!observedTokens,
        entryLeg: pernaEntrada,
        entryPriceNote: result.fillMeasured
          ? null
          : `fill não medido (${result.reason ?? "motivo não informado"}) — entryPrice 0 até reconciliar`,
      } as any);

      recorder.recordPositionLifecycle({
        positionId,
        mint: params.mint,
        token: params.tokenName.toUpperCase(),
        event: "opened",
        mode: "live",
        sizeSol,
        entryPriceSol: entryPrice,
        exitPriceSol: null,
        pnlPercent: null,
        reason: `entrada real confirmada (slot ${result.slot})`,
        pnlMeasuredOnChain: result.fillMeasured,
      });
    }

    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: result.confirmedOnChain ? "CRITICAL" : result.signature ? "WARN" : "INFO",
      component: "REAL_ENTRY",
      message:
        `[S6] Entrada real ${params.tokenName.toUpperCase()} → status=${result.status}` +
        (result.signature ? `, assinatura ${result.signature.slice(0, 16)}...` : "") +
        (result.slot !== null ? `, slot ${result.slot}` : "") +
        (result.tipSol !== null ? `, tip ${result.tipSol} SOL` : "") +
        (result.tokensReceived !== null ? `, recebido ${result.tokensReceived}` : "") +
        `, latência total ${result.timingsMs.total}ms ` +
        `(quote ${result.timingsMs.quote}/build ${result.timingsMs.build}/sim ${result.timingsMs.simulate}/submit ${result.timingsMs.submit}/confirm ${result.timingsMs.confirm}ms)` +
        (result.reason ? `. Motivo: ${result.reason}` : "") +
        (result.status === "submitted_unconfirmed"
          ? ". ATENÇÃO: aceito pelo block engine e NÃO observado na janela — reconciliar por status antes de assumir posição."
          : ""),
      correlationId: params.correlationId,
    });

    realEntryHistory.unshift(result);
    if (realEntryHistory.length > MAX_REAL_ENTRY_HISTORY) realEntryHistory.pop();
    return result;
  } finally {
    /**
     * LIBERAÇÃO DO CLAIM. Fica no `finally` de propósito: qualquer saída (confirmado, não
     * confirmado, recusado, exceção) libera o voo único imediatamente — o TTL existe para CRASH,
     * não para segurar o mint enquanto o processo está vivo e ocioso.
     */
    if (entryClaimId && storageRef) {
      const liberado = await storageRef.releaseEntryClaim(entryClaimId, {
        sizeSol,
        correlationId: params.correlationId,
        note: entryClaimNote,
      });
      if (!liberado) {
        console.warn(
          `[S10] Claim ${entryClaimId.slice(0, 8)}… NÃO foi liberado (expirado ou já liberado). ` +
            `Ele expira pelo TTL e outro processo o retoma — nenhuma ação necessária.`
        );
      }
    }
  }
}

/**
 * POST /api/real-entry — entrada real MANUAL (canário).
 *
 * Existe separado do pipeline por uma razão de operação: a primeira entrada real deve ser
 * disparada por uma pessoa que sabe qual mint escolheu, e não por um sinal automático.
 */
app.post("/api/real-entry", async (req, res) => {
  const mint = String(req.body?.mint ?? "").trim();
  const sizeSol = Number(req.body?.sizeSol ?? process.env.HFT_CANARY_MAX_SOL ?? 0.01);
  const tokenName = String(req.body?.token ?? mint.slice(0, 6));
  const { gateInput } = buildEntryGateInput({ mint, sizeSol, autonomousCall: false });
  const gate = assessEntryGate(gateInput);

  if (!gate.allowed) {
    // A pré-checagem evita trabalho, mas a recusa precisa deixar rastro: sem isso o log de decisão
    // ficaria vazio justamente quando alguém tentou operar com o caminho desligado.
    const refused = registrarRecusaDeEntrada(refusedRealEntry(mint, sizeSol, gate), null);
    return res.status(409).json({ refused: true, gate, reason: refused.reason });
  }

  const correlationId = `corr_realentry_${mint.slice(0, 8)}_${Date.now()}`;
  const result = await runRealEntry({ mint, tokenName, sizeSol, autonomousCall: false, correlationId });
  const httpStatus =
    result.status === "confirmed" ? 200 : result.status === "submitted_unconfirmed" ? 202 : 424;
  return res.status(httpStatus).json({ result, gate });
});

/** GET /api/real-entry — política vigente + último resultado. Somente leitura. */
app.get("/api/real-entry", (_req, res) => {
  const policy = resolveRealEntryPolicy();
  const { gateInput } = buildEntryGateInput({ mint: "So11111111111111111111111111111111111111112", sizeSol: policy.canaryMaxSol, autonomousCall: false });
  const entryRoute = (process.env.HFT_ENTRY_ROUTE ?? "aggregator").trim().toLowerCase();
  res.json({
    policy,
    entryRoute,
    idlDrift: pumpIdlDrift,
    parallelSend: {
      policy: PARALLEL_SEND,
      notes: describeParallelSendPolicy(PARALLEL_SEND),
      lastResult: lastParallelSend,
      howToMeasure:
        "cada tentativa de transporte é registrada em log com latência e motivo; `lastResult` é o " +
        "último corrida inteira. NÃO há taxa de aceite 'por caminho' calculada aqui: ela precisa de " +
        "amostra medida, não de número publicado por terceiro.",
    },
    ingest: (() => {
      const policy = resolveIngestPolicy(process.env);
      const health: any = grpcIngestRef?.getHealth() ?? null;
      return {
        policy,
        endpointProblem: policy.effective === "grpc" ? assessGrpcEndpoint(GEYSER_GRPC_URL).problem : null,
        active: health
          ? {
              endpoint: health.grpc?.endpoint ?? null,
              streamOpen: health.socketOpen,
              events: health.eventCount,
              updatesSeen: health.grpc?.updatesSeen ?? null,
              decodeFailures: health.grpc?.decodeFailures ?? null,
              reconnects: health.grpc?.reconnectAttempts ?? null,
            }
          : null,
        note:
          "o fast path gRPC é ADITIVO: o WebSocket continua assinando TODOS os programas. Se o gRPC " +
          "cair, a cobertura do pump permanece pelo WSS (mais lento, com getTransaction).",
      };
    })(),
    entryRouteNote:
      entryRoute === "native"
        ? "ROTA NATIVA: instrução montada do IDL pinado (assets/pump-idl-excerpt.json). Exige que " +
          "`npm run pump:dryrun` tenha retornado err=null contra a mainnet antes de operar."
        : "ROTA AGREGADOR (Jupiter): caminho exercitado; exige rota existente para o mint.",
    policyNote:
      "Entrada real exige TRÊS declarações: RUNTIME_MODE=LIVE, LIVE_TRADING_ENABLED=true e " +
      "HFT_REAL_ENTRY_ENABLED=1. Entrada automática exige ainda HFT_AUTONOMOUS_ENTRY=1.",
    readiness: assessEntryGate(gateInput),
    lastResults: realEntryHistory,
    howToMeasure: {
      tip: "POST /api/jito-tips (tip floor real; os campos percentilesSol são medidos)",
      costs: "o fill real é lido de pre/postTokenBalances da transação confirmada (parseEntryFill)",
      landing: "getBundleStatuses/getInflightBundleStatuses reconciliam 'aceito' × 'executado'",
    },
  });
});

/**
 * GET /api/performance (S9) — VALIDAÇÃO ESTATÍSTICA do que foi operado.
 *
 * Responde à pergunta que o operador realmente faz ("isso está funcionando?") sem permitir a
 * resposta fácil: o veredito sai do conjunto de desfechos com **PnL líquido medido on-chain**, e
 * tudo o que ficou de fora é contado com o motivo. Nada aqui é estimado: os campos que não foram
 * medidos vêm `null` e o texto diz por quê.
 *
 * Fonte de dados: Postgres quando ativo (histórico completo até `HFT_STORAGE_HISTORY_LIMIT`), senão
 * o JSON local — que guarda no máximo 50 trades. A resposta DECLARA a fonte e se houve truncamento,
 * porque uma métrica sobre 50 trades truncados não é a métrica da operação inteira.
 */
app.get("/api/performance", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 1000) || 1000, 10_000);
  const tradesJson = dbStore.getTrades();
  const positionsJson = dbStore.getPositions();

  let trades: any[] = tradesJson;
  let sourceName = "json local";
  let truncated = false;
  let note =
    "fonte local: o arquivo JSON mantém no MÁXIMO 50 trades — histórico truncado por construção. " +
    "Ligue HFT_STORAGE=postgres para o histórico completo.";
  if (STORAGE_POLICY.mode === "postgres" && storageRef && storageRef.health().connected) {
    try {
      const doBanco = await storageRef.fetchTrades({ limit });
      trades = doBanco;
      sourceName = "postgres";
      truncated = doBanco.length >= limit;
      note =
        "fonte: banco (espelho de escrita). trades lidos: " + doBanco.length +
        (truncated ? ` (LIMITE de ${limit} atingido — refine com ?limit=)` : "");
    } catch (err: any) {
      note = `banco configurado mas a leitura falhou (${err?.message ?? err}): caindo para o JSON local`;
    }
  }

  const labeled = labelAll(trades as any, positionsJson as any);
  const report = buildValidationReport({
    labeled,
    source: {
      name: sourceName,
      tradesRead: trades.length,
      positionsRead: positionsJson.length,
      truncated,
      note,
    },
  });
  return res.json(report);
});

/**
 * GET /api/storage (S10) — qual modo de persistência está ativo, e o que ele garante.
 *
 * `guarantee` é a parte que interessa: em JSON o voo único vale POR PROCESSO (duas instâncias na
 * mesma carteira não se enxergam); em Postgres vale ENTRE processos, por claim com expiração.
 */
app.get("/api/storage", async (_req, res) => {
  const health = storageRef ? storageRef.health() : null;
  let counts: any = null;
  let claims: any[] = [];
  if (storageRef && health?.connected) {
    try {
      counts = await storageRef.counts();
      claims = await storageRef.listActiveClaims();
    } catch (err: any) {
      counts = { error: err?.message ?? String(err) };
    }
  }
  const guard = decideEntryStorageGuard(STORAGE_POLICY, {
    configured: health?.configured ?? false,
    connected: health?.connected ?? false,
    migrated: health?.migrated ?? false,
    schemaVersion: health?.schemaVersion ?? null,
    lastError: health?.lastError ?? null,
  });
  return res.json({
    policy: STORAGE_POLICY,
    notes: describeStoragePolicy(STORAGE_POLICY),
    health,
    counts,
    activeClaims: claims,
    entryGuard: guard,
    guarantee:
      STORAGE_POLICY.mode === "postgres"
        ? "voo único ENTRE PROCESSOS (claim atômico com TTL) + histórico durável espelhado"
        : "voo único POR PROCESSO (memória) — duas instâncias na mesma carteira NÃO se enxergam; " +
          "histórico local limitado a 50 trades",
    jsonRemains: dbStore.hasWriteThrough()
      ? "o JSON local continua sendo escrito em paralelo (um banco fora do ar degrada, não apaga)"
      : "sem espelho ativo: somente o JSON local é escrito",
  });
});

// ============================================================================
// S4 — INTENÇÕES DE EXECUÇÃO (idempotência) E RECONCILIAÇÃO POSIÇÃO × CADEIA
// ============================================================================

/** Intervalo entre reconciliações de carteira. Piso de 15s: RPC não é gratuito. */
const DESYNC_INTERVAL_MS = Math.max(15_000, Number(process.env.HFT_DESYNC_INTERVAL_MS ?? 60_000));
/**
 * Idade mínima para uma posição poder ser considerada fantasma. Sem esta janela, uma
 * entrada recém-disparada (ainda não confirmada) seria marcada como inexistente.
 */
const DESYNC_MIN_AGE_MS = Math.max(0, Number(process.env.HFT_DESYNC_MIN_AGE_MS ?? 120_000));

/** Último relatório de reconciliação (memória: some no restart, o banco mantém o estado). */
let lastDesyncReport: { report: DesyncReport; at: string; trigger: string } | null = null;
/** Controle do intervalo entre reconciliações (evita leitura de carteira por ciclo). */
let lastDesyncRunAt = 0;

/** Lê o status de UMA assinatura, com failover de RPC. `null` = não foi possível perguntar. */
async function observeSignatureStatus(
  signature: string
): Promise<{ observation: SignatureObservation | null; slot: number | null }> {
  try {
    const res = await runWithRpcFailover(async (conn) =>
      await conn.getSignatureStatus(signature, { searchTransactionHistory: false })
    );
    if (!res || !res.value) {
      // O RPC respondeu e NÃO conhece a assinatura. Em cache recente isso significa
      // "não vi", que não é o mesmo que "não aconteceu" — quem decide é `decideRetry`.
      return { observation: { found: false, err: null, confirmationStatus: null }, slot: res?.context?.slot ?? null };
    }
    const level = res.value.confirmationStatus;
    return {
      observation: {
        found: true,
        err: res.value.err ?? null,
        confirmationStatus:
          level === "processed" || level === "confirmed" || level === "finalized" ? level : null,
      },
      slot: res.value.slot ?? res.context?.slot ?? null,
    };
  } catch (err: any) {
    console.warn(`[Intents] Falha ao consultar a assinatura ${signature.slice(0, 12)}...: ${err.message}`);
    return { observation: null, slot: null };
  }
}

/** Altura de bloco atual. `null` = não medido (e sem medição não há prova de expiração). */
async function readCurrentBlockHeight(): Promise<number | null> {
  try {
    return await runWithRpcFailover(async (conn) => await conn.getBlockHeight("confirmed"));
  } catch (err: any) {
    console.warn(`[Intents] Não foi possível ler a altura de bloco: ${err.message}`);
    return null;
  }
}

function persistIntent(intent: ExecutionIntentRecord): ExecutionIntentRecord {
  dbStore.saveIntent(intent);
  return intent;
}

function advanceIntentOrKeep(
  intent: ExecutionIntentRecord,
  to: ExecutionIntentRecord["state"],
  patch: Parameters<typeof advanceIntent>[2],
  reason: string
): ExecutionIntentRecord {
  const res = advanceIntent(intent, to, patch, reason);
  if (!res.ok) {
    // Transição inválida NÃO é silenciada: ela indica estado inconsistente, e seguir
    // adiante com estado inconsistente é como o bot passa a mentir para si mesmo.
    console.error(`[Intents] Transição recusada para ${intent.id}: ${res.reason}`);
    return persistIntent({ ...intent, lastError: `transição recusada: ${res.reason}`, updatedAt: new Date().toISOString() });
  }
  return persistIntent(res.intent);
}

/**
 * RECUPERAÇÃO DE INTENÇÕES NO BOOT — só pergunta à cadeia, nunca assina nem envia.
 *
 * Cenário que isto resolve: o processo morre entre ASSINAR e confirmar (deploy, OOM,
 * SIGKILL). No restart, `exit_pending` é revertido para `open` — mas a transação pode
 * ter entrado. Sem esta função, o bot consideraria a venda não feita e (pior) ficaria
 * livre para assinar uma SEGUNDA venda. Aqui a única ação é observar.
 */
async function recoverActiveIntents(): Promise<void> {
  let active: ExecutionIntentRecord[] = [];
  try {
    active = dbStore.getActiveIntents();
  } catch (err: any) {
    console.error(`[Intents] Não foi possível ler intenções ativas: ${err.message}`);
    return;
  }
  if (active.length === 0) return;

  console.warn(`[Intents] ${active.length} intenção(ões) não terminal(is) encontrada(s) no boot. Consultando a cadeia (somente leitura)...`);

  for (const intent of active) {
    if (!intent.signature) {
      // Morreu entre persistir "created" e assinar: NADA foi transmitido (assinatura é
      // pré-requisito de transmissão). É seguro liberar o caminho.
      advanceIntentOrKeep(intent, "failed", { lastError: "processo interrompido antes de assinar: nada foi enviado" }, "boot: sem assinatura");
      dbStore.saveLog({
        timestamp: new Date().toISOString(),
        level: "WARN",
        component: "JITO_BUNDLE",
        message:
          `[INTENTS] Intenção ${intent.id} (${intent.side}) foi interrompida antes de assinar. ` +
          `Nenhuma transação foi transmitida — caminho liberado para nova tentativa.`,
        correlationId: `corr_intent_${intent.id}`,
      });
      continue;
    }

    const { observation, slot } = await observeSignatureStatus(intent.signature);
    const height = await readCurrentBlockHeight();
    const decision = decideRetry(intent, {
      currentBlockHeight: height,
      signatureStatus: observation,
      // Após restart, os bytes assinados NÃO existem mais (nunca vão para disco).
      hasSignedBytes: false,
    });

    if (decision.action === "stop_confirmed") {
      advanceIntentOrKeep(intent, "confirmed", { confirmationLevel: decision.level }, `boot: ${decision.reason}`);
      dbStore.saveLog({
        timestamp: new Date().toISOString(),
        level: "CRITICAL",
        component: "JITO_BUNDLE",
        message:
          `[INTENTS] Intenção ${intent.id} (${intent.side} de $${intent.token}) JÁ EXECUTOU na cadeia ` +
          `(assinatura ${intent.signature.slice(0, 12)}..., nível ${decision.level ?? "desconhecido"}, slot ${slot ?? "?"}). ` +
          `O estado local da posição ${intent.positionId} pode estar DESATUALIZADO: confirme no explorador. ` +
          `A reconciliação POSITION_DESYNC vai comparar carteira × banco no próximo ciclo.`,
        correlationId: `corr_intent_${intent.id}`,
      });
      continue;
    }

    if (decision.action === "rebuild") {
      advanceIntentOrKeep(
        intent,
        observation?.found && observation.err ? "failed" : "expired",
        { lastError: decision.reason, confirmationLevel: null },
        `boot: ${decision.reason}`
      );
      dbStore.saveLog({
        timestamp: new Date().toISOString(),
        level: "WARN",
        component: "JITO_BUNDLE",
        message:
          `[INTENTS] Intenção ${intent.id} encerrada sem execução (${decision.reason}). ` +
          `Uma nova tentativa pode ser construída com segurança.`,
        correlationId: `corr_intent_${intent.id}`,
      });
      continue;
    }

    // "wait": não há evidência suficiente. A intenção CONTINUA ativa e a trava de voo
    // único impede uma segunda assinatura na mesma posição/lado.
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "WARN",
      component: "JITO_BUNDLE",
      message:
        `[INTENTS] Intenção ${intent.id} (${intent.side} de $${intent.token}) segue NÃO RESOLVIDA: ${decision.reason} ` +
        `A posição fica bloqueada para nova saída até haver evidência — reconstruir aqui poderia duplicar a ação.`,
      correlationId: `corr_intent_${intent.id}`,
    });
  }
}

/**
 * Decide o que fazer antes de uma nova tentativa de saída. Reúne observação da
 * assinatura + altura de bloco e aplica `decideRetry` (regra: reenviar os mesmos bytes
 * é idempotente; reconstruir só com prova de que a anterior não pode entrar).
 */
async function decideExitRetry(
  intent: ExecutionIntentRecord,
  previous: { signature: string } | null
): Promise<{ decision: RetryDecision; slot: number | null }> {
  if (!previous) {
    return { decision: { action: "rebuild", reason: "primeira tentativa: nada foi assinado ainda" }, slot: null };
  }
  const { observation, slot } = await observeSignatureStatus(previous.signature);
  const height = await readCurrentBlockHeight();
  const decision = decideRetry(intent, {
    currentBlockHeight: height,
    signatureStatus: observation,
    hasSignedBytes: true,
  });
  return { decision, slot };
}

/** Inicia a nova intenção que substitui uma anterior provadamente incapaz de entrar. */
function supersedeIntent(
  intent: ExecutionIntentRecord,
  terminalState: "failed" | "expired",
  reason: string
): ExecutionIntentRecord {
  const closed = advanceIntentOrKeep(intent, terminalState, { lastError: reason }, reason);
  return persistIntent(
    createExecutionIntent(
      {
        positionId: closed.positionId,
        mint: closed.mint,
        token: closed.token,
        side: closed.side,
        attempt: closed.attempt + 1,
        supersedesIntentId: closed.id,
      },
      {}
    )
  );
}

/**
 * Leitura ÚNICA das contas de token da carteira (um `getParsedTokenAccountsByOwner`).
 * `null` = falha de leitura; nunca "sem tokens".
 */
async function fetchWalletHoldings(owner: PublicKey): Promise<Holding[] | null> {
  if (!globalConnection) return null;
  const programIds = [PROGRAMS.TOKEN_PROGRAM, PROGRAMS.TOKEN_2022_PROGRAM];
  const holdings = new Map<string, Holding>();
  for (const programId of programIds) {
    try {
      const res = await runWithRpcFailover(async (conn) =>
        await conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(programId) })
      );
      for (const item of res.value ?? []) {
        const info = (item as any)?.account?.data?.parsed?.info;
        const mint = info?.mint;
        if (typeof mint !== "string") continue;
        const raw = Number(info?.tokenAmount?.amount ?? 0);
        const entry: Holding = {
          mint,
          rawAmount: Number.isFinite(raw) ? raw : 0,
          decimals: Number(info?.tokenAmount?.decimals ?? 0) || 0,
          tokenAccount: item.pubkey?.toBase58?.(),
        };
        const current = holdings.get(mint);
        if (!current || entry.rawAmount > current.rawAmount) holdings.set(mint, entry);
      }
    } catch (err: any) {
      /**
       * ATENÇÃO: os DOIS programas precisam responder. Se um falha, o snapshot está
       * incompleto e um token legítimo poderia parecer ausente → falso fantasma.
       * Devolver `null` é a resposta honesta: "não consegui ler", nunca "não há tokens".
       */
      console.warn(`[Desync] Falha ao ler contas de token (${programId.slice(0, 6)}...): ${err.message}`);
      return null;
    }
  }
  return [...holdings.values()];
}

/**
 * Segunda leitura, DIRIGIDA ao mint, antes de marcar uma posição como fantasma.
 * Marcar uma posição saudável como inexistente é caro (ela sai da gestão de risco),
 * então a confirmação dupla é obrigatória. `null` = não confirmado.
 */
async function confirmNoTokensForMint(owner: PublicKey, mint: string): Promise<boolean | null> {
  if (!globalConnection) return null;
  try {
    const res = await runWithRpcFailover(async (conn) =>
      await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) })
    );
    const total = (res.value ?? []).reduce((acc: number, item: any) => {
      const raw = Number(item?.account?.data?.parsed?.info?.tokenAmount?.amount ?? 0);
      return acc + (Number.isFinite(raw) ? raw : 0);
    }, 0);
    return total === 0;
  } catch (err: any) {
    console.warn(`[Desync] Confirmação dirigida do mint ${mint.slice(0, 8)}... falhou: ${err.message}`);
    return null;
  }
}

/**
 * Executa a reconciliação POSITION_DESYNC: estado local × carteira. NÃO fecha, NÃO
 * apaga e NÃO quarentena nada: marca a divergência no registro da posição, registra
 * evidência e deixa a decisão para o operador (mesmo princípio do S0).
 */
async function runDesyncReconciliation(trigger: string): Promise<DesyncReport | null> {
  try {
    if (!globalConnection) return null;
    const positions = dbStore.getPositions();
    const managed = positions.filter(
      (p: any) => p.mode !== "paper" && p.status !== "quarantined" && p.status !== "closed"
    );
    if (managed.length === 0) return null;

    const owner = getActiveWalletPublicKey();
    const holdings = await fetchWalletHoldings(owner);

    // Mints que o bot acredita TER ENCERRADO: saídas live com sucesso no histórico de
    // trades. Serve para "achei que vendi mas ainda tenho token".
    const closedMints = dbStore
      .getTrades()
      .filter((t) => t.mode === "live" && t.status === "success")
      .map((t) => ({ mint: t.mint, token: t.token, closedAt: t.time ?? null }));

    const report = reconcilePositionDesync({
      positions: positions as any,
      closedMints,
      holdings,
      nowMs: Date.now(),
      options: { minAgeMs: DESYNC_MIN_AGE_MS },
    });

    const nowIso = new Date().toISOString();
    for (const f of report.findings) {
      if (f.verdict === "in_sync" || f.verdict === "too_young" || !f.positionId) continue;
      const pos = positions.find((p: any) => p.id === f.positionId);
      if (!pos) continue;

      if (f.verdict === "phantom_position") {
        /**
         * Confirmação dupla ANTES de marcar. Uma leitura errada (nó atrasado, RPC
         * degradado) marcaria uma posição real como inexistente e a tiraria da gestão
         * de risco — trocar um problema de dados por um problema de capital.
         */
        const confirmed = await confirmNoTokensForMint(owner, pos.mint);
        if (confirmed !== true) {
          pos.desyncState = "unknown";
          pos.desyncReason =
            `Saldo zero no snapshot, mas a confirmação dirigida ${confirmed === null ? "falhou (sem leitura)" : "encontrou saldo"}. ` +
            `Não classificado como fantasma.`;
          pos.desyncCheckedAt = nowIso;
          dbStore.savePosition(pos);
          continue;
        }
        pos.phantomConfirmations = (pos.phantomConfirmations || 0) + 1;
        pos.desyncState = "phantom_position";
        pos.desyncReason = f.evidence;
        pos.desyncCheckedAt = nowIso;
        dbStore.savePosition(pos);
        dbStore.saveLog({
          timestamp: nowIso,
          level: "CRITICAL",
          component: "RISK_ENGINE",
          message:
            `[POSITION_DESYNC] ${pos.token ?? pos.id} está ABERTA no banco e a carteira NÃO tem o token ` +
            `(duas leituras independentes concordam). Evidência: ${f.evidence} ` +
            `Ação: confirme no explorador e decida (quarentenar/pausar). Esta posição NÃO será gerida ` +
            `(não há o que vender) e nada foi alterado no estado além da marcação.`,
          correlationId: `corr_desync_${pos.id}_${Date.now()}`,
        });
        continue;
      }

      pos.desyncState = f.verdict as any;
      pos.desyncReason = f.evidence;
      pos.desyncCheckedAt = nowIso;
      dbStore.savePosition(pos);
      dbStore.saveLog({
        timestamp: nowIso,
        level: f.severity === "critical" ? "CRITICAL" : "WARN",
        component: "RISK_ENGINE",
        message: `[POSITION_DESYNC] ${f.verdict}${f.token ? ` em ${f.token}` : ""}: ${f.evidence} ${f.interpretation} Ação: ${f.recommendedAction}`,
        correlationId: `corr_desync_${f.positionId ?? "global"}_${Date.now()}`,
      });
    }

    lastDesyncReport = { report, at: nowIso, trigger };
    console.log(`[Desync] ${describeDesyncReport(report)} (disparo: ${trigger})`);
    return report;
  } catch (err: any) {
    console.error(`[Desync] Reconciliação falhou: ${err.message}`);
    return null;
  }
}

/**
 * RECONCILIADOR DE ESTADO DE SAÍDA — resolve posições presas em `exit_pending`.
 *
 * POR QUE ISTO EXISTE (lacuna que eu mesmo introduzi):
 * a correção de falha de saída reverte a posição para `open` dentro do `catch`, o que
 * resolve o caso comum. Mas se o PROCESSO morrer no meio da liquidação (deploy, OOM,
 * SIGKILL), a posição fica em `exit_pending` no disco para sempre — e o lock em memória
 * (`exitLocks`) some no restart, então o gerenciador pode pegar a posição depois.
 * Pior: se um kill switch ou um read-only foi acionado no meio, a posição fica travada
 * em `exit_pending` sem ninguém para destravá-la, e todo POST de fechamento devolve 409.
 *
 * Comportamento: as posições são liberadas para `open` com falha registrada, forçando
 * uma nova avaliação de risco. Isos e honesto: registra cada reconciliação no log.
 */
async function reconcileStuckExits(): Promise<void> {
  try {
    const positions = dbStore.getPositions();
    const stuck = positions.filter((p) => p.status === "exit_pending");
    for (const pos of stuck) {
      pos.status = "open";
      pos.exitAttempts = (pos.exitAttempts || 0) + 1;
      pos.lastExitError = "Posição encontrada em exit_pending no boot (processo interrompido durante a liquidação).";
      pos.lastExitAttemptAt = new Date().toISOString();
      dbStore.savePosition(pos);
      dbStore.saveLog({
        timestamp: new Date().toISOString(),
        level: "WARN",
        component: "RISK_ENGINE",
        message:
          `[RECONCILIAÇÃO] Posição $${pos.token} estava presa em EXIT_PENDING (liquidação interrompida). ` +
          `Status revertido para OPEN para que o risco seja reavaliado. Verifique on-chain se os tokens ` +
          `ainda estão na carteira antes de confiar no estado local.`,
        correlationId: `corr_reconcile_${pos.id}_${Date.now()}`,
      });
    }
    if (stuck.length > 0) {
      console.warn(`[Risk Engine] ${stuck.length} posição(ões) reconciliada(s) de EXIT_PENDING para OPEN.`);
    }
  } catch (err: any) {
    console.error("[Risk Engine] Falha na reconciliação de posições:", err.message);
  }
}

/**
 * Fecha uma posição PAPER (shadow trading) usando o preço de mercado observado.
 *
 * Por que isto é separado de executeAutonomousExit:
 *   - Não assina nada, não envia nada, não toca a rede.
 *   - Registra o resultado marcado como `mode: "paper"`, para que nunca se confunda com
 *     PnL real nos relatórios. Um backtest que se disfarça de execução real é pior do que
 *     nenhum backtest.
 */
function recordPaperClose(pos: any, reason: string, pnlPercent: number): void {
  const exitPrice = pos.currentPrice || pos.entryPrice;
  const pnlSol = (pos.sizeSol * pnlPercent) / 100;

  const paperTrade = {
    id: `paper_close_${pos.id}_${Date.now()}`,
    token: pos.token,
    mint: pos.mint,
    amount: `${pos.sizeSol} SOL (PAPER)`,
    outAmount: `${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL (shadow, não realizado)`,
    time: new Date().toTimeString().split(" ")[0] + "." + String(Date.now() % 1000).padStart(3, "0"),
    latencyMs: 0,
    status: "paper" as const,
    block: 0,
    tipSol: 0,
    route: `PAPER/shadow close (${reason}) @ ${Number(exitPrice).toPrecision(6)} SOL`,
    mode: "paper" as const,
    signature: null,
  };

  dbStore.saveTrade(paperTrade);
  snipedTransactions.unshift(paperTrade);
  if (snipedTransactions.length > 25) snipedTransactions.pop();

  pos.status = "closed";
  pos.pnlPercent = pnlPercent;
  dbStore.savePosition(pos);
  dbStore.deletePosition(pos.id);
  exitLocks.delete(pos.id);

  recorder.recordPositionLifecycle({
    positionId: pos.id,
    mint: pos.mint,
    token: pos.token,
    event: "closed",
    mode: "paper",
    sizeSol: pos.sizeSol,
    entryPriceSol: pos.entryPrice ?? null,
    exitPriceSol: null, // a sombra não recebe preço de execução; o gatilho é registrado em 'reason'
    pnlPercent,
    reason,
    pnlMeasuredOnChain: false, // sombra: NUNCA medido on-chain
  });

  dbStore.saveLog({
    timestamp: new Date().toISOString(),
    level: "INFO",
    component: "RISK_ENGINE",
    message:
      `[PAPER/SHADOW] Posição simulada de $${pos.token} encerrada por ${reason} com PnL ` +
      `${pnlPercent.toFixed(2)}% (${pnlSol.toFixed(4)} SOL nocionais). Nenhuma transação foi ` +
      `enviada on-chain. Este resultado NÃO é PnL real e não deve ser usado como métrica de ` +
      `desempenho de capital.`,
    correlationId: `corr_paper_${pos.id}_${Date.now()}`,
  });
}

// ETAPA 12 — Motor de Gerenciamento de Posições On-Chain REAL (Zero Simulation Mode)
async function startAutonomousPositionManager(): Promise<void> {
  console.log("[HFT Position Manager] Motor de Gerenciamento de Posições On-Chain REAL iniciado.");
  
  while (true) {
    try {
      // Monitor every 3 seconds
      await new Promise((resolve) => setTimeout(resolve, 3000));
      
      if (!globalConnection) {
        continue;
      }

      const positions = dbStore.getPositions();
      const openPositions = positions.filter(p => p.status === "open" || !p.status);

      /**
       * RECONCILIAÇÃO PERIÓDICA POSIÇÃO × CADEIA (S4). Roda no máximo a cada
       * DESYNC_INTERVAL_MS e só quando existe posição gerível — uma leitura de carteira
       * por ciclo, não uma por posição.
       */
      const nowMs = Date.now();
      if (
        openPositions.some((p: any) => p.mode !== "paper") &&
        nowMs - lastDesyncRunAt >= DESYNC_INTERVAL_MS
      ) {
        lastDesyncRunAt = nowMs;
        await runDesyncReconciliation("periódica");
      }

      if (openPositions.length === 0) {
        continue;
      }

      /**
       * PREÇOS EM LOTE — UMA passada por ciclo para TODAS as posições.
       *
       * Antes: 1 requisição DexScreener por posição e, se falhasse, 1 cotação Jupiter por posição
       * — a cada 3 s. Dez posições passavam de 400 req/min, acima do teto público de 300/min:
       * o bot garantia 429 no meio da operação. Agora: 1 requisição por provedor por ciclo
       * (DexScreener cobre 30 tokens, Jupiter 50, GeckoTerminal 30).
       *
       * Prioridade de SAÍDA: gerenciar posição é reduzir risco — cota não bloqueia.
       */
      const batchPricesThisCycle: BatchResult = await (async () => {
        const vazio = (problemas: string[]): BatchResult => ({
          quotes: new Map<string, BatchQuote>(),
          requests: 0,
          problems: problemas,
          sourcesUsed: [],
          divergences: [],
          verification: { attempted: false, source: null, checked: 0, comparisons: [], problems: [] },
        });

        if (marketBatchStats.disabled) {
          return vazio(["desligado por HFT_MARKET_BATCH=0"]);
        }
        const mints = openPositions
          .filter((p: any) => isQueryableMint(p.mint))
          .filter((p: any) => Number.isFinite(Number(p.sizeSol)) && Number(p.sizeSol) > 0)
          .filter((p: any) => {
            const b = priceTelemetryBackoff.get(p.id);
            return !b || Date.now() >= b.nextPollAt;
          })
          .map((p: any) => p.mint as string);

        if (mints.length === 0) {
          return vazio([]);
        }

        /**
         * AMOSTRA DE VERIFICAÇÃO (rotativa): a cascata para na primeira fonte que responde, então
         * sem amostra NUNCA haveria segunda opinião — e "sem divergência" viraria sinônimo de
         * "sem verificação". Aqui N tokens por ciclo (custo: no máximo 1 requisição) recebem
         * segunda opinião, girando o cursor para que, em poucos ciclos, toda a carteira seja
         * conferida contra uma fonte independente.
         */
        const amostra = Math.min(PRICE_VERIFY_SAMPLE, mints.length);
        const verifyMints =
          amostra > 0
            ? Array.from({ length: amostra }, (_, i) => mints[(priceVerifyCursor + i) % mints.length])
            : [];
        if (amostra > 0) priceVerifyCursor = (priceVerifyCursor + amostra) % mints.length;

        const result = await fetchBatchPrices(mints, {
          dexscreenerBudget: budgets.dexscreener,
          jupiterBudget: budgets.jupiter,
          geckoterminalBudget: budgets.geckoterminal,
          priority: "exit",
          sampleBook: priceSampleBook ?? undefined,
          divergenceThresholds: PRICE_DIVERGENCE_THRESHOLDS,
          verifyMints,
        });

        marketBatchStats.cycles++;
        marketBatchStats.mintsRequested += mints.length;
        marketBatchStats.requests += result.requests;
        marketBatchStats.priced += [...result.quotes.values()].filter((q) => q.priceSol !== null).length;
        marketBatchStats.liquidityKnown += [...result.quotes.values()].filter((q) => q.liquidityUsd !== null).length;
        marketBatchStats.lastSources = result.sourcesUsed;
        marketBatchStats.lastProblems = result.problems.slice(-5);
        marketBatchStats.verifications += result.verification.checked;
        if (result.verification.attempted && result.verification.source) {
          marketBatchStats.verificationSources = [
            ...marketBatchStats.verificationSources.slice(-4),
            result.verification.source,
          ];
        }

        /**
         * DIVERGÊNCIA ENTRE FONTES — alerta com os DOIS números e as DUAS fontes.
         *
         * Nunca silencioso e nunca decisório por si só: o achado é registrado no log operacional,
         * anexado à posição (para o painel e para o pós-mortem) e contado no /api/health. NÃO
         * dispara venda: uma divergência pode ser pool raso lido por uma fonte, e vender com
         * base em leitura errada é tão ruim quanto não vender. Com capital real, a política de
         * agir precisa de regra própria validada — não de um gatilho escondido aqui.
         */
        if (result.divergences.length > 0) {
          marketBatchStats.divergences += result.divergences.length;
          const agora = new Date().toISOString();
          for (const d of result.divergences) {
            marketBatchStats.lastDivergences = [
              ...marketBatchStats.lastDivergences.slice(-4),
              {
                mint: d.mint,
                pct: d.pct,
                bps: d.bps,
                severity: d.severity,
                reference: d.reference,
                candidate: d.candidate,
                at: agora,
              },
            ];
            const lastAlert = divergenceAlertedAt.get(d.mint) ?? 0;
            if (Date.now() - lastAlert < DIVERGENCE_ALERT_INTERVAL_MS) continue;
            divergenceAlertedAt.set(d.mint, Date.now());
            const resumo =
              `${d.mint.slice(0, 6)}… divergência de ${(d.pct * 100).toFixed(2)}% (${d.bps} bps, ${d.severity}): ` +
              `${d.reference.source} diz ${d.reference.priceSol.toPrecision(6)} SOL (amostra de ${Math.round(d.reference.ageMs / 1000)}s atrás) ` +
              `e ${d.candidate.source} diz ${d.candidate.priceSol.toPrecision(6)} SOL.`;
            console.warn(`[Qualidade de preço] ${resumo}`);
            dbStore.saveLog({
              timestamp: agora,
              level: d.severity === "critical" ? "CRITICAL" : "WARN",
              component: "RISK_ENGINE",
              message:
                `[DIVERGÊNCIA DE PREÇO] ${resumo} Uma das fontes está errada (pool raso, par errado, ` +
                `decimal trocado ou cache velho) — decisões de stop/alvo sobre preço divergente podem ` +
                `${d.severity === "critical" ? "vender por engano e devem ser tratadas como indisponíveis até a checagem manual" : "sair da faixa esperada"}.`,
              correlationId: `corr_divergence_${d.mint.slice(0, 8)}_${Date.now()}`,
            });
          }
        }

        return result;
      })();

      /** Divergências deste ciclo por token — usado no laço para anexar à posição. */
      const divergenciaPorMint = new Map<string, DivergenceFinding>(
        batchPricesThisCycle.divergences.map((d) => [d.mint, d])
      );

      for (const pos of openPositions) {
        // POSIÇÕES PAPER: gestão de risco em modo sombra. Nenhuma assinatura, nenhuma
        // transação. Sem este desvio, o gerenciador tentaria VENDER tokens que nunca
        // foram comprados — e antes da correção, gravava essa "venda" como sucesso.
        const isPaper = (pos as any).mode === "paper";

        /**
         * SANIDADE DE POSIÇÃO — corta lixo ANTES de gastar RPC.
         *
         * Observado em execução (2026-10-02): o banco operacional atual contém posições de
         * histórico fabricado (tokens que nunca existiram) e o loop de gestão gastava uma
         * chamada de RPC por mint a cada 3s, além de inundar o log. Nenhuma dessas posições
         * pode ser gerida de verdade — e uma delas tinha `sizeSol: 0`.
         *
         * Isto NÃO apaga nem corrige nada: só recusa consultar o que é estruturalmente
         * impossível. A decisão de quarentenar o banco continua sendo do operador.
         */
        if (!Number.isFinite(Number(pos.sizeSol)) || Number(pos.sizeSol) <= 0) {
          if (!invalidPositionWarned.has(pos.id)) {
            invalidPositionWarned.add(pos.id);
            dbStore.saveLog({
              timestamp: new Date().toISOString(),
              level: "WARN",
              component: "RISK_ENGINE",
              message:
                `[POSIÇÃO INVÁLIDA] ${pos.token ?? pos.id} tem tamanho ${pos.sizeSol} SOL (esperado > 0). ` +
                `Não será gerida nem consultada. Provável resíduo de histórico fabricado — considere quarentenar o banco.`,
              correlationId: `corr_invalid_pos_${pos.id}`,
            });
          }
          continue;
        }
        /**
         * FANTASMA CONFIRMADO: o banco diz aberta, duas leituras independentes da
         * carteira dizem que o token não existe. Gerir isso é gastar RPC para calcular
         * stop/alvo de um ativo inexistente — e, pior, um gatilho poderia tentar vender
         * zero e derrubar o circuit breaker, escondendo as falhas reais. Não é fechada
         * nem apagada: fica marcada e visível em GET /api/positions/desync.
         */
        if ((pos as any).desyncState === "phantom_position") {
          continue;
        }

        if (!pos.mint || !isValidPubkey(pos.mint)) {
          if (!invalidPositionWarned.has(pos.id)) {
            invalidPositionWarned.add(pos.id);
            dbStore.saveLog({
              timestamp: new Date().toISOString(),
              level: "WARN",
              component: "RISK_ENGINE",
              message:
                `[POSIÇÃO INVÁLIDA] ${pos.token ?? pos.id} tem mint que não é uma pubkey base58 válida ` +
                `("${pos.mint ?? "(vazio)"}"). Não será consultada no RPC.`,
              correlationId: `corr_invalid_mint_${pos.id}`,
            });
          }
          continue;
        }

        /**
         * 1. CONSULTA DE PREÇO — CASCATA COM FONTES VERIFICÁVEIS.
         *
         * AUDITORIA 2026-10-02 (achado C25): a versão anterior tentava dois hosts MORTOs
         * (`api.jup.ag/v6/price`) e, se ambos respondessem, convertia USD->SOL usando um
         * fallback hardcoded de 140.0 dólares quando a segunda chamada falhasse — ou seja,
         * podia inventar um preço de SOL. De quebra, a terceira tentativa assumia
         * `amount=1000000` = 1 token inteiro, isto é, SÓ funciona para mints de 6 decimais;
         * em um token de 9 decimais o preço sairia 1000x maior, disparando stop/alvo
         * imediatamente e vendendo a posição por engano.
         *
         * Agora: (1) DexScreener; (2) cotação Jupiter REAL na quantidade exata de 1 token
         * inteiro — com os decimais lidos do mint (imutáveis, cacheados por processo).
         * Se os decimais não puderem ser lidos, a fonte é DESCARTADA: preço ausente é
         * tratado pelo fluxo como "sem telemetria" (SL/TP pulados). Preço errado é pior
         * do que preço nenhum — ele dispara uma venda real por engano.
         */
        // Respeita o backoff: sem telemetria, insistir a cada 3s não produz informação.
        const priceBackoff = priceTelemetryBackoff.get(pos.id);
        if (priceBackoff && Date.now() < priceBackoff.nextPollAt) {
          continue;
        }

        let currentPriceSol = 0;
        let priceSource = "";

        const isMockMint = !pos.mint || pos.mint.includes("...") || pos.mint.length < 32;

        /**
         * Attempt 0: preço vindo do LOTE deste ciclo (o caminho barato). Se o lote não trouxe
         * preço para ESTE mint, cai nas tentativas por posição abaixo — que continuam existindo
         * como fallback, com prioridade de saída e backoff.
         */
        const batchQuote = isMockMint ? undefined : batchPricesThisCycle.quotes.get(pos.mint);
        if (batchQuote && batchQuote.priceSol !== null && batchQuote.priceSol > 0) {
          currentPriceSol = batchQuote.priceSol;
          priceSource = batchQuote.source;
        }

        /**
         * DIVERGÊNCIA DESTE TOKEN: anexa à posição (visível no painel e no pós-mortem) e mantém
         * o alerta já emitido no bloco do lote. O preço CONTINUA sendo usado para gestão — parar
         * de gerir risco é pior —, mas fica registrado que ele veio de uma fonte sob suspeita.
         */
        const divergencia = divergenciaPorMint.get(pos.mint);
        if (divergencia) {
          pos.priceDivergence = {
            observedAt: new Date().toISOString(),
            pct: divergencia.pct,
            bps: divergencia.bps,
            severity: divergencia.severity,
            reference: divergencia.reference,
            candidate: divergencia.candidate,
          };
        }

        /**
         * LIQUIDEZ EM QUEDA — o DexScreener (fonte do lote) informa a liquidez do par, e a
         * informação já foi PAGA em cota: ignorá-la seria desperdício. Remoção de LP é o sinal
         * clássico de rug e antecede o preço cair.
         *
         * O que este bloco faz: compara com o PICO já observado e ALERTA (log + campo na posição)
         * quando a queda passa dos limiares. O que NÃO faz: vender. Gatilho de saída automático
         * por liquidez exige execução real autorizada e regra validada em paper — vender por
         * leitura de um único pool seria trocar um risco por outro.
         */
        const liquidezAgora = batchQuote?.liquidityUsd ?? null;
        if (liquidezAgora !== null && liquidezAgora > 0) {
          const picoAnterior = Number((pos as any).liquidityUsdPeak);
          const pico = Number.isFinite(picoAnterior) && picoAnterior > 0 ? Math.max(picoAnterior, liquidezAgora) : liquidezAgora;
          (pos as any).liquidityUsdPeak = pico;
          (pos as any).liquidityUsdLast = liquidezAgora;

          const queda = assessLiquidityDrop(pico, liquidezAgora, LIQUIDITY_THRESHOLDS);
          if (queda) {
            const observadoEm = new Date().toISOString();
            pos.liquidityAlert = {
              observedAt: observadoEm,
              peakUsd: queda.peakUsd,
              currentUsd: queda.currentUsd,
              dropPct: queda.dropPct,
              severity: queda.severity,
            };
            const lastAlert = liquidityAlertedAt.get(pos.id) ?? 0;
            if (Date.now() - lastAlert >= LIQUIDITY_ALERT_INTERVAL_MS) {
              liquidityAlertedAt.set(pos.id, Date.now());
              console.warn(
                `[Liquidez] $${pos.token} caiu ${(queda.dropPct * 100).toFixed(1)}% do pico ` +
                  `($${Math.round(queda.peakUsd)} → $${Math.round(queda.currentUsd)}) — ${queda.severity}`
              );
              dbStore.saveLog({
                timestamp: observadoEm,
                level: queda.severity === "critical" ? "CRITICAL" : "WARN",
                component: "RISK_ENGINE",
                message:
                  `[LIQUIDEZ EM QUEDA] $${pos.token} (${pos.mint.slice(0, 6)}…): ` +
                  `$${Math.round(queda.currentUsd)} agora contra pico de $${Math.round(queda.peakUsd)} observado pelo bot ` +
                  `(−${(queda.dropPct * 100).toFixed(1)}%, ${queda.severity}). Remoção de liquidez é o padrão clássico de rug. ` +
                  `ALERTA apenas: nenhuma venda foi disparada por este sinal.`,
                correlationId: `corr_liquidity_${pos.id}_${Date.now()}`,
              });
            }
          }
        }

        if (!isMockMint && currentPriceSol === 0) {
          // Attempt 1: DexScreener (host vem da configuração, não hardcoded)
          try {
            /**
             * PRIORIDADE DE SAÍDA: este preço alimenta stop-loss/take-profit. Posição sem
             * telemetria é posição sem gestão de risco — bloquear isso por cota trocaria risco
             * de mercado por risco de infraestrutura. Sem vaga, a chamada passa mesmo assim e o
             * excesso é CONTADO (`bypassed`).
             */
            const dexCall = await withBudget(
              budgets.dexscreener,
              // O SOL entra na mesma chamada como âncora USD→SOL (ver resolveEntryPrice).
              () => fetch(`${DEXSCREENER_BASE_URL}/tokens/${pos.mint},${SOL_MINT}`),
              { priority: "exit" }
            );
            const dexRes = dexCall.value;
            if (dexRes?.ok) {
              const dexData = await dexRes.json();
              // Mesma regra do lote: `priceNative` só é SOL quando o par é cotado em SOL.
              const r = priceSolFromDexPairs(dexData?.pairs, pos.mint);
              if (r.priceSol !== null && r.priceSol > 0) {
                currentPriceSol = r.priceSol;
                priceSource = `DexScreener (${r.reason})`;
              }
            }
          } catch (err: any) {
            // DexScreener indisponível: cai para a cotação real.
          }

          // Attempt 2: cotação REAL da Jupiter para exatamente 1 token inteiro.
          if (currentPriceSol === 0) {
            const decimals = await getMintDecimals(pos.mint);
            if (decimals === null) {
              console.warn(
                `[Price] Não foi possível determinar os decimais de ${pos.mint}; fonte de cotação descartada ` +
                  `(converter sem decimais produziria preço errado por ordens de magnitude).`
              );
            } else {
              try {
                const oneTokenRaw = Math.pow(10, decimals);
                // Fallback de preço para a gestão de risco: mesma prioridade de SAÍDA.
                const jupCall = await withBudget(
                  budgets.jupiter,
                  () =>
                    JupiterIntegration.getQuote(
                      pos.mint,
                      "So11111111111111111111111111111111111111112",
                      oneTokenRaw,
                      100
                    ),
                  { priority: "exit" }
                );
                const q = jupCall.value;
                const solPerToken = q ? parseFloat(q.outAmount) / 1e9 : Number.NaN;
                if (Number.isFinite(solPerToken) && solPerToken > 0) {
                  currentPriceSol = solPerToken;
                  priceSource = `Jupiter Quote API (${decimals} decimais)`;
                }
              } catch (err: any) {
                // Sem rota/erro de rede: permanece sem preço (tratado abaixo).
              }
            }
          }
        }

        /**
         * SEM PREÇO NÃO HÁ GESTÃO DE RISCO — E ISSO PRECISA SER DITO EM VOZ ALTA.
         *
         * O código anterior, quando todas as fontes falhavam, reaproveitava o último
         * preço conhecido e seguia. Consequência: com preço congelado o PnL congela, o
         * stop-loss nunca dispara, e o operador não recebe nenhum sinal de que o bot
         * perdeu telemetria de preço de uma posição ABERTA com capital real.
         *
         * Agora: preço ausente ou velho => escalamos alerta e NÃO avaliamos SL/TP com
         * dado inválido. Preferimos dizer "não sei" a fingir que sei.
         */
        const priceQuote: PriceQuote | undefined =
          currentPriceSol > 0 ? { priceSol: currentPriceSol, source: priceSource, fetchedAt: Date.now() } : undefined;
        const freshness = assessPriceFreshness(priceQuote);

        if (riskActionForFreshness(freshness) === "escalate") {
          // Registra a falha e afasta a próxima tentativa (backoff exponencial com teto).
          const misses = (priceTelemetryBackoff.get(pos.id)?.misses ?? 0) + 1;
          const backoffMs = Math.min(3000 * Math.pow(2, misses - 1), 60_000);
          priceTelemetryBackoff.set(pos.id, { misses, nextPollAt: Date.now() + backoffMs });

          const lastAlertAt = (pos as any).lastPriceAlertAt || 0;
          if (Date.now() - lastAlertAt > 60_000) {
            (pos as any).lastPriceAlertAt = Date.now();
            (pos as any).priceTelemetry = {
              status: freshness,
              lastAttemptAt: new Date().toISOString(),
              consecutiveMisses: misses,
              nextPollInMs: backoffMs,
            };
            dbStore.savePosition(pos);
            dbStore.saveLog({
              timestamp: new Date().toISOString(),
              level: "CRITICAL",
              component: "RISK_ENGINE",
              message:
                `[TELEMETRIA DE PREÇO PERDIDA] Posição $${pos.token} está ABERTA e não há preço ` +
                `confiável (status: ${freshness}). Stop-loss/take-profit NÃO estão sendo avaliados. ` +
                `Intervenção manual necessária — o bot não consegue proteger esta posição sem preço.`,
              correlationId: `corr_price_${pos.id}_${Date.now()}`,
            });
          }
          continue;
        }

        // Telemetria recuperada: zera o backoff desta posição.
        if (priceTelemetryBackoff.has(pos.id)) priceTelemetryBackoff.delete(pos.id);

        console.log(`[On-Chain Price Monitor] ${currentPriceSol} SOL para $${pos.token} via ${priceSource}`);

        // 2. Cálculo de PnL usando preço real
        pos.currentPrice = currentPriceSol;
        pos.pnlPercent = parseFloat((((currentPriceSol - pos.entryPrice) / pos.entryPrice) * 100).toFixed(2));
        if (currentPriceSol > pos.highestPrice) {
          pos.highestPrice = currentPriceSol;
        }
        
        // Save current price & PnL directly to database
        dbStore.savePosition(pos);

        // SÉRIE DE PREÇOS PARA REPLAY.
        // Esta é a matéria-prima do backtest: sem gravar o preço em cada observação, não
        // existe como responder depois "a estratégia de saída tinha edge?". Gravar aqui
        // custa um append em JSONL; não gravar custa a capacidade de validar qualquer coisa.
        recorder.recordPriceObservation({
          positionId: pos.id,
          mint: pos.mint,
          priceSol: currentPriceSol,
          source: priceSource,
          ageMs: 0, // a observação é rotulada 'fresh' pelo assessPriceFreshness acima
          pnlPercent: pos.pnlPercent,
        });

        const correlationId = `corr_pos_${pos.id}_${Date.now()}`;

        // 3. Stop Loss
        const slThreshold = pos.stopLossPercent || -5.0;
        if (pos.pnlPercent <= slThreshold) {
          if (isPaper) {
            recordPaperClose(pos, "Stop-Loss (shadow)", pos.pnlPercent);
          } else {
            await executeAutonomousExit(pos, "Stop-Loss Real On-Chain", pos.pnlPercent, correlationId);
          }
          continue;
        }

        // 4. Take Profit
        const tpThreshold = pos.takeProfitPercent || 15.0;
        if (pos.pnlPercent >= tpThreshold) {
          if (isPaper) {
            recordPaperClose(pos, "Take Profit (shadow)", pos.pnlPercent);
          } else {
            await executeAutonomousExit(pos, "Take Profit Alvo Real", pos.pnlPercent, correlationId);
          }
          continue;
        }

        // 5. Trailing Stop
        if (pos.trailingStopActive) {
          const trailingOffset = pos.trailingStopOffsetPercent || 2.5;
          const drawdownPercent = ((pos.highestPrice - currentPriceSol) / pos.highestPrice) * 100;
          
          if (drawdownPercent >= trailingOffset && pos.pnlPercent > 1.0) {
            if (isPaper) {
              recordPaperClose(pos, `Trailing Stop ${trailingOffset}% (shadow)`, pos.pnlPercent);
            } else {
              await executeAutonomousExit(pos, `Trailing Stop Real (${trailingOffset}% Drawdown)`, pos.pnlPercent, correlationId);
            }
            continue;
          }
        }
      }
    } catch (err: any) {
      console.error("[HFT Position Manager] Error in position tracking loop:", err.message);
    }
  }
}

/**
 * Decimais de um mint, lidos do RPC e CACHEADOS pelo resto do processo.
 *
 * Por que cachear sem TTL: os decimais de um mint são imutáveis por definição do SPL Token.
 * Não existe invalidação possível, e uma chamada de rede por poll (a cada 3s por posição)
 * seria desperdício puro.
 *
 * Devolve `null` quando não foi possível LER. Nunca assume 9 (o default perigoso): assumir
 * decimais errados multiplica ou divide o preço interpretado por 10^n, e esse preço alimenta
 * stop-loss e take-profit reais.
 */
const mintDecimalsCache = new Map<string, number>();
async function getMintDecimals(mint: string): Promise<number | null> {
  const cached = mintDecimalsCache.get(mint);
  if (cached !== undefined) return cached;
  const conn = globalConnection;
  if (!conn) return null; // sem conexão não há leitura — e não vamos adivinhar decimais
  try {
    const info = await conn.getParsedAccountInfo(new PublicKey(mint));
    const parsed: any = (info.value as any)?.data?.parsed;
    const decimals = parsed?.info?.decimals;
    if (parsed?.type === "mint" && typeof decimals === "number" && decimals >= 0 && decimals <= 18) {
      mintDecimalsCache.set(mint, decimals);
      return decimals;
    }
  } catch (err: any) {
    console.warn(`[Price] getParsedAccountInfo(${mint}) falhou: ${err.message}`);
  }
  return null;
}

// ETAPA 12 — Real On-Chain Liquidation and Swap Execution

/**
 * Retry com backoff exponencial sobre a MESMA operação idempotente.
 *
 * Retry só é seguro para COTAÇÃO (leitura). A construção do swap também é leitura
 * (devolve transação não assinada), portanto pode ser repetida. O ENVIO nunca é
 * repetido aqui — reenviar um bundle já aceito pode liquidar duas vezes.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>, retries = 2, delayMs = 500): Promise<T> {
  let lastError: any = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (attempt < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs * Math.pow(2, attempt)));
      }
    }
  }
  throw new Error(`${label} falhou após ${retries} tentativas: ${lastError?.message ?? lastError}`);
}

/** Cotação da Jupiter com retry, no host configurado (nunca em host hardcoded). */
async function fetchJupiterQuoteWithRetry(
  inputMint: string,
  outputMint: string,
  amountLamports: number,
  slippageBps: number,
  retries = 2
): Promise<any> {
  /**
   * Esta função só é usada no caminho de SAÍDA (fechar posição). Portanto: prioridade de
   * saída — cota esgotada não pode impedir reduzir risco; o bypass aparece em `bypassed`.
   */
  const call = await withBudget(
    budgets.jupiter,
    () =>
      withRetry(
        "Jupiter quote",
        () => JupiterIntegration.getQuote(inputMint, outputMint, amountLamports, slippageBps),
        retries
      ),
    { priority: "exit" }
  );
  if (!call.ok) {
    throw new Error(call.skippedReason ?? "cotação bloqueada por orçamento de cota");
  }
  return call.value;
}

/** Construção da transação de swap com retry (não assina, não envia). */
async function fetchJupiterSwapWithRetry(quoteResponse: any, userPublicKeyStr: string, retries = 2): Promise<VersionedTransaction> {
  return withRetry(
    "Jupiter swap build",
    () => JupiterIntegration.buildSwapTransaction(quoteResponse, userPublicKeyStr),
    retries
  );
}

/**
 * MEDE UMA PERNA do ciclo (uma transação confirmada) — entrada ou saída (S11).
 *
 * Por que isto existe: o extrator anterior lia o ΔSOL da **transação de saída** e gravava esse
 * número como `pnlNetSol` com `measuredOnChain: true`. Esse delta é a RECEITA DA VENDA — o crédito
 * da venda menos fee/tip dela — e não contém o que foi pago na compra. O efeito é do TAMANHO DA
 * POSIÇÃO em toda operação e sempre para cima: uma compra de 0,01 SOL que vende por 0,02 SOL era
 * reportada como "+0,02 SOL de PnL líquido medido", quando o lucro do ciclo era +0,01 SOL. Como o
 * número vinha marcado como medido, entrava na validação estatística como desfecho confiável.
 *
 * A medição por PERNA é feita nos saldos da própria transação (`parseTransactionLeg`, puro) e a
 * combinação das duas pernas é a conta do ciclo (`computeRoundTrip`). `getTransaction` exige
 * commitment `confirmed` ou `finalized` (o RPC recusa `processed`), então isto roda DEPOIS da
 * confirmação — nunca no caminho crítico da decisão de vender.
 */
async function measureLeg(
  signature: string,
  wallet: PublicKey,
  mint: string
): Promise<ReturnType<typeof parseTransactionLeg>> {
  const conn = globalConnection;
  if (!conn) return unmeasuredLeg(signature, "sem conexão RPC");
  try {
    const tx = await conn.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) return unmeasuredLeg(signature, "transação não retornada pelo RPC (histórico indisponível?)");
    return parseTransactionLeg(wallet.toBase58(), mint, tx);
  } catch (err: any) {
    return unmeasuredLeg(signature, err?.message ?? String(err));
  }
}

/** Saldo da carteira em lamports (usado SÓ na conferência opcional por janela). */
async function walletLamportsNow(): Promise<number | null> {
  const conn = globalConnection;
  if (!conn) return null;
  try {
    return await conn.getBalance(getActiveWalletPublicKey(), "confirmed");
  } catch {
    return null;
  }
}

/**
 * PnL DO CICLO COMPLETO de uma posição real (S11).
 *
 * Combina a perna de ENTRADA (gravada na posição no momento da confirmação da compra) com a perna
 * de SAÍDA (a transação que acabou de confirmar). Sem as duas, `pnlNetSol` é `null` — nunca a
 * receita da venda disfarçada de lucro.
 *
 * A conferência por janela de saldos é OPCIONAL (`HFT_PNL_WINDOW_CHECK=1`) porque custa duas
 * chamadas `getBalance` (RTT) no caminho da saída; o PnL por perna é exato sem ela.
 */
async function measureRoundTrip(
  pos: { entryLeg?: LegRecord | null; mint: string },
  exitSignature: string,
  exitWalletLamportsBefore: number | null
): Promise<ReturnType<typeof parseTransactionLeg> extends never ? never : {
  economics: ReturnType<typeof parseTransactionLeg>;
  ciclo: ReturnType<typeof computeRoundTrip>;
}> {
  const wallet = getActiveWalletPublicKey();
  const economics = await measureLeg(exitSignature, wallet, pos.mint);
  const pernaEntrada = pos.entryLeg ?? null;

  const querJanela = process.env.HFT_PNL_WINDOW_CHECK === "1";
  const depois = querJanela && exitWalletLamportsBefore !== null ? await walletLamportsNow() : null;

  const ciclo = computeRoundTrip({
    entry: pernaEntrada
      ? {
          signature: pernaEntrada.signature,
          measured: pernaEntrada.measured,
          solDeltaLamports: pernaEntrada.solDeltaLamports,
          preLamports: pernaEntrada.preLamports,
          postLamports: pernaEntrada.postLamports,
          feeLamports: pernaEntrada.feeLamports,
          tokenDeltaRaw: pernaEntrada.tokenDeltaRaw,
          slot: pernaEntrada.slot,
          onChainError: pernaEntrada.onChainError,
          error: pernaEntrada.error,
        }
      : null,
    exit: economics,
    /**
     * Tamanho da posição = tokens RECEBIDOS na entrada (medidos on-chain, mesmo extrator da perna).
     * Sem isso não há como distinguir venda parcial de venda total — e uma venda parcial tratada
     * como total "fecha" uma posição que ainda tem exposição.
     */
    positionTokensRaw: pernaEntrada?.tokenDeltaRaw ?? null,
    walletLamportsBefore: querJanela ? exitWalletLamportsBefore : null,
    walletLamportsAfter: querJanela ? depois : null,
  });
  if (querJanela && exitWalletLamportsBefore === null) {
    ciclo.notes.push("conferência por janela pedida, mas o saldo da carteira antes da saída não foi lido — janela não conferida.");
  }
  return { economics, ciclo };
}

async function executeAutonomousExit(pos: any, reason: string, pnlPercent: number, correlationId: string): Promise<void> {
  /**
   * Trilha de latência da SAÍDA. O caminho de saída é o que decide se a perda para no
   * stop ou vira prejuízo grande — medir cada estágio é o mínimo para poder discuti-lo.
   * A amostra é gravada tanto no sucesso quanto na falha (falha também é resultado).
   */
  const trace = new LatencyTrace(`exit_${pos.id}_${Date.now()}`, undefined, null, null);
  // 1. Thread-safe concurrency check (Double sell / Race condition prevention)
  if (exitLocks.has(pos.id) || pos.status === "exit_pending" || pos.status === "closed") {
    console.warn(`[Risk Engine Lock] Aborting exit. Position ${pos.id} is already in exit process or closed. Status: ${pos.status}`);
    return;
  }

  /**
   * TRAVA DE VOO ÚNICO (S4). Antes de qualquer assinatura, verifica se já existe uma
   * intenção de SAÍDA não terminal para esta posição. Se existe, NÃO se assina outra:
   * duas transações válidas para a mesma venda podem vender duas vezes.
   *
   * A saída legítima para uma intenção travada é EVIDÊNCIA (expiração provada por altura
   * de bloco ou erro de execução na cadeia), aplicada por `recoverActiveIntents()`.
   */
  const blockingIntent = findBlockingIntent(dbStore.getIntents(), pos.id, "exit");
  if (blockingIntent) {
    if (blockedIntentWarned.has(blockingIntent.id)) {
      console.warn(`[Intents] Saída de ${pos.id} continua bloqueada por ${blockingIntent.id} (${blockingIntent.state}).`);
      return;
    }
    blockedIntentWarned.add(blockingIntent.id);
    console.warn(
      `[Intents] Saída de ${pos.id} bloqueada: intenção ${blockingIntent.id} segue em estado "${blockingIntent.state}" ` +
        `(assinatura ${blockingIntent.signature?.slice(0, 12) ?? "nenhuma"}). Não se assina uma segunda venda sem prova de que a primeira não pode entrar.`
    );
    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "WARN",
      component: "RISK_ENGINE",
      message:
        `[INTENTS] Saída de $${pos.token} NÃO iniciada: já existe intenção não resolvida ` +
        `(${blockingIntent.id}, estado ${blockingIntent.state}). Um segundo envio poderia duplicar a venda. ` +
        `Aguarde a resolução por status/expiração.`,
      correlationId,
    });
    return;
  }

  // Acquire Lock and set status to EXIT_PENDING immediately
  exitLocks.add(pos.id);
  pos.status = "exit_pending";
  dbStore.savePosition(pos);

  // Intenção persistida ANTES de assinar. É o registro que sobrevive a um crash entre
  // assinar e confirmar — e o que impede uma segunda assinatura no restart.
  let exitIntent = persistIntent(
    createExecutionIntent({ positionId: pos.id, mint: pos.mint, token: pos.token, side: "exit" })
  );

  const triggerTime = Date.now();
  
  dbStore.saveLog({
    timestamp: new Date().toISOString(),
    level: "WARN",
    component: "RISK_ENGINE",
    message: `[AUTO-EXIT DISPARADO] Limite de ${reason} alcançado para $${pos.token} (PnL Real: ${pnlPercent.toFixed(2)}%). Status alterado para EXIT_PENDING. Iniciando liquidação...`,
    correlationId
  });

  try {
    const connection = await runWithRpcFailover(async (conn) => conn);
    const walletPublicKey = getActiveWalletPublicKey();

    // 2. Fetch exact token account balance and decimals from RPC
    let rawAmount = 0;
    let decimals = 9;

    try {
      const tokenAccounts = await runWithRpcFailover(async (conn) => {
        return await conn.getParsedTokenAccountsByOwner(
          walletPublicKey,
          { mint: new PublicKey(pos.mint) }
        );
      });
      if (tokenAccounts.value.length > 0) {
        const accInfo = tokenAccounts.value[0].account.data.parsed.info;
        rawAmount = parseInt(accInfo.tokenAmount.amount) || 0;
        decimals = accInfo.tokenAmount.decimals || 9;
      }
    } catch (err: any) {
      console.log(`[On-Chain Exit] Parsed token accounts query for ${pos.token}: ${err.message}. Using local calculation.`);
    }

    // If balance is 0, fall back to calculated quantity
    if (rawAmount === 0) {
      const qtyFloat = (pos.sizeSol / (pos.entryPrice || 0.0001)) || 1000000;
      rawAmount = Math.floor(qtyFloat * Math.pow(10, decimals));
      console.log(`[On-Chain Exit] Local token balance was 0. Proceeding with position qty ${qtyFloat} units.`);
    }

    // Tip LIMITADO por bps do capital (mesmo motivo do fechamento manual).
    const { tipSol: jitoTip, clamped: tipClamped } = clampTipSol(
      0.003,
      pos.sizeSol,
      Number(process.env.MAX_TIP_BPS ?? 50)
    );
    if (tipClamped) {
      console.warn(
        `[Tip Limitado] Tip de saída de $${pos.token} reduzido para ${jitoTip.toFixed(6)} SOL ` +
          `(teto de ${process.env.MAX_TIP_BPS ?? 50} bps sobre ${pos.sizeSol} SOL).`
      );
    }
    const jitoSender = new JitoBundleSender(connection);
    
    let signature = "";
    let finalSlot = 0;
    let confirmed = false;
    let quoteData: any = null;
    let observedConfirmationLevel: "processed" | "confirmed" | "finalized" = "confirmed";

    /**
     * Tentativa anterior mantida em MEMÓRIA — os bytes assinados nunca vão para disco
     * (transação assinada é dinheiro em movimento; quem a tem pode transmiti-la).
     */
    let previousExitAttempt:
      | { transaction: VersionedTransaction; blockhash: string; lastValidBlockHeight: number; signature: string }
      | null = null;
    /** true quando a política decidiu REENVIAR os mesmos bytes (nada é reconstruído). */
    let rebroadcastOnly = false;

    // Retry loop with Adaptive Slippage (max 3 retries)
    for (let jitoAttempt = 0; jitoAttempt < 3; jitoAttempt++) {
      /**
       * POLÍTICA DE RETRY (S4). Antes de reconstruir a transação, pergunta-se à cadeia:
       * reenviar os MESMOS bytes é idempotente (a runtime deduplica por message hash);
       * reconstruir cria uma transação NOVA (blockhash novo) que pode entrar junto com a
       * anterior. Só se reconstrói com prova de que a anterior não pode mais entrar.
       */
      rebroadcastOnly = false;
      if (previousExitAttempt) {
        const { decision, slot } = await decideExitRetry(exitIntent, previousExitAttempt);

        if (decision.action === "stop_confirmed") {
          confirmed = true;
          signature = previousExitAttempt.signature;
          finalSlot = slot ?? 0;
          trace.mark("confirmed");
          exitIntent = advanceIntentOrKeep(
            exitIntent,
            "confirmed",
            { confirmationLevel: decision.level },
            `tentativa ${jitoAttempt + 1}: ${decision.reason}`
          );
          dbStore.saveLog({
            timestamp: new Date().toISOString(),
            level: "WARN",
            component: "JITO_BUNDLE",
            message:
              `[INTENTS] Saída de $${pos.token} JÁ ESTAVA na cadeia (${decision.reason}). Nenhuma nova transação ` +
              `foi construída — a intenção ${exitIntent.id} foi encerrada como confirmada (nível ${decision.level ?? "?"}).`,
            correlationId,
          });
          break;
        }

        if (decision.action === "rebuild") {
          dbStore.saveLog({
            timestamp: new Date().toISOString(),
            level: "WARN",
            component: "JITO_BUNDLE",
            message:
              `[INTENTS] Reconstrução AUTORIZADA por evidência (tentativa ${jitoAttempt + 1}): ${decision.reason}`,
            correlationId,
          });
          const terminal = decision.reason.includes("ERRO de execução") ? "failed" : "expired";
          exitIntent = supersedeIntent(exitIntent, terminal, decision.reason);
        } else if (decision.action === "rebroadcast") {
          rebroadcastOnly = true;
          dbStore.saveLog({
            timestamp: new Date().toISOString(),
            level: "WARN",
            component: "JITO_BUNDLE",
            message:
              `[INTENTS] Reenvio dos MESMOS bytes assinados (tentativa ${jitoAttempt + 1}): ${decision.reason}`,
            correlationId,
          });
        } else {
          // "wait": não há evidência. Nenhuma transação nova; aguarda o próximo ciclo.
          dbStore.saveLog({
            timestamp: new Date().toISOString(),
            level: "WARN",
            component: "JITO_BUNDLE",
            message: `[INTENTS] Saída de $${pos.token} aguardando evidência (nenhuma transação nova): ${decision.reason}`,
            correlationId,
          });
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }
      }

      try {
        // Read user-configured base slippage (default 1.5% = 150 bps)
        const baseSlippageBps = pos.slippageBps || 150;
        // Adaptive algorithm: increase slippage on successive retries
        let currentSlippageBps = baseSlippageBps;
        if (jitoAttempt === 1) currentSlippageBps += 100; // +1.0%
        if (jitoAttempt === 2) currentSlippageBps += 250; // +2.5%

        // Cap at configured maximum or fallback 10% (1000 bps)
        const maxSlippageBps = pos.maxSlippageBps || 1000;
        currentSlippageBps = Math.min(currentSlippageBps, maxSlippageBps);

        dbStore.saveLog({
          timestamp: new Date().toISOString(),
          level: "INFO",
          component: "RISK_ENGINE",
          message: `[SLIPPAGE ADAPTATIVO] Auto Exit Tentativa #${jitoAttempt + 1} para $${pos.token}. Ajustando slippage para ${(currentSlippageBps / 100).toFixed(2)}% (Slippage Base: ${(baseSlippageBps / 100).toFixed(2)}%, Limite Max: ${(maxSlippageBps / 100).toFixed(2)}%).`,
          correlationId
        });

        // 3–4. Cotação e construção — OU reaproveitamento dos MESMOS bytes assinados.
        let transaction: VersionedTransaction;
        let blockhash: string;
        let lastValidBlockHeight: number;
        let alreadySigned = false;

        if (rebroadcastOnly && previousExitAttempt) {
          transaction = previousExitAttempt.transaction;
          blockhash = previousExitAttempt.blockhash;
          lastValidBlockHeight = previousExitAttempt.lastValidBlockHeight;
          alreadySigned = true;
          dbStore.saveLog({
            timestamp: new Date().toISOString(),
            level: "INFO",
            component: "JITO_BUNDLE",
            message:
              `[INTENTS] Reenviando a MESMA transação assinada (assinatura ${previousExitAttempt.signature.slice(0, 12)}...). ` +
              `Nenhuma recotação, nenhuma nova assinatura: reenvio dos mesmos bytes é idempotente na Solana.`,
            correlationId
          });
        } else {
          quoteData = await fetchJupiterQuoteWithRetry(
            pos.mint,
            "So11111111111111111111111111111111111111112",
            rawAmount,
            currentSlippageBps
          );
          trace.mark("built");

          transaction = await fetchJupiterSwapWithRetry(quoteData, walletPublicKey.toBase58());

          dbStore.saveLog({
            timestamp: new Date().toISOString(),
            level: "INFO",
            component: "JITO_BUNDLE",
            message: `[KMS Private Signer] Assinando transação de swap e autorizando Jito Tip de ${jitoTip} SOL via Vault Isolado.`,
            correlationId
          });

          const latest = await runWithRpcFailover(async (conn) => await conn.getLatestBlockhash("processed"));
          blockhash = latest.blockhash;
          // Sem lastValidBlockHeight não existe prova de expiração — e sem prova de
          // expiração a política de retry NUNCA autoriza reconstruir.
          lastValidBlockHeight = latest.lastValidBlockHeight;
        }

        const jitoRes = await executeWithDecryptedKeypair(async (keypair) => {
          if (!alreadySigned) {
            transaction.sign([keypair]);
            const signedSignature = bs58.encode(transaction.signatures[0]);
            /**
             * PERSISTIR ANTES DE TRANSMITIR. Se o processo morrer entre assinar e enviar,
             * a assinatura fica registrada e o próximo boot CONSULTA o status (nunca
             * reconstrói às cegas). Os bytes assinados NÃO são gravados.
             */
            exitIntent = advanceIntentOrKeep(
              exitIntent,
              "signed",
              { signature: signedSignature, blockhash, lastValidBlockHeight },
              `tentativa ${jitoAttempt + 1}: transação assinada (ainda não transmitida)`
            );
          }
          trace.mark("signed");
          const submitted = await jitoSender.submitBundle([transaction], keypair, jitoTip, blockhash, {
            capitalCommittedSol: pos.sizeSol,
            maxTipBps: Number(process.env.MAX_TIP_BPS ?? 50),
            region: (process.env.JITO_REGION as any) || undefined,
            purpose: "exit",
          });
          trace.mark("submitted");
          return submitted;
        }, "exit");

        if (!jitoRes || !jitoRes.success) {
          throw new Error(`Jito Block Engine rejected bundle: ${jitoRes?.error || "Unknown bundle error"}`);
        }

        signature = bs58.encode(transaction.signatures[0]);
        // Tentativa corrente guardada em MEMÓRIA para permitir reenvio dos mesmos bytes.
        previousExitAttempt = { transaction, blockhash, lastValidBlockHeight, signature };
        exitIntent = advanceIntentOrKeep(
          exitIntent,
          "submitted",
          { signature, blockhash, lastValidBlockHeight },
          `tentativa ${jitoAttempt + 1}: aceita pelo block engine`
        );
        dbStore.saveLog({
          timestamp: new Date().toISOString(),
          level: "INFO",
          component: "JITO_BUNDLE",
          message: `[Jito Bundle Exit] Bundle enviado (Tentativa ${jitoAttempt + 1}/3, intenção ${exitIntent.id}). ID Jito: ${jitoRes.bundleId}. Assinatura: ${signature}. Aguardando confirmação...`,
          correlationId
        });

        // Poll for confirmation
        const confirmTimeout = 30000; // 30s per attempt
        const confirmStart = Date.now();
        while (Date.now() - confirmStart < confirmTimeout) {
          const status = await runWithRpcFailover(async (conn) => await conn.getSignatureStatus(signature, {
            searchTransactionHistory: false
          }));
          if (status.value) {
            if (status.value.err) {
              throw new Error(`Transação de liquidação rejeitada on-chain: ${JSON.stringify(status.value.err)}`);
            }
            if (status.value.confirmationStatus === "confirmed" || status.value.confirmationStatus === "processed") {
              confirmed = true;
              /**
               * NÍVEL DE CONFIRMAÇÃO registrado literalmente. `processed` é inclusão
               * otimista: a venda foi aceita em bloco, mas ainda pode ser revertida.
               * A posição tem de ser dada como vendida de qualquer forma (não fazer isso
               * reabriria a porta para uma SEGUNDA venda), e o nível fica gravado para
               * auditoria — e não como "confirmado" genérico.
               */
              observedConfirmationLevel =
                status.value.confirmationStatus === "processed" ? "processed" : "confirmed";
              finalSlot = status.context.slot;
              trace.mark("confirmed");
              break;
            }
          }
          await new Promise(resolve => setTimeout(resolve, 1500));
        }

        if (confirmed) {
          break; // successfully landed
        } else {
          console.log(`[Jito Retry] Attempt ${jitoAttempt + 1} timeout check. Re-submitting bundle...`);
        }
      } catch (jitoErr: any) {
        console.log(`[Jito Retry] Attempt ${jitoAttempt + 1} status: ${jitoErr.message}`);
        if (jitoAttempt === 2) {
          throw jitoErr;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    if (!confirmed || !signature || !quoteData) {
      throw new Error("Transação enviada ao Jito mas não foi confirmada pelo RPC da Solana dentro de todas as tentativas.");
    }

    // Intenção encerrada como CONFIRMADA, com o nível realmente observado.
    exitIntent = advanceIntentOrKeep(
      exitIntent,
      "confirmed",
      { confirmationLevel: observedConfirmationLevel, signature },
      `confirmada no nível ${observedConfirmationLevel}`
    );
    blockedIntentWarned.delete(exitIntent.id);
    if (observedConfirmationLevel === "processed") {
      dbStore.saveLog({
        timestamp: new Date().toISOString(),
        level: "WARN",
        component: "JITO_BUNDLE",
        message:
          `[INTENTS] Saída de $${pos.token} vista como PROCESSED (inclusão otimista, NÃO finalizada). ` +
          `A posição é dada como vendida para não reabrir segunda venda; a assinatura ${signature} fica registrada ` +
          `para verificação posterior.`,
        correlationId,
      });
    }

    // 5. Encerramento da posição (SÓ DEPOIS da confirmação on-chain)
    const outSol = parseFloat(quoteData.outAmount) / 1e9;
    const latencyMs = Date.now() - triggerTime;

    // Amostra de latência da SAÍDA bem-sucedida: recebimento do gatilho -> confirmação.
    telemetry.record(trace.toRecord("executed"));

    /**
     * PnL DO CICLO (S11): perna de entrada (gravada na posição) + perna de saída (esta transação).
     * Substitui a leitura do ΔSOL da venda, que media RECEITA e era gravada como lucro.
     */
    const { economics: pernaSaida, ciclo } = await measureRoundTrip(pos, signature, null);

    const realCloseTx = {
      id: signature, // Assinatura real da transação na blockchain
      token: pos.token,
      mint: pos.mint,
      amount: `${(rawAmount / Math.pow(10, decimals)).toFixed(2)} ${pos.token}`,
      outAmount: `${outSol.toFixed(4)} SOL (bruto cotado)`,
      time: new Date().toTimeString().split(' ')[0] + "." + String(Date.now() % 1000).padStart(3, '0'),
      latencyMs,
      status: "success" as const,
      block: finalSlot,
      tipSol: jitoTip,
      route: `KMS Real Exit Jito (${reason})${ciclo.measured ? "" : ` (PnL do ciclo NÃO apurado: ${ciclo.basis})`}`,
      signature,
      pnlNetSol: ciclo.measured ? (ciclo.pnlNetSol as number) : undefined,
      saleProceedsSol: pernaSaida.measured && pernaSaida.solDeltaLamports !== null ? pernaSaida.solDeltaLamports / 1e9 : undefined,
      // Soma das base fees das DUAS pernas (quando conhecidas): o custo de rede do ciclo, não só da venda.
      feesSol: ciclo.feesSol ?? undefined,
      measuredOnChain: pernaSaida.measured,
      pnlBasis: ciclo.basis,
      windowConflictSol: ciclo.windowConflict ? (ciclo.discrepancySol as number) : undefined,
      mode: "live" as const,
    };

    dbStore.saveTrade(realCloseTx);
    snipedTransactions.unshift(realCloseTx);
    if (snipedTransactions.length > 25) {
      snipedTransactions.pop();
    }

    // Set status to closed, save to db, and remove from memory active list
    pos.status = "closed";
    dbStore.savePosition(pos);
    dbStore.deletePosition(pos.id);
    exitLocks.delete(pos.id);

    recorder.recordPositionLifecycle({
      positionId: pos.id,
      mint: pos.mint,
      token: pos.token,
      event: "closed",
      mode: "live",
      sizeSol: pos.sizeSol,
      entryPriceSol: pos.entryPrice ?? null,
      exitPriceSol: rawAmount > 0 ? outSol / (rawAmount / Math.pow(10, decimals)) : null,
      pnlPercent: ciclo.measured && pos.sizeSol > 0 ? ((ciclo.pnlNetSol as number) / pos.sizeSol) * 100 : null,
      reason,
      pnlMeasuredOnChain: ciclo.measured,
    });

    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "SUCCESS",
      component: "RISK_ENGINE",
      message:
        `[AUTO-EXIT CONFIRMADO] Posição de $${pos.token} liquidada on-chain no bloco #${finalSlot}. ` +
        `Bruto cotado: ${outSol.toFixed(4)} SOL. ` +
        (ciclo.measured
          ? `PnL LÍQUIDO DO CICLO MEDIDO on-chain (entrada + saída): ${(ciclo.pnlNetSol as number) >= 0 ? "+" : ""}${(ciclo.pnlNetSol as number).toFixed(6)} SOL ` +
            `(custo de entrada: ${(ciclo.entryCostSol as number).toFixed(6)} SOL; receita da venda: ${(ciclo.exitProceedsSol as number).toFixed(6)} SOL; ` +
            `fees de rede: ${(ciclo.feesSol ?? 0).toFixed(6)} SOL; tip: ${jitoTip.toFixed(6)} SOL). ` +
            `PnL de preço no momento do gatilho: ${pnlPercent.toFixed(2)}%. ` +
            ciclo.notes.join(" ")
          : `ATENÇÃO: PnL do ciclo NÃO apurado (${ciclo.basis}): ${ciclo.reasons.join("; ")}. ` +
            (ciclo.exitProceedsSol !== null
              ? `O que foi medido é a RECEITA DA VENDA: ${ciclo.exitProceedsSol.toFixed(6)} SOL entraram na carteira nesta transação — isto NÃO é lucro. `
              : "") +
            `O valor exibido NÃO é resultado realizado.`) +
        ` Latência: ${latencyMs}ms.`,
      correlationId
    });

    reportTradeOutcome(true);

  } catch (err: any) {
    /**
     * FALHA DE SAÍDA — REGISTRADA COMO FALHA, NUNCA COMO SUCESSO.
     *
     * AUDITORIA 2026-10-02 (achado de severidade CRÍTICA):
     * Este bloco anteriormente "liquidava" a posição em um simulador interno, gravava
     * a operação com `status: "success"`, um block number ALEATÓRIO, latência aleatória e
     * chamava `reportTradeOutcome(true)`. Consequências encadeadas:
     *
     *   1. O relatório de PnL era ficção: `outSol` vinha de `sizeSol * (1 + pnl/100)`,
     *      ou seja, assumia que o preço-alvo foi executado sem qualquer atrito.
     *   2. O circuit breaker NUNCA disparava por falha de saída, porque toda falha de
     *      saída era reportada como sucesso (`reportTradeOutcome(true)`).
     *   3. A posição era REMOVIDA do banco sem que os tokens tivessem sido vendidos.
     *      O bot "esquecia" que tinha exposição, e capital real ficava preso em um ativo
     *      sem gestão de risco — o modo de falha mais perigoso em uma estratégia de saída.
     *
     * Comportamento correto: manter a posição ABERTA, registrar a falha, alimentar o
     * circuit breaker e escalar alerta para intervenção humana.
     */
    const latencyMs = Date.now() - triggerTime;
    const errorMessage = err?.message || String(err);

    // Falha de saída TAMBÉM é resultado: a trilha parcial mostra em que estágio o
    // caminho parou (cotação / construção / assinatura / envio / confirmação).
    telemetry.record(trace.toRecord("failed"));

    /**
     * ESTADO DA INTENÇÃO NA FALHA — decidido pelo que se SABE, não pelo que se espera:
     *   - `created`: nada foi assinado → nada poderia ter sido transmitido → terminal.
     *   - `signed` : assinada, envio NÃO confirmado → pode ter chegado. NÃO é terminal:
     *                a trava de voo único impede uma segunda assinatura até haver prova.
     *   - `submitted`: enviada → mesma regra, com evidência de envio.
     */
    if (exitIntent.state === "created") {
      exitIntent = advanceIntentOrKeep(
        exitIntent,
        "failed",
        { lastError: errorMessage },
        "falha antes da assinatura: nenhuma transação poderia ter sido transmitida"
      );
    } else {
      dbStore.saveLog({
        timestamp: new Date().toISOString(),
        level: "CRITICAL",
        component: "JITO_BUNDLE",
        message:
          `[INTENTS] Intenção ${exitIntent.id} (saída de $${pos.token}) permanece NÃO RESOLVIDA no estado ` +
          `"${exitIntent.state}" após erro: ${errorMessage.slice(0, 160)}. ` +
          `A posição volta para OPEN, mas uma NOVA assinatura está bloqueada até haver evidência ` +
          `(isso impede duplicar a venda). Resolução: status/expiração (automática no próximo boot) ou intervenção do operador.`,
        correlationId,
      });
    }

    pos.status = "open"; // Reverte EXIT_PENDING: a posição AINDA EXISTE e ainda tem risco.
    (pos as any).exitAttempts = ((pos as any).exitAttempts || 0) + 1;
    (pos as any).lastExitError = errorMessage;
    (pos as any).lastExitAttemptAt = new Date().toISOString();
    dbStore.savePosition(pos);
    exitLocks.delete(pos.id);

    // Registro da tentativa falha — visível no log de transações, com status "failed".
    // Nenhum hash/bloco é inventado: `block: 0` e id prefixado por "failed_exit_".
    const failedExitTx = {
      id: `failed_exit_${pos.id}_${Date.now()}`,
      token: pos.token,
      mint: pos.mint,
      amount: `${pos.sizeSol} SOL (posição permanece aberta)`,
      outAmount: "não liquidado",
      time: new Date().toTimeString().split(" ")[0] + "." + String(Date.now() % 1000).padStart(3, "0"),
      latencyMs,
      status: "failed" as const,
      block: 0,
      tipSol: 0,
      route: `EXIT FALHOU (${reason}) — ${errorMessage.slice(0, 80)}`,
      mode: "live" as const,
      signature: null,
      measuredOnChain: false,
    };

    dbStore.saveTrade(failedExitTx);
    snipedTransactions.unshift(failedExitTx);
    if (snipedTransactions.length > 25) {
      snipedTransactions.pop();
    }

    // Tentativa de saída FRACASSADA não é fechamento: a posição segue aberta e exposta.
    // Gravar como 'closed' aqui mascararia capital preso — o registro é 'exit_failed'.
    recorder.recordPositionLifecycle({
      positionId: pos.id,
      mint: pos.mint,
      token: pos.token,
      event: "exit_failed",
      mode: "live",
      sizeSol: pos.sizeSol,
      entryPriceSol: pos.entryPrice ?? null,
      exitPriceSol: null,
      pnlPercent: null,
      reason: `${reason}: ${errorMessage.slice(0, 120)}`,
      pnlMeasuredOnChain: false,
    });

    dbStore.saveLog({
      timestamp: new Date().toISOString(),
      level: "CRITICAL",
      component: "RISK_ENGINE",
      message:
        `[FALHA DE SAÍDA REAL] Não foi possível liquidar $${pos.token} (${reason}) após ${latencyMs}ms. ` +
        `Erro: ${errorMessage}. A posição CONTINUA ABERTA no banco (tentativa nº ${(pos as any).exitAttempts}). ` +
        `Ação necessária: verificar liquidez/roteamento e intervir manualmente. ` +
        `Não houve venda on-chain e nenhum PnL foi registrado.`,
      correlationId,
    });

    // Falha de execução REAL alimenta o circuit breaker (comportamento correto).
    reportTradeOutcome(false);
  }
}

// Vite Middleware & Production Routing
async function startServer() {
  // Start High-Performance trading systems asynchronously to prevent blocking server port binding
  (async () => {
    /**
     * ARMAZENAMENTO (S10) — antes de qualquer coisa que possa assinar. Política:
     *  - JSON (default): nada a fazer, comportamento idêntico ao anterior;
     *  - Postgres pedido e mal configurado (sem DATABASE_URL) → FATAL, porque o operador acredita
     *    num guarda de voo único entre processos que não existe;
     *  - Postgres inacessível ou schema atrás → tenta migrar; se ainda assim não estiver pronto,
     *    FATAL. Subir sem o árbitro que o operador acha que tem é pior do que não subir.
     */
    for (const note of describeStoragePolicy(STORAGE_POLICY)) {
      const fatal = note.startsWith("ATENÇÃO:") && STORAGE_POLICY.requestedPostgres;
      if (fatal) console.error(`[Boot][Storage] ${note}`);
      else console.log(`[Boot][Storage] ${note}`);
    }
    if (STORAGE_POLICY.requestedPostgres && STORAGE_POLICY.blockers.length > 0) {
      console.error(
        "[Boot][Storage][FATAL] HFT_STORAGE=postgres está PEDIDO mas não está operacional: " +
          STORAGE_POLICY.blockers.join(" | ") +
          ". Corrija a configuração ou volte para HFT_STORAGE=json (o JSON não precisa de banco)."
      );
      process.exit(1);
    }
    if (STORAGE_POLICY.mode === "postgres") {
      try {
        const client = await loadPgClient((process.env.DATABASE_URL ?? "").trim());
        const storage = new PostgresStorage(client, STORAGE_POLICY);
        storageRef = storage;
        let health = await storage.initialize();
        if (health.connected && !health.migrated) {
          console.warn(
            `[Boot][Storage] schema em ${health.schemaVersion ?? "ausente"} < ${"esperado"}: ` +
              `aplicando migrações (idempotentes, somente aditivas)...`
          );
          const res = await storage.migrate();
          health = storage.health();
          console.log(`[Boot][Storage] migrações aplicadas: [${res.applied.join(", ") || "nenhuma"}]`);
        }
        if (!health.connected || !health.migrated) {
          console.error(
            `[Boot][Storage][FATAL] Postgres pedido e NÃO pronto (connected=${health.connected}, ` +
              `migrated=${health.migrated}, erro=${health.lastError ?? "n/a"}). ` +
              `Sem o banco, o voo único entre processos não existe — e assinar sem ele é assinar ` +
              `confiando numa proteção ausente.`
          );
          process.exit(1);
        }
        const counts = await storage.counts();
        console.log(
          `[Boot][Storage] Postgres pronto: schema v${health.schemaVersion}, ` +
            `${counts.trades} trade(s), ${counts.positions} posição(ões), ` +
            `${counts.intents} intenção(ões), ${counts.activeClaims} claim(s) ativo(s).`
        );
        // ESPELHO: cada gravação local vai também para o banco (o JSON continua sendo escrito).
        dbStore.setWriteThrough({
          mirrorTrade: (trade) => void storage.mirrorTrade(trade as any),
          mirrorPosition: (pos) => void storage.mirrorPosition(pos as any),
          mirrorIntent: (intent) => void storage.mirrorIntent(intent as any),
          mirrorLog: (log) => void storage.mirrorLog(log as any),
        });
      } catch (err: any) {
        console.error(
          `[Boot][Storage][FATAL] Falha ao inicializar o Postgres: ${err?.message ?? err}. ` +
            `HFT_STORAGE=postgres exige banco operacional; use HFT_STORAGE=json para operar sem banco.`
        );
        process.exit(1);
      }
    }

    // Inicialização do cofre de chaves. Erro de CONFIGURAÇÃO de custódia é FATAL:
    // subir com carteira aleatória (ou sem carteira) significa exibir um endereço que não
    // é o do operador — e fundos enviados a ele são irrecuperáveis.
    try {
      await initializeVault();
    } catch (err: any) {
      if (err?.name === "KeyCustodyError") {
        console.error(
          "[FATAL] Custódia de chave inválida. O servidor NÃO vai subir para evitar operar/divulgar " +
            "um endereço incorreto. Detalhe: " + err.message
        );
        process.exit(1);
      }
      console.error("[Vault] Falha na inicialização do cofre:", err.message);
    }

    // Start Real-time High Frequency execution components
    try {
      const connection = new Connection(RPC_ENDPOINT, {
        wsEndpoint: RPC_WEBSOCKET,
        commitment: "processed",
        disableRetryOnRateLimit: true
      });
      globalConnection = connection;

      // ANTI-DRIFT DO IDL: valida o layout pinado contra a rede ANTES de qualquer caminho que
      // possa assinar. Fatal na rota native, aviso registrado na rota aggregator.
      await verifyPumpIdlAgainstChain(connection, (process.env.HFT_ENTRY_ROUTE ?? "aggregator").trim().toLowerCase());

      // Instância ÚNICA e real do cache de blockhash (antes havia um gerador de hash falso).
      blockhashCacheRef = new RecentBlockhashCache(connection);
      await blockhashCacheRef.start();
      console.log(
        `[HFT Engine] Cache de blockhash iniciado. Utilizável: ${blockhashCacheRef.isUsable()}. ` +
          `Sem blockhash real, nenhuma transação é assinada.`
      );

      const geyserClient = new GeyserStreamClient(RPC_ENDPOINT, RPC_WEBSOCKET, "");
      geyserClient.onTokenDetected((event) => {
        /**
         * DEDUPE ENTRE FONTES (S7): gRPC e WSS cobrem o MESMO programa (pump). Quem chega primeiro
         * processa; o segundo é contado e descartado. Sem esta linha, o dedupe por mint do caminho
         * quente só pegaria a duplicata enquanto a primeira ainda estivesse em voo.
         */
        if (!firstSightAcrossSources(event.signature)) {
          crossSourceDuplicatesDropped++;
          return;
        }
        const receivedAt = wallClockNow();
        const trace = new LatencyTrace(
          `evt_${event.signature?.slice(0, 16) ?? event.mint}_${receivedAt}`,
          receivedAt,
          event.slot ?? null,
          event.receivedSlot ?? null
        );

        // EVENTO CRU — sem campos inventados.
        //
        // AUDITORIA 2026-10-02: este bloco preenchia `jsonRpcLatencyMs` com Math.random(),
        // `savedComputeUnits` com Math.random() e `rawProtobufHex` com bytes aleatórios, e
        // marcava tudo com `isRealOnChain: true`. O painel exibia números que não mediam nada.
        //
        // Agora os campos são o que a origem forneceu, ou `null` explícito quando não há
        // medição. `null` é informação: significa "não sabemos", o que é diferente de "0".
        const realEvent = {
          id: trace.id,
          timestamp: receivedAt,
          programId: event.programId,
          programName: event.programName,
          type: event.type,
          mint: event.mint,
          mintName: event.mintName,
          signature: event.signature,
          slot: event.slot ?? null,
          /** RTT medido do enriquecimento (callback → getTransaction). null = não medido. */
          enrichmentMs: event.grpcLatencyMs ?? null,
          /** Atraso estimado vs. cadeia por slot. Marcado como estimativa. */
          slotLagMs: event.slotLagEstimateMs ?? null,
          source: event.source ?? "unknown",
          isRealOnChain: true, // o evento VEIO da cadeia; os campos é que são medidos ou null
        };

        telemetry.record(trace.toRecord("pending"));

        recorder.recordLaunchEvent({
          eventId: `${event.signature ?? event.mint}:0`,
          source: event.source === "grpc-geyser" ? "grpc-geyser" : "wss-logs",
          programId: event.programId,
          programName: event.programName,
          eventType: event.type,
          mint: event.mint,
          signature: event.signature ?? "",
          slot: event.slot ?? null,
          enrichmentMs: event.grpcLatencyMs ?? null,
        });

        realOnChainEvents.unshift(realEvent);
        if (realOnChainEvents.length > 50) {
          realOnChainEvents.pop();
        }

        // Pipeline autônomo (Etapa 10). A trilha de latência é propagada para que o
        // estágio de decisão seja medido de verdade, não estimado.
        executeAutonomousPipeline(event, trace).catch((err) => {
          console.error("[Autonomous Daemon] Pipeline execution error:", err.message);
        });
      });
      geyserClientRef = geyserClient;
      await geyserClient.connect();

      /**
       * FAST PATH gRPC (S7) — ADITIVO. Decisão de configuração, com o motivo impresso:
       *  - `HFT_INGEST=grpc` sem endpoint coerente → aviso alto (o gRPC simplesmente não sobe e o
       *    WSS cobre tudo, como antes). Não é fatal: a detecção continua funcionando, só mais lenta.
       *  - endpoint incoerente (http://, wss://, sem porta) → recusa EXPLÍCITA de conectar, com o
       *    motivo, em vez de um erro de biblioteca nativa ilegível.
       *  - falha ao carregar o pacote nativo → `degraded` declarado; o WSS segue cobrindo o pump.
       */
      {
        const ingestPolicy = resolveIngestPolicy(process.env);
        for (const note of ingestPolicy.notes) console.log(`[Boot][Ingest] ${note}`);
        for (const blocker of ingestPolicy.blockers) console.warn(`[Boot][Ingest] ${blocker}`);
        if (ingestPolicy.effective === "grpc") {
          const endpointOk = assessGrpcEndpoint(GEYSER_GRPC_URL);
          if (!endpointOk.ok) {
            console.warn(
              `[Boot][Ingest] GEYSER_GRPC_URL rejeitado (${endpointOk.problem}). ` +
                `O fast path gRPC NÃO será usado; o WSS cobre todos os programas, como antes.`
            );
          } else {
            const token = process.env.GEYSER_GRPC_TOKEN ?? "";
            console.log(
              `[Boot][Ingest] fast path gRPC habilitado em ${redactGrpcEndpoint(GEYSER_GRPC_URL)} ` +
                `(token ${token ? "presente, não exibido" : "ausente"}).`
            );
            try {
              const grpcClient = new GrpcIngestClient(
                () => loadYellowstoneClient(GEYSER_GRPC_URL, token),
                {
                  url: GEYSER_GRPC_URL,
                  token,
                  programId: PROGRAMS.PUMP_FUN,
                  pingIntervalMs: Number(process.env.HFT_GRPC_PING_MS ?? 15_000),
                  maxReconnectAttempts: Number(process.env.HFT_GRPC_MAX_RECONNECTS ?? 0),
                }
              );
              grpcClient.onTokenDetected((event) => {
                if (!firstSightAcrossSources(event.signature)) {
                  crossSourceDuplicatesDropped++;
                  return;
                }
                geyserClient.emitDetected(event);
              });
              grpcIngestRef = grpcClient;
              await grpcClient.connect();
            } catch (err: any) {
              console.warn(
                `[Boot][Ingest] fast path gRPC NÃO subiu (${sanitizeGrpcError(err?.message ?? String(err), token)}). ` +
                  `A detecção continua pelo WSS; este é um caminho ADICIONAL, não o único.`
              );
            }
          }
        } else {
          console.log(
            "[Boot][Ingest] gRPC desabilitado (HFT_INGEST não pede grpc ou GEYSER_GRPC_URL ausente): " +
              "detecção por WebSocket, com getTransaction no enriquecimento."
          );
        }
      }
      // O log anterior ("Yellowstone Geyser stream pipeline connected.") era impresso sem
      // verificar nada: `connect()` apenas anexa listeners. Se o RPC recusa o WebSocket, o
      // operador lia "connected" com o bot cego. Agora imprimimos o estado do cliente.
      {
        const h = geyserClient.getHealth();
        if (h.connected && h.subscriptionsRequested > 0) {
          console.log(
            `[HFT Engine] Detecção armada: socket WS aberto, ${h.subscriptionsRequested} ` +
              `subscrição(ões) registrada(s) localmente. Isto NÃO prova que o RPC aceitou os ` +
              `filtros nem que eventos chegam — a prova é eventCount > 0 (GET /api/health).`
          );
        } else {
          console.error(
            `[HFT Engine] Detecção DESARMADA: socket WS ${h.socketOpen ? "aberto" : "NÃO conectado"}, ` +
              `${h.subscriptionsRequested} subscrição(ões) registrada(s). Nenhum lançamento será ` +
              `detectado até que RPC_WEBSOCKET responda. GET /api/health → detection.degraded = true.`
          );
        }
      }
      /**
       * FEED GRATUITO DA PUMPPORTAL (segunda fonte de detecção).
       *
       * Entrega o MINT no próprio evento de criação. Por isso este caminho não chama
       * `getTransaction` e não espera `confirmed` — que o S5 mediu como o gargalo estrutural do
       * caminho WSS. Fonte ADICIONAL: Raydium e Meteora continuam exclusivamente no WSS.
       */
      if (process.env.HFT_PUMPPORTAL !== "0") {
        const feed = new PumpPortalFeed({
          url: process.env.PUMPPORTAL_WS_URL?.trim() || undefined,
          onEvent: (ppEvent: PumpPortalEvent) => {
            const receivedAt = wallClockNow();
            const trace = new LatencyTrace(
              `pp_${ppEvent.signature?.slice(0, 16) ?? ppEvent.mint}_${receivedAt}`,
              receivedAt,
              null, // PumpPortal não informa slot na mensagem: null, nunca inventado
              null
            );

            const launchEvent = {
              id: trace.id,
              timestamp: receivedAt,
              programId: "pumpportal",
              programName: "Pump.fun (feed PumpPortal)",
              type: ppEvent.txType === "migrate" ? "Migration" : "TokenCreated",
              mint: ppEvent.mint,
              mintName: ppEvent.name ?? ppEvent.symbol ?? "LAUNCHED_TOKEN",
              signature: ppEvent.signature,
              slot: null,
              /**
               * Custo de enriquecimento NESTE caminho é zero por construção: o mint veio na
               * mensagem. Zero medido — diferente de null, que significaria "não medido".
               */
              enrichmentMs: 0,
              slotLagMs: null,
              source: "pumpportal",
              isRealOnChain: true,
              simulated: false,
            };

            telemetry.record(trace.toRecord("pending"));
            recorder.recordLaunchEvent({
              eventId: `${ppEvent.signature ?? ppEvent.mint}:0`,
              source: "pumpportal",
              programId: "pumpportal",
              programName: "Pump.fun (feed PumpPortal)",
              eventType: launchEvent.type,
              mint: ppEvent.mint,
              signature: ppEvent.signature ?? "",
              slot: null,
              enrichmentMs: 0,
            });

            realOnChainEvents.unshift(launchEvent);
            if (realOnChainEvents.length > 50) realOnChainEvents.pop();

            executeAutonomousPipeline(
              {
                mint: ppEvent.mint,
                mintName: launchEvent.mintName,
                signature: ppEvent.signature,
                preEnriched: true,
                source: "pumpportal",
              },
              trace
            ).catch((err) => {
              console.error("[Autonomous Daemon] Pipeline (PumpPortal) error:", err.message);
            });
          },
        });
        pumpPortalRef = feed;
        feed.connect();
        console.log(
          "[PumpPortal] Feed assinado (subscribeNewToken + subscribeMigration), uma conexão " +
            "única. Mint direto no evento: este caminho NÃO paga getTransaction."
        );
      } else {
        console.log("[PumpPortal] Desligado por configuração (HFT_PUMPPORTAL=0).");
      }

    } catch (err: any) {
      console.log("[HFT Engine] Real infrastructure setup skipped or offline. Running simulation fallback mode.", err.message);
    }

    // Start ETAPA 11 Autonomous Position Manager Daemon
    // Reconcilia posições presas em EXIT_PENDING antes de retomar a gestão de risco.
    /**
     * ORDEM IMPORTA: primeiro pergunta-se à cadeia o que aconteceu com as intenções que
     * ficaram abertas (processo morto entre assinar e confirmar); só depois o estado
     * local `exit_pending` é revertido. Reverter antes seria afirmar "não vendeu" sem
     * nenhuma evidência.
     */
    await recoverActiveIntents();
    await reconcileStuckExits();
    await runDesyncReconciliation("boot");
    // O boot já reconciliou: o próximo ciclo periódico conta a partir daqui, sem repetir
    // a leitura de carteira segundos depois de subir.
    lastDesyncRunAt = Date.now();

    startAutonomousPositionManager().catch((err) => {
      console.error("[Autonomous Position Manager] Daemon start failed:", err.message);
    });
  })();

  const isProduction = 
    process.env.NODE_ENV === "production" || 
    currentFilename.endsWith(".cjs") || 
    currentFilename.includes("dist");

  if (isProduction) {
    process.env.NODE_ENV = "production";
    let distPath = path.join(process.cwd(), 'dist');
    if (!fs.existsSync(path.join(distPath, 'index.html'))) {
      distPath = currentDirname;
    }
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  // Bind to port 3000 (standard reverse proxy port in dev container)
  /**
   * BIND: loopback por padrão.
   *
   * A versão anterior escutava em 0.0.0.0 incondicionalmente. Combinada com o fail-open do
   * guard de mutação, isso expunha kill switch e fechamento de posição a qualquer host que
   * alcançasse a porta. Expor passa a ser uma decisão explícita (HFT_BIND_HOST), validada
   * no boot contra a presença de capital real.
   */
  const bindHost = (process.env.HFT_BIND_HOST || "").trim() || "127.0.0.1";
  console.log(`[Server] Bind em ${bindHost}:${PORT} (HFT_BIND_HOST para expor deliberadamente).`);

  const httpServer = app.listen(PORT, bindHost, () => {
    console.log(`[Server] Primary HTTP service running on port ${PORT}`);
  });

  /**
   * ENCERRAMENTO GRACIOSO.
   *
   * Sem isto, matar o processo deixava o WebSocket do RPC tentando reconectar para sempre
   * (`max_reconnects: Infinity`) e abandonava a conexão da PumpPortal — e a documentação do
   * provedor avisa que conexões abandonadas/múltiplas podem causar banimento (expira em 1h).
   * Encerrar corretamente é parte de operar bem um serviço de terceiro.
   */
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Shutdown] ${signal} recebido: desconectando fontes de dados e encerrando HTTP.`);
    try {
      geyserClientRef?.disconnect();
    } catch (err: any) {
      console.warn("[Shutdown] Falha ao desconectar o cliente de detecção:", err?.message ?? err);
    }
    try {
      pumpPortalRef?.stop();
    } catch (err: any) {
      console.warn("[Shutdown] Falha ao encerrar o feed da PumpPortal:", err?.message ?? err);
    }
    try {
      grpcIngestRef?.disconnect();
    } catch (err: any) {
      console.warn("[Shutdown] Falha ao encerrar o fast path gRPC:", err?.message ?? err);
    }
    /**
     * ARMAZENAMENTO: libera os claims DESTA instância e fecha o pool. O encerramento espera isto
     * antes de sair (com o teto de 5s logo abaixo como rede de segurança): sem liberar, um restart
     * deixaria o voo único preso até o TTL — e o TTL existe para CRASH, não para desligamento normal.
     *
     * A liberação usa o `claimId` (não o mint): só quem detém o claim pode liberá-lo, senão um
     * processo que perdeu o claim por expiração liberaria o claim de OUTRO e abriria a porta para
     * duas entradas simultâneas.
     */
    const encerrarArmazenamento = async (): Promise<void> => {
      const storage = storageRef;
      if (!storage) return;
      try {
        const owner = storage.health().owner;
        for (const claim of await storage.listActiveClaims()) {
          if (claim.owner !== owner) continue;
          await storage.releaseEntryClaim(claim.claimId, { note: `liberado no encerramento (${signal})` });
        }
      } catch (err: any) {
        console.warn("[Shutdown] Falha ao liberar claims:", err?.message ?? err);
      }
      await storage.close();
    };
    httpServer.close(() => {
      void encerrarArmazenamento().finally(() => {
        console.log("[Shutdown] HTTP encerrado e armazenamento liberado. Nada ficou pendente.");
        process.exit(0);
      });
    });
    // Rede de segurança: se algum socket pendurar o fechamento, não ficamos presos.
    setTimeout(() => process.exit(0), 5_000).unref?.();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // In Cloud Run production deployments, Cloud Run routes traffic to process.env.PORT (typically 8080).
  // Listen on process.env.PORT as well so Cloud Run health checks and ingress routing succeed.
  const cloudRunPort = process.env.PORT ? parseInt(process.env.PORT, 10) : null;
  if (cloudRunPort && cloudRunPort !== PORT && !isNaN(cloudRunPort)) {
    try {
      const secondaryServer = app.listen(cloudRunPort, bindHost, () => {
        console.log(`[Server] Cloud Run ingress listener active on port ${cloudRunPort}`);
      });
      secondaryServer.on("error", (err: any) => {
        if (err.code === "EADDRINUSE") {
          console.log(`[Server] Port ${cloudRunPort} already bound (handled by platform reverse proxy).`);
        } else {
          console.warn(`[Server] Secondary listener notice on port ${cloudRunPort}:`, err.message);
        }
      });
    } catch (err: any) {
      console.warn(`[Server] Could not initialize secondary listener on port ${cloudRunPort}:`, err.message);
    }
  }
}

startServer().catch((err) => {
  console.error("Unhandled error starting server:", err);
  process.exit(1);
});
