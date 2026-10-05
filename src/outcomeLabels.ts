/**
 * RÓTULOS DE RESULTADO (S9) — transformar registros operacionais em evidência rotulada, sem
 * inventar o que não foi medido.
 *
 * ## O que faz
 *
 * Lê os registros REAIS do sistema (trades e posições fechadas) e devolve, para cada um, um rótulo
 * de desfecho com a BASE DE CÁLCULO explícita:
 *
 * | rótulo | quando | entra na validação? |
 * |---|---|---|
 * | `win` / `loss` / `breakeven` | PnL LÍQUIDO medido on-chain (`measuredOnChain` + `pnlNetSol`) | **sim** |
 * | `estimated_win` / `estimated_loss` | só `pnlPercent` da posição (preço, **sem** taxas/tip/rent) | não |
 * | `failed_attempt` | tentativa que falhou (entrada recusada ou saída que não liquidou) | não (é custo) |
 * | `entry_leg` | perna de entrada: resultado só existe na saída | não |
 * | `unresolved` | dado ausente/inconsistente | não (com motivo) |
 *
 * ## Por que a base de cálculo é o centro deste módulo
 *
 * O `pnlPercent` de uma posição é calculado de PREÇO. Ele não inclui tip do Jito, priority fee,
 * base fee nem o rent da ATA (~0,002 SOL) — e não inclui slippage real de execução. Tratar esse
 * número como resultado da estratégia produz uma curva de capital que nunca existiu: é exatamente
 * como se fabrica "estratégia lucrativa" em bot de sniper. Por isso:
 *
 * - só `pnlNetSol` medido on-chain é base de validação;
 * - tudo o mais é rotulado, mostrado, e EXCLUÍDO da conclusão — com o motivo escrito.
 *
 * ## Como funciona
 *
 * Funções puras. O módulo não lê arquivo, não lê banco, não lê rede: recebe os registros e devolve
 * rótulos. Quem escolhe a fonte (JSON local ou banco, no S10) é o chamador.
 *
 * ## Dependências
 *
 * Nenhuma.
 *
 * ## Riscos
 *
 * 1. **Classificação por texto.** O sistema não grava um campo `leg` (entrada × saída) em todos os
 *    registros; onde ele falta, a inferência usa o campo `route` e o rótulo declara
 *    `attemptKindSource: "texto"`. Inferência declarada é aceitável; inferência silenciosa não.
 * 2. **Status fora da união declarada.** O tipo `DBTrade` declara
 *    `success|failed|blacklisted|paper|shadow`, mas o caminho real do S6 grava `confirmed` e
 *    `rejected`. Este módulo NÃO normaliza isso por conta própria: ele classifica pelo que os
 *    CAMPOS dizem (PnL medido, presença de assinatura) e mantém o status original no rótulo.
 *
 * ## Como testar
 *
 * Grupo [28] de `npm run test`: cada rótulo, a regra de base de cálculo, breakeven por epsilon,
 * registro truncado, e a garantia de que paper NUNCA entra no conjunto de validação.
 *
 * ## Como colocar em produção
 *
 * Nada a configurar: é a camada que alimenta `GET /api/performance`.
 */

import type { DBTrade, DBPosition } from "./persistence.js";

/** Piso de indiferença para classificar empate. 1.000 lamports = 1 base fee — declarado. */
export const BREAKEVEN_EPSILON_SOL = 0.000_001;

export type OutcomeLabel =
  | "win"
  | "loss"
  | "breakeven"
  | "estimated_win"
  | "estimated_loss"
  | "estimated_breakeven"
  | "failed_attempt"
  | "entry_leg"
  | "unresolved";

/** De onde veio o número do resultado — a distinção que impede PnL fabricado. */
export type OutcomeBasis = "net_measured" | "price_estimated" | "none";

export type AttemptKind = "entry" | "exit" | "unknown";

export interface LabeledOutcome {
  id: string;
  mint: string;
  token: string;
  mode: "live" | "paper" | "unknown";
  source: "trade" | "position";
  label: OutcomeLabel;
  basis: OutcomeBasis;
  /** PnL líquido em SOL — SÓ preenchido quando a base é `net_measured`. */
  pnlNetSol: number | null;
  /**
   * Percentual de preço — SÓ quando a base é `price_estimated`. Existe no rótulo para auditoria,
   * NUNCA para conclusão (é estimativa sem custos).
   */
  pnlPercent: number | null;
  costs: { feesSol: number | null; tipSol: number | null };
  signature: string | null;
  slot: number | null;
  attemptKind: AttemptKind;
  /** Como `attemptKind` foi determinado — `campo`, `texto` ou `desconhecido`. */
  attemptKindSource: "campo" | "texto" | "desconhecido";
  /** Motivo legível do rótulo (por que win, por que excluído, etc.). */
  reason: string;
  /** `true` = fora da conclusão estatística; `exclusionReason` diz por quê. */
  excluded: boolean;
  exclusionReason: string | null;
  /** Campos que sustentam o rótulo (auditoria: de onde veio cada afirmação). */
  provenance: string[];
  at: number | null;
}

export interface LabelCoverage {
  total: number;
  byLabel: Record<OutcomeLabel, number>;
  /** Registros com base `net_measured` — o único conjunto elegível para validar. */
  measured: number;
  /** Registros com base `price_estimated`. */
  estimated: number;
  /** Registros sem número nenhum. */
  withoutNumber: number;
  /** Percentual de registros sem número sobre o total (0..1). */
  missingShare: number;
  notes: string[];
}

/* -------------------------------------------------------------------------- */
/* 1. CLASSIFICAÇÃO DE UMA PERNA                                              */
/* -------------------------------------------------------------------------- */

const EXIT_HINTS = /\bexit\b|venda|sell|saída|saida/i;

/**
 * Determina se o registro é entrada ou saída. Ordem: campo explícito → texto da rota → desconhecido.
 * IMPORTANTE: "desconhecido" é um resultado legítimo e NÃO bloqueia o rótulo quando o PnL medido
 * existe — só impede afirmar QUE tipo de tentativa foi.
 */
export function classifyAttemptKind(trade: Partial<DBTrade>): { kind: AttemptKind; source: "campo" | "texto" | "desconhecido" } {
  const explicit = (trade as any).leg;
  if (explicit === "entry" || explicit === "exit") return { kind: explicit, source: "campo" };
  const route = String(trade.route ?? "");
  if (route !== "") {
    if (EXIT_HINTS.test(route)) return { kind: "exit", source: "texto" };
    if (/entrada|entry|buy/i.test(route)) return { kind: "entry", source: "texto" };
  }
  return { kind: "unknown", source: "desconhecido" };
}

/* -------------------------------------------------------------------------- */
/* 2. RÓTULO DE UM TRADE                                                      */
/* -------------------------------------------------------------------------- */

export function labelTrade(trade: DBTrade): LabeledOutcome {
  const provenance: string[] = [];
  const mode: LabeledOutcome["mode"] = trade.mode === "live" || trade.mode === "paper" ? trade.mode : "unknown";
  const { kind, source: kindSource } = classifyAttemptKind(trade);
  const status = String(trade.status ?? "unknown");
  const pnl = typeof trade.pnlNetSol === "number" && Number.isFinite(trade.pnlNetSol) ? trade.pnlNetSol : null;
  const measured = trade.measuredOnChain === true;
  if (measured) provenance.push("measuredOnChain=true");
  if (pnl !== null) provenance.push("pnlNetSol");

  const base = {
    id: trade.id,
    mint: trade.mint,
    token: trade.token,
    mode,
    source: "trade" as const,
    costs: {
      feesSol: typeof trade.feesSol === "number" && Number.isFinite(trade.feesSol) ? trade.feesSol : null,
      tipSol: typeof trade.tipSol === "number" && Number.isFinite(trade.tipSol) ? trade.tipSol : null,
    },
    signature: typeof trade.signature === "string" && trade.signature !== "" ? trade.signature : null,
    slot: Number.isFinite(trade.block) ? trade.block : null,
    attemptKind: kind,
    attemptKindSource: kindSource,
    at: parseStamp(trade.time),
  };

  /**
   * ORDEM DAS REGRAS (importa): primeiro o que é MEDIDO, depois tentativa falhada, depois perna de
   * entrada, e só então "sem número". Se a ordem fosse outra, um trade com PnL medido e rota de
   * saída mal classificada poderia cair em "entrada" — perdendo a melhor evidência que existe.
   */
  if (pnl !== null && measured && mode === "live") {
    const label: OutcomeLabel = pnl > BREAKEVEN_EPSILON_SOL ? "win" : pnl < -BREAKEVEN_EPSILON_SOL ? "loss" : "breakeven";
    return {
      ...base,
      label,
      basis: "net_measured",
      pnlNetSol: pnl,
      pnlPercent: null,
      reason:
        `PnL líquido MEDIDO on-chain (inclui tip, priority fee e base fee conforme o extrator): ` +
        `${pnl >= 0 ? "+" : ""}${pnl.toFixed(9)} SOL`,
      excluded: false,
      exclusionReason: null,
      provenance,
    };
  }

  if (pnl !== null && mode === "paper") {
    return {
      ...base,
      label: pnl > BREAKEVEN_EPSILON_SOL ? "win" : pnl < -BREAKEVEN_EPSILON_SOL ? "loss" : "breakeven",
      basis: "net_measured",
      pnlNetSol: pnl,
      pnlPercent: null,
      reason: "resultado de PAPER: medido no simulador, não é dinheiro — NUNCA entra na validação",
      excluded: true,
      exclusionReason: "modo paper",
      provenance: [...provenance, "mode=paper"],
    };
  }

  if (status === "failed" || status === "rejected" || status === "blacklisted") {
    return {
      ...base,
      label: "failed_attempt",
      basis: "none",
      pnlNetSol: null,
      pnlPercent: null,
      reason:
        `tentativa com status "${status}"${kind !== "unknown" ? ` (${kind})` : ""}: é CUSTO (taxa/tip ` +
        `possivelmente pagos) e não resultado de estratégia`,
      excluded: true,
      exclusionReason: "tentativa falhada/recusada",
      provenance: [...provenance, `status=${status}`],
    };
  }

  /**
   * Sem PnL medido. Se há resultado de PREÇO em outro lugar (posição fechada), o número sai de lá —
   * aqui o registro é a perna de entrada, que por natureza não tem resultado.
   */
  if (kind === "entry" || (pnl === null && (status === "confirmed" || status === "success"))) {
    return {
      ...base,
      label: "entry_leg",
      basis: "none",
      pnlNetSol: null,
      pnlPercent: null,
      reason: "perna de ENTRADA: o resultado da operação só existe quando a posição é fechada",
      excluded: true,
      exclusionReason: "perna de entrada",
      provenance: [...provenance, `status=${status}`],
    };
  }

  return {
    ...base,
    label: "unresolved",
    basis: "none",
    pnlNetSol: null,
    pnlPercent: null,
    reason:
      `sem número de resultado: pnlNetSol ausente e measuredOnChain=${trade.measuredOnChain === true}. ` +
      `Não é "zero": é NÃO MEDIDO`,
    excluded: true,
    exclusionReason: "resultado não medido",
    provenance,
  };
}

/* -------------------------------------------------------------------------- */
/* 3. RÓTULO DE UMA POSIÇÃO FECHADA (base ESTIMADA)                           */
/* -------------------------------------------------------------------------- */

/**
 * Posição fechada só tem resultado de PREÇO (`pnlPercent`). O rótulo é `estimated_*` e é SEMPRE
 * excluído da validação — mas continua visível, porque uma sequência de `estimated_loss` com
 * `measured` ausente é o sintoma de que a medição on-chain não está funcionando.
 */
export function labelPosition(pos: DBPosition): LabeledOutcome {
  const pct = typeof pos.pnlPercent === "number" && Number.isFinite(pos.pnlPercent) ? pos.pnlPercent : null;
  const mode: LabeledOutcome["mode"] = pos.mode === "live" || pos.mode === "paper" ? pos.mode : "unknown";
  const provenance: string[] = ["pnlPercent (preço, sem custos)"];
  if (pos.entryPriceVerification) provenance.push(`entrada verificada: ${pos.entryPriceVerification.status}`);
  if (pos.slippageBps !== undefined) provenance.push(`slippageBps=${pos.slippageBps}`);

  const base = {
    id: `pos_${pos.id}`,
    mint: pos.mint,
    token: pos.token,
    mode,
    source: "position" as const,
    costs: { feesSol: null, tipSol: null },
    signature: null,
    slot: null,
    attemptKind: "exit" as AttemptKind,
    attemptKindSource: "campo" as const,
    at: parseStamp(pos.timeClosed ?? pos.timeOpened),
  };

  if (pct === null) {
    return {
      ...base,
      label: "unresolved",
      basis: "none",
      pnlNetSol: null,
      pnlPercent: null,
      reason: "posição sem `pnlPercent` numérico: não há resultado a rotular",
      excluded: true,
      exclusionReason: "resultado não medido",
      provenance,
    };
  }

  const label: OutcomeLabel =
    pct > 0.01 ? "estimated_win" : pct < -0.01 ? "estimated_loss" : "estimated_breakeven";
  return {
    ...base,
    label,
    basis: "price_estimated",
    pnlNetSol: null,
    pnlPercent: pct,
    reason:
      `resultado de PREÇO (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%): NÃO inclui tip, priority fee, ` +
      `base fee nem rent da ATA — serve para diagnóstico, não para concluir edge`,
    excluded: true,
    exclusionReason: "base estimada (preço, sem custos)",
    provenance,
  };
}

/* -------------------------------------------------------------------------- */
/* 4. COBERTURA (o relatório que impede conclusão sobre amostra viciada)      */
/* -------------------------------------------------------------------------- */

export function summarizeCoverage(labeled: LabeledOutcome[]): LabelCoverage {
  const byLabel = {} as Record<OutcomeLabel, number>;
  for (const l of labeled) byLabel[l.label] = (byLabel[l.label] ?? 0) + 1;
  const measured = labeled.filter((l) => l.basis === "net_measured" && !l.excluded).length;
  const estimated = labeled.filter((l) => l.basis === "price_estimated").length;
  const withoutNumber = labeled.filter((l) => l.basis === "none").length;
  const total = labeled.length;
  const missingShare = total > 0 ? withoutNumber / total : 0;

  const notes: string[] = [];
  if (total === 0) {
    notes.push("nenhum registro: sem dado não há conclusão — e 'sem dado' não é 'sem perda'");
  }
  if (measured > 0 && estimated > measured * 2) {
    notes.push(
      `${estimated} resultado(s) de PREÇO contra ${measured} MEDIDO(s): a medição on-chain parece não ` +
        `estar preenchendo os trades — investigue antes de olhar qualquer métrica`
    );
  }
  /**
   * O aviso vale a partir de 5 registros — não de 10. Amostra pequena COM muito dado faltando é
   * exatamente a situação em que concluir é mais perigoso, e um limite alto suprimiria o aviso
   * justamente ali. Abaixo de 5, tudo é anedota e o veredito (`amostra_insuficiente`) já diz isso.
   */
  if (missingShare > 0.3 && total >= 5) {
    notes.push(
      `${(missingShare * 100).toFixed(0)}% dos registros não têm número de resultado: a amostra válida ` +
        `pode estar enviesada (os casos piores/melhores são justamente os que falham na medição)`
    );
  }
  return { total, byLabel, measured, estimated, withoutNumber, missingShare, notes };
}

/** Junta trades e posições em um conjunto rotulado, sem duplicar o mesmo desfecho. */
export function labelAll(trades: DBTrade[], positions: DBPosition[]): LabeledOutcome[] {
  const out = trades.map(labelTrade);
  /**
   * Posições fechadas entram como base ESTIMADA — sempre. Elas não substituem um trade medido do
   * mesmo mint: somam-se como diagnóstico. Duplicar o mesmo desfecho como win medido + estimated_win
   * inflaria a contagem de operações e a "amostra" pareceria maior do que é.
   */
  for (const pos of positions) {
    if (pos.status !== "closed") continue;
    out.push(labelPosition(pos));
  }
  return out;
}

function parseStamp(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}
