# Clawback data service (see nas/README.md). Build from the repository root:
#   docker build -f nas/Dockerfile -t clawback-data .
FROM python:3.12-slim

# Node runs the app's tests against every new build before it's published.
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY nas/requirements.txt nas/
RUN pip install --no-cache-dir -r nas/requirements.txt
COPY scripts/build_data.py scripts/
COPY js/ js/
COPY test/*.test.js test/
COPY nas/clawback_data.py nas/

ENV PYTHONUNBUFFERED=1 HOME=/tmp DATA_DIR=/data
# Unhealthy when the loop stopped (30 min) or the data is more than 10 days old (refreshes failed).
HEALTHCHECK --interval=10m --timeout=10s --start-period=2h \
    CMD python -c "import json,os,sys,time; from datetime import datetime; \
d=json.load(open('/data/current/uov.json')); \
sys.exit(time.time()-os.path.getmtime('/tmp/alive')>1800 or time.time()-datetime.fromisoformat(d['generated']).timestamp()>10*86400)"
CMD ["python", "nas/clawback_data.py"]
