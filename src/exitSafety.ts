/**
 * SEGURANÇA DE SAÍDA E LIMITE DE PERDA (S12).
 *
 * ## O que este módulo NÃO faz (e por que está escrito aqui em cima)
 *
 * Ele **não** torna a operação lucrativa. Não existe configuração de bot que garanta
 * "só ganhar": cada operação paga base fee, priority fee, tip, spread e slippage, e o ativo
 * pode simplesmente cair depois da compra. Um número como "acerto garantido" só pode ser
 * produzido de três formas — escondendo as perdas, estimando o que não foi medido, ou
 * inventando. Este módulo existe para tornar as três impossíveis de acontecer por acidente.
 *
 * ## O que ele garante (e isso é verificável)
 *
 * 1. **Quantidade de venda vem da CADEIA, nunca de conta de padaria.** Se a leitura do saldo
 *    falhar, ou se o saldo for zero, a saída é ABORTADA: não se estima quantidade, não se
 *    assina, não se apaga posição. Antes disto, o caminho de saída calculava
 *    `sizeSol / entryPrice` quando o RPC devolvia zero ou falhava — ou seja, em cima de um
 *    número inventado (herdado do scaffold `b6df555`).
 * 2. **Fechamento só com prova de resíduo.** A posição deixa de existir no banco apenas
 *    quando a carteira comprova que não tem mais o token. Resíduo > 0 ⇒ posição CONTINUA
 *    aberta (o que sobrou é vendido no ciclo seguinte). Leitura falhou ⇒ posição continua
 *    aberta (não se apaga o que não se conseguiu verificar).
 * 3. **Posição não-provada não assina.** Só posição declarada `live` E com evidência
 *    on-chain de entrada é gerenciada como real. Posição sem `mode` (herança de scaffold) é
 *    `unverified`: continua contando para EXPOSIÇÃO (conservador), mas NÃO entra no caminho
 *    que assina — antes, `pos.mode` ausente era tratado como live e disparava venda real.
 * 4. **Perda diária limitada com kill switch.** Soma apenas PnL MEDIDO de ciclo completo
 *    (`round_trip_legs*`) das saídas reais do dia; ao atingir o teto declarado, o kill switch
 *    é acionado e novas entradas são recusadas. Perda não medida é declarada como não medida
 *    (nunca somada, nunca convertida em zero).
 *
 * ## Honestidade das contas
 *
 * `realizedLossSol` soma SOMENTE perdas medidas com data legível. Um trade medido sem data
 * (`time` no formato `HH:MM:SS` não tem dia) é contado em `undatedMeasured` e **não** entra na
 * soma: preferimos declarar a lacuna a inflar ou desinflar o número. O efeito prático é que o
 * limite diário é um piso, não uma prova de que nada mais foi perdido — e isso está dito na
 * `note` do estado, que é exibida no painel.
 *
 * Puro: nenhuma rede, nenhum relógio global, nenhum disco. Tudo entra por parâmetro.
 */

/* -------------------------------------------------------------------------- */
/* 0. POLÍTICA (env → números, com piso/teto)                                  */
/* -------------------------------------------------------------------------- */

export const EXIT_SAFETY_DEFAULTS = Object.freeze({
  /** Tentativas de leitura de saldo antes de declarar "não consegui ver". */
  balanceAttempts: 3,
  /** Espera entre tentativas (dobra a cada falha). */
  balanceBackoffMs: 400,
  /**
   * Resíduo tolerado para dar a posição como fechada, em unidades brutas do token.
   * Default 0 = prova exata. Token-2022 com transfer fee pode reter poeira; aí o operador
   * declara o valor (HFT_RESIDUAL_DUST_RAW) em vez de o código adivinhar.
   */
  residualDustRaw: 0,
  /** Intervalo mínimo entre tentativas de saída abortada da MESMA posição (anti-loop de RPC). */
  abortRecheckMs: 60_000,
});

function intEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  const s = (raw ?? "").trim();
  if (s === "") return fallback;
  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export interface ExitSafetyPolicy {
  balanceAttempts: number;
  balanceBackoffMs: number;
  residualDustRaw: number;
  abortRecheckMs: number;
}

/** Resolve a política do ambiente. Pura: mesmo env ⇒ mesma política. */
export function resolveExitSafetyPolicy(env: NodeJS.ProcessEnv = process.env): ExitSafetyPolicy {
  return {
    balanceAttempts: intEnv(env.HFT_EXIT_BALANCE_ATTEMPTS, EXIT_SAFETY_DEFAULTS.balanceAttempts, 1, 5),
    balanceBackoffMs: intEnv(env.HFT_EXIT_BALANCE_BACKOFF_MS, EXIT_SAFETY_DEFAULTS.balanceBackoffMs, 0, 5_000),
    residualDustRaw: intEnv(env.HFT_RESIDUAL_DUST_RAW, EXIT_SAFETY_DEFAULTS.residualDustRaw, 0, Number.MAX_SAFE_INTEGER),
    abortRecheckMs: intEnv(env.HFT_EXIT_ABORT_RECHECK_MS, EXIT_SAFETY_DEFAULTS.abortRecheckMs, 0, 3_600_000),
  };
}

/* -------------------------------------------------------------------------- */
/* 1. LEITURA DE SALDO FAIL-CLOSED                                             */
/* -------------------------------------------------------------------------- */

/** Uma conta de token do mint, como o RPC devolve (já parseada). */
export interface MintBalanceAccount {
  rawAmount: number;
  decimals: number | null;
  tokenAccount?: string | null;
}

/**
 * Resultado da leitura. `ok: false` significa **não consegui ver** — que é diferente de
 * "a carteira está vazia" (`ok: true, rawAmount: 0`). Confundir os dois é o erro que faz o
 * bot vender quantidade inventada.
 */
export interface MintBalanceRead {
  ok: boolean;
  rawAmount: number;
  decimals: number | null;
  accounts: number;
  attempts: number;
  errors: string[];
}

export interface MintBalanceDeps {
  /** UMA leitura completa (todas as contas do mint na carteira). Pode lançar. */
  readAccounts: () => Promise<MintBalanceAccount[]>;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  backoffMs?: number;
}

/**
 * Lê o saldo de um mint com retry + backoff. Uma leitura concluída — mesmo que devolva ZERO
 * contas — é um FATO e encerra o retry. Só quando TODAS as tentativas falham o resultado é
 * `ok: false`; nesse caso o chamador DEVE abortar a decisão (fail-closed), nunca estimar.
 */
export async function readMintBalanceFailClosed(deps: MintBalanceDeps): Promise<MintBalanceRead> {
  const attempts = Math.max(1, Math.trunc(deps.attempts ?? EXIT_SAFETY_DEFAULTS.balanceAttempts));
  const backoffMs = Math.max(0, Math.trunc(deps.backoffMs ?? EXIT_SAFETY_DEFAULTS.balanceBackoffMs));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const errors: string[] = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const accounts = (await deps.readAccounts()) ?? [];
      const rawAmount = accounts.reduce((acc, a) => acc + (Number.isFinite(a.rawAmount) ? a.rawAmount : 0), 0);
      const decimals = accounts.find((a) => a.decimals !== null && a.decimals !== undefined)?.decimals ?? null;
      return { ok: true, rawAmount, decimals, accounts: accounts.length, attempts: attempt, errors };
    } catch (err: any) {
      errors.push(`tentativa ${attempt}/${attempts}: ${err?.message ?? String(err)}`);
      if (attempt < attempts && backoffMs > 0) {
        await sleep(backoffMs * Math.pow(2, attempt - 1));
      }
    }
  }

  return { ok: false, rawAmount: 0, decimals: null, accounts: 0, attempts, errors };
}

/* -------------------------------------------------------------------------- */
/* 2. DECISÃO DE SAÍDA (a quantidade pode ser usada?)                          */
/* -------------------------------------------------------------------------- */

export type ExitBalanceVerdict =
  | { action: "proceed"; rawAmount: number; decimals: number; note: string }
  | { action: "abort_unverified"; code: "EXIT_ABORTED_BALANCE_UNREADABLE"; reason: string }
  | { action: "abort_zero_balance"; code: "EXIT_ABORTED_ZERO_ONCHAIN_BALANCE"; reason: string };

/**
 * Decide se existe quantidade VERIFICADA para vender.
 *
 * - leitura falhou  ⇒ `abort_unverified` (fail-closed)
 * - saldo zero      ⇒ `abort_zero_balance` (não se vende o que não existe; não se apaga a posição)
 * - saldo > 0       ⇒ `proceed` com o valor EXATO da cadeia
 *
 * `decimals` ausente junto de uma leitura bem-sucedida cai no valor passado pelo chamador
 * (`fallbackDecimals`) e o motivo fica na `note` — nunca silencioso.
 */
export function decideExitFromBalance(
  read: MintBalanceRead,
  fallbackDecimals = 9
): ExitBalanceVerdict {
  if (!read.ok) {
    return {
      action: "abort_unverified",
      code: "EXIT_ABORTED_BALANCE_UNREADABLE",
      reason:
        `saldo on-chain do mint não pôde ser lido em ${read.attempts} tentativa(s): ` +
        `${read.errors.join(" | ") || "motivo não informado"}. A saída é abortada SEM estimar ` +
        `quantidade, SEM assinar e SEM apagar a posição — vender número inventado é pior do que não vender.`,
    };
  }
  if (!(read.rawAmount > 0)) {
    return {
      action: "abort_zero_balance",
      code: "EXIT_ABORTED_ZERO_ONCHAIN_BALANCE",
      reason:
        `a carteira tem ZERO do mint ${read.accounts === 0 ? "(nenhuma conta de token)" : "(contas com saldo 0)"} ` +
        `— não há o que vender. A posição permanece aberta para reconciliação: NADA é estimado, nada é apagado.`,
    };
  }
  const decimals = read.decimals ?? fallbackDecimals;
  return {
    action: "proceed",
    rawAmount: read.rawAmount,
    decimals,
    note:
      `quantidade verificada on-chain: ${read.rawAmount} unidades brutas em ${read.accounts} conta(s)` +
      (read.decimals === null ? ` (decimals não veio na leitura; usando ${fallbackDecimals} declarado)` : ""),
  };
}

/* -------------------------------------------------------------------------- */
/* 3. FECHAMENTO (a posição pode sair do banco?)                               */
/* -------------------------------------------------------------------------- */

export type ResidualVerdict =
  | { close: true; remainingRaw: 0; reason: string }
  | { close: false; kind: "partial"; remainingRaw: number; reason: string }
  | { close: false; kind: "unverified"; remainingRaw: null; reason: string };

/**
 * Decide se a posição pode ser marcada como fechada e removida do banco.
 *
 * Regra: **só com prova de resíduo**. Contra-intuitivo de propósito — manter uma posição que
 * já foi vendida é menos grave do que apagar uma que ainda tem token: a primeira aparece na
 * reconciliação (POSITION_DESYNC) e alguém olha; a segunda some do radar e o ativo fica solto
 * na carteira sem stop e sem alvo.
 */
export function decideCloseFromResidual(read: MintBalanceRead, dustRaw = 0): ResidualVerdict {
  if (!read.ok) {
    return {
      close: false,
      kind: "unverified",
      remainingRaw: null,
      reason:
        `resíduo NÃO verificado (${read.errors.join(" | ") || "leitura falhou"}): a posição permanece ` +
        `aberta no banco. Não se apaga o que não se conseguiu ver.`,
    };
  }
  if (read.rawAmount > dustRaw) {
    return {
      close: false,
      kind: "partial",
      remainingRaw: read.rawAmount,
      reason:
        `${read.rawAmount} unidade(s) bruta(s) do token AINDA na carteira (tolerância declarada: ${dustRaw}). ` +
        `A posição CONTINUA aberta para vender o restante no próximo ciclo — a venda não é registrada como ` +
        `encerrada enquanto houver resíduo acima da tolerância.`,
    };
  }
  return {
    close: true,
    remainingRaw: 0,
    reason:
      read.rawAmount === 0
        ? "carteira sem o token: saída completa comprovada"
        : `resíduo ${read.rawAmount} ≤ tolerância ${dustRaw} (declarado em HFT_RESIDUAL_DUST_RAW)`,
  };
}

/* -------------------------------------------------------------------------- */
/* 4. POSIÇÃO PODE ASSINAR SAÍDA?                                              */
/* -------------------------------------------------------------------------- */

export type ManagedPositionClass = "paper" | "live" | "unverified";

export interface ManageablePositionLike {
  id?: string | null;
  mode?: string | null;
  status?: string | null;
  signature?: string | null;
  entryTxSignature?: string | null;
  entryLeg?: { signature?: string | null; measured?: boolean } | null;
}

/**
 * Classifica uma posição para GESTÃO (não para contagem de exposição — essa é outra pergunta
 * e continua conservadora em `collectRealEntryState`).
 *
 * - `paper`:  declarada paper/shadow ⇒ fecha em shadow, nunca assina.
 * - `live`:   declarada live E com evidência on-chain de entrada ⇒ pode assinar saída.
 * - `unverified`: qualquer outra coisa (sem `mode`, ou live sem evidência) ⇒ NÃO assina saída.
 */
export function classifyManagedPosition(pos: ManageablePositionLike): { kind: ManagedPositionClass; reason: string } {
  const mode = String(pos?.mode ?? "").trim().toLowerCase();
  if (mode === "paper" || mode === "shadow" || mode === "simulation") {
    return { kind: "paper", reason: `declarada "${mode}": sai em sombra, nunca on-chain` };
  }
  const evidence =
    (typeof pos?.signature === "string" && pos.signature.trim() !== "" ? pos.signature : null) ??
    (typeof pos?.entryTxSignature === "string" && pos.entryTxSignature.trim() !== "" ? pos.entryTxSignature : null) ??
    (typeof pos?.entryLeg?.signature === "string" && (pos.entryLeg!.signature as string).trim() !== ""
      ? (pos.entryLeg!.signature as string)
      : null);
  if (mode === "live") {
    if (evidence) return { kind: "live", reason: `live com evidência on-chain de entrada (${evidence.slice(0, 12)}…)` };
    return {
      kind: "unverified",
      reason:
        "declarada live SEM nenhuma evidência on-chain de entrada (assinatura), não pode assinar saída: " +
        "sem saber se a entrada existiu, uma ordem de venda é uma aposta",
    };
  }
  return {
    kind: "unverified",
    reason:
      `modo ausente/desconhecido (${JSON.stringify(pos?.mode ?? null)}): herança de scaffold. ` +
      "Conta para EXPOSIÇÃO (conservador), mas não entra no caminho que assina até haver reconciliação",
  };
}

/* -------------------------------------------------------------------------- */
/* 5. LIMITE DE PERDA DIÁRIA                                                    */
/* -------------------------------------------------------------------------- */

/** Bases de PnL em que as DUAS pernas foram medidas (ver src/outcomeLabels.ts, S11). */
export const MEASURED_PNL_BASES = Object.freeze([
  "round_trip_legs",
  "round_trip_legs_window_conflict",
  // S14: ciclo fechado por reconciliação tem as duas pernas medidas — a perda dele conta no teto.
  "round_trip_legs_reconciled",
]);

export function isMeasuredPnlBasis(basis: unknown): boolean {
  return typeof basis === "string" && (MEASURED_PNL_BASES as readonly string[]).includes(basis);
}

export interface LossTradeLike {
  id?: string | null;
  status?: string | null;
  mode?: string | null;
  /** "HH:MM:SS.mmm" — NÃO tem data; por isso não entra na soma diária. */
  time?: string | null;
  /** ISO completo, quando existir. */
  timestamp?: string | null;
  /** ISO gravado pelo S12 em toda saída real nova. */
  closedAtIso?: string | null;
  pnlNetSol?: number | null;
  pnlBasis?: string | null;
}

export interface DailyLossState {
  /** Dia UTC de referência ("YYYY-MM-DD"). */
  dayIso: string;
  /** Soma das PERDAS medidas (≥ 0). Ganho não abate perda de outro trade. */
  realizedLossSol: number;
  countedTrades: number;
  /** Trades medidos cuja janela de saldos divergiu (S11) — contados, mas sinalizados. */
  conflictedTrades: number;
  ignoredNotMeasured: number;
  ignoredGains: number;
  /** Medidos sem data legível: declarados, NÃO somados (lacuna explícita). */
  undatedMeasured: number;
  note: string;
}

export interface DailyLossLedger {
  seed(trades: LossTradeLike[], nowIso?: string): DailyLossState;
  record(input: {
    tradeId: string;
    pnlNetSol: number | null;
    pnlBasis: string | null;
    closedAtIso: string | null;
  }): DailyLossState;
  state(nowIso?: string): DailyLossState;
  exceeded(limitSol: number, nowIso?: string): boolean;
}

/** "YYYY-MM-DD" UTC de um ISO válido, ou null. Nunca inventa data para HH:MM:SS. */
export function dayIsoOf(iso: string | null | undefined): string | null {
  const s = (iso ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Livro de perda diária. Deduplica por id de trade (a mesma venda pode ser reavaliada no
 * boot), rola no dia UTC e ignora — declarando — o que não é perda medida.
 */
export function createDailyLossLedger(opts: { now?: () => Date } = {}): DailyLossLedger {
  const now = opts.now ?? (() => new Date());
  const counted = new Set<string>();
  let dayIso = dayIsoOf(now().toISOString()) ?? "1970-01-01";
  let realizedLossSol = 0;
  let countedTrades = 0;
  let conflictedTrades = 0;
  let ignoredNotMeasured = 0;
  let ignoredGains = 0;
  let undatedMeasured = 0;

  const roll = (nowIso: string): void => {
    const today = dayIsoOf(nowIso);
    if (today && today !== dayIso) {
      dayIso = today;
      realizedLossSol = 0;
      countedTrades = 0;
      conflictedTrades = 0;
      ignoredNotMeasured = 0;
      ignoredGains = 0;
      undatedMeasured = 0;
      // `counted` NÃO é limpo de propósito: um id já contado ontem não pode ser contado hoje
      // por uma reavaliação tardia do mesmo registro.
    }
  };

  const snapshot = (): DailyLossState => ({
    dayIso,
    realizedLossSol: Number(realizedLossSol.toFixed(9)),
    countedTrades,
    conflictedTrades,
    ignoredNotMeasured,
    ignoredGains,
    undatedMeasured,
    note:
      `Soma SOMENTE perdas com PnL de ciclo medido (${MEASURED_PNL_BASES.join(" | ")}) e data legível. ` +
      `Ganhos não abatem perdas (perder 1 e ganhar 1 não é "zero": é um erro e um acerto). ` +
      (undatedMeasured > 0
        ? `${undatedMeasured} trade(s) medido(s) sem data legível NÃO entraram na soma — o limite diário ` +
          `é um PISO verificado, não a prova de que nada mais foi perdido. `
        : "") +
      `${ignoredNotMeasured} trade(s) sem medição de ciclo foram ignorados (não se converte o não medido em zero).`,
  });

  const absorb = (t: LossTradeLike): void => {
    const id = typeof t.id === "string" && t.id.trim() !== "" ? `id:${t.id}` : null;
    const basis = t.pnlBasis ?? null;
    if (!isMeasuredPnlBasis(basis)) {
      ignoredNotMeasured++;
      return;
    }
    if (id && counted.has(id)) return;
    const pnl = Number(t.pnlNetSol);
    const day = dayIsoOf(t.closedAtIso) ?? dayIsoOf(t.timestamp) ?? null;
    if (day === null) {
      undatedMeasured++;
      if (id) counted.add(id);
      return;
    }
    if (day !== dayIso) {
      // Registro de outro dia: se for de hoje (fuso), conta; senão, fica de fora com motivo.
      if (day < dayIso) {
        if (id) counted.add(id);
        return;
      }
      roll(day);
    }
    if (id) counted.add(id);
    if (!Number.isFinite(pnl)) {
      ignoredNotMeasured++;
      return;
    }
    countedTrades++;
    if (basis === "round_trip_legs_window_conflict") conflictedTrades++;
    if (pnl < 0) realizedLossSol += Math.abs(pnl);
    else ignoredGains++;
  };

  return {
    seed(trades: LossTradeLike[], nowIso?: string): DailyLossState {
      roll(nowIso ?? now().toISOString());
      for (const t of trades ?? []) absorb(t);
      return snapshot();
    },
    record(input): DailyLossState {
      absorb({
        id: input.tradeId,
        pnlNetSol: input.pnlNetSol,
        pnlBasis: input.pnlBasis,
        closedAtIso: input.closedAtIso,
      });
      return snapshot();
    },
    state(nowIso?: string): DailyLossState {
      roll(nowIso ?? now().toISOString());
      return snapshot();
    },
    exceeded(limitSol: number, nowIso?: string): boolean {
      roll(nowIso ?? now().toISOString());
      return Number.isFinite(limitSol) && limitSol > 0 && realizedLossSol >= limitSol;
    },
  };
}

/**
 * Veredito do limite de perda diária, já redigido para log/painel.
 * `limitSol <= 0` = nenhum teto declarado (nunca "excedido"): a ausência de limite é
 * declarada, não silenciada — e o boot avisa em voz alta.
 */
export function dailyLossGate(
  state: DailyLossState,
  limitSol: number
): { exceeded: boolean; limitSol: number; reason: string } {
  const limit = Number.isFinite(limitSol) && limitSol > 0 ? limitSol : 0;
  if (limit === 0) {
    return { exceeded: false, limitSol: 0, reason: "sem limite diário declarado (MAX_DAILY_LOSS_SOL=0/ausente)" };
  }
  const exceeded = state.realizedLossSol >= limit;
  return {
    exceeded,
    limitSol: limit,
    reason:
      `perda medida hoje ${state.realizedLossSol.toFixed(6)} SOL vs teto ${limit} SOL` +
      (exceeded ? " — TETO ATINGIDO" : " (dentro do teto)") +
      (state.undatedMeasured > 0 ? `; ${state.undatedMeasured} trade(s) medido(s) sem data ficaram FORA da soma` : ""),
  };
}
