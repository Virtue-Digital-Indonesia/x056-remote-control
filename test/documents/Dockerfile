FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-venv libreoffice-writer=4:7.4.7-1+deb12u14 poppler-utils=22.12.0-2+deb12u3 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
COPY skills/rc-documents/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/rc-documents && /opt/rc-documents/bin/pip install --no-cache-dir -r /tmp/requirements.txt
ENTRYPOINT ["/opt/rc-documents/bin/python"]
