/**
 * DRY-RUN DA INSTRUÇÃO NATIVA DO PUMP — valida o layout contra a mainnet SEM ASSINAR.
 *
 * ## O que faz
 *
 * Lê a conta `Global` e a `BondingCurve` de um mint REAL, valida os parsers contra dados reais,
 * calcula a cotação com a fórmula oficial, monta a instrução `buy_exact_sol_in` e a submete a
 * `simulateTransaction`. Imprime tudo o que um operador precisa para decidir se a rota nativa
 * pode ser ligada: contas que o programa aceitou, compute units consumidos, erro (se houver) e
 * as últimas linhas de log.
 *
 * ## Como funciona (e por que é seguro por construção)
 *
 * - **Não existe chave privada neste caminho.** O pagador é uma chave PÚBLICA recebida por
 *   parâmetro; a simulação roda com `sigVerify: false`, então nenhuma assinatura é necessária
 *   nem verificada. Não há `sendTransaction`, `sendRawTransaction` ou assinatura em lugar algum
 *   — há teste de regressão que varre este arquivo.
 * - **`replaceRecentBlockhash: true`**: o blockhash não é o objeto do teste. Um blockhash
 *   expirado faria a simulação falhar por expiração e mascarar o resultado que importa
 *   (o programa aceita as CONTAS e a INSTRUÇÃO?).
 * - **Recusa antes de simular** quando os dados não permitem: curva completa (já migrou),
 *   `quote_mint` não-SOL, taxas ilegíveis, conta truncada. Nesses casos não há o que medir.
 * - A simulação não move fundos: nada é assinado, nada é transmitido. O pior caso é uma
 *   mensagem de erro.
 *
 * ## Dependências
 *
 * `RPC_ENDPOINT` (env) ou `--rpc`. Um RPC público basta: são 2 leituras de conta + 1 simulação.
 *
 * ## Riscos
 *
 * 1. **Um dry-run bem-sucedido não garante execução real.** Ele prova que o programa ACEITA a
 *    instrução com aquelas contas; não prova que ela entra no bloco (isso depende de tip,
 *    prioridade e concorrência de outros bots).
 * 2. **A curva muda entre o dry-run e a execução.** O dry-run é um retrato do instante; em
 *    lançamento quente, reservas mudam a cada slot.
 * 3. **Conta `Global` do devnet é diferente.** Para validar em devnet, o IDL/programa precisam
 *    existir lá — o pump é mainnet; por isso o dry-run é contra mainnet e é somente leitura.
 *
 * ## Como testar
 *
 * `npm run pump:dryrun -- <mint> --payer <sua_chave_PUBLICA> [--sol 0.01] [--slippage-bps 300]`
 *
 * ## Como colocar em produção
 *
 * Rode antes de habilitar `HFT_ENTRY_ROUTE=native`. Verdict esperado: `err: null` e
 * `unitsConsumed` plausível (compra na curva consome ~120k–180k CU). Se der erro de conta,
 * NÃO ligue a rota: o layout mudou e o IDL pinado precisa ser atualizado.
 */

import { Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import {
  PUMP_PROGRAM_ID,
  WSOL_MINT,
  assertSolQuotedCurve,
  buildPumpBuyExactSolInInstruction,
  deriveBondingCurvePda,
  deriveGlobalPda,
  isUsableAddress,
  minTokensOutFromSlippage,
  parseBondingCurveAccount,
  parseGlobalAccount,
  quoteTokensOutExactSolIn,
} from "../src/pumpInstruction.js";

interface Args {
  mint: string;
  payer: string;
  sol: number;
  slippageBps: number;
  rpc: string;
}

function parseArgs(argv: string[]): Args {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flag = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const mint = positional[0] ?? "";
  return {
    mint,
    payer: flag("payer", ""),
    sol: Number(flag("sol", "0.01")),
    slippageBps: Number(flag("slippage-bps", "300")),
    rpc: flag("rpc", process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com"),
  };
}

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!isUsableAddress(args.mint)) fail("informe um mint válido como primeiro argumento");
  if (!isUsableAddress(args.payer)) {
    fail(
      "informe --payer <chave PUBLICA da carteira que pagaria>. É chave pública: este script não " +
        "aceita nem precisa de chave privada. A simulação usa sigVerify=false."
    );
  }
  if (!(args.sol > 0)) fail("--sol precisa ser > 0");
  const lamports = BigInt(Math.floor(args.sol * 1_000_000_000));

  console.log("=======================================================");
  console.log(" DRY-RUN — instrução nativa do pump (NENHUMA assinatura)");
  console.log("=======================================================");
  console.log(`mint          : ${args.mint}`);
  console.log(`pagador       : ${args.payer} (somente chave pública)`);
  console.log(`gasto         : ${args.sol} SOL (${lamports} lamports)`);
  console.log(`slippage      : ${args.slippageBps} bps`);
  console.log(`rpc           : ${args.rpc.replace(/\/[^/]*$/, "/…")}`);
  console.log(`programa      : ${PUMP_PROGRAM_ID}`);
  console.log("");

  const connection = new Connection(args.rpc, "confirmed");
  const globalPk = new PublicKey(deriveGlobalPda());
  const curvePk = new PublicKey(deriveBondingCurvePda(args.mint));

  console.log(`global PDA    : ${globalPk.toBase58()}`);
  console.log(`bonding curve : ${curvePk.toBase58()}`);
  console.log("→ lendo as duas contas...");

  const infos = await connection.getMultipleAccountsInfo([globalPk, curvePk]);
  const [globalInfo, curveInfo] = infos;
  if (!globalInfo) fail(`conta Global não existe em ${args.rpc} (RPC errado ou rede errada)`);
  if (!curveInfo) fail(`bonding curve não existe para este mint — o token pode já ter migrado para AMM`);

  console.log(`  Global: ${globalInfo.data.length} bytes, owner ${globalInfo.owner.toBase58()}`);
  console.log(`  Curve : ${curveInfo.data.length} bytes, owner ${curveInfo.owner.toBase58()}`);
  if (globalInfo.owner.toBase58() !== PUMP_PROGRAM_ID || curveInfo.owner.toBase58() !== PUMP_PROGRAM_ID) {
    fail(
      "as contas não pertencem ao programa do pump: os PDAs derivados não são os que a rede usa. " +
        "NÃO ligue a rota nativa — investigue o programa antes."
    );
  }

  const global = parseGlobalAccount(globalInfo.data);
  const curve = parseBondingCurveAccount(curveInfo.data);
  if (!global.value) fail(`Global não parseou: ${global.problems.map((p) => p.message).join(" | ")}`);
  if (!curve.value) fail(`BondingCurve não parseou: ${curve.problems.map((p) => p.message).join(" | ")}`);

  console.log("\n── Global (medido) ─────────────────────────────────────");
  console.log(`  fee_recipient       : ${global.value.feeRecipient}`);
  console.log(`  fee_basis_points    : ${global.value.feeBasisPoints} (${global.value.feeBasisPoints / 100}%)`);
  console.log(`  creator_fee_config  : ${global.value.creatorFeeConfigurable}`);
  console.log(`  mayhem_mode_enabled : ${global.value.mayhemModeEnabled}`);

  console.log("\n── BondingCurve (medido) ───────────────────────────────");
  console.log(`  virtual_token_reserves : ${curve.value.virtualTokenReserves}`);
  console.log(`  virtual_quote_reserves : ${curve.value.virtualQuoteReserves}`);
  console.log(`  real_token_reserves    : ${curve.value.realTokenReserves}`);
  console.log(`  complete               : ${curve.value.complete}`);
  console.log(`  creator                : ${curve.value.creator}`);
  console.log(`  creator_fee_bps        : ${curve.value.creatorFeeBps}`);
  console.log(`  quote_mint             : ${curve.value.quoteMint}`);

  if (curve.value.complete) {
    fail(
      "a curva está COMPLETA: comprar aqui é comprar na migração (o token vai para o AMM). " +
        "Nenhuma cotação de curva é válida neste estado."
    );
  }
  const quoteGuard = assertSolQuotedCurve(curve.value.quoteMint);
  if (!quoteGuard.ok) fail(quoteGuard.reason!);
  if (curve.value.quoteMint !== WSOL_MINT) {
    console.log(
      `\n  ℹ quote_mint observado = ${curve.value.quoteMint} (não wSOL). Aceito como cotação em SOL ` +
        `(endereço zero). Registre este valor: é a evidência que confirma a assunção da guarda.`
    );
  }

  const q = quoteTokensOutExactSolIn({
    spendableSolIn: lamports,
    virtualTokenReserves: curve.value.virtualTokenReserves,
    virtualQuoteReserves: curve.value.virtualQuoteReserves,
    protocolFeeBps: global.value.feeBasisPoints,
    creatorFeeBps: curve.value.creatorFeeBps,
  });
  if (!q) fail("a cotação não pôde ser calculada (reservas/taxas/valores): dado inválido para entrar");

  const minTokensOut = minTokensOutFromSlippage(q.tokensOut, args.slippageBps);
  const precoSpot = Number(curve.value.virtualQuoteReserves) / Number(curve.value.virtualTokenReserves);
  const precoExecucao = Number(q.netSol) / Number(q.tokensOut);
  console.log("\n── Cotação (fórmula oficial do IDL) ────────────────────");
  console.log(`  net_sol usado      : ${q.netSol} lamports`);
  console.log(`  taxa total         : ${q.totalFeeBps} bps`);
  console.log(`  tokens_out         : ${q.tokensOut}`);
  console.log(`  min_tokens_out     : ${minTokensOut} (piso com ${args.slippageBps} bps de slippage)`);
  console.log(`  preço spot (quote) : ${precoSpot.toExponential(6)} lamports/token`);
  console.log(`  preço de execução  : ${precoExecucao.toExponential(6)} lamports/token`);
  console.log(`  impacto calculado  : ${(((precoExecucao - precoSpot) / precoSpot) * 100).toFixed(3)}%`);

  const instruction = buildPumpBuyExactSolInInstruction({
    mint: args.mint,
    user: args.payer,
    feeRecipient: global.value.feeRecipient,
    creator: curve.value.creator,
    spendableSolIn: lamports,
    minTokensOut,
  });

  console.log("\n── Instrução montada (ordem do IDL) ────────────────────");
  instruction.keys.forEach((k, i) => {
    console.log(`  ${String(i).padStart(2)} ${k.name.padEnd(28)} ${k.pubkey}${k.isSigner ? " [signer]" : ""}${k.isWritable ? " [writable]" : ""}`);
  });
  console.log(`  data: ${instruction.data.toString("hex")} (${instruction.data.length} bytes)`);

  // Transação v0 com compute budget, igual à que a rota nativa montaria.
  const cuLimit = Number(process.env.HFT_ENTRY_CU_LIMIT ?? 200_000);
  const ix = new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: instruction.data,
  });
  const message = new TransactionMessage({
    payerKey: new PublicKey(args.payer),
    // Blockhash de espaço reservado: `replaceRecentBlockhash` o substitui na simulação. Não é
    // assinado nem transmitido — nada aqui depende da validade dele.
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }), ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);

  console.log("\n→ simulando (sigVerify=false, NENHUMA assinatura, NADA é transmitido)...");
  const sim = await connection.simulateTransaction(tx, {
    commitment: "processed",
    sigVerify: false,
    replaceRecentBlockhash: true,
  });

  const err = sim.value.err;
  console.log("\n── Resultado da simulação ──────────────────────────────");
  console.log(`  err            : ${err === null || err === undefined ? "null (instrução ACEITA pelo programa)" : JSON.stringify(err)}`);
  console.log(`  unitsConsumed  : ${sim.value.unitsConsumed ?? "n/d"}`);
  const logs = (sim.value.logs ?? []).slice(-8);
  if (logs.length) {
    console.log("  últimas linhas de log:");
    for (const l of logs) console.log(`    ${String(l).slice(0, 160)}`);
  }

  console.log("\n=======================================================");
  if (err === null || err === undefined) {
    console.log(" VERDICT: layout ACEITO. A rota nativa está validada contra a mainnet.");
    console.log(" Próximo passo: HFT_ENTRY_ROUTE=native, com o canário de 0,01 SOL.");
  } else {
    console.log(" VERDICT: layout REPROVADO pela rede. NÃO ligue a rota nativa.");
    console.log(" O IDL pinado pode estar desatualizado — confira o hash do arquivo oficial.");
  }
  console.log(" Nenhuma transação foi assinada ou enviada por este script.");
  console.log("=======================================================\n");
}

main().catch((err) => {
  const message = String(err?.message ?? err);
  /**
   * "fetch failed" é o sintoma de rede, e a causa muda o encaminhamento: RPC inalcançável
   * (firewall/egress) é problema de infraestrutura; RPC errado é configuração. Sem esta dica, o
   * operador perde tempo achando que o problema é o layout — que é justamente o que o script mede.
   */
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
    fail(
      `Falha no dry-run: ${message}. ` +
        `Isso é REDE, não layout: confirme que este host alcança o RPC (egress/firewall) e que ` +
        `--rpc/RPC_ENDPOINT apontam para o provedor correto. Nenhum veredito de layout foi emitido.`
    );
  }
  fail(`Falha no dry-run: ${message}`);
});
