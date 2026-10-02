import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  TransactionInstruction
} from "@solana/web3.js";
import dotenv from "dotenv";
import {
  DISCRIMINATORS,
  JITO_TIP_ACCOUNTS_FALLBACK,
  PROGRAMS,
  discriminatorToBytes,
  jitoBlockEngineUrl,
  jitoHeaders,
  jupiterBaseUrl,
  jupiterHeaders,
  isValidPubkey,
  type JitoRegion
} from "./solanaConfig.js";
import {
  MAX_BUNDLE_IDS_PER_REQUEST,
  JITO_MIN_REQUEST_INTERVAL_MS,
  isPlausibleBundleId,
  parseBundleStatuses,
  parseInflightStatuses,
  type BundleStatusEntry,
  type InflightStatusEntry,
  type JitoStatusQueryResult,
} from "./jitoStatus.js";
import { BASE_FEE_LAMPORTS, clampTipSol, type CostBreakdown, emptyCosts } from "./accounting.js";
import { assertCanSign, type OperationPurpose } from "./runtimeMode.js";

dotenv.config();

/**
 * NOTA DE AUDITORIA (2026-10-02)
 * ------------------------------
 * Este arquivo continha 4 classes de defeito crítico, todos corrigidos abaixo:
 *
 *  [C1] Tip accounts do Jito FABRICADOS. Os endereços hardcoded
 *       ("Cw8CFBTGowau99vVnKAhZAsfS6D1g6A7B2Xz11G1Zabz", etc.) não existem.
 *       Enviar SOL para eles = perda permanente do tip. Corrigido: getTipAccounts()
 *       em runtime + lista oficial como fallback, validada estruturalmente.
 *
 *  [C2] Program ID da Raydium FABRICADO
 *       ("675k1g2EPJ8gS7q9yGP8REukXXhxZ9ReM78D4cifFGL"). O correto é
 *       675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8. Consequência: a subscription
 *       de detecção de novos pools NUNCA recebia evento real.
 *
 *  [C3] Blockhash de fallback FABRICADO ("5EgS1mEB..."). Usar blockhash inexistente
 *       faz a transação ser rejeitada por todos os líderes. Agora: sem blockhash
 *       válido, o sistema FALHA explicitamente em vez de inventar.
 *
 *  [C4] Instruções nativas montadas com discriminador errado e lista de contas
 *       inventada (pump.fun buy). Agora: parsing usa o discriminador correto
 *       (verificado contra o IDL oficial) e os builders nativos se RECUSAM a montar
 *       instruções que não podem ser verificadas. Recusar é melhor que enviar lixo.
 */

// Monkey-patch @solana/web3.js Connection.prototype._wsOnError para interceptar e
// suprimir rate-limit (HTTP 429) de endpoints públicos, evitando tempestade de reconexão.
// MANTIDO da versão original (evita reconnect storm), mas agora acompanhado de
// health-check explícito em GeyserStreamClient.getHealth(), porque suprimir reconexão
// sem monitorar significa WebSocket morto em silêncio.
const originalWsOnError = (Connection.prototype as any)._wsOnError;
const originalWsOnOpen = (Connection.prototype as any)._wsOnOpen;

/** Intervalo base de reconexão do cliente WS (o mesmo default do web3.js/rpc-websockets). */
export const WS_BASE_RECONNECT_MS = 1_000;
/** Teto do backoff. Um minuto entre tentativas é agressivo o bastante para não derrubar a cota. */
export const WS_MAX_RECONNECT_MS = 60_000;
/** Silêncio mínimo entre linhas de log da MESMA falha (evita inundação de log). */
const WS_LOG_THROTTLE_MS = 30_000;

/**
 * Atraso da próxima reconexão após `consecutive` falhas consecutivas.
 *
 * EXPORTADO e determinístico de propósito: é uma decisão operacional (quantas tentativas por
 * minuto o seu provedor de RPC recebe) e precisa ser testável sem rede.
 *
 * Sem jitter porque este processo mantém UMA conexão WS (os quatro programas de lançamento
 * compartilham o mesmo socket). Jitter existe para descorrelacionar MUITOS clientes; aqui ele
 * só tornaria o comportamento não determinístico. Se um dia houver N conexões, somar jitter
 * passa a ser necessário.
 */
export function wsBackoffDelayMs(consecutive: number): number {
  if (consecutive <= 1) return WS_BASE_RECONNECT_MS;
  // 1s → 2s → 4s → 8s → 16s → 32s → 60s (teto)
  const exp = Math.min(consecutive - 1, 6);
  return Math.min(WS_BASE_RECONNECT_MS * 2 ** exp, WS_MAX_RECONNECT_MS);
}

interface WsFailureState {
  consecutive: number;
  lastLogAt: number;
}

const wsFailureStates = new WeakMap<object, WsFailureState>();

function isRateLimitMessage(msg: string): boolean {
  return msg.includes("429") || msg.includes("Unexpected server response: 429") || msg.includes("Too Many Requests");
}

if (typeof originalWsOnError === "function") {
  (Connection.prototype as any)._wsOnError = function (err: any) {
    this._rpcWebSocketConnected = false;

    const ws = this._rpcWebSocket;
    const msg = err?.message || String(err || "");

    // Rate limit (HTTP 429): NÃO reconectar. Insistir em 429 é o caminho mais rápido para o
    // provedor bloquear a chave. O failover de RPC (camada HTTP) decide o próximo host.
    if (isRateLimitMessage(msg)) {
      console.warn(
        `[Solana RPC WS] Endpoint rate-limited (HTTP 429). Reconexão WS suspensa neste host ` +
          `para não amplificar o bloqueio; o failover HTTP assume.`
      );
      if (ws) {
        ws.reconnect = false;
        if (ws.reconnect_timer_id) {
          clearTimeout(ws.reconnect_timer_id);
          ws.reconnect_timer_id = undefined;
        }
      }
      return;
    }

    const state = wsFailureStates.get(this) ?? { consecutive: 0, lastLogAt: 0 };
    state.consecutive++;
    wsFailureStates.set(this, state);

    /**
     * BACKOFF PROGRESSIVO — correção de auditoria (2026-10-02).
     *
     * MEDIDO: com `max_reconnects: Infinity` e `reconnect_interval: 1000` (defaults internos do
     * web3.js 1.98.4 / rpc-websockets 9.3.9), uma conexão que nunca abre tentava reconectar
     * **1x por segundo, para sempre** — 20 falhas em 20 s no teste com host inacessível. Isso
     * gera 3600 tentativas TLS/hora contra o provedor (caminho direto para rate-limit/ban) e
     * enche o log até o operador parar de ler. Agora o intervalo cresce 1s → 2s → 4s … 60s e
     * volta ao base no primeiro `open`.
     */
    const delay = wsBackoffDelayMs(state.consecutive);
    if (ws && typeof ws.setReconnectInterval === "function") {
      ws.setReconnectInterval(delay);
    }

    const now = Date.now();
    if (state.consecutive === 1 || now - state.lastLogAt > WS_LOG_THROTTLE_MS) {
      state.lastLogAt = now;
      // Não chamamos o handler original: ele imprime `ws error:` a CADA tentativa. Reproduzimos
      // apenas o efeito de estado (`_rpcWebSocketConnected = false`, já feito acima) e logamos
      // uma linha informativa, com o número de falhas e o próximo atraso.
      console.warn(
        `[Solana RPC WS] Falha de conexão (${state.consecutive}ª consecutiva): ${msg}. ` +
          `Próxima tentativa em ${delay}ms (backoff progressivo; teto ${WS_MAX_RECONNECT_MS}ms). ` +
          `Detecção de lançamentos está DEGRADADA enquanto isso.`
      );
    }
  };
}

if (typeof originalWsOnOpen === "function") {
  (Connection.prototype as any)._wsOnOpen = function () {
    const state = wsFailureStates.get(this);
    if (state && state.consecutive > 0) {
      console.log(`[Solana RPC WS] Conexão restabelecida após ${state.consecutive} falha(s) consecutiva(s).`);
      wsFailureStates.set(this, { consecutive: 0, lastLogAt: 0 });
      const ws = this._rpcWebSocket;
      if (ws && typeof ws.setReconnectInterval === "function") {
        ws.setReconnectInterval(WS_BASE_RECONNECT_MS);
      }
    }
    return originalWsOnOpen.call(this);
  };
}

// Load environment variables with fallback.
// ATENÇÃO: api.mainnet-beta.solana.com NÃO é um endpoint operacional para trading.
// É rate-limited agressivamente e não oferece garantia de envio. Use RPC pago.
export const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
export const RPC_WEBSOCKET = process.env.RPC_WEBSOCKET || "wss://api.mainnet-beta.solana.com";
export const GEYSER_GRPC_URL = process.env.GEYSER_GRPC_URL || "";
export const OPERATIONAL_PRIVATE_KEY = process.env.OPERATIONAL_PRIVATE_KEY || "";

const DEFAULT_JITO_REGION: JitoRegion = (process.env.JITO_REGION as JitoRegion) || "ny";

/**
 * Erro tipado para que o chamador distinga "infraestrutura indisponível" de
 * "operação rejeitada". Sem isso, o código anterior tratava falha de infra como
 * sucesso simulado.
 */
export class InfrastructureError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "InfrastructureError";
  }
}

/* -------------------------------------------------------------------------- */
/* 1. RECENT BLOCKHASH CACHE                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Cache de blockhash com polling em background (~4000ms). Um blockhash da Solana é
 * válido por ~150 blocos (~60-90s), então 4s de cache é seguro e economiza 1 RTT no
 * momento crítico da execução.
 *
 * CORREÇÃO [C3]: em caso de falha, NÃO inventamos um blockhash. Marcamos o cache como
 * indisponível. O chamador deve falhar explicitamente.
 */
export class RecentBlockhashCache {
  private connection: Connection;
  private currentBlockhash: string = "";
  private lastValidBlockHeight: number = 0;
  private lastSuccessAt: number = 0;
  private consecutiveFailures: number = 0;
  private lastError: string | null = null;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  public async start(): Promise<void> {
    await this.update();
    this.intervalId = setInterval(() => {
      void this.update();
    }, 4000);
  }

  public stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
  }

  private async update(): Promise<void> {
    try {
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("processed");
      if (!blockhash || !isValidBase58Blockhash(blockhash)) {
        throw new Error(`RPC retornou blockhash estruturalmente inválido: "${blockhash}"`);
      }
      this.currentBlockhash = blockhash;
      this.lastValidBlockHeight = lastValidBlockHeight;
      this.lastSuccessAt = Date.now();
      this.consecutiveFailures = 0;
      this.lastError = null;
    } catch (err: any) {
      this.consecutiveFailures++;
      const message = err?.message || String(err);
      this.lastError = message;
      const isRateLimit = message.includes("429");
      const ageMs = this.ageMs();
      const ageLabel = Number.isFinite(ageMs) ? `${Math.round(ageMs / 1000)}s` : "nenhum (nunca obtido)";

      // Throttle de log: um RPC fora do ar geraria uma linha a cada 4s para sempre,
      // poluindo o log operacional onde os eventos de risco precisam ser visíveis.
      const shouldLog =
        this.consecutiveFailures <= 5 ||
        this.consecutiveFailures % 15 === 0;

      if (shouldLog) {
        console.warn(
          `[BlockhashCache] Falha ao atualizar blockhash (tentativa ${this.consecutiveFailures}${isRateLimit ? ", rate-limit" : ""}). ` +
            `Último blockhash conhecido: ${ageLabel}. Motivo: ${message}`
        );
      }
      // NÃO inventamos blockhash. O cache apenas envelhece e é invalidado por idade.
      if (this.ageMs() > BLOCKHASH_MAX_AGE_MS) {
        this.currentBlockhash = "";
        this.lastValidBlockHeight = 0;
      }
    }
  }

  public ageMs(): number {
    return this.lastSuccessAt ? Date.now() - this.lastSuccessAt : Number.POSITIVE_INFINITY;
  }

  /** Retorna o blockhash apenas se ele ainda é utilizável. Caso contrário, string vazia. */
  public get(): { blockhash: string; lastValidBlockHeight: number } {
    if (!this.isUsable()) return { blockhash: "", lastValidBlockHeight: 0 };
    return { blockhash: this.currentBlockhash, lastValidBlockHeight: this.lastValidBlockHeight };
  }

  public isUsable(): boolean {
    return this.currentBlockhash.length > 0 && this.ageMs() < BLOCKHASH_MAX_AGE_MS;
  }

  /**
   * Busca um blockhash fresco direto do RPC, com fallback para o cache.
   * Prefira esta função no caminho de execução: 1 RTT antecipado é melhor do que
   * assinar com blockhash prestes a expirar.
   */
  public async getFresh(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    try {
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("processed");
      if (!isValidBase58Blockhash(blockhash)) {
        throw new Error(`Blockhash estruturalmente inválido: "${blockhash}"`);
      }
      this.currentBlockhash = blockhash;
      this.lastValidBlockHeight = lastValidBlockHeight;
      this.lastSuccessAt = Date.now();
      this.consecutiveFailures = 0;
      return { blockhash, lastValidBlockHeight };
    } catch (err: any) {
      this.consecutiveFailures++;
      this.lastError = err?.message || String(err);
      const cached = this.get();
      if (cached.blockhash) return cached;
      throw new InfrastructureError(
        `Sem blockhash válido disponível. Nenhuma transação pode ser assinada. Último erro: ${this.lastError}`,
        "BLOCKHASH_UNAVAILABLE"
      );
    }
  }

  public getStatus() {
    return {
      usable: this.isUsable(),
      ageMs: this.ageMs(),
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
    };
  }
}

/** Blockhash válido é base58 de 32 bytes. Não aceitamos strings "plausíveis". */
export function isValidBase58Blockhash(blockhash: string): boolean {
  return isValidPubkey(blockhash);
}

/** 150 slots * ~400ms = 60s. Na prática usamos margem: 45s. */
export const BLOCKHASH_MAX_AGE_MS = 45_000;

/* -------------------------------------------------------------------------- */
/* 2. GEYSER / WEBSOCKET INGRESS + HEALTH                                       */
/* -------------------------------------------------------------------------- */

export interface LaunchEvent {
  programId: string;
  programName: string;
  type: string;
  mint: string;
  mintName: string;
  signature: string;
  slot: number | null;
  /** Slot local no momento da emissão — permite estimar atraso relativo à cadeia. */
  receivedSlot: number | null;
  /**
   * Estimativa de atraso em relação à cadeia: (slot_local - slot_evento) * 400ms.
   * É ESTIMATIVA, não medição direta. `null` quando um dos slots é desconhecido.
   */
  slotLagEstimateMs: number | null;
  /** Latência do enriquecimento (callback → getTransaction), em ms, MEDIDA. */
  grpcLatencyMs: number | null;
  detectedAt: number;
  source: "grpc-geyser" | "wss-logs";
}

export class GeyserStreamClient {
  private rpcUrl: string;
  private wsUrl: string;
  private grpcUrl: string;
  private connection: Connection;
  private callback: ((event: LaunchEvent) => void) | null = null;
  private activeSubscriptions: number[] = [];
  private lastEventAt: number = 0;
  private eventCount: number = 0;
  private subscriptionErrors: string[] = [];
  private connected: boolean = false;

  constructor(rpcUrl: string, wsUrl: string, grpcUrl: string) {
    this.rpcUrl = rpcUrl;
    this.wsUrl = wsUrl;
    this.grpcUrl = grpcUrl;
    this.connection = new Connection(this.rpcUrl, {
      wsEndpoint: this.wsUrl,
      commitment: "processed",
      disableRetryOnRateLimit: true
    });
  }

  public onTokenDetected(callback: (event: LaunchEvent) => void): void {
    this.callback = callback;
  }

  public async connect(): Promise<void> {
    console.log(`[GeyserClient] Handshake de ingresso: gRPC=${this.grpcUrl || "não configurado (usando WSS fallback)"}, RPC=${this.rpcUrl}`);

    if (this.grpcUrl) {
      // Yellowstone gRPC exige cliente protobuf dedicado (@triton-one/yellowstone-grpc
      // ou equivalente). Não simulamos a conexão: declaramos explicitamente que o
      // caminho gRPC não está implementado neste runtime.
      console.warn(
        "[GeyserClient] GEYSER_GRPC_URL configurado, mas o cliente protobuf Yellowstone não está " +
          "implementado neste runtime. Caindo para WebSocket RPC (latência maior). " +
          "Para latência competitiva, implemente o canal gRPC dedicado."
      );
    }
    await this.connectWebsocketFallback();
  }

  /**
   * Ingress via logsSubscribe nos programas de lançamento verificados.
   *
   * CORREÇÃO [C2]: antes a subscription era feita em um program ID fabricado, então
   * nenhum lançamento da Raydium era detectado (falha silenciosa: o log dizia
   * "listeners attached successfully").
   */
  private async connectWebsocketFallback(): Promise<void> {
    console.log("[GeyserClient] Anexando listeners de lançamento via WebSocket RPC...");

    const launchPrograms = [
      { id: PROGRAMS.RAYDIUM_AMM_V4, name: "Raydium AMM v4", hints: ["initialize2", "Initialize2"] },
      { id: PROGRAMS.RAYDIUM_CPMM, name: "Raydium CPMM", hints: ["create_pool", "CreatePool"] },
      { id: PROGRAMS.PUMP_FUN, name: "Pump.fun", hints: ["Instruction: Create", "Instruction: create"] },
      { id: PROGRAMS.METEORA_DLMM, name: "Meteora DLMM", hints: ["initialize_lb_pair", "InitializeLbPair"] },
    ];

    for (const program of launchPrograms) {
      try {
        const programId = new PublicKey(program.id);
        const subId = this.connection.onLogs(
          programId,
          (logs) => {
            if (logs.err) return;
            const matchers = program.hints;
            // Raydium sinaliza o pool via log "initialize2" (o ID do programa não
            // aparece no texto do log, por isso comparamos contra a lista de hints).
            const matched = matchers.some((hint) =>
              logs.logs.some((line) => line.includes(hint))
            );
            if (!matched) return;
            // `Logs` do web3.js não tipa `slot`, mas o objeto entregue pelo RPC o inclui.
            // Acessamos com fallback null: se não vier, a estimativa de atraso fica null
            // em vez de ser inventada.
            const eventSlot = typeof (logs as any).slot === "number" ? (logs as any).slot : null;
            void this.handleLaunch(program.name, program.id, logs.signature, eventSlot);
          },
          "processed"
        );
        this.activeSubscriptions.push(subId);
        console.log(`[GeyserClient]   ✓ ${program.name} (${program.id.slice(0, 8)}...) sub=${subId}`);
      } catch (err: any) {
        const msg = `Falha ao assinar ${program.name} (${program.id}): ${err.message}`;
        this.subscriptionErrors.push(msg);
        console.error(`[GeyserClient]   ✗ ${msg}`);
      }
    }

    this.connected = this.activeSubscriptions.length > 0;
    if (this.connected) {
      console.log(`[GeyserClient] ${this.activeSubscriptions.length} listener(s) ativo(s) em Mainnet.`);
    } else {
      console.error("[GeyserClient] NENHUM listener ativo. Detecção de lançamentos está OFF.");
    }
  }

  /**
   * Confirma o lançamento e extrai o mint do token.
   *
   * As posições de conta usadas aqui são documentadas por Raydium/QuickNode
   * (initialize2: mints nas posições 8 e 9 das contas) — não são adivinhação.
   * Ainda assim, o mint extraído é validado estruturalmente antes de ir ao risk engine.
   */
  private async handleLaunch(
    programName: string,
    programId: string,
    signature: string,
    eventSlot: number | null = null
  ): Promise<void> {
    const detectedAt = Date.now();
    try {
      const tx = await this.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      });
      if (!tx) {
        this.subscriptionErrors.push(`getTransaction retornou null para ${signature}`);
        return;
      }

      const allKeys: string[] = collectAccountKeys(tx.transaction.message, tx.meta?.loadedAddresses);

      const mint = extractLaunchMint(programName, allKeys, tx.meta);
      if (!mint) {
        this.subscriptionErrors.push(`Não foi possível extrair mint de ${signature} (${programName})`);
        return;
      }

      this.lastEventAt = Date.now();
      this.eventCount++;

      // Slot local: usado apenas para ESTIMAR atraso relativo à cadeia. Se a consulta
      // falhar, reportamos null em vez de inventar — um atraso desconhecido é informação
      // melhor do que um atraso errado.
      let receivedSlot: number | null = null;
      try {
        receivedSlot = await this.connection.getSlot("processed");
      } catch {
        receivedSlot = null;
      }

      const slotLagEstimateMs =
        eventSlot !== null && receivedSlot !== null && receivedSlot >= eventSlot
          ? (receivedSlot - eventSlot) * 400 // 400ms = tempo-alvo de slot; ESTIMATIVA
          : null;

      if (this.callback) {
        this.callback({
          programId,
          programName,
          type: "PoolCreated",
          mint,
          mintName: mint.slice(0, 6).toUpperCase(),
          signature,
          slot: eventSlot,
          receivedSlot,
          slotLagEstimateMs,
          // MEDIDO: tempo entre o callback do listener e o getTransaction concluído.
          grpcLatencyMs: Date.now() - detectedAt,
          detectedAt,
          source: "wss-logs",
        });
      }
    } catch (err: any) {
      this.subscriptionErrors.push(`Erro ao processar ${signature}: ${err.message}`);
    }
  }

  /**
   * Health-check explícito de ingestão. Sem isso, a supressão de reconexão do
   * WebSocket pode deixar o listener morto por horas sem que ninguém perceba.
   */
  /**
   * Estado REAL da detecção.
   *
   * CORREÇÃO 2026-10-02: `connected` era `activeSubscriptions.length > 0`, e esse número é
   * atribuído **localmente** pelo web3.js no momento em que `onLogs()` é chamado — antes de o
   * socket abrir e sem nenhuma confirmação do RPC. Ou seja: o painel exibia "connected" com o
   * WebSocket inoperante. Aqui passamos a ler o bit de conexão do próprio cliente
   * (`_rpcWebSocketConnected`, setado em `_wsOnOpen` e limpo em erro/close) e a declarar a
   * diferença entre "subscrição pedida" e "evento recebido".
   *
   * Limitação declarada: nem `_rpcWebSocketConnected` nem a lista de subscrições provam que o
   * RPC ACEITOU o filtro. A única prova é `eventCount` crescer.
   */
  public getHealth() {
    const sinceLastEventMs = this.lastEventAt ? Date.now() - this.lastEventAt : null;
    const socketOpen = (this.connection as any)._rpcWebSocketConnected === true;
    return {
      /** Socket WS de fato conectado (não confundir com "subscrições pedidas"). */
      socketOpen,
      connected: socketOpen && this.activeSubscriptions.length > 0,
      /** IDs de subscrição atribuídos LOCALMENTE — não são confirmação do RPC. */
      subscriptionsRequested: this.activeSubscriptions.length,
      subscriptions: this.activeSubscriptions.length,
      /** Prova de que a detecção funciona: eventos recebidos. 0 = nenhum lançamento visto. */
      eventCount: this.eventCount,
      lastEventAt: this.lastEventAt || null,
      sinceLastEventMs,
      degraded: !socketOpen || this.activeSubscriptions.length === 0,
      note:
        "socketOpen=true significa socket estabelecido. subscriptionsRequested NÃO é confirmação " +
        "do RPC. A prova de detecção é eventCount > 0.",
      recentErrors: this.subscriptionErrors.slice(-5),
    };
  }

  /**
   * Encerra a detecção.
   *
   * CORREÇÃO 2026-10-02: a versão anterior só removia os listeners. O cliente WS interno do
   * web3.js continua com `reconnect: true` e `max_reconnects: Infinity`, isto é, segue tentando
   * reconectar para sempre — o processo não consegue encerrar (event loop preso) e um shutdown
   * gracioso vira uma tempestade de reconexão. Aqui desligamos o auto-reconectar ANTES de
   * fechar o socket.
   */
  public disconnect(): void {
    this.activeSubscriptions.forEach((sub) => {
      try {
        this.connection.removeOnLogsListener(sub);
      } catch {
        /* ignora */
      }
    });
    this.activeSubscriptions = [];

    const ws = (this.connection as any)._rpcWebSocket;
    if (ws) {
      try {
        if (typeof ws.setAutoReconnect === "function") ws.setAutoReconnect(false);
        if (ws.reconnect_timer_id) {
          clearTimeout(ws.reconnect_timer_id);
          ws.reconnect_timer_id = undefined;
        }
        if (typeof ws.close === "function") ws.close();
      } catch {
        /* encerramento best-effort: nunca lançar de dentro de cleanup */
      }
    }

    this.connected = false;
  }
}

/**
 * Coleta todas as chaves de conta de uma transação (estáticas + endereços carregados
 * via Address Lookup Table). Sem isto, transações versionadas de DEX aparecem truncadas
 * e o mint não é encontrado.
 */
function collectAccountKeys(
  message: any,
  loadedAddresses?: { writable?: PublicKey[]; readonly?: PublicKey[] } | null
): string[] {
  if (typeof message.getAccountKeys === "function") {
    const keys = message.getAccountKeys({ accountKeysFromLookups: loadedAddresses ?? undefined });
    const out: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys.get(i);
      if (k) out.push(k.toBase58());
    }
    return out;
  }
  return (message.staticAccountKeys || []).map((k: PublicKey) => k.toBase58());
}

/**
 * Extrai o mint do token a partir das contas da transação de lançamento.
 *
 * Estratégia conservadora e verificável:
 *   1. Filtra candidatos: pubkey válido, não é programa conhecido, não é WSOL, e
 *      (quando disponível) possui token account associada na transação.
 *   2. Raydium AMM v4 initialize2: mints nas posições 8 e 9 (documentado).
 *   3. Fallback: primeira conta cujo owner (via meta.postTokenBalances) é o Token Program.
 *
 * Retorna null quando não há evidência suficiente. NUNCA inventa um mint.
 */
export function extractLaunchMint(
  programName: string,
  accountKeys: string[],
  meta: { postTokenBalances?: Array<{ mint?: string | null }> | null } | null | undefined
): string | null {
  const excluded = new Set<string>([
    PROGRAMS.TOKEN_PROGRAM,
    PROGRAMS.TOKEN_2022_PROGRAM,
    PROGRAMS.RAYDIUM_AMM_V4,
    PROGRAMS.RAYDIUM_CPMM,
    PROGRAMS.PUMP_FUN,
    PROGRAMS.PUMP_SWAP_AMM,
    PROGRAMS.METEORA_DLMM,
    PROGRAMS.ASSOCIATED_TOKEN_PROGRAM,
    PROGRAMS.SYSTEM_PROGRAM,
    "So11111111111111111111111111111111111111112", // WSOL
  ]);

  // Sinal mais confiável: os mints que aparecem em postTokenBalances são tokens reais
  // da transação (owner = Token Program), não PDAs ou contas de sistema.
  const mintsFromBalances = new Set(
    (meta?.postTokenBalances || []).map((b) => b.mint).filter((m): m is string => Boolean(m))
  );

  const isCandidate = (key: string) =>
    isValidPubkey(key) && !excluded.has(key) && !key.startsWith("ComputeBudget") && !key.startsWith("Sysvar");

  if (mintsFromBalances.size > 0) {
    // Preferimos um mint que tenha saldo token na transação (evita confundir com
    // o mint de um token já existente que só foi movimentado).
    const ordered = accountKeys.filter((k) => mintsFromBalances.has(k) && isCandidate(k));
    const nonWsol = ordered.filter((k) => k !== "So11111111111111111111111111111111111111112");
    if (nonWsol.length > 0) return nonWsol[0];
  }

  if (programName.includes("Raydium")) {
    // initialize2: posições documentadas 8 e 9 = mint base e mint quote.
    for (const idx of [8, 9]) {
      const key = accountKeys[idx];
      if (key && isCandidate(key) && key !== "So11111111111111111111111111111111111111112") {
        return key;
      }
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* 3. JITO BLOCK ENGINE BUNDLE SUBMITTER                                       */
/* -------------------------------------------------------------------------- */

export interface BundleSubmitResult {
  bundleId: string;
  success: boolean;
  error?: string;
  /** Tip efetivamente pago em SOL (após clamp por tamanho de posição). */
  tipSol: number;
  /** true quando o tip foi reduzido pelo teto de bps. */
  tipClamped: boolean;
}

export interface BundleSubmitOptions {
  /** Último blockhash válido conhecido. Usado pela tx de tip. */
  blockhash: string;
  /** Capital comprometido na operação, para limitar o tip em bps. */
  capitalCommittedSol?: number;
  /** Teto de tip em bps do capital (default 50 bps). */
  maxTipBps?: number;
  region?: JitoRegion;
  /**
   * Intenção da operação. Default `"entry"` (mais restritivo): saída só é permitida com
   * `purpose: "exit"` explícito, porque a política de saída é deliberadamente assimétrica
   * (bloquear saída prende capital).
   */
  purpose?: OperationPurpose;
}

/**
 * Submete bundles ao Jito Block Engine.
 *
 * CORREÇÕES APLICADAS:
 *   [C1] tip accounts reais (getTipAccounts em runtime + fallback documentado e validado)
 *   [C5] `encoding: "base64"` explícito. A doc do Jito diz base58 é o default e está
 *        DEPRECATED; enviar base64 sem declarar o encoding faz o block engine tentar
 *        decodificar como base58 e rejeitar o bundle.
 *   [C6] tip limitado por bps do capital. Tip fixo de 0.003 SOL inviabiliza
 *        matematicamente posições pequenas (300 bps em 0.1 SOL).
 *   [C7] verificação estrutural do tip account antes de transferir SOL.
 */
/**
 * Opções do cliente do Jito.
 *
 * Existem para que a política de rate limit seja explícita e TESTÁVEL: o comportamento padrão
 * respeita o limite documentado (1 req/s/IP/região) e os testes podem encurtar a espera.
 */
export interface JitoSenderOptions {
  /** Intervalo mínimo entre consultas de status. Default: 1000ms (rate limit documentado). */
  minStatusIntervalMs?: number;
  /**
   * Espera máxima enfileirada antes de desistir. Acima disso, devolvemos erro de throttle em
   * vez de acumular fila: um cliente que aceita fila ilimitada transforma "rate limit" em
   * "latência crescente e imprevisível".
   */
  maxStatusWaitMs?: number;
}

export class JitoBundleSender {
  private tipAccountsCache: { accounts: string[]; fetchedAt: number } | null = null;
  /** Horário RESERVADO da última consulta de status (ver `reserveStatusSlot`). */
  private lastStatusQueryAt = 0;

  constructor(
    _connection: Connection,
    private readonly options: JitoSenderOptions = {}
  ) {}

  /**
   * Rate limit do block engine: 1 requisição/segundo/IP/região (doc).
   *
   * Estratégia "reserve-then-wait": reservamos o horário da requisição IMEDIATAMENTE (antes de
   * qualquer await), de modo que duas chamadas concorrentes não escolham o mesmo instante —
   * depois esperamos a diferença. A versão anterior FALHAVA a segunda chamada; falhar uma
   * consulta legítima por causa de outra consulta nossa é defeito de cliente, não rate limit.
   *
   * Se a espera necessária passar de `maxStatusWaitMs`, aí sim devolvemos erro de throttle —
   * mas com a fila declarada, em vez de silenciosamente estourar o limite do provedor.
   */
  private async reserveStatusSlot(): Promise<{ ok: true; waitMs: number } | { ok: false; waitMs: number }> {
    const minInterval = this.options.minStatusIntervalMs ?? JITO_MIN_REQUEST_INTERVAL_MS;
    const maxWait = this.options.maxStatusWaitMs ?? 1_500;
    const now = Date.now();
    const reservedAt = Math.max(now, this.lastStatusQueryAt + minInterval);
    this.lastStatusQueryAt = reservedAt;
    const waitMs = reservedAt - now;
    if (waitMs > maxWait) return { ok: false, waitMs };
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    return { ok: true, waitMs };
  }

  /** Busca os tip accounts oficiais. Cache de 10 min. Fallback: lista publicada. */
  public async getTipAccounts(region: JitoRegion = DEFAULT_JITO_REGION): Promise<string[]> {
    if (this.tipAccountsCache && Date.now() - this.tipAccountsCache.fetchedAt < 600_000) {
      return this.tipAccountsCache.accounts;
    }

    try {
      const res = await fetch(`${jitoBlockEngineUrl(region)}/api/v1/getTipAccounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ao consultar getTipAccounts`);
      }
      const json = (await res.json()) as { result?: unknown };
      const accounts = Array.isArray(json.result) ? (json.result as string[]).filter(isValidPubkey) : [];
      if (accounts.length === 0) {
        throw new Error("getTipAccounts retornou lista vazia ou inválida");
      }
      this.tipAccountsCache = { accounts, fetchedAt: Date.now() };
      return accounts;
    } catch (err: any) {
      console.warn(
        `[Jito] getTipAccounts indisponível (${err.message}). Usando lista publicada ` +
          `(docs.jito.wtf) com validação estrutural.`
      );
      const verified = JITO_TIP_ACCOUNTS_FALLBACK.filter(isValidPubkey);
      if (verified.length === 0) {
        throw new InfrastructureError(
          "Nenhum tip account válido disponível. Abortando para não queimar SOL.",
          "JITO_TIP_ACCOUNTS_UNAVAILABLE"
        );
      }
      this.tipAccountsCache = { accounts: verified, fetchedAt: Date.now() };
      return verified;
    }
  }

  /**
   * Escolhe um tip account aleatório entre os 8 oficiais.
   * A doc do Jito recomenda randomizar para reduzir contenção de conta.
   */
  private async pickTipAccount(region: JitoRegion): Promise<PublicKey> {
    const accounts = await this.getTipAccounts(region);
    const idx = Math.floor(Math.random() * accounts.length);
    const chosen = accounts[idx];
    if (!isValidPubkey(chosen)) {
      throw new InfrastructureError(`Tip account inválido selecionado: ${chosen}`, "INVALID_TIP_ACCOUNT");
    }
    return new PublicKey(chosen);
  }

  public async submitBundle(
    transactions: (Transaction | VersionedTransaction)[],
    signer: Keypair,
    tipSol: number,
    blockhash: string,
    options?: Omit<BundleSubmitOptions, "blockhash">
  ): Promise<BundleSubmitResult> {
    const region: JitoRegion = options?.region || DEFAULT_JITO_REGION;

    try {
      /**
       * DEFESA EM PROFUNDIDADE (Etapa 1 do plano de correção).
       *
       * Este método constrói a transação de tip, ASSINA e envia ao Block Engine. O caminho
       * normal já passa pelo choke point (`executeWithDecryptedKeypair` → `assertCanSign`),
       * mas depender de um único ponto de controle é frágil: qualquer novo chamador que
       * construa a transação por conta própria assinaria sem passar por lá.
       *
       * Aqui a barreira é reavaliada com o contexto completo (kill switch, read-only, cofre),
       * e a recusa é devolvida como resultado tipado — sem exceção, sem rede, sem tip.
       */
      try {
        assertCanSign(options?.purpose ?? "entry");
      } catch (guardErr: any) {
        return {
          bundleId: "",
          success: false,
          error: guardErr?.message || "[Signer Guard] Envio bloqueado pelo modo de execução.",
          tipSol: 0,
          tipClamped: false,
        };
      }

      if (!blockhash || !isValidBase58Blockhash(blockhash)) {
        return {
          bundleId: "",
          success: false,
          error: "Blockhash ausente ou inválido. Recusando assinar transação (evita rejeição garantida).",
          tipSol: 0,
          tipClamped: false,
        };
      }

      const capital = options?.capitalCommittedSol ?? 0;
      let effectiveTipSol = tipSol;
      let tipClamped = false;
      if (capital > 0) {
        const clamped = clampTipSol(tipSol, capital, options?.maxTipBps ?? 50);
        effectiveTipSol = clamped.tipSol;
        tipClamped = clamped.clamped;
        if (tipClamped) {
          console.warn(
            `[Jito] Tip reduzido de ${tipSol.toFixed(6)} SOL para ${effectiveTipSol.toFixed(6)} SOL ` +
              `para respeitar o teto de ${options?.maxTipBps ?? 50} bps sobre ${capital} SOL de capital.`
          );
        }
      }

      const tipRecipient = await this.pickTipAccount(region);

      // A tx de tip reutiliza o MESMO blockhash da tx principal (padrão recomendado,
      // evita expiração desalinhada entre as txs do bundle).
      const tipTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: signer.publicKey,
          toPubkey: tipRecipient,
          lamports: Math.max(1, Math.floor(effectiveTipSol * 1_000_000_000)),
        })
      );
      tipTx.recentBlockhash = blockhash;
      tipTx.feePayer = signer.publicKey;
      tipTx.sign(signer);

      // Ordem do bundle: [txs principais..., tip] — a doc confirma que o tip
      // tipicamente fica na última transação.
      const bundleTxs = [...transactions, tipTx];
      if (bundleTxs.length > 5) {
        return {
          bundleId: "",
          success: false,
          error: `Bundle com ${bundleTxs.length} transações excede o máximo de 5 permitido pelo Jito.`,
          tipSol: effectiveTipSol,
          tipClamped,
        };
      }

      const serializedTxs = bundleTxs.map((tx) =>
        Buffer.from(tx.serialize()).toString("base64")
      );

      const res = await fetch(`${jitoBlockEngineUrl(region)}/api/v1/bundles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendBundle",
          params: [serializedTxs, { encoding: "base64" }],
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          bundleId: "",
          success: false,
          error: `Block Engine HTTP ${res.status}: ${body.slice(0, 200)}`,
          tipSol: effectiveTipSol,
          tipClamped,
        };
      }

      const resJson = (await res.json()) as { result?: string; error?: { message?: string } };
      if (resJson.error) {
        return {
          bundleId: "",
          success: false,
          error: resJson.error.message || "Erro não especificado do block engine",
          tipSol: effectiveTipSol,
          tipClamped,
        };
      }
      if (!resJson.result) {
        return {
          bundleId: "",
          success: false,
          error: "Resposta sem bundle_id. Bundle não foi aceito.",
          tipSol: effectiveTipSol,
          tipClamped,
        };
      }

      return { bundleId: resJson.result, success: true, tipSol: effectiveTipSol, tipClamped };
    } catch (err: any) {
      return { bundleId: "", success: false, error: err.message, tipSol: 0, tipClamped: false };
    }
  }

  /**
   * Fallback quando o Jito está fora do ar ou o bundle é rejeitado.
   *
   * IMPORTANTE: enviar por `sendTransaction` normal EXPÕE a transação a sandwich.
   * Só use quando a alternativa for não executar a saída (ficar preso no ativo).
   * Para SAÍDA, ficar preso é pior que tomar sandwich — por isso o fallback existe.
   */
  /**
   * ───────────────────────────────────────────────────────────────────────────
   * STATUS DE LANDING (Etapa S3)
   * ───────────────────────────────────────────────────────────────────────────
   *
   * POR QUE ISTO EXISTE
   * `sendBundle` devolve um `bundle_id` e a doc é explícita: "This does not guarantee the
   * bundle will be processed or land on-chain." Sem consultar o status, o sistema tratava
   * "aceito pelo block engine" como "executado" — a mesma classe de erro que produziu PnL
   * fabricado nesta base. Estes dois métodos são a CONSULTA; a interpretação (incluindo a
   * regra "Landed ≠ confirmado") vive em `src/jitoStatus.ts`, testada sem rede.
   *
   * READ-ONLY: não assinam, não enviam, não pagam tip. Funcionam em qualquer modo de execução,
   * inclusive PAPER/SHADOW, onde servem para medir antes de existir capital em risco.
   *
   * THROTTLE: o block engine documenta 1 requisição/segundo/IP/região. Insistir acelera o
   * bloqueio; uma chamada dentro do intervalo mínimo devolve `ok: false` com o motivo, em vez
   * de ser disparada.
   */
  public async getBundleStatuses(
    bundleIds: string[],
    region: JitoRegion = DEFAULT_JITO_REGION
  ): Promise<JitoStatusQueryResult<BundleStatusEntry>> {
    return this.queryBundleStatus("getBundleStatuses", bundleIds, region, parseBundleStatuses);
  }

  public async getInflightBundleStatuses(
    bundleIds: string[],
    region: JitoRegion = DEFAULT_JITO_REGION
  ): Promise<JitoStatusQueryResult<InflightStatusEntry>> {
    return this.queryBundleStatus("getInflightBundleStatuses", bundleIds, region, parseInflightStatuses);
  }

  private async queryBundleStatus<T>(
    method: "getBundleStatuses" | "getInflightBundleStatuses",
    bundleIds: string[],
    region: JitoRegion,
    parser: (raw: unknown, requestedIds: string[]) => JitoStatusQueryResult<T>
  ): Promise<JitoStatusQueryResult<T>> {
    const ids = [...new Set((bundleIds || []).map((id) => String(id).trim()))].filter(Boolean);

    if (ids.length === 0) {
      return { ok: false, entries: [], missingIds: [], problems: ["nenhum bundle id informado"] };
    }
    if (ids.length > MAX_BUNDLE_IDS_PER_REQUEST) {
      return {
        ok: false,
        entries: [],
        missingIds: ids,
        problems: [
          `${ids.length} ids excede o máximo de ${MAX_BUNDLE_IDS_PER_REQUEST} por requisição ` +
            `(limite documentado do método). Divida em lotes.`,
        ],
      };
    }
    const invalid = ids.filter((id) => !isPlausibleBundleId(id));
    if (invalid.length > 0) {
      return {
        ok: false,
        entries: [],
        missingIds: ids,
        problems: [
          `id(s) com formato implausível: ${invalid.map((i) => i.slice(0, 16)).join(", ")}. ` +
            `A doc do Jito mostra o id como SHA-256 hex (64 chars) num exemplo e como base58 no outro; ` +
            `o código aceita ambos e recusa o resto.`,
        ],
      };
    }

    const slot = await this.reserveStatusSlot();
    if (!slot.ok) {
      return {
        ok: false,
        entries: [],
        missingIds: ids,
        problems: [
          `throttle local: a próxima consulta precisaria esperar ${slot.waitMs}ms, acima do ` +
            `máximo de ${this.options.maxStatusWaitMs ?? 1_500}ms. O rate limit documentado do ` +
            `block engine é 1 req/s/IP/região — consulte com espaçamento.`,
        ],
      };
    }

    try {
      const res = await fetch(`${jitoBlockEngineUrl(region)}/api/v1/${method}`, {
        method: "POST",
        headers: jitoHeaders(),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [ids] }),
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          ok: false,
          entries: [],
          missingIds: ids,
          problems: [`block engine HTTP ${res.status}: ${body.slice(0, 200)}`],
        };
      }

      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("json")) {
        return {
          ok: false,
          entries: [],
          missingIds: ids,
          problems: [`resposta não-JSON (content-type "${contentType}") — host errado ou block page`],
        };
      }

      return parser(await res.json(), ids);
    } catch (err: any) {
      return {
        ok: false,
        entries: [],
        missingIds: ids,
        problems: [`falha de rede ao consultar ${method}: ${err?.message ?? String(err)}`],
      };
    }
  }

  public async submitViaRpc(
    connection: Connection,
    transaction: VersionedTransaction,
    options?: { skipPreflight?: boolean; maxRetries?: number }
  ): Promise<{ signature: string; success: boolean; error?: string }> {
    try {
      const raw = transaction.serialize();
      const signature = await connection.sendRawTransaction(raw, {
        skipPreflight: options?.skipPreflight ?? false,
        maxRetries: options?.maxRetries ?? 3,
        preflightCommitment: "processed",
      });
      return { signature, success: true };
    } catch (err: any) {
      return { signature: "", success: false, error: err.message };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 4. JUPITER AGGREGATOR                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Cliente Jupiter.
 *
 * CORREÇÃO [C8]: os endpoints `quote-api.jup.ag/v6/*` foram SUNSET pela Jupiter
 * (developers.jup.ag/docs/changelog). O código apontava para endpoints mortos, o que
 * significa que a ÚNICA rota de saída do bot estava inoperante. Pior: a falha era
 * capturada e convertida em "liquidação simulada com status success".
 *
 * Agora o host vem de JUPITER_BASE_URL (default = host atual documentado) e erros
 * são propagados como erro, nunca convertidos em sucesso.
 */
export class JupiterIntegration {
  public static async getQuote(
    inputMint: string,
    outputMint: string,
    amountLamports: number,
    slippageBps: number,
    timeoutMs: number = 4000
  ): Promise<any> {
    const url =
      `${jupiterBaseUrl()}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
      `&amount=${amountLamports}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;

    const res = await fetch(url, {
      headers: jupiterHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new InfrastructureError(
        `Jupiter quote HTTP ${res.status}. Base=${jupiterBaseUrl()}. Body=${body.slice(0, 200)}`,
        "JUPITER_QUOTE_FAILED"
      );
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      throw new InfrastructureError(
        `Jupiter quote retornou content-type "${contentType}" (esperado JSON). ` +
          `Isso indica endpoint deprecado, block page da Cloudflare ou host errado.`,
        "JUPITER_BAD_RESPONSE"
      );
    }

    const quote = await res.json();
    if (!quote || !quote.outAmount) {
      throw new InfrastructureError(
        `Jupiter quote sem outAmount (rota inexistente para o par). Mint=${inputMint}`,
        "JUPITER_NO_ROUTE"
      );
    }
    return quote;
  }

  public static async buildSwapTransaction(
    quoteResponse: any,
    userPublicKeyStr: string,
    timeoutMs: number = 6000
  ): Promise<VersionedTransaction> {
    const res = await fetch(`${jupiterBaseUrl()}/swap`, {
      method: "POST",
      headers: jupiterHeaders(),
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: userPublicKeyStr,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new InfrastructureError(
        `Jupiter swap HTTP ${res.status}. Body=${body.slice(0, 200)}`,
        "JUPITER_SWAP_FAILED"
      );
    }

    const json = (await res.json()) as { swapTransaction?: string };
    if (!json.swapTransaction) {
      throw new InfrastructureError("Jupiter swap não retornou swapTransaction.", "JUPITER_NO_TX");
    }

    return VersionedTransaction.deserialize(Buffer.from(json.swapTransaction, "base64"));
  }
}

/* -------------------------------------------------------------------------- */
/* 5. BUILDERS NATIVOS — RECUSA EXPLÍCITA                                       */
/* -------------------------------------------------------------------------- */

/**
 * Builders nativos de swap (pump.fun / Raydium) foram DESABILITADOS.
 *
 * MOTIVO [C4]: as versões anteriores montavam instruções com:
 *   - discriminador de `buy` errado (0xeaebda01122eff09 em vez de 0x66063d1201daebea);
 *   - contas hardcoded que não existem ("C7S8bAaCb7129A09bBC71a81289Acb1129A")
 *     e PDAs incorretos (global do pump.fun é derivado de seeds, não fixo);
 *   - layout desatualizado. O pump.fun passou a exigir, em atualizações de 2025,
 *     contas adicionais em buy (fee_config index 14, fee_program index 15) e duas
 *     contas writable de volume accumulator (índices 12 e 13), além do fee_config no
 *     sell. Um layout de 2024 simplesmente falha on-chain hoje.
 *
 * Montar instrução de swap "de cabeça" em um programa cujo IDL muda é uma forma
 * garantida de queimar taxa e perder a oportunidade. Recusar é a decisão correta:
 * use o Jupiter `swap-instructions` (que retorna instruções construídas pelo próprio
 * agregador, com contas e layout corretos) ou o IDL oficial do programa.
 *
 * Mantemos o discriminador correto exportado em solanaConfig.ts para PARSING de
 * transações (detecção de buy/sell), onde ele é usado e verificável.
 */
export class LaunchSwapper {
  public static buildPumpFunBuyInstruction(
    _userPublicKey: PublicKey,
    _mintPublicKey: PublicKey,
    _solAmount: number,
    _maxTokenAmount: number
  ): TransactionInstruction {
    throw new InfrastructureError(
      "buildPumpFunBuyInstruction desabilitado: layout de contas do pump.fun não é " +
        "verificável neste código e mudou em 2025 (fee_config, fee_program, volume " +
        "accumulators). Use Jupiter POST /swap-instructions ou construa a partir do IDL " +
        "oficial (discriminador correto disponível em DISCRIMINATORS.PUMP_BUY).",
      "NATIVE_BUILDER_DISABLED"
    );
  }

  public static buildRaydiumSwapInstruction(
    _userPublicKey: PublicKey,
    _poolId: PublicKey,
    _solAmount: number
  ): TransactionInstruction {
    throw new InfrastructureError(
      "buildRaydiumSwapInstruction desabilitado: um swap da AMM v4 exige ~17 contas " +
        "derivadas do estado do pool (vaults, market do OpenBook, bids/asks, event queue). " +
        "A versão anterior montava 3 contas, o que só resultaria em falha on-chain. " +
        "Use Jupiter swap-instructions ou o SDK oficial da Raydium.",
      "NATIVE_BUILDER_DISABLED"
    );
  }

  /** Utilitário mantido para parsing: bytes do discriminador de buy do pump.fun. */
  public static pumpBuyDiscriminator(): Buffer {
    return discriminatorToBytes(DISCRIMINATORS.PUMP_BUY);
  }

  /** Utilitário mantido para parsing: bytes do discriminador de sell. */
  public static pumpSellDiscriminator(): Buffer {
    return discriminatorToBytes(DISCRIMINATORS.PUMP_SELL);
  }
}

/* -------------------------------------------------------------------------- */
/* 6. CONFIRMATION MONITOR                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Monitor de confirmação.
 *
 * Diferença crítica em relação à versão anterior: distinguimos
 *   - confirmado,
 *   - falhou on-chain (erro de programa),
 *   - expirou (blockhash vencido),
 *   - desconhecido (não conseguimos observar).
 * "Desconhecido" NUNCA pode ser tratado como sucesso — era exatamente isso que
 * produzia PnL fictício no relatório.
 */
export type ConfirmationOutcome = "confirmed" | "failed" | "expired" | "unknown";

export interface ConfirmationResult {
  outcome: ConfirmationOutcome;
  slot?: number;
  error?: string;
  /** Custo de rede observado até a confirmação. */
  feeLamports?: number;
}

export class ConfirmationMonitor {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  public async confirmWithRetry(
    signature: string,
    lastValidBlockHeight: number,
    timeoutMs: number = 20_000,
    retryDelayMs: number = 800
  ): Promise<ConfirmationResult> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      try {
        const currentHeight = await this.connection.getBlockHeight("processed");
        if (lastValidBlockHeight > 0 && currentHeight > lastValidBlockHeight) {
          return { outcome: "expired", error: "Blockhash expirado (lastValidBlockHeight excedido)" };
        }

        const status = await this.connection.getSignatureStatus(signature, {
          searchTransactionHistory: false,
        });

        const val = status.value;
        if (val) {
          if (val.err) {
            return { outcome: "failed", error: `Execução on-chain falhou: ${JSON.stringify(val.err)}` };
          }
          if (val.confirmationStatus === "confirmed" || val.confirmationStatus === "finalized") {
            return { outcome: "confirmed", slot: status.context.slot };
          }
          // "processed" é otimista: pode ser revertido em fork. Reportamos como
          // unknown para que o chamador decida (não tratamos como final).
          if (val.confirmationStatus === "processed") {
            return { outcome: "unknown", slot: status.context.slot, error: "Somente 'processed'; sujeito a reversão" };
          }
        }
      } catch {
        // Retry silencioso em timeout de rede.
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }

    return { outcome: "unknown", error: "Timeout aguardando confirmação" };
  }
}

/* -------------------------------------------------------------------------- */
/* 7. MODELO DE CUSTOS PARA O ORÇAMENTO DE EXECUÇÃO                            */
/* -------------------------------------------------------------------------- */

/**
 * Estima o custo round-trip de uma operação ANTES de executá-la.
 * Use para decidir se a oportunidade vale a pena: se o break-even estimado é maior
 * que o TP configurado, a estratégia está matematicamente condenada.
 */
export function estimateRoundTripCosts(params: {
  capitalSol: number;
  jitoTipSol: number;
  priorityFeeMicroLamportsPerCu: number;
  computeUnits: number;
  expectedSlippageBps: number;
  ammFeeBps?: number;
}): CostBreakdown {
  const costs = emptyCosts();
  costs.jitoTipSol = params.jitoTipSol * 2; // entrada + saída
  costs.baseFeeSol = (BASE_FEE_LAMPORTS * 2) / 1_000_000_000;
  costs.priorityFeeSol =
    ((params.priorityFeeMicroLamportsPerCu * params.computeUnits) / 1_000_000 / 1_000_000_000) * 2;
  costs.slippageCostSol = ((params.expectedSlippageBps * 2) / 10_000) * params.capitalSol;
  costs.ammFeeSol = ((params.ammFeeBps ?? 25) / 10_000) * params.capitalSol;
  return costs;
}
