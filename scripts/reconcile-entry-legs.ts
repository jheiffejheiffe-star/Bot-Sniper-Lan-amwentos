/**
 * `npm run reconcile` — RECONCILIAÇÃO DA PERNA DE ENTRADA (S14).
 *
 * ## O que faz
 *
 * Fecha o ciclo das saídas que ficaram em PERNA ÚNICA (registros anteriores ao S11, e os que o S11
 * passou a marcar como `exit_leg_only`): localiza o trade de ENTRADA do mesmo mint, **remede as duas
 * transações na cadeia** (`getTransaction` → `parseTransactionLeg`) e grava o PnL do ciclo medido.
 *
 * Sem isso, `GET /api/performance` (S9) não tem amostra: toda a história anterior aparece como
 * "não medido" — e os registros PRÉ-S11 carregam o defeito do Adendo 19 (o ΔSOL da VENDA, que é
 * receita, gravado como se fosse lucro).
 *
 * ## O que este script NÃO faz
 *
 * - **Não adivinha**: saída com mais de uma entrada candidata é RECUSADA (`AMBIGUOUS_ENTRY`) em vez
 *   de escolher a "mais provável"; divergência entre o valor registrado e a releitura da saída
 *   recusa a promoção (`EXIT_LEG_MISMATCH`).
 * - **Não reescreve história**: o número anterior (quando era a receita da venda) fica preservado em
 *   `supersededPnlNetSol`, e o novo valor entra com procedência própria
 *   (`pnlBasis: "round_trip_legs_reconciled"`), separável do que foi medido em tempo real.
 * - **Não assina nada, não envia nada, não usa chave privada** (nem lê a sua): só `getTransaction`.
 *
 * ## Como usar
 *
 *   npm run reconcile                  # DRY-RUN (default): mede, relata e NÃO grava — custa 2 getTransaction por registro
 *   npm run reconcile -- --apply       # grava os registros reconciliados (upsert por id)
 *   npm run reconcile -- --json        # saída de máquina (pipe para jq)
 *   npm run reconcile -- --limit 5     # processa no máximo 5 registros
 *   npm run reconcile -- --wallet <pubkey>   # carteira operacional (default: env/cofre)
 *
 * O relatório é sempre gravado em `data/reconciliation-<timestamp>.json` (diretório ignorado pelo
 * git) — inclusive no dry-run, porque o resultado da medição é evidência.
 *
 * ## Custo (camada gratuita)
 *
 * 2 `getTransaction` por registro reconciliado — a mesma chamada que o S11 já usa. Com `--limit`
 * dá para reconciliar em lotes para não estourar a cota de leitura do plano.
 */

import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { dbStore } from "../src/persistence.js";
import { RPC_ENDPOINT } from "../src/realExecution.js";
import { measureLegWith } from "../src/roundTrip.js";
import {
  buildReconciledTrade,
  decideEntryLegReconciliation,
  planEntryLegReconciliation,
  resolveReconcileToleranceSol,
  summarizeReconciliation,
  type ReconcileOutcomeRow,
} from "../src/entryLegReconciliation.js";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const next = process.argv[idx + 1];
  return next && !next.startsWith("--") ? next : "";
}

function falhar(msg: string): never {
  console.error(`\n✖ ${msg}\n`);
  process.exit(2);
}

/** A carteira que assinou as transações — sem ela não há como medir a perna. */
async function resolveWallet(): Promise<{ pubkey: PublicKey; source: string }> {
  const flag = argValue("--wallet");
  if (flag) {
    try {
      return { pubkey: new PublicKey(flag), source: "--wallet" };
    } catch {
      falhar(`--wallet "${flag}" não é uma chave pública válida (base58).`);
    }
  }
  const env = (process.env.OPERATIONAL_PUBLIC_KEY ?? "").trim();
  if (env) {
    try {
      return { pubkey: new PublicKey(env), source: "OPERATIONAL_PUBLIC_KEY" };
    } catch {
      falhar("OPERATIONAL_PUBLIC_KEY não é uma chave pública válida (base58).");
    }
  }
  try {
    const sec: any = await import("../src/security.js");
    const pk = typeof sec.getActiveWalletPublicKey === "function" ? sec.getActiveWalletPublicKey() : null;
    if (pk) return { pubkey: pk, source: "cofre do processo (getActiveWalletPublicKey)" };
  } catch {
    // Sem cofre inicializado neste processo: é o caso normal de script. Cai no erro explicativo.
  }
  falhar(
    "não sei qual carteira é a operacional. O medidor precisa dela para localizar o seu saldo DENTRO " +
      "da transação: passe `--wallet <pubkey>` ou exporte OPERATIONAL_PUBLIC_KEY. " +
      "(Nenhuma chave privada é necessária — este script só lê a cadeia.)"
  );
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const asJson = process.argv.includes("--json");
  const limitRaw = argValue("--limit");
  const limit = limitRaw === undefined || limitRaw === "" ? Number.POSITIVE_INFINITY : Number(limitRaw);
  if (!Number.isFinite(limit) && limit !== Number.POSITIVE_INFINITY) falhar(`--limit inválido: ${limitRaw}`);

  const wallet = await resolveWallet();
  const toleranceSol = resolveReconcileToleranceSol();
  const conn = new Connection(RPC_ENDPOINT, "confirmed");

  const trades = dbStore.getTrades();
  const plan = planEntryLegReconciliation(trades);

  if (!asJson) {
    console.log("\n══════════════════════════════════════════════════════════════");
    console.log(" RECONCILIAÇÃO DA PERNA DE ENTRADA (S14)");
    console.log("══════════════════════════════════════════════════════════════");
    console.log(` RPC      : ${RPC_ENDPOINT}`);
    console.log(` carteira : ${wallet.pubkey.toBase58()}  (${wallet.source})`);
    console.log(` trades   : ${plan.counts.considered} no banco | ${plan.counts.eligible} elegíveis | ${plan.counts.skipped} fora`);
    console.log(` modo     : ${apply ? "APLICAR (grava no banco)" : "DRY-RUN (nada é gravado)"}`);
    console.log(` tolerância: ${toleranceSol} SOL na conferência da saída`);
    if (Object.keys(plan.counts.byCode).length > 0) {
      console.log("\n Fora da fila (motivo declarado):");
      for (const [code, n] of Object.entries(plan.counts.byCode)) console.log(`   ${code}: ${n}`);
    }
    console.log("");
  }

  const fila = plan.items.slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit);
  const rows: ReconcileOutcomeRow[] = [];
  let gravados = 0;

  for (const item of fila) {
    const trade = trades.find((t) => String(t.id) === item.exitTradeId);
    if (!trade) {
      rows.push({
        exitTradeId: item.exitTradeId, mint: item.mint, token: item.token,
        verdict: "refused", code: "TRADE_DESAPARECEU",
        pnlNetSol: null, previousPnlSol: null,
        reason: "o trade saiu do banco entre o plano e a medição (outro processo escreveu?)",
      });
      continue;
    }

    const entryLeg = await measureLegWith(conn, item.entrySignature, wallet.pubkey.toBase58(), item.mint);
    const exitLeg = await measureLegWith(conn, item.exitSignature, wallet.pubkey.toBase58(), item.mint);

    const decision = decideEntryLegReconciliation({
      entryLeg,
      exitLeg,
      recordedSaleProceedsSol: trade.saleProceedsSol ?? null,
      recordedLegacyPnlSol: trade.pnlBasis === undefined ? (trade.pnlNetSol ?? null) : null,
      toleranceSol,
    });

    if (decision.action === "refuse") {
      rows.push({
        exitTradeId: item.exitTradeId, mint: item.mint, token: item.token,
        verdict: "refused", code: decision.code,
        pnlNetSol: null,
        previousPnlSol: typeof trade.pnlNetSol === "number" ? trade.pnlNetSol : null,
        reason: decision.reason,
      });
      if (!asJson) console.log(`  · ${item.token.slice(0, 14).padEnd(14)} RECUSADO (${decision.code}): ${decision.reason.slice(0, 90)}`);
      continue;
    }

    const novo = buildReconciledTrade(trade, {
      entryLeg,
      exitLeg,
      cycle: decision.cycle,
      reconciledAt: new Date().toISOString(),
      mismatchSol: decision.mismatchSol,
      expectedExitProceedsSol: decision.expectedExitProceedsSol,
    });

    if (apply) {
      dbStore.saveTrade(novo);
      gravados++;
    }

    rows.push({
      exitTradeId: item.exitTradeId, mint: item.mint, token: item.token,
      verdict: "reconciled", code: "OK",
      pnlNetSol: decision.cycle.pnlNetSol,
      previousPnlSol: typeof trade.pnlNetSol === "number" ? trade.pnlNetSol : null,
      reason: (novo as any).reconciliationNote ?? "",
    });

    if (!asJson) {
      const antes = typeof trade.pnlNetSol === "number" ? trade.pnlNetSol.toFixed(6) : "n/d";
      console.log(
        `  · ${item.token.slice(0, 14).padEnd(14)} CICLO MEDIDO: ${(decision.cycle.pnlNetSol as number) >= 0 ? "+" : ""}` +
          `${(decision.cycle.pnlNetSol as number).toFixed(6)} SOL   (antes, receita da venda: ${antes})` +
          `${apply ? "  [GRAVADO]" : "  [dry-run]"}`
      );
    }
  }

  const summary = summarizeReconciliation(plan, rows);

  const report = {
    generatedAt: new Date().toISOString(),
    dryRun: !apply,
    rpcEndpoint: RPC_ENDPOINT,
    wallet: wallet.pubkey.toBase58(),
    toleranceSol,
    plan: plan.counts,
    summary,
    rows,
    skipped: plan.skipped,
    note: summary.note,
  };

  const dataDir = path.resolve(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const reportPath = path.join(dataDir, `reconciliation-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("\n──────────────────────────────────────────────────────────────");
    console.log(` reconciliados : ${summary.reconciled}`);
    console.log(` recusados     : ${summary.refused}${Object.keys(summary.byRefusal).length ? ` (${Object.entries(summary.byRefusal).map(([k, v]) => `${k}: ${v}`).join(", ")})` : ""}`);
    console.log(` fora da fila  : ${summary.skipped}`);
    console.log(` PnL somado dos reconciliados: ${summary.totalPnlSol >= 0 ? "+" : ""}${summary.totalPnlSol} SOL (medido, ciclo completo)`);
    console.log(` relatório     : ${reportPath}`);
    console.log(
      apply
        ? " ✔ APLICADO: os registros reconciliados foram gravados (base round_trip_legs_reconciled)."
        : " ⚠ DRY-RUN: NADA foi gravado. Rode com -- --apply para gravar."
    );
    console.log("──────────────────────────────────────────────────────────────\n");
  }
}

main().catch((err) => {
  console.error("Falha na reconciliação:", err?.message ?? err);
  process.exit(1);
});
