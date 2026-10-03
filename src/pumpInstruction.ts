/**
 * PUMP INSTRUCTION — construção de instrução a partir do IDL OFICIAL (Etapa S6).
 *
 * ## O que faz
 *
 * Constrói a instrução de COMPRA da bonding curve do pump.fun (`buy_exact_sol_in`, a que gasta
 * um valor EXATO de SOL) exatamente como o IDL oficial a define: discriminador, ordem das
 * contas, seeds dos PDAs e layout dos argumentos. Também lê e valida as contas `Global` e
 * `BondingCurve` (fee recipient, creator, reservas, taxas) e aplica a **fórmula de cotação
 * publicada pela própria equipe do programa** nas docs de `buy_exact_sol_in`.
 *
 * ## Como funciona
 *
 * - **Zero rede, zero chave, zero assinatura.** O módulo não importa `security`, não lê
 *   `process.env` e não abre socket. Usa `@solana/web3.js` apenas para derivar PDAs
 *   (`findProgramAddressSync`) e validar endereços — criptografia pública, nenhum segredo.
 *   O teste [25] varre o arquivo e falha se `Keypair`/`sendTransaction`/chave aparecerem aqui.
 * - **O layout é DADO, não código espalhado.** `BONDING_CURVE_LAYOUT` e `GLOBAL_LAYOUT` são
 *   tabelas de campos, e o teste compara essas tabelas, campo por campo, com o IDL pinado em
 *   `assets/pump-idl-excerpt.json`. Trocar a ordem de dois campos quebra o teste, não a
 *   produção silenciosamente.
 * - **Erro de layout não gasta taxa.** A instrução montada aqui passa pelo PRÉ-FLIGHT
 *   obrigatório do caminho de entrada (`docs`): layout errado aparece como simulação reprovada,
 *   com os logs do programa, ANTES de qualquer assinatura. É o mesmo mecanismo que protege o
 *   caminho do agregador.
 *
 * ## Dependências
 *
 * - `@solana/web3.js`: `PublicKey` (derivação de PDA e validação de endereço). Nada além disso.
 * - `assets/pump-idl-excerpt.json`: a fonte do layout. O teste compara builder × IDL.
 *
 * ## Riscos (leia antes de usar)
 *
 * 1. **O IDL muda.** O próprio repositório oficial já mudou o layout em 2025 (fee_config,
 *    fee_program, volume accumulators) e hoje publica instruções v2 com `quote_mint`. Uma
 *    instrução montada com layout vencido falha — o pré-flight pega, mas você perde a
 *    oportunidade. Antes de operar: rode `scripts/pump-dryrun.ts` contra mainnet.
 * 2. **Taxas dinâmicas.** O programa `pump-fees` (FeeConfig) define faixas por market cap; as
 *    taxas usadas aqui (`Global.fee_basis_points`, `BondingCurve.creator_fee_bps`) são as
 *    declaradas na conta. Se a faixa dinâmica for maior, o resultado real é MENOR que o
 *    cotado — o que torna `min_tokens_out` conservador (a curva reverte em vez de aceitar
 *    preço pior). Reverter custa uma tentativa, não capital: reverter é o lado seguro.
 * 3. **`quote_mint` não-SOL.** Esta instrução é de curva com cotação em SOL. O módulo RECUSA
 *    curvas cujo `quote_mint` não seja wSOL/zero (guarda `assertSolQuotedCurve`), porque as
 *    instruções de moeda de cotação são as `*_v2` e a conta `quote_mint` nem aparece nesta.
 * 4. **PDA derivado ≠ endereço publicado na web.** Ver `EVENT_AUTHORITY_TRAP_*`: existe pelo
 *    menos um endereço amplamente copiado com o MESMO prefixo de vaidade e sufixo diferente.
 *    Este módulo nunca aceita endereço copiado — deriva do IDL e provou o `global` contra
 *    duas fontes independentes.
 *
 * ## Como testar
 *
 * `npm run test` (grupo [25]): layout × IDL campo a campo, discriminadores, PDAs contra
 * ground truth público, fórmula de cotação (passo a passo das docs), limites/erros de entrada,
 * guarda de curva não-SOL, parsers com dados sintéticos e rejeição de dados truncados.
 *
 * ## Como colocar em produção
 *
 * Não é ligado por import: o caminho de entrada usa `HFT_ENTRY_ROUTE=aggregator` (default e
 * validado) ou `native` (esta instrução). Antes de usar `native`: (a) `npm run pump:dryrun --
 * <mint>` no VPS, que simula a instrução real contra a mainnet SEM assinar; (b) conferir que o
 * resultado da simulação é `err: null`; (c) só então habilitar a rota.
 */

import { PublicKey } from "@solana/web3.js";

/* -------------------------------------------------------------------------- */
/* 0. PROGRAMAS E CONSTANTES (do IDL pinado)                                   */
/* -------------------------------------------------------------------------- */

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_FEE_PROGRAM_ID = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/** Discriminadores de instrução — bytes do IDL, na ordem em que vão na instrução. */
export const PUMP_INSTRUCTION_DISCRIMINATORS = {
  buy: [102, 6, 61, 18, 1, 218, 235, 234],
  buyExactSolIn: [56, 252, 116, 8, 158, 223, 205, 95],
} as const;

/** Discriminadores de CONTA (os 8 primeiros bytes de toda conta Anchor do programa). */
export const PUMP_ACCOUNT_DISCRIMINATORS = {
  BondingCurve: [23, 183, 248, 55, 96, 216, 172, 96],
  FeeConfig: [143, 52, 146, 187, 219, 123, 76, 155],
  Global: [167, 232, 232, 177, 200, 108, 114, 127],
  GlobalVolumeAccumulator: [202, 42, 246, 43, 142, 190, 30, 255],
  QuoteControl: [56, 244, 35, 238, 193, 213, 162, 201],
  SharingConfig: [216, 74, 9, 0, 56, 140, 93, 75],
  UserVolumeAccumulator: [86, 255, 112, 14, 102, 53, 154, 250],
} as const;

export const PDA_SEEDS = {
  global: "global",
  bondingCurve: "bonding-curve",
  creatorVault: "creator-vault",
  eventAuthority: "__event_authority",
  globalVolumeAccumulator: "global_volume_accumulator",
  userVolumeAccumulator: "user_volume_accumulator",
  feeConfig: "fee_config",
} as const;

/**
 * ARMADILHA DOCUMENTADA — endereços "sósia" com prefixo de vaidade.
 *
 * O `event_authority` do pump é um PDA derivado de ["__event_authority"] sob o programa. O
 * endereço amplamente copiado em exemplos da web (`Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7Hx6SgqR`)
 * é um base58 VÁLIDO de 32 bytes e compartilha 40 caracteres de prefixo com o derivado — o
 * padrão exato do endereço fabricado que esta base já removeu na auditoria C4. Ele NÃO é
 * aceito aqui: o módulo deriva, e o teste [25] trava a diferença.
 */
export const EVENT_AUTHORITY_TRAP_ADDRESSES = [
  "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7Hx6SgqR",
] as const;

/* -------------------------------------------------------------------------- */
/* 1. LAYOUTS (tabelas — comparadas com o IDL pinado pelo teste)               */
/* -------------------------------------------------------------------------- */

export type FieldKind = "u8" | "u16" | "u64" | "i64" | "u128" | "bool" | "pubkey";
export interface LayoutField {
  name: string;
  kind: FieldKind;
  /** Repetições (arrays fixos do IDL, ex.: `["pubkey", 7]`). Default 1. */
  count?: number;
}

export const FIELD_SIZES: Record<FieldKind, number> = {
  u8: 1,
  u16: 2,
  u64: 8,
  i64: 8,
  u128: 16,
  bool: 1,
  pubkey: 32,
};

/**
 * `BondingCurve` — ordem EXATA do tipo no IDL pinado.
 *
 * Note que o IDL atual usa `virtual_quote_reserves`/`real_quote_reserves` (cotação genérica) em
 * vez dos antigos `virtual_sol_reserves`/`real_sol_reserves`. Ler o campo errado aqui não daria
 * erro de parse — daria um NÚMERO PLAUSÍVEL E ERRADO, que é o pior desfecho possível.
 */
export const BONDING_CURVE_LAYOUT: LayoutField[] = [
  { name: "virtual_token_reserves", kind: "u64" },
  { name: "virtual_quote_reserves", kind: "u64" },
  { name: "real_token_reserves", kind: "u64" },
  { name: "real_quote_reserves", kind: "u64" },
  { name: "token_total_supply", kind: "u64" },
  { name: "complete", kind: "bool" },
  { name: "creator", kind: "pubkey" },
  { name: "is_mayhem_mode", kind: "bool" },
  { name: "is_cashback_coin", kind: "bool" },
  { name: "quote_mint", kind: "pubkey" },
  { name: "creator_fee_bps", kind: "u64" },
  { name: "can_edit_creator_fee", kind: "bool" },
  { name: "is_holder_reward", kind: "bool" },
];

export const GLOBAL_LAYOUT: LayoutField[] = [
  { name: "initialized", kind: "bool" },
  { name: "authority", kind: "pubkey" },
  { name: "fee_recipient", kind: "pubkey" },
  { name: "initial_virtual_token_reserves", kind: "u64" },
  { name: "initial_virtual_sol_reserves", kind: "u64" },
  { name: "initial_real_token_reserves", kind: "u64" },
  { name: "token_total_supply", kind: "u64" },
  { name: "fee_basis_points", kind: "u64" },
  { name: "withdraw_authority", kind: "pubkey" },
  { name: "enable_migrate", kind: "bool" },
  { name: "pool_migration_fee", kind: "u64" },
  { name: "creator_fee_basis_points", kind: "u64" },
  { name: "fee_recipients", kind: "pubkey", count: 7 },
  { name: "set_creator_authority", kind: "pubkey" },
  { name: "admin_set_creator_authority", kind: "pubkey" },
  { name: "create_v2_enabled", kind: "bool" },
  { name: "whitelist_pda", kind: "pubkey" },
  { name: "reserved_fee_recipient", kind: "pubkey" },
  { name: "mayhem_mode_enabled", kind: "bool" },
  { name: "reserved_fee_recipients", kind: "pubkey", count: 7 },
  { name: "is_cashback_enabled", kind: "bool" },
  { name: "buyback_fee_recipients", kind: "pubkey", count: 8 },
  { name: "buyback_basis_points", kind: "u64" },
  { name: "initial_virtual_quote_reserves", kind: "u64" },
  { name: "whitelisted_quote_mints", kind: "pubkey", count: 1 },
  { name: "creator_fee_configurable", kind: "bool" },
  { name: "max_configurable_creator_fee_bps", kind: "u64" },
  { name: "holder_reward_claim_authority", kind: "pubkey" },
  { name: "is_holder_reward_enabled", kind: "bool" },
];

export function layoutSize(layout: LayoutField[]): number {
  return layout.reduce((acc, f) => acc + FIELD_SIZES[f.kind] * (f.count ?? 1), 0);
}

/** Tamanho total da conta = discriminador (8) + struct. */
export const BONDING_CURVE_ACCOUNT_SIZE = 8 + layoutSize(BONDING_CURVE_LAYOUT);
export const GLOBAL_ACCOUNT_SIZE = 8 + layoutSize(GLOBAL_LAYOUT);

/* -------------------------------------------------------------------------- */
/* 2. LEITURA DE CONTA (pura, defensiva)                                       */
/* -------------------------------------------------------------------------- */

export interface ParseIssue {
  code: string;
  message: string;
}

export interface ParseResult<T> {
  value: T | null;
  problems: ParseIssue[];
}

function toBytes(data: Uint8Array | Buffer | null | undefined): Uint8Array | null {
  if (!data) return null;
  if (data instanceof Uint8Array) return data;
  return null;
}

function bytesEqual(a: Uint8Array, b: readonly number[]): boolean {
  if (a.length < b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function readStruct(layout: LayoutField[], data: Uint8Array, offset: number): { values: Record<string, any>; next: number } {
  const values: Record<string, any> = {};
  let o = offset;
  for (const field of layout) {
    const count = field.count ?? 1;
    if (field.kind === "pubkey") {
      if (count === 1) {
        values[field.name] = new PublicKey(data.slice(o, o + 32)).toBase58();
      } else {
        const list: string[] = [];
        for (let i = 0; i < count; i++) {
          list.push(new PublicKey(data.slice(o + i * 32, o + i * 32 + 32)).toBase58());
        }
        values[field.name] = list;
      }
      o += 32 * count;
      continue;
    }
    const size = FIELD_SIZES[field.kind];
    if (count === 1) {
      values[field.name] = readScalar(field.kind, data, o);
    } else {
      const list: any[] = [];
      for (let i = 0; i < count; i++) list.push(readScalar(field.kind, data, o + i * size));
      values[field.name] = list;
    }
    o += size * count;
  }
  return { values, next: o };
}

function readScalar(kind: FieldKind, data: Uint8Array, offset: number): number | bigint | boolean | string {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  switch (kind) {
    case "u8":
      return view.getUint8(offset);
    case "u16":
      return view.getUint16(offset, true);
    case "u64":
      return view.getBigUint64(offset, true);
    case "i64":
      return view.getBigInt64(offset, true);
    case "u128": {
      const low = view.getBigUint64(offset, true);
      const high = view.getBigUint64(offset + 8, true);
      return (high << 64n) | low;
    }
    case "bool":
      return view.getUint8(offset) !== 0;
    case "pubkey":
      // Chamado só pelo ramo de array (`count > 1`), já que o caso escalar de pubkey é
      // tratado antes em `readStruct`. Mantido explícito para o switch ser exaustivo —
      // um `kind` novo no layout tem de quebrar o build, não passar batido.
      return new PublicKey(data.slice(offset, offset + 32)).toBase58();
    default: {
      const exhaustive: never = kind;
      throw new Error(`kind de layout não suportado: ${String(exhaustive)}`);
    }
  }
}

function parseAccount<T>(params: {
  data: Uint8Array | Buffer | null | undefined;
  layout: LayoutField[];
  expectedSize: number;
  discriminator: readonly number[];
  name: string;
}): ParseResult<T> {
  const problems: ParseIssue[] = [];
  const bytes = toBytes(params.data);
  if (!bytes) {
    return { value: null, problems: [{ code: "sem-dado", message: `conta ${params.name}: nenhum dado fornecido` }] };
  }
  if (bytes.length < 8) {
    return {
      value: null,
      problems: [{ code: "curta-demais", message: `conta ${params.name}: ${bytes.length} bytes — nem o discriminador cabe` }],
    };
  }
  if (!bytesEqual(bytes, params.discriminator)) {
    return {
      value: null,
      problems: [
        {
          code: "discriminador-errado",
          message:
            `conta ${params.name}: discriminador ${Array.from(bytes.slice(0, 8)).join(",")} não é o esperado ` +
            `${params.discriminator.join(",")} (conta de outro tipo ou programa errado)`,
        },
      ],
    };
  }
  if (bytes.length < params.expectedSize) {
    /**
   * Conta MENOR que o struct atual. Motivo real e comum: o programa tem instrução
   * `extend_account` e contas antigas ficam com o layout antigo. Ler assim mesmo produziria
   * números plausíveis e errados — recusar é a única resposta honesta.
   */
    return {
      value: null,
      problems: [
        {
          code: "bytes-insuficientes",
          message:
            `conta ${params.name}: ${bytes.length} bytes, esperado ≥ ${params.expectedSize} ` +
            `(layout desatualizado/extensão pendente). Recusando para não ler campo errado.`,
        },
      ],
    };
  }
  const { values, next } = readStruct(params.layout, bytes, 8);
  if (next > bytes.length) {
    return { value: null, problems: [{ code: "leitura-passou-do-fim", message: `conta ${params.name}: leitura passou do fim` }] };
  }
  return { value: values as T, problems };
}

export interface BoundingCurveState {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: string;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  quoteMint: string;
  creatorFeeBps: number;
  canEditCreatorFee: boolean;
  isHolderReward: boolean;
}

export interface GlobalState {
  initialized: boolean;
  authority: string;
  feeRecipient: string;
  feeBasisPoints: number;
  creatorFeeBasisPoints: number;
  creatorFeeConfigurable: boolean;
  isCashbackEnabled: boolean;
  mayhemModeEnabled: boolean;
  createV2Enabled: boolean;
}

export function parseBondingCurveAccount(data: Uint8Array | Buffer | null | undefined): ParseResult<BoundingCurveState> {
  const raw = parseAccount<any>({
    data,
    layout: BONDING_CURVE_LAYOUT,
    expectedSize: BONDING_CURVE_ACCOUNT_SIZE,
    discriminator: PUMP_ACCOUNT_DISCRIMINATORS.BondingCurve,
    name: "BondingCurve",
  });
  if (!raw.value) return { value: null, problems: raw.problems };
  const r = raw.value;
  return {
    value: {
      virtualTokenReserves: r.virtual_token_reserves,
      virtualQuoteReserves: r.virtual_quote_reserves,
      realTokenReserves: r.real_token_reserves,
      realQuoteReserves: r.real_quote_reserves,
      tokenTotalSupply: r.token_total_supply,
      complete: r.complete,
      creator: r.creator,
      isMayhemMode: r.is_mayhem_mode,
      isCashbackCoin: r.is_cashback_coin,
      quoteMint: r.quote_mint,
      creatorFeeBps: Number(r.creator_fee_bps),
      canEditCreatorFee: r.can_edit_creator_fee,
      isHolderReward: r.is_holder_reward,
    },
    problems: raw.problems,
  };
}

export function parseGlobalAccount(data: Uint8Array | Buffer | null | undefined): ParseResult<GlobalState> {
  const raw = parseAccount<any>({
    data,
    layout: GLOBAL_LAYOUT,
    expectedSize: GLOBAL_ACCOUNT_SIZE,
    discriminator: PUMP_ACCOUNT_DISCRIMINATORS.Global,
    name: "Global",
  });
  if (!raw.value) return { value: null, problems: raw.problems };
  const r = raw.value;
  return {
    value: {
      initialized: r.initialized,
      authority: r.authority,
      feeRecipient: r.fee_recipient,
      feeBasisPoints: Number(r.fee_basis_points),
      creatorFeeBasisPoints: Number(r.creator_fee_basis_points),
      creatorFeeConfigurable: r.creator_fee_configurable,
      isCashbackEnabled: r.is_cashback_enabled,
      mayhemModeEnabled: r.mayhem_mode_enabled,
      createV2Enabled: r.create_v2_enabled,
    },
    problems: raw.problems,
  };
}

/* -------------------------------------------------------------------------- */
/* 3. PDAs (derivação — nunca endereço copiado)                                */
/* -------------------------------------------------------------------------- */

function pda(seeds: (Buffer | Uint8Array)[], programId: string): string {
  return PublicKey.findProgramAddressSync(seeds as Buffer[], new PublicKey(programId))[0].toBase58();
}

export function deriveGlobalPda(): string {
  return pda([Buffer.from(PDA_SEEDS.global)], PUMP_PROGRAM_ID);
}

export function deriveBondingCurvePda(mint: string): string {
  return pda([Buffer.from(PDA_SEEDS.bondingCurve), new PublicKey(mint).toBuffer()], PUMP_PROGRAM_ID);
}

export function deriveAssociatedBondingCurve(mint: string, tokenProgram: string = TOKEN_PROGRAM_ID): string {
  const bondingCurve = new PublicKey(deriveBondingCurvePda(mint));
  return pda(
    [bondingCurve.toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

export function deriveCreatorVaultPda(creator: string): string {
  return pda([Buffer.from(PDA_SEEDS.creatorVault), new PublicKey(creator).toBuffer()], PUMP_PROGRAM_ID);
}

export function deriveEventAuthorityPda(): string {
  return pda([Buffer.from(PDA_SEEDS.eventAuthority)], PUMP_PROGRAM_ID);
}

export function deriveGlobalVolumeAccumulatorPda(): string {
  return pda([Buffer.from(PDA_SEEDS.globalVolumeAccumulator)], PUMP_PROGRAM_ID);
}

export function deriveUserVolumeAccumulatorPda(user: string): string {
  return pda([Buffer.from(PDA_SEEDS.userVolumeAccumulator), new PublicKey(user).toBuffer()], PUMP_PROGRAM_ID);
}

/** `["fee_config", <pump program id>]` sob o programa de taxas. */
export function deriveFeeConfigPda(): string {
  return pda([Buffer.from(PDA_SEEDS.feeConfig), new PublicKey(PUMP_PROGRAM_ID).toBuffer()], PUMP_FEE_PROGRAM_ID);
}

export function deriveAssociatedTokenAddress(owner: string, mint: string, tokenProgram: string = TOKEN_PROGRAM_ID): string {
  return pda(
    [new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

/* -------------------------------------------------------------------------- */
/* 4. COTAÇÃO (fórmula publicada nas docs de buy_exact_sol_in)                 */
/* -------------------------------------------------------------------------- */

export interface QuoteExactSolInParams {
  /** SOL que será gasto (lamports), taxas INCLUÍDAS — é o argumento da instrução. */
  spendableSolIn: bigint;
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  protocolFeeBps: number;
  /** 0 quando a moeda não tem creator. */
  creatorFeeBps: number;
}

export interface QuoteExactSolInResult {
  tokensOut: bigint;
  netSol: bigint;
  totalFeeBps: number;
  /** Rastreio dos passos, para auditoria e para o painel explicar o número. */
  steps: string[];
}

const TEN_THOUSAND = 10_000n;

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * `tokens_out` para um gasto exato de SOL — implementa, na ordem, os 4 passos das docs oficiais.
 *
 * Devolve `null` (e nunca um número "aproximado") quando os dados não permitem calcular:
 * reserva não positiva, gasto pequeno demais para cobrir taxas, ou resultado ≤ 0. Um número
 * inventado aqui viraria `min_tokens_out` inventado — e `min_tokens_out` é justamente a
 * proteção contra comprar a preço ruim.
 */
export function quoteTokensOutExactSolIn(p: QuoteExactSolInParams): QuoteExactSolInResult | null {
  const protocolFeeBps = Math.max(0, Math.floor(p.protocolFeeBps));
  const creatorFeeBps = Math.max(0, Math.floor(p.creatorFeeBps));
  const totalFeeBps = protocolFeeBps + creatorFeeBps;
  if (totalFeeBps >= 10_000) return null;
  if (p.spendableSolIn <= 0n) return null;
  if (p.virtualTokenReserves <= 0n || p.virtualQuoteReserves <= 0n) return null;

  const steps: string[] = [];
  // 1. net_sol = floor(spendable * 10_000 / (10_000 + total_fee_bps))
  let netSol = (p.spendableSolIn * TEN_THOUSAND) / (TEN_THOUSAND + BigInt(totalFeeBps));
  steps.push(`net_sol=${netSol}`);

  // 2. fees = ceil(net_sol * protocol / 10_000) + ceil(net_sol * creator / 10_000)
  const fees =
    ceilDiv(netSol * BigInt(protocolFeeBps), TEN_THOUSAND) + ceilDiv(netSol * BigInt(creatorFeeBps), TEN_THOUSAND);
  steps.push(`fees=${fees}`);

  // 3. se net_sol + fees passa do gasto, reduz net_sol
  if (netSol + fees > p.spendableSolIn) {
    netSol = netSol - (netSol + fees - p.spendableSolIn);
    steps.push(`net_sol ajustado=${netSol}`);
  }

  // 4. tokens_out = floor((net_sol - 1) * vTokens / (vQuote + net_sol - 1))
  if (netSol <= 1n) return null;
  const numerator = (netSol - 1n) * p.virtualTokenReserves;
  const denominator = p.virtualQuoteReserves + netSol - 1n;
  if (denominator <= 0n) return null;
  const tokensOut = numerator / denominator;
  if (tokensOut <= 0n) return null;
  steps.push(`tokens_out=${tokensOut}`);

  return { tokensOut, netSol, totalFeeBps, steps };
}

/**
 * Piso de tokens aceitável: `esperado × (1 − slippage)`. É o argumento `min_tokens_out`.
 *
 * Arredonda PARA BAIXO (aceita menos), que é o lado conservador para quem compra: um piso
 * mais alto rejeita execuções válidas; mais baixo aceita preço pior. `slippageBps` é limitado
 * a [0, 9999]: 10.000 bps aceitaria qualquer preço — inclusive infinito.
 */
export function minTokensOutFromSlippage(expectedTokensOut: bigint, slippageBps: number): bigint {
  const bps = Math.min(9_999, Math.max(0, Math.floor(slippageBps)));
  return (expectedTokensOut * BigInt(10_000 - bps)) / TEN_THOUSAND;
}

/* -------------------------------------------------------------------------- */
/* 5. CONSTRUÇÃO DA INSTRUÇÃO                                                  */
/* -------------------------------------------------------------------------- */

export interface AccountKey {
  /** Nome da conta NO IDL — usado pelo teste para comparar ordem e nomes com o IDL pinado. */
  name: string;
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface BuiltInstruction {
  programId: string;
  keys: AccountKey[];
  data: Buffer;
  /** Nomes na ordem do IDL — atalho para log/diagnóstico. */
  accountNames: string[];
}

function disc(d: readonly number[]): Buffer {
  return Buffer.from(d);
}

function u64le(value: bigint): Buffer {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error(`u64 fora do intervalo: ${value}`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

/** Dados de `buy`: amount (tokens), max_sol_cost (lamports), track_volume (OptionBool = 1 byte). */
export function buildBuyData(params: { amount: bigint; maxSolCost: bigint; trackVolume: boolean }): Buffer {
  return Buffer.concat([
    disc(PUMP_INSTRUCTION_DISCRIMINATORS.buy),
    u64le(params.amount),
    u64le(params.maxSolCost),
    Buffer.from([params.trackVolume ? 1 : 0]),
  ]);
}

/** Dados de `buy_exact_sol_in`: spendable_quote_in (lamports), min_tokens_out (tokens). */
export function buildBuyExactSolInData(params: { spendableSolIn: bigint; minTokensOut: bigint }): Buffer {
  return Buffer.concat([
    disc(PUMP_INSTRUCTION_DISCRIMINATORS.buyExactSolIn),
    u64le(params.spendableSolIn),
    u64le(params.minTokensOut),
  ]);
}

export interface BuyAccountsParams {
  mint: string;
  user: string;
  /** `Global.fee_recipient` — lido da conta, nunca hardcoded (muda quando o protocolo muda). */
  feeRecipient: string;
  /** `BondingCurve.creator` — define o PDA do creator_vault. */
  creator: string;
  /** Programa do token do mint (SPL Token ou Token-2022). Default: SPL Token. */
  tokenProgram?: string;
}

/**
 * Lista de contas de `buy`/`buy_exact_sol_in` — a MESMA nos dois (conferida no IDL pinado),
 * na ordem do IDL. Cada entrada carrega o nome do IDL para que o teste compare com o arquivo.
 */
export function buildBuyAccountKeys(params: BuyAccountsParams): AccountKey[] {
  const tokenProgram = params.tokenProgram ?? TOKEN_PROGRAM_ID;
  return [
    { name: "global", pubkey: deriveGlobalPda(), isSigner: false, isWritable: false },
    { name: "fee_recipient", pubkey: params.feeRecipient, isSigner: false, isWritable: true },
    { name: "mint", pubkey: params.mint, isSigner: false, isWritable: false },
    { name: "bonding_curve", pubkey: deriveBondingCurvePda(params.mint), isSigner: false, isWritable: true },
    {
      name: "associated_bonding_curve",
      pubkey: deriveAssociatedBondingCurve(params.mint, tokenProgram),
      isSigner: false,
      isWritable: true,
    },
    {
      name: "associated_user",
      pubkey: deriveAssociatedTokenAddress(params.user, params.mint, tokenProgram),
      isSigner: false,
      isWritable: true,
    },
    { name: "user", pubkey: params.user, isSigner: true, isWritable: true },
    { name: "system_program", pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    { name: "token_program", pubkey: tokenProgram, isSigner: false, isWritable: false },
    { name: "creator_vault", pubkey: deriveCreatorVaultPda(params.creator), isSigner: false, isWritable: true },
    { name: "event_authority", pubkey: deriveEventAuthorityPda(), isSigner: false, isWritable: false },
    { name: "program", pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    {
      name: "global_volume_accumulator",
      pubkey: deriveGlobalVolumeAccumulatorPda(),
      isSigner: false,
      isWritable: false,
    },
    {
      name: "user_volume_accumulator",
      pubkey: deriveUserVolumeAccumulatorPda(params.user),
      isSigner: false,
      isWritable: true,
    },
    { name: "fee_config", pubkey: deriveFeeConfigPda(), isSigner: false, isWritable: false },
    { name: "fee_program", pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
}

/**
 * Instrução `buy_exact_sol_in`: gasta no máximo `spendableSolIn` lamports e exige ao menos
 * `minTokensOut` tokens. É a instrução certa para sniper: o valor gasto é conhecido ANTES, e a
 * proteção contra preço ruim é explícita (a curva reverte em vez de encher de tokens a preço pior).
 */
export function buildPumpBuyExactSolInInstruction(
  params: BuyAccountsParams & { spendableSolIn: bigint; minTokensOut: bigint }
): BuiltInstruction {
  const keys = buildBuyAccountKeys(params);
  return {
    programId: PUMP_PROGRAM_ID,
    keys,
    accountNames: keys.map((k) => k.name),
    data: buildBuyExactSolInData({ spendableSolIn: params.spendableSolIn, minTokensOut: params.minTokensOut }),
  };
}

/** Instrução `buy`: quantidade EXATA de tokens com teto de SOL. Mantida para completude do IDL. */
export function buildPumpBuyInstruction(
  params: BuyAccountsParams & { amount: bigint; maxSolCost: bigint; trackVolume?: boolean }
): BuiltInstruction {
  const keys = buildBuyAccountKeys(params);
  return {
    programId: PUMP_PROGRAM_ID,
    keys,
    accountNames: keys.map((k) => k.name),
    data: buildBuyData({ amount: params.amount, maxSolCost: params.maxSolCost, trackVolume: params.trackVolume ?? false }),
  };
}

/* -------------------------------------------------------------------------- */
/* 6. GUARDAS DE CURVA (falham antes de montar)                                */
/* -------------------------------------------------------------------------- */

/**
 * A instrução `buy`/`buy_exact_sol_in` NÃO tem conta `quote_mint`: ela é da curva cotada em SOL.
 * Moedas com outra cotação usam as instruções `*_v2`. A guarda existe porque o desfecho de usar
 * a instrução errada é uma falha de programa — no melhor caso — e um número sem sentido no pior.
 *
 * A conta de SOL pode aparecer como wSOL ou como o endereço zero (system program). Ambos são
 * aceitos; o dry-run imprime o valor OBSERVADO para o operador confirmar qual aparece.
 */
export function assertSolQuotedCurve(quoteMint: string): { ok: boolean; reason?: string } {
  if (quoteMint === WSOL_MINT || quoteMint === SYSTEM_PROGRAM_ID) return { ok: true };
  return {
    ok: false,
    reason:
      `quote_mint da curva é ${quoteMint}, não uma cotação em SOL (${WSOL_MINT} ou ${SYSTEM_PROGRAM_ID}). ` +
      `Esta instrução é SOL-only; moedas cotadas em outro ativo usam as instruções *_v2.`,
  };
}

/** Endereço base58 estruturalmente válido e diferente do zero. */
export function isUsableAddress(value: string): boolean {
  try {
    const pk = new PublicKey(value);
    return pk.toBase58() === value && value !== SYSTEM_PROGRAM_ID;
  } catch {
    return false;
  }
}
