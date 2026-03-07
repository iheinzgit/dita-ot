# DITA-OT Worker

Secure DITA-OT conversion worker service. Deploy to Railway via GitHub.

## Endpoints

- `GET /health` — health check, returns `{ status, activeJobs, maxJobs }`
- `POST /convert?format=html5|pdf|epub[&ditaval=filter.ditaval]` — accepts a multipart ZIP containing `map.ditamap` and topic `.dita` files, returns the converted output

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DITA_OT_API_KEY` | Yes (recommended) | _(none)_ | Bearer token callers must send in `Authorization` header |
| `PORT` | No | `3000` | HTTP port (Railway sets this automatically) |
| `DITA_OT_HOME` | No | `/opt/dita-ot` | Path to DITA-OT installation |
| `MAX_CONCURRENT_JOBS` | No | `4` | Max parallel conversion jobs |
| `JOB_TIMEOUT_MS` | No | `300000` | Per-job timeout in milliseconds |

## Deployment Steps

1. Create a new GitHub repository and push these files
2. In Railway, create a new project from that GitHub repository
3. Set `DITA_OT_API_KEY` to a strong random secret in Railway's environment variables
4. Railway builds the Docker image and exposes an HTTPS URL
5. In the main application's Admin Settings → DITA-OT, enter: `https://<your-service>.up.railway.app`
6. In the Supabase edge function secrets, set `DITA_OT_API_KEY` to the same value (so the `run-dita-ot` function can authenticate against this worker)

## Request Format

```
POST /convert?format=pdf&ditaval=filter.ditaval
Authorization: Bearer <DITA_OT_API_KEY>
Content-Type: multipart/form-data

file: <ZIP containing map.ditamap, topic files, optional filter.ditaval>
```

## Response

- `html5` → `application/zip`
- `pdf` → `application/pdf` (or `application/zip` if multiple PDFs)
- `epub` → `application/epub+zip`
