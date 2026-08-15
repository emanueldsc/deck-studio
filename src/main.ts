import {
  Canvas,
  FabricImage,
  FabricText,
  Textbox,
  type FabricObject,
} from 'fabric'
import { jsPDF } from 'jspdf'
import JSZip from 'jszip'
import './style.css'

type LayerKind =
  | 'base'
  | 'image'
  | 'text'

type LayerScope = 'model' | 'deck'
type EditMode = LayerScope
type ImageFitMode = 'fill' | 'contain' | 'cover' | 'none' | 'scale-down'

interface LayerMeta {
  id: string
  name: string
  kind: LayerKind
  scope: LayerScope
  fit?: ImageFitMode
  slotWidth?: number
  slotHeight?: number
}

interface CardModelOverride {
  text?: string
  src?: string
  fit?: ImageFitMode
}

interface CardState {
  id: string
  name: string
  deckObjects: unknown[]
  modelOverrides: Record<string, CardModelOverride>
  thumbnail: string
}

interface DeckDocument {
  id: string
  name: string
  modelCanvas: ReturnType<Canvas['toObject']>
  cards: CardState[]
  activeCardId: string
}

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('Elemento #app nao encontrado.')
}

const CARD_WIDTH = 630
const CARD_HEIGHT = 880
const ZOOM_MIN = 0.2
const ZOOM_MAX = 4
const ZOOM_STEP = 0.05
const PREVIEW_MAX_CARDS = 48
const FONT_OPTIONS = [
  'Cinzel Decorative',
  'Galada',
  'Lobster Two',
  'Arial',
  'Times New Roman',
  'Courier New',
]

const DEFAULT_DECK_NAME = 'Baralho 1'

interface SizePreset {
  key: string
  label: string
  widthMm: number
  heightMm: number
}

const CARD_SIZE_PRESETS: SizePreset[] = [
  { key: 'tcg', label: '63 x 88 mm (TCG)', widthMm: 63, heightMm: 88 },
  { key: 'yugioh', label: '59 x 86 mm (Yu-Gi-Oh)', widthMm: 59, heightMm: 86 },
  { key: 'poker', label: '63 x 89 mm (Poker)', widthMm: 63, heightMm: 89 },
  { key: 'uno', label: '56 x 87 mm (UNO)', widthMm: 56, heightMm: 87 },
  { key: 'uno-itu', label: '100 x 150 mm (UNO ITU)', widthMm: 100, heightMm: 150 },
  { key: 'euro-standard', label: '59 x 92 mm (Euro Standard)', widthMm: 59, heightMm: 92 },
  { key: 'euro-mini', label: '44 x 68 mm (Euro Mini)', widthMm: 44, heightMm: 68 },
  { key: 'taro', label: '70 x 120 mm (Taro)', widthMm: 70, heightMm: 120 },
]

const PAPER_SIZE_PRESETS: SizePreset[] = [
  { key: 'a4', label: 'A4 (210 x 297 mm)', widthMm: 210, heightMm: 297 },
  { key: 'a3', label: 'A3 (297 x 420 mm)', widthMm: 297, heightMm: 420 },
  { key: 'a5', label: 'A5 (148 x 210 mm)', widthMm: 148, heightMm: 210 },
  { key: 'letter', label: 'Carta (216 x 279 mm)', widthMm: 216, heightMm: 279 },
  { key: 'oficio', label: 'Oficio (216 x 330 mm)', widthMm: 216, heightMm: 330 },
]

let activeEditMode: EditMode = 'deck'
let deckCount = 0
let deckDocuments: DeckDocument[] = []
let activeDeckId = ''

function generateDeckId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  deckCount += 1
  return `deck-${Date.now()}-${deckCount}`
}

function createEmptyCanvasState(): ReturnType<Canvas['toObject']> {
  return {
    version: '7.4.0',
    objects: [],
  } as ReturnType<Canvas['toObject']>
}

function createDeckDocument(name = DEFAULT_DECK_NAME): DeckDocument {
  const firstCard: CardState = {
    id: generateDeckId(),
    name: 'Carta 1',
    deckObjects: [],
    modelOverrides: {},
    thumbnail: '',
  }
  return {
    id: generateDeckId(),
    name,
    modelCanvas: createEmptyCanvasState(),
    cards: [firstCard],
    activeCardId: firstCard.id,
  }
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isImageFitMode(value: unknown): value is ImageFitMode {
  return value === 'fill' || value === 'contain' || value === 'cover' || value === 'none' || value === 'scale-down'
}

function normalizeImageFit(value: unknown, fallback: ImageFitMode = 'contain'): ImageFitMode {
  return isImageFitMode(value) ? value : fallback
}

function sourceObjectBox(object: FabricObject): { width: number; height: number } {
  return {
    width: Math.max(1, Math.abs((object.width ?? 1) * (object.scaleX ?? 1))),
    height: Math.max(1, Math.abs((object.height ?? 1) * (object.scaleY ?? 1))),
  }
}

function applyImageFit(image: FabricImage, fit: ImageFitMode, targetWidth: number, targetHeight: number): void {
  const naturalWidth = Math.max(1, image.width ?? 1)
  const naturalHeight = Math.max(1, image.height ?? 1)

  if (fit === 'fill') {
    image.set({ scaleX: targetWidth / naturalWidth, scaleY: targetHeight / naturalHeight })
    return
  }

  let scale = 1
  if (fit === 'contain') {
    scale = Math.min(targetWidth / naturalWidth, targetHeight / naturalHeight)
  } else if (fit === 'cover') {
    scale = Math.max(targetWidth / naturalWidth, targetHeight / naturalHeight)
  } else if (fit === 'scale-down') {
    scale = Math.min(1, Math.min(targetWidth / naturalWidth, targetHeight / naturalHeight))
  }

  image.set({ scaleX: scale, scaleY: scale })
}

function applyImageFitForObject(object: FabricImage, fit: ImageFitMode): void {
  const meta = getLayerMeta(object)
  const target = {
    width: Math.max(1, meta.slotWidth ?? sourceObjectBox(object).width),
    height: Math.max(1, meta.slotHeight ?? sourceObjectBox(object).height),
  }

  applyImageFit(object, fit, target.width, target.height)
  setLayerMeta(object, { ...meta, fit, slotWidth: target.width, slotHeight: target.height })
}

async function replaceIllustrationOnObject(object: FabricImage, url: string, fit: ImageFitMode): Promise<void> {
  const meta = getLayerMeta(object)
  await object.setSrc(url)
  applyImageFitForObject(object, fit)
  setLayerMeta(object, { ...meta, fit, slotWidth: meta.slotWidth, slotHeight: meta.slotHeight })
  object.setCoords()
}

function selectedEditableImageObject(): FabricImage | null {
  const activeObject = canvas.getActiveObject()
  if (!(activeObject instanceof FabricImage)) {
    return null
  }

  const meta = getLayerMeta(activeObject)
  if (meta.kind !== 'image') {
    return null
  }

  if (meta.scope !== activeEditMode && !(activeEditMode === 'deck' && meta.scope === 'model')) {
    return null
  }

  return activeObject
}

function openIllustrationUpload(): void {
  if (!selectedEditableImageObject()) {
    return
  }

  imageInput.click()
}

function createImageBehaviorControls(object: FabricImage): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const meta = getLayerMeta(object)

  const fileField = document.createElement('input')
  fileField.type = 'file'
  fileField.accept = 'image/*'
  attachNoDragPropagation(fileField)
  fileField.addEventListener('change', async () => {
    const file = fileField.files?.[0]
    if (!file) return
    try {
      const dataUrl = await fileToDataUrl(file)
      await replaceIllustrationOnObject(object, dataUrl, normalizeImageFit(meta.fit ?? 'contain'))
      canvas.requestRenderAll()
      persistActiveDeckDocument()
      renderCardThumbnails()
    } catch {
      window.alert('Falha ao substituir a ilustracao desta carta.')
    } finally {
      fileField.value = ''
    }
  })
  fragment.append(detailsRow('Ilustração carregue uma imagem.', fileField))

  const hint = document.createElement('p')
  hint.className = 'layer-note'
  hint.textContent = 'Dê duplo clique na imagem para abrir o upload.'
  fragment.append(hint)

  return fragment
}

function layerIdFromSerialized(object: unknown): string | null {
  if (!object || typeof object !== 'object') return null
  const data = (object as { data?: Partial<LayerMeta> }).data
  if (!data?.id) return null
  return data.id
}

function layerFitFromSerialized(object: unknown): ImageFitMode | undefined {
  if (!object || typeof object !== 'object') return undefined
  const data = (object as { data?: Partial<LayerMeta> }).data
  if (!isImageFitMode(data?.fit)) return undefined
  return data.fit
}

function collectCardModelOverrides(
  modelBaseObjects: unknown[],
  modelCurrentObjects: unknown[],
): Record<string, CardModelOverride> {
  const baseById = new Map<string, Record<string, unknown>>()
  for (const object of modelBaseObjects) {
    const id = layerIdFromSerialized(object)
    if (!id || typeof object !== 'object') continue
    baseById.set(id, object as Record<string, unknown>)
  }

  const overrides: Record<string, CardModelOverride> = {}

  for (const object of modelCurrentObjects) {
    if (!object || typeof object !== 'object') continue
    const current = object as Record<string, unknown>
    const id = layerIdFromSerialized(current)
    if (!id) continue

    const data = current['data'] as Partial<LayerMeta> | undefined
    const kind = data?.kind
    if (kind !== 'text' && kind !== 'image') continue

    const base = baseById.get(id)
    if (!base) continue

    if (kind === 'text') {
      const currentText = String(current['text'] ?? '')
      const baseText = String(base['text'] ?? '')
      if (currentText !== baseText) {
        overrides[id] = { text: currentText }
      }
      continue
    }

    const currentSrc = typeof current['src'] === 'string' ? current['src'] : ''
    const baseSrc = typeof base['src'] === 'string' ? base['src'] : ''
    const currentFit = isImageFitMode(data?.fit) ? data.fit : undefined
    if (currentSrc && currentSrc !== baseSrc) {
      overrides[id] = { src: currentSrc, fit: currentFit }
      continue
    }

    if (currentFit) {
      overrides[id] = { fit: currentFit }
    }
  }

  return overrides
}

function cloneCanvasState(state: ReturnType<Canvas['toObject']>): ReturnType<Canvas['toObject']> {
  return JSON.parse(JSON.stringify(state)) as ReturnType<Canvas['toObject']>
}

function currentDeck(): DeckDocument {
  const found = deckDocuments.find((deck) => deck.id === activeDeckId)
  if (!found) {
    if (deckDocuments.length === 0) {
      const deck = createDeckDocument()
      deckDocuments.push(deck)
      activeDeckId = deck.id
      return deck
    }

    activeDeckId = deckDocuments[0].id
    return deckDocuments[0]
  }

  return found
}

function captureCardThumbnail(): string {
  return canvas.toDataURL({ format: 'jpeg', quality: 0.35, multiplier: 0.22 })
}

function applyDeckModelImageFit(targetCanvas: Canvas): void {
  targetCanvas.getObjects().forEach((object) => {
    const meta = getLayerMeta(object)
    if (meta.kind !== 'image' || meta.scope !== 'model' || !(object instanceof FabricImage)) {
      return
    }

    // Keep model image slots stable for every render path (editor, thumbnails, print).
    const fit = normalizeImageFit(meta.fit ?? 'contain')
    const targetWidth = Math.max(1, meta.slotWidth ?? object.getScaledWidth?.() ?? object.width ?? 1)
    const targetHeight = Math.max(1, meta.slotHeight ?? object.getScaledHeight?.() ?? object.height ?? 1)

    applyImageFit(object, fit, targetWidth, targetHeight)
    setLayerMeta(object, { ...meta, fit, slotWidth: targetWidth, slotHeight: targetHeight })
    object.setCoords()
  })
}

async function captureDeckCardThumbnail(deck: DeckDocument, cardId: string): Promise<string> {
  thumbnailCanvas.clear()
  await thumbnailCanvas.loadFromJSON(buildCardCanvasState(deck, cardId))
  applyDeckModelImageFit(thumbnailCanvas)
  thumbnailCanvas.setViewportTransform([1, 0, 0, 1, 0, 0])
  thumbnailCanvas.requestRenderAll()
  return thumbnailCanvas.toDataURL({ format: 'jpeg', quality: 0.35, multiplier: 0.22 })
}

async function refreshDeckThumbnails(deck: DeckDocument): Promise<void> {
  for (const card of deck.cards) {
    try {
      card.thumbnail = await captureDeckCardThumbnail(deck, card.id)
    } catch {
      card.thumbnail = ''
    }
  }

  if (deck.id === activeDeckId && activeEditMode === 'deck') {
    renderCardThumbnails()
  }
}

function persistActiveDeckDocument(): void {
  const deck = currentDeck()
  const snapshot = canvas.toObject(['data'])
  const all = (snapshot.objects ?? []) as Array<{ data?: Partial<LayerMeta> }>
  const modelObjects = all.filter(o => o.data?.scope === 'model') as unknown[]

  if (activeEditMode === 'model') {
    deck.modelCanvas = {
      ...snapshot,
      objects: modelObjects as ReturnType<Canvas['toObject']>['objects'],
    }
    return
  }

  const card = deck.cards.find(c => c.id === deck.activeCardId)
  if (card) {
    card.modelOverrides = collectCardModelOverrides(
      (deck.modelCanvas.objects ?? []) as unknown[],
      modelObjects,
    )
    card.deckObjects = all.filter(o => o.data?.scope !== 'model') as unknown[]
    try {
      card.thumbnail = captureCardThumbnail()
    } catch {
      card.thumbnail = ''
    }
  }
}

function buildCardCanvasState(deck: DeckDocument, cardId: string): ReturnType<Canvas['toObject']> {
  const card = deck.cards.find(c => c.id === cardId) ?? deck.cards[0]
  const modelObjects = deepClone((deck.modelCanvas.objects ?? []) as Array<Record<string, unknown>>)

  for (const object of modelObjects) {
    const id = layerIdFromSerialized(object)
    if (!id) continue
    const override = card?.modelOverrides?.[id]
    if (!override) continue
    if (typeof override.text === 'string') object['text'] = override.text
    if (typeof override.src === 'string' && override.src && override.src !== object['src']) {
      // Changing src: remove stale dimensions so Fabric.js uses the new image's natural size
      delete object['width']
      delete object['height']
      object['src'] = override.src
    } else if (typeof override.src === 'string' && override.src) {
      object['src'] = override.src
    }
    const overrideFit = override.fit ?? layerFitFromSerialized(object)
    const existingData = object['data'] as Record<string, unknown> | undefined
    object['data'] = {
      ...existingData,
      ...(overrideFit ? { fit: overrideFit } : {}),
      // preserve slot dimensions so loadDeckCanvas can reapply fit without recalculating
      ...(existingData?.['slotWidth'] != null ? { slotWidth: existingData['slotWidth'] } : {}),
      ...(existingData?.['slotHeight'] != null ? { slotHeight: existingData['slotHeight'] } : {}),
    }
  }

  return {
    ...deck.modelCanvas,
    objects: [
      ...modelObjects,
      ...((card?.deckObjects ?? []) as ReturnType<Canvas['toObject']>['objects']),
    ],
  }
}

async function loadActiveDeckCard(deck: DeckDocument, cardId?: string): Promise<void> {
  const target = deck.cards.find(c => c.id === (cardId ?? deck.activeCardId)) ?? deck.cards[0]
  if (target) deck.activeCardId = target.id
  await loadDeckCanvas(buildCardCanvasState(deck, deck.activeCardId))
}

async function switchToModelView(): Promise<void> {
  if (activeEditMode === 'model') return
  persistActiveDeckDocument() // activeEditMode is 'deck' here → saves both model and card
  activeEditMode = 'model'
  const deck = currentDeck()
  canvas.clear()
  layerById.clear()
  baseLayerId = ''
  await canvas.loadFromJSON(deck.modelCanvas)
  canvas.getObjects().forEach(obj => {
    const meta = getLayerMeta(obj)
    if (meta.kind === 'base') baseLayerId = meta.id
    applyRuntimeConfig(obj)
  })
  refreshLayerIndex()
  renderLayersAccordion()
  canvas.discardActiveObject()
  canvas.requestRenderAll()
  renderWorkspaceTabs()
}

async function switchToCardView(): Promise<void> {
  if (activeEditMode === 'deck') return
  persistActiveDeckDocument() // activeEditMode is 'model' here → saves only modelCanvas
  activeEditMode = 'deck'
  await loadActiveDeckCard(currentDeck())
  await refreshDeckThumbnails(currentDeck())
  renderWorkspaceTabs()
}

function normalizeScope(value: unknown, kind: LayerKind): LayerScope {
  if (value === 'model' || value === 'deck') {
    return value
  }

  return kind === 'base' ? 'model' : activeEditMode
}

async function decompressDeckText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)

  if (
    bytes.length >= 2 &&
    bytes[0] === 0x1f &&
    bytes[1] === 0x8b &&
    typeof DecompressionStream !== 'undefined'
  ) {
    const compressed = new Blob([bytes])
    const decompressedStream = compressed.stream().pipeThrough(new DecompressionStream('gzip'))
    const decompressedBuffer = await new Response(decompressedStream).arrayBuffer()
    return new TextDecoder().decode(decompressedBuffer)
  }

  return new TextDecoder().decode(buffer)
}

async function compressTextToBlob(text: string): Promise<Blob> {
  if (typeof CompressionStream === 'undefined') {
    return new Blob([text], { type: 'application/json' })
  }

  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  const buffer = await new Response(stream).arrayBuffer()
  return new Blob([buffer], { type: 'application/gzip' })
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function markObjectScope(object: FabricObject, scope: LayerScope): void {
  const meta = getLayerMeta(object)
  setLayerMeta(object, { ...meta, scope })
}

function migrateDeckDocument(raw: Record<string, unknown>): DeckDocument {
  if (raw['modelCanvas'] && Array.isArray(raw['cards'])) {
    const deck = raw as unknown as DeckDocument
    return {
      ...deck,
      cards: deck.cards.map((card, index) => ({
        id: card.id || generateDeckId(),
        name: card.name || `Carta ${index + 1}`,
        deckObjects: Array.isArray(card.deckObjects) ? card.deckObjects : [],
        modelOverrides: card.modelOverrides && typeof card.modelOverrides === 'object' ? card.modelOverrides : {},
        thumbnail: card.thumbnail || '',
      })),
      activeCardId: deck.activeCardId || deck.cards[0]?.id || '',
    }
  }
  const oldCanvas = (raw['canvas'] ?? createEmptyCanvasState()) as ReturnType<Canvas['toObject']>
  const all = (oldCanvas.objects ?? []) as Array<{ data?: Partial<LayerMeta> }>
  const modelCanvas = {
    ...oldCanvas,
    objects: all.filter(o => o.data?.scope === 'model') as ReturnType<Canvas['toObject']>['objects'],
  }
  const deckObjects = all.filter(o => o.data?.scope !== 'model') as unknown[]
  const firstCard: CardState = {
    id: generateDeckId(),
    name: 'Carta 1',
    deckObjects,
    modelOverrides: {},
    thumbnail: '',
  }
  return {
    id: (raw['id'] as string | undefined) ?? generateDeckId(),
    name: (raw['name'] as string | undefined) ?? DEFAULT_DECK_NAME,
    modelCanvas,
    cards: [firstCard],
    activeCardId: firstCard.id,
  }
}

function deckFileSnapshot(): { version: 1; deck: DeckDocument } {
  persistActiveDeckDocument()
  const deck = currentDeck()

  return {
    version: 1,
    deck: {
      id: deck.id,
      name: deck.name,
      modelCanvas: cloneCanvasState(deck.modelCanvas),
      cards: deck.cards.map(c => ({
        id: c.id,
        name: c.name,
        deckObjects: JSON.parse(JSON.stringify(c.deckObjects)) as unknown[],
        modelOverrides: JSON.parse(JSON.stringify(c.modelOverrides)) as Record<string, CardModelOverride>,
        thumbnail: c.thumbnail,
      })),
      activeCardId: deck.activeCardId,
    },
  }
}

app.innerHTML = `
<main class="editor-layout">
  <section class="panel tools-panel">
    <div class="menu-shell">
      <div class="menu-top">
        <h1 class="menu-brand">Vivid Cards</h1>
        <p class="menu-caption">Ferramentas</p>
      </div>

      <nav class="menu-list" aria-label="Ferramentas do projeto">
        <button id="importDeckButton" class="menu-item" type="button">
          <span class="material-symbols-outlined" aria-hidden="true">folder_open</span>
          <span>Abrir .deck</span>
        </button>
        <button id="exportDeckButton" class="menu-item" type="button">
          <span class="material-symbols-outlined" aria-hidden="true">save</span>
          <span>Salvar .deck</span>
        </button>
      </nav>

      <div class="menu-footer">
        <button id="openPrintModalButton" class="menu-item menu-item-strong" type="button">
          <span class="material-symbols-outlined" aria-hidden="true">print</span>
          <span>Gerar baralho</span>
        </button>
        <button id="exportPngButton" class="menu-cta" type="button">
          <span class="material-symbols-outlined" aria-hidden="true">print</span>
          <span>Exportar Carta</span>
        </button>
      </div>
      <input id="importDeckInput" type="file" accept=".deck,application/octet-stream,application/gzip,application/json" hidden />
    </div>
  </section>

  <section class="panel canvas-panel">
    <div class="zoom-controls">
      <button id="zoomOutButton" class="ghost tiny" type="button" aria-label="Diminuir zoom">-</button>
      <input id="zoomRange" type="range" min="20" max="400" step="5" value="100" />
      <span id="zoomLabel" class="zoom-label">100%</span>
      <button id="zoomInButton" class="ghost tiny" type="button" aria-label="Aumentar zoom">+</button>
      <button id="zoomFitButton" class="ghost tiny" type="button">Ajustar carta</button>
    </div>
    <div id="canvasStage" class="canvas-stage" aria-label="Editor visual da carta">
      <canvas id="cardCanvas" width="${CARD_WIDTH}" height="${CARD_HEIGHT}"></canvas>
    </div>
  </section>

  <div class="right-panel-host">
    <div class="right-panel-tab-bar">
      <button id="editDeckButton" class="tab-button is-active" type="button">Baralho</button>
      <button id="editModelButton" class="tab-button" type="button">Modelo</button>
    </div>
    <section id="cardsSection" class="panel cards-panel">
      <h2>Miniaturas</h2>
      <p class="subtitle compact" id="cardCountLabel"></p>
      <div id="cardThumbnails" class="card-thumbnails"></div>
      <button id="addCardButton" class="primary" type="button">+ Adicionar carta</button>
    </section>
    <section id="layersSection" class="panel layers-panel" hidden>
      <h2>Layers</h2>
      <p class="subtitle compact">Reordene tambem arrastando os blocos.</p>
      <div id="layersAccordion" class="layers-accordion"></div>
      <div class="control-block">
        <h2>Elementos</h2>
        <div class="row two">
          <button id="addGraphicButton" class="primary" type="button">Adicionar referência</button>
          <button id="addTextButton" class="ghost" type="button">Adicionar texto</button>
        </div>
        <label>
          Trocar ilustração
          <input id="imageInput" type="file" accept="image/*" />
        </label>
        <label>
          Imagem da carta base
          <input id="baseImageInput" type="file" accept="image/*" />
        </label>
        <p class="hint">Dica: tambem pode soltar imagens direto na area da carta.</p>
      </div>
    </section>
  </div>
</main>

<div id="printModal" class="print-modal" hidden>
  <div id="printModalBackdrop" class="print-modal-backdrop"></div>
  <section class="print-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="printModalTitle">
    <header class="print-modal-header">
      <h2 id="printModalTitle">Gerar Baralho</h2>
      <button id="closePrintModalButton" class="ghost tiny" type="button" aria-label="Fechar modal">Fechar</button>
    </header>

    <div class="print-modal-body">
      <label>
        Formato da carta
        <select id="printCardSizeSelect">
          <option value="tcg">63 x 88 mm (TCG)</option>
          <option value="yugioh">59 x 86 mm (Yu-Gi-Oh)</option>
          <option value="poker">63 x 89 mm (Poker)</option>
          <option value="uno">56 x 87 mm (UNO)</option>
          <option value="uno-itu">100 x 150 mm (UNO ITU)</option>
          <option value="euro-standard">59 x 92 mm (Euro Standard)</option>
          <option value="euro-mini">44 x 68 mm (Euro Mini)</option>
          <option value="taro">70 x 120 mm (Taro)</option>
          <option value="custom">Custom</option>
        </select>
      </label>

      <div id="printCustomSizeRow" class="row two" hidden>
        <label>
          Largura (mm)
          <input id="printCardWidthInput" type="number" min="10" max="300" step="1" value="63" />
        </label>
        <label>
          Altura (mm)
          <input id="printCardHeightInput" type="number" min="10" max="300" step="1" value="88" />
        </label>
      </div>

      <label>
        Formato da folha
        <select id="printPaperSizeSelect">
          <option value="a4">A4 (210 x 297 mm)</option>
          <option value="a3">A3 (297 x 420 mm)</option>
          <option value="a5">A5 (148 x 210 mm)</option>
          <option value="letter">Carta (216 x 279 mm)</option>
          <option value="oficio">Oficio (216 x 330 mm)</option>
        </select>
      </label>

      <label>
        Orientacao da folha
        <select id="printOrientationSelect">
          <option value="portrait">Retrato</option>
          <option value="landscape">Paisagem</option>
        </select>
      </label>

      <label>
        Gap entre cartas (mm)
        <input id="printGapInput" type="number" min="0" max="30" step="1" value="3" />
      </label>

      <p id="printLayoutSummary" class="hint"></p>

      <div class="print-preview-wrap">
        <div id="printPreviewSheet" class="print-preview-sheet">
          <div id="printPreviewGrid" class="print-preview-grid"></div>
        </div>
      </div>

      <div class="print-modal-actions">
        <button id="generateDeckPrintPdfButton" class="primary" type="button">Baixar Baralho em PDF</button>
        <button id="generateDeckPrintZipButton" class="ghost" type="button">Baixar Baralho em ZIP</button>
      </div>
    </div>
  </section>
</div>
`

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector)
  if (!found) {
    throw new Error(`Elemento obrigatorio ausente: ${selector}`)
  }
  return found
}

const addTextButton = requireElement<HTMLButtonElement>(app, '#addTextButton')
const addGraphicButton = requireElement<HTMLButtonElement>(app, '#addGraphicButton')
const imageInput = requireElement<HTMLInputElement>(app, '#imageInput')
const baseImageInput = requireElement<HTMLInputElement>(app, '#baseImageInput')
const exportDeckButton = requireElement<HTMLButtonElement>(app, '#exportDeckButton')
const importDeckButton = requireElement<HTMLButtonElement>(app, '#importDeckButton')
const importDeckInput = requireElement<HTMLInputElement>(app, '#importDeckInput')
const editModelButton = requireElement<HTMLButtonElement>(app, '#editModelButton')
const editDeckButton = requireElement<HTMLButtonElement>(app, '#editDeckButton')
const openPrintModalButton = requireElement<HTMLButtonElement>(app, '#openPrintModalButton')
const printModal = requireElement<HTMLDivElement>(app, '#printModal')
const printModalBackdrop = requireElement<HTMLDivElement>(app, '#printModalBackdrop')
const closePrintModalButton = requireElement<HTMLButtonElement>(app, '#closePrintModalButton')
const printCardSizeSelect = requireElement<HTMLSelectElement>(app, '#printCardSizeSelect')
const printCustomSizeRow = requireElement<HTMLDivElement>(app, '#printCustomSizeRow')
const printCardWidthInput = requireElement<HTMLInputElement>(app, '#printCardWidthInput')
const printCardHeightInput = requireElement<HTMLInputElement>(app, '#printCardHeightInput')
const printPaperSizeSelect = requireElement<HTMLSelectElement>(app, '#printPaperSizeSelect')
const printOrientationSelect = requireElement<HTMLSelectElement>(app, '#printOrientationSelect')
const printGapInput = requireElement<HTMLInputElement>(app, '#printGapInput')
const printLayoutSummary = requireElement<HTMLParagraphElement>(app, '#printLayoutSummary')
const printPreviewSheet = requireElement<HTMLDivElement>(app, '#printPreviewSheet')
const printPreviewGrid = requireElement<HTMLDivElement>(app, '#printPreviewGrid')
const generateDeckPrintZipButton = requireElement<HTMLButtonElement>(app, '#generateDeckPrintZipButton')
const generateDeckPrintPdfButton = requireElement<HTMLButtonElement>(app, '#generateDeckPrintPdfButton')
const exportPngButton = requireElement<HTMLButtonElement>(app, '#exportPngButton')
const canvasStage = requireElement<HTMLDivElement>(app, '#canvasStage')
const layersSection = requireElement<HTMLElement>(app, '#layersSection')
const cardsSection = requireElement<HTMLElement>(app, '#cardsSection')
const cardThumbnails = requireElement<HTMLDivElement>(app, '#cardThumbnails')
const cardCountLabel = requireElement<HTMLParagraphElement>(app, '#cardCountLabel')
const addCardButton = requireElement<HTMLButtonElement>(app, '#addCardButton')
const layersAccordion = requireElement<HTMLDivElement>(app, '#layersAccordion')
const zoomOutButton = requireElement<HTMLButtonElement>(app, '#zoomOutButton')
const zoomInButton = requireElement<HTMLButtonElement>(app, '#zoomInButton')
const zoomFitButton = requireElement<HTMLButtonElement>(app, '#zoomFitButton')
const zoomRange = requireElement<HTMLInputElement>(app, '#zoomRange')
const zoomLabel = requireElement<HTMLSpanElement>(app, '#zoomLabel')

const canvas = new Canvas('cardCanvas', {
  preserveObjectStacking: true,
  selection: true,
})
const thumbnailCanvasElement = document.createElement('canvas')
thumbnailCanvasElement.width = CARD_WIDTH
thumbnailCanvasElement.height = CARD_HEIGHT
const thumbnailCanvas = new Canvas(thumbnailCanvasElement, {
  preserveObjectStacking: true,
  selection: false,
  renderOnAddRemove: false,
})

const layerById = new Map<string, FabricObject>()
let baseLayerId = ''
let layerCount = 0
let suppressSelectionSync = false
let draggedLayerId: string | null = null
let canvasDisplayZoom = 1

deckDocuments = [createDeckDocument(DEFAULT_DECK_NAME)]
activeDeckId = deckDocuments[0].id

function renderWorkspaceTabs(): void {
  const modelActive = activeEditMode === 'model'
  editModelButton.classList.toggle('is-active', modelActive)
  editDeckButton.classList.toggle('is-active', !modelActive)

  layersSection.hidden = !modelActive
  cardsSection.hidden = modelActive
  layersSection.classList.toggle('tab-panel-hidden', !modelActive)
  cardsSection.classList.toggle('tab-panel-hidden', modelActive)

  if (!modelActive) renderCardThumbnails()
}

function renderCardThumbnails(): void {
  const deck = currentDeck()
  const previousScrollTop = cardThumbnails.scrollTop
  cardThumbnails.innerHTML = ''
  cardCountLabel.textContent = `${deck.cards.length} carta${deck.cards.length === 1 ? '' : 's'}`

  deck.cards.forEach((card, index) => {
    const item = document.createElement('article')
    item.className = 'card-thumb'

    const selectBtn = document.createElement('button')
    selectBtn.type = 'button'
    selectBtn.className = `card-thumb-select ${card.id === deck.activeCardId ? 'is-active' : ''}`
    selectBtn.addEventListener('mousedown', (event) => {
      // Prevent browser from scrolling overflow containers to keep focused button in view.
      event.preventDefault()
    })

    if (card.thumbnail) {
      const img = document.createElement('img')
      img.src = card.thumbnail
      img.alt = card.name
      img.className = 'card-thumb-img'
      selectBtn.append(img)
    } else {
      const ph = document.createElement('div')
      ph.className = 'card-thumb-placeholder'
      ph.textContent = String(index + 1)
      selectBtn.append(ph)
    }

    const lbl = document.createElement('span')
    lbl.className = 'card-thumb-label'
    lbl.textContent = card.name
    selectBtn.append(lbl)

    selectBtn.addEventListener('click', () => { selectCard(card.id) })

    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'tiny danger card-thumb-delete'
    deleteBtn.textContent = 'Excluir'
    deleteBtn.disabled = deck.cards.length <= 1
    deleteBtn.addEventListener('click', () => {
      deleteCard(card.id)
    })

    item.append(selectBtn, deleteBtn)
    cardThumbnails.append(item)
  })

  cardThumbnails.scrollTop = previousScrollTop
}

function deleteCard(cardId: string): void {
  const deck = currentDeck()
  if (deck.cards.length <= 1) {
    window.alert('O baralho precisa ter ao menos 1 carta.')
    return
  }

  persistActiveDeckDocument()
  const index = deck.cards.findIndex((card) => card.id === cardId)
  if (index < 0) {
    return
  }

  const deletingActive = deck.activeCardId === cardId
  deck.cards.splice(index, 1)

  if (deletingActive) {
    const nextCard = deck.cards[Math.min(index, deck.cards.length - 1)]
    deck.activeCardId = nextCard.id
    void loadActiveDeckCard(deck, nextCard.id)
  }

  renderCardThumbnails()
}

function renderWorkspaceSidebar(): void {
  renderWorkspaceTabs()
}

async function loadDeckCanvas(state: ReturnType<Canvas['toObject']>): Promise<void> {
  canvas.clear()
  layerById.clear()
  baseLayerId = ''

  await canvas.loadFromJSON(state)

  const objects = canvas.getObjects()
  objects.forEach((object) => {
    const meta = getLayerMeta(object)
    if (meta.kind === 'base') {
      baseLayerId = meta.id
    }

    const currentScope = normalizeScope((object.get('data') as Partial<LayerMeta> | undefined)?.scope, meta.kind)
    markObjectScope(object, currentScope)
    applyRuntimeConfig(object)
  })

  if (activeEditMode === 'deck') {
    canvas.getObjects().forEach((object) => {
      const meta = getLayerMeta(object)
      if (meta.kind !== 'image' || meta.scope !== 'model' || !(object instanceof FabricImage)) {
        return
      }

      // use saved slot dimensions – never recalculate from natural image size
      const fit = normalizeImageFit(meta.fit ?? 'contain')
      const targetWidth = Math.max(1, meta.slotWidth ?? object.getScaledWidth?.() ?? object.width ?? 1)
      const targetHeight = Math.max(1, meta.slotHeight ?? object.getScaledHeight?.() ?? object.height ?? 1)

      applyImageFit(object, fit, targetWidth, targetHeight)
      setLayerMeta(object, { ...meta, fit, slotWidth: targetWidth, slotHeight: targetHeight })
      object.setCoords()
    })
  }

  refreshLayerIndex()
  renderLayersAccordion()
  canvas.discardActiveObject()
  canvas.requestRenderAll()
  persistActiveDeckDocument()
}

function toHexColor(value: string, fallback: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback
}

function generateLayerId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  layerCount += 1
  return `layer-${Date.now()}-${layerCount}`
}

function setLayerMeta(object: FabricObject, meta: LayerMeta): void {
  object.set('data', meta)
}

function getLayerMeta(object: FabricObject): LayerMeta {
  const raw = object.get('data') as Partial<LayerMeta> | undefined
  const id = raw?.id ?? generateLayerId()
  const kind = raw?.kind ?? 'image'
  const name = raw?.name ?? `Layer ${id.slice(0, 4)}`
  const scope = normalizeScope(raw?.scope, kind)
  const meta: LayerMeta = {
    id,
    kind,
    name,
    scope,
    fit: kind === 'image' ? normalizeImageFit(raw?.fit ?? 'contain') : undefined,
    slotWidth: raw?.slotWidth,
    slotHeight: raw?.slotHeight,
  }
  setLayerMeta(object, meta)
  return meta
}

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value))
}

function slugifyFilename(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()

  const slug = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'carta'
}

function buildExportFilename(): string {
  const textCandidates = canvas
    .getObjects()
    .filter((object): object is FabricText | Textbox => isTextLayer(object))
    .map((object) => {
      const text = String((object as FabricText | Textbox).text ?? '').trim()
      const numberMatch = text.match(/^(\d+)/)
      return {
        text,
        number: numberMatch ? Number(numberMatch[1]) : Number.POSITIVE_INFINITY,
      }
    })
    .filter(({ text }) => text.length > 0)

  if (textCandidates.length === 0) {
    const hashSource =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`

    const shortHash = hashSource.replace(/[^a-z0-9]/gi, '').slice(0, 5).toLowerCase()
    return shortHash || 'carta'
  }

  textCandidates.sort((a, b) => a.number - b.number || a.text.localeCompare(b.text))
  return slugifyFilename(textCandidates[0].text)
}

function currentZoom(): number {
  return canvasDisplayZoom
}

function setCanvasZoom(zoom: number): void {
  const clamped = clamp(ZOOM_MIN, ZOOM_MAX, zoom)
  const displayWidth = CARD_WIDTH * clamped
  const displayHeight = CARD_HEIGHT * clamped

  canvasDisplayZoom = clamped
  canvas.setViewportTransform([1, 0, 0, 1, 0, 0])
  canvas.lowerCanvasEl.style.width = `${displayWidth}px`
  canvas.lowerCanvasEl.style.height = `${displayHeight}px`
  canvas.upperCanvasEl.style.width = `${displayWidth}px`
  canvas.upperCanvasEl.style.height = `${displayHeight}px`
  if (canvas.wrapperEl) {
    canvas.wrapperEl.style.width = `${displayWidth}px`
    canvas.wrapperEl.style.height = `${displayHeight}px`
  }
  zoomRange.value = String(Math.round(clamped * 100))
  zoomLabel.textContent = `${Math.round(clamped * 100)}%`
  canvas.requestRenderAll()
}

function fitCanvasZoomToStage(): void {
  const availableWidth = Math.max(1, canvasStage.clientWidth - 20)
  const availableHeight = Math.max(1, canvasStage.clientHeight - 20)
  const fit = Math.min(availableWidth / CARD_WIDTH, availableHeight / CARD_HEIGHT)
  setCanvasZoom(clamp(ZOOM_MIN, ZOOM_MAX, fit))
}

function attachNoDragPropagation(control: HTMLElement): void {
  control.addEventListener('pointerdown', (event) => {
    event.stopPropagation()
  })
  control.addEventListener('mousedown', (event) => {
    event.stopPropagation()
  })
  control.addEventListener('touchstart', (event) => {
    event.stopPropagation()
  })
  control.addEventListener('dragstart', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
}

function isTextLayer(object: FabricObject): object is FabricText | Textbox {
  return object instanceof FabricText || object instanceof Textbox
}

function layerKindLabel(kind: LayerKind): string {
  return kind
}

function applyRuntimeConfig(object: FabricObject): void {
  const meta = getLayerMeta(object)
  const canEditCardModelContent =
    activeEditMode === 'deck' && meta.scope === 'model' && (meta.kind === 'text' || meta.kind === 'image')

  object.set({
    cornerStyle: 'circle',
    borderColor: '#cc4f1d',
    cornerColor: '#cc4f1d',
    transparentCorners: false,
    padding: 4,
  })

  const editable = meta.kind !== 'base' && (meta.scope === activeEditMode || canEditCardModelContent)

  object.set({
    selectable: editable,
    evented: editable,
    lockMovementX: !editable,
    lockMovementY: !editable,
    lockRotation: !editable,
    lockScalingX: !editable,
    lockScalingY: !editable,
    hasControls: editable,
    editable: meta.kind === 'text' && editable,
  })
}

function refreshLayerIndex(): void {
  layerById.clear()
  canvas.getObjects().forEach((object) => {
    const meta = getLayerMeta(object)
    layerById.set(meta.id, object)
  })
}

function selectedLayerId(): string | null {
  const active = canvas.getActiveObject()
  if (!active) {
    return null
  }
  return getLayerMeta(active).id
}

function selectLayer(layerId: string): void {
  const object = layerById.get(layerId)
  if (!object) {
    return
  }

  const meta = getLayerMeta(object)
  if (meta.kind !== 'base' && meta.scope !== activeEditMode) {
    return
  }

  suppressSelectionSync = true
  canvas.setActiveObject(object)
  suppressSelectionSync = false
  canvas.requestRenderAll()
  renderLayersAccordion()
}

function removeLayer(layerId: string): void {
  if (layerId === baseLayerId) {
    return
  }
  const object = layerById.get(layerId)
  if (!object) {
    return
  }

  if (getLayerMeta(object).scope !== activeEditMode) {
    return
  }

  canvas.remove(object)
  refreshLayerIndex()
  renderLayersAccordion()
  canvas.requestRenderAll()
}

function moveLayer(layerId: string, direction: 'up' | 'down'): void {
  const object = layerById.get(layerId)
  if (!object) {
    return
  }

  const meta = getLayerMeta(object)
  if (meta.kind === 'base' || meta.scope !== activeEditMode) {
    return
  }

  const objects = canvas.getObjects()
  const currentIndex = objects.indexOf(object)
  if (currentIndex < 0) {
    return
  }

  const target = direction === 'up' ? currentIndex + 1 : currentIndex - 1
  const nextIndex = clamp(0, objects.length - 1, target)

  if (nextIndex === currentIndex) {
    return
  }

  canvas.moveObjectTo(object, nextIndex)
  refreshLayerIndex()
  renderLayersAccordion()
  canvas.requestRenderAll()
}

function reorderLayersByAccordion(sourceLayerId: string, targetLayerId: string): void {
  if (sourceLayerId === targetLayerId) {
    return
  }

  const objects = canvas.getObjects()
  const ordered = [...objects].reverse()
  const fromIndex = ordered.findIndex((item) => getLayerMeta(item).id === sourceLayerId)
  const toIndex = ordered.findIndex((item) => getLayerMeta(item).id === targetLayerId)

  if (fromIndex < 0 || toIndex < 0) {
    return
  }

  const sourceMeta = getLayerMeta(ordered[fromIndex])
  const targetMeta = getLayerMeta(ordered[toIndex])
  if (sourceMeta.kind === 'base' || sourceMeta.scope !== activeEditMode || targetMeta.scope !== activeEditMode) {
    return
  }

  const [moved] = ordered.splice(fromIndex, 1)
  ordered.splice(toIndex, 0, moved)

  const total = ordered.length
  ordered.forEach((item, displayIndex) => {
    const canvasIndex = total - 1 - displayIndex
    canvas.moveObjectTo(item, canvasIndex)
  })

  refreshLayerIndex()
  renderLayersAccordion()
  canvas.requestRenderAll()
}

function detailsRow(labelText: string, control: HTMLElement): HTMLDivElement {
  const row = document.createElement('div')
  row.className = 'layer-detail-row'

  const label = document.createElement('label')
  label.textContent = labelText
  label.append(control)
  row.append(label)

  return row
}

function createFontSelect(currentFont: string): HTMLSelectElement {
  const select = document.createElement('select')

  FONT_OPTIONS.forEach((fontName) => {
    const option = document.createElement('option')
    option.value = fontName
    option.textContent = fontName
    if (fontName === currentFont) {
      option.selected = true
    }
    select.append(option)
  })

  return select
}

function getBaseLayerObject(): FabricImage | null {
  const object = layerById.get(baseLayerId)
  if (!object || !(object instanceof FabricImage)) {
    return null
  }
  return object
}

function isEditingField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  const tagName = target.tagName.toLowerCase()
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
    return true
  }

  return target.isContentEditable
}

function removeSelectedLayer(): void {
  const activeObject = canvas.getActiveObject()
  if (!activeObject) {
    return
  }

  const meta = getLayerMeta(activeObject)
  if (meta.id === baseLayerId) {
    return
  }

  if (meta.scope !== activeEditMode) {
    return
  }

  if (isTextLayer(activeObject) && (activeObject as unknown as { isEditing?: boolean }).isEditing) {
    return
  }

  canvas.discardActiveObject()
  removeLayer(meta.id)
}

function nudgeSelectedLayer(key: string): boolean {
  const activeObject = canvas.getActiveObject()
  if (!activeObject) {
    return false
  }

  const meta = getLayerMeta(activeObject)
  if (meta.id === baseLayerId || meta.scope !== activeEditMode) {
    return false
  }

  const canMoveByArrow = activeObject instanceof FabricImage || isTextLayer(activeObject)
  if (!canMoveByArrow) {
    return false
  }

  if (isTextLayer(activeObject) && (activeObject as unknown as { isEditing?: boolean }).isEditing) {
    return false
  }

  const currentLeft = activeObject.left ?? 0
  const currentTop = activeObject.top ?? 0

  if (key === 'ArrowLeft') {
    activeObject.set({ left: currentLeft - 1 })
  } else if (key === 'ArrowRight') {
    activeObject.set({ left: currentLeft + 1 })
  } else if (key === 'ArrowUp') {
    activeObject.set({ top: currentTop - 1 })
  } else if (key === 'ArrowDown') {
    activeObject.set({ top: currentTop + 1 })
  } else {
    return false
  }

  activeObject.setCoords()
  canvas.requestRenderAll()
  renderLayersAccordion()
  return true
}

function renderLayersAccordion(): void {
  refreshLayerIndex()
  layersAccordion.innerHTML = ''

  const objects = canvas.getObjects()
  const activeId = selectedLayerId()
  const ordered = [...objects].reverse()

  ordered.forEach((object, reverseIndex) => {
    const meta = getLayerMeta(object)
    const zFromTop = reverseIndex
    const editable = meta.kind !== 'base' && meta.scope === activeEditMode
    const scopeLabel = meta.scope === 'model' ? 'Modelo' : 'Baralho'

    const details = document.createElement('details')
    details.className = `layer-item ${meta.id === activeId ? 'is-active' : ''}`
    details.open = meta.id === activeId
    details.dataset.layerId = meta.id

    details.addEventListener('dragover', (event) => {
      event.preventDefault()
      if (draggedLayerId && draggedLayerId !== meta.id) {
        details.classList.add('drag-over')
      }
    })

    details.addEventListener('dragleave', () => {
      details.classList.remove('drag-over')
    })

    details.addEventListener('drop', (event) => {
      event.preventDefault()
      details.classList.remove('drag-over')
      const source = draggedLayerId ?? event.dataTransfer?.getData('text/plain')
      if (!source) {
        return
      }
      reorderLayersByAccordion(source, meta.id)
    })

    const summary = document.createElement('summary')
    summary.className = 'layer-summary'
    summary.draggable = editable
    summary.innerHTML = `
      <span class="layer-name">${meta.name}</span>
      <span class="layer-kind">${scopeLabel} • ${layerKindLabel(meta.kind)}</span>
      <span class="layer-z">z:${zFromTop}</span>
    `

    summary.addEventListener('dragstart', (event) => {
      if (!editable) {
        event.preventDefault()
        return
      }
      draggedLayerId = meta.id
      event.dataTransfer?.setData('text/plain', meta.id)
      event.dataTransfer?.setDragImage(details, 24, 20)
      details.classList.add('is-dragging')
    })

    summary.addEventListener('dragend', () => {
      draggedLayerId = null
      details.classList.remove('is-dragging')
      layersAccordion
        .querySelectorAll<HTMLElement>('.layer-item.drag-over')
        .forEach((node) => node.classList.remove('drag-over'))
    })

    summary.addEventListener('click', () => {
      selectLayer(meta.id)
    })

    const actions = document.createElement('div')
    actions.className = 'layer-actions'

    const selectBtn = document.createElement('button')
    selectBtn.type = 'button'
    selectBtn.className = 'tiny ghost'
    selectBtn.textContent = 'Selecionar'
    selectBtn.disabled = !editable && meta.kind !== 'base'
    selectBtn.addEventListener('click', (event) => {
      event.preventDefault()
      selectLayer(meta.id)
    })

    const upBtn = document.createElement('button')
    upBtn.type = 'button'
    upBtn.className = 'tiny ghost'
    upBtn.textContent = 'Subir'
    upBtn.disabled = zFromTop === 0 || !editable
    upBtn.addEventListener('click', (event) => {
      event.preventDefault()
      moveLayer(meta.id, 'up')
    })

    const downBtn = document.createElement('button')
    downBtn.type = 'button'
    downBtn.className = 'tiny ghost'
    downBtn.textContent = 'Descer'
    downBtn.disabled = zFromTop === objects.length - 1 || !editable
    downBtn.addEventListener('click', (event) => {
      event.preventDefault()
      moveLayer(meta.id, 'down')
    })

    actions.append(selectBtn, upBtn, downBtn)

    if (meta.id !== baseLayerId) {
      const removeBtn = document.createElement('button')
      removeBtn.type = 'button'
      removeBtn.className = 'tiny danger'
      removeBtn.textContent = 'Remover'
      removeBtn.disabled = !editable
      removeBtn.addEventListener('click', (event) => {
        event.preventDefault()
        removeLayer(meta.id)
      })
      actions.append(removeBtn)
    }

    const body = document.createElement('div')
    body.className = 'layer-body'

    if (meta.id === baseLayerId) {
      const lockNote = document.createElement('p')
      lockNote.className = 'layer-note'
      lockNote.textContent =
        'Layer base bloqueada: use apenas Subir/Descer ou arraste no acordeao para mudar a ordem.'
      body.append(lockNote)
      details.append(summary, actions, body)
      layersAccordion.append(details)
      return
    }

    if (!editable) {
      const canEditCardContent =
        activeEditMode === 'deck' &&
        meta.scope === 'model' &&
        (meta.kind === 'text' || meta.kind === 'image')

      if (canEditCardContent) {
        const note = document.createElement('p')
        note.className = 'layer-note'
        note.textContent =
          'Conteudo individual desta carta: altere texto/ilustracao sem mover ou redimensionar o layer do modelo. Dê duplo clique na imagem para trocar.'
        body.append(note)

        if (meta.kind === 'text' && isTextLayer(object)) {
          const textObject = object as FabricText | Textbox
          const textField = document.createElement('textarea')
          textField.rows = 3
          textField.value = String((textObject as any).text ?? '')
          attachNoDragPropagation(textField)
          textField.addEventListener('input', () => {
            textObject.set({ text: textField.value })
            textObject.setCoords()
            canvas.requestRenderAll()
            persistActiveDeckDocument()
            renderCardThumbnails()
          })
          body.append(detailsRow('Texto da carta', textField))
        }

        if (meta.kind === 'image' && object instanceof FabricImage) {
          body.append(createImageBehaviorControls(object))
        }

        details.append(summary, actions, body)
        layersAccordion.append(details)
        return
      }

      const lockNote = document.createElement('p')
      lockNote.className = 'layer-note'
      lockNote.textContent =
        meta.scope === 'model'
          ? 'Este layer pertence ao modelo. Troque para a aba Modelo para editar.'
          : 'Este layer pertence ao baralho. Troque para a aba Baralhos para editar.'
      body.append(lockNote)
      details.append(summary, actions, body)
      layersAccordion.append(details)
      return
    }

    const xInput = document.createElement('input')
    xInput.type = 'number'
    xInput.step = '1'
    xInput.value = String(Math.round(object.left ?? 0))
    attachNoDragPropagation(xInput)
    xInput.addEventListener('input', () => {
      object.set({ left: Number(xInput.value) || 0 })
      object.setCoords()
      canvas.requestRenderAll()
    })
    body.append(detailsRow('X', xInput))

    const yInput = document.createElement('input')
    yInput.type = 'number'
    yInput.step = '1'
    yInput.value = String(Math.round(object.top ?? 0))
    attachNoDragPropagation(yInput)
    yInput.addEventListener('input', () => {
      object.set({ top: Number(yInput.value) || 0 })
      object.setCoords()
      canvas.requestRenderAll()
    })
    body.append(detailsRow('Y', yInput))

    const opacityInput = document.createElement('input')
    opacityInput.type = 'range'
    opacityInput.min = '0'
    opacityInput.max = '1'
    opacityInput.step = '0.01'
    opacityInput.value = String(object.opacity ?? 1)
    attachNoDragPropagation(opacityInput)
    opacityInput.addEventListener('input', () => {
      object.set({ opacity: Number(opacityInput.value) || 1 })
      canvas.requestRenderAll()
    })
    body.append(detailsRow('Opacidade', opacityInput))

    const scaleInput = document.createElement('input')
    scaleInput.type = 'range'
    scaleInput.min = '0.1'
    scaleInput.max = '3'
    scaleInput.step = '0.01'
    scaleInput.value = String(object.scaleX ?? 1)
    attachNoDragPropagation(scaleInput)
    scaleInput.addEventListener('input', () => {
      const scale = Number(scaleInput.value) || 1
      object.set({ scaleX: scale, scaleY: scale })
      object.setCoords()
      canvas.requestRenderAll()
    })
    body.append(detailsRow('Escala', scaleInput))

    const angleInput = document.createElement('input')
    angleInput.type = 'range'
    angleInput.min = '-180'
    angleInput.max = '180'
    angleInput.step = '1'
    angleInput.value = String(object.angle ?? 0)
    attachNoDragPropagation(angleInput)
    angleInput.addEventListener('input', () => {
      object.set({ angle: Number(angleInput.value) || 0 })
      object.setCoords()
      canvas.requestRenderAll()
    })
    body.append(detailsRow('Rotacao', angleInput))

    if (isTextLayer(object)) {
      const textObject = object as FabricText | Textbox

      const textField = document.createElement('textarea')
      textField.rows = 3
      textField.value = (textObject as any).text ?? 'Texto'
      attachNoDragPropagation(textField)
      textField.addEventListener('input', () => {
        textObject.set({ text: textField.value })
        textObject.setCoords()
        canvas.requestRenderAll()
      })
      body.append(detailsRow('Texto (use Enter para quebra de linha)', textField))

      const fontFamilyField = createFontSelect(String((textObject as any).fontFamily ?? 'Arial'))
      attachNoDragPropagation(fontFamilyField)
      fontFamilyField.addEventListener('change', () => {
        textObject.set({ fontFamily: fontFamilyField.value })
        textObject.setCoords()
        canvas.requestRenderAll()
      })
      body.append(detailsRow('Fonte', fontFamilyField))

      const fontSizeField = document.createElement('input')
      fontSizeField.type = 'number'
      fontSizeField.min = '8'
      fontSizeField.max = '220'
      fontSizeField.value = String((textObject as any).fontSize ?? 40)
      attachNoDragPropagation(fontSizeField)
      fontSizeField.addEventListener('input', () => {
        textObject.set({ fontSize: clamp(8, 220, Number(fontSizeField.value) || 40) })
        textObject.setCoords()
        canvas.requestRenderAll()
      })
      body.append(detailsRow('Tamanho', fontSizeField))

      const fillField = document.createElement('input')
      fillField.type = 'color'
      fillField.value = toHexColor(String((textObject as any).fill ?? '#1c2738'), '#1c2738')
      attachNoDragPropagation(fillField)
      fillField.addEventListener('input', () => {
        textObject.set({ fill: fillField.value })
        canvas.requestRenderAll()
      })
      body.append(detailsRow('Cor do texto', fillField))

      const strokeColorField = document.createElement('input')
      strokeColorField.type = 'color'
      const strokeColor = toHexColor(String((textObject as any).stroke ?? '#000000'), '#000000')
      strokeColorField.value = strokeColor
      attachNoDragPropagation(strokeColorField)
      strokeColorField.addEventListener('input', () => {
        textObject.set({ stroke: strokeColorField.value })
        canvas.requestRenderAll()
      })
      body.append(detailsRow('Cor da borda', strokeColorField))

      const strokeWidthField = document.createElement('input')
      strokeWidthField.type = 'number'
      strokeWidthField.min = '0'
      strokeWidthField.max = '20'
      strokeWidthField.step = '0.2'
      strokeWidthField.value = String((textObject as any).strokeWidth ?? 0)
      attachNoDragPropagation(strokeWidthField)
      strokeWidthField.addEventListener('input', () => {
        textObject.set({ strokeWidth: clamp(0, 20, Number(strokeWidthField.value) || 0) })
        textObject.setCoords()
        canvas.requestRenderAll()
      })
      body.append(detailsRow('Espessura da borda', strokeWidthField))

      const alignField = document.createElement('select')
      attachNoDragPropagation(alignField)
      ;['left', 'center', 'right', 'justify'].forEach((align) => {
        const option = document.createElement('option')
        option.value = align
        option.textContent = align
        option.selected = (textObject as any).textAlign === align
        alignField.append(option)
      })
      alignField.addEventListener('change', () => {
        textObject.set({ textAlign: alignField.value as 'left' | 'center' | 'right' | 'justify' })
        textObject.setCoords()
        canvas.requestRenderAll()
      })
      body.append(detailsRow('Alinhamento', alignField))

      if (textObject instanceof Textbox) {
        const widthField = document.createElement('input')
        widthField.type = 'number'
        widthField.min = '40'
        widthField.max = '800'
        widthField.step = '1'
        widthField.value = String(Math.round(textObject.width ?? 260))
        attachNoDragPropagation(widthField)
        widthField.addEventListener('input', () => {
          textObject.set({ width: clamp(40, 800, Number(widthField.value) || 260) })
          textObject.setCoords()
          canvas.requestRenderAll()
        })
        body.append(detailsRow('Largura (quebra automatica)', widthField))
      }

      const lineHeightField = document.createElement('input')
      lineHeightField.type = 'number'
      lineHeightField.min = '0.6'
      lineHeightField.max = '3'
      lineHeightField.step = '0.05'
      lineHeightField.value = String((textObject as any).lineHeight ?? 1.16)
      attachNoDragPropagation(lineHeightField)
      lineHeightField.addEventListener('input', () => {
        textObject.set({ lineHeight: clamp(0.6, 3, Number(lineHeightField.value) || 1.16) })
        textObject.setCoords()
        canvas.requestRenderAll()
      })
      body.append(detailsRow('Espacamento de linha', lineHeightField))

      const rawShadow = (textObject as any).shadow as
        | { color?: string; blur?: number; offsetX?: number; offsetY?: number }
        | null
      const shadowEnabledField = document.createElement('input')
      shadowEnabledField.type = 'checkbox'
      shadowEnabledField.checked = Boolean(rawShadow)
      attachNoDragPropagation(shadowEnabledField)
      body.append(detailsRow('Sombra', shadowEnabledField))

      const shadowColorField = document.createElement('input')
      shadowColorField.type = 'color'
      shadowColorField.value = toHexColor(String(rawShadow?.color ?? '#000000'), '#000000')
      attachNoDragPropagation(shadowColorField)
      body.append(detailsRow('Cor da sombra', shadowColorField))

      const shadowBlurField = document.createElement('input')
      shadowBlurField.type = 'number'
      shadowBlurField.min = '0'
      shadowBlurField.max = '60'
      shadowBlurField.step = '1'
      shadowBlurField.value = String(rawShadow?.blur ?? 0)
      attachNoDragPropagation(shadowBlurField)
      body.append(detailsRow('Blur da sombra', shadowBlurField))

      const applyShadow = () => {
        if (!shadowEnabledField.checked) {
          textObject.set({ shadow: null })
        } else {
          textObject.set({
            shadow: {
              color: shadowColorField.value,
              blur: clamp(0, 60, Number(shadowBlurField.value) || 0),
              offsetX: 2,
              offsetY: 2,
            },
          })
        }
        textObject.setCoords()
        canvas.requestRenderAll()
      }

      shadowEnabledField.addEventListener('change', applyShadow)
      shadowColorField.addEventListener('input', applyShadow)
      shadowBlurField.addEventListener('input', applyShadow)
    }

    if (meta.kind === 'image' && object instanceof FabricImage) {
      body.append(createImageBehaviorControls(object))
    }

    details.append(summary, actions, body)
    layersAccordion.append(details)
  })

}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('Falha ao converter arquivo em base64.'))
      }
    }
    reader.onerror = () => reject(new Error('Falha ao ler arquivo.'))
    reader.readAsDataURL(file)
  })
}

async function addImageLayer(url: string, name = 'Imagem'): Promise<void> {
  const image = await FabricImage.fromURL(url)

  const maxWidth = CARD_WIDTH * 0.62
  const maxHeight = CARD_HEIGHT * 0.62
  const baseW = image.width ?? 1
  const baseH = image.height ?? 1
  const scale = Math.min(maxWidth / baseW, maxHeight / baseH, 1)

  image.set({
    left: CARD_WIDTH * 0.5,
    top: CARD_HEIGHT * 0.5,
    originX: 'center',
    originY: 'center',
    scaleX: scale,
    scaleY: scale,
  })

  setLayerMeta(image, {
    id: generateLayerId(),
    kind: 'image',
    name,
    scope: activeEditMode,
  })

  applyRuntimeConfig(image)
  canvas.add(image)
  canvas.setActiveObject(image)
  refreshLayerIndex()
  renderLayersAccordion()
  persistActiveDeckDocument()
  canvas.requestRenderAll()
}

async function addGraphicReferenceLayer(name = 'Referência gráfica'): Promise<void> {
  const svg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="360" height="480" viewBox="0 0 360 480">
      <rect x="4" y="4" width="352" height="472" rx="18" fill="#fff7e2" stroke="#b3833a" stroke-width="4" stroke-dasharray="14 10"/>
      <rect x="34" y="34" width="292" height="292" rx="16" fill="#f4e5c4" opacity="0.85"/>
      <text x="180" y="382" font-family="Arial, sans-serif" font-size="26" text-anchor="middle" fill="#7f6647">Ilustração</text>
      <text x="180" y="414" font-family="Arial, sans-serif" font-size="18" text-anchor="middle" fill="#7f6647">carregue uma imagem</text>
    </svg>
  `)
  const reference = await FabricImage.fromURL(`data:image/svg+xml;charset=utf-8,${svg}`)

  reference.set({
    left: CARD_WIDTH * 0.5,
    top: CARD_HEIGHT * 0.45,
    originX: 'center',
    originY: 'center',
    scaleX: 1,
    scaleY: 1,
  })

  setLayerMeta(reference, {
    id: generateLayerId(),
    kind: 'image',
    name,
    scope: activeEditMode,
    fit: 'fill',
    slotWidth: 360,
    slotHeight: 480,
  })

  applyRuntimeConfig(reference)
  canvas.add(reference)
  canvas.setActiveObject(reference)
  refreshLayerIndex()
  renderLayersAccordion()
  persistActiveDeckDocument()
  canvas.requestRenderAll()
}

function addTextLayer(): void {
  const text = new Textbox('Texto', {
    left: CARD_WIDTH * 0.5,
    top: CARD_HEIGHT * 0.5,
    originX: 'center',
    originY: 'center',
    width: 260,
    fontFamily: 'Cinzel Decorative',
    fontSize: 44,
    fontWeight: 'bold',
    fill: '#1c2738',
    textAlign: 'center',
    lineHeight: 1.16,
  })

  setLayerMeta(text, {
    id: generateLayerId(),
    kind: 'text',
    name: `Texto ${canvas.getObjects().length}`,
    scope: activeEditMode,
  })

  applyRuntimeConfig(text)
  canvas.add(text)
  canvas.setActiveObject(text)
  refreshLayerIndex()
  renderLayersAccordion()
  persistActiveDeckDocument()
  canvas.requestRenderAll()
}

async function ensureBaseLayer(url?: string): Promise<void> {
  if (!url) {
    return
  }

  const baseImage = await FabricImage.fromURL(url)

  const imageWidth = baseImage.width ?? CARD_WIDTH
  const imageHeight = baseImage.height ?? CARD_HEIGHT

  baseImage.set({
    left: 0,
    top: 0,
    originX: 'left',
    originY: 'top',
    scaleX: CARD_WIDTH / imageWidth,
    scaleY: CARD_HEIGHT / imageHeight,
  })

  baseLayerId = generateLayerId()
  setLayerMeta(baseImage, {
    id: baseLayerId,
    kind: 'base',
    name: 'Carta base',
    scope: 'model',
  })

  applyRuntimeConfig(baseImage)
  canvas.add(baseImage)
  canvas.bringObjectToFront(baseImage)
  refreshLayerIndex()
  renderLayersAccordion()
  persistActiveDeckDocument()
  canvas.requestRenderAll()
}

async function replaceBaseLayer(url: string): Promise<void> {
  let baseObject = getBaseLayerObject()

  if (!baseObject) {
    await ensureBaseLayer(url)
    baseObject = getBaseLayerObject()
    if (!baseObject) {
      throw new Error('Nao foi possivel preparar a layer base da carta.')
    }
  } else {
    await baseObject.setSrc(url)
  }

  const imageWidth = baseObject.width ?? CARD_WIDTH
  const imageHeight = baseObject.height ?? CARD_HEIGHT

  baseObject.set({
    left: 0,
    top: 0,
    originX: 'left',
    originY: 'top',
    scaleX: CARD_WIDTH / imageWidth,
    scaleY: CARD_HEIGHT / imageHeight,
  })

  applyRuntimeConfig(baseObject)
  baseObject.setCoords()
  refreshLayerIndex()
  renderLayersAccordion()
  persistActiveDeckDocument()
  canvas.requestRenderAll()
}

function addNewCard(): void {
  persistActiveDeckDocument()
  const deck = currentDeck()
  const newCard: CardState = {
    id: generateDeckId(),
    name: `Carta ${deck.cards.length + 1}`,
    deckObjects: [],
    modelOverrides: {},
    thumbnail: '',
  }
  deck.cards.push(newCard)
  deck.activeCardId = newCard.id
  void loadActiveDeckCard(deck, newCard.id)
  renderCardThumbnails()
}

function selectCard(cardId: string): void {
  const deck = currentDeck()
  if (cardId === deck.activeCardId) return
  persistActiveDeckDocument()
  deck.activeCardId = cardId
  void loadActiveDeckCard(deck, cardId)
  renderCardThumbnails()
}

function saveActiveDeckAsFile(): void {
  const snapshot = deckFileSnapshot()
  const filename = `${slugifyFilename(snapshot.deck.name)}.deck`
  void compressTextToBlob(JSON.stringify(snapshot)).then((blob) => {
    downloadBlob(filename, blob)
  })
}

async function importDeckFile(file: File): Promise<void> {
  const rawText = await decompressDeckText(file)
  const parsed = JSON.parse(rawText) as Record<string, unknown>

  let rawDeck: Record<string, unknown> | null = null

  if (parsed['version'] === 1 && parsed['deck']) {
    rawDeck = { ...(parsed['deck'] as Record<string, unknown>) }
    if (!rawDeck['name']) rawDeck['name'] = file.name.replace(/\.deck$/i, '') || DEFAULT_DECK_NAME
  } else if (parsed['canvas'] || parsed['modelCanvas']) {
    rawDeck = { ...parsed }
    if (!rawDeck['name']) rawDeck['name'] = file.name.replace(/\.deck$/i, '') || DEFAULT_DECK_NAME
  }

  if (!rawDeck) throw new Error('Arquivo .deck inválido.')

  const deck = migrateDeckDocument({ ...rawDeck, id: generateDeckId() })
  deckDocuments = [deck]
  activeDeckId = deck.id
  activeEditMode = 'deck'
  await loadActiveDeckCard(deck)
  await refreshDeckThumbnails(deck)
  renderWorkspaceSidebar()
}

function exportCanvasPng(): void {
  const imageData = canvas.toDataURL({
    format: 'png',
    multiplier: 2,
  })

  const anchor = document.createElement('a')
  anchor.href = imageData
  anchor.download = `${buildExportFilename()}.png`
  anchor.click()
}

function presetByKey(list: SizePreset[], key: string): SizePreset | null {
  return list.find((item) => item.key === key) ?? null
}

function mmToPx(mm: number, dpi = 300): number {
  return Math.max(1, Math.round((mm / 25.4) * dpi))
}

function canvasToBlob(canvasElement: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvasElement.toBlob((blob) => {
      if (blob) {
        resolve(blob)
      } else {
        reject(new Error('Falha ao gerar imagem para impressao.'))
      }
    }, type)
  })
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Falha ao carregar imagem da carta.'))
    image.src = src
  })
}

function currentPrintCardSize(): { widthMm: number; heightMm: number } {
  if (printCardSizeSelect.value === 'custom') {
    const widthMm = clamp(10, 300, Number(printCardWidthInput.value) || 63)
    const heightMm = clamp(10, 300, Number(printCardHeightInput.value) || 88)
    return { widthMm, heightMm }
  }

  const preset = presetByKey(CARD_SIZE_PRESETS, printCardSizeSelect.value) ?? CARD_SIZE_PRESETS[0]
  return { widthMm: preset.widthMm, heightMm: preset.heightMm }
}

function currentPrintPaperSize(): { widthMm: number; heightMm: number } {
  const preset = presetByKey(PAPER_SIZE_PRESETS, printPaperSizeSelect.value) ?? PAPER_SIZE_PRESETS[0]
  const portraitWidth = Math.min(preset.widthMm, preset.heightMm)
  const portraitHeight = Math.max(preset.widthMm, preset.heightMm)

  if (printOrientationSelect.value === 'landscape') {
    return { widthMm: portraitHeight, heightMm: portraitWidth }
  }

  return { widthMm: portraitWidth, heightMm: portraitHeight }
}

function currentPrintLayout(): {
  card: { widthMm: number; heightMm: number }
  paper: { widthMm: number; heightMm: number }
  gapMm: number
  sideMarginMm: number
  columns: number
  rows: number
  perSheet: number
} {
  const card = currentPrintCardSize()
  const paper = currentPrintPaperSize()
  const gapMm = clamp(0, 30, Number(printGapInput.value) || 0)
  const sideMarginMm = 6

  const usableWidthMm = Math.max(1, paper.widthMm - sideMarginMm * 2)
  const usableHeightMm = Math.max(1, paper.heightMm - sideMarginMm * 2)
  const columns = Math.max(1, Math.floor((usableWidthMm + gapMm) / (card.widthMm + gapMm)))
  const rows = Math.max(1, Math.floor((usableHeightMm + gapMm) / (card.heightMm + gapMm)))

  return {
    card,
    paper,
    gapMm,
    sideMarginMm,
    columns,
    rows,
    perSheet: Math.max(1, columns * rows),
  }
}

async function captureDeckCardPrintImage(deck: DeckDocument, cardId: string): Promise<string> {
  thumbnailCanvas.clear()
  await thumbnailCanvas.loadFromJSON(buildCardCanvasState(deck, cardId))
  applyDeckModelImageFit(thumbnailCanvas)
  thumbnailCanvas.setViewportTransform([1, 0, 0, 1, 0, 0])
  thumbnailCanvas.requestRenderAll()
  return thumbnailCanvas.toDataURL({ format: 'png', multiplier: 1 })
}

async function generateDeckPrintSheets(downloadFormat: 'zip' | 'pdf'): Promise<void> {
  const deck = currentDeck()
  if (deck.cards.length === 0) {
    window.alert('Nao ha cartas no baralho para gerar baralho.')
    return
  }

  const layout = currentPrintLayout()
  if (layout.perSheet <= 0) {
    window.alert('Configuracao de baralho invalida.')
    return
  }

  const previousPdfText = generateDeckPrintPdfButton.textContent
  const previousZipText = generateDeckPrintZipButton.textContent
  generateDeckPrintZipButton.disabled = true
  generateDeckPrintPdfButton.disabled = true
  if (downloadFormat === 'pdf') {
    generateDeckPrintPdfButton.textContent = 'Gerando PDF...'
  } else {
    generateDeckPrintZipButton.textContent = 'Gerando ZIP...'
  }

  try {
    const cardImages = await Promise.all(
      deck.cards.map(async (card) => captureDeckCardPrintImage(deck, card.id)),
    )
    const imageElements = await Promise.all(cardImages.map(async (src) => loadImageElement(src)))

    const totalPages = Math.ceil(deck.cards.length / layout.perSheet)
    const paperWidthPx = mmToPx(layout.paper.widthMm)
    const paperHeightPx = mmToPx(layout.paper.heightMm)
    const cardWidthPx = mmToPx(layout.card.widthMm)
    const cardHeightPx = mmToPx(layout.card.heightMm)
    const gapPx = mmToPx(layout.gapMm)
    const marginPx = mmToPx(layout.sideMarginMm)
    const baseName = slugifyFilename(deck.name)
    const zip = downloadFormat === 'zip' ? new JSZip() : null
    const pdf = downloadFormat === 'pdf'
      ? new jsPDF({
        orientation: layout.paper.widthMm > layout.paper.heightMm ? 'landscape' : 'portrait',
        unit: 'mm',
        format: [layout.paper.widthMm, layout.paper.heightMm],
        compress: true,
      })
      : null

    for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
      const sheetCanvas = document.createElement('canvas')
      sheetCanvas.width = paperWidthPx
      sheetCanvas.height = paperHeightPx
      const context = sheetCanvas.getContext('2d')
      if (!context) {
        throw new Error('Falha ao preparar canvas de impressao.')
      }

      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, paperWidthPx, paperHeightPx)

      for (let slot = 0; slot < layout.perSheet; slot += 1) {
        const cardIndex = pageIndex * layout.perSheet + slot
        if (cardIndex >= cardImages.length) {
          break
        }

        const row = Math.floor(slot / layout.columns)
        const col = slot % layout.columns
        const x = marginPx + col * (cardWidthPx + gapPx)
        const y = marginPx + row * (cardHeightPx + gapPx)
        const image = imageElements[cardIndex]
        context.drawImage(image, x, y, cardWidthPx, cardHeightPx)
      }

      if (downloadFormat === 'zip' && zip) {
        const blob = await canvasToBlob(sheetCanvas)
        const fileName = totalPages === 1
          ? `${baseName}-impressao.png`
          : `${baseName}-impressao-${String(pageIndex + 1).padStart(2, '0')}.png`
        zip.file(fileName, blob)
      }

      if (downloadFormat === 'pdf' && pdf) {
        if (pageIndex > 0) {
          pdf.addPage()
        }
        const imageData = sheetCanvas.toDataURL('image/png')
        pdf.addImage(
          imageData,
          'PNG',
          0,
          0,
          layout.paper.widthMm,
          layout.paper.heightMm,
          undefined,
          'FAST',
        )
      }
    }

    if (downloadFormat === 'zip' && zip) {
      const zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      })
      downloadBlob(`${baseName}-impressao.zip`, zipBlob)
    }

    if (downloadFormat === 'pdf' && pdf) {
      const pdfBlob = pdf.output('blob')
      downloadBlob(`${baseName}-impressao.pdf`, pdfBlob)
    }

    closePrintModal()
  } catch (error) {
    window.alert(error instanceof Error ? error.message : 'Falha ao gerar folhas de impressao.')
  } finally {
    generateDeckPrintZipButton.disabled = false
    generateDeckPrintPdfButton.disabled = false
    generateDeckPrintPdfButton.textContent = previousPdfText
    generateDeckPrintZipButton.textContent = previousZipText
  }
}

function updatePrintPreview(): void {
  const layout = currentPrintLayout()
  const total = Math.max(1, layout.columns * layout.rows)
  const previewCount = Math.min(PREVIEW_MAX_CARDS, total)

  const mmScale = Math.min(220 / layout.paper.widthMm, 300 / layout.paper.heightMm)
  const sheetWidthPx = Math.max(120, Math.round(layout.paper.widthMm * mmScale))
  const sheetHeightPx = Math.max(160, Math.round(layout.paper.heightMm * mmScale))
  const gapPx = Math.max(0, Math.round(layout.gapMm * mmScale))
  const cardWidthPx = Math.max(6, Math.floor(layout.card.widthMm * mmScale))
  const cardHeightPx = Math.max(6, Math.floor(layout.card.heightMm * mmScale))

  printPreviewSheet.style.width = `${sheetWidthPx}px`
  printPreviewSheet.style.height = `${sheetHeightPx}px`

  printPreviewGrid.style.gridTemplateColumns = `repeat(${layout.columns}, ${cardWidthPx}px)`
  printPreviewGrid.style.gridAutoRows = `${cardHeightPx}px`
  printPreviewGrid.style.gap = `${gapPx}px`
  printPreviewGrid.innerHTML = ''

  for (let i = 0; i < previewCount; i += 1) {
    const thumb = document.createElement('div')
    thumb.className = 'print-preview-card'
    thumb.style.width = `${cardWidthPx}px`
    thumb.style.height = `${cardHeightPx}px`
    const caption = document.createElement('span')
    caption.textContent = String(i + 1)
    thumb.append(caption)
    printPreviewGrid.append(thumb)
  }

  const limitedLabel = total > previewCount ? ` (mostrando ${previewCount})` : ''
  const orientationLabel = printOrientationSelect.value === 'landscape' ? 'Paisagem' : 'Retrato'
  printLayoutSummary.textContent = `${orientationLabel}: ${layout.columns} colunas x ${layout.rows} linhas = ${total} cartas por folha${limitedLabel}`
}

function openPrintModal(): void {
  printModal.hidden = false
  updatePrintPreview()
}

function closePrintModal(): void {
  printModal.hidden = true
}

function syncPrintCustomFieldsVisibility(): void {
  const customSelected = printCardSizeSelect.value === 'custom'
  printCustomSizeRow.hidden = !customSelected
  printCustomSizeRow.style.display = customSelected ? 'grid' : 'none'
}

function attachCanvasDnD(): void {
  canvasStage.addEventListener('dragover', (event) => {
    event.preventDefault()
  })

  canvasStage.addEventListener('drop', async (event) => {
    event.preventDefault()
    const files = event.dataTransfer?.files
    if (!files || files.length === 0) {
      return
    }

    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) {
        continue
      }

      try {
        const dataUrl = await fileToDataUrl(file)
        await addImageLayer(dataUrl, file.name)
      } catch {
        window.alert(`Falha ao carregar a imagem ${file.name}.`)
      }
    }
  })
}

editModelButton.addEventListener('click', () => { void switchToModelView() })
editDeckButton.addEventListener('click', () => { void switchToCardView() })
exportDeckButton.addEventListener('click', saveActiveDeckAsFile)

importDeckButton.addEventListener('click', () => {
  importDeckInput.click()
})

importDeckInput.addEventListener('change', async () => {
  const file = importDeckInput.files?.[0]
  if (!file) {
    return
  }

  try {
    await importDeckFile(file)
  } catch (error) {
    window.alert(error instanceof Error ? error.message : 'Falha ao carregar .deck.')
  } finally {
    importDeckInput.value = ''
  }
})

addCardButton.addEventListener('click', addNewCard)

addGraphicButton.addEventListener('click', () => {
  void addGraphicReferenceLayer()
})

addTextButton.addEventListener('click', () => {
  addTextLayer()
})

imageInput.addEventListener('change', async () => {
  const file = imageInput.files?.[0]
  if (!file) {
    return
  }

  try {
    const dataUrl = await fileToDataUrl(file)
    const activeObject = selectedEditableImageObject()

    if (activeObject) {
      const fit = normalizeImageFit(getLayerMeta(activeObject).fit ?? 'cover')
      await replaceIllustrationOnObject(activeObject, dataUrl, fit)
      applyRuntimeConfig(activeObject)
      persistActiveDeckDocument()
      renderLayersAccordion()
      canvas.requestRenderAll()
    } else {
      await addImageLayer(dataUrl, file.name)
    }
  } catch {
    window.alert('Falha ao carregar imagem selecionada.')
  } finally {
    imageInput.value = ''
  }
})

baseImageInput.addEventListener('change', async () => {
  const file = baseImageInput.files?.[0]
  if (!file) {
    return
  }

  try {
    const dataUrl = await fileToDataUrl(file)
    await replaceBaseLayer(dataUrl)
  } catch {
    window.alert('Falha ao substituir a imagem da carta base.')
  } finally {
    baseImageInput.value = ''
  }
})

exportPngButton.addEventListener('click', exportCanvasPng)

openPrintModalButton.addEventListener('click', () => {
  syncPrintCustomFieldsVisibility()
  openPrintModal()
})

closePrintModalButton.addEventListener('click', closePrintModal)
printModalBackdrop.addEventListener('click', closePrintModal)

printCardSizeSelect.addEventListener('change', () => {
  syncPrintCustomFieldsVisibility()
  updatePrintPreview()
})
printCardWidthInput.addEventListener('input', updatePrintPreview)
printCardHeightInput.addEventListener('input', updatePrintPreview)
printPaperSizeSelect.addEventListener('change', updatePrintPreview)
printOrientationSelect.addEventListener('change', updatePrintPreview)
printGapInput.addEventListener('input', updatePrintPreview)
generateDeckPrintZipButton.addEventListener('click', () => {
  void generateDeckPrintSheets('zip')
})

generateDeckPrintPdfButton.addEventListener('click', () => {
  void generateDeckPrintSheets('pdf')
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !printModal.hidden) {
    closePrintModal()
  }
})

canvas.upperCanvasEl.addEventListener('dblclick', () => {
  openIllustrationUpload()
})

zoomOutButton.addEventListener('click', () => {
  setCanvasZoom(currentZoom() - ZOOM_STEP)
})

zoomInButton.addEventListener('click', () => {
  setCanvasZoom(currentZoom() + ZOOM_STEP)
})

zoomRange.addEventListener('input', () => {
  const value = Number(zoomRange.value) || 100
  setCanvasZoom(value / 100)
})

zoomFitButton.addEventListener('click', () => {
  fitCanvasZoomToStage()
})

window.addEventListener('keydown', (event) => {
  if (isEditingField(event.target)) {
    return
  }

  if (event.key === 'Delete') {
    event.preventDefault()
    removeSelectedLayer()
    return
  }

  if (
    event.key === 'ArrowLeft' ||
    event.key === 'ArrowRight' ||
    event.key === 'ArrowUp' ||
    event.key === 'ArrowDown'
  ) {
    const moved = nudgeSelectedLayer(event.key)
    if (moved) {
      event.preventDefault()
    }
  }
})

canvas.on('selection:created', () => {
  if (!suppressSelectionSync) {
    renderLayersAccordion()
  }
})

canvas.on('selection:updated', () => {
  if (!suppressSelectionSync) {
    renderLayersAccordion()
  }
})

canvas.on('selection:cleared', () => {
  if (!suppressSelectionSync) {
    renderLayersAccordion()
  }
})

canvas.on('object:modified', (e) => {
  const obj = e.target
  if (obj instanceof FabricImage) {
    const meta = getLayerMeta(obj)
    if (meta.kind === 'image') {
      // keep slot dimensions in sync with the object's visual size after any transform
      setLayerMeta(obj, { ...meta, slotWidth: Math.max(1, obj.getScaledWidth()), slotHeight: Math.max(1, obj.getScaledHeight()) })
    }
  }
  renderLayersAccordion()
  persistActiveDeckDocument()
})

canvas.on('object:added', (event) => {
  const object = event.target
  if (!object) {
    return
  }

  applyRuntimeConfig(object)
  refreshLayerIndex()
})

window.addEventListener('resize', () => {
  fitCanvasZoomToStage()
})

attachCanvasDnD()
renderWorkspaceSidebar()
void loadActiveDeckCard(currentDeck()).then(async () => {
  await refreshDeckThumbnails(currentDeck())
})
setTimeout(() => {
  fitCanvasZoomToStage()
}, 0)
