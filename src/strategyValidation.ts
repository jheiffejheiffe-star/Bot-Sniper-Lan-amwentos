/**
 * VALIDAÇÃO ESTATÍSTICA (S9) — separar "ganhou em alguns trades" de "estratégia com edge".
 *
 * ## O que faz
 *
 * Recebe os desfechos rotulados (`src/outcomeLabels.ts`), seleciona o único conjunto que pode
 * sustentar uma conclusão (PnL líquido MEDIDO, modo live), calcula as métricas e emite um VEREDITO
 * com o motivo e o que mudaria a conclusão.
 *
 * ## Como funciona
 *
 * 1. **Seleção explícita do conjunto de validação.** Tudo o que não é `net_measured` + live fica
 *    fora, com o motivo contado. A métrica nunca mistura paper com live nem preço com líquido.
 * 2. **Intervalos de confiança, não pontos.** Win rate com intervalo de Wilson (exato para
 *    proporções com n pequeno) e média do PnL com erro-padrão da amostra (aproximação normal,
 *    declarada — e `null` quando n < 2, porque não existe desvio-padrão de uma amostra única).
 * 3. **Veredito com 5 estados**, do mais fraco ao mais forte, e a regra de cada um escrita no
 *    código:
 *      - `sem_dados` — nenhum desfecho medido;
 *      - `amostra_insuficiente` — n < `MIN_TRADES_FOR_CONFIDENCE` (já existente em `accounting`);
 *      - `indistinguivel_de_zero` — o IC 95% da média contém zero;
 *      - `edge_negativo` — IC INTEIRO abaixo de zero;
 *      - `candidato_a_edge` — n suficiente E IC inteiro acima de zero E profit factor > 1.
 *    Nenhum estado diz "lucrativo". O último diz "candidato" porque há vieses que IC não cobre:
 *    seleção de amostra, sobrevivência, custos que mudam com o tempo e múltiplas comparações.
 * 4. **Aviso de viés de exclusão.** Se uma fração grande dos registros não entrou, a amostra válida
 *    pode ser justamente a parte "que funcionou de medir" — o relatório diz isso em texto.
 *
 * ## Dependências
 *
 * `src/accounting.ts` (métricas já testadas: expectativa, profit factor, drawdown). Nada de rede,
 * banco ou relógio: funções puras.
 *
 * ## Riscos
 *
 * 1. **Aproximação normal para a média.** Com poucas operações e PnL muito assimétrico (um trade que
 *    multiplica), o IC fica otimista. Mitigação: o piso de amostra e o aviso explícito de assimetria
 *    (`skewWarning`) calculado da razão entre maior ganho e desvio-padrão.
 * 2. **Custos variáveis.** O IC assume que a distribuição de custos é a mesma do passado. Num
 *    lançamento congestionado, tip e prioridade sobem — e o resultado medido de ontem não é o de
 *    amanhã. Está declarado no veredito, não escondido.
 * 3. **Múltiplas comparações.** Testar N configurações de saída infla a chance de uma parecer boa.
 *    Por isso o veredito é sobre UMA configuração por vez e o relatório de estratégias
 *    (`compareStrategies`) já recusa conclusão com amostra pequena.
 *
 * ## Como testar
 *
 * Grupo [28]: Wilson conhecido por cálculo manual, IC da média, os 5 vereditos, exclusão de paper e
 * de estimado, e o aviso de assimetria.
 *
 * ## Como colocar em produção
 *
 * Nada a configurar: alimenta `GET /api/performance`. O operador lê `verdict.state` e
 * `verdict.whatWouldChangeIt`.
 */

import { computeStrategyMetrics, MIN_TRADES_FOR_CONFIDENCE, type StrategyMetrics } from "./accounting.js";
import { summarizeCoverage, type LabelCoverage, type LabeledOutcome, type OutcomeLabel } from "./outcomeLabels.js";

/* -------------------------------------------------------------------------- */
/* 1. ESTATÍSTICA BASE                                                        */
/* -------------------------------------------------------------------------- */

/** Quantil normal para 95% (bilateral). Constante declarada — não é número mágico. */
export const Z_95 = 1.959_964;

/**
 * Intervalo de confiança de Wilson para uma proporção. Escolhido no lugar da aproximação normal
 * porque com n pequeno (o caso de um bot em teste) a normal produz intervalos que chegam a cruzar
 * 0 e 1 — e um intervalo que atravessa o impossível não deveria instruir decisão de capital.
 */
export function wilsonInterval(successes: number, n: number, z = Z_95): { low: number; high: number } | null {
  if (!Number.isFinite(successes) || !Number.isFinite(n) || n <= 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export interface MeanInterval {
  mean: number;
  /** Erro-padrão da média (desvio-padrão amostral / √n). `null` com n < 2. */
  standardError: number | null;
  low: number | null;
  high: number | null;
  n: number;
  /** Assimetria: maior ganho / desvio-padrão. Alto = a aproximação normal fica otimista. */
  skewRatio: number | null;
}

export function meanConfidenceInterval(values: number[], z = Z_95): MeanInterval {
  const n = values.length;
  if (n === 0) return { mean: 0, standardError: null, low: null, high: null, n: 0, skewRatio: null };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) {
    // Com UMA observação não existe desvio-padrão: devolver um IC aqui seria inventar precisão.
    return { mean, standardError: null, low: null, high: null, n, skewRatio: null };
  }
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(n);
  const max = values.reduce((a, b) => Math.max(a, b), values[0]);
  return {
    mean,
    standardError: se,
    low: mean - z * se,
    high: mean + z * se,
    n,
    skewRatio: sd > 0 ? max / sd : null,
  };
}

/* -------------------------------------------------------------------------- */
/* 2. SELEÇÃO E VEREDITO                                                      */
/* -------------------------------------------------------------------------- */

export interface ValidationSet {
  /** Desfechos com PnL líquido MEDIDO em modo live — os únicos válidos para concluir. */
  outcomes: LabeledOutcome[];
  pnl: number[];
  coverage: LabelCoverage;
  /** Quantos ficaram de fora e por qual motivo agregado. */
  exclusionsByReason: Array<{ reason: string; count: number }>;
}

export function selectValidationSet(labeled: LabeledOutcome[]): ValidationSet {
  const outcomes = labeled.filter((l) => l.basis === "net_measured" && !l.excluded && l.mode === "live" && l.pnlNetSol !== null);
  // Ordem cronológica por timestamp quando existir: drawdown e curva de capital dependem da ORDEM.
  const ordenado = [...outcomes].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

  const reasons = new Map<string, number>();
  for (const l of labeled) {
    if (outcomes.includes(l)) continue;
    const key = l.exclusionReason ?? (l.basis === "price_estimated" ? "base estimada (preço, sem custos)" : "não elegível");
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }

  return {
    outcomes: ordenado,
    pnl: ordenado.map((o) => o.pnlNetSol as number),
    coverage: summarizeCoverage(labeled),
    exclusionsByReason: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  };
}

export type ValidationState =
  | "sem_dados"
  | "amostra_insuficiente"
  | "indistinguivel_de_zero"
  | "edge_negativo"
  | "candidato_a_edge";

export interface ValidationVerdict {
  state: ValidationState;
  /** Explicação em uma frase, com os números que a sustentam. */
  why: string;
  /** O que faria a conclusão MUDAR — a parte acionável. */
  whatWouldChangeIt: string;
  /** Avisos que impedem leitura otimista (assimetria, viés de exclusão, custos variáveis). */
  caveats: string[];
}

export interface StrategyValidationReport {
  generatedAt: string;
  /** Quantos trades/posições foram lidos e de onde (fonte declarada pelo chamador). */
  source: { name: string; tradesRead: number; positionsRead: number; truncated: boolean; note: string };
  metrics: StrategyMetrics;
  winRateInterval: { low: number; high: number } | null;
  pnlInterval: MeanInterval;
  profitFactorNote: string;
  verdict: ValidationVerdict;
  coverage: LabelCoverage;
  exclusionsByReason: Array<{ reason: string; count: number }>;
  byLabel: Record<OutcomeLabel, number>;
  /** Custo medido agregado (só dos registros que o mediram). */
  measuredCosts: {
    /** Soma de `feesSol` dos desfechos medidos (base fee das transações). */
    feesSol: number | null;
    /** Soma de `tipSol` dos desfechos medidos. */
    tipsSol: number | null;
    samples: number;
    /**
     * O que esta soma COBRE e o que ela não cobre. Sem isto, "custo medido" seria lido como "custo
     * total": o tip e a priority fee da ENTRADA são parte do ΔSOL do ciclo (portanto do PnL), mas não
     * chegam aqui decompostos — só o tip da saída é registrado como campo.
     */
    note: string;
  };
}

export function buildValidationReport(params: {
  labeled: LabeledOutcome[];
  source: StrategyValidationReport["source"];
  now?: () => Date;
}): StrategyValidationReport {
  const set = selectValidationSet(params.labeled);
  const metrics = computeStrategyMetrics(
    set.outcomes.map((o) => ({
      pnlNetSol: o.pnlNetSol as number,
      openedAt: o.at ?? 0,
      closedAt: o.at ?? 0,
      failed: false, // falhas ficam de fora deste conjunto por construção (são custo, não desfecho)
      latencyMs: undefined,
      slippageBps: undefined,
    }))
  );

  const winRateInterval = set.pnl.length > 0 ? wilsonInterval(metrics.wins, set.pnl.length) : null;
  const pnlInterval = meanConfidenceInterval(set.pnl);

  const fees = set.outcomes.map((o) => o.costs.feesSol).filter((v): v is number => v !== null);
  const tips = set.outcomes.map((o) => o.costs.tipSol).filter((v): v is number => v !== null);

  const caveats: string[] = [];
  if (pnlInterval.skewRatio !== null && pnlInterval.skewRatio > 3) {
    caveats.push(
      `assimetria alta (maior ganho = ${pnlInterval.skewRatio.toFixed(1)}× o desvio-padrão): a ` +
        `aproximação normal do intervalo é OTIMISTA — um único trade explica grande parte do resultado`
    );
  }
  if (metrics.profitFactor === Number.POSITIVE_INFINITY) {
    caveats.push("nenhuma perda na amostra: profit factor infinito é ausência de dado, não de risco");
  }
  if (set.coverage.missingShare > 0.3) {
    caveats.push("mais de 30% dos registros não têm resultado medido: risco de viés de exclusão");
  }
  caveats.push(
    "custos variam com congestionamento (tip/prioridade): o intervalo descreve o passado medido, " +
      "não garante o próximo lançamento"
  );
  if (set.outcomes.length > 0 && set.outcomes.length < MIN_TRADES_FOR_CONFIDENCE) {
    caveats.push(`amostra de ${set.outcomes.length} operação(ões) medidas — piso declarado: ${MIN_TRADES_FOR_CONFIDENCE}`);
  }

  const verdict = buildVerdict({ metrics, pnlInterval, coverage: set.coverage, n: set.pnl.length });

  return {
    generatedAt: (params.now ?? (() => new Date()))().toISOString(),
    source: params.source,
    metrics,
    winRateInterval,
    pnlInterval,
    profitFactorNote:
      metrics.grossLossSol > 0
        ? `ganhos ${metrics.grossProfitSol.toFixed(6)} SOL / perdas ${metrics.grossLossSol.toFixed(6)} SOL`
        : "sem perdas na amostra: profit factor não é estimável (evita-se exibir ∞ como qualidade)",
    verdict,
    coverage: set.coverage,
    exclusionsByReason: set.exclusionsByReason,
    byLabel: set.coverage.byLabel,
    measuredCosts: {
      feesSol: fees.length > 0 ? fees.reduce((a, b) => a + b, 0) : null,
      tipsSol: tips.length > 0 ? tips.reduce((a, b) => a + b, 0) : null,
      samples: Math.max(fees.length, tips.length),
      note:
        "cobre a base fee das transações dos desfechos medidos e o tip registrado (o da SAÍDA). " +
        "Tip e priority fee da ENTRADA estão embutidos no ΔSOL do ciclo — logo, no PnL — mas não " +
        "aparecem decompostos aqui.",
    },
  };
}

function buildVerdict(params: {
  metrics: StrategyMetrics;
  pnlInterval: MeanInterval;
  coverage: LabelCoverage;
  n: number;
}): ValidationVerdict {
  const { metrics, pnlInterval, coverage, n } = params;

  if (coverage.total === 0) {
    return {
      state: "sem_dados",
      why: "nenhum registro para rotular: não há o que concluir",
      whatWouldChangeIt: "ter operações registradas (paper ou live) e, para validação, que o PnL seja medido on-chain",
      caveats: ["ausência de dado não é evidência de segurança nem de lucro"],
    };
  }
  if (n === 0) {
    return {
      state: "sem_dados",
      why:
        `existem ${coverage.total} registro(s), mas NENHUM com PnL líquido medido em modo live ` +
        `(${coverage.measured} medido(s) no total, ${coverage.estimated} estimado(s))`,
      whatWouldChangeIt:
        "medir o resultado on-chain nas saídas (o `pnlNetSol` depende de `measuredOnChain=true`); " +
        "sem isso, nenhuma métrica deste relatório descreve dinheiro",
      caveats: [coverage.notes.join(" | ") || "sem nota"],
    };
  }
  if (n < MIN_TRADES_FOR_CONFIDENCE) {
    return {
      state: "amostra_insuficiente",
      why:
        `${n} operação(ões) medidas com intervalo 95% de PnL [${fmt(pnlInterval.low)}, ${fmt(pnlInterval.high)}] SOL — ` +
        `o piso declarado para levar a sério é ${MIN_TRADES_FOR_CONFIDENCE}`,
      whatWouldChangeIt:
        `mais ${MIN_TRADES_FOR_CONFIDENCE - n} operação(ões) medidas (ou um edge grande o bastante para o ` +
        `intervalo não tocar o zero antes disso)`,
      caveats: ["com amostra pequena, win rate e profit factor são ruído — não indicador"],
    };
  }
  if (pnlInterval.low !== null && pnlInterval.high !== null && pnlInterval.low > 0 && metrics.profitFactor > 1) {
    return {
      state: "candidato_a_edge",
      why:
        `n=${n} com IC 95% da média inteiramente acima de zero [${fmt(pnlInterval.low)}, ${fmt(pnlInterval.high)}] ` +
        `SOL e profit factor ${metrics.profitFactor.toFixed(2)}`,
      whatWouldChangeIt:
        "uma amostra FORA do período (mesma configuração, mercado/taxas diferentes) ou o custo subir: " +
        "o IC cobre ruído amostral, não mudança de regime nem seleção de amostra",
      caveats: ["candidato ≠ lucrativo: validação exige amostra independente e custos vigentes"],
    };
  }
  if (pnlInterval.high !== null && pnlInterval.high < 0) {
    return {
      state: "edge_negativo",
      why:
        `IC 95% da média inteiramente ABAIXO de zero [${fmt(pnlInterval.low)}, ${fmt(pnlInterval.high)}] SOL ` +
        `em ${n} operações: a evidência disponível aponta perda sistemática`,
      whatWouldChangeIt:
        "reduzir custo (tip/prioridade/slippage) ou mudar a estratégia de saída — e MEDIR de novo; " +
        "não aumentar tamanho de posição esperando reversão",
      caveats: ["drawdown máximo observado: " + metrics.maxDrawdownSol.toFixed(6) + " SOL"],
    };
  }
  return {
    state: "indistinguivel_de_zero",
    why:
      `n=${n}, média ${fmt(pnlInterval.mean)} SOL com IC 95% [${fmt(pnlInterval.low)}, ${fmt(pnlInterval.high)}]: ` +
      `o intervalo CONTÉM o zero — não dá para separar a estratégia de ruído`,
    whatWouldChangeIt:
      "mais operações medidas, ou redução de custo por operação (o zero aqui é depois de tip/fee)",
    caveats: ["expectativa perto de zero com custo fixo alto é o desfecho MAIS COMUM de sniper sem edge"],
  };
}

function fmt(v: number | null): string {
  return v === null ? "n/d" : v.toFixed(6);
}
