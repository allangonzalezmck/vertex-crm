# Vertex CRM — Master Deployment Guide
## Complete Production Package | GitHub Setup | Day 1 Verification

**Version:** 1.0.0  
**Status:** PRODUCTION READY  
**Last Updated:** 2026-07-21  
**Total Files:** 12 artifacts  
**Timeline:** 90 minutes setup → deployment ready

---

## QUICK START (5 Minutes)

```bash
# 1. Clone/create GitHub repo
git clone https://github.com/YOUR-ORG/vertex-crm.git
cd vertex-crm

# 2. Copy all files from this package
# (See "File Organization" below)

# 3. Run verification
bash scripts/verify-setup.sh

# 4. Deploy
bash scripts/deploy-to-gcp.sh
```

---

## FILE ORGANIZATION

This package includes **12 production-ready files**:

### **Core Files (In This Directory)**
```
/
├── 00-MASTER_DEPLOYMENT_GUIDE.md          (THIS FILE)
├── 01-GITHUB_SETUP_GUIDE.md               (GitHub CLI instructions)
├── 02-FRONTEND_PROJECT_TEMPLATE.md        (Next.js project structure)
├── 03-GCP_DEPLOYMENT_SCRIPTS.sh           (Automated deployment)
├── 04-MONITORING_DASHBOARD_CONFIG.json    (Cloud Monitoring)
├── 05-VERIFICATION_CHECKLIST.md           (Day 1 testing)
├── 06-INTEROPERABILITY_TEST_SUITE.md      (Full system tests)
└── 07-TROUBLESHOOTING_GUIDE.md            (Common issues + fixes)
```

### **Backend Files (Already in vertex-crm repo)**
```
services/
├── api-gateway/                           ✅ DEPLOYED
├── workflow-engine/                       ✅ DEPLOYED
├── notification-service/                  ✅ DEPLOYED
├── billing-service/                       ❌ SKIP (Phase 2)
├── crm-service/                           ✅ READY
├── marketing-intelligence/                ✅ READY
├── ai-sales-agent/                        ❌ SKIP (Phase 2)
└── embedding-service/                     ❌ SKIP (Phase 2)
```

### **Frontend Files (To Create)**
```
vertex-crm-web/
├── src/
│   ├── app/
│   ├── components/
│   ├── lib/
│   ├── hooks/
│   ├── types/
│   └── styles/
├── public/
├── Dockerfile
├── docker-compose.yml
├── next.config.js
├── tailwind.config.ts
├── tsconfig.json
└── package.json
```

### **Deployment Files (To Create)**
```
infrastructure/
├── scripts/
│   ├── verify-setup.sh                    (Pre-deployment checks)
│   ├── deploy-to-gcp.sh                   (Automated GCP deploy)
│   ├── create-static-ip.sh                (IP setup)
│   ├── setup-load-balancer.sh             (LB config)
│   ├── setup-dns.sh                       (DNS records)
│   └── rollback.sh                        (Emergency rollback)
├── terraform/
│   └── production.tfvars                  (Already exists)
├── monitoring/
│   ├── dashboards.json                    (Cloud Monitoring)
│   └── alerts.yaml                        (Alert policies)
└── config/
    ├── dockerfile.nextjs                  (Frontend container)
    └── cloud-run-config.yaml              (Cloud Run settings)
```

---

## STEP 1: GitHub Setup (10 Minutes)

**See: `01-GITHUB_SETUP_GUIDE.md`**

Quick summary:
```bash
# Initialize repo structure
git init vertex-crm
cd vertex-crm

# Add remote
git remote add origin https://github.com/YOUR-ORG/vertex-crm.git

# Copy all files from this package
cp -r ../deployment-files/* .

# Create branch for frontend
git checkout -b feature/frontend-deployment

# Commit
git add .
git commit -m "feat: Add complete Next.js frontend + deployment scripts"

# Push
git push -u origin feature/frontend-deployment
```

---

## STEP 2: Create Frontend Project (30 Minutes)

**See: `02-FRONTEND_PROJECT_TEMPLATE.md`**

```bash
# Create frontend directory
mkdir -p vertex-crm-web
cd vertex-crm-web

# Initialize Next.js (use template from guide)
npx create-next-app@latest . \
  --typescript \
  --tailwind \
  --eslint \
  --src-dir \
  --app

# Copy provided files
cp -r ../templates/next-js-app/* .

# Install dependencies
npm install

# Verify it builds
npm run build

# Test locally
npm run dev
# Visit: http://localhost:3000
```

---

## STEP 3: Setup GCP Deployment (20 Minutes)

**See: `03-GCP_DEPLOYMENT_SCRIPTS.sh`**

```bash
# Set environment variables
export PROJECT_ID=vertex-crm-production
export REGION=us-central1
export DOMAIN=vertex-crm.yourdomain.com

# Run deployment script
bash scripts/deploy-to-gcp.sh

# Script will:
# ✅ Create static IP
# ✅ Setup load balancer
# ✅ Configure DNS
# ✅ Build + push Docker image
# ✅ Deploy to Cloud Run
# ✅ Setup monitoring
```

---

## STEP 4: Verify Everything Works (20 Minutes)

**See: `05-VERIFICATION_CHECKLIST.md`**

```bash
# Run verification suite
bash scripts/verify-setup.sh

# This checks:
# ✅ Static IP is allocated
# ✅ Load Balancer is responding
# ✅ SSL certificate is valid
# ✅ DNS resolves correctly
# ✅ Frontend loads
# ✅ Backend APIs respond
# ✅ Dashboards render data
# ✅ Authentication works
```

---

## STEP 5: Run Full Integration Tests (10 Minutes)

**See: `06-INTEROPERABILITY_TEST_SUITE.md`**

```bash
# Run complete test suite
npm run test:integration

# Tests verify:
# ✅ Frontend ↔ Backend communication
# ✅ Database connections
# ✅ AUTH workflows
# ✅ CRM data flows
# ✅ META data sync
# ✅ Error handling
# ✅ Load balancing
# ✅ SSL/HTTPS
```

---

## TIMELINE: Day 1 Deployment

```
09:00 - 09:10   GitHub Setup (10 min)
09:10 - 09:40   Frontend Project (30 min)
09:40 - 10:00   GCP Deployment (20 min)
10:00 - 10:20   Verification (20 min)
10:20 - 10:30   Integration Tests (10 min)
10:30 - 11:00   Buffer/Troubleshooting (30 min)

TOTAL: ~2 hours to production deployment ✅
```

---

## KEY DECISIONS MADE

### **Frontend: Next.js 14**
- ✅ Full-stack (easier deployment)
- ✅ Server components (data fetching)
- ✅ Built-in API routes
- ✅ Auto-scaling friendly

### **Deployment: Cloud Run**
- ✅ Serverless (no VM management)
- ✅ Auto-scaling (handles 1000s of users)
- ✅ Pay per request
- ✅ Easy rollback

### **Infrastructure: Load Balancer + Static IP**
- ✅ Global SSL termination
- ✅ Custom domain support
- ✅ DDoS protection
- ✅ Multi-region ready

### **Auth: Local JWT (Phase 1)**
- ✅ 2-3 hardcoded users for testing
- ✅ JWT tokens in localStorage
- ✅ Secure credentials in env vars
- ✅ Easy to upgrade to multi-user later

### **Monitoring: Cloud Monitoring**
- ✅ Real-time dashboards
- ✅ Alert policies
- ✅ Log aggregation
- ✅ Performance metrics

---

## PRE-DEPLOYMENT CHECKLIST

### **Before Running Deployment**

- [ ] GitHub repo created
- [ ] GCP project with billing enabled
- [ ] Cloud SQL database deployed (should already exist)
- [ ] Redis instance created (should already exist)
- [ ] Service account created (with appropriate roles)
- [ ] Domain registered at GoDaddy/similar
- [ ] SSL certificate ready or plan to use Let's Encrypt
- [ ] 2-3 test META business accounts available
- [ ] Terraform state is accessible

### **Environment Variables Prepared**

```bash
# Set these before deployment
export PROJECT_ID=vertex-crm-production
export REGION=us-central1
export DOMAIN=vertex-crm.yourdomain.com
export GITHUB_TOKEN=ghp_xxxxx  # For GitHub Actions
export GCP_SERVICE_ACCOUNT_KEY=/path/to/key.json
```

---

## POST-DEPLOYMENT CHECKLIST

### **After Deployment**

- [ ] Static IP is allocated and visible in GCP Console
- [ ] Load Balancer is created and healthy
- [ ] SSL certificate is active
- [ ] DNS records point to static IP
- [ ] Frontend loads at custom domain
- [ ] Login page displays correctly
- [ ] CRM dashboards show data
- [ ] META dashboards show data
- [ ] No console errors in browser
- [ ] No errors in Cloud Logging
- [ ] Health checks pass
- [ ] Monitoring dashboards show metrics
- [ ] Alert policies are active

---

## DEPLOYMENT FLOW DIAGRAM

```
┌─────────────────────────────────────────────────────────────┐
│ Day 1 Deployment Flow                                       │
└─────────────────────────────────────────────────────────────┘

1. GITHUB SETUP
   ├─ Create repository
   ├─ Add all files
   └─ Create feature branch

2. FRONTEND PROJECT
   ├─ Initialize Next.js
   ├─ Copy components
   ├─ Install dependencies
   └─ Test locally (npm run dev)

3. GCP DEPLOYMENT
   ├─ Create Static IP
   ├─ Create Load Balancer
   ├─ Configure SSL
   ├─ Setup DNS
   ├─ Build Docker image
   ├─ Push to Artifact Registry
   └─ Deploy to Cloud Run

4. VERIFICATION
   ├─ Test Static IP
   ├─ Test Load Balancer
   ├─ Test SSL Certificate
   ├─ Test DNS Resolution
   ├─ Test Frontend Loading
   ├─ Test Backend APIs
   └─ Test Dashboards

5. INTEGRATION TESTS
   ├─ Test Frontend ↔ Backend
   ├─ Test Authentication
   ├─ Test CRM Data Flows
   ├─ Test META Integration
   ├─ Test Error Handling
   └─ Test Performance

6. PRODUCTION READY ✅
   └─ System is live and monitoring
```

---

## DISASTER RECOVERY

### **If Deployment Fails**

**Quick Rollback:**
```bash
bash scripts/rollback.sh
```

**Manual Rollback:**
```bash
# Revert to previous deployment
gcloud run services update-traffic vertex-crm-web \
  --to-revisions=PREVIOUS_REVISION=100 \
  --region=us-central1

# Or redeploy previous image
bash scripts/deploy-to-gcp.sh --version=v1.0.0-previous
```

---

## SUPPORT FILES

| File | Purpose |
|------|---------|
| `01-GITHUB_SETUP_GUIDE.md` | Complete GitHub CLI instructions |
| `02-FRONTEND_PROJECT_TEMPLATE.md` | Next.js project template + code |
| `03-GCP_DEPLOYMENT_SCRIPTS.sh` | Automated deployment script |
| `04-MONITORING_DASHBOARD_CONFIG.json` | Cloud Monitoring config |
| `05-VERIFICATION_CHECKLIST.md` | Step-by-step verification |
| `06-INTEROPERABILITY_TEST_SUITE.md` | Full integration tests |
| `07-TROUBLESHOOTING_GUIDE.md` | Common issues + solutions |

---

## NEXT STEPS

1. **Read this file completely** (you are here)
2. **Follow `01-GITHUB_SETUP_GUIDE.md`** → Create GitHub repo
3. **Follow `02-FRONTEND_PROJECT_TEMPLATE.md`** → Create frontend
4. **Run `03-GCP_DEPLOYMENT_SCRIPTS.sh`** → Deploy to GCP
5. **Complete `05-VERIFICATION_CHECKLIST.md`** → Verify everything
6. **Run `06-INTEROPERABILITY_TEST_SUITE.md`** → Full integration tests

---

## SUPPORT

**Questions during deployment?**
- Check `07-TROUBLESHOOTING_GUIDE.md` first
- All scripts include error messages
- Cloud Logging shows detailed errors
- Monitoring dashboard shows real-time status

**Everything working?**
- ✅ Celebrate! You have a production CRM system
- ✅ Monitor dashboards daily
- ✅ Plan Phase 2: AI features + billing

---

## TIMELINE SUMMARY

| Phase | Duration | Status |
|-------|----------|--------|
| GitHub Setup | 10 min | Before deployment |
| Frontend Creation | 30 min | Before deployment |
| GCP Deployment | 20 min | Automated script |
| Verification | 20 min | Automated checks |
| Integration Tests | 10 min | Automated tests |
| **TOTAL** | **~90 min** | ✅ Live |

---

**You're ready! Start with `01-GITHUB_SETUP_GUIDE.md` →**
