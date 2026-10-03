/**
 * eventRecorder.ts — GRAVAÇÃO DE EVENTOS PARA REPLAY E BACKTEST.
 *
 * POR QUE ESTE MÓDULO EXISTE
 * --------------------------
 * A auditoria concluiu que não existe validação estatística de estratégia: só "algumas
 * operações que deram lucro". Para transformar isso em evidência é preciso gravar o que
 * ACONTECEU (evento de lançamento + decisão + preços observados) e poder reprocessar
 * depois, de forma determinística.
 *
 * PRINCÍPIOS
 * ----------
 *  1. Append-only em JSONL. Nunca reescreve o arquivo (diferente do dbStore, que reescreve
 *     o JSON inteiro a cada log).
 *  2. Registra a DECISÃO e o MOTIVO, não só o resultado. Um backtest sem os sinais que
 *     foram rejeitados só mostra metade do sistema — e a metade que engana (viés de
 *     sobrevivência: você mede a estratégia sobre os tokens que ela já aprovou).
 *  3. Registra o preço no momento da decisão E a série subsequente. Sem preço de entrada
 *     registrado, não há como reconstruir PnL de forma honesta depois.
 *  4. Falha de disco na telemetria NUNCA derruba o pipeline de trading. Gravação é
 *     observabilidade; se falhar, logamos e seguimos — mas nunca silenciosamente.
 */

import fs from "fs";
import path from "path";
import { JsonlSink, readJsonl } from "./telemetry.js";

/* -------------------------------------------------------------------------- */
/* TIPOS DE REGISTRO                                                           */
/* -------------------------------------------------------------------------- */

export type EventSource = "wss-logs" | "grpc-geyser" | "pumpportal" | "manual";

export interface RecordedLaunchEvent {
  kind: "launch-event";
  recordedAt: string;
  /** Identificador estável para deduplicação (assinatura + índice da instrução). */
  eventId: string;
  source: EventSource;
  programId: string;
  programName: string;
  eventType: string;
  mint: string;
  signature: string;
  slot: number | null;
  /** RTT do enriquecimento: callback → getTransaction concluído (ms, medido). */
  enrichmentMs: number | null;
}

/**
 * Snapshot da avaliação de risco no momento da decisão.
 * Guardamos o resultado COMPLETO (não só aprovado/reprovado) porque um backtest precisa
 * poder reavaliar com limites diferentes dos que estavam configurados naquele dia.
 */
export interface RecordedAssessment {
  kind: "assessment";
  recordedAt: string;
  eventId: string;
  mint: string;
  decision: "accepted" | "rejected";
  rejectionReason: string | null;
  score: number;
  verdict: string;
  dataComplete: boolean;
  missingChecks: string[];
  isRug: boolean;
  mintAuthorityDisabled: boolean | null;
  freezeAuthorityDisabled: boolean | null;
  liquidityUsd: number;
  poolSource: string;
  token2022Risk?: string;
  /** Preço no momento da decisão (SOL por token) e sua origem. */
  entryPriceSol: number | null;
  entryPriceSource: string | null;
  /** Custos estimados naquele instante, para o replay recalcular break-even. */
  estimatedCostsBps: number | null;
  /**
   * Tempo MEDIDO do filtro profundo e o orçamento vigente (S5). Sem estes dois números,
   * "por que não entrei nesse lançamento" vira arqueologia: o registro mostra se o sinal
   * foi reprovado por evidência ou por estouro de orçamento.
   */
  deepFilterMs?: number | null;
  deepFilterBudgetMs?: number | null;
}

export interface RecordedPriceObservation {
  kind: "price-observation";
  recordedAt: string;
  positionId: string;
  mint: string;
  priceSol: number;
  source: string;
  /** Idade do preço quando foi usado (ms). 0 quando fresco. */
  ageMs: number;
  /** PnL calculado no momento da observação, em %. */
  pnlPercent: number | null;
}

export interface RecordedPositionLifecycle {
  kind: "position-lifecycle";
  recordedAt: string;
  positionId: string;
  mint: string;
  token: string;
  event: "opened" | "closed" | "exit_failed";
  mode: "live" | "paper";
  sizeSol: number;
  entryPriceSol: number;
  exitPriceSol: number | null;
  pnlPercent: number | null;
  reason: string | null;
  /** NÃO medido quando não houve confirmação on-chain. */
  pnlMeasuredOnChain: boolean;
}

/**
 * Resultado de uma ENTRADA EM SHADOW: rota cotada, transação construída e SIMULADA.
 *
 * Gravado porque é a evidência que separa "o bot decidiu comprar" de "a compra é
 * construível e o compute cabe". Nenhum campo aqui vem de assinatura ou envio — este
 * registro é sempre de simulação, e `pnlMeasuredOnChain`-like não existe porque não há PnL.
 */
export interface RecordedShadowEntry {
  kind: "shadow-entry";
  recordedAt: string;
  mint: string;
  token: string | null;
  mode: string;
  sizeSol: number;
  built: boolean;
  skippedReason: string | null;
  routeLabels: string[];
  outAmount: string | null;
  priceImpactPct: number | null;
  simulationOk: boolean | null;
  simulationErr: string | null;
  unitsConsumed: number | null;
  quoteMs: number | null;
  buildMs: number | null;
  simulateMs: number | null;
}

export type RecordedRecord =
  | RecordedLaunchEvent
  | RecordedAssessment
  | RecordedPriceObservation
  | RecordedPositionLifecycle
  | RecordedShadowEntry;

/* -------------------------------------------------------------------------- */
/* RECORDER                                                                    */
/* -------------------------------------------------------------------------- */

export interface RecorderConfig {
  /** Diretório de dados. Default: ./data (gitignored). */
  dir?: string;
  /** Máximo de bytes por arquivo antes de rotacionar. */
  maxBytesPerFile?: number;
  /** Desliga a gravação (útil em testes e em ambientes sem disco persistente). */
  disabled?: boolean;
}

export class EventRecorder {
  private sink: JsonlSink;
  private counts: Record<string, number> = {
    "launch-event": 0,
    assessment: 0,
    "price-observation": 0,
    "position-lifecycle": 0,
    "shadow-entry": 0,
  };
  private writeErrors = 0;
  private seenEventIds = new Set<string>();
  private static readonly MAX_DEDUPE_KEYS = 10_000;

  constructor(private readonly config: RecorderConfig = {}) {
    const dir = config.dir || path.join(process.cwd(), "data");
    const file = path.join(dir, "events.jsonl");
    this.sink = new JsonlSink(file, config.maxBytesPerFile ?? 64 * 1024 * 1024);
  }

  private write(record: RecordedRecord): void {
    if (this.config.disabled) return;
    try {
      this.sink.write(record);
      this.counts[record.kind] = (this.counts[record.kind] || 0) + 1;
    } catch (err: any) {
      // Telemetria não pode derrubar trading — mas também não pode falhar em silêncio.
      this.writeErrors++;
      console.error(`[Recorder] Falha ao gravar ${record.kind}:`, err.message);
    }
  }

  /**
   * Registra um evento de lançamento. Deduplica por `eventId`: uma reconexão de WebSocket
   * pode reentregar o mesmo log, e um evento contado duas vezes distorce qualquer métrica
   * de frequência de lançamentos.
   */
  recordLaunchEvent(event: Omit<RecordedLaunchEvent, "kind" | "recordedAt">): boolean {
    if (this.seenEventIds.has(event.eventId)) return false;
    this.seenEventIds.add(event.eventId);
    if (this.seenEventIds.size > EventRecorder.MAX_DEDUPE_KEYS) {
      // Descarta os mais antigos (Set preserva ordem de inserção).
      const first = this.seenEventIds.values().next().value;
      if (first) this.seenEventIds.delete(first);
    }
    this.write({ kind: "launch-event", recordedAt: new Date().toISOString(), ...event });
    return true;
  }

  recordAssessment(assessment: Omit<RecordedAssessment, "kind" | "recordedAt">): void {
    this.write({ kind: "assessment", recordedAt: new Date().toISOString(), ...assessment });
  }

  recordPriceObservation(obs: Omit<RecordedPriceObservation, "kind" | "recordedAt">): void {
    this.write({ kind: "price-observation", recordedAt: new Date().toISOString(), ...obs });
  }

  recordPositionLifecycle(lifecycle: Omit<RecordedPositionLifecycle, "kind" | "recordedAt">): void {
    this.write({ kind: "position-lifecycle", recordedAt: new Date().toISOString(), ...lifecycle });
  }

  /** Registra uma entrada em shadow (cotação + construção + simulação, sem assinatura). */
  recordShadowEntry(entry: Omit<RecordedShadowEntry, "kind" | "recordedAt">): void {
    this.write({ kind: "shadow-entry", recordedAt: new Date().toISOString(), ...entry });
  }

  /**
   * Garante que tudo que foi enfileirado chegou ao disco.
   *
   * `record*()` é assíncrono por baixo (stream). Quem lê `events.jsonl` logo após registrar
   * — teste, endpoint de replay ou o operador — pode ver um arquivo mais curto do que o
   * registrado. Retorna `false` se houve qualquer erro de escrita acumulado.
   */
  async flush(): Promise<boolean> {
    await this.sink.flush();
    return this.writeErrors === 0;
  }

  /** Contadores por tipo de registro + erros de escrita + estado do sink. */
  getStats(): {
    counts: Record<string, number>;
    writeErrors: number;
    sink: { path: string; bytesWritten: number; rotations: number };
  } {
    return {
      counts: { ...this.counts },
      writeErrors: this.writeErrors,
      sink: this.sink.getStats(),
    };
  }

  async close(): Promise<void> {
    await this.sink.close();
  }
}

/** Instância global. Desabilitada quando HFT_DISABLE_RECORDER=true (testes/CI). */
export const recorder = new EventRecorder({
  disabled: process.env.HFT_DISABLE_RECORDER === "true",
});

/* -------------------------------------------------------------------------- */
/* LEITURA DO DATASET                                                          */
/* -------------------------------------------------------------------------- */

export interface BacktestEpisode {
  mint: string;
  /** Evento de lançamento que originou o episódio (primeiro observado). */
  event: RecordedLaunchEvent | null;
  /** Avaliação de risco correspondente — inclusive quando REJEITADO. */
  assessment: RecordedAssessment | null;
  /** Série temporal de preços observados, em ordem cronológica. */
  prices: RecordedPriceObservation[];
  lifecycle: RecordedPositionLifecycle[];
}

export interface BacktestDataset {
  path: string;
  records: number;
  corruptedLines: number;
  episodes: BacktestEpisode[];
  stats: {
    launchEvents: number;
    assessments: number;
    accepted: number;
    rejected: number;
    priceObservations: number;
    positionLifecycles: number;
    /** Entradas em shadow registradas (simulações; nunca operações). */
    shadowEntries: number;
    mintsWithoutPrices: number;
    acceptanceRate: number;
  };
}

/**
 * Monta o dataset de backtest a partir do JSONL gravado.
 *
 * Inclui deliberadamente os REJEITADOS: medir a estratégia apenas sobre o que ela aprovou
 * mede a si mesma, não o mercado. O valor de um backtest está também em verificar o que
 * teria acontecido com o que foi recusado.
 */
export function loadBacktestDataset(filePath?: string): BacktestDataset {
  const dir = path.join(process.cwd(), "data");
  const resolved = filePath || path.join(dir, "events.jsonl");
  const { records, corruptedLines } = readJsonl<RecordedRecord>(resolved);

  const episodes = new Map<string, BacktestEpisode>();
  let launchEvents = 0;
  let assessments = 0;
  let accepted = 0;
  let rejected = 0;
  let priceObservations = 0;
  let positionLifecycles = 0;
  let shadowEntries = 0;

  const episodeFor = (mint: string): BacktestEpisode => {
    let ep = episodes.get(mint);
    if (!ep) {
      ep = { mint, event: null, assessment: null, prices: [], lifecycle: [] };
      episodes.set(mint, ep);
    }
    return ep;
  };

  for (const rec of records) {
    switch (rec.kind) {
      case "launch-event":
        launchEvents++;
        {
          const ep = episodeFor(rec.mint);
          // Mantém o PRIMEIRO evento visto do mint (o mais próximo do lançamento).
          if (!ep.event) ep.event = rec;
        }
        break;
      case "assessment":
        assessments++;
        if (rec.decision === "accepted") accepted++;
        else rejected++;
        {
          const ep = episodeFor(rec.mint);
          if (!ep.assessment) ep.assessment = rec;
        }
        break;
      case "price-observation":
        priceObservations++;
        episodeFor(rec.mint).prices.push(rec);
        break;
      case "position-lifecycle":
        positionLifecycles++;
        episodeFor(rec.mint).lifecycle.push(rec);
        break;
      case "shadow-entry":
        // Contado, não misturado com trades: uma simulação bem-sucedida NÃO é uma operação.
        shadowEntries++;
        break;
    }
  }

  // Ordena séries cronologicamente (o JSONL é append-only, mas reconexões e escritas
  // concorrentes podem intercalar; a ordem do arquivo não é garantia de ordem temporal).
  for (const ep of episodes.values()) {
    ep.prices.sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
  }

  const all = [...episodes.values()];
  return {
    path: resolved,
    records: records.length,
    corruptedLines,
    episodes: all,
    stats: {
      launchEvents,
      assessments,
      accepted,
      rejected,
      priceObservations,
      positionLifecycles,
      shadowEntries,
      mintsWithoutPrices: all.filter((e) => e.prices.length === 0).length,
      acceptanceRate: assessments > 0 ? round4(accepted / assessments) : 0,
    },
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Lista arquivos de dados gravados (inclui rotacionados), do mais antigo ao mais novo. */
export function listDataFiles(dir?: string): string[] {
  const base = dir || path.join(process.cwd(), "data");
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .filter((f) => f.startsWith("events.jsonl"))
    .map((f) => path.join(base, f))
    .sort();
}
