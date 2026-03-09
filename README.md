# LazyLabel Web

A localhost web application for video mask propagation using [SAM2.1](https://github.com/facebookresearch/sam2).

**Sequence-first**: import a video → choose a frame → add point prompts → propagate masks across the entire clip.

---

## Requirements

- Python ≥ 3.10
- Node.js ≥ 18
- NVIDIA GPU with CUDA (CPU is supported but extremely slow — a warning will be shown)
- SAM2.1 installed and weights downloaded

---

## Setup

### 1. Install SAM2

```bash
pip install git+https://github.com/facebookresearch/sam2.git
```

Download SAM2.1 weights (e.g. `sam2.1_hiera_large.pt`) from the [SAM2 releases](https://github.com/facebookresearch/sam2/releases).

### 2. Backend

```bash
cd backend
pip install -e .
# or: uv sync
```

Configure via environment variables (optional — defaults shown):

| Variable | Default | Description |
|---|---|---|
| `LAZYLABEL_WEB_SAM2_WEIGHTS` | _(required)_ | Absolute path to SAM2 `.pt` weights file |
| `LAZYLABEL_WEB_SAM2_CONFIG` | `configs/sam2.1/sam2.1_hiera_large.yaml` | SAM2 config YAML |
| `LAZYLABEL_WEB_DEVICE` | `cuda` | `cuda`, `cpu`, or `mps` |
| `LAZYLABEL_WEB_DATA_DIR` | platform default¹ | Where projects are stored |

¹ Linux: `~/.local/share/lazylabel-web` · macOS: `~/Library/Application Support/lazylabel-web` · Windows: `%APPDATA%\lazylabel-web`

Start the backend:

```bash
export LAZYLABEL_WEB_SAM2_WEIGHTS=/path/to/sam2.1_hiera_large.pt
uvicorn app.main:app --reload --port 8000
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## Usage

1. **Import Video** — enter the absolute path to a video file (mp4, mov, etc.) and click **Import**. Frames are extracted automatically.

2. **View Frames** — use the timeline slider or frame strip at the bottom to navigate.

3. **Add Prompts** — left-click to add a positive point (green), right-click to add a negative point (red).

4. **Run Prompt** — click **▶ Run Prompt** to generate a mask for the current frame using SAM2.

5. **Propagate** — in the Propagation panel, set the frame range and direction, then click **🚀 Start Propagation**. Progress is shown in real time.

6. **View Results** — after propagation, navigate through frames to see the overlaid masks.

---

## Architecture

```
backend/
  app/
    main.py          # FastAPI entry point
    config.py        # Configuration from env vars
    routers/         # API route handlers
    services/        # Business logic (project, SAM2, jobs)
    models/          # Pydantic schemas

frontend/
  src/
    App.tsx          # Router
    pages/           # ProjectList, ProjectView
    components/      # PropagationPanel
    api/client.ts    # API client
```

### API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Backend version, CUDA status |
| GET | `/api/projects` | List projects |
| POST | `/api/projects/import_video` | Import video + extract frames |
| GET | `/api/projects/{id}` | Project metadata |
| GET | `/api/projects/{id}/frames` | Frame list with mask status |
| GET | `/api/projects/{id}/frames/{n}/image` | Serve frame JPEG |
| GET | `/api/projects/{id}/frames/{n}/mask` | Serve mask PNG |
| DELETE | `/api/projects/{id}/frames/{n}/mask` | Delete mask |
| POST | `/api/projects/{id}/frames/{n}/prompt` | Run SAM2 prompt |
| POST | `/api/projects/{id}/propagate` | Start propagation job |
| GET | `/api/jobs/{job_id}` | Job status + progress |

### On-disk Layout

```
~/.local/share/lazylabel-web/
  projects/
    <project_id>/
      meta.json
      source/video.mp4
      frames/000000.jpg …
      masks/000000.png …
      jobs/<job_id>.json
      exports/
```

---

## Production

Build the frontend and serve it from FastAPI:

```bash
cd frontend && npm run build
```

Then add to `backend/app/main.py`:

```python
app.mount("/", StaticFiles(directory="../frontend/dist", html=True), name="static")
```
