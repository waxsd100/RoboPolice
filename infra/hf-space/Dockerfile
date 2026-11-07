FROM ghcr.io/ggml-org/llama.cpp:server

ENV PORT=8080 \
    LLAMA_CACHE=/tmp/llama-cache \
    HF_REPO=mradermacher/DeepSeek-V4-Pro-Qwen3.5-9B-UNCENSORED-heretic-i1-GGUF \
    HF_QUANT=IQ3_M \
    CTX_SIZE=8192 \
    REASONING=off

RUN mkdir -p /tmp/llama-cache && chmod 777 /tmp/llama-cache

EXPOSE 8080

ENTRYPOINT ["/bin/sh", "-c"]
CMD ["exec /app/llama-server --host :: --port \"${PORT}\" -hf \"${HF_REPO}:${HF_QUANT}\" --ctx-size \"${CTX_SIZE}\" --jinja --reasoning \"${REASONING}\" ${API_KEY:+--api-key \"$API_KEY\"}"]
