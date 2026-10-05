/**
 * MIGRAÇÃO E VERIFICAÇÃO DO POSTGRES (S10) — dois modos, um script.
 *
 * ## O que faz
 *
 * - `npm run storage:migrate` — aplica as migrações pendentes (idempotente, só aditivas) e imprime
 *   o que foi aplicado, a versão final do schema e as contagens por tabela;
 * - `npm run storage:check` — **somente leitura**: conecta, verifica se o schema está na versão
 *   esperada, conta registros, lista claims ativos e diz se o bot está autorizado a assinar
 *   (`entryGuard`). Sai com código 1 se o banco não estiver pronto para operar.
 *
 * ## Como funciona
 *
 * Usa exatamente os mesmos módulos do runtime (`resolveStoragePolicy`, `PostgresStorage`, `schema`),
 * com o MESMO cliente (`pg`, carregado sob demanda). Isso importa: um script que migra "por fora"
 * pode deixar o banco num estado que o runtime não reconhece — aqui, se este script diz OK, o
 * runtime vê o mesmo.
 *
 * ## Dependências
 *
 * - `DATABASE_URL` com uma connection string de Postgres (Neon/Supabase free servem; SQLite não).
 * - `HFT_STORAGE` NÃO precisa estar `postgres`: estes scripts operam o banco sob demanda, sem ligar
 *   o modo de produção. Isso permite preparar/migrar o banco ANTES de virar o bot para ele.
 *
 * ## Riscos
 *
 * - `storage:migrate` altera o schema (aditivamente). Nunca há `DROP`/`TRUNCATE` neste schema —
 *   migração destrutiva não existe por decisão, e o teste `[29]` falha se alguém introduzir uma.
 * - Rodar `migrate` em duas máquinas ao mesmo tempo é seguro: as migrações são transacionais e a
 *   versão aplicada é a chave primária, então a segunda é um no-op (testado).
 * - A connection string NUNCA é impressa: `redactDatabaseUrl` preserva só host/porta/base.
 *
 * ## Como testar
 *
 * ```bash
 * npm run storage:check            # antes de migrar: deve falhar dizendo que o schema está atrás
 * npm run storage:migrate          # aplica a v1
 * npm run storage:check            # agora deve dizer ready
 * ```
 *
 * ## Como colocar em produção
 *
 * Rode `storage:check` como passo de deploy (health gate) e `storage:migrate` numa etapa de
 * release — nunca no caminho de boot quente se o banco puder estar indisponível na hora do deploy.
 * O boot do bot também migra (fail-closed), mas ter o passo separado deixa o log do banco fora do
 * log do bot.
 */

import {
  PostgresStorage,
  decideEntryStorageGuard,
  describeStoragePolicy,
  loadPgClient,
  resolveStoragePolicy,
} from "../src/storage/postgresStorage.js";
import { SCHEMA_VERSION } from "../src/storage/schema.js";

/**
 * Redige a connection string preservando o que serve para diagnóstico (host/porta/base) e
 * escondendo a credencial. Regra do projeto: log nunca expõe segredo — e uma URL de banco é
 * segredo completo (usuário + senha + host = acesso total aos dados).
 */
function redactDatabaseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = "***";
    if (u.username) u.username = u.username.slice(0, 3) + "***";
    return u.toString();
  } catch {
    return "<url inválida>";
  }
}

async function main(): Promise<number> {
  const modo = process.argv.includes("--check") ? "check" : "migrate";
  const policy = resolveStoragePolicy();
  const url = (process.env.DATABASE_URL ?? "").trim();

  console.log(`[storage:${modo}] DATABASE_URL=${url ? redactDatabaseUrl(url) : "AUSENTE"}`);
  console.log(`[storage:${modo}] HFT_STORAGE=${policy.mode} (estes scripts não dependem do modo de produção)`);
  for (const note of describeStoragePolicy(policy)) console.log(`[storage:${modo}] política: ${note}`);

  if (!url) {
    console.error(
      `[storage:${modo}][FATAL] DATABASE_URL ausente. Nenhum banco foi tocado. ` +
        `Defina a connection string (ex.: Neon/Supabase free) e rode de novo.`
    );
    return 1;
  }

  const client = await loadPgClient(url);
  const storage = new PostgresStorage(client, policy);

  try {
    const inicial = await storage.initialize();
    if (!inicial.connected) {
      console.error(
        `[storage:${modo}][FATAL] banco inacessível: ${inicial.lastError ?? "erro desconhecido"}. ` +
          `Nada foi alterado. Verifique a URL, o IP allowlist e se o banco está de pé.`
      );
      return 1;
    }
    console.log(
      `[storage:${modo}] conectado. schema atual: ${inicial.schemaVersion ?? "nenhum (banco novo)"} ` +
        `(esperado: ${SCHEMA_VERSION})`
    );

    if (modo === "migrate") {
      const res = await storage.migrate();
      if (res.applied.length > 0) {
        console.log(`[storage:${modo}] migrações aplicadas: [${res.applied.join(", ")}]`);
      } else {
        console.log(`[storage:${modo}] nada a aplicar (já em v${res.alreadyAt ?? SCHEMA_VERSION}) — idempotente`);
      }
    }

    const health = storage.health();
    const counts = await storage.counts();
    const claims = await storage.listActiveClaims();
    const guard = decideEntryStorageGuard(policy, {
      configured: health.configured,
      connected: health.connected,
      migrated: health.migrated,
      schemaVersion: health.schemaVersion,
      lastError: health.lastError,
    });

    console.log(
      `[storage:${modo}] v${health.schemaVersion ?? "?"} · ` +
        `trades=${counts.trades} posições=${counts.positions} intenções=${counts.intents} ` +
        `logs=${counts.logs} claimsAtivos=${counts.activeClaims}`
    );
    for (const c of claims) {
      console.log(
        `[storage:${modo}] claim ${c.claimId.slice(0, 8)}… mint=${c.mint} lado=${c.side} ` +
          `dono=${c.owner} expira=${c.expiresAt}${c.expired ? " (EXPIRADO — será retomado no próximo claim)" : ""}`
      );
    }
    console.log(
      `[storage:${modo}] guarda de entrada: allowSign=${guard.allowSign}` +
        `${guard.code ? ` code=${guard.code}` : ""} — ${guard.detail}`
    );

    if (!health.migrated) {
      console.error(
        `[storage:${modo}][FALHA] schema em v${health.schemaVersion ?? "?"} < ${SCHEMA_VERSION}. ` +
          `Rode: npm run storage:migrate`
      );
      return 1;
    }

    console.log(
      `[storage:${modo}] OK. ` +
        (policy.mode === "postgres"
          ? "HFT_STORAGE=postgres está ativo: o voo único vale ENTRE processos."
          : "HFT_STORAGE≠postgres: o banco está pronto, mas o bot ainda usa JSON " +
            "(voo único POR PROCESSO). Ligue HFT_STORAGE=postgres para usá-lo.")
    );
    return 0;
  } finally {
    // `close` é idempotente e nunca lança: encerrar o script não pode virar erro de saída.
    await storage.close().catch(() => undefined);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Falha inesperada: 2 distingue "banco recusou" de "bug no script" em pipelines de CI.
    console.error(`[storage] erro inesperado: ${err?.message ?? err}`);
    process.exit(2);
  });
