import { useState, useEffect } from "react";
import { Radio, Play, Pause, Zap, ArrowRight, CheckCircle2 } from "lucide-react";

interface MempoolTx {
  signature: string;
  type: "LP_INITIALIZE" | "PUMP_MIGRATION" | "WHALE_BUY" | "RUG_PULL_ATTEMPT";
  tokenName: string;
  tokenMint: string;
  solAmount: string;
  time: string;
  gasPriceGwei: number; // micro-lamports for Solana
  jitoTip?: number;
  status: "pending" | "sniped" | "passed";
}

interface MempoolScannerProps {
  onSelectToken: (token: { name: string; mint: string }) => void;
  onTokenDetected?: (token: { name: string; mint: string; type: string; solAmount: string }) => void;
}

export function MempoolScanner({ onSelectToken, onTokenDetected }: MempoolScannerProps) {
  const [isActive, setIsActive] = useState(true);
  const [transactions, setTransactions] = useState<MempoolTx[]>([]);
  const [selectedType, setSelectedType] = useState<string>("all");
  const [lastNotification, setLastNotification] = useState<string>("");

  // Simulated live Solana pending tx stream
  useEffect(() => {
    if (!isActive) return;

    const tokenNames = ["PEPE_SOL", "NEURAL_NET", "SOL_DOGE", "ALPHA_AI", "MEME_KING", "RUG_TRAP", "PUMP_MASTER", "CYBER_PUNK", "SOL_TURBO"];
    const tokenMints = [
      "Pep3JtE718291abcDeFgHiJkLmNoPqRsTuVwXyZ1",
      "Neur6718291882Hdkas9812hasd812hasd281H",
      "Doge18293911XyZaBcDeFgHiJkLmNoPqRsTuVwX",
      "Alph78129329DfGgHiJkLmNoPqRsTuVwXyZ1234",
      "King777123912Aasdasdsa8912hads9812hasdH",
      "RugT1111111111111111111111111111111111",
      "Pump98231has98das89123hasd89123hdsadasd",
      "Cybe91283hds98dsa9812hsa9812hasd8912hs",
      "Turb82391has89das89213hasd89213has892d"
    ];

    const interval = setInterval(() => {
      const idx = Math.floor(Math.random() * tokenNames.length);
      const isRug = tokenNames[idx] === "RUG_TRAP";
      const types: Array<MempoolTx["type"]> = ["LP_INITIALIZE", "PUMP_MIGRATION", "WHALE_BUY"];
      if (isRug) {
        types.push("RUG_PULL_ATTEMPT");
      }
      const type = types[Math.floor(Math.random() * (isRug ? 4 : 3))];

      const solAmount = type === "WHALE_BUY" 
        ? (Math.random() * 80 + 20).toFixed(1) 
        : type === "RUG_PULL_ATTEMPT"
        ? (Math.random() * 250 + 50).toFixed(1)
        : (Math.random() * 15 + 2).toFixed(1);

      const newTx: MempoolTx = {
        signature: "sig_" + Math.random().toString(36).substring(2, 12),
        type,
        tokenName: tokenNames[idx],
        tokenMint: tokenMints[idx],
        solAmount,
        time: new Date().toTimeString().split(' ')[0] + "." + String(Date.now() % 1000).padStart(3, '0'),
        gasPriceGwei: Math.floor(Math.random() * 400000) + 100000,
        jitoTip: type === "LP_INITIALIZE" || type === "PUMP_MIGRATION" ? Number((Math.random() * 0.015).toFixed(4)) : undefined,
        status: "pending"
      };

      setTransactions((prev) => {
        const updated = [newTx, ...prev];
        return updated.slice(0, 15); // keep last 15
      });

      if (onTokenDetected) {
        onTokenDetected({
          name: newTx.tokenName,
          mint: newTx.tokenMint,
          type: newTx.type,
          solAmount: newTx.solAmount
        });
      }

      if (type === "LP_INITIALIZE") {
        setLastNotification(`🎯 Nova Liquidez Criada para ${newTx.tokenName}!`);
        setTimeout(() => setLastNotification(""), 3000);
      } else if (type === "RUG_PULL_ATTEMPT") {
        setLastNotification(`🚨 Tentativa de Rug Pull detectada em mempool para ${newTx.tokenName}!`);
        setTimeout(() => setLastNotification(""), 3000);
      }
    }, 2800);

    return () => clearInterval(interval);
  }, [isActive]);

  const filteredTxs = selectedType === "all" 
    ? transactions 
    : transactions.filter(t => t.type === selectedType);

  const handleSelect = (tx: MempoolTx) => {
    onSelectToken({
      name: tx.tokenName,
      mint: tx.tokenMint
    });
  };

  return (
    <div id="mempool-scanner-panel" className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 backdrop-blur-md glow-cyan relative overflow-hidden flex flex-col justify-between h-full">
      <div className="absolute top-0 left-0 w-24 h-24 bg-cyan-500/5 rounded-full blur-2xl pointer-events-none"></div>

      <div>
        <div className="flex items-center justify-between mb-2 pb-2 border-b border-slate-800/60">
          <div className="flex items-center gap-2">
            <Radio className={`w-5 h-5 ${isActive ? "text-rose-500 animate-pulse" : "text-slate-500"}`} />
            <h2 className="text-lg font-display font-semibold text-slate-100">Live Mempool Scanner</h2>
          </div>

          <div className="flex items-center gap-2">
            {isActive ? (
              <span className="flex items-center gap-1 text-[9px] font-mono font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded animate-pulse">
                🔴 LIVE STREAM
              </span>
            ) : (
              <span className="text-[9px] font-mono text-slate-500 bg-slate-850 px-1.5 py-0.5 rounded">
                PAUSADO
              </span>
            )}
            <button
              onClick={() => setIsActive(!isActive)}
              className={`p-1 rounded cursor-pointer transition-all ${
                isActive ? "bg-slate-800 text-slate-400 hover:text-rose-400" : "bg-cyan-500 text-slate-950 font-bold"
              }`}
              title={isActive ? "Pause stream" : "Resume stream"}
            >
              {isActive ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {lastNotification && (
          <div className="mb-3 p-2 bg-rose-950/30 border border-rose-500/30 rounded text-xs font-mono text-rose-300 animate-bounce flex items-center gap-2">
            <Zap className="w-4 h-4 text-rose-400 animate-pulse shrink-0" />
            <span>{lastNotification}</span>
          </div>
        )}

        {/* Categories selector */}
        <div className="flex gap-1.5 mb-3 overflow-x-auto scrollbar-none">
          {[
            { id: "all", label: "TUDO" },
            { id: "LP_INITIALIZE", label: "LPs NOVOS" },
            { id: "PUMP_MIGRATION", label: "MIGRAÇÕES" },
            { id: "WHALE_BUY", label: "BALEIAS" },
            { id: "RUG_PULL_ATTEMPT", label: "RUGS" }
          ].map(cat => (
            <button
              key={cat.id}
              onClick={() => setSelectedType(cat.id)}
              className={`text-[9px] font-mono px-2 py-0.5 rounded border whitespace-nowrap cursor-pointer transition-all ${
                selectedType === cat.id
                  ? "bg-cyan-500/15 text-cyan-400 border-cyan-500/40"
                  : "bg-slate-950 text-slate-400 border-slate-850/80 hover:border-slate-800"
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Live stream feeds list */}
        <div className="space-y-2 max-h-[175px] overflow-y-auto scrollbar-thin">
          {filteredTxs.length === 0 ? (
            <div className="py-8 text-center text-slate-500 text-xs font-mono border border-dashed border-slate-850 rounded bg-slate-950/40">
              Escaneando slots Solana PubSub à procura de transações de mempool...
            </div>
          ) : (
            filteredTxs.map((tx) => (
              <div
                key={tx.signature}
                className="p-2.5 bg-slate-950 rounded-lg border border-slate-850/80 hover:border-cyan-500/30 transition-all flex items-center justify-between group"
              >
                <div className="min-w-0 flex-1 pr-3">
                  <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                    <span className={`text-[8px] font-mono font-bold px-1.5 py-0.25 rounded ${
                      tx.type === "LP_INITIALIZE"
                        ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
                        : tx.type === "PUMP_MIGRATION"
                        ? "bg-purple-500/10 text-purple-400 border border-purple-500/20"
                        : tx.type === "WHALE_BUY"
                        ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                        : "bg-rose-500/10 text-rose-400 border border-rose-500/20 animate-pulse"
                    }`}>
                      {tx.type === "LP_INITIALIZE" 
                        ? "NEW_LP" 
                        : tx.type === "PUMP_MIGRATION" 
                        ? "MIGRADO" 
                        : tx.type === "WHALE_BUY" 
                        ? "BALEIA" 
                        : "RUG_PULL"}
                    </span>
                    <span className="text-xs font-bold text-slate-200 font-mono truncate max-w-[80px]">
                      {tx.tokenName}
                    </span>
                    <span className="text-[9px] font-mono text-slate-500">
                      {tx.time}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                    <span className="truncate max-w-[120px] text-slate-500" title={tx.tokenMint}>{tx.tokenMint}</span>
                    <span className="text-slate-300 font-bold">{tx.solAmount} SOL</span>
                  </div>

                  {tx.jitoTip !== undefined && (
                    <div className="mt-1 text-[8px] font-mono text-cyan-500/90 flex items-center gap-1">
                      ⚡ Jito Bundle Tip: {tx.jitoTip} SOL
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleSelect(tx)}
                    className="p-1 px-2 rounded bg-slate-900 border border-slate-800 text-slate-400 hover:text-cyan-400 hover:border-cyan-500/40 text-[9px] font-mono flex items-center gap-1 cursor-pointer transition-all"
                  >
                    <span>Carregar</span>
                    <ArrowRight className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-slate-850 flex items-center justify-between text-[9px] font-mono text-slate-500">
        <span className="flex items-center gap-1">
          <CheckCircle2 className="w-3 h-3 text-emerald-500" />
          WebSocket Buffer OK
        </span>
        <span>Slots/Sec: 1.8</span>
      </div>
    </div>
  );
}
