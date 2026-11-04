FROM python:3.12-slim AS base
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH"
# rasterio's wheel bundles GDAL but links against the system's expat.
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --root-user-action=ignore --disable-pip-version-check uv==0.8.22
WORKDIR /app
COPY pyproject.toml uv.lock ./

FROM base AS dev
RUN uv sync --frozen
# Set after the build step, so these directories are writable by the non-root dev user.
ENV RUFF_NO_CACHE=true MYPY_CACHE_DIR=/tmp/mypy UV_CACHE_DIR=/tmp/uv-cache
COPY . .
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

FROM base AS prod
RUN uv sync --frozen --no-dev
COPY alembic.ini ./
COPY app ./app
COPY migrations ./migrations
RUN useradd --system --no-create-home trailstat
USER trailstat
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
