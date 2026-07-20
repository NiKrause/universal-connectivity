import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { privateKeyToAccount } from 'viem/accounts'

const PRIVATE_KEY = process.env.RELAY_BUTTON_E2E_PRIVATE_KEY?.trim()
const SSH_PUBLIC_KEY = process.env.RELAY_BUTTON_E2E_SSH_PUBLIC_KEY?.trim()
const APP_URL = process.env.RELAY_BUTTON_E2E_APP_URL ?? 'http://127.0.0.1:4173'
const TESTKIT_MODULE = process.env.RELAY_BUTTON_TESTKIT_MODULE ?? '@le-space/playwright'
const OUTPUT_DIR = 'test-results/relay-button-chat'
const RELAY_READINESS_TIMEOUT = 8 * 60_000
const CHAT_TIMEOUT = 3 * 60_000
const CHAT_TOPIC = 'universal-connectivity'
const CLEANUP_INSTANCE_HASHES = (process.env.RELAY_BUTTON_E2E_CLEANUP_INSTANCE_HASHES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

type WalletAccount = ReturnType<typeof privateKeyToAccount>
type EvidenceStatus = 'pending' | 'passed' | 'failed' | 'skipped'
type RelayEvidence = {
  instanceName: string
  ownerAddress: string
  startedAt: string
  finishedAt?: string
  instanceHash?: string
  error?: string
  steps: Record<string, { label: string; status: EvidenceStatus; detail?: string }>
  [key: string]: unknown
}
type ProvisionedRelay = {
  instanceHash: string
  peerId: string
  addresses: string[]
  registration: unknown
}
type RelayTestkit = {
  installEip1193WalletMock(context: BrowserContext, account: WalletAccount): Promise<void>
  provisionRelay(
    page: Page,
    options: {
      accountAddress: string
      instanceName: string
      sshPublicKey: string
      startedAt: number
      onDeploymentSubmitted?: () => void
      onPhase?: (
        phase: 'wallet-and-manifest-ready' | 'deployment-submitted' | 'instance-resolved' | 'bootstrap-resolved',
        detail?: string,
      ) => void
    },
  ): Promise<ProvisionedRelay>
  findAlephInstanceHash(options: {
    ownerAddress: string
    instanceName: string
    startedAt: number
    timeoutMs?: number
  }): Promise<string>
  waitForPubsubSubscriber(
    page: Page,
    options: {
      topic: string
      peerId: string
      timeoutMs?: number
      pollIntervalMs?: number
      stableForMs?: number
    },
  ): Promise<string[]>
  cleanupRelay(options: {
    page: Page
    account: WalletAccount
    instanceName: string
    instanceHash: string
    eraseFirst?: boolean
    driver?: { requestDelete(instanceName: string): Promise<void> }
  }): Promise<{
    fallbackUsed: boolean
    eraseSummary: string
    forgetSummary: string
    verificationSummary: string
  }>
  createRelayEvidence(options: {
    instanceName: string
    ownerAddress: string
    startedAt: number
    steps: Record<string, string>
  }): RelayEvidence
  updateRelayEvidenceStep(evidence: RelayEvidence, step: string, status: EvidenceStatus, detail?: string): void
  writeRelayEvidence(path: string, evidence: RelayEvidence): Promise<void>
  createProgressLogger(options?: { label?: string; log?: (line: string) => void }): {
    progress(message: string): void
    stage(name: string, detail?: string): void
  }
  forwardBrowserConsole(
    page: Page,
    options: {
      label: string
      log?: (line: string) => void
      filter?: RegExp | ((text: string) => boolean) | null
      maxLength?: number
    },
  ): void
}

let testkitPromise: Promise<RelayTestkit> | undefined

function loadRelayTestkit(): Promise<RelayTestkit> {
  testkitPromise ??= import(TESTKIT_MODULE) as Promise<RelayTestkit>
  return testkitPromise
}

class ChatBrowserAgent {
  context: BrowserContext | null = null
  page: Page | null = null

  constructor(
    readonly name: string,
    readonly browser: Browser,
    readonly testkit: RelayTestkit,
  ) {}

  async open() {
    this.context = await this.browser.newContext()
    this.page = await this.context.newPage()
    // Stream this browser's libp2p console activity into the test log so the run
    // is diagnosable instead of silent for minutes.
    this.testkit.forwardBrowserConsole(this.page, { label: this.name })
    await this.page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await this.page.getByPlaceholder('Message').waitFor({ state: 'visible', timeout: 120_000 })
    await this.page.waitForFunction(
      () => Boolean((window as unknown as { libp2p?: { peerId?: unknown } }).libp2p?.peerId),
      undefined,
      { timeout: 120_000 },
    )
  }

  async connectToRelay(addresses: string[], relayPeerId: string) {
    const deadline = Date.now() + RELAY_READINESS_TIMEOUT
    const attempts: { address: string; error?: string }[] = []

    while (Date.now() < deadline) {
      for (const address of addresses) {
        const page = this.requiredPage()
        try {
          if (
            !(await page
              .getByRole('dialog')
              .isVisible()
              .catch(() => false))
          ) {
            await page.getByRole('button', { name: /libp2p node info|Node/ }).click()
          }
          const dialog = page.getByRole('dialog')
          await dialog.getByLabel('Multiaddr to connect to').fill(address)
          await dialog.getByRole('button', { name: /Connect to multiaddr/ }).click()
          await this.waitForRelayConnection(relayPeerId, 20_000)
          await page.keyboard.press('Escape')
          return { address, attempts }
        } catch (error) {
          attempts.push({ address, error: error instanceof Error ? error.message : String(error) })
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    }
    throw new Error(`${this.name} did not connect to ${relayPeerId}: ${JSON.stringify(attempts)}`)
  }

  async waitForRelayConnection(relayPeerId: string, timeout = CHAT_TIMEOUT) {
    await this.requiredPage().waitForFunction(
      (expectedPeerId) =>
        (
          (
            window as unknown as { libp2p: { getConnections: () => { remotePeer: unknown }[] } }
          ).libp2p.getConnections() ?? []
        ).some(({ remotePeer }) => String(remotePeer) === expectedPeerId),
      relayPeerId,
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
    await this.page?.screenshot({ path, fullPage: true })
  }

  pageForTestkit() {
    return this.requiredPage()
  }

  async diagnostics() {
    return this.requiredPage().evaluate((topic) => {
      const node = (
        window as unknown as {
          libp2p: {
            peerId: unknown
            getMultiaddrs: () => unknown[]
            getConnections: () => { remotePeer: unknown; remoteAddr: unknown }[]
            services: {
              pubsub: {
                getPeers: () => unknown[]
                getSubscribers: (topic: string) => unknown[]
              }
            }
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
    await this.context?.close()
  }

  private requiredPage() {
    if (!this.page) throw new Error(`${this.name} is not open`)
    return this.page
  }
}

test.describe('React Relay Button chat', () => {
  test.skip(!PRIVATE_KEY, 'RELAY_BUTTON_E2E_PRIVATE_KEY is required to provision an Aleph relay')
  test.skip(!SSH_PUBLIC_KEY, 'RELAY_BUTTON_E2E_SSH_PUBLIC_KEY is required to provision an Aleph relay')
  test.setTimeout(45 * 60_000)

  test('provisions a uc-go-peer and exchanges chat messages through it in two browsers', async ({ browser }) => {
    await mkdir(OUTPUT_DIR, { recursive: true })
    const testkit = await loadRelayTestkit()
    const account = privateKeyToAccount(
      PRIVATE_KEY!.startsWith('0x') ? (PRIVATE_KEY as `0x${string}`) : `0x${PRIVATE_KEY}`,
    )
    const instanceName = `uc-chat-e2e-${Date.now()}`
    const startedAt = Date.now()
    const evidence = testkit.createRelayEvidence({
      instanceName,
      ownerAddress: account.address,
      startedAt,
      steps: {
        preflightCleanup: 'Previously leaked E2E instances deleted',
        walletAndManifest: 'Wallet connected and uc-go-peer manifest accepted',
        instanceProvisioned: 'Aleph uc-go-peer VM provisioned',
        bootstrapPublished: 'New peer published authenticated browser addresses',
        browserAConnected: 'Browser A connected to the new peer',
        browserBConnected: 'Browser B connected to the new peer',
        pubsubReady: 'Both browsers joined the Relay PubSub topic',
        messageAToB: 'Public chat message travelled A → B',
        messageBToA: 'Public chat message travelled B → A',
        cleanup: 'Temporary Aleph INSTANCE forgotten and deallocated',
      },
    })
    const deploymentContext = await browser.newContext()
    await testkit.installEip1193WalletMock(deploymentContext, account)
    const deploymentPage = await deploymentContext.newPage()
    const progress = testkit.createProgressLogger({ label: 'relay-chat' })
    const agentA = new ChatBrowserAgent('browser-a', browser, testkit)
    const agentB = new ChatBrowserAgent('browser-b', browser, testkit)
    let deploymentSubmitted = false
    let instanceHash: string | null = null
    let currentStep = 'preflightCleanup'
    let testError: Error | null = null
    let cleanupError: Error | null = null
    const pass = (step: string, detail = '') => {
      progress.stage(step, detail || undefined)
      testkit.updateRelayEvidenceStep(evidence, step, 'passed', detail)
    }

    try {
      if (CLEANUP_INSTANCE_HASHES.length > 0) {
        const cleanupSummaries = await Promise.all(
          CLEANUP_INSTANCE_HASHES.map((hash) =>
            testkit.cleanupRelay({
              page: deploymentPage,
              account,
              instanceName: `orphan-${hash.slice(0, 8)}`,
              instanceHash: hash,
              eraseFirst: true,
              driver: {
                requestDelete: async () => {
                  throw new Error('Preflight cleanup has no Relay Button UI record')
                },
              },
            }),
          ),
        )
        pass('preflightCleanup', cleanupSummaries.map(({ verificationSummary }) => verificationSummary).join('\n'))
      } else {
        testkit.updateRelayEvidenceStep(evidence, 'preflightCleanup', 'skipped', 'No cleanup input supplied')
      }

      currentStep = 'walletAndManifest'
      progress.stage('provisioning', `${instanceName} via ${APP_URL}`)
      await deploymentPage.goto(APP_URL, { waitUntil: 'domcontentloaded' })
      const relay = await testkit.provisionRelay(deploymentPage, {
        accountAddress: account.address,
        instanceName,
        sshPublicKey: SSH_PUBLIC_KEY!,
        startedAt,
        onDeploymentSubmitted: () => {
          deploymentSubmitted = true
        },
        onPhase: (phase, detail = '') => {
          if (phase === 'wallet-and-manifest-ready') {
            pass('walletAndManifest')
          } else if (phase === 'deployment-submitted') {
            currentStep = 'instanceProvisioned'
          } else if (phase === 'instance-resolved') {
            pass('instanceProvisioned', detail)
            currentStep = 'bootstrapPublished'
          } else {
            pass('bootstrapPublished', detail)
          }
        },
      })
      instanceHash = relay.instanceHash
      evidence.instanceHash = instanceHash
      evidence.registration = relay.registration
      evidence.relayAddresses = relay.addresses

      currentStep = 'browserAConnected'
      progress.stage('opening-browsers', `both loading ${APP_URL}`)
      await Promise.all([agentA.open(), agentB.open()])
      progress.stage('connecting-relay', `${relay.peerId} via ${relay.addresses.length} address(es)`)
      const connectionA = await agentA.connectToRelay(relay.addresses, relay.peerId)
      pass('browserAConnected', connectionA.address)
      currentStep = 'browserBConnected'
      const connectionB = await agentB.connectToRelay(relay.addresses, relay.peerId)
      pass('browserBConnected', connectionB.address)
      evidence.relayConnections = { browserA: connectionA, browserB: connectionB }

      currentStep = 'pubsubReady'
      const [subscribersA, subscribersB] = await Promise.all([
        testkit.waitForPubsubSubscriber(agentA.pageForTestkit(), {
          topic: CHAT_TOPIC,
          peerId: relay.peerId,
          timeoutMs: CHAT_TIMEOUT,
          stableForMs: 2_000,
        }),
        testkit.waitForPubsubSubscriber(agentB.pageForTestkit(), {
          topic: CHAT_TOPIC,
          peerId: relay.peerId,
          timeoutMs: CHAT_TIMEOUT,
          stableForMs: 2_000,
        }),
      ])
      evidence.pubsubReadiness = { browserA: subscribersA, browserB: subscribersB }
      pass('pubsubReady', `${relay.peerId} stable on ${CHAT_TOPIC} in both browsers`)

      const messageA = `${instanceName}-from-a`
      const messageB = `${instanceName}-from-b`
      currentStep = 'messageAToB'
      await agentA.sendMessage(messageA)
      await agentB.waitForMessage(messageA)
      pass('messageAToB', messageA)
      currentStep = 'messageBToA'
      await agentB.sendMessage(messageB)
      await agentA.waitForMessage(messageB)
      pass('messageBToA', messageB)

      evidence.final = { browserA: await agentA.diagnostics(), browserB: await agentB.diagnostics() }
      await Promise.all([
        agentA.screenshot(`${OUTPUT_DIR}/browser-a.png`),
        agentB.screenshot(`${OUTPUT_DIR}/browser-b.png`),
        deploymentPage.screenshot({ path: `${OUTPUT_DIR}/relay-panel.png`, fullPage: true }),
      ])
    } catch (error) {
      testError = error instanceof Error ? error : new Error(String(error))
      if (evidence.steps[currentStep]?.status === 'pending') {
        testkit.updateRelayEvidenceStep(evidence, currentStep, 'failed', testError.message)
      }
      evidence.error = testError.message
      const failureDiagnostics = await Promise.allSettled([agentA.diagnostics(), agentB.diagnostics()])
      evidence.failureDiagnostics = {
        browserA:
          failureDiagnostics[0].status === 'fulfilled'
            ? failureDiagnostics[0].value
            : { error: String(failureDiagnostics[0].reason) },
        browserB:
          failureDiagnostics[1].status === 'fulfilled'
            ? failureDiagnostics[1].value
            : { error: String(failureDiagnostics[1].reason) },
      }
      await Promise.allSettled([
        agentA.screenshot(`${OUTPUT_DIR}/browser-a-error.png`),
        agentB.screenshot(`${OUTPUT_DIR}/browser-b-error.png`),
        deploymentPage.screenshot({ path: `${OUTPUT_DIR}/relay-panel-error.png`, fullPage: true }),
      ])
    }

    await Promise.allSettled([agentA.close(), agentB.close()])
    if (deploymentSubmitted) {
      try {
        instanceHash ??= await testkit.findAlephInstanceHash({
          ownerAddress: account.address,
          instanceName,
          startedAt,
          timeoutMs: 60_000,
        })
        evidence.instanceHash = instanceHash
        const cleanup = await testkit.cleanupRelay({
          page: deploymentPage,
          account,
          instanceName,
          instanceHash,
        })
        pass('cleanup', [cleanup.eraseSummary, cleanup.forgetSummary, cleanup.verificationSummary].join('; '))
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error(String(error))
        testkit.updateRelayEvidenceStep(evidence, 'cleanup', 'failed', cleanupError.message)
      }
    } else {
      testkit.updateRelayEvidenceStep(evidence, 'cleanup', 'skipped', 'No VM was submitted')
    }

    await testkit.writeRelayEvidence(`${OUTPUT_DIR}/result.json`, evidence)
    await deploymentContext.close()
    if (cleanupError) throw cleanupError
    if (testError) throw testError
  })
})
