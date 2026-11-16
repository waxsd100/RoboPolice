"""An uncensored image model behind a small HTTP API, for the bot's generate_image (see
docs/deploy/cloud-run-imagegen.md).

It speaks the part of the AUTOMATIC1111 / Forge web API the bot uses (POST /sdapi/v1/txt2img,
POST /sdapi/v1/img2img), so the bot can be pointed at either this or an existing Forge.

Environment:
  IMAGEGEN_MODEL      a Hugging Face repo id, or a path to a .safetensors checkpoint (SDXL)
  IMAGEGEN_API_KEY    when set, requests must carry "Authorization: Bearer <key>"
  PORT                the port to listen on (8080)

A prompt that says a child is refused, and a short negative prompt against one goes with every
image.
"""
import asyncio
import base64
import io
import os
import re

import torch
from diffusers import StableDiffusionXLImg2ImgPipeline, StableDiffusionXLPipeline
from fastapi import FastAPI, Header, HTTPException
from PIL import Image
from pydantic import BaseModel, Field

MODEL = os.environ.get("IMAGEGEN_MODEL", "cagliostrolab/animagine-xl-4.0")
API_KEY = os.environ.get("IMAGEGEN_API_KEY", "")
MAX_SIDE = 1536
MAX_STEPS = 50

# Words that say a child. The bot checks the same (src/bot/utils/uncensoredImage.js); this is the
# last line, for any other caller. Only words that say one, so an anime look is not refused.
MINOR = re.compile(
    r"\b(child|children|kid|kids|underage|toddler|infant|loli|lolis|lolicon|shota|shotacon|schoolgirl|schoolboy|"
    r"elementary school|middle school|junior high|(?:[1-9]|1[0-7])\s*(?:yo|y/o|years? old))\b"
    r"|(?<!\d)(?:[1-9]|1[0-7])\s*(?:歳|才)"
    r"|幼女|幼児|園児|児童|女児|男児|小学生|中学生|女子高生|男子高生|ロリ|ショタ|未成年"
    r"|(?<![a-z])(?:js|jc|jk)(?![a-z])",
    re.IGNORECASE,
)
# Short, as a long negative prompt changes the picture too.
ALWAYS_NEGATIVE = "child, loli, shota"

app = FastAPI(title="imagegen")
lock = asyncio.Lock()
pipes = {}


def load():
    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    if MODEL.endswith(".safetensors"):
        txt2img = StableDiffusionXLPipeline.from_single_file(MODEL, torch_dtype=dtype)
    else:
        txt2img = StableDiffusionXLPipeline.from_pretrained(MODEL, torch_dtype=dtype)
    txt2img.to("cuda" if torch.cuda.is_available() else "cpu")
    pipes["txt2img"] = txt2img
    pipes["img2img"] = StableDiffusionXLImg2ImgPipeline(**txt2img.components)


@app.on_event("startup")
def startup():
    load()


def check_key(authorization):
    if API_KEY and authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="bad or missing API key")


def check_prompt(text):
    if MINOR.search(text or ""):
        raise HTTPException(status_code=400, detail="the prompt reads as a child: refused")


def fit(n):
    return max(512, min(MAX_SIDE, int(n) // 64 * 64))


class Txt2Img(BaseModel):
    prompt: str
    negative_prompt: str = ""
    width: int = 1024
    height: int = 1024
    steps: int = 28
    cfg_scale: float = 6.0
    seed: int = -1


class Img2Img(Txt2Img):
    init_images: list[str] = Field(default_factory=list)
    denoising_strength: float = 0.6


def encode(image):
    out = io.BytesIO()
    image.save(out, format="PNG")
    return base64.b64encode(out.getvalue()).decode()


def run(kind, req, **extra):
    check_prompt(req.prompt)
    generator = None
    if req.seed >= 0:
        generator = torch.Generator(device=pipes[kind].device).manual_seed(req.seed)
    result = pipes[kind](
        prompt=req.prompt,
        negative_prompt=f"{ALWAYS_NEGATIVE}, {req.negative_prompt}".strip(", "),
        num_inference_steps=max(1, min(MAX_STEPS, req.steps)),
        guidance_scale=req.cfg_scale,
        generator=generator,
        **extra,
    )
    return {"images": [encode(image) for image in result.images]}


@app.get("/health")
def health():
    return {"status": "ok" if pipes else "loading", "model": MODEL}


@app.post("/sdapi/v1/txt2img")
async def txt2img(req: Txt2Img, authorization: str = Header(default="")):
    check_key(authorization)
    async with lock:
        return await asyncio.to_thread(run, "txt2img", req, width=fit(req.width), height=fit(req.height))


@app.post("/sdapi/v1/img2img")
async def img2img(req: Img2Img, authorization: str = Header(default="")):
    check_key(authorization)
    if not req.init_images:
        raise HTTPException(status_code=400, detail="init_images is empty")
    source = Image.open(io.BytesIO(base64.b64decode(req.init_images[0].split(",")[-1]))).convert("RGB")
    source = source.resize((fit(req.width), fit(req.height)))
    async with lock:
        return await asyncio.to_thread(run, "img2img", req, image=source, strength=max(0.05, min(1.0, req.denoising_strength)))
