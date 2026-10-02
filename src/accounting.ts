/**
 * accounting.ts — Contabilidade HONESTA de PnL.
 *
 * PROBLEMA QUE ESTE MÓDULO RESOLVE
 * --------------------------------
 * O código auditado (server.ts, executeAutonomousExit) calculava o resultado da
 * operação a partir do `outAmount` da COTAÇÃO da Jupiter, e gravava isso como
 * "PnL Realizado". Três erros se acumulavam:
 *
 *   1. Cotação != fill. O preço executado pode ser pior (slippage dentro do limite).
 *   2. Custos ignorados. Não descontava Jito tip, priority fee, base fee, rent de ATA
 *      e a taxa de saída da própria AMM.
 *   3. Latência ignorada. O preço no momento da decisão != preço no momento do fill.
 *
 * Um Jito tip de 0.003 SOL em uma posição de 0.1 SOL é 300 bps de custo SÓ na entrada
 * (e mais 300 bps na saída se você tippar de novo, = 600 bps round-trip). Ignorar isso
 * transforma uma estratégia perdedora em "lucrativa" no relatório.
 *
 * REGRA: PnL reportado é sempre LÍQUIDO e sempre medido contra DELTA DE SALDO
 * observado on-chain, nunca contra cotação.
 */

/** Lamports por SOL. */
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Taxa base da Solana por assinatura (5000 lamports). */
export const BASE_FEE_LAMPORTS = 5_000;

/** Parâmetros de custo de uma operação. */
export interface CostBreakdown {
  /** Tip pago ao Jito, em SOL. */
  jitoTipSol: number;
  /** Priority fee (compute unit price * units), em SOL. */
  priorityFeeSol: number;
  /** Taxas base das transações, em SOL. */
  baseFeeSol: number;
  /** Rent de ATA criado e não recuperado, em SOL. */
  ataRentSol: number;
  /** Taxa da AMM / protocolo, em SOL (quando mensurável). */
  ammFeeSol: number;
  /** Custo de slippage medido (preço de decisão vs preço de fill), em SOL. */
  slippageCostSol: number;
}

export function emptyCosts(): CostBreakdown {
  return {
    jitoTipSol: 0,
    priorityFeeSol: 0,
    baseFeeSol: 0,
    ataRentSol: 0,
    ammFeeSol: 0,
    slippageCostSol: 0,
  };
}

export function totalCostsSol(costs: CostBreakdown): number {
  return (
    costs.jitoTipSol +
    costs.priorityFeeSol +
    costs.baseFeeSol +
    costs.ataRentSol +
    costs.ammFeeSol +
    costs.slippageCostSol
  );
}

/** Estima priority fee em SOL a partir de micro-lamports por CU. */
export function estimatePriorityFeeSol(
  microLamportsPerCu: number,
  computeUnits: number
): number {
  // microLamports/CU * CU = microLamports -> lamports / 1e6 -> SOL / 1e9
  const microLamports = microLamportsPerCu * computeUnits;
  const lamports = microLamports / 1_000_000;
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Resultado LÍQUIDO de uma operação, derivado de saldos observados on-chain.
 *
 * @param solBefore  Saldo SOL da carteira antes da entrada (exclui tip/fees).
 * @param solAfter   Saldo SOL da carteira depois da saída COMPLETA (após todos os custos).
 */
export interface RealizedResult {
  /** PnL líquido em SOL, já com todos os custos. */
  pnlNetSol: number;
  /** PnL líquido em % do capital comprometido. */
  pnlNetPercent: number;
  /** PnL bruto (só preço) para diagnóstico da diferença. */
  pnlGrossSol: number;
  /** Custos totais em SOL. */
  costsSol: number;
  /** Custos como fração do capital comprometido (bps). */
  costsBps: number;
  /** true quando o resultado veio de saldos on-chain; false quando é estimativa. */
  measuredOnChain: boolean;
}

/**
 * Calcula o resultado líquido comparando saldos reais de SOL.
 * Esta é a ÚNICA forma de calcular PnL que consideramos confiável.
 */
export function realizedFromBalances(
  solBefore: number,
  solAfter: number,
  capitalCommittedSol: number,
  costs: CostBreakdown
): RealizedResult {
  const pnlNetSol = solAfter - solBefore;
  const costsSol = totalCostsSol(costs);
  const pnlGrossSol = pnlNetSol + costsSol;
  const capital = capitalCommittedSol > 0 ? capitalCommittedSol : Number.NaN;

  return {
    pnlNetSol,
    pnlNetPercent: Number.isFinite(capital) ? (pnlNetSol / capital) * 100 : 0,
    pnlGrossSol,
    costsSol,
    costsBps: Number.isFinite(capital) ? (costsSol / capital) * 10_000 : 0,
    measuredOnChain: true,
  };
}

/**
 * Break-even: quanto o ativo precisa subir, em %, para a operação empatar.
 * Use isto ANTES de operar. Se o break-even é 6% e o TP é 15%, você está pagando
 * 40% do seu alvo só em custos de execução.
 */
export function breakEvenPercent(costs: CostBreakdown, capitalCommittedSol: number): number {
  if (capitalCommittedSol <= 0) return Number.POSITIVE_INFINITY;
  return (totalCostsSol(costs) / capitalCommittedSol) * 100;
}

/**
 * Teto de tip do Jito em bps do capital comprometido.
 *
 * O código anterior usava tip fixo de 0.003 SOL independente do tamanho da posição.
 * Isso é 300 bps em uma posição de 0.1 SOL e 3 bps em uma de 10 SOL — ou seja, a
 * estratégia era matematicamente inviável em posições pequenas por causa do custo fixo.
 *
 * @param maxTipBps Teto de aceitação (default 50 bps = 0.5% do capital).
 */
export function clampTipSol(
  desiredTipSol: number,
  capitalCommittedSol: number,
  maxTipBps: number = 50
): { tipSol: number; clamped: boolean } {
  const capSol = (capitalCommittedSol * maxTipBps) / 10_000;
  if (desiredTipSol <= capSol) return { tipSol: desiredTipSol, clamped: false };
  return { tipSol: Math.max(0, capSol), clamped: true };
}

/* -------------------------------------------------------------------------- */
/* FRESCOR DE PREÇO                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Metadados obrigatórios de qualquer preço usado para decisão de SL/TP.
 *
 * O código anterior, quando todas as fontes de preço falhavam, reutilizava
 * silenciosamente o último preço conhecido. Efeito: com preço congelado, o PnL
 * congela, o stop-loss NUNCA dispara e o bot fica parado achando que está tudo bem.
 * Falha silenciosa em stop-loss é o pior modo de falha de um sistema de risco.
 */
export interface PriceQuote {
  priceSol: number;
  source: string;
  /** epoch ms em que o preço foi obtido da fonte. */
  fetchedAt: number;
  /** true se a fonte declarou o dado como stale/degradado. */
  degraded?: boolean;
}

/** Idade máxima aceitável de um preço (default 15s para tokens novos/voláteis). */
export const MAX_PRICE_AGE_MS = Number(process.env.MAX_PRICE_AGE_MS ?? 15_000);

export type PriceFreshness = "fresh" | "stale" | "missing";

export function assessPriceFreshness(
  quote: PriceQuote | undefined,
  maxAgeMs: number = MAX_PRICE_AGE_MS,
  now: number = Date.now()
): PriceFreshness {
  if (!quote || !Number.isFinite(quote.priceSol) || quote.priceSol <= 0) return "missing";
  if (now - quote.fetchedAt > maxAgeMs) return "stale";
  return "fresh";
}

/**
 * Decide a ação de risco permitida com base no frescor do preço.
 *
 * Política (fail-safe, não fail-open):
 *   - fresh  -> SL/TP/trailing podem executar normalmente.
 *   - stale  -> NÃO executar decisão de risco baseada em preço; escalar alerta.
 *               Nunca "segurar posição para sempre" silenciosamente.
 *   - missing-> tratar como stale, com alerta CRITICAL (perda de telemetria de preço).
 */
export function riskActionForFreshness(freshness: PriceFreshness): "evaluate" | "escalate" {
  return freshness === "fresh" ? "evaluate" : "escalate";
}

/* -------------------------------------------------------------------------- */
/* MÉTRICAS DE ESTRATÉGIA                                                      */
/* -------------------------------------------------------------------------- */

export interface TradeOutcomeRecord {
  pnlNetSol: number;
  openedAt: number;
  closedAt: number;
  failed: boolean;
  latencyMs?: number;
  slippageBps?: number;
}

export interface StrategyMetrics {
  trades: number;
  wins: number;
  losses: number;
  failures: number;
  winRate: number;
  /** Expectativa por operação em SOL (média líquida). */
  expectancySol: number;
  grossProfitSol: number;
  grossLossSol: number;
  /** Profit factor = soma dos ganhos / |soma das perdas|. */
  profitFactor: number;
  /** Drawdown máximo com base na curva de capital, em SOL. */
  maxDrawdownSol: number;
  averageWinSol: number;
  averageLossSol: number;
  totalCostsSol?: number;
  totalLatencyMs?: number;
}

/**
 * Métricas de estratégia. Um conjunto de operações com lucro não é evidência de edge:
 * profit factor perto de 1, expectativa perto de zero e amostra pequena significam ruído.
 */
export function computeStrategyMetrics(records: TradeOutcomeRecord[]): StrategyMetrics {
  const trades = records.length;
  let wins = 0;
  let losses = 0;
  let failures = 0;
  let grossProfitSol = 0;
  let grossLossSol = 0;
  let totalLatencyMs = 0;
  let latencySamples = 0;

  for (const r of records) {
    if (r.failed) failures++;
    if (r.pnlNetSol > 0) {
      wins++;
      grossProfitSol += r.pnlNetSol;
    } else if (r.pnlNetSol < 0) {
      losses++;
      grossLossSol += Math.abs(r.pnlNetSol);
    }
    if (Number.isFinite(r.latencyMs)) {
      totalLatencyMs += r.latencyMs as number;
      latencySamples++;
    }
  }

  // Equity curve para drawdown.
  let equity = 0;
  let peak = 0;
  let maxDrawdownSol = 0;
  for (const r of records) {
    equity += r.pnlNetSol;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdownSol) maxDrawdownSol = dd;
  }

  const netTotal = records.reduce((acc, r) => acc + r.pnlNetSol, 0);

  return {
    trades,
    wins,
    losses,
    failures,
    winRate: trades > 0 ? wins / trades : 0,
    expectancySol: trades > 0 ? netTotal / trades : 0,
    grossProfitSol,
    grossLossSol,
    profitFactor:
      grossLossSol > 0 ? grossProfitSol / grossLossSol : grossProfitSol > 0 ? Number.POSITIVE_INFINITY : 0,
    maxDrawdownSol,
    averageWinSol: wins > 0 ? grossProfitSol / wins : 0,
    averageLossSol: losses > 0 ? grossLossSol / losses : 0,
    totalLatencyMs,
  };
}

/**
 * Amostra mínima para levar uma estratégia a sério.
 * Com 30 operações e win rate de 60%, o intervalo de confiança de 95% ainda cobre ~40%,
 * ou seja: indistinguível de moeda justa com custos. Números abaixo são um piso, não uma garantia.
 */
export const MIN_TRADES_FOR_CONFIDENCE = 100;
