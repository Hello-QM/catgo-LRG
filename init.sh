#!/bin/bash
# Initialization script for LAMMPS module development

set -e  # Exit on error

PROJECT_DIR="/Users/chem/Desktop/UCSD/CatGO-Doloris_max-adv_MD"
cd "$PROJECT_DIR"

echo "=========================================="
echo "LAMMPS Module Development Environment"
echo "=========================================="
echo "Project directory: $PROJECT_DIR"
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    pnpm install
fi

# Kill any existing dev server on port 3000
echo "Checking for existing processes on port 3000..."
if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "Killing existing process on port 3000..."
    kill $(lsof -Pi :3000 -sTCP:LISTEN -t) 2>/dev/null || true
    sleep 1
fi

# Kill any existing Python server on port 8000
echo "Checking for existing processes on port 8000..."
if lsof -Pi :8000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "Killing existing process on port 8000..."
    kill $(lsof -Pi :8000 -sTCP:LISTEN -t) 2>/dev/null || true
    sleep 1
fi

# Start Python backend server (if available)
if [ -d "server" ] && [ -f "server/main.py" ]; then
    echo "Starting Python backend server on port 8000..."
    cd server
    python -m uvicorn main:app --host localhost --port 8000 --reload &
    PYTHON_PID=$!
    cd ..
    echo "Backend server PID: $PYTHON_PID"
fi

# Start SvelteKit dev server
echo "Starting SvelteKit dev server on port 3000..."
pnpm dev &
DEV_PID=$!
echo "Frontend server PID: $DEV_PID"

echo ""
echo "=========================================="
echo "Development servers started!"
echo "=========================================="
echo "Frontend: http://localhost:3000"
echo "Backend API: http://localhost:8000"
echo "API Docs: http://localhost:8000/docs"
echo ""
echo "Press Ctrl+C to stop all servers"
echo ""

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "Stopping servers..."
    kill $PYTHON_PID 2>/dev/null || true
    kill $DEV_PID 2>/dev/null || true
    exit
}

trap cleanup SIGINT SIGTERM

# Wait for any process to exit
wait
