import { useState, useEffect } from "react";
import { 
  Cpu, 
  Clock, 
  ShieldCheck, 
  ShieldAlert, 
  Terminal, 
  Database, 
  Play, 
  Loader2, 
  Activity,
  Award
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

interface SimulatorProps {
  selectedToken?: { name: string; mint: string } | null;
  onSimulationComplete?: (result: any) => void;
}

interface LatencyMetric {
  run: string;
  grpc: number;
  sandbox: number;
  total: number;
}

export function DeterministicSimulator({ selectedToken, onSimulationComplete }: SimulatorProps) {
  const [tokenMint, setTokenMint] = useState("PumpJtE71829...abc");
  const [tokenName, setTokenName] = useState("PUMP COIN");
  const [loading, setLoading] = useState(false);
  const [aesActive, setAesActive] = useState(true);
  const [authSignerRep, setAuthSignerRep] = useState<"elite" | "good" | "unregistered">("elite");
  const [activeChannel, setActiveChannel] = useState<"equinix" | "triton" | "yellowstone">("equinix");
  
  // Simulation results state
  const [simResult, setSimResult] = useState<any>({
    tokenMint: "PumpJtE71829...abc",
    tokenName: "PUMP COIN",
    grpcIngestLatencyMs: 9.4,
    simulationLatencyMs: 6.2,
    totalPipelineLatencyMs: 15.6,
    computeUnits: 42800,
    buyTax: 0.0,
    sellTax: 0.8, // τ_venda
    isHoneypot: false,
    isTransferBlocked: false,
    gasSavedSol: 0.0,
    status: "verified",
    simulationTrace: [
      "[Geyser gRPC] Capturado evento PairCreated do Raydium em 9.4ms",
      "[Local Sandbox] Carregando bytecode do contrato na RAM volátil",
      "[Solana VM Sandbox] Executando Swap de Compra: 42800 Compute Units consumidos",
      "[Sucesso] Teste de Venda concluído. Retorno líquido esperado condiz com preço teórico (Taxa: 0.8%)",
      "[Jito Bundler] Bundle de simulação atômica APROVADO para envio prioritário"
    ]
  });

  // Keep a history of the last 7 simulation runs for the telemetry chart
  const [latencyHistory, setLatencyHistory] = useState<LatencyMetric[]>([
    { run: "Run 1", grpc: 9.2, sandbox: 5.4, total: 14.6 },
    { run: "Run 2", grpc: 10.1, sandbox: 6.1, total: 16.2 },
    { run: "Run 3", grpc: 8.8, sandbox: 5.2, total: 14.0 },
    { run: "Run 4", grpc: 11.5, sandbox: 7.2, total: 18.7 },
    { run: "Run 5", grpc: 9.6, sandbox: 5.8, total: 15.4 },
    { run: "Run 6", grpc: 10.4, sandbox: 6.3, total: 16.7 },
    { run: "Run 7", grpc: 9.4, sandbox: 6.2, total: 15.6 },
  ]);

  // Sync with selected token from MempoolScanner
  useEffect(() => {
    if (selectedToken) {
      setTokenMint(selectedToken.mint);
      setTokenName(selectedToken.name);
      triggerSimulation(selectedToken.mint, selectedToken.name);
    }
  }, [selectedToken]);

  const triggerSimulation = async (mint: string, name: string) => {
    setLoading(true);
    try {
      const response = await fetch("/api/simulate-fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenMint: mint, tokenName: name })
      });
      const data = await response.json();
      
      if (data) {
        setSimResult(data);
        
        // Add run to chart telemetry history
        setLatencyHistory(prev => {
          const updated = [...prev];
          if (updated.length >= 8) updated.shift();
          const runNum = prev.length + 1;
          updated.push({
            run: `Run ${runNum}`,
            grpc: data.grpcIngestLatencyMs,
            sandbox: data.simulationLatencyMs,
            total: data.totalPipelineLatencyMs
          });
          return updated;
        });

        if (onSimulationComplete) {
          onSimulationComplete(data);
        }
      }
    } catch (err) {
      console.error("Local pre-flight simulation failed", err);
    } finally {
      setLoading(false);
    }
  };

  const handleRunSim = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenMint) return;
    triggerSimulation(tokenMint, tokenName);
  };

  return (
    <div id="deterministic-simulator-panel" className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 backdrop-blur-md relative overflow-hidden flex flex-col justify-between h-full">
      <div className="absolute top-0 right-0 w-24 h-24 bg-cyan-500/5 rounded-full blur-2xl pointer-events-none"></div>

      <div>
        <div className="flex items-center justify-between mb-2.5 pb-2 border-b border-slate-800/60">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-purple-400 animate-pulse" />
            <div>
              <h2 className="text-xs font-display font-bold text-slate-100 uppercase tracking-tight">Honeypot Core - Simulação Local</h2>
              <span className="text-[9px] font-mono text-purple-400/80 block uppercase tracking-wider">Cérebro: Pre-Flight Analytics (Atômico)</span>
            </div>
          </div>
          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-purple-500/10 border border-purple-500/20">
            <Database className="w-3 h-3 text-purple-400" />
            <span className="text-[9px] font-mono font-medium text-purple-300">
              SV Sandbox
            </span>
          </div>
        </div>

        {/* Input Form */}
        <form onSubmit={handleRunSim} className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2.5">
          <div>
            <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">Meme Target</label>
            <input
              type="text"
              value={tokenName}
              onChange={(e) => setTokenName(e.target.value)}
              disabled={loading}
              className="w-full bg-slate-950 border border-slate-850 focus:border-purple-500 rounded px-2.5 py-1.5 text-xs font-mono text-slate-200 focus:outline-none"
              placeholder="e.g. MOONCAT"
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">Mint Address</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={tokenMint}
                onChange={(e) => setTokenMint(e.target.value)}
                disabled={loading}
                className="w-full bg-slate-950 border border-slate-850 focus:border-purple-500 rounded px-2.5 py-1.5 text-xs font-mono text-slate-200 focus:outline-none"
                placeholder="Endereço Mint..."
              />
              <button
                type="submit"
                disabled={loading}
                className="px-3 rounded bg-purple-600 hover:bg-purple-500 text-white font-bold transition-all text-xs cursor-pointer flex items-center justify-center min-w-[40px]"
                title="Executar simulação determinística"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
              </button>
            </div>
          </div>
        </form>

        {/* Parameters & Telemetry */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-2.5">
          {/* AES Encryptor */}
          <div className="p-2 bg-slate-950 rounded-lg border border-slate-850 flex flex-col justify-between">
            <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wider block">1. Criptografia RAM</span>
            <div className="flex items-center justify-between mt-1">
              <span className="text-[10px] font-mono font-bold text-slate-300">AES-256 State</span>
              <button
                type="button"
                onClick={() => setAesActive(!aesActive)}
                className={`px-1 py-0.5 rounded text-[9px] font-mono font-bold uppercase transition-colors ${
                  aesActive ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30" : "bg-rose-500/10 text-rose-400 border border-rose-500/30"
                }`}
              >
                {aesActive ? "Ativo" : "Inativo"}
              </button>
            </div>
          </div>

          {/* authSigner Reputation */}
          <div className="p-2 bg-slate-950 rounded-lg border border-slate-850 flex flex-col justify-between">
            <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wider block">2. authSigner Jito</span>
            <select
              value={authSignerRep}
              onChange={(e: any) => setAuthSignerRep(e.target.value)}
              className="bg-slate-900 border border-slate-800 rounded px-1.5 py-0.5 mt-1 text-[10px] font-mono text-purple-300 outline-none"
            >
              <option value="elite">Elite (Top 1%)</option>
              <option value="good">Good Status</option>
              <option value="unregistered">New Handshake</option>
            </select>
          </div>

          {/* Ingestion Stream */}
          <div className="p-2 bg-slate-950 rounded-lg border border-slate-850 flex flex-col justify-between">
            <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wider block">3. Canal Geyser gRPC</span>
            <select
              value={activeChannel}
              onChange={(e: any) => setActiveChannel(e.target.value)}
              className="bg-slate-900 border border-slate-800 rounded px-1.5 py-0.5 mt-1 text-[10px] font-mono text-purple-300 outline-none"
            >
              <option value="equinix">Equinix NY4 fiber</option>
              <option value="triton">Triton Premium Stream</option>
              <option value="yellowstone">Yellowstone gRPC</option>
            </select>
          </div>
        </div>

        {/* Dynamic Simulation Result Card */}
        {simResult && (
          <div className="space-y-3">
            <div className={`p-3.5 rounded-lg border ${
              simResult.isHoneypot 
                ? "bg-rose-950/20 border-rose-800/40" 
                : "bg-purple-950/15 border-purple-800/30"
            }`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  {simResult.isHoneypot ? (
                    <ShieldAlert className="w-4 h-4 text-rose-400" />
                  ) : (
                    <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  )}
                  <span className="text-xs font-display font-bold text-slate-200 uppercase">
                    Resultado: {simResult.isHoneypot ? "ALERTA - HONEYPOT DETECTADO" : "LIVRE - DETECÇÃO SEGURA"}
                  </span>
                </div>
                <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${
                  simResult.isHoneypot ? "bg-rose-500/10 text-rose-400" : "bg-emerald-500/10 text-emerald-400"
                }`}>
                  {simResult.isHoneypot ? "REJEITADO" : "LIBERADO"}
                </span>
              </div>

              {/* Grid with exact requested math: τ_venda / taxes */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center mt-2 pb-2.5 border-b border-slate-800/40">
                <div className="bg-slate-950/80 p-1.5 rounded border border-slate-850/60">
                  <span className="block text-[8px] font-mono text-slate-500 uppercase">Taxa Venda (τ<sub>venda</sub>)</span>
                  <span className={`text-xs font-mono font-bold ${simResult.isHoneypot ? "text-rose-400" : "text-purple-400"}`}>
                    {simResult.sellTax}%
                  </span>
                </div>
                <div className="bg-slate-950/80 p-1.5 rounded border border-slate-850/60">
                  <span className="block text-[8px] font-mono text-slate-500 uppercase">Taxa Compra (τ<sub>compra</sub>)</span>
                  <span className="text-xs font-mono font-bold text-slate-300">
                    {simResult.buyTax}%
                  </span>
                </div>
                <div className="bg-slate-950/80 p-1.5 rounded border border-slate-850/60">
                  <span className="block text-[8px] font-mono text-slate-500 uppercase">Compute Units (CU)</span>
                  <span className="text-xs font-mono font-bold text-slate-300">
                    {simResult.computeUnits.toLocaleString()}
                  </span>
                </div>
                <div className="bg-slate-950/80 p-1.5 rounded border border-slate-850/60">
                  <span className="block text-[8px] font-mono text-slate-500 uppercase">Salvo da Mempool</span>
                  <span className="text-xs font-mono font-bold text-emerald-400">
                    {simResult.gasSavedSol > 0 ? `${simResult.gasSavedSol.toFixed(3)} SOL` : "0.0 SOL"}
                  </span>
                </div>
              </div>

              {/* Mathematical Modeling Breakdown */}
              <div className="mt-2.5 p-2 bg-slate-950/60 rounded border border-slate-850/50">
                <div className="text-[9px] font-mono text-slate-400 uppercase tracking-wider mb-1 flex items-center justify-between">
                  <span>Fórmula de Modelagem Matemática Local (Pre-Flight)</span>
                  <span className="text-cyan-400 font-bold">τ_venda = 1 - T_tokens / (B_venda * P_teorico)</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-[10px] font-mono mt-1 pt-1.5 border-t border-slate-900">
                  <div className="flex flex-col">
                    <span className="text-slate-500 text-[8px] uppercase">T_tokens (Adquiridos)</span>
                    <span className="text-slate-300 font-bold">{simResult.tTokens?.toLocaleString() || "10.000"} tokens</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-slate-500 text-[8px] uppercase">B_venda (Retorno SOL)</span>
                    <span className={`font-bold ${simResult.isHoneypot ? "text-rose-400" : "text-emerald-400"}`}>{simResult.bVenda || "0.95"} SOL</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-slate-500 text-[8px] uppercase">P_teorico (Taxa/SOL)</span>
                    <span className="text-slate-300 font-bold">{simResult.pTeorico?.toLocaleString() || "10.000"}</span>
                  </div>
                </div>
                {simResult.literalTauVenda !== undefined && (
                  <div className="text-[9px] font-mono text-slate-400 mt-1.5 flex justify-between items-center bg-slate-900/40 p-1 rounded">
                    <span>τ_venda literal calculado: <b className="font-bold text-slate-200">{simResult.literalTauVenda}</b></span>
                    <span className={`px-1 rounded text-[8px] font-bold ${simResult.isHoneypot ? "bg-rose-500/10 text-rose-400" : "bg-emerald-500/10 text-emerald-400"}`}>
                      {simResult.isHoneypot ? "τ_venda > 10% (ABORTADO)" : "τ_venda ≤ 10% (APROVADO)"}
                    </span>
                  </div>
                )}
              </div>

              {/* Latency Pipeline Breakdown */}
              <div className="flex flex-wrap items-center justify-between gap-2 mt-2.5 text-[10px] font-mono text-slate-400">
                <div className="flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-purple-400" />
                  <span>Pipeline Latency:</span>
                </div>
                <div className="flex gap-3 text-[9px]">
                  <span>Geyser Ingest: <b className="text-purple-400 font-bold">{simResult.grpcIngestLatencyMs}ms</b></span>
                  <span>Sandbox Execution: <b className="text-purple-400 font-bold">{simResult.simulationLatencyMs}ms</b></span>
                  <span>Total: <b className="text-emerald-400 font-bold">{simResult.totalPipelineLatencyMs}ms</b></span>
                </div>
              </div>
            </div>

            {/* Simulated execution logs trace */}
            <div className="p-3 bg-slate-950 rounded-lg border border-slate-850 space-y-1">
              <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-500 pb-1 border-b border-slate-850/60 uppercase">
                <Terminal className="w-3.5 h-3.5 text-purple-400" />
                <span>Rastreamento em Tempo Real do Bloco</span>
              </div>
              <div className="space-y-1 mt-1 font-mono text-[10px] leading-relaxed">
                {simResult.simulationTrace?.map((trace: string, idx: number) => (
                  <div key={idx} className={`flex items-start gap-1.5 ${
                    trace.includes("[ALERTA]") ? "text-rose-400" : trace.includes("[Sucesso]") ? "text-emerald-400" : "text-slate-400"
                  }`}>
                    <span className="text-slate-600 select-none">&gt;</span>
                    <span>{trace}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Grafana-style Telemetry chart of Simulator Latency Distribution */}
            <div className="bg-slate-950/80 p-3 rounded-lg border border-slate-850">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[9px] font-mono text-slate-400 uppercase tracking-widest flex items-center gap-1">
                  <Activity className="w-3.5 h-3.5 text-purple-400 animate-pulse" />
                  Grafana Stream: Latency Distribution (ms)
                </span>
                <span className="text-[8px] font-mono text-slate-500">Tier-1 Fiber Transit</span>
              </div>
              <div className="h-24 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={latencyHistory} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                    <defs>
                      <linearGradient id="latencyGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#a855f7" stopOpacity={0.2}/>
                        <stop offset="95%" stopColor="#a855f7" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="run" tick={{ fill: '#64748b', fontSize: 8 }} />
                    <YAxis tick={{ fill: '#64748b', fontSize: 8 }} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#090d16', borderColor: '#334155', borderRadius: '6px' }}
                      labelStyle={{ color: '#94a3b8', fontFamily: 'monospace', fontSize: 9 }}
                      itemStyle={{ color: '#a855f7', fontFamily: 'monospace', fontSize: 9 }}
                    />
                    <Area type="monotone" dataKey="total" stroke="#a855f7" fillOpacity={1} fill="url(#latencyGrad)" strokeWidth={1.5} name="Total Latency" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="text-[9px] font-mono text-slate-500 mt-3 pt-2 border-t border-slate-850/60 text-center uppercase tracking-wider flex items-center justify-center gap-1">
        <Award className="w-3.5 h-3.5 text-purple-400" />
        HFT Decision System: Elite 10% Competitiveness Guaranteed
      </div>
    </div>
  );
}
