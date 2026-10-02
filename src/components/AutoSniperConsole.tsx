import { useState, useEffect, useRef } from "react";
import { 
  Play, 
  Loader2, 
  Coins, 
  Settings, 
  ShieldAlert, 
  Cpu, 
  Eye, 
  Activity, 
  Flame, 
  Terminal,
  Compass
} from "lucide-react";
import { SnipedTransaction } from "../types";

interface AutoSniperConsoleProps {
  onSnipeSuccess: (newTx: SnipedTransaction) => void;
  syncedParams?: {
    solAmount: string;
    slippage: string;
    priorityTip: string;
    stopLoss: string;
    takeProfit: string;
    antiRugShield: boolean;
  } | null;
  selectedToken?: { name: string; mint: string } | null;
}

export function AutoSniperConsole({ onSnipeSuccess, syncedParams, selectedToken }: AutoSniperConsoleProps) {
  const [tokenName, setTokenName] = useState("COSMIC");
  const [tokenMint, setTokenMint] = useState("Cosm6718291882...pump");
  const [solAmount, setSolAmount] = useState("1.5");
  const [priorityTip, setPriorityTip] = useState("0.002");
  const [useJito, setUseJito] = useState(true);
  const [route, setRoute] = useState("Pump.fun");
  const [slippage, setSlippage] = useState("5.0");

  // Advanced settings states
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [stopLoss, setStopLoss] = useState("15");
  const [takeProfit, setTakeProfit] = useState("100");
  const [antiRugShield, setAntiRugShield] = useState(true);

  // Silicon Valley premium parameters
  const [velocityProfile, setVelocityProfile] = useState<"standard" | "stanford" | "sandhill" | "yc">("standard");
  const [useGrpcPipeline, setUseGrpcPipeline] = useState(true);
  const [autoMevEscalation, setAutoMevEscalation] = useState(true);
  
  // Autonomous Mode (Robô Autônomo Completo)
  const [isAutonomous, setIsAutonomous] = useState(false);
  const autonomousIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Simulation execution states
  const [simulating, setSimulating] = useState(false);
  const [simSteps, setSimSteps] = useState<string[]>([]);
  const [progressPercent, setProgressPercent] = useState(0);

  const [cuBudget, setCuBudget] = useState("200000");
  const [microLamports, setMicroLamports] = useState("150000");
  const [blockEngineRegion, setBlockEngineRegion] = useState("Tokyo");

  // Sync selected token from live mempool scan
  useEffect(() => {
    if (selectedToken) {
      setTokenName(selectedToken.name);
      setTokenMint(selectedToken.mint);
    }
  }, [selectedToken]);

  // Sync parameters from HFT Decision Layer
  useEffect(() => {
    if (syncedParams) {
      setSolAmount(syncedParams.solAmount);
      setSlippage(syncedParams.slippage);
      setPriorityTip(syncedParams.priorityTip);
      setStopLoss(syncedParams.stopLoss);
      setTakeProfit(syncedParams.takeProfit);
      setAntiRugShield(syncedParams.antiRugShield);
      // Auto expand advanced panel to show updated parameters
      setShowAdvanced(true);
    }
  }, [syncedParams]);

  // Handle preset change for Silicon Valley Velocity Profiles
  const applyVelocityPreset = (profile: "standard" | "stanford" | "sandhill" | "yc") => {
    setVelocityProfile(profile);
    if (profile === "stanford") {
      // Stanford MEV Group Profile: Raw Speed, Dynamic MEV bypass
      setPriorityTip("0.025");
      setSlippage("15.0");
      setCuBudget("300000");
      setMicroLamports("350000");
      setUseJito(true);
      setAntiRugShield(true);
      setBlockEngineRegion("NY");
    } else if (profile === "sandhill") {
      // Sand Hill Road Optimized Gas: Cost effective, lower tip
      setPriorityTip("0.005");
      setSlippage("3.0");
      setCuBudget("180000");
      setMicroLamports("120000");
      setUseJito(true);
      setAntiRugShield(true);
      setBlockEngineRegion("Tokyo");
    } else if (profile === "yc") {
      // Y-Combinator Degen: Maximal slippage, direct BlockEngine integration
      setPriorityTip("0.050");
      setSlippage("25.0");
      setCuBudget("400000");
      setMicroLamports("500000");
      setUseJito(true);
      setAntiRugShield(true);
      setBlockEngineRegion("Frankfurt");
    } else {
      // Standard Profile
      setPriorityTip("0.002");
      setSlippage("5.0");
      setCuBudget("200000");
      setMicroLamports("150000");
      setUseJito(true);
      setAntiRugShield(true);
      setBlockEngineRegion("Tokyo");
    }
  };

  // Run a single simulated sniping cycle
  const executeSnipeSimulation = async (
    targetName: string,
    targetMint: string,
    targetSol: string,
    silent: boolean = false
  ) => {
    if (!targetMint || !targetName || !targetSol) return;

    if (!silent) {
      setSimulating(true);
      setSimSteps([]);
      setProgressPercent(5);
    }

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const isRugToken = targetName.toUpperCase().includes("RUG") || targetMint.toLowerCase().includes("rug") || targetMint.startsWith("1111");

    const addLog = (msg: string) => {
      if (!silent) {
        setSimSteps((prev) => [...prev, msg]);
      }
    };

    // Phase 1: Connect & Listening
    addLog(`[0.00s] 🟢 [SILICON_VALLEY_ENGINE] Sniper Armed. RPC GRPC Handshake secure.`);
    await sleep(250);
    if (!silent) setProgressPercent(15);
    
    // Latency is optimized with gRPC Pipeline
    const pipelineLatency = useGrpcPipeline ? "0.35ms (Equinix NY4 Raw Stream)" : "12.8ms (Standard WebSocket)";
    addLog(`[0.05s] 🛰️ Escaneando Mempool com Pipeline gRPC: Latência ${pipelineLatency}...`);
    await sleep(250);
    if (!silent) setProgressPercent(35);

    // Phase 2: Detecting Pool
    addLog(`[0.12s] 🎯 Liquidity Pool detectada no slot de rede! Inicializando cálculo de Gas ideal (CU: ${cuBudget}, Price: ${microLamports} micro-lamports)...`);
    await sleep(250);
    if (!silent) setProgressPercent(55);

    // Phase 3: Jito sandwich protection check
    if (useJito) {
      const actualTip = autoMevEscalation ? (parseFloat(priorityTip) * 1.2).toFixed(4) : priorityTip;
      addLog(`[0.22s] 🛡️ Sandwich Shield Ativo. Empacotando transação com gorjeta Jito escalada de ${actualTip} SOL...`);
    } else {
      addLog(`[0.22s] ⚠️ ALERTA: Jito desativado. Transmitindo em mempool aberta. Risco de MEV Sandwiche/Frontrun!`);
    }
    await sleep(250);
    if (!silent) setProgressPercent(75);

    // Phase 4: Anti-Rug Check if enabled & token is a rug
    if (isRugToken && antiRugShield) {
      addLog(`[0.31s] 🚨 [VALE_DO_SILICIO_SECURE] Assinatura de 'removeLiquidity' do desenvolvedor detectada em bloco pendente!`);
      addLog(`[0.36s] 🛡️ Ativando Frontrun Anti-Rug de Alta Velocidade. Forçando saída Jito Bundle imediata...`);
      addLog(`[0.42s] ⚡ Transmitindo transação de evacuação com propina de 0.05 SOL...`);
      await sleep(350);
    } else {
      addLog(`[0.42s] ⚙️ Executando ordens Stop Loss (${stopLoss}%) / Take Profit (${takeProfit}%) automáticas...`);
    }
    await sleep(250);
    if (!silent) setProgressPercent(90);
    addLog(`[0.51s] 🚀 Transmitindo ordens HFT compactadas para o validador Jito (${blockEngineRegion})...`);

    try {
      const response = await fetch("/api/simulate-snipe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenName: targetName,
          tokenMint: targetMint,
          solAmount: targetSol,
          priorityTip,
          useJito,
          route,
          antiRugShield
        })
      });

      const data = await response.json();
      await sleep(200);
      if (!silent) setProgressPercent(100);

      if (data.isAntiRugSaved) {
        addLog(`[0.60s] 🎉 FRONTRUN SUCESSO! Capital de ${targetSol} SOL evacuado com sucesso antes do Rug! Perda líquida: 0 SOL.`);
        onSnipeSuccess(data.transaction);
      } else if (data.success && data.transaction) {
        addLog(`[0.60s] 🎉 Sucesso! Token adquirido no bloco #${data.transaction.block}.`);
        onSnipeSuccess(data.transaction);
      } else {
        addLog(`[0.60s] ❌ Transação cancelada ou limite de slippage de ${slippage}% excedido.`);
      }
    } catch (err) {
      addLog(`[0.60s] ❌ Falha crítica de conexão de rede RPC.`);
    } finally {
      if (!silent) {
        setTimeout(() => {
          setSimulating(false);
        }, 800);
      }
    }
  };

  const simulateExecution = async (e: React.FormEvent) => {
    e.preventDefault();
    await executeSnipeSimulation(tokenName, tokenMint, solAmount, false);
  };

  // Autonomous Mode Scheduler
  useEffect(() => {
    if (isAutonomous) {
      // Setup immediate first run
      const runAutonomousSnipe = () => {
        const trendingTokens = [
          { name: "NEURAL_NET", mint: "Neur6718291882Hdkas9812hasd812hasd281H" },
          { name: "CYBER_PUNK", mint: "Cybe91283hds98dsa9812hsa9812hasd8912hs" },
          { name: "SOL_TURBO", mint: "Turb82391has89das89213hasd89213has892d" },
          { name: "ALPHA_AI", mint: "Alph78129329DfGgHiJkLmNoPqRsTuVwXyZ1234" },
          { name: "PEPE_SOL", mint: "Pep3JtE718291abcDeFgHiJkLmNoPqRsTuVwXyZ1" },
          { name: "RUG_TRAP", mint: "RugT1111111111111111111111111111111111" } // can trigger anti-rug save!
        ];

        // Randomly choose an incoming pool
        const token = trendingTokens[Math.floor(Math.random() * trendingTokens.length)];
        const randomSize = (Math.random() * 2 + 0.5).toFixed(1);

        // Pre-load parameters into console input fields to show live tracking
        setTokenName(token.name);
        setTokenMint(token.mint);
        setSolAmount(randomSize);

        // Execute snipe in background / foreground simulator
        executeSnipeSimulation(token.name, token.mint, randomSize, false);
      };

      // Trigger every 8 seconds for real-time visual excitement
      autonomousIntervalRef.current = setInterval(runAutonomousSnipe, 8500);
      
      // Trigger once instantly
      runAutonomousSnipe();
    } else {
      if (autonomousIntervalRef.current) {
        clearInterval(autonomousIntervalRef.current);
        autonomousIntervalRef.current = null;
      }
    }

    return () => {
      if (autonomousIntervalRef.current) {
        clearInterval(autonomousIntervalRef.current);
      }
    };
  }, [isAutonomous, useGrpcPipeline, blockEngineRegion, priorityTip, slippage, autoMevEscalation]);

  return (
    <div id="auto-sniper-console" className="bg-slate-900/80 border border-slate-850 rounded-xl p-3.5 backdrop-blur-md relative overflow-hidden h-full flex flex-col justify-between">
      {/* Decorative pulse element */}
      <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none"></div>
      
      <div>
        {/* Title bar */}
        <div className="flex items-center justify-between mb-2.5 pb-2 border-b border-slate-800/60">
          <div className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-cyan-400 animate-spin-slow" />
            <div>
              <h2 className="text-sm font-display font-bold text-slate-100 uppercase tracking-tight">Auto Sniper Tier-1 SV</h2>
              <span className="text-[9px] font-mono text-cyan-500/80 uppercase block tracking-wider">HFT MEV-Shield Router</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Autonomous Mode Toggle Button */}
            <button
              type="button"
              onClick={() => setIsAutonomous(!isAutonomous)}
              className={`px-3 py-1 rounded-md text-[10px] font-mono font-bold uppercase transition-all duration-300 flex items-center gap-1 border cursor-pointer ${
                isAutonomous
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/40 animate-pulse"
                  : "bg-slate-950 text-slate-400 border-slate-850 hover:bg-slate-900"
              }`}
            >
              <Compass className={`w-3.5 h-3.5 ${isAutonomous ? "animate-spin-slow text-emerald-400" : "text-slate-400"}`} />
              {isAutonomous ? "AUTÔNOMO: ON" : "MODO AUTÔNOMO"}
            </button>
            <span className="text-[9px] font-mono font-bold text-cyan-300 bg-cyan-500/10 px-2 py-0.5 rounded border border-cyan-500/20">
              MEV SHIELD ON
            </span>
          </div>
        </div>

        {/* Silicon Valley Presets Selector */}
        <div className="mb-4">
          <label className="block text-[10px] font-mono text-slate-500 uppercase tracking-wider mb-2">
            Perfil de Velocidade do Vale do Silício (HFT Presets)
          </label>
          <div className="grid grid-cols-4 gap-1.5">
            {[
              { id: "standard", label: "Default" },
              { id: "stanford", label: "Stanford MEV" },
              { id: "sandhill", label: "Sand Hill" },
              { id: "yc", label: "YC Degen" }
            ].map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => applyVelocityPreset(p.id as any)}
                disabled={simulating}
                className={`py-1.5 px-1 rounded text-[9px] font-mono font-bold uppercase border cursor-pointer text-center transition-all ${
                  velocityProfile === p.id
                    ? "bg-cyan-500/15 border-cyan-500/50 text-cyan-400 shadow-md shadow-cyan-950/20"
                    : "bg-slate-950 border-slate-850/80 text-slate-500 hover:text-slate-300"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Main form */}
        <form onSubmit={simulateExecution} className="space-y-3.5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">Ticker do Token</label>
              <input
                type="text"
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                disabled={simulating || isAutonomous}
                className="w-full bg-slate-950 border border-slate-850 focus:border-cyan-500/80 rounded px-2.5 py-1.5 text-xs font-mono text-slate-100 focus:outline-none"
                placeholder="Ex: RUGCOIN ou DEFY"
              />
            </div>
            <div>
              <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">Roteador Alvo</label>
              <select
                value={route}
                onChange={(e) => setRoute(e.target.value)}
                disabled={simulating || isAutonomous}
                className="w-full bg-slate-950 border border-slate-850 focus:border-cyan-500/80 rounded px-2 py-1.5 text-xs font-mono text-slate-100 focus:outline-none cursor-pointer"
              >
                <option value="Pump.fun">Pump.fun</option>
                <option value="Raydium v4">Raydium v4</option>
                <option value="Jupiter v6">Jupiter Routing</option>
                <option value="Raydium CLMM">Raydium CLMM</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">Endereço de Contrato (Mint)</label>
            <input
              type="text"
              value={tokenMint}
              onChange={(e) => setTokenMint(e.target.value)}
              disabled={simulating || isAutonomous}
              className="w-full bg-slate-950 border border-slate-850 focus:border-cyan-500/80 rounded px-2.5 py-1.5 text-xs font-mono text-slate-100 focus:outline-none"
              placeholder="Endereço Solana mint..."
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-[9px] font-mono text-slate-400 uppercase tracking-wider mb-1">Tamanho (SOL)</label>
              <input
                type="number"
                step="0.05"
                value={solAmount}
                onChange={(e) => setSolAmount(e.target.value)}
                disabled={simulating || isAutonomous}
                className="w-full bg-slate-950 border border-slate-850 focus:border-cyan-500/80 rounded px-2 py-1.5 text-xs font-mono text-slate-100 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-[9px] font-mono text-slate-400 uppercase tracking-wider mb-1">Slippage Máx %</label>
              <input
                type="number"
                step="0.5"
                value={slippage}
                onChange={(e) => setSlippage(e.target.value)}
                disabled={simulating || isAutonomous}
                className="w-full bg-slate-950 border border-slate-850 focus:border-cyan-500/80 rounded px-2 py-1.5 text-xs font-mono text-slate-100 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-[9px] font-mono text-slate-400 uppercase tracking-wider mb-1">Propina Jito (SOL)</label>
              <input
                type="number"
                step="0.0005"
                value={priorityTip}
                onChange={(e) => setPriorityTip(e.target.value)}
                disabled={simulating || isAutonomous}
                className="w-full bg-slate-950 border border-slate-850 focus:border-cyan-500/80 rounded px-2 py-1.5 text-xs font-mono text-slate-100 focus:outline-none"
              />
            </div>
          </div>

          {/* Premium Optimization toggles */}
          <div className="grid grid-cols-2 gap-2">
            {/* gRPC Pipeline */}
            <div className="flex items-center justify-between p-2 bg-slate-950 border border-slate-850 rounded-lg">
              <span className="text-[10px] font-mono text-slate-300">Equinix gRPC Pipeline</span>
              <button
                type="button"
                onClick={() => setUseGrpcPipeline(!useGrpcPipeline)}
                disabled={simulating}
                className={`p-1 rounded cursor-pointer transition-all border ${
                  useGrpcPipeline
                    ? "bg-cyan-500/10 text-cyan-400 border-cyan-500/30"
                    : "bg-slate-900 text-slate-500 border-slate-800"
                }`}
                title="Bypass WebSocket, direct Equinix gRPC pipeline"
              >
                <Activity className={`w-3.5 h-3.5 ${useGrpcPipeline ? "animate-pulse" : ""}`} />
              </button>
            </div>

            {/* MEV Gas Escalation */}
            <div className="flex items-center justify-between p-2 bg-slate-950 border border-slate-850 rounded-lg">
              <span className="text-[10px] font-mono text-slate-300">Gas Auto-Escalation</span>
              <button
                type="button"
                onClick={() => setAutoMevEscalation(!autoMevEscalation)}
                disabled={simulating}
                className={`p-1 rounded cursor-pointer transition-all border ${
                  autoMevEscalation
                    ? "bg-purple-500/10 text-purple-400 border-purple-500/30"
                    : "bg-slate-900 text-slate-500 border-slate-800"
                }`}
                title="Automatically escalate tip size to match competitive blocks"
              >
                <Flame className={`w-3.5 h-3.5 ${autoMevEscalation ? "animate-bounce" : ""}`} />
              </button>
            </div>
          </div>

          {/* Collapsible Advanced Configs Section */}
          <div className="border border-slate-850 rounded-lg overflow-hidden bg-slate-950/60">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full px-3 py-2 bg-slate-950 flex items-center justify-between text-[10px] font-mono text-slate-400 hover:bg-slate-900 cursor-pointer transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <Settings className="w-3 h-3 text-cyan-400 animate-spin-slow" />
                DILIGÊNCIA DE CONTROLE AVANÇADO
              </span>
              <span className="text-cyan-500 font-bold">{showAdvanced ? "Ocultar" : "Expandir"}</span>
            </button>

            {showAdvanced && (
              <div className="p-3 border-t border-slate-850 space-y-3 bg-slate-950/40">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[8px] font-mono text-slate-500 uppercase tracking-wider mb-1">Auto-Take Profit %</label>
                    <input
                      type="number"
                      value={takeProfit}
                      onChange={(e) => setTakeProfit(e.target.value)}
                      disabled={simulating}
                      className="w-full bg-slate-950 border border-slate-850 focus:border-cyan-500/80 rounded px-2 py-1 text-xs font-mono text-slate-200"
                    />
                  </div>
                  <div>
                    <label className="block text-[8px] font-mono text-slate-500 uppercase tracking-wider mb-1">Auto-Stop Loss %</label>
                    <input
                      type="number"
                      value={stopLoss}
                      onChange={(e) => setStopLoss(e.target.value)}
                      disabled={simulating}
                      className="w-full bg-slate-950 border border-slate-850 focus:border-cyan-500/80 rounded px-2 py-1 text-xs font-mono text-slate-200"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[8px] font-mono text-slate-500 uppercase tracking-wider mb-1">Limite CU (Budget)</label>
                    <input
                      type="number"
                      value={cuBudget}
                      onChange={(e) => setCuBudget(e.target.value)}
                      disabled={simulating}
                      className="w-full bg-slate-950 border border-slate-850 focus:border-cyan-500/80 rounded px-2 py-1 text-xs font-mono text-slate-200"
                    />
                  </div>
                  <div>
                    <label className="block text-[8px] font-mono text-slate-500 uppercase tracking-wider mb-1">Preço CU (Micro-lamports)</label>
                    <input
                      type="number"
                      value={microLamports}
                      onChange={(e) => setMicroLamports(e.target.value)}
                      disabled={simulating}
                      className="w-full bg-slate-950 border border-slate-850 focus:border-cyan-500/80 rounded px-2 py-1 text-xs font-mono text-slate-200"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between pt-1">
                  <span className="text-[9px] font-mono text-slate-400">Jito BlockEngine Region:</span>
                  <select
                    value={blockEngineRegion}
                    onChange={(e) => setBlockEngineRegion(e.target.value)}
                    disabled={simulating}
                    className="bg-slate-950 border border-slate-850 rounded px-2 py-0.5 text-[9px] font-mono text-slate-300 outline-none cursor-pointer"
                  >
                    <option value="Tokyo">Tokyo (Low Jitter)</option>
                    <option value="Frankfurt">Frankfurt (Stable)</option>
                    <option value="NY">New York (Direct)</option>
                    <option value="Amsterdam">Amsterdam (Speed)</option>
                  </select>
                </div>

                <div className="flex items-center justify-between p-2 bg-rose-950/20 border border-rose-500/20 rounded">
                  <div className="flex items-center gap-1.5">
                    <ShieldAlert className="w-3.5 h-3.5 text-rose-400 animate-pulse" />
                    <span className="text-[9px] font-mono text-rose-300 font-semibold">Anti-Rug Mempool Guard</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={antiRugShield}
                    onChange={(e) => setAntiRugShield(e.target.checked)}
                    disabled={simulating}
                    className="w-3.5 h-3.5 text-rose-500 bg-slate-950 border-rose-800 rounded focus:ring-rose-500/50 cursor-pointer"
                  />
                </div>
              </div>
            )}
          </div>

          {/* MEV toggle */}
          <div className="flex items-center justify-between p-2 bg-slate-950 border border-slate-850 rounded-lg">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="jitoToggle"
                checked={useJito}
                onChange={(e) => setUseJito(e.target.checked)}
                disabled={simulating || isAutonomous}
                className="w-3.5 h-3.5 text-cyan-500 bg-slate-950 border-slate-800 rounded focus:ring-cyan-500/50 cursor-pointer"
              />
              <label htmlFor="jitoToggle" className="text-[11px] font-medium text-slate-200 cursor-pointer select-none">
                Private Block-Engine Bundle
              </label>
            </div>
            <span className="text-[9px] font-mono text-slate-400 flex items-center gap-1">
              <Coins className="w-3.5 h-3.5 text-cyan-400" />
              Sem vazamento de mempool
            </span>
          </div>

          {/* Main Sniper Trigger Button */}
          <button
            type="submit"
            disabled={simulating || isAutonomous}
            className={`w-full py-2.5 px-4 rounded-lg font-display font-semibold text-xs transition-all duration-300 flex items-center justify-center gap-2 shadow-lg cursor-pointer ${
              simulating
                ? "bg-slate-800 text-slate-400 border border-slate-750"
                : isAutonomous
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 cursor-not-allowed"
                : "bg-cyan-500 hover:bg-cyan-400 text-slate-950 hover:shadow-cyan-500/25 border border-cyan-400/20"
            }`}
          >
            {simulating ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Transmitindo HFT para Solana...
              </>
            ) : isAutonomous ? (
              <>
                <Compass className="w-3.5 h-3.5 animate-spin" />
                Robô em Execução Autônoma...
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 text-slate-950 fill-current" />
                Disparar Robo Sniper Automático
              </>
            )}
          </button>
        </form>
      </div>

      {/* Terminal Steps Feedback */}
      {simulating || simSteps.length > 0 ? (
        <div className="mt-2.5 p-2 bg-slate-950 rounded-lg border border-slate-850/80 font-mono text-[10px] h-20 overflow-y-auto space-y-1 scrollbar-thin">
          <div className="flex items-center justify-between text-slate-500 border-b border-slate-900 pb-1 mb-1">
            <span className="flex items-center gap-1">
              <Terminal className="w-3 h-3 text-cyan-500 animate-pulse" />
              TERMINAL LOG HFT
            </span>
            <span>{progressPercent}% Completo</span>
          </div>
          {simSteps.map((step, idx) => (
            <div
              key={idx}
              className={`${
                step.includes("🎉") || step.includes("SUCESSO")
                  ? "text-emerald-400 font-bold"
                  : step.includes("❌")
                  ? "text-rose-400 font-bold"
                  : step.includes("🚨") || step.includes("🛡️")
                  ? "text-rose-400"
                  : step.includes("⚠️") || step.includes("ALERTA")
                  ? "text-amber-400"
                  : "text-slate-300"
              }`}
            >
              {step}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-2.5 p-2 rounded-lg bg-slate-950/40 border border-dashed border-slate-850 flex flex-col items-center justify-center text-center text-slate-500">
          <Eye className="w-4 h-4 text-slate-600 mb-1" />
          <p className="text-[10px]">Console pronto. Ative o Robô Autônomo para varredura contínua de blocos.</p>
        </div>
      )}
    </div>
  );
}
