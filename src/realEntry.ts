/**
 * REAL ENTRY (S6) — o caminho de ENTRADA on-chain, com travas declaradas.
 *
 * ## O que faz
 *
 * Orquestra a entrada real em uma posição: cota (Jupiter) → constrói a transação de swap →
 * SIMULA (pré-flight) → substitui o blockhash por um monitorado → assina e envia via bundle
 * Jito (pelo cofre, fora deste arquivo) → confirma → lê o PREENCHIMENTO real da transação
 * confirmada. Devolve um resultado TIPADO em que `confirmed` só existe com slot observado.
 *
 * ## Como funciona (e por que é seguro por construção)
 *
 * 1. **Este módulo não tem acesso a chave.** Ele não importa `security`, não importa
 *    `@solana/web3.js` e não serializa transação. Assinar+enviar é UMA capacidade injetada
 *    (`signAndSubmit`) — o mesmo padrão de `shadowEntry.ts`, onde a interface simplesmente
 *    não oferece a capacidade perigosa. Aqui ela é oferecida, mas isolada: se o cofre
 *    recusar, o módulo recebe a recusa e a reporta; nunca contorna.
 * 2. **Nada é assinado sem pré-flight.** A simulação (`simulateTransaction`) roda ANTES de
 *    `signAndSubmit`. Se a simulação falha, o resultado é `refused` com os logs do programa:
 *    nenhuma taxa é gasta para descobrir o que uma simulação diria de graça.
 * 3. **O blockhash é substituído por um monitorado.** A transação do agregador vem com um
 *    blockhash de terceiro, cuja validade não conseguimos provar. Trocamos pelo do
 *    `RecentBlockhashCache` (com `lastValidBlockHeight`) — sem prova de expiração, uma
 *    retentativa não pode ser decidida (a política de intenção exige a prova).
 * 4. **`confirmed` exige slot.** `submitted_unconfirmed` é um estado PRÓPRIO: o bundle foi
 *    aceito pelo block engine, e a própria doc do Jito diz que isso não garante execução.
 *    Colapsar isso em "sucesso" é exatamente o erro que produziu PnL fabricado nesta base.
 * 5. **Teto canário é teto, não sugestão.** `HFT_CANARY_MAX_SOL` (default 0,01) limita o
 *    tamanho de QUALQUER entrada real, inclusive na primeira. O teto é conferido na função
 *    pura de gate — testável sem rede, sem cofre e sem RPC.
 *
 * ## Dependências
 *
 * - NENHUMA em runtime: todo efeito externo é injetado. O módulo não importa `web3.js`,
 *   `security` nem `telemetry` — não tem como alcançar chave, rede ou relógio global.
 *   O chamador injeta `now()` (monotônico em produção, controlado nos testes).
 * - O servidor injeta: cotação/construção (Jupiter), simulação (RPC), blockhash (cache),
 *   assinatura+envio (cofre + Jito) e confirmação (RPC).
 *
 * ## Riscos
 *
 * 1. **TOCTOU**: a simulação descreve o estado no instante da simulação. Entre simular e
 *    entrar no bloco, o pool muda. É por isso que o slippage vai na instrução (a AMM rejeita
 *    se o preço sair da banda) e que a confirmação é medida no fill real, não na cotação.
 * 2. **Bundle aceito ≠ executado.** Sem consultar `getBundleStatuses`, "aceito" é só isso.
 * 3. **Latência do agregador**: a cotação da Jupiter é um round-trip HTTP. Em lançamento,
 *    isso é decisivo. O caminho nativo por IDL (sem agregador) é a otimização seguinte
 *    (S6b) e NÃO está implementado aqui — a doc do pump mudou o layout de contas em 2025
 *    (fee_config/fee_program/volume accumulators) e montar instrução "de cabeça" queima
 *    taxa e perde a oportunidade. Correção antes de latência.
 * 4. **Rent da ATA**: a primeira compra de um mint cria a conta de token associada
 *    (~0,002 SOL de rent). É custo real e entra no cálculo de custo, não no PnL.
 *
 * ## Como testar
 *
 * `npm run test` (grupo [24]): os gates e a política são funções puras — teto canário,
 * modo não-LIVE, caminho desabilitado, kill switch, read-only, mint inválido, tamanho
 * inválido, posição já aberta, limite de exposição, exigência de simulação.
 *
 * ## Como colocar em produção
 *
 * `RUNTIME_MODE=LIVE` + `LIVE_TRADING_ENABLED=true` (as duas declarações) **e**
 * `HFT_REAL_ENTRY_ENABLED=1` (terceira declaração, específica de entrada). A entrada
 * autônoma exige ainda `HFT_AUTONOMOUS_ENTRY=1`. Sem elas, o caminho real responde
 * `refused` com o código do gate — nunca "silenciosamente paper".
 */

/* -------------------------------------------------------------------------- */
/* 0. TIPOS                                                                    */
/* -------------------------------------------------------------------------- */

export interface RealEntryPolicy {
  /** `HFT_REAL_ENTRY_ENABLED=1` — terceira declaração exigida para operar entrada real. */
  enabled: boolean;
  /** `HFT_AUTONOMOUS_ENTRY=1` — sem isto, só o operador dispara entrada (rota manual). */
  autonomous: boolean;
  /** `HFT_CANARY_MAX_SOL` — teto DURO por entrada, inclusive na primeira. */
  canaryMaxSol: number;
  /** `HFT_CANARY_ONE_ENTRY=1` (default) — depois da primeira entrada real, para. */
  canaryOneEntry: boolean;
  slippageBps: number;
  maxPriceImpactBps: number;
  requirePreflight: boolean;
  maxTipBps: number;
  /** `MAX_TOTAL_EXPOSURE_SOL` — soma de todas as posições abertas; 0 = sem limite declarado. */
  maxTotalExposureSol: number;
}

export const REAL_ENTRY_DEFAULTS = Object.freeze({
  canaryMaxSol: 0.01,
  slippageBps: 300,
  maxPriceImpactBps: 1500,
  maxTipBps: 50,
});

function num(raw: string | undefined, fallback: number): number {
  /**
   * VARIÁVEL AUSENTE ≠ ZERO. `Number("")` é 0 e `Number.isFinite(0)` é true: sem esta
   * linha, um ambiente sem `HFT_CANARY_MAX_SOL` definiria teto canário = 0 SOL (bloqueando
   * tudo) e sem `HFT_ENTRY_SLIPPAGE_BPS` definiria slippage 0 (rejeição garantida). O
   * fallback tem de valer para AUSÊNCIA, e só a presença de valor inválido também cai nele.
   */
  const rawStr = (raw ?? "").trim();
  if (rawStr === "") return fallback;
  const n = Number(rawStr);
  return Number.isFinite(n) ? n : fallback;
}

function flag(raw: string | undefined, fallback = false): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return fallback;
  return v === "1" || v === "true" || v === "yes";
}

/** Resolve a política do ambiente. Pura: o mesmo env produz sempre a mesma política. */
export function resolveRealEntryPolicy(env: NodeJS.ProcessEnv = process.env): RealEntryPolicy {
  return {
    enabled: flag(env.HFT_REAL_ENTRY_ENABLED),
    autonomous: flag(env.HFT_AUTONOMOUS_ENTRY),
    canaryMaxSol: num(env.HFT_CANARY_MAX_SOL, REAL_ENTRY_DEFAULTS.canaryMaxSol),
    canaryOneEntry: flag(env.HFT_CANARY_ONE_ENTRY, true),
    slippageBps: num(env.HFT_ENTRY_SLIPPAGE_BPS, REAL_ENTRY_DEFAULTS.slippageBps),
    maxPriceImpactBps: num(env.HFT_ENTRY_MAX_PRICE_IMPACT_BPS, REAL_ENTRY_DEFAULTS.maxPriceImpactBps),
    requirePreflight: flag(env.HFT_ENTRY_REQUIRE_PREFLIGHT, true),
    maxTipBps: num(env.MAX_TIP_BPS, REAL_ENTRY_DEFAULTS.maxTipBps),
    maxTotalExposureSol: num(env.MAX_TOTAL_EXPOSURE_SOL, 0),
  };
}

export type EntryGateCode =
  | "ENTRY_PATH_DISABLED"
  | "AUTONOMOUS_ENTRY_DISABLED"
  | "MODE_NOT_LIVE"
  | "KILL_SWITCH"
  | "READ_ONLY"
  | "MINT_INVALID"
  | "SIZE_INVALID"
  | "CANARY_CAP_EXCEEDED"
  | "CANARY_ALREADY_USED"
  | "EXPOSURE_LIMIT"
  | "DUPLICATE_OPEN_POSITION"
  | "MAX_POSITION_SOL_EXCEEDED";

export interface EntryGateIssue {
  code: EntryGateCode;
  /** `block` impede a entrada; `warn` acompanha a decisão e é registrado. */
  severity: "block" | "warn";
  message: string;
}

export interface EntryGateInput {
  policy: RealEntryPolicy;
  /** Modo efetivo (`getRuntimeModeResolution().mode`). */
  mode: string;
  liveAuthorized: boolean;
  killSwitchActive?: boolean;
  readOnlyMode?: boolean;
  /** `true` quando a chamada vem do pipeline automático (não do operador). */
  autonomousCall?: boolean;
  mint: string;
  sizeSol: number;
  /** `MAX_POSITION_SOL` — teto por posição declarado no boot. */
  maxPositionSol?: number;
  /** Exposição aberta atual, em SOL (soma de `sizeSol` das posições abertas). */
  openExposureSol?: number;
  /** Posições abertas que são reais (não paper). */
  realPositionsOpen?: number;
  /** Entradas reais já concluídas nesta sessão/histórico. */
  realEntriesDone?: number;
  /** Já existe posição aberta para este mint? */
  hasOpenPositionForMint?: boolean;
}

export interface EntryGateResult {
  allowed: boolean;
  issues: EntryGateIssue[];
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * GATE PURO de entrada real. Nenhuma rede, nenhum relógio, nenhum cofre.
 *
 * A ordem das checagens é a ordem em que um operador precisa pensar: caminho ligado? →
 * modo autoriza? → freios de emergência? → entrada faz sentido (mint/tamanho)? → cabe no
 * orçamento? Cada bloqueio é uma linha explícita, não um `if` composto que esconde qual
 * regra disparou.
 */
export function assessEntryGate(input: EntryGateInput): EntryGateResult {
  const issues: EntryGateIssue[] = [];
  const p = input.policy;
  const block = (code: EntryGateCode, message: string) => issues.push({ code, severity: "block", message });
  const warn = (code: EntryGateCode, message: string) => issues.push({ code, severity: "warn", message });

  // 1. O caminho está ligado? (declaração explícita, separada do modo)
  if (!p.enabled) {
    block(
      "ENTRY_PATH_DISABLED",
      "Entrada real DESLIGADA (HFT_REAL_ENTRY_ENABLED≠1). Este é o default de propósito: " +
        "o bot opera em PAPER/SHADOW sem capital. Ligue a variável para autorizar entrada real."
    );
  }

  // 2. Chamada automática exige declaração própria — modo LIVE não implica autonomia.
  if (input.autonomousCall && !p.autonomous) {
    block(
      "AUTONOMOUS_ENTRY_DISABLED",
      "Entrada AUTOMÁTICA desligada (HFT_AUTONOMOUS_ENTRY≠1). Em modo LIVE, entradas só " +
        "acontecem por disparo manual (POST /api/real-entry) até esta variável ser ligada."
    );
  }

  // 3. Modo. `liveAuthorized` é o AND de RUNTIME_MODE=LIVE com LIVE_TRADING_ENABLED=true.
  if (input.mode !== "LIVE" || !input.liveAuthorized) {
    block(
      "MODE_NOT_LIVE",
      `Modo ${input.mode} não assina. Entrada real exige RUNTIME_MODE=LIVE e ` +
        `LIVE_TRADING_ENABLED=true (duas declarações).`
    );
  }

  // 4. Freios de emergência.
  if (input.killSwitchActive) {
    block("KILL_SWITCH", "Kill Switch ativo: nenhuma entrada é permitida (saídas continuam liberadas).");
  }
  if (input.readOnlyMode) {
    block("READ_ONLY", "Modo Read-Only ativo: nenhuma entrada é permitida.");
  }

  // 5. A entrada faz sentido?
  if (!BASE58_RE.test((input.mint ?? "").trim())) {
    block("MINT_INVALID", `mint inválido (não é base58 de 32–44 caracteres): "${String(input.mint).slice(0, 32)}"`);
  }
  const size = Number(input.sizeSol);
  if (!Number.isFinite(size) || size <= 0) {
    block("SIZE_INVALID", `tamanho inválido: ${JSON.stringify(input.sizeSol)} SOL`);
  }

  // 6. Teto canário. Aplicado a QUALQUER entrada real — é o que impede "0,01 SOL de teste"
  //    virar 5 SOL por um default esquecido.
  if (Number.isFinite(size) && size > 0 && size > p.canaryMaxSol) {
    block(
      "CANARY_CAP_EXCEEDED",
      `tamanho ${size} SOL excede o teto canário HFT_CANARY_MAX_SOL=${p.canaryMaxSol} SOL. ` +
        `O teto é duro: para subir, altere a variável de forma consciente e registrada.`
    );
  }

  // 7. Teto por posição declarado no boot (MAX_POSITION_SOL) — pode ser MENOR que o canário.
  if (Number.isFinite(size) && input.maxPositionSol !== undefined && input.maxPositionSol > 0 && size > input.maxPositionSol) {
    block(
      "MAX_POSITION_SOL_EXCEEDED",
      `tamanho ${size} SOL excede MAX_POSITION_SOL=${input.maxPositionSol} SOL.`
    );
  }

  // 8. Uma entrada canário por vez.
  if (p.canaryOneEntry && (input.realEntriesDone ?? 0) >= 1) {
    block(
      "CANARY_ALREADY_USED",
      "Já existe entrada real registrada e HFT_CANARY_ONE_ENTRY=1: o canário roda UMA vez. " +
        "Analise o resultado (fill, custos, PnL medido) antes de liberar a próxima."
    );
  }

  // 9. Exposição total.
  const exp = (input.openExposureSol ?? 0) + (Number.isFinite(size) ? Math.max(0, size) : 0);
  if (p.maxTotalExposureSol > 0 && exp > p.maxTotalExposureSol) {
    block(
      "EXPOSURE_LIMIT",
      `exposição após esta entrada (${exp.toFixed(4)} SOL) excede MAX_TOTAL_EXPOSURE_SOL=${p.maxTotalExposureSol} SOL.`
    );
  }

  // 10. Duplicidade por mint (a trava de intenção cobre o reenvio; isto cobre o segundo sinal).
  if (input.hasOpenPositionForMint) {
    block("DUPLICATE_OPEN_POSITION", "já existe posição ABERTA para este mint — uma segunda entrada multiplicaria a exposição.");
  }

  if ((input.realPositionsOpen ?? 0) > 0) {
    warn(
      "DUPLICATE_OPEN_POSITION",
      `existem ${input.realPositionsOpen} posição(ões) real(is) aberta(s): confirme que o capital total continua dentro do que você aceita perder.`
    );
  }

  return { allowed: !issues.some((i) => i.severity === "block"), issues };
}

/**
 * Resultado de recusa SEM tocar em rede/cofre. Existe para que o chamador (servidor) não
 * precise remontar a forma do resultado — e para que um gate bloqueado produza EXATAMENTE
 * o mesmo tipo de objeto que uma tentativa real que falhou.
 */
export function refusedRealEntry(mint: string, sizeSol: number, gate: EntryGateResult, reason?: string): RealEntryResult {
  const first = gate.issues.find((i) => i.severity === "block");
  return {
    status: "refused",
    mint,
    sizeSol,
    confirmedOnChain: false,
    bundleAccepted: false,
    signature: null,
    bundleId: null,
    tipSol: null,
    slot: null,
    blockhash: null,
    lastValidBlockHeight: null,
    routeLabels: [],
    priceImpactPct: null,
    tokensReceived: null,
    fillMeasured: false,
    unitsConsumed: null,
    reason: reason ?? (first ? `${first.code}: ${first.message}` : "gate recusou a entrada"),
    gateIssues: gate.issues,
    timingsMs: { quote: 0, build: 0, simulate: 0, blockhash: 0, submit: 0, confirm: 0, observe: 0, total: 0 },
  };
}

/**
 * Quantas tentativas de entrada real PODERIAM ter sido executadas.
 *
 * Regra: uma tentativa só "conta" se chegou a existir uma ASSINATURA (ou se há confirmação
 * registrada). Falha de cotação, de construão, de simulação ou de blockhash acontece ANTES
 * de assinar e não toca a cadeia — então não pode consumir o canário de uma entrada, sob
 * pena de transformar uma falha de rede transitória em bloqueio permanente até alguém
 * editar o banco à mão.
 *
 * Este é o contador que alimenta `HFT_CANARY_ONE_ENTRY`. Ele vive aqui (puro) e não no
 * servidor porque é regra de política, não detalhe de persistência.
 */
export function countLandedEntryAttempts(
  trades: Array<{ mode?: unknown; signature?: unknown; status?: unknown }>
): number {
  let count = 0;
  for (const t of trades ?? []) {
    const mode = String(t?.mode ?? "");
    if (mode === "paper" || mode === "shadow") continue;
    const hasSignature = typeof t?.signature === "string" && t.signature.trim() !== "";
    if (hasSignature || String(t?.status ?? "") === "confirmed") count++;
  }
  return count;
}

/* -------------------------------------------------------------------------- */
/* 1. ORQUESTRAÇÃO                                                             */
/* -------------------------------------------------------------------------- */

export interface EntryQuoteLike {
  outAmount?: string | number;
  priceImpactPct?: string | number;
  routeLabels?: string[];
  [k: string]: unknown;
}

export interface EntrySimulation {
  ok: boolean;
  err?: unknown;
  unitsConsumed?: number | null;
  logsTail?: string[];
}

export interface EntryFillObservation {
  /** `true` quando o saldo pós-transação foi lido da cadeia (não da cotação). */
  measured: boolean;
  tokensReceived: string | null;
  feeLamports: number | null;
  slot: number | null;
  error?: string;
}

export interface RealEntryDeps {
  /** Barreira de assinatura. Lança quando o modo/estado não autoriza (fail-closed). */
  assertCanSign: () => void;
  getQuote: (mint: string, sizeLamports: number, slippageBps: number, timeoutMs?: number) => Promise<EntryQuoteLike>;
  buildSwapTransaction: (quote: EntryQuoteLike, userPublicKey: string, timeoutMs?: number) => Promise<unknown>;
  simulateTransaction: (tx: unknown) => Promise<EntrySimulation>;
  getFreshBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  /** Capacidade ÚNICA perigosa: assina e envia. O módulo não vê a chave. */
  signAndSubmit: (args: {
    transaction: unknown;
    blockhash: string;
    sizeSol: number;
    maxTipBps: number;
    purpose: "entry";
  }) => Promise<{ ok: boolean; signature?: string; bundleId?: string; tipSol?: number; error?: string }>;
  confirm: (
    signature: string,
    lastValidBlockHeight: number,
    timeoutMs: number
  ) => Promise<{ outcome: "confirmed" | "failed" | "expired" | "unknown"; slot?: number; error?: string }>;
  observeFill: (signature: string) => Promise<EntryFillObservation>;
  now: () => number;
}

export interface RealEntryRequest {
  mint: string;
  sizeSol: number;
  userPublicKey: string;
  policy: RealEntryPolicy;
  /** Resultado do gate puro, calculado pelo chamador (que conhece exposição/posições). */
  gate: EntryGateResult;
  confirmTimeoutMs?: number;
}

export type RealEntryStatus =
  | "refused"
  | "quote_failed"
  | "build_failed"
  | "simulation_failed"
  | "signing_blocked"
  | "submit_failed"
  | "submitted_unconfirmed"
  | "confirmed"
  | "failed_on_chain"
  | "expired";

export interface RealEntryStageTimings {
  quote: number;
  build: number;
  simulate: number;
  blockhash: number;
  submit: number;
  confirm: number;
  observe: number;
  total: number;
}

export interface RealEntryResult {
  status: RealEntryStatus;
  mint: string;
  sizeSol: number;
  /** Nunca `true` sem slot observado. "Aceito pelo block engine" fica em `bundleAccepted`. */
  confirmedOnChain: boolean;
  bundleAccepted: boolean;
  signature: string | null;
  bundleId: string | null;
  tipSol: number | null;
  slot: number | null;
  /**
   * Blockhash usado na assinatura + altura de validade. Vão para a INTENÇÃO persistida:
   * sem `lastValidBlockHeight` não existe prova de expiração, e sem prova de expiração a
   * política de retry (decideRetry) NUNCA autoriza reconstruir — a intenção ficaria travada.
   */
  blockhash: string | null;
  lastValidBlockHeight: number | null;
  routeLabels: string[];
  priceImpactPct: number | null;
  tokensReceived: string | null;
  fillMeasured: boolean;
  unitsConsumed: number | null;
  reason: string | null;
  gateIssues: EntryGateIssue[];
  timingsMs: RealEntryStageTimings;
}

const LAMPORTS_PER_SOL = 1_000_000_000;

function toBps(priceImpactPct: string | number | undefined): number | null {
  if (priceImpactPct === undefined || priceImpactPct === null) return null;
  const n = Number(priceImpactPct);
  // Jupiter devolve fração (0.0123 = 1,23%). A API v6 já devolveu percentual; aceitamos
  // a convenção da v1 (fração) e documentamos — sem adivinhar duas vezes.
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10_000);
}

/**
 * Executa a entrada real. TODOS os efeitos externos vêm de `deps` — este arquivo é testável
 * e auditável sem RPC, sem chave e sem rede.
 */
export async function executeRealEntry(
  deps: RealEntryDeps,
  req: RealEntryRequest
): Promise<RealEntryResult> {
  const t0 = deps.now();
  const timings: RealEntryStageTimings = {
    quote: 0, build: 0, simulate: 0, blockhash: 0, submit: 0, confirm: 0, observe: 0, total: 0,
  };
  /** Compute units observados na simulação — preenchidos só quando o pré-flight roda. */
  let unitsConsumed: number | null = null;
  const base: RealEntryResult = {
    status: "refused",
    mint: req.mint,
    sizeSol: req.sizeSol,
    confirmedOnChain: false,
    bundleAccepted: false,
    signature: null,
    bundleId: null,
    tipSol: null,
    slot: null,
    blockhash: null,
    lastValidBlockHeight: null,
    routeLabels: [],
    priceImpactPct: null,
    tokensReceived: null,
    fillMeasured: false,
    unitsConsumed: null,
    reason: null,
    gateIssues: req.gate.issues,
    timingsMs: timings,
  };
  const finish = (patch: Partial<RealEntryResult>): RealEntryResult => {
    timings.total = deps.now() - t0;
    return { ...base, ...patch };
  };

  // ── Gate (puro) ────────────────────────────────────────────────────────────
  if (!req.gate.allowed) {
    const first = req.gate.issues.find((i) => i.severity === "block");
    return finish({ status: "refused", reason: first ? `${first.code}: ${first.message}` : "gate recusou a entrada" });
  }

  // ── Barreira de assinatura ANTES de gastar cota/construir ──────────────────
  try {
    deps.assertCanSign();
  } catch (err: any) {
    return finish({ status: "signing_blocked", reason: err?.message ?? String(err) });
  }

  // ── 1. Cotação ─────────────────────────────────────────────────────────────
  const sizeLamports = Math.floor(req.sizeSol * LAMPORTS_PER_SOL);
  let s = deps.now();
  let quote: EntryQuoteLike;
  try {
    quote = await deps.getQuote(req.mint, sizeLamports, req.policy.slippageBps);
  } catch (err: any) {
    return finish({ status: "quote_failed", reason: err?.message ?? String(err) });
  }
  timings.quote = deps.now() - s;

  const outAmount = quote?.outAmount;
  if (outAmount === undefined || outAmount === null || Number(outAmount) <= 0) {
    return finish({
      status: "quote_failed",
      reason: "cotação sem `outAmount` positivo: não há rota líquida para este mint agora",
      routeLabels: quote?.routeLabels ?? [],
    });
  }

  const impactBps = toBps(quote.priceImpactPct);
  if (impactBps !== null && impactBps > req.policy.maxPriceImpactBps) {
    return finish({
      status: "refused",
      reason:
        `impacto de preço ${(impactBps / 100).toFixed(2)}% excede o teto de ` +
        `${(req.policy.maxPriceImpactBps / 100).toFixed(2)}% (HFT_ENTRY_MAX_PRICE_IMPACT_BPS). ` +
        `Entrar aqui é comprar o próprio impacto.`,
      routeLabels: quote.routeLabels ?? [],
      priceImpactPct: impactBps / 10_000,
    });
  }

  // ── 2. Construção da transação ─────────────────────────────────────────────
  s = deps.now();
  let transaction: unknown;
  try {
    transaction = await deps.buildSwapTransaction(quote, req.userPublicKey);
  } catch (err: any) {
    return finish({ status: "build_failed", reason: err?.message ?? String(err), routeLabels: quote.routeLabels ?? [] });
  }
  timings.build = deps.now() - s;

  // ── 3. Pré-flight (nenhuma taxa gasta para descobrir o que a simulação diz) ─
  if (req.policy.requirePreflight) {
    s = deps.now();
    let sim: EntrySimulation;
    try {
      sim = await deps.simulateTransaction(transaction);
    } catch (err: any) {
      return finish({
        status: "simulation_failed",
        reason: `simulação não executou: ${err?.message ?? String(err)}`,
        routeLabels: quote.routeLabels ?? [],
      });
    }
    timings.simulate = deps.now() - s;
    if (!sim.ok) {
      const errMsg = String((sim.err as any)?.message ?? sim.err ?? "erro sem detalhe");
      return finish({
        status: "simulation_failed",
        reason: `simulação REJEITOU a entrada: ${errMsg}`,
        routeLabels: quote.routeLabels ?? [],
        unitsConsumed: sim.unitsConsumed ?? null,
        gateIssues: [
          ...req.gate.issues,
          {
            code: "ENTRY_PATH_DISABLED",
            severity: "warn",
            message: `pré-flight falhou (logs: ${(sim.logsTail ?? []).join(" | ").slice(0, 300) || "sem logs"})`,
          },
        ],
      });
    }
    unitsConsumed = sim.unitsConsumed ?? null;
  }

  // ── 4. Blockhash monitorado (prova de expiração para a política de retry) ──
  s = deps.now();
  let bh: { blockhash: string; lastValidBlockHeight: number };
  try {
    bh = await deps.getFreshBlockhash();
  } catch (err: any) {
    return finish({ status: "submit_failed", reason: `sem blockhash utilizável: ${err?.message ?? String(err)}` });
  }
  timings.blockhash = deps.now() - s;
  if (!bh?.blockhash || !(bh.lastValidBlockHeight > 0)) {
    return finish({
      status: "submit_failed",
      reason: "blockhash sem `lastValidBlockHeight`: sem prova de expiração não há retentativa segura",
    });
  }

  // ── 5. Assinar + enviar (capacidade isolada; o cofre pode recusar) ─────────
  s = deps.now();
  let submitted: Awaited<ReturnType<RealEntryDeps["signAndSubmit"]>>;
  try {
    submitted = await deps.signAndSubmit({
      transaction,
      blockhash: bh.blockhash,
      sizeSol: req.sizeSol,
      maxTipBps: req.policy.maxTipBps,
      purpose: "entry",
    });
  } catch (err: any) {
    return finish({ status: "signing_blocked", reason: err?.message ?? String(err) });
  }
  timings.submit = deps.now() - s;

  if (!submitted?.ok || !submitted.signature) {
    return finish({
      status: "submit_failed",
      reason: submitted?.error ?? "assinatura/envio não retornou assinatura",
      bundleId: submitted?.bundleId ?? null,
      tipSol: submitted?.tipSol ?? null,
      routeLabels: quote.routeLabels ?? [],
    });
  }

  const signature = submitted.signature;
  const partial: Partial<RealEntryResult> = {
    blockhash: bh.blockhash,
    lastValidBlockHeight: bh.lastValidBlockHeight,
    signature,
    bundleId: submitted.bundleId ?? null,
    bundleAccepted: true,
    tipSol: submitted.tipSol ?? null,
    routeLabels: quote.routeLabels ?? [],
    priceImpactPct: impactBps === null ? null : impactBps / 10_000,
  };

  // ── 6. Confirmação ─────────────────────────────────────────────────────────
  s = deps.now();
  const confirmation = await deps.confirm(signature, bh.lastValidBlockHeight, req.confirmTimeoutMs ?? 30_000);
  timings.confirm = deps.now() - s;

  if (confirmation.outcome === "failed") {
    return finish({ ...partial, status: "failed_on_chain", slot: confirmation.slot ?? null, reason: confirmation.error ?? "transação falhou on-chain" });
  }
  if (confirmation.outcome === "expired") {
    return finish({ ...partial, status: "expired", reason: confirmation.error ?? "blockhash expirou antes da confirmação" });
  }
  if (confirmation.outcome === "unknown" || confirmation.slot === undefined) {
    /**
     * ESTADO PRÓPRIO, NÃO SUCESSO. O bundle foi aceito; a execução não foi observada.
     * Tratar isto como confirmado é o erro que fabrica PnL. O chamador deve reconciliar
     * (`getBundleStatuses`/`getSignatureStatuses`) antes de assumir posição.
     */
    return finish({
      ...partial,
      status: "submitted_unconfirmed",
      reason: confirmation.error ?? "aceito pelo block engine, mas nenhum slot foi observado dentro da janela",
    });
  }

  // ── 7. Fill real (o que a cadeia diz, não o que a cotação prometeu) ────────
  s = deps.now();
  let fill: EntryFillObservation;
  try {
    fill = await deps.observeFill(signature);
  } catch (err: any) {
    fill = { measured: false, tokensReceived: null, feeLamports: null, slot: confirmation.slot ?? null, error: err?.message ?? String(err) };
  }
  timings.observe = deps.now() - s;

  return finish({
    ...partial,
    status: "confirmed",
    confirmedOnChain: true,
    slot: confirmation.slot,
    tokensReceived: fill.tokensReceived,
    fillMeasured: fill.measured,
    unitsConsumed,
    reason: fill.measured ? null : `fill não medido: ${fill.error ?? "transação sem meta utilizável"}`,
  });
}

/* -------------------------------------------------------------------------- */
/* 2. LEITURA DO FILL — pura, para ser testada com metadados reais             */
/* -------------------------------------------------------------------------- */

export interface FillParseInput {
  owner: string;
  mint: string;
  meta: {
    err?: unknown;
    fee?: number;
    postTokenBalances?: Array<{ owner?: string; mint?: string; uiTokenAmount?: { amount?: string } }>;
    preTokenBalances?: Array<{ owner?: string; mint?: string; uiTokenAmount?: { amount?: string } }>;
  } | null;
  slot?: number | null;
}

/**
 * Lê o que a carteira RECEBEU, comparando `preTokenBalances` e `postTokenBalances` da
 * transação confirmada. Se a transação falhou (`meta.err`), o resultado é `measured: true`
 * com `tokensReceived: "0"` — falha observada é medição, não ausência de dado.
 */
export function parseEntryFill(input: FillParseInput): EntryFillObservation {
  const meta = input.meta;
  if (!meta) {
    return { measured: false, tokensReceived: null, feeLamports: null, slot: input.slot ?? null, error: "transação sem meta" };
  }
  if (meta.err) {
    return {
      measured: true,
      tokensReceived: "0",
      feeLamports: typeof meta.fee === "number" ? meta.fee : null,
      slot: input.slot ?? null,
      error: "transação falhou on-chain (err presente no meta)",
    };
  }

  const sum = (rows?: Array<{ owner?: string; mint?: string; uiTokenAmount?: { amount?: string } }>): bigint => {
    let total = 0n;
    for (const r of rows ?? []) {
      if (r?.owner !== input.owner || r?.mint !== input.mint) continue;
      const raw = r?.uiTokenAmount?.amount;
      if (typeof raw !== "string" || !/^\d+$/.test(raw)) continue;
      total += BigInt(raw);
    }
    return total;
  };

  const pre = sum(meta.preTokenBalances);
  const post = sum(meta.postTokenBalances);
  const delta = post - pre;
  if (delta < 0n) {
    return {
      measured: true,
      tokensReceived: "0",
      feeLamports: typeof meta.fee === "number" ? meta.fee : null,
      slot: input.slot ?? null,
      error: `saldo de ${input.mint} DIMINUIU na entrada (${delta.toString()}) — premissa de compra violada`,
    };
  }

  return {
    measured: true,
    tokensReceived: delta.toString(),
    feeLamports: typeof meta.fee === "number" ? meta.fee : null,
    slot: input.slot ?? null,
  };
}
