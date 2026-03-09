"""FastAPI application entry point."""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import PROJECTS_DIR
from app.routers import health, projects, prompt, propagation

# Ensure projects dir exists
PROJECTS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="LazyLabel Web", version="0.1.0")

# CORS for development (allow Vite dev server)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(health.router, prefix="/api")
app.include_router(projects.router, prefix="/api")
app.include_router(prompt.router, prefix="/api")
app.include_router(propagation.router, prefix="/api")
