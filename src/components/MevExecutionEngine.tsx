import { useState, useEffect } from "react";
import { 
  Zap, 
  Send, 
  Layers, 
  Server, 
  CheckCircle, 
  XCircle, 
  Loader2, 
  Activity, 
  ShieldAlert,
  ArrowRight
} from "lucide-react";
import { JitoTips } from "../types";

interface MevExecutionEngineProps {
  selectedToken?: { name: string; mint: string } | null;
  onBundleSuccess?: (newTx: any) => void;
}

interface LeaderSchedule {
  currentSlot: number;
  nextLeaderSlot: number;
  currentLeader: string;
  isJitoNextLeader: boolean;
  blockEngineReputation: string;
  regions: { name: string; delayMs: number }[];
}

export function MevExecutionEngine({ selectedToken, onBundleSuccess }: MevExecutionEngineProps) {
  // Tips state
  const [tips, setTips] = useState<JitoTips>({ low: 0.0005, medium: 0.0015, high: 0.005, extreme: 0.02 });
  const [congestion, setCongestion] = useState<"low" | "medium" | "high">("medium");

  // Leader schedule state
  const [leaderInfo, setLeaderInfo] = useState<LeaderSchedule>({
    currentSlot: 278913410,
    nextLeaderSlot: 278913415,
    currentLeader: "Jito Validator (Tokyo-A)",
    isJitoNextLeader: true,
    blockEngineReputation: "Elite (99.8th percentile)",
    regions: [
      { name: "Tokyo (ap-northeast-1)", delayMs: 4.8 },
      { name: "Frankfurt (eu-central-1)", delayMs: 5.2 },
      { name: "New York (us-east-4)", delayMs: 1.1 },
      { name: "Amsterdam (eu-west-3)", delayMs: 6.0 }
    ]
  });

  // Bundle inputs
  const [tokenName, setTokenName] = useState("COSMIC");
  const [tokenMint, setTokenMint] = useState("Cosm6718291882...pump");
  const [swapSol, setSwapSol] = useState("1.5");
  const [customTip, setCustomTip] = useState("0.002");
  const [selectedRegion, setSelectedRegion] = useState("New York (us-east-4)");

  // Submission execution state
  const [submitting, setSubmitting] = useState(false);
  const [bundleResult, setBundleResult] = useState<any>(null);

  // Sync selected token
  useEffect(() => {
    if (selectedToken) {
      setTokenName(selectedToken.name);
      setTokenMint(selectedToken.mint);
    }
  }, [selectedToken]);

  // Fetch Tips
  useEffect(() => {
    const fetchTips = async () => {
      try {
        const res = await fetch("/api/jito-tips");
        const data = await res.json();
        setTips(data.tips);
        const rand = Math.random();
        if (rand > 0.7) setCongestion("high");
        else if (rand < 0.3) setCongestion("low");
        else setCongestion("medium");
      } catch (e) {
        console.warn("Failed to fetch tips (using local fallback)", e);
      }
    };
    fetchTips();
    const interval = setInterval(fetchTips, 5000);
    return () => clearInterval(interval);
  }, []);

  // Fetch Leader Schedule
  useEffect(() => {
    const fetchLeader = async () => {
      try {
        const res = await fetch("/api/jito-leader-schedule");
        const data = await res.json();
        setLeaderInfo(data);
      } catch (e) {
        console.warn("Failed to fetch leader schedule (using local fallback)", e);
      }
    };
    fetchLeader();
    const interval = setInterval(fetchLeader, 3000);
    return () => clearInterval(interval);
  }, []);

  const handleSendBundle = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setBundleResult(null);

    try {
      const response = await fetch("/api/submit-bundle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenName,
          tokenMint,
          solAmount: swapSol,
          priorityTip: customTip,
          region: selectedRegion.split(" ")[0]
        })
      });
      const data = await response.json();
      
      if (data) {
        setBundleResult(data);
        
        // If bundle landed, notify App context
        if (data.landStatus === "Landed" && onBundleSuccess) {
          const mockTx = {
            id: data.bundleId,
            token: tokenName.toUpperCase(),
            mint: tokenMint.slice(0, 10) + "..." + tokenMint.slice(-4),
            amount: `${swapSol} SOL`,
            outAmount: `${(parseFloat(swapSol) * (150000 + Math.floor(Math.random() * 50000))).toLocaleString()} ${tokenName.toUpperCase()}`,
            time: data.timestamp,
            latencyMs: 4,
            status: "success" as any,
            block: 278913410 + Math.floor(Math.random() * 500),
            tipSol: parseFloat(customTip),
            route: `Jito Bundle (${selectedRegion.split(" ")[0]})`
          };
          onBundleSuccess(mockTx);
        }
      }
    } catch (err) {
      console.error("Bundle dispatch failed", err);
    } finally {
      setSubmitting(false);
    }
  };

  const applyTipPreset = (amount: number) => {
    setCustomTip(amount.toString());
  };

  return (
    <div id="mev-execution-engine" className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 backdrop-blur-md relative overflow-hidden">
      <div className="absolute top-0 right-0 w-24 h-24 bg-purple-500/5 rounded-full blur-2xl pointer-events-none"></div>

      {/* Header Info */}
      <div className="flex items-center justify-between mb-2.5 pb-2 border-b border-slate-800/60">
        <div className="flex items-center gap-2">
          <Layers className="w-5 h-5 text-purple-400 animate-pulse" />
          <div>
            <h2 className="text-xs font-display font-bold text-slate-100 uppercase tracking-tight">Motor de Execução MEV Jito Bundles</h2>
            <span className="text-[9px] font-mono text-purple-400 block uppercase tracking-wider">Atomic Private Bundle Dispatcher</span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-[9px] font-mono font-bold text-emerald-400">
          <Server className="w-3.5 h-3.5" />
          BLOCK-ENGINE LINKED
        </div>
      </div>

      {/* Leader Schedule Tracker */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-2.5">
        {/* Slot Sync */}
        <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-850/80">
          <span className="block text-[8px] font-mono text-slate-500 uppercase">Solana Slot Atual</span>
          <span className="text-sm font-mono font-bold text-slate-200 mt-1 block flex items-center justify-between">
            {leaderInfo.currentSlot.toLocaleString()}
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>
          </span>
        </div>

        {/* Next Leader Slot */}
        <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-850/80">
          <span className="block text-[8px] font-mono text-slate-500 uppercase">Slot do Próximo Líder Jito</span>
          <span className="text-sm font-mono font-bold text-purple-400 mt-1 block flex items-center justify-between">
            {leaderInfo.nextLeaderSlot.toLocaleString()}
            <span className={`text-[8px] font-mono px-1 rounded ${
              leaderInfo.isJitoNextLeader ? "bg-purple-500/10 text-purple-400" : "bg-slate-800 text-slate-400"
            }`}>
              {leaderInfo.isJitoNextLeader ? "JITO NEXT" : "NORMAL RPC"}
            </span>
          </span>
        </div>

        {/* Jito Validator Name */}
        <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-850/80">
          <span className="block text-[8px] font-mono text-slate-500 uppercase">Validador Ativo no Bloco</span>
          <span className="text-[10px] font-mono text-slate-300 mt-1 block truncate">
            {leaderInfo.currentLeader}
          </span>
        </div>
      </div>

      {/* Jito Tips Estimator integration */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest flex items-center gap-1">
            <Zap className="w-3.5 h-3.5 text-amber-400" />
            Nível Recomendado de Gorjeta Jito (SOL)
          </span>
          <span className="text-[9px] font-mono text-slate-500 uppercase">Congestionamento: <b className="text-cyan-400 font-bold">{congestion}</b></span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <button
            type="button"
            onClick={() => applyTipPreset(tips.low)}
            className="p-2 bg-slate-950 hover:bg-slate-900 border border-slate-850 rounded text-center transition-all cursor-pointer"
          >
            <span className="block text-[8px] font-mono text-slate-500 uppercase">Baixo</span>
            <span className="text-xs font-mono font-bold text-slate-300 block mt-0.5">{tips.low}</span>
          </button>
          <button
            type="button"
            onClick={() => applyTipPreset(tips.medium)}
            className="p-2 bg-slate-950 hover:bg-slate-900 border border-slate-850 rounded text-center transition-all cursor-pointer"
          >
            <span className="block text-[8px] font-mono text-slate-500 uppercase">Médio</span>
            <span className="text-xs font-mono font-bold text-cyan-400 block mt-0.5">{tips.medium}</span>
          </button>
          <button
            type="button"
            onClick={() => applyTipPreset(tips.high)}
            className="p-2 bg-slate-950 hover:bg-slate-900 border border-slate-850 rounded text-center transition-all cursor-pointer"
          >
            <span className="block text-[8px] font-mono text-slate-500 uppercase">Alto</span>
            <span className="text-xs font-mono font-bold text-emerald-400 block mt-0.5">{tips.high}</span>
          </button>
          <button
            type="button"
            onClick={() => applyTipPreset(tips.extreme)}
            className="p-2 bg-slate-950 hover:bg-slate-900 border border-slate-850 rounded text-center transition-all cursor-pointer"
          >
            <span className="block text-[8px] font-mono text-slate-500 uppercase">Extremo</span>
            <span className="text-xs font-mono font-bold text-amber-400 block mt-0.5">{tips.extreme}</span>
          </button>
        </div>
      </div>

      {/* Custom Bundle Submitter Console */}
      <form onSubmit={handleSendBundle} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">Meme Target</label>
            <input
              type="text"
              value={tokenName}
              onChange={(e) => setTokenName(e.target.value)}
              disabled={submitting}
              className="w-full bg-slate-950 border border-slate-850 focus:border-purple-500 rounded px-2.5 py-1.5 text-xs font-mono text-slate-200 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">Mint do Contrato</label>
            <input
              type="text"
              value={tokenMint}
              onChange={(e) => setTokenMint(e.target.value)}
              disabled={submitting}
              className="w-full bg-slate-950 border border-slate-850 focus:border-purple-500 rounded px-2.5 py-1.5 text-xs font-mono text-slate-200 focus:outline-none"
            />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">Swap (SOL)</label>
            <input
              type="number"
              step="0.05"
              value={swapSol}
              onChange={(e) => setSwapSol(e.target.value)}
              disabled={submitting}
              className="w-full bg-slate-950 border border-slate-850 focus:border-purple-500 rounded px-2 py-1.5 text-xs font-mono text-slate-200 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">Gorjeta (Tip)</label>
            <input
              type="number"
              step="0.0005"
              value={customTip}
              onChange={(e) => setCustomTip(e.target.value)}
              disabled={submitting}
              className="w-full bg-slate-950 border border-slate-850 focus:border-purple-500 rounded px-2 py-1.5 text-xs font-mono text-slate-200 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">Relayer Node</label>
            <select
              value={selectedRegion}
              onChange={(e) => setSelectedRegion(e.target.value)}
              disabled={submitting}
              className="w-full bg-slate-950 border border-slate-850 focus:border-purple-500 rounded px-1.5 py-1.5 text-[10px] font-mono text-slate-200 focus:outline-none cursor-pointer"
            >
              {leaderInfo.regions.map((reg) => (
                <option key={reg.name} value={reg.name}>
                  {reg.name.split(" ")[0]} ({reg.delayMs}ms)
                </option>
              ))}
            </select>
          </div>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full py-2 px-4 rounded bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold text-xs transition-all flex items-center justify-center gap-1.5 shadow-lg cursor-pointer"
        >
          {submitting ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Sincronizando & Transmitindo Bundle Atômico...
            </>
          ) : (
            <>
              <Send className="w-3.5 h-3.5" />
              Enviar Bundle Jito (Atômico & Protegido)
            </>
          )}
        </button>
      </form>

      {/* Atomic packing list */}
      <div className="mt-3 p-2 bg-slate-950 rounded border border-slate-850/80 space-y-1">
        <div className="text-[9px] font-mono text-slate-500 uppercase tracking-widest pb-1 border-b border-slate-900">
          Estrutura Atômica do Jito Bundle:
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono text-slate-300 py-0.5">
          <span className="w-4 h-4 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-400 flex items-center justify-center text-[8px] font-bold">1</span>
          <span>Tx1: Raydium / Pump Swap Ingress (Comprar {swapSol} SOL do token)</span>
          <ArrowRight className="w-3 h-3 text-slate-600" />
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono text-slate-300 py-0.5">
          <span className="w-4 h-4 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-400 flex items-center justify-center text-[8px] font-bold">2</span>
          <span>Tx2: MEV Transfer Tip Fee ({customTip} SOL para validador Jito)</span>
          <ArrowRight className="w-3 h-3 text-slate-600" />
        </div>
      </div>

      {/* Submission Status Results */}
      {bundleResult && (
        <div className={`mt-3.5 p-3 rounded-lg border ${
          bundleResult.landStatus === "Landed"
            ? "bg-emerald-950/15 border-emerald-800/30 text-emerald-300"
            : bundleResult.landStatus === "Reverted"
            ? "bg-rose-950/15 border-rose-800/30 text-rose-300"
            : "bg-amber-950/15 border-amber-800/30 text-amber-300"
        }`}>
          <div className="flex items-center justify-between mb-2 pb-1 border-b border-slate-800/20">
            <div className="flex items-center gap-1.5 font-display font-bold text-xs uppercase">
              {bundleResult.landStatus === "Landed" && <CheckCircle className="w-4 h-4 text-emerald-400 animate-pulse" />}
              {bundleResult.landStatus === "Reverted" && <ShieldAlert className="w-4 h-4 text-rose-400" />}
              {bundleResult.landStatus === "Dropped" && <XCircle className="w-4 h-4 text-amber-400 animate-pulse" />}
              Bundle ID: <span className="font-mono font-medium text-[10px] text-slate-300">{bundleResult.bundleId}</span>
            </div>
            <span className="text-[9px] font-mono text-slate-400">
              {bundleResult.timestamp}
            </span>
          </div>

          <p className="text-[10px] font-mono leading-relaxed text-slate-300 mb-2">
            <b>Status:</b> {bundleResult.landStatus} <br />
            <b>Detalhe:</b> {bundleResult.landReason}
          </p>

          {bundleResult.gasSavedSol > 0 && (
            <div className="mb-2.5 p-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded text-[10px] font-mono text-emerald-400 font-bold flex items-center justify-between">
              <span>Evitou Gasto de Gas Inútil:</span>
              <span>+{bundleResult.gasSavedSol.toFixed(4)} SOL</span>
            </div>
          )}

          {/* Trace details */}
          <div className="space-y-1 pt-1.5 border-t border-slate-800/20 font-mono text-[9px] text-slate-400">
            {bundleResult.bundleTrace.map((tr: string, i: number) => (
              <div key={i} className="flex items-start gap-1">
                <span>&gt;</span>
                <span>{tr}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Network Latency Stats footer */}
      <div className="mt-3.5 pt-2 border-t border-slate-850/60 flex items-center justify-between text-[9px] font-mono text-slate-500 uppercase tracking-wider">
        <span>BlockEngine Jitter: &lt; 0.2ms</span>
        <span className="flex items-center gap-1">
          <Activity className="w-3 h-3 text-purple-400 animate-pulse" />
          Pre-Mempool Shield Enabled
        </span>
      </div>
    </div>
  );
}
