/**
 * VERIFICAÇÃO DO FAST PATH gRPC — conecta, ESCUTA e imprime o que o provedor entrega.
 *
 * ## O que faz
 *
 * Lê `GEYSER_GRPC_URL`/`GEYSER_GRPC_TOKEN` (ou `--url`/`--token`), conecta ao stream de transações
 * do programa pump no commitment `processed`, roda por N segundos e imprime, medido:
 *
 * - updates recebidos (tráfego do canal), separando `CreateEvent` de outros;
 * - latência entre o update e o fim da decodificação (`p50`, `p95`) — o número que o S7 existe
 *   para melhorar, medido AQUI, sem depender de `getTransaction`;
 * - slot do evento e arrasto estimado em relação ao slot local;
 * - erros/motivos, sem nunca imprimir o token.
 *
 * ## Como funciona
 *
 * Usa exatamente o mesmo cliente do runtime (`GrpcIngestClient` + adaptador Yellowstone), com o
 * mesmo filtro e a mesma decodificação — se este script vê lançamentos, o runtime vê também.
 *
 * **Nenhuma transação é assinada ou enviada**: o script só assina um stream de leitura. Não existe
 * chave neste caminho (nada de `Keypair`, `sign` ou `sendTransaction`).
 *
 * ## Dependências
 *
 * `@triton-one/yellowstone-grpc` (instalado por `npm ci`) e um endpoint gRPC válido. Provedor
 * gratuito ou pago: é o operador que escolhe; sem endpoint, este script diz que não há o que testar.
 *
 * ## Riscos
 *
 * 1. Um stream "conectado" que não entrega NADA é indistinguível de mercado parado sem esta
 *    medição: o script imprime `updates` justamente para separar "canal mudo" de "sem lançamento".
 * 2. Feed gRPC de terceiro é cota/limite do provedor: rodar em laço contínuo consome a sua cota.
 *
 * ## Como testar
 *
 * `npm run grpc:check -- --seconds 30`
 *
 * ## Como colocar em produção
 *
 * Rode ANTES de ligar `HFT_INGEST=grpc`: com `updates > 0` e sem erro, o caminho está provado no SEU
 * ambiente. Se `updates == 0` com o stream aberto, o problema é filtro/endpoint — e o runtime deve
 * continuar no WSS (`HFT_INGEST=wss`) até isso ser resolvido.
 */

import { GrpcIngestClient, assessGrpcEndpoint, redactGrpcEndpoint, sanitizeGrpcError, resolveIngestPolicy } from "../src/grpcIngest.js";
import { loadYellowstoneClient } from "../src/grpcYellowstoneClient.js";
import { PUMP_PROGRAM_ID } from "../src/pumpInstruction.js";

interface Args {
  url: string;
  token: string;
  seconds: number;
}

function parseArgs(argv: string[]): Args {
  const flag = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    url: flag("url", (process.env.GEYSER_GRPC_URL ?? "").trim()),
    token: flag("token", (process.env.GEYSER_GRPC_TOKEN ?? "").trim()),
    seconds: Math.max(5, Math.min(600, Number(flag("seconds", "30")) || 30)),
  };
}

function percentil(valores: number[], p: number): number | null {
  if (valores.length === 0) return null;
  const ordenado = [...valores].sort((a, b) => a - b);
  const idx = Math.min(ordenado.length - 1, Math.max(0, Math.ceil((p / 100) * ordenado.length) - 1));
  return ordenado[idx];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const policy = resolveIngestPolicy({ ...process.env, GEYSER_GRPC_URL: args.url, GEYSER_GRPC_TOKEN: args.token } as NodeJS.ProcessEnv);

  console.log("=======================================================");
  console.log(" CHECK do fast path gRPC (Yellowstone) — somente leitura");
  console.log("=======================================================");
  if (!args.url) {
    console.error(
      "\n✗ GEYSER_GRPC_URL não informado. Este script NÃO inventa endpoint: informe o do seu provedor\n" +
        "  (--url host:porta ou a variável no .env). Sem ele, o bot opera pelo WebSocket (mais lento,\n" +
        "  e cobrindo os mesmos programas) — não há nada quebrado.\n"
    );
    process.exit(2);
  }
  const endpoint = assessGrpcEndpoint(args.url);
  if (!endpoint.ok) {
    console.error(`\n✗ GEYSER_GRPC_URL inválido: ${endpoint.problem}\n`);
    process.exit(2);
  }
  console.log(`endpoint     : ${redactGrpcEndpoint(args.url)}`);
  console.log(`token        : ${args.token ? "presente (não exibido)" : "ausente"}`);
  console.log(`programa     : ${PUMP_PROGRAM_ID}`);
  console.log(`duração      : ${args.seconds}s`);
  console.log(`política     : pedido=${policy.requested} efetivo=${policy.effective}`);
  console.log("");

  const started = Date.now();
  const latencias: number[] = [];
  let creates = 0;
  let outros = 0;
  let ultimoSlot: number | null = null;

  const client = new GrpcIngestClient(
    () => loadYellowstoneClient(args.url, args.token),
    {
      url: args.url,
      token: args.token,
      programId: PUMP_PROGRAM_ID,
      pingIntervalMs: 15_000,
      maxReconnectAttempts: 3,
      initialBackoffMs: 1_000,
    }
  );

  client.onTokenDetected((event) => {
    creates++;
    const atraso = Date.now() - event.detectedAt;
    latencias.push(atraso);
    if (typeof event.slot === "number") ultimoSlot = event.slot;
    console.log(
      `[${new Date().toISOString()}] LANÇAMENTO mint=${event.mint} slot=${event.slot ?? "?"} ` +
        `fonte=${event.source} nome=${event.mintName} decode=${atraso}ms`
    );
  });

  await client.connect();

  const amostra = setInterval(() => {
    const h: any = client.getHealth();
    const recebidos = h.grpc?.updatesSeen ?? 0;
    outros = Math.max(outros, recebidos - creates);
    console.log(
      `  … ${Math.round((Date.now() - started) / 1000)}s: updates=${recebidos} ` +
        `lançamentos=${creates} streamOpen=${h.socketOpen} reconexões=${h.grpc?.reconnectAttempts ?? 0}`
    );
  }, 5_000);

  await new Promise((r) => setTimeout(r, args.seconds * 1_000));
  clearInterval(amostra);

  const h: any = client.getHealth();
  client.disconnect();

  console.log("\n── Medido ──────────────────────────────────────────────");
  console.log(`  updates recebidos   : ${h.grpc?.updatesSeen ?? 0} (tráfego do canal: prova de que o stream VIVE)`);
  console.log(`  CreateEvent         : ${creates}`);
  console.log(`  outros updates      : ${outros} (trades/admin: o filtro do pump não é só lançamento)`);
  console.log(`  latência decode p50 : ${percentil(latencias, 50) ?? "n/d"}ms`);
  console.log(`  latência decode p95 : ${percentil(latencias, 95) ?? "n/d"}ms`);
  console.log(`  último slot do evento: ${ultimoSlot ?? "n/d"}`);
  console.log(`  reconexões          : ${h.grpc?.reconnectAttempts ?? 0}`);
  console.log(`  erros de decode     : ${h.grpc?.decodeFailures ?? 0}`);
  for (const err of h.recentErrors ?? []) console.log(`  erro: ${sanitizeGrpcError(String(err), args.token)}`);

  console.log("\n=======================================================");
  if ((h.grpc?.updatesSeen ?? 0) > 0) {
    console.log(" VERDICT: canal PROVADO — o provedor entregou transações do programa.");
    console.log(
      creates > 0
        ? " Lançamentos foram decodificados: HFT_INGEST=grpc tem o que precisa."
        : " Nenhum CreateEvent no período (mercado parado é possível, mas confira o filtro)."
    );
  } else {
    console.log(" VERDICT: canal MUDO — nenhum update no período.");
    console.log(" Causas prováveis: endpoint/token do provedor, cota excedida, ou filtro recusado.");
    console.log(" Mantenha HFT_INGEST=wss: a detecção continua pelos programas via WebSocket.");
  }
  console.log(" Nada foi assinado ou enviado: este script só LÊ a rede.");
  console.log("=======================================================\n");
}

main().catch((err) => {
  console.error(`\n✗ Falha no check do gRPC: ${sanitizeGrpcError(String(err?.message ?? err), process.env.GEYSER_GRPC_TOKEN)}\n`);
  process.exit(2);
});
