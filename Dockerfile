FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml README.md ./
COPY nwp_ingest ./nwp_ingest
COPY config ./config
RUN pip install --no-cache-dir '.[processing]'
ENV PYTHONUNBUFFERED=1
VOLUME ["/data"]
ENTRYPOINT ["python", "-m", "nwp_ingest", "--data-root", "/data"]
CMD ["--config", "config/starter.json", "watch"]
