FROM ghcr.io/dita-ot/dita-ot:4.2

USER root

# Install dependencies
RUN apt-get update && apt-get install -y python3 python3-pip unzip && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python requirements
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# Copy your code
COPY main.py .

# IMPORTANT: Reset the entrypoint so it doesn't try to run 'dita --host'
ENTRYPOINT []

# Railway/Cloud Run environment setup
ENV PORT 8080
EXPOSE 8080

# Use the full path to uvicorn to ensure it's found
CMD ["python3", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
