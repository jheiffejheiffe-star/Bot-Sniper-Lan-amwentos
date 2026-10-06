/**
 * COERÊNCIA ENTRE PERFIL DE COTA E ENDPOINT DE RPC.
 *
 * ## O problema que este módulo resolve (aconteceu de verdade)
 *
 * O orçamento de cota (`src/rateBudget.ts`) usa o teto PUBLICADO do provedor escolhido em
 * `HFT_RPC_PROFILE`. O endpoint, porém, vem de `RPC_ENDPOINT` — **variáveis independentes**.
 * Nada impedia a combinação perigosa:
 *
 *     HFT_RPC_PROFILE=syndica        (teto de 100 req/s, plano Syndica)
 *     RPC_ENDPOINT=                  (vazio → endpoint público, ~8 req/s)
 *
 * Efeito: o bot acha que pode 12x mais do que pode e recebe `429` exatamente na janela em que
 * precisa do RPC (segundos após um lançamento). O inverso também custa: perfil `public` com
 * endpoint dedicado faz o bot **se limitar demais** e pular decisões que caberiam na cota.
 * Foi exatamente o que aconteceu com a pré-visualização deste projeto — perfil herdado de uma
 * sessão anterior, endpoint público.
 *
 * ## O que este módulo NÃO faz
 *
 * Não valida chave, não mede latência e não tenta "corrigir" a configuração: ele diz o que
 * conseguiu inferir do HOST e onde a declaração do operador não bate com o que está conectado.
 * Host desconhecido (provedor próprio, proxy corporativo, domínio customizado) **não** é
 * tratado como erro — é tratado como NÃO VERIFICÁVEL, porque bloquear o operador por não
 * conhecer o provedor dele seria pior do que avisar.
 *
 * ## Segurança
 *
 * A chave da API vive na query string da URL (`?api-key=...`). Este módulo **nunca** devolve
 * nem registra a URL completa: apenas `host`. É por isso que a função de extração existe e é
 * a única forma de olhar a URL aqui dentro.
 *
 * ## Dependências
 *
 * Apenas `src/rateBudget.ts` (de onde vêm os nomes de perfil válidos — assim, adicionar um
 * perfil novo lá o torna válido aqui automaticamente).
 *
 * ## Como testar
 *
 * `npm run test` — grupo [23]: inferência por host, endpoint vazio, perfil desconhecido,
 * provedor próprio (não verificável, sem erro), fallback misto e WebSocket de outro provedor.
 */

import { RPC_PROFILES } from "./rateBudget.js";

/** Provedores que este módulo sabe reconhecer pelo host. */
export type RpcProviderKey = "public" | "helius" | "quicknode" | "alchemy" | "syndica" | "unknown";

/** Nomes de perfil aceitos — derivados de `RPC_PROFILES` para não existirem duas listas. */
export const RPC_PROFILE_NAMES = Object.keys(RPC_PROFILES);

/** Endpoint público da Solana: usado quando `RPC_ENDPOINT` está vazio. */
export const PUBLIC_RPC_HOST = "api.mainnet-beta.solana.com";

/**
 * Padrões de host por provedor. São apenas para DIAGNÓSTICO (avisar o operador), nunca para
 * decidir rota, chave ou orçamento — quem decide o orçamento é o perfil declarado.
 */
const PROVIDER_HOST_PATTERNS: Array<{ provider: RpcProviderKey; patterns: RegExp[] }> = [
  { provider: "public", patterns: [/^api\.mainnet-beta\.solana\.com$/i, /^api\.devnet\.solana\.com$/i] },
  { provider: "helius", patterns: [/(^|\.)helius-rpc\.com$/i, /(^|\.)helius\.xyz$/i, /(^|\.)helius\.dev$/i] },
  { provider: "quicknode", patterns: [/(^|\.)quiknode\.pro$/i, /(^|\.)quicknode\.com$/i, /(^|\.)quicknode\.pro$/i] },
  { provider: "alchemy", patterns: [/(^|\.)alchemy\.com$/i, /(^|\.)g\.alchemy\.com$/i, /(^|\.)alchemyapi\.io$/i] },
  { provider: "syndica", patterns: [/(^|\.)syndica\.io$/i] },
];

export interface RpcCoherenceIssue {
  /**
   * `mismatch` = declaração do operador contradiz o que está conectado (bloqueia LIVE).
   * `warn`     = não é possível verificar, ou o efeito é só de eficiência (não bloqueia).
   */
  severity: "warn" | "mismatch";
  code:
    | "perfil-desconhecido"
    | "perfil-nao-bate-endpoint"
    | "perfil-nao-bate-websocket"
    | "perfil-nao-bate-fallback"
    | "endpoint-publico-com-perfil-dedicado"
    | "endpoint-dedicado-com-perfil-publico"
    | "endpoint-ausente"
    | "host-nao-verificavel"
    | "fallback-misto";
  message: string;
}

export interface RpcHostObservation {
  role: "endpoint" | "websocket" | "fallback";
  /** Só o host — jamais a URL completa (a query pode conter chave de API). */
  host: string;
  provider: RpcProviderKey;
}

export interface RpcCoherence {
  declaredProfile: string;
  declaredProfileKnown: boolean;
  /** Perfil efetivo provável a partir do endpoint (quando inferível). */
  inferredFromEndpoint: RpcProviderKey;
  /** `true` quando não há NENHUM mismatch. Warnings não derrubam a coerência. */
  coherent: boolean;
  /** `true` quando o endpoint efetivo é o público padrão (RPC_ENDPOINT vazio). */
  usingPublicDefaultEndpoint: boolean;
  observations: RpcHostObservation[];
  issues: RpcCoherenceIssue[];
}

/** Extrai APENAS o host de uma URL. Inválida devolve string vazia (nunca lança, nunca loga a URL). */
export function hostFromUrl(url: unknown): string {
  if (typeof url !== "string" || url.trim() === "") return "";
  try {
    return new URL(url.trim()).host.toLowerCase();
  } catch {
    return "";
  }
}

/** Inferência por host. Desconhecido NÃO é erro: é "não sei". */
export function inferRpcProvider(url: unknown): RpcProviderKey {
  const host = hostFromUrl(url);
  if (host === "") return "unknown";
  for (const { provider, patterns } of PROVIDER_HOST_PATTERNS) {
    if (patterns.some((p) => p.test(host))) return provider;
  }
  return "unknown";
}

/** Aceita CSV (como vem do env) ou array. */
function toList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export interface RpcCoherenceInput {
  endpoint?: string;
  websocket?: string;
  fallbacks?: string | string[];
  declaredProfile?: string;
  /** Permite injetar a lista de perfis válidos em teste. */
  knownProfiles?: readonly string[];
}

/**
 * Avalia a coerência entre o perfil declarado e os hosts conectados.
 *
 * Regras, em ordem de precedência:
 *   1. perfil fora da lista conhecida → `mismatch` (o orçamento cai em `public` silenciosamente);
 *   2. endpoint vazio → está usando o público padrão; se o perfil declarado não é `public`,
 *      `mismatch` (o teto declarado não tem lastro no endpoint conectado);
 *   3. endpoint reconhecido e diferente do perfil declarado → `mismatch`;
 *   4. endpoint não reconhecido → `warn` de "não verificável" (provedor próprio é legítimo);
 *   5. WebSocket/fallback de provedor conhecido e diferente → `warn` (pior caso: failover
 *      com teto diferente do declarado).
 */
export function assessRpcCoherence(input: RpcCoherenceInput = {}): RpcCoherence {
  const known = input.knownProfiles ?? RPC_PROFILE_NAMES;
  const declaredProfile = String(input.declaredProfile ?? "public").toLowerCase().trim();
  const declaredProfileKnown = known.includes(declaredProfile);

  const issues: RpcCoherenceIssue[] = [];
  const observations: RpcHostObservation[] = [];

  const endpointRaw = typeof input.endpoint === "string" ? input.endpoint.trim() : "";
  const usingPublicDefaultEndpoint = endpointRaw === "";
  const endpointProvider: RpcProviderKey = usingPublicDefaultEndpoint
    ? "public"
    : inferRpcProvider(endpointRaw);

  if (!declaredProfileKnown) {
    issues.push({
      severity: "mismatch",
      code: "perfil-desconhecido",
      message:
        `HFT_RPC_PROFILE="${input.declaredProfile}" não é um perfil conhecido ` +
        `(${known.join(" | ")}). O orçamento cai silenciosamente em "public" (teto baixo) — ` +
        `corrija a variável em vez de conviver com o teto errado.`,
    });
  }

  observations.push(
    usingPublicDefaultEndpoint
      ? { role: "endpoint", host: PUBLIC_RPC_HOST, provider: "public" }
      : { role: "endpoint", host: hostFromUrl(endpointRaw) || "(url inválida)", provider: endpointProvider }
  );

  if (usingPublicDefaultEndpoint) {
    issues.push({
      severity: "warn",
      code: "endpoint-ausente",
      message:
        "RPC_ENDPOINT não está definido: o processo está usando o endpoint PÚBLICO " +
        `(https://${PUBLIC_RPC_HOST}), compartilhado e sem garantia de envio. ` +
        "Isso é aceitável para teste e NÃO é aceitável para operar capital.",
    });
    if (declaredProfileKnown && declaredProfile !== "public") {
      issues.push({
        severity: "mismatch",
        code: "endpoint-publico-com-perfil-dedicado",
        message:
          `HFT_RPC_PROFILE="${declaredProfile}" declara um provedor dedicado, mas o endpoint é o ` +
          `público (${
            endpointProvider === "public" ? PUBLIC_RPC_HOST : "RPC_ENDPOINT vazio"
          }). O teto do orçamento ficará MAIOR do que o endpoint aguenta: 429 no momento em que o ` +
          `bot mais precisa dele.`,
      });
    }
  } else if (endpointProvider === "unknown") {
    issues.push({
      severity: "warn",
      code: "host-nao-verificavel",
      message:
        "o host do endpoint não corresponde a nenhum provedor conhecido deste código " +
        "(provedor próprio, proxy ou domínio customizado). Não é erro — é NÃO VERIFICÁVEL: " +
        "confirme manualmente que o teto do perfil declarado é igual ao do plano contratado.",
    });
  } else if (endpointProvider === "public" && declaredProfileKnown && declaredProfile === "public") {
    // Caso coerente e barato: endpoint público + perfil público. Nada a declarar.
  } else if (declaredProfileKnown && declaredProfile === "public" && endpointProvider !== "public") {
    // Sub-utilização: o teto declarado é MENOR que o do endpoint. Não estoura cota — mas o bot
    // pula decisões que caberiam, então é aviso (e não bloqueio de boot).
    issues.push({
      severity: "warn",
      code: "endpoint-dedicado-com-perfil-publico",
      message:
        `o endpoint é dedicado ("${endpointProvider}") mas o perfil é "public": o bot se limita ` +
        `a ~${RPC_PROFILES.public.limit} req/s e vai PULAR decisões que a sua cota suportaria. ` +
        `Ajuste HFT_RPC_PROFILE para "${endpointProvider}" para usar o teto real do plano.`,
    });
    // Aqui `endpointProvider` já é conhecido (o ramo "unknown" foi tratado acima; o compilador
    // até prova isso pelo estreitamento de tipo da cadeia else-if).
  } else if (declaredProfileKnown && endpointProvider !== declaredProfile) {
    issues.push({
      severity: "mismatch",
      code: "perfil-nao-bate-endpoint",
      message:
        `o endpoint conectado é do provedor "${endpointProvider}" mas HFT_RPC_PROFILE="${declaredProfile}". ` +
        `Um dos dois está errado: ou o perfil (teto de cota) ou o endpoint.`,
    });
  }

  const websocketRaw = typeof input.websocket === "string" ? input.websocket.trim() : "";
  if (websocketRaw !== "") {
    const wsProvider = inferRpcProvider(websocketRaw);
    observations.push({
      role: "websocket",
      host: hostFromUrl(websocketRaw) || "(url inválida)",
      provider: wsProvider,
    });
    if (wsProvider !== "unknown" && declaredProfileKnown && wsProvider !== declaredProfile) {
      issues.push({
        severity: "warn",
        code: "perfil-nao-bate-websocket",
        message:
          `o RPC_WEBSOCKET é do provedor "${wsProvider}" e o perfil declarado é "${declaredProfile}". ` +
          `Cada provedor tem cota própria de WebSocket — confirme que a assinatura de logs pertence ` +
          `ao plano do perfil declarado.`,
      });
    }
  }

  const fallbacks = toList(input.fallbacks);
  const fallbackProviders = new Set<RpcProviderKey>();
  for (const url of fallbacks) {
    const provider = inferRpcProvider(url);
    fallbackProviders.add(provider);
    observations.push({ role: "fallback", host: hostFromUrl(url) || "(url inválida)", provider });
  }
  if (fallbackProviders.size > 0) {
    const knownProviders = [...fallbackProviders].filter((p) => p !== "unknown");
    const divergent = knownProviders.filter((p) => p !== declaredProfile);
    if (divergent.length > 0) {
      issues.push({
        severity: "warn",
        code: "perfil-nao-bate-fallback",
        message:
          `RPC_FALLBACKS contém provedor(es) "${divergent.join(", ")}" diferente(s) do perfil ` +
          `declarado "${declaredProfile}". No failover, o teto de cota muda sem aviso — o ` +
          `orçamento continua aplicando o teto do perfil declarado.`,
      });
    }
    if (knownProviders.length > 1) {
      issues.push({
        severity: "warn",
        code: "fallback-misto",
        message:
          `RPC_FALLBACKS mistura provedores (${knownProviders.join(", ")}): o custo por chamada e o ` +
          `teto de cota mudam conforme quem responde.`,
      });
    }
  }

  return {
    declaredProfile,
    declaredProfileKnown,
    inferredFromEndpoint: endpointProvider,
    coherent: issues.every((i) => i.severity !== "mismatch"),
    usingPublicDefaultEndpoint,
    observations,
    issues,
  };
}

/** Resumo de uma linha por achado — pronto para log, sem URL completa e sem chave. */
export function describeRpcCoherence(coherence: RpcCoherence): string[] {
  const linhas = [
    `perfil declarado="${coherence.declaredProfile}"` +
      (coherence.declaredProfileKnown ? "" : " [DESCONHECIDO]") +
      ` | endpoint inferido="${coherence.inferredFromEndpoint}"` +
      (coherence.usingPublicDefaultEndpoint ? " (padrão público)" : "") +
      ` | coerente=${coherence.coherent}`,
  ];
  for (const issue of coherence.issues) {
    linhas.push(`${issue.severity === "mismatch" ? "[INCOERENTE]" : "[AVISO]"} ${issue.message}`);
  }
  return linhas;
}
