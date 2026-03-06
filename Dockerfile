# Use the official DITA-OT image
FROM ghcr.io/dita-ot/dita-ot:4.2

# Switch to root to install Python
USER root
RUN apt-get update && apt-get install -y python3 python3-pip

# Set working directory
WORKDIR /app

# Copy requirements and install
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt --break-system-packages

# Copy your Python API script
COPY main.py .

# Railway provides a PORT environment variable automatically
ENV PORT 8080
EXPOSE 8080

# Start the Python web server
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
