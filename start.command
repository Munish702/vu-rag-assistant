#!/bin/bash
# Double-click this file to start the VU study assistant (macOS).
cd "$(dirname "$0")"

# Make sure Ollama (the local language model) is running.
if ! curl -s http://localhost:11434 > /dev/null; then
  echo "Starting Ollama..."
  open -a Ollama
  sleep 5
fi

source .venv/bin/activate
export HF_HUB_OFFLINE=1
echo "Opening the assistant in your browser..."
streamlit run src/app.py
