FROM python:3.12-slim
LABEL org.opencontainers.image.source="https://github.com/ruvnet/metaharness"
LABEL org.opencontainers.image.description="Original procedural OpenEnv tasks; no measured transfer claim"
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini && rm -rf /var/lib/apt/lists/*
COPY requirements.lock /app/requirements.lock
RUN pip install --no-cache-dir -r /app/requirements.lock && useradd --uid 10001 --create-home arena
COPY arena_env /app/arena_env
COPY openenv.yaml /app/openenv.yaml
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ENABLE_WEB_INTERFACE=false
USER 10001
EXPOSE 8000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "-m", "uvicorn", "arena_env.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
