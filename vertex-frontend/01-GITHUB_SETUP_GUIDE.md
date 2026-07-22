# GitHub Setup Guide
## Complete CLI Instructions for Vertex CRM Repository

**Duration:** 10 minutes  
**Prerequisites:** Git installed, GitHub account  
**Outcome:** Production-ready repository with all files

---

## STEP 1: Create GitHub Repository (2 Minutes)

### **Option A: Using GitHub Web UI (Easiest)**

1. Go to https://github.com/new
2. Fill in details:
   - **Repository name:** `vertex-crm`
   - **Description:** `Complete CRM system with META integration`
   - **Visibility:** Private (recommended)
   - **Add .gitignore:** Select "Node"
   - **License:** MIT

3. Click "Create repository"

### **Option B: Using GitHub CLI**

```bash
# Install GitHub CLI if not already installed
# macOS: brew install gh
# Linux: curl -fsSLo gh.sh https://cli.github.com/install.sh && sh gh.sh

# Login to GitHub
gh auth login

# Create repository
gh repo create vertex-crm \
  --private \
  --description="Complete CRM system with META integration" \
  --source=. \
  --remote=origin \
  --push
```

---

## STEP 2: Clone Repository Locally (2 Minutes)

```bash
# Option A: If creating new
mkdir ~/projects
cd ~/projects
git clone https://github.com/YOUR-ORG/vertex-crm.git
cd vertex-crm

# Option B: If repo already exists
cd ~/existing-vertex-crm-repo
git remote add origin https://github.com/YOUR-ORG/vertex-crm.git
git branch -M main
git push -u origin main
```

---

## STEP 3: Organize Repository Structure (3 Minutes)

```bash
# Create directory structure
mkdir -p vertex-crm-web/{src,public,scripts}
mkdir -p infrastructure/{scripts,terraform,monitoring,config}
mkdir -p services/{api-gateway,workflow-engine,notification-service,crm-service,marketing-intelligence}
mkdir -p .github/workflows
mkdir -p docs

# Create .gitignore (if not already present)
cat > .gitignore << 'EOF'
# Dependencies
node_modules/
.pnpm-lock.yaml
yarn.lock
package-lock.json

# Production
.next/
out/
build/
dist/

# Environment variables
.env
.env.local
.env.*.local
.env.production.local

# IDE
.vscode/
.idea/
*.swp
*.swo
*.sublime-project
*.sublime-workspace

# OS
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*
yarn-debug.log*

# Cache
.cache/
.eslintcache

# GCP
key.json
terraform.tfstate*
.terraform/

# Docker
.docker/
docker-compose.override.yml

# Testing
coverage/
.nyc_output/

# Misc
.turbo/
EOF

git add .gitignore
git commit -m "chore: add .gitignore"
```

---

## STEP 4: Add Backend Files (Already Exist)

```bash
# If backend services are already in your repo, verify structure
ls -la services/

# Expected output:
# services/
# ├── api-gateway/                ✅ Already deployed
# ├── workflow-engine/            ✅ Already deployed
# ├── notification-service/       ✅ Already deployed
# ├── crm-service/                ✅ Ready to deploy
# ├── marketing-intelligence/     ✅ Ready to deploy
# ├── billing-service/            ⏸️  Phase 2
# ├── ai-sales-agent/             ⏸️  Phase 2
# └── embedding-service/          ⏸️  Phase 2

# If not present, copy from your local vertex-crm directory
cp -r ~/vertex-crm/services ./

git add services/
git commit -m "feat: add backend microservices"
```

---

## STEP 5: Add Frontend Project (5 Minutes)

```bash
# Copy frontend template files (provided in this package)
cp -r ../vertex-crm-web-template/* ./vertex-crm-web/

# Verify structure
ls -la vertex-crm-web/
# Should show: src/, public/, scripts/, package.json, Dockerfile, etc.

# Stage files
git add vertex-crm-web/
git commit -m "feat: add Next.js frontend application"
```

---

## STEP 6: Add Deployment Scripts (2 Minutes)

```bash
# Copy deployment scripts (provided in this package)
cp -r ../deployment-scripts/* ./infrastructure/scripts/

# Make scripts executable
chmod +x infrastructure/scripts/*.sh

# Verify
ls -la infrastructure/scripts/
# Should show: deploy-to-gcp.sh, verify-setup.sh, etc.

git add infrastructure/scripts/
git commit -m "feat: add deployment and verification scripts"
```

---

## STEP 7: Add Configuration Files (1 Minute)

```bash
# Copy monitoring config
cp ../04-MONITORING_DASHBOARD_CONFIG.json ./infrastructure/monitoring/

# Copy documentation
cp ../VERTEX_CRM_COMPLETE_FIX_GUIDE.md ./docs/
cp ../VERTEX_CRM_FRONTEND_DEPLOYMENT_GUIDE.md ./docs/
cp ../00-MASTER_DEPLOYMENT_GUIDE.md ./docs/
cp ../01-GITHUB_SETUP_GUIDE.md ./docs/
cp ../02-FRONTEND_PROJECT_TEMPLATE.md ./docs/
cp ../05-VERIFICATION_CHECKLIST.md ./docs/
cp ../06-INTEROPERABILITY_TEST_SUITE.md ./docs/
cp ../07-TROUBLESHOOTING_GUIDE.md ./docs/

# Create README
cat > README.md << 'EOF'
# Vertex CRM

Complete CRM system with META Business integration for Phase 1 MVP.

## Quick Start

### Backend (Already Deployed)
- ✅ api-gateway
- ✅ workflow-engine
- ✅ notification-service
- ✅ crm-service
- ✅ marketing-intelligence

### Frontend (This Repository)
- Next.js 14 web application
- TailwindCSS + shadcn/ui components
- Real-time CRM dashboards
- META business analytics

### Deployment
```bash
# See docs/00-MASTER_DEPLOYMENT_GUIDE.md for complete instructions

# Quick deploy
bash infrastructure/scripts/deploy-to-gcp.sh

# Verify deployment
bash infrastructure/scripts/verify-setup.sh
```

## Documentation

- [Master Deployment Guide](docs/00-MASTER_DEPLOYMENT_GUIDE.md) - Start here
- [Frontend Setup](docs/02-FRONTEND_PROJECT_TEMPLATE.md)
- [Verification Checklist](docs/05-VERIFICATION_CHECKLIST.md)
- [Troubleshooting](docs/07-TROUBLESHOOTING_GUIDE.md)

## Project Structure

```
vertex-crm/
├── services/                 # Backend microservices
│   ├── api-gateway/         # Entry point
│   ├── crm-service/         # Data layer
│   ├── workflow-engine/     # Automation
│   └── ...
├── vertex-crm-web/          # Frontend (Next.js)
├── infrastructure/          # Deployment & monitoring
│   ├── scripts/            # Deployment scripts
│   ├── monitoring/         # Cloud Monitoring config
│   └── terraform/          # Infrastructure as Code
└── docs/                   # Documentation
```

## Status

- ✅ Backend: Deployed (07-21-2026)
- ⏳ Frontend: Ready for deployment
- ⏳ Live: Awaiting frontend deployment

## Support

See [Troubleshooting Guide](docs/07-TROUBLESHOOTING_GUIDE.md) for common issues.
EOF

git add README.md docs/
git commit -m "docs: add comprehensive documentation"
```

---

## STEP 8: Push Everything to GitHub (1 Minute)

```bash
# View all changes
git status
# Should show all new files ready to commit

# Push to main branch
git branch -M main
git push -u origin main

# Verify everything pushed
git remote -v
# Should show: origin https://github.com/YOUR-ORG/vertex-crm.git

# Check on GitHub
echo "Visit: https://github.com/YOUR-ORG/vertex-crm"
```

---

## STEP 9: Setup GitHub Actions (Optional - Advanced)

If you want automated deployment on push to main:

```bash
# Copy GitHub Actions workflow
mkdir -p .github/workflows
cp ../github-actions-deploy.yml .github/workflows/deploy.yml

# Set secrets
gh secret set GCP_PROJECT_ID -b "vertex-crm-production"
gh secret set GCP_REGION -b "us-central1"
gh secret set GCP_SERVICE_ACCOUNT_KEY -b @/path/to/key.json

git add .github/
git commit -m "ci: add GitHub Actions CI/CD pipeline"
git push
```

---

## STEP 10: Verify Repository Setup (1 Minute)

```bash
# List all files in repo
git ls-tree -r HEAD --name-only | head -30

# Should show files from all subdirectories

# Count files
git ls-tree -r HEAD | wc -l

# Show last commits
git log --oneline | head -10
```

---

## COMPLETE FILE CHECKLIST

```
✅ Backend Services (already in repo)
   ├─ services/api-gateway/
   ├─ services/workflow-engine/
   ├─ services/notification-service/
   ├─ services/crm-service/
   ├─ services/marketing-intelligence/
   └─ services/*.{Dockerfile,package.json}

✅ Frontend Application
   ├─ vertex-crm-web/src/
   ├─ vertex-crm-web/public/
   ├─ vertex-crm-web/Dockerfile
   ├─ vertex-crm-web/package.json
   ├─ vertex-crm-web/tsconfig.json
   └─ vertex-crm-web/tailwind.config.ts

✅ Deployment Infrastructure
   ├─ infrastructure/scripts/deploy-to-gcp.sh
   ├─ infrastructure/scripts/verify-setup.sh
   ├─ infrastructure/scripts/rollback.sh
   ├─ infrastructure/monitoring/dashboards.json
   └─ infrastructure/terraform/

✅ Documentation
   ├─ docs/00-MASTER_DEPLOYMENT_GUIDE.md
   ├─ docs/01-GITHUB_SETUP_GUIDE.md (this file)
   ├─ docs/02-FRONTEND_PROJECT_TEMPLATE.md
   ├─ docs/05-VERIFICATION_CHECKLIST.md
   ├─ docs/06-INTEROPERABILITY_TEST_SUITE.md
   ├─ docs/07-TROUBLESHOOTING_GUIDE.md
   └─ README.md

✅ Configuration
   ├─ .gitignore
   ├─ .github/workflows/deploy.yml
   └─ .env.example
```

---

## QUICK REFERENCE: Common Git Commands

```bash
# View changes
git status                      # See what's changed
git diff                        # See changes in detail
git log --oneline              # View commit history

# Make changes
git add <file>                 # Stage file
git add .                      # Stage all files
git commit -m "message"        # Commit changes
git push                       # Push to GitHub

# Branches
git branch                     # List branches
git checkout -b feature/name   # Create new branch
git push -u origin feature/name # Push new branch

# Undo changes
git reset HEAD~1               # Undo last commit (keep changes)
git revert HEAD                # Revert last commit (new commit)
git checkout -- <file>        # Discard changes in file

# Sync with remote
git pull origin main           # Get latest changes
git fetch                      # Check for updates without merging
```

---

## BRANCH STRATEGY

Recommended workflow:

```
main (production)
  ↑
  └── feature/frontend-deployment
       └── feature/monitoring
            └── feature/github-actions
```

### **Create Feature Branch**

```bash
git checkout -b feature/frontend-deployment

# Make changes
git add .
git commit -m "feat: add frontend"

# Push branch
git push -u origin feature/frontend-deployment

# Create Pull Request on GitHub (or use CLI)
gh pr create --title "Add frontend deployment" \
  --body "Adds Next.js frontend and deployment scripts" \
  --base main
```

### **Merge to Main**

```bash
# Review changes on GitHub, then:
gh pr merge 1 --merge          # Merge PR #1

# Or merge locally
git checkout main
git merge feature/frontend-deployment
git push origin main
```

---

## PROTECTING MAIN BRANCH (Recommended)

To prevent accidental overwrites:

```bash
# Using GitHub CLI
gh repo edit --enable-auto-merge \
  --require-code-review-before-merge \
  --require-status-checks-before-merge

# Or via Web UI:
# 1. Go to Settings → Branches
# 2. Add rule for "main"
# 3. Enable: Require pull request reviews
# 4. Enable: Require status checks to pass
```

---

## AUTOMATED DEPLOYMENTS (CI/CD)

Set up automatic deployment on push:

```bash
# GitHub Actions will:
# ✅ Build Docker image
# ✅ Push to Artifact Registry
# ✅ Deploy to Cloud Run
# ✅ Run verification tests

# See .github/workflows/deploy.yml for details
```

---

## TROUBLESHOOTING

### **"fatal: not a git repository"**
```bash
git init
git remote add origin https://github.com/YOUR-ORG/vertex-crm.git
```

### **"Permission denied" when pushing**
```bash
# Use personal access token instead of password
# 1. Create token at https://github.com/settings/tokens
# 2. When prompted for password, use the token
# Or: git remote set-url origin https://TOKEN@github.com/YOUR-ORG/vertex-crm.git
```

### **"branch main not found"**
```bash
git branch -M main
git push -u origin main
```

### **Large files rejected**
```bash
# Remove large files from history
git rm --cached <file>
echo "<file>" >> .gitignore
git commit -m "Remove large file"

# Or use Git LFS for large files
git lfs track "*.{zip,tar.gz}"
```

---

## FINAL VERIFICATION

```bash
# Verify repo structure
tree -L 2 -I 'node_modules|.git'

# Verify all files committed
git status
# Should show: "On branch main, nothing to commit, working tree clean"

# Verify remote
git remote -v
# Should show both fetch and push URLs

# View on GitHub
echo "Repository ready at: https://github.com/YOUR-ORG/vertex-crm"
```

---

## NEXT STEP

Once GitHub is setup and all files are pushed:

**→ Follow `02-FRONTEND_PROJECT_TEMPLATE.md` to create the frontend**

```bash
cd vertex-crm-web
npm install
npm run dev
# Frontend ready on http://localhost:3000
```

---

## SUMMARY

✅ Repository created on GitHub  
✅ All files organized and pushed  
✅ Branch strategy configured  
✅ CI/CD ready (optional)  
✅ Protected main branch (recommended)  

**Your GitHub repo is production-ready!**
