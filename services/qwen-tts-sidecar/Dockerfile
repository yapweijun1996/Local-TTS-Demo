# CPU image (works everywhere, slow inference — dev/demo only).
# For GPU serving swap the base for an NVIDIA CUDA image, e.g.:
#   FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04  (+ install python3.12)
# and run the container with `--gpus all`.
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .

# Model weights download at first startup into this cache; mount it to persist.
ENV HF_HOME=/models
VOLUME /models

EXPOSE 8100
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8100"]
