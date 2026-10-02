import { useState, useEffect } from "react";
import { 
  Zap, 
  Activity, 
  Sliders, 
  CheckCircle,
  Flame,
  LifeBuoy
} from "lucide-react";
import { 
  ResponsiveContainer, 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  Tooltip, 
  CartesianGrid 
} from "recharts";

interface Position {
  id: string;
  token: string;
  qty: string;
  avgEntry: string;
  valueSol: string;
  pnlPercent: number;
  pnl: string;
  isGain: boolean;
  peakPnlPercent: number; // For trailing stop calculation
  ladderMilestonesReached: string[]; // Track laddered sells
  mintAddress?: string;
}

interface PositionParachuteManagerProps {
  positions: Position[];
  onSellPosition: (id: string, token: string, pct?: number, reason?: string) => void;
  syncedParams?: any;
}

export function PositionParachuteManager({ positions, onSellPosition, syncedParams }: PositionParachuteManagerProps) {
  // Configurable thresholds
  const [stopLoss, setStopLoss] = useState<number>(syncedParams ? Math.abs(parseFloat(syncedParams.stopLoss)) : 15);
  const [takeProfit, setTakeProfit] = useState<number>(syncedParams ? Math.abs(parseFloat(syncedParams.takeProfit)) : 80);
  const [trailingStop, setTrailingStop] = useState<number>(10); // trailing distance in %
  const [trailingActive, setTrailingActive] = useState<boolean>(true);
  
  // Ladder exits (Take Profit 1, 2, 3)
  const [ladderActive, setLadderActive] = useState<boolean>(true);
  const [ladderPct1, setLadderPct1] = useState<number>(50); // sell 50% at 2x
  const [ladderTrigger1, setLadderTrigger1] = useState<number>(100); // 100% gain

  // Jito parameters for priority exit
  const [jitoTip, setJitoTip] = useState<number>(0.005);

  // Monitor engine state
  const [isEngineRunning, setIsEngineRunning] = useState<boolean>(true);
  const [monitorLatency, setMonitorLatency] = useState<number>(14); // in ms

  // Selection for detailed tracking chart
  const [selectedPosId, setSelectedPosId] = useState<string>("");
  const [chartData, setChartData] = useState<any[]>([]);

  // Local logs for "O Paraquedas"
  const [parachuteLogs, setParachuteLogs] = useState<string[]>([
    "[SYSTEM] Módulo de Gerenciamento de Posição Layer 7 (O Paraquedas) inicializado.",
    "[STANDBY] Escaneando posições ativas em intervalos de milissegundos...",
    "[JITO] Conexão com BlockEngine estabelecida para saídas flash."
  ]);

  // Sync prop changes
  useEffect(() => {
    if (syncedParams) {
      if (syncedParams.stopLoss) setStopLoss(Math.abs(parseFloat(syncedParams.stopLoss)));
      if (syncedParams.takeProfit) setTakeProfit(Math.abs(parseFloat(syncedParams.takeProfit)));
    }
  }, [syncedParams]);

  // Set default selected position
  useEffect(() => {
    if (positions.length > 0 && !selectedPosId) {
      setSelectedPosId(positions[0].id);
    }
  }, [positions]);

  // Handle selected position chart mock simulation data
  useEffect(() => {
    if (selectedPosId) {
      const pos = positions.find(p => p.id === selectedPosId);
      if (pos) {
        // Build simulated chart history around current PnL
        const pnlVal = pos.pnlPercent;
        const pts = [];
        for (let i = 4; i >= 0; i--) {
          pts.push({
            time: `-${i * 5}s`,
            pnl: Math.round((pnlVal - (Math.random() * 8) + 4) * 10) / 10,
            threshold: takeProfit
          });
        }
        pts.push({ time: "Now", pnl: pnlVal, threshold: takeProfit });
        setChartData(pts);
      }
    } else {
      setChartData([]);
    }
  }, [selectedPosId, positions, takeProfit]);

  // Core Monitoring Loop
  useEffect(() => {
    if (!isEngineRunning) return;

    const interval = setInterval(() => {
      // Periodic check and event simulation
      positions.forEach(pos => {
        const currentPnl = pos.pnlPercent;
        
        // 1. Stop Loss check
        if (currentPnl <= -Math.abs(stopLoss)) {
          triggerExit(pos, "Stop-Loss Atômico", currentPnl, 100);
          return;
        }

        // 2. Take Profit check (only if ladder is not taking partial)
        if (!ladderActive && currentPnl >= takeProfit) {
          triggerExit(pos, "Take Profit Alvo", currentPnl, 100);
          return;
        }

        // 3. Ladder (Partial) Exit check
        if (ladderActive && currentPnl >= ladderTrigger1) {
          const reached = pos.ladderMilestonesReached || [];
          if (!reached.includes("ladder_1")) {
            pos.ladderMilestonesReached = [...reached, "ladder_1"];
            triggerExit(pos, `Saída Parcial Ladder (${ladderPct1}%)`, currentPnl, ladderPct1);
            return;
          }
        }

        // 4. Trailing Stop Loss
        // Track peak PnL
        if (trailingActive) {
          const currentPeak = pos.peakPnlPercent || 0;
          if (currentPnl > currentPeak) {
            pos.peakPnlPercent = currentPnl;
          } else if (currentPeak > 15) { // Activate after at least 15% gain
            const dropFromPeak = currentPeak - currentPnl;
            if (dropFromPeak >= trailingStop) {
              triggerExit(pos, `Trailing Stop (${trailingStop}% queda do pico ${currentPeak}%)`, currentPnl, 100);
              return;
            }
          }
        }
      });

      // Fluctuate monitor latency slightly to simulate network load
      setMonitorLatency(prev => Math.max(9, Math.min(25, prev + Math.floor(Math.random() * 5) - 2)));
    }, 1500);

    return () => clearInterval(interval);
  }, [positions, isEngineRunning, stopLoss, takeProfit, trailingStop, trailingActive, ladderActive, ladderTrigger1, ladderPct1]);

  const triggerExit = (pos: Position, reason: string, _pnl: number, percentToSell: number) => {
    // Add logs
    setParachuteLogs(prev => [
      `[💥 EXECUTION] DISPARADO GATILHO DE SAÍDA: ${reason} para $${pos.token}!`,
      `[⚡ MEV BUNDLE] Roteando venda de ${percentToSell}% via Jito BlockEngine com tip de ${jitoTip} SOL.`,
      `[📊 METRICS] Latência de Decisão: ${Math.floor(Math.random() * 5) + 6}ms | Slippage Real: ${(Math.random() * 0.4 + 0.1).toFixed(2)}%`,
      ...prev
    ]);

    // Notify parent component
    onSellPosition(pos.id, pos.token, percentToSell, reason);
  };

  const simulateRugPull = () => {
    if (positions.length === 0) {
      setParachuteLogs(prev => ["[ALERT] Nenhuma posição ativa para simular Rug Pull.", ...prev]);
      return;
    }

    const pos = positions[0];
    setParachuteLogs(prev => [
      `[🚨 DETECTOR] ATENÇÃO: Mudança brusca detectada no smart contract de $${pos.token}!`,
      `[🚨 DETECTOR] Retirada de 85% da Liquidez ou Taxa alterada para 99% (Honeypot)!`,
      `[💥 ESCAPE] Ativando protocolo de saída de emergência ("O Paraquedas")!`,
      ...prev
    ]);

    // Force flash-sell position at market
    setTimeout(() => {
      triggerExit(pos, "Detector de Rug/Honeypot Ativo (Layer 7)", -35.2, 100);
    }, 500);
  };

  return (
    <div id="position-parachute-manager" className="bg-slate-900 border border-slate-800 rounded-xl p-4 relative overflow-hidden flex flex-col gap-4">
      {/* Visual background element */}
      <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none"></div>

      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
            <LifeBuoy className="w-5 h-5 text-cyan-400 animate-spin-slow" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h2 className="text-sm font-sans font-extrabold text-slate-100 uppercase tracking-tight">
                O Paraquedas (The Parachute)
              </h2>
              <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-cyan-950/80 border border-cyan-800/40 text-cyan-400 uppercase">
                Layer 7
              </span>
            </div>
            <p className="text-[10px] font-mono text-slate-400">Gerenciador Atômico de Posição & Saída de Emergência HFT</p>
          </div>
        </div>

        {/* Engine status indicators */}
        <div className="flex items-center gap-3">
          <div className="text-right">
            <span className="block text-[9px] font-mono text-slate-500 uppercase">Latência de Decisão</span>
            <span className="font-mono text-xs text-emerald-400 font-bold">{monitorLatency}ms</span>
          </div>

          <button
            onClick={() => setIsEngineRunning(!isEngineRunning)}
            className={`px-2.5 py-1 rounded font-mono text-[10px] font-bold border transition-all flex items-center gap-1 cursor-pointer ${
              isEngineRunning 
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" 
                : "bg-slate-800 border-slate-700 text-slate-400"
            }`}
          >
            {isEngineRunning ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                MONITOR ATIVO
              </>
            ) : (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
                PAUSADO
              </>
            )}
          </button>
        </div>
      </div>

      {/* Main Grid: Threshold Settings & Active Positions tracking */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        
        {/* Left 2 Columns: Control & Settings sliders */}
        <div className="lg:col-span-2 space-y-4">
          
          {/* Safety thresholds block */}
          <div className="bg-slate-950/60 border border-slate-850 p-3 rounded-lg space-y-3">
            <div className="flex items-center justify-between border-b border-slate-850 pb-1.5">
              <h3 className="text-[11px] font-mono font-extrabold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-cyan-400" /> PARÂMETROS MATEMÁTICOS DE PROTEÇÃO
              </h3>
              <div className="flex gap-1.5">
                <button 
                  onClick={() => { setStopLoss(15); setTakeProfit(80); setTrailingStop(10); }}
                  className="text-[9px] font-mono text-slate-500 hover:text-slate-300 transition-colors"
                >
                  [RESETA]
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              
              {/* Stop Loss Input */}
              <div className="space-y-1">
                <div className="flex justify-between items-center text-xs font-mono">
                  <span className="text-slate-400">Stop Loss Atômico:</span>
                  <span className="text-rose-400 font-extrabold">-{stopLoss}%</span>
                </div>
                <input
                  type="range"
                  min="5"
                  max="45"
                  value={stopLoss}
                  onChange={(e) => setStopLoss(parseInt(e.target.value))}
                  className="w-full accent-rose-500 bg-slate-900 rounded-lg appearance-none h-1.5 cursor-pointer"
                />
                <span className="text-[9px] text-slate-500 block">Venda instantânea de mercado caso o preço caia abaixo desse limite.</span>
              </div>

              {/* Take Profit Input */}
              <div className="space-y-1">
                <div className="flex justify-between items-center text-xs font-mono">
                  <span className="text-slate-400">Take Profit Alvo (100%):</span>
                  <span className="text-emerald-400 font-extrabold">+{takeProfit}%</span>
                </div>
                <input
                  type="range"
                  min="20"
                  max="300"
                  value={takeProfit}
                  onChange={(e) => setTakeProfit(parseInt(e.target.value))}
                  className="w-full accent-emerald-500 bg-slate-900 rounded-lg appearance-none h-1.5 cursor-pointer"
                />
                <span className="text-[9px] text-slate-500 block">Realização integral de lucros na listagem ou na curva de vinculação.</span>
              </div>

              {/* Trailing Stop */}
              <div className="space-y-2 border-t border-slate-900 pt-2.5">
                <div className="flex justify-between items-center text-xs font-mono">
                  <label className="flex items-center gap-1.5 text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={trailingActive}
                      onChange={(e) => setTrailingActive(e.target.checked)}
                      className="rounded border-slate-800 text-cyan-500 focus:ring-cyan-500/20"
                    />
                    Trailing Stop Loss (Ativo)
                  </label>
                  <span className={`font-extrabold ${trailingActive ? "text-cyan-400" : "text-slate-500"}`}>
                    -{trailingStop}% do Pico
                  </span>
                </div>
                <input
                  type="range"
                  min="5"
                  max="25"
                  value={trailingStop}
                  onChange={(e) => setTrailingStop(parseInt(e.target.value))}
                  disabled={!trailingActive}
                  className="w-full accent-cyan-500 bg-slate-900 rounded-lg appearance-none h-1.5 cursor-pointer disabled:opacity-30"
                />
                <span className="text-[9px] text-slate-500 block">O gatilho acompanha a máxima e executa se o preço recuar {trailingStop}% do pico.</span>
              </div>

              {/* Partial sells (Laddering) */}
              <div className="space-y-2 border-t border-slate-900 pt-2.5">
                <div className="flex justify-between items-center text-xs font-mono">
                  <label className="flex items-center gap-1.5 text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={ladderActive}
                      onChange={(e) => setLadderActive(e.target.checked)}
                      className="rounded border-slate-800 text-cyan-500 focus:ring-cyan-500/20"
                    />
                    Saída Parcial Escalonada (Ladder)
                  </label>
                  <span className={`font-extrabold ${ladderActive ? "text-amber-400" : "text-slate-500"}`}>
                    Vender {ladderPct1}% aos +{ladderTrigger1}%
                  </span>
                </div>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="text-[8px] font-mono text-slate-500 block uppercase">% a vender</label>
                    <input
                      type="number"
                      min="10"
                      max="90"
                      value={ladderPct1}
                      onChange={(e) => setLadderPct1(parseInt(e.target.value) || 50)}
                      disabled={!ladderActive}
                      className="w-full bg-slate-900 border border-slate-850 rounded px-1.5 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-amber-500/50 disabled:opacity-30"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-[8px] font-mono text-slate-500 block uppercase">Trigger %</label>
                    <input
                      type="number"
                      min="10"
                      max="500"
                      value={ladderTrigger1}
                      onChange={(e) => setLadderTrigger1(parseInt(e.target.value) || 100)}
                      disabled={!ladderActive}
                      className="w-full bg-slate-900 border border-slate-850 rounded px-1.5 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-amber-500/50 disabled:opacity-30"
                    />
                  </div>
                </div>
                <span className="text-[9px] text-slate-500 block">Minimiza riscos vendendo fatias enquanto o moonshot continua subindo.</span>
              </div>

            </div>
          </div>

          {/* Active Positions List */}
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <h3 className="text-[11px] font-mono font-extrabold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-cyan-400 animate-pulse" /> POSIÇÕES SOB ESCRUTÍNIO ATÔMICO ({positions.length})
              </h3>
              
              <div className="flex gap-2">
                <button
                  onClick={simulateRugPull}
                  className="px-2.5 py-1 bg-rose-500 hover:bg-rose-600 text-white rounded font-mono font-bold text-[9px] transition-colors flex items-center gap-1 cursor-pointer shadow"
                >
                  <Flame className="w-3 h-3" /> SIMULAR DETECÇÃO DE RUG
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2">
              {positions.length === 0 ? (
                <div className="py-8 text-center bg-slate-950/40 border border-slate-850/50 rounded-lg text-slate-500 font-mono text-xs">
                  Sem posições ativas. Aguarde novas transações snipadas pelo gRPC Radar.
                </div>
              ) : (
                positions.map((pos) => {
                  const isSelected = pos.id === selectedPosId;
                  return (
                    <div
                      key={pos.id}
                      onClick={() => setSelectedPosId(pos.id)}
                      className={`p-3 bg-slate-950/80 hover:bg-slate-950 border rounded-lg transition-all flex flex-col sm:flex-row items-center justify-between gap-3 cursor-pointer ${
                        isSelected ? "border-cyan-500/40 shadow shadow-cyan-950/30" : "border-slate-850"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-cyan-950/50 border border-cyan-800/30 flex items-center justify-center text-xs font-mono font-bold text-cyan-400">
                          {pos.token[0]}
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-display font-extrabold text-sm text-slate-200">{pos.token}</span>
                            {pos.peakPnlPercent && pos.peakPnlPercent > pos.pnlPercent && (
                              <span className="text-[8px] font-mono text-cyan-400 bg-cyan-950/80 border border-cyan-900/40 px-1 py-0.2 rounded">
                                Pico: +{pos.peakPnlPercent}%
                              </span>
                            )}
                          </div>
                          <span className="block text-[10px] font-mono text-slate-400">
                            Volume: {pos.qty} | Entrada: {pos.avgEntry}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <span className="block text-xs font-mono font-bold text-slate-200">Total: {pos.valueSol}</span>
                          <span className={`text-[10px] font-mono font-bold ${pos.pnlPercent >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                            PnL Realtime: {pos.pnl}
                          </span>
                        </div>

                        <div className="flex gap-1.5">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              triggerExit(pos, "Saída Forçada de Mercado", pos.pnlPercent, 100);
                            }}
                            className="px-2 py-1 bg-rose-500/10 hover:bg-rose-500 text-rose-400 hover:text-white border border-rose-500/20 rounded font-display font-bold text-[10px] transition-all cursor-pointer"
                          >
                            EXIT
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

        </div>

        {/* Right 1 Column: Real-time telemetry, charts, and performance logs */}
        <div className="space-y-4">
          
          {/* Chart Section */}
          <div className="p-3 bg-slate-950/60 border border-slate-850 rounded-lg flex flex-col justify-between h-48">
            <h3 className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider mb-2 flex items-center justify-between">
              <span>Rastreamento Milissegundo</span>
              {selectedPosId && <span className="text-cyan-400 text-[9px] font-bold">Token: {positions.find(p=>p.id === selectedPosId)?.token}</span>}
            </h3>
            
            {chartData.length > 0 ? (
              <div className="h-32">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 5, right: 5, left: -30, bottom: 0 }}>
                    <CartesianGrid stroke="#0f172a" vertical={false} />
                    <XAxis dataKey="time" stroke="#475569" fontSize={9} fontStyle="italic" />
                    <YAxis stroke="#475569" fontSize={9} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: "#020617", borderColor: "#1e293b" }}
                      itemStyle={{ color: "#22d3ee", fontSize: "11px", fontFamily: "monospace" }}
                    />
                    <Line type="monotone" dataKey="pnl" stroke="#06b6d4" strokeWidth={2} dot={true} />
                    <Line type="monotone" dataKey="threshold" stroke="#ef4444" strokeWidth={1} dot={false} strokeDasharray="3 3" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-center text-slate-600 text-[10px] font-mono">
                Selecione uma posição para monitoramento gráfico em milissegundos
              </div>
            )}
          </div>

          {/* Jito Bundle Tip details & gas optimizer */}
          <div className="p-3 bg-slate-950/40 border border-slate-850 rounded-lg space-y-2">
            <h4 className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1 border-b border-slate-850 pb-1.5">
              <Zap className="w-3.5 h-3.5 text-cyan-400" /> MEV BUNDLE / CO-LOCATION EXIT
            </h4>
            
            <div className="space-y-2 text-[11px] font-mono">
              <div className="flex flex-col gap-1">
                <div className="flex justify-between">
                  <span className="text-slate-500">Jito Flash Exit Tip:</span>
                  <span className="text-cyan-400 font-bold">{jitoTip} SOL</span>
                </div>
                <input
                  type="range"
                  min="0.001"
                  max="0.05"
                  step="0.001"
                  value={jitoTip}
                  onChange={(e) => setJitoTip(parseFloat(e.target.value))}
                  className="w-full accent-cyan-500 bg-slate-900 rounded-lg appearance-none h-1 cursor-pointer"
                />
              </div>

              <div className="flex justify-between items-center text-[10px] bg-slate-950/80 p-1.5 border border-slate-850/60 rounded mt-2">
                <span className="text-emerald-400 flex items-center gap-1">
                  <CheckCircle className="w-3.5 h-3.5" /> Jito BlockEngine On
                </span>
                <span className="text-slate-400">Co-location: 0.8ms</span>
              </div>
            </div>
          </div>

        </div>

      </div>

      {/* Realtime Action Logs Terminal */}
      <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-850 text-[10px] font-mono flex-1 min-h-[110px] flex flex-col">
        <span className="text-slate-500 uppercase tracking-widest text-[9px] border-b border-slate-850/60 pb-1 mb-1.5 block">
          REGISTRO DE SAÍDAS & EVENTOS DE LIQUIDAÇÃO (O PARAQUEDAS LAYER 7)
        </span>
        <div className="overflow-y-auto max-h-[110px] space-y-1 select-text scrollbar-thin">
          {parachuteLogs.map((log, index) => (
            <div key={index} className="text-slate-400">
              <span className="text-slate-600">[{new Date().toTimeString().split(' ')[0]}]</span> {log}
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}
