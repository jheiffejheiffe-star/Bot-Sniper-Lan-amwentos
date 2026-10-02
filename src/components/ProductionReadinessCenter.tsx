import { useState, useEffect } from "react";
import { 
  Server, 
  Activity, 
  ShieldCheck, 
  AlertTriangle, 
  RotateCcw, 
  FileText, 
  Play, 
  XCircle, 
  CheckCircle2, 
  RefreshCw, 
  Zap, 
  Download,
  Terminal,
  Cpu,
  Trash2,
  Clock
} from "lucide-react";

interface OperationalIncident {
  id: string;
  time: string;
  severity: "low" | "medium" | "high" | "critical";
  service: string;
  description: string;
  status: "active" | "mitigated" | "resolved";
}

interface DeployLog {
  time: string;
  level: "INFO" | "SUCCESS" | "WARN" | "ERROR";
  message: string;
}

export function ProductionReadinessCenter() {
  // Master Operational Pipeline States:
  // "deploy" | "prr" | "golive" | "health" | "latency" | "rollback" | "incidents" | "reports"
  const [activeTab, setActiveTab] = useState<"deploy" | "prr" | "golive" | "health" | "latency" | "rollback" | "incidents" | "reports">("latency");

  // General Operation State
  const [deployStep, setDeployStep] = useState<number>(0); // 0: Idle, 1: Building, 2: Bundling, 3: Simulating Landing, 4: Live on Mainnet
  const [isDeploying, setIsDeploying] = useState<boolean>(false);
  const [prrAuditPassed, setPrrAuditPassed] = useState<boolean>(true); // Queries or assumes L13 audit passes
  const [isLivePromoted, setIsLivePromoted] = useState<boolean>(false);
  const [promotionProgress, setPromotionProgress] = useState<number>(0);
  const [isPromoting, setIsPromoting] = useState<boolean>(false);
  
  // Real-time Health Metrics States
  const [eventLoopLag, setEventLoopLag] = useState<number>(0.12);
  const [ramUsage, setRamUsage] = useState<number>(242); // in MB
  const [grpcLatency, setGrpcLatency] = useState<number>(1.25); // ms
  const [rpcSuccessRate, setRpcSuccessRate] = useState<number>(100.0);
  const [isHealthDegraded, setIsHealthDegraded] = useState<boolean>(false);

  // Latency Check-up States (L14 Sovereignty of Milliseconds)
  const [latencyCheckRunning, setLatencyCheckRunning] = useState<boolean>(false);
  const [latencyCheckProgress, setLatencyCheckProgress] = useState<number>(0);
  const [latencyCongested, setLatencyCongested] = useState<boolean>(false);
  const [ingestionMs, setIngestionMs] = useState<number>(38.5);
  const [processingMs, setProcessingMs] = useState<number>(62.4);
  const [submissionMs, setSubmissionMs] = useState<number>(35.2);
  const [clockDriftMs, setClockDriftMs] = useState<number>(0.12);
  const [packetLossPercent, setPacketLossPercent] = useState<number>(0.0);
  const [jitterMs, setJitterMs] = useState<number>(2.45);
  
  const [latencyLogs, setLatencyLogs] = useState<{ time: string; stage: "INGESTION" | "PROCESSING" | "SUBMISSION" | "SYSTEM"; rtt: number; status: "PASS" | "WARN" | "FAIL"; msg: string }[]>([
    { time: "13:30:05", stage: "SYSTEM", rtt: 0, status: "PASS", msg: "Análise diferencial de timestamps inicializada (p99.9 standard)." },
    { time: "13:31:12", stage: "INGESTION", rtt: 38.5, status: "PASS", msg: "Yellowstone Geyser gRPC: stream estabelecido com Frankfurt Co-location." },
    { time: "13:32:04", stage: "PROCESSING", rtt: 62.4, status: "PASS", msg: "Tomada de decisão no Cérebro (Rust VM): latência média de 62.4ms." },
    { time: "13:33:15", stage: "SUBMISSION", rtt: 35.2, status: "PASS", msg: "Landing de transação Jito Private ShredStream: slot pego no topo do bloco." }
  ]);

  // Deploy logs
  const [deployLogs, setDeployLogs] = useState<DeployLog[]>([
    { time: "13:20:01", level: "INFO", message: "Inicializando compilador de bytecode solana-anchor v0.29..." },
    { time: "13:20:04", level: "INFO", message: "Carregando assinaturas de hotwallets para verificação de balance..." },
    { time: "13:20:05", level: "SUCCESS", message: "Pronto para iniciar deploy operacional em produção." }
  ]);

  // Operational Incidents List
  const [incidents, setIncidents] = useState<OperationalIncident[]>([
    { id: "INC-901", time: "11:45:02", severity: "medium", service: "Yellowstone gRPC", description: "Oscilação temporária de RTT (+4.5ms) mitigada por fallback", status: "resolved" },
    { id: "INC-904", time: "12:15:30", severity: "low", service: "Jito BlockEngine", description: "Overhead de processamento de mempool forçou otimização de GC", status: "resolved" }
  ]);

  // SLA Reports statistics
  const [slaUptime] = useState<number>(99.98);
  const [totalExecutedSnipes] = useState<number>(452);
  const [savingsInGasSol] = useState<number>(12.45);

  // Dynamic values updater
  useEffect(() => {
    const interval = setInterval(() => {
      // Fluctuating health metrics
      setEventLoopLag(prev => {
        const drift = (Math.random() * 0.08) - 0.04;
        const next = parseFloat((prev + drift).toFixed(3));
        return next < 0.02 ? 0.02 : next > 0.45 ? 0.45 : next;
      });

      setRamUsage(prev => {
        const drift = Math.floor(Math.random() * 5) - 2;
        const next = prev + drift;
        return next < 200 ? 200 : next > 310 ? 310 : next;
      });

      setGrpcLatency(prev => {
        if (latencyCongested) {
          const drift = (Math.random() * 2.5) - 1.0;
          const next = parseFloat((prev + drift).toFixed(2));
          return next < 8.0 ? 8.25 : next > 25.0 ? 25.0 : next;
        } else {
          const drift = (Math.random() * 0.4) - 0.2;
          const next = parseFloat((prev + drift).toFixed(2));
          return next < 0.35 ? 0.35 : next > 4.5 ? 4.5 : next;
        }
      });

      setRpcSuccessRate(prev => {
        if (latencyCongested) {
          return parseFloat((80.5 + Math.random() * 5.0).toFixed(2));
        }
        if (Math.random() > 0.95) {
          return parseFloat((98.5 + Math.random() * 1.5).toFixed(2));
        }
        return prev < 100 ? parseFloat((prev + 0.15).toFixed(2)) : 100.0;
      });

      // Fluctuating specific latency stage metrics
      if (latencyCongested) {
        setIngestionMs(prev => {
          const drift = (Math.random() * 10) - 4;
          const next = parseFloat((prev + drift).toFixed(1));
          return next < 95.0 ? 98.4 : next > 140.0 ? 140.0 : next;
        });
        setProcessingMs(prev => {
          const drift = (Math.random() * 15) - 5;
          const next = parseFloat((prev + drift).toFixed(1));
          return next < 115.0 ? 122.5 : next > 165.0 ? 165.0 : next;
        });
        setSubmissionMs(prev => {
          const drift = (Math.random() * 25) - 8;
          const next = parseFloat((prev + drift).toFixed(1));
          return next < 210.0 ? 232.1 : next > 320.0 ? 320.0 : next;
        });
        setClockDriftMs(prev => {
          const drift = (Math.random() * 2) - 0.8;
          const next = parseFloat((prev + drift).toFixed(2));
          return next < 4.0 ? 4.25 : next > 15.0 ? 15.0 : next;
        });
        setPacketLossPercent(prev => {
          const drift = (Math.random() * 1.5) - 0.5;
          const next = parseFloat((prev + drift).toFixed(2));
          return next < 1.0 ? 1.45 : next > 5.5 ? 5.5 : next;
        });
        setJitterMs(prev => {
          const drift = (Math.random() * 5) - 1.5;
          const next = parseFloat((prev + drift).toFixed(2));
          return next < 12.0 ? 15.20 : next > 45.0 ? 45.0 : next;
        });
      } else {
        setIngestionMs(prev => {
          const drift = (Math.random() * 3) - 1.5;
          const next = parseFloat((prev + drift).toFixed(1));
          return next < 30.0 ? 32.5 : next > 49.5 ? 49.5 : next;
        });
        setProcessingMs(prev => {
          const drift = (Math.random() * 4) - 2.0;
          const next = parseFloat((prev + drift).toFixed(1));
          return next < 50.0 ? 52.4 : next > 75.0 ? 75.0 : next;
        });
        setSubmissionMs(prev => {
          const drift = (Math.random() * 3) - 1.5;
          const next = parseFloat((prev + drift).toFixed(1));
          return next < 25.0 ? 28.5 : next > 48.0 ? 48.0 : next;
        });
        setClockDriftMs(prev => {
          const drift = (Math.random() * 0.05) - 0.02;
          const next = parseFloat((prev + drift).toFixed(2));
          return next < 0.02 ? 0.04 : next > 0.45 ? 0.45 : next;
        });
        setPacketLossPercent(0.00);
        setJitterMs(prev => {
          const drift = (Math.random() * 0.5) - 0.25;
          const next = parseFloat((prev + drift).toFixed(2));
          return next < 1.2 ? 1.45 : next > 4.5 ? 4.5 : next;
        });
      }

    }, 3000);

    return () => clearInterval(interval);
  }, [latencyCongested]);

  // Run deployment pipeline simulator
  const runDeploymentPipeline = () => {
    if (isDeploying) return;
    setIsDeploying(true);
    setDeployStep(1);
    
    const steps = [
      { msg: "Compilando contratos inteligentes via Anchor v0.29...", level: "INFO" as const, delay: 1000 },
      { msg: "Bytecode gerado com sucesso: SHA256 matches verified (0x7F9aB...23c)", level: "SUCCESS" as const, delay: 2000 },
      { msg: "Transferindo bytecode para Solana Mainnet-Beta via pipeline de fibra Equinix NY4...", level: "INFO" as const, delay: 3500 },
      { msg: "Páginas de escrita de buffer alocadas no slot on-chain.", level: "INFO" as const, delay: 5000 },
      { msg: "Executando assinatura de autorização multimigração...", level: "INFO" as const, delay: 6500 },
      { msg: "Deploy concluído com sucesso no Program ID: SnpV6R...7Xz2!", level: "SUCCESS" as const, delay: 8000 }
    ];

    setDeployLogs(prev => [
      { time: new Date().toTimeString().substring(0, 8), level: "INFO", message: "🚀 Iniciando Deploy Operacional em Produção..." },
      ...prev
    ]);

    steps.forEach((step, idx) => {
      setTimeout(() => {
        setDeployLogs(prev => [
          { time: new Date().toTimeString().substring(0, 8), level: step.level, message: step.msg },
          ...prev
        ]);
        if (idx === 1) setDeployStep(2);
        if (idx === 3) setDeployStep(3);
        if (idx === 5) {
          setDeployStep(4);
          setIsDeploying(false);
          // Add system log
          setDeployLogs(prev => [
            { time: new Date().toTimeString().substring(0, 8), level: "SUCCESS", message: "✓ Sistema Operacional de Alta Frequência em modo pré-voo." },
            ...prev
          ]);
        }
      }, step.delay);
    });
  };

  // Run Go Live Promotion Simulator
  const runGoLivePromotion = () => {
    if (!prrAuditPassed) return;
    if (isPromoting || isLivePromoted) return;

    setIsPromoting(true);
    setPromotionProgress(5);

    const interval = setInterval(() => {
      setPromotionProgress(prev => {
        if (prev >= 100) {
          clearInterval(interval);
          setIsPromoting(false);
          setIsLivePromoted(true);
          return 100;
        }
        return prev + 15 + Math.floor(Math.random() * 10);
      });
    }, 600);
  };

  // Run Latency Check-up Diagnostics (L14 Sovereignty check)
  const runLatencyDiagnose = () => {
    if (latencyCheckRunning) return;
    setLatencyCheckRunning(true);
    setLatencyCheckProgress(5);
    
    // Clear and add start log
    const timeStart = new Date().toTimeString().substring(0, 8);
    setLatencyLogs([
      { time: timeStart, stage: "SYSTEM", rtt: 0, status: "PASS", msg: "⚡ Iniciando Check-up de Latência L14: Soberania de Milissegundos..." }
    ]);

    // Stage 1: Ingestão de Dados (Geyser gRPC)
    setTimeout(() => {
      setLatencyCheckProgress(35);
      const curTime = new Date().toTimeString().substring(0, 8);
      const rttVal = latencyCongested ? 112.4 : 38.5;
      const rttStatus = latencyCongested ? "WARN" : "PASS";
      setLatencyLogs(prev => [
        { 
          time: curTime, 
          stage: "INGESTION", 
          rtt: rttVal, 
          status: rttStatus, 
          msg: latencyCongested 
            ? "Yellowstone Geyser gRPC degradado: RTT físico excede barreira crítica de 50ms (congestionamento detectado)." 
            : "Yellowstone Geyser gRPC: Estável em Frankfurt co-location. Sub-50ms verificado com sucesso." 
        },
        ...prev
      ]);
    }, 1000);

    // Stage 2: Tomada de Decisão (Cérebro VM)
    setTimeout(() => {
      setLatencyCheckProgress(70);
      const curTime = new Date().toTimeString().substring(0, 8);
      const rttVal = latencyCongested ? 134.8 : 62.4;
      const rttStatus = latencyCongested ? "WARN" : "PASS";
      setLatencyLogs(prev => [
        { 
          time: curTime, 
          stage: "PROCESSING", 
          rtt: rttVal, 
          status: rttStatus, 
          msg: latencyCongested 
            ? "Cérebro (Rust VM) processando com GC lag elevado: Heap GC jitter detectado (+25ms drift)." 
            : "Cérebro (Rust VM): Otimização de compilação ativada. Assinatura e decisão sub-70ms ativa." 
        },
        ...prev
      ]);
    }, 2000);

    // Stage 3: Submissão e Landing Jito
    setTimeout(() => {
      setLatencyCheckProgress(100);
      setLatencyCheckRunning(false);
      const curTime = new Date().toTimeString().substring(0, 8);
      const rttVal = latencyCongested ? 265.1 : 35.2;
      const rttStatus = latencyCongested ? "FAIL" : "PASS";
      setLatencyLogs(prev => [
        { 
          time: curTime, 
          stage: "SUBMISSION", 
          rtt: rttVal, 
          status: rttStatus, 
          msg: latencyCongested 
            ? "Submissão Jito BlockEngine ABORTADA: Latência do bundle excede 200ms. Slot perdido! Perda de oportunidade de lucro estimada." 
            : "Jito ShredStream & BlockEngine: Bundle landing bem-sucedido no topo do bloco Solana (Absolute God Tier)." 
        },
        { 
          time: curTime, 
          stage: "SYSTEM", 
          rtt: 0, 
          status: latencyCongested ? "FAIL" : "PASS", 
          msg: latencyCongested 
            ? "❌ Check-up de Latência concluído: PERFORMANCE DEGRADADA. Risco extremo de compra de ativo com preço inflacionado." 
            : "✓ Check-up de Latência concluído: SOBERANIA DE MILISSEGUNDOS GARANTIDA. Sistema apto para execução Mainnet." 
        },
        ...prev
      ]);
    }, 3200);
  };

  // Immediate Disaster Recovery / Rollback Trigger
  const triggerEmergencyRollback = () => {
    setIsLivePromoted(false);
    setDeployStep(0);
    setPromotionProgress(0);
    setIsPromoting(false);

    // Create an incident
    const newInc: OperationalIncident = {
      id: `INC-${Math.floor(100 + Math.random() * 900)}`,
      time: new Date().toTimeString().substring(0, 8),
      severity: "critical",
      service: "CORE ENGINE",
      description: "DISJUNTOR OPERACIONAL DISPARADO PELO OPERADOR. ROLLBACK GERAL IMEDIATO ATIVADO.",
      status: "active"
    };

    setIncidents(prev => [newInc, ...prev]);
    setActiveTab("incidents");
  };

  // Inject a simulated Incident
  const injectSimulatedIncident = (type: "grpc" | "slippage" | "jito") => {
    let incidentInfo: OperationalIncident;
    const timeNow = new Date().toTimeString().substring(0, 8);

    if (type === "grpc") {
      incidentInfo = {
        id: `INC-${Math.floor(100 + Math.random() * 900)}`,
        time: timeNow,
        severity: "critical",
        service: "Yellowstone gRPC",
        description: "Falha de streaming de blocos Solana. RTT excede 12.0ms. Timeout na conexão do pipeline NY4.",
        status: "active"
      };
      setGrpcLatency(12.50);
      setIsHealthDegraded(true);
    } else if (type === "slippage") {
      incidentInfo = {
        id: `INC-${Math.floor(100 + Math.random() * 900)}`,
        time: timeNow,
        severity: "high",
        service: "Jupiter Router v6",
        description: "Taxa severa de rejeição por Slippage de Preço. 4 Bundles seguidos abortados na rede real.",
        status: "active"
      };
      setRpcSuccessRate(82.4);
    } else {
      incidentInfo = {
        id: `INC-${Math.floor(100 + Math.random() * 900)}`,
        time: timeNow,
        severity: "medium",
        service: "Jito BlockEngine",
        description: "Congestionamento de gorjeta MEV. Falhas intermitentes de pouso de transações privadas.",
        status: "active"
      };
    }

    setIncidents(prev => [incidentInfo, ...prev]);
  };

  // Mitigate/Resolve incident
  const resolveIncident = (id: string) => {
    setIncidents(prev => prev.map(inc => {
      if (inc.id === id) {
        return { ...inc, status: "resolved" };
      }
      return inc;
    }));

    // Reset metrics if critical mitigated
    setGrpcLatency(1.15);
    setRpcSuccessRate(100.0);
    setIsHealthDegraded(false);
  };

  // Clear all resolved incidents
  const clearResolvedIncidents = () => {
    setIncidents(prev => prev.filter(inc => inc.status === "active"));
  };

  return (
    <div id="production-readiness-center-dashboard" className="space-y-4">
      {/* Top Header Information Panel */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 backdrop-blur-md relative overflow-hidden">
        <div className="absolute top-0 right-0 w-36 h-36 bg-emerald-500/5 rounded-full blur-3xl pointer-events-none"></div>
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500/20 to-teal-500/20 border border-emerald-500/30 flex items-center justify-center shrink-0 glow-emerald">
              <Server className="w-6 h-6 text-emerald-400 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-display font-black text-slate-100 uppercase tracking-tight">
                  L14 &mdash; Production Readiness Center
                </h2>
                <span className="text-[9px] font-mono font-extrabold px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                  OPERATIONAL MANAGEMENT
                </span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed mt-1">
                Central de Gerenciamento On-Chain após validação. Monitore a integridade operacional, gerencie deploys em tempo real, promova o Go-Live, execute Rollbacks de desastre imediatos e responda a incidentes ao vivo.
              </p>
            </div>
          </div>

          {/* Quick status badge indicators */}
          <div className="flex gap-2.5 bg-slate-950 px-3 py-2 rounded-lg border border-slate-850 self-stretch sm:self-auto justify-between sm:justify-start">
            <div className="flex flex-col items-center">
              <span className="text-[8px] font-mono text-slate-500 uppercase">Estado Geral</span>
              <span className={`text-[10px] font-mono font-black uppercase mt-0.5 ${
                isLivePromoted ? "text-emerald-400" : "text-purple-400"
              }`}>
                {isLivePromoted ? "● LIVE IN PRODUCTION" : "● STANDBY / PRE-FLIGHT"}
              </span>
            </div>
            <div className="border-l border-slate-850 px-2.5 flex flex-col items-center">
              <span className="text-[8px] font-mono text-slate-500 uppercase">Uptime SLA</span>
              <span className="text-[10px] font-mono font-bold text-cyan-400 mt-0.5">{slaUptime}%</span>
            </div>
          </div>
        </div>
      </div>

      {/* Operations Flow Steps Tracker */}
      <div className="bg-slate-900/60 border border-slate-850 p-1.5 rounded-xl flex flex-wrap items-center justify-between gap-1 backdrop-blur-md">
        <div className="flex flex-wrap items-center gap-1">
          <button
            onClick={() => setActiveTab("deploy")}
            className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === "deploy"
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Zap className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
            1. DEPLOY INFRA
          </button>

          <button
            onClick={() => setActiveTab("prr")}
            className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === "prr"
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
            2. PRR VERIFIER (L13)
          </button>

          <button
            onClick={() => setActiveTab("golive")}
            className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === "golive"
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Play className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
            4. GO LIVE PROMOTER
          </button>

          <button
            onClick={() => setActiveTab("latency")}
            className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === "latency"
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Clock className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
            3. LATÊNCIA L14
          </button>

          <button
            onClick={() => setActiveTab("health")}
            className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === "health"
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Activity className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
            5. HEALTH METRICS
          </button>

          <button
            onClick={() => setActiveTab("rollback")}
            className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === "rollback"
                ? "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <RotateCcw className="w-3.5 h-3.5 shrink-0 text-rose-400" />
            6. ROLLBACK DISASTER
          </button>

          <button
            onClick={() => setActiveTab("incidents")}
            className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === "incidents"
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-400" />
            7. INCIDENTES ({incidents.filter(i => i.status === "active").length})
          </button>

          <button
            onClick={() => setActiveTab("reports")}
            className={`text-[11px] font-mono font-bold px-3 py-1.5 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === "reports"
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <FileText className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
            8. RELATÓRIOS SLA
          </button>
        </div>

        <span className="text-[8px] font-mono text-slate-500 uppercase mr-1">
          OPERATIONAL LIFECYCLE PIPELINE
        </span>
      </div>

      {/* Main Tab Render Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        
        {/* Left Interactive Section (Domain Panel) */}
        <div className="lg:col-span-8 space-y-4">
          
          {/* TAB 1: DEPLOY INFRASTRUCTURE */}
          {activeTab === "deploy" && (
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-850 pb-2.5">
                <div className="flex items-center gap-2">
                  <Server className="w-4 h-4 text-emerald-400 animate-spin-slow" />
                  <span className="text-xs font-mono font-bold text-slate-200">SISTEMA AUTOMÁTICO DE DEPLOY DE CONTRATOS</span>
                </div>
                <span className="text-[9px] font-mono text-slate-500 uppercase">Anchor Program Deployment</span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 flex flex-col justify-between">
                  <div>
                    <span className="text-[9px] font-mono text-slate-500 block uppercase">1. Anchor Compiler</span>
                    <span className="text-xs font-mono font-bold text-slate-200 block mt-1">Anchor CLI v0.29.0</span>
                    <p className="text-[9px] text-slate-400 font-mono mt-1 leading-relaxed uppercase">
                      Compila o código Rust do sniper e gera o IDL correspondente.
                    </p>
                  </div>
                  <span className={`text-[9px] font-mono font-bold uppercase mt-2 block ${
                    deployStep >= 1 ? "text-emerald-400" : "text-slate-600"
                  }`}>
                    {deployStep >= 1 ? "✓ Compiled" : "Ready"}
                  </span>
                </div>

                <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 flex flex-col justify-between">
                  <div>
                    <span className="text-[9px] font-mono text-slate-500 block uppercase">2. Address Allocator</span>
                    <span className="text-xs font-mono font-bold text-slate-200 block mt-1">Program ID Verification</span>
                    <p className="text-[9px] text-slate-400 font-mono mt-1 leading-relaxed uppercase">
                      Mapeia chaves de controle do disjuntor para evitar herança de memória.
                    </p>
                  </div>
                  <span className={`text-[9px] font-mono font-bold uppercase mt-2 block ${
                    deployStep >= 3 ? "text-emerald-400" : "text-slate-600"
                  }`}>
                    {deployStep >= 3 ? "✓ Space Allocated" : "Awaiting step 1"}
                  </span>
                </div>

                <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 flex flex-col justify-between">
                  <div>
                    <span className="text-[9px] font-mono text-slate-500 block uppercase">3. Fiber Network Ingress</span>
                    <span className="text-xs font-mono font-bold text-slate-200 block mt-1">Equinix NY4 Equilink</span>
                    <p className="text-[9px] text-slate-400 font-mono mt-1 leading-relaxed uppercase">
                      Transfere os bytes em blocos discretos por fibra de ultra baixa latência.
                    </p>
                  </div>
                  <span className={`text-[9px] font-mono font-bold uppercase mt-2 block ${
                    deployStep >= 4 ? "text-emerald-400" : "text-slate-600"
                  }`}>
                    {deployStep >= 4 ? "✓ Deployed & Synced" : "Awaiting upload"}
                  </span>
                </div>
              </div>

              {/* Progress bar */}
              {isDeploying && (
                <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 space-y-2">
                  <div className="flex justify-between items-center text-[10px] font-mono">
                    <span className="text-emerald-400 font-bold animate-pulse">DEPLOY EM ANDAMENTO (SOLANA MAINNET-BETA)</span>
                    <span className="text-slate-400">{deployStep * 25}% Concluído</span>
                  </div>
                  <div className="w-full bg-slate-900 rounded-full h-1.5 overflow-hidden">
                    <div 
                      className="bg-emerald-500 h-1.5 rounded-full transition-all duration-500" 
                      style={{ width: `${deployStep * 25}%` }}
                    ></div>
                  </div>
                </div>
              )}

              {/* Action Trigger */}
              <div className="flex items-center justify-between bg-slate-950 p-3 rounded-lg border border-slate-850">
                <div className="font-mono text-[10px] text-slate-400 uppercase">
                  <span>DEPLOY TARGET:</span> <strong className="text-slate-200">Mainnet Program ProgramId: SnpV6R...7Xz2</strong>
                </div>
                <button
                  onClick={runDeploymentPipeline}
                  disabled={isDeploying}
                  className="px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/25 text-emerald-400 border border-emerald-500/30 font-mono text-[10px] font-bold rounded-lg transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isDeploying ? "animate-spin" : ""}`} />
                  {deployStep === 4 ? "RE-IMPLANTAR SISTEMA" : "DISPARAR DEPLOY IMEDIATO"}
                </button>
              </div>

              {/* Live console logs */}
              <div className="bg-slate-950 p-3 rounded-lg border border-slate-850">
                <span className="text-[8px] font-mono text-slate-500 block uppercase mb-2 border-b border-slate-900 pb-1 flex justify-between">
                  <span>LOGS DO COMPILADOR E PIPELINE OPERACIONAL</span>
                  <span className="text-emerald-400/80">LIVE FEED</span>
                </span>
                <div className="h-40 overflow-y-auto space-y-1 pr-1 font-mono text-[10px] leading-relaxed scrollbar-thin">
                  {deployLogs.map((log, i) => (
                    <div key={i} className="flex gap-2 border-b border-slate-900/30 pb-0.5 last:border-0">
                      <span className="text-slate-600 shrink-0">[{log.time}]</span>
                      <span className={`font-bold shrink-0 text-[8px] px-1 rounded uppercase ${
                        log.level === "SUCCESS" ? "bg-emerald-500/10 text-emerald-400" :
                        log.level === "WARN" ? "bg-amber-500/10 text-amber-400" :
                        log.level === "ERROR" ? "bg-rose-500/10 text-rose-400" :
                        "bg-slate-900 text-slate-400"
                      }`}>{log.level}</span>
                      <span className="text-slate-300">{log.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 8: REAL-TIME LATENCY CHECK-UP (L14) */}
          {activeTab === "latency" && (
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-850 pb-2.5">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-emerald-400 animate-pulse" />
                  <span className="text-xs font-mono font-bold text-slate-200">L14 &mdash; CHECK-UP DE LATÊNCIA EM TEMPO REAL</span>
                </div>
                <span className="text-[9px] font-mono text-emerald-400 uppercase bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                  SOBERANIA DE MILISSEGUNDOS
                </span>
              </div>

              {/* Executive Summary */}
              <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 space-y-1.5">
                <span className="text-[9px] font-mono text-slate-500 uppercase font-bold">1. RESUMO EXECUTIVO</span>
                <p className="text-[10.5px] text-slate-400 font-mono leading-relaxed uppercase">
                  O Check-up de Latência L14 é um teste de estresse e sincronização em tempo real que mede o tempo decorrido em cada estágio do pipeline: Ingestão (Radar), Processamento (Cérebro), e Submissão (Gatilho). O objetivo técnico é validar se o sistema mantém o ciclo end-to-end abaixo de <strong className="text-emerald-400">150-200ms</strong> sob condições reais de tráfego. Sem esta validação, o robô corre risco crítico de comprar ativos com atraso de slots (~400ms), resultando em preços <strong className="text-rose-400">3x a 5x superiores</strong> e perdas de até <strong className="text-rose-400">25% do lucro potencial</strong>.
                </p>
              </div>

              {/* Diagnostics Controller & Live Status */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="bg-slate-950 p-4 rounded-lg border border-slate-850 flex flex-col justify-between space-y-3">
                  <div>
                    <span className="text-[9px] font-mono text-slate-500 uppercase block font-bold">PAINEL DE ESTRESSE & CONTROLE</span>
                    <p className="text-[10px] text-slate-400 font-mono mt-1 leading-normal uppercase">
                      Execute o diagnóstico de estresse diferencial de timestamps para avaliar a saúde física das fibras óticas Frankfurt-Equinix e integridade do Geyser gRPC.
                    </p>
                  </div>

                  {latencyCheckRunning ? (
                    <div className="space-y-2">
                      <div className="flex justify-between text-[9px] font-mono text-emerald-400">
                        <span>ENVIANDO MICRO-BUNDLES DE TESTE OPERACIONAL...</span>
                        <span>{latencyCheckProgress}%</span>
                      </div>
                      <div className="w-full bg-slate-900 rounded-full h-1.5 overflow-hidden">
                        <div className="bg-emerald-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${latencyCheckProgress}%` }}></div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col sm:flex-row gap-2">
                      <button
                        onClick={runLatencyDiagnose}
                        className="flex-1 py-2 px-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-mono font-black text-[10px] rounded transition-all cursor-pointer text-center uppercase tracking-wider"
                      >
                        ⚡ INICIAR TESTE OPERACIONAL
                      </button>
                      
                      <button
                        onClick={() => {
                          setLatencyCongested(!latencyCongested);
                          // Clear resolved to make things look active if degraded
                          if (!latencyCongested) {
                            setIsHealthDegraded(true);
                            setGrpcLatency(14.5);
                            setRpcSuccessRate(81.2);
                          } else {
                            setIsHealthDegraded(false);
                            setGrpcLatency(1.15);
                            setRpcSuccessRate(100.0);
                          }
                        }}
                        className={`flex-1 py-2 px-3 border font-mono font-bold text-[10px] rounded transition-all cursor-pointer text-center uppercase ${
                          latencyCongested 
                            ? "bg-rose-500/20 text-rose-400 border-rose-500/30 animate-pulse" 
                            : "bg-slate-900 text-slate-400 border-slate-800 hover:bg-slate-850"
                        }`}
                      >
                        {latencyCongested ? "⚠️ REMOVER CONGESTIONAMENTO" : "🔴 SIMULAR CONGESTIONAMENTO"}
                      </button>
                    </div>
                  )}
                </div>

                {/* Clock Drift, Jitter & Packet Loss Widget */}
                <div className="bg-slate-950 p-4 rounded-lg border border-slate-850 space-y-3">
                  <span className="text-[9px] font-mono text-slate-500 uppercase block font-bold">TELEMETRIA COMPLEMENTAR (RISCOS)</span>
                  
                  <div className="grid grid-cols-3 gap-2 font-mono text-[10px]">
                    <div className="bg-slate-900/60 p-2 rounded border border-slate-850 text-center">
                      <span className="text-slate-500 text-[8px] block uppercase">NTP Clock Drift</span>
                      <span className={`text-xs font-black block mt-1 ${clockDriftMs > 1.0 ? "text-rose-400" : "text-emerald-400"}`}>
                        {clockDriftMs > 0 ? `+${clockDriftMs.toFixed(2)}` : clockDriftMs.toFixed(2)} ms
                      </span>
                      <span className="text-[7px] text-slate-500 block uppercase mt-0.5">Sincronia NTP</span>
                    </div>

                    <div className="bg-slate-900/60 p-2 rounded border border-slate-850 text-center">
                      <span className="text-slate-500 text-[8px] block uppercase">Packet Loss</span>
                      <span className={`text-xs font-black block mt-1 ${packetLossPercent > 0 ? "text-rose-400 animate-pulse" : "text-emerald-400"}`}>
                        {packetLossPercent.toFixed(2)}%
                      </span>
                      <span className="text-[7px] text-slate-500 block uppercase mt-0.5">Perda de rede</span>
                    </div>

                    <div className="bg-slate-900/60 p-2 rounded border border-slate-850 text-center">
                      <span className="text-slate-500 text-[8px] block uppercase">Lat Jitter</span>
                      <span className={`text-xs font-black block mt-1 ${jitterMs > 5.0 ? "text-rose-400" : "text-emerald-400"}`}>
                        ±{jitterMs.toFixed(2)} ms
                      </span>
                      <span className="text-[7px] text-slate-500 block uppercase mt-0.5">Desvio Padrão</span>
                    </div>
                  </div>

                  <div className="text-[8.5px] font-mono text-slate-500 leading-snug uppercase">
                    {latencyCongested 
                      ? "⚠️ drift e jitter elevados ameaçam sincronia de blocos Jito Leader Schedule." 
                      : "✓ Desvio padrão ideal garantindo previsibilidade de landing sub-150ms."
                    }
                  </div>
                </div>
              </div>

              {/* Three Pipeline Latency Stages & Cumulative */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 font-mono">
                {/* Ingestion */}
                <div className="bg-slate-950 p-3.5 rounded-lg border border-slate-850 flex flex-col justify-between">
                  <div>
                    <span className="text-[8px] text-slate-500 uppercase block font-bold">A. Ingestão (Radar)</span>
                    <span className="text-xs font-bold text-slate-200 mt-1 block">Yellowstone Geyser gRPC</span>
                  </div>
                  <div className="mt-2.5">
                    <span className={`text-xl font-black block ${ingestionMs > 50.0 ? "text-amber-400" : "text-emerald-400"}`}>
                      {ingestionMs.toFixed(1)}ms
                    </span>
                    <span className={`text-[8px] font-extrabold uppercase ${ingestionMs > 50.0 ? "text-amber-500" : "text-emerald-500"}`}>
                      {ingestionMs > 50.0 ? "⚠ EXCEEDE LIMITE (<50)" : "✓ SOBERANO (<50ms)"}
                    </span>
                  </div>
                </div>

                {/* Processing */}
                <div className="bg-slate-950 p-3.5 rounded-lg border border-slate-850 flex flex-col justify-between">
                  <div>
                    <span className="text-[8px] text-slate-500 uppercase block font-bold">B. Processamento (Cérebro)</span>
                    <span className="text-xs font-bold text-slate-200 mt-1 block">Rust VM Decision Engine</span>
                  </div>
                  <div className="mt-2.5">
                    <span className={`text-xl font-black block ${processingMs > 100.0 ? "text-amber-400" : "text-emerald-400"}`}>
                      {processingMs.toFixed(1)}ms
                    </span>
                    <span className={`text-[8px] font-extrabold uppercase ${processingMs > 100.0 ? "text-amber-500" : "text-emerald-500"}`}>
                      {processingMs > 100.0 ? "⚠ DEGRADADO (<100)" : "✓ EXCELENTE (<100ms)"}
                    </span>
                  </div>
                </div>

                {/* Submission */}
                <div className="bg-slate-950 p-3.5 rounded-lg border border-slate-850 flex flex-col justify-between">
                  <div>
                    <span className="text-[8px] text-slate-500 uppercase block font-bold">C. Submissão (Gatilho)</span>
                    <span className="text-xs font-bold text-slate-200 mt-1 block">Jito ShredStream Private</span>
                  </div>
                  <div className="mt-2.5">
                    <span className={`text-xl font-black block ${submissionMs > 50.0 ? "text-rose-400" : "text-emerald-400"}`}>
                      {submissionMs.toFixed(1)}ms
                    </span>
                    <span className={`text-[8px] font-extrabold uppercase ${submissionMs > 50.0 ? "text-rose-500" : "text-emerald-500"}`}>
                      {submissionMs > 50.0 ? "⚠ TIMEOUT / SLOT LOST" : "✓ LANDED NO TOPO"}
                    </span>
                  </div>
                </div>

                {/* Cumulative End-to-End Cycle */}
                <div className="bg-slate-950 p-3.5 rounded-lg border border-emerald-500/20 shadow-lg shadow-emerald-500/2 flex flex-col justify-between relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-16 h-16 bg-emerald-500/5 rounded-full blur-xl"></div>
                  <div>
                    <span className="text-[8px] text-emerald-400 uppercase block font-bold">CICLO COMPLETO (END-TO-END)</span>
                    <span className="text-xs font-bold text-slate-200 mt-1 block">Pipeline Real-Time Latency</span>
                  </div>
                  <div className="mt-2.5">
                    <span className={`text-xl font-black block ${
                      (ingestionMs + processingMs + submissionMs) > 150.0 ? "text-rose-400 animate-pulse" : "text-emerald-400"
                    }`}>
                      {(ingestionMs + processingMs + submissionMs).toFixed(1)}ms
                    </span>
                    <span className={`text-[8px] font-extrabold uppercase ${
                      (ingestionMs + processingMs + submissionMs) > 150.0 ? "text-rose-500" : "text-emerald-400"
                    }`}>
                      {(ingestionMs + processingMs + submissionMs) > 150.0 ? "❌ SEM SOBERANIA (TIER-2)" : "✓ GOD TIER (TOP 1%)"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Financial Risk & Profit Opportunity Loss Box */}
              <div className={`p-3 rounded-lg border font-mono text-[10px] leading-relaxed uppercase flex flex-col sm:flex-row items-center gap-3 ${
                latencyCongested 
                  ? "bg-rose-500/10 text-rose-400 border-rose-500/25" 
                  : "bg-emerald-500/5 text-emerald-400 border-emerald-500/15"
              }`}>
                <AlertTriangle className={`w-5 h-5 shrink-0 ${latencyCongested ? "text-rose-400 animate-bounce" : "text-emerald-400"}`} />
                <div>
                  <strong className="block text-slate-200">CUSTO DE OPORTUNIDADE & SOBERANIA OPERACIONAL</strong>
                  {latencyCongested ? (
                    <span>ALERTA DE DESASTRE HFT: Latência de {(ingestionMs + processingMs + submissionMs).toFixed(1)}ms excede um slot de bloco Solana (~400ms). Preço estimado de aquisição inflacionado em até 4x (perda de 20% do lucro real). Mitigue restabelecendo o Private RPC imediatamente.</span>
                  ) : (
                    <span>Estabilidade nominal de sub-150ms confirmada. O robô HFT garante a inclusão de transações privadas na primeira posição do bloco Solana, sem exposição de slippage e capturando 100% da oportunidade de lucro estimado.</span>
                  )}
                </div>
              </div>

              {/* Technology Classification Table */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-slate-950 p-3.5 rounded-lg border border-slate-850">
                  <span className="text-[9px] font-mono text-slate-500 block uppercase font-bold mb-2">2. CLASSIFICAÇÃO TECNOLÓGICA & JUSTIFICATIVA</span>
                  <div className="overflow-x-auto text-left">
                    <table className="w-full font-mono text-[10px] border-collapse">
                      <thead>
                        <tr className="border-b border-slate-900 text-slate-400">
                          <th className="pb-1.5 font-bold uppercase w-1/3 text-left">Tecnologia</th>
                          <th className="pb-1.5 font-bold uppercase w-1/4 text-left">Classificação</th>
                          <th className="pb-1.5 font-bold uppercase text-left">Justificativa / Objetivo</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-900/40">
                        <tr>
                          <td className="py-1.5 text-slate-200 font-bold">Yellowstone Geyser gRPC</td>
                          <td className="py-1.5 text-emerald-400 font-extrabold uppercase">Essencial</td>
                          <td className="py-1.5 text-slate-400 uppercase">Única forma de garantir detecção sub-50ms de atualizações on-chain</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 text-slate-200 font-bold">Co-location (Bare Metal)</td>
                          <td className="py-1.5 text-emerald-400 font-extrabold uppercase">Essencial</td>
                          <td className="py-1.5 text-slate-400 uppercase">Minimiza latência física e RTT para sub-milissegundo em Frankfurt</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 text-slate-200 font-bold">Jito Bundles</td>
                          <td className="py-1.5 text-emerald-400 font-extrabold uppercase">Essencial</td>
                          <td className="py-1.5 text-slate-400 uppercase">Garante atomicidade e prioridade máxima de bloco no leilão MEV</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 text-slate-200 font-bold">Timestamp Diff Analysis</td>
                          <td className="py-1.5 text-cyan-400 font-extrabold uppercase">Importante</td>
                          <td className="py-1.5 text-slate-400 uppercase">Auditoria interna de performance de cada microsserviço</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 text-slate-200 font-bold">ShredStream</td>
                          <td className="py-1.5 text-cyan-400 font-extrabold uppercase">Importante</td>
                          <td className="py-1.5 text-slate-400 uppercase">Visibilidade de blocos Solana pré-propagação global</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* KPI Targets Table */}
                <div className="bg-slate-950 p-3.5 rounded-lg border border-slate-850">
                  <span className="text-[9px] font-mono text-slate-500 block uppercase font-bold mb-2">3. KPIs DE LATÊNCIA OBSERVADOS (MÉTRICAS ALVO)</span>
                  <div className="overflow-x-auto text-left">
                    <table className="w-full font-mono text-[10px] border-collapse">
                      <thead>
                        <tr className="border-b border-slate-900 text-slate-400">
                          <th className="pb-1.5 font-bold uppercase w-1/3 text-left">Estágio do Pipeline</th>
                          <th className="pb-1.5 font-bold uppercase w-1/4 text-left">Latência P99 Alvo</th>
                          <th className="pb-1.5 font-bold uppercase text-left">Ferramenta de Medição</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-900/40">
                        <tr>
                          <td className="py-1.5 text-slate-200 font-bold">Detecção (Geyser)</td>
                          <td className="py-1.5 text-emerald-400 font-extrabold uppercase">&lt; 50ms</td>
                          <td className="py-1.5 text-slate-400 uppercase">Telemetria gRPC Link</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 text-slate-200 font-bold">Simulação / Decisão</td>
                          <td className="py-1.5 text-emerald-400 font-extrabold uppercase">&lt; 20ms</td>
                          <td className="py-1.5 text-slate-400 uppercase">Logs Internos (Rust/Node)</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 text-slate-200 font-bold">Construção / Assinatura</td>
                          <td className="py-1.5 text-emerald-400 font-extrabold uppercase">&lt; 30ms</td>
                          <td className="py-1.5 text-slate-400 uppercase">Timestamp Diff Analysis</td>
                        </tr>
                        <tr>
                          <td className="py-1.5 text-slate-200 font-bold">Submissão Jito</td>
                          <td className="py-1.5 text-emerald-400 font-extrabold uppercase">&lt; 50ms</td>
                          <td className="py-1.5 text-slate-400 uppercase">Jito Block Engine Latency</td>
                        </tr>
                        <tr className="bg-emerald-500/5 font-bold">
                          <td className="py-1.5 text-emerald-400 font-bold">Ciclo Total (E2E)</td>
                          <td className="py-1.5 text-emerald-400 font-extrabold uppercase">&lt; 150ms</td>
                          <td className="py-1.5 text-emerald-400 uppercase">Dashboard Grafana Real-time</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* Architecture Deep Dive (Pros, Contras, Limitations, Costs) */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {/* Pros & Contras */}
                <div className="bg-slate-950 p-3.5 rounded-lg border border-slate-850 space-y-2">
                  <span className="text-[9px] font-mono text-slate-500 block uppercase font-bold border-b border-slate-900 pb-1">
                    4. PRÓS & CONTRAS DA ARQUITETURA
                  </span>
                  <div className="grid grid-cols-2 gap-3 text-[10px] font-mono">
                    <div className="space-y-1">
                      <span className="text-emerald-400 font-bold block uppercase text-[9px]">✓ PRÓS (Vantagens)</span>
                      <p className="text-slate-400 leading-relaxed uppercase text-[8.5px]">
                        Identifica gargalos de rede ocultos antes da exposição real de capital; Garante que as gorjetas (tips) do Jito sejam despachadas no momento exato do leilão de blocos.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <span className="text-rose-400 font-bold block uppercase text-[9px]">✗ CONTRAS (Desvantagens)</span>
                      <p className="text-slate-400 leading-relaxed uppercase text-[8.5px]">
                        Exige infraestrutura RPC Privada ativa e de alto custo financeiro mesmo na fase de testes; Carga excessiva de telemetria pode introduzir jitter na RAM se não for executada de forma estritamente assíncrona.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Limitations, Costs & Complexity */}
                <div className="bg-slate-950 p-3.5 rounded-lg border border-slate-850 space-y-2">
                  <span className="text-[9px] font-mono text-slate-500 block uppercase font-bold border-b border-slate-900 pb-1">
                    5. LIMITAÇÕES & CUSTOS OPERACIONAIS
                  </span>
                  <div className="grid grid-cols-2 gap-3 text-[10px] font-mono">
                    <div className="space-y-1">
                      <span className="text-amber-400 font-bold block uppercase text-[9px]">⚠️ LIMITAÇÕES</span>
                      <p className="text-slate-400 leading-relaxed uppercase text-[8.5px]">
                        Latência medida flutua sob congestionamento extremo da rede global; Não prevê falhas de inclusão se o validador Jito sofrer degradação momentânea inesperada.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <span className="text-cyan-400 font-bold block uppercase text-[9px]">💵 CUSTOS ESTIMADOS</span>
                      <p className="text-slate-400 leading-relaxed uppercase text-[8.5px]">
                        RPC Dedicado: US$ 500 – US$ 2.000 mensais para streams gRPC Yellowstone; Telemetria/Monitoramento integrado: 15-25% do CAPEX anual de infraestrutura do Sniper.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Extra Meta Data (Complexity & References) */}
              <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 grid grid-cols-1 md:grid-cols-3 gap-3 font-mono text-[9px] uppercase">
                <div className="p-1.5 bg-slate-900 rounded">
                  <span className="text-slate-500 block">Complexidade Técnica:</span>
                  <strong className="text-slate-200">Extrema (Ajuste fino de Kernel Linux & Rust Optimization)</strong>
                </div>
                <div className="p-1.5 bg-slate-900 rounded">
                  <span className="text-slate-500 block">Nível de Competitividade:</span>
                  <strong className="text-emerald-400">Absolute God Tier (Top 1% dos Robôs Solana)</strong>
                </div>
                <div className="p-1.5 bg-slate-900 rounded">
                  <span className="text-slate-500 block">Referências de Engenharia:</span>
                  <strong className="text-slate-400">Dysnix 2026, Solana Docs, Jito Foundation Specs</strong>
                </div>
              </div>

              {/* Live console logs for Timestamp checkup */}
              <div className="bg-slate-950 p-3 rounded-lg border border-slate-850">
                <span className="text-[8px] font-mono text-slate-500 block uppercase mb-2 border-b border-slate-900 pb-1 flex justify-between">
                  <span>TELEMETRIA DE TIMESTAMPS OPERACIONAIS & PIPELINE DIAGNOSTIC FEED</span>
                  <span className="text-emerald-400/80 animate-pulse">SYSTEM REAL-TIME</span>
                </span>
                <div className="h-32 overflow-y-auto space-y-1.5 pr-1 font-mono text-[10px] leading-relaxed scrollbar-thin">
                  {latencyLogs.map((log, i) => (
                    <div key={i} className="flex gap-2 border-b border-slate-900/30 pb-1 last:border-0 text-left">
                      <span className="text-slate-600 shrink-0">[{log.time}]</span>
                      <span className={`font-bold shrink-0 text-[8px] px-1 rounded uppercase ${
                        log.status === "PASS" ? "bg-emerald-500/10 text-emerald-400" :
                        log.status === "WARN" ? "bg-amber-500/10 text-amber-400 animate-pulse" :
                        "bg-rose-500/10 text-rose-400 animate-pulse"
                      }`}>{log.status}</span>
                      <span className="text-slate-400 font-bold shrink-0">[{log.stage}]</span>
                      {log.rtt > 0 && <span className="text-cyan-400 shrink-0">{log.rtt.toFixed(1)}ms RTT &mdash;</span>}
                      <span className="text-slate-300">{log.msg}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: PRR AUDIT VERIFIER */}
          {activeTab === "prr" && (
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-850 pb-2.5">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs font-mono font-bold text-slate-200">INTEGRAÇÃO COM AUDITORIA L13 (PRODUCTION READINESS REVIEW)</span>
                </div>
                <span className="text-[9px] font-mono text-slate-500 uppercase">PRR Gateway Guard</span>
              </div>

              <div className="bg-slate-950 p-4 rounded-lg border border-slate-850 text-center space-y-3">
                <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto text-emerald-400">
                  <CheckCircle2 className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-sm font-display font-bold text-slate-200 uppercase">Resultado da Auditoria PRR</h3>
                  <p className="text-[10px] text-slate-400 font-mono mt-1 leading-relaxed uppercase">
                    O L13 PRODUCTION READINESS REVIEW ATINGIU UM SCORE DE <strong className="text-emerald-400">98/100</strong>. TODAS AS 5 GATES CRÍTICAS DE ENGENHARIA FORAM CONFIRMADAS COMO APROVADAS.
                  </p>
                </div>
                
                <div className="flex justify-center gap-6 text-[10px] font-mono py-2 bg-slate-900/50 rounded-lg border border-slate-850">
                  <div className="flex items-center gap-1.5 text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Gate 1 (Infra): PASS
                  </div>
                  <div className="flex items-center gap-1.5 text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Gate 2 (Wallets): PASS
                  </div>
                  <div className="flex items-center gap-1.5 text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Gate 3 (Latency): PASS
                  </div>
                  <div className="flex items-center gap-1.5 text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Gate 4 (Shadow): PASS
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 space-y-2">
                  <span className="text-[9px] font-mono text-slate-500 uppercase font-bold">Por que é necessário separar validação de operação?</span>
                  <p className="text-[10.5px] text-slate-400 font-sans leading-relaxed">
                    A auditoria do <strong>L13</strong> verifica estaticamente e sob simulação de degradação se as regras de slippage, o RTT p99.9 e os isolamentos de RAM estão corretos. O <strong>L14</strong> assume este resultado para dar permissão operacional de escrita on-chain. Caso o score da auditoria caia abaixo do aceitável, o Go-Live é revogado preventivamente.
                  </p>
                </div>

                <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 flex flex-col justify-between">
                  <div>
                    <span className="text-[9px] font-mono text-slate-500 uppercase font-bold">Simular Estado do PRR</span>
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={() => {
                          setPrrAuditPassed(true);
                        }}
                        className={`flex-1 py-1 px-2 text-[10px] font-mono font-bold rounded transition-all cursor-pointer border ${
                          prrAuditPassed
                            ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                            : "bg-slate-900 text-slate-500 border-slate-850"
                        }`}
                      >
                        PRR APROVADO (SLA OK)
                      </button>
                      <button
                        onClick={() => {
                          setPrrAuditPassed(false);
                          setIsLivePromoted(false);
                        }}
                        className={`flex-1 py-1 px-2 text-[10px] font-mono font-bold rounded transition-all cursor-pointer border ${
                          !prrAuditPassed
                            ? "bg-rose-500/15 text-rose-400 border-rose-500/30 animate-pulse"
                            : "bg-slate-900 text-slate-500 border-slate-850"
                        }`}
                      >
                        PRR BLOQUEADO (RISCO)
                      </button>
                    </div>
                  </div>
                  <span className="text-[8px] font-mono text-slate-500 leading-tight uppercase mt-2">
                    Alterar este estado para simular o bloqueio de segurança operacional do L14 Go Live.
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: GO LIVE PROMOTION CONTROL */}
          {activeTab === "golive" && (
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-850 pb-2.5">
                <div className="flex items-center gap-2">
                  <Play className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs font-mono font-bold text-slate-200">PROMOÇÃO OPERACIONAL ATIVA DE GO-LIVE</span>
                </div>
                <span className="text-[9px] font-mono text-slate-500 uppercase">Mainnet Promotion Panel</span>
              </div>

              {!prrAuditPassed ? (
                <div className="bg-rose-500/5 border border-rose-500/20 p-4 rounded-xl text-center space-y-2">
                  <XCircle className="w-10 h-10 text-rose-400 mx-auto" />
                  <h3 className="text-xs font-mono font-bold text-rose-400 uppercase">BLOQUEIO OPERACIONAL DE SEGURANÇA</h3>
                  <p className="text-[10px] text-slate-300 font-mono leading-relaxed uppercase">
                    PROMOÇÃO DE GO-LIVE BLOQUEADA. O SCORE DE AUDITORIA DO L13 ESTÁ REBAIXADO OU COM GATES CRÍTICAS PENDENTES. RE-EXECUTE A DIAGNOSE DO PRR PARA LIBERAR.
                  </p>
                </div>
              ) : isLivePromoted ? (
                <div className="bg-emerald-500/5 border border-emerald-500/20 p-4 rounded-xl text-center space-y-3">
                  <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto animate-bounce" />
                  <div>
                    <h3 className="text-sm font-display font-black text-emerald-400 uppercase">SISTEMA ATIVO EM MAINNET (LIVE!)</h3>
                    <p className="text-[10px] text-slate-300 font-mono mt-1 leading-relaxed uppercase">
                      O ROBÔ DE ALTA FREQUÊNCIA FOI PROMOVIDO AO ESTÁGIO DE EXECUÇÃO TOTAL ON-CHAIN. FLUXOS DE LIQUIDEZ REAIS ESTÃO SENDO PROCESSADOS VIA JITO BLOCKENGINE.
                    </p>
                  </div>
                  <div className="inline-block px-3 py-1 bg-emerald-500/10 rounded border border-emerald-500/20 text-[9px] font-mono text-emerald-400 uppercase">
                    PROMOÇÃO VERIFICADA • ASSINATURA DE CONTROLE ATIVA
                  </div>
                </div>
              ) : (
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-850 text-center space-y-4">
                  <div className="space-y-1">
                    <span className="text-[9px] font-mono text-slate-500 uppercase">Estágio Atual de Segurança</span>
                    <h3 className="text-xs font-mono font-bold text-slate-200 uppercase">SANDBOX / SIMULAÇÃO COMPLETA EM ANDAMENTO</h3>
                  </div>

                  <p className="text-[10px] text-slate-400 font-mono leading-relaxed max-w-lg mx-auto uppercase">
                    Ao confirmar a virada de chave, o sistema operacional irá desacoplar a barreira protetora de Shadow-State e passará a assinar transações on-chain de alta competição com fundos das hotwallets ativas.
                  </p>

                  {isPromoting ? (
                    <div className="space-y-2">
                      <div className="flex justify-between text-[9px] font-mono text-cyan-400">
                        <span>ESTABELECENDO CANAIS SEGUROS DE FIBRA NY4...</span>
                        <span>{promotionProgress}%</span>
                      </div>
                      <div className="w-full bg-slate-900 rounded-full h-1 overflow-hidden">
                        <div className="bg-cyan-400 h-1 rounded-full transition-all duration-300" style={{ width: `${promotionProgress}%` }}></div>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={runGoLivePromotion}
                      className="px-6 py-3 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-display font-extrabold text-xs rounded-xl transition-all cursor-pointer glow-emerald uppercase tracking-wider"
                    >
                      CONFIRMAR VIRADA DE CHAVE & PROMOVER PARA MAINNET
                    </button>
                  )}
                </div>
              )}

              {/* Pre-conditions list for Promotion */}
              <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 space-y-2 font-mono text-[9.5px]">
                <span className="text-[8.5px] text-slate-500 block uppercase font-bold border-b border-slate-900 pb-1">
                  LISTA DE PRÉ-CONDIÇÕES OPERACIONAIS (GATES EXECUTÁVEIS)
                </span>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <div className="flex items-center justify-between p-1.5 bg-slate-900 rounded">
                    <span className="text-slate-400">1. Deploy do Bytecode:</span>
                    <span className={`font-bold ${deployStep === 4 ? "text-emerald-400" : "text-amber-400"}`}>
                      {deployStep === 4 ? "APROVADO" : "PENDENTE DEPLOY"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between p-1.5 bg-slate-900 rounded">
                    <span className="text-slate-400">2. Relatório PRR L13:</span>
                    <span className={`font-bold ${prrAuditPassed ? "text-emerald-400" : "text-rose-400"}`}>
                      {prrAuditPassed ? "98% (SEGURO)" : "REBAIXADO"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between p-1.5 bg-slate-900 rounded">
                    <span className="text-slate-400">3. Conectividade RTT:</span>
                    <span className="text-emerald-400 font-bold">1.25ms (EXCELENTE)</span>
                  </div>
                  <div className="flex items-center justify-between p-1.5 bg-slate-900 rounded">
                    <span className="text-slate-400">4. Hotwallets Balance:</span>
                    <span className="text-emerald-400 font-bold">14.85 SOL (OK)</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: REAL-TIME HEALTH METRICS & INSTRUMENTATION */}
          {activeTab === "health" && (
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-850 pb-2.5">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs font-mono font-bold text-slate-200">MONITORAMENTO DE SAÚDE OPERACIONAL CONTINUADA</span>
                </div>
                <span className="text-[9px] font-mono text-slate-500 uppercase">Live Instrumentation telemetry</span>
              </div>

              {/* Instrumentation Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Event Loop & Engine health */}
                <div className="bg-slate-950 p-3.5 rounded-lg border border-slate-850 space-y-3 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between border-b border-slate-900 pb-1.5 mb-2">
                      <span className="text-[9px] font-mono text-slate-500 uppercase">V8 Runtime Engine Health</span>
                      <Cpu className="w-3.5 h-3.5 text-cyan-400" />
                    </div>
                    
                    <div className="space-y-2 font-mono text-[10px]">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Event Loop Lag:</span>
                        <span className={`font-bold ${eventLoopLag > 0.3 ? "text-amber-400" : "text-emerald-400"}`}>
                          {eventLoopLag} ms
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">V8 Heap Utilized:</span>
                        <span className="text-slate-200 font-bold">{ramUsage} MB / 512 MB</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Estabilidade GC Lag:</span>
                        <span className="text-emerald-400 font-bold">&lt; 0.08ms</span>
                      </div>
                    </div>
                  </div>
                  <div className="bg-slate-900/50 p-2 rounded text-[8px] font-mono text-slate-500 uppercase">
                    ✓ Event loop monitorizado em tempo real. Vazamentos de memória zerados.
                  </div>
                </div>

                {/* Network & RPC Health */}
                <div className="bg-slate-950 p-3.5 rounded-lg border border-slate-850 space-y-3 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center justify-between border-b border-slate-900 pb-1.5 mb-2">
                      <span className="text-[9px] font-mono text-slate-500 uppercase">Solana Edge Connection</span>
                      <Activity className="w-3.5 h-3.5 text-emerald-400" />
                    </div>

                    <div className="space-y-2 font-mono text-[10px]">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Yellowstone gRPC RTT:</span>
                        <span className={`font-bold ${
                          grpcLatency > 5.0 ? "text-rose-400 animate-pulse" : grpcLatency > 2.0 ? "text-amber-400" : "text-emerald-400"
                        }`}>
                          {grpcLatency} ms
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Landing RPC Success Rate:</span>
                        <span className={`font-bold ${rpcSuccessRate < 95 ? "text-amber-400" : "text-emerald-400"}`}>
                          {rpcSuccessRate}%
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Fibra Equinix Pipeline:</span>
                        <span className="text-emerald-400 font-bold">Ativa (10Gbps)</span>
                      </div>
                    </div>
                  </div>
                  <div className="bg-slate-900/50 p-2 rounded text-[8px] font-mono text-slate-500 uppercase">
                    ✓ Pipeline de fibra Equinix NY4 sintonizado com validadores primários.
                  </div>
                </div>
              </div>

              {/* Dynamic Health Chart Mock */}
              <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 space-y-2">
                <span className="text-[8.5px] font-mono text-slate-500 block uppercase">
                  INSTRUMENTAÇÃO DE SAÚDE OPERACIONAL CONTINUADA
                </span>
                
                {/* Visual indicator lines represent continuous ping tests */}
                <div className="flex gap-1 h-12 items-end pt-2 bg-slate-900/40 px-2 rounded-lg border border-slate-900">
                  {Array.from({ length: 48 }).map((_, i) => {
                    // Create some simulated noise for the bar graphs
                    const isHigh = i === 12 || i === 34;
                    const height = isHigh ? "h-10 bg-amber-500" : "h-6 bg-emerald-500/80";
                    return (
                      <div key={i} className={`flex-1 rounded-sm ${height} transition-all duration-300`} title="Ping check segment"></div>
                    );
                  })}
                </div>
                <div className="flex justify-between text-[7px] font-mono text-slate-500 uppercase pt-1">
                  <span>Há 5 minutos</span>
                  <span>Estável (99.99% compliance)</span>
                  <span>Agora (RTT: {grpcLatency}ms)</span>
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: IMMEDIATE DISASTER RECOVERY / ROLLBACK */}
          {activeTab === "rollback" && (
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-850 pb-2.5">
                <div className="flex items-center gap-2">
                  <RotateCcw className="w-4 h-4 text-rose-400" />
                  <span className="text-xs font-mono font-bold text-rose-400 uppercase">DISPOSITIVO DE DESASTRE OPERACIONAL E ROLLBACK</span>
                </div>
                <span className="text-[9px] font-mono text-slate-500 uppercase">Disaster Recovery & Circuit Breakers</span>
              </div>

              <div className="bg-rose-500/5 border border-rose-500/10 p-3.5 rounded-lg space-y-2">
                <div className="flex items-center gap-2 text-rose-400 text-xs font-mono font-bold uppercase">
                  <AlertTriangle className="w-4 h-4 text-rose-400" />
                  ATENÇÃO - ZONA DE ALTA SENSIBILIDADE OPERACIONAL
                </div>
                <p className="text-[10px] text-slate-400 font-mono leading-relaxed uppercase">
                  A AÇÃO DE ROLLBACK É IRREVERSÍVEL. AO DISPARAR, O SISTEMA ENTRARÁ IMEDIATAMENTE EM MODO READ-ONLY, OS CONTRATOS DO SNIPER EM PRODUÇÃO SERÃO DESATIVADOS NO PROGRAM ID, AS CHAVES DE ASSINATURA EM RAM SERÃO PURGADAS E TODOS OS BUNDLES PENDENTES NO MEMPOOL SERÃO CANCELADOS.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 space-y-1">
                  <span className="text-[9px] font-mono text-slate-400 font-extrabold uppercase">Ações do Rollback de Desastre:</span>
                  <ul className="space-y-1 text-[9px] font-mono text-slate-500 leading-normal uppercase">
                    <li>1. Desativação física de escrita no Program ID Solana.</li>
                    <li>2. Purga completa e criptográfica de chaves Ed25519 na cache de RAM.</li>
                    <li>3. Aborto forçado de Bundles e transações pendentes de Jito.</li>
                    <li>4. Desconexão física com Yellowstone gRPC para evitar overhead de rede.</li>
                    <li>5. Criação automática de log de incidente crítico para perícia legal.</li>
                  </ul>
                </div>

                <div className="bg-slate-950 p-4 rounded-lg border border-slate-850 flex flex-col justify-between text-center space-y-3">
                  <div>
                    <span className="text-[9px] font-mono text-slate-400 uppercase block font-bold">DISPARAR DISPOSITIVO</span>
                    <p className="text-[8px] text-slate-500 font-mono uppercase mt-1 leading-normal">
                      Requer aprovação imediata do broker principal on-chain.
                    </p>
                  </div>
                  <button
                    onClick={triggerEmergencyRollback}
                    className="px-4 py-2.5 bg-rose-600 hover:bg-rose-500 text-slate-100 font-mono font-black text-xs rounded-xl transition-all cursor-pointer glow-rose uppercase tracking-wider"
                  >
                    EXECUTAR ROLLBACK DE DISASTRE IMEDIATO
                  </button>
                  <span className="text-[7.5px] font-mono text-rose-400 font-bold uppercase animate-pulse">
                    ⚠️ MODO BOTÃO DE PÂNICO INTEGRADO
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* TAB 6: OPERATIONAL INCIDENT TRACKING */}
          {activeTab === "incidents" && (
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-850 pb-2.5">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400" />
                  <span className="text-xs font-mono font-bold text-slate-200">GERENCIAMENTO E RESPOSTA A INCIDENTES</span>
                </div>
                <span className="text-[9px] font-mono text-slate-500 uppercase">Live Incident Response</span>
              </div>

              {/* Simulation bar for injection */}
              <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 space-y-2">
                <div className="flex justify-between items-center text-[9px] font-mono text-slate-500 uppercase font-bold">
                  <span>Simulador de Injeção de Anomalias (Auto-Healing Test)</span>
                  <span className="text-cyan-400">Teste do L14</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => injectSimulatedIncident("grpc")}
                    className="py-1 px-2 text-[9px] font-mono font-bold rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 cursor-pointer transition-all"
                  >
                    Simular Queda gRPC (Critical)
                  </button>
                  <button
                    onClick={() => injectSimulatedIncident("slippage")}
                    className="py-1 px-2 text-[9px] font-mono font-bold rounded bg-orange-500/10 hover:bg-orange-500/20 text-orange-400 border border-orange-500/20 cursor-pointer transition-all"
                  >
                    Simular Queda de Landing (High)
                  </button>
                  <button
                    onClick={() => injectSimulatedIncident("jito")}
                    className="py-1 px-2 text-[9px] font-mono font-bold rounded bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/20 cursor-pointer transition-all"
                  >
                    Simular Jito Latência (Medium)
                  </button>
                </div>
              </div>

              {/* Incidentes List */}
              <div className="space-y-2">
                <div className="flex justify-between items-center border-b border-slate-900 pb-1 text-[8.5px] font-mono text-slate-500 uppercase">
                  <span>Fila de Incidentes Ativos/Histórico</span>
                  <button 
                    onClick={clearResolvedIncidents}
                    className="text-rose-400 hover:text-rose-300 flex items-center gap-1 cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" /> Limpar Resolvidos
                  </button>
                </div>

                {incidents.length === 0 ? (
                  <div className="bg-slate-950/40 border border-slate-850/60 p-8 rounded-lg text-center text-[10px] font-mono text-slate-500 uppercase">
                    Nenhum incidente ativo detectado. Operações com 100% de estabilidade.
                  </div>
                ) : (
                  <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                    {incidents.map((inc) => {
                      let sevColor = "text-slate-400 bg-slate-950 border-slate-850";
                      if (inc.severity === "critical") sevColor = "text-rose-400 bg-rose-500/10 border-rose-500/20";
                      if (inc.severity === "high") sevColor = "text-orange-400 bg-orange-500/10 border-orange-500/20";
                      if (inc.severity === "medium") sevColor = "text-amber-400 bg-amber-500/10 border-amber-500/20";

                      return (
                        <div key={inc.id} className="bg-slate-950 p-2.5 rounded-lg border border-slate-850 flex flex-col md:flex-row md:items-center justify-between gap-2.5 font-mono text-[10px]">
                          <div className="flex items-start gap-2.5">
                            <span className={`px-1.5 py-0.5 rounded border text-[8px] font-bold uppercase shrink-0 ${sevColor}`}>
                              {inc.severity}
                            </span>
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="text-slate-500 text-[8.5px]">[{inc.id}]</span>
                                <strong className="text-slate-200">{inc.service}</strong>
                                <span className="text-slate-600 text-[8.5px]">{inc.time}</span>
                              </div>
                              <p className="text-slate-400 text-[9.5px] mt-0.5">{inc.description}</p>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0 self-end md:self-auto">
                            <span className={`text-[8.5px] font-bold uppercase px-1.5 py-0.5 rounded ${
                              inc.status === "resolved" ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400 animate-pulse"
                            }`}>
                              {inc.status}
                            </span>
                            {inc.status === "active" && (
                              <button
                                onClick={() => resolveIncident(inc.id)}
                                className="px-2 py-0.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 rounded cursor-pointer text-[8px] uppercase"
                              >
                                Mitigar / Resolver
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 7: OPERATIONAL REPORTS & SLA COMPLIANCE */}
          {activeTab === "reports" && (
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-850 pb-2.5">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs font-mono font-bold text-slate-200">RELATÓRIOS SLA E ANALYTICS DE OPERAÇÃO</span>
                </div>
                <span className="text-[9px] font-mono text-slate-500 uppercase">SLA & Performance reporting</span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 text-center space-y-1">
                  <span className="text-[8.5px] font-mono text-slate-500 uppercase">Média Geral de Latência</span>
                  <span className="text-xl font-mono font-black text-emerald-400 block">1.12ms</span>
                  <span className="text-[8px] font-mono text-slate-500 uppercase">Meta contratual: &lt; 1.5ms</span>
                </div>

                <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 text-center space-y-1">
                  <span className="text-[8.5px] font-mono text-slate-500 uppercase">Total de Snipes Sucesso</span>
                  <span className="text-xl font-mono font-black text-cyan-400 block">{totalExecutedSnipes}</span>
                  <span className="text-[8px] font-mono text-slate-500 uppercase">Sucesso de Landing: 98.2%</span>
                </div>

                <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 text-center space-y-1">
                  <span className="text-[8.5px] font-mono text-slate-500 uppercase">Economia de Gas Estimada</span>
                  <span className="text-xl font-mono font-black text-purple-400 block">{savingsInGasSol} SOL</span>
                  <span className="text-[8px] font-mono text-slate-500 uppercase">bundles privados otimizados</span>
                </div>
              </div>

              {/* Exporte Audit details */}
              <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 space-y-2.5">
                <span className="text-[9px] font-mono text-slate-500 block uppercase font-bold border-b border-slate-900 pb-1">
                  Exportar Audit Técnico (Formato Regulatório)
                </span>
                
                <p className="text-[10px] text-slate-400 font-sans leading-relaxed">
                  Gere o PDF de conformidade militar operacional contendo logs de deploy, baseline computado da rede Solana, histórico de incidentes mitigados pelo L14 e o score de validação PRR do L13.
                </p>

                <div className="flex justify-between items-center bg-slate-900 p-2.5 rounded border border-slate-850">
                  <span className="text-[9px] font-mono text-slate-300">Format: PDF-Compliance (SLA-Verified-1.2)</span>
                  <button
                    onClick={() => {
                      alert("Relatório de auditoria gerado com sucesso! Arquivo exportado para o console de segurança.");
                    }}
                    className="px-3 py-1 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[9.5px] font-mono font-bold rounded flex items-center gap-1 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" /> Exportar Relatório
                  </button>
                </div>
              </div>
            </div>
          )}

        </div>

        {/* Right Panel: Operator Cockpit Sidebar (L14 Operations Desk) */}
        <div className="lg:col-span-4 space-y-4">
          
          {/* Active site incident watch */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-850 pb-2">
              <span className="text-xs font-mono font-bold text-slate-200 flex items-center gap-1.5">
                <Terminal className="w-4 h-4 text-emerald-400" />
                CONTROLE OPERACIONAL L14
              </span>
              <span className="text-[8px] font-mono text-slate-500 uppercase">Live Watch</span>
            </div>

            <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 space-y-2.5 font-mono text-[9.5px]">
              <span className="text-[8px] text-slate-500 block uppercase font-bold">Estado dos Parâmetros Mainnet</span>
              
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-400">gRPC Provider:</span>
                  <span className="text-emerald-400 font-bold uppercase">Yellowstone Supernode</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Jito MEV Bundler:</span>
                  <span className="text-emerald-400 font-bold uppercase">Active & Optimized</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Circuit Breakers:</span>
                  <span className="text-emerald-400 font-bold uppercase">Filtros Ativos</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Wallet rotation:</span>
                  <span className="text-cyan-400 font-bold uppercase">8 Hot Wallets active</span>
                </div>
              </div>
            </div>

            {/* Simulated Disaster Check Indicators */}
            <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 space-y-2">
              <span className="text-[8px] text-slate-500 block uppercase font-bold">Disjuntores Operacionais</span>
              <div className="grid grid-cols-2 gap-1.5 font-mono text-[8.5px]">
                <div className="p-1 bg-slate-900 border border-slate-850 rounded flex justify-between items-center">
                  <span className="text-slate-400">Slippage Guard:</span>
                  <span className="text-emerald-400 font-bold">OK</span>
                </div>
                <div className="p-1 bg-slate-900 border border-slate-850 rounded flex justify-between items-center">
                  <span className="text-slate-400">RAM Safety:</span>
                  <span className="text-emerald-400 font-bold">OK</span>
                </div>
                <div className="p-1 bg-slate-900 border border-slate-850 rounded flex justify-between items-center">
                  <span className="text-slate-400">RPC Fail Guard:</span>
                  <span className="text-emerald-400 font-bold">OK</span>
                </div>
                <div className="p-1 bg-slate-900 border border-slate-850 rounded flex justify-between items-center">
                  <span className="text-slate-400">Honeypot Guard:</span>
                  <span className="text-emerald-400 font-bold">OK</span>
                </div>
              </div>
            </div>

            {/* Quick alert bar */}
            {isHealthDegraded ? (
              <div className="bg-rose-500/15 border border-rose-500/30 p-2.5 rounded-lg text-[9px] font-mono text-rose-400 flex items-center gap-2 animate-pulse uppercase leading-tight">
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>Alerta: Saúde degradada! Verifique a aba de Incidentes para mitigar anomalias.</span>
              </div>
            ) : (
              <div className="bg-emerald-500/5 border border-emerald-500/15 p-2.5 rounded-lg text-[9px] font-mono text-emerald-400 flex items-center gap-2 uppercase leading-tight">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>Operação nominal. Prontidão operacional total (L14 Center).</span>
              </div>
            )}
          </div>

          {/* Quick Stats Summary Card */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 space-y-2.5">
            <span className="text-xs font-mono font-bold text-slate-200 block border-b border-slate-850 pb-1.5">
              INFRAESTRUTURA DE RETAGUARDA
            </span>
            <div className="space-y-1.5 font-mono text-[9px] leading-normal uppercase text-slate-400">
              <div className="flex justify-between">
                <span>Plataforma:</span>
                <span className="text-slate-200 font-bold">Solana Mainnet-Beta</span>
              </div>
              <div className="flex justify-between">
                <span>Datacenter:</span>
                <span className="text-slate-200 font-bold">Equinix NY4 (Ashburn)</span>
              </div>
              <div className="flex justify-between">
                <span>Inclusão Jito BlockEngine:</span>
                <span className="text-emerald-400 font-bold">Sim (Private Bundles)</span>
              </div>
              <div className="flex justify-between">
                <span>Controle de Ofuscação:</span>
                <span className="text-emerald-400 font-bold">Ativado (8 Keypairs)</span>
              </div>
            </div>
          </div>

        </div>

      </div>

    </div>
  );
}
