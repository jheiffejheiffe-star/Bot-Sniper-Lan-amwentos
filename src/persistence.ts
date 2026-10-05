import fs from "fs";
import path from "path";
import type { ExecutionIntentRecord } from "./executionIntent.js";

const isServer = typeof window === "undefined";

export interface DBTrade {
  id: string;
  token: string;
  mint: string;
  amount: string;
  outAmount: string;
  /**
   * "paper" e "shadow" NUNCA podem ser contados como execução real em relatório de PnL.
   * Sem esta distinção, somar trades de sombra com trades reais produz um número que não
   * corresponde a dinheiro nenhum.
   */
  status: "success" | "failed" | "blacklisted" | "paper" | "shadow";
  block: number;
  tipSol: number;
  route: string;
  time: string;
  latencyMs: number;
  isAntiRugSaved?: boolean;
  savedAmountSol?: string;
  /**
   * "live" = execução real on-chain; "paper" = sombra/simulação (NUNCA é PnL real).
   * Sem este campo não há como distinguir resultado real de simulado no relatório —
   * e confundir os dois é o erro que mais destrói capital em bots.
   */
  mode?: "live" | "paper";
  /** Assinatura on-chain real. `null` em paper trades (nunca preenchida com texto). */
  signature?: string | null;
  /** PnL líquido medido por delta de saldo (SOL). Ausente quando não medido. */
  pnlNetSol?: number;
  /** Fee de rede paga (SOL). */
  feesSol?: number;
  /** true somente quando o resultado foi derivado de saldos on-chain confirmados. */
  measuredOnChain?: boolean;
}

export interface DBPosition {
  id: string;
  token: string;
  mint: string;
  sizeSol: number;
  entryPrice: number;
  currentPrice: number;
  pnlPercent: number;
  status: "open" | "closed" | "exit_pending";
  stopLossPercent: number; // e.g. -5 for -5%
  takeProfitPercent: number; // e.g. 15 for +15%
  trailingStopActive: boolean;
  trailingStopOffsetPercent: number; // e.g. 3 for 3% trailing
  highestPrice: number;
  timeOpened: string;
  timeClosed?: string;
  slippageBps?: number;
  maxSlippageBps?: number;
  /** "paper" = posição sombra; o gerenciador NÃO tenta liquidar on-chain. */
  mode?: "live" | "paper";
  /** Origem do último preço usado (para auditar decisões de SL/TP). */
  priceSource?: string;
  /** Contador de tentativas de saída que falharam (posição continua aberta). */
  exitAttempts?: number;
  lastExitError?: string;
  lastExitAttemptAt?: string;
  lastPriceAlertAt?: number;
  priceTelemetry?: { status: string; lastAttemptAt: string };
  /**
   * Última discordância entre FONTES INDEPENDENTES de preço para este token
   * (`src/priceQuality.ts`). Gravado na posição porque log em memória some e o pós-mortem
   * precisa responder "o stop que vendeu por engano foi calculado sobre preço confiável?".
   */
  priceDivergence?: {
    observedAt: string;
    /** Diferença relativa (0,05 = 5%) e o mesmo em pontos-base. */
    pct: number;
    bps: number;
    severity: string;
    reference: { source: string; priceSol: number; ageMs: number };
    candidate: { source: string; priceSol: number };
  };
  /**
   * Como o preço de ENTRADA foi confirmado (`src/entryQuality.ts`): quantas fontes independentes
   * responderam, quanto concordavam e se a entrada foi aceita com ou sem verificação. Fica na
   * posição porque é o que permite ao replay separar o resultado da ESTRATÉGIA do resultado de
   * uma entrada com preço duvidoso — e porque log em memória não sobrevive ao restart.
   */
  entryPriceVerification?: {
    status: string;
    sources: string[];
    divergenceBps: number | null;
    severity: string | null;
    accepted: boolean;
    reason: string;
    checkedAt: string;
  };
  /** Pico de liquidez observado pelo bot (base do alerta de queda). */
  liquidityUsdPeak?: number;
  /** Última liquidez observada (USD) — pode ser `null` quando a fonte não informa. */
  liquidityUsdLast?: number | null;
  /**
   * Alerta de queda de liquidez (remoção de LP). É ALERTA: nenhuma venda é disparada por ele
   * nas versões atuais — ver o comentário no laço de gestão (`server.ts`).
   */
  liquidityAlert?: {
    observedAt: string;
    peakUsd: number;
    currentUsd: number;
    dropPct: number;
    severity: string;
  };
  /**
   * Resultado da última reconciliação posição × cadeia (`src/positionDesync.ts`).
   * Gravado para que a divergência seja AUDITÁVEL depois do ciclo que a detectou —
   * log em memória some, o banco fica.
   */
  desyncState?: "in_sync" | "phantom_position" | "untracked_exposure" | "closed_but_holding" | "too_young" | "unknown";
  desyncReason?: string;
  desyncCheckedAt?: string;
  /** Quantas confirmações independentes de fantasma já foram obtidas (histerese). */
  phantomConfirmations?: number;
  /** Intenção de execução que originou/gerencia esta posição (rastreabilidade). */
  executionIntentId?: string | null;
}

export interface DBOperationalState {
  killSwitchActive: boolean;
  readOnlyMode: boolean;
  activeWallet: "operational" | "test" | "emergency";
  consecutiveFailures: number;
  failureThreshold: number;
  lastUpdated: string;
}

export interface DBSettings {
  circuitBreakerActive: boolean;
  circuitBreakerThreshold: number;
  coLocationActive: boolean;
  pm2State: string;
}

export interface DBLog {
  id: string;
  timestamp: string;
  level: "INFO" | "WARN" | "ERROR" | "CRITICAL" | "SUCCESS";
  component:
    | "RPC_INFRA"
    | "RISK_ENGINE"
    | "JITO_BUNDLE"
    | "SECURITY_SHIELD"
    | "MEMPOOL_SCANNER"
    /** Entradas em shadow: cotação + transação simulada (nunca assinada/enviada). */
    | "SHADOW_ENTRY"
    /** Entrada REAL (S6): assinatura, envio e confirmação. Não confundir com shadow/paper. */
    | "REAL_ENTRY"
    | "SYSTEM";
  message: string;
  correlationId?: string;
  metadata?: any;
}

// Memory database fallback / cache
class TransactionalStore {
  private dbPath: string = "";
  private logCounter: number = 0;
  /** Contadores REAIS de persistência (substituem as constantes de "saúde"). */
  private commitsAttempted: number = 0;
  private commitFailures: number = 0;
  private lastCommitDurationsMs: number[] = [];
  private data: {
    trades: DBTrade[];
    positions: DBPosition[];
    state: DBOperationalState;
    settings: DBSettings;
    logs: DBLog[];
    /** Intenções de execução (idempotência). NUNCA contêm bytes assinados. */
    intents: ExecutionIntentRecord[];
    schemaVersion: number;
    transactionCount: number;
  };

  constructor() {
    // Default initial data (production state starts clean)
    this.data = {
      trades: [],
      positions: [],
      state: {
        killSwitchActive: false,
        readOnlyMode: false,
        activeWallet: "operational",
        consecutiveFailures: 0,
        failureThreshold: 3,
        lastUpdated: new Date().toISOString()
      },
      settings: {
        circuitBreakerActive: true,
        circuitBreakerThreshold: 150,
        coLocationActive: false,
        pm2State: "online"
      },
      logs: [],
      intents: [],
      schemaVersion: 5,
      transactionCount: 0
    };

    if (isServer) {
      try {
        this.dbPath = path.join(process.cwd(), "hft_operational_db.json");
        this.loadOrMigrate();
      } catch (err) {
        console.error("[Database] Failed to initialize file path:", err);
      }
    }
  }

  private loadOrMigrate() {
    if (!isServer) return;

    const backupPath = this.dbPath + ".bak";

    const isValidDatabase = (parsed: any): boolean => {
      return (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray(parsed.trades) &&
        Array.isArray(parsed.positions) &&
        parsed.state &&
        typeof parsed.state === "object"
      );
    };

    const tryParseFile = (filePath: string): any => {
      if (!fs.existsSync(filePath)) return null;
      try {
        const fileContent = fs.readFileSync(filePath, "utf8");
        if (!fileContent || fileContent.trim() === "") return null;
        const parsed = JSON.parse(fileContent);
        if (isValidDatabase(parsed)) {
          return parsed;
        }
        return null;
      } catch (e) {
        return null;
      }
    };

    try {
      let parsed = tryParseFile(this.dbPath);

      if (!parsed) {
        console.warn("[Database Engine] Primary database file missing or corrupted. Attempting recovery from backup...");
        parsed = tryParseFile(backupPath);
        if (parsed) {
          console.log("[Database Engine] SUCCESSFUL AUTO-RECOVERY: Restored database from last valid backup.");
          try {
            // Restore primary from backup safely
            const jsonStr = JSON.stringify(parsed, null, 2);
            const fd = fs.openSync(this.dbPath, "w");
            fs.writeSync(fd, jsonStr, 0, "utf8");
            fs.fsyncSync(fd);
            fs.closeSync(fd);
          } catch (writeErr: any) {
            console.error("[Database Engine] Failed to write back parsed state from backup to primary:", writeErr.message);
          }
        }
      }

      if (!parsed) {
        console.log("[Database Engine] No valid database or backup found. Creating fresh atomic operational state on disk.");
        this.commit(this.data);
        return;
      }

      // Dynamic Migration Checker (Upgrading schema if outdated)
      if (parsed.schemaVersion < 3) {
        console.log(`[Database Migration] Outdated schema version ${parsed.schemaVersion} detected. Running automatic upgrade script...`);
        parsed.positions = parsed.positions || [];
        parsed.settings = parsed.settings || this.data.settings;
        parsed.schemaVersion = 3;
        this.commit(parsed);
        console.log("[Database Migration] Completed upgrade to Schema v3. High performance structural indices applied.");
      }

      if (parsed.schemaVersion < 4) {
        console.log(`[Database Migration] Outdated schema version ${parsed.schemaVersion} detected. Upgrading to Schema v4...`);
        parsed.logs = parsed.logs || [
          { id: "log_1", timestamp: new Date().toISOString(), level: "INFO", component: "SYSTEM", message: "Inicializando Observabilidade do Robô HFT..." },
          { id: "log_2", timestamp: new Date().toISOString(), level: "SUCCESS", component: "RPC_INFRA", message: "Balanceamento ativo estabelecido entre 4 RPCs co-localizados." },
          { id: "log_3", timestamp: new Date().toISOString(), level: "INFO", component: "MEMPOOL_SCANNER", message: "Monitor de gRPC escaneando blocos em tempo real..." }
        ];
        parsed.schemaVersion = 4;
        this.commit(parsed);
        console.log("[Database Migration] Completed upgrade to Schema v4. Structured Logging tables initialized.");
      }
      
      if (parsed.schemaVersion < 5) {
        console.log(`[Database Migration] Outdated schema version ${parsed.schemaVersion} detected. Upgrading to Schema v5...`);
        // Intenções de execução: array vazio é o estado correto de um banco que nunca
        // registrou intenção. Nada é inferido/retro-preenchido — inventar intenção para
        // histórico antigo criaria rastreabilidade falsa.
        parsed.intents = Array.isArray(parsed.intents) ? parsed.intents : [];
        parsed.schemaVersion = 5;
        this.commit(parsed);
        console.log("[Database Migration] Completed upgrade to Schema v5. Execution intents table initialized.");
      }

      this.data = parsed;
      console.log(`[Database Engine] Loaded state from disk successfully. Version: v${this.data.schemaVersion}. Transaction commits: ${this.data.transactionCount}`);
    } catch (err: any) {
      console.error("[Database Engine] Load / Migration failed. Running fallback memory mode.", err.message);
    }
  }

  private commit(newData: typeof this.data) {
    if (!isServer) return;

    const startedAt = Date.now();
    this.commitsAttempted++;

    try {
      newData.transactionCount++;
      const jsonString = JSON.stringify(newData, null, 2);

      // JSON pre-validation - ensure we do not write corrupted data
      JSON.parse(jsonString);

      const backupPath = this.dbPath + ".bak";

      // Create backup of current existing dbPath first, only if it is completely valid
      if (fs.existsSync(this.dbPath)) {
        try {
          const currentContent = fs.readFileSync(this.dbPath, "utf8");
          const currentParsed = JSON.parse(currentContent);
          if (currentParsed && Array.isArray(currentParsed.trades) && Array.isArray(currentParsed.positions)) {
            // Write to backup using sync for safety
            const bakFd = fs.openSync(backupPath, "w");
            fs.writeSync(bakFd, currentContent, 0, "utf8");
            fs.fsyncSync(bakFd);
            fs.closeSync(bakFd);
          }
        } catch (bkpErr: any) {
          console.warn("[Database Backup Error] Could not create backup from current file:", bkpErr.message);
        }
      }

      // Write to temp file then rename (POSIX Atomic Write guarantee)
      const tmpPath = this.dbPath + ".tmp";
      const fd = fs.openSync(tmpPath, "w");
      fs.writeSync(fd, jsonString, 0, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);

      // Atomic rename
      fs.renameSync(tmpPath, this.dbPath);

      this.lastCommitDurationsMs.push(Date.now() - startedAt);
      if (this.lastCommitDurationsMs.length > 50) this.lastCommitDurationsMs.shift();
    } catch (err: any) {
      this.commitFailures++;
      console.error("[Database Commit Error] Disk write aborted, rolled back to state cache.", err.message);
    }
  }

  /** Sink de espelho (S10). Opcional: sem ele, o comportamento é exatamente o anterior. */
  private writeThrough: WriteThroughSink | null = null;

  public setWriteThrough(sink: WriteThroughSink): void {
    this.writeThrough = sink;
  }

  public hasWriteThrough(): boolean {
    return this.writeThrough !== null;
  }

  /**
   * Chama o sink sem deixar exceção subir. Um espelho com defeito não pode impedir a gravação local
   * — a operação não pode depender do banco de terceiro para registrar o que fez.
   */
  private mirror(fn: (sink: WriteThroughSink) => void): void {
    if (!this.writeThrough) return;
    try {
      fn(this.writeThrough);
    } catch (err: any) {
      console.error("[Database Engine] Falha ao espelhar registro (a gravação local foi mantida):", err?.message ?? err);
    }
  }

  // Trades Repository
  public getTrades(): DBTrade[] {
    return this.data.trades;
  }

  public saveTrade(trade: DBTrade): void {
    const idx = this.data.trades.findIndex(t => t.id === trade.id);
    if (idx !== -1) {
      this.data.trades[idx] = trade;
    } else {
      this.data.trades.unshift(trade);
      if (this.data.trades.length > 50) {
        this.data.trades.pop();
      }
    }
    this.commit(this.data);
    this.mirror((sink) => sink.mirrorTrade?.(trade));
  }

  // Positions Repository
  public getPositions(): DBPosition[] {
    return this.data.positions;
  }

  public savePosition(pos: DBPosition): void {
    const idx = this.data.positions.findIndex(p => p.id === pos.id);
    if (idx !== -1) {
      this.data.positions[idx] = pos;
    } else {
      this.data.positions.unshift(pos);
    }
    this.commit(this.data);
    this.mirror((sink) => sink.mirrorPosition?.(pos));
  }

  public deletePosition(id: string): void {
    this.data.positions = this.data.positions.filter(p => p.id !== id);
    this.commit(this.data);
  }

  // Operational State Repository
  public getOperationalState(): DBOperationalState {
    return this.data.state;
  }

  public updateOperationalState(state: Partial<DBOperationalState>): void {
    this.data.state = {
      ...this.data.state,
      ...state,
      lastUpdated: new Date().toISOString()
    };
    this.commit(this.data);
  }

  // Settings Repository
  public getSettings(): DBSettings {
    return this.data.settings;
  }

  public updateSettings(settings: Partial<DBSettings>): void {
    this.data.settings = {
      ...this.data.settings,
      ...settings
    };
    this.commit(this.data);
  }

  // Execution Intents Repository (idempotência de ação econômica)
  public getIntents(): ExecutionIntentRecord[] {
    if (!this.data.intents) this.data.intents = [];
    return this.data.intents;
  }

  /**
   * Grava/atualiza uma intenção. Persistir ANTES de assinar é o que dá sentido ao
   * registro: uma intenção que só existe depois do envio não serve para impedir o
   * segundo envio.
   */
  public saveIntent(intent: ExecutionIntentRecord): void {
    if (!this.data.intents) this.data.intents = [];
    const idx = this.data.intents.findIndex((i) => i.id === intent.id);
    if (idx !== -1) {
      this.data.intents[idx] = intent;
    } else {
      this.data.intents.unshift(intent);
      // Retenção: as 200 mais recentes. Histórico de intenções é auditoria, não estado
      // ativo — mas as NÃO TERMINAIS nunca são descartadas (ver compactIntents).
      if (this.data.intents.length > 200) {
        const terminal = this.data.intents.filter((i) => i.state === "confirmed" || i.state === "failed" || i.state === "expired");
        const nonTerminal = this.data.intents.filter((i) => i.state !== "confirmed" && i.state !== "failed" && i.state !== "expired");
        this.data.intents = [...nonTerminal, ...terminal.slice(0, Math.max(0, 200 - nonTerminal.length))];
      }
    }
    this.commit(this.data);
    // Intenção espelhada é o que permite a auditoria pós-restart cruzar estado local × banco.
    this.mirror((sink) => sink.mirrorIntent?.(intent));
  }

  /** Intenções não terminais (as que impedem uma segunda ação na mesma posição/lado). */
  public getActiveIntents(): ExecutionIntentRecord[] {
    return this.getIntents().filter(
      (i) => i.state !== "confirmed" && i.state !== "failed" && i.state !== "expired"
    );
  }

  // Structured Logging Repository
  public getLogs(): DBLog[] {
    return this.data.logs || [];
  }

  public saveLog(log: Omit<DBLog, "id">): DBLog {
    if (!this.data.logs) this.data.logs = [];
    this.logCounter = (this.logCounter + 1) % 100000;
    const newLog: DBLog = {
      id: `log_${Date.now()}_${this.logCounter}`,
      ...log
    };
    this.data.logs.unshift(newLog);
    // Keep max 300 logs for high frequency efficiency
    if (this.data.logs.length > 300) {
      this.data.logs.pop();
    }
    this.commit(this.data);
    this.mirror((sink) => sink.mirrorLog?.(newLog));
    return newLog;
  }

  public rotateLogs(retentionDays: number = 7, maxSizeKb: number = 2000): {
    rotatedCount: number;
    bytesSaved: number;
    currentSizeKb: number;
    bytesAreEstimated: boolean;
    appliedPolicy: string;
  } {
    if (!this.data.logs) this.data.logs = [];
    const initialCount = this.data.logs.length;
    // AVISO: isto é rotação por CONTAGEM, não por retenção de tempo/tamanho.
    // Os parâmetros retentionDays/maxSizeKb são aceitos mas NÃO aplicados — reportamos isso
    // no retorno (appliedPolicy) para que a UI não afirme uma política que não existe.
    const keptCount = Math.min(initialCount, 15);
    const removedCount = initialCount - keptCount;
    this.data.logs = this.data.logs.slice(0, keptCount);
    
    // Log rotation event
    this.data.logs.unshift({
      id: `log_rotate_${Date.now()}`,
      timestamp: new Date().toISOString(),
      level: "WARN",
      component: "SYSTEM",
      message: `[ROTATION POLICY] Rotação executada com sucesso. Retenção de logs limitada a ${retentionDays} dias e ${maxSizeKb}KB max. Expurgados ${removedCount} registros antigos.`
    });

    this.commit(this.data);
    
    return {
      rotatedCount: removedCount,
      // bytesSaved/currentSizeKb são ESTIMATIVAS (180 bytes/log). Marcado explicitamente
      // para não serem lidos como medição precisa.
      bytesSaved: removedCount * 180,
      currentSizeKb: Math.round((this.data.logs.length * 180) / 1024 * 100) / 100,
      bytesAreEstimated: true,
      appliedPolicy: `contagem (máx. 15 entradas); retentionDays=${retentionDays} e maxSizeKb=${maxSizeKb} NÃO aplicados`,
    };
  }

  public getDatabaseStats() {
    return {
      engine: "SQLite-like Atomic JSON DB",
      schemaVersion: this.data.schemaVersion,
      transactionCount: this.data.transactionCount,
      tradesCount: this.data.trades.length,
      positionsCount: this.data.positions.length,
      logsCount: (this.data.logs || []).length,
      intentsCount: (this.data.intents || []).length,
      activeIntentsCount: this.getActiveIntents().length,
      path: this.dbPath,
      // MÉTRICAS REAIS (auditoria): "EXCELLENT" e 0.12ms eram constantes hardcoded exibidas
      // como se fossem medição. health agora deriva da razão de commits com falha; a latência
      // de escrita é a média das últimas operações observadas.
      health: this.commitsAttempted === 0
        ? "UNKNOWN"
        : this.commitFailures / this.commitsAttempted > 0.05
          ? "DEGRADED"
          : this.commitFailures > 0
            ? "WARN"
            : "OK",
      commitsAttempted: this.commitsAttempted,
      commitFailures: this.commitFailures,
      writeLatencyMs: this.lastCommitDurationsMs.length
        ? Math.round((this.lastCommitDurationsMs.reduce((a, b) => a + b, 0) / this.lastCommitDurationsMs.length) * 100) / 100
        : null,
      logsRetentionNote:
        "Rotação por contagem (não por dias/KB): mantém as 15 entradas mais recentes. " +
        "Os parâmetros retentionDays/maxSizeKb são aceitos por compatibilidade e NÃO são aplicados.",
    };
  }
}

// Instantiate Singleton Database client
/**
 * ESPELHO DE ESCRITA (S10). O JSON continua sendo a fonte operacional (decisões não mudam), e o
 * Postgres recebe os MESMOS registros por este sink — o adaptador decide o que fazer e nunca lança.
 *
 * Por que um sink em vez de trocar a implementação: trocar o armazenamento operacional de uma vez
 * colocaria em risco o caminho de decisão que já está funcionando. Com o sink, o banco é ADITIVO:
 * se ele não responde, o bot continua operando com o JSON e o health declara a degradação.
 */
export interface WriteThroughSink {
  mirrorTrade?(trade: DBTrade): void;
  mirrorPosition?(position: DBPosition): void;
  mirrorIntent?(intent: ExecutionIntentRecord): void;
  mirrorLog?(log: DBLog): void;
}

export const dbStore = new TransactionalStore();
