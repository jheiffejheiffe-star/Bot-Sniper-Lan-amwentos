import { CheckCircle, AlertOctagon, Terminal, ExternalLink } from "lucide-react";
import { SnipedTransaction } from "../types";

interface TransactionLoggerProps {
  transactions: SnipedTransaction[];
}

export function TransactionLogger({ transactions }: TransactionLoggerProps) {
  return (
    <div id="transaction-logger" className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 backdrop-blur-md glow-cyan relative overflow-hidden">
      <div className="flex items-center justify-between mb-2.5 pb-2 border-b border-slate-800/60">
        <div className="flex items-center gap-2">
          <Terminal className="w-5 h-5 text-cyan-400" />
          <h2 className="text-xs font-display font-bold text-slate-100 uppercase tracking-tight">Live Sniped Transaction History</h2>
        </div>
        <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-slate-800 text-slate-400">
          {transactions.length} Broadcasted
        </span>
      </div>

      <div className="overflow-x-auto">
        {transactions.length === 0 ? (
          <div className="py-8 text-center text-slate-500 text-sm">
            No sniper activities logged. Arm the sniper to begin listening.
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800/40 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                <th className="py-3 px-2">Time</th>
                <th className="py-3 px-2">Token</th>
                <th className="py-3 px-2">Sol Amount</th>
                <th className="py-3 px-2">Acquired</th>
                <th className="py-3 px-2">Latency</th>
                <th className="py-3 px-2">Tip</th>
                {/* B: o resultado só aparece COM procedência (régua do rótulo do S9/S11/S14). */}
                <th className="py-3 px-2">Resultado</th>
                <th className="py-3 px-2 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/40 font-mono text-xs">
              {transactions.map((tx) => (
                <tr
                  key={tx.id}
                  className="hover:bg-slate-850/40 transition-colors group"
                >
                  <td className="py-3.5 px-2 text-slate-400 text-[11px]">{tx.time}</td>
                  <td className="py-3.5 px-2 font-semibold">
                    <div className="flex flex-col">
                      <span className="text-slate-100 flex items-center gap-1.5">
                        {tx.token}
                        <a
                          href={`https://solscan.io/token/${tx.mint}`}
                          target="_blank"
                          rel="noreferrer"
                          className="opacity-0 group-hover:opacity-100 text-cyan-400 hover:text-cyan-300 transition-opacity"
                        >
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </span>
                      <span className="text-[10px] text-slate-500">{tx.mint}</span>
                    </div>
                  </td>
                  <td className="py-3.5 px-2 text-slate-300 font-medium">{tx.amount}</td>
                  <td className="py-3.5 px-2 text-cyan-400 font-bold">{tx.outAmount}</td>
                  <td className="py-3.5 px-2">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] ${
                        tx.latencyMs < 10
                          ? "bg-emerald-950/40 text-emerald-400 border border-emerald-900/40"
                          : tx.latencyMs < 20
                          ? "bg-cyan-950/40 text-cyan-400 border border-cyan-900/40"
                          : "bg-amber-950/40 text-amber-400 border border-amber-900/40"
                      }`}
                    >
                      {tx.latencyMs}ms
                    </span>
                  </td>
                  <td className="py-3.5 px-2 text-slate-400 text-[11px]">{tx.tipSol} SOL</td>
                  <td className="py-3.5 px-2">
                    {/*
                      B: sem rótulo do servidor, NADA de PnL é exibido — "não medido" é a resposta
                      honesta. Um número sem procedência (receita da venda lida como lucro, por
                      exemplo) é o defeito do Adendo 19; aqui ele não tem por onde aparecer.
                    */}
                    {typeof tx.pnlNetSol === "number" && tx.label ? (
                      <div className="flex flex-col" title={`${tx.labelBasis ?? "?"}${tx.labelReason ? ` — ${tx.labelReason}` : ""}`}>
                        <span
                          className={`text-[11px] font-bold ${
                            tx.pnlNetSol >= 0 ? "text-emerald-400" : "text-rose-400"
                          }`}
                        >
                          {tx.pnlNetSol >= 0 ? "+" : ""}
                          {tx.pnlNetSol.toFixed(6)} SOL
                        </span>
                        <span className="text-[9px] text-slate-500">
                          {tx.labelBasis === "net_measured" ? "ciclo medido" : (tx.labelBasis ?? tx.label)}
                          {tx.excludedFromValidation ? " · fora da validação" : ""}
                        </span>
                      </div>
                    ) : (
                      <span className="text-[10px] text-slate-500" title={tx.labelReason ?? "sem rótulo de procedência do servidor"}>
                        não medido
                      </span>
                    )}
                  </td>
                  <td className="py-3.5 px-2 text-right">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        tx.isAntiRugSaved
                          ? "bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse"
                          : tx.status === "success"
                          ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                          : tx.status === "blacklisted"
                          ? "bg-slate-800 text-slate-400 border border-slate-700"
                          : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                      }`}
                    >
                      {tx.isAntiRugSaved ? (
                        <>
                          <CheckCircle className="w-3 h-3 text-amber-400" />
                          {tx.savedAmountSol} SOL SALVO
                        </>
                      ) : tx.status === "success" ? (
                        <>
                          <CheckCircle className="w-3 h-3 text-emerald-400" />
                          CONFIRMED
                        </>
                      ) : tx.status === "blacklisted" ? (
                        <>
                          <AlertOctagon className="w-3 h-3 text-slate-500" />
                          SHIELDED
                        </>
                      ) : (
                        <>
                          <AlertOctagon className="w-3 h-3 text-rose-400" />
                          FAILED
                        </>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
