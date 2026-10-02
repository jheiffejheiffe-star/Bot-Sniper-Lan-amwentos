/**
 * SHADOW ENTRY — constrói e SIMULA a entrada, sem assinar.
 *
 * ## O que faz
 *
 * Dado um mint e um tamanho em SOL, este módulo:
 *   1. pede uma cotação REAL de rota (Jupiter) para o par mint/SOL;
 *   2. pede ao builder a transação de swap pronta para assinar;
 *   3. roda `simulateTransaction` no RPC — **sem assinatura**;
 *   4. devolve tudo em um resultado TIPADO: rota encontrada, compute units consumidas, erro
 *      do programa (se houver), logs e os tempos de cada etapa.
 *
 * ## Como funciona (e por que é seguro por construção)
 *
 * Não existe, neste arquivo, nenhuma chamada de assinatura nem de envio: `deps` recebe apenas
 * três capacidades — cotar, montar e simular. Quem injeta não pode oferecer "enviar" porque a
 * interface não tem esse campo. Um teste de regressão (`tests/safety.test.ts`, grupo [11])
 * varre o código-fonte e falha se alguém acrescentar `sign`/`send` aqui dentro.
 *
 * `deps.now()` é monotônico e injetável: os tempos medidos são de relógio monotônico (imune a
 * ajuste de NTP) e os testes não dependem do relógio da máquina.
 *
 * ## Dependências
 *
 * - `src/telemetry.ts` (monotonicNow) — apenas para o default de `now`.
 * - Nenhuma dependência de rede direta: o transporte é sempre injetado.
 *
 * ## Riscos
 *
 * 1. **Simulação não é garantia.** O estado muda entre simular e enviar (TOCTOU). Uma
 *    simulação bem-sucedida diz "a rota existe e o compute cabe", não "vai executar".
 * 2. **Blockhash substituído.** Simulamos com `replaceRecentBlockhash`, ou seja, de propósito
 *    NÃO validamos frescor de blockhash: queremos medir programa/compute, não expiração. O
 *    campo `blockhashReplaced` deixa isso explícito no resultado para ninguém ler errado.
 * 3. **Sem carteira não há simulação.** Se não houver chave operacional provisionada, o
 *    resultado é `skipped` — este módulo NUNCA cria chave efêmera para "ter o que simular".
 *
 * ## Como testar
 *
 * `npm run test` (grupo [11]): rota ok, rota inexistente, RPC fora do ar, e a ausência de
 * qualquer caminho de assinatura.
 *
 * ## Como colocar em produção
 *
 * Chamado pelo pipeline autônomo APÓS a aprovação do risk engine, sempre em modo
 * fire-and-forget (`void ... .catch(...)`) para não somar latência ao instante de decisão.
 * Requer `RUNTIME_MODE` em PAPER ou SHADOW (em LIVE o caminho é o real, não o shadow).
 */

import { monotonicNow } from "./telemetry.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Capacidades mínimas necessárias. Note a AUSÊNCIA de qualquer primitiva de assinatura/envio. */
export interface ShadowEntryDeps {
  getQuote(
    inputMint: string,
    outputMint: string,
    amountLamports: number,
    slippageBps: number,
    timeoutMs?: number
  ): Promise<any>;
  buildSwapTransaction(quote: any, userPublicKey: string, timeoutMs?: number): Promise<any>;
  simulateTransaction(tx: any): Promise<any>;
  now(): number;
}

export interface ShadowEntryRequest {
  mint: string;
  sizeSol: number;
  /** Chave pública (nunca secreta) que assinaria a transação no caminho real. */
  userPublicKey: string | null;
  /** Modo efetivo do processo (`getRuntimeModeResolution().mode`). */
  mode: string;
  slippageBps?: number;
  quoteTimeoutMs?: number;
}

export interface ShadowSimulationOutcome {
  ok: boolean;
  err: unknown | null;
  unitsConsumed: number | null;
  logsTail: string[];
  /** true = o blockhash foi substituído por um recente durante a simulação (ver Riscos). */
  blockhashReplaced: boolean;
}

export interface ShadowEntryResult {
  mint: string;
  sizeSol: number;
  mode: string;
  built: boolean;
  skippedReason: string | null;
  quote: {
    inputMint: string;
    outputMint: string;
    inAmountLamports: number;
    outAmount: string;
    priceImpactPct: number | null;
    routeLabels: string[];
  } | null;
  simulation: ShadowSimulationOutcome | null;
  timingsMs: { quote: number | null; build: number | null; simulate: number | null; total: number };
  recordedAt: string;
  note: string;
}

const DEFAULT_SLIPPAGE_BPS = 300;
const DEFAULT_QUOTE_TIMEOUT_MS = 4000;

const NOTE =
  "Simulação NÃO é garantia de execução: o estado muda entre simular e enviar. " +
  "Nenhuma assinatura e nenhum envio ocorrem neste caminho.";

function skipped(request: ShadowEntryRequest, reason: string, startedAt: number, nowFn: () => number): ShadowEntryResult {
  return {
    mint: request.mint,
    sizeSol: request.sizeSol,
    mode: request.mode,
    built: false,
    skippedReason: reason,
    quote: null,
    simulation: null,
    timingsMs: { quote: null, build: null, simulate: null, total: Math.max(0, nowFn() - startedAt) },
    recordedAt: new Date().toISOString(),
    note: NOTE,
  };
}

function describeError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as any;
    const code = typeof e.code === "string" ? `${e.code}: ` : "";
    return `${code}${e.message ?? String(err)}`;
  }
  return String(err);
}

function routeLabelsOf(quote: any): string[] {
  const steps: any[] = Array.isArray(quote?.routePlan) ? (quote.routePlan as any[]) : [];
  const labels: string[] = steps
    .map((s: any) => s?.swapInfo?.label)
    .filter((l: unknown): l is string => typeof l === "string" && l.length > 0);
  return [...new Set(labels)];
}

/**
 * Executa a entrada em modo shadow. NUNCA lança: toda falha vira um resultado tipado com
 * `built: false` e o motivo. O chamador decide o que fazer com a informação.
 */
export async function simulateEntry(
  deps: ShadowEntryDeps,
  request: ShadowEntryRequest
): Promise<ShadowEntryResult> {
  const nowFn = deps.now ?? monotonicNow;
  const startedAt = nowFn();

  if (request.mode === "SIMULATION") {
    return skipped(request, "modo SIMULATION não usa dados reais: não há entrada a simular.", startedAt, nowFn);
  }
  if (request.mode === "LIVE") {
    return skipped(request, "modo LIVE não usa o caminho shadow (a entrada real é o caminho de execução).", startedAt, nowFn);
  }
  if (!request.userPublicKey) {
    return skipped(
      request,
      "sem chave operacional provisionada: não há carteira para simular (nenhuma chave efêmera é criada).",
      startedAt,
      nowFn
    );
  }
  if (!Number.isFinite(request.sizeSol) || request.sizeSol <= 0) {
    return skipped(request, `tamanho inválido (${request.sizeSol} SOL).`, startedAt, nowFn);
  }

  const amountLamports = Math.floor(request.sizeSol * LAMPORTS_PER_SOL);
  if (amountLamports <= 0) {
    return skipped(request, `tamanho abaixo de 1 lamport (${request.sizeSol} SOL).`, startedAt, nowFn);
  }

  // 1. COTAÇÃO
  const quoteStart = nowFn();
  let quote: any;
  try {
    quote = await deps.getQuote(
      WSOL_MINT,
      request.mint,
      amountLamports,
      request.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
      request.quoteTimeoutMs ?? DEFAULT_QUOTE_TIMEOUT_MS
    );
  } catch (err) {
    const result = skipped(request, `cotação falhou: ${describeError(err)}`, startedAt, nowFn);
    result.timingsMs.quote = nowFn() - quoteStart;
    return result;
  }
  const quoteMs = nowFn() - quoteStart;

  const parsedQuote = {
    inputMint: String(quote?.inputMint ?? WSOL_MINT),
    outputMint: String(quote?.outputMint ?? request.mint),
    inAmountLamports: amountLamports,
    outAmount: String(quote?.outAmount ?? ""),
    priceImpactPct: Number.isFinite(Number(quote?.priceImpactPct)) ? Number(quote.priceImpactPct) : null,
    routeLabels: routeLabelsOf(quote),
  };

  // 2. CONSTRUÇÃO (transação pronta para assinar — mas nunca assinada aqui)
  const buildStart = nowFn();
  let tx: any;
  try {
    tx = await deps.buildSwapTransaction(quote, request.userPublicKey);
  } catch (err) {
    const result = skipped(request, `construção falhou: ${describeError(err)}`, startedAt, nowFn);
    result.timingsMs.quote = quoteMs;
    result.timingsMs.build = nowFn() - buildStart;
    result.quote = parsedQuote;
    return result;
  }
  if (!tx || typeof tx.serialize !== "function") {
    const result = skipped(request, "builder devolveu objeto que não é transação serializável.", startedAt, nowFn);
    result.timingsMs.quote = quoteMs;
    result.timingsMs.build = nowFn() - buildStart;
    result.quote = parsedQuote;
    return result;
  }
  const buildMs = nowFn() - buildStart;

  // 3. SIMULAÇÃO (sem assinatura, blockhash substituído por um recente)
  const simStart = nowFn();
  let simulation: ShadowSimulationOutcome;
  try {
    const sim = await deps.simulateTransaction(tx);
    const value = (sim && typeof sim === "object" && "value" in sim ? (sim as any).value : sim) ?? {};
    const logsRaw: unknown[] = Array.isArray(value?.logs) ? value.logs : [];
    // Logs vêm de resposta de rede: filtramos o que não for string em vez de confiar no tipo.
    const logs: string[] = logsRaw.filter((l): l is string => typeof l === "string");
    simulation = {
      ok: value?.err == null,
      err: value?.err ?? null,
      unitsConsumed: Number.isFinite(Number(value?.unitsConsumed)) ? Number(value.unitsConsumed) : null,
      logsTail: logs.slice(-12),
      blockhashReplaced: true,
    };
  } catch (err) {
    simulation = {
      ok: false,
      err: describeError(err),
      unitsConsumed: null,
      logsTail: [],
      blockhashReplaced: true,
    };
  }
  const simulateMs = nowFn() - simStart;

  return {
    mint: request.mint,
    sizeSol: request.sizeSol,
    mode: request.mode,
    built: true,
    skippedReason: null,
    quote: parsedQuote,
    simulation,
    timingsMs: { quote: quoteMs, build: buildMs, simulate: simulateMs, total: nowFn() - startedAt },
    recordedAt: new Date().toISOString(),
    note: NOTE,
  };
}
