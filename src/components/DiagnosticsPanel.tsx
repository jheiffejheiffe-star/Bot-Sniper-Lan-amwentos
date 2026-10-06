import { useState, useEffect } from "react";
import { CheckCircle2, AlertTriangle, Play, Loader2, AlertOctagon, Key, ShieldCheck, Activity, Sliders } from "lucide-react";
import { HftProfiler } from "./HftProfiler";

interface DiagnosticItem {
  id: string;
  name: string;
  desc: string;
  status: 'passed' | 'warning' | 'failed' | 'pending';
}

export function DiagnosticsPanel() {
  const [activeSubTab, setActiveSubTab] = useState<"infra" | "profiler">("infra");
  const [coLocationActive, setCoLocationActive] = useState(false);
  /**
   * AUDITORIA DE INFRAESTRUTURA — CADA ITEM É UMA VERIFICAÇÃO REAL.
   *
   * A versão anterior "auditava" uma lista de textos fixos ("drift física do PTPv2 no rack LD4
   * ... [OK, <1ns]", "canal ShredStream ... [OK, 1.1ms]") e marcava tudo como ATIVO,
   * independentemente do estado do sistema. Aquilo não era diagnóstico: era animação com
   * aparência de laudo técnico — e um operador podia acreditar que tinha co-location e clock
   * sincronizado por nanossegundo.
   *
   * Agora cada item corresponde a um dado LIDO do backend agora. Sem resposta, o estado é
   * OFFLINE/ALERTA com o motivo — nunca "ATIVO" por padrão.
   */
  const [items, setItems] = useState<DiagnosticItem[]>([
    { id: "rpc", name: "RPC conectado e medido", desc: "Verifica se algum nó RPC respondeu e qual a latência p95 MEDIDA", status: 'pending' },
    { id: "deteccao", name: "Detecção de lançamentos (logsSubscribe WSS)", desc: "Verifica se o WebSocket está aberto e se há eventos chegando", status: 'pending' },
    { id: "blockhash", name: "Blockhash real disponível para assinar", desc: "Sem blockhash real, NENHUMA transação é assinada — o cache informa o motivo", status: 'pending' },
    { id: "orcamento", name: "Perfil de cota coerente com o endpoint", desc: "HFT_RPC_PROFILE tem de bater com o endpoint conectado (senão: 429 ou teto baixo demais)", status: 'pending' },
    { id: "chave", name: "Custódia da chave operacional", desc: "Estado do cofre: chave presente, cifrada em RAM e se está em modo efêmero", status: 'pending' },
  ]);
  const [running, setRunning] = useState(false);
  const [sandboxLog, setSandboxLog] = useState<string>("");

  const checkCoLocation = async () => {
    try {
      const res = await fetch("/api/co-location");
      const data = await res.json();
      setCoLocationActive(data.active);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    checkCoLocation();
    const interval = setInterval(checkCoLocation, 3000);
    return () => clearInterval(interval);
  }, []);

  /**
   * Executa as verificações contra o backend. `fetchJson` devolve `null` quando a chamada falha —
   * e aí o item vira OFFLINE com o motivo, em vez de "ATIVO".
   */
  const runDiagnostics = async () => {
    setRunning(true);
    setItems((prev) => prev.map((item) => ({ ...item, status: 'pending' })));

    const fetchJson = async (url: string): Promise<any | null> => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    };

    const setStatus = (id: string, status: DiagnosticItem["status"]) =>
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, status } : i)));

    const registrar = (id: string, msg: string, status: DiagnosticItem["status"]) => {
      setSandboxLog(`[${id}] ${msg}`);
      setStatus(id, status);
    };

    // 1. RPC: existe nó medido?
    {
      setSandboxLog("[rpc] consultando /api/rpc-nodes...");
      const nodes = await fetchJson("/api/rpc-nodes");
      const medidos = Array.isArray(nodes?.nodes)
        ? nodes.nodes.filter((n: any) => n?.metricsSource !== "unavailable" && typeof n?.latency === "number" && n.latency > 0)
        : [];
      if (medidos.length > 0) {
        const melhor = medidos.reduce((a: any, b: any) => (b.latency < a.latency ? b : a));
        registrar("rpc", `${medidos.length} nó(s) medido(s); menor p95 = ${melhor.latency} ms (${melhor.name})`, "passed");
      } else {
        // `metricsSource: unavailable` = sem amostra. Sem amostra não existe latência para exibir.
        registrar("rpc", "nenhum nó RPC respondeu neste processo — latência NÃO medida", "failed");
      }
    }

    // 2. Detecção
    {
      setSandboxLog("[deteccao] consultando /api/health...");
      const health = await fetchJson("/api/health");
      const det = health?.detection;
      if (!det) {
        registrar("deteccao", "backend não respondeu em /api/health", "failed");
      } else if (det.socketOpen && !det.degraded) {
        registrar("deteccao", `WSS aberto; ${det.eventCount ?? 0} evento(s) de lançamento recebido(s)`, "passed");
      } else if (det.socketOpen) {
        registrar("deteccao", `WSS aberto, mas DEGRADADO; ${det.eventCount ?? 0} evento(s) até agora`, "warning");
      } else {
        registrar("deteccao", "socket WSS NÃO conectado: nenhum lançamento será detectado", "failed");
      }
    }

    // 3. Blockhash
    {
      setSandboxLog("[blockhash] consultando /api/rpc-infra/blockhash...");
      const bh = await fetchJson("/api/rpc-infra/blockhash");
      if (bh?.usable === true) {
        registrar("blockhash", `blockhash válido (idade ${bh.ageMs ?? "?"} ms) — pronto para assinar`, "passed");
      } else {
        registrar("blockhash", `sem blockhash utilizável: ${bh?.lastError ?? "RPC indisponível"}`, "failed");
      }
    }

    // 4. Coerência de perfil de cota
    {
      setSandboxLog("[orcamento] consultando coerência de perfil...");
      const health = await fetchJson("/api/health");
      const coh = health?.rpcCoherence;
      if (!coh) {
        registrar("orcamento", "coerência de perfil não exposta pelo backend", "warning");
      } else if (coh.coherent) {
        registrar("orcamento", `perfil "${coh.declaredProfile}" coerente com o endpoint`, "passed");
      } else {
        const pior = (coh.issues ?? []).find((i: any) => i.severity === "mismatch");
        registrar("orcamento", `INCOERENTE: ${pior?.message ?? "perfil não bate com o endpoint"}`, "failed");
      }
    }

    // 5. Custódia da chave
    {
      setSandboxLog("[chave] consultando /api/operational-security/state...");
      const seg = await fetchJson("/api/operational-security/state");
      const cust = seg?.keyCustody;
      if (!cust) {
        registrar("chave", "estado de custódia não exposto pelo backend", "warning");
      } else if (cust.ephemeral === true || /efêmer|ephemeral/i.test(String(cust.mode ?? ""))) {
        registrar("chave", `chave EFÊMERA (${cust.mode ?? "modo desconhecido"}): não use com capital real`, "warning");
      } else if (cust.present === false) {
        registrar("chave", "nenhuma chave operacional presente", "failed");
      } else {
        registrar("chave", `carteira operacional presente (${cust.mode ?? "modo não informado"})`, "passed");
      }
    }

    setSandboxLog("Auditoria concluída. Estados refletem o que o backend respondeu AGORA — não há valor decorativo.");
    setRunning(false);
  };

  /** Rótulos neutros: a verificação real roda ao apertar o botão. */
  const dynamicDescFor = (item: DiagnosticItem): string => {
    if (item.status === "passed") return item.desc;
    if (item.status === "failed") return `${item.desc} — verificação FALHOU na última execução.`;
    if (item.status === "warning") return `${item.desc} — verificação com ALERTA na última execução.`;
    return item.desc;
  };

  return (
    <div id="diagnostics-panel" className="space-y-4">
      {/* Sub-tab selection */}
      <div className="bg-slate-900/60 border border-slate-850 p-1 rounded-lg flex items-center backdrop-blur-md">
        <button
          onClick={() => setActiveSubTab("infra")}
          className={`text-[11px] font-mono font-bold py-1.5 rounded transition-all cursor-pointer flex-1 flex items-center justify-center gap-1.5 ${
            activeSubTab === "infra"
              ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 shadow-sm"
              : "text-slate-400 hover:text-slate-200 border border-transparent"
          }`}
        >
          <Activity className="w-3.5 h-3.5" />
          Hardware & Infra (Tier-1)
        </button>
        <button
          onClick={() => setActiveSubTab("profiler")}
          className={`text-[11px] font-mono font-bold py-1.5 rounded transition-all cursor-pointer flex-1 flex items-center justify-center gap-1.5 ${
            activeSubTab === "profiler"
              ? "bg-rose-500/10 text-rose-400 border border-rose-500/20 shadow-sm"
              : "text-slate-400 hover:text-slate-200 border border-transparent"
          }`}
        >
          <Sliders className="w-3.5 h-3.5 animate-pulse" />
          Perfilador Performance HFT
        </button>
      </div>

      {activeSubTab === "profiler" ? (
        <HftProfiler />
      ) : (
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 backdrop-blur-md relative overflow-hidden">
          <div className="absolute top-0 right-0 w-24 h-24 bg-cyan-500/5 rounded-full blur-2xl pointer-events-none"></div>

          <div className="flex items-center justify-between mb-2.5 pb-2 border-b border-slate-800/60">
            <div className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-cyan-400 animate-pulse" />
              <div>
                <h2 className="text-sm font-display font-bold text-slate-100 uppercase tracking-tight">Infraestrutura Tier-1 SV</h2>
                <span className="text-[9px] font-mono text-cyan-500/80 block uppercase tracking-wider">HFT Hardware Diagnostics</span>
              </div>
            </div>
            <button
              onClick={runDiagnostics}
              disabled={running}
              className={`px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold flex items-center gap-1.5 transition-all cursor-pointer uppercase ${
                running
                  ? "bg-slate-850 text-slate-400 border border-slate-800"
                  : "bg-cyan-500/10 text-cyan-400 border-cyan-500/30 hover:bg-cyan-500/20"
              }`}
            >
              {running ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Sincronizando...
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5 text-cyan-400" />
                  Auditar Sistema
                </>
              )}
            </button>
          </div>

          {/* Declaração x medição: co-location é fato FÍSICO do host que este painel não mede. */}
          <div className="mb-3 p-2 bg-slate-950 border border-slate-850 rounded text-[10px] font-mono text-slate-400">
            Co-location (declarado pelo operador):{" "}
            <b className={coLocationActive ? "text-cyan-400" : "text-slate-300"}>
              {coLocationActive ? "ATIVO" : "inativo"}
            </b>{" "}
            — este painel NÃO mede a posição física do servidor; a declaração serve para o
            operador registrar o que contratou, não como evidência de latência.
          </div>

          <div className="space-y-3">
            {items.map((item) => {
              const dynamicDesc = dynamicDescFor(item);

              return (
                <div
                  key={item.id}
                  className="p-3 bg-slate-950 rounded-lg border border-slate-850/80 flex items-start justify-between gap-3 hover:border-slate-800 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <span className="font-display font-bold text-xs text-slate-200 flex items-center gap-1.5">
                      {item.id === "chave" && <Key className="w-3.5 h-3.5 text-cyan-400" />}
                      {item.id === "orcamento" && <ShieldCheck className="w-3.5 h-3.5 text-purple-400" />}
                      {item.name}
                    </span>
                    <span className="block text-[10px] text-slate-400 font-mono mt-1 leading-relaxed">{dynamicDesc}</span>
                  </div>

                  <div className="shrink-0 flex items-center justify-center">
                    {item.status === 'passed' ? (
                      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-[9px] font-mono font-bold text-emerald-400">
                        <CheckCircle2 className="w-3 h-3" />
                        ATIVO
                      </span>
                    ) : item.status === 'warning' ? (
                      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-[9px] font-mono font-bold text-amber-400 animate-pulse">
                        <AlertTriangle className="w-3 h-3" />
                        ALERTA
                      </span>
                    ) : item.status === 'pending' ? (
                      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/20 text-[9px] font-mono font-bold text-cyan-400">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        TESTANDO
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-500/10 border border-rose-500/20 text-[9px] font-mono font-bold text-rose-400">
                        <AlertOctagon className="w-3 h-3" />
                        OFFLINE
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {sandboxLog && (
            <div className="mt-3.5 p-2 bg-slate-950 border border-slate-850 rounded text-[9px] font-mono text-cyan-500/90 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400 shrink-0" />
              <span className="truncate">{sandboxLog}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
