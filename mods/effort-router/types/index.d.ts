export type Mode = 'chat' | 'impl'

export type Pin = 'auto' | Mode

export type Stats = {
  /** Duration of each classifier call that answered, in ms; the newest 200. */
  samples: number[]
  /** Calls cut by the timeout: the mode in force was kept. */
  timeouts: number
  /** Calls that failed or named no mode: the mode in force was kept. */
  failures: number
  /** Messages routed without a classifier call. */
  skipped: number
}

declare module 'claude-code' {
  interface PluginState {
    'effort-router': { mode: Mode; pin: Pin; stats: Stats }
  }
}
