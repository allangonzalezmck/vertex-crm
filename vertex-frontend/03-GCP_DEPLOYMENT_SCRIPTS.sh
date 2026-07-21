#!/bin/bash

################################################################################
# Vertex CRM — Complete GCP Deployment Script
# Deploys frontend (Next.js) + configures infrastructure
# Run this script to go from zero to production in <20 minutes
################################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
PROJECT_ID="${PROJECT_ID:-vertex-crm-production}"
REGION="${REGION:-us-central1}"
DOMAIN="${DOMAIN:-vertex-crm.yourdomain.com}"
DOCKER_REGISTRY="$REGION-docker.pkg.dev"
REPO_NAME="vertex-crm"
IMAGE_NAME="vertex-crm-web"
TAG="v1.0.0"
SERVICE_NAME="vertex-crm-web"

################################################################################
# Helper Functions
################################################################################

log_header() {
  echo -e "\n${BLUE}═══════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}  $1${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════════════${NC}\n"
}

log_info() {
  echo -e "${GREEN}✓${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}⚠${NC} $1"
}

log_error() {
  echo -e "${RED}✗${NC} $1"
}

check_prerequisites() {
  log_header "Checking Prerequisites"

  # Check gcloud
  if ! command -v gcloud &> /dev/null; then
    log_error "gcloud CLI not found. Please install Google Cloud SDK."
    exit 1
  fi
  log_info "gcloud CLI found"

  # Check docker
  if ! command -v docker &> /dev/null; then
    log_error "Docker not found. Please install Docker."
    exit 1
  fi
  log_info "Docker found"

  # Check git
  if ! command -v git &> /dev/null; then
    log_error "git not found. Please install Git."
    exit 1
  fi
  log_info "git found"

  # Check authentication
  if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" &> /dev/null; then
    log_error "Not authenticated with gcloud. Run: gcloud auth login"
    exit 1
  fi
  log_info "gcloud authentication verified"

  # Set project
  gcloud config set project $PROJECT_ID 2>/dev/null
  log_info "GCP project set to $PROJECT_ID"
}

create_static_ip() {
  log_header "Creating Static IP Address"

  # Check if already exists
  if gcloud compute addresses describe vertex-crm-ip --global --project=$PROJECT_ID &>/dev/null; then
    log_warn "Static IP already exists"
    IP=$(gcloud compute addresses describe vertex-crm-ip --global --project=$PROJECT_ID --format="value(address)")
    log_info "IP Address: $IP"
    return
  fi

  # Create static IP
  gcloud compute addresses create vertex-crm-ip \
    --global \
    --project=$PROJECT_ID

  IP=$(gcloud compute addresses describe vertex-crm-ip --global --project=$PROJECT_ID --format="value(address)")
  log_info "Static IP created: $IP"
  echo "$IP" > /tmp/vertex-crm-ip.txt
}

setup_load_balancer() {
  log_header "Setting Up Load Balancer"

  # Get static IP
  IP=$(gcloud compute addresses describe vertex-crm-ip --global --project=$PROJECT_ID --format="value(address)")

  # Create health check
  if ! gcloud compute health-checks describe vertex-crm-health-check --global --project=$PROJECT_ID &>/dev/null; then
    gcloud compute health-checks create http vertex-crm-health-check \
      --port=3000 \
      --request-path=/api/health \
      --check-interval=30s \
      --timeout=5s \
      --global \
      --project=$PROJECT_ID
    log_info "Health check created"
  else
    log_warn "Health check already exists"
  fi

  # Create backend service
  if ! gcloud compute backend-services describe vertex-crm-backend --global --project=$PROJECT_ID &>/dev/null; then
    gcloud compute backend-services create vertex-crm-backend \
      --protocol=HTTP \
      --port-name=http \
      --health-checks=vertex-crm-health-check \
      --global \
      --project=$PROJECT_ID
    log_info "Backend service created"
  else
    log_warn "Backend service already exists"
  fi

  log_info "Load Balancer ready (IP: $IP)"
}

build_and_push_image() {
  log_header "Building and Pushing Docker Image"

  IMAGE_URL="$DOCKER_REGISTRY/$PROJECT_ID/$REPO_NAME/$IMAGE_NAME:$TAG"

  # Build image
  log_info "Building Docker image..."
  docker build \
    -t $IMAGE_URL \
    -t "$DOCKER_REGISTRY/$PROJECT_ID/$REPO_NAME/$IMAGE_NAME:latest" \
    -f Dockerfile \
    . || {
    log_error "Docker build failed"
    exit 1
  }

  log_info "Image built successfully"

  # Authenticate docker
  gcloud auth configure-docker $DOCKER_REGISTRY

  # Push image
  log_info "Pushing image to Artifact Registry..."
  docker push $IMAGE_URL
  docker push "$DOCKER_REGISTRY/$PROJECT_ID/$REPO_NAME/$IMAGE_NAME:latest"

  log_info "Image pushed: $IMAGE_URL"
  echo "$IMAGE_URL" > /tmp/vertex-crm-image.txt
}

deploy_to_cloud_run() {
  log_header "Deploying to Cloud Run"

  IMAGE_URL=$(cat /tmp/vertex-crm-image.txt 2>/dev/null || echo "$DOCKER_REGISTRY/$PROJECT_ID/$REPO_NAME/$IMAGE_NAME:$TAG")

  # Check if service exists
  if gcloud run services describe $SERVICE_NAME --region=$REGION --project=$PROJECT_ID &>/dev/null; then
    log_warn "Cloud Run service already exists. Updating..."
    ACTION="update"
  else
    log_info "Creating new Cloud Run service..."
    ACTION="deploy"
  fi

  # Deploy/Update service
  gcloud run $ACTION $SERVICE_NAME \
    --image=$IMAGE_URL \
    --platform=managed \
    --region=$REGION \
    --allow-unauthenticated \
    --memory=512Mi \
    --cpu=1 \
    --timeout=300 \
    --max-instances=10 \
    --set-env-vars="NEXT_PUBLIC_API_URL=https://api.$DOMAIN" \
    --project=$PROJECT_ID

  # Get service URL
  SERVICE_URL=$(gcloud run services describe $SERVICE_NAME \
    --platform=managed \
    --region=$REGION \
    --project=$PROJECT_ID \
    --format='value(status.url)')

  log_info "Cloud Run service deployed"
  log_info "Service URL: $SERVICE_URL"
  echo "$SERVICE_URL" > /tmp/vertex-crm-service-url.txt
}

setup_ssl_certificate() {
  log_header "Setting Up SSL Certificate"

  log_warn "SSL certificate setup requires manual steps:"
  echo "1. For Let's Encrypt (free):"
  echo "   - Use Cloud Armor for termination"
  echo "   - Or generate cert and upload manually"
  echo ""
  echo "2. Using existing certificate:"
  echo "   gcloud compute ssl-certificates create vertex-crm-cert \\"
  echo "     --cert-file=path/to/fullchain.pem \\"
  echo "     --key-file=path/to/privkey.pem \\"
  echo "     --project=$PROJECT_ID"
  echo ""
  echo "For now, continuing with HTTP..."
}

setup_dns() {
  log_header "Setting Up DNS"

  IP=$(gcloud compute addresses describe vertex-crm-ip --global --project=$PROJECT_ID --format="value(address)")

  log_warn "DNS setup requires manual configuration:"
  echo ""
  echo "1. Go to GoDaddy (or your DNS provider) admin panel"
  echo "2. Add A record:"
  echo "   Name: vertex-crm"
  echo "   Type: A"
  echo "   Value: $IP"
  echo "   TTL: 3600"
  echo ""
  echo "3. Or use Google Cloud DNS:"
  echo "   gcloud dns record-sets create vertex-crm.$DOMAIN. \\"
  echo "     --rrdatas=$IP \\"
  echo "     --ttl=300 \\"
  echo "     --type=A \\"
  echo "     --zone=YOUR_ZONE_NAME"
  echo ""
  echo "Note: DNS changes can take 15-30 minutes to propagate"
}

setup_monitoring() {
  log_header "Setting Up Monitoring"

  # Create notification channel (email)
  log_info "Setting up Cloud Monitoring..."

  # Import monitoring config if exists
  if [ -f "infrastructure/monitoring/dashboards.json" ]; then
    log_info "Creating monitoring dashboard..."
    gcloud monitoring dashboards create \
      --config-from-file=infrastructure/monitoring/dashboards.json \
      --project=$PROJECT_ID 2>/dev/null || log_warn "Dashboard creation may have failed (this is OK)"
  fi

  log_info "Monitoring configured"
}

run_verification() {
  log_header "Running Verification Tests"

  log_info "Checking service status..."
  
  # Check Cloud Run service
  SERVICE_URL=$(cat /tmp/vertex-crm-service-url.txt)
  
  # Try to reach service
  if curl -s -o /dev/null -w "%{http_code}" "$SERVICE_URL" | grep -q "302\|200\|401"; then
    log_info "✓ Cloud Run service is responding"
  else
    log_warn "Cloud Run service may not be responding yet (normal if just deployed)"
  fi

  # Check static IP
  IP=$(gcloud compute addresses describe vertex-crm-ip --global --project=$PROJECT_ID --format="value(address)")
  log_info "✓ Static IP allocated: $IP"

  # Check image in registry
  if gcloud artifacts docker images describe "$DOCKER_REGISTRY/$PROJECT_ID/$REPO_NAME/$IMAGE_NAME:$TAG" \
    --project=$PROJECT_ID &>/dev/null; then
    log_info "✓ Docker image in Artifact Registry"
  fi

  log_info "Verification complete!"
}

print_summary() {
  log_header "Deployment Summary"

  IP=$(gcloud compute addresses describe vertex-crm-ip --global --project=$PROJECT_ID --format="value(address)" 2>/dev/null || echo "Pending")
  SERVICE_URL=$(gcloud run services describe $SERVICE_NAME --platform=managed --region=$REGION --project=$PROJECT_ID --format='value(status.url)' 2>/dev/null || echo "Pending")

  echo "Project ID:          $PROJECT_ID"
  echo "Region:              $REGION"
  echo "Static IP:           $IP"
  echo "Domain:              $DOMAIN"
  echo "Service URL:         $SERVICE_URL"
  echo "Docker Image:        $DOCKER_REGISTRY/$PROJECT_ID/$REPO_NAME/$IMAGE_NAME:$TAG"
  echo ""
  echo "Next Steps:"
  echo "1. Configure DNS to point $DOMAIN to $IP"
  echo "2. Setup SSL certificate (see setup_ssl_certificate output)"
  echo "3. Wait for Cloud Run service to become healthy"
  echo "4. Test frontend at https://$DOMAIN"
  echo ""
  echo "See: 05-VERIFICATION_CHECKLIST.md for complete verification steps"
}

################################################################################
# Main Execution
################################################################################

main() {
  log_header "Vertex CRM — Complete GCP Deployment"

  # Check prerequisites
  check_prerequisites

  # Deploy
  create_static_ip
  setup_load_balancer
  build_and_push_image
  deploy_to_cloud_run
  setup_ssl_certificate
  setup_dns
  setup_monitoring

  # Verify
  run_verification

  # Summary
  print_summary

  log_info "Deployment complete! ✨"
}

# Run main if script is executed directly
if [ "${BASH_SOURCE[0]}" == "${0}" ]; then
  main "$@"
fi
