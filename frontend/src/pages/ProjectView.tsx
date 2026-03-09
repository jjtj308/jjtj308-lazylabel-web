import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, type FrameInfo, type Point, type ProjectMeta } from '../api/client'
import PropagationPanel from '../components/PropagationPanel'
import styles from './ProjectView.module.css'

export default function ProjectView() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()

  const [meta, setMeta] = useState<ProjectMeta | null>(null)
  const [frames, setFrames] = useState<FrameInfo[]>([])
  const [currentFrame, setCurrentFrame] = useState(0)
  const [positivePoints, setPositivePoints] = useState<Point[]>([])
  const [negativePoints, setNegativePoints] = useState<Point[]>([])
  const [maskVisible, setMaskVisible] = useState(true)
  const [maskOpacity, setMaskOpacity] = useState(0.5)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<string>('')
  const [maskBuster, setMaskBuster] = useState(0)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const maskRef = useRef<HTMLImageElement | null>(null)

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

  // Render canvas whenever frame/mask/points change
  useEffect(() => {
    if (!meta || !projectId) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const frameUrl = api.frameImageUrl(projectId, currentFrame)
    const maskUrl = api.frameMaskUrl(projectId, currentFrame) + `?v=${maskBuster}`

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = frameUrl

    img.onload = () => {
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
    }
  }, [currentFrame, meta, projectId, maskVisible, maskOpacity, maskBuster, frames, positivePoints, negativePoints])

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
      // Draw mask in green tint
      const offscreen = document.createElement('canvas')
      offscreen.width = ctx.canvas.width
      offscreen.height = ctx.canvas.height
      const oCtx = offscreen.getContext('2d')!
      oCtx.drawImage(mask, 0, 0)
      // Colorize: green where mask is white
      oCtx.globalCompositeOperation = 'source-in'
      oCtx.fillStyle = 'rgba(0, 200, 100, 1)'
      oCtx.fillRect(0, 0, offscreen.width, offscreen.height)
      ctx.drawImage(offscreen, 0, 0)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    }

    // Draw points
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
  }

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    const x = (e.clientX - rect.left) * scaleX
    const y = (e.clientY - rect.top) * scaleY

    if (e.button === 2 || e.altKey) {
      setNegativePoints((prev) => [...prev, { x, y }])
    } else {
      setPositivePoints((prev) => [...prev, { x, y }])
    }
  }

  function handleCanvasContextMenu(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault()
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    const x = (e.clientX - rect.left) * scaleX
    const y = (e.clientY - rect.top) * scaleY
    setNegativePoints((prev) => [...prev, { x, y }])
  }

  async function handleRunPrompt() {
    if (!projectId) return
    if (positivePoints.length === 0 && negativePoints.length === 0) {
      setStatus('Add at least one point first.')
      return
    }
    setRunning(true)
    setStatus('Running SAM2 prompt…')
    try {
      await api.runPrompt(projectId, currentFrame, positivePoints, negativePoints)
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

  function handleClearPoints() {
    setPositivePoints([])
    setNegativePoints([])
  }

  const currentHasMask = frames[currentFrame]?.has_mask ?? false

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
          <h3>Point Prompts</h3>
          <p className={styles.hint}>
            Left-click = positive (green) · Right-click / Alt+click = negative (red)
          </p>
          <p className={styles.pointCount}>
            ✅ {positivePoints.length} pos · ❌ {negativePoints.length} neg
          </p>
          <div className={styles.btnGroup}>
            <button
              className={styles.primaryBtn}
              onClick={handleRunPrompt}
              disabled={running}
            >
              {running ? 'Running…' : '▶ Run Prompt'}
            </button>
            <button className={styles.secondaryBtn} onClick={handleClearPoints}>
              Clear Points
            </button>
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
          {currentHasMask && (
            <button className={styles.dangerBtn} onClick={handleDeleteMask}>
              🗑 Delete Mask
            </button>
          )}
        </div>

        <PropagationPanel
          projectId={projectId!}
          frameCount={meta.frame_count}
          currentFrame={currentFrame}
          positivePoints={positivePoints}
          negativePoints={negativePoints}
          onComplete={refreshFrames}
        />
      </aside>

      {/* Main canvas area */}
      <main className={styles.main}>
        <div className={styles.canvasWrapper}>
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            onClick={handleCanvasClick}
            onContextMenu={handleCanvasContextMenu}
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
