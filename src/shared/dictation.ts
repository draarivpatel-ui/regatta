// Dictation: speak into a composer or a terminal; the words arrive as a draft and are never sent or
// run by Regatta. Speech becomes text on this computer with whisper.cpp.

export type DictationModelId = 'base.en' | 'large-v3-turbo-q5_0'

export interface DictationModel {
  id: DictationModelId
  /** For example "Base, English". */
  name: string
  /** Download size in MiB. */
  sizeMiB: number
  /** "English" or "Many languages". */
  languages: string
  installed: boolean
}

export interface DictationStatus {
  /** Path of whisper.cpp's command line program (`whisper-cli`), or null when it is not installed. */
  engine: string | null
  models: DictationModel[]
  /** The model used for dictation; null until one is installed. */
  model: DictationModelId | null
  /** A download in progress. */
  download: { id: DictationModelId; received: number; total: number } | null
  error: string | null
}

/** A recording stops by itself after this long. */
export const DICTATION_MAX_MS = 120_000
