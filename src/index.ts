import { MerklePath, Transaction } from '@bsv/sdk'

// Interfaces for API responses
interface Utxo {
  tx_hash: string
  tx_pos: number
  value: number
}

interface UtxoResponse {
  result?: Utxo[]
  script?: string
}

interface TSCProof {
  txOrId: string
  target: string
  index: number
  nodes: string[]
}

interface HeaderResponse {
  height: number
  merkleroot: string
}

/**
 * WocClient
 * @class
 * @classdesc A class for interacting with the Whatsonchain API
 * @example
 * const woc = new WocClient()
 * const utxos = await woc.getUtxos('1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu')
 */
export default class WocClient {
  private api: string

  constructor () {
    this.api = 'https://api.whatsonchain.com/v1/bsv/main'
  }

  private readonly requestQueue: Array<{
    resolve: (value: any) => void
    reject: (reason?: any) => void
    request: { url: string; options: RequestInit }
  }> = []
  private isProcessingQueue: boolean = false

  setNetwork (network: string): void {
    this.api = `https://api.whatsonchain.com/v1/bsv/${network}`
  }

  private async processQueue (): Promise<void> {
    if (this.isProcessingQueue) return
    this.isProcessingQueue = true
    while (this.requestQueue.length > 0) {
      const { resolve, request } = this.requestQueue.shift()!
      try {
        console.log({ url: request.url, options: request.options })
        const response = await fetch(request.url, {
          ...request.options,
          cache: 'no-store'
        })
        if (request.options.headers?.['Accept'] === 'plain/text') {
          const text = await response.text()
          resolve(text)
        } else {
          const data = await response.json()
          resolve(data)
        }
      } catch (error) {
        console.log({ error })
        resolve(null)
      }
      await new Promise(resolve => setTimeout(resolve, 350))
    }
    this.isProcessingQueue = false
  }

  private queueRequest (url: string, options: RequestInit): Promise<any> {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ resolve, reject, request: { url, options } })
      this.processQueue()
    })
  }

  private async getJson (route: string): Promise<any> {
    return await this.queueRequest(this.api + route, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    })
  }

  private async get (route: string): Promise<string | null> {
    return await this.queueRequest(this.api + route, {
      method: 'GET',
      headers: {
        'Accept': 'plain/text'
      }
    })
  }

  private async post (route: string, body: any): Promise<any> {
    return await this.queueRequest(this.api + route, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body)
    })
  }

  async getUtxos (address: string): Promise<Array<{
    txid: string
    vout: number
    satoshis: number
    script: string
  }>> {
    console.log({ getUtxo: address })
    let confirmed: UtxoResponse = {}
    let unconfirmed: UtxoResponse = {}
    try {
      confirmed = await this.getJson(`/address/${address}/confirmed/unspent`)
    } catch (error) {
      console.log({ error })
    }
    try {
      unconfirmed = await this.getJson(`/address/${address}/unconfirmed/unspent`)
    } catch (error) {
      console.log({ error })
    }
    const combined: Utxo[] = []
    confirmed?.result?.forEach(utxo => combined.push(utxo))
    unconfirmed?.result?.forEach(utxo => combined.push(utxo))
    const script = confirmed?.script || unconfirmed?.script || ''
    const formatted = combined.map(u => ({
      txid: u.tx_hash,
      vout: u.tx_pos,
      satoshis: u.value,
      script
    }))
    console.log({ confirmed, unconfirmed, combined, formatted })
    return formatted
  }

  async getTx (txid: string): Promise<string | null> {
    return this.get(`/tx/${txid}/hex`)
  }

  async getMerklePath (txid: string): Promise<TSCProof | null> {
    return this.getJson(`/tx/${txid}/proof/tsc`)
  }

  async getHeader (hash: string): Promise<HeaderResponse> {
    return this.getJson(`/block/${hash}/header`)
  }

  async convertTSCtoBUMP (tsc: TSCProof): Promise<MerklePath> {
    const txid = tsc.txOrId
    const header = await this.getHeader(tsc.target)
    const bump: {
      blockHeight: number
      path: Array<Array<{ hash?: string; txid?: boolean; offset: number; duplicate?: boolean }>>
    } = {
      blockHeight: header.height,
      path: []
    }
    const leafOfInterest = { hash: txid, txid: true, offset: tsc.index }
    tsc.nodes.forEach((hash, idx) => {
      const offset = tsc.index >> idx ^ 1
      const leaf: { offset: number; hash?: string; duplicate?: boolean } = { offset }
      if (hash === '*') leaf.duplicate = true
      else leaf.hash = hash
      if (idx === 0) {
        if (tsc.index % 2) bump.path.push([leafOfInterest, leaf])
        else bump.path.push([leaf, leafOfInterest])
      } else {
        bump.path.push([leaf])
      }
    })
    const merklePath = new MerklePath(bump.blockHeight, bump.path)
    if (header.merkleroot !== merklePath.computeRoot(txid)) {
      throw new Error('Invalid Merkle Path')
    }
    return merklePath
  }

  async getMerklePathOrParents (tx: Transaction): Promise<Transaction> {
    const tscRes = await this.getMerklePath(tx.id('hex'))
    console.log({ tscRes })
    if (tscRes !== null) {
      tx.merklePath = await this.convertTSCtoBUMP(tscRes)
      console.log({ bump: tx.merklePath })
      return tx
    }
    await Promise.all(tx.inputs.map(async (input, idx) => {
      const rawtx = await this.getTx(input.sourceTXID as string)
      const inputTx = Transaction.fromHex(rawtx!)
      const st = await this.getMerklePathOrParents(inputTx)
      tx.inputs[idx].sourceTransaction = st
    }))
    return tx
  }

  async getPrice (): Promise<any> {
    return await this.getJson('/exchangerate')
  }
}