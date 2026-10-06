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
/**
 * Presets de tip SEM valor inventado: `null` significa NÃO MEDIDO. O painel mostra "não medido"
 * em vez de um número de vitrine — quem opera capital precisa saber quando não há dado.
 */
interface TipPresets {
  low: number | null;
  medium: number | null;
  high: number | null;
  extreme: number | null;
}

/**
 * Regiões de block engine da Jito são um fato publicado (não medimos latência a partir daqui —
 * este processo não está em nenhuma delas). A lista existe para o operador ESCOLHER a região
 * mais próxima do seu servidor; o número em ms que existia aqui era invenção.
 */
const JITO_BLOCK_ENGINE_REGIONS = ["Amsterdam", "Frankfurt", "London", "New York", "Salt Lake City", "Singapore", "Tokyo"];

interface MevExecutionEngineProps {
  selectedToken?: { name: string; mint: string } | null;
  onBundleSuccess?: (newTx: any) => void;
}

/**
 * Escala de líderes: `null` = NÃO MEDIDO / não observável deste processo (ver o endpoint
 * `/api/jito-leader-schedule`). Nada aqui é preenchido com valor de vitrine.
 */
interface LeaderSchedule {
  measured?: boolean;
  currentSlot: number | null;
  nextLeaderSlot: number | null;
  currentLeader: string | null;
  isJitoNextLeader: boolean | null;
  blockEngineReputation: string | null;
  regions: { name: string; delayMs: number }[];
}

export function MevExecutionEngine({ selectedToken, onBundleSuccess }: MevExecutionEngineProps) {
  // Tips state
  const [tips, setTips] = useState<TipPresets>({ low: null, medium: null, high: null, extreme: null });
  /** Quando o tip floor foi medido pela última vez (null = nunca, nesta sessão de painel). */
  const [tipsMeasuredAt, setTipsMeasuredAt] = useState<number | null>(null);
  const [tipsSource, setTipsSource] = useState<string>("não medido");

  // Leader schedule state
  const [leaderInfo, setLeaderInfo] = useState<LeaderSchedule>({
    measured: false,
    currentSlot: null,
    nextLeaderSlot: null,
    currentLeader: null,
    isJitoNextLeader: null,
    blockEngineReputation: null,
    regions: [],
  });

  // Bundle inputs
  const [tokenName, setTokenName] = useState("COSMIC");
  const [tokenMint, setTokenMint] = useState("Cosm6718291882...pump");
  const [swapSol, setSwapSol] = useState("1.5");
  const [customTip, setCustomTip] = useState("0.002");
  const [selectedRegion, setSelectedRegion] = useState(JITO_BLOCK_ENGINE_REGIONS[3]);

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

  /**
   * Tip floor REAL. A resposta de `/api/jito-tips` traz `percentilesSol` (p25/p50/p75/p95) —
   * e o código anterior lia `data.tips`, campo que NÃO existe: o painel exibia presets fixos
   * (0.0005/0.0015/0.005/0.02) como se fossem medição, e o "congestionamento" era `Math.random()`.
   * Agora: sem `percentilesSol`, tudo fica `null` e o painel diz "não medido".
   */
  useEffect(() => {
    const fetchTips = async () => {
      try {
        const res = await fetch("/api/jito-tips");
        const data = await res.json();
        const p = data?.percentilesSol;
        if (data?.available && p && typeof p.p25 === "number") {
          setTips({ low: p.p25, medium: p.p50 ?? null, high: p.p75 ?? null, extreme: p.p95 ?? p.p99 ?? null });
          setTipsMeasuredAt(Date.now());
          setTipsSource("Jito tip_floor (medido no backend)");
        } else {
          setTips({ low: null, medium: null, high: null, extreme: null });
          setTipsSource(`não medido${data?.error ? ` — ${String(data.error).slice(0, 60)}` : ""}`);
        }
      } catch {
        setTips({ low: null, medium: null, high: null, extreme: null });
        setTipsSource("não medido — backend inacessível");
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

        /**
         * NADA DE TRANSAÇÃO FABRICADA. O endpoint `/api/submit-bundle` é um SIMULADOR declarado
         * (`/api/system-truth` → fabricatedEndpoints): nenhum bundle sai daqui, logo não existe
         * fill, preço de execução nem número de bloco. O código anterior montava uma "transação"
         * com `outAmount` e `block` ALEATÓRIOS e a empurrava para a lista de operações do App —
         * o painel exibia um trade que nunca existiu, com números inventados.
         * Agora: o resultado aparece marcado como SIMULADO e nenhuma operação é registrada.
         * `onBundleSuccess` segue reservado para quando houver submissão REAL de bundle — que é a
         * capacidade S8 (envio paralelo), ainda não implementada. Este componente NÃO é o caminho
         * da entrada real do S6: a compra real sai por `POST /api/real-entry` (rota aggregator ou
         * native), com pré-flight simulado e canário. Não confundir os dois: aqui é demonstração
         * da mecânica de bundle; lá é a ordem de compra.
         */
        void onBundleSuccess;
      }
    } catch (err) {
      console.error("Bundle dispatch failed", err);
    } finally {
      setSubmitting(false);
    }
  };

  /** Só aplica preset MEDIDO: com `null` (fonte indisponível), o campo não é preenchido com ficção. */
  const applyTipPreset = (amount: number | null) => {
    if (amount === null) return;
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

        <div
          className={`flex items-center gap-1.5 px-2 py-0.5 rounded border text-[9px] font-mono font-bold ${
            tipsMeasuredAt !== null
              ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
              : "bg-slate-800/60 border-slate-700 text-slate-400"
          }`}
          title={tipsSource}
        >
          <Server className="w-3.5 h-3.5" />
          {tipsMeasuredAt !== null ? "TIP FLOOR MEDIDO" : "TIP FLOOR NÃO MEDIDO"}
        </div>
      </div>

      {/* Leader Schedule Tracker */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-2.5">
        {/* Slot Sync */}
        <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-850/80">
          <span className="block text-[8px] font-mono text-slate-500 uppercase">Solana Slot Atual</span>
          <span className="text-sm font-mono font-bold text-slate-200 mt-1 block flex items-center justify-between">
            {leaderInfo.currentSlot !== null ? leaderInfo.currentSlot.toLocaleString() : "não medido"}
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>
          </span>
        </div>

        {/* Next Leader Slot */}
        <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-850/80">
          <span className="block text-[8px] font-mono text-slate-500 uppercase">Slot do Próximo Líder Jito</span>
          <span className="text-sm font-mono font-bold text-purple-400 mt-1 block flex items-center justify-between">
            {leaderInfo.nextLeaderSlot !== null ? leaderInfo.nextLeaderSlot.toLocaleString() : "não medido"}
            <span className="text-[8px] font-mono px-1 rounded bg-slate-800 text-slate-400">
              {leaderInfo.nextLeaderSlot !== null
                ? leaderInfo.isJitoNextLeader
                  ? "JITO NEXT"
                  : "NORMAL RPC"
                : "SEM ESCALA DE LÍDERES"}
            </span>
          </span>
        </div>

        {/* Jito Validator Name */}
        <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-850/80">
          <span className="block text-[8px] font-mono text-slate-500 uppercase">Validador Ativo no Bloco</span>
          <span className="text-[10px] font-mono text-slate-300 mt-1 block truncate">
            {leaderInfo.currentLeader ?? "não medido (este processo não consulta a escala)"}
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
          <span className="text-[9px] font-mono text-slate-500 uppercase">
            Tip floor p75:{" "}
            <b className={tips.high !== null ? "text-cyan-400 font-bold" : "text-slate-400 font-bold"}>
              {tips.high !== null ? `${tips.high} SOL` : "não medido"}
            </b>
            {tipsMeasuredAt !== null && <span className="text-slate-600"> · fonte: Jito (medido)</span>}
          </span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <button
            type="button"
            onClick={() => applyTipPreset(tips.low)}
            className="p-2 bg-slate-950 hover:bg-slate-900 border border-slate-850 rounded text-center transition-all cursor-pointer"
          >
            <span className="block text-[8px] font-mono text-slate-500 uppercase">Baixo</span>
            <span className="text-xs font-mono font-bold text-slate-300 block mt-0.5">{tips.low ?? "não medido"}</span>
          </button>
          <button
            type="button"
            onClick={() => applyTipPreset(tips.medium)}
            className="p-2 bg-slate-950 hover:bg-slate-900 border border-slate-850 rounded text-center transition-all cursor-pointer"
          >
            <span className="block text-[8px] font-mono text-slate-500 uppercase">Médio</span>
            <span className="text-xs font-mono font-bold text-cyan-400 block mt-0.5">{tips.medium ?? "não medido"}</span>
          </button>
          <button
            type="button"
            onClick={() => applyTipPreset(tips.high)}
            className="p-2 bg-slate-950 hover:bg-slate-900 border border-slate-850 rounded text-center transition-all cursor-pointer"
          >
            <span className="block text-[8px] font-mono text-slate-500 uppercase">Alto</span>
            <span className="text-xs font-mono font-bold text-emerald-400 block mt-0.5">{tips.high ?? "não medido"}</span>
          </button>
          <button
            type="button"
            onClick={() => applyTipPreset(tips.extreme)}
            className="p-2 bg-slate-950 hover:bg-slate-900 border border-slate-850 rounded text-center transition-all cursor-pointer"
          >
            <span className="block text-[8px] font-mono text-slate-500 uppercase">Extremo</span>
            <span className="text-xs font-mono font-bold text-amber-400 block mt-0.5">{tips.extreme ?? "não medido"}</span>
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
              {(leaderInfo.regions.length > 0
                ? leaderInfo.regions.map((reg) => ({ name: reg.name }))
                : JITO_BLOCK_ENGINE_REGIONS.map((name) => ({ name }))
              ).map((reg) => (
                <option key={reg.name} value={reg.name}>
                  {reg.name}
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

          {bundleResult.simulated === true && (
            <div className="mb-2 p-1.5 bg-amber-500/10 border border-amber-500/30 rounded text-[10px] font-mono text-amber-300 font-bold">
              SIMULADO — nenhum bundle foi enviado on-chain. Sem fill, sem preço de execução, sem
              slot. Esta tela demonstra a mecânica de bundle (S8, não implementada). A compra real
              é outro caminho: <code className="text-amber-200">POST /api/real-entry</code>, com
              rota declarada em <code className="text-amber-200">/api/real-entry → entryRoute</code>.
            </div>
          )}
          <p className="text-[10px] font-mono leading-relaxed text-slate-300 mb-2">
            <b>Status:</b> {bundleResult.simulated === true ? "SIMULADO (não é landing real)" : bundleResult.landStatus} <br />
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
        <span>Jitter do block engine: não medido (tip floor medido ≠ jitter de rede)</span>
        <span className="flex items-center gap-1">
          <Activity className="w-3 h-3 text-slate-500" />
          nenhum bundle enviado por este processo
        </span>
      </div>
    </div>
  );
}
