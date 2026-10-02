/**
 * STATUS DE LANDING DO JITO + ORÁCULO DE TIP.
 *
 * ## O que faz
 *
 * Duas coisas que faltavam para separar "enviado" de "executado", e para parar de chutar o
 * valor do tip:
 *
 *   1. **Parsing e reconciliação de status** — funções puras que leem as respostas de
 *      `getBundleStatuses` / `getInflightBundleStatuses` e produzem um veredito de estado:
 *      `not_found | pending | failed | invalid | landed_unconfirmed | confirmed_on_chain`.
 *   2. **Oráculo de tip** — lê o tip floor REAL (`https://bundles.jito.wtf/api/v1/bundles/tip_floor`),
 *      escolhe um percentil por política, aplica o teto em bps do capital e nunca inventa número.
 *
 * ## Por que a distinção "Landing ≠ confirmado" está no centro deste módulo
 *
 * A doc do Jito descreve `Landed` no inflight como "landed on-chain (determined using RPC or
 * `bundles_landed` table)". Isso é evidência de que o bundle entrou em um bloco — NÃO é
 * confirmação no nível `confirmed`/`finalized` no SEU RPC, e não é prova de que a transação
 * fez o que você queria (um bloco "uncled" pode ser rebroadcast fora da atomicidade do bundle;
 * a própria doc alerta para isso). Portanto: `Landed` vira `landed_unconfirmed`, com autoridade
 * declarada, e só o RPC (ou `confirmation_status` de `getBundleStatuses`, que o Jito obtém via
 * `getSignatureStatuses`) promove para `confirmed_on_chain`.
 *
 * ## Dependências
 *
 * - `src/accounting.ts` (`clampTipSol`) — teto de tip em bps do capital.
 * - Nada de rede nas funções puras. A única I/O está em `JitoTipOracle`, com `fetchFn` injetável.
 *
 * ## Riscos e limites (declarados)
 *
 * 1. `getInflightBundleStatuses` só cobre os **últimos 5 minutos**; fora disso, devolve `Invalid`.
 * 2. `getBundleStatuses` usa `getSignatureStatuses` com `searchTransactionHistory=false`:
 *    cobre ~300 slots enraizados. Bundle antigo pode vir `null` — e `null` NÃO significa falha.
 * 3. Rate limit do block engine e do tip floor: **1 requisição/segundo/IP/região** (doc). Por
 *    isso o oráculo tem throttle + cache; insistir acelera o bloqueio da chave.
 * 4. Tip mínimo aceito pelo Jito: **1000 lamports** (doc). Tip abaixo disso provavelmente não é
 *    considerado. O teto de risco em bps vence: nunca elevamos o tip acima do teto só para
 *    atingir o mínimo — avisamos que o bundle provavelmente não será considerado.
 * 5. Formato do bundle id: a DOC SE CONTRADIZ — o exemplo de `sendBundle` mostra base58
 *    (formato de assinatura) e o de `getBundleStatuses` mostra SHA-256 em hex. Não adivinhamos:
 *    `isPlausibleBundleId` aceita os dois formatos e o parser nunca depende do formato.
 *
 * ## Como testar
 *
 * `npm run test` (grupo [12]) — parsers, reconciliação, tip (percentis, teto em bps, mínimo,
 * offline sem invenção) e throttle/cache com `fetchFn` injetado.
 *
 * ## Como colocar em produção
 *
 * `JitoBundleSender.getBundleStatuses()` / `getInflightBundleStatuses()` (rede) +
 * `JitoTipOracle.recommendTip()` (decisão de tip no momento do envio). Endpoint de leitura:
 * `GET /api/jito/bundle-status?ids=…&signatures=…`.
 */

import { clampTipSol } from "./accounting.js";

/* -------------------------------------------------------------------------- */
/* CONSTANTES VERIFICADAS NA DOC (docs.jito.wtf/lowlatencytxnsend)             */
/* -------------------------------------------------------------------------- */

/** Máximo de bundle ids por requisição em getBundleStatuses/getInflightBundleStatuses. */
export const MAX_BUNDLE_IDS_PER_REQUEST = 5;
/** Tip mínimo considerado pelo Jito (doc: "The minimum tips is 1000 lamports"). */
export const MIN_JITO_TIP_LAMPORTS = 1000;
/** Host do tip floor: REST em bundles.jito.wtf (NÃO é método JSON-RPC do block engine). */
export const TIP_FLOOR_URL = "https://bundles.jito.wtf/api/v1/bundles/tip_floor";
/** Rate limit documentado: 1 requisição por segundo por IP por região. */
export const JITO_MIN_REQUEST_INTERVAL_MS = 1_000;
/** Janela do getInflightBundleStatuses (doc: "within the last five minutes"). */
export const INFLIGHT_WINDOW_MS = 5 * 60 * 1000;

export const LAMPORTS_PER_SOL = 1_000_000_000;

/* -------------------------------------------------------------------------- */
/* 1. VALIDAÇÃO DE ID                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Aceita SHA-256 em hex (64 chars, exemplo da doc de getBundleStatuses) OU base58
 * (43–90 chars, exemplo da doc de sendBundle). A doc se contradiz; recusar um dos formatos
 * rejeitaria ids legítimos. O parser nunca usa o formato para inferir nada além de validade.
 */
export function isPlausibleBundleId(id: unknown): boolean {
  if (typeof id !== "string") return false;
  const s = id.trim();
  if (s.length === 0) return false;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return true;
  if (/^[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(s)) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* 2. TIPOS                                                                    */
/* -------------------------------------------------------------------------- */

export type JitoInflightStatus = "Invalid" | "Pending" | "Failed" | "Landed";
export const INFLIGHT_STATUSES: readonly JitoInflightStatus[] = ["Invalid", "Pending", "Failed", "Landed"];

export type JitoConfirmationStatus = "processed" | "confirmed" | "finalized";
export const CONFIRMATION_STATUSES: readonly JitoConfirmationStatus[] = ["processed", "confirmed", "finalized"];

export type LandingVerdict =
  | "not_found"
  | "pending"
  | "failed"
  | "invalid"
  | "landed_unconfirmed"
  | "confirmed_on_chain"
  | "unknown";

export interface BundleStatusEntry {
  bundleId: string;
  found: boolean;
  slot: number | null;
  confirmationStatus: JitoConfirmationStatus | null;
  /** Assinaturas (base58) das transações do bundle, conforme devolvidas pelo Jito. */
  signatures: string[];
  /** `null` = sem erro relatado. String = erro relatado (formato cru, sem interpretação). */
  err: string | null;
  /** `null` = a resposta não declara se o erro é retentável. Não inventamos. */
  retryable: boolean | null;
}

export interface InflightStatusEntry {
  bundleId: string;
  found: boolean;
  status: JitoInflightStatus | null;
  landedSlot: number | null;
}

export interface JitoStatusQueryResult<T> {
  ok: boolean;
  entries: T[];
  /** Ids pedidos que não vieram na resposta. Resposta parcial é fato, não erro. */
  missingIds: string[];
  /** Problemas de formato/erros de rede — declarados, nunca silenciados. */
  problems: string[];
}

export interface RpcConfirmation {
  signature: string;
  confirmationStatus: JitoConfirmationStatus;
  slot: number | null;
  /** `null` = o RPC não informou erro (nenhum erro relatado). */
  err: string | null;
}

export interface LandingReconciliation {
  bundleId: string;
  verdict: LandingVerdict;
  /** De ONDE veio a evidência mais forte. "rpc" é a autoridade para decidir sobre capital. */
  authority: "rpc" | "jito" | "none";
  slot: number | null;
  signatures: string[];
  reasons: string[];
}

/* -------------------------------------------------------------------------- */
/* 3. PARSING (PURO)                                                           */
/* -------------------------------------------------------------------------- */

function asArray(v: unknown): any[] | null {
  return Array.isArray(v) ? (v as any[]) : null;
}

function toSlot(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeErr(raw: unknown): { err: string | null; retryable: boolean | null } {
  if (raw === null || raw === undefined) return { err: null, retryable: null };
  // Formato observado na doc: { "Ok": null } = sem erro.
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if ("Ok" in obj && (obj.Ok === null || obj.Ok === undefined)) return { err: null, retryable: null };
    const retryable = typeof (obj as any).retryable === "boolean" ? ((obj as any).retryable as boolean) : null;
    if ("Err" in obj) return { err: JSON.stringify(obj.Err), retryable };
    return { err: JSON.stringify(obj), retryable };
  }
  return { err: String(raw), retryable: null };
}

/**
 * Interpreta a resposta de `getBundleStatuses`.
 *
 * A resposta pode conter `null` no lugar de um bundle não encontrado — tratamos como
 * `found: false`. `null` NÃO é falha: pode significar apenas que o bundle saiu da janela
 * recente do RPC (searchTransactionHistory=false, ~300 slots enraizados).
 */
export function parseBundleStatuses(
  raw: unknown,
  requestedIds: string[]
): JitoStatusQueryResult<BundleStatusEntry> {
  const problems: string[] = [];
  const entries: BundleStatusEntry[] = [];
  const missingIds: string[] = [];

  const result = (raw as any)?.result;
  const value = asArray(result?.value);
  if (!value) {
    const rpcError = (raw as any)?.error;
    problems.push(
      rpcError
        ? `RPC do block engine devolveu erro: ${JSON.stringify(rpcError).slice(0, 200)}`
        : "resposta sem result.value (formato inesperado)"
    );
    return { ok: false, entries: [], missingIds: [...requestedIds], problems };
  }

  const byId = new Map<string, any>();
  for (const item of value) {
    if (item === null || item === undefined) continue;
    if (typeof item !== "object") {
      problems.push("item de result.value não é objeto nem null");
      continue;
    }
    const id = (item as any).bundle_id;
    if (typeof id === "string") byId.set(id, item);
  }

  for (const requested of requestedIds) {
    const item = byId.get(requested);
    if (!item) {
      missingIds.push(requested);
      entries.push({
        bundleId: requested,
        found: false,
        slot: null,
        confirmationStatus: null,
        signatures: [],
        err: null,
        retryable: null,
      });
      continue;
    }

    // A doc usa `confirmation_status` no exemplo e `confirmationStatus` na tabela: aceitamos os dois.
    const rawStatus = (item as any).confirmation_status ?? (item as any).confirmationStatus ?? null;
    let confirmationStatus: JitoConfirmationStatus | null = null;
    if (typeof rawStatus === "string") {
      if ((CONFIRMATION_STATUSES as readonly string[]).includes(rawStatus)) {
        confirmationStatus = rawStatus as JitoConfirmationStatus;
      } else {
        problems.push(`bundle ${requested.slice(0, 12)}…: confirmation_status desconhecido ("${rawStatus}")`);
      }
    }

    const signatures = (asArray((item as any).transactions) ?? []).filter(
      (s): s is string => typeof s === "string"
    );
    const { err, retryable } = normalizeErr((item as any).err);

    entries.push({
      bundleId: requested,
      found: true,
      slot: toSlot((item as any).slot),
      confirmationStatus,
      signatures,
      err,
      retryable,
    });
  }

  return { ok: true, entries, missingIds, problems };
}

/** Interpreta a resposta de `getInflightBundleStatuses` (janela de 5 minutos). */
export function parseInflightStatuses(
  raw: unknown,
  requestedIds: string[]
): JitoStatusQueryResult<InflightStatusEntry> {
  const problems: string[] = [];
  const entries: InflightStatusEntry[] = [];
  const missingIds: string[] = [];

  const result = (raw as any)?.result;
  const value = asArray(result?.value);
  if (!value) {
    const rpcError = (raw as any)?.error;
    problems.push(
      rpcError
        ? `RPC do block engine devolveu erro: ${JSON.stringify(rpcError).slice(0, 200)}`
        : "resposta sem result.value (formato inesperado)"
    );
    return { ok: false, entries: [], missingIds: [...requestedIds], problems };
  }

  const byId = new Map<string, any>();
  for (const item of value) {
    if (item === null || item === undefined) continue;
    if (typeof item !== "object") {
      problems.push("item de result.value não é objeto nem null");
      continue;
    }
    const id = (item as any).bundle_id;
    if (typeof id === "string") byId.set(id, item);
  }

  for (const requested of requestedIds) {
    const item = byId.get(requested);
    if (!item) {
      missingIds.push(requested);
      entries.push({ bundleId: requested, found: false, status: null, landedSlot: null });
      continue;
    }
    const rawStatus = (item as any).status;
    let status: JitoInflightStatus | null = null;
    if (typeof rawStatus === "string") {
      if ((INFLIGHT_STATUSES as readonly string[]).includes(rawStatus)) {
        status = rawStatus as JitoInflightStatus;
      } else {
        problems.push(`bundle ${requested.slice(0, 12)}…: status desconhecido ("${rawStatus}")`);
      }
    } else {
      problems.push(`bundle ${requested.slice(0, 12)}…: resposta sem campo "status"`);
    }
    entries.push({
      bundleId: requested,
      found: true,
      status,
      landedSlot: toSlot((item as any).landed_slot),
    });
  }

  return { ok: true, entries, missingIds, problems };
}

/* -------------------------------------------------------------------------- */
/* 4. RECONCILIAÇÃO DE LANDING (a regra "Landed ≠ confirmado")                 */
/* -------------------------------------------------------------------------- */

/**
 * Combina as três fontes de evidência em UM veredito com autoridade declarada.
 *
 * Precedência: RPC (autoridade) > `getBundleStatuses.confirmation_status` (o Jito consulta o
 * RPC dele) > `getInflightBundleStatuses.status` (sinal operacional, não confirmação).
 */
export function reconcileLanding(input: {
  bundleId: string;
  inflight?: InflightStatusEntry | null;
  bundleStatus?: BundleStatusEntry | null;
  rpcConfirmation?: RpcConfirmation | null;
  /**
   * Falha de CONSULTA por fonte (não de status). Existe para impedir o erro mais perigoso
   * desta reconciliação: transformar "não consegui perguntar" em "não encontrado".
   */
  sourceErrors?: { inflight?: string | null; bundleStatus?: string | null } | null;
}): LandingReconciliation {
  const { bundleId } = input;
  const inflight = input.inflight ?? null;
  const bundleStatus = input.bundleStatus ?? null;
  const rpc = input.rpcConfirmation ?? null;
  const signatures = bundleStatus?.signatures ?? [];
  const reasons: string[] = [];
  /**
   * Evidência de que a transação EXISTE on-chain em nível otimista ("processed").
   *
   * Por que guardamos em vez de retornar na hora: `getBundleStatuses` pode trazer um estado
   * mais forte (confirmed/finalized) para o mesmo bundle, e essa checagem vem logo abaixo.
   * Mas se nada mais aparecer, `processed` NÃO é `not_found` — a assinatura está na cadeia,
   * só não está confirmada. Sem este guarda, o veredito mentia dizendo "não encontrado".
   */
  let rpcProcessed: RpcConfirmation | null = null;

  /**
   * Falhas de CONSULTA são registradas aqui, no topo, para acompanharem qualquer veredito
   * que use `reasons` (inclusive os que retornam cedo). A pior conclusão possível desta função
   * seria transformar "não consegui perguntar" em "não existe".
   */
  const inflightError = input.sourceErrors?.inflight ?? null;
  const bundleError = input.sourceErrors?.bundleStatus ?? null;
  if (inflightError) reasons.push(`Consulta ao inflight falhou: ${inflightError}`);
  if (bundleError) reasons.push(`Consulta a getBundleStatuses falhou: ${bundleError}`);
  if ((inflightError || bundleError) && !(inflightError && bundleError)) {
    reasons.push(
      `Uma das fontes não respondeu (${inflightError ? "inflight" : "getBundleStatuses"}): a conclusão ` +
        `abaixo se apoia apenas na fonte que respondeu.`,
    );
  }

  // 1. RPC é a autoridade.
  if (rpc) {
    if (rpc.confirmationStatus === "confirmed" || rpc.confirmationStatus === "finalized") {
      return {
        bundleId,
        verdict: "confirmed_on_chain",
        authority: "rpc",
        slot: rpc.slot ?? bundleStatus?.slot ?? null,
        signatures,
        reasons: [
          `RPC confirmou a assinatura ${rpc.signature.slice(0, 12)}… com nível "${rpc.confirmationStatus}"` +
            (rpc.err ? ` (erro relatado: ${rpc.err})` : "") +
            ". Esta é a autoridade final para decisão de capital.",
        ],
      };
    }
    rpcProcessed = rpc;
    reasons.push(
      `RPC reporta "${rpc.confirmationStatus}" — confirmação OTIMISTA, não definitiva. ` +
        `Reconsulte até "confirmed"/"finalized" antes de tratar como executado.`
    );
  }

  // 2. Confirmação obtida via getBundleStatuses (o Jito consulta getSignatureStatuses).
  /**
   * Nenhuma fonte do Jito respondeu E não há confirmação de RPC → "unknown", jamais "not_found".
   * Fica DEPOIS dos retornos por evidência (RPC confirmado / RPC processed / bundleStatus final)
   * de propósito: evidência positiva não deixa de existir porque uma consulta falhou.
   */
  if (inflightError && bundleError && !rpc && !(bundleStatus?.found)) {
    reasons.push(
      "Nenhuma das duas fontes respondeu. Isto significa \"não foi possível consultar\", e NÃO " +
        "\"o bundle não existe\". Reconsulte antes de concluir qualquer coisa sobre este bundle.",
    );
    return { bundleId, verdict: "unknown", authority: "none", slot: null, signatures, reasons };
  }

  if (bundleStatus?.found && (bundleStatus.confirmationStatus === "confirmed" || bundleStatus.confirmationStatus === "finalized")) {
    reasons.push(
      `getBundleStatuses reporta "${bundleStatus.confirmationStatus}" para o slot ` +
        `${bundleStatus.slot ?? "?"}. A evidência vem do RPC do Jito — para decisão de capital, ` +
        `confirme a assinatura no SEU RPC.`,
    );
    return {
      bundleId,
      verdict: "confirmed_on_chain",
      authority: "jito",
      slot: bundleStatus.slot,
      signatures,
      reasons,
    };
  }

  /**
   * 3. RPC em nível otimista com evidência de que a assinatura EXISTE on-chain.
   *
   * Vem ANTES dos sinais do inflight de propósito: "a transação está na cadeia em nível
   * processed" é evidência mais forte do que "o Jito não achou o bundle na janela de 5 min"
   * (Invalid) ou "não falhou nem pousou" (Pending).
   */
  if (rpcProcessed) {
    reasons.push(
      "A assinatura existe on-chain (nível processed). O bundle NÃO está 'não encontrado' — " +
        "falta apenas a confirmação final.",
    );
    return {
      bundleId,
      verdict: "landed_unconfirmed",
      authority: "rpc",
      slot: rpcProcessed.slot,
      signatures,
      reasons,
    };
  }

  // 4. "Landed" do inflight: entrou em bloco, NÃO é confirmação.
  if (inflight?.status === "Landed") {
    reasons.push(
      `Jito reporta "Landed" no slot ${inflight.landedSlot ?? "?"}. Isso significa que o bundle ` +
        `entrou em um bloco — NÃO que a confirmação (nível confirmed/finalized) ocorreu, e NÃO que ` +
        `a execução produziu o efeito esperado (um bloco "uncled" pode ser rebroadcast fora da ` +
        `atomicidade do bundle). Confirme a assinatura no seu RPC.`,
    );
    return { bundleId, verdict: "landed_unconfirmed", authority: "jito", slot: inflight.landedSlot, signatures, reasons };
  }

  if (inflight?.status === "Failed") {
    reasons.push(
      "Jito reporta \"Failed\": todas as regiões que receberam o bundle o marcaram como falho e ele não foi encaminhado.",
    );
    return { bundleId, verdict: "failed", authority: "jito", slot: null, signatures, reasons };
  }

  if (inflight?.status === "Pending") {
    reasons.push("Jito reporta \"Pending\": não falhou, não pousou, não foi invalidado. Ainda pode pousar.");
    return { bundleId, verdict: "pending", authority: "jito", slot: null, signatures, reasons };
  }

  if (inflight?.status === "Invalid") {
    reasons.push(
      "Inflight reporta \"Invalid\": o bundle está fora da janela de 5 minutos deste método " +
        "(ou nunca foi visto por esta região). Isso NÃO é falha — consulte getBundleStatuses, que " +
        "cobre o histórico recente do RPC.",
    );
    return { bundleId, verdict: "invalid", authority: "jito", slot: null, signatures, reasons };
  }

  // 4. Encontrado em getBundleStatuses, mas ainda sem status de confirmação.
  if (bundleStatus?.found) {
    if (bundleStatus.err) {
      reasons.push(
        `getBundleStatuses devolveu erro para o bundle: ${bundleStatus.err}` +
          (bundleStatus.retryable === true ? " (retentável: consulte de novo)" : ""),
      );
    }
    reasons.push(
      bundleStatus.confirmationStatus
        ? `status de confirmação atual: "${bundleStatus.confirmationStatus}" (ainda não é confirmação final).`
        : "bundle encontrado, mas sem status de confirmação na resposta — estado indeterminado.",
    );
    return {
      bundleId,
      verdict: bundleStatus.confirmationStatus ? "landed_unconfirmed" : "unknown",
      authority: "jito",
      slot: bundleStatus.slot,
      signatures,
      reasons,
    };
  }

  reasons.push(
    "Nenhuma fonte reportou o bundle: não encontrado no inflight (janela de 5 min) nem em " +
      "getBundleStatuses (histórico recente do RPC). \"Não sei\" ≠ \"falhou\": o bundle pode ter " +
      "saído da janela de consulta.",
  );
  return { bundleId, verdict: "not_found", authority: "none", slot: null, signatures, reasons };
}

/* -------------------------------------------------------------------------- */
/* 5. TIP FLOOR (PARSING + POLÍTICA)                                           */
/* -------------------------------------------------------------------------- */

export interface TipFloorSample {
  time: string | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p95: number | null;
  p99: number | null;
  ema50: number | null;
}

export type TipPercentilePolicy = "p25" | "p50" | "p75" | "p95" | "p99" | "ema50";
export const TIP_POLICIES: readonly TipPercentilePolicy[] = ["p25", "p50", "p75", "p95", "p99", "ema50"];

/** Percentil do tip floor segundo a política. `null` quando ausente/inválido — nunca inventamos. */
export function percentileValue(sample: TipFloorSample, policy: TipPercentilePolicy): number | null {
  switch (policy) {
    case "p25": return sample.p25;
    case "p50": return sample.p50;
    case "p75": return sample.p75;
    case "p95": return sample.p95;
    case "p99": return sample.p99;
    case "ema50": return sample.ema50;
  }
}

export function parseTipFloor(raw: unknown): { sample: TipFloorSample | null; problems: string[] } {
  const problems: string[] = [];
  const arr = asArray(raw);
  if (!arr || arr.length === 0) {
    return { sample: null, problems: ["tip floor vazio ou não é array"] };
  }
  const last = arr[arr.length - 1];
  if (!last || typeof last !== "object") {
    return { sample: null, problems: ["último item do tip floor não é objeto"] };
  }

  const num = (v: unknown, field: string): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      problems.push(`campo ${field} inválido (${String(v)})`);
      return null;
    }
    return n;
  };

  const sample: TipFloorSample = {
    time: typeof (last as any).time === "string" ? (last as any).time : null,
    p25: num((last as any).landed_tips_25th_percentile, "landed_tips_25th_percentile"),
    p50: num((last as any).landed_tips_50th_percentile, "landed_tips_50th_percentile"),
    p75: num((last as any).landed_tips_75th_percentile, "landed_tips_75th_percentile"),
    p95: num((last as any).landed_tips_95th_percentile, "landed_tips_95th_percentile"),
    p99: num((last as any).landed_tips_99th_percentile, "landed_tips_99th_percentile"),
    ema50: num((last as any).ema_landed_tips_50th_percentile, "ema_landed_tips_50th_percentile"),
  };

  const anyValue = TIP_POLICIES.some((p) => percentileValue(sample, p) !== null);
  if (!anyValue) {
    return { sample: null, problems: [...problems, "nenhum percentil utilizável na resposta"] };
  }
  return { sample, problems };
}

export interface RecommendedTip {
  /** Tip escolhido a partir do tip floor, ANTES de teto/mínimo. `null` se não há dado. */
  rawTipSol: number | null;
  policy: TipPercentilePolicy;
  usedPolicy: TipPercentilePolicy | null;
  /** true = a política pedida não tinha valor e outro percentil foi usado (declarado). */
  substituted: boolean;
  basis: string;
}

/**
 * Escolhe o tip a partir do tip floor.
 *
 * Se a política pedida não tiver valor no sample, cai para outro percentil REAL e declara a
 * substituição (`substituted: true`). Se nenhum percentil existir, devolve `rawTipSol: null` —
 * NUNCA um valor inventado (o código anterior desta base retornava constantes fixas aqui).
 */
export function computeRecommendedTip(
  sample: TipFloorSample,
  policy: TipPercentilePolicy
): RecommendedTip {
  const direct = percentileValue(sample, policy);
  if (direct !== null) {
    return {
      rawTipSol: direct,
      policy,
      usedPolicy: policy,
      substituted: false,
      basis: `${policy} do tip floor = ${direct} SOL`,
    };
  }

  const fallbackOrder: TipPercentilePolicy[] = ["p50", "p75", "p25", "ema50", "p95", "p99"];
  for (const candidate of fallbackOrder) {
    if (candidate === policy) continue;
    const v = percentileValue(sample, candidate);
    if (v !== null) {
      return {
        rawTipSol: v,
        policy,
        usedPolicy: candidate,
        substituted: true,
        basis: `${policy} ausente no tip floor; usado ${candidate} = ${v} SOL (substituição declarada)`,
      };
    }
  }

  return { rawTipSol: null, policy, usedPolicy: null, substituted: false, basis: "sem percentil utilizável no tip floor" };
}

/* -------------------------------------------------------------------------- */
/* 6. ORÁCULO (com I/O injetável, throttle e cache)                            */
/* -------------------------------------------------------------------------- */

export interface TipOracleOptions {
  fetchFn: typeof fetch;
  now: () => number;
  /** Intervalo mínimo entre requisições reais (rate limit documentado: 1 req/s). */
  minIntervalMs?: number;
  /** TTL do cache. O tip floor muda a cada bloco; 10s é o suficiente para não perder sinal. */
  cacheTtlMs?: number;
  url?: string;
  timeoutMs?: number;
}

export type TipFloorResult =
  | {
      available: true;
      sample: TipFloorSample;
      fetchedAt: number;
      ageMs: number;
      fromCache: boolean;
      problems: string[];
      url: string;
    }
  | {
      available: false;
      error: string;
      lastKnown: { sample: TipFloorSample; fetchedAt: number; ageMs: number } | null;
      url: string;
    };

export interface TipRecommendation {
  available: boolean;
  tipSol: number | null;
  tipLamports: number | null;
  policy: TipPercentilePolicy;
  usedPolicy: TipPercentilePolicy | null;
  substituted: boolean;
  cappedByBps: boolean;
  capSol: number | null;
  belowJitoMinimum: boolean;
  sampleTime: string | null;
  ageMs: number | null;
  basis: string;
  warnings: string[];
  error: string | null;
}

export class JitoTipOracle {
  private cache: { sample: TipFloorSample; fetchedAt: number; problems: string[] } | null = null;
  private lastRequestAt = 0;
  private lastError: string | null = null;
  /** Momento do último sucesso real (null = nunca consultado com sucesso). */
  private lastSuccessAt: number | null = null;

  constructor(private readonly options: TipOracleOptions) {}

  private get url(): string {
    return this.options.url ?? TIP_FLOOR_URL;
  }

  /**
   * Lê o tip floor. Nunca lança: falha vira `available: false` com o motivo e, se houver,
   * o último valor conhecido COM A IDADE explicitada (para o chamador decidir se ainda serve).
   */
  async getTipFloor(): Promise<TipFloorResult> {
    const now = this.options.now();
    const ttl = this.options.cacheTtlMs ?? 10_000;

    if (this.cache && now - this.cache.fetchedAt < ttl) {
      return {
        available: true,
        sample: this.cache.sample,
        fetchedAt: this.cache.fetchedAt,
        ageMs: now - this.cache.fetchedAt,
        fromCache: true,
        problems: this.cache.problems,
        url: this.url,
      };
    }

    const minInterval = this.options.minIntervalMs ?? JITO_MIN_REQUEST_INTERVAL_MS;
    if (now - this.lastRequestAt < minInterval) {
      return {
        available: false,
        error:
          `Requisição ao tip floor limitada por throttle (${minInterval}ms entre chamadas; ` +
          `rate limit documentado do Jito é 1 req/s/IP/região). Sem valor em cache para servir.` +
          (this.lastError ? ` Último erro da fonte: ${this.lastError}` : ""),
        lastKnown: this.describeLastKnown(now),
        url: this.url,
      };
    }

    this.lastRequestAt = now;
    try {
      const res = await this.options.fetchFn(this.url, {
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      });
      if (!res.ok) {
        this.lastError = `tip floor HTTP ${res.status}`;
        return {
          available: false,
          error: this.lastError,
          lastKnown: this.describeLastKnown(now),
          url: this.url,
        };
      }
      const raw = await res.json();
      const parsed = parseTipFloor(raw);
      if (!parsed.sample) {
        this.lastError = `tip floor ilegível: ${parsed.problems.join("; ") || "formato inesperado"}`;
        return {
          available: false,
          error: this.lastError,
          lastKnown: this.describeLastKnown(now),
          url: this.url,
        };
      }
      this.cache = { sample: parsed.sample, fetchedAt: now, problems: parsed.problems };
      this.lastError = null;
      this.lastSuccessAt = now;
      return {
        available: true,
        sample: parsed.sample,
        fetchedAt: now,
        ageMs: 0,
        fromCache: false,
        problems: parsed.problems,
        url: this.url,
      };
    } catch (err: any) {
      this.lastError = `tip floor inacessível: ${err?.message ?? String(err)}`;
      return {
        available: false,
        error: this.lastError,
        lastKnown: this.describeLastKnown(now),
        url: this.url,
      };
    }
  }

  private describeLastKnown(now: number) {
    return this.cache
      ? { sample: this.cache.sample, fetchedAt: this.cache.fetchedAt, ageMs: now - this.cache.fetchedAt }
      : null;
  }

  /**
   * Recomendação de tip para um envio: percentil do tip floor → teto em bps do capital →
   * comparação com o mínimo do Jito. Sem dado de mercado, `available: false` (nunca um número).
   *
   * ORDEM DAS TRAVAS (importa): o TETO DE RISCO VENCE. Se o teto em bps ficar abaixo do mínimo
   * do Jito, o resultado é o teto com `belowJitoMinimum: true` — subir o tip acima do teto
   * silenciosamente seria violar o limite de risco, que é pior do que não pousar.
   */
  async recommendTip(
    input: {
      capitalSol: number;
      maxTipBps: number;
      policy: TipPercentilePolicy;
    },
    /**
     * Tip floor já lido pelo chamador.
     *
     * Existe por um motivo concreto: quem lê o floor e depois pede a recomendação faria DUAS
     * chamadas ao oráculo em sequência — e a segunda cairia no throttle (1 req/s), devolvendo
     * "throttled" no lugar do erro real da fonte. Passar o resultado já obtido elimina a
     * chamada redundante e o diagnóstico enganoso.
     */
    floorOverride?: TipFloorResult
  ): Promise<TipRecommendation> {
    const floor = floorOverride ?? (await this.getTipFloor());
    const warnings: string[] = [];

    if (!floor.available) {
      return {
        available: false,
        tipSol: null,
        tipLamports: null,
        policy: input.policy,
        usedPolicy: null,
        substituted: false,
        cappedByBps: false,
        capSol: null,
        belowJitoMinimum: false,
        sampleTime: null,
        ageMs: floor.lastKnown?.ageMs ?? null,
        basis: "",
        warnings,
        error: floor.error,
      };
    }

    const recommended = computeRecommendedTip(floor.sample, input.policy);
    if (recommended.rawTipSol === null) {
      return {
        available: false,
        tipSol: null,
        tipLamports: null,
        policy: input.policy,
        usedPolicy: null,
        substituted: false,
        cappedByBps: false,
        capSol: null,
        belowJitoMinimum: false,
        sampleTime: floor.sample.time,
        ageMs: floor.ageMs,
        basis: recommended.basis,
        warnings,
        error: "tip floor disponível, mas sem percentil utilizável",
      };
    }
    if (recommended.substituted) {
      warnings.push(recommended.basis);
    }

    const capSol = (input.capitalSol * input.maxTipBps) / 10_000;
    const clamped = clampTipSol(recommended.rawTipSol, input.capitalSol, input.maxTipBps);
    if (clamped.clamped) {
      warnings.push(
        `Tip reduzido de ${recommended.rawTipSol} SOL para ${clamped.tipSol} SOL pelo teto de ` +
          `${input.maxTipBps} bps sobre ${input.capitalSol} SOL.`,
      );
    }

    const tipLamports = Math.floor(clamped.tipSol * LAMPORTS_PER_SOL);
    const belowJitoMinimum = tipLamports < MIN_JITO_TIP_LAMPORTS;
    if (belowJitoMinimum) {
      warnings.push(
        `Tip resultante (${tipLamports} lamports) está abaixo do mínimo do Jito ` +
          `(${MIN_JITO_TIP_LAMPORTS} lamports): o bundle provavelmente NÃO será considerado. ` +
          `O teto de risco não foi violado de propósito — para competir, aumente o capital ` +
          `comprometido ou o teto em bps, de forma consciente.`,
      );
    }
    if (floor.fromCache) {
      warnings.push(`Tip floor veio do cache (${floor.ageMs}ms de idade).`);
    }

    return {
      available: true,
      tipSol: clamped.tipSol,
      tipLamports,
      policy: input.policy,
      usedPolicy: recommended.usedPolicy,
      substituted: recommended.substituted,
      cappedByBps: clamped.clamped,
      capSol,
      belowJitoMinimum,
      sampleTime: floor.sample.time,
      ageMs: floor.ageMs,
      basis: `${recommended.basis}; teto ${input.maxTipBps} bps de ${input.capitalSol} SOL = ${capSol} SOL`,
      warnings,
      error: null,
    };
  }

  /** Último erro observado (para diagnóstico no painel), sem inventar estado. */
  getLastError(): string | null {
    return this.lastError;
  }

  /**
   * Estado REAL do oráculo, para diagnóstico honesto.
   *
   * `lastError` só existe depois de uma consulta falha; `lastSuccessAt` só depois de uma
   * consulta bem-sucedida. Um oráculo NUNCA consultado não é "ok" nem "com erro" — é
   * "não consultado", e é isso que ele reporta (antes, `getLastError() === null` era lido
   * como "tudo certo" mesmo sem nenhuma chamada ter acontecido).
   */
  getStatus(): {
    everQueried: boolean;
    lastSuccessAt: number | null;
    lastSuccessAgeMs: number | null;
    lastError: string | null;
    hasLastKnown: boolean;
  } {
    const now = this.options.now();
    return {
      everQueried: this.lastSuccessAt !== null,
      lastSuccessAt: this.lastSuccessAt,
      lastSuccessAgeMs: this.lastSuccessAt === null ? null : now - this.lastSuccessAt,
      lastError: this.lastError,
      hasLastKnown: this.describeLastKnown(now) !== null,
    };
  }
}
