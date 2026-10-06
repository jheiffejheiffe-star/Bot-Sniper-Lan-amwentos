/**
 * ORÇAMENTO DE COTA — operar no gratuito sem quebrar no pior momento.
 *
 * ## O que faz
 *
 * Controla quantas chamadas externas o bot faz por provedor dentro de uma janela, usando os
 * limites PUBLICADOS de cada camada gratuita (RPC, DexScreener, Jupiter, Jito). Sem isso, num
 * plano grátis o bot gasta a cota em polling de fundo e recebe `429` exatamente quando um
 * lançamento aparece — ou seja, o defeito se manifesta na única hora que importa.
 *
 * ## Como funciona
 *
 * - `RateBudget` é uma janela deslizante de verdade: guarda o instante das aquisições ACEITAS
 *   e descarta as que saíram da janela. `tryAcquire()` responde na hora (sem `await`), portanto
 *   serve para o caminho quente.
 * - `withBudget()` envolve uma chamada de rede: se não houver cota, espera no máximo
 *   `maxWaitMs` (curto) e, se ainda não houver, **pula a chamada e conta o pulo** — pular com
 *   número é melhor do que estourar a cota em silêncio.
 * - **Exceção deliberada e documentada:** chamadas de SAÍDA (`priority: "exit"`) nunca são
 *   bloqueadas por orçamento. Reduzir risco não pode depender de cota; o bypass é CONTADO
 *   (`bypassed`) para o operador ver que a cota foi excedida e por quê.
 * - Chamadas de FUNDO (medição de RTT dos nós, tip floor quando ninguém está operando)
 *   desistem na primeira negativa: elas cedem a cota para o caminho quente.
 *
 * ## Dependências
 *
 * Nenhuma. TypeScript puro, sem rede, sem `@solana/web3.js`, relógio injetável (`now`) e
 * `sleep` injetável — é por isso que o teste consegue exercitar janela de 60 s em microssegundos.
 *
 * ## Riscos e limites
 *
 * - Os limites de cada perfil são os PUBLICADOS pelo provedor na data registrada em `source`.
 *   Provedor muda limite sem avisar: se aparecer `429` com os contadores dentro do limite, o
 *   perfil está desatualizado — o lugar de corrigir é o preset, não o call site.
 * - Isto NÃO é controle de gasto em plano pago: em plano pago o excesso vira fatura. Aqui o
 *   objetivo é não perder o lançamento por `429` em plano gratuito.
 * - O orçamento é por PROCESSO. Rodar dois processos com a mesma chave consome a mesma cota do
 *   provedor e o limite dobra de fato — por isso o padrão é um processo só (ver `GRATIS.md`).
 *
 * ## Como testar
 *
 * `npm run test` — grupo [17]: janela deslizante, custo por chamada, espera máxima, pulo
 * contabilizado, bypass de saída e saneamento de parâmetros.
 *
 * ## Como colocar em produção
 *
 * `HFT_RPC_PROFILE` escolhe o perfil (helius|alchemy|quicknode|syndica|public). Comece em
 * `public` e suba para o perfil do provedor no dia em que a chave entrar. Os contadores saem em
 * `GET /api/system-truth → budgets` e `GET /api/health → budgets.resumo`.
 */

export interface BudgetSpec {
  /** Identificador curto usado nos contadores e no endpoint (ex.: "dexscreener"). */
  name: string;
  /** Máximo de aquisições aceitas dentro da janela. */
  limit: number;
  windowMs: number;
  /** Custo por chamada (APIs que cobram por peso, ex.: Alchemy: getTransaction = 4x leitura). */
  cost?: number;
  /** DE ONDE veio este número — documentação do provedor, com data. Nunca "achismo". */
  source: string;
}

export interface BudgetSnapshot extends BudgetSpec {
  used: number;
  remaining: number;
  /** Espera até liberar uma vaga (0 = livre agora). */
  waitMs: number;
  accepted: number;
  rejected: number;
  skipped: number;
  bypassed: number;
  /** Soma do tempo efetivamente esperado por cota (ms). */
  waitedMs: number;
}

const DEFAULT_COST = 1;

/**
 * Janela deslizante com relógio injetável.
 *
 * Complexidade: `tryAcquire` é O(nº de aquisições na janela) porque descarta do início do
 * array. Com `limit` de algumas centenas e janela de 1 minuto, o custo é irrelevante — e a
 * alternativa (contadores por bucket) gasta memória sem resolver nada aqui.
 */
export class RateBudget {
  private stamps: number[] = [];
  public accepted = 0;
  public rejected = 0;
  public skipped = 0;
  public bypassed = 0;
  public waitedMs = 0;

  constructor(
    public readonly spec: BudgetSpec,
    private readonly now: () => number = () => Date.now()
  ) {
    if (!Number.isFinite(spec.limit) || spec.limit <= 0) {
      throw new Error(`RateBudget("${spec.name}"): limit precisa ser > 0 (recebido ${spec.limit})`);
    }
    if (!Number.isFinite(spec.windowMs) || spec.windowMs <= 0) {
      throw new Error(`RateBudget("${spec.name}"): windowMs precisa ser > 0 (recebido ${spec.windowMs})`);
    }
  }

  private get costPerCall(): number {
    const c = this.spec.cost ?? DEFAULT_COST;
    return Number.isFinite(c) && c > 0 ? c : DEFAULT_COST;
  }

  /** Descarta aquisições fora da janela. */
  private prune(now: number): void {
    const cutoff = now - this.spec.windowMs;
    let drop = 0;
    while (drop < this.stamps.length && this.stamps[drop] <= cutoff) drop++;
    if (drop > 0) this.stamps.splice(0, drop);
  }

  /** Quantas chamadas estão na janela agora (usa o relógio real). */
  public used(): number {
    const now = this.now();
    this.prune(now);
    return this.stamps.length;
  }

  /** Tenta reservar cota. Nunca espera. */
  public tryAcquire(cost: number = this.costPerCall): boolean {
    const now = this.now();
    this.prune(now);
    const c = Number.isFinite(cost) && cost > 0 ? cost : DEFAULT_COST;
    if (this.stamps.length + c > this.spec.limit) {
      this.rejected++;
      return false;
    }
    // Uma aquisição custa `c` "vagas": registra o mesmo instante `c` vezes.
    for (let i = 0; i < c; i++) this.stamps.push(now);
    this.accepted++;
    return true;
  }

  /** Espera necessária para caber UMA chamada de custo padrão. 0 = agora. */
  public waitMsUntilNextSlot(cost: number = this.costPerCall): number {
    const now = this.now();
    this.prune(now);
    const c = Number.isFinite(cost) && cost > 0 ? cost : DEFAULT_COST;
    if (this.stamps.length + c <= this.spec.limit) return 0;
    // Precisa sair (stamps.length + c - limit) aquisições: a que sai mais tarde define a espera.
    const need = this.stamps.length + c - this.spec.limit;
    const idx = Math.min(need - 1, this.stamps.length - 1);
    if (idx < 0) return 0;
    const oldest = this.stamps[idx];
    return Math.max(0, this.spec.windowMs - (now - oldest));
  }

  public snapshot(): BudgetSnapshot {
    const now = this.now();
    this.prune(now);
    const used = this.stamps.length;
    return {
      ...this.spec,
      used,
      remaining: Math.max(0, this.spec.limit - used),
      waitMs: this.waitMsUntilNextSlot(),
      accepted: this.accepted,
      rejected: this.rejected,
      skipped: this.skipped,
      bypassed: this.bypassed,
      waitedMs: this.waitedMs,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* PRESETS DAS CAMADAS GRATUITAS                                              */
/* -------------------------------------------------------------------------- */

export type RpcProfileName = "public" | "helius" | "alchemy" | "quicknode" | "syndica";

/**
 * Perfis de RPC gratuito.
 *
 * ATENÇÃO ao que estes números significam: são o teto PUBLICADO do plano gratuito, não uma
 * promessa de latência. `public` (api.mainnet-beta.solana.com) é deliberadamente conservador:
 * o endpoint público é compartilhado e não tem SLA; medir antes de confiar.
 */
export const RPC_PROFILES: Record<RpcProfileName, BudgetSpec> = {
  public: {
    name: "rpc",
    limit: 8,
    windowMs: 1000,
    source:
      "endpoint público (api.mainnet-beta.solana.com): compartilhado, sem SLA e sem garantia de " +
      "envio — teto conservador por processo, medir com `npm run free:check`",
  },
  helius: {
    name: "rpc",
    limit: 10,
    windowMs: 1000,
    source: "Helius Free: 1M créditos/mês, 10 req/s (sendTransaction: 1/s) — docs do provedor",
  },
  alchemy: {
    name: "rpc",
    limit: 25,
    windowMs: 1000,
    source: "Alchemy Free: 30M CU/mês, 25 req/s (getTransaction custa 4x uma leitura simples)",
  },
  quicknode: {
    name: "rpc",
    limit: 15,
    windowMs: 1000,
    source: "QuickNode Free: 10M créditos/mês, ~15 req/s (varia por fonte publicada — validar)",
  },
  syndica: {
    name: "rpc",
    limit: 100,
    windowMs: 1000,
    source: "Syndica Free: 10M req/mês, até 100 req/s (o maior teto gratuito de leitura)",
  },
};

/** APIs de mercado gratuitas usadas no caminho de preço/decisão. */
export const MARKET_BUDGET_SPECS = {
  dexscreener: {
    name: "dexscreener",
    limit: 300,
    windowMs: 60_000,
    source: "DexScreener API pública: 300 req/min (pairs/tokens/search) — 60 req/min em profiles/boosts",
  } as BudgetSpec,
  jupiter: {
    name: "jupiter",
    limit: 60,
    windowMs: 60_000,
    source: "Jupiter API Free: 60 req/min por ORGANIZAÇÃO (≈1 req/s) — criar mais chaves não aumenta o limite",
  } as BudgetSpec,
  geckoterminal: {
    name: "geckoterminal",
    limit: 30,
    windowMs: 60_000,
    source:
      "GeckoTerminal API pública (beta, grátis e sem chave): 30 chamadas/min — aceita até 30 " +
      "endereços por chamada no endpoint token_price",
  } as BudgetSpec,
  rugcheck: {
    name: "rugcheck",
    limit: 5,
    windowMs: 60_000,
    source:
      "RugCheck API gratuita; teto prático relatado por terceiros ~5 req/min — evidência " +
      "ADICIONAL: não pode virar gargalo do caminho quente",
  } as BudgetSpec,
  jitoTipFloor: {
    name: "jito-tip-floor",
    limit: 1,
    windowMs: 1000,
    source: "Jito: 1 requisição/segundo por IP por região (block engine e REST do tip floor)",
  } as BudgetSpec,
  jitoBlockEngine: {
    name: "jito-block-engine",
    limit: 1,
    windowMs: 1000,
    source: "Jito: 1 requisição/segundo por IP por região",
  } as BudgetSpec,
} as const;

export interface BudgetRegistry {
  rpc: RateBudget;
  dexscreener: RateBudget;
  jupiter: RateBudget;
  geckoterminal: RateBudget;
  rugcheck: RateBudget;
  jitoTipFloor: RateBudget;
  jitoBlockEngine: RateBudget;
  snapshot(): BudgetSnapshot[];
  resumo(): Record<string, { used: number; limit: number; janelaMs: number; skipped: number; bypassed: number; perfil: string }>;
}

export interface BuildBudgetOptions {
  rpcProfile?: string;
  disabled?: boolean;
  now?: () => number;
}

/**
 * Monta o registro de orçamentos do processo.
 *
 * `disabled` (env `HFT_BUDGET_DISABLED=1`) existe para UM caso: diagnosticar se o orçamento é
 * a causa de um comportamento estranho. Desligar em produção é trocar uma falha previsível
 * (sinal pulado e contado) por uma imprevisível (429 no meio do lançamento) — por isso o
 * endpoint informa quando está desligado.
 */
export function buildBudgetRegistry(options: BuildBudgetOptions = {}): BudgetRegistry {
  const profileName = (options.rpcProfile || "public").toLowerCase() as RpcProfileName;
  const profile = RPC_PROFILES[profileName] ?? RPC_PROFILES.public;
  const now = options.now ?? (() => Date.now());
  const disabled = options.disabled === true;

  // Com o orçamento desligado, o "limite" é efetivamente infinito — mas continua contando
  // (`accepted`), para o operador saber o volume real que passou pelo processo.
  const effective = (spec: BudgetSpec): BudgetSpec =>
    disabled ? { ...spec, limit: Number.MAX_SAFE_INTEGER, source: `${spec.source} [ORÇAMENTO DESLIGADO]` } : spec;

  const rpc = new RateBudget(effective(profile), now);
  const dexscreener = new RateBudget(effective(MARKET_BUDGET_SPECS.dexscreener), now);
  const jupiter = new RateBudget(effective(MARKET_BUDGET_SPECS.jupiter), now);
  const geckoterminal = new RateBudget(effective(MARKET_BUDGET_SPECS.geckoterminal), now);
  const rugcheck = new RateBudget(effective(MARKET_BUDGET_SPECS.rugcheck), now);
  const jitoTipFloor = new RateBudget(effective(MARKET_BUDGET_SPECS.jitoTipFloor), now);
  const jitoBlockEngine = new RateBudget(effective(MARKET_BUDGET_SPECS.jitoBlockEngine), now);

  return {
    rpc,
    dexscreener,
    jupiter,
    geckoterminal,
    rugcheck,
    jitoTipFloor,
    jitoBlockEngine,
    snapshot: () =>
      [rpc, dexscreener, jupiter, geckoterminal, rugcheck, jitoTipFloor, jitoBlockEngine].map((b) => b.snapshot()),
    resumo: () => {
      const out: Record<string, { used: number; limit: number; janelaMs: number; skipped: number; bypassed: number; perfil: string }> = {};
      for (const b of [rpc, dexscreener, jupiter, geckoterminal, rugcheck, jitoTipFloor, jitoBlockEngine]) {
        out[b.spec.name] = {
          used: b.used(),
          limit: b.spec.limit,
          janelaMs: b.spec.windowMs,
          skipped: b.skipped,
          bypassed: b.bypassed,
          perfil: profileName,
        };
      }
      return out;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* ENVOLVIMENTO DE CHAMADAS DE REDE                                           */
/* -------------------------------------------------------------------------- */

export interface WithBudgetOptions {
  /** Espera máxima antes de desistir (padrão: 0 = não espera). */
  maxWaitMs?: number;
  /**
   * `exit` = chamada que REDUZ risco (fechar posição, cotar saída). Nunca é bloqueada por
   * cota: o bypass é contado.
   */
  priority?: "normal" | "exit" | "background";
  sleep?: (ms: number) => Promise<void>;
  /** Custo da chamada (padrão: custo do orçamento). */
  cost?: number;
}

export interface BudgetOutcome<T> {
  /** A chamada foi executada? */
  ok: boolean;
  value?: T;
  /** Quando `ok=false`: por que a chamada NÃO foi feita. */
  skippedReason?: string;
  /** true quando executou mesmo sem cota (somente `exit`). */
  bypassed?: boolean;
}

/**
 * Executa `fn` respeitando o orçamento.
 *
 * Regra de prioridade (e é uma decisão de RISCO, não de estilo):
 *   1. `exit`       — executa sempre; sem cota, executa assim mesmo e marca `bypassed`.
 *   2. `normal`     — espera até `maxWaitMs`; sem cota após a espera, PULA e conta `skipped`.
 *   3. `background` — não espera nada; sem cota, pula e conta `skipped`.
 */
export async function withBudget<T>(
  budget: RateBudget,
  fn: () => Promise<T>,
  options: WithBudgetOptions = {}
): Promise<BudgetOutcome<T>> {
  const priority = options.priority ?? "normal";
  const cost = options.cost ?? budget.spec.cost ?? DEFAULT_COST;

  if (budget.tryAcquire(cost)) {
    return { ok: true, value: await fn() };
  }

  if (priority === "exit") {
    budget.bypassed++;
    return { ok: true, value: await fn(), bypassed: true };
  }

  const maxWaitMs = priority === "background" ? 0 : Math.max(0, options.maxWaitMs ?? 0);
  if (maxWaitMs > 0) {
    const waitMs = budget.waitMsUntilNextSlot(cost);
    if (waitMs > 0 && waitMs <= maxWaitMs) {
      const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      budget.waitedMs += waitMs;
      await sleep(waitMs);
      if (budget.tryAcquire(cost)) {
        return { ok: true, value: await fn() };
      }
    }
  }

  budget.skipped++;
  return {
    ok: false,
    skippedReason:
      `cota de "${budget.spec.name}" esgotada (${budget.spec.limit}/${budget.spec.windowMs}ms) e ` +
      `a prioridade é ${priority}: chamada PULADA e contabilizada em vez de arriscar 429`,
  };
}
