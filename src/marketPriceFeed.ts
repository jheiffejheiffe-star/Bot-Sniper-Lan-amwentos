/**
 * PREÇO DE MERCADO EM LOTE — escalar o bot GRATUITO sem estourar cota.
 *
 * ## O que faz
 *
 * Busca preço de VÁRIOS tokens em UMA chamada por provedor, em vez de uma chamada por token.
 * Três fontes gratuitas, com contratos verificados:
 *
 *   1. **DexScreener** — `GET /latest/dex/tokens/{mints}` aceita **até 30 endereços** separados
 *      por vírgula na mesma requisição (mesmo teto de 300 req/min). É a fonte mais rica: dá
 *      `priceNative`, `priceUsd` e `liquidity.usd`. CUIDADO: `priceNative` é o preço do token na
 *      moeda de COTAÇÃO do par — só é "preço em SOL" quando o par é cotado em wrapped SOL. Em
 *      par cotado em USDC, o número está em USDC e vale ~200x o preço em SOL; por isso a
 *      conversão usa o USD/SOL do PRÓPRIO payload (`priceSolFromDexPairs`).
 *   2. **Jupiter Price API v3** — `GET /price/v3?ids={mints}` aceita **até 50 ids**. Devolve
 *      preço em USD; a conversão para SOL usa o preço do SOL **pedido na mesma requisição**
 *      (o mint wrapped-SOL vai sempre no lote). No plano Free, as chamadas do Price API contam
 *      no MESMO balde de 60 req/min das cotações — por isso compartilham o orçamento `jupiter`.
 *   3. **GeckoTerminal** — `GET /simple/networks/solana/token_price/{mints}` aceita até 30,
 *      **grátis e sem chave**, 30 chamadas/min. Terceira opinião independente das duas
 *      anteriores (se ambas caírem, o bot continua com telemetria de preço).
 *
 * ## Por que isto é a alavanca certa no gratuito
 *
 * Latência não é o problema de um plano gratuito: **cota** é. Com 10 posições abertas, o
 * código anterior gastava 10 requisições DexScreener + até 10 cotações Jupiter **a cada ciclo de
 * 3 s** — mais de 400 req/min, acima do teto de 300/min do DexScreener. Ou seja: o bot garantia
 * `429` no meio da operação. Em lote, o MESMO trabalho custa 1 requisição por provedor por ciclo.
 *
 * ## Regras de honestidade (as mesmas de todo o resto do projeto)
 *
 * - Preço ausente é `null` — nunca `0`, nunca o último valor conhecido apresentado como atual.
 * - A fonte que forneceu cada número vem junto (`source`), e o motivo de cada falha é registrado.
 * - `priceSol` só é calculado quando existe o preço do SOL na MESMA resposta (ou um SOL/USD
 *   explicitamente fornecido pelo chamador): converter com um SOL/USD velho ou chutado seria
 *   fabricar preço, e preço errado dispara stop-loss/venda por engano.
 * - Endereços são comparados EXATAMENTE (base58 é case-sensitive): nada de `toLowerCase()`.
 *
 * ## Dependências
 *
 * Nenhuma. `fetch` e orçamentos injetáveis; funções puras exportadas para teste.
 *
 * ## Como testar
 *
 * `npm run test` — grupo [20]: parsing das três fontes, escolha do par de maior liquidez,
 * conversão USD→SOL com o SOL do lote, "sem SOL no lote NÃO converte", lote por chunks,
 * fallback em cascata e contabilização de cota.
 *
 * ## Como colocar em produção
 *
 * `HFT_MARKET_BATCH=0` volta ao comportamento por posição. Os contadores aparecem em
 * `GET /api/health → marketBatch`.
 */

import { BudgetOutcome, RateBudget, withBudget } from "./rateBudget.js";
import {
  assessDivergence,
  compareSamples,
  DEFAULT_DIVERGENCE_THRESHOLDS,
  PriceSampleBook,
  type DivergenceFinding,
  type DivergenceThresholds,
} from "./priceQuality.js";

export const DEXSCREENER_BASE_URL_DEFAULT = "https://api.dexscreener.com/latest/dex";
export const JUPITER_PRICE_BASE_URL_DEFAULT = "https://lite-api.jup.ag";
export const GECKOTERMINAL_BASE_URL_DEFAULT = "https://api.geckoterminal.com/api/v2";

/** Limites publicados de cada provedor para chamadas em lote. */
export const DEXSCREENER_MAX_ADDRESSES_PER_CALL = 30;
export const JUPITER_MAX_IDS_PER_CALL = 50;
export const GECKOTERMINAL_MAX_ADDRESSES_PER_CALL = 30;

export const SOL_MINT = "So11111111111111111111111111111111111111112";

export interface BatchQuote {
  mint: string;
  /** Preço em SOL. `null` = não determinado por NENHUMA fonte (nunca 0). */
  priceSol: number | null;
  /** Liquidez em USD quando a fonte informa (hoje: DexScreener). */
  liquidityUsd: number | null;
  /** Qual fonte produziu o `priceSol`. */
  source: string;
  fetchedAt: number;
}

export interface BatchResult {
  quotes: Map<string, BatchQuote>;
  /** Quantas requisições HTTP foram realmente feitas. */
  requests: number;
  /** Uma linha por provedor tentado — inclusive quando não foi usado e por quê. */
  problems: string[];
  /** Fontes que efetivamente forneceram algum preço, na ordem de tentativa. */
  sourcesUsed: string[];
  /**
   * Discordâncias entre fontes INDEPENDENTES para o mesmo token (`warn`/`critical`).
   * Lista vazia significa "não houve discordância relevante" — para saber se houve
   * comparação de verdade, olhe `verification.checked`.
   */
  divergences: DivergenceFinding[];
  /** Resultado da amostra de verificação cruzada deste ciclo. */
  verification: BatchVerification;
}

export interface BatchVerification {
  /** A verificação cruzada foi tentada neste ciclo? */
  attempted: boolean;
  /** Fonte usada na verificação (a primeira que ainda não havia respondido). */
  source: string | null;
  /** Quantas comparações cruzadas foram efetivamente feitas. */
  checked: number;
  problems: string[];
}

export interface BatchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  dexscreenerBaseUrl?: string;
  jupiterBaseUrl?: string;
  geckoterminalBaseUrl?: string;
  /** Cabeçalho `x-api-key` da Jupiter quando houver chave (Free também usa). */
  jupiterApiKey?: string;
  now?: () => number;
  priority?: "normal" | "exit" | "background";
  maxWaitMs?: number;
  /** Orçamentos: se ausentes, a chamada é feita sem controle de cota (uso em teste). */
  dexscreenerBudget?: RateBudget;
  jupiterBudget?: RateBudget;
  geckoterminalBudget?: RateBudget;
  /** SOL/USD de reserva quando a fonte não devolve o SOL no lote (nunca inventa). */
  solUsdFallback?: number | null;
  /**
   * Livro de amostras por token/fonte. Quando presente, cada preço obtido é COMPARADO com a
   * amostra mais recente de outra fonte e depois registrado. Sem livro, não há verificação
   * cruzada — o lote volta a ser só "o primeiro que responde".
   */
  sampleBook?: PriceSampleBook;
  /** Limiares da comparação (ligados por padrão; ver `priceQuality.ts`). */
  divergenceThresholds?: DivergenceThresholds;
  /**
   * Tokens que devem ganhar uma SEGUNDA OPINIÃO neste ciclo, mesmo já tendo preço. A verificação
   * usa a primeira fonte ainda não tentada (Jupiter, depois GeckoTerminal) e custa no MÁXIMO
   * uma requisição extra por chamada — é o que permite detectar divergência no caso comum, em
   * que o DexScreener responde tudo.
   */
  verifyMints?: string[];
  /**
   * Prioridade da VERIFICAÇÃO. Padrão `background`: verificação é dado adicional, então ela
   * desiste na primeira negativa de cota e NUNCA faz bypass. Sem isto, uma chamada de lote com
   * prioridade `exit` (gestão de posição) faria a verificação furar a cota — roubando vaga de
   * quem realmente precisa reduzir risco.
   */
  verificationPriority?: "normal" | "exit" | "background";
}

function finiteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Endereço que vale a pena consultar: base58 plausível, sem "..." de mock. */
export function isQueryableMint(mint: unknown): mint is string {
  return typeof mint === "string" && mint.length >= 32 && mint.length <= 44 && !mint.includes("...");
}

/** Divide em lotes do tamanho máximo do provedor. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/* -------------------------------------------------------------------------- */
/* PARSERS (puros)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Ancoragem de SOL/USD a partir do próprio payload do DexScreener: o par de MAIOR liquidez cujo
 * token-base é o wrapped SOL (`priceUsd` é dólar por SOL). Sem isso, não existe como converter
 * preço em USD para SOL sem inventar cotação — e o `solUsdFallback` do chamador é a única
 * alternativa explícita.
 */
export function dexSolUsdFromPairs(pairs: unknown, solUsdFallback: number | null = null): number | null {
  if (!Array.isArray(pairs)) return finiteNumber(solUsdFallback) ?? null;
  let melhor: number | null = null;
  let melhorLiquidez = -1;
  for (const p of pairs) {
    if (!p || typeof p !== "object") continue;
    if ((p as any).chainId !== "solana") continue;
    if ((p as any)?.baseToken?.address !== SOL_MINT) continue;
    const usd = finiteNumber((p as any).priceUsd);
    if (usd === null || usd <= 0) continue;
    const liq = finiteNumber((p as any)?.liquidity?.usd) ?? 0;
    if (liq > melhorLiquidez) {
      melhorLiquidez = liq;
      melhor = usd;
    }
  }
  if (melhor !== null) return melhor;
  const reserva = finiteNumber(solUsdFallback);
  return reserva !== null && reserva > 0 ? reserva : null;
}

/**
 * Preço em SOL a partir dos pares de UM token, escolhendo o par de MAIOR LIQUIDEZ.
 *
 * ## A regra que evita erro de 200x
 *
 * No DexScreener, `priceNative` é o preço do token-base na moeda de COTAÇÃO do par — não "em
 * SOL" por definição. Para um par TOKEN/SOL isso coincide com SOL por token; para um par
 * TOKEN/USDC, `priceNative` é USDC por token e vale ~200x mais que o preço em SOL (SOL ≈ 200
 * USD). Usar esse número como preço em SOL infla o PnL e, com capital real, dispara take-profit
 * imediatamente depois da compra.
 *
 * Então:
 *   1. par cotado em WRAPPED SOL  → `priceNative` É preço em SOL (sem conversão);
 *   2. par cotado em outro token  → `priceUsd / solUsd` (SOL/USD do mesmo payload);
 *   3. sem SOL/USD disponível     → `null` (a razão fica em `reason`), nunca o número errado.
 */
export function priceSolFromDexPairs(
  pairs: unknown,
  mint: string,
  solUsdFallback: number | null = null,
  /**
   * Âncora USD/SOL já extraída do payload COMPLETO. Obrigatória quando `pairs` é apenas a lista
   * de pares DESTE token (caso do parser em lote): o par do SOL não estaria nessa lista e a
   * conversão cairia indevidamente em "sem âncora".
   */
  solUsdPrecomputed: number | null = null
): { priceSol: number | null; liquidityUsd: number | null; quoteToken: string | null; reason: string } {
  const lista = Array.isArray(pairs)
    ? (pairs as any[]).filter(
        (p) => p && typeof p === "object" && p.chainId === "solana" && p?.baseToken?.address === mint
      )
    : [];
  if (lista.length === 0) {
    return { priceSol: null, liquidityUsd: null, quoteToken: null, reason: "nenhum par Solana com este token como base" };
  }

  // Par de MAIOR liquidez (pool raso não é preço de mercado).
  const melhor = lista.reduce((a, b) =>
    (finiteNumber(b?.liquidity?.usd) ?? -1) > (finiteNumber(a?.liquidity?.usd) ?? -1) ? b : a
  );
  const liquidityUsd = finiteNumber(melhor?.liquidity?.usd);
  const quoteToken = typeof melhor?.quoteToken?.address === "string" ? melhor.quoteToken.address : null;

  // O próprio wrapped SOL vale 1 SOL, por definição — independe da moeda de cotação do par.
  if (mint === SOL_MINT) {
    return { priceSol: 1, liquidityUsd, quoteToken, reason: "wrapped SOL (preço 1 por definição)" };
  }

  const priceNative = finiteNumber(melhor?.priceNative);
  if (quoteToken === SOL_MINT) {
    if (priceNative !== null && priceNative > 0) {
      return { priceSol: priceNative, liquidityUsd, quoteToken, reason: "par cotado em SOL: priceNative já é SOL por token" };
    }
    return { priceSol: null, liquidityUsd, quoteToken, reason: "par cotado em SOL, mas priceNative ausente ou inválido" };
  }

  const priceUsd = finiteNumber(melhor?.priceUsd);
  const solUsd = solUsdPrecomputed ?? dexSolUsdFromPairs(pairs, solUsdFallback);
  if (priceUsd !== null && priceUsd > 0 && solUsd !== null && solUsd > 0) {
    return {
      priceSol: priceUsd / solUsd,
      liquidityUsd,
      quoteToken,
      reason: quoteToken === null ? "par sem quoteToken: convertido por USD/SOL do lote" : "par cotado em outro token: convertido por USD/SOL do lote",
    };
  }

  return {
    priceSol: null,
    liquidityUsd,
    quoteToken,
    reason:
      "par cotado em outro token e sem SOL/USD no payload: converter seria fabricar preço " +
      "(priceNative está na moeda de cotação, não em SOL)",
  };
}

/**
 * DexScreener, em lote: escolhe o par Solana de MAIOR LIQUIDEZ por token e calcula o preço em
 * SOL pela regra acima (`priceSolFromDexPairs`). A fonte registrada em `source` diz QUAL
 * caminho foi usado, para o operador saber se houve conversão.
 */
export function parseDexScreenerBatch(
  body: unknown,
  fetchedAt: number,
  solUsdFallback: number | null = null
): Map<string, BatchQuote> {
  const out = new Map<string, BatchQuote>();
  const pairs = (body as any)?.pairs;
  if (!Array.isArray(pairs)) return out;

  const porMint = new Map<string, any[]>();
  for (const p of pairs) {
    if (!p || typeof p !== "object") continue;
    if ((p as any).chainId !== "solana") continue;
    const mint = (p as any)?.baseToken?.address;
    if (!isQueryableMint(mint)) continue;
    const lista = porMint.get(mint) ?? [];
    lista.push(p);
    porMint.set(mint, lista);
  }

  // Âncora USD/SOL do payload COMPLETO (o SOL pode não ser base de nenhum par da lista de um token).
  const solUsdAncora = dexSolUsdFromPairs(pairs, solUsdFallback);

  for (const [mint, lista] of porMint) {
    const r = priceSolFromDexPairs(lista, mint, solUsdFallback, solUsdAncora);
    const conversao = r.reason.includes("convertido") ? " (USD→SOL do lote)" : "";
    out.set(mint, {
      mint,
      priceSol: r.priceSol,
      liquidityUsd: r.liquidityUsd,
      source:
        r.priceSol === null
          ? `dexscreener (lote) — sem preço em SOL: ${r.reason}`
          : `dexscreener (lote)${conversao}`,
      fetchedAt,
    });
  }
  return out;
}

/**
 * Jupiter Price v3: `{ "<mint>": { usdPrice } }`. A conversão para SOL exige o preço do SOL;
 * quando o chamador passou um valor de reserva, ele é usado APENAS se a resposta não trouxer SOL
 * — e a fonte registra isso para auditoria.
 */
export function parseJupiterPriceBatch(
  body: unknown,
  fetchedAt: number,
  solUsdFallback: number | null = null
): { quotes: Map<string, BatchQuote>; solUsd: number | null; solFromResponse: boolean } {
  const quotes = new Map<string, BatchQuote>();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { quotes, solUsd: null, solFromResponse: false };
  }
  const obj = body as Record<string, any>;

  const solUsdFromResponse = finiteNumber(obj[SOL_MINT]?.usdPrice);
  const solUsd = solUsdFromResponse ?? (finiteNumber(solUsdFallback) ?? null);

  for (const [mint, data] of Object.entries(obj)) {
    if (!isQueryableMint(mint)) continue;
    const usd = finiteNumber((data as any)?.usdPrice);
    let priceSol: number | null = null;
    if (mint === SOL_MINT) {
      priceSol = 1; // o próprio SOL, por definição
    } else if (usd !== null && solUsd !== null && solUsd > 0) {
      priceSol = usd / solUsd;
    }
    quotes.set(mint, {
      mint,
      priceSol,
      liquidityUsd: null,
      source: solUsdFromResponse ? "jupiter price/v3 (lote)" : "jupiter price/v3 (lote, SOL/USD de reserva)",
      fetchedAt,
    });
  }
  return { quotes, solUsd, solFromResponse: solUsdFromResponse !== null };
}

/** GeckoTerminal: JSON:API `data.attributes.token_prices[addr].price_usd`. */
export function parseGeckoTerminalBatch(
  body: unknown,
  fetchedAt: number,
  solUsdFallback: number | null = null
): { quotes: Map<string, BatchQuote>; solUsd: number | null; solFromResponse: boolean } {
  const quotes = new Map<string, BatchQuote>();
  const attrs = (body as any)?.data?.attributes;
  const table = attrs?.token_prices;
  if (!table || typeof table !== "object" || Array.isArray(table)) {
    return { quotes, solUsd: null, solFromResponse: false };
  }

  const rawSol = finiteNumber((table as any)[SOL_MINT]?.price_usd);
  const solUsd = rawSol ?? (finiteNumber(solUsdFallback) ?? null);

  for (const [mint, data] of Object.entries(table as Record<string, any>)) {
    if (!isQueryableMint(mint)) continue;
    const usd = finiteNumber((data as any)?.price_usd);
    let priceSol: number | null = null;
    if (mint === SOL_MINT) {
      priceSol = 1;
    } else if (usd !== null && solUsd !== null && solUsd > 0) {
      priceSol = usd / solUsd;
    }
    quotes.set(mint, {
      mint,
      priceSol,
      liquidityUsd: null,
      source: rawSol !== null ? "geckoterminal (lote)" : "geckoterminal (lote, SOL/USD de reserva)",
      fetchedAt,
    });
  }
  return { quotes, solUsd, solFromResponse: rawSol !== null };
}

/* -------------------------------------------------------------------------- */
/* BUSCA EM CASCATA                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Executa um provedor respeitando o orçamento. O contador de requisições HTTP é incrementado
 * dentro de `getJson` (fonte real), então aqui só importa se a chamada foi PULADA por cota.
 */
async function runProvider(
  budget: RateBudget | undefined,
  options: BatchOptions,
  fn: () => Promise<Map<string, BatchQuote>>
): Promise<{ quotes: Map<string, BatchQuote>; skipped: BudgetOutcome<Map<string, BatchQuote>> | null }> {
  if (!budget) {
    return { quotes: await fn(), skipped: null };
  }
  /**
   * Prioridade padrão aqui é `normal` (respeita a cota e PULA quando ela acaba). Quem chama
   * declara `exit` quando o dado é para GERENCIAR posição — reduzir risco não pode depender de
   * cota, mas essa é uma decisão explícita do chamador, não um default silencioso deste módulo.
   */
  const outcome = await withBudget(budget, fn, {
    priority: options.priority ?? "normal",
    maxWaitMs: options.maxWaitMs ?? 0,
  });
  if (!outcome.ok) {
    return { quotes: new Map(), skipped: outcome };
  }
  return { quotes: (outcome.value ?? new Map()) as Map<string, BatchQuote>, skipped: null };
}

/**
 * Busca preço para uma LISTA de mints, em cascata, parando assim que todos tiverem preço.
 *
 * Ordem: DexScreener (traz preço em SOL + liquidez) → Jupiter Price v3 (USD→SOL com o SOL do
 * lote) → GeckoTerminal (idem, terceira opinião). O SOL é incluído no lote das duas últimas
 * para que a conversão não dependa de valor externo.
 */
export async function fetchBatchPrices(mints: string[], options: BatchOptions = {}): Promise<BatchResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? 6_000;
  const dexscreenerBaseUrl = (options.dexscreenerBaseUrl ?? DEXSCREENER_BASE_URL_DEFAULT).replace(/\/$/, "");
  const jupiterBaseUrl = (options.jupiterBaseUrl ?? JUPITER_PRICE_BASE_URL_DEFAULT).replace(/\/$/, "");
  const geckoterminalBaseUrl = (options.geckoterminalBaseUrl ?? GECKOTERMINAL_BASE_URL_DEFAULT).replace(/\/$/, "");

  const quotes = new Map<string, BatchQuote>();
  const problems: string[] = [];
  const sourcesUsed: string[] = [];
  const divergences: DivergenceFinding[] = [];
  const verification: BatchVerification = { attempted: false, source: null, checked: 0, problems: [] };
  const book = options.sampleBook;
  const thresholds = options.divergenceThresholds ?? DEFAULT_DIVERGENCE_THRESHOLDS;
  let requests = 0;

  const wanted = [...new Set(mints.filter(isQueryableMint))];
  if (wanted.length === 0) {
    return {
      quotes,
      requests,
      problems: ["nenhum mint consultável na lista (vazio ou com endereços de mock)"],
      sourcesUsed,
      divergences,
      verification,
    };
  }

  const missing = (): string[] => wanted.filter((m) => quotes.get(m)?.priceSol == null);

  /**
   * Compara com a outra fonte (se houver) e registra a amostra. Preço ausente não é amostra:
   * `null` nunca entra no livro, senão "sem dado" viraria "preço concordante".
   */
  const ingest = (found: Map<string, BatchQuote>): void => {
    for (const q of found.values()) {
      if (q.priceSol === null || !(q.priceSol > 0)) continue;
      if (book) {
        const finding = assessDivergence(q.mint, { source: q.source, priceSol: q.priceSol }, book, thresholds);
        if (finding && finding.severity !== "ok") divergences.push(finding);
        book.record({ mint: q.mint, source: q.source, priceSol: q.priceSol, at: q.fetchedAt });
      }
    }
  };

  /**
   * NUNCA lança. Uma exceção de rede aqui não pode derrubar o gerenciador de posições nem o
   * script de diagnóstico (foi exatamente o que aconteceu na primeira execução do `free:check`
   * neste sandbox sem egress: o erro propagou e matou o processo inteiro). Falha vira
   * `ok:false` com o motivo, e a cascata segue para a próxima fonte.
   */
  const getJson = async (
    url: string,
    headers: Record<string, string> = {}
  ): Promise<{ ok: boolean; status: number; body: any; error: string | null }> => {
    requests++;
    try {
      const res = await doFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { ok: false, status: res.status, body: null, error: null };
      const body = await res.json().catch(() => null);
      if (body === null) return { ok: false, status: res.status, body: null, error: "resposta não é JSON" };
      return { ok: true, status: res.status, body, error: null };
    } catch (err: any) {
      const msg = err?.name === "TimeoutError" ? `timeout de ${timeoutMs}ms` : (err?.message ?? String(err));
      return { ok: false, status: 0, body: null, error: msg };
    }
  };

  /** Mensagem de problema padronizada para as três fontes. */
  const describeFailure = (fonte: string, r: { status: number; error: string | null }, size: number): string =>
    r.error !== null
      ? `${fonte}: falha de rede no lote de ${size} (${r.error})`
      : `${fonte}: HTTP ${r.status} no lote de ${size}`;

  /**
   * DexScreener — também é a única fonte de LIQUIDEZ, então roda sempre (para os que faltam).
   *
   * O wrapped SOL entra na lista de endereços: o preço dele no próprio payload é a âncora
   * USD→SOL usada para tokens cujo par mais líquido NÃO é cotado em SOL (ex.: TOKEN/USDC). Isso
   * não custa requisição extra — o endpoint aceita até 30 endereços por chamada.
   */
  const dexscreenerFetch = async (): Promise<Map<string, BatchQuote>> => {
    const found = new Map<string, BatchQuote>();
    const alvos = [...new Set([...(missing().length > 0 ? missing() : wanted), SOL_MINT])];
    for (const batch of chunk(alvos, DEXSCREENER_MAX_ADDRESSES_PER_CALL)) {
      const url = `${dexscreenerBaseUrl}/tokens/${batch.join(",")}`;
      const r = await getJson(url);
      if (!r.ok) {
        problems.push(describeFailure("dexscreener", r, batch.length));
        continue;
      }
      for (const [mint, q] of parseDexScreenerBatch(r.body, now(), options.solUsdFallback ?? null)) found.set(mint, q);
    }
    return found;
  };

  const dexRun = await runProvider(options.dexscreenerBudget, options, dexscreenerFetch);
  if (dexRun.skipped) {
    problems.push(`dexscreener: PULADO — ${dexRun.skipped.skippedReason}`);
  } else {
    for (const [mint, q] of dexRun.quotes) quotes.set(mint, q);
    ingest(dexRun.quotes);
    if (dexRun.quotes.size > 0) sourcesUsed.push("dexscreener");
  }

  /** Jupiter Price v3 — só para o que ainda não tem preço. */
  let jupiterAttempted = false;
  if (missing().length > 0) {
    jupiterAttempted = true;
    const jupiterFetch = async (): Promise<Map<string, BatchQuote>> => {
      const found = new Map<string, BatchQuote>();
      // O SOL entra no lote para a conversão USD→SOL vir da MESMA resposta.
      const ids = [...new Set([...missing(), SOL_MINT])];
      for (const batch of chunk(ids, JUPITER_MAX_IDS_PER_CALL)) {
        const url = `${jupiterBaseUrl}/price/v3?ids=${batch.join(",")}`;
        const headers: Record<string, string> = {};
        if (options.jupiterApiKey) headers["x-api-key"] = options.jupiterApiKey;
        const r = await getJson(url, headers);
        if (!r.ok) {
          problems.push(describeFailure("jupiter price v3", r, batch.length));
          continue;
        }
        const parsed = parseJupiterPriceBatch(r.body, now(), options.solUsdFallback ?? null);
        for (const [mint, q] of parsed.quotes) found.set(mint, q);
      }
      return found;
    };
    const jupRun = await runProvider(options.jupiterBudget, options, jupiterFetch);
    if (jupRun.skipped) {
      problems.push(`jupiter price v3: PULADO — ${jupRun.skipped.skippedReason}`);
    } else {
      for (const [mint, q] of jupRun.quotes) quotes.set(mint, q);
      ingest(jupRun.quotes);
      if (jupRun.quotes.size > 0) sourcesUsed.push("jupiter-price-v3");
    }
  }

  /** GeckoTerminal — terceira opinião independente. */
  let geckoterminalAttempted = false;
  if (missing().length > 0) {
    geckoterminalAttempted = true;
    const geckoFetch = async (): Promise<Map<string, BatchQuote>> => {
      const found = new Map<string, BatchQuote>();
      const ids = [...new Set([...missing(), SOL_MINT])];
      for (const batch of chunk(ids, GECKOTERMINAL_MAX_ADDRESSES_PER_CALL)) {
        const url = `${geckoterminalBaseUrl}/simple/networks/solana/token_price/${batch.join(",")}`;
        const r = await getJson(url, { accept: "application/json" });
        if (!r.ok) {
          problems.push(describeFailure("geckoterminal", r, batch.length));
          continue;
        }
        const parsed = parseGeckoTerminalBatch(r.body, now(), options.solUsdFallback ?? null);
        for (const [mint, q] of parsed.quotes) found.set(mint, q);
      }
      return found;
    };
    const geckoRun = await runProvider(options.geckoterminalBudget, options, geckoFetch);
    if (geckoRun.skipped) {
      problems.push(`geckoterminal: PULADO — ${geckoRun.skipped.skippedReason}`);
    } else {
      for (const [mint, q] of geckoRun.quotes) quotes.set(mint, q);
      ingest(geckoRun.quotes);
      if (geckoRun.quotes.size > 0) sourcesUsed.push("geckoterminal");
    }
  }

  /* ------------------------------------------------------------------------- */
  /* VERIFICAÇÃO CRUZADA — a segunda opinião que a cascata sozinha não produz    */
  /* ------------------------------------------------------------------------- */

  /**
   * A cascata para assim que todos têm preço — ótimo para cota e péssimo para AUDITORIA: se o
   * DexScreener responde tudo, nunca existe segunda fonte para comparar. Aqui pedimos uma
   * segunda opinião para uma AMOSTRA pequena de tokens (`verifyMints`), sempre na primeira
   * fonte que ainda NÃO respondeu neste ciclo. Custo máximo: 1 requisição extra por chamada.
   *
   * Se a amostra não tem nenhum token já precificado, não há o que verificar (cada fonte seria
   * apenas mais uma tentativa de achar preço) — a verificação é pulada e o motivo fica visível.
   */
  const verifyTargets = [...new Set((options.verifyMints ?? []).filter(isQueryableMint))].filter(
    (m) => (quotes.get(m)?.priceSol ?? null) !== null
  );
  if (verifyTargets.length > 0) {
    const verifySource: "jupiter" | "geckoterminal" | null = !jupiterAttempted
      ? "jupiter"
      : !geckoterminalAttempted
        ? "geckoterminal"
        : null;

    if (verifySource === null) {
      verification.problems.push(
        `verificação não feita: as três fontes já foram tentadas neste ciclo (amostra de ${verifyTargets.length} token(s))`
      );
    } else {
      verification.attempted = true;
      verification.source = verifySource === "jupiter" ? "jupiter-price-v3" : "geckoterminal";

      const verifyFetch = async (): Promise<Map<string, BatchQuote>> => {
        const found = new Map<string, BatchQuote>();
        const ids = [...new Set([...verifyTargets, SOL_MINT])];
        for (const batch of chunk(ids, verifySource === "jupiter" ? JUPITER_MAX_IDS_PER_CALL : GECKOTERMINAL_MAX_ADDRESSES_PER_CALL)) {
          const url =
            verifySource === "jupiter"
              ? `${jupiterBaseUrl}/price/v3?ids=${batch.join(",")}`
              : `${geckoterminalBaseUrl}/simple/networks/solana/token_price/${batch.join(",")}`;
          const headers: Record<string, string> = verifySource === "jupiter" ? {} : { accept: "application/json" };
          if (verifySource === "jupiter" && options.jupiterApiKey) headers["x-api-key"] = options.jupiterApiKey;
          const r = await getJson(url, headers);
          if (!r.ok) {
            const msg = describeFailure(verification.source ?? verifySource, r, batch.length);
            verification.problems.push(msg);
            problems.push(`${msg} (verificação cruzada)`);
            continue;
          }
          const parsed =
            verifySource === "jupiter"
              ? parseJupiterPriceBatch(r.body, now(), options.solUsdFallback ?? null).quotes
              : parseGeckoTerminalBatch(r.body, now(), options.solUsdFallback ?? null).quotes;
          for (const [mint, q] of parsed) found.set(mint, q);
        }
        return found;
      };

      const verifyBudget = verifySource === "jupiter" ? options.jupiterBudget : options.geckoterminalBudget;
      const verifyRun = await runProvider(
        verifyBudget,
        { ...options, priority: options.verificationPriority ?? "background" },
        verifyFetch
      );
      if (verifyRun.skipped) {
        const msg = `${verification.source}: verificação cruzada PULADA — ${verifyRun.skipped.skippedReason}`;
        verification.problems.push(msg);
        problems.push(msg);
      } else {
        for (const target of verifyTargets) {
          const candidato = verifyRun.quotes.get(target);
          const referencia = quotes.get(target);
          if (!candidato || candidato.priceSol === null || !(candidato.priceSol > 0)) continue;
          if (!referencia || referencia.priceSol === null) continue;

          verification.checked++;
          const finding = compareSamples(
            target,
            { source: referencia.source, priceSol: referencia.priceSol, at: referencia.fetchedAt },
            { source: candidato.source, priceSol: candidato.priceSol },
            thresholds,
            now()
          );
          if (finding && finding.severity !== "ok") divergences.push(finding);
          if (book) book.record({ mint: target, source: candidato.source, priceSol: candidato.priceSol, at: candidato.fetchedAt });
        }
      }
    }
  }

  const aindaSemPreco = missing();
  if (aindaSemPreco.length > 0) {
    problems.push(
      `${aindaSemPreco.length} mint(s) sem preço em nenhuma fonte: ` +
        `${aindaSemPreco.slice(0, 3).map((m) => m.slice(0, 6)).join(", ")}${aindaSemPreco.length > 3 ? "…" : ""}`
    );
  }

  return { quotes, requests, problems, sourcesUsed, divergences, verification };
}
