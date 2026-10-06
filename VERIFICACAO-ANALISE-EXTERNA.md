# Verificação da análise externa (Claude) — Bot Sniper Solana

**Data:** 2026-10-02
**Pergunta:** "Essa é a análise do Claude, confere?"
**Método:** cada afirmação foi testada contra o código original (`b6df555`), contra execução real de biblioteca e contra documentação oficial. Nenhuma afirmação foi aceita por plausibilidade.

> **Veredito geral: a análise está tecnicamente correta em praticamente tudo, é criteriosa na separação entre fato e memória, e identifica o problema central com precisão.** Encontrei **uma inversão factual** (zeroização), **um número não reproduzível** ("161 ocorrências") e **imprecisão em uma citação de endereço**. Também encontrei um problema que ela **deixou passar** — e que se revelou real no banco de dados.

---

## 1. O que confere (verificado com execução)

### 1.1 O diagnóstico central está certo

| Afirmação | Veredito | Evidência |
|---|---|---|
| A "assinatura" é sobre string de texto, não transação | ✅ **Confirmado** | `server.ts` original ~2150: `new TextEncoder().encode("Snipe transaction for ${tokenMint}...")` |
| Landed vem de `Math.random() > 0.05` | ✅ **Confirmado** | linha 2362 original, verbatim |
| Bloco, latência e preço de entrada aleatórios | ✅ **Confirmado** | `278913000 + Math.floor(Math.random()*5000)`, `0.000003 + Math.random()*0.000004` |
| Nenhuma instrução de compra chega à rede | ✅ **Confirmado** | `submitBundle` só é chamado nos 2 caminhos de saída |
| Posições registradas com preço sorteado | ✅ **Confirmado** | posição criada no daemon com `entryPrice` aleatório |

### 1.2 `/api/submit-bundle` é inteiramente falso — confirmado verbatim

Ele descreveu com precisão, inclusive o detalhe do "rug". Código original:

```ts
let landStatus: "Landed" | "Reverted" | "Dropped" = "Landed";
if (tipAmount < 0.001) { landStatus = "Dropped"; }
else if (tokenMint && (tokenMint.toLowerCase().includes("rug") || tokenMint.startsWith("1111"))) {
  landStatus = "Reverted";
}
```

O `bundleId` é `bundle_jito_${Math.random().toString(36)...}`. **Confere integralmente.**

### 1.3 P0-2 — tip accounts fabricados: confirmado com medição exata

Eu decodifiquei os 4 endereços em execução:

| Endereço no código | bytes | `new PublicKey()` |
|---|---|---|
| `Cw8CFBTGowau99vVnKAhZAsfS6D1g6A7B2Xz11G1Zabz` | 32 | OK |
| `96gYZGLnJYVFihjz7mZge1L97McJ79S9Aabbb3BE` | **29** | ❌ `Invalid public key input` |
| `HFqU5x63VTgdaLLwt7Wb97F7tG2S3zD7F64848Z1` | **30** | ❌ `Invalid public key input` |
| `ADa6ZsCtf7vD8W9zFda987AsDGaC8aBca8A9Zda` | **29** | ❌ `Invalid public key input` |

Com `Date.now() % 4` escolhendo o índice, **~75% dos envios lançam exceção antes de chegar ao Jito**. A estimativa dele está correta.

**Correção de uma imprecisão na citação dele:** ele escreveu "o quarto endereço (NY) tem 32 bytes mas não é uma conta de tip legítima (Cw8CFyM9…)". O endereço **no código** é `Cw8CFBTGowau99vVnKAhZAsfS6D1g6A7B2Xz11G1Zabz`; `Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY` é o endereço **oficial** do Jito. Ele citou o oficial ao descrever o fabricado. O mérito está certo — e o detalhe é revelador: os dois começam com `Cw8CF`, ou seja, é um **endereço sósia** (mesmo prefixo de vaidade, resto inventado). É exatamente o padrão que quebra validação por prefixo.

### 1.4 P1 — `LaunchSwapper`: confirmado, inclusive o cálculo de bytes

A descrição dele ("os últimos 5 bytes batem, os 3 primeiros não") é **matematicamente precisa**:

```
valor no código : 16927863322537033481 = 0xeaebda01122eff09
bytes wire (LE) : 09 ff 2e 12 01 da eb ea
correto         : 66 06 3d 12 01 da eb ea
                  ^^^^^^ diferença    ^^^^^^^^^^^^^^^ idêntico (5 bytes)
```

Também confirmei o endereço com caractere inválido:
```
"C7S8bAaCb7129A09bBC71a81289Acb1129A"
  → caractere fora de base58: ['0']  → Non-base58 character
```
E a capitalização do sysvar: `SysVarRent...` (código) vs `SysvarRent...` (correto). Ambos decodificam para 32 bytes válidos — o errado só falha em execução. Confirma o ponto dele.

### 1.5 P0-6 — "configurar o Geyser desliga toda a ingestão": excelente achado

```ts
if (this.grpcUrl) { this.connectRealGrpc(); }   // só imprime log
else { await this.connectWebsocketFallback(); } // nunca executado se grpcUrl existir
```

**Confirmado.** Definir `GEYSER_GRPC_URL` fazia `connectRealGrpc()` apenas imprimir uma linha e **nunca** caía no fallback. Um operador configurando o gRPC (que é o caminho recomendado) desligava a detecção por completo. Este é um achado que eu não havia isolado com esse ângulo — bons olhos.

Também confirmei: mint extraído = primeira chave ≠ WSOL/programa (na prática o fee payer), filtro `"create"` casando com logs de ATA/Token, e `grpcLatencyMs: 1.2`/`0.95` hardcoded.

### 1.6 Segurança — confirmado, incluindo o ponto mais importante

**"O 'KMS' é AES-GCM em RAM, mas o sessionKey mora no mesmo processo que o ciphertext, e a chave privada original continua em texto puro em `process.env`."** ✅ **Confirmado.** Esta é a crítica mais bem calibrada da análise: o nome "KMS" promete uma garantia que o código não entrega, e isso faz o operador alocar capital acima do prudente. Eu já havia corrigido a nomenclatura; reforcei com `describeKeyCustody()` declarando explicitamente `protectedAgainstProcessAccess: false`.

Também confirmados: chave aleatória silenciosa (`:63`/`:79`), `readOnlyMode` não bloqueia assinatura (corrigido — gate único em 1 call site), LLM sobrescrevendo `score`/`isRug` (`{...parsedOnChain, ...parsed}`), `uncaughtException` engolida, ausência de `.gitignore`.

### 1.7 Persistência e testes — confirmado

`health: "EXCELLENT"` e `writeLatencyMs: 0.12` **são constantes hardcoded**. A rotação mantém **15 entradas** e `bytesSaved = removedCount * 180` é estimativa. O teste imprime "10/10" com 4 testes reais, dois deles reimplementando a lógica localmente. Tudo verificado no código.

### 1.8 O que ele disse que está bom — concordo

`exitLocks` + `exit_pending`, escrita atômica com `.bak`, kill switch persistido, slippage adaptativo com teto, separação de carteiras por papel. São escolhas de arquitetura corretas.

---

## 2. O que **não** confere

### 2.1 ❌ Zeroização: a análise está **invertida**

Ele afirmou:

> "Testei em execução: `Keypair.secretKey` devolve uma **cópia**, então `zeroizeBuffer(opKp.secretKey)` na inicialização **não zera nada**. Já em `executeWithDecryptedKeypair`, zerar o buffer de entrada funciona nesta versão do web3.js, porque `fromSecretKey` guarda a referência."

Executei o teste:

```
secretKey é a MESMA referência interna? SIM (referência) -> zeroizeBuffer DESTRÓI o keypair
fromSecretKey guarda referência? SIM
```

**Na versão instalada de `@solana/web3.js`, `Keypair.secretKey` devolve a referência interna** — `fill(0)` destrói o keypair (não é no-op). E `fromSecretKey` de fato guarda a referência, como ele disse. Ou seja: **ele acertou metade e inverteu a outra metade.** O mecanismo que ele descreveu como ineficaz é justamente o que funciona.

**Onde ele está certo no espírito:** a conclusão geral dele — "é um mérito pontual, mas não sustenta a narrativa de RAM wipe" — **é correta e eu a endosso**. `Buffer.fill(0)` não garante remoção de cópias sob o GC, `global.gc()` é no-op sem `--expose-gc`, e nada disso protege contra dump de memória. Corrigi o comentário de `zeroizeBuffer()` para documentar exatamente o que a função faz e não faz, em vez de alegar "eliminated side-channel RAM trace leakage".

**Lição prática:** a mutação tem efeito colateral perigoso. Zerar `kp.secretKey` **destrói** o keypair — por isso o código guarda apenas o `PublicKey` em cache e re-deriva o keypair do ciphertext em cada assinatura. Está correto, mas por um motivo diferente do que ele supôs.

### 2.2 ⚠️ "161 ocorrências de simulação/mock/fallback" — não reproduzível

Nenhuma contagem razoável chega a 161 no `server.ts` original (2814 linhas):

| Padrão | Ocorrências |
|---|---|
| `simulat*` \| `mock` (case-insensitive) | **82** |
| `simulat*` \| `mock` \| `fallback` \| `simulad` \| `simula` | **116** |
| `Math.random()` (para escala) | **96** |

O número depende inteiramente da definição, e ele não a informou. **Recomendação: não use "161" em nenhum documento.** Use os valores verificáveis: 82 ocorrências de `simulat*/mock`, 96 chamadas de `Math.random()`.

### 2.3 ⚠️ `isRealOnChain: true` — correto no mérito, superestimado no escopo

Ele escreveu "Eventos reais são marcados com `isRealOnChain: true` mesmo com campos sorteados". A string aparece **exatamente 2 vezes** no arquivo original: linha 1375 (`false`) e linha 2736 (`true`). O ponto vale para o evento do daemon (linha 2736, com `jsonRpcLatencyMs`, `savedComputeUnits` e `rawProtobufHex` sorteados), mas "eventos" no plural sugere um padrão disseminado que não existe. Detalhe menor, mas em auditoria de segurança a contagem importa.

---

## 3. O que a análise **deixou passar** — e que se provou real

Ele elogiou o `exitLocks` + `exit_pending` como "a abordagem certa". A abordagem **é** certa, mas falta uma peça: **não existia reconciliador**. `exit_pending` era escrito em `server.ts:574` e `:3090`, guardado em `:568` e `:3083`, e **nunca revertido em caso de morte do processo**.

Consequência: qualquer liquidação interrompida (deploy, OOM, `SIGKILL`, kill switch no meio do caminho) deixava a posição presa para sempre — todo `POST /api/positions/close` respondia 409, e o lock em memória desaparecia no restart.

**Prova empírica:** ao subir o servidor com o reconciliador novo, ele encontrou no banco operacional real:

```
[Risk Engine] 3 posição(ões) reconciliada(s) de EXIT_PENDING para OPEN.
```

**Três posições estavam presas.** Não é hipótese — o bug já tinha se materializado nos seus dados. Implementei `reconcileStuckExits()`, executado no boot antes de retomar a gestão de risco.

Este é o único achado relevante que a análise do Claude não cobriu. Todo o resto dela eu confirmei, e ela ainda isolou um problema (Geyser desligando a ingestão) que eu não havia destacado.

---

## 4. Sobre o plano recomendado

A ordem proposta está correta e é praticamente a que segui:

| Passo dele | Situação |
|---|---|
| 1. Parar a falsificação (P0-1) | ✅ feito — falha de saída não grava mais sucesso |
| 2. Marcar tudo que é simulado | ✅ feito — `mode: "paper"`, `status: "paper"`, `measuredOnChain`, banner explícito |
| 3. Autenticação em `/api/*` + bind local | ✅ feito — `ADMIN_TOKEN` fail-closed em produção (bind em 127.0.0.1 é decisão de deploy, não de código) |
| 4. Corrigir rota de saída | ✅ feito — tip na mesma decisão, `getTipAccounts`, `encoding: "base64"`, saldo on-chain exigido |
| 5. Construir a entrada de verdade em dry-run | ⏳ **não feito — e é deliberado.** O daemon recusa executar em modo live porque não há caminho de compra verificado. Recusar é melhor que simular |
| 6. Medir latência de verdade | ⏳ parcial — cache de blockhash e RTT de RPC medidos; falta instrumentação ponta a ponta |
| 7. Backtest/replay | ⏳ não feito |

**Uma discordância técnica:** ele recomenda "tip dentro da tx do swap". Concordo que é o padrão correto e mais robusto, mas o fallback atual usa tx de tip separada com o **mesmo** blockhash — que é a mitigação que a doc do Jito exige para o caso separado. Manter a tx separada preserva a capacidade de o swap ser uma `VersionedTransaction` da Jupiter (que já tem seu próprio conjunto de signatários). É uma trade-off, não um erro — vale revisitar quando o builder nativo existir.

**Sobre "bind em 127.0.0.1 por padrão":** concordo como princípio, mas neste ambiente o servidor precisa escutar em `0.0.0.0` para o preview funcionar. A mitigação correta é `ADMIN_TOKEN` obrigatório + firewall/reverse proxy — que é o que foi feito.

---

## 5. Resumo da verificação

| Categoria | Quantidade |
|---|---|
| Afirmações confirmadas com evidência | **31** |
| Correções factuais necessárias | **1** (zeroização — invertida) |
| Números não reproduzíveis | **1** ("161") |
| Imprecisões de citação | **1** (endereço sósia do Jito) |
| Achados dela que eu não tinha isolado | **2** (Geyser desliga ingestão; crítica ao nome "KMS") |
| Achados meus que ela deixou passar | **1** (reconciliador de `exit_pending` — provado real no banco) |

**Confiança no conjunto:** alta. A análise é honesta, conservadora onde não tinha evidência (ele escreveu explicitamente "não tenho evidência do estado atual dos hosts antigos" e "confirme na doc" duas vezes) e acertou o diagnóstico central. As divergências são de detalhe, não de direção — e a única inversão factual (zeroização) não muda a conclusão dele, porque a conclusão certa é a mais cética: **isto não é RAM wipe e não é KMS.**

---

## 6. Ação imediata

Nada na análise muda a recomendação anterior: **não operar capital real.**

A sequência segura é a mesma que o plano dele propõe, com uma correção de prioridade: antes de "construir a entrada de verdade", é preciso existir **medição** (passo 6) e **replay** (passo 7) — caso contrário repetiremos o erro atual com código novo: confundir movimento de preço com edge.
