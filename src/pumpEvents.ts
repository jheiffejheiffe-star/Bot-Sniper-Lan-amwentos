/**
 * EVENTOS DO PUMP — decodificação pura dos `Program data:` de uma transação.
 *
 * ## O que faz
 *
 * Decodifica os eventos do programa pump que aparecem nos logs de uma transação:
 * `CreateEvent` (o lançamento), `TradeEvent` (compra/venda), `CompleteEvent` e
 * `CompletePumpAmmMigrationEvent` (migração para o AMM). Também varre uma lista de linhas de log
 * e devolve os eventos que encontrar, tipados.
 *
 * ## Como funciona
 *
 * - Os **layouts são DADO**, transcritos do IDL oficial (`assets/pump-idl-excerpt.json`) e
 *   conferidos campo a campo pelo teste [25].
 * - O esquema de discriminador do Anchor é público e conferível sem rede:
 *   `sha256("event:CreateEvent")[0..8]`. O teste [25] **recalcula todos** — um discriminador
 *   transcrito errado falha o teste em vez de virar evento silenciosamente errado.
 * - Formato de log: `Program data: <base58(8 bytes de discriminador + corpo borsh)>`.
 * - **Nunca inventa**: campo que não couber no corpo → `bytes-insuficientes`, sem valor parcial.
 *
 * ## Por que decodificar o evento em vez de ler `postTokenBalances`
 *
 * `postTokenBalances` diz "esta conta de token mudou" — e numa COMPRA a ATA do comprador também
 * muda. O `CreateEvent` diz "este mint foi CRIADO nesta transação", que é a pergunta do sniper.
 * Usar saldos como proxy de lançamento produziria compras de tokens já existentes (ruído) e,
 * pior, mints errados.
 *
 * ## Dependências
 *
 * `bs58` (já no projeto) e nada mais. Sem rede, sem chave, sem `Connection`.
 *
 * ## Riscos
 *
 * 1. O layout pode mudar (o programa é atualizável e já mudou em 2025). O anti-drift do boot cobre
 *    as CONTAS; para eventos, a proteção é o teste [25] contra o IDL pinado + a contagem de
 *    falhas de decodificação exposta no health (`decodeFailures`), que torna a mudança visível.
 * 2. `is_mayhem_mode` / `is_cashback_enabled` vêm do evento: são MODOS lançados pelo próprio
 *    pump, e um sniper precisa saber que existem (ver `warning` em `CreateEventDecoded`).
 *
 * ## Como testar
 *
 * Grupo [25] de `npm run test`: layouts × IDL campo a campo, discriminadores por recálculo de
 * sha256, eventos sintéticos montados a partir do IDL e corpos truncados.
 *
 * ## Como colocar em produção
 *
 * Não há configuração: é biblioteca pura usada pela ingestão (`src/grpcIngest.ts`) e pelo scanner
 * de logs do caminho WSS.
 */

import bs58 from "bs58";

/* -------------------------------------------------------------------------- */
/* 1. DISCRIMINADORES E LAYOUTS (DADO, do IDL oficial)                         */
/* -------------------------------------------------------------------------- */

export const PUMP_EVENT_DISCRIMINATORS = Object.freeze({
  CreateEvent: Uint8Array.from([27, 114, 169, 77, 222, 235, 99, 118]),
  TradeEvent: Uint8Array.from([189, 219, 127, 211, 78, 230, 97, 238]),
  CompleteEvent: Uint8Array.from([95, 114, 97, 156, 212, 46, 152, 8]),
  CompletePumpAmmMigrationEvent: Uint8Array.from([189, 233, 93, 185, 92, 148, 234, 148]),
});

export type PumpEventName = keyof typeof PUMP_EVENT_DISCRIMINATORS;

/** Campos de um evento, na ORDEM do IDL. `defined` referencia outro layout registrado. */
export interface EventField {
  name: string;
  type: "u8" | "u16" | "u32" | "u64" | "i64" | "bool" | "pubkey" | "string" | { vec: { defined: { name: string } } };
}

export const CREATE_EVENT_LAYOUT: readonly EventField[] = Object.freeze([
  { name: "name", type: "string" },
  { name: "symbol", type: "string" },
  { name: "uri", type: "string" },
  { name: "mint", type: "pubkey" },
  { name: "bonding_curve", type: "pubkey" },
  { name: "user", type: "pubkey" },
  { name: "creator", type: "pubkey" },
  { name: "timestamp", type: "i64" },
  { name: "virtual_token_reserves", type: "u64" },
  { name: "virtual_sol_reserves", type: "u64" },
  { name: "real_token_reserves", type: "u64" },
  { name: "token_total_supply", type: "u64" },
  { name: "token_program", type: "pubkey" },
  { name: "is_mayhem_mode", type: "bool" },
  { name: "is_cashback_enabled", type: "bool" },
  { name: "quote_mint", type: "pubkey" },
  { name: "virtual_quote_reserves", type: "u64" },
  { name: "creator_fee_bps", type: "u64" },
  { name: "is_holder_reward", type: "bool" },
]);

export const TRADE_EVENT_LAYOUT: readonly EventField[] = Object.freeze([
  { name: "mint", type: "pubkey" },
  { name: "sol_amount", type: "u64" },
  { name: "token_amount", type: "u64" },
  { name: "is_buy", type: "bool" },
  { name: "user", type: "pubkey" },
  { name: "timestamp", type: "i64" },
  { name: "virtual_sol_reserves", type: "u64" },
  { name: "virtual_token_reserves", type: "u64" },
  { name: "real_sol_reserves", type: "u64" },
  { name: "real_token_reserves", type: "u64" },
  { name: "fee_recipient", type: "pubkey" },
  { name: "fee_basis_points", type: "u64" },
  { name: "fee", type: "u64" },
  { name: "creator", type: "pubkey" },
  { name: "creator_fee_basis_points", type: "u64" },
  { name: "creator_fee", type: "u64" },
  { name: "track_volume", type: "bool" },
  { name: "total_unclaimed_tokens", type: "u64" },
  { name: "total_claimed_tokens", type: "u64" },
  { name: "current_sol_volume", type: "u64" },
  { name: "last_update_timestamp", type: "i64" },
  { name: "ix_name", type: "string" },
  { name: "mayhem_mode", type: "bool" },
  { name: "cashback_fee_basis_points", type: "u64" },
  { name: "cashback", type: "u64" },
  { name: "buyback_fee_basis_points", type: "u64" },
  { name: "buyback_fee", type: "u64" },
  { name: "shareholders", type: { vec: { defined: { name: "Shareholder" } } } },
  { name: "quote_mint", type: "pubkey" },
  { name: "quote_amount", type: "u64" },
  { name: "virtual_quote_reserves", type: "u64" },
  { name: "real_quote_reserves", type: "u64" },
  { name: "holder_rewards_bps", type: "u64" },
  { name: "holder_rewards", type: "u64" },
]);

export const COMPLETE_EVENT_LAYOUT: readonly EventField[] = Object.freeze([
  { name: "user", type: "pubkey" },
  { name: "mint", type: "pubkey" },
  { name: "bonding_curve", type: "pubkey" },
  { name: "timestamp", type: "i64" },
  { name: "quote_mint", type: "pubkey" },
]);

export const MIGRATION_EVENT_LAYOUT: readonly EventField[] = Object.freeze([
  { name: "user", type: "pubkey" },
  { name: "mint", type: "pubkey" },
  { name: "mint_amount", type: "u64" },
  { name: "sol_amount", type: "u64" },
  { name: "pool_migration_fee", type: "u64" },
  { name: "bonding_curve", type: "pubkey" },
  { name: "timestamp", type: "i64" },
  { name: "pool", type: "pubkey" },
  { name: "quote_mint", type: "pubkey" },
]);

/** Structs auxiliares referenciados por eventos (`defined`). */
const DEFINED_LAYOUTS: Record<string, readonly EventField[]> = {
  Shareholder: [
    { name: "address", type: "pubkey" },
    { name: "share_bps", type: "u16" },
  ],
};

const LAYOUTS: Record<PumpEventName, readonly EventField[]> = {
  CreateEvent: CREATE_EVENT_LAYOUT,
  TradeEvent: TRADE_EVENT_LAYOUT,
  CompleteEvent: COMPLETE_EVENT_LAYOUT,
  CompletePumpAmmMigrationEvent: MIGRATION_EVENT_LAYOUT,
};

/* -------------------------------------------------------------------------- */
/* 2. DECODIFICAÇÃO                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Valor decodificado. É `unknown` de propósito: quem LÊ um campo precisa estreitar o tipo
 * (`asString`, `asBig`, `asBool`), e um campo ausente/inesperado vira valor padrão explícito em
 * vez de um `any` que se propaga silenciosamente pelo sistema.
 */
export type DecodedValue = unknown;

export interface EventDecodeProblem {
  code: "curta-demais" | "discriminador-errado" | "bytes-insuficientes" | "utf8-invalido" | "tipo-desconhecido";
  message: string;
}

export interface EventDecodeResult<T> {
  value: T | null;
  problems: EventDecodeProblem[];
}

/** Estado do cursor: um decodificador que avança posição e RECUSA em vez de adivinhar. */
class Reader {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  private need(bytes: number, what: string): void {
    if (this.pos + bytes > this.buf.length) {
      throw new ReaderError("bytes-insuficientes", `faltam bytes para ${what} na posição ${this.pos}`);
    }
  }

  u8(what = "u8"): number {
    this.need(1, what);
    return this.buf[this.pos++];
  }
  u16(what = "u16"): number {
    this.need(2, what);
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 2).getUint16(0, true);
    this.pos += 2;
    return v;
  }
  u32(what = "u32"): number {
    this.need(4, what);
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getUint32(0, true);
    this.pos += 4;
    return v;
  }
  u64(what = "u64"): bigint {
    this.need(8, what);
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getBigUint64(0, true);
    this.pos += 8;
    return v;
  }
  i64(what = "i64"): bigint {
    this.need(8, what);
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getBigInt64(0, true);
    this.pos += 8;
    return v;
  }
  bool(what = "bool"): boolean {
    const b = this.u8(what);
    // Borsh só admite 0 ou 1; qualquer outro byte é dado corrompido, não "true".
    if (b !== 0 && b !== 1) throw new ReaderError("utf8-invalido", `${what}: byte booleano ${b} não é 0 nem 1`);
    return b === 1;
  }
  pubkey(what = "pubkey"): string {
    this.need(32, what);
    const key = bs58.encode(this.buf.subarray(this.pos, this.pos + 32));
    this.pos += 32;
    return key;
  }
  string(what = "string"): string {
    const len = this.u32(`${what} (tamanho)`);
    this.need(len, what);
    const bytes = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    let out: string;
    try {
      out = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ReaderError("utf8-invalido", `${what}: bytes não são UTF-8 válido`);
    }
    return out;
  }
  remaining(): number {
    return this.buf.length - this.pos;
  }
}

class ReaderError extends Error {
  constructor(public readonly code: EventDecodeProblem["code"], message: string) {
    super(message);
  }
}

function readFields(reader: Reader, fields: readonly EventField[]): Record<string, DecodedValue> {
  const out: Record<string, DecodedValue> = {};
  for (const field of fields) {
    out[field.name] = readField(reader, field);
  }
  return out;
}

function readField(reader: Reader, field: EventField): DecodedValue {
  const t = field.type;
  if (t === "u8") return reader.u8(field.name);
  if (t === "u16") return reader.u16(field.name);
  if (t === "u32") return reader.u32(field.name);
  if (t === "u64") return reader.u64(field.name);
  if (t === "i64") return reader.i64(field.name);
  if (t === "bool") return reader.bool(field.name);
  if (t === "pubkey") return reader.pubkey(field.name);
  if (t === "string") return reader.string(field.name);
  if (typeof t === "object" && "vec" in t) {
    const inner = t.vec.defined.name;
    const layout = DEFINED_LAYOUTS[inner];
    if (!layout) throw new ReaderError("tipo-desconhecido", `vec<${inner}> não está registrado`);
    const count = reader.u32(`${field.name} (quantidade)`);
    const items: Array<Record<string, DecodedValue>> = [];
    for (let i = 0; i < count; i++) items.push(readFields(reader, layout));
    return items;
  }
  throw new ReaderError("tipo-desconhecido", `tipo de campo não suportado: ${JSON.stringify(t)}`);
}

/**
 * Decodifica o CORPO de um evento (sem o discriminador), dado o layout.
 * Exportado para o teste poder montar dados sintéticos a partir do IDL e conferir o resultado.
 */
export function decodeEventBody<T = Record<string, DecodedValue>>(
  layout: readonly EventField[],
  body: Uint8Array
): EventDecodeResult<T> {
  const reader = new Reader(body);
  try {
    const value = readFields(reader, layout) as T;
    /**
     * Corpo MAIOR que o layout não é erro por si: eventos costumam ganhar campos no fim, e ler os
     * que conhecemos continua correto. O que não pode passar é corpo MENOR (aí os campos lidos
     * estariam deslocados). A sobra é reportada como aviso no valor decodificado.
     */
    return { value, problems: [] };
  } catch (err: any) {
    return {
      value: null,
      problems: [{ code: err?.code ?? "tipo-desconhecido", message: err?.message ?? String(err) }],
    };
  }
}

export interface EventDecode<T> extends EventDecodeResult<T> {
  name: PumpEventName;
  /** Bytes do corpo além do layout conhecido. > 0 = o programa adicionou campos. */
  trailingBytes: number;
}

/**
 * Decodifica um `Program data:` completo (discriminador + corpo) contra os eventos conhecidos.
 * Devolve `null` quando o discriminador não é de nenhum evento do pump — o que é o caso COMUM
 * (qualquer outro programa loga `Program data:` também).
 */
export function decodePumpEventData(data: Uint8Array): EventDecode<DecodedValue> | null {
  if (data.length < 8) return null;
  for (const name of Object.keys(PUMP_EVENT_DISCRIMINATORS) as PumpEventName[]) {
    const disc = PUMP_EVENT_DISCRIMINATORS[name];
    let match = true;
    for (let i = 0; i < 8; i++) {
      if (data[i] !== disc[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;

    const body = data.subarray(8);
    const layout = LAYOUTS[name];
    const reader = new Reader(body);
    try {
      const value = readFields(reader, layout);
      return { name, value, problems: [], trailingBytes: reader.remaining() };
    } catch (err: any) {
      return {
        name,
        value: null,
        problems: [{ code: err?.code ?? "tipo-desconhecido", message: err?.message ?? String(err) }],
        trailingBytes: 0,
      };
    }
  }
  return null;
}

/**
 * Varre linhas de log (`Program data: <base58>`) e devolve os eventos do pump decodificados.
 *
 * Linhas que não são `Program data:` são ignoradas — a imensa maioria. Bytes que não decodificam
 * em base58 entram em `problems` (log truncado é informação, não ruído a esconder).
 */
export function scanPumpEvents(logs: readonly string[]): {
  events: Array<EventDecode<DecodedValue>>;
  problems: EventDecodeProblem[];
} {
  const events: Array<EventDecode<DecodedValue>> = [];
  const problems: EventDecodeProblem[] = [];
  for (const line of logs) {
    const marker = "Program data: ";
    const at = line.indexOf(marker);
    if (at < 0) continue;
    const payload = line.slice(at + marker.length).trim();
    if (!payload) continue;
    let data: Uint8Array;
    try {
      data = bs58.decode(payload);
    } catch {
      problems.push({ code: "curta-demais", message: `linha de log com base58 inválido: ${payload.slice(0, 24)}…` });
      continue;
    }
    const decoded = decodePumpEventData(data);
    if (decoded) events.push(decoded);
  }
  return { events, problems };
}

/* -------------------------------------------------------------------------- */
/* 3. LEITORES TIPADOS (o que o resto do sistema consome)                      */
/* -------------------------------------------------------------------------- */

export interface CreateEventDecoded {
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  user: string;
  creator: string;
  timestamp: bigint;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  tokenTotalSupply: bigint;
  tokenProgram: string;
  /** Modo "mayhem" do próprio pump: mecânica diferente, não é o lançamento padrão. */
  isMayhemMode: boolean;
  isCashbackEnabled: boolean;
  quoteMint: string;
  virtualQuoteReserves: bigint;
  creatorFeeBps: bigint;
  isHolderReward: boolean;
  /** Avisos MEDIDOS sobre o lançamento — nunca inventados, nunca "achismo". */
  warnings: string[];
}

export interface TradeEventDecoded {
  mint: string;
  solAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: string;
  timestamp: bigint;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  feeRecipient: string;
  feeBasisPoints: bigint;
  fee: bigint;
  creator: string;
  creatorFeeBasisPoints: bigint;
  creatorFee: bigint;
  trackVolume: boolean;
  ixName: string;
  mayhemMode: boolean;
  quoteMint: string;
  quoteAmount: bigint;
  virtualQuoteReserves: bigint;
  realQuoteReserves: bigint;
  holdersRewardsBps: bigint;
  holdersRewards: bigint;
}

function asString(v: DecodedValue | undefined): string {
  return typeof v === "string" ? v : "";
}
/**
 * BigInt do campo. Números pequenos podem chegar como `number` (o leitor do web3.js devolve
 * number para u8/u16): a conversão é explícita, e ausência de campo vira 0n — que é o valor
 * IDENTIDADE para reserva/quantia e é visível em qualquer verificação (0n de reserva nunca
 * passa numa cotação).
 */
function asBig(v: DecodedValue | undefined): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  return 0n;
}
function asBool(v: DecodedValue | undefined): boolean {
  return v === true;
}

/** Zero (= endereço de sistema) significa "cotação em SOL" nas versões antigas do programa. */
const SOL_QUOTE_SENTINEL = "11111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";

/**
 * Converte um `CreateEvent` decodificado no formato de domínio, com os avisos que o operador
 * precisa ver. Nada aqui é opinião de mercado: é o que o evento (ou a ausência de campo) diz.
 */
export function toCreateEvent(event: EventDecode<DecodedValue>): CreateEventDecoded | null {
  if (event.name !== "CreateEvent") return null;
  if (!event.value || typeof event.value !== "object" || Array.isArray(event.value)) return null;
  const v = event.value as Record<string, DecodedValue>;
  const warnings: string[] = [];
  const quoteMint = asString(v.quote_mint);
  if (quoteMint !== SOL_QUOTE_SENTINEL && quoteMint !== WSOL) {
    warnings.push(
      `cotação NÃO é SOL (quote_mint=${quoteMint}): a instrução SOL-only do S6b recusa esta curva`
    );
  }
  if (asBool(v.is_mayhem_mode)) {
    warnings.push("lançamento em modo MAYHEM: mecânica de preço diferente do padrão");
  }
  if (asBool(v.is_cashback_enabled)) {
    warnings.push("lançamento com CASHBACK habilitado");
  }
  if (asBool(v.is_holder_reward)) {
    warnings.push("lançamento com HOLDER REWARDS habilitado");
  }
  if (event.trailingBytes > 0) {
    warnings.push(
      `corpo do evento com ${event.trailingBytes} byte(s) além do layout pinado: o programa pode ter ` +
        `adicionado campos (os campos lidos continuam corretos, os novos não são conhecidos)`
    );
  }
  return {
    name: asString(v.name),
    symbol: asString(v.symbol),
    uri: asString(v.uri),
    mint: asString(v.mint),
    bondingCurve: asString(v.bonding_curve),
    user: asString(v.user),
    creator: asString(v.creator),
    timestamp: asBig(v.timestamp),
    virtualTokenReserves: asBig(v.virtual_token_reserves),
    virtualSolReserves: asBig(v.virtual_sol_reserves),
    realTokenReserves: asBig(v.real_token_reserves),
    tokenTotalSupply: asBig(v.token_total_supply),
    tokenProgram: asString(v.token_program),
    isMayhemMode: asBool(v.is_mayhem_mode),
    isCashbackEnabled: asBool(v.is_cashback_enabled),
    quoteMint,
    virtualQuoteReserves: asBig(v.virtual_quote_reserves),
    creatorFeeBps: asBig(v.creator_fee_bps),
    isHolderReward: asBool(v.is_holder_reward),
    warnings,
  };
}

export function toTradeEvent(event: EventDecode<DecodedValue>): TradeEventDecoded | null {
  if (event.name !== "TradeEvent") return null;
  if (!event.value || typeof event.value !== "object" || Array.isArray(event.value)) return null;
  const v = event.value as Record<string, DecodedValue>;
  return {
    mint: asString(v.mint),
    solAmount: asBig(v.sol_amount),
    tokenAmount: asBig(v.token_amount),
    isBuy: asBool(v.is_buy),
    user: asString(v.user),
    timestamp: asBig(v.timestamp),
    virtualSolReserves: asBig(v.virtual_sol_reserves),
    virtualTokenReserves: asBig(v.virtual_token_reserves),
    realSolReserves: asBig(v.real_sol_reserves),
    realTokenReserves: asBig(v.real_token_reserves),
    feeRecipient: asString(v.fee_recipient),
    feeBasisPoints: asBig(v.fee_basis_points),
    fee: asBig(v.fee),
    creator: asString(v.creator),
    creatorFeeBasisPoints: asBig(v.creator_fee_basis_points),
    creatorFee: asBig(v.creator_fee),
    trackVolume: asBool(v.track_volume),
    ixName: asString(v.ix_name),
    mayhemMode: asBool(v.mayhem_mode),
    quoteMint: asString(v.quote_mint),
    quoteAmount: asBig(v.quote_amount),
    virtualQuoteReserves: asBig(v.virtual_quote_reserves),
    realQuoteReserves: asBig(v.real_quote_reserves),
    holdersRewardsBps: asBig(v.holder_rewards_bps),
    holdersRewards: asBig(v.holder_rewards),
  };
}

/**
 * Atalho para o caminho quente: encontra o PRIMEIRO `CreateEvent` de uma transação.
 * Devolve `null` quando a transação não criou token (caso comum: compras e vendas).
 */
export function findCreateEvent(logs: readonly string[]): CreateEventDecoded | null {
  const { events } = scanPumpEvents(logs);
  for (const ev of events) {
    if (ev.name !== "CreateEvent") continue;
    const decoded = toCreateEvent(ev);
    if (decoded) return decoded;
  }
  return null;
}

/** Detecta migração/complete (usado para não comprar curva de token já migrado). */
export function findCurveTerminalEvent(logs: readonly string[]): "complete" | "migrated" | null {
  const { events } = scanPumpEvents(logs);
  for (const ev of events) {
    if (ev.name === "CompletePumpAmmMigrationEvent") return "migrated";
    if (ev.name === "CompleteEvent") return "complete";
  }
  return null;
}

/** Último `TradeEvent` da lista de logs, se houver (preço de execução real de terceiros). */
export function findLastTradeEvent(logs: readonly string[]): TradeEventDecoded | null {
  const { events } = scanPumpEvents(logs);
  let last: TradeEventDecoded | null = null;
  for (const ev of events) {
    if (ev.name !== "TradeEvent") continue;
    const decoded = toTradeEvent(ev);
    if (decoded) last = decoded;
  }
  return last;
}
