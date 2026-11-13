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
  /**
   * Calls that named a mode below the minimum confidence: the mode in force
   * was kept. Absent from stats an earlier version stored; read it `?? 0`.
   */
  unsure: number
}

/** How the most recent routed message got its mode. */
export type Last =
  /** The classifier named a mode with enough confidence, from 0 to 1. */
  | { how: 'classifier'; mode: Mode; confidence: number; ms: number }
  /** The classifier named a mode below the minimum confidence: `kept` stayed in force. */
  | { how: 'unsure'; mode: Mode; confidence: number; ms: number; kept: Mode }
  /** The classifier was cut by its timeout: `kept` stayed in force. */
  | { how: 'timeout'; ms: number; kept: Mode }
  /** The classifier failed or named no mode: `kept` stayed in force. */
  | { how: 'failure'; ms: number; detail: string; kept: Mode }
  /** A pinned mode: no classifier call. */
  | { how: 'pinned' }
  /** A bare approval in impl: no classifier call. */
  | { how: 'ack' }

declare module 'claude-code' {
  interface PluginState {
    'effort-router': {
      mode: Mode
      pin: Pin
      stats: Stats
      /** `null` until the first routed message. */
      last: Shaped<Last | null>
    }
  }
}
