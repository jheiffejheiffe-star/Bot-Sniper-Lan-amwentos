/**
 * FEED PUMPPORTAL — o melhor instrumento GRATUITO de detecção de lançamento.
 *
 * ## O que faz
 *
 * Assina `subscribeNewToken` e `subscribeMigration` em `wss://pumpportal.fun/api/data`
 * (ambos **gratuitos e sem chave**, conforme a documentação do provedor) e entrega o evento de
 * lançamento **já com o endereço do mint**.
 *
 * ## Por que isto importa (motivo MEDIDO no S5)
 *
 * O caminho anterior detectava por `logsSubscribe` e só descobria o mint depois de
 * `getTransaction` — e `getTransaction` **não aceita `processed`** (tipo `Finality` do
 * `@solana/web3.js` + documentação da RPC): é obrigatório esperar `confirmed`. Ou seja, todo
 * lançamento pagava um RTT + espera de confirmação **antes** de qualquer decisão. Este feed
 * entrega o mint na notificação: o estágio de enriquecimento passa a custar ~0 neste caminho.
 *
 * ## Como funciona
 *
 * - Uma ÚNICA conexão por processo. A documentação do provedor é explícita: abrir várias
 *   conexões pode render banimento ("PLEASE ONLY USE ONE WEBSOCKET CONNECTION AT A TIME";
 *   banimentos expiram a cada hora). `connect()` é idempotente por construção.
 * - Reconexão com backoff exponencial + jitter e teto (60 s), porque reconectar em rajada é
 *   justamente o comportamento que causa banimento.
 * - Dedupe por assinatura (o mesmo evento pode chegar ao reconectar), reutilizando
 *   `SeenLaunchSignatures` do caminho quente.
 * - Parsing DEFENSIVO: a página de documentação não lista os campos da mensagem. Portanto o
 *   parser exige apenas `mint` estruturalmente válido e trata todo o resto como opcional —
 *   campo ausente vira `null`, nunca valor inventado. `fields` registra o que a mensagem
 *   trouxe, para auditoria e para evolução sem adivinhação.
 *
 * ## Dependências
 *
 * Zero. Usa o `WebSocket` global (Node ≥ 22) por padrão e aceita `wsFactory` injetada —
 * é o que permite testar o feed inteiro sem abrir socket de verdade.
 *
 * ## Riscos e limites
 *
 * - **É um serviço de terceiro.** Se cair, a detecção de pump.fun cai junto; por isso o
 *   `logsSubscribe` do RPC continua ativo como fonte independente e o health mostra as duas.
 * - O feed é de DADOS, não de execução: nada aqui assina ou envia.
 * - Lançamentos de Raydium/Meteora não vêm por aqui — continuam exclusivamente no WSS do RPC.
 * - Sem confirmação de cadeia: a mensagem indica que alguém criou o token; ela não é prova de
 *   que a transação foi finalizada. A verificação on-chain segue sendo feita no filtro profundo.
 *
 * ## Como testar
 *
 * `npm run test` — grupo [18]: subscribe único, idempotência de conexão, parsing defensivo,
 * dedupe, contadores e backoff (com socket e agendador falsos, sem rede).
 *
 * ## Como colocar em produção
 *
 * `HFT_PUMPPORTAL=0` desliga. `PUMPPORTAL_WS_URL` troca o host (teste/A-B). Os contadores
 * aparecem em `GET /api/health → pumpPortal`.
 */

import { SeenLaunchSignatures } from "./hotPath.js";

/** Socket mínimo aceito — o que o `WebSocket` global (WHATWG) e o pacote `ws` têm em comum. */
export interface MinimalSocket {
  send(data: string): void;
  close(): void;
  addEventListener?(type: string, listener: (ev: any) => void): void;
  on?(type: string, listener: (ev: any) => void): void;
  readyState?: number;
}

export interface PumpPortalEvent {
  /** Endereço do token criado — o dado que no caminho antigo exigia `getTransaction`. */
  mint: string;
  name: string | null;
  symbol: string | null;
  signature: string | null;
  /** "create" | "migrate" | "unknown" — nunca inferido além do que a mensagem informa. */
  txType: "create" | "migrate" | "unknown";
  /** Métricas que a mensagem eventualmente traz (SOL). `null` = não veio. */
  marketCapSol: number | null;
  initialBuySol: number | null;
  receivedAt: number;
  source: "pumpportal";
  /** Nomes dos campos presentes na mensagem — auditoria do contrato real observado. */
  fields: string[];
}

export type PumpPortalParseResult =
  | { ok: true; event: PumpPortalEvent }
  | { ok: false; reason: string };

/** Base58 estrutural (sem 0/O/I/l). Validação profunda é feita com PublicKey no pipeline. */
const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function finiteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Parsing puro de uma mensagem do feed. Regras, em ordem:
 *   1. JSON válido e objeto;
 *   2. `mint` presente e estruturalmente válido (é o único campo obrigatório);
 *   3. `txType` conhecido → mapeado; desconhecido → `"unknown"` (jamais chutado);
 *   4. demais campos opcionais, convertidos só quando numéricos de verdade.
 */
export function parsePumpPortalMessage(raw: string, receivedAt: number): PumpPortalParseResult {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "JSON inválido" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "mensagem não é objeto JSON" };
  }

  const mint = typeof parsed.mint === "string" ? parsed.mint.trim() : "";
  if (!mint) return { ok: false, reason: "mensagem sem campo `mint`" };
  if (!BASE58_PUBKEY.test(mint)) {
    return { ok: false, reason: `mint estruturalmente inválido: "${mint.slice(0, 16)}"` };
  }

  const rawType = typeof parsed.txType === "string" ? parsed.txType.toLowerCase() : "";
  const txType: PumpPortalEvent["txType"] =
    rawType === "create" ? "create" : rawType === "migrate" ? "migrate" : "unknown";

  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

  return {
    ok: true,
    event: {
      mint,
      name: str(parsed.name),
      symbol: str(parsed.symbol),
      signature: str(parsed.signature),
      txType,
      marketCapSol: finiteNumber(parsed.marketCapSol),
      initialBuySol: finiteNumber(parsed.initialBuy),
      receivedAt,
      source: "pumpportal",
      fields: Object.keys(parsed).sort(),
    },
  };
}

export interface PumpPortalFeedOptions {
  /** `onEvent` é chamado só para mensagens válidas e não duplicadas. */
  onEvent: (event: PumpPortalEvent) => void;
  url?: string;
  wsFactory?: (url: string) => MinimalSocket;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => any;
  clearTimer?: (handle: any) => void;
  /** Base do backoff (ms). Teto é `maxBackoffMs`. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Injetável para teste; por padrão usa dedupe próprio de 120 s / 10 000 entradas. */
  dedupe?: SeenLaunchSignatures;
}

export const PUMPPORTAL_DEFAULT_URL = "wss://pumpportal.fun/api/data";

/** Backoff exponencial com jitter, com teto — nunca reconectar em rajada (risco de ban). */
export function pumpPortalBackoffMs(failures: number, baseMs: number, maxMs: number): number {
  const n = Math.max(1, Math.floor(failures));
  const raw = baseMs * Math.pow(2, n - 1);
  const capped = Math.min(raw, maxMs);
  // Jitter determinístico de ±20% a partir do próprio número de falhas: evita sincronizar
  // várias instâncias sem introduzir dependência de RNG (testável).
  const jitter = 1 + (((n * 37) % 41) - 20) / 100;
  return Math.max(250, Math.round(capped * jitter));
}

export class PumpPortalFeed {
  private socket: MinimalSocket | null = null;
  private connected = false;
  private stopped = false;
  private retryHandle: any = null;
  private consecutiveFailures = 0;

  /* Contadores — todos medidos, nenhum estimado. */
  private messagesReceived = 0;
  private eventsEmitted = 0;
  private invalidMessages = 0;
  private duplicatesDropped = 0;
  private connectsAttempted = 0;
  private firstMessageAt: number | null = null;
  private lastMessageAt: number | null = null;
  private lastError: string | null = null;
  private recentErrors: string[] = [];
  private subscriptionsSent: string[] = [];

  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => any;
  private readonly clearTimer: (h: any) => void;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly dedupe: SeenLaunchSignatures;

  constructor(private readonly options: PumpPortalFeedOptions) {
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.dedupe = options.dedupe ?? new SeenLaunchSignatures(120_000, 10_000);
  }

  private get url(): string {
    return this.options.url ?? PUMPPORTAL_DEFAULT_URL;
  }

  /** Conexão padrão via `WebSocket` global (Node ≥ 22). Falha explícita, nunca silenciosa. */
  private defaultFactory(url: string): MinimalSocket {
    const WS = (globalThis as any).WebSocket;
    if (typeof WS !== "function") {
      throw new Error(
        "WebSocket global indisponível: este feed requer Node >= 22 (ou injetar wsFactory)."
      );
    }
    return new WS(url) as MinimalSocket;
  }

  /** Liga eventos aceitando tanto a API WHATWG quanto a do pacote `ws`. */
  private bind(socket: MinimalSocket, type: string, handler: (ev: any) => void): void {
    if (typeof socket.addEventListener === "function") {
      socket.addEventListener(type, handler);
      return;
    }
    if (typeof socket.on === "function") {
      // No pacote `ws`, o handler de "message" recebe o dado direto (não um evento).
      socket.on(type, (arg: any) => handler(type === "message" ? { data: arg } : arg));
      return;
    }
    throw new Error("socket sem addEventListener/on: não é possível observar eventos");
  }

  private recordError(message: string): void {
    this.lastError = message;
    this.recentErrors.push(`${new Date(this.now()).toISOString()} ${message}`);
    if (this.recentErrors.length > 10) this.recentErrors.shift();
  }

  /**
   * Abre a conexão (uma só). Chamar de novo com socket vivo é no-op DELIBERADO: a doc do
   * provedor informa que múltiplas conexões podem causar banimento.
   */
  public connect(): void {
    if (this.stopped) return;
    if (this.socket) return;

    const factory = this.options.wsFactory ?? ((u: string) => this.defaultFactory(u));
    let socket: MinimalSocket;
    try {
      socket = factory(this.url);
    } catch (err: any) {
      this.recordError(`falha ao criar socket: ${err?.message ?? err}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.connectsAttempted++;

    this.bind(socket, "open", () => {
      this.connected = true;
      this.consecutiveFailures = 0;
      this.subscriptionsSent = [];
      for (const method of ["subscribeNewToken", "subscribeMigration"]) {
        try {
          socket.send(JSON.stringify({ method }));
          this.subscriptionsSent.push(method);
        } catch (err: any) {
          this.recordError(`falha ao enviar ${method}: ${err?.message ?? err}`);
        }
      }
    });

    this.bind(socket, "message", (ev: any) => {
      const raw = typeof ev?.data === "string" ? ev.data : String(ev?.data ?? "");
      this.messagesReceived++;
      const at = this.now();
      if (this.firstMessageAt === null) this.firstMessageAt = at;
      this.lastMessageAt = at;

      const parsed = parsePumpPortalMessage(raw, at);
      if (!parsed.ok) {
        this.invalidMessages++;
        // Só registra o motivo: o conteúdo bruto pode ser grande e não ajuda no diagnóstico.
        this.recordError(`mensagem ignorada: ${parsed.reason}`);
        return;
      }

      // Dedupe: sem assinatura, usa o mint (o mesmo token criado duas vezes é o MESMO evento).
      const key = parsed.event.signature ?? `mint:${parsed.event.mint}`;
      if (!this.dedupe.firstSight(key, at)) {
        this.duplicatesDropped++;
        return;
      }

      this.eventsEmitted++;
      try {
        this.options.onEvent(parsed.event);
      } catch (err: any) {
        // Falha do consumidor não pode derrubar o feed.
        this.recordError(`onEvent lançou: ${err?.message ?? err}`);
      }
    });

    this.bind(socket, "error", (ev: any) => {
      this.recordError(`erro no socket: ${ev?.message ?? "sem detalhe"}`);
    });

    this.bind(socket, "close", () => {
      this.connected = false;
      this.socket = null;
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryHandle !== null) return;
    this.consecutiveFailures++;
    const delay = pumpPortalBackoffMs(this.consecutiveFailures, this.baseBackoffMs, this.maxBackoffMs);
    this.retryHandle = this.setTimer(() => {
      this.retryHandle = null;
      this.connect();
    }, delay);
  }

  /** Encerra: cancela reconexão e fecha o socket. Idempotente. */
  public stop(): void {
    this.stopped = true;
    if (this.retryHandle !== null) {
      this.clearTimer(this.retryHandle);
      this.retryHandle = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    if (socket) {
      try {
        if (this.subscriptionsSent.length > 0) {
          socket.send(JSON.stringify({ method: "unsubscribeNewToken" }));
        }
      } catch {
        /* best-effort: nunca lançar de dentro de cleanup */
      }
      try {
        socket.close();
      } catch {
        /* idem */
      }
      this.subscriptionsSent = [];
    }
  }

  public getHealth() {
    const now = this.now();
    return {
      source: "pumpportal (terceiro)",
      url: this.url,
      socketOpen: this.connected,
      subscriptionsSent: [...this.subscriptionsSent],
      connectsAttempted: this.connectsAttempted,
      consecutiveFailures: this.consecutiveFailures,
      /** Prova de vida é `eventsEmitted > 0` — não o log de conexão. */
      messagesReceived: this.messagesReceived,
      eventsEmitted: this.eventsEmitted,
      invalidMessages: this.invalidMessages,
      duplicatesDropped: this.duplicatesDropped,
      firstMessageAt: this.firstMessageAt,
      lastMessageAt: this.lastMessageAt,
      sinceLastMessageMs: this.lastMessageAt === null ? null : now - this.lastMessageAt,
      degraded: !this.connected,
      lastError: this.lastError,
      recentErrors: [...this.recentErrors],
      caveat:
        "Serviço de TERCEIRO: entrega o mint na criação do token (sem getTransaction). Se cair, " +
        "o logsSubscribe do RPC continua como fonte independente. Não é confirmação de cadeia.",
    };
  }
}
