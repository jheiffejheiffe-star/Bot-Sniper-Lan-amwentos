/**
 * `npm run cost:roundtrip` — CUSTO DA VOLTA (A): o piso de custo de um ciclo completo, sem rede,
 * sem chave e sem capital.
 *
 * ## Por que este script existe
 *
 * Em PAPER, o resultado era `sizeSol * pnlPercent / 100` — só movimento de PREÇO. Custo zero. Isso
 * faz um "+2%" na sombra parecer ganho mesmo quando o ciclo real paga fee base nas duas pernas, tip
 * do Jito (com teto de 50 bps = ~1% do capital nas DUAS pernas) e priority fee. Este script
 * responde à pergunta que precede qualquer conversa de lucro: **quanto o ciclo custa antes de o
 * preço se mover?**
 *
 * ## O que este script NÃO faz
 *
 * - **Não mede slippage real, impacto de preço nem o tip pago**: exige execução real. Slippage e fee
 *   de AMM aparecem como PREMISSAS declaradas; sem `HFT_PRIORITY_FEE_MICROLAMPORTS` o piso é
 *   explicitamente um LIMITE INFERIOR.
 * - **Não prevê resultado**: um piso de custo não diz nada sobre o preço do ativo.
 * - **Não usa rede, não lê chave, não grava em banco**: só aritmética sobre política declarada.
 *
 * ## Como usar
 *
 *   npm run cost:roundtrip                          # varredura de tamanhos (0,01 → 1 SOL)
 *   npm run cost:roundtrip -- --size 0.01 --pnl-percent 2
 *   npm run cost:roundtrip -- --json
 *   npm run cost:roundtrip -- --priority-microlamports 100000 --cu 200000
 *
 * Exit code: 0 sempre que o cálculo roda (é medição, não gate). `--json` para máquina.
 */

import {
  applyCostFloorToPaperClose,
  paperRoundTripCostFloor,
  resolveRoundTripCostPolicy,
} from "../src/roundTripCost.js";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const next = process.argv[idx + 1];
  return next && !next.startsWith("--") ? next : "";
}

function numFlag(flag: string): number | undefined {
  const raw = argValue(flag);
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

const asJson = process.argv.includes("--json");
const policy = resolveRoundTripCostPolicy();

// Overrides por flag (declarados no relatório como tal).
if (numFlag("--tip") !== undefined) {
  policy.entryTipDesiredSol = numFlag("--tip") as number;
  policy.exitTipDesiredSol = numFlag("--tip") as number;
  policy.sources.entryTipDesiredSol = "--tip";
  policy.sources.exitTipDesiredSol = "--tip";
}
if (numFlag("--slippage-bps") !== undefined) {
  policy.slippageBps = numFlag("--slippage-bps") as number;
  policy.sources.slippageBps = "--slippage-bps";
}
if (numFlag("--amm-bps") !== undefined) {
  policy.ammFeeBps = numFlag("--amm-bps") as number;
  policy.sources.ammFeeBps = "--amm-bps";
}
if (numFlag("--priority-microlamports") !== undefined) {
  policy.priorityFeeMicroLamportsPerCu = numFlag("--priority-microlamports") as number;
  policy.sources.priorityFeeMicroLamportsPerCu = "--priority-microlamports";
}
if (numFlag("--cu") !== undefined) {
  policy.computeUnitsPerLeg = numFlag("--cu") as number;
  policy.sources.computeUnitsPerLeg = "--cu";
}

const sizeAlvo = numFlag("--size") ?? 0.01;
const pnlPercent = numFlag("--pnl-percent");
const varredura = [0.01, 0.05, 0.1, 0.5, 1];

/** Formata em SOL com 9 casas (lamport) e em % do capital — nunca um número sem a sua unidade. */
const sol = (v: number) => `${v.toFixed(9)} SOL`;
const pct = (v: number, base: number) => (base > 0 ? `${((v / base) * 100).toFixed(3)}%` : "n/a");

const floor = paperRoundTripCostFloor({ sizeSol: sizeAlvo, policy });

if (asJson) {
  const out: any = {
    policy,
    floor,
    varredura: varredura.map((s) => {
      const f = paperRoundTripCostFloor({ sizeSol: s, policy });
      return {
        sizeSol: s,
        pisoConhecidoSol: f.pisoConhecidoSol,
        pisoComPremissasSol: f.pisoComPremissasSol,
        breakevenPercentConhecido: f.breakevenPercentConhecido,
        breakevenPercentComPremissas: f.breakevenPercentComPremissas,
      };
    }),
  };
  if (pnlPercent !== undefined) out.cenario = applyCostFloorToPaperClose({ sizeSol: sizeAlvo, pnlPercent, policy });
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

console.log("\n════════════════════════════════════════════════════════════════════");
console.log(" CUSTO DA VOLTA (A) — piso de custo do ciclo entrada+saída");
console.log("════════════════════════════════════════════════════════════════════");
console.log(" POLÍTICA (cada valor com a sua procedência):");
for (const [k, v] of Object.entries(policy)) {
  if (k === "sources") continue;
  console.log(`   ${k.padEnd(32)} ${String(v).padEnd(12)} ← ${(policy.sources[k] ?? "?").toString()}`);
}

console.log(`\n CICLO DE ${sizeAlvo} SOL`);
for (const leg of floor.legs) {
  console.log(
    `   ${leg.leg === "entry" ? "entrada" : "saída  "}: tip ${sol(leg.tipSol)}${leg.tipClamped ? " (LIMITADO pelo teto em bps)" : ""}` +
      ` + base ${sol(leg.baseFeeSol)} + priority ${leg.priorityFeeSol === null ? "NÃO DECLARADA" : sol(leg.priorityFeeSol)}`
  );
}
console.log(`   ${"─".repeat(62)}`);
console.log(`   PISO CONHECIDO (limite inferior) : ${sol(floor.pisoConhecidoSol)} = ${pct(floor.pisoConhecidoSol, sizeAlvo)} do capital`);
console.log(`   + premissas (slippage+AMM)      : ${sol(floor.premissasSol)}`);
console.log(`   PISO COM PREMISSAS              : ${sol(floor.pisoComPremissasSol)} = ${pct(floor.pisoComPremissasSol, sizeAlvo)} do capital`);
console.log(`   Break-even: ${floor.breakevenPercentConhecido.toFixed(3)}% (conhecido) / ${floor.breakevenPercentComPremissas.toFixed(3)}% (com premissas)`);

console.log("\n CONDICIONAIS (não somados ao piso):");
for (const c of floor.condicionais) console.log(`   · ${c.label}: ${sol(c.sol as number)} — ${c.reason}`);
console.log("\n NÃO MEDIDOS (por que não estão no número):");
for (const n of floor.naoMedidos) console.log(`   · ${n.key}: ${n.reason}`);
console.log("\n LIMITAÇÕES DECLARADAS:");
for (const l of floor.limitacoes) console.log(`   ⚠ ${l}`);

if (pnlPercent !== undefined) {
  const c = applyCostFloorToPaperClose({ sizeSol: sizeAlvo, pnlPercent, policy });
  console.log(`\n CENÁRIO: movimento de preço de ${pnlPercent >= 0 ? "+" : ""}${pnlPercent}% em ${sizeAlvo} SOL`);
  console.log(`   bruto (só preço)          : ${sol(c.pnlGrossSol)}`);
  console.log(`   líquido do piso conhecido : ${sol(c.pnlNetKnownSol)}`);
  console.log(`   líquido com premissas     : ${sol(c.pnlNetWithAssumptionsSol)}`);
  const veredito =
    c.pnlNetKnownSol > 0 && c.pnlNetWithAssumptionsSol > 0
      ? "positivo nos dois cenários"
      : c.pnlNetKnownSol > 0
      ? "POSITIVO só no limite inferior — com as premissas de slippage/AMM vira PREJUÍZO"
      : "PREJUÍZO mesmo antes das premissas";
  console.log(`   ⇒ ${veredito}`);
}

console.log("\n VARREDURA POR TAMANHO (o custo fixo pesa mais no tamanho pequeno):");
console.log("   tamanho      piso conhecido      % do capital    piso c/ premissas    % do capital");
for (const s of varredura) {
  const f = paperRoundTripCostFloor({ sizeSol: s, policy });
  console.log(
    `   ${String(s).padEnd(11)} ${sol(f.pisoConhecidoSol).padEnd(20)} ${pct(f.pisoConhecidoSol, s).padEnd(15)} ${sol(f.pisoComPremissasSol).padEnd(20)} ${pct(f.pisoComPremissasSol, s)}`
  );
}
console.log("\n " + floor.note);
console.log("════════════════════════════════════════════════════════════════════\n");
