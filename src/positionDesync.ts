/**
 * RECONCILIADOR DE POSIÇÃO × CADEIA (`POSITION_DESYNC`).
 *
 * ## Por que isto existe
 *
 * Toda a gestão de risco do bot parte de uma premissa não verificada: "o que o banco
 * diz sobre a posição corresponde ao que existe na carteira". Se essa premissa é
 * falsa, o bot gerencia uma ficção em dois sentidos, e os dois custam dinheiro:
 *
 *   - **Posição fantasma**: o banco diz `open` e a carteira NÃO tem o token. O bot
 *     calcula stop/alvo de algo que não existe e, quando o gatilho dispara, tenta
 *     VENDER ZERO (live) — gerando falha de saída, circuit breaker e ruído que esconde
 *     as falhas reais. É o resíduo típico de histórico fabricado.
 *   - **Exposição não rastreada**: a carteira TEM o token e o bot não a considera
 *     posição (nunca aberta, ou já dada como fechada). Não há stop, não há alvo, não
 *     há gestão: o ativo fica solto, sem ninguém olhando.
 *
 * ## Como funciona
 *
 * Funções puras: recebe o estado local (posições + mints que o bot acredita ter
 * encerrado) e um SNAPSHOT de saldos (`holdings`) e devolve achados com veredito,
 * severidade, evidência e ação recomendada. Nenhuma escrita, nenhuma rede.
 *
 * O snapshot de saldos vem de UMA chamada (`getParsedTokenAccountsByOwner`), o que é
 * importante: sem saldo de todas as contas, teríamos que consultar cada mint — lento e
 * mais caro em RPC por ciclo.
 *
 * ## Regras de honestidade (o que NÃO é reportado como desvio)
 *
 * 1. **Falha de leitura ≠ desvio.** `holdings: null` produz vereditos `unknown`. Nunca
 *    `phantom_position`. "Não consegui ver a carteira" não é "a carteira está vazia".
 * 2. **Posição nova não é fantasma.** Dentro da janela de tolerância (`minAgeMs`), a
 *    entrada pode ainda não ter confirmado. Um falso positivo aqui levaria o operador a
 *    "corrigir" uma posição saudável.
 * 3. **Posição paper/sombra nunca é comparada.** Ela não tem (nem deveria ter) token
 *    on-chain: cobrar correspondência de uma simulação é erro de categoria.
 * 4. **Exposição não rastreada só é reportada para mints que o BOT tocou.** A carteira
 *    pode conter tokens do operador, sem relação com o robô. Alertar sobre eles seria
 *    ruído — e ruído em alerta de risco é o que faz alerta ser ignorado.
 *
 * ## Limites declarados
 *
 * - `holdings` é um RETRATO: a cadeia pode mudar no instante seguinte. Isto é
 *   reconciliação de estado, não prova de liquidação. Não substitui confirmação de
 *   transação (ver `src/jitoStatus.ts`).
 * - Tolerância de saldo (`dustToleranceRaw`) existe porque taxas de transferência de
 *   Token-2022 podem reter valor: um resto pequeno não deve ser lido como "ainda tenho
 *   a posição inteira".
 * - Esta camada MARCA e reporta; ela não fecha, não apaga e não quarentena nada. A
 *   decisão de mexer no banco continua sendo do operador (mesmo princípio do S0).
 *
 * ## Como testar
 *
 * `npm run test` (grupo [14]): fantasma, exposição não rastreada, falha de leitura,
 * janela de tolerância, posição paper, poeira e histerese de confirmação dupla.
 */

import { isValidPubkey } from "./solanaConfig.js";

export type DesyncVerdict =
  | "in_sync"
  | "phantom_position"
  | "untracked_exposure"
  | "closed_but_holding"
  | "too_young"
  | "unknown";

export type DesyncSeverity = "none" | "info" | "warning" | "critical";

export interface PositionLike {
  id?: string;
  mint?: string | null;
  token?: string;
  sizeSol?: number | null;
  status?: string | null;
  mode?: string | null;
  timeOpened?: string | null;
  /** true quando o operador já aceitou/deixou de gerir a posição. */
  quarantined?: boolean;
  [key: string]: unknown;
}

/** Saldo on-chain de um mint, como lido da carteira. */
export interface Holding {
  mint: string;
  /** Quantidade em unidades base (inteiro, já com decimais aplicados no valor bruto). */
  rawAmount: number;
  decimals: number;
  /** Conta de token que detém o saldo (evidência para o operador). */
  tokenAccount?: string;
}

export interface DesyncFinding {
  verdict: DesyncVerdict;
  severity: DesyncSeverity;
  positionId: string | null;
  mint: string | null;
  token: string | null;
  /** Fato observado (não interpretação). */
  evidence: string;
  /** Interpretação/hi pótese, separada da evidência. */
  interpretation: string;
  /** Ação recomendada ao operador (nunca executada por este módulo). */
  recommendedAction: string;
}

export interface DesyncInput {
  /** Posições geridas localmente (todas; o filtro de modo é feito aqui dentro). */
  positions: readonly PositionLike[];
  /**
   * Mints que o bot acredita ter ENCERRADO (saídas confirmadas). Serve para detectar
   * "achei que vendi, ainda tenho token". Só mints que o bot operou entram aqui.
   */
  closedMints?: readonly { mint: string; token?: string; closedAt?: string | null }[];
  /** Snapshot de saldos. `null` = leitura falhou (não é "carteira vazia"). */
  holdings: readonly Holding[] | null;
  nowMs: number;
  options?: {
    /**
     * Idade mínima da posição para ser candidata a fantasma (default 120s). Entrada
     * recém-disparada pode não ter confirmado ainda.
     */
    minAgeMs?: number;
    /**
     * Saldo residual tolerado (unidades base) para não tratar poeira como posição
     * existente (default 1 unidade base).
     */
    dustToleranceRaw?: number;
  };
}

export interface DesyncReport {
  findings: DesyncFinding[];
  summary: {
    checkedPositions: number;
    skipped: number;
    phantom: number;
    untrackedExposure: number;
    closedButHolding: number;
    unknown: number;
    critical: number;
  };
  /** De onde veio o snapshot: a leitura foi possível? */
  snapshotAvailable: boolean;
  /** Motivo legível quando o snapshot não está disponível. */
  snapshotNote: string | null;
}

const DEFAULTS = { minAgeMs: 120_000, dustToleranceRaw: 1 };

function ageMs(position: PositionLike, nowMs: number): number | null {
  const t = position.timeOpened ? Date.parse(position.timeOpened) : Number.NaN;
  if (Number.isNaN(t)) return null;
  return nowMs - t;
}

function isManagedLive(position: PositionLike): boolean {
  if (position.status === "quarantined") return false;
  if (position.quarantined === true) return false;
  // Paper/sombra: simulação por definição, não tem token on-chain. Comparar seria erro.
  return position.mode !== "paper";
}

/**
 * Reconcilia estado local × cadeia. Retorna TODOS os achados (inclusive `in_sync`
 * e `unknown`), porque a ausência de achado também precisa ser auditável.
 */
export function reconcilePositionDesync(input: DesyncInput): DesyncReport {
  const minAgeMs = input.options?.minAgeMs ?? DEFAULTS.minAgeMs;
  const dust = input.options?.dustToleranceRaw ?? DEFAULTS.dustToleranceRaw;
  const findings: DesyncFinding[] = [];
  const summary = {
    checkedPositions: 0,
    skipped: 0,
    phantom: 0,
    untrackedExposure: 0,
    closedButHolding: 0,
    unknown: 0,
    critical: 0,
  };

  const snapshotAvailable = input.holdings !== null;
  const byMint = new Map<string, Holding>();
  if (input.holdings) {
    for (const h of input.holdings) {
      if (!h || typeof h.mint !== "string") continue;
      if (!Number.isFinite(h.rawAmount)) continue;
      const current = byMint.get(h.mint);
      if (!current || h.rawAmount > current.rawAmount) byMint.set(h.mint, h);
    }
  }

  if (!snapshotAvailable) {
    findings.push({
      verdict: "unknown",
      severity: "warning",
      positionId: null,
      mint: null,
      token: null,
      evidence: "Não foi possível ler as contas de token da carteira (snapshot indisponível).",
      interpretation:
        "Sem leitura não existe reconciliação. \"Não consegui ver\" NÃO significa \"a carteira está vazia\".",
      recommendedAction:
        "Nenhuma ação sobre posições. Verifique conectividade/RPC e aguarde o próximo ciclo.",
    });
  }

  for (const pos of input.positions) {
    if (!isManagedLive(pos)) {
      summary.skipped++;
      continue;
    }
    if (!pos.mint || !isValidPubkey(pos.mint)) {
      summary.skipped++;
      continue;
    }

    const id = pos.id ?? null;
    const token = pos.token ?? null;
    summary.checkedPositions++;

    if (!snapshotAvailable) {
      summary.unknown++;
      findings.push({
        verdict: "unknown",
        severity: "warning",
        positionId: id,
        mint: pos.mint,
        token,
        evidence: `Posição ${id ?? "(sem id)"} declarada localmente; saldo on-chain não pôde ser lido.`,
        interpretation: "Estado local e cadeia NÃO foram comparados neste ciclo.",
        recommendedAction: "Reexecutar a reconciliação quando houver leitura de carteira.",
      });
      continue;
    }

    const held = byMint.get(pos.mint) ?? null;
    const heldRaw = held?.rawAmount ?? 0;
    const age = ageMs(pos, input.nowMs);

    if (heldRaw > dust) {
      findings.push({
        verdict: "in_sync",
        severity: "info",
        positionId: id,
        mint: pos.mint,
        token,
        evidence: `Carteira detém ${heldRaw} unidades base de ${pos.mint.slice(0, 8)}... (decimais ${held?.decimals ?? "?"}).`,
        interpretation: "Posição local corresponde a saldo existente na carteira.",
        recommendedAction: "Nenhuma.",
      });
      continue;
    }

    // Saldo zero (ou poeira) com posição local aberta.
    if (age !== null && age < minAgeMs) {
      findings.push({
        verdict: "too_young",
        severity: "info",
        positionId: id,
        mint: pos.mint,
        token,
        evidence: `Posição aberta há ${Math.round(age / 1000)}s (< tolerância de ${Math.round(minAgeMs / 1000)}s) e sem saldo na carteira.`,
        interpretation:
          "A entrada pode ainda não ter confirmado. Fantasma NÃO pode ser concluído dentro da janela de tolerância.",
        recommendedAction: "Aguardar o próximo ciclo antes de agir.",
      });
      continue;
    }

    summary.phantom++;
    summary.critical++;
    findings.push({
      verdict: "phantom_position",
      severity: "critical",
      positionId: id,
      mint: pos.mint,
      token,
      evidence:
        `Posição ${id ?? "(sem id)"} está aberta localmente (${pos.sizeSol ?? "?"} SOL) há ` +
        `${age === null ? "tempo desconhecido" : `${Math.round(age / 1000)}s`} e a carteira tem ` +
        `${heldRaw} unidades base do mint${heldRaw === 0 ? " (nenhuma)" : " (apenas poeira)"}.`,
      interpretation:
        "Hipótese: posição fantasma (entrada nunca executada / resíduo de histórico fabricado). " +
        "O bot gerencia risco de um ativo que não possui.",
      recommendedAction:
        "Confirmar no explorador que a carteira não detém o mint e, se confirmado, quarentenar/pausar " +
        "esta posição. NÃO vender: não há o que vender.",
    });
  }

  // Exposição não rastreada: mints que o bot tocou e que não estão em posição gerida.
  if (snapshotAvailable && input.holdings) {
    const managedMints = new Set(
      input.positions.filter((p) => isManagedLive(p) && p.mint).map((p) => p.mint as string)
    );
    const closedMints = new Map<string, { token?: string; closedAt?: string | null }>();
    for (const c of input.closedMints ?? []) {
      if (c && typeof c.mint === "string") closedMints.set(c.mint, { token: c.token, closedAt: c.closedAt });
    }

    for (const held of byMint.values()) {
      if (held.rawAmount <= dust) continue;
      if (managedMints.has(held.mint)) continue;

      const wasClosed = closedMints.get(held.mint);
      if (!wasClosed) {
        // Mint que o bot nunca operou (carteira do operador): fora do escopo, por decisão.
        continue;
      }

      summary.closedButHolding++;
      summary.critical++;
      findings.push({
        verdict: "closed_but_holding",
        severity: "critical",
        positionId: null,
        mint: held.mint,
        token: wasClosed.token ?? null,
        evidence:
          `O bot considera ${wasClosed.token ?? held.mint.slice(0, 8)} ENCERRADO` +
          `${wasClosed.closedAt ? ` (${wasClosed.closedAt})` : ""} e a carteira ainda detém ` +
          `${held.rawAmount} unidades base.`,
        interpretation:
          "Hipótese: a venda encerrou apenas parcialmente, ou o saldo voltou/ficou na carteira. O bot está " +
          "exposto a um ativo sem stop e sem alvo — o modo de falha mais caro em gestão de saída.",
        recommendedAction:
          "Verificar a assinatura da venda no explorador (valor recebido e saldo restante) e decidir a " +
          "liquidação manual do restante. Não confie no estado local.",
      });
    }
  }

  return {
    findings,
    summary,
    snapshotAvailable,
    snapshotNote: snapshotAvailable
      ? null
      : "Leitura das contas de token indisponível: nenhum veredito de desvio foi emitido.",
  };
}

/** Resumo de uma linha para log — sem inventar número quando não houve leitura. */
export function describeDesyncReport(report: DesyncReport): string {
  if (!report.snapshotAvailable) {
    return `Reconciliação sem snapshot de carteira: ${report.summary.checkedPositions} posição(ões) não comparadas.`;
  }
  return (
    `Reconciliação: ${report.summary.checkedPositions} posição(ões) comparadas; ` +
    `fantasma=${report.summary.phantom}; exposição não rastreada=${report.summary.closedButHolding}; ` +
    `desconhecido=${report.summary.unknown}; puladas=${report.summary.skipped}.`
  );
}
