/**
 * verify:endpoints — verificação de endpoints NO AMBIENTE DO OPERADOR.
 *
 * Por que este script existe: a auditoria de 2026-10-02 encontrou endpoints mortos e
 * fabricados no código (Jupiter v6 sunset, program IDs inexistentes, tip accounts
 * inventados) que NÃO falhavam de forma visível — o sistema reportava sucesso enquanto
 * nada acontecia on-chain. A verificação documental que fizemos aqui não substitui a
 * verificação no SEU ambiente de rede.
 *
 * Rode isto ANTES de ligar LIVE_TRADING_ENABLED=true, e periodicamente depois
 * (endpoints mudam: a própria Jupiter anuncia deprecação de host no changelog deles).
 *
 * Uso:  npm run verify:endpoints
 */

import {
  JITO_TIP_ACCOUNTS_FALLBACK,
  PROGRAMS,
  isValidPubkey,
  jitoBlockEngineUrl,
  jupiterBaseUrl,
  jupiterHeaders,
} from "../src/solanaConfig.js";
import { Connection, PublicKey } from "@solana/web3.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}\n       ${detail}`);
}

async function checkRpc(): Promise<void> {
  const url = process.env.RPC_ENDPOINT;
  if (!url) {
    record("RPC_ENDPOINT configurado", false, "RPC_ENDPOINT ausente. O default público não serve para trading.");
    return;
  }
  if (/api\.mainnet-beta\.solana\.com/.test(url)) {
    record(
      "RPC de trading não é o endpoint público",
      false,
      "Você está no api.mainnet-beta.solana.com: rate-limited e sem garantia de envio. " +
        "Use um RPC dedicado para operar."
    );
  } else {
    record("RPC de trading é customizado", true, url.replace(/api-key=[^&]+/, "api-key=***"));
  }

  try {
    const conn = new Connection(url, { commitment: "processed" });
    const started = Date.now();
    const bh = await conn.getLatestBlockhash("processed");
    const rtt = Date.now() - started;
    record(`RPC responde (getLatestBlockhash)`, true, `RTT ${rtt}ms, blockhash ${bh.blockhash.slice(0, 12)}...`);
    const slot = await conn.getSlot("processed");
    record("RPC reporta slot", slot > 0, `slot ${slot}`);
  } catch (err: any) {
    record("RPC responde", false, err.message);
  }
}

async function checkJito(): Promise<void> {
  const region = process.env.JITO_REGION || "ny";
  const url = `${jitoBlockEngineUrl(region as any)}/api/v1/getTipAccounts`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      record("Jito getTipAccounts", false, `HTTP ${res.status} em ${url}`);
      return;
    }
    const json: any = await res.json();
    const accounts: string[] = Array.isArray(json.result) ? json.result : [];
    const allValid = accounts.length > 0 && accounts.every(isValidPubkey);
    record(
      "Jito getTipAccounts",
      allValid,
      `${accounts.length} contas retornadas; todas válidas: ${allValid}`
    );

    // Compara com a lista publicada: se divergirem, o Jito mudou as contas e nosso
    // fallback está desatualizado (o que enviaria SOL para endereço errado).
    const drift = accounts.filter((a) => !JITO_TIP_ACCOUNTS_FALLBACK.includes(a));
    record(
      "Tip accounts sem divergência vs. lista publicada",
      drift.length === 0,
      drift.length === 0
        ? "conjunto idêntico ao documentado em docs.jito.wtf"
        : `DIVERGÊNCIA: ${drift.join(", ")} — atualize JITO_TIP_ACCOUNTS_FALLBACK`
    );
  } catch (err: any) {
    record("Jito getTipAccounts", false, `falhou: ${err.message}`);
  }
}

async function checkJupiter(): Promise<void> {
  const base = jupiterBaseUrl();
  const sol = "So11111111111111111111111111111111111111112";
  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const url = `${base}/quote?inputMint=${sol}&outputMint=${usdc}&amount=10000000&slippageBps=50`;

  try {
    const res = await fetch(url, { headers: jupiterHeaders(), signal: AbortSignal.timeout(8000) });
    const contentType = res.headers.get("content-type") || "";
    if (!res.ok) {
      record(
        "Jupiter quote",
        false,
        `HTTP ${res.status} em ${base}. Se for 401/403 e você estiver em api.jup.ag, defina JUPITER_API_KEY. ` +
          `Se for 530/HTML, o host foi descontinuado.`
      );
      return;
    }
    if (!contentType.includes("json")) {
      record("Jupiter quote", false, `content-type "${contentType}" (esperado JSON) — host provavelmente descontinuado`);
      return;
    }
    const json: any = await res.json();
    record("Jupiter quote", Boolean(json.outAmount), `outAmount=${json.outAmount} via ${base}`);
    record(
      "Jupiter base URL é o host atual (não o legado v6)",
      !/quote-api\.jup\.ag/.test(base),
      /quote-api\.jup\.ag/.test(base)
        ? "JUPITER_BASE_URL aponta para quote-api.jup.ag/v6, que a Jupiter DESCONTINUOU."
        : base
    );
  } catch (err: any) {
    record("Jupiter quote", false, err.message);
  }
}

async function checkProgramsExist(): Promise<void> {
  const url = process.env.RPC_ENDPOINT;
  if (!url) {
    /**
     * SILÊNCIO NÃO É RESULTADO. A versão anterior não imprimia nada aqui quando
     * RPC_ENDPOINT estava ausente — e uma seção vazia se lê como "nada a reportar",
     * quando na verdade significa "não verifiquei". Os program IDs são exatamente o que
     * já foi fabricado uma vez neste projeto: precisam de verificação explícita.
     */
    record(
      "Programas on-chain",
      false,
      "NÃO VERIFICADO: sem RPC_ENDPOINT não há como confirmar que os program ids existem " +
        `e são executáveis (${Object.keys(PROGRAMS).length - 1} endereços não checados)`
    );
    return;
  }
  try {
    const conn = new Connection(url, { commitment: "confirmed" });
    for (const [name, id] of Object.entries(PROGRAMS)) {
      if (name === "SYSTEM_PROGRAM") continue;
      const info = await conn.getAccountInfo(new PublicKey(id));
      record(
        `Programa on-chain: ${name}`,
        info !== null && info.executable,
        info === null ? "NÃO EXISTE on-chain — endereço errado/fabricado" : `executable=${info.executable}`
      );
    }
  } catch (err: any) {
    record("Verificação de programas on-chain", false, err.message);
  }
}

async function main(): Promise<void> {
  console.log("=========================================================");
  console.log(" VERIFICAÇÃO DE ENDPOINTS — rode no SEU ambiente de rede");
  console.log("=========================================================\n");

  console.log("[RPC]");
  await checkRpc();
  console.log("\n[Programas on-chain]");
  await checkProgramsExist();
  console.log("\n[Jito]");
  await checkJito();
  console.log("\n[Jupiter]");
  await checkJupiter();

  const failed = results.filter((r) => !r.ok);
  console.log("\n=========================================================");
  if (failed.length === 0) {
    console.log(`🏆 ${results.length} verificações OK`);
  } else {
    console.log(`⚠️  ${failed.length} de ${results.length} verificações FALHARAM:`);
    for (const f of failed) console.log(`   - ${f.name}: ${f.detail}`);
    console.log("\nNÃO habilite LIVE_TRADING_ENABLED=true com falhas acima.");
    process.exitCode = 1;
  }
  console.log("=========================================================");
}

main().catch((err) => {
  console.error("Falha fatal:", err);
  process.exit(1);
});
