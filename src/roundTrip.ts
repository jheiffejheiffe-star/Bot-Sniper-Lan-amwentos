/**
 * PnL DO CICLO COMPLETO — a única aritmética que pode ser chamada de "resultado" (S11).
 *
 * ## O que faz
 *
 * Combina as DUAS pernas de uma operação (compra e venda), cada uma medida na sua própria
 * transação confirmada, e devolve o PnL LÍQUIDO do ciclo — ou `null`, quando não dá para medir.
 *
 * ## Por que este módulo existe (o defeito que ele corrige)
 *
 * O extrator anterior lia o delta de SOL da **transação de saída** e gravava esse número como
 * `pnlNetSol` com `measuredOnChain: true`. Esse delta é a **receita da venda** (crédito da venda
 * menos fee/tip da venda) — ele NÃO contém o que foi pago na entrada. Uma operação que comprou por
 * 0,01 SOL e vendeu por 0,02 SOL era reportada como "+0,02 SOL de PnL líquido medido", quando o
 * lucro do ciclo era +0,01 SOL. O erro não é de arredondamento: ele é do TAMANHO DA POSIÇÃO em
 * toda operação, e sempre para cima. Pior: como o número era marcado como medido, ele entrava na
 * validação estatística (S9) como desfecho confiável — a "estratégia validada" seria a que compra e
 * vende ao mesmo preço, porque sair devolvia a entrada inteira como lucro.
 *
 * A conta correta é a soma das duas pernas:
 *
 * ```
 * PnL do ciclo = ΔSOL(entrada) + ΔSOL(saída)      // entrada é negativa, saída positiva
 * ```
 *
 * Cada delta é lido da PRÓPRIA transação (pre/postBalances da carteira naquele tx). A soma é
 * portanto imune a transferências de SOL não relacionadas que a carteira receba no meio do caminho
 * — diferente de comparar o saldo da carteira antes e depois, que é exato apenas se a carteira
 * estiver dedicada a esta operação durante a janela.
 *
 * O RENT da conta de token entra nessa conta pela via natural: é debitado na transação de entrada
 * (criação da ATA) e devolvido na de saída, se a conta for fechada. Se sobrar conta vazia aberta, o
 * custo aparece no PnL do ciclo — que é exatamente onde ele deve aparecer.
 *
 * ## Como funciona
 *
 * 1. `parseTransactionLeg` — função PURA: recebe a resposta de `getTransaction` e devolve a
 *    economia de uma perna (ΔSOL da carteira em lamports, base fee, Δ do token, slot, erro on-chain).
 * 2. `computeRoundTrip` — função PURA: soma as pernas, detecta venda PARCIAL (comparando o Δ do
 *    token com o tamanho da posição) e, quando a janela de saldos é informada, CONFERE a soma das
 *    pernas contra a janela — divergência significa que houve outra movimentação de SOL na carteira
 *    (carteira não dedicada), e isso é declarado, não escondido.
 *
 * As duas são puras de propósito: a aritmética que decide "isto deu lucro?" é testada sem rede, sem
 * RPC e sem relógio. O wrapper de RPC (`measureLeg`, no `server.ts`) só faz a chamada e delega.
 *
 * ## Regras de honestidade (herdadas da autorização 12)
 *
 * - Sem as DUAS pernas medidas, `pnlNetSol` é `null` — nunca a receita da venda disfarçada de lucro.
 * - Medição parcial continua sendo REPORTADA (`exitProceedsSol`), com nome próprio
 *   (`basis: "exit_leg_only"`), e é EXCLUÍDA da validação estatística.
 * - Venda parcial não é venda total: o PnL é da fração vendida e a posição não está fechada.
 * - Nenhum campo é preenchido por dedução: o que não foi lido sai `null` com o motivo.
 *
 * ## Dependências
 *
 * Nenhuma além de `src/accounting.ts` (constante de lamports e a conta por janela de saldo).
 *
 * ## Riscos
 *
 * - `getTransaction` pode não retornar a transação (RPC sem histórico, nó podado) → a perna sai
 *   `measured: false` com o motivo, e o ciclo vira `incomplete`/`exit_leg_only`. Nunca "0".
 * - A janela de saldo (`walletLamportsBefore/After`) é opcional: quando informada e divergente, o
 *   PnL por perna CONTINUA válido (cada delta é da sua transação), mas a nota declara a divergência.
 * - Venda parcial em várias transações não é somada por este módulo: cada saída é um desfecho com o
 *   seu próprio ciclo até a última. A fração restante continua sendo exposição aberta.
 *
 * ## Como testar
 *
 * Grupo `[30]` de `tests/safety.test.ts`: aritmética de lucro/prejuízo/empate, perna faltante,
 * venda parcial, divergência de janela e fail-closed do rótulo.
 *
 * ## Como colocar em produção
 *
 * É o caminho padrão das saídas reais (`executeAutonomousExit` e a saída manual via Jito): a perna
 * de entrada é gravada na posição no momento da confirmação e usada na saída. Nada a configurar —
 * `HFT_PNL_WINDOW_CHECK=1` é opcional e só adiciona a conferência por janela de saldo (2 chamadas
 * `getBalance`, com custo de latência declarado no boot).
 */

import { LAMPORTS_PER_SOL, realizedFromBalances, type CostBreakdown } from "./accounting.js";

/**
 * Diferença tolerada entre a soma das pernas e a janela de saldos, em SOL (5.000 lamports).
 * Valor declarado, não mágico: cobre fee de uma transação extra e arredondamento de lamports. Acima
 * disso, houve movimentação de SOL que este ciclo não explica.
 */
export const WINDOW_CONFLICT_EPSILON_SOL = 0.000005;

/** Economia de UMA perna (uma transação confirmada). */
export interface TransactionLegEconomics {
  signature: string | null;
  /** true somente quando os saldos foram efetivamente lidos da transação. */
  measured: boolean;
  /** Δ SOL da carteira NESTA transação, em lamports (negativo na compra, positivo na venda). */
  solDeltaLamports: number | null;
  /** Saldo da carteira ANTES desta transação (lamports). Permite conferência de janela sem RPC extra. */
  preLamports: number | null;
  /** Saldo da carteira DEPOIS desta transação (lamports). */
  postLamports: number | null;
  /** Base fee da transação, em lamports (já embutida no Δ acima; separada para auditoria). */
  feeLamports: number | null;
  /** Δ do saldo do mint na carteira, em unidades mínimas (decimal, vindo do RPC). */
  tokenDeltaRaw: string | null;
  slot: number | null;
  /** Erro de execução on-chain (`meta.err`), quando a transação falhou. */
  onChainError: string | null;
  /** Motivo pelo qual a perna NÃO foi medida. */
  error: string | null;
}

/** Como o PnL do ciclo foi (ou não foi) apurado. */
export type RoundTripBasis =
  /** As duas pernas medidas: o número é o lucro/prejuízo real do ciclo. */
  | "round_trip_legs"
  /**
   * S14 — ciclo fechado por RECONCILIAÇÃO: as duas pernas foram medidas on-chain, mas a de
   * entrada só foi remedida DEPOIS (a partir da assinatura gravada). Mesma medição, procedência
   * diferente — por isso o valor próprio: relatórios podem separar o subconjunto reconciliado.
   */
  | "round_trip_legs_reconciled"
  /** As duas pernas medidas, mas a janela de saldo não fecha — houve outra movimentação de SOL. */
  | "round_trip_legs_window_conflict"
  /** Só a saída foi medida: isto é RECEITA DA VENDA, não lucro do ciclo. Excluído da validação. */
  | "exit_leg_only"
  /** Nenhuma perna utilizável. */
  | "incomplete";

export interface RoundTripInput {
  /** Perna de compra (pode ser `null` quando a entrada não foi medida/registrada). */
  entry: TransactionLegEconomics | null;
  /** Perna de venda. */
  exit: TransactionLegEconomics | null;
  /** Tamanho total da posição em unidades mínimas, para detectar venda PARCIAL. */
  positionTokensRaw?: string | null;
  /** Saldo SOL da carteira (lamports) imediatamente ANTES da entrada — opcional. */
  walletLamportsBefore?: number | null;
  /** Saldo SOL da carteira (lamports) DEPOIS da saída confirmada — opcional. */
  walletLamportsAfter?: number | null;
}

export interface RoundTripEconomics {
  /** PnL LÍQUIDO do ciclo em SOL — `null` enquanto as duas pernas não estiverem medidas. */
  pnlNetSol: number | null;
  /** O mesmo valor em lamports (inteiro), para auditoria sem ponto flutuante. */
  pnlNetLamports: number | null;
  /** Quanto saiu da carteira na entrada (valor absoluto, já com fee/tip), em SOL. */
  entryCostSol: number | null;
  /** Quanto entrou na carteira na saída (já com fee/tip descontados), em SOL. */
  exitProceedsSol: number | null;
  /** Soma das base fees das duas pernas, em SOL (informativo; já embutido no PnL). */
  feesSol: number | null;
  basis: RoundTripBasis;
  /** true SOMENTE quando as duas pernas foram medidas — o que autoriza chamar isto de "PnL". */
  measured: boolean;
  /** true quando a venda observada é menor que a posição: o ciclo NÃO está fechado. */
  partialExit: boolean;
  partialExitDetail: string | null;
  /** Divergência entre a janela de saldos e a soma das pernas, em SOL (`null` = janela não informada). */
  windowDeltaSol: number | null;
  discrepancySol: number | null;
  windowConflict: boolean | null;
  /** Fatos sobre o cálculo (método, cobertura, divergências). */
  notes: string[];
  /** Motivos pelos quais o PnL NÃO é medido. */
  reasons: string[];
}

const ZERO_COSTS: CostBreakdown = {
  jitoTipSol: 0,
  priorityFeeSol: 0,
  baseFeeSol: 0,
  ataRentSol: 0,
  ammFeeSol: 0,
  slippageCostSol: 0,
};

/** Perna não medida, com motivo. Nunca devolve zero "por padrão". */
/**
 * Conexão MÍNIMA necessária para medir uma perna (tipagem estrutural: este módulo não importa
 * `@solana/web3.js` e continua puro — quem passa a conexão é o chamador: servidor ou script).
 */
export interface LegFetchConnection {
  getTransaction(
    signature: string,
    options: { commitment: "confirmed"; maxSupportedTransactionVersion: number }
  ): Promise<any>;
}

/**
 * S14 — mede UMA perna relendo a transação da cadeia. Extraído do servidor para que o script de
 * reconciliação meça EXATAMENTE como o caminho ao vivo mede (uma única definição de "o que é
 * medir uma perna"). Fail-closed: sem conexão, sem assinatura, transação ausente ou erro do RPC
 * ⇒ `unmeasuredLeg` com o motivo — nunca número estimado.
 */
export async function measureLegWith(
  conn: LegFetchConnection | null,
  signature: string | null,
  walletBase58: string,
  mint: string
): Promise<TransactionLegEconomics> {
  if (!conn) return unmeasuredLeg(signature, "sem conexão RPC");
  if (typeof signature !== "string" || signature.trim() === "") {
    return unmeasuredLeg(signature, "assinatura ausente: não há transação a medir");
  }
  try {
    const tx = await conn.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) return unmeasuredLeg(signature, "transação não retornada pelo RPC (histórico indisponível?)");
    return parseTransactionLeg(walletBase58, mint, tx);
  } catch (err: any) {
    return unmeasuredLeg(signature, err?.message ?? String(err));
  }
}

export function unmeasuredLeg(signature: string | null, error: string): TransactionLegEconomics {
  return {
    signature,
    measured: false,
    solDeltaLamports: null,
    preLamports: null,
    postLamports: null,
    feeLamports: null,
    tokenDeltaRaw: null,
    slot: null,
    onChainError: null,
    error,
  };
}

/**
 * Extrai a economia de uma perna da resposta de `getTransaction`. PURA: nenhum RPC aqui.
 *
 * @param walletBase58 Carteira cujo saldo importa (a operacional).
 * @param mint         Mint da posição, para calcular o Δ de tokens.
 * @param tx           Objeto de `getTransaction` (tipagem estrutural, tolerante a `null`).
 */
export function parseTransactionLeg(walletBase58: string, mint: string, tx: any): TransactionLegEconomics {
  if (!tx || !tx.meta) {
    return unmeasuredLeg(tx?.transaction?.signatures?.[0] ?? null, "transação sem meta (o RPC não devolveu saldos)");
  }
  const meta = tx.meta;
  const signature: string | null = tx.transaction?.signatures?.[0] ?? null;
  const slot: number | null = typeof tx.slot === "number" ? tx.slot : null;
  const onChainError: string | null = meta.err ? JSON.stringify(meta.err) : null;

  // ---- Índice da carteira nas chaves da mensagem -------------------------------------------
  let index = -1;
  const message: any = tx.transaction?.message;
  if (message && typeof message.getAccountKeys === "function") {
    const keys = message.getAccountKeys({ accountKeysFromLookups: meta.loadedAddresses });
    for (let i = 0; i < keys.length; i++) {
      if (keys.get(i)?.toBase58?.() === walletBase58) {
        index = i;
        break;
      }
    }
  } else if (message && Array.isArray(message.staticAccountKeys)) {
    index = message.staticAccountKeys.findIndex((k: any) => (k?.toBase58?.() ?? String(k)) === walletBase58);
  } else if (Array.isArray(message?.accountKeys)) {
    // Legado (MessageAccountKeys como array de PublicKey).
    index = message.accountKeys.findIndex((k: any) => (k?.toBase58?.() ?? String(k)) === walletBase58);
  }

  if (index < 0) {
    return unmeasuredLeg(signature, "carteira não localizada entre as contas da transação");
  }
  if (!Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances)) {
    return unmeasuredLeg(signature, "transação sem preBalances/postBalances");
  }

  const pre = meta.preBalances[index];
  const post = meta.postBalances[index];
  if (typeof pre !== "number" || typeof post !== "number") {
    return unmeasuredLeg(signature, "saldos da carteira ausentes nesta transação");
  }

  // ---- Δ do token ----------------------------------------------------------------------------
  /**
   * Soma apenas as entradas de saldo do MINT cujo `owner` é a carteira. Entradas sem `owner` são
   * ignoradas de propósito: atribuí-las seria adivinhar de quem é o saldo e poderia contar a
   * posição de outra pessoa como se fosse a nossa.
   */
  let tokenDeltaRaw: string | null = null;
  const somarTokens = (lista: any[], sinal: 1n | -1n): bigint => {
    let total = 0n;
    if (!Array.isArray(lista)) return total;
    for (const b of lista) {
      if (!b || b.mint !== mint) continue;
      if (b.owner !== walletBase58) continue;
      const bruto = b.uiTokenAmount?.amount;
      if (typeof bruto !== "string" || bruto === "") continue;
      try {
        total += sinal * BigInt(bruto);
      } catch {
        // Amount não numérico: ignorado (não é motivo para inventar valor).
      }
    }
    return total;
  };
  const deltaTokens = somarTokens(meta.postTokenBalances ?? [], 1n) + somarTokens(meta.preTokenBalances ?? [], -1n);
  const temListaDeTokens = Array.isArray(meta.preTokenBalances) || Array.isArray(meta.postTokenBalances);
  if (temListaDeTokens) tokenDeltaRaw = deltaTokens.toString();

  return {
    signature,
    measured: true,
    solDeltaLamports: post - pre,
    preLamports: pre,
    postLamports: post,
    feeLamports: typeof meta.fee === "number" ? meta.fee : null,
    tokenDeltaRaw,
    slot,
    onChainError,
    error: null,
  };
}

/**
 * Combina as pernas e devolve o PnL do ciclo — ou a razão explícita de não haver número.
 *
 * A ordem de decisão importa: só somamos as pernas quando AMBAS estão medidas. Somar "saída menos
 * zero" (entrada ausente) é exatamente o defeito que este módulo existe para impedir.
 */
export function computeRoundTrip(input: RoundTripInput): RoundTripEconomics {
  const notes: string[] = [];
  const reasons: string[] = [];
  const entry = input.entry ?? null;
  const exit = input.exit ?? null;

  const entradaMedida = !!entry && entry.measured && entry.solDeltaLamports !== null;
  const saidaMedida = !!exit && exit.measured && exit.solDeltaLamports !== null;

  if (!entradaMedida) {
    reasons.push(
      entry === null
        ? "perna de ENTRADA ausente: a posição não guarda a economia da compra (medida antes desta versão ou entrada fora do bot)"
        : `perna de ENTRADA não medida: ${entry.error ?? "motivo não informado"}`
    );
  }
  if (!saidaMedida) {
    reasons.push(
      exit === null ? "perna de SAÍDA ausente" : `perna de SAÍDA não medida: ${exit.error ?? "motivo não informado"}`
    );
  }

  const entryCostSol = entradaMedida ? Math.abs((entry!.solDeltaLamports as number) / LAMPORTS_PER_SOL) : null;
  const exitProceedsSol = saidaMedida ? (exit!.solDeltaLamports as number) / LAMPORTS_PER_SOL : null;

  // ---- Venda parcial ---------------------------------------------------------------------------
  let partialExit = false;
  let partialExitDetail: string | null = null;
  if (saidaMedida && exit!.tokenDeltaRaw !== null && input.positionTokensRaw) {
    try {
      const vendido = -BigInt(exit!.tokenDeltaRaw);
      const posicao = BigInt(input.positionTokensRaw);
      if (posicao > 0n && vendido > 0n && vendido < posicao) {
        partialExit = true;
        const pct = Number((vendido * 10_000n) / posicao) / 100;
        partialExitDetail =
          `venda PARCIAL: ${vendido.toString()} de ${posicao.toString()} unidades (${pct.toFixed(2)}%). ` +
          `O PnL abaixo é apenas da fração vendida; a posição NÃO está fechada.`;
        notes.push(partialExitDetail);
      } else if (posicao > 0n && vendido > posicao) {
        notes.push(
          `a venda devolveu MAIS tokens do que a posição registrava (${vendido.toString()} > ${posicao.toString()}): ` +
            `pode haver tokens do mesmo mint fora desta posição — investigar antes de confiar no PnL.`
        );
      }
    } catch {
      notes.push("não foi possível comparar o Δ de tokens com o tamanho da posição (valor não numérico).");
    }
  }

  // ---- Soma das pernas -------------------------------------------------------------------------
  if (!entradaMedida || !saidaMedida) {
    const basis: RoundTripBasis = saidaMedida ? "exit_leg_only" : "incomplete";
    if (saidaMedida) {
      notes.push(
        `medido apenas na SAÍDA: ${exitProceedsSol!.toFixed(9)} SOL entraram na carteira nesta transação. ` +
          `Isto é RECEITA DA VENDA, não lucro: o custo da entrada não está incluído. Por isso NÃO é ` +
          `chamado de PnL e NÃO entra na validação estatística.`
      );
      notes.push(
        "como fechar o laço: registre a economia da entrada na posição (`entryLeg`) no momento da " +
          "confirmação — a partir daí todo ciclo passa a ter as duas pernas."
      );
    }
    return {
      pnlNetSol: null,
      pnlNetLamports: null,
      entryCostSol,
      exitProceedsSol,
      feesSol: somaFees(entry, exit),
      basis,
      measured: false,
      partialExit,
      partialExitDetail,
      windowDeltaSol: null,
      discrepancySol: null,
      windowConflict: null,
      notes,
      reasons,
    };
  }

  const pnlNetLamports = (entry!.solDeltaLamports as number) + (exit!.solDeltaLamports as number);
  const pnlNetSol = pnlNetLamports / LAMPORTS_PER_SOL;

  notes.push(
    `PnL = ΔSOL(entrada) + ΔSOL(saída) = ${formatSol(entry!.solDeltaLamports as number)} + ` +
      `${formatSol(exit!.solDeltaLamports as number)} = ${pnlNetSol >= 0 ? "+" : ""}${pnlNetSol.toFixed(9)} SOL. ` +
      `Cada delta vem da PRÓPRIA transação (pre/postBalances), então a soma é imune a movimentações ` +
      `de SOL não relacionadas à operação.`
  );
  const fees = somaFees(entry, exit);
  if (fees !== null) {
    notes.push(
      `base fees somadas das duas transações: ${fees.toFixed(9)} SOL (já embutidas no PnL, que é líquido).`
    );
    notes.push(
      "LIMITE DA DECOMPOSIÇÃO: tip (Jito) e priority fee NÃO são separáveis do delta de saldo — eles " +
        "aparecem como transferência/instrução, não como `meta.fee`. O PnL está correto (o delta os " +
        "inclui), mas a soma de `feesSol` cobre apenas a base fee das transações."
    );
  }
  if (entry!.onChainError) {
    notes.push(`a transação de ENTRADA falhou on-chain (${entry!.onChainError}): o Δ medido é o custo do fracasso, não uma compra.`);
  }
  if (exit!.onChainError) {
    notes.push(`a transação de SAÍDA falhou on-chain (${exit!.onChainError}): o Δ medido é o custo do fracasso, não uma venda.`);
  }

  // ---- Conferência pela janela de saldos ---------------------------------------------------------
  let windowDeltaSol: number | null = null;
  let discrepancySol: number | null = null;
  let windowConflict: boolean | null = null;
  /**
   * CONFERÊNCIA POR JANELA SEM RPC EXTRA. Se as duas pernas têm saldos absolutos, a diferença entre
   * elas já responde "houve movimentação de SOL fora deste ciclo?":
   *
   *   janela  = post(saída) − pre(entrada)      // variação total da carteira no ciclo
   *   pernas  = Δ(entrada) + Δ(saída)           // o que as duas transações explicam
   *   resto   = janela − pernas = pre(saída) − post(entrada)
   *
   * `resto ≠ 0` significa que, ENTRE a confirmação da compra e a venda, a carteira variou por outra
   * transação (outra posição, transferência, fee avulsa). O PnL do ciclo continua exato — cada delta
   * é da sua transação —, mas o operador precisa saber que a carteira não estava dedicada.
   */
  const temJanelaDerivada =
    typeof entry!.preLamports === "number" &&
    typeof entry!.postLamports === "number" &&
    typeof exit!.preLamports === "number" &&
    typeof exit!.postLamports === "number";
  const temJanela =
    typeof input.walletLamportsBefore === "number" &&
    typeof input.walletLamportsAfter === "number" &&
    Number.isFinite(input.walletLamportsBefore) &&
    Number.isFinite(input.walletLamportsAfter);
  if (!temJanela && temJanelaDerivada) {
    const janelaLamports = (exit!.postLamports as number) - (entry!.preLamports as number);
    const pernasLamports = (entry!.solDeltaLamports as number) + (exit!.solDeltaLamports as number);
    windowDeltaSol = janelaLamports / LAMPORTS_PER_SOL;
    discrepancySol = (janelaLamports - pernasLamports) / LAMPORTS_PER_SOL;
    windowConflict = Math.abs(discrepancySol) > WINDOW_CONFLICT_EPSILON_SOL;
    if (windowConflict) {
      notes.push(
        `DIVERGÊNCIA DE JANELA (calculada sem RPC extra, dos saldos das próprias transações): entre a ` +
          `confirmação da entrada e a venda, a carteira variou ${discrepancySol.toFixed(9)} SOL por fora ` +
          `deste ciclo — houve OUTRA movimentação de SOL na carteira (outra posição, transferência ou fee avulsa). ` +
          `O PnL do ciclo segue exato (cada delta é da sua transação), mas a carteira NÃO estava dedicada a ele.`
      );
    } else {
      notes.push(
        `janela confere: nenhuma variação de SOL fora das duas transações (diferença de ` +
          `${(discrepancySol ?? 0).toFixed(9)} SOL, tolerância declarada de ${WINDOW_CONFLICT_EPSILON_SOL} SOL).`
      );
    }
  }
  if (temJanela) {
    // Reusa a conta por janela de saldos já existente (`realizedFromBalances`): aqui só interessa o
    // delta; os custos por componente não são usados porque cada perna já traz a sua própria fee.
    const janela = realizedFromBalances(
      (input.walletLamportsBefore as number) / LAMPORTS_PER_SOL,
      (input.walletLamportsAfter as number) / LAMPORTS_PER_SOL,
      0,
      ZERO_COSTS
    );
    windowDeltaSol = janela.pnlNetSol;
    discrepancySol = windowDeltaSol - pnlNetSol;
    windowConflict = Math.abs(discrepancySol) > WINDOW_CONFLICT_EPSILON_SOL;
    if (windowConflict) {
      notes.push(
        `DIVERGÊNCIA DE JANELA: o saldo da carteira variou ${windowDeltaSol.toFixed(9)} SOL da entrada até a ` +
          `saída, mas as duas pernas somam ${pnlNetSol.toFixed(9)} SOL (diferença de ${discrepancySol.toFixed(9)} SOL). ` +
          `Houve OUTRA movimentação de SOL na carteira nessa janela — o PnL por perna continua exato para ` +
          `este ciclo, mas a carteira NÃO estava dedicada a ele.`
      );
    } else {
      notes.push(
        `janela de saldo confere com a soma das pernas (diferença de ${(discrepancySol ?? 0).toFixed(9)} SOL, ` +
          `dentro da tolerância declarada de ${WINDOW_CONFLICT_EPSILON_SOL} SOL).`
      );
    }
  }

  return {
    pnlNetSol,
    pnlNetLamports,
    entryCostSol,
    exitProceedsSol,
    feesSol: fees,
    basis: windowConflict ? "round_trip_legs_window_conflict" : "round_trip_legs",
    measured: true,
    partialExit,
    partialExitDetail,
    windowDeltaSol,
    discrepancySol,
    windowConflict,
    notes,
    reasons,
  };
}

/** Soma de base fees das pernas disponíveis (`null` quando nenhuma informou). */
function somaFees(entry: TransactionLegEconomics | null, exit: TransactionLegEconomics | null): number | null {
  const valores = [entry?.feeLamports, exit?.feeLamports].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v)
  );
  if (valores.length === 0) return null;
  return valores.reduce((acc, v) => acc + v, 0) / LAMPORTS_PER_SOL;
}

/** Formata lamports com sinal, para as notas (auditoria legível). */
function formatSol(lamports: number): string {
  const sol = lamports / LAMPORTS_PER_SOL;
  return `${sol >= 0 ? "+" : ""}${sol.toFixed(9)}`;
}
