import JSZip from 'jszip'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

type Json = Record<string, unknown>
interface CoverImage { bytes: Buffer; ext: string }

const IMAGE_REFERENCE_PREFIX = 'deck-image:'

async function extractCover(raw: Buffer): Promise<CoverImage | null> {
  const archive = await JSZip.loadAsync(raw)
  const configFile = archive.file('config.json')
  if (!configFile) return null
  const encoded = await configFile.async('text')
  const config = JSON.parse(decodeURIComponent(escape(atob(encoded)))) as Json
  const deck = (config['deck'] ?? config) as Json
  const cover = typeof deck['cover'] === 'string' ? deck['cover'] : ''
  if (cover.startsWith(IMAGE_REFERENCE_PREFIX)) {
    const path = cover.slice(IMAGE_REFERENCE_PREFIX.length)
    const image = path.startsWith('images/') ? archive.file(path) : null
    if (!image) return null
    return { bytes: await image.async('nodebuffer'), ext: extname(path).slice(1) || 'png' }
  }
  const match = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(cover)
  if (!match) return null
  const type = match[1].toLowerCase()
  return { bytes: Buffer.from(match[2], 'base64'), ext: type === 'jpeg' ? 'jpg' : type.replace(/\+xml$/, '') }
}

// Extrai a capa de cada .deck para dist/decks/covers e referencia em index.json.
function extractDeckCovers(): Plugin {
  let outDir = 'dist'
  let root = process.cwd()
  return {
    name: 'extract-deck-covers',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
      root = config.root
    },
    async closeBundle() {
      const srcDir = join(root, 'public', 'decks')
      const outDecks = join(outDir, 'decks')
      const indexPath = join(outDecks, 'index.json')
      if (!existsSync(indexPath)) return
      const entries = JSON.parse(readFileSync(indexPath, 'utf8')) as Json[]
      const coversDir = join(outDecks, 'covers')
      mkdirSync(coversDir, { recursive: true })
      for (const entry of entries) {
        const file = typeof entry['file'] === 'string' ? basename(entry['file']) : ''
        if (!file) continue
        try {
          const cover = await extractCover(readFileSync(join(srcDir, file)))
          if (!cover) continue
          const coverName = `${basename(file, extname(file))}.${cover.ext}`
          writeFileSync(join(coversDir, coverName), cover.bytes)
          entry['cover'] = `covers/${coverName}`
        } catch {
          // Sem capa extraível: a interface usa o fallback.
        }
      }
      writeFileSync(indexPath, JSON.stringify(entries, null, 2))
    },
  }
}

export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [extractDeckCovers()],
})
