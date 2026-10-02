/**
 * replay — compara estratégias de SAÍDA sobre o que o bot realmente viu.
 *
 * Por que este script existe
 * --------------------------
 * O bot grava, em `data/events.jsonl`, três coisas por candidato:
 *   1. o evento de lançamento (mint, slot, fonte);
 *   2. a avaliação de risco — INCLUSIVE quando o token foi REJEITADO;
 *   3. a série temporal de preços observada enquanto a posição esteve aberta.
 *
 * Sem isso, qualquer discussão sobre stop/take-profit/trailing é opinião. Com isso, é
 * possível responder à única pergunta que importa antes de arriscar capital: "a regra de
 * saída que eu escolhi tem vantagem sobre simplesmente segurar, DEPOIS dos custos?".
 *
 * O que este script NÃO faz (e não finge fazer)
 * --------------------------------------------
 *  - Não simula latência de rede nem inclusão de transação.
 *  - Não simula profundidade de livro: assume que a observação de preço seria executável.
 *  - Não preenche lacunas: episódio sem série de preços é contado como não analisável.
 *  - Não produz ranking quando a amostra é pequena: com poucos trades, ordenar estratégias
 *    por expectativa é ordenar ruído.
 *
 * Uso
 * ---
 *   npm run replay                       # todas as estratégias, filtro 'all'
 *   npm run replay -- --filter accepted-only
 *   npm run replay -- --json             # saída de máquina (pipe para jq)
 *   npm run replay -- --file data/events.jsonl --size 0.1
 */

import { loadBacktestDataset, listDataFiles } from "../src/eventRecorder.js";
import { compareStrategies, DEFAULT_STRATEGIES, type EpisodeFilter } from "../src/replay.js";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const next = process.argv[idx + 1];
  return next && !next.startsWith("--") ? next : "";
}

const asJson = process.argv.includes("--json");
const fileArg = argValue("--file");
const filterArg = (argValue("--filter") ?? "all") as EpisodeFilter;
const sizeArg = argValue("--size");

const VALID_FILTERS: EpisodeFilter[] = ["all", "accepted-only", "rejected-only", "no-assessment"];
if (!VALID_FILTERS.includes(filterArg)) {
  console.error(`Filtro inválido: "${filterArg}". Use um de: ${VALID_FILTERS.join(", ")}`);
  process.exit(2);
}

const sizeSol = sizeArg ? Number(sizeArg) : undefined;
if (sizeArg && (!Number.isFinite(sizeSol!) || sizeSol! <= 0)) {
  console.error(`--size inválido: "${sizeArg}". Esperado número > 0 em SOL.`);
  process.exit(2);
}

let dataset;
try {
  dataset = loadBacktestDataset(fileArg || undefined);
} catch (err: any) {
  console.error(`Não foi possível ler o arquivo de eventos: ${err.message}`);
  console.error("O arquivo é criado pelo próprio bot ao processar eventos. Sem eventos, não há replay.");
  process.exit(1);
}

if (dataset.records === 0) {
  console.error(`Arquivo de eventos vazio ou inexistente: ${dataset.path}`);
  console.error("Nenhum dado gravado ainda — rode o bot em modo paper/shadow por um período antes de tirar conclusões.");
  const files = listDataFiles();
  if (files.length) console.error(`Arquivos encontrados em data/: ${files.join(", ")}`);
  process.exit(1);
}

const comparison = compareStrategies(dataset, DEFAULT_STRATEGIES, {
  filter: filterArg,
  ...(sizeSol !== undefined ? { sizeSol } : {}),
});

if (asJson) {
  console.log(JSON.stringify({ datasetStats: dataset.stats, comparison }, null, 2));
  process.exit(0);
}

/* ------------------------------- SAÍDA HUMANA ------------------------------ */

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const sol = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(6)} SOL`;

console.log("");
console.log("REPLAY DE ESTRATÉGIAS DE SAÍDA — dados observados pelo próprio bot");
console.log("=".repeat(78));
console.log(`Arquivo .......... ${dataset.path}`);
console.log(`Registros ........ ${dataset.records}${dataset.corruptedLines ? ` (${dataset.corruptedLines} linha(s) corrompida(s) ignorada(s))` : ""}`);
console.log(`Lançamentos ...... ${dataset.stats.launchEvents}`);
console.log(`Avaliações ....... ${dataset.stats.assessments} (aprovadas: ${dataset.stats.accepted}, rejeitadas: ${dataset.stats.rejected})`);
console.log(`Taxa de aceite ... ${pct(dataset.stats.acceptanceRate)}`);
console.log(`Obs. de preço .... ${dataset.stats.priceObservations}`);
console.log(`Mints s/ preço ... ${dataset.stats.mintsWithoutPrices} (não analisáveis)`);
console.log(`Filtro ........... ${filterArg}`);
console.log(`Tamanho posição .. ${comparison.sizeSol} SOL`);
console.log("");

console.log("COMPARAÇÃO (líquido = depois de custos de round-trip)");
console.log("-".repeat(78));
const header = ["estratégia", "trades", "expect. líq.", "win", "PF", "DD", "vs base"];
console.log(header.map((h, i) => h.padEnd([22, 7, 15, 7, 7, 11, 8][i])).join(""));
for (const row of comparison.rows) {
  console.log(
    [
      row.strategy.padEnd(22),
      String(row.trades).padEnd(7),
      sol(row.expectancyNetSol).padEnd(15),
      pct(row.winRate).padEnd(7),
      (Number.isFinite(row.profitFactor) ? row.profitFactor.toFixed(2) : "inf").padEnd(7),
      row.maxDrawdownSol.toFixed(6).padEnd(11),
      (row.beatsBaseline ? "sim" : "não").padEnd(8),
    ].join("")
  );
}
console.log("");
console.log(`Linha de base obrigatória: ${comparison.baselineName} — segurar até o timeout, sem stop nem alvo.`);
const winners = comparison.rows.filter((r) => r.beatsBaseline);
if (winners.length === 0) {
  console.log("NENHUMA estratégia superou a linha de base nesta amostra: as regras de saída");
  console.log("não se pagaram. A hipótese mais parcimoniosa é a de que os custos consumiram");
  console.log("o que o gatilho tentou capturar.");
} else {
  console.log(
    `Superaram a base (${winners.length}): ` +
      winners.map((r) => `${r.strategy} (${sol(r.expectancyNetSol)} vs ${sol(comparison.baselineExpectancyNetSol)})`).join(", ")
  );
  console.log(
    `IMPORTANTE: superar a base sem significância estatística pode ser sorte (nesta amostra, ${comparison.baselineTrades} operações na base).`
  );
}
console.log("");

if (comparison.ranking.length === 0) {
  console.log("RANKING OMITIDO: amostra insuficiente para distinguir estratégias de ruído.");
} else {
  console.log(`Ranking por expectativa líquida: ${comparison.ranking.join(" > ")}`);
}
console.log("");
console.log("LIMITAÇÕES (leia antes de agir sobre estes números):");
for (const note of comparison.notes) console.log(`  - ${note}`);
console.log("");
