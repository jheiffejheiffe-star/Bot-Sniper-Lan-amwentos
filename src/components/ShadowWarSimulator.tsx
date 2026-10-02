import { useState, useEffect } from "react";
import { 
  Shield, 
  RefreshCw, 
  Target, 
  TrendingUp
} from "lucide-react";
import { 
  ResponsiveContainer, 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  Tooltip, 
  CartesianGrid 
} from "recharts";

interface SimulatedWar {
  id: string;
  token: string;
  ourTipSol: number;
  competitorTipSol: number;
  ourLatencyMs: number;
  inclusionStatus: "landed" | "failed_tip" | "failed_latency";
  slippageEstimated: number;
  slippageRealized: number;
  timestamp: string;
}

export function ShadowWarSimulator() {
  const [isSimulatingLive, setIsSimulatingLive] = useState<boolean>(true);
  const [jitoBaseTip, setJitoBaseTip] = useState<number>(0.05); // Standard Jito tip in SOL
  const [targetSlippage, setTargetSlippage] = useState<number>(0.5); // Slippage target %
  
  // Simulated statistics
  const [totalSimulations, setTotalSimulations] = useState<number>(38);
  const [landedCount, setLandedCount] = useState<number>(24);
  const [failedTipCount, setFailedTipCount] = useState<number>(8);
  const [failedLatencyCount, setFailedLatencyCount] = useState<number>(6);
  
  const [slippageHistory, setSlippageHistory] = useState<any[]>([
    { index: 1, expected: 0.5, realized: 0.48 },
    { index: 2, expected: 0.5, realized: 0.52 },
    { index: 3, expected: 0.5, realized: 0.45 },
    { index: 4, expected: 0.5, realized: 0.61 },
    { index: 5, expected: 0.5, realized: 0.49 }
  ]);

  const [warHistory, setWarHistory] = useState<SimulatedWar[]>([
    { id: "war_1", token: "PUMP_MILORD", ourTipSol: 0.05, competitorTipSol: 0.04, ourLatencyMs: 14.5, inclusionStatus: "landed", slippageEstimated: 0.5, slippageRealized: 0.48, timestamp: "08:52:10" },
    { id: "war_2", token: "SOL_GIGA", ourTipSol: 0.05, competitorTipSol: 0.08, ourLatencyMs: 12.2, inclusionStatus: "failed_tip", slippageEstimated: 0.5, slippageRealized: 0.85, timestamp: "08:52:35" },
    { id: "war_3", token: "WIF_MOON", ourTipSol: 0.05, competitorTipSol: 0.03, ourLatencyMs: 205.0, inclusionStatus: "failed_latency", slippageEstimated: 0.5, slippageRealized: 0.0, timestamp: "08:53:01" }
  ]);

  const [logs, setLogs] = useState<string[]>([]);

  // Simulation engine loop
  useEffect(() => {
    // Initial logs setup
    setLogs([
      "[SHADOW] Inicializando Rede de Simulação de Guerra (Shadow Mode) Layer 11.",
      "[SHADOW] Sincronizando estado processado do Yellowstone Geyser gRPC local.",
      "[JITO] Leilão virtual de blocos monitorando transações concorrentes na blockchain.",
      "[SHADOW] Pronto para simulação não-destrutiva de liquidez ao vivo."
    ]);
  }, []);

  useEffect(() => {
    if (!isSimulatingLive) return;

    const interval = setInterval(() => {
      const tokenSymbol = `SHDW_${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
      const competitorTip = parseFloat((0.01 + Math.random() * 0.12).toFixed(3));
      const ourLatency = parseFloat((10 + Math.random() * 240).toFixed(1));
      
      let status: "landed" | "failed_tip" | "failed_latency" = "landed";
      let realizedSlip = 0;

      if (ourLatency > 200) {
        status = "failed_latency";
        realizedSlip = 0.0;
      } else if (competitorTip > jitoBaseTip) {
        status = "failed_tip";
        realizedSlip = parseFloat((targetSlippage + (Math.random() * 0.5)).toFixed(2));
      } else {
        status = "landed";
        realizedSlip = parseFloat((targetSlippage - (Math.random() * 0.15)).toFixed(2));
      }

      const timestampString = new Date().toTimeString().split(' ')[0];

      const newWar: SimulatedWar = {
        id: `war_${Date.now()}`,
        token: tokenSymbol,
        ourTipSol: jitoBaseTip,
        competitorTipSol: competitorTip,
        ourLatencyMs: ourLatency,
        inclusionStatus: status,
        slippageEstimated: targetSlippage,
        slippageRealized: realizedSlip,
        timestamp: timestampString
      };

      setTotalSimulations(prev => prev + 1);
      if (status === "landed") {
        setLandedCount(prev => prev + 1);
      } else if (status === "failed_tip") {
        setFailedTipCount(prev => prev + 1);
      } else {
        setFailedLatencyCount(prev => prev + 1);
      }

      setWarHistory(prev => [newWar, ...prev.slice(0, 5)]);

      // Graph update
      setSlippageHistory(history => {
        const nextIndex = history.length + 1;
        return [
          ...history.slice(-10),
          { index: nextIndex, expected: targetSlippage, realized: status === "landed" ? realizedSlip : targetSlippage }
        ];
      });

      // Append appropriate logs
      let logMsg = "";
      if (status === "landed") {
        logMsg = `[🏆 LANDED] Vitória no leilão virtual de blocos para ${tokenSymbol}. Gorjeta Jito: ${jitoBaseTip} SOL vs. concorrente ${competitorTip} SOL. Slippage: ${realizedSlip}%.`;
      } else if (status === "failed_tip") {
        logMsg = `[⚠️ FAILED TIP] Transação preterida por leilão financeiro Jito em ${tokenSymbol}. Gorjeta do oponente (${competitorTip} SOL) superou nossa oferta (${jitoBaseTip} SOL).`;
      } else {
        logMsg = `[⛔ FAILED LATENCY] Abortado no Shadow Mode. Latência do pipeline de ${ourLatency}ms excedeu o limiar de sobrevivência (<200ms).`;
      }

      setLogs(prev => [logMsg, ...prev.slice(0, 40)]);

    }, 3500);

    return () => clearInterval(interval);
  }, [isSimulatingLive, jitoBaseTip, targetSlippage]);

  const landedRate = totalSimulations > 0 ? (landedCount / totalSimulations) * 100 : 0;

  const handleResetSimulator = () => {
    setTotalSimulations(0);
    setLandedCount(0);
    setFailedTipCount(0);
    setFailedLatencyCount(0);
    setWarHistory([]);
    setSlippageHistory([{ index: 1, expected: targetSlippage, realized: targetSlippage }]);
    setLogs([
      "[SYSTEM] Simulador de Guerra de Blocos (Shadow Mode) resetado.",
      "[SHADOW] Monitorando novas filas de inclusão na blockchain em modo passivo..."
    ]);
  };

  return (
    <div id="shadow-war-simulator" className="bg-slate-900 border border-slate-800 rounded-xl p-4 relative overflow-hidden flex flex-col gap-4">
      {/* Visual neon bar */}
      <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-amber-500/40 to-transparent"></div>

      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-slate-850 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
            <Shield className="w-4.5 h-4.5 text-amber-400 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h2 className="text-xs font-mono font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1">
                Rede de Simulação de Guerra <span className="text-amber-400 font-extrabold text-[9px] bg-amber-950/60 border border-amber-800/40 px-1.5 py-0.5 rounded-full uppercase">Shadow Mode</span>
              </h2>
            </div>
            <p className="text-[10px] font-mono text-slate-500">Validação teórica de Landed Probability & Slippage sem perdas</p>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => setIsSimulatingLive(!isSimulatingLive)}
            className={`px-2.5 py-1 rounded font-mono text-[10px] font-bold border transition-all cursor-pointer flex items-center gap-1.5 ${
              isSimulatingLive 
                ? "bg-amber-500/10 border-amber-500/30 text-amber-400" 
                : "bg-slate-800 border-slate-700 text-slate-400"
            }`}
          >
            {isSimulatingLive ? "ACTIVE REPLAY" : "PAUSED"}
          </button>
          <button
            onClick={handleResetSimulator}
            className="p-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-750 transition-colors flex items-center justify-center cursor-pointer"
            title="Resetar Simulação"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Inputs Settings */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 bg-slate-950/60 border border-slate-850 p-3 rounded-lg">
        <div className="flex flex-col gap-1">
          <div className="flex justify-between items-center">
            <label className="text-[9px] font-mono text-slate-400 uppercase tracking-wider">Oferta de Gorjeta Jito (SOL)</label>
            <span className="text-amber-400 font-bold font-mono text-xs">{jitoBaseTip} SOL</span>
          </div>
          <input
            type="range"
            min="0.01"
            max="0.30"
            step="0.01"
            value={jitoBaseTip}
            onChange={(e) => setJitoBaseTip(parseFloat(e.target.value))}
            className="w-full accent-amber-500 bg-slate-900 rounded-lg appearance-none h-1 cursor-pointer"
          />
          <span className="text-[8px] text-slate-500 font-mono">Gorjeta virtual para competir com outros snipers HFT.</span>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex justify-between items-center">
            <label className="text-[9px] font-mono text-slate-400 uppercase tracking-wider">Slippage Limite de Compra</label>
            <span className="text-cyan-400 font-bold font-mono text-xs">{targetSlippage}%</span>
          </div>
          <input
            type="range"
            min="0.1"
            max="2.0"
            step="0.1"
            value={targetSlippage}
            onChange={(e) => setTargetSlippage(parseFloat(e.target.value))}
            className="w-full accent-cyan-500 bg-slate-900 rounded-lg appearance-none h-1 cursor-pointer"
          />
          <span className="text-[8px] text-slate-500 font-mono">Slippage máximo admitido antes de rejeitar a transação.</span>
        </div>
      </div>

      {/* Main KPI metrics Dashboard */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        
        {/* Metric 1: LANDED PROBABILITY */}
        <div className="p-3 bg-slate-950/40 border border-slate-850 rounded-lg">
          <span className="block text-[9px] font-mono text-slate-500 uppercase">Landed Probability (Target &gt;60%)</span>
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <span className={`text-xl font-mono font-extrabold ${landedRate >= 60 ? "text-emerald-400" : "text-amber-400"}`}>
              {landedRate.toFixed(1)}%
            </span>
            <span className="text-xs font-mono text-slate-400">({landedCount} / {totalSimulations})</span>
          </div>
          <div className="h-1.5 w-full bg-slate-900 rounded-full overflow-hidden mt-2">
            <div className="bg-amber-500 h-full transition-all duration-300" style={{ width: `${landedRate}%` }}></div>
          </div>
        </div>

        {/* Metric 2: FAILED BY TIP */}
        <div className="p-3 bg-slate-950/40 border border-slate-850 rounded-lg">
          <span className="block text-[9px] font-mono text-slate-500 uppercase">Derrotas por Gorjeta</span>
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <span className="text-xl font-mono font-extrabold text-rose-400">{failedTipCount}</span>
            <span className="text-[10px] font-mono text-slate-500">transações</span>
          </div>
          <span className="block text-[8px] font-mono text-slate-500 mt-2">Sub-licitados no Jito</span>
        </div>

        {/* Metric 3: FAILED BY LATENCY */}
        <div className="p-3 bg-slate-950/40 border border-slate-850 rounded-lg">
          <span className="block text-[9px] font-mono text-slate-500 uppercase">Atraso de Ingestão</span>
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <span className="text-xl font-mono font-extrabold text-orange-400">{failedLatencyCount}</span>
            <span className="text-[10px] font-mono text-slate-500">bloqueios</span>
          </div>
          <span className="block text-[8px] font-mono text-rose-500 mt-2">Latência excedeu 200ms</span>
        </div>

        {/* Metric 4: AVERAGE SLIPPAGE */}
        <div className="p-3 bg-slate-950/40 border border-slate-850 rounded-lg">
          <span className="block text-[9px] font-mono text-slate-500 uppercase">Slippage Virtual Realizado</span>
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <span className="text-xl font-mono font-extrabold text-cyan-400">
              {(slippageHistory.reduce((acc, curr) => acc + curr.realized, 0) / (slippageHistory.length || 1)).toFixed(2)}%
            </span>
            <span className="text-[10px] font-mono text-slate-500">Média</span>
          </div>
          <span className="block text-[8px] font-mono text-emerald-400 mt-2">Eficiência de Rota: Ativa</span>
        </div>
      </div>

      {/* Grid Charts & Detailed Battle Logs */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        
        {/* Chart */}
        <div className="lg:col-span-2 p-3 bg-slate-950/60 border border-slate-850 rounded-lg">
          <h3 className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest mb-2 flex items-center gap-1">
            <TrendingUp className="w-3.5 h-3.5 text-amber-400" /> SLIPPAGE ESTIMADO VS. REALIZADO (L11 STAGING)
          </h3>
          <div className="h-32">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={slippageHistory} margin={{ top: 5, right: 10, left: -25, bottom: 0 }}>
                <defs>
                  <linearGradient id="slipGlow" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25}/>
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#0f172a" vertical={false} />
                <XAxis dataKey="index" stroke="#475569" fontSize={9} />
                <YAxis stroke="#475569" fontSize={9} domain={['auto', 'auto']} />
                <Tooltip 
                  contentStyle={{ backgroundColor: "#020617", borderColor: "#1e293b" }}
                  labelStyle={{ color: "#94a3b8", fontSize: "10px", fontFamily: "monospace" }}
                  itemStyle={{ color: "#f59e0b", fontSize: "11px", fontFamily: "monospace" }}
                />
                <Area type="monotone" dataKey="realized" name="Slippage Realizado" stroke="#f59e0b" strokeWidth={1.5} fillOpacity={1} fill="url(#slipGlow)" />
                <Area type="monotone" dataKey="expected" name="Slippage Alvo" stroke="#06b6d4" strokeWidth={1.5} fill="none" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Live List of virtual disputed launches */}
        <div className="p-3 bg-slate-950/40 border border-slate-850 rounded-lg flex flex-col justify-between">
          <div>
            <h3 className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest mb-2 border-b border-slate-900 pb-1.5 flex items-center gap-1.5">
              <Target className="w-3.5 h-3.5 text-amber-400" /> ÚLTIMAS BATALHAS SHADOW
            </h3>

            <div className="space-y-1.5 max-h-[110px] overflow-y-auto pr-1">
              {warHistory.map((war) => (
                <div key={war.id} className="p-1.5 bg-slate-900/60 border border-slate-850 rounded flex justify-between items-center text-[9px] font-mono">
                  <div>
                    <span className="font-extrabold text-slate-200 block">{war.token}</span>
                    <span className="text-slate-500">Latency: {war.ourLatencyMs}ms</span>
                  </div>

                  <div className="text-right">
                    <span className={`font-bold block ${
                      war.inclusionStatus === "landed" 
                        ? "text-emerald-400" 
                        : war.inclusionStatus === "failed_tip" 
                          ? "text-rose-400" 
                          : "text-orange-400"
                    }`}>
                      {war.inclusionStatus === "landed" ? "VITORIOSO" : war.inclusionStatus === "failed_tip" ? "PERDA JITO" : "TIMEOUT"}
                    </span>
                    <span className="text-slate-500 text-[8px]">Tip: {war.ourTipSol} SOL</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

      </div>

      {/* Terminal Replay logs stream */}
      <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-850 text-[10px] font-mono flex-1 min-h-[110px] flex flex-col">
        <span className="text-slate-500 uppercase tracking-widest text-[9px] border-b border-slate-850/60 pb-1 mb-1.5 block">
          LOGS DO SIMULADOR SHADOW & LEILÃO VIRTUAL DE BLOCOS SOLANA (GEWALT GEYSER LIVE)
        </span>
        <div className="overflow-y-auto max-h-[120px] space-y-1 select-text scrollbar-thin">
          {logs.map((log, index) => (
            <div key={index} className="text-slate-400">
              <span className="text-slate-600">[{new Date().toTimeString().split(' ')[0]}]</span> {log}
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}
