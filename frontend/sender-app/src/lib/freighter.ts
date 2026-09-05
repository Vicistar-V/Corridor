import {
  getAddress,
  getNetworkDetails,
  isConnected,
  requestAccess,
  signTransaction,
  signAuthEntry,
  addToken,
} from '@stellar/freighter-api'

export interface Wallet {
  address: string
  network: string
  networkPassphrase: string
}

export interface WalletResult {
  wallet: Wallet | null
  error?: string
}

function err(result: { error?: { message?: string; code?: number } }): string | undefined {
  return result.error?.message
}

export async function connectWallet(): Promise<WalletResult> {
  try {
    const allowed = await requestAccess()
    const denied = err(allowed)
    if (denied) return { wallet: null, error: denied }

    const [details, address] = await Promise.all([getNetworkDetails(), getAddress()])
    const detailsErr = err(details)
    const addressErr = err(address)
    if (detailsErr || addressErr) {
      return { wallet: null, error: detailsErr ?? addressErr }
    }
    return {
      wallet: {
        address: address.address,
        network: details.network,
        networkPassphrase: details.networkPassphrase,
      },
    }
  } catch (e) {
    return { wallet: null, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function currentWallet(): Promise<WalletResult> {
  try {
    const connected = await isConnected()
    if (connected.error || !connected.isConnected) {
      return { wallet: null, error: connected.error?.message }
    }
    const details = await getNetworkDetails()
    const address = await getAddress()
    if (details.error || address.error) {
      return { wallet: null, error: details.error?.message ?? address.error?.message }
    }
    return {
      wallet: {
        address: address.address,
        network: details.network,
        networkPassphrase: details.networkPassphrase,
      },
    }
  } catch (e) {
    return { wallet: null, error: e instanceof Error ? e.message : String(e) }
  }
}

export type { signTransaction as freighterSignTransactionType }

export async function signTx(
  txXdr: string,
  networkPassphrase: string,
  address?: string,
): Promise<{ signedXdr: string; error?: string }> {
  const result = await signTransaction(txXdr, { networkPassphrase, address })
  if (result.error) return { signedXdr: '', error: result.error.message }
  return { signedXdr: result.signedTxXdr }
}

export async function signAuth(
  entryXdr: string,
  networkPassphrase: string,
  address?: string,
): Promise<{ signedEntry: string; error?: string }> {
  const result = await signAuthEntry(entryXdr, { networkPassphrase, address })
  if (result.error) return { signedEntry: '', error: result.error.message }
  return { signedEntry: result.signedAuthEntry ?? '' }
}

export async function watchToken(contractId: string, networkPassphrase: string): Promise<void> {
  try {
    await addToken({ contractId, networkPassphrase })
  } catch {
    // Listing a token is a UX nicety; failure isn't fatal.
  }
}