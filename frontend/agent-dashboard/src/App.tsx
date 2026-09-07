import { useCallback, useEffect, useMemo, useState } from 'react'
import { connectWallet, currentWallet } from './lib/freighter'
import {
  confirmDelivery,
  getAgents,
  getBalance,
  getRate,
  getStatus,
  isRateStale,
  STATUS_STEPS,
  type AgentInfo,
  type TransferStatus,
} from './lib/soroban'
import {
  bpsToPercent,
  CFG,
  formatTokens,
  formatWhole,
  shortAddress,
} from './lib/fmt'

const DEMO_ATTESTATION_SIG =
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
  + '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40'

const STATUS_LABELS: Record<string, string> = {
  Locked: 'Rate locked — awaiting funds',
  Funded: 'Funds held in escrow',
  AgentAssigned: 'Assigned to you — payout pending',
  Delivered: 'Delivered — funds released',
  Refunded: 'Refunded to sender',
  Disputed: 'Escalated to arbiter',
}

interface AssignedRecord {
  id: string
  addedAt: string
  status?: TransferStatus
}

const QUEUE_KEY = 'corridor.agentQueue'

function loadQueue(): AssignedRecord[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Array<{ id: string; addedAt: string }>
    return parsed.map((r) => ({ id: r.id, addedAt: r.addedAt }))
  } catch {
    return []
  }
}

function saveQueue(queue: AssignedRecord[]) {
  localStorage.setItem(
    QUEUE_KEY,
    JSON.stringify(queue.map(({ id, addedAt }) => ({ id, addedAt }))),
  )
}

function isAssigned(status: TransferStatus | undefined): boolean {
  return status === 'AgentAssigned'
}

function WalletCard(props: {
  wallet: { address: string } | null
  networkOk: boolean
  isAgent: boolean | null
  agent: AgentInfo | null
  onConnect: () => void
}) {
  return (
    <section className="card">
      <div className="row between">
        <h2>Agent wallet</h2>
        {props.isAgent && <span className="pill agent">verified agent</span>}
        {props.isAgent === false && <span className="pill observer">not registered</span>}
      </div>
      {props.wallet ? (
        <>
          <p className="mono">{props.wallet.address}</p>
          <p className="hint">
            {props.networkOk
              ? '✓ connected to testnet'
              : '⚠ connected wallet is not on testnet'}
          </p>
          {props.agent ? (
            <p className="hint">
              Registered for {props.agent.corridorIds.join(', ')} ·{' '}
              {shortAddress(props.agent.address)}
            </p>
          ) : null}
        </>
      ) : (
        <button className="primary" onClick={props.onConnect}>
          Connect Freighter (agent)
        </button>
      )}
    </section>
  )
}

function CorridorCard(props: { rate: { rate: bigint } | null; rateStale: boolean }) {
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
            {props.rate
              ? `${formatWhole(props.rate.rate)} ${corridor.quote}/${corridor.base}`
              : props.rateStale
                ? 'stale'
                : '—'}
          </dd>
        </div>
        <div>
          <dt>Your fee</dt>
          <dd>{bpsToPercent(corridor.agentFeeBps)}</dd>
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
  onRefresh: () => void
}) {
  return (
    <section className="card">
      <div className="row between">
        <h2>Your token balance</h2>
        <button className="ghost" onClick={props.onRefresh}>Refresh</button>
      </div>
      {props.wallet ? (
        <p className="balance">
          {props.balance !== null ? formatTokens(props.balance) : '…'} {CFG.tokenCode}
        </p>
      ) : (
        <p className="hint">Connect your wallet to view balances.</p>
      )}
    </section>
  )
}

function LookupCard(props: {
  input: string
  setInput: (v: string) => void
  onLookup: () => void
  disabled: boolean
}) {
  return (
    <section className="card">
      <h2>Look up a transfer</h2>
      <label>
        Transfer id
        <input
          type="number"
          min="1"
          placeholder="e.g. 1"
          value={props.input}
          onChange={(e) => props.setInput(e.target.value)}
        />
      </label>
      <div className="row gap">
        <button
          className="primary"
          disabled={props.disabled || props.input === ''}
          onClick={props.onLookup}
        >
          Track transfer
        </button>
      </div>
      <p className="hint">Add a transfer to your queue, then confirm delivery once the payout is done.</p>
    </section>
  )
}

function AssignedQueue(props: {
  queue: AssignedRecord[]
  selected: AssignedRecord | null
  refreshable: boolean
  onSelect: (record: AssignedRecord) => void
  onRemove: (id: string) => void
  onRefresh: () => void
}) {
  const pending = props.queue.filter((r) => isAssigned(r.status)).length

  return (
    <section className="card">
      <div className="row between">
        <h2>My assigned transfers</h2>
        <button className="ghost" disabled={!props.refreshable} onClick={props.onRefresh}>
          Refresh statuses
        </button>
      </div>
      <p className="hint">
        {props.queue.length === 0
          ? 'No transfers tracked yet. Use "Look up a transfer" above.'
          : `${pending} awaiting payout · ${props.queue.length} tracked`}
      </p>
      {props.queue.length > 0 && (
        <ul className="session">
          {props.queue.map((r) => (
            <li key={r.id}>
              <button
                className={`ghost ${props.selected?.id === r.id ? 'selected' : ''}`}
                onClick={() => props.onSelect(r)}
              >
                Transfer #{r.id}
              </button>
              <em className={`muted ${isAssigned(r.status) ? 'flag' : ''}`}>
                {r.status ?? '…'}
              </em>
              <button className="ghost link" onClick={() => props.onRemove(r.id)}>
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function PayoutCard(props: {
  status: TransferStatus | null
  offChainDone: boolean
  setOffChainDone: (v: boolean) => void
  busy: boolean
  onSubmit: () => void
}) {
  return (
    <section className="card">
      <h2>Payout &amp; attestation</h2>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={props.offChainDone}
          onChange={(e) => props.setOffChainDone(e.target.checked)}
        />
        <span>Off-chain payout completed (cash pickup / mobile money / bank deposit)</span>
      </label>

      <button
        className="primary"
        disabled={props.busy || props.status !== 'AgentAssigned' || !props.offChainDone}
        onClick={props.onSubmit}
      >
        {props.busy
          ? 'Submitting…'
          : props.status === 'AgentAssigned'
            ? 'Submit delivery attestation'
            : props.status
              ? `Transfer is ${props.status}`
              : 'Submit delivery attestation'}
      </button>
      <p className="hint">
        Attestation is signed by your wallet and releases escrowed funds (recipient, your fee,
        protocol fee). It can only be submitted while the transfer is <code>AgentAssigned</code>.
      </p>
    </section>
  )
}

function StatusTimeline(props: { status: TransferStatus | null }) {
  const stepIndex = props.status ? STATUS_STEPS.indexOf(props.status as (typeof STATUS_STEPS)[number]) : -1
  const terminal = props.status && !STATUS_STEPS.includes(props.status as (typeof STATUS_STEPS)[number])

  if (!props.status) return null

  return (
    <section className="card">
      <div className="row between">
        <h2>Status</h2>
        <span className="pill">{props.status}</span>
      </div>
      <ol className="timeline">
        {STATUS_STEPS.map((step, i) => {
          const reached = i <= stepIndex
          const current = i === stepIndex
          return (
            <li key={step} className={reached ? 'reached' : ''} data-current={current || undefined}>
              <span className="dot" />
              <span>
                {step}
                {current && <small className="hint"> {STATUS_LABELS[step]}</small>}
              </span>
            </li>
          )
        })}
      </ol>
      {terminal && props.status && (
        <p className="terminal">Terminal state: {props.status}</p>
      )}
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

  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [rate, setRate] = useState<{ rate: bigint } | null>(null)
  const [rateStale, setRateStale] = useState(false)
  const [balance, setBalance] = useState<bigint | null>(null)

  const [lookupInput, setLookupInput] = useState('')
  const [queue, setQueue] = useState<AssignedRecord[]>([])
  const [selected, setSelected] = useState<AssignedRecord | null>(null)

  const [offChainDone, setOffChainDone] = useState(false)

  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const notified = useCallback((msg: string | null) => {
    setError(msg)
    if (msg) setSuccess(null)
  }, [])

  const ok = useCallback((msg: string) => {
    setSuccess(msg)
    setError(null)
  }, [])

  const myAgent: AgentInfo | null = useMemo(() => {
    if (!wallet) return null
    return agents.find((a) => a.address === wallet.address) ?? null
  }, [agents, wallet])

  const isAgent = wallet ? Boolean(myAgent) : null

  const refreshReads = useCallback(async () => {
    if (!wallet) return
    try {
      setAgents(await getAgents())
    } catch {
      setAgents([])
    }
    try {
      setRate(await getRate())
      setRateStale(false)
    } catch (e) {
      setRate(null)
      setRateStale(isRateStale(e))
    }
    try {
      setBalance(await getBalance(wallet.address))
    } catch {
      setBalance(null)
    }
  }, [wallet])

  const refreshQueue = useCallback(
    async (records: AssignedRecord[]) => {
      const updated: AssignedRecord[] = []
      for (const record of records) {
        try {
          const status = await getStatus(BigInt(record.id))
          updated.push({ ...record, status })
        } catch (e) {
          notified(e instanceof Error ? e.message : String(e))
          updated.push(record)
        }
      }
      setQueue(updated)
      setSelected((prev) =>
        prev ? (updated.find((r) => r.id === prev.id) ?? prev) : prev,
      )
      return updated
    },
    [notified],
  )

  useEffect(() => {
    setQueue(loadQueue())
  }, [])

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
    if (wallet && queue.length > 0) {
      void refreshQueue(queue)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet])

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

  const addToQueue = useCallback(
    async (id: string) => {
      let record: AssignedRecord = { id, addedAt: new Date().toISOString() }
      try {
        const status = await getStatus(BigInt(id))
        record = { ...record, status }
      } catch (e) {
        notified(e instanceof Error ? e.message : String(e))
      }
      const next = [...queue.filter((r) => r.id !== id), record]
      setQueue(next)
      saveQueue(next)
      setSelected(record)
      setLookupInput('')
      ok(`Transfer #${id} tracked`)
    },
    [queue, notified, ok],
  )

  const removeFromQueue = useCallback((id: string) => {
    const next = queue.filter((r) => r.id !== id)
    setQueue(next)
    saveQueue(next)
    if (selected?.id === id) setSelected(null)
  }, [queue, selected])

  const submitAttestation = useCallback(() => {
    if (!selected || !wallet) return
    setBusy('Submit attestation')
    void (async () => {
      try {
        await confirmDelivery({
          transferId: BigInt(selected.id),
          attestationSigHex: DEMO_ATTESTATION_SIG,
          source: wallet.address,
        })
        ok(`Delivery attestation for transfer #${selected.id} accepted`)
        const status = await getStatus(BigInt(selected.id))
        const nextQ = queue.map((r) => (r.id === selected.id ? { ...r, status } : r))
        setQueue(nextQ)
        saveQueue(nextQ)
        setSelected((prev) => (prev?.id === selected.id ? { ...prev, status } : prev))
        setOffChainDone(false)
      } catch (e) {
        notified(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(null)
      }
    })()
  }, [selected, wallet, queue, ok, notified])

  const status = selected?.status ?? null

  const canConfirm = status === 'AgentAssigned'

  return (
    <main className="app">
      <header>
        <h1>Corridor — agent dashboard</h1>
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
            isAgent={isAgent}
            agent={myAgent}
            onConnect={() => {
              if (!walletBusy) void handleConnect()
            }}
          />

          <CorridorCard rate={rate} rateStale={rateStale} />

          <TokenCard
            wallet={wallet?.address ?? null}
            balance={balance}
            onRefresh={() => void refreshReads()}
          />

          {myAgent && (
            <section className="card">
              <h2>Your registration</h2>
              <dl className="grid">
                <div>
                  <dt>Verified</dt>
                  <dd>{myAgent.verified ? 'yes' : 'no'}</dd>
                </div>
                <div>
                  <dt>Active</dt>
                  <dd>{myAgent.active ? 'yes' : 'no'}</dd>
                </div>
                <div>
                  <dt>Corridors</dt>
                  <dd>{myAgent.corridorIds.join(', ')}</dd>
                </div>
                <div>
                  <dt>Metadata</dt>
                  <dd className="mono truncate">{myAgent.metadataUri}</dd>
                </div>
              </dl>
            </section>
          )}

          {!myAgent && wallet && (
            <section className="card">
              <h2>Not a registered agent</h2>
              <p className="hint">
                This wallet is not a verified payout agent for the {CFG.corridor.id} corridor. It
                cannot submit delivery attestations. Register it via{' '}
                <code>./scripts/setup_corridor.sh</code> as the deployer before confirming
                deliveries.
              </p>
            </section>
          )}
        </div>

        <div className="col">
          <LookupCard
            input={lookupInput}
            setInput={setLookupInput}
            onLookup={() => {
              const id = lookupInput.trim()
              if (id && BigInt(id) > 0n) void addToQueue(id)
            }}
            disabled={!wallet || !networkOk}
          />

          <AssignedQueue
            queue={queue}
            selected={selected}
            refreshable={!busy}
            onSelect={(record) => {
              setSelected(record)
              setOffChainDone(false)
            }}
            onRemove={removeFromQueue}
            onRefresh={() => void refreshQueue(queue)}
          />
        </div>

        <div className="col">
          {selected && (
            <>
              <StatusTimeline status={status} />

              <PayoutCard
                status={status}
                offChainDone={offChainDone}
                setOffChainDone={setOffChainDone}
                busy={busy !== null}
                onSubmit={submitAttestation}
              />

              {canConfirm && !offChainDone && (
                <p className="hint">
                  Complete the off-chain payout first, then check the box above to enable the
                  on-chain attestation.
                </p>
              )}
            </>
          )}

          {!selected && (
            <section className="card">
              <h2>Agent flow</h2>
              <ol className="steps hint">
                <li>Connect Freighter with your registered agent address.</li>
                <li>Look up a transfer id to track it in your queue.</li>
                <li>Complete the off-chain payout to the recipient (cash / mobile money / bank).</li>
                <li>Submit the delivery attestation to release escrowed funds on-chain.</li>
                <li>Watch the status reach Delivered.</li>
              </ol>
            </section>
          )}
        </div>
      </div>
    </main>
  )
}
