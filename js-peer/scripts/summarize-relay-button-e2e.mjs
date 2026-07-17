import { appendFile, readFile } from 'node:fs/promises'

const resultPath = 'test-results/relay-button-chat/result.json'
const moduleSpecifier = process.env.RELAY_BUTTON_TESTKIT_MODULE ?? '@le-space/playwright'
const { formatRelayGithubSummary } = await import(moduleSpecifier)

let result
try {
  result = JSON.parse(await readFile(resultPath, 'utf8'))
} catch (error) {
  result = {
    instanceName: 'not-resolved',
    ownerAddress: 'not-resolved',
    startedAt: new Date().toISOString(),
    error: `No structured Playwright result was available: ${error instanceof Error ? error.message : String(error)}`,
    steps: {},
  }
}

const output = formatRelayGithubSummary(result, 'js-peer Relay Button E2E')
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, output)
} else {
  process.stdout.write(output)
}
