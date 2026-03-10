import { useEffect, useRef, useState } from 'react'
import { api, type JobResponse, type Point } from '../api/client'
import styles from './PropagationPanel.module.css'

interface Props {
  projectId: string
  frameCount: number
  currentFrame: number
  positivePoints: Point[]
  negativePoints: Point[]
  box?: [number, number, number, number] | null
  onComplete: () => void
}

export default function PropagationPanel({
  projectId,
  frameCount,
  currentFrame,
  positivePoints,
  negativePoints,
  box,
  onComplete,
}: Props) {
  const [startFrame, setStartFrame] = useState(0)
  const [endFrame, setEndFrame] = useState(Math.max(0, frameCount - 1))
  const [direction, setDirection] = useState<'forward' | 'backward' | 'both'>('forward')
  const [referenceFrame, setReferenceFrame] = useState(currentFrame)
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<JobResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync reference frame with current frame
  useEffect(() => {
    setReferenceFrame(currentFrame)
  }, [currentFrame])

  // Poll job status
  useEffect(() => {
    if (!jobId) return
    function poll() {
      api.getJob(jobId!).then((j) => {
        setJob(j)
        if (j.status === 'running' || j.status === 'queued') {
          pollRef.current = setTimeout(poll, 1000)
        } else if (j.status === 'completed') {
          onComplete()
        }
      })
    }
    poll()
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current)
    }
  }, [jobId, onComplete])

  async function handleStart() {
    setError(null)
    setStarting(true)
    try {
      // Cache prompts for propagation
      await api.cachePrompt(projectId, referenceFrame, positivePoints, negativePoints, box)
      const { job_id } = await api.propagate(projectId, {
        start_frame: startFrame,
        end_frame: endFrame,
        direction,
        reference_frame: referenceFrame,
      })
      setJobId(job_id)
      setJob(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setStarting(false)
    }
  }

  const isRunning = job?.status === 'running' || job?.status === 'queued'
  const pct =
    job && job.progress.total > 0
      ? Math.round((job.progress.done / job.progress.total) * 100)
      : 0

  return (
    <div className={styles.panel}>
      <h3>Propagation</h3>

      <div className={styles.field}>
        <label>Reference Frame</label>
        <input
          type="number"
          min={0}
          max={frameCount - 1}
          value={referenceFrame}
          onChange={(e) =>
            setReferenceFrame(Math.max(0, Math.min(frameCount - 1, parseInt(e.target.value) || 0)))
          }
        />
      </div>

      <div className={styles.field}>
        <label>Start Frame</label>
        <input
          type="number"
          min={0}
          max={frameCount - 1}
          value={startFrame}
          onChange={(e) =>
            setStartFrame(Math.max(0, Math.min(frameCount - 1, parseInt(e.target.value) || 0)))
          }
        />
      </div>

      <div className={styles.field}>
        <label>End Frame</label>
        <input
          type="number"
          min={0}
          max={frameCount - 1}
          value={endFrame}
          onChange={(e) =>
            setEndFrame(Math.max(0, Math.min(frameCount - 1, parseInt(e.target.value) || 0)))
          }
        />
      </div>

      <div className={styles.field}>
        <label>Direction</label>
        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value as 'forward' | 'backward' | 'both')}
        >
          <option value="forward">Forward</option>
          <option value="backward">Backward</option>
          <option value="both">Both</option>
        </select>
      </div>

      <button
        className={styles.startBtn}
        onClick={handleStart}
        disabled={starting || isRunning || (positivePoints.length === 0 && negativePoints.length === 0 && !box)}
      >
        {starting ? 'Starting…' : isRunning ? 'Propagating…' : '🚀 Start Propagation'}
      </button>

      {isRunning && job && (
        <div className={styles.progress}>
          <div className={styles.progressBar}>
            <div className={styles.progressFill} style={{ width: `${pct}%` }} />
          </div>
          <span className={styles.progressText}>
            {job.progress.done} / {job.progress.total} frames ({pct}%)
          </span>
        </div>
      )}

      {job?.status === 'completed' && (
        <p className={styles.success}>✓ Propagation complete</p>
      )}

      {job?.status === 'failed' && (
        <p className={styles.err}>✗ {job.error}</p>
      )}

      {error && <p className={styles.err}>{error}</p>}
    </div>
  )
}
