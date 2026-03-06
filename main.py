from fastapi import FastAPI, UploadFile
from fastapi.responses import FileResponse
import subprocess
import shutil
import os
import uuid
import glob

app = FastAPI()

@app.post("/convert")
async def convert_dita(file: UploadFile, format: str = "html5"):
    job_id = str(uuid.uuid4())
    upload_path = f"/tmp/{job_id}"
    os.makedirs(upload_path, exist_ok=True)
    
    # 1. Save and Unzip
    zip_path = f"{upload_path}/input.zip"
    with open(zip_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    
    subprocess.run(["unzip", zip_path, "-d", upload_path])

    # 2. Find the .ditamap file
    maps = glob.glob(f"{upload_path}/*.ditamap")
    if not maps:
        return {"error": "No .ditamap file found in ZIP"}
    
    input_map = maps[0]
    output_path = f"{upload_path}/out"

    # 3. Run DITA-OT (Fixed the capture_all error)
    # Using the absolute path to the dita binary in the official image
    result = subprocess.run([
        "/opt/dita-ot/bin/dita", 
        "-i", input_map, 
        "-f", format, 
        "-o", output_path
    ], capture_output=True, text=True)

    # Log errors to console if DITA-OT fails
    if result.returncode != 0:
        print(f"DITA-OT Error: {result.stderr}")
        return {"error": "DITA-OT failed", "details": result.stderr}

    # 4. Zip result and send
    result_zip_base = f"/tmp/{job_id}_result"
    shutil.make_archive(result_zip_base, 'zip', output_path)
    
    return FileResponse(f"{result_zip_base}.zip", media_type="application/zip", filename="converted_content.zip")

@app.get("/")
def health_check():
    return {"status": "DITA-OT is online"}
