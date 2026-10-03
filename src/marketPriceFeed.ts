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
 *      `priceNative` (preço JÁ em SOL, sem conversão) e `liquidity.usd`.
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
 * DexScreener: escolhe o par Solana de MAIOR LIQUIDEZ por token (não o primeiro da lista —
 * pool raso tem preço que não é preço de mercado) e devolve `priceNative` como preço em SOL.
 */
export function parseDexScreenerBatch(body: unknown, fetchedAt: number): Map<string, BatchQuote> {
  const out = new Map<string, BatchQuote>();
  const pairs = (body as any)?.pairs;
  if (!Array.isArray(pairs)) return out;

  for (const p of pairs) {
    if (!p || typeof p !== "object") continue;
    if ((p as any).chainId !== "solana") continue;
    const mint = (p as any)?.baseToken?.address;
    if (!isQueryableMint(mint)) continue;

    const priceSol = finiteNumber((p as any).priceNative);
    const liquidityUsd = finiteNumber((p as any)?.liquidity?.usd);
    const existing = out.get(mint);

    const better =
      !existing ||
      (liquidityUsd ?? -1) > (existing.liquidityUsd ?? -1) ||
      ((liquidityUsd ?? null) === (existing.liquidityUsd ?? null) && existing.priceSol === null && priceSol !== null);

    if (better) {
      out.set(mint, {
        mint,
        priceSol,
        liquidityUsd,
        source: "dexscreener (lote)",
        fetchedAt,
      });
    }
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
  let requests = 0;

  const wanted = [...new Set(mints.filter(isQueryableMint))];
  if (wanted.length === 0) {
    return { quotes, requests, problems: ["nenhum mint consultável na lista (vazio ou com endereços de mock)"], sourcesUsed };
  }

  const missing = (): string[] => wanted.filter((m) => quotes.get(m)?.priceSol == null);

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

  /** DexScreener — também é a única fonte de LIQUIDEZ, então roda sempre (para os que faltam). */
  const dexscreenerFetch = async (): Promise<Map<string, BatchQuote>> => {
    const found = new Map<string, BatchQuote>();
    for (const batch of chunk(missing().length > 0 ? missing() : wanted, DEXSCREENER_MAX_ADDRESSES_PER_CALL)) {
      const url = `${dexscreenerBaseUrl}/tokens/${batch.join(",")}`;
      const r = await getJson(url);
      if (!r.ok) {
        problems.push(describeFailure("dexscreener", r, batch.length));
        continue;
      }
      for (const [mint, q] of parseDexScreenerBatch(r.body, now())) found.set(mint, q);
    }
    return found;
  };

  const dexRun = await runProvider(options.dexscreenerBudget, options, dexscreenerFetch);
  if (dexRun.skipped) {
    problems.push(`dexscreener: PULADO — ${dexRun.skipped.skippedReason}`);
  } else {
    for (const [mint, q] of dexRun.quotes) quotes.set(mint, q);
    if (dexRun.quotes.size > 0) sourcesUsed.push("dexscreener");
  }

  /** Jupiter Price v3 — só para o que ainda não tem preço. */
  if (missing().length > 0) {
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
      if (jupRun.quotes.size > 0) sourcesUsed.push("jupiter-price-v3");
    }
  }

  /** GeckoTerminal — terceira opinião independente. */
  if (missing().length > 0) {
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
      if (geckoRun.quotes.size > 0) sourcesUsed.push("geckoterminal");
    }
  }

  const aindaSemPreco = missing();
  if (aindaSemPreco.length > 0) {
    problems.push(
      `${aindaSemPreco.length} mint(s) sem preço em nenhuma fonte: ` +
        `${aindaSemPreco.slice(0, 3).map((m) => m.slice(0, 6)).join(", ")}${aindaSemPreco.length > 3 ? "…" : ""}`
    );
  }

  return { quotes, requests, problems, sourcesUsed };
}
