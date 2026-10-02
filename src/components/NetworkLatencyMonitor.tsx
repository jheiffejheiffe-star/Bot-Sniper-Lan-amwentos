import { useState, useEffect } from "react";
import { 
  Wifi, RefreshCw, Activity, Zap, Cpu, Server, Flame, 
  Database, Clock, Copy, Check, CornerDownRight 
} from "lucide-react";
import { RpcNode } from "../types";

export function NetworkLatencyMonitor() {
  const [nodes, setNodes] = useState<RpcNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [optimizing, setOptimizing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>("");
  const [coLocationActive, setCoLocationActive] = useState<boolean>(false);
  const [logs, setLogs] = useState<Array<{ time: string; fromNode: string; toNode: string; reason: string }>>([]);
  const [copied, setCopied] = useState(false);
  const [refreshingBlockhash, setRefreshingBlockhash] = useState(false);
  
  const [blockhashInfo, setBlockhashInfo] = useState({
    cachedBlockhash: "Hft5E8yvQ7N1gA9zK8uXy4mN2bVp3qW5e6f7g8h9jK",
    hits: 0,
    misses: 0,
    ttlMs: 1500,
    ageMs: 0
  });

  const fetchCoLocation = async () => {
    try {
      const res = await fetch("/api/co-location");
      const data = await res.json();
      setCoLocationActive(data.active);
    } catch (e) {
      console.warn("Failed to load co-location state", e);
    }
  };

  const toggleCoLocation = async () => {
    try {
      const res = await fetch("/api/co-location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !coLocationActive })
      });
      const data = await res.json();
      setCoLocationActive(data.active);
      
      // Auto-trigger recalculate on backend immediately
      await fetch("/api/rpc-infra/chaos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "recover_all" })
      });
      
      fetchData();
    } catch (e) {
      console.warn("Failed to toggle co-location state", e);
    }
  };

  const fetchData = async () => {
    try {
      // 1. Fetch nodes health & parameters
      const rpcRes = await fetch("/api/rpc-nodes");
      const rpcData = await rpcRes.json();
      setNodes(rpcData.nodes || []);
      
      // 2. Fetch blockhash cache stats
      const bhRes = await fetch("/api/rpc-infra/blockhash");
      const bhData = await bhRes.json();
      setBlockhashInfo(bhData);

      // 3. Fetch failover logs
      const logsRes = await fetch("/api/rpc-infra/failover-logs");
      const logsData = await logsRes.json();
      setLogs(logsData.logs || []);

      setLastUpdated(new Date().toLocaleTimeString());
    } catch (e) {
      console.warn("Failed to fetch RPC infrastructure status", e);
    } finally {
      setLoading(false);
    }
  };

  const forceRefreshBlockhash = async () => {
    setRefreshingBlockhash(true);
    try {
      const res = await fetch("/api/rpc-infra/blockhash/refresh", { method: "POST" });
      const data = await res.json();
      setBlockhashInfo(prev => ({
        ...prev,
        cachedBlockhash: data.blockhash,
        ageMs: 0
      }));
    } catch (e) {
      console.warn("Failed to refresh blockhash", e);
    } finally {
      setRefreshingBlockhash(false);
    }
  };

  const handleChaosAction = async (nodeId: string, action: string, value?: number) => {
    try {
      const res = await fetch("/api/rpc-infra/chaos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId, action, value })
      });
      const data = await res.json();
      setNodes(data.nodes || []);
      setLogs(data.logs || []);
    } catch (e) {
      console.warn("Failed to trigger Chaos action", e);
    }
  };

  const handleOptimizeFailover = async () => {
    setOptimizing(true);
    // Simulate active ping sweeps & network rerouting telemetry in parallel
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    await sleep(400);
    
    try {
      await fetch("/api/rpc-infra/chaos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "recover_all" })
      });
      await fetchData();
    } catch (e) {
      console.warn("Failed to optimize failover", e);
    } finally {
      setOptimizing(false);
    }
  };

  const copyBlockhash = () => {
    navigator.clipboard.writeText(blockhashInfo.cachedBlockhash);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    fetchData();
    fetchCoLocation();
    
    // Quick polling interval (2000ms) for high-frequency infrastructure telemetry
    const interval = setInterval(fetchData, 2000);
    return () => clearInterval(interval);
  }, [coLocationActive]);

  const activePrimaryNode = nodes.find(n => n.isPrimary) || nodes.find(n => n.status === "healthy");

  return (
    <div id="network-latency-monitor" className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 backdrop-blur-md glow-cyan relative overflow-hidden flex flex-col justify-between h-full space-y-4">
      {/* Decorative ambient pulse glow */}
      <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none"></div>

      <div>
        {/* Header Block */}
        <div className="flex items-center justify-between mb-3 border-b border-slate-800/80 pb-3">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-cyan-400 animate-pulse" />
            <div>
              <h2 className="text-base font-display font-bold tracking-tight text-slate-100 flex items-center gap-1.5">
                Solana HFT Infrastructure Panel
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 font-mono animate-pulse">
                  v2.5 LIVE
                </span>
              </h2>
              <p className="text-[10px] font-mono text-slate-400 mt-0.5">Balanciador de Carga, Auto-Failover e Telemetria Ativa</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <button
              onClick={handleOptimizeFailover}
              disabled={optimizing}
              className={`px-2.5 py-1 text-[10px] font-mono font-bold rounded border transition-all cursor-pointer ${
                optimizing
                  ? "bg-slate-850 text-slate-500 border-slate-800"
                  : "bg-cyan-500/15 text-cyan-300 border-cyan-500/30 hover:bg-cyan-500/25 active:scale-95"
              }`}
              title="Optimize failover routes and clear chaos"
            >
              {optimizing ? "Roteando..." : "Reset Geral (Otimizar)"}
            </button>
            <button
              onClick={fetchData}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-cyan-400 transition-all cursor-pointer active:scale-95"
              title="Manual update"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-cyan-400' : ''}`} />
            </button>
          </div>
        </div>

        {/* Global Summary Info Bar */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mb-4">
          <div className="p-2 bg-slate-950 border border-slate-850 rounded-lg flex flex-col justify-center">
            <span className="text-[9px] font-mono text-slate-500 uppercase">Gateway Principal</span>
            <span className="text-xs font-display font-bold text-cyan-400 truncate mt-0.5">
              {activePrimaryNode ? activePrimaryNode.name.split(" (")[0] : "Buscando..."}
            </span>
          </div>

          <div className="p-2 bg-slate-950 border border-slate-850 rounded-lg flex flex-col justify-center">
            <span className="text-[9px] font-mono text-slate-500 uppercase">Blockhash HIT Rate</span>
            <span className="text-xs font-mono font-bold text-emerald-400 mt-0.5 flex items-center gap-1">
              <Database className="w-3 h-3" />
              {blockhashInfo.hits + blockhashInfo.misses > 0 
                ? `${((blockhashInfo.hits / (blockhashInfo.hits + blockhashInfo.misses)) * 100).toFixed(1)}%` 
                : "99.2%"}
            </span>
          </div>

          <div className="p-2 bg-slate-950 border border-slate-850 rounded-lg flex flex-col justify-center">
            <span className="text-[9px] font-mono text-slate-500 uppercase">Status do Roteador</span>
            <span className="text-xs font-mono font-bold text-purple-400 mt-0.5 flex items-center gap-1 animate-pulse">
              <Zap className="w-3 h-3 animate-bounce" />
              AUTO-FAILOVER ATIVO
            </span>
          </div>

          <div className="p-2 bg-slate-950 border border-slate-850 rounded-lg flex flex-col justify-center">
            <span className="text-[9px] font-mono text-slate-500 uppercase">Health Check</span>
            <span className="text-xs font-mono font-bold text-slate-300 mt-0.5 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>
              2000ms Contínuo
            </span>
          </div>
        </div>

        {/* AWS / Equinix Co-location Panel */}
        <div className="mb-4 p-2.5 rounded-lg border border-purple-500/20 bg-purple-500/5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-16 h-16 bg-purple-500/5 rounded-full blur-xl pointer-events-none"></div>
          <div className="flex items-center gap-2.5">
            <div className={`p-1.5 rounded-md border transition-all duration-300 ${
              coLocationActive 
                ? "bg-purple-500/20 border-purple-500/40 text-purple-400" 
                : "bg-slate-950 border-slate-800 text-slate-500"
            }`}>
              <Cpu className={`w-4 h-4 ${coLocationActive ? "animate-spin text-purple-400" : ""}`} />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-display font-bold text-slate-100">Co-location Física Equinix LD4</span>
                <span className={`text-[7px] font-mono px-1 rounded uppercase font-bold tracking-wider ${
                  coLocationActive 
                    ? "bg-purple-500/25 text-purple-300 border border-purple-500/30" 
                    : "bg-slate-900 text-slate-500 border border-slate-850"
                }`}>
                  {coLocationActive ? "Absolute God" : "Sem Co-location"}
                </span>
              </div>
              <p className="text-[9px] font-mono text-slate-400 mt-0.5 leading-relaxed">
                {coLocationActive 
                  ? "Bare Metal conectado diretamente via fibra escura. ShredStream sub-1.5ms." 
                  : "Ative o gateway ultra-rápido Bare Metal co-localizado com validadores em Frankfurt/London."
                }
              </p>
            </div>
          </div>
          
          <button
            onClick={toggleCoLocation}
            className={`w-full sm:w-auto px-2.5 py-1.25 rounded-md font-display font-bold text-[10px] transition-all cursor-pointer select-none text-center ${
              coLocationActive 
                ? "bg-purple-600 hover:bg-purple-500 text-white shadow-[0_0_8px_rgba(147,51,234,0.4)]" 
                : "bg-slate-850 hover:bg-slate-800 text-slate-200 border border-slate-700"
            }`}
          >
            {coLocationActive ? "Conectado ✅" : "Implantar Bare Metal"}
          </button>
        </div>

        {/* RPC Endpoints Grid */}
        <h3 className="text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1">
          <Server className="w-3 h-3 text-cyan-400" />
          Provedores RPC Integrados (Medidores de RTT, Slot Lag, Jitter e Loss)
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 mb-4">
          {nodes.map((node) => {
            const isPrimary = node.isPrimary;
            const isOffline = node.status === 'offline';
            const isDegraded = node.status === 'degraded';
            
            return (
              <div
                key={node.id}
                className={`p-3 bg-slate-950 border rounded-lg transition-all duration-300 relative ${
                  isPrimary
                    ? "border-cyan-500/40 shadow-[0_0_12px_rgba(6,182,212,0.15)] bg-slate-950"
                    : isOffline
                    ? "border-red-950/40 opacity-70 bg-slate-950/50"
                    : "border-slate-850/80 hover:border-slate-750/80"
                }`}
              >
                {/* Upper badges */}
                {isPrimary && (
                  <span className="absolute top-2.5 right-2.5 flex items-center gap-1 px-1.5 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/30 text-[8px] font-mono font-bold text-cyan-400">
                    <Zap className="w-2.5 h-2.5 animate-bounce" />
                    ROTA ATIVA
                  </span>
                )}

                {node.id === "rpc-bare-metal-shred" && node.status === "healthy" && (
                  <span className="absolute top-2.5 right-2.5 flex items-center gap-1 px-1.5 py-0.5 rounded bg-purple-500/15 border border-purple-500/30 text-[8px] font-mono font-bold text-purple-400 animate-pulse">
                    <Server className="w-2.5 h-2.5 text-purple-400" />
                    SHREDSTREAM
                  </span>
                )}

                {/* Node Info Header */}
                <div className="flex items-center gap-1.5 mb-1.5">
                  <div className={`w-2 h-2 rounded-full ${
                    isOffline 
                      ? 'bg-red-500 animate-pulse' 
                      : isDegraded 
                      ? 'bg-amber-500 animate-pulse'
                      : 'bg-emerald-500 animate-pulse'
                  }`}></div>
                  <div className="truncate">
                    <span className="font-display font-bold text-xs text-slate-200 truncate block max-w-[170px]">{node.name}</span>
                    <span className="text-[8px] font-mono text-slate-600 block truncate">{node.url || "Desconectado"}</span>
                  </div>
                </div>

                {/* Performance Metrics Row */}
                <div className="grid grid-cols-4 gap-1 bg-slate-900/50 p-1.5 rounded-md border border-slate-850/60 mt-2 text-[10px] font-mono">
                  <div className="flex flex-col items-center justify-center text-center">
                    <span className="text-[7px] text-slate-500 uppercase block">RTT (Ping)</span>
                    <span className={`font-bold block mt-0.5 ${
                      isOffline ? "text-slate-600" : node.latency < 5 ? "text-purple-400 font-extrabold" : node.latency < 25 ? "text-emerald-400" : node.latency < 75 ? "text-cyan-400" : "text-amber-500"
                    }`}>
                      {isOffline ? "∞" : `${node.latency}ms`}
                    </span>
                  </div>

                  <div className="flex flex-col items-center justify-center text-center border-l border-slate-850">
                    <span className="text-[7px] text-slate-500 uppercase block">Slot Lag</span>
                    <span className={`font-bold block mt-0.5 ${
                      isOffline ? "text-slate-600" : node.slotLag === 0 ? "text-emerald-400" : node.slotLag === 1 ? "text-amber-400" : "text-red-400"
                    }`}>
                      {isOffline ? "N/A" : `-${node.slotLag} slots`}
                    </span>
                  </div>

                  <div className="flex flex-col items-center justify-center text-center border-l border-slate-850">
                    <span className="text-[7px] text-slate-500 uppercase block">Jitter</span>
                    <span className={`font-bold block mt-0.5 ${isOffline ? "text-slate-600" : "text-slate-300"}`}>
                      {isOffline ? "N/A" : `±${node.jitterMs}ms`}
                    </span>
                  </div>

                  <div className="flex flex-col items-center justify-center text-center border-l border-slate-850">
                    <span className="text-[7px] text-slate-500 uppercase block">Loss (Perda)</span>
                    <span className={`font-bold block mt-0.5 ${
                      isOffline ? "text-slate-600" : node.packetLoss > 2 ? "text-red-400 font-bold" : node.packetLoss > 0 ? "text-amber-400" : "text-emerald-400"
                    }`}>
                      {isOffline ? "100%" : `${node.packetLoss}%`}
                    </span>
                  </div>
                </div>

                {/* Progress bar visualizer */}
                <div className="w-full bg-slate-900 h-1 rounded-full mt-2 overflow-hidden border border-slate-950">
                  <div
                    style={{ width: `${isOffline ? 0 : Math.min(100, Math.max(5, 100 - (node.latency * 0.7) - (node.slotLag * 10)))}%` }}
                    className={`h-full rounded-full transition-all duration-500 ${
                      isOffline
                        ? 'bg-slate-800'
                        : node.latency < 5
                        ? 'bg-purple-500'
                        : node.latency < 25
                        ? 'bg-emerald-500'
                        : node.latency < 70
                        ? 'bg-cyan-500'
                        : 'bg-amber-500'
                    }`}
                  ></div>
                </div>

                {/* Injected Chaos Controllers */}
                <div className="mt-3.5 pt-2 border-t border-slate-900/60 flex items-center justify-between gap-1">
                  <span className="text-[8px] font-mono text-slate-500 uppercase flex items-center gap-0.5">
                    <Flame className="w-2.5 h-2.5 text-amber-500" />
                    Injetar Caos:
                  </span>
                  
                  <div className="flex items-center gap-1 flex-wrap">
                    {isOffline ? (
                      <button
                        onClick={() => handleChaosAction(node.id, "recover")}
                        className="px-1.5 py-0.5 bg-emerald-500/10 border border-emerald-500/30 rounded text-[8px] font-mono font-bold text-emerald-400 hover:bg-emerald-500/25 active:scale-95 transition-all cursor-pointer"
                      >
                        Recuperar Canal
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() => handleChaosAction(node.id, "fail")}
                          className="px-1 py-0.5 bg-red-950/40 border border-red-900/30 hover:border-red-800/60 rounded text-[7.5px] font-mono text-red-400 hover:bg-red-500/10 active:scale-95 transition-all cursor-pointer"
                          title="Induce datacenter failure"
                        >
                          Derrubar
                        </button>
                        <button
                          onClick={() => handleChaosAction(node.id, "spike_latency", 280)}
                          className="px-1 py-0.5 bg-amber-950/40 border border-amber-900/30 hover:border-amber-800/60 rounded text-[7.5px] font-mono text-amber-400 hover:bg-amber-500/10 active:scale-95 transition-all cursor-pointer"
                          title="Spike RTT ping"
                        >
                          +RTT Spike
                        </button>
                        <button
                          onClick={() => handleChaosAction(node.id, "spike_lag", 3)}
                          className="px-1 py-0.5 bg-orange-950/40 border border-orange-900/30 hover:border-orange-800/60 rounded text-[7.5px] font-mono text-orange-400 hover:bg-orange-500/10 active:scale-95 transition-all cursor-pointer"
                          title="Introduce slot delay lag"
                        >
                          +Slot Lag
                        </button>
                        <button
                          onClick={() => handleChaosAction(node.id, "spike_packet_loss", 14)}
                          className="px-1 py-0.5 bg-rose-950/40 border border-rose-900/30 hover:border-rose-800/60 rounded text-[7.5px] font-mono text-rose-400 hover:bg-rose-500/10 active:scale-95 transition-all cursor-pointer"
                          title="Inject packet loss burst"
                        >
                          +Loss Burst
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Shared Blockhash Cache Center */}
        <div className="p-3 bg-slate-950 border border-slate-850 rounded-xl mb-4 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-24 h-24 bg-cyan-500/[0.02] rounded-full blur-xl pointer-events-none"></div>
          
          <div className="flex items-center justify-between mb-2 pb-1.5 border-b border-slate-900">
            <div className="flex items-center gap-1.5">
              <Database className="w-4 h-4 text-cyan-400" />
              <div>
                <span className="text-xs font-display font-bold text-slate-100 block">Cache de Blockhash Compartilhado</span>
                <span className="text-[8px] font-mono text-slate-500 block">HFT Global Mempool Block Synchronization</span>
              </div>
            </div>
            
            <button
              onClick={forceRefreshBlockhash}
              disabled={refreshingBlockhash}
              className={`px-2 py-1 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 rounded text-[9px] font-mono font-bold transition-all cursor-pointer flex items-center gap-1 ${
                refreshingBlockhash ? "animate-pulse" : ""
              }`}
            >
              <RefreshCw className={`w-3 h-3 ${refreshingBlockhash ? "animate-spin text-cyan-400" : ""}`} />
              Renovação Imediata
            </button>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mt-2.5">
            <div className="flex-1 bg-slate-900 border border-slate-850 rounded-lg p-2 flex items-center justify-between">
              <div className="truncate font-mono">
                <span className="text-[7.5px] text-slate-500 uppercase block">Bloco Atual Cacheado</span>
                <span className="text-xs text-slate-300 truncate tracking-tight font-bold select-all block">
                  {blockhashInfo.cachedBlockhash}
                </span>
              </div>
              <button 
                onClick={copyBlockhash}
                className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-cyan-400 transition-all cursor-pointer"
                title="Copy current blockhash"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 text-center text-xs font-mono">
              <div className="bg-slate-900 border border-slate-850 rounded-lg px-3 py-1.5 flex flex-col justify-center min-w-[70px]">
                <span className="text-[7px] text-slate-500 uppercase block">Cache HITS</span>
                <span className="text-emerald-400 font-bold block mt-0.5">{blockhashInfo.hits}</span>
              </div>
              <div className="bg-slate-900 border border-slate-850 rounded-lg px-3 py-1.5 flex flex-col justify-center min-w-[70px]">
                <span className="text-[7px] text-slate-500 uppercase block">Cache MISS</span>
                <span className="text-amber-400 font-bold block mt-0.5">{blockhashInfo.misses}</span>
              </div>
            </div>
          </div>

          {/* Age progress bar (refreshes in 1500ms intervals) */}
          <div className="w-full bg-slate-900 h-1.5 rounded-full mt-3 overflow-hidden border border-slate-950 flex">
            <div
              style={{ width: `${Math.min(100, Math.max(5, (1 - (blockhashInfo.ageMs / blockhashInfo.ttlMs)) * 100))}%` }}
              className={`h-full rounded-full transition-all duration-300 bg-cyan-500/70`}
            ></div>
          </div>
          <div className="flex justify-between items-center text-[7.5px] font-mono text-slate-600 uppercase mt-1">
            <span>Idade do Blockhash: {blockhashInfo.ageMs}ms</span>
            <span>Tempo Máx de Cache (TTL): {blockhashInfo.ttlMs}ms</span>
          </div>
        </div>

        {/* HFT Route Controller Stream Logs */}
        <div className="bg-slate-950 border border-slate-850 rounded-xl p-3">
          <div className="flex items-center justify-between pb-1.5 border-b border-slate-900 mb-2">
            <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider flex items-center gap-1">
              <Clock className="w-3.5 h-3.5 text-purple-400" />
              Feed HFT de Auto-Failover & Chaos Engineering
            </span>
            <button
              onClick={() => handleChaosAction("", "recover_all")}
              className="text-[8.5px] font-mono text-cyan-400 hover:text-cyan-300 font-bold underline cursor-pointer"
            >
              Normalizar Redes (Recuperar Tudo)
            </button>
          </div>

          <div className="h-32 overflow-y-auto font-mono text-[9.5px] text-slate-400 divide-y divide-slate-900/50 pr-1 select-text scrollbar-thin">
            {logs.length === 0 ? (
              <p className="text-slate-600 italic text-center pt-8">Nenhum evento de failover recente registrado.</p>
            ) : (
              logs.map((logItem, idx) => (
                <div key={idx} className="py-2 flex items-start gap-1.5 leading-relaxed">
                  <span className="text-slate-500 shrink-0 select-none bg-slate-900 px-1 py-0.5 rounded text-[8px]">{logItem.time}</span>
                  <div className="flex-1">
                    <div className="flex items-center gap-1">
                      <span className="text-purple-400 font-bold">{logItem.fromNode}</span>
                      <CornerDownRight className="w-3 h-3 text-slate-600" />
                      <span className="text-cyan-400 font-bold">{logItem.toNode}</span>
                    </div>
                    <p className="text-slate-400 mt-0.5 text-[9px]">{logItem.reason}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Footer indicators */}
      <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-500 font-mono">
        <span className="flex items-center gap-1.5">
          <Wifi className="w-3 h-3 text-emerald-500" />
          Conexão Multi-RPC: Ativa e Balanceada
        </span>
        <span>Sweep: {lastUpdated || "Sincronizando"}</span>
      </div>
    </div>
  );
}
