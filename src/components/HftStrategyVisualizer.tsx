import { useState } from "react";
import { 
  ResponsiveContainer, 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  Tooltip, 
  CartesianGrid 
} from "recharts";
import { 
  TrendingUp, 
  Play, 
  RotateCcw, 
  ShieldCheck, 
  ShieldAlert, 
  Award, 
  ArrowUpRight, 
  Flame, 
  Zap 
} from "lucide-react";

interface BacktestStep {
  trade: number;
  label: string;
  smartCapital: number;
  staticCapital: number;
  event: string;
  type: "success" | "rug_avoided" | "rug_hit" | "frontrun_success";
}

export function HftStrategyVisualizer() {
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [currentStep, setCurrentStep] = useState<number>(0);
  const [marketVolatility, setMarketVolatility] = useState<number>(65); // 0-100
  const [jitoTipTier, setJitoTipTier] = useState<"standard" | "ultra">("standard");
  const [antiRugActive, setAntiRugActive] = useState<boolean>(true);

  // Initial Capital in SOL
  const initialCapital = 10;

  const [simulationData, setSimulationData] = useState<BacktestStep[]>([
    { trade: 0, label: "Início", smartCapital: 10, staticCapital: 10, event: "Aguardando", type: "success" }
  ]);

  const [stats, setStats] = useState({
    smartNetPnl: "0.00 SOL",
    staticNetPnl: "0.00 SOL",
    rugsSaved: 0,
    frontrunBypasses: 0,
    efficiencyGain: "0.0%"
  });

  // Run Step-by-Step Backtest Simulation
  const runBacktest = () => {
    setIsRunning(true);
    setCurrentStep(0);
    
    // Scenarios for the 8-step HFT backtest
    const scenarios = [
      { name: "PUMP Coin", isRug: false, multiplier: 1.45, event: "Lançamento de Liquidez Sucesso" },
      { name: "SOLCAT", isRug: false, multiplier: 1.80, event: "Baleia Executa Entrada Mempool" },
      { name: "RUG_TRAP", isRug: true, multiplier: 0.05, event: "Tentativa de Rug Pull Detectada" },
      { name: "NEURAL", isRug: false, multiplier: 2.10, event: "Migração Pump.fun para Raydium" },
      { name: "MEME_KING", isRug: true, multiplier: 0.10, event: "Contrato Liquidado Pelo Criador" },
      { name: "ALPHA_AI", isRug: false, multiplier: 1.65, event: "Parceria de Influenciador Detectada" },
      { name: "RUG_TRAP_2", isRug: true, multiplier: 0.02, event: "Liquidez Removida na Mempool" },
      { name: "CYBER", isRug: false, multiplier: 2.40, event: "Fast Buy Jito Bundle Confirmada" }
    ];

    let smartCap = initialCapital;
    let staticCap = initialCapital;
    let rugsSavedCount = 0;
    let frontrunBypassesCount = 0;

    const newSteps: BacktestStep[] = [
      { trade: 0, label: "T0", smartCapital: initialCapital, staticCapital: initialCapital, event: "Capital Inicial", type: "success" }
    ];

    scenarios.forEach((sc, index) => {
      const stepNum = index + 1;
      
      // Volatility amplifies or dampens profits/losses
      const volFactor = 1 + (marketVolatility - 50) / 100;
      
      // Calculate STATIC Strategy Results:
      // Flat 1.5 SOL trade sizing, no anti-rug protection, standard slippage of 3%
      const flatSize = 1.5;
      if (sc.isRug) {
        // Static strategy gets rugged completely on that trade size
        staticCap = Math.max(0.1, staticCap - flatSize + (flatSize * sc.multiplier));
      } else {
        // Standard trades gain based on multiplier and volatility
        const profit = flatSize * (sc.multiplier - 1) * volFactor;
        staticCap = Math.max(0.1, staticCap + profit);
      }

      // Calculate DECISION ENGINE (SMART) Strategy Results:
      // Dynamic allocation (less capital placed in high-risk tokens), dynamic slippage, and auto anti-rug trigger
      let smartAllocation = 1.0; // Dynamic baseline
      let smartType: BacktestStep["type"] = "success";

      if (sc.isRug) {
        if (antiRugActive) {
          // Saved by anti-rug! Avoids loss, pays only minimal fee/tip to frontrun the rug tx
          smartCap = smartCap - 0.005; // minuscule tip cost
          rugsSavedCount++;
          smartType = "rug_avoided";
        } else {
          // Hit by rug because protection was disabled
          smartCap = Math.max(0.1, smartCap - smartAllocation + (smartAllocation * sc.multiplier));
          smartType = "rug_hit";
        }
      } else {
        // Normal trade success
        // Extra profit if using ultra tip due to absolute priority in block inclusion
        const tipBonus = jitoTipTier === "ultra" ? 0.15 : 0;
        if (jitoTipTier === "ultra") {
          frontrunBypassesCount++;
        }
        
        const smartProfit = smartAllocation * (sc.multiplier - 1 + tipBonus) * volFactor;
        smartCap = smartCap + smartProfit;
        smartType = jitoTipTier === "ultra" ? "frontrun_success" : "success";
      }

      // Limit decimals for cleaner chart plotting
      const finalSmart = Math.round(smartCap * 100) / 100;
      const finalStatic = Math.round(staticCap * 100) / 100;

      newSteps.push({
        trade: stepNum,
        label: `T${stepNum} (${sc.name})`,
        smartCapital: finalSmart,
        staticCapital: finalStatic,
        event: sc.isRug && antiRugActive ? "Mempool Rug Blocked" : sc.event,
        type: smartType
      });
    });

    // Run interval to animate chart step rendering
    let currentIdx = 0;
    const interval = setInterval(() => {
      currentIdx++;
      if (currentIdx < newSteps.length) {
        setCurrentStep(currentIdx);
        setSimulationData(newSteps.slice(0, currentIdx + 1));
      } else {
        clearInterval(interval);
        setIsRunning(false);

        // Update final statistics
        const finalSmartCap = newSteps[newSteps.length - 1].smartCapital;
        const finalStaticCap = newSteps[newSteps.length - 1].staticCapital;
        const smartNet = (finalSmartCap - initialCapital).toFixed(2);
        const staticNet = (finalStaticCap - initialCapital).toFixed(2);
        const efficiency = (((finalSmartCap - finalStaticCap) / finalStaticCap) * 100).toFixed(1);

        setStats({
          smartNetPnl: `${smartNet > "0" ? "+" : ""}${smartNet} SOL`,
          staticNetPnl: `${staticNet > "0" ? "+" : ""}${staticNet} SOL`,
          rugsSaved: rugsSavedCount,
          frontrunBypasses: frontrunBypassesCount,
          efficiencyGain: `+${efficiency}%`
        });
      }
    }, 500);
  };

  return (
    <div id="hft-backtest-simulator-panel" className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 backdrop-blur-md relative overflow-hidden flex flex-col justify-between h-full">
      <div className="absolute top-0 right-0 w-28 h-28 bg-purple-500/5 rounded-full blur-2xl pointer-events-none"></div>

      <div>
        <div className="flex items-center justify-between mb-2.5 pb-2 border-b border-slate-800/60">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-purple-400" />
            <h2 className="text-xs font-display font-semibold text-slate-100">Backrun Strategy Benchmarking</h2>
          </div>
          <span className="text-[9px] font-mono font-bold text-purple-400 bg-purple-500/10 px-1.5 py-0.5 rounded border border-purple-500/20">
            SIMULADOR HFT
          </span>
        </div>

        {/* Configurations Drawer / Row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-2.5">
          {/* Volatility */}
          <div className="p-3 bg-slate-950 rounded-lg border border-slate-850/80">
            <label className="text-[10px] font-mono text-slate-400 uppercase tracking-wider block mb-1">Volatilidade do Mercado</label>
            <div className="flex items-center gap-2 mt-1.5">
              <Flame className="w-4 h-4 text-amber-500 shrink-0" />
              <input 
                type="range"
                min="20"
                max="100"
                disabled={isRunning}
                value={marketVolatility}
                onChange={(e) => setMarketVolatility(Number(e.target.value))}
                className="w-full accent-purple-500 bg-slate-900 h-1.5 rounded cursor-pointer"
              />
              <span className="text-xs font-mono font-bold text-slate-200 shrink-0">{marketVolatility}%</span>
            </div>
          </div>

          {/* Jito Bundle Tip tier selector */}
          <div className="p-3 bg-slate-950 rounded-lg border border-slate-850/80">
            <label className="text-[10px] font-mono text-slate-400 uppercase tracking-wider block mb-1">Jito Bundle Tip Level</label>
            <div className="flex gap-1.5 mt-1.5">
              <button
                onClick={() => setJitoTipTier("standard")}
                disabled={isRunning}
                className={`flex-1 py-1 px-2 rounded text-[10px] font-mono font-bold uppercase border cursor-pointer transition-all ${
                  jitoTipTier === "standard"
                    ? "bg-purple-500/10 border-purple-500/40 text-purple-400"
                    : "bg-slate-900 border-slate-850 text-slate-500"
                }`}
              >
                Standard
              </button>
              <button
                onClick={() => setJitoTipTier("ultra")}
                disabled={isRunning}
                className={`flex-1 py-1 px-2 rounded text-[10px] font-mono font-bold uppercase border cursor-pointer transition-all ${
                  jitoTipTier === "ultra"
                    ? "bg-cyan-500/10 border-cyan-500/40 text-cyan-400 animate-pulse"
                    : "bg-slate-900 border-slate-850 text-slate-500"
                }`}
              >
                Ultra-Snipe
              </button>
            </div>
          </div>

          {/* Anti-Rug Switch */}
          <div className="p-3 bg-slate-950 rounded-lg border border-slate-850/80 flex items-center justify-between">
            <div>
              <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider block">Mempool Guard (Anti-Rug)</span>
              <span className="text-[9px] text-slate-500 font-mono block mt-0.5">Auto bypass triggers</span>
            </div>
            <button
              onClick={() => setAntiRugActive(!antiRugActive)}
              disabled={isRunning}
              className={`p-1 rounded cursor-pointer transition-all border ${
                antiRugActive 
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" 
                  : "bg-rose-500/10 text-rose-400 border-rose-500/30"
              }`}
            >
              {antiRugActive ? <ShieldCheck className="w-5 h-5" /> : <ShieldAlert className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* Strategy Real-time Chart */}
        <div className="bg-slate-950/70 rounded-xl p-3 border border-slate-850/70 mb-3 relative">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[10px] font-mono text-slate-500 uppercase">Crescimento de Capital (SOL) vs Swaps Efetuados</span>
            <div className="flex gap-2 text-[10px] font-mono">
              <span className="flex items-center gap-1 text-purple-400 font-bold">
                <span className="w-1.5 h-1.5 rounded-full bg-purple-500 inline-block"></span> Decisional Engine
              </span>
              <span className="flex items-center gap-1 text-slate-500 font-bold">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-600 inline-block"></span> Estratégia Estática
              </span>
            </div>
          </div>

          <div className="h-[125px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={simulationData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorSmart" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#a855f7" stopOpacity={0.2}/>
                    <stop offset="95%" stopColor="#a855f7" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorStatic" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#64748b" stopOpacity={0.1}/>
                    <stop offset="95%" stopColor="#64748b" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" opacity={0.3} />
                <XAxis dataKey="trade" stroke="#475569" fontSize={10} fontStyle="italic" />
                <YAxis stroke="#475569" fontSize={10} />
                <Tooltip
                  contentStyle={{ backgroundColor: "#020617", borderColor: "#1e293b", borderRadius: "8px" }}
                  labelStyle={{ color: "#94a3b8", fontFamily: "monospace", fontSize: "11px" }}
                  itemStyle={{ fontFamily: "monospace", fontSize: "12px" }}
                />
                <Area type="monotone" name="Orchestrated (SOL)" dataKey="smartCapital" stroke="#a855f7" strokeWidth={2.5} fillOpacity={1} fill="url(#colorSmart)" />
                <Area type="monotone" name="Static Flat (SOL)" dataKey="staticCapital" stroke="#64748b" strokeWidth={1.5} strokeDasharray="3 3" fillOpacity={1} fill="url(#colorStatic)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Interactive Steps Feedback during execution */}
          {isRunning && simulationData.length > 1 && (
            <div className="absolute inset-x-4 bottom-4 bg-slate-950/95 border border-purple-500/30 p-2 rounded-lg text-[10px] font-mono text-purple-300 animate-pulse flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-purple-400 animate-spin" />
                <span>Simulando Swap {currentStep}: {simulationData[currentStep].event}</span>
              </span>
              <span className="text-slate-400">Cap: {simulationData[currentStep].smartCapital} SOL</span>
            </div>
          )}
        </div>

        {/* Simulation Output Statistics */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-850">
            <span className="text-[8px] font-mono text-slate-500 uppercase block">PnL Broker Inteligente</span>
            <span className={`text-sm font-mono font-bold block mt-1 ${
              parseFloat(stats.smartNetPnl) >= 0 ? "text-purple-400" : "text-rose-400"
            }`}>
              {stats.smartNetPnl}
            </span>
          </div>

          <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-850">
            <span className="text-[8px] font-mono text-slate-500 uppercase block">PnL Setup Estático</span>
            <span className={`text-sm font-mono font-bold block mt-1 ${
              parseFloat(stats.staticNetPnl) >= 0 ? "text-slate-300" : "text-rose-400"
            }`}>
              {stats.staticNetPnl}
            </span>
          </div>

          <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-850">
            <span className="text-[8px] font-mono text-slate-500 uppercase block">Fugas de Rug Pull</span>
            <span className="text-sm font-mono font-bold text-emerald-400 block mt-1">
              {stats.rugsSaved} Evitados
            </span>
          </div>

          <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-850">
            <span className="text-[8px] font-mono text-slate-500 uppercase block">Ultra Bundle Bypass</span>
            <span className="text-sm font-mono font-bold text-cyan-400 block mt-1">
              {stats.frontrunBypasses} Sucessos
            </span>
          </div>

          <div className="p-2.5 bg-purple-950/20 rounded-lg border border-purple-500/30 col-span-2 sm:col-span-1 flex flex-col justify-between">
            <span className="text-[8px] font-mono text-purple-300 uppercase block">Performance Edge</span>
            <span className="text-sm font-mono font-extrabold text-purple-400 inline-flex items-center gap-0.5 mt-1">
              {stats.efficiencyGain}
              <ArrowUpRight className="w-3.5 h-3.5" />
            </span>
          </div>
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-slate-850 flex items-center justify-between">
        <span className="text-[9px] font-mono text-slate-500 flex items-center gap-1">
          <Award className="w-3.5 h-3.5 text-purple-400" />
          Escoramento de Liquidez Protegido
        </span>

        <div className="flex gap-2">
          <button
            onClick={() => {
              setSimulationData([{ trade: 0, label: "Início", smartCapital: 10, staticCapital: 10, event: "Resetado", type: "success" }]);
              setStats({ smartNetPnl: "0.00 SOL", staticNetPnl: "0.00 SOL", rugsSaved: 0, frontrunBypasses: 0, efficiencyGain: "0.0%" });
            }}
            disabled={isRunning}
            className="p-2 text-slate-400 hover:text-slate-200 bg-slate-950 hover:bg-slate-900 border border-slate-850 rounded-lg cursor-pointer transition-all flex items-center gap-1.5 text-xs font-mono"
            title="Reset simulation"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={runBacktest}
            disabled={isRunning}
            className={`py-2 px-4 rounded-lg font-display font-semibold text-xs transition-all duration-300 flex items-center gap-1.5 cursor-pointer ${
              isRunning
                ? "bg-purple-500/20 text-purple-400 border border-purple-500/30 cursor-not-allowed"
                : "bg-purple-600 hover:bg-purple-500 text-slate-100 border border-purple-500/20 hover:shadow-purple-500/25"
            }`}
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            {isRunning ? "Simulando HFT..." : "Executar Backtest"}
          </button>
        </div>
      </div>
    </div>
  );
}
