import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type ProjectSummary } from '../api/client'
import styles from './ProjectList.module.css'

export default function ProjectList() {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [videoPath, setVideoPath] = useState('')
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    api.listProjects()
      .then(setProjects)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  async function handleImport() {
    if (!videoPath.trim()) return
    setImporting(true)
    setError(null)
    try {
      const { project_id } = await api.importVideo(videoPath.trim())
      navigate(`/projects/${project_id}`)
    } catch (e) {
      setError(String(e))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>🎬 LazyLabel Web</h1>
      <p className={styles.subtitle}>Video mask propagation with SAM2.1</p>

      <div className={styles.importBox}>
        <h2>Import Video</h2>
        <p className={styles.hint}>Enter the absolute path to a video file on this machine.</p>
        <div className={styles.importRow}>
          <input
            type="text"
            placeholder="/path/to/video.mp4"
            value={videoPath}
            onChange={(e) => setVideoPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleImport()}
            className={styles.pathInput}
          />
          <button
            onClick={handleImport}
            disabled={importing || !videoPath.trim()}
            className={styles.importBtn}
          >
            {importing ? 'Importing…' : 'Import'}
          </button>
        </div>
        {error && <div className={styles.error}>{error}</div>}
      </div>

      <div className={styles.projectsSection}>
        <h2>Recent Projects</h2>
        {loading && <p>Loading…</p>}
        {!loading && projects.length === 0 && <p className={styles.empty}>No projects yet.</p>}
        <ul className={styles.projectList}>
          {projects.map((p) => (
            <li key={p.project_id} className={styles.projectItem}>
              <button
                className={styles.projectBtn}
                onClick={() => navigate(`/projects/${p.project_id}`)}
              >
                <span className={styles.projectName}>{p.source_filename}</span>
                <span className={styles.projectMeta}>
                  {p.frame_count} frames · {p.fps.toFixed(1)} fps ·{' '}
                  {new Date(p.created_at).toLocaleDateString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
