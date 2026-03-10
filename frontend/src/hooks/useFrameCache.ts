import { useCallback, useEffect, useRef } from 'react'

/** Maximum number of decoded frame images to keep in memory. */
const CACHE_MAX = 30

/** Number of frames to prefetch ahead of the current frame. */
const PREFETCH_AHEAD = 5

/** Number of frames to keep prefetched behind the current frame. */
const PREFETCH_BEHIND = 2

/**
 * Caches decoded HTMLImageElements for video frames so that navigating to a
 * previously viewed frame is instant (no network round-trip).  Adjacent frames
 * are also prefetched in the background so that scrubbing feels smooth.
 *
 * The cache is bounded by `CACHE_MAX` entries.  When full, the entry that was
 * least recently inserted is evicted (insertion-order LRU via Map).
 */
export function useFrameCache(
  projectId: string | undefined,
  frameCount: number,
  currentFrame: number,
  frameImageUrl: (projectId: string, frameIndex: number) => string,
) {
  // Map preserves insertion order, which gives us cheap LRU eviction via
  // Map.prototype.keys().next() (oldest key first).
  const cacheRef = useRef<Map<number, HTMLImageElement>>(new Map())

  /**
   * Returns a Promise that resolves to the decoded HTMLImageElement for the
   * given frame index.  If the frame is already cached the Promise resolves
   * synchronously (microtask-queue flush), otherwise it initiates a fetch.
   */
  const loadFrame = useCallback(
    (index: number): Promise<HTMLImageElement> => {
      const cache = cacheRef.current

      if (cache.has(index)) {
        return Promise.resolve(cache.get(index)!)
      }

      return new Promise((resolve, reject) => {
        if (!projectId) {
          reject(new Error('No project ID'))
          return
        }

        const img = new Image()
        img.crossOrigin = 'anonymous'

        img.onload = () => {
          // Evict the oldest entry when the cache is full.
          if (cache.size >= CACHE_MAX) {
            const oldest = cache.keys().next().value as number
            cache.delete(oldest)
          }
          cache.set(index, img)
          resolve(img)
        }

        img.onerror = () => reject(new Error(`Failed to load frame ${index}`))
        img.src = frameImageUrl(projectId, index)
      })
    },
    [projectId, frameImageUrl],
  )

  // Prefetch a window of frames around the current position.
  useEffect(() => {
    if (!projectId || frameCount === 0) return

    const cache = cacheRef.current
    for (let i = currentFrame - PREFETCH_BEHIND; i <= currentFrame + PREFETCH_AHEAD; i++) {
      if (i >= 0 && i < frameCount && i !== currentFrame && !cache.has(i)) {
        loadFrame(i).catch(() => {
          // Prefetch errors are non-fatal; the frame will be fetched on demand.
        })
      }
    }
  }, [currentFrame, frameCount, projectId, loadFrame])

  return { loadFrame }
}
