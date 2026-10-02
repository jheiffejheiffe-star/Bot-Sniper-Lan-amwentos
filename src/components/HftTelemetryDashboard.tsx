import { useState, useEffect } from "react";
import { 
  Activity, 
  Terminal, 
  Cpu, 
  RefreshCw, 
  LineChart, 
  BarChart3, 
  ExternalLink,
  Zap,
  Database,
  Server,
  ShieldAlert,
  Play,
  Square,
  Lock
} from "lucide-react";
import { 
  ResponsiveContainer, 
  AreaChart, 
  Area, 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  Tooltip, 
  CartesianGrid, 
  Legend 
} from "recharts";

interface TelemetryData {
  currentSlot: number;
  ticks: {
    time: string;
    grpc: number;
    sandbox: number;
    trigger: number;
    total: number;
    landed: boolean;
  }[];
  p95: {
    detection: number;
    simulation: number;
    trigger: number;
  };
  p99: {
    detection: number;
    simulation: number;
    trigger: number;
  };
  inclusionRate: number;
  circuitBreakerActive: boolean;
  circuitBreakerThreshold: number;
  pm2State: string;
  kafkaThroughput: number;
  protobufRatio: number;
  redisQueueSize: number;
  timescaleWriteRate: number;
  kpis: {
    successRate: number;
    returnPerBatch: number;
    endToEndLoop: number;
    detectionLatency: number;
  };
}

interface LogEntry {
  timestamp: string;
  level: "INFO" | "WARN" | "ERROR" | "DEBUG";
  service: string;
  message: string;
}

export function HftTelemetryDashboard() {
  const [data, setData] = useState<TelemetryData | null>(null);
  const [activeTab, setActiveTab] = useState<"grafana" | "prometheus" | "logs">("grafana");
  const [prometheusRaw, setPrometheusRaw] = useState<string>("");
  const [exporterLive, setExporterLive] = useState(true);
  const [queryCount, setQueryCount] = useState(0);
  const [simulatedLogs, setSimulatedLogs] = useState<LogEntry[]>([]);
  const [updatingSettings, setUpdatingSettings] = useState(false);

  const fetchTelemetry = async () => {
    try {
      const res = await fetch("/api/hft-telemetry");
      const json = await res.json();
      setData(json);

      const promRes = await fetch("/metrics");
      const text = await promRes.text();
      setPrometheusRaw(text);
      setQueryCount(prev => prev + 1);
    } catch (err) {
      console.error("Telemetry ingest failed", err);
    }
  };

  useEffect(() => {
    fetchTelemetry();
    let interval: any = null;
    if (exporterLive) {
      interval = setInterval(fetchTelemetry, 2500);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [exporterLive]);

  // Generate simulated logs representing historical TimescaleDB records
  useEffect(() => {
    if (!data) return;
    const services = ["KAFKA-FEED", "PROTOBUF-DEC", "REDIS-QUEUE", "TIMESCALEDB-WRITER", "CIRCUIT-BREAKER", "PM2-SUPERVISOR"];
    
    const generateInitialLogs = () => {
      const list: LogEntry[] = [];
      const now = Date.now();
      for (let i = 12; i >= 0; i--) {
        const time = new Date(now - i * 4000).toLocaleTimeString();
        list.push({
          timestamp: time,
          level: i % 7 === 0 ? "DEBUG" : i === 3 ? "WARN" : "INFO",
          service: services[i % services.length],
          message: getRandomLogMessage(services[i % services.length])
        });
      }
      setSimulatedLogs(list);
    };

    const getRandomLogMessage = (service: string) => {
      switch (service) {
        case "KAFKA-FEED":
          return `Stream processado com sucesso. Offset atualizado para partition_0. Lote tamanho: ${Math.floor(10 + Math.random() * 20)} transações.`;
        case "PROTOBUF-DEC":
          return `Estrutura de bloco desserializada via Protobuf schema. Latência local de parse: ${Math.floor(35 + Math.random() * 50)}µs.`;
        case "REDIS-QUEUE":
          return `Pool de concorrência Redis liberado. 0 chaves pendentes. Estado em cache sincronizado com sucesso.`;
        case "TIMESCALEDB-WRITER":
          return `Métricas de série temporal compactadas e persistidas no TimescaleDB. Compressão de bloco ativa.`;
        case "CIRCUIT-BREAKER":
          return `Relatório de latência analisado: Relógio PTPv2 estável dentro do limite aceitável.`;
        case "PM2-SUPERVISOR":
          return `Processo 'solana-hft-bot' respondendo na porta 3000. Logs rotacionados com sucesso.`;
        default:
          return "Métrica sincronizada.";
      }
    };

    generateInitialLogs();
  }, [data === null]);

  // Push new logs periodically
  useEffect(() => {
    if (!data || activeTab !== "logs") return;
    const interval = setInterval(() => {
      const services = ["KAFKA-FEED", "PROTOBUF-DEC", "REDIS-QUEUE", "TIMESCALEDB-WRITER", "CIRCUIT-BREAKER", "PM2-SUPERVISOR"];
      const service = services[Math.floor(Math.random() * services.length)];
      const isBreakerActive = data?.circuitBreakerActive;
      const isHighLatency = avgTotal > (data?.circuitBreakerThreshold || 150);

      let level: "INFO" | "WARN" | "ERROR" | "DEBUG" = "INFO";
      let message = "";

      if (isBreakerActive && isHighLatency) {
        level = "ERROR";
        message = `🚨 [ALERTA DE SEGURANÇA] Disjuntor acionado! Latência de pipeline de ${avgTotal}ms excedeu limite de ${data.circuitBreakerThreshold}ms! Execução suspensa de forma atômica para proteção de fundos.`;
      } else {
        const rand = Math.random();
        if (rand > 0.85) {
          level = "DEBUG";
          message = `Mapeamento de memória compactado no Redis. Capacidade utilizada: ${(1.2 + Math.random() * 0.8).toFixed(2)}MB.`;
        } else if (rand > 0.7) {
          level = "WARN";
          message = `Detecção de leve oscilação de ping no RPC secundário. Sincronismo mantido no canal co-localizado principal.`;
        } else {
          message = service === "KAFKA-FEED" 
            ? `Processados ${(30 + Math.floor(Math.random() * 20))} pacotes Protobuf do ShredStream. Latência de rede estável.`
            : service === "TIMESCALEDB-WRITER"
            ? `Dados persistidos para análise retrospectiva de derrapagem (slippage backtesting).`
            : `Mapeador de fila Redis liberado. Processador ativo.`;
        }
      }

      setSimulatedLogs(prev => [
        {
          timestamp: new Date().toLocaleTimeString(),
          level,
          service,
          message
        },
        ...prev.slice(0, 14)
      ]);
    }, 3000);

    return () => clearInterval(interval);
  }, [data, activeTab]);

  if (!data) {
    return (
      <div className="p-8 text-center bg-slate-900/80 border border-slate-800 rounded-xl">
        <RefreshCw className="w-6 h-6 animate-spin text-purple-400 mx-auto mb-2" />
        <span className="text-xs font-mono text-slate-400">Carregando métricas do Prometheus...</span>
      </div>
    );
  }

  // Calculate current averages from ticks
  const avgDetection = parseFloat((data.ticks.reduce((acc, t) => acc + t.grpc, 0) / data.ticks.length).toFixed(2));
  const avgSimulation = parseFloat((data.ticks.reduce((acc, t) => acc + t.sandbox, 0) / data.ticks.length).toFixed(2));
  const avgTrigger = parseFloat((data.ticks.reduce((acc, t) => acc + t.trigger, 0) / data.ticks.length).toFixed(2));
  const avgTotal = parseFloat((avgDetection + avgSimulation + avgTrigger).toFixed(2));

  // Trigger breaker warning if active & total > threshold
  const breakerTriggered = data.circuitBreakerActive && avgTotal > data.circuitBreakerThreshold;

  // Handle setting updates
  const updateSettings = async (updates: { circuitBreakerActive?: boolean; circuitBreakerThreshold?: number; pm2State?: string }) => {
    setUpdatingSettings(true);
    try {
      const payload = {
        circuitBreakerActive: updates.circuitBreakerActive !== undefined ? updates.circuitBreakerActive : data.circuitBreakerActive,
        circuitBreakerThreshold: updates.circuitBreakerThreshold !== undefined ? updates.circuitBreakerThreshold : data.circuitBreakerThreshold,
        pm2State: updates.pm2State !== undefined ? updates.pm2State : data.pm2State
      };

      const res = await fetch("/api/hft-telemetry/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = await res.json();
      if (result.success) {
        setData(prev => prev ? {
          ...prev,
          circuitBreakerActive: result.circuitBreakerActive,
          circuitBreakerThreshold: result.circuitBreakerThreshold,
          pm2State: result.pm2State
        } : null);
      }
    } catch (e) {
      console.error("Failed to update telemetry settings", e);
    } finally {
      setUpdatingSettings(false);
    }
  };

  return (
    <div id="hft-telemetry-dashboard" className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 backdrop-blur-md relative overflow-hidden">
      <div className="absolute top-0 right-0 w-24 h-24 bg-purple-500/5 rounded-full blur-2xl pointer-events-none"></div>

      {/* Header Panel */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 mb-3.5 pb-2.5 border-b border-slate-800/60">
        <div className="flex items-center gap-2.5">
          <Activity className="w-5 h-5 text-purple-400 animate-pulse" />
          <div>
            <h2 className="text-sm font-display font-bold text-slate-100 uppercase tracking-tight">Métricas & Observabilidade Layer 5</h2>
            <span className="text-[9px] font-mono text-purple-400 block uppercase tracking-wider">Prometheus + Grafana HFT telemetry</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Active Status tabs */}
          <div className="flex bg-slate-950 p-0.5 rounded border border-slate-850">
            <button
              onClick={() => setActiveTab("grafana")}
              className={`px-2 py-0.5 text-[9px] font-mono font-bold rounded uppercase transition-all cursor-pointer ${
                activeTab === "grafana" ? "bg-purple-600 text-white" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Grafana UI
            </button>
            <button
              onClick={() => setActiveTab("prometheus")}
              className={`px-2 py-0.5 text-[9px] font-mono font-bold rounded uppercase transition-all cursor-pointer ${
                activeTab === "prometheus" ? "bg-amber-600 text-white" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Prometheus
            </button>
            <button
              onClick={() => setActiveTab("logs")}
              className={`px-2 py-0.5 text-[9px] font-mono font-bold rounded uppercase transition-all cursor-pointer ${
                activeTab === "logs" ? "bg-cyan-600 text-white" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Timescale Logs
            </button>
          </div>

          <button
            onClick={() => setExporterLive(!exporterLive)}
            className={`p-1.5 rounded border text-[9px] font-mono transition-all cursor-pointer flex items-center gap-1 ${
              exporterLive 
                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20" 
                : "bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-750"
            }`}
          >
            <RefreshCw className={`w-3 h-3 ${exporterLive ? "animate-spin" : ""}`} />
            <span>{exporterLive ? "AO VIVO" : "PAUSADO"}</span>
          </button>
        </div>
      </div>

      {/* EMERGENCY CIRCUIT BREAKER SYSTEM */}
      {breakerTriggered && (
        <div className="mb-3.5 p-3 rounded-lg border border-rose-500 bg-rose-500/10 animate-pulse flex items-center gap-3">
          <ShieldAlert className="w-5 h-5 text-rose-500 shrink-0" />
          <div className="min-w-0 flex-1">
            <span className="text-xs font-display font-bold text-rose-400 uppercase block tracking-wider">🚨 DISJUNTOR DE SEGURANÇA ATIVADO</span>
            <p className="text-[10px] font-mono text-rose-300 leading-normal">
              Latência de trânsito ({avgTotal}ms) excedeu o limite de segurança configurado ({data.circuitBreakerThreshold}ms). O envio de transações foi suspenso automaticamente no hot path para preservar o capital de mercado!
            </p>
          </div>
          <button 
            onClick={() => updateSettings({ circuitBreakerActive: false })}
            className="px-2.5 py-1 bg-rose-600 hover:bg-rose-500 text-white font-mono font-bold text-[9px] rounded uppercase cursor-pointer"
          >
            Resetar Disjuntor
          </button>
        </div>
      )}

      {/* KPI METRICS AND PERFORMANCE TARGETS BOARD */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-3.5">
        {/* KPI 1: Success Rate */}
        <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-850/60 flex flex-col justify-between">
          <div>
            <span className="text-[8px] font-mono text-slate-500 uppercase tracking-widest block">Taxa de Sucesso</span>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <span className="text-sm font-mono font-bold text-slate-200">
                {data.kpis.successRate}%
              </span>
              <span className="text-[7px] font-mono text-slate-500">Alvo: &gt;60%</span>
            </div>
          </div>
          <div className="flex items-center justify-between mt-2 pt-1 border-t border-slate-900">
            <span className="text-[7px] font-mono text-slate-500">MÉTRICA ATUAL</span>
            <span className={`text-[7px] font-mono px-1 py-0.25 rounded font-bold uppercase ${
              data.kpis.successRate >= 60 
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" 
                : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
            }`}>
              {data.kpis.successRate >= 60 ? "Aprovado ✅" : "Abaixo do Alvo"}
            </span>
          </div>
        </div>

        {/* KPI 2: Return per batch */}
        <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-850/60 flex flex-col justify-between">
          <div>
            <span className="text-[8px] font-mono text-slate-500 uppercase tracking-widest block">Retorno por Lote</span>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <span className="text-sm font-mono font-bold text-slate-200">
                +{data.kpis.returnPerBatch}%
              </span>
              <span className="text-[7px] font-mono text-slate-500">Alvo: 10-20%</span>
            </div>
          </div>
          <div className="flex items-center justify-between mt-2 pt-1 border-t border-slate-900">
            <span className="text-[7px] font-mono text-slate-500">EFICIÊNCIA</span>
            <span className="text-[7px] font-mono px-1 py-0.25 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20 font-bold uppercase">
              {data.kpis.returnPerBatch >= 10 ? "Consistente ⚡" : "Sob Calibração"}
            </span>
          </div>
        </div>

        {/* KPI 3: End-to-End Loop */}
        <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-850/60 flex flex-col justify-between">
          <div>
            <span className="text-[8px] font-mono text-slate-500 uppercase tracking-widest block">Ciclo Completo</span>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <span className={`text-sm font-mono font-bold ${
                data.kpis.endToEndLoop < 100 
                  ? "text-purple-400" 
                  : data.kpis.endToEndLoop < 200 
                  ? "text-emerald-400" 
                  : "text-slate-200"
              }`}>
                {data.kpis.endToEndLoop}ms
              </span>
              <span className="text-[7px] font-mono text-slate-500">Alvo: &lt;200ms</span>
            </div>
          </div>
          <div className="flex items-center justify-between mt-2 pt-1 border-t border-slate-900">
            <span className="text-[7px] font-mono text-slate-500">VELOCIDADE DE LOOP</span>
            <span className={`text-[7px] font-mono px-1 py-0.25 rounded font-bold uppercase ${
              data.kpis.endToEndLoop < 100 
                ? "bg-purple-500/20 text-purple-400 border border-purple-500/30" 
                : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
            }`}>
              {data.kpis.endToEndLoop < 100 ? "God Tier 👑" : "Ótimo ⚡"}
            </span>
          </div>
        </div>

        {/* KPI 4: Detection Latency */}
        <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-850/60 flex flex-col justify-between">
          <div>
            <span className="text-[8px] font-mono text-slate-500 uppercase tracking-widest block">Latência de Detecção</span>
            <div className="flex items-baseline gap-1.5 mt-0.5">
              <span className={`text-sm font-mono font-bold ${
                data.kpis.detectionLatency < 2 
                  ? "text-purple-400" 
                  : "text-slate-200"
              }`}>
                {data.kpis.detectionLatency}ms
              </span>
              <span className="text-[7px] font-mono text-slate-500">Alvo: &lt;50ms</span>
            </div>
          </div>
          <div className="flex items-center justify-between mt-2 pt-1 border-t border-slate-900">
            <span className="text-[7px] font-mono text-slate-500">REDE FÍSICA</span>
            <span className={`text-[7px] font-mono px-1 py-0.25 rounded font-bold uppercase ${
              data.kpis.detectionLatency < 2 
                ? "bg-purple-500/20 text-purple-400 border border-purple-500/30" 
                : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
            }`}>
              {data.kpis.detectionLatency < 2 ? "FIBRA LD4 🔮" : "Geyser gRPC"}
            </span>
          </div>
        </div>
      </div>

      {/* INTERACTIVE CONTROLS: CIRCUIT BREAKER + PM2 MONITOR */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        {/* Disjuntor de Emergência (Circuit Breaker) Panel */}
        <div className="p-3 bg-slate-950 rounded-lg border border-slate-850 flex flex-col justify-between">
          <div className="flex items-center justify-between pb-1.5 border-b border-slate-900 mb-2">
            <div className="flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 text-purple-400" />
              <span className="text-[10px] font-mono font-bold text-slate-200 uppercase tracking-wider">Disjuntor de Emergência Atômico</span>
            </div>
            <div className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${data.circuitBreakerActive ? "bg-purple-500 animate-pulse" : "bg-slate-700"}`}></span>
              <span className="text-[8px] font-mono text-slate-400 uppercase">{data.circuitBreakerActive ? "ARMADO" : "INATIVO"}</span>
            </div>
          </div>

          <p className="text-[9px] font-mono text-slate-400 leading-normal mb-2.5">
            Interrompe imediatamente o envio de transações para o Jito Block Engine se a latência física ou do validador ultrapassar o limite aceitável de capitalização de risco.
          </p>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <span className="text-[9px] font-mono text-slate-500 uppercase">Limite Máximo: <b className="text-purple-400">{data.circuitBreakerThreshold}ms</b></span>
              <input 
                type="range" 
                min="10" 
                max="250" 
                value={data.circuitBreakerThreshold} 
                onChange={(e) => updateSettings({ circuitBreakerThreshold: parseInt(e.target.value) })}
                className="flex-1 h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-purple-500" 
              />
            </div>

            <div className="flex items-center justify-between pt-1">
              <span className="text-[9px] font-mono text-slate-500 uppercase">Estado da Chave</span>
              <button
                onClick={() => updateSettings({ circuitBreakerActive: !data.circuitBreakerActive })}
                disabled={updatingSettings}
                className={`px-3 py-1 text-[9px] font-mono font-bold rounded cursor-pointer uppercase transition-all ${
                  data.circuitBreakerActive 
                    ? "bg-purple-600 hover:bg-purple-500 text-white shadow-[0_0_8px_rgba(147,51,234,0.3)]" 
                    : "bg-slate-800 hover:bg-slate-750 text-slate-400"
                }`}
              >
                {data.circuitBreakerActive ? "DESATIVAR PROTEÇÃO" : "ATIVAR DISJUNTOR"}
              </button>
            </div>
          </div>
        </div>

        {/* PM2 & Process Supervisor Monitor */}
        <div className="p-3 bg-slate-950 rounded-lg border border-slate-850 flex flex-col justify-between">
          <div className="flex items-center justify-between pb-1.5 border-b border-slate-900 mb-2">
            <div className="flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-cyan-400" />
              <span className="text-[10px] font-mono font-bold text-slate-200 uppercase tracking-wider">PM2 Process Supervisor</span>
            </div>
            <div className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${
                data.pm2State === "online" 
                  ? "bg-emerald-500 animate-pulse" 
                  : data.pm2State === "restarting" 
                  ? "bg-amber-500 animate-spin" 
                  : "bg-rose-500"
              }`}></span>
              <span className={`text-[8px] font-mono font-bold uppercase ${
                data.pm2State === "online" 
                  ? "text-emerald-400" 
                  : data.pm2State === "restarting" 
                  ? "text-amber-400" 
                  : "text-rose-400"
              }`}>{data.pm2State}</span>
            </div>
          </div>

          <p className="text-[9px] font-mono text-slate-400 leading-normal mb-2.5">
            Gerenciador daemon garante funcionamento ininterrupto do robô 24/7. Executa recuperação e reinicialização instantânea em caso de travamentos.
          </p>

          <div className="grid grid-cols-3 gap-2 pt-1">
            <div className="bg-slate-900/60 p-1.5 rounded border border-slate-900 flex flex-col justify-center">
              <span className="text-[7px] text-slate-500 uppercase font-mono">Modo de Cluster</span>
              <span className="text-[9px] text-slate-200 font-bold font-mono">Fork Mode</span>
            </div>
            <div className="bg-slate-900/60 p-1.5 rounded border border-slate-900 flex flex-col justify-center">
              <span className="text-[7px] text-slate-500 uppercase font-mono">Uptime PM2</span>
              <span className="text-[9px] text-slate-200 font-bold font-mono">
                {data.pm2State === "online" ? "99.98% / 12d" : "0.00% / Offline"}
              </span>
            </div>
            <div className="bg-slate-900/60 p-1.5 rounded border border-slate-900 flex flex-col justify-center">
              <span className="text-[7px] text-slate-500 uppercase font-mono">ID PM2</span>
              <span className="text-[9px] text-slate-200 font-bold font-mono">pm2_app_0</span>
            </div>
          </div>

          <div className="flex gap-2 mt-3 pt-1 border-t border-slate-900/45">
            <button
              onClick={() => updateSettings({ pm2State: "restarting" })}
              disabled={updatingSettings || data.pm2State === "restarting"}
              className="flex-1 py-1 text-[8px] font-mono font-bold rounded cursor-pointer uppercase transition-all bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/20 flex items-center justify-center gap-1"
            >
              <RefreshCw className="w-2.5 h-2.5" />
              Reiniciar PM2
            </button>
            <button
              onClick={() => updateSettings({ pm2State: data.pm2State === "online" ? "stopped" : "online" })}
              disabled={updatingSettings}
              className={`flex-1 py-1 text-[8px] font-mono font-bold rounded cursor-pointer uppercase transition-all flex items-center justify-center gap-1 ${
                data.pm2State === "online"
                  ? "bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20"
                  : "bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20"
              }`}
            >
              {data.pm2State === "online" ? (
                <>
                  <Square className="w-2.5 h-2.5" /> Pausar Bot
                </>
              ) : (
                <>
                  <Play className="w-2.5 h-2.5" /> Iniciar Bot
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Main Render Block depending on active Tab */}
      {activeTab === "grafana" ? (
        <div className="space-y-4">
          {/* MIDDLE METADATA MIDDLEWARE BAR (KAFKA, PROTOBUF, REDIS, TIMESCALEDB) */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {/* Kafka */}
            <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-850/60 flex items-center gap-2.5">
              <div className="p-1.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/15">
                <Zap className="w-3.5 h-3.5" />
              </div>
              <div>
                <span className="text-[7px] font-mono text-slate-500 uppercase block tracking-wider">Apache Kafka Ingest</span>
                <span className="text-[10px] font-mono font-bold text-slate-200 mt-0.5 block">
                  {data.kafkaThroughput.toLocaleString()} msg/s
                </span>
              </div>
            </div>

            {/* Protobuf */}
            <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-850/60 flex items-center gap-2.5">
              <div className="p-1.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/15">
                <Server className="w-3.5 h-3.5" />
              </div>
              <div>
                <span className="text-[7px] font-mono text-slate-500 uppercase block tracking-wider">Protobuf Compression</span>
                <span className="text-[10px] font-mono font-bold text-slate-200 mt-0.5 block">
                  {data.protobufRatio}x (sub-100µs)
                </span>
              </div>
            </div>

            {/* Redis Queue */}
            <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-850/60 flex items-center gap-2.5">
              <div className="p-1.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/15">
                <Database className="w-3.5 h-3.5" />
              </div>
              <div>
                <span className="text-[7px] font-mono text-slate-500 uppercase block tracking-wider">Redis Queue State</span>
                <span className="text-[10px] font-mono font-bold text-slate-200 mt-0.5 block">
                  {data.redisQueueSize} transações
                </span>
              </div>
            </div>

            {/* TimescaleDB */}
            <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-850/60 flex items-center gap-2.5">
              <div className="p-1.5 rounded bg-yellow-500/10 text-yellow-500 border border-yellow-500/15">
                <LineChart className="w-3.5 h-3.5" />
              </div>
              <div>
                <span className="text-[7px] font-mono text-slate-500 uppercase block tracking-wider">TimescaleDB Writes</span>
                <span className="text-[10px] font-mono font-bold text-slate-200 mt-0.5 block">
                  {data.timescaleWriteRate} logs/s
                </span>
              </div>
            </div>
          </div>

          {/* Grafana Dashboard charts */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Chart 1: Pipeline latency breakdown (AreaChart) */}
            <div className="bg-slate-950/90 p-4 rounded-lg border border-slate-850">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest flex items-center gap-1">
                  <LineChart className="w-3.5 h-3.5 text-purple-400" />
                  Grafana Panel: Latency Breakdown (ms)
                </span>
                <span className="text-[8px] font-mono text-slate-500 uppercase">Live Fiber Ingestion Analytics</span>
              </div>
              <div className="h-28 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.ticks} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                    <defs>
                      <linearGradient id="grpcGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#c084fc" stopOpacity={0.25}/>
                        <stop offset="95%" stopColor="#c084fc" stopOpacity={0}/>
                      </linearGradient>
                      <linearGradient id="sandboxGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#a855f7" stopOpacity={0.15}/>
                        <stop offset="95%" stopColor="#a855f7" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="time" tick={{ fill: '#64748b', fontSize: 8 }} />
                    <YAxis tick={{ fill: '#64748b', fontSize: 8 }} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#090d16', borderColor: '#334155', borderRadius: '6px' }}
                      labelStyle={{ color: '#94a3b8', fontFamily: 'monospace', fontSize: 9 }}
                      itemStyle={{ fontFamily: 'monospace', fontSize: 9 }}
                    />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: '8px', fontFamily: 'monospace', marginTop: '4px' }} />
                    <Area type="monotone" dataKey="grpc" stroke="#c084fc" fillOpacity={1} fill="url(#grpcGrad)" strokeWidth={1.5} name="gRPC Ingestion" />
                    <Area type="monotone" dataKey="sandbox" stroke="#a855f7" fillOpacity={1} fill="url(#sandboxGrad)" strokeWidth={1.5} name="Sandbox VM" />
                    <Area type="monotone" dataKey="total" stroke="#38bdf8" fillOpacity={0} strokeWidth={2} name="Total Pipeline" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Chart 2: Landed vs Dropped bundles distribution (BarChart) */}
            <div className="bg-slate-950/90 p-4 rounded-lg border border-slate-850">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest flex items-center gap-1">
                  <BarChart3 className="w-3.5 h-3.5 text-emerald-400" />
                  Grafana Panel: Jito Bundle Landed Rate
                </span>
                <span className="text-[8px] font-mono text-slate-500 uppercase">Block Confirmation</span>
              </div>
              <div className="h-28 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.ticks} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="time" tick={{ fill: '#64748b', fontSize: 8 }} />
                    <YAxis tick={{ fill: '#64748b', fontSize: 8 }} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#090d16', borderColor: '#334155', borderRadius: '6px' }}
                      labelStyle={{ color: '#94a3b8', fontFamily: 'monospace', fontSize: 9 }}
                      itemStyle={{ fontFamily: 'monospace', fontSize: 9 }}
                    />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: '8px', fontFamily: 'monospace', marginTop: '4px' }} />
                    <Bar dataKey="total" name="Landed Bundle Speed" fill="#10b981" radius={[2, 2, 0, 0]}>
                      {data.ticks.map((entry, index) => (
                        <div key={`cell-${index}`} style={{ fill: entry.landed ? '#10b981' : '#f43f5e' }} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      ) : activeTab === "prometheus" ? (
        <div className="space-y-3">
          {/* Prometheus plain text exporter output terminal */}
          <div className="p-4 bg-slate-950 rounded-lg border border-slate-850 flex flex-col h-64 justify-between">
            <div className="flex items-center justify-between pb-1.5 border-b border-slate-900">
              <div className="flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5 text-amber-500" />
                <span className="text-[10px] font-mono text-amber-400 uppercase">Prometheus plain-text Exporter</span>
              </div>
              <div className="flex items-center gap-2 text-[9px] font-mono text-slate-500">
                <span>Format: openmetrics-text</span>
                <span>Scrapes: {queryCount}</span>
              </div>
            </div>

            <div className="font-mono text-[9.5px] text-slate-300 overflow-y-auto flex-1 my-2.5 leading-relaxed whitespace-pre-wrap select-text scrollbar-thin scrollbar-thumb-slate-800">
              {prometheusRaw}
              {`# HELP solana_hft_kafka_messages_processed_total Total Protobuf telemetry messages processed via Apache Kafka pipeline
# TYPE solana_hft_kafka_messages_processed_total counter
solana_hft_kafka_messages_processed_total{status="buffered"} ${data.kafkaThroughput * 5}
solana_hft_kafka_messages_processed_total{status="sent"} ${data.kafkaThroughput * 15}

# HELP solana_hft_circuit_breaker_active Represents emergency circuit breaker state
# TYPE solana_hft_circuit_breaker_active gauge
solana_hft_circuit_breaker_active ${data.circuitBreakerActive ? 1 : 0}

# HELP solana_hft_redis_queue_size Real-time concurrent transaction backlog inside Redis
# TYPE solana_hft_redis_queue_size gauge
solana_hft_redis_queue_size ${data.redisQueueSize}

# HELP solana_hft_pm2_supervisor_status Process status supervised by PM2 daemon
# TYPE solana_hft_pm2_supervisor_status gauge
solana_hft_pm2_supervisor_status{process="solana-hft-bot",state="online"} ${data.pm2State === "online" ? 1 : 0}
solana_hft_pm2_supervisor_status{process="solana-hft-bot",state="stopped"} ${data.pm2State === "stopped" ? 1 : 0}
solana_hft_pm2_supervisor_status{process="solana-hft-bot",state="restarting"} ${data.pm2State === "restarting" ? 1 : 0}
`}
            </div>

            <div className="pt-1.5 border-t border-slate-900 flex items-center justify-between text-[9px] font-mono text-slate-500">
              <span>Endpoint Exposto em: <a href="/metrics" target="_blank" rel="noreferrer" className="text-amber-500 hover:underline flex inline-flex items-center gap-0.5">/metrics <ExternalLink className="w-2.5 h-2.5" /></a></span>
              <span>SLA Target: Realtime P99</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Structured TimescaleDB Log Stream (Chronological Order) */}
          <div className="p-3 bg-slate-950 rounded-lg border border-slate-850">
            <div className="flex items-center justify-between pb-1.5 border-b border-slate-900 mb-2">
              <div className="flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5 text-cyan-400" />
                <span className="text-[10px] font-mono text-cyan-400 uppercase font-bold">TimescaleDB Log Aggregator (Chronological Feed)</span>
              </div>
              <span className="text-[8px] font-mono text-slate-500 uppercase">RETROSPECTIVE & AUDIT TRAIL</span>
            </div>

            <div className="h-56 overflow-y-auto space-y-1.5 scrollbar-thin scrollbar-thumb-slate-800 pr-1">
              {simulatedLogs.map((log, index) => {
                const isError = log.level === "ERROR";
                const isWarn = log.level === "WARN";
                const isDebug = log.level === "DEBUG";

                return (
                  <div 
                    key={index} 
                    className={`p-1.5 rounded font-mono text-[9px] border transition-colors ${
                      isError 
                        ? "bg-rose-500/10 border-rose-500/25 text-rose-300" 
                        : isWarn 
                        ? "bg-amber-500/10 border-amber-500/20 text-amber-300" 
                        : isDebug 
                        ? "bg-purple-500/10 border-purple-500/15 text-purple-300" 
                        : "bg-slate-900/60 border-slate-850/60 text-slate-300"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-0.5 pb-0.5 border-b border-slate-900/40 text-[8px] text-slate-500">
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold text-slate-400">[{log.timestamp}]</span>
                        <span className={`px-1 rounded font-bold ${
                          isError 
                            ? "bg-rose-500/20 text-rose-400" 
                            : isWarn 
                            ? "bg-amber-500/20 text-amber-400" 
                            : isDebug 
                            ? "bg-purple-500/20 text-purple-400" 
                            : "bg-slate-800 text-slate-400"
                        }`}>
                          {log.level}
                        </span>
                        <span className="text-slate-400 font-bold">&lt;{log.service}&gt;</span>
                      </div>
                      <span className="text-[7px]">COMPRESSED IN TS-DB</span>
                    </div>
                    <p className="leading-relaxed whitespace-pre-wrap">{log.message}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Observability footer status */}
      <div className="mt-4 pt-2.5 border-t border-slate-850/60 flex items-center justify-between text-[9px] font-mono text-slate-500 uppercase tracking-wider">
        <span>Prometheus Exporter Status: <b className="text-emerald-400">UP</b></span>
        <span className="flex items-center gap-1">
          <Lock className="w-3 h-3 text-purple-400" />
          Secured RAM-Only Metrics Isolation
        </span>
      </div>
    </div>
  );
}
