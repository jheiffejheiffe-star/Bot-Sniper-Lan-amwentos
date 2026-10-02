/**
 * telemetry.ts — MEDIÇÃO REAL DE LATÊNCIA, POR ESTÁGIO.
 *
 * POR QUE ESTE MÓDULO EXISTE
 * --------------------------
 * A auditoria de 2026-10-02 encontrou latências geradas por `Math.random()` no
 * `server.ts` (p95, p99, taxa de inclusão, "grpcLatencyMs"). Um painel que exibe números
 * sorteados é pior do que um painel vazio: ele cria confiança onde não há medição.
 *
 * Este módulo mede o que É medível e diz explicitamente o que NÃO é.
 *
 * DECISÕES TÉCNICAS (cada uma tem consequência):
 *
 *  1. RELÓGIO MONOTÔNICO (`performance.now()`), não `Date.now()`.
 *     `Date.now()` pode andar para trás com ajuste de NTP. Uma medição de latência que
 *     pode ser negativa não serve para diagnosticar gargalo. Para carimbar "quando
 *     aconteceu no mundo" usamos epoch (`Date.now()`); para MEDIR DURAÇÃO, monotônico.
 *
 *  2. HISTOGRAMA, não média.
 *     Latência em Solana tem cauda longa e multimodal (o líder muda a cada ~400ms, e um
 *     evento que cai antes da janela espera 400ms inteiros). Média esconde isso. Reportamos
 *     p50/p95/p99/max por estágio.
 *
 *  3. BUFFER CIRCULAR LIMITADO.
 *     Amostras ilimitadas em processo de longa duração = vazamento de memória. Mantemos
 *     as últimas N amostras por estágio (N=2000 por default).
 *
 *  4. ESTÁGIOS QUE NÃO SÃO MENSURÁVEIS SÃO MARCADOS COMO TAL.
 *     Com `logsSubscribe` (WebSocket RPC) não existe timestamp do evento na origem: só dá
 *     para medir o custo de ENRIQUECIMENTO (callback → getTransaction), não a latência de
 *     DETECÇÃO. Reportamos `detection: { measurable: false, reason: ... }` em vez de
 *     inventar. Com gRPC Yellowstone existe `created_at` do slot, e aí sim a detecção é
 *     mensurável ponta a ponta.
 *
 *  5. LATÊNCIA DE INCLUSÃO É APROXIMADA POR SLOT, E DIZEMOS QUE É APROXIMAÇÃO.
 *     `(slot_confirmado - slot_do_evento) * 400ms` é uma estimativa baseada no tempo-alvo
 *     de slot. O tempo real varia com skip de líder. Marcamos `estimated: true`.
 */

import fs from "fs";
import path from "path";

/* -------------------------------------------------------------------------- */
/* 1. RELÓGIO                                                                  */
/* -------------------------------------------------------------------------- */

/** Relógio monotônico em milissegundos fracionários (nunca anda para trás). */
export function monotonicNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  // Fallback: hrtime em ns → ms
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

/** Carimbo de parede (para correlacionar com logs e horário real). */
export function wallClockNow(): number {
  return Date.now();
}

/* -------------------------------------------------------------------------- */
/* 2. ESTÁGIOS DO PIPELINE                                                     */
/* -------------------------------------------------------------------------- */

export const LATENCY_STAGES = [
  "received",   // callback do listener (WSS/gRPC) entregou a notificação
  "enriched",   // getTransaction retornou + mint extraído
  "assessed",   // risk engine concluiu
  "built",      // transação montada (quote/swap-instructions)
  "signed",     // assinatura produzida
  "submitted",  // block engine / RPC aceitou o envio
  "confirmed",  // status confirmado on-chain
] as const;

export type LatencyStage = (typeof LATENCY_STAGES)[number];

/** Ordinal do estágio, para validar ordem e calcular deltas. */
const STAGE_ORDER: Record<LatencyStage, number> = LATENCY_STAGES.reduce(
  (acc, stage, i) => ({ ...acc, [stage]: i }),
  {} as Record<LatencyStage, number>
);

export interface LatencyRecord {
  id: string;
  /** Slot do evento, quando conhecido. Permite estimar atraso relativo à cadeia. */
  eventSlot: number | null;
  /** Slot local no momento da recepção. */
  receivedSlot: number | null;
  marks: Partial<Record<LatencyStage, number>>; // relógio monotônico
  receivedAtWallClock: number;
  /** Duração por estágio em ms. */
  durationsMs: Partial<Record<LatencyStage, number>>;
  /** received -> confirmed, quando o ciclo fechou. */
  endToEndMs: number | null;
  outcome: "pending" | "rejected" | "executed" | "failed" | "expired";
  /** Estimativas são marcadas como tais — nunca apresentadas como medição direta. */
  estimated: { inclusionApproxMs?: number };
}

/**
 * Trilha de latência de UMA oportunidade.
 * Uso: criar no recebimento, marcar estágios, finalizar com desfecho.
 */
export class LatencyTrace {
  private startMonotonic: number;
  private marks: Partial<Record<LatencyStage, number>> = {};
  private lastStage: LatencyStage | null = null;

  constructor(
    public readonly id: string,
    public readonly receivedAtWallClock: number = wallClockNow(),
    public eventSlot: number | null = null,
    public receivedSlot: number | null = null
  ) {
    this.startMonotonic = monotonicNow();
    this.marks.received = this.startMonotonic;
    this.lastStage = "received";
  }

  /**
   * Marca a conclusão de um estágio.
   * Ignora marcações fora de ordem (protege contra callback duplicado/assíncrono).
   */
  mark(stage: LatencyStage): void {
    if (this.lastStage && STAGE_ORDER[stage] <= STAGE_ORDER[this.lastStage]) {
      return; // já marcado, ou fora de ordem — não sobrescrevemos medição válida
    }
    this.marks[stage] = monotonicNow();
    this.lastStage = stage;
  }

  has(stage: LatencyStage): boolean {
    return this.marks[stage] !== undefined;
  }

  /** Duração de received até o estágio informado. */
  elapsedTo(stage: LatencyStage): number | null {
    const t = this.marks[stage];
    return t === undefined ? null : round2(t - this.startMonotonic);
  }

  toRecord(outcome: LatencyRecord["outcome"] = "pending"): LatencyRecord {
    const durationsMs: Partial<Record<LatencyStage, number>> = {};
    let prev: LatencyStage | null = null;
    for (const stage of LATENCY_STAGES) {
      const t = this.marks[stage];
      if (t === undefined) continue;
      if (prev !== null) {
        const prevT = this.marks[prev] as number;
        durationsMs[stage] = round2(t - prevT);
      }
      prev = stage;
    }

    const confirmed = this.marks.confirmed;
    const endToEndMs = confirmed !== undefined ? round2(confirmed - this.startMonotonic) : null;

    // Estimativa de atraso em relação à cadeia, SÓ quando temos os dois slots.
    // 400ms por slot é o tempo-alvo; skip de líder faz o real ser maior.
    const estimated: LatencyRecord["estimated"] = {};
    if (this.eventSlot !== null && this.receivedSlot !== null && this.receivedSlot >= this.eventSlot) {
      estimated.inclusionApproxMs = (this.receivedSlot - this.eventSlot) * 400;
    }

    return {
      id: this.id,
      eventSlot: this.eventSlot,
      receivedSlot: this.receivedSlot,
      marks: { ...this.marks },
      receivedAtWallClock: this.receivedAtWallClock,
      durationsMs,
      endToEndMs,
      outcome,
      estimated,
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/* 3. HISTOGRAMA COM BUFFER LIMITADO                                           */
/* -------------------------------------------------------------------------- */

export interface HistogramSnapshot {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export class LatencyHistogram {
  private samples: number[] = [];

  constructor(private readonly maxSamples: number = 2000) {}

  add(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.samples.push(ms);
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  snapshot(): HistogramSnapshot | null {
    if (this.samples.length === 0) return null;
    // Cópia ordenada: não mutamos a ordem de chegada (que é a informação temporal).
    const sorted = [...this.samples].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    return {
      count: sorted.length,
      min: round2(sorted[0]),
      p50: round2(at(0.5)),
      p95: round2(at(0.95)),
      p99: round2(at(0.99)),
      max: round2(sorted[sorted.length - 1]),
      mean: round2(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    };
  }

  get size(): number {
    return this.samples.length;
  }
}

/* -------------------------------------------------------------------------- */
/* 4. REGISTRO CENTRAL                                                         */
/* -------------------------------------------------------------------------- */

export interface LatencySnapshot {
  generatedAt: string;
  traces: number;
  outcomes: Record<string, number>;
  perStageMs: Record<string, HistogramSnapshot | null>;
  endToEndMs: HistogramSnapshot | null;
  detection: { measurable: boolean; reason: string };
  inclusion: { mode: "estimated-from-slot"; estimated: boolean; note: string };
}

export class TelemetryRegistry {
  private histograms = new Map<string, LatencyHistogram>();
  private outcomeCounts: Record<string, number> = {};
  private traceCount = 0;
  /**
   * `logsSubscribe` (WSS) NÃO entrega timestamp do evento na origem: só é possível medir
   * o custo de enriquecimento local. Marcar isto como `false` é a diferença entre um
   * painel honesto e um painel decorativo.
   */
  private detectionMeasurable = false;
  private detectionReason = "Ingestão via WebSocket RPC: sem timestamp de origem. Configure gRPC Yellowstone para medir detecção ponta a ponta.";

  readonly maxSamplesPerStage: number;

  constructor(maxSamplesPerStage: number = 2000) {
    this.maxSamplesPerStage = maxSamplesPerStage;
    for (const stage of LATENCY_STAGES) {
      this.histograms.set(stage, new LatencyHistogram(maxSamplesPerStage));
    }
    this.histograms.set("endToEnd", new LatencyHistogram(maxSamplesPerStage));
  }

  /** Habilita medição de detecção fim-a-fim (chamado quando a origem fornece timestamp). */
  enableDetectionMeasurement(source: string): void {
    this.detectionMeasurable = true;
    this.detectionReason = `Origem fornece timestamp de evento (${source}). Detecção mensurável ponta a ponta.`;
  }

  record(trace: LatencyRecord): void {
    this.traceCount++;
    this.outcomeCounts[trace.outcome] = (this.outcomeCounts[trace.outcome] || 0) + 1;

    for (const stage of LATENCY_STAGES) {
      const d = trace.durationsMs[stage];
      if (d !== undefined) this.histograms.get(stage)!.add(d);
    }
    if (trace.endToEndMs !== null) this.histograms.get("endToEnd")!.add(trace.endToEndMs);
  }

  snapshot(): LatencySnapshot {
    const perStageMs: Record<string, HistogramSnapshot | null> = {};
    for (const stage of [...LATENCY_STAGES, "endToEnd"]) {
      perStageMs[stage] = this.histograms.get(stage)!.snapshot();
    }
    return {
      generatedAt: new Date().toISOString(),
      traces: this.traceCount,
      outcomes: { ...this.outcomeCounts },
      perStageMs,
      endToEndMs: perStageMs.endToEnd,
      detection: { measurable: this.detectionMeasurable, reason: this.detectionReason },
      inclusion: {
        mode: "estimated-from-slot",
        estimated: true,
        note:
          "Atraso em relação à cadeia é estimado por (slot_local - slot_evento) * 400ms. " +
          "O tempo real de slot varia com skip de líder; não é uma medição direta.",
      },
    };
  }

  /** Amostras brutas por estágio — para análise externa (ex.: plotar cauda). */
  rawSamples(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const stage of [...LATENCY_STAGES, "endToEnd"]) {
      out[stage] = this.histograms.get(stage)!["samples"] ?? [];
    }
    return out;
  }
}

/** Registro global do processo. */
export const telemetry = new TelemetryRegistry();

/* -------------------------------------------------------------------------- */
/* 5. PERSISTÊNCIA EM JSONL (para análise posterior / replay)                   */
/* -------------------------------------------------------------------------- */

/**
 * Grava trilhas de latência em JSONL (uma linha por registro).
 *
 * Por que JSONL e não o JSON operacional: append em arquivo é O(1) e não reescreve o
 * arquivo inteiro a cada medição. O `dbStore` reescreve o banco completo a cada
 * `saveLog` — aceitável para estado, inadequado para telemetria de alta frequência.
 */
export class JsonlSink {
  private stream: fs.WriteStream | null = null;
  private bytesWritten = 0;
  private rotations = 0;

  constructor(
    private readonly filePath: string,
    /** Tamanho máximo antes de rotacionar (default 64 MB). */
    private readonly maxBytes: number = 64 * 1024 * 1024
  ) {}

  private ensureStream(): fs.WriteStream {
    if (this.stream) return this.stream;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.stream = fs.createWriteStream(this.filePath, { flags: "a" });
    this.stream.on("error", (err) => {
      console.error(`[Telemetry] Falha de escrita em ${this.filePath}:`, err.message);
      this.stream = null;
    });
    return this.stream;
  }

  write(record: unknown): void {
    try {
      const line = JSON.stringify(record) + "\n";
      if (this.bytesWritten + line.length > this.maxBytes) {
        this.rotate();
      }
      const s = this.ensureStream();
      s.write(line);
      this.bytesWritten += line.length;
    } catch (err: any) {
      console.error("[Telemetry] Falha ao serializar registro:", err.message);
    }
  }

  private rotate(): void {
    try {
      if (this.stream) {
        this.stream.end();
        this.stream = null;
      }
      const rotated = `${this.filePath}.${Date.now()}.rotated`;
      if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, rotated);
      this.bytesWritten = 0;
      this.rotations++;
      console.log(`[Telemetry] Arquivo rotacionado: ${rotated}`);
    } catch (err: any) {
      console.error("[Telemetry] Falha na rotação:", err.message);
    }
  }

  /**
   * Espera o stream esvaziar SEM fechá-lo.
   *
   * `write()` é assíncrono por baixo (createWriteStream): quem lê o arquivo logo depois de
   * gravar pode não encontrar a última linha. Em desligamento gracioso e em teste isso vira
   * diagnóstico errado do tipo "o registro não aconteceu". Aqui a última escrita vazia só
   * resolve quando tudo que foi enfileirado antes dela já chegou ao sistema de arquivos.
   */
  async flush(): Promise<void> {
    const s = this.stream;
    if (!s) return;
    await new Promise<void>((resolve) => s.write("", () => resolve()));
  }

  async close(): Promise<void> {
    if (!this.stream) return;
    await new Promise<void>((resolve) => this.stream!.end(resolve));
    this.stream = null;
  }

  getStats() {
    return { path: this.filePath, bytesWritten: this.bytesWritten, rotations: this.rotations };
  }
}

/**
 * Lê um arquivo JSONL tolerando linhas corrompidas.
 * Uma linha truncada (processo morto no meio da escrita) não pode invalidar o histórico
 * inteiro — por isso contamos e reportamos as linhas ruins em vez de lançar.
 */
export function readJsonl<T>(filePath: string, limit?: number): { records: T[]; corruptedLines: number } {
  if (!fs.existsSync(filePath)) return { records: [], corruptedLines: 0 };
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const records: T[] = [];
  let corruptedLines = 0;
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      corruptedLines++;
    }
  }
  return { records: limit ? records.slice(-limit) : records, corruptedLines };
}
