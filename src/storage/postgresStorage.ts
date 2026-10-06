/**
 * POSTGRES (S10) — o que o arquivo JSON não consegue fazer: voo único ENTRE processos e histórico
 * além do teto de memória local.
 *
 * ## O que faz
 *
 * 1. **Voo único entre processos.** `claimEntry()` insere uma linha em `entry_claims` protegida por
 *    índice único parcial (`WHERE state = 'active'`). Duas instâncias na mesma carteira apontando
 *    para o mesmo mint: exatamente UMA ganha; a outra recebe o dono e a expiração do claim. É a
 *    guarda que o `InFlightMints` (memória, por processo) não pode dar.
 * 2. **Espelho durável.** Posições, trades, intenções e logs de decisão são escritos no Postgres
 *    junto com o JSON (write-through, upsert idempotente). Motivo medido: o JSON guarda no máximo
 *    50 trades — pouco para validar estratégia estatisticamente, e o histórico é justamente o dado
 *    que a validação precisa.
 * 3. **Health e política** para que o operador saiba, em `/api/storage`, qual modo está ativo.
 *
 * ## Como funciona
 *
 * - O cliente SQL é INJETADO (`SqlClient`). Em produção é `pg` (carregado por `import()` dinâmico em
 *   `loadPgClient`); nos testes é um Postgres REAL em WASM (PGlite) — o SQL exercitado é o mesmo.
 * - `payload JSONB` guarda o registro completo; as colunas são só o índice de consulta (ver
 *   `schema.ts`).
 * - **Fail-closed:** `decideEntryStorageGuard()` decide se o caminho de assinatura pode prosseguir.
 *   Com `HFT_STORAGE=postgres` e banco indisponível, a entrada real é RECUSADA — assinar sem o
 *   guarda de voo único que o operador acredita ter é pior do que não assinar.
 *
 * ## Dependências
 *
 * `pg` (dependência do projeto, carregada só quando o modo Postgres é usado). Nenhuma chave,
 * nenhuma assinatura: este módulo só grava e lê dados operacionais.
 *
 * ## Riscos
 *
 * 1. **Banco é infraestrutura de terceiro**: cota, latência e disponibilidade. Por isso o modo
 *    Postgres é opt-in e o JSON continua sendo escrito — um banco fora do ar degrada a operação, não
 *    apaga o histórico local.
 * 2. **TTL do claim.** Se o TTL for curto demais, um processo lento pode perder o claim para outro;
 *    se for longo demais, um crash bloqueia entradas até expirar. O default (5 min) é declarado em
 *    `HFT_STORAGE_CLAIM_TTL_MS` e o health mostra a expiração de cada claim ativo.
 * 3. **Latência extra no caminho de assinatura**: o claim é um INSERT idempotente antes de assinar.
 *    É uma escrita por ENTRADA (não por ciclo), e o orçamento de tempo é explícito no boot
 *    (`HFT_STORAGE_CLAIM_TIMEOUT_MS`): estourou, a entrada é recusada.
 *
 * ## Como testar
 *
 * Grupo [29]: Postgres real (PGlite) — migração idempotente, dois processos disputando o mesmo
 * mint, retomada de claim expirado, liberação só pelo dono, upsert do espelho e o guarda fail-closed.
 *
 * ## Como colocar em produção
 *
 * `npm run storage:migrate` (idempotente) → `HFT_STORAGE=postgres` + `DATABASE_URL=postgres://…`
 * (tier gratuito serve). Sem essas duas variáveis, o comportamento é o do JSON: idêntico ao atual.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";

/* -------------------------------------------------------------------------- */
/* 1. POLÍTICA (puro)                                                          */
/* -------------------------------------------------------------------------- */

export type StorageMode = "json" | "postgres";

export interface StoragePolicy {
  mode: StorageMode;
  /** `HFT_STORAGE=postgres` foi pedido. */
  requestedPostgres: boolean;
  databaseUrlConfigured: boolean;
  /** TTL do claim de entrada. Default 5 min. */
  claimTtlMs: number;
  /** Teto de espera do claim antes de recusar a entrada. Default 1500ms. */
  claimTimeoutMs: number;
  /** Quais níveis de log vão para o banco: `critical` (WARN+), `all` ou `off`. */
  mirrorLogs: "critical" | "all" | "off";
  /** Quantos trades o histórico do banco deve carregar para a validação estatística. */
  historyLimit: number;
  /** Motivos para o Postgres NÃO estar operacional. Vazio = pronto. */
  blockers: string[];
}

/** AUSÊNCIA ≠ ZERO: variável ausente cai no default; inválida também. */
function num(raw: string | undefined, fallback: number, min: number, max: number): number {
  const s = (raw ?? "").trim();
  if (s === "") return fallback;
  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export const STORAGE_DEFAULTS = Object.freeze({
  claimTtlMs: 300_000,
  claimTimeoutMs: 1_500,
  historyLimit: 5_000,
});

export function resolveStoragePolicy(env: NodeJS.ProcessEnv = process.env): StoragePolicy {
  const raw = (env.HFT_STORAGE ?? "json").trim().toLowerCase();
  const requestedPostgres = raw === "postgres" || raw === "postgresql";
  const databaseUrl = (env.DATABASE_URL ?? "").trim();
  const blockers: string[] = [];

  const modoConhecido = raw === "json" || raw === "postgres" || raw === "postgresql";
  /**
   * MODO DESCONHECIDO é bloqueio por si só. A primeira versão só o detectava quando DATABASE_URL
   * estava preenchida — ou seja, um `HFT_STORAGE=mysql` sem URL passava em silêncio, e o operador
   * ficava acreditando que havia configurado um banco. Não adivinhar inclui não ignorar.
   */
  if (!modoConhecido) {
    blockers.push(`HFT_STORAGE="${raw}" não é um modo conhecido (use "json" ou "postgres")`);
  }
  if (requestedPostgres && databaseUrl === "") {
    blockers.push("HFT_STORAGE=postgres exige DATABASE_URL");
  }
  if (modoConhecido && !requestedPostgres && databaseUrl !== "") {
    blockers.push(
      "DATABASE_URL definido com HFT_STORAGE=json: o banco NÃO está sendo usado. " +
        "Ligue HFT_STORAGE=postgres para valer, ou remova a variável para não confundir o operador."
    );
  }

  const mirrorLogsRaw = (env.HFT_STORAGE_MIRROR_LOGS ?? "critical").trim().toLowerCase();
  const mirrorLogs: StoragePolicy["mirrorLogs"] =
    mirrorLogsRaw === "all" || mirrorLogsRaw === "critical" || mirrorLogsRaw === "off" ? mirrorLogsRaw : "critical";

  return {
    mode: requestedPostgres && databaseUrl !== "" ? "postgres" : "json",
    requestedPostgres,
    databaseUrlConfigured: databaseUrl !== "",
    claimTtlMs: num(env.HFT_STORAGE_CLAIM_TTL_MS, STORAGE_DEFAULTS.claimTtlMs, 5_000, 3_600_000),
    claimTimeoutMs: num(env.HFT_STORAGE_CLAIM_TIMEOUT_MS, STORAGE_DEFAULTS.claimTimeoutMs, 100, 30_000),
    mirrorLogs,
    historyLimit: num(env.HFT_STORAGE_HISTORY_LIMIT, STORAGE_DEFAULTS.historyLimit, 50, 1_000_000),
    blockers,
  };
}

export function describeStoragePolicy(policy: StoragePolicy): string[] {
  const notes: string[] = [];
  if (policy.mode === "json") {
    notes.push(
      "persistência em JSON atômico (default): voo único vale POR PROCESSO — duas instâncias na " +
        "mesma carteira NÃO se enxergam (limite declarado desde a Etapa 1) e o histórico local é " +
        "limitado a 50 trades"
    );
  } else {
    notes.push(
      `espelho em Postgres ATIVO: voo único entre processos via entry_claims (TTL ${Math.round(
        policy.claimTtlMs / 1000
      )}s), histórico até ${policy.historyLimit} trades; o JSON continua sendo escrito`
    );
    notes.push(
      policy.mirrorLogs === "off"
        ? "logs de decisão NÃO são espelhados (HFT_STORAGE_MIRROR_LOGS=off)"
        : policy.mirrorLogs === "all"
          ? "TODOS os logs vão para o banco (HFT_STORAGE_MIRROR_LOGS=all) — volume alto por decisão"
          : "só WARN/CRITICAL vão para o banco (HFT_STORAGE_MIRROR_LOGS=critical, default)"
    );
  }
  for (const b of policy.blockers) notes.push(`ATENÇÃO: ${b}`);
  return notes;
}

/**
 * DECISÃO DE ASSINATURA segundo o armazenamento. Fail-closed por desenho:
 * com Postgres configurado, a entrada real só prossegue com banco conectado E schema na versão
 * esperada. Motivo: o operador acredita que existe um guarda de voo único entre processos — e
 * assinar sem ele é assinar acreditando numa proteção que não está lá.
 */
export interface StorageHealth {
  configured: boolean;
  connected: boolean;
  migrated: boolean;
  schemaVersion: number | null;
  lastError: string | null;
}

export interface StorageGuardDecision {
  allowSign: boolean;
  code: string | null;
  detail: string | null;
}

export function decideEntryStorageGuard(policy: StoragePolicy, health: StorageHealth): StorageGuardDecision {
  if (policy.mode === "json") {
    return {
      allowSign: true,
      code: null,
      detail: "modo JSON: guarda de voo único por processo (declarada) — sem árbitro entre instâncias",
    };
  }
  if (!health.connected) {
    return {
      allowSign: false,
      code: "STORAGE_UNAVAILABLE",
      detail:
        `Postgres indisponível (${health.lastError ?? "sem detalhe"}): o guarda de voo único entre ` +
        `processos não pode ser exercido. Entrada recusada — não se assina confiando numa proteção ` +
        `que não está respondendo.`,
    };
  }
  if (!health.migrated) {
    return {
      allowSign: false,
      code: "STORAGE_SCHEMA_OUTDATED",
      detail:
        `schema do banco em ${health.schemaVersion ?? "ausente"}, esperado ${SCHEMA_VERSION}. ` +
        `Rode: npm run storage:migrate.`,
    };
  }
  return { allowSign: true, code: null, detail: "Postgres conectado e schema na versão esperada" };
}

/* -------------------------------------------------------------------------- */
/* 2. CLIENTE INJETÁVEL                                                        */
/* -------------------------------------------------------------------------- */

export interface SqlQueryResult {
  rows: any[];
  rowCount?: number | null;
}

export interface SqlClient {
  query(sql: string, params?: unknown[]): Promise<SqlQueryResult>;
  end(): Promise<void>;
}

/** Carrega `pg` sob demanda: o modo JSON não paga o carregamento nem depende do pacote. */
export async function loadPgClient(databaseUrl: string): Promise<SqlClient> {
  let pgModule: any;
  try {
    pgModule = await import("pg");
  } catch (err: any) {
    throw new Error(
      `não foi possível carregar o pacote "pg" (${err?.code ?? err?.name ?? "erro"}: ${err?.message ?? err}). ` +
        `Rode npm ci — ou mantenha HFT_STORAGE=json, que não precisa de banco.`
    );
  }
  const Client = pgModule?.default?.Client ?? pgModule?.Client;
  if (typeof Client !== "function") {
    throw new Error(`o pacote "pg" carregou mas não expõe Client (versão incompatível com este adaptador)`);
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  return {
    query: (sql, params) => client.query(sql, params as any[]),
    end: () => client.end(),
  };
}

/* -------------------------------------------------------------------------- */
/* 3. ADAPTADOR                                                                */
/* -------------------------------------------------------------------------- */

export interface EntryClaimResult {
  acquired: boolean;
  claimId: string | null;
  owner: string;
  /** Dono do claim vigente quando `acquired === false`. */
  heldBy: string | null;
  expiresAt: string | null;
  /** `novo` | `retomado-expirado` | `ocupado` | `banco-indisponivel` */
  reason: "novo" | "retomado-expirado" | "ocupado" | "banco-indisponivel";
  detail: string;
}

/** Identificação desta instância nos claims — diagnóstico de "qual processo está com o quê". */
export function instanceOwner(): string {
  return `${hostname()}#${process.pid}`;
}

export class PostgresStorage {
  private connected = false;
  private migrated = false;
  private schemaVersion: number | null = null;
  private lastError: string | null = null;
  private lastOkAt: number | null = null;
  private writes = 0;
  private writeFailures = 0;
  private claimsAcquired = 0;
  private claimsRefused = 0;

  constructor(
    private readonly client: SqlClient,
    private readonly policy: StoragePolicy,
    private readonly owner: string = instanceOwner()
  ) {}

  /** Conecta (se preciso) e confere a versão do schema. Nunca lança: devolve o motivo no health. */
  public async initialize(): Promise<StorageHealth> {
    try {
      await this.client.query("SELECT 1");
      this.connected = true;
      /**
       * BANCO NOVO ≠ BANCO FORA DO AR. A primeira versão consultava `schema_migrations` direto: numa
       * base vazia a tabela não existe, o erro era capturado e o health reportava
       * `connected=false` — ou seja, o boot abortava (fail-closed) sem nunca conseguir bootstrap
       * de um banco limpo, e o log dizia "sem conexão" quando a conexão estava perfeita.
       * `to_regclass` responde "a tabela existe?" sem lançar, então os dois estados ficam separados.
       */
      const existe = await this.client.query("SELECT to_regclass('public.schema_migrations') AS tabela");
      const tabela = existe.rows?.[0]?.tabela ?? null;
      if (tabela === null) {
        this.schemaVersion = null;
        this.migrated = false;
      } else {
        const res = await this.client.query("SELECT MAX(version) AS version FROM schema_migrations");
        const raw = res.rows?.[0]?.version;
        // `pg` devolve BIGINT/INTEGER como string em alguns casos; Number só para versão de schema.
        this.schemaVersion = raw === null || raw === undefined ? null : Number(raw);
        this.migrated = this.schemaVersion !== null && this.schemaVersion >= SCHEMA_VERSION;
      }
      this.lastError = null;
      this.lastOkAt = Date.now();
    } catch (err: any) {
      this.connected = false;
      this.migrated = false;
      this.schemaVersion = null;
      this.lastError = err?.message ?? String(err);
    }
    return this.health();
  }

  public async migrate(): Promise<{ applied: number[]; alreadyAt: number | null }> {
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    INTEGER PRIMARY KEY,
         name       TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );
    const atual = await this.client.query("SELECT MAX(version) AS version FROM schema_migrations");
    const rawAtual = atual.rows?.[0]?.version;
    const atVersion = rawAtual === null || rawAtual === undefined ? null : Number(rawAtual);

    const applied: number[] = [];
    for (const migration of MIGRATIONS) {
      if (atVersion !== null && migration.version <= atVersion) continue;
      for (const statement of migration.statements) {
        await this.client.query(statement);
      }
      await this.client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
        migration.version,
        migration.name,
      ]);
      applied.push(migration.version);
    }
    this.migrated = true;
    this.schemaVersion = Math.max(atVersion ?? 0, ...MIGRATIONS.map((m) => m.version));
    return { applied, alreadyAt: atVersion };
  }

  public health(): StorageHealth & {
    mode: StorageMode;
    owner: string;
    writes: number;
    writeFailures: number;
    claimsAcquired: number;
    claimsRefused: number;
    lastOkAgeMs: number | null;
  } {
    return {
      configured: this.policy.mode === "postgres",
      connected: this.connected,
      migrated: this.migrated,
      schemaVersion: this.schemaVersion,
      lastError: this.lastError,
      mode: this.policy.mode,
      owner: this.owner,
      writes: this.writes,
      writeFailures: this.writeFailures,
      claimsAcquired: this.claimsAcquired,
      claimsRefused: this.claimsRefused,
      lastOkAgeMs: this.lastOkAt ? Date.now() - this.lastOkAt : null,
    };
  }

  /** Executa uma query de escrita marcando contadores. Nunca deixa exceção subir para o chamador. */
  private async write(sql: string, params: unknown[], what: string): Promise<boolean> {
    try {
      await this.client.query(sql, params);
      this.writes++;
      this.lastOkAt = Date.now();
      return true;
    } catch (err: any) {
      this.writeFailures++;
      this.lastError = `${what}: ${err?.message ?? String(err)}`;
      return false;
    }
  }

  /* ------------------------------- claims -------------------------------- */

  /**
   * Tenta adquirir o voo único de (mint, side). Três desfechos possíveis, todos explícitos:
   * `novo` (insert venceu), `retomado-expirado` (havia claim ativo mas vencido) e `ocupado`
   * (outro processo está com o claim, dentro do TTL). Falha de banco NÃO é "livre": é
   * `banco-indisponivel`, e quem decide recusar é o chamador (fail-closed).
   */
  public async claimEntry(params: {
    mint: string;
    side: "entry" | "exit";
    /** TTL específico (default: política). */
    ttlMs?: number;
    payload?: Record<string, unknown>;
  }): Promise<EntryClaimResult> {
    const ttlMs = Math.max(1_000, params.ttlMs ?? this.policy.claimTtlMs);
    const claimId = randomUUID();
    const payloadJson = params.payload ? JSON.stringify(params.payload) : null;

    try {
      const inserted = await this.client.query(
        `INSERT INTO entry_claims (claim_id, mint, side, owner, state, expires_at, payload)
         VALUES ($1, $2, $3, $4, 'active', now() + ($5::text || ' milliseconds')::interval, $6)
         ON CONFLICT DO NOTHING
         RETURNING claim_id, expires_at`,
        [claimId, params.mint, params.side, this.owner, String(ttlMs), payloadJson]
      );
      if (inserted.rows?.length) {
        this.claimsAcquired++;
        return {
          acquired: true,
          claimId,
          owner: this.owner,
          heldBy: this.owner,
          expiresAt: toIso(inserted.rows[0].expires_at),
          reason: "novo",
          detail: "claim criado neste processo",
        };
      }

      /**
       * Conflito no índice único parcial: há claim ATIVO para este (mint, side). Se ele já venceu,
       * a retomada é atômica (UPDATE condicional) — não existe janela em que dois processos
       * concluam que o claim expirou e ambos o tomem.
       */
      const stolen = await this.client.query(
        `UPDATE entry_claims
            SET claim_id = $1, owner = $2, acquired_at = now(),
                expires_at = now() + ($3::text || ' milliseconds')::interval,
                payload = $4
          WHERE mint = $5 AND side = $6 AND state = 'active' AND expires_at < now()
          RETURNING claim_id, expires_at`,
        [claimId, this.owner, String(ttlMs), payloadJson, params.mint, params.side]
      );
      if (stolen.rows?.length) {
        this.claimsAcquired++;
        return {
          acquired: true,
          claimId,
          owner: this.owner,
          heldBy: this.owner,
          expiresAt: toIso(stolen.rows[0].expires_at),
          reason: "retomado-expirado",
          detail: "claim anterior havia EXPIRADO (processo que o criou não liberou) e foi retomado",
        };
      }

      const vigente = await this.client.query(
        `SELECT owner, expires_at FROM entry_claims
          WHERE mint = $1 AND side = $2 AND state = 'active' LIMIT 1`,
        [params.mint, params.side]
      );
      this.claimsRefused++;
      return {
        acquired: false,
        claimId: null,
        owner: this.owner,
        heldBy: vigente.rows?.[0]?.owner ?? null,
        expiresAt: toIso(vigente.rows?.[0]?.expires_at),
        reason: "ocupado",
        detail:
          `outro processo (${vigente.rows?.[0]?.owner ?? "desconhecido"}) detém o voo único deste mint ` +
          `até ${toIso(vigente.rows?.[0]?.expires_at) ?? "expiração desconhecida"}`,
      };
    } catch (err: any) {
      this.lastError = `claimEntry: ${err?.message ?? String(err)}`;
      return {
        acquired: false,
        claimId: null,
        owner: this.owner,
        heldBy: null,
        expiresAt: null,
        reason: "banco-indisponivel",
        detail: `falha ao consultar o banco: ${err?.message ?? String(err)}`,
      };
    }
  }

  /**
   * Libera o claim. Só o `claimId` detentor consegue liberar: assim, um processo que perdeu o claim
   * por expiração não libera o claim de outro (o que abriria a porta para dois processos entrarem).
   */
  public async releaseEntryClaim(claimId: string, payload?: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await this.client.query(
        `UPDATE entry_claims
            SET state = 'released', released_at = now(), payload = COALESCE($2, payload)
          WHERE claim_id = $1 AND state = 'active'
          RETURNING claim_id`,
        [claimId, payload ? JSON.stringify(payload) : null]
      );
      return Boolean(res.rows?.length);
    } catch (err: any) {
      this.writeFailures++;
      this.lastError = `releaseEntryClaim: ${err?.message ?? String(err)}`;
      return false;
    }
  }

  public async listActiveClaims(): Promise<
    Array<{
      claimId: string;
      mint: string;
      side: string;
      owner: string;
      acquiredAt: string | null;
      expiresAt: string | null;
      expired: boolean;
    }>
  > {
    const res = await this.client.query(
      `SELECT claim_id, mint, side, owner, acquired_at, expires_at, (expires_at < now()) AS expired
         FROM entry_claims WHERE state = 'active' ORDER BY acquired_at DESC LIMIT 200`
    );
    return (res.rows ?? []).map((r: any) => ({
      claimId: String(r.claim_id),
      mint: String(r.mint),
      side: String(r.side),
      owner: String(r.owner),
      acquiredAt: toIso(r.acquired_at),
      expiresAt: toIso(r.expires_at),
      expired: r.expired === true || r.expired === "t",
    }));
  }

  /* ------------------------------- espelho ------------------------------- */

  public mirrorPosition(pos: Record<string, any>): Promise<boolean> {
    return this.write(
      `INSERT INTO positions (id, mint, token, mode, status, size_sol, entry_price, current_price,
                              pnl_percent, time_opened, time_closed, exit_attempts, last_exit_error,
                              execution_intent_id, payload, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status, current_price = EXCLUDED.current_price,
         pnl_percent = EXCLUDED.pnl_percent, time_closed = EXCLUDED.time_closed,
         exit_attempts = EXCLUDED.exit_attempts, last_exit_error = EXCLUDED.last_exit_error,
         payload = EXCLUDED.payload, updated_at = now()`,
      [
        pos.id, pos.mint, pos.token ?? null, pos.mode ?? null, pos.status,
        numberOrNull(pos.sizeSol), numberOrNull(pos.entryPrice), numberOrNull(pos.currentPrice),
        numberOrNull(pos.pnlPercent), isoOrNull(pos.timeOpened), isoOrNull(pos.timeClosed),
        Number.isFinite(pos.exitAttempts) ? pos.exitAttempts : null, pos.lastExitError ?? null,
        pos.executionIntentId ?? null, JSON.stringify(pos),
      ],
      "mirrorPosition"
    );
  }

  public mirrorTrade(trade: Record<string, any>): Promise<boolean> {
    return this.write(
      `INSERT INTO trades (id, mint, token, status, mode, signature, pnl_net_sol, fees_sol,
                           slippage_bps, measured_on_chain, traded_at, payload, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status, signature = EXCLUDED.signature, pnl_net_sol = EXCLUDED.pnl_net_sol,
         fees_sol = EXCLUDED.fees_sol, slippage_bps = EXCLUDED.slippage_bps,
         measured_on_chain = EXCLUDED.measured_on_chain, payload = EXCLUDED.payload, updated_at = now()`,
      [
        trade.id, trade.mint, trade.token ?? null, trade.status ?? "unknown", trade.mode ?? null,
        trade.signature ?? null, numberOrNull(trade.pnlNetSol), numberOrNull(trade.feesSol),
        numberOrNull(trade.slippageBps), trade.measuredOnChain === true,
        isoOrNull(trade.time), JSON.stringify(trade),
      ],
      "mirrorTrade"
    );
  }

  public mirrorIntent(intent: Record<string, any>): Promise<boolean> {
    return this.write(
      `INSERT INTO intents (id, position_id, mint, side, state, attempt, signature,
                            last_valid_block_height, payload, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (id) DO UPDATE SET
         state = EXCLUDED.state, attempt = EXCLUDED.attempt, signature = EXCLUDED.signature,
         last_valid_block_height = EXCLUDED.last_valid_block_height, payload = EXCLUDED.payload,
         updated_at = now()`,
      [
        intent.id, intent.positionId ?? null, intent.mint, intent.side, intent.state,
        Number.isFinite(intent.attempt) ? intent.attempt : null, intent.signature ?? null,
        Number.isFinite(intent.lastValidBlockHeight) ? intent.lastValidBlockHeight : null,
        JSON.stringify(intent),
      ],
      "mirrorIntent"
    );
  }

  /** Log de decisão. O filtro de nível é aplicado AQUI (não no chamador) para não haver dúvida. */
  public mirrorLog(log: Record<string, any>): Promise<boolean> {
    const level = String(log.level ?? "INFO").toUpperCase();
    if (this.policy.mirrorLogs === "off") return Promise.resolve(false);
    if (this.policy.mirrorLogs === "critical" && !["WARN", "WARNING", "ERROR", "CRITICAL", "FATAL"].includes(level)) {
      return Promise.resolve(false);
    }
    return this.write(
      `INSERT INTO decision_logs (level, component, message, correlation, payload)
       VALUES ($1,$2,$3,$4,$5)`,
      [level, String(log.component ?? "?"), String(log.message ?? ""), log.correlationId ?? null, JSON.stringify(log)],
      "mirrorLog"
    );
  }

  /* --------------------------- leitura (S9) ------------------------------ */

  /**
   * Histórico para a validação estatística. `mode` e `status` são FILTROS EXPLÍCITOS: somar paper com
   * live é o erro que produz "PnL" que não corresponde a dinheiro nenhum.
   */
  public async fetchTrades(filter: { mode?: "live" | "paper"; limit?: number }): Promise<Array<Record<string, any>>> {
    const limit = Math.min(filter.limit ?? this.policy.historyLimit, this.policy.historyLimit);
    const res = await this.client.query(
      `SELECT payload FROM trades
        WHERE ($1::text IS NULL OR mode = $1)
        ORDER BY COALESCE(traded_at, updated_at) DESC
        LIMIT $2`,
      [filter.mode ?? null, limit]
    );
    return (res.rows ?? []).map((r: any) => r.payload);
  }

  public async counts(): Promise<{ positions: number; trades: number; intents: number; logs: number; activeClaims: number }> {
    const res = await this.client.query(
      `SELECT
         (SELECT count(*) FROM positions)      AS positions,
         (SELECT count(*) FROM trades)         AS trades,
         (SELECT count(*) FROM intents)        AS intents,
         (SELECT count(*) FROM decision_logs)  AS logs,
         (SELECT count(*) FROM entry_claims WHERE state = 'active') AS active_claims`
    );
    const row = res.rows?.[0] ?? {};
    return {
      positions: Number(row.positions ?? 0),
      trades: Number(row.trades ?? 0),
      intents: Number(row.intents ?? 0),
      logs: Number(row.logs ?? 0),
      activeClaims: Number(row.active_claims ?? 0),
    };
  }

  public async close(): Promise<void> {
    try {
      await this.client.end();
    } catch {
      /* já fechado */
    }
    this.connected = false;
  }
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
