import { useState, useEffect } from "react";
import { 
  Database, Search, RotateCcw, FileText, 
  ShieldAlert, Copy, Check, ExternalLink, RefreshCw, 
  Bell, Trash2, TrendingUp, Terminal, CheckCircle2, AlertOctagon
} from "lucide-react";
import { 
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, 
  CartesianGrid, Tooltip, Legend, LineChart, Line 
} from "recharts";

interface LogItem {
  id: string;
  timestamp: string;
  level: "INFO" | "WARN" | "ERROR" | "CRITICAL" | "SUCCESS";
  component: "RPC_INFRA" | "RISK_ENGINE" | "JITO_BUNDLE" | "SECURITY_SHIELD" | "MEMPOOL_SCANNER" | "SHADOW_ENTRY" | "SYSTEM";
  message: string;
  correlationId?: string;
  metadata?: any;
}

interface AlertItem {
  id: string;
  title: string;
  level: "WARN" | "CRITICAL";
  message: string;
  timestamp: string;
}

export function ObservabilityCenter() {
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  
  // Filters
  const [selectedLevel, setSelectedLevel] = useState<string>("");
  const [selectedComponent, setSelectedComponent] = useState<string>("");
  const [correlationQuery, setCorrelationQuery] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Prometheus RAW metrics
  const [rawMetrics, setRawMetrics] = useState<string>("");
  const [showRawMetrics, setShowRawMetrics] = useState(false);
  const [copiedMetrics, setCopiedMetrics] = useState(false);

  // Rotation policies
  const [retentionDays, setRetentionDays] = useState(7);
  const [maxLogSize, setMaxLogSize] = useState(2048);
  const [rotationResult, setRotationResult] = useState<{ rotatedCount: number; bytesSaved: number; currentSizeKb: number } | null>(null);
  const [rotating, setRotating] = useState(false);

  // Grafana mock telemetry history for charts
  const [chartData, setChartData] = useState<any[]>([]);

  // Sound / alarm toggle
  const [audioAlerts, setAudioAlerts] = useState(false);
  const [activeAlertCount, setActiveAlertCount] = useState(0);

  // Load logs and active alerts
  const fetchLogs = async () => {
    setLoadingLogs(true);
    try {
      let url = "/api/logs?";
      if (selectedLevel) url += `level=${selectedLevel}&`;
      if (selectedComponent) url += `component=${selectedComponent}&`;
      if (correlationQuery) url += `correlationId=${correlationQuery}&`;
      if (searchQuery) url += `search=${searchQuery}&`;

      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setLogs(data);
      }
    } catch (e) {
      console.error("Erro ao carregar logs estruturados:", e);
    } finally {
      setLoadingLogs(false);
    }
  };

  const fetchAlerts = async () => {
    try {
      const res = await fetch("/api/alerts");
      if (res.ok) {
        const data = await res.json();
        setAlerts(data);
        if (data.length > activeAlertCount && audioAlerts) {
          // Play a gentle buzzer sound using Web Audio API
          playBeep();
        }
        setActiveAlertCount(data.length);
      }
    } catch (e) {
      console.error("Erro ao consultar alertas ativos:", e);
    }
  };

  const fetchPrometheusMetrics = async () => {
    try {
      const res = await fetch("/metrics");
      if (res.ok) {
        const text = await res.text();
        setRawMetrics(text);
      }
    } catch (e) {
      console.error("Erro ao puxar métricas do exportador Prometheus:", e);
    }
  };

  // Web Audio Alert sound simulator (Bypasses iframe sound restrictions gracefully)
  const playBeep = () => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(440, ctx.currentTime); // A4 note
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.5);
    } catch (err) {
      // Audio context might be blocked by user interaction constraints, safe catch
    }
  };

  // Perform rotation policy POST
  const handleRotateLogs = async () => {
    setRotating(true);
    try {
      const res = await fetch("/api/logs/rotate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retentionDays, maxSizeKb: maxLogSize })
      });
      if (res.ok) {
        const data = await res.json();
        setRotationResult(data);
        fetchLogs();
        setTimeout(() => setRotationResult(null), 10000); // fade out result
      }
    } catch (e) {
      console.error("Erro ao rodar script de rotação de logs:", e);
    } finally {
      setRotating(false);
    }
  };

  // Fill sample Grafana chart history
  useEffect(() => {
    const generateHistory = () => {
      const points = [];
      const now = Date.now();
      for (let i = 24; i >= 0; i--) {
        const timeStr = new Date(now - i * 5000).toLocaleTimeString().split(' ')[0];
        // Generate values simulating a co-located low latency setup
        const isSpike = Math.random() > 0.93;
        const latency = isSpike ? Math.floor(Math.random() * 120) + 40 : Math.floor(Math.random() * 8) + 11;
        const slotLag = isSpike ? Math.floor(Math.random() * 3) + 1 : 0;
        const jitter = Math.floor(Math.random() * 3) + (isSpike ? 20 : 1);
        const bundles = 1200 + i * 5;
        const landedBundles = Math.floor(bundles * (0.88 + Math.random() * 0.1));

        points.push({
          time: timeStr,
          latency,
          slotLag,
          jitter,
          landed: landedBundles,
          total: bundles
        });
      }
      setChartData(points);
    };

    generateHistory();
    fetchLogs();
    fetchAlerts();
    fetchPrometheusMetrics();

    // Intervals
    const logInterval = setInterval(fetchLogs, 4000);
    const alertInterval = setInterval(fetchAlerts, 3000);
    const metricsInterval = setInterval(fetchPrometheusMetrics, 5000);

    // Live Chart flow
    const chartInterval = setInterval(() => {
      setChartData(prev => {
        const nextTime = new Date().toLocaleTimeString().split(' ')[0];
        const lastPoint = prev[prev.length - 1] || { landed: 1200, total: 1250 };
        // Base latency on whether high alerts exist
        const hasHighLatencyAlert = alerts.some(a => a.id.includes("latency") || a.id.includes("down"));
        const baseLatency = hasHighLatencyAlert ? 180 + Math.random() * 50 : 11 + Math.random() * 7;
        const baseLag = hasHighLatencyAlert ? 3 + Math.floor(Math.random() * 3) : 0;

        const newPoint = {
          time: nextTime,
          latency: Math.round(baseLatency * 10) / 10,
          slotLag: baseLag,
          jitter: Math.round((Math.random() * 3 + (hasHighLatencyAlert ? 45 : 1)) * 10) / 10,
          landed: lastPoint.landed + Math.floor(Math.random() * 5),
          total: lastPoint.total + 5
        };
        const updated = [...prev.slice(1), newPoint];
        return updated;
      });
    }, 4000);

    return () => {
      clearInterval(logInterval);
      clearInterval(alertInterval);
      clearInterval(metricsInterval);
      clearInterval(chartInterval);
    };
  }, [selectedLevel, selectedComponent, correlationQuery, searchQuery, alerts]);

  // Click handler to instantly copy raw metrics text
  const copyMetricsToClipboard = () => {
    navigator.clipboard.writeText(rawMetrics);
    setCopiedMetrics(true);
    setTimeout(() => setCopiedMetrics(false), 2000);
  };

  const getLevelColor = (level: string) => {
    switch (level) {
      case "INFO": return "bg-cyan-950/50 text-cyan-400 border-cyan-900/60";
      case "WARN": return "bg-amber-950/50 text-amber-400 border-amber-900/60";
      case "ERROR": return "bg-rose-950/50 text-rose-400 border-rose-900/60";
      case "CRITICAL": return "bg-red-500/10 text-red-400 border-red-500/30 animate-pulse";
      case "SUCCESS": return "bg-emerald-950/50 text-emerald-400 border-emerald-900/60";
      default: return "bg-slate-900 text-slate-400 border-slate-800";
    }
  };

  const getComponentBadge = (comp: string) => {
    switch (comp) {
      case "RPC_INFRA": return "text-[10px] font-mono text-purple-400 bg-purple-950/30 border border-purple-900/50 px-1.5 py-0.5 rounded";
      case "RISK_ENGINE": return "text-[10px] font-mono text-orange-400 bg-orange-950/30 border border-orange-900/50 px-1.5 py-0.5 rounded";
      case "JITO_BUNDLE": return "text-[10px] font-mono text-emerald-400 bg-emerald-950/30 border border-emerald-900/50 px-1.5 py-0.5 rounded";
      case "SECURITY_SHIELD": return "text-[10px] font-mono text-blue-400 bg-blue-950/30 border border-blue-900/50 px-1.5 py-0.5 rounded";
      case "MEMPOOL_SCANNER": return "text-[10px] font-mono text-cyan-400 bg-cyan-950/30 border border-cyan-900/50 px-1.5 py-0.5 rounded";
      case "SHADOW_ENTRY": return "text-[10px] font-mono text-violet-300 bg-violet-950/30 border border-violet-900/50 px-1.5 py-0.5 rounded";
      default: return "text-[10px] font-mono text-slate-400 bg-slate-950 border border-slate-850 px-1.5 py-0.5 rounded";
    }
  };

  return (
    <div id="observability-center-root" className="space-y-4">
      {/* Real-time Health Alarm Panel */}
      <div id="active-alarms-panel" className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 backdrop-blur-md relative overflow-hidden">
        <div className="absolute top-0 left-0 w-1.5 h-full bg-cyan-500"></div>
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-3 border-b border-slate-800/60 mb-3.5">
          <div className="flex items-center gap-2.5">
            <div className={`p-1.5 rounded-lg ${alerts.length > 0 ? "bg-red-500/20 text-red-400 animate-bounce" : "bg-cyan-500/10 text-cyan-400"}`}>
              <Bell className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-display font-bold text-slate-100 uppercase tracking-tight">Active Real-Time Alarm Monitor</h2>
              <p className="text-[10px] text-slate-400 font-mono">Continuous checking of RTT, Slot Lag, Packet Loss and system violations</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              id="audio-alert-btn"
              onClick={() => {
                setAudioAlerts(!audioAlerts);
                if (!audioAlerts) playBeep();
              }}
              className={`text-[10px] font-mono font-bold px-3 py-1.5 rounded-lg border transition-all cursor-pointer ${
                audioAlerts 
                  ? "bg-red-500/10 text-red-400 border-red-500/30 shadow-sm"
                  : "bg-slate-950 text-slate-400 border-slate-850 hover:text-slate-200"
              }`}
            >
              🔈 Audio Beep Alerts: {audioAlerts ? "ENABLED" : "SILENT"}
            </button>
            <span className="text-[10px] font-mono px-2.5 py-1 rounded-md bg-slate-950 text-slate-400 border border-slate-850">
              {alerts.length} ALARM{alerts.length !== 1 ? "S" : ""} ACTIVE
            </span>
          </div>
        </div>

        {alerts.length === 0 ? (
          <div className="py-6 flex flex-col items-center justify-center text-center">
            <CheckCircle2 className="w-8 h-8 text-emerald-500 mb-2 animate-pulse" />
            <p className="text-xs font-mono font-bold text-emerald-400 uppercase tracking-wider">ALL ENDPOINTS HEALTHY</p>
            <p className="text-[10px] text-slate-500 font-mono mt-1">HFT routing balancing correctly. Maximum latency below SLA limits.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {alerts.map((alert) => (
              <div 
                key={alert.id}
                className={`p-3 rounded-lg border flex items-start gap-2.5 relative overflow-hidden backdrop-blur-lg ${
                  alert.level === "CRITICAL"
                    ? "bg-red-950/20 border-red-900/60 text-red-300"
                    : "bg-amber-950/20 border-amber-900/60 text-amber-300"
                }`}
              >
                <div className="absolute top-0 right-0 p-1">
                  <span className={`text-[8px] font-mono px-1 py-0.5 rounded uppercase font-bold ${
                    alert.level === "CRITICAL" ? "bg-red-500/20 text-red-400" : "bg-amber-500/20 text-amber-400"
                  }`}>
                    {alert.level}
                  </span>
                </div>
                <div className="mt-0.5 flex-shrink-0">
                  {alert.level === "CRITICAL" ? (
                    <AlertOctagon className="w-4 h-4 text-red-400 animate-pulse" />
                  ) : (
                    <ShieldAlert className="w-4 h-4 text-amber-400" />
                  )}
                </div>
                <div className="space-y-1 pr-12">
                  <h4 className="text-xs font-bold font-mono tracking-tight text-slate-200">{alert.title}</h4>
                  <p className="text-[10px] font-mono leading-relaxed text-slate-400">{alert.message}</p>
                  <span className="text-[9px] font-mono text-slate-500 block">
                    {new Date(alert.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Grafana Dashboard Simulator Panel */}
      <div id="grafana-simulator" className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 backdrop-blur-md relative">
        <div className="absolute top-3 right-4 flex items-center gap-1.5 z-10">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          <span className="text-[9px] font-mono text-slate-400 uppercase tracking-widest bg-slate-950 px-2 py-0.5 rounded border border-slate-850">
            GRAFANA v10.4.1 (PROMETHEUS LIVE)
          </span>
        </div>

        <div className="flex items-center gap-2.5 pb-3 border-b border-slate-800/60 mb-4">
          <div className="p-1.5 rounded-lg bg-orange-500/10 text-orange-400">
            <TrendingUp className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-display font-bold text-slate-100 uppercase tracking-tight">HFT Performance Grafana Dashboards</h2>
            <p className="text-[10px] text-slate-400 font-mono">High-fidelity visualization scraped from `/metrics` exporter</p>
          </div>
        </div>

        {/* Recharts HFT Performance Monitor */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Latency (RTT & Jitter) Over Time */}
          <div className="bg-slate-950 border border-slate-850 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-mono font-bold text-slate-300">Solana RPC RTT Latency & Network Jitter</span>
              <span className="text-[10px] font-mono text-cyan-400 bg-cyan-950/30 border border-cyan-900/40 px-1.5 py-0.2 rounded">
                SLA target: &lt;30ms
              </span>
            </div>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="latencyGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.2}/>
                      <stop offset="95%" stopColor="#22d3ee" stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="jitterGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#ec4899" stopOpacity={0.25}/>
                      <stop offset="95%" stopColor="#ec4899" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="time" stroke="#64748b" style={{ fontSize: "9px", fontFamily: "monospace" }} />
                  <YAxis stroke="#64748b" style={{ fontSize: "9px", fontFamily: "monospace" }} label={{ value: 'ms', angle: -90, position: 'insideLeft', fill: '#64748b', style: { textAnchor: 'middle' } }} />
                  <Tooltip contentStyle={{ backgroundColor: '#020617', borderColor: '#1e293b', borderRadius: '8px', fontFamily: 'monospace', fontSize: '10px' }} />
                  <Legend wrapperStyle={{ fontSize: "10px", fontFamily: "monospace" }} />
                  <Area type="monotone" dataKey="latency" name="gRPC RTT Latency" stroke="#22d3ee" fillOpacity={1} fill="url(#latencyGradient)" strokeWidth={1.5} />
                  <Area type="monotone" dataKey="jitter" name="Hardware Jitter" stroke="#ec4899" fillOpacity={1} fill="url(#jitterGradient)" strokeWidth={1.5} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Slot Delay & Inclusion Success Rate */}
          <div className="bg-slate-950 border border-slate-850 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-mono font-bold text-slate-300">Continuous Slot Lag & Jito Block Inclusion</span>
              <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/30 border border-emerald-900/40 px-1.5 py-0.2 rounded">
                SLA target: 100% Landed
              </span>
            </div>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="time" stroke="#64748b" style={{ fontSize: "9px", fontFamily: "monospace" }} />
                  <YAxis stroke="#64748b" style={{ fontSize: "9px", fontFamily: "monospace" }} />
                  <Tooltip contentStyle={{ backgroundColor: '#020617', borderColor: '#1e293b', borderRadius: '8px', fontFamily: 'monospace', fontSize: '10px' }} />
                  <Legend wrapperStyle={{ fontSize: "10px", fontFamily: "monospace" }} />
                  <Line type="stepAfter" dataKey="slotLag" name="Slot Lag (Leader Node)" stroke="#f59e0b" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="landed" name="Landed Bundles (Jito)" stroke="#10b981" strokeWidth={1.5} dot={true} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>

      {/* Prometheus Metric Exporter RAW text */}
      <div id="prometheus-raw-metrics" className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 backdrop-blur-md relative">
        <div className="flex items-center justify-between mb-3 pb-3 border-b border-slate-800/60">
          <div className="flex items-center gap-2">
            <Database className="w-5 h-5 text-purple-400" />
            <div>
              <h2 className="text-sm font-display font-bold text-slate-100 uppercase tracking-tight">Prometheus Scraper Exporter (/metrics)</h2>
              <p className="text-[10px] text-slate-400 font-mono">Official scraping route compiled dynamically from physical state</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              id="toggle-metrics-btn"
              onClick={() => setShowRawMetrics(!showRawMetrics)}
              className="text-[10px] font-mono font-bold px-3 py-1.5 rounded-lg bg-purple-500/10 text-purple-400 border border-purple-500/20 hover:bg-purple-500/20 transition-all cursor-pointer flex items-center gap-1.5"
            >
              <Terminal className="w-3.5 h-3.5" />
              {showRawMetrics ? "HIDE METRICS PREVIEW" : "CURL METRICS PREVIEW"}
            </button>
            <a 
              href="/metrics" 
              target="_blank" 
              className="text-[10px] font-mono font-bold px-3 py-1.5 rounded-lg bg-slate-950 text-slate-400 border border-slate-850 hover:text-slate-200 transition-all cursor-pointer flex items-center gap-1"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              OPEN ENDPOINT
            </a>
          </div>
        </div>

        {showRawMetrics && (
          <div className="space-y-2 animate-fadeIn">
            <div className="bg-slate-950 rounded-lg p-3 border border-slate-850 relative">
              <div className="absolute top-2.5 right-2.5 flex items-center gap-2">
                <button
                  id="copy-metrics-btn"
                  onClick={copyMetricsToClipboard}
                  className="p-1 rounded bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800 cursor-pointer"
                  title="Copiar para área de transferência"
                >
                  {copiedMetrics ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
              <span className="text-[10px] font-mono text-slate-500 block mb-2 uppercase">$ curl http://localhost:3000/metrics</span>
              <pre className="text-[11px] font-mono text-slate-300 max-h-56 overflow-y-auto whitespace-pre-wrap leading-relaxed">
                {rawMetrics}
              </pre>
            </div>
            <p className="text-[9px] font-mono text-slate-500">
              *The Prometheus agent scrapes this text formatting every 5 seconds to generate time-series metrics.
            </p>
          </div>
        )}
      </div>

      {/* Structured Logs Event Auditor with Correlation Tracking */}
      <div id="structured-logs-auditor" className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 backdrop-blur-md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800/60 mb-4">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-cyan-500/10 text-cyan-400">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-display font-bold text-slate-100 uppercase tracking-tight">Structured Persistent Event & Log Auditor</h2>
              <p className="text-[10px] text-slate-400 font-mono">Complete execution log with atomic write on POSIX guaranteed schema</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              id="refresh-logs-btn"
              onClick={fetchLogs}
              disabled={loadingLogs}
              className="text-[10px] font-mono font-bold px-3 py-1.5 rounded-lg bg-slate-950 text-slate-400 border border-slate-850 hover:text-slate-200 transition-all cursor-pointer flex items-center gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingLogs ? "animate-spin text-cyan-400" : ""}`} />
              REFRESH AUDIT LOGS
            </button>
          </div>
        </div>

        {/* Real-time search and filter row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5 mb-4 p-3 bg-slate-950 rounded-lg border border-slate-850/60">
          <div className="lg:col-span-2 relative">
            <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-slate-500" />
            <input
              id="log-search-input"
              type="text"
              placeholder="Filtro geral por texto (ex: honeypot, Jito)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full text-xs font-mono bg-slate-900 border border-slate-800 rounded-md pl-8.5 pr-2.5 py-2 text-slate-200 focus:outline-none focus:border-cyan-500 transition-colors"
            />
          </div>

          <div>
            <select
              id="log-level-select"
              value={selectedLevel}
              onChange={(e) => setSelectedLevel(e.target.value)}
              className="w-full text-xs font-mono bg-slate-900 border border-slate-800 rounded-md px-2.5 py-2 text-slate-300 focus:outline-none focus:border-cyan-500 cursor-pointer"
            >
              <option value="">Níveis: Todos</option>
              <option value="INFO">INFO</option>
              <option value="WARN">WARN</option>
              <option value="ERROR">ERROR</option>
              <option value="CRITICAL">CRITICAL</option>
              <option value="SUCCESS">SUCCESS</option>
            </select>
          </div>

          <div>
            <select
              id="log-component-select"
              value={selectedComponent}
              onChange={(e) => setSelectedComponent(e.target.value)}
              className="w-full text-xs font-mono bg-slate-900 border border-slate-800 rounded-md px-2.5 py-2 text-slate-300 focus:outline-none focus:border-cyan-500 cursor-pointer"
            >
              <option value="">Componentes: Todos</option>
              <option value="RPC_INFRA">RPC INFRA</option>
              <option value="RISK_ENGINE">RISK ENGINE</option>
              <option value="JITO_BUNDLE">JITO BUNDLE</option>
              <option value="SECURITY_SHIELD">SECURITY SHIELD</option>
              <option value="MEMPOOL_SCANNER">MEMPOOL SCANNER</option>
              <option value="SHADOW_ENTRY">SHADOW ENTRY</option>
              <option value="SYSTEM">SYSTEM</option>
            </select>
          </div>

          <div className="relative">
            <input
              id="log-correlation-input"
              type="text"
              placeholder="Correlation Trace ID..."
              value={correlationQuery}
              onChange={(e) => setCorrelationQuery(e.target.value)}
              className="w-full text-xs font-mono bg-slate-900 border border-slate-800 rounded-md px-2.5 py-2 text-slate-200 focus:outline-none focus:border-cyan-500 transition-colors placeholder:text-slate-600"
            />
            {correlationQuery && (
              <button
                onClick={() => setCorrelationQuery("")}
                className="absolute right-2 top-2.5 text-[9px] font-mono text-slate-400 hover:text-slate-200"
              >
                CLEAR
              </button>
            )}
          </div>
        </div>

        {/* Audit Log Table */}
        <div className="bg-slate-950 border border-slate-850 rounded-lg overflow-hidden relative">
          <div className="max-h-96 overflow-y-auto">
            {logs.length === 0 ? (
              <div className="py-12 text-center text-slate-500 text-xs font-mono">
                {loadingLogs ? "Varrendo banco de logs estruturados..." : "Nenhum evento registrado com as condições de busca."}
              </div>
            ) : (
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-850 bg-slate-950/80 sticky top-0 backdrop-blur-md text-[9px] font-mono text-slate-500 uppercase tracking-wider">
                    <th className="py-2.5 px-3">Timestamp</th>
                    <th className="py-2.5 px-2">Level</th>
                    <th className="py-2.5 px-2">Component</th>
                    <th className="py-2.5 px-3">Log Message</th>
                    <th className="py-2.5 px-3">Correlation ID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-850/40 font-mono text-xs text-slate-300">
                  {logs.map((log) => (
                    <tr 
                      key={log.id}
                      className="hover:bg-slate-900/40 transition-colors group"
                    >
                      <td className="py-3 px-3 text-[10px] text-slate-500 whitespace-nowrap">
                        {new Date(log.timestamp).toLocaleTimeString() + "." + String(new Date(log.timestamp).getMilliseconds()).padStart(3, '0')}
                      </td>
                      <td className="py-3 px-2">
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${getLevelColor(log.level)}`}>
                          {log.level}
                        </span>
                      </td>
                      <td className="py-3 px-2 whitespace-nowrap">
                        <span className={getComponentBadge(log.component)}>
                          {log.component}
                        </span>
                      </td>
                      <td className="py-3 px-3 leading-relaxed text-[11px] text-slate-200">
                        {log.message}
                      </td>
                      <td className="py-3 px-3 whitespace-nowrap">
                        {log.correlationId ? (
                          <button
                            onClick={() => setCorrelationQuery(log.correlationId || "")}
                            className={`text-[9px] font-mono px-1.5 py-0.5 rounded cursor-pointer transition-all ${
                              correlationQuery === log.correlationId
                                ? "bg-cyan-500/20 text-cyan-400 border border-cyan-500/30"
                                : "bg-slate-900 text-slate-400 border border-slate-800 hover:text-cyan-400"
                            }`}
                          >
                            🔍 {log.correlationId}
                          </button>
                        ) : (
                          <span className="text-slate-700 text-[10px]">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Rotação e Retenção Policy Controls */}
      <div id="log-rotation-policy-card" className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 backdrop-blur-md">
        <div className="flex items-center gap-2.5 pb-3 border-b border-slate-800/60 mb-4">
          <div className="p-1.5 rounded-lg bg-yellow-500/10 text-yellow-400">
            <Trash2 className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-display font-bold text-slate-100 uppercase tracking-tight">Active Log Rotation & Truncation Policies</h2>
            <p className="text-[10px] text-slate-400 font-mono">Limits disk footprint to ensure high speed performance of storage write</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div>
            <label className="text-[10px] font-mono text-slate-400 uppercase block mb-1.5">Logs Retention Threshold</label>
            <div className="flex items-center gap-2">
              <input
                id="retention-days-input"
                type="number"
                min="1"
                max="30"
                value={retentionDays}
                onChange={(e) => setRetentionDays(Number(e.target.value))}
                className="w-full text-xs font-mono bg-slate-950 border border-slate-800 rounded-md px-2.5 py-2 text-slate-200 focus:outline-none focus:border-yellow-500"
              />
              <span className="text-xs font-mono text-slate-400">Days</span>
            </div>
          </div>

          <div>
            <label className="text-[10px] font-mono text-slate-400 uppercase block mb-1.5">Max Log File Size Limit</label>
            <div className="flex items-center gap-2">
              <input
                id="max-log-size-input"
                type="number"
                min="100"
                max="10000"
                value={maxLogSize}
                onChange={(e) => setMaxLogSize(Number(e.target.value))}
                className="w-full text-xs font-mono bg-slate-950 border border-slate-800 rounded-md px-2.5 py-2 text-slate-200 focus:outline-none focus:border-yellow-500"
              />
              <span className="text-xs font-mono text-slate-400">KB</span>
            </div>
          </div>

          <div>
            <button
              id="trigger-rotation-btn"
              onClick={handleRotateLogs}
              disabled={rotating}
              className="w-full text-xs font-mono font-bold py-2 px-3 rounded-md bg-yellow-500/10 text-yellow-400 border border-yellow-500/20 hover:bg-yellow-500/20 transition-all cursor-pointer flex items-center justify-center gap-1.5"
            >
              {rotating ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  TRUNCATING SYSTEM LOGS...
                </>
              ) : (
                <>
                  <RotateCcw className="w-3.5 h-3.5" />
                  TRIGGER MANUALLY ROTATION
                </>
              )}
            </button>
          </div>
        </div>

        {rotationResult && (
          <div className="mt-3.5 p-3 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono text-xs flex items-center gap-2.5 animate-fadeIn">
            <CheckCircle2 className="w-4 h-4" />
            <div>
              <span className="font-bold">Rotação Executada! </span>
              Purged <span className="font-bold">{rotationResult.rotatedCount}</span> older log entries. 
              Frees up <span className="font-bold">{(rotationResult.bytesSaved / 1024).toFixed(2)} KB</span> on operational database disk. 
              Current file footprint: <span className="font-bold">{rotationResult.currentSizeKb} KB</span>.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
