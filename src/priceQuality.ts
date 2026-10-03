/**
 * QUALIDADE DE PREÇO E LIQUIDEZ — o que decide se um preço pode ser usado para decidir.
 *
 * ## O que faz
 *
 * Duas verificações de SANIDADE sobre o dado que o bot já tem em mãos, sem gastar cota nova:
 *
 *   1. **Divergência entre fontes** (`PriceSampleBook` + `assessDivergence`): guarda as últimas
 *      cotações de cada token POR FONTE e, quando uma segunda fonte responde o mesmo token
 *      dentro da janela de validade, compara as duas. Divergência grande significa que uma das
 *      duas está errada (pool raso, token errado do par, dado velho de cache, decimal trocado)
 *      — e um stop-loss calculado sobre preço errado vende por engano.
 *   2. **Liquidez em queda** (`assessLiquidityDrop`): o DexScreener (fonte do lote) informa a
 *      liquidez do par; queda acentuada em relação ao pico observado é o sinal clássico de
 *      "rug pull" em andamento (o LP sendo removido) e chega ANTES do preço refletir.
 *
 * ## Como funciona
 *
 * - `PriceSampleBook` é um cache LIMITADO por token e por fonte: no máximo `maxPerMint` amostras
 *  por token, no máximo `maxMints` tokens (evicção FIFO). Sem teto, um cache de preço vira
 *   memory leak em bot que roda semanas — e é exatamente o tipo de vazamento que só aparece em
 *   produção.
 * - A comparação IGNORA a mesma fonte: o mesmo provedor responder duas vezes com preços
 *   diferentes é deriva de mercado (o ativo andou), não divergência. Divergência é discordância
 *   entre fontes INDEPENDENTES, no mesmo intervalo de tempo.
 * - Amostra mais velha que `maxAgeMs` não conta: comparar preço de agora com preço de dois
 *   minutos atrás em token recém-lançado transformaria movimento normal em "divergência".
 *   Por isso o achado carrega `reference.ageMs` — quem lê sabe o quanto confiar.
 * - Resultado é sempre CLASSIFICADO (`ok`/`warn`/`critical`) com limiar explícito em fração
 *   (0,05 = 5%) e nunca esconde o número bruto (`pct` e `bps`).
 *
 * ## Regras de honestidade
 *
 * - Preço ≤ 0, `NaN` ou `Infinity` NUNCA entra no livro (não é amostra).
 * - Sem outra fonte na janela, `assessDivergence` devolve `null` — ausência de segunda opinião
 *   não é aprovação. `null` significa "não verifiquei", não "está tudo certo".
 * - Este módulo NÃO decide comprar nem vender. Ele produz um veredito; a política de agir
 *   (alertar, vetar entrada, reduzir posição) é do chamador e precisa de autorização própria.
 *   Preço divergente não pode virar "venda automática" sem antes existir execução real
 *   autorizada e regra de saída testada.
 *
 * ## Dependências
 *
 * Nenhuma. TypeScript puro, relógio injetável (`now`) — testável em microssegundos.
 *
 * ## Como testar
 *
 * `npm run test` — grupo [21]: comparação entre fontes, ignorar mesma fonte, amostra velha,
 * memória limitada, preço inválido descartado e queda de liquidez por faixa.
 *
 * ## Como colocar em produção
 *
 * Ligado por padrão no gerenciador de posições (ver `HFT_PRICE_DIVERGENCE`,
 * `HFT_PRICE_DIVERGENCE_WARN_BPS`, `HFT_PRICE_DIVERGENCE_CRITICAL_BPS` e
 * `HFT_PRICE_VERIFY_SAMPLE` no `.env.example`). Achados aparecem em `GET /api/health →
 * marketBatch.divergences` e no log operacional com os DOIS preços e as DUAS fontes.
 */

export interface PriceSample {
  mint: string;
  source: string;
  priceSol: number;
  /** Instante da COLETA (não do registro no livro). */
  at: number;
}

export interface DivergenceThresholds {
  /** A partir desta fração de diferença relativa, o achado vira `warn`. */
  warnPct: number;
  /** A partir desta fração, `critical`. */
  criticalPct: number;
  /** Amostra mais velha que isto não serve de referência. */
  maxAgeMs: number;
}

/**
 * Limiares padrão.
 *
 * 5% / 15% são escolhas EXPLÍCITAS, não medições: token recém-lançado negocia com spread alto e
 * fontes calculam preço por pools diferentes, então discordância pequena é esperada. Acima de
 * 15% a probabilidade de uma das fontes estar ESTRUTURALMENTE errada (pool errado, decimal
 * errado) cresce muito. Quem quiser mais sensibilidade aperta por env e observa os números
 * reais — o limiar não deve ser chutado para baixo sem medir o ruído da própria carteira.
 */
export const DEFAULT_DIVERGENCE_THRESHOLDS: DivergenceThresholds = {
  warnPct: 0.05,
  criticalPct: 0.15,
  maxAgeMs: 45_000,
};

export type DivergenceSeverity = "ok" | "warn" | "critical";

export interface DivergenceFinding {
  mint: string;
  /** Diferença relativa (0,05 = 5%) entre a referência e o candidato. */
  pct: number;
  /** O mesmo número em pontos-base, já arredondado — para log e dashboard. */
  bps: number;
  severity: DivergenceSeverity;
  reference: { source: string; priceSol: number; ageMs: number };
  candidate: { source: string; priceSol: number };
}

/**
 * Diferença relativa entre dois preços, normalizada pelo MAIOR.
 *
 * Dividir pelo maior (e não pela média) mantém o número em [0, 1) e garante simetria:
 * `pct(a, b) === pct(b, a)`. Preço não positivo ou não finito devolve `null` — nunca 0, que
 * seria lido como "concordam".
 */
export function relativeDivergencePct(a: unknown, b: unknown): number | null {
  const x = typeof a === "number" && Number.isFinite(a) ? a : NaN;
  const y = typeof b === "number" && Number.isFinite(b) ? b : NaN;
  if (!(x > 0) || !(y > 0)) return null;
  const max = Math.max(x, y);
  if (max <= 0) return null;
  return Math.abs(x - y) / max;
}

/** Classifica a diferença pelas faixas informadas. `null` (não comparável) devolve `null`. */
export function classifyDivergence(
  pct: number | null,
  thresholds: DivergenceThresholds = DEFAULT_DIVERGENCE_THRESHOLDS
): DivergenceSeverity | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  if (pct >= thresholds.criticalPct) return "critical";
  if (pct >= thresholds.warnPct) return "warn";
  return "ok";
}

/**
 * Compara duas amostras EXPLÍCITAS (referência e candidato) e classifica a discordância.
 *
 * É a função pura por trás de tudo: `assessDivergence` só escolhe a referência no livro e
 * delega para cá. Mantida pública porque a verificação cruzada do lote chama dois preços que
 * acabaram de chegar e não precisa passar pelo histórico.
 *
 * Devolve `null` quando não há o que comparar: mesma fonte (deriva de mercado não é
 * divergência), preços inválidos, ou nenhum dos dois positivo.
 */
export function compareSamples(
  mint: string,
  reference: { source: string; priceSol: number; at: number },
  candidate: { source: string; priceSol: number },
  thresholds: DivergenceThresholds = DEFAULT_DIVERGENCE_THRESHOLDS,
  nowMs: number = Date.now()
): DivergenceFinding | null {
  if (reference.source === candidate.source) return null;

  const pct = relativeDivergencePct(reference.priceSol, candidate.priceSol);
  const severity = classifyDivergence(pct, thresholds);
  if (pct === null || severity === null) return null;

  return {
    mint,
    pct,
    bps: Math.round(pct * 10_000),
    severity,
    reference: {
      source: reference.source,
      priceSol: reference.priceSol,
      ageMs: Math.max(0, nowMs - reference.at),
    },
    candidate: { source: candidate.source, priceSol: candidate.priceSol },
  };
}

/**
 * Compara um candidato com a amostra mais recente de OUTRA fonte para o mesmo token.
 *
 * Devolve `null` quando não existe segunda opinião válida (mesma fonte, amostra velha demais,
 * preços inválidos, nada registrado). Isso é deliberado: o chamador precisa distinguir
 * "verifiquei e concorda" de "não verifiquei".
 */
export function assessDivergence(
  mint: string,
  candidate: { source: string; priceSol: number },
  book: PriceSampleBook,
  thresholds: DivergenceThresholds = DEFAULT_DIVERGENCE_THRESHOLDS
): DivergenceFinding | null {
  const reference = book.freshestOtherSource(mint, candidate.source, thresholds.maxAgeMs);
  if (!reference) return null;
  return compareSamples(mint, reference, candidate, thresholds, book.nowMs());
}

/**
 * Livro de amostras de preço — memória LIMITADA e auditável.
 *
 * Limites (evitam crescimento sem teto em processo de longa duração):
 * - `maxPerMint`: amostras guardadas por token (as mais recentes vencem);
 * - `maxMints`: tokens guardados; ao exceder, o token registrado há mais tempo sai.
 */
export class PriceSampleBook {
  private byMint = new Map<string, PriceSample[]>();

  constructor(
    private readonly options: {
      maxPerMint?: number;
      maxMints?: number;
      now?: () => number;
    } = {}
  ) {
    const perMint = options.maxPerMint ?? 4;
    const mints = options.maxMints ?? 500;
    if (!Number.isFinite(perMint) || perMint <= 0) {
      throw new Error(`PriceSampleBook: maxPerMint precisa ser > 0 (recebido ${perMint})`);
    }
    if (!Number.isFinite(mints) || mints <= 0) {
      throw new Error(`PriceSampleBook: maxMints precisa ser > 0 (recebido ${mints})`);
    }
    this.maxPerMint = perMint;
    this.maxMints = mints;
  }

  private readonly maxPerMint: number;
  private readonly maxMints: number;

  public nowMs(): number {
    return (this.options.now ?? (() => Date.now()))();
  }

  /** Registra uma amostra. Preço não positivo/não finito é DESCARTADO (não é preço). */
  public record(sample: PriceSample): boolean {
    if (!sample || typeof sample.mint !== "string" || sample.mint.length === 0) return false;
    if (typeof sample.source !== "string" || sample.source.length === 0) return false;
    if (typeof sample.priceSol !== "number" || !Number.isFinite(sample.priceSol) || sample.priceSol <= 0) {
      return false;
    }
    if (!Number.isFinite(sample.at)) return false;

    const list = this.byMint.get(sample.mint) ?? [];
    list.push({ ...sample });

    // Mantém apenas as `maxPerMint` mais recentes do token.
    if (list.length > this.maxPerMint) {
      list.sort((a, b) => a.at - b.at);
      list.splice(0, list.length - this.maxPerMint);
    }
    this.byMint.set(sample.mint, list);

    // Evicção FIFO por token (Map preserva a ordem de inserção).
    while (this.byMint.size > this.maxMints) {
      const oldest = this.byMint.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.byMint.delete(oldest);
    }
    return true;
  }

  /** Amostra mais recente de outra fonte dentro da janela. `null` quando não há segunda opinião. */
  public freshestOtherSource(mint: string, source: string, maxAgeMs: number): PriceSample | null {
    const list = this.byMint.get(mint);
    if (!list || list.length === 0) return null;
    const cutoff = this.nowMs() - Math.max(0, maxAgeMs);
    let best: PriceSample | null = null;
    for (const s of list) {
      if (s.source === source) continue;
      if (s.at < cutoff) continue;
      if (!best || s.at > best.at) best = s;
    }
    return best;
  }

  /** Última amostra do token (de qualquer fonte), opcionalmente filtrando por fonte. */
  public latest(mint: string, source?: string): PriceSample | null {
    const list = this.byMint.get(mint);
    if (!list || list.length === 0) return null;
    let best: PriceSample | null = null;
    for (const s of list) {
      if (source !== undefined && s.source !== source) continue;
      if (!best || s.at > best.at) best = s;
    }
    return best;
  }

  /** Remove amostras mais velhas que `maxAgeMs` (e tokens que ficaram vazios). */
  public prune(maxAgeMs: number): number {
    const cutoff = this.nowMs() - Math.max(0, maxAgeMs);
    let removed = 0;
    for (const [mint, list] of this.byMint) {
      const keep = list.filter((s) => s.at >= cutoff);
      removed += list.length - keep.length;
      if (keep.length === 0) this.byMint.delete(mint);
      else this.byMint.set(mint, keep);
    }
    return removed;
  }

  public size(): number {
    return this.byMint.size;
  }

  /** Só para diagnóstico/teste: quantas amostras existem para um token. */
  public countFor(mint: string): number {
    return this.byMint.get(mint)?.length ?? 0;
  }

  public clear(): void {
    this.byMint.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* LIQUIDEZ                                                                   */
/* -------------------------------------------------------------------------- */

export interface LiquidityThresholds {
  /** Queda relativa a partir da qual o alerta é `warn` (0,5 = −50% do pico). */
  warnDropPct: number;
  /** Queda relativa a partir da qual o alerta é `critical` (0,8 = −80% do pico). */
  criticalDropPct: number;
}

/**
 * Limiares de queda de liquidez.
 *
 * −50% / −80% são ALERTA, não gatilho: liquidez de pool medida em USD oscila com o próprio
 * preço do token (se o token cai, a perna em token vale menos em USD) e com a entrada/saída de
 * LPs legítimos. Por isso o módulo só classifica — quem decide reduzir posição precisa antes
 * ter execução real autorizada e regra validada em paper.
 */
export const DEFAULT_LIQUIDITY_THRESHOLDS: LiquidityThresholds = {
  warnDropPct: 0.5,
  criticalDropPct: 0.8,
};

export interface LiquidityAlert {
  peakUsd: number;
  currentUsd: number;
  /** Queda relativa ao pico (0,6 = caiu 60%). */
  dropPct: number;
  severity: "warn" | "critical";
}

/**
 * Queda de liquidez em relação ao pico OBSERVADO pelo bot.
 *
 * Devolve `null` — silêncio — quando: o pico não é positivo, o valor atual não é finito/positivo,
 * ou a queda é menor que `warnDropPct`. `null` aqui significa "nada a declarar", nunca
 * "liquidez saudável".
 */
export function assessLiquidityDrop(
  peakUsd: unknown,
  currentUsd: unknown,
  thresholds: LiquidityThresholds = DEFAULT_LIQUIDITY_THRESHOLDS
): LiquidityAlert | null {
  const peak = typeof peakUsd === "number" && Number.isFinite(peakUsd) ? peakUsd : NaN;
  const current = typeof currentUsd === "number" && Number.isFinite(currentUsd) ? currentUsd : NaN;
  if (!(peak > 0) || !(current > 0)) return null;
  if (current >= peak) return null;

  const dropPct = (peak - current) / peak;
  if (dropPct < thresholds.warnDropPct) return null;

  return {
    peakUsd: peak,
    currentUsd: current,
    dropPct,
    severity: dropPct >= thresholds.criticalDropPct ? "critical" : "warn",
  };
}
