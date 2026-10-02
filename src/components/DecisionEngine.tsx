import { useState, useEffect } from "react";
import { ShieldAlert, Zap, Layers, Sparkles, Sliders, Check, Cpu } from "lucide-react";

interface DecisionEngineProps {
  walletBalance: number; // e.g. 14.85
  onApplyParams: (params: {
    solAmount: string;
    slippage: string;
    priorityTip: string;
    stopLoss: string;
    takeProfit: string;
    antiRugShield: boolean;
  }) => void;
  lastAuditedToken?: {
    name: string;
    mint: string;
    score: number;
    isRug: boolean;
    renounced: boolean;
    liquidityLocked: string;
    topHoldersShare: string;
    freezeAuthorityDisabled: boolean;
    mintAuthorityDisabled: boolean;
    creatorAllocation: string;
    taxBuySell: string;
  } | null;
}

export type RiskProfile = "conservative" | "balanced" | "aggressive";

export function DecisionEngine({ walletBalance, onApplyParams, lastAuditedToken }: DecisionEngineProps) {
  const [profile, setProfile] = useState<RiskProfile>("balanced");
  const [customScore, setCustomScore] = useState<number>(lastAuditedToken ? lastAuditedToken.score : 85);
  const [tokenName, setTokenName] = useState<string>(lastAuditedToken ? lastAuditedToken.name : "COSMIC");
  const [synced, setSynced] = useState<boolean>(false);

  // Simulação do Worker Pool de Rust em tempo real (Fidelidade HFT)
  const [rustThreads, setRustThreads] = useState<{ id: number; status: "IDLE" | "SIMULATING" | "OK" | "ABORT"; load: number }[]>(() =>
    Array.from({ length: 16 }, (_, i) => ({
      id: i,
      status: "IDLE",
      load: 0,
    }))
  );
  const [activeRustSimulations, setActiveRustSimulations] = useState<number>(0);
  const [rustLatencyAvg, setRustLatencyAvg] = useState<number>(1.24);
  const [tokioThroughput, setTokioThroughput] = useState<number>(1240);

  // Sync with prop if it changes
  useEffect(() => {
    if (lastAuditedToken) {
      setCustomScore(lastAuditedToken.score);
      setTokenName(lastAuditedToken.name);
    }
  }, [lastAuditedToken]);

  // Simulação periódica dos Workers HFT concorrentes
  useEffect(() => {
    const interval = setInterval(() => {
      setRustThreads((prev) =>
        prev.map((thread) => {
          const rand = Math.random();
          let status: "IDLE" | "SIMULATING" | "OK" | "ABORT" = "IDLE";
          let load = 0;
          if (rand < 0.25) {
            status = "SIMULATING";
            load = Math.floor(40 + Math.random() * 50);
          } else if (rand < 0.45) {
            status = "OK";
            load = Math.floor(10 + Math.random() * 20);
          } else if (rand < 0.55) {
            status = "ABORT";
            load = Math.floor(5 + Math.random() * 15);
          }
          return { ...thread, status, load };
        })
      );
      setActiveRustSimulations(Math.floor(2 + Math.random() * 8));
      setRustLatencyAvg(parseFloat((0.82 + Math.random() * 0.45).toFixed(2)));
      setTokioThroughput(Math.floor(1180 + Math.random() * 160));
    }, 1200);

    return () => clearInterval(interval);
  }, []);

  // Formulas for Position Sizing (Fractional Allocation based on Audit Score & Risk Profile)
  const getPositionSizing = () => {
    // Allocation ratio based on profile
    let maxAllocationPct = 0.05; // 5% for Balanced
    if (profile === "conservative") maxAllocationPct = 0.01; // 1%
    if (profile === "aggressive") maxAllocationPct = 0.12; // 12%

    // Scale linearly with safety score
    const scoreFactor = customScore / 100;
    
    // Position Size in SOL
    const rawSize = walletBalance * maxAllocationPct * scoreFactor;
    
    // Safe bounds
    return Math.max(0.05, Math.min(walletBalance, Math.round(rawSize * 100) / 100));
  };

  // Formulas for Dynamic Slippage
  const getDynamicSlippage = () => {
    // Lower score implies higher volatility and potential Rug attempt, requiring larger slippage to escape
    const baseSlippage = profile === "conservative" ? 1.5 : profile === "balanced" ? 3.0 : 5.0;
    const scorePenalty = (100 - customScore) * 0.25; // max 25% extra
    const calculated = baseSlippage + scorePenalty;
    
    return Math.min(99.0, Math.round(calculated * 10) / 10);
  };

  // Formulas for Priority Tip/Fee recommended
  const getPriorityTip = () => {
    // If risk score is extremely low, recommend higher tip to frontrun the mempool
    const riskFactor = (100 - customScore) / 100;
    const baseTip = profile === "conservative" ? 0.001 : profile === "balanced" ? 0.002 : 0.005;
    const extraTip = riskFactor * 0.015; // up to 0.015 SOL extra tip in extreme danger
    
    return Math.round((baseTip + extraTip) * 10000) / 10000;
  };

  // Formulas for Stop Loss and Take Profit
  const getStopLoss = () => {
    if (profile === "conservative") return "10";
    if (profile === "balanced") return "18";
    return "35";
  };

  const getTakeProfit = () => {
    if (profile === "conservative") return "40";
    if (profile === "balanced") return "120";
    return "350";
  };

  const isAntiRugShieldRequired = () => {
    // Mandatory shield if score is below 75
    return customScore < 85;
  };

  const computedSize = getPositionSizing();
  const computedSlippage = getDynamicSlippage();
  const computedTip = getPriorityTip();
  const computedStopLoss = getStopLoss();
  const computedTakeProfit = getTakeProfit();
  const computedAntiRug = isAntiRugShieldRequired();

  // Handle Application
  const handleApply = () => {
    onApplyParams({
      solAmount: computedSize.toFixed(2),
      slippage: computedSlippage.toFixed(1),
      priorityTip: computedTip.toFixed(4),
      stopLoss: computedStopLoss,
      takeProfit: computedTakeProfit,
      antiRugShield: computedAntiRug,
    });
    setSynced(true);
    setTimeout(() => setSynced(false), 3000);
  };

  return (
    <div id="decision-engine-panel" className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 backdrop-blur-md glow-cyan relative overflow-hidden flex flex-col justify-between h-full">
      <div className="absolute top-0 right-0 w-24 h-24 bg-cyan-500/5 rounded-full blur-2xl pointer-events-none"></div>

      <div>
        <div className="flex items-center justify-between mb-2.5 pb-2 border-b border-slate-800/60">
          <div className="flex items-center gap-2">
            <Layers className="w-5 h-5 text-cyan-400" />
            <h2 className="text-xs font-display font-bold text-slate-100 uppercase tracking-tight">Decision & Execution Orchestrator</h2>
          </div>
          <div className="flex items-center gap-1 bg-cyan-500/10 px-2 py-0.5 rounded text-[9px] font-mono font-bold text-cyan-300 border border-cyan-500/20">
            <Sparkles className="w-3 h-3 text-cyan-400 animate-pulse" />
            REAL-TIME INTEL
          </div>
        </div>

        {/* Profiles Selector */}
        <div className="mb-4">
          <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-2">Perfil de Risco do Broker</label>
          <div className="grid grid-cols-3 gap-2">
            {(["conservative", "balanced", "aggressive"] as RiskProfile[]).map((p) => (
              <button
                key={p}
                onClick={() => setProfile(p)}
                className={`py-1.5 px-1 rounded text-xs font-mono font-bold uppercase border transition-all cursor-pointer ${
                  profile === p
                    ? p === "conservative"
                      ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-400"
                      : p === "balanced"
                      ? "bg-cyan-500/10 border-cyan-500/40 text-cyan-400"
                      : "bg-amber-500/10 border-amber-500/40 text-amber-400 animate-pulse"
                    : "bg-slate-950 border-slate-850 hover:border-slate-800 text-slate-500"
                }`}
              >
                {p === "conservative" ? "Conservador" : p === "balanced" ? "Moderado" : "Agressivo"}
              </button>
            ))}
          </div>
        </div>

        {/* Risk Score Controller */}
        <div className="p-3 bg-slate-950 rounded-lg border border-slate-850 mb-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono text-slate-400 uppercase">Input do Risk Score Engine ({tokenName})</span>
            <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded ${
              customScore > 75 ? "bg-emerald-500/10 text-emerald-400" : customScore > 45 ? "bg-amber-500/10 text-amber-400" : "bg-rose-500/10 text-rose-400"
            }`}>
              Score: {customScore}/100
            </span>
          </div>

          <input
            type="range"
            min="5"
            max="100"
            value={customScore}
            onChange={(e) => setCustomScore(Number(e.target.value))}
            className="w-full accent-cyan-400 bg-slate-900 cursor-pointer h-1.5 rounded"
          />

          <div className="flex justify-between text-[8px] font-mono text-slate-500 uppercase">
            <span>Risco Crítico (Rug)</span>
            <span>Seguro / Auditado</span>
          </div>
        </div>

        {/* Dynamic Decisional Results Grid */}
        <div className="space-y-3">
          <h3 className="text-[10px] font-mono text-slate-500 uppercase tracking-widest border-b border-slate-850 pb-1 flex items-center gap-1.5">
            <Sliders className="w-3.5 h-3.5 text-cyan-400" />
            RESOLUÇÃO DA CAMADA DE DECISÃO HFT
          </h3>

          <div className="grid grid-cols-2 gap-3">
            {/* Position Size Engine */}
            <div className="p-3 bg-slate-950/60 rounded-lg border border-slate-850 relative">
              <span className="text-[9px] font-mono text-slate-400 uppercase block">1. Position Sizing</span>
              <span className="text-lg font-mono font-bold text-slate-100 mt-1 block">
                {computedSize.toFixed(2)} <span className="text-xs text-slate-400 font-normal">SOL</span>
              </span>
              <span className="text-[8px] font-mono text-slate-500 block mt-1">
                Allocated: {((computedSize / walletBalance) * 100).toFixed(1)}% of Capital
              </span>
            </div>

            {/* Dynamic Slippage Engine */}
            <div className="p-3 bg-slate-950/60 rounded-lg border border-slate-850 relative">
              <span className="text-[9px] font-mono text-slate-400 uppercase block">2. Dynamic Slippage</span>
              <span className="text-lg font-mono font-bold text-cyan-400 mt-1 block">
                {computedSlippage.toFixed(1)}%
              </span>
              <span className="text-[8px] font-mono text-slate-500 block mt-1">
                Protection: {computedSlippage > 10 ? "Fast Escape Route" : "Optimized Entry"}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Jito Recommended Tip */}
            <div className="p-3 bg-slate-950/60 rounded-lg border border-slate-850">
              <span className="text-[9px] font-mono text-slate-400 uppercase block">3. Propina Jito Recomendada</span>
              <span className="text-lg font-mono font-bold text-emerald-400 mt-1 block">
                {computedTip.toFixed(4)} <span className="text-xs text-slate-400 font-normal">SOL</span>
              </span>
              <span className="text-[8px] font-mono text-slate-500 block mt-1">
                Mempool Bypass Target
              </span>
            </div>

            {/* Anti-Rug Auto Trigger */}
            <div className="p-3 bg-slate-950/60 rounded-lg border border-slate-850 flex flex-col justify-between">
              <div>
                <span className="text-[9px] font-mono text-slate-400 uppercase block">4. Mempool Guard Shield</span>
                <span className={`text-xs font-mono font-bold mt-1.5 inline-flex items-center gap-1.5 ${
                  computedAntiRug ? "text-rose-400" : "text-emerald-400"
                }`}>
                  <ShieldAlert className="w-3.5 h-3.5" />
                  {computedAntiRug ? "ATIVO MANDATÓRIO" : "DISPENSÁVEL (CONTRATO SEGURO)"}
                </span>
              </div>
            </div>
          </div>

          {/* Core Stop Loss / Take profit decision metrics */}
          <div className="p-2.5 bg-slate-950 border border-slate-850 rounded text-[10px] font-mono text-slate-400 flex justify-between items-center">
            <span>Escrow TP target: <span className="text-emerald-400 font-bold">+{computedTakeProfit}%</span></span>
            <span>Escrow SL target: <span className="text-rose-400 font-bold">-{computedStopLoss}%</span></span>
          </div>

          {/* Rust Multi-Threaded Parallelization Simulator */}
          <div className="p-2.5 bg-slate-950/80 rounded-lg border border-slate-850/60 mt-2.5">
            <div className="flex items-center justify-between mb-1.5 pb-1.5 border-b border-slate-900">
              <span className="text-[9px] font-mono font-bold text-purple-400 uppercase tracking-wider flex items-center gap-1">
                <Cpu className="w-3 h-3 animate-pulse text-purple-400" />
                Rust Multi-Threaded Engine (Tokio/Rayon)
              </span>
              <span className="text-[8px] font-mono text-emerald-400 bg-emerald-500/10 px-1 py-0.25 rounded border border-emerald-500/20 font-bold uppercase tracking-widest">
                Tier God
              </span>
            </div>

            {/* Grid of 16 threads */}
            <div className="grid grid-cols-8 gap-1 mb-2">
              {rustThreads.map((thread) => (
                <div
                  key={thread.id}
                  className={`p-1 rounded text-center border font-mono transition-all duration-200 ${
                    thread.status === "SIMULATING"
                      ? "bg-purple-500/20 border-purple-500/40 text-purple-300 animate-pulse"
                      : thread.status === "OK"
                      ? "bg-emerald-500/15 border-emerald-500/35 text-emerald-400"
                      : thread.status === "ABORT"
                      ? "bg-rose-500/15 border-rose-500/35 text-rose-400"
                      : "bg-slate-900/60 border-slate-850 text-slate-600"
                  }`}
                  style={{ fontSize: "8px" }}
                  title={`Thread ${thread.id.toString().padStart(2, "0")} | Load: ${thread.load}%`}
                >
                  T{thread.id.toString().padStart(2, "0")}
                </div>
              ))}
            </div>

            {/* Performance telemetry readout */}
            <div className="grid grid-cols-3 gap-1.5 text-[8px] font-mono text-slate-400">
              <div className="bg-slate-900/40 p-1 rounded flex flex-col">
                <span className="text-slate-500 uppercase">Workers Ativos</span>
                <span className="text-purple-400 font-bold text-[9px]">{activeRustSimulations} Threads</span>
              </div>
              <div className="bg-slate-900/40 p-1 rounded flex flex-col">
                <span className="text-slate-500 uppercase">Latência Média</span>
                <span className="text-emerald-400 font-bold text-[9px]">{rustLatencyAvg}ms</span>
              </div>
              <div className="bg-slate-900/40 p-1 rounded flex flex-col">
                <span className="text-slate-500 uppercase">Vazão Total</span>
                <span className="text-slate-200 font-bold text-[9px]">{tokioThroughput} tps</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-slate-850">
        <button
          onClick={handleApply}
          className={`w-full py-2.5 px-4 rounded-lg font-display font-semibold text-xs transition-all duration-300 flex items-center justify-center gap-2 cursor-pointer ${
            synced
              ? "bg-emerald-500 text-slate-950 border border-emerald-400"
              : "bg-cyan-500 hover:bg-cyan-400 text-slate-950 hover:shadow-cyan-500/25 border border-cyan-400/20"
          }`}
        >
          {synced ? (
            <>
              <Check className="w-4 h-4" />
              Sincronizado com Sucesso!
            </>
          ) : (
            <>
              <Zap className="w-4 h-4 text-slate-950 fill-current" />
              Sincronizar Parâmetros com Sniper HFT
            </>
          )}
        </button>
      </div>
    </div>
  );
}
