/**
 * QUARENTENA DO BANCO OPERACIONAL — separa histórico estruturalmente impossível sem apagar nada.
 *
 * ## O que faz
 *
 * Classifica posições do banco operacional em três baldes:
 *   - `invalid`  : estruturalmente impossível gerir (tamanho <= 0, mint ausente ou que não é
 *                  pubkey base58 válida). Nenhum RPC consegue resolver isso: ou o tamanho da
 *                  posição é zero, ou o ativo não existe.
 *   - `suspect`  : sem campo `mode` (`paper`/`live`). Toda posição criada pelas versões
 *                  auditadas grava o modo; a ausência indica registro ANTERIOR à correção —
 *                  candidato a resíduo do histórico fabricado, mas não prova.
 *   - `ok`       : nada a apontar estruturalmente.
 *
 * ## Como funciona
 *
 * Funções puras (`classifyPosition`, `planQuarantine`, `applyQuarantine`) mais um CLI fino
 * (`scripts/quarantine-db.ts`). O plano é sempre calculado antes de gravar, e a gravação é
 * opt-in (`--apply`), atômica (tmp + rename) e precedida de backup.
 *
 * ## Limites (declarados, não escondidos)
 *
 * 1. Isto é classificação ESTRUTURAL. Não há consulta on-chain: não se afirma que um mint
 *    "existe" ou "não existe" — apenas que o registro é impossível de gerir ou suspeito.
 * 2. `suspect` só entra no plano com `--include-unmigrated`. Sem isso, o operador decide.
 * 3. Nada é apagado: as posições movidas recebem `status: "quarantined"` e os motivos ficam
 *    gravados no registro e no arquivo de quarentena.
 *
 * ## Como testar
 *
 * `npm run test` (grupo [11]). CLI: `npm run quarantine` (dry-run) e
 * `npm run quarantine -- --apply`.
 */

import { isValidPubkey } from "./solanaConfig.js";

export interface PositionLike {
  id?: string;
  mint?: string | null;
  token?: string;
  sizeSol?: number | null;
  mode?: string | null;
  status?: string | null;
  [key: string]: unknown;
}

export type QuarantineVerdict = "invalid" | "suspect" | "ok";

export interface QuarantineClassification {
  id: string;
  token: string;
  mint: string | null;
  sizeSol: number | null;
  verdict: QuarantineVerdict;
  reasons: string[];
}

export interface QuarantinePlan {
  invalid: QuarantineClassification[];
  suspect: QuarantineClassification[];
  ok: QuarantineClassification[];
  /** O que o `--apply` vai mover, dado o plano e as opções. */
  toMove: QuarantineClassification[];
}

/** Classificação de UMA posição. Pura: não lê disco, não consulta rede. */
export function classifyPosition(pos: PositionLike): QuarantineClassification {
  const reasons: string[] = [];
  const sizeSol = Number(pos?.sizeSol);
  const sizeFinite = Number.isFinite(sizeSol);

  if (!sizeFinite || sizeSol <= 0) {
    reasons.push(`tamanho inválido/zero (sizeSol=${pos?.sizeSol ?? "ausente"})`);
  }
  if (!pos?.mint || typeof pos.mint !== "string" || !isValidPubkey(pos.mint)) {
    reasons.push(`mint ausente ou não-base58 ("${pos?.mint ?? "(vazio)"}")`);
  }

  let verdict: QuarantineVerdict = "ok";
  if (reasons.length > 0) {
    verdict = "invalid";
  } else if (pos.mode !== "paper" && pos.mode !== "live") {
    verdict = "suspect";
    reasons.push(
      "registro sem campo `mode` (paper/live): anterior às correções que passaram a gravar o modo"
    );
  }

  return {
    id: String(pos?.id ?? "(sem id)"),
    token: String(pos?.token ?? "(sem token)"),
    mint: typeof pos?.mint === "string" ? pos.mint : null,
    sizeSol: sizeFinite ? sizeSol : null,
    verdict,
    reasons,
  };
}

export function planQuarantine(
  positions: PositionLike[],
  options: { includeUnmigrated?: boolean } = {}
): QuarantinePlan {
  const classified = (positions ?? []).map(classifyPosition);
  const invalid = classified.filter((c) => c.verdict === "invalid");
  const suspect = classified.filter((c) => c.verdict === "suspect");
  const ok = classified.filter((c) => c.verdict === "ok");
  const toMove = options.includeUnmigrated ? [...invalid, ...suspect] : [...invalid];
  return { invalid, suspect, ok, toMove };
}

/**
 * Aplica o plano sobre a lista de posições, devolvendo uma NOVA lista.
 *
 * As posições movidas continuam no banco (não são removidas): recebem `status: "quarantined"`,
 * o instante e os motivos. O gerenciador de posições só considera `status === "open"` (ou
 * ausente), portanto uma posição quarentenada deixa de ser consultada no RPC — que é o efeito
 * pretendido (parar de gastar cota com registro impossível) sem perder o histórico.
 */
export function applyQuarantine(
  positions: PositionLike[],
  plan: QuarantinePlan,
  at: string
): { next: PositionLike[]; moved: QuarantineClassification[] } {
  const moveIds = new Set(plan.toMove.map((c) => c.id));
  const reasonsById = new Map(plan.toMove.map((c) => [c.id, c.reasons]));
  let moved = 0;
  const next = (positions ?? []).map((pos) => {
    const id = String(pos?.id ?? "(sem id)");
    if (!moveIds.has(id)) return pos;
    moved++;
    return {
      ...pos,
      status: "quarantined",
      quarantinedAt: at,
      quarantineReasons: reasonsById.get(id) ?? [],
    };
  });
  return { next, moved: plan.toMove.slice(0, moved) };
}
