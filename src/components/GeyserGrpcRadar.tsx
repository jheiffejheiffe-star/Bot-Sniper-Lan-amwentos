import { useState, useEffect } from "react";
import { 
  Radio, 
  Terminal, 
  Sliders, 
  Activity, 
  Play, 
  FileCode,
  Zap
} from "lucide-react";
import { 
  ResponsiveContainer, 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  Tooltip, 
  CartesianGrid, 
  Legend 
} from "recharts";

interface GeyserEvent {
  id: string;
  timestamp: number;
  programId: string;
  programName: string;
  type: string;
  mint: string;
  mintName: string;
  grpcLatencyMs: number;
  jsonRpcLatencyMs: number;
  savedComputeUnits: number;
  rawProtobufHex: string;
}

interface GeyserStreamConfig {
  provider: "triton" | "helius" | "jito" | "custom";
  commitment: "processed" | "confirmed" | "finalized";
  filterRaydium: boolean;
  filterPumpFun: boolean;
  filterWhales: boolean;
  customFilterAddress: string;
}

export function GeyserGrpcRadar() {
  const [config, setConfig] = useState<GeyserStreamConfig>({
    provider: "triton",
    commitment: "processed",
    filterRaydium: true,
    filterPumpFun: true,
    filterWhales: false,
    customFilterAddress: ""
  });

  const [streamActive, setStreamActive] = useState(true);
  const [events, setEvents] = useState<GeyserEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<GeyserEvent | null>(null);
  const [systemStats, setSystemStats] = useState({
    currentSlot: 0,
    systemLoad: 0,
    activeChannels: 4,
    shredStreamState: "CONNECTED",
    messagesPerSecond: 1540
  });

  const [latencyHistory, setLatencyHistory] = useState<any[]>([]);
  const [timelineLogs, setTimelineLogs] = useState<string[]>([]);
  const [isSimulatingEvent, setIsSimulatingEvent] = useState(false);

  const fetchGeyserStream = async () => {
    if (!streamActive) return;
    try {
      const res = await fetch("/api/geyser-stream");
      const data = await res.json();
      
      setSystemStats({
        currentSlot: data.currentSlot,
        systemLoad: data.systemLoad,
        activeChannels: data.activeChannels,
        shredStreamState: data.shredStreamState,
        messagesPerSecond: data.messagesPerSecond
      });

      // Update events list (keep max 10 to avoid memory bloating)
      setEvents(prev => {
        const combined = [...data.events, ...prev];
        // Merge without duplicates
        const unique = combined.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i);
        // Sort by timestamp descending
        unique.sort((a, b) => b.timestamp - a.timestamp);
        return unique.slice(0, 10);
      });

      // Maintain a latency history for charting
      if (data.events && data.events.length > 0) {
        const latest = data.events[0];
        setLatencyHistory(prev => {
          const newPoint = {
            time: new Date(latest.timestamp).toLocaleTimeString().split(' ')[0],
            gRPC: latest.grpcLatencyMs,
            JSONRPC: latest.jsonRpcLatencyMs,
            Saved: parseFloat((latest.jsonRpcLatencyMs - latest.grpcLatencyMs).toFixed(1))
          };
          const nextHistory = [...prev, newPoint];
          if (nextHistory.length > 12) nextHistory.shift();
          return nextHistory;
        });
      }
    } catch (err) {
      console.error("Geyser stream fetch failed", err);
    }
  };

  useEffect(() => {
    fetchGeyserStream();
    const interval = setInterval(fetchGeyserStream, 3500);
    return () => clearInterval(interval);
  }, [streamActive]);

  // Set default selected event on load
  useEffect(() => {
    if (events.length > 0 && !selectedEvent) {
      setSelectedEvent(events[0]);
    }
  }, [events]);

  const simulateLivePoolCreation = async () => {
    setIsSimulatingEvent(true);
    setTimelineLogs([]);
    
    const logs = [
      "📶 [gRPC ShredStream] Handshake established with Seattle Solana validator node...",
      "⏱️ [0.00ms] Micro-block shredded payload received via socket pipeline",
      "🔍 [1.14ms] Scanning Protobuf payload for signature patterns...",
      "🧩 [2.58ms] Match found: Program ID '675k1g...' (Raydium Liquidity Pool v4)",
      "🧬 [3.92ms] Binary Protobuf parser completed: extracted Token Mint address and pool state info",
      "⚡ [5.21ms] RAM Volatile sandbox triggered for dynamic contract bytecode evaluation",
      "💵 [8.44ms] Local VM Dry-run: calculated Sell Tax (0.25%) and checked HoneyPot triggers",
      "🔥 [12.11ms] Pre-flight logic SUCCESS. Dynamic payload sent to Jito BlockEngine atomic bundle packer!"
    ];

    for (let i = 0; i < logs.length; i++) {
      await new Promise(resolve => setTimeout(resolve, i === 0 ? 150 : 250));
      setTimelineLogs(prev => [...prev, logs[i]]);
    }

    // Insert a custom simulated event at top of list
    const simulatedEvent: GeyserEvent = {
      id: `evt_sim_${Date.now()}`,
      timestamp: Date.now(),
      programId: "675k1g2EPJ8gS7q9yGP8REukXXhxZ9ReM78D4cifFGL",
      programName: "Raydium AMM",
      type: "PoolCreated (SIMULATED)",
      mint: "PumpGeysER781293...a82f",
      mintName: "GeyserSpeed",
      grpcLatencyMs: 4.8,
      jsonRpcLatencyMs: 382.4,
      savedComputeUnits: 31200,
      rawProtobufHex: "0a1402a35bfd2912440b8a1c" + Math.floor(Math.random() * 9000 + 1000)
    };

    setEvents(prev => [simulatedEvent, ...prev.slice(0, 9)]);
    setSelectedEvent(simulatedEvent);
    
    setLatencyHistory(prev => {
      const newPoint = {
        time: "SIMULATED",
        gRPC: 4.8,
        JSONRPC: 382.4,
        Saved: 377.6
      };
      const nextHistory = [...prev, newPoint];
      if (nextHistory.length > 12) nextHistory.shift();
      return nextHistory;
    });

    setIsSimulatingEvent(false);
  };

  const getProviderLabel = (prov: string) => {
    switch (prov) {
      case "triton": return "Triton One (gRPC Dedicated)";
      case "helius": return "Helius ShredStream (gRPC)";
      case "jito": return "Jito Relayer (gRPC)";
      case "custom": return "Custom Bare-metal Node";
      default: return "gRPC Provider";
    }
  };

  return (
    <div id="geyser-grpc-radar" className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 backdrop-blur-md relative overflow-hidden">
      <div className="absolute top-0 right-0 w-24 h-24 bg-cyan-500/5 rounded-full blur-2xl pointer-events-none"></div>

      {/* Main Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 mb-3 pb-2 border-b border-slate-800/60">
        <div className="flex items-center gap-2.5">
          <Radio className="w-5 h-5 text-cyan-400 animate-pulse" />
          <div>
            <h2 className="text-sm font-display font-bold text-slate-100 uppercase tracking-tight">Geyser gRPC Ingestão de Dados (Camada 5)</h2>
            <span className="text-[9px] font-mono text-cyan-400 block uppercase tracking-wider">Sub-50ms Solana Realtime Radar System</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className={`flex items-center gap-1.5 text-[9px] font-mono px-2 py-0.5 rounded border uppercase font-bold tracking-wider ${
            systemStats.shredStreamState.includes("COLOCATED") || systemStats.shredStreamState.includes("CO-LOCATED")
              ? "text-purple-400 bg-purple-500/10 border-purple-500/30 animate-pulse"
              : "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${
              systemStats.shredStreamState.includes("COLOCATED") || systemStats.shredStreamState.includes("CO-LOCATED")
                ? "bg-purple-400"
                : "bg-emerald-400 animate-ping"
            }`} />
            {systemStats.shredStreamState}
          </span>
          <button
            onClick={() => setStreamActive(!streamActive)}
            className={`px-2.5 py-1 text-[10px] font-mono font-bold rounded border transition-all cursor-pointer ${
              streamActive 
                ? "bg-rose-500/10 text-rose-400 border-rose-500/30 hover:bg-rose-500/20" 
                : "bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20"
            }`}
          >
            {streamActive ? "PAUSE STREAM" : "RESUME STREAM"}
          </button>
        </div>
      </div>

      {/* Grid: 2 columns - Left Controls and Stats, Right Stream Monitor */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 mb-5">
        
        {/* Left Hand: Controls and Settings (5 cols) */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-slate-950 p-4 rounded-lg border border-slate-850 space-y-3.5">
            <div className="flex items-center gap-1.5 pb-2 border-b border-slate-900">
              <Sliders className="w-4 h-4 text-cyan-400" />
              <span className="text-xs font-mono font-bold text-slate-300 uppercase tracking-wider">Stream Configuration</span>
            </div>

            {/* Provider Selector */}
            <div>
              <label className="block text-[9px] font-mono text-slate-500 uppercase tracking-wider mb-1">gRPC Stream Provider</label>
              <select
                value={config.provider}
                onChange={(e) => setConfig(prev => ({ ...prev, provider: e.target.value as any }))}
                className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500"
              >
                <option value="triton">Triton One (US-West/US-East Premium)</option>
                <option value="helius">Helius ShredStream (gRPC Pool)</option>
                <option value="jito">Jito Relayer Stream (Tokyo-NY)</option>
                <option value="custom">Custom Private Validator Geyser</option>
              </select>
            </div>

            {/* Commitment Level */}
            <div>
              <label className="block text-[9px] font-mono text-slate-500 uppercase tracking-wider mb-1">Block Commitment Filter</label>
              <div className="grid grid-cols-3 gap-1 bg-slate-900 p-0.5 rounded border border-slate-800">
                {(["processed", "confirmed", "finalized"] as const).map((level) => (
                  <button
                    key={level}
                    type="button"
                    onClick={() => setConfig(prev => ({ ...prev, commitment: level }))}
                    className={`py-1 text-[9px] font-mono font-bold rounded uppercase transition-all cursor-pointer ${
                      config.commitment === level 
                        ? "bg-cyan-600 text-white" 
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>

            {/* Toggles */}
            <div className="space-y-2 pt-1">
              <span className="block text-[9px] font-mono text-slate-500 uppercase tracking-wider">Event Message Filters</span>
              <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
                <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.filterRaydium}
                    onChange={(e) => setConfig(prev => ({ ...prev, filterRaydium: e.target.checked }))}
                    className="accent-cyan-500"
                  />
                  <span>Raydium Pools</span>
                </label>
                <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.filterPumpFun}
                    onChange={(e) => setConfig(prev => ({ ...prev, filterPumpFun: e.target.checked }))}
                    className="accent-cyan-500"
                  />
                  <span>Pump.fun Mints</span>
                </label>
                <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.filterWhales}
                    onChange={(e) => setConfig(prev => ({ ...prev, filterWhales: e.target.checked }))}
                    className="accent-cyan-500"
                  />
                  <span>Large Trades</span>
                </label>
                <span className="text-[9px] text-slate-500 flex items-center justify-end font-bold italic">
                  Active Filter
                </span>
              </div>
            </div>
          </div>

          {/* Quick Realtime Stats */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-slate-950 p-3 rounded-lg border border-slate-850">
              <span className="block text-[8px] font-mono text-slate-500 uppercase">Stream Rate</span>
              <span className="text-sm font-mono font-bold text-slate-200 mt-1 block">
                {systemStats.messagesPerSecond.toLocaleString()} <span className="text-[10px] text-slate-500 font-normal">msgs/s</span>
              </span>
            </div>
            <div className="bg-slate-950 p-3 rounded-lg border border-slate-850">
              <span className="block text-[8px] font-mono text-slate-500 uppercase">System Ingestion Load</span>
              <span className="text-sm font-mono font-bold text-cyan-400 mt-1 block">
                {systemStats.systemLoad}%
              </span>
            </div>
          </div>

          {/* Force Ingestion Event Trigger */}
          <div className="bg-slate-950 p-4 rounded-lg border border-slate-850/80">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-mono text-slate-400 uppercase tracking-wider font-bold">Simulador de Evento Geyser</span>
              <span className="text-[9px] font-mono text-purple-400 uppercase">Interactive</span>
            </div>
            <p className="text-[10px] font-mono text-slate-400 leading-normal mb-3">
              Gere um evento de liquidez artificial em tempo real para assistir à serialização Protobuf e ao pipeline de desserialização instantânea.
            </p>
            <button
              type="button"
              onClick={simulateLivePoolCreation}
              disabled={isSimulatingEvent}
              className="w-full py-2 bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 disabled:from-slate-800 disabled:to-slate-800 text-white font-bold font-mono text-xs rounded transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-lg shadow-cyan-950/20"
            >
              <Play className="w-3.5 h-3.5" />
              {isSimulatingEvent ? "Parsing Protobuf..." : "Forçar Ingestão Geyser"}
            </button>
          </div>
        </div>

        {/* Right Hand: Stream Monitor (7 cols) */}
        <div className="lg:col-span-7 space-y-4">
          <div className="bg-slate-950 p-4 rounded-lg border border-slate-850 flex flex-col justify-between">
            <div className="flex items-center justify-between pb-2 border-b border-slate-900 mb-3">
              <span className="text-xs font-mono font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <Terminal className="w-4 h-4 text-cyan-400 animate-pulse" />
                Live Ingestion Stream Feed
              </span>
              <span className="text-[9px] font-mono text-slate-500">
                Slot: <span className="text-cyan-400">{systemStats.currentSlot}</span>
              </span>
            </div>

            {/* List of events */}
            <div className="space-y-1 max-h-36 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-800 mb-2">
              {events.length === 0 ? (
                <div className="p-8 text-center text-slate-500 text-xs font-mono">
                  Aguardando stream do Geyser gRPC...
                </div>
              ) : (
                events.map((evt) => {
                  const isSelected = selectedEvent?.id === evt.id;
                  return (
                    <div
                      key={evt.id}
                      onClick={() => setSelectedEvent(evt)}
                      className={`p-2.5 rounded border text-[10px] font-mono cursor-pointer transition-all flex items-center justify-between ${
                        isSelected 
                          ? "bg-cyan-950/20 border-cyan-500/40 text-slate-100" 
                          : "bg-slate-900/60 border-slate-850 hover:border-slate-800 text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full ${evt.type.includes("SIMULATED") ? "bg-purple-400" : "bg-cyan-400 animate-pulse"}`}></span>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-slate-100">{evt.mintName}</span>
                            <span className="text-[8px] bg-slate-950 px-1 py-0.5 rounded text-cyan-400 font-bold uppercase">{evt.type}</span>
                          </div>
                          <span className="text-[8px] text-slate-500 truncate max-w-[150px] block mt-0.5">{evt.mint}</span>
                        </div>
                      </div>

                      <div className="flex flex-col items-end gap-0.5">
                        <span className="text-[9px] font-bold text-emerald-400">gRPC: {evt.grpcLatencyMs}ms</span>
                        <span className="text-[8px] text-slate-500">JSON-RPC: {evt.jsonRpcLatencyMs.toFixed(0)}ms</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Simulated Live Event Timeline Logs */}
            {timelineLogs.length > 0 && (
              <div className="p-3 bg-slate-900 border border-slate-800 rounded-lg text-[10px] font-mono text-slate-300 space-y-1 max-h-36 overflow-y-auto mb-4 animate-fade-in">
                <span className="text-[9px] text-cyan-400 font-bold uppercase block pb-1 border-b border-slate-850">HFT Microsecond Ingestion Trace:</span>
                {timelineLogs.map((log, idx) => (
                  <div key={idx} className="flex items-start gap-1">
                    <span className="text-cyan-500 select-none">&gt;</span>
                    <span>{log}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Selected Event Details: Raw Protobuf vs Decoded JSON JSON Viewer */}
            {selectedEvent && (
              <div className="border border-slate-850 rounded-lg overflow-hidden mt-2 bg-slate-900">
                <div className="bg-slate-950 px-3 py-1.5 border-b border-slate-850 flex items-center justify-between text-[9px] font-mono text-slate-400">
                  <span className="flex items-center gap-1">
                    <FileCode className="w-3.5 h-3.5 text-cyan-400" />
                    Protobuf Payload Conversion Sandbox (Layer 5 Deserializer)
                  </span>
                  <span>Decoder Speed: &lt; 0.2ms</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 text-[9px] font-mono divide-y sm:divide-y-0 sm:divide-x divide-slate-850">
                  {/* Left Column: Hex Dump Protobuf */}
                  <div className="p-2.5">
                    <span className="block text-slate-500 uppercase tracking-wider mb-1">Raw Protobuf Byte Stream:</span>
                    <div className="bg-slate-950 p-2 rounded text-rose-300 break-all select-text leading-tight font-mono h-20 overflow-y-auto">
                      {selectedEvent.rawProtobufHex}
                    </div>
                  </div>

                  {/* Right Column: JSON Result */}
                  <div className="p-2.5">
                    <span className="block text-slate-500 uppercase tracking-wider mb-1">Decoded Struct (HFT Stream):</span>
                    <div className="bg-slate-950 p-2 rounded text-emerald-400 break-all select-text font-mono h-20 overflow-y-auto leading-normal">
                      {`{`}
                      <br />
                      &nbsp;&nbsp;{`"mint": "${selectedEvent.mint.substring(0, 15)}...",`}
                      <br />
                      &nbsp;&nbsp;{`"program": "${selectedEvent.programName}",`}
                      <br />
                      &nbsp;&nbsp;{`"event_type": "${selectedEvent.type}"`}
                      <br />
                      {`}`}
                    </div>
                  </div>
                </div>
              </div>
            )}

          </div>
        </div>

      </div>

      {/* Latency Comparison Graph: Recharts */}
      <div className="bg-slate-950/80 border border-slate-850/80 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3 pb-1 border-b border-slate-900">
          <span className="text-xs font-mono font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <Activity className="w-4 h-4 text-cyan-400" />
            gRPC Stream vs JSON-RPC Polling Latency Matrix (ms)
          </span>
          <span className="text-[9px] font-mono text-emerald-400 font-bold uppercase">
            ⚡ Advantage: ~{latencyHistory.length > 0 ? (latencyHistory[latencyHistory.length - 1].Saved || 350).toFixed(0) : 380}ms Speed Boost
          </span>
        </div>

        <div className="h-32 w-full">
          {latencyHistory.length === 0 ? (
            <div className="h-full flex items-center justify-center text-slate-500 text-xs font-mono">
              Waiting for stream stream metrics...
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={latencyHistory} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#101726" />
                <XAxis dataKey="time" tick={{ fill: '#475569', fontSize: 8 }} />
                <YAxis tick={{ fill: '#475569', fontSize: 8 }} domain={[0, 'auto']} />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#090d16', borderColor: '#1e293b', borderRadius: '6px' }}
                  labelStyle={{ color: '#94a3b8', fontFamily: 'monospace', fontSize: 9 }}
                  itemStyle={{ fontFamily: 'monospace', fontSize: 9 }}
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: '9px', fontFamily: 'monospace', marginTop: '4px' }} />
                <Line type="monotone" dataKey="gRPC" stroke="#06b6d4" activeDot={{ r: 4 }} strokeWidth={2} name="Geyser gRPC Stream (ms)" />
                <Line type="monotone" dataKey="JSONRPC" stroke="#f43f5e" strokeWidth={1.5} strokeDasharray="3 3" name="JSON-RPC Polling (ms)" />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Footer Details */}
      <div className="mt-4 pt-2.5 border-t border-slate-850 flex items-center justify-between text-[9px] font-mono text-slate-500 uppercase tracking-wider">
        <span>Active gRPC Endpoint: <b className="text-cyan-400">{
          systemStats.shredStreamState.includes("COLOCATED") || systemStats.shredStreamState.includes("CO-LOCATED")
            ? "SHREDSTREAM CO-LOCATED (EQUINIX LD4)"
            : getProviderLabel(config.provider)
        }</b></span>
        <span className="flex items-center gap-1">
          <Zap className={`w-3.5 h-3.5 ${systemStats.shredStreamState.includes("COLOCATED") || systemStats.shredStreamState.includes("CO-LOCATED") ? "text-purple-400" : "text-cyan-400"}`} />
          {systemStats.shredStreamState.includes("COLOCATED") || systemStats.shredStreamState.includes("CO-LOCATED")
            ? "Pre-shred event ingest sub-1.2ms"
            : "Pre-shred event ingest sub-50ms"
          }
        </span>
      </div>
    </div>
  );
}
