import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, type ClassAlias, type FrameInfo, type Point, type ProjectMeta } from '../api/client'
import { useFrameCache } from '../hooks/useFrameCache'
import PropagationPanel from '../components/PropagationPanel'
import styles from './ProjectView.module.css'

type PromptMode = 'point' | 'box'
type BoxCoords = [number, number, number, number] // [x1, y1, x2, y2]
type DisplayMode = 'mask' | 'bbox' | 'both'

const ZOOM_FACTOR = 1.1
const MIN_ZOOM = 0.05
const MAX_ZOOM = 10
const MIN_BOX_SIZE_PX = 4
const BOX_DASH_PATTERN: [number, number] = [6, 3]
// Max dimension when sampling mask for bbox computation (performance optimisation)
const BBOX_SAMPLE_MAX = 512

export default function ProjectView() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()

  const [meta, setMeta] = useState<ProjectMeta | null>(null)
  const [frames, setFrames] = useState<FrameInfo[]>([])
  const [currentFrame, setCurrentFrame] = useState(0)
  const [positivePoints, setPositivePoints] = useState<Point[]>([])
  const [negativePoints, setNegativePoints] = useState<Point[]>([])
  const [promptMode, setPromptMode] = useState<PromptMode>('point')
  const [box, setBox] = useState<BoxCoords | null>(null)
  const [maskVisible, setMaskVisible] = useState(true)
  const [maskOpacity, setMaskOpacity] = useState(0.5)
  const [displayMode, setDisplayMode] = useState<DisplayMode>('mask')
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackFps, setPlaybackFps] = useState(10)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<string>('')
  const [maskBuster, setMaskBuster] = useState(0)

  // Class aliases
  const [classes, setClasses] = useState<ClassAlias[]>([])
  const [editingClasses, setEditingClasses] = useState<ClassAlias[]>([])
  const [selectedClassId, setSelectedClassId] = useState<number | null>(null)
  const [classesDirty, setClassesDirty] = useState(false)

  // Zoom state: null = fit-to-viewport (default CSS behavior)
  const [zoom, setZoom] = useState<number | null>(null)
  const zoomRef = useRef<number | null>(null)

  // Box drawing state (tracked via refs to avoid re-render during drag)
  const isDrawingBox = useRef(false)
  const boxDragStart = useRef<Point | null>(null)
  const [liveBox, setLiveBox] = useState<BoxCoords | null>(null) // box being drawn

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const maskRef = useRef<HTMLImageElement | null>(null)

  const { loadFrame } = useFrameCache(projectId, meta?.frame_count ?? 0, currentFrame, api.frameImageUrl)

  // Keep zoom ref in sync with state for use inside non-React event listeners
  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  // Load project metadata
  useEffect(() => {
    if (!projectId) return
    api.getProject(projectId).then(setMeta).catch(() => navigate('/'))
  }, [projectId, navigate])

  // Load frames list
  const refreshFrames = useCallback(() => {
    if (!projectId) return
    api.listFrames(projectId).then(setFrames)
  }, [projectId])

  useEffect(() => {
    refreshFrames()
  }, [refreshFrames])

  // Load class aliases
  useEffect(() => {
    if (!projectId) return
    api.getClasses(projectId).then((cls) => {
      setClasses(cls)
      setEditingClasses(cls)
    })
  }, [projectId])

  // Attach non-passive wheel listener for zoom (React's onWheel is passive in some browsers)
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return

    function handleWheel(e: WheelEvent) {
      e.preventDefault()
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const currentZoom = zoomRef.current ?? (rect.width / canvas.width)
      const factor = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, currentZoom * factor))
      zoomRef.current = newZoom
      setZoom(newZoom)
    }

    wrapper.addEventListener('wheel', handleWheel, { passive: false })
    return () => wrapper.removeEventListener('wheel', handleWheel)
  }, [])

  // Playback: auto-advance frames at the selected FPS
  useEffect(() => {
    if (!isPlaying || !meta) return
    const intervalMs = 1000 / playbackFps
    const id = setInterval(() => {
      setCurrentFrame((prev) => {
        if (prev >= meta.frame_count - 1) {
          setIsPlaying(false)
          return prev
        }
        return prev + 1
      })
    }, intervalMs)
    return () => clearInterval(id)
  }, [isPlaying, playbackFps, meta])

  // Render canvas whenever frame/mask/points/box/zoom change
  useEffect(() => {
    if (!meta || !projectId) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const maskUrl = api.frameMaskUrl(projectId, currentFrame) + `?v=${maskBuster}`

    loadFrame(currentFrame).then((img) => {
      imgRef.current = img
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      drawCanvas(ctx, img, null)

      if (maskVisible && frames[currentFrame]?.has_mask) {
        const mask = new Image()
        mask.crossOrigin = 'anonymous'
        mask.src = maskUrl
        mask.onload = () => {
          maskRef.current = mask
          drawCanvas(ctx, img, mask)
        }
        mask.onerror = () => drawCanvas(ctx, img, null)
      }
    }).catch((err) => {
      console.error('Failed to load frame', currentFrame, err)
    })
  }, [currentFrame, meta, projectId, maskVisible, maskOpacity, maskBuster, frames, positivePoints, negativePoints, box, liveBox, loadFrame, displayMode, classes])

  // Compute the bounding rectangle of the non-zero pixels in a mask image.
  // Uses a downsampled canvas for performance (BBOX_SAMPLE_MAX on longest side).
  function computeMaskBBox(mask: HTMLImageElement): [number, number, number, number] | null {
    const scale = Math.min(1, BBOX_SAMPLE_MAX / Math.max(mask.naturalWidth, mask.naturalHeight))
    const w = Math.round(mask.naturalWidth * scale)
    const h = Math.round(mask.naturalHeight * scale)
    const offscreen = document.createElement('canvas')
    offscreen.width = w
    offscreen.height = h
    const oCtx = offscreen.getContext('2d')!
    oCtx.drawImage(mask, 0, 0, w, h)
    const { data } = oCtx.getImageData(0, 0, w, h)
    let minX = w, minY = h, maxX = -1, maxY = -1
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        if (data[i] > 0 || data[i + 1] > 0 || data[i + 2] > 0 || data[i + 3] > 0) {
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < 0) return null
    return [
      Math.floor(minX / scale),
      Math.floor(minY / scale),
      Math.ceil((maxX + 1) / scale),
      Math.ceil((maxY + 1) / scale),
    ]
  }

  function drawCanvas(
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    mask: HTMLImageElement | null,
  ) {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    ctx.drawImage(img, 0, 0)

    // Resolve the class color for the current frame's label (if any)
    const currentClassId = frames[currentFrame]?.class_id ?? null
    const activeClass = currentClassId !== null ? classes.find((c) => c.id === currentClassId) : undefined
    const maskColor = activeClass ? activeClass.color : '#00c864'

    if (mask) {
      // Mask overlay
      if (displayMode === 'mask' || displayMode === 'both') {
        ctx.globalAlpha = maskOpacity
        ctx.globalCompositeOperation = 'source-over'
        const offscreen = document.createElement('canvas')
        offscreen.width = ctx.canvas.width
        offscreen.height = ctx.canvas.height
        const oCtx = offscreen.getContext('2d')!
        oCtx.drawImage(mask, 0, 0)
        oCtx.globalCompositeOperation = 'source-in'
        oCtx.fillStyle = maskColor
        oCtx.fillRect(0, 0, offscreen.width, offscreen.height)
        ctx.drawImage(offscreen, 0, 0)
        ctx.globalAlpha = 1
        ctx.globalCompositeOperation = 'source-over'
      }

      // Bounding box derived from mask pixels
      const bbox = (displayMode === 'bbox' || displayMode === 'both') ? computeMaskBBox(mask) : null
      if (bbox) {
        const [x1, y1, x2, y2] = bbox
        const lw = Math.max(2, Math.min(ctx.canvas.width, ctx.canvas.height) * 0.003)
        ctx.save()
        ctx.globalAlpha = maskOpacity
        ctx.strokeStyle = maskColor
        ctx.lineWidth = lw
        ctx.setLineDash([])
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)
        ctx.globalAlpha = maskOpacity * 0.15
        ctx.fillStyle = maskColor
        ctx.fillRect(x1, y1, x2 - x1, y2 - y1)
        ctx.restore()
      }

      // Draw class label text over the mask region
      if (activeClass) {
        const labelBbox = bbox ?? computeMaskBBox(mask)
        if (labelBbox) {
          const [x1, y1] = labelBbox
          const fontSize = Math.max(14, Math.min(ctx.canvas.width, ctx.canvas.height) * 0.028)
          ctx.save()
          ctx.font = `bold ${fontSize}px sans-serif`
          const textMetrics = ctx.measureText(activeClass.name)
          const textW = textMetrics.width
          const labelY = Math.max(fontSize + 4, y1 - 4)
          // Semi-transparent background rectangle
          ctx.globalAlpha = 0.75
          ctx.fillStyle = '#000'
          ctx.fillRect(x1, labelY - fontSize - 2, textW + 10, fontSize + 6)
          // Label text in class color
          ctx.globalAlpha = 1
          ctx.fillStyle = maskColor
          ctx.fillText(activeClass.name, x1 + 5, labelY)
          ctx.restore()
        }
      }
    }

    // Draw point prompts
    const r = Math.max(4, Math.min(ctx.canvas.width, ctx.canvas.height) * 0.01)
    for (const pt of positivePoints) {
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(0, 255, 0, 0.9)'
      ctx.fill()
      ctx.strokeStyle = 'white'
      ctx.lineWidth = 2
      ctx.stroke()
    }
    for (const pt of negativePoints) {
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255, 50, 50, 0.9)'
      ctx.fill()
      ctx.strokeStyle = 'white'
      ctx.lineWidth = 2
      ctx.stroke()
    }

    // Draw committed box prompt
    const activeBox = liveBox ?? box
    if (activeBox) {
      const [x1, y1, x2, y2] = activeBox
      const bx = Math.min(x1, x2)
      const by = Math.min(y1, y2)
      const bw = Math.abs(x2 - x1)
      const bh = Math.abs(y2 - y1)
      ctx.save()
      ctx.strokeStyle = 'rgba(255, 200, 0, 0.95)'
      ctx.lineWidth = 2
      ctx.setLineDash(BOX_DASH_PATTERN)
      ctx.strokeRect(bx, by, bw, bh)
      ctx.globalAlpha = 0.1
      ctx.fillStyle = 'rgba(255, 200, 0, 1)'
      ctx.fillRect(bx, by, bw, bh)
      ctx.restore()
    }
  }

  // Convert a mouse event to canvas image-space coordinates (accounts for CSS scaling)
  function getCanvasCoords(e: React.MouseEvent<HTMLCanvasElement>): Point {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    }
  }

  function handleCanvasMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    if (promptMode === 'box') {
      e.preventDefault()
      const pt = getCanvasCoords(e)
      boxDragStart.current = pt
      isDrawingBox.current = true
      setLiveBox([pt.x, pt.y, pt.x, pt.y])
    }
  }

  function handleCanvasMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (promptMode === 'box' && isDrawingBox.current && boxDragStart.current) {
      const pt = getCanvasCoords(e)
      const start = boxDragStart.current
      setLiveBox([start.x, start.y, pt.x, pt.y])
    }
  }

  function handleCanvasMouseUp(e: React.MouseEvent<HTMLCanvasElement>) {
    if (promptMode === 'box' && isDrawingBox.current && boxDragStart.current) {
      isDrawingBox.current = false
      const pt = getCanvasCoords(e)
      const start = boxDragStart.current
      const newBox: BoxCoords = [start.x, start.y, pt.x, pt.y]
      // Only keep the box if it has non-trivial size (> 4px in each dimension)
      if (Math.abs(pt.x - start.x) > MIN_BOX_SIZE_PX && Math.abs(pt.y - start.y) > MIN_BOX_SIZE_PX) {
        setBox(newBox)
      }
      setLiveBox(null)
      boxDragStart.current = null
    }
  }

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    // Only handle point placement in point mode; box mode uses mouseDown/Up
    if (promptMode !== 'point') return
    const pt = getCanvasCoords(e)
    if (e.button === 2 || e.altKey) {
      setNegativePoints((prev) => [...prev, pt])
    } else {
      setPositivePoints((prev) => [...prev, pt])
    }
  }

  function handleCanvasContextMenu(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault()
    if (promptMode !== 'point') return
    const pt = getCanvasCoords(e)
    setNegativePoints((prev) => [...prev, pt])
  }

  async function handleRunPrompt() {
    if (!projectId) return
    const hasPoints = positivePoints.length > 0 || negativePoints.length > 0
    const hasBox = box !== null
    if (!hasPoints && !hasBox) {
      setStatus('Add at least one point or draw a box first.')
      return
    }
    setRunning(true)
    setStatus('Running SAM2 prompt…')
    try {
      await api.runPrompt(projectId, currentFrame, positivePoints, negativePoints, box)
      if (selectedClassId !== null) {
        await api.setFrameLabel(projectId, currentFrame, selectedClassId)
      }
      setStatus('Mask generated ✓')
      setMaskBuster((b) => b + 1)
      refreshFrames()
    } catch (e) {
      setStatus(`Error: ${e}`)
    } finally {
      setRunning(false)
    }
  }

  async function handleDeleteMask() {
    if (!projectId) return
    try {
      await api.deleteMask(projectId, currentFrame)
      setMaskBuster((b) => b + 1)
      refreshFrames()
      setStatus('Mask deleted.')
    } catch {
      setStatus('No mask to delete.')
    }
  }

  async function handleClearAllMasks() {
    if (!projectId) return
    if (!window.confirm('Delete ALL masks for this project? This cannot be undone.')) return
    try {
      const result = await api.clearAllMasks(projectId)
      setMaskBuster((b) => b + 1)
      refreshFrames()
      setStatus(`Cleared ${result.deleted} mask(s).`)
    } catch {
      setStatus('Failed to clear masks.')
    }
  }

  function handleClearPoints() {
    setPositivePoints([])
    setNegativePoints([])
  }

  function handleClearBox() {
    setBox(null)
    setLiveBox(null)
  }

  function handleExport() {
    if (!projectId) return
    const a = document.createElement('a')
    a.href = api.exportMasksUrl(projectId)
    a.download = ''
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  function handleResetZoom() {
    setZoom(null)
    zoomRef.current = null
  }

  // ── Class alias management ──────────────────────────────────────────────────

  const DEFAULT_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#f97316', '#ec4899']

  function handleAddClass() {
    // Use max of both saved and editing classes to avoid ID reuse after deletion
    const allIds = [...classes.map((c) => c.id), ...editingClasses.map((c) => c.id)]
    const nextId = allIds.length > 0 ? Math.max(...allIds) + 1 : 1
    const color = DEFAULT_COLORS[(nextId - 1) % DEFAULT_COLORS.length]
    setEditingClasses((prev) => [...prev, { id: nextId, name: `Class ${nextId}`, color }])
    setClassesDirty(true)
  }

  function handleEditClassName(id: number, name: string) {
    setEditingClasses((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)))
    setClassesDirty(true)
  }

  function handleEditClassColor(id: number, color: string) {
    setEditingClasses((prev) => prev.map((c) => (c.id === id ? { ...c, color } : c)))
    setClassesDirty(true)
  }

  function handleDeleteClass(id: number) {
    setEditingClasses((prev) => prev.filter((c) => c.id !== id))
    if (selectedClassId === id) setSelectedClassId(null)
    setClassesDirty(true)
  }

  async function handleSaveClasses() {
    if (!projectId) return
    try {
      await api.saveClasses(projectId, editingClasses)
      setClasses(editingClasses)
      setClassesDirty(false)
      setStatus('Classes saved ✓')
    } catch (e) {
      console.error('Failed to save classes', e)
      setStatus('Failed to save classes.')
    }
  }

  async function handleSetFrameLabel(classId: number | null) {
    if (!projectId) return
    try {
      await api.setFrameLabel(projectId, currentFrame, classId)
      refreshFrames()
    } catch (e) {
      console.error('Failed to update label', e)
      setStatus('Failed to update label.')
    }
  }

  const currentHasMask = frames[currentFrame]?.has_mask ?? false
  const maskedFrameCount = frames.filter((f) => f.has_mask).length

  // Determine canvas CSS size: explicit when zoomed, otherwise default max-width/max-height
  const canvasStyle =
    zoom !== null && meta
      ? { width: `${meta.width * zoom}px`, height: `${meta.height * zoom}px`, maxWidth: 'none', maxHeight: 'none' }
      : undefined

  if (!meta) {
    return (
      <div className={styles.loading}>
        <p>Loading project…</p>
      </div>
    )
  }

  return (
    <div className={styles.layout}>
      {/* Sidebar */}
      <aside className={styles.sidebar}>
        <button className={styles.backBtn} onClick={() => navigate('/')}>
          ← Back
        </button>
        <h2 className={styles.projectName}>{meta.source_filename}</h2>
        <p className={styles.projectMeta}>
          {meta.frame_count} frames · {meta.fps.toFixed(1)} fps · {meta.width}×{meta.height}
        </p>

        <div className={styles.section}>
          <h3>Frame Navigation</h3>
          <div className={styles.frameNav}>
            <span>Frame: {currentFrame}</span>
            <input
              type="number"
              min={0}
              max={meta.frame_count - 1}
              value={currentFrame}
              onChange={(e) => {
                const v = Math.max(0, Math.min(meta.frame_count - 1, parseInt(e.target.value) || 0))
                setCurrentFrame(v)
              }}
              className={styles.frameInput}
            />
          </div>
        </div>

        {/* Class Aliases */}
        <div className={styles.section}>
          <h3>Classes</h3>
          {editingClasses.length === 0 && (
            <p className={styles.hint}>No classes defined. Add one below.</p>
          )}
          <div className={styles.classList}>
            {editingClasses.map((cls) => (
              <div key={cls.id} className={styles.classRow}>
                <input
                  type="color"
                  value={cls.color}
                  className={styles.colorSwatch}
                  onChange={(e) => handleEditClassColor(cls.id, e.target.value)}
                  title="Class color"
                />
                <input
                  type="text"
                  value={cls.name}
                  className={styles.classNameInput}
                  onChange={(e) => handleEditClassName(cls.id, e.target.value)}
                  placeholder="Class name"
                />
                <button
                  className={styles.classDeleteBtn}
                  onClick={() => handleDeleteClass(cls.id)}
                  title="Delete class"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className={styles.btnGroup} style={{ marginTop: 8 }}>
            <button className={styles.secondaryBtn} onClick={handleAddClass}>
              + Add Class
            </button>
            {classesDirty && (
              <button className={styles.primaryBtn} onClick={handleSaveClasses}>
                💾 Save Classes
              </button>
            )}
          </div>
        </div>

        <div className={styles.section}>
          <h3>Prompts</h3>
          <div className={styles.modeToggle}>
            <button
              className={promptMode === 'point' ? styles.modeActive : styles.modeBtn}
              onClick={() => setPromptMode('point')}
            >
              ● Points
            </button>
            <button
              className={promptMode === 'box' ? styles.modeActive : styles.modeBtn}
              onClick={() => setPromptMode('box')}
            >
              ▭ Box
            </button>
          </div>

          {/* Active class selector */}
          {classes.length > 0 && (
            <div className={styles.classSelector}>
              <label className={styles.classSelectorLabel}>Label as:</label>
              <select
                className={styles.classSelectorSelect}
                value={selectedClassId ?? ''}
                onChange={(e) => setSelectedClassId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">— none —</option>
                {classes.map((cls) => (
                  <option key={cls.id} value={cls.id}>
                    {cls.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {promptMode === 'point' ? (
            <>
              <p className={styles.hint}>
                Left-click = positive (green) · Right-click / Alt+click = negative (red)
              </p>
              <p className={styles.pointCount}>
                ✅ {positivePoints.length} pos · ❌ {negativePoints.length} neg
              </p>
            </>
          ) : (
            <>
              <p className={styles.hint}>Drag on the frame to draw a bounding box.</p>
              {box ? (
                <p className={styles.pointCount}>
                  Box: [{Math.round(Math.min(box[0], box[2]))}, {Math.round(Math.min(box[1], box[3]))}] →
                  [{Math.round(Math.max(box[0], box[2]))}, {Math.round(Math.max(box[1], box[3]))}]
                </p>
              ) : (
                <p className={styles.pointCount}>No box drawn</p>
              )}
            </>
          )}

          <div className={styles.btnGroup}>
            <button
              className={styles.primaryBtn}
              onClick={handleRunPrompt}
              disabled={running}
            >
              {running ? 'Running…' : '▶ Run Prompt'}
            </button>
            {promptMode === 'point' && (
              <button className={styles.secondaryBtn} onClick={handleClearPoints}>
                Clear Points
              </button>
            )}
            {promptMode === 'box' && box && (
              <button className={styles.secondaryBtn} onClick={handleClearBox}>
                Clear Box
              </button>
            )}
          </div>
          {status && <p className={styles.status}>{status}</p>}
        </div>

        <div className={styles.section}>
          <h3>Mask Controls</h3>
          <label className={styles.toggleRow}>
            <input
              type="checkbox"
              checked={maskVisible}
              onChange={(e) => setMaskVisible(e.target.checked)}
            />
            Show annotation overlay
          </label>
          {maskVisible && (
            <div className={styles.displayModeToggle}>
              <button
                className={displayMode === 'mask' ? styles.modeActive : styles.modeBtn}
                onClick={() => setDisplayMode('mask')}
                title="Show colored mask overlay"
              >
                Mask
              </button>
              <button
                className={displayMode === 'bbox' ? styles.modeActive : styles.modeBtn}
                onClick={() => setDisplayMode('bbox')}
                title="Show bounding box around masked region"
              >
                BBox
              </button>
              <button
                className={displayMode === 'both' ? styles.modeActive : styles.modeBtn}
                onClick={() => setDisplayMode('both')}
                title="Show both mask overlay and bounding box"
              >
                Both
              </button>
            </div>
          )}
          <label className={styles.sliderRow}>
            Opacity
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={maskOpacity}
              onChange={(e) => setMaskOpacity(parseFloat(e.target.value))}
            />
          </label>
          {/* Per-frame label assignment */}
          {currentHasMask && classes.length > 0 && (
            <div className={styles.frameLabelRow}>
              <span className={styles.frameLabelText}>
                Label:
              </span>
              <select
                className={styles.classSelectorSelect}
                value={frames[currentFrame]?.class_id ?? ''}
                onChange={(e) => handleSetFrameLabel(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">— none —</option>
                {classes.map((cls) => (
                  <option key={cls.id} value={cls.id}>
                    {cls.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className={styles.btnGroup} style={{ marginTop: 8 }}>
            {currentHasMask && (
              <button className={styles.dangerBtn} onClick={handleDeleteMask}>
                🗑 Delete Mask
              </button>
            )}
            {maskedFrameCount > 0 && (
              <button className={styles.dangerBtn} onClick={handleClearAllMasks}>
                🗑 Clear All Masks ({maskedFrameCount})
              </button>
            )}
          </div>
        </div>

        <div className={styles.section}>
          <h3>Export</h3>
          <p className={styles.hint}>
            Download all masks as a ZIP archive.
          </p>
          <button className={styles.secondaryBtn} onClick={handleExport} disabled={maskedFrameCount === 0}>
            ⬇ Export Masks ({maskedFrameCount})
          </button>
        </div>

        <PropagationPanel
          projectId={projectId!}
          frameCount={meta.frame_count}
          currentFrame={currentFrame}
          positivePoints={positivePoints}
          negativePoints={negativePoints}
          box={box}
          onComplete={refreshFrames}
        />
      </aside>

      {/* Main canvas area */}
      <main className={styles.main}>
        <div className={styles.canvasWrapper} ref={wrapperRef}>
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            style={canvasStyle}
            onClick={handleCanvasClick}
            onContextMenu={handleCanvasContextMenu}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
          />
        </div>

        {/* Zoom indicator */}
        {zoom !== null && (
          <div className={styles.zoomBar}>
            <span>{Math.round(zoom * 100)}%</span>
            <button className={styles.zoomResetBtn} onClick={handleResetZoom}>
              Reset Zoom
            </button>
          </div>
        )}

        {/* Playback controls */}
        <div className={styles.playbackBar}>
          <button
            className={styles.playBtn}
            onClick={() => setIsPlaying((p) => !p)}
            title={isPlaying ? 'Pause playback' : 'Play frames at the selected FPS'}
          >
            {isPlaying ? '⏸ Pause' : '▶ Play'}
          </button>
          <span className={styles.fpsLabel}>{playbackFps} fps</span>
          <input
            type="range"
            min={1}
            max={30}
            step={1}
            value={playbackFps}
            onChange={(e) => setPlaybackFps(parseInt(e.target.value))}
            className={styles.fpsSlider}
            title="Playback speed"
          />
        </div>

        {/* Timeline */}
        <div className={styles.timeline}>
          <span className={styles.timelineLabel}>0</span>
          <input
            type="range"
            min={0}
            max={meta.frame_count - 1}
            value={currentFrame}
            onChange={(e) => setCurrentFrame(parseInt(e.target.value))}
            className={styles.timelineSlider}
          />
          <span className={styles.timelineLabel}>{meta.frame_count - 1}</span>
          <span className={styles.timelineCurrent}>Frame {currentFrame}</span>
        </div>

        {/* Mini frame strip showing mask coverage */}
        <div className={styles.frameStrip}>
          {frames.map((f) => (
            <button
              key={f.frame_index}
              title={`Frame ${f.frame_index}${f.has_mask ? ' (has mask)' : ''}`}
              className={[
                styles.stripFrame,
                f.frame_index === currentFrame ? styles.stripActive : '',
                f.has_mask ? styles.stripHasMask : '',
              ].join(' ')}
              onClick={() => setCurrentFrame(f.frame_index)}
            />
          ))}
        </div>
      </main>
    </div>
  )
}
