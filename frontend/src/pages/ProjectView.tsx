import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, type FrameInfo, type Point, type ProjectMeta } from '../api/client'
import { useFrameCache } from '../hooks/useFrameCache'
import PropagationPanel from '../components/PropagationPanel'
import styles from './ProjectView.module.css'

type PromptMode = 'point' | 'box'
type BoxCoords = [number, number, number, number] // [x1, y1, x2, y2]

const ZOOM_FACTOR = 1.1
const MIN_ZOOM = 0.05
const MAX_ZOOM = 10
const MIN_BOX_SIZE_PX = 4
const BOX_DASH_PATTERN: [number, number] = [6, 3]

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
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<string>('')
  const [maskBuster, setMaskBuster] = useState(0)

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
  }, [currentFrame, meta, projectId, maskVisible, maskOpacity, maskBuster, frames, positivePoints, negativePoints, box, liveBox, loadFrame])

  function drawCanvas(
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    mask: HTMLImageElement | null,
  ) {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    ctx.drawImage(img, 0, 0)

    if (mask) {
      ctx.globalAlpha = maskOpacity
      ctx.globalCompositeOperation = 'source-over'
      const offscreen = document.createElement('canvas')
      offscreen.width = ctx.canvas.width
      offscreen.height = ctx.canvas.height
      const oCtx = offscreen.getContext('2d')!
      oCtx.drawImage(mask, 0, 0)
      oCtx.globalCompositeOperation = 'source-in'
      oCtx.fillStyle = 'rgba(0, 200, 100, 1)'
      oCtx.fillRect(0, 0, offscreen.width, offscreen.height)
      ctx.drawImage(offscreen, 0, 0)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
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
            Show mask overlay
          </label>
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
