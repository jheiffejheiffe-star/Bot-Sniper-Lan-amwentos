import { useState, useEffect } from "react";
import { 
  Rocket, 
  Layers, 
  CheckCircle2, 
  Percent, 
  Key, 
  Award,
  RefreshCw,
  FileText,
  ArrowRight,
  Shield,
  Check,
  X,
  Lock,
  Unlock,
  Play,
  Square,
  Activity,
  Sliders,
  Zap
} from "lucide-react";

interface Stage {
  id: number;
  name: string;
  capital: string;
  strategy: string;
  objective: string;
  capitalVal: number;
  duration: string;
}

export function GoLiveManual() {
  const [activeStage, setActiveStage] = useState<number>(1);
  const [totalCapital, setTotalCapital] = useState<number>(2000); // USD
  const [solPrice] = useState<number>(150); // Fixed SOL/USD rate for conversion
  const [lotPercent, setLotPercent] = useState<number>(1.5); // 1.5% lot size
  const [keypairsCount, setKeypairsCount] = useState<number>(8); // 8 Hot Wallets
  
  // Wallet rotation simulator states
  const [isRotating, setIsRotating] = useState(false);
  const [activeWalletIndex, setActiveWalletIndex] = useState(0);
  const [rotationLogs, setRotationLogs] = useState<string[]>([
    "[INFO] Subsistema de Múltiplas Hot Wallets inicializado.",
    "[INFO] Prontidão de chaves: 8 pares carregados com assinaturas Ed25519 em cache de RAM.",
    "[STATUS] Wallets rotacionadas periodicamente para ofuscar padrões de concorrência."
  ]);

  // 16 Go Live Checklist States
  const [checklistPRR, setChecklistPRR] = useState<number>(96); // Goal: >= 95%
  const [checklistShadowMode, setChecklistShadowMode] = useState<boolean>(true); // Goal: true (approved)
  const [checklistSignals, setChecklistSignals] = useState<number>(1142); // Goal: >= 1000
  const [checklistProfitFactor, setChecklistProfitFactor] = useState<number>(2.14); // Goal: >= 1.8
  const [checklistExpectancy, setChecklistExpectancy] = useState<number>(0.18); // Goal: > 0 (Positive)
  const [checklistDrawdown, setChecklistDrawdown] = useState<number>(2.85); // Goal: <= 5.0%
  const [checklistLatency, setChecklistLatency] = useState<number>(142); // Goal: < 150ms
  const [checklistRpcHealthy, setChecklistRpcHealthy] = useState<boolean>(true); // Goal: true
  const [checklistGeyserConnected, setChecklistGeyserConnected] = useState<boolean>(true); // Goal: true
  const [checklistJitoConnected, setChecklistJitoConnected] = useState<boolean>(true); // Goal: true
  const [checklistWalletLoaded, setChecklistWalletLoaded] = useState<boolean>(true); // Goal: true
  const [checklistWalletBalance, setChecklistWalletBalance] = useState<number>(18.5); // Goal: >= 5.0 SOL
  const [checklistKillSwitchOperational, setChecklistKillSwitchOperational] = useState<boolean>(true); // Goal: true
  const [checklistCircuitBreakersActive, setChecklistCircuitBreakersActive] = useState<boolean>(true); // Goal: true
  const [checklistDbHealthy, setChecklistDbHealthy] = useState<boolean>(true); // Goal: true (Banco íntegro)
  const [checklistObservabilityActive, setChecklistObservabilityActive] = useState<boolean>(true); // Goal: true

  // Mainnet promotion simulator states
  const [isLivePromoted, setIsLivePromoted] = useState<boolean>(false);
  const [isPromotingChecklist, setIsPromotingChecklist] = useState<boolean>(false);
  const [promoLogs, setPromoLogs] = useState<string[]>([]);

  // ETAPA 13 — Homologação em Mainnet (capital mínimo)
  const [homologationActive, setHomologationActive] = useState<boolean>(false);
  const [tradesCount, setTradesCount] = useState<number>(0);
  const [successfulTrades, setSuccessfulTrades] = useState<number>(0);
  const [jitoLandedCount, setJitoLandedCount] = useState<number>(0);
  const [realPnlSol, setRealPnlSol] = useState<number>(0.0);
  const [killSwitchActive, setKillSwitchActive] = useState<boolean>(false);
  const [circuitBreakerTripped, setCircuitBreakerTripped] = useState<boolean>(false);
  const [dbBackupRecovered, setDbBackupRecovered] = useState<boolean>(false);
  const [homologationLogs, setHomologationLogs] = useState<string[]>([
    "[SISTEMA] Pronto para homologação militar em Mainnet (Capital Mínimo).",
    "[DIRETRIZ] Bateria necessária: 50 a 100 trades reais on-chain para homologação de landing rate.",
    "[REQUISITO] Todos os 16 checks estão validados. Assinatura Ed25519 ativa e cofre KMS pronto."
  ]);
  const [isSimulatingReboot, setIsSimulatingReboot] = useState<boolean>(false);

  // Executar loop de homologação
  useEffect(() => {
    if (!homologationActive || killSwitchActive || circuitBreakerTripped) return;

    const interval = setInterval(() => {
      setTradesCount(prev => {
        const next = prev + 1;
        
        // Randomly pick token and simulate real swap pipeline
        const tokens = ["CHIP", "MIN", "LOW_CAP", "SOL_PUMP", "MEV_PROOF", "JITO_TEST"];
        const t = tokens[Math.floor(Math.random() * tokens.length)];
        const isWin = Math.random() > 0.35; // 65% win rate
        const jitoLanded = Math.random() > 0.02; // 98% landing rate with Jito
        const pnl = isWin ? (0.001 + Math.random() * 0.005) : -(0.001 + Math.random() * 0.003);
        
        const timestamp = new Date().toTimeString().split(' ')[0];
        const txIdComp = Math.random().toString(36).substring(2, 10).toUpperCase();
        const txIdVend = Math.random().toString(36).substring(2, 10).toUpperCase();
        const block = 278912450 + next * 3;

        const newLogs = [
          `[${timestamp}] 🗄️ [SQL DB] Posição removida do banco APÓS a confirmação on-chain do recebimento de ${(0.005 + pnl).toFixed(5)} SOL. Trade encerrado.`,
          `[${timestamp}] 📡 [RPC SOLANA] Venda confirmada no Bloco #${block + 2}. Status: processed. Hash: ${txIdVend}vend...`,
          `[${timestamp}] ⚡ [JITO ENGINE] Enviando Bundle de venda para Jito Block Engine. ID: jito_bundle_${txIdVend}`,
          `[${timestamp}] 🔑 [KMS VAULT] Assinando transação de swap de venda via chave Ed25519 isolada.`,
          `[${timestamp}] 🚨 [AUTO-EXIT] Disparando saída de $${t} (${isWin ? "Take Profit" : "Stop Loss"} disparado: ${(pnl * 100).toFixed(1)}%).`,
          `[${timestamp}] 📈 [MONITOR] Preço monitorado em tempo real via Jupiter Quote API. PnL flutuando...`,
          `[${timestamp}] 🗄️ [SQL DB] Posição aberta e persistida localmente no banco de dados.`,
          `[${timestamp}] 📡 [RPC SOLANA] Compra confirmada no Bloco #${block}. Status: confirmed. Hash: ${txIdComp}comp...`,
          `[${timestamp}] ⚡ [JITO ENGINE] Enviando Bundle privado contendo swap e Jito Tip de 0.003 SOL para o Block Engine. ID: jito_bundle_${txIdComp}`,
          `[${timestamp}] 🔑 [KMS VAULT] Descriptografando e assinando transação no cofre isolado de forma síncrona. RAM zerada após uso.`,
          `[${timestamp}] 🚀 [TRADE #${next}] Iniciando compra de $${t} com 0.005 SOL (Capital Mínimo).`
        ];

        setHomologationLogs(prevLogs => [...newLogs, ...prevLogs].slice(0, 60));
        
        if (jitoLanded) setJitoLandedCount(j => j + 1);
        if (isWin) setSuccessfulTrades(s => s + 1);
        setRealPnlSol(p => {
          const nextPnl = parseFloat((p + pnl).toFixed(5));
          if (nextPnl < -0.05) {
            setCircuitBreakerTripped(true);
            setHomologationActive(false);
            setHomologationLogs(prev => [
              `[${timestamp}] 🚨 [CIRCUIT BREAKER] Limite de segurança atingido! Drawdown superior a 0.05 SOL. Ativação automática do disjuntor de segurança!`,
              ...prev
            ]);
          }
          return nextPnl;
        });

        if (next >= 100) {
          setHomologationActive(false);
          setHomologationLogs(prev => [
            `[${timestamp}] 🎉 [HOMOLOGAÇÃO CONCLUÍDA] Parabéns! Bateria de 100 trades finalizada com 100% de sucesso e conformidade na Mainnet!`,
            ...prev
          ]);
        }

        return next;
      });
    }, 2500);

    return () => clearInterval(interval);
  }, [homologationActive, killSwitchActive, circuitBreakerTripped, realPnlSol]);

  const stages: Stage[] = [
    {
      id: 1,
      name: "Semana 1",
      capital: "~$100",
      capitalVal: 100,
      strategy: "Monitoramento em tempo real (Sem execução real).",
      objective: "Validar latência de detecção e consistência da telemetria off-chain.",
      duration: "Dias 1 - 7"
    },
    {
      id: 2,
      name: "Semana 2",
      capital: "~$500",
      capitalVal: 500,
      strategy: "Oportunidades de baixa competição (LP inicializações rasas).",
      objective: "Testar inclusão real de bundles, taxas de slippage e tempo de resposta.",
      duration: "Dias 8 - 14"
    },
    {
      id: 3,
      name: "Semana 3",
      capital: "~$2.000",
      capitalVal: 2000,
      strategy: "Expansão controlada para tokens de média competição.",
      objective: "Calibrar gorjetas Jito e pesos preditivos do filtro de Inteligência Artificial.",
      duration: "Dias 15 - 21"
    },
    {
      id: 4,
      name: "Semana 4+",
      capital: "Escalonado",
      capitalVal: 5000,
      strategy: "Execução automática completa baseada na performance de win-rate.",
      objective: "Maximizar ROI geral, monitorar stop-outs e escalonar lotes on-chain.",
      duration: "Infinito (Go-Live Total)"
    }
  ];

  // Calculated variables
  const totalCapitalSol = totalCapital / solPrice;
  const lotSizeSol = (totalCapitalSol * (lotPercent / 100));
  const lotSizeUsd = totalCapital * (lotPercent / 100);
  const exposurePerKeypairSol = lotSizeSol / keypairsCount;
  const exposurePerKeypairPercent = (exposurePerKeypairSol / totalCapitalSol) * 100;
  
  const isKeypairRiskAcceptable = exposurePerKeypairPercent < 1.0;

  // Validation for the 16 checks
  const isPrrPass = checklistPRR >= 95;
  const isShadowPass = checklistShadowMode;
  const isSignalsPass = checklistSignals >= 1000;
  const isProfitFactorPass = checklistProfitFactor >= 1.8;
  const isExpectancyPass = checklistExpectancy > 0;
  const isDrawdownPass = checklistDrawdown <= 5.0;
  const isLatencyPass = checklistLatency < 150;
  const isRpcPass = checklistRpcHealthy;
  const isGeyserPass = checklistGeyserConnected;
  const isJitoPass = checklistJitoConnected;
  const isWalletPass = checklistWalletLoaded;
  const isBalancePass = checklistWalletBalance >= 5.0;
  const isKillSwitchPass = checklistKillSwitchOperational;
  const isCircuitBreakerPass = checklistCircuitBreakersActive;
  const isDbPass = checklistDbHealthy;
  const isObservabilityPass = checklistObservabilityActive;

  const passedChecksCount = [
    isPrrPass, isShadowPass, isSignalsPass, isProfitFactorPass,
    isExpectancyPass, isDrawdownPass, isLatencyPass, isRpcPass,
    isGeyserPass, isJitoPass, isWalletPass, isBalancePass,
    isKillSwitchPass, isCircuitBreakerPass, isDbPass, isObservabilityPass
  ].filter(Boolean).length;

  const isGoLiveFullyUnlocked = passedChecksCount === 16;

  const triggerMainnetPromotion = () => {
    if (!isGoLiveFullyUnlocked || isPromotingChecklist || isLivePromoted) return;
    setIsPromotingChecklist(true);
    setPromoLogs([]);

    const steps = [
      "[SYSTEM] INICIANDO SEQUÊNCIA DE PROMOÇÃO DE GO-LIVE MILITAR EM MAINNET...",
      "[AUTH] Validando chaves privadas rotacionadas AES-256-GCM... OK",
      "[INFRA] Ping Jito BlockEngine: " + checklistLatency + "ms. Conexão robusta.",
      "[CHECKLIST] Verificando integridade das 16 regras automáticas de barreira...",
      "  - PRR Score: " + checklistPRR + "% (Mín: 95%) [CONFORME]",
      "  - Shadow Mode: Aprovado [CONFORME]",
      "  - Sinais Válidos: " + checklistSignals + " analisados (Mín: 1000) [CONFORME]",
      "  - Profit Factor: " + checklistProfitFactor + " (Mín: 1.8) [CONFORME]",
      "  - Expectância: " + checklistExpectancy + " SOL/trade [CONFORME]",
      "  - Drawdown: " + checklistDrawdown + "% (Limite: 5.0%) [CONFORME]",
      "  - Latência P99: " + checklistLatency + "ms [CONFORME]",
      "  - Conexão RPC & Geyser & Jito: 100% ONLINE [CONFORME]",
      "  - Hot Wallets: " + keypairsCount + " carregadas com " + checklistWalletBalance + " SOL totais [CONFORME]",
      "  - Kill Switch & Circuit Breakers: OPERACIONAIS [CONFORME]",
      "  - Banco de Dados & Observabilidade: ÍNTEGROS & ATIVOS [CONFORME]",
      "[SECURE] Desengatando travas físicas e desconectando Replay Sandbox...",
      "[PIPELINE] Promovendo processo sniper-engine para prioridade real-time FIFO...",
      "[LIVE] ESCUTA DE POOLS DA SOLANA INICIADA EM MODO REAL ON-CHAIN!",
      "🎉 [SUCCESS] PARABÉNS! ROBÔ ATIVO NA MAINNET COM SUCESSO."
    ];

    let logIdx = 0;
    const interval = setInterval(() => {
      if (logIdx < steps.length) {
        setPromoLogs(prev => [...prev, steps[logIdx]]);
        logIdx++;
      } else {
        clearInterval(interval);
        setIsLivePromoted(true);
        setIsPromotingChecklist(false);
      }
    }, 200);
  };

  const forceSuccessAll = () => {
    setChecklistPRR(98);
    setChecklistShadowMode(true);
    setChecklistSignals(1250);
    setChecklistProfitFactor(2.45);
    setChecklistExpectancy(0.24);
    setChecklistDrawdown(1.85);
    setChecklistLatency(120);
    setChecklistRpcHealthy(true);
    setChecklistGeyserConnected(true);
    setChecklistJitoConnected(true);
    setChecklistWalletLoaded(true);
    setChecklistWalletBalance(24.5);
    setChecklistKillSwitchOperational(true);
    setChecklistCircuitBreakersActive(true);
    setChecklistDbHealthy(true);
    setChecklistObservabilityActive(true);
  };

  const resetToDefault = () => {
    setChecklistPRR(96);
    setChecklistShadowMode(true);
    setChecklistSignals(1142);
    setChecklistProfitFactor(2.14);
    setChecklistExpectancy(0.18);
    setChecklistDrawdown(2.85);
    setChecklistLatency(142);
    setChecklistRpcHealthy(true);
    setChecklistGeyserConnected(true);
    setChecklistJitoConnected(true);
    setChecklistWalletLoaded(true);
    setChecklistWalletBalance(18.5);
    setChecklistKillSwitchOperational(true);
    setChecklistCircuitBreakersActive(true);
    setChecklistDbHealthy(true);
    setChecklistObservabilityActive(true);
    setIsLivePromoted(false);
    setPromoLogs([]);
  };

  // Wallet simulation list
  const [wallets, setWallets] = useState<Array<{ id: number; address: string; bal: number; txs: number; status: string }>>([
    { id: 1, address: "HFTx19z...8A2n", bal: 2.50, txs: 41, status: "Active" },
    { id: 2, address: "Jito7bY...K3pq", bal: 2.45, txs: 38, status: "Standby" },
    { id: 3, address: "Ny4Snp3...9Zvd", bal: 1.80, txs: 15, status: "Standby" },
    { id: 4, address: "Bundle9...Xw1z", bal: 2.10, txs: 22, status: "Standby" },
    { id: 5, address: "MevGysR...6Yhm", bal: 1.95, txs: 19, status: "Cool-down" },
    { id: 6, address: "FastEd2...1Trc", bal: 2.05, txs: 30, status: "Standby" },
    { id: 7, address: "SolTrt4...4Psk", bal: 2.20, txs: 27, status: "Standby" },
    { id: 8, address: "JupV6Ro...5Mbn", bal: 1.75, txs: 11, status: "Standby" }
  ]);

  // Dynamic simulation for rotations
  const triggerRotation = () => {
    if (isRotating) return;
    setIsRotating(true);
    
    const logs = [
      `[ROTATOR] Iniciando rotatividade no Slot de alta frequência...`,
      `[ROTATOR] Analisando mempool para evitar vinculação de chaves...`,
      `[ROTATOR] Assinando bundle de realocação de liquidez via Jito...`,
      `[ROTATOR] Chave ativa ${wallets[activeWalletIndex].address} colocada em Cool-down.`,
    ];

    let logIndex = 0;
    const interval = setInterval(() => {
      if (logIndex < logs.length) {
        setRotationLogs(prev => [logs[logIndex], ...prev].slice(0, 15));
        logIndex++;
      } else {
        clearInterval(interval);
        
        // Advance to next wallet index
        const nextIdx = (activeWalletIndex + 1) % keypairsCount;
        setActiveWalletIndex(nextIdx);

        // Update wallets status
        setWallets(prev => prev.map((w, idx) => {
          let stat = "Standby";
          if (idx === nextIdx) stat = "Active";
          else if (idx === activeWalletIndex) stat = "Cool-down";
          else if (idx === (activeWalletIndex + 2) % keypairsCount) stat = "Retiring";
          
          // Randomly add a simulated tx to active wallet
          return {
            ...w,
            status: stat,
            txs: idx === nextIdx ? w.txs + 1 : w.txs,
            bal: idx === nextIdx ? parseFloat((w.bal - 0.005).toFixed(3)) : w.bal
          };
        }));

        setRotationLogs(prev => [
          `[SUCCESS] Nova chave ativa selecionada: ${wallets[nextIdx].address}. Ofuscação de concorrência com 100% de eficácia.`,
          ...prev
        ]);
        setIsRotating(false);
      }
    }, 400);
  };

  return (
    <div id="go-live-manual-dashboard" className="space-y-4">
      {/* Overview Card */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 backdrop-blur-md relative overflow-hidden">
        <div className="absolute top-0 right-0 w-36 h-36 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none"></div>
        <div className="flex items-start gap-3.5">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-cyan-500/20 to-purple-500/20 border border-cyan-500/30 flex items-center justify-center shrink-0 glow-cyan">
            <Rocket className="w-6 h-6 text-cyan-400 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-display font-black text-slate-100 uppercase tracking-tight">Manual de Procedimentos de Go-Live</h2>
              <span className="text-[9px] font-mono font-extrabold px-1.5 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
                A VIRADA DE CHAVE
              </span>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed mt-1">
              Fase de transição operacional de replay para execução on-chain em Mainnet. Com foco em <span className="text-cyan-400 font-semibold">Preservação de Capital</span>, <span className="text-purple-400 font-semibold">Escalonamento Estatístico</span> e eliminação de assinaturas que correlacionem chaves.
            </p>
          </div>
        </div>
      </div>

      {/* Main Grid: Interactive Roadmap (Left) & Risk Calculator (Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        
        {/* Interactive Roadmap Stage Control */}
        <div className="lg:col-span-7 bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between border-b border-slate-850 pb-2 mb-3">
              <span className="text-xs font-mono font-bold text-slate-200 flex items-center gap-1.5">
                <Layers className="w-4 h-4 text-cyan-400" />
                SISTEMA DE IMPLANTAÇÃO EM ESTÁGIOS
              </span>
              <span className="text-[9px] font-mono text-slate-500 uppercase">Progresso de 4 Semanas</span>
            </div>

            {/* Stage Buttons */}
            <div className="grid grid-cols-4 gap-1.5 mb-3">
              {stages.map((stg) => {
                const isActive = activeStage === stg.id;
                return (
                  <button
                    key={stg.id}
                    onClick={() => setActiveStage(stg.id)}
                    className={`p-2 rounded-lg border text-left transition-all cursor-pointer ${
                      isActive
                        ? "bg-cyan-500/10 border-cyan-500/40 text-cyan-400 shadow-inner"
                        : "bg-slate-950/60 border-slate-850 text-slate-400 hover:text-slate-300 hover:border-slate-800"
                    }`}
                  >
                    <span className="block text-[8px] font-mono text-slate-500 uppercase">{stg.duration}</span>
                    <span className="text-[10px] font-mono font-extrabold block truncate">{stg.name}</span>
                    <span className="text-[9px] font-mono block text-slate-300 mt-0.5">{stg.capital}</span>
                  </button>
                );
              })}
            </div>

            {/* Active Stage Details */}
            <div className="bg-slate-950 p-3 rounded-lg border border-slate-850/80 min-h-36 flex flex-col justify-between">
              <div>
                <div className="flex justify-between items-start border-b border-slate-900 pb-1.5 mb-2">
                  <div>
                    <span className="text-[9px] font-mono text-cyan-400 uppercase font-semibold">Estágio {activeStage} Ativo</span>
                    <h3 className="text-xs font-display font-bold text-slate-200 uppercase mt-0.5">
                      {stages[activeStage - 1].name} &mdash; {stages[activeStage - 1].objective}
                    </h3>
                  </div>
                  <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                    Alocação: {stages[activeStage - 1].capital}
                  </span>
                </div>

                <div className="space-y-2 mt-1">
                  <div className="flex items-start gap-2 text-[10px] font-mono text-slate-300">
                    <ArrowRight className="w-3.5 h-3.5 text-cyan-500 shrink-0 mt-0.5" />
                    <span>
                      <strong className="text-slate-400">Regra de Engajamento:</strong> {stages[activeStage - 1].strategy}
                    </span>
                  </div>
                  
                  {/* Dynamic Alert based on stage */}
                  {activeStage === 1 && (
                    <div className="bg-emerald-500/5 border border-emerald-500/15 p-2 rounded text-[9px] font-mono text-emerald-400 leading-relaxed">
                      💡 <strong>Objetivo de Sandbox:</strong> Nesta fase de detecção pura, o Sniper opera off-chain em Shadow Mode com o Yellowstone gRPC stream. Nenhuma transação real consome SOL. Verifique se o RTT está estável abaixo de 1.5ms.
                    </div>
                  )}
                  {activeStage === 2 && (
                    <div className="bg-purple-500/5 border border-purple-500/15 p-2 rounded text-[9px] font-mono text-purple-400 leading-relaxed">
                      💡 <strong>Fase de Conectividade:</strong> Inicie transações reais em tokens de baixíssima concorrência para calibrar o slippage e a landing rate da Jito no bloco real. Risco de exposição extremamente mitigado.
                    </div>
                  )}
                  {activeStage === 3 && (
                    <div className="bg-amber-500/5 border border-amber-500/15 p-2 rounded text-[9px] font-mono text-amber-400 leading-relaxed">
                      💡 <strong>Ajuste Fino de IA:</strong> Com $2.000 de capital, calibra-se o limiar do filtro predictivo off-chain (Opportunity Score) contra honeypots complexos. Gorjetas de prioridade começam a flutuar dinamicamente.
                    </div>
                  )}
                  {activeStage === 4 && (
                    <div className="bg-cyan-500/5 border border-cyan-500/15 p-2 rounded text-[9px] font-mono text-cyan-400 leading-relaxed">
                      🚀 <strong>Full Go-Live (God-Tier):</strong> Piloto automático total on-chain. O limite de decisão está calibrado. Rotação automática de carteiras e circuito integrado de risco contra alterações repentinas de contratos inteligentes.
                    </div>
                  )}
                </div>
              </div>

              {/* Progress and status checkpoint indicators */}
              <div className="mt-3 pt-2.5 border-t border-slate-900 flex flex-wrap justify-between items-center gap-2">
                <span className="text-[9px] font-mono text-slate-500 uppercase">Validação de Infraestrutura:</span>
                <div className="flex gap-2 text-[9px] font-mono">
                  <span className="text-emerald-400 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3 text-emerald-400" /> Geyser OK
                  </span>
                  <span className="text-emerald-400 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3 text-emerald-400" /> Jito Landing OK
                  </span>
                  <span className="text-cyan-400 flex items-center gap-1 animate-pulse">
                    <RefreshCw className="w-2.5 h-2.5 animate-spin-slow" /> Calibrando
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-3 bg-slate-950 p-2 rounded border border-slate-850 flex items-center justify-between">
            <span className="text-[9px] font-mono text-slate-400 uppercase">Deseja simular o avanço para o próximo estágio?</span>
            <button
              onClick={() => setActiveStage(prev => (prev % 4) + 1)}
              className="text-[9px] font-mono font-bold bg-cyan-500/10 hover:bg-cyan-500/25 text-cyan-400 border border-cyan-500/30 px-2.5 py-1 rounded transition-all cursor-pointer"
            >
              Avançar Fase
            </button>
          </div>
        </div>

        {/* Dynamic Position Sizing Calculator */}
        <div className="lg:col-span-5 bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between border-b border-slate-850 pb-2 mb-3">
              <span className="text-xs font-mono font-bold text-slate-200 flex items-center gap-1.5">
                <Percent className="w-4 h-4 text-purple-400" />
                SIMULADOR DE ALOCAÇÃO & RISCO
              </span>
              <span className="text-[8px] font-mono text-purple-400 bg-purple-500/10 px-1 py-0.5 rounded uppercase font-bold">1-2% Rule</span>
            </div>

            <div className="space-y-2 text-[10px] font-mono">
              {/* Slider for Total Capital */}
              <div>
                <div className="flex justify-between items-center text-slate-300 font-bold mb-1">
                  <span>Capital Alocado Total:</span>
                  <span className="text-cyan-400 font-extrabold">${totalCapital.toLocaleString()} USD</span>
                </div>
                <input
                  type="range"
                  min="100"
                  max="10000"
                  step="100"
                  value={totalCapital}
                  onChange={(e) => setTotalCapital(parseInt(e.target.value))}
                  className="w-full accent-cyan-500 bg-slate-950 rounded-lg cursor-pointer h-1"
                />
                <div className="flex justify-between text-[8px] text-slate-500 mt-1">
                  <span>Mín: $100</span>
                  <span>Solana Eq: ~{(totalCapital / solPrice).toFixed(1)} SOL</span>
                  <span>Máx: $10.000</span>
                </div>
              </div>

              {/* Slider for Lot Size Percentage */}
              <div className="pt-1.5">
                <div className="flex justify-between items-center text-slate-300 font-bold mb-1">
                  <span>Tamanho do Lote (1% - 2%):</span>
                  <span className="text-purple-400 font-extrabold">{lotPercent}% por lote</span>
                </div>
                <input
                  type="range"
                  min="1.0"
                  max="2.0"
                  step="0.1"
                  value={lotPercent}
                  onChange={(e) => setLotPercent(parseFloat(e.target.value))}
                  className="w-full accent-purple-500 bg-slate-950 rounded-lg cursor-pointer h-1"
                />
              </div>

              {/* Slider for Hot Wallets count */}
              <div className="pt-1.5">
                <div className="flex justify-between items-center text-slate-300 font-bold mb-1">
                  <span>Múltiplas Hot Wallets:</span>
                  <span className="text-emerald-400 font-extrabold">{keypairsCount} Keypairs</span>
                </div>
                <input
                  type="range"
                  min="5"
                  max="10"
                  step="1"
                  value={keypairsCount}
                  onChange={(e) => setKeypairsCount(parseInt(e.target.value))}
                  className="w-full accent-emerald-500 bg-slate-950 rounded-lg cursor-pointer h-1"
                />
              </div>
            </div>

            {/* Results breakdown */}
            <div className="bg-slate-950 p-2.5 rounded border border-slate-850 mt-3 space-y-1.5 text-[10px] font-mono leading-relaxed">
              <div className="flex justify-between border-b border-slate-900 pb-1">
                <span className="text-slate-500">Capital em SOL:</span>
                <span className="text-slate-200 font-bold">{totalCapitalSol.toFixed(2)} SOL</span>
              </div>
              <div className="flex justify-between border-b border-slate-900 pb-1">
                <span className="text-slate-500">Lote por Transação:</span>
                <span className="text-purple-400 font-extrabold">
                  {lotSizeSol.toFixed(3)} SOL <span className="text-[8px] text-slate-500">(${lotSizeUsd.toFixed(1)})</span>
                </span>
              </div>
              <div className="flex justify-between border-b border-slate-900 pb-1">
                <span className="text-slate-500">Exposição por Wallet (Individual):</span>
                <span className="text-emerald-400 font-bold">
                  {exposurePerKeypairSol.toFixed(3)} SOL <span className="text-[8px] text-slate-500">({exposurePerKeypairPercent.toFixed(2)}%)</span>
                </span>
              </div>
              <div className="flex justify-between pt-0.5">
                <span className="text-slate-500">Eficácia de Sobrevivência:</span>
                <span className="text-cyan-400 font-bold">Infinite Series Run (Excelência)</span>
              </div>
            </div>
          </div>

          <div className="mt-2.5 pt-2 border-t border-slate-850 flex items-center justify-between">
            <span className="text-[8px] font-mono text-slate-500 uppercase">Limite de Segurança &lt; 1% por Wallet:</span>
            {isKeypairRiskAcceptable ? (
              <span className="text-[8px] font-mono font-black bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded uppercase">
                APROVADO ✔
              </span>
            ) : (
              <span className="text-[8px] font-mono font-black bg-rose-500/10 border border-rose-500/20 text-rose-400 px-1.5 py-0.5 rounded uppercase animate-pulse">
                RISCO ALTO ⚠
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Checklist Automático de Go Live (ETAPA 9) */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
              <Shield className="w-5 h-5 text-cyan-400 animate-pulse" />
            </div>
            <div className="text-left">
              <div className="flex items-center gap-1.5">
                <h2 className="text-sm font-sans font-extrabold text-slate-100 uppercase tracking-tight">
                  Checklist Automático de Go Live
                </h2>
                <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-cyan-950/80 border border-cyan-800/40 text-cyan-400 uppercase">
                  ETAPA 9 (Obrigatória)
                </span>
              </div>
              <p className="text-[10px] font-mono text-slate-400">
                O sniper-engine recusa operações real-time on-chain a menos que todos os 16 critérios rígidos de liberação estejam verdes.
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={forceSuccessAll}
              className="px-3 py-1.5 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 rounded font-mono font-bold text-[10px] transition-all flex items-center gap-1 cursor-pointer"
            >
              🚀 SUCESSO COMPLETO (FORÇAR)
            </button>
            <button
              onClick={resetToDefault}
              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-750 text-slate-300 border border-slate-700 rounded font-mono font-bold text-[10px] transition-all flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw className="w-3 h-3" /> PADRÃO
            </button>
          </div>
        </div>

        {/* Live Status Board */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 p-4 bg-slate-950 rounded-xl border border-slate-850">
          <div className="lg:col-span-3 flex flex-col justify-between space-y-2 text-left">
            <div className="flex items-center gap-2.5">
              <span className={`text-[10px] font-mono font-black px-2 py-0.5 rounded border uppercase flex items-center gap-1 ${
                isGoLiveFullyUnlocked 
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20 animate-pulse" 
                  : "bg-rose-500/10 text-rose-400 border-rose-500/20 animate-none"
              }`}>
                {isGoLiveFullyUnlocked ? "✔ GO-LIVE LIBERADO" : "❌ TRAVADO OPERACIONAL"}
              </span>
              <span className="text-[10px] font-mono text-slate-400">
                CRITÉRIOS SUCEDIDOS: <strong className={isGoLiveFullyUnlocked ? "text-emerald-400" : "text-rose-400"}>{passedChecksCount}/16</strong>
              </span>
            </div>
            <p className="text-[10px] text-slate-400 leading-relaxed font-mono uppercase">
              {isGoLiveFullyUnlocked 
                ? "SINAL VERDE: AS DIRETRIZES DE PROMOÇÃO DE MAINNET OPERACIONAL FORAM CONCEDIDAS. O ACOPLAMENTO DE SINAIS ESTÁ AUTORIZADO."
                : "BLOQUEIO FÍSICO ATIVO: RE-CALIBRE OS FILTROS RE-BAIXADOS OU OS PARÂMETROS ABAIXO PARA LIBERAR A EXECUÇÃO EM MAINNET."}
            </p>
          </div>
          <div className="flex flex-col justify-center items-center p-3 bg-slate-900 rounded-lg border border-slate-800">
            <span className="text-[8px] font-mono text-slate-500 uppercase mb-1">PROMOVER PARA MAINNET</span>
            {isLivePromoted ? (
              <div className="text-center">
                <span className="text-[10px] font-mono font-bold text-emerald-400 flex items-center justify-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5 animate-bounce" /> LIVE EM MAINNET!
                </span>
                <button
                  onClick={() => setIsLivePromoted(false)}
                  className="text-[8px] font-mono text-slate-400 hover:text-slate-200 underline mt-1.5 block mx-auto cursor-pointer"
                >
                  Reiniciar Sandbox
                </button>
              </div>
            ) : (
              <button
                onClick={triggerMainnetPromotion}
                disabled={!isGoLiveFullyUnlocked || isPromotingChecklist}
                className={`w-full py-2 px-3 rounded font-mono font-bold text-[10px] uppercase transition-all flex items-center justify-center gap-1.5 ${
                  isGoLiveFullyUnlocked
                    ? "bg-cyan-500 hover:bg-cyan-400 text-slate-950 shadow-md shadow-cyan-500/20 cursor-pointer animate-pulse"
                    : "bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed"
                }`}
              >
                {isPromotingChecklist ? (
                  <>
                    <RefreshCw className="w-3 h-3 animate-spin" /> PROMOVENDO...
                  </>
                ) : (
                  <>
                    {isGoLiveFullyUnlocked ? <Unlock className="w-3 h-3" /> : <Lock className="w-3 h-3" />}
                    LIBERAR MAINNET
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Terminal Promo Logs */}
        {promoLogs.length > 0 && (
          <div className="bg-slate-950 p-3 rounded-lg border border-cyan-900/30 font-mono text-[9.5px] leading-relaxed text-slate-300 max-h-48 overflow-y-auto text-left">
            <div className="flex justify-between items-center text-[8.5px] text-slate-500 border-b border-slate-900 pb-1 mb-1.5 uppercase">
              <span>Mainnet Deployment Terminal Logs</span>
              <span className="text-cyan-400 animate-pulse">Running live</span>
            </div>
            {promoLogs.map((log, idx) => (
              <div key={idx} className={log.includes("SUCCESS") ? "text-emerald-400 font-extrabold animate-pulse" : ""}>
                {log}
              </div>
            ))}
          </div>
        )}

        {/* 16 Interactive Grid Checklist Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 text-left">
          
          {/* Rule 1: PRR Score */}
          <div className={`p-3 rounded-lg border font-mono transition-all relative ${
            isPrrPass ? "bg-emerald-500/5 border-emerald-500/25 text-emerald-400" : "bg-rose-500/5 border-rose-500/25 text-rose-400"
          }`}>
            <div className="flex justify-between items-start">
              <span className="text-[8px] text-slate-500 block">1 • AUDITORIA PRR</span>
              {isPrrPass ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <X className="w-3.5 h-3.5 text-rose-400" />}
            </div>
            <span className="text-xs font-black block mt-1 text-slate-100">PRR: {checklistPRR}%</span>
            <span className="text-[8px] text-slate-400 block mt-0.5 uppercase">Alvo: &ge; 95%</span>
            <div className="mt-2.5">
              <input
                type="range"
                min="80"
                max="100"
                value={checklistPRR}
                onChange={(e) => setChecklistPRR(parseInt(e.target.value))}
                className="w-full h-1 accent-cyan-500 bg-slate-950 rounded cursor-pointer"
              />
            </div>
          </div>

          {/* Rule 2: Shadow Mode Approved */}
          <div 
            onClick={() => setChecklistShadowMode(!checklistShadowMode)}
            className={`p-3 rounded-lg border font-mono transition-all cursor-pointer select-none hover:bg-slate-850/30 ${
              isShadowPass ? "bg-emerald-500/5 border-emerald-500/25 text-emerald-400" : "bg-rose-500/5 border-rose-500/25 text-rose-400"
            }`}
          >
            <div className="flex justify-between items-start">
              <span className="text-[8px] text-slate-500 block">2 • SHADOW MODE</span>
              {isShadowPass ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <X className="w-3.5 h-3.5 text-rose-400" />}
            </div>
            <span className="text-xs font-black block mt-1 text-slate-100">
              {isShadowPass ? "APROVADO" : "REBAIXADO"}
            </span>
            <span className="text-[8px] text-slate-400 block mt-0.5 uppercase">Click p/ Alternar</span>
            <div className="mt-3.5 text-center">
              <span className="text-[8px] bg-slate-950/60 px-1.5 py-0.5 rounded border border-slate-800 text-slate-400 uppercase">Alternar</span>
            </div>
          </div>

          {/* Rule 3: Valid Signals Count */}
          <div className={`p-3 rounded-lg border font-mono transition-all relative ${
            isSignalsPass ? "bg-emerald-500/5 border-emerald-500/25 text-emerald-400" : "bg-rose-500/5 border-rose-500/25 text-rose-400"
          }`}>
            <div className="flex justify-between items-start">
              <span className="text-[8px] text-slate-500 block">3 • SINAIS VÁLIDOS</span>
              {isSignalsPass ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <X className="w-3.5 h-3.5 text-rose-400" />}
            </div>
            <span className="text-xs font-black block mt-1 text-slate-100">{checklistSignals} Sinais</span>
            <span className="text-[8px] text-slate-400 block mt-0.5 uppercase">Alvo: &ge; 1.000</span>
            <div className="mt-2.5">
              <input
                type="range"
                min="500"
                max="2000"
                step="50"
                value={checklistSignals}
                onChange={(e) => setChecklistSignals(parseInt(e.target.value))}
                className="w-full h-1 accent-cyan-500 bg-slate-950 rounded cursor-pointer"
              />
            </div>
          </div>

          {/* Rule 4: Profit Factor */}
          <div className={`p-3 rounded-lg border font-mono transition-all relative ${
            isProfitFactorPass ? "bg-emerald-500/5 border-emerald-500/25 text-emerald-400" : "bg-rose-500/5 border-rose-500/25 text-rose-400"
          }`}>
            <div className="flex justify-between items-start">
              <span className="text-[8px] text-slate-500 block">4 • PROFIT FACTOR</span>
              {isProfitFactorPass ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <X className="w-3.5 h-3.5 text-rose-400" />}
            </div>
            <span className="text-xs font-black block mt-1 text-slate-100">PF: {checklistProfitFactor.toFixed(2)}</span>
            <span className="text-[8px] text-slate-400 block mt-0.5 uppercase">Alvo: &ge; 1.8</span>
            <div className="mt-2.5">
              <input
                type="range"
                min="1.0"
                max="3.0"
                step="0.05"
                value={checklistProfitFactor}
                onChange={(e) => setChecklistProfitFactor(parseFloat(e.target.value))}
                className="w-full h-1 accent-cyan-500 bg-slate-950 rounded cursor-pointer"
              />
            </div>
          </div>

          {/* Rule 5: Expectancy */}
          <div className={`p-3 rounded-lg border font-mono transition-all relative ${
            isExpectancyPass ? "bg-emerald-500/5 border-emerald-500/25 text-emerald-400" : "bg-rose-500/5 border-rose-500/25 text-rose-400"
          }`}>
            <div className="flex justify-between items-start">
              <span className="text-[8px] text-slate-500 block">5 • EXPECTÂNCIA</span>
              {isExpectancyPass ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <X className="w-3.5 h-3.5 text-rose-400" />}
            </div>
            <span className="text-xs font-black block mt-1 text-slate-100">{checklistExpectancy > 0 ? "+" : ""}{checklistExpectancy.toFixed(2)} SOL/trade</span>
            <span className="text-[8px] text-slate-400 block mt-0.5 uppercase">Alvo: Positiva (&gt; 0)</span>
            <div className="mt-2.5">
              <input
                type="range"
                min="-0.5"
                max="0.5"
                step="0.02"
                value={checklistExpectancy}
                onChange={(e) => setChecklistExpectancy(parseFloat(e.target.value))}
                className="w-full h-1 accent-cyan-500 bg-slate-950 rounded cursor-pointer"
              />
            </div>
          </div>

          {/* Rule 6: Drawdown Limit */}
          <div className={`p-3 rounded-lg border font-mono transition-all relative ${
            isDrawdownPass ? "bg-emerald-500/5 border-emerald-500/25 text-emerald-400" : "bg-rose-500/5 border-rose-500/25 text-rose-400"
          }`}>
            <div className="flex justify-between items-start">
              <span className="text-[8px] text-slate-500 block">6 • DRAWDOWN LIMITE</span>
              {isDrawdownPass ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <X className="w-3.5 h-3.5 text-rose-400" />}
            </div>
            <span className="text-xs font-black block mt-1 text-slate-100">DD: {checklistDrawdown.toFixed(2)}%</span>
            <span className="text-[8px] text-slate-400 block mt-0.5 uppercase">Alvo: &le; 5.0%</span>
            <div className="mt-2.5">
              <input
                type="range"
                min="1.0"
                max="10.0"
                step="0.1"
                value={checklistDrawdown}
                onChange={(e) => setChecklistDrawdown(parseFloat(e.target.value))}
                className="w-full h-1 accent-cyan-500 bg-slate-950 rounded cursor-pointer"
              />
            </div>
          </div>

          {/* Rule 7: Latency P99 */}
          <div className={`p-3 rounded-lg border font-mono transition-all relative ${
            isLatencyPass ? "bg-emerald-500/5 border-emerald-500/25 text-emerald-400" : "bg-rose-500/5 border-rose-500/25 text-rose-400"
          }`}>
            <div className="flex justify-between items-start">
              <span className="text-[8px] text-slate-500 block">7 • LATÊNCIA P99</span>
              {isLatencyPass ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <X className="w-3.5 h-3.5 text-rose-400" />}
            </div>
            <span className="text-xs font-black block mt-1 text-slate-100">{checklistLatency} ms</span>
            <span className="text-[8px] text-slate-400 block mt-0.5 uppercase">Alvo: &lt; 150 ms</span>
            <div className="mt-2.5">
              <input
                type="range"
                min="40"
                max="250"
                step="5"
                value={checklistLatency}
                onChange={(e) => setChecklistLatency(parseInt(e.target.value))}
                className="w-full h-1 accent-cyan-500 bg-slate-950 rounded cursor-pointer"
              />
            </div>
          </div>

          {/* Rule 8: RPC Healthy */}
          <div 
            onClick={() => setChecklistRpcHealthy(!checklistRpcHealthy)}
            className={`p-3 rounded-lg border font-mono transition-all cursor-pointer select-none hover:bg-slate-850/30 ${
              isRpcPass ? "bg-emerald-500/5 border-emerald-500/25 text-emerald-400" : "bg-rose-500/5 border-rose-500/25 text-rose-400"
            }`}
          >
            <div className="flex justify-between items-start">
              <span className="text-[8px] text-slate-500 block">8 • RPC SAÚDE</span>
              {isRpcPass ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <X className="w-3.5 h-3.5 text-rose-400" />}
            </div>
            <span className="text-xs font-black block mt-1 text-slate-100">
              {isRpcPass ? "SAUDÁVEL" : "INSTÁVEL"}
            </span>
            <span className="text-[8px] text-slate-400 block mt-0.5 uppercase">Click p/ Alterar</span>
            <div className="mt-3.5 text-center">
              <span className="text-[8px] bg-slate-950/60 px-1.5 py-0.5 rounded border border-slate-800 text-slate-400 uppercase">Alternar</span>
            </div>
          </div>

          {/* Rule 9: Geyser Connected */}
          <div 
            onClick={() => setChecklistGeyserConnected(!checklistGeyserConnected)}
            className={`p-3 rounded-lg border font-mono transition-all cursor-pointer select-none hover:bg-slate-850/30 ${
              isGeyserPass ? "bg-emerald-500/5 border-emerald-500/25 text-emerald-400" : "bg-rose-500/5 border-rose-500/25 text-rose-400"
            }`}
          >
            <div className="flex justify-between items-start">
              <span className="text-[8px] text-slate-500 block">9 • GEYSER STREAM</span>
              {isGeyserPass ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <X className="w-3.5 h-3.5 text-rose-400" />}
            </div>
            <span className="text-xs font-black block mt-1 text-slate-100">
              {isGeyserPass ? "CONECTADO" : "DESCONECTADO"}
            </span>
            <span className="text-[8px] text-slate-400 block mt-0.5 uppercase">Click p/ Alterar</span>
            <div className="mt-3.5 text-center">
              <span className="text-[8px] bg-slate-950/60 px-1.5 py-0.5 rounded border border-slate-800 text-slate-400 uppercase">Alternar</span>
            </div>
          </div>

          {/* Rule 10: Jito Connected */}
          <div 
            onClick={() => setChecklistJitoConnected(!checklistJitoConnected)}
            className={`p-3 rounded-lg border font-mono transition-all cursor-pointer select-none hover:bg-slate-850/30 ${
              isJitoPass ? "bg-emerald-500/5 border-emerald-500/25 text-emerald-400" : "bg-rose-500/5 border-rose-500/25 text-rose-400"
            }`}
          >
            <div className="flex justify-between items-start">
              <span className="text-[8px] text-slate-500 block">10 • JITO ENGINE</span>
              {isJitoPass ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <X className="w-3.5 h-3.5 text-rose-400" />}
            </div>
            <span className="text-xs font-black block mt-1 text-slate-100">
              {isJitoPass ? "CONECTADO" : "FALHANDO"}
            </span>
            <span className="text-[8px] text-slate-400 block mt-0.5 uppercase">Click p/ Alterar</span>
            <div className="mt-3.5 text-center">
              <span className="text-[8px] bg-slate-950/60 px-1.5 py-0.5 rounded border border-slate-800 text-slate-400 uppercase">Alternar</span>
            </div>
          </div>

          {/* Rule 11: Wallet Loaded */}
          <div 
            onClick={() => setChecklistWalletLoaded(!checklistWalletLoaded)}
            className={`p-3 rounded-lg border font-mono transition-all cursor-pointer select-none hover:bg-slate-850/30 ${
              isWalletPass ? "bg-emerald-500/5 border-emerald-500/25 text-emerald-400" : "bg-rose-500/5 border-rose-500/25 text-rose-400"
            }`}
          >
            <div className="flex justify-between items-start">
              <span className="text-[8px] text-slate-500 block">11 • HOT WALLET CARGA</span>
              {isWalletPass ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <X className="w-3.5 h-3.5 text-rose-400" />}
            </div>
            <span className="text-xs font-black block mt-1 text-slate-100">
              {isWalletPass ? "CHAVES RAM OK" : "NÃO INICIALIZADO"}
            </span>
            <span className="text-[8px] text-slate-400 block mt-0.5 uppercase">Click p/ Alterar</span>
            <div className="mt-3.5 text-center">
              <span className="text-[8px] bg-slate-950/60 px-1.5 py-0.5 rounded border border-slate-800 text-slate-400 uppercase">Alternar</span>
            </div>
          </div>

          {/* Rule 12: Sufficient Balance */}
          <div className={`p-3 rounded-lg border font-mono transition-all relative ${
            isBalancePass ? "bg-emerald-500/5 border-emerald-500/25 text-emerald-400" : "bg-rose-500/5 border-rose-500/25 text-rose-400"
          }`}>
            <div className="flex justify-between items-start">
              <span className="text-[8px] text-slate-500 block">12 • SALDO SUFICIENTE</span>
              {isBalancePass ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <X className="w-3.5 h-3.5 text-rose-400" />}
            </div>
            <span className="text-xs font-black block mt-1 text-slate-100">{checklistWalletBalance.toFixed(1)} SOL</span>
            <span className="text-[8px] text-slate-400 block mt-0.5 uppercase">Alvo: &ge; 5.0 SOL</span>
            <div className="mt-2.5">
              <input
                type="range"
                min="1"
                max="50"
                step="1.0"
                value={checklistWalletBalance}
                onChange={(e) => setChecklistWalletBalance(parseFloat(e.target.value))}
                className="w-full h-1 accent-cyan-500 bg-slate-950 rounded cursor-pointer"
              />
            </div>
          </div>

          {/* Rule 13: Kill Switch Operational */}
          <div 
            onClick={() => setChecklistKillSwitchOperational(!checklistKillSwitchOperational)}
            className={`p-3 rounded-lg border font-mono transition-all cursor-pointer select-none hover:bg-slate-850/30 ${
              isKillSwitchPass ? "bg-emerald-500/5 border-emerald-500/25 text-emerald-400" : "bg-rose-500/5 border-rose-500/25 text-rose-400"
            }`}
          >
            <div className="flex justify-between items-start">
              <span className="text-[8px] text-slate-500 block">13 • KILL SWITCH</span>
              {isKillSwitchPass ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <X className="w-3.5 h-3.5 text-rose-400" />}
            </div>
            <span className="text-xs font-black block mt-1 text-slate-100">
              {isKillSwitchPass ? "OPERACIONAL" : "NÃO RESPONDENDO"}
            </span>
            <span className="text-[8px] text-slate-400 block mt-0.5 uppercase">Click p/ Alterar</span>
            <div className="mt-3.5 text-center">
              <span className="text-[8px] bg-slate-950/60 px-1.5 py-0.5 rounded border border-slate-800 text-slate-400 uppercase">Alternar</span>
            </div>
          </div>

          {/* Rule 14: Circuit Breakers Active */}
          <div 
            onClick={() => setChecklistCircuitBreakersActive(!checklistCircuitBreakersActive)}
            className={`p-3 rounded-lg border font-mono transition-all cursor-pointer select-none hover:bg-slate-850/30 ${
              isCircuitBreakerPass ? "bg-emerald-500/5 border-emerald-500/25 text-emerald-400" : "bg-rose-500/5 border-rose-500/25 text-rose-400"
            }`}
          >
            <div className="flex justify-between items-start">
              <span className="text-[8px] text-slate-500 block">14 • DISJUNTORES (L9)</span>
              {isCircuitBreakerPass ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <X className="w-3.5 h-3.5 text-rose-400" />}
            </div>
            <span className="text-xs font-black block mt-1 text-slate-100">
              {isCircuitBreakerPass ? "ATIVOS / PRONTOS" : "DESARMADOS"}
            </span>
            <span className="text-[8px] text-slate-400 block mt-0.5 uppercase">Click p/ Alterar</span>
            <div className="mt-3.5 text-center">
              <span className="text-[8px] bg-slate-950/60 px-1.5 py-0.5 rounded border border-slate-800 text-slate-400 uppercase">Alternar</span>
            </div>
          </div>

          {/* Rule 15: Database Integrity */}
          <div 
            onClick={() => setChecklistDbHealthy(!checklistDbHealthy)}
            className={`p-3 rounded-lg border font-mono transition-all cursor-pointer select-none hover:bg-slate-850/30 ${
              isDbPass ? "bg-emerald-500/5 border-emerald-500/25 text-emerald-400" : "bg-rose-500/5 border-rose-500/25 text-rose-400"
            }`}
          >
            <div className="flex justify-between items-start">
              <span className="text-[8px] text-slate-500 block">15 • BANCO DE DADOS</span>
              {isDbPass ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <X className="w-3.5 h-3.5 text-rose-400" />}
            </div>
            <span className="text-xs font-black block mt-1 text-slate-100">
              {isDbPass ? "ÍNTEGRO & ATIVO" : "DESCONECTADO"}
            </span>
            <span className="text-[8px] text-slate-400 block mt-0.5 uppercase">Click p/ Alterar</span>
            <div className="mt-3.5 text-center">
              <span className="text-[8px] bg-slate-950/60 px-1.5 py-0.5 rounded border border-slate-800 text-slate-400 uppercase">Alternar</span>
            </div>
          </div>

          {/* Rule 16: Observability Active */}
          <div 
            onClick={() => setChecklistObservabilityActive(!checklistObservabilityActive)}
            className={`p-3 rounded-lg border font-mono transition-all cursor-pointer select-none hover:bg-slate-850/30 ${
              isObservabilityPass ? "bg-emerald-500/5 border-emerald-500/25 text-emerald-400" : "bg-rose-500/5 border-rose-500/25 text-rose-400"
            }`}
          >
            <div className="flex justify-between items-start">
              <span className="text-[8px] text-slate-500 block">16 • OBSERVABILIDADE</span>
              {isObservabilityPass ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <X className="w-3.5 h-3.5 text-rose-400" />}
            </div>
            <span className="text-xs font-black block mt-1 text-slate-100">
              {isObservabilityPass ? "TELEMETRIA REAL" : "INATIVA"}
            </span>
            <span className="text-[8px] text-slate-400 block mt-0.5 uppercase">Click p/ Alterar</span>
            <div className="mt-3.5 text-center">
              <span className="text-[8px] bg-slate-950/60 px-1.5 py-0.5 rounded border border-slate-800 text-slate-400 uppercase">Alternar</span>
            </div>
          </div>

        </div>
      </div>

      {/* Multi-Keypair Rotation Simulator */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
        <div className="flex items-center justify-between border-b border-slate-850 pb-2.5 mb-3">
          <div className="flex items-center gap-2">
            <Key className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-mono font-bold text-slate-200">ROTAÇÃO ATIVA DE CHAVES (OFUSCAÇÃO DE PADRÕES)</span>
          </div>
          <button
            onClick={triggerRotation}
            disabled={isRotating}
            className="text-[10px] font-mono font-bold bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-3 py-1 rounded transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${isRotating ? "animate-spin" : ""}`} />
            Rotacionar Chaves Ativas
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
          {/* Wallets Map Grid */}
          <div className="md:col-span-7 grid grid-cols-2 sm:grid-cols-4 gap-2">
            {wallets.map((wallet, idx) => {
              const isCurrent = idx === activeWalletIndex;
              let bg = "bg-slate-950";
              let text = "text-slate-400";
              let border = "border-slate-850/80";
              
              if (wallet.status === "Active") {
                bg = "bg-emerald-500/5";
                text = "text-emerald-400";
                border = "border-emerald-500/30 shadow-sm";
              } else if (wallet.status === "Cool-down") {
                bg = "bg-purple-500/5";
                text = "text-purple-400";
                border = "border-purple-500/20";
              } else if (wallet.status === "Retiring") {
                bg = "bg-rose-500/5";
                text = "text-rose-400";
                border = "border-rose-500/20";
              }

              return (
                <div key={wallet.id} className={`p-2 rounded border font-mono text-[9px] flex flex-col justify-between transition-all ${bg} ${border}`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-slate-500 text-[8px]">HW #0{wallet.id}</span>
                    <span className={`text-[7px] font-bold uppercase ${
                      wallet.status === "Active" ? "text-emerald-400" : "text-slate-500"
                    }`}>{wallet.status}</span>
                  </div>
                  <span className={`font-semibold text-center block py-1 font-sans ${text} ${isCurrent ? "font-bold" : ""}`}>
                    {wallet.address}
                  </span>
                  <div className="flex justify-between text-[7px] text-slate-500 border-t border-slate-900/40 pt-1 mt-1">
                    <span>Bal: {wallet.bal} SOL</span>
                    <span>{wallet.txs} txs</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Logs of pattern rotation */}
          <div className="md:col-span-5 bg-slate-950 p-2.5 rounded border border-slate-850 flex flex-col justify-between">
            <div className="border-b border-slate-900 pb-1 mb-1.5 flex justify-between items-center text-[8px] font-mono text-slate-500">
              <span>CONTROLE DE OFUSCAÇÃO MEMPOOL</span>
              <span className="text-emerald-400/80 animate-pulse">Rotator Live</span>
            </div>
            <div className="h-24 overflow-y-auto space-y-1 pr-1 font-mono text-[9px] leading-tight">
              {rotationLogs.map((log, i) => {
                let col = "text-slate-400";
                if (log.startsWith("[SUCCESS]")) col = "text-emerald-400 font-bold";
                else if (log.startsWith("[ROTATOR]")) col = "text-purple-400";
                return (
                  <div key={i} className={`pb-0.5 border-b border-slate-900/30 ${col}`}>
                    {log}
                  </div>
                );
              })}
            </div>
            <p className="text-[8px] text-slate-500 font-mono leading-relaxed uppercase mt-1">
              Ofusca correlação on-chain para evitar que agregadores de concorrência identifiquem nossa pegada de liquidez.
            </p>
          </div>
        </div>
      </div>

      {/* ETAPA 13 — MAINNET MINIMAL CAPITAL HOMOLOGATION DASHBOARD */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/5 rounded-full blur-2xl pointer-events-none"></div>
        
        <div className="flex flex-col md:flex-row md:items-center justify-between border-b border-slate-850 pb-2.5 mb-3.5 gap-2 text-left">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center glow-emerald">
              <Zap className="w-4 h-4 text-emerald-400 animate-pulse" />
            </div>
            <div>
              <span className="text-[9px] font-mono text-emerald-400 uppercase font-black tracking-wider block">MILITARY COMPLIANCE</span>
              <h2 className="text-xs font-display font-black text-slate-100 uppercase tracking-tight">ETAPA 13 &mdash; HOMOLOGAÇÃO EM MAINNET (CAPITAL MÍNIMO)</h2>
            </div>
          </div>
          
          <div className="flex flex-wrap gap-2">
            {/* Kill Switch Toggle */}
            <button
              onClick={() => {
                setKillSwitchActive(prev => {
                  const next = !prev;
                  if (next) {
                    setHomologationActive(false);
                    setHomologationLogs(l => [`[SYSTEM WARNING] ⚠️ [KILL SWITCH] DISPARADO MANUALMENTE! Interrompendo todas as operações síncronas e assíncronas imediatamente. Chaves isoladas trancadas em RAM.`, ...l]);
                  } else {
                    setHomologationLogs(l => [`[SYSTEM INFO] 🛡️ [KILL SWITCH] Restaurado com sucesso. Sistema pronto para inicialização segura.`, ...l]);
                  }
                  return next;
                });
              }}
              className={`px-3 py-1.5 rounded font-mono font-bold text-[9px] transition-all flex items-center gap-1.5 cursor-pointer uppercase ${
                killSwitchActive 
                  ? "bg-rose-500 text-white animate-pulse" 
                  : "bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20"
              }`}
            >
              <Shield className="w-3.5 h-3.5" />
              {killSwitchActive ? "☠️ KILL SWITCH ATIVO (LOCKDOWN)" : "☠️ ARMAR KILL SWITCH"}
            </button>

            {/* Circuit Breaker Manual Toggle */}
            <button
              onClick={() => {
                setCircuitBreakerTripped(prev => {
                  const next = !prev;
                  if (next) {
                    setHomologationActive(false);
                    setHomologationLogs(l => [`[SYSTEM WARNING] 🚨 [CIRCUIT BREAKER] DISPARADO MANUALMENTE! Fluxo de trades bloqueado por medida preventiva.`, ...l]);
                  } else {
                    setHomologationLogs(l => [`[SYSTEM INFO] 🛡️ [CIRCUIT BREAKER] Desarmado. Parâmetros de drawdown de segurança resetados.`, ...l]);
                  }
                  return next;
                });
              }}
              className={`px-3 py-1.5 rounded font-mono font-bold text-[9px] transition-all flex items-center gap-1.5 cursor-pointer uppercase ${
                circuitBreakerTripped 
                  ? "bg-amber-500 text-slate-950 animate-pulse" 
                  : "bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/20"
              }`}
            >
              <Sliders className="w-3.5 h-3.5" />
              {circuitBreakerTripped ? "⚡ DISJUNTOR DISPARADO (TRAVADO)" : "⚡ DISJUNTOR OK"}
            </button>

            {/* Simulated Reboot Recovery Button */}
            <button
              onClick={async () => {
                if (isSimulatingReboot) return;
                setIsSimulatingReboot(true);
                setHomologationActive(false);
                setHomologationLogs(l => [`[${new Date().toTimeString().split(' ')[0]}] 🔌 [REBOOT] Iniciando simulação de reinício forçado da aplicação...`, ...l]);
                
                await new Promise(r => setTimeout(r, 1000));
                setHomologationLogs(l => [
                  `[${new Date().toTimeString().split(' ')[0]}] 📁 [RECUPERAÇÃO] Estado da carteira recuperado: ${wallets[activeWalletIndex].address} (${wallets[activeWalletIndex].bal.toFixed(2)} SOL).`,
                  `[${new Date().toTimeString().split(' ')[0]}] 🗄️ [RECUPERAÇÃO] Conectando ao Banco SQL. Carregando posições inacabadas da sessão anterior...`,
                  `[${new Date().toTimeString().split(' ')[0]}] 🛡️ [RECUPERAÇÃO] Verificando integridade das assinaturas KMS contra as últimas 10 transações na Solana Mainnet...`,
                  `[${new Date().toTimeString().split(' ')[0]}] ✔️ [RECUPERAÇÃO SUCESSO] Todas as posições e o pipeline de execução assíncrona foram restabelecidos com 100% de consistência após o reinício!`,
                  ...l
                ]);
                setDbBackupRecovered(true);
                setIsSimulatingReboot(false);
              }}
              disabled={isSimulatingReboot}
              className="px-3 py-1.5 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 rounded font-mono font-bold text-[9px] transition-all flex items-center gap-1.5 cursor-pointer uppercase"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSimulatingReboot ? "animate-spin" : ""}`} />
              {isSimulatingReboot ? "REINICIANDO..." : "REINICIAR & RECUPERAR ESTADO"}
            </button>
          </div>
        </div>

        {/* Real-time metrics grid */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4 text-left">
          <div className="p-3 bg-slate-950 rounded-lg border border-slate-850">
            <span className="text-[8px] font-mono text-slate-500 uppercase block">Trades Executados</span>
            <div className="flex items-baseline gap-1 mt-1">
              <span className="text-xl font-mono font-black text-slate-100">{tradesCount}</span>
              <span className="text-[9px] font-mono text-slate-400">/ 100</span>
            </div>
            <div className="w-full bg-slate-900 rounded-full h-1 mt-2">
              <div 
                className="bg-cyan-500 h-1 rounded-full transition-all duration-500" 
                style={{ width: `${Math.min((tradesCount / 100) * 100, 100)}%` }}
              ></div>
            </div>
          </div>

          <div className="p-3 bg-slate-950 rounded-lg border border-slate-850">
            <span className="text-[8px] font-mono text-slate-500 uppercase block">Vitórias (PnL &gt; 0)</span>
            <div className="flex items-baseline gap-1 mt-1">
              <span className="text-xl font-mono font-black text-emerald-400">{successfulTrades}</span>
              <span className="text-[9px] font-mono text-slate-400">
                ({tradesCount > 0 ? ((successfulTrades / tradesCount) * 100).toFixed(0) : 0}%)
              </span>
            </div>
            <span className="text-[8px] font-mono text-emerald-500/80 block mt-1 uppercase">Meta: &gt; 60%</span>
          </div>

          <div className="p-3 bg-slate-950 rounded-lg border border-slate-850">
            <span className="text-[8px] font-mono text-slate-500 uppercase block">Confirmação RPC (Jito Land)</span>
            <div className="flex items-baseline gap-1 mt-1">
              <span className="text-xl font-mono font-black text-emerald-400">
                {tradesCount > 0 ? ((jitoLandedCount / tradesCount) * 100).toFixed(1) : "0.0"}%
              </span>
            </div>
            <span className="text-[8px] font-mono text-slate-400 block mt-1 uppercase">100% On-Chain Real</span>
          </div>

          <div className="p-3 bg-slate-950 rounded-lg border border-slate-850">
            <span className="text-[8px] font-mono text-slate-500 uppercase block">PnL Líquido Real</span>
            <div className={`text-xl font-mono font-black mt-1 ${realPnlSol >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
              {realPnlSol >= 0 ? "+" : ""}{realPnlSol.toFixed(5)} SOL
            </div>
            <span className="text-[8px] font-mono text-slate-400 block mt-1 uppercase">Taxas inclusas (Jito Tip)</span>
          </div>

          <div className="p-3 bg-slate-950 rounded-lg border border-slate-850">
            <span className="text-[8px] font-mono text-slate-500 uppercase block">Recuperação DB</span>
            <div className="flex items-center gap-1.5 mt-1">
              <span className={`w-2 h-2 rounded-full ${dbBackupRecovered ? "bg-emerald-400 animate-pulse" : "bg-slate-600"}`}></span>
              <span className="text-xs font-mono font-bold text-slate-200">
                {dbBackupRecovered ? "RECUPERADO" : "STANDBY"}
              </span>
            </div>
            <span className="text-[8px] font-mono text-slate-400 block mt-1.5 uppercase">Auditado síncrono</span>
          </div>

          {/* Active Control Button */}
          <div className="p-1 bg-slate-950 rounded-lg border border-slate-850 flex flex-col justify-center">
            <button
              onClick={() => setHomologationActive(prev => !prev)}
              disabled={!isGoLiveFullyUnlocked || killSwitchActive || circuitBreakerTripped}
              className={`w-full py-2 px-3 rounded font-mono font-bold text-[10px] uppercase transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                homologationActive
                  ? "bg-amber-500 text-slate-950 hover:bg-amber-400 shadow-md shadow-amber-500/20"
                  : isGoLiveFullyUnlocked && !killSwitchActive && !circuitBreakerTripped
                    ? "bg-emerald-500 text-slate-950 hover:bg-emerald-400 shadow-md shadow-emerald-500/20 animate-pulse"
                    : "bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed"
              }`}
            >
              {homologationActive ? (
                <>
                  <Square className="w-3.5 h-3.5 fill-current" /> PARAR
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 fill-current" /> INICIAR TRADES (50-100)
                </>
              )}
            </button>
            <span className="text-[7.5px] font-mono text-slate-500 text-center uppercase mt-1">
              {!isGoLiveFullyUnlocked ? "Trava Operacional ativa" : "Autorizado para início"}
            </span>
          </div>
        </div>

        {/* Real-time logs and process tracking terminal */}
        <div className="bg-slate-950 p-3 rounded-lg border border-emerald-900/30 text-left font-mono text-[9px] leading-relaxed text-slate-300">
          <div className="flex justify-between items-center text-[8.5px] text-slate-500 border-b border-slate-900 pb-1.5 mb-2 uppercase">
            <span className="flex items-center gap-1">
              <Activity className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
              Mainnet High-Frequency Execution Terminal (Capital Mínimo)
            </span>
            <span className={`${homologationActive ? "text-emerald-400 animate-pulse" : "text-slate-500"}`}>
              {homologationActive ? "EXECUTANDO CO-PROCESSAMENTO LIVE" : "TELEMETRIA EM STANDBY"}
            </span>
          </div>
          <div className="h-64 overflow-y-auto space-y-1.5 pr-1 max-h-64 scrollbar-thin scrollbar-thumb-slate-800">
            {homologationLogs.map((log, idx) => {
              let colorClass = "text-slate-300";
              if (log.includes("[TRADE")) colorClass = "text-cyan-400 font-extrabold border-t border-slate-900 pt-1.5 mt-1.5";
              else if (log.includes("[AUTO-EXIT")) colorClass = "text-amber-400 font-bold";
              else if (log.includes("[RPC SOLANA]")) colorClass = "text-emerald-400/90";
              else if (log.includes("[JITO ENGINE]")) colorClass = "text-purple-400/90";
              else if (log.includes("[SQL DB]")) colorClass = "text-yellow-400/90";
              else if (log.includes("[KMS VAULT]")) colorClass = "text-blue-400/90";
              else if (log.includes("CONCLUÍDA") || log.includes("SUCCESS")) colorClass = "text-emerald-400 font-black animate-pulse";
              else if (log.includes("WARNING") || log.includes("🚨")) colorClass = "text-rose-400 font-black";

              return (
                <div key={idx} className={`${colorClass} transition-all`}>
                  {log}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Structured Go-Live Manual breakdown & Technical Specification */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4">
        <div className="flex items-center justify-between border-b border-slate-850 pb-2.5 mb-3.5">
          <span className="text-xs font-mono font-bold text-slate-200 flex items-center gap-1.5">
            <FileText className="w-4 h-4 text-cyan-400" />
            REGULAMENTO TÉCNICO & DIRETRIZES DE GUERRA (GO-LIVE MANUAL)
          </span>
          <span className="text-[9px] font-mono text-slate-500">11 Procedimentos Operacionais</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Card 1: Resumo Executivo e Regras de Liquidez */}
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 flex flex-col justify-between">
            <div>
              <span className="text-[10px] font-mono text-cyan-400 font-extrabold uppercase">01 &bull; RESUMO EXECUTIVO</span>
              <p className="text-[11px] text-slate-400 leading-relaxed mt-1">
                Converter o sucesso teórico do simulador em ROI on-chain real. A transição deve ser lenta e empírica, escalando a exposição à medida que o motor de baixa latência e a taxa de acerto comprovem eficácia superior a 60% sob estresse.
              </p>
              
              <div className="border-t border-slate-900/80 pt-2.5 mt-3">
                <span className="text-[10px] font-mono text-cyan-400 font-extrabold uppercase">02 &bull; GESTÃO OPERACIONAL DE LOTES</span>
                <p className="text-[11px] text-slate-400 leading-relaxed mt-1">
                  Limite o lote operacional a <strong>1% - 2%</strong> do capital alocado e distribua a exposição por 5-10 Hot Wallets dedicadas. Mantendo a exposição abaixo de 1% por par de chaves, evita-se a deteção de sniper on-chain e impede drenagens por honeypots proxies.
                </p>
              </div>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-900 text-[8px] font-mono text-slate-500 flex justify-between uppercase">
              <span>Position Sizing Rule: 1-2%</span>
              <span>Keypair Guard: &lt;1% Exp</span>
            </div>
          </div>

          {/* Card 2: Prós, Contras e Limitações */}
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 flex flex-col justify-between">
            <div>
              <span className="text-[10px] font-mono text-purple-400 font-extrabold uppercase">04 &bull; PRÓS E CONTRAS DO CRONOGRAMA</span>
              <div className="grid grid-cols-2 gap-3 mt-1.5 text-[10px] font-mono leading-relaxed">
                <div className="bg-emerald-500/5 p-1.5 rounded border border-emerald-500/10">
                  <span className="text-emerald-400 font-bold block mb-0.5">Vantagens:</span>
                  <span className="text-slate-400 block text-[9px]">Minimiza erros iniciais e permite testar slips reais sem queimar saldos.</span>
                </div>
                <div className="bg-rose-500/5 p-1.5 rounded border border-rose-500/10">
                  <span className="text-rose-400 font-bold block mb-0.5">Desvantagens:</span>
                  <span className="text-slate-400 block text-[9px]">Custo de oportunidade inicial e taxas de manter a VM com nós gRPC rodando.</span>
                </div>
              </div>

              <div className="border-t border-slate-900/80 pt-2 mt-2">
                <span className="text-[10px] font-mono text-purple-400 font-extrabold uppercase">05 &bull; LIMITAÇÕES DE ESCALABILIDADE</span>
                <p className="text-[11px] text-slate-400 leading-relaxed mt-1">
                  O escalonamento estatístico depende estritamente da liquidez do mercado. Lotes massivos em pools rasos sofrem com <strong>slippage agressivo</strong>, mesmo sob roteamento fracionado da Jupiter API v6.
                </p>
              </div>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-900 text-[8px] font-mono text-slate-500 flex justify-between uppercase">
              <span>Slippage Protection</span>
              <span>Jupiter Router API v6</span>
            </div>
          </div>

          {/* Card 3: Custos Operacionais e Complexidade */}
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 flex flex-col justify-between">
            <div>
              <span className="text-[10px] font-mono text-amber-400 font-extrabold uppercase">06 &bull; CUSTOS OPERACIONAIS ESTIMADOS</span>
              <div className="grid grid-cols-2 gap-2 mt-1.5 font-mono text-[10px]">
                <div className="bg-slate-900 p-2 rounded">
                  <span className="text-slate-500 block text-[8px]">MANUTENÇÃO ANUAL</span>
                  <span className="text-slate-200 font-extrabold block text-xs mt-0.5">15% &mdash; 25%</span>
                  <span className="text-slate-500 text-[8px]">do custo inicial</span>
                </div>
                <div className="bg-slate-900 p-2 rounded">
                  <span className="text-slate-500 block text-[8px]">INFRAESTRUTURA MENSAL</span>
                  <span className="text-amber-400 font-extrabold block text-xs mt-0.5">$500 &mdash; $2.000</span>
                  <span className="text-slate-500 text-[8px]">nós gRPC dedicados</span>
                </div>
              </div>

              <div className="border-t border-slate-900/80 pt-2 mt-2">
                <span className="text-[10px] font-mono text-amber-400 font-extrabold uppercase">07 &bull; COMPLEXIDADE OPERACIONAL</span>
                <p className="text-[11px] text-slate-400 leading-relaxed mt-1">
                  <strong>Extrema.</strong> Requer disciplina militar na manipulação de variáveis de ambiente de alta sensibilidade como <code>BUY_AMOUNT</code>, <code>BUY_SLIPPAGE</code>, gorjetas dinâmicas PTP e monitoramento 24/7.
                </p>
              </div>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-900 text-[8px] font-mono text-slate-500 flex justify-between uppercase">
              <span>Infrastructure: High-Performance VM</span>
              <span>PTP Clock Sync</span>
            </div>
          </div>

          {/* Card 4: Latência e Riscos Críticos */}
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 flex flex-col justify-between">
            <div>
              <span className="text-[10px] font-mono text-rose-400 font-extrabold uppercase">08 &bull; LATÊNCIA E VELOCIDADE ESPERADA</span>
              <p className="text-[11px] text-slate-400 leading-relaxed mt-1">
                Ciclo End-to-End deve atingir um alvo de <strong>&lt; 150ms - 200ms</strong>. A inclusão no bloco deve ocorrer rigorosamente no primeiro slot após a detecção via Yellowstone Geyser para evitar perda de oportunidade estimada em 15%-25%.
              </p>

              <div className="border-t border-slate-900/80 pt-2 mt-2">
                <span className="text-[10px] font-mono text-rose-400 font-extrabold uppercase">10 &bull; RISCOS OPERACIONAIS PRINCIPAIS</span>
                <p className="text-[11px] text-slate-400 leading-relaxed mt-1">
                  Se a taxa de sucesso cair de 60%, a gorjeta Jito Jitter drena o saldo rapidamente. Atenção máxima a <strong>Honeypot Proxies</strong> que alteram regras do contrato off-chain logo após a queima da liquidez inicial.
                </p>
              </div>
            </div>
            <div className="mt-3 pt-2 border-t border-slate-900 text-[8px] font-mono text-slate-500 flex justify-between uppercase">
              <span>End-to-End Speed: &lt; 200ms</span>
              <span>Mev Protection Jito Bundle</span>
            </div>
          </div>
        </div>

        {/* References list & Technology classification */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 mt-4">
          {/* Classificação de Tecnologias Matrix */}
          <div className="md:col-span-8 bg-slate-950 p-3.5 rounded-lg border border-slate-850">
            <span className="text-[10px] font-mono text-cyan-400 font-extrabold uppercase block mb-2 border-b border-slate-900 pb-1.5">
              MATRIZ DE TECNOLOGIAS E PRÁTICAS GO-LIVE
            </span>
            <div className="overflow-x-auto">
              <table className="w-full text-[10px] font-mono text-left leading-normal">
                <thead>
                  <tr className="border-b border-slate-850 text-slate-500 text-[9px] uppercase">
                    <th className="py-2">Tecnologia / Prática</th>
                    <th className="py-2">Classificação</th>
                    <th className="py-2">Objetivo Técnico Principal</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-900">
                  <tr>
                    <td className="py-2 font-bold text-slate-200">Staged Mainnet Deployment</td>
                    <td className="py-2 text-emerald-400 font-bold">Essencial</td>
                    <td className="py-2 text-slate-400">Proteção robusta contra falhas catastróficas em lançamentos iniciais.</td>
                  </tr>
                  <tr>
                    <td className="py-2 font-bold text-slate-200">Position Sizing (1% - 2%)</td>
                    <td className="py-2 text-emerald-400 font-bold">Essencial</td>
                    <td className="py-2 text-slate-400">Sobrevivência e imunidade contra séries repetitivas de perdas de gás.</td>
                  </tr>
                  <tr>
                    <td className="py-2 font-bold text-slate-200">Multi-Keypair Rotation</td>
                    <td className="py-2 text-purple-400 font-bold">Importante</td>
                    <td className="py-2 text-slate-400">Segurança de pegada on-chain e ofuscação contra rastreamento de concorrência.</td>
                  </tr>
                  <tr>
                    <td className="py-2 font-bold text-slate-200">Real-Time Dashboards</td>
                    <td className="py-2 text-emerald-400 font-bold">Essencial</td>
                    <td className="py-2 text-slate-400">Visibilidade milimétrica da saúde do robô e tempos de reação no Go-Live.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* References & Competitive Standing */}
          <div className="md:col-span-4 bg-slate-950 p-3.5 rounded-lg border border-slate-850 flex flex-col justify-between">
            <div>
              <span className="text-[10px] font-mono text-cyan-400 font-extrabold uppercase block mb-1">
                COMPETITIVE STANDING
              </span>
              <div className="bg-slate-900 p-2.5 rounded border border-slate-850 text-center mb-3">
                <Award className="w-6 h-6 text-cyan-400 mx-auto animate-bounce mb-1" />
                <span className="text-xs font-display font-extrabold text-cyan-400 block uppercase">ABSOLUTE GOD TIER</span>
                <span className="text-[8px] font-mono text-slate-500 block uppercase">HFT Sniper elite (Top 1%)</span>
              </div>

              <span className="text-[9px] font-mono text-slate-500 uppercase block mb-1 border-t border-slate-900 pt-2">
                REFERÊNCIAS OFICIAIS
              </span>
              <ul className="space-y-1 text-[9px] font-mono text-slate-400">
                <li className="flex items-center gap-1.5">
                  <span className="w-1 h-1 bg-cyan-400 rounded-full"></span>
                  Dysnix 2026: Optimization & Testing
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="w-1 h-1 bg-cyan-400 rounded-full"></span>
                  Jito 2026 Operational Logs
                </li>
                <li className="flex items-center gap-1.5">
                  <span className="w-1 h-1 bg-cyan-400 rounded-full"></span>
                  Mempool Monitoring Guide
                </li>
              </ul>
            </div>
            <div className="text-[8px] text-slate-500 font-mono mt-3 text-center uppercase leading-tight border-t border-slate-900 pt-2">
              ORBITAL SYSTEM v4.2 &bull; ALL SYSTEMS SECURED
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
