/**
 * CLI DE QUARENTENA DO BANCO OPERACIONAL.
 *
 * Uso:
 *   npm run quarantine                                   # dry-run no banco padrão
 *   npm run quarantine -- --file ./hft_operational_db.json --include-unmigrated
 *   npm run quarantine -- --apply                        # grava (com backup)
 *
 * Segurança: por padrão NÃO grava nada. O `--apply` exige que o servidor esteja parado
 * (dois processos escrevendo o mesmo JSON produzem perda de dados). Nada é apagado: as
 * posições movidas ganham `status: "quarantined"` + motivos, e um arquivo de quarentena
 * separado é criado com os registros completos.
 *
 * Sair com código 2 quando houver posições `invalid` no dry-run é proposital: torna o
 * problema visível em qualquer pipeline/CI, em vez de depender de alguém ler a saída.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { applyQuarantine, planQuarantine, type PositionLike } from "../src/dbQuarantine.js";

interface DbShape {
  positions?: PositionLike[];
  [key: string]: unknown;
}

function parseArgs(argv: string[]) {
  const args = { file: path.join(process.cwd(), "hft_operational_db.json"), apply: false, includeUnmigrated: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") args.file = argv[++i] ?? args.file;
    else if (a === "--apply") args.apply = true;
    else if (a === "--include-unmigrated") args.includeUnmigrated = true;
    else if (a === "--json") args.json = true;
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.file)) {
    console.error(`Banco não encontrado: ${args.file}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(args.file, "utf8");
  let db: DbShape;
  try {
    db = JSON.parse(raw);
  } catch (err: any) {
    console.error(`Banco ilegível (JSON inválido): ${err.message}. Nada foi alterado.`);
    process.exit(1);
  }

  if (!Array.isArray(db.positions)) {
    console.error("Banco sem array `positions` — formato inesperado. Nada foi alterado.");
    process.exit(1);
  }

  const plan = planQuarantine(db.positions, { includeUnmigrated: args.includeUnmigrated });

  if (args.json) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(`Arquivo: ${args.file}`);
    console.log(`Posições: ${db.positions.length} (inválidas: ${plan.invalid.length}, suspeitas: ${plan.suspect.length}, ok: ${plan.ok.length})`);
    console.log("");
    for (const c of [...plan.invalid, ...(args.includeUnmigrated ? plan.suspect : [])]) {
      console.log(`  [${c.verdict}] ${c.id} — ${c.token} — ${c.reasons.join("; ")}`);
    }
    if (!args.includeUnmigrated && plan.suspect.length > 0) {
      console.log("");
      console.log(
        `  ${plan.suspect.length} posição(ões) SUSPEITA(S) (sem campo \`mode\`, típicas de histórico ` +
          `anterior às correções). Não entram no plano sem --include-unmigrated.`
      );
    }
    console.log("");
    console.log(
      `Plano: mover ${plan.toMove.length} posição(ões) para status "quarantined" ` +
        `(${args.apply ? "APLICANDO" : "dry-run — nada será gravado; use --apply para gravar"}).`
    );
  }

  if (!args.apply) {
    console.log("");
    console.log(
      "Classificação ESTRUTURAL: não houve consulta on-chain. `invalid` = impossível gerir; " +
        "`suspect` = sem modo gravado. A decisão final é do operador."
    );
    process.exit(plan.invalid.length > 0 ? 2 : 0);
  }

  if (plan.toMove.length === 0) {
    console.log("Nada a mover. Banco inalterado.");
    process.exit(0);
  }

  const at = new Date().toISOString();
  const { next, moved } = applyQuarantine(db.positions, plan, at);
  const backupPath = args.file.replace(/\.json$/, "") + `.quarantine.${at.replace(/[:.]/g, "-")}.json`;

  fs.writeFileSync(
    backupPath,
    JSON.stringify(
      {
        generatedAt: at,
        sourceFile: args.file,
        criteria: {
          invalid: "sizeSol <= 0 ou mint ausente/não-base58",
          suspect: "sem campo `mode` (paper/live)",
          includeUnmigrated: args.includeUnmigrated,
        },
        note:
          "Registro das posições quarentenadas. Nada foi apagado do banco: elas continuam lá " +
          "com status \"quarantined\" e os motivos. Este arquivo é o inventário independente.",
        positions: moved.map((c) => ({
          ...(db.positions ?? []).find((p) => String(p?.id) === c.id),
          quarantineReasons: c.reasons,
          quarantinedAt: at,
        })),
      },
      null,
      2
    ),
    "utf8"
  );

  const nextDb: DbShape = { ...db, positions: next };
  const tmpPath = `${args.file}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(nextDb, null, 2), "utf8");
  fs.renameSync(tmpPath, args.file); // atômico: nunca deixa o banco pela metade

  console.log(`Quarentena aplicada: ${moved.length} posição(ões) em "${at}".`);
  console.log(`  inventário: ${backupPath}`);
  console.log(`  banco atualizado: ${args.file} (backup anterior do banco não foi tocado)`);
}

main();
