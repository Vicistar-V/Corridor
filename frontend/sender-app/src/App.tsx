import { useCallback, useEffect, useMemo, useState } from 'react'
import { connectWallet, currentWallet, watchToken } from './lib/freighter'
import {
  approveToken,
  assignAgent,
  confirmDelivery,
  fundTransfer,
  getAgents,
  getAllowance,
  getBalance,
  getRate,
  getStatus,
  getTokenDecimals,
  getTokenSymbol,
  initiateTransfer,
  isRateStale,
  latestLedger,
  lockRate,
  publishRate,
  STATUS_STEPS,
  type AgentInfo,
  type TransferStatus,
} from './lib/soroban'
import {
  bpsToPercent,
  CFG,
  formatTokens,
  formatWhole,
  payoutAfterFees,
  quoteOf,
  shortAddress,
  tokensToUnits,
} from './lib/fmt'

const DEMO_ATTESTATION_SIG =
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
  + '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40'

interface TransferRecord {
  id: bigint
  label: string
  createdAt: string
  status?: TransferStatus
}

interface TokenMeta {
  decimals: number
  symbol: string
}

const STATUS_LABELS: Record<string, string> = {
  Locked: 'Rate locked — awaiting funds',
  Funded: 'Funds held in escrow',
  AgentAssigned: 'Payout agent assigned',
  Delivered: 'Delivered — funds released',
  Refunded: 'Refunded to sender',
  Disputed: 'Escalated to arbiter',
}

function WalletCard(props: {
  wallet: { address: string } | null
  networkOk: boolean
  onConnect: () => void
}) {
  return (
    <section className="card">
      <h2>Wallet</h2>
      {props.wallet ? (
        <>
          <p className="mono">{props.wallet.address}</p>
          <p className="hint">
            {props.networkOk ? '✓ connected to testnet' : '⚠ connected wallet is not on testnet'}
          </p>
        </>
      ) : (
        <button className="primary" onClick={props.onConnect}>
          Connect Freighter
        </button>
      )}
    </section>
  )
}

function CorridorCard(props: {
  rate: bigint | null
  rateStale: boolean
  agents: AgentInfo[]
}) {
  const { corridor } = CFG
  return (
    <section className="card">
      <h2>
        Corridor {corridor.id} <span className="muted">(pilot)</span>
      </h2>
      <dl className="grid">
        <div>
          <dt>Route</dt>
          <dd>
            {corridor.base} → {corridor.quote}
          </dd>
        </div>
        <div>
          <dt>Live oracle rate</dt>
          <dd>
            {props.rate !== null
              ? `${formatWhole(props.rate)} ${corridor.quote}/${corridor.base}`
              : props.rateStale
                ? 'stale → refresh'
                : '—'}
          </dd>
        </div>
        <div>
          <dt>Protocol fee</dt>
          <dd>{bpsToPercent(corridor.protocolFeeBps)}</dd>
        </div>
        <div>
          <dt>Agent fee</dt>
          <dd>{bpsToPercent(corridor.agentFeeBps)}</dd>
        </div>
        <div>
          <dt>Verified payout agents</dt>
          <dd>{props.agents.length}</dd>
        </div>
        <div>
          <dt>Demo token</dt>
          <dd>
            {CFG.tokenCode} · {CFG.tokenDecimals} decimals
          </dd>
        </div>
      </dl>
    </section>
  )
}

function TokenCard(props: {
  wallet: string | null
  balance: bigint | null
  allowance: bigint | null
  decimals: number
  onRefresh: () => void
  onWatch: () => void
  onMintHint: () => void
}) {
  return (
    <section className="card">
      <div className="row between">
        <h2>My {CFG.tokenCode} balance</h2>
        <button className="ghost" onClick={props.onRefresh}>Refresh</button>
      </div>
      {props.wallet ? (
        <>
          <p className="balance">
            {props.balance !== null ? formatTokens(props.balance, props.decimals) : '…'} {CFG.tokenCode}
          </p>
          <p className="hint">
            escrow allowance: {props.allowance !== null ? formatTokens(props.allowance, props.decimals) : '…'}
          </p>
          <div className="row gap">
            <button className="ghost" onClick={props.onWatch}>Add token to wallet</button>
            <button className="ghost" onClick={props.onMintHint}>Mint demo balance</button>
          </div>
        </>
      ) : (
        <p className="hint">Connect your wallet to view balances.</p>
      )}
    </section>
  )
}

function TransferForm(props: {
  wallet: string | null
  amount: string
  setAmount: (v: string) => void
  recipient: string
  setRecipient: (v: string) => void
  rate: bigint | null
  disabled: boolean
  onStart: () => void
}) {
  const amountUnits = tokensToUnits(props.amount)
  const payout = useMemo(
    () =>
      amountUnits === null
        ? null
        : payoutAfterFees(amountUnits, CFG.corridor.protocolFeeBps, CFG.corridor.agentFeeBps),
    [amountUnits],
  )
  const quote =
    amountUnits !== null && payout !== null && props.rate !== null
      ? quoteOf(payout, props.rate)
      : null

  return (
    <section className="card">
      <h2>New transfer</h2>
      <label>
        Amount ({CFG.tokenCode})
        <input
          type="text"
          inputMode="decimal"
          placeholder="e.g. 100"
          value={props.amount}
          onChange={(e) => props.setAmount(e.target.value)}
        />
      </label>
      <label>
        Recipient (pays out)
        <input
          type="text"
          placeholder="G…"
          value={props.recipient}
          onChange={(e) => props.setRecipient(e.target.value)}
        />
      </label>
      {payout !== null && (
        <p className="quote">
          Estimated payout ≈{' '}
          <strong>
            {formatTokens(payout)} {CFG.tokenCode}
          </strong>
          {quote !== null && (
            <>
              {' '}≈ <strong>{formatWhole(quote)} {CFG.corridor.quote}</strong>
            </>
          )}
          <span className="hint"> (after fees)</span>
        </p>
      )}
      <button
        className="primary"
        disabled={props.disabled || !props.wallet}
        onClick={props.onStart}
      >
        {props.disabled ? 'Working…' : `Initiate ${props.wallet ? '' : '(connect first)'}`}
      </button>
    </section>
  )
}

function StatusTimeline(props: {
  selected: bigint | null
  status: TransferStatus | null
  records: TransferRecord[]
  onSelect: (id: bigint) => void
  onRefresh: () => void
}) {
  const stepIndex = props.status ? STATUS_STEPS.indexOf(props.status as (typeof STATUS_STEPS)[number]) : -1
  const terminal = props.status && !STATUS_STEPS.includes(props.status as (typeof STATUS_STEPS)[number])

  return (
    <section className="card">
      <div className="row between">
        <h2>Transfer status</h2>
        <button className="ghost" onClick={props.onRefresh}>Refresh</button>
      </div>

      {props.records.length === 0 && <p className="hint">No transfers started in this session.</p>}

      <div className="row gap">
        <label>
          Inspect transfer id
          <input
            type="number"
            min="1"
            placeholder="e.g. 1"
            value={props.selected !== null ? props.selected.toString() : ''}
            onChange={(e) => {
              const v = BigInt(e.target.value || '0')
              if (v > 0n) props.onSelect(v)
            }}
          />
        </label>
      </div>

      {props.selected !== null && props.status && (
        <>
          <ol className="timeline">
            {STATUS_STEPS.map((step, i) => {
              const reached = i <= stepIndex
              const current = i === stepIndex
              return (
                <li key={step} className={reached ? 'reached' : ''} data-current={current || undefined}>
                  <span className="dot" />
                  <span>
                    {step}
                    <small className="hint"> {props.status !== null && current ? STATUS_LABELS[step] : ''}</small>
                  </span>
                </li>
              )
            })}
          </ol>
          {terminal && props.status && (
            <p className="terminal">Terminal state: {props.status}</p>
          )}
          {!terminal && props.status !== 'Delivered' && props.status !== 'Refunded' && (
            <p className="hint">This transfer is still awaiting the next step.</p>
          )}
        </>
      )}

      {props.records.length > 0 && (
        <ul className="session">
          {props.records.map((r) => (
            <li key={r.id.toString()}>
              <button className="ghost" onClick={() => props.onSelect(r.id)}>
                #{r.id.toString()} · {r.label}
              </button>
              {r.status && <em className="muted">{r.status}</em>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function OperatorPanel(props: {
  status: TransferStatus | null
  selected: bigint | null
  rateStale: boolean
  busy: boolean
  onRefreshRate: () => void
  onLockRate: () => void
  onAssignAgent: () => void
  onConfirm: () => void
}) {
  const canLock = props.status === 'Locked' && !props.rateStale
  const canAssign = props.status === 'Funded'
  const canConfirm = props.status === 'AgentAssigned'

  return (
    <section className="card">
      <div className="row between">
        <h2>Operator controls</h2>
        <span className="pill">{props.rateStale ? 'rate stale' : 'rate fresh'}</span>
      </div>
      <div className="row gap">
        <button className="ghost" disabled={props.busy || props.selected === null} onClick={props.onRefreshRate}>
          Refresh rate (demo publisher)
        </button>
      </div>
      <div className="row gap">
        <button className="ghost" disabled={props.busy || props.selected === null || !canLock} onClick={props.onLockRate}>
          Lock rate
        </button>
        <button className="ghost" disabled={props.busy || props.selected === null || !canAssign} onClick={props.onAssignAgent}>
          Assign agent
        </button>
        <button className="ghost" disabled={props.busy || props.selected === null || !canConfirm} onClick={props.onConfirm}>
          Confirm delivery
        </button>
      </div>
      <p className="hint">
        The demo rate expires after 300s — refresh it before locking. Then walk
        Lock rate → Assign agent → Confirm delivery (attestation is a demo
        placeholder).
      </p>
    </section>
  )
}

function StatusBanner(props: { error: string | null; success: string | null }) {
  if (props.error) return <div className="banner error">Error: {props.error}</div>
  if (props.success) return <div className="banner success">{props.success}</div>
  return null
}

export default function App() {
  const [wallet, setWallet] = useState<{ address: string; network: string; networkPassphrase: string } | null>(null)
  const [networkOk, setNetworkOk] = useState(false)
  const [walletBusy, setWalletBusy] = useState(false)

  const [tokenMeta, setTokenMeta] = useState<TokenMeta>({ decimals: CFG.tokenDecimals, symbol: CFG.tokenCode })
  const [balance, setBalance] = useState<bigint | null>(null)
  const [allowance, setAllowance] = useState<bigint | null>(null)
  const [rate, setRate] = useState<bigint | null>(null)
  const [rateStale, setRateStale] = useState(false)
  const [agents, setAgents] = useState<AgentInfo[]>([])

  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')

  const [records, setRecords] = useState<TransferRecord[]>([])
  const [selected, setSelected] = useState<bigint | null>(null)
  const [status, setStatus] = useState<TransferStatus | null>(null)

  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const DEMO_RATE = 1550n

  const notified = useCallback((msg: string | null) => {
    setError(msg)
    if (msg) setSuccess(null)
  }, [])

  const ok = useCallback((msg: string) => {
    setSuccess(msg)
    setError(null)
  }, [])

  const refreshReads = useCallback(async () => {
    if (!wallet) return
    try {
      setRate(await getRate())
    } catch (e) {
      setRate(null)
      setRateStale(isRateStale(e))
    }
    try {
      setAgents(await getAgents())
    } catch {
      setAgents([])
    }
    try {
      const [bal, allow, dec, sym] = await Promise.all([
        getBalance(wallet.address),
        getAllowance(wallet.address, CFG.escrow),
        getTokenDecimals(),
        getTokenSymbol(),
      ])
      setBalance(bal)
      setAllowance(allow)
      setTokenMeta({ decimals: dec, symbol: sym })
    } catch (e) {
      notified(e instanceof Error ? e.message : String(e))
    }
  }, [wallet, notified])

  useEffect(() => {
    void (async () => {
      const res = await currentWallet()
      if (res.wallet) {
        setWallet(res.wallet)
        setNetworkOk(res.wallet.network === 'testnet' && res.wallet.networkPassphrase === CFG.networkPassphrase)
        await refreshReads()
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (wallet && selected !== null && status === null) {
      void refreshStatus(selected)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, selected])

  const refreshStatus = useCallback(
    async (id: bigint) => {
      if (id === null) return
      try {
        const next = await getStatus(id)
        setStatus(next)
        setRecords((prev) => prev.map((r) => (r.id === id ? { ...r, status: next } : r)))
      } catch (e) {
        notified(e instanceof Error ? e.message : String(e))
      }
    },
    [notified],
  )

  const handleConnect = useCallback(async () => {
    setWalletBusy(true)
    const res = await connectWallet()
    setWalletBusy(false)
    if (res.error) {
      notified(res.error)
      return
    }
    if (!res.wallet) {
      notified('No wallet address returned')
      return
    }
    setWallet(res.wallet)
    setNetworkOk(
      res.wallet.network === 'testnet' && res.wallet.networkPassphrase === CFG.networkPassphrase,
    )
    await refreshReads()
  }, [notified, refreshReads])

  const runAction = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      if (!wallet) return
      setBusy(label)
      try {
        const outcome = await fn()
        ok(`${label} succeeded`)
        await refreshReads()
        if (selected !== null) await refreshStatus(selected)
        return outcome
      } catch (e) {
        notified(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(null)
      }
    },
    [wallet, selected, ok, notified, refreshReads, refreshStatus],
  )

  const startTransfer = useCallback(() => {
    void runAction('Initiate transfer', async () => {
      const amountUnits = tokensToUnits(amount)
      if (amountUnits === null || amountUnits <= 0n) throw new Error('Enter a valid amount')
      if (!/^G[A-Z2-7]{55}$/.test(recipient.trim())) throw new Error('Enter a valid recipient G-address')
      const outcome = await initiateTransfer({
        sender: wallet!.address,
        recipient: recipient.trim(),
        amountUnits,
      })
      const id = outcome.value as bigint
      setSelected(id)
      setRecords((prev) => [
        ...prev,
        { id, label: `${formatTokens(amountUnits)} ${CFG.tokenCode} → ${shortAddress(recipient.trim())}`, createdAt: new Date().toISOString() },
      ])
      localStorage.setItem('corridor.lastTransferId', id.toString())
      return id
    })
  }, [amount, recipient, runAction, wallet])

  const doApproveAndFund = useCallback(() => {
    void runAction('Approve + fund escrow', async () => {
      const amountUnits = tokensToUnits(amount)
      if (amountUnits === null || selected === null) throw new Error('Enter amount and start a transfer first')
      const ledger = await latestLedger()
      await approveToken({
        from: wallet!.address,
        spender: CFG.escrow,
        amountUnits,
        liveUntilLedger: ledger + 10000n,
      })
      await fundTransfer({ transferId: selected, source: wallet!.address })
    })
  }, [amount, selected, runAction, wallet])

  const doLockRate = useCallback(() => {
    void runAction('Lock rate', () => lockRate({ transferId: selected!, source: wallet!.address }))
  }, [runAction, selected, wallet])

  const doAssign = useCallback(() => {
    void runAction('Assign agent', async () => {
      const first = agents.find((a) => a.active && a.verified)
      if (!first) throw new Error('No verified agents registered')
      return assignAgent({ transferId: selected!, agentId: first.address, source: wallet!.address })
    })
  }, [runAction, agents, selected, wallet])

  const doConfirm = useCallback(() => {
    void runAction('Confirm delivery', () =>
      confirmDelivery({
        transferId: selected!,
        attestationSigHex: DEMO_ATTESTATION_SIG,
        source: wallet!.address,
      }),
    )
  }, [runAction, selected, wallet])

  const doRefreshRate = useCallback(() => {
    void runAction('Refresh rate', () => publishRate(DEMO_RATE, wallet!.address))
  }, [runAction, wallet])

  const doWatchToken = useCallback(() => {
    void watchToken(CFG.token, CFG.networkPassphrase)
  }, [])

  const doMintHint = useCallback(() => {
    ok(`No in-browser minting: run ./scripts/mint_test_usdc.sh ${CFG.network} ${wallet?.address}`)
  }, [ok, wallet])

  const active = busy !== null
  const canOperate = active || selected === null

  return (
    <main className="app">
      <header>
        <h1>Corridor — sender app</h1>
        <p className="hint">
          Testnet demo · {CFG.corridor.id} corridor ({CFG.corridor.base} → {CFG.corridor.quote})
        </p>
      </header>

      <StatusBanner error={error} success={success} />

      <div className="columns">
        <div className="col">
          <WalletCard
            wallet={wallet}
            networkOk={networkOk}
            onConnect={() => {
              if (!walletBusy) void handleConnect()
            }}
          />

          <CorridorCard rate={rate} rateStale={rateStale} agents={agents} />

          <TokenCard
            wallet={wallet?.address ?? null}
            balance={balance}
            allowance={allowance}
            decimals={tokenMeta.decimals}
            onRefresh={() => void refreshReads()}
            onWatch={doWatchToken}
            onMintHint={doMintHint}
          />
        </div>

        <div className="col">
          <TransferForm
            wallet={wallet?.address ?? null}
            amount={amount}
            setAmount={setAmount}
            recipient={recipient}
            setRecipient={setRecipient}
            rate={rate}
            disabled={active || !networkOk}
            onStart={startTransfer}
          />

          <section className="card">
            <h2>Fund the escrow</h2>
            <p className="hint">
              After initiating, grant the escrow an allowance and move the funds in. Both steps run
              from your wallet.
            </p>
            <button
              className="primary"
              disabled={active || !networkOk || selected === null}
              onClick={doApproveAndFund}
            >
              Approve + fund escrow
            </button>
          </section>

          <StatusTimeline
            selected={selected}
            status={status}
            records={records}
            onSelect={(id) => {
              setSelected(id)
              void refreshStatus(id)
            }}
            onRefresh={() => {
              if (selected !== null) void refreshStatus(selected)
            }}
          />
        </div>

        <div className="col">
          <OperatorPanel
            status={status}
            selected={selected}
            rateStale={rateStale}
            busy={canOperate}
            onRefreshRate={doRefreshRate}
            onLockRate={doLockRate}
            onAssignAgent={doAssign}
            onConfirm={doConfirm}
          />

          <section className="card">
            <h2>Get the demo running</h2>
            <ol className="steps hint">
              <li>Connect Freighter on testnet (install the extension first).</li>
              <li>
                Trust & fund <code>{CFG.tokenCode}</code>: run{' '}
                <code>./scripts/mint_test_usdc.sh {CFG.network} &lt;your G-address&gt;</code> after
                adding a trustline.
              </li>
              <li>Enter an amount + recipient, then Initiate → Approve + fund.</li>
              <li>
                As the deployer wallet, Lock rate then Assign agent; as a verified agent,
                Confirm delivery.
              </li>
              <li>Watch the status timeline reach Delivered.</li>
            </ol>
          </section>
        </div>
      </div>
    </main>
  )
}