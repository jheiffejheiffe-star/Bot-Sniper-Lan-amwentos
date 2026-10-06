/**
 * CUSTO DA VOLTA (A) — o piso de custo de um ciclo completo, em PAPER, sem tocar a rede.
 *
 * ## Por que este módulo existe
 *
 * `recordPaperClose` calculava o resultado da sombra como `sizeSol * pnlPercent / 100` — puro
 * movimento de PREÇO. Custo zero. No papel, um "+2%" em 0,01 SOL aparecia como +0,0002 SOL de
 * "lucro", ignorando que o ciclo real paga: fee base nas DUAS pernas, tip do Jito nas duas (ou na
 * entrada), priority fee, slippage e fee de AMM. Com o teto de tip em 50 bps (`MAX_TIP_BPS`), só o
 * tip das duas pernas já custa ~1% do capital — ou seja, "+2%" no papel podia ser prejuízo real.
 *
 * O modelo de custo JÁ EXISTIA (`estimateRoundTripCosts`, hoje em `src/accounting.ts`) e não era
 * usado por NINGUÉM: 0 pontos de chamada. Um modelo de custo desligado é pior do que não ter
 * modelo, porque dá a impressão de que o custo está contabilizado.
 *
 * ## O que este módulo garante
 *
 * 1. **Piso conhecido × premissas × não medido, separados.** Tip/fee base são política declarada do
 *    caminho real. Slippage/AMM são PREMISSAS (a sombra não preenche ordem: não há fill para
 *    medir). O que não é conhecido NÃO vira número: entra em `naoMedidos` com o motivo.
 * 2. **Limite inferior declarado.** Sem `HFT_PRIORITY_FEE_MICROLAMPORTS`, a priority fee é
 *    `null` e o piso é explicitamente um LIMITE INFERIOR (`limitacoes`), nunca um número cheio.
 * 3. **Nada de rede, relógio ou disco.** Funções puras: o mesmo valor em qualquer máquina.
 *
 * ## O que este módulo NÃO faz
 *
 * - Não mede slippage real, impacto de preço, latência nem o tip efetivamente pago (isso só existe
 *   com execução real e é lido das transações — S11).
 * - Não decide entrada/saída e não altera os gatilhos de stop/take-profit: o gatilho continua sendo
 *   movimento de PREÇO (conflacionar preço com custo faria o stop disparar por fee).
 */

import { BASE_FEE_LAMPORTS, LAMPORTS_PER_SOL, clampTipSol, estimatePriorityFeeSol } from "./accounting.js";

export type CostProvenance = "declarado" | "premissa" | "nao_declarado";

export interface CostLine {
  key: string;
  label: string;
  sol: number | null;
  provenance: CostProvenance;
  /** Por que este número (ou por que ele não existe). */
  reason: string;
}

export interface RoundTripCostPolicy {
  /** Tip DESEJADO na entrada (SOL), antes do teto em bps. */
  entryTipDesiredSol: number;
  /** Tip DESEJADO na saída (SOL), antes do teto em bps. */
  exitTipDesiredSol: number;
  /** Teto de tip em bps do capital — o mesmo `MAX_TIP_BPS` do caminho real (default 50). */
  maxTipBps: number;
  /** micro-lamports por CU. `null` = NÃO declarado ⇒ priority fee fica fora do piso conhecido. */
  priorityFeeMicroLamportsPerCu: number | null;
  computeUnitsPerLeg: number;
  /** Slippage assumido por perna (bps). Premissa, não medição. */
  slippageBps: number;
  /** Fee de AMM/rota assumida (bps do capital). Premissa, não medição. */
  ammFeeBps: number;
  /** De onde veio cada valor (auditoria: nenhum número sem procedência). */
  sources: Record<string, string>;
}

function numOrNull(raw: string | undefined): number | null {
  const s = (raw ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function num(raw: string | undefined, fallback: number): number {
  const n = numOrNull(raw);
  return n === null ? fallback : n;
}

/**
 * Resolve a política de custo a partir do ambiente. Os defaults NÃO são inventados: onde o caminho
 * real tem política declarada, é a MESMA política que entra aqui.
 *
 * - tip desejado 0,003 SOL com teto `MAX_TIP_BPS` (50 bps) — é o que os DOIS fechamentos reais usam
 *   (`clampTipSol(0.003, pos.sizeSol, MAX_TIP_BPS)`);
 * - slippage: `HFT_PAPER_SLIPPAGE_BPS` → `HFT_ENTRY_SLIPPAGE_BPS` → 300 bps (o mesmo parâmetro que
 *   a validação de sombra usa para cotar);
 * - CU por perna: `HFT_ENTRY_CU_LIMIT` (default 200000);
 * - fee de AMM: `HFT_PAPER_AMM_FEE_BPS` (default 25 bps = 0,25%), PREMISSA declarada;
 * - priority fee: `HFT_PRIORITY_FEE_MICROLAMPORTS` — SEM declarar, o piso é limite inferior.
 */
export function resolveRoundTripCostPolicy(env: NodeJS.ProcessEnv = process.env): RoundTripCostPolicy {
  const priority = numOrNull(env.HFT_PRIORITY_FEE_MICROLAMPORTS);
  return {
    entryTipDesiredSol: num(env.HFT_PAPER_ENTRY_TIP_SOL, 0.003),
    exitTipDesiredSol: num(env.HFT_PAPER_EXIT_TIP_SOL, 0.003),
    maxTipBps: num(env.MAX_TIP_BPS, 50),
    priorityFeeMicroLamportsPerCu: priority,
    computeUnitsPerLeg: num(env.HFT_ENTRY_CU_LIMIT, 200_000),
    slippageBps: num(env.HFT_PAPER_SLIPPAGE_BPS, num(env.HFT_ENTRY_SLIPPAGE_BPS, 300)),
    ammFeeBps: num(env.HFT_PAPER_AMM_FEE_BPS, 25),
    sources: {
      entryTipDesiredSol: (env.HFT_PAPER_ENTRY_TIP_SOL ?? "").trim() !== "" ? "HFT_PAPER_ENTRY_TIP_SOL" : "política dos fechamentos reais (0,003 SOL desejado)",
      exitTipDesiredSol: (env.HFT_PAPER_EXIT_TIP_SOL ?? "").trim() !== "" ? "HFT_PAPER_EXIT_TIP_SOL" : "clampTipSol(0.003, size, MAX_TIP_BPS) do caminho real",
      maxTipBps: (env.MAX_TIP_BPS ?? "").trim() !== "" ? "MAX_TIP_BPS" : "default do clampTipSol (50 bps)",
      priorityFeeMicroLamportsPerCu: priority === null ? "NÃO DECLARADO (HFT_PRIORITY_FEE_MICROLAMPORTS)" : "HFT_PRIORITY_FEE_MICROLAMPORTS",
      computeUnitsPerLeg: (env.HFT_ENTRY_CU_LIMIT ?? "").trim() !== "" ? "HFT_ENTRY_CU_LIMIT" : "default 200.000 CU",
      slippageBps: (env.HFT_PAPER_SLIPPAGE_BPS ?? "").trim() !== "" ? "HFT_PAPER_SLIPPAGE_BPS" : (env.HFT_ENTRY_SLIPPAGE_BPS ?? "").trim() !== "" ? "HFT_ENTRY_SLIPPAGE_BPS" : "default 300 bps (mesmo parâmetro da sombra)",
      ammFeeBps: (env.HFT_PAPER_AMM_FEE_BPS ?? "").trim() !== "" ? "HFT_PAPER_AMM_FEE_BPS" : "PREMISSA default 25 bps",
    },
  };
}

export interface RoundTripLegCost {
  leg: "entry" | "exit";
  tipSol: number;
  tipClamped: boolean;
  baseFeeSol: number;
  priorityFeeSol: number | null;
}

export interface RoundTripCostFloor {
  sizeSol: number;
  legs: RoundTripLegCost[];
  /** Tips + fees base (+ priority fee SE declarada). Limite INFERIOR do custo do ciclo. */
  pisoConhecidoSol: number;
  /** Slippage + fee de AMM assumidas (premissas declaradas, NÃO medidas). */
  premissasSol: number;
  pisoComPremissasSol: number;
  /** Itens condicionais (não somados): só existem em certas condições e são declarados como tal. */
  condicionais: CostLine[];
  /** O que este piso NÃO inclui — cada item com o motivo de não estar medido. */
  naoMedidos: { key: string; reason: string }[];
  breakevenPercentConhecido: number;
  breakevenPercentComPremissas: number;
  limitacoes: string[];
  note: string;
}

/**
 * Piso de custo do ciclo (entrada + saída) para um tamanho de posição.
 * Determinístico: mesmo input ⇒ mesmo output, sem rede/relógio.
 */
export function paperRoundTripCostFloor(params: { sizeSol: number; policy: RoundTripCostPolicy }): RoundTripCostFloor {
  const { policy } = params;
  const sizeSol = params.sizeSol;

  const entrada = clampTipSol(policy.entryTipDesiredSol, sizeSol, policy.maxTipBps);
  const saida = clampTipSol(policy.exitTipDesiredSol, sizeSol, policy.maxTipBps);
  const baseFeeSol = BASE_FEE_LAMPORTS / LAMPORTS_PER_SOL;
  const priorityFeeSol =
    policy.priorityFeeMicroLamportsPerCu === null
      ? null
      : estimatePriorityFeeSol(policy.priorityFeeMicroLamportsPerCu, policy.computeUnitsPerLeg);

  const legs: RoundTripLegCost[] = [
    { leg: "entry", tipSol: entrada.tipSol, tipClamped: entrada.clamped, baseFeeSol, priorityFeeSol },
    { leg: "exit", tipSol: saida.tipSol, tipClamped: saida.clamped, baseFeeSol, priorityFeeSol },
  ];

  const pisoConhecidoSol = legs.reduce((acc, l) => acc + l.tipSol + l.baseFeeSol + (l.priorityFeeSol ?? 0), 0);
  const slippageSol = ((policy.slippageBps * 2) / 10_000) * sizeSol;
  const ammFeeSol = (policy.ammFeeBps / 10_000) * sizeSol;
  const premissasSol = slippageSol + ammFeeSol;
  const pisoComPremissasSol = pisoConhecidoSol + premissasSol;

  const limitacoes: string[] = [];
  if (priorityFeeSol === null) {
    limitacoes.push(
      "priority fee NÃO declarada (HFT_PRIORITY_FEE_MICROLAMPORTS ausente): este piso é um LIMITE INFERIOR — o custo real é maior ou igual a ele."
    );
  }
  limitacoes.push(
    "slippage e fee de AMM são PREMISSAS, não medições: a sombra não preenche ordem, então não existe fill para medir desvio de preço."
  );

  return {
    sizeSol,
    legs,
    pisoConhecidoSol,
    premissasSol,
    pisoComPremissasSol,
    condicionais: [
      {
        key: "ataRentSol",
        label: "rent da ATA do token (SE a conta ainda não existir)",
        sol: 2_039_280 / LAMPORTS_PER_SOL,
        provenance: "premissa",
        reason:
          "rent-exempt padrão de uma conta de token de 165 bytes (~0,00203928 SOL); é RECUPERÁVEL ao fechar a conta e NÃO é pago se a ATA já existir — por isso não entra no piso.",
      },
    ],
    naoMedidos: [
      { key: "slippageReal", reason: "exige fill real (a sombra não executa) — só mensurável nas transações confirmadas (S11)" },
      { key: "impactoDePreco", reason: "depende da profundidade do pool no momento da execução, não do preço de tela" },
      { key: "priorityFeePaga", reason: "só é conhecida lendo a transação que entrou no bloco" },
      { key: "latencia", reason: "não é custo em SOL, mas muda o preço de entrada (medida em separado pelo trace de latência)" },
    ],
    breakevenPercentConhecido: sizeSol > 0 ? (pisoConhecidoSol / sizeSol) * 100 : Number.POSITIVE_INFINITY,
    breakevenPercentComPremissas: sizeSol > 0 ? (pisoComPremissasSol / sizeSol) * 100 : Number.POSITIVE_INFINITY,
    limitacoes,
    note:
      `Piso de custo do ciclo para ${sizeSol} SOL: ${pisoConhecidoSol.toFixed(9)} SOL conhecidos ` +
      `(${sizeSol > 0 ? ((pisoConhecidoSol / sizeSol) * 100).toFixed(3) : "∞"}% do capital) e ` +
      `${pisoComPremissasSol.toFixed(9)} SOL com as premissas de slippage/AMM ` +
      `(${sizeSol > 0 ? ((pisoComPremissasSol / sizeSol) * 100).toFixed(3) : "∞"}%). ` +
      `Sem execução real não há slippage medido: os dois números são PISO, não previsão de resultado.`,
  };
}

export interface PaperCloseNetResult {
  sizeSol: number;
  pnlPercent: number;
  /** Resultado bruto do movimento de preço (o que a sombra calculava antes, sozinho). */
  pnlGrossSol: number;
  floor: RoundTripCostFloor;
  /** Bruto − piso conhecido (limite inferior de custo). */
  pnlNetKnownSol: number;
  /** Bruto − piso com as premissas de slippage/AMM (cenário declarado, não medição). */
  pnlNetWithAssumptionsSol: number;
}

/**
 * Aplica o piso de custo a um fechamento em sombra. NÃO altera gatilhos nem percentuais: recebe o
 * movimento de preço e devolve o resultado LÍQUIDO com o custo do ciclo descontado.
 */
export function applyCostFloorToPaperClose(params: {
  sizeSol: number;
  pnlPercent: number;
  policy: RoundTripCostPolicy;
}): PaperCloseNetResult {
  const pnlGrossSol = (params.sizeSol * params.pnlPercent) / 100;
  const floor = paperRoundTripCostFloor({ sizeSol: params.sizeSol, policy: params.policy });
  return {
    sizeSol: params.sizeSol,
    pnlPercent: params.pnlPercent,
    pnlGrossSol,
    floor,
    pnlNetKnownSol: pnlGrossSol - floor.pisoConhecidoSol,
    pnlNetWithAssumptionsSol: pnlGrossSol - floor.pisoComPremissasSol,
  };
}
