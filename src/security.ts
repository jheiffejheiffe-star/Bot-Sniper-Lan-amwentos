import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { dbStore } from "./persistence.js";
import {
  assertCanSign,
  describeRuntimeMode,
  evaluateCapitalPermission,
  getRuntimeModeResolution,
  registerSigningContextProvider,
  type OperationPurpose,
} from "./runtimeMode.js";

import crypto from "crypto";

const isServer = typeof window === "undefined";

/**
 * Erro de CONFIGURAÇÃO de custódia de chave — é fatal, não transitório.
 *
 * Distinção que importa: uma falha transitória (crypto indisponível) pode ser logada e
 * seguida. Uma chave malformada ou ausente em produção NÃO pode: o operador precisa
 * perceber que o endereço exibido não é o dele antes de enviar qualquer SOL.
 * Sem esta classe, o `catch` externo de initializeVault engolia a recusa e o processo
 * subia com uma carteira errada (ou com `publicKeysCache` vazio) silenciosamente.
 */
export class KeyCustodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyCustodyError";
  }
}

// Volatile Vault State (Only alive in process memory)
interface EncryptedVault {
  operational?: { ciphertext: string; iv: string; tag: string };
  test?: { ciphertext: string; iv: string; tag: string };
  emergency?: { ciphertext: string; iv: string; tag: string };
}

let sessionKey: any = null; // Generated in memory on startup, never saved to disk
let encryptedVault: EncryptedVault = {};

// Cached Public Keys to completely avoid decrypting private keys for simple public key lookups
let publicKeysCache: {
  operational?: PublicKey;
  test?: PublicKey;
  emergency?: PublicKey;
} = {};

// Load operational controls state from persistent DB if available, else default
const savedState = dbStore.getOperationalState();
let activeWalletType: "operational" | "test" | "emergency" = savedState?.activeWallet || "operational";
let killSwitchActive = savedState?.killSwitchActive || false;
let readOnlyMode = savedState?.readOnlyMode || false;
let consecutiveFailures = savedState?.consecutiveFailures || 0;
const failureThreshold = savedState?.failureThreshold || 3;

/**
 * A política de operação de capital vive em runtimeMode.ts; o ESTADO vive aqui.
 * Sem este registro, a barreira de assinatura decidiria sem saber se o kill switch está
 * acionado — ou seja, decidiria errado.
 */
registerSigningContextProvider(() => ({
  killSwitchActive,
  readOnlyMode,
  vaultArmed: isServer ? Boolean(sessionKey) && Boolean(encryptedVault[activeWalletType]) : false,
}));

/**
 * 1. ZEROIZAÇÃO DE BUFFERS — ESCOPO REAL, SEM EXAGERO
 *
 * O QUE ISTO FAZ: sobrescreve com zeros um Uint8Array/Buffer que VOCÊ controla.
 *
 * O QUE ISTO **NÃO** FAZ (verificado em execução, 2026-10-02):
 *   - Não "limpa vestígios de RAM". Em V8, `Buffer.fill(0)` em uma cópia não afeta outras
 *     cópias que o runtime ou a biblioteca possam ter feito. O coletor de lixo ainda pode
 *     conter a versão antiga até reutilizar a página.
 *   - Não protege contra dump de memória em nenhum cenário realista: a chave precisa estar
 *     em texto puro em algum momento para assinar, e `global.gc()` só existe com
 *     --expose-gc (é um no-op silencioso fora disso).
 *   - Verificação empírica: em @solana/web3.js, `Keypair.secretKey` devolve a MESMA
 *     referência interna — `zeroizeBuffer(kp.secretKey)` DESTRÓI o keypair (não é uma
 *     proteção, é uma mutação com efeito colateral). Já em `executeWithDecryptedKeypair`,
 *     zerar o buffer de entrada funciona porque `Keypair.fromSecretKey` também guarda a
 *     referência.
 *
 * UTILIDADE REAL: reduz a janela em que uma cópia específica permanece legível, o que é
 * defesa em profundidade de baixo valor contra um atacante com acesso ao processo. A
 * proteção que importa é NÃO TER a chave no processo (KMS externo / signer isolado).
 * Ver describeKeyCustody().
 */
export function zeroizeBuffer(buffer: Uint8Array | Buffer | null): void {
  if (!buffer) return;
  try {
    buffer.fill(0);
  } catch (err) {
    console.error("[RAM Hardening] Zeroization failed:", err);
  }
}

/**
 * 2. VOLATILE VAULT / KMS STORAGE LAYER
 * Initializes and encrypts/decrypts keypairs in Node RAM-only scope using AES-256-GCM.
 */
export async function initializeVault(): Promise<void> {
  if (!isServer) return;

  try {
    // Create random session key strictly in RAM
    sessionKey = crypto.randomBytes(32);

    // ------------------------------------------------------------------------
    // CARTEIRA OPERACIONAL — FAIL-CLOSED (correção de auditoria)
    //
    // A versão anterior, se OPERATIONAL_PRIVATE_KEY estivesse ausente OU malformada
    // (typo, base58 inválido, JSON truncado), gerava um keypair ALEATÓRIO e continuava,
    // apenas logando "falling back to random".
    //
    // Risco real: o painel exibe um endereço válido e diferente do esperado. O operador
    // pode enviar SOL para ele sem perceber, e no próximo restart o endereço muda —
    // o capital fica inacessível para sempre. Um erro de digitação não pode virar perda
    // de fundos silenciosa.
    // ------------------------------------------------------------------------
    const envKey = process.env.OPERATIONAL_PRIVATE_KEY;
    const isProduction = process.env.NODE_ENV === "production";
    let opKp: Keypair | null = null;

    if (envKey && envKey.trim().length > 0) {
      try {
        if (envKey.trim().startsWith("[")) {
          const secretKey = new Uint8Array(JSON.parse(envKey));
          opKp = Keypair.fromSecretKey(secretKey);
          console.log("[HFT Vault] Carteira operacional carregada de array JSON no ambiente.");
        } else {
          const bs58Module = await import("bs58");
          const secretKey = bs58Module.default.decode(envKey.trim());
          opKp = Keypair.fromSecretKey(secretKey);
          console.log("[HFT Vault] Carteira operacional carregada de string base58 no ambiente.");
        }
      } catch (err: any) {
        // NUNCA cair para aleatória: a chave foi fornecida e está inválida.
        throw new KeyCustodyError(
          `OPERATIONAL_PRIVATE_KEY foi definida mas não pôde ser decodificada (${err.message}). ` +
            `Recusando iniciar com carteira aleatória: o endereço exibido não seria o seu e ` +
            `fundos enviados a ele seriam irrecuperáveis. Corrija a variável ou remova-a.`
        );
      }
    }

    if (!opKp) {
      if (isProduction) {
        throw new KeyCustodyError(
          "OPERATIONAL_PRIVATE_KEY ausente em produção. Recusando iniciar com carteira aleatória " +
            "(o endereço mudaria a cada restart e os fundos enviados a ele seriam perdidos). " +
            "Defina a variável ou use um signer externo/KMS."
        );
      }
      opKp = Keypair.generate();
      console.warn(
        "[HFT Vault] ⚠️  OPERATIONAL_PRIVATE_KEY ausente (ambiente de desenvolvimento). " +
          `Carteira EFÊMERA gerada: ${opKp.publicKey.toBase58()}. ` +
          "NÃO envie SOL para este endereço: ele muda a cada restart e o saldo é irrecuperável."
      );
    }

    const testKp = Keypair.generate();
    const emergencyKp = Keypair.generate();

    // Cache PublicKeys directly in volatile state
    publicKeysCache.operational = opKp.publicKey;
    publicKeysCache.test = testKp.publicKey;
    publicKeysCache.emergency = emergencyKp.publicKey;

    // Encrypt each keypair and save to volatile state
    encryptedVault.operational = encryptSecret(opKp.secretKey);
    encryptedVault.test = encryptSecret(testKp.secretKey);
    encryptedVault.emergency = encryptSecret(emergencyKp.secretKey);

    // AVISO CRÍTICO: em @solana/web3.js, `Keypair.secretKey` devolve a referência interna.
    // As linhas abaixo, portanto, DESTROEM estes objetos Keypair (é por isso que guardamos
    // apenas o PublicKey em cache, e que toda assinatura re-deriva o keypair a partir do
    // ciphertext). Não são "limpeza de vestígios de RAM" — ver comentário de zeroizeBuffer.
    zeroizeBuffer(opKp.secretKey);
    zeroizeBuffer(testKp.secretKey);
    zeroizeBuffer(emergencyKp.secretKey);

    console.log(
      "[Vault] Chaves cifradas em RAM com AES-256-GCM. " +
        "IMPORTANTE: isto NÃO é um KMS — o texto puro da chave operacional reside em " +
        "process.env.OPERATIONAL_PRIVATE_KEY enquanto o processo existir. Detalhes em " +
        "getOperationalSecurityState().keyCustody."
    );
  } catch (err: any) {
    if (err instanceof KeyCustodyError || err?.name === "KeyCustodyError") {
      // Erro de configuração: PROPAGA. O boot não pode continuar com carteira errada.
      console.error("[Vault] FALHA FATAL DE CUSTÓDIA DE CHAVE:", err.message);
      throw err;
    }
    console.error("[Vault] Falha ao inicializar o cofre:", err.message);
  }
}

function encryptSecret(secret: Uint8Array): { ciphertext: string; iv: string; tag: string } {
  // Only called server-side
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sessionKey, iv);
  
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("hex"),
    iv: iv.toString("hex"),
    tag: tag.toString("hex")
  };
}

function decryptSecret(encrypted: { ciphertext: string; iv: string; tag: string }): Uint8Array {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    sessionKey,
    Buffer.from(encrypted.iv, "hex")
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, "hex"));
  
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "hex")),
    decipher.final()
  ]);

  // Convert to Uint8Array safely
  const result = new Uint8Array(decrypted);
  return result;
}

/**
 * 3. WALLET ROTATION ENGINE
 * Swaps operational wallets in sub-milliseconds and zeroizes previous cache lines.
 */
export function rotateActiveWallet(type: "operational" | "test" | "emergency"): void {
  activeWalletType = type;
  dbStore.updateOperationalState({ activeWallet: type });
  console.log(`[Wallet Manager] Active operational wallet rotated to: [${type.toUpperCase()}]`);
}

export function getActiveWalletType(): string {
  return activeWalletType;
}

/**
 * 4. SECURE ISOLATED ED25519 SIGNING PIPELINE
 * Temporarily decrypts key in memory, signs target transaction, then zeroizes immediately.
 * No private key is ever serialized or returned outside of the signing block.
 */
export async function signWithIsolatedKey(
  message: Uint8Array
): Promise<Uint8Array | null> {
  if (!isServer) {
    throw new Error("Private key signature operations are strictly forbidden on browser client");
  }

  // Prevent signing if Kill Switch or Read-Only mode is enabled
  if (killSwitchActive) {
    console.warn("[Isolated Signer] Action blocked: Kill Switch is active.");
    return null;
  }

  // BARREIRA DE MODO: fora de LIVE, não existe assinatura — nem desta função utilitária.
  const permission = evaluateCapitalPermission(getRuntimeModeResolution(), { killSwitchActive, readOnlyMode }, "entry");
  if (!permission.ok) {
    console.warn(`[Isolated Signer] Assinatura bloqueada pelo modo de execução: ${permission.error}`);
    return null;
  }

  const encryptedKey = encryptedVault[activeWalletType];
  if (!encryptedKey) {
    throw new Error(`Wallet of type ${activeWalletType} has not been provisioned in secure vault`);
  }

  let decryptedKey: Uint8Array | null = null;
  try {
    // Decrypt directly into volatile buffer
    decryptedKey = decryptSecret(encryptedKey);
    const keypair = Keypair.fromSecretKey(decryptedKey);

    // Sign message directly using tweetnacl
    const signature = nacl.sign.detached(message, keypair.secretKey);

    // Dynamic verification
    console.log(`[Isolated Signer] Ed25519 signature generated for wallet ${keypair.publicKey.toBase58().slice(0, 8)}...`);
    
    return signature;
  } finally {
    // CRITICAL: Wipe decrypted key from memory buffer IMMEDIATELY after signature
    if (decryptedKey) {
      zeroizeBuffer(decryptedKey);
    }
  }
}

/**
 * Runs a secure operational block requiring a real Keypair, zeroizing the key immediately afterwards.
 */
export async function executeWithDecryptedKeypair<T>(
  callback: (keypair: Keypair) => Promise<T> | T,
  purpose: OperationPurpose = "entry"
): Promise<T> {
  if (!isServer) {
    throw new Error("Keypair operations are strictly forbidden on browser client");
  }

  // Ordem importa: a barreira roda ANTES de qualquer verificação de cofre e antes de
  // decifrar a chave. Se o modo não autoriza, não há motivo para tocar em material secreto.
  // `purpose` default é "entry" (o mais restritivo): esquecer de declarar resulta em
  // comportamento mais conservador, nunca mais permissivo.
  assertCanSign(purpose);

  if (killSwitchActive) {
    throw new Error("[Isolated Signer] Action blocked: Kill Switch is active.");
  }

  const encryptedKey = encryptedVault[activeWalletType];
  if (!encryptedKey) {
    throw new Error(`Wallet of type ${activeWalletType} has not been provisioned in secure vault`);
  }

  let decryptedKey: Uint8Array | null = null;
  try {
    decryptedKey = decryptSecret(encryptedKey);
    const keypair = Keypair.fromSecretKey(decryptedKey);
    return await callback(keypair);
  } finally {
    if (decryptedKey) {
      zeroizeBuffer(decryptedKey);
    }
  }
}

/**
 * Returns the public key of the currently active operational/test/emergency wallet.
 */
export function getActiveWalletPublicKey(): PublicKey {
  const cached = publicKeysCache[activeWalletType];
  if (cached) {
    return cached;
  }
  
  // Fallback if not initialized yet
  const encryptedKey = encryptedVault[activeWalletType];
  if (!encryptedKey) {
    throw new Error(`Wallet of type ${activeWalletType} has not been provisioned in secure vault`);
  }
  const decryptedKey = decryptSecret(encryptedKey);
  try {
    const keypair = Keypair.fromSecretKey(decryptedKey);
    // Cache it now
    publicKeysCache[activeWalletType] = keypair.publicKey;
    return keypair.publicKey;
  } finally {
    zeroizeBuffer(decryptedKey);
  }
}

/**
 * 5. OPERATIONAL CIRCUIT BREAKERS & EMERGENCY KILL SWITCH
 */
export function getOperationalSecurityState() {
  return {
    killSwitchActive,
    readOnlyMode,
    consecutiveFailures,
    failureThreshold,
    activeWallet: activeWalletType,
    vaultArmed: isServer ? !!sessionKey : true,
    isServer,
    // Transparência sobre o que o "vault" realmente é. Ver comentário no topo do arquivo:
    // com a chave em process.env, isto NÃO é um KMS e não protege contra acesso ao processo.
    keyCustody: describeKeyCustody(),
    liveTradingEnabled: isLiveTradingEnabled(),
    // O operador precisa poder ver o MODO e o motivo dele sem ler o código.
    runtimeMode: describeRuntimeMode(),
  };
}

/**
 * Descreve honestamente onde a chave privada está.
 *
 * Motivo: a versão anterior chamava esta camada de "KMS" e logava "Plaintext seed traces
 * wiped", sugerindo garantia de HSM que o código não oferece. Sem KMS externo, o modelo
 * de ameaça real é: quem acessa o processo (RCE, dump de memória, acesso ao .env) obtém a
 * chave. Nomear isso corretamente importa — uma garantia falsa faz o operador alocar
 * mais capital do que deveria.
 */
export function describeKeyCustody() {
  const fromEnvVar = Boolean(process.env.OPERATIONAL_PRIVATE_KEY && process.env.OPERATIONAL_PRIVATE_KEY.trim().length > 0);
  const externalKms = Boolean(process.env.SIGNER_KMS_ENDPOINT || process.env.AWS_KMS_KEY_ID);
  return {
    mode: externalKms ? "external-kms" : fromEnvVar ? "env-var-in-process" : "ephemeral-dev-keypair",
    // Fonte autoritativa da chave (o texto puro vive aqui enquanto o processo existir).
    plaintextLocation: externalKms ? "kms-externo" : fromEnvVar ? "process.env.OPERATIONAL_PRIVATE_KEY" : "memória (efêmera, dev)",
    protectedAgainstProcessAccess: false,
    protectedAgainstDiskAccess: false,
    note: externalKms
      ? "Endpoint de KMS externo configurado; confirme se a assinatura realmente sai do processo."
      : "SEM KMS: a chave é decifrada no mesmo processo do servidor HTTP e o texto puro fica em " +
        "process.env. Não há proteção contra RCE, dump de memória ou leitura do .env. " +
        "Use apenas hot wallet com capital pequeno e descartável.",
  };
}

export function triggerKillSwitch(active: boolean): void {
  killSwitchActive = active;
  dbStore.updateOperationalState({ killSwitchActive: active });
  if (active) {
    console.warn("[OPERATIONAL SECURITY] !!! KILL SWITCH ENGAGED !!! All outbound Jito bundles and trades aborted.");
  } else {
    console.log("[OPERATIONAL SECURITY] Kill Switch disengaged. Rearming system safety barriers.");
  }
}

export function setReadOnlyMode(active: boolean): void {
  readOnlyMode = active;
  dbStore.updateOperationalState({ readOnlyMode: active });
  console.log(`[OPERATIONAL SECURITY] Read-Only Mode set to: [${active ? "ACTIVE" : "DISABLED"}]`);
}

/**
 * Feeds a trade outcome to the Circuit Breaker
 */
export function reportTradeOutcome(success: boolean, slippageExceeded: boolean = false): void {
  if (success) {
    consecutiveFailures = 0;
  } else {
    consecutiveFailures++;
    console.warn(`[Circuit Breaker] Trade failure registered. Consecutive failures: ${consecutiveFailures}/${failureThreshold}`);
  }

  // Trigger safety halt if threshold reached or extreme slippage occurs
  if (consecutiveFailures >= failureThreshold) {
    killSwitchActive = true;
    console.error(`[🚨 CIRCUIT BREAKER AUTOMATIC HALT] consecutive failures exceeded limit of ${failureThreshold}. Shutting down all trading.`);
  }

  if (slippageExceeded) {
    killSwitchActive = true;
    console.error("[🚨 CIRCUIT BREAKER AUTOMATIC HALT] Extreme slippage deviation detected! Capital preservation triggered.");
  }

  dbStore.updateOperationalState({ consecutiveFailures, killSwitchActive });
}

export function resetCircuitBreaker(): void {
  consecutiveFailures = 0;
  killSwitchActive = false;
  dbStore.updateOperationalState({ consecutiveFailures: 0, killSwitchActive: false });
  console.log("[Circuit Breaker] Reset successfully. Consecutive failure counter zeroized.");
}

/* -------------------------------------------------------------------------- */
/* 6. SEPARAÇÃO ENTRE "SINAL REJEITADO" E "OPERAÇÃO FALHOU"                     */
/* -------------------------------------------------------------------------- */

/**
 * AUDITORIA 2026-10-02 — este é um bug de lógica de risco, não de estilo.
 *
 * O código chamava `reportTradeOutcome(false)` sempre que a AUDITORIA rejeitava um
 * token (score baixo / indício de rug). Mas o circuit breaker conta "falhas
 * consecutivas de operação" e dispara o kill switch em 3. Resultado: um bot rodando
 * em um lançamento legítimo porém arriscado recebia 3 rejeições em poucos segundos e
 * se auto-desligava — deixando de operar por causa do acerto do próprio filtro.
 *
 * Rejeitar sinal é SUCESSO do sistema de risco. Não pode alimentar o breaker de execução.
 */
let signalsRejected = 0;
let signalsAccepted = 0;

export function reportSignalRejected(reason: string): void {
  signalsRejected++;
  console.log(
    `[Risk Engine] Sinal rejeitado (${reason}). Total rejeitado nesta sessão: ${signalsRejected}. ` +
      `Rejeição de sinal NÃO conta como falha de execução (não alimenta o circuit breaker).`
  );
  dbStore.updateOperationalState({});
}

export function reportSignalAccepted(): void {
  signalsAccepted++;
}

export function getRiskEngineCounters() {
  return { signalsRejected, signalsAccepted };
}

/* -------------------------------------------------------------------------- */
/* 7. GATE DE OPERAÇÃO REAL (FAIL-CLOSED)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Nenhuma transação que mova capital deve ser assinada por acidente.
 *
 * LIVE_TRADING_ENABLED precisa ser explicitamente "true". Ausente = desligado.
 * Isto é deliberadamente fail-closed: um .env incompleto não deve virar trading real.
 *
 * Modos:
 *   LIVE_TRADING_ENABLED=true  -> assina e envia transações reais.
 *   ausente/false              -> modo PAPER: nenhuma assinatura on-chain. O sistema
 *                                 registra decisões e preços de mercado, marcados
 *                                 como paper, e NÃO grava PnL como se fosse real.
 */
export function isLiveTradingEnabled(): boolean {
  const raw = (process.env.LIVE_TRADING_ENABLED || "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Autoriza requisições MUTANTES (POST) na API.
 *
 * Antes da correção, qualquer processo com acesso de rede à porta 3000 podia chamar
 * /api/positions/close, /api/operational-security/kill-switch ou /api/submit-bundle
 * sem autenticação. Em um servidor com a hot wallet armada, isso equivale a dar a
 * qualquer um na rede o poder de operar a carteira.
 *
 * Política:
 *   - ADMIN_TOKEN definido  -> exige header `x-admin-token` (ou Authorization: Bearer).
 *   - ADMIN_TOKEN ausente   -> em produção: NEGA TUDO (fail-closed).
 *                              em dev: libera para não travar o desenvolvimento,
 *                              com aviso explícito no log.
 */
export function assertMutationAuthorized(req: {
  headers: Record<string, unknown>;
}): { ok: true } | { ok: false; status: number; error: string } {
  const expected = (process.env.ADMIN_TOKEN || "").trim();
  const isProduction = process.env.NODE_ENV === "production";

  if (!expected) {
    if (isProduction) {
      return {
        ok: false,
        status: 503,
        error:
          "ADMIN_TOKEN não configurado em produção. Endpoints mutantes bloqueados por padrão " +
          "(fail-closed). Defina ADMIN_TOKEN para habilitar controle remoto.",
      };
    }

    /**
     * FAIL-OPEN NÃO É GRATUITO — e agora é estreito.
     *
     * A versão anterior liberava QUALQUER POST quando `ADMIN_TOKEN` estava ausente e
     * `NODE_ENV !== "production"`, em um servidor que escuta em 0.0.0.0. Ou seja: um host
     * de desenvolvimento exposto na rede (VPS, container em rede compartilhada, túnel,
     * pré-visualização) aceitava kill switch, fechamento de posição e mudança de modo sem
     * autenticação.
     *
     * Regra atual: sem token, só passa se NÃO existe capital real em jogo — nem chave
     * operacional provisionada, nem modo LIVE. No instante em que há chave real, o token
     * passa a ser obrigatório, independentemente de NODE_ENV.
     */
    const hasRealKey = Boolean((process.env.OPERATIONAL_PRIVATE_KEY || "").trim());
    const mode = getRuntimeModeResolution().mode;
    if (hasRealKey || mode === "LIVE") {
      return {
        ok: false,
        status: 503,
        error:
          "ADMIN_TOKEN não configurado e há capital real em jogo " +
          `(chave operacional: ${hasRealKey ? "presente" : "ausente"}; modo: ${mode}). ` +
          "Endpoints mutantes bloqueados por padrão (fail-closed). Defina ADMIN_TOKEN.",
      };
    }

    console.warn(
      "[API Guard] POST sem autenticação permitido APENAS porque não há chave operacional real " +
        "nem modo LIVE. Defina ADMIN_TOKEN antes de operar capital."
    );
    return { ok: true };
  }

  const headerToken =
    (req.headers["x-admin-token"] as string | undefined) ||
    (typeof req.headers["authorization"] === "string" &&
    (req.headers["authorization"] as string).startsWith("Bearer ")
      ? (req.headers["authorization"] as string).slice(7)
      : undefined);

  if (!headerToken || !timingSafeEqualStrings(headerToken, expected)) {
    return { ok: false, status: 401, error: "Não autorizado. Header x-admin-token inválido ou ausente." };
  }

  return { ok: true };
}

/** Comparação em tempo constante para evitar timing oracle na validação do token. */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/** Bloqueia execução quando o modo read-only está ativo (antes era ignorado nos endpoints). */
export function assertExecutionAllowed(): { ok: true } | { ok: false; status: number; error: string } {
  // Delega para a política única (modo + kill switch + read-only + cofre). Antes, esta
  // função reimplementava a política e podia divergir da barreira de assinatura.
  const verdict = evaluateCapitalPermission(
    getRuntimeModeResolution(),
    { killSwitchActive, readOnlyMode, vaultArmed: isServer ? Boolean(sessionKey) : false },
    "entry"
  );
  return verdict.ok ? { ok: true } : { ok: false, status: verdict.status, error: verdict.error };
}

/**
 * Gate específico para SAÍDA (liquidação).
 *
 * DECISÃO DELIBERADA DE RISCO — e é uma trade-off, não um detalhe:
 * uma saída REDUZ exposição. Bloquear saída pode prender capital em um ativo que está
 * caindo, o que é pior do que qualquer política de "não tocar a rede".
 *
 * Política implementada:
 *   - LIVE_TRADING_ENABLED=false (paper) -> não há o que liquidar on-chain; o chamador
 *     deve fechar em modo shadow. Retorna bloqueado com mensagem explícita.
 *   - readOnlyMode ativo -> PERMITE a saída, com log WARN (reduz risco; o operador que
 *     quer bloqueio total deve usar o kill switch).
 *   - killSwitch ativo -> bloqueia, A MENOS que BLOCK_EXITS_ON_KILL_SWITCH=false
 *     (default "false": em pânico, poder sair é o comportamento correto).
 */
export function assertExitAllowed(): { ok: true; warnings: string[] } | { ok: false; status: number; error: string } {
  // Mesma política única, com `purpose: "exit"` — que é onde ela é deliberadamente
  // assimétrica: saída reduz exposição e por isso tem precedência sobre read-only.
  const verdict = evaluateCapitalPermission(
    getRuntimeModeResolution(),
    { killSwitchActive, readOnlyMode, vaultArmed: isServer ? Boolean(sessionKey) : false },
    "exit"
  );
  return verdict.ok ? { ok: true, warnings: verdict.warnings } : { ok: false, status: verdict.status, error: verdict.error };
}
