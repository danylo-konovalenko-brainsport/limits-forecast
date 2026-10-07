export type Step = {
  at: number
  model: string
  outputTokens: number
  inputTokens: number
  cacheRead: number
  cacheWrite: number
  ttftMs: number
  genMs: number
  tps: number
}

declare module 'claude-code' {
  interface PluginState {
    'token-speed': { steps: Step[] }
  }
}
