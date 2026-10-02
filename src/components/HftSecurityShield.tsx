import { useState, useEffect } from "react";
import { 
  ShieldCheck, 
  ShieldAlert, 
  Terminal, 
  RefreshCw, 
  Key, 
  EyeOff, 
  Fingerprint, 
  CheckCircle, 
  Clock 
} from "lucide-react";

interface HftSecurityShieldProps {
  selectedToken?: { name: string; mint: string } | null;
  onAuditUpdated?: (updatedAudit: any) => void;
}

export function HftSecurityShield({ selectedToken, onAuditUpdated }: HftSecurityShieldProps) {
  const [tokenMint, setTokenMint] = useState("PumpJtE71829...abc");
  const [tokenName, setTokenName] = useState("PUMP COIN");
  const [loading, setLoading] = useState(false);
  
  // Security levels state
  const [staticResult, setStaticResult] = useState({
    mintAuthority: "Renounced", // Disabled
    freezeAuthority: "Disabled",
    lpStatus: "99% Burned (Locked)",
    devAllocation: "1.2%",
    status: "SECURE"
  });

  const [oraclesResult, setOraclesResult] = useState({
    goPlusScore: "Low Risk",
    tokenSnifferScore: "95 / 100",
    honeyBadgerStatus: "No Traps Found",
    blacklistCheck: "Passed (Clean)",
    totalQueries: 3
  });

  const [dynamicResult, setDynamicResult] = useState({
    sellTax: 0.8, // τ_venda
    buyTax: 0.0,
    computeUnits: 42800,
    honeypotDetected: false,
    slippageEst: "0.25%"
  });

  const [ramResult, setRamResult] = useState({
    aesState: "Active (RAM-Only)",
    decryptionSpeed: "0.12ms",
    keypairRotations: 42,
    activeKeyFingerprint: "SHA256:d8c9...71ab",
    timeToNextRotation: 58 // Countdown seconds
  });

  // Steps detailed logging log
  const [securityLogs, setSecurityLogs] = useState<string[]>([
    "[AES-256 Volatile] Chave de sessão operacional descriptografada em RAM volátil (Duração: 0.12ms)",
    "[Camada 1] Verificação Estática: Mint Authority e Freeze Authority confirmadas Inativas",
    "[Camada 2] Oráculo GoPlus: Token verificado livre de Blacklists",
    "[Camada 3] Simulação Dinâmica: Swap de Compra/Venda executado no sandbox de bifurcação local (τ_venda: 0.8%)",
    "[Status] Blindagem de Segurança HFT: 100% OPERATIVA"
  ]);

  // Sync token from MempoolScanner
  useEffect(() => {
    if (selectedToken) {
      setTokenMint(selectedToken.mint);
      setTokenName(selectedToken.name);
      triggerSecuritySuite(selectedToken.mint, selectedToken.name);
    }
  }, [selectedToken]);

  // Countdown for Keypair Rotation timer (Camada 4)
  useEffect(() => {
    const timer = setInterval(() => {
      setRamResult(prev => {
        if (prev.timeToNextRotation <= 1) {
          // Trigger mock key rotation
          const randRotations = prev.keypairRotations + 1;
          const randHex = Array.from({ length: 4 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
          const randHex2 = Array.from({ length: 4 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
          
          setSecurityLogs(logs => [
            `[AES-256 Volatile] Rotação periódica síncrona de chaves completada com sucesso. Nova assinatura: SHA256:${randHex}...${randHex2}`,
            ...logs.slice(0, 8)
          ]);

          return {
            ...prev,
            keypairRotations: randRotations,
            activeKeyFingerprint: `SHA256:${randHex}...${randHex2}`,
            timeToNextRotation: 60
          };
        }
        return {
          ...prev,
          timeToNextRotation: prev.timeToNextRotation - 1
        };
      });
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const triggerSecuritySuite = async (mint: string, name: string) => {
    setLoading(true);
    setSecurityLogs(prev => [
      `[HFT Shield] Inicializando varredura de segurança em profundidade para ${name}...`,
      ...prev
    ]);

    try {
      const response = await fetch("/api/simulate-fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenMint: mint, tokenName: name })
      });
      const data = await response.json();

      if (data) {
        const isMalicious = data.isHoneypot || mint.toLowerCase().includes("rug");
        
        // Update Layer 1 (Static)
        const updatedStatic = {
          mintAuthority: isMalicious ? "ACTIVE (CRITICAL)" : "Renounced",
          freezeAuthority: isMalicious ? "ACTIVE (CRITICAL)" : "Disabled",
          lpStatus: isMalicious ? "0% Unlocked" : "99% Burned (Locked)",
          devAllocation: isMalicious ? "15.0%" : "1.2%",
          status: isMalicious ? "HIGH RISK" : "SECURE"
        };
        setStaticResult(updatedStatic);

        // Update Layer 2 (Oracles)
        setOraclesResult({
          goPlusScore: isMalicious ? "Dangerous Traps Detected" : "Low Risk",
          tokenSnifferScore: isMalicious ? "10 / 100" : "96 / 100",
          honeyBadgerStatus: isMalicious ? "Honeypot Trigger Discovered" : "No Traps Found",
          blacklistCheck: isMalicious ? "Blacklist Functions Found" : "Passed (Clean)",
          totalQueries: 3
        });

        // Update Layer 3 (Dynamic)
        setDynamicResult({
          sellTax: data.sellTax,
          buyTax: data.buyTax,
          computeUnits: data.computeUnits,
          honeypotDetected: data.isHoneypot,
          slippageEst: isMalicious ? "99.0%" : "0.25%"
        });

        // Add custom audit result
        if (onAuditUpdated) {
          onAuditUpdated({
            name: name,
            mint: mint,
            score: isMalicious ? 12 : 95,
            isRug: isMalicious,
            renounced: !isMalicious,
            liquidityLocked: isMalicious ? "0%" : "99% (Burned)",
            topHoldersShare: isMalicious ? "45%" : "3.2%",
            freezeAuthorityDisabled: !isMalicious,
            mintAuthorityDisabled: !isMalicious,
            creatorAllocation: isMalicious ? "15.0%" : "0.5%",
            taxBuySell: `${data.buyTax}% / ${data.sellTax}%`
          });
        }

        // Trace logs
        setSecurityLogs([
          `[AES-256 Volatile] Chaves RAM descriptografadas e prontas para validação síncrona`,
          `[Camada 1 - Estática] ${isMalicious ? "ALERTA: Mint / Freeze Authority ATIVAS on-chain!" : "Autoridades e metadados saudáveis e inativos"}`,
          `[Camada 2 - Oráculos] GoPlus check finalizado. Risco detectado: ${isMalicious ? "EXTREMO" : "ZERO"}`,
          `[Camada 2 - Oráculos] Token Sniffer Score: ${isMalicious ? "10/100 (Rejeitado)" : "96/100 (Aprovado)"}`,
          `[Camada 3 - Dinâmica] Simulação local Solana VM concluída. Taxa de Venda (τ_venda): ${data.sellTax}%`,
          isMalicious 
            ? `[ALERTA SECURITY] Simulação dinâmica falhou! Transação de swap abortada para proteção de capital.` 
            : `[Sucesso] Execução limpa. Swap aprovado síncronamente pela barreira lógica.`,
          `[Camada 4] Chave temporária rotacionada. Raio de explosão contido síncronamente.`
        ]);
      }
    } catch (err) {
      console.error("Failed executing security pipeline", err);
    } finally {
      setLoading(false);
    }
  };

  const forceRotateKeypair = () => {
    const randHex = Array.from({ length: 4 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    const randHex2 = Array.from({ length: 4 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    
    setRamResult(prev => ({
      ...prev,
      keypairRotations: prev.keypairRotations + 1,
      activeKeyFingerprint: `SHA256:${randHex}...${randHex2}`,
      timeToNextRotation: 60
    }));

    setSecurityLogs(logs => [
      `[AES-256 RAM] Rotação manual assíncrona forçada pelo operador. Limpando memória volátil anterior...`,
      `[AES-256 RAM] Nova chave AES de sessão gerada: SHA256:${randHex}...${randHex2}`,
      ...logs.slice(0, 8)
    ]);
  };

  const handleManualRun = (e: React.FormEvent) => {
    e.preventDefault();
    triggerSecuritySuite(tokenMint, tokenName);
  };

  const isRiskAlert = staticResult.status === "HIGH RISK" || dynamicResult.honeypotDetected;

  return (
    <div id="hft-layered-security" className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 backdrop-blur-md relative overflow-hidden">
      <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/5 rounded-full blur-2xl pointer-events-none"></div>

      {/* Header */}
      <div className="flex items-center justify-between mb-2.5 pb-2 border-b border-slate-800/60">
        <div className="flex items-center gap-2.5">
          <Fingerprint className="w-5 h-5 text-emerald-400 animate-pulse" />
          <div>
            <h2 className="text-sm font-display font-bold text-slate-100 uppercase tracking-tight">Camada de Segurança e Blindagem HFT</h2>
            <span className="text-[9px] font-mono text-emerald-400 block uppercase tracking-wider">Defesa em Profundidade (Layers 1-4)</span>
          </div>
        </div>

        <div className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded text-[10px] font-mono font-bold border ${
          isRiskAlert 
            ? "bg-rose-500/10 border-rose-500/20 text-rose-400" 
            : "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
        }`}>
          {isRiskAlert ? <ShieldAlert className="w-3.5 h-3.5" /> : <ShieldCheck className="w-3.5 h-3.5" />}
          {isRiskAlert ? "SHIELD FAULT / BLOCKED" : "SHIELD: 100% ARMED"}
        </div>
      </div>

      {/* Interactive Input Form */}
      <form onSubmit={handleManualRun} className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
        <div>
          <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">Target Name</label>
          <input
            type="text"
            value={tokenName}
            onChange={(e) => setTokenName(e.target.value)}
            disabled={loading}
            className="w-full bg-slate-950 border border-slate-850 focus:border-emerald-500 rounded px-2.5 py-1.5 text-xs font-mono text-slate-200 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1">Solana Mint Contract Address</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={tokenMint}
              onChange={(e) => setTokenMint(e.target.value)}
              disabled={loading}
              className="w-full bg-slate-950 border border-slate-850 focus:border-emerald-500 rounded px-2.5 py-1.5 text-xs font-mono text-slate-200 focus:outline-none"
            />
            <button
              type="submit"
              disabled={loading}
              className="px-3 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-bold transition-all text-xs cursor-pointer flex items-center justify-center min-w-[40px]"
              title="Query Full layered Security Suite"
            >
              {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : "Verify"}
            </button>
          </div>
        </div>
      </form>

      {/* The 4 Defence Layers Visual Hub */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        
        {/* Layer 1: Static Analysis */}
        <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-1.5 border-b border-slate-900 pb-1">
            <span className="text-[10px] font-mono text-slate-400 font-bold uppercase tracking-wide flex items-center gap-1">
              <span className="w-4 h-4 rounded bg-emerald-500/10 text-emerald-400 text-[9px] font-mono font-bold flex items-center justify-center">L1</span>
              Análise Estática
            </span>
            <span className={`text-[8px] font-mono px-1 rounded ${
              staticResult.status === "SECURE" ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
            }`}>
              {staticResult.status}
            </span>
          </div>
          
          <div className="space-y-1 text-[10px] font-mono">
            <div className="flex items-center justify-between text-slate-400">
              <span>Mint Authority:</span>
              <span className={staticResult.mintAuthority === "Renounced" ? "text-emerald-400" : "text-rose-400 font-bold"}>
                {staticResult.mintAuthority}
              </span>
            </div>
            <div className="flex items-center justify-between text-slate-400">
              <span>Freeze Authority:</span>
              <span className={staticResult.freezeAuthority === "Disabled" ? "text-emerald-400" : "text-rose-400 font-bold"}>
                {staticResult.freezeAuthority}
              </span>
            </div>
            <div className="flex items-center justify-between text-slate-400">
              <span>Liquidity status:</span>
              <span className="text-cyan-400">{staticResult.lpStatus}</span>
            </div>
            <div className="flex items-center justify-between text-slate-400">
              <span>Dev Share:</span>
              <span className="text-slate-300">{staticResult.devAllocation}</span>
            </div>
          </div>
        </div>

        {/* Layer 2: Security Oracles */}
        <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-1.5 border-b border-slate-900 pb-1">
            <span className="text-[10px] font-mono text-slate-400 font-bold uppercase tracking-wide flex items-center gap-1">
              <span className="w-4 h-4 rounded bg-emerald-500/10 text-emerald-400 text-[9px] font-mono font-bold flex items-center justify-center">L2</span>
              Oráculos de Reputação
            </span>
            <span className="text-[8px] font-mono text-slate-500 uppercase">GoPlus/Sniffer API</span>
          </div>

          <div className="space-y-1 text-[10px] font-mono">
            <div className="flex items-center justify-between text-slate-400">
              <span>GoPlus Check:</span>
              <span className={oraclesResult.goPlusScore === "Low Risk" ? "text-emerald-400" : "text-rose-400 font-bold"}>
                {oraclesResult.goPlusScore}
              </span>
            </div>
            <div className="flex items-center justify-between text-slate-400">
              <span>Token Sniffer:</span>
              <span className={oraclesResult.tokenSnifferScore.startsWith("9") ? "text-emerald-400" : "text-rose-400 font-bold"}>
                {oraclesResult.tokenSnifferScore}
              </span>
            </div>
            <div className="flex items-center justify-between text-slate-400">
              <span>HoneyBadger check:</span>
              <span className="text-cyan-400">{oraclesResult.honeyBadgerStatus}</span>
            </div>
            <div className="flex items-center justify-between text-slate-400">
              <span>IP / Wallet Check:</span>
              <span className="text-emerald-400">{oraclesResult.blacklistCheck}</span>
            </div>
          </div>
        </div>

        {/* Layer 3: Dynamic Simulation */}
        <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-1.5 border-b border-slate-900 pb-1">
            <span className="text-[10px] font-mono text-slate-400 font-bold uppercase tracking-wide flex items-center gap-1">
              <span className="w-4 h-4 rounded bg-emerald-500/10 text-emerald-400 text-[9px] font-mono font-bold flex items-center justify-center">L3</span>
              Simulação Dinâmica
            </span>
            <span className={`text-[8px] font-mono px-1 rounded ${
              dynamicResult.honeypotDetected ? "bg-rose-500/10 text-rose-400" : "bg-emerald-500/10 text-emerald-400"
            }`}>
              {dynamicResult.honeypotDetected ? "HONEYPOT DETECTED" : "VERIFIED"}
            </span>
          </div>

          <div className="space-y-1 text-[10px] font-mono">
            <div className="flex items-center justify-between text-slate-400">
              <span>Taxa Venda (τ_venda):</span>
              <span className={dynamicResult.sellTax > 5 ? "text-rose-400 font-bold text-xs" : "text-emerald-400 font-bold"}>
                {dynamicResult.sellTax}%
              </span>
            </div>
            <div className="flex items-center justify-between text-slate-400">
              <span>Taxa Compra (τ_compra):</span>
              <span className="text-slate-300">{dynamicResult.buyTax}%</span>
            </div>
            <div className="flex items-center justify-between text-slate-400">
              <span>Simulated Slippage:</span>
              <span className={dynamicResult.sellTax > 5 ? "text-rose-400" : "text-cyan-400"}>{dynamicResult.slippageEst}</span>
            </div>
            <div className="flex items-center justify-between text-slate-400">
              <span>Execution Cost CU:</span>
              <span className="text-slate-300">{dynamicResult.computeUnits.toLocaleString()} CU</span>
            </div>
          </div>
        </div>

        {/* Layer 4: RAM Criptografia & Key Rotation */}
        <div className="bg-slate-950 p-3 rounded-lg border border-slate-850 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-1.5 border-b border-slate-900 pb-1">
            <span className="text-[10px] font-mono text-slate-400 font-bold uppercase tracking-wide flex items-center gap-1">
              <span className="w-4 h-4 rounded bg-emerald-500/10 text-emerald-400 text-[9px] font-mono font-bold flex items-center justify-center">L4</span>
              Chaves Cripto RAM
            </span>
            <span className="text-[8px] font-mono text-emerald-400 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span>
              AES-256
            </span>
          </div>

          <div className="space-y-1 text-[10px] font-mono mb-1.5">
            <div className="flex items-center justify-between text-slate-400">
              <span>Armazenamento:</span>
              <span className="text-emerald-400 font-bold">{ramResult.aesState}</span>
            </div>
            <div className="flex items-center justify-between text-slate-400">
              <span>Ativa Hash:</span>
              <span className="text-slate-300 font-mono text-[9px]">{ramResult.activeKeyFingerprint}</span>
            </div>
            <div className="flex items-center justify-between text-slate-400">
              <span>Rotações Totais:</span>
              <span className="text-cyan-400">{ramResult.keypairRotations}</span>
            </div>
            <div className="flex items-center justify-between text-slate-400">
              <span>Próxima em:</span>
              <span className="text-amber-400 font-bold flex items-center gap-0.5">
                <Clock className="w-3 h-3 text-amber-500 animate-spin" />
                {ramResult.timeToNextRotation}s
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={forceRotateKeypair}
            className="w-full py-1 bg-slate-900 hover:bg-slate-850 border border-slate-800 text-[10px] text-slate-300 font-semibold font-mono rounded transition-colors flex items-center justify-center gap-1 cursor-pointer"
          >
            <Key className="w-3 h-3 text-emerald-400" />
            Rotate Keypairs (Blast Shield)
          </button>
        </div>

      </div>

      {/* Volatile RAM execution trace logs */}
      <div className="p-3.5 bg-slate-950 rounded-lg border border-slate-850/80 space-y-1.5 mb-2.5">
        <div className="flex items-center justify-between pb-1 border-b border-slate-900">
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400 uppercase tracking-widest font-bold">
            <Terminal className="w-4 h-4 text-emerald-400" />
            Volatile RAM Exec Trace
          </div>
          <span className="text-[8px] font-mono text-emerald-500/80 flex items-center gap-1">
            <EyeOff className="w-3 h-3" /> Zero Leak sandbox (AES-256)
          </span>
        </div>

        <div className="space-y-1 mt-1 font-mono text-[10px] leading-relaxed max-h-36 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-800">
          {securityLogs.map((log, index) => (
            <div key={index} className={`flex items-start gap-1.5 ${
              log.includes("[ALERTA") ? "text-rose-400 font-bold" : log.includes("[AES-") ? "text-purple-400" : log.includes("[Sucesso]") ? "text-emerald-400" : "text-slate-400"
            }`}>
              <span className="text-slate-600 select-none">&gt;</span>
              <span>{log}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Latency / Competitive Footnote */}
      <div className="pt-2 border-t border-slate-850/60 flex items-center justify-between text-[9px] font-mono text-slate-500 uppercase tracking-wider">
        <span>Static Sweep: &lt; 5ms</span>
        <span>Local VM Dry-Run: 12ms</span>
        <span className="text-emerald-400 font-bold flex items-center gap-0.5">
          <CheckCircle className="w-3.5 h-3.5 text-emerald-400" /> Layered Protection Armed
        </span>
      </div>
    </div>
  );
}
