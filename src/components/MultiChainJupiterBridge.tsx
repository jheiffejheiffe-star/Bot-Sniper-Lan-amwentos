import { useState, useEffect } from "react";
import { 
  Globe, 
  RefreshCw, 
  Shuffle, 
  Compass, 
  MapPin, 
  TrendingUp, 
  CheckCircle, 
  Cpu, 
  ArrowRight
} from "lucide-react";

interface RouteStep {
  dex: string;
  percent: number;
  inputToken: string;
  outputToken: string;
}

interface ArbOpportunity {
  id: string;
  sourceChain: string;
  targetChain: string;
  token: string;
  spread: number; // in %
  profitSol: number;
  bridge: string;
  status: "detected" | "executing" | "completed";
}

export function MultiChainJupiterBridge() {
  const [activeChain, setActiveChain] = useState<"solana" | "base" | "ethereum" | "bsc">("solana");
  const [slippage, setSlippage] = useState<number>(0.3); // Configurable slippage
  const [isSearchingArb, setIsSearchingArb] = useState<boolean>(true);
  
  // Jupiter routing simulation variables
  const [selectedRoute, setSelectedRoute] = useState<RouteStep[]>([
    { dex: "Raydium CLMM", percent: 40, inputToken: "SOL", outputToken: "USDC" },
    { dex: "Meteora DLMM", percent: 35, inputToken: "SOL", outputToken: "USDC" },
    { dex: "Orca Whirlpool", percent: 25, inputToken: "SOL", outputToken: "USDC" }
  ]);
  const [bestPrice, setBestPrice] = useState<number>(142.45);
  const [priceImpact, setPriceImpact] = useState<number>(0.04); // 0.04%

  // Multi-chain node health parameters
  const [chainNodes, setChainNodes] = useState({
    solana: { ping: 14, blockTime: "400ms", location: "Frankfurt (DE)", workerActive: true },
    base: { ping: 28, blockTime: "2.0s", location: "Virginia (US)", workerActive: true },
    ethereum: { ping: 42, blockTime: "12.0s", location: "Virginia (US)", workerActive: true },
    bsc: { ping: 35, blockTime: "3.0s", location: "Frankfurt (DE)", workerActive: true }
  });

  // Cross-chain arbitrage live streams
  const [arbitrages, setArbitrages] = useState<ArbOpportunity[]>([
    { id: "arb_1", sourceChain: "solana", targetChain: "base", token: "WIF", spread: 1.45, profitSol: 1.22, bridge: "Wormhole", status: "completed" },
    { id: "arb_2", sourceChain: "bsc", targetChain: "solana", token: "USDT", spread: 0.88, profitSol: 0.65, bridge: "deBridge", status: "executing" }
  ]);

  const [bridgeLogs, setBridgeLogs] = useState<string[]>([
    "[GLOBAL] Módulo de Roteamento Jupiter V6 e Expansão Multi-Chain (Layer 10) ativado.",
    "[JUPITER] Sincronizado com API de Roteamento Inteligente da Jupiter v6.",
    "[KAFKA] Subscrevendo a tópicos de eventos em formato Protobuf para baixa latência.",
    "[WORKERS] Trabalhador multi-região ativo monitorando Frankfurt (Solana/BSC) e Virgínia (EVM/Base)."
  ]);

  // Periodic simulations for multi-chain telemetry
  useEffect(() => {
    const interval = setInterval(() => {
      // 1. Simulate mild changes in RPC pings
      setChainNodes(prev => ({
        solana: { ...prev.solana, ping: Math.max(9, Math.min(25, prev.solana.ping + Math.floor(Math.random() * 5) - 2)) },
        base: { ...prev.base, ping: Math.max(20, Math.min(45, prev.base.ping + Math.floor(Math.random() * 7) - 3)) },
        ethereum: { ...prev.ethereum, ping: Math.max(35, Math.min(65, prev.ethereum.ping + Math.floor(Math.random() * 9) - 4)) },
        bsc: { ...prev.bsc, ping: Math.max(28, Math.min(50, prev.bsc.ping + Math.floor(Math.random() * 7) - 3)) }
      }));

      // 2. Refresh Jupiter routes slightly
      if (Math.random() > 0.5) {
        const randVal = Math.random();
        if (randVal < 0.3) {
          setSelectedRoute([
            { dex: "Meteora DLMM", percent: 50, inputToken: "SOL", outputToken: "USDC" },
            { dex: "Orca Whirlpool", percent: 50, inputToken: "SOL", outputToken: "USDC" }
          ]);
        } else if (randVal < 0.6) {
          setSelectedRoute([
            { dex: "Raydium CLMM", percent: 60, inputToken: "SOL", outputToken: "USDC" },
            { dex: "Phoenix DEX", percent: 40, inputToken: "SOL", outputToken: "USDC" }
          ]);
        } else {
          setSelectedRoute([
            { dex: "Raydium CLMM", percent: 40, inputToken: "SOL", outputToken: "USDC" },
            { dex: "Meteora DLMM", percent: 35, inputToken: "SOL", outputToken: "USDC" },
            { dex: "Orca Whirlpool", percent: 25, inputToken: "SOL", outputToken: "USDC" }
          ]);
        }
        setPriceImpact(parseFloat((0.02 + Math.random() * 0.05).toFixed(3)));
        setBestPrice(parseFloat((142.2 + Math.random() * 0.5).toFixed(2)));
      }

      // 3. Generate new cross-chain arbitrage opportunities if searching is enabled
      if (isSearchingArb && Math.random() > 0.7) {
        const tokens = ["WIF", "BONK", "SOL", "USDC", "POPCAT"];
        const chains = ["solana", "base", "ethereum", "bsc"];
        const randomToken = tokens[Math.floor(Math.random() * tokens.length)];
        const src = chains[Math.floor(Math.random() * chains.length)];
        let dest = chains[Math.floor(Math.random() * chains.length)];
        while (src === dest) {
          dest = chains[Math.floor(Math.random() * chains.length)];
        }
        const spread = parseFloat((0.4 + Math.random() * 1.8).toFixed(2));
        const profit = parseFloat((0.2 + Math.random() * 2.1).toFixed(2));
        const bridges = ["Wormhole", "deBridge", "Celer cBridge", "LayerZero"];
        const selectedBridge = bridges[Math.floor(Math.random() * bridges.length)];

        const newArb: ArbOpportunity = {
          id: `arb_${Date.now()}`,
          sourceChain: src,
          targetChain: dest,
          token: randomToken,
          spread,
          profitSol: profit,
          bridge: selectedBridge,
          status: "detected"
        };

        setArbitrages(prev => {
          const next = [newArb, ...prev.slice(0, 4)];
          // Automatically progress status to completed or executing
          setTimeout(() => {
            setArbitrages(current => current.map(item => {
              if (item.id === newArb.id) {
                return { ...item, status: "executing" };
              }
              return item;
            }));
            setBridgeLogs(logs => [
              `[⚡ EXECUTION] Disparada transação de arbitragem para ${randomToken} (${src.toUpperCase()} -> ${dest.toUpperCase()}) via ${selectedBridge}.`,
              ...logs
            ]);
          }, 800);

          setTimeout(() => {
            setArbitrages(current => current.map(item => {
              if (item.id === newArb.id) {
                return { ...item, status: "completed" };
              }
              return item;
            }));
            setBridgeLogs(logs => [
              `[🏆 ARB SUCCESS] Arbitragem concluída para ${randomToken}! Lucro líquido realizado: +${profit.toFixed(2)} SOL. Spread: ${spread}%.`,
              ...logs
            ]);
          }, 2000);

          return next;
        });

        setBridgeLogs(logs => [
          `[🚨 DETECTOR] Oportunidade identificada: ${randomToken} spread de ${spread}% entre ${src.toUpperCase()} e ${dest.toUpperCase()}.`,
          ...logs
        ]);
      }
    }, 4000);

    return () => clearInterval(interval);
  }, [isSearchingArb]);

  const forceRouteRequery = () => {
    setBridgeLogs(prev => [
      `[JUPITER] Requisitando nova cotação (quote) v6 de roteamento ótimo...`,
      `[JUPITER] Best Quote: 1 SOL -> ${bestPrice} USDC via ${selectedRoute.length} pools. Slippage limite: ${slippage}%.`,
      ...prev
    ]);
  };

  return (
    <div id="multi-chain-jupiter-bridge" className="bg-slate-900 border border-slate-800 rounded-xl p-4 relative overflow-hidden flex flex-col gap-4">
      {/* Glow highlight */}
      <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none"></div>

      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
            <Globe className="w-5 h-5 text-cyan-400 animate-spin-slow" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h2 className="text-sm font-sans font-extrabold text-slate-100 uppercase tracking-tight">
                Jupiter Routing & Multi-Chain L10
              </h2>
              <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-cyan-950/80 border border-cyan-800/40 text-cyan-400 uppercase">
                Layer 10
              </span>
            </div>
            <p className="text-[10px] font-mono text-slate-400">Roteador Inteligente Jupiter v6, EVM Workers & Arbitragem Cross-Chain</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsSearchingArb(!isSearchingArb)}
            className={`px-2.5 py-1 rounded font-mono text-[10px] font-bold border transition-all flex items-center gap-1 cursor-pointer ${
              isSearchingArb 
                ? "bg-cyan-500/10 border-cyan-500/30 text-cyan-400" 
                : "bg-slate-800 border-slate-700 text-slate-400"
            }`}
          >
            {isSearchingArb ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></span>
                DETECTOR ARB ATIVO
              </>
            ) : (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
                DETECTOR ARB PAUSADO
              </>
            )}
          </button>
        </div>
      </div>

      {/* Layout Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        
        {/* Left 2 Columns: Jupiter V6 Router Visualizer & Chain Nodes */}
        <div className="lg:col-span-2 space-y-4">
          
          {/* Jupiter V6 Routing pathing visualizer */}
          <div className="bg-slate-950/60 border border-slate-850 p-3 rounded-lg space-y-3">
            <div className="flex justify-between items-center border-b border-slate-900 pb-2">
              <h3 className="text-[11px] font-mono font-extrabold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <Shuffle className="w-3.5 h-3.5 text-cyan-400" /> JUPITER V6 SMART ROUTING PATHS
              </h3>
              
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1 text-[11px] font-mono text-slate-400">
                  <span>Slippage:</span>
                  <input
                    type="number"
                    min="0.1"
                    max="3.0"
                    step="0.1"
                    value={slippage}
                    onChange={(e) => setSlippage(parseFloat(e.target.value) || 0.3)}
                    className="w-12 bg-slate-900 border border-slate-800 rounded px-1 py-0.5 text-xs text-center font-semibold text-slate-200"
                  />
                  <span>%</span>
                </div>

                <button
                  onClick={forceRouteRequery}
                  className="p-1 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded text-slate-300 hover:text-white transition-colors cursor-pointer"
                  title="Forçar Requery Quote"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Route path diagram */}
            <div className="bg-slate-950 p-3 border border-slate-900 rounded-lg space-y-4 relative">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-cyan-400 font-bold px-2 py-0.5 bg-cyan-950/40 border border-cyan-800/20 rounded">
                  In: SOL (1.00)
                </span>
                
                <span className="text-slate-500 font-italic text-[10px]">
                  Price Impact: <span className="text-emerald-400">{priceImpact}%</span>
                </span>

                <span className="text-emerald-400 font-bold px-2 py-0.5 bg-emerald-950/40 border border-emerald-800/20 rounded">
                  Out: {bestPrice} USDC
                </span>
              </div>

              {/* Graphical Path Connection */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 relative">
                {/* Horizontal line for desktop path */}
                <div className="hidden md:block absolute top-[44%] left-[10%] right-[10%] h-[1px] bg-gradient-to-r from-cyan-500/20 via-cyan-500/40 to-cyan-500/20 pointer-events-none z-0"></div>

                {selectedRoute.map((route, i) => (
                  <div key={i} className="bg-slate-900/80 border border-slate-800 p-2.5 rounded-md relative z-10 text-center flex flex-col justify-center">
                    <span className="text-[10px] font-mono text-slate-500 block uppercase font-bold tracking-wider mb-1">
                      {route.dex}
                    </span>
                    <span className="text-xs font-mono font-extrabold text-cyan-400">
                      {route.percent}% Allocation
                    </span>
                    <span className="text-[9px] font-mono text-slate-400 mt-1">
                      {route.inputToken} <ArrowRight className="w-2.5 h-2.5 inline mx-0.5" /> {route.outputToken}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Geographical Hubs & Regional Worker status */}
          <div className="bg-slate-950/40 border border-slate-850 p-3 rounded-lg space-y-2.5">
            <h3 className="text-[11px] font-mono font-extrabold text-slate-300 uppercase tracking-wider flex items-center gap-1.5 border-b border-slate-850 pb-1.5">
              <Compass className="w-3.5 h-3.5 text-cyan-400 animate-pulse" /> REDE GLOBAL DE WORKERS HFT (CO-LOCATION)
            </h3>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {Object.entries(chainNodes).map(([key, value]) => {
                const isActive = activeChain === key;
                return (
                  <div
                    key={key}
                    onClick={() => setActiveChain(key as any)}
                    className={`p-2.5 rounded-lg border transition-all cursor-pointer ${
                      isActive 
                        ? "bg-cyan-500/10 border-cyan-500/40 text-cyan-200" 
                        : "bg-slate-900/60 border-slate-850 hover:bg-slate-900 text-slate-400"
                    }`}
                  >
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-xs font-mono font-bold uppercase">{key}</span>
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                    </div>
                    
                    <div className="space-y-0.5 text-[10px] font-mono text-slate-500">
                      <div className="flex justify-between">
                        <span>Ping:</span>
                        <span className="text-emerald-400 font-bold">{value.ping}ms</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Block:</span>
                        <span className="text-slate-300">{value.blockTime}</span>
                      </div>
                      <div className="flex items-center gap-1 mt-1 border-t border-slate-850/50 pt-1 text-[8px] uppercase tracking-wider">
                        <MapPin className="w-2.5 h-2.5 text-cyan-400" />
                        <span>{value.location}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

        </div>

        {/* Right 1 Column: Real-time Arbitrage Telemetry & bridges */}
        <div className="space-y-4">
          
          {/* Arbitrage Opportunities panel */}
          <div className="p-3 bg-slate-950/60 border border-slate-850 rounded-lg space-y-2.5 flex flex-col justify-between min-h-[220px]">
            <div>
              <h3 className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5 border-b border-slate-850 pb-1.5 mb-2">
                <TrendingUp className="w-3.5 h-3.5 text-cyan-400" /> ARBITRAGEM MULTI-CHAIN ATIVA
              </h3>

              <div className="space-y-1.5 max-h-[170px] overflow-y-auto pr-1">
                {arbitrages.map((arb) => (
                  <div key={arb.id} className="p-2 bg-slate-900/80 border border-slate-850 rounded flex justify-between items-center text-[10px] font-mono">
                    <div>
                      <div className="flex items-center gap-1">
                        <span className="font-extrabold text-cyan-400">{arb.token}</span>
                        <span className="text-slate-500 uppercase">({arb.sourceChain} <ArrowRight className="w-2 h-2 inline" /> {arb.targetChain})</span>
                      </div>
                      <span className="text-[8px] text-slate-400 block uppercase">Bridge: {arb.bridge}</span>
                    </div>

                    <div className="text-right">
                      <span className="text-emerald-400 font-bold block">+{arb.spread}% Spread</span>
                      <span className={`text-[9px] font-bold ${
                        arb.status === "completed" 
                          ? "text-emerald-500" 
                          : arb.status === "executing" 
                            ? "text-amber-400 animate-pulse" 
                            : "text-slate-500"
                      }`}>
                        {arb.status === "completed" ? "CONCLUÍDO" : arb.status === "executing" ? "EXECUTANDO" : "DETECTADO"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="text-[9px] font-mono text-cyan-400 bg-cyan-950/30 border border-cyan-800/20 px-2.5 py-1.5 rounded flex items-center gap-1.5 mt-2">
              <CheckCircle className="w-4 h-4 text-cyan-400" />
              Roteamento cross-chain via wormhole/deBridge ativado.
            </div>
          </div>

          {/* EVM Block & Gas optimization details */}
          <div className="p-3 bg-slate-950/40 border border-slate-850 rounded-lg space-y-2">
            <h4 className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1 border-b border-slate-850 pb-1.5">
              <Cpu className="w-3.5 h-3.5 text-cyan-400" /> METADADOS MULTI-CHAIN PROTOCOL
            </h4>
            
            <div className="space-y-1 text-[11px] font-mono text-slate-400">
              <div className="flex justify-between border-b border-slate-900 pb-1">
                <span>Inbound Engine:</span>
                <span className="text-emerald-400 font-bold">Apache Kafka Stream</span>
              </div>
              <div className="flex justify-between border-b border-slate-900 pb-1">
                <span>Serialização:</span>
                <span className="text-cyan-400">Google Protobuf</span>
              </div>
              <div className="flex justify-between">
                <span>EVM Flashbots:</span>
                <span className="text-emerald-400">Ativado (Direct bundle)</span>
              </div>
            </div>
          </div>

        </div>

      </div>

      {/* Realtime Action Logs Terminal */}
      <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-850 text-[10px] font-mono flex-1 min-h-[110px] flex flex-col">
        <span className="text-slate-500 uppercase tracking-widest text-[9px] border-b border-slate-850/60 pb-1 mb-1.5 block">
          LOGS DE LIQUIDEZ GLOBAL, COMUNICAÇÃO DE WORKERS & JUPITER QUOTES
        </span>
        <div className="overflow-y-auto max-h-[110px] space-y-1 select-text scrollbar-thin">
          {bridgeLogs.map((log, index) => (
            <div key={index} className="text-slate-400">
              <span className="text-slate-600">[{new Date().toTimeString().split(' ')[0]}]</span> {log}
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}
