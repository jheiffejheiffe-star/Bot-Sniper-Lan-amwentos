/**
 * RUGCHECK — evidência EXTERNA de risco de token (camada gratuita).
 *
 * ## O que faz
 *
 * Consulta `https://api.rugcheck.xyz/v1/tokens/{mint}/report` e transforma o relatório em uma
 * evidência COMPACTA para o filtro profundo: score de risco, lista de riscos, LP travado/queimado
 * e situação das autoridades. É um segundo par de olhos — não substitui a verificação on-chain
 * que o próprio bot faz (mint/freeze authority, holders, Token-2022).
 *
 * ## Regra de ouro (a razão de existir deste módulo ser tão restritivo)
 *
 * **O RugCheck só pode ENDURECER a decisão, nunca amolecer.** Se ele disser "ok", o veredito
 * continua sendo o das checagens on-chain locais; se ele disser "perigo", isso entra como risco.
 * E se ele NÃO responder, isso é registrado como verificação AUSENTE — jamais como aprovação.
 *
 * ## Contrato e limites (o que é verificado e o que é suposição declarada)
 *
 * - Endpoint e formato geral (JSON com `score`, `risks[]`, `markets[]`) são os publicamente
 *   usados pela comunidade; o parser é DEFENSIVO porque o provedor não publica um schema
 *   versionado: campo ausente vira `null`, nunca valor otimista.
 * - O provedor oferece acesso gratuito; o limite prático relatado por terceiros é baixo
 *   (~5 req/min). Por isso o orçamento default é conservador e a checagem é **opcional**:
 *   ela não pode virar gargalo do caminho quente.
 * - Nada aqui assina, envia ou gasta. Só leitura.
 *
 * ## Como testar
 *
 * `npm run test` — grupo [19]: parser com payloads reais/vazios/malformados, timeouts,
 * orçamento e a regra "nunca amolece" (aprovar externo não altera veredito local).
 *
 * ## Como colocar em produção
 *
 * `HFT_RUGCHECK=0` desliga. A latência entra em `evidence` e nos contadores do health.
 */

import { MARKET_BUDGET_SPECS, RateBudget, withBudget } from "./rateBudget.js";

export const RUGCHECK_BASE_URL = "https://api.rugcheck.xyz/v1";

/**
 * Limite conservador: o provedor é gratuito, mas o teto prático relatado é ~5 req/min.
 * A definição vive em `rateBudget.ts` (fonte única dos tetos) e é reexportada aqui por clareza.
 */
export const RUGCHECK_BUDGET_SPEC = MARKET_BUDGET_SPECS.rugcheck;

export interface RugCheckRisk {
  name: string;
  level: string | null;
  score: number | null;
  description: string | null;
}

export interface RugCheckEvidence {
  available: boolean;
  /** Motivo quando `available=false` — sempre preenchido, nunca silencioso. */
  reason: string | null;
  score: number | null;
  /** "danger" | "warn" | "info" | null — classificação quando o provedor informa. */
  scoreLevel: string | null;
  risks: RugCheckRisk[];
  /** Riscos que o provedor classifica como perigosos (nome preservado). */
  dangerNames: string[];
  lpLockedPct: number | null;
  lpLockedUsd: number | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  totalHolders: number | null;
  latencyMs: number | null;
  source: "rugcheck";
}

function finiteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Parser puro do relatório. Nunca lança: relatório inesperado vira `available: false` com
 * motivo — o chamador decide o que fazer com a ausência (o bot registra o check como faltante).
 */
export function parseRugCheckReport(raw: unknown, latencyMs: number | null = null): RugCheckEvidence {
  const base: RugCheckEvidence = {
    available: false,
    reason: null,
    score: null,
    scoreLevel: null,
    risks: [],
    dangerNames: [],
    lpLockedPct: null,
    lpLockedUsd: null,
    mintAuthority: null,
    freezeAuthority: null,
    totalHolders: null,
    latencyMs,
    source: "rugcheck",
  };

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...base, reason: "relatório não é objeto JSON" };
  }
  const r = raw as Record<string, any>;

  const risks: RugCheckRisk[] = Array.isArray(r.risks)
    ? r.risks
        .filter((x: any) => x && typeof x === "object")
        .map((x: any) => ({
          name: str(x.name) ?? "risco sem nome",
          level: str(x.level),
          score: finiteNumber(x.score),
          description: str(x.description),
        }))
    : [];

  const dangerNames = risks
    .filter((x) => (x.level ?? "").toLowerCase() === "danger")
    .map((x) => x.name);

  // LP: o provedor agrupa mercados; pegamos o MAIOR `lpLockedUSD` — o pool que importa.
  let lpLockedPct: number | null = null;
  let lpLockedUsd: number | null = null;
  if (Array.isArray(r.markets)) {
    for (const m of r.markets) {
      if (!m || typeof m !== "object") continue;
      const lp = (m as any).lp ?? {};
      const pct = finiteNumber(lp.lpLockedPct);
      const usd = finiteNumber(lp.lpLockedUSD);
      if (usd !== null && (lpLockedUsd === null || usd > lpLockedUsd)) {
        lpLockedUsd = usd;
        lpLockedPct = pct;
      } else if (usd === null && pct !== null && lpLockedPct === null) {
        lpLockedPct = pct;
      }
    }
  }

  const score = finiteNumber(r.score);
  /**
   * "Disponível" = o provedor reconheceu o token e devolveu ALGUM campo nosso. Um relatório com
   * só `totalHolders` já é utilizável (sabemos que o provedor tem o token indexado); um objeto
   * vazio/desconhecido NÃO é tratado como disponível — e indisponível nunca significa aprovado.
   */
  const hasAnything =
    score !== null ||
    risks.length > 0 ||
    lpLockedUsd !== null ||
    lpLockedPct !== null ||
    r.mintAuthority !== undefined ||
    r.freezeAuthority !== undefined ||
    r.totalHolders !== undefined ||
    r.score_level !== undefined ||
    r.scoreLevel !== undefined;

  return {
    ...base,
    available: hasAnything,
    reason: hasAnything ? null : "relatório sem nenhum campo reconhecível",
    score,
    scoreLevel: str(r.score_level) ?? str(r.scoreLevel),
    risks,
    dangerNames,
    lpLockedPct,
    lpLockedUsd,
    mintAuthority: str(r.mintAuthority),
    freezeAuthority: str(r.freezeAuthority),
    totalHolders: finiteNumber(r.totalHolders),
  };
}

export interface FetchRugCheckOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
  budget?: RateBudget;
  /** Espera máxima por cota (padrão 0: evidência ADICIONAL não pode atrasar a decisão). */
  maxWaitMs?: number;
  now?: () => number;
}

/**
 * Busca + parseia o relatório. NUNCA lança e NUNCA espera por cota além de `maxWaitMs`:
 * ausência de evidência é registrada como ausência — o chamador decide (e, no caminho LIVE, a
 * política de filtro incompleto já veta por conta própria).
 */
export async function fetchRugCheckEvidence(
  mint: string,
  options: FetchRugCheckOptions = {}
): Promise<RugCheckEvidence> {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? RUGCHECK_BASE_URL).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 3_500;
  const now = options.now ?? (() => Date.now());
  const url = `${baseUrl}/tokens/${encodeURIComponent(mint)}/report`;

  /** Indisponibilidade é um RESULTADO legítimo — registrada com motivo, nunca silenciada. */
  const unavailable = (reason: string, latencyMs: number | null = null): RugCheckEvidence => ({
    ...parseRugCheckReport(null, latencyMs),
    reason,
  });

  const call = async (): Promise<RugCheckEvidence> => {
    const t0 = now();
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const latencyMs = now() - t0;
      if (!res.ok) {
        return unavailable(`HTTP ${res.status}`, latencyMs);
      }
      const body = await res.json().catch(() => null);
      if (body === null) return unavailable("resposta não é JSON", latencyMs);
      return parseRugCheckReport(body, latencyMs);
    } catch (err: any) {
      return unavailable(`falha na consulta: ${err?.message ?? err}`, now() - t0);
    }
  };

  if (!options.budget) return call();

  const outcome = await withBudget(options.budget, call, {
    maxWaitMs: options.maxWaitMs ?? 0,
    priority: "normal",
  });
  if (!outcome.ok) {
    return unavailable(outcome.skippedReason ?? "bloqueado por orçamento de cota");
  }
  return outcome.value as RugCheckEvidence;
}

/**
 * Traduz a evidência externa em RISCO para o filtro profundo — apenas na direção de endurecer.
 *
 * Devolve a lista de motivos de risco (vazia quando não há nada de preocupante) e se a evidência
 * é utilizável. **Nunca** devolve "aprovação": ausência de risco externo não é atestado de
 * segurança, e o veredito continua sendo o das checagens on-chain.
 */
export function rugCheckRiskReasons(evidence: RugCheckEvidence): {
  usable: boolean;
  reasons: string[];
} {
  if (!evidence.available) {
    return { usable: false, reasons: [] };
  }
  const reasons: string[] = [];

  for (const name of evidence.dangerNames) {
    reasons.push(`RugCheck: risco classificado como PERIGO — ${name}`);
  }

  // Score do provedor: quanto MAIOR, pior (escala pública do RugCheck). O limiar é
  // deliberadamente conservador: só entra como risco quando o número é claramente alto.
  if (evidence.score !== null && evidence.score >= 700) {
    reasons.push(`RugCheck: score de risco ${Math.round(evidence.score)} (alto)`);
  } else if (evidence.score !== null && evidence.score >= 500) {
    reasons.push(`RugCheck: score de risco ${Math.round(evidence.score)} (moderado)`);
  }

  if (evidence.freezeAuthority) {
    reasons.push(`RugCheck: freeze authority ativa (${evidence.freezeAuthority.slice(0, 8)}...)`);
  }

  return { usable: true, reasons };
}
