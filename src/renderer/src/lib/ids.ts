// Small ID generator. Not cryptographically secure, fine for local UI keys.

let counter = 0

export function generateId(): string {
  counter += 1
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}