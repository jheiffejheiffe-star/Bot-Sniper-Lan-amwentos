/**
 * ADAPTADOR YELLOWSTONE — a única parte que toca o pacote nativo `@triton-one/yellowstone-grpc`.
 *
 * ## O que faz
 *
 * Converte o update protobuf do Yellowstone no tipo estrutural que `src/grpcIngest.ts` consome
 * (`GrpcTransactionUpdate`) e monta o pedido de assinatura (`SubscribeRequest`) para o programa
 * informado. Mantém TODO o conhecimento da biblioteca num só arquivo: se a API do pacote mudar, o
 * núcleo de ingestão (e os seus testes) não mudam.
 *
 * ## Como funciona
 *
 * - A biblioteca é carregada por `import()` dinâmico. Isso é deliberado:
 *   1. o processo sobe mesmo sem o binário nativo disponível (o caminho WSS continua funcionando);
 *   2. `npm run test` (e o bundle do servidor) não precisam carregar o módulo nativo;
 *   3. a falha é REPORTADA como string, não como exceção não tratada.
 * - Normalização: `message.accountKeys` e `meta.loaded*Addresses` são `Uint8Array` → base58; os
 *   logs já vêm como `string[]`; o slot vem como `string` (u64 do protobuf) → number.
 *
 * ## Dependências
 *
 * `@triton-one/yellowstone-grpc` (dependência do projeto, `--packages=external` no bundle) e
 * `bs58`. Nenhuma chave, nenhuma assinatura: este arquivo só LÊ a rede.
 *
 * ## Riscos
 *
 * 1. **Pacote nativo (N-API)**: exige binário compatível com a plataforma. Em arquitetura sem
 *    build disponível, o carregamento falha e o erro é devolvido com o nome do pacote — o operador
 *    vê que é infraestrutura, não layout.
 * 2. **Formato do update**: campos opcionais do protobuf (`meta`, `transaction`) podem faltar; o
 *    normalizador devolve `null` em vez de inventar campos. `null` significa "este update não é
 *    uma transação que possamos usar".
 * 3. **u64 como string**: slots e valores grandes vêm como string decimal; converter com `Number`
 *    é seguro para slot (ordem de 10^8-10^9) e NÃO é seguro para lamports — por isso aqui só se
 *    converte slot.
 *
 * ## Como testar
 *
 * O núcleo é testado com dublê (grupo [26]). Este adaptador é exercitado em `npm run grpc:check`,
 * que conecta, espera updates e imprime o que chegou (read-only; nada é assinado).
 *
 * ## Como colocar em produção
 *
 * `GEYSER_GRPC_URL` (host:porta) + `GEYSER_GRPC_TOKEN` do provedor. Sem os dois, o caminho é WSS.
 */

import bs58 from "bs58";
import type { GrpcClientLike, GrpcStreamLike, GrpcTransactionUpdate } from "./grpcIngest.js";

/** Nome do pacote, isolado: é ele que aparece no erro quando o carregamento falha. */
export const YELLOWSTONE_PACKAGE = "@triton-one/yellowstone-grpc";

interface YellowstoneModule {
  default?: unknown;
  CommitmentLevel?: Record<string, number>;
}

/**
 * Carrega o cliente real. Erros são convertidos em `Error` com o pacote no texto: um
 * `MODULE_NOT_FOUND` cru ("Cannot find module") não diz ao operador qual caminho caiu.
 */
export async function loadYellowstoneClient(endpoint: string, token: string): Promise<GrpcClientLike> {
  let mod: YellowstoneModule;
  try {
    // Carregamento dinâmico deliberado: o caminho WSS não paga por ele e não falha sem ele.
    mod = (await import(YELLOWSTONE_PACKAGE)) as unknown as YellowstoneModule;
  } catch (err: any) {
    throw new Error(
      `não foi possível carregar ${YELLOWSTONE_PACKAGE} (${err?.code ?? err?.name ?? "erro"}: ${err?.message ?? err}). ` +
        `Instale as dependências (npm ci) ou use HFT_INGEST=wss, que não precisa deste pacote.`
    );
  }

  const ClientCtor = (mod.default ?? (mod as any).Client) as new (
    endpoint: string,
    xToken: string | undefined,
    channelOptions: Record<string, unknown> | undefined
  ) => {
    connect(): Promise<void>;
    subscribe(request: unknown): Promise<GrpcStreamLike>;
    getSlot?(commitment?: unknown): Promise<{ slot?: string | number } | string | number>;
    close?(): void;
  };

  if (typeof ClientCtor !== "function") {
    throw new Error(
      `${YELLOWSTONE_PACKAGE} carregou, mas não expõe um construtor de cliente (export default ausente). ` +
        `Versão do pacote incompatível com este adaptador.`
    );
  }

  const client = new ClientCtor(endpoint, token || undefined, {});
  const commitmentProcessed = mod.CommitmentLevel?.PROCESSED ?? 1;
  const commitmentConfirmed = mod.CommitmentLevel?.CONFIRMED ?? 2;

  return {
    connect: () => client.connect(),
    subscribe: (request) => client.subscribe(request),
    getSlot: async () => {
      if (!client.getSlot) return null;
      try {
        const res = await client.getSlot(commitmentProcessed);
        if (typeof res === "number") return res;
        if (typeof res === "string") return Number(res);
        if (res && typeof res === "object" && res.slot !== undefined) return Number(res.slot);
        return null;
      } catch {
        return null;
      }
    },
    close: () => {
      try {
        client.close?.();
      } catch {
        /* ignora */
      }
    },
    buildTransactionSubscribeRequest: (programId, commitment) => ({
      transactions: {
        pump_launches: {
          vote: false,
          failed: false,
          accountInclude: [programId],
          accountExclude: [],
          accountRequired: [],
        },
      },
      // Campos vazios exigidos pelo protobuf (mapas devem ser declarados como objeto vazio).
      accounts: {},
      slots: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: commitment === "processed" ? commitmentProcessed : commitmentConfirmed,
    }),
    buildPingRequest: (id) => ({ ping: { id } }),
    normalizeTransactionUpdate: (raw) => normalizeYellowstoneUpdate(raw),
  };
}

/**
 * Normaliza o update do protobuf. Devolve `null` quando não é um update de transação utilizável
 * (update de slot/conta/ping, ou transação sem mensagem) — o chamador trata `null` como "não é
 * lançamento", sem contar como falha de decodificação.
 */
export function normalizeYellowstoneUpdate(raw: unknown): GrpcTransactionUpdate | null {
  const update = raw as any;
  const tx = update?.transaction;
  if (!tx) return null;

  const info = tx.transaction;
  if (!info) return null;
  const message = info.transaction?.message;
  const meta = info.meta;

  const signatureBytes: Uint8Array | undefined = info.signature;
  const signature = signatureBytes ? bs58.encode(signatureBytes) : "";
  if (!signature) return null;

  const toBase58 = (bytes: unknown): string => {
    if (!bytes) return "";
    if (typeof bytes === "string") return bytes;
    try {
      return bs58.encode(bytes as Uint8Array);
    } catch {
      return "";
    }
  };

  const accountKeys: string[] = [];
  for (const key of message?.accountKeys ?? []) accountKeys.push(toBase58(key));
  // Contas carregadas de Address Lookup Table: sem elas, uma transação v0 fica sem os endereços
  // que só existem na tabela. Aqui entram DEPOIS das estáticas — mesma ordem do runtime.
  for (const key of meta?.loadedWritableAddresses ?? []) accountKeys.push(toBase58(key));
  for (const key of meta?.loadedReadonlyAddresses ?? []) accountKeys.push(toBase58(key));

  const slotRaw = tx.slot ?? info.slot ?? "0";
  const slot = Number(slotRaw);

  return {
    slot: Number.isFinite(slot) ? slot : 0,
    signature,
    failed: meta?.err !== undefined && meta?.err !== null,
    isVote: info.isVote === true,
    logMessages: Array.isArray(meta?.logMessages) ? meta.logMessages : [],
    accountKeys: accountKeys.filter((k) => k !== ""),
  };
}
