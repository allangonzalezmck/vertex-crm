# Day 1 Verification Checklist
## Complete System Testing & Validation

**Duration:** 20 minutes  
**Prerequisites:** Deployment completed (scripts ran successfully)  
**Outcome:** Verified production system ready for testing

---

## PHASE 1: Infrastructure Verification (5 Minutes)

### ✅ Static IP Allocated

```bash
# Verify static IP exists and is assigned
gcloud compute addresses describe vertex-crm-ip \
  --global \
  --project=$PROJECT_ID

# Expected output should show:
# address: <IP_ADDRESS>
# status: IN_USE
```

**Pass/Fail:** ☐ PASS ☐ FAIL

### ✅ Cloud Run Service Deployed

```bash
# Check service status
gcloud run services describe vertex-crm-web \
  --platform=managed \
  --region=us-central1 \
  --project=$PROJECT_ID

# Expected: Service should be ready
```

**Pass/Fail:** ☐ PASS ☐ FAIL

### ✅ Service URL Accessible

```bash
# Get service URL
SERVICE_URL=$(gcloud run services describe vertex-crm-web \
  --platform=managed \
  --region=us-central1 \
  --project=$PROJECT_ID \
  --format='value(status.url)')

# Test endpoint
curl -v $SERVICE_URL

# Expected: HTTP 302 (redirect to login) or 200 (page loads)
```

**Pass/Fail:** ☐ PASS ☐ FAIL

### ✅ Docker Image in Registry

```bash
# Verify image exists
gcloud artifacts docker images describe \
  us-central1-docker.pkg.dev/$PROJECT_ID/vertex-crm/vertex-crm-web:v1.0.0 \
  --project=$PROJECT_ID

# Expected: Image found with all layers intact
```

**Pass/Fail:** ☐ PASS ☐ FAIL

### ✅ Health Check Passing

```bash
# Check load balancer health
gcloud compute backend-services get-health vertex-crm-backend \
  --global \
  --project=$PROJECT_ID

# Expected: All instances HEALTHY
```

**Pass/Fail:** ☐ PASS ☐ FAIL

---

## PHASE 2: Frontend Verification (5 Minutes)

### ✅ Login Page Loads

```bash
# Visit frontend
SERVICE_URL=$(gcloud run services describe vertex-crm-web \
  --platform=managed \
  --region=us-central1 \
  --project=$PROJECT_ID \
  --format='value(status.url)')

echo "Visit: $SERVICE_URL"
```

**Manual Test:**
1. Open browser to service URL
2. Verify login page displays
3. Check for styling (Tailwind CSS applied)
4. Verify no console errors (F12 → Console)

**Pass/Fail:** ☐ PASS ☐ FAIL

### ✅ Authentication Works

```bash
# Test login endpoint
curl -X POST $SERVICE_URL/api/auth \
  -H "Content-Type: application/json" \
  -d '{"username":"demo","password":"demo123"}'

# Expected: JSON response with auth token
```

**Manual Test:**
1. Click login form
2. Enter: username=demo, password=demo123
3. Click Submit
4. Verify redirects to dashboard

**Pass/Fail:** ☐ PASS ☐ FAIL

### ✅ Dashboard Loads

```bash
# After login, verify you can access:
# - Dashboard home page
# - CRM dashboards (Leads, Deals, Contacts)
# - META dashboards (Analytics, Campaigns)
```

**Manual Test:**
1. After successful login
2. Dashboard should display
3. Navigation sidebar should work
4. Click each dashboard item

**Pass/Fail:** ☐ PASS ☐ FAIL

### ✅ Styling & Responsive Design

**Manual Test:**
1. Check styling appears correct (no unstyled elements)
2. Test responsive design (resize browser)
3. Verify mobile view works
4. Check dark mode support (if implemented)

**Pass/Fail:** ☐ PASS ☐ FAIL

---

## PHASE 3: Backend Integration (5 Minutes)

### ✅ Backend API Accessible

```bash
# From frontend, check if backend is reachable
# This would be done via frontend tests

# Verify backend service URL
echo $NEXT_PUBLIC_API_URL
# Expected: https://api.vertex-crm.yourdomain.com (or http://localhost:8000 in dev)
```

**Pass/Fail:** ☐ PASS ☐ FAIL

### ✅ CRM Data Loads

**Manual Test:**
1. Navigate to CRM → Leads
2. Verify leads list loads (even if empty)
3. Try to create a new lead
4. Verify form submits
5. Check new lead appears in list

**Pass/Fail:** ☐ PASS ☐ FAIL

### ✅ Database Connection Works

```bash
# Check Cloud SQL connection
gcloud sql instances describe vertex-crm-db \
  --project=$PROJECT_ID

# Expected: Instance should be RUNNABLE
```

**Pass/Fail:** ☐ PASS ☐ FAIL

### ✅ META Integration Ready

**Manual Test:**
1. Navigate to META section
2. Verify page loads (may show no data initially)
3. Check for data loading indicators
4. Verify no errors in console

**Pass/Fail:** ☐ PASS ☐ FAIL

---

## PHASE 4: Error Handling & Edge Cases (3 Minutes)

### ✅ Invalid Login Rejected

```bash
# Test with wrong credentials
curl -X POST $SERVICE_URL/api/auth \
  -H "Content-Type: application/json" \
  -d '{"username":"invalid","password":"wrong"}'

# Expected: 401 Unauthorized with error message
```

**Manual Test:**
1. Try login with wrong credentials
2. Verify error message displays
3. Verify still on login page

**Pass/Fail:** ☐ PASS ☐ FAIL

### ✅ Session Timeout Handled

**Manual Test:**
1. Login and let session expire (if configured)
2. Try to access protected page
3. Verify redirected to login
4. Check error message is user-friendly

**Pass/Fail:** ☐ PASS ☐ FAIL

### ✅ 404 Pages Work

**Manual Test:**
1. Navigate to non-existent URL (e.g., /nonexistent)
2. Verify 404 page displays
3. Verify can navigate back via links

**Pass/Fail:** ☐ PASS ☐ FAIL

### ✅ Network Error Handling

**Manual Test:**
1. Disconnect network (toggle offline mode in DevTools)
2. Try to load data
3. Verify error message (not broken state)
4. Reconnect and verify recovery

**Pass/Fail:** ☐ PASS ☐ FAIL

---

## PHASE 5: Performance & Monitoring (2 Minutes)

### ✅ Page Load Time Acceptable

```bash
# Measure performance
curl -w "Time: %{time_total}s\n" \
  -o /dev/null -s $SERVICE_URL

# Expected: < 2 seconds
```

**Manual Test:**
1. Open DevTools → Network tab
2. Reload page
3. Check: Largest Contentful Paint (LCP) < 2.5s
4. Check: First Input Delay (FID) < 100ms

**Pass/Fail:** ☐ PASS ☐ FAIL

### ✅ Monitoring Dashboards Visible

```bash
# Check Cloud Monitoring
gcloud monitoring dashboards list --project=$PROJECT_ID

# Expected: vertex-crm dashboard should be listed
```

**Manual Test:**
1. Go to GCP Cloud Console
2. Navigate to Monitoring → Dashboards
3. Find "vertex-crm" dashboard
4. Verify it shows metrics

**Pass/Fail:** ☐ PASS ☐ FAIL

### ✅ Logging Working

```bash
# Check logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=vertex-crm-web" \
  --limit=10 \
  --format=json \
  --project=$PROJECT_ID

# Expected: Recent log entries should appear
```

**Pass/Fail:** ☐ PASS ☐ FAIL

---

## PHASE 6: Security Verification (2 Minutes)

### ✅ HTTPS/SSL Working (when configured)

```bash
# Test HTTPS
curl -v https://$DOMAIN

# Expected: 200 OK with valid certificate
```

**Manual Test:**
1. Check browser security indicator (🔒)
2. Click to view certificate details
3. Verify certificate is valid

**Pass/Fail:** ☐ PASS ☐ FAIL

### ✅ Security Headers Present

```bash
# Check security headers
curl -v $SERVICE_URL -I | grep -E "X-Frame-Options|X-Content-Type|Referrer-Policy"

# Expected: Headers should be present
```

**Pass/Fail:** ☐ PASS ☐ FAIL

### ✅ No Sensitive Data in Console

```bash
# Check frontend console
# DevTools F12 → Console
```

**Manual Test:**
1. Open DevTools Console (F12)
2. Verify no auth tokens logged
3. Verify no API keys exposed
4. Verify no error stack traces

**Pass/Fail:** ☐ PASS ☐ FAIL

---

## AUTOMATED VERIFICATION SCRIPT

Run this script to automate many checks:

```bash
#!/bin/bash

PROJECT_ID=vertex-crm-production
REGION=us-central1
SERVICE_NAME=vertex-crm-web

echo "Running automated verification..."

# Get service URL
SERVICE_URL=$(gcloud run services describe $SERVICE_NAME \
  --platform=managed \
  --region=$REGION \
  --project=$PROJECT_ID \
  --format='value(status.url)')

echo "Service URL: $SERVICE_URL"

# Test endpoint
echo "Testing service endpoint..."
if curl -s -o /dev/null -w "%{http_code}" "$SERVICE_URL" | grep -q "302\|200\|401"; then
  echo "✓ Service responding"
else
  echo "✗ Service not responding"
fi

# Check Cloud Run status
echo "Checking Cloud Run service..."
gcloud run services describe $SERVICE_NAME \
  --platform=managed \
  --region=$REGION \
  --project=$PROJECT_ID \
  --format="table(status.conditions[0].reason)"

# Check logs
echo "Checking recent logs..."
gcloud logging read "resource.type=cloud_run_revision" \
  --limit=5 \
  --format="value(severity, jsonPayload.message)" \
  --project=$PROJECT_ID

# Check monitoring
echo "Checking monitoring dashboard..."
gcloud monitoring dashboards list --project=$PROJECT_ID

echo "Verification complete!"
```

---

## TROUBLESHOOTING

If any checks fail:

1. **Service not responding?**
   ```bash
   # Check logs for errors
   gcloud logging read "resource.type=cloud_run_revision" \
     --limit=50 \
     --format=json \
     --project=$PROJECT_ID
   ```

2. **Login not working?**
   - Check if backend API is accessible
   - Verify credentials (demo/demo123)
   - Check CORS headers

3. **Dashboards showing no data?**
   - Check if database has seed data
   - Verify backend services are running
   - Check API endpoints are returning data

4. **Styling broken?**
   - Verify Tailwind CSS built correctly
   - Check CSS files included in Docker image
   - Check for CSP headers blocking styles

---

## FINAL SIGN-OFF

Once all tests pass:

```
Date: _______________
Tester: _______________
Status: ☐ All Passed ☐ Some Failed (see notes)

Notes:
_________________________________________________________________

_________________________________________________________________

System Status: ☐ READY FOR PRODUCTION ☐ NEEDS FIXES
```

---

## NEXT STEPS

✅ All checks passed?
→ Continue to `06-INTEROPERABILITY_TEST_SUITE.md` for full integration tests

❌ Some checks failed?
→ See `07-TROUBLESHOOTING_GUIDE.md` for solutions

---

**Verification Complete!** 🎉
