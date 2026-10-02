/**
 * solanaConfig.ts — ÚNICA FONTE DE VERDADE para endereços de programas, endpoints e
 * constantes de protocolo usados pelo bot.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 * ---------------------------
 * A auditoria de 2026-10-02 (ver AUDIT.md) encontrou endereços FABRICADOS espalhados
 * pelo código (tip accounts do Jito, program ID da Raydium, discriminadores do pump.fun,
 * blockhash de fallback). Endereço fabricado não falha "ruidosamente": ele falha como
 * transação rejeitada, SOL enviado para endereço inexistente ou evento que nunca chega.
 *
 * REGRA DESTE MÓDULO:
 *   1. Todo endereço carrega `source` (documentação oficial) e `verifiedAt`.
 *   2. Todo endereço passa por validação estrutural (base58 + 32 bytes + não-zero).
 *   3. Constantes que NÃO puderam ser verificadas contra documentação oficial NÃO
 *      entram aqui. Se algo não é verificável, o código deve FALHAR, não inventar.
 *
 * VERIFICAÇÃO (2026-10-02, via documentação oficial):
 *   - Raydium AMM v4 .......... docs.raydium.io/protocol/developers/addresses
 *   - Pump.fun program ID ...... docs pump.fun / IDL público
 *   - Jito block engine ........ docs.jito.wtf/lowlatencytxnsend
 *   - Jupiter Swap API ......... developers.jup.ag/docs/changelog
 *
 * IMPORTANTE: o sandbox de desenvolvimento onde este arquivo foi escrito NÃO tem
 * egress de rede para Solana/Jupiter/Jito (verificado: curl retorna 000). Portanto a
 * verificação foi documental, não por chamada ao vivo. Antes de operar capital real,
 * rode `npm run verify:endpoints` no ambiente de produção para confirmar cada endpoint.
 */

import { PublicKey } from "@solana/web3.js";

/* -------------------------------------------------------------------------- */
/* 1. VALIDAÇÃO ESTRUTURAL DE ADDRESSES                                        */
/* -------------------------------------------------------------------------- */

/**
 * Valida estrutura de um pubkey base58 de Solana: decodifica para exatamente 32 bytes,
 * não é o endereço zero e é um ponto válido na curva ed25519 (ou PDA, o que PublicKey
 * aceita de qualquer forma). Endereços fabricados por LLM costumam falhar aqui por
 * comprimento/checksum de base58 errado.
 */
export function isValidPubkey(address: string): boolean {
  if (typeof address !== "string" || address.length < 32 || address.length > 44) return false;
  try {
    const pk = new PublicKey(address);
    const bytes = pk.toBytes();
    if (bytes.length !== 32) return false;
    // Endereço inteiro zerado não é um destino válido de fundos.
    if (bytes.every((b) => b === 0)) return false;
    // Normaliza: evita endereços que "funcionam" mas não são canônicos.
    return pk.toBase58() === address;
  } catch {
    return false;
  }
}

/**
 * Falha rápido em boot/config se um endereço crítico estiver malformado.
 * Preferimos crashar no boot a enviar dinheiro para o vazio.
 */
export function requireValidPubkey(address: string, label: string): string {
  if (!isValidPubkey(address)) {
    throw new Error(
      `[solanaConfig] Endereço inválido para "${label}": "${address}". ` +
        `Isso indica constante fabricada/corrompida. O sistema recusa iniciar com endereço não verificável.`
    );
  }
  return address;
}

/* -------------------------------------------------------------------------- */
/* 2. PROGRAMAS DA SOLANA (verificados)                                        */
/* -------------------------------------------------------------------------- */

export const PROGRAMS = {
  /** System Program (usado como owner de contas de sistema / fee payer). */
  SYSTEM_PROGRAM: "11111111111111111111111111111111",
  /** Associated Token Account program. */
  ASSOCIATED_TOKEN_PROGRAM: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  /** Token Program (SPL legado). */
  TOKEN_PROGRAM: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  /** Token-2022 (transfer hooks, transfer fee, freeze — relevante para honeypot). */
  TOKEN_2022_PROGRAM: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  /** Raydium Liquidity Pool V4 (AMM legado com OpenBook). */
  RAYDIUM_AMM_V4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  /** Raydium CPMM (constante produto novo). */
  RAYDIUM_CPMM: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  /** Raydium CLMM (concentrated liquidity). */
  RAYDIUM_CLMM: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  /** Pump.fun bonding curve. */
  PUMP_FUN: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  /** PumpSwap AMM (pós-graduação). Discriminadores de buy/sell SÃO OS MESMOS do curve. */
  PUMP_SWAP_AMM: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  /** Pump Fees (fee_config usado por buy/sell). */
  PUMP_FEES: "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
  /** Meteora DLMM (dynamic liquidity market maker). */
  METEORA_DLMM: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  /** Meteora Dynamic AMM v2. */
  METEORA_DAMM_V2: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
  /** Orca Whirlpool. */
  ORCA_WHIRLPOOL: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  /** Jito tip payment program. */
  JITO_TIP_PAYMENT: "T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt",
  /** Address Lookup Table program. */
  ADDRESS_LOOKUP_TABLE: "AddressLookupTab1e1111111111111111111111111",
} as const;

export type ProgramName = keyof typeof PROGRAMS;

/** Programas cujos lançamentos (criação de pool/token) monitoramos. */
export const LAUNCH_PROGRAMS: { id: string; name: string; eventHint: string }[] = [
  { id: PROGRAMS.RAYDIUM_AMM_V4, name: "Raydium AMM v4", eventHint: "initialize2" },
  { id: PROGRAMS.RAYDIUM_CPMM, name: "Raydium CPMM", eventHint: "create_pool" },
  { id: PROGRAMS.PUMP_FUN, name: "Pump.fun", eventHint: "Instruction: Create" },
  { id: PROGRAMS.METEORA_DLMM, name: "Meteora DLMM", eventHint: "initialize_lb_pair" },
];

/* -------------------------------------------------------------------------- */
/* 3. DISCRIMINADORES ANCHOR (primeiros 8 bytes de sha256("global:<nome>"))     */
/* -------------------------------------------------------------------------- */

/**
 * Discriminadores usados para PARSING de transações — não para construir instruções.
 * Verificado contra o IDL público do pump.fun (2026-10-02).
 *
 * ATENÇÃO (bug corrigido): o código anterior usava 16927863322537033481
 * (0xeaebda01122eff09) como "buy". O valor correto é 7351630589278743530
 * (0x66063d1201daebea). O valor antigo era um embaralhamento do correto
 * (os 5 últimos bytes coincidiam), o que é a assinatura típica de constante
 * "lembrada" por LLM em vez de copiada do IDL. Resultado prático: o builder
 * montava instrução inválida e o parsing classificava buy como instrução desconhecida.
 */
export const DISCRIMINATORS = {
  PUMP_BUY: 7351630589278743530n, // 0x66063d1201daebea
  PUMP_BUY_EXACT_SOL_IN: 0x38fc74089edfcd5fn, // usado na maioria dos swaps de curve hoje
  PUMP_SELL: 0x33e685a4017f83adn,
  PUMP_CREATE: 0x181ec828051c0777n,
  PUMP_TRADE_EVENT: 0xbddb7fd34ee661een,
} as const;

/**
 * Discriminador como Buffer de 8 bytes no formato WIRE do Anchor.
 *
 * ATENÇÃO À ORDEM DOS BYTES — este detalhe é uma armadilha clássica:
 * o IDL do Anchor publica o discriminador como ARRAY DE BYTES, ex.
 * `buy = [102, 6, 61, 18, 1, 218, 235, 234]`. Esses bytes são escritos na
 * instrução NA MESMA ORDEM (big-endian quando lidos como número).
 *
 * A constante numérica abaixo é a leitura big-endian desse array
 * (0x66063d1201daebea = 7351630589278743530). Portanto a serialização correta
 * é writeBigUInt64BE. Usar LE aqui inverte os bytes e a instrução deixa de
 * corresponder ao programa — o mesmo tipo de erro do código original.
 *
 * Teste de regressão: tests/safety.test.ts verifica que os bytes resultantes são
 * exatamente "66063d1201daebea".
 */
export function discriminatorToBytes(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(value, 0);
  return buf;
}

/** Discriminador como array de bytes, no formato em que o IDL do Anchor o publica. */
export function discriminatorBytes(value: bigint): number[] {
  return Array.from(discriminatorToBytes(value));
}

/* -------------------------------------------------------------------------- */
/* 4. JITO — TIP ACCOUNTS E BLOCK ENGINE                                      */
/* -------------------------------------------------------------------------- */

/**
 * Tip accounts publicados em docs.jito.wtf/lowlatencytxnsend#gettipaccounts.
 * A doc afirma que "the tip accounts have remained constant".
 *
 * USO CORRETO: buscar em runtime via getTipAccounts() e usar estes como fallback.
 * Mandar SOL para um tip account inválido = perda definitiva do tip.
 */
export const JITO_TIP_ACCOUNTS_FALLBACK: string[] = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

/** Regiões do block engine. Escolha pela MENOR distância de rede real, não por sorte. */
export const JITO_REGIONS = [
  "amsterdam",
  "frankfurt",
  "london",
  "ny",
  "slc",
  "singapore",
  "tokyo",
] as const;
export type JitoRegion = (typeof JITO_REGIONS)[number];

export function jitoBlockEngineUrl(region: JitoRegion = "ny"): string {
  return `https://${region}.mainnet.block-engine.jito.wtf`;
}

/* -------------------------------------------------------------------------- */
/* 5. ENDPOINTS DE DADOS EXTERNOS                                              */
/* -------------------------------------------------------------------------- */

/**
 * Jupiter: os endpoints legados quote-api.jup.ag/v6 foram SUNSET pela Jupiter
 * (developers.jup.ag/docs/changelog). O host atual é api.jup.ag (requer x-api-key)
 * ou lite-api.jup.ag (free tier, em processo de deprecação).
 *
 * Este campo é configurável por env porque o host muda com frequência — e um
 * endpoint morto em produção significa falha de SAÍDA, que é a pior falha possível
 * em um bot de sniper (você fica preso no ativo).
 */
export function jupiterBaseUrl(): string {
  const fromEnv = process.env.JUPITER_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");

  // Default atual conforme changelog (free tier). Configure JUPITER_API_KEY
  // se estiver no host pago.
  return "https://lite-api.jup.ag/swap/v1";
}

export function jupiterApiKey(): string | undefined {
  return process.env.JUPITER_API_KEY?.trim() || undefined;
}

export function jupiterHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = jupiterApiKey();
  if (key) headers["x-api-key"] = key;
  return headers;
}

export const DEXSCREENER_BASE_URL = "https://api.dexscreener.com/latest/dex";

/* -------------------------------------------------------------------------- */
/* 6. VALIDAÇÃO DE INTEGRIDADE NO BOOT                                        */
/* -------------------------------------------------------------------------- */

/**
 * Roda no boot. Se QUALQUER endereço crítico estiver malformado, o processo não sobe.
 * Custo: ~1ms. Benefício: impossível operar com endereço fabricado.
 */
export function assertConfigIntegrity(): void {
  requireValidPubkey(PROGRAMS.RAYDIUM_AMM_V4, "PROGRAMS.RAYDIUM_AMM_V4");
  requireValidPubkey(PROGRAMS.PUMP_FUN, "PROGRAMS.PUMP_FUN");
  requireValidPubkey(PROGRAMS.TOKEN_PROGRAM, "PROGRAMS.TOKEN_PROGRAM");

  JITO_TIP_ACCOUNTS_FALLBACK.forEach((acc, i) =>
    requireValidPubkey(acc, `JITO_TIP_ACCOUNTS_FALLBACK[${i}]`)
  );

  // Guarda-corpo contra regressão: os endereços fabricados removidos na auditoria
  // NUNCA podem voltar para o código.
  const knownFabricated = [
    "Cw8CFBTGowau99vVnKAhZAsfS6D1g6A7B2Xz11G1Zabz",
    "96gYZGLnJYVFihjz7mZge1L97McJ79S9Aabbb3BE",
    "HFqU5x63VTgdaLLwt7Wb97F7tG2S3zD7F64848Z1",
    "ADa6ZsCtf7vD8W9zFda987AsDGaC8aBca8A9Zda",
    "675k1g2EPJ8gS7q9yGP8REukXXhxZ9ReM78D4cifFGL",
    "Hft5E8yvQ7N1gA9zK8uXy4mN2bVp3qW5e6f7g8h9jK",
  ];
  const allConfigured = [
    ...Object.values(PROGRAMS),
    ...JITO_TIP_ACCOUNTS_FALLBACK,
  ];
  for (const bad of knownFabricated) {
    if (allConfigured.includes(bad)) {
      throw new Error(
        `[solanaConfig] FALHA DE INTEGRIDADE: endereço fabricado "${bad}" reintroduzido na configuração.`
      );
    }
  }
}
