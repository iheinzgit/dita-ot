from fastapi import FastAPI, UploadFile, BackgroundTasks
from fastapi.responses import FileResponse
import subprocess
import shutil
import os
import uuid

app = FastAPI()

@app.post("/convert")
async def convert_dita(file: UploadFile, format: str = "html5"):
    job_id = str(uuid.uuid4())
    upload_path = f"/tmp/{job_id}"
    os.makedirs(upload_path)
    
    # 1. Save and Unzip the uploaded content
    zip_path = f"{upload_path}/input.zip"
    with open(zip_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    subprocess.run(["unzip", zip_path, "-d", upload_path])

    # 2. Run DITA-OT (Finding the first .ditamap automatically)
    # This assumes your ZIP contains a .ditamap file
    output_path = f"{upload_path}/out"
    result = subprocess.run([
        "/opt/dita-ot/bin/dita", 
        "-i", upload_path, 
        "-f", format, 
        "-o", output_path
    ], capture_all=True)

    # 3. Zip the result and send back
    result_zip = f"/tmp/{job_id}_result.zip"
    shutil.make_archive(result_zip.replace(".zip", ""), 'zip', output_path)
    
    return FileResponse(result_zip, media_type="application/zip", filename="converted_content.zip")

@app.get("/")
def health_check():
    return {"status": "DITA-OT is online"}
