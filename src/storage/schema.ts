/**
 * SCHEMA DO POSTGRES (S10) — DDL versionada, idempotente e auditável.
 *
 * ## O que faz
 *
 * Define as tabelas que dão ao bot o que o arquivo JSON **não pode** dar: (1) VOO ÚNICO ENTRE
 * PROCESSOS (duas instâncias na mesma carteira não podem assinar a mesma entrada) e (2) histórico
 * além do teto de memória do arquivo local (50 trades no JSON — pouco para validar estratégia).
 *
 * ## Decisões de modelagem (e o motivo de cada uma)
 *
 * 1. **`payload JSONB` + colunas de índice.** Cada linha guarda o registro COMPLETO em `payload` e
 *    promove a colunas só os campos que são consultados/agregados. Consequência: adicionar um campo
 *    no TypeScript nunca exige migração, e nada se perde por o schema não conhecer o campo. A
 *    alternativa (coluna para cada campo) transforma cada evolução do app numa migração — e a
 *    primeira migração esquecida vira perda de dado em produção.
 * 2. **Voo único por ÍNDICE ÚNICO PARCIAL, não por advisory lock.** `WHERE state = 'active'` num
 *    índice único é atômico, não depende de afinidade de sessão (advisory lock exige a mesma
 *    conexão) e sobrevive a pool de conexões. Um lock de sessão "segurado" num pool é uma armadilha
 *    clássica: a conexão volta ao pool e o lock continua preso.
 * 3. **Claims com TTL.** Um processo que morre no meio deixa o claim ativo. Sem expiração, o bot
 *    ficaria bloqueado para sempre por causa de um crash — "fail-closed" não pode virar
 *    "permanentemente quebrado". `expires_at` permite retomada atômica por outro processo.
 * 4. **`updated_at`/`acquired_at` com `now()` do BANCO**, não do cliente: relógio de processo
 *    errado não pode corromper a contabilidade de tempo (e as duas instâncias usam a mesma régua).
 *
 * ## Dependências
 *
 * Nenhuma em runtime: este módulo é DADO e texto SQL. O cliente (`pg`) é injetado pelo adaptador.
 *
 * ## Riscos
 *
 * 1. `CREATE INDEX IF NOT EXISTS` é idempotente, mas migração com DDL destrutivo NÃO existe aqui de
 *    propósito: nada neste arquivo apaga tabela ou coluna. Evolução de schema é sempre aditiva.
 * 2. O schema é pequeno de propósito. Tabela que ninguém consulta é passivo, não garantia.
 *
 * ## Como testar
 *
 * Grupo [29] de `npm run test` roda este SQL contra um Postgres REAL (PGlite, WASM): aplica duas
 * vezes (idempotência), testa o índice único parcial do claim, a expiração e a retomada.
 *
 * ## Como colocar em produção
 *
 * `npm run storage:migrate` (idempotente) e depois `HFT_STORAGE=postgres` + `DATABASE_URL`.
 */

/**
 * Versão do schema. Incrementar SÓ quando houver nova migração aditiva; o runner aplica em ordem e
 * registra a versão, então um banco antigo é atualizado sem intervenção manual.
 */
export const SCHEMA_VERSION = 1;

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

/**
 * Migrações em ordem. Regra: nunca remover nem reescrever uma migração já publicada — um ambiente
 * que já a aplicou não a roda de novo, e dois ambientes com histories diferentes seriam
 * indistinguíveis. Correção de schema entra como migração NOVA.
 */
export const MIGRATIONS: readonly Migration[] = Object.freeze([
  {
    version: 1,
    name: "estrutura inicial: posições, trades, intenções, claims de entrada e logs de decisão",
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version     INTEGER PRIMARY KEY,
         name        TEXT NOT NULL,
         applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,

      `CREATE TABLE IF NOT EXISTS positions (
         id                  TEXT PRIMARY KEY,
         mint                TEXT NOT NULL,
         token               TEXT,
         mode                TEXT,
         status              TEXT NOT NULL,
         size_sol            DOUBLE PRECISION,
         entry_price         DOUBLE PRECISION,
         current_price       DOUBLE PRECISION,
         pnl_percent         DOUBLE PRECISION,
         time_opened         TIMESTAMPTZ,
         time_closed         TIMESTAMPTZ,
         exit_attempts       INTEGER,
         last_exit_error     TEXT,
         execution_intent_id TEXT,
         payload             JSONB NOT NULL,
         updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS positions_mint_idx ON positions (mint)`,
      `CREATE INDEX IF NOT EXISTS positions_status_idx ON positions (status)`,
      `CREATE INDEX IF NOT EXISTS positions_closed_idx ON positions (time_closed DESC NULLS LAST)`,

      `CREATE TABLE IF NOT EXISTS trades (
         id                TEXT PRIMARY KEY,
         mint              TEXT NOT NULL,
         token             TEXT,
         status            TEXT NOT NULL,
         mode              TEXT,
         signature         TEXT,
         pnl_net_sol       DOUBLE PRECISION,
         fees_sol          DOUBLE PRECISION,
         slippage_bps      DOUBLE PRECISION,
         measured_on_chain BOOLEAN NOT NULL DEFAULT false,
         traded_at         TIMESTAMPTZ,
         payload           JSONB NOT NULL,
         updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      `CREATE INDEX IF NOT EXISTS trades_mint_idx ON trades (mint)`,
      `CREATE INDEX IF NOT EXISTS trades_mode_status_idx ON trades (mode, status)`,
      `CREATE INDEX IF NOT EXISTS trades_traded_at_idx ON trades (traded_at DESC NULLS LAST)`,

      `CREATE TABLE IF NOT EXISTS intents (
         id                    TEXT PRIMARY KEY,
         position_id           TEXT,
         mint                  TEXT NOT NULL,
         side                  TEXT NOT NULL,
         state                 TEXT NOT NULL,
         attempt               INTEGER,
         signature             TEXT,
         last_valid_block_height BIGINT,
         updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
         payload               JSONB NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS intents_state_idx ON intents (state)`,
      `CREATE INDEX IF NOT EXISTS intents_position_idx ON intents (position_id)`,
      /**
       * ÚNICA RESTRIÇÃO QUE IMPEDE DOIS PROCESSOS DE COMPRAREM O MESMO TOKEN AO MESMO TEMPO.
       * Índice único PARCIAL: só linhas `active` competem; claims liberados/expirados não bloqueiam
       * nada. É por isto que o claim é uma linha, e não um "campo" na posição.
       */
      `CREATE TABLE IF NOT EXISTS entry_claims (
         claim_id    TEXT PRIMARY KEY,
         mint        TEXT NOT NULL,
         side        TEXT NOT NULL,
         owner       TEXT NOT NULL,
         state       TEXT NOT NULL,
         acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         expires_at  TIMESTAMPTZ NOT NULL,
         released_at TIMESTAMPTZ,
         payload     JSONB
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS entry_claims_active_unique
         ON entry_claims (mint, side) WHERE state = 'active'`,
      `CREATE INDEX IF NOT EXISTS entry_claims_mint_idx ON entry_claims (mint, side)`,

      `CREATE TABLE IF NOT EXISTS decision_logs (
         id          BIGSERIAL PRIMARY KEY,
         level       TEXT NOT NULL,
         component   TEXT NOT NULL,
         message     TEXT NOT NULL,
         correlation TEXT,
         logged_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
         payload     JSONB
       )`,
      `CREATE INDEX IF NOT EXISTS decision_logs_logged_at_idx ON decision_logs (logged_at DESC)`,
      `CREATE INDEX IF NOT EXISTS decision_logs_level_idx ON decision_logs (level)`,
    ],
  },
]);

/** Todas as migrações, concatenadas — usado pelos scripts para conferir o SQL sem rodar. */
export function allStatements(): string[] {
  return MIGRATIONS.flatMap((m) => m.statements);
}
