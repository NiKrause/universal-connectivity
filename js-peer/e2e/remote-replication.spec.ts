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
const CONNECT_TIMEOUT = 5 * 60_000
const CHAT_TIMEOUT = 3 * 60_000

const REMOTE_WS_ENDPOINT = process.env.ALEPH_PLAYWRIGHT_WS_ENDPOINT?.trim()
const REMOTE_VERSION_URL = process.env.ALEPH_PLAYWRIGHT_VERSION_URL?.trim()
const REMOTE_SECRET = process.env.ALEPH_PLAYWRIGHT_SECRET?.trim()

// Stream stage progress + browser diagnostics so a stuck run is diagnosable
// (previously the test printed only "Running 1 test" through the whole window).
function progress(message: string) {
  console.log(`[remote-repl ${new Date().toISOString().slice(11, 23)}] ${message}`)
}

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
    progress(`[${this.name}] opening ${APP_URL}...`)
    this.context = await this.browser.newContext()
    this.page = await this.context.newPage()
    // Forward browser console + page errors so libp2p connection/discovery
    // activity is visible in the CI log.
    this.page.on('console', (msg) => {
      const text = msg.text()
      if (/error|warn|relay|dial|peer|webrtc|circuit|reservation|connect/i.test(text)) {
        progress(`[${this.name} ${msg.type()}] ${text}`.slice(0, 300))
      }
    })
    this.page.on('pageerror', (err) => progress(`[${this.name} pageerror] ${err.message}`.slice(0, 300)))
    await this.page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await this.page.getByPlaceholder('Message').waitFor({ state: 'visible', timeout: 120_000 })
    await this.page.waitForFunction(
      () => Boolean((window as unknown as { libp2p?: { peerId?: unknown } }).libp2p?.peerId),
      undefined,
      { timeout: 120_000 },
    )
    const peerId = await this.peerId()
    progress(`[${this.name}] ready, peerId=${peerId}`)
  }

  async peerId(): Promise<string> {
    return this.requiredPage().evaluate(() =>
      String((window as unknown as { libp2p: { peerId: unknown } }).libp2p.peerId),
    )
  }

  // universal-connectivity chat is relay-mediated pubsub, NOT a direct
  // browser-to-browser connection: both browsers join the same relay + chat
  // topic and gossipsub forwards messages through the relay. So readiness =
  // "connected to a relay and subscribed to the chat topic", and the actual
  // replication is proven by the message exchange itself (not a direct dial).
  async waitForChatReady(timeout = CONNECT_TIMEOUT) {
    const deadline = Date.now() + timeout
    let lastLog = 0
    while (Date.now() < deadline) {
      const d = await this.diagnostics()
      if (d.connections.length > 0 && d.pubsub.chatSubscribers.length > 0) {
        progress(
          `[${this.name}] chat-ready — relays=${d.connections.length} chatSubs=${d.pubsub.chatSubscribers.length}`,
        )
        return
      }
      if (Date.now() - lastLog > 15_000) {
        lastLog = Date.now()
        progress(
          `[${this.name}] waiting to be chat-ready — conns=${d.connections.length} ` +
            `pubsubPeers=${d.pubsub.peers.length} chatSubs=${d.pubsub.chatSubscribers.length}`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
    const d = await this.diagnostics()
    throw new Error(`${this.name} never became chat-ready. Final diagnostics: ${JSON.stringify(d)}`)
  }

  async sendMessage(message: string) {
    progress(`[${this.name}] sending "${message}"`)
    const input = this.requiredPage().getByPlaceholder('Message')
    await input.fill(message)
    await input.press('Enter')
  }

  async waitForMessage(message: string) {
    await this.requiredPage()
      .getByTestId('chat-message-body')
      .filter({ hasText: message })
      .waitFor({ state: 'visible', timeout: CHAT_TIMEOUT })
    progress(`[${this.name}] received "${message}"`)
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
      progress(`connecting browser B to remote runner ${REMOTE_WS_ENDPOINT}`)
      remoteBrowser = await testkit.connectAlephChromium({
        chromium,
        wsEndpoint: REMOTE_WS_ENDPOINT,
        versionUrl: REMOTE_VERSION_URL,
        secret: REMOTE_SECRET,
        timeoutMs: 120_000,
      })
      progress('browser B connected to remote runner')
    } else {
      progress('no remote endpoint — running both browsers same-machine')
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
      progress(`peers: A=${peerA} B=${peerB}`)

      // Both browsers join a relay + the chat topic; gossipsub then relays
      // messages between them (no direct browser-to-browser dial required).
      progress('waiting for both browsers to be chat-ready...')
      await Promise.all([agentA.waitForChatReady(), agentB.waitForChatReady()])
      evidence.ready = true

      const messageAToB = `remote-repl-a-${Date.now()}`
      const messageBToA = `remote-repl-b-${Date.now()}`
      await agentA.sendMessage(messageAToB)
      await agentB.waitForMessage(messageAToB)
      evidence.messageAToB = messageAToB
      await agentB.sendMessage(messageBToA)
      await agentA.waitForMessage(messageBToA)
      evidence.messageBToA = messageBToA
      evidence.passed = true
      progress('remote replication succeeded')

      evidence.final = { a: await agentA.diagnostics(), b: await agentB.diagnostics() }
      await Promise.all([
        agentA.screenshot(`${OUTPUT_DIR}/local-success.png`),
        agentB.screenshot(`${OUTPUT_DIR}/remote-success.png`),
      ])
    } catch (error) {
      testError = error instanceof Error ? error : new Error(String(error))
      evidence.passed = false
      evidence.error = testError.message
      progress(`FAILED: ${testError.message}`)
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
