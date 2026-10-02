export interface RpcNode {
  id: string;
  name: string;
  latency: number;
  jitterMs: number;
  status: 'healthy' | 'degraded' | 'offline';
  region: string;
  load: number;
  slotLag: number;
  packetLoss: number;
  isPrimary?: boolean;
  url?: string;
  blockhashCacheAge?: number;
  reconnectionCount?: number;
  /**
   * Procedência dos números deste nó. `unavailable` = nenhuma medição de RTT válida
   * (URL placeholder ou todas as sondagens falharam) — a UI NÃO pode exibir latência,
   * porque não existe. `partial` = há medição real, mas campos não observáveis via RPC
   * (ex.: `load`) ficam zerados de propósito.
   */
  metricsSource?: 'real' | 'partial' | 'unavailable';
  shredStream?: 'active' | 'inactive';
}

export interface SnipedTransaction {
  id: string;
  token: string;
  mint: string;
  amount: string;
  outAmount: string;
  time: string;
  latencyMs: number;
  status: 'success' | 'failed' | 'blacklisted';
  block: number;
  tipSol: number;
  route: string;
  isAntiRugSaved?: boolean;
  savedAmountSol?: string;
}

export interface JitoTips {
  low: number;
  medium: number;
  high: number;
  extreme: number;
}

export interface TokenAuditResult {
  isRug: boolean;
  score: number;
  mint: string;
  name: string;
  renounced: boolean;
  liquidityLocked: string;
  topHoldersShare: string;
  analysis: string;
  freezeAuthorityDisabled?: boolean;
  mintAuthorityDisabled?: boolean;
  creatorAllocation?: string;
  taxBuySell?: string;
  priceSol?: number;
  poolSource?: string;
  liquidityUsd?: number;
  priceImpact?: string;
}

