FROM ghcr.io/mikf/gallery-dl:latest

RUN apk add --no-cache exiftool tzdata

WORKDIR /app

COPY requirements.txt /app/
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY app /app/app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DATA_DIR=/data \
    DOWNLOAD_DIR=/gallery-dl \
    LEGACY_CONF_PATH=/config/legacy-gallery-dl.conf \
    INTERNAL_PORT=8766

HEALTHCHECK --interval=1m --timeout=10s --start-period=20s --retries=3 \
  CMD ["python3", "-m", "app.main", "--healthcheck"]

ENTRYPOINT ["python3", "-m", "app.main"]
CMD ["--serve"]
