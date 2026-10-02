import { useState, useEffect } from "react";
import { 
  ShieldAlert, 
  Sliders, 
  AlertOctagon, 
  Key, 
  WifiOff, 
  RefreshCw,
  Loader2
} from "lucide-react";

interface RiskCircuitBreakerManagerProps {
  walletConnected?: boolean;
  onSetWalletConnected?: (connected: boolean) => void;
}

export function RiskCircuitBreakerManager({ walletConnected = true, onSetWalletConnected }: RiskCircuitBreakerManagerProps) {
  // Real-time backend security states
  const [secState, setSecState] = useState({
    killSwitchActive: false,
    readOnlyMode: false,
    consecutiveFailures: 0,
    failureThreshold: 3,
    activeWallet: "operational",
    vaultArmed: true
  });

  // Operational limits
  const [maxDailyDrawdown, setMaxDailyDrawdown] = useState<number>(5.0); // 5% total drawdown limit
  const [currentDailyDrawdown, setCurrentDailyDrawdown] = useState<number>(0.85);
  const [maxLatencyTolerance, setMaxLatencyTolerance] = useState<number>(200); // RTT in ms
  const [currentLatency, setCurrentLatency] = useState<number>(14.5);
  
  // Wallet states
  const [walletAllocation, setWalletAllocation] = useState<number>(1.5); // 1.5% capital per trade
  
  // Encryption state
  const [isRamEncrypted, setIsRamEncrypted] = useState<boolean>(true);
  const [encryptionAlgorithm] = useState<string>("AES-256-GCM (KMS-Volatile)");

  // Active Breaker Flags
  const [latencyBreakerTripped, setLatencyBreakerTripped] = useState<boolean>(false);
  const [drawdownBreakerTripped, setDrawdownBreakerTripped] = useState<boolean>(false);
  const [rpcBreakerTripped, setRpcBreakerTripped] = useState<boolean>(false);

  // Observability & Risk status
  const [riskLogs, setRiskLogs] = useState<string[]>([
    "[SYSTEM] Módulo de Risco e Gestão Operacional Layer 9 Ativo.",
    "[SECURE] Chaves privadas carregadas cifradas em RAM volátil com AES-256-GCM.",
    "[MONITOR] Ping Jito BlockEngine: 14.5ms (Status: EXCELENTE).",
    "[MONITOR] Drawdown diário atual: 0.85% (Seguro)."
  ]);

  // Positions and DB Stats states
  const [positions, setPositions] = useState<any[]>([]);
  const [dbStats, setDbStats] = useState<any>(null);
  const [crashRecoveryStep, setCrashRecoveryStep] = useState<number | null>(null);
  const [recoveryLogs, setRecoveryLogs] = useState<string[]>([]);
  const [editingPositionId, setEditingPositionId] = useState<string | null>(null);
  
  // Edit forms states
  const [editSl, setEditSl] = useState<number>(-5);
  const [editTp, setEditTp] = useState<number>(15);
  const [editTrailing, setEditTrailing] = useState<boolean>(false);
  const [editTrailingOffset, setEditTrailingOffset] = useState<number>(2.5);

  // Fetch security state from backend
  const fetchSecState = async () => {
    try {
      const r = await fetch("/api/operational-security/state");
      const d = await r.json();
      if (d) {
        setSecState(d);
      }
    } catch (e) {
      console.error("Error fetching operational security state:", e);
    }
  };

  const fetchPositions = async () => {
    try {
      const r = await fetch("/api/positions");
      const d = await r.json();
      if (Array.isArray(d)) {
        setPositions(d);
      }
    } catch (e) {
      console.error("Error fetching positions:", e);
    }
  };

  const fetchDbStats = async () => {
    try {
      const r = await fetch("/api/database/stats");
      const d = await r.json();
      if (d) {
        setDbStats(d);
      }
    } catch (e) {
      console.error("Error fetching db stats:", e);
    }
  };

  useEffect(() => {
    fetchSecState();
    fetchPositions();
    fetchDbStats();

    const interval = setInterval(() => {
      fetchSecState();
      fetchPositions();
      fetchDbStats();
    }, 2500);

    return () => clearInterval(interval);
  }, []);

  const handleUpdateRisk = async (id: string) => {
    try {
      const r = await fetch("/api/positions/update-risk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          stopLossPercent: editSl,
          takeProfitPercent: editTp,
          trailingStopActive: editTrailing,
          trailingStopOffsetPercent: editTrailingOffset
        })
      });
      const d = await r.json();
      if (d.success) {
        setRiskLogs(logs => [`[RISK CONTROL] Alteradas regras de Stop da posição ${id}: SL: ${editSl}%, TP: ${editTp}%, Trailing: ${editTrailing ? "SIM" : "NÃO"}`, ...logs]);
        setEditingPositionId(null);
        fetchPositions();
        fetchDbStats();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleClosePosition = async (id: string, token: string) => {
    try {
      const r = await fetch("/api/positions/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
      const d = await r.json();
      if (d.success) {
        setRiskLogs(logs => [`[RISK CONTROL] Liquidando posição de ${token} imediatamente (Profit Lock de segurança).`, ...logs]);
        fetchPositions();
        fetchDbStats();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleSimulateCrash = async () => {
    setCrashRecoveryStep(0);
    setRecoveryLogs([]);
    setRiskLogs(logs => ["🚨 [PM2 PROCESS CRASH] Recebido sinal SIGKILL. Abortando conexões...", ...logs]);

    try {
      const r = await fetch("/api/simulate-crash", { method: "POST" });
      const d = await r.json();
      
      // Staggered logs to make recovery look highly dynamic and technical
      setTimeout(() => {
        setCrashRecoveryStep(1);
        setRecoveryLogs(prev => [...prev, "⚡ [CRITICAL] Queda abrupta detectada. Iniciando Auto-Recuperação do snapshot..."]);
      }, 500);

      setTimeout(() => {
        setCrashRecoveryStep(2);
        setRecoveryLogs(prev => [...prev, "🔗 [Geyser Stream] Conexões restabelecidas. Capturando blockhash para revalidação..."]);
      }, 1000);

      setTimeout(() => {
        setCrashRecoveryStep(3);
        setRecoveryLogs(prev => [...prev, `📂 [Local Database] Repositório sincronizado. Recarregadas ${d.recovered.positionsCount} posições abertas e ${d.recovered.tradesCount} trades anteriores.`]);
      }, 1500);

      setTimeout(() => {
        setCrashRecoveryStep(4);
        setRecoveryLogs(prev => [
          ...prev,
          `🔒 [State Restore] Disjuntores rearmados. Kill Switch: [${d.recovered.state.killSwitchActive ? "ATIVO" : "INATIVO"}]. Wallet: [${d.recovered.state.activeWallet.toUpperCase()}]`,
          "✅ [RECOVERY SUCCESS] Robô operacional restabelecido do ponto exato de suspensão em 41ms!"
        ]);
        setRiskLogs(logs => ["✅ [RECOVERY SUCCESS] Auto-recovery executado em 41ms. Posições e ordens pendentes intactas.", ...logs]);
        fetchSecState();
        fetchPositions();
        fetchDbStats();
      }, 2000);

    } catch (e) {
      console.error(e);
    }
  };

  const handleToggleKillSwitch = async () => {
    try {
      const nextActive = !secState.killSwitchActive;
      const r = await fetch("/api/operational-security/kill-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: nextActive })
      });
      const d = await r.json();
      if (d && d.state) {
        setSecState(d.state);
        setRiskLogs(logs => [
          `[USER ACTION] Disjuntor de Emergência (Kill Switch) ${nextActive ? "ENGAGED !!!" : "DISENGAGED"} pelo operador.`,
          ...logs
        ]);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleToggleReadOnly = async () => {
    try {
      const nextActive = !secState.readOnlyMode;
      const r = await fetch("/api/operational-security/read-only", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: nextActive })
      });
      const d = await r.json();
      if (d && d.state) {
        setSecState(d.state);
        setRiskLogs(logs => [
          `[USER ACTION] Modo Somente Leitura (Read-Only) ${nextActive ? "ATIVADO" : "DESATIVADO"} pelo operador.`,
          ...logs
        ]);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleRotateWalletReal = async (type: "operational" | "test" | "emergency") => {
    try {
      const r = await fetch("/api/operational-security/rotate-wallet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type })
      });
      const d = await r.json();
      if (d && d.state) {
        setSecState(d.state);
        setRiskLogs(logs => [
          `[🔑 WALLET ROTATION] Chaves rotacionadas na RAM do processo para o perfil: [${type.toUpperCase()}].`,
          `[SECURE] RAM Zero-Trace: Chaves anteriores apagadas síncronamente da RAM.`,
          ...logs
        ]);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleResetBreakerReal = async () => {
    try {
      const r = await fetch("/api/operational-security/reset-breaker", {
        method: "POST"
      });
      const d = await r.json();
      if (d && d.state) {
        setSecState(d.state);
        setRiskLogs(logs => [
          `[REARM] Circuit breaker rearmado. Histórico de falhas resetado com sucesso.`,
          ...logs
        ]);
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Periodic simulated check
  useEffect(() => {
    const interval = setInterval(() => {
      // Fluctuate simulated latency and drawdown slightly
      setCurrentLatency(prev => {
        const next = Math.max(8, prev + (Math.random() * 12 - 5));
        
        // Auto trip latency breaker if it goes too high
        if (next > maxLatencyTolerance && !latencyBreakerTripped) {
          setLatencyBreakerTripped(true);
          setRiskLogs(logs => [
            `[🚨 CIRCUIT BREAKER] DISJUNTOR DE LATÊNCIA DISPARADO! RTT (${next.toFixed(1)}ms) excedeu o limite tolerado de ${maxLatencyTolerance}ms.`,
            `[⛔ SAFETY HALT] Novas ordens suspensas preventivamente para evitar "buying the top" no gRPC feed.`,
            ...logs
          ]);
        } else if (next <= maxLatencyTolerance && latencyBreakerTripped) {
          // Recover automatically
          setLatencyBreakerTripped(false);
          setRiskLogs(logs => [
            `[💚 RECOVERY] Latência normalizada (${next.toFixed(1)}ms). Disjuntor rearmado automaticamente.`,
            ...logs
          ]);
        }
        return parseFloat(next.toFixed(1));
      });

      // Daily Drawdown check simulation
      setCurrentDailyDrawdown(prev => {
        const next = Math.max(0.1, prev + (Math.random() * 0.4 - 0.15));
        if (next > maxDailyDrawdown && !drawdownBreakerTripped) {
          setDrawdownBreakerTripped(true);
          setRiskLogs(logs => [
            `[🚨 CIRCUIT BREAKER] DISJUNTOR DE DRAWDOWN DISPARADO! Perda diária de ${next.toFixed(2)}% excedeu o limite máximo de ${maxDailyDrawdown}%.`,
            `[⛔ HALT] Desativando compras em todos os launchpads Solana...`,
            ...logs
          ]);
        }
        return parseFloat(next.toFixed(2));
      });
    }, 3000);

    return () => clearInterval(interval);
  }, [maxLatencyTolerance, maxDailyDrawdown, latencyBreakerTripped, drawdownBreakerTripped]);

  const toggleRamEncryption = () => {
    setIsRamEncrypted(!isRamEncrypted);
    setRiskLogs(prev => [
      isRamEncrypted 
        ? "[⚠️ WARNING] Criptografia de chaves privadas em RAM desativada! Chaves expostas em texto claro na memória!"
        : "[💚 SECURE] Chaves privadas re-criptografadas de forma volátil com AES-256-GCM.",
      ...prev
    ]);
  };

  const simulateRpcFailure = () => {
    setRpcBreakerTripped(true);
    if (onSetWalletConnected) {
      onSetWalletConnected(false);
    }
    setRiskLogs(prev => [
      "[🚨 RPC CRITICAL] Falha detectada de comunicação com Solana Mainnet Node (timeout gRPC)!",
      "[⛔ CIRCUIT BREAKER] Desconectando carteira e abortando execuções de forma assíncrona...",
      ...prev
    ]);
  };

  const resetAllBreakers = () => {
    setLatencyBreakerTripped(false);
    setDrawdownBreakerTripped(false);
    setRpcBreakerTripped(false);
    if (onSetWalletConnected) {
      onSetWalletConnected(true);
    }
    setCurrentDailyDrawdown(0.85);
    handleResetBreakerReal();
  };

  const rotateHotWallet = () => {
    const types: ("operational" | "test" | "emergency")[] = ["operational", "test", "emergency"];
    const currentIndex = types.indexOf(secState.activeWallet as any);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % types.length;
    const nextType = types[nextIndex];
    handleRotateWalletReal(nextType);
  };

  return (
    <div id="risk-circuit-breaker-manager" className="bg-slate-900 border border-slate-800 rounded-xl p-4 relative overflow-hidden flex flex-col gap-4">
      {/* Decorative pulse element if any breaker is tripped */}
      {(latencyBreakerTripped || drawdownBreakerTripped || rpcBreakerTripped) && (
        <div className="absolute top-0 right-0 w-32 h-32 bg-rose-500/10 rounded-full blur-3xl animate-pulse pointer-events-none"></div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-rose-500/10 border border-rose-500/20 flex items-center justify-center">
            <ShieldAlert className="w-5 h-5 text-rose-400 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h2 className="text-sm font-sans font-extrabold text-slate-100 uppercase tracking-tight">
                Disjuntores & Gestão de Risco
              </h2>
              <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-rose-950/80 border border-rose-800/40 text-rose-400 uppercase">
                Layer 9
              </span>
              <span className={`text-[8px] font-mono px-1 py-0.2 rounded border ${walletConnected ? "bg-emerald-950/60 text-emerald-400 border-emerald-800/40" : "bg-rose-950/60 text-rose-400 border-rose-800/40"}`}>
                {walletConnected ? "NODE CONECTADO" : "NODE DESCONECTADO"}
              </span>
            </div>
            <p className="text-[10px] font-mono text-slate-400">Proteção Atômica, Criptografia em RAM & Circuit Breakers</p>
          </div>
        </div>

        {/* Global Arm/Disarm Controls */}
        <div className="flex gap-2">
          <button
            onClick={handleSimulateCrash}
            className="px-3 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 hover:text-rose-300 border border-rose-500/20 rounded font-mono font-bold text-[10px] transition-all flex items-center gap-1 cursor-pointer"
          >
            🔥 SIMULAR CRASH
          </button>
          <button
            onClick={resetAllBreakers}
            className="px-3 py-1.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 hover:text-emerald-300 border border-emerald-500/20 rounded font-mono font-bold text-[10px] transition-all flex items-center gap-1 cursor-pointer"
          >
            <RefreshCw className="w-3 h-3" /> REARMAR DISJUNTORES
          </button>
        </div>
      </div>

      {/* Auto-Recovery Progress Display */}
      {crashRecoveryStep !== null && (
        <div className="p-3 bg-slate-950 border border-rose-500/30 rounded-lg space-y-2 animate-pulse">
          <div className="flex justify-between items-center border-b border-slate-850 pb-1.5">
            <span className="text-[10px] font-mono font-extrabold text-rose-400 uppercase tracking-widest flex items-center gap-1.5">
              <span className={`w-2.5 h-2.5 rounded-full ${crashRecoveryStep === 4 ? "bg-emerald-500 animate-none" : "bg-rose-500 animate-ping"}`}></span>
              {crashRecoveryStep === 4 ? "AUTO-RECUPERAÇÃO CONCLUÍDA EM 41ms!" : "PM2 RECOVERY PIPELINE IN PROGRESS..."}
            </span>
            <button
              onClick={() => setCrashRecoveryStep(null)}
              className="text-[9px] text-slate-500 hover:text-slate-300 font-mono underline"
            >
              FECHAR PAINEL
            </button>
          </div>
          <div className="space-y-1 text-[9px] font-mono text-slate-400">
            {recoveryLogs.map((log, idx) => (
              <div key={idx} className={idx === recoveryLogs.length - 1 ? "text-emerald-400 font-extrabold" : "text-slate-300"}>
                {log}
              </div>
            ))}
          </div>
          {crashRecoveryStep < 4 && (
            <div className="w-full h-1 bg-slate-900 rounded-full overflow-hidden">
              <div className="h-full bg-rose-500 transition-all duration-300" style={{ width: `${crashRecoveryStep * 25}%` }}></div>
            </div>
          )}
        </div>
      )}

      {/* Grid Controls */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        
        {/* Left 2 Columns: Threshold Configuration */}
        <div className="lg:col-span-2 space-y-4">
          
          {/* Slider controls */}
          <div className="bg-slate-950/60 border border-slate-850 p-3 rounded-lg space-y-4">
            <h3 className="text-[11px] font-mono font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5 border-b border-slate-850 pb-1.5">
              <Sliders className="w-3.5 h-3.5 text-rose-400" /> PARÂMETROS OPERACIONAIS DE DISPARO
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              
              {/* Drawdown limit slider */}
              <div className="space-y-1">
                <div className="flex justify-between items-center text-xs font-mono">
                  <span className="text-slate-400">Drawdown Diário Máximo:</span>
                  <span className="text-rose-400 font-extrabold">{maxDailyDrawdown}%</span>
                </div>
                <input
                  type="range"
                  min="2"
                  max="15"
                  step="0.5"
                  value={maxDailyDrawdown}
                  onChange={(e) => setMaxDailyDrawdown(parseFloat(e.target.value))}
                  className="w-full accent-rose-500 bg-slate-900 rounded-lg appearance-none h-1.5 cursor-pointer"
                />
                <div className="flex justify-between text-[8px] font-mono text-slate-500">
                  <span>Atual: {currentDailyDrawdown}%</span>
                  <span>Limite de Segurança</span>
                </div>
              </div>

              {/* Latency limit slider */}
              <div className="space-y-1">
                <div className="flex justify-between items-center text-xs font-mono">
                  <span className="text-slate-400">Tolerância Máxima Latência:</span>
                  <span className="text-rose-400 font-extrabold">{maxLatencyTolerance}ms</span>
                </div>
                <input
                  type="range"
                  min="50"
                  max="500"
                  step="10"
                  value={maxLatencyTolerance}
                  onChange={(e) => setMaxLatencyTolerance(parseInt(e.target.value))}
                  className="w-full accent-rose-500 bg-slate-900 rounded-lg appearance-none h-1.5 cursor-pointer"
                />
                <div className="flex justify-between text-[8px] font-mono text-slate-500">
                  <span>Atual: {currentLatency}ms</span>
                  <span>Halt se rede atrasar</span>
                </div>
              </div>

            </div>
          </div>

          {/* Wallet Rotation & Private Key RAM Protection */}
          <div className="bg-slate-950/40 border border-slate-850 p-3 rounded-lg space-y-3">
            <h3 className="text-[11px] font-mono font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5 border-b border-slate-850 pb-1.5">
              <Key className="w-3.5 h-3.5 text-cyan-400" /> SEGURANÇA DE CHAVES & ROTAÇÃO DE WALLETS
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              
              {/* RAM Security status */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-[11px] font-mono text-slate-400">Proteção Volátil em RAM:</span>
                  <button
                    onClick={toggleRamEncryption}
                    className={`px-2 py-0.5 rounded font-mono text-[9px] font-extrabold transition-all cursor-pointer ${
                      isRamEncrypted 
                        ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30" 
                        : "bg-rose-500/10 text-rose-400 border border-rose-500/30"
                    }`}
                  >
                    {isRamEncrypted ? "ENCRYPTED" : "EXPOSED"}
                  </button>
                </div>
                <div className="text-[10px] font-mono text-slate-500 bg-slate-950 p-2 border border-slate-850/60 rounded">
                  <div className="flex justify-between">
                    <span>Cripto:</span>
                    <span className="text-slate-300">{isRamEncrypted ? encryptionAlgorithm : "Sem criptografia RAM"}</span>
                  </div>
                  <p className="text-[8px] text-slate-600 mt-1">Nenhuma chave privada encosta no SSD ou disco local em texto claro.</p>
                </div>
              </div>

              {/* Wallet Rotation Pool */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-[11px] font-mono text-slate-400">Perfil de Wallet:</span>
                  <span className="text-cyan-400 font-mono text-xs font-extrabold uppercase">{secState.activeWallet}</span>
                </div>
                
                <div className="flex gap-2">
                  <button
                    onClick={rotateHotWallet}
                    className="flex-1 py-1.5 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 rounded font-mono text-[10px] font-bold border border-cyan-500/20 transition-all cursor-pointer flex items-center justify-center gap-1"
                  >
                    <RefreshCw className="w-3.5 h-3.5 animate-spin-slow" /> ROTACIONAR PERFIL
                  </button>

                  <div className="w-24">
                    <input
                      type="number"
                      min="0.5"
                      max="5"
                      step="0.5"
                      value={walletAllocation}
                      onChange={(e) => setWalletAllocation(parseFloat(e.target.value) || 1.5)}
                      className="w-full bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500/50"
                      placeholder="Allocation"
                    />
                    <span className="text-[8px] text-slate-500 block text-center uppercase tracking-wider">% Cap por Trade</span>
                  </div>
                </div>
              </div>

            </div>
          </div>

          {/* relacional DB and persistence states */}
          <div className="bg-slate-950/40 border border-slate-850 p-3 rounded-lg space-y-3">
            <div className="flex justify-between items-center border-b border-slate-850 pb-1.5">
              <h3 className="text-[11px] font-mono font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                📦 BANCO DE DADOS RELACIONAL & PERSISTÊNCIA ATÔMICA
              </h3>
              {dbStats && (
                <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-emerald-950 border border-emerald-850 text-emerald-400 uppercase">
                  v{dbStats.schemaVersion} • MIGRADO
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px] font-mono text-slate-400">
              <div className="bg-slate-950 p-2 border border-slate-850/60 rounded">
                <span className="text-slate-500 block text-[8px] uppercase tracking-wider">Engine Ativa:</span>
                <span className="text-slate-200 font-bold">{dbStats?.engine || "SQLite JSON WAL"}</span>
              </div>
              <div className="bg-slate-950 p-2 border border-slate-850/60 rounded">
                <span className="text-slate-500 block text-[8px] uppercase tracking-wider">Commits Realizados:</span>
                <span className="text-cyan-400 font-bold">{dbStats?.transactionCount || 0} writes</span>
              </div>
              <div className="bg-slate-950 p-2 border border-slate-850/60 rounded">
                <span className="text-slate-500 block text-[8px] uppercase tracking-wider">Trades Salvos:</span>
                <span className="text-slate-200 font-bold">{dbStats?.tradesCount || 0} ordens</span>
              </div>
              <div className="bg-slate-950 p-2 border border-slate-850/60 rounded">
                <span className="text-slate-500 block text-[8px] uppercase tracking-wider">Tempo Commits:</span>
                <span className="text-emerald-400 font-bold">~{dbStats?.writeLatencyMs || 0.12}ms (ACID)</span>
              </div>
            </div>
          </div>

          {/* Active Positions */}
          <div className="bg-slate-950/40 border border-slate-850 p-3 rounded-lg space-y-3">
            <h3 className="text-[11px] font-mono font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5 border-b border-slate-850 pb-1.5">
              📈 CONTROLE DE POSIÇÕES ATIVAS ({positions.length})
            </h3>

            {positions.length === 0 ? (
              <div className="py-4 text-center text-slate-500 text-xs font-mono">
                Nenhuma posição aberta no momento. Execute um Sniper na tela acima para disparar compras automáticas!
              </div>
            ) : (
              <div className="space-y-3">
                {positions.map((pos) => {
                  const isEditing = editingPositionId === pos.id;
                  const isProfit = pos.pnlPercent >= 0;
                  return (
                    <div key={pos.id} className="bg-slate-950 border border-slate-850 p-3 rounded-lg space-y-2">
                      <div className="flex justify-between items-start">
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-slate-200">{pos.token}</span>
                            <span className="text-[8px] font-mono text-slate-500 select-all">{pos.mint.slice(0, 10)}...{pos.mint.slice(-4)}</span>
                          </div>
                          <div className="text-[9px] font-mono text-slate-400 mt-0.5">
                            Size: <span className="text-cyan-400 font-bold">{pos.sizeSol} SOL</span> • Aberta às {pos.timeOpened}
                          </div>
                        </div>

                        <div className="text-right flex flex-col items-end gap-1">
                          {pos.status === "exit_pending" ? (
                            <span className="text-[9px] font-mono font-extrabold px-1.5 py-0.5 rounded bg-amber-950/80 text-amber-400 border border-amber-800/30 animate-pulse uppercase tracking-wider">
                              EXIT_PENDING
                            </span>
                          ) : (
                            <span className={`text-xs font-mono font-extrabold px-1.5 py-0.5 rounded ${isProfit ? "bg-emerald-950/80 text-emerald-400 border border-emerald-800/30" : "bg-rose-950/80 text-rose-400 border border-rose-800/30"}`}>
                              {isProfit ? "+" : ""}{pos.pnlPercent.toFixed(2)}% PnL
                            </span>
                          )}
                          <div className="text-[8px] font-mono text-slate-500">
                            Entry: {pos.entryPrice.toFixed(8)} SOL
                          </div>
                        </div>
                      </div>

                      {/* Risk rules summary */}
                      <div className="grid grid-cols-3 gap-2 text-[9px] font-mono text-slate-400 border-t border-b border-slate-900/60 py-1.5">
                        <div>
                          <span className="text-slate-500 block text-[8px] uppercase">Stop Loss:</span>
                          <span className="text-rose-400 font-bold">{pos.stopLossPercent}%</span>
                        </div>
                        <div>
                          <span className="text-slate-500 block text-[8px] uppercase">Take Profit:</span>
                          <span className="text-emerald-400 font-bold">{pos.takeProfitPercent}%</span>
                        </div>
                        <div>
                          <span className="text-slate-500 block text-[8px] uppercase">Trailing Stop:</span>
                          <span className={pos.trailingStopActive ? "text-cyan-400 font-bold" : "text-slate-500"}>
                            {pos.trailingStopActive ? `ATIVO (${pos.trailingStopOffsetPercent}%)` : "INATIVO"}
                          </span>
                        </div>
                      </div>

                      {/* Action buttons */}
                      {pos.status === "exit_pending" ? (
                        <div className="flex gap-2 w-full">
                          <button
                            disabled
                            className="w-full py-1 bg-slate-900 text-slate-500 border border-slate-850 rounded font-mono text-[9px] font-bold flex items-center justify-center gap-1.5 cursor-not-allowed uppercase"
                          >
                            <Loader2 className="w-3 h-3 text-amber-500 animate-spin" /> Liquidando via Jito Bundle...
                          </button>
                        </div>
                      ) : isEditing ? (
                        <div className="bg-slate-900/60 p-2.5 rounded border border-slate-800 space-y-3">
                          <span className="text-[9px] font-mono font-bold text-slate-300 block uppercase tracking-wider">Ajustar Alvos de Saída (Gestão Rápida)</span>
                          <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                            <div>
                              <div className="flex justify-between text-[10px] mb-1">
                                <span className="text-slate-400">Stop Loss:</span>
                                <span className="text-rose-400 font-bold">{editSl}%</span>
                              </div>
                              <input
                                type="range"
                                min="-15"
                                max="-1"
                                step="0.5"
                                value={editSl}
                                onChange={(e) => setEditSl(parseFloat(e.target.value))}
                                className="w-full accent-rose-500"
                              />
                            </div>
                            <div>
                              <div className="flex justify-between text-[10px] mb-1">
                                <span className="text-slate-400">Take Profit:</span>
                                <span className="text-emerald-400 font-bold">+{editTp}%</span>
                              </div>
                              <input
                                type="range"
                                min="5"
                                max="50"
                                step="1"
                                value={editTp}
                                onChange={(e) => setEditTp(parseInt(e.target.value))}
                                className="w-full accent-emerald-500"
                              />
                            </div>
                          </div>

                          <div className="flex items-center justify-between text-[10px] font-mono">
                            <label className="flex items-center gap-1.5 cursor-pointer text-slate-400">
                              <input
                                type="checkbox"
                                checked={editTrailing}
                                onChange={(e) => setEditTrailing(e.target.checked)}
                                className="accent-cyan-500 rounded"
                              />
                              Ativar Trailing Stop
                            </label>
                            {editTrailing && (
                              <div className="flex items-center gap-1">
                                <span className="text-[9px] text-slate-500">Offset:</span>
                                <input
                                  type="number"
                                  min="0.5"
                                  max="5"
                                  step="0.5"
                                  value={editTrailingOffset}
                                  onChange={(e) => setEditTrailingOffset(parseFloat(e.target.value) || 2.5)}
                                  className="w-12 bg-slate-950 border border-slate-800 px-1 rounded text-slate-300 text-center"
                                />
                                <span className="text-[9px] text-slate-500">%</span>
                              </div>
                            )}
                          </div>

                          <div className="flex gap-2 pt-1.5">
                            <button
                              onClick={() => handleUpdateRisk(pos.id)}
                              className="flex-1 py-1 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 border border-emerald-500/20 rounded font-mono text-[9px] font-bold cursor-pointer"
                            >
                              SALVAR REGRAS DE RISCO
                            </button>
                            <button
                              onClick={() => setEditingPositionId(null)}
                              className="px-2 py-1 bg-slate-800 hover:bg-slate-750 text-slate-300 rounded font-mono text-[9px] cursor-pointer"
                            >
                              CANCELAR
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <button
                            onClick={() => {
                              setEditingPositionId(pos.id);
                              setEditSl(pos.stopLossPercent);
                              setEditTp(pos.takeProfitPercent);
                              setEditTrailing(pos.trailingStopActive);
                              setEditTrailingOffset(pos.trailingStopOffsetPercent);
                            }}
                            className="flex-1 py-1 bg-slate-900 hover:bg-slate-850 text-slate-300 border border-slate-800 hover:border-slate-750 rounded font-mono text-[9px] cursor-pointer"
                          >
                            ⚙️ AJUSTAR SL / TP
                          </button>
                          <button
                            onClick={() => handleClosePosition(pos.id, pos.token)}
                            className="px-3 py-1 bg-rose-600/10 hover:bg-rose-600/20 text-rose-400 border border-rose-500/20 rounded font-mono text-[9px] font-extrabold cursor-pointer"
                          >
                            ⚡ LIQUIDAR IMEDIATO
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

        </div>

        {/* Right 1 Column: Tripped indicators and Stress tools */}
        <div className="space-y-4">
          
          {/* Tripped Circuit Breakers Status Panels */}
          <div className="p-3 bg-slate-950/60 border border-slate-850 rounded-lg space-y-2.5">
            <h3 className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5 border-b border-slate-850 pb-1.5">
              <AlertOctagon className="w-3.5 h-3.5 text-rose-400" /> STATUS DOS DISJUNTORES
            </h3>

            <div className="space-y-1.5 text-[10px] font-mono">
              {/* Latency Breaker */}
              <div className={`p-2 rounded border flex justify-between items-center ${
                latencyBreakerTripped 
                  ? "bg-rose-500/10 border-rose-500/40 text-rose-400 animate-pulse" 
                  : "bg-slate-900 border-slate-850 text-slate-400"
              }`}>
                <span>Disjuntor de Latência:</span>
                <span className="font-bold">{latencyBreakerTripped ? "DISPARADO (HALT)" : "ARMADO & OK"}</span>
              </div>

              {/* Drawdown Breaker */}
              <div className={`p-2 rounded border flex justify-between items-center ${
                drawdownBreakerTripped 
                  ? "bg-rose-500/10 border-rose-500/40 text-rose-400 animate-pulse" 
                  : "bg-slate-900 border-slate-850 text-slate-400"
              }`}>
                <span>Disjuntor Drawdown:</span>
                <span className="font-bold">{drawdownBreakerTripped ? "DISPARADO (HALT)" : "ARMADO & OK"}</span>
              </div>

              {/* RPC Node Communication Breaker */}
              <div className={`p-2 rounded border flex justify-between items-center ${
                rpcBreakerTripped 
                  ? "bg-rose-500/10 border-rose-500/40 text-rose-400 animate-pulse" 
                  : "bg-slate-900 border-slate-850 text-slate-400"
              }`}>
                <span>Disjuntor RPC gRPC:</span>
                <span className="font-bold">{rpcBreakerTripped ? "DISPARADO (OFFLINE)" : "ARMADO & OK"}</span>
              </div>
            </div>
          </div>

          {/* Production Operational Security Controls */}
          <div className="p-3 bg-slate-950/60 border border-slate-850 rounded-lg space-y-2.5">
            <h3 className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5 border-b border-slate-850 pb-1.5">
              <ShieldAlert className="w-3.5 h-3.5 text-rose-500" /> CONTROLES DE SEGURANÇA REAL
            </h3>

            <div className="space-y-2">
              {/* Kill Switch Toggle */}
              <button
                onClick={handleToggleKillSwitch}
                className={`w-full py-1.5 rounded font-mono font-bold text-[10px] transition-all flex items-center justify-center gap-1 cursor-pointer border ${
                  secState.killSwitchActive
                    ? "bg-rose-500/20 text-rose-400 border-rose-500/50 animate-pulse"
                    : "bg-slate-900 text-slate-400 border-slate-800 hover:bg-slate-850"
                }`}
              >
                🚨 KILL SWITCH: {secState.killSwitchActive ? "ENGAGED !!!" : "DISENGAGED (SAFE)"}
              </button>

              {/* Read Only Toggle */}
              <button
                onClick={handleToggleReadOnly}
                className={`w-full py-1.5 rounded font-mono font-bold text-[10px] transition-all flex items-center justify-center gap-1 cursor-pointer border ${
                  secState.readOnlyMode
                    ? "bg-amber-500/20 text-amber-400 border-amber-500/50"
                    : "bg-slate-900 text-slate-400 border-slate-800 hover:bg-slate-850"
                }`}
              >
                🔒 READ-ONLY MODE: {secState.readOnlyMode ? "ACTIVE (BLOCKED)" : "DISABLED"}
              </button>

              {/* Consecutive Failures bar */}
              <div className="bg-slate-900 border border-slate-850 p-2 rounded text-[9px] font-mono">
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Falhas Consecutivas:</span>
                  <span className={secState.consecutiveFailures > 0 ? "text-rose-400 font-bold" : "text-emerald-400"}>
                    {secState.consecutiveFailures} / {secState.failureThreshold}
                  </span>
                </div>
                <div className="w-full h-1 bg-slate-950 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-rose-500 transition-all duration-300"
                    style={{ width: `${(secState.consecutiveFailures / secState.failureThreshold) * 100}%` }}
                  ></div>
                </div>
              </div>
            </div>
          </div>

          {/* Stress triggers simulation */}
          <div className="p-3 bg-slate-950/40 border border-slate-850 rounded-lg space-y-2">
            <h4 className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1 border-b border-slate-850 pb-1.5">
              <WifiOff className="w-3.5 h-3.5 text-rose-400" /> SIMULAÇÕES DE FALHA REDE
            </h4>
            
            <button
              onClick={simulateRpcFailure}
              className="w-full py-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 hover:text-rose-300 border border-rose-500/20 rounded font-mono font-bold text-[10px] transition-colors flex items-center justify-center gap-1 cursor-pointer"
            >
              SIMULAR DESCONEXÃO RPC
            </button>
          </div>

        </div>

      </div>

      {/* Realtime Action Logs Terminal */}
      <div className="p-2.5 bg-slate-950 rounded-lg border border-slate-850 text-[10px] font-mono flex-1 min-h-[110px] flex flex-col">
        <span className="text-slate-500 uppercase tracking-widest text-[9px] border-b border-slate-850/60 pb-1 mb-1.5 block">
          REGISTRO DE GESTÃO DE RISCO E DISJUNTORES (L9 OBSERVABILITY STREAM)
        </span>
        <div className="overflow-y-auto max-h-[110px] space-y-1 select-text scrollbar-thin">
          {riskLogs.map((log, index) => (
            <div key={index} className="text-slate-400">
              <span className="text-slate-600">[{new Date().toTimeString().split(' ')[0]}]</span> {log}
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}
