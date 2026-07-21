# Troubleshooting Guide
## Common Issues & Solutions for Vertex CRM Deployment

**Scope:** Infrastructure, deployment, frontend, backend integration  
**Last Updated:** 2026-07-21  
**Coverage:** 20+ common issues

---

## DEPLOYMENT ISSUES

### Issue: "gcloud: command not found"

**Symptoms:** Deployment script fails immediately

**Solution:**
```bash
# Install Google Cloud SDK
# macOS
brew install --cask google-cloud-sdk

# Linux
curl https://sdk.cloud.google.com | bash

# Verify installation
gcloud --version

# Initialize
gcloud init
gcloud auth login
gcloud config set project vertex-crm-production
```

---

### Issue: "Docker: permission denied"

**Symptoms:** "Got permission denied while trying to connect to Docker daemon"

**Solution:**
```bash
# Add your user to docker group
sudo usermod -aG docker $USER

# Apply group changes
newgrp docker

# Verify
docker ps

# If still failing, restart Docker
sudo systemctl restart docker
```

---

### Issue: "Artifact Registry push fails"

**Symptoms:** "denied: User does not have IAM permission"

**Solution:**
```bash
# Ensure service account has proper permissions
gcloud projects add-iam-policy-binding vertex-crm-production \
  --member=serviceAccount:YOUR_SA@vertex-crm-production.iam.gserviceaccount.com \
  --role=roles/artifactregistry.writer

# Reconfigure docker auth
gcloud auth configure-docker us-central1-docker.pkg.dev

# Retry push
docker push us-central1-docker.pkg.dev/vertex-crm-production/vertex-crm/vertex-crm-web:v1.0.0
```

---

### Issue: "Cloud Run deployment times out"

**Symptoms:** Deployment hangs or fails after 30+ minutes

**Solution:**
```bash
# Check Docker image size (should be < 500MB)
docker images | grep vertex-crm-web

# If too large, optimize Dockerfile:
# 1. Use Alpine base image
# 2. Remove dev dependencies
# 3. Use multi-stage builds

# Rebuild with --no-cache
docker build --no-cache -t vertex-crm-web:v1.0.0 .

# Check build logs
gcloud builds log BUILD_ID --stream

# Increase timeout
gcloud run deploy vertex-crm-web \
  --timeout=3600 \  # 1 hour
  --region=us-central1 \
  ...
```

---

### Issue: "Static IP creation fails"

**Symptoms:** "error: (gcloud.compute.addresses.create) Could not fetch resource"

**Solution:**
```bash
# Ensure quota available
gcloud compute project-info describe --project=vertex-crm-production \
  | grep -A 5 QUOTA

# If quota exceeded, request increase:
# 1. Go to GCP Console
# 2. Quotas & System Limits
# 3. Search "Global internal addresses"
# 4. Request increase

# Delete unused IPs to free quota
gcloud compute addresses list --global
gcloud compute addresses delete OLD_IP --global
```

---

## FRONTEND ISSUES

### Issue: "Frontend shows blank page"

**Symptoms:** Browser loads but page is empty or white

**Solution:**
```bash
# Check browser console (F12)
# Look for JavaScript errors

# Verify environment variables
gcloud run services describe vertex-crm-web \
  --platform=managed \
  --region=us-central1 \
  --format="value(spec.template.spec.containers[0].env[*].name)"

# Check if NEXT_PUBLIC_API_URL is set
gcloud run services describe vertex-crm-web \
  --platform=managed \
  --region=us-central1 \
  --format="value(spec.template.spec.containers[0].env)" | grep NEXT_PUBLIC_API_URL

# If missing, update service
gcloud run deploy vertex-crm-web \
  --set-env-vars="NEXT_PUBLIC_API_URL=https://api.vertex-crm.yourdomain.com" \
  --region=us-central1
```

---

### Issue: "Login page shows but login fails"

**Symptoms:** Can reach login page, but credentials don't work

**Solution:**
```bash
# Test backend auth endpoint directly
curl -X POST https://api.vertex-crm.yourdomain.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"demo","password":"demo123"}'

# If fails:
# 1. Check backend logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=api-gateway" \
  --limit=20

# 2. Verify backend is running
gcloud run services describe api-gateway --region=us-central1

# 3. Check if auth service is deployed
gcloud run services list --region=us-central1
```

---

### Issue: "Styling broken or unstyled elements"

**Symptoms:** Tailwind CSS not applied, elements look unstyled

**Solution:**
```bash
# Build Tailwind CSS
npm run build

# Verify CSS file is generated
ls -la .next/static/css/

# Check if styles are included in HTML
# DevTools → Elements → Head section
# Should see <link rel="stylesheet" href="/_next/static/css/..."

# If not included, rebuild
rm -rf .next
npm run build

# Redeploy
gcloud run deploy vertex-crm-web \
  --image=us-central1-docker.pkg.dev/vertex-crm-production/vertex-crm/vertex-crm-web:v1.0.0 \
  --region=us-central1
```

---

### Issue: "Dashboard loads but shows no data"

**Symptoms:** Page loads fine but all data is empty/missing

**Solution:**
```bash
# Check if backend API is reachable
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://api.vertex-crm.yourdomain.com/api/v1/leads

# If fails:
# 1. Verify backend service is running
gcloud run services describe crm-service --region=us-central1

# 2. Check backend logs
gcloud logging read "resource.labels.service_name=crm-service" --limit=20

# 3. Check database connection
gcloud sql instances describe vertex-crm-db

# 4. Check if database has data
# Connect via Cloud SQL Proxy and query
gcloud sql connect vertex-crm-db --user=postgres

# Inside psql:
# \dt  -- list tables
# SELECT COUNT(*) FROM leads;  -- check data
```

---

### Issue: "Images/assets not loading"

**Symptoms:** 404 errors for images in console

**Solution:**
```bash
# Verify static files in public/ directory
ls -la public/

# Check if files were copied to Docker image
docker run -it vertex-crm-web:v1.0.0 ls -la /app/public/

# If missing, rebuild Dockerfile:
# Ensure public directory is copied
# COPY public ./public

# Test locally
npm run dev
# Visit http://localhost:3000/[image-path]
```

---

## BACKEND INTEGRATION ISSUES

### Issue: "CORS errors in browser console"

**Symptoms:** "Access to XMLHttpRequest at '...' has been blocked by CORS policy"

**Solution:**
```bash
# Check backend CORS configuration
# Look for CORS headers in response
curl -H "Origin: https://vertex-crm.yourdomain.com" \
  https://api.vertex-crm.yourdomain.com/api/v1/leads \
  -H "Authorization: Bearer TOKEN" -v

# Should see:
# Access-Control-Allow-Origin: *
# Access-Control-Allow-Methods: GET, POST, PUT, DELETE

# If missing, check backend CORS settings
# api-gateway should have CORS middleware enabled

# Restart backend services
gcloud run services list --region=us-central1 | grep -E "api-gateway|crm-service"
```

---

### Issue: "Authentication token invalid or expired"

**Symptoms:** "401 Unauthorized" errors, redirect to login

**Solution:**
```bash
# Token expired?
# Tokens expire based on backend configuration
# Check token expiry
# DevTools → Application → localStorage → auth_token

# Decode token (paste at jwt.io)
# Check "exp" claim

# Solution: Login again to get fresh token

# For development, check backend token TTL
# Look for JWT configuration in environment
gcloud run services describe api-gateway \
  --platform=managed \
  --region=us-central1 \
  --format="value(spec.template.spec.containers[0].env[*].name)" | grep -i token
```

---

### Issue: "Database connection refused"

**Symptoms:** "Error: connect ECONNREFUSED 127.0.0.1:5432"

**Solution:**
```bash
# Check Cloud SQL instance status
gcloud sql instances describe vertex-crm-db

# Should show: STATUS: RUNNABLE

# If not running:
gcloud sql instances patch vertex-crm-db --backup-start-time=03:00

# Check connection string
gcloud sql instances describe vertex-crm-db \
  --format="value(connectionName)"

# Use Cloud SQL Proxy to test connection
cloud-sql-proxy --instances=PROJECT_ID:REGION:INSTANCE_NAME=tcp:5432 &

# Connect locally
psql -h 127.0.0.1 -U postgres -d vertex-crm
```

---

## INFRASTRUCTURE ISSUES

### Issue: "DNS not resolving"

**Symptoms:** "Cannot reach vertex-crm.yourdomain.com"

**Solution:**
```bash
# Test DNS resolution
nslookup vertex-crm.yourdomain.com

# Check current DNS settings
dig vertex-crm.yourdomain.com

# If not resolving:
# 1. Wait 15-30 minutes for DNS propagation
# 2. Verify DNS record in GoDaddy/registrar
# 3. Check nameservers are correct
nslookup -type=NS yourdomain.com

# Flush DNS cache (macOS)
sudo dscacheutil -flushcache

# Or use Google DNS directly
nslookup vertex-crm.yourdomain.com 8.8.8.8
```

---

### Issue: "SSL certificate errors"

**Symptoms:** Browser shows "Your connection is not private" or certificate warnings

**Solution:**
```bash
# Check certificate validity
gcloud compute ssl-certificates describe vertex-crm-cert \
  --project=vertex-crm-production

# Check certificate details
openssl s_client -connect vertex-crm.yourdomain.com:443 -showcerts

# If expired, renew certificate:
# 1. Get new certificate from Let's Encrypt or your provider
# 2. Upload to GCP
gcloud compute ssl-certificates create vertex-crm-cert-new \
  --cert-file=path/to/fullchain.pem \
  --key-file=path/to/privkey.pem

# Update load balancer to use new cert
# (via GCP Console or gcloud)
```

---

### Issue: "Load Balancer not routing traffic"

**Symptoms:** Requests timeout or 503 Service Unavailable

**Solution:**
```bash
# Check backend service health
gcloud compute backend-services get-health vertex-crm-backend \
  --global

# If UNHEALTHY:
# 1. Check Cloud Run service status
gcloud run services describe vertex-crm-web --region=us-central1

# 2. Check instance health
gcloud compute backend-services get-health vertex-crm-backend \
  --global \
  --format="table(status,instance)"

# 3. If instances unhealthy, they may be misconfigured
# Rebuild and redeploy service

# 4. Check firewall rules
gcloud compute firewall-rules list --filter="name:vertex-crm"
```

---

## MONITORING & LOGGING ISSUES

### Issue: "No logs appearing in Cloud Logging"

**Symptoms:** "No results found" when querying logs

**Solution:**
```bash
# Check service is running
gcloud run services describe vertex-crm-web --region=us-central1 | grep status

# Check log sink configuration
gcloud logging sinks list

# View recent logs (any service)
gcloud logging read "severity>=WARNING" --limit=20

# View logs for specific service
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=vertex-crm-web" \
  --limit=50 \
  --format=json

# Enable logging in Next.js
# Add to next.config.js:
# env: {
#   LOG_LEVEL: 'debug'
# }
```

---

### Issue: "Monitoring dashboard empty"

**Symptoms:** Dashboard created but no metrics showing

**Solution:**
```bash
# Wait 5-10 minutes for metrics to appear
# (Cloud Monitoring needs time to collect initial data)

# Verify metrics are being collected
gcloud monitoring time-series list \
  --filter='metric.type="cloud.googleapis.com/run/request_count"'

# If no metrics:
# 1. Ensure Cloud Run service is receiving traffic
# 2. Check if monitoring agent is running
# 3. Verify permissions to create dashboards

# Manually trigger some traffic
curl -v https://vertex-crm.yourdomain.com
curl -v https://api.vertex-crm.yourdomain.com/health
```

---

## PERFORMANCE ISSUES

### Issue: "Slow page load times"

**Symptoms:** Website takes 5+ seconds to load

**Solution:**
```bash
# Measure load time
curl -w "Total: %{time_total}s\n" -o /dev/null -s https://vertex-crm.yourdomain.com

# Check where time is spent (DevTools)
# F12 → Network → reload page
# Look for slow requests

# Common culprits:
# 1. API responses slow
#    → Check backend service performance
#    → Check database query performance

# 2. Large bundle size
#    → Check if bundle is minified
#    → Use next/image for images
#    → Code split with dynamic imports

# 3. Network latency
#    → Check browser location vs GCP region
#    → Consider adding Cloud CDN

# Enable Cloud CDN
gcloud compute backend-services update vertex-crm-backend \
  --enable-cdn \
  --global
```

---

### Issue: "High memory usage"

**Symptoms:** Cloud Run instance kills processes, "Out of memory"

**Solution:**
```bash
# Check current memory allocation
gcloud run services describe vertex-crm-web \
  --platform=managed \
  --region=us-central1 \
  --format="value(spec.template.spec.containers[0].resources.limits.memory)"

# Increase if needed
gcloud run deploy vertex-crm-web \
  --memory=1Gi \  # Increase from 512Mi to 1Gi
  --region=us-central1

# Check memory usage in logs
gcloud logging read "resource.type=cloud_run_revision" \
  --limit=20 \
  | grep -i memory

# Memory optimization tips:
# 1. Use production build (npm run build)
# 2. Remove unused dependencies
# 3. Optimize images
# 4. Enable compression in Next.js
```

---

### Issue: "High CPU usage"

**Symptoms:** Slow response times, 99% CPU in metrics

**Solution:**
```bash
# Increase CPU allocation
gcloud run deploy vertex-crm-web \
  --cpu=2 \  # Increase from 1 to 2
  --region=us-central1

# Check if database queries are slow
# Profile database:
gcloud sql instances describe vertex-crm-db \
  --format="value(currentDiskSize)"

# Optimize slow queries
# 1. Add indexes on frequently queried columns
# 2. Pagination for large result sets
# 3. Use prepared statements

# Check for infinite loops or memory leaks
# Review recent code changes
git log --oneline -10
```

---

## SECURITY ISSUES

### Issue: "Exposed API keys or secrets"

**Symptoms:** Credentials visible in logs or frontend

**Solution:**
```bash
# Immediately rotate exposed keys
gcloud sql users set-password postgres --instance=vertex-crm-db --password

# Regenerate API tokens
# (Depends on your backend auth system)

# Remove secrets from repository
git rm --cached .env
echo ".env" >> .gitignore
git commit -m "Remove .env file"

# Use GCP Secret Manager for secrets
gcloud secrets create db-password --data-file=- << EOF
your-secure-password
EOF

# Reference in Cloud Run
gcloud run deploy vertex-crm-web \
  --set-secrets="DB_PASSWORD=db-password:latest" \
  --region=us-central1

# Scan git history for exposed secrets
git log -p --all -S "password\|secret\|key" > /tmp/secrets.log

# Review and clean up if necessary
```

---

### Issue: "HTTPS/SSL not enforced"

**Symptoms:** Can access site over HTTP (insecure)

**Solution:**
```bash
# Create HTTP to HTTPS redirect
gcloud compute url-maps create vertex-crm-https-redirect \
  --default-service=vertex-crm-backend

# Create HTTP proxy
gcloud compute target-http-proxies create vertex-crm-http-proxy \
  --url-map=vertex-crm-https-redirect

# Add redirect rule
gcloud compute forwarding-rules create vertex-crm-http-rule \
  --global \
  --target-http-proxy=vertex-crm-http-proxy \
  --address=vertex-crm-ip \
  --ports=80

# Test redirect
curl -i http://vertex-crm.yourdomain.com/
# Should return 301 to https://
```

---

## SUPPORT & ESCALATION

### When to escalate to GCP Support:

1. **Infrastructure issues beyond scripts**
   - Network connectivity problems
   - Quota limit issues requiring exceptions
   - GCP service outages

2. **Data loss or corruption**
   - Database recovery needed
   - Unexpected data deletion

3. **Security incidents**
   - Suspected unauthorized access
   - DDoS attacks

### How to escalate:

```bash
# Create support case via GCP Console
# Console → Support → Create Ticket

# Or use gcloud
gcloud support tickets create \
  --description="Issue description" \
  --severity=P1  # P1=Critical, P4=Low
```

---

## QUICK REFERENCE: Common Commands

```bash
# View service status
gcloud run services describe SERVICE_NAME --region=us-central1

# View recent logs
gcloud logging read "resource.type=cloud_run_revision" --limit=20

# Deploy service
gcloud run deploy SERVICE_NAME --image=IMAGE_URL --region=us-central1

# Rollback deployment
gcloud run services update-traffic SERVICE_NAME --to-revisions=REVISION_ID=100

# Connect to database
gcloud sql connect vertex-crm-db --user=postgres

# View project quota
gcloud compute project-info describe --project=$PROJECT_ID | grep QUOTA

# Check service logs
gcloud logging read "resource.labels.service_name=SERVICE_NAME" --limit=50
```

---

## DOCUMENTATION LINKS

- [GCP Cloud Run Docs](https://cloud.google.com/run/docs)
- [Cloud SQL Troubleshooting](https://cloud.google.com/sql/docs/postgres/troubleshooting-connection-issues)
- [Cloud Logging Docs](https://cloud.google.com/logging/docs)
- [Next.js Deployment](https://nextjs.org/docs/deployment)

---

**Can't find your issue?**  
→ Contact support with logs from:
```bash
gcloud logging read --limit=100 --format=json > /tmp/logs.json
```

Include this file when requesting help!
