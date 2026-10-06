/**
 * RECONCILIAÇÃO DA PERNA DE ENTRADA (S14).
 *
 * ## Por que isto existe
 *
 * O S11 corrigiu a contabilidade: `pnlNetSol` passou a exigir as DUAS pernas (ΔSOL da entrada +
 * ΔSOL da saída). O efeito colateral é que todo o histórico anterior ficou em `exit_leg_only` —
 * a receita da venda é conhecida, o lucro do ciclo não — e o pior: os registros PRÉ-S11 têm
 * `pnlNetSol` preenchido com o ΔSOL da **venda**, que é receita, não lucro (o defeito do Adendo 19).
 *
 * Sem amostra, `GET /api/performance` (S9) não tem o que validar. Este módulo converte aquele
 * histórico em ciclo medido — **mas só quando pode provar**, e sem apagar o que estava lá.
 *
 * ## O que a reconciliação É e o que ela NÃO É
 *
 * - É **medição nova da MESMA transação**: a perna de entrada é relida da cadeia
 *   (`getTransaction` na assinatura gravada) e o ΔSOL da carteira dentro daquela transação é
 *   imutável — medir hoje dá o mesmo número que mediria no dia. Para a perna de saída, o valor
 *   registrado é conferido contra a releitura: se divergir além da tolerância, o registro é
 *   RECUSADO (`EXIT_LEG_MISMATCH`) em vez de promovido — divergência significa que outra coisa
 *   mexeu no saldo e o número não é confiável.
 * - NÃO é reinterpretação de histórico: o número antigo (quando era a receita da venda) é
 *   PRESERVADO em `supersededPnlNetSol` com o motivo escrito em `reconciliationNote`, e o novo
 *   valor vem com procedência própria (`pnlBasis: "round_trip_legs_reconciled"`).
 * - NÃO adivinha qual foi a entrada: se houver mais de um candidato para o mesmo mint, o registro
 *   é recusado por AMBIGUIDADE (`AMBIGUOUS_ENTRY`) em vez de escolher o mais provável.
 *
 * ## Como o candidato de entrada é identificado
 *
 * O trade de SAÍDA guarda `mint` e `signature`. O trade de ENTRADA do mesmo mint é localizado com
 * três exigências: (1) `mode: live`; (2) status de execução confirmada; (3) assinatura on-chain
 * presente. Quando os dois blocos são conhecidos, exige-se `entrada <= saída`. Mais de um
 * candidato ⇒ recusa declarada.
 *
 * Puro: nenhuma rede, nenhum relógio global, nenhum disco. As pernas entram já medidas.
 */

import type { DBTrade } from "./persistence.js";
import { classifyAttemptKind } from "./outcomeLabels.js";
import {
  computeRoundTrip,
  WINDOW_CONFLICT_EPSILON_SOL,
  type RoundTripEconomics,
  type TransactionLegEconomics,
} from "./roundTrip.js";

/* -------------------------------------------------------------------------- */
/* 0. TOLERÂNCIA                                                               */
/* -------------------------------------------------------------------------- */

export const RECONCILE_DEFAULTS = Object.freeze({
  /**
   * Tolerância entre o valor REGISTRADO da venda e a releitura da perna de saída, em SOL.
   * Igual à da conferência de janela do S11 (5.000 lamports): abaixo disso é ruído de
   * arredondamento; acima, é sinal de que outra movimentação mexeu no saldo — e a promoção
   * do registro é recusada.
   */
  toleranceSol: WINDOW_CONFLICT_EPSILON_SOL,
});

/** Resolve a tolerância do ambiente (`HFT_RECONCILE_TOLERANCE_SOL`). Pura. */
export function resolveReconcileToleranceSol(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.HFT_RECONCILE_TOLERANCE_SOL ?? "").trim();
  if (raw === "") return RECONCILE_DEFAULTS.toleranceSol;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return RECONCILE_DEFAULTS.toleranceSol;
  return n;
}

/* -------------------------------------------------------------------------- */
/* 1. PLANO (quem PODE ser reconciliado)                                       */
/* -------------------------------------------------------------------------- */

export type ReconcileSkipCode =
  | "NOT_AN_EXIT"
  | "NOT_LIVE"
  | "NOT_MEASURED_EXIT"
  | "ALREADY_RECONCILED"
  | "NO_ENTRY_SIGNATURE"
  | "AMBIGUOUS_ENTRY"
  | "ENTRY_AFTER_EXIT";

export interface ReconcilePlanItem {
  exitTradeId: string;
  entryTradeId: string;
  mint: string;
  token: string;
  entrySignature: string;
  exitSignature: string;
  entryBlock: number;
  exitBlock: number;
  /** Valor registrado da venda (S11) — ou, em registros pré-S11, o `pnlNetSol` que ERA a venda. */
  recordedSaleProceedsSol: number | null;
  /** Procedência do registro original, para a nota: pré-S11 (`pnlBasis` ausente) ou S11. */
  originalBasis: string | null;
}

export interface ReconcileSkip {
  exitTradeId: string;
  mint: string;
  token: string;
  code: ReconcileSkipCode;
  reason: string;
}

export interface ReconcilePlan {
  items: ReconcilePlanItem[];
  skipped: ReconcileSkip[];
  counts: { considered: number; eligible: number; skipped: number; byCode: Record<string, number> };
  note: string;
}

/** Statuses de um trade de ENTRADA que provam execução (a posição só existe com slot observado). */
const LANDED_ENTRY_STATUS = new Set(["confirmed", "success"]);

function statusOf(t: DBTrade): string {
  return String(t.status ?? "unknown");
}

function isLandedEntry(t: DBTrade): boolean {
  return (
    t.mode === "live" &&
    LANDED_ENTRY_STATUS.has(statusOf(t)) &&
    typeof t.signature === "string" &&
    t.signature.trim() !== "" &&
    classifyAttemptKind(t).kind === "entry"
  );
}

/** Bases de PnL que já representam um ciclo completo (nada a reconciliar). */
function alreadyReconciled(t: DBTrade): boolean {
  const basis = typeof t.pnlBasis === "string" ? t.pnlBasis : null;
  if (typeof t.reconciledAt === "string" && t.reconciledAt !== "") return true;
  return basis !== null && basis.startsWith("round_trip_legs");
}

/**
 * Constrói o plano: para cada trade de saída real que está em perna única, procura o trade de
 * entrada correspondente. Nada é medido aqui (sem rede) — o plano diz o que PODE ser medido.
 */
export function planEntryLegReconciliation(trades: DBTrade[]): ReconcilePlan {
  const items: ReconcilePlanItem[] = [];
  const skipped: ReconcileSkip[] = [];
  const byCode: Record<string, number> = {};
  const lista = Array.isArray(trades) ? trades : [];

  const skip = (t: DBTrade, code: ReconcileSkipCode, reason: string) => {
    byCode[code] = (byCode[code] ?? 0) + 1;
    skipped.push({
      exitTradeId: t.id ?? "(sem id)",
      mint: t.mint ?? "(sem mint)",
      token: t.token ?? "?",
      code,
      reason,
    });
  };

  for (const t of lista) {
    const kind = classifyAttemptKind(t).kind;
    if (kind !== "exit") {
      /**
       * Entradas e falhas não entram na fila (não têm ciclo a fechar) e NÃO poluem o relatório.
       * Exceção declarada: trade de execução real com número medido mas classificação
       * desconhecida — pode ser uma saída sem procedência identificável, e silêncio aqui seria
       * esconder um registro que talvez devesse estar na fila.
       */
      const temNumeroMedido =
        t.mode === "live" &&
        t.measuredOnChain === true &&
        (typeof t.pnlNetSol === "number" || typeof (t as any).saleProceedsSol === "number");
      if (temNumeroMedido) {
        skip(
          t,
          "NOT_AN_EXIT",
          `trade de execução real com número medido, mas classificável como "${kind}" — não é possível afirmar ` +
            `que fecha um ciclo; fica declarado em vez de silenciado`
        );
      }
      continue;
    }
    if (t.mode !== "live") {
      skip(t, "NOT_LIVE", `mode=${String(t.mode ?? "ausente")} — só execução real entra na validação`);
      continue;
    }
    if (alreadyReconciled(t)) {
      skip(t, "ALREADY_RECONCILED", `já é ciclo completo (pnlBasis=${String(t.pnlBasis ?? "com reconciledAt")})`);
      continue;
    }

    const saleProceeds = typeof t.saleProceedsSol === "number" && Number.isFinite(t.saleProceedsSol) ? t.saleProceedsSol : null;
    const legacyPnl = typeof t.pnlNetSol === "number" && Number.isFinite(t.pnlNetSol) ? t.pnlNetSol : null;
    if (t.measuredOnChain !== true || (saleProceeds === null && legacyPnl === null)) {
      skip(
        t,
        "NOT_MEASURED_EXIT",
        `saída sem medição on-chain utilizável (measuredOnChain=${String(t.measuredOnChain)}, ` +
          `saleProceedsSol=${String(saleProceeds)}, pnlNetSol=${String(legacyPnl)}) — sem número da venda não há o que fechar`
      );
      continue;
    }
    if (typeof t.signature !== "string" || t.signature.trim() === "") {
      skip(t, "NOT_MEASURED_EXIT", "saída sem assinatura gravada: não há transação a remedir");
      continue;
    }

    const exitBlock = Number.isFinite(t.block) ? Number(t.block) : 0;
    const candidatos = lista.filter(
      (c) =>
        c.mint === t.mint &&
        isLandedEntry(c) &&
        (exitBlock <= 0 || !Number.isFinite(c.block) || Number(c.block) <= 0 || Number(c.block) <= exitBlock)
    );

    if (candidatos.length === 0) {
      const existiam = lista.filter((c) => c.mint === t.mint && isLandedEntry(c) === false && classifyAttemptKind(c).kind === "entry");
      skip(
        t,
        "NO_ENTRY_SIGNATURE",
        existiam.length > 0
          ? `${existiam.length} trade(s) de entrada para o mint não servem (sem assinatura, sem status confirmado ou ` +
            `posteriores à saída): a perna de entrada não pode ser remedida e o ciclo segue NÃO medido`
          : "nenhum trade de entrada com assinatura on-chain para este mint: a perna de entrada não existe no histórico"
      );
      continue;
    }
    if (candidatos.length > 1) {
      skip(
        t,
        "AMBIGUOUS_ENTRY",
        `há ${candidatos.length} entradas candidatas (${candidatos
          .map((c) => String(c.id))
          .slice(0, 3)
          .join(", ")}${candidatos.length > 3 ? ", …" : ""}): escolher a "mais provável" seria inventar ` +
          `qual compra é a desta venda — o registro segue NÃO medido até haver vínculo explícito`
      );
      continue;
    }

    const entrada = candidatos[0];
    if (Number.isFinite(entrada.block) && Number.isFinite(t.block) && Number(entrada.block) > Number(t.block) && Number(t.block) > 0) {
      skip(t, "ENTRY_AFTER_EXIT", `entrada no bloco ${entrada.block} depois da saída no bloco ${t.block}`);
      continue;
    }

    items.push({
      exitTradeId: String(t.id),
      entryTradeId: String(entrada.id),
      mint: String(t.mint),
      token: String(t.token ?? "?"),
      entrySignature: String(entrada.signature),
      exitSignature: String(t.signature),
      entryBlock: Number.isFinite(entrada.block) ? Number(entrada.block) : 0,
      exitBlock: Number.isFinite(t.block) ? Number(t.block) : 0,
      recordedSaleProceedsSol: saleProceeds ?? legacyPnl,
      originalBasis: typeof t.pnlBasis === "string" ? t.pnlBasis : null,
    });
  }

  return {
    items,
    skipped,
    counts: {
      considered: lista.length,
      eligible: items.length,
      skipped: skipped.length,
      byCode,
    },
    note:
      `${items.length} registro(s) podem ser reconciliados (perna de entrada localizada, uma única ` +
      `candidata) e ${skipped.length} ficam de fora com o motivo declarado. Reconciliar é REMEDIR a ` +
      `transação de entrada na cadeia — não é reinterpretar histórico: o registro anterior é preservado.`,
  };
}

/* -------------------------------------------------------------------------- */
/* 2. DECISÃO (o que a medição permite concluir)                               */
/* -------------------------------------------------------------------------- */

export type ReconcileRefusalCode = "ENTRY_LEG_UNMEASURED" | "EXIT_LEG_UNMEASURED" | "EXIT_LEG_MISMATCH" | "CYCLE_NOT_MEASURED";

export type ReconcileDecision =
  | {
      action: "reconcile";
      cycle: RoundTripEconomics;
      exitProceedsSol: number;
      expectedExitProceedsSol: number | null;
      mismatchSol: number | null;
    }
  | { action: "refuse"; code: ReconcileRefusalCode; reason: string };

export interface ReconcileDecisionInput {
  entryLeg: TransactionLegEconomics;
  exitLeg: TransactionLegEconomics;
  /** Registrado no S11. */
  recordedSaleProceedsSol?: number | null;
  /** Registrado ANTES do S11 (quando `pnlNetSol` era o ΔSOL da venda). */
  recordedLegacyPnlSol?: number | null;
  toleranceSol?: number;
}

/**
 * Decide se a releitura das duas pernas autoriza promover o registro a ciclo medido.
 *
 * Fail-closed: qualquer perna não medida, ciclo não medido ou divergência acima da tolerância
 * contra o valor registrado ⇒ RECUSA com motivo. Nunca "promove porque parece plausível".
 */
export function decideEntryLegReconciliation(input: ReconcileDecisionInput): ReconcileDecision {
  const tol = Number.isFinite(input.toleranceSol) && (input.toleranceSol as number) >= 0
    ? (input.toleranceSol as number)
    : RECONCILE_DEFAULTS.toleranceSol;

  const entry = input.entryLeg;
  const exit = input.exitLeg;

  if (!entry || entry.measured !== true || entry.solDeltaLamports === null) {
    return {
      action: "refuse",
      code: "ENTRY_LEG_UNMEASURED",
      reason: `perna de ENTRADA não medida (${entry?.error ?? "motivo não informado"}) — sem ela o ciclo continua NÃO medido`,
    };
  }
  if (!exit || exit.measured !== true || exit.solDeltaLamports === null) {
    return {
      action: "refuse",
      code: "EXIT_LEG_UNMEASURED",
      reason: `perna de SAÍDA não medida na releitura (${exit?.error ?? "motivo não informado"}) — o valor registrado não pôde ser conferido`,
    };
  }

  const exitProceedsSol = exit.solDeltaLamports / 1e9;
  const expected =
    typeof input.recordedSaleProceedsSol === "number" && Number.isFinite(input.recordedSaleProceedsSol)
      ? input.recordedSaleProceedsSol
      : typeof input.recordedLegacyPnlSol === "number" && Number.isFinite(input.recordedLegacyPnlSol)
        ? input.recordedLegacyPnlSol
        : null;

  let mismatch: number | null = null;
  if (expected !== null) {
    mismatch = Math.abs(exitProceedsSol - expected);
    if (mismatch > tol) {
      return {
        action: "refuse",
        code: "EXIT_LEG_MISMATCH",
        reason:
          `a releitura da SAÍDA (${exitProceedsSol.toFixed(9)} SOL) diverge do valor registrado ` +
          `(${expected.toFixed(9)} SOL) em ${mismatch.toFixed(9)} SOL — acima da tolerância de ${tol} SOL. ` +
          `Divergência significa que outra movimentação mexeu no saldo desta carteira: o registro NÃO é promovido.`,
      };
    }
  }

  const cycle = computeRoundTrip({ entry, exit });
  if (!cycle.measured || cycle.pnlNetSol === null) {
    return {
      action: "refuse",
      code: "CYCLE_NOT_MEASURED",
      reason: `o ciclo não fechou como medido (${cycle.basis}): ${cycle.reasons.join("; ") || "motivo não informado"}`,
    };
  }

  return { action: "reconcile", cycle, exitProceedsSol, expectedExitProceedsSol: expected, mismatchSol: mismatch };
}

/* -------------------------------------------------------------------------- */
/* 3. ESCRITA (o registro novo, com procedência)                                */
/* -------------------------------------------------------------------------- */

export interface BuildReconciledTradeInput {
  entryLeg: TransactionLegEconomics;
  exitLeg: TransactionLegEconomics;
  cycle: RoundTripEconomics;
  reconciledAt: string;
  mismatchSol: number | null;
  expectedExitProceedsSol: number | null;
}

/**
 * Monta o trade reconciliado. REGRAS DE HONESTIDADE:
 *   - `pnlBasis` ganha valor PRÓPRIO (`round_trip_legs_reconciled`) — o subconjunto reconciliado
 *     continua separável do que foi medido em tempo real;
 *   - o número anterior é PRESERVADO em `supersededPnlNetSol` (era a receita da venda, não o lucro);
 *   - `saleProceedsSol` registrado nunca é sobrescrito; quando ausente (pré-S11), é preenchido com a
 *     receita medida na releitura e a nota diz que veio daí;
 *   - a nota declara o que foi feito, quando e com qual tolerância.
 */
export function buildReconciledTrade(trade: DBTrade, input: BuildReconciledTradeInput): DBTrade {
  const pnlNovo = input.cycle.pnlNetSol as number;
  const anterior = typeof trade.pnlNetSol === "number" && Number.isFinite(trade.pnlNetSol) ? trade.pnlNetSol : null;
  const saleProceeds = typeof trade.saleProceedsSol === "number" && Number.isFinite(trade.saleProceedsSol) ? trade.saleProceedsSol : null;

  const partes: string[] = [
    `Reconciliado em ${input.reconciledAt}: as DUAS pernas foram medidas on-chain ` +
      `(entrada ${input.entryLeg.signature ?? "?"}, saída ${input.exitLeg.signature ?? "?"}).`,
    `PnL do ciclo = ΔSOL(entrada) + ΔSOL(saída) = ${pnlNovo >= 0 ? "+" : ""}${pnlNovo.toFixed(9)} SOL.`,
  ];
  if (anterior !== null) {
    partes.push(
      `O número anterior (${anterior >= 0 ? "+" : ""}${anterior.toFixed(9)} SOL) era a RECEITA da venda e está ` +
        `preservado em supersededPnlNetSol — NÃO é lucro e não deve ser usado como resultado.`
    );
  }
  partes.push(
    input.expectedExitProceedsSol === null
      ? "Não havia valor registrado da venda para conferir (registro anterior ao S11 sem número utilizável)."
      : `A releitura da saída confere com o valor registrado (${input.expectedExitProceedsSol.toFixed(9)} SOL, ` +
        `divergência ${(input.mismatchSol ?? 0).toFixed(9)} SOL dentro da tolerância).`
  );
  partes.push("Nada foi reinterpretado: a medição é da MESMA transação, relida da cadeia.");

  return {
    ...trade,
    pnlNetSol: pnlNovo,
    pnlBasis: "round_trip_legs_reconciled",
    measuredOnChain: true,
    feesSol: input.cycle.feesSol ?? trade.feesSol,
    entryLegSignature: input.entryLeg.signature ?? null,
    reconciledAt: input.reconciledAt,
    reconciliationNote: partes.join(" "),
    ...(anterior !== null ? { supersededPnlNetSol: anterior } : {}),
    ...(saleProceeds === null ? { saleProceedsSol: (input.exitLeg.solDeltaLamports as number) / 1e9 } : {}),
  } as DBTrade;
}

/* -------------------------------------------------------------------------- */
/* 4. RESUMO                                                                    */
/* -------------------------------------------------------------------------- */

export interface ReconcileOutcomeRow {
  exitTradeId: string;
  mint: string;
  token: string;
  verdict: "reconciled" | "refused";
  code: string;
  pnlNetSol: number | null;
  previousPnlSol: number | null;
  reason: string;
}

export interface ReconcileSummary {
  planned: number;
  considered: number;
  reconciled: number;
  refused: number;
  skipped: number;
  totalPnlSol: number;
  byRefusal: Record<string, number>;
  bySkip: Record<string, number>;
  note: string;
}

export function summarizeReconciliation(
  plan: ReconcilePlan,
  rows: ReconcileOutcomeRow[]
): ReconcileSummary {
  const reconciled = rows.filter((r) => r.verdict === "reconciled");
  const refused = rows.filter((r) => r.verdict === "refused");
  const byRefusal: Record<string, number> = {};
  for (const r of refused) byRefusal[r.code] = (byRefusal[r.code] ?? 0) + 1;

  return {
    planned: plan.items.length,
    considered: plan.counts.considered,
    reconciled: reconciled.length,
    refused: refused.length,
    skipped: plan.counts.skipped,
    totalPnlSol: Number(reconciled.reduce((acc, r) => acc + (r.pnlNetSol ?? 0), 0).toFixed(9)),
    byRefusal,
    bySkip: plan.counts.byCode,
    note:
      `${reconciled.length} registro(s) promovidos a ciclo medido (marcados como ` +
      `round_trip_legs_reconciled — separáveis do que foi medido em tempo real) e ${refused.length} ` +
      `recusado(s) por falta de prova. O histórico NÃO foi reescrito: onde havia receita de venda gravada ` +
      `como PnL, o valor anterior ficou preservado em supersededPnlNetSol.`,
  };
}
