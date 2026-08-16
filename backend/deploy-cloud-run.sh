#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${GOOGLE_CLOUD_PROJECT:-}" ]]; then
  echo "GOOGLE_CLOUD_PROJECT is required"
  exit 1
fi

if [[ -z "${CLOUD_RUN_SERVICE_ACCOUNT:-}" ]]; then
  echo "CLOUD_RUN_SERVICE_ACCOUNT is required"
  exit 1
fi

SERVICE_NAME="wedding-rsvps-backend"
REGION="${REGION:-us-central1}"
IMAGE="gcr.io/${GOOGLE_CLOUD_PROJECT}/${SERVICE_NAME}:$(date +%Y%m%d-%H%M%S)"
ENV_VARS_FILE="${ENV_VARS_FILE:-cloudrun.env.yaml}"

if [[ ! -f "${ENV_VARS_FILE}" ]]; then
  echo "Missing ${ENV_VARS_FILE}. Copy cloudrun.env.yaml.example and fill it in."
  exit 1
fi

gcloud builds submit --tag "${IMAGE}" .

gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE}" \
  --platform managed \
  --region "${REGION}" \
  --allow-unauthenticated \
  --service-account "${CLOUD_RUN_SERVICE_ACCOUNT}" \
  --env-vars-file "${ENV_VARS_FILE}"

URL=$(gcloud run services describe "${SERVICE_NAME}" --region "${REGION}" --format='value(status.url)')
echo "Deployed URL: ${URL}"
