import { AsyncZipDeflate, Zip, ZipPassThrough, strToU8 } from 'fflate'
import JSZip from 'jszip'

interface SavePickerOptions {
  suggestedName: string
  types: Array<{
    description: string
    accept: Record<string, string[]>
  }>
}

interface FileSystemWindow extends Window {
  showSaveFilePicker?: (options: SavePickerOptions) => Promise<FileSystemFileHandle>
}

export interface DeckHistorySummary {
  key: string
  index: number
  count: number
}

export let activeDeckFileHandle: FileSystemFileHandle | null = null

export function clearActiveDeckFileHandle(): void {
  activeDeckFileHandle = null
}

const AUTOSAVE_DATABASE = 'deckstudio-local-autosave'
const AUTOSAVE_STORE = 'documents'
const AUTOSAVE_KEY = 'latest'
const IMAGE_REFERENCE_PREFIX = 'deck-image:'

function isImageReference(value: string): boolean {
  return value.startsWith('data:image/') || value.startsWith('blob:') || value.startsWith(IMAGE_REFERENCE_PREFIX)
}

function imageExtension(blob: Blob): string {
  const mime = blob.type.toLowerCase().split(';', 1)[0]
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/svg+xml') return 'svg'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/gif') return 'gif'
  return 'png'
}

async function fetchImageBlob(reference: string): Promise<Blob> {
  const response = await fetch(reference)
  if (!response.ok) throw new Error('Não foi possível ler uma imagem do projeto.')
  return response.blob()
}

function encodeConfig(config: unknown): string {
  // Image payloads are already external ZIP entries here; Base64 only obfuscates the smaller JSON config.
  return btoa(unescape(encodeURIComponent(JSON.stringify(config))))
}

function decodeConfig(encoded: string): unknown {
  return JSON.parse(decodeURIComponent(escape(atob(encoded)))) as unknown
}

async function replaceImageReferences(
  value: unknown,
  replace: (reference: string) => Promise<string>,
): Promise<unknown> {
  // Keep image bytes outside JSON and reuse one archive entry for every repeated URL.
  if (typeof value === 'string') {
    return isImageReference(value) ? replace(value) : value
  }
  if (Array.isArray(value)) {
    const result: unknown[] = []
    for (const item of value) result.push(await replaceImageReferences(item, replace))
    return result
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      result[key] = await replaceImageReferences(item, replace)
    }
    return result
  }
  return value
}

interface ArchiveEntry {
  path: string
  blob: Blob
  compress: boolean
}

function generateStreamingZip(entries: ArchiveEntry[]): Promise<Blob> {
  // Images are already compressed; stream them through unchanged and deflate only config in a Worker.
  return new Promise((resolve, reject) => {
    const output: BlobPart[] = []
    let settled = false
    const archive = new Zip((error, chunk, final) => {
      if (error) {
        if (!settled) {
          settled = true
          archive.terminate()
          reject(error)
        }
        return
      }
      if (chunk.byteLength > 0) output.push(chunk)
      if (final && !settled) {
        settled = true
        resolve(new Blob(output, { type: 'application/zip' }))
      }
    })

    void (async () => {
      try {
        for (const entry of entries) {
          const zipEntry = entry.compress
            ? new AsyncZipDeflate(entry.path, { level: 6 })
            : new ZipPassThrough(entry.path)
          archive.add(zipEntry)
          const reader = entry.blob.stream().getReader()
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              zipEntry.push(value, false)
            }
            zipEntry.push(new Uint8Array(0), true)
          } finally {
            reader.releaseLock()
          }
        }
        archive.end()
      } catch (error) {
        if (!settled) {
          settled = true
          archive.terminate()
          reject(error)
        }
      }
    })()
  })
}

export async function createDeckArchive(snapshot: unknown): Promise<Blob> {
  const images = new Map<string, Blob>()
  const referencePaths = new Map<string, string>()
  const contentPaths = new Map<string, string>()
  let imageNumber = 0

  const config = await replaceImageReferences(snapshot, async (reference) => {
    const existingPath = referencePaths.get(reference)
    if (existingPath) return `${IMAGE_REFERENCE_PREFIX}${existingPath}`

    const blob = await fetchImageBlob(reference)
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
    const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    let path = contentPaths.get(fingerprint)
    if (!path) {
      path = `images/image-${String(++imageNumber).padStart(5, '0')}.${imageExtension(blob)}`
      images.set(path, blob)
      contentPaths.set(fingerprint, path)
    }
    referencePaths.set(reference, path)
    return `${IMAGE_REFERENCE_PREFIX}${path}`
  })

  const entries: ArchiveEntry[] = [{
    path: 'config.json',
    blob: new Blob([strToU8(encodeConfig(config))], { type: 'application/json' }),
    compress: true,
  }]
  for (const [path, blob] of images) entries.push({ path, blob, compress: false })
  return generateStreamingZip(entries)
}

export async function readDeckArchive(file: File): Promise<unknown | null> {
  const header = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  if (header[0] !== 0x50 || header[1] !== 0x4b) return null

  let archive: JSZip
  try {
    archive = await JSZip.loadAsync(file)
  } catch {
    throw new Error('O arquivo ZIP do projeto está corrompido ou incompleto.')
  }

  const configFile = archive.file('config.json')
  if (!configFile) throw new Error('O arquivo .deck não contém config.json.')

  const config = decodeConfig(await configFile.async('text'))
  // Fabric and undo history may still reference these URLs, so keep them alive for the loaded document.
  return replaceImageReferences(config, async (reference) => {
    if (!reference.startsWith(IMAGE_REFERENCE_PREFIX)) return reference
    const imagePath = reference.slice(IMAGE_REFERENCE_PREFIX.length)
    const imageFile = archive.file(imagePath)
    if (!imageFile || !imagePath.startsWith('images/')) {
      throw new Error(`Imagem ausente no arquivo .deck: ${imagePath}`)
    }
    return URL.createObjectURL(await imageFile.async('blob'))
  })
}

export async function selecionarLocalArquivo(
  suggestedName: string,
): Promise<'selected' | 'cancelled' | 'unsupported'> {
  const picker = (window as FileSystemWindow).showSaveFilePicker
  if (!picker) return 'unsupported'

  try {
    activeDeckFileHandle = await picker.call(window, {
      suggestedName: suggestedName.endsWith('.deck') ? suggestedName : `${suggestedName}.deck`,
      types: [{ description: 'Projeto Deck Studio', accept: { 'application/zip': ['.deck'] } }],
    })
    return 'selected'
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled'
    throw error
  }
}

export async function writeDeckFile(handle: FileSystemFileHandle, blob: Blob): Promise<void> {
  const writable = await handle.createWritable()
  try {
    await writable.write(blob)
    await writable.close()
  } catch (error) {
    await writable.abort?.().catch(() => undefined)
    throw error
  }
}

export async function writeActiveDeckFile(blob: Blob): Promise<boolean> {
  if (!activeDeckFileHandle) return false
  await writeDeckFile(activeDeckFileHandle, blob)
  return true
}

export async function activeDeckPermissionGranted(): Promise<boolean> {
  const permissionHandle = activeDeckFileHandle as (FileSystemFileHandle & {
    queryPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>
  }) | null
  if (!permissionHandle?.queryPermission) return false
  try {
    return (await permissionHandle.queryPermission({ mode: 'readwrite' })) === 'granted'
  } catch {
    return false
  }
}

function openAutosaveDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(AUTOSAVE_DATABASE, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(AUTOSAVE_STORE)) {
        request.result.createObjectStore(AUTOSAVE_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Falha ao abrir o autosave local.'))
  })
}

export async function saveLightweightAutosave(
  config: unknown,
  history: DeckHistorySummary,
): Promise<void> {
  // The caller strips image sources first, keeping this transaction limited to metadata and history state.
  const database = await openAutosaveDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(AUTOSAVE_STORE, 'readwrite')
    transaction.objectStore(AUTOSAVE_STORE).put({
      savedAt: Date.now(),
      config,
      history,
    }, AUTOSAVE_KEY)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Falha ao gravar o autosave local.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Autosave local cancelado.'))
  }).finally(() => database.close())
}

export function stripImagePayloads(value: unknown): unknown {
  if (typeof value === 'string') return isImageReference(value) ? '' : value
  if (Array.isArray(value)) return value.map(stripImagePayloads)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, stripImagePayloads(item)]),
    )
  }
  return value
}