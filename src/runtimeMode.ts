/**
 * runtimeMode.ts — MODO DE EXECUÇÃO E BARREIRA ÚNICA DE ASSINATURA.
 *
 * POR QUE ESTE MÓDULO EXISTE
 * --------------------------
 * Antes dele, o sistema tinha um único booleano (`LIVE_TRADING_ENABLED`) decidindo se
 * transações reais podiam ser assinadas. Isso confunde três perguntas diferentes:
 *
 *   1. De onde vêm os dados?        (sintéticos × reais)
 *   2. O que fazemos com a decisão? (registrar, simular, construir, enviar)
 *   3. Podemos gastar capital?      (assinar × não assinar)
 *
 * Misturar as três é o que produz o pior modo de falha possível: um sistema que *parece*
 * paper (o operador acha que nada é enviado) e assina. Por isso os modos são explícitos e
 * a autorização de assinatura é derivada deles, não de um booleano solto.
 *
 * DEFINIÇÃO DOS MODOS (contrato, não sugestão)
 * --------------------------------------------
 *   SIMULATION — dados sintéticos. É o ÚNICO modo em que RNG é legítimo. Nunca assina.
 *   SHADOW     — dados reais, decisão real, transação CONSTRUÍDA e SIMULADA, nunca assinada.
 *                É o teste que valida o builder sem arriscar capital.
 *   PAPER      — dados reais, contabilidade com preço observado e custos modelados.
 *                Não constrói transação. Nunca assina.
 *   LIVE       — único modo autorizado a assinar/enviar.
 *
 * REGRA DE OURO DA RESOLUÇÃO (fail-closed)
 * ----------------------------------------
 *   - `RUNTIME_MODE=LIVE` sozinho NÃO basta: exige `LIVE_TRADING_ENABLED=true`.
 *   - `LIVE_TRADING_ENABLED=true` sozinho NUNCA vira LIVE: seria live por acidente.
 *     Essa combinação é tratada como ERRO DE CONFIGURAÇÃO FATAL no boot (ver
 *     `validateRuntimeConfiguration`) — o processo não sobe, em vez de subir ambíguo.
 *   - Valor inválido em `RUNTIME_MODE` rebaixa para PAPER e declara o conflito.
 *
 * Sem este módulo, um erro de digitação em uma variável de ambiente virava uma transação
 * real. Com ele, vira uma recusa com mensagem dizendo exatamente o que corrigir.
 */

/* -------------------------------------------------------------------------- */
/* 0. TIPOS                                                                    */
/* -------------------------------------------------------------------------- */

export type RuntimeMode = "SIMULATION" | "PAPER" | "SHADOW" | "LIVE";

/** Intenção da operação. Muda a política: sair é reduzir risco; entrar é assumir risco. */
export type OperationPurpose = "entry" | "exit";

export interface RuntimeModeResolution {
  /** Modo efetivo depois da resolução fail-closed. */
  mode: RuntimeMode;
  /** O que `RUNTIME_MODE` pedia (null quando ausente ou inválido). */
  requested: RuntimeMode | null;
  /** Valor de `LIVE_TRADING_ENABLED`. */
  liveTradingFlag: boolean;
  /** `true` somente quando modo === LIVE **e** a flag confirma. */
  liveAuthorized: boolean;
  /** Declarações contraditórias encontradas (nunca silenciadas). */
  conflicts: string[];
  /** Explicação legível de por que o modo resolvido é este. */
  reasons: string[];
  resolvedAt: string;
}

export const RUNTIME_MODES: RuntimeMode[] = ["SIMULATION", "PAPER", "SHADOW", "LIVE"];

/* -------------------------------------------------------------------------- */
/* 1. RESOLUÇÃO (função pura — testável sem mexer no ambiente)                 */
/* -------------------------------------------------------------------------- */

function parseLiveTradingFlag(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.LIVE_TRADING_ENABLED || "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function parseRuntimeModeEnv(env: NodeJS.ProcessEnv): { mode: RuntimeMode | null; invalid: string | null } {
  const raw = (env.RUNTIME_MODE || "").trim();
  if (!raw) return { mode: null, invalid: null };
  const upper = raw.toUpperCase();
  if ((RUNTIME_MODES as string[]).includes(upper)) {
    return { mode: upper as RuntimeMode, invalid: null };
  }
  return { mode: null, invalid: raw };
}

/**
 * Resolve o modo efetivo a partir do ambiente.
 *
 * É uma função PURA de propósito: a regra mais crítica do sistema (quem pode assinar)
 * precisa ser testável com um objeto de ambiente sintético, sem depender de mutação de
 * `process.env` nem de ordem de import de módulos.
 */
export function resolveRuntimeMode(env: NodeJS.ProcessEnv = process.env): RuntimeModeResolution {
  const conflicts: string[] = [];
  const reasons: string[] = [];
  const liveTradingFlag = parseLiveTradingFlag(env);
  const { mode: requested, invalid } = parseRuntimeModeEnv(env);

  if (invalid !== null) {
    conflicts.push(
      `RUNTIME_MODE="${invalid}" não é um modo válido (${RUNTIME_MODES.join(", ")}). ` +
        `Valor inválido é tratado como ausente — nunca como LIVE.`
    );
  }

  let mode: RuntimeMode;

  if (requested === "LIVE") {
    if (liveTradingFlag) {
      mode = "LIVE";
      reasons.push("RUNTIME_MODE=LIVE com LIVE_TRADING_ENABLED=true: assinatura autorizada.");
    } else {
      // Downgrade deliberado: LIVE sem a flag é uma configuração ambígua. Entre assinar
      // e não assinar na dúvida, não assinar.
      mode = "SHADOW";
      conflicts.push(
        "RUNTIME_MODE=LIVE exige LIVE_TRADING_ENABLED=true. Sem a flag, o modo foi " +
          "rebaixado para SHADOW (observa e simula, não assina)."
      );
      reasons.push("Rebaixado de LIVE para SHADOW por falta de confirmação explícita.");
    }
  } else if (requested !== null) {
    mode = requested;
    reasons.push(`RUNTIME_MODE=${requested} declarado explicitamente.`);
    if (liveTradingFlag) {
      conflicts.push(
        `LIVE_TRADING_ENABLED=true com RUNTIME_MODE=${requested}: prevalece o modo declarado ` +
          `${requested} (fail-closed). Ajuste RUNTIME_MODE=LIVE se a intenção era operar capital.`
      );
    }
  } else if (liveTradingFlag) {
    // O caso mais perigoso de todos: alguém ligou a flag "de trading real" e não declarou
    // o modo. Nunca transformamos isso em LIVE por inferência.
    mode = "SHADOW";
    conflicts.push(
      "LIVE_TRADING_ENABLED=true sem RUNTIME_MODE explícito. O sistema NÃO entra em LIVE " +
        "por inferência: declare RUNTIME_MODE=LIVE (e a configuração mínima de LIVE) ou remova a flag."
    );
    reasons.push("Flag de trading real presente, mas modo não declarado: SHADOW por segurança.");
  } else {
    mode = "PAPER";
    reasons.push("Nenhuma declaração de modo: PAPER é o padrão fail-closed.");
  }

  return {
    mode,
    requested,
    liveTradingFlag,
    liveAuthorized: mode === "LIVE" && liveTradingFlag,
    conflicts,
    reasons,
    resolvedAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* 2. RESOLUÇÃO MEMOIZADA (por impressão digital do ambiente)                  */
/* -------------------------------------------------------------------------- */

/**
 * A resolução é memoizada por impressão digital das duas variáveis que a determinam.
 *
 * Por que não um snapshot fixo no import: em testes e em cenários de reconfiguração, a
 * variável muda em runtime. Um snapshot fixo faria a barreira de assinatura responder com
 * base em configuração que não existe mais — exatamente o tipo de defasagem que queremos
 * eliminar. O custo é ler duas strings por chamada (chamada por operação, não por evento).
 */
let cached: { fingerprint: string; resolution: RuntimeModeResolution } | null = null;

function fingerprintOf(env: NodeJS.ProcessEnv): string {
  return `${(env.RUNTIME_MODE || "").trim().toUpperCase()}|${(env.LIVE_TRADING_ENABLED || "").trim().toLowerCase()}`;
}

export function getRuntimeModeResolution(env: NodeJS.ProcessEnv = process.env): RuntimeModeResolution {
  const fp = fingerprintOf(env);
  if (!cached || cached.fingerprint !== fp) {
    cached = { fingerprint: fp, resolution: resolveRuntimeMode(env) };
  }
  return cached.resolution;
}

export function getRuntimeMode(env: NodeJS.ProcessEnv = process.env): RuntimeMode {
  return getRuntimeModeResolution(env).mode;
}

export function isLiveAuthorized(env: NodeJS.ProcessEnv = process.env): boolean {
  return getRuntimeModeResolution(env).liveAuthorized;
}

/** Snapshot para API/painel — o operador precisa ver o modo E o motivo dele. */
export function describeRuntimeMode(env: NodeJS.ProcessEnv = process.env) {
  const res = getRuntimeModeResolution(env);
  return {
    mode: res.mode,
    requested: res.requested,
    liveTradingFlag: res.liveTradingFlag,
    liveAuthorized: res.liveAuthorized,
    canSign: res.liveAuthorized,
    conflicts: res.conflicts,
    reasons: res.reasons,
    modes: RUNTIME_MODES,
    note:
      `Modo ${res.mode}: ` +
      (res.mode === "LIVE"
        ? "assinatura e envio autorizados."
        : res.mode === "SHADOW"
          ? "dados reais, constrói e simula, NUNCA assina."
          : res.mode === "PAPER"
            ? "dados reais, contabilidade modelada, NUNCA assina nem constrói transação."
            : "dados sintéticos, NUNCA assina."),
  };
}

/* -------------------------------------------------------------------------- */
/* 3. BARREIRA ÚNICA DE ASSINATURA                                             */
/* -------------------------------------------------------------------------- */

export class SigningBlockedError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "SigningBlockedError";
  }
}

export interface SigningContext {
  killSwitchActive?: boolean;
  readOnlyMode?: boolean;
  vaultArmed?: boolean;
}

export type CapitalPermission =
  | { ok: true; warnings: string[] }
  | { ok: false; status: number; error: string; code: string };

/**
 * POLÍTICA ÚNICA de operação de capital — usada por entrada, saída e pelo choke point de
 * assinatura. Estar em um só lugar é o ponto: antes existiam três implementações parecidas
 * (entrada, saída, assinatura) e a política podia divergir entre elas.
 *
 * A assimetria entre "entry" e "exit" é DELIBERADA e é uma trade-off declarada:
 * entrar aumenta risco; sair reduz. Bloquear a saída pode prender capital em um ativo em
 * queda, o que é pior do que a maioria das políticas de "não tocar a rede".
 */
export function evaluateCapitalPermission(
  res: RuntimeModeResolution,
  ctx: SigningContext,
  purpose: OperationPurpose
): CapitalPermission {
  const warnings: string[] = [];

  if (!res.liveAuthorized) {
    const why = res.conflicts.length > 0 ? ` Conflitos: ${res.conflicts.join(" | ")}` : "";
    return {
      ok: false,
      status: 409,
      code: purpose === "exit" ? "EXIT_BLOCKED_BY_MODE" : "ENTRY_BLOCKED_BY_MODE",
      error:
        `Modo ${res.mode} não autoriza ${purpose === "entry" ? "operação de capital" : "liquidação on-chain"}. ` +
        (purpose === "exit"
          ? "Para liquidar on-chain defina RUNTIME_MODE=LIVE e LIVE_TRADING_ENABLED=true. "
          : "Nenhuma transação é assinada fora do modo LIVE. ") + why,
    };
  }

  if (ctx.vaultArmed === false) {
    return {
      ok: false,
      status: 503,
      code: "VAULT_NOT_ARMED",
      error:
        "Modo LIVE autorizado, mas o cofre de chaves não está provisionado neste processo. " +
        "Nenhuma assinatura é possível (e nenhuma chave será gerada em runtime em produção).",
    };
  }

  if (ctx.killSwitchActive) {
    if (purpose === "entry") {
      return { ok: false, status: 423, code: "KILL_SWITCH", error: "Kill Switch ativo. Nenhuma operação de capital é permitida." };
    }
    if ((process.env.BLOCK_EXITS_ON_KILL_SWITCH || "").trim().toLowerCase() === "true") {
      return {
        ok: false,
        status: 423,
        code: "KILL_SWITCH_BLOCKS_EXIT",
        error:
          "Kill Switch ativo e BLOCK_EXITS_ON_KILL_SWITCH=true: saídas bloqueadas por configuração explícita. " +
          "Atenção: isto mantém a exposição aberta.",
      };
    }
    warnings.push(
      "Kill Switch ativo: saída PERMITIDA porque reduz exposição. Defina BLOCK_EXITS_ON_KILL_SWITCH=true se preferir bloqueio total."
    );
  }

  if (ctx.readOnlyMode) {
    if (purpose === "entry") {
      return { ok: false, status: 423, code: "READ_ONLY", error: "Modo Read-Only ativo. Operações de capital bloqueadas." };
    }
    warnings.push("Modo Read-Only ativo: saída PERMITIDA por reduzir exposição.");
  }

  return { ok: true, warnings };
}

let contextProvider: (() => SigningContext) | null = null;

/**
 * O módulo de segurança registra aqui a fonte da verdade sobre kill switch / read-only /
 * cofre. A injeção evita dependência circular: `runtimeMode` (política) não importa
 * `security` (estado), e ainda assim a política enxerga o estado real.
 */
export function registerSigningContextProvider(provider: () => SigningContext): void {
  contextProvider = provider;
}

/**
 * BARREIRA ÚNICA. Nenhum caminho de código pode assinar sem passar por aqui.
 *
 * Lança em vez de retornar `false`: uma assinatura negada precisa ser IMPOSSÍVEL de ignorar
 * por um `if` esquecido. Chamadores que preferem resultado tipado usam
 * `evaluateCapitalPermission` diretamente.
 */
export function assertCanSign(purpose: OperationPurpose = "entry"): void {
  const res = getRuntimeModeResolution();
  const ctx = contextProvider ? contextProvider() : {};
  const verdict = evaluateCapitalPermission(res, ctx, purpose);
  if (!verdict.ok) {
    throw new SigningBlockedError(`[Signer Guard] ${verdict.error}`, verdict.code);
  }
  for (const w of verdict.warnings) console.warn(`[Signer Guard] ${w}`);
}

/* -------------------------------------------------------------------------- */
/* 4. VALIDAÇÃO DE BOOT (por modo)                                             */
/* -------------------------------------------------------------------------- */

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

/**
 * Valida a configuração CONTRA o modo declarado.
 *
 * Regra do plano de correção: "se faltar configuração crítica, a aplicação NÃO sobe em
 * modo LIVE". Subir meio-configurada é pior do que não subir: a saída é o caminho que
 * mais depende de configuração correta, e é justamente ela que falha em silêncio.
 */
export function validateRuntimeConfiguration(
  res: RuntimeModeResolution,
  env: NodeJS.ProcessEnv = process.env
): { fatal: string[]; warnings: string[] } {
  const fatal: string[] = [];
  const warnings: string[] = [];

  // Conflito fatal clássico: flag de capital ligada sem modo declarado.
  if (res.liveTradingFlag && res.requested === null) {
    fatal.push(
      "LIVE_TRADING_ENABLED=true sem RUNTIME_MODE explícito. Declare RUNTIME_MODE=LIVE " +
        "(exige chave operacional, ADMIN_TOKEN e RPC) ou remova a flag. O sistema não sobe " +
        "em estado ambíguo."
    );
  }

  if (res.mode === "LIVE") {
    if (!(env.OPERATIONAL_PRIVATE_KEY || "").trim()) {
      fatal.push(
        "Modo LIVE exige OPERATIONAL_PRIVATE_KEY. Sem chave própria, uma carteira efêmera " +
          "seria criada e qualquer SOL enviado a ela seria perdido no próximo restart."
      );
    }
    if (!(env.ADMIN_TOKEN || "").trim()) {
      fatal.push(
        "Modo LIVE exige ADMIN_TOKEN: com capital real, rotas mutantes não podem ficar sem " +
          "autenticação (POST /api/positions/close, kill switch, etc.)."
      );
    }
    const rpc = (env.RPC_ENDPOINT || "").trim();
    if (!/^https?:\/\//i.test(rpc)) {
      fatal.push(
        `Modo LIVE exige RPC_ENDPOINT válido (https). Valor atual: "${rpc || "(vazio)"}". ` +
          "Sem RPC real, detecção e confirmação são impossíveis — e confirmar é o que separa 'enviado' de 'executado'."
      );
    } else if (/api\.mainnet-beta\.solana\.com/i.test(rpc)) {
      warnings.push(
        "RPC_ENDPOINT aponta para o endpoint público da Solana (rate-limited e sem garantia de " +
          "latência). Em LIVE, use um provedor dedicado."
      );
    }
    const maxPos = (env.MAX_POSITION_SOL || "").trim();
    if (maxPos && (!Number.isFinite(Number(maxPos)) || Number(maxPos) <= 0)) {
      fatal.push(`MAX_POSITION_SOL inválido: "${maxPos}". Precisa ser número > 0.`);
    }
    if (!maxPos) {
      warnings.push("MAX_POSITION_SOL não definido em LIVE: o teto de posição ficará no default do código.");
    }
  }

  // Exposição de rede: quem pode alcançar a API mutante?
  const bindHost = (env.HFT_BIND_HOST || "").trim();
  const exposedBind = bindHost !== "" && !isLoopbackHost(bindHost);
  const hasRealKey = Boolean((env.OPERATIONAL_PRIVATE_KEY || "").trim());
  if (exposedBind) {
    const hasToken = Boolean((env.ADMIN_TOKEN || "").trim());
    if ((hasRealKey || res.mode === "LIVE") && !hasToken) {
      fatal.push(
        `HFT_BIND_HOST=${bindHost} com chave operacional real e sem ADMIN_TOKEN: a API mutante ` +
          "ficaria alcançável na rede sem autenticação. Defina ADMIN_TOKEN ou volte o bind para 127.0.0.1."
      );
    } else if (!hasToken) {
      warnings.push(
        `HFT_BIND_HOST=${bindHost} (não-loopback) sem ADMIN_TOKEN. Permitido apenas porque não há ` +
          "chave real nem modo LIVE. Antes de operar capital: defina ADMIN_TOKEN ou bind em 127.0.0.1."
      );
    }
  }

  if (res.mode === "SIMULATION") {
    warnings.push(
      "Modo SIMULATION: dados sintéticos. Nenhum número produzido aqui descreve o mercado real — " +
        "não use esta sessão para decidir estratégia."
    );
  }
  if (res.mode === "SHADOW") {
    warnings.push(
      "Modo SHADOW: observa e simula com dados reais, mas NÃO assina. Nenhuma ordem será enviada."
    );
  }

  return { fatal, warnings };
}
