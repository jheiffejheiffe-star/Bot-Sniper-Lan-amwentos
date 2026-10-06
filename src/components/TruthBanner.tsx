import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, ShieldCheck } from "lucide-react";

/**
 * BANNER DE VERDADE — o que neste painel é MEDIÇÃO e o que é SIMULAÇÃO.
 *
 * Por que existe: vários painéis desta interface exibem números plausíveis que são gerados
 * com `Math.random()` NO SERVIDOR (latências, inclusion rate, score preditivo, "geyser
 * stream", veredito de bundle). Sem uma declaração visível, esses números são lidos como
 * desempenho medido — e uma decisão de capital tomada sobre número aleatório é pior do que
 * nenhuma decisão.
 *
 * O que este componente NÃO faz: esconder os painéis simulados. Ele declara o status de
 * cada fonte (dado real / número aleatório / indisponível) para que a leitura seja honesta,
 * e mostra o resumo do que está de fato ligado nesta instalação.
 *
 * Fonte dos dados: GET /api/system-truth (o próprio servidor enumera o que é RNG).
 */
export default function TruthBanner() {
  const [truth, setTruth] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/system-truth");
      if (!res.ok) {
        setError(`HTTP ${res.status} em /api/system-truth`);
        return;
      }
      setTruth(await res.json());
      setError(null);
    } catch (err: any) {
      // Sem leitura, este banner NÃO inventa um estado: declara a falha.
      setError(err?.message ?? "falha ao consultar /api/system-truth");
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  if (error) {
    return (
      <div className="bg-red-950/60 border-b border-red-800/60 px-4 py-2 text-[11px] text-red-200 flex items-center gap-2">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        <span>
          Não foi possível ler o status de veracidade do painel ({error}). Trate TODOS os números desta
          tela como <strong>não verificados</strong> até esta consulta responder.
        </span>
      </div>
    );
  }

  if (!truth) {
    return (
      <div className="bg-slate-900/70 border-b border-slate-800 px-4 py-2 text-[11px] text-slate-400">
        Verificando quais fontes deste painel são medição real…
      </div>
    );
  }

  const simulated: Array<{ path: string; why: string }> = truth.simulatedEndpoints ?? [];
  const real: Array<{ source: string; status: string; detail: string; caveat: string }> =
    truth.realSources ?? [];
  const hasSimulation = simulated.length > 0;

  return (
    <div
      className={`border-b text-[11px] ${
        hasSimulation ? "bg-amber-950/50 border-amber-800/60 text-amber-100" : "bg-emerald-950/40 border-emerald-800/50 text-emerald-100"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-2 flex items-center gap-2 text-left hover:bg-white/5 transition-colors"
      >
        {hasSimulation ? (
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        ) : (
          <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
        )}
        <span className="flex-1">
          <strong>
            {hasSimulation
              ? `${simulated.length} painel(is) desta tela são SIMULAÇÃO (números aleatórios no servidor)`
              : "Nenhuma fonte simulada declarada"}
          </strong>
          {" — "}
          {truth.summary?.liveExecutionPath ?? "caminho de execução real: não verificado"}
        </span>
        {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>

      {open && (
        <div className="px-4 pb-3 grid gap-3 md:grid-cols-2">
          <div>
            <div className="uppercase tracking-wide text-[10px] opacity-70 mb-1">
              Fontes com dado REAL desta instalação
            </div>
            <ul className="space-y-1">
              {real.map((s) => (
                <li key={s.source} className="flex gap-2">
                  <span className="shrink-0">{s.status === "real" ? "✅" : s.status === "unavailable" ? "⚠️" : "ℹ️"}</span>
                  <span>
                    <strong>{s.source}</strong>: {s.detail}
                    <span className="opacity-70"> — {s.caveat}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="uppercase tracking-wide text-[10px] opacity-70 mb-1">
              Painéis SIMULADOS (não usar como métrica)
            </div>
            <ul className="space-y-1">
              {simulated.map((s) => (
                <li key={s.path}>
                  <code className="opacity-90">{s.path}</code>: <span className="opacity-80">{s.why}</span>
                </li>
              ))}
              {simulated.length === 0 && <li>Nenhum.</li>}
            </ul>
            <div className="mt-2 opacity-80">
              Relatórios de desempenho que misturam estes números com PnL real são inválidos por construção.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
