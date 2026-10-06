/**
 * QUALIDADE DO PREÇO DE ENTRADA — a última fonte única do fluxo.
 *
 * ## O que faz
 *
 * Classifica o preço que será usado para ABRIR posição, com base em quantas fontes
 * independentes o confirmaram e no quanto elas concordam. É a mesma pergunta que o
 * gerenciador de posição já faz a cada ciclo (`priceQuality.ts`), aplicada ao momento em que
 * o preço deixa de ser telemetria e passa a ser **preço de compra**.
 *
 * ## Por que isto importa mais do que parece
 *
 * O preço de entrada é o denominador de TODO o PnL da posição: `pnlPercent` é calculado
 * contra ele, o stop-loss e o take-profit são percentuais dele, e o replay usa esse número
 * como ponto zero. Se o preço de entrada estiver errado por 30%, todas as decisões seguintes
 * (e a estatística que diz se a estratégia tem ou não edge) estão contaminadas — e o operador
 * não tem como saber, porque nada no registro aponta a dúvida.
 *
 * Uma fonte só não responde a pergunta "esse preço é real?": responde "esse preço foi lido uma
 * vez". Duas fontes independentes discordando são EVIDÊNCIA de erro (pool raso, par errado,
 * decimal trocado, cache velho). Duas concordando não provam verdade, mas excluem os erros
 * grosseiros — que são os que doem.
 *
 * ## Regras (explícitas, não implícitas)
 *
 * - `verified`              — duas fontes independentes concordam dentro do limiar de aviso.
 * - `verified_with_warning` — concordam, mas a diferença passou de `warnPct`: aceita e REGISTRA
 *                             que o preço entrou sob aviso.
 * - `divergent`            — diferença ≥ `criticalPct`: **recusa** por padrão. O risco não é
 *                             "o preço está um pouco diferente", é "uma das fontes está
 *                             estruturalmente errada" — e abrir posição nesse estado é
 *                             envenenar o histórico inteiro.
 * - `single_source`        — só uma fonte respondeu: aceita (senão o bot pararia de operar cada
 *                             vez que uma API gratuita piscasse), mas marca a posição como
 *                             NÃO verificada, para que o replay possa separar os dois grupos
 *                             depois. Recusar por padrão seria confundir "sem prova de verdade"
 *                             com "prova de erro".
 * - `unavailable`          — nenhuma fonte trouxe preço: recusa. Nunca inventa.
 *
 * ## Limite honesto
 *
 * Duas fontes podem repetir o MESMO erro (ambas lendo o mesmo pool raso, por exemplo). Este
 * módulo reduz erro grosseiro; não certifica verdade. E o inverso também vale: token novo com
 * pool único pode divergir por diferença de horário de leitura em mercado em movimento — por
 * isso a divergência carrega a IDADE da amostra de referência, e o limiar é parâmetro.
 *
 * ## Dependências
 *
 * Nenhuma além de `priceQuality.ts` (funções puras, sem rede, sem relógio próprio).
 *
 * ## Como testar
 *
 * `npm run test` — grupo [22]: as cinco classificações, recusa em divergência crítica, aceitação
 * de fonte única, preço inválido, e uma checagem de que o caminho de entrada do `server.ts`
 * realmente usa este módulo (regressão: alguém pode reintroduzir fonte única sem perceber).
 *
 * ## Como colocar em produção
 *
 * `HFT_ENTRY_VERIFY=0` desliga (volta a aceitar a primeira fonte, sem marcação).
 * `HFT_ENTRY_DIVERGENCE_CRITICAL_BPS` ajusta o limiar de recusa. As estatísticas saem em
 * `GET /api/health → entryQuality`, e cada posição carrega `entryPriceVerification`.
 */

import type { DivergenceFinding, DivergenceThresholds } from "./priceQuality.js";

export type EntryPriceStatus =
  | "verified"
  | "verified_with_warning"
  | "single_source"
  | "divergent"
  | "unavailable";

export interface EntryPriceAssessment {
  status: EntryPriceStatus;
  /** Preço em SOL a usar na entrada. `null` apenas quando não há preço algum. */
  priceSol: number | null;
  /** Fontes independentes que responderam para este token (a principal + a da verificação). */
  sources: string[];
  /** Diferença relativa entre as fontes (0,05 = 5%); `null` quando não houve segunda opinião. */
  divergenceBps: number | null;
  severity: "ok" | "warn" | "critical" | null;
  /** A política permite abrir posição com este preço? */
  accepted: boolean;
  /** Motivo em texto — vai para o log, nunca fica só no booleano. */
  reason: string;
}

export interface EntryAssessmentInput {
  /** Preço vencedor da cascata (o que seria usado antes desta verificação). */
  quote: { priceSol: number | null; source: string } | null | undefined;
  /** Resultado da comparação com a segunda fonte, quando ela existiu. */
  comparison?:
    | {
        referenceSource: string;
        candidateSource: string;
        bps: number;
        severity: "ok" | "warn" | "critical";
      }
    | null;
  thresholds: DivergenceThresholds;
  /**
   * Aceitar entrada com apenas UMA fonte? Padrão `true` — com justificativa explícita: numa
   * fase de teste em plano gratuito, uma API indisponível não pode zerar a coleta de dados,
   * e a posição fica MARCADA como não verificada. Quem for operar capital real pode virar isto
   * para `false` e exigir duas fontes.
   */
  allowSingleSource?: boolean;
  /** Kill switch da própria verificação. Com `false`, o preço da cascata é aceito sem marcação. */
  enabled?: boolean;
}

/** Faixa de severidade a partir dos bps, usando os MESMOS limiares da gestão de posição. */
function severityFromBps(bps: number, thresholds: DivergenceThresholds): "ok" | "warn" | "critical" {
  const pct = bps / 10_000;
  if (pct >= thresholds.criticalPct) return "critical";
  if (pct >= thresholds.warnPct) return "warn";
  return "ok";
}

/**
 * Classifica o preço de entrada. Função PURA: recebe o que foi observado e devolve o veredito,
 * sem tocar em rede, relógio ou banco — é por isso que dá para testar todas as combinações.
 */
export function assessEntryPrice(input: EntryAssessmentInput): EntryPriceAssessment {
  const { quote, comparison, thresholds } = input;
  const enabled = input.enabled !== false;
  const allowSingleSource = input.allowSingleSource !== false;

  const priceSol =
    quote && typeof quote.priceSol === "number" && Number.isFinite(quote.priceSol) && quote.priceSol > 0
      ? quote.priceSol
      : null;

  if (priceSol === null) {
    return {
      status: "unavailable",
      priceSol: null,
      sources: [],
      divergenceBps: null,
      severity: null,
      accepted: false,
      reason: "nenhuma fonte trouxe preço em SOL para este token (não existe preço para inventar)",
    };
  }

  const firstSource = quote?.source ?? "fonte desconhecida";

  // Verificação desligada: aceita o preço da cascata, mas o status diz que não houve checagem.
  if (!enabled) {
    return {
      status: "single_source",
      priceSol,
      sources: [firstSource],
      divergenceBps: null,
      severity: null,
      accepted: true,
      reason: "verificação de entrada DESLIGADA (HFT_ENTRY_VERIFY=0): preço aceito sem segunda opinião",
    };
  }

  if (!comparison) {
    return {
      status: "single_source",
      priceSol,
      sources: [firstSource],
      divergenceBps: null,
      severity: null,
      accepted: allowSingleSource,
      reason:
        "apenas uma fonte respondeu para este token: o preço é aceito como NÃO verificado " +
        "(isso não é prova de erro — é ausência de segunda opinião)",
    };
  }

  const bps = Number.isFinite(comparison.bps) ? Math.max(0, Math.round(comparison.bps)) : 0;
  const severity = severityFromBps(bps, thresholds);
  const sources = [comparison.referenceSource, comparison.candidateSource];
  const base = { priceSol, sources, divergenceBps: bps, severity };

  if (severity === "critical") {
    return {
      ...base,
      status: "divergent",
      accepted: false,
      reason:
        `fontes INDEPENDENTES discordam em ${(bps / 100).toFixed(2)}% (≥ ${(thresholds.criticalPct * 100).toFixed(2)}%): ` +
        `${comparison.referenceSource} vs ${comparison.candidateSource}. Uma delas está estruturalmente errada ` +
        `(pool raso, par errado, decimal trocado ou cache velho) — abrir posição aqui envenena PnL, stop e replay`,
    };
  }

  if (severity === "warn") {
    return {
      ...base,
      status: "verified_with_warning",
      accepted: true,
      reason:
        `duas fontes concordam dentro do tolerável, com aviso: ${(bps / 100).toFixed(2)}% de diferença ` +
        `(≥ ${(thresholds.warnPct * 100).toFixed(2)}%) entre ${comparison.referenceSource} e ${comparison.candidateSource}`,
    };
  }

  return {
    ...base,
    status: "verified",
    accepted: true,
    reason: `duas fontes independentes concordam (${(bps / 100).toFixed(2)}% de diferença): ${sources.join(" + ")}`,
  };
}

/**
 * Converte um achado de divergência (`priceQuality`) na forma usada aqui.
 *
 * Existe para que o chamador não precise remontar o objeto — e para que a regra de "mesma fonte
 * não é divergência" continue vindo de um lugar só.
 */
export function comparisonFromFinding(
  finding: Pick<DivergenceFinding, "reference" | "candidate" | "bps" | "severity">
): NonNullable<EntryAssessmentInput["comparison"]> {
  return {
    referenceSource: finding.reference.source,
    candidateSource: finding.candidate.source,
    bps: finding.bps,
    severity: finding.severity,
  };
}
