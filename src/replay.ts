/**
 * replay.ts — MOTOR DE REPLAY DETERMINÍSTICO SOBRE DADOS GRAVADOS.
 *
 * OBJETIVO
 * --------
 * Responder à pergunta que o sistema nunca soube responder: **a estratégia de saída tem
 * edge, ou o lucro observado foi sorte?**
 *
 * O QUE ESTE MOTOR FAZ
 * --------------------
 * Recebe episódios gravados (evento de lançamento + avaliação + série de preços observados)
 * e re-simula estratégias de saída de forma DETERMINÍSTICA: mesma entrada, mesmo resultado,
 * sempre. Compara cada estratégia contra a linha de base "segurar até o fim", que é o
 * competidor mais honesto que existe — se a estratégia não bate o simples buy-and-hold
 * na mesma amostra, ela não tem edge, tem complexidade.
 *
 * LIMITAÇÕES — DECLARADAS, NÃO ESCONDIDAS
 * ---------------------------------------
 * Estas limitações são reais e mudam a interpretação dos números. Elas são devolvidas em
 * `warnings` junto com cada resultado, porque um backtest sem suas limitações explícitas é
 * propaganda, não análise.
 *
 *  1. AMOSTRAGEM DISCRETA. Só conhecemos os preços NOS INSTANTES OBSERVADOS (tipicamente a
 *     cada 3s, o intervalo do gerenciador de posições). Um stop de -5% pode ter sido
 *     rompido e recuperado ENTRE duas observações — o replay não veria. Isso tende a
 *     SUPERESTIMAR o resultado de stops (o mundo real é pior do que a amostra sugere).
 *     Não temos high/low de candle porque não gravamos candles.
 *
 *  2. PREÇO DE SAÍDA = PREÇO OBSERVADO, SEM SLIPPAGE DE IMPACTO. Custos entram como bps
 *     configuráveis, mas o impacto real de vender em pool rasa é pior e depende do tamanho
 *     da ordem. Um stop em token ilíquido executa MUITO pior do que o preço do gráfico.
 *
 *  3. SEM LATÊNCIA. O replay assume execução instantânea no preço observado. Na prática há
 *     detecção + construção + assinatura + inclusão (ver telemetry.ts). Em token que cai
 *     40% em 10 segundos, a diferença entre o preço do gatilho e o preço do fill é o
 *     resultado inteiro da operação.
 *
 *  4. SEM PROFUNDIDADE DE LIVRO. Não modelamos liquidez disponível.
 *
 *  5. AMOSTRA PEQUENA NÃO É EVIDÊNCIA. Com menos de MIN_TRADES_FOR_CONFIDENCE operações o
 *     intervalo de confiança é largo demais para concluir qualquer coisa. O resultado é
 *     marcado com `validStatistically: false` e a conclusão textual reflete isso.
 *
 *  6. VIÉS DE SELEÇÃO NO GATILHO. O SL/TP é avaliado apenas nas observações que existiram.
 *     Se o preço saiu do ar (fonte falhou), o replay simplesmente avança — o mundo real
 *     teria uma posição sem gestão. O contador `gaps` reporta quantas observações faltaram.
 */

import {
  computeStrategyMetrics,
  MIN_TRADES_FOR_CONFIDENCE,
  type StrategyMetrics,
} from "./accounting.js";
import type { BacktestDataset, BacktestEpisode } from "./eventRecorder.js";

/* -------------------------------------------------------------------------- */
/* CONFIGURAÇÃO DE ESTRATÉGIA                                                  */
/* -------------------------------------------------------------------------- */

export interface ExitStrategyConfig {
  name: string;
  /** Stop loss em % (negativo). Ex.: -5. `null` = sem stop. */
  stopLossPercent: number | null;
  /** Take profit em % (positivo). Ex.: 15. `null` = sem alvo. */
  takeProfitPercent: number | null;
  /** Trailing stop em % de recuo desde o topo. `null` = desligado. */
  trailingStopPercent: number | null;
  /** Tempo máximo de permanência (ms). `null` = sem limite de tempo. */
  maxHoldMs: number | null;
  /**
   * Custo round-trip em bps (tip + priority + base fee + taxa AMM + slippage assumido).
   * Default 600 bps = 6%, compatível com o que o sistema praticava (tip fixo de 0.003 SOL
   * sobre 0.1 SOL = 300 bps só de tip, ida e volta). Ajuste para o seu cenário real.
   */
  costsRoundTripBps: number;
  /** Só entra se o PnL alvo supera o break-even com folga (margem de segurança em bps). */
  minEdgeOverCostsBps?: number;
}

export const DEFAULT_STRATEGIES: ExitStrategyConfig[] = [
  {
    name: "baseline-hold",
    stopLossPercent: null,
    takeProfitPercent: null,
    trailingStopPercent: null,
    maxHoldMs: null,
    costsRoundTripBps: 600,
  },
  {
    name: "sl5-tp15",
    stopLossPercent: -5,
    takeProfitPercent: 15,
    trailingStopPercent: null,
    maxHoldMs: null,
    costsRoundTripBps: 600,
  },
  {
    name: "sl10-tp30",
    stopLossPercent: -10,
    takeProfitPercent: 30,
    trailingStopPercent: null,
    maxHoldMs: null,
    costsRoundTripBps: 600,
  },
  {
    name: "sl15-tp50-trail15",
    stopLossPercent: -15,
    takeProfitPercent: 50,
    trailingStopPercent: 15,
    maxHoldMs: null,
    costsRoundTripBps: 600,
  },
  {
    name: "tp15-tp30-timeout5m",
    stopLossPercent: -8,
    takeProfitPercent: 15,
    trailingStopPercent: 10,
    maxHoldMs: 5 * 60 * 1000,
    costsRoundTripBps: 600,
  },
];

/* -------------------------------------------------------------------------- */
/* RESULTADO                                                                   */
/* -------------------------------------------------------------------------- */

export interface ReplayTrade {
  mint: string;
  entryPriceSol: number;
  exitPriceSol: number;
  exitReason: "stop-loss" | "take-profit" | "trailing-stop" | "timeout" | "end-of-data";
  /** Variação de preço pura, sem custos. */
  grossPnlPercent: number;
  /** Variação após custos round-trip. É o número que importa. */
  netPnlPercent: number;
  holdingMs: number;
  observations: number;
  /** Maior intervalo entre observações durante a operação (ms). Mede a cegueira do replay. */
  maxGapMs: number;
}

export interface ReplayCoverage {
  episodesInDataset: number;
  episodesEvaluated: number;
  skippedNoPrices: number;
  skippedNoEntryPrice: number;
  skippedByFilter: number;
  medianObservations: number;
  medianMaxGapMs: number;
  /** Observações descartadas por preço inválido (≤0 ou não finito). */
  invalidPriceObservations: number;
}

export interface ReplayResult {
  strategy: string;
  trades: ReplayTrade[];
  /** Métricas LÍQUIDAS (após custos) — as que devem ser usadas para decidir. */
  metricsNet: StrategyMetrics;
  /** Métricas BRUTAS, para ver quanto do resultado foi consumido por custos. */
  metricsGross: StrategyMetrics;
  /** Linha de base: segurar do início ao fim da série observada. */
  baselineHold: StrategyMetrics;
  coverage: ReplayCoverage;
  /** `false` quando a amostra é pequena demais para concluir qualquer coisa. */
  validStatistically: boolean;
  warnings: string[];
  /**
   * Veredito textual conservador. Não existe "estratégia validada" com amostra pequena.
   */
  conclusion: string;
}

export type EpisodeFilter = "all" | "accepted-only" | "rejected-only" | "no-assessment";

/* -------------------------------------------------------------------------- */
/* SIMULAÇÃO DE UM EPISÓDIO                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Simula uma estratégia sobre a série de preços de um episódio.
 *
 * Ordem de avaliação em CADA observação: stop-loss → take-profit → trailing → timeout.
 * A ordem importa e é uma escolha: o stop loss é verificado primeiro porque proteger
 * capital tem prioridade sobre capturar ganho — se o preço caiu abaixo do stop, não
 * importa que ele também esteja acima do alvo em outra leitura.
 *
 * Retorna `null` quando não há dados suficientes para simular com honestidade.
 */
export function simulateEpisode(
  episode: BacktestEpisode,
  strategy: ExitStrategyConfig,
  entryPriceOverride?: number
): ReplayTrade | null {
  const prices = episode.prices.filter((p) => Number.isFinite(p.priceSol) && p.priceSol > 0);
  if (prices.length === 0) return null;

  const entryPrice =
    entryPriceOverride ??
    episode.assessment?.entryPriceSol ??
    prices[0].priceSol;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;

  const entryAt = Date.parse(prices[0].recordedAt);
  const costsPercent = strategy.costsRoundTripBps / 100;

  // Margem de segurança: se o alvo não cobre os custos com folga, a estratégia é
  // matematicamente condenada neste cenário. Reportamos como end-of-data imediato?
  // Não — isso enviesaria o backtest. Deixamos a operação acontecer e o resultado
  // (negativo) aparecer nas métricas. O filtro de margem é informativo, não mascarador.

  let highest = entryPrice;
  let maxGapMs = 0;
  let previousAt = entryAt;

  for (let i = 1; i < prices.length; i++) {
    const obs = prices[i];
    const at = Date.parse(obs.recordedAt);
    const gap = at - previousAt;
    if (Number.isFinite(gap) && gap > maxGapMs) maxGapMs = gap;
    previousAt = at;

    const price = obs.priceSol;
    if (price > highest) highest = price;

    const grossPnlPercent = ((price - entryPrice) / entryPrice) * 100;
    const holdingMs = at - entryAt;

    let exitReason: ReplayTrade["exitReason"] | null = null;

    // 1. Stop loss
    if (strategy.stopLossPercent !== null && grossPnlPercent <= strategy.stopLossPercent) {
      exitReason = "stop-loss";
    }
    // 2. Take profit
    else if (strategy.takeProfitPercent !== null && grossPnlPercent >= strategy.takeProfitPercent) {
      exitReason = "take-profit";
    }
    // 3. Trailing stop (só depois de haver lucro, para não sair no ruído inicial)
    else if (strategy.trailingStopPercent !== null && highest > entryPrice) {
      const drawdownFromPeak = ((highest - price) / highest) * 100;
      const peakProfitPercent = ((highest - entryPrice) / entryPrice) * 100;
      if (drawdownFromPeak >= strategy.trailingStopPercent && peakProfitPercent > 1) {
        exitReason = "trailing-stop";
      }
    }
    // 4. Timeout
    else if (strategy.maxHoldMs !== null && holdingMs >= strategy.maxHoldMs) {
      exitReason = "timeout";
    }

    if (exitReason) {
      return {
        mint: episode.mint,
        entryPriceSol: entryPrice,
        exitPriceSol: price,
        exitReason,
        grossPnlPercent: round4(grossPnlPercent),
        netPnlPercent: round4(grossPnlPercent - costsPercent),
        holdingMs,
        observations: i + 1,
        maxGapMs,
      };
    }
  }

  // Nenhum gatilho: sai no último preço observado.
  const last = prices[prices.length - 1];
  const grossPnlPercent = ((last.priceSol - entryPrice) / entryPrice) * 100;
  return {
    mint: episode.mint,
    entryPriceSol: entryPrice,
    exitPriceSol: last.priceSol,
    exitReason: "end-of-data",
    grossPnlPercent: round4(grossPnlPercent),
    netPnlPercent: round4(grossPnlPercent - costsPercent),
    holdingMs: Date.parse(last.recordedAt) - entryAt,
    observations: prices.length,
    maxGapMs,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/* -------------------------------------------------------------------------- */
/* REPLAY COMPLETO                                                             */
/* -------------------------------------------------------------------------- */

function filterEpisodes(dataset: BacktestDataset, filter: EpisodeFilter): BacktestEpisode[] {
  return dataset.episodes.filter((ep) => {
    switch (filter) {
      case "accepted-only":
        return ep.assessment?.decision === "accepted";
      case "rejected-only":
        return ep.assessment?.decision === "rejected";
      case "no-assessment":
        return ep.assessment === null;
      case "all":
      default:
        return true;
    }
  });
}

/**
 * Roda uma estratégia sobre o dataset e devolve métricas + limitações.
 *
 * `sizeSol` é o notional por operação usado para converter % em SOL nas métricas.
 * Como o replay mede variação percentual, o notional só escala o resultado — não muda
 * win rate, profit factor nem drawdown relativo.
 */
export function replayStrategy(
  dataset: BacktestDataset,
  strategy: ExitStrategyConfig,
  options: { filter?: EpisodeFilter; sizeSol?: number; entryPriceByMint?: Record<string, number> } = {}
): ReplayResult {
  const filter = options.filter ?? "all";
  const sizeSol = options.sizeSol ?? Number(process.env.MAX_POSITION_SOL ?? 0.1);

  const candidates = filterEpisodes(dataset, filter);
  const trades: ReplayTrade[] = [];
  let skippedNoPrices = 0;
  let skippedNoEntryPrice = 0;
  let invalidPriceObservations = 0;

  for (const ep of dataset.episodes) {
    invalidPriceObservations += ep.prices.filter(
      (p) => !Number.isFinite(p.priceSol) || p.priceSol <= 0
    ).length;
  }

  for (const ep of candidates) {
    if (ep.prices.length === 0) {
      skippedNoPrices++;
      continue;
    }
    const override = options.entryPriceByMint?.[ep.mint];
    const trade = simulateEpisode(ep, strategy, override);
    if (!trade) {
      skippedNoEntryPrice++;
      continue;
    }
    trades.push(trade);
  }

  const toRecords = (pick: (t: ReplayTrade) => number) =>
    trades.map((t) => ({
      pnlNetSol: (pick(t) / 100) * sizeSol,
      openedAt: 0,
      closedAt: t.holdingMs,
      failed: false,
      latencyMs: t.maxGapMs,
      slippageBps: strategy.costsRoundTripBps,
    }));

  const metricsNet = computeStrategyMetrics(toRecords((t) => t.netPnlPercent));
  const metricsGross = computeStrategyMetrics(toRecords((t) => t.grossPnlPercent));

  // Linha de base: segurar do primeiro ao último preço, mesma amostra e mesmos custos.
  const baselineTrades = candidates
    .filter((ep) => ep.prices.length > 0)
    .map((ep) => simulateEpisode(ep, { ...strategy, name: "baseline", stopLossPercent: null, takeProfitPercent: null, trailingStopPercent: null, maxHoldMs: null }, options.entryPriceByMint?.[ep.mint]))
    .filter((t): t is ReplayTrade => t !== null);
  const baselineHold = computeStrategyMetrics(
    baselineTrades.map((t) => ({
      pnlNetSol: (t.netPnlPercent / 100) * sizeSol,
      openedAt: 0,
      closedAt: t.holdingMs,
      failed: false,
    }))
  );

  const gaps = trades.map((t) => t.maxGapMs).sort((a, b) => a - b);
  const obsCounts = trades.map((t) => t.observations).sort((a, b) => a - b);
  const median = (arr: number[]) =>
    arr.length === 0 ? 0 : arr[Math.floor(arr.length / 2)];

  const coverage: ReplayCoverage = {
    episodesInDataset: dataset.episodes.length,
    episodesEvaluated: trades.length,
    skippedNoPrices,
    skippedNoEntryPrice,
    skippedByFilter: dataset.episodes.length - candidates.length,
    medianObservations: median(obsCounts),
    medianMaxGapMs: median(gaps),
    invalidPriceObservations,
  };

  const validStatistically = trades.length >= MIN_TRADES_FOR_CONFIDENCE;

  const warnings = buildWarnings(strategy, coverage, validStatistically, trades.length);

  return {
    strategy: strategy.name,
    trades,
    metricsNet,
    metricsGross,
    baselineHold,
    coverage,
    validStatistically,
    warnings,
    conclusion: buildConclusion(metricsNet, baselineHold, coverage, validStatistically),
  };
}

function buildWarnings(
  strategy: ExitStrategyConfig,
  coverage: ReplayCoverage,
  validStatistically: boolean,
  tradeCount: number
): string[] {
  const w: string[] = [];

  w.push(
    "Amostragem discreta: os preços só existem nos instantes observados. Rompimentos de " +
      "stop entre duas observações NÃO são vistos — o resultado real tende a ser PIOR que o simulado."
  );
  w.push(
    "Sem latência e sem profundidade de livro: o fill real de um stop em pool rasa é pior " +
      "que o preço observado. O custo configurado (" + strategy.costsRoundTripBps + " bps) " +
      "cobre taxas e tip, não impacto de mercado."
  );

  if (coverage.medianMaxGapMs > 5000) {
    w.push(
      `Intervalo mediano entre observações de ${Math.round(coverage.medianMaxGapMs / 1000)}s: ` +
        `a série é esparsa e o timing dos gatilhos é grosseiro.`
    );
  }
  if (coverage.invalidPriceObservations > 0) {
    w.push(`${coverage.invalidPriceObservations} observações de preço inválidas foram descartadas.`);
  }
  if (coverage.skippedNoPrices > 0) {
    w.push(
      `${coverage.skippedNoPrices} episódios não têm nenhum preço registrado (a fonte falhou) — ` +
        `não são avaliáveis e não entram nas métricas.`
    );
  }

  if (!validStatistically) {
    w.push(
      `AMOSTRA INSUFICIENTE: ${tradeCount} operações é menos que o piso de ${MIN_TRADES_FOR_CONFIDENCE}. ` +
        `Com esta amostra, win rate e profit factor são indistinguíveis de ruído. ` +
        `Nenhuma conclusão de edge pode ser tirada daqui.`
    );
  }

  if (strategy.takeProfitPercent !== null) {
    const breakEven = strategy.costsRoundTripBps / 100;
    if (strategy.takeProfitPercent <= breakEven * 2) {
      w.push(
        `Alerta de viabilidade: o take-profit de ${strategy.takeProfitPercent}% é menos que o dobro do ` +
          `break-even (${breakEven}%). A estratégia precisa de taxa de acerto muito alta só para empatar.`
      );
    }
  }

  return w;
}

function buildConclusion(
  net: StrategyMetrics,
  baseline: StrategyMetrics,
  coverage: ReplayCoverage,
  validStatistically: boolean
): string {
  if (net.trades === 0) {
    return (
      "Nenhuma operação pôde ser simulada: não há episódios com série de preços utilizável. " +
      "Deixe o sistema coletando dados (modo paper) antes de tirar qualquer conclusão."
    );
  }

  const edgeVsBaseline = net.expectancySol - baseline.expectancySol;
  const parts: string[] = [];

  parts.push(
    `${net.trades} operações simuladas, expectativa líquida ${net.expectancySol.toFixed(6)} SOL/op ` +
      `(bruta: ${toUsable(baseline.expectancySol)}), win rate ${(net.winRate * 100).toFixed(1)}%, ` +
      `profit factor ${formatProfitFactor(net.profitFactor)}.`
  );

  parts.push(
    `Linha de base "segurar até o fim" na MESMA amostra: expectativa ` +
      `${baseline.expectancySol.toFixed(6)} SOL/op, win rate ${(baseline.winRate * 100).toFixed(1)}%.`
  );

  if (edgeVsBaseline > 0) {
    parts.push(
      `A estratégia supera a linha de base em ${edgeVsBaseline.toFixed(6)} SOL/op nesta amostra.`
    );
  } else {
    parts.push(
      `A estratégia NÃO supera segurar o ativo nesta amostra (${edgeVsBaseline.toFixed(6)} SOL/op). ` +
        `Complexidade de saída sem ganho mensurável é só mais superfície de falha.`
    );
  }

  if (!validStatistically) {
    parts.push(
      `Não há base estatística para agir sobre isto: ${net.trades} operações < ${MIN_TRADES_FOR_CONFIDENCE} ` +
        `necessárias. O número é descritivo, não preditivo.`
    );
  }

  if (coverage.skippedNoPrices > 0) {
    parts.push(
      `${coverage.skippedNoPrices} episódios ficaram fora por falta de preço — se a falha de ` +
        `telemetria for sistemática, a amostra é enviesada.`
    );
  }

  return parts.join(" ");
}

function formatProfitFactor(pf: number): string {
  if (!Number.isFinite(pf)) return "∞ (sem perdas na amostra — sinal de amostra pequena, não de perfeição)";
  return pf.toFixed(2);
}

function toUsable(n: number): string {
  return Number.isFinite(n) ? n.toFixed(6) : "n/a";
}

/* -------------------------------------------------------------------------- */
/* COMPARAÇÃO DE ESTRATÉGIAS                                                   */
/* -------------------------------------------------------------------------- */

export interface StrategyComparisonRow {
  strategy: string;
  trades: number;
  expectancyNetSol: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownSol: number;
  grossExpectancySol: number;
  costDragBps: number;
  beatsBaseline: boolean;
  validStatistically: boolean;
}

export interface StrategyComparison {
  generatedAt: string;
  datasetPath: string;
  datasetStats: BacktestDataset["stats"];
  sizeSol: number;
  baselineName: string;
  /** Expectativa líquida da linha de base (SOL por operação) — referência de comparação. */
  baselineExpectancyNetSol: number;
  baselineTrades: number;
  rows: StrategyComparisonRow[];
  /** Ranking por expectativa líquida. Vazio quando a amostra é insuficiente. */
  ranking: string[];
  notes: string[];
}

/**
 * Compara todas as estratégias na mesma amostra.
 *
 * IMPORTANTE: quando a amostra é insuficiente, `ranking` fica VAZIO de propósito.
 * Ordenar estratégias por ruído é a forma mais rápida de escolher a pior e acreditar
 * que escolheu a melhor.
 */
export function compareStrategies(
  dataset: BacktestDataset,
  strategies: ExitStrategyConfig[] = DEFAULT_STRATEGIES,
  options: { filter?: EpisodeFilter; sizeSol?: number } = {}
): StrategyComparison {
  const sizeSol = options.sizeSol ?? Number(process.env.MAX_POSITION_SOL ?? 0.1);

  const baselineCfg: ExitStrategyConfig = {
    name: "baseline-hold",
    stopLossPercent: null,
    takeProfitPercent: null,
    trailingStopPercent: null,
    maxHoldMs: null,
    costsRoundTripBps: strategies[0]?.costsRoundTripBps ?? 600,
  };
  const baseline = replayStrategy(dataset, baselineCfg, { ...options, sizeSol });

  const others = strategies.filter((s) => s.name !== "baseline-hold");
  const rows: StrategyComparisonRow[] = [];
  let anyValid = false;

  for (const strategy of others) {
    const result = replayStrategy(dataset, strategy, { ...options, sizeSol });
    if (result.validStatistically) anyValid = true;
    const costDragBps =
      result.metricsGross.expectancySol !== 0
        ? ((result.metricsGross.expectancySol - result.metricsNet.expectancySol) /
            Math.abs(result.metricsGross.expectancySol)) * 10_000
        : 0;
    rows.push({
      strategy: strategy.name,
      trades: result.metricsNet.trades,
      expectancyNetSol: result.metricsNet.expectancySol,
      winRate: result.metricsNet.winRate,
      profitFactor: result.metricsNet.profitFactor,
      maxDrawdownSol: result.metricsNet.maxDrawdownSol,
      grossExpectancySol: result.metricsGross.expectancySol,
      costDragBps,
      beatsBaseline: result.metricsNet.expectancySol > baseline.metricsNet.expectancySol,
      validStatistically: result.validStatistically,
    });
  }

  const notes: string[] = [
    `Baseline "segurar até o fim": expectativa ${baseline.metricsNet.expectancySol.toFixed(6)} SOL/op ` +
      `em ${baseline.metricsNet.trades} operações.`,
    "Custos aplicados: " + (strategies[0]?.costsRoundTripBps ?? 600) + " bps round-trip. " +
      "Ajuste CONFIG conforme seu cenário real antes de concluir qualquer coisa.",
  ];

  if (!anyValid) {
    notes.push(
      `Nenhuma estratégia atingiu o piso de ${MIN_TRADES_FOR_CONFIDENCE} operações. ` +
        `O ranking foi omitido deliberadamente: ordenar por ruído produz decisão errada com aparência de método.`
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    datasetPath: dataset.path,
    datasetStats: dataset.stats,
    sizeSol,
    baselineName: "baseline-hold",
    baselineExpectancyNetSol: baseline.metricsNet.expectancySol,
    baselineTrades: baseline.metricsNet.trades,
    rows,
    ranking: anyValid
      ? rows
          .filter((r) => r.validStatistically)
          .sort((a, b) => b.expectancyNetSol - a.expectancyNetSol)
          .map((r) => r.strategy)
      : [],
    notes,
  };
}
