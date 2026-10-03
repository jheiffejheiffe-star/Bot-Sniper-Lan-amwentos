/**
 * `npm run free:check` — MEDIÇÃO DA PILHA GRATUITA, no SEU ambiente, sem assinar nada.
 *
 * ## O que faz
 *
 * Executa, em sequência, as camadas que um bot gratuito usa — e imprime o que foi MEDIDO, o
 * que NÃO respondeu e o que não foi medido:
 *
 *   1. Configuração: modo de execução, host do RPC (chave mascarada) e perfil de cota efetivo.
 *   2. RPC: 5 chamadas `getLatestBlockhash` → p50/p95 reais + slot observado.
 *   3. Detecção WebSocket: assina logs do programa Pump.fun e CONTA notificações na janela.
 *   4. DexScreener: 1 requisição de token (300 req/min no plano público).
 *   5. Jupiter: 1 cotação real (60 req/min no plano Free, por organização).
 *   6. Jito: tip floor (REST) e `getTipAccounts` (block engine) — 1 req/s por IP por região.
 *   7. Orçamentos: tabela de teto por provedor, com a ORIGEM de cada número.
 *   8. Recomendação: bloco `.env` baseado no que foi medido (ou "sem medição", quando falhou).
 *
 * ## Por que existe
 *
 * Em plano gratuito o bot não morre de latência: morre de `429` e de queda de WebSocket. Este
 * comando separa, com evidência, três coisas que parecem iguais no log — "a rede está lenta",
 * "a cota acabou" e "o endpoint não responde" — e diz qual é o caso no SEU ambiente.
 *
 * ## O que NÃO faz
 *
 * Nenhuma assinatura, nenhum envio, nenhum gasto. Só leitura. Não grava nada em disco.
 *
 * ## Limite honesto
 *
 * Uma janela de 20 s no WebSocket pode ver 0 lançamentos e isso NÃO prova que a detecção está
 * quebrada: prova apenas que, nesse intervalo, nada chegou. Para julgar detecção, use janela
 * maior (`--ws-window=120`) e várias execuções em horários diferentes.
 *
 * Uso: `npm run free:check` · `npm run free:check -- --quick` (pula a janela de WS)
 *      `npm run free:check -- --ws-window=120`
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { RPC_ENDPOINT, RPC_WEBSOCKET } from "../src/realExecution.js";
import { RPC_PROFILES, buildBudgetRegistry, type RpcProfileName } from "../src/rateBudget.js";
import { PumpPortalFeed } from "../src/pumpPortalFeed.js";
import { fetchRugCheckEvidence } from "../src/rugCheck.js";
import { getRuntimeModeResolution } from "../src/runtimeMode.js";

const args = process.argv.slice(2);
const QUICK = args.includes("--quick");
const WS_WINDOW_MS = (() => {
  const raw = args.find((a) => a.startsWith("--ws-window="));
  if (!raw) return 20_000;
  const n = Number(raw.split("=")[1]);
  return Number.isFinite(n) && n >= 5 ? Math.min(n, 300) * 1000 : 20_000;
})();

const PUMP_FUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEXSCREENER_BASE_URL = "https://api.dexscreener.com/latest/dex";
const TIP_FLOOR_URL = "https://bundles.jito.wtf/api/v1/bundles/tip_floor";
const JITO_BLOCK_ENGINE = "https://mainnet.block-engine.jito.wtf";

const results: Array<{ stage: string; ok: boolean; detail: string; skipped?: boolean }> = [];
function record(stage: string, ok: boolean, detail: string, skipped = false): void {
  results.push({ stage, ok, detail, skipped });
  const icon = skipped ? "⬜" : ok ? "✅" : "❌";
  console.log(`${icon} ${stage.padEnd(34, ".")} ${detail}`);
}

/** Mascara a chave do endpoint: o valor NUNCA é impresso, só o host. */
function maskEndpoint(url: string): string {
  try {
    const u = new URL(url);
    const hasKey = u.searchParams.toString().length > 0;
    return `${u.protocol}//${u.host}${hasKey ? "/?…(chave presente, não exibida)" : ""}`;
  } catch {
    return "(URL inválida)";
  }
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function round1(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : Number.NaN;
}

async function timedFetch(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; ms: number; body?: any }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(9000) });
    const ms = Date.now() - t0;
    let body: any = undefined;
    const text = await res.text().catch(() => "");
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 200);
    }
    return { ok: res.ok, status: res.status, ms, body };
  } catch (err: any) {
    return { ok: false, status: 0, ms: Date.now() - t0, body: err?.message ?? String(err) };
  }
}

async function main(): Promise<void> {
  console.log("=========================================================");
  console.log("  MEDIÇÃO DA PILHA GRATUITA — nada é assinado ou enviado");
  console.log("=========================================================\n");

  /* ------------------------------------------------------------------ */
  console.log("[1] Configuração");
  const mode = getRuntimeModeResolution();
  record(
    "Modo de execução",
    true,
    `${mode.mode} (pedido: ${mode.requested ?? "nada declarado"}; LIVE autorizado: ${mode.liveAuthorized})`
  );
  if (!mode.liveAuthorized) {
    record("Assinatura de transação", true, "desarmada neste processo — leitura pura, nenhuma chave em uso");
  }
  record("RPC primário (host)", true, maskEndpoint(RPC_ENDPOINT), false);
  record("RPC WebSocket (host)", true, maskEndpoint(RPC_WEBSOCKET));
  const rpcProfile = (process.env.HFT_RPC_PROFILE || "public").toLowerCase() as RpcProfileName;
  const profile = RPC_PROFILES[rpcProfile] ?? RPC_PROFILES.public;
  record(
    "Perfil de cota declarado",
    Boolean(RPC_PROFILES[rpcProfile]),
    RPC_PROFILES[rpcProfile] ? `${rpcProfile}: ${profile.limit} req/${profile.windowMs}ms` : `${rpcProfile} desconhecido — usando "public"`
  );

  /* ------------------------------------------------------------------ */
  console.log("\n[2] RPC (leitura, 5 amostras)");
  const samples: number[] = [];
  let slot: number | null = null;
  let rpcError = "";
  const conn = new Connection(RPC_ENDPOINT, { commitment: "processed", disableRetryOnRateLimit: true });
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    try {
      const [bh, s] = await Promise.all([conn.getLatestBlockhash("processed"), conn.getSlot("processed")]);
      samples.push(Date.now() - t0);
      slot = s;
      if (!bh?.blockhash) throw new Error("blockhash vazio");
    } catch (err: any) {
      rpcError = err?.message ?? String(err);
      break;
    }
  }
  if (samples.length > 0) {
    const sorted = [...samples].sort((a, b) => a - b);
    record(
      "RPC responde",
      true,
      `p50=${round1(pct(sorted, 50))}ms p95=${round1(pct(sorted, 95))}ms (n=${samples.length}) | slot=${slot}`
    );
  } else {
    record("RPC responde", false, `sem resposta: ${rpcError || "erro desconhecido"}`);
  }

  /* ------------------------------------------------------------------ */
  console.log("\n[3] Detecção por WebSocket (logs do Pump.fun)");
  if (QUICK) {
    record("WebSocket logsSubscribe", true, "pulada (--quick)", true);
  } else {
    try {
      /**
       * Contrato verificado no `@solana/web3.js` (index.d.ts, `wsEndpoint?`): o primeiro
       * argumento do `Connection` é HTTP(S) e o WebSocket vai em `wsEndpoint`. Passar `wss://`
       * como endpoint primário quebra com "Endpoint URL must start with http(s)" — foi o que
       * aconteceu na primeira execução deste script, e é o tipo de erro que só a EXECUÇÃO mostra.
       */
      const wsConn = new Connection(RPC_ENDPOINT, { commitment: "processed", wsEndpoint: RPC_WEBSOCKET });
      let notifications = 0;
      let subId = -1;
      const started = Date.now();
      subId = wsConn.onLogs(new PublicKey(PUMP_FUN_PROGRAM), () => {
        notifications++;
      }, "processed");
      await new Promise((r) => setTimeout(r, WS_WINDOW_MS));
      try {
        wsConn.removeOnLogsListener(subId);
      } catch {
        /* ignora */
      }
      // Encerra o socket interno do web3.js (que reconecta para sempre por padrão).
      const ws = (wsConn as any)._rpcWebSocket;
      if (ws) {
        try {
          if (typeof ws.setAutoReconnect === "function") ws.setAutoReconnect(false);
          if (typeof ws.close === "function") ws.close();
        } catch {
          /* ignora */
        }
      }
      const elapsed = Math.round((Date.now() - started) / 1000);
      /**
       * TRÊS resultados diferentes, e confundi-los leva a diagnóstico errado:
       *   socket não abriu      → problema de REDE/permissão (nada foi testado);
       *   abriu, 0 notificações → INCONCLUSIVO (pode não haver lançamento na janela);
       *   abriu, N notificações → detecção VIVA (prova de recebimento).
       */
      const socketOpen = (wsConn as any)._rpcWebSocketConnected === true;
      if (!socketOpen) {
        record(
          "WebSocket logsSubscribe",
          false,
          `socket NÃO abriu (${elapsed}s) — rede/firewall do ambiente bloqueando ${maskEndpoint(RPC_WEBSOCKET)}`
        );
      } else if (notifications === 0) {
        record(
          "WebSocket logsSubscribe",
          false,
          `socket abriu e 0 notificação(ões) em ${elapsed}s — INCONCLUSIVO: aumente --ws-window e repita em outro horário`
        );
      } else {
        record(
          "WebSocket logsSubscribe",
          true,
          `${notifications} notificação(ões) em ${elapsed}s (~${(notifications / elapsed).toFixed(1)}/s) — detecção VIVA`
        );
      }
    } catch (err: any) {
      record("WebSocket logsSubscribe", false, `falha de conexão: ${err?.message ?? err}`);
    }
  }

  /* ------------------------------------------------------------------ */
  console.log("\n[3b] Feed PumpPortal (mint direto, grátis, sem chave)");
  if (QUICK) {
    record("PumpPortal subscribeNewToken", true, "pulada (--quick)", true);
  } else {
    const ppWindowMs = 12_000;
    let ppEvents = 0;
    let ppError: string | null = null;
    const ppFeed = new PumpPortalFeed({
      onEvent: () => {
        ppEvents++;
      },
    });
    ppFeed.connect();
    await new Promise((r) => setTimeout(r, ppWindowMs));
    const h = ppFeed.getHealth();
    ppFeed.stop();
    ppError = h.lastError;
    if (!h.socketOpen) {
      record(
        "PumpPortal subscribeNewToken",
        false,
        `socket NÃO abriu (${ppWindowMs / 1000}s) — ${ppError ?? "sem detalhe do erro"}`
      );
    } else if (ppEvents === 0) {
      record(
        "PumpPortal subscribeNewToken",
        false,
        `socket abriu e 0 evento(s) em ${ppWindowMs / 1000}s — INCONCLUSIVO (pump.fun lança em rajadas; repita)`
      );
    } else {
      record(
        "PumpPortal subscribeNewToken",
        true,
        `${ppEvents} evento(s) em ${ppWindowMs / 1000}s com mint direto ($${h.messagesReceived} mensagens, ` +
          `${h.invalidMessages} inválidas, ${h.duplicatesDropped} duplicadas)`
      );
    }
  }

  /* ------------------------------------------------------------------ */
  console.log("\n[4] DexScreener (mercado)");
  const dex = await timedFetch(`${DEXSCREENER_BASE_URL}/tokens/${USDC_MINT}`);
  record(
    "DexScreener responde",
    dex.ok,
    dex.ok
      ? `HTTP ${dex.status} em ${dex.ms}ms (cota pública: 300 req/min)`
      : `HTTP ${dex.status} em ${dex.ms}ms — ${String(dex.body ?? "").slice(0, 80)}`
  );

  /* ------------------------------------------------------------------ */
  console.log("\n[5] Jupiter (cotação de saída)");
  const jupBase = (process.env.JUPITER_BASE_URL || "https://lite-api.jup.ag/swap/v1").replace(/\/$/, "");
  const jup = await timedFetch(
    `${jupBase}/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=10000000&slippageBps=100`
  );
  record(
    "Jupiter cotação",
    jup.ok && typeof jup.body?.outAmount === "string",
    jup.ok
      ? `outAmount presente em ${jup.ms}ms (host ${new URL(jupBase).host}; Free: 60 req/min por organização)`
      : `HTTP ${jup.status} em ${jup.ms}ms — ${String(jup.body ?? "").slice(0, 80)}`
  );

  /* ------------------------------------------------------------------ */
  console.log("\n[6] Jito (tip floor + block engine)");
  const tip = await timedFetch(TIP_FLOOR_URL);
  if (tip.ok && Array.isArray(tip.body) && tip.body.length > 0) {
    const e = tip.body[0];
    record("Tip floor (REST)", true, `p50=${e?.landed_tips_50th_percentile ?? "?"} SOL em ${tip.ms}ms`);
  } else {
    record("Tip floor (REST)", false, `HTTP ${tip.status} em ${tip.ms}ms — ${String(tip.body ?? "").slice(0, 80)}`);
  }
  const tipAccounts = await timedFetch(`${JITO_BLOCK_ENGINE}/api/v1/getTipAccounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }),
  });
  record(
    "Jito block engine",
    tipAccounts.ok && Array.isArray(tipAccounts.body?.result),
    tipAccounts.ok
      ? `${tipAccounts.body?.result?.length ?? 0} tip accounts em ${tipAccounts.ms}ms (limite: 1 req/s/IP/região)`
      : `HTTP ${tipAccounts.status} em ${tipAccounts.ms}ms — ${String(tipAccounts.body ?? "").slice(0, 80)}`
  );

  /* ------------------------------------------------------------------ */
  console.log("\n[6b] RugCheck (evidência externa de risco, grátis)");
  const rugcheck = await fetchRugCheckEvidence(USDC_MINT, {
    fetchImpl: (async (url: any, init: any) => {
      const t0 = Date.now();
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(9000) });
      return { ok: res.ok, status: res.status, json: async () => res.json(), _ms: Date.now() - t0 } as any;
    }) as any,
    timeoutMs: 9_000,
  });
  record(
    "RugCheck /report",
    rugcheck.available,
    rugcheck.available
      ? `disponível em ${rugcheck.latencyMs ?? "?"}ms (score=${rugcheck.score ?? "?"}, riscos=${rugcheck.risks.length}) — evidência ADICIONAL: não aprova nada, só desconta`
      : `INDISPONÍVEL: ${rugcheck.reason ?? "motivo não informado"} (o bot registra como verificação faltante; NÃO aprova por ausência)`
  );

  /* ------------------------------------------------------------------ */
  console.log("\n[7] Orçamentos que este processo aplicaria");
  const registry = buildBudgetRegistry({ rpcProfile: process.env.HFT_RPC_PROFILE });
  for (const b of registry.snapshot()) {
    console.log(`   • ${b.name.padEnd(18)} teto ${String(b.limit).padStart(4)} / ${b.windowMs}ms — ${b.source}`);
  }

  /* ------------------------------------------------------------------ */
  console.log("\n[8] Recomendação para .env (somente o que foi medido)");
  const networkFailures = results.filter((r) => !r.ok && !r.skipped).length;
  if (samples.length === 0) {
    console.log("   ⚠️  Sem medição de RPC: NÃO há recomendação de endpoint. Corrija a rede antes de operar.");
  } else {
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = round1(pct(sorted, 95));
    console.log(`   RPC_ENDPOINT=${maskEndpoint(RPC_ENDPOINT)}   # medido p95=${p95}ms nesta rede`);
    console.log(`   RPC_WEBSOCKET=${maskEndpoint(RPC_WEBSOCKET)}`);
    console.log(`   HFT_RPC_PROFILE=${RPC_PROFILES[rpcProfile] ? rpcProfile : "public"}`);
    console.log(
      `   # Regra prática: se p95 > 250ms, o gargalo é REDE até o provedor — nenhuma otimização de\n` +
        `   # código resolve isso. Plano gratuito com host domiciliar (Brasil) costuma medir 120–200ms até\n` +
        `   # us-east; o mesmo código em VPS gratuito na mesma região que o RPC mede uma ordem de grandeza menos.`
    );
  }

  console.log("\n=========================================================");
  console.log(`  ${results.length} estágios | ${networkFailures} falha(s) de rede | nada foi assinado ou enviado`);
  console.log("=========================================================");
  process.exit(networkFailures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[free:check] falha inesperada:", err?.message ?? err);
  process.exit(2);
});
