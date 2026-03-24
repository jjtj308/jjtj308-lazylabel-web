// API client for LazyLabel Web backend

export interface ProjectSummary {
  project_id: string
  source_filename: string
  frame_count: number
  fps: number
  created_at: string
}

export interface ProjectMeta extends ProjectSummary {
  width: number
  height: number
  frame_ext: string
}

export interface FrameInfo {
  frame_index: number
  has_mask: boolean
  class_id: number | null
}

export interface ClassAlias {
  id: number
  name: string
  color: string
}

export interface Point {
  x: number
  y: number
}

export interface PromptResponse {
  mask_url: string
  area_px: number
}

export interface PropagateRequest {
  start_frame: number
  end_frame: number
  direction: 'forward' | 'backward' | 'both'
  reference_frame: number
}

export interface JobResponse {
  job_id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  progress: { done: number; total: number }
  last_frame: number | null
  error: string | null
}

export interface HealthResponse {
  version: string
  cuda_available: boolean
  torch_version: string | null
  device: string
}

const BASE = '/api'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, options)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status} ${res.statusText}: ${text}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  health: () => request<HealthResponse>('/health'),

  listProjects: () => request<ProjectSummary[]>('/projects'),

  importVideo: (videoPath: string) =>
    request<{ project_id: string }>('/projects/import_video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_path: videoPath }),
    }),

  getProject: (projectId: string) =>
    request<ProjectMeta>(`/projects/${projectId}`),

  listFrames: (projectId: string) =>
    request<FrameInfo[]>(`/projects/${projectId}/frames`),

  frameImageUrl: (projectId: string, frameIndex: number) =>
    `${BASE}/projects/${projectId}/frames/${frameIndex}/image`,

  frameMaskUrl: (projectId: string, frameIndex: number) =>
    `${BASE}/projects/${projectId}/frames/${frameIndex}/mask`,

  runPrompt: (
    projectId: string,
    frameIndex: number,
    positivePoints: Point[],
    negativePoints: Point[],
    box?: [number, number, number, number] | null,
    save = true,
  ) =>
    request<PromptResponse>(`/projects/${projectId}/frames/${frameIndex}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positive_points: positivePoints, negative_points: negativePoints, box: box ?? null, save }),
    }),

  cachePrompt: (
    projectId: string,
    frameIndex: number,
    positivePoints: Point[],
    negativePoints: Point[],
    box?: [number, number, number, number] | null,
  ) =>
    request<{ cached: boolean }>(`/projects/${projectId}/frames/${frameIndex}/cache_prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positive_points: positivePoints, negative_points: negativePoints, box: box ?? null }),
    }),

  deleteMask: (projectId: string, frameIndex: number) =>
    request<{ deleted: boolean }>(`/projects/${projectId}/frames/${frameIndex}/mask`, {
      method: 'DELETE',
    }),

  clearAllMasks: (projectId: string) =>
    request<{ deleted: number }>(`/projects/${projectId}/masks`, {
      method: 'DELETE',
    }),

  exportMasksUrl: (projectId: string) =>
    `${BASE}/projects/${projectId}/export`,

  propagate: (projectId: string, body: PropagateRequest) =>
    request<{ job_id: string }>(`/projects/${projectId}/propagate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  getJob: (jobId: string) => request<JobResponse>(`/jobs/${jobId}`),

  getClasses: (projectId: string) =>
    request<ClassAlias[]>(`/projects/${projectId}/classes`),

  saveClasses: (projectId: string, classes: ClassAlias[]) =>
    request<{ saved: number }>(`/projects/${projectId}/classes`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classes }),
    }),

  setFrameLabel: (projectId: string, frameIndex: number, classId: number | null) =>
    request<{ frame_index: number; class_id: number | null }>(
      `/projects/${projectId}/frames/${frameIndex}/label`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ class_id: classId }),
      },
    ),
}
