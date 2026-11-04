# ComfyUI worker image with our handler on top. Pin BASE_IMAGE to the tag you
# validated on the GPU pool; the community H3 images change often.
ARG BASE_IMAGE=runpod/worker-comfyui:5.1.0-base
FROM ${BASE_IMAGE}

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY handler.py /app/handler.py
COPY workflows /app/workflows

# Models live on the network volume mounted at /runpod-volume (≥160 GB).
# ComfyUI from the base image is started by its own entrypoint and listens on
# 127.0.0.1:8188; our handler talks to it over HTTP.
ENV COMFY_URL=http://127.0.0.1:8188 \
    WORKFLOW_DIR=/app/workflows \
    PYTHONUNBUFFERED=1

CMD ["python3", "-u", "/app/handler.py"]
