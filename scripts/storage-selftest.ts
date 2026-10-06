/**
 * AUTO-TESTE DO POSTGRES EM MEMÓRIA (S10) — prova o caminho do banco SEM nuvem, SEM daemon e
 * SEM gastar nada.
 *
 * ## O que faz
 *
 * Sobe um **PostgreSQL real** (compilado para WASM, `@electric-sql/pglite`) atrás de um servidor de
 * socket que fala o protocolo nativo do Postgres, e então executa, pelo driver `pg` — o MESMO do
 * runtime — os cenários que sustentam o S10:
 *
 * 1. `DATABASE_URL` sem esquema explícito e migração idempotente (`initialize` → `migrate` → no-op);
 * 2. banco NOVO (conectado, sem schema) ≠ banco fora do ar;
 * 3. dois adaptadores disputando o mesmo mint: exatamente UM ganha, e o perdedor recebe o dono;
 * 4. claim expirado retomado de forma atômica, e o dono antigo impossibilitado de liberar o novo;
 * 5. liberação pelo dono → o mint volta a ficar disponível;
 * 6. espelho de posição/trade/intenção/log com upsert e contagens;
 * 7. guarda de entrada fail-closed com o banco derrubado.
 *
 * ## Limite de escopo (declarado, não escondido)
 *
 * O PGlite é um Postgres de **conexão única**: o servidor de socket atende um cliente por vez. Por
 * isso a disputa pelo claim aqui é SEQUENCIAL — que é exatamente a ordem que importa (A entra,
 * B tenta depois). O que este harness NÃO prova:
 *
 * - dois claims simultâneos no mesmo instante com conexões concorrentes — quem garante isso é o
 *   **índice único parcial** do banco (descrito abaixo e conferido aqui por SQL);
 * - rede real do provedor: TLS, pooler (PgBouncer/Supavisor), limites de conexão e permissões;
 * - `pg.Pool` com várias conexões (o runtime usa um cliente; um pool é decisão de operação).
 *
 * Para esses pontos, o caminho é `npm run storage:check` contra o banco real no VPS.
 *
 * ## Como funciona
 *
 * `PGLiteSocketServer` aceita conexões TCP do protocolo Postgres e as encaminha para a instância
 * WASM em memória. O `pg` então conecta em `127.0.0.1:<porta>` como conectaria em qualquer servidor.
 * **É PostgreSQL de verdade (v18/WASM), mas não é o Postgres que você vai usar em produção**: o
 * caminho de rede, TLS, pooler e permissões do provedor (Neon/Supabase) NÃO estão cobertos aqui —
 * isso é validado no VPS com `npm run storage:check` contra o banco real.
 *
 * ## Dependências
 *
 * - `@electric-sql/pglite` + `@electric-sql/pglite-socket` (devDependencies) e `pg` (runtime).
 * Nenhum servidor externo, nenhuma conta, nenhum custo.
 *
 * ## Riscos
 *
 * - O banco é **em memória**: ao terminar, tudo se perde. É intencional — o script não toca nenhum
 * banco real e não pode causar dano a dados de produção.
 * - A porta é efêmera (padrão 55432); se estiver ocupada, passe outra em `HFT_SELFTEST_PORT`.
 * - Este script NÃO fala com a rede Solana, NÃO assina nada e NÃO habilita entrada real.
 *
 * ## Como testar
 *
 * ```bash
 * npm run storage:selftest
 * ```
 *
 * ## Como colocar em produção
 *
 * Não precisa: é ferramenta de verificação. Em produção, o caminho é `npm run storage:migrate`
 * + `npm run storage:check` contra o banco real, e `HFT_STORAGE=postgres` no bot.
 */

import { PostgresStorage, resolveStoragePolicy, loadPgClient } from "../src/storage/postgresStorage.js";
import { SCHEMA_VERSION } from "../src/storage/schema.js";

type Resultado = { nome: string; ok: boolean; detalhe: string };
const resultados: Resultado[] = [];

function checar(nome: string, condicao: boolean, detalhe: string): void {
  resultados.push({ nome, ok: condicao, detalhe });
  console.log(`${condicao ? "✅" : "❌"} ${nome} — ${detalhe}`);
}

async function main(): Promise<number> {
  const porta = Number(process.env.HFT_SELFTEST_PORT ?? 55432);
  const { PGlite } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");

  const db = new PGlite();
  const servidor = new PGLiteSocketServer({ db, port: porta, host: "127.0.0.1" });
  await servidor.start();
  console.log(`[selftest] PostgreSQL (WASM) escutando em 127.0.0.1:${porta} — em memória, nada é persistido\n`);

  const url = `postgres://selftest:selftest@127.0.0.1:${porta}/postgres`;
  const policy = resolveStoragePolicy({
    HFT_STORAGE: "postgres",
    DATABASE_URL: url,
    HFT_STORAGE_CLAIM_TTL_MS: "5000",
  } as any);
  checar("política resolveu para Postgres", policy.mode === "postgres", `TTL do claim = ${policy.claimTtlMs}ms`);

  /**
   * UMA conexão, dois adaptadores: cada adaptador é uma instância do bot (dono diferente), e ambos
   * falam com o MESMO banco — que é o que torna o voo único entre processos possível.
   */
  const conexao = await loadPgClient(url);
  const instancia = new PostgresStorage(conexao, policy, "selftest#1");
  const outro = new PostgresStorage(conexao, policy, "selftest#2");

  const inicial = await instancia.initialize();
  checar(
    "banco NOVO: conectado, mas sem schema (não é 'fora do ar')",
    inicial.connected === true && inicial.migrated === false && inicial.lastError === null,
    `connected=${inicial.connected} migrated=${inicial.migrated} erro=${inicial.lastError ?? "nenhum"}`
  );

  const m1 = await instancia.migrate();
  const m2 = await instancia.migrate();
  checar(
    "migração aplica a v1 e é idempotente",
    m1.applied.join() === String(SCHEMA_VERSION) && m2.applied.length === 0,
    `1ª aplicou [${m1.applied}] · 2ª aplicou [${m2.applied}]`
  );
  checar("schema ficou na versão esperada", instancia.health().schemaVersion === SCHEMA_VERSION, `v${instancia.health().schemaVersion}`);

  // ---- VOO ÚNICO ENTRE PROCESSOS ------------------------------------------------------------
  const mint = "SelfTestMint1111111111111111111111111111111";
  const a = await instancia.claimEntry({ mint, side: "entry", payload: { sizeSol: 0.01 } });
  const b = await outro.claimEntry({ mint, side: "entry", payload: { sizeSol: 0.01 } });
  checar(
    "voo único: dos dois processos, exatamente UM ganha",
    a.acquired === true && b.acquired === false,
    `#1=${a.reason} · #2=${b.reason}, detido por ${b.heldBy ?? "n/d"}`
  );
  checar("mint diferente não compete", (await outro.claimEntry({ mint: "OutroMint222222", side: "entry" })).acquired === true, "claim por (mint, side)");

  // ---- EXPIRAÇÃO E RETOMADA ------------------------------------------------------------------
  const ttl = await instancia.claimEntry({ mint: "ExpiraMint333333", side: "entry", ttlMs: 1_000 });
  await new Promise((r) => setTimeout(r, 1_200));
  const retomado = await outro.claimEntry({ mint: "ExpiraMint333333", side: "entry" });
  checar(
    "claim vencido é retomado (crash não bloqueia o mint para sempre)",
    ttl.acquired === true && retomado.acquired === true && retomado.reason === "retomado-expirado",
    `motivo da retomada: ${retomado.reason}`
  );
  const liberacaoAntiga = await instancia.releaseEntryClaim(ttl.claimId!);
  const aindaAtivo = (await outro.listActiveClaims()).filter((c) => c.mint === "ExpiraMint333333").length;
  checar(
    "o dono ANTIGO não libera o claim do novo (senão dois entrariam no mesmo mint)",
    liberacaoAntiga === false && aindaAtivo === 1,
    `liberação antiga=${liberacaoAntiga}, claims ativos no mint=${aindaAtivo}`
  );
  checar("o dono atual libera normalmente", (await outro.releaseEntryClaim(retomado.claimId!)) === true, `claim_id ${retomado.claimId!.slice(0, 8)}…`);

  // ---- ESPELHO --------------------------------------------------------------------------------
  const agora = new Date().toISOString();
  const posOk = await instancia.mirrorPosition({
    id: "pos-self", token: "SELF", mint, sizeSol: 0.01, entryPrice: 1, currentPrice: 1, pnlPercent: 0,
    status: "open", stopLossPercent: -20, takeProfitPercent: 20, trailingStopActive: false,
    trailingStopOffsetPercent: 3, highestPrice: 1, timeOpened: agora, mode: "paper",
  } as any);
  await instancia.mirrorPosition({ id: "pos-self", token: "SELF", mint, sizeSol: 0.01, entryPrice: 1, currentPrice: 1.5, pnlPercent: 50, status: "closed", stopLossPercent: -20, takeProfitPercent: 20, trailingStopActive: false, trailingStopOffsetPercent: 3, highestPrice: 1.5, timeOpened: agora, timeClosed: agora, mode: "paper" } as any);
  const tradeOk = await instancia.mirrorTrade({ id: "tr-self", mint, status: "paper", mode: "paper", time: agora } as any);
  await instancia.mirrorIntent({ id: "int-self", mint, side: "entry", state: "signed", attempt: 1, createdAt: agora, updatedAt: agora } as any);
  await instancia.mirrorLog({ level: "CRITICAL", component: "SELFTEST", message: "log crítico espelhado" });
  const ignorado = await instancia.mirrorLog({ level: "INFO", component: "SELFTEST", message: "info não sobe no default" });
  const counts = await instancia.counts();
  checar(
    "espelho grava e faz upsert (posição continua UMA linha)",
    posOk && tradeOk && counts.positions === 1 && counts.trades === 1 && counts.intents === 1,
    `posições=${counts.positions} trades=${counts.trades} intenções=${counts.intents} logs=${counts.logs}`
  );
  checar("filtro de log no adaptador (INFO não sobe no default)", ignorado === false && counts.logs === 1, `logs no banco=${counts.logs}`);

  const doBanco = await instancia.fetchTrades({ mode: "paper", limit: 10 });
  checar("histórico lido do banco preserva o modo", doBanco.length === 1 && (doBanco[0] as any).mode === "paper", `${doBanco.length} trade lido`);

  // ---- A GARANTIA BASE: ÍNDICE ÚNICO PARCIAL ----------------------------------------------------
  const indice = await conexao.query(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'entry_claims' AND indexname = 'entry_claims_active_unique'`
  );
  checar(
    "o banco enforça o voo único por ÍNDICE ÚNICO PARCIAL (não por 'checagem antes de inserir')",
    indice.rows.length === 1 && /UNIQUE/.test(indice.rows[0].indexdef) && /WHERE .*active/.test(indice.rows[0].indexdef),
    indice.rows[0]?.indexdef ?? "índice ausente"
  );
  let violou = false;
  try {
    // Inserção crua, por fora do adaptador: se o índice não enforçasse, esta linha passaria.
    await conexao.query(
      `INSERT INTO entry_claims (claim_id, mint, side, owner, state, expires_at, payload)
       VALUES ('cru-1', $1, 'entry', 'invasor#1', 'active', now() + interval '300 seconds', '{}'::jsonb)`,
      [mint]
    );
  } catch (err: any) {
    violou = /duplicate key|unique/i.test(err?.message ?? "");
  }
  checar("insert cru concorrente é REJEITADO pelo banco", violou, violou ? "duplicate key (constraint ativa)" : "o banco ACEITOU dois claims ativos — proteção inexistente!");

  // ---- BANCO CAI --------------------------------------------------------------------------------
  const quebrado = {
    query: async () => {
      throw new Error("connection terminated unexpectedly");
    },
    end: async () => undefined,
  };
  const offline = new PostgresStorage(quebrado as any, policy, "selftest#3");
  const healthOffline = await offline.initialize();
  const guardaDepois = await offline.claimEntry({ mint, side: "entry" });
  checar(
    "banco fora do ar ⇒ health 'desconectado' e claim 'banco-indisponivel' (nunca 'livre')",
    healthOffline.connected === false && guardaDepois.acquired === false && guardaDepois.reason === "banco-indisponivel",
    `${guardaDepois.reason}: ${guardaDepois.detail}`
  );

  await instancia.close();
  await servidor.stop();
  await db.close();

  const falhas = resultados.filter((r) => !r.ok).length;
  console.log(`\n${falhas === 0 ? "🏆" : "💥"} ${resultados.length - falhas}/${resultados.length} verificações passaram`);
  console.log(
    "NOTA DE ESCOPO: aqui o Postgres é local (WASM). O caminho de rede do provedor (Neon/Supabase, " +
      "TLS, pooler, limites) só é validado contra o banco real — `npm run storage:check`."
  );
  return falhas === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[selftest] erro inesperado: ${err?.message ?? err}`);
    process.exit(2);
  });
