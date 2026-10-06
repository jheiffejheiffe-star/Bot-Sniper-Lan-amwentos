import { useState, useEffect, useRef } from "react";
import { NetworkLatencyMonitor } from "./components/NetworkLatencyMonitor";
import { AutoSniperConsole } from "./components/AutoSniperConsole";
import { MevExecutionEngine } from "./components/MevExecutionEngine";
import { TransactionLogger } from "./components/TransactionLogger";
import { TokenAuditConsole } from "./components/TokenAuditConsole";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { DecisionEngine } from "./components/DecisionEngine";
import { MempoolScanner } from "./components/MempoolScanner";
import { HftStrategyVisualizer } from "./components/HftStrategyVisualizer";
import { DeterministicSimulator } from "./components/DeterministicSimulator";
import { HftTelemetryDashboard } from "./components/HftTelemetryDashboard";
import { HftSecurityShield } from "./components/HftSecurityShield";
import { GeyserGrpcRadar } from "./components/GeyserGrpcRadar";
import { PredictiveScoringEngine } from "./components/PredictiveScoringEngine";
import { PositionParachuteManager } from "./components/PositionParachuteManager";
import { MempoolBacktestSandbox } from "./components/MempoolBacktestSandbox";
import { RiskCircuitBreakerManager } from "./components/RiskCircuitBreakerManager";
import { MultiChainJupiterBridge } from "./components/MultiChainJupiterBridge";
import { ShadowWarSimulator } from "./components/ShadowWarSimulator";
import { ShadowVsRealityDashboard } from "./components/ShadowVsRealityDashboard";
import { GoLiveManual } from "./components/GoLiveManual";
import { ProductionReadinessReview } from "./components/ProductionReadinessReview";
import { EvidenceCenter } from "./components/EvidenceCenter";
import { ProductionReadinessCenter } from "./components/ProductionReadinessCenter";
import { MissionControl } from "./components/MissionControl";
import { ObservabilityCenter } from "./components/ObservabilityCenter";
import TruthBanner from "./components/TruthBanner";
import { StatisticalValidationCenter } from "./components/StatisticalValidationCenter";
import { SnipedTransaction } from "./types";
import { Coins, ShieldCheck, Activity, LogOut, Globe, Layers, Cpu } from "lucide-react";

export default function App() {
  const [transactions, setTransactions] = useState<SnipedTransaction[]>([]);
  const [walletConnected, setWalletConnected] = useState(true);
  const [activeTab, setActiveTab] = useState<"terminal" | "positions">("terminal");
  const [leftTab, setLeftTab] = useState<"radar" | "brain" | "strategy" | "portfolio" | "backtest" | "risk" | "multichain" | "shadow" | "comparison" | "golive" | "prr" | "evidence" | "prc" | "mc" | "observability" | "validation">("mc");
  const [rightTab, setRightTab] = useState<"security" | "execution">("security");
  const [currentTime, setCurrentTime] = useState("");
  const [blockHeight, setBlockHeight] = useState(278912440);
  const [tps, setTps] = useState(2450);

  // HFT Centralized Core states
  const [autonomousCoreEnabled, setAutonomousCoreEnabled] = useState(true);
  const [coreMode, setCoreMode] = useState<"shadow" | "real">("shadow");
  const [minScoreThreshold, setMinScoreThreshold] = useState<number>(70);
  const [coreLogs, setCoreLogs] = useState<Array<{ time: string; msg: string; type: string }>>([
    { time: new Date().toTimeString().split(' ')[0], msg: "Núcleo HFT inicializado com sucesso em Shadow Mode.", type: "info" },
    { time: new Date().toTimeString().split(' ')[0], msg: "Aguardando novos blocos Solana e transações de mempool...", type: "info" }
  ]);
  const lastProcessedMintRef = useRef<string>("");

  // Live mempool token selection
  const [selectedToken, setSelectedToken] = useState<{ name: string; mint: string } | null>(null);

  // Sync state between Decision Engine & AutoSniperConsole
  const [syncedParams, setSyncedParams] = useState<{
    solAmount: string;
    slippage: string;
    priorityTip: string;
    stopLoss: string;
    takeProfit: string;
    antiRugShield: boolean;
  } | null>(null);

  const [lastAuditedToken, setLastAuditedToken] = useState<any>(null);

  // Simulated live positions with base PnL percentage
  const [positions, setPositions] = useState<any[]>([
    { id: "pos_1", token: "PUMP", qty: "142,500", avgEntry: "0.000035 SOL", valueSol: "4.98 SOL", pnlPercent: 15.2, pnl: "+15.2%", isGain: true },
    { id: "pos_2", token: "SOLCAT", qty: "2,410,000", avgEntry: "0.0000041 SOL", valueSol: "9.88 SOL", pnlPercent: -1.2, pnl: "-1.2%", isGain: false }
  ]);

  const loadSnipes = async () => {
    try {
      const res = await fetch("/api/snipes");
      const data = await res.json();
      setTransactions(data);
    } catch (e) {
      console.warn("Failed to load initial snipes (using local storage fallback)", e);
    }
  };

  // 1. Live price fluctuations effect
  useEffect(() => {
    const priceInterval = setInterval(() => {
      setPositions(prevPositions => {
        return prevPositions.map(pos => {
          // Live price drift: random value between -4% and +5%
          const drift = (Math.random() * 9) - 4;
          const updatedPnlPercent = Math.round((pos.pnlPercent + drift) * 10) / 10;
          
          // Calculate new value in SOL based on entry and drift
          const entryValue = parseFloat(pos.valueSol) / (1 + (pos.pnlPercent || 0) / 100);
          const updatedValueSol = (entryValue * (1 + updatedPnlPercent / 100)).toFixed(2);
          
          return {
            ...pos,
            pnlPercent: updatedPnlPercent,
            valueSol: `${updatedValueSol} SOL`,
            pnl: `${updatedPnlPercent >= 0 ? "+" : ""}${updatedPnlPercent}%`,
            isGain: updatedPnlPercent >= 0
          };
        });
      });
    }, 4000);

    return () => clearInterval(priceInterval);
  }, []);

  // 2. Automated Exit Monitor (Take Profit / Stop Loss)
  useEffect(() => {
    const slLimit = syncedParams ? -Math.abs(parseFloat(syncedParams.stopLoss)) : -18;
    const tpLimit = syncedParams ? Math.abs(parseFloat(syncedParams.takeProfit)) : 100;

    positions.forEach(pos => {
      const currentPnl = pos.pnlPercent || 0;
      if (currentPnl <= slLimit) {
        triggerAutoExit(pos, "Stop-Loss", currentPnl);
      } else if (currentPnl >= tpLimit) {
        triggerAutoExit(pos, "Take-Profit", currentPnl);
      }
    });
  }, [positions, syncedParams]);

  const triggerAutoExit = (pos: any, reason: "Stop-Loss" | "Take-Profit", currentPnl: number) => {
    // Instantly remove to avoid multiple triggers
    setPositions(prev => prev.filter(p => p.id !== pos.id));

    const exitTx: SnipedTransaction = {
      id: `txn_${Date.now()}`,
      token: pos.token,
      mint: "Jito BlockEngine Flash-Exit",
      amount: pos.valueSol,
      outAmount: `Auto-Exit (${reason} @ ${currentPnl >= 0 ? "+" : ""}${currentPnl}%)`,
      time: new Date().toTimeString().split(' ')[0],
      latencyMs: 8,
      status: currentPnl >= 0 ? "success" : "failed",
      block: blockHeight + 1,
      tipSol: syncedParams ? parseFloat(syncedParams.priorityTip) : 0.002,
      route: `Jito Bundler (${reason})`
    };

    setTransactions(prev => [exitTx, ...prev]);
  };

  useEffect(() => {
    loadSnipes();

    // Live clock
    const clockInterval = setInterval(() => {
      const now = new Date();
      setCurrentTime(now.toTimeString().split(' ')[0] + " UTC");
    }, 1000);

    // Live slot updates
    const slotInterval = setInterval(() => {
      setBlockHeight(prev => prev + 1 + Math.floor(Math.random() * 2));
      setTps(prev => Math.min(3200, Math.max(1800, prev + Math.floor(Math.random() * 200) - 100)));
    }, 1500);

    return () => {
      clearInterval(clockInterval);
      clearInterval(slotInterval);
    };
  }, []);

  const handleNewSnipe = (newTx: SnipedTransaction) => {
    // Refresh list of transactions
    setTransactions(prev => [newTx, ...prev]);

    // Dynamically insert into active positions
    if (newTx.status === "success" && parseFloat(newTx.outAmount) > 0) {
      const parsedOut = parseFloat(newTx.outAmount.replace(/,/g, ''));
      const newPos = {
        id: `pos_${Date.now()}`,
        token: newTx.token,
        qty: newTx.outAmount.split(' ')[0],
        avgEntry: `${(parseFloat(newTx.amount) / (parsedOut || 1)).toFixed(8)} SOL`,
        valueSol: newTx.amount,
        pnlPercent: 0.0,
        pnl: "0.0%",
        isGain: true
      };
      setPositions(prev => [newPos, ...prev]);
    }
  };

  const handleSellPosition = (id: string, token: string, pct: number = 100, reason?: string) => {
    const posToSell = positions.find(pos => pos.id === id);
    if (!posToSell) return;

    if (pct >= 100) {
      setPositions(prev => prev.filter(pos => pos.id !== id));
    } else {
      setPositions(prev => prev.map(pos => {
        if (pos.id === id) {
          const cleanQty = parseFloat(pos.qty.replace(/,/g, ''));
          const newQty = cleanQty * (1 - pct / 100);
          const currentValue = parseFloat(pos.valueSol);
          const newValue = currentValue * (1 - pct / 100);
          return {
            ...pos,
            qty: newQty.toLocaleString(undefined, { maximumFractionDigits: 0 }),
            valueSol: `${newValue.toFixed(2)} SOL`
          };
        }
        return pos;
      }));
    }

    const soldAmount = posToSell ? `${(parseFloat(posToSell.valueSol) * (pct / 100)).toFixed(2)} SOL` : "0.0 SOL";
    const outLabel = reason ? `Saída Layer 7 (${reason})` : `Exit Position ${pct}% (${token})`;

    // Add transaction log entry for sale
    const saleTx: SnipedTransaction = {
      id: `txn_${Date.now()}`,
      token,
      mint: reason ? "Jito BlockEngine Flash-Exit" : "Sold on Jupiter v6",
      amount: soldAmount,
      outAmount: outLabel,
      time: new Date().toTimeString().split(' ')[0],
      latencyMs: reason ? Math.floor(Math.random() * 5) + 6 : 11,
      status: "success",
      block: blockHeight + 1,
      tipSol: reason ? 0.005 : 0.001,
      route: reason ? `Jito Bundler (${reason})` : "Jupiter Router v6"
    };
    setTransactions(prev => [saleTx, ...prev]);
  };

  const handleTokenDetected = async (token: { name: string; mint: string; type: string; solAmount: string }) => {
    if (!autonomousCoreEnabled) return;
    if (token.mint === lastProcessedMintRef.current) return;
    lastProcessedMintRef.current = token.mint;

    const nowTime = new Date().toTimeString().split(' ')[0];

    // 1. DETECT
    const detectLog = {
      time: nowTime,
      msg: `[DETECTADO] Novo token ${token.name} (${token.mint.slice(0, 8)}...) interceptado via Yellowstone Geyser gRPC.`,
      type: "detect"
    };
    setCoreLogs(prev => [detectLog, ...prev].slice(0, 35));

    // 2. DECIDE (fetch predictive score asynchronously in background)
    try {
      const response = await fetch("/api/predictive-score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenMint: token.mint, tokenName: token.name, useGemini: false })
      });
      const data = await response.json();
      
      const scoreTime = new Date().toTimeString().split(' ')[0];
      const decideLog = {
        time: scoreTime,
        msg: `[DECIDIR] Auditoria off-chain para ${token.name}. Opportunity Score: ${data.score}/100. Classe: ${data.predictionClass}.`,
        type: "decide"
      };
      setCoreLogs(prev => [decideLog, ...prev].slice(0, 35));

      // 3. FILTER & EXECUTE
      if (data.score >= minScoreThreshold) {
        const approvedLog = {
          time: scoreTime,
          msg: `[DECIDIR] Token ${token.name} aprovado! Score ${data.score} >= ${minScoreThreshold}. Disparando transação privada...`,
          type: "execute"
        };
        setCoreLogs(prev => [approvedLog, ...prev].slice(0, 35));

        // EXECUTE (fetch buy simulation)
        const snipeRes = await fetch("/api/simulate-snipe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tokenName: token.name,
            tokenMint: token.mint,
            solAmount: coreMode === "real" ? "1.5" : "0.0", // Shadow Mode has 0 SOL real cost
            priorityTip: syncedParams ? syncedParams.priorityTip : "0.005",
            useJito: true,
            route: "Jupiter Router v6",
            antiRugShield: true
          })
        });
        const snipeData = await snipeRes.json();
        
        const execTime = new Date().toTimeString().split(' ')[0];
        if (snipeData.success && snipeData.transaction) {
          const finishedTx = {
            ...snipeData.transaction,
            route: coreMode === "shadow" ? "Jito Shadow Bundle" : "Jito Bundle (Mainnet)",
            token: coreMode === "shadow" ? `[SHADOW] ${token.name}` : token.name
          };

          // Log transaction
          setTransactions(prev => [finishedTx, ...prev]);

          // Manage Positions
          const parsedOut = parseFloat(finishedTx.outAmount.replace(/,/g, ''));
          const newPos = {
            id: `pos_${Date.now()}`,
            token: finishedTx.token,
            qty: finishedTx.outAmount.split(' ')[0],
            avgEntry: `${(parseFloat(finishedTx.amount) / (parsedOut || 1)).toFixed(8)} SOL`,
            valueSol: finishedTx.amount || "1.50 SOL",
            pnlPercent: 0.0,
            pnl: "0.0%",
            isGain: true,
            isShadow: coreMode === "shadow"
          };
          setPositions(prev => [newPos, ...prev]);

          const successLog = {
            time: execTime,
            msg: `[EXECUTAR] Compra de ${token.name} concluída com sucesso via ${finishedTx.route}.`,
            type: "manage"
          };
          setCoreLogs(prev => [successLog, ...prev].slice(0, 35));
        } else {
          const failLog = {
            time: execTime,
            msg: `[FALHA] Transação de compra rejeitada pelos validadores Solana.`,
            type: "error"
          };
          setCoreLogs(prev => [failLog, ...prev].slice(0, 35));
        }
      } else {
        const rejectLog = {
          time: scoreTime,
          msg: `[FILTRAR] Token ${token.name} descartado. Score ${data.score}/100 abaixo do limite de segurança (${minScoreThreshold}).`,
          type: "info"
        };
        setCoreLogs(prev => [rejectLog, ...prev].slice(0, 35));
      }
    } catch (err) {
      console.warn("Core Engine execution error (handled gracefully):", err);
    }
  };

  // Background Autonomous Core Loop Emitter
  useEffect(() => {
    if (!autonomousCoreEnabled) return;

    const tokenNames = ["NEURAL_NET", "CYBER_PUNK", "SOL_TURBO", "ALPHA_AI", "PEPE_SOL", "RUG_TRAP", "MEME_KING"];
    const tokenMints = [
      "Neur6718291882Hdkas9812hasd812hasd281H",
      "Cybe91283hds98dsa9812hsa9812hasd8912hs",
      "Turb82391has89das89213hasd89213has892d",
      "Alph78129329DfGgHiJkLmNoPqRsTuVwXyZ1234",
      "Pep3JtE718291abcDeFgHiJkLmNoPqRsTuVwXyZ1",
      "RugT1111111111111111111111111111111111",
      "King777123912Aasdasdsa8912hads9812hasdH"
    ];

    const interval = setInterval(() => {
      const idx = Math.floor(Math.random() * tokenNames.length);
      const randomSize = (Math.random() * 8 + 1).toFixed(1);

      const mockEvent = {
        name: tokenNames[idx],
        mint: tokenMints[idx],
        type: tokenNames[idx] === "RUG_TRAP" ? "RUG_PULL_ATTEMPT" : "LP_INITIALIZE",
        solAmount: randomSize
      };

      handleTokenDetected(mockEvent);
    }, 9000); // Automatically trigger every 9 seconds for high-density action

    return () => clearInterval(interval);
  }, [autonomousCoreEnabled, coreMode, minScoreThreshold, syncedParams]);

  return (
    <div id="solana-sniper-app" className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans select-none pb-12">
      {/* Decorative top grid lines */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#0f172a_1px,transparent_1px),linear-gradient(to_bottom,#0f172a_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] pointer-events-none z-0"></div>

      {/*
        BANNER DE VERDADE — acima de tudo e permanente.
        Vários painéis abaixo exibem números aleatórios gerados no servidor. Sem esta
        declaração, "inclusion rate" e "P95 de latência" seriam lidos como desempenho
        medido. Recolhível, mas nunca oculto por completo.
      */}
      <div className="relative z-20">
        <TruthBanner />
      </div>

      {/* Header */}
      <header className="relative z-10 border-b border-slate-900 bg-slate-950/70 backdrop-blur-md px-6 py-4 flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center glow-cyan">
            <Coins className="w-5 h-5 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-xl font-display font-bold tracking-tight text-slate-100 flex items-center gap-2">
              ORBITAL <span className="text-cyan-400 font-extrabold">SOLANA SNIPER</span>
            </h1>
            <p className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">HFT MEV-Shield Broker Console v4.2</p>
          </div>
        </div>

        {/* Realtime Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 bg-slate-900/40 border border-slate-850/60 rounded-xl px-5 py-2.5">
          <div className="flex flex-col">
            <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wider flex items-center gap-1">
              <Globe className="w-3 h-3 text-cyan-500" /> Network Time
            </span>
            <span className="text-xs font-mono font-bold text-slate-200 mt-0.5">{currentTime || "Syncing..."}</span>
          </div>

          <div className="flex flex-col">
            <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wider flex items-center gap-1">
              <Layers className="w-3 h-3 text-emerald-500" /> Current Slot
            </span>
            <span className="text-xs font-mono font-bold text-emerald-400 mt-0.5">{blockHeight}</span>
          </div>

          <div className="flex flex-col">
            <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wider flex items-center gap-1">
              <Activity className="w-3 h-3 text-cyan-500" /> Solana TPS
            </span>
            <span className="text-xs font-mono font-bold text-slate-200 mt-0.5">{tps} tx/s</span>
          </div>

          <div className="flex flex-col">
            <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wider flex items-center gap-1">
              <ShieldCheck className="w-3 h-3 text-cyan-400" /> Security State
            </span>
            <span className="text-[11px] font-mono font-bold text-cyan-400 uppercase tracking-wider mt-0.5">SHIELDED</span>
          </div>
        </div>

        {/* Wallet Connection */}
        <div className="flex items-center gap-3">
          {walletConnected ? (
            <div className="flex items-center gap-3 bg-slate-900/60 border border-slate-800 rounded-lg px-4 py-1.5">
              <div className="flex flex-col items-end">
                <span className="text-[10px] font-mono text-slate-500 uppercase">Broker Balance</span>
                <span className="text-xs font-mono font-bold text-slate-200">14.85 SOL</span>
              </div>
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></div>
              <button
                onClick={() => setWalletConnected(false)}
                className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-rose-400 transition-colors cursor-pointer"
                title="Disconnect broker"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setWalletConnected(true)}
              className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-display font-semibold text-xs rounded-lg transition-all cursor-pointer glow-cyan"
            >
              Connect Broker Wallet
            </button>
          )}
        </div>
      </header>

      {/* Main Container */}
      <main className="relative z-10 flex-1 max-w-7xl w-full mx-auto px-4 py-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
        
        {/* Left column (Network Latency & Sniper setup) */}
        <div className="lg:col-span-2 space-y-4">
          
          {/* HFT Centralized Autonomous Core Controller */}
          <div id="hft-central-core-controller" className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 backdrop-blur-md relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none"></div>
            
            {/* Title & Status */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-850 pb-3 mb-3">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center border transition-all ${
                  autonomousCoreEnabled 
                    ? "bg-cyan-500/10 border-cyan-500/30 glow-cyan" 
                    : "bg-slate-950 border-slate-850"
                }`}>
                  <Cpu className={`w-5 h-5 ${autonomousCoreEnabled ? "text-cyan-400 animate-spin-slow" : "text-slate-500"}`} />
                </div>
                <div>
                  <h2 className="text-sm font-display font-bold text-slate-100 flex items-center gap-2">
                    NÚCLEO OPERACIONAL CENTRAL HFT
                    {autonomousCoreEnabled ? (
                      <span className="text-[9px] font-mono font-extrabold px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 animate-pulse uppercase tracking-wider">
                        ATIVO (AUTÔNOMO)
                      </span>
                    ) : (
                      <span className="text-[9px] font-mono font-bold px-2 py-0.5 rounded bg-slate-850 border border-slate-800 text-slate-400 uppercase tracking-wider">
                        STANDBY
                      </span>
                    )}
                  </h2>
                  <p className="text-[10px] font-mono text-slate-400 uppercase tracking-wider mt-0.5">
                    Sincronização de Pipeline: Detecção (gRPC) → Decisão (AI L6) → Execução (Jito) → Gestão (SL/TP)
                  </p>
                </div>
              </div>

              {/* Master Activation Switch */}
              <button
                onClick={() => setAutonomousCoreEnabled(!autonomousCoreEnabled)}
                className={`px-4 py-2 rounded-lg text-xs font-mono font-bold uppercase transition-all cursor-pointer border ${
                  autonomousCoreEnabled
                    ? "bg-rose-500/10 text-rose-400 border-rose-500/30 hover:bg-rose-500/20"
                    : "bg-cyan-500/10 text-cyan-400 border-cyan-500/30 hover:bg-cyan-500/20"
                }`}
              >
                {autonomousCoreEnabled ? "DESATIVAR NÚCLEO AUTÔNOMO" : "ATIVAR NÚCLEO AUTÔNOMO"}
              </button>
            </div>

            {/* Config & Metrics Row */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
              {/* Core Mode Config */}
              <div className="bg-slate-950/60 border border-slate-850 p-3 rounded-lg flex flex-col justify-between">
                <div>
                  <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wider block mb-1.5">MODO DE VALIDAÇÃO</span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setCoreMode("shadow")}
                      className={`flex-1 py-1 px-2 text-[10px] font-mono font-bold rounded transition-all cursor-pointer border ${
                        coreMode === "shadow"
                          ? "bg-purple-500/15 text-purple-400 border-purple-500/30"
                          : "bg-slate-900 text-slate-400 border-slate-850 hover:text-slate-200"
                      }`}
                    >
                      SHADOW MODE
                    </button>
                    <button
                      onClick={() => setCoreMode("real")}
                      className={`flex-1 py-1 px-2 text-[10px] font-mono font-bold rounded transition-all cursor-pointer border ${
                        coreMode === "real"
                          ? "bg-cyan-500/15 text-cyan-400 border-cyan-500/30"
                          : "bg-slate-900 text-slate-400 border-slate-850 hover:text-slate-200"
                      }`}
                    >
                      REAL MODE
                    </button>
                  </div>
                </div>
                <p className="text-[8px] font-mono text-slate-500 leading-relaxed mt-2 uppercase">
                  {coreMode === "shadow" 
                    ? "✓ Simula ordens com latência real sem deduzir saldo. Risco Zero." 
                    : "⚠ Conecta à carteira para transações reais de mainnet."}
                </p>
              </div>

              {/* Score Filter Config */}
              <div className="bg-slate-950/60 border border-slate-850 p-3 rounded-lg flex flex-col justify-between">
                <div>
                  <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wider block mb-1">LIMITE DE DECISÃO IA</span>
                  <div className="flex items-center justify-between text-xs font-mono font-bold mb-1">
                    <span className="text-slate-400">Score Mínimo:</span>
                    <span className="text-cyan-400">{minScoreThreshold}/100</span>
                  </div>
                  <input
                    type="range"
                    min="40"
                    max="95"
                    value={minScoreThreshold}
                    onChange={(e) => setMinScoreThreshold(parseInt(e.target.value))}
                    className="w-full accent-cyan-500 bg-slate-900 rounded-lg cursor-pointer h-1"
                  />
                </div>
                <span className="text-[8px] font-mono text-slate-500 uppercase tracking-wider mt-2.5 block">
                  Rejeita contratos suspeitos ou honeypots
                </span>
              </div>

              {/* Shadow Validation Live Metrics */}
              <div className="bg-slate-950/60 border border-slate-850 p-3 rounded-lg flex flex-col justify-between">
                <div>
                  <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wider block mb-1.5">METRICAS SHADOW LIVE</span>
                  <div className="space-y-1 text-[10px] font-mono">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Latência de Ingestão:</span>
                      <span className="text-emerald-400 font-bold">0.32 ms</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Inclusão Jito Bundle:</span>
                      <span className="text-cyan-400 font-bold">98.4%</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Gargalos Event-Loop:</span>
                      <span className="text-emerald-400 font-bold">0 detectados</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 text-[8px] font-mono text-slate-500 uppercase">
                  <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></span>
                  Estabilidade do Núcleo: 100% OK
                </div>
              </div>
            </div>

            {/* Core logs tracking pipeline */}
            <div className="bg-slate-950 p-3 rounded-lg border border-slate-850">
              <span className="text-[8px] font-mono text-slate-500 uppercase tracking-wider block mb-2 pb-1 border-b border-slate-900 flex items-center justify-between">
                <span>PIPELINE TRACE LOG (INTEGRAÇÃO DE PROCESSO)</span>
                <span className="text-cyan-400/80">LIVE FEED</span>
              </span>
              
              <div className="h-28 overflow-y-auto space-y-1.5 pr-1 font-mono text-[10px] leading-relaxed scrollbar-thin">
                {coreLogs.map((log, i) => {
                  let colorClass = "text-slate-400";
                  if (log.type === "detect") colorClass = "text-amber-400 font-medium";
                  if (log.type === "decide") colorClass = "text-purple-400 font-medium";
                  if (log.type === "execute") colorClass = "text-cyan-400 font-bold";
                  if (log.type === "manage") colorClass = "text-emerald-400 font-bold";
                  if (log.type === "error") colorClass = "text-rose-400 font-bold animate-pulse";
                  
                  return (
                    <div key={i} className="flex items-start gap-2 border-b border-slate-900/40 pb-1 last:border-0">
                      <span className="text-slate-600 shrink-0">[{log.time}]</span>
                      <span className={colorClass}>{log.msg}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <NetworkLatencyMonitor />
            <AutoSniperConsole onSnipeSuccess={handleNewSnipe} syncedParams={syncedParams} selectedToken={selectedToken} />
          </div>

          {/* High-density Terminal Tab Navigation */}
          <div className="bg-slate-900/60 border border-slate-850 p-1 rounded-lg flex items-center justify-between backdrop-blur-md">
            <div className="flex flex-wrap items-center gap-1">
              <button
                onClick={() => setLeftTab("mc")}
                className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded transition-all cursor-pointer flex items-center gap-1.5 ${
                  leftTab === "mc"
                    ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 border border-transparent"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${leftTab === "mc" ? "bg-emerald-400 animate-pulse" : "bg-slate-600"}`}></span>
                🛡️ L15 &mdash; MISSION CONTROL
              </button>
              <button
                id="tab-observability-btn"
                onClick={() => setLeftTab("observability")}
                className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded transition-all cursor-pointer flex items-center gap-1.5 ${
                  leftTab === "observability"
                    ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 border border-transparent"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${leftTab === "observability" ? "bg-cyan-400 animate-pulse" : "bg-slate-600"}`}></span>
                📊 L16 &mdash; OBSERVABILIDADE (E7)
              </button>
              <button
                onClick={() => setLeftTab("radar")}
                className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded transition-all cursor-pointer flex items-center gap-1.5 ${
                  leftTab === "radar"
                    ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 border border-transparent"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${leftTab === "radar" ? "bg-cyan-400 animate-pulse" : "bg-slate-600"}`}></span>
                📡 RADAR & INGESTÃO
              </button>
              <button
                onClick={() => setLeftTab("brain")}
                className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded transition-all cursor-pointer flex items-center gap-1.5 ${
                  leftTab === "brain"
                    ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 border border-transparent"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${leftTab === "brain" ? "bg-cyan-400 animate-pulse" : "bg-slate-600"}`}></span>
                🧠 CÉREBRO DE IA (L6)
              </button>
              <button
                onClick={() => setLeftTab("strategy")}
                className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded transition-all cursor-pointer flex items-center gap-1.5 ${
                  leftTab === "strategy"
                    ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 border border-transparent"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${leftTab === "strategy" ? "bg-cyan-400 animate-pulse" : "bg-slate-600"}`}></span>
                📈 ESTRATÉGIA & TELEMETRIA
              </button>
              <button
                onClick={() => setLeftTab("portfolio")}
                className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded transition-all cursor-pointer flex items-center gap-1.5 ${
                  leftTab === "portfolio"
                    ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 border border-transparent"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${leftTab === "portfolio" ? "bg-cyan-400 animate-pulse" : "bg-slate-600"}`}></span>
                💼 CARTEIRA & HISTÓRICO
              </button>
              <button
                onClick={() => setLeftTab("backtest")}
                className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded transition-all cursor-pointer flex items-center gap-1.5 ${
                  leftTab === "backtest"
                    ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 border border-transparent"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${leftTab === "backtest" ? "bg-cyan-400 animate-pulse" : "bg-slate-600"}`}></span>
                🔬 BACKTEST & REPLAY (L8)
              </button>
              <button
                onClick={() => setLeftTab("risk")}
                className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded transition-all cursor-pointer flex items-center gap-1.5 ${
                  leftTab === "risk"
                    ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 border border-transparent"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${leftTab === "risk" ? "bg-cyan-400 animate-pulse" : "bg-slate-600"}`}></span>
                🛡️ DISJUNTORES DE RISCO (L9)
              </button>
              <button
                onClick={() => setLeftTab("multichain")}
                className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded transition-all cursor-pointer flex items-center gap-1.5 ${
                  leftTab === "multichain"
                    ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 border border-transparent"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${leftTab === "multichain" ? "bg-cyan-400 animate-pulse" : "bg-slate-600"}`}></span>
                🌐 MULTI-CHAIN & JUPITER (L10)
              </button>
              <button
                onClick={() => setLeftTab("shadow")}
                className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded transition-all cursor-pointer flex items-center gap-1.5 ${
                  leftTab === "shadow"
                    ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 border border-transparent"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${leftTab === "shadow" ? "bg-cyan-400 animate-pulse" : "bg-slate-600"}`}></span>
                ⚔️ SHADOW SIMULATOR (L11)
              </button>
              <button
                onClick={() => setLeftTab("comparison")}
                className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded transition-all cursor-pointer flex items-center gap-1.5 ${
                  leftTab === "comparison"
                    ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 border border-transparent"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${leftTab === "comparison" ? "bg-cyan-400 animate-pulse" : "bg-slate-600"}`}></span>
                🔍 COMPARATIVO REALITY (L8.5)
              </button>
              <button
                id="tab-validation-btn"
                onClick={() => setLeftTab("validation")}
                className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded transition-all cursor-pointer flex items-center gap-1.5 ${
                  leftTab === "validation"
                    ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 border border-transparent"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${leftTab === "validation" ? "bg-cyan-400 animate-pulse" : "bg-slate-600"}`}></span>
                📈 VALIDAÇÃO ESTATÍSTICA (E8)
              </button>
              <button
                onClick={() => setLeftTab("golive")}
                className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded transition-all cursor-pointer flex items-center gap-1.5 ${
                  leftTab === "golive"
                    ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 border border-transparent"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${leftTab === "golive" ? "bg-cyan-400 animate-pulse" : "bg-slate-600"}`}></span>
                🚀 GO-LIVE READY (L12)
              </button>
              <button
                onClick={() => setLeftTab("prr")}
                className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded transition-all cursor-pointer flex items-center gap-1.5 ${
                  leftTab === "prr"
                    ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 border border-transparent"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${leftTab === "prr" ? "bg-emerald-400 animate-pulse" : "bg-slate-600"}`}></span>
                🛡️ AUDITORIA PRR (L13)
              </button>
              <button
                onClick={() => setLeftTab("evidence")}
                className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded transition-all cursor-pointer flex items-center gap-1.5 ${
                  leftTab === "evidence"
                    ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 border border-transparent"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${leftTab === "evidence" ? "bg-cyan-400 animate-pulse" : "bg-slate-600"}`}></span>
                📊 EVIDENCE CENTER (L13.5)
              </button>
              <button
                onClick={() => setLeftTab("prc")}
                className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded transition-all cursor-pointer flex items-center gap-1.5 ${
                  leftTab === "prc"
                    ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-sm"
                    : "text-slate-400 hover:text-slate-200 border border-transparent"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${leftTab === "prc" ? "bg-emerald-400 animate-pulse" : "bg-slate-600"}`}></span>
                ⚙️ OPERAÇÕES L14 (PRC)
              </button>
            </div>
            <span className="text-[9px] font-mono text-slate-500 hidden sm:inline uppercase mr-2">HFT COCKPIT FEED</span>
          </div>

          <div className="space-y-4">
            {leftTab === "radar" && (
              <>
                <MempoolScanner onSelectToken={setSelectedToken} onTokenDetected={handleTokenDetected} />
                <GeyserGrpcRadar />
              </>
            )}

            {leftTab === "brain" && (
              <PredictiveScoringEngine selectedToken={selectedToken} onScoringComplete={(res) => {
                if (res) {
                  setLastAuditedToken({
                    name: res.name,
                    mint: res.mint,
                    score: res.score,
                    isRug: res.score < 40,
                    renounced: res.score >= 40,
                    liquidityLocked: res.score >= 40 ? "99% (Burned)" : "0%",
                    topHoldersShare: res.score >= 40 ? "3.2%" : "45%",
                    freezeAuthorityDisabled: res.score >= 40,
                    mintAuthorityDisabled: res.score >= 40,
                    creatorAllocation: res.score >= 40 ? "0.5%" : "15.0%",
                    taxBuySell: res.score >= 40 ? "0% / 0%" : "30% / 30%"
                  });
                }
              }} />
            )}

            {leftTab === "strategy" && (
              <>
                <HftStrategyVisualizer />
                <HftTelemetryDashboard />
              </>
            )}

            {leftTab === "portfolio" && (
              <>
                {/* Active Positions & Token Portfolio tabs */}
                <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 backdrop-blur-md relative overflow-hidden">
                  <div className="flex items-center justify-between mb-2.5 border-b border-slate-800 pb-2">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => setActiveTab("terminal")}
                        className={`text-sm font-display font-semibold px-3 py-1.5 rounded-lg transition-all cursor-pointer ${
                          activeTab === "terminal"
                            ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/30"
                            : "text-slate-400 hover:text-slate-200"
                        }`}
                      >
                        Live Swapped Portfolio
                      </button>
                      <button
                        onClick={() => setActiveTab("positions")}
                        className={`text-sm font-display font-semibold px-3 py-1.5 rounded-lg transition-all cursor-pointer ${
                          activeTab === "positions"
                            ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/30"
                            : "text-slate-400 hover:text-slate-200"
                        }`}
                      >
                        Active Escrow PnL ({positions.length})
                      </button>
                    </div>

                    <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest bg-slate-950 px-2.5 py-0.5 rounded-full border border-slate-850">
                      100% CLIENT CONTROL
                    </span>
                  </div>

                  {activeTab === "terminal" ? (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="p-3 bg-slate-950 rounded-lg border border-slate-850">
                        <span className="text-[10px] font-mono text-slate-500 uppercase">SOL Balance</span>
                        <span className="text-xl font-mono font-bold text-slate-100 mt-1 block">14.85 SOL</span>
                        <span className="text-[10px] font-mono text-slate-400 block mt-0.5">$1,856.25 USD</span>
                      </div>
                      <div className="p-3 bg-slate-950 rounded-lg border border-slate-850">
                        <span className="text-[10px] font-mono text-slate-500 uppercase">Net Sniper Capital</span>
                        <span className="text-xl font-mono font-bold text-cyan-400 mt-1 block">25.00 SOL</span>
                        <span className="text-[10px] font-mono text-slate-400 block mt-0.5">Asset reserve verified</span>
                      </div>
                      <div className="p-3 bg-slate-950 rounded-lg border border-slate-850">
                        <span className="text-[10px] font-mono text-slate-500 uppercase">Jito Total Tips Paid</span>
                        <span className="text-xl font-mono font-bold text-emerald-400 mt-1 block">0.145 SOL</span>
                        <span className="text-[10px] font-mono text-slate-400 block mt-0.5">Private routing optimized</span>
                      </div>
                    </div>
                  ) : (
                    <PositionParachuteManager 
                      positions={positions} 
                      onSellPosition={handleSellPosition} 
                      syncedParams={syncedParams} 
                    />
                  )}
                </div>
                <TransactionLogger transactions={transactions} />
              </>
            )}

            {leftTab === "backtest" && (
              <MempoolBacktestSandbox />
            )}

            {leftTab === "risk" && (
              <RiskCircuitBreakerManager walletConnected={walletConnected} onSetWalletConnected={setWalletConnected} />
            )}

            {leftTab === "multichain" && (
              <MultiChainJupiterBridge />
            )}

            {leftTab === "shadow" && (
              <ShadowWarSimulator />
            )}

            {leftTab === "comparison" && (
              <ShadowVsRealityDashboard />
            )}

            {leftTab === "validation" && (
              <StatisticalValidationCenter />
            )}

            {leftTab === "golive" && (
              <GoLiveManual />
            )}

            {leftTab === "prr" && (
              <ProductionReadinessReview />
            )}

            {leftTab === "evidence" && (
              <EvidenceCenter />
            )}

            {leftTab === "prc" && (
              <ProductionReadinessCenter />
            )}

            {leftTab === "mc" && (
              <MissionControl setLeftTab={setLeftTab} />
            )}

            {leftTab === "observability" && (
              <ObservabilityCenter />
            )}
          </div>
        </div>

        {/* Right column (Smart Contract Safety, MEV levels, Pre-flight checks) */}
        <div className="space-y-4">
          
          {/* Safety & Execution Switcher */}
          <div className="bg-slate-900/60 border border-slate-850 p-1 rounded-lg flex items-center backdrop-blur-md">
            <button
              onClick={() => setRightTab("security")}
              className={`text-[11px] font-mono font-bold py-1.5 rounded transition-all cursor-pointer flex-1 flex items-center justify-center gap-1.5 ${
                rightTab === "security"
                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-sm"
                  : "text-slate-400 hover:text-slate-200 border border-transparent"
              }`}
            >
              🛡️ SEGURANÇA & AUDITORIA
            </button>
            <button
              onClick={() => setRightTab("execution")}
              className={`text-[11px] font-mono font-bold py-1.5 rounded transition-all cursor-pointer flex-1 flex items-center justify-center gap-1.5 ${
                rightTab === "execution"
                  ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shadow-sm"
                  : "text-slate-400 hover:text-slate-200 border border-transparent"
              }`}
            >
              ⚡ EXECUÇÃO & MEV
            </button>
          </div>

          <div className="space-y-4">
            {rightTab === "security" && (
              <>
                <TokenAuditConsole onAuditSuccess={setLastAuditedToken} selectedToken={selectedToken} />
                <DeterministicSimulator selectedToken={selectedToken} onSimulationComplete={(res) => {
                  // Automatically feed custom score & metadata to Decision Engine if simulated
                  if (res) {
                    setLastAuditedToken({
                      name: res.tokenName,
                      mint: res.tokenMint,
                      score: res.isHoneypot ? 12 : 92,
                      isRug: res.isHoneypot,
                      renounced: !res.isHoneypot,
                      liquidityLocked: res.isHoneypot ? "0%" : "99% (Burned)",
                      topHoldersShare: res.isHoneypot ? "45%" : "3.2%",
                      freezeAuthorityDisabled: !res.isHoneypot,
                      mintAuthorityDisabled: !res.isHoneypot,
                      creatorAllocation: res.isHoneypot ? "15.0%" : "0.5%",
                      taxBuySell: `${res.buyTax}% / ${res.sellTax}%`
                    });
                  }
                }} />
                <HftSecurityShield selectedToken={selectedToken} onAuditUpdated={setLastAuditedToken} />
              </>
            )}

            {rightTab === "execution" && (
              <>
                <DecisionEngine walletBalance={14.85} onApplyParams={setSyncedParams} lastAuditedToken={lastAuditedToken} />
                <MevExecutionEngine selectedToken={selectedToken} onBundleSuccess={(newTx) => {
                  setTransactions(prev => [newTx, ...prev]);
                  if (newTx.status === "success" && parseFloat(newTx.outAmount) > 0) {
                    const parsedOut = parseFloat(newTx.outAmount.replace(/,/g, ''));
                    const newPos = {
                      id: `pos_${Date.now()}`,
                      token: newTx.token,
                      qty: newTx.outAmount.split(' ')[0],
                      avgEntry: `${(parseFloat(newTx.amount) / (parsedOut || 1)).toFixed(8)} SOL`,
                      valueSol: newTx.amount,
                      pnlPercent: 0.0,
                      pnl: "0.0%",
                      isGain: true
                    };
                    setPositions(prev => [newPos, ...prev]);
                  }
                }} />
                <DiagnosticsPanel />
              </>
            )}
          </div>
        </div>

      </main>
    </div>
  );
}
