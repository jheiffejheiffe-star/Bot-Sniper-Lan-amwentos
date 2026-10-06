/**
 * INTENÇÃO DE EXECUÇÃO E IDEMPOTÊNCIA — o que impede uma ação de virar duas.
 *
 * ## O que faz
 *
 * Modela cada ação econômica (uma compra, uma venda) como uma INTENÇÃO com estado
 * persistido, separada do transporte que a envia. O ponto central:
 *
 *   - **Reenviar os MESMOS bytes assinados é idempotente.** O runtime da Solana
 *     deduplica transações por *message hash* — a mesma transação não pode ser
 *     processada duas vezes. Reenviar por outro RPC, ou de novo pelo mesmo, não
 *     duplica a ação.
 *   - **Reconstruir NÃO é idempotente.** Uma transação reconstruída (blockhash novo,
 *     slippage ajustado, rota diferente) tem mensagem e assinatura DIFERENTES. A
 *     runtime vê uma transação nova. As duas ficam válidas enquanto seus blockhashes
 *     forem válidos — e as duas podem entrar em bloco.
 *
 * Ou seja: retry seguro = reenviar os mesmos bytes. Reconstruir só é seguro depois de
 * PROVAR que a tentativa anterior não pode mais entrar em bloco (blockhash expirado,
 * medido por `lastValidBlockHeight`, ou status de execução com erro na cadeia).
 * Timeout próprio não é prova de nada: "não sei se entrou" deve permanecer pendente,
 * nunca virar "não entrou" — a mesma regra que o reconciliador de landing aplica.
 *
 * ## Como funciona
 *
 * Tipos e funções puras, sem rede e sem I/O:
 *   - `createExecutionIntent` / `advanceIntent` : máquina de estados com guardas.
 *   - `findBlockingIntent`                      : trava de voo único por posição/lado.
 *   - `decideRetry`                             : a decisão que separa dinheiro de prejuízo
 *                                                 (rebroadcast × rebuild × wait × stop).
 *
 * Estados: `created` → `signed` → `submitted` → (`confirmed` | `failed` | `expired`).
 * `confirmed`, `failed` e `expired` são TERMINAIS: para agir de novo, crie uma NOVA
 * intenção (novo id, novo `attempt`), nunca "ressuscite" uma confirmada.
 *
 * ## O que NUNCA é persistido
 *
 * Os bytes assinados. Uma transação já assinada é dinheiro em movimento: quem a
 * possui pode transmiti-la. Ela vive apenas em memória (`wireTransaction`) e não vai
 * para disco, log, JSONL de eventos nem resposta de API. O que é persistido é
 * suficiente para PERGUNTAR à cadeia (assinatura + blockhash + lastValidBlockHeight).
 *
 * ## Riscos e limites declarados
 *
 * 1. Um snapshot de status de assinatura pode vir `null` mesmo para uma transação que
 *    entrou: os caches de assinatura recente são limitados (~150 slots) e um nó atrasado
 *    pode não ver a transação. Por isso `null` é `wait`, nunca `rebuild`.
 * 2. `lastValidBlockHeight` protege contra expiração de blockhash, não contra
 *    reorganização de blocos nem contra transações com DURABLE NONCE, que não expiram.
 *    Uma intenção com nonce durável só pode ser considerada expirada por evidência de
 *    execução (status com erro) — a função devolve `wait` e isso é intencional.
 * 3. Esta camada garante no máximo UMA transação válida por intenção *no processo que a
 *    usa*. Ela não garante nada se outro operador (ou outra instância do bot) operar a
 *    mesma carteira em paralelo: dois processos não veem a intenção um do outro. Para
 *    isso o caminho é idempotência NA CADEIA (conta de receipt), que este módulo não
 *    implementa.
 *
 * ## Como testar
 *
 * `npm run test` (grupo [13]). Os testes cobrem: matriz de decisão de retry por
 * evidência, expiração por altura, tempo-limite não sendo tratado como falha, estados
 * terminais, e a trava de voo único.
 *
 * ## Como colocar em produção
 *
 * 1. Chame `createExecutionIntent` e `dbStore.saveIntent(...)` ANTES de assinar.
 * 2. Só depois assine; em seguida `advanceIntent(signed)` e `advanceIntent(submitted)`.
 * 3. Em cada retry, consulte `decideRetry` com a altura de bloco ATUAL lida de um RPC
 *    saudável e o status da assinatura; siga a decisão literalmente.
 * 4. Ao terminar, marque `confirmed` (com o nível) ou `failed`. Não gaste estado
 *    terminal: crie intenção nova.
 */

export type ExecutionSide = "entry" | "exit";

export type ExecutionIntentState =
  | "created"
  | "signed"
  | "submitted"
  | "confirmed"
  | "failed"
  | "expired";

/** Estados a partir dos quais NENHUMA ação nova pode partir sem criar outra intenção. */
export const TERMINAL_INTENT_STATES: readonly ExecutionIntentState[] = [
  "confirmed",
  "failed",
  "expired",
];

/**
 * Nível de confirmação observado. `processed` NÃO é confirmação: é inclusão otimista
 * em um bloco que ainda pode ser revertido. Registrar o nível é o que permite separar
 * "saiu" de "saiu e está finalizado".
 */
export type ConfirmationLevel = "processed" | "confirmed" | "finalized";

export interface IntentTransition {
  at: string;
  from: ExecutionIntentState;
  to: ExecutionIntentState;
  reason: string;
}

/**
 * Registro persistível de uma intenção.
 *
 * Não contém bytes assinados, chave, nem qualquer segredo. `signature` é pública
 * (qualquer explorador a mostra) e serve para CONSULTAR, não para transmitir.
 */
export interface ExecutionIntentRecord {
  id: string;
  positionId: string;
  mint: string;
  token: string;
  side: ExecutionSide;
  state: ExecutionIntentState;
  /** Nª transação construída para esta intenção (rebuilds provados inclusive). */
  attempt: number;
  signature: string | null;
  blockhash: string | null;
  /**
   * Altura máxima de bloco em que o blockhash desta tentativa é válido, como devolvido
   * por `getLatestBlockhash`. Sem este número não existe prova de expiração — e sem
   * prova de expiração não existe rebuild seguro.
   */
  lastValidBlockHeight: number | null;
  confirmationLevel: ConfirmationLevel | null;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  /**
   * Intenção que esta substitui. Uma tentativa nova (rebuild) só existe depois de a
   * anterior ser PROVADAMENTE incapaz de entrar em bloco; o encadeamento deixa isso
   * auditável em vez de apagar o histórico.
   */
  supersedesIntentId: string | null;
  history: IntentTransition[];
}

export interface IntentDeps {
  /** Injetável para teste; default `new Date().toISOString()`. */
  now?: () => string;
  /** Injetável para teste; default `Math.random().toString(36).slice(2, 10)`. */
  randomSuffix?: () => string;
}

/** Gera o id local da intenção. Não é a assinatura: a assinatura só existe após assinar. */
export function createExecutionIntent(
  input: {
    positionId: string;
    mint: string;
    token: string;
    side: ExecutionSide;
    /** Nº da tentativa (1 = primeira). Tentativas novas nascem de rebuild com prova. */
    attempt?: number;
    /** Id da intenção anterior, quando esta é uma reconstrução provada. */
    supersedesIntentId?: string | null;
  },
  deps: IntentDeps = {}
): ExecutionIntentRecord {
  const now = deps.now ?? (() => new Date().toISOString());
  const suffix = deps.randomSuffix ?? (() => Math.random().toString(36).slice(2, 10));
  const at = now();
  return {
    id: `intent_${input.side}_${input.positionId}_${Date.now().toString(36)}_${suffix()}`,
    positionId: input.positionId,
    mint: input.mint,
    token: input.token,
    side: input.side,
    state: "created",
    attempt: Math.max(1, Math.floor(input.attempt ?? 1)),
    signature: null,
    blockhash: null,
    lastValidBlockHeight: null,
    confirmationLevel: null,
    createdAt: at,
    updatedAt: at,
    lastError: null,
    supersedesIntentId: input.supersedesIntentId ?? null,
    history: [],
  };
}

export function isTerminalIntent(intent: ExecutionIntentRecord): boolean {
  return TERMINAL_INTENT_STATES.includes(intent.state);
}

/**
 * Transições permitidas. Qualquer outra combinação é recusada (retorna `null` e não
 * altera nada): estado inconsistente é como um bot passa a mentir para si mesmo.
 */
const ALLOWED_TRANSITIONS: Record<ExecutionIntentState, ExecutionIntentState[]> = {
  created: ["signed", "failed"],
  /**
   * `signed → confirmed` e `signed → expired` são PERMITIDAS de propósito: uma transação
   * assinada pode ter chegado ao block engine sem que o processo tenha conseguido gravar
   * o "submitted" (queda entre assinar e registrar, resposta perdida). O boot descobre o
   * desfecho pela cadeia — e recusar essa transição faria a recuperação falhar justamente
   * no cenário que ela existe para resolver.
   */
  signed: ["submitted", "confirmed", "failed", "expired"],
  submitted: ["submitted", "confirmed", "failed", "expired"],
  confirmed: [],
  failed: [],
  expired: [],
};

/**
 * Avança o estado da intenção. Devolve `{ ok: true, intent }` com um NOVO objeto
 * (imutável: nada é mutado no registro original) ou `{ ok: false, reason }` quando a
 * transição não é permitida.
 */
export function advanceIntent(
  intent: ExecutionIntentRecord,
  to: ExecutionIntentState,
  patch: Partial<Pick<ExecutionIntentRecord, "signature" | "blockhash" | "lastValidBlockHeight" | "confirmationLevel" | "lastError" | "attempt">> = {},
  reason = "",
  deps: IntentDeps = {}
): { ok: true; intent: ExecutionIntentRecord } | { ok: false; reason: string } {
  if (intent.state === to && to !== "submitted") {
    return { ok: false, reason: `intenção já está em "${to}" (nada a fazer)` };
  }
  if (!ALLOWED_TRANSITIONS[intent.state].includes(to)) {
    return {
      ok: false,
      reason: `transição proibida: ${intent.state} → ${to} (estados terminais não são reutilizados)`,
    };
  }
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const next: ExecutionIntentRecord = {
    ...intent,
    ...patch,
    state: to,
    updatedAt: now,
    history: [...intent.history, { at: now, from: intent.state, to, reason }],
  };
  return { ok: true, intent: next };
}

/**
 * TRAVA DE VOO ÚNICO. Se existe uma intenção não terminal para a mesma posição e o
 * mesmo lado, NÃO se inicia outra: duas transações válidas para a mesma intenção
 * econômica é exatamente o caso que pode comprar (ou vender) duas vezes.
 *
 * `null` = caminho livre.
 */
export function findBlockingIntent(
  intents: readonly ExecutionIntentRecord[],
  positionId: string,
  side: ExecutionSide
): ExecutionIntentRecord | null {
  return (
    intents.find((i) => i.positionId === positionId && i.side === side && !isTerminalIntent(i)) ?? null
  );
}

/** Status de assinatura como observado no RPC, já normalizado. */
export interface SignatureObservation {
  /** `false` quando o RPC/nó respondeu que não conhece a assinatura. */
  found: boolean;
  /** Erro de execução reportado pela cadeia (transação executou e falhou). */
  err: unknown | null;
  confirmationStatus: ConfirmationLevel | null;
}

export interface RetryContext {
  /**
   * Altura de bloco atual (`getBlockHeight`). `null` = não foi possível medir, e sem
   * medição NÃO se prova expiração.
   */
  currentBlockHeight: number | null;
  /**
   * Observação da assinatura anterior. `null` = não foi possível perguntar (RPC fora do
   * ar / assinatura desconhecida). Ausência de resposta não é resposta negativa.
   */
  signatureStatus: SignatureObservation | null;
  /** Se os bytes assinados da tentativa anterior ainda estão em memória. */
  hasSignedBytes: boolean;
  /**
   * true quando a transação usa durable nonce (`AdvanceNonceAccount`). Nonce durável não
   * expira por blockhash: a única prova disponível passa a ser o status de execução.
   */
  usesDurableNonce?: boolean;
}

export type RetryDecision =
  | { action: "stop_confirmed"; level: ConfirmationLevel | null; reason: string }
  | { action: "rebuild"; reason: string }
  | { action: "rebroadcast"; reason: string }
  | { action: "wait"; reason: string };

/**
 * A DECISÃO DE RETRY. Ordem de avaliação (evidência antes de conveniência):
 *
 * 1. Estado terminal confirmado → pare.
 * 2. Cadeia diz que EXECUTOU com erro → rebuild é seguro (aquela transação não volta).
 * 3. Cadeia diz que ENTROU (processed/confirmed/finalized) → pare e registre o nível.
 * 4. Nunca foi assinada → criando pela primeira vez, construa.
 * 5. Blockhash provadamente expirado (altura atual > lastValidBlockHeight) → rebuild.
 * 6. Qualquer outro caso → reenvie os MESMOS bytes se os tiver; senão, espere.
 *    Esperar é a resposta correta quando não se sabe: reconstruir aqui é o defeito.
 */
export function decideRetry(intent: ExecutionIntentRecord, ctx: RetryContext): RetryDecision {
  if (intent.state === "confirmed") {
    return {
      action: "stop_confirmed",
      level: intent.confirmationLevel,
      reason: "Intenção já confirmada: nada é reenviado nem reconstruído.",
    };
  }

  const status = ctx.signatureStatus;
  if (status?.found && status.err) {
    return {
      action: "rebuild",
      reason:
        "A cadeia reportou ERRO de execução para a assinatura anterior: aquela transação executou e " +
        "falhou, não pode voltar. Reconstruir é seguro (com novo blockhash).",
    };
  }
  if (status?.found && status.confirmationStatus) {
    return {
      action: "stop_confirmed",
      level: status.confirmationStatus,
      reason: `A cadeia já reporta a assinatura como "${status.confirmationStatus}": a ação ocorreu.`,
    };
  }

  if (!intent.signature) {
    return {
      action: "rebuild",
      reason: "Nenhuma transação foi assinada para esta intenção: não há duplicata possível.",
    };
  }

  const expiredByHeight =
    !ctx.usesDurableNonce &&
    intent.lastValidBlockHeight !== null &&
    ctx.currentBlockHeight !== null &&
    ctx.currentBlockHeight > intent.lastValidBlockHeight;

  if (expiredByHeight) {
    return {
      action: "rebuild",
      reason:
        `Blockhash expirado: altura atual ${ctx.currentBlockHeight} > lastValidBlockHeight ` +
        `${intent.lastValidBlockHeight}. A tentativa anterior não pode mais entrar em bloco.`,
    };
  }

  if (ctx.usesDurableNonce) {
    return {
      action: "wait",
      reason:
        "Transação com durable nonce não expira por blockhash. Sem status de execução não existe prova " +
        "de que ela não vai entrar: reconstruir aqui poderia produzir duas transações válidas.",
    };
  }

  if (ctx.hasSignedBytes) {
    return {
      action: "rebroadcast",
      reason:
        "Não há prova de expiração nem de falha. A ação segura é reenviar os MESMOS bytes assinados " +
        "(idempotente por mensagem/assinatura), não reconstruir.",
    };
  }

  return {
    action: "wait",
    reason:
      "Sem prova de expiração, sem status e sem os bytes em memória: não sabemos se a tentativa anterior " +
      "entrou. Consultar a assinatura é a única ação honesta; reconstruir poderia duplicar a operação.",
  };
}

/** Motivo legível de expiração, usado em logs. */
export function describeExpiration(intent: ExecutionIntentRecord, currentBlockHeight: number | null): string {
  if (intent.lastValidBlockHeight === null) return "lastValidBlockHeight não registrado (não é possível provar expiração)";
  if (currentBlockHeight === null) return "altura de bloco indisponível (não é possível provar expiração)";
  return `${currentBlockHeight} > ${intent.lastValidBlockHeight}`;
}
