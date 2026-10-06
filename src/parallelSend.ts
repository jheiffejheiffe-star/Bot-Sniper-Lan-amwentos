/**
 * ENVIO PARALELO (S8) — a mesma transação assinada entregue por vários caminhos ao mesmo tempo.
 *
 * ## O que faz
 *
 * Depois de ASSINAR (uma única vez), entrega os MESMOS bytes assinados por múltiplos transportes em
 * paralelo — bundle Jito, sender com stake (SWQOS) e envio direto ao RPC — e devolve o primeiro
 * aceite, com o registro de TODAS as tentativas.
 *
 * ## Por que isso é seguro (e o que exatamente é paralelizado)
 *
 * O paralelismo aqui é de ENTREGA, não de ASSINATURA. A transação é assinada uma vez; os bytes são
 * idênticos em todos os caminhos. Na Solana a assinatura é o identificador da transação: os mesmos
 * bytes NÃO podem entrar duas vezes no mesmo fork — o segundo caminho que "chegar" será descartado
 * como duplicata. Ou seja: paralelizar entrega não pode duplicar a operação.
 *
 * O que PODE duplicar é assinar duas vezes (duas transações, duas assinaturas, duas ordens). Isso
 * continua proibido pelo sistema de intenções (`advanceIntentOrKeep`), que é avaliado ANTES de
 * assinar — e este módulo não tem acesso a chave nenhuma.
 *
 * ## Por que paralelizar entrega
 *
 * Porque o landing não é determinístico: depende de qual bloco o leader inclui e por qual caminho o
 * pacote chegou. Publicado: RPC público < 30% de landing; sender com stake na faixa de 70-75%;
 * caminho dedicado ~94% — e o Jito bloqueia a inclusão de um bundle se o bloco já tiver a
 * transação. Enviar por VÁRIOS caminhos no mesmo instante maximiza a chance de que UM deles chegue
 * ao leader atual. Cada caminho extra custa uma requisição HTTP; o custo de NÃO chegar é perder a
 * entrada e, pior, deixar uma posição aberta em condições assimétricas.
 *
 * ## Semântica (a parte que os testes fixam)
 *
 * 1. Todos os transportes são disparados SIMULTANEAMENTE (não em sequência com timeout).
 * 2. Devolve assim que o PRIMEIRO aceita. **Os perdedores NÃO são cancelados**: abortar um envio
 *    que poderia entrar no próximo bloco destruiria exatamente o motivo de existir do paralelismo.
 * 3. Falha de um transporte não interrompe os outros; se TODOS falham, o resultado agrega os
 *    motivos (nunca um "erro genérico" que esconde qual caminho recusou o quê).
 * 4. `ok` significa ACEITO por pelo menos um caminho — NÃO significa executado. A distinção
 *    `aceito` × `executado` é do `realEntry` (confirmação com slot observado) e não é redefinida
 *    aqui.
 * 5. Timeout por transporte: um caminho lento não segura o resultado nem deixa `await` pendurado.
 *
 * ## Dependências
 *
 * Nenhuma nova: `fetch` (global) e a interface `injected` de envio. Nada de chave, nada de
 * assinatura, nada de `Connection` própria — o envio direto ao RPC recebe uma função já preparada.
 *
 * ## Riscos
 *
 * 1. **Multiplicar requisições** pode ativar rate limit do provedor: `HFT_STAKED_SENDER_URL` é um
 *    endpoint SEPARADO do RPC de leitura, justamente para não competir com as leituras.
 * 2. **Sender com stake exige relação de stake/tip com o provedor.** Isso é configuração de
 *    infraestrutura do operador — o código não inventa endpoint nem presume que o caminho está
 *    ativo: sem URL configurada, o transporte simplesmente não entra na corrida (e é declarado).
 * 3. **Tip do Jito**: só existe no bundle. Quando o vencedor é outro caminho, nenhum tip é pago —
 *    o que também significa menos incentivo de inclusão naquele caminho. Isso está declarado no
 *    resultado (`tipPaid`).
 * 4. **Cancelamento de bundle**: o Jito não cancela bundle já aceito; enviar em paralelo pode
 *    resultar em "bundle aceito e não incluído" (inofensivo: aceito ≠ executado).
 *
 * ## Como testar
 *
 * Grupo [27] de `npm run test`: política por ambiente, corrida com vencedor único, todos falhando,
 * um transporte lento com timeout, transporte que lança exceção, nomes duplicados, e — o mais
 * importante — que o `ok` NUNCA seja reportado como execução confirmada.
 *
 * ## Como colocar em produção
 *
 * `HFT_PARALLEL_SEND=1` (habilita a corrida), `HFT_STAKED_SENDER_URL=https://...` (opcional, habilita
 * o terceiro caminho) e `HFT_SEND_RPC_DIRECT=1` (opcional, envia também pelo RPC de leitura).
 * Sem `HFT_PARALLEL_SEND=1`, o comportamento é o do S6: só o bundle Jito — nada muda.
 */

/* -------------------------------------------------------------------------- */
/* 1. POLÍTICA                                                                 */
/* -------------------------------------------------------------------------- */

export type TransportName = "jito" | "staked" | "rpc";

export interface ParallelSendPolicy {
  /** `HFT_PARALLEL_SEND=1` — sem isto, só o caminho Jito (comportamento do S6). */
  enabled: boolean;
  /** Transportes que participam da corrida, na ordem de declaração. Sempre inclui `jito`. */
  transports: TransportName[];
  /** `HFT_STAKED_SENDER_URL` — sender com stake/SWQOS. Vazio = transporte desligado. */
  stakedSenderUrl: string;
  /** `HFT_STAKED_SWQOS_ONLY` (default true) — passa `?swqos_only=true` no envio ao sender. */
  swqosOnly: boolean;
  /** `HFT_SEND_RPC_DIRECT=1` — envia também pelo RPC de leitura, em paralelo ao bundle. */
  rpcDirect: boolean;
  /** Timeout por transporte. Default 3000ms (um slot tem ~400ms; 3s já é generoso). */
  transportTimeoutMs: number;
}

function flag(raw: string | undefined, fallback = false): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return fallback;
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Número com fallback para AUSÊNCIA (mesma doutrina de `realEntry.num`): `Number("")` é 0 e
 * `Number.isFinite(0)` é true, então variável ausente viraria timeout 0 — ou seja, abortar tudo
 * "por padronagem" em vez de usar o default. Este erro já aconteceu nesta base.
 */
function num(raw: string | undefined, fallback: number, min: number, max: number): number {
  const s = (raw ?? "").trim();
  if (s === "") return fallback;
  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export const PARALLEL_SEND_DEFAULTS = Object.freeze({
  transportTimeoutMs: 3_000,
});

export function resolveParallelSendPolicy(env: NodeJS.ProcessEnv = process.env): ParallelSendPolicy {
  const enabled = flag(env.HFT_PARALLEL_SEND);
  const stakedSenderUrl = (env.HFT_STAKED_SENDER_URL ?? "").trim();
  const rpcDirect = flag(env.HFT_SEND_RPC_DIRECT);
  const swqosOnly = flag(env.HFT_STAKED_SWQOS_ONLY, true);

  const transports: TransportName[] = ["jito"];
  if (stakedSenderUrl !== "") transports.push("staked");
  if (rpcDirect) transports.push("rpc");

  return {
    enabled,
    transports: enabled ? transports : ["jito"],
    stakedSenderUrl,
    swqosOnly,
    rpcDirect,
    transportTimeoutMs: num(env.HFT_TRANSPORT_TIMEOUT_MS, PARALLEL_SEND_DEFAULTS.transportTimeoutMs, 250, 30_000),
  };
}

/** Avisos honestos sobre a configuração — exibidos no health, não escondidos no código. */
export function describeParallelSendPolicy(policy: ParallelSendPolicy): string[] {
  const notes: string[] = [];
  if (!policy.enabled) {
    notes.push(
      "envio paralelo DESLIGADO (HFT_PARALLEL_SEND≠1): o caminho é o bundle Jito único, como no S6"
    );
    if (policy.stakedSenderUrl !== "") {
      notes.push("HFT_STAKED_SENDER_URL está definido, mas sem HFT_PARALLEL_SEND=1 ele não é usado");
    }
    return notes;
  }
  notes.push(`transporte(s) na corrida: ${policy.transports.join(" + ")}`);
  if (!policy.stakedSenderUrl) {
    notes.push(
      "sem HFT_STAKED_SENDER_URL: não há caminho com stake/SWQOS na corrida (um dos caminhos de maior " +
        "landing publicado). Configurar é decisão de infraestrutura do operador e exige relação de " +
        "stake/tip com o provedor — nada é presumido aqui"
    );
  }
  if (policy.swqosOnly && policy.stakedSenderUrl) {
    notes.push("envio ao sender com `?swqos_only=true`: o provedor pode recusar se o tip não atender ao mínimo dele");
  }
  if (policy.rpcDirect) {
    notes.push(
      "HFT_SEND_RPC_DIRECT=1: os mesmos bytes também vão pelo RPC de leitura — consome cota de envio do plano"
    );
  }
  notes.push(
    "os mesmos bytes assinados em vários caminhos não podem executar duas vezes (mesma assinatura = " +
      "mesma transação); quem impede duplicar é o sistema de intenções, ANTES de assinar"
  );
  return notes;
}

/* -------------------------------------------------------------------------- */
/* 2. CORRIDA (núcleo puro e testável)                                         */
/* -------------------------------------------------------------------------- */

export interface TransportAttempt {
  transport: TransportName;
  ok: boolean;
  /** Motivo da falha quando `ok === false`. */
  error: string | null;
  latencyMs: number;
}

export interface ParallelSendOutcome {
  /** ACEITO por pelo menos um transporte. NÃO é "executado". */
  ok: boolean;
  signature: string;
  /** Transportes que aceitaram (normalmente 1; mais de um é possível). */
  acceptedBy: TransportName[];
  /** Vencedor (primeiro a aceitar); `null` se nenhum aceitou. */
  winner: TransportName | null;
  attempts: TransportAttempt[];
  /** Texto para log/telemetria, sem prometer execução. */
  note: string;
}

export interface TransportSpec {
  name: TransportName;
  /**
   * Envia e resolve quando o caminho ACEITA. Resolver com string = aceito (mensagem informativa
   * opcional); LANÇAR = recusado. `signal` é abortado no timeout — implementações que usam `fetch`
   * devem repassá-lo.
   */
  send: (signal: AbortSignal) => Promise<string | null | void>;
}

/** Timeout por transporte, sem `Promise.race` solto: o timer é limpo sempre. */
function withTimeout<T>(promise: Promise<T>, ms: number, transport: TransportName): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout de ${ms}ms no transporte ${transport}`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Dispara todos os transportes e devolve no primeiro aceite.
 *
 * Implementação: cada transporte é envolvido numa promessa que NUNCA rejeita (converte para
 * `TransportAttempt`), e o conjunto é observado por um `Promise` externo que resolve no primeiro
 * `ok`. Os perdedores seguem rodando: o resultado final os registra via `onAttempt` (para log) e o
 * `ParallelSendOutcome.attempts` carrega o que já se sabe no momento da resolução.
 */
export async function sendInParallel(params: {
  signature: string;
  transports: TransportSpec[];
  timeoutMs: number;
  now: () => number;
  /** Chamado a cada desfecho (vencedor imediato ou perdedor tardio). Não pode lançar. */
  onAttempt?: (attempt: TransportAttempt) => void;
}): Promise<ParallelSendOutcome> {
  const { signature, transports, timeoutMs, now } = params;
  const attempts: TransportAttempt[] = [];

  if (transports.length === 0) {
    return {
      ok: false,
      signature,
      acceptedBy: [],
      winner: null,
      attempts,
      note: "nenhum transporte configurado: nada foi enviado",
    };
  }
  const names = transports.map((t) => t.name);
  const duplicated = names.filter((n, i) => names.indexOf(n) !== i);
  if (duplicated.length > 0) {
    // Dois transportes com o mesmo nome tornam o relatório ambíguo — e ambigüidade em telemetria
    // de execução é o primeiro passo para "aceito" virar "executado" na cabeça de quem lê.
    return {
      ok: false,
      signature,
      acceptedBy: [],
      winner: null,
      attempts: [],
      note: `configuração inválida: transporte duplicado (${[...new Set(duplicated)].join(", ")})`,
    };
  }

  let settled = false;
  let resolveFirst: (name: TransportName) => void;
  const firstAccepted = new Promise<TransportName>((resolve) => {
    resolveFirst = resolve;
  });

  const record = (attempt: TransportAttempt) => {
    attempts.push(attempt);
    try {
      params.onAttempt?.(attempt);
    } catch {
      /* telemetria nunca derruba execução */
    }
  };

  for (const spec of transports) {
    const startedAt = now();
    const controller = new AbortController();
    void withTimeout(Promise.resolve().then(() => spec.send(controller.signal)), timeoutMs, spec.name)
      .then((accepted) => {
        record({
          transport: spec.name,
          ok: true,
          error: typeof accepted === "string" && accepted !== "" ? accepted : null,
          latencyMs: now() - startedAt,
        });
        if (!settled) {
          settled = true;
          resolveFirst(spec.name);
        }
      })
      .catch((err: any) => {
        // Aborta o que ainda estiver pendente DESTE transporte: o timeout já venceu.
        try {
          controller.abort();
        } catch {
          /* ignora */
        }
        record({
          transport: spec.name,
          ok: false,
          error: err?.message ?? String(err),
          latencyMs: now() - startedAt,
        });
      });
  }

  /**
   * Espera o primeiro aceite OU todos falharem. Não existe "esperar todos" no caminho de sucesso:
   * o operador precisa do resultado no menor tempo possível — o resto é telemetria.
   */
  const winner = await Promise.race<TransportName | null>([
    firstAccepted,
    (async () => {
      // Só resolve quando TODOS os transportes já reportaram (sucesso ou falha).
      while (attempts.length < transports.length) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return null;
    })(),
  ]);

  const acceptedBy = attempts.filter((a) => a.ok).map((a) => a.transport);
  const failures = attempts.filter((a) => !a.ok);

  if (winner === null) {
    return {
      ok: false,
      signature,
      acceptedBy,
      winner: null,
      attempts: [...attempts],
      note:
        `nenhum dos ${transports.length} transporte(s) aceitou. Motivos: ` +
        failures.map((f) => `${f.transport}=${f.error}`).join(" | "),
    };
  }

  return {
    ok: true,
    signature,
    acceptedBy,
    winner,
    attempts: [...attempts],
    note:
      `aceito por ${winner}` +
      (failures.length > 0
        ? ` (outros caminhos: ${failures.map((f) => `${f.transport}=${f.error}`).join(" | ")})`
        : "") +
      " — ACEITO não é EXECUTADO: a execução só existe com confirmação e slot observados",
  };
}

/* -------------------------------------------------------------------------- */
/* 3. TRANSPORTES REAIS (o que fala com a rede)                               */
/* -------------------------------------------------------------------------- */

export interface StakedTransportOptions {
  url: string;
  swqosOnly: boolean;
  /** Transação SERIALIZADA em base64 (assinada antes, fora deste módulo). */
  rawTransactionBase64: string;
  timeoutMs: number;
  /** Injetável para teste; default `fetch` global. */
  fetchImpl?: typeof fetch;
}

function senderUrl(url: string, swqosOnly: boolean): string {
  if (!swqosOnly) return url;
  return url.includes("?") ? `${url}&swqos_only=true` : `${url}?swqos_only=true`;
}

/**
 * Transporte "sender" (envio com prioridade/stake do provedor).
 *
 * O ENDPOINT VEM DA CONFIGURAÇÃO DO OPERADOR — este código não inventa endereço de provedor nem
 * presume que exista caminho com stake. A resposta é validada: um `sendTransaction` de JSON-RPC
 * devolve `{ result: <assinatura> }`; `{ error: ... }` e corpos estranhos viram recusa declarada
 * (aceitar "algo que respondeu 200" como aceite é como se transforma telemetria em ficção).
 */
export function buildStakedSenderTransport(opts: StakedTransportOptions): TransportSpec {
  return {
    name: "staked",
    send: async (signal) => {
      const doFetch = opts.fetchImpl ?? fetch;
      const res = await doFetch(senderUrl(opts.url, opts.swqosOnly), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendTransaction",
          params: [
            opts.rawTransactionBase64,
            {
              encoding: "base64",
              // `skipPreflight` porque o pré-flight JÁ foi feito na simulação do caminho real;
              // repetir aqui adiciona RTT e pode falhar por estado local do nó de envio.
              skipPreflight: true,
              // `maxRetries: 0` porque a repetição é decisão do sistema de intenções (com prova de
              // expiração), não de um nó arbitrário de envio.
              maxRetries: 0,
            },
          ],
        }),
        signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`sender HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
      }
      const json = (await res.json().catch(() => null)) as { result?: string; error?: { message?: string } } | null;
      if (!json) throw new Error("sender respondeu corpo não-JSON (resposta inválida)");
      if (json.error) throw new Error(`sender recusou: ${json.error.message ?? JSON.stringify(json.error)}`);
      if (typeof json.result !== "string" || json.result === "") {
        throw new Error("sender respondeu sem assinatura em `result` (aceite não comprovado)");
      }
      return `sender aceitou ${json.result.slice(0, 12)}…`;
    },
  };
}

/**
 * Transporte de envio direto ao RPC.
 *
 * Recebe uma FUNÇÃO de envio já preparada pelo servidor (que conhece o `Connection` e a política
 * de `sendRawTransaction`) — este módulo não abre conexão própria nem guarda referência de rede.
 */
export function buildRpcDirectTransport(send: (signal: AbortSignal) => Promise<string | void>): TransportSpec {
  return { name: "rpc", send };
}

/**
 * Transporte Jito, embrulhado na mesma interface. O envio do bundle fica no servidor (que conhece
 * o `JitoBundleSender`, o tip e a política de bps); aqui só se adapta o resultado.
 */
export function buildJitoTransport(
  submit: (signal: AbortSignal) => Promise<{ success: boolean; bundleId?: string; error?: string }>
): TransportSpec {
  return {
    name: "jito",
    send: async (signal) => {
      const res = await submit(signal);
      if (!res.success) throw new Error(res.error ?? "block engine recusou o bundle");
      return res.bundleId ? `bundle ${res.bundleId.slice(0, 12)}… aceito` : "bundle aceito";
    },
  };
}

/* -------------------------------------------------------------------------- */
/* S13 — PLANO DE SUBMISSÃO (decisão PURA, testável)                           */
/* -------------------------------------------------------------------------- */

/**
 * Política do fallback por RPC quando o block engine do Jito RECUSA o bundle.
 *
 * ## Por que o default é LIGADO
 *
 * Os dois modos de falha não são simétricos:
 *   - **Entrada** recusada pelo Jito ⇒ oportunidade perdida (custo: não operar).
 *   - **Saída** recusada pelo Jito ⇒ capital PRESO no token, com preço se movendo contra
 *     (`[C6]` da auditoria). O custo é ilimitado, e é o modo de falha que trava a operação.
 *
 * Então a entrega tem de sobreviver à recusa do block engine. Os MESMOS bytes assinados vão por
 * RPC (`sendRawTransaction`): a assinatura é o identificador da transação, e a runtime deduplica
 * por *message hash* — reenviar o mesmo par (bytes, assinatura) NÃO duplica a ordem. Duplicar
 * exigiria assinar duas vezes, e isso o sistema de intenções bloqueia antes de qualquer chave.
 *
 * O custo é declarado, não escondido: o envio consome cota do plano de RPC (no plano gratuito,
 * essa cota é pequena) e é justamente por isso que o caminho NÃO é ligado para tudo — só quando
 * o Jito recusa.
 */
export interface RpcFallbackPolicy {
  enabled: boolean;
  /** Valor literal do ambiente (`null` quando ausente). */
  raw: string | null;
  note: string;
}

export function resolveRpcFallbackPolicy(env: NodeJS.ProcessEnv = process.env): RpcFallbackPolicy {
  const raw = (env.HFT_RPC_FALLBACK_ON_JITO_FAIL ?? "").trim();
  if (raw === "") {
    return {
      enabled: true,
      raw: null,
      note:
        "default LIGADO: se o block engine recusar, os MESMOS bytes assinados vão pelo RPC. " +
        "Saída presa é pior do que gastar cota de envio (reativar/desligar: HFT_RPC_FALLBACK_ON_JITO_FAIL).",
    };
  }
  const off = raw.toLowerCase();
  if (off === "0" || off === "false" || off === "no") {
    return {
      enabled: false,
      raw,
      note:
        "HFT_RPC_FALLBACK_ON_JITO_FAIL desligado: recusa do Jito passa a ser FALHA TERMINAL da tentativa. " +
        "Com um provider que aplica rate limit (a causa mais comum de recusa), uma saída pode ficar presa.",
    };
  }
  return { enabled: true, raw, note: `HFT_RPC_FALLBACK_ON_JITO_FAIL=${raw}: fallback por RPC ligado.` };
}

export interface SubmissionPlan {
  mode: "race" | "jito_with_fallback" | "jito_only";
  transports: TransportName[];
  rpcFallback: boolean;
  note: string;
}

/**
 * Decide COMO entregar a transação assinada, a partir de duas políticas independentes.
 *
 * - `HFT_PARALLEL_SEND=1` ⇒ corrida (perde-se em latência se o Jito demorar, ganha-se em landing).
 * - desligado (default) + fallback ligado ⇒ **Jito primeiro**; recusa do block engine ⇒ RPC.
 * - desligado + fallback desligado ⇒ só Jito; recusa é terminal (declarado, não silencioso).
 */
export function planSubmission(policy: ParallelSendPolicy, fallback: RpcFallbackPolicy): SubmissionPlan {
  if (policy.enabled) {
    const temRpc = policy.transports.includes("rpc");
    return {
      mode: "race",
      transports: policy.transports,
      rpcFallback: false,
      note:
        `corrida de transportes: ${policy.transports.join(" + ")} — o primeiro aceite vence; os perdedores ` +
        `seguem rodando (podem entrar no próximo bloco).` +
        (temRpc
          ? " O RPC já faz parte da corrida (HFT_SEND_RPC_DIRECT=1)."
          : " O RPC NÃO está na corrida (HFT_SEND_RPC_DIRECT≠1): a corrida é Jito/staked."),
    };
  }
  if (fallback.enabled) {
    return {
      mode: "jito_with_fallback",
      transports: ["jito", "rpc"],
      rpcFallback: true,
      note:
        "corrida DESLIGADA: bundle Jito primeiro; se o block engine recusar, os MESMOS bytes assinados " +
        "são enviados pelo RPC (fallback sequencial — só paga o custo quando o Jito falha).",
    };
  }
  return {
    mode: "jito_only",
    transports: ["jito"],
    rpcFallback: false,
    note: "corrida DESLIGADA e fallback DESLIGADO: recusa do Jito é falha terminal da tentativa.",
  };
}
