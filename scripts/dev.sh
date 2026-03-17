#!/bin/bash

# Ensure we are in the project root
cd "$(dirname "$0")/.."

echo "Starting infrastructure (PostgreSQL, Redis)..."
docker-compose up -d

echo "Infrastructure is up. Starting the application in development mode..."
npm run start:dev
