/** Error thrown by a module whose package has not been built yet. The UI shows the message. */
export function notBuilt(feature: string): Error {
  return new Error(`${feature} is not built yet`)
}
