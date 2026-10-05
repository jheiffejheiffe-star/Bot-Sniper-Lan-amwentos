/**
 * INGESTÃO gRPC (YELLOWSTONE) — S7.
 *
 * ## O que faz
 *
 * Assina o stream de transações do programa pump via gRPC (Yellowstone/Geyser) no nível
 * `processed` e entrega lançamentos prontos ao pipeline. Substitui, no caminho de detecção, o
 * `logsSubscribe` do WebSocket RPC + `getTransaction` — que é onde estava o gargalo MEDIDO no
 * caminho antigo: a notificação chega em `processed`, mas `getTransaction` **não aceita**
 * `processed` (só `confirmed`/`finalized`), então o enriquecimento esperava confirmação e ainda
 * pagava repetições de 80 ms quando o nó não tinha indexado a transação.
 *
 * Com gRPC, a transação inteira (mensagem + meta + logs) chega no MESMO evento que a anuncia:
 * zero RTT de enriquecimento e zero `getTransaction`. O ganho não é "mais rápido" no abstrato —
 * é a eliminação de uma espera estrutural (confirmação) e de uma chamada RPC por lançamento.
 *
 * ## Como funciona
 *
 * - Um filtro `transactions` com `accountInclude: [pump program]`, `vote: false`, `failed: false`.
 * - Cada update é normalizado e decodificado por funções PURAS (`src/pumpEvents.ts`): o lançamento
 *   é reconhecido pelo `CreateEvent` nos logs, e o mint vem do PRÓPRIO evento — não de heurística
 *   sobre saldos de token.
 * - Dedupe por assinatura (reentrega de stream/reconexão não pode virar segunda compra).
 * - Reconexão com backoff exponencial e teto, mais `ping` periódico (o provedor derruba stream
 *   ocioso; sem ping, a conexão "viva" para de entregar e o operador só descobre pelo silêncio).
 * - Health com os MESMOS campos do cliente WSS, para o painel não precisar saber qual transporte
 *   está ativo — e para `eventCount` continuar sendo a única prova de detecção.
 *
 * ## Dependências
 *
 * O cliente protobuf é INJETADO (`GrpcClientLike`). Em produção o adaptador é
 * `src/grpcYellowstoneClient.ts` (carrega `@triton-one/yellowstone-grpc` sob demanda); nos testes é
 * um dublê. Assim este módulo não depende do binário nativo para ser testado, e uma falha de
 * carregamento da biblioteca vira `degraded` declarado — não uma queda do processo.
 *
 * ## Riscos
 *
 * 1. **Provedor pago/limitado.** O gRPC de produção (Yellowstone dedicado) é serviço de terceiro.
 *    A ausência dele não impede operar: sem `GEYSER_GRPC_URL` o bot fica no caminho WSS, que
 *    funciona e é declarado como mais lento.
 * 2. **`processed` não é final.** A transação vista em `processed` pode não entrar no bloco
 *    (fork). Isso já era verdade no caminho WSS e é tratado adiante: a entrada real só existe com
 *    confirmação observada (o `realEntry` exige slot; `submitted_unconfirmed` é estado próprio).
 *    Detecção em `processed` é para ser RÁPIDO; a decisão de capital continua exigindo confirmação.
 * 3. **Token de autenticação é segredo.** Ele nunca é logado: o endpoint passa por
 *    `redactGrpcEndpoint` e os erros passam por `sanitizeGrpcError`. Há teste que varre o código.
 * 4. **Evento pode ganhar campos.** O decoder devolve `trailingBytes`; o lançamento continua
 *    utilizável e o aviso aparece no próprio evento (`warnings`).
 *
 * ## Como testar
 *
 * Grupo [26] de `npm run test`: política/coerência de configuração, redação do token, decodificação
 * de um update sintético (inclusive `err`≠null, voto, transação sem `CreateEvent`, truncada),
 * dedupe, backoff, e o caminho de falha ao carregar o cliente nativo.
 *
 * ## Como colocar em produção
 *
 * `GEYSER_GRPC_URL=...` + `GEYSER_GRPC_TOKEN=...` e `HFT_INGEST=grpc` (ou deixe `auto`, que usa
 * gRPC quando configurado). Se o cliente não carregar ou o stream não conectar, o health mostra
 * `degraded: true` com o motivo e o operador volta para WSS sabendo o que aconteceu.
 */

import { findCreateEvent, findCurveTerminalEvent } from "./pumpEvents.js";
import type { LaunchEvent } from "./realExecution.js";

/* -------------------------------------------------------------------------- */
/* 1. POLÍTICA E CONFIGURAÇÃO (puro)                                           */
/* -------------------------------------------------------------------------- */

export type IngestMode = "auto" | "grpc" | "wss";

export interface IngestPolicy {
  /** O que o operador PEDIU (`HFT_INGEST`). */
  requested: IngestMode;
  /** O que será usado de fato, dadas as credenciais presentes. */
  effective: "grpc" | "wss";
  urlConfigured: boolean;
  tokenConfigured: boolean;
  /** Motivos MEDIDOS para não usar gRPC (vazio quando `effective === "grpc"`). */
  blockers: string[];
  /** Avisos que não impedem operar. */
  notes: string[];
}

export function resolveIngestPolicy(env: NodeJS.ProcessEnv = process.env): IngestPolicy {
  const raw = (env.HFT_INGEST ?? "auto").trim().toLowerCase();
  const requested: IngestMode = raw === "grpc" || raw === "wss" ? raw : "auto";
  const url = (env.GEYSER_GRPC_URL ?? "").trim();
  const token = (env.GEYSER_GRPC_TOKEN ?? "").trim();
  const urlConfigured = url !== "";
  const tokenConfigured = token !== "";
  const blockers: string[] = [];
  const notes: string[] = [];

  if (tokenConfigured && !urlConfigured) {
    // Segredo sem endpoint é sinal de configuração pela metade: o token está sobrando no ambiente.
    blockers.push("GEYSER_GRPC_TOKEN definido sem GEYSER_GRPC_URL");
  }

  if (requested === "wss") {
    if (urlConfigured) {
      notes.push("HFT_INGEST=wss força o caminho WebSocket mesmo com GEYSER_GRPC_URL definido");
    }
    return { requested, effective: "wss", urlConfigured, tokenConfigured, blockers, notes };
  }

  if (!urlConfigured) {
    if (requested === "grpc") blockers.push("HFT_INGEST=grpc exige GEYSER_GRPC_URL");
    return { requested, effective: "wss", urlConfigured, tokenConfigured, blockers, notes };
  }

  return { requested, effective: "grpc", urlConfigured, tokenConfigured, blockers, notes };
}

/** Coerência mínima do endpoint, avaliada ANTES de tentar conectar (falhar cedo é mais barato). */
export function assessGrpcEndpoint(url: string): { ok: boolean; problem: string | null } {
  const trimmed = url.trim();
  if (trimmed === "") return { ok: false, problem: "endpoint vazio" };
  if (/^https?:\/\//i.test(trimmed)) {
    return { ok: false, problem: "endpoint parece HTTP: gRPC usa host:porta (ex.: grpc.exemplo.com:443)" };
  }
  if (/^wss?:\/\//i.test(trimmed)) {
    return { ok: false, problem: "endpoint parece WebSocket: gRPC usa host:porta, sem esquema de URL" };
  }
  if (/\/$/.test(trimmed)) {
    return { ok: false, problem: "endpoint tem barra final: informe host:porta sem caminho" };
  }
  if (!/^[^\s]+:\d{1,5}$/.test(trimmed)) {
    return { ok: false, problem: "endpoint sem porta explícita (ex.: grpc.exemplo.com:443)" };
  }
  const port = Number(trimmed.slice(trimmed.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, problem: `porta inválida: ${port}` };
  }
  return { ok: true, problem: null };
}

/**
 * Redige o endpoint para LOG. O token de autenticação viaja em header/metadata, mas nada impede
 * um operador colar credencial na URL (`user:pass@host`): então credenciais de URL são removidas
 * e o resto é preservado — log útil sem segredo.
 */
export function redactGrpcEndpoint(url: string): string {
  const trimmed = url.trim();
  if (trimmed === "") return "(não configurado)";
  /**
   * Cobre as DUAS formas em que uma credencial pode aparecer: com esquema
   * (`grpc://user:senha@host:443`) e sem esquema (`user:senha@host:443`). A primeira versão só
   * tratava a primeira forma — o teste pegou a segunda, que é justamente a que um operador cola
   * no `.env` quando o campo pede "host:porta".
   */
  return trimmed
    .replace(/(\/\/)([^/@\s]+)@/, "$1***@")
    .replace(/^([^/@\s:]+):([^/@\s]+)@/, "***@");
}

/** Remove qualquer ocorrência do token de uma mensagem de erro antes de logar/expor. */
export function sanitizeGrpcError(message: string, token?: string): string {
  let out = message ?? "";
  const secret = (token ?? "").trim();
  if (secret.length >= 8) {
    out = out.split(secret).join("***");
  }
  return out.replace(/(x-token|authorization)[=:]\s*\S+/gi, "$1=***");
}

/* -------------------------------------------------------------------------- */
/* 2. TIPOS DO CLIENTE (estrutural — o adaptador real implementa)              */
/* -------------------------------------------------------------------------- */

export interface GrpcTransactionUpdate {
  /** Corpo do update JÁ normalizado pelo adaptador (bytes → hex/strings quando aplicável). */
  slot: number;
  signature: string;
  /** `true` quando a transação falhou (`meta.err` preenchido). */
  failed: boolean;
  isVote: boolean;
  logMessages: string[];
  accountKeys: string[];
}

export interface GrpcStreamLike {
  on(event: "data", listener: (update: unknown) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  /** Envia um comando no stream (usado para `ping` de manutenção). */
  write?(chunk: unknown, cb?: (err?: Error | null) => void): unknown;
  destroy?(err?: Error): unknown;
  cancel?(): void;
}

export interface GrpcClientLike {
  connect(): Promise<void>;
  subscribe(request: unknown): Promise<GrpcStreamLike>;
  /** Slot atual — usado para medir arrasto relativo (amostra em segundo plano, 1x/2s). */
  getSlot?(): Promise<number | null>;
  close?(): void;
  /** Normaliza o update bruto do protobuf. Fica no adaptador para o núcleo ser testável. */
  normalizeTransactionUpdate(raw: unknown): GrpcTransactionUpdate | null;
  /** Monta o pedido de assinatura para o programa informado. */
  buildTransactionSubscribeRequest(programId: string, commitment: "processed" | "confirmed"): unknown;
  /** Comando de keep-alive do provedor. */
  buildPingRequest?(id: number): unknown;
}

export type GrpcClientFactory = () => Promise<GrpcClientLike>;

/* -------------------------------------------------------------------------- */
/* 3. CLIENTE DE INGESTÃO                                                      */
/* -------------------------------------------------------------------------- */

export interface GrpcIngestOptions {
  url: string;
  token: string;
  programId: string;
  /** Intervalo entre pings de manutenção. Default 15s. */
  pingIntervalMs?: number;
  /** Backoff inicial de reconexão. Default 1s (dobra até `maxBackoffMs`). */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Quantas tentativas antes de desistir e cair para WSS, se houver fallback. 0 = infinito. */
  maxReconnectAttempts?: number;
  /** Injetável para teste. Default: `Date.now`. */
  now?: () => number;
}

/** Assinatura do handler de lançamento — deliberadamente igual à do cliente WSS. */
export type LaunchHandler = (event: LaunchEvent) => void;

export class GrpcIngestClient {
  private client: GrpcClientLike | null = null;
  private stream: GrpcStreamLike | null = null;
  private callback: LaunchHandler | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly seen = new Set<string>();
  private seenOrder: string[] = [];
  private readonly seenCapacity = 50_000;

  private eventCount = 0;
  private lastEventAt = 0;
  private duplicatesDropped = 0;
  private decodeFailures = 0;
  private streamOpen = false;
  private connecting = false;
  private closed = false;
  private reconnectAttempts = 0;
  /** Total de reconexões desde o boot — NÃO é zerado no sucesso: é isto que conta a história. */
  private reconnectsTotal = 0;
  private readonly errors: string[] = [];
  private lastLocalSlot: number | null = null;
  private lastLocalSlotAt = 0;
  private slotRefreshInFlight = false;
  /** Updates recebidos do stream (inclui trades e ruído): mede se o canal está vivo. */
  private updatesSeen = 0;
  private lastUpdateAt = 0;
  private readonly startedAt = Date.now();

  constructor(
    private readonly factory: GrpcClientFactory,
    private readonly opts: GrpcIngestOptions
  ) {}

  public onTokenDetected(cb: LaunchHandler): void {
    this.callback = cb;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  public async connect(): Promise<void> {
    this.closed = false;
    await this.attemptConnect();
  }

  private async attemptConnect(): Promise<void> {
    if (this.closed || this.connecting) return;
    this.connecting = true;
    try {
      const client = await this.factory();
      await client.connect();
      const request = client.buildTransactionSubscribeRequest(this.opts.programId, "processed");
      const stream = await client.subscribe(request);
      if (this.closed) {
        stream.destroy?.();
        return;
      }
      this.client = client;
      this.stream = stream;
      this.streamOpen = true;
      this.reconnectAttempts = 0;

      stream.on("data", (raw: unknown) => this.handleUpdate(raw));
      stream.on("error", (err: Error) => {
        this.pushError(`erro no stream: ${sanitizeGrpcError(err?.message ?? String(err), this.opts.token)}`);
        this.scheduleReconnect("erro no stream");
      });
      stream.on("end", () => this.scheduleReconnect("stream encerrado pelo provedor"));
      stream.on("close", () => this.scheduleReconnect("stream fechado"));

      this.startPing();
      console.log(
        `[GeyserClient] gRPC conectado em ${redactGrpcEndpoint(this.opts.url)} ` +
          `(filtro: transações do programa ${this.opts.programId.slice(0, 8)}…, commitment=processed). ` +
          `Sem getTransaction no enriquecimento: o mint vem do CreateEvent do próprio stream.`
      );
    } catch (err: any) {
      const reason = sanitizeGrpcError(err?.message ?? String(err), this.opts.token);
      this.pushError(`falha ao conectar/assinar: ${reason}`);
      this.streamOpen = false;
      this.scheduleReconnect(`falha ao conectar: ${reason}`);
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Reconexão com backoff exponencial e teto. O contador de tentativas é zerado a cada stream
   * aberto com sucesso: sem isso, uma queda depois de horas de operação herdaria o backoff alto
   * de uma instabilidade antiga e a retomada demoraria minutos.
   */
  private scheduleReconnect(reason: string): void {
    if (this.closed) return;
    /**
     * O MOTIVO entra no health. Antes ele só era impresso no console: um operador que abrisse
     * `/api/health` veria `connected: false` sem saber se foi queda de rede, token inválido ou o
     * provedor encerrando o stream — três problemas com encaminhamentos completamente diferentes.
     */
    this.pushError(`reconexão agendada: ${reason}`);
    this.stopPing();
    this.streamOpen = false;
    try {
      this.stream?.destroy?.();
    } catch {
      /* já morto */
    }
    this.stream = null;

    const maxAttempts = this.opts.maxReconnectAttempts ?? 0;
    this.reconnectAttempts++;
    this.reconnectsTotal++;
    if (maxAttempts > 0 && this.reconnectAttempts > maxAttempts) {
      this.pushError(
        `desistindo do gRPC após ${this.reconnectAttempts - 1} tentativa(s) — ` +
          `o caminho WSS (se configurado) assume a detecção`
      );
      return;
    }
    const initial = this.opts.initialBackoffMs ?? 1_000;
    const max = this.opts.maxBackoffMs ?? 30_000;
    const delay = Math.min(max, initial * 2 ** Math.min(this.reconnectAttempts - 1, 10));
    console.warn(
      `[GeyserClient] gRPC: ${reason}. Reconectando em ${delay}ms ` +
        `(tentativa ${this.reconnectAttempts}${maxAttempts > 0 ? `/${maxAttempts}` : ""}).`
    );
    this.reconnectTimer = setTimeout(() => {
      void this.attemptConnect();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    const interval = this.opts.pingIntervalMs ?? 15_000;
    if (!this.client?.buildPingRequest) return;
    let id = 0;
    this.pingTimer = setInterval(() => {
      if (!this.stream?.write) return;
      try {
        this.stream.write(this.client!.buildPingRequest!(++id));
      } catch (err: any) {
        this.pushError(`falha ao enviar ping: ${sanitizeGrpcError(err?.message ?? String(err), this.opts.token)}`);
      }
    }, interval);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private pushError(message: string): void {
    this.errors.push(message);
    if (this.errors.length > 20) this.errors.shift();
  }

  /** Dedupe com capacidade LIMITADA: sem isso, o conjunto cresceria sem teto em memória. */
  private firstSight(signature: string): boolean {
    if (this.seen.has(signature)) return false;
    this.seen.add(signature);
    this.seenOrder.push(signature);
    if (this.seenOrder.length > this.seenCapacity) {
      const oldest = this.seenOrder.shift();
      if (oldest) this.seen.delete(oldest);
    }
    return true;
  }

  private handleUpdate(raw: unknown): void {
    this.updatesSeen++;
    this.lastUpdateAt = this.now();
    const client = this.client;
    if (!client) return;

    const update = client.normalizeTransactionUpdate(raw);
    if (!update) {
      // Update de outro tipo (slot, conta, ping): não é erro de decodificação.
      return;
    }

    this.refreshLocalSlotInBackground(update.slot);

    // Transação falhada não cria nada: o evento de criação não existiria no log de sucesso.
    if (update.failed || update.isVote) return;
    if (!this.firstSight(update.signature)) {
      this.duplicatesDropped++;
      return;
    }

    const detectedAt = this.now();
    let create: ReturnType<typeof findCreateEvent>;
    try {
      create = findCreateEvent(update.logMessages);
    } catch (err: any) {
      this.decodeFailures++;
      this.pushError(`falha ao decodificar logs de ${update.signature.slice(0, 12)}…: ${err?.message ?? err}`);
      return;
    }
    if (!create) return; // caso comum: compra/venda/instrução administrativa

    const terminal = findCurveTerminalEvent(update.logMessages);
    if (terminal) {
      /**
       * Curva complete/migrada na MESMA transação da criação é impossível na prática, mas se
       * acontecer o lançamento não é negociável na curva — e o operador precisa saber.
       */
      this.pushError(`transação ${update.signature.slice(0, 12)}… cria e ${terminal === "migrated" ? "migra" : "completa"} a curva`);
      return;
    }

    this.eventCount++;
    this.lastEventAt = detectedAt;

    const receivedSlot = this.lastLocalSlot;
    const slotLagEstimateMs =
      receivedSlot !== null && receivedSlot >= update.slot ? (receivedSlot - update.slot) * 400 : null;

    if (!this.callback) return;
    this.callback({
      programId: this.opts.programId,
      programName: "Pump.fun",
      type: "PoolCreated",
      mint: create.mint,
      // Nome do TOKEN (o evento traz nome e símbolo reais) — antes vinha do mint truncado.
      mintName: (create.symbol || create.name || create.mint.slice(0, 6)).slice(0, 16).toUpperCase(),
      signature: update.signature,
      slot: update.slot,
      receivedSlot,
      slotLagEstimateMs,
      /**
       * MEDIDO: nada. Neste caminho não há enriquecimento (nem RTT de `getTransaction`), então
       * `0` é o valor HONESTO e medido: o mint foi obtido dentro do próprio callback do stream.
       * Deixar `null` sugeriria "desconhecido", mas aqui o valor é conhecido e é zero.
       */
      grpcLatencyMs: 0,
      detectedAt,
      source: "grpc-geyser",
    });
  }

  private refreshLocalSlotInBackground(observedSlot: number): void {
    /**
     * O slot do PRÓPRIO evento já é uma amostra melhor que uma consulta: usamos o maior slot visto
     * e evitamos qualquer chamada quando o stream está entregando. `getSlot` fica como rede de
     * segurança (1x/2s) apenas se o provedor parar de mandar slot nos updates.
     */
    if (observedSlot > (this.lastLocalSlot ?? 0)) {
      this.lastLocalSlot = observedSlot;
      this.lastLocalSlotAt = this.now();
      return;
    }
    const at = this.now();
    if (this.slotRefreshInFlight || at - this.lastLocalSlotAt < 2_000) return;
    if (!this.client?.getSlot) return;
    this.slotRefreshInFlight = true;
    this.lastLocalSlotAt = at;
    void this.client
      .getSlot()
      .then((slot) => {
        if (typeof slot === "number" && slot > 0) this.lastLocalSlot = slot;
      })
      .catch(() => {
        /* sem amostra: mantém a anterior. Nada é inventado. */
      })
      .finally(() => {
        this.slotRefreshInFlight = false;
      });
  }

  public disconnect(): void {
    this.closed = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.stream?.destroy?.();
    } catch {
      /* ignora */
    }
    this.stream = null;
    this.streamOpen = false;
    try {
      this.client?.close?.();
    } catch {
      /* ignora */
    }
    this.client = null;
  }

  /**
   * Health no MESMO formato do cliente WSS. `eventCount` é a única prova de detecção; `degraded`
   * é verdadeiro quando não há stream aberto OU quando nunca chegou update (canal mudo).
   */
  public getHealth() {
    const at = this.now();
    const sinceLastEventMs = this.lastEventAt ? at - this.lastEventAt : null;
    return {
      transport: "grpc-geyser" as const,
      socketOpen: this.streamOpen,
      connected: this.streamOpen,
      subscriptionsRequested: this.streamOpen ? 1 : 0,
      subscriptions: this.streamOpen ? 1 : 0,
      eventCount: this.eventCount,
      lastEventAt: this.lastEventAt || null,
      sinceLastEventMs,
      /** Canal aberto mas sem NENHUM update = stream mudo (pior que fechado: parece vivo). */
      degraded: !this.streamOpen || (this.updatesSeen === 0 && at - this.startedAt > 30_000),
      hotPath: {
        launchesSeen: this.eventCount,
        duplicatesDropped: this.duplicatesDropped,
        enrichmentRetries: 0,
        enrichmentFailures: this.decodeFailures,
        lastLocalSlot: this.lastLocalSlot,
        lastLocalSlotAgeMs: this.lastLocalSlotAt ? at - this.lastLocalSlotAt : null,
      },
      grpc: {
        endpoint: redactGrpcEndpoint(this.opts.url),
        updatesSeen: this.updatesSeen,
        sinceLastUpdateMs: this.lastUpdateAt ? at - this.lastUpdateAt : null,
        decodeFailures: this.decodeFailures,
        /** Reconexões desde o boot (histórico) e o streak atual (usado pelo backoff). */
        reconnectAttempts: this.reconnectsTotal,
        currentBackoffAttempts: this.reconnectAttempts,
      },
      note:
        "Transporte gRPC (Yellowstone, commitment=processed): a transação chega no próprio update, " +
        "sem getTransaction — `enrichmentFailures` aqui conta falhas de DECODIFICAÇÃO, não de RPC. " +
        "A prova de detecção continua sendo eventCount > 0.",
      recentErrors: this.errors.slice(-5),
    };
  }
}
