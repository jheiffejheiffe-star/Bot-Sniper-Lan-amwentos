/**
 * CAMINHO QUENTE — as três decisões que separam LATÊNCIA de DESLEIXO.
 *
 * ## O que faz
 *
 * Reúne, em funções puras e testáveis, as decisões que hoje estão espalhadas pelo
 * caminho crítico (notificação → decisão):
 *
 *   1. **`SeenLaunchSignatures`** — deduplicação por assinatura. Um WebSocket que
 *      reconecta pode reentregar a mesma notificação; sem dedupe, a MESMA criação de
 *      pool entra duas vezes no pipeline (duas decisões, dois conjuntos de RPC, e — em
 *      modo real — duas compras do mesmo ativo).
 *   2. **`resolveSendOptions`** — defaults de ENVIO explícitos e justificados. Os
 *      defaults do SDK (`maxRetries: 3`, `skipPreflight: false`) servem para uso geral;
 *      num caminho de corrida eles duplicam a política de retry (que em S4 é por
 *      EVIDÊNCIA, com idempotência) e pagam um RTT de preflight.
 *   3. **`decideEntryWithBudget`** — política de orçamento entre GATE RÁPIDO e FILTRO
 *      PROFUNDO. O filtro profundo (RPC de holders/supply + auditoria externa) é o que
 *      impede entrar em rug; ele não pode simplesmente ser cortado por latência. Mas ele
 *      também não pode ser exigido em PAPER/SHADOW, onde nada é comprado — ali o correto
 *      é PROSSEGUIR e MEDIR quanto o filtro custou, para calibrar depois.
 *
 * ## Regra que não muda com modo
 *
 * Em `LIVE`, filtro profundo incompleto **veta** a entrada. Não existe "entrei sem
 * auditar para chegar primeiro": correr esse risco é como se perde a carteira inteira em
 * um honeypot. Latência se compra com infraestrutura; segurança não se compra de volta.
 *
 * ## Riscos e limites
 *
 * - O dedupe é por assinatura e com TTL: se a mesma assinatura reaparecer depois do TTL
 *   (improvável: a assinatura é única por transação), ela será reprocessada.
 * - `resolveSendOptions` NÃO decide política de negócio: ele apenas não deixa o default
 *   do SDK decidir por você. `preSimulated` é declaração do CHAMADOR de que a transação
 *   já foi simulada — não é verificação.
 * - O orçamento do filtro profundo é por SINAL, não global. Um orçamento global
 *   esconderia o caso patológico (um sinal que consome 5s) atrás de uma média.
 *
 * ## Como testar
 *
 * `npm run test` (grupo [16]): dedupe com TTL, defaults de envio e a matriz de decisão
 * do orçamento (incluindo a regra crítica: LIVE + incompleto = veta).
 *
 * ## Como colocar em produção
 *
 * `HFT_DEEP_FILTER_BUDGET_MS` (default 900) define o orçamento. Ao subir para LIVE,
 * comece com o valor medido em PAPER para o p95 do filtro profundo — e só reduza com
 * dados de quantos sinais ficariam sem auditoria.
 */

/** Assinaturas já processadas, com expiração — evita reentrega do mesmo evento. */
export class SeenLaunchSignatures {
  private seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = 120_000,
    private readonly maxEntries: number = 5_000
  ) {}

  /**
   * Registra a assinatura. Retorna `true` na PRIMEIRA vez (deve processar) e `false`
   * quando já foi vista dentro do TTL (deve ignorar).
   */
  firstSight(signature: string, nowMs: number = Date.now()): boolean {
    this.prune(nowMs);
    if (this.seen.has(signature)) return false;
    if (this.seen.size >= this.maxEntries) {
      // Limite atingido: removemos a entrada mais antiga (ordem de inserção do Map).
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    this.seen.set(signature, nowMs);
    return true;
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.ttlMs;
    for (const [sig, at] of this.seen) {
      if (at >= cutoff) break; // Map preserva ordem de inserção: o resto é mais novo
      this.seen.delete(sig);
    }
  }

  /** Tamanho atual (após poda) — usado em teste e diagnóstico. */
  size(nowMs: number = Date.now()): number {
    this.prune(nowMs);
    return this.seen.size;
  }
}

/**
 * Mints em processamento. Impede que dois sinais do MESMO mint corram em paralelo — o
 * que em modo real significa duas compras para uma decisão.
 */
export class InFlightMints {
  private inFlight = new Set<string>();

  /** Marca o mint como em processamento. `false` = já havia um em andamento. */
  tryAcquire(mint: string): boolean {
    if (this.inFlight.has(mint)) return false;
    this.inFlight.add(mint);
    return true;
  }

  release(mint: string): void {
    this.inFlight.delete(mint);
  }

  has(mint: string): boolean {
    return this.inFlight.has(mint);
  }

  size(): number {
    return this.inFlight.size;
  }
}

export interface SendOptionsInput {
  /** Declaração do chamador: a transação JÁ foi simulada (preflight seria redundante). */
  preSimulated?: boolean;
  /** Força preflight mesmo com `preSimulated` (usado em diagnóstico/devnet). */
  forcePreflight?: boolean;
  /** Overrides explícitos, quando houver razão medida. */
  skipPreflight?: boolean;
  maxRetries?: number;
  preflightCommitment?: "processed" | "confirmed" | "finalized";
}

export interface ResolvedSendOptions {
  skipPreflight: boolean;
  maxRetries: number;
  preflightCommitment: "processed" | "confirmed" | "finalized";
  /** Por que estes valores foram escolhidos — vai para o log, não fica implícito. */
  rationale: string;
}

/**
 * Defaults de envio para o caminho de trading.
 *
 * - `maxRetries: 0` — o RPC NÃO repete às cegas. Quem repete é a política de evidência
 *   (S4): reenviar os mesmos bytes é idempotente; repetir no RPC, não é observável nem
 *   interrompível, e pode continuar depois do blockhash expirar.
 * - `skipPreflight` — verdadeiro SOMENTE quando o chamador declara que já simulou
 *   (`preSimulated`). Pular preflight sem ter simulado joga fora a informação de erro
 *   mais barata que existe (C41).
 */
export function resolveSendOptions(input: SendOptionsInput = {}): ResolvedSendOptions {
  const skipPreflight =
    typeof input.skipPreflight === "boolean"
      ? input.skipPreflight
      : Boolean(input.preSimulated) && !input.forcePreflight;

  const maxRetries = Number.isFinite(input.maxRetries as number)
    ? Math.max(0, Math.floor(input.maxRetries as number))
    : 0;

  const rationale = skipPreflight
    ? `preflight pulado porque a transação foi simulada por este processo (maxRetries=${maxRetries}: retry é da política de evidência, não do RPC)`
    : `preflight ativo (nenhuma simulação declarada) com maxRetries=${maxRetries}: erro de simulação é a evidência mais barata disponível`;

  return {
    skipPreflight,
    maxRetries,
    preflightCommitment: input.preflightCommitment ?? "processed",
    rationale,
  };
}

export type EntryMode = "PAPER" | "SHADOW" | "LIVE" | "SIMULATION" | string;

export interface EntryBudgetInput {
  mode: EntryMode;
  /** O filtro profundo terminou dentro do orçamento? */
  deepComplete: boolean;
  /** Tempo gasto no filtro profundo (ms) — medido. */
  deepElapsedMs: number | null;
  budgetMs: number;
  /** Veredito do filtro profundo quando ele terminou. */
  deepVerdict?: "approve" | "reject" | null;
  /**
   * POR QUE o filtro está incompleto — os dois casos NÃO são equivalentes:
   *   - `budget`: o filtro ainda está rodando e o orçamento estourou (há dados parciais);
   *     em LIVE veta; fora de LIVE prossegue marcado, para medir o custo.
   *   - `audit-error`: o filtro FALHOU (RPC recusou, timeout de rede, erro de parsing):
   *     não existe dado nenhum sobre o token. Prosseguir aqui não é "entrar sem auditar",
   *     é entrar sem saber o que se está comprando. Veta em QUALQUER modo.
   */
  incompleteCause?: "budget" | "audit-error";
}

export interface EntryBudgetDecision {
  /** Prosseguir para a etapa seguinte (cotação/shadow)? */
  proceed: boolean;
  /** Motivo, sempre preenchido — a decisão não fica implícita. */
  reason: string;
  /** true quando prosseguiu SEM filtro profundo completo (precisa aparecer no registro). */
  unvetted: boolean;
}

/**
 * Decide se o sinal segue para entrada, considerando o orçamento do filtro profundo.
 *
 * Matriz (por modo):
 *   - filtro completo + approve → prossegue (vetted)
 *   - filtro completo + reject  → NÃO prossegue (nem em PAPER: o registro é o dado)
 *   - filtro incompleto + LIVE  → NÃO prossegue (fail-closed: sem auditoria não se compra)
 *   - filtro incompleto + PAPER/SHADOW → prossegue, marcado `unvetted: true`
 *   - filtro FALHOU (`incompleteCause: "audit-error"`) → NÃO prossegue em NENHUM modo
 *
 * Nota de alcance (S5): hoje o filtro profundo é "tudo ou nada" — `fetchRealOnChainTokenData`
 * devolve o objeto completo ou lança. Logo, no call site, só o caso `audit-error` chega com
 * `deepComplete: false`; a linha "incompleto + PAPER prossegue" é POLÍTICA para quando existir
 * caminho com dado parcial (S7, `transactionSubscribe`/gRPC). Ela está coberta por teste como
 * função pura para não virar surpresa no dia em que o dado parcial existir.
 */
export function decideEntryWithBudget(input: EntryBudgetInput): EntryBudgetDecision {
  if (input.deepComplete && input.deepVerdict === "reject") {
    return {
      proceed: false,
      unvetted: false,
      reason: "Filtro profundo REPROVOU o token (veredito com evidência). Nenhuma entrada.",
    };
  }

  if (input.deepComplete) {
    return {
      proceed: true,
      unvetted: false,
      reason: `Filtro profundo concluído em ${input.deepElapsedMs ?? "?"}ms (orçamento ${input.budgetMs}ms) com veredito favorável.`,
    };
  }

  if (input.incompleteCause === "audit-error") {
    return {
      proceed: false,
      unvetted: false,
      reason:
        `AUDITORIA FALHOU (sem dado nenhum sobre o token, gasto: ${input.deepElapsedMs ?? "?"}ms). ` +
        `Não existe "entrar sem auditar" quando não há nem o dado a auditar: isto é comprar às cegas. ` +
        `Bloqueado em ${input.mode} (não é uma restrição de modo, é ausência de evidência).`,
    };
  }

  const isLive = input.mode === "LIVE";
  if (isLive) {
    return {
      proceed: false,
      unvetted: false,
      reason:
        `FAIL-CLOSED: filtro profundo NÃO concluiu dentro do orçamento de ${input.budgetMs}ms ` +
        `(gasto: ${input.deepElapsedMs ?? "?"}ms) e o modo é LIVE. Entrar sem auditoria é o caminho ` +
        `conhecido para honeypot/rug. Aumente o orçamento com dados medidos ou reduza o custo do filtro.`,
    };
  }

  return {
    proceed: true,
    unvetted: true,
    reason:
      `Filtro profundo incompleto (${input.deepElapsedMs ?? "?"}ms > orçamento ${input.budgetMs}ms), mas o modo ` +
      `é ${input.mode}: prossegue SEM capital em risco e registra o sinal como NÃO AUDITADO, para medir ` +
      `quanto o filtro custa e quantos sinais ele reprovaria.`,
  };
}

/** Estatísticas de decisão do caminho quente, para medição (nunca inventadas). */
export interface HotPathStats {
  /** Sinais que ENTRARAM no pipeline (após o listener de detecção). */
  signalsSeen: number;
  /**
   * Sinais do MESMO mint descartados porque já havia decisão em voo (trava por mint).
   * Nome com prefixo porque existe OUTRO contador com semântica diferente no cliente de
   * detecção (notificação reentregue pelo WebSocket, deduplicada por assinatura). Dois
   * números com o mesmo nome em endpoints diferentes é convite a diagnóstico errado.
   */
  inFlightDuplicatesDropped: number;
  unvettedEntries: number;
  /** Filtro profundo FALHOU (RPC/parsing) — perda de sinal por falha, não por reprovação. */
  deepFilterFailures: number;
  /** Entradas bloqueadas porque o filtro REPROVOU o token (evidência, não orçamento). */
  rejectedByVerdict: number;
  budgetExceeded: number;
  liveVetoesByBudget: number;
}
