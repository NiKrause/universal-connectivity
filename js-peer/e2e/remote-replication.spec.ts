import { chromium, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'

// Cross-network remote-replication test (mirrors simple-todo's e2e/remote):
// browser A runs on the GitHub runner, browser B runs on an ephemeral Aleph
// Playwright-runner VM. Both load the *deployed* js-peer app and connect through
// its own (uc-go-peer) relays — no relay is provisioned here, and no wallet is
// used. This is the deploy-pipeline replication test, kept separate from the
// relay-button provisioning E2E.
//
// Reuse, not reimplementation:
// - browser B is connected via the shared testkit's `connectAlephChromium`.
// - the VM is provisioned by the relay-button `aleph-playwright-runner` action.

const APP_URL = process.env.RELAY_BUTTON_E2E_APP_URL ?? 'https://connect.nicokrause.com'
const TESTKIT_MODULE = process.env.RELAY_BUTTON_TESTKIT_MODULE ?? '@le-space/playwright'
const OUTPUT_DIR = 'test-results/remote-replication'
const CHAT_TOPIC = 'universal-connectivity'
const CONNECT_TIMEOUT = 3 * 60_000
const CHAT_TIMEOUT = 3 * 60_000

const REMOTE_WS_ENDPOINT = process.env.ALEPH_PLAYWRIGHT_WS_ENDPOINT?.trim()
const REMOTE_VERSION_URL = process.env.ALEPH_PLAYWRIGHT_VERSION_URL?.trim()
const REMOTE_SECRET = process.env.ALEPH_PLAYWRIGHT_SECRET?.trim()

type RelayTestkit = {
  connectAlephChromium(options: {
    chromium: {
      connect(wsEndpoint: string, options?: { headers?: Record<string, string>; timeout?: number }): Promise<Browser>
    }
    wsEndpoint: string
    versionUrl: string
    secret: string
    expectedVersion?: string
    timeoutMs?: number
  }): Promise<Browser>
}

function loadRelayTestkit(): Promise<RelayTestkit> {
  return import(TESTKIT_MODULE) as Promise<RelayTestkit>
}

type Diagnostics = {
  peerId: string
  multiaddrs: string[]
  connections: { remotePeer: string; remoteAddr: string }[]
  pubsub: { peers: string[]; chatSubscribers: string[] }
}

class RemoteChatAgent {
  context: BrowserContext | null = null
  page: Page | null = null

  constructor(
    readonly name: string,
    readonly browser: Browser,
  ) {}

  async open() {
    this.context = await this.browser.newContext()
    this.page = await this.context.newPage()
    await this.page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await this.page.getByPlaceholder('Message').waitFor({ state: 'visible', timeout: 120_000 })
    await this.page.waitForFunction(
      () => Boolean((window as unknown as { libp2p?: { peerId?: unknown } }).libp2p?.peerId),
      undefined,
      { timeout: 120_000 },
    )
  }

  async peerId(): Promise<string> {
    return this.requiredPage().evaluate(() =>
      String((window as unknown as { libp2p: { peerId: unknown } }).libp2p.peerId),
    )
  }

  // Wait until this browser has an open connection whose remote peer is the
  // other browser (established through the deployed app's relay circuit / WebRTC).
  async waitForPeerConnection(otherPeerId: string, timeout = CONNECT_TIMEOUT) {
    await this.requiredPage().waitForFunction(
      (expectedPeerId) =>
        (
          (
            window as unknown as { libp2p: { getConnections: () => { remotePeer: unknown }[] } }
          ).libp2p.getConnections() ?? []
        ).some(({ remotePeer }) => String(remotePeer) === expectedPeerId),
      otherPeerId,
      { timeout, polling: 1_000 },
    )
  }

  async sendMessage(message: string) {
    const input = this.requiredPage().getByPlaceholder('Message')
    await input.fill(message)
    await input.press('Enter')
  }

  async waitForMessage(message: string) {
    await this.requiredPage()
      .getByTestId('chat-message-body')
      .filter({ hasText: message })
      .waitFor({ state: 'visible', timeout: CHAT_TIMEOUT })
  }

  async screenshot(path: string) {
    await this.page?.screenshot({ path, fullPage: true }).catch(() => {})
  }

  async diagnostics(): Promise<Diagnostics> {
    return this.requiredPage().evaluate((topic) => {
      const node = (
        window as unknown as {
          libp2p: {
            peerId: unknown
            getMultiaddrs: () => unknown[]
            getConnections: () => { remotePeer: unknown; remoteAddr: unknown }[]
            services: { pubsub: { getPeers: () => unknown[]; getSubscribers: (topic: string) => unknown[] } }
          }
        }
      ).libp2p
      return {
        peerId: String(node.peerId),
        multiaddrs: node.getMultiaddrs().map(String),
        connections: node.getConnections().map(({ remotePeer, remoteAddr }) => ({
          remotePeer: String(remotePeer),
          remoteAddr: String(remoteAddr),
        })),
        pubsub: {
          peers: node.services.pubsub.getPeers().map(String),
          chatSubscribers: node.services.pubsub.getSubscribers(topic).map(String),
        },
      }
    }, CHAT_TOPIC)
  }

  async close() {
    await this.context?.close().catch(() => {})
  }

  private requiredPage() {
    if (!this.page) throw new Error(`${this.name} is not open`)
    return this.page
  }
}

test.describe('js-peer remote replication', () => {
  test.setTimeout(30 * 60_000)

  test('replicates a public chat message between a local and a remote-VM browser', async ({ browser }) => {
    await mkdir(OUTPUT_DIR, { recursive: true })
    const testkit = await loadRelayTestkit()

    // Browser B: remote Aleph Playwright-runner VM when an endpoint is provided,
    // otherwise same-machine (local smoke run).
    let remoteBrowser: Browser | null = null
    if (REMOTE_WS_ENDPOINT) {
      if (!REMOTE_VERSION_URL || !REMOTE_SECRET) {
        throw new Error('ALEPH_PLAYWRIGHT_VERSION_URL and ALEPH_PLAYWRIGHT_SECRET are required with a WS endpoint')
      }
      remoteBrowser = await testkit.connectAlephChromium({
        chromium,
        wsEndpoint: REMOTE_WS_ENDPOINT,
        versionUrl: REMOTE_VERSION_URL,
        secret: REMOTE_SECRET,
        timeoutMs: 120_000,
      })
    }

    const agentA = new RemoteChatAgent('local', browser)
    const agentB = new RemoteChatAgent('aleph-remote', remoteBrowser ?? browser)
    const evidence: Record<string, unknown> = {
      appUrl: APP_URL,
      remote: Boolean(remoteBrowser),
      startedAt: new Date().toISOString(),
    }
    let testError: Error | null = null

    try {
      await Promise.all([agentA.open(), agentB.open()])
      const [peerA, peerB] = await Promise.all([agentA.peerId(), agentB.peerId()])
      evidence.peerA = peerA
      evidence.peerB = peerB

      // Both browsers must connect to each other through the deployed app's relays.
      await Promise.all([agentA.waitForPeerConnection(peerB), agentB.waitForPeerConnection(peerA)])
      evidence.connected = true

      const messageAToB = `remote-repl-a-${Date.now()}`
      const messageBToA = `remote-repl-b-${Date.now()}`
      await agentA.sendMessage(messageAToB)
      await agentB.waitForMessage(messageAToB)
      evidence.messageAToB = messageAToB
      await agentB.sendMessage(messageBToA)
      await agentA.waitForMessage(messageBToA)
      evidence.messageBToA = messageBToA
      evidence.passed = true

      evidence.final = { a: await agentA.diagnostics(), b: await agentB.diagnostics() }
      await Promise.all([
        agentA.screenshot(`${OUTPUT_DIR}/local-success.png`),
        agentB.screenshot(`${OUTPUT_DIR}/remote-success.png`),
      ])
    } catch (error) {
      testError = error instanceof Error ? error : new Error(String(error))
      evidence.passed = false
      evidence.error = testError.message
      const diags = await Promise.allSettled([agentA.diagnostics(), agentB.diagnostics()])
      evidence.failureDiagnostics = {
        a: diags[0].status === 'fulfilled' ? diags[0].value : { error: String(diags[0].reason) },
        b: diags[1].status === 'fulfilled' ? diags[1].value : { error: String(diags[1].reason) },
      }
      await Promise.all([
        agentA.screenshot(`${OUTPUT_DIR}/local-failure.png`),
        agentB.screenshot(`${OUTPUT_DIR}/remote-failure.png`),
      ])
    }

    evidence.finishedAt = new Date().toISOString()
    await Promise.allSettled([agentA.close(), agentB.close()])
    if (remoteBrowser) await remoteBrowser.close().catch(() => {})
    await writeFile(`${OUTPUT_DIR}/result.json`, `${JSON.stringify(evidence, null, 2)}\n`)
    if (testError) throw testError
  })
})
