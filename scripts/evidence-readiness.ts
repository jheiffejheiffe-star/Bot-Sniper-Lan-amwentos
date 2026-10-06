/**
 * `npm run evidence` — PRONTIDÃO DA EVIDÊNCIA (B): quantos desfechos MEDIDOS existem e o que falta.
 *
 * ## Por que este script existe
 *
 * A conclusão estatística exige `>= 100` desfechos com PnL de CICLO medido (`net_measured`). O
 * número não pode ser estimado de memória nem inferido do total de registros: no mesmo banco convivem
 * resultados medidos, medições de UMA perna (receita, não lucro), resultados de sombra e tentativas
 * falhadas — e somar tudo isso como "amostra" é o erro que infla a confiança.
 *
 * Este script NÃO inventa dado nenhum: ele lê o banco operacional, aplica a MESMA régua do
 * `/api/performance` (`labelAll`) e diz exatamente quantos desfechos contam, quantos faltam e por que
 * cada um dos outros está fora.
 *
 * ## O que este script NÃO faz
 *
 * - Não mede nada na cadeia, não assina, não envia, não toca chave privada.
 * - Não escreve no banco (só leitura) e não altera estado.
 * - Não transforma "amostra pequena" em "quase validado": sem 100 desfechos a resposta é `faltam N`.
 *
 * ## Como usar
 *
 *   npm run evidence            # relatório legível
 *   npm run evidence -- --json  # máquina
 *   npm run evidence -- --strict   # exit 1 quando faltam desfechos (para usar como gate)
 *
 * Exit codes: 0 = relatório gerado; 1 = faltam desfechos E `--strict`; 2 = erro de execução.
 */

import { dbStore } from "../src/persistence.js";
import { labelAll } from "../src/outcomeLabels.js";
import { MIN_TRADES_FOR_CONFIDENCE } from "../src/accounting.js";

const asJson = process.argv.includes("--json");
const strict = process.argv.includes("--strict");

const trades = dbStore.getTrades() as any[];
const positions = dbStore.getPositions() as any[];
const rotulados = labelAll(trades, positions);

const elegiveis = rotulados.filter((l) => l.basis === "net_measured" && !l.excluded && l.mode === "live" && l.pnlNetSol !== null);
const faltam = Math.max(0, MIN_TRADES_FOR_CONFIDENCE - elegiveis.length);

/** Histograma do que está FORA, pelo motivo declarado (nada é agrupado em "outros"). */
const motivos = new Map<string, number>();
for (const l of rotulados) {
  if (elegiveis.includes(l)) continue;
  const chave = l.exclusionReason ?? (l.basis === "price_estimated" ? "base estimada (preço, sem custos)" : `basis=${l.basis}`);
  motivos.set(chave, (motivos.get(chave) ?? 0) + 1);
}
const porBasis = new Map<string, number>();
for (const l of rotulados) porBasis.set(l.basis, (porBasis.get(l.basis) ?? 0) + 1);

const ganhos = elegiveis.filter((l) => (l.pnlNetSol as number) > 0).length;
const perdas = elegiveis.filter((l) => (l.pnlNetSol as number) < 0).length;
const somaSol = elegiveis.reduce((acc, l) => acc + (l.pnlNetSol as number), 0);

const relatorio = {
  generatedAt: new Date().toISOString(),
  fonte: "banco operacional desta instância (dbStore) — o backend em vigor é declarado em GET /api/storage",
  minimoParaConclusao: MIN_TRADES_FOR_CONFIDENCE,
  registros: { trades: trades.length, posicoesFechadas: positions.filter((p) => p.status === "closed").length },
  elegiveis: { total: elegiveis.length, ganhos, perdas, empates: elegiveis.length - ganhos - perdas, somaPnlSol: Number(somaSol.toFixed(9)) },
  faltam,
  conclusao:
    elegiveis.length === 0
      ? "SEM AMOSTRA: nenhum desfecho com PnL de ciclo medido. Nada pode ser dito sobre a estratégia."
      : faltam > 0
        ? `AMOSTRA INSUFICIENTE: faltam ${faltam} desfecho(s) medidos para o mínimo de ${MIN_TRADES_FOR_CONFIDENCE}.`
        : `AMOSTRA ATINGIDA (${elegiveis.length} desfechos medidos): a análise estatística passa a ter base — o que NÃO garante lucro futuro.`,
  porBasis: Object.fromEntries(porBasis),
  foraPorMotivo: Object.fromEntries(motivos),
  comoAumentarAmostra: [
    "registros reais já fechados sem a perna de entrada medida: `npm run reconcile` (S14) fecha o ciclo por releitura da cadeia",
    "o restante exige execução real (o PAPER é declaradamente excluído da validação)",
  ],
};

if (asJson) {
  console.log(JSON.stringify(relatorio, null, 2));
} else {
  console.log("\n════════════════════════════════════════════════════════════════");
  console.log(" PRONTIDÃO DA EVIDÊNCIA (B) — amostra para a validação estatística");
  console.log("════════════════════════════════════════════════════════════════");
  console.log(` fonte      : ${relatorio.fonte}`);
  console.log(` registros  : ${trades.length} trade(s), ${relatorio.registros.posicoesFechadas} posição(ões) fechada(s)`);
  console.log(` elegíveis  : ${elegiveis.length} de ${MIN_TRADES_FOR_CONFIDENCE} necessários (net_measured + live)`);
  if (elegiveis.length > 0) {
    console.log(` resultado  : ${ganhos} ganho(s), ${perdas} perda(s), ${elegiveis.length - ganhos - perdas} empate(s) | soma ${somaSol >= 0 ? "+" : ""}${somaSol.toFixed(9)} SOL`);
  }
  console.log(`\n ${relatorio.conclusao}`);
  console.log("\n POR BASE:");
  for (const [b, n] of porBasis) console.log(`   ${b.padEnd(20)} ${n}`);
  if (motivos.size > 0) {
    console.log("\n FORA DA VALIDAÇÃO (por motivo):");
    for (const [m, n] of motivos) console.log(`   ${String(n).padStart(4)}  ${m}`);
  }
  console.log("\n COMO AUMENTAR A AMOSTRA:");
  for (const c of relatorio.comoAumentarAmostra) console.log(`   · ${c}`);
  console.log("════════════════════════════════════════════════════════════════\n");
}

process.exit(strict && faltam > 0 ? 1 : 0);
