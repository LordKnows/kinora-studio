# The painter as a small image, for a VPS or a RunPod CPU pod:
#   docker build -t cinema-painter workers/painter
#   docker run -d --restart unless-stopped -v painter:/data \
#     -e STUDIO_URL=https://studio.example.com -e PAINTER_TOKEN=... cinema-painter
# /data keeps the Codex login and the painter id across restarts.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir "pillow>=10" "requests>=2.32"
WORKDIR /app
COPY paint.py painter.py install_codex.sh run_painter.sh /app/
RUN bash /app/install_codex.sh /opt/codex/bin
ENV PAINTER_STATE_DIR=/data CODEX_BIN=/opt/codex/bin/codex CODEX_HOME_MASTER=/data/codex/home \
    CODEX_INSTALL=0 PYTHONUNBUFFERED=1
VOLUME /data
CMD ["bash", "/app/run_painter.sh"]
